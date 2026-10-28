/**
 * AI 音乐工作室 — MIDI 导入（P14a，schema 2）。
 *
 * 纯解析 + 构建：
 * - `parseMidiBuffer(buffer)`：SMF Format 0/1（running status、note/program/tempo/timesig/track name），
 *   非法文件抛中文错误（`MidiImportError`）。
 * - `buildProjectFromMidi(parsed, { title, baseBpm })`：把解析结果转成 schema2 工程
 *   （首 tempo → bpm、tempos → tempoMap、channel10 → 采样鼓、GM program → 最近采样乐器、
 *   每轨一个 pattern + clip、曲长按数据推算）。
 *
 * 另外提供 `importMidiIntoState(state, options)` 供工具与 HTTP 路由共用（备份、mutate、activeName 处理）。
 */
import { writeAutobackup, writeProjectVersion } from './projects.js'
import * as ops from './ops.js'
import { LIMITS, SYNTH_PRESETS } from '../shared/catalog.js'
import {
  AUTOMATION_CC_PARAMS,
  beatsPerBar,
  createEmptyProject,
  makeClip,
  makeIdGen,
  makePattern,
  makeTrack,
  normalizeAutomation,
} from '../shared/model.js'
import { clampTempoBpm, normalizeTempoPoints } from '../shared/tempo.js'

/** MIDI 文件大小上限（10MB）。 */
export const MAX_MIDI_BYTES = 10 * 1024 * 1024
/** MIDI 导入默认标题。 */
export const DEFAULT_MIDI_TITLE = 'MIDI 导入'

/** MIDI 导入错误（message 直接回给用户/模型）。 */
export class MidiImportError extends Error {
  constructor(message) {
    super(message.includes('MIDI') ? message : `MIDI 导入失败：${message}`)
    this.name = 'MidiImportError'
    this.code = 'MIDI_IMPORT'
  }
}

const fail = (message) => {
  throw new MidiImportError(message)
}

/* ------------------------------------------------------------------------- */
/* 二进制读取                                                                  */
/* ------------------------------------------------------------------------- */

function readVarLen(buffer, offset, end = buffer.length) {
  let value = 0
  let bytes = 0
  for (;;) {
    if (offset + bytes >= end) fail('变长整数越界（文件被截断）')
    const byte = buffer[offset + bytes]
    value = (value << 7) | (byte & 0x7f)
    bytes += 1
    if ((byte & 0x80) === 0) break
    if (bytes > 4) fail('变长整数超过 4 字节（文件损坏）')
  }
  return { value, bytes }
}

const readUInt16 = (buffer, offset) => (buffer[offset] << 8) | buffer[offset + 1]
const readUInt32 = (buffer, offset) =>
  ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0
const readAscii = (buffer, offset, length) => buffer.toString('ascii', offset, offset + length)

/* ------------------------------------------------------------------------- */
/* SMF 解析                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * 解析单个 MTrk。
 * @returns {{name:string|null, notes:object[], programByChannel:Map, metas:object[], endTick:number}}
 */
