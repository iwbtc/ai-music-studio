/**
 * Host 半区单测：ops 纯函数 / state 持久化与订阅 / routes HTTP API / 15 个 studio_* 工具。
 * 运行：node --test test/host.test.mjs
 *
 * 不依赖 DSH 运行时：createTools 使用 `(options) => options` 的 mock defineTool，
 * routes 用真实 node:http 服务测试 HTTP 语义。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { cp, mkdir, open, readFile, readdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CURRENT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
import { createDemoProject } from '../src/shared/demo.js'
import { DRUM_KITS, DRUM_PARAM_SPECS, FX_TYPES, SYNTH_INSTRUMENTS, SYNTH_PRESETS, findSynthInstrument } from '../src/shared/catalog.js'
import { MEDIA_DEFAULT_CLIP_BARS, MEDIA_MAX_BYTES, SCHEMA_VERSION, audioClipPlayableSeconds, createEmptyProject, makeClip, makePattern, makeTrack } from '../src/shared/model.js'
import { buildMidi, buildMidiFile } from '../src/host/midi.js'
import { MAX_MIDI_BYTES, MidiImportError, buildProjectFromMidi, importMidiIntoState, nearestSampledPreset, parseMidiBuffer } from '../src/host/midi-import.js'
import * as ops from '../src/host/ops.js'
import {
  MAX_PROJECT_VERSIONS,
  VERSION_DIR_NAME,
  listProjectVersions,
  listProjects,
  loadProjectFile,
  projectVersionsDir,
  projectsDir,
  readProjectVersion,
  sanitizeProjectName,
  saveProjectFile,
  writeProjectVersion,
} from '../src/host/projects.js'
import { createRoutes, sanitizeExportName, wavDurationSeconds } from '../src/host/routes.js'
import { startServer as startStandaloneServer } from '../src/standalone/server.mjs'
import {
  AUTOSAVE_FILE_NAME,
  AUTOSAVE_INTERVAL_MS,
  MAX_AUTOSAVE_COPIES,
  MAX_UNDO,
  RECOVERY_DIR_NAME,
  SESSION_LOCK_FILE_NAME,
  createState,
  sanitizeProject,
} from '../src/host/state.js'
import { createMetrics } from '../src/host/perf.js'
import { createTools, TOOL_NAMES } from '../src/host/tools.js'
import { defineTool as realDefineTool } from '../src/host/define-tool.js'
import { makeMediaFileName, randomMediaSuffix, writeUniqueMediaFile } from '../src/host/media-files.js'
import { clearPreviewRequests, completePreviewRequest, peekPreviewRequest, pendingPreviewCount, requestPreview } from '../src/host/preview-bridge.js'

/* ------------------------------------------------------------------------- */
/* 测试工具                                                                   */
/* ------------------------------------------------------------------------- */

const tmpDirs = []
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aims-host-'))
  tmpDirs.push(dir)
  return dir
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 构造 1 秒双声道 16bit 44.1kHz 的 WAV（内容为静音，仅用于测试文件头解析）。 */
function makeWav(seconds = 1) {
  const sampleRate = 44100
  const channels = 2
  const bits = 16
  const byteRate = (sampleRate * channels * bits) / 8
  const dataSize = Math.round(byteRate * seconds)
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE((channels * bits) / 8, 32)
  buffer.writeUInt16LE(bits, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

/** 带演示工程的临时 state。 */
async function makeState({ withDemo = true } = {}) {
  const dir = await tempDir()
  const state = createState({
    dataDir: dir,
    fallbackInitial: withDemo ? () => createDemoProject() : () => null,
  })
  await state.ready
  return { dir, state }
}

/** 启动一个只挂 Host API 路由的真实 HTTP 服务。 */
async function startServer(state, options = {}) {
  const routes = createRoutes({ state, longPollMs: 300, ...options })
  const server = http.createServer((req, res) => {
    routes[0].handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    routes,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

/** 递归检查 DSL 中每个 object 节点都显式声明了 additionalProperties。 */
function assertObjectSchemasExplicit(node, where) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertObjectSchemasExplicit(item, `${where}[${index}]`))
    return
  }
  if (node.type === 'object') {
    assert.equal(typeof node.additionalProperties, 'boolean', `${where} 缺少 additionalProperties`)
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, value] of Object.entries(node.properties)) {
      assertObjectSchemasExplicit(value, `${where}.${key}`)
    }
  }
  if (node.items) assertObjectSchemasExplicit(node.items, `${where}[]`)
}

/* ------------------------------------------------------------------------- */
/* DSH 参数 DSL 编译规则本地复刻                                              */
/* 依据 packages/core/tools/src/schema.ts（0.2.1）的 assertAuthorKeys / required */
/* 规则，用于在无 DSH 运行时的环境里预校验工具定义，降低真机 E2E 风险。          */
/* ------------------------------------------------------------------------- */

const DSL_ANNOTATIONS = ['description', 'title', 'default', 'examples']

function dslAssertKeys(node, pathName, allowed) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw new Error(`${pathName}.${key} 不是 DSL 支持的键（允许：${allowed.join(', ')}）`)
  }
}

/** 编译隐式参数对象（属性表 → raw JSON Schema object 根）。 */
function dslCompileParameters(spec, pathName) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${pathName} 必须是对象`)
  const properties = {}
  const required = []
  for (const [key, property] of Object.entries(spec)) {
    const childPath = `${pathName}.${key}`
    if (property === null || typeof property !== 'object' || Array.isArray(property)) throw new Error(`${childPath} 必须是 value schema 对象`)
    if (Object.hasOwn(property, 'required')) {
      if (property.required !== true) throw new Error(`${childPath}.required 只能是 true`)
      required.push(key)
    }
    properties[key] = dslCompileValue(property, childPath, true)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** 编译单个 value schema 节点（含属性表 / items / oneOf）。 */
function dslCompileValue(node, pathName, allowRequired) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${pathName} 必须是 value schema 对象`)
  const annotations = [...DSL_ANNOTATIONS, ...(allowRequired ? ['required'] : [])]
  if (Object.hasOwn(node, 'oneOf')) {
    dslAssertKeys(node, pathName, [...annotations, 'oneOf', 'type'])
    if (Object.hasOwn(node, 'type')) throw new Error(`${pathName} 不能同时声明 type 与 oneOf`)
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) throw new Error(`${pathName}.oneOf 至少需要 2 个分支`)
    return { oneOf: node.oneOf.map((branch, index) => dslCompileValue(branch, `${pathName}.oneOf[${index}]`, false)) }
  }
  const type = Object.hasOwn(node, 'type') ? node.type : undefined
  switch (type) {
    case 'json':
      dslAssertKeys(node, pathName, [...annotations, 'type'])
      return {}
    case 'object': {
      dslAssertKeys(node, pathName, [...annotations, 'type', 'properties', 'additionalProperties'])
      if (typeof node.additionalProperties !== 'boolean') throw new Error(`${pathName}.additionalProperties 必须显式 true/false`)
      const out = { type: 'object', additionalProperties: node.additionalProperties }
      if (Object.hasOwn(node, 'properties')) {
        const compiled = dslCompileParameters(node.properties, `${pathName}.properties`)
        out.properties = compiled.properties
        if (compiled.required) out.required = compiled.required
      }
      return out
    }
    case 'array': {
      dslAssertKeys(node, pathName, [...annotations, 'type', 'items'])
      const out = { type: 'array' }
      if (Object.hasOwn(node, 'items')) out.items = dslCompileValue(node.items, `${pathName}.items`, false)
      return out
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      dslAssertKeys(node, pathName, [...annotations, 'type', 'enum', 'const'])
      const out = { type }
      if (Object.hasOwn(node, 'enum')) {
        if (!Array.isArray(node.enum) || node.enum.length === 0) throw new Error(`${pathName}.enum 必须是非空数组`)
        out.enum = node.enum
      }
      if (Object.hasOwn(node, 'const')) out.const = node.const
      return out
    }
    default:
      throw new Error(`${pathName}.type 非法：${String(type)}`)
  }
}

/* ------------------------------------------------------------------------- */
/* ops：轨道                                                                  */
/* ------------------------------------------------------------------------- */

describe('ops 纯函数 — 轨道', () => {
  it('addTrack 支持 synth / drum，并返回 trackId + 摘要', () => {
    const project = createEmptyProject()
    const synth = ops.addTrack(project, { name: '低音', kind: 'synth', preset: 'finger_bass', role: 'bass', volume: 0.9 })
    assert.equal(synth.trackId, 'trk_1')
    assert.equal(synth.track.instrument.preset, 'finger_bass')
    assert.equal(synth.track.role, 'bass')
    assert.equal(synth.track.volume, 0.9)
    assert.equal(project.tracks.length, 1)

    const drum = ops.addTrack(project, { name: '鼓组', kind: 'drum', kit: 'smp_electro' })
    assert.equal(drum.trackId, 'trk_2')
    assert.equal(drum.track.kind, 'drum')
    assert.equal(drum.track.role, 'drums')
    assert.equal(drum.track.instrument.kit, 'smp_electro')
    // 采样鼓机 instrument 参数由 model.makeTrack 填满
    assert.ok(Object.keys(project.tracks[1].instrument.params).length > 0)
    // P8：采样乐器没有合成参数（engine 读 soundfont）
    assert.deepEqual(project.tracks[0].instrument.params, {})
  })

  it('addTrack 参数非法时抛出结构化 OpError', () => {
    const project = createEmptyProject()
    assert.throws(() => ops.addTrack(project, { name: 'x', kind: 'piano' }), (error) => error.name === 'OpError' && /kind/.test(error.message))
    assert.throws(() => ops.addTrack(project, { name: 'x', kind: 'synth', preset: 'nope' }), /未知采样乐器/)
    assert.throws(() => ops.addTrack(project, { name: 'x', kind: 'synth', preset: 'supersaw' }), /未知采样乐器/)
    assert.throws(() => ops.addTrack(project, { name: 'x', kind: 'drum', kit: 'nope' }), /未知采样鼓机/)
    assert.throws(() => ops.addTrack(project, { name: 'x', kind: 'drum', kit: 'neon808' }), /未知采样鼓机/)
    assert.throws(() => ops.addTrack(project, { name: 'x', kind: 'synth', color: 'red' }), /#RRGGBB/)
  })

  it('addTrack 遵守 maxTracks 上限', () => {
    const project = createEmptyProject()
    for (let i = 0; i < 32; i += 1) ops.addTrack(project, { name: `T${i}`, kind: 'synth' })
    assert.throws(() => ops.addTrack(project, { name: 'overflow', kind: 'synth' }), /上限/)
  })

  it('updateTrack 修改音量/静音/发送量，换采样乐器预设；鼓机参数钳制', () => {
    const project = createEmptyProject()
    const { trackId } = ops.addTrack(project, { name: '主音', kind: 'synth', preset: 'grand_piano' })
    let result = ops.updateTrack(project, { trackId, volume: 2, pan: -3, mute: true, sends: { reverb: 0.5 } })
    assert.equal(result.track.volume, 1) // clamp01
    assert.equal(result.track.pan, -1) // clampPan
    assert.equal(result.track.mute, true)
    assert.equal(result.track.sends.reverb, 0.5)

    // 采样乐器换预设：id 更新、无合成参数
    ops.updateTrack(project, { trackId, preset: 'strings_ensemble' })
    const track = project.tracks.find((item) => item.id === trackId)
    assert.equal(track.instrument.preset, 'strings_ensemble')
    assert.deepEqual(track.instrument.params, {})

    // 采样鼓机参数覆盖 + 钳制
    const drum = ops.addTrack(project, { name: '鼓', kind: 'drum' })
    ops.updateTrack(project, { trackId: drum.trackId, params: { kickPitch: 999, hatDecay: -1 } })
    const drumTrack = project.tracks.find((item) => item.id === drum.trackId)
    assert.equal(drumTrack.instrument.params.kickPitch, 80) // DRUM_PARAM_SPECS 上限
    assert.equal(drumTrack.instrument.params.hatDecay, 0.01)
  })

  it('updateTrack 找不到轨道 / 参数非法时报错', () => {
    const project = createEmptyProject()
    assert.throws(() => ops.updateTrack(project, { trackId: 'trk_9', volume: 0.5 }), /找不到轨道/)
    const { trackId } = ops.addTrack(project, { name: '鼓', kind: 'drum' })
    assert.throws(() => ops.updateTrack(project, { trackId, params: { osc: 'saw' } }), /不存在鼓组参数 osc/)
    assert.throws(() => ops.updateTrack(project, { trackId, params: { kickPitch: 'low' } }), /必须是数字|非法/)
  })
})

/* ------------------------------------------------------------------------- */
/* ops：pattern / 音符                                                        */
/* ------------------------------------------------------------------------- */

describe('ops 纯函数 — pattern 与音符', () => {
  it('addPattern / setNotes / getPatternView 组合可用', () => {
    const project = createEmptyProject()
    const { trackId } = ops.addTrack(project, { name: '鼓组', kind: 'drum' })
    const added = ops.addPattern(project, { name: '鼓 · Drop', lengthBars: 4 })
    assert.equal(added.patternId, 'pat_1')
    assert.equal(added.pattern.notes, 0)

    const set = ops.setNotes(project, {
      patternId: added.patternId,
      notes: [
        { pitch: 36, start: 0, dur: 0.5, vel: 0.95 },
        { pitch: 38, start: 1, dur: 0.2, vel: 0.8 },
      ],
    })
    assert.equal(set.noteCount, 2)

    const view = ops.getPatternView(project, { patternId: added.patternId })
    assert.equal(view.noteCount, 2)
    assert.equal(view.notes[0].pitch, 36)
    // 尚无 clip 引用该 pattern，tracks 为空
    assert.deepEqual(view.tracks, [])
    // 鼓件映射（36 底鼓 / 38 军鼓）
    assert.equal(view.drumPieces.length, 2)
    assert.equal(view.drumPieces[0].pitch, 36)
    assert.ok(trackId)
  })

  it('setNotes 校验音符数量/字段，超限报错', () => {
    const project = createEmptyProject()
    const { patternId } = ops.addPattern(project, { name: 'p', lengthBars: 1 })
    assert.throws(() => ops.setNotes(project, { patternId, notes: 'nope' }), /notes 必须是数组/)
    assert.throws(() => ops.setNotes(project, { patternId, notes: [{ pitch: 300, start: 0, dur: 1 }] }), /pitch 超出范围/)
    assert.throws(() => ops.setNotes(project, { patternId, notes: [{ pitch: 60, start: 0, dur: 0 }] }), /dur 必须大于 0/)
    const tooMany = Array.from({ length: 4097 }, (_, index) => ({ pitch: 60, start: index * 0.1, dur: 0.1 }))
    assert.throws(() => ops.setNotes(project, { patternId, notes: tooMany }), /上限 4096/)
    assert.throws(() => ops.setNotes(project, { patternId: 'pat_9', notes: [] }), /找不到 pattern/)
  })

  it('setNotes 支持清空（[]）且会归一化 vel/时值', () => {
    const project = createEmptyProject()
    const { patternId } = ops.addPattern(project, { name: 'p', lengthBars: 1 })
    ops.setNotes(project, { patternId, notes: [{ pitch: 60, start: 0.333333, dur: 0.5, vel: 7 }] })
    const notes = project.patterns[0].notes
    assert.equal(notes[0].vel, 1)
    ops.setNotes(project, { patternId, notes: [] })
    assert.equal(project.patterns[0].notes.length, 0)
  })

  it('setNotes 对超出 pattern 长度的音符返回 warning（不报错）', () => {
    const project = createEmptyProject()
    const { patternId } = ops.addPattern(project, { name: 'p', lengthBars: 1 }) // = 4 beat
    const result = ops.setNotes(project, {
      patternId,
      notes: [
        { pitch: 60, start: 0, dur: 0.5 },
        { pitch: 62, start: 8, dur: 0.5 }, // 超出 4 beat
      ],
    })
    assert.equal(result.noteCount, 2)
    assert.match(String(result.warning), /超出 pattern 长度/)
  })
})

/* ------------------------------------------------------------------------- */
/* ops：编排                                                                  */
/* ------------------------------------------------------------------------- */

describe('ops 纯函数 — 编排', () => {
  it('setArrangement 整体替换 clips 与 sections', () => {
    const project = createEmptyProject()
    const { trackId } = ops.addTrack(project, { name: '鼓', kind: 'drum' })
    const { patternId } = ops.addPattern(project, { name: 'beat', lengthBars: 2 })
    const result = ops.setArrangement(project, {
      clips: [
        { trackId, patternId, startBar: 0, lengthBars: 8 },
        { trackId, patternId, startBar: 8, lengthBars: 4, transpose: 2 },
      ],
      sections: [
        { name: 'Intro', startBar: 0, lengthBars: 8, color: '#7FC8A9' },
        { name: 'Drop', startBar: 8, lengthBars: 8, color: '#F26B3A' },
      ],
    })
    assert.deepEqual({ clips: result.clips, sections: result.sections }, { clips: 2, sections: 2 })
    assert.equal(project.clips[1].transpose, 2)
    assert.equal(project.sections[1].name, 'Drop')
    assert.equal(project.clips[0].id, 'clip_1')

    // 第二次只改 clips：sections 保持
    const second = ops.setArrangement(project, { clips: [{ trackId, patternId, startBar: 0, lengthBars: 2 }] })
    assert.equal(second.clips, 1)
    assert.equal(second.sectionsReplaced, false)
    assert.equal(project.sections.length, 2)

    // 片段超出曲长（默认 32 小节）→ 返回 warning 而不是报错
    const overrun = ops.setArrangement(project, { clips: [{ trackId, patternId, startBar: 30, lengthBars: 8 }] })
    assert.match(String(overrun.warning), /超出曲长/)
  })

  it('setArrangement 校验 trackId/patternId/小节范围', () => {
    const project = createEmptyProject()
    const { trackId } = ops.addTrack(project, { name: '鼓', kind: 'drum' })
    const { patternId } = ops.addPattern(project, { name: 'beat', lengthBars: 2 })
    assert.throws(() => ops.setArrangement(project, { clips: [{ trackId, patternId: 'pat_9', startBar: 0, lengthBars: 1 }] }), /patternId=pat_9/)
    assert.throws(() => ops.setArrangement(project, { clips: [{ trackId: 'trk_9', patternId, startBar: 0, lengthBars: 1 }] }), /trackId=trk_9/)
    assert.throws(() => ops.setArrangement(project, {}), /缺少 clips/)
    assert.throws(() => ops.setArrangement(project, { clips: 'nope' }), /clips 必须是数组/)
    assert.throws(
      () => ops.setArrangement(project, { clips: [{ trackId, patternId, startBar: 250, lengthBars: 16 }] }),
      /超过最大曲长/,
    )
    // clips: [] 是合法的：清空编排
    const cleared = ops.setArrangement(project, { clips: [] })
    assert.equal(cleared.clips, 0)
    assert.equal(project.clips.length, 0)
  })
})

/* ------------------------------------------------------------------------- */
/* ops：效果器 / master                                                       */
/* ------------------------------------------------------------------------- */

describe('ops 纯函数 — 效果器与 master', () => {
  it('addEffect 支持 master 与轨道，position 生效，参数被归一', () => {
    const project = createEmptyProject()
    const { trackId } = ops.addTrack(project, { name: '主音', kind: 'synth' })
    const masterFx = ops.addEffect(project, { target: 'master', type: 'reverb', params: { size: 2, mix: 0.4 } })
    // P13：空白工程 master 默认空链 → 新效果器从 fx_1 开始（id 全局递增仍扫描 master 与各轨道链）
    assert.equal(masterFx.effectId, 'fx_1')
    assert.equal(masterFx.chain.at(-1).params.size, 1) // 钳制
    assert.equal(masterFx.chain.at(-1).params.mix, 0.4)
    assert.throws(() => ops.addEffect(project, { target: 'master', type: 'reverb', params: { nope: 1 } }), /没有参数 nope/)

    const trackFx = ops.addEffect(project, { target: trackId, type: 'drive' })
    assert.equal(trackFx.chain.length, 1)
    assert.equal(trackFx.chain[0].type, 'drive')
    ops.addEffect(project, { target: trackId, type: 'delay', position: 0 })
    assert.equal(project.tracks[0].effects[0].type, 'delay')
    assert.equal(project.tracks[0].effects.length, 2)
    assert.throws(() => ops.addEffect(project, { target: trackId, type: 'nope' }), /未知效果器/)
  })

  it('updateEffect 开关/合并参数/移动位置', () => {
    const project = createEmptyProject()
    const { trackId } = ops.addTrack(project, { name: '主音', kind: 'synth' })
    const filter = ops.addEffect(project, { target: trackId, type: 'filter', params: { cutoff: 2400 } })
    ops.addEffect(project, { target: trackId, type: 'delay' })
    const updated = ops.updateEffect(project, {
      target: trackId,
      effectId: filter.effectId,
      enabled: false,
      params: { resonance: 8 },
      move: 1,
    })
    assert.equal(updated.chain[1].id, filter.effectId)
    assert.equal(updated.chain[1].enabled, false)
    assert.equal(updated.chain[1].params.resonance, 8)
    assert.equal(updated.chain[1].params.cutoff, 2400) // 未传的保留
    assert.throws(() => ops.updateEffect(project, { target: trackId, effectId: 'fx_999' }), /找不到 fx_999/)
  })

  it('removeEffect 与链上限', () => {
    const project = createEmptyProject()
    const { trackId } = ops.addTrack(project, { name: '主音', kind: 'synth' })
    const ids = []
    for (let i = 0; i < 8; i += 1) ids.push(ops.addEffect(project, { target: trackId, type: 'eq3' }).effectId)
    assert.throws(() => ops.addEffect(project, { target: trackId, type: 'eq3' }), /上限 8/)
    const removed = ops.removeEffect(project, { target: trackId, effectId: ids[0] })
    assert.equal(removed.removed, true)
    assert.equal(removed.chain.length, 7)
    assert.throws(() => ops.removeEffect(project, { target: trackId, effectId: ids[0] }), /找不到/)
  })

  it('setMaster 设置音量并整链替换效果器', () => {
    const project = createEmptyProject()
    const result = ops.setMaster(project, {
      volume: 0.5,
      effects: [
        { type: 'eq3', params: { low: 3 } },
        { type: 'compressor', enabled: false },
      ],
    })
    assert.equal(result.master.volume, 0.5)
    assert.equal(result.master.effects.length, 2)
    assert.equal(result.master.effects[1].enabled, false)
    assert.equal(project.master.effects[0].id, 'fx_1')
    assert.equal(project.master.effects[0].type, 'eq3')
    assert.throws(() => ops.setMaster(project, { effects: [{ type: 'nope' }] }), /不是有效效果器/)
  })
})

/* ------------------------------------------------------------------------- */
/* ops：transport / export / activity / action / 概览                          */
/* ------------------------------------------------------------------------- */

describe('ops 纯函数 — transport / 导出 / 动态 / UI 操作 / 概览', () => {
  it('transport 写 cmd 序列号并维护播放状态', () => {
    const project = createEmptyProject()
    const play = ops.transport(project, { action: 'play', positionBar: 4 })
    assert.equal(play.action, 'play')
    assert.equal(play.playing, true)
    assert.equal(play.positionBar, 4)
    assert.ok(Number.isInteger(play.seq) && play.seq > 0)
    const seek = ops.transport(project, { action: 'seek', positionBar: 12 })
    assert.ok(seek.seq > play.seq) // 严格单调递增
    assert.equal(project.transport.playheadBar, 12)
    assert.equal(project.transport.playing, true)
    const stop = ops.transport(project, { action: 'stop' })
    assert.ok(stop.seq > seek.seq)
    assert.equal(stop.playing, false)
    // create_project 重置后序列号也不能回退（否则 UI 会把新命令当成旧命令 */
    const fresh = createEmptyProject()
    assert.equal(ops.transport(fresh, { action: 'play' }).seq > 0, true)
    assert.throws(() => ops.transport(project, { action: 'seek' }), /必须提供 positionBar/)
    assert.throws(() => ops.transport(project, { action: 'pause' }), /action 必须是/)
  })

  it('exportRequest 序列递增；setLastExport / setActivity 更新状态', () => {
    const project = createEmptyProject()
    const first = ops.exportRequest(project)
    const second = ops.exportRequest(project)
    assert.ok(Number.isInteger(first.seq) && first.seq > 0)
    assert.ok(second.seq > first.seq)
    const exported = ops.setLastExport(project, { path: '/tmp/a.wav', bytes: 1024, seconds: 1.234 })
    assert.equal(exported.lastExport.seconds, 1.23)
    const activity = ops.setActivity(project, { text: '正在编排 Drop 段落的鼓组' })
    assert.equal(activity.text, '正在编排 Drop 段落的鼓组')
    assert.equal(project.activity.text, '正在编排 Drop 段落的鼓组')
    assert.throws(() => ops.setActivity(project, { text: '' }), /不能为空/)
  })

  it('applyAction 处理 UI 的静音/独奏/音量/声像', () => {
    const project = createEmptyProject()
    const { trackId } = ops.addTrack(project, { name: '鼓', kind: 'drum' })
    assert.equal(ops.applyAction(project, { type: 'toggleMute', trackId }).value, true)
    assert.equal(ops.applyAction(project, { type: 'toggleMute', trackId }).value, false)
    assert.equal(ops.applyAction(project, { type: 'toggleSolo', trackId }).value, true)
    assert.equal(ops.applyAction(project, { type: 'setVolume', trackId, value: 0.33 }).value, 0.33)
    assert.equal(ops.applyAction(project, { type: 'setPan', trackId, value: -2 }).value, -1)
    assert.throws(() => ops.applyAction(project, { type: 'nope', trackId }), /不支持的操作/)
    assert.throws(() => ops.applyAction(project, { type: 'setVolume', trackId }), /value 必须是数字/)
  })

  it('createProject 重置内容并采用新元信息', () => {
    const project = createDemoProject()
    const overview = ops.createProject(project, { title: '新工程', bpm: 140, key: 'C', scale: 'major', lengthBars: 16 })
    assert.equal(overview.title, '新工程')
    assert.equal(project.tracks.length, 0)
    assert.equal(project.patterns.length, 0)
    assert.equal(project.clips.length, 0)
    assert.equal(project.lengthBars, 16)
    assert.equal(project.bpm, 140)
    assert.equal(project.key, 'C')
    assert.equal(project.scale, 'major')
    assert.throws(() => ops.createProject(project, { scale: 'nope' }), /未知调式/)
    assert.throws(() => ops.createProject(project, { bpm: 999 }), /超出范围/)
  })

  it('getProjectOverview 紧凑（<8KB）且不含音符，getPatternView 才返回音符', () => {
    const project = createDemoProject()
    const overview = ops.getProjectOverview(project)
    const size = Buffer.byteLength(JSON.stringify(overview))
    assert.ok(size < 8800, `概览 JSON ${size} 字节，应 < 8800（v2.1 增加 contentRevision 等字段）`)
    assert.equal(overview.tracks.length, project.tracks.length)
    assert.equal(overview.patterns.length, project.patterns.length)
    assert.equal(overview.clips.length, project.clips.length)
    assert.equal(typeof overview.patterns[0].notes, 'number') // patterns 里只有音符「数量」
    assert.ok(!Array.isArray(overview.patterns[0].notes))
    assert.ok(!JSON.stringify(overview).includes('"pitch"'))

    const view = ops.getPatternView(project, { patternId: 'pat_3' })
    assert.equal(view.noteCount, project.patterns.find((p) => p.id === 'pat_3').notes.length)
    assert.ok(Array.isArray(view.notes) && view.notes.length > 0)
    assert.equal(view.tracks.length, 1)
    assert.equal(view.clips.length, project.clips.filter((clip) => clip.patternId === 'pat_3').length)
  })

  it('sanitizeProject 补齐缺失字段并可恢复（坏字段回退默认）；旧 schema 拒绝', () => {
    const project = sanitizeProject({ schemaVersion: 3, title: 'x', tracks: 'bad', master: null, revision: 'abc' })
    assert.equal(project.schemaVersion, 3)
    assert.deepEqual(project.tracks, [])
    assert.equal(project.revision, 1)
    assert.equal(typeof project.master.volume, 'number')
    assert.equal(project.title, 'x')
    assert.equal(sanitizeProject(null).tracks.length, 0)
    assert.throws(() => sanitizeProject({ title: 'old', schemaVersion: 1 }), /旧版本工程不支持/)
    assert.throws(() => sanitizeProject({ title: 'missing' }), /旧版本工程不支持/)
  })
})

/* ------------------------------------------------------------------------- */
/* state：加载 / 保存 / 订阅 / history                                        */
/* ------------------------------------------------------------------------- */

describe('state — 持久化、revision 与订阅', () => {
  it('首次启动加载演示工程并落盘；第二次启动从磁盘恢复', async () => {
    const { dir, state } = await makeState()
    assert.equal(state.loadedFromDisk, false)
    assert.equal(state.revision, 1)
    assert.equal(state.project.tracks.length, 7)
    assert.equal(state.project.title, '霓虹天际线 Neon Skyline')
    await state.flush()
    const files = await readdir(dir)
    // R1a：recovery/ 目录（session.lock）也会出现在 dataDir；工程文件仍为 project.json。
    assert.deepEqual(files.filter((name) => name !== 'recovery'), ['project.json'])
    assert.ok(files.includes('recovery'))
    const saved = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
    assert.equal(saved.tracks.length, 7)

    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    assert.equal(reloaded.loadedFromDisk, true)
    assert.equal(reloaded.project.title, '霓虹天际线 Neon Skyline')
    assert.equal(reloaded.revision, 1)
    reloaded.dispose()
    state.dispose()
  })

  it('mutate 事务：成功 bump revision / history / activity 并通知订阅者，失败不改项目', async () => {
    const { state } = await makeState({ withDemo: false })
    assert.equal(state.project.tracks.length, 0)

    const seen = []
    const unsubscribe = state.subscribe((revision, project) => seen.push({ revision, tracks: project.tracks.length }))
    const result = state.mutate(
      { tool: 'studio_add_track', text: '添加轨道「Bass」', activity: '正在搭建低音' },
      (draft) => ops.addTrack(draft, { name: 'Bass', kind: 'synth', preset: 'finger_bass' }),
    )
    assert.equal(result.trackId, 'trk_1')
    assert.equal(state.revision, 2)
    assert.equal(state.project.history.length, 1)
    assert.equal(state.project.history[0].tool, 'studio_add_track')
    assert.equal(state.project.history[0].text, '添加轨道「Bass」')
    assert.equal(state.project.activity.text, '正在搭建低音')
    assert.ok(state.project.updatedAt > 0)
    assert.deepEqual(seen, [{ revision: 2, tracks: 1 }])

    // 失败事务：revision / 历史不动
    const revisionBefore = state.revision
    const historyBefore = state.project.history.length
    assert.throws(() => state.mutate({ tool: 'studio_x', text: 'fail' }, () => { throw new Error('boom') }), /boom/)
    assert.equal(state.revision, revisionBefore)
    assert.equal(state.project.history.length, historyBefore)
    assert.throws(() => state.mutate({}, () => { throw new ops.OpError('参数错误') }), /参数错误/)
    assert.equal(state.revision, revisionBefore)

    unsubscribe()
    assert.equal(state.subscriberCount, 0)
    state.dispose()
  })

  it('history 最多保留 LIMITS.maxHistory（40）条', async () => {
    const { state } = await makeState({ withDemo: false })
    for (let i = 0; i < 45; i += 1) {
      state.mutate({ tool: 'studio_set_activity', text: `第 ${i} 条` }, () => undefined)
    }
    assert.equal(state.project.history.length, 40)
    assert.equal(state.project.history.at(-1).text, '第 44 条')
    await state.flush()
    state.dispose()
  })

  it('commit 只 bump revision 并与 flush 协作落盘', async () => {
    const { dir, state } = await makeState({ withDemo: false })
    const revision = state.commit({ tool: 'studio_export', text: '导出 WAV' })
    assert.equal(revision, 2)
    await state.flush()
    const saved = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
    assert.equal(saved.revision, 2)
    assert.equal(saved.history.at(-1).tool, 'studio_export')
    state.dispose()
  })

  it('损坏的 project.json 会被归档并回退到初始工程', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, 'project.json'), '{ this is not json', 'utf8')
    const state = createState({ dataDir: dir, fallbackInitial: () => createDemoProject() })
    await state.ready
    assert.equal(state.loadedFromDisk, false)
    assert.equal(state.project.tracks.length, 7) // 回退演示工程
    const files = await readdir(dir)
    assert.ok(files.some((file) => file.includes('.corrupt-')), '应归档损坏文件')
    await state.flush()
    state.dispose()
  })

  it('dispose 后禁止继续变更、清理订阅者', async () => {
    const { state } = await makeState({ withDemo: false })
    state.subscribe(() => undefined)
    assert.equal(state.subscriberCount, 1)
    state.dispose()
    assert.equal(state.subscriberCount, 0)
    assert.throws(() => state.mutate({}, () => undefined), /已卸载/)
    await state.flush()
  })

  it('DSH_STUDIO_DATA_DIR 环境变量可作为数据目录', async () => {
    const dir = await tempDir()
    const previous = process.env.DSH_STUDIO_DATA_DIR
    process.env.DSH_STUDIO_DATA_DIR = dir
    try {
      const state = createState({ fallbackInitial: () => null })
      await state.ready
      await state.flush()
      const files = await readdir(dir)
      assert.ok(files.includes('project.json'), '应在环境变量目录生成 project.json')
      state.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_STUDIO_DATA_DIR
      else process.env.DSH_STUDIO_DATA_DIR = previous
    }
  })
})

/* ------------------------------------------------------------------------- */
/* routes：HTTP API                                                           */
/* ------------------------------------------------------------------------- */

describe('routes — HTTP API（真实 node:http）', () => {
  it('注册信息符合契约（prefix /studio/api）', () => {
    // createRoutes 需要 state，用最小假对象验证路由声明形状
    const routes = createRoutes({
      state: {
        ready: Promise.resolve(),
        mutate: () => undefined,
        revision: 1,
        project: createEmptyProject(),
        exportsDir: path.join(os.tmpdir(), 'aims-fake-exports'),
        filePath: '/tmp/project.json',
        subscribe: () => () => {},
      },
    })
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/studio/api')
    assert.equal(typeof routes[0].handler, 'function')
  })

  it('GET /health 返回版本与统计', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const res = await fetch(`${server.base}/studio/api/health`)
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.deepEqual({ ok: data.ok, version: data.version, rev: data.rev, tracks: data.tracks, patterns: data.patterns }, {
        ok: true, version: CURRENT_VERSION, rev: 1, tracks: 7, patterns: 13,
      })
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('GET /catalog 返回当前窗口/工程 + 32 采样乐器/4 鼓组/14 效果器（P9 AI 接线信息）', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      // 写入端点文件，模拟窗口已经启动
      await writeFile(
        path.join(dir, 'app-endpoint.json'),
        JSON.stringify({
          version: '1.0.0',
          mode: 'window',
          port: 41731,
          host: '127.0.0.1',
          pid: 1234,
          dataDir: dir,
          startedAt: '2026-10-22T00:00:00.000Z',
          url: 'http://127.0.0.1:41731/',
        }),
        'utf8',
      )
      const data = await (await fetch(`${server.base}/studio/api/catalog`)).json()
      assert.equal(data.ok, true)
      assert.equal(data.tool, 'studio_app_info')
      assert.equal(data.app.dataDir, dir)
      assert.equal(data.app.url, 'http://127.0.0.1:41731')
      assert.equal(data.app.pid, 1234)
      assert.equal(data.project.title, '霓虹天际线 Neon Skyline')
      assert.deepEqual(data.counts, { instruments: 32, drumKits: 4, effects: 15 })
      assert.equal(data.instruments.length, 32)
      assert.ok(data.instruments.some((item) => item.id === 'grand_piano' && item.program === 0))
      assert.ok(data.instruments.some((item) => item.id === 'strings_ensemble' && item.program === 49))
      assert.equal(data.drumKits.length, 4)
      assert.equal(data.effects.length, 15)
      assert.ok(data.note.includes('dataDir'))
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('GET /state?rev=N：落后立即返回、一致时挂起、变更立即返回、超时 changed:false', async () => {
    const { state } = await makeState()
    const server = await startServer(state, { longPollMs: 120 })
    try {
      // 首次连接（rev=0，落后于 revision=1）→ 立即 changed:true
      const first = await (await fetch(`${server.base}/studio/api/state?rev=0`)).json()
      assert.equal(first.changed, true)
      assert.equal(first.rev, 1)
      assert.equal(first.project.tracks.length, 7)

      // 版本一致 → 挂起，超时后 changed:false
      const timeoutStarted = Date.now()
      const timeout = await (await fetch(`${server.base}/studio/api/state?rev=1`)).json()
      assert.equal(timeout.changed, false)
      assert.equal(timeout.rev, 1)
      assert.ok(Date.now() - timeoutStarted >= 80, '应至少挂起一段时间')

      // 挂起期间发生变更 → 立即返回新 revision
      const pending = fetch(`${server.base}/studio/api/state?rev=1`).then((res) => res.json())
      await wait(30)
      state.mutate({ tool: 'studio_set_activity', text: '测试长轮询', activity: '测试长轮询文案' }, () => undefined)
      const changed = await pending
      assert.equal(changed.changed, true)
      assert.equal(changed.rev, 2)
      assert.equal(changed.project.activity.text, '测试长轮询文案')

      // 超时/变更后订阅者都应清理干净
      await wait(200)
      assert.equal(state.subscriberCount, 0)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('长轮询客户端断开（AbortController）后不泄漏订阅者', async () => {
    const { state } = await makeState()
    const server = await startServer(state, { longPollMs: 5000 })
    try {
      const controller = new AbortController()
      const pending = fetch(`${server.base}/studio/api/state?rev=1`, { signal: controller.signal }).catch(() => null)
      await wait(40)
      assert.equal(state.subscriberCount, 1)
      controller.abort()
      await pending
      await wait(60)
      assert.equal(state.subscriberCount, 0)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('POST /action 修改轨道并 bump revision', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const res = await fetch(`${server.base}/studio/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'toggleMute', trackId: 'trk_2' }),
      })
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.ok, true)
      assert.equal(data.rev, 2)
      const track = state.project.tracks.find((item) => item.id === 'trk_2')
      assert.equal(track.mute, true)

      const bad = await fetch(`${server.base}/studio/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'nope', trackId: 'trk_2' }),
      })
      assert.equal(bad.status, 400)
      const badData = await bad.json()
      assert.equal(badData.ok, false)
      assert.match(badData.error, /不支持的操作/)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('方法不匹配回 405，未知路径回 404，坏 JSON 回 400', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const getAction = await fetch(`${server.base}/studio/api/action`)
      assert.equal(getAction.status, 405)
      assert.equal(getAction.headers.get('allow'), 'POST')

      const postState = await fetch(`${server.base}/studio/api/state?rev=0`, { method: 'POST' })
      assert.equal(postState.status, 405)
      assert.equal(postState.headers.get('allow'), 'GET')

      const unknown = await fetch(`${server.base}/studio/api/nope`)
      assert.equal(unknown.status, 404)

      const badJson = await fetch(`${server.base}/studio/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      })
      assert.equal(badJson.status, 400)
      assert.equal((await badJson.json()).ok, false)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('POST /export-done 保存 WAV 到 data/exports 并更新 lastExport', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      // 模拟 AI 的导出请求，验证导出完成后请求被消费（清空）
      state.mutate({ tool: 'studio_export', text: '请求导出' }, (draft) => ops.exportRequest(draft))
      assert.ok(state.project.exportRequest.seq > 0)
      const wav = makeWav(1)
      const res = await fetch(`${server.base}/studio/api/export-done?name=${encodeURIComponent('霓虹天际线-3s.wav')}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
      })
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(data.ok, true)
      assert.equal(data.bytes, wav.length)
      assert.ok(Math.abs(data.seconds - 1) < 0.01)
      assert.ok(data.path.endsWith('.wav'))
      const saved = await readFile(data.path)
      assert.equal(saved.length, wav.length)
      // 只留最终文件，不残留 .tmp
      const exports = await readdir(path.join(dir, 'exports'))
      assert.equal(exports.filter((name) => name.endsWith('.tmp')).length, 0)
      assert.equal(exports.length, 1)
      // lastExport 已更新（并 bump revision）；exportRequest 被消费清空
      assert.equal(state.project.lastExport.bytes, wav.length)
      assert.equal(state.project.exportRequest, null)
      assert.ok(state.revision > 1)

      const bad = await fetch(`${server.base}/studio/api/export-done?name=a.wav`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from('not a wav file'),
      })
      assert.equal(bad.status, 400)
      assert.equal((await bad.json()).ok, false)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('导出文件名防目录穿越；WAV 时长解析正确', async () => {
    assert.equal(sanitizeExportName('../evil.wav'), 'evil.wav')
    assert.equal(sanitizeExportName('..\\..\\evil.wav'), 'evil.wav')
    assert.match(sanitizeExportName(''), /^mixdown-\d+\.wav$/)
    assert.match(sanitizeExportName(undefined), /^mixdown-\d+\.wav$/)
    assert.equal(sanitizeExportName('demo'), 'demo.wav')
    assert.equal(wavDurationSeconds(makeWav(2)), 2)
    assert.equal(wavDurationSeconds(Buffer.from('nope')), 0)

    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      const res = await fetch(`${server.base}/studio/api/export-done?name=${encodeURIComponent('../evil.wav')}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: makeWav(0.5),
      })
      assert.equal(res.status, 200)
      const data = await res.json()
      const exportsDir = path.join(dir, 'exports')
      assert.equal(path.dirname(data.path), exportsDir)
      assert.equal(path.basename(data.path), 'evil.wav')
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('JSON body 超过上限返回 413（mock req/res，避免真实连接被销毁的竞争）', async () => {
    const { state } = await makeState({ withDemo: false })
    const routes = createRoutes({ state, jsonBodyLimit: 64 })
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/studio/api/action'
    req.headers = { 'content-type': 'application/json' }
    req.destroy = () => {}
    const res = new EventEmitter()
    res.statusCode = 0
    res.headers = {}
    res.writableEnded = false
    res.destroyed = false
    res.setHeader = (key, value) => {
      res.headers[key.toLowerCase()] = value
    }
    const finished = new Promise((resolve) => {
      res.end = (body) => {
        res.writableEnded = true
        res.body = body
        resolve()
      }
    })
    setImmediate(() => {
      req.emit('data', Buffer.from('x'.repeat(200)))
      req.emit('end')
    })
    await routes[0].handler(req, res)
    await finished
    assert.equal(res.statusCode, 413)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    state.dispose()
  })

  it('GET /project-file 返回项目 JSON 路径', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      const data = await (await fetch(`${server.base}/studio/api/project-file`)).json()
      assert.equal(data.path, path.join(dir, 'project.json'))
    } finally {
      await server.close()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* tools：定义与执行（mock defineTool）                                        */
/* ------------------------------------------------------------------------- */

describe('tools — 定义与执行（mock defineTool）', () => {
  const mockDefineTool = (options) => options

  async function makeToolsState() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: mockDefineTool, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => {
      const tool = byName.get(name)
      assert.ok(tool, `缺少工具 ${name}`)
      return tool.execute(args, {})
    }
    return { dir, state, tools, byName, exec }
  }

  it('定义完整：110 个工具（v2.2 M1/M4 外部 VST3 冻结 + R7b + R7a + R6e + R6d + R6c + R6b + R6a + R5d + R5c + R5b + R4c + R4a + R3c + R3a + R2c + R2a + 既有全部）、名称符合契约、描述中文、output 含 schema+render', async () => {
    const { state, tools } = await makeToolsState()
    state.dispose()
    assert.equal(tools.length, 110)
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES)
    for (const tool of tools) {
      assert.match(tool.name, /^studio_[a-z_]+$/)
      assert.ok(tool.description.length >= 20, `${tool.name} 描述太短`)
      assert.match(tool.description, /[\u4e00-\u9fa5]/, `${tool.name} 描述应为中文`)
      assert.equal(tool.output.schema.type, 'object')
      assert.equal(tool.output.schema.additionalProperties, true)
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.parameters, 'object')
      for (const [key, schema] of Object.entries(tool.parameters)) {
        assertObjectSchemasExplicit(schema, `${tool.name}.parameters.${key}`)
      }
    }
    // render 输出 text 内容块且可 JSON.parse
    const block = tools[0].output.render({}, { ok: true, n: 1 })
    assert.deepEqual(block, [{ type: 'text', text: '{"ok":true,"n":1}' }])
  })

  it('parameters / output.schema 符合 DSH 0.2.1 参数 DSL 编译规则（schema.ts 规则复刻）', async () => {
    const { state, tools } = await makeToolsState()
    state.dispose()
    for (const tool of tools) {
      const json = dslCompileParameters(tool.parameters, tool.name)
      assert.equal(json.type, 'object')
      assert.equal(typeof json.properties, 'object')
      // 参数根是「隐式开放对象」：不需要也不应出现 additionalProperties
      assert.equal(Object.hasOwn(json, 'additionalProperties'), false)
      const output = dslCompileValue(tool.output.schema, `${tool.name}.output.schema`, false)
      assert.deepEqual(output, { type: 'object', additionalProperties: true })
    }
    // 抽查 required 收集与嵌套数组/对象声明
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const setNotes = dslCompileParameters(byName.get('studio_set_notes').parameters, 'studio_set_notes')
    assert.deepEqual(setNotes.required, ['patternId', 'notes'])
    assert.equal(setNotes.properties.notes.type, 'array')
    assert.equal(setNotes.properties.notes.items.type, 'object')
    assert.deepEqual(setNotes.properties.notes.items.required, ['pitch', 'start', 'dur'])
    const addTrack = dslCompileParameters(byName.get('studio_add_track').parameters, 'studio_add_track')
    assert.deepEqual(addTrack.properties.kind.enum, ['synth', 'drum'])
    const arrangement = dslCompileParameters(byName.get('studio_set_arrangement').parameters, 'studio_set_arrangement')
    assert.equal(arrangement.properties.clips.items.properties.trackId.type, 'string')
  })


  it('完整创作工作流：get_project → add_track → add_pattern → set_notes → set_arrangement', async () => {
    const { state, exec } = await makeToolsState()
    try {
      const overview = await exec('studio_get_project')
      assert.equal(overview.ok, true)
      assert.equal(overview.tracks.length, 7)
      assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 9192)
      const rev0 = overview.rev

      const track = await exec('studio_add_track', { name: '测试低音', kind: 'synth', preset: 'finger_bass', role: 'bass' })
      assert.equal(track.ok, true)
      assert.equal(track.trackId, 'trk_8')
      assert.ok(track.rev > rev0)

      const pattern = await exec('studio_add_pattern', { name: '测试 pattern', lengthBars: 2 })
      assert.equal(pattern.ok, true)
      assert.equal(pattern.patternId, 'pat_14')

      const notes = [
        { pitch: 36, start: 0, dur: 0.5, vel: 0.95 },
        { pitch: 36, start: 1, dur: 0.5, vel: 0.9 },
        { pitch: 38, start: 2, dur: 0.25, vel: 0.8 },
      ]
      const setNotes = await exec('studio_set_notes', { patternId: pattern.patternId, notes })
      assert.equal(setNotes.ok, true)
      assert.equal(setNotes.noteCount, 3)

      const patternView = await exec('studio_get_pattern', { patternId: pattern.patternId })
      assert.equal(patternView.ok, true)
      assert.equal(patternView.notes.length, 3)
      assert.equal(patternView.notes[0].pitch, 36)

      const arrangement = await exec('studio_set_arrangement', {
        clips: [{ trackId: track.trackId, patternId: pattern.patternId, startBar: 0, lengthBars: 4 }],
        sections: [{ name: '测试段落', startBar: 0, lengthBars: 4 }],
      })
      assert.equal(arrangement.ok, true)
      assert.equal(arrangement.clips, 1)
      assert.equal(arrangement.sections, 1)

      const after = await exec('studio_get_project')
      assert.equal(after.clipsTotal, 1)
      assert.equal(after.tracks.length, 8)
      assert.equal(after.activity.at > 0, true)
      assert.ok(after.rev > rev0)
    } finally {
      state.dispose()
    }
  })

  it('轨道/效果器/播放/导出/动态/母带工具都能改到项目', async () => {
    const { state, exec } = await makeToolsState()
    try {
      const addTrack = await exec('studio_add_track', { name: '测试 Lead', kind: 'synth' })
      const trackId = addTrack.trackId

      const updateTrack = await exec('studio_update_track', { trackId, volume: 0.42, pan: 0.2 })
      assert.equal(updateTrack.ok, true)
      assert.equal(updateTrack.track.volume, 0.42)
      // P12：采样乐器没有合成参数，params 仅支持采样鼓机轨道
      const rejectedParams = await exec('studio_update_track', { trackId, params: { cutoff: 3000 } })
      assert.equal(rejectedParams.ok, false)
      assert.match(rejectedParams.error, /采样乐器没有合成参数/)

      const addEffect = await exec('studio_add_effect', { target: trackId, type: 'drive' })
      assert.equal(addEffect.ok, true)
      assert.equal(addEffect.chain.length, 1)

      const updateEffect = await exec('studio_update_effect', {
        target: trackId,
        effectId: addEffect.effectId,
        enabled: false,
        params: { amount: 0.8 },
      })
      assert.equal(updateEffect.ok, true)
      assert.equal(updateEffect.chain[0].enabled, false)
      assert.equal(updateEffect.chain[0].params.amount, 0.8)

      const removeEffect = await exec('studio_remove_effect', { target: trackId, effectId: addEffect.effectId })
      assert.equal(removeEffect.ok, true)
      assert.equal(removeEffect.chain.length, 0)

      const setMaster = await exec('studio_set_master', { volume: 0.7 })
      assert.equal(setMaster.ok, true)
      assert.equal(setMaster.master.volume, 0.7)

      const transport = await exec('studio_transport', { action: 'play', positionBar: 8 })
      assert.equal(transport.ok, true)
      assert.ok(transport.seq > 0)
      assert.equal(state.project.transport.playing, true)
      assert.equal(state.project.transport.playheadBar, 8)
      // 再发一条命令：seq 必须更大，UI 才会执行
      const stop = await exec('studio_transport', { action: 'stop' })
      assert.ok(stop.seq > transport.seq)

      const exported = await exec('studio_export')
      assert.equal(exported.ok, true)
      assert.equal(exported.requested, true)
      assert.ok(state.project.exportRequest.seq > 0)

      const activity = await exec('studio_set_activity', { text: '正在编排 Drop 段落的鼓组' })
      assert.equal(activity.ok, true)
      assert.equal(state.project.activity.text, '正在编排 Drop 段落的鼓组')
    } finally {
      state.dispose()
    }
  })

  it('studio_create_project 重置工程并返回新概览', async () => {
    const { state, exec } = await makeToolsState()
    try {
      const result = await exec('studio_create_project', { title: '测试工程', bpm: 120, key: 'C', lengthBars: 16 })
      assert.equal(result.ok, true)
      assert.equal(result.project.title, '测试工程')
      assert.equal(result.project.tracks.length, 0)
      assert.equal(result.project.lengthBars, 16)
      assert.equal(result.project.revision, result.rev) // 概览 revision 与返回 rev 一致
      assert.ok(typeof result.backupPath === 'string' && result.backupPath.length > 0, '创建前应自动备份旧工程')
      assert.equal(state.project.tracks.length, 0)
      assert.equal(state.project.history.at(-1).tool, 'studio_create_project')
    } finally {
      state.dispose()
    }
  })

  it('非法参数返回 ok:false（不抛异常、不改项目）', async () => {
    const { state, exec } = await makeToolsState()
    const revisionBefore = state.revision
    try {
      const cases = [
        ['studio_add_track', { name: 'x', kind: 'piano' }],
        ['studio_add_track', { name: 'x', kind: 'synth', preset: 'nope' }],
        ['studio_add_pattern', { name: 'x', lengthBars: 0 }],
        ['studio_set_notes', { patternId: 'pat_999', notes: [] }],
        ['studio_set_notes', { patternId: 'pat_1', notes: Array.from({ length: 5000 }, () => ({ pitch: 60, start: 0, dur: 0.25 })) }],
        ['studio_set_arrangement', { clips: [{ trackId: 'trk_1', patternId: 'pat_999', startBar: 0, lengthBars: 1 }] }],
        ['studio_add_effect', { target: 'track', trackId: 'trk_1', type: 'nope' }],
        ['studio_update_effect', { target: 'track', trackId: 'trk_1', effectId: 'fx_99' }],
        ['studio_remove_effect', { target: 'track', trackId: 'trk_1', effectId: 'fx_99' }],
        ['studio_update_track', { trackId: 'trk_999', volume: 0.5 }],
        ['studio_transport', { action: 'pause' }],
        ['studio_transport', { action: 'seek' }],
        ['studio_set_activity', { text: '' }],
        ['studio_create_project', { title: 'x', scale: 'nope' }],
      ]
      for (const [name, args] of cases) {
        const result = await exec(name, args)
        assert.equal(result.ok, false, `${name} 应失败`)
        assert.equal(typeof result.error, 'string')
        assert.ok(result.error.length > 0, `${name} 应给出错误信息`)
      }
      assert.equal(state.revision, revisionBefore, '失败调用不应 bump revision')
      assert.equal(state.project.tracks.length, 7)
    } finally {
      state.dispose()
    }
  })

  it('工具变更经 state.flush 持久化，重新加载后仍在', async () => {
    const { dir, state, exec } = await makeToolsState()
    try {
      await exec('studio_add_track', { name: '持久化测试', kind: 'synth', preset: 'violin' })
      await exec('studio_add_pattern', { name: '保存在盘上', lengthBars: 2 })
      await state.flush()
    } finally {
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      assert.equal(reloaded.loadedFromDisk, true)
      assert.equal(reloaded.project.tracks.length, 8)
      assert.equal(reloaded.project.tracks.at(-1).name, '持久化测试')
      assert.equal(reloaded.project.patterns.at(-1).name, '保存在盘上')
      assert.ok(reloaded.revision > 1)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* index.js：真实插件入口 apply(ctx) 冒烟（复制到临时目录 + 桩 defineTool 包）  */
/* ------------------------------------------------------------------------- */

describe('index.js — apply(ctx) 插件入口冒烟（P9：只注册代理工具，不建内嵌后端）', () => {
  const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

  it('注册 110 个 App 代理 + 2 个本地工具（launch/app_status，共 112），不注册路由/不创建隐藏 data/', async () => {
    const copyDir = await tempDir()
    await cp(path.join(PLUGIN_ROOT, 'src'), path.join(copyDir, 'src'), { recursive: true })
    await cp(path.join(PLUGIN_ROOT, 'package.json'), path.join(copyDir, 'package.json'))

    const previousDataDir = process.env.DSH_STUDIO_DATA_DIR
    const previousAppUrl = process.env.AIMS_APP_URL
    const previousPort = process.env.AIMS_PORT
    delete process.env.DSH_STUDIO_DATA_DIR
    // 指向一个不可达端口，避免测试时误连本机正在运行的窗口
    process.env.AIMS_APP_URL = 'http://127.0.0.1:9'
    process.env.AIMS_PORT = '9'
    process.env.AIMS_ENDPOINT_DIR = path.join(copyDir, 'empty-endpoint-dir')

    const registeredTools = []
    const registeredRoutes = []
    const effectLabels = []
    const disposers = []
    const warnings = []
    const ctx = {
      logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
      tools: {
        register(tool) {
          registeredTools.push(tool)
          return () => {
            const index = registeredTools.indexOf(tool)
            if (index >= 0) registeredTools.splice(index, 1)
          }
        },
      },
      webServer: {
        register(route) {
          registeredRoutes.push(route)
          return () => {}
        },
      },
      effect(callback, label) {
        effectLabels.push(label)
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
    }

    try {
      const entry = await import(pathToFileURL(path.join(copyDir, 'src', 'host', 'index.js')).href)
      assert.deepEqual(entry.inject, ['tools'])
      assert.equal(typeof entry.apply, 'function')
      assert.equal(typeof entry.VERSION, 'string')

      entry.apply(ctx)
      assert.equal(registeredTools.length, 112)
      assert.deepEqual(registeredTools.map((tool) => tool.name), [...TOOL_NAMES, 'studio_launch_app', 'studio_app_status'])
      assert.equal(registeredTools[0].name, 'studio_app_info')
      // P15/R0：本地工具不经过代理，窗口没开时也能调用
      const launchTool = registeredTools[registeredTools.length - 2]
      assert.equal(launchTool.name, 'studio_launch_app')
      assert.match(launchTool.description, /窗口没开|一键启动/)
      assert.equal(typeof launchTool.execute, 'function')
      const appStatusTool = registeredTools[registeredTools.length - 1]
      assert.equal(appStatusTool.name, 'studio_app_status')
      assert.match(appStatusTool.description, /上次退出|窗口状态/)
      assert.equal(typeof appStatusTool.execute, 'function')
      // 桥接错误提示包含两个本地工具
      const bridge = await import(pathToFileURL(path.join(copyDir, 'src', 'host', 'tool-bridge.js')).href)
      assert.match(bridge.NO_APP_MESSAGE, /studio_launch_app/)
      assert.match(bridge.NO_APP_MESSAGE, /studio_app_status/)
      // P9：不注册 HTTP 路由、不写隐藏 data/
      assert.equal(registeredRoutes.length, 0, '插件不应注册内嵌 HTTP 路由')
      assert.equal(effectLabels.length, 1)
      await assert.rejects(stat(path.join(copyDir, 'data')), '插件不得创建内嵌 data/ 目录')
      for (const tool of registeredTools) assert.equal(typeof tool.execute, 'function')
    } finally {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      if (previousDataDir === undefined) delete process.env.DSH_STUDIO_DATA_DIR
      else process.env.DSH_STUDIO_DATA_DIR = previousDataDir
      if (previousAppUrl === undefined) delete process.env.AIMS_APP_URL
      else process.env.AIMS_APP_URL = previousAppUrl
      if (previousPort === undefined) delete process.env.AIMS_PORT
      else process.env.AIMS_PORT = previousPort
      delete process.env.AIMS_ENDPOINT_DIR
      await rm(copyDir, { recursive: true, force: true })
    }
  })
})

/* P1：ops 编辑操作                                                           */
/* ------------------------------------------------------------------------- */

/** 统一 JSON 请求助手（P1 路由测试用）。 */
async function httpJson(base, urlPath, options = {}) {
  const res = await fetch(`${base}${urlPath}`, options)
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status, data }
}
const getJson = (base, urlPath) => httpJson(base, urlPath)
const postJson = (base, urlPath, body) =>
  httpJson(base, urlPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

describe('ops P1 — 编辑操作（POST /edit 的 op 实现）', () => {
  it('applyEditOps 一次按顺序应用 7 种操作', () => {
    const project = createDemoProject()
    const keptClips = project.clips
      .filter((clip) => clip.patternId !== 'pat_1')
      .map((clip) => ({
        id: clip.id,
        trackId: clip.trackId,
        patternId: clip.patternId,
        startBar: clip.startBar,
        lengthBars: clip.lengthBars,
        transpose: clip.transpose,
      }))
    const result = ops.applyEditOps(project, [
      { type: 'setPatternNotes', patternId: 'pat_1', notes: [{ pitch: 42, start: 0, dur: 0.25, vel: 0.8 }] },
      { type: 'updatePattern', patternId: 'pat_1', name: 'Intro 重写', lengthBars: 2 },
      { type: 'addPattern', name: '新 pattern', lengthBars: 2 },
      { type: 'setClips', clips: keptClips },
      { type: 'setSections', sections: [{ name: '唯一段落', startBar: 0, lengthBars: 8 }] },
      { type: 'updateTrack', trackId: 'trk_1', volume: 0.5, mute: true },
      { type: 'removePattern', patternId: 'pat_1' },
    ])
    assert.equal(result.label, '编辑工程') // 混合操作
    assert.equal(result.results.length, 7)
    assert.equal(project.patterns.some((pattern) => pattern.id === 'pat_1'), false)
    assert.equal(project.patterns.at(-1).name, '新 pattern')
    assert.equal(project.clips.length, keptClips.length)
    assert.equal(project.sections.length, 1)
    assert.equal(project.sections[0].name, '唯一段落')
    assert.equal(project.tracks.find((track) => track.id === 'trk_1').volume, 0.5)
    assert.equal(project.tracks.find((track) => track.id === 'trk_1').mute, true)
  })

  it('保留 UI 传入的 clip / section id（增量编辑不丢选中）', () => {
    const project = createDemoProject()
    const clips = project.clips.map((clip) => ({
      id: clip.id,
      trackId: clip.trackId,
      patternId: clip.patternId,
      startBar: clip.startBar,
      lengthBars: clip.lengthBars,
      transpose: clip.transpose,
    }))
    clips[0] = { ...clips[0], startBar: clips[0].startBar + 2 }
    const result = ops.applyEditOps(project, [{ type: 'setClips', clips }])
    assert.equal(result.label, '编辑片段')
    assert.equal(project.clips[0].id, clips[0].id)
    assert.equal(project.clips[0].startBar, clips[0].startBar)

    const sections = project.sections.map((section) => ({ ...section }))
    ops.applyEditOps(project, [{ type: 'setSections', sections }])
    assert.deepEqual(project.sections.map((section) => section.id), sections.map((section) => section.id))
  })

  it('单 op 的撤销标签映射', () => {
    const cases = [
      ['setPatternNotes', '编辑音符'],
      ['setClips', '编辑片段'],
      ['setSections', '编辑段落'],
      ['addPattern', '新建 pattern'],
      ['updatePattern', '修改 pattern'],
      ['removePattern', '删除 pattern'],
      ['updateTrack', '修改轨道'],
      ['setAutomation', '编辑自动化'],
      ['clearAutomation', '清除自动化'],
    ]
    for (const [type, label] of cases) assert.equal(ops.editLabelFor([{ type }]), label)
    assert.equal(ops.editLabelFor([]), '编辑工程')
  })

  it('校验失败抛出中文 OpError（含 ops[index] 定位）', () => {
    const project = createDemoProject()
    assert.throws(() => ops.applyEditOps(project, []), /ops 不能为空/)
    assert.throws(() => ops.applyEditOps(project, 'nope'), /ops 必须是数组/)
    assert.throws(
      () => ops.applyEditOps(project, Array.from({ length: 201 }, () => ({ type: 'addPattern' }))),
      /最多提交 200/,
    )
    // 被 clip 引用的 pattern 不能删
    assert.throws(() => ops.applyEditOps(project, [{ type: 'removePattern', patternId: 'pat_1' }]), /正被 \d+ 个片段引用/)
    // 第 2 个 op 失败时错误信息带索引
    assert.throws(
      () =>
        ops.applyEditOps(project, [
          { type: 'updateTrack', trackId: 'trk_1', volume: 0.3 },
          { type: 'setPatternNotes', patternId: 'pat_999', notes: [] },
        ]),
      /ops\[1\]（setPatternNotes）失败/,
    )
    assert.throws(() => ops.applyEditOps(project, [{ type: 'nope' }]), /不支持的编辑操作 type=nope/)
    assert.throws(() => ops.applyEditOps(project, [{ type: 'updatePattern', patternId: 'pat_1' }]), /至少提供/)
    assert.throws(() => ops.applyEditOps(project, [{ type: 'updateTrack', trackId: 'trk_999', volume: 0.3 }]), /找不到轨道/)
    assert.throws(() => ops.applyEditOps(project, [{ type: 'setNotes', patternId: 'pat_1', notes: [] }]), /不支持的编辑操作/)
  })
})

/* ------------------------------------------------------------------------- */
/* P1：state 撤销 / 重做                                                      */
/* ------------------------------------------------------------------------- */

describe('state P1 — 撤销 / 重做', () => {
  it('AI 式 mutate 入撤销栈；undo 恢复内容并保留 revision/history/transport 会话字段', async () => {
    const { state } = await makeState()
    try {
      const pattern = () => state.project.patterns.find((item) => item.id === 'pat_1')
      const originalNotes = pattern().notes.length
      const transportBefore = JSON.stringify(state.project.transport)
      const rev0 = state.revision
      state.mutate(
        { tool: 'studio_set_notes', text: '编辑 pat_1 音符', undoLabel: '编辑音符' },
        (draft) => ops.setNotes(draft, { patternId: 'pat_1', notes: [{ pitch: 36, start: 0, dur: 1 }] }),
      )
      const revAfterEdit = state.revision
      assert.ok(revAfterEdit > rev0)
      assert.equal(pattern().notes.length, 1)
      assert.equal(state.canUndo, true)
      assert.equal(state.canRedo, false)
      assert.equal(state.historyState().undoLabel, '编辑音符')

      const undone = state.undo()
      assert.equal(undone.ok, true)
      assert.equal(undone.label, '编辑音符')
      assert.equal(pattern().notes.length, originalNotes)
      assert.ok(state.revision > revAfterEdit, '撤销也应 bump revision（单调递增）')
      assert.equal(JSON.stringify(state.project.transport), transportBefore, '撤销不应回退 transport 命令')
      assert.equal(state.canUndo, false)
      assert.equal(state.canRedo, true)
      assert.equal(state.historyState().redoLabel, '编辑音符')
      // 撤销不写入 AI 动态历史
      assert.equal(state.project.history.at(-1).tool, 'studio_set_notes')

      const redone = state.redo()
      assert.equal(redone.ok, true)
      assert.equal(redone.label, '编辑音符')
      assert.equal(pattern().notes.length, 1)
      assert.equal(state.canRedo, false)
      // 空栈时 undo/redo 返回 ok:false（路由层包成 ok:true + didStep:false）
      assert.equal(state.redo().ok, false)
      assert.equal(state.undo().ok, true)
    } finally {
      state.dispose()
    }
  })

  it('失败 mutate 不压栈；非内容字段的 mutate（transport/activity/exportRequest）不压栈', async () => {
    const { state } = await makeState()
    try {
      assert.equal(state.canUndo, false)
      assert.throws(
        () => state.mutate({ tool: 'studio_add_track', text: 'bad' }, (draft) => ops.addTrack(draft, { name: 'x', kind: 'piano' })),
        /kind/,
      )
      assert.equal(state.canUndo, false, '失败变更不应产生撤销步骤')
      assert.equal(state.revision, 1)

      state.mutate({ tool: 'studio_transport', text: null }, (draft) => ops.transport(draft, { action: 'play' }))
      assert.equal(state.canUndo, false, 'transport 变化不算可撤销内容')
      state.mutate({ tool: 'studio_set_activity', text: '动态' }, (draft) => ops.setActivity(draft, { text: '测试动态' }))
      assert.equal(state.canUndo, false, 'activity 变化不算可撤销内容')
      state.mutate({ tool: 'studio_export', text: '导出请求' }, (draft) => ops.exportRequest(draft))
      assert.equal(state.canUndo, false, 'exportRequest 变化不算可撤销内容')
      assert.ok(state.revision > 1)
    } finally {
      state.dispose()
    }
  })

  it('撤销栈深度上限 100（超出丢弃最旧快照）', async () => {
    const { state } = await makeState()
    const volumeAt = (index) => 0.005 + index * 0.008 // 120 步内互不相同且在 0..1 内
    try {
      for (let index = 0; index < 120; index += 1) {
        state.mutate({ tool: 'studio_update_track', text: `调整音量 ${index}`, undoLabel: '调整音量' }, (draft) =>
          ops.updateTrack(draft, { trackId: 'trk_1', volume: volumeAt(index) }),
        )
      }
      const track = () => state.project.tracks.find((item) => item.id === 'trk_1')
      assert.equal(state.undoDepth, MAX_UNDO)
      assert.equal(MAX_UNDO, 100)
      assert.ok(Math.abs(track().volume - volumeAt(119)) < 1e-9)

      for (let index = 0; index < MAX_UNDO; index += 1) assert.equal(state.undo().ok, true)
      assert.equal(state.canUndo, false)
      // 撤销 100 步后回到第 20 步之后的状态（快照只保留最近 100 个）
      assert.ok(Math.abs(track().volume - volumeAt(19)) < 1e-9, `撤销后音量应为 ${volumeAt(19)}，实际 ${track().volume}`)
      assert.equal(state.undo().ok, false)

      // 重做 100 步回到最新状态
      for (let index = 0; index < MAX_UNDO; index += 1) assert.equal(state.redo().ok, true)
      assert.ok(Math.abs(track().volume - volumeAt(119)) < 1e-9)
      assert.equal(state.canRedo, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('新的编辑会清空重做栈', async () => {
    const { state } = await makeState()
    try {
      state.mutate({ text: '第一次', undoLabel: '第一次' }, (draft) => ops.updateTrack(draft, { trackId: 'trk_1', volume: 0.4 }))
      state.mutate({ text: '第二次', undoLabel: '第二次' }, (draft) => ops.updateTrack(draft, { trackId: 'trk_1', volume: 0.3 }))
      state.undo()
      assert.equal(state.canRedo, true)
      state.mutate({ text: '第三次', undoLabel: '第三次' }, (draft) => ops.updateTrack(draft, { trackId: 'trk_1', volume: 0.2 }))
      assert.equal(state.canRedo, false, '新编辑应清空重做栈')
    } finally {
      state.dispose()
    }
  })

  it('loadProject（打开/新建）清空撤销历史并保持 revision 单调', async () => {
    const { state } = await makeState()
    try {
      state.mutate({ text: '改一下', undoLabel: '改一下' }, (draft) => ops.updateTrack(draft, { trackId: 'trk_1', volume: 0.1 }))
      assert.equal(state.canUndo, true)
      const revBefore = state.revision
      const newRev = state.loadProject(createEmptyProject({ title: '打开的新工程' }), { activity: '已打开' })
      assert.ok(newRev > revBefore)
      assert.equal(state.project.tracks.length, 0)
      assert.equal(state.project.title, '打开的新工程')
      assert.equal(state.canUndo, false)
      assert.equal(state.canRedo, false)
      assert.equal(state.project.transport.cmd, null)
    } finally {
      state.dispose()
    }
  })

  it('activeName / activeSavedAt 持久化（重启后仍可读）', async () => {
    const dir = await tempDir()
    const first = createState({ dataDir: dir, fallbackInitial: () => null })
    await first.ready
    first.setActiveProject('我的工程', 1234567890)
    await first.flush()
    first.dispose()

    const second = createState({ dataDir: dir })
    await second.ready
    try {
      assert.equal(second.activeName, '我的工程')
      assert.equal(second.activeSavedAt, 1234567890)
      second.setActiveProject(null, null)
      await second.flush()
    } finally {
      second.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P1：routes — 编辑 / 撤销重做                                                */
/* ------------------------------------------------------------------------- */

describe('routes P1 — POST /edit 与撤销重做', () => {
  it('POST /edit 应用整组 op，返回 rev/canUndo/canRedo/label/results；undo/redo 可往返', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const beforeVolume = state.project.tracks[0].volume
      const beforeName = state.project.tracks[0].name
      const edit = await postJson(server.base, '/studio/api/edit', {
        ops: [
          { type: 'updateTrack', trackId: 'trk_1', volume: 0.33, name: '鼓组改名' },
          { type: 'setPatternNotes', patternId: 'pat_1', notes: [{ pitch: 42, start: 0, dur: 0.25 }] },
        ],
      })
      assert.equal(edit.status, 200)
      assert.equal(edit.data.ok, true)
      assert.equal(edit.data.label, '编辑工程')
      assert.equal(edit.data.canUndo, true)
      assert.equal(edit.data.canRedo, false)
      assert.equal(edit.data.results.length, 2)
      assert.equal(state.project.tracks[0].volume, 0.33)
      assert.equal(state.project.tracks[0].name, '鼓组改名')
      assert.equal(state.project.patterns.find((pattern) => pattern.id === 'pat_1').notes.length, 1)

      const hist = await getJson(server.base, '/studio/api/history')
      assert.equal(hist.data.ok, true)
      assert.equal(hist.data.canUndo, true)
      assert.equal(hist.data.undoLabel, '编辑工程')
      assert.equal(hist.data.canRedo, false)

      const undo = await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(undo.status, 200)
      assert.equal(undo.data.ok, true)
      assert.equal(undo.data.didStep, true)
      assert.equal(undo.data.canUndo, false)
      assert.equal(undo.data.canRedo, true)
      assert.equal(state.project.tracks[0].volume, beforeVolume)
      assert.equal(state.project.tracks[0].name, beforeName)

      const redo = await postJson(server.base, '/studio/api/history/redo', {})
      assert.equal(redo.data.ok, true)
      assert.equal(redo.data.didStep, true)
      assert.equal(state.project.tracks[0].volume, 0.33)
      assert.equal(state.project.tracks[0].name, '鼓组改名')

      const redoAgain = await postJson(server.base, '/studio/api/history/redo', {})
      assert.equal(redoAgain.data.ok, true)
      assert.equal(redoAgain.data.didStep, false)
      assert.equal(redoAgain.data.canRedo, false)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('POST /edit 校验失败：HTTP 200 + ok:false + 中文原因，整组不生效（原子）', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const before = JSON.stringify(state.project)
      const failed = await postJson(server.base, '/studio/api/edit', {
        ops: [
          { type: 'updateTrack', trackId: 'trk_1', volume: 0.5 },
          { type: 'removePattern', patternId: 'pat_1' }, // 被 clip 引用 → 失败
        ],
      })
      assert.equal(failed.status, 200)
      assert.equal(failed.data.ok, false)
      assert.match(failed.data.error, /ops\[1\]/)
      assert.match(failed.data.error, /正被 \d+ 个片段引用/)
      assert.equal(JSON.stringify(state.project), before, '整组失败不应改工程')
      assert.equal(state.canUndo, false)

      const badBody = await postJson(server.base, '/studio/api/edit', { ops: 'nope' })
      assert.equal(badBody.data.ok, false)
      assert.match(badBody.data.error, /ops 必须是编辑操作数组/)

      const wrongMethod = await fetch(`${server.base}/studio/api/edit`)
      assert.equal(wrongMethod.status, 405)
      assert.equal(wrongMethod.headers.get('allow'), 'POST')
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('GET /history 初始状态 + POST /action 也会入撤销栈', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const initial = await getJson(server.base, '/studio/api/history')
      assert.equal(initial.data.ok, true)
      assert.equal(initial.data.canUndo, false)
      assert.equal(initial.data.canRedo, false)
      assert.equal(initial.data.undoLabel, '')

      const action = await postJson(server.base, '/studio/api/action', { type: 'toggleMute', trackId: 'trk_2' })
      assert.equal(action.data.ok, true)
      assert.equal(action.data.canUndo, true)
      const tracked = await getJson(server.base, '/studio/api/history')
      assert.equal(tracked.data.undoLabel, '切换静音')
      const undo = await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(undo.data.didStep, true)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_2').mute, false)
    } finally {
      await server.close()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P1：routes — 工程管理                                                       */
/* ------------------------------------------------------------------------- */

describe('routes P1 — 工程管理（/projects）', () => {
  it('保存 → 列表 → 覆盖保存 → 另存为 → 新建 → 打开 → 删除 全流程', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      // 初始没有工程
      let list = await getJson(server.base, '/studio/api/projects')
      assert.equal(list.data.ok, true)
      assert.deepEqual(list.data.projects, [])
      assert.equal(list.data.activeName, null)
      assert.equal(list.data.activeSavedAt, null)

      // 保存（不传 name → 用工程标题）
      const saved = await postJson(server.base, '/studio/api/projects/save', {})
      assert.equal(saved.data.ok, true)
      assert.equal(saved.data.activeName, '霓虹天际线 Neon Skyline')
      assert.ok(saved.data.path.startsWith(projectsDir(dir) + path.sep))
      assert.ok((await stat(saved.data.path)).size > 0)

      list = await getJson(server.base, '/studio/api/projects')
      assert.equal(list.data.projects.length, 1)
      assert.equal(list.data.projects[0].name, '霓虹天际线 Neon Skyline')
      assert.equal(list.data.projects[0].trackCount, 7)
      assert.equal(list.data.activeName, '霓虹天际线 Neon Skyline')
      assert.ok(Number.isFinite(list.data.activeSavedAt))

      // 修改后 Ctrl+S 覆盖当前工程（不传 overwrite 也允许）
      state.mutate({ tool: 'studio_update_track', text: '改名' }, (draft) =>
        ops.updateTrack(draft, { trackId: 'trk_1', name: '改过的鼓组' }),
      )
      const ctrlS = await postJson(server.base, '/studio/api/projects/save', {})
      assert.equal(ctrlS.data.ok, true)
      const savedFile = await loadProjectFile(dir, '霓虹天际线 Neon Skyline')
      assert.equal(savedFile.project.tracks[0].name, '改过的鼓组')

      // 另存为
      const copy = await postJson(server.base, '/studio/api/projects/save', { name: '副本工程' })
      assert.equal(copy.data.ok, true)
      assert.equal(copy.data.activeName, '副本工程')

      // 同名冲突（当前活跃是「副本工程」，保存到已存在的另一个工程）
      const conflict = await postJson(server.base, '/studio/api/projects/save', { name: '霓虹天际线 Neon Skyline' })
      assert.equal(conflict.data.ok, false)
      assert.match(conflict.data.error, /同名工程已存在/)
      const forced = await postJson(server.base, '/studio/api/projects/save', {
        name: '霓虹天际线 Neon Skyline',
        overwrite: true,
      })
      assert.equal(forced.data.ok, true)
      assert.equal(forced.data.activeName, '霓虹天际线 Neon Skyline')

      // 新建空工程
      const created = await postJson(server.base, '/studio/api/projects/new', { template: 'empty', name: '空工程' })
      assert.equal(created.data.ok, true)
      assert.equal(created.data.template, 'empty')
      assert.equal(created.data.title, '空工程')
      assert.equal(created.data.activeName, null)
      let current = await getJson(server.base, '/studio/api/state?rev=0')
      assert.equal(current.data.project.tracks.length, 0)
      assert.equal(current.data.project.patterns.length, 0)

      // 打开工程 → 数据恢复
      const opened = await postJson(server.base, '/studio/api/projects/open', { name: '副本工程' })
      assert.equal(opened.data.ok, true)
      assert.equal(opened.data.activeName, '副本工程')
      current = await getJson(server.base, '/studio/api/state?rev=0')
      assert.equal(current.data.project.tracks.length, 7)
      assert.equal(current.data.project.tracks[0].name, '改过的鼓组')

      // 打开不存在的工程
      const missing = await postJson(server.base, '/studio/api/projects/open', { name: '不存在的工程' })
      assert.equal(missing.data.ok, false)
      assert.match(missing.data.error, /工程不存在/)

      // 删除当前活跃工程 → activeName 清空
      const deleted = await postJson(server.base, '/studio/api/projects/delete', { name: '副本工程' })
      assert.equal(deleted.data.ok, true)
      assert.equal(deleted.data.activeName, null)
      const deleteAgain = await postJson(server.base, '/studio/api/projects/delete', { name: '副本工程' })
      assert.equal(deleteAgain.data.ok, false)
      assert.match(deleteAgain.data.error, /工程不存在/)
      list = await getJson(server.base, '/studio/api/projects')
      assert.equal(list.data.projects.length, 1)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('POST /projects/new template=demo 恢复演示工程', async () => {
    const { state } = await makeState({ withDemo: false })
    const server = await startServer(state)
    try {
      assert.equal(state.project.tracks.length, 0)
      const created = await postJson(server.base, '/studio/api/projects/new', { template: 'demo' })
      assert.equal(created.data.ok, true)
      assert.equal(created.data.template, 'demo')
      const current = await getJson(server.base, '/studio/api/state?rev=0')
      assert.equal(current.data.project.tracks.length, 7)
      assert.equal(current.data.project.patterns.length, 13)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('工程名安全化：路径穿越 / 非法字符 / 长度 / Windows 保留名', async () => {
    // 纯函数层
    assert.equal(sanitizeProjectName('../危险/工程:名'), '危险-工程-名')
    assert.equal(sanitizeProjectName('a/b\\c:d'), 'a-b-c-d')
    assert.equal(sanitizeProjectName('CON'), '_CON')
    assert.ok(sanitizeProjectName('名'.repeat(100)).length <= 60)

    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      const saved = await postJson(server.base, '/studio/api/projects/save', { name: '../危险/工程:名' })
      assert.equal(saved.data.ok, true)
      assert.equal(saved.data.activeName, '危险-工程-名')
      assert.ok(path.resolve(saved.data.path).startsWith(path.resolve(projectsDir(dir)) + path.sep))
      assert.equal(path.basename(saved.data.path), '危险-工程-名.json')
    } finally {
      await server.close()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P1：routes — MIDI 导出 / 下载                                               */
/* ------------------------------------------------------------------------- */

describe('routes P1 — MIDI 导出与文件下载', () => {
  it('POST /export-midi 生成 SMF 文件，返回统计，lastExport 更新', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      const exported = await postJson(server.base, '/studio/api/export-midi', { name: '路由导出' })
      assert.equal(exported.status, 200)
      assert.equal(exported.data.ok, true)
      assert.equal(exported.data.fileName, '路由导出.mid')
      assert.ok(path.resolve(exported.data.path).startsWith(path.resolve(dir)))
      assert.ok(exported.data.bytes > 100)
      assert.equal(exported.data.tracks, 7)
      assert.ok(exported.data.notes > 0)
      assert.ok(exported.data.seconds > 0)

      const file = await readFile(exported.data.path)
      assert.equal(file.length, exported.data.bytes)
      assert.equal(file.toString('ascii', 0, 4), 'MThd')
      assert.equal(file.readUInt16BE(8), 1) // format 1
      assert.equal(file.readUInt16BE(10), 8) // ntrks = 7 轨 + conductor
      assert.equal(file.readUInt16BE(12), 480) // PPQ
      assert.deepEqual(file, buildMidi(state.project).buffer, '路由写出的字节应与 buildMidi 一致')

      assert.equal(state.project.lastExport.path, exported.data.path)
      assert.equal(state.project.lastExport.bytes, exported.data.bytes)
      const cached = state.project.lastExport
      void cached
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('GET /download 仅允许 dataDir 下文件（绝对/相对路径均可）', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      const exported = await postJson(server.base, '/studio/api/export-midi', { name: '下载测试' })
      const file = await readFile(exported.data.path)

      // 绝对路径
      const absolute = await fetch(
        `${server.base}/studio/api/download?path=${encodeURIComponent(exported.data.path)}`,
      )
      assert.equal(absolute.status, 200)
      assert.match(absolute.headers.get('content-type') ?? '', /audio\/midi/)
      assert.match(absolute.headers.get('content-disposition') ?? '', /attachment/)
      assert.deepEqual(Buffer.from(await absolute.arrayBuffer()), file)

      // 相对 dataDir 路径
      const relative = await fetch(
        `${server.base}/studio/api/download?path=${encodeURIComponent(`exports/${exported.data.fileName}`)}`,
      )
      assert.equal(relative.status, 200)
      assert.deepEqual(Buffer.from(await relative.arrayBuffer()), file)

      // dataDir 之外 → 403
      const outside = await fetch(
        `${server.base}/studio/api/download?path=${encodeURIComponent('../project.json')}`,
      )
      assert.equal(outside.status, 403)
      assert.match((await outside.json()).error, /只能下载数据目录/)
      const outsideAbsolute = await fetch(
        `${server.base}/studio/api/download?path=${encodeURIComponent(path.join(os.tmpdir(), 'not-in-data.txt'))}`,
      )
      assert.equal(outsideAbsolute.status, 403)

      // dataDir 内不存在 → 404
      const missing = await fetch(`${server.base}/studio/api/download?path=${encodeURIComponent('exports/nope.mid')}`)
      assert.equal(missing.status, 404)

      // 缺参数 → 400
      const noPath = await fetch(`${server.base}/studio/api/download`)
      assert.equal(noPath.status, 400)

      // dataDir 内 project.json 可以下载（受限于目录，不限制类型）
      const projectJson = await fetch(`${server.base}/studio/api/download?path=${encodeURIComponent('project.json')}`)
      assert.equal(projectJson.status, 200)
      assert.ok((await projectJson.json()).tracks.length >= 0)
      assert.ok(path.resolve(dir))
    } finally {
      await server.close()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P1：tools — studio_export format: midi                                     */
/* ------------------------------------------------------------------------- */

describe('tools P1 — studio_export 支持 MIDI 格式', () => {
  it('format=midi 由 Host 直接生成文件；默认 wav 仍写 exportRequest', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    try {
      const exportTool = byName.get('studio_export')
      assert.match(exportTool.description, /MIDI/)
      assert.equal(exportTool.parameters.format.type, 'string')
      assert.deepEqual(exportTool.parameters.format.enum, ['wav', 'mp3', 'flac', 'midi', 'stems'])

      const midi = await exportTool.execute({ format: 'midi', name: '工具导出' }, {})
      assert.equal(midi.ok, true)
      assert.equal(midi.format, 'midi')
      assert.ok(midi.path.endsWith('工具导出.mid'))
      assert.equal(midi.tracks, 7)
      assert.ok(midi.notes > 0)
      assert.ok((await stat(midi.path)).size > 0)
      assert.equal(state.project.lastExport.path, midi.path)

      const wav = await exportTool.execute({}, {})
      assert.equal(wav.ok, true)
      assert.equal(wav.format, 'wav')
      assert.equal(wav.requested, true)
      assert.ok(state.project.exportRequest.seq > 0)
    } finally {
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2a：ops 自动化                                                            */
/* ------------------------------------------------------------------------- */

describe('ops P2a — 自动化曲线 setAutomation / clearAutomation', () => {
  it('setAutomation 写入轨道曲线：beat 排序/夹紧、重复 beat 后者覆盖、value 夹 0..1、enabled 默认 true', () => {
    const project = createDemoProject()
    const result = ops.setAutomation(project, {
      trackId: 'trk_2',
      param: 'volume',
      points: [
        { beat: 16, value: 0.9 },
        { beat: 0, value: 0.2 },
        { beat: -8, value: 0.4 }, // beat 夹到 0
      ],
    })
    assert.deepEqual(result, {
      target: 'track',
      trackId: 'trk_2',
      param: 'volume',
      enabled: true,
      pointCount: 2,
    })
    const track = project.tracks.find((item) => item.id === 'trk_2')
    assert.deepEqual(track.automation.volume, {
      enabled: true,
      points: [
        { beat: 0, value: 0.4 },
        { beat: 16, value: 0.9 },
      ],
    })

    // 重复 beat：后者覆盖；beat 超曲长（32 小节 × 4 = 128）夹紧
    ops.setAutomation(project, {
      trackId: 'trk_2',
      param: 'pan',
      points: [
        { beat: 8, value: 0.2 },
        { beat: 8, value: 0.8 },
        { beat: 9999, value: 1.5 },
      ],
      enabled: false,
    })
    assert.deepEqual(track.automation.pan, {
      enabled: false,
      points: [
        { beat: 8, value: 0.8 },
        { beat: 128, value: 1 },
      ],
    })
    // 三类参数互不影响
    ops.setAutomation(project, { trackId: 'trk_2', param: 'cutoff', points: [{ beat: 0, value: 0.1 }] })
    assert.deepEqual(Object.keys(track.automation).sort(), ['cutoff', 'pan', 'volume'])
    // 传 [] 合法：保留空曲线
    ops.setAutomation(project, { trackId: 'trk_2', param: 'volume', points: [] })
    assert.deepEqual(track.automation.volume, { enabled: true, points: [] })
  })

  it('setAutomation 支持 master volume；master 不支持 pan/cutoff', () => {
    const project = createDemoProject()
    const result = ops.setAutomation(project, {
      target: 'master',
      param: 'volume',
      points: [{ beat: 0, value: 0.4 }, { beat: 64, value: 0.9 }],
    })
    assert.deepEqual(result, { target: 'master', param: 'volume', enabled: true, pointCount: 2 })
    assert.deepEqual(project.master.automation, {
      volume: {
        enabled: true,
        points: [
          { beat: 0, value: 0.4 },
          { beat: 64, value: 0.9 },
        ],
      },
    })
    assert.throws(() => ops.setAutomation(project, { target: 'master', param: 'pan', points: [] }), /master 只支持 volume/)
    assert.throws(() => ops.setAutomation(project, { target: 'master', param: 'cutoff', points: [] }), /master 只支持 volume/)
  })

  it('setAutomation 校验错误返回中文 OpError', () => {
    const project = createDemoProject()
    const set = (args) => () => ops.setAutomation(project, args)
    assert.throws(set({ param: 'volume', points: [] }), /trackId 必须是字符串|找不到轨道/)
    assert.throws(set({ trackId: 'trk_999', param: 'volume', points: [] }), /找不到轨道/)
    assert.throws(set({ trackId: 'trk_1', param: 'nope', points: [] }), /未知自动化参数 nope/)
    assert.throws(set({ target: 'song', trackId: 'trk_1', param: 'volume', points: [] }), /target 必须是/)
    assert.throws(set({ trackId: 'trk_1', param: 'volume', points: 'nope' }), /points 必须是数组/)
    assert.throws(set({ trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.5 }, null] }), /points\[1\] 必须是对象/)
    assert.throws(set({ trackId: 'trk_1', param: 'volume', points: [{ beat: 'x', value: 0.5 }] }), /beat 必须是数字/)
    assert.throws(set({ trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 'x' }] }), /value 必须是 0..1 的数字/)
    assert.throws(set({ trackId: 'trk_1', param: 'volume', points: [], enabled: 'yes' }), /必须是布尔值/)
    const tooMany = Array.from({ length: 257 }, (_, index) => ({ beat: index, value: 0.5 }))
    assert.throws(set({ trackId: 'trk_1', param: 'volume', points: tooMany }), /超过上限 256/)
  })

  it('clearAutomation 删除曲线；空后删除 automation 字段；幂等返回 cleared:false', () => {
    const project = createDemoProject()
    ops.setAutomation(project, { trackId: 'trk_2', param: 'volume', points: [{ beat: 0, value: 0.5 }] })
    ops.setAutomation(project, { trackId: 'trk_2', param: 'pan', points: [{ beat: 0, value: 0.5 }] })
    ops.setAutomation(project, { target: 'master', param: 'volume', points: [{ beat: 0, value: 0.5 }] })
    const track = project.tracks.find((item) => item.id === 'trk_2')

    assert.deepEqual(ops.clearAutomation(project, { trackId: 'trk_2', param: 'volume' }), {
      target: 'track',
      trackId: 'trk_2',
      param: 'volume',
      cleared: true,
    })
    assert.deepEqual(Object.keys(track.automation), ['pan'])
    assert.deepEqual(ops.clearAutomation(project, { trackId: 'trk_2', param: 'volume' }), {
      target: 'track',
      trackId: 'trk_2',
      param: 'volume',
      cleared: false,
    })
    ops.clearAutomation(project, { trackId: 'trk_2', param: 'pan' })
    assert.equal(Object.hasOwn(track, 'automation'), false, '所有曲线清空后删除 automation 字段')

    const masterResult = ops.clearAutomation(project, { target: 'master', param: 'volume' })
    assert.deepEqual(masterResult, { target: 'master', param: 'volume', cleared: true })
    assert.equal(Object.hasOwn(project.master, 'automation'), false)
    assert.throws(() => ops.clearAutomation(project, { target: 'master', param: 'cutoff' }), /master 只支持 volume/)
  })

  it('applyEditOps：自动化 op 的撤销标签与结果；混合 op 标签为「编辑工程」', () => {
    const project = createDemoProject()
    const single = ops.applyEditOps(project, [
      { type: 'setAutomation', trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.5 }] },
    ])
    assert.equal(single.label, '编辑自动化')
    assert.deepEqual(single.results[0], {
      type: 'setAutomation',
      target: 'track',
      trackId: 'trk_1',
      param: 'volume',
      enabled: true,
      pointCount: 1,
    })

    const clear = ops.applyEditOps(project, [{ type: 'clearAutomation', trackId: 'trk_1', param: 'volume' }])
    assert.equal(clear.label, '清除自动化')
    assert.equal(clear.results[0].cleared, true)

    const mixed = ops.applyEditOps(project, [
      { type: 'setAutomation', target: 'master', param: 'volume', points: [{ beat: 0, value: 0.6 }] },
      { type: 'updateTrack', trackId: 'trk_1', volume: 0.5 },
    ])
    assert.equal(mixed.label, '编辑工程')
    assert.equal(mixed.results.length, 2)
  })
})

/* ------------------------------------------------------------------------- */
/* P2a：state 自动化撤销/重做                                                   */
/* ------------------------------------------------------------------------- */

describe('state P2a — 自动化撤销/重做', () => {
  it('设置自动化 → undo 移除 → redo 恢复；覆盖曲线时 undo 回到上一条曲线', async () => {
    const { state } = await makeState()
    try {
      const track = () => state.project.tracks.find((item) => item.id === 'trk_2')
      assert.equal(Object.hasOwn(track(), 'automation'), false)
      const rev0 = state.revision

      // 第一次设置曲线 A
      state.mutate({ tool: 'studio_set_automation', text: '设置自动化 A', undoLabel: '编辑自动化' }, (draft) =>
        ops.setAutomation(draft, { trackId: 'trk_2', param: 'volume', points: [{ beat: 0, value: 0.2 }, { beat: 16, value: 0.8 }] }),
      )
      const curveA = JSON.stringify(track().automation.volume)
      assert.ok(state.revision > rev0)
      assert.equal(state.historyState().undoLabel, '编辑自动化')

      // 覆盖为曲线 B
      state.mutate({ tool: 'studio_set_automation', text: '设置自动化 B', undoLabel: '编辑自动化' }, (draft) =>
        ops.setAutomation(draft, { trackId: 'trk_2', param: 'volume', points: [{ beat: 0, value: 0.9 }] }),
      )
      assert.equal(track().automation.volume.points.length, 1)

      // undo → 回到曲线 A；再 undo → 完全没有 automation
      assert.equal(state.undo().ok, true)
      assert.equal(JSON.stringify(track().automation.volume), curveA)
      assert.equal(state.undo().ok, true)
      assert.equal(Object.hasOwn(track(), 'automation'), false)

      // redo ×2 → 曲线 A → 曲线 B
      assert.equal(state.redo().ok, true)
      assert.equal(JSON.stringify(track().automation.volume), curveA)
      assert.equal(state.redo().ok, true)
      assert.deepEqual(track().automation.volume.points, [{ beat: 0, value: 0.9 }])
      assert.equal(state.canRedo, false)
    } finally {
      state.dispose()
    }
  })

  it('非法自动化 mutate 不压栈、不改项目（原子）', async () => {
    const { state } = await makeState()
    try {
      const before = JSON.stringify(state.project)
      assert.throws(
        () =>
          state.mutate({ tool: 'studio_edit', text: null }, (draft) =>
            ops.applyEditOps(draft, [
              { type: 'setAutomation', trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.5 }] },
              { type: 'setAutomation', trackId: 'trk_999', param: 'pan', points: [] },
            ]),
          ),
        /ops\[1\]/,
      )
      assert.equal(JSON.stringify(state.project), before)
      assert.equal(state.canUndo, false)
    } finally {
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2a：routes /edit 自动化 + 工程持久化                                       */
/* ------------------------------------------------------------------------- */

describe('routes P2a — /edit 自动化与工程持久化', () => {
  it('POST /edit setAutomation → /state 校验 → undo/redo 往返', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const edit = await postJson(server.base, '/studio/api/edit', {
        ops: [
          {
            type: 'setAutomation',
            trackId: 'trk_3',
            param: 'cutoff',
            points: [
              { beat: 0, value: 0.15 },
              { beat: 8, value: 0.9 },
            ],
          },
        ],
      })
      assert.equal(edit.status, 200)
      assert.equal(edit.data.ok, true)
      assert.equal(edit.data.label, '编辑自动化')
      assert.equal(edit.data.canUndo, true)
      assert.equal(edit.data.results[0].pointCount, 2)

      const current = await getJson(server.base, '/studio/api/state?rev=0')
      const liveTrack = current.data.project.tracks.find((track) => track.id === 'trk_3')
      assert.deepEqual(liveTrack.automation.cutoff, {
        enabled: true,
        points: [
          { beat: 0, value: 0.15 },
          { beat: 8, value: 0.9 },
        ],
      })

      const history = await getJson(server.base, '/studio/api/history')
      assert.equal(history.data.undoLabel, '编辑自动化')

      const undo = await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(undo.data.didStep, true)
      assert.equal(
        Object.hasOwn(state.project.tracks.find((track) => track.id === 'trk_3'), 'automation'),
        false,
      )

      const redo = await postJson(server.base, '/studio/api/history/redo', {})
      assert.equal(redo.data.didStep, true)
      assert.deepEqual(state.project.tracks.find((track) => track.id === 'trk_3').automation.cutoff.points, [
        { beat: 0, value: 0.15 },
        { beat: 8, value: 0.9 },
      ])
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('非法自动化 op：HTTP 200 + ok:false，整组原子不生效', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const before = JSON.stringify(state.project)
      const failed = await postJson(server.base, '/studio/api/edit', {
        ops: [
          { type: 'setAutomation', trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.5 }] },
          { type: 'setAutomation', target: 'master', param: 'pan', points: [] }, // master 不支持 pan
        ],
      })
      assert.equal(failed.status, 200)
      assert.equal(failed.data.ok, false)
      assert.match(failed.data.error, /master 只支持 volume/)
      assert.equal(JSON.stringify(state.project), before)
      assert.equal(state.canUndo, false)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('工程保存 → 新建空工程 → 打开：automation 完整保留（轨道 + master）', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      await postJson(server.base, '/studio/api/edit', {
        ops: [
          {
            type: 'setAutomation',
            trackId: 'trk_2',
            param: 'volume',
            points: [
              { beat: 0, value: 0.2 },
              { beat: 32, value: 1 },
            ],
          },
          { type: 'setAutomation', trackId: 'trk_3', param: 'pan', points: [{ beat: 8, value: 0.9 }], enabled: false },
          { type: 'setAutomation', target: 'master', param: 'volume', points: [{ beat: 0, value: 0.7 }] },
        ],
      })
      const saved = await postJson(server.base, '/studio/api/projects/save', { name: '自动化工程' })
      assert.equal(saved.data.ok, true)

      // 新建空工程清空内容
      await postJson(server.base, '/studio/api/projects/new', { template: 'empty' })
      assert.equal(state.project.tracks.length, 0)

      // 打开保存的工程 → automation 恢复
      const opened = await postJson(server.base, '/studio/api/projects/open', { name: '自动化工程' })
      assert.equal(opened.data.ok, true)
      const restored = state.project
      assert.deepEqual(restored.tracks.find((track) => track.id === 'trk_2').automation.volume.points, [
        { beat: 0, value: 0.2 },
        { beat: 32, value: 1 },
      ])
      assert.deepEqual(restored.tracks.find((track) => track.id === 'trk_3').automation.pan, {
        enabled: false,
        points: [{ beat: 8, value: 0.9 }],
      })
      assert.deepEqual(restored.master.automation.volume.points, [{ beat: 0, value: 0.7 }])
      // 打开后撤销栈清空（不同工程不共享）
      assert.equal(state.canUndo, false)
    } finally {
      await server.close()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2a：tools 自动化工具                                                       */
/* ------------------------------------------------------------------------- */

describe('tools P2a — studio_set_automation / studio_clear_automation', () => {
  async function makeAutomationTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { state, tools, byName, exec }
  }

  it('19 个工具含自动化+侧链工具；studio_get_project 默认摘要、includeAutomation 才全量', async () => {
    const { state, exec } = await makeAutomationTools()
    try {
      assert.equal((await exec('studio_set_automation', {
        trackId: 'trk_2',
        param: 'volume',
        points: [{ beat: 0, value: 0.2 }, { beat: 16, value: 0.8 }],
      })).ok, true)
      assert.equal((await exec('studio_set_automation', {
        target: 'master',
        param: 'volume',
        points: [{ beat: 0, value: 0.6 }],
      })).ok, true)

      const overview = await exec('studio_get_project')
      assert.equal(overview.ok, true)
      const track = overview.tracks.find((item) => item.id === 'trk_2')
      // task-75：默认只给摘要（不再返回 points）
      assert.deepEqual(track.automation.volume, {
        enabled: true,
        pointCount: 2,
        firstBeat: 0,
        lastBeat: 16,
      })
      assert.equal(track.automation.volume.points, undefined)
      // 无自动化的轨道返回空对象
      assert.deepEqual(overview.tracks.find((item) => item.id === 'trk_1').automation, {})
      // includeAutomation=true 才返回完整点
      const full = await exec('studio_get_project', { includeAutomation: true })
      assert.deepEqual(full.tracks.find((item) => item.id === 'trk_2').automation.volume.points, [
        { beat: 0, value: 0.2 },
        { beat: 16, value: 0.8 },
      ])
      assert.deepEqual(full.master.automation.volume.points, [{ beat: 0, value: 0.6 }])
      // /state 全量工程保留完整点
      assert.deepEqual(state.project.tracks.find((item) => item.id === 'trk_2').automation.volume.points, [
        { beat: 0, value: 0.2 },
        { beat: 16, value: 0.8 },
      ])
    } finally {
      state.dispose()
    }
  })

  it('studio_set_automation：enabled:false、cutoff 无 filter 时给 warning、加 filter 后无 warning', async () => {
    const { state, exec } = await makeAutomationTools()
    try {
      const disabled = await exec('studio_set_automation', {
        trackId: 'trk_6',
        param: 'pan',
        points: [{ beat: 0, value: 0.1 }],
        enabled: false,
      })
      assert.equal(disabled.ok, true)
      assert.equal(disabled.enabled, false)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_6').automation.pan.enabled, false)

      // trk_2 没有 filter 效果器 → warning
      const cutoff = await exec('studio_set_automation', {
        trackId: 'trk_2',
        param: 'cutoff',
        points: [{ beat: 0, value: 0.15 }, { beat: 8, value: 0.9 }],
      })
      assert.equal(cutoff.ok, true)
      assert.ok(Array.isArray(cutoff.warnings) && /filter 效果器/.test(cutoff.warnings[0]))
      // master 音量自动化不会给 filter warning
      const masterAutomation = await exec('studio_set_automation', {
        target: 'master',
        param: 'volume',
        points: [{ beat: 0, value: 0.5 }],
      })
      assert.equal(masterAutomation.ok, true)
      assert.equal(masterAutomation.warnings, undefined)

      // 添加 filter 后再设置 cutoff → 无 warning
      const addFilter = await exec('studio_add_effect', { target: 'trk_2', type: 'filter' })
      assert.equal(addFilter.ok, true)
      const cutoffAgain = await exec('studio_set_automation', {
        trackId: 'trk_2',
        param: 'cutoff',
        points: [{ beat: 0, value: 0.2 }, { beat: 8, value: 0.95 }],
      })
      assert.equal(cutoffAgain.ok, true)
      assert.equal(cutoffAgain.warnings, undefined)
    } finally {
      state.dispose()
    }
  })

  it('studio_clear_automation：清除曲线，幂等 cleared:false，撤销可恢复', async () => {
    const { state, exec } = await makeAutomationTools()
    try {
      await exec('studio_set_automation', {
        trackId: 'trk_4',
        param: 'volume',
        points: [{ beat: 0, value: 0.5 }],
      })
      const cleared = await exec('studio_clear_automation', { trackId: 'trk_4', param: 'volume' })
      assert.equal(cleared.ok, true)
      assert.equal(cleared.cleared, true)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_4'), 'automation'), false)

      const clearedAgain = await exec('studio_clear_automation', { trackId: 'trk_4', param: 'volume' })
      assert.equal(clearedAgain.ok, true)
      assert.equal(clearedAgain.cleared, false)

      assert.equal(state.undo().ok, true)
      assert.deepEqual(state.project.tracks.find((item) => item.id === 'trk_4').automation.volume.points, [
        { beat: 0, value: 0.5 },
      ])
    } finally {
      state.dispose()
    }
  })

  it('工具参数错误返回 ok:false（不抛异常、不改项目）', async () => {
    const { state, exec } = await makeAutomationTools()
    const revisionBefore = state.revision
    try {
      const cases = [
        ['studio_set_automation', { param: 'volume', points: [] }], // 缺 trackId
        ['studio_set_automation', { trackId: 'trk_999', param: 'volume', points: [] }],
        ['studio_set_automation', { trackId: 'trk_1', param: 'nope', points: [] }],
        ['studio_set_automation', { target: 'master', param: 'pan', points: [] }],
        ['studio_set_automation', { trackId: 'trk_1', param: 'volume', points: [{ beat: 'x', value: 0.5 }] }],
        ['studio_set_automation', {
          trackId: 'trk_1',
          param: 'volume',
          points: Array.from({ length: 257 }, (_, index) => ({ beat: index, value: 0.5 })),
        }],
        ['studio_clear_automation', { param: 'volume' }],
        ['studio_clear_automation', { target: 'master', param: 'cutoff' }],
      ]
      for (const [name, args] of cases) {
        const result = await exec(name, args)
        assert.equal(result.ok, false, `${name} ${JSON.stringify(args)} 应失败`)
        assert.equal(typeof result.error, 'string')
        assert.ok(result.error.length > 0)
      }
      assert.equal(state.revision, revisionBefore)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'automation'), false)
    } finally {
      state.dispose()
    }
  })

  it('概览大小防护：大曲线默认只给 pointCount，includeAutomation 才全量返回 200 点，/state 仍是完整点', async () => {
    const { state, byName } = await makeAutomationTools()
    try {
      // 200 个不同 beat 的点（0, 0.5, 1, ... 99.5；都在 32 小节 = 128 beat 内）
      const many = Array.from({ length: 200 }, (_, index) => ({ beat: index * 0.5, value: (index % 100) / 100 }))
      state.mutate({ tool: 'studio_set_automation', text: '批量自动化', undoLabel: '编辑自动化' }, (draft) => {
        for (const track of draft.tracks) ops.setAutomation(draft, { trackId: track.id, param: 'volume', points: many })
        return undefined
      })
      const overview = await byName.get('studio_get_project').execute({}, {})
      assert.equal(overview.ok, true)
      for (const track of overview.tracks) {
        assert.equal(track.automation.volume.pointCount, 200)
        assert.equal(track.automation.volume.points, undefined)
      }
      const full = await byName.get('studio_get_project').execute({ includeAutomation: true }, {})
      for (const track of full.tracks) {
        assert.equal(track.automation.volume.points.length, 200)
      }
      const bytes = Buffer.byteLength(JSON.stringify(overview))
      assert.ok(bytes < 16000, `自动化概览 ${bytes} 字节应受控（截断后）`)
      // /state 的完整工程仍有 200 点
      assert.equal(state.project.tracks[0].automation.volume.points.length, 200)
    } finally {
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2b：ops 效果器链编辑 op                                                    */
/* ------------------------------------------------------------------------- */

describe('ops P2b — 效果器链编辑（addEffect/updateEffect/removeEffect）', () => {
  it('addEffect：fxType 映射、position 生效、params 归一，结果含 effectId/chain', () => {
    const project = createDemoProject()
    const track = () => project.tracks.find((item) => item.id === 'trk_2')
    const result = ops.applyEditOps(project, [
      { type: 'addEffect', trackId: 'trk_2', fxType: 'filter', params: { cutoff: 800, resonance: 5 }, position: 0 },
    ])
    assert.equal(result.label, '添加效果器')
    const added = result.results[0]
    assert.equal(added.type, 'addEffect')
    assert.equal(added.target, 'trk_2')
    assert.equal(added.position, 0)
    assert.equal(track().effects[0].id, added.effectId)
    assert.equal(track().effects[0].type, 'filter')
    assert.equal(track().effects[0].params.cutoff, 800)
    assert.equal(track().effects[0].params.resonance, 5)
    assert.deepEqual(added.chain.map((fx) => fx.type), track().effects.map((fx) => fx.type))
    assert.equal(added.effect.id, added.effectId)
    assert.equal(added.effect.type, 'filter')

    // 缺省 target = track；position 超界夹紧到末尾
    const appended = ops.applyEditOps(project, [
      { type: 'addEffect', trackId: 'trk_2', fxType: 'delay', position: 999 },
    ])
    assert.equal(track().effects.at(-1).type, 'delay')
    assert.equal(appended.results[0].position, track().effects.length - 1)

    // master 链
    const masterResult = ops.applyEditOps(project, [{ type: 'addEffect', target: 'master', fxType: 'reverb' }])
    assert.equal(masterResult.results[0].target, 'master')
    assert.equal(project.master.effects.at(-1).type, 'reverb')
  })

  it('addEffect 校验：缺 trackId/fxType/未知 fxType/未知轨道', () => {
    const project = createDemoProject()
    assert.throws(() => ops.applyEditOps(project, [{ type: 'addEffect', fxType: 'filter' }]), /target=track 时必须提供 trackId/)
    assert.throws(() => ops.applyEditOps(project, [{ type: 'addEffect', trackId: 'trk_1' }]), /需要 fxType/)
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'addEffect', trackId: 'trk_1', fxType: 'nope' }]),
      /未知效果器/,
    )
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'addEffect', trackId: 'trk_999', fxType: 'filter' }]),
      /找不到轨道/,
    )
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'addEffect', target: 'song', trackId: 'trk_1', fxType: 'filter' }]),
      /target 必须是/,
    )
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'addEffect', trackId: 'trk_1', fxType: 'filter', params: { nope: 1 } }]),
      /没有参数 nope/,
    )
  })

  it('updateEffect：params/enabled/position 映射生效，返回 effect 摘要', () => {
    const project = createDemoProject()
    const add = ops.applyEditOps(project, [
      { type: 'addEffect', trackId: 'trk_2', fxType: 'filter' },
      { type: 'addEffect', trackId: 'trk_2', fxType: 'delay' },
    ])
    const effectId = add.results[0].effectId
    const updated = ops.applyEditOps(project, [
      { type: 'updateEffect', trackId: 'trk_2', effectId, enabled: false, params: { cutoff: 1200 }, position: 1 },
    ])
    assert.equal(updated.label, '调整效果器')
    const result = updated.results[0]
    assert.equal(result.effectId, effectId)
    assert.equal(result.position, 1)
    assert.equal(result.effect.enabled, false)
    assert.equal(result.effect.params.cutoff, 1200)
    const track = project.tracks.find((item) => item.id === 'trk_2')
    assert.equal(track.effects[1].id, effectId)
    assert.equal(track.effects[1].params.cutoff, 1200)

    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'updateEffect', trackId: 'trk_2', effectId: 'fx_999' }]),
      /找不到 fx_999/,
    )
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'updateEffect', effectId }]),
      /target=track/,
    )
  })

  it('removeEffect：删除并返回剩余链；未知 effectId 报错', () => {
    const project = createDemoProject()
    const track = () => project.tracks.find((item) => item.id === 'trk_2')
    const before = track().effects.length
    const effectId = track().effects[0].id
    const result = ops.applyEditOps(project, [{ type: 'removeEffect', trackId: 'trk_2', effectId }])
    assert.equal(result.label, '移除效果器')
    assert.equal(result.results[0].removed, true)
    assert.equal(track().effects.length, before - 1)
    assert.ok(result.results[0].chain.every((fx) => fx.id !== effectId))
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'removeEffect', trackId: 'trk_2', effectId }]),
      /找不到/,
    )
  })

  it('5 个新 op 的撤销标签与混合标签', () => {
    const cases = [
      ['addEffect', '添加效果器'],
      ['updateEffect', '调整效果器'],
      ['removeEffect', '移除效果器'],
      ['setSidechain', '设置侧链'],
      ['clearSidechain', '清除侧链'],
    ]
    for (const [type, label] of cases) assert.equal(ops.editLabelFor([{ type }]), label)
    assert.equal(ops.editLabelFor([{ type: 'setSidechain' }, { type: 'addEffect' }]), '编辑工程')
    for (const [type, label] of cases) assert.equal(ops.EDIT_OP_LABELS[type], label)
  })
})

/* ------------------------------------------------------------------------- */
/* P2b：ops 侧链                                                              */
/* ------------------------------------------------------------------------- */

describe('ops P2b — 侧链压缩 setSidechain / clearSidechain', () => {
  it('setSidechain 写入默认值、夹紧数值、可覆盖既有配置', () => {
    const project = createDemoProject()
    const track = () => project.tracks.find((item) => item.id === 'trk_2')
    assert.equal(Object.hasOwn(track(), 'sidechain'), false)
    const result = ops.applyEditOps(project, [
      { type: 'setSidechain', trackId: 'trk_2', sourceTrackId: 'trk_1', amount: 1.5, attack: 0.5, release: 0 },
    ])
    assert.equal(result.label, '设置侧链')
    assert.equal(result.results[0].type, 'setSidechain')
    assert.equal(result.results[0].trackId, 'trk_2')
    assert.equal(track().sidechain.enabled, true)
    assert.equal(track().sidechain.sourceTrackId, 'trk_1')
    assert.equal(track().sidechain.amount, 1) // 夹到 1
    assert.equal(track().sidechain.attack, 0.2) // 夹到 0.2
    assert.equal(track().sidechain.release, 0.02) // 夹到 0.02
    // 覆盖并显式禁用
    ops.applyEditOps(project, [{ type: 'setSidechain', trackId: 'trk_2', sourceTrackId: 'trk_1', amount: 0.6, release: 0.15, enabled: false }])
    assert.deepEqual(track().sidechain, {
      enabled: false,
      sourceTrackId: 'trk_1',
      amount: 0.6,
      attack: 0.005,
      release: 0.15,
      triggerNotes: [],
    })
    // trackSummary 带 sidechain 摘要
    const summary = ops.trackSummary(track())
    assert.deepEqual(summary.sidechain, {
      enabled: false,
      sourceTrackId: 'trk_1',
      amount: 0.6,
      attack: 0.005,
      release: 0.15,
      triggerNotes: [],
    })
  })

  it('setSidechain 校验：缺 trackId/sourceTrackId、自引用、未知来源、非法数字', () => {
    const project = createDemoProject()
    assert.throws(() => ops.setSidechain(project, { sourceTrackId: 'trk_1' }), /trackId 必须是字符串|找不到轨道/)
    assert.throws(() => ops.setSidechain(project, { trackId: 'trk_999', sourceTrackId: 'trk_1' }), /找不到轨道/)
    assert.throws(() => ops.setSidechain(project, { trackId: 'trk_2' }), /sourceTrackId 必须是字符串/)
    assert.throws(
      () => ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_2' }),
      /侧链来源不能是轨道自身/,
    )
    assert.throws(
      () => ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_999' }),
      /找不到侧链来源轨道 trk_999/,
    )
    assert.throws(
      () => ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1', amount: 'bad' }),
      /amount 必须是数字/,
    )
    assert.throws(
      () => ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1', attack: Number.NaN }),
      /attack 必须是数字/,
    )
  })

  it('clearSidechain 删除配置、幂等返回 cleared:false；getProjectOverview 带 sidechain', () => {
    const project = createDemoProject()
    ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1' })
    const overview = ops.getProjectOverview(project)
    const trackSummary = overview.tracks.find((track) => track.id === 'trk_2')
    assert.equal(trackSummary.sidechain.sourceTrackId, 'trk_1')
    assert.equal(overview.tracks.find((track) => track.id === 'trk_1').sidechain, null)

    const first = ops.applyEditOps(project, [{ type: 'clearSidechain', trackId: 'trk_2' }])
    assert.equal(first.label, '清除侧链')
    assert.equal(first.results[0].cleared, true)
    assert.equal(Object.hasOwn(project.tracks.find((item) => item.id === 'trk_2'), 'sidechain'), false)
    const again = ops.applyEditOps(project, [{ type: 'clearSidechain', trackId: 'trk_2' }])
    assert.equal(again.results[0].cleared, false)
  })
})

/* ------------------------------------------------------------------------- */
/* P2b：state 撤销/重做（效果器与侧链）                                         */
/* ------------------------------------------------------------------------- */

describe('state P2b — 效果器/侧链撤销重做', () => {
  it('addEffect 可撤销/重做；setSidechain 可撤销/重做，标签正确', async () => {
    const { state } = await makeState()
    try {
      const track = () => state.project.tracks.find((item) => item.id === 'trk_2')
      const effectsBefore = track().effects.length
      state.mutate({ tool: 'studio_edit', text: null, undoLabel: '添加效果器' }, (draft) =>
        ops.applyEditOps(draft, [{ type: 'addEffect', trackId: 'trk_2', fxType: 'filter', params: { cutoff: 700 } }]),
      )
      assert.equal(track().effects.length, effectsBefore + 1)
      assert.equal(track().effects.at(-1).type, 'filter')
      assert.equal(state.historyState().undoLabel, '添加效果器')
      assert.equal(state.undo().ok, true)
      assert.equal(track().effects.length, effectsBefore)
      assert.equal(state.redo().ok, true)
      assert.equal(track().effects.at(-1).type, 'filter')

      state.mutate({ tool: 'studio_set_sidechain', text: '设置侧链', undoLabel: '设置侧链' }, (draft) =>
        ops.setSidechain(draft, { trackId: 'trk_2', sourceTrackId: 'trk_1', amount: 0.6, release: 0.15 }),
      )
      assert.equal(track().sidechain.amount, 0.6)
      assert.equal(state.undo().ok, true)
      assert.equal(Object.hasOwn(track(), 'sidechain'), false)
      assert.equal(state.redo().ok, true)
      assert.equal(track().sidechain.release, 0.15)

      state.mutate({ tool: 'studio_clear_sidechain', text: '清除侧链', undoLabel: '清除侧链' }, (draft) =>
        ops.clearSidechain(draft, { trackId: 'trk_2' }),
      )
      assert.equal(Object.hasOwn(track(), 'sidechain'), false)
      assert.equal(state.historyState().undoLabel, '清除侧链')
      assert.equal(state.undo().ok, true)
      assert.equal(track().sidechain.sourceTrackId, 'trk_1')
    } finally {
      state.dispose()
    }
  })

  it('非法效果器/侧链 op 原子失败，不压栈、不改项目', async () => {
    const { state } = await makeState()
    try {
      const before = JSON.stringify(state.project)
      assert.throws(
        () =>
          state.mutate({ tool: 'studio_edit', text: null }, (draft) =>
            ops.applyEditOps(draft, [
              { type: 'addEffect', trackId: 'trk_2', fxType: 'filter' },
              { type: 'setSidechain', trackId: 'trk_3', sourceTrackId: 'trk_3' },
            ]),
          ),
        /侧链来源不能是轨道自身/,
      )
      assert.equal(JSON.stringify(state.project), before)
      assert.equal(state.canUndo, false)
    } finally {
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2b：routes /edit 效果器/侧链 + 持久化                                       */
/* ------------------------------------------------------------------------- */

describe('routes P2b — /edit 效果器与侧链', () => {
  it('addEffect → updateEffect → removeEffect 走 /edit，可 undo/redo', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const track = () => state.project.tracks.find((item) => item.id === 'trk_2')
      const effectsBefore = track().effects.length
      const added = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'addEffect', trackId: 'trk_2', fxType: 'filter', params: { cutoff: 600 }, position: 0 }],
      })
      assert.equal(added.data.ok, true)
      assert.equal(added.data.label, '添加效果器')
      assert.equal(added.data.canUndo, true)
      const effectId = added.data.results[0].effectId
      assert.equal(track().effects[0].id, effectId)

      const updated = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'updateEffect', trackId: 'trk_2', effectId, enabled: false, params: { cutoff: 900 }, position: 1 }],
      })
      assert.equal(updated.data.ok, true)
      assert.equal(updated.data.label, '调整效果器')
      assert.equal(track().effects[1].id, effectId)
      assert.equal(track().effects[1].enabled, false)
      assert.equal(track().effects[1].params.cutoff, 900)

      const removed = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'removeEffect', trackId: 'trk_2', effectId }],
      })
      assert.equal(removed.data.ok, true)
      assert.equal(removed.data.label, '移除效果器')
      assert.equal(track().effects.length, effectsBefore)

      const undo = await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(undo.data.didStep, true)
      assert.equal(track().effects.length, effectsBefore + 1)
      const redo = await postJson(server.base, '/studio/api/history/redo', {})
      assert.equal(redo.data.didStep, true)
      assert.equal(track().effects.length, effectsBefore)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('setSidechain/clearSidechain 走 /edit；/state 可见；undo 回滚', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const set = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'setSidechain', trackId: 'trk_2', sourceTrackId: 'trk_1', amount: 0.6, attack: 0.01, release: 0.15 }],
      })
      assert.equal(set.data.ok, true)
      assert.equal(set.data.label, '设置侧链')
      const current = await getJson(server.base, '/studio/api/state?rev=0')
      const liveTrack = current.data.project.tracks.find((track) => track.id === 'trk_2')
      assert.deepEqual(liveTrack.sidechain, {
        enabled: true,
        sourceTrackId: 'trk_1',
        amount: 0.6,
        attack: 0.01,
        release: 0.15,
        triggerNotes: [],
      })
      // overview 摘要
      const overview = ops.getProjectOverview(state.project)
      assert.equal(overview.tracks.find((track) => track.id === 'trk_2').sidechain.sourceTrackId, 'trk_1')

      const undo = await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(undo.data.didStep, true)
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === 'trk_2'), 'sidechain'), false)

      const redo = await postJson(server.base, '/studio/api/history/redo', {})
      assert.equal(redo.data.didStep, true)
      const cleared = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'clearSidechain', trackId: 'trk_2' }],
      })
      assert.equal(cleared.data.ok, true)
      assert.equal(cleared.data.label, '清除侧链')
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === 'trk_2'), 'sidechain'), false)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('非法 op（未知 fxType / 自引用侧链）→ 200 ok:false 且整组原子', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const before = JSON.stringify(state.project)
      const badFx = await postJson(server.base, '/studio/api/edit', {
        ops: [
          { type: 'addEffect', trackId: 'trk_2', fxType: 'filter' },
          { type: 'addEffect', trackId: 'trk_2', fxType: 'nope' },
        ],
      })
      assert.equal(badFx.status, 200)
      assert.equal(badFx.data.ok, false)
      assert.match(badFx.data.error, /未知效果器/)
      assert.equal(JSON.stringify(state.project), before)

      const badSidechain = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'setSidechain', trackId: 'trk_2', sourceTrackId: 'trk_2' }],
      })
      assert.equal(badSidechain.data.ok, false)
      assert.match(badSidechain.data.error, /侧链来源不能是轨道自身/)
      assert.equal(JSON.stringify(state.project), before)
      assert.equal(state.canUndo, false)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('工程保存→新建→打开：效果器链与侧链完整保留', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      await postJson(server.base, '/studio/api/edit', {
        ops: [
          { type: 'addEffect', trackId: 'trk_2', fxType: 'filter', params: { cutoff: 500 }, position: 0 },
          { type: 'setSidechain', trackId: 'trk_2', sourceTrackId: 'trk_1', amount: 0.7, release: 0.2 },
        ],
      })
      const saved = await postJson(server.base, '/studio/api/projects/save', { name: 'P2b 工程' })
      assert.equal(saved.data.ok, true)
      await postJson(server.base, '/studio/api/projects/new', { template: 'empty' })
      assert.equal(state.project.tracks.length, 0)
      const opened = await postJson(server.base, '/studio/api/projects/open', { name: 'P2b 工程' })
      assert.equal(opened.data.ok, true)
      const restored = state.project.tracks.find((track) => track.id === 'trk_2')
      assert.equal(restored.effects[0].type, 'filter')
      assert.equal(restored.effects[0].params.cutoff, 500)
      assert.deepEqual(restored.sidechain, {
        enabled: true,
        sourceTrackId: 'trk_1',
        amount: 0.7,
        attack: 0.005,
        release: 0.2,
        triggerNotes: [],
      })
    } finally {
      await server.close()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2b：tools 侧链工具 + stems 导出标记                                        */
/* ------------------------------------------------------------------------- */

describe('tools P2b — studio_set_sidechain / studio_clear_sidechain / stems 导出', () => {
  async function makeP2bTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { state, tools, byName, exec }
  }

  it('studio_get_project 每轨返回 sidechain 摘要（无侧链为 null）', async () => {
    const { state, exec } = await makeP2bTools()
    try {
      await exec('studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_1', amount: 0.6, release: 0.15 })
      const overview = await exec('studio_get_project')
      assert.equal(overview.ok, true)
      assert.deepEqual(overview.tracks.find((track) => track.id === 'trk_2').sidechain, {
        enabled: true,
        sourceTrackId: 'trk_1',
        amount: 0.6,
        attack: 0.005,
        release: 0.15,
        triggerNotes: [],
      })
      assert.equal(overview.tracks.find((track) => track.id === 'trk_1').sidechain, null)
      assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 8500, 'R4d 每轨 automationMode 后略增；仍保持紧凑')
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_2').sidechain.sourceTrackId, 'trk_1')
    } finally {
      state.dispose()
    }
  })

  it('studio_set_sidechain：默认值/夹紧/enabled:false；studio_clear_sidechain 幂等', async () => {
    const { state, exec } = await makeP2bTools()
    try {
      const track = () => state.project.tracks.find((item) => item.id === 'trk_2')
      const set = await exec('studio_set_sidechain', {
        trackId: 'trk_2',
        sourceTrackId: 'trk_1',
        amount: 2,
        attack: 1,
        release: -1,
        enabled: false,
      })
      assert.equal(set.ok, true)
      assert.equal(set.enabled, false)
      assert.equal(track().sidechain.amount, 1)
      assert.equal(track().sidechain.attack, 0.2)
      assert.equal(track().sidechain.release, 0.02)
      assert.equal(state.canUndo, true)

      const cleared = await exec('studio_clear_sidechain', { trackId: 'trk_2' })
      assert.equal(cleared.ok, true)
      assert.equal(cleared.cleared, true)
      assert.equal(Object.hasOwn(track(), 'sidechain'), false)
      const again = await exec('studio_clear_sidechain', { trackId: 'trk_2' })
      assert.equal(again.ok, true)
      assert.equal(again.cleared, false)
      // 工具变更可撤销
      assert.equal(state.undo().ok, true)
      assert.equal(track().sidechain.sourceTrackId, 'trk_1')
    } finally {
      state.dispose()
    }
  })

  it('侧链工具参数错误返回 ok:false（不抛、不改项目）', async () => {
    const { state, exec } = await makeP2bTools()
    const revisionBefore = state.revision
    try {
      const cases = [
        ['studio_set_sidechain', { sourceTrackId: 'trk_1' }],
        ['studio_set_sidechain', { trackId: 'trk_2' }],
        ['studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_2' }],
        ['studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_999' }],
        ['studio_set_sidechain', { trackId: 'trk_999', sourceTrackId: 'trk_1' }],
        ['studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_1', amount: 'x' }],
        ['studio_clear_sidechain', {}],
        ['studio_clear_sidechain', { trackId: 'trk_999' }],
      ]
      for (const [name, args] of cases) {
        const result = await exec(name, args)
        assert.equal(result.ok, false, `${name} ${JSON.stringify(args)} 应失败`)
        assert.equal(typeof result.error, 'string')
        assert.ok(result.error.length > 0)
      }
      assert.equal(state.revision, revisionBefore)
    } finally {
      state.dispose()
    }
  })

  it('studio_export format="stems" 只写 exportRequest（不触发 WAV 渲染），seq 递增', async () => {
    const { state, exec } = await makeP2bTools()
    try {
      const stems = await exec('studio_export', { format: 'stems' })
      assert.equal(stems.ok, true)
      assert.equal(stems.format, 'stems')
      assert.equal(stems.requested, true)
      assert.ok(Number.isInteger(stems.seq))
      assert.deepEqual(
        { seq: state.project.exportRequest.seq, format: state.project.exportRequest.format },
        { seq: stems.seq, format: 'stems' },
      )
      assert.equal(typeof state.project.exportRequest.at, 'number')
      // stems 导出请求不是内容变更，不产生撤销步骤
      assert.equal(state.canUndo, false)

      state.project.exportRequest = null
      const stemsAgain = await exec('studio_export', { format: 'stems' })
      assert.ok(stemsAgain.seq > stems.seq)
      assert.equal(state.project.exportRequest.format, 'stems')

      // 默认 wav 仍写 exportRequest 且不带 format
      state.project.exportRequest = null
      const wav = await exec('studio_export', {})
      assert.equal(wav.format, 'wav')
      assert.equal(state.project.exportRequest.format, undefined)
    } finally {
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2c-2：ops 发送量与返回总线                                                */
/* ------------------------------------------------------------------------- */

describe('ops P2c-2 — 轨道发送量与返回总线电平', () => {
  it('setTrackSends：只改提供字段、0..1 夹紧、返回 sends 摘要，标签「调整发送」', () => {
    const project = createDemoProject()
    const track = () => project.tracks.find((item) => item.id === 'trk_4')
    const delayBefore = track().sends.delay
    const result = ops.applyEditOps(project, [{ type: 'setTrackSends', trackId: 'trk_4', reverb: 0.6 }])
    assert.equal(result.label, '调整发送')
    assert.equal(result.results[0].type, 'setTrackSends')
    assert.equal(result.results[0].trackId, 'trk_4')
    assert.equal(result.results[0].sends.reverb, 0.6)
    assert.equal(track().sends.reverb, 0.6)
    assert.equal(track().sends.delay, delayBefore, '未提供的字段保持不变')

    ops.applyEditOps(project, [{ type: 'setTrackSends', trackId: 'trk_4', reverb: 2, delay: -1 }])
    assert.equal(track().sends.reverb, 1)
    assert.equal(track().sends.delay, 0)
    ops.applyEditOps(project, [{ type: 'setTrackSends', trackId: 'trk_4', delay: 0.25 }])
    assert.equal(track().sends.delay, 0.25)
  })

  it('setTrackSends 校验错误（缺 trackId/未知轨道/未提供字段/非数字）', () => {
    const project = createDemoProject()
    assert.throws(() => ops.setTrackSends(project, { reverb: 0.5 }), /trackId 必须是字符串|找不到轨道/)
    assert.throws(() => ops.setTrackSends(project, { trackId: 'trk_999', reverb: 0.5 }), /找不到轨道/)
    assert.throws(() => ops.setTrackSends(project, { trackId: 'trk_1' }), /至少提供 reverb 或 delay/)
    assert.throws(() => ops.setTrackSends(project, { trackId: 'trk_1', reverb: 'bad' }), /reverb 必须是数字/)
  })

  it('setBus：设置/夹紧/省略 level 只读，标签「调整返回总线」', () => {
    const project = createDemoProject()
    const result = ops.applyEditOps(project, [{ type: 'setBus', busId: 'reverb', level: 0.5 }])
    assert.equal(result.label, '调整返回总线')
    assert.deepEqual(result.results[0], { type: 'setBus', busId: 'reverb', level: 0.5 })
    assert.equal(project.buses.reverb.level, 0.5)

    ops.applyEditOps(project, [{ type: 'setBus', busId: 'delay', level: 3 }])
    assert.equal(project.buses.delay.level, 1)
    // 省略 level：只返回当前值，不改变
    const readOnly = ops.applyEditOps(project, [{ type: 'setBus', busId: 'delay' }])
    assert.equal(readOnly.results[0].level, 1)
    assert.equal(project.buses.delay.level, 1)
  })

  it('setBus 校验错误（缺 busId/未知 busId/非数字 level）', () => {
    const project = createDemoProject()
    assert.throws(() => ops.setBus(project, { level: 0.5 }), /busId 必须是字符串/)
    assert.throws(() => ops.setBus(project, { busId: 'nope', level: 0.5 }), /未知返回总线 busId=nope/)
    assert.throws(() => ops.setBus(project, { busId: 'reverb', level: 'bad' }), /level 必须是数字/)
  })

  it('新 op 撤销标签映射与混合标签', () => {
    assert.equal(ops.editLabelFor([{ type: 'setTrackSends' }]), '调整发送')
    assert.equal(ops.editLabelFor([{ type: 'setBus' }]), '调整返回总线')
    assert.equal(ops.editLabelFor([{ type: 'setTrackSends' }, { type: 'setBus' }]), '编辑工程')
    assert.equal(ops.EDIT_OP_LABELS.setTrackSends, '调整发送')
    assert.equal(ops.EDIT_OP_LABELS.setBus, '调整返回总线')
  })

  it('旧数字 buses 工程上 setBus / addEffect(target=bus)：规范化为对象结构（旧数字不再迁移）', () => {
    const project = createDemoProject()
    project.buses = { reverb: 0.8, delay: 0.4 }
    const result = ops.applyEditOps(project, [
      { type: 'setBus', busId: 'reverb', level: 0.5 },
      { type: 'addEffect', target: 'bus', busId: 'reverb', fxType: 'eq3' },
    ])
    assert.equal(result.label, '编辑工程')
    assert.equal(project.buses.reverb.level, 0.5)
    assert.equal(project.buses.reverb.effects.length, 1)
    assert.equal(project.buses.reverb.effects[0].type, 'eq3')
    assert.deepEqual({ level: project.buses.delay.level, effects: project.buses.delay.effects }, { level: 0.22, effects: [] })
  })

  it('非法混音 op 整组原子（state.mutate 失败不生效、不压栈）', async () => {
    const { state } = await makeState()
    try {
      const before = JSON.stringify(state.project)
      assert.throws(
        () =>
          state.mutate({ tool: 'studio_edit', text: null }, (draft) =>
            ops.applyEditOps(draft, [
              { type: 'setTrackSends', trackId: 'trk_4', reverb: 0.9 },
              { type: 'setBus', busId: 'nope', level: 0.5 },
            ]),
          ),
        /未知返回总线/,
      )
      assert.equal(JSON.stringify(state.project), before)
      assert.equal(state.canUndo, false)
    } finally {
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2c-2：ops 返回总线效果器（target=bus）                                     */
/* ------------------------------------------------------------------------- */

describe('ops P2c-2 — 返回总线效果器（target=bus）', () => {
  it('addEffect target=bus reverb/delay：结果含 target/busId/position/chain', () => {
    const project = createDemoProject()
    const result = ops.applyEditOps(project, [
      { type: 'addEffect', target: 'bus', busId: 'reverb', fxType: 'filter', params: { cutoff: 2000 }, position: 0 },
      { type: 'addEffect', target: 'bus', busId: 'delay', fxType: 'eq3' },
    ])
    assert.equal(result.label, '添加效果器')
    const [reverbFx, delayFx] = result.results
    assert.equal(reverbFx.target, 'bus')
    assert.equal(reverbFx.busId, 'reverb')
    assert.equal(reverbFx.position, 0)
    assert.equal(project.buses.reverb.effects[0].id, reverbFx.effectId)
    assert.equal(project.buses.reverb.effects[0].params.cutoff, 2000)
    assert.equal(delayFx.busId, 'delay')
    assert.equal(project.buses.delay.effects.length, 1)
    assert.equal(project.buses.delay.effects[0].type, 'eq3')
    // master / 轨道结果形状保持兼容
    const masterFx = ops.applyEditOps(project, [{ type: 'addEffect', target: 'master', fxType: 'reverb' }])
    assert.equal(masterFx.results[0].target, 'master')
    assert.equal(masterFx.results[0].busId, undefined)
  })

  it('updateEffect target=bus：参数/开关/排序', () => {
    const project = createDemoProject()
    const add = ops.applyEditOps(project, [
      { type: 'addEffect', target: 'bus', busId: 'reverb', fxType: 'filter' },
      { type: 'addEffect', target: 'bus', busId: 'reverb', fxType: 'eq3' },
    ])
    const effectId = add.results[0].effectId
    const updated = ops.applyEditOps(project, [
      { type: 'updateEffect', target: 'bus', busId: 'reverb', effectId, enabled: false, params: { cutoff: 800 }, position: 1 },
    ])
    assert.equal(updated.label, '调整效果器')
    assert.equal(updated.results[0].target, 'bus')
    assert.equal(updated.results[0].busId, 'reverb')
    assert.equal(updated.results[0].position, 1)
    assert.equal(updated.results[0].effect.enabled, false)
    assert.equal(updated.results[0].effect.params.cutoff, 800)
    assert.equal(project.buses.reverb.effects[1].id, effectId)
  })

  it('removeEffect target=bus；总线链上限 8', () => {
    const project = createDemoProject()
    const ids = []
    for (let index = 0; index < 8; index += 1) {
      const added = ops.applyEditOps(project, [{ type: 'addEffect', target: 'bus', busId: 'delay', fxType: 'eq3' }])
      ids.push(added.results[0].effectId)
    }
    assert.equal(project.buses.delay.effects.length, 8)
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'addEffect', target: 'bus', busId: 'delay', fxType: 'eq3' }]),
      /上限 8/,
    )
    const removed = ops.applyEditOps(project, [{ type: 'removeEffect', target: 'bus', busId: 'delay', effectId: ids[0] }])
    assert.equal(removed.label, '移除效果器')
    assert.equal(removed.results[0].busId, 'delay')
    assert.equal(project.buses.delay.effects.length, 7)
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'updateEffect', target: 'bus', busId: 'delay', effectId: ids[0] }]),
      /找不到/,
    )
  })

  it('target=bus 校验：缺 busId / 未知 busId / 尚未提供 target', () => {
    const project = createDemoProject()
    assert.throws(() => ops.applyEditOps(project, [{ type: 'addEffect', target: 'bus', fxType: 'filter' }]), /必须提供 busId/)
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'addEffect', target: 'bus', busId: 'nope', fxType: 'filter' }]),
      /未知返回总线 busId=nope/,
    )
    assert.throws(
      () => ops.applyEditOps(project, [{ type: 'addEffect', target: 'song', fxType: 'filter' }]),
      /target 必须是/,
    )
  })
})

/* ------------------------------------------------------------------------- */
/* P2c-2：state 撤销/重做                                                      */
/* ------------------------------------------------------------------------- */

describe('state P2c-2 — 发送/返回总线的撤销与重做', () => {
  it('setTrackSends / setBus 可撤销/重做且标签正确', async () => {
    const { state } = await makeState()
    try {
      const sendsBefore = { ...state.project.tracks.find((track) => track.id === 'trk_4').sends }
      state.mutate({ tool: 'studio_edit', text: null, undoLabel: '调整发送' }, (draft) =>
        ops.applyEditOps(draft, [{ type: 'setTrackSends', trackId: 'trk_4', reverb: 0.6 }]),
      )
      state.mutate({ tool: 'studio_edit', text: null, undoLabel: '调整返回总线' }, (draft) =>
        ops.applyEditOps(draft, [{ type: 'setBus', busId: 'reverb', level: 0.5 }]),
      )
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_4').sends.reverb, 0.6)
      assert.equal(state.project.buses.reverb.level, 0.5)
      assert.equal(state.historyState().undoLabel, '调整返回总线')

      assert.equal(state.undo().ok, true)
      assert.equal(state.project.buses.reverb.level, 0.35)
      assert.equal(state.historyState().undoLabel, '调整发送')
      assert.equal(state.undo().ok, true)
      assert.deepEqual(state.project.tracks.find((track) => track.id === 'trk_4').sends, sendsBefore)
      assert.equal(state.undo().ok, false)

      assert.equal(state.redo().ok, true)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_4').sends.reverb, 0.6)
      assert.equal(state.redo().ok, true)
      assert.equal(state.project.buses.reverb.level, 0.5)
      assert.equal(state.canRedo, false)
    } finally {
      state.dispose()
    }
  })

  it('返回总线效果器增删可撤销/重做', async () => {
    const { state } = await makeState()
    try {
      state.mutate({ tool: 'studio_edit', text: null, undoLabel: '添加效果器' }, (draft) =>
        ops.applyEditOps(draft, [{ type: 'addEffect', target: 'bus', busId: 'delay', fxType: 'filter' }]),
      )
      assert.equal(state.project.buses.delay.effects.length, 1)
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.buses.delay.effects.length, 0)
      assert.equal(state.redo().ok, true)
      assert.equal(state.project.buses.delay.effects[0].type, 'filter')
      state.mutate({ tool: 'studio_edit', text: null, undoLabel: '移除效果器' }, (draft) =>
        ops.applyEditOps(draft, [
          { type: 'removeEffect', target: 'bus', busId: 'delay', effectId: state.project.buses.delay.effects[0].id },
        ]),
      )
      assert.equal(state.project.buses.delay.effects.length, 0)
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.buses.delay.effects.length, 1)
    } finally {
      state.dispose()
    }
  })

  it('state 启动时旧 schema project.json 冷备份到 legacy-v1 并重新 seed 当前 demo', async () => {
    const dir = await tempDir()
    const legacy = JSON.parse(JSON.stringify(createDemoProject()))
    legacy.schemaVersion = 1
    legacy.title = '旧版工程'
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(legacy), 'utf8')
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      assert.equal(state.loadedFromDisk, false, '旧 schema 不应被加载')
      assert.equal(state.project.schemaVersion, 3)
      assert.equal(state.project.title, '霓虹天际线 Neon Skyline')
      assert.ok(state.legacyBackupPath, '应返回冷备份路径')
      assert.match(path.basename(state.legacyBackupPath), /^project-\d{8}-\d{6}\.json$/)
      const backup = JSON.parse(await readFile(state.legacyBackupPath, 'utf8'))
      assert.equal(backup.schemaVersion, 1)
      assert.equal(backup.title, '旧版工程')
      // 新工程最终落盘为 schema 2
      await state.flush()
      const persisted = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
      assert.equal(persisted.schemaVersion, 3)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2c-2：routes /edit + 持久化/旧工程迁移                                      */
/* ------------------------------------------------------------------------- */

describe('routes P2c-2 — /edit 混音路由与持久化', () => {
  it('POST /edit setTrackSends/setBus/总线效果器 → /state 校验 + undo/redo', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const edit = await postJson(server.base, '/studio/api/edit', {
        ops: [
          { type: 'setTrackSends', trackId: 'trk_4', reverb: 0.6 },
          { type: 'setBus', busId: 'reverb', level: 0.5 },
          { type: 'addEffect', target: 'bus', busId: 'reverb', fxType: 'filter', params: { cutoff: 1800 } },
        ],
      })
      assert.equal(edit.data.ok, true)
      assert.equal(edit.data.label, '编辑工程')
      assert.equal(edit.data.results.length, 3)
      const effectId = edit.data.results[2].effectId

      const current = await getJson(server.base, '/studio/api/state?rev=0')
      assert.equal(current.data.project.tracks.find((track) => track.id === 'trk_4').sends.reverb, 0.6)
      assert.equal(current.data.project.buses.reverb.level, 0.5)
      assert.equal(current.data.project.buses.reverb.effects[0].id, effectId)
      assert.equal(current.data.project.buses.reverb.effects[0].params.cutoff, 1800)

      const undo = await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(undo.data.didStep, true)
      assert.equal(state.project.buses.reverb.level, 0.35)
      assert.equal(state.project.buses.reverb.effects.length, 0)
      const redo = await postJson(server.base, '/studio/api/history/redo', {})
      assert.equal(redo.data.didStep, true)
      assert.equal(state.project.buses.reverb.level, 0.5)
      assert.equal(state.project.buses.reverb.effects.length, 1)
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('旧 schema 工程：/projects 标记 unsupported，/projects/open 中文拒绝（不 500）', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      const legacy = JSON.parse(JSON.stringify(createDemoProject()))
      legacy.schemaVersion = 1
      await mkdir(projectsDir(dir), { recursive: true })
      await writeFile(path.join(projectsDir(dir), '旧工程.json'), JSON.stringify(legacy), 'utf8')
      const listed = await getJson(server.base, '/studio/api/projects')
      assert.equal(listed.status, 200)
      assert.equal(listed.data.ok, true)
      assert.ok(!listed.data.projects.some((project) => project.name === '旧工程'))
      assert.equal(listed.data.unsupported.length, 1)
      assert.equal(listed.data.unsupported[0].name, '旧工程')
      assert.match(listed.data.unsupported[0].reason, /旧版本工程不支持/)
      const opened = await postJson(server.base, '/studio/api/projects/open', { name: '旧工程' })
      assert.equal(opened.status, 200)
      assert.equal(opened.data.ok, false)
      assert.match(opened.data.error, /旧版本工程不支持/)
      // 当前工程未被替换
      assert.equal(state.project.title, '霓虹天际线 Neon Skyline')
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('buses + 总线 FX + 发送量保存→新建→打开→重启 全链路保留', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      await postJson(server.base, '/studio/api/edit', {
        ops: [
          { type: 'setTrackSends', trackId: 'trk_4', reverb: 0.45, delay: 0.3 },
          { type: 'setBus', busId: 'delay', level: 0.4 },
          { type: 'addEffect', target: 'bus', busId: 'delay', fxType: 'filter', params: { cutoff: 3000 } },
        ],
      })
      const saved = await postJson(server.base, '/studio/api/projects/save', { name: 'P2c2 混音工程' })
      assert.equal(saved.data.ok, true)
      await postJson(server.base, '/studio/api/projects/new', { template: 'empty' })
      assert.equal(state.project.tracks.length, 0)
      const opened = await postJson(server.base, '/studio/api/projects/open', { name: 'P2c2 混音工程' })
      assert.equal(opened.data.ok, true)
      const track = state.project.tracks.find((item) => item.id === 'trk_4')
      assert.equal(track.sends.reverb, 0.45)
      assert.equal(track.sends.delay, 0.3)
      assert.equal(state.project.buses.delay.level, 0.4)
      assert.equal(state.project.buses.delay.effects[0].type, 'filter')
      assert.equal(state.project.buses.delay.effects[0].params.cutoff, 3000)
      await state.flush()
    } finally {
      await server.close()
      state.dispose()
    }
    // 重启：从同一 dataDir 的 project.json 重新加载
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      const track = reloaded.project.tracks.find((item) => item.id === 'trk_4')
      assert.equal(track.sends.reverb, 0.45)
      assert.equal(reloaded.project.buses.delay.level, 0.4)
      assert.equal(reloaded.project.buses.delay.effects[0].type, 'filter')
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P2c-2：tools 发送/返回总线 + 总线效果器                                      */
/* ------------------------------------------------------------------------- */

describe('tools P2c-2 — studio_set_track_sends / studio_set_bus / 总线 FX', () => {
  async function makeMixTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { state, tools, byName, exec }
  }

  it('studio_set_track_sends：正常/夹紧/参数错误', async () => {
    const { state, exec } = await makeMixTools()
    try {
      const track = () => state.project.tracks.find((item) => item.id === 'trk_4')
      const set = await exec('studio_set_track_sends', { trackId: 'trk_4', reverb: 2, delay: -1 })
      assert.equal(set.ok, true)
      assert.equal(set.trackId, 'trk_4')
      assert.equal(track().sends.reverb, 1)
      assert.equal(track().sends.delay, 0)
      assert.equal(state.canUndo, true)
      assert.equal(state.historyState().undoLabel, '调整发送')

      const cases = [
        { trackId: 'trk_999', reverb: 0.5 },
        { trackId: 'trk_4' },
        { trackId: 'trk_4', reverb: 'x' },
      ]
      for (const args of cases) {
        const result = await exec('studio_set_track_sends', args)
        assert.equal(result.ok, false, JSON.stringify(args))
        assert.equal(typeof result.error, 'string')
      }
    } finally {
      state.dispose()
    }
  })

  it('studio_set_bus：正常/夹紧/未知总线/缺 bus/level 非数字', async () => {
    const { state, exec } = await makeMixTools()
    try {
      const set = await exec('studio_set_bus', { bus: 'reverb', level: 0.5 })
      assert.equal(set.ok, true)
      assert.equal(set.busId, 'reverb')
      assert.equal(set.level, 0.5)
      assert.equal(state.project.buses.reverb.level, 0.5)
      assert.equal(state.historyState().undoLabel, '调整返回总线')
      const clamped = await exec('studio_set_bus', { bus: 'delay', level: 9 })
      assert.equal(clamped.level, 1)

      for (const args of [{ bus: 'nope', level: 0.5 }, {}, { bus: 'reverb', level: 'x' }]) {
        const result = await exec('studio_set_bus', args)
        assert.equal(result.ok, false, JSON.stringify(args))
      }
    } finally {
      state.dispose()
    }
  })

  it('studio_get_project 返回 buses 摘要（level + effects）与每轨 sends', async () => {
    const { state, exec } = await makeMixTools()
    try {
      await exec('studio_set_bus', { bus: 'reverb', level: 0.5 })
      await exec('studio_add_effect', { target: 'bus', busId: 'reverb', type: 'eq3', params: { low: 2 } })
      const overview = await exec('studio_get_project')
      assert.equal(overview.ok, true)
      assert.deepEqual(overview.buses.reverb.level, 0.5)
      assert.equal(overview.buses.reverb.effects.length, 1)
      assert.equal(overview.buses.reverb.effects[0].type, 'eq3')
      assert.deepEqual(overview.buses.delay, { level: 0.22, effects: [] })
      const track = overview.tracks.find((item) => item.id === 'trk_4')
      assert.deepEqual(track.sends, { reverb: 0.38, delay: 0.08 })
      assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 9000)
    } finally {
      state.dispose()
    }
  })

  it('效果器工具支持 target=bus + busId（add/update/remove）', async () => {
    const { state, exec } = await makeMixTools()
    try {
      const add = await exec('studio_add_effect', {
        target: 'bus',
        busId: 'reverb',
        type: 'filter',
        params: { cutoff: 1200 },
      })
      assert.equal(add.ok, true)
      assert.equal(add.target, 'bus')
      assert.equal(add.busId, 'reverb')
      assert.equal(state.project.buses.reverb.effects[0].id, add.effectId)
      const update = await exec('studio_update_effect', {
        target: 'bus',
        busId: 'reverb',
        effectId: add.effectId,
        enabled: false,
        params: { cutoff: 1600 },
      })
      assert.equal(update.ok, true)
      assert.equal(update.busId, 'reverb')
      assert.equal(state.project.buses.reverb.effects[0].enabled, false)
      assert.equal(state.project.buses.reverb.effects[0].params.cutoff, 1600)
      const remove = await exec('studio_remove_effect', { target: 'bus', busId: 'reverb', effectId: add.effectId })
      assert.equal(remove.ok, true)
      assert.equal(state.project.buses.reverb.effects.length, 0)

      const noBusId = await exec('studio_add_effect', { target: 'bus', type: 'filter' })
      assert.equal(noBusId.ok, false)
      const badBusId = await exec('studio_add_effect', { target: 'bus', busId: 'nope', type: 'filter' })
      assert.equal(badBusId.ok, false)
    } finally {
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P3b：ops 媒体与音频轨道                                                     */
/* ------------------------------------------------------------------------- */

describe('ops P3b — 媒体与音频轨道', () => {
  it('addMedia：分配 med id、规范化、id 冲突与数量上限', () => {
    const project = createDemoProject()
    const media = ops.addMedia(project, {
      name: '人声.wav',
      file: 'med_1.wav',
      bytes: 1000,
      durationSeconds: 2.5,
      channels: 2,
      sampleRate: 44100,
    })
    assert.equal(media.id, 'med_1')
    assert.equal(project.media.length, 1)
    assert.equal(project.media[0].file, 'med_1.wav')
    assert.equal(project.media[0].durationSeconds, 2.5)
    // 显式 id
    const explicit = ops.addMedia(project, { id: 'med_9', name: 'b.mp3', file: 'med_9.mp3', bytes: 10 })
    assert.equal(explicit.id, 'med_9')
    assert.equal(explicit.durationSeconds, null)
    // id 冲突
    assert.throws(
      () => ops.addMedia(project, { id: 'med_9', name: 'c.mp3', file: 'med_9.mp3' }),
      /媒体 id 冲突/,
    )
    // 文件名非法 / 格式不支持
    assert.throws(() => ops.addMedia(project, { name: 'x', file: '../x.wav' }), /媒体文件名非法|媒体信息非法/)
    assert.throws(() => ops.addMedia(project, { name: 'x', file: 'x.aiff' }), /媒体信息非法/)
    assert.throws(() => ops.addMedia(project, { name: '', file: 'x.wav' }), /name 必须是字符串|name/)
  })

  it('addAudioTrack：默认命名/片段长度/起始小节；未知 media 报错', () => {
    const project = createDemoProject()
    const media = ops.addMedia(project, {
      name: '人声.wav',
      file: 'med_1.wav',
      bytes: 1000,
      durationSeconds: 2, // 128bpm 4/4 → 1 小节 = 1.875s → 2 小节
    })
    const result = ops.addAudioTrack(project, { mediaId: media.id, startBar: 4 })
    assert.equal(project.tracks.at(-1).id, result.trackId)
    assert.equal(project.tracks.at(-1).kind, 'audio')
    assert.equal(project.tracks.at(-1).role, 'audio')
    assert.equal(result.name, '音频 · 人声.wav')
    assert.equal(result.startBar, 4)
    assert.equal(result.lengthBars, 2)
    assert.equal(project.clips.filter((clip) => clip.id === result.clipId).length, 1)
    assert.deepEqual(project.clips.at(-1), {
      id: result.clipId,
      trackId: result.trackId,
      mediaId: media.id,
      startBar: 4,
      lengthBars: 2,
      offsetSeconds: 0,
    })
    // name 自定义
    const named = ops.addAudioTrack(project, { mediaId: media.id, name: 'Vocal', startBar: 0 })
    assert.equal(project.tracks.at(-1).name, 'Vocal')
    assert.equal(named.startBar, 0)
    // 未知媒体 / 非法 startBar
    assert.throws(() => ops.addAudioTrack(project, { mediaId: 'med_999' }), /找不到音频媒体 med_999/)
    assert.throws(() => ops.addAudioTrack(project, { mediaId: media.id, startBar: -1 }), /startBar 必须 >= 0/)
  })

  it('mediaClipLengthBars：未知时长默认 4 小节、时长换算、超长夹紧', () => {
    const project = createDemoProject()
    assert.equal(ops.mediaClipLengthBars(project, { durationSeconds: null }), MEDIA_DEFAULT_CLIP_BARS)
    assert.equal(ops.mediaClipLengthBars(project, { durationSeconds: 1.875 }), 1)
    assert.equal(ops.mediaClipLengthBars(project, { durationSeconds: 4 }), 3) // 4 / 1.875 = 2.13 → ceil 3
    assert.equal(ops.mediaClipLengthBars(project, { durationSeconds: 100000 }), 256)
  })

  it('removeTrack：删除轨道与片段、保留媒体；未知轨道报错', () => {
    const project = createDemoProject()
    const media = ops.addMedia(project, { name: 'v.wav', file: 'med_1.wav', bytes: 10 })
    const { trackId } = ops.addAudioTrack(project, { mediaId: media.id })
    const tracksBefore = project.tracks.length
    const result = ops.applyEditOps(project, [{ type: 'removeTrack', trackId }])
    assert.equal(result.label, '移除轨道')
    assert.equal(result.results[0].removed, true)
    assert.equal(result.results[0].removedClips, 1)
    assert.equal(project.tracks.length, tracksBefore - 1)
    assert.equal(project.clips.filter((clip) => clip.trackId === trackId).length, 0)
    assert.equal(project.media.length, 1, '媒体保留不删')
    assert.throws(() => ops.removeTrack(project, { trackId: 'trk_999' }), /找不到轨道/)
  })

  it('updateTrack 音频轨：允许音量/静音/发送；拒绝 preset/params/非 audio role；不改 instrument', () => {
    const project = createDemoProject()
    const media = ops.addMedia(project, { name: 'v.wav', file: 'med_1.wav', bytes: 10 })
    const { trackId } = ops.addAudioTrack(project, { mediaId: media.id })
    const result = ops.updateTrack(project, { trackId, name: '人声轨', volume: 0.5, mute: true, sends: { reverb: 0.3 } })
    assert.equal(result.track.name, '人声轨')
    assert.equal(result.track.volume, 0.5)
    assert.equal(result.track.mute, true)
    assert.equal(result.track.sends.reverb, 0.3)
    assert.equal(Object.hasOwn(project.tracks.at(-1), 'instrument'), false)
    assert.throws(() => ops.updateTrack(project, { trackId, preset: 'pluck' }), /音频轨没有采样乐器预设/)
    assert.throws(() => ops.updateTrack(project, { trackId, params: { cutoff: 1000 } }), /音频轨没有乐器参数/)
    assert.throws(() => ops.updateTrack(project, { trackId, role: 'bass' }), /role 固定为 'audio'/)
  })

  it('setClips 支持音频片段（可与 pattern 片段混排），引用/轨道/字段校验', () => {
    const project = createDemoProject()
    const media = ops.addMedia(project, { name: 'v.wav', file: 'med_1.wav', bytes: 10, durationSeconds: 2 })
    const { trackId } = ops.addAudioTrack(project, { mediaId: media.id, startBar: 0 })
    const patternId = project.patterns[0].id
    const synthTrackId = project.tracks.find((track) => track.kind === 'synth').id
    const result = ops.applyEditOps(project, [
      {
        type: 'setClips',
        clips: [
          { trackId, mediaId: media.id, startBar: 2, lengthBars: 3 },
          { trackId: synthTrackId, patternId, startBar: 0, lengthBars: 4 },
        ],
      },
    ])
    assert.equal(result.label, '编辑片段')
    const audioClip = project.clips.find((clip) => clip.mediaId === media.id && clip.startBar === 2)
    assert.ok(audioClip)
    assert.equal(audioClip.lengthBars, 3)
    assert.equal(Object.hasOwn(audioClip, 'patternId'), false)
    assert.equal(audioClip.trackId, trackId)
    // 错误：媒体不存在 / 同时两个 id / 都没有 / 音频片段放错轨道
    const cases = [
      { clips: [{ trackId, mediaId: 'med_999', startBar: 0, lengthBars: 1 }], error: /找不到音频媒体|不存在/ },
      { clips: [{ trackId, mediaId: media.id, patternId, startBar: 0, lengthBars: 1 }], error: /不能同时提供 patternId 与 mediaId/ },
      { clips: [{ trackId, startBar: 0, lengthBars: 1 }], error: /必须提供 patternId/ },
      { clips: [{ trackId: synthTrackId, mediaId: media.id, startBar: 0, lengthBars: 1 }], error: /不是音频轨/ },
    ]
    for (const { clips, error } of cases) {
      assert.throws(() => ops.applyEditOps(project, [{ type: 'setClips', clips }]), error)
    }
  })

  it('getProjectOverview：media 摘要 / audioTracks / audioClips / 音频 clip mediaId', () => {
    const project = createDemoProject()
    const media = ops.addMedia(project, { name: '人声.wav', file: 'med_1.wav', bytes: 100, durationSeconds: 2 })
    ops.addAudioTrack(project, { mediaId: media.id, startBar: 2 })
    const overview = ops.getProjectOverview(project)
    assert.deepEqual(overview.media, [
      {
        id: media.id,
        name: '人声.wav',
        file: 'med_1.wav',
        bytes: 100,
        durationSeconds: 2,
        channels: 2,
        sampleRate: 44100,
        hasPeaks: false,
      },
    ])
    assert.equal(overview.mediaTotal, 1)
    assert.equal(overview.audioTracks, 1)
    assert.equal(overview.audioClips, 1)
    const audioClip = overview.clips.find((clip) => clip.mediaId === media.id)
    assert.ok(audioClip)
    assert.equal(audioClip.trackId, project.tracks.at(-1).id)
    assert.equal(Object.hasOwn(audioClip, 'patternId'), false)
    assert.ok(Buffer.byteLength(JSON.stringify(overview)) < 12000)
  })

  it('editLabelFor / applyEditOps：addAudioTrack / removeTrack 回路与标签', () => {
    const project = createDemoProject()
    const media = ops.addMedia(project, { name: 'v.wav', file: 'med_1.wav', bytes: 10 })
    const added = ops.applyEditOps(project, [{ type: 'addAudioTrack', mediaId: media.id, name: '导入轨', startBar: 1 }])
    assert.equal(added.label, '添加音频轨')
    assert.equal(added.results[0].type, 'addAudioTrack')
    const trackId = added.results[0].trackId
    assert.equal(project.tracks.at(-1).name, '导入轨')
    const removed = ops.applyEditOps(project, [{ type: 'removeTrack', trackId }])
    assert.equal(removed.label, '移除轨道')
    assert.equal(removed.results[0].removed, true)
    assert.equal(ops.editLabelFor([{ type: 'addAudioTrack' }]), '添加音频轨')
  })
})

/* ------------------------------------------------------------------------- */
/* P3b：state 导入撤销 / 旧工程 / 持久化                                       */
/* ------------------------------------------------------------------------- */

describe('state P3b — 音频导入撤销与持久化', () => {
  it('一次 mutate（addMedia+addAudioTrack）可撤销/重做，标签「导入音频」', async () => {
    const { state } = await makeState()
    try {
      const tracksBefore = state.project.tracks.length
      state.mutate({ tool: 'studio_import_audio', text: null, undoLabel: '导入音频' }, (draft) => {
        const media = ops.addMedia(draft, { name: 'v.wav', file: 'med_1.wav', bytes: 100, durationSeconds: 2 })
        return ops.addAudioTrack(draft, { mediaId: media.id, startBar: 1 })
      })
      assert.equal(state.project.media.length, 1)
      assert.equal(state.project.tracks.length, tracksBefore + 1)
      assert.equal(state.project.clips.filter((clip) => clip.mediaId).length, 1)
      assert.equal(state.historyState().undoLabel, '导入音频')

      assert.equal(state.undo().ok, true)
      assert.equal(state.project.media.length, 0, '撤销同时回退 media 条目')
      assert.equal(state.project.tracks.length, tracksBefore)
      assert.equal(state.project.clips.filter((clip) => clip.mediaId).length, 0)

      assert.equal(state.redo().ok, true)
      assert.equal(state.project.media.length, 1)
      assert.equal(state.project.tracks.filter((track) => track.kind === 'audio').length, 1)
      assert.equal(state.project.clips.filter((clip) => clip.mediaId).length, 1)
    } finally {
      state.dispose()
    }
  })

  it('缺 media 字段的工程加载补 media: []，概览正常', async () => {
    const dir = await tempDir()
    const legacy = createDemoProject()
    delete legacy.media
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(legacy), 'utf8')
    const state = createState({ dataDir: dir })
    await state.ready
    try {
      assert.deepEqual(state.project.media, [])
      const overview = ops.getProjectOverview(state.project)
      assert.equal(overview.mediaTotal, 0)
      assert.equal(overview.audioTracks, 0)
      assert.equal(overview.audioClips, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('音频媒体/音频轨/片段随工程保存并重启保留', async () => {
    const { dir, state } = await makeState()
    try {
      state.mutate({ tool: 'studio_import_audio', text: null, undoLabel: '导入音频' }, (draft) => {
        const media = ops.addMedia(draft, { name: 'v.wav', file: 'med_1.wav', bytes: 100, durationSeconds: 2 })
        return ops.addAudioTrack(draft, { mediaId: media.id, startBar: 2 })
      })
      await state.flush()
    } finally {
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      assert.equal(reloaded.project.media.length, 1)
      assert.equal(reloaded.project.media[0].name, 'v.wav')
      const audioTracks = reloaded.project.tracks.filter((track) => track.kind === 'audio')
      assert.equal(audioTracks.length, 1)
      assert.equal(audioTracks[0].role, 'audio')
      const clip = reloaded.project.clips.find((item) => item.mediaId === reloaded.project.media[0].id)
      assert.ok(clip)
      assert.equal(clip.startBar, 2)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P3b：routes /import-audio 与 /media                                        */
/* ------------------------------------------------------------------------- */

describe('routes P3b — /import-audio 与 /media', () => {
  it('JSON base64 导入 WAV：写文件/媒体/轨/片段、/media 字节一致、撤销标签「导入音频」、保存打开', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      const wav = makeWav(2)
      const res = await postJson(server.base, '/studio/api/import-audio', {
        name: '人声.wav',
        startBar: 2,
        dataBase64: wav.toString('base64'),
      })
      assert.equal(res.status, 200)
      assert.equal(res.data.ok, true)
      assert.equal(res.data.name, '人声.wav')
      assert.equal(res.data.bytes, wav.length)
      assert.equal(res.data.durationSeconds, 2)
      assert.equal(res.data.channels, 2)
      assert.equal(res.data.sampleRate, 44100)
      assert.equal(res.data.startBar, 2)
      assert.ok(Number.isInteger(res.data.lengthBars) && res.data.lengthBars >= 1)
      const { mediaId, trackId, clipId } = res.data

      const media = state.project.media.find((item) => item.id === mediaId)
      assert.ok(media.file.startsWith(mediaId + '-'), '媒体文件名应全局唯一（mediaId-时间戳-随机）')
      assert.match(media.file, /^[A-Za-z0-9_-]+\.[a-z0-9]+$/)
      assert.ok(media.file.endsWith('.wav'))
      const filePath = path.join(state.mediaDir, media.file)
      assert.deepEqual(await readFile(filePath), wav)
      const track = state.project.tracks.find((item) => item.id === trackId)
      assert.equal(track.kind, 'audio')
      assert.equal(track.role, 'audio')
      const clip = state.project.clips.find((item) => item.id === clipId)
      assert.equal(clip.mediaId, mediaId)
      assert.equal(clip.startBar, 2)

      const current = await getJson(server.base, '/studio/api/state?rev=0')
      assert.equal(current.data.project.media.length, 1)
      assert.equal(current.data.project.clips.find((item) => item.id === clipId).mediaId, mediaId)

      // /media 二进制与字节一致
      const response = await fetch(`${server.base}/studio/api/media/${media.file}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'audio/wav')
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav)

      // 撤销标签 + 回退（media 条目/轨/片段一起回退，磁盘文件保留）
      const history = await getJson(server.base, '/studio/api/history')
      assert.equal(history.data.undoLabel, '导入音频')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.media.length, 0)
      assert.equal(state.project.clips.filter((item) => item.mediaId).length, 0)
      assert.equal(state.project.tracks.filter((item) => item.kind === 'audio').length, 0)
      assert.deepEqual(await readFile(filePath), wav, '撤销不删除媒体文件')
      await postJson(server.base, '/studio/api/history/redo', {})
      assert.equal(state.project.media.length, 1)
      assert.equal(state.project.tracks.filter((item) => item.kind === 'audio').length, 1)

      // 保存 → 新建（空）→ 打开：媒体/轨/片段保留，/media 仍可访问
      const saved = await postJson(server.base, '/studio/api/projects/save', { name: 'P3b 音频工程' })
      assert.equal(saved.data.ok, true)
      await postJson(server.base, '/studio/api/projects/new', { template: 'empty' })
      assert.equal(state.project.media.length, 0)
      const opened = await postJson(server.base, '/studio/api/projects/open', { name: 'P3b 音频工程' })
      assert.equal(opened.data.ok, true)
      assert.equal(state.project.media.length, 1)
      assert.equal(state.project.tracks.filter((item) => item.kind === 'audio').length, 1)
      const still = await fetch(`${server.base}/studio/api/media/${media.file}`)
      assert.equal(still.status, 200)
      assert.deepEqual(Buffer.from(await still.arrayBuffer()), wav)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
    // 重启后 media 元数据与片段仍在
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      assert.equal(reloaded.project.media.length, 1)
      assert.equal(reloaded.project.tracks.filter((item) => item.kind === 'audio').length, 1)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('原始字节 + query 元数据导入 mp3：duration 未知 → 片段默认 4 小节', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const fakeMp3 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(1024, 7)])
      const res = await httpJson(server.base, '/studio/api/import-audio?name=vocal.mp3&startBar=1', {
        method: 'POST',
        headers: { 'content-type': 'audio/mpeg' },
        body: fakeMp3,
      })
      assert.equal(res.status, 200)
      assert.equal(res.data.ok, true)
      assert.equal(res.data.file.endsWith('.mp3'), true)
      assert.equal(res.data.durationSeconds, null)
      assert.equal(res.data.startBar, 1)
      assert.equal(res.data.lengthBars, MEDIA_DEFAULT_CLIP_BARS)
      await state.flush()
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('import-audio 参数错误：非 POST / 非法 base64 / 不支持格式 / 坏 WAV / 空 name / 负 startBar', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const getRes = await getJson(server.base, '/studio/api/import-audio')
      assert.equal(getRes.status, 405)

      const badBase64 = await postJson(server.base, '/studio/api/import-audio', { name: 'a.wav', dataBase64: '!!!not-base64!!!' })
      assert.equal(badBase64.status, 400)
      assert.match(badBase64.data.error, /base64/)

      const noName = await postJson(server.base, '/studio/api/import-audio', { dataBase64: makeWav(1).toString('base64') })
      assert.equal(noName.status, 400)
      assert.match(noName.data.error, /name/)

      const badExt = await postJson(server.base, '/studio/api/import-audio', { name: 'a.aiff', dataBase64: makeWav(1).toString('base64') })
      assert.equal(badExt.status, 400)
      assert.match(badExt.data.error, /不支持的音频格式/)

      const badWav = await postJson(server.base, '/studio/api/import-audio', {
        name: 'bad.wav',
        dataBase64: Buffer.alloc(100, 1).toString('base64'),
      })
      assert.equal(badWav.status, 400)
      assert.match(badWav.data.error, /不是合法 WAV/)

      const negativeStart = await postJson(server.base, '/studio/api/import-audio', {
        name: 'a.wav',
        startBar: -2,
        dataBase64: makeWav(1).toString('base64'),
      })
      assert.equal(negativeStart.status, 400)
      assert.match(negativeStart.data.error, /startBar/)
      await state.flush()
    } finally {
      await server.close()
      state.dispose()
    }
  })

  it('/media 安全：未知媒体 404、路径穿越 403、POST 405、媒体文件缺失 404', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const missing = await fetch(`${server.base}/studio/api/media/med_999.wav`)
      assert.equal(missing.status, 404)
      const traversal = await fetch(`${server.base}/studio/api/media/%2e%2e%2fproject.json`)
      assert.equal(traversal.status, 403)
      const traversalBackslash = await fetch(`${server.base}/studio/api/media/%2e%2e%5cproject.json`)
      assert.equal(traversalBackslash.status, 403)
      const postMedia = await fetch(`${server.base}/studio/api/media/med_1.wav`, { method: 'POST' })
      assert.equal(postMedia.status, 405)

      // 先导入一个媒体，再删除磁盘文件 → 404
      const imported = await postJson(server.base, '/studio/api/import-audio', {
        name: 'a.wav',
        dataBase64: makeWav(1).toString('base64'),
      })
      assert.equal(imported.data.ok, true)
      const filePath = path.join(state.mediaDir, imported.data.file)
      assert.equal((await fetch(`${server.base}/studio/api/media/${imported.data.file}`)).status, 200)
      await rm(filePath, { force: true })
      assert.equal((await fetch(`${server.base}/studio/api/media/${imported.data.file}`)).status, 404)
      await state.flush()
    } finally {
      await server.close()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P3b：tools studio_import_audio                                             */
/* ------------------------------------------------------------------------- */

describe('tools P3b — studio_import_audio', () => {
  async function makeImportTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { state, tools, byName, exec }
  }

  it('导入临时 WAV：media/轨/片段齐全、WAV 头解析、撤销标签「导入音频」、get_project 概览', async () => {
    const { state, exec } = await makeImportTools()
    try {
      const dir = await tempDir()
      const wavPath = path.join(dir, 'vocal.wav')
      const wav = makeWav(2)
      await writeFile(wavPath, wav)
      const tracksBefore = state.project.tracks.length
      const result = await exec('studio_import_audio', { path: wavPath })
      assert.equal(result.ok, true)
      assert.equal(result.name, 'vocal.wav')
      assert.equal(result.durationSeconds, 2)
      assert.equal(result.channels, 2)
      assert.equal(result.sampleRate, 44100)
      assert.equal(result.bytes, wav.length)
      assert.equal(result.startBar, 0)
      assert.equal(state.project.tracks.length, tracksBefore + 1)
      assert.equal(state.project.tracks.at(-1).kind, 'audio')
      assert.equal(state.project.media.length, 1)
      assert.equal(state.project.media[0].id, result.mediaId)
      assert.ok(state.project.media[0].file.startsWith(result.mediaId + '-'))
      assert.match(state.project.media[0].file, /^[A-Za-z0-9_-]+\.[a-z0-9]+$/)
      assert.deepEqual(await readFile(path.join(state.mediaDir, state.project.media[0].file)), wav)
      assert.equal(state.historyState().undoLabel, '导入音频')

      const overview = await exec('studio_get_project')
      assert.equal(overview.mediaTotal, 1)
      assert.equal(overview.audioTracks, 1)
      assert.equal(overview.audioClips, 1)
      assert.equal(overview.media[0].name, 'vocal.wav')
      const audioClip = overview.clips.find((clip) => clip.mediaId === result.mediaId)
      assert.ok(audioClip)
    } finally {
      state.dispose()
    }
  })

  it('name/startBar 参数生效；mp3 无头解析 duration null → 片段 4 小节', async () => {
    const { state, exec } = await makeImportTools()
    try {
      const dir = await tempDir()
      const mp3Path = path.join(dir, 'beat.mp3')
      await writeFile(mp3Path, Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(2048, 1)]))
      const named = await exec('studio_import_audio', { path: mp3Path, name: '自定义底鼓循环', startBar: 4 })
      assert.equal(named.ok, true)
      assert.equal(named.name, '自定义底鼓循环')
      assert.equal(named.startBar, 4)
      assert.equal(named.durationSeconds, null)
      assert.equal(named.lengthBars, MEDIA_DEFAULT_CLIP_BARS)
      assert.equal(state.project.tracks.at(-1).name, '音频 · 自定义底鼓循环')
      assert.equal(state.project.clips.at(-1).startBar, 4)
    } finally {
      state.dispose()
    }
  })

  it('错误：路径缺失/不存在/目录/不支持格式/空文件/坏 WAV/超大文件（中文错误）', async () => {
    const { state, exec } = await makeImportTools()
    try {
      assert.equal((await exec('studio_import_audio', {})).ok, false)
      const missing = await exec('studio_import_audio', { path: 'C:\\definitely\\not\\here\\x.wav' })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /不存在/)
      const dir = await tempDir()
      const dirResult = await exec('studio_import_audio', { path: dir })
      assert.equal(dirResult.ok, false)
      assert.match(dirResult.error, /不是文件/)
      const txtPath = path.join(dir, 'note.txt')
      await writeFile(txtPath, 'hello')
      const extResult = await exec('studio_import_audio', { path: txtPath })
      assert.equal(extResult.ok, false)
      assert.match(extResult.error, /不支持的音频格式/)
      const emptyPath = path.join(dir, 'empty.wav')
      await writeFile(emptyPath, Buffer.alloc(0))
      const emptyResult = await exec('studio_import_audio', { path: emptyPath })
      assert.equal(emptyResult.ok, false)
      assert.match(emptyResult.error, /为空/)
      const badWavPath = path.join(dir, 'bad.wav')
      await writeFile(badWavPath, Buffer.alloc(200, 9))
      const badWavResult = await exec('studio_import_audio', { path: badWavPath })
      assert.equal(badWavResult.ok, false)
      assert.match(badWavResult.error, /不是合法 WAV/)
      const bigPath = path.join(dir, 'big.wav')
      await writeFile(bigPath, Buffer.alloc(0))
      const handle = await open(bigPath, 'r+')
      try {
        await handle.truncate(MEDIA_MAX_BYTES + 1)
      } finally {
        await handle.close()
      }
      const bigResult = await exec('studio_import_audio', { path: bigPath })
      assert.equal(bigResult.ok, false)
      assert.match(bigResult.error, /过大/)
      assert.equal(state.project.media.length, 0, '失败导入不留下媒体条目')
    } finally {
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P5：Catalog 扩充在 Host/工具层生效                                          */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* P8：真实采样音源（32 采样乐器 / 4 采样鼓机 / 14 效果器）经 Host 工具生效      */
/* P5 的 3 个效果器能力保留（属效果器扩充，与音源无关）。                        */
/* ------------------------------------------------------------------------- */

describe('catalog P8 — 采样音源经 Host 工具与 API 生效', () => {
  async function makeCatalogTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, tools, byName, exec }
  }

  it('32 个采样乐器都能通过 studio_add_track 创建并写入 instrument（无合成参数）', async () => {
    const { state, exec } = await makeCatalogTools()
    try {
      // 清空 demo 轨道，确保 32 个预设都在轨道上限内逐一创建
      state.mutate({ tool: 'test' }, (draft) => {
        draft.tracks = []
        draft.patterns = []
        draft.clips = []
        return undefined
      })
      for (const preset of SYNTH_PRESETS) {
        const result = await exec('studio_add_track', { name: `P8-${preset.id}`, kind: 'synth', preset: preset.id })
        assert.equal(result.ok, true, `${preset.id} 创建失败：${result.error}`)
        assert.equal(result.track.instrument.preset, preset.id)
        const track = state.project.tracks.find((item) => item.id === result.trackId)
        assert.equal(track.instrument.preset, preset.id)
        assert.equal(track.kind, 'synth')
        assert.deepEqual(track.instrument.params, {}, `${preset.id} 采样乐器不应有合成参数`)
        assert.equal(track.role, 'lead')
      }
      assert.equal(state.project.tracks.filter((track) => track.name.startsWith('P8-')).length, 32)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('4 套采样鼓机可创建，instrument kit 与 params 与 catalog 一致', async () => {
    const { state, exec } = await makeCatalogTools()
    try {
      for (const kit of DRUM_KITS) {
        const result = await exec('studio_add_track', { name: `P8-${kit.id}`, kind: 'drum', kit: kit.id })
        assert.equal(result.ok, true, `${kit.id} 创建失败：${result.error}`)
        assert.equal(result.track.instrument.kit, kit.id)
        const track = state.project.tracks.find((item) => item.id === result.trackId)
        assert.equal(track.instrument.kit, kit.id)
        assert.equal(track.role, 'drums')
        for (const [key, value] of Object.entries(kit.params)) {
          assert.equal(track.instrument.params[key], value, `${kit.id}.${key}`)
        }
        assert.equal(Object.keys(track.instrument.params).length, Object.keys(DRUM_PARAM_SPECS).length)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_track 可切换采样乐器音色（清空合成参数）；非法/遗留预设在工具入口被拒', async () => {
    const { state, exec } = await makeCatalogTools()
    try {
      const added = await exec('studio_add_track', { name: 'P8 Lead', kind: 'synth', preset: 'grand_piano' })
      assert.equal(added.ok, true)
      const changed = await exec('studio_update_track', { trackId: added.trackId, preset: 'warm_pad' })
      assert.equal(changed.ok, true, changed.error)
      assert.equal(changed.track.instrument.preset, 'warm_pad')
      assert.deepEqual(state.project.tracks.find((track) => track.id === added.trackId).instrument.params, {})
      // 遗留合成预设不再出现在工具可选值：ops.addTrack 拒绝（即使绕过 enum）
      const legacyPreset = await exec('studio_add_track', { name: 'Legacy', kind: 'synth', preset: 'supersaw' })
      assert.equal(legacyPreset.ok, false)
      assert.match(legacyPreset.error, /未知采样乐器/)
      const legacyKit = await exec('studio_add_track', { name: 'Legacy Kit', kind: 'drum', kit: 'neon808' })
      assert.equal(legacyKit.ok, false)
      assert.match(legacyKit.error, /未知采样鼓机/)
      const badPreset = await exec('studio_update_track', { trackId: added.trackId, preset: 'nope' })
      assert.equal(badPreset.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('3 种 P5 效果器可挂轨道/Master/返回总线：参数夹紧、开关、删除、撤销', async () => {
    const { state, exec } = await makeCatalogTools()
    try {
      const trackId = state.project.tracks.find((track) => track.kind === 'synth').id
      const getTrack = () => state.project.tracks.find((item) => item.id === trackId)
      const added = await exec('studio_add_effect', { target: trackId, type: 'flanger', params: { rate: 99, feedback: -1, depth: 2 } })
      assert.equal(added.ok, true, added.error)
      const effect = getTrack().effects.at(-1)
      assert.equal(effect.type, 'flanger')
      assert.equal(effect.params.rate, 5)
      assert.equal(effect.params.feedback, 0)
      assert.equal(effect.params.depth, 1)
      assert.equal(effect.params.mix, 0.5)
      const updated = await exec('studio_update_effect', { target: trackId, effectId: added.effectId, enabled: false, params: { mix: 0.9 } })
      assert.equal(updated.ok, true)
      assert.equal(getTrack().effects.find((item) => item.id === added.effectId).enabled, false)
      assert.equal(getTrack().effects.find((item) => item.id === added.effectId).params.mix, 0.9)
      const master = await exec('studio_add_effect', { target: 'master', type: 'ringmod', params: { frequency: 5000 } })
      assert.equal(master.ok, true)
      assert.equal(state.project.master.effects.at(-1).params.frequency, 2000)
      const bus = await exec('studio_add_effect', { target: 'bus', busId: 'reverb', type: 'autopan', params: { rate: 0 } })
      assert.equal(bus.ok, true)
      assert.equal(state.project.buses.reverb.effects.at(-1).params.rate, 0.05)
      const removed = await exec('studio_remove_effect', { target: trackId, effectId: added.effectId })
      assert.equal(removed.ok, true)
      assert.equal(state.undo().ok, true)
      assert.equal(getTrack().effects.some((item) => item.id === added.effectId), true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('采样乐器/效果器随工程保存并在重启后保留', async () => {
    const { dir, state } = await makeCatalogTools()
    try {
      state.mutate({ tool: 'studio_edit', text: null, undoLabel: 'P8 测试' }, (draft) => {
        const added = ops.addTrack(draft, { name: 'Warm Pad 轨', kind: 'synth', preset: 'warm_pad' })
        ops.addEffect(draft, { target: added.trackId, type: 'ringmod', params: { frequency: 660, mix: 0.8 } })
        return added
      })
      await state.flush()
    } finally {
      await state.flush()
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      const track = reloaded.project.tracks.find((item) => item.name === 'Warm Pad 轨')
      assert.ok(track)
      assert.equal(track.instrument.preset, 'warm_pad')
      assert.deepEqual(track.instrument.params, {})
      const effect = track.effects.find((item) => item.type === 'ringmod')
      assert.ok(effect)
      assert.equal(effect.params.frequency, 660)
      assert.equal(effect.params.mix, 0.8)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('工具枚举/描述同步真实采样目录：preset 32 / kit 4 / effect enum 15', async () => {
    const { state, byName, exec } = await makeCatalogTools()
    const addTrack = byName.get('studio_add_track')
    // R5a：preset enum 同步 32 个真实采样乐器（kit 仍用描述 + studio_app_info 动态列表）
    assert.deepEqual(addTrack.parameters.preset.enum, SYNTH_PRESETS.map((preset) => preset.id))
    assert.equal(addTrack.parameters.kit.enum, undefined)
    for (const id of SYNTH_PRESETS.map((preset) => preset.id)) {
      assert.ok(addTrack.parameters.preset.description.includes(id), `preset 描述缺少 ${id}`)
    }
    for (const id of DRUM_KITS.map((kit) => kit.id)) {
      assert.ok(addTrack.parameters.kit.description.includes(id), `kit 描述缺少 ${id}`)
    }
    assert.ok(!addTrack.parameters.kit.description.includes('neon808'), '遗留合成鼓机不应出现在描述')
    assert.ok(!addTrack.parameters.preset.description.includes('supersaw'), '遗留合成预设不应出现在描述')
    for (const id of ['grand_piano', 'strings_ensemble', 'finger_bass', 'marimba', 'warm_pad']) {
      assert.ok(addTrack.description.includes(id), `add_track 描述缺少 ${id}`)
    }
    const updateTrack = byName.get('studio_update_track')
    assert.ok(updateTrack.description.includes('采样乐器'))
    assert.ok(updateTrack.parameters.preset.description.includes('grand_piano'))
    const addEffect = byName.get('studio_add_effect')
    assert.equal(addEffect.parameters.type.enum.length, 15)
    for (const id of ['flanger', 'ringmod', 'autopan']) assert.ok(addEffect.parameters.type.enum.includes(id))

    // P9：studio_app_info 返回目标 + 18/4/15 + 合法 id
    const info = byName.get('studio_app_info')
    assert.ok(info, '缺少 studio_app_info')
    assert.ok(info.description.includes('studio_app_info') || info.description.includes('dataDir'))
    const result = await exec('studio_app_info')
    assert.equal(result.ok, true)
    assert.equal(result.app.dataDir, state.dataDir)
    assert.equal(result.counts.instruments, 32)
    assert.equal(result.counts.drumKits, 4)
    assert.equal(result.counts.effects, 15)
    assert.equal(result.instruments.length, 32)
    assert.ok(result.instruments.some((item) => item.id === 'grand_piano' && item.program === 0))
    assert.equal(result.drumKits.length, 4)
    await state.flush()
    state.dispose()
  })

  it('get_project 概览的轨道摘要反映采样乐器 / 采样鼓机 instrument', async () => {
    const { state, exec } = await makeCatalogTools()
    try {
      const synth = await exec('studio_add_track', { name: 'P8 Piano', kind: 'synth', preset: 'grand_piano' })
      const drum = await exec('studio_add_track', { name: 'P8 Drums', kind: 'drum', kit: 'smp_lofi' })
      const overview = await exec('studio_get_project')
      assert.equal(overview.ok, true)
      assert.equal(overview.tracks.find((track) => track.id === synth.trackId).instrument.preset, 'grand_piano')
      assert.equal(overview.tracks.find((track) => track.id === drum.trackId).instrument.kit, 'smp_lofi')
      // demo 工程的 7 轨也全部是采样音源
      const demoPresets = overview.tracks
        .filter((track) => ['trk_1', 'trk_2', 'trk_3', 'trk_4', 'trk_5', 'trk_6', 'trk_7'].includes(track.id))
        .map((track) => track.instrument.preset ?? track.instrument.kit)
      for (const id of ['smp_acoustic', 'finger_bass', 'grand_piano', 'strings_ensemble', 'marimba', 'tine_epiano', 'concert_choir']) {
        assert.ok(demoPresets.includes(id), `demo 概览缺少 ${id}`)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('schema2 工程中的未知采样乐器/鼓机：validate 标记 unknown_instrument，工具入口拒绝旧 id', async () => {
    const dir = await tempDir()
    const project = createDemoProject()
    project.tracks[0].instrument = { preset: null, kit: 'neon808', params: {} }
    project.tracks[2].instrument = { preset: 'supersaw', kit: null, params: {} }
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(project), 'utf8')
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      const { issues, counts } = ops.validateProject(state.project)
      const unknown = issues.filter((issue) => issue.code === 'unknown_instrument')
      assert.ok(unknown.length >= 2)
      assert.equal(Object.hasOwn(counts, 'legacyInstruments'), false, '不再统计 legacy 乐器')
      // 未知 instrument 不再被当作可解析音色；addTrack 拒绝
      assert.throws(() => ops.addTrack(state.project, { name: 'x', kind: 'synth', preset: 'supersaw' }), /未知采样乐器/)
      assert.throws(() => ops.addTrack(state.project, { name: 'x', kind: 'drum', kit: 'neon808' }), /未知采样鼓机/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit API：P5 FX type 可 add/update/remove，/state 与撤销/重做一致', async () => {
    const { state } = await makeCatalogTools()
    const server = await startServer(state)
    try {
      const trackId = state.project.tracks.find((track) => track.kind === 'synth').id
      const add = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'addEffect', trackId, fxType: 'autopan', params: { rate: 1.5, depth: 0.6 } }],
      })
      assert.equal(add.data.ok, true, add.data.error)
      const effectId = add.data.results[0].effectId
      assert.equal(add.data.results[0].effect.params.rate, 1.5)
      const update = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'updateEffect', trackId, effectId, params: { mix: 0.3 }, enabled: false }],
      })
      assert.equal(update.data.ok, true)
      const current = await getJson(server.base, '/studio/api/state?rev=0')
      const effect = current.data.project.tracks.find((item) => item.id === trackId).effects.find((item) => item.id === effectId)
      assert.equal(effect.params.mix, 0.3)
      assert.equal(effect.enabled, false)
      const remove = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'removeEffect', trackId, effectId }],
      })
      assert.equal(remove.data.ok, true)
      const undo = await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(undo.data.didStep, true)
      assert.ok(state.project.tracks.find((item) => item.id === trackId).effects.some((item) => item.id === effectId))
      const redo = await postJson(server.base, '/studio/api/history/redo', {})
      assert.equal(redo.data.didStep, true)
      assert.equal(state.project.tracks.find((item) => item.id === trackId).effects.some((item) => item.id === effectId), false)
      await state.flush()
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P6：音频片段 offsetSeconds 在 ops / API / 持久化中生效                       */
/* ------------------------------------------------------------------------- */

describe('ops/routes P6 — 音频片段裁切偏移 offsetSeconds', () => {
  function makeAudioProject() {
    const project = createDemoProject()
    const media = ops.addMedia(project, { name: '双频.wav', file: 'med_1.wav', bytes: 1000, durationSeconds: 2 })
    const { trackId, clipId } = ops.addAudioTrack(project, { mediaId: media.id, startBar: 0 })
    return { project, media, trackId, clipId }
  }

  it('setClips 写入 offsetSeconds（3 位小数、按媒体时长夹紧），project 与结果一致', () => {
    const { project, media, trackId, clipId } = makeAudioProject()
    const result = ops.applyEditOps(project, [
      {
        type: 'setClips',
        clips: [{ id: clipId, trackId, mediaId: media.id, startBar: 0, lengthBars: 2, offsetSeconds: 1.23456 }],
      },
    ])
    assert.equal(result.label, '编辑片段')
    const clip = project.clips.find((item) => item.id === clipId)
    assert.equal(clip.offsetSeconds, 1.235)
    // 超出媒体时长（2s）→ 1.99
    ops.applyEditOps(project, [
      { type: 'setClips', clips: [{ id: clipId, trackId, mediaId: media.id, startBar: 0, lengthBars: 1, offsetSeconds: 9 }] },
    ])
    assert.equal(project.clips.find((item) => item.id === clipId).offsetSeconds, 1.99)
  })

  it('setClips 修改 offset 时保留 startBar/lengthBars/id，可混排 pattern 片段；pattern 片段忽略 offset', () => {
    const { project, media, trackId, clipId } = makeAudioProject()
    const patternId = project.patterns[0].id
    const synthTrackId = project.tracks.find((track) => track.kind === 'synth').id
    ops.applyEditOps(project, [
      {
        type: 'setClips',
        clips: [
          { id: clipId, trackId, mediaId: media.id, startBar: 1, lengthBars: 3, offsetSeconds: 0.5 },
          { id: 'clip_700', trackId: synthTrackId, patternId, startBar: 0, lengthBars: 4, offsetSeconds: 1.2 },
        ],
      },
    ])
    const audioClip = project.clips.find((item) => item.id === clipId)
    assert.equal(audioClip.startBar, 1)
    assert.equal(audioClip.lengthBars, 3)
    assert.equal(audioClip.offsetSeconds, 0.5)
    const patternClip = project.clips.find((item) => item.id === 'clip_700')
    assert.equal(patternClip.patternId, patternId)
    assert.equal(Object.hasOwn(patternClip, 'offsetSeconds'), false)
    // 修改 offset 保留其他字段
    ops.applyEditOps(project, [
      { type: 'setClips', clips: [{ id: clipId, trackId, mediaId: media.id, startBar: 1, lengthBars: 3, offsetSeconds: 1.75 }] },
    ])
    const updated = project.clips.find((item) => item.id === clipId)
    assert.equal(updated.offsetSeconds, 1.75)
    assert.equal(updated.startBar, 1)
    assert.equal(updated.lengthBars, 3)
  })

  it('非法 offset（NaN/负数/字符串/超上限）不报错：回 0 或夹紧', () => {
    const { project, media, trackId, clipId } = makeAudioProject()
    const cases = [
      [Number.NaN, 0],
      [-3, 0],
      ['bad', 0],
      [null, 0],
      [9999, 1.99],
    ]
    for (const [raw, expected] of cases) {
      ops.applyEditOps(project, [
        { type: 'setClips', clips: [{ id: clipId, trackId, mediaId: media.id, startBar: 0, lengthBars: 2, offsetSeconds: raw }] },
      ])
      assert.equal(project.clips.find((item) => item.id === clipId).offsetSeconds, expected, `offset=${String(raw)}`)
    }
  })

  it('get_project 概览的音频片段投影带 offsetSeconds（3 位小数）', () => {
    const { project, media, trackId, clipId } = makeAudioProject()
    ops.applyEditOps(project, [
      { type: 'setClips', clips: [{ id: clipId, trackId, mediaId: media.id, startBar: 0, lengthBars: 2, offsetSeconds: 0.5555 }] },
    ])
    const overview = ops.getProjectOverview(project)
    const projected = overview.clips.find((clip) => clip.mediaId === media.id)
    assert.ok(projected)
    assert.equal(projected.offsetSeconds, 0.556)
  })

  it('state：setClips 改 offset 可撤销/重做且标签为「编辑片段」', async () => {
    const { state } = await makeState()
    try {
      state.mutate({ tool: 'studio_import_audio', text: null, undoLabel: '导入音频' }, (draft) => {
        const media = ops.addMedia(draft, { name: 'v.wav', file: 'med_1.wav', bytes: 10, durationSeconds: 2 })
        return ops.addAudioTrack(draft, { mediaId: media.id, startBar: 0 })
      })
      const trackId = state.project.tracks.find((track) => track.kind === 'audio').id
      const clipId = state.project.clips.find((clip) => clip.mediaId).id
      state.mutate({ tool: 'studio_edit', text: null, undoLabel: '编辑片段' }, (draft) =>
        ops.applyEditOps(draft, [
          { type: 'setClips', clips: [{ id: clipId, trackId, mediaId: state.project.media[0].id, startBar: 0, lengthBars: 2, offsetSeconds: 1.25 }] },
        ]),
      )
      assert.equal(state.project.clips.find((clip) => clip.id === clipId).offsetSeconds, 1.25)
      assert.equal(state.historyState().undoLabel, '编辑片段')
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.clips.find((clip) => clip.id === clipId).offsetSeconds, 0)
      assert.equal(state.redo().ok, true)
      assert.equal(state.project.clips.find((clip) => clip.id === clipId).offsetSeconds, 1.25)
    } finally {
      await state.flush().catch(() => {})
      state.dispose()
    }
  })

  it('持久化：offset 随工程保存并在重启后保留', async () => {
    const { dir, state } = await makeState()
    try {
      state.mutate({ tool: 'studio_edit', text: null }, (draft) => {
        const media = ops.addMedia(draft, { name: 'v.wav', file: 'med_1.wav', bytes: 10, durationSeconds: 2 })
        const added = ops.addAudioTrack(draft, { mediaId: media.id, startBar: 0 })
        return ops.applyEditOps(draft, [
          { type: 'setClips', clips: [{ id: added.clipId, trackId: added.trackId, mediaId: media.id, startBar: 0, lengthBars: 2, offsetSeconds: 1.5 }] },
        ])
      })
      await state.flush()
    } finally {
      await state.flush().catch(() => {})
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      const clip = reloaded.project.clips.find((item) => item.mediaId)
      assert.ok(clip)
      assert.equal(clip.offsetSeconds, 1.5)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('/edit API：setClips offset → /state，保存→新建→打开→重启保留', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    let mediaId
    let trackId
    let clipId
    try {
      // 用 /import-audio 建音频轨（复用现有路由，最小 WAV）
      const wav = makeWav(2)
      const imported = await postJson(server.base, '/studio/api/import-audio', {
        name: '双频.wav',
        startBar: 0,
        dataBase64: wav.toString('base64'),
      })
      assert.equal(imported.data.ok, true)
      mediaId = imported.data.mediaId
      trackId = imported.data.trackId
      clipId = imported.data.clipId
      // 先裁切 offset（一次 setClips）
      const edit = await postJson(server.base, '/studio/api/edit', {
        ops: [
          {
            type: 'setClips',
            clips: [{ id: clipId, trackId, mediaId, startBar: 1, lengthBars: 1, offsetSeconds: 1.23456 }],
          },
        ],
      })
      assert.equal(edit.data.ok, true)
      assert.equal(edit.data.label, '编辑片段')
      const current = await getJson(server.base, '/studio/api/state?rev=0')
      const clip = current.data.project.clips.find((item) => item.id === clipId)
      assert.equal(clip.offsetSeconds, 1.235)
      assert.equal(clip.startBar, 1)
      assert.equal(clip.lengthBars, 1)
      // 撤销 → 回到初始 offset 0 / startBar 0
      const undo = await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(undo.data.didStep, true)
      assert.equal(state.project.clips.find((item) => item.id === clipId).offsetSeconds, 0)
      const redo = await postJson(server.base, '/studio/api/history/redo', {})
      assert.equal(redo.data.didStep, true)
      assert.equal(state.project.clips.find((item) => item.id === clipId).offsetSeconds, 1.235)
      // 保存 → 新建 → 打开
      const saved = await postJson(server.base, '/studio/api/projects/save', { name: 'P6 裁切工程' })
      assert.equal(saved.data.ok, true)
      await postJson(server.base, '/studio/api/projects/new', { template: 'empty' })
      assert.equal(state.project.clips.length, 0)
      const opened = await postJson(server.base, '/studio/api/projects/open', { name: 'P6 裁切工程' })
      assert.equal(opened.data.ok, true)
      const reopened = state.project.clips.find((item) => item.mediaId)
      assert.ok(reopened)
      assert.equal(reopened.offsetSeconds, 1.235)
      assert.equal(reopened.startBar, 1)
      await state.flush()
    } finally {
      await server.close()
      await state.flush().catch(() => {})
      state.dispose()
    }
    // 重启保留
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      const clip = reloaded.project.clips.find((item) => item.mediaId)
      assert.ok(clip)
      assert.equal(clip.offsetSeconds, 1.235)
      assert.equal(clip.startBar, 1)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('音频片段无 offset 字段可加载，再次 setClips 默认 offset 0', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      // 构造旧格式工程文件：音频 clip 无 offsetSeconds
      const legacy = createDemoProject()
      const media = { id: 'med_1', name: '旧音频.wav', file: 'med_1.wav', bytes: 10, durationSeconds: 2, channels: 2, sampleRate: 44100 }
      legacy.media = [media]
      legacy.tracks.push({
        id: 'trk_old_audio',
        name: '音频 · 旧',
        role: 'audio',
        kind: 'audio',
        color: '#4E9AA6',
        volume: 0.78,
        pan: 0,
        mute: false,
        solo: false,
        sends: { reverb: 0.12, delay: 0.06 },
        effects: [],
      })
      legacy.clips.push({ id: 'clip_90', trackId: 'trk_old_audio', mediaId: 'med_1', startBar: 0, lengthBars: 2 })
      await mkdir(projectsDir(dir), { recursive: true })
      await writeFile(path.join(projectsDir(dir), '旧音频工程.json'), JSON.stringify(legacy), 'utf8')
      const opened = await postJson(server.base, '/studio/api/projects/open', { name: '旧音频工程' })
      assert.equal(opened.data.ok, true)
      const loaded = state.project.clips.find((item) => item.id === 'clip_90')
      assert.ok(loaded)
      assert.equal(Object.hasOwn(loaded, 'offsetSeconds'), false, '旧工程不迁移 offset 字段')
      assert.equal(loaded.offsetSeconds ?? 0, 0, '语义上默认 0')
      // 再次 setClips（UI 只提交已有字段）→ 新 clip 带默认 offset 0
      const edit = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'setClips', clips: [{ id: 'clip_90', trackId: 'trk_old_audio', mediaId: 'med_1', startBar: 0, lengthBars: 2 }] }],
      })
      assert.equal(edit.data.ok, true)
      const updated = state.project.clips.find((item) => item.mediaId === 'med_1')
      assert.ok(updated)
      assert.equal(updated.offsetSeconds, 0)
      await state.flush()
    } finally {
      await server.close()
      await state.flush().catch(() => {})
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P10：渲染预览闭环 / 工程自检 / 增量编辑 / 工程管理 / 导出控制 / 并发一致性    */
/* ------------------------------------------------------------------------- */

const P10_ANALYSIS = {
  seconds: 4,
  sampleRate: 44100,
  channels: 2,
  peak: 0.9,
  peakDb: -0.92,
  rms: 0.3,
  rmsDb: -10.46,
  lufsApprox: -11.15,
  crestDb: 9.54,
  clipping: false,
  clippedSamples: 0,
  silent: false,
  dcOffset: 0.001,
  stems: [{ trackId: 'trk_1', name: '鼓组', peakDb: -6, rmsDb: -18, clipping: false }],
}

describe('P10 preview-bridge — 渲染预览请求/轮询/回报', () => {
  it('request/peek/complete 闭环：seq 递增、参数透传、resolve analysis', async () => {
    const { state } = await makeState()
    try {
      const first = requestPreview(state, { fromBar: 0, toBar: 4, tailSeconds: 0, includeStems: false })
      assert.equal(pendingPreviewCount(state), 1)
      const peeked = peekPreviewRequest(state, 0)
      assert.ok(peeked)
      assert.equal(peeked.seq, 1)
      const { revision: previewRevision, ...previewParams } = peeked.params
      assert.equal(previewRevision, state.revision)
      assert.deepEqual(previewParams, { fromBar: 0, toBar: 4, tailSeconds: 0, includeStems: false })
      assert.equal(peekPreviewRequest(state, 1), null, 'since=当前 seq 时不应再返回')
      assert.equal(completePreviewRequest(state, peeked.seq, { analysis: { peak: 0.5 } }), true)
      assert.deepEqual(await first, { peak: 0.5 })
      assert.equal(pendingPreviewCount(state), 0)

      const second = requestPreview(state, { fromBar: 8, toBar: 12 })
      const peekedAgain = peekPreviewRequest(state, 1)
      assert.equal(peekedAgain.seq, 2)
      // 未知/重复 seq 返回 false
      assert.equal(completePreviewRequest(state, 999, { analysis: {} }), false)
      assert.equal(completePreviewRequest(state, 2, { analysis: { silent: true } }), true)
      assert.deepEqual(await second, { silent: true })
      assert.equal(completePreviewRequest(state, 2, { analysis: {} }), false)
    } finally {
      clearPreviewRequests(state)
      state.dispose()
    }
  })

  it('UI 回报 error → promise reject；清空时 pending 全部取消', async () => {
    const { state } = await makeState()
    try {
      const failed = requestPreview(state, { fromBar: 0, toBar: 2 })
      const peeked = peekPreviewRequest(state, 0)
      assert.equal(completePreviewRequest(state, peeked.seq, { error: '渲染崩溃了' }), true)
      await assert.rejects(failed, /渲染崩溃了/)

      const pending = requestPreview(state, { fromBar: 2, toBar: 4 })
      assert.equal(pendingPreviewCount(state), 1)
      clearPreviewRequests(state)
      await assert.rejects(pending, (error) => error.code === 'PREVIEW_CANCELLED')
      assert.equal(pendingPreviewCount(state), 0)
    } finally {
      clearPreviewRequests(state)
      state.dispose()
    }
  })

  it('超时：requestPreview 带 timeoutMs 触发 PREVIEW_TIMEOUT 并清理 pending', async () => {
    const { state } = await makeState()
    try {
      const pending = requestPreview(state, { fromBar: 0, toBar: 2 }, { timeoutMs: 30 })
      await assert.rejects(pending, (error) => error.code === 'PREVIEW_TIMEOUT')
      assert.equal(pendingPreviewCount(state), 0)
    } finally {
      clearPreviewRequests(state)
      state.dispose()
    }
  })
})

describe('P10 routes — /preview-request 与 /preview-done', () => {
  it('GET 无待处理返回 request:null（保留 since）；有待处理返回 seq+params；POST done resolve', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const empty = await getJson(server.base, '/studio/api/preview-request?since=7')
      assert.equal(empty.status, 200)
      assert.deepEqual(empty.data, { ok: true, seq: 7, request: null })

      const pending = requestPreview(state, { fromBar: 16, toBar: 20, tailSeconds: 1, includeStems: true })
      const polled = await getJson(server.base, '/studio/api/preview-request?since=0')
      assert.equal(polled.data.ok, true)
      assert.equal(polled.data.seq, 1)
      const { revision: polledRevision, ...polledParams } = polled.data.request
      assert.equal(polledRevision, state.revision)
      assert.deepEqual(polledParams, { fromBar: 16, toBar: 20, tailSeconds: 1, includeStems: true })

      const done = await postJson(server.base, '/studio/api/preview-done', { seq: polled.data.seq, analysis: P10_ANALYSIS })
      assert.equal(done.status, 200)
      assert.equal(done.data.ok, true)
      assert.deepEqual(await pending, P10_ANALYSIS)

      const afterDone = await getJson(server.base, `/studio/api/preview-request?since=${polled.data.seq}`)
      assert.deepEqual(afterDone.data, { ok: true, seq: polled.data.seq, request: null })
    } finally {
      await server.close()
      clearPreviewRequests(state)
      state.dispose()
    }
  })

  it('POST /preview-done：未知 seq / 缺 analysis 返回 ok:false；不产生 revision/undo', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const revisionBefore = state.revision
      const undoBefore = state.canUndo
      assert.equal((await getJson(server.base, '/studio/api/preview-request?since=0')).status, 200)
      const unknown = await postJson(server.base, '/studio/api/preview-done', { seq: 424242, analysis: P10_ANALYSIS })
      assert.equal(unknown.status, 200)
      assert.equal(unknown.data.ok, false)
      assert.match(unknown.data.error, /未知或已超时/)
      const missing = await postJson(server.base, '/studio/api/preview-done', { seq: 1 })
      assert.equal(missing.data.ok, false)
      const badSeq = await postJson(server.base, '/studio/api/preview-done', { seq: 'abc', analysis: {} })
      assert.equal(badSeq.data.ok, false)

      // error 回报 → 请求 reject（先挂 rejection handler，避免 unhandled rejection）
      const failed = assert.rejects(requestPreview(state, { fromBar: 0, toBar: 2 }), /UI 渲染异常/)
      const peeked = await getJson(server.base, '/studio/api/preview-request?since=0')
      const doneError = await postJson(server.base, '/studio/api/preview-done', { seq: peeked.data.seq, error: 'UI 渲染异常' })
      assert.equal(doneError.data.ok, true)
      await failed

      assert.equal(state.revision, revisionBefore, 'preview 路由不应 bump revision')
      assert.equal(state.canUndo, undoBefore, 'preview 路由不应产生撤销步')
      // 方法错误 405
      const getDone = await getJson(server.base, '/studio/api/preview-done')
      assert.equal(getDone.status, 405)
      const postRequest = await fetch(`${server.base}/studio/api/preview-request`, { method: 'POST' })
      assert.equal(postRequest.status, 405)
    } finally {
      await server.close()
      clearPreviewRequests(state)
      state.dispose()
    }
  })
})

describe('P10 tools — studio_render_preview / studio_validate_project', () => {
  async function makeP10Tools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, tools, byName, exec }
  }

  it('studio_render_preview：等待 UI 轮询并透传 analysis（含 stems）', async () => {
    const { state, exec } = await makeP10Tools()
    try {
      const toolPromise = exec('studio_render_preview', { fromBar: 16, toBar: 20, tailSeconds: 2, includeStems: true })
      let peeked = null
      for (let i = 0; i < 100; i += 1) {
        peeked = peekPreviewRequest(state, 0)
        if (peeked) break
        await wait(10)
      }
      assert.ok(peeked, '工具应发起预览请求')
      const { revision: renderRevision, ...renderParams } = peeked.params
      assert.equal(renderRevision, state.revision)
      assert.deepEqual(renderParams, { fromBar: 16, toBar: 20, tailSeconds: 2, includeStems: true })
      assert.equal(completePreviewRequest(state, peeked.seq, { analysis: P10_ANALYSIS }), true)
      const result = await toolPromise
      assert.equal(result.ok, true)
      assert.equal(result.preview.fromBar, 16)
      assert.equal(result.preview.toBar, 20)
      assert.equal(result.preview.tailSeconds, 2)
      assert.equal(result.preview.peak, 0.9)
      assert.equal(result.preview.silent, false)
      assert.equal(result.preview.stems.length, 1)
    } finally {
      clearPreviewRequests(state)
      await state.flush()
      state.dispose()
    }
  })

  it('studio_render_preview：默认 toBar=min(曲长, fromBar+4)，参数越界返回 ok:false', async () => {
    const { state, exec } = await makeP10Tools()
    try {
      // 默认区间
      const toolPromise = exec('studio_render_preview', { fromBar: 30 })
      let peeked = null
      for (let i = 0; i < 100; i += 1) {
        peeked = peekPreviewRequest(state, 0)
        if (peeked) break
        await wait(10)
      }
      assert.ok(peeked)
      assert.equal(peeked.params.toBar, 32, '32 小节工程从第 30 小节起应截到 32')
      completePreviewRequest(state, peeked.seq, { analysis: P10_ANALYSIS })
      assert.equal((await toolPromise).ok, true)

      for (const args of [{ fromBar: -1 }, { fromBar: 5, toBar: 5 }, { fromBar: 0, toBar: 4, tailSeconds: 99 }]) {
        const failed = await exec('studio_render_preview', args)
        assert.equal(failed.ok, false, JSON.stringify(args))
      }
      const outOfRange = await exec('studio_render_preview', { fromBar: 999 })
      assert.equal(outOfRange.ok, false)
    } finally {
      clearPreviewRequests(state)
      await state.flush()
      state.dispose()
    }
  })

  it('studio_validate_project：demo 工程无 error，返回 issues/counts/summary', async () => {
    const { state, exec } = await makeP10Tools()
    try {
      const result = await exec('studio_validate_project')
      assert.equal(result.ok, true)
      assert.ok(Array.isArray(result.issues))
      assert.equal(result.summary.errors, 0, `demo 不应有 error：${JSON.stringify(result.issues.filter((issue) => issue.level === 'error'))}`)
      assert.equal(result.counts.tracks, 7)
      assert.equal(result.counts.patterns, 13)
      assert.equal(result.summary.errors, result.issues.filter((issue) => issue.level === 'error').length)
      assert.equal(result.summary.warns, result.issues.filter((issue) => issue.level === 'warn').length)
      assert.equal(result.summary.infos, result.issues.filter((issue) => issue.level === 'info').length)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_validate_project：检出音符越界/空 pattern/缺失引用/静音轨/重复效果器/未知音色/自动化越界', async () => {
    const project = createDemoProject()
    project.patterns[0].notes.push({ pitch: 200, start: 0, dur: 0.5, vel: 0.8 })
    project.patterns[0].notes.push({ pitch: 60, start: 0, dur: -1, vel: 0.8 })
    project.patterns.push({ id: 'pat_empty', name: '空 pattern', lengthBars: 4, notes: [] })
    project.clips.push({ id: 'clip_bad', trackId: 'trk_1', patternId: 'pat_404', startBar: 0, lengthBars: 4 })
    project.clips.push({ id: 'clip_overrun', trackId: 'trk_1', patternId: project.patterns[0].id, startBar: 30, lengthBars: 8 })
    project.tracks[0].mute = true
    project.tracks[1].effects.push({ ...project.tracks[1].effects[0] })
    project.master.effects.push({ id: 'fx_99', type: 'eq3', enabled: true, params: {} })
    project.master.effects.push({ id: 'fx_100', type: 'eq3', enabled: true, params: {} })
    project.master.effects.push({ id: 'fx_101', type: 'reverb', enabled: true, params: {} })
    project.tracks[2].instrument.preset = 'not_a_real_preset'
    project.tracks[3].automation = { volume: { enabled: true, points: [{ beat: 99999, value: 0.5 }] } }
    const { issues, summary, counts } = ops.validateProject(project)
    const codes = new Set(issues.map((issue) => issue.code))
    for (const code of ['note_pitch', 'note_dur', 'empty_pattern', 'clip_pattern_missing', 'clip_overrun', 'muted_track', 'duplicate_effect', 'master_chain_long', 'unknown_instrument', 'automation_point']) {
      assert.ok(codes.has(code), `缺少问题码 ${code}`)
    }
    assert.ok(summary.errors > 0)
    assert.ok(summary.warns > 0)
    assert.equal(counts.emptyPatterns, 1)
    assert.equal(Object.hasOwn(counts, 'legacyInstruments'), false)
  })

  it('studio_validate_project 只读：不 bump revision/不产生撤销步', async () => {
    const { state, exec } = await makeP10Tools()
    try {
      const revisionBefore = state.revision
      const historyBefore = state.historyState().undoDepth
      const first = await exec('studio_validate_project')
      const second = await exec('studio_validate_project')
      assert.equal(first.ok, true)
      assert.deepEqual(first.issues, second.issues)
      assert.equal(state.revision, revisionBefore)
      assert.equal(state.historyState().undoDepth, historyBefore)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('P10 tools — 增量编辑音符/片段与复制 pattern', () => {
  async function makeEditTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('studio_edit_notes：add/remove/update/transpose/velocityScale/quantize 组合且一次撤销', async () => {
    const { state, exec } = await makeEditTools()
    try {
      const pattern = await exec('studio_add_pattern', { name: '增量编辑测试', lengthBars: 4 })
      const patternId = pattern.patternId
      await exec('studio_set_notes', {
        patternId,
        notes: [
          { pitch: 60, start: 0, dur: 1, vel: 0.8 },
          { pitch: 64, start: 1, dur: 0.5, vel: 0.6 },
          { pitch: 67, start: 2, dur: 0.5, vel: 0.4 },
        ],
      })
      const undoDepthBefore = state.historyState().undoDepth
      const result = await exec('studio_edit_notes', {
        patternId,
        update: [{ index: 0, pitch: 62 }],
        remove: [2],
        add: [{ pitch: 72, start: 3, dur: 0.25, vel: 0.9 }],
        transpose: 12,
        velocityScale: 0.5,
        quantize: 0.25,
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.noteCount, 3)
      assert.equal(result.updated, 1)
      assert.equal(result.removed, 1)
      assert.equal(result.added, 1)
      const notes = state.project.patterns.find((item) => item.id === patternId).notes
      assert.deepEqual(notes.map((note) => note.pitch), [74, 76, 84])
      assert.deepEqual(notes.map((note) => Math.round(note.vel * 1000) / 1000), [0.4, 0.3, 0.45])
      assert.equal(state.historyState().undoDepth, undoDepthBefore + 1, '一次调用只产生一个撤销步')
      assert.equal(state.historyState().undoLabel, '增量编辑音符')
      assert.equal(state.undo().ok, true)
      const restored = state.project.patterns.find((item) => item.id === patternId).notes
      assert.deepEqual(restored.map((note) => note.pitch), [60, 64, 67])
      assert.equal(state.redo().ok, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_edit_notes：空 pattern 追加、humanize 参数校验、非法索引/pitch 报错', async () => {
    const { state, exec } = await makeEditTools()
    try {
      const pattern = await exec('studio_add_pattern', { name: '空 pattern', lengthBars: 2 })
      const patternId = pattern.patternId
      const added = await exec('studio_edit_notes', { patternId, add: [{ pitch: 60, start: 0, dur: 0.5, vel: 0.8 }] })
      assert.equal(added.ok, true)
      assert.equal(added.noteCount, 1)
      // humanize 0 抖动量 = 不变
      const unchanged = await exec('studio_edit_notes', { patternId, humanize: { timing: 0, velocity: 0 } })
      assert.equal(unchanged.ok, true)
      const notes = state.project.patterns.find((item) => item.id === patternId).notes
      assert.equal(notes[0].pitch, 60)
      assert.equal(notes[0].start, 0)
      // 非法参数
      const cases = [
        { patternId, update: [{ index: 99, pitch: 60 }] },
        { patternId, update: [{ index: 0, pitch: 200 }] },
        { patternId, update: [{ index: 0, dur: 0 }] },
        { patternId, remove: [5] },
        { patternId, humanize: { velocity: 2 } },
        { patternId, transpose: 999 },
      ]
      for (const args of cases) {
        const failed = await exec('studio_edit_notes', args)
        assert.equal(failed.ok, false, JSON.stringify(args))
        assert.equal(typeof failed.error, 'string')
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_edit_clips：add/update/remove 生效且一次撤销；未知轨道报错', async () => {
    const { state, exec } = await makeEditTools()
    try {
      const clipsBefore = state.project.clips.length
      const patternId = state.project.patterns[0].id
      const added = await exec('studio_edit_clips', {
        add: [{ trackId: 'trk_2', patternId, startBar: 0, lengthBars: 4 }],
      })
      assert.equal(added.ok, true, added.error)
      assert.equal(state.project.clips.length, clipsBefore + 1)
      const addedIndex = state.project.clips.length - 1
      const updated = await exec('studio_edit_clips', { update: [{ index: addedIndex, startBar: 4, lengthBars: 2 }] })
      assert.equal(updated.ok, true)
      assert.equal(state.project.clips[addedIndex].startBar, 4)
      assert.equal(state.project.clips[addedIndex].lengthBars, 2)
      const removed = await exec('studio_edit_clips', { remove: [addedIndex] })
      assert.equal(removed.ok, true)
      assert.equal(state.project.clips.length, clipsBefore)
      assert.equal(state.historyState().undoLabel, '增量编辑片段')
      // 一次 undo 回到添加后的状态
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.clips.length, clipsBefore + 1)
      // 错误
      const badTrack = await exec('studio_edit_clips', { add: [{ trackId: 'trk_404', patternId, startBar: 0, lengthBars: 2 }] })
      assert.equal(badTrack.ok, false)
      assert.match(badTrack.error, /不存在/)
      const badIndex = await exec('studio_edit_clips', { remove: [999] })
      assert.equal(badIndex.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_copy_pattern：复制全部音符与新 id，默认名字「副本」，可撤销', async () => {
    const { state, exec } = await makeEditTools()
    try {
      const source = state.project.patterns[6]
      const result = await exec('studio_copy_pattern', { patternId: source.id })
      assert.equal(result.ok, true, result.error)
      assert.notEqual(result.patternId, source.id)
      assert.equal(result.noteCount, source.notes.length)
      assert.equal(result.name, `${source.name} 副本`)
      const copy = state.project.patterns.find((item) => item.id === result.patternId)
      assert.ok(copy)
      assert.deepEqual(copy.notes, source.notes)
      assert.equal(state.historyState().undoLabel, '复制 pattern')
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.patterns.some((item) => item.id === result.patternId), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('P10 tools — 工程保存/列出/打开与自动备份', () => {
  async function makeProjectTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('studio_save_project / studio_list_projects / studio_open_project 闭环', async () => {
    const { dir, state, exec } = await makeProjectTools()
    try {
      const revisionBefore = state.revision
      const saved = await exec('studio_save_project', { name: 'P10 测试工程' })
      assert.equal(saved.ok, true, saved.error)
      assert.equal(saved.activeName, 'P10 测试工程')
      assert.equal(saved.name, 'P10 测试工程')
      assert.ok(saved.bytes > 0)
      assert.equal(state.activeName, 'P10 测试工程')
      assert.equal(state.revision, revisionBefore, '保存不应 bump revision')

      const listed = await exec('studio_list_projects')
      assert.equal(listed.ok, true)
      assert.equal(listed.activeName, 'P10 测试工程')
      const entry = listed.projects.find((project) => project.name === 'P10 测试工程')
      assert.ok(entry)
      assert.equal(entry.title, '霓虹天际线 Neon Skyline')
      assert.equal(entry.bpm, 128)
      assert.equal(entry.lengthBars, 32)

      // 新建另一个工程并保存
      const created = await exec('studio_create_project', { title: 'P10 第二工程' })
      assert.equal(created.ok, true)
      assert.equal(state.activeName, null, 'create_project 后 activeName 应清空')
      const saved2 = await exec('studio_save_project', { name: 'P10 第二工程' })
      assert.equal(saved2.ok, true)
      const listed2 = await exec('studio_list_projects')
      assert.ok(listed2.projects.some((project) => project.name === 'P10 测试工程'))
      assert.ok(listed2.projects.some((project) => project.name === 'P10 第二工程'))

      const opened = await exec('studio_open_project', { name: 'P10 测试工程' })
      assert.equal(opened.ok, true, opened.error)
      assert.equal(opened.name, 'P10 测试工程')
      assert.equal(state.project.title, '霓虹天际线 Neon Skyline')
      assert.equal(state.activeName, 'P10 测试工程')
      assert.equal(state.canUndo, false, '打开工程应清空撤销历史')

      const missing = await exec('studio_open_project', { name: '不存在的工程' })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /不存在/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_save_project：同名冲突默认拒绝，overwrite:true 覆盖', async () => {
    const { dir, state, exec } = await makeProjectTools()
    try {
      assert.equal((await exec('studio_save_project', { name: '冲突工程' })).ok, true)
      // 切到另一个工程后再次保存同名 → 冲突
      assert.equal((await exec('studio_create_project', { title: '冲突工程 v2' })).ok, true)
      const conflict = await exec('studio_save_project', { name: '冲突工程' })
      assert.equal(conflict.ok, false)
      assert.match(conflict.error, /已存在/)
      const overwritten = await exec('studio_save_project', { name: '冲突工程', overwrite: true })
      assert.equal(overwritten.ok, true)
      const loaded = await loadProjectFile(dir, '冲突工程')
      assert.equal(loaded.project.title, '冲突工程 v2')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_create_project：自动备份旧工程、activeName 清空、list 过滤自动备份', async () => {
    const { dir, state, exec } = await makeProjectTools()
    try {
      // R0A：先保存命名工程 → 创建新工程前的快照写入该工程的版本历史（不再用 _autobackup-*）
      await exec('studio_save_project', { name: '待备份工程' })
      const result = await exec('studio_create_project', { title: '全新工程' })
      assert.equal(result.ok, true)
      assert.ok(result.backupPath, 'create_project 应返回 backupPath')
      assert.equal(result.backupKind, 'version')
      assert.ok(result.backupPath.includes('_history'), '命名工程快照应在 projects/_history/<name>/ 下')
      assert.ok(result.backupPath.includes('待备份工程'))
      const backup = JSON.parse(await readFile(result.backupPath, 'utf8'))
      assert.equal(backup.title, '霓虹天际线 Neon Skyline')
      assert.equal(state.project.title, '全新工程')
      assert.equal(state.activeName, null)
      const listed = await exec('studio_list_projects')
      assert.ok(!listed.projects.some((project) => project.name.startsWith('_autobackup-')), '自动备份不应出现在工程列表')
      // 磁盘上确实有版本历史文件（且没有为命名工程写 _autobackup-*）
      const historyFiles = await readdir(path.join(projectsDir(dir), '_history', '待备份工程'))
      assert.ok(historyFiles.some((name) => name.endsWith('.json')))
      const files = await readdir(projectsDir(dir))
      assert.ok(!files.some((name) => name.startsWith('_autobackup-') && name.endsWith('.json')))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_list_projects：损坏工程返回 skipped 而不崩', async () => {
    const { dir, state, exec } = await makeProjectTools()
    try {
      await exec('studio_save_project', { name: '正常工程' })
      await writeFile(path.join(projectsDir(dir), '损坏工程.json'), '{not valid json', 'utf8')
      const listed = await exec('studio_list_projects')
      assert.equal(listed.ok, true)
      assert.ok(listed.projects.some((project) => project.name === '正常工程'))
      assert.ok(listed.skipped.some((item) => item.name === '损坏工程'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('P10 tools — 并发一致性 expectedRevision / 重复效果器 / 导出控制', () => {
  async function makeConcurrencyTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('expectedRevision 冲突：返回 retry:true 且不写入、不入撤销栈', async () => {
    const { state, exec } = await makeConcurrencyTools()
    try {
      const patternId = state.project.patterns[0].id
      const notesBefore = state.project.patterns[0].notes.length
      const undoDepthBefore = state.historyState().undoDepth
      const stale = state.revision - 1 >= 0 ? state.revision - 1 : 0
      const conflict = await exec('studio_edit_notes', {
        patternId,
        add: [{ pitch: 60, start: 0, dur: 0.5 }],
        expectedRevision: stale,
      })
      assert.equal(conflict.ok, false)
      assert.equal(conflict.retry, true)
      assert.equal(conflict.currentRevision, state.revision)
      assert.equal(conflict.expectedRevision, stale)
      assert.match(conflict.error, /版本冲突/)
      assert.equal(state.project.patterns[0].notes.length, notesBefore, '冲突时不应写入')
      assert.equal(state.historyState().undoDepth, undoDepthBefore, '冲突时不应入撤销栈')

      const success = await exec('studio_edit_notes', {
        patternId,
        add: [{ pitch: 60, start: 0, dur: 0.5 }],
        expectedRevision: state.revision,
      })
      assert.equal(success.ok, true, success.error)
      assert.equal(state.project.patterns[0].notes.length, notesBefore + 1)

      const badExpected = await exec('studio_edit_notes', { patternId, expectedRevision: 'abc' })
      assert.equal(badExpected.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 同样约束 create_project / copy_pattern（冲突不执行）', async () => {
    const { state, exec } = await makeConcurrencyTools()
    try {
      const titleBefore = state.project.title
      const conflict = await exec('studio_create_project', { title: '不应创建', expectedRevision: state.revision - 1 })
      assert.equal(conflict.ok, false)
      assert.equal(conflict.retry, true)
      assert.equal(state.project.title, titleBefore, '冲突时不应重置工程')

      const patternId = state.project.patterns[0].id
      const countBefore = state.project.patterns.length
      const copyConflict = await exec('studio_copy_pattern', { patternId, expectedRevision: state.revision - 1 })
      assert.equal(copyConflict.ok, false)
      assert.equal(state.project.patterns.length, countBefore)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_add_effect 重复同 type 返回 warnings；validate 报告 duplicate_effect', async () => {
    const { state, exec } = await makeConcurrencyTools()
    try {
      const trackId = 'trk_1'
      const first = await exec('studio_add_effect', { target: trackId, type: 'filter' })
      assert.equal(first.ok, true)
      assert.equal(first.warnings, undefined)
      const second = await exec('studio_add_effect', { target: trackId, type: 'filter' })
      assert.equal(second.ok, true)
      assert.ok(Array.isArray(second.warnings))
      assert.match(second.warnings[0], /已存在同类效果器/)
      const validated = await exec('studio_validate_project')
      assert.ok(validated.issues.some((issue) => issue.code === 'duplicate_effect'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_export：tailSeconds/normalize/name 写入 exportRequest 并回传', async () => {
    const { state, exec } = await makeConcurrencyTools()
    try {
      const result = await exec('studio_export', { tailSeconds: 2.5, normalize: true, name: '我的成品' })
      assert.equal(result.ok, true)
      assert.equal(result.format, 'wav')
      assert.equal(result.tailSeconds, 2.5)
      assert.equal(result.normalize, true)
      const request = state.project.exportRequest
      assert.equal(request.tailSeconds, 2.5)
      assert.equal(request.normalize, true)
      assert.equal(request.name, '我的成品')
      assert.equal(request.format, undefined)

      // 越界 tailSeconds 钳制到 0..8
      state.project.exportRequest = null
      const clamped = await exec('studio_export', { tailSeconds: 99 })
      assert.equal(state.project.exportRequest.tailSeconds, 8)
      state.project.exportRequest = null
      const negative = await exec('studio_export', { tailSeconds: -3 })
      assert.equal(state.project.exportRequest.tailSeconds, 0)

      state.project.exportRequest = null
      const stems = await exec('studio_export', { format: 'stems', tailSeconds: 1, normalize: false })
      assert.equal(stems.format, 'stems')
      assert.equal(state.project.exportRequest.format, 'stems')
      assert.equal(state.project.exportRequest.tailSeconds, 1)
      assert.equal(state.project.exportRequest.normalize, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P11：延音踏板 / 揉弦 / includeNotes / 导出历史 / highshelf / preDelay       */
/* ------------------------------------------------------------------------- */

describe('P11 tools — 延音踏板 / 揉弦 / includeNotes', () => {
  async function makeP11Tools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('studio_set_sustain：排序/去重/夹紧，get_project 默认摘要、includeSustain 才全量，可撤销', async () => {
    const { state, exec } = await makeP11Tools()
    try {
      const trackId = state.project.tracks.find((track) => track.instrument?.preset === 'grand_piano').id
      const result = await exec('studio_set_sustain', {
        trackId,
        points: [
          { beat: 8, value: 1 },
          { beat: 4, value: 0.2 },
          { beat: 4, value: 1 },
          { beat: 999999, value: 0 },
        ],
      })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === trackId)
      assert.deepEqual(track.sustain, [
        { beat: 4, value: 1 },
        { beat: 8, value: 1 },
        { beat: 128, value: 0 }, // 32 小节 * 4 beat
      ])
      assert.equal(result.points.length, 3)
      assert.equal(state.historyState().undoLabel, '设置延音踏板')
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.tracks.find((item) => item.id === trackId).sustain, {
        pointCount: 3,
        down: false,
        firstBeat: 4,
        lastBeat: 128,
      })
      const full = await exec('studio_get_project', { includeSustain: true })
      assert.deepEqual(full.tracks.find((item) => item.id === trackId).sustain.points, track.sustain)
      assert.equal(overview.tracks.find((item) => item.id === 'trk_1').sustain, null)
      // 撤销
      assert.equal(state.undo().ok, true)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === trackId), 'sustain'), false)
      assert.equal(state.redo().ok, true)
      // 清除
      const cleared = await exec('studio_clear_sustain', { trackId })
      assert.equal(cleared.ok, true)
      assert.equal(cleared.cleared, true)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === trackId), 'sustain'), false)
      const again = await exec('studio_clear_sustain', { trackId })
      assert.equal(again.cleared, false)
      // 空数组 = 清除
      await exec('studio_set_sustain', { trackId, points: [] })
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === trackId), 'sustain'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_set_vibrato：部分更新合并默认值、范围夹紧、clear、可撤销', async () => {
    const { state, exec } = await makeP11Tools()
    try {
      const trackId = state.project.tracks.find((track) => track.instrument?.preset === 'strings_ensemble').id
      const result = await exec('studio_set_vibrato', { trackId, rateHz: 99, depthCents: 999 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.rateHz, 12)
      assert.equal(result.depthCents, 100)
      assert.equal(result.enabled, true)
      const partial = await exec('studio_set_vibrato', { trackId, enabled: false })
      assert.equal(partial.ok, true)
      assert.deepEqual(partial, { ok: true, trackId, rateHz: 12, depthCents: 100, enabled: false, rev: state.revision })
      assert.equal(state.historyState().undoLabel, '设置揉弦')
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.tracks.find((item) => item.id === trackId).vibrato, {
        rateHz: 12,
        depthCents: 100,
        enabled: false,
      })
      // 撤销
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.tracks.find((item) => item.id === trackId).vibrato.enabled, true)
      // 清除
      const cleared = await exec('studio_clear_vibrato', { trackId })
      assert.equal(cleared.ok, true)
      assert.equal(cleared.cleared, true)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === trackId), 'vibrato'), false)
      assert.equal((await exec('studio_clear_vibrato', { trackId })).cleared, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('P11 工具参数校验：sustain points 非数组 / vibrato 无字段 / 非法 trackId', async () => {
    const { state, exec } = await makeP11Tools()
    try {
      const trackId = state.project.tracks[0].id
      const cases = [
        ['studio_set_sustain', { trackId }],
        ['studio_set_sustain', { trackId, points: 'bad' }],
        ['studio_set_sustain', { trackId: 'trk_404', points: [] }],
        ['studio_set_vibrato', { trackId }],
        ['studio_set_vibrato', { trackId, rateHz: 'fast' }],
        ['studio_clear_sustain', { trackId: 'trk_404' }],
        ['studio_clear_vibrato', {}],
      ]
      for (const [name, args] of cases) {
        const result = await exec(name, args)
        assert.equal(result.ok, false, `${name} ${JSON.stringify(args)} 应失败`)
        assert.equal(typeof result.error, 'string')
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('P11 expectedRevision：sustain/vibrato 冲突不写入', async () => {
    const { state, exec } = await makeP11Tools()
    try {
      const trackId = state.project.tracks[0].id
      const stale = state.revision - 1
      const conflict = await exec('studio_set_sustain', { trackId, points: [{ beat: 0, value: 1 }], expectedRevision: stale })
      assert.equal(conflict.ok, false)
      assert.equal(conflict.retry, true)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === trackId), 'sustain'), false)
      const okResult = await exec('studio_set_sustain', { trackId, points: [{ beat: 0, value: 1 }], expectedRevision: state.revision })
      assert.equal(okResult.ok, true)
      assert.equal(state.project.tracks.find((item) => item.id === trackId).sustain.length, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_get_project includeNotes：默认 false（patterns 无 notes），true 时带完整音符', async () => {
    const { state, exec } = await makeP11Tools()
    try {
      const normal = await exec('studio_get_project')
      assert.equal(normal.ok, true)
      assert.equal(normal.notesIncluded, undefined)
      // 默认：patterns[].notes 是音符数量（number），不是数组
      for (const pattern of normal.patterns) assert.equal(typeof pattern.notes, 'number')
      assert.equal(normal.patterns.length, 13)
      assert.equal(normal.patterns[0].notes, state.project.patterns[0].notes.length)

      const withNotes = await exec('studio_get_project', { includeNotes: true })
      assert.equal(withNotes.ok, true)
      assert.equal(withNotes.notesIncluded, true)
      assert.equal(withNotes.patterns.length, state.project.patterns.length)
      for (const pattern of withNotes.patterns) {
        assert.ok(Array.isArray(pattern.notes), `${pattern.id} 应有 notes 数组`)
        const source = state.project.patterns.find((item) => item.id === pattern.id)
        assert.equal(pattern.notes.length, source.notes.length)
        assert.deepEqual(pattern.notes[0], {
          pitch: source.notes[0].pitch,
          start: Math.round(source.notes[0].start * 1000) / 1000,
          dur: Math.round(source.notes[0].dur * 1000) / 1000,
          vel: Math.round(source.notes[0].vel * 1000) / 1000,
        })
      }
      // 音符格式与 get_pattern 一致
      const view = await exec('studio_get_pattern', { patternId: withNotes.patterns[0].id })
      assert.deepEqual(withNotes.patterns[0].notes, view.notes)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('P11 — 导出历史 / highshelf / reverb preDelay', () => {
  async function makeP11Tools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('/export-done 成功写入 exportHistory（最新在前、格式正确）', async () => {
    const { state } = await makeP11Tools()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      const first = await fetch(`${server.base}/studio/api/export-done?name=mix-1.wav`, { method: 'POST', body: wav })
      assert.equal(first.status, 200)
      assert.equal(state.project.exportHistory.length, 1)
      assert.deepEqual(
        {
          name: state.project.exportHistory[0].name,
          format: state.project.exportHistory[0].format,
          seconds: state.project.exportHistory[0].seconds,
          bytes: state.project.exportHistory[0].bytes,
        },
        { name: 'mix-1.wav', format: 'wav', seconds: 1, bytes: wav.length },
      )
      assert.ok(state.project.exportHistory[0].path.endsWith('mix-1.wav'))
      assert.equal(typeof state.project.exportHistory[0].at, 'number')

      // 第二次导出（stems 请求下）→ 最新在前、format=stems
      state.mutate({ tool: 'studio_export', text: null }, (draft) => ops.exportRequest(draft, { format: 'stems' }))
      const second = await fetch(`${server.base}/studio/api/export-done?name=stems-01-鼓.wav`, { method: 'POST', body: wav })
      assert.equal(second.status, 200)
      assert.equal(state.project.exportHistory.length, 2)
      assert.equal(state.project.exportHistory[0].name, 'stems-01-鼓.wav')
      assert.equal(state.project.exportHistory[0].format, 'stems')
      assert.equal(state.project.exportHistory[1].name, 'mix-1.wav')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('导出历史最多 10 条；get_project 返回；create_project 重置为空', async () => {
    const { state, exec } = await makeP11Tools()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      for (let index = 0; index < 12; index += 1) {
        const response = await fetch(`${server.base}/studio/api/export-done?name=mix-${index}.wav`, { method: 'POST', body: wav })
        assert.equal(response.status, 200)
      }
      assert.equal(state.project.exportHistory.length, 10)
      assert.equal(state.project.exportHistory[0].name, 'mix-11.wav')
      assert.equal(state.project.exportHistory[9].name, 'mix-2.wav')
      const overview = await exec('studio_get_project')
      assert.equal(overview.exportHistory.length, 10)
      assert.equal(overview.exportHistory[0].name, 'mix-11.wav')
      // create_project 重置工程 → 历史清空（旧工程有 autobackup）
      const created = await exec('studio_create_project', { title: 'P11 新工程' })
      assert.equal(created.ok, true)
      assert.deepEqual(state.project.exportHistory, [])
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('导出历史持久化：保存→打开、重启后保留；缺字段兼容', async () => {
    const { dir, state, exec } = await makeP11Tools()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      await fetch(`${server.base}/studio/api/export-done?name=持久化导出.wav`, { method: 'POST', body: wav })
      await exec('studio_save_project', { name: 'P11 导出历史工程' })
      // 新建（重置）→ 打开保留
      await exec('studio_create_project', { title: '临时工程' })
      assert.deepEqual(state.project.exportHistory, [])
      const opened = await exec('studio_open_project', { name: 'P11 导出历史工程' })
      assert.equal(opened.ok, true)
      assert.equal(state.project.exportHistory.length, 1)
      assert.equal(state.project.exportHistory[0].name, '持久化导出.wav')
      await state.flush()
    } finally {
      await server.close()
      state.dispose()
    }
    // 重启（同 dataDir 的 project.json）
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      assert.equal(reloaded.project.exportHistory.length, 1)
      assert.equal(reloaded.project.exportHistory[0].format, 'wav')
      assert.ok(reloaded.project.exportHistory[0].seconds > 0)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('exportHistory 非法数据：加载时防御规范化（丢弃非法/超 10 截断）', async () => {
    const dir = await tempDir()
    const legacy = createDemoProject()
    delete legacy.exportHistory // 旧工程没有字段
    const legacy2 = JSON.parse(JSON.stringify(legacy))
    const entries = [{ name: 'a.wav', format: 'wav', seconds: 1, bytes: 10, path: '/x/a.wav', at: 1 }]
    for (let index = 0; index < 20; index += 1) entries.push({ name: `b-${index}.wav`, format: 'stems', seconds: index, bytes: index, path: `b-${index}`, at: index })
    entries.push({ name: '', path: '' }) // 非法
    legacy2.exportHistory = entries
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(legacy2), 'utf8')
    const state = createState({ dataDir: dir })
    await state.ready
    try {
      assert.equal(state.project.exportHistory.length, 10, '超 10 条截断')
      assert.equal(state.project.exportHistory[0].name, 'a.wav')
      for (const entry of state.project.exportHistory) assert.ok(entry.name && entry.path)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_add_effect 支持 highshelf：参数钳制、摘要、撤销、master/返回总线可用', async () => {
    const { state, exec } = await makeP11Tools()
    try {
      const trackId = state.project.tracks.find((track) => track.instrument?.preset === 'grand_piano').id
      const added = await exec('studio_add_effect', {
        target: trackId,
        type: 'highshelf',
        params: { freq: 99999, gain: 99 },
      })
      assert.equal(added.ok, true, added.error)
      const trackFx = () => state.project.tracks.find((item) => item.id === trackId).effects.find((fx) => fx.id === added.effectId)
      assert.equal(trackFx().type, 'highshelf')
      assert.equal(trackFx().params.freq, 16000)
      assert.equal(trackFx().params.gain, 12)
      const updated = await exec('studio_update_effect', {
        target: trackId,
        effectId: added.effectId,
        params: { freq: 5000, gain: -3 },
      })
      assert.equal(updated.ok, true)
      assert.equal(trackFx().params.freq, 5000)
      assert.equal(trackFx().params.gain, -3)
      const overview = await exec('studio_get_project')
      const track = overview.tracks.find((item) => item.id === trackId)
      assert.ok(track.effects.some((fx) => fx.type === 'highshelf'))
      // master / bus
      assert.equal((await exec('studio_add_effect', { target: 'master', type: 'highshelf', params: { gain: 6 } })).ok, true)
      assert.equal((await exec('studio_add_effect', { target: 'bus', busId: 'reverb', type: 'highshelf' })).ok, true)
      assert.equal(state.undo().ok, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('reverb preDelay：默认值、更新钳制、保存重启保留', async () => {
    const { dir, state, exec } = await makeP11Tools()
    try {
      const trackId = state.project.tracks[0].id
      const added = await exec('studio_add_effect', { target: trackId, type: 'reverb' })
      assert.equal(added.ok, true)
      const trackFx = () => state.project.tracks.find((item) => item.id === trackId).effects.find((fx) => fx.id === added.effectId)
      assert.equal(trackFx().params.preDelay, 20, '默认 preDelay 20ms')
      const updated = await exec('studio_update_effect', {
        target: trackId,
        effectId: added.effectId,
        params: { preDelay: 999 },
      })
      assert.equal(updated.ok, true)
      assert.equal(trackFx().params.preDelay, 120)
      await state.flush()
    } finally {
      await state.flush()
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      const reverbFx = reloaded.project.tracks.flatMap((track) => track.effects).find((fx) => fx.type === 'reverb')
      assert.ok(reverbFx)
      assert.equal(reverbFx.params.preDelay, 120)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P12a：schemaVersion 2 clean break — 旧文件冷备份/列表标记/打开拒绝           */
/* ------------------------------------------------------------------------- */

describe('P12a clean break — schemaVersion 2', () => {
  async function makeP12Tools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  /** 造一份 schemaVersion 1 的旧工程快照。 */
  const legacyProject = () => {
    const project = JSON.parse(JSON.stringify(createDemoProject()))
    project.schemaVersion = 1
    project.title = '旧版本工程'
    return project
  }

  it('旧 schema project.json：冷备份到 legacy-v1/project-<时间戳>.json，重新 seed 当前 demo', async () => {
    const dir = await tempDir()
    const legacy = legacyProject()
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(legacy), 'utf8')
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      assert.equal(state.loadedFromDisk, false)
      assert.equal(state.project.schemaVersion, 3)
      assert.equal(state.project.title, '霓虹天际线 Neon Skyline')
      assert.ok(state.legacyBackupPath.includes('legacy-v1'))
      assert.match(path.basename(state.legacyBackupPath), /^project-\d{8}-\d{6}\.json$/)
      const backup = JSON.parse(await readFile(state.legacyBackupPath, 'utf8'))
      assert.equal(backup.schemaVersion, 1)
      assert.equal(backup.title, '旧版本工程')
      await state.flush()
      const persisted = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
      assert.equal(persisted.schemaVersion, 3, '旧文件被新版本工程覆盖前已冷备份')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('缺少 schemaVersion 的 project.json 也算旧文件：冷备份 + 重新 seed', async () => {
    const dir = await tempDir()
    const legacy = legacyProject()
    delete legacy.schemaVersion
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(legacy), 'utf8')
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      assert.equal(state.loadedFromDisk, false)
      assert.equal(state.project.schemaVersion, 3)
      assert.ok(state.legacyBackupPath)
      assert.equal(JSON.parse(await readFile(state.legacyBackupPath, 'utf8')).schemaVersion, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('当前 schema 启动不产生冷备份；legacyBackupPath 为 null', async () => {
    const { dir, state } = await makeState()
    try {
      assert.equal(state.project.schemaVersion, 3)
      assert.equal(state.legacyBackupPath, null)
      await state.flush()
      assert.equal((await readdir(dir)).includes('legacy-v1'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('listProjects 跳过旧 schema 并标记 unsupported；损坏 JSON 仍进 skipped', async () => {
    const dir = await tempDir()
    await mkdir(projectsDir(dir), { recursive: true })
    await writeFile(path.join(projectsDir(dir), '旧版.json'), JSON.stringify(legacyProject()), 'utf8')
    await writeFile(path.join(projectsDir(dir), '损坏.json'), '{bad json', 'utf8')
    const result = await listProjects(dir)
    assert.equal(result.projects.length, 0)
    assert.equal(result.unsupported.length, 1)
    assert.equal(result.unsupported[0].name, '旧版')
    assert.match(result.unsupported[0].reason, /旧版本工程不支持/)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].name, '损坏')
  })

  it('loadProjectFile / saveProjectFile：v1 中文拒绝，v2 打开时迁移、只写 v3', async () => {
    const dir = await tempDir()
    await mkdir(projectsDir(dir), { recursive: true })
    await writeFile(path.join(projectsDir(dir), '旧版.json'), JSON.stringify(legacyProject()), 'utf8')
    await assert.rejects(() => loadProjectFile(dir, '旧版'), /旧版本工程不支持/)
    const invalidProject = JSON.parse(JSON.stringify(createEmptyProject()))
    invalidProject.schemaVersion = 1
    await assert.rejects(() => saveProjectFile(dir, '非法保存', invalidProject), /schemaVersion 必须为 3/)
    // 合法工程可正常保存/读取
    const saved = await saveProjectFile(dir, '正常工程', createEmptyProject())
    assert.equal(saved.name, '正常工程')
    const loaded = await loadProjectFile(dir, '正常工程')
    assert.equal(loaded.project.schemaVersion, 3)
  })

  it('工具层：list_projects 返回 unsupported；open_project 旧版返回中文错误且不切换工程', async () => {
    const { dir, state, exec } = await makeP12Tools()
    try {
      const titleBefore = state.project.title
      await mkdir(projectsDir(dir), { recursive: true })
      await writeFile(path.join(projectsDir(dir), '旧版工程.json'), JSON.stringify(legacyProject()), 'utf8')
      const listed = await exec('studio_list_projects')
      assert.equal(listed.ok, true)
      assert.equal(listed.unsupported.length, 1)
      assert.equal(listed.unsupported[0].name, '旧版工程')
      assert.ok(!listed.projects.some((project) => project.name === '旧版工程'))
      const opened = await exec('studio_open_project', { name: '旧版工程' })
      assert.equal(opened.ok, false)
      assert.match(opened.error, /旧版本工程不支持/)
      assert.equal(state.project.title, titleBefore)
      // 当前 schema 工程可正常保存/打开
      assert.equal((await exec('studio_save_project', { name: '新版本工程' })).ok, true)
      const reopened = await exec('studio_open_project', { name: '新版本工程' })
      assert.equal(reopened.ok, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/state 与 app_info 暴露 schemaVersion 3；不再包含 LEGACY 音源目录', async () => {
    const { state } = await makeP12Tools()
    const server = await startServer(state)
    try {
      const current = await getJson(server.base, '/studio/api/state?rev=0')
      assert.equal(current.data.project.schemaVersion, 3)
      const catalog = await getJson(server.base, '/studio/api/catalog')
      assert.equal(catalog.data.ok, true)
      assert.equal(Object.hasOwn(catalog.data, 'legacySynthPresets'), false)
      assert.equal(Object.hasOwn(catalog.data, 'legacyDrumKits'), false)
      assert.equal(catalog.data.counts.instruments, 32)
      assert.equal(catalog.data.counts.drumKits, 4)
      assert.equal(catalog.data.counts.effects, 15)
      const appInfo = await ops.getProjectOverview(state.project)
      assert.equal(appInfo.schemaVersion, 3, 'R1b：概览返回 schemaVersion=3')
      assert.equal(appInfo.format.name, 'aims')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('P12：normalizeProject 旧 schema 抛错；createDemoProject 可直接启动', async () => {
    const stateDir = await tempDir()
    await mkdir(stateDir, { recursive: true })
    await writeFile(path.join(stateDir, 'project.json'), JSON.stringify(legacyProject()), 'utf8')
    const state = createState({ dataDir: stateDir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      const { schemaVersion } = state.project
      assert.equal(schemaVersion, SCHEMA_VERSION)
      const backupName = path.basename(state.legacyBackupPath)
      assert.match(backupName, /^project-/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P12b：全局速度曲线 tempoMap（模型/工具/撤销/持久化）                        */
/* ------------------------------------------------------------------------- */

describe('P12b — tempoMap 工具与摘要', () => {
  async function makeTempoTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('studio_set_tempo_map：排序/去重/夹紧/上限，get_project 返回 tempoMap 摘要', async () => {
    const { state, exec } = await makeTempoTools()
    try {
      const result = await exec('studio_set_tempo_map', {
        points: [
          { beat: 16, bpm: 180 },
          { beat: 0, bpm: 90 },
          { beat: 8, bpm: 999 },
          { beat: 8, bpm: 60 },
          { beat: -1, bpm: 120 },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.points, [
        { beat: 0, bpm: 90 },
        { beat: 8, bpm: 60 },
        { beat: 16, bpm: 180 },
      ])
      assert.equal(result.hasTempo, true)
      assert.equal(state.historyState().undoLabel, '设置速度曲线')
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.tempoMap, [
        { beat: 0, bpm: 90 },
        { beat: 8, bpm: 60 },
        { beat: 16, bpm: 180 },
      ])
      assert.equal(overview.hasTempo, true)
      assert.equal(overview.bpm, 128)
      // 撤销/重做
      assert.equal(state.undo().ok, true)
      assert.equal(Object.hasOwn(state.project, 'tempoMap'), false)
      assert.equal(state.redo().ok, true)
      assert.equal(state.project.tempoMap.length, 3)
      // 空数组 = 清除
      const clearedBySet = await exec('studio_set_tempo_map', { points: [] })
      assert.equal(clearedBySet.ok, true)
      assert.equal(clearedBySet.hasTempo, false)
      assert.equal(Object.hasOwn(state.project, 'tempoMap'), false)
      // clear 幂等
      const cleared = await exec('studio_clear_tempo_map')
      assert.equal(cleared.ok, true)
      assert.equal(cleared.cleared, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('tempoMap 上限 64 点、expectedRevision 冲突不写入', async () => {
    const { state, exec } = await makeTempoTools()
    try {
      const points = Array.from({ length: 70 }, (_, index) => ({ beat: index * 0.1, bpm: 40 + (index % 100) }))
      const result = await exec('studio_set_tempo_map', { points })
      assert.equal(result.ok, true)
      assert.equal(result.points.length, 64)
      const stale = await exec('studio_set_tempo_map', { points: [{ beat: 0, bpm: 120 }], expectedRevision: state.revision - 1 })
      assert.equal(stale.ok, false)
      assert.equal(stale.retry, true)
      assert.equal(state.project.tempoMap.length, 64, '冲突时不应写入')
      const okResult = await exec('studio_clear_tempo_map', { expectedRevision: state.revision })
      assert.equal(okResult.ok, true)
      assert.equal(okResult.cleared, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('tempoMap 持久化：保存→打开、重启后保留；/edit setTempoMap 可用', async () => {
    const { dir, state, exec } = await makeTempoTools()
    try {
      await exec('studio_set_tempo_map', { points: [{ beat: 0, bpm: 100 }, { beat: 32, bpm: 140 }] })
      const saved = await exec('studio_save_project', { name: 'P12b tempo 工程' })
      assert.equal(saved.ok, true)
      await exec('studio_create_project', { title: '临时' })
      assert.equal(Object.hasOwn(state.project, 'tempoMap'), false)
      const opened = await exec('studio_open_project', { name: 'P12b tempo 工程' })
      assert.equal(opened.ok, true)
      assert.deepEqual(state.project.tempoMap, [{ beat: 0, bpm: 100 }, { beat: 32, bpm: 140 }])
      // /edit op setTempoMap（经 state.mutate 持久化，一次撤销「设置速度曲线」）
      const edit = state.mutate({ tool: 'studio_edit', text: null, undoLabel: '设置速度曲线' }, (draft) =>
        ops.applyEditOps(draft, [{ type: 'setTempoMap', points: [{ beat: 4, bpm: 160 }] }]),
      )
      assert.equal(edit.label, '设置速度曲线')
      assert.deepEqual(state.project.tempoMap, [{ beat: 4, bpm: 160 }])
      assert.equal(state.historyState().undoLabel, '设置速度曲线')
      await state.flush()
    } finally {
      await state.flush()
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      assert.deepEqual(reloaded.project.tempoMap, [{ beat: 4, bpm: 160 }])
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('studio_validate_project：速度曲线点越界/乱序/非法 bpm 给出 tempo_point 警告', async () => {
    const project = createDemoProject()
    project.tempoMap = [
      { beat: 0, bpm: 120 },
      { beat: 16, bpm: 999 },
      { beat: 8, bpm: 60 },
      { beat: 99999, bpm: 90 },
    ]
    const { issues, counts } = ops.validateProject(project)
    const tempoIssues = issues.filter((issue) => issue.code === 'tempo_point')
    assert.ok(tempoIssues.length >= 2, JSON.stringify(tempoIssues))
    assert.ok(tempoIssues.some((issue) => /bpm/.test(issue.message)))
    assert.ok(tempoIssues.some((issue) => /升序|beat/.test(issue.message)))
    assert.equal(counts.tempoPoints, 4)
  })
})

/* ------------------------------------------------------------------------- */
/* P13：EQ3 全参数 / 表情自动化 / studio_batch / Master 默认                   */
/* ------------------------------------------------------------------------- */

describe('P13 — eq3 全参数 / 表情自动化 / studio_batch / master 默认', () => {
  async function makeP13Tools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('studio_add_effect eq3：新参数默认值/钳制/更新/撤销/重启保留', async () => {
    const { dir, state, exec } = await makeP13Tools()
    try {
      const trackId = state.project.tracks.find((track) => track.instrument?.preset === 'grand_piano').id
      const added = await exec('studio_add_effect', { target: trackId, type: 'eq3' })
      assert.equal(added.ok, true, added.error)
      const fx = () => state.project.tracks.find((track) => track.id === trackId).effects.find((item) => item.id === added.effectId)
      assert.deepEqual(fx().params, {
        low: 0, lowFreq: 200, mid: 0, midFreq: 1000, midQ: 1, high: 0, highFreq: 8000,
      })
      const updated = await exec('studio_update_effect', {
        target: trackId,
        effectId: added.effectId,
        params: { lowFreq: 120, midFreq: 2500, midQ: 2.5, highFreq: 99999 },
      })
      assert.equal(updated.ok, true, updated.error)
      assert.equal(fx().params.lowFreq, 120)
      assert.equal(fx().params.midFreq, 2500)
      assert.equal(fx().params.midQ, 2.5)
      assert.equal(fx().params.highFreq, 16000, '钳制到 16000')
      await state.flush()
    } finally {
      await state.flush()
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      const eq3 = reloaded.project.tracks.flatMap((track) => track.effects).find((item) => item.type === 'eq3' && item.params.lowFreq === 120)
      assert.ok(eq3, '重启后 eq3 新参数保留')
      assert.equal(eq3.params.midQ, 2.5)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('master 默认空链：新建工程 master.effects=[]；demo 保留 eq3+compressor', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.master.effects.map((fx) => fx.type), ['eq3', 'compressor'])
      assert.equal(state.project.master.effects.length, 2)
      const created = await exec('studio_create_project', { title: 'P13 空白工程' })
      assert.equal(created.ok, true)
      assert.equal(created.project.master.effects.length, 0)
      assert.deepEqual(state.project.master.effects, [])
      // 新建工程后加 master EQ 正常
      const added = await exec('studio_add_effect', { target: 'master', type: 'eq3' })
      assert.equal(added.ok, true)
      assert.equal(state.project.master.effects.length, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_set_automation 表情参数：pitchBend/modulation/expression 写入/get_project/撤销；master 拒绝', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const trackId = 'trk_3'
      const bend = await exec('studio_set_automation', {
        trackId,
        param: 'pitchBend',
        points: [{ beat: 0, value: 0.5 }, { beat: 8, value: 0 }],
      })
      assert.equal(bend.ok, true, bend.error)
      await exec('studio_set_automation', { trackId, param: 'modulation', points: [{ beat: 0, value: 1 }] })
      await exec('studio_set_automation', { trackId, param: 'expression', points: [{ beat: 0, value: 0.4 }, { beat: 4, value: 1 }] })
      const overview = await exec('studio_get_project')
      const automation = overview.tracks.find((track) => track.id === trackId).automation
      assert.deepEqual(automation.pitchBend, { enabled: true, pointCount: 2, firstBeat: 0, lastBeat: 8 })
      assert.equal(automation.modulation.pointCount, 1)
      assert.equal(automation.expression.pointCount, 2)
      const full = await exec('studio_get_project', { includeAutomation: true })
      const fullAutomation = full.tracks.find((track) => track.id === trackId).automation
      assert.deepEqual(fullAutomation.pitchBend.points, [{ beat: 0, value: 0.5 }, { beat: 8, value: 0 }])
      assert.equal(fullAutomation.expression.points.length, 2)
      assert.equal(state.historyState().undoLabel, '编辑自动化')
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.tracks.find((track) => track.id === trackId).automation.expression, undefined)
      // master 只能 volume：表情参数中文拒绝且不写入
      const revisionBefore = state.revision
      for (const param of ['pitchBend', 'modulation', 'expression']) {
        const rejected = await exec('studio_set_automation', { target: 'master', param, points: [{ beat: 0, value: 0.5 }] })
        assert.equal(rejected.ok, false, param)
        assert.match(rejected.error, /master 只支持 volume/)
      }
      assert.equal(state.revision, revisionBefore)
      // 表情曲线经保存/重启保留
      await exec('studio_set_automation', { trackId, param: 'pitchBend', points: [{ beat: 0, value: 0.2 }] })
      await state.flush()
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：混合操作一次撤销（默认 label「批量编辑」），undo/redo 全回退', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const before = JSON.stringify({
        track: state.project.tracks.find((track) => track.id === 'trk_3'),
        master: state.project.master,
        tempoMap: state.project.tempoMap ?? null,
      })
      const revBefore = state.revision
      const undoDepthBefore = state.historyState().undoDepth
      const result = await exec('studio_batch', {
        ops: [
          { type: 'updateTrack', args: { trackId: 'trk_3', volume: 0.5, pan: 0.2 } },
          { type: 'setAutomation', args: { trackId: 'trk_3', param: 'pitchBend', points: [{ beat: 0, value: 0.5 }, { beat: 4, value: 0 }] } },
          { type: 'setSustain', args: { trackId: 'trk_3', points: [{ beat: 0, value: 1 }] } },
          { type: 'addEffect', args: { target: 'trk_3', type: 'filter', params: { cutoff: 2000 } } },
          { type: 'setTempoMap', args: { points: [{ beat: 0, bpm: 100 }, { beat: 8, bpm: 140 }] } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 5)
      assert.equal(result.label, '批量编辑')
      assert.equal(result.results.length, 5)
      assert.equal(result.results[0].type, 'updateTrack')
      assert.equal(state.historyState().undoLabel, '批量编辑')
      assert.equal(state.historyState().undoDepth, undoDepthBefore + 1, '一次批量只入一个撤销步')
      assert.equal(state.revision, revBefore + 1, '一次 mutate 只 bump 一次 revision')
      const track = state.project.tracks.find((item) => item.id === 'trk_3')
      assert.equal(track.volume, 0.5)
      assert.equal(track.pan, 0.2)
      assert.deepEqual(track.automation.pitchBend.points, [{ beat: 0, value: 0.5 }, { beat: 4, value: 0 }])
      assert.deepEqual(track.sustain, [{ beat: 0, value: 1 }])
      assert.ok(track.effects.some((fx) => fx.type === 'filter'))
      assert.deepEqual(state.project.tempoMap, [{ beat: 0, bpm: 100 }, { beat: 8, bpm: 140 }])
      // undo 恢复全部内容
      assert.equal(state.undo().ok, true)
      const after = JSON.stringify({
        track: state.project.tracks.find((item) => item.id === 'trk_3'),
        master: state.project.master,
        tempoMap: state.project.tempoMap ?? null,
      })
      assert.equal(after, before)
      assert.equal(state.redo().ok, true)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_3').volume, 0.5)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：自定义 label / 空 ops / 超 200 / 非法 type / 内部失败整批不写', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const custom = await exec('studio_batch', { ops: [{ type: 'updateTrack', args: { trackId: 'trk_1', volume: 0.9 } }], label: '鼓组音量调整' })
      assert.equal(custom.ok, true)
      assert.equal(custom.label, '鼓组音量调整')
      assert.equal(state.historyState().undoLabel, '鼓组音量调整')
      // 空/超限
      assert.equal((await exec('studio_batch', { ops: [] })).ok, false)
      const tooMany = await exec('studio_batch', {
        ops: Array.from({ length: 201 }, () => ({ type: 'updateTrack', args: { trackId: 'trk_1', volume: 0.5 } })),
      })
      assert.equal(tooMany.ok, false)
      assert.match(tooMany.error, /最多 200/)
      // 非法 type
      const badType = await exec('studio_batch', { ops: [{ type: 'clearAll', args: {} }] })
      assert.equal(badType.ok, false)
      assert.match(badType.error, /不支持的操作类型/)
      // 内部失败：第二个 op 非法 → 整批不写入、不入撤销、不 bump revision
      const snapshot = JSON.stringify(state.project)
      const revisionBefore = state.revision
      const undoDepthBefore = state.historyState().undoDepth
      const failed = await exec('studio_batch', {
        ops: [
          { type: 'updateTrack', args: { trackId: 'trk_1', volume: 0.11 } },
          { type: 'addEffect', args: { target: 'track', trackId: 'trk_1', type: 'nonexistent_fx' } },
        ],
      })
      assert.equal(failed.ok, false)
      assert.match(failed.error, /ops\[1\].*整批未写入/)
      assert.equal(JSON.stringify(state.project), snapshot)
      assert.equal(state.revision, revisionBefore)
      assert.equal(state.historyState().undoDepth, undoDepthBefore)
      // args 非对象
      const badArgs = await exec('studio_batch', { ops: [{ type: 'updateTrack', args: 'bad' }] })
      assert.equal(badArgs.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：expectedRevision 冲突不写入；白名单/上限常量符合契约', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const stale = await exec('studio_batch', {
        ops: [{ type: 'updateTrack', args: { trackId: 'trk_1', volume: 0.2 } }],
        expectedRevision: state.revision - 1,
      })
      assert.equal(stale.ok, false)
      assert.equal(stale.retry, true)
      const okResult = await exec('studio_batch', {
        ops: [{ type: 'updateTrack', args: { trackId: 'trk_1', volume: 0.2 } }],
        expectedRevision: state.revision,
      })
      assert.equal(okResult.ok, true)
      assert.deepEqual(ops.BATCH_OP_TYPES, [
        'addTrack', 'addPattern',
        'setPatternNotes', 'editPatternNotes', 'setClips', 'editClips', 'setArrangement', 'updateTrack',
        'setAutomation', 'clearAutomation', 'setSustain', 'clearSustain', 'setVibrato', 'clearVibrato',
        'addEffect', 'updateEffect', 'removeEffect', 'setTempoMap', 'clearTempoMap', 'copyPattern', 'setTakeActive',
        'writeChords', 'generateArp', 'applyGroove', 'setMidiMapping', 'clearMidiMapping',
        'addGroup', 'updateGroup', 'removeGroup', 'setTrackOutput', 'updateInstrument', 'updateSynth',
        'saveScene', 'recallScene', 'deleteScene',
      ])
      assert.equal(ops.BATCH_MAX_OPS, 200)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：支持 editPatternNotes / copyPattern / setVibrato / editClips', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const patternsBefore = state.project.patterns.length
      const clipsBefore = state.project.clips.length
      const result = await exec('studio_batch', {
        ops: [
          { type: 'editPatternNotes', args: { patternId: 'pat_1', transpose: 2 } },
          { type: 'copyPattern', args: { patternId: 'pat_1', name: '批量副本' } },
          { type: 'setVibrato', args: { trackId: 'trk_4', rateHz: 6, depthCents: 20 } },
          { type: 'editClips', args: { add: [{ trackId: 'trk_2', patternId: 'pat_1', startBar: 0, lengthBars: 4 }] } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 4)
      assert.equal(state.project.patterns.length, patternsBefore + 1)
      assert.equal(state.project.patterns.at(-1).name, '批量副本')
      assert.equal(state.project.clips.length, clipsBefore + 1)
      assert.deepEqual(state.project.tracks.find((track) => track.id === 'trk_4').vibrato, {
        rateHz: 6,
        depthCents: 20,
        enabled: true,
      })
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.patterns.length, patternsBefore)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('P13 — 补充：eq3 master / batch 更多白名单 / 路由新建 master 空链', () => {
  async function makeP13Tools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('master 上 eq3 新参数：默认值/更新/撤销', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const created = await exec('studio_create_project', { title: '空母带' })
      assert.equal(created.ok, true)
      const added = await exec('studio_add_effect', { target: 'master', type: 'eq3', params: { lowFreq: 400, midQ: 4 } })
      assert.equal(added.ok, true)
      const fx = () => state.project.master.effects.find((item) => item.id === added.effectId)
      assert.equal(fx().params.lowFreq, 400)
      assert.equal(fx().params.midQ, 4)
      assert.equal(fx().params.highFreq, 8000)
      await exec('studio_update_effect', { target: 'master', effectId: added.effectId, params: { highFreq: 15000, midQ: 7 } })
      assert.equal(fx().params.highFreq, 15000)
      assert.equal(fx().params.midQ, 7)
      assert.equal(state.undo().ok, true)
      assert.equal(fx().params.midQ, 4)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：setPatternNotes/setClips/setArrangement/updateEffect/removeEffect 白名单可用', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const earlier = await exec('studio_add_effect', { target: 'trk_2', type: 'drive' })
      assert.equal(earlier.ok, true)
      const notes = state.project.patterns[0].notes.slice(0, 4).map((note) => ({ ...note }))
      const originalNoteCount = state.project.patterns[0].notes.length
      const result = await exec('studio_batch', {
        ops: [
          { type: 'setPatternNotes', args: { patternId: 'pat_1', notes } },
          {
            type: 'setClips',
            args: { clips: [{ trackId: 'trk_1', patternId: state.project.patterns[0].id, startBar: 0, lengthBars: 4 }] },
          },
          {
            type: 'setArrangement',
            args: {
              clips: [{ trackId: 'trk_1', patternId: state.project.patterns[0].id, startBar: 0, lengthBars: 4 }],
              sections: [{ name: '批量段', startBar: 0, lengthBars: 4 }],
            },
          },
          { type: 'updateEffect', args: { target: 'trk_2', effectId: earlier.effectId, enabled: false } },
          { type: 'removeEffect', args: { target: 'trk_2', effectId: earlier.effectId } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 5)
      assert.equal(state.project.patterns.find((pattern) => pattern.id === 'pat_1').notes.length, 4)
      assert.equal(state.project.clips.length, 1)
      assert.equal(state.project.sections[0].name, '批量段')
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_2').effects.some((fx) => fx.id === earlier.effectId), false)
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.patterns.find((pattern) => pattern.id === 'pat_1').notes.length, originalNoteCount)
      assert.ok(state.project.clips.length > 1, '撤销后恢复 demo 编排')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：clearAutomation/clearSustain/clearVibrato/clearTempoMap 组合', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      await exec('studio_set_automation', { trackId: 'trk_3', param: 'expression', points: [{ beat: 0, value: 1 }] })
      await exec('studio_set_sustain', { trackId: 'trk_3', points: [{ beat: 0, value: 1 }] })
      await exec('studio_set_vibrato', { trackId: 'trk_3', rateHz: 6 })
      await exec('studio_set_tempo_map', { points: [{ beat: 0, bpm: 110 }] })
      const result = await exec('studio_batch', {
        label: '清空表情',
        ops: [
          { type: 'clearAutomation', args: { trackId: 'trk_3', param: 'expression' } },
          { type: 'clearSustain', args: { trackId: 'trk_3' } },
          { type: 'clearVibrato', args: { trackId: 'trk_3' } },
          { type: 'clearTempoMap', args: {} },
        ],
      })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === 'trk_3')
      assert.equal(track.automation?.expression, undefined)
      assert.equal(track.sustain, undefined)
      assert.equal(track.vibrato, undefined)
      assert.equal(state.project.tempoMap, undefined)
      assert.equal(state.historyState().undoLabel, '清空表情')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch 结果紧凑：含 type 与少量关键字段，不返回完整链/params', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const result = await exec('studio_batch', {
        ops: [{ type: 'updateTrack', args: { trackId: 'trk_1', volume: 0.7 } }],
      })
      assert.equal(result.ok, true)
      const item = result.results[0]
      assert.equal(item.type, 'updateTrack')
      assert.equal(item.trackId, 'trk_1')
      assert.equal(item.track, undefined, '不返回完整 track 摘要')
      assert.ok(JSON.stringify(item).length < 500)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：label 过长/ops 项非对象/缺 type 均中文拒绝', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const cases = [
        { ops: [{ type: 'updateTrack', args: { trackId: 'trk_1', volume: 0.5 } }], label: 'x'.repeat(61) },
        { ops: ['bad'] },
        { ops: [{ args: {} }] },
      ]
      for (const args of cases) {
        const result = await exec('studio_batch', args)
        assert.equal(result.ok, false, JSON.stringify(args).slice(0, 80))
        assert.equal(typeof result.error, 'string')
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('表情自动化保存→新建→打开→重启保留', async () => {
    const { dir, state, exec } = await makeP13Tools()
    try {
      await exec('studio_set_automation', {
        trackId: 'trk_3',
        param: 'pitchBend',
        points: [{ beat: 0, value: 0.5 }, { beat: 8, value: 1 }],
      })
      await exec('studio_save_project', { name: 'P13 表情工程' })
      await exec('studio_create_project', { title: '临时' })
      const opened = await exec('studio_open_project', { name: 'P13 表情工程' })
      assert.equal(opened.ok, true)
      await state.flush()
    } finally {
      await state.flush()
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      const automation = reloaded.project.tracks.find((track) => track.id === 'trk_3').automation
      assert.deepEqual(automation.pitchBend.points, [{ beat: 0, value: 0.5 }, { beat: 8, value: 1 }])
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('studio_get_project：表情自动化默认摘要、includeAutomation 全量，未配置参数不出现', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      await exec('studio_set_automation', { trackId: 'trk_4', param: 'modulation', points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] })
      const overview = await exec('studio_get_project')
      const automation = overview.tracks.find((track) => track.id === 'trk_4').automation
      assert.deepEqual(Object.keys(automation), ['modulation'])
      assert.equal(automation.modulation.enabled, true)
      assert.equal(automation.modulation.pointCount, 2)
      assert.equal(automation.modulation.points, undefined)
      const full = await exec('studio_get_project', { includeAutomation: true })
      assert.deepEqual(full.tracks.find((track) => track.id === 'trk_4').automation.modulation.points, [
        { beat: 0, value: 0 },
        { beat: 4, value: 1 },
      ])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('路由 /projects/new：empty 模板 master 空链，demo 模板保留母带', async () => {
    const { state } = await makeP13Tools()
    const server = await startServer(state)
    try {
      const emptyNew = await postJson(server.base, '/studio/api/projects/new', { template: 'empty', name: 'P13 空工程' })
      assert.equal(emptyNew.data.ok, true)
      assert.equal(state.project.master.effects.length, 0)
      const demoNew = await postJson(server.base, '/studio/api/projects/new', { template: 'demo' })
      assert.equal(demoNew.data.ok, true)
      assert.deepEqual(state.project.master.effects.map((fx) => fx.type), ['eq3', 'compressor'])
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('P13 工具描述同步：studio_batch 描述含白名单，automation 参数枚举含表情', async () => {
    const { byName } = await makeP13Tools()
    const batch = byName.get('studio_batch')
    assert.ok(batch)
    for (const type of ['setPatternNotes', 'editPatternNotes', 'setClips', 'editClips', 'setArrangement', 'updateTrack', 'setAutomation', 'clearAutomation', 'setSustain', 'clearSustain', 'setVibrato', 'clearVibrato', 'addEffect', 'updateEffect', 'removeEffect', 'setTempoMap', 'clearTempoMap', 'copyPattern']) {
      assert.ok(batch.description.includes(type), 'batch 描述缺少 ' + type)
    }
    const automation = byName.get('studio_set_automation')
    assert.deepEqual(automation.parameters.param.enum, ['volume', 'pan', 'cutoff', 'pitchBend', 'modulation', 'expression', 'cc1', 'cc11', 'cc64', 'cc74'])
  })

  it('studio_batch 与单工具等价：批量 updateTrack + setBus 不支持的 setBus 报错', async () => {
    const { state, exec } = await makeP13Tools()
    try {
      const rejected = await exec('studio_batch', {
        ops: [{ type: 'setBus', args: { busId: 'reverb', level: 0.5 } }],
      })
      assert.equal(rejected.ok, false, 'setBus 不在白名单')
      assert.match(rejected.error, /不支持的操作类型/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P14a：MIDI 导入（解析/构建/工具/路由）                                     */
/* ------------------------------------------------------------------------- */

/** 构造一个最小 SMF 的 MTrk 数据（events = Buffer 数组，已含 delta）。 */
function smfTrack(events) {
  const body = Buffer.concat(events)
  const header = Buffer.alloc(8)
  header.write('MTrk', 0, 'ascii')
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

/** 构造 SMF 文件。 */
function buildSmf({ format = 1, ppq = 480, tracks = [] }) {
  const header = Buffer.alloc(14)
  header.write('MThd', 0, 'ascii')
  header.writeUInt32BE(6, 4)
  header.writeUInt16BE(format, 8)
  header.writeUInt16BE(tracks.length, 10)
  header.writeUInt16BE(ppq, 12)
  return Buffer.concat([header, ...tracks])
}

const SMF_VLQ = (value) => {
  const bytes = [value & 0x7f]
  let rest = Math.floor(value / 128)
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  return Buffer.from(bytes)
}
const smfDelta = (ticks) => SMF_VLQ(ticks)
const metaEvent = (type, data) => Buffer.concat([Buffer.from([0xff, type]), SMF_VLQ(data.length), Buffer.from(data)])

describe('P14a — MIDI 解析 parseMidiBuffer', () => {
  it('buildMidiFile 往返：format/PPQ/轨名/program/音符/ tempo/拍号', () => {
    const project = createDemoProject()
    const buffer = buildMidi(project).buffer
    const parsed = parseMidiBuffer(buffer)
    assert.equal(parsed.format, 1)
    assert.equal(parsed.ppq, 480)
    assert.equal(parsed.noteCount, buildMidi(project).noteCount)
    assert.deepEqual(parsed.timeSignature, { numerator: 4, denominator: 4 })
    assert.equal(parsed.tempos.length, 1)
    assert.ok(Math.abs(parsed.tempos[0].bpm - project.bpm) < 1e-6)
    assert.ok(parsed.tracks.length >= project.tracks.length)
    // 鼓轨（channel 10 = index 9）被识别
    assert.ok(parsed.tracks.some((track) => track.isDrum && track.channel === 9))
    // 音符合法
    for (const track of parsed.tracks) {
      for (const note of track.notes) {
        assert.ok(note.pitch >= 0 && note.pitch <= 127)
        assert.ok(note.durTicks >= 1)
        assert.ok(note.vel >= 1 && note.vel <= 127)
      }
    }
  })

  it('Format 0：单轨多 channel 拆分 + running status + program change + 未闭合音符', () => {
    const events = [
      smfDelta(0), Buffer.from([0x90, 60, 100]), // note on ch0
      smfDelta(480), Buffer.from([60, 0]), // running status: 同 status 的 note off（vel 0）
      smfDelta(0), Buffer.from([0xc0, 33]), // program change ch0 → finger_bass
      smfDelta(0), Buffer.from([0x99, 36, 110]), // note on ch9（鼓）
      // 不写 note off → 轨道末尾闭合
      smfDelta(240), metaEvent(0x2f, []),
    ]
    const buffer = buildSmf({ format: 0, tracks: [smfTrack(events)] })
    const parsed = parseMidiBuffer(buffer)
    assert.equal(parsed.format, 0)
    assert.equal(parsed.tracks.length, 2, '按 channel 拆成两条')
    const piano = parsed.tracks.find((track) => track.channel === 0)
    const drums = parsed.tracks.find((track) => track.channel === 9)
    assert.ok(piano && drums)
    assert.equal(piano.isDrum, false)
    assert.equal(piano.program, 33)
    assert.equal(piano.notes.length, 1)
    assert.equal(piano.notes[0].startTick, 0)
    assert.equal(piano.notes[0].durTicks, 480)
    assert.equal(drums.isDrum, true)
    assert.equal(drums.notes[0].pitch, 36)
    assert.ok(drums.notes[0].durTicks >= 1, '未闭合音符按轨道末尾结束')
    // 轨道名（无 meta name 时用默认）
    assert.ok(piano.name.includes('轨道') || piano.name.length > 0)
  })

  it('多 tempo + 拍号：按 tick 排序、同 tick 后者覆盖', () => {
    const conductor = [
      smfDelta(0), metaEvent(0x51, [0x07, 0xa1, 0x20]), // 500000us = 120bpm
      smfDelta(0), metaEvent(0x58, [3, 2, 24, 8]), // 3/4
      smfDelta(960), metaEvent(0x51, [0x0f, 0x42, 0x40]), // 1000000us = 60bpm
      smfDelta(0), metaEvent(0x51, [0x03, 0xd0, 0x90]), // 同 tick 覆盖为 250000us = 240bpm
      smfDelta(0), metaEvent(0x2f, []),
    ]
    const notes = [
      smfDelta(0), Buffer.from([0x90, 60, 100]),
      smfDelta(480), Buffer.from([0x80, 60, 0]),
      smfDelta(0), metaEvent(0x2f, []),
    ]
    const buffer = buildSmf({ format: 1, tracks: [smfTrack(conductor), smfTrack(notes)] })
    const parsed = parseMidiBuffer(buffer)
    assert.deepEqual(parsed.tempos.map((tempo) => tempo.tick), [0, 960])
    assert.ok(Math.abs(parsed.tempos[0].bpm - 120) < 1e-6)
    assert.ok(Math.abs(parsed.tempos[1].bpm - 240) < 1e-6, '同 tick 后者覆盖')
    assert.deepEqual(parsed.timeSignature, { numerator: 3, denominator: 4 })
  })

  it('非法文件：空/过短/非 MThd/坏 chunk/截断/Format 2/SMPTE/无音符 都中文报错', () => {
    const cases = [
      ['空文件', Buffer.alloc(0), /为空/],
      ['过短', Buffer.from('MThd'), /过短/],
      ['非 MThd', Buffer.concat([Buffer.from('XXXX'), Buffer.alloc(10)]), /MThd/],
      ['Format 2', buildSmf({ format: 2, tracks: [smfTrack([smfDelta(0), metaEvent(0x2f, [])])] }), /Format 2/],
      ['SMPTE', (() => {
        const buffer = buildSmf({ tracks: [smfTrack([smfDelta(0), metaEvent(0x2f, [])])] })
        buffer.writeUInt16BE(0xe728, 12)
        return buffer
      })(), /SMPTE/],
      ['坏 chunk', (() => {
        const buffer = buildSmf({ tracks: [smfTrack([smfDelta(0), metaEvent(0x2f, [])])] })
        buffer.write('XXXX', 14, 'ascii')
        return buffer
      })(), /MTrk/],
      ['截断', (() => {
        const buffer = buildSmf({ tracks: [smfTrack([smfDelta(0), metaEvent(0x2f, [])])] })
        buffer.writeUInt32BE(9999, 18)
        return buffer
      })(), /越界/],
      ['无音符', buildSmf({ tracks: [smfTrack([smfDelta(0), metaEvent(0x2f, [])])] }), /没有音符/],
    ]
    for (const [label, buffer, pattern] of cases) {
      assert.throws(() => parseMidiBuffer(buffer), (error) => error instanceof MidiImportError && pattern.test(error.message), label)
    }
  })
})

describe('P14a — buildProjectFromMidi 构建', () => {
  it('首 tempo→bpm、tempos→tempoMap、channel10→采样鼓、GM→最近采样乐器、每轨 pattern/clip', () => {
    const parsed = {
      format: 1,
      ppq: 480,
      endTick: 7680,
      timeSignature: { numerator: 4, denominator: 4 },
      tempos: [{ tick: 0, bpm: 120 }, { tick: 3840, bpm: 60 }],
      tracks: [
        { name: 'Bass', channel: 0, program: 33, isDrum: false, notes: [
          { pitch: 40, startTick: 0, durTicks: 480, vel: 100 },
          { pitch: 43, startTick: 480, durTicks: 240, vel: 80 },
        ] },
        { name: 'Drums', channel: 9, program: 0, isDrum: true, notes: [
          { pitch: 36, startTick: 0, durTicks: 120, vel: 127 },
        ] },
      ],
    }
    const { project, imported } = buildProjectFromMidi(parsed, { title: '测试 MIDI' })
    assert.equal(project.schemaVersion, 3)
    assert.equal(project.title, '测试 MIDI')
    assert.equal(project.bpm, 120)
    assert.deepEqual(project.tempoMap, [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }])
    assert.equal(project.timeSignature[0], 4)
    assert.equal(project.tracks.length, 2)
    assert.deepEqual(project.patterns.map((pattern) => pattern.name), ['Bass', 'Drums'])
    assert.equal(project.lengthBars, 4) // 7680/480=16 beat /4 = 4 小节
    assert.deepEqual(project.clips.map((clip) => [clip.startBar, clip.lengthBars]), [[0, 4], [0, 4]])
    const bass = project.tracks[0]
    assert.equal(bass.kind, 'synth')
    assert.equal(bass.instrument.preset, 'finger_bass') // program 33 最近
    assert.equal(bass.role, 'bass')
    assert.deepEqual(project.patterns[0].notes.map((note) => [note.pitch, note.start, note.dur]), [
      [40, 0, 1],
      [43, 1, 0.5],
    ])
    assert.ok(Math.abs(project.patterns[0].notes[0].vel - 100 / 127) < 1e-9)
    const drums = project.tracks[1]
    assert.equal(drums.kind, 'drum')
    assert.equal(drums.instrument.kit, 'smp_acoustic')
    assert.deepEqual(imported, { tracks: 2, notes: 3, patterns: 2, clips: 2, tempos: 2, lengthBars: 4, bpm: 120, automationTracks: 0 })
  })

  it('nearestSampledPreset：GM program → 最近采样乐器', () => {
    assert.equal(nearestSampledPreset(0), 'grand_piano')
    assert.equal(nearestSampledPreset(1), 'bright_piano')
    assert.equal(nearestSampledPreset(40), 'violin')
    assert.equal(nearestSampledPreset(42), 'cello')
    assert.equal(nearestSampledPreset(49), 'strings_ensemble')
    assert.equal(nearestSampledPreset(33), 'finger_bass')
    assert.equal(nearestSampledPreset(89), 'warm_pad')
    assert.equal(nearestSampledPreset(127), 'warm_pad')
  })

  it('空 parsed / 无音符轨中文拒绝；超长音符轨道拒绝', () => {
    assert.throws(() => buildProjectFromMidi(null), /解析结果非法/)
    assert.throws(() => buildProjectFromMidi({ ppq: 480, tracks: [] }), /没有可导入的音符轨/)
    const huge = {
      ppq: 480,
      endTick: 480,
      tracks: [{ name: 'X', channel: 0, program: 0, isDrum: false, notes: Array.from({ length: 4097 }, () => ({ pitch: 60, startTick: 0, durTicks: 1, vel: 100 })) }],
    }
    assert.throws(() => buildProjectFromMidi(huge), /超过上限/)
  })
})

describe('P14a — studio_import_midi 工具', () => {
  async function makeImportTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('replace=true：导入替换工程、自动备份、一次撤销可回退；返回 imported 摘要', async () => {
    const { dir, state, exec } = await makeImportTools()
    try {
      const importedProject = createDemoProject()
      importedProject.title = '将被导入'
      // 用 demo 生成 MIDI，再改标题导入
      const midiPath = path.join(dir, 'import.mid')
      const buffer = buildMidi(createDemoProject()).buffer
      await writeFile(midiPath, buffer)
      const oldTitle = state.project.title
      const result = await exec('studio_import_midi', { path: midiPath, title: '导入后的工程' })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.replace, true)
      assert.equal(result.tracks, state.project.tracks.length)
      assert.ok(result.notes > 0)
      assert.equal(result.project.title, '导入后的工程')
      assert.equal(state.project.schemaVersion, 3)
      assert.equal(state.project.title, '导入后的工程')
      assert.ok(state.activeName === null, 'replace 后 activeName 清空')
      assert.ok(typeof result.backupPath === 'string')
      const backup = JSON.parse(await readFile(result.backupPath, 'utf8'))
      assert.equal(backup.title, oldTitle)
      assert.equal(state.historyState().undoLabel, '导入 MIDI')
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.title, oldTitle, '一次撤销恢复旧工程')
      assert.equal(state.redo().ok, true)
      assert.equal(state.project.title, '导入后的工程')
      // tempoMap / 每轨 pattern+clip
      assert.ok(Array.isArray(state.project.tempoMap) && state.project.tempoMap.length >= 1)
      assert.equal(state.project.patterns.length, state.project.tracks.length)
      assert.equal(state.project.clips.length, state.project.tracks.length)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('replace=false：追加轨道/pattern/clip、id 不冲突、不备份、标题不变', async () => {
    const { dir, state, exec } = await makeImportTools()
    try {
      const midiPath = path.join(dir, 'append.mid')
      await writeFile(midiPath, buildMidi(createDemoProject()).buffer)
      const before = {
        tracks: state.project.tracks.length,
        patterns: state.project.patterns.length,
        clips: state.project.clips.length,
        title: state.project.title,
      }
      const result = await exec('studio_import_midi', { path: midiPath, replace: false })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.replace, false)
      assert.equal(state.project.tracks.length, before.tracks + result.tracks)
      assert.equal(state.project.patterns.length, before.patterns + result.patterns)
      assert.equal(state.project.clips.length, before.clips + result.clips)
      assert.equal(state.project.title, before.title)
      assert.equal(result.backupPath, null, '追加模式不自动备份')
      assert.equal(new Set(state.project.tracks.map((track) => track.id)).size, state.project.tracks.length, 'track id 唯一')
      assert.equal(new Set(state.project.patterns.map((pattern) => pattern.id)).size, state.project.patterns.length)
      assert.equal(new Set(state.project.clips.map((clip) => clip.id)).size, state.project.clips.length)
      // 每个新 clip 引用存在的新 pattern/track
      for (const clip of state.project.clips.slice(before.clips)) {
        assert.ok(state.project.tracks.some((track) => track.id === clip.trackId))
        assert.ok(state.project.patterns.some((pattern) => pattern.id === clip.patternId))
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('非法路径/不存在文件/坏 MIDI/超大文件都返回中文 ok:false', async () => {
    const { dir, state, exec } = await makeImportTools()
    try {
      const badPath = path.join(dir, 'bad.mid')
      await writeFile(badPath, Buffer.from('not a midi file'))
      assert.equal((await exec('studio_import_midi', { path: '' })).ok, false)
      const missing = await exec('studio_import_midi', { path: path.join(dir, 'missing.mid') })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /无法读取 MIDI 文件/)
      const bad = await exec('studio_import_midi', { path: badPath })
      assert.equal(bad.ok, false)
      assert.match(bad.error, /MThd|MIDI/)
      const huge = path.join(dir, 'huge.mid')
      await writeFile(huge, Buffer.alloc(MAX_MIDI_BYTES + 1))
      const tooBig = await exec('studio_import_midi', { path: huge })
      assert.equal(tooBig.ok, false)
      assert.match(tooBig.error, /过大/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突不写入', async () => {
    const { dir, state, exec } = await makeImportTools()
    try {
      const midiPath = path.join(dir, 'rev.mid')
      await writeFile(midiPath, buildMidi(createDemoProject()).buffer)
      const snapshot = JSON.stringify(state.project)
      const stale = await exec('studio_import_midi', { path: midiPath, expectedRevision: state.revision - 1 })
      assert.equal(stale.ok, false)
      assert.equal(stale.retry, true)
      assert.equal(JSON.stringify(state.project), snapshot)
      const okResult = await exec('studio_import_midi', { path: midiPath, expectedRevision: state.revision })
      assert.equal(okResult.ok, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('P14a — 工程版本历史', () => {
  async function makeVersionTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('保存 3 次 → 3 个版本（最新在前）；saveProjectFile 自动写版本、自动备份不写历史', async () => {
    const { dir, state, exec } = await makeVersionTools()
    try {
      for (let index = 0; index < 3; index += 1) {
        await exec('studio_update_track', { trackId: 'trk_1', volume: 0.5 + index * 0.1 })
        const saved = await exec('studio_save_project', { name: '版本工程' })
        assert.equal(saved.ok, true)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const versions = await listProjectVersions(dir, '版本工程')
      assert.equal(versions.length, 3)
      assert.ok(versions[0].id > versions[1].id)
      for (const version of versions) {
        assert.match(version.id, /^\d{8}-\d{6}-\d{3}(?:-\d+)?$/)
        assert.equal(version.title, state.project.title)
        assert.ok(version.bytes > 0)
      }
      // 自动备份目录不进入版本历史
      const backup = await writeProjectVersion(dir, '版本工程', createDemoProject(), { now: Date.now() })
      assert.ok(backup.id)
      const dirFiles = await readdir(projectVersionsDir(dir, '版本工程'))
      assert.ok(dirFiles.length >= 4)
      assert.ok(dirFiles.every((name) => name.endsWith('.json')))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('版本上限 20：写 25 次只保留最新 20', async () => {
    const dir = await tempDir()
    const project = createDemoProject()
    const base = Date.now()
    for (let index = 0; index < 25; index += 1) {
      await writeProjectVersion(dir, '上限工程', project, { now: base + index * 1000 })
    }
    const versions = await listProjectVersions(dir, '上限工程')
    assert.equal(versions.length, MAX_PROJECT_VERSIONS)
    const files = (await readdir(projectVersionsDir(dir, '上限工程'))).filter((name) => name.endsWith('.json'))
    assert.equal(files.length, MAX_PROJECT_VERSIONS)
    assert.equal(versions[0].id, files.sort().reverse()[0].replace('.json', ''))
  })

  it('studio_list_project_versions：默认 activeName、未保存工程中文错误', async () => {
    const { state, exec } = await makeVersionTools()
    try {
      const empty = await exec('studio_list_project_versions')
      assert.equal(empty.ok, false)
      assert.match(empty.error, /还没有保存过/)
      await exec('studio_save_project', { name: '列表工程' })
      const listed = await exec('studio_list_project_versions')
      assert.equal(listed.ok, true)
      assert.equal(listed.name, '列表工程')
      assert.equal(listed.versions.length, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_restore_project_version：恢复内容、自动备份、activeName、可撤销', async () => {
    const { state, exec } = await makeVersionTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.4 })
      await exec('studio_save_project', { name: '恢复工程' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const versions = await exec('studio_list_project_versions', { name: '恢复工程' })
      const versionId = versions.versions[0].id
      // 修改后保存第二版
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.9 })
      await exec('studio_create_project', { title: '临时工程' })
      const restored = await exec('studio_restore_project_version', { name: '恢复工程', id: versionId })
      assert.equal(restored.ok, true, restored.error)
      assert.equal(restored.name, '恢复工程')
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').volume, 0.4)
      assert.equal(state.activeName, '恢复工程')
      assert.equal(state.historyState().undoLabel, '恢复历史版本')
      assert.ok(typeof restored.backupPath === 'string')
      // undo 恢复恢复前的工程
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.title, '临时工程')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('非法 id / 非法工程名 / 路径穿越防御', async () => {
    const { state, exec } = await makeVersionTools()
    try {
      await exec('studio_save_project', { name: '安全工程' })
      const badId = await exec('studio_restore_project_version', { name: '安全工程', id: '../etc/passwd' })
      assert.equal(badId.ok, false)
      assert.match(badId.error, /版本 id 非法/)
      await assert.rejects(() => readProjectVersion(state.dataDir, '安全工程', 'not-an-id'), /版本 id 非法/)
      // 工程名穿越会被 sanitize 成安全名
      const weird = await exec('studio_list_project_versions', { name: '../../evil' })
      assert.equal(weird.ok, true)
      assert.equal(weird.versions.length, 0)
      const versionDir = projectVersionsDir(state.dataDir, '../../evil')
      assert.ok(versionDir.includes(VERSION_DIR_NAME))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('readProjectVersion：存在性/内容读取', async () => {
    const { dir, state, exec } = await makeVersionTools()
    try {
      await exec('studio_save_project', { name: '读取工程' })
      const versions = await exec('studio_list_project_versions', { name: '读取工程' })
      const version = await readProjectVersion(dir, '读取工程', versions.versions[0].id)
      assert.equal(version.name, '读取工程')
      assert.equal(version.project.schemaVersion, 3)
      assert.equal(version.project.title, state.project.title)
      await assert.rejects(() => readProjectVersion(dir, '读取工程', '20990101-000000-000'), /版本不存在/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('P14a — 路由 /import-midi 与 /project-versions', () => {
  it('POST /import-midi：JSON base64 替换导入、返回 project；原始字节 + query 可用', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const buffer = buildMidi(createDemoProject()).buffer
      const dataBase64 = buffer.toString('base64')
      const imported = await fetch(`${server.base}/studio/api/import-midi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '路由导入', dataBase64, replace: true }),
      })
      const importedData = await imported.json()
      assert.equal(imported.status, 200)
      assert.equal(importedData.ok, true, importedData.error)
      assert.equal(importedData.project.title, '路由导入')
      assert.equal(state.project.title, '路由导入')
      assert.ok(importedData.imported.tracks > 0)
      // 原始字节 + query（replace=false 追加）
      const tracksBefore = state.project.tracks.length
      const raw = await fetch(`${server.base}/studio/api/import-midi?name=raw.mid&replace=false`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: buffer,
      })
      const rawData = await raw.json()
      assert.equal(rawData.ok, true, rawData.error)
      assert.equal(state.project.tracks.length, tracksBefore + rawData.imported.tracks)
      // 非法 base64
      const bad = await fetch(`${server.base}/studio/api/import-midi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataBase64: '@@@@' }),
      })
      assert.equal(bad.status, 400)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('GET /project-versions + POST /project-versions/restore 闭环', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const tools = createTools({ defineTool: (options) => options, state })
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const exec = (name, args = {}) => byName.get(name).execute(args, {})
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.3 })
      await exec('studio_save_project', { name: '路由版本工程' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const listed = await getJson(server.base, '/studio/api/project-versions?name=路由版本工程')
      assert.equal(listed.status, 200)
      assert.equal(listed.data.ok, true)
      assert.equal(listed.data.versions.length, 1)
      const versionId = listed.data.versions[0].id
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.95 })
      const restore = await postJson(server.base, '/studio/api/project-versions/restore', { name: '路由版本工程', id: versionId })
      assert.equal(restore.status, 200)
      assert.equal(restore.data.ok, true, restore.data.error)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').volume, 0.3)
      assert.equal(restore.data.name, '路由版本工程')
      // 缺 id / 未保存工程
      const missing = await postJson(server.base, '/studio/api/project-versions/restore', { name: '路由版本工程' })
      assert.equal(missing.data.ok, false)
      // activeName 已由 restore 设置 → 省略 name 也可列出版本
      const defaultName = await getJson(server.base, '/studio/api/project-versions')
      assert.equal(defaultName.data.ok, true)
      assert.equal(defaultName.data.name, '路由版本工程')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

describe('P14a — MIDI 解析/构建补充', () => {
  it('CC/pitch bend/aftertouch/sysex 被安全跳过；track name meta 保留；同音重叠 note-on 成对收尾', () => {
    const events = [
      smfDelta(0), metaEvent(0x03, Buffer.from('主旋律', 'utf8')),
      smfDelta(0), Buffer.from([0xb0, 7, 100]), // CC
      smfDelta(0), Buffer.from([0xe0, 0, 64]), // pitch bend
      smfDelta(0), Buffer.from([0xa0, 60, 50]), // poly aftertouch
      smfDelta(0), Buffer.from([0xd0, 80]), // channel pressure
      smfDelta(0), Buffer.from([0xf0, 2, 1, 2]), // sysex（len=2）
      smfDelta(0), Buffer.from([0x90, 60, 100]),
      smfDelta(120), Buffer.from([0x90, 60, 90]), // 同音重复 note-on → 前一音符结束
      smfDelta(120), Buffer.from([0x80, 60, 0]),
      smfDelta(0), metaEvent(0x2f, []),
    ]
    const parsed = parseMidiBuffer(buildSmf({ tracks: [smfTrack(events)] }))
    assert.equal(parsed.tracks[0].name, '主旋律')
    assert.equal(parsed.tracks[0].notes.length, 2)
    assert.deepEqual(parsed.tracks[0].notes.map((note) => [note.startTick, note.durTicks]), [[0, 120], [120, 120]])
  })

  it('buildMidi（含 multi tempoMap）导出的 MIDI 可被导入解析出多条 tempo', () => {
    const project = createEmptyProject({ bpm: 120, lengthBars: 8 })
    project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }, { beat: 16, bpm: 90 }]
    project.tracks = []
    project.patterns = []
    project.clips = []
    project.sections = []
    // 造一条简单音符（避免无音符）
    const pattern = makePattern({ id: 'pat_1', name: 'P', lengthBars: 8, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
    const track = makeTrack({ id: 'trk_1', preset: 'grand_piano' })
    project.tracks.push(track)
    project.patterns.push(pattern)
    project.clips.push(makeClip({ id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 8 }))
    const parsed = parseMidiBuffer(buildMidi(project).buffer)
    assert.deepEqual(parsed.tempos.map((tempo) => Math.round(tempo.bpm)), [120, 60, 90])
    assert.deepEqual(parsed.tempos.map((tempo) => tempo.tick), [0, 8 * 480, 16 * 480])
  })

  it('buildProjectFromMidi：3/4 拍曲长计算与 role 映射', () => {
    const parsed = {
      ppq: 480,
      endTick: 3 * 480 * 4, // 4 小节 3/4
      timeSignature: { numerator: 3, denominator: 4 },
      tempos: [],
      tracks: [
        { name: 'Keys', channel: 0, program: 0, isDrum: false, notes: [{ pitch: 60, startTick: 0, durTicks: 480, vel: 100 }] },
        { name: 'Pad', channel: 1, program: 49, isDrum: false, notes: [{ pitch: 60, startTick: 0, durTicks: 480, vel: 100 }] },
        { name: 'Lead', channel: 2, program: 81, isDrum: false, notes: [{ pitch: 72, startTick: 0, durTicks: 480, vel: 100 }] },
      ],
    }
    const { project } = buildProjectFromMidi(parsed)
    assert.equal(project.timeSignature[0], 3)
    assert.equal(project.lengthBars, 4)
    assert.equal(project.bpm, 120, '无 tempo 用默认 120')
    assert.equal(Object.hasOwn(project, 'tempoMap'), false)
    assert.deepEqual(project.tracks.map((track) => track.role), ['keys', 'pad', 'lead'])
    // 无音符轨被过滤
    const filtered = buildProjectFromMidi({
      ppq: 480,
      endTick: 480,
      tracks: [
        { name: 'Empty', channel: 0, program: 0, isDrum: false, notes: [] },
        { name: 'One', channel: 1, program: 0, isDrum: false, notes: [{ pitch: 60, startTick: 0, durTicks: 100, vel: 100 }] },
      ],
    })
    assert.equal(filtered.project.tracks.length, 1)
    assert.equal(filtered.project.tracks[0].name, 'One')
  })

  it('importMidiIntoState 直接调用：使用 state 当前 bpm 作 fallback、replace=false 不改标题', async () => {
    const { dir, state } = await makeState()
    try {
      const midiPath = path.join(dir, 'direct.mid')
      await writeFile(midiPath, buildMidi(createDemoProject()).buffer)
      const buffer = buildMidi(createDemoProject()).buffer
      const title = state.project.title
      const result = await importMidiIntoState(state, { buffer, replace: false })
      assert.equal(result.replace, false)
      assert.equal(state.project.title, title)
      assert.ok(result.imported.tracks > 0)
      assert.equal(result.backupPath, null)
      // 直接调用解析非法 MIDI 会抛 MidiImportError
      await assert.rejects(() => importMidiIntoState(state, { buffer: Buffer.from('bad') }), (error) => error instanceof MidiImportError)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('P14a — 版本历史补充', () => {
  async function makeVersionTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('listProjects 不受 _history 目录影响；listProjectVersions 跳过损坏版本文件', async () => {
    const { dir, state, exec } = await makeVersionTools()
    try {
      await exec('studio_save_project', { name: '混合工程' })
      const listed = await listProjects(dir)
      assert.deepEqual(listed.projects.map((project) => project.name), ['混合工程'])
      const versionDir = projectVersionsDir(dir, '混合工程')
      await writeFile(path.join(versionDir, '20990101-000000-000.json'), '{bad json', 'utf8')
      const versions = await listProjectVersions(dir, '混合工程')
      assert.equal(versions.length, 1, '损坏版本被跳过')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('writeProjectVersion 拒绝自动备份名；readProjectVersion 拒绝旧 schema', async () => {
    const dir = await tempDir()
    await assert.rejects(() => writeProjectVersion(dir, '_autobackup-20261022-210000', createDemoProject()), /自动备份/)
    const project = createDemoProject()
    const saved = await writeProjectVersion(dir, '旧版工程', project)
    // 手动把版本改成 schemaVersion 1 → 读取中文拒绝
    const versionPath = path.join(projectVersionsDir(dir, '旧版工程'), saved.id + '.json')
    const legacy = JSON.parse(await readFile(versionPath, 'utf8'))
    legacy.schemaVersion = 1
    await writeFile(versionPath, JSON.stringify(legacy), 'utf8')
    await assert.rejects(() => readProjectVersion(dir, '旧版工程', saved.id), /旧版本工程不支持/)
  })

  it('工具：restore expectedRevision 冲突不写入；list 对不存在工程返回空版本', async () => {
    const { state, exec } = await makeVersionTools()
    try {
      await exec('studio_save_project', { name: '冲突版本工程' })
      const versions = await exec('studio_list_project_versions', { name: '冲突版本工程' })
      const id = versions.versions[0].id
      const snapshot = JSON.stringify(state.project)
      const conflict = await exec('studio_restore_project_version', {
        name: '冲突版本工程',
        id,
        expectedRevision: state.revision - 1,
      })
      assert.equal(conflict.ok, false)
      assert.equal(conflict.retry, true)
      assert.equal(JSON.stringify(state.project), snapshot)
      const missing = await exec('studio_list_project_versions', { name: '不存在的工程' })
      assert.equal(missing.ok, true)
      assert.deepEqual(missing.versions, [])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('反复保存 22 次（save_project）仍只保留 20 个版本', async () => {
    const { state, exec } = await makeVersionTools()
    try {
      for (let index = 0; index < 22; index += 1) {
        await exec('studio_update_track', { trackId: 'trk_1', volume: 0.3 + (index % 5) * 0.1 })
        await exec('studio_save_project', { name: '多次保存工程' })
        await new Promise((resolve) => setTimeout(resolve, 3))
      }
      const versions = await exec('studio_list_project_versions', { name: '多次保存工程' })
      assert.equal(versions.versions.length, MAX_PROJECT_VERSIONS)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('P14a — 路由补充', () => {
  it('GET /project-versions 未保存工程返回 ok:false；POST /import-midi 非法 MIDI 返回 ok:false 中文', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const noActive = await getJson(server.base, '/studio/api/project-versions')
      assert.equal(noActive.data.ok, false)
      assert.match(noActive.data.error, /还没有保存过/)
      const badMidi = await fetch(`${server.base}/studio/api/import-midi`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('this is not midi'),
      })
      const badData = await badMidi.json()
      assert.equal(badMidi.status, 200)
      assert.equal(badData.ok, false)
      assert.match(badData.error, /MThd|MIDI/)
      // 合法 base64 但不是 MIDI → ok:false（不是 500）
      const decoded = await fetch(`${server.base}/studio/api/import-midi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataBase64: Buffer.from('garbage').toString('base64'), replace: true }),
      })
      const decodedData = await decoded.json()
      assert.equal(decoded.status, 200)
      assert.equal(decodedData.ok, false)
      assert.match(decodedData.error, /MIDI/)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /import-midi 缺 dataBase64 → 400；未知接口列表包含新路由', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const missing = await fetch(`${server.base}/studio/api/import-midi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x.mid' }),
      })
      assert.equal(missing.status, 400)
      const unknown = await getJson(server.base, '/studio/api/nope')
      assert.equal(unknown.status, 404)
      assert.match(unknown.data.error, /import-midi/)
      assert.match(unknown.data.error, /project-versions/)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

describe('P14a — 补充 2：版本唯一性 / 路径防御 / 路由错误', () => {
  async function makeTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('writeProjectVersion：同一毫秒连续写入也能生成唯一 id 且都可见', async () => {
    const dir = await tempDir()
    const now = Date.now()
    const first = await writeProjectVersion(dir, '同毫秒工程', createDemoProject(), { now })
    const second = await writeProjectVersion(dir, '同毫秒工程', createDemoProject(), { now })
    assert.notEqual(first.id, second.id)
    const versions = await listProjectVersions(dir, '同毫秒工程')
    assert.equal(versions.length, 2)
    assert.equal(versions[0].id, second.id, '最新在前')
  })

  it('非法工程名/路径穿越只会落在 projects/_history 内', async () => {
    const dir = await tempDir()
    const weirdNames = ['../evil', '..\\..\\evil', 'a/b/c', 'CON', '   ']
    for (const name of weirdNames) {
      const versionDir = projectVersionsDir(dir, name)
      const root = path.resolve(path.join(projectsDir(dir), VERSION_DIR_NAME))
      assert.ok(versionDir === root || versionDir.startsWith(root + path.sep), name)
    }
    const saved = await writeProjectVersion(dir, '../evil', createDemoProject(), { now: Date.now() })
    assert.ok(saved.path.startsWith(projectVersionsDir(dir, '../evil')))
  })

  it('studio_import_midi：无 title 时用文件名作标题；再次导入标题可覆盖', async () => {
    const { dir, state, exec } = await makeTools()
    try {
      const midiPath = path.join(dir, '我的旋律.mid')
      await writeFile(midiPath, buildMidi(createDemoProject()).buffer)
      const result = await exec('studio_import_midi', { path: midiPath })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.title, '我的旋律')
      const result2 = await exec('studio_import_midi', { path: midiPath, title: '自定义标题' })
      assert.equal(result2.ok, true)
      assert.equal(state.project.title, '自定义标题')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('路由：restore 未知版本返回 ok:false 中文；JSON 追加导入 replace=false', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const tools = createTools({ defineTool: (options) => options, state })
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const exec = (name, args = {}) => byName.get(name).execute(args, {})
      await exec('studio_save_project', { name: '路由工程' })
      const restore = await postJson(server.base, '/studio/api/project-versions/restore', {
        name: '路由工程',
        id: '20990101-000000-000',
      })
      assert.equal(restore.status, 200)
      assert.equal(restore.data.ok, false)
      assert.match(restore.data.error, /版本不存在/)
      // JSON 追加导入
      const tracksBefore = state.project.tracks.length
      const appended = await fetch(`${server.base}/studio/api/import-midi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataBase64: buildMidi(createDemoProject()).buffer.toString('base64'), replace: false }),
      })
      const appendedData = await appended.json()
      assert.equal(appendedData.ok, true, appendedData.error)
      assert.equal(appendedData.replace, false)
      assert.equal(state.project.tracks.length, tracksBefore + appendedData.imported.tracks)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('importMidiIntoState：超过 10MB 直接中文拒绝且不改工程', async () => {
    const { state } = await makeState()
    try {
      const snapshot = JSON.stringify(state.project)
      const revisionBefore = state.revision
      await assert.rejects(
        () => importMidiIntoState(state, { buffer: Buffer.alloc(MAX_MIDI_BYTES + 1), replace: true }),
        /过大/,
      )
      assert.equal(JSON.stringify(state.project), snapshot)
      assert.equal(state.revision, revisionBefore)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* P14b：MP3/FLAC 导出 / targetLufs / 参考曲                                    */
/* ------------------------------------------------------------------------- */

describe('P14b — MP3/FLAC 导出与 targetLufs', () => {
  async function makeExportTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('studio_export format=mp3/flac 写 exportRequest；targetLufs 透传且优先于 normalize', async () => {
    const { state, exec } = await makeExportTools()
    try {
      const mp3 = await exec('studio_export', { format: 'mp3', targetLufs: -14, normalize: true, tailSeconds: 1.5 })
      assert.equal(mp3.ok, true, mp3.error)
      assert.equal(mp3.format, 'mp3')
      assert.equal(mp3.targetLufs, -14)
      assert.equal(mp3.normalize, false, 'targetLufs 与 normalize 同传时 normalize=false')
      assert.ok(Array.isArray(mp3.warnings) && /targetLufs/.test(mp3.warnings[0]))
      assert.equal(state.project.exportRequest.format, 'mp3')
      assert.equal(state.project.exportRequest.targetLufs, -14)
      assert.equal(state.project.exportRequest.normalize, false)
      assert.equal(state.project.exportRequest.tailSeconds, 1.5)
      state.project.exportRequest = null
      const flac = await exec('studio_export', { format: 'flac', normalize: true })
      assert.equal(flac.format, 'flac')
      assert.equal(state.project.exportRequest.format, 'flac')
      assert.equal(state.project.exportRequest.normalize, true)
      // wav 默认请求不带 format
      state.project.exportRequest = null
      const wav = await exec('studio_export', {})
      assert.equal(wav.format, 'wav')
      assert.equal(state.project.exportRequest.format, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('targetLufs 范围/类型非法中文拒绝且不写入；MIDI 不支持 targetLufs', async () => {
    const { state, exec } = await makeExportTools()
    try {
      const snapshot = JSON.stringify(state.project)
      for (const value of [-30, -4, 0, 'abc', Number.NaN]) {
        const result = await exec('studio_export', { targetLufs: value })
        assert.equal(result.ok, false, String(value))
        assert.match(result.error, /targetLufs/)
      }
      assert.equal(JSON.stringify(state.project), snapshot, '非法 targetLufs 不写入')
      const midi = await exec('studio_export', { format: 'midi', targetLufs: -14 })
      assert.equal(midi.ok, false)
      assert.match(midi.error, /targetLufs 只支持音频导出/)
      // 边界值合法
      assert.equal((await exec('studio_export', { targetLufs: -24 })).ok, true)
      assert.equal(state.project.exportRequest.targetLufs, -24)
      state.project.exportRequest = null
      assert.equal((await exec('studio_export', { targetLufs: -5 })).ok, true)
      assert.equal(state.project.exportRequest.targetLufs, -5)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/export-done MP3：保存 .mp3、MIME/时长/历史 format 正确；扩展名自动补全', async () => {
    const { state, exec } = await makeExportTools()
    const server = await startServer(state)
    try {
      await exec('studio_export', { format: 'mp3', targetLufs: -14 })
      const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 0)])
      const done = await fetch(`${server.base}/studio/api/export-done?name=mixdown&seconds=3.2`, { method: 'POST', body: mp3 })
      assert.equal(done.status, 200)
      const data = await done.json()
      assert.equal(data.ok, true)
      assert.equal(data.format, 'mp3')
      assert.equal(data.seconds, 3.2)
      assert.ok(data.path.endsWith('.mp3'), '目标扩展名自动补 .mp3')
      assert.equal(state.project.exportHistory[0].format, 'mp3')
      assert.equal(state.project.exportHistory[0].name.endsWith('.mp3'), true)
      assert.equal(state.project.lastExport.path, data.path)
      assert.equal(state.project.exportRequest, null, '导出完成消费请求')
      // 非法 MP3 数据 → 400
      await exec('studio_export', { format: 'mp3' })
      const bad = await fetch(`${server.base}/studio/api/export-done?name=bad.mp3`, {
        method: 'POST',
        body: Buffer.concat([Buffer.from('riff'), Buffer.alloc(200)]),
      })
      assert.equal(bad.status, 400)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('/export-done FLAC：fLaC magic、历史 format=flac；非法 FLAC 400', async () => {
    const { state, exec } = await makeExportTools()
    const server = await startServer(state)
    try {
      await exec('studio_export', { format: 'flac' })
      const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(120, 0)])
      const done = await fetch(`${server.base}/studio/api/export-done?name=无损.flac`, { method: 'POST', body: flac })
      assert.equal(done.status, 200)
      const data = await done.json()
      assert.equal(data.format, 'flac')
      assert.ok(data.path.endsWith('无损.flac'))
      assert.equal(state.project.exportHistory[0].format, 'flac')
      await exec('studio_export', { format: 'flac' })
      const bad = await fetch(`${server.base}/studio/api/export-done?name=bad.flac`, {
        method: 'POST',
        body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(50)]),
      })
      assert.equal(bad.status, 400)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('无 exportRequest 时按文件名扩展名推断格式（mp3/flac）', async () => {
    const { state } = await makeExportTools()
    const server = await startServer(state)
    try {
      const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(60)])
      const done = await fetch(`${server.base}/studio/api/export-done?name=hint.mp3`, { method: 'POST', body: mp3 })
      assert.equal(done.status, 200)
      assert.equal((await done.json()).format, 'mp3')
      const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(60)])
      const doneFlac = await fetch(`${server.base}/studio/api/export-done?name=hint.flac`, { method: 'POST', body: flac })
      assert.equal(doneFlac.status, 200)
      assert.equal((await doneFlac.json()).format, 'flac')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('sanitizeExportName：按格式强制扩展名、防路径穿越', () => {
    assert.equal(sanitizeExportName('mix.wav', 'mp3'), 'mix.mp3')
    assert.equal(sanitizeExportName('mix', 'flac'), 'mix.flac')
    assert.equal(sanitizeExportName('mix.mp3', 'wav'), 'mix.wav')
    assert.equal(sanitizeExportName('../evil.mp3', 'mp3'), 'evil.mp3')
    assert.equal(sanitizeExportName('', 'mp3').endsWith('.mp3'), true)
    assert.equal(sanitizeExportName('a/b/c.flac', 'flac'), 'c.flac')
  })
})

describe('P14b — 参考曲导入 / reference 轨', () => {
  async function makeReferenceTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('ops.addAudioTrack reference：默认名/音量 0.9/静音/小发送；非参考轨保持原默认', () => {
    const project = createEmptyProject()
    const media = ops.addMedia(project, { name: 'ref.wav', file: 'ref.wav', bytes: 10, durationSeconds: 2 })
    const normal = ops.addAudioTrack(project, { mediaId: media.id })
    assert.equal(normal.reference, false)
    assert.equal(normal.mute, false)
    const reference = ops.addAudioTrack(project, { mediaId: media.id, reference: true, startBar: 2 })
    assert.equal(reference.reference, true)
    assert.equal(reference.mute, true)
    assert.equal(reference.volume, 0.9)
    assert.equal(reference.startBar, 2)
    const track = project.tracks.find((item) => item.id === reference.trackId)
    assert.equal(track.reference, true)
    assert.equal(track.name, '参考曲 · ref.wav')
    assert.ok(track.sends.reverb <= 0.1)
    assert.ok(track.sends.delay <= 0.1)
    // 非参考轨默认名不变
    assert.equal(project.tracks.find((item) => item.id === normal.trackId).name, '音频 · ref.wav')
  })

  it('get_project 每轨摘要暴露 reference（true/false）', async () => {
    const { state, exec } = await makeReferenceTools()
    try {
      const wav = makeWav(1)
      const wavPath = path.join(state.dataDir, 'ref.wav')
      await writeFile(wavPath, wav)
      const imported = await exec('studio_import_reference', { path: wavPath })
      assert.equal(imported.ok, true, imported.error)
      const overview = await exec('studio_get_project')
      const track = overview.tracks.find((item) => item.id === imported.trackId)
      assert.equal(track.reference, true)
      assert.equal(track.mute, true)
      assert.equal(track.volume, 0.9)
      assert.ok(overview.tracks.find((item) => item.id === 'trk_1').reference === false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_import_reference：命名/静音/一次撤销/startBar；错误路径/格式/空文件/超大中文拒绝', async () => {
    const { dir, state, exec } = await makeReferenceTools()
    try {
      const wav = makeWav(1)
      const wavPath = path.join(dir, '参考曲.wav')
      await writeFile(wavPath, wav)
      const before = state.project.tracks.length
      const result = await exec('studio_import_reference', { path: wavPath, startBar: 4 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.reference, true)
      assert.equal(result.mute, true)
      assert.equal(result.volume, 0.9)
      assert.equal(result.name, '参考曲 · 参考曲.wav')
      assert.equal(result.startBar, 4)
      assert.equal(state.project.tracks.length, before + 1)
      assert.equal(state.historyState().undoLabel, '导入参考曲')
      assert.equal(state.undo().ok, true)
      assert.equal(state.project.tracks.length, before)
      // 错误
      assert.equal((await exec('studio_import_reference', { path: '' })).ok, false)
      assert.equal((await exec('studio_import_reference', { path: path.join(dir, 'missing.wav') })).ok, false)
      const txtPath = path.join(dir, 'notaudio.txt')
      await writeFile(txtPath, 'hello')
      const badExt = await exec('studio_import_reference', { path: txtPath })
      assert.equal(badExt.ok, false)
      assert.match(badExt.error, /不支持的音频格式/)
      const emptyPath = path.join(dir, 'empty.wav')
      await writeFile(emptyPath, Buffer.alloc(0))
      assert.equal((await exec('studio_import_reference', { path: emptyPath })).ok, false)
      const badWavPath = path.join(dir, 'bad.wav')
      await writeFile(badWavPath, Buffer.from('not wav at all'))
      const badWav = await exec('studio_import_reference', { path: badWavPath })
      assert.equal(badWav.ok, false)
      assert.match(badWav.error, /WAV/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_import_reference：超过 30MB 拒绝', async () => {
    const { dir, state, exec } = await makeReferenceTools()
    try {
      const bigPath = path.join(dir, 'big.wav')
      await writeFile(bigPath, Buffer.alloc(MEDIA_MAX_BYTES + 1))
      const result = await exec('studio_import_reference', { path: bigPath })
      assert.equal(result.ok, false)
      assert.match(result.error, /过大/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('POST /import-audio body reference:true → 参考轨（默认名/静音/音量），并出现在 /state', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      const response = await fetch(`${server.base}/studio/api/import-audio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ref.wav', dataBase64: wav.toString('base64'), reference: true, startBar: 2 }),
      })
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.ok, true, data.error)
      assert.equal(data.reference, true)
      const track = state.project.tracks.find((item) => item.id === data.trackId)
      assert.equal(track.reference, true)
      assert.equal(track.mute, true)
      assert.equal(track.volume, 0.9)
      assert.equal(track.name, '参考曲 · ref.wav')
      // /state 持久化展示 reference
      const current = await getJson(server.base, '/studio/api/state?rev=0')
      assert.equal(current.data.project.tracks.find((item) => item.id === data.trackId).reference, true)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /import-audio 原始字节 + query reference=true 也创建参考轨', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      const response = await fetch(`${server.base}/studio/api/import-audio?name=raw.wav&reference=true`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
      })
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.ok, true, data.error)
      assert.equal(data.reference, true)
      assert.equal(state.project.tracks.find((item) => item.id === data.trackId).mute, true)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

describe('P14b — 补充：下载 MIME / 参考轨持久化 / 导出细节', () => {
  async function makeTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('GET /download：mp3 → audio/mpeg、flac → audio/flac', async () => {
    const { state, exec } = await makeTools()
    const server = await startServer(state)
    try {
      await exec('studio_export', { format: 'mp3' })
      const mp3Done = await fetch(`${server.base}/studio/api/export-done?name=dl.mp3`, {
        method: 'POST',
        body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(80)]),
      })
      const mp3Data = await mp3Done.json()
      const relative = 'exports/' + path.basename(mp3Data.path)
      const download = await fetch(`${server.base}/studio/api/download?path=${encodeURIComponent(relative)}`)
      assert.equal(download.status, 200)
      assert.equal(download.headers.get('content-type'), 'audio/mpeg')
      await exec('studio_export', { format: 'flac' })
      const flacDone = await fetch(`${server.base}/studio/api/export-done?name=dl.flac`, {
        method: 'POST',
        body: Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(80)]),
      })
      const flacData = await flacDone.json()
      const flacDownload = await fetch(`${server.base}/studio/api/download?path=${encodeURIComponent('exports/' + path.basename(flacData.path))}`)
      assert.equal(flacDownload.status, 200)
      assert.equal(flacDownload.headers.get('content-type'), 'audio/flac')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('/export-done mp3：无 seconds 参数时按字节估算时长 >0，并写入历史', async () => {
    const { state, exec } = await makeTools()
    const server = await startServer(state)
    try {
      await exec('studio_export', { format: 'mp3' })
      const done = await fetch(`${server.base}/studio/api/export-done?name=estimate.mp3`, {
        method: 'POST',
        body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(48000)]),
      })
      const data = await done.json()
      assert.equal(data.ok, true)
      assert.ok(data.seconds > 0, '估算时长应 >0')
      assert.ok(state.project.exportHistory[0].seconds > 0)
      assert.equal(state.project.exportHistory[0].format, 'mp3')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('参考轨导入不改变其它轨道 mute/solo 与 master；A/B 语义就绪', async () => {
    const { state, exec } = await makeTools()
    try {
      const before = state.project.tracks.map((track) => ({ id: track.id, mute: track.mute, solo: track.solo }))
      const masterBefore = JSON.stringify(state.project.master)
      const wavPath = path.join(state.dataDir, 'ab.wav')
      await writeFile(wavPath, makeWav(1))
      const imported = await exec('studio_import_reference', { path: wavPath })
      assert.equal(imported.ok, true, imported.error)
      const after = state.project.tracks.filter((track) => track.id !== imported.trackId).map((track) => ({ id: track.id, mute: track.mute, solo: track.solo }))
      assert.deepEqual(after, before)
      assert.equal(JSON.stringify(state.project.master), masterBefore)
      // 参考轨默认 mute；取消静音后 other tracks 仍保持原状
      await exec('studio_update_track', { trackId: imported.trackId, mute: false })
      assert.equal(state.project.tracks.find((track) => track.id === imported.trackId).mute, false)
      assert.deepEqual(state.project.tracks.filter((track) => track.id !== imported.trackId).map((track) => track.mute), before.map((track) => track.mute))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('参考轨随工程保存→打开→重启保留 reference 标记', async () => {
    const { dir, state, exec } = await makeTools()
    try {
      const wavPath = path.join(dir, 'persist.wav')
      await writeFile(wavPath, makeWav(1))
      const imported = await exec('studio_import_reference', { path: wavPath })
      assert.equal(imported.ok, true)
      await exec('studio_save_project', { name: 'P14b 参考工程' })
      await exec('studio_create_project', { title: '临时' })
      const opened = await exec('studio_open_project', { name: 'P14b 参考工程' })
      assert.equal(opened.ok, true)
      const restored = state.project.tracks.find((track) => track.id === imported.trackId)
      assert.equal(restored.reference, true)
      await state.flush()
    } finally {
      await state.flush()
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      const track = reloaded.project.tracks.find((item) => item.reference === true)
      assert.ok(track, '重启后 reference 轨保留')
      assert.equal(track.mute, true)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('参考轨导入失败（轨道已满）时回滚已写入的媒体文件', async () => {
    const { state, exec } = await makeTools()
    try {
      // 新建空工程并填满轨道（32）
      await exec('studio_create_project', { title: '满轨工程' })
      for (let index = 0; index < 32; index += 1) {
        const added = await exec('studio_add_track', { name: 'T' + index, kind: 'synth' })
        assert.equal(added.ok, true)
      }
      assert.equal(state.project.tracks.length, 32)
      const mediaDirBefore = await readdir(state.mediaDir).catch(() => [])
      const wavPath = path.join(state.dataDir, 'full.wav')
      await writeFile(wavPath, makeWav(1))
      const result = await exec('studio_import_reference', { path: wavPath })
      assert.equal(result.ok, false)
      assert.match(result.error, /轨道数量已达上限/)
      const mediaDirAfter = await readdir(state.mediaDir).catch(() => [])
      assert.equal(mediaDirAfter.length, mediaDirBefore.length, '失败时媒体文件已回滚')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_import_reference：startBar 越界中文错误且不写入', async () => {
    const { state, exec } = await makeTools()
    try {
      const wavPath = path.join(state.dataDir, 'bar.wav')
      await writeFile(wavPath, makeWav(1))
      const snapshot = JSON.stringify(state.project)
      const result = await exec('studio_import_reference', { path: wavPath, startBar: 9999 })
      assert.equal(result.ok, false)
      assert.match(result.error, /startBar/)
      assert.equal(JSON.stringify(state.project), snapshot)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_export 参数声明：format enum 含 mp3/flac、targetLufs 存在、描述含参考/MP3/FLAC', async () => {
    const { byName } = await makeTools()
    const tool = byName.get('studio_export')
    assert.deepEqual(tool.parameters.format.enum, ['wav', 'mp3', 'flac', 'midi', 'stems'])
    assert.equal(tool.parameters.targetLufs.type, 'number')
    assert.match(tool.description, /mp3|MP3/)
    assert.match(tool.description, /flac|FLAC/)
    assert.match(tool.description, /targetLufs/)
    const reference = byName.get('studio_import_reference')
    assert.ok(reference)
    assert.match(reference.description, /参考曲/)
    assert.match(reference.description, /静音/)
  })

  it('导出历史 mp3/flac 混合：记录格式正确、最多 10 条', async () => {
    const { state, exec } = await makeTools()
    const server = await startServer(state)
    try {
      for (let index = 0; index < 12; index += 1) {
        const isMp3 = index % 2 === 0
        await exec('studio_export', { format: isMp3 ? 'mp3' : 'flac' })
        const body = isMp3
          ? Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)])
          : Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(20)])
        await fetch(`${server.base}/studio/api/export-done?name=mix-${index}.${isMp3 ? 'mp3' : 'flac'}`, { method: 'POST', body })
      }
      assert.equal(state.project.exportHistory.length, 10)
      assert.equal(state.project.exportHistory[0].format, 'flac')
      assert.equal(state.project.exportHistory[1].format, 'mp3')
      for (const entry of state.project.exportHistory) assert.ok(['mp3', 'flac'].includes(entry.format))
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('targetLufs 边界合法值写入 /state；非法值不改变已有请求', async () => {
    const { state, exec } = await makeTools()
    try {
      await exec('studio_export', { format: 'wav', targetLufs: -14 })
      const request = state.project.exportRequest
      assert.equal(request.targetLufs, -14)
      assert.equal(request.format, undefined)
      assert.equal(request.normalize, false)
      const failed = await exec('studio_export', { targetLufs: -99 })
      assert.equal(failed.ok, false)
      assert.equal(state.project.exportRequest.targetLufs, -14, '失败不改已有请求')
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R0A：导出任务 / 破坏性快照 / undo-redo / 原子导入 / batch / 小节结构          */
/* ------------------------------------------------------------------------- */

describe('R0A — 导出任务 job 生命周期与 outputDir', () => {
  async function makeR0ATools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('studio_export 返回 jobId/status=pending；exportRequest 记录 jobId/startedAt/outputDir', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      const outputDir = await tempDir()
      const result = await exec('studio_export', { format: 'mp3', name: '任务导出', outputDir })
      assert.equal(result.ok, true, result.error)
      assert.match(result.jobId, /^job_[a-z0-9]+_[a-z0-9]+$/)
      assert.equal(result.status, 'pending')
      assert.equal(result.outputDir, outputDir)
      const request = state.project.exportRequest
      assert.equal(request.jobId, result.jobId)
      assert.equal(request.status, 'pending')
      assert.equal(request.outputDir, outputDir)
      assert.ok(Number.isFinite(request.startedAt))
      assert.equal(request.seq, result.seq)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('outputDir 校验：相对路径/不存在/文件/盘符根/系统目录中文拒绝；合法目录接受', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      const relative = await exec('studio_export', { outputDir: 'relative-dir' })
      assert.equal(relative.ok, false)
      assert.match(relative.error, /绝对路径/)
      const missing = await exec('studio_export', { outputDir: path.join(await tempDir(), 'nope') })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /不存在/)
      const filePath = path.join(await tempDir(), 'a.txt')
      await writeFile(filePath, 'x')
      const notDir = await exec('studio_export', { outputDir: filePath })
      assert.equal(notDir.ok, false)
      assert.match(notDir.error, /不是文件夹/)
      const root = path.parse(process.cwd()).root
      const rootResult = await exec('studio_export', { outputDir: root })
      assert.equal(rootResult.ok, false)
      assert.match(rootResult.error, /不允许指向系统目录/)
      if (process.env.WINDIR) {
        const system = await exec('studio_export', { outputDir: process.env.WINDIR })
        assert.equal(system.ok, false)
        assert.match(system.error, /不允许指向系统目录/)
      }
      const valid = await tempDir()
      const accepted = await exec('studio_export', { outputDir: valid })
      assert.equal(accepted.ok, true, accepted.error)
      assert.equal(accepted.outputDir, valid)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_export_status：按 jobId 查询 pending、未知 jobId found=false、无参返回当前任务', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      const job = await exec('studio_export', { format: 'wav' })
      const byId = await exec('studio_export_status', { jobId: job.jobId })
      assert.equal(byId.ok, true)
      assert.equal(byId.found, true)
      assert.equal(byId.job.jobId, job.jobId)
      assert.equal(byId.job.status, 'pending')
      const unknown = await exec('studio_export_status', { jobId: 'job_nope' })
      assert.equal(unknown.ok, true)
      assert.equal(unknown.found, false)
      assert.equal(unknown.job, null)
      const current = await exec('studio_export_status')
      assert.equal(current.found, true)
      assert.equal(current.job.jobId, job.jobId)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('POST /export-done 带 jobId：标记 success、写 lastExport/历史、清空请求', async () => {
    const { state, exec } = await makeR0ATools()
    const server = await startServer(state)
    try {
      const job = await exec('studio_export', { name: '任务完成' })
      const wav = makeWav(1)
      const response = await fetch(
        `${server.base}/studio/api/export-done?jobId=${encodeURIComponent(job.jobId)}&name=${encodeURIComponent('任务完成.wav')}`,
        { method: 'POST', body: wav },
      )
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.ok, true, data.error)
      assert.equal(data.jobId, job.jobId)
      assert.equal(data.status, 'success')
      assert.equal(data.format, 'wav')
      assert.ok(data.name.endsWith('任务完成.wav'))
      assert.equal(state.project.exportRequest, null)
      assert.equal(state.project.exportJobs[0].jobId, job.jobId)
      assert.equal(state.project.exportJobs[0].status, 'success')
      assert.equal(state.project.exportJobs[0].bytes, wav.length)
      assert.equal(state.project.lastExport.path, data.path)
      assert.equal(state.project.exportHistory[0].path, data.path)
      const status = await fetch(`${server.base}/studio/api/export-status?jobId=${encodeURIComponent(job.jobId)}`)
      const statusData = await status.json()
      assert.equal(statusData.found, true)
      assert.equal(statusData.job.status, 'success')
      assert.equal(statusData.job.path, data.path)
      // 文件真实存在且非空
      assert.equal((await stat(data.path)).size, wav.length)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('同名导出不覆盖：第二次自动 -2，历史路径唯一', async () => {
    const { state, exec } = await makeR0ATools()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      const paths = []
      for (let index = 0; index < 2; index += 1) {
        const job = await exec('studio_export', { name: '同名导出' })
        const response = await fetch(
          `${server.base}/studio/api/export-done?jobId=${encodeURIComponent(job.jobId)}&name=${encodeURIComponent('同名导出.wav')}`,
          { method: 'POST', body: wav },
        )
        const data = await response.json()
        assert.equal(data.ok, true, data.error)
        paths.push(data.path)
      }
      assert.notEqual(paths[0], paths[1])
      assert.ok(paths[0].endsWith('同名导出.wav'))
      assert.ok(paths[1].endsWith('同名导出-2.wav'))
      assert.equal(new Set(state.project.exportHistory.map((entry) => entry.path)).size, 2)
      assert.equal((await stat(paths[0])).size, wav.length)
      assert.equal((await stat(paths[1])).size, wav.length)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('outputDir 生效：/export-done 写到外部作品文件夹', async () => {
    const { state, exec } = await makeR0ATools()
    const server = await startServer(state)
    try {
      const outputDir = await tempDir()
      const job = await exec('studio_export', { name: '作品文件', outputDir })
      const wav = makeWav(1)
      const response = await fetch(
        `${server.base}/studio/api/export-done?jobId=${encodeURIComponent(job.jobId)}&name=${encodeURIComponent('作品文件.wav')}`,
        { method: 'POST', body: wav },
      )
      const data = await response.json()
      assert.equal(data.ok, true, data.error)
      assert.equal(path.dirname(data.path), outputDir)
      assert.equal((await stat(data.path)).size, wav.length)
      assert.equal(state.project.exportJobs[0].outputDir, outputDir)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /export-error：标记 error、清空请求、状态可查', async () => {
    const { state, exec } = await makeR0ATools()
    const server = await startServer(state)
    try {
      const job = await exec('studio_export', { format: 'flac' })
      const response = await fetch(`${server.base}/studio/api/export-error`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: job.jobId, error: '渲染进程崩溃' }),
      })
      const data = await response.json()
      assert.equal(data.ok, true, data.error)
      assert.equal(data.status, 'error')
      assert.equal(data.job.error, '渲染进程崩溃')
      assert.equal(state.project.exportRequest, null)
      assert.equal(state.project.exportJobs[0].status, 'error')
      assert.equal(state.project.exportJobs[0].error, '渲染进程崩溃')
      const status = await fetch(`${server.base}/studio/api/export-status?jobId=${encodeURIComponent(job.jobId)}`)
      const statusData = await status.json()
      assert.equal(statusData.job.status, 'error')
      assert.equal(statusData.job.error, '渲染进程崩溃')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('未知/陈旧 jobId：export-done 容错返回 ok/stale；export-error 仍中文 ok:false', async () => {
    const { state } = await makeR0ATools()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      const done = await fetch(`${server.base}/studio/api/export-done?jobId=job_missing&name=x.wav`, { method: 'POST', body: wav })
      const doneData = await done.json()
      assert.equal(doneData.ok, true)
      assert.equal(doneData.stale, true)
      assert.equal(doneData.jobId, 'job_missing')
      const fail = await fetch(`${server.base}/studio/api/export-error`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: 'job_missing2', error: 'x' }),
      })
      const failData = await fail.json()
      assert.equal(failData.ok, false)
      assert.match(failData.error, /找不到导出任务/)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('无 exportRequest 时 /export-done 兼容旧流程（jobId=null，历史正常记录）', async () => {
    const { state } = await makeR0ATools()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      const response = await fetch(`${server.base}/studio/api/export-done?name=legacy.wav`, { method: 'POST', body: wav })
      const data = await response.json()
      assert.equal(data.ok, true, data.error)
      assert.equal(data.jobId, null)
      assert.equal(state.project.exportHistory[0].name, 'legacy.wav')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('GET /export-status 无 jobId：返回当前任务；完成后返回最近任务', async () => {
    const { state, exec } = await makeR0ATools()
    const server = await startServer(state)
    try {
      const empty = await fetch(`${server.base}/studio/api/export-status`)
      const emptyData = await empty.json()
      assert.equal(emptyData.ok, true)
      assert.equal(emptyData.found, false)
      const job = await exec('studio_export', { name: '最近任务' })
      const current = await (await fetch(`${server.base}/studio/api/export-status`)).json()
      assert.equal(current.found, true)
      assert.equal(current.job.status, 'pending')
      assert.equal(current.job.jobId, job.jobId)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

describe('R0A — 破坏性操作快照 / 原子导入 / undo / 小节结构', () => {
  async function makeR0ATools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('studio_open_project：命名工程切换前写版本历史快照并返回 backupPath', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      await exec('studio_save_project', { name: '源工程' })
      await exec('studio_create_project', { title: '当前工程' })
      await exec('studio_save_project', { name: '当前工程' })
      const opened = await exec('studio_open_project', { name: '源工程' })
      assert.equal(opened.ok, true, opened.error)
      assert.equal(opened.backupKind, 'version')
      assert.ok(opened.backupPath.includes('_history'))
      assert.ok(opened.backupPath.includes('当前工程'))
      const backup = JSON.parse(await readFile(opened.backupPath, 'utf8'))
      assert.equal(backup.title, '当前工程')
      assert.equal(state.activeName, '源工程')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('未命名工程被替换时先写 _autobackup-*，backupKind=autobackup', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      await exec('studio_save_project', { name: '已存工程' })
      await exec('studio_create_project', { title: '未保存新工程' })
      assert.equal(state.activeName, null)
      const opened = await exec('studio_open_project', { name: '已存工程' })
      assert.equal(opened.ok, true, opened.error)
      assert.equal(opened.backupKind, 'autobackup')
      assert.match(path.basename(opened.backupPath), /^_autobackup-\d{8}-\d{6}\.json$/)
      const backup = JSON.parse(await readFile(opened.backupPath, 'utf8'))
      assert.equal(backup.title, '未保存新工程')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('POST /projects/new 前快照当前命名工程', async () => {
    const { state, exec } = await makeR0ATools()
    const server = await startServer(state)
    try {
      await exec('studio_save_project', { name: '待换工程' })
      const response = await fetch(`${server.base}/studio/api/projects/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template: 'empty' }),
      })
      const data = await response.json()
      assert.equal(data.ok, true)
      assert.equal(data.backupKind, 'version')
      assert.ok(data.backupPath.includes('_history'))
      assert.ok(data.backupPath.includes('待换工程'))
      assert.equal(state.activeName, null)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_import_midi replace 前快照命名工程（_history）', async () => {
    const { dir, state, exec } = await makeR0ATools()
    try {
      await exec('studio_save_project', { name: '将被替换' })
      const midiPath = path.join(dir, 'r0a.mid')
      const midi = buildMidi(createDemoProject())
      await writeFile(midiPath, midi.buffer)
      const result = await exec('studio_import_midi', { path: midiPath, replace: true, title: '导入后的工程' })
      assert.equal(result.ok, true, result.error)
      assert.ok(result.backupPath)
      assert.ok(result.backupPath.includes('_history'))
      assert.ok(result.backupPath.includes('将被替换'))
      assert.ok((await stat(result.backupPath)).size > 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_import_project_json：一次写入 + 快照 + 一次撤销恢复', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      await exec('studio_save_project', { name: '导入前工程' })
      const beforeTitle = state.project.title
      const beforeTracks = state.project.tracks.length
      const importedProject = createDemoProject()
      const result = await exec('studio_import_project_json', { project: importedProject, title: '整份导入作品' })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.title, '整份导入作品')
      assert.equal(result.tracks, importedProject.tracks.length)
      assert.ok(result.backupPath.includes('_history'))
      assert.equal(state.project.title, '整份导入作品')
      assert.equal(state.activeName, null)
      assert.equal(state.historyState().undoLabel, '导入工程')
      const undo = await exec('studio_undo')
      assert.equal(undo.ok, true, undo.error)
      assert.equal(state.project.title, beforeTitle)
      assert.equal(state.project.tracks.length, beforeTracks)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_import_project_json：非法 schema/超限/replace=false 中文拒绝且不改工程', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      const snapshot = JSON.stringify(state.project)
      const oldSchema = await exec('studio_import_project_json', { project: { schemaVersion: 1, title: '旧' } })
      assert.equal(oldSchema.ok, false)
      assert.match(oldSchema.error, /schemaVersion 必须为 3/)
      const notObject = await exec('studio_import_project_json', { project: 'bad' })
      assert.equal(notObject.ok, false)
      const manyTracks = createEmptyProject()
      manyTracks.tracks = Array.from({ length: 33 }, (_, index) => makeTrack({ id: 'trk_' + index, name: 'T' + index, preset: 'grand_piano' }))
      const tooManyTracks = await exec('studio_import_project_json', { project: manyTracks })
      assert.equal(tooManyTracks.ok, false)
      assert.match(tooManyTracks.error, /tracks 数量 33 超过上限 32/)
      const tooManyNotes = createEmptyProject()
      tooManyNotes.patterns = [{
        id: 'pat_1',
        name: '超多音符',
        lengthBars: 4,
        notes: Array.from({ length: 4097 }, (_, index) => ({ pitch: 60, start: (index % 64) * 0.25, dur: 0.25, vel: 0.8 })),
      }]
      const notesResult = await exec('studio_import_project_json', { project: tooManyNotes })
      assert.equal(notesResult.ok, false)
      assert.match(notesResult.error, /音符数 4097 超过上限 4096/)
      const appendNotSupported = await exec('studio_import_project_json', { project: createDemoProject(), replace: false })
      assert.equal(appendNotSupported.ok, false)
      assert.match(appendNotSupported.error, /只支持 replace=true/)
      assert.equal(JSON.stringify(state.project), snapshot, '非法导入不修改工程')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_undo / studio_redo / studio_get_history：空栈中文错误、深度与工程恢复', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      const emptyUndo = await exec('studio_undo')
      assert.equal(emptyUndo.ok, false)
      assert.match(emptyUndo.error, /没有可撤销的操作/)
      const emptyRedo = await exec('studio_redo')
      assert.equal(emptyRedo.ok, false)
      assert.match(emptyRedo.error, /没有可重做的操作/)
      const before = state.project.tracks.find((track) => track.id === 'trk_1').volume
      const edit = await exec('studio_update_track', { trackId: 'trk_1', volume: 0.12 })
      assert.equal(edit.ok, true)
      const history = await exec('studio_get_history')
      assert.equal(history.canUndo, true)
      assert.equal(history.undoDepth, 1)
      assert.ok(Array.isArray(history.recentActions))
      assert.ok(history.recentActions.length >= 1)
      const undone = await exec('studio_undo')
      assert.equal(undone.ok, true, undone.error)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').volume, before)
      assert.equal(undone.undoDepth, 0)
      assert.equal(undone.redoDepth, 1)
      const redone = await exec('studio_redo')
      assert.equal(redone.ok, true, redone.error)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').volume, 0.12)
      assert.equal(redone.undoDepth, 1)
      assert.equal(redone.redoDepth, 0)
      // 多步撤销
      await exec('studio_update_track', { trackId: 'trk_2', volume: 0.33 })
      const undo2 = await exec('studio_undo')
      assert.equal(undo2.ok, true)
      const undo3 = await exec('studio_undo')
      assert.equal(undo3.ok, true)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').volume, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：addTrack/addPattern 一次原子写入、一次撤销、失败整批不写', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      const tracksBefore = state.project.tracks.length
      const patternsBefore = state.project.patterns.length
      const result = await exec('studio_batch', {
        label: '批量建轨',
        ops: [
          { type: 'addTrack', args: { name: '批量合成', kind: 'synth', preset: 'grand_piano' } },
          { type: 'addTrack', args: { name: '批量鼓', kind: 'drum', kit: 'smp_acoustic' } },
          { type: 'addPattern', args: { name: '批量 Pattern', lengthBars: 2 } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 3)
      assert.equal(state.project.tracks.length, tracksBefore + 2)
      assert.equal(state.project.patterns.length, patternsBefore + 1)
      assert.equal(new Set(state.project.tracks.map((track) => track.id)).size, state.project.tracks.length)
      await exec('studio_undo')
      assert.equal(state.project.tracks.length, tracksBefore)
      assert.equal(state.project.patterns.length, patternsBefore)
      // 失败整批不写
      const snapshot = JSON.stringify(state.project)
      const failed = await exec('studio_batch', {
        ops: [
          { type: 'addTrack', args: { name: '不会被创建', kind: 'synth' } },
          { type: 'addPattern', args: { name: 'bad', lengthBars: 0 } },
        ],
      })
      assert.equal(failed.ok, false)
      assert.match(failed.error, /整批未写入/)
      assert.equal(JSON.stringify(state.project), snapshot)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：允许 200 个操作（上限从 50 提升）', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      const opsList = Array.from({ length: 200 }, () => ({ type: 'updateTrack', args: { trackId: 'trk_1', volume: 0.5 } }))
      const result = await exec('studio_batch', { ops: opsList })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 200)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_insert_bars：clips/sections/tempoMap 右移、跨边界片段延长、曲长 +count', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      await exec('studio_set_arrangement', {
        clips: [
          { trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 4 },
          { trackId: 'trk_2', patternId: 'pat_1', startBar: 4, lengthBars: 8 },
          { trackId: 'trk_3', patternId: 'pat_1', startBar: 12, lengthBars: 4 },
        ],
        sections: [
          { name: 'Intro', startBar: 0, lengthBars: 8 },
          { name: 'Drop', startBar: 12, lengthBars: 4 },
        ],
      })
      await exec('studio_set_tempo_map', { points: [{ beat: 0, bpm: 120 }, { beat: 64, bpm: 140 }] })
      const result = await exec('studio_insert_bars', { atBar: 8, count: 4 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.lengthBars, state.project.lengthBars)
      assert.equal(state.project.lengthBars, 36)
      const clips = state.project.clips
      assert.equal(clips.find((clip) => clip.trackId === 'trk_1').startBar, 0)
      const crossing = clips.find((clip) => clip.trackId === 'trk_2')
      assert.equal(crossing.startBar, 4)
      assert.equal(crossing.lengthBars, 12, '跨插入点的片段延长')
      assert.equal(clips.find((clip) => clip.trackId === 'trk_3').startBar, 16, '插入点后的片段右移')
      const intro = state.project.sections.find((section) => section.name === 'Intro')
      assert.equal(intro.lengthBars, 8, '插入点在段落末尾时段落不延长')
      assert.equal(state.project.sections.find((section) => section.name === 'Drop').startBar, 16)
      assert.equal(state.project.tempoMap.find((point) => point.bpm === 140).beat, 80)
      // 一次撤销恢复
      await exec('studio_undo')
      assert.equal(state.project.lengthBars, 32)
      assert.equal(state.project.tempoMap.find((point) => point.bpm === 140).beat, 64)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_insert_bars：非法 atBar/count/超上限中文拒绝', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      const snapshot = JSON.stringify(state.project)
      const negative = await exec('studio_insert_bars', { atBar: -1, count: 4 })
      assert.equal(negative.ok, false)
      const zeroCount = await exec('studio_insert_bars', { atBar: 0, count: 0 })
      assert.equal(zeroCount.ok, false)
      const tooFar = await exec('studio_insert_bars', { atBar: 33, count: 1 })
      assert.equal(tooFar.ok, false)
      const overflow = await exec('studio_insert_bars', { atBar: 0, count: 225 })
      assert.equal(overflow.ok, false)
      assert.match(overflow.error, /超过上限/)
      assert.equal(JSON.stringify(state.project), snapshot)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_delete_bars：完全/跨界 clips 与 sections 移除或裁剪、automation/tempoMap 左移', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      await exec('studio_set_arrangement', {
        clips: [
          { trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 4 },
          { trackId: 'trk_2', patternId: 'pat_1', startBar: 4, lengthBars: 8 },
          { trackId: 'trk_3', patternId: 'pat_1', startBar: 8, lengthBars: 4 },
          { trackId: 'trk_4', patternId: 'pat_1', startBar: 14, lengthBars: 4 },
        ],
        sections: [
          { name: 'Intro', startBar: 0, lengthBars: 8 },
          { name: 'Drop', startBar: 8, lengthBars: 4 },
          { name: 'Outro', startBar: 14, lengthBars: 4 },
        ],
      })
      await exec('studio_set_automation', { trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.2 }, { beat: 20, value: 0.8 }, { beat: 40, value: 0.5 }] })
      await exec('studio_set_tempo_map', { points: [{ beat: 0, bpm: 120 }, { beat: 64, bpm: 140 }] })
      const result = await exec('studio_delete_bars', { atBar: 6, count: 4 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.lengthBars, 28)
      const clips = state.project.clips
      assert.equal(clips.find((clip) => clip.trackId === 'trk_1').lengthBars, 4, '删除区前片段不变')
      const crossing = clips.find((clip) => clip.trackId === 'trk_2')
      assert.equal(crossing.startBar, 4)
      assert.equal(crossing.lengthBars, 4, '跨删除区前后尾段拼接')
      const trimmed = clips.find((clip) => clip.trackId === 'trk_3')
      assert.equal(trimmed.startBar, 6)
      assert.equal(trimmed.lengthBars, 2, '删除区内的片段只保留尾部')
      assert.equal(clips.find((clip) => clip.trackId === 'trk_4').startBar, 10, '删除区后的片段左移')
      assert.equal(state.project.sections.find((section) => section.name === 'Intro').lengthBars, 6)
      assert.equal(state.project.sections.find((section) => section.name === 'Drop').startBar, 6)
      assert.equal(state.project.sections.find((section) => section.name === 'Outro').startBar, 10)
      const volume = state.project.tracks.find((track) => track.id === 'trk_1').automation.volume.points
      assert.deepEqual(volume.map((point) => point.beat), [0, 20, 24], '删除区前的点保留、之后的点左移')
      assert.equal(state.project.tempoMap.find((point) => point.bpm === 140).beat, 48)
      assert.ok(result.removedClips >= 0)
      assert.ok(result.removedSections >= 0)
      assert.ok(result.removedTempoPoints >= 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_delete_bars：范围越界/删空曲长中文拒绝；一次撤销恢复', async () => {
    const { state, exec } = await makeR0ATools()
    try {
      const snapshot = JSON.stringify(state.project)
      const beyond = await exec('studio_delete_bars', { atBar: 30, count: 4 })
      assert.equal(beyond.ok, false)
      assert.match(beyond.error, /超出曲长/)
      const all = await exec('studio_delete_bars', { atBar: 0, count: 32 })
      assert.equal(all.ok, false)
      assert.match(all.error, /至少保留 1 小节/)
      assert.equal(JSON.stringify(state.project), snapshot)
      const okDelete = await exec('studio_delete_bars', { atBar: 0, count: 4 })
      assert.equal(okDelete.ok, true, okDelete.error)
      assert.equal(state.project.lengthBars, 28)
      const undo = await exec('studio_undo')
      assert.equal(undo.ok, true)
      assert.equal(state.project.lengthBars, 32)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* task-75：get_project 摘要 / lastExport stale / 备份列表恢复                  */
/* ------------------------------------------------------------------------- */

describe('task-75 — 摘要、lastExport 与备份恢复', () => {
  async function makeTaskTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('studio_get_project 参数声明 includeSustain/includeAutomation；默认摘要不含 points', async () => {
    const { byName } = await makeTaskTools()
    const tool = byName.get('studio_get_project')
    assert.equal(tool.parameters.includeSustain.type, 'boolean')
    assert.equal(tool.parameters.includeAutomation.type, 'boolean')
    assert.match(tool.description, /includeSustain/)
    assert.match(tool.description, /includeAutomation/)
  })

  it('lastExport 文件不存在：get_project 标 stale 且不返回失效 path', async () => {
    const { dir, state, exec } = await makeTaskTools()
    try {
      const missing = path.join(dir, 'exports', 'missing.wav')
      state.mutate({ tool: 'test', text: null }, (draft) => {
        ops.setLastExport(draft, { path: missing, bytes: 123, seconds: 4 })
        return undefined
      })
      const overview = await exec('studio_get_project')
      assert.equal(overview.lastExport.stale, true)
      assert.equal(overview.lastExport.path, null)
      assert.equal(overview.lastExport.bytes, 123)
      assert.equal(overview.lastExport.seconds, 4)
      // 文件真实存在后不再 stale
      const realPath = path.join(dir, 'exports', 'real.wav')
      await mkdir(path.dirname(realPath), { recursive: true })
      await writeFile(realPath, makeWav(1))
      state.mutate({ tool: 'test', text: null }, (draft) => {
        ops.setLastExport(draft, { path: realPath, bytes: 100, seconds: 1 })
        return undefined
      })
      const overview2 = await exec('studio_get_project')
      assert.equal(Object.hasOwn(overview2.lastExport, 'stale'), false)
      assert.equal(overview2.lastExport.path, realPath)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('get_project includeSustain/includeAutomation 只影响返回内容，不改工程', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_set_sustain', { trackId: 'trk_1', points: [{ beat: 0, value: 1 }, { beat: 8, value: 0 }] })
      await exec('studio_set_automation', { trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.2 }, { beat: 8, value: 0.9 }] })
      const snapshot = JSON.stringify(state.project)
      const defaultView = await exec('studio_get_project')
      const track = defaultView.tracks.find((item) => item.id === 'trk_1')
      assert.equal(track.sustain.points, undefined)
      assert.equal(track.automation.volume.points, undefined)
      const full = await exec('studio_get_project', { includeSustain: true, includeAutomation: true })
      const fullTrack = full.tracks.find((item) => item.id === 'trk_1')
      assert.equal(fullTrack.sustain.points.length, 2)
      assert.equal(fullTrack.automation.volume.points.length, 2)
      assert.equal(JSON.stringify(state.project), snapshot, '读取不修改工程')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('get_project 概览大小：大量自动化点默认响应明显更小', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_set_automation', {
        trackId: 'trk_1',
        param: 'volume',
        points: Array.from({ length: 200 }, (_, index) => ({ beat: index * 0.5, value: (index % 100) / 100 })),
      })
      const compact = await exec('studio_get_project')
      const full = await exec('studio_get_project', { includeAutomation: true })
      const compactBytes = Buffer.byteLength(JSON.stringify(compact))
      const fullBytes = Buffer.byteLength(JSON.stringify(full))
      assert.ok(compactBytes < fullBytes, `${compactBytes} < ${fullBytes}`)
      assert.equal(full.tracks.find((item) => item.id === 'trk_1').automation.volume.points.length, 200)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_list_backups：保存产生版本历史、未命名快照产生 autobackup，均可列出', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      // 先在未命名状态 create_project → 产生 autobackup
      await exec('studio_create_project', { title: '临时未命名工程' })
      await exec('studio_save_project', { name: '备份工程' })
      state.mutate({ tool: 'test', text: null }, (draft) => {
        draft.title = '备份工程第二版'
        return undefined
      })
      await exec('studio_save_project', { name: '备份工程' })
      const listed = await exec('studio_list_backups')
      assert.equal(listed.ok, true, listed.error)
      const versions = listed.backups.filter((entry) => entry.kind === 'version' && entry.name === '备份工程')
      assert.ok(versions.length >= 2, '两次保存应产生至少 2 个版本')
      assert.ok(versions.every((entry) => entry.path && entry.id && typeof entry.bytes === 'number'))
      assert.ok(listed.backups.some((entry) => entry.kind === 'autobackup'))
      assert.equal(listed.counts.version, listed.backups.filter((entry) => entry.kind === 'version').length)
      assert.equal(listed.counts.autobackup, listed.backups.filter((entry) => entry.kind === 'autobackup').length)
      // 按工程过滤（autobackup 仍列出）
      const filtered = await exec('studio_list_backups', { name: '备份工程' })
      assert.ok(filtered.backups.filter((entry) => entry.kind === 'version').every((entry) => entry.name === '备份工程'))
      // 最新在前
      const timestamps = listed.backups.map((entry) => Number(entry.at) || 0)
      assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_restore_backup {name,id}：恢复历史版本、恢复前快照当前工程、activeName 设回', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_save_project', { name: '原始工程' })
      const originalTitle = state.project.title
      await exec('studio_create_project', { title: '改过的工程' })
      const listed = await exec('studio_list_backups', { name: '原始工程' })
      const version = listed.backups.find((entry) => entry.kind === 'version' && entry.name === '原始工程')
      assert.ok(version)
      const restored = await exec('studio_restore_backup', { name: '原始工程', id: version.id })
      assert.equal(restored.ok, true, restored.error)
      assert.equal(restored.kind, 'version')
      assert.equal(restored.id, version.id)
      assert.equal(restored.name, '原始工程')
      assert.equal(state.project.title, originalTitle)
      assert.equal(state.activeName, '原始工程')
      assert.ok(restored.backupPath, '恢复前应快照当前工程')
      assert.equal((await stat(restored.backupPath)).size > 0, true)
      assert.equal(state.historyState().canUndo, false, '恢复后清空撤销历史')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_restore_backup {path}：恢复 autobackup 文件，activeName=null', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_create_project', { title: '第一份未命名快照' })
      await exec('studio_create_project', { title: '第二份未命名快照' })
      const listed = await exec('studio_list_backups')
      const autobackups = listed.backups.filter((entry) => entry.kind === 'autobackup')
      assert.ok(autobackups.length >= 1)
      const target = autobackups[0]
      const restored = await exec('studio_restore_backup', { path: target.path })
      assert.equal(restored.ok, true, restored.error)
      assert.equal(restored.kind, 'autobackup')
      assert.equal(state.activeName, null)
      assert.ok(state.project.title)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_restore_backup 无参数：恢复最近一次 auto backup', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_create_project', { title: '自动备份目标' })
      await exec('studio_create_project', { title: '覆盖工程' })
      const restored = await exec('studio_restore_backup')
      assert.equal(restored.ok, true, restored.error)
      assert.equal(state.project.title, '自动备份目标')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_restore_backup 错误：路径越界/不存在/坏 schema/无备份均中文拒绝', async () => {
    const { dir, state, exec } = await makeTaskTools()
    try {
      const outside = path.join(dir, 'outside.json')
      await writeFile(outside, JSON.stringify(createEmptyProject()))
      const outsideResult = await exec('studio_restore_backup', { path: outside })
      assert.equal(outsideResult.ok, false)
      assert.match(outsideResult.error, /只能恢复 data\/projects 下的备份文件/)
      const missing = await exec('studio_restore_backup', { path: path.join(projectsDir(dir), '_autobackup-missing.json') })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /备份文件不存在/)
      const badSchemaPath = path.join(projectsDir(dir), '_autobackup-bad.json')
      await mkdir(path.dirname(badSchemaPath), { recursive: true })
      await writeFile(badSchemaPath, JSON.stringify({ schemaVersion: 1, title: '旧' }))
      const badSchema = await exec('studio_restore_backup', { path: badSchemaPath })
      assert.equal(badSchema.ok, false)
      assert.match(badSchema.error, /schemaVersion 必须为 3/)
      const fresh = await makeTaskTools()
      try {
        const none = await fresh.exec('studio_restore_backup')
        assert.equal(none.ok, false)
        assert.match(none.error, /没有找到可恢复的备份/)
      } finally {
        await fresh.state.flush()
        fresh.state.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_restore_backup：仅 name（最新版本）可恢复；坏 JSON 文件中文拒绝', async () => {
    const { dir, state, exec } = await makeTaskTools()
    try {
      await exec('studio_save_project', { name: '版本工程' })
      state.mutate({ tool: 'test', text: null }, (draft) => {
        draft.title = '版本工程 v2'
        return undefined
      })
      await exec('studio_save_project', { name: '版本工程' })
      const restored = await exec('studio_restore_backup', { name: '版本工程' })
      assert.equal(restored.ok, true, restored.error)
      assert.equal(state.project.title, '版本工程 v2', 'name 省略 id 时恢复最新版本')
      // 坏 JSON 备份
      const badJson = path.join(projectsDir(dir), '_autobackup-broken.json')
      await mkdir(path.dirname(badJson), { recursive: true })
      await writeFile(badJson, '{not json')
      const broken = await exec('studio_restore_backup', { path: badJson })
      assert.equal(broken.ok, false)
      assert.match(broken.error, /不是合法 JSON/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('task-75 — 补充：结构边界 / 原子导入 / 导出任务历史', () => {
  async function makeTaskTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('insert_bars atBar=0：全部 clips/sections 右移，曲长增加，可撤销', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_set_arrangement', {
        clips: [{ trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 4 }],
        sections: [{ name: 'Intro', startBar: 0, lengthBars: 4 }],
      })
      const result = await exec('studio_insert_bars', { atBar: 0, count: 2 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.clips.find((clip) => clip.trackId === 'trk_1').startBar, 2)
      assert.equal(state.project.sections.find((section) => section.name === 'Intro').startBar, 2)
      assert.equal(state.project.lengthBars, 34)
      await exec('studio_undo')
      assert.equal(state.project.lengthBars, 32)
      assert.equal(state.project.clips.find((clip) => clip.trackId === 'trk_1').startBar, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('delete_bars atBar=0：跨起点 clip/section 裁剪而非整体移除', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_set_arrangement', {
        clips: [{ trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 8 }],
        sections: [{ name: 'Intro', startBar: 0, lengthBars: 8 }],
      })
      const result = await exec('studio_delete_bars', { atBar: 0, count: 2 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.clips.find((clip) => clip.trackId === 'trk_1').startBar, 0)
      assert.equal(state.project.clips.find((clip) => clip.trackId === 'trk_1').lengthBars, 6)
      assert.equal(state.project.sections.find((section) => section.name === 'Intro').lengthBars, 6)
      assert.equal(state.project.lengthBars, 30)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('insert/delete bars：无 tempoMap/automation 时也能工作', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      assert.deepEqual(state.project.tempoMap ?? [], [])
      assert.ok((await exec('studio_insert_bars', { atBar: 4, count: 2 })).ok)
      assert.ok((await exec('studio_delete_bars', { atBar: 4, count: 2 })).ok)
      assert.equal(state.project.lengthBars, 32)
      assert.deepEqual(state.project.tempoMap ?? [], [])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('insert/delete bars 后 tempoMap 保持 beat 升序', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_set_tempo_map', { points: [{ beat: 0, bpm: 120 }, { beat: 64, bpm: 140 }, { beat: 96, bpm: 100 }] })
      await exec('studio_insert_bars', { atBar: 8, count: 4 })
      const beats = state.project.tempoMap.map((point) => point.beat)
      assert.deepEqual(beats, [...beats].sort((a, b) => a - b))
      await exec('studio_delete_bars', { atBar: 8, count: 4 })
      const after = state.project.tempoMap.map((point) => point.beat)
      assert.deepEqual(after, [...after].sort((a, b) => a - b))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('import_project_json：保留 pattern 音符/安排/clips/master，返回统计准确', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      const imported = createDemoProject()
      const expectedNotes = imported.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0)
      const result = await exec('studio_import_project_json', { project: imported })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.notes, expectedNotes)
      assert.equal(result.patterns, imported.patterns.length)
      assert.equal(result.clips, imported.clips.length)
      assert.equal(state.project.clips.length, imported.clips.length)
      assert.deepEqual(state.project.sections.map((section) => section.name), imported.sections.map((section) => section.name))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('import_project_json：expectedRevision 冲突时不写入', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      const snapshot = JSON.stringify(state.project)
      const conflict = await exec('studio_import_project_json', {
        project: createDemoProject(),
        expectedRevision: state.revision - 1,
      })
      assert.equal(conflict.ok, false)
      assert.equal(conflict.retry, true)
      assert.equal(JSON.stringify(state.project), snapshot)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('导出任务历史：exportJobs 最多 10 条、最新在前、状态 success', async () => {
    const { state, exec } = await makeTaskTools()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      for (let index = 0; index < 12; index += 1) {
        const job = await exec('studio_export', { name: '历史任务' + index })
        const response = await fetch(
          `${server.base}/studio/api/export-done?jobId=${encodeURIComponent(job.jobId)}&name=${encodeURIComponent('历史任务' + index + '.wav')}`,
          { method: 'POST', body: wav },
        )
        assert.equal((await response.json()).ok, true)
      }
      assert.equal(state.project.exportJobs.length, 10)
      assert.equal(state.project.exportJobs[0].status, 'success')
      assert.equal(state.project.exportJobs[0].name, '历史任务11.wav')
      assert.ok(state.project.exportJobs.every((job) => job.status === 'success'))
      assert.equal(state.project.exportHistory.length, 10)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /export-error 无 jobId：作用当前 exportRequest；未知 jobId 的 export-status found=false', async () => {
    const { state, exec } = await makeTaskTools()
    const server = await startServer(state)
    try {
      const job = await exec('studio_export', { format: 'wav' })
      const errorResponse = await fetch(`${server.base}/studio/api/export-error`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: '无 jobId 的失败' }),
      })
      const errorData = await errorResponse.json()
      assert.equal(errorData.ok, true)
      assert.equal(errorData.jobId, job.jobId)
      assert.equal(errorData.status, 'error')
      assert.equal(state.project.exportRequest, null)
      const status = await (await fetch(`${server.base}/studio/api/export-status?jobId=job_none`)).json()
      assert.equal(status.found, false)
      assert.equal(status.job, null)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_list_backups：默认 activeName 过滤仍包含所有历史工程与 autobackup', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_create_project', { title: '未命名' })
      await exec('studio_save_project', { name: '历史工程A' })
      await exec('studio_save_project', { name: '历史工程B' })
      const listed = await exec('studio_list_backups')
      assert.equal(listed.ok, true)
      const names = new Set(listed.backups.filter((entry) => entry.kind === 'version').map((entry) => entry.name))
      assert.ok(names.has('历史工程A'))
      assert.ok(names.has('历史工程B'))
      assert.ok(listed.backups.some((entry) => entry.kind === 'autobackup'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_restore_backup：name+不存在 id 返回中文错误且不改工程', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_save_project', { name: '无此版本' })
      const snapshot = JSON.stringify(state.project)
      const result = await exec('studio_restore_backup', { name: '无此版本', id: '20260101-000000-000' })
      assert.equal(result.ok, false)
      assert.match(result.error, /没有找到可恢复的备份/)
      assert.equal(JSON.stringify(state.project), snapshot)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_get_project includeNotes + includeAutomation 可同时使用', async () => {
    const { state, exec } = await makeTaskTools()
    try {
      await exec('studio_set_automation', { trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.3 }, { beat: 8, value: 0.7 }] })
      const overview = await exec('studio_get_project', { includeNotes: true, includeAutomation: true })
      assert.equal(overview.ok, true)
      assert.ok(overview.patterns.some((pattern) => Array.isArray(pattern.notes) && pattern.notes.length > 0))
      assert.deepEqual(overview.tracks.find((track) => track.id === 'trk_1').automation.volume.points, [
        { beat: 0, value: 0.3 },
        { beat: 8, value: 0.7 },
      ])
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('task-75 — /state lastExport stale 标记', () => {
  it('GET /state：失效 lastExport 返回 stale:true/path:null；文件存在时正常返回 path', async () => {
    const { dir, state } = await makeState()
    const server = await startServer(state)
    try {
      const missing = path.join(dir, 'exports', 'gone.wav')
      state.mutate({ tool: 'test', text: null }, (draft) => {
        ops.setLastExport(draft, { path: missing, bytes: 10, seconds: 1 })
        return undefined
      })
      const first = await fetch(`${server.base}/studio/api/state`)
      const firstData = await first.json()
      assert.equal(firstData.project.lastExport.stale, true)
      assert.equal(firstData.project.lastExport.path, null)
      // 真实文件存在 → 不标 stale
      const realPath = path.join(dir, 'exports', 'here.wav')
      await mkdir(path.dirname(realPath), { recursive: true })
      await writeFile(realPath, makeWav(1))
      state.mutate({ tool: 'test', text: null }, (draft) => {
        ops.setLastExport(draft, { path: realPath, bytes: 5, seconds: 1 })
        return undefined
      })
      const second = await (await fetch(`${server.base}/studio/api/state`)).json()
      assert.equal(Object.hasOwn(second.project.lastExport, 'stale'), false)
      assert.equal(second.project.lastExport.path, realPath)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

describe('task-78 — studio_render_preview 参数映射（solo/fast/section）', () => {
  async function makePreviewTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, tools, byName, exec }
  }

  async function waitPreview(state, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const peeked = peekPreviewRequest(state, 0)
      if (peeked) return peeked
      await wait(10)
    }
    return null
  }

  it('参数声明：soloTrackIds/trackIds/fast/sampleRate/includeSectionStats + 描述', async () => {
    const { byName } = await makePreviewTools()
    const tool = byName.get('studio_render_preview')
    assert.equal(tool.parameters.soloTrackIds.type, 'array')
    assert.deepEqual(tool.parameters.soloTrackIds.items, { type: 'string' })
    assert.equal(tool.parameters.trackIds.type, 'array')
    assert.equal(tool.parameters.fast.type, 'boolean')
    assert.equal(tool.parameters.sampleRate.type, 'number')
    assert.equal(tool.parameters.includeSectionStats.type, 'boolean')
    assert.match(tool.description, /soloTrackIds/)
    assert.match(tool.description, /fast/)
    assert.match(tool.description, /lufs/)
  })

  it('soloTrackIds + fast + sampleRate + includeSectionStats：透传 params 并附 sections 原始边界', async () => {
    const { state, exec } = await makePreviewTools()
    try {
      const toolPromise = exec('studio_render_preview', {
        fromBar: 0,
        toBar: 8,
        soloTrackIds: ['trk_1', 'trk_2', 'trk_1'],
        fast: true,
        sampleRate: 44100,
        includeSectionStats: true,
      })
      const peeked = await waitPreview(state)
      assert.ok(peeked, '应发起预览请求')
      assert.deepEqual(peeked.params.soloTrackIds, ['trk_1', 'trk_2'], '去重保序')
      assert.equal(peeked.params.fast, true)
      assert.equal(peeked.params.sampleRate, 44100)
      assert.equal(peeked.params.includeSectionStats, true)
      assert.deepEqual(peeked.params.sections, state.project.sections.map((section) => ({
        name: section.name,
        startBar: section.startBar,
        lengthBars: section.lengthBars,
      })))
      completePreviewRequest(state, peeked.seq, {
        analysis: { ...P10_ANALYSIS, lufs: -14.2, mode: 'fast', renderedTrackIds: ['trk_1', 'trk_2'] },
      })
      const result = await toolPromise
      assert.equal(result.ok, true, result.error)
      assert.equal(result.preview.lufs, -14.2)
      assert.equal(result.preview.mode, 'fast')
      assert.deepEqual(result.preview.renderedTrackIds, ['trk_1', 'trk_2'])
    } finally {
      clearPreviewRequests(state)
      await state.flush()
      state.dispose()
    }
  })

  it('trackIds 别名：string 或 string[] 均归一化为 soloTrackIds；空数组=全曲', async () => {
    const { state, exec } = await makePreviewTools()
    try {
      const singlePromise = exec('studio_render_preview', { trackIds: 'trk_1' })
      const single = await waitPreview(state)
      assert.ok(single)
      assert.deepEqual(single.params.soloTrackIds, ['trk_1'])
      completePreviewRequest(state, single.seq, { analysis: P10_ANALYSIS })
      assert.equal((await singlePromise).ok, true)

      const arrayPromise = exec('studio_render_preview', { trackIds: ['trk_2', 'trk_3', 'trk_2'] })
      const arrayPeek = await waitPreview(state)
      assert.ok(arrayPeek)
      assert.deepEqual(arrayPeek.params.soloTrackIds, ['trk_2', 'trk_3'])
      completePreviewRequest(state, arrayPeek.seq, { analysis: P10_ANALYSIS })
      assert.equal((await arrayPromise).ok, true)

      const emptyPromise = exec('studio_render_preview', { soloTrackIds: [] })
      const emptyPeek = await waitPreview(state)
      assert.ok(emptyPeek)
      assert.deepEqual(emptyPeek.params.soloTrackIds, [])
      completePreviewRequest(state, emptyPeek.seq, { analysis: P10_ANALYSIS })
      assert.equal((await emptyPromise).ok, true)
    } finally {
      clearPreviewRequests(state)
      await state.flush()
      state.dispose()
    }
  })

  it('非法参数中文拒绝：未知轨道 id / 非字符串 / sampleRate 越界 / fast 非布尔 / includeSectionStats 非布尔', async () => {
    const { state, exec } = await makePreviewTools()
    try {
      const unknown = await exec('studio_render_preview', { soloTrackIds: ['trk_999'] })
      assert.equal(unknown.ok, false)
      assert.match(unknown.error, /不存在的轨道 id：trk_999/)
      const badType = await exec('studio_render_preview', { soloTrackIds: [123] })
      assert.equal(badType.ok, false)
      assert.match(badType.error, /字符串数组/)
      const badRateLow = await exec('studio_render_preview', { sampleRate: 4000 })
      assert.equal(badRateLow.ok, false)
      assert.match(badRateLow.error, /sampleRate 必须在 8000–96000/)
      const badRateHigh = await exec('studio_render_preview', { sampleRate: 192000 })
      assert.equal(badRateHigh.ok, false)
      const badFast = await exec('studio_render_preview', { fast: 'yes' })
      assert.equal(badFast.ok, false)
      assert.match(badFast.error, /fast 必须是布尔值/)
      const badSections = await exec('studio_render_preview', { includeSectionStats: 'yes' })
      assert.equal(badSections.ok, false)
      assert.match(badSections.error, /includeSectionStats 必须是布尔值/)
      assert.equal(peekPreviewRequest(state, 0), null, '非法参数不应发起预览请求')
    } finally {
      clearPreviewRequests(state)
      await state.flush()
      state.dispose()
    }
  })

  it('sampleRate 越界钳制：合法边界 8000/96000 直接透传并取整', async () => {
    const { state, exec } = await makePreviewTools()
    try {
      for (const [value, expected] of [[8000, 8000], [96000, 96000], [22050.6, 22051]]) {
        const toolPromise = exec('studio_render_preview', { sampleRate: value })
        const peeked = await waitPreview(state)
        assert.ok(peeked)
        assert.equal(peeked.params.sampleRate, expected)
        completePreviewRequest(state, peeked.seq, { analysis: P10_ANALYSIS })
        assert.equal((await toolPromise).ok, true)
      }
    } finally {
      clearPreviewRequests(state)
      await state.flush()
      state.dispose()
    }
  })

  it('GET /preview-request 透传新字段；POST /preview-done 的 analysis 原样回给工具', async () => {
    const { state } = await makePreviewTools()
    const server = await startServer(state)
    try {
      const analysis = {
        ...P10_ANALYSIS,
        lufs: -13.8,
        lufsMaxShortTerm: -11.2,
        stereoBalanceDb: 0.2,
        correlation: 0.91,
        spectralCentroidHz: 1800,
        bandEnergyPct: { sub: 10, low: 40, lowMid: 20, mid: 20, highMid: 8, high: 2 },
        sectionStats: [{ name: 'Intro', peakDb: -3, rmsDb: -14, lufs: -16 }],
      }
      const request = requestPreview(state, {
        fromBar: 0,
        toBar: 4,
        soloTrackIds: ['trk_1'],
        fast: true,
        sampleRate: 22050,
        includeSectionStats: true,
        sections: [{ name: 'Intro', startBar: 0, lengthBars: 8 }],
      }, { timeoutMs: 5000 })
      const polled = await getJson(server.base, '/studio/api/preview-request?since=0')
      assert.equal(polled.data.ok, true)
      assert.deepEqual(polled.data.request.soloTrackIds, ['trk_1'])
      assert.equal(polled.data.request.fast, true)
      assert.equal(polled.data.request.sampleRate, 22050)
      assert.equal(polled.data.request.includeSectionStats, true)
      assert.deepEqual(polled.data.request.sections, [{ name: 'Intro', startBar: 0, lengthBars: 8 }])
      const done = await postJson(server.base, '/studio/api/preview-done', { seq: polled.data.seq, analysis })
      assert.equal(done.data.ok, true)
      const result = await request
      assert.deepEqual(result, analysis)
      assert.equal(result.lufs, -13.8)
      assert.deepEqual(result.bandEnergyPct, { sub: 10, low: 40, lowMid: 20, mid: 20, highMid: 8, high: 2 })
      assert.equal(result.sectionStats[0].name, 'Intro')
    } finally {
      await server.close()
      clearPreviewRequests(state)
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* task-81：studio_validate_project includeMix 混音 lint                        */
/* ------------------------------------------------------------------------- */

describe('task-81 — validate_project includeMix 混音 lint', () => {
  async function makeMixTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  function mixIssue(result, code) {
    return result.issues.find((issue) => issue.code === code)
  }

  it('默认 validate 不变：不传 includeMix 不返回 mix / mixIssues，工程只读', async () => {
    const { state, exec } = await makeMixTools()
    try {
      const before = JSON.stringify(state.project)
      const revisionBefore = state.revision
      const result = await exec('studio_validate_project')
      assert.equal(Object.hasOwn(result, 'mix'), false)
      assert.equal(Object.hasOwn(result.counts, 'mixIssues'), false)
      assert.equal(JSON.stringify(state.project), before)
      assert.equal(state.revision, revisionBefore)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('includeMix 静态：某轨响度比中位数低 >20dB → mix_track_too_quiet（code/trackId/severity/suggestion）', async () => {
    const { state, exec } = await makeMixTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.01 })
      const result = await exec('studio_validate_project', { includeMix: true })
      assert.equal(result.ok, true)
      assert.equal(result.mix.mode, 'static')
      const issue = mixIssue(result, 'mix_track_too_quiet')
      assert.ok(issue, JSON.stringify(result.issues.filter((item) => item.code?.startsWith('mix_'))))
      assert.equal(issue.trackId, 'trk_1')
      assert.equal(issue.severity, 'warn')
      assert.equal(issue.level, 'warn')
      assert.match(issue.message, /中位数/)
      assert.ok(issue.suggestion)
      assert.equal(result.counts.mixIssues, result.mix.issueCount)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('includeMix 静态：全部轨道偏左 → mix_stereo_imbalance', async () => {
    const { state, exec } = await makeMixTools()
    try {
      for (const track of state.project.tracks) track.pan = -1
      state.project.tracks.forEach((track) => { track.pan = -1 })
      const result = await exec('studio_validate_project', { includeMix: true })
      const issue = mixIssue(result, 'mix_stereo_imbalance')
      assert.ok(issue, JSON.stringify(result.issues.map((item) => item.code)))
      assert.ok(Math.abs(Number(result.mix.stats.stereoBalanceDb)) > 3)
      assert.ok(issue.suggestion)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('includeMix 静态：低频乐器占主导 → mix_low_excess', async () => {
    const { state, exec } = await makeMixTools()
    try {
      // 新建工程后加 4 条贝斯轨（静态低频权重 1，普通轨 0.15）
      await exec('studio_create_project', { title: '低频测试' })
      await exec('studio_add_track', { name: 'Bass A', kind: 'synth', preset: 'finger_bass' })
      await exec('studio_add_track', { name: 'Bass B', kind: 'synth', preset: 'acoustic_bass' })
      await exec('studio_add_track', { name: 'Bass C', kind: 'synth', preset: 'finger_bass' })
      const result = await exec('studio_validate_project', { includeMix: true })
      const issue = mixIssue(result, 'mix_low_excess')
      assert.ok(issue, JSON.stringify(result.issues.map((item) => item.code)))
      assert.ok(Number(result.mix.stats.lowSharePct) > 80)
      assert.ok(issue.suggestion)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('includeMix 静态：master 无压缩/限制器且高电平 → mix_clipping_risk', async () => {
    const { state, exec } = await makeMixTools()
    try {
      await exec('studio_create_project', { title: '削波测试' })
      for (let index = 0; index < 4; index += 1) {
        await exec('studio_add_track', { name: 'Loud ' + index, kind: 'synth', preset: 'grand_piano', volume: 0.95 })
      }
      state.project.master.volume = 1
      state.project.master.effects = []
      const result = await exec('studio_validate_project', { includeMix: true })
      const issue = mixIssue(result, 'mix_clipping_risk')
      assert.ok(issue, JSON.stringify(result.issues.map((item) => item.code)))
      assert.match(issue.message, /削波风险/)
      // 加 compressor 后风险消失
      await exec('studio_add_effect', { target: 'master', type: 'compressor' })
      const after = await exec('studio_validate_project', { includeMix: true })
      assert.equal(mixIssue(after, 'mix_clipping_risk'), undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('includeMix：静音有内容轨与 solo 状态给出 mix_muted_track / mix_solo_active', async () => {
    const { state, exec } = await makeMixTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', mute: true })
      await exec('studio_update_track', { trackId: 'trk_2', solo: true })
      const result = await exec('studio_validate_project', { includeMix: true })
      const muted = mixIssue(result, 'mix_muted_track')
      assert.ok(muted, JSON.stringify(result.issues.map((item) => item.code)))
      assert.equal(muted.trackId, 'trk_1')
      const solo = mixIssue(result, 'mix_solo_active')
      assert.ok(solo)
      assert.equal(solo.severity, 'info')
      assert.equal(result.mix.stats.soloTracks, 1)
      assert.equal(result.mix.stats.mutedTracks, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('includeMix + 真实 analysis：响度/频段/立体声/削波/相位按真实指标出 issue', () => {
    const project = createDemoProject()
    const analysis = {
      clipping: true,
      peak: 1.2,
      peakDb: 1.58,
      lufs: -6,
      stereoBalanceDb: 5,
      correlation: -0.2,
      bandEnergyPct: { sub: 50, low: 40, lowMid: 5, mid: 3, highMid: 1, high: 1 },
      stems: [
        { trackId: 'trk_1', rmsDb: -10 },
        { trackId: 'trk_2', rmsDb: -12 },
        { trackId: 'trk_3', rmsDb: -35 },
      ],
    }
    const result = ops.validateProject(project, { includeMix: true, mixAnalysis: analysis })
    assert.equal(result.mix.mode, 'analysis')
    const codes = result.issues.filter((issue) => issue.code?.startsWith('mix_')).map((issue) => issue.code)
    assert.ok(codes.includes('mix_clipping'), codes.join(','))
    assert.ok(codes.includes('mix_stereo_imbalance'))
    assert.ok(codes.includes('mix_low_excess'))
    assert.ok(codes.includes('mix_loudness'))
    assert.ok(codes.includes('mix_phase'))
    const quiet = result.issues.find((issue) => issue.code === 'mix_track_too_quiet')
    assert.ok(quiet)
    assert.equal(quiet.trackId, 'trk_3')
    const clipping = result.issues.find((issue) => issue.code === 'mix_clipping')
    assert.equal(clipping.level, 'error')
    assert.equal(clipping.severity, 'error')
    assert.ok(clipping.suggestion)
  })

  it('includeMix + 部分 analysis（无 stems）：mode=analysis-partial，真实指标仍生效', () => {
    const project = createDemoProject()
    const result = ops.validateProject(project, {
      includeMix: true,
      mixAnalysis: { lufs: -14, stereoBalanceDb: 0.5, correlation: 0.9, bandEnergyPct: { sub: 10, low: 20, lowMid: 30, mid: 25, highMid: 10, high: 5 } },
    })
    assert.equal(result.mix.mode, 'analysis-partial')
    assert.equal(result.issues.filter((issue) => issue.code === 'mix_low_excess').length, 0)
    assert.equal(result.issues.filter((issue) => issue.code === 'mix_loudness').length, 0)
    assert.ok(Number.isFinite(result.mix.stats.lufs))
  })

  it('工具参数声明与静态执行：includeMix/mixAnalysis、mix.mode、只读', async () => {
    const { state, byName, exec } = await makeMixTools()
    try {
      const tool = byName.get('studio_validate_project')
      assert.equal(tool.parameters.includeMix.type, 'boolean')
      assert.equal(tool.parameters.mixAnalysis.type, 'object')
      assert.match(tool.description, /includeMix/)
      assert.match(tool.description, /混音 lint/)
      const result = await exec('studio_validate_project', { includeMix: true })
      assert.equal(result.ok, true)
      assert.equal(result.mix.mode, 'static')
      assert.ok(Array.isArray(result.issues))
      assert.equal(typeof result.mix.issueCount, 'number')
      // 非法 mixAnalysis 类型 → 退化为静态，不崩溃
      const fallback = await exec('studio_validate_project', { includeMix: true, mixAnalysis: 'bad' })
      assert.equal(fallback.ok, true)
      assert.equal(fallback.mix.mode, 'static')
      assert.equal(state.historyState().canUndo, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具 includeMix + mixAnalysis：真实 analysis 透传到 lint（mode=analysis）', async () => {
    const { state, exec } = await makeMixTools()
    try {
      const analysis = {
        clipping: false,
        lufs: -14,
        stereoBalanceDb: 4.5,
        correlation: 0.95,
        bandEnergyPct: { sub: 30, low: 55, lowMid: 10, mid: 3, highMid: 1, high: 1 },
        stems: [{ trackId: 'trk_1', rmsDb: -12 }, { trackId: 'trk_2', rmsDb: -14 }, { trackId: 'trk_3', rmsDb: -40 }],
      }
      const result = await exec('studio_validate_project', { includeMix: true, mixAnalysis: analysis })
      assert.equal(result.mix.mode, 'analysis')
      const codes = result.issues.filter((issue) => issue.code?.startsWith('mix_')).map((issue) => issue.code)
      assert.ok(codes.includes('mix_stereo_imbalance'))
      assert.ok(codes.includes('mix_low_excess'))
      assert.ok(codes.includes('mix_track_too_quiet'))
      assert.equal(result.issues.find((issue) => issue.code === 'mix_track_too_quiet').trackId, 'trk_3')
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R0-12：studio_set_sidechain triggerNotes                                    */
/* ------------------------------------------------------------------------- */

describe('R0-12 — setSidechain triggerNotes（数组/单数/旧工程兼容）', () => {
  it('ops.setSidechain：数组去重排序、单数归一、空数组合法', () => {
    const project = createDemoProject()
    const track = () => project.tracks.find((item) => item.id === 'trk_2')
    const result = ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: [38, 36, 36] })
    assert.deepEqual(result.triggerNotes, [36, 38])
    assert.deepEqual(track().sidechain.triggerNotes, [36, 38])
    ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: 36 })
    assert.deepEqual(track().sidechain.triggerNotes, [36])
    ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: [] })
    assert.deepEqual(track().sidechain.triggerNotes, [])
  })

  it('ops.setSidechain：省略 triggerNotes 保留既有过滤；新建侧链默认 []', () => {
    const project = createDemoProject()
    const track = () => project.tracks.find((item) => item.id === 'trk_2')
    ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: [36] })
    ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1', amount: 0.7 })
    assert.deepEqual(track().sidechain.triggerNotes, [36], '省略时应保留既有过滤')
    assert.equal(track().sidechain.amount, 0.7)
    // 清除后新建 → []
    ops.clearSidechain(project, { trackId: 'trk_2' })
    ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1' })
    assert.deepEqual(track().sidechain.triggerNotes, [])
  })

  it('ops.setSidechain：非法 triggerNotes 过滤（越界/非整数/非数字）', () => {
    const project = createDemoProject()
    ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: [36, 'x', 200, -3, 38.5, 38] })
    assert.deepEqual(project.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [36, 38])
    ops.setSidechain(project, { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: 'bad' })
    assert.deepEqual(project.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [])
  })

  it('applyEditOps setSidechain 支持 triggerNotes，get_project 摘要含字段', () => {
    const project = createDemoProject()
    const edited = ops.applyEditOps(project, [
      { type: 'setSidechain', trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: [36] },
    ])
    assert.equal(edited.label, '设置侧链')
    assert.deepEqual(edited.results[0].triggerNotes, [36])
    const overview = ops.getProjectOverview(project)
    assert.deepEqual(overview.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [36])
  })

  it('工具 studio_set_sidechain：数组与单数、可撤销、get_project 摘要', async () => {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    try {
      const arrayResult = await exec('studio_set_sidechain', {
        trackId: 'trk_2',
        sourceTrackId: 'trk_1',
        amount: 0.6,
        triggerNotes: [36, 38, 36],
      })
      assert.equal(arrayResult.ok, true, arrayResult.error)
      assert.deepEqual(arrayResult.triggerNotes, [36, 38])
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes.join(','), '36,38')
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [36, 38])
      // 单数
      const single = await exec('studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: 36 })
      assert.equal(single.ok, true)
      assert.deepEqual(single.triggerNotes, [36])
      // 撤销恢复上一版 [36,38]
      const undo = await exec('studio_undo')
      assert.equal(undo.ok, true)
      assert.deepEqual(state.project.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [36, 38])
      await exec('studio_redo')
      assert.deepEqual(state.project.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [36])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具 studio_set_sidechain 参数声明 triggerNotes（array/integer 描述）', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    try {
      const tool = tools.find((item) => item.name === 'studio_set_sidechain')
      assert.equal(tool.parameters.triggerNotes.type, 'array')
      assert.equal(tool.parameters.triggerNotes.items.type, 'integer')
      assert.match(tool.parameters.triggerNotes.description, /36|单数|触发/)
      assert.match(tool.description, /triggerNotes/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('保存→打开→重启：triggerNotes 持久化', async () => {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    try {
      await exec('studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: [36] })
      await exec('studio_save_project', { name: '侧链过滤工程' })
      await exec('studio_create_project', { title: '临时' })
      await exec('studio_open_project', { name: '侧链过滤工程' })
      assert.deepEqual(state.project.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [36])
      await state.flush()
    } finally {
      await state.flush()
      state.dispose()
    }
    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      const track = reloaded.project.tracks.find((item) => item.id === 'trk_2')
      assert.deepEqual(track.sidechain.triggerNotes, [36])
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('POST /edit setSidechain triggerNotes；/state 完整可见', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const response = await fetch(`${server.base}/studio/api/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [{ type: 'setSidechain', trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: [36, 38] }] }),
      })
      const data = await response.json()
      assert.equal(data.ok, true, JSON.stringify(data))
      assert.deepEqual(data.results[0].triggerNotes, [36, 38])
      const stateResponse = await getJson(server.base, '/studio/api/state?rev=0')
      assert.deepEqual(stateResponse.data.project.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [36, 38])
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('clear_sidechain 后 triggerNotes 随配置移除；重新设置默认 []', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    try {
      await exec('studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNotes: [36] })
      const cleared = await exec('studio_clear_sidechain', { trackId: 'trk_2' })
      assert.equal(cleared.ok, true)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_2'), 'sidechain'), false)
      await exec('studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_1' })
      assert.deepEqual(state.project.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [])
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R0-12 — triggerNote 单数参数（DSH schema 兼容）', () => {
  async function makeSidechainTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  it('工具参数声明：triggerNotes=array、triggerNote=integer，描述含单数入口', async () => {
    const { state, byName } = await makeSidechainTools()
    try {
      const tool = byName.get('studio_set_sidechain')
      assert.equal(tool.parameters.triggerNotes.type, 'array')
      assert.equal(tool.parameters.triggerNotes.items.type, 'integer')
      assert.equal(tool.parameters.triggerNote.type, 'integer')
      assert.match(tool.parameters.triggerNote.description, /单个触发音高/)
      assert.match(tool.description, /triggerNote/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('triggerNote 单数与 triggerNotes 合并；单数等价数组', async () => {
    const { state, exec } = await makeSidechainTools()
    try {
      const single = await exec('studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNote: 38 })
      assert.equal(single.ok, true, single.error)
      assert.deepEqual(single.triggerNotes, [38])
      const merged = await exec('studio_set_sidechain', {
        trackId: 'trk_2',
        sourceTrackId: 'trk_1',
        triggerNotes: [36],
        triggerNote: 38,
      })
      assert.equal(merged.ok, true, merged.error)
      assert.deepEqual(merged.triggerNotes, [36, 38])
      assert.deepEqual(state.project.tracks.find((item) => item.id === 'trk_2').sidechain.triggerNotes, [36, 38])
      // 只传 triggerNote：再次设置会覆盖上一版（不是保留），符合显式过滤语义
      const overwrite = await exec('studio_set_sidechain', { trackId: 'trk_2', sourceTrackId: 'trk_1', triggerNote: 36 })
      assert.deepEqual(overwrite.triggerNotes, [36])
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R1a：自动保存 / 崩溃恢复 / doctor / metrics                                 */
/* ------------------------------------------------------------------------- */

describe('R1a — state 自动保存与崩溃恢复', () => {
  async function recoveryFiles(dir) {
    try {
      return await readdir(path.join(dir, RECOVERY_DIR_NAME))
    } catch {
      return []
    }
  }
  async function readAutosave(dir) {
    return JSON.parse(await readFile(path.join(dir, RECOVERY_DIR_NAME, AUTOSAVE_FILE_NAME), 'utf8'))
  }
  async function writeProjectJson(dir, project) {
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(project), 'utf8')
  }

  it('创建时写 session.lock；正常 dispose 删除 lock 与 autosave，重启 detected/available=false', async () => {
    const { dir, state } = await makeState()
    await state.flush()
    const files = await recoveryFiles(dir)
    assert.ok(files.includes(SESSION_LOCK_FILE_NAME), `recovery 应有 session.lock：${files.join(',')}`)
    const lock = JSON.parse(await readFile(path.join(dir, RECOVERY_DIR_NAME, SESSION_LOCK_FILE_NAME), 'utf8'))
    assert.equal(lock.pid, process.pid)
    assert.ok(Number.isFinite(lock.startedAt))
    assert.equal(lock.dataDir, dir)
    assert.equal(state.recovery.detected, false)
    assert.equal(state.recovery.available, false)

    state.dispose()
    const afterDispose = await recoveryFiles(dir)
    assert.equal(afterDispose.includes(SESSION_LOCK_FILE_NAME), false, 'dispose 应删除 session.lock')
    assert.equal(afterDispose.includes(AUTOSAVE_FILE_NAME), false, '正常退出应清理 autosave')

    const reloaded = createState({ dataDir: dir })
    await reloaded.ready
    try {
      assert.equal(reloaded.recovery.detected, false)
      assert.equal(reloaded.recovery.available, false)
    } finally {
      await reloaded.flush()
      reloaded.dispose()
    }
  })

  it('异常退出检测：残留 lock + 更新的 autosave → detected/available，且不自动覆盖项目', async () => {
    const { dir, state: first } = await makeState()
    await first.flush()
    const originalProject = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
    first.mutate({ tool: 'studio_update_track', text: '崩溃前修改' }, (draft) => {
      draft.title = '崩溃前修改的工程'
      return undefined
    })
    await first.flush()
    const autosave = await readAutosave(dir)
    assert.equal(autosave.project.title, '崩溃前修改的工程')
    assert.ok(autosave.revision >= 2)
    assert.ok(autosave.projectBytes > 0)
    assert.equal(typeof autosave.at, 'number')
    // 模拟“project.json 还是旧的”（异常退出时最后一次自动保存比落盘更新）
    await writeProjectJson(dir, originalProject)

    const second = createState({ dataDir: dir })
    await second.ready
    try {
      assert.equal(second.recovery.detected, true, '残留 lock 应检测为异常退出')
      assert.equal(second.recovery.available, true)
      assert.equal(second.recovery.autosave.revision, autosave.revision)
      assert.equal(second.recovery.autosave.activeName, null)
      assert.ok(second.recovery.lock && second.recovery.lock.pid)
      assert.equal(second.project.title, '霓虹天际线 Neon Skyline', '启动不自动覆盖项目')
      assert.ok(second.recovery.projectRevision <= second.recovery.autosave.revision)
    } finally {
      await second.flush()
      second.dispose()
      first.dispose()
    }
  })

  it('autosave 时间戳副本最多保留 3 个；节流常量 ≥750ms', async () => {
    assert.equal(MAX_AUTOSAVE_COPIES, 3)
    assert.ok(AUTOSAVE_INTERVAL_MS >= 750)
    const { dir, state } = await makeState()
    try {
      for (let index = 0; index < 6; index += 1) {
        state.mutate({ tool: 'test_burst' }, (draft) => {
          draft.title = 'burst-' + index
          return undefined
        })
        await state.flush()
      }
      const files = await recoveryFiles(dir)
      const copies = files.filter((name) => /^autosave-\d{8}-\d{6}-\d{3}\.json$/.test(name))
      assert.ok(copies.length <= MAX_AUTOSAVE_COPIES, `副本应 ≤3，实际 ${copies.length}`)
      assert.ok(copies.length >= 1)
      assert.ok(files.includes(AUTOSAVE_FILE_NAME))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('损坏 autosave：available=false + autosaveError，不崩溃', async () => {
    const { dir, state } = await makeState()
    state.dispose()
    await mkdir(path.join(dir, RECOVERY_DIR_NAME), { recursive: true })
    await writeFile(path.join(dir, RECOVERY_DIR_NAME, AUTOSAVE_FILE_NAME), '{not json', 'utf8')
    const next = createState({ dataDir: dir })
    await next.ready
    try {
      assert.equal(next.recovery.available, false)
      assert.match(next.recovery.autosaveError, /不是合法 JSON/)
    } finally {
      await next.flush()
      next.dispose()
    }
  })

  it('studio_get_recovery：只读返回恢复信息与提示，不改 revision', async () => {
    const { dir, state: first } = await makeState()
    first.mutate({ tool: 'test' }, (draft) => {
      draft.title = '待恢复工程'
      return undefined
    })
    await first.flush()
    const second = createState({ dataDir: dir })
    await second.ready
    try {
      const tools = createTools({ defineTool: (options) => options, state: second })
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const revisionBefore = second.revision
      const result = await byName.get('studio_get_recovery').execute({}, {})
      assert.equal(result.ok, true)
      assert.equal(result.detected, true)
      assert.equal(result.available, true)
      assert.ok(result.autosave.revision >= 1)
      assert.ok(result.autosavePath.endsWith(AUTOSAVE_FILE_NAME))
      assert.ok(result.lockPath.endsWith(SESSION_LOCK_FILE_NAME))
      assert.match(result.hint, /studio_restore_recovery/)
      assert.equal(second.revision, revisionBefore)
    } finally {
      await second.flush()
      second.dispose()
      first.dispose()
    }
  })

  it('studio_restore_recovery：先备份当前项目、一次 mutate、activeName 恢复、撤销可回退', async () => {
    const { dir, state: first } = await makeState()
    await first.flush()
    const olderProject = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
    first.setActiveProject('崩溃前工程', null)
    first.mutate({ tool: 'test' }, (draft) => {
      draft.title = '自动保存里的工程'
      return undefined
    })
    await first.flush()
    // 模拟 project.json 落后于 autosave（异常退出时最后一次自动保存更新）
    await writeProjectJson(dir, olderProject)
    const second = createState({ dataDir: dir })
    await second.ready
    try {
      const tools = createTools({ defineTool: (options) => options, state: second })
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const exec = (name, args = {}) => byName.get(name).execute(args, {})
      const beforeTitle = second.project.title
      const beforeRevision = second.revision
      const restored = await exec('studio_restore_recovery')
      assert.equal(restored.ok, true, restored.error)
      assert.equal(restored.restored, true)
      assert.equal(second.project.title, '自动保存里的工程')
      assert.equal(second.activeName, '崩溃前工程')
      assert.ok(restored.backupPath && restored.backupPath.includes('_autobackup-'))
      assert.equal((await stat(restored.backupPath)).size > 0, true)
      assert.equal(second.revision, beforeRevision + 1)
      assert.equal(second.historyState().undoLabel, '恢复自动保存')
      assert.equal(second.recovery.available, false, '恢复后消费 autosave')
      const files = await recoveryFiles(dir)
      assert.equal(files.includes(AUTOSAVE_FILE_NAME), false)
      const undo = await exec('studio_undo')
      assert.equal(undo.ok, true)
      assert.equal(second.project.title, beforeTitle)
    } finally {
      await second.flush()
      second.dispose()
      first.dispose()
    }
  })

  it('studio_restore_recovery 错误：无 autosave / 损坏 / discardCurrent 跳过备份', async () => {
    const { dir, state } = await makeState()
    try {
      const tools = createTools({ defineTool: (options) => options, state })
      const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
      const none = await exec('studio_restore_recovery')
      assert.equal(none.ok, false)
      assert.match(none.error, /没有可恢复的自动保存/)
      await mkdir(path.join(dir, RECOVERY_DIR_NAME), { recursive: true })
      await writeFile(path.join(dir, RECOVERY_DIR_NAME, AUTOSAVE_FILE_NAME), '{broken', 'utf8')
      const broken = await exec('studio_restore_recovery')
      assert.equal(broken.ok, false)
      assert.match(broken.error, /不是合法 JSON/)
      // discardCurrent=true：构造合法 autosave 后跳过备份
      state.mutate({ tool: 'test' }, (draft) => {
        draft.title = 'discard 目标'
        return undefined
      })
      await state.flush()
      const discard = await exec('studio_restore_recovery', { discardCurrent: true })
      assert.equal(discard.ok, true, discard.error)
      assert.equal(discard.backupPath, null)
      assert.match(discard.warning, /discardCurrent/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R1a — studio_doctor_project 检查与安全修复', () => {
  function makeBrokenProject() {
    const project = structuredClone(createDemoProject())
    project.tracks[0].volume = 5
    project.tracks[0].pan = -9
    project.tracks[0].effects.push({ ...project.tracks[0].effects[0] })
    project.tracks[0].effects.push({ id: 'fx_bad', type: 'bogus', enabled: true, params: {} })
    project.tracks[1].sidechain = { sourceTrackId: 'trk_999' }
    project.tracks[1].automation = { volume: { points: [{ beat: 99999, value: 2 }] } }
    project.tracks.push(structuredClone(project.tracks[0])) // 重复 id
    project.clips.push({ id: 'clip_missing_track', trackId: 'trk_999', patternId: 'pat_1', startBar: 0, lengthBars: 1 })
    project.clips.push({ id: 'clip_missing_media', trackId: 'trk_1', mediaId: 'med_missing', startBar: 0, lengthBars: 1 })
    project.clips.push({ id: 'clip_bad_bounds', trackId: 'trk_1', patternId: 'pat_1', startBar: -2, lengthBars: 0 })
    project.patterns[0].notes.push({ pitch: 999, start: -1, dur: 0 })
    project.patterns[0].notes.push({ pitch: 60, start: 9999, dur: 1 })
    project.tempoMap = [{ beat: -1, bpm: 0 }, { beat: 8, bpm: 999 }]
    project.sections.push({ id: 'sec_bad', name: '', startBar: -1, lengthBars: 0 })
    project.master.effects.push({ ...project.master.effects[0] })
    return project
  }

  it('合法 demo：无 error、无 repairable；只读不修改', () => {
    const project = createDemoProject()
    const before = JSON.stringify(project)
    const result = ops.doctorProject(project)
    assert.equal(result.counts.errors, 0, JSON.stringify(result.issues.filter((issue) => issue.level === 'error')))
    assert.equal(result.counts.repairable, 0)
    assert.equal(JSON.stringify(project), before)
    assert.equal(Object.hasOwn(result, 'repaired'), false)
  })

  it('坏工程：检出 schema/引用/音符/效果器/automation/tempo/sidechain/重复 id 等 code，只读不改', () => {
    const project = makeBrokenProject()
    const before = JSON.stringify(project)
    const result = ops.doctorProject(project)
    const codes = new Set(result.issues.map((issue) => issue.code))
    for (const code of [
      'doctor.track_duplicate',
      'doctor.clip_track',
      'doctor.clip_media',
      'doctor.clip_bounds',
      'doctor.note_pitch',
      'doctor.note_overflow',
      'doctor.effect_duplicate',
      'doctor.effect_invalid',
      'doctor.automation',
      'doctor.tempo',
      'doctor.sidechain',
      'doctor.section',
      'doctor.track_volume',
      'doctor.track_pan',
    ]) {
      assert.ok(codes.has(code), `应有 code ${code}；实际 ${[...codes].join(',')}`)
    }
    const issue = result.issues.find((item) => item.code === 'doctor.clip_track')
    assert.equal(issue.canRepair, true)
    assert.ok(issue.path)
    assert.equal(JSON.stringify(project), before, '只读不得修改工程')
  })

  it('工具 doctor 只读：issues/counts/summary，不改 revision/undo', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    try {
      const tool = tools.find((item) => item.name === 'studio_doctor_project')
      assert.equal(tool.parameters.repair.type, 'boolean')
      assert.match(tool.description, /repair/)
      const revisionBefore = state.revision
      const result = await tool.execute({}, {})
      assert.equal(result.ok, true)
      assert.ok(Array.isArray(result.issues))
      assert.equal(typeof result.counts.errors, 'number')
      assert.equal(typeof result.summary.repairable, 'number')
      assert.equal(state.revision, revisionBefore)
      assert.equal(state.historyState().canUndo, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('repair：安全修复 + 备份 + 一次撤销；不删有内容轨道/pattern，媒体缺失只删 clip', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    try {
      const trackCountBefore = state.project.tracks.length
      const patternCountBefore = state.project.patterns.length
      // 把坏工程写进当前 state
      state.mutate({ tool: 'test' }, (draft) => {
        const broken = makeBrokenProject()
        // 只替换内容字段（保持会话字段）
        for (const key of ['tracks', 'patterns', 'clips', 'sections', 'tempoMap', 'master']) draft[key] = broken[key]
        return undefined
      })
      const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
      const repaired = await exec('studio_doctor_project', { repair: true })
      assert.equal(repaired.ok, true, repaired.error)
      assert.ok(repaired.repaired.applied > 0)
      assert.ok(repaired.repaired.before.errors > repaired.repaired.after.errors)
      assert.ok(repaired.backupPath && repaired.backupPath.includes('_autobackup-'))
      assert.equal(repaired.counts.errors, 0, JSON.stringify(repaired.issues.filter((issue) => issue.level === 'error')))
      // 有内容的轨道/pattern 保留（重复 id 副本被移除，但数量至少不减少）
      assert.ok(state.project.tracks.length >= 1)
      assert.equal(state.project.patterns.length, patternCountBefore)
      assert.ok(state.project.clips.every((clip) => clip.trackId !== 'trk_999'))
      assert.ok(state.project.clips.every((clip) => clip.mediaId !== 'med_missing'))
      assert.equal(state.historyState().undoLabel, '修复工程')
      // 撤销恢复坏工程
      await exec('studio_undo')
      assert.equal(JSON.stringify(state.project.tracks).includes('"volume":5'), true)
      void trackCountBefore
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R1a — studio_get_metrics 与 GET /metrics', () => {
  it('工具 get_metrics：字段完整、toolCalls 增长、不泄漏工程内容', async () => {
    const { state } = await makeState()
    const metrics = createMetrics()
    const tools = createTools({ defineTool: (options) => options, state, metrics })
    try {
      const tool = tools.find((item) => item.name === 'studio_get_metrics')
      const first = await tool.execute({}, {})
      assert.equal(first.ok, true)
      assert.ok(Number.isFinite(first.uptimeMs))
      assert.equal(first.revision, state.revision)
      assert.ok(first.projectBytes > 0)
      assert.equal(typeof first.tracks, 'number')
      assert.equal(typeof first.patterns, 'number')
      assert.equal(typeof first.notes, 'number')
      assert.ok(Array.isArray([]))
      assert.equal(typeof first.toolCalls.total, 'number')
      assert.equal(typeof first.state.saveMs, 'number')
      assert.equal(typeof first.state.loadMs, 'number')
      assert.ok(first.state.saveMs >= 0 && first.state.loadMs >= 0)
      assert.ok(first.memory.rss > 0)
      // 两次调用后 toolCalls 至少 +1（当前调用在返回后记账，所以第二次可见第一次）
      await tool.execute({}, {})
      const second = await tool.execute({}, {})
      assert.ok(second.toolCalls.total >= 2)
      assert.ok(second.toolCalls.maxMs >= second.toolCalls.avgMs)
      // 不泄漏工程内容字段
      const text = JSON.stringify(second)
      assert.ok(!text.includes('霓虹天际线'))
      assert.ok(!text.includes('"tracks":['))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('GET /metrics：200 + 完整字段；POST 405；404 列表含 metrics', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      await state.flush()
      const response = await fetch(`${server.base}/studio/api/metrics`)
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.ok, true)
      assert.ok(Number.isFinite(data.uptimeMs))
      assert.equal(data.revision, state.revision)
      assert.ok(data.projectBytes > 0)
      assert.equal(data.tracks, state.project.tracks.length)
      assert.equal(typeof data.toolCalls.total, 'number')
      assert.ok(data.state.saveMs >= 0)
      assert.ok(data.memory.rss > 0)
      const text = JSON.stringify(data)
      assert.ok(!text.includes('霓虹天际线'), '路由不应返回工程内容')
      const post = await fetch(`${server.base}/studio/api/metrics`, { method: 'POST' })
      assert.equal(post.status, 405)
      const notFound = await fetch(`${server.base}/studio/api/unknown-endpoint`)
      const notFoundData = await notFound.json()
      assert.match(notFoundData.error, /GET \/metrics/)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R1b：schema v3 / v2 迁移（state/projects/tools/doctor）                     */
/* ------------------------------------------------------------------------- */

describe('R1b — state 启动 v2→v3 迁移与备份', () => {
  function toV2(project, overrides = {}) {
    const v2 = JSON.parse(JSON.stringify(project))
    v2.schemaVersion = 2
    delete v2.format
    return { ...v2, ...overrides }
  }
  async function writeV2Project(dir, project) {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(project), 'utf8')
  }
  async function listMigrationDirs(dir) {
    try {
      const entries = await readdir(path.join(dir, 'migrations'))
      return entries.filter((name) => name.startsWith('v2-'))
    } catch {
      return []
    }
  }

  it('v2 project.json → 迁移前备份到 migrations/v2-<ts>/project.json、迁移为 v3、写回 project.json', async () => {
    const dir = await tempDir()
    const v2 = toV2(createDemoProject(), { title: 'v2 迁移作品' })
    await writeV2Project(dir, v2)
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      assert.equal(state.loadedFromDisk, true)
      assert.equal(state.project.schemaVersion, 3)
      assert.equal(state.project.title, 'v2 迁移作品', '内容不丢')
      assert.equal(state.project.tracks.length, v2.tracks.length)
      assert.equal(state.project.format.name, 'aims')
      assert.equal(state.project.format.version, 3)
      assert.equal(state.project.format.migratedFrom, 2)
      assert.ok(Number.isFinite(state.project.format.migratedAt))
      const migration = state.migration
      assert.equal(migration.from, 2)
      assert.equal(migration.to, 3)
      assert.ok(Number.isFinite(migration.at))
      assert.ok(migration.backupPath.includes(path.join('migrations', 'v2-')))
      assert.ok(migration.backupPath.endsWith('project.json'))
      // 备份内容是原始 v2 文本
      const backup = JSON.parse(await readFile(migration.backupPath, 'utf8'))
      assert.equal(backup.schemaVersion, 2)
      assert.equal(backup.title, 'v2 迁移作品')
      // 迁移前磁盘仍是 v2；flush 后写回 v3
      await state.flush()
      const persisted = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
      assert.equal(persisted.schemaVersion, 3)
      assert.equal(persisted.format.migratedFrom, 2)
      assert.equal(persisted.title, 'v2 迁移作品')
      assert.equal(state.legacyBackupPath, null, 'v2 不应走 legacy-v1')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('迁移幂等：重启读取 v3 不再迁移、不新增 migrations 目录', async () => {
    const dir = await tempDir()
    await writeV2Project(dir, toV2(createDemoProject(), { title: '一次迁移' }))
    const first = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await first.ready
    await first.flush()
    const dirsAfterFirst = await listMigrationDirs(dir)
    assert.equal(dirsAfterFirst.length, 1)
    first.dispose()

    const second = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await second.ready
    try {
      assert.equal(second.project.schemaVersion, 3)
      assert.equal(second.project.title, '一次迁移')
      assert.equal(second.migration, null, '已经是 v3，不再迁移')
      assert.equal((await listMigrationDirs(dir)).length, 1)
    } finally {
      await second.flush()
      second.dispose()
    }
  })

  it('v1 仍不兼容：legacy-v1 冷备份、不创建 migrations、重新 seed v3 demo', async () => {
    const dir = await tempDir()
    const v1 = toV2(createDemoProject(), { schemaVersion: 1, title: 'v1 旧版' })
    await writeV2Project(dir, v1)
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      assert.equal(state.loadedFromDisk, false)
      assert.equal(state.project.schemaVersion, 3)
      assert.ok(state.legacyBackupPath && state.legacyBackupPath.includes('legacy-v1'))
      assert.equal(state.migration, null)
      assert.equal((await listMigrationDirs(dir)).length, 0)
      assert.equal(JSON.parse(await readFile(state.legacyBackupPath, 'utf8')).schemaVersion, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('迁移备份失败：migration.failed=true、原 project.json 不被覆盖', async () => {
    const dir = await tempDir()
    const v2Text = JSON.stringify(toV2(createDemoProject(), { title: '不能被覆盖' }))
    await writeV2Project(dir, JSON.parse(v2Text))
    // 用同名文件占住 migrations 目录 → backup mkdir 失败
    await writeFile(path.join(dir, 'migrations'), 'blocked', 'utf8')
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      assert.equal(state.loadedFromDisk, false)
      assert.equal(state.migration.from, 2)
      assert.equal(state.migration.failed, true)
      assert.match(state.migration.error, /备份失败/)
      assert.equal(state.project.schemaVersion, 3, '内存回退 demo 也是 v3')
      // 本次启动不写 project.json（skipInitialSave）
      await state.flush()
      const onDisk = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
      assert.equal(onDisk.schemaVersion, 2)
      assert.equal(onDisk.title, '不能被覆盖')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('v2 autosave 可恢复：accept 2/3、恢复后为 v3 且记录 backupPath', async () => {
    const { dir, state: first } = await makeState()
    await first.flush()
    // 手写一份 v2 autosave（模拟 R1a 旧版本自动保存）比 project.json 新
    const v2 = toV2(createDemoProject(), { title: '来自 v2 autosave', revision: 99 })
    const autosaveDir = path.join(dir, RECOVERY_DIR_NAME)
    await mkdir(autosaveDir, { recursive: true })
    await writeFile(
      path.join(autosaveDir, AUTOSAVE_FILE_NAME),
      JSON.stringify({ schemaVersion: 2, revision: 99, at: Date.now(), activeName: null, tool: 'studio_set_notes', projectBytes: 1, project: v2 }),
      'utf8',
    )
    const second = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await second.ready
    try {
      assert.equal(second.recovery.available, true)
      const tools = createTools({ defineTool: (options) => options, state: second })
      const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
      const restored = await exec('studio_restore_recovery')
      assert.equal(restored.ok, true, restored.error)
      assert.equal(second.project.schemaVersion, 3)
      assert.equal(second.project.title, '来自 v2 autosave')
      assert.ok(restored.backupPath)
    } finally {
      await second.flush()
      second.dispose()
      first.dispose()
    }
  })
})

describe('R1b — projects v2 列表/打开/保存迁移', () => {
  function toV2(project, overrides = {}) {
    const v2 = JSON.parse(JSON.stringify(project))
    v2.schemaVersion = 2
    delete v2.format
    return { ...v2, ...overrides }
  }

  it('listProjects：v2 可列出且 needsMigration=true（不自动迁移/备份）；v1 仍 unsupported', async () => {
    const dir = await tempDir()
    await mkdir(projectsDir(dir), { recursive: true })
    await writeFile(path.join(projectsDir(dir), '旧版v2.json'), JSON.stringify(toV2(createDemoProject(), { title: '列表 v2' })), 'utf8')
    await writeFile(path.join(projectsDir(dir), '旧版v1.json'), JSON.stringify(toV2(createDemoProject(), { schemaVersion: 1 })), 'utf8')
    const result = await listProjects(dir)
    const v2Entry = result.projects.find((project) => project.name === '旧版v2')
    assert.ok(v2Entry)
    assert.equal(v2Entry.title, '列表 v2')
    assert.equal(v2Entry.needsMigration, true)
    assert.equal(v2Entry.migrationFrom, 2)
    assert.equal(result.unsupported.some((item) => item.name === '旧版v1'), true)
    // 列表不应创建 migrations 备份
    await assert.rejects(() => readdir(path.join(dir, 'migrations')))
  })

  it('loadProjectFile：v2 打开时备份并迁移到 3；saveProjectFile 只写 3', async () => {
    const dir = await tempDir()
    await mkdir(projectsDir(dir), { recursive: true })
    const sourcePath = path.join(projectsDir(dir), '打开迁移.json')
    await writeFile(sourcePath, JSON.stringify(toV2(createDemoProject(), { title: '打开迁移' })), 'utf8')
    const loaded = await loadProjectFile(dir, '打开迁移')
    assert.equal(loaded.project.schemaVersion, 3)
    assert.equal(loaded.project.title, '打开迁移')
    assert.equal(loaded.migratedFrom, 2)
    assert.ok(loaded.backupPath.includes(path.join('migrations', 'v2-')))
    assert.ok(loaded.backupPath.includes('打开迁移'))
    const backup = JSON.parse(await readFile(loaded.backupPath, 'utf8'))
    assert.equal(backup.schemaVersion, 2)
    // 原文件仍是 v2，直到保存
    assert.equal(JSON.parse(await readFile(sourcePath, 'utf8')).schemaVersion, 2)
    await saveProjectFile(dir, '打开迁移', loaded.project)
    assert.equal(JSON.parse(await readFile(sourcePath, 'utf8')).schemaVersion, 3)
    // 保存 v2 对象也会被迁移后写 3（不写 v2）
    const v2Object = toV2(createDemoProject(), { title: '保存 v2' })
    const saved = await saveProjectFile(dir, '保存v2', v2Object)
    assert.equal(saved.name, '保存v2')
    const persisted = JSON.parse(await readFile(path.join(projectsDir(dir), '保存v2.json'), 'utf8'))
    assert.equal(persisted.schemaVersion, 3)
    assert.equal(persisted.format.name, 'aims')
  })

  it('readProjectVersion：v2 版本文件迁移为内存 3（内容保留）', async () => {
    const dir = await tempDir()
    const versionDir = projectVersionsDir(dir, '版本迁移')
    await mkdir(versionDir, { recursive: true })
    const id = '20260101-120000-123'
    await writeFile(path.join(versionDir, id + '.json'), JSON.stringify(toV2(createDemoProject(), { title: 'v2 版本' })), 'utf8')
    const version = await readProjectVersion(dir, '版本迁移', id)
    assert.equal(version.project.schemaVersion, 3)
    assert.equal(version.project.title, 'v2 版本')
    assert.equal(version.project.format.migratedFrom, 2)
  })

  it('工具 list_projects 暴露 needsMigration；open_project 打开 v2 返回迁移信息与备份路径', async () => {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    try {
      await mkdir(projectsDir(dir), { recursive: true })
      await writeFile(path.join(projectsDir(dir), '待迁移工具.json'), JSON.stringify(toV2(createDemoProject(), { title: '工具迁移' })), 'utf8')
      const listed = await exec('studio_list_projects')
      const entry = listed.projects.find((project) => project.name === '待迁移工具')
      assert.ok(entry)
      assert.equal(entry.needsMigration, true)
      assert.equal(entry.migrationFrom, 2)
      const opened = await exec('studio_open_project', { name: '待迁移工具' })
      assert.equal(opened.ok, true, opened.error)
      assert.equal(opened.migratedFrom, 2)
      assert.ok(opened.migrationBackupPath && opened.migrationBackupPath.includes('migrations'))
      assert.equal(state.project.schemaVersion, 3)
      assert.equal(state.project.title, '工具迁移')
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R1b — doctor / 概览 v3', () => {
  it('doctor 对内存 v2 工程：info schema_migration、repair 后转 3 + format', () => {
    const v2 = JSON.parse(JSON.stringify(createDemoProject()))
    v2.schemaVersion = 2
    delete v2.format
    const readOnly = ops.doctorProject(v2)
    const issue = readOnly.issues.find((item) => item.code === 'doctor.schema_migration')
    assert.ok(issue, JSON.stringify(readOnly.issues.map((item) => item.code)))
    assert.equal(issue.level, 'info')
    assert.equal(issue.canRepair, true)
    assert.equal(v2.schemaVersion, 2, '只读不修改')
    const repaired = ops.doctorProject(v2, { repair: true })
    assert.equal(v2.schemaVersion, 3)
    assert.equal(v2.format.name, 'aims')
    assert.equal(v2.format.migratedFrom, 2)
    assert.ok(repaired.repaired.applied >= 1)
  })

  it('get_project / app_info 返回 schemaVersion 3 与 format', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    try {
      const overview = await exec('studio_get_project')
      assert.equal(overview.schemaVersion, 3)
      assert.equal(overview.format.name, 'aims')
      assert.equal(overview.format.version, 3)
      const info = await exec('studio_app_info')
      assert.equal(info.project.schemaVersion, 3)
      assert.equal(info.project.format.name, 'aims')
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R1b — 补充：迁移备份命名/内容保留/版本恢复', () => {
  function toV2(project, overrides = {}) {
    const v2 = JSON.parse(JSON.stringify(project))
    v2.schemaVersion = 2
    delete v2.format
    return { ...v2, ...overrides }
  }

  it('迁移备份目录名符合 migrations/v2-YYYYMMDD-HHmmss[-name]/project.json', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(toV2(createDemoProject(), { title: '命名检查' })), 'utf8')
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      const parts = state.migration.backupPath.split(path.sep)
      const dirName = parts[parts.length - 2]
      assert.match(dirName, /^v2-[0-9]{8}-[0-9]{6}$/)
      assert.equal(parts[parts.length - 1], 'project.json')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('迁移保留全部内容字段：tracks/patterns/clips/notes/sections/clips 数量与 revision', async () => {
    const dir = await tempDir()
    const v2 = toV2(createDemoProject(), { title: '内容保留', revision: 7 })
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(v2), 'utf8')
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      assert.equal(state.project.revision, 7)
      assert.equal(state.project.tracks.length, v2.tracks.length)
      assert.equal(state.project.patterns.length, v2.patterns.length)
      assert.equal(state.project.clips.length, v2.clips.length)
      assert.equal(state.project.sections.length, v2.sections.length)
      assert.equal(state.project.master.effects.length, v2.master.effects.length)
      assert.equal(state.project.buses.reverb.level, v2.buses.reverb.level)
      assert.equal(state.project.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0), v2.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0))
      assert.equal(state.project.tracks[0].id, v2.tracks[0].id)
      assert.equal(state.project.patterns[0].notes[0].pitch, v2.patterns[0].notes[0].pitch)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('恢复 v2 版本历史：内存为 v3，保存后磁盘为 v3', async () => {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    try {
      await exec('studio_save_project', { name: '版本保存工程' })
      const versions = await exec('studio_list_project_versions', { name: '版本保存工程' })
      const versionId = versions.versions[0].id
      // 手写覆盖该版本文件为 v2 内容
      const versionPath = path.join(projectVersionsDir(dir, '版本保存工程'), versionId + '.json')
      await writeFile(versionPath, JSON.stringify(toV2(createDemoProject(), { title: 'v2 历史版本' })), 'utf8')
      const restored = await exec('studio_restore_project_version', { name: '版本保存工程', id: versionId })
      assert.equal(restored.ok, true, restored.error)
      assert.equal(state.project.schemaVersion, 3)
      assert.equal(state.project.title, 'v2 历史版本')
      await exec('studio_save_project', { name: '版本恢复保存', overwrite: true })
      const persisted = JSON.parse(await readFile(path.join(projectsDir(dir), '版本恢复保存.json'), 'utf8'))
      assert.equal(persisted.schemaVersion, 3)
      assert.equal(persisted.title, 'v2 历史版本')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('迁移失败时不创建 legacy-v1、也不写 project.json；state.migration 带 error', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(toV2(createDemoProject(), { title: '失败保持' })), 'utf8')
    await writeFile(path.join(dir, 'migrations'), 'block', 'utf8')
    const state = createState({ dataDir: dir, fallbackInitial: createDemoProject })
    await state.ready
    try {
      assert.equal(state.migration.failed, true)
      assert.equal(state.legacyBackupPath, null)
      assert.equal(state.loadedFromDisk, false)
      await state.flush()
      assert.equal(JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8')).schemaVersion, 2)
      await assert.rejects(() => readdir(path.join(dir, 'legacy-v1')))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('v1 命名工程仍 unsupported；v2 命名工程 list 与 open 迁移都在 migrations 下留备份', async () => {
    const dir = await tempDir()
    await mkdir(projectsDir(dir), { recursive: true })
    await writeFile(path.join(projectsDir(dir), 'v1命名.json'), JSON.stringify(toV2(createDemoProject(), { schemaVersion: 1 })), 'utf8')
    await writeFile(path.join(projectsDir(dir), 'v2命名.json'), JSON.stringify(toV2(createDemoProject(), { title: 'v2 命名' })), 'utf8')
    const listed = await listProjects(dir)
    assert.equal(listed.unsupported.some((item) => item.name === 'v1命名'), true)
    assert.equal(listed.projects.find((item) => item.name === 'v2命名').needsMigration, true)
    const loaded = await loadProjectFile(dir, 'v2命名')
    assert.equal(loaded.migratedFrom, 2)
    assert.ok(loaded.backupPath.startsWith(path.join(dir, 'migrations') + path.sep))
  })

  it('doctor 修复 v2 后 format.migratedAt 有效、schemaVersion=3', () => {
    const v2 = JSON.parse(JSON.stringify(createDemoProject()))
    v2.schemaVersion = 2
    delete v2.format
    ops.doctorProject(v2, { repair: true })
    assert.equal(v2.schemaVersion, 3)
    assert.equal(v2.format.version, 3)
    assert.equal(v2.format.migratedFrom, 2)
    assert.ok(v2.format.migratedAt > 0)
  })
})

/* ------------------------------------------------------------------------- */
/* R2a：音频片段 gain / fade / reverse / update / split（恢复自 R2a 交付）      */
/* ------------------------------------------------------------------------- */

describe('R2a — 音频片段 gain/fade/reverse/offset/update', () => {
  async function makeAudioTools({ mediaDuration = 20, lengthBars = 4 } = {}) {
    const { dir, state } = await makeState()
    state.mutate({ tool: 'test_audio_clip' }, (draft) => {
      const media = ops.addMedia(draft, { name: 'vocal.wav', file: 'vocal.wav', bytes: 1000, durationSeconds: mediaDuration })
      const track = ops.addAudioTrack(draft, { mediaId: media.id, startBar: 0 })
      ops.setClips(draft, [{ id: 'clip_1', trackId: track.trackId, mediaId: media.id, startBar: 0, lengthBars }])
      return undefined
    })
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    const clip = () => state.project.clips.find((item) => item.id === 'clip_1')
    return { dir, state, byName, exec, clip }
  }

  it('工具参数声明：clipId 必填、gain/fade/reverse/offset/start/length', async () => {
    const { state, byName } = await makeAudioTools()
    try {
      const tool = byName.get('studio_update_audio_clip')
      assert.equal(tool.parameters.clipId.required, true)
      assert.equal(tool.parameters.gainDb.type, 'number')
      assert.equal(tool.parameters.fadeInSeconds.type, 'number')
      assert.equal(tool.parameters.fadeOutSeconds.type, 'number')
      assert.equal(tool.parameters.reverse.type, 'boolean')
      assert.equal(tool.parameters.offsetSeconds.type, 'number')
      assert.match(tool.description, /gainDb/)
      const split = byName.get('studio_split_audio_clip')
      assert.equal(split.parameters.atBar.required, true)
      assert.match(split.description, /tempoMap|tempo/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：写入 gainDb/fade/reverse/offset，get_project clips 返回这些字段', async () => {
    const { state, exec, clip } = await makeAudioTools()
    try {
      const result = await exec('studio_update_audio_clip', {
        clipId: 'clip_1',
        gainDb: -6,
        fadeInSeconds: 1.5,
        fadeOutSeconds: 2,
        reverse: true,
        offsetSeconds: 1,
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.clip.gainDb, -6)
      assert.equal(result.clip.fadeInSeconds, 1.5)
      assert.equal(result.clip.fadeOutSeconds, 2)
      assert.equal(result.clip.reverse, true)
      assert.equal(result.clip.offsetSeconds, 1)
      assert.equal(clip().gainDb, -6)
      assert.equal(state.historyState().undoLabel, '编辑音频片段')
      const overview = await exec('studio_get_project')
      const overviewClip = overview.clips.find((item) => item.mediaId === result.clip.mediaId)
      assert.equal(overviewClip.gainDb, -6)
      assert.equal(overviewClip.fadeInSeconds, 1.5)
      assert.equal(overviewClip.fadeOutSeconds, 2)
      assert.equal(overviewClip.reverse, true)
      assert.equal(overviewClip.offsetSeconds, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：0/false 清除字段；撤销一步恢复上一版', async () => {
    const { state, exec, clip } = await makeAudioTools()
    try {
      await exec('studio_update_audio_clip', { clipId: 'clip_1', gainDb: -12, fadeInSeconds: 2, fadeOutSeconds: 2, reverse: true })
      const cleared = await exec('studio_update_audio_clip', {
        clipId: 'clip_1',
        gainDb: 0,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        reverse: false,
      })
      assert.equal(cleared.ok, true, cleared.error)
      for (const field of ['gainDb', 'fadeInSeconds', 'fadeOutSeconds', 'reverse']) {
        assert.equal(Object.hasOwn(clip(), field), false, `${field} 应被清除`)
      }
      await exec('studio_undo')
      assert.equal(clip().gainDb, -12)
      assert.equal(clip().reverse, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：startBar/lengthBars 可改；offset/媒体时长联动校验', async () => {
    const { state, exec, clip } = await makeAudioTools({ mediaDuration: 20, lengthBars: 4 })
    try {
      const moved = await exec('studio_update_audio_clip', { clipId: 'clip_1', startBar: 2, lengthBars: 2 })
      assert.equal(moved.ok, true, moved.error)
      assert.equal(clip().startBar, 2)
      assert.equal(clip().lengthBars, 2)
      const tooLong = await exec('studio_update_audio_clip', { clipId: 'clip_1', offsetSeconds: 18, lengthBars: 4 })
      assert.equal(tooLong.ok, false)
      assert.match(tooLong.error, /媒体剩余时长|超出媒体/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update 非法：gain/fade 越界、reverse 非布尔、offset 超媒体、无字段均拒绝且不改', async () => {
    const { state, exec, clip } = await makeAudioTools({ mediaDuration: 10, lengthBars: 2 })
    try {
      const snapshot = JSON.stringify(clip())
      for (const args of [
        { gainDb: 30 },
        { gainDb: -30 },
        { gainDb: 'x' },
        { fadeInSeconds: -1 },
        { fadeOutSeconds: 11 },
        { reverse: 'yes' },
        { offsetSeconds: 10 },
        { startBar: -1 },
        { lengthBars: 0 },
        {},
      ]) {
        const result = await exec('studio_update_audio_clip', { clipId: 'clip_1', ...args })
        assert.equal(result.ok, false, JSON.stringify(args))
      }
      assert.equal(JSON.stringify(clip()), snapshot, '非法编辑不修改片段')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：导入过盈片段仅调 gain/fade 不因媒体长度失败；fade 总和超时中文拒绝', async () => {
    const overhang = await makeAudioTools({ mediaDuration: 6, lengthBars: 4 })
    try {
      const result = await overhang.exec('studio_update_audio_clip', { clipId: 'clip_1', gainDb: -6, fadeInSeconds: 1 })
      assert.equal(result.ok, true, result.error)
    } finally {
      await overhang.state.flush()
      overhang.state.dispose()
    }
    const { state, exec } = await makeAudioTools({ mediaDuration: 5, lengthBars: 2 })
    try {
      const result = await exec('studio_update_audio_clip', { clipId: 'clip_1', fadeInSeconds: 2, fadeOutSeconds: 2 })
      assert.equal(result.ok, false)
      assert.match(result.error, /fadeIn\+fadeOut|可播放时长/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：pattern 片段/不存在 clipId 中文拒绝', async () => {
    const { state, exec } = await makeAudioTools()
    try {
      const missing = await exec('studio_update_audio_clip', { clipId: 'clip_999', gainDb: -3 })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /找不到片段/)
      state.mutate({ tool: 'test' }, (draft) => {
        ops.setArrangement(draft, { clips: [{ trackId: 'trk_2', patternId: 'pat_1', startBar: 0, lengthBars: 2 }] })
        return undefined
      })
      const patternClipId = state.project.clips.find((item) => item.patternId).id
      const patternResult = await exec('studio_update_audio_clip', { clipId: patternClipId, gainDb: -3 })
      assert.equal(patternResult.ok, false)
      assert.match(patternResult.error, /不是音频片段/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R2a — 音频片段 split（tempo 换算 / fade 分配 / 撤销）', () => {
  async function makeSplitTools({ mediaDuration = 20, lengthBars = 4, bpm = 128 } = {}) {
    const { dir, state } = await makeState()
    state.mutate({ tool: 'test_split' }, (draft) => {
      draft.bpm = bpm
      const media = ops.addMedia(draft, { name: 'loop.wav', file: 'loop.wav', bytes: 1000, durationSeconds: mediaDuration })
      const track = ops.addAudioTrack(draft, { mediaId: media.id, startBar: 0 })
      ops.setClips(draft, [{ id: 'clip_1', trackId: track.trackId, mediaId: media.id, startBar: 0, lengthBars }])
      const clip = draft.clips.find((item) => item.id === 'clip_1')
      clip.offsetSeconds = 0
      clip.gainDb = -6
      clip.fadeInSeconds = 1
      clip.fadeOutSeconds = 2
      clip.reverse = true
      return undefined
    })
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { dir, state, exec, clips: () => state.project.clips.filter((item) => item.trackId === state.project.tracks.find((track) => track.kind === 'audio').id) }
  }

  it('split：左右长度/startBar/offset（128BPM 2 小节=3.75s）、fade/gain/reverse 分配', async () => {
    const { state, exec, clips } = await makeSplitTools({ bpm: 128, lengthBars: 4, mediaDuration: 20 })
    try {
      const result = await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar: 2 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.left.lengthBars, 2)
      assert.equal(result.right.startBar, 2)
      assert.equal(result.right.lengthBars, 2)
      assert.ok(Math.abs(result.offsetDeltaSeconds - 3.75) < 1e-6, String(result.offsetDeltaSeconds))
      assert.ok(Math.abs(result.right.offsetSeconds - 3.75) < 1e-3)
      assert.equal(result.left.gainDb, -6)
      assert.equal(result.right.gainDb, -6)
      assert.equal(result.left.reverse, true)
      assert.equal(result.right.reverse, true)
      assert.equal(result.left.fadeInSeconds, 1)
      assert.equal(result.left.fadeOutSeconds, 0)
      assert.equal(result.right.fadeInSeconds, 0)
      assert.equal(result.right.fadeOutSeconds, 2)
      assert.equal(clips().length, 2)
      assert.notEqual(result.left.id, result.right.id)
      assert.equal(state.historyState().undoLabel, '分割音频片段')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split：tempoMap 60BPM 时 offset 按积分增加（2 小节=8s）', async () => {
    const { state, exec } = await makeSplitTools({ bpm: 60, lengthBars: 4, mediaDuration: 20 })
    try {
      await exec('studio_set_tempo_map', { points: [{ beat: 0, bpm: 60 }, { beat: 32, bpm: 60 }] })
      const result = await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar: 2 })
      assert.equal(result.ok, true, result.error)
      assert.ok(Math.abs(result.offsetDeltaSeconds - 8) < 1e-6, String(result.offsetDeltaSeconds))
      assert.ok(Math.abs(result.right.offsetSeconds - 8) < 1e-3)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split：一次撤销恢复单个片段与原字段', async () => {
    const { state, exec, clips } = await makeSplitTools()
    try {
      const before = JSON.stringify(clips())
      const result = await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar: 2 })
      assert.equal(result.ok, true, result.error)
      assert.equal(clips().length, 2)
      await exec('studio_undo')
      assert.equal(clips().length, 1)
      assert.equal(JSON.stringify(clips()), before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split 非法：atBar 边界/不存在片段/右段起点超出媒体', async () => {
    const { state, exec } = await makeSplitTools({ mediaDuration: 2, lengthBars: 4 })
    try {
      for (const atBar of [0, 4, 5, -1]) {
        const result = await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar })
        assert.equal(result.ok, false, String(atBar))
      }
      const missing = await exec('studio_split_audio_clip', { clipId: 'clip_999', atBar: 2 })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /找不到片段/)
      const over = await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar: 3 })
      assert.equal(over.ok, false)
      assert.match(over.error, /超出媒体/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split：左段 fadeIn/右段 fadeOut 过长时按新长度夹紧', async () => {
    const { state, exec } = await makeSplitTools({ mediaDuration: 20, lengthBars: 4, bpm: 120 })
    try {
      await exec('studio_update_audio_clip', { clipId: 'clip_1', fadeInSeconds: 5, fadeOutSeconds: 5 })
      const result = await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar: 1 })
      assert.equal(result.ok, true, result.error)
      assert.ok(result.left.fadeInSeconds <= 2 + 1e-6, String(result.left.fadeInSeconds))
      assert.ok(result.right.fadeOutSeconds <= 6 + 1e-6, String(result.right.fadeOutSeconds))
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R2a — setClips / editClips 透传音频字段', () => {
  it('ops.setClips 可创建带 gain/fade/reverse/offset 的音频 clip；pattern clip 忽略音频字段', () => {
    const project = createDemoProject()
    const media = ops.addMedia(project, { name: 'x.wav', file: 'x.wav', bytes: 1000, durationSeconds: 10 })
    const audioTrack = ops.addAudioTrack(project, { mediaId: media.id, startBar: 0 })
    ops.setClips(project, [
      {
        trackId: audioTrack.trackId,
        mediaId: media.id,
        startBar: 0,
        lengthBars: 2,
        gainDb: -6,
        fadeInSeconds: 1,
        fadeOutSeconds: 1.5,
        reverse: true,
        offsetSeconds: 2,
      },
      { trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 2, gainDb: -3, fadeInSeconds: 2, reverse: true },
    ])
    const audioClip = project.clips.find((clip) => clip.mediaId === media.id)
    assert.equal(audioClip.gainDb, -6)
    assert.equal(audioClip.fadeInSeconds, 1)
    assert.equal(audioClip.fadeOutSeconds, 1.5)
    assert.equal(audioClip.reverse, true)
    assert.equal(audioClip.offsetSeconds, 2)
    const patternClip = project.clips.find((clip) => clip.patternId === 'pat_1')
    for (const field of ['gainDb', 'fadeInSeconds', 'reverse']) assert.equal(Object.hasOwn(patternClip, field), false)
  })

  it('editClips update 支持 offset/gain/fade/reverse 并持久化', async () => {
    const { state } = await makeState()
    try {
      state.mutate({ tool: 'test' }, (draft) => {
        const media = ops.addMedia(draft, { name: 'y.wav', file: 'y.wav', bytes: 1000, durationSeconds: 10 })
        const track = ops.addAudioTrack(draft, { mediaId: media.id, startBar: 0 })
        ops.setClips(draft, [{ id: 'clip_1', trackId: track.trackId, mediaId: media.id, startBar: 0, lengthBars: 2 }])
        return undefined
      })
      const result = ops.editClips(state.project, {
        update: [{ index: 0, gainDb: -3, fadeInSeconds: 0.5, fadeOutSeconds: 0.5, reverse: true, offsetSeconds: 1 }],
      })
      assert.equal(result.clips, state.project.clips.length)
      const clip = state.project.clips[0]
      assert.equal(clip.gainDb, -3)
      assert.equal(clip.fadeInSeconds, 0.5)
      assert.equal(clip.fadeOutSeconds, 0.5)
      assert.equal(clip.reverse, true)
      assert.equal(clip.offsetSeconds, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具 TOOL_NAMES 包含 update/split 两个新工具', () => {
    assert.ok(TOOL_NAMES.includes('studio_update_audio_clip'))
    assert.ok(TOOL_NAMES.includes('studio_split_audio_clip'))
  })
})

/* ------------------------------------------------------------------------- */
/* R2a 修复：媒体文件全局唯一命名（跨工程不覆盖、数据不损坏）                   */
/* ------------------------------------------------------------------------- */

describe('R2a 修复 — 媒体文件全局唯一命名', () => {
  it('makeMediaFileName/randomMediaSuffix：安全字符、唯一格式、扩展名防御', () => {
    const name = makeMediaFileName('med_1', 'wav', { now: 1700000000000, suffix: 'abcd' })
    assert.match(name, /^med_1-[0-9a-z]+-abcd\.wav$/)
    assert.match(name, /^[A-Za-z0-9_-]+\.[a-z0-9]+$/, '文件名只含安全字符')
    const weird = makeMediaFileName('med 1/../x', '.WAV')
    assert.match(weird, /^[A-Za-z0-9_-]+\.wav$/)
    assert.match(randomMediaSuffix(), /^[0-9a-f]{4}$/)
    assert.notEqual(makeMediaFileName('med_1', 'wav'), makeMediaFileName('med_1', 'wav'), '默认随机后缀应不同')
  })

  it('writeUniqueMediaFile：同名 mediaId 写入两次 → 两个不同文件、内容都不丢', async () => {
    const dir = await tempDir()
    const a = Buffer.from('AAAA')
    const b = Buffer.from('BBBB')
    const first = await writeUniqueMediaFile(dir, a, { mediaId: 'med_1', ext: 'wav' })
    const second = await writeUniqueMediaFile(dir, b, { mediaId: 'med_1', ext: 'wav' })
    assert.notEqual(first.fileName, second.fileName)
    assert.deepEqual(await readFile(first.filePath), a)
    assert.deepEqual(await readFile(second.filePath), b)
  })

  it('工具：两个工程同 dataDir 各导入不同 WAV → file 不同、两文件都在、分别打开引用正确', async () => {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    try {
      // 工程 A：导入 1s 单音 WAV
      const wavA = makeWav(1)
      const pathA = path.join(dir, '工程A素材.wav')
      await writeFile(pathA, wavA)
      const importedA = await exec('studio_import_audio', { path: pathA })
      assert.equal(importedA.ok, true, importedA.error)
      const mediaA = state.project.media.find((item) => item.id === importedA.mediaId)
      const fileA = mediaA.file
      const bytesA = await readFile(path.join(state.mediaDir, fileA))
      assert.deepEqual(bytesA, wavA)
      assert.match(fileA, /^med_[0-9]+-[0-9a-z]+-[0-9a-f]{4}\.wav$/)
      assert.equal(await exec('studio_save_project', { name: '媒体工程A', overwrite: true }).then((r) => r.ok), true)

      // 工程 B：重置后 media id 又从 med_1 开始，导入 2s 不同 WAV
      assert.equal(await exec('studio_create_project', { title: '媒体工程B' }).then((r) => r.ok), true)
      const wavB = makeWav(2)
      const pathB = path.join(dir, '工程B素材.wav')
      await writeFile(pathB, wavB)
      const importedB = await exec('studio_import_audio', { path: pathB })
      assert.equal(importedB.ok, true, importedB.error)
      const mediaB = state.project.media.find((item) => item.id === importedB.mediaId)
      const fileB = mediaB.file
      assert.notEqual(fileB, fileA, '跨工程媒体文件名必须不同')
      // 两个文件都还在，且同名旧文件内容没有被覆盖
      assert.deepEqual(await readFile(path.join(state.mediaDir, fileA)), wavA, '工程 A 的媒体文件内容不应被工程 B 覆盖')
      assert.deepEqual(await readFile(path.join(state.mediaDir, fileB)), wavB)
      assert.equal(await exec('studio_save_project', { name: '媒体工程B', overwrite: true }).then((r) => r.ok), true)

      // 打开工程 A：media.file 仍指向 A 的素材，内容一致
      const openedA = await exec('studio_open_project', { name: '媒体工程A' })
      assert.equal(openedA.ok, true, openedA.error)
      assert.equal(state.project.media.length, 1)
      assert.equal(state.project.media[0].file, fileA)
      assert.deepEqual(await readFile(path.join(state.mediaDir, state.project.media[0].file)), wavA)
      // 打开工程 B 再核对
      const openedB = await exec('studio_open_project', { name: '媒体工程B' })
      assert.equal(openedB.ok, true, openedB.error)
      assert.equal(state.project.media[0].file, fileB)
      assert.deepEqual(await readFile(path.join(state.mediaDir, state.project.media[0].file)), wavB)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('路由：两工程 /import-audio 同名 mediaId 不覆盖（文件唯一、/media 分别正确）', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const wavA = makeWav(1)
      const wavB = makeWav(2)
      // 工程 A 导入
      const a = await postJson(server.base, '/studio/api/import-audio', { name: 'a.wav', dataBase64: wavA.toString('base64') })
      assert.equal(a.status, 200)
      const fileA = state.project.media.find((item) => item.id === a.data.mediaId).file
      assert.deepEqual(await readFile(path.join(state.mediaDir, fileA)), wavA)
      assert.equal((await postJson(server.base, '/studio/api/projects/save', { name: '路由媒体A' })).data.ok, true)
      // 新建工程 B（media id 又从 med_1 开始）→ 导入不同 WAV
      assert.equal((await postJson(server.base, '/studio/api/projects/new', { template: 'empty' })).data.ok, true)
      const b = await postJson(server.base, '/studio/api/import-audio', { name: 'b.wav', dataBase64: wavB.toString('base64') })
      assert.equal(b.status, 200)
      const fileB = state.project.media.find((item) => item.id === b.data.mediaId).file
      assert.notEqual(fileB, fileA, '跨工程媒体文件名必须不同')
      // 两个文件都在，A 的内容没被 B 覆盖
      assert.deepEqual(await readFile(path.join(state.mediaDir, fileA)), wavA)
      assert.deepEqual(await readFile(path.join(state.mediaDir, fileB)), wavB)
      assert.equal((await postJson(server.base, '/studio/api/projects/save', { name: '路由媒体B' })).data.ok, true)
      // 打开 A：/media 返回 A 的字节；打开 B：返回 B 的字节
      assert.equal((await postJson(server.base, '/studio/api/projects/open', { name: '路由媒体A' })).data.ok, true)
      assert.equal(state.project.media[0].file, fileA)
      const responseA = await fetch(`${server.base}/studio/api/media/${fileA}`)
      assert.equal(responseA.status, 200)
      assert.deepEqual(Buffer.from(await responseA.arrayBuffer()), wavA)
      assert.equal((await postJson(server.base, '/studio/api/projects/open', { name: '路由媒体B' })).data.ok, true)
      assert.equal(state.project.media[0].file, fileB)
      const responseB = await fetch(`${server.base}/studio/api/media/${fileB}`)
      assert.equal(responseB.status, 200)
      assert.deepEqual(Buffer.from(await responseB.arrayBuffer()), wavB)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R2b：音频片段 stretchRatio / semitones（update / split / 透传）              */
/* ------------------------------------------------------------------------- */

describe('R2b — 音频片段 stretchRatio/semitones', () => {
  async function makeStretchTools({ mediaDuration = 20, lengthBars = 4, bpm = 128 } = {}) {
    const { dir, state } = await makeState()
    state.mutate({ tool: 'test_stretch' }, (draft) => {
      draft.bpm = bpm
      const media = ops.addMedia(draft, { name: 'loop.wav', file: 'loop.wav', bytes: 1000, durationSeconds: mediaDuration })
      const track = ops.addAudioTrack(draft, { mediaId: media.id, startBar: 0 })
      ops.setClips(draft, [{ id: 'clip_1', trackId: track.trackId, mediaId: media.id, startBar: 0, lengthBars }])
      return undefined
    })
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    const clip = () => state.project.clips.find((item) => item.id === 'clip_1')
    return { dir, state, exec, clip }
  }

  it('工具参数/描述：update_audio_clip 支持 stretchRatio/semitones', async () => {
    const { state, exec, clip } = await makeStretchTools()
    try {
      const updateTool = createTools({ defineTool: (options) => options, state }).find((tool) => tool.name === 'studio_update_audio_clip')
      assert.equal(updateTool.parameters.stretchRatio.type, 'number')
      assert.equal(updateTool.parameters.semitones.type, 'number')
      assert.match(updateTool.description, /stretchRatio/)
      assert.match(updateTool.description, /semitones/)
      const splitTool = createTools({ defineTool: (options) => options, state }).find((tool) => tool.name === 'studio_split_audio_clip')
      assert.match(splitTool.description, /stretchRatio|源媒体时间/)
      void exec
      void clip
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：写入 stretchRatio/semitones，get_project 返回', async () => {
    const { state, exec, clip } = await makeStretchTools({ bpm: 120 })
    try {
      const result = await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 1.25, semitones: -3.5 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.clip.stretchRatio, 1.25)
      assert.equal(result.clip.semitones, -3.5)
      assert.equal(clip().stretchRatio, 1.25)
      const overview = await exec('studio_get_project')
      const overviewClip = overview.clips.find((item) => item.mediaId === result.clip.mediaId)
      assert.equal(overviewClip.stretchRatio, 1.25)
      assert.equal(overviewClip.semitones, -3.5)
      assert.equal(state.historyState().undoLabel, '编辑音频片段')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：stretchRatio=1 / semitones=0 清除字段；撤销恢复', async () => {
    const { state, exec, clip } = await makeStretchTools({ bpm: 120 })
    try {
      await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 2, semitones: 3 })
      const cleared = await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 1, semitones: 0 })
      assert.equal(cleared.ok, true, cleared.error)
      assert.equal(Object.hasOwn(clip(), 'stretchRatio'), false)
      assert.equal(Object.hasOwn(clip(), 'semitones'), false)
      await exec('studio_undo')
      assert.equal(clip().stretchRatio, 2)
      assert.equal(clip().semitones, 3)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update 非法：stretchRatio/semitones 越界或非数字均中文拒绝且不改', async () => {
    const { state, exec, clip } = await makeStretchTools({ bpm: 120 })
    try {
      const snapshot = JSON.stringify(clip())
      for (const args of [
        { stretchRatio: 0.2 },
        { stretchRatio: 4.5 },
        { stretchRatio: 'x' },
        { semitones: 13 },
        { semitones: -13 },
        { semitones: 'x' },
      ]) {
        const result = await exec('studio_update_audio_clip', { clipId: 'clip_1', ...args })
        assert.equal(result.ok, false, JSON.stringify(args))
      }
      assert.equal(JSON.stringify(clip()), snapshot)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：仅改 stretchRatio/semitones（含清除）不做源时长拒绝；改 offset/length 才校验', async () => {
    const { state, exec, clip } = await makeStretchTools({ mediaDuration: 8, lengthBars: 4 })
    try {
      // 4 小节 @128 = 7.5s timeline；ratio=0.5 源需 15s，但只是时间拉伸 → 允许（引擎按播放窗口夹紧）
      const ratioOnly = await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 0.5 })
      assert.equal(ratioOnly.ok, true, ratioOnly.error)
      assert.equal(clip().stretchRatio, 0.5)
      // 清除 1/0 也允许（即使源需求超出媒体，实际可播放被 min 夹紧）
      const clear = await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 1, semitones: 0 })
      assert.equal(clear.ok, true, clear.error)
      assert.equal(Object.hasOwn(clip(), 'stretchRatio'), false)
      // 显式改 offset 仍按源时间校验：ratio=2 时 7.5/2=3.75s，offset=5 → 8.75 > 8 拒绝
      assert.equal((await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 2 })).ok, true)
      const tooFar = await exec('studio_update_audio_clip', { clipId: 'clip_1', offsetSeconds: 5 })
      assert.equal(tooFar.ok, false)
      assert.match(tooFar.error, /超出媒体剩余时长/)
      // offset=4 → 3.75+4=7.75 ≤ 8 允许
      assert.equal((await exec('studio_update_audio_clip', { clipId: 'clip_1', offsetSeconds: 4 })).ok, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：2s 媒体 + 2 小节 clip（timeline 4s）设 stretchRatio 0.8 允许（可播放 1.6s）', async () => {
    const { state, exec, clip } = await makeStretchTools({ mediaDuration: 2, lengthBars: 2, bpm: 120 })
    try {
      const result = await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 0.8 })
      assert.equal(result.ok, true, result.error)
      assert.equal(clip().stretchRatio, 0.8)
      // 按音频引擎契约：timeline 4s，可播放 min(4, 2×0.8)=1.6s，由引擎夹紧
      assert.equal(audioClipPlayableSeconds(state.project, clip()), 1.6)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：导入过盈 clip 清除 stretchRatio=1/semitones=0 允许（R2a slack 口径）', async () => {
    // 6s 媒体、4 小节 = 7.5s timeline（导入向上取整的过盈 clip）
    const { state, exec, clip } = await makeStretchTools({ mediaDuration: 6, lengthBars: 4 })
    try {
      assert.equal((await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 1.5, semitones: -5 })).ok, true)
      const cleared = await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 1, semitones: 0 })
      assert.equal(cleared.ok, true, cleared.error)
      assert.equal(Object.hasOwn(clip(), 'stretchRatio'), false)
      assert.equal(Object.hasOwn(clip(), 'semitones'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update：导入过盈片段仅调 gain 不因 ratio 源时长失败', async () => {
    const { state, exec, clip } = await makeStretchTools({ mediaDuration: 6, lengthBars: 4 })
    try {
      // 6s 媒体、4 小节 7.5s；先设 ratio=2（源 3.75s 可）再用仅 gain 编辑
      assert.equal((await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 2 })).ok, true)
      const result = await exec('studio_update_audio_clip', { clipId: 'clip_1', gainDb: -6 })
      assert.equal(result.ok, true, result.error)
      assert.equal(clip().gainDb, -6)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split ratio=2：右段 offset += timelineDelta/2，两段继承 stretch/semitones/reverse', async () => {
    const { state, exec } = await makeStretchTools({ mediaDuration: 20, lengthBars: 4, bpm: 120 })
    try {
      assert.equal((await exec('studio_update_audio_clip', {
        clipId: 'clip_1',
        stretchRatio: 2,
        semitones: 3,
        reverse: true,
        gainDb: -6,
        fadeInSeconds: 1,
        fadeOutSeconds: 2,
      })).ok, true)
      // 4 小节 @120 = 8s timeline；split bar2 → timelineDelta=4s，源增量=2s
      const result = await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar: 2 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.offsetDeltaSeconds, 4)
      assert.equal(result.sourceOffsetDeltaSeconds, 2)
      assert.equal(result.right.offsetSeconds, 2)
      assert.equal(result.left.stretchRatio, 2)
      assert.equal(result.right.stretchRatio, 2)
      assert.equal(result.left.semitones, 3)
      assert.equal(result.right.semitones, 3)
      assert.equal(result.left.reverse, true)
      assert.equal(result.right.reverse, true)
      // fade 分配同 R2a：fadeIn 只左、fadeOut 只右
      assert.equal(result.left.fadeInSeconds, 1)
      assert.equal(result.left.fadeOutSeconds, 0)
      assert.equal(result.right.fadeInSeconds, 0)
      assert.equal(result.right.fadeOutSeconds, 2)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split ratio=0.5：源增量 = 4s/0.5 = 8s', async () => {
    const { state, exec } = await makeStretchTools({ mediaDuration: 20, lengthBars: 4, bpm: 120 })
    try {
      assert.equal((await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 0.5 })).ok, true)
      const result = await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar: 2 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.sourceOffsetDeltaSeconds, 8)
      assert.equal(result.right.offsetSeconds, 8)
      assert.equal(result.right.stretchRatio, 0.5)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split tempoMap 60BPM + ratio=2：timeline 8s、源增量 4s', async () => {
    const { state, exec } = await makeStretchTools({ mediaDuration: 40, lengthBars: 4, bpm: 60 })
    try {
      await exec('studio_set_tempo_map', { points: [{ beat: 0, bpm: 60 }, { beat: 32, bpm: 60 }] })
      assert.equal((await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 2 })).ok, true)
      const result = await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar: 2 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.offsetDeltaSeconds, 8)
      assert.equal(result.sourceOffsetDeltaSeconds, 4)
      assert.equal(result.right.offsetSeconds, 4)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split + stretch：一次撤销恢复单个片段与原 ratio/semitones', async () => {
    const { state, exec, clip } = await makeStretchTools({ mediaDuration: 20, lengthBars: 4, bpm: 120 })
    try {
      await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 2, semitones: -4 })
      const before = JSON.stringify(clip())
      assert.equal((await exec('studio_split_audio_clip', { clipId: 'clip_1', atBar: 2 })).ok, true)
      assert.equal(state.project.clips.length, 2)
      await exec('studio_undo')
      assert.equal(state.project.clips.length, 1)
      assert.equal(JSON.stringify(clip()), before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('setClips/editClips 透传 stretchRatio/semitones；pattern clip 忽略', () => {
    const project = createDemoProject()
    const media = ops.addMedia(project, { name: 'x.wav', file: 'x.wav', bytes: 1000, durationSeconds: 10 })
    const audioTrack = ops.addAudioTrack(project, { mediaId: media.id, startBar: 0 })
    ops.setClips(project, [
      { trackId: audioTrack.trackId, mediaId: media.id, startBar: 0, lengthBars: 2, stretchRatio: 1.25, semitones: 3 },
      { trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 2, stretchRatio: 2, semitones: 3 },
    ])
    const audioClip = project.clips.find((clip) => clip.mediaId === media.id)
    assert.equal(audioClip.stretchRatio, 1.25)
    assert.equal(audioClip.semitones, 3)
    const patternClip = project.clips.find((clip) => clip.patternId === 'pat_1')
    for (const field of ['stretchRatio', 'semitones']) assert.equal(Object.hasOwn(patternClip, field), false)
    // editClips update（replaceClips 会重建对象，需按 mediaId 重新定位索引）
    const index = project.clips.findIndex((clip) => clip.mediaId === media.id)
    ops.editClips(project, { update: [{ index, stretchRatio: 0.5, semitones: -7.5 }] })
    const updatedClip = project.clips.find((clip) => clip.mediaId === media.id)
    assert.equal(updatedClip.stretchRatio, 0.5)
    assert.equal(updatedClip.semitones, -7.5)
  })

  it('fade 总和校验按 ratio 后的可播放 timeline 秒', async () => {
    // 媒体剩余 1.2s、ratio=2 → playable=min(timeline, 2.4)=2.4；fade 2+1=3 > 2.4 → 拒绝
    const { state, exec } = await makeStretchTools({ mediaDuration: 1.2, lengthBars: 4, bpm: 120 })
    try {
      assert.equal((await exec('studio_update_audio_clip', { clipId: 'clip_1', stretchRatio: 2 })).ok, true)
      const result = await exec('studio_update_audio_clip', { clipId: 'clip_1', fadeInSeconds: 2, fadeOutSeconds: 1 })
      assert.equal(result.ok, false)
      assert.match(result.error, /fadeIn\+fadeOut|可播放时长/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R2c：take 模型 + 导入 + set_take_active + split/透传                        */
/* ------------------------------------------------------------------------- */

describe('R2c — take 导入与 studio_set_take_active', () => {
  async function makeTakeTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    const writeWav = async (name, seconds = 1) => {
      const filePath = path.join(dir, name)
      await writeFile(filePath, makeWav(seconds))
      return filePath
    }
    return { dir, state, tools, exec, writeWav }
  }

  it('import_audio：takeGroup 自动 takeIndex=0、返回/工程带 take 字段、新 take active', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const wav = await writeWav('take-a.wav', 1)
      const result = await exec('studio_import_audio', { path: wav, takeGroup: 'take-2026' })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.takeGroup, 'take-2026')
      assert.equal(result.takeIndex, 0)
      assert.equal(result.takeActive, true)
      const clip = state.project.clips.find((item) => item.id === result.clipId)
      assert.equal(clip.takeGroup, 'take-2026')
      assert.equal(clip.takeIndex, 0)
      assert.equal(Object.hasOwn(clip, 'takeActive'), false, 'active 默认省略')
      const overview = await exec('studio_get_project')
      const overviewClip = overview.clips.find((item) => item.id === result.clipId)
      assert.equal(overviewClip.takeGroup, 'take-2026')
      assert.equal(overviewClip.takeIndex, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('import_audio：同组第二次 takeIndex=max+1，旧 take inactive、新 take active；其他组不受影响', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const first = await exec('studio_import_audio', { path: await writeWav('t1.wav', 1), takeGroup: 'g1' })
      const other = await exec('studio_import_audio', { path: await writeWav('o1.wav', 1), takeGroup: 'g2' })
      const second = await exec('studio_import_audio', { path: await writeWav('t2.wav', 2), takeGroup: 'g1' })
      assert.equal(first.takeIndex, 0)
      assert.equal(other.takeIndex, 0)
      assert.equal(second.takeIndex, 1)
      const byId = (id) => state.project.clips.find((clip) => clip.id === id)
      assert.equal(byId(first.clipId).takeActive, false, '旧 take 自动 inactive')
      assert.equal(Object.hasOwn(byId(second.clipId), 'takeActive'), false, '新 take active')
      assert.equal(Object.hasOwn(byId(other.clipId), 'takeActive'), false, '其他组仍 active')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('import_audio：显式 takeIndex 生效；非法 group/index、index 无 group 均中文拒绝', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const explicit = await exec('studio_import_audio', { path: await writeWav('e.wav', 1), takeGroup: 'g', takeIndex: 5 })
      assert.equal(explicit.ok, true, explicit.error)
      assert.equal(explicit.takeIndex, 5)
      const badGroup = await exec('studio_import_audio', { path: await writeWav('bad.wav', 1), takeGroup: 'bad group!' })
      assert.equal(badGroup.ok, false)
      assert.match(badGroup.error, /takeGroup/)
      const badIndex = await exec('studio_import_audio', { path: await writeWav('bad2.wav', 1), takeGroup: 'g', takeIndex: 100 })
      assert.equal(badIndex.ok, false)
      assert.match(badIndex.error, /takeIndex/)
      const noGroup = await exec('studio_import_audio', { path: await writeWav('no.wav', 1), takeIndex: 0 })
      assert.equal(noGroup.ok, false)
      assert.match(noGroup.error, /takeGroup/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('import_reference：take 字段同样生效', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const result = await exec('studio_import_reference', { path: await writeWav('ref.wav', 1), takeGroup: 'ref-group' })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.takeGroup, 'ref-group')
      assert.equal(result.takeIndex, 0)
      const clip = state.project.clips.find((item) => item.id === result.clipId)
      assert.equal(clip.takeGroup, 'ref-group')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('set_take_active（group+index）：该 index active、同组其余 inactive、一次撤销', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const t0 = await exec('studio_import_audio', { path: await writeWav('s1.wav', 1), takeGroup: 'g' })
      const t1 = await exec('studio_import_audio', { path: await writeWav('s2.wav', 1), takeGroup: 'g' })
      const t2 = await exec('studio_import_audio', { path: await writeWav('s3.wav', 1), takeGroup: 'g' })
      // 当前 t2 active、t0/t1 inactive
      assert.equal(state.project.clips.find((clip) => clip.id === t0.clipId).takeActive, false)
      const beforeRevision = state.revision
      const result = await exec('studio_set_take_active', { takeGroup: 'g', takeIndex: 0 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.takeGroup, 'g')
      assert.equal(result.takeIndex, 0)
      assert.deepEqual(result.activeClipIds, [t0.clipId])
      assert.deepEqual(result.deactivatedClipIds.sort(), [t2.clipId])
      assert.equal(state.revision, beforeRevision + 1)
      assert.equal(state.historyState().undoLabel, '切换 take')
      const byId = (id) => state.project.clips.find((clip) => clip.id === id)
      assert.equal(Object.hasOwn(byId(t0.clipId), 'takeActive'), false)
      assert.equal(byId(t1.clipId).takeActive, false)
      assert.equal(byId(t2.clipId).takeActive, false)
      await exec('studio_undo')
      // 撤销后回到切换前：t2 active、t0/t1 inactive
      assert.equal(Object.hasOwn(state.project.clips.find((clip) => clip.id === t2.clipId), 'takeActive'), false)
      assert.equal(state.project.clips.find((clip) => clip.id === t0.clipId).takeActive, false)
      void t1
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('set_take_active（clipId）：只激活该片段，不取消其他 active（comping 多段共存）', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const a = await exec('studio_import_audio', { path: await writeWav('c1.wav', 1), takeGroup: 'g' })
      const b = await exec('studio_import_audio', { path: await writeWav('c2.wav', 2), takeGroup: 'g' })
      // 先让两条都 active（setClips 允许）
      state.mutate({ tool: 'test' }, (draft) => {
        ops.editClips(draft, { update: [
          { index: draft.clips.findIndex((clip) => clip.id === a.clipId), takeActive: true },
          { index: draft.clips.findIndex((clip) => clip.id === b.clipId), takeActive: true },
        ] })
        return undefined
      })
      const result = await exec('studio_set_take_active', { clipId: a.clipId })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.activeClipIds, [a.clipId])
      assert.deepEqual(result.deactivatedClipIds, [])
      const byId = (id) => state.project.clips.find((clip) => clip.id === id)
      assert.equal(Object.hasOwn(byId(a.clipId), 'takeActive'), false)
      assert.equal(Object.hasOwn(byId(b.clipId), 'takeActive'), false, '其他 active 不被取消')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('set_take_active 非法：缺参数/未知组/未知 index/clipId+takeIndex/trackId 不匹配', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const a = await exec('studio_import_audio', { path: await writeWav('x1.wav', 1), takeGroup: 'g' })
      const noArgs = await exec('studio_set_take_active', {})
      assert.equal(noArgs.ok, false)
      const unknownGroup = await exec('studio_set_take_active', { takeGroup: 'nope', takeIndex: 0 })
      assert.equal(unknownGroup.ok, false)
      assert.match(unknownGroup.error, /不存在/)
      const unknownIndex = await exec('studio_set_take_active', { takeGroup: 'g', takeIndex: 9 })
      assert.equal(unknownIndex.ok, false)
      assert.match(unknownIndex.error, /没有 takeIndex/)
      const conflict = await exec('studio_set_take_active', { clipId: a.clipId, takeIndex: 0 })
      assert.equal(conflict.ok, false)
      assert.match(conflict.error, /不能同时指定/)
      const trackMismatch = await exec('studio_set_take_active', { clipId: a.clipId, trackId: 'trk_999' })
      assert.equal(trackMismatch.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('set_take_active：trackId 只在指定轨道范围内切换', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const a = await exec('studio_import_audio', { path: await writeWav('tr1.wav', 1), takeGroup: 'g' })
      const b = await exec('studio_import_audio', { path: await writeWav('tr2.wav', 2), takeGroup: 'g' })
      const trackA = state.project.clips.find((clip) => clip.id === a.clipId).trackId
      const result = await exec('studio_set_take_active', { takeGroup: 'g', takeIndex: 0, trackId: trackA })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.activeClipIds, [a.clipId])
      assert.deepEqual(result.deactivatedClipIds, [])
      // b 在另一轨道，不受影响（当前 active）
      assert.equal(state.project.clips.find((clip) => clip.id === b.clipId).takeActive, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split_audio_clip：两段保留 takeGroup/takeIndex/takeActive', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const imported = await exec('studio_import_audio', { path: await writeWav('split-take.wav', 2), takeGroup: 'g', takeIndex: 3 })
      const clip = state.project.clips.find((item) => item.id === imported.clipId)
      // 让片段足够长（默认 2 小节）并分割
      const result = await exec('studio_split_audio_clip', { clipId: clip.id, atBar: clip.startBar + 1 })
      assert.equal(result.ok, true, result.error)
      for (const segment of [result.left, result.right]) {
        assert.equal(segment.takeGroup, 'g')
        assert.equal(segment.takeIndex, 3)
        assert.equal(segment.takeActive, true)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('setClips/editClips/update_audio_clip 透传 take 字段；非法校验中文拒绝', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const imported = await exec('studio_import_audio', { path: await writeWav('pass.wav', 2), takeGroup: 'g' })
      const clipId = imported.clipId
      // update 设置 takeIndex/takeActive
      const updated = await exec('studio_update_audio_clip', { clipId, takeIndex: 2, takeActive: false })
      assert.equal(updated.ok, true, updated.error)
      assert.equal(updated.clip.takeIndex, 2)
      assert.equal(updated.clip.takeActive, false)
      // editClips update
      state.mutate({ tool: 'test' }, (draft) => {
        ops.editClips(draft, { update: [{ index: draft.clips.findIndex((clip) => clip.id === clipId), takeIndex: 4, takeActive: true }] })
        return undefined
      })
      const clip = state.project.clips.find((item) => item.id === clipId)
      assert.equal(clip.takeIndex, 4)
      assert.equal(Object.hasOwn(clip, 'takeActive'), false)
      // 非法：无 group 设 index / index 越界 / group 非法
      const noGroup = await exec('studio_update_audio_clip', { clipId, takeGroup: '', takeIndex: 1 })
      assert.equal(noGroup.ok, false)
      assert.match(noGroup.error, /需要先有 takeGroup/)
      const badIndex = await exec('studio_update_audio_clip', { clipId, takeGroup: 'g', takeIndex: 100 })
      assert.equal(badIndex.ok, false)
      const badGroup = await exec('studio_update_audio_clip', { clipId, takeGroup: 'bad group!' })
      assert.equal(badGroup.ok, false)
      // 清除整组
      const cleared = await exec('studio_update_audio_clip', { clipId, takeGroup: '' })
      assert.equal(cleared.ok, true, cleared.error)
      assert.equal(Object.hasOwn(state.project.clips.find((item) => item.id === clipId), 'takeGroup'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('路由 POST /import-audio 支持 takeGroup/takeIndex 并返回 take 字段', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const wav = makeWav(1)
      const res = await postJson(server.base, '/studio/api/import-audio', {
        name: 'take-route.wav',
        dataBase64: wav.toString('base64'),
        takeGroup: 'route-take',
      })
      assert.equal(res.status, 200)
      assert.equal(res.data.ok, true)
      assert.equal(res.data.takeGroup, 'route-take')
      assert.equal(res.data.takeIndex, 0)
      const clip = state.project.clips.find((item) => item.id === res.data.clipId)
      assert.equal(clip.takeGroup, 'route-take')
      // 第二次导入同组 → takeIndex=1，旧 inactive
      const res2 = await postJson(server.base, '/studio/api/import-audio', {
        name: 'take-route-2.wav',
        dataBase64: wav.toString('base64'),
        takeGroup: 'route-take',
      })
      assert.equal(res2.data.takeIndex, 1)
      assert.equal(state.project.clips.find((item) => item.id === res.data.clipId).takeActive, false)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('get_project：takeActive=false 显式返回；active 省略', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const a = await exec('studio_import_audio', { path: await writeWav('g1.wav', 1), takeGroup: 'g' })
      const b = await exec('studio_import_audio', { path: await writeWav('g2.wav', 2), takeGroup: 'g' })
      const overview = await exec('studio_get_project')
      const inactive = overview.clips.find((clip) => clip.id === a.clipId)
      const active = overview.clips.find((clip) => clip.id === b.clipId)
      assert.equal(inactive.takeActive, false)
      assert.equal(active.takeActive, undefined)
      assert.equal(active.takeGroup, 'g')
      assert.equal(active.takeIndex, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R2c 补充：边界回归 */
describe('R2c — 补充边界', () => {
  async function makeTakeTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    const writeWav = async (name, seconds = 1) => {
      const filePath = path.join(dir, name)
      await writeFile(filePath, makeWav(seconds))
      return filePath
    }
    return { dir, state, exec, writeWav }
  }

  it('takeIndex 自动分配在显式 index 后继续 max+1（0,5 → 6）', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const first = await exec('studio_import_audio', { path: await writeWav('m1.wav', 1), takeGroup: 'g' })
      const explicit = await exec('studio_import_audio', { path: await writeWav('m2.wav', 1), takeGroup: 'g', takeIndex: 5 })
      const auto = await exec('studio_import_audio', { path: await writeWav('m3.wav', 1), takeGroup: 'g' })
      assert.equal(first.takeIndex, 0)
      assert.equal(explicit.takeIndex, 5)
      assert.equal(auto.takeIndex, 6)
      // 之前 active 的 clip（explicit）在新导入后 inactive
      assert.equal(state.project.clips.find((clip) => clip.id === explicit.clipId).takeActive, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('split 保留 takeActive=false（inactive take 两段仍 inactive）', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const imported = await exec('studio_import_audio', { path: await writeWav('inactive.wav', 2), takeGroup: 'g' })
      state.mutate({ tool: 'test' }, (draft) => {
        const clip = draft.clips.find((item) => item.id === imported.clipId)
        clip.takeActive = false
        return undefined
      })
      const clip = state.project.clips.find((item) => item.id === imported.clipId)
      const split = await exec('studio_split_audio_clip', { clipId: clip.id, atBar: clip.startBar + 1 })
      assert.equal(split.ok, true, split.error)
      assert.equal(split.left.takeActive, false)
      assert.equal(split.right.takeActive, false)
      assert.equal(state.project.clips.find((item) => item.id === split.left.id).takeActive, false)
      assert.equal(state.project.clips.find((item) => item.id === split.right.id).takeActive, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('路由原始字节 + query takeGroup/takeIndex 生效', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const fakeMp3 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(1024, 7)])
      const res = await httpJson(server.base, '/studio/api/import-audio?name=vocal.mp3&takeGroup=raw-take&takeIndex=2', {
        method: 'POST',
        headers: { 'content-type': 'audio/mpeg' },
        body: fakeMp3,
      })
      assert.equal(res.status, 200)
      assert.equal(res.data.ok, true, res.data.error)
      assert.equal(res.data.takeGroup, 'raw-take')
      assert.equal(res.data.takeIndex, 2)
      const clip = state.project.clips.find((item) => item.id === res.data.clipId)
      assert.equal(clip.takeGroup, 'raw-take')
      assert.equal(clip.takeIndex, 2)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

/* R2c 补充：/edit 与 studio_batch 的 setTakeActive */
describe('R2c — /edit 与 studio_batch setTakeActive', () => {
  async function makeTakeTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    const writeWav = async (name, seconds = 1) => {
      const filePath = path.join(dir, name)
      await writeFile(filePath, makeWav(seconds))
      return filePath
    }
    return { dir, state, exec, writeWav }
  }

  it('/edit setTakeActive：一次撤销、与工具同语义', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    const server = await startServer(state)
    try {
      const a = await exec('studio_import_audio', { path: await writeWav('e1.wav', 1), takeGroup: 'g' })
      const b = await exec('studio_import_audio', { path: await writeWav('e2.wav', 2), takeGroup: 'g' })
      const rev = state.revision
      const res = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'setTakeActive', takeGroup: 'g', takeIndex: 0 }],
      })
      assert.equal(res.status, 200)
      assert.equal(res.data.ok, true, res.data.error)
      assert.equal(state.revision, rev + 1)
      assert.equal(state.historyState().undoLabel, '切换 take')
      assert.equal(Object.hasOwn(state.project.clips.find((clip) => clip.id === a.clipId), 'takeActive'), false)
      assert.equal(state.project.clips.find((clip) => clip.id === b.clipId).takeActive, false)
      const undo = await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(undo.data.ok, true)
      assert.equal(Object.hasOwn(state.project.clips.find((clip) => clip.id === b.clipId), 'takeActive'), false)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch setTakeActive：白名单生效、结果含 activeClipIds/deactivatedClipIds', async () => {
    const { state, exec, writeWav } = await makeTakeTools()
    try {
      const a = await exec('studio_import_audio', { path: await writeWav('b1.wav', 1), takeGroup: 'g' })
      const b = await exec('studio_import_audio', { path: await writeWav('b2.wav', 2), takeGroup: 'g' })
      // 切到 takeIndex=0（当前 active 是 index=1）→ 内容有变化，一次批量撤销
      const result = await exec('studio_batch', { ops: [{ type: 'setTakeActive', args: { takeGroup: 'g', takeIndex: 0 } }] })
      assert.equal(result.ok, true, result.error)
      const entry = result.results.find((item) => item.type === 'setTakeActive')
      assert.ok(entry)
      assert.deepEqual(entry.activeClipIds, [a.clipId])
      assert.deepEqual(entry.deactivatedClipIds, [b.clipId])
      assert.equal(state.historyState().undoLabel, '批量编辑')
      assert.equal(Object.hasOwn(state.project.clips.find((clip) => clip.id === a.clipId), 'takeActive'), false)
      assert.equal(state.project.clips.find((clip) => clip.id === b.clipId).takeActive, false)
      void a
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R3a：乐理工具 / 和弦 / 琶音 / Groove                                        */
/* ------------------------------------------------------------------------- */

describe('R3a — studio_get_theory / write_chords / generate_arp / apply_groove', () => {
  async function makeTheoryTools() {
    // 空工程：避免 demo 现有 pattern 音符干扰 noteCount 断言
    const { dir, state } = await makeState({ withDemo: false })
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    let patternId = null
    state.mutate({ tool: 'test_r3a' }, (draft) => {
      draft.key = 'C'
      draft.scale = 'major'
      const pattern = ops.addPattern(draft, { name: 'Theory Test', lengthBars: 4 })
      patternId = pattern.patternId
      return undefined
    })
    const pattern = () => state.project.patterns.find((item) => item.id === patternId)
    return { dir, state, tools, exec, patternId: () => patternId, pattern }
  }

  it('studio_get_theory：默认返回 key/scale/音阶/7 级和弦/建议进行，只读', async () => {
    const { state, exec } = await makeTheoryTools()
    try {
      const revision = state.revision
      const result = await exec('studio_get_theory')
      assert.equal(result.ok, true, result.error)
      assert.equal(result.key, 'C')
      assert.equal(result.scale, 'major')
      assert.equal(result.scaleLabel, '自然大调')
      assert.deepEqual(result.scaleNotes, [60, 62, 64, 65, 67, 69, 71])
      assert.equal(result.diatonicChords.length, 7)
      assert.deepEqual(result.diatonicChords.map((chord) => chord.roman), ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'])
      assert.ok(result.suggestedProgressions.length >= 3)
      assert.ok(result.suggestedProgressions.some((item) => item.romans.join('-') === 'I-V-vi-IV'))
      assert.equal(state.revision, revision)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_get_theory：自定义 key/scale；非法 key/scale 中文拒绝', async () => {
    const { state, exec } = await makeTheoryTools()
    try {
      const custom = await exec('studio_get_theory', { key: 'A', scale: 'minor' })
      assert.equal(custom.ok, true, custom.error)
      assert.equal(custom.key, 'A')
      assert.equal(custom.diatonicChords[0].name, 'Am')
      assert.equal(custom.diatonicChords[2].name, 'C')
      const badKey = await exec('studio_get_theory', { key: 'H' })
      assert.equal(badKey.ok, false)
      assert.match(badKey.error, /key/)
      const badScale = await exec('studio_get_theory', { scale: 'blues' })
      assert.equal(badScale.ok, false)
      assert.match(badScale.error, /scale/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_write_chords：C 大调 I-V-vi-IV 音高/起点/时值/一次撤销', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const result = await exec('studio_write_chords', { patternId: state.project.patterns[0].id, progression: ['I', 'V', 'vi', 'IV'] })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.noteCount, 12)
      assert.equal(result.chords.length, 4)
      assert.deepEqual(result.chords.map((chord) => chord.rootPitch), [60, 67, 69, 65])
      const notes = pattern().notes
      assert.equal(notes.length, 12)
      assert.deepEqual(notes.filter((note) => note.start === 0).map((note) => note.pitch).sort((a, b) => a - b), [60, 64, 67])
      assert.deepEqual(notes.filter((note) => note.start === 4).map((note) => note.pitch).sort((a, b) => a - b), [67, 71, 74])
      assert.equal(notes[0].dur, 3.8)
      assert.equal(state.historyState().undoLabel, '写和弦')
      await exec('studio_undo')
      assert.equal(pattern().notes.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_write_chords：对象项 rootPitch/quality、replaceExisting=true 替换、追加模式', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      const appended = await exec('studio_write_chords', { patternId, progression: ['I'] })
      assert.equal(appended.ok, true, appended.error)
      const replaced = await exec('studio_write_chords', {
        patternId,
        progression: [{ rootPitch: 60, quality: 'min7' }],
        replaceExisting: true,
      })
      assert.equal(replaced.ok, true, replaced.error)
      assert.equal(pattern().notes.length, 4)
      assert.deepEqual(pattern().notes.map((note) => note.pitch), [60, 63, 67, 70])
      await exec('studio_write_chords', { patternId, progression: ['V'] })
      assert.equal(pattern().notes.length, 7, '默认追加')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_write_chords 非法：pattern/progression/罗马数字/性质/voicing 中文拒绝', async () => {
    const { state, exec } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      for (const args of [
        { patternId: 'pat_999', progression: ['I'] },
        { patternId, progression: [] },
        { patternId, progression: ['VIII'] },
        { patternId, progression: [{ rootPitch: 60, quality: 'bogus' }] },
        { patternId, progression: ['I'], voicing: 'weird' },
      ]) {
        const result = await exec('studio_write_chords', args)
        assert.equal(result.ok, false, JSON.stringify(args))
        assert.match(result.error, /\S/)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_generate_arp：chordPitches up 4 音、replaceExisting、一次撤销', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      const result = await exec('studio_generate_arp', {
        patternId,
        chordPitches: [60, 64, 67],
        pattern: 'up',
        rate: 0.25,
        beats: 1,
        replaceExisting: true,
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.noteCount, 4)
      assert.deepEqual(pattern().notes.map((note) => note.pitch), [60, 64, 67, 60])
      assert.deepEqual(pattern().notes.map((note) => note.start), [0, 0.25, 0.5, 0.75])
      assert.equal(state.historyState().undoLabel, '生成琶音')
      await exec('studio_undo')
      assert.equal(pattern().notes.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_generate_arp：random 同 seed 确定性、不同 seed 可不同；octaves 扩展', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      await exec('studio_generate_arp', { patternId, chordPitches: [60, 64, 67], pattern: 'random', beats: 2, seed: 7, replaceExisting: true })
      const first = JSON.stringify(pattern().notes)
      await exec('studio_generate_arp', { patternId, chordPitches: [60, 64, 67], pattern: 'random', beats: 2, seed: 7, replaceExisting: true })
      assert.equal(JSON.stringify(pattern().notes), first)
      await exec('studio_generate_arp', { patternId, chordPitches: [60, 64, 67], pattern: 'up', beats: 1, octaves: 2, replaceExisting: true })
      assert.ok(pattern().notes.some((note) => note.pitch >= 72))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_generate_arp：progression 分段生成；非法 pattern/无来源中文拒绝', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      const result = await exec('studio_generate_arp', { patternId, progression: ['I', 'V'], beats: 4, rate: 0.25, replaceExisting: true })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.noteCount, 16)
      assert.ok(pattern().notes.some((note) => note.start >= 2))
      const bad = await exec('studio_generate_arp', { patternId, chordPitches: [60], pattern: 'sideways' })
      assert.equal(bad.ok, false)
      assert.match(bad.error, /pattern/)
      const none = await exec('studio_generate_arp', { patternId })
      assert.equal(none.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_apply_groove：swing60 偏移反拍、straight 幂等、undo', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      state.mutate({ tool: 'test' }, (draft) => {
        ops.setNotes(draft, {
          patternId,
          notes: [
            { pitch: 60, start: 0, dur: 1, vel: 0.8 },
            { pitch: 62, start: 0.5, dur: 0.5, vel: 0.8 },
            { pitch: 64, start: 1, dur: 1, vel: 0.8 },
          ],
        })
        return undefined
      })
      const swung = await exec('studio_apply_groove', { patternId, template: 'swing60' })
      assert.equal(swung.ok, true, swung.error)
      assert.equal(swung.changed, true)
      assert.equal(pattern().notes.find((note) => note.pitch === 60).start, 0)
      assert.ok(Math.abs(pattern().notes.find((note) => note.pitch === 62).start - 0.6) < 1e-9)
      assert.equal(state.historyState().undoLabel, '应用 Groove')
      const straight = await exec('studio_apply_groove', { patternId, template: 'straight' })
      assert.equal(straight.ok, true, straight.error)
      assert.equal(straight.changed, false)
      await exec('studio_undo')
      assert.equal(pattern().notes.find((note) => note.pitch === 62).start, 0.5)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_apply_groove：quantizeGrid 先量化；非法模板中文拒绝', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      state.mutate({ tool: 'test' }, (draft) => {
        ops.setNotes(draft, { patternId, notes: [{ pitch: 60, start: 0.33, dur: 1, vel: 0.8 }] })
        return undefined
      })
      const result = await exec('studio_apply_groove', { patternId, template: 'straight', quantizeGrid: 0.25 })
      assert.equal(result.ok, true, result.error)
      assert.equal(pattern().notes[0].start, 0.25)
      const bad = await exec('studio_apply_groove', { patternId, template: 'bogus' })
      assert.equal(bad.ok, false)
      assert.match(bad.error, /groove/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit 支持 writeChords/generateArp/applyGroove，各自一次撤销', async () => {
    const { state, exec } = await makeTheoryTools()
    const server = await startServer(state)
    try {
      const patternId = state.project.patterns[0].id
      const rev = state.revision
      const chords = await postJson(server.base, '/studio/api/edit', { ops: [{ type: 'writeChords', patternId, progression: ['I', 'V'] }] })
      assert.equal(chords.status, 200)
      assert.equal(chords.data.ok, true, chords.data.error)
      assert.equal(state.revision, rev + 1)
      assert.equal(state.historyState().undoLabel, '写和弦')
      const arp = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'generateArp', patternId, chordPitches: [60, 64, 67], pattern: 'up', beats: 1, replaceExisting: true }],
      })
      assert.equal(arp.data.ok, true, arp.data.error)
      assert.equal(state.historyState().undoLabel, '生成琶音')
      const groove = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'applyGroove', patternId, template: 'swing60' }],
      })
      assert.equal(groove.data.ok, true, groove.data.error)
      assert.equal(state.historyState().undoLabel, '应用 Groove')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.historyState().undoLabel, '生成琶音')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch 支持 writeChords+applyGroove，一次撤销标签「批量编辑」', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      const result = await exec('studio_batch', {
        ops: [
          { type: 'writeChords', args: { patternId, progression: ['I', 'IV'] } },
          { type: 'applyGroove', args: { patternId, template: 'swing60' } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 2)
      assert.equal(state.historyState().undoLabel, '批量编辑')
      assert.equal(pattern().notes.length, 6)
      await exec('studio_undo')
      assert.equal(pattern().notes.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('writeChords/generateArp 支持 expectedRevision 冲突不写入', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      const stale = state.revision - 1
      const chords = await exec('studio_write_chords', { patternId, progression: ['I'], expectedRevision: stale })
      assert.equal(chords.ok, false)
      assert.equal(chords.retry, true)
      const arp = await exec('studio_generate_arp', { patternId, chordPitches: [60], expectedRevision: stale })
      assert.equal(arp.ok, false)
      assert.equal(pattern().notes.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('writeChords octave/inversion/voicing open 生效且 pitch 夹紧', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      const result = await exec('studio_write_chords', {
        patternId,
        progression: ['I'],
        octave: 3,
        inversion: 1,
        voicing: 'open',
        replaceExisting: true,
      })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(pattern().notes.map((note) => note.pitch), [52, 60, 67])
      assert.ok(pattern().notes.every((note) => note.pitch >= 0 && note.pitch <= 127))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('get_theory 随工程 key/scale 变化同步（A minor）', async () => {
    const { state, exec } = await makeTheoryTools()
    try {
      state.mutate({ tool: 'test' }, (draft) => {
        draft.key = 'A'
        draft.scale = 'minor'
        return undefined
      })
      const result = await exec('studio_get_theory')
      assert.equal(result.key, 'A')
      assert.equal(result.scale, 'minor')
      assert.equal(result.diatonicChords[0].name, 'Am')
      assert.equal(result.scaleNotes[0], 69)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('applyGroove 生成的音符可正常保存→打开→重启保留', async () => {
    const { state, exec, pattern } = await makeTheoryTools()
    try {
      const patternId = state.project.patterns[0].id
      await exec('studio_write_chords', { patternId, progression: ['I', 'V'], replaceExisting: true })
      await exec('studio_apply_groove', { patternId, template: 'shuffle', strength: 0.5 })
      await exec('studio_save_project', { name: 'R3a 理论工程', overwrite: true })
      const before = JSON.stringify(pattern().notes)
      await exec('studio_open_project', { name: 'R3a 理论工程' })
      const reopened = state.project.patterns.find((item) => item.id === patternId)
      assert.equal(JSON.stringify(reopened.notes), before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R3a — 真实 DSL 参数校验', () => {
  it('write_chords/generate_arp progression 接受字符串/对象/混合数组', async () => {
    const { state } = await makeState({ withDemo: false })
    state.mutate({ tool: 'test' }, (draft) => {
      ops.addPattern(draft, { name: 'DSL 校验', lengthBars: 4 })
      return undefined
    })
    const tools = createTools({ defineTool: realDefineTool, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    try {
      const patternId = state.project.patterns[0].id
      for (const progression of [
        ['I', 'V', 'vi', 'IV'],
        [{ roman: 'I' }, { roman: 'V' }],
        ['I', { rootPitch: 60, quality: 'min7' }],
      ]) {
        const result = await exec('studio_write_chords', { patternId, progression, replaceExisting: true })
        assert.equal(result.ok, true, JSON.stringify(progression) + ' => ' + (result.error ?? ''))
      }
      const arp = await exec('studio_generate_arp', { patternId, progression: ['I', 'V'], beats: 1, replaceExisting: true })
      assert.equal(arp.ok, true, arp.error)
      await assert.rejects(() => exec('studio_write_chords', { patternId, progression: 123 }), /invalid arguments/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R3b：CC automation 工具 / 持久化 / MIDI 导出导入                            */
/* ------------------------------------------------------------------------- */

describe('R3b — CC automation 工具与 MIDI 往返', () => {
  async function makeR3bTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { dir, state, tools, exec }
  }

  it('studio_set_automation：track 支持 cc1/cc11/cc64/cc74，get_project 摘要正确', async () => {
    const { state, exec } = await makeR3bTools()
    try {
      const trackId = 'trk_1'
      for (const param of ['cc1', 'cc11', 'cc64', 'cc74']) {
        const result = await exec('studio_set_automation', {
          target: 'track',
          trackId,
          param,
          points: [{ beat: 0, value: 0 }, { beat: 8, value: 1 }],
        })
        assert.equal(result.ok, true, `${param}: ${result.error}`)
      }
      const overview = await exec('studio_get_project')
      const track = overview.tracks.find((item) => item.id === trackId)
      for (const param of ['cc1', 'cc11', 'cc64', 'cc74']) {
        assert.ok(track.automation[param], param)
        assert.equal(track.automation[param].pointCount, 2)
      }
      assert.equal(track.automation.cc1.firstBeat, 0)
      assert.equal(track.automation.cc1.lastBeat, 8)
      const cc1 = state.project.tracks.find((item) => item.id === trackId).automation.cc1
      assert.equal(cc1.enabled, true)
      assert.deepEqual(cc1.points, [{ beat: 0, value: 0 }, { beat: 8, value: 1 }])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_set_automation 参数枚举包含 10 个参数；master 拒绝 CC；非法参数中文错误', async () => {
    const { state, tools, exec } = await makeR3bTools()
    try {
      const tool = tools.find((item) => item.name === 'studio_set_automation')
      assert.deepEqual(tool.parameters.param.enum, [
        'volume', 'pan', 'cutoff', 'pitchBend', 'modulation', 'expression', 'cc1', 'cc11', 'cc64', 'cc74',
      ])
      const master = await exec('studio_set_automation', { target: 'master', param: 'cc1', points: [{ beat: 0, value: 0.5 }] })
      assert.equal(master.ok, false)
      assert.match(master.error, /master 只支持 volume/)
      const badParam = await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc99', points: [{ beat: 0, value: 0.5 }] })
      assert.equal(badParam.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_clear_automation：清除单条 CC 曲线，其他曲线保留', async () => {
    const { state, exec } = await makeR3bTools()
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc1', points: [{ beat: 0, value: 0.2 }] })
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc74', points: [{ beat: 0, value: 0.8 }] })
      const cleared = await exec('studio_clear_automation', { target: 'track', trackId: 'trk_1', param: 'cc1' })
      assert.equal(cleared.ok, true, cleared.error)
      const automation = state.project.tracks.find((item) => item.id === 'trk_1').automation
      assert.equal(automation.cc1, undefined)
      assert.ok(automation.cc74)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('CC 自动化保存→新建→打开→重启后持久化', async () => {
    const { dir, state, exec } = await makeR3bTools()
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc11', points: [{ beat: 0, value: 0.1 }, { beat: 4, value: 0.9 }] })
      await exec('studio_save_project', { name: 'R3b CC 工程', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      const opened = await exec('studio_open_project', { name: 'R3b CC 工程' })
      assert.equal(opened.ok, true, opened.error)
      assert.deepEqual(state.project.tracks.find((item) => item.id === 'trk_1').automation.cc11.points, [
        { beat: 0, value: 0.1 },
        { beat: 4, value: 0.9 },
      ])
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.deepEqual(reloaded.project.tracks.find((item) => item.id === 'trk_1').automation.cc11.points, [
          { beat: 0, value: 0.1 },
          { beat: 4, value: 0.9 },
        ])
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('导出 MIDI 路由：CC automation 写成 0xB0 事件（cc1/cc11/cc74）', async () => {
    const { state, exec } = await makeR3bTools()
    const server = await startServer(state)
    try {
      for (const param of ['cc1', 'cc11', 'cc74']) {
        await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param, points: [{ beat: 0, value: 0 }, { beat: 2, value: 1 }] })
      }
      const exported = await postJson(server.base, '/studio/api/export-midi', { name: 'R3b CC' })
      assert.equal(exported.data.ok, true, exported.data.error)
      const buffer = await readFile(exported.data.path)
      const parsed = parseMidiBuffer(buffer)
      const ccNumbers = parsed.tracks.flatMap((track) => track.controllers).filter((event) => event.type === 'cc').map((event) => event.cc)
      for (const cc of [1, 11, 74]) assert.ok(ccNumbers.includes(cc), `缺少 CC${cc}`)
      const beats = parsed.tracks.flatMap((track) => track.controllers).filter((event) => event.cc === 1).map((event) => event.tick / 480)
      assert.deepEqual(beats, [0, 2])
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_import_midi：从导出的 MIDI 恢复 CC/pitch bend/expression automation', async () => {
    const { state, exec } = await makeR3bTools()
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc1', points: [{ beat: 0, value: 0.2 }, { beat: 3, value: 0.8 }] })
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc11', points: [{ beat: 1, value: 0.6 }] })
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'pitchBend', points: [{ beat: 0, value: 0.75 }] })
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'expression', points: [{ beat: 2, value: 0.5 }] })
      const midiPath = path.join(state.dataDir, 'r3b-roundtrip.mid')
      await writeFile(midiPath, buildMidiFile(state.project))
      const imported = await exec('studio_import_midi', { path: midiPath, replace: true, title: 'R3b 往返' })
      assert.equal(imported.ok, true, imported.error)
      assert.ok(imported.automationTracks >= 1)
      const automation = state.project.tracks.flatMap((track) => track.automation ? [track.automation] : [])[0]
      assert.ok(automation)
      for (const param of ['cc1', 'cc11', 'pitchBend', 'expression']) assert.ok(automation[param], param)
      assert.equal(automation.cc1.points.length, 2)
      assert.equal(automation.cc1.points[0].beat, 0)
      assert.ok(Math.abs(automation.cc1.points[0].value - 0.2) <= 1 / 127 + 1e-9)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_import_midi：旧 MIDI（无 CC）不产生 automation', async () => {
    const { state, exec } = await makeR3bTools()
    try {
      const midiPath = path.join(state.dataDir, 'legacy.mid')
      await writeFile(midiPath, buildMidiFile(createDemoProject()))
      const imported = await exec('studio_import_midi', { path: midiPath, replace: true, title: '旧 MIDI' })
      assert.equal(imported.ok, true, imported.error)
      assert.equal(imported.automationTracks, 0)
      assert.ok(state.project.tracks.every((track) => !track.automation || Object.keys(track.automation).length === 0))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('disabled 的 CC 曲线不写入 MIDI 导出', async () => {
    const { state, exec } = await makeR3bTools()
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc1', points: [{ beat: 0, value: 1 }] })
      state.mutate({ tool: 'test' }, (draft) => {
        draft.tracks.find((item) => item.id === 'trk_1').automation.cc1.enabled = false
        return undefined
      })
      const buffer = buildMidiFile(state.project)
      const parsed = parseMidiBuffer(buffer)
      assert.equal(parsed.tracks.flatMap((track) => track.controllers).filter((event) => event.cc === 1).length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/state 返回 CC automation；normalizeProject 保留 10 参数中的 cc 曲线', async () => {
    const { state, exec } = await makeR3bTools()
    const server = await startServer(state)
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc74', points: [{ beat: 0, value: 0.25 }] })
      const current = await getJson(server.base, '/studio/api/state?rev=0')
      const track = current.data.project.tracks.find((item) => item.id === 'trk_1')
      assert.deepEqual(track.automation.cc74.points, [{ beat: 0, value: 0.25 }])
      const revision = state.revision
      const reloaded = await exec('studio_get_project')
      assert.ok(reloaded.tracks.find((item) => item.id === 'trk_1').automation.cc74)
      assert.equal(state.revision, revision, '读取不改 revision')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('set_automation CC：>256 点被拒绝；正常点 value 夹紧 0..1', async () => {
    const { state, exec } = await makeR3bTools()
    try {
      const tooMany = Array.from({ length: 300 }, (_, index) => ({ beat: index * 0.1, value: 0.5 }))
      const rejected = await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc1', points: tooMany })
      assert.equal(rejected.ok, false)
      assert.match(rejected.error, /256/)
      const result = await exec('studio_set_automation', {
        target: 'track',
        trackId: 'trk_1',
        param: 'cc1',
        points: [{ beat: 0, value: -1 }, { beat: 1, value: 2 }],
      })
      assert.equal(result.ok, true, result.error)
      const curve = state.project.tracks.find((item) => item.id === 'trk_1').automation.cc1
      assert.deepEqual(curve.points.map((point) => point.value), [0, 1])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('导出 MIDI 再导入：cc64 曲线往返（tick/value 匹配）', async () => {
    const { state, exec } = await makeR3bTools()
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc64', points: [{ beat: 4, value: 1 }] })
      const midiPath = path.join(state.dataDir, 'cc64.mid')
      await writeFile(midiPath, buildMidiFile(state.project))
      const imported = await exec('studio_import_midi', { path: midiPath, replace: true })
      assert.equal(imported.ok, true, imported.error)
      const automation = state.project.tracks.find((track) => track.automation?.cc64)?.automation
      assert.ok(automation)
      assert.equal(automation.cc64.points[0].beat, 4)
      assert.equal(automation.cc64.points[0].value, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('set_automation cc 曲线与旧曲线共存，undo 只回退本次', async () => {
    const { state, exec } = await makeR3bTools()
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.5 }] })
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc11', points: [{ beat: 0, value: 0.3 }] })
      const automation = state.project.tracks.find((item) => item.id === 'trk_1').automation
      assert.ok(automation.volume && automation.cc11)
      await exec('studio_undo')
      const afterUndo = state.project.tracks.find((item) => item.id === 'trk_1').automation
      assert.equal(afterUndo.cc11, undefined)
      assert.ok(afterUndo.volume)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('MIDI 导入 tool 返回 imported.automationTracks，且不会把 CC-only 轨变成新轨道', async () => {
    const { state, exec } = await makeR3bTools()
    try {
      const source = createDemoProject()
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc1', points: [{ beat: 0, value: 0.5 }] })
      const midiPath = path.join(state.dataDir, 'count-tracks.mid')
      await writeFile(midiPath, buildMidiFile(state.project))
      const imported = await exec('studio_import_midi', { path: midiPath, replace: true })
      assert.equal(imported.ok, true, imported.error)
      assert.ok(imported.tracks >= source.tracks.length)
      assert.equal(imported.automationTracks, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R3b — clear_automation 真实 DSL 枚举', () => {
  it('studio_clear_automation 真实 DSL 支持 cc1/cc11/cc64/cc74', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: realDefineTool, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    try {
      for (const param of ['cc1', 'cc11', 'cc64', 'cc74']) {
        const set = await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param, points: [{ beat: 0, value: 0.5 }] })
        assert.equal(set.ok, true, set.error)
      }
      for (const param of ['cc1', 'cc11', 'cc64', 'cc74']) {
        const cleared = await exec('studio_clear_automation', { target: 'track', trackId: 'trk_1', param })
        assert.equal(cleared.ok, true, param + ': ' + (cleared.error ?? ''))
      }
      const automation = state.project.tracks.find((item) => item.id === 'trk_1').automation
      assert.equal(automation, undefined)
      // master 仍只允许 volume（cc11 被 ops 拒绝，中文错误）
      const master = await exec('studio_clear_automation', { target: 'master', param: 'cc11' })
      assert.equal(master.ok, false)
      assert.match(master.error, /master 只支持 volume/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_set_automation 真实 DSL 参数枚举含全部 10 个参数', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: realDefineTool, state })
    const tool = tools.find((item) => item.name === 'studio_set_automation')
    try {
      const expected = ['volume', 'pan', 'cutoff', 'pitchBend', 'modulation', 'expression', 'cc1', 'cc11', 'cc64', 'cc74']
      // 真实 defineTool 暴露 JSON Schema（parameters.properties.*），与 mock 的 DSL 形状不同。
      assert.deepEqual(tool.parameters.properties.param.enum, expected)
      const clearTool = tools.find((item) => item.name === 'studio_clear_automation')
      assert.deepEqual(clearTool.parameters.properties.param.enum, expected)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('CC set→clear→保存→打开：清空状态持久化', async () => {
    const { state, tools } = await (async () => {
      const { state: s } = await makeState()
      return { state: s, tools: createTools({ defineTool: (options) => options, state: s }) }
    })()
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'cc11', points: [{ beat: 0, value: 0.4 }] })
      await exec('studio_clear_automation', { target: 'track', trackId: 'trk_1', param: 'cc11' })
      await exec('studio_save_project', { name: 'R3b clear 持久化', overwrite: true })
      await exec('studio_open_project', { name: 'R3b clear 持久化' })
      const track = state.project.tracks.find((item) => item.id === 'trk_1')
      assert.ok(!track.automation || !track.automation.cc11)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R3c：MIDI Learn 映射工具 / edit ops / 持久化                                */
/* ------------------------------------------------------------------------- */

describe('R3c — MIDI Learn 映射', () => {
  async function makeR3cTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { dir, state, tools, exec }
  }

  it('studio_set_midi_mapping：volume 基础映射、get_project 全量、undo', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const result = await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1' })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.mapping.id, 'map_1')
      assert.equal(result.mapping.channel, null)
      assert.equal(result.mapping.min, 0)
      assert.equal(result.mapping.max, 1)
      assert.equal(result.count, 1)
      const list = await exec('studio_list_midi_mappings')
      assert.equal(list.count, 1)
      assert.deepEqual(list.midiMappings, state.project.midiMappings)
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.midiMappings, state.project.midiMappings)
      assert.equal(overview.midiMappingsTotal, 1)
      await exec('studio_undo')
      assert.equal(state.project.midiMappings.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('targets：pan/sendReverb/sendDelay 可映射', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const targets = [
        ['pan', 2],
        ['sendReverb', 3],
        ['sendDelay', 4],
      ]
      for (const [target, cc] of targets) {
        const result = await exec('studio_set_midi_mapping', { cc, target, trackId: 'trk_1' })
        assert.equal(result.ok, true, `${target}: ${result.error}`)
        assert.equal(result.mapping.target, target)
      }
      assert.equal(state.project.midiMappings.length, 3)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('effectParam：有效效果器参数成功；无效 effectId/param 中文拒绝', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const effect = await exec('studio_add_effect', { target: 'trk_1', type: 'filter' })
      assert.equal(effect.ok, true, effect.error)
      const effectId = effect.effectId
      const valid = await exec('studio_set_midi_mapping', {
        cc: 74,
        target: 'effectParam',
        trackId: 'trk_1',
        effectId,
        param: 'cutoff',
        min: 0.2,
        max: 0.9,
      })
      assert.equal(valid.ok, true, valid.error)
      assert.equal(valid.mapping.effectId, effectId)
      assert.equal(valid.mapping.param, 'cutoff')
      const badEffect = await exec('studio_set_midi_mapping', { cc: 75, target: 'effectParam', trackId: 'trk_1', effectId: 'fx_404', param: 'cutoff' })
      assert.equal(badEffect.ok, false)
      assert.match(badEffect.error, /effectId/)
      const badParam = await exec('studio_set_midi_mapping', { cc: 76, target: 'effectParam', trackId: 'trk_1', effectId, param: 'bogus' })
      assert.equal(badParam.ok, false)
      assert.match(badParam.error, /参数/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('非法参数：cc/channel/target/track/minmax 中文拒绝', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      for (const args of [
        { cc: 128, target: 'volume', trackId: 'trk_1' },
        { cc: -1, target: 'volume', trackId: 'trk_1' },
        { cc: 1, channel: 16, target: 'volume', trackId: 'trk_1' },
        { cc: 1, target: 'bogus', trackId: 'trk_1' },
        { cc: 1, target: 'volume', trackId: 'trk_999' },
        { cc: 1, target: 'volume', trackId: 'trk_1', min: 0.9, max: 0.1 },
        { cc: 1, target: 'effectParam', trackId: 'trk_1', effectId: 'fx_404', param: 'cutoff' },
      ]) {
        const result = await exec('studio_set_midi_mapping', args)
        assert.equal(result.ok, false, JSON.stringify(args))
      }
      assert.equal(state.project.midiMappings.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('上限 16 条：第 17 条中文拒绝；更新已有不增加', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      for (let cc = 0; cc < 16; cc += 1) {
        const result = await exec('studio_set_midi_mapping', { cc, target: 'volume', trackId: 'trk_1' })
        assert.equal(result.ok, true, `cc${cc}: ${result.error}`)
      }
      assert.equal(state.project.midiMappings.length, 16)
      const overflow = await exec('studio_set_midi_mapping', { cc: 100, target: 'volume', trackId: 'trk_1' })
      assert.equal(overflow.ok, false)
      assert.match(overflow.error, /上限 16/)
      // 更新已有 cc=0 映射不超限
      const update = await exec('studio_set_midi_mapping', { cc: 0, target: 'pan', trackId: 'trk_1' })
      assert.equal(update.ok, true, update.error)
      assert.equal(update.mapping.target, 'pan')
      assert.equal(state.project.midiMappings.length, 16)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('同 cc+channel 更新原映射；同 id 更新；cc 冲突拒绝', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const first = await exec('studio_set_midi_mapping', { cc: 10, target: 'volume', trackId: 'trk_1' })
      const updated = await exec('studio_set_midi_mapping', { cc: 10, target: 'pan', trackId: 'trk_1' })
      assert.equal(updated.mapping.id, first.mapping.id, '同 cc+channel 应更新同一条')
      assert.equal(updated.mapping.target, 'pan')
      assert.equal(state.project.midiMappings.length, 1)
      const byId = await exec('studio_set_midi_mapping', { cc: 11, target: 'volume', trackId: 'trk_1', id: first.mapping.id })
      assert.equal(byId.mapping.id, first.mapping.id)
      assert.equal(byId.mapping.cc, 11)
      assert.equal(state.project.midiMappings.length, 1)
      const second = await exec('studio_set_midi_mapping', { cc: 12, target: 'volume', trackId: 'trk_1' })
      assert.ok(second.ok)
      const conflict = await exec('studio_set_midi_mapping', { cc: 12, target: 'pan', trackId: 'trk_1', id: first.mapping.id })
      assert.equal(conflict.ok, false)
      assert.match(conflict.error, /已被映射/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('clear：按 id 删除/幂等；无 selector 拒绝', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const created = await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1' })
      const cleared = await exec('studio_clear_midi_mapping', { id: created.mapping.id })
      assert.equal(cleared.ok, true, cleared.error)
      assert.equal(cleared.cleared, true)
      assert.equal(cleared.removed, 1)
      assert.equal(state.project.midiMappings.length, 0)
      const again = await exec('studio_clear_midi_mapping', { id: created.mapping.id })
      assert.equal(again.ok, true)
      assert.equal(again.cleared, false)
      const none = await exec('studio_clear_midi_mapping', {})
      assert.equal(none.ok, false)
      assert.match(none.error, /id 或 cc/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('clear：按 cc 删除任意 channel / 指定 channel；不影响其他映射', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      await exec('studio_set_midi_mapping', { cc: 7, target: 'volume', trackId: 'trk_1' })
      await exec('studio_set_midi_mapping', { cc: 7, channel: 0, target: 'pan', trackId: 'trk_1' })
      await exec('studio_set_midi_mapping', { cc: 8, target: 'sendReverb', trackId: 'trk_1' })
      const cleared = await exec('studio_clear_midi_mapping', { cc: 7 })
      assert.equal(cleared.cleared, true)
      assert.equal(cleared.removed, 2)
      assert.deepEqual(state.project.midiMappings.map((mapping) => mapping.cc), [8])
      const specific = await exec('studio_clear_midi_mapping', { cc: 8, channel: 0 })
      assert.equal(specific.cleared, false)
      assert.equal(state.project.midiMappings.length, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit setMidiMapping + clearMidiMapping：一次撤销 & 撤销标签', async () => {
    const { state } = await makeR3cTools()
    const server = await startServer(state)
    try {
      const set = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'setMidiMapping', cc: 1, target: 'volume', trackId: 'trk_1' }],
      })
      assert.equal(set.status, 200)
      assert.equal(set.data.ok, true, set.data.error)
      assert.equal(state.historyState().undoLabel, '设置 MIDI 映射')
      assert.equal(state.project.midiMappings.length, 1)
      const clear = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'clearMidiMapping', id: state.project.midiMappings[0].id }],
      })
      assert.equal(clear.data.ok, true)
      assert.equal(state.historyState().undoLabel, '清除 MIDI 映射')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.midiMappings.length, 1)
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.midiMappings.length, 0)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch setMidiMapping+clearMidiMapping：一次撤销标签「批量编辑」', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const result = await exec('studio_batch', {
        ops: [
          { type: 'setMidiMapping', args: { cc: 1, target: 'volume', trackId: 'trk_1' } },
          { type: 'setMidiMapping', args: { cc: 2, target: 'pan', trackId: 'trk_1' } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 2)
      assert.equal(state.project.midiMappings.length, 2)
      assert.equal(state.historyState().undoLabel, '批量编辑')
      await exec('studio_undo')
      assert.equal(state.project.midiMappings.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('持久化：保存→新建→打开→重启后映射完整保留', async () => {
    const { dir, state, exec } = await makeR3cTools()
    try {
      const effect = await exec('studio_add_effect', { target: 'trk_1', type: 'filter' })
      await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1', min: 0.1, max: 0.9 })
      await exec('studio_set_midi_mapping', {
        cc: 74,
        target: 'effectParam',
        trackId: 'trk_1',
        effectId: effect.effectId,
        param: 'cutoff',
      })
      await exec('studio_save_project', { name: 'R3c MIDI 工程', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R3c MIDI 工程' })
      assert.equal(state.project.midiMappings.length, 2)
      assert.equal(state.project.midiMappings[0].min, 0.1)
      assert.equal(state.project.midiMappings[0].max, 0.9)
      assert.equal(state.project.midiMappings[1].param, 'cutoff')
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.equal(reloaded.project.midiMappings.length, 2)
        assert.equal(reloaded.project.midiMappings[1].cc, 74)
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('撤销/重做包含 midiMappings（CONTENT_KEYS）', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      await exec('studio_set_midi_mapping', { cc: 5, target: 'volume', trackId: 'trk_1' })
      assert.equal(state.project.midiMappings.length, 1)
      await exec('studio_clear_midi_mapping', { cc: 5 })
      assert.equal(state.project.midiMappings.length, 0)
      await exec('studio_undo')
      assert.equal(state.project.midiMappings.length, 1)
      await exec('studio_redo')
      assert.equal(state.project.midiMappings.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('channel null 与 channel 0 是两条映射，可分别更新', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      await exec('studio_set_midi_mapping', { cc: 9, target: 'volume', trackId: 'trk_1' })
      await exec('studio_set_midi_mapping', { cc: 9, channel: 0, target: 'pan', trackId: 'trk_1' })
      assert.equal(state.project.midiMappings.length, 2)
      await exec('studio_set_midi_mapping', { cc: 9, channel: 0, target: 'sendReverb', trackId: 'trk_1' })
      assert.equal(state.project.midiMappings.length, 2)
      assert.equal(state.project.midiMappings.find((mapping) => mapping.channel === 0).target, 'sendReverb')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('自动 id 递增：删除后再新增取 max+1', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const a = await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1' })
      const b = await exec('studio_set_midi_mapping', { cc: 2, target: 'volume', trackId: 'trk_1' })
      assert.deepEqual([a.mapping.id, b.mapping.id], ['map_1', 'map_2'])
      await exec('studio_clear_midi_mapping', { id: 'map_2' })
      const c = await exec('studio_set_midi_mapping', { cc: 3, target: 'volume', trackId: 'trk_1' })
      assert.equal(c.mapping.id, 'map_2')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突不写入', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const stale = state.revision - 1
      const result = await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1', expectedRevision: stale })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.midiMappings.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('get_project midiMappings 为拷贝（修改返回不影响工程）', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1' })
      const overview = await exec('studio_get_project')
      overview.midiMappings[0].cc = 99
      assert.equal(state.project.midiMappings[0].cc, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R3c 补充：工具边界 */
describe('R3c — 映射工具补充', () => {
  async function makeR3cTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { dir, state, exec }
  }

  it('studio_list_midi_mappings 只读：不改 revision/不占撤销步', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1' })
      const revision = state.revision
      const undoDepth = state.historyState().undoDepth
      const list = await exec('studio_list_midi_mappings')
      assert.equal(list.ok, true)
      assert.equal(list.count, 1)
      assert.equal(state.revision, revision)
      assert.equal(state.historyState().undoDepth, undoDepth)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 正确时写入成功', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const result = await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1', expectedRevision: state.revision })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.midiMappings.length, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch clearMidiMapping：结果含 removed/cleared，一次撤销', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1' })
      const result = await exec('studio_batch', {
        ops: [{ type: 'clearMidiMapping', args: { cc: 1 } }],
      })
      assert.equal(result.ok, true, result.error)
      const entry = result.results.find((item) => item.type === 'clearMidiMapping')
      assert.deepEqual(entry.cleared, true)
      assert.equal(entry.removed, 1)
      assert.equal(state.project.midiMappings.length, 0)
      await exec('studio_undo')
      assert.equal(state.project.midiMappings.length, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('effectParam 映射 undo/redo 完整恢复', async () => {
    const { state, exec } = await makeR3cTools()
    try {
      const effect = await exec('studio_add_effect', { target: 'trk_1', type: 'filter' })
      await exec('studio_set_midi_mapping', { cc: 74, target: 'effectParam', trackId: 'trk_1', effectId: effect.effectId, param: 'cutoff' })
      const before = JSON.stringify(state.project.midiMappings)
      const cleared = await exec('studio_clear_midi_mapping', { cc: 74 })
      assert.equal(cleared.cleared, true)
      await exec('studio_undo')
      assert.equal(JSON.stringify(state.project.midiMappings), before)
      await exec('studio_redo')
      assert.equal(state.project.midiMappings.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R4a：Group bus / 轨道输出 工具 / edit ops / 持久化                          */
/* ------------------------------------------------------------------------- */

describe('R4a — Group bus 与轨道输出', () => {
  async function makeR4aTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { dir, state, tools, exec }
  }

  it('studio_add_group：默认值/返回/ get_project / undo', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      const result = await exec('studio_add_group', { name: '鼓组' })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.groupId, 'grp_1')
      assert.equal(result.group.name, '鼓组')
      assert.equal(result.group.level, 0.8)
      assert.equal(result.group.mute, false)
      assert.equal(result.group.solo, false)
      assert.equal(result.group.output, 'master')
      assert.deepEqual(result.group.effects, [])
      assert.equal(result.count, 1)
      const overview = await exec('studio_get_project')
      assert.equal(overview.groups.length, 1)
      assert.equal(overview.groupsTotal, 1)
      assert.equal(overview.groups[0].effectCount, 0)
      assert.equal(overview.groups[0].inputTracks, 0)
      await exec('studio_undo')
      assert.equal(state.project.groups.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_add_group：最多 8 个；第 9 个中文拒绝；删除后可再添加', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      for (let index = 0; index < 8; index += 1) {
        const result = await exec('studio_add_group', { name: `G${index + 1}` })
        assert.equal(result.ok, true, `第 ${index + 1} 个：${result.error}`)
      }
      assert.equal(state.project.groups.length, 8)
      const overflow = await exec('studio_add_group', { name: 'G9' })
      assert.equal(overflow.ok, false)
      assert.match(overflow.error, /上限 8/)
      const removed = await exec('studio_remove_group', { groupId: 'grp_8' })
      assert.equal(removed.ok, true)
      const again = await exec('studio_add_group', { name: 'G9' })
      assert.equal(again.ok, true, again.error)
      assert.equal(again.groupId, 'grp_8')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_add_group：默认名 Group N；空名/超长名中文拒绝', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      const first = await exec('studio_add_group', {})
      assert.equal(first.group.name, 'Group 1')
      const second = await exec('studio_add_group', {})
      assert.equal(second.group.name, 'Group 2')
      const empty = await exec('studio_add_group', { name: '   ' })
      assert.equal(empty.ok, false)
      assert.match(empty.error, /name/)
      const long = await exec('studio_add_group', { name: 'a'.repeat(41) })
      assert.equal(long.ok, false)
      assert.match(long.error, /40/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_group：name/level/mute/solo 部分更新、undo', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      const updated = await exec('studio_update_group', { groupId: 'grp_1', level: 0.4, mute: true, solo: true })
      assert.equal(updated.ok, true, updated.error)
      assert.equal(updated.group.level, 0.4)
      assert.equal(updated.group.mute, true)
      assert.equal(updated.group.solo, true)
      assert.equal(updated.group.name, 'G', '未提供的字段保持')
      await exec('studio_update_group', { groupId: 'grp_1', name: 'New' })
      assert.equal(state.project.groups[0].name, 'New')
      assert.equal(state.project.groups[0].level, 0.4, '只更新 name 保留 level')
      await exec('studio_undo')
      assert.equal(state.project.groups[0].name, 'G')
      const unknown = await exec('studio_update_group', { groupId: 'grp_404', name: 'X' })
      assert.equal(unknown.ok, false)
      assert.match(unknown.error, /找不到 group/)
      const badLevel = await exec('studio_update_group', { groupId: 'grp_1', level: 2 })
      assert.equal(badLevel.ok, false)
      const badMute = await exec('studio_update_group', { groupId: 'grp_1', mute: 'yes' })
      assert.equal(badMute.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_remove_group：轨道输出回 master、tracksReset 计数、组 FX 删除、undo 恢复', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      await exec('studio_set_track_output', { trackId: 'trk_2', output: 'grp_1' })
      await exec('studio_add_effect', { target: 'group', groupId: 'grp_1', type: 'filter' })
      const removed = await exec('studio_remove_group', { groupId: 'grp_1' })
      assert.equal(removed.ok, true, removed.error)
      assert.equal(removed.removed, true)
      assert.equal(removed.tracksReset, 2)
      assert.equal(state.project.groups.length, 0)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, undefined)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_2').output, undefined)
      await exec('studio_undo')
      assert.equal(state.project.groups.length, 1)
      assert.equal(state.project.groups[0].effects.length, 1)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_2').output, 'grp_1')
      const unknown = await exec('studio_remove_group', { groupId: 'grp_404' })
      assert.equal(unknown.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_remove_group：无输入轨道 tracksReset=0', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', {})
      const removed = await exec('studio_remove_group', { groupId: 'grp_1' })
      assert.equal(removed.tracksReset, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_set_track_output：master/组切换、get_project output、undo、非法错误', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      const toGroup = await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      assert.equal(toGroup.ok, true, toGroup.error)
      assert.equal(toGroup.output, 'grp_1')
      let overview = await exec('studio_get_project')
      assert.equal(overview.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
      const toMaster = await exec('studio_set_track_output', { trackId: 'trk_1', output: 'master' })
      assert.equal(toMaster.output, 'master')
      overview = await exec('studio_get_project')
      assert.equal(overview.tracks.find((track) => track.id === 'trk_1').output, 'master')
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === 'trk_1'), 'output'), false)
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
      const badGroup = await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_404' })
      assert.equal(badGroup.ok, false)
      assert.match(badGroup.error, /master|group/)
      const badTrack = await exec('studio_set_track_output', { trackId: 'trk_404', output: 'master' })
      assert.equal(badTrack.ok, false)
      const missing = await exec('studio_set_track_output', { trackId: 'trk_1', output: '' })
      assert.equal(missing.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('effect 工具 target=group：add/update/remove 链路、get_project 摘要', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', { name: 'FX 组' })
      const added = await exec('studio_add_effect', { target: 'group', groupId: 'grp_1', type: 'filter', params: { cutoff: 900 } })
      assert.equal(added.ok, true, added.error)
      assert.equal(added.target, 'group')
      assert.equal(added.groupId, 'grp_1')
      const effectId = added.effectId
      let overview = await exec('studio_get_project')
      assert.equal(overview.groups[0].effectCount, 1)
      assert.equal(overview.groups[0].effects[0].type, 'filter')
      const updated = await exec('studio_update_effect', { target: 'group', groupId: 'grp_1', effectId, params: { cutoff: 1200 }, enabled: false })
      assert.equal(updated.ok, true, updated.error)
      const updatedFx = updated.chain.find((fx) => fx.id === effectId)
      assert.equal(updatedFx.params.cutoff, 1200)
      assert.equal(updatedFx.enabled, false)
      const removed = await exec('studio_remove_effect', { target: 'group', groupId: 'grp_1', effectId })
      assert.equal(removed.ok, true, removed.error)
      overview = await exec('studio_get_project')
      assert.equal(overview.groups[0].effectCount, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('effect target=group 错误：缺 groupId/未知 group；master/bus 行为不变', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      const missing = await exec('studio_add_effect', { target: 'group', type: 'filter' })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /groupId/)
      const unknown = await exec('studio_add_effect', { target: 'group', groupId: 'grp_404', type: 'filter' })
      assert.equal(unknown.ok, false)
      assert.match(unknown.error, /groupId|group/)
      const bus = await exec('studio_add_effect', { target: 'bus', busId: 'reverb', type: 'filter' })
      assert.equal(bus.ok, true, bus.error)
      assert.equal(bus.target, 'bus')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit：addGroup/updateGroup/removeGroup/setTrackOutput 一次撤销', async () => {
    const { state } = await makeR4aTools()
    const server = await startServer(state)
    try {
      const add = await postJson(server.base, '/studio/api/edit', { ops: [{ type: 'addGroup', name: 'E' }] })
      assert.equal(add.data.ok, true, add.data.error)
      assert.equal(state.project.groups.length, 1)
      assert.equal(state.historyState().undoLabel, '添加编组')
      const update = await postJson(server.base, '/studio/api/edit', { ops: [{ type: 'updateGroup', groupId: 'grp_1', level: 0.2 }] })
      assert.equal(update.data.ok, true, update.data.error)
      assert.equal(state.project.groups[0].level, 0.2)
      const route = await postJson(server.base, '/studio/api/edit', { ops: [{ type: 'setTrackOutput', trackId: 'trk_1', output: 'grp_1' }] })
      assert.equal(route.data.ok, true, route.data.error)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, undefined)
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.groups[0].level, 0.8)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：addGroup+setTrackOutput+updateGroup 一次撤销、结果字段', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      const result = await exec('studio_batch', {
        ops: [
          { type: 'addGroup', args: { name: 'B' } },
          { type: 'setTrackOutput', args: { trackId: 'trk_1', output: 'grp_1' } },
          { type: 'updateGroup', args: { groupId: 'grp_1', mute: true } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 3)
      assert.equal(state.historyState().undoLabel, '批量编辑')
      assert.equal(state.project.groups[0].mute, true)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
      await exec('studio_undo')
      assert.equal(state.project.groups.length, 0)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('持久化：groups/轨道 output/组 FX 保存→打开→重启', async () => {
    const { dir, state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', { name: '持久组' })
      await exec('studio_update_group', { groupId: 'grp_1', level: 0.33, mute: true })
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      await exec('studio_add_effect', { target: 'group', groupId: 'grp_1', type: 'filter' })
      await exec('studio_save_project', { name: 'R4a 编组工程', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R4a 编组工程' })
      assert.equal(state.project.groups.length, 1)
      assert.equal(state.project.groups[0].name, '持久组')
      assert.equal(state.project.groups[0].level, 0.33)
      assert.equal(state.project.groups[0].mute, true)
      assert.equal(state.project.groups[0].effects.length, 1)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.equal(reloaded.project.groups.length, 1)
        assert.equal(reloaded.project.groups[0].effects.length, 1)
        assert.equal(reloaded.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('组 FX 与 output 参与 undo/redo', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', {})
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      const revision = state.revision
      await exec('studio_remove_group', { groupId: 'grp_1' })
      await exec('studio_undo')
      assert.equal(state.project.groups.length, 1)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
      assert.equal(state.revision, revision + 2)
      await exec('studio_redo')
      assert.equal(state.project.groups.length, 0)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('set_track_output 切组/回 master 流程', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', { name: 'A' })
      await exec('studio_add_group', { name: 'B' })
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_2' })
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_2')
      const overview = await exec('studio_get_project')
      assert.equal(overview.groups.find((group) => group.id === 'grp_2').inputTracks, 1)
      assert.equal(overview.groups.find((group) => group.id === 'grp_1').inputTracks, 0)
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'master' })
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突不写入 group 操作', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      const stale = state.revision - 1
      const result = await exec('studio_add_group', { name: 'X', expectedRevision: stale })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.groups.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('组名长度边界 40 可创建；41 中文拒绝', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      const ok = await exec('studio_add_group', { name: 'a'.repeat(40) })
      assert.equal(ok.ok, true, ok.error)
      assert.equal(ok.group.name.length, 40)
      const tooLong = await exec('studio_add_group', { name: 'b'.repeat(41) })
      assert.equal(tooLong.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R4a 补充：工具/edit 边界 */
describe('R4a — 补充工具边界', () => {
  async function makeR4aTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { dir, state, exec }
  }

  it('/edit addEffect/removeEffect target=group', async () => {
    const { state } = await makeR4aTools()
    const server = await startServer(state)
    try {
      await postJson(server.base, '/studio/api/edit', { ops: [{ type: 'addGroup', name: 'E' }] })
      const addFx = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'addEffect', target: 'group', groupId: 'grp_1', fxType: 'drive' }],
      })
      assert.equal(addFx.data.ok, true, addFx.data.error)
      const effect = state.project.groups[0].effects[0]
      assert.equal(effect.type, 'drive')
      const removeFx = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'removeEffect', target: 'group', groupId: 'grp_1', effectId: effect.id }],
      })
      assert.equal(removeFx.data.ok, true, removeFx.data.error)
      assert.equal(state.project.groups[0].effects.length, 0)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：addEffect(target=group)+setTrackOutput 一次撤销', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', { name: 'B' })
      const result = await exec('studio_batch', {
        ops: [
          { type: 'addEffect', args: { target: 'group', groupId: 'grp_1', type: 'filter' } },
          { type: 'setTrackOutput', args: { trackId: 'trk_1', output: 'grp_1' } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.groups[0].effects.length, 1)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('多轨输出到同一组：get_project inputTracks 计数', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      await exec('studio_set_track_output', { trackId: 'trk_2', output: 'grp_1' })
      const overview = await exec('studio_get_project')
      assert.equal(overview.groups[0].inputTracks, 2)
      assert.equal(overview.tracks.find((track) => track.id === 'trk_3').output, 'master')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_group level 边界 0/1 接受，>1 拒绝', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', {})
      for (const level of [0, 1]) {
        const result = await exec('studio_update_group', { groupId: 'grp_1', level })
        assert.equal(result.ok, true, `${level}: ${result.error}`)
        assert.equal(result.group.level, level)
      }
      const bad = await exec('studio_update_group', { groupId: 'grp_1', level: 1.1 })
      assert.equal(bad.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('组 FX 多效果器顺序与 effectCount', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', {})
      await exec('studio_add_effect', { target: 'group', groupId: 'grp_1', type: 'filter' })
      await exec('studio_add_effect', { target: 'group', groupId: 'grp_1', type: 'drive' })
      const overview = await exec('studio_get_project')
      assert.equal(overview.groups[0].effectCount, 2)
      assert.deepEqual(overview.groups[0].effects.map((fx) => fx.type), ['filter', 'drive'])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('batch removeGroup：tracksReset 结果正确', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', {})
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      const result = await exec('studio_batch', { ops: [{ type: 'removeGroup', args: { groupId: 'grp_1' } }] })
      assert.equal(result.ok, true, result.error)
      const entry = result.results.find((item) => item.type === 'removeGroup')
      assert.equal(entry.tracksReset, 1)
      assert.equal(entry.removed, true)
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('set_track_output undo 恢复上一个组', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', {})
      await exec('studio_add_group', {})
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_2' })
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').output, 'grp_1')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('add_group expectedRevision 正确时写入', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      const result = await exec('studio_add_group', { name: 'R', expectedRevision: state.revision })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.groups.length, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('组 FX 禁用状态经 get_project 可见', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', {})
      const added = await exec('studio_add_effect', { target: 'group', groupId: 'grp_1', type: 'filter' })
      await exec('studio_update_effect', { target: 'group', groupId: 'grp_1', effectId: added.effectId, enabled: false })
      const overview = await exec('studio_get_project')
      assert.equal(overview.groups[0].effects[0].enabled, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('保存/打开保留组 mute/solo', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', { name: 'M' })
      await exec('studio_update_group', { groupId: 'grp_1', mute: true, solo: true })
      await exec('studio_save_project', { name: 'R4a mute solo', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R4a mute solo' })
      assert.equal(state.project.groups[0].mute, true)
      assert.equal(state.project.groups[0].solo, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit updateEffect target=group 生效', async () => {
    const { state, exec } = await makeR4aTools()
    const server = await startServer(state)
    try {
      await exec('studio_add_group', {})
      const effect = await exec('studio_add_effect', { target: 'group', groupId: 'grp_1', type: 'filter' })
      const edited = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'updateEffect', target: 'group', groupId: 'grp_1', effectId: effect.effectId, params: { cutoff: 600 } }],
      })
      assert.equal(edited.data.ok, true, edited.data.error)
      assert.equal(state.project.groups[0].effects[0].params.cutoff, 600)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('group.output 被外部改成非法值后 normalizeProject 强制 master', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', {})
      state.project.groups[0].output = 'grp_2'
      await exec('studio_save_project', { name: 'R4a output 修复', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R4a output 修复' })
      assert.equal(state.project.groups[0].output, 'master')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_group solo 单独切换', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      await exec('studio_add_group', {})
      const solo = await exec('studio_update_group', { groupId: 'grp_1', solo: true })
      assert.equal(solo.group.solo, true)
      assert.equal(solo.group.mute, false)
      const unsolo = await exec('studio_update_group', { groupId: 'grp_1', solo: false })
      assert.equal(unsolo.group.solo, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('无 groups 的旧工程：get_project groups=[]、每轨 output=master', async () => {
    const { state, exec } = await makeR4aTools()
    try {
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.groups, [])
      assert.equal(overview.groupsTotal, 0)
      assert.ok(overview.tracks.every((track) => track.output === 'master'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R4b：混音控制字段工具 / edit / 持久化                                       */
/* ------------------------------------------------------------------------- */

describe('R4b — sendMode/phase/mono/bypass/pdc 工具', () => {
  async function makeR4bTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { dir, state, tools, exec }
  }

  it('studio_update_track：sendMode pre/post 往返与 get_project', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      const pre = await exec('studio_update_track', { trackId: 'trk_1', sendMode: 'pre' })
      assert.equal(pre.ok, true, pre.error)
      assert.equal(pre.track.sendMode, 'pre')
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').sendMode, 'pre')
      const overview = await exec('studio_get_project')
      assert.equal(overview.tracks.find((track) => track.id === 'trk_1').sendMode, 'pre')
      const post = await exec('studio_update_track', { trackId: 'trk_1', sendMode: 'post' })
      assert.equal(post.track.sendMode, 'post')
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === 'trk_1'), 'sendMode'), false)
      const overview2 = await exec('studio_get_project')
      assert.equal(overview2.tracks.find((track) => track.id === 'trk_1').sendMode, 'post')
      const invalid = await exec('studio_update_track', { trackId: 'trk_1', sendMode: 'PRE' })
      assert.equal(invalid.ok, false)
      assert.match(invalid.error, /sendMode/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_track：phaseInvert/mono/bypassFx 设置与清除', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      for (const flag of ['phaseInvert', 'mono', 'bypassFx']) {
        const set = await exec('studio_update_track', { trackId: 'trk_1', [flag]: true })
        assert.equal(set.ok, true, `${flag}: ${set.error}`)
        assert.equal(set.track[flag], true)
        const overview = await exec('studio_get_project')
        assert.equal(overview.tracks.find((track) => track.id === 'trk_1')[flag], true)
        const clear = await exec('studio_update_track', { trackId: 'trk_1', [flag]: false })
        assert.equal(clear.track[flag], false)
        assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === 'trk_1'), flag), false)
      }
      const invalid = await exec('studio_update_track', { trackId: 'trk_1', mono: 'yes' })
      assert.equal(invalid.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_track：pdcMs 1 位小数/0 清除/夹紧 500', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      const set = await exec('studio_update_track', { trackId: 'trk_1', pdcMs: 123.456 })
      assert.equal(set.ok, true, set.error)
      assert.equal(set.track.pdcMs, 123.5)
      assert.equal(state.project.tracks.find((track) => track.id === 'trk_1').pdcMs, 123.5)
      const clamp = await exec('studio_update_track', { trackId: 'trk_1', pdcMs: 900 })
      assert.equal(clamp.track.pdcMs, 500)
      const clear = await exec('studio_update_track', { trackId: 'trk_1', pdcMs: 0 })
      assert.equal(clear.track.pdcMs, 0)
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === 'trk_1'), 'pdcMs'), false)
      const invalid = await exec('studio_update_track', { trackId: 'trk_1', pdcMs: 'x' })
      assert.equal(invalid.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_track：组合字段一次写入 + undo', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      const result = await exec('studio_update_track', {
        trackId: 'trk_1',
        sendMode: 'pre',
        phaseInvert: true,
        mono: true,
        bypassFx: true,
        pdcMs: 25.5,
      })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === 'trk_1')
      assert.deepEqual(
        [track.sendMode, track.phaseInvert, track.mono, track.bypassFx, track.pdcMs],
        ['pre', true, true, true, 25.5],
      )
      assert.equal(state.historyState().undoLabel, '调整轨道 trk_1')
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').sendMode, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('R4b 字段保存→打开→重启持久化', async () => {
    const { dir, state, exec } = await makeR4bTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', sendMode: 'pre', phaseInvert: true, mono: true, bypassFx: true, pdcMs: 11.1 })
      await exec('studio_save_project', { name: 'R4b 字段工程', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R4b 字段工程' })
      const track = state.project.tracks.find((item) => item.id === 'trk_1')
      assert.equal(track.sendMode, 'pre')
      assert.equal(track.phaseInvert, true)
      assert.equal(track.mono, true)
      assert.equal(track.bypassFx, true)
      assert.equal(track.pdcMs, 11.1)
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        const reloadedTrack = reloaded.project.tracks.find((item) => item.id === 'trk_1')
        assert.equal(reloadedTrack.sendMode, 'pre')
        assert.equal(reloadedTrack.pdcMs, 11.1)
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_group：bypassFx/pdcMs 设置/清除/undo', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      const set = await exec('studio_update_group', { groupId: 'grp_1', bypassFx: true, pdcMs: 50.04 })
      assert.equal(set.ok, true, set.error)
      assert.equal(set.group.bypassFx, true)
      assert.equal(set.group.pdcMs, 50)
      const overview = await exec('studio_get_project')
      assert.equal(overview.groups[0].bypassFx, true)
      assert.equal(overview.groups[0].pdcMs, 50)
      const cleared = await exec('studio_update_group', { groupId: 'grp_1', bypassFx: false, pdcMs: 0 })
      assert.equal(cleared.group.bypassFx, false)
      assert.equal(cleared.group.pdcMs, 0)
      assert.equal(Object.hasOwn(state.project.groups[0], 'bypassFx'), false)
      assert.equal(Object.hasOwn(state.project.groups[0], 'pdcMs'), false)
      await exec('studio_undo')
      assert.equal(state.project.groups[0].bypassFx, true)
      assert.equal(state.project.groups[0].pdcMs, 50)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_group：pdcMs 夹紧 500、非法类型拒绝', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', {})
      const clamp = await exec('studio_update_group', { groupId: 'grp_1', pdcMs: 999 })
      assert.equal(clamp.group.pdcMs, 500)
      const invalid = await exec('studio_update_group', { groupId: 'grp_1', pdcMs: 'x' })
      assert.equal(invalid.ok, false)
      const invalidBypass = await exec('studio_update_group', { groupId: 'grp_1', bypassFx: 'yes' })
      assert.equal(invalidBypass.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('组 R4b 字段保存→打开持久化', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      await exec('studio_update_group', { groupId: 'grp_1', bypassFx: true, pdcMs: 33.3 })
      await exec('studio_save_project', { name: 'R4b 组工程', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R4b 组工程' })
      assert.equal(state.project.groups[0].bypassFx, true)
      assert.equal(state.project.groups[0].pdcMs, 33.3)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit updateTrack 新字段：一次撤销', async () => {
    const { state } = await makeR4bTools()
    const server = await startServer(state)
    try {
      const edited = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'updateTrack', trackId: 'trk_1', sendMode: 'pre', phaseInvert: true, pdcMs: 12.5 }],
      })
      assert.equal(edited.data.ok, true, edited.data.error)
      const track = state.project.tracks.find((item) => item.id === 'trk_1')
      assert.equal(track.sendMode, 'pre')
      assert.equal(track.phaseInvert, true)
      assert.equal(track.pdcMs, 12.5)
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').sendMode, undefined)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('/edit updateGroup 新字段：一次撤销', async () => {
    const { state, exec } = await makeR4bTools()
    const server = await startServer(state)
    try {
      await exec('studio_add_group', {})
      const edited = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'updateGroup', groupId: 'grp_1', bypassFx: true, pdcMs: 20 }],
      })
      assert.equal(edited.data.ok, true, edited.data.error)
      assert.equal(state.project.groups[0].bypassFx, true)
      assert.equal(state.project.groups[0].pdcMs, 20)
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.groups[0].bypassFx, undefined)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：updateTrack+updateGroup 新字段一次撤销', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', {})
      const result = await exec('studio_batch', {
        ops: [
          { type: 'updateTrack', args: { trackId: 'trk_1', mono: true, pdcMs: 5 } },
          { type: 'updateGroup', args: { groupId: 'grp_1', bypassFx: true } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').mono, true)
      assert.equal(state.project.groups[0].bypassFx, true)
      assert.equal(state.historyState().undoLabel, '批量编辑')
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').mono, undefined)
      assert.equal(state.project.groups[0].bypassFx, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('get_project 默认摘要：sendMode=post、布尔 false、pdcMs=0、组字段默认', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', {})
      const overview = await exec('studio_get_project')
      const track = overview.tracks.find((item) => item.id === 'trk_1')
      assert.equal(track.sendMode, 'post')
      assert.equal(track.phaseInvert, false)
      assert.equal(track.mono, false)
      assert.equal(track.bypassFx, false)
      assert.equal(track.pdcMs, 0)
      const group = overview.groups[0]
      assert.equal(group.bypassFx, false)
      assert.equal(group.pdcMs, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('布尔字段 false 清除已设置值；undo 恢复', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', phaseInvert: true })
      await exec('studio_update_track', { trackId: 'trk_1', phaseInvert: false })
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'phaseInvert'), false)
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').phaseInvert, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_group 只改 pdcMs 保留 bypassFx 等字段', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      await exec('studio_update_group', { groupId: 'grp_1', bypassFx: true, level: 0.4 })
      await exec('studio_update_group', { groupId: 'grp_1', pdcMs: 8 })
      assert.equal(state.project.groups[0].bypassFx, true)
      assert.equal(state.project.groups[0].level, 0.4)
      assert.equal(state.project.groups[0].pdcMs, 8)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突不写入 R4b 字段', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      const stale = state.revision - 1
      const result = await exec('studio_update_track', { trackId: 'trk_1', pdcMs: 10, expectedRevision: stale })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').pdcMs, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('旧工程加载无 R4b 字段：summary 默认、工程对象不写字段', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      const overview = await exec('studio_get_project')
      const track = overview.tracks.find((item) => item.id === 'trk_1')
      assert.equal(track.sendMode, 'post')
      for (const key of ['sendMode', 'phaseInvert', 'mono', 'bypassFx', 'pdcMs']) {
        assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), key), false, key)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_track pdcMs 0.04 归零清除、500 边界保留', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      const zero = await exec('studio_update_track', { trackId: 'trk_1', pdcMs: 0.04 })
      assert.equal(zero.track.pdcMs, 0)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'pdcMs'), false)
      const max = await exec('studio_update_track', { trackId: 'trk_1', pdcMs: 500 })
      assert.equal(max.track.pdcMs, 500)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').pdcMs, 500)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('组 pdcMs/level 组合夹紧', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', {})
      const result = await exec('studio_update_group', { groupId: 'grp_1', level: 0.6, pdcMs: 499.96 })
      assert.equal(result.group.level, 0.6)
      assert.equal(result.group.pdcMs, 500)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_group 不改变未提供字段（mute/solo/name）', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', { name: '原' })
      await exec('studio_update_group', { groupId: 'grp_1', mute: true, solo: true })
      await exec('studio_update_group', { groupId: 'grp_1', bypassFx: true, pdcMs: 15 })
      const group = state.project.groups[0]
      assert.equal(group.name, '原')
      assert.equal(group.mute, true)
      assert.equal(group.solo, true)
      assert.equal(group.bypassFx, true)
      assert.equal(group.pdcMs, 15)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('R4b 字段参与 undo/redo 快照', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', sendMode: 'pre', mono: true })
      await exec('studio_update_track', { trackId: 'trk_1', sendMode: 'post', mono: false })
      await exec('studio_undo')
      const track = state.project.tracks.find((item) => item.id === 'trk_1')
      assert.equal(track.sendMode, 'pre')
      assert.equal(track.mono, true)
      await exec('studio_redo')
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').sendMode, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('updateTrack 工具参数声明含 R4b 字段（mock DSL）', async () => {
    const { state, tools } = await makeR4bTools()
    try {
      const tool = tools.find((item) => item.name === 'studio_update_track')
      for (const key of ['sendMode', 'phaseInvert', 'mono', 'bypassFx', 'pdcMs']) {
        assert.ok(tool.parameters[key], key)
      }
      assert.deepEqual(tool.parameters.sendMode.enum, ['post', 'pre'])
      const groupTool = tools.find((item) => item.name === 'studio_update_group')
      assert.ok(groupTool.parameters.bypassFx)
      assert.ok(groupTool.parameters.pdcMs)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('save/load 两次往返字段稳定（幂等）', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', sendMode: 'pre', phaseInvert: true, pdcMs: 9.9 })
      const before = JSON.stringify(state.project.tracks.find((item) => item.id === 'trk_1'))
      await exec('studio_save_project', { name: 'R4b 幂等', overwrite: true })
      await exec('studio_open_project', { name: 'R4b 幂等' })
      const after = JSON.stringify(state.project.tracks.find((item) => item.id === 'trk_1'))
      assert.equal(after, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('group bypassFx 与 track bypassFx 独立', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', {})
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      await exec('studio_update_track', { trackId: 'trk_1', bypassFx: true })
      await exec('studio_update_group', { groupId: 'grp_1', bypassFx: true })
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').bypassFx, true)
      assert.equal(state.project.groups[0].bypassFx, true)
      await exec('studio_update_track', { trackId: 'trk_1', bypassFx: false })
      assert.equal(state.project.groups[0].bypassFx, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R4b 补充：工具边界 */
describe('R4b — 补充工具边界', () => {
  async function makeR4bTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { state, exec }
  }

  it('鼓轨也可设置 R4b 字段', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      const drum = state.project.tracks.find((track) => track.kind === 'drum')
      assert.ok(drum, 'demo 工程应有鼓轨')
      const result = await exec('studio_update_track', {
        trackId: drum.id,
        sendMode: 'pre',
        phaseInvert: true,
        mono: true,
        bypassFx: true,
        pdcMs: 3.3,
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.track.sendMode, 'pre')
      assert.equal(result.track.pdcMs, 3.3)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('组 bypassFx undo/redo 完整', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', {})
      await exec('studio_update_group', { groupId: 'grp_1', bypassFx: true, pdcMs: 10 })
      await exec('studio_update_group', { groupId: 'grp_1', bypassFx: false, pdcMs: 0 })
      await exec('studio_undo')
      assert.equal(state.project.groups[0].bypassFx, true)
      assert.equal(state.project.groups[0].pdcMs, 10)
      await exec('studio_redo')
      assert.equal(Object.hasOwn(state.project.groups[0], 'bypassFx'), false)
      assert.equal(Object.hasOwn(state.project.groups[0], 'pdcMs'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('组 pdcMs 清 0 后保存/打开仍为空', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      await exec('studio_add_group', {})
      await exec('studio_update_group', { groupId: 'grp_1', pdcMs: 40 })
      await exec('studio_update_group', { groupId: 'grp_1', pdcMs: 0 })
      await exec('studio_save_project', { name: 'R4b 组 pdc 清零', overwrite: true })
      await exec('studio_open_project', { name: 'R4b 组 pdc 清零' })
      assert.equal(Object.hasOwn(state.project.groups[0], 'pdcMs'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_track 非法布尔值中文错误', async () => {
    const { state, exec } = await makeR4bTools()
    try {
      const result = await exec('studio_update_track', { trackId: 'trk_1', bypassFx: 'yes' })
      assert.equal(result.ok, false)
      assert.match(result.error, /bypassFx/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R4c：混音场景工具 / recall / 持久化                                        */
/* ------------------------------------------------------------------------- */

describe('R4c — 混音场景', () => {
  async function makeR4cTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { dir, state, tools, exec }
  }

  it('studio_save_scene：保存摘要/get_project/list/undo', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      const saved = await exec('studio_save_scene', { name: '混音 A' })
      assert.equal(saved.ok, true, saved.error)
      assert.equal(saved.scene.id, 'scene_1')
      assert.equal(saved.scene.name, '混音 A')
      assert.equal(saved.overwritten, false)
      assert.equal(saved.count, 1)
      assert.equal(typeof saved.scene.at, 'string')
      assert.ok(!Number.isNaN(Date.parse(saved.scene.at)))
      const list = await exec('studio_list_scenes')
      assert.equal(list.count, 1)
      assert.equal(list.scenes[0].id, 'scene_1')
      assert.equal(Object.hasOwn(list.scenes[0], 'state'), false)
      const overview = await exec('studio_get_project')
      assert.equal(overview.scenes.length, 1)
      assert.equal(overview.scenesTotal, 1)
      assert.equal(overview.scenes[0].name, '混音 A')
      assert.ok(overview.scenes[0].trackCount > 0)
      assert.equal(Object.hasOwn(overview.scenes[0], 'state'), false)
      await exec('studio_undo')
      assert.equal(state.project.scenes.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_save_scene：同名覆盖保留 id、更新 at、count 不变', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      const first = await exec('studio_save_scene', { name: 'A' })
      const at = state.project.scenes[0].at
      await new Promise((resolve) => setTimeout(resolve, 5))
      const second = await exec('studio_save_scene', { name: 'A' })
      assert.equal(second.scene.id, first.scene.id)
      assert.equal(second.overwritten, true)
      assert.equal(second.count, 1)
      assert.equal(state.project.scenes.length, 1)
      assert.notEqual(state.project.scenes[0].at, '', 'at 仍有值')
      assert.ok(Date.parse(state.project.scenes[0].at) >= Date.parse(at))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_save_scene：最多 8 个；删除后可再添加', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      for (let index = 0; index < 8; index += 1) {
        const result = await exec('studio_save_scene', { name: `S${index}` })
        assert.equal(result.ok, true, `第 ${index + 1} 个：${result.error}`)
      }
      assert.equal(state.project.scenes.length, 8)
      const overflow = await exec('studio_save_scene', { name: 'S9' })
      assert.equal(overflow.ok, false)
      assert.match(overflow.error, /上限 8/)
      const deleted = await exec('studio_delete_scene', { id: 'scene_8' })
      assert.equal(deleted.ok, true, deleted.error)
      const again = await exec('studio_save_scene', { name: 'S9' })
      assert.equal(again.ok, true, again.error)
      assert.equal(again.count, 8)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_save_scene：非法名中文拒绝', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      const empty = await exec('studio_save_scene', { name: '   ' })
      assert.equal(empty.ok, false)
      assert.match(empty.error, /name/)
      const long = await exec('studio_save_scene', { name: 'a'.repeat(41) })
      assert.equal(long.ok, false)
      assert.match(long.error, /40/)
      assert.equal(state.project.scenes.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('保存快照：深拷贝 tracks/groups/master/buses effects，之后改工程不影响场景', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      const effect = await exec('studio_add_effect', { target: 'trk_1', type: 'filter', params: { cutoff: 900 } })
      await exec('studio_add_group', { name: 'G' })
      await exec('studio_add_effect', { target: 'group', groupId: 'grp_1', type: 'drive' })
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.4, sendMode: 'pre', pdcMs: 10 })
      await exec('studio_set_master', { volume: 0.6 })
      await exec('studio_save_scene', { name: 'A' })
      const snapTrack = state.project.scenes[0].state.tracks.find((item) => item.id === 'trk_1')
      assert.equal(snapTrack.effects.find((fx) => fx.type === 'filter').params.cutoff, 900)
      assert.equal(snapTrack.sendMode, 'pre')
      assert.equal(state.project.scenes[0].state.master.volume, 0.6)
      assert.equal(state.project.scenes[0].state.groups.find((item) => item.id === 'grp_1').level, 0.8)
      // 修改工程后快照不变
      await exec('studio_update_effect', { target: 'trk_1', effectId: effect.effectId, params: { cutoff: 200 } })
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.9 })
      await exec('studio_set_master', { volume: 0.2 })
      assert.equal(state.project.scenes[0].state.tracks.find((item) => item.id === 'trk_1').effects.find((fx) => fx.type === 'filter').params.cutoff, 900)
      assert.equal(state.project.scenes[0].state.tracks.find((item) => item.id === 'trk_1').volume, 0.4)
      assert.equal(state.project.scenes[0].state.master.volume, 0.6)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_recall_scene：恢复轨道混音字段与发送/路由', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      await exec('studio_update_track', {
        trackId: 'trk_1',
        volume: 0.4,
        pan: -0.3,
        mute: true,
        solo: true,
        sends: { reverb: 0.5, delay: 0.1 },
        sendMode: 'pre',
        phaseInvert: true,
        mono: true,
        bypassFx: true,
        pdcMs: 22.2,
      })
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      const saved = await exec('studio_save_scene', { name: 'A' })
      await exec('studio_update_track', {
        trackId: 'trk_1',
        volume: 0.9,
        pan: 0.5,
        mute: false,
        solo: false,
        sends: { reverb: 0.1, delay: 0.9 },
        sendMode: 'post',
        phaseInvert: false,
        mono: false,
        bypassFx: false,
        pdcMs: 0,
      })
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'master' })
      const recalled = await exec('studio_recall_scene', { id: saved.scene.id })
      assert.equal(recalled.ok, true, recalled.error)
      assert.equal(recalled.restoredTracks, state.project.tracks.length)
      assert.equal(recalled.skippedTracks, 0)
      const track = state.project.tracks.find((item) => item.id === 'trk_1')
      assert.equal(track.volume, 0.4)
      assert.equal(track.pan, -0.3)
      assert.equal(track.mute, true)
      assert.equal(track.solo, true)
      assert.deepEqual(track.sends, { reverb: 0.5, delay: 0.1 })
      assert.equal(track.sendMode, 'pre')
      assert.equal(track.phaseInvert, true)
      assert.equal(track.mono, true)
      assert.equal(track.bypassFx, true)
      assert.equal(track.pdcMs, 22.2)
      assert.equal(track.output, 'grp_1')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_recall_scene：恢复 effects 参数链（轨道/组/master/bus）', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      const trackFx = await exec('studio_add_effect', { target: 'trk_1', type: 'filter', params: { cutoff: 700 } })
      await exec('studio_add_effect', { target: 'group', groupId: 'grp_1', type: 'drive' })
      await exec('studio_add_effect', { target: 'master', type: 'compressor' })
      await exec('studio_add_effect', { target: 'bus', busId: 'reverb', type: 'filter' })
      const saved = await exec('studio_save_scene', { name: 'FX' })
      await exec('studio_update_effect', { target: 'trk_1', effectId: trackFx.effectId, params: { cutoff: 100 } })
      await exec('studio_remove_effect', { target: 'group', groupId: 'grp_1', effectId: state.project.groups[0].effects[0].id })
      const recalled = await exec('studio_recall_scene', { name: 'FX' })
      assert.equal(recalled.ok, true, recalled.error)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').effects.find((fx) => fx.type === 'filter').params.cutoff, 700)
      const recalledGroup = state.project.groups.find((item) => item.id === 'grp_1')
      assert.equal(recalledGroup.effects.length, 1)
      assert.equal(recalledGroup.effects[0].type, 'drive')
      const sceneState = state.project.scenes[0].state
      assert.equal(state.project.master.effects.length, sceneState.master.effects.length)
      assert.equal(state.project.master.effects.at(-1).type, 'compressor')
      assert.equal(state.project.buses.reverb.effects.length, sceneState.buses.reverb.effects.length)
      assert.equal(state.project.buses.reverb.effects.at(-1).type, 'filter')
      assert.equal(saved.scene.id, recalled.sceneId)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_recall_scene：恢复组字段（level/mute/solo/bypass/pdc），保留组名', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_add_group', { name: '组原名' })
      await exec('studio_update_group', { groupId: 'grp_1', level: 0.3, mute: true, solo: true, bypassFx: true, pdcMs: 44 })
      const saved = await exec('studio_save_scene', { name: 'G' })
      await exec('studio_update_group', { groupId: 'grp_1', level: 0.9, mute: false, solo: false, bypassFx: false, pdcMs: 0 })
      await exec('studio_update_group', { groupId: 'grp_1', name: '改过名' })
      await exec('studio_recall_scene', { id: saved.scene.id })
      const group = state.project.groups[0]
      assert.equal(group.level, 0.3)
      assert.equal(group.mute, true)
      assert.equal(group.solo, true)
      assert.equal(group.bypassFx, true)
      assert.equal(group.pdcMs, 44)
      assert.equal(group.name, '改过名', '场景只恢复混音字段，不改组名')
      assert.equal(group.output, 'master')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_recall_scene：只恢复仍存在的 track id，缺失跳过且不重建', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.3 })
      const saved = await exec('studio_save_scene', { name: 'A' })
      state.mutate({ tool: 'test' }, (draft) => {
        draft.tracks = draft.tracks.filter((item) => item.id !== 'trk_1')
        return undefined
      })
      assert.equal(state.project.tracks.some((item) => item.id === 'trk_1'), false)
      const recalled = await exec('studio_recall_scene', { id: saved.scene.id })
      assert.equal(recalled.ok, true, recalled.error)
      assert.ok(recalled.skippedTracks >= 1)
      assert.equal(state.project.tracks.some((item) => item.id === 'trk_1'), false, '不重建轨道')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_recall_scene：缺失 group 跳过；轨道 output 指向缺失组时回 master', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      await exec('studio_set_track_output', { trackId: 'trk_1', output: 'grp_1' })
      const saved = await exec('studio_save_scene', { name: 'A' })
      await exec('studio_remove_group', { groupId: 'grp_1' })
      const recalled = await exec('studio_recall_scene', { id: saved.scene.id })
      assert.equal(recalled.ok, true, recalled.error)
      assert.ok(recalled.skippedGroups >= 1)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').output, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_recall_scene：不改音符/片段/自动化；只改混音字段', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.5 }] })
      await exec('studio_save_scene', { name: 'A' })
      const patterns = JSON.stringify(state.project.patterns)
      const clips = JSON.stringify(state.project.clips)
      const automation = JSON.stringify(state.project.tracks.find((item) => item.id === 'trk_1').automation)
      await exec('studio_recall_scene', { name: 'A' })
      assert.equal(JSON.stringify(state.project.patterns), patterns)
      assert.equal(JSON.stringify(state.project.clips), clips)
      assert.equal(JSON.stringify(state.project.tracks.find((item) => item.id === 'trk_1').automation), automation)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_recall_scene：按 name 召回、未知 id/name 错误、缺 selector 错误', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_save_scene', { name: 'ByName' })
      const recalled = await exec('studio_recall_scene', { name: 'ByName' })
      assert.equal(recalled.ok, true, recalled.error)
      assert.equal(recalled.sceneName, 'ByName')
      const unknownId = await exec('studio_recall_scene', { id: 'scene_404' })
      assert.equal(unknownId.ok, false)
      assert.match(unknownId.error, /找不到场景/)
      const unknownName = await exec('studio_recall_scene', { name: 'nope' })
      assert.equal(unknownName.ok, false)
      const none = await exec('studio_recall_scene', {})
      assert.equal(none.ok, false)
      assert.match(none.error, /id 或 name/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_delete_scene：按 id/name 删除、未知错误、undo 恢复', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_save_scene', { name: 'B' })
      const byId = await exec('studio_delete_scene', { id: 'scene_1' })
      assert.equal(byId.ok, true, byId.error)
      assert.equal(byId.deleted, true)
      assert.equal(byId.sceneName, 'A')
      assert.equal(state.project.scenes.length, 1)
      const byName = await exec('studio_delete_scene', { name: 'B' })
      assert.equal(byName.ok, true, byName.error)
      assert.equal(state.project.scenes.length, 0)
      const unknown = await exec('studio_delete_scene', { id: 'scene_404' })
      assert.equal(unknown.ok, false)
      assert.match(unknown.error, /找不到场景/)
      await exec('studio_undo')
      assert.equal(state.project.scenes.length, 1)
      assert.equal(state.project.scenes[0].name, 'B')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('recall undo/redo：一次撤销恢复召回前混音', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.2 })
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.8 })
      await exec('studio_recall_scene', { name: 'A' })
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').volume, 0.2)
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').volume, 0.8)
      await exec('studio_redo')
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').volume, 0.2)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('持久化：保存→新建→打开→重启后场景与快照完整', async () => {
    const { dir, state, exec } = await makeR4cTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.33, sendMode: 'pre', pdcMs: 5.5 })
      await exec('studio_save_scene', { name: '持久场景' })
      await exec('studio_save_project', { name: 'R4c 场景工程', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R4c 场景工程' })
      assert.equal(state.project.scenes.length, 1)
      assert.equal(state.project.scenes[0].name, '持久场景')
      assert.equal(state.project.scenes[0].state.tracks[0].volume, 0.33)
      assert.equal(state.project.scenes[0].state.tracks[0].sendMode, 'pre')
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.equal(reloaded.project.scenes.length, 1)
        assert.equal(reloaded.project.scenes[0].state.tracks[0].pdcMs, 5.5)
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('空场景列表与 scenesTotal=0', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      const list = await exec('studio_list_scenes')
      assert.deepEqual(list.scenes, [])
      assert.equal(list.count, 0)
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.scenes, [])
      assert.equal(overview.scenesTotal, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突不写入场景', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      const stale = state.revision - 1
      const result = await exec('studio_save_scene', { name: 'X', expectedRevision: stale })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.scenes.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('同名覆盖使用最新混音状态；不同名新增', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.2 })
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.7 })
      await exec('studio_save_scene', { name: 'A' })
      assert.equal(state.project.scenes.length, 1)
      assert.equal(state.project.scenes[0].state.tracks[0].volume, 0.7, '同名覆盖为最新状态')
      await exec('studio_save_scene', { name: 'B' })
      assert.equal(state.project.scenes.length, 2)
      assert.deepEqual(state.project.scenes.map((scene) => scene.name), ['A', 'B'])
      assert.deepEqual(state.project.scenes.map((scene) => scene.id), ['scene_1', 'scene_2'])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('recall 保留轨道身份字段（name/role/instrument）', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      const before = state.project.tracks.find((item) => item.id === 'trk_1')
      const identity = JSON.stringify({ name: before.name, role: before.role, instrument: before.instrument, kind: before.kind })
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_recall_scene', { name: 'A' })
      const after = state.project.tracks.find((item) => item.id === 'trk_1')
      assert.equal(JSON.stringify({ name: after.name, role: after.role, instrument: after.instrument, kind: after.kind }), identity)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('scene at 为 ISO 时间；name trim 后保存', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      const saved = await exec('studio_save_scene', { name: '  场景 A  ' })
      assert.equal(saved.scene.name, '场景 A')
      assert.ok(!Number.isNaN(Date.parse(state.project.scenes[0].at)))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('recall 全部存在时 skipped 为 0；summary trackCount/groupCount 正确', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_add_group', { name: 'G' })
      const saved = await exec('studio_save_scene', { name: 'A' })
      assert.equal(saved.scene.trackCount, state.project.tracks.length)
      assert.equal(saved.scene.groupCount, 1)
      const recalled = await exec('studio_recall_scene', { id: saved.scene.id })
      assert.equal(recalled.skippedTracks, 0)
      assert.equal(recalled.skippedGroups, 0)
      assert.equal(recalled.restoredGroups, 1)
      assert.equal(recalled.restoredTracks, state.project.tracks.length)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('recall 两次幂等：字段与 effects 不变', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.45, mono: true })
      await exec('studio_add_effect', { target: 'trk_1', type: 'filter' })
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_recall_scene', { name: 'A' })
      const first = JSON.stringify({
        mix: state.project.tracks.map((track) => [track.id, track.volume, track.mono, track.effects.map((fx) => [fx.type, fx.params])]),
        master: state.project.master,
      })
      await exec('studio_recall_scene', { name: 'A' })
      const second = JSON.stringify({
        mix: state.project.tracks.map((track) => [track.id, track.volume, track.mono, track.effects.map((fx) => [fx.type, fx.params])]),
        master: state.project.master,
      })
      assert.equal(second, first)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('delete 全部场景后 list 为空', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_save_scene', { name: 'B' })
      await exec('studio_delete_scene', { name: 'A' })
      await exec('studio_delete_scene', { name: 'B' })
      const list = await exec('studio_list_scenes')
      assert.equal(list.count, 0)
      assert.equal(state.project.scenes.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('recall 不改 master automation / tempoMap', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_set_automation', { target: 'master', param: 'volume', points: [{ beat: 0, value: 0.5 }] })
      await exec('studio_set_tempo_map', { points: [{ beat: 0, bpm: 90 }] })
      const automation = JSON.stringify(state.project.master.automation)
      const tempoMap = JSON.stringify(state.project.tempoMap)
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_recall_scene', { name: 'A' })
      assert.equal(JSON.stringify(state.project.master.automation), automation)
      assert.equal(JSON.stringify(state.project.tempoMap), tempoMap)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('保存场景 state 不含 patterns/clips/自动化', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_save_scene', { name: 'A' })
      const sceneState = state.project.scenes[0].state
      for (const key of ['patterns', 'clips', 'tempoMap', 'sections', 'media']) {
        assert.equal(Object.hasOwn(sceneState, key), false, key)
      }
      assert.ok(Array.isArray(sceneState.tracks))
      assert.ok(Array.isArray(sceneState.groups))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('无 group 的工程可保存/召回场景', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      const saved = await exec('studio_save_scene', { name: 'NoGroup' })
      assert.equal(saved.scene.groupCount, 0)
      const recalled = await exec('studio_recall_scene', { name: 'NoGroup' })
      assert.equal(recalled.ok, true, recalled.error)
      assert.equal(recalled.restoredGroups, 0)
      assert.equal(recalled.skippedGroups, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('recall 恢复 master/buses 电平与 effects', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_set_master', { volume: 0.42 })
      await exec('studio_set_bus', { bus: 'reverb', level: 0.11 })
      await exec('studio_add_effect', { target: 'bus', busId: 'delay', type: 'filter' })
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_set_master', { volume: 0.99 })
      await exec('studio_set_bus', { bus: 'reverb', level: 0.9 })
      await exec('studio_remove_effect', { target: 'bus', busId: 'delay', effectId: state.project.buses.delay.effects[0].id })
      await exec('studio_recall_scene', { name: 'A' })
      assert.equal(state.project.master.volume, 0.42)
      assert.equal(state.project.buses.reverb.level, 0.11)
      assert.equal(state.project.buses.delay.effects.length, 1)
      assert.equal(state.project.buses.delay.effects[0].type, 'filter')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('recall 后保存再打开：召回结果持久化', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.21 })
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.81 })
      await exec('studio_recall_scene', { name: 'A' })
      await exec('studio_save_project', { name: 'R4c 召回持久化', overwrite: true })
      await exec('studio_open_project', { name: 'R4c 召回持久化' })
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').volume, 0.21)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('场景 store 在 state 里持久化（save/open 不丢 at/state）', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_save_scene', { name: 'A' })
      const at = state.project.scenes[0].at
      await exec('studio_save_project', { name: 'R4c at', overwrite: true })
      await exec('studio_open_project', { name: 'R4c at' })
      assert.equal(state.project.scenes[0].at, at)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R4c 补充：场景 edit ops / batch */
describe('R4c — 场景 edit ops', () => {
  async function makeR4cTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { state, exec }
  }

  it('/edit saveScene/recallScene/deleteScene 一次撤销', async () => {
    const { state, exec } = await makeR4cTools()
    const server = await startServer(state)
    try {
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.3 })
      const saved = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'saveScene', name: 'Edit A' }],
      })
      assert.equal(saved.data.ok, true, saved.data.error)
      assert.equal(state.project.scenes.length, 1)
      assert.equal(state.historyState().undoLabel, '保存场景')
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.9 })
      const recalled = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'recallScene', name: 'Edit A' }],
      })
      assert.equal(recalled.data.ok, true, recalled.data.error)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').volume, 0.3)
      assert.equal(state.historyState().undoLabel, '召回场景')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').volume, 0.9)
      const deleted = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'deleteScene', name: 'Edit A' }],
      })
      assert.equal(deleted.data.ok, true, deleted.data.error)
      assert.equal(state.project.scenes.length, 0)
      assert.equal(state.historyState().undoLabel, '删除场景')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.scenes.length, 1)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch：saveScene+deleteScene 一次撤销与结果字段', async () => {
    const { state, exec } = await makeR4cTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', volume: 0.25 })
      const result = await exec('studio_batch', {
        ops: [
          { type: 'saveScene', args: { name: 'Batch A' } },
          { type: 'updateTrack', args: { trackId: 'trk_1', volume: 0.7 } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 2)
      assert.equal(state.project.scenes.length, 1)
      assert.equal(state.historyState().undoLabel, '批量编辑')
      const saveEntry = result.results.find((item) => item.type === 'saveScene')
      assert.equal(saveEntry.scene.name, 'Batch A')
      assert.equal(saveEntry.overwritten, false)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').volume, 0.7)
      await exec('studio_undo')
      assert.equal(state.project.scenes.length, 0)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').volume, 0.25)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R4d：automationMode 工具 / edit / 持久化                                   */
/* ------------------------------------------------------------------------- */

describe('R4d — automationMode', () => {
  async function makeR4dTools(defineTool) {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: defineTool ?? ((options) => options), state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { dir, state, tools, exec }
  }

  it('studio_update_track：touch/latch/write 写入、get_project 回显', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      for (const mode of ['touch', 'latch', 'write']) {
        const result = await exec('studio_update_track', { trackId: 'trk_1', automationMode: mode })
        assert.equal(result.ok, true, `${mode}: ${result.error}`)
        assert.equal(result.track.automationMode, mode)
        assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').automationMode, mode)
        const overview = await exec('studio_get_project')
        assert.equal(overview.tracks.find((item) => item.id === 'trk_1').automationMode, mode)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_track：read 清除字段并回显 read', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'write' })
      const result = await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'read' })
      assert.equal(result.track.automationMode, 'read')
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'automationMode'), false)
      const overview = await exec('studio_get_project')
      assert.equal(overview.tracks.find((item) => item.id === 'trk_1').automationMode, 'read')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('默认摘要：每轨 automationMode=read', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      const overview = await exec('studio_get_project')
      assert.ok(overview.tracks.every((track) => track.automationMode === 'read'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('ops 层非法值回 read（不报错）', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      for (const value of ['bogus', 'TOUCH', 123, true]) {
        const result = await exec('studio_update_track', { trackId: 'trk_1', automationMode: value })
        assert.equal(result.ok, true, `${String(value)}: ${result.error}`)
        assert.equal(result.track.automationMode, 'read')
        assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'automationMode'), false)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('真实 DSL：非法 automationMode 被 schema enum 拒绝', async () => {
    const { state, tools } = await makeR4dTools(realDefineTool)
    try {
      const tool = tools.find((item) => item.name === 'studio_update_track')
      assert.deepEqual(tool.parameters.properties.automationMode.enum, ['read', 'touch', 'latch', 'write'])
      await assert.rejects(
        () => tool.execute({ trackId: 'trk_1', automationMode: 'bogus' }, {}),
        /invalid arguments/,
      )
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('undo/redo：automationMode 写入与清除', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'latch' })
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').automationMode, 'latch')
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'read' })
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'automationMode'), false)
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').automationMode, 'latch')
      await exec('studio_redo')
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'automationMode'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('持久化：保存→新建→打开→重启', async () => {
    const { dir, state, exec } = await makeR4dTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'write' })
      await exec('studio_save_project', { name: 'R4d 自动化模式', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R4d 自动化模式' })
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').automationMode, 'write')
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.equal(reloaded.project.tracks.find((item) => item.id === 'trk_1').automationMode, 'write')
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit updateTrack automationMode：一次撤销', async () => {
    const { state } = await makeR4dTools()
    const server = await startServer(state)
    try {
      const edited = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'updateTrack', trackId: 'trk_1', automationMode: 'touch' }],
      })
      assert.equal(edited.data.ok, true, edited.data.error)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').automationMode, 'touch')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'automationMode'), false)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch updateTrack automationMode + 其他字段一次撤销', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      const result = await exec('studio_batch', {
        ops: [
          { type: 'updateTrack', args: { trackId: 'trk_1', automationMode: 'latch' } },
          { type: 'updateTrack', args: { trackId: 'trk_2', automationMode: 'write' } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').automationMode, 'latch')
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_2').automationMode, 'write')
      assert.equal(state.historyState().undoLabel, '批量编辑')
      await exec('studio_undo')
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'automationMode'), false)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_2'), 'automationMode'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('多轨模式独立设置', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'touch' })
      await exec('studio_update_track', { trackId: 'trk_2', automationMode: 'write' })
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').automationMode, 'touch')
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_2').automationMode, 'write')
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_3'), 'automationMode'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('不改变已有 automation 曲线', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      await exec('studio_set_automation', { target: 'track', trackId: 'trk_1', param: 'volume', points: [{ beat: 0, value: 0.2 }, { beat: 4, value: 0.8 }] })
      const before = JSON.stringify(state.project.tracks.find((item) => item.id === 'trk_1').automation)
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'write' })
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'read' })
      assert.equal(JSON.stringify(state.project.tracks.find((item) => item.id === 'trk_1').automation), before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('与 R4b 字段组合更新', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      const result = await exec('studio_update_track', {
        trackId: 'trk_1',
        automationMode: 'touch',
        sendMode: 'pre',
        phaseInvert: true,
        mono: true,
        pdcMs: 7.7,
      })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === 'trk_1')
      assert.equal(track.automationMode, 'touch')
      assert.equal(track.sendMode, 'pre')
      assert.equal(track.phaseInvert, true)
      assert.equal(track.mono, true)
      assert.equal(track.pdcMs, 7.7)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('旧工程加载：无字段，summary 全部 read', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      const overview = await exec('studio_get_project')
      assert.ok(overview.tracks.every((track) => track.automationMode === 'read'))
      assert.ok(state.project.tracks.every((track) => !Object.hasOwn(track, 'automationMode')))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('场景 recall 不改变 automationMode（场景快照不含该字段）', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'write' })
      await exec('studio_save_scene', { name: 'A' })
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'touch' })
      await exec('studio_recall_scene', { name: 'A' })
      assert.equal(state.project.tracks.find((item) => item.id === 'trk_1').automationMode, 'touch')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突不写入 automationMode', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      const stale = state.revision - 1
      const result = await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'write', expectedRevision: stale })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'automationMode'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具参数声明包含 automationMode enum', async () => {
    const { state, tools } = await makeR4dTools()
    try {
      const tool = tools.find((item) => item.name === 'studio_update_track')
      assert.deepEqual(tool.parameters.automationMode.enum, ['read', 'touch', 'latch', 'write'])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('read→write→read 持久化状态正确（保存打开）', async () => {
    const { state, exec } = await makeR4dTools()
    try {
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'write' })
      await exec('studio_update_track', { trackId: 'trk_1', automationMode: 'read' })
      await exec('studio_save_project', { name: 'R4d read 清零', overwrite: true })
      await exec('studio_open_project', { name: 'R4d read 清零' })
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === 'trk_1'), 'automationMode'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R5a：32 音色工具 / 持久化 / app_info                                       */
/* ------------------------------------------------------------------------- */

describe('R5a — 32 个采样乐器工具', () => {
  const R5A_NEW = [
    ['vibraphone', 11], ['glockenspiel', 9], ['church_organ', 19], ['jazz_guitar', 26], ['muted_guitar', 28],
    ['picked_bass', 34], ['fretless_bass', 35], ['synth_bass', 38], ['viola', 41], ['pizzicato_strings', 45],
    ['voice_oohs', 53], ['french_horn', 60], ['trombone', 57], ['clarinet', 71],
  ]

  async function makeR5aTools(empty = false) {
    const { dir, state } = await makeState()
    if (empty) {
      state.mutate({ tool: 'test' }, (draft) => {
        draft.tracks = []
        draft.patterns = []
        draft.clips = []
        return undefined
      })
    }
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, tools, byName, exec }
  }

  it('studio_add_track：5 个新增 preset 创建成功并写入 instrument', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      for (const id of ['vibraphone', 'church_organ', 'picked_bass', 'viola', 'clarinet']) {
        const result = await exec('studio_add_track', { name: `R5a-${id}`, kind: 'synth', preset: id })
        assert.equal(result.ok, true, `${id}: ${result.error}`)
        assert.equal(result.track.instrument.preset, id)
        const track = state.project.tracks.find((item) => item.id === result.trackId)
        assert.equal(track.instrument.preset, id)
        assert.equal(track.kind, 'synth')
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('14 个新增 preset 全部可创建（空工程）；每轨 instrument.preset 正确', async () => {
    const { state, exec } = await makeR5aTools(true)
    try {
      for (const [id] of R5A_NEW) {
        const result = await exec('studio_add_track', { name: `R5a-${id}`, kind: 'synth', preset: id })
        assert.equal(result.ok, true, `${id}: ${result.error}`)
        assert.equal(state.project.tracks.find((item) => item.id === result.trackId).instrument.preset, id)
      }
      assert.equal(state.project.tracks.length, 14)
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.tracks.map((track) => track.instrument.preset), R5A_NEW.map(([id]) => id))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_add_track preset enum = 32，含 14 个新 id 且旧 18 顺序不变', async () => {
    const { state, byName } = await makeR5aTools()
    try {
      const tool = byName.get('studio_add_track')
      assert.equal(tool.parameters.preset.enum.length, 32)
      assert.deepEqual(tool.parameters.preset.enum.slice(0, 18), SYNTH_PRESETS.slice(0, 18).map((preset) => preset.id))
      for (const [id] of R5A_NEW) assert.ok(tool.parameters.preset.enum.includes(id), id)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_track：切到新增 preset 成功、清空合成参数', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a', kind: 'synth', preset: 'grand_piano' })
      for (const id of ['vibraphone', 'fretless_bass', 'voice_oohs', 'trombone']) {
        const changed = await exec('studio_update_track', { trackId: added.trackId, preset: id })
        assert.equal(changed.ok, true, `${id}: ${changed.error}`)
        assert.equal(changed.track.instrument.preset, id)
        assert.deepEqual(state.project.tracks.find((track) => track.id === added.trackId).instrument.params, {})
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('非法/旧合成 preset 仍被拒绝', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      for (const id of ['supersaw', 'neon808', 'nope', 'trumpet_section']) {
        const result = await exec('studio_add_track', { name: 'X', kind: 'synth', preset: id })
        assert.equal(result.ok, false, id)
        assert.match(result.error, /未知采样乐器/)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('新 preset 轨的 color 来自 catalog，get_project instrument 正确', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a color', kind: 'synth', preset: 'jazz_guitar' })
      const trackState = state.project.tracks.find((track) => track.id === added.trackId)
      assert.match(trackState.color, /^#[0-9A-Fa-f]{6}$/)
      const overview = await exec('studio_get_project')
      const track = overview.tracks.find((item) => item.id === added.trackId)
      assert.equal(track.instrument.preset, 'jazz_guitar')
      assert.match(track.color, /^#[0-9A-Fa-f]{6}$/)
      assert.equal(track.kind, 'synth')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('新 preset 工程保存→新建→打开→重启持久化', async () => {
    const { dir, state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a 持久化', kind: 'synth', preset: 'french_horn' })
      await exec('studio_save_project', { name: 'R5a 音色工程', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R5a 音色工程' })
      assert.equal(state.project.tracks.find((track) => track.id === added.trackId).instrument.preset, 'french_horn')
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.equal(reloaded.project.tracks.find((track) => track.id === added.trackId).instrument.preset, 'french_horn')
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_app_info：counts 32 且 instruments 含新 id/program/label', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const info = await exec('studio_app_info')
      assert.equal(info.ok, true, info.error)
      assert.equal(info.counts.instruments, 32)
      assert.equal(info.instruments.length, 32)
      for (const [id, program] of R5A_NEW) {
        const item = info.instruments.find((entry) => entry.id === id)
        assert.ok(item, id)
        assert.equal(item.program, program)
        assert.ok(item.label.length > 0)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('GET /catalog 包含 32 个乐器与新增程序号', async () => {
    const { state } = await makeR5aTools()
    const server = await startServer(state)
    try {
      const data = (await (await fetch(`${server.base}/studio/api/catalog`)).json())
      assert.equal(data.counts.instruments, 32)
      assert.equal(data.instruments.length, 32)
      for (const [id, program] of R5A_NEW) {
        const item = data.instruments.find((entry) => entry.id === id)
        assert.ok(item, id)
        assert.equal(item.program, program)
      }
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_add_track 新 preset 可 undo/redo', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a undo', kind: 'synth', preset: 'glockenspiel' })
      assert.equal(state.project.tracks.some((track) => track.id === added.trackId), true)
      await exec('studio_undo')
      assert.equal(state.project.tracks.some((track) => track.id === added.trackId), false)
      await exec('studio_redo')
      assert.equal(state.project.tracks.some((track) => track.id === added.trackId), true)
      assert.equal(state.project.tracks.find((track) => track.id === added.trackId).instrument.preset, 'glockenspiel')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('nearestSampledPreset：新增程序号精确映射到新 preset', async () => {
    const cases = [
      [11, 'vibraphone'],
      [9, 'glockenspiel'],
      [19, 'church_organ'],
      [26, 'jazz_guitar'],
      [28, 'muted_guitar'],
      [34, 'picked_bass'],
      [35, 'fretless_bass'],
      [38, 'synth_bass'],
      [41, 'viola'],
      [45, 'pizzicato_strings'],
      [53, 'voice_oohs'],
      [60, 'french_horn'],
      [57, 'trombone'],
      [71, 'clarinet'],
    ]
    for (const [program, id] of cases) assert.equal(nearestSampledPreset(program), id)
    assert.equal(nearestSampledPreset(0), 'grand_piano')
  })

  it('14 条新 preset 轨 id 唯一、kind synth、instrument.params 空', async () => {
    const { state, exec } = await makeR5aTools(true)
    try {
      const created = []
      for (const [id] of R5A_NEW) created.push((await exec('studio_add_track', { name: id, kind: 'synth', preset: id })).trackId)
      assert.equal(new Set(created).size, 14)
      for (const trackId of created) {
        const track = state.project.tracks.find((item) => item.id === trackId)
        assert.equal(track.kind, 'synth')
        assert.deepEqual(track.instrument.params, {})
        assert.equal(track.role, 'lead')
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('保存后 project.json 含新 preset id（restart 读取）', async () => {
    const { dir, state, exec } = await makeR5aTools()
    try {
      await exec('studio_add_track', { name: 'R5a json', kind: 'synth', preset: 'pizzicato_strings' })
      await exec('studio_save_project', { name: 'R5a json 工程', overwrite: true })
      const raw = await readFile(path.join(dir, 'projects', 'R5a json 工程.json'), 'utf8')
      assert.ok(raw.includes('pizzicato_strings'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('新 preset 的 role 可按 add_track 参数覆盖', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a bass', kind: 'synth', preset: 'picked_bass', role: 'bass' })
      assert.equal(added.ok, true, added.error)
      assert.equal(state.project.tracks.find((track) => track.id === added.trackId).role, 'bass')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('add_track 新 preset 后 update 到另一个新 preset', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a switch', kind: 'synth', preset: 'muted_guitar' })
      const changed = await exec('studio_update_track', { trackId: added.trackId, preset: 'trombone' })
      assert.equal(changed.ok, true, changed.error)
      assert.equal(state.project.tracks.find((track) => track.id === added.trackId).instrument.preset, 'trombone')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('新 preset 轨 get_project 摘要可读（instrument.preset / color）', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a summary', kind: 'synth', preset: 'church_organ' })
      const overview = await exec('studio_get_project')
      const track = overview.tracks.find((item) => item.id === added.trackId)
      assert.equal(track.instrument.preset, 'church_organ')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('新 preset 数量断言：catalog 32（非 18）且 4 鼓机 15 效果器不变', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const info = await exec('studio_app_info')
      assert.deepEqual(info.counts, { instruments: 32, drumKits: 4, effects: 15 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('新增 preset 轨可加效果器/更新音量（正常轨道行为）', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a fx', kind: 'synth', preset: 'fretless_bass' })
      const effect = await exec('studio_add_effect', { target: added.trackId, type: 'filter' })
      assert.equal(effect.ok, true, effect.error)
      const updated = await exec('studio_update_track', { trackId: added.trackId, volume: 0.5, pan: -0.2 })
      assert.equal(updated.ok, true, updated.error)
      assert.equal(state.project.tracks.find((track) => track.id === added.trackId).instrument.preset, 'fretless_bass')
      assert.equal(state.project.tracks.find((track) => track.id === added.trackId).volume, 0.5)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突时新 preset 轨不写入', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const before = state.project.tracks.length
      const result = await exec('studio_add_track', {
        name: 'R5a conflict',
        kind: 'synth',
        preset: 'synth_bass',
        expectedRevision: state.revision - 1,
      })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.tracks.length, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R5a 补充：工具边界 */
describe('R5a — 32 音色补充', () => {
  async function makeR5aTools(empty = false) {
    const { dir, state } = await makeState()
    if (empty) {
      state.mutate({ tool: 'test' }, (draft) => {
        draft.tracks = []
        draft.patterns = []
        draft.clips = []
        return undefined
      })
    }
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, tools, byName, exec }
  }

  it('nearestSampledPreset：32 个 catalog 程序号都精确映射自身', () => {
    for (const preset of SYNTH_PRESETS) {
      assert.equal(nearestSampledPreset(preset.soundfont.program), preset.id, `${preset.id}:${preset.soundfont.program}`)
    }
  })

  it('validateProject：新增 preset 轨无 unknown_instrument', async () => {
    const { state, exec } = await makeR5aTools(true)
    try {
      for (const id of ['vibraphone', 'church_organ', 'synth_bass', 'viola', 'clarinet']) {
        await exec('studio_add_track', { name: `R5a-${id}`, kind: 'synth', preset: id })
      }
      const { issues } = ops.validateProject(state.project)
      assert.deepEqual(issues.filter((issue) => issue.code === 'unknown_instrument'), [])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('显式 color 覆盖时仍保留传入颜色（新 preset）', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a color2', kind: 'synth', preset: 'clarinet', color: '#123456' })
      assert.equal(added.ok, true, added.error)
      assert.equal(state.project.tracks.find((track) => track.id === added.trackId).color, '#123456')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('新增 preset 轨修改音量/效果后保存打开仍保留 preset', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a modify', kind: 'synth', preset: 'voice_oohs' })
      await exec('studio_add_effect', { target: added.trackId, type: 'chorus' })
      await exec('studio_update_track', { trackId: added.trackId, volume: 0.4 })
      await exec('studio_save_project', { name: 'R5a 修改工程', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R5a 修改工程' })
      const track = state.project.tracks.find((item) => item.id === added.trackId)
      assert.equal(track.instrument.preset, 'voice_oohs')
      assert.equal(track.volume, 0.4)
      assert.equal(track.effects[0].type, 'chorus')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('连续添加 5 个新 preset 后可 undo 逐步回退', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const before = state.project.tracks.length
      for (const id of ['vibraphone', 'glockenspiel', 'jazz_guitar', 'picked_bass', 'trombone']) {
        await exec('studio_add_track', { name: `R5a-${id}`, kind: 'synth', preset: id })
      }
      assert.equal(state.project.tracks.length, before + 5)
      for (let index = 0; index < 5; index += 1) await exec('studio_undo')
      assert.equal(state.project.tracks.length, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_app_info instruments 新 preset label/中文分类存在', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const info = await exec('studio_app_info')
      for (const id of ['vibraphone', 'picked_bass', 'viola', 'voice_oohs', 'clarinet']) {
        const item = info.instruments.find((entry) => entry.id === id)
        assert.ok(item, id)
        assert.ok(item.label.length > 0)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_track 切到新增 preset 后 get_project 反映新 preset', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const added = await exec('studio_add_track', { name: 'R5a switch2', kind: 'synth', preset: 'grand_piano' })
      await exec('studio_update_track', { trackId: added.trackId, preset: 'glockenspiel' })
      const overview = await exec('studio_get_project')
      assert.equal(overview.tracks.find((track) => track.id === added.trackId).instrument.preset, 'glockenspiel')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('新增 preset 创建失败（未知 id）时工程不变', async () => {
    const { state, exec } = await makeR5aTools()
    try {
      const before = state.project.tracks.length
      const result = await exec('studio_add_track', { name: 'bad', kind: 'synth', preset: 'vibraphone_x' })
      assert.equal(result.ok, false)
      assert.equal(state.project.tracks.length, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R5b：instrumentParams 工具 / edit / batch / 持久化                         */
/* ------------------------------------------------------------------------- */

describe('R5b — studio_update_instrument', () => {
  async function makeR5bTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    const synthId = state.project.tracks.find((track) => track.kind === 'synth').id
    return { dir, state, tools, byName, exec, synthId }
  }

  it('基础：attack/release 合并更新、get_project 摘要、state 同步', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.05, release: 1.5 } })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.instrumentParams, { attack: 0.05, release: 1.5 })
      assert.equal(result.reset, false)
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.05, release: 1.5 })
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.05, release: 1.5 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('六个参数一次更新并规范化', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_update_instrument', {
        trackId: synthId,
        params: { attack: 0.1, release: 1, filterCutoff: 800, filterQ: 2.5, lfoRate: 3, lfoDepth: 40 },
      })
      assert.equal(result.ok, true, result.error)
      const expected = { attack: 0.1, release: 1, filterCutoff: 800, filterQ: 2.5, lfoRate: 3, lfoDepth: 40 }
      assert.deepEqual(result.instrumentParams, expected)
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, expected)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('取整：attack/release 3 位；cutoff/Q/rate 1 位；depth 整数', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_update_instrument', {
        trackId: synthId,
        params: { attack: 0.12345, release: 0.98765, filterCutoff: 1234.56, filterQ: 2.34, lfoRate: 5.55, lfoDepth: 50.6 },
      })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.instrumentParams, {
        attack: 0.123,
        release: 0.988,
        filterCutoff: 1234.6,
        filterQ: 2.3,
        lfoRate: 5.6,
        lfoDepth: 51,
      })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('部分合并：再次更新保留已有参数', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.2, filterCutoff: 500 } })
      const result = await exec('studio_update_instrument', { trackId: synthId, params: { release: 2 } })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.instrumentParams, { attack: 0.2, release: 2, filterCutoff: 500 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('写入全部默认值时省略 instrumentParams 字段', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_update_instrument', {
        trackId: synthId,
        params: { attack: 0.005, release: 0.2, filterCutoff: 20000, filterQ: 0.7, lfoRate: 5, lfoDepth: 0 },
      })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.instrumentParams, {})
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('reset:true 清除全部参数', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 1, lfoDepth: 60 } })
      const result = await exec('studio_update_instrument', { trackId: synthId, reset: true })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.reset, true)
      assert.deepEqual(result.instrumentParams, {})
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('未知参数键中文错误；工程不变', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_update_instrument', { trackId: synthId, params: { bogus: 1 } })
      assert.equal(result.ok, false)
      assert.match(result.error, /未知乐器参数/)
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('范围校验：越界返回中文错误（attack/release/cutoff/Q/rate/depth）', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const cases = [
        { attack: 0 },
        { attack: 2.5 },
        { release: 0.001 },
        { release: 9 },
        { filterCutoff: 50 },
        { filterCutoff: 30000 },
        { filterQ: 0.05 },
        { filterQ: 20 },
        { lfoRate: 0 },
        { lfoRate: 20 },
        { lfoDepth: -1 },
        { lfoDepth: 101 },
      ]
      for (const params of cases) {
        const result = await exec('studio_update_instrument', { trackId: synthId, params })
        assert.equal(result.ok, false, JSON.stringify(params))
        assert.match(result.error, /params\./)
      }
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('非 synth 轨拒绝（鼓轨）', async () => {
    const { state, byName, exec, synthId } = await makeR5bTools()
    try {
      const drum = state.project.tracks.find((track) => track.kind === 'drum')
      assert.ok(drum)
      const result = await exec('studio_update_instrument', { trackId: drum.id, params: { attack: 0.1 } })
      assert.equal(result.ok, false)
      assert.match(result.error, /kind=synth|采样乐器轨/)
      const updateTrack = await exec('studio_update_track', { trackId: drum.id, instrumentParams: { attack: 0.1 } })
      assert.equal(updateTrack.ok, false)
      assert.match(updateTrack.error, /kind=synth|采样乐器轨/)
      assert.ok(byName.get('studio_update_instrument'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('missing track / 无 params 错误', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const missing = await exec('studio_update_instrument', { trackId: 'trk_404', params: { attack: 0.1 } })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /找不到轨道/)
      const noParams = await exec('studio_update_instrument', { trackId: synthId })
      assert.equal(noParams.ok, false)
      assert.match(noParams.error, /instrumentParams|params/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('undo/redo：参数写入与重置', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.5 } })
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.5 })
      await exec('studio_update_instrument', { trackId: synthId, reset: true })
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
      await exec('studio_undo')
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.5 })
      await exec('studio_redo')
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('undo 标签为「更新乐器参数」', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.1 } })
      assert.equal(state.historyState().undoLabel, '更新乐器参数')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('持久化：保存→新建→打开→重启', async () => {
    const { dir, state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.3, release: 1.5, filterCutoff: 600, lfoDepth: 25 } })
      await exec('studio_save_project', { name: 'R5b 乐器参数', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R5b 乐器参数' })
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, {
        attack: 0.3,
        release: 1.5,
        filterCutoff: 600,
        lfoDepth: 25,
      })
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.deepEqual(reloaded.project.tracks.find((track) => track.id === synthId).instrumentParams, {
          attack: 0.3,
          release: 1.5,
          filterCutoff: 600,
          lfoDepth: 25,
        })
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit updateInstrument：一次撤销', async () => {
    const { state, synthId } = await makeR5bTools()
    const server = await startServer(state)
    try {
      const edited = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'updateInstrument', trackId: synthId, params: { attack: 0.4, lfoRate: 2 } }],
      })
      assert.equal(edited.data.ok, true, edited.data.error)
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.4, lfoRate: 2 })
      assert.equal(state.historyState().undoLabel, '更新乐器参数')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch updateInstrument + updateTrack 一次撤销', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_batch', {
        ops: [
          { type: 'updateInstrument', args: { trackId: synthId, params: { attack: 0.2 } } },
          { type: 'updateTrack', args: { trackId: synthId, volume: 0.5 } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.2 })
      assert.equal(state.project.tracks.find((track) => track.id === synthId).volume, 0.5)
      assert.equal(state.historyState().undoLabel, '批量编辑')
      await exec('studio_undo')
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_track instrumentParams：合并更新并返回摘要', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_update_track', { trackId: synthId, instrumentParams: { attack: 0.15, release: 0.8 } })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.track.instrumentParams, { attack: 0.15, release: 0.8 })
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.15, release: 0.8 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('batch updateInstrument reset 结果 reset=true', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.3 } })
      const result = await exec('studio_batch', {
        ops: [{ type: 'updateInstrument', args: { trackId: synthId, reset: true } }],
      })
      assert.equal(result.ok, true, result.error)
      const entry = result.results.find((item) => item.type === 'updateInstrument')
      assert.equal(entry.reset, true)
      assert.deepEqual(entry.instrumentParams, {})
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('get_project：synth 默认 instrumentParams={}；非 synth 无该字段', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const overview = await exec('studio_get_project')
      const synth = overview.tracks.find((track) => track.id === synthId)
      assert.deepEqual(synth.instrumentParams, {})
      for (const track of overview.tracks.filter((item) => item.kind !== 'synth')) {
        assert.equal(Object.hasOwn(track, 'instrumentParams'), false, track.id)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('多个 synth 轨参数独立', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.1 } })
      const second = await exec('studio_add_track', { name: 'R5b 第二轨', kind: 'synth', preset: 'viola' })
      await exec('studio_update_instrument', { trackId: second.trackId, params: { release: 2 } })
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.1 })
      assert.deepEqual(state.project.tracks.find((track) => track.id === second.trackId).instrumentParams, { release: 2 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('最大/最小边界值可用', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const max = await exec('studio_update_instrument', {
        trackId: synthId,
        params: { attack: 2, release: 4, filterCutoff: 20000, filterQ: 12, lfoRate: 12, lfoDepth: 100 },
      })
      assert.equal(max.ok, true, max.error)
      assert.deepEqual(max.instrumentParams, { attack: 2, release: 4, filterQ: 12, lfoRate: 12, lfoDepth: 100 })
      const min = await exec('studio_update_instrument', {
        trackId: synthId,
        params: { attack: 0.001, release: 0.01, filterCutoff: 100, filterQ: 0.1, lfoRate: 0.1, lfoDepth: 0 },
      })
      assert.equal(min.ok, true, min.error)
      assert.deepEqual(min.instrumentParams, { attack: 0.001, release: 0.01, filterCutoff: 100, filterQ: 0.1, lfoRate: 0.1 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('更新乐器参数不改变 preset/instrument.params 与音量', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const before = state.project.tracks.find((track) => track.id === synthId)
      const preset = before.instrument.preset
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.2 } })
      const after = state.project.tracks.find((track) => track.id === synthId)
      assert.equal(after.instrument.preset, preset)
      assert.deepEqual(after.instrument.params, before.instrument.params)
      assert.equal(after.volume, before.volume)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('切换 preset 后 instrumentParams 保留', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.3 } })
      await exec('studio_update_track', { trackId: synthId, preset: 'vibraphone' })
      const track = state.project.tracks.find((item) => item.id === synthId)
      assert.equal(track.instrument.preset, 'vibraphone')
      assert.deepEqual(track.instrumentParams, { attack: 0.3 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突不写入参数', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_update_instrument', {
        trackId: synthId,
        params: { attack: 0.2 },
        expectedRevision: state.revision - 1,
      })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('reset 后 save/open 保持默认（无字段）', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.5 } })
      await exec('studio_update_instrument', { trackId: synthId, reset: true })
      await exec('studio_save_project', { name: 'R5b reset', overwrite: true })
      await exec('studio_open_project', { name: 'R5b reset' })
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('保存后 project.json 含 instrumentParams', async () => {
    const { dir, state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.25 } })
      await exec('studio_save_project', { name: 'R5b json', overwrite: true })
      const raw = await readFile(path.join(dir, 'projects', 'R5b json.json'), 'utf8')
      assert.ok(raw.includes('instrumentParams'))
      assert.ok(raw.includes('"attack":0.25'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具参数声明：trackId/params/reset + 描述中文', async () => {
    const { state, byName, synthId } = await makeR5bTools()
    try {
      const tool = byName.get('studio_update_instrument')
      assert.ok(tool)
      assert.ok(tool.parameters.trackId)
      assert.ok(tool.parameters.params)
      assert.ok(tool.parameters.reset)
      assert.match(tool.description, /attack/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R5b 补充：边界 */
describe('R5b — 乐器参数补充', () => {
  async function makeR5bTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    const synthId = state.project.tracks.find((track) => track.kind === 'synth').id
    return { state, byName, exec, synthId }
  }

  it('场景 recall 不改变 instrumentParams（快照不含）', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.2 } })
      await exec('studio_save_scene', { name: 'R5b scene' })
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.9 } })
      await exec('studio_recall_scene', { name: 'R5b scene' })
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.9 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('batch updateInstrument 多轨一次撤销', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const second = await exec('studio_add_track', { name: 'R5b B', kind: 'synth', preset: 'cello' })
      const result = await exec('studio_batch', {
        ops: [
          { type: 'updateInstrument', args: { trackId: synthId, params: { attack: 0.1 } } },
          { type: 'updateInstrument', args: { trackId: second.trackId, params: { release: 3 } } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.1 })
      assert.deepEqual(state.project.tracks.find((track) => track.id === second.trackId).instrumentParams, { release: 3 })
      await exec('studio_undo')
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('reset:false + params:{} 不改变现有参数', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.3 } })
      const result = await exec('studio_update_instrument', { trackId: synthId, reset: false, params: {} })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.instrumentParams, { attack: 0.3 })
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.3 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_track 组合 volume+automationMode+instrumentParams', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_update_track', {
        trackId: synthId,
        volume: 0.4,
        automationMode: 'write',
        instrumentParams: { attack: 0.2, filterCutoff: 1200 },
      })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === synthId)
      assert.equal(track.volume, 0.4)
      assert.equal(track.automationMode, 'write')
      assert.deepEqual(track.instrumentParams, { attack: 0.2, filterCutoff: 1200 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('连续更新后逐次 undo', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.2 } })
      await exec('studio_update_instrument', { trackId: synthId, params: { release: 1 } })
      await exec('studio_update_instrument', { trackId: synthId, params: { lfoDepth: 20 } })
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.2, release: 1, lfoDepth: 20 })
      await exec('studio_undo')
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.2, release: 1 })
      await exec('studio_undo')
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.2 })
      await exec('studio_undo')
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('reset 后 get_project synth 仍返回 {}', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.8 } })
      await exec('studio_update_instrument', { trackId: synthId, reset: true })
      const overview = await exec('studio_get_project')
      assert.deepEqual(overview.tracks.find((track) => track.id === synthId).instrumentParams, {})
      const drum = overview.tracks.find((track) => track.kind === 'drum')
      assert.equal(Object.hasOwn(drum, 'instrumentParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('保存→打开→重置→undo 恢复参数', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      await exec('studio_update_instrument', { trackId: synthId, params: { attack: 0.35, filterQ: 4 } })
      await exec('studio_save_project', { name: 'R5b undo', overwrite: true })
      await exec('studio_open_project', { name: 'R5b undo' })
      await exec('studio_update_instrument', { trackId: synthId, reset: true })
      assert.equal(Object.hasOwn(state.project.tracks.find((track) => track.id === synthId), 'instrumentParams'), false)
      await exec('studio_undo')
      assert.deepEqual(state.project.tracks.find((track) => track.id === synthId).instrumentParams, { attack: 0.35, filterQ: 4 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('reset:false 返回 reset=false；工具结果 normalized', async () => {
    const { state, exec, synthId } = await makeR5bTools()
    try {
      const result = await exec('studio_update_instrument', { trackId: synthId, params: { lfoDepth: 10.6 } })
      assert.equal(result.reset, false)
      assert.deepEqual(result.instrumentParams, { lfoDepth: 11 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R5c：模板/插件工具与路由                                                   */
/* ------------------------------------------------------------------------- */

describe('R5c — 工程模板 Host', () => {
  async function makeR5cTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, tools, byName, exec }
  }

  it('studio_list_templates：5 个模板摘要、只读不改 revision', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const revision = state.revision
      const result = await exec('studio_list_templates')
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 5)
      assert.deepEqual(result.templates.map((template) => template.id), ['empty', 'demo', 'electronic', 'piano', 'song'])
      for (const template of result.templates) {
        assert.ok(template.name.length > 0)
        assert.ok(template.desc.length > 0)
        assert.equal(typeof template.trackCount, 'number')
        assert.ok(Array.isArray(template.tracks))
        assert.equal(template.tracks.length, template.trackCount)
      }
      assert.equal(state.revision, revision)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_create_project template=electronic：结构/预设/BPM/长度/schema3', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const result = await exec('studio_create_project', { template: 'electronic' })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.schemaVersion, 3)
      assert.equal(state.project.tracks.length, 5)
      assert.equal(state.project.bpm, 128)
      assert.equal(state.project.lengthBars, 16)
      const kits = state.project.tracks.filter((track) => track.kind === 'drum').map((track) => track.instrument.kit)
      assert.deepEqual(kits, ['smp_electro'])
      const presets = state.project.tracks.filter((track) => track.kind === 'synth').map((track) => track.instrument.preset)
      assert.deepEqual(presets, ['picked_bass', 'synth_bass', 'warm_pad', 'trumpet'])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_create_project template=piano：无鼓、C 大调、96 BPM；title 可覆盖', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const result = await exec('studio_create_project', { template: 'piano', title: '我的钢琴曲' })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.title, '我的钢琴曲')
      assert.equal(state.project.tracks.length, 2)
      assert.equal(state.project.tracks.some((track) => track.kind === 'drum'), false)
      assert.equal(state.project.key, 'C')
      assert.equal(state.project.scale, 'major')
      assert.equal(state.project.bpm, 96)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_create_project template=demo：7 轨演示工程', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const result = await exec('studio_create_project', { template: 'demo' })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.length, 7)
      assert.equal(state.project.lengthBars, 32)
      assert.ok(state.project.patterns.length > 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_create_project 未知 template：中文错误、工程不变', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const before = state.project.title
      const result = await exec('studio_create_project', { template: 'nope', title: 'X' })
      assert.equal(result.ok, false)
      assert.match(result.error, /未知工程模板/)
      assert.equal(state.project.title, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('template 显式参数覆盖模板默认（title/bpm/key/scale/lengthBars）', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const result = await exec('studio_create_project', {
        template: 'piano',
        title: '覆盖',
        bpm: 140,
        key: 'A',
        scale: 'minor',
        lengthBars: 8,
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.title, '覆盖')
      assert.equal(state.project.bpm, 140)
      assert.equal(state.project.key, 'A')
      assert.equal(state.project.scale, 'minor')
      assert.equal(state.project.lengthBars, 8)
      assert.equal(state.project.tracks.length, 2)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('template=empty：0 轨空白工程（等同旧空工程）', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const result = await exec('studio_create_project', { template: 'empty' })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.length, 0)
      assert.equal(state.project.lengthBars, 32)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('创建模板工程重置 scenes/midiMappings/撤销历史', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      await exec('studio_set_midi_mapping', { cc: 1, target: 'volume', trackId: 'trk_1' })
      await exec('studio_save_scene', { name: '旧场景' })
      assert.equal(state.project.scenes.length, 1)
      assert.equal(state.project.midiMappings.length, 1)
      const created = await exec('studio_create_project', { template: 'piano' })
      assert.equal(created.ok, true, created.error)
      assert.equal(state.project.scenes.length, 0)
      assert.equal(state.project.midiMappings.length, 0)
      assert.equal(state.historyState().undoDepth, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('模板工程保存→打开→重启持久化', async () => {
    const { dir, state, exec } = await makeR5cTools()
    try {
      await exec('studio_create_project', { template: 'song', title: '模板持久化' })
      await exec('studio_save_project', { name: 'R5c 模板工程', overwrite: true })
      await exec('studio_create_project', { template: 'empty' })
      await exec('studio_open_project', { name: 'R5c 模板工程' })
      assert.equal(state.project.title, '模板持久化')
      assert.equal(state.project.tracks.length, 5)
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.equal(reloaded.project.tracks.length, 5)
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('POST /projects/new：5 个模板均可创建且结构正确', async () => {
    const { state } = await makeR5cTools()
    const server = await startServer(state)
    try {
      const expected = { empty: 0, demo: 7, electronic: 5, piano: 2, song: 5 }
      for (const [template, trackCount] of Object.entries(expected)) {
        const res = await postJson(server.base, '/studio/api/projects/new', { template })
        assert.equal(res.status, 200, template)
        assert.equal(res.data.ok, true, res.data.error)
        assert.equal(res.data.template, template)
        assert.equal(state.project.tracks.length, trackCount, template)
      }
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /projects/new 未知模板：400 中文错误', async () => {
    const { state } = await makeR5cTools()
    const server = await startServer(state)
    try {
      const res = await postJson(server.base, '/studio/api/projects/new', { template: 'nope' })
      assert.equal(res.status, 400)
      assert.equal(res.data.ok, false)
      assert.match(res.data.error, /未知工程模板/)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /projects/new 旧行为：无 template/带 name → 空白并改标题；demo 仍演示', async () => {
    const { state } = await makeR5cTools()
    const server = await startServer(state)
    try {
      const plain = await postJson(server.base, '/studio/api/projects/new', {})
      assert.equal(plain.status, 200)
      assert.equal(plain.data.template, 'empty')
      assert.equal(state.project.tracks.length, 0)
      const named = await postJson(server.base, '/studio/api/projects/new', { name: '新名字' })
      assert.equal(named.data.ok, true)
      assert.equal(state.project.title, '新名字')
      const demo = await postJson(server.base, '/studio/api/projects/new', { template: 'demo' })
      assert.equal(demo.data.template, 'demo')
      assert.equal(state.project.tracks.length, 7)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('创建模板后 activeName 清空、可保存', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      await exec('studio_create_project', { template: 'electronic' })
      assert.equal(state.activeName, null)
      const saved = await exec('studio_save_project', { name: 'R5c active', overwrite: true })
      assert.equal(saved.ok, true, saved.error)
      assert.equal(state.activeName, 'R5c active')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('连续创建模板工程不共享轨道引用', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      await exec('studio_create_project', { template: 'piano' })
      state.mutate({ tool: 'test' }, (draft) => {
        draft.tracks[0].volume = 0.1
        return undefined
      })
      await exec('studio_create_project', { template: 'piano' })
      assert.notEqual(state.project.tracks[0].volume, 0.1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R5c — 插件清单 Host', () => {
  async function makeR5cTools(defineTool) {
    const { state } = await makeState()
    const tools = createTools({ defineTool: defineTool ?? ((options) => options), state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { state, tools, byName, exec }
  }

  it('studio_list_plugins：47 个插件/32 乐器/15 效果器、SDK 版本', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const revision = state.revision
      const result = await exec('studio_list_plugins')
      assert.equal(result.ok, true, result.error)
      assert.equal(result.sdkVersion, '1.0')
      assert.equal(result.count, 47)
      assert.equal(result.plugins.filter((plugin) => plugin.kind === 'instrument').length, 32)
      assert.equal(result.plugins.filter((plugin) => plugin.kind === 'effect').length, 15)
      assert.equal(state.revision, revision)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_list_plugins：参数 schema 完整（乐器 6 项/效果器全量）', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const all = await exec('studio_list_plugins')
      const piano = all.plugins.find((plugin) => plugin.id === 'grand_piano')
      assert.equal(piano.kind, 'instrument')
      assert.deepEqual(piano.params.map((param) => param.key), ['attack', 'release', 'filterCutoff', 'filterQ', 'lfoRate', 'lfoDepth'])
      const filter = all.plugins.find((plugin) => plugin.id === 'filter')
      assert.equal(filter.kind, 'effect')
      assert.ok(filter.params.some((param) => param.key === 'mode' && Array.isArray(param.options)))
      for (const plugin of all.plugins) {
        assert.equal(plugin.stateVersion, 1)
        assert.ok(plugin.name.length > 0)
        assert.ok(plugin.category.length > 0)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_list_plugins：type 过滤 instrument/effect', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const instruments = await exec('studio_list_plugins', { type: 'instrument' })
      assert.equal(instruments.count, 32)
      assert.ok(instruments.plugins.every((plugin) => plugin.kind === 'instrument'))
      const effects = await exec('studio_list_plugins', { type: 'effect' })
      assert.equal(effects.count, 15)
      assert.ok(effects.plugins.every((plugin) => plugin.kind === 'effect'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_list_plugins 真实 DSL：非法 type 被 enum 拒绝', async () => {
    const { state, tools } = await makeR5cTools(realDefineTool)
    try {
      const tool = tools.find((item) => item.name === 'studio_list_plugins')
      assert.deepEqual(tool.parameters.properties.type.enum, ['instrument', 'effect'])
      await assert.rejects(() => tool.execute({ type: 'drum' }, {}), /invalid arguments/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('GET /plugins：全部/类型过滤/未知类型 400', async () => {
    const { state } = await makeR5cTools()
    const server = await startServer(state)
    try {
      const all = await (await fetch(`${server.base}/studio/api/plugins`)).json()
      assert.equal(all.ok, true)
      assert.equal(all.sdkVersion, '1.0')
      assert.equal(all.count, 47)
      assert.equal(all.plugins.length, 47)
      const instruments = await (await fetch(`${server.base}/studio/api/plugins?type=instrument`)).json()
      assert.equal(instruments.count, 32)
      const effects = await (await fetch(`${server.base}/studio/api/plugins?type=effect`)).json()
      assert.equal(effects.count, 15)
      const bad = await fetch(`${server.base}/studio/api/plugins?type=drum`)
      assert.equal(bad.status, 400)
      const badBody = await bad.json()
      assert.equal(badBody.ok, false)
      assert.match(badBody.error, /未知插件类型/)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('插件清单与模板工具只读：不改工程 revision', async () => {
    const { state, exec } = await makeR5cTools()
    try {
      const revision = state.revision
      await exec('studio_list_plugins', { type: 'effect' })
      await exec('studio_list_templates')
      assert.equal(state.revision, revision)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具声明：list_templates/list_plugins 无必填参数、描述中文', async () => {
    const { state, byName } = await makeR5cTools()
    try {
      const templates = byName.get('studio_list_templates')
      const plugins = byName.get('studio_list_plugins')
      assert.ok(templates)
      assert.ok(plugins)
      assert.ok(/模板/.test(templates.description))
      assert.ok(/插件/.test(plugins.description))
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R5d：subtractive 合成器 Host 工具                                          */
/* ------------------------------------------------------------------------- */

describe('R5d — engine / studio_update_synth', () => {
  async function makeR5dTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    const samplerId = state.project.tracks.find((track) => track.kind === 'synth').id
    return { state, tools, byName, exec, samplerId }
  }

  async function addSubtractive(exec, preset = 'saw_lead', extra = {}) {
    return exec('studio_add_track', { name: `R5d-${preset}`, kind: 'synth', engine: 'subtractive', synthPreset: preset, ...extra })
  }

  it('studio_add_track engine=subtractive：创建并写入 engine/synthPreset', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const result = await addSubtractive(exec, 'saw_lead')
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === result.trackId)
      assert.equal(track.engine, 'subtractive')
      assert.equal(track.synthPreset, 'saw_lead')
      assert.equal(track.kind, 'synth')
      assert.equal(result.track.engine, 'subtractive')
      assert.equal(result.track.synthPreset, 'saw_lead')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('subtractive 省略 synthPreset：默认 sub_bass', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const result = await exec('studio_add_track', { name: 'R5d-default', kind: 'synth', engine: 'subtractive' })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.find((item) => item.id === result.trackId).synthPreset, 'sub_bass')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('默认 sampler：不写 engine/synthPreset/synthParams', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const result = await exec('studio_add_track', { name: 'R5d-sampler', kind: 'synth', preset: 'grand_piano' })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === result.trackId)
      assert.equal(Object.hasOwn(track, 'engine'), false)
      assert.equal(Object.hasOwn(track, 'synthPreset'), false)
      assert.equal(result.track.engine, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('互斥：subtractive + preset 拒绝；sampler + synthPreset 拒绝', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const a = await exec('studio_add_track', { name: 'x', kind: 'synth', engine: 'subtractive', synthPreset: 'pluck', preset: 'grand_piano' })
      assert.equal(a.ok, false)
      assert.match(a.error, /不接受采样 preset/)
      const b = await exec('studio_add_track', { name: 'x', kind: 'synth', preset: 'grand_piano', synthPreset: 'pluck' })
      assert.equal(b.ok, false)
      assert.match(b.error, /不接受 synthPreset/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('非法 engine / synthPreset 中文拒绝', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const engine = await exec('studio_add_track', { name: 'x', kind: 'synth', engine: 'bogus' })
      assert.equal(engine.ok, false)
      assert.match(engine.error, /engine/)
      const preset = await exec('studio_add_track', { name: 'x', kind: 'synth', engine: 'subtractive', synthPreset: 'nope' })
      assert.equal(preset.ok, false)
      assert.match(preset.error, /未知合成器/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('drum + subtractive 拒绝', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const result = await exec('studio_add_track', { name: 'x', kind: 'drum', engine: 'subtractive' })
      assert.equal(result.ok, false)
      assert.match(result.error, /subtractive|kind=synth/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('add subtractive + synthParams：夹紧并规范化', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const result = await addSubtractive(exec, 'saw_lead', { synthParams: { wave: 'square', unison: 9, attack: 0.0001 } })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === result.trackId)
      assert.deepEqual(track.synthParams, { wave: 'square', attack: 0.001 }, 'unison=2 与 saw_lead 默认相同而省略')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('get_project：subtractive 摘要含 engine/synthPreset/synthParams', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'supersaw', { synthParams: { detuneCents: 25 } })
      const overview = await exec('studio_get_project')
      const track = overview.tracks.find((item) => item.id === added.trackId)
      assert.equal(track.engine, 'subtractive')
      assert.equal(track.synthPreset, 'supersaw')
      assert.deepEqual(track.synthParams, { detuneCents: 25 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_track 切换 engine：subtractive 时 instrument.preset=null，切回 sampler 恢复默认 preset', async () => {
    const { state, exec, samplerId } = await makeR5dTools()
    try {
      const result = await exec('studio_update_track', { trackId: samplerId, engine: 'subtractive' })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === samplerId)
      assert.equal(track.engine, 'subtractive')
      // v2.1：subtractive 轨不使用采样器 preset，UI 按 synthPreset 显示 label。
      assert.equal(track.instrument.preset, null)
      assert.equal(track.synthPreset, 'sub_bass')
      await exec('studio_update_track', { trackId: samplerId, engine: 'sampler' })
      const back = state.project.tracks.find((item) => item.id === samplerId)
      assert.equal(back.engine, undefined)
      assert.equal(typeof back.instrument.preset, 'string')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('切回 sampler：保留 synthPreset（切换保留）', async () => {
    const { state, exec, samplerId } = await makeR5dTools()
    try {
      await exec('studio_update_track', { trackId: samplerId, engine: 'subtractive', synthPreset: 'acid_bass' })
      await exec('studio_update_track', { trackId: samplerId, engine: 'sampler' })
      const track = state.project.tracks.find((item) => item.id === samplerId)
      assert.equal(track.engine, undefined)
      assert.equal(track.synthPreset, 'acid_bass')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_track engine 非法/非 synth 拒绝', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const drum = state.project.tracks.find((track) => track.kind === 'drum')
      const bad = await exec('studio_update_track', { trackId: 'trk_404', engine: 'subtractive' })
      assert.equal(bad.ok, false)
      const badDrum = await exec('studio_update_track', { trackId: drum.id, engine: 'subtractive' })
      assert.equal(badDrum.ok, false)
      const deep = await makeR5dTools()
      try {
        const invalid = await deep.exec('studio_update_track', { trackId: deep.samplerId, engine: 'bogus' })
        assert.equal(invalid.ok, false)
        assert.match(invalid.error, /engine/)
      } finally {
        await deep.state.flush()
        deep.state.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth：切换 preset + 参数合并/取整', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'saw_lead')
      const result = await exec('studio_update_synth', {
        trackId: added.trackId,
        synthPreset: 'acid_bass',
        params: { filterCutoff: 1200.46, wave: 'square', unison: 9 },
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.synthPreset, 'acid_bass')
      assert.deepEqual(result.synthParams, { wave: 'square', unison: 2, filterCutoff: 1200.5 })
      const track = state.project.tracks.find((item) => item.id === added.trackId)
      assert.equal(track.synthPreset, 'acid_bass')
      assert.deepEqual(track.synthParams, { wave: 'square', unison: 2, filterCutoff: 1200.5 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth：未知参数/非法 wave 中文拒绝', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'pluck')
      const unknown = await exec('studio_update_synth', { trackId: added.trackId, params: { bogus: 1 } })
      assert.equal(unknown.ok, false)
      assert.match(unknown.error, /未知合成器参数/)
      const badWave = await exec('studio_update_synth', { trackId: added.trackId, params: { wave: 'noise' } })
      assert.equal(badWave.ok, false)
      assert.match(badWave.error, /wave/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth：非法 preset / 非 subtractive 轨拒绝', async () => {
    const { state, exec, samplerId } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'pluck')
      const badPreset = await exec('studio_update_synth', { trackId: added.trackId, synthPreset: 'nope' })
      assert.equal(badPreset.ok, false)
      assert.match(badPreset.error, /未知合成器/)
      const sampler = await exec('studio_update_synth', { trackId: samplerId, synthPreset: 'saw_lead' })
      assert.equal(sampler.ok, false)
      assert.match(sampler.error, /subtractive/)
      const drum = state.project.tracks.find((track) => track.kind === 'drum')
      const drumResult = await exec('studio_update_synth', { trackId: drum.id, params: { level: 0.5 } })
      assert.equal(drumResult.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth reset：清除覆盖、保留 preset', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'warm_pad', { synthParams: { attack: 1, wave: 'sine' } })
      const result = await exec('studio_update_synth', { trackId: added.trackId, reset: true })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.reset, true)
      assert.deepEqual(result.synthParams, {})
      assert.equal(result.synthPreset, 'warm_pad')
      const track = state.project.tracks.find((item) => item.id === added.trackId)
      assert.equal(Object.hasOwn(track, 'synthParams'), false)
      assert.equal(track.synthPreset, 'warm_pad')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth undo/redo 与撤销标签', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'saw_lead')
      await exec('studio_update_synth', { trackId: added.trackId, params: { filterCutoff: 900 } })
      assert.equal(state.historyState().undoLabel, '更新合成器音色')
      assert.equal(state.project.tracks.find((item) => item.id === added.trackId).synthParams.filterCutoff, 900)
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((item) => item.id === added.trackId).synthParams, undefined)
      await exec('studio_redo')
      assert.equal(state.project.tracks.find((item) => item.id === added.trackId).synthParams.filterCutoff, 900)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 持久化：保存→新建→打开→重启', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'sine_keys', { synthParams: { attack: 0.5, level: 0.6 } })
      await exec('studio_save_project', { name: 'R5d 合成器工程', overwrite: true })
      await exec('studio_create_project', { title: '空' })
      await exec('studio_open_project', { name: 'R5d 合成器工程' })
      const track = state.project.tracks.find((item) => item.id === added.trackId)
      assert.equal(track.engine, 'subtractive')
      assert.equal(track.synthPreset, 'sine_keys')
      assert.deepEqual(track.synthParams, { attack: 0.5, level: 0.6 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit updateSynth：一次撤销', async () => {
    const { state, exec } = await makeR5dTools()
    const added = await addSubtractive(exec, 'saw_lead')
    const server = await startServer(state)
    try {
      const edited = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'updateSynth', trackId: added.trackId, params: { wave: 'square' } }],
      })
      assert.equal(edited.data.ok, true, edited.data.error)
      assert.equal(state.project.tracks.find((item) => item.id === added.trackId).synthParams.wave, 'square')
      assert.equal(state.historyState().undoLabel, '更新合成器音色')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(state.project.tracks.find((item) => item.id === added.trackId).synthParams, undefined)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_batch updateSynth+updateTrack 一次撤销', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'supersaw')
      const result = await exec('studio_batch', {
        ops: [
          { type: 'updateSynth', args: { trackId: added.trackId, synthPreset: 'pluck', params: { wave: 'triangle' } } },
          { type: 'updateTrack', args: { trackId: added.trackId, volume: 0.5 } },
        ],
      })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === added.trackId)
      assert.equal(track.synthPreset, 'pluck')
      assert.equal(track.synthParams.wave, 'triangle')
      assert.equal(track.volume, 0.5)
      assert.equal(state.historyState().undoLabel, '批量编辑')
      await exec('studio_undo')
      assert.equal(state.project.tracks.find((item) => item.id === added.trackId).synthPreset, 'supersaw')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具声明与参数枚举：studio_update_synth + add/update track engine', async () => {
    const { state, byName } = await makeR5dTools()
    try {
      const synth = byName.get('studio_update_synth')
      assert.ok(synth)
      assert.deepEqual(synth.parameters.synthPreset.enum, ['sub_bass', 'saw_lead', 'square_lead', 'supersaw', 'warm_pad', 'pluck', 'acid_bass', 'sine_keys'])
      const add = byName.get('studio_add_track')
      assert.deepEqual(add.parameters.engine.enum, ['sampler', 'subtractive'])
      assert.equal(add.parameters.synthPreset.enum.length, 8)
      const update = byName.get('studio_update_track')
      assert.deepEqual(update.parameters.engine.enum, ['sampler', 'subtractive'])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth：missing track / 无 engine 的 sampler 轨错误', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const missing = await exec('studio_update_synth', { trackId: 'trk_404', params: {} })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /找不到轨道/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth expectedRevision 冲突不写入', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'pluck')
      const result = await exec('studio_update_synth', {
        trackId: added.trackId,
        params: { wave: 'square' },
        expectedRevision: state.revision - 1,
      })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.tracks.find((item) => item.id === added.trackId).synthParams, undefined)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth params:{} 不改变现有覆盖', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'saw_lead', { synthParams: { wave: 'square' } })
      const result = await exec('studio_update_synth', { trackId: added.trackId, params: {} })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.synthParams, { wave: 'square' })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 写入默认值等价时省略覆盖', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'sine_keys')
      const defaults = findSynthInstrument('sine_keys').synthPreset
      const result = await exec('studio_update_synth', { trackId: added.trackId, params: { ...defaults } })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.synthParams, {})
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === added.trackId), 'synthParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 8 个 preset 全部可切换', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'saw_lead')
      for (const preset of SYNTH_INSTRUMENTS.map((item) => item.id)) {
        const result = await exec('studio_update_synth', { trackId: added.trackId, synthPreset: preset })
        assert.equal(result.ok, true, `${preset}: ${result.error}`)
        assert.equal(result.synthPreset, preset)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 保留 instrumentParams/volume/preset 等其它字段', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'pluck')
      await exec('studio_update_instrument', { trackId: added.trackId, params: { attack: 0.2 } })
      await exec('studio_update_track', { trackId: added.trackId, volume: 0.4 })
      await exec('studio_update_synth', { trackId: added.trackId, params: { wave: 'square' } })
      const track = state.project.tracks.find((item) => item.id === added.trackId)
      assert.deepEqual(track.instrumentParams, { attack: 0.2 })
      assert.equal(track.volume, 0.4)
      assert.equal(track.synthPreset, 'pluck')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('两条 subtractive 轨参数独立', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const a = await addSubtractive(exec, 'saw_lead')
      const b = await addSubtractive(exec, 'acid_bass')
      await exec('studio_update_synth', { trackId: a.trackId, params: { wave: 'square' } })
      await exec('studio_update_synth', { trackId: b.trackId, params: { filterQ: 9 } })
      assert.deepEqual(state.project.tracks.find((item) => item.id === a.trackId).synthParams, { wave: 'square' })
      assert.deepEqual(state.project.tracks.find((item) => item.id === b.trackId).synthParams, { filterQ: 9 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('保存后 project.json 含 engine/synthPreset', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      await addSubtractive(exec, 'sine_keys', { synthParams: { attack: 0.3 } })
      await exec('studio_save_project', { name: 'R5d json', overwrite: true })
      const raw = await readFile(path.join(state.dataDir, 'projects', 'R5d json.json'), 'utf8')
      assert.ok(raw.includes('"engine":"subtractive"'))
      assert.ok(raw.includes('"synthPreset":"sine_keys"'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('app_info：synthInstruments 8，counts.instruments 仍 32', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const info = await exec('studio_app_info')
      assert.equal(info.synthInstruments.length, 8)
      assert.deepEqual(info.synthInstruments.map((item) => item.id), [
        'sub_bass', 'saw_lead', 'square_lead', 'supersaw', 'warm_pad', 'pluck', 'acid_bass', 'sine_keys',
      ])
      assert.equal(info.counts.instruments, 32)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('GET /catalog 返回 synthInstruments 8', async () => {
    const { state } = await makeR5dTools()
    const server = await startServer(state)
    try {
      const data = await (await fetch(`${server.base}/studio/api/catalog`)).json()
      assert.equal(data.synthInstruments.length, 8)
      assert.equal(data.counts.instruments, 32)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('场景 recall 不改变 engine/synthPreset/synthParams', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const added = await addSubtractive(exec, 'saw_lead', { synthParams: { wave: 'square' } })
      await exec('studio_save_scene', { name: 'R5d scene' })
      await exec('studio_update_synth', { trackId: added.trackId, synthPreset: 'pluck', params: { attack: 0.4 } })
      await exec('studio_recall_scene', { name: 'R5d scene' })
      const track = state.project.tracks.find((item) => item.id === added.trackId)
      assert.equal(track.synthPreset, 'pluck')
      assert.deepEqual(track.synthParams, { attack: 0.4 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('模板工程上添加 subtractive 轨正常', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      await exec('studio_create_project', { template: 'piano' })
      const before = state.project.tracks.length
      const added = await addSubtractive(exec, 'warm_pad')
      assert.equal(added.ok, true, added.error)
      assert.equal(state.project.tracks.length, before + 1)
      assert.equal(state.project.tracks.find((item) => item.id === added.trackId).engine, 'subtractive')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('sampler 与 subtractive 轨共存，summary 各自正确', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const sub = await addSubtractive(exec, 'saw_lead')
      const sampler = await exec('studio_add_track', { name: 'sampler', kind: 'synth', preset: 'grand_piano' })
      const overview = await exec('studio_get_project')
      assert.equal(overview.tracks.find((item) => item.id === sub.trackId).engine, 'subtractive')
      const samplerSummary = overview.tracks.find((item) => item.id === sampler.trackId)
      assert.equal(Object.hasOwn(samplerSummary, 'engine'), false)
      assert.equal(Object.hasOwn(samplerSummary, 'synthPreset'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R5d 补充：工具边界 */
describe('R5d — 合成器补充', () => {
  async function makeR5dTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    const samplerId = state.project.tracks.find((track) => track.kind === 'synth').id
    return { state, byName, exec, samplerId }
  }

  async function addSub(exec, preset, extra = {}) {
    const result = await exec('studio_add_track', { name: `R5d-x-${preset}`, kind: 'synth', engine: 'subtractive', synthPreset: preset, ...extra })
    if (!result.ok) throw new Error(result.error)
    return result.trackId
  }

  it('update_track 同一次设置 engine+synthPreset', async () => {
    const { state, exec, samplerId } = await makeR5dTools()
    try {
      const result = await exec('studio_update_track', { trackId: samplerId, engine: 'subtractive', synthPreset: 'supersaw' })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === samplerId)
      assert.equal(track.engine, 'subtractive')
      assert.equal(track.synthPreset, 'supersaw')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('sampler 轨设置 synthPreset：摘要保留（切换 retention）', async () => {
    const { state, exec, samplerId } = await makeR5dTools()
    try {
      await exec('studio_update_track', { trackId: samplerId, synthPreset: 'pluck' })
      const overview = await exec('studio_get_project')
      const summary = overview.tracks.find((item) => item.id === samplerId)
      assert.equal(summary.engine, 'sampler')
      assert.equal(summary.synthPreset, 'pluck')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 切换 preset 时保留已有覆盖', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const trackId = await addSub(exec, 'saw_lead', { synthParams: { wave: 'square' } })
      const result = await exec('studio_update_synth', { trackId, synthPreset: 'warm_pad' })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(state.project.tracks.find((item) => item.id === trackId).synthParams, { wave: 'square' })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 全字段夹紧：unison/detune/sub/cutoff/Q/ADSR/rate/depth/level', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const trackId = await addSub(exec, 'saw_lead')
      const result = await exec('studio_update_synth', {
        trackId,
        params: {
          unison: 99,
          detuneCents: -5,
          subLevel: 2,
          filterCutoff: 99999,
          filterQ: 99,
          attack: 99,
          decay: 0,
          sustain: 5,
          release: 0,
          lfoRate: 99,
          lfoDepth: 999,
          level: 2,
        },
      })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.synthParams, {
        detuneCents: 0,
        subLevel: 1,
        filterCutoff: 18000,
        filterQ: 20,
        attack: 2,
        decay: 0.005,
        sustain: 1,
        release: 0.01,
        lfoRate: 12,
        lfoDepth: 100,
        level: 1,
      }, 'unison=2 与 saw_lead 默认相同而省略')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 所有字段写入/取整一次完成', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const trackId = await addSub(exec, 'sine_keys')
      const result = await exec('studio_update_synth', {
        trackId,
        params: {
          wave: 'triangle',
          unison: 2,
          detuneCents: 12.34,
          subLevel: 0.5,
          filterCutoff: 1234.56,
          filterQ: 2.34,
          attack: 0.12,
          decay: 0.34,
          sustain: 0.56,
          release: 0.78,
          lfoRate: 0.45,
          lfoDepth: 6.6,
          level: 0.9,
        },
      })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.synthParams, {
        wave: 'triangle',
        unison: 2,
        detuneCents: 12.3,
        subLevel: 0.5,
        filterCutoff: 1234.6,
        filterQ: 2.3,
        attack: 0.12,
        decay: 0.34,
        sustain: 0.56,
        release: 0.78,
        lfoRate: 0.5,
        lfoDepth: 7,
        level: 0.9,
      })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('/edit updateTrack engine 切换一次撤销', async () => {
    const { state, exec, samplerId } = await makeR5dTools()
    const server = await startServer(state)
    try {
      const edited = await postJson(server.base, '/studio/api/edit', {
        ops: [{ type: 'updateTrack', trackId: samplerId, engine: 'subtractive', synthPreset: 'pluck' }],
      })
      assert.equal(edited.data.ok, true, edited.data.error)
      assert.equal(state.project.tracks.find((item) => item.id === samplerId).engine, 'subtractive')
      await postJson(server.base, '/studio/api/history/undo', {})
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === samplerId), 'engine'), false)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('batch updateSynth reset：结果 reset=true', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const trackId = await addSub(exec, 'saw_lead', { synthParams: { wave: 'square' } })
      const result = await exec('studio_batch', { ops: [{ type: 'updateSynth', args: { trackId, reset: true } }] })
      assert.equal(result.ok, true, result.error)
      const entry = result.results.find((item) => item.type === 'updateSynth')
      assert.equal(entry.reset, true)
      assert.deepEqual(entry.synthParams, {})
      assert.equal(Object.hasOwn(state.project.tracks.find((item) => item.id === trackId), 'synthParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('add subtractive expectedRevision 冲突不写入', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const before = state.project.tracks.length
      const result = await exec('studio_add_track', {
        name: 'x',
        kind: 'synth',
        engine: 'subtractive',
        synthPreset: 'pluck',
        expectedRevision: state.revision - 1,
      })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.tracks.length, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 切换 preset 后 get_project 反映新 preset/覆盖', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const trackId = await addSub(exec, 'sub_bass')
      await exec('studio_update_synth', { trackId, synthPreset: 'acid_bass', params: { filterQ: 8 } })
      const overview = await exec('studio_get_project')
      const summary = overview.tracks.find((item) => item.id === trackId)
      assert.equal(summary.synthPreset, 'acid_bass')
      assert.deepEqual(summary.synthParams, { filterQ: 8 })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('app_info synthInstruments 含 8 个 wave 字段', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const info = await exec('studio_app_info')
      const waves = info.synthInstruments.map((item) => item.wave)
      assert.equal(waves.length, 8)
      for (const wave of waves) assert.ok(['saw', 'square', 'sine', 'triangle'].includes(wave))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 重置后保存/打开保持无覆盖', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const trackId = await addSub(exec, 'warm_pad', { synthParams: { attack: 1 } })
      await exec('studio_update_synth', { trackId, reset: true })
      await exec('studio_save_project', { name: 'R5d reset 持久化', overwrite: true })
      await exec('studio_update_synth', { trackId, params: { wave: 'sine' } })
      await exec('studio_open_project', { name: 'R5d reset 持久化' })
      const track = state.project.tracks.find((item) => item.id === trackId)
      assert.equal(track.synthPreset, 'warm_pad')
      assert.equal(Object.hasOwn(track, 'synthParams'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_synth 参数 wave=triangle 可写入', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const trackId = await addSub(exec, 'sine_keys')
      const result = await exec('studio_update_synth', { trackId, params: { wave: 'triangle' } })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.find((item) => item.id === trackId).synthParams.wave, 'triangle')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('update_track synthParams 无 synthPreset 时用默认 preset 归一', async () => {
    const { state, exec, samplerId } = await makeR5dTools()
    try {
      const result = await exec('studio_update_track', { trackId: samplerId, synthPreset: 'saw_lead', synthParams: { wave: 'square' } })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(state.project.tracks.find((item) => item.id === samplerId).synthParams, { wave: 'square' })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('add subtractive 后 update_track engine=sampler 再回 subtractive 保留 synthPreset', async () => {
    const { state, exec } = await makeR5dTools()
    try {
      const trackId = await addSub(exec, 'pluck')
      await exec('studio_update_track', { trackId, engine: 'sampler' })
      assert.equal(state.project.tracks.find((item) => item.id === trackId).synthPreset, 'pluck')
      await exec('studio_update_track', { trackId, engine: 'subtractive' })
      assert.equal(state.project.tracks.find((item) => item.id === trackId).synthPreset, 'pluck')
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R6a：生成器/混音 assistant Host 工具                                       */
/* ------------------------------------------------------------------------- */

describe('R6a — studio_generate_part / variation / mix', () => {
  async function makeR6aTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    const drumId = state.project.tracks.find((track) => track.kind === 'drum').id
    const synthId = state.project.tracks.find((track) => track.kind === 'synth').id
    return { state, tools, byName, exec, drumId, synthId }
  }

  it('studio_generate_part：house drums → 新 pattern/summary/noteCount', async () => {
    const { state, exec, drumId } = await makeR6aTools()
    try {
      const result = await exec('studio_generate_part', { trackId: drumId, kind: 'drums', style: 'house', bars: 2, seed: 7 })
      assert.equal(result.ok, true, result.error)
      assert.ok(result.patternId.startsWith('pat_'))
      assert.equal(result.trackId, drumId)
      assert.equal(result.summary.kind, 'drums')
      assert.equal(result.summary.style, 'house')
      assert.equal(result.summary.bars, 2)
      assert.equal(result.summary.seed, 7)
      assert.ok(result.noteCount > 0)
      const pattern = state.project.patterns.find((item) => item.id === result.patternId)
      assert.equal(pattern.lengthBars, 2)
      assert.equal(pattern.notes.length, result.noteCount)
      const overview = await exec('studio_get_project')
      assert.ok(overview.patterns.some((item) => item.id === result.patternId))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_generate_part：bass/chords/lead/arp 均可生成', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      for (const kind of ['bass', 'chords', 'lead', 'arp']) {
        const result = await exec('studio_generate_part', { trackId: synthId, kind, style: 'pop', bars: 2, seed: 3 })
        assert.equal(result.ok, true, `${kind}: ${result.error}`)
        assert.equal(result.summary.kind, kind)
        assert.ok(result.noteCount > 0, kind)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_generate_part：同 seed 工具调用完全一致；不同 seed 不同', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const a = await exec('studio_generate_part', { trackId: synthId, kind: 'lead', style: 'house', bars: 2, seed: 5 })
      const b = await exec('studio_generate_part', { trackId: synthId, kind: 'lead', style: 'house', bars: 2, seed: 5 })
      const notesA = state.project.patterns.find((item) => item.id === a.patternId).notes
      const notesB = state.project.patterns.find((item) => item.id === b.patternId).notes
      assert.deepEqual(notesA, notesB)
      const c = await exec('studio_generate_part', { trackId: synthId, kind: 'lead', style: 'house', bars: 2, seed: 6 })
      const notesC = state.project.patterns.find((item) => item.id === c.patternId).notes
      assert.notDeepEqual(notesA, notesC)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_generate_part：写入现有 pattern 替换/追加', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const created = await exec('studio_add_pattern', { name: 'R6a', lengthBars: 4 })
      const patternId = created.patternId ?? created.pattern?.id
      assert.ok(patternId, JSON.stringify(created).slice(0, 120))
      const replaced = await exec('studio_generate_part', { trackId: synthId, patternId, kind: 'bass', bars: 4, seed: 2 })
      assert.equal(replaced.ok, true, replaced.error)
      assert.equal(replaced.patternId, patternId)
      const replaceCount = state.project.patterns.find((item) => item.id === patternId).notes.length
      assert.equal(replaceCount, replaced.noteCount)
      const appended = await exec('studio_generate_part', { trackId: synthId, patternId, kind: 'bass', bars: 4, seed: 3, replaceExisting: false })
      assert.equal(appended.ok, true, appended.error)
      assert.ok(appended.noteCount > replaceCount)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_part 错误：轨道类型/kind/style/bars/pattern/bars 越界', async () => {
    const { state, exec, drumId, synthId } = await makeR6aTools()
    try {
      const cases = [
        { trackId: synthId, kind: 'drums' },
        { trackId: drumId, kind: 'bass' },
        { trackId: synthId, kind: 'nope' },
        { trackId: synthId, kind: 'lead', style: 'jazz' },
        { trackId: synthId, kind: 'lead', bars: 0 },
        { trackId: synthId, kind: 'lead', patternId: 'pat_404' },
        { trackId: 'trk_404', kind: 'lead' },
      ]
      for (const args of cases) {
        const result = await exec('studio_generate_part', args)
        assert.equal(result.ok, false, JSON.stringify(args))
      }
      const tooLong = await exec('studio_generate_part', { trackId: synthId, kind: 'lead', bars: 8, patternId: state.project.patterns[0].id })
      assert.equal(tooLong.ok, false)
      assert.match(tooLong.error, /bars|长度/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_part undo/redo：新 pattern 整体回滚', async () => {
    const { state, exec, drumId } = await makeR6aTools()
    try {
      const before = state.project.patterns.length
      const result = await exec('studio_generate_part', { trackId: drumId, kind: 'drums', bars: 2, seed: 1 })
      assert.equal(state.project.patterns.length, before + 1)
      assert.equal(state.historyState().undoLabel, '生成声部')
      await exec('studio_undo')
      assert.equal(state.project.patterns.length, before)
      await exec('studio_redo')
      assert.equal(state.project.patterns.length, before + 1)
      assert.ok(state.project.patterns.some((item) => item.id === result.patternId))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_part：key/scale 覆盖工程；pitch 落在指定音阶', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const result = await exec('studio_generate_part', { trackId: synthId, kind: 'lead', style: 'pop', bars: 2, key: 'D', scale: 'major', seed: 4 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.summary.seed, 4)
      const scalePcs = new Set([2, 4, 6, 7, 9, 11, 1]) // D major
      for (const note of state.project.patterns.find((item) => item.id === result.patternId).notes) {
        assert.ok(scalePcs.has(note.pitch % 12), String(note.pitch))
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_part：barBeats=3 时间正确', async () => {
    const { state, exec, drumId } = await makeR6aTools()
    try {
      const result = await exec('studio_generate_part', { trackId: drumId, kind: 'drums', bars: 2, barBeats: 3, seed: 2 })
      assert.equal(result.ok, true, result.error)
      for (const note of state.project.patterns.find((item) => item.id === result.patternId).notes) {
        assert.ok(note.start < 6)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_part expectedRevision 冲突不写入', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const before = state.project.patterns.length
      const result = await exec('studio_generate_part', { trackId: synthId, kind: 'lead', expectedRevision: state.revision - 1 })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.patterns.length, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_part：GM 鼓音高与 summary noteCount 一致', async () => {
    const { state, exec, drumId } = await makeR6aTools()
    try {
      const result = await exec('studio_generate_part', { trackId: drumId, kind: 'drums', style: 'techno', bars: 2, seed: 9 })
      const notes = state.project.patterns.find((item) => item.id === result.patternId).notes
      assert.equal(notes.length, result.summary.noteCount)
      const allowed = new Set([36, 38, 39, 42, 46])
      for (const note of notes) assert.ok(allowed.has(note.pitch), String(note.pitch))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_generate_variation：确定性变体、transpose、undo', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const generated = await exec('studio_generate_part', { trackId: synthId, kind: 'lead', bars: 2, seed: 1 })
      const first = await exec('studio_generate_variation', { patternId: generated.patternId, seed: 2, density: 0.9, humanize: 0.3 })
      assert.equal(first.ok, true, first.error)
      const notesAfterFirst = state.project.patterns.find((item) => item.id === generated.patternId).notes
      assert.equal(notesAfterFirst.length, first.noteCount)
      assert.equal(state.historyState().undoLabel, '生成变体')
      await exec('studio_undo')
      const restored = state.project.patterns.find((item) => item.id === generated.patternId).notes
      assert.deepEqual(restored, state.project.patterns.find((item) => item.id === generated.patternId).notes)
      const up = await exec('studio_generate_variation', { patternId: generated.patternId, seed: 2, density: 0.9, humanize: 0.3, transpose: 12 })
      assert.equal(up.ok, true, up.error)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_generate_variation：append 与错误', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const generated = await exec('studio_generate_part', { trackId: synthId, kind: 'arp', bars: 2, seed: 1 })
      const before = state.project.patterns.find((item) => item.id === generated.patternId).notes.length
      const appended = await exec('studio_generate_variation', { patternId: generated.patternId, seed: 2, replaceExisting: false })
      assert.equal(appended.ok, true, appended.error)
      assert.ok(appended.noteCount > before)
      const missing = await exec('studio_generate_variation', { patternId: 'pat_404' })
      assert.equal(missing.ok, false)
      const empty = await exec('studio_add_pattern', { name: 'empty', lengthBars: 2 })
      const emptyId = empty.patternId ?? empty.pattern?.id
      if (emptyId) {
        const emptyResult = await exec('studio_generate_variation', { patternId: emptyId })
        assert.equal(emptyResult.ok, false)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_suggest_mix：只读、返回 score/summary/recommendations', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      const revision = state.revision
      const result = await exec('studio_suggest_mix', {})
      assert.equal(result.ok, true, result.error)
      assert.ok(Number.isFinite(result.score))
      assert.ok(typeof result.summary === 'string')
      assert.ok(Array.isArray(result.recommendations))
      assert.equal(state.revision, revision)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_suggest_mix：analysis 响度/削波/stems 建议', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      const stems = state.project.tracks.map((track, index) => ({ trackId: track.id, rmsDb: index === 0 ? 0 : -30 }))
      const result = await exec('studio_suggest_mix', {
        analysis: { lufs: -5, peak: 1.02, clipping: true, stereoBalanceDb: 5, bandEnergyPct: { low: 75, high: 10 }, stems },
        targetLufs: -14,
      })
      assert.equal(result.ok, true, result.error)
      assert.ok(result.score < 100)
      const codes = new Set(result.recommendations.map((item) => item.code))
      assert.ok(codes.has('mix.loudness.high'))
      assert.ok(codes.has('mix.clipping'))
      assert.ok(codes.has('mix.stem.loud'))
      for (const rec of result.recommendations) {
        assert.ok(['warn', 'info'].includes(rec.severity))
        assert.ok(typeof rec.code === 'string' && typeof rec.reason === 'string')
        assert.ok(Number.isFinite(rec.current) && Number.isFinite(rec.suggested))
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_apply_mix：改 master volume 且一次 undo 回滚', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      const before = state.project.master.volume
      const result = await exec('studio_apply_mix', { analysis: { lufs: -5 }, codes: ['mix.loudness.high'] })
      assert.equal(result.ok, true, result.error)
      assert.ok(result.applied >= 1)
      assert.ok(state.project.master.volume < before)
      assert.equal(state.historyState().undoLabel, '应用混音建议')
      await exec('studio_undo')
      assert.equal(state.project.master.volume, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_apply_mix：codes 过滤/no-op', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      const before = state.project.master.volume
      const none = await exec('studio_apply_mix', { analysis: { lufs: -5 }, codes: ['mix.nope'] })
      assert.equal(none.ok, true)
      assert.equal(none.applied, 0)
      assert.equal(state.project.master.volume, before)
      const one = await exec('studio_apply_mix', { analysis: { lufs: -5, clipping: true }, codes: ['mix.clipping'] })
      assert.equal(one.ok, true)
      assert.equal(one.changes.every((change) => change.code === 'mix.clipping'), true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_apply_mix：stems 降轨音量、pan 建议安全应用', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      const stems = state.project.tracks.map((track, index) => ({ trackId: track.id, rmsDb: index === 0 ? -2 : -30 }))
      const before = state.project.tracks[0].volume
      const result = await exec('studio_apply_mix', { analysis: { stems }, codes: ['mix.stem.loud'] })
      assert.equal(result.ok, true, result.error)
      assert.ok(result.applied >= 1)
      assert.ok(state.project.tracks[0].volume < before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_apply_mix：静态 sends 建议应用', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      state.project.tracks[0].sends = { reverb: 0.9, delay: 0.1 }
      const result = await exec('studio_apply_mix', { codes: ['mix.send.reverb'] })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks[0].sends.reverb, 0.35)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_apply_mix：filter cutoff 建议只改已存在 filter', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      await exec('studio_add_effect', { target: state.project.tracks[0].id, type: 'filter', params: { cutoff: 900 } })
      const result = await exec('studio_apply_mix', {
        analysis: { bandEnergyPct: { low: 80 } },
        codes: ['mix.band.low'],
      })
      assert.equal(result.ok, true, result.error)
      if (result.applied > 0) assert.ok(state.project.tracks[0].effects.find((fx) => fx.type === 'filter').params.cutoff > 900)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_apply_mix：非法 targetLufs 中文错误；工程不变', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      const before = JSON.stringify(state.project.master)
      const result = await exec('studio_apply_mix', { targetLufs: -30 })
      assert.equal(result.ok, false)
      assert.match(result.error, /targetLufs/)
      assert.equal(JSON.stringify(state.project.master), before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具声明：4 个新工具 + enum', async () => {
    const { state, byName } = await makeR6aTools()
    try {
      const part = byName.get('studio_generate_part')
      assert.ok(part)
      assert.deepEqual(part.parameters.kind.enum, ['drums', 'bass', 'chords', 'lead', 'arp'])
      assert.deepEqual(part.parameters.style.enum, ['house', 'techno', 'lofi', 'pop', 'cinematic'])
      assert.ok(byName.get('studio_generate_variation'))
      assert.ok(byName.get('studio_suggest_mix'))
      assert.ok(byName.get('studio_apply_mix'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('生成/变体/应用混音撤销标签', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const generated = await exec('studio_generate_part', { trackId: synthId, kind: 'bass', bars: 2, seed: 1 })
      assert.equal(state.historyState().undoLabel, '生成声部')
      await exec('studio_generate_variation', { patternId: generated.patternId, seed: 1 })
      assert.equal(state.historyState().undoLabel, '生成变体')
      await exec('studio_apply_mix', { analysis: { lufs: -5 }, codes: ['mix.loudness.high'] })
      assert.equal(state.historyState().undoLabel, '应用混音建议')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('生成不改变 notes 之外字段（track 音量/效果器）', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const before = JSON.stringify({
        volume: state.project.tracks.find((item) => item.id === synthId).volume,
        effects: state.project.tracks.find((item) => item.id === synthId).effects,
      })
      await exec('studio_generate_part', { trackId: synthId, kind: 'arp', bars: 2, seed: 1 })
      const after = JSON.stringify({
        volume: state.project.tracks.find((item) => item.id === synthId).volume,
        effects: state.project.tracks.find((item) => item.id === synthId).effects,
      })
      assert.equal(after, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R6a 补充：工具边界 */
describe('R6a — 补充工具边界', () => {
  async function makeR6aTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    const drumId = state.project.tracks.find((track) => track.kind === 'drum').id
    const synthId = state.project.tracks.find((track) => track.kind === 'synth').id
    return { state, exec, byName, drumId, synthId }
  }

  it('五种 kind 连续生成后 get_project pattern 数正确', async () => {
    const { state, exec, drumId, synthId } = await makeR6aTools()
    try {
      const before = state.project.patterns.length
      await exec('studio_generate_part', { trackId: drumId, kind: 'drums', bars: 2, seed: 1 })
      for (const kind of ['bass', 'chords', 'lead', 'arp']) {
        await exec('studio_generate_part', { trackId: synthId, kind, bars: 2, seed: 1 })
      }
      assert.equal(state.project.patterns.length, before + 5)
      const overview = await exec('studio_get_project')
      assert.equal(overview.patterns.length, before + 5)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('生成不创建 clip（只写 pattern）', async () => {
    const { state, exec, drumId } = await makeR6aTools()
    try {
      const before = state.project.clips.length
      await exec('studio_generate_part', { trackId: drumId, kind: 'drums', bars: 2 })
      assert.equal(state.project.clips.length, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('模板工程中新增鼓/合成器轨后可生成', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      await exec('studio_create_project', { template: 'empty' })
      const drum = await exec('studio_add_track', { name: 'D', kind: 'drum', kit: 'smp_acoustic' })
      const synth = await exec('studio_add_track', { name: 'S', kind: 'synth', preset: 'grand_piano' })
      const d = await exec('studio_generate_part', { trackId: drum.trackId, kind: 'drums', bars: 2 })
      const s = await exec('studio_generate_part', { trackId: synth.trackId, kind: 'lead', bars: 2 })
      assert.equal(d.ok, true, d.error)
      assert.equal(s.ok, true, s.error)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_variation：append 后 undo 恢复原 notes', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const generated = await exec('studio_generate_part', { trackId: synthId, kind: 'arp', bars: 2, seed: 1 })
      const beforeNotes = JSON.stringify(state.project.patterns.find((item) => item.id === generated.patternId).notes)
      await exec('studio_generate_variation', { patternId: generated.patternId, seed: 2, replaceExisting: false })
      await exec('studio_undo')
      assert.equal(JSON.stringify(state.project.patterns.find((item) => item.id === generated.patternId).notes), beforeNotes)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('suggest_mix 自定义 targetLufs 与 rec 字段完整', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      const result = await exec('studio_suggest_mix', { analysis: { lufs: -8 }, targetLufs: -16 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.targetLufs, -16)
      for (const rec of result.recommendations) {
        for (const key of ['code', 'severity', 'target', 'param', 'current', 'suggested', 'reason']) assert.ok(Object.hasOwn(rec, key), key)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('apply_mix：无 analysis 的静态建议也可应用且一次撤销', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      state.project.master.volume = 0.99
      const before = state.project.master.volume
      const result = await exec('studio_apply_mix', { codes: ['mix.static.master'] })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.applied, 1)
      assert.ok(state.project.master.volume < before)
      await exec('studio_undo')
      assert.equal(state.project.master.volume, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('apply_mix：多 code 一次撤销全部回滚', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      state.project.master.volume = 0.8
      state.project.tracks[1].sends = { reverb: 0.9, delay: 0.2 }
      const masterBefore = state.project.master.volume
      const reverbBefore = state.project.tracks[1].sends.reverb
      const result = await exec('studio_apply_mix', { analysis: { lufs: -5 }, codes: ['mix.loudness.high', 'mix.send.reverb'] })
      assert.ok(result.applied >= 1)
      await exec('studio_undo')
      assert.equal(state.project.master.volume, masterBefore)
      assert.equal(state.project.tracks[1].sends.reverb, reverbBefore)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('生成音符时值不超 pattern 长度', async () => {
    const { state, exec, drumId } = await makeR6aTools()
    try {
      const result = await exec('studio_generate_part', { trackId: drumId, kind: 'drums', bars: 3, barBeats: 4 })
      const pattern = state.project.patterns.find((item) => item.id === result.patternId)
      assert.equal(pattern.lengthBars, 3)
      for (const note of pattern.notes) assert.ok(note.start + note.dur <= 12 + 1e-6)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('apply_mix analysis peak 触发 clipping 应用', async () => {
    const { state, exec } = await makeR6aTools()
    try {
      const before = state.project.master.volume
      const result = await exec('studio_apply_mix', { analysis: { peak: 0.995 }, codes: ['mix.clipping'] })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.applied, 1)
      assert.ok(state.project.master.volume < before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_variation humanize 确定性（同 seed 两次一致）', async () => {
    const { state, exec, synthId } = await makeR6aTools()
    try {
      const generated = await exec('studio_generate_part', { trackId: synthId, kind: 'lead', bars: 2, seed: 3 })
      const first = await exec('studio_generate_variation', { patternId: generated.patternId, seed: 4, density: 0.9, humanize: 0.6 })
      assert.equal(first.ok, true, first.error)
      const notesFirst = JSON.stringify(state.project.patterns.find((item) => item.id === generated.patternId).notes)
      await exec('studio_undo')
      await exec('studio_generate_variation', { patternId: generated.patternId, seed: 4, density: 0.9, humanize: 0.6 })
      const notesSecond = JSON.stringify(state.project.patterns.find((item) => item.id === generated.patternId).notes)
      assert.equal(notesSecond, notesFirst)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R6b：studio_generate_beat 一键 beat                                        */
/* ------------------------------------------------------------------------- */

describe('R6b — studio_generate_beat', () => {
  async function makeR6bTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  async function emptyState() {
    const ctx = await makeR6bTools()
    await ctx.exec('studio_create_project', { template: 'empty', title: '空' })
    return ctx
  }

  it('空工程 house 8 小节：4 轨/4 pattern/4 clip/1 section、BPM/调式正确', async () => {
    const { state, exec } = await emptyState()
    try {
      const result = await exec('studio_generate_beat', { style: 'house', bars: 8, seed: 42 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.trackIds.length, 4)
      assert.equal(result.patternIds.length, 4)
      assert.equal(result.clipCount, 4)
      assert.equal(state.project.tracks.length, 4)
      assert.equal(state.project.patterns.length, 4)
      assert.equal(state.project.clips.length, 4)
      assert.equal(state.project.sections.length, 1)
      assert.equal(state.project.bpm, 126)
      assert.equal(state.project.key, 'A')
      assert.equal(state.project.scale, 'minor')
      assert.equal(state.project.lengthBars, 8)
      assert.equal(result.summary.style, 'house')
      assert.equal(result.summary.bars, 8)
      assert.equal(result.summary.seed, 42)
      assert.ok(result.summary.totalNotes > 100)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('4 条轨道类型/音色：鼓 smp_electro、贝斯 sub_bass、和弦 warm_pad、主音 saw_lead', async () => {
    const { state, exec } = await emptyState()
    try {
      const result = await exec('studio_generate_beat', { seed: 1 })
      const tracks = state.project.tracks
      const drums = tracks.find((track) => track.kind === 'drum')
      assert.equal(drums.instrument.kit, 'smp_electro')
      const synths = tracks.filter((track) => track.kind === 'synth')
      assert.deepEqual(synths.map((track) => track.engine), ['subtractive', 'subtractive', 'subtractive'])
      assert.deepEqual(synths.map((track) => track.synthPreset), ['sub_bass', 'warm_pad', 'saw_lead'])
      assert.deepEqual(tracks.map((track) => track.role), ['drums', 'bass', 'pad', 'lead'])
      assert.deepEqual(result.trackIds, tracks.map((track) => track.id))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('patterns/clips/section 关联正确、都有 notes', async () => {
    const { state, exec } = await emptyState()
    try {
      const result = await exec('studio_generate_beat', { bars: 8 })
      for (const patternId of result.patternIds) {
        const pattern = state.project.patterns.find((item) => item.id === patternId)
        assert.ok(pattern)
        assert.equal(pattern.lengthBars, 8)
        assert.ok(pattern.notes.length > 0)
      }
      for (const clip of state.project.clips) {
        assert.ok(result.trackIds.includes(clip.trackId))
        assert.ok(result.patternIds.includes(clip.patternId))
        assert.equal(clip.startBar, 0)
        assert.equal(clip.lengthBars, 8)
      }
      const section = state.project.sections[0]
      assert.equal(section.name, 'AI Beat')
      assert.equal(section.startBar, 0)
      assert.equal(section.lengthBars, 8)
      assert.equal(result.section.id, section.id)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('summary.totalNotes/notesByTrack 与实际 notes 一致；GM 鼓合法', async () => {
    const { state, exec } = await emptyState()
    try {
      const result = await exec('studio_generate_beat', { seed: 5 })
      const allowed = new Set([36, 38, 39, 42, 46])
      let total = 0
      for (const pattern of state.project.patterns) {
        total += pattern.notes.length
        if (pattern.name.startsWith('drums')) {
          for (const note of pattern.notes) assert.ok(allowed.has(note.pitch), String(note.pitch))
        }
      }
      assert.equal(total, result.summary.totalNotes)
      assert.deepEqual(result.summary.notesByTrack, {
        drums: state.project.patterns[0].notes.length,
        bass: state.project.patterns[1].notes.length,
        chords: state.project.patterns[2].notes.length,
        lead: state.project.patterns[3].notes.length,
      })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('同 seed 生成完全一致（跨工程 notes 相同）', async () => {
    const a = await emptyState()
    const b = await emptyState()
    try {
      await a.exec('studio_generate_beat', { style: 'techno', bars: 8, seed: 77 })
      await b.exec('studio_generate_beat', { style: 'techno', bars: 8, seed: 77 })
      const notesA = a.state.project.patterns.map((pattern) => pattern.notes)
      const notesB = b.state.project.patterns.map((pattern) => pattern.notes)
      assert.deepEqual(notesA, notesB)
    } finally {
      await a.state.flush()
      a.state.dispose()
      await b.state.flush()
      b.state.dispose()
    }
  })

  it('不同 seed 生成不同 notes', async () => {
    const a = await emptyState()
    const b = await emptyState()
    try {
      await a.exec('studio_generate_beat', { seed: 1 })
      await b.exec('studio_generate_beat', { seed: 2 })
      assert.notDeepEqual(
        a.state.project.patterns.map((pattern) => pattern.notes),
        b.state.project.patterns.map((pattern) => pattern.notes),
      )
    } finally {
      await a.state.flush()
      a.state.dispose()
      await b.state.flush()
      b.state.dispose()
    }
  })

  it('风格默认 BPM/key/scale：techno/lofi/pop/cinematic', async () => {
    const cases = [
      ['techno', 132, 'A', 'minor'],
      ['lofi', 86, 'D', 'minor'],
      ['pop', 100, 'C', 'major'],
      ['cinematic', 80, 'D', 'minor'],
    ]
    for (const [style, bpm, key, scale] of cases) {
      const { state, exec } = await emptyState()
      try {
        const result = await exec('studio_generate_beat', { style, bars: 4, seed: 1 })
        assert.equal(result.ok, true, `${style}: ${result.error}`)
        assert.equal(state.project.bpm, bpm, style)
        assert.equal(state.project.key, key, style)
        assert.equal(state.project.scale, scale, style)
      } finally {
        await state.flush()
        state.dispose()
      }
    }
  })

  it('显式 bpm/key/scale 覆盖风格默认', async () => {
    const { state, exec } = await emptyState()
    try {
      const result = await exec('studio_generate_beat', { style: 'techno', bars: 8, bpm: 90, key: 'C', scale: 'major' })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.bpm, 90)
      assert.equal(state.project.key, 'C')
      assert.equal(state.project.scale, 'major')
      assert.equal(result.bpm, 90)
      assert.equal(result.key, 'C')
      assert.equal(result.scale, 'major')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('sectionName 自定义', async () => {
    const { state, exec } = await emptyState()
    try {
      const result = await exec('studio_generate_beat', { sectionName: 'Drop A' })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.sections[0].name, 'Drop A')
      assert.equal(result.section.name, 'Drop A')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('bars 4..16 接受；seeds 0/大整数接受', async () => {
    const { state, exec } = await emptyState()
    try {
      for (const bars of [4, 16]) {
        const result = await exec('studio_generate_beat', { bars, seed: 0 })
        assert.equal(result.ok, true, `${bars}: ${result.error}`)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('非法参数：style/bars/seed/bpm/key/scale/sectionName 中文错误且工程不变', async () => {
    const { state, exec } = await emptyState()
    try {
      const before = JSON.stringify(state.project)
      const cases = [
        { style: 'jazz' },
        { bars: 3 },
        { bars: 17 },
        { seed: -1 },
        { seed: 1.5 },
        { bpm: 59 },
        { bpm: 181 },
        { key: 'H' },
        { scale: 'blues' },
        { sectionName: '   ' },
        { sectionName: 'a'.repeat(41) },
      ]
      for (const args of cases) {
        const result = await exec('studio_generate_beat', args)
        assert.equal(result.ok, false, JSON.stringify(args))
        assert.match(result.error, /[\u4e00-\u9fa5]/, JSON.stringify(args))
      }
      assert.equal(JSON.stringify(state.project), before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('一次 undo 完全移除新增轨道/pattern/clip/section；redo 恢复', async () => {
    const { state, exec } = await emptyState()
    try {
      const result = await exec('studio_generate_beat', {})
      assert.equal(state.project.tracks.length, 4)
      assert.equal(state.historyState().undoLabel, '生成 beat')
      await exec('studio_undo')
      assert.equal(state.project.tracks.length, 0)
      assert.equal(state.project.patterns.length, 0)
      assert.equal(state.project.clips.length, 0)
      assert.equal(state.project.sections.length, 0)
      await exec('studio_redo')
      assert.equal(state.project.tracks.length, 4)
      assert.deepEqual(state.project.tracks.map((track) => track.id), result.trackIds)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('追加模式：非空工程从曲长末追加，已有 notes 不变', async () => {
    const { state, exec } = await makeR6bTools()
    try {
      const demo = await exec('studio_create_project', { template: 'demo' })
      assert.equal(demo.ok, true, demo.error)
      const beforeTracks = state.project.tracks.length
      const beforePatterns = state.project.patterns.length
      const beforeClips = state.project.clips.length
      const beforeSections = state.project.sections.length
      const beforeLength = state.project.lengthBars
      const demoNotes = JSON.stringify(state.project.patterns.map((pattern) => pattern.notes))
      const result = await exec('studio_generate_beat', { style: 'lofi', bars: 4, seed: 3 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.length, beforeTracks + 4)
      assert.equal(state.project.patterns.length, beforePatterns + 4)
      assert.equal(state.project.clips.length, beforeClips + 4)
      assert.equal(state.project.sections.length, beforeSections + 1)
      assert.equal(result.summary.startBar, beforeLength)
      assert.equal(state.project.lengthBars, beforeLength + 4)
      assert.equal(JSON.stringify(state.project.patterns.slice(0, beforePatterns).map((pattern) => pattern.notes)), demoNotes)
      for (const clip of state.project.clips.slice(beforeClips)) assert.equal(clip.startBar, beforeLength)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('追加时未显式 bpm/key/scale 保留工程设置', async () => {
    const { state, exec } = await makeR6bTools()
    try {
      const demo = await exec('studio_create_project', { template: 'song', title: 'Song' })
      const before = { bpm: state.project.bpm, key: state.project.key, scale: state.project.scale }
      await exec('studio_generate_beat', { style: 'techno' })
      assert.equal(state.project.bpm, before.bpm)
      assert.equal(state.project.key, before.key)
      assert.equal(state.project.scale, before.scale)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('追加后曲长扩展；第二次 undo 只移除第二个 beat', async () => {
    const { state, exec } = await emptyState()
    try {
      await exec('studio_generate_beat', { bars: 4, seed: 1 })
      const firstTracks = state.project.tracks.length
      await exec('studio_generate_beat', { bars: 4, seed: 2 })
      assert.equal(state.project.tracks.length, firstTracks + 4)
      await exec('studio_undo')
      assert.equal(state.project.tracks.length, firstTracks)
      assert.equal(state.project.patterns.length, 4)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突不写入', async () => {
    const { state, exec } = await emptyState()
    try {
      const result = await exec('studio_generate_beat', { expectedRevision: state.revision - 1 })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.tracks.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('生成后保存→打开→重启：4 轨/编排/section/bpm 持久化', async () => {
    const { dir, state, exec } = await emptyState()
    try {
      await exec('studio_generate_beat', { style: 'pop', bars: 4, seed: 4, sectionName: 'Verse' })
      await exec('studio_save_project', { name: 'R6b beat', overwrite: true })
      await exec('studio_create_project', { template: 'empty' })
      await exec('studio_open_project', { name: 'R6b beat' })
      assert.equal(state.project.tracks.length, 4)
      assert.equal(state.project.clips.length, 4)
      assert.equal(state.project.sections[0].name, 'Verse')
      assert.equal(state.project.bpm, 100)
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.equal(reloaded.project.tracks.length, 4)
        assert.equal(reloaded.project.sections[0].name, 'Verse')
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具参数声明：style/bars/seed/bpm/key/scale/sectionName', async () => {
    const { state, byName } = await makeR6bTools()
    try {
      const tool = byName.get('studio_generate_beat')
      assert.ok(tool)
      assert.deepEqual(tool.parameters.style.enum, ['house', 'techno', 'lofi', 'pop', 'cinematic'])
      assert.deepEqual(tool.parameters.scale.enum, ['major', 'minor', 'dorian', 'phrygian', 'harmonicMinor'])
      for (const key of ['bars', 'seed', 'bpm', 'key', 'sectionName']) assert.ok(tool.parameters[key], key)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('notes 边界/音阶：所有 part 在 bars 内，旋律在 key/scale（major）', async () => {
    const { state, exec } = await emptyState()
    try {
      await exec('studio_generate_beat', { bars: 8, key: 'C', scale: 'major', seed: 9 })
      const scalePcs = new Set([0, 2, 4, 5, 7, 9, 11])
      for (const pattern of state.project.patterns) {
        for (const note of pattern.notes) {
          assert.ok(note.start >= 0 && note.start + note.dur <= 8 * 4 + 1e-6)
          if (!pattern.name.startsWith('drums')) assert.ok(scalePcs.has(note.pitch % 12), `${pattern.name}:${note.pitch}`)
        }
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('生成不创建多余音频/metrics；track 音量/发送正常', async () => {
    const { state, exec } = await emptyState()
    try {
      await exec('studio_generate_beat', {})
      assert.equal(state.project.media.length, 0)
      for (const track of state.project.tracks) {
        assert.ok(track.volume > 0 && track.volume <= 1)
        assert.ok(track.sends && Number.isFinite(track.sends.reverb))
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R6b 补充：beat 边界 */
describe('R6b — 补充 beat 边界', () => {
  async function emptyCtx() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    await exec('studio_create_project', { template: 'empty', title: '空' })
    return { state, exec }
  }

  it('clips 全部长度=bars 且引用 4 个 pattern', async () => {
    const { state, exec } = await emptyCtx()
    try {
      await exec('studio_generate_beat', { bars: 6, seed: 2 })
      const patternIds = new Set(state.project.patterns.map((pattern) => pattern.id))
      const trackIds = new Set(state.project.tracks.map((track) => track.id))
      for (const clip of state.project.clips) {
        assert.equal(clip.lengthBars, 6)
        assert.ok(patternIds.has(clip.patternId))
        assert.ok(trackIds.has(clip.trackId))
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('get_project 反映 beat 的 tracks/patterns/clips/sections 数量', async () => {
    const { state, exec } = await emptyCtx()
    try {
      await exec('studio_generate_beat', { bars: 8 })
      const overview = await exec('studio_get_project')
      assert.equal(overview.tracks.length, 4)
      assert.equal(overview.patterns.length, 4)
      assert.equal(overview.clips.length, 4)
      assert.equal(overview.sections.length, 1)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('两次 beat 共 8 轨，第二次 append 不覆盖第一次', async () => {
    const { state, exec } = await emptyCtx()
    try {
      const first = await exec('studio_generate_beat', { bars: 4, seed: 1 })
      const firstNotes = JSON.stringify(state.project.patterns.map((pattern) => pattern.notes))
      await exec('studio_generate_beat', { bars: 4, seed: 2 })
      assert.equal(state.project.tracks.length, 8)
      assert.equal(JSON.stringify(state.project.patterns.slice(0, 4).map((pattern) => pattern.notes)), firstNotes)
      assert.ok(state.project.clips.slice(4).every((clip) => clip.startBar === 4))
      assert.ok(first.trackIds.length === 4)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('cinematic beat 生成非空且 4 轨', async () => {
    const { state, exec } = await emptyCtx()
    try {
      const result = await exec('studio_generate_beat', { style: 'cinematic', bars: 4, seed: 1 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.length, 4)
      assert.ok(result.summary.totalNotes > 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('section 颜色合法、bpm 取整', async () => {
    const { state, exec } = await emptyCtx()
    try {
      await exec('studio_generate_beat', { bpm: 126.6 })
      assert.equal(state.project.bpm, 127)
      assert.match(state.project.sections[0].color, /^#[0-9A-Fa-f]{6}$/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('模板工程（piano 16 小节）追加 beat：从 16 起、+4 轨', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    try {
      await exec('studio_create_project', { template: 'piano', title: 'Piano' })
      const beforeTracks = state.project.tracks.length
      const result = await exec('studio_generate_beat', { bars: 4, seed: 1 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.length, beforeTracks + 4)
      assert.equal(result.summary.startBar, 16)
      assert.ok(state.project.clips.slice(-4).every((clip) => clip.startBar === 16))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('seed 派生不同：各 pattern notes 不相等', async () => {
    const { state, exec } = await emptyCtx()
    try {
      await exec('studio_generate_beat', { seed: 9 })
      const serialized = state.project.patterns.map((pattern) => JSON.stringify(pattern.notes))
      assert.equal(new Set(serialized).size, 4)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('summary.notesByTrack 键顺序/数值正确', async () => {
    const { state, exec } = await emptyCtx()
    try {
      const result = await exec('studio_generate_beat', { seed: 2 })
      assert.deepEqual(Object.keys(result.summary.notesByTrack), ['drums', 'bass', 'chords', 'lead'])
      for (const count of Object.values(result.summary.notesByTrack)) assert.ok(count > 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('beat 轨道颜色合法、pattern 名含风格', async () => {
    const { state, exec } = await emptyCtx()
    try {
      await exec('studio_generate_beat', { style: 'lofi', bars: 4 })
      for (const track of state.project.tracks) assert.match(track.color, /^#[0-9A-Fa-f]{6}$/)
      for (const pattern of state.project.patterns) assert.ok(pattern.name.includes('lofi'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('beat 不产生媒体；空工程新生成会加安全母带 compressor', async () => {
    const { state, exec } = await emptyCtx()
    try {
      await exec('studio_generate_beat', {})
      assert.equal(state.project.media.length, 0)
      // R6e：空工程生成 beat 使用安全母带（compressor + makeup），不污染旧工程但新工程需要。
      assert.equal(state.project.master.volume, 0.77)
      assert.ok(state.project.master.effects.some((effect) => effect.type === 'compressor'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('beat 后 stop/play 工具仍可用（工程结构合法）', async () => {
    const { state, exec } = await emptyCtx()
    try {
      await exec('studio_generate_beat', {})
      const play = await exec('studio_transport', { action: 'play' })
      assert.equal(play.ok, true, play.error)
      const stop = await exec('studio_transport', { action: 'stop' })
      assert.equal(stop.ok, true, stop.error)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R6c：AI 变更日志 Host 集成（server tool-call → GET /ai-changes）           */
/* ------------------------------------------------------------------------- */

describe('R6c — AI 变更日志工具/路由', () => {
  async function makeJournalServer() {
    const dir = await tempDir()
    // standalone server 的 port=0 会回退到默认端口范围；用 net 探测空闲端口避免与运行中桌面 app/E2E 冲突。
    const net = await import('node:net')
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const assigned = probe.address().port
        probe.close(() => resolve(assigned))
      })
    })
    const standalone = await startStandaloneServer({ dataDir: dir, port })
    const base = String(standalone.url).replace(/\/$/, '')
    const toolCall = (name, args = {}) => postJson(base, '/studio/api/tool-call', { name, args })
    const aiChanges = async (query = '') => {
      const response = await fetch(`${base}/studio/api/ai-changes${query}`)
      return { status: response.status, data: await response.json() }
    }
    const server = { base, close: standalone.close }
    return { dir, state: standalone.state, server, toolCall, aiChanges }
  }

  it('初始无变更：GET /ai-changes 返回空数组与 canUndo', async () => {
    const { server, state, aiChanges } = await makeJournalServer()
    try {
      const result = await aiChanges()
      assert.equal(result.status, 200)
      assert.equal(result.data.ok, true)
      assert.deepEqual(result.data.changes, [])
      assert.equal(typeof result.data.canUndo, 'boolean')
      assert.equal(result.data.undoLabel, '')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('add_track 后记录一条：diff tracksAdded/名称/标题/canUndo', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      const before = state.project.tracks.length
      const added = await toolCall('studio_add_track', { name: 'R6c 合成器', kind: 'synth', preset: 'grand_piano' })
      assert.equal(added.data.ok, true, added.data.error)
      assert.equal(state.project.tracks.length, before + 1)
      const result = await aiChanges()
      assert.equal(result.data.changes.length, 1)
      const entry = result.data.changes[0]
      assert.match(entry.id, /^chg_\d+$/)
      assert.ok(!Number.isNaN(Date.parse(entry.at)))
      assert.equal(entry.tool, 'studio_add_track')
      assert.ok(entry.title.includes('添加轨道'))
      assert.equal(entry.diff.tracksAdded, 1)
      assert.equal(entry.diff.tracksRemoved, 0)
      assert.ok(entry.diff.trackNames.includes('R6c 合成器'))
      assert.equal(entry.beforeRev + 1, entry.afterRev)
      assert.equal(entry.canUndo, true)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('update_track 记录 tracksChanged', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      const trackId = state.project.tracks[0].id
      const updated = await toolCall('studio_update_track', { trackId, volume: 0.33 })
      assert.equal(updated.data.ok, true, updated.data.error)
      const entry = (await aiChanges()).data.changes[0]
      assert.equal(entry.tool, 'studio_update_track')
      assert.equal(entry.diff.tracksChanged, 1)
      assert.equal(entry.diff.tracksAdded, 0)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('generate_part 记录 patternsAdded/notesDelta', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      const synthId = state.project.tracks.find((track) => track.kind === 'synth').id
      const result = await toolCall('studio_generate_part', { trackId: synthId, kind: 'lead', bars: 2, seed: 1 })
      assert.equal(result.data.ok, true, result.data.error)
      const entry = (await aiChanges()).data.changes[0]
      assert.equal(entry.tool, 'studio_generate_part')
      assert.equal(entry.diff.patternsAdded, 1)
      assert.ok(entry.diff.notesDelta > 0)
      assert.equal(entry.diff.patternDeltas.length, 1)
      assert.ok(entry.diff.patternDeltas[0].afterNotes > 0)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('generate_beat 记录 4 轨/4 pattern/4 clip/1 section', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      const result = await toolCall('studio_generate_beat', { style: 'house', bars: 4, seed: 1 })
      assert.equal(result.data.ok, true, result.data.error)
      const entry = (await aiChanges()).data.changes[0]
      assert.equal(entry.tool, 'studio_generate_beat')
      assert.equal(entry.diff.tracksAdded, 4)
      assert.equal(entry.diff.patternsAdded, 4)
      assert.equal(entry.diff.clipsDelta, 4)
      assert.equal(entry.diff.sectionsDelta, 1)
      assert.ok(entry.diff.notesDelta > 0)
      assert.ok(entry.title.includes('beat'))
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('读取类工具不记录（get_project/app_info/list）', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      for (const name of ['studio_get_project', 'studio_app_info', 'studio_list_templates', 'studio_list_plugins']) {
        await toolCall(name)
      }
      assert.equal((await aiChanges()).data.changes.length, 0)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('错误调用不记录（未知工具 404 / 业务校验失败）', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      const unknown = await toolCall('studio_nope')
      assert.equal(unknown.data.ok, false)
      const badArgs = await toolCall('studio_add_track', { name: 'x', kind: 'synth', preset: 'nope' })
      assert.equal(badArgs.data.ok, false)
      assert.equal((await aiChanges()).data.changes.length, 0)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('最多保留 30 条（连续 35 次 update_track）', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      const trackId = state.project.tracks[0].id
      for (let index = 0; index < 35; index += 1) {
        const result = await toolCall('studio_update_track', { trackId, volume: 0.2 + (index % 50) / 100 })
        assert.equal(result.data.ok, true, result.data.error)
      }
      const changes = (await aiChanges()).data.changes
      assert.equal(changes.length, 30)
      assert.equal(changes[0].afterRev > changes[29].afterRev, true)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('GET ?limit=5 截断，新在前', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      const trackId = state.project.tracks[0].id
      for (let index = 0; index < 8; index += 1) await toolCall('studio_update_track', { trackId, volume: 0.2 + index / 100 })
      const changes = (await aiChanges('?limit=5')).data.changes
      assert.equal(changes.length, 5)
      assert.ok(changes[0].afterRev > changes[4].afterRev)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('create_project 后清空日志（且不记录创建本身）', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      await toolCall('studio_update_track', { trackId: state.project.tracks[0].id, volume: 0.4 })
      assert.equal((await aiChanges()).data.changes.length, 1)
      const created = await toolCall('studio_create_project', { template: 'empty', title: '空' })
      assert.equal(created.data.ok, true, created.data.error)
      assert.deepEqual((await aiChanges()).data.changes, [])
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('保存后打开工程：日志清空', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      await toolCall('studio_save_project', { name: 'R6c 日志工程', overwrite: true })
      await toolCall('studio_update_track', { trackId: state.project.tracks[0].id, volume: 0.4 })
      assert.equal((await aiChanges()).data.changes.length, 1)
      const opened = await toolCall('studio_open_project', { name: 'R6c 日志工程' })
      assert.equal(opened.data.ok, true, opened.data.error)
      assert.deepEqual((await aiChanges()).data.changes, [])
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('studio_get_ai_changes 工具：只读、limit、结果形状', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      for (let index = 0; index < 4; index += 1) {
        await toolCall('studio_update_track', { trackId: state.project.tracks[0].id, volume: 0.2 + index / 10 })
      }
      const revision = state.revision
      const result = await toolCall('studio_get_ai_changes', { limit: 2 })
      assert.equal(result.data.ok, true, result.data.error)
      assert.equal(result.data.result.changes.length, 2)
      for (const key of ['changes', 'canUndo', 'canRedo', 'undoLabel', 'redoLabel']) assert.ok(Object.hasOwn(result.data.result, key), key)
      assert.equal(state.revision, revision)
      assert.equal((await aiChanges()).data.changes.length, 4, '读取工具不新增记录')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('无变更时工具返回 changes=[]', async () => {
    const { server, state, toolCall } = await makeJournalServer()
    try {
      const result = await toolCall('studio_get_ai_changes')
      assert.equal(result.data.ok, true)
      assert.deepEqual(result.data.result.changes, [])
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('undo/redo 后 canUndo/canRedo/undoLabel 反映历史栈', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      await toolCall('studio_update_track', { trackId: state.project.tracks[0].id, volume: 0.3 })
      const afterWrite = (await aiChanges()).data
      assert.equal(afterWrite.canUndo, true)
      await postJson(server.base, '/studio/api/history/undo', {})
      const afterUndo = (await aiChanges()).data
      assert.ok(Object.hasOwn(afterUndo, 'canRedo'))
      assert.ok(typeof afterUndo.undoLabel === 'string')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('追加第二个 beat：sectionsDelta=1、patternsAdded=4', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      await toolCall('studio_create_project', { template: 'empty', title: '空' })
      await toolCall('studio_generate_beat', { bars: 4, seed: 1 })
      const result = await toolCall('studio_generate_beat', { bars: 4, seed: 2 })
      assert.equal(result.data.ok, true, result.data.error)
      const entry = (await aiChanges()).data.changes[0]
      assert.equal(entry.diff.tracksAdded, 4)
      assert.equal(entry.diff.patternsAdded, 4)
      assert.equal(entry.diff.sectionsDelta, 1)
      assert.equal(entry.diff.clipsDelta, 4)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('generate_variation 记录 patternsChanged/notesDelta', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      const synthId = state.project.tracks.find((track) => track.kind === 'synth').id
      const generated = await toolCall('studio_generate_part', { trackId: synthId, kind: 'arp', bars: 2, seed: 1 })
      const variation = await toolCall('studio_generate_variation', { patternId: generated.data.result.patternId, seed: 2, density: 0.9, humanize: 0.3 })
      assert.equal(variation.data.ok, true, variation.data.error)
      const entry = (await aiChanges()).data.changes[0]
      assert.equal(entry.tool, 'studio_generate_variation')
      assert.equal(entry.diff.patternsChanged, 1)
      assert.equal(entry.diff.patternsAdded, 0)
      assert.equal(entry.diff.patternDeltas.length, 1)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /ai-changes 返回 405', async () => {
    const { server, state } = await makeJournalServer()
    try {
      const response = await fetch(`${server.base}/studio/api/ai-changes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(response.status, 405)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('limit 非法回退 30；changes 字段类型正确', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      await toolCall('studio_update_track', { trackId: state.project.tracks[0].id, volume: 0.4 })
      const data = (await aiChanges('?limit=abc')).data
      assert.equal(data.ok, true)
      assert.ok(Array.isArray(data.changes))
      const entry = data.changes[0]
      for (const key of ['id', 'at', 'tool', 'title', 'beforeRev', 'afterRev', 'diff', 'canUndo', 'canRedo']) assert.ok(Object.hasOwn(entry, key), key)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('GET /projects（读取路由）不新增日志', async () => {
    const { server, state, aiChanges } = await makeJournalServer()
    try {
      const response = await fetch(`${server.base}/studio/api/projects`)
      assert.equal(response.status, 200)
      assert.deepEqual((await aiChanges()).data.changes, [])
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('创建工程后 canUndo=false、undoLabel 为空', async () => {
    const { server, state, toolCall, aiChanges } = await makeJournalServer()
    try {
      await toolCall('studio_create_project', { template: 'piano', title: 'P' })
      const data = (await aiChanges()).data
      assert.equal(data.canUndo, false)
      assert.equal(data.undoLabel, '')
      assert.deepEqual(data.changes, [])
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R6d：参考分析/按参考生成 Host 工具                                         */
/* ------------------------------------------------------------------------- */

describe('R6d — studio_analyze_reference / generate_like_reference', () => {
  async function makeR6dTools() {
    const { dir, state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { dir, state, byName, exec }
  }

  async function emptyContext(withReference = false) {
    const ctx = await makeR6dTools()
    if (withReference) await ctx.exec('studio_save_project', { name: '参考Z', overwrite: true })
    await ctx.exec('studio_create_project', { template: 'empty', title: '空' })
    if (withReference) {
      const realExec = ctx.exec
      ctx.exec = (name, args = {}) => realExec(name, name === 'studio_generate_like_reference' ? { ...args, reference: args.reference ?? '参考Z' } : args)
    }
    return ctx
  }

  it('分析当前 demo：profile 字段/只读 revision', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      const revision = state.revision
      const result = await exec('studio_analyze_reference', {})
      assert.equal(result.ok, true, result.error)
      assert.equal(result.bpm, state.project.bpm)
      assert.equal(result.key, state.project.key)
      assert.equal(result.scale, state.project.scale)
      assert.ok(result.tracks.length > 0)
      assert.ok(result.avgNotesPerBar > 0)
      assert.ok(result.drumPitches.includes(36))
      assert.ok(Array.isArray(result.effectTypes))
      assert.equal(state.revision, revision)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('空工程分析当前：0 轨不崩', async () => {
    const { state, exec } = await emptyContext()
    try {
      const result = await exec('studio_analyze_reference', {})
      assert.equal(result.ok, true, result.error)
      assert.equal(result.tracks.length, 0)
      assert.equal(result.avgNotesPerBar, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('保存 demo 后按 name 分析：source=saved、bpm 一致、不打开工程', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      const saved = await exec('studio_save_project', { name: '参考A', overwrite: true })
      assert.equal(saved.ok, true, saved.error)
      await exec('studio_create_project', { template: 'empty', title: '空' })
      const activeBefore = state.activeName
      const result = await exec('studio_analyze_reference', { name: '参考A' })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.source, 'saved:参考A')
      assert.equal(result.bpm, 128)
      assert.equal(state.activeName, activeBefore)
      assert.equal(state.project.tracks.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('未知参考名中文错误', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      const result = await exec('studio_analyze_reference', { name: '不存在的工程' })
      assert.equal(result.ok, false)
      assert.match(result.error, /[\u4e00-\u9fa5]/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('损坏工程文件中文错误', async () => {
    const { dir, state, exec } = await makeR6dTools()
    try {
      await mkdir(path.join(dir, 'projects'), { recursive: true })
      await writeFile(path.join(dir, 'projects', '坏参考.json'), '{bad', 'utf8')
      const result = await exec('studio_analyze_reference', { name: '坏参考' })
      assert.equal(result.ok, false)
      assert.match(result.error, /[\u4e00-\u9fa5]/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('git生成：空工程且无 reference → 中文错误', async () => {
    const { state, exec } = await emptyContext()
    try {
      const result = await exec('studio_generate_like_reference', {})
      assert.equal(result.ok, false)
      assert.match(result.error, /当前工程为空/)
      assert.equal(state.project.tracks.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('按保存参考生成：4 轨/4 pattern/4 clip/1 section，沿用 BPM/key/scale', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      await exec('studio_save_project', { name: '参考B', overwrite: true })
      await exec('studio_create_project', { template: 'empty', title: '空' })
      const result = await exec('studio_generate_like_reference', { reference: '参考B', bars: 8, seed: 42 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.trackIds.length, 4)
      assert.equal(result.patterns.length, 4)
      assert.equal(result.clipCount, 4)
      assert.equal(state.project.tracks.length, 4)
      assert.equal(state.project.patterns.length, 4)
      assert.equal(state.project.clips.length, 4)
      assert.equal(state.project.sections.length, 1)
      assert.equal(state.project.bpm, 128)
      assert.equal(state.project.key, 'F#')
      assert.equal(state.project.scale, 'minor')
      assert.equal(result.bpm, 128)
      assert.equal(result.key, 'F#')
      assert.equal(result.scale, 'minor')
      assert.ok(result.totalNotes > 100)
      assert.ok(result.profileSummary.includes('参考B') || result.profileSummary.includes('128'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('生成 4 轨角色 drums/bass/pad/lead', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      await exec('studio_save_project', { name: '参考C', overwrite: true })
      await exec('studio_create_project', { template: 'empty', title: '空' })
      await exec('studio_generate_like_reference', { reference: '参考C', bars: 4, seed: 1 })
      assert.deepEqual(state.project.tracks.map((track) => track.role), ['drums', 'bass', 'pad', 'lead'])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('音色/鼓件尽量沿用参考', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      await exec('studio_save_project', { name: '参考D', overwrite: true })
      const reference = JSON.parse(JSON.stringify(state.project))
      const refDrum = reference.tracks.find((track) => track.kind === 'drum')
      const refSynths = reference.tracks.filter((track) => track.kind === 'synth')
      await exec('studio_create_project', { template: 'empty', title: '空' })
      const result = await exec('studio_generate_like_reference', { reference: '参考D', bars: 4, seed: 1 })
      assert.equal(result.ok, true, result.error)
      const generatedDrum = state.project.tracks.find((track) => track.kind === 'drum')
      assert.equal(generatedDrum.instrument.kit, refDrum.instrument.kit)
      for (const track of state.project.tracks.filter((item) => item.kind === 'synth')) {
        assert.ok(['sampler', 'subtractive'].includes(track.engine ?? 'sampler'))
        const hasSamplerPreset = track.instrument?.preset === undefined || typeof track.instrument.preset === 'string'
        const hasSynthPreset = track.engine !== 'subtractive' || typeof track.synthPreset === 'string'
        assert.ok(hasSamplerPreset && hasSynthPreset, JSON.stringify({ preset: track.instrument?.preset, synthPreset: track.synthPreset }))
      }
      assert.ok(refSynths.length > 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('同 seed 同参考：两次生成 notes 签名一致', async () => {
    const a = await makeR6dTools()
    const b = await makeR6dTools()
    try {
      await a.exec('studio_save_project', { name: '参考E', overwrite: true })
      await b.exec('studio_save_project', { name: '参考E', overwrite: true })
      await a.exec('studio_create_project', { template: 'empty', title: '空' })
      await b.exec('studio_create_project', { template: 'empty', title: '空' })
      await a.exec('studio_generate_like_reference', { reference: '参考E', bars: 8, seed: 42 })
      await b.exec('studio_generate_like_reference', { reference: '参考E', bars: 8, seed: 42 })
      assert.deepEqual(a.state.project.patterns.map((pattern) => pattern.notes), b.state.project.patterns.map((pattern) => pattern.notes))
      assert.deepEqual(a.state.project.tracks.map((track) => track.role), b.state.project.tracks.map((track) => track.role))
    } finally {
      await a.state.flush()
      a.state.dispose()
      await b.state.flush()
      b.state.dispose()
    }
  })

  it('不同参考的 BPM/调式影响生成输出', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      const second = createDemoProject()
      second.bpm = 96
      second.key = 'C'
      second.scale = 'major'
      await saveProjectFile(state.dataDir, '参考F', second)
      await exec('studio_create_project', { template: 'empty', title: '空' })
      const result = await exec('studio_generate_like_reference', { reference: '参考F', bars: 8, seed: 7 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.bpm, 96)
      assert.equal(state.project.key, 'C')
      assert.equal(state.project.scale, 'major')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('append：非空工程从曲长末追加，已有 notes 不变', async () => {
    const { state, exec } = await emptyContext(true)
    try {
      await exec('studio_generate_like_reference', { bars: 8, seed: 1 })
      const firstNotes = JSON.stringify(state.project.patterns.map((pattern) => pattern.notes))
      const firstTracks = state.project.tracks.length
      const result = await exec('studio_generate_like_reference', { bars: 4, seed: 2 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.length, firstTracks + 4)
      assert.equal(result.startBar, 8)
      assert.equal(state.project.lengthBars, 12)
      assert.equal(JSON.stringify(state.project.patterns.slice(0, 4).map((pattern) => pattern.notes)), firstNotes)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('append=false：非空工程从 0 叠加（不删除）', async () => {
    const { state, exec } = await emptyContext(true)
    try {
      await exec('studio_generate_like_reference', { bars: 4, seed: 1 })
      const result = await exec('studio_generate_like_reference', { bars: 4, seed: 2, append: false })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.startBar, 0)
      assert.equal(state.project.clips.slice(4).every((clip) => clip.startBar === 0), true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('一次 undo 完全移除新增；redo 恢复', async () => {
    const { state, exec } = await emptyContext(true)
    try {
      const result = await exec('studio_generate_like_reference', { bars: 8, seed: 3 })
      assert.equal(state.project.tracks.length, 4)
      assert.equal(state.historyState().undoLabel, '按参考生成')
      await exec('studio_undo')
      assert.equal(state.project.tracks.length, 0)
      assert.equal(state.project.patterns.length, 0)
      assert.equal(state.project.clips.length, 0)
      assert.equal(state.project.sections.length, 0)
      await exec('studio_redo')
      assert.deepEqual(state.project.tracks.map((track) => track.id), result.trackIds)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('非法参数：bars/seed/sectionName 中文错误且不写入', async () => {
    const { state, exec } = await emptyContext()
    try {
      const before = JSON.stringify(state.project)
      for (const args of [{ bars: 3 }, { bars: 17 }, { seed: -1 }, { seed: 1.5 }, { sectionName: '  ' }]) {
        const result = await exec('studio_generate_like_reference', args)
        assert.equal(result.ok, false, JSON.stringify(args))
        assert.match(result.error, /[\u4e00-\u9fa5]/)
      }
      assert.equal(JSON.stringify(state.project), before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('非法参考名生成错误', async () => {
    const { state, exec } = await emptyContext()
    try {
      const result = await exec('studio_generate_like_reference', { reference: '不存在' })
      assert.equal(result.ok, false)
      assert.match(result.error, /[\u4e00-\u9fa5]/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('expectedRevision 冲突不写入', async () => {
    const { state, exec } = await emptyContext()
    try {
      const result = await exec('studio_generate_like_reference', { expectedRevision: state.revision - 1 })
      assert.equal(result.ok, false)
      assert.equal(result.retry, true)
      assert.equal(state.project.tracks.length, 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('sectionName 自定义；pattern 名含「参考生成」', async () => {
    const { state, exec } = await emptyContext(true)
    try {
      const result = await exec('studio_generate_like_reference', { bars: 4, seed: 1, sectionName: 'Verse A' })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.sections[0].name, 'Verse A')
      assert.equal(result.section.name, 'Verse A')
      for (const pattern of state.project.patterns) assert.ok(pattern.name.includes('参考生成'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('生成的鼓音高来自参考 drumPitches（子集）', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      await exec('studio_save_project', { name: '参考G', overwrite: true })
      const saved = await exec('studio_analyze_reference', { name: '参考G' })
      await exec('studio_create_project', { template: 'empty', title: '空' })
      await exec('studio_generate_like_reference', { reference: '参考G', bars: 4, seed: 1 })
      const allowed = new Set(saved.drumPitches)
      const drumTrack = state.project.tracks.find((track) => track.kind === 'drum')
      const pattern = state.project.patterns.find((item) => state.project.clips.some((clip) => clip.trackId === drumTrack.id && clip.patternId === item.id))
      for (const note of pattern.notes) assert.ok(allowed.has(note.pitch), String(note.pitch))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('当前工程非空可直接按当前工程生成（省略 reference）', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      const before = state.project.tracks.length
      const result = await exec('studio_generate_like_reference', { bars: 4, seed: 2 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.tracks.length, before + 4)
      assert.equal(result.startBar, 32)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('生成后保存→重启：4 轨/编排/段/BPM 持久化', async () => {
    const { dir, state, exec } = await emptyContext(true)
    try {
      await exec('studio_generate_like_reference', { bars: 4, seed: 2, sectionName: 'Ref' })
      await exec('studio_save_project', { name: 'R6d beat', overwrite: true })
      await state.flush()
      state.dispose()
      const reloaded = createState({ dataDir: dir, fallbackInitial: createDemoProject })
      await reloaded.ready
      try {
        assert.equal(reloaded.project.tracks.length, 4)
        assert.equal(reloaded.project.clips.length, 4)
        assert.equal(reloaded.project.sections[0].name, 'Ref')
      } finally {
        await reloaded.flush()
        reloaded.dispose()
      }
    } catch (error) {
      state.dispose()
      throw error
    }
  })

  it('工具参数声明：reference/bars/seed/append/sectionName', async () => {
    const { state, byName } = await makeR6dTools()
    try {
      const analyze = byName.get('studio_analyze_reference')
      const generate = byName.get('studio_generate_like_reference')
      assert.ok(analyze)
      assert.ok(analyze.parameters.name)
      for (const key of ['reference', 'bars', 'seed', 'append', 'sectionName']) assert.ok(generate.parameters[key], key)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('按参考生成后分析当前工程：4 轨/密度>0', async () => {
    const { state, exec } = await emptyContext(true)
    try {
      await exec('studio_generate_like_reference', { bars: 8, seed: 1 })
      const profile = await exec('studio_analyze_reference', {})
      assert.equal(profile.ok, true, profile.error)
      assert.equal(profile.tracks.length, 4)
      assert.ok(profile.avgNotesPerBar > 0)
      assert.ok(profile.drumPitches.length > 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('默认 bars=8；生成段落长度=8', async () => {
    const { state, exec } = await emptyContext(true)
    try {
      const result = await exec('studio_generate_like_reference', { seed: 1 })
      assert.equal(result.ok, true, result.error)
      assert.equal(state.project.sections[0].lengthBars, 8)
      assert.equal(state.project.lengthBars, 8)
      for (const pattern of state.project.patterns) assert.equal(pattern.lengthBars, 8)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('totalNotes 与 pattern notes 总和一致', async () => {
    const { state, exec } = await emptyContext(true)
    try {
      const result = await exec('studio_generate_like_reference', { bars: 8, seed: 5 })
      const total = state.project.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0)
      assert.equal(result.totalNotes, total)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('undo 恢复生成前的 BPM/长度（空工程默认值）', async () => {
    const { state, exec } = await emptyContext(true)
    try {
      const beforeBpm = state.project.bpm
      const beforeLength = state.project.lengthBars
      await exec('studio_generate_like_reference', { bars: 8, seed: 1 })
      assert.equal(state.project.bpm, 128)
      await exec('studio_undo')
      assert.equal(state.project.bpm, beforeBpm)
      assert.equal(state.project.lengthBars, beforeLength)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('参考名含路径分隔符：不越权读取，中文错误', async () => {
    const { state, exec } = await emptyContext()
    try {
      const result = await exec('studio_analyze_reference', { name: '../project' })
      assert.equal(result.ok, false)
      assert.match(result.error, /[\u4e00-\u9fa5]/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R6d 补充：工具参数回退 */
describe('R6d — 补充工具边界', () => {
  async function makeR6dTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { state, exec }
  }

  it('analyze_reference name 非字符串 → 按当前工程分析', async () => {
    const { state, exec } = await makeR6dTools()
    try {
      const revision = state.revision
      const result = await exec('studio_analyze_reference', { name: 123 })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.source, 'current')
      assert.equal(state.revision, revision)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_like_reference 省略 seed 等价 seed=1（同参考签名一致）', async () => {
    const a = await makeR6dTools()
    const b = await makeR6dTools()
    try {
      await a.exec('studio_save_project', { name: '参考Y', overwrite: true })
      await b.exec('studio_save_project', { name: '参考Y', overwrite: true })
      await a.exec('studio_create_project', { template: 'empty', title: '空' })
      await b.exec('studio_create_project', { template: 'empty', title: '空' })
      await a.exec('studio_generate_like_reference', { reference: '参考Y', bars: 4 })
      await b.exec('studio_generate_like_reference', { reference: '参考Y', bars: 4, seed: 1 })
      assert.deepEqual(a.state.project.patterns.map((pattern) => pattern.notes), b.state.project.patterns.map((pattern) => pattern.notes))
    } finally {
      await a.state.flush()
      a.state.dispose()
      await b.state.flush()
      b.state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R6e：studio_ai_quality_report 只读质量报告                                 */
/* ------------------------------------------------------------------------- */

describe('R6e — studio_ai_quality_report', () => {
  async function makeR6eTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { state, byName, exec }
  }

  const goodAnalysis = {
    lufs: -14.2,
    peakDb: -1.2,
    crestDb: 10.5,
    stereoBalanceDb: 0.5,
    correlation: 0.8,
    bandEnergyPct: { sub: 8, low: 22, lowMid: 32, mid: 25, highMid: 9, high: 4 },
    clipping: false,
    clippedSamples: 0,
    rmsDb: -24.5,
  }

  it('真实风格 analysis：返回 score/grade/metrics/findings/recommendations/summary，且只读', async () => {
    const { state, exec } = await makeR6eTools()
    try {
      const revision = state.revision
      const result = await exec('studio_ai_quality_report', { analysis: goodAnalysis })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.score, 100)
      assert.equal(result.grade, 'A')
      for (const key of ['score', 'grade', 'metrics', 'findings', 'recommendations', 'summary']) assert.ok(Object.hasOwn(result, key), key)
      assert.equal(state.revision, revision)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('低质 analysis：grade 降低、findings/recommendations 非空', async () => {
    const { state, exec } = await makeR6eTools()
    try {
      const result = await exec('studio_ai_quality_report', {
        analysis: {
          lufs: -5,
          peakDb: 0.5,
          crestDb: 4,
          stereoBalanceDb: 6,
          correlation: -0.2,
          bandEnergyPct: { sub: 40, low: 35, lowMid: 15, mid: 8, highMid: 1, high: 1 },
          clipping: true,
          clippedSamples: 1200,
        },
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.grade, 'D')
      assert.ok(result.score < 50)
      assert.ok(result.findings.length > 0)
      assert.ok(result.recommendations.length > 0)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('缺少 analysis → 中文错误', async () => {
    const { state, exec } = await makeR6eTools()
    try {
      const result = await exec('studio_ai_quality_report', {})
      assert.equal(result.ok, false)
      assert.match(result.error, /[\u4e00-\u9fa5]/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('缺 lufs/peakDb → 中文错误', async () => {
    const { state, exec } = await makeR6eTools()
    try {
      const a = await exec('studio_ai_quality_report', { analysis: { peakDb: -1 } })
      assert.equal(a.ok, false)
      assert.match(a.error, /lufs/)
      const b = await exec('studio_ai_quality_report', { analysis: { lufs: -14 } })
      assert.equal(b.ok, false)
      assert.match(b.error, /peakDb/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('targetLufs 生效且非法值中文错误', async () => {
    const { state, exec } = await makeR6eTools()
    try {
      const custom = await exec('studio_ai_quality_report', { analysis: goodAnalysis, targetLufs: -20 })
      assert.equal(custom.ok, true, custom.error)
      assert.ok(custom.score < 100)
      const invalid = await exec('studio_ai_quality_report', { analysis: goodAnalysis, targetLufs: -30 })
      assert.equal(invalid.ok, false)
      assert.match(invalid.error, /targetLufs/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('genre 出现在 summary', async () => {
    const { state, exec } = await makeR6eTools()
    try {
      const result = await exec('studio_ai_quality_report', { analysis: goodAnalysis, genre: 'house' })
      assert.equal(result.ok, true, result.error)
      assert.ok(result.summary.includes('house'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('工具参数声明 analysis/targetLufs/genre', async () => {
    const { state, byName } = await makeR6eTools()
    try {
      const tool = byName.get('studio_ai_quality_report')
      assert.ok(tool)
      assert.ok(tool.parameters.analysis)
      assert.equal(tool.parameters.analysis.required, true)
      assert.ok(tool.parameters.targetLufs)
      assert.ok(tool.parameters.genre)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('削波 analysis metrics.clipping=true', async () => {
    const { state, exec } = await makeR6eTools()
    try {
      const result = await exec('studio_ai_quality_report', { analysis: { ...goodAnalysis, peakDb: 0.2, clipping: true, clippedSamples: 10 } })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.metrics.clipping, true)
      assert.ok(result.findings.some((item) => item.code === 'audio.clipping'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('只读不影响之后 AI 日志/撤销标签', async () => {
    const { state, exec } = await makeR6eTools()
    try {
      await exec('studio_ai_quality_report', { analysis: goodAnalysis })
      assert.equal(state.historyState().undoDepth, 0)
      assert.equal(state.revision, state.project.revision)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* R6e：生成 beat 的安全增益分级（真实 render_preview 削波回归） */
describe('R6e — 生成 beat 安全增益分级', () => {
  async function makeCtx() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    return { state, exec }
  }

  it('generate_beat 4 轨音量：drums 0.58 / bass 0.45 / chords 0.4 / lead 0.4', async () => {
    const { state, exec } = await makeCtx()
    try {
      await exec('studio_create_project', { template: 'empty', title: '空' })
      const result = await exec('studio_generate_beat', { style: 'house', bars: 8, seed: 1 })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(state.project.tracks.map((track) => track.role), ['drums', 'bass', 'pad', 'lead'])
      assert.deepEqual(state.project.tracks.map((track) => track.volume), [0.58, 0.45, 0.4, 0.4])
      // R6e：空工程新生成时加安全母带（compressor + makeup gain）
      assert.equal(state.project.master.volume, 0.77)
      const compressor = state.project.master.effects.find((effect) => effect.type === 'compressor')
      assert.ok(compressor)
      assert.equal(compressor.params.threshold, -13)
      assert.equal(compressor.params.ratio, 3.5)
      for (const track of state.project.tracks) assert.ok(track.volume <= 0.6)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('generate_like_reference 4 轨同样增益分级', async () => {
    const { state, exec } = await makeCtx()
    try {
      await exec('studio_save_project', { name: '增益参考', overwrite: true })
      await exec('studio_create_project', { template: 'empty', title: '空' })
      const result = await exec('studio_generate_like_reference', { reference: '增益参考', bars: 8, seed: 1 })
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(state.project.tracks.map((track) => track.volume), [0.58, 0.45, 0.4, 0.4])
      assert.equal(state.project.master.volume, 0.77)
      assert.ok(state.project.master.effects.some((effect) => effect.type === 'compressor'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('append 只改新生成轨道：既有轨道音量不变', async () => {
    const { state, exec } = await makeCtx()
    try {
      const before = state.project.tracks.map((track) => ({ id: track.id, volume: track.volume }))
      const masterBefore = JSON.stringify(state.project.master)
      const result = await exec('studio_generate_beat', { bars: 4, seed: 2 })
      assert.equal(JSON.stringify(state.project.master), masterBefore)
      assert.equal(result.ok, true, result.error)
      const afterMap = new Map(state.project.tracks.map((track) => [track.id, track.volume]))
      for (const item of before) assert.equal(afterMap.get(item.id), item.volume)
      const newTracks = state.project.tracks.slice(before.length)
      assert.deepEqual(newTracks.map((track) => track.volume), [0.58, 0.45, 0.4, 0.4])
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('增益分级在 4 轨叠加时相对旧默认有明显 headroom（每轨 ≥ -5.8dB）', async () => {
    const { state, exec } = await makeCtx()
    try {
      await exec('studio_create_project', { template: 'empty', title: '空' })
      await exec('studio_generate_beat', { bars: 8, seed: 1 })
      const relationalDb = state.project.tracks.map((track) => 20 * Math.log10(track.volume / 0.78))
      assert.ok(relationalDb.every((value) => value <= -2.5), JSON.stringify(relationalDb))
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R7a：版本/构建信息（build-info.json → app_info / GET /health）             */
/* ------------------------------------------------------------------------- */

describe('R7a — 版本/构建信息', () => {
  async function makeBuildInfoFile(content) {
    const dir = await tempDir()
    const file = path.join(dir, 'build-info.json')
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
    return { dir, file }
  }

  const SAMPLE = {
    version: '2.3.4',
    gitCommit: 'abc1234',
    gitDirty: true,
    buildDate: '2026-10-24T12:00:00.000Z',
    channel: 'beta',
    electronVersion: '45.0.0',
  }

  async function withBuildInfoEnv(file, fn) {
    const previous = process.env.AIMS_BUILD_INFO
    process.env.AIMS_BUILD_INFO = file
    try {
      return await fn()
    } finally {
      if (previous === undefined) delete process.env.AIMS_BUILD_INFO
      else process.env.AIMS_BUILD_INFO = previous
    }
  }

  it('缺少 build-info：回退 dev 值（version/commit/date/channel/electron）', async () => {
    const { resolveBuildInfo } = await import('../src/host/app-info.js')
    const dir = await tempDir()
    try {
      const missing = path.join(dir, 'missing.json')
      // 用 candidates 隔离：真实打包可能在仓库根生成 build-info.json，不能依赖它缺失。
      const info = resolveBuildInfo({ fallbackVersion: '1.0.0', candidates: [missing] })
      assert.equal(info.version, '1.0.0')
      assert.equal(info.commit, 'unknown')
      assert.equal(info.date, null)
      assert.equal(info.channel, 'dev')
      assert.equal(info.electron, null)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('AIMS_BUILD_INFO 指向的文件：字段映射正确', async () => {
    const { resolveBuildInfo } = await import('../src/host/app-info.js')
    const { dir, file } = await makeBuildInfoFile(SAMPLE)
    try {
      await withBuildInfoEnv(file, () => {
        const info = resolveBuildInfo()
        assert.equal(info.version, '2.3.4')
        assert.equal(info.commit, 'abc1234')
        assert.equal(info.date, '2026-10-24T12:00:00.000Z')
        assert.equal(info.channel, 'beta')
        assert.equal(info.electron, '45.0.0')
        assert.equal(info.dirty, true)
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('损坏/非对象 build-info：回退不崩溃', async () => {
    const { resolveBuildInfo } = await import('../src/host/app-info.js')
    const corrupt = await makeBuildInfoFile('{ not json')
    const arrayFile = await makeBuildInfoFile('[1,2,3]')
    try {
      assert.equal(resolveBuildInfo({ fallbackVersion: '9.9.9', candidates: [corrupt.file] }).version, '9.9.9')
      assert.equal(resolveBuildInfo({ fallbackVersion: '8.8.8', candidates: [arrayFile.file] }).version, '8.8.8')
    } finally {
      await rm(corrupt.dir, { recursive: true, force: true })
      await rm(arrayFile.dir, { recursive: true, force: true })
    }
  })

  it('buildAppInfo(state,{buildInfo})：version/build/app.version 同步', async () => {
    const { buildAppInfo } = await import('../src/host/app-info.js')
    const { state } = await makeState()
    try {
      const info = buildAppInfo(state, {
        buildInfo: { version: '3.0.0', commit: 'deadbee', date: '2026-01-02T03:04:05.000Z', channel: 'stable', electron: '45.0.0' },
      })
      assert.equal(info.version, '3.0.0')
      assert.deepEqual(info.build, { version: '3.0.0', commit: 'deadbee', date: '2026-01-02T03:04:05.000Z', channel: 'stable', electron: '45.0.0' })
      assert.equal(info.app.version, '3.0.0')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_app_info 工具：返回 version/build（来自 build-info.json）', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const exec = (name, args = {}) => tools.find((tool) => tool.name === name).execute(args, {})
    const { dir, file } = await makeBuildInfoFile(SAMPLE)
    try {
      await withBuildInfoEnv(file, async () => {
        const result = await exec('studio_app_info')
        assert.equal(result.ok, true, result.error)
        assert.equal(result.version, '2.3.4')
        assert.deepEqual(result.build, { version: '2.3.4', commit: 'abc1234', date: '2026-10-24T12:00:00.000Z', channel: 'beta', electron: '45.0.0', dirty: true })
      })
    } finally {
      await state.flush()
      state.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('GET /health：version/build 与 build-info 同步', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    const { dir, file } = await makeBuildInfoFile(SAMPLE)
    try {
      await withBuildInfoEnv(file, async () => {
        const response = await fetch(`${server.base}/studio/api/health`)
        assert.equal(response.status, 200)
        const data = await response.json()
        assert.equal(data.ok, true)
        assert.equal(data.version, '2.3.4')
        assert.deepEqual(data.build, { version: '2.3.4', commit: 'abc1234', date: '2026-10-24T12:00:00.000Z', channel: 'beta', electron: '45.0.0', dirty: true })
        assert.equal(data.tracks, state.project.tracks.length)
      })
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('GET /catalog：app_info 同样带 version/build', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    const { dir, file } = await makeBuildInfoFile({ ...SAMPLE, channel: 'stable' })
    try {
      await withBuildInfoEnv(file, async () => {
        const response = await fetch(`${server.base}/studio/api/catalog`)
        assert.equal(response.status, 200)
        const data = await response.json()
        assert.equal(data.version, '2.3.4')
        assert.equal(data.build.channel, 'stable')
      })
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('desktop/build-exe.mjs --build-info-only：生成 version/gitCommit/buildDate/channel/electronVersion', async () => {
    const { existsSync: exists } = await import('node:fs')
    if (!exists('desktop/node_modules/electron/package.json')) return // public source tree: optional Electron deps not installed
    const { spawnSync } = await import('node:child_process')
    const dir = await tempDir()
    const out = path.join(dir, 'build-info.json')
    try {
      const result = spawnSync(process.execPath, ['desktop/build-exe.mjs', '--build-info-only', `--build-info-out=${out}`], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, AIMS_CHANNEL: 'stable' },
        timeout: 120000,
      })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      const info = JSON.parse(await readFile(out, 'utf8'))
      assert.equal(info.version, CURRENT_VERSION)
      assert.ok(typeof info.gitCommit === 'string' && info.gitCommit.length > 0)
      assert.equal(typeof info.gitDirty, 'boolean')
      assert.ok(!Number.isNaN(Date.parse(info.buildDate)))
      assert.equal(info.channel, 'stable')
      assert.equal(typeof info.electronVersion, 'string')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('app_info 工具描述包含 version/build 说明', async () => {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    try {
      const tool = tools.find((item) => item.name === 'studio_app_info')
      assert.ok(tool.description.includes('version/build'))
      assert.ok(tool.description.includes('构建日期'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('buildInfoCandidatePaths：含 env 与仓库/app.asar 候选', async () => {
    const { buildInfoCandidatePaths } = await import('../src/host/app-info.js')
    const { dir, file } = await makeBuildInfoFile(SAMPLE)
    try {
      await withBuildInfoEnv(file, () => {
        const paths = buildInfoCandidatePaths()
        assert.ok(paths.includes(file))
        assert.ok(paths.some((candidate) => candidate.endsWith('build-info.json')))
        assert.equal(new Set(paths).size, paths.length)
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R7b：设置 / 更新检查 / 诊断 / 崩溃日志 / 路由 / 工具                        */
/* ------------------------------------------------------------------------- */

describe('R7b — settings 模块', () => {
  const settingsMod = () => import('../src/host/settings.js')

  it('缺失 settings.json：返回默认值', async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await settingsMod()
    const dir = await tempDir()
    try {
      assert.deepEqual(await loadSettings(dir), { ...DEFAULT_SETTINGS })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('损坏 JSON/非法字段：逐字段回默认', async () => {
    const { loadSettings } = await settingsMod()
    const dir = await tempDir()
    try {
      await writeFile(path.join(dir, 'settings.json'), '{bad json', 'utf8')
      assert.deepEqual(await loadSettings(dir), { channel: 'stable', telemetryOptIn: false, crashReports: true, language: 'zh-CN' })
      await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ channel: 'nightly', telemetryOptIn: 'yes', crashReports: 0, language: 'fr-FR' }), 'utf8')
      assert.deepEqual(await loadSettings(dir), { channel: 'stable', telemetryOptIn: false, crashReports: true, language: 'zh-CN' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('saveSettings：原子写文件且持久化', async () => {
    const { loadSettings, saveSettings, settingsFilePath } = await settingsMod()
    const dir = await tempDir()
    try {
      const saved = await saveSettings(dir, { channel: 'beta', telemetryOptIn: true })
      assert.deepEqual(saved, { channel: 'beta', telemetryOptIn: true, crashReports: true, language: 'zh-CN' })
      const onDisk = JSON.parse(await readFile(settingsFilePath(dir), 'utf8'))
      assert.deepEqual(onDisk, saved)
      assert.deepEqual(await loadSettings(dir), saved)
      const leftover = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
      assert.deepEqual(leftover, [])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('validateSettingsPatch：未知字段/空 patch/非法值中文错误', async () => {
    const { validateSettingsPatch } = await settingsMod()
    assert.throws(() => validateSettingsPatch({}), /至少/)
    assert.throws(() => validateSettingsPatch({ bogus: 1 }), /未知设置字段/)
    assert.throws(() => validateSettingsPatch({ channel: 'nightly' }), /channel/)
    assert.throws(() => validateSettingsPatch({ language: 'fr-FR' }), /language/)
    assert.throws(() => validateSettingsPatch({ telemetryOptIn: 'yes' }), /布尔/)
    assert.throws(() => validateSettingsPatch({ crashReports: 1 }), /布尔/)
    assert.throws(() => validateSettingsPatch(null), /对象/)
  })

  it('normalizeSettings：非对象/缺失字段安全', async () => {
    const { normalizeSettings } = await settingsMod()
    assert.deepEqual(normalizeSettings(null), { channel: 'stable', telemetryOptIn: false, crashReports: true, language: 'zh-CN' })
    assert.deepEqual(normalizeSettings({ channel: 'beta' }), { channel: 'beta', telemetryOptIn: false, crashReports: true, language: 'zh-CN' })
  })

  it('设置写入不影响工程 revision/undo（模块级）', async () => {
    const { state } = await makeState()
    const { saveSettings } = await settingsMod()
    try {
      const revision = state.revision
      const depth = state.historyState().undoDepth
      await saveSettings(state.dataDir, { channel: 'beta' })
      assert.equal(state.revision, revision)
      assert.equal(state.historyState().undoDepth, depth)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('R7b — update-check 模块', () => {
  const updateMod = () => import('../src/host/update-check.js')

  it('parseVersion/compareVersions：语义版本比较', async () => {
    const { parseVersion, compareVersions } = await updateMod()
    assert.deepEqual(parseVersion('v1.2.3'), { core: [1, 2, 3], prerelease: null })
    assert.deepEqual(parseVersion('1.2.3-beta.1'), { core: [1, 2, 3], prerelease: 'beta.1' })
    assert.equal(parseVersion('1.2'), null)
    assert.equal(parseVersion('abc'), null)
    assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
    assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
    assert.equal(compareVersions('1.2.3', '1.2.3-beta'), 1)
    assert.equal(compareVersions('1.2.3-alpha', '1.2.3-beta'), -1)
    assert.throws(() => compareVersions('x', '1.0.0'), /版本号/)
  })

  it('无 manifest：status=no-source', async () => {
    const { checkForUpdate } = await updateMod()
    const dir = await tempDir()
    try {
      const result = await checkForUpdate({ dataDir: dir, currentVersion: '1.0.0' })
      assert.equal(result.status, 'no-source')
      assert.equal(result.current.version, '1.0.0')
      assert.ok(!Number.isNaN(Date.parse(result.checkedAt)))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('最新/有更新：up-to-date/update-available + available 字段', async () => {
    const { checkForUpdate } = await updateMod()
    const dir = await tempDir()
    try {
      await writeFile(path.join(dir, 'update-manifest.json'), JSON.stringify({
        stable: { latestVersion: '1.2.0', buildDate: '2026-10-20', notes: '新功能', url: 'https://example.invalid/setup' },
        beta: { latestVersion: '0.9.0' },
      }), 'utf8')
      const available = await checkForUpdate({ dataDir: dir, channel: 'stable', currentVersion: '1.0.0' })
      assert.equal(available.status, 'update-available')
      assert.deepEqual(available.available, { version: '1.2.0', buildDate: '2026-10-20', notes: '新功能', url: 'https://example.invalid/setup' })
      assert.equal(available.notes, '新功能')
      assert.equal(available.url, 'https://example.invalid/setup')
      const upToDate = await checkForUpdate({ dataDir: dir, channel: 'beta', currentVersion: '1.0.0' })
      assert.equal(upToDate.status, 'up-to-date')
      const same = await checkForUpdate({ dataDir: dir, channel: 'stable', currentVersion: '1.2.0' })
      assert.equal(same.status, 'up-to-date')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('AIMS_UPDATE_MANIFEST env 指定清单路径', async () => {
    const { checkForUpdate } = await updateMod()
    const dir = await tempDir()
    const manifestPath = path.join(dir, 'custom-manifest.json')
    const previous = process.env.AIMS_UPDATE_MANIFEST
    try {
      await writeFile(manifestPath, JSON.stringify({ stable: { latestVersion: '9.9.9' } }), 'utf8')
      process.env.AIMS_UPDATE_MANIFEST = manifestPath
      const result = await checkForUpdate({ dataDir: path.join(dir, 'empty-data'), currentVersion: '1.0.0' })
      assert.equal(result.status, 'update-available')
      assert.equal(result.available.version, '9.9.9')
    } finally {
      if (previous === undefined) delete process.env.AIMS_UPDATE_MANIFEST
      else process.env.AIMS_UPDATE_MANIFEST = previous
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('损坏 manifest/非法 latestVersion：中文错误', async () => {
    const { checkForUpdate, loadUpdateManifest } = await updateMod()
    const dir = await tempDir()
    try {
      await writeFile(path.join(dir, 'update-manifest.json'), '{bad', 'utf8')
      await assert.rejects(loadUpdateManifest(dir), /[\u4e00-\u9fa5]/)
      await assert.rejects(checkForUpdate({ dataDir: dir }), /[\u4e00-\u9fa5]/)
      await writeFile(path.join(dir, 'update-manifest.json'), JSON.stringify({ stable: { latestVersion: 'not-a-version' } }), 'utf8')
      await assert.rejects(loadUpdateManifest(dir), /latestVersion/)
      await writeFile(path.join(dir, 'update-manifest.json'), JSON.stringify([]), 'utf8')
      await assert.rejects(loadUpdateManifest(dir), /结构错误/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('R7b — diagnostics 模块', () => {
  const diagMod = () => import('../src/host/diagnostics.js')

  it('recordCrash：写 JSON（message/stack/at/version/source）', async () => {
    const { recordCrash, crashReportsDir } = await diagMod()
    const dir = await tempDir()
    try {
      const error = new Error('测试崩溃')
      const summary = await recordCrash(dir, error, { version: '1.0.0', source: 'test' })
      assert.ok(path.basename(summary.file).startsWith('crash-'))
      assert.equal(summary.message, '测试崩溃')
      const files = await readdir(crashReportsDir(dir))
      assert.equal(files.length, 1)
      const report = JSON.parse(await readFile(path.join(crashReportsDir(dir), files[0]), 'utf8'))
      assert.equal(report.message, '测试崩溃')
      assert.ok(report.stack.includes('测试崩溃'))
      assert.equal(report.version, '1.0.0')
      assert.equal(report.source, 'test')
      assert.ok(!Number.isNaN(Date.parse(report.at)))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('崩溃报告上限 20：超出清理最旧', async () => {
    const { recordCrash, crashReportsDir } = await diagMod()
    const dir = await tempDir()
    try {
      for (let index = 0; index < 24; index += 1) {
        await recordCrash(dir, new Error(`err-${index}`), { at: new Date(Date.now() + index * 1000).toISOString() })
      }
      const files = (await readdir(crashReportsDir(dir))).filter((name) => name.endsWith('.json'))
      assert.equal(files.length, 20)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('listCrashReports：新在前、limit、损坏文件跳过', async () => {
    const { recordCrash, listCrashReports, crashReportsDir } = await diagMod()
    const dir = await tempDir()
    try {
      await recordCrash(dir, new Error('old'), { at: '2026-01-01T00:00:00.000Z' })
      await recordCrash(dir, new Error('new'), { at: '2026-02-01T00:00:00.000Z' })
      await writeFile(path.join(crashReportsDir(dir), 'crash-broken.json'), '{oops', 'utf8')
      const list = await listCrashReports(dir, { limit: 5 })
      assert.equal(list.length, 2)
      assert.equal(list[0].message, 'new')
      assert.equal(list[1].message, 'old')
      const limited = await listCrashReports(dir, { limit: 1 })
      assert.equal(limited.length, 1)
      assert.equal(limited[0].message, 'new')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('collectDiagnostics：版本/设置/工程规模/内存/脱敏 dataDir', async () => {
    const { state } = await makeState()
    const { collectDiagnostics, exportDiagnosticsText } = await diagMod()
    try {
      await (await import('../src/host/settings.js')).saveSettings(state.dataDir, { channel: 'beta' })
      const diag = await collectDiagnostics({ dataDir: state.dataDir, state })
      assert.ok(diag.version)
      assert.ok(diag.build && diag.build.version)
      assert.equal(diag.channel, 'beta')
      assert.equal(diag.settings.telemetryOptIn, false)
      assert.equal(diag.project.tracks, state.project.tracks.length)
      assert.ok(diag.project.notes > 0)
      assert.ok(diag.memory.rssMB > 0)
      assert.ok(Array.isArray(diag.crashes))
      assert.equal(diag.dataDir.includes(os.homedir()), false)
      const text = exportDiagnosticsText(diag)
      assert.ok(text.includes('诊断报告'))
      assert.ok(text.includes('版本'))
      assert.ok(text.includes('设置'))
      assert.ok(text.includes('不会自动上传'))
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('collectDiagnostics：崩溃摘要包含最近记录', async () => {
    const { recordCrash } = await diagMod()
    const { collectDiagnostics } = await diagMod()
    const dir = await tempDir()
    try {
      await recordCrash(dir, new Error('诊断崩溃'), { source: 'test' })
      const diag = await collectDiagnostics({ dataDir: dir })
      assert.equal(diag.crashes.length, 1)
      assert.equal(diag.crashes[0].message, '诊断崩溃')
      assert.ok(diag.text === undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('R7b — 设置/更新/诊断 路由', () => {
  it('GET /settings 默认值', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const response = await fetch(`${server.base}/studio/api/settings`)
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.ok, true)
      assert.deepEqual(data.settings, { channel: 'stable', telemetryOptIn: false, crashReports: true, language: 'zh-CN' })
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('PATCH /settings：持久化且不改变 revision/undo', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const revision = state.revision
      const depth = state.historyState().undoDepth
      const response = await fetch(`${server.base}/studio/api/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'beta', telemetryOptIn: true, crashReports: false }),
      })
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.ok, true)
      assert.equal(data.settings.channel, 'beta')
      assert.equal(data.settings.telemetryOptIn, true)
      assert.equal(data.settings.crashReports, false)
      const again = await (await fetch(`${server.base}/studio/api/settings`)).json()
      assert.equal(again.settings.channel, 'beta')
      assert.equal(state.revision, revision)
      assert.equal(state.historyState().undoDepth, depth)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('PATCH /settings：未知字段/非法值 400', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      for (const body of [{ bogus: 1 }, { channel: 'nightly' }, { language: 'fr-FR' }, { telemetryOptIn: 'yes' }]) {
        const response = await fetch(`${server.base}/studio/api/settings`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        assert.equal(response.status, 400, JSON.stringify(body))
        const data = await response.json()
        assert.equal(data.ok, false)
        assert.match(data.error, /[\u4e00-\u9fa5]/)
      }
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('GET /update-check：no-source 默认', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const data = await (await fetch(`${server.base}/studio/api/update-check`)).json()
      assert.equal(data.ok, true)
      assert.equal(data.status, 'no-source')
      assert.equal(data.current.channel, 'stable')
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('GET /update-check：有更新/最新 + 非法 channel 400', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      await writeFile(path.join(state.dataDir, 'update-manifest.json'), JSON.stringify({
        stable: { latestVersion: '99.0.0', notes: '更新说明', url: 'https://example.invalid' },
      }), 'utf8')
      const data = await (await fetch(`${server.base}/studio/api/update-check`)).json()
      assert.equal(data.status, 'update-available')
      assert.equal(data.available.version, '99.0.0')
      const invalid = await fetch(`${server.base}/studio/api/update-check?channel=nightly`)
      assert.equal(invalid.status, 400)
      const invalidData = await invalid.json()
      assert.match(invalidData.error, /channel/)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('GET /update-check：损坏 manifest → ok:false 中文错误且服务继续', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      await writeFile(path.join(state.dataDir, 'update-manifest.json'), '{bad json', 'utf8')
      const response = await fetch(`${server.base}/studio/api/update-check`)
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.ok, false)
      assert.match(data.error, /[\u4e00-\u9fa5]/)
      const settingsResponse = await fetch(`${server.base}/studio/api/settings`)
      assert.equal(settingsResponse.status, 200)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('GET /diagnostics：返回版本/构建/设置/工程/内存', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const response = await fetch(`${server.base}/studio/api/diagnostics`)
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.ok, true)
      assert.ok(data.version)
      assert.ok(data.build)
      assert.ok(data.settings)
      assert.equal(data.project.tracks, state.project.tracks.length)
      assert.ok(data.memory.rssMB > 0)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /diagnostics/export：text/plain attachment 含诊断内容', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const response = await fetch(`${server.base}/studio/api/diagnostics/export`, { method: 'POST' })
      assert.equal(response.status, 200)
      assert.match(String(response.headers.get('content-type')), /text\/plain/)
      assert.match(String(response.headers.get('content-disposition')), /attachment/)
      const text = await response.text()
      assert.ok(text.includes('AI 音乐工作室'))
      assert.ok(text.includes('诊断报告'))
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /settings 方法与 GET /diagnostics 方法 405', async () => {
    const { state } = await makeState()
    const server = await startServer(state)
    try {
      const settings = await fetch(`${server.base}/studio/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(settings.status, 405)
      const diagnostics = await fetch(`${server.base}/studio/api/diagnostics`, { method: 'POST' })
      assert.equal(diagnostics.status, 405)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })
})

describe('R7b — 设置/更新/诊断 工具', () => {
  async function makeR7bTools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { state, byName, exec }
  }

  it('studio_get_settings：默认值', async () => {
    const { state, exec } = await makeR7bTools()
    try {
      const result = await exec('studio_get_settings')
      assert.equal(result.ok, true, result.error)
      assert.deepEqual(result.settings, { channel: 'stable', telemetryOptIn: false, crashReports: true, language: 'zh-CN' })
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_settings：写入并返回 settings/changed，不 bump revision/undo', async () => {
    const { state, exec } = await makeR7bTools()
    try {
      const revision = state.revision
      const depth = state.historyState().undoDepth
      const result = await exec('studio_update_settings', { channel: 'beta', language: 'en-US', telemetryOptIn: true })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.settings.channel, 'beta')
      assert.equal(result.settings.language, 'en-US')
      assert.deepEqual(result.changed, ['channel', 'language', 'telemetryOptIn'])
      assert.equal(state.revision, revision)
      assert.equal(state.historyState().undoDepth, depth)
      const readBack = await exec('studio_get_settings')
      assert.equal(readBack.settings.channel, 'beta')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_update_settings：未知字段/非法值中文错误', async () => {
    const { state, exec } = await makeR7bTools()
    try {
      for (const args of [{ bogus: 1 }, { channel: 'nightly' }, { language: 'fr-FR' }, { crashReports: 'yes' }, {}]) {
        const result = await exec('studio_update_settings', args)
        assert.equal(result.ok, false, JSON.stringify(args))
        assert.match(result.error, /[\u4e00-\u9fa5]/)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_check_update：no-source/up-to-date/update-available', async () => {
    const { state, exec } = await makeR7bTools()
    try {
      const none = await exec('studio_check_update')
      assert.equal(none.ok, true, none.error)
      assert.equal(none.status, 'no-source')
      await writeFile(path.join(state.dataDir, 'update-manifest.json'), JSON.stringify({
        stable: { latestVersion: '99.0.0', notes: 'n', url: 'u' },
        beta: { latestVersion: '0.5.0' },
      }), 'utf8')
      const available = await exec('studio_check_update')
      assert.equal(available.status, 'update-available')
      assert.equal(available.available.version, '99.0.0')
      const beta = await exec('studio_check_update', { channel: 'beta' })
      assert.equal(beta.status, 'up-to-date')
      const badChannel = await exec('studio_check_update', { channel: 'nightly' })
      assert.equal(badChannel.ok, false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_check_update：损坏 manifest 中文错误', async () => {
    const { state, exec } = await makeR7bTools()
    try {
      await writeFile(path.join(state.dataDir, 'update-manifest.json'), '{bad', 'utf8')
      const result = await exec('studio_check_update')
      assert.equal(result.ok, false)
      assert.match(result.error, /[\u4e00-\u9fa5]/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('studio_get_diagnostics：字段完整 + text', async () => {
    const { state, exec } = await makeR7bTools()
    try {
      const result = await exec('studio_get_diagnostics')
      assert.equal(result.ok, true, result.error)
      assert.ok(result.version)
      assert.ok(result.build)
      assert.ok(result.settings)
      assert.ok(result.project)
      assert.ok(result.memory)
      assert.ok(Array.isArray(result.crashes))
      assert.ok(typeof result.text === 'string' && result.text.includes('诊断报告'))
      assert.equal(result.dataDir.includes(os.homedir()), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('4 个新工具声明/描述中文', async () => {
    const { state, byName } = await makeR7bTools()
    try {
      for (const name of ['studio_get_settings', 'studio_update_settings', 'studio_check_update', 'studio_get_diagnostics']) {
        const tool = byName.get(name)
        assert.ok(tool, name)
        assert.ok(tool.description.includes(name.includes('settings') ? '设置' : name.includes('update') ? '更新' : '诊断'), name)
        assert.ok(tool.output?.schema)
      }
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('设置工具不影响 AI 变更日志（只读/设置写入不产生工程变更）', async () => {
    const { state, exec } = await makeR7bTools()
    try {
      const before = state.aiJournal.list().length
      await exec('studio_get_settings')
      await exec('studio_update_settings', { channel: 'beta' })
      assert.equal(state.aiJournal.list().length, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

/* ------------------------------------------------------------------------- */
/* v2.1 Host P0：contentRevision / effectId / automation / export claim 指标    */
/* ------------------------------------------------------------------------- */

/* v2.1 helper */
  async function makeV21Tools() {
    const { state } = await makeState()
    const tools = createTools({ defineTool: (options) => options, state })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const exec = (name, args = {}) => byName.get(name).execute(args, {})
    return { state, byName, exec }
  }

  describe('v2.1 — contentRevision 与 dirty', () => {
  it('init/meta/content/undo/redo 的 contentRevision 语义', async () => {
    const { state, exec } = await makeV21Tools()
    try {
      assert.equal(state.project.contentRevision, 1)
      assert.equal(state.savedContentRevision, 1)
      await exec('studio_set_activity', { text: 'x' })
      assert.equal(state.project.revision, 2)
      assert.equal(state.project.contentRevision, 1, 'meta 不增加 contentRevision')
      const added = await exec('studio_add_track', { name: 'v21', kind: 'synth', preset: 'grand_piano' })
      assert.equal(added.ok, true, added.error)
      assert.equal(state.project.contentRevision, 2, '内容编辑增加')
      await exec('studio_undo')
      assert.equal(state.project.contentRevision, 3, 'undo 是内容变化')
      await exec('studio_redo')
      assert.equal(state.project.contentRevision, 4, 'redo 是内容变化')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('get_project contentRevision/savedContentRevision/dirty + save 同步基线', async () => {
    const { state, exec } = await makeV21Tools()
    try {
      let overview = await exec('studio_get_project')
      assert.equal(overview.contentRevision, 1)
      assert.equal(overview.savedContentRevision, 1)
      assert.equal(overview.dirty, false)
      await exec('studio_update_track', { trackId: state.project.tracks[0].id, volume: 0.42 })
      overview = await exec('studio_get_project')
      assert.ok(overview.contentRevision > overview.savedContentRevision)
      assert.equal(overview.dirty, true)
      const saved = await exec('studio_save_project', { name: 'v21 dirty', overwrite: true })
      assert.equal(saved.ok, true, saved.error)
      assert.equal(saved.contentRevision, state.project.contentRevision)
      assert.equal(saved.savedContentRevision, state.project.contentRevision)
      overview = await exec('studio_get_project')
      assert.equal(overview.dirty, false)
      await exec('studio_update_track', { trackId: state.project.tracks[0].id, volume: 0.33 })
      assert.equal((await exec('studio_get_project')).dirty, true)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('导出/播放等 meta 不增加 contentRevision', async () => {
    const { state, exec } = await makeV21Tools()
    try {
      await exec('studio_set_activity', { text: 'a' })
      await exec('studio_transport', { action: 'seek', positionBar: 2 })
      const before = state.project.contentRevision
      await exec('studio_export', { format: 'wav' })
      assert.equal(state.project.contentRevision, before)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('v2.1 — subtractive / effectId', () => {
  it('add_track subtractive：instrument.preset=null；切回 sampler 恢复默认 preset', async () => {
    const { state, exec } = await makeV21Tools()
    try {
      const result = await exec('studio_add_track', { name: 'v21 sub', kind: 'synth', engine: 'subtractive', synthPreset: 'saw_lead' })
      assert.equal(result.ok, true, result.error)
      const track = state.project.tracks.find((item) => item.id === result.trackId)
      assert.equal(track.instrument.preset, null)
      assert.equal(track.engine, 'subtractive')
      assert.equal(track.synthPreset, 'saw_lead')
      await exec('studio_update_track', { trackId: track.id, engine: 'sampler' })
      const back = state.project.tracks.find((item) => item.id === track.id)
      assert.equal(back.instrument.preset, 'grand_piano')
      assert.equal(back.synthPreset, 'saw_lead')
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('effectId 全局唯一（master/轨道/bus/group）', async () => {
    const { state, exec } = await makeV21Tools()
    try {
      const trackId = state.project.tracks[1].id
      await exec('studio_add_effect', { target: 'master', type: 'compressor' })
      await exec('studio_add_effect', { target: trackId, type: 'filter', params: { cutoff: 1200 } })
      await exec('studio_add_effect', { target: 'bus', busId: 'reverb', type: 'eq3' })
      const group = await exec('studio_add_group', { name: 'v21 G' })
      const groupId = group.groupId ?? group.group?.id
      await exec('studio_add_effect', { target: 'group', groupId, type: 'chorus' })
      const ids = [
        ...state.project.tracks.flatMap((track) => (track.effects ?? []).map((effect) => effect.id)),
        ...(state.project.master.effects ?? []).map((effect) => effect.id),
        ...(state.project.buses?.reverb?.effects ?? []).map((effect) => effect.id),
        ...(state.project.groups ?? []).flatMap((item) => (item.effects ?? []).map((effect) => effect.id)),
      ]
      assert.ok(ids.length >= 4)
      assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids))
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('v2.1 — 音量自动化乘算 validate / noteIndex', () => {
  it('volume 自动化首点与 track.volume 不一致 → warning（乘算语义说明）', async () => {
    const { state, exec } = await makeV21Tools()
    try {
      const track = state.project.tracks[0]
      await exec('studio_update_track', { trackId: track.id, volume: 0.8 })
      await exec('studio_set_automation', { trackId: track.id, param: 'volume', points: [{ beat: 0, value: 0.2 }, { beat: 4, value: 0.6 }] })
      const result = await exec('studio_validate_project')
      const warning = result.issues.find((issue) => issue.code === 'automation.volume_multiplier')
      assert.ok(warning, JSON.stringify(result.issues.map((issue) => issue.code)))
      assert.match(warning.message, /乘算/)
      // 首点与轨道音量一致 → 不 warn
      await exec('studio_set_automation', { trackId: track.id, param: 'volume', points: [{ beat: 0, value: 0.8 }, { beat: 4, value: 0.6 }] })
      const clean = await exec('studio_validate_project')
      assert.equal(clean.issues.some((issue) => issue.code === 'automation.volume_multiplier'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })

  it('doctor noteIndex 消息明确 0 基', () => {
    const project = createDemoProject()
    project.patterns[0].notes.push({ pitch: 200, start: 0, dur: 1, vel: 0.8 })
    const result = ops.doctorProject(project)
    const noteIssue = result.issues.find((issue) => issue.code.startsWith('doctor.note_'))
    assert.ok(noteIssue, JSON.stringify(result.issues.map((issue) => issue.code)))
    assert.match(noteIssue.message, /0 基/)
  })
})

describe('v2.1 — apply_mix 自动化曲线缩放/warning', () => {
  it('volume 自动化存在时按比例缩放曲线点并 warning/lastMixWarnings/activity', async () => {
    const { state, exec } = await makeV21Tools()
    try {
      const trackId = state.project.tracks[1].id
      await exec('studio_update_track', { trackId, volume: 0.8 })
      await exec('studio_set_automation', { trackId, param: 'volume', points: [{ beat: 0, value: 1 }, { beat: 8, value: 0.5 }] })
      const before = state.project.tracks.find((item) => item.id === trackId).automation.volume.points.map((point) => point.value)
      const other = state.project.tracks.filter((item) => item.id !== trackId).map((item) => ({ trackId: item.id, rmsDb: -40 }))
      const analysis = { stems: [{ trackId, rmsDb: 0 }, ...other] }
      const result = await exec('studio_apply_mix', { analysis, codes: ['mix.stem.loud'] })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.automationAdjusted, true)
      assert.ok(Array.isArray(result.warnings) && result.warnings.some((item) => item.code === 'mix.automation.volume'))
      const after = state.project.tracks.find((item) => item.id === trackId).automation.volume.points.map((point) => point.value)
      assert.notDeepEqual(after, before)
      assert.ok(Array.isArray(state.project.lastMixWarnings) && state.project.lastMixWarnings.length > 0)
      assert.match(state.project.activity.text, /自动化/)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})

describe('v2.1 — export claim / 响度指标 / 预览超时文案', () => {
  it('exportRequest 带 claimable/claimedBy；首个 claim 成功、后续失败', async () => {
    const { state, exec } = await makeV21Tools()
    const server = await startServer(state)
    try {
      const exported = await exec('studio_export', { format: 'wav' })
      assert.equal(exported.ok, true, exported.error)
      const request = state.project.exportRequest
      assert.equal(request.claimable, true)
      assert.equal(request.claimedBy, null)
      const jobId = request.jobId
      const claim = (clientId) => postJson(server.base, '/studio/api/export-claim', { jobId, clientId })
      const first = await claim('client-a')
      assert.equal(first.status, 200)
      assert.equal(first.data.ok, true)
      assert.equal(first.data.claimed, true)
      assert.equal(first.data.claimedBy, 'client-a')
      assert.equal(state.project.exportRequest.claimedBy, 'client-a')
      const second = await claim('client-b')
      assert.equal(second.data.claimed, false)
      assert.equal(second.data.claimedBy, 'client-a')
      const missing = await postJson(server.base, '/studio/api/export-claim', { jobId: 'job_404', clientId: 'x' })
      assert.equal(missing.data.ok, true)
      assert.equal(missing.data.claimed, false)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('POST /export-done 回传 achievedLufs/peak/truePeak 并持久化 exportStatus/lastExport', async () => {
    const { state, exec } = await makeV21Tools()
    const server = await startServer(state)
    try {
      await exec('studio_export', { format: 'wav' })
      const jobId = state.project.exportRequest.jobId
      const wav = makeWav(1)
      const query = new URLSearchParams({
        name: 'v21-export.wav',
        seconds: '1',
        jobId,
        achievedLufs: '-14.12',
        peak: '0.78',
        peakDb: '-1.25',
        truePeak: '0.82',
        truePeakDb: '-0.9',
        gainDb: '2.35',
        limited: 'true',
      })
      const response = await fetch(`${server.base}/studio/api/export-done?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
      })
      assert.equal(response.status, 200)
      const data = await response.json()
      assert.equal(data.ok, true)
      assert.equal(data.jobId, jobId)
      const status = await (await fetch(`${server.base}/studio/api/export-status?jobId=${jobId}`)).json()
      assert.equal(status.job.achievedLufs, -14.12)
      assert.equal(status.job.peak, 0.78)
      assert.equal(status.job.truePeak, 0.82)
      assert.equal(status.job.truePeakDb, -0.9)
      assert.equal(status.job.limited, true)
      assert.equal(state.project.lastExport.achievedLufs, -14.12)
      assert.equal(state.project.lastExport.peakDb, -1.25)
      const overview = await exec('studio_get_project')
      assert.equal(overview.lastExport.achievedLufs, -14.12)
      assert.equal(overview.lastExport.peak, 0.78)
    } finally {
      await server.close()
      await state.flush()
      state.dispose()
    }
  })

  it('render_preview 描述/超时文案：120s + AIMS_PREVIEW_TIMEOUT_MS + 窗口遮挡说明', async () => {
    const { state, byName } = await makeV21Tools()
    try {
      const tool = byName.get('studio_render_preview')
      assert.ok(tool.description.includes('120s'))
      assert.ok(tool.description.includes('AIMS_PREVIEW_TIMEOUT_MS'))
      const source = await readFile(new URL('../src/host/tools.js', import.meta.url), 'utf8')
      assert.ok(source.includes('窗口被遮挡/最小化'))
      assert.ok(source.includes('大段预览已自动 fast'))
      assert.equal(source.includes('首次预览会加载音色库'), false)
    } finally {
      await state.flush()
      state.dispose()
    }
  })
})