function parseTrack(buffer, start, length, trackIndex) {
  const end = start + length
  let offset = start
  let tick = 0
  let lastTick = 0
  let endTick = 0
  let runningStatus = null
  let name = null
  const programByChannel = new Map()
  const metas = []
  const notes = []
  // R3b：CC / pitch bend / aftertouch / channel pressure 事件（按 channel 归属）。
  const controllers = []
  const open = new Map() // "channel:pitch" → { tick, velocity }

  while (offset < end) {
    const delta = readVarLen(buffer, offset, end)
    offset += delta.bytes
    tick += delta.value
    lastTick = tick

    if (offset >= end) fail(`第 ${trackIndex + 1} 轨事件缺少 status（文件被截断）`)
    let status = buffer[offset]
    if (status < 0x80) {
      if (runningStatus === null) fail(`第 ${trackIndex + 1} 轨 running status 未初始化（文件损坏）`)
      status = runningStatus
    } else {
      offset += 1
      if (status < 0xf0) runningStatus = status
    }

    if (status === 0xff) {
      if (offset >= end) fail(`第 ${trackIndex + 1} 轨 meta 缺少类型`)
      const type = buffer[offset]
      offset += 1
      const len = readVarLen(buffer, offset, end)
      offset += len.bytes
      if (offset + len.value > end) fail(`第 ${trackIndex + 1} 轨 meta 数据越界`)
      const data = buffer.subarray(offset, offset + len.value)
      offset += len.value
      if (type === 0x03) name = data.toString('utf8').replace(/\u0000/g, '').trim() || null
      else if (type === 0x51 || type === 0x58) metas.push({ tick, type, data: Buffer.from(data) })
      else if (type === 0x2f) {
        endTick = Math.max(endTick, tick)
        break
      }
      continue
    }
    if (status === 0xf0 || status === 0xf7) {
      const len = readVarLen(buffer, offset, end)
      offset += len.bytes
      if (offset + len.value > end) fail(`第 ${trackIndex + 1} 轨 sysex 数据越界`)
      offset += len.value
      continue
    }
    if (status >= 0xf0) fail(`第 ${trackIndex + 1} 轨不支持的 status 0x${status.toString(16)}`)

    const kind = status & 0xf0
    const channel = status & 0x0f
    if (kind === 0x90 || kind === 0x80) {
      if (offset + 1 >= end) fail(`第 ${trackIndex + 1} 轨 note 事件缺少参数`)
      const pitch = buffer[offset]
      const velocity = buffer[offset + 1]
      offset += 2
      const key = `${channel}:${pitch}`
      const isOn = kind === 0x90 && velocity > 0
      if (isOn) {
        if (open.has(key)) {
          const previous = open.get(key)
          notes.push({
            pitch,
            channel,
            velocity: previous.velocity,
            startTick: previous.tick,
            durTicks: Math.max(1, tick - previous.tick),
          })
        }
        open.set(key, { tick, velocity })
      } else {
        const startEvent = open.get(key)
        if (startEvent) {
          notes.push({
            pitch,
            channel,
            velocity: startEvent.velocity,
            startTick: startEvent.tick,
            durTicks: Math.max(1, tick - startEvent.tick),
          })
          open.delete(key)
        }
      }
      continue
    }
    if (kind === 0xb0) {
      if (offset + 1 >= end) fail(`第 ${trackIndex + 1} 轨 CC 事件参数越界`)
      controllers.push({
        tick,
        type: 'cc',
        channel,
        cc: buffer[offset],
        value: buffer[offset + 1],
      })
      offset += 2
      continue
    }
    if (kind === 0xa0) {
      if (offset + 1 >= end) fail(`第 ${trackIndex + 1} 轨 aftertouch 事件缺少参数`)
      controllers.push({
        tick,
        type: 'aftertouch',
        channel,
        note: buffer[offset],
        value: buffer[offset + 1],
      })
      offset += 2
      continue
    }
    if (kind === 0xe0) {
      if (offset + 1 >= end) fail(`第 ${trackIndex + 1} 轨 pitch bend 事件缺少参数`)
      const lsb = buffer[offset]
      const msb = buffer[offset + 1]
      controllers.push({
        tick,
        type: 'pitchBend',
        channel,
        value14: (msb << 7) | lsb,
      })
      offset += 2
      continue
    }
    if (kind === 0xc0) {
      if (offset >= end) fail(`第 ${trackIndex + 1} 轨 program change 越界`)
      if (!programByChannel.has(channel)) programByChannel.set(channel, buffer[offset])
      offset += 1
      continue
    }
    if (kind === 0xd0) {
      if (offset >= end) fail(`第 ${trackIndex + 1} 轨 channel pressure 越界`)
      controllers.push({
        tick,
        type: 'channelPressure',
        channel,
        value: buffer[offset],
      })
      offset += 1
      continue
    }
    fail(`第 ${trackIndex + 1} 轨未知事件 0x${status.toString(16)}`)
  }

  const trackEndTick = Math.max(endTick, lastTick)
  // 未闭合音符：按轨道末尾结束
  for (const [key, startEvent] of open) {
    const [channelText, pitchText] = key.split(':')
    notes.push({
      pitch: Number(pitchText),
      channel: Number(channelText),
      velocity: startEvent.velocity,
      startTick: startEvent.tick,
      durTicks: Math.max(1, trackEndTick - startEvent.tick),
    })
  }
  notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch)
  controllers.sort((a, b) => a.tick - b.tick)
  return { name, notes, programByChannel, metas, controllers, endTick: trackEndTick }
}

/**
 * 解析 SMF buffer。
 * @param {Buffer|Uint8Array} input
 * @returns {{format:number, ppq:number, tracks:object[], tempos:object[], timeSignature:object|null, endTick:number, noteCount:number}}
 */
export function parseMidiBuffer(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input ?? [])
  if (buffer.length === 0) fail('文件为空')
  if (buffer.length < 14) fail('文件过短（不是合法 MIDI）')
  const headerId = readAscii(buffer, 0, 4)
  if (headerId !== 'MThd') fail(`不是标准 MIDI 文件（缺少 MThd，实际 "${headerId}"）`)
  const headerLength = readUInt32(buffer, 4)
  if (headerLength < 6) fail(`header 长度非法（${headerLength}）`)
  const format = readUInt16(buffer, 8)
  if (format !== 0 && format !== 1) fail(`不支持的 MIDI Format ${format}（只支持 0/1）`)
  const ntrks = readUInt16(buffer, 10)
  if (ntrks === 0) fail('MIDI 没有轨道')
  if (ntrks > 256) fail(`MIDI 轨道数过多（${ntrks}）`)
  const divisionRaw = readUInt16(buffer, 12)
  if ((divisionRaw & 0x8000) !== 0) fail('不支持 SMPTE 时间码 MIDI（请导出为 PPQ）')
  const ppq = divisionRaw
  if (ppq <= 0) fail('MIDI PPQ 非法（0）')

  let offset = 8 + headerLength
  const parsedTracks = []
  const tempos = []
  let timeSignature = null
  let endTick = 0
  let noteCount = 0
  for (let index = 0; index < ntrks; index += 1) {
    if (offset + 8 > buffer.length) fail(`声明 ${ntrks} 轨，但第 ${index + 1} 轨缺少数据`)
    const chunkId = readAscii(buffer, offset, 4)
    if (chunkId !== 'MTrk') fail(`第 ${index + 1} 轨缺少 MTrk（实际 "${chunkId}"）`)
    const length = readUInt32(buffer, offset + 4)
    const start = offset + 8
    if (start + length > buffer.length) fail(`第 ${index + 1} 轨长度越界（文件被截断）`)
    const parsed = parseTrack(buffer, start, length, index)
    parsedTracks.push(parsed)
    endTick = Math.max(endTick, parsed.endTick)
    noteCount += parsed.notes.length
    offset = start + length
  }
  // 统一收集 tempo / 拍号
  for (const parsed of parsedTracks) {
    for (const meta of parsed.metas) {
      if (meta.type === 0x51 && meta.data.length === 3) {
        const microseconds = (meta.data[0] << 16) | (meta.data[1] << 8) | meta.data[2]
        if (microseconds > 0) tempos.push({ tick: meta.tick, bpm: 60000000 / microseconds, microsecondsPerQuarter: microseconds })
      } else if (meta.type === 0x58 && timeSignature === null && meta.data.length >= 2) {
        const numerator = meta.data[0]
        const denominator = 2 ** meta.data[1]
        if (numerator > 0 && denominator > 0) timeSignature = { numerator, denominator }
      }
    }
  }
  if (noteCount === 0) fail('MIDI 中没有音符（无可导入内容）')
  tempos.sort((a, b) => a.tick - b.tick || a.bpm - b.bpm)
  const dedupedTempos = []
  for (const tempo of tempos) {
    if (dedupedTempos.length && dedupedTempos[dedupedTempos.length - 1].tick === tempo.tick) {
      dedupedTempos[dedupedTempos.length - 1] = tempo
    } else {
      dedupedTempos.push(tempo)
    }
  }
  // 同一 MIDI 轨可能包含多个 channel（Format 0 常见）：按 channel 拆成多条 studio 轨
  const tracks = []
  for (const [index, parsed] of parsedTracks.entries()) {
    const byChannel = new Map()
    for (const note of parsed.notes) {
      if (!byChannel.has(note.channel)) byChannel.set(note.channel, [])
      byChannel.get(note.channel).push(note)
    }
    const channels = [...byChannel.keys()].sort((a, b) => a - b)
    for (const channel of channels) {
      const channelNotes = byChannel.get(channel)
      const baseName = parsed.name ?? `轨道 ${index + 1}`
      const name = channels.length > 1 ? `${baseName} · CH${channel + 1}` : baseName
      tracks.push({
        name,
        channel,
        program: parsed.programByChannel.get(channel) ?? 0,
        isDrum: channel === 9,
        // R3b：同 channel 的 CC/pitch bend/aftertouch 事件（CC-only 无音符轨不会走到这里）。
        controllers: (parsed.controllers ?? []).filter((event) => event.channel === channel),
        notes: channelNotes.map((note) => ({
          pitch: note.pitch,
          startTick: note.startTick,
          durTicks: note.durTicks,
          vel: Math.max(1, Math.min(127, note.velocity)),
        })),
      })
    }
  }
  return {
    format,
    ppq,
    tracks,
    tempos: dedupedTempos,
    timeSignature,
    endTick,
    noteCount,
  }
}

/* ------------------------------------------------------------------------- */
/* 构建工程                                                                    */
/* ------------------------------------------------------------------------- */

/** GM program → 音色家族 role。 */
function roleForProgram(program) {
  if (program >= 32 && program <= 39) return 'bass'
  if (program >= 40 && program <= 55) return 'pad'
  if (program >= 56 && program <= 95) return 'lead'
  if (program >= 8 && program <= 31) return 'keys'
  return 'keys'
}

/** GM program → 最近的采样乐器 id（按 soundfont.program 距离）。 */
export function nearestSampledPreset(program) {
  const target = Math.max(0, Math.min(127, Number(program) || 0))
  let best = SYNTH_PRESETS[0]
  let bestDistance = Math.abs(best.soundfont.program - target)
  for (const preset of SYNTH_PRESETS) {
    const distance = Math.abs(preset.soundfont.program - target)
    if (distance < bestDistance) {
      best = preset
      bestDistance = distance
    }
  }
  return best.id
}

/**
 * 把 parseMidiBuffer 结果构建成 schema2 工程。
 * @param {object} parsed
 * @param {{title?:string, baseBpm?:number}} [options]
 * @returns {{project:object, imported:{tracks:number,notes:number,patterns:number,clips:number,tempos:number,lengthBars:number,bpm:number}}}
 */
export function buildProjectFromMidi(parsed, options = {}) {
  if (parsed === null || typeof parsed !== 'object') fail('解析结果非法')
  const noteTracks = Array.isArray(parsed.tracks)
    ? parsed.tracks.filter((track) => track && Array.isArray(track.notes) && track.notes.length > 0)
    : []
  if (noteTracks.length === 0) fail('MIDI 中没有可导入的音符轨')
  const ppq = Number(parsed.ppq)
  if (!Number.isFinite(ppq) || ppq <= 0) fail('PPQ 非法')
  const timeSignature = parsed.timeSignature && Number(parsed.timeSignature.numerator) > 0
    ? [Number(parsed.timeSignature.numerator), Math.max(1, Number(parsed.timeSignature.denominator) || 4)]
    : [4, 4]
  const barBeats = Math.max(1, beatsPerBar({ timeSignature }))
  const endTick = Math.max(0, Number(parsed.endTick) || 0)
  const maxBeat = endTick / ppq
  const lengthBars = Math.min(LIMITS.maxBars, Math.max(1, Math.ceil(maxBeat / barBeats)))
  const firstTempo = Array.isArray(parsed.tempos) && parsed.tempos.length > 0 ? parsed.tempos[0].bpm : null
  const baseBpm = clampTempoBpm(firstTempo ?? options.baseBpm ?? 120)
  const title = typeof options.title === 'string' && options.title.trim() !== '' ? options.title.trim().slice(0, 120) : DEFAULT_MIDI_TITLE
  const project = createEmptyProject({ title, bpm: baseBpm, lengthBars, timeSignature })
  project.artist = 'MIDI 导入'
  project.composer = 'MIDI 导入'
  // 首 tempo 为 bpm，其余（含首点）转 tempoMap（beat = tick / PPQ）
  const tempoMap = normalizeTempoPoints(
    (Array.isArray(parsed.tempos) ? parsed.tempos : []).map((tempo) => ({ beat: Number(tempo.tick) / ppq, bpm: tempo.bpm })),
    { baseBpm, maxBeat },
  )
  if (tempoMap.length > 0) project.tempoMap = tempoMap

  const nextId = makeIdGen(project)
  let noteTotal = 0
  for (const midiTrack of noteTracks) {
    const isDrum = Boolean(midiTrack.isDrum)
    const trackId = nextId('trk')
    const name = typeof midiTrack.name === 'string' && midiTrack.name.trim() !== ''
      ? midiTrack.name.trim().slice(0, 80)
      : (isDrum ? '鼓组 · MIDI' : 'MIDI 轨')
    const track = isDrum
      ? makeTrack({ id: trackId, name, kind: 'drum', kit: 'smp_acoustic', role: 'drums' })
      : makeTrack({
        id: trackId,
        name,
        kind: 'synth',
        preset: nearestSampledPreset(midiTrack.program),
        role: roleForProgram(Number(midiTrack.program) || 0),
      })
    // R3b：把 CC/pitch bend/aftertouch 转成 track.automation（beat=tick/PPQ，value 归一 0..1）。
    const automationCurves = {}
    for (const event of midiTrack.controllers ?? []) {
      const beat = Math.max(0, Number(event.tick) / ppq)
      if (!Number.isFinite(beat) || beat > maxBeat + 1e-6) continue
      let param = null
      let value = null
      if (event.type === 'cc') {
        param = AUTOMATION_CC_PARAMS[event.cc] ?? null
        value = Math.max(0, Math.min(127, Number(event.value))) / 127
      } else if (event.type === 'pitchBend') {
        param = 'pitchBend'
        value = Math.max(0, Math.min(16383, Number(event.value14))) / 16383
      } else if (event.type === 'aftertouch' || event.type === 'channelPressure') {
        param = 'expression'
        value = Math.max(0, Math.min(127, Number(event.value))) / 127
      }
      if (param === null || !Number.isFinite(value)) continue
      if (automationCurves[param] === undefined) automationCurves[param] = { enabled: true, points: [] }
      automationCurves[param].points.push({ beat, value })
    }
    const trackAutomation = normalizeAutomation(automationCurves, { maxBeat: Math.max(1, maxBeat) })
    if (Object.keys(trackAutomation).length > 0) track.automation = trackAutomation
    const patternId = nextId('pat')
    const notes = []
    for (const note of midiTrack.notes) {
      const start = Math.max(0, Number(note.startTick) / ppq)
      if (start >= maxBeat + 1e-6) continue
      const dur = Math.max(0.02, Math.min(Number(note.durTicks) / ppq, maxBeat - start))
      const pitch = Math.max(0, Math.min(127, Math.round(Number(note.pitch) || 0)))
      const vel = Math.max(0.05, Math.min(1, (Number(note.vel) || 80) / 127))
      notes.push({ pitch, start: Math.round(start * 1e6) / 1e6, dur: Math.round(dur * 1e6) / 1e6, vel })
    }
    if (notes.length === 0) continue
    if (notes.length > LIMITS.maxNotesPerPattern) fail(`轨道「${name}」音符数 ${notes.length} 超过上限 ${LIMITS.maxNotesPerPattern}`)
    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    const pattern = makePattern({ id: patternId, name, lengthBars, notes })
    const clip = makeClip({ id: nextId('clip'), trackId, patternId, startBar: 0, lengthBars })
    project.tracks.push(track)
    project.patterns.push(pattern)
    project.clips.push(clip)
    noteTotal += notes.length
  }
  if (project.tracks.length === 0) fail('MIDI 中没有可导入的音符轨')
  project.lengthBars = Math.max(project.lengthBars, ...project.clips.map((clip) => clip.startBar + clip.lengthBars))
  return {
    project,
    imported: {
      tracks: project.tracks.length,
      notes: noteTotal,
      patterns: project.patterns.length,
      clips: project.clips.length,
      tempos: tempoMap.length,
      lengthBars: project.lengthBars,
      bpm: project.bpm,
      automationTracks: project.tracks.filter((track) => track.automation && Object.keys(track.automation).length > 0).length,
    },
  }
}

/* ------------------------------------------------------------------------- */
/* 与 state 集成（工具/路由共用）                                              */
/* ------------------------------------------------------------------------- */

/**
 * 解析 buffer 并导入到 state（replace 时先自动备份当前工程）。
 * @param {object} state createState() 实例
 * @param {{buffer:Buffer|Uint8Array, title?:string, replace?:boolean}} options
 */
export async function importMidiIntoState(state, options = {}) {
  const buffer = Buffer.isBuffer(options.buffer) ? options.buffer : Buffer.from(options.buffer ?? [])
  if (buffer.length === 0) fail('文件为空')
  if (buffer.length > MAX_MIDI_BYTES) fail(`MIDI 文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB，上限 10MB）`)
  const replace = options.replace !== false
  const parsed = parseMidiBuffer(buffer)
  const fallbackName = typeof options.name === 'string' && options.name.trim() !== ''
    ? options.name.trim().replace(/\.midi?$/i, '')
    : ''
  const title = typeof options.title === 'string' && options.title.trim() !== ''
    ? options.title.trim()
    : (fallbackName !== '' ? fallbackName : DEFAULT_MIDI_TITLE)
  const { project, imported } = buildProjectFromMidi(parsed, { title, baseBpm: state.project.bpm })
  let backup = null
  let warning = null
  if (replace) {
    try {
      // R0A：统一快照——命名工程写版本历史（可在工程历史里恢复），未命名写 _autobackup-*。
      if (state.activeName) {
        const version = await writeProjectVersion(state.dataDir, state.activeName, state.project)
        backup = { path: version.path, id: version.id, name: version.id }
      } else {
        backup = await writeAutobackup(state.dataDir, state.project)
      }
    } catch (error) {
      warning = `自动快照失败：${error?.message ?? error}`
    }
  }
  state.mutate(
    {
      tool: 'studio_import_midi',
      text: `导入 MIDI：${title}（${imported.tracks} 轨 / ${imported.notes} 音符${replace ? '，替换当前工程' : '，追加'}）`,
      activity: `正在导入 MIDI「${title}」`,
      undoLabel: '导入 MIDI',
    },
    (draft) => ops.applyMidiProject(draft, project, { replace }),
  )
  if (replace) state.setActiveProject(null, null)
  return {
    parsed,
    imported,
    backupPath: backup?.path ?? null,
    warning,
    title,
    replace,
  }
}
