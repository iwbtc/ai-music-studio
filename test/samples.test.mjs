/**
 * 采样鼓机单元测试（采样乐器预设已按用户要求移除，仅保留 CC0 采样鼓组）：
 * - 采样目录与 catalog 引用一致（每个 samplerPieces 文件都存在且非空）
 * - 音高 → 播放速率换算
 * - collectSampleFiles / allSampleFiles 去重与覆盖
 * - buildSampleVoice / buildSampleDrum 在 mock Web Audio 上的节点连接与参数行为
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  SampleBank,
  buildSampleVoice,
  buildSampleDrum,
  samplePlaybackRate,
  collectSampleFiles,
  allSampleFiles,
  samplerPieceFile,
  samplerForPreset,
} from '../src/client/audio/samples.js'
import { DRUM_KITS } from '../src/shared/catalog.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLES_DIR = join(ROOT, 'assets', 'samples')

const samplerKits = DRUM_KITS.filter((kit) => kit.samplerPieces)

function assertSampleFile(file) {
  const path = join(SAMPLES_DIR, file)
  assert.ok(existsSync(path), `采样文件不存在：${file}`)
  assert.ok(statSync(path).size > 1000, `采样文件过小/为空：${file}`)
}

test('采样目录：所有采样鼓组的文件都存在且非空', () => {
  assert.ok(samplerKits.length >= 3, `采样鼓组数量 ${samplerKits.length} < 3`)
  for (const kit of samplerKits) {
    for (const file of Object.values(kit.samplerPieces)) assertSampleFile(file)
  }
})

test('采样引用查询：采样乐器已移除；samplerPieceFile 正常', () => {
  // 用户反馈采样乐器听起来不像真实乐器，已从 catalog 删除（保留采样鼓组）
  assert.equal(samplerForPreset('smp_piano'), null)
  assert.equal(samplerForPreset('smp_pad'), null)
  assert.equal(samplerForPreset('supersaw'), null)
  assert.equal(samplerPieceFile('smp_acoustic', 'kick'), 'drum_bass_hard.flac')
  assert.equal(samplerPieceFile('neon808', 'kick'), null)
})

test('采样音高换算：root 原速、八度 2x、低八度 0.5x', () => {
  assert.equal(samplePlaybackRate(60, 60), 1)
  assert.equal(samplePlaybackRate(72, 60), 2)
  assert.equal(samplePlaybackRate(48, 60), 0.5)
  assert.ok(Math.abs(samplePlaybackRate(64, 60) - Math.pow(2, 4 / 12)) < 1e-12)
})

test('采样文件收集：collectSampleFiles 去重且只包含用到的文件', () => {
  const project = {
    tracks: [
      { instrument: { preset: 'supersaw' } },
      { kind: 'drum', instrument: { kit: 'smp_electro' } },
      { kind: 'drum', instrument: { kit: 'neon808' } },
    ],
  }
  const files = collectSampleFiles(project)
  assert.ok(files.includes('bd_808.flac'))
  assert.ok(files.includes('elec_snare.flac'))
  assert.equal(files.length, new Set(files).size)
  const all = allSampleFiles()
  assert.ok(all.length >= 30, `全部采样文件 ${all.length} < 30`)
  assert.equal(all.length, new Set(all).size)
  for (const file of all) assertSampleFile(file)
})

/** 极简 mock：只记录调用关系，足以验证采样 voice 的图连接与参数。 */
function createMockContext() {
  const created = []
  const ctx = {
    currentTime: 0,
    sampleRate: 44100,
    created,
    createBufferSource() {
      const node = {
        buffer: null,
        playbackRate: { value: 1 },
        loop: false,
        started: null,
        stopped: null,
        connect(target) { node.connectedTo = target; return target },
        start(at) { node.started = at },
        stop(at) { node.stopped = at },
      }
      created.push(node)
      return node
    },
    createGain() {
      const node = {
        gainValue: 1,
        gain: {
          value: 1,
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          setTargetAtTime() {},
        },
        connect(target) { node.connectedTo = target; return target },
      }
      created.push(node)
      return node
    },
  }
  return ctx
}

function createBank(files) {
  const ctx = createMockContext()
  const bank = new SampleBank({ fetchImpl: null })
  bank.setContext(ctx)
  for (const [file, duration] of Object.entries(files)) {
    bank._buffers.set(file, { duration, numberOfChannels: 1 })
  }
  return bank
}

test('buildSampleVoice：按音高设置 playbackRate、连接增益、按时启动/停止', () => {
  const ctx = createMockContext()
  const bank = createBank({ 'drum_bass_hard.flac': 2.5 })
  const dest = { name: 'dest' }
  const handle = buildSampleVoice(
    ctx,
    dest,
    { pitch: 72, vel: 0.8, startTime: 1, dur: 0.5 },
    { file: 'drum_bass_hard.flac', root: 60, gain: 0.8, attack: 0.01, release: 0.3 },
    { bank },
  )
  assert.ok(handle)
  const src = ctx.created.find((node) => 'playbackRate' in node)
  assert.ok(src)
  assert.equal(src.playbackRate.value, 2) // 72-60 = 一个八度
  assert.equal(src.buffer.numberOfChannels, 1)
  assert.equal(src.started, 1)
  assert.ok(src.stopped > 1)
  assert.ok(handle.endTime > 1)
})

test('buildSampleVoice：采样未加载/未知文件时安全返回 null', () => {
  const ctx = createMockContext()
  const bank = createBank({})
  assert.equal(
    buildSampleVoice(ctx, {}, { pitch: 60, startTime: 0, dur: 0.5 }, { file: 'missing.flac' }, { bank }),
    null,
  )
  assert.equal(buildSampleVoice(ctx, {}, { pitch: 60, startTime: 0, dur: 0.5 }, null, { bank }), null)
})

test('buildSampleDrum：使用鼓件对应采样、按鼓件增益缩放', () => {
  const ctx = createMockContext()
  const bank = createBank({ 'bd_808.flac': 1.2, 'hat_zan.flac': 0.3 })
  const dest = { name: 'dest' }
  const kick = buildSampleDrum(
    ctx,
    dest,
    { startTime: 2, vel: 1, pieceId: 'kick' },
    { level: 0.8 },
    { bank, kitId: 'smp_electro' },
  )
  assert.ok(kick)
  const src = ctx.created.find((node) => 'playbackRate' in node)
  assert.equal(src.buffer.duration, 1.2)
  assert.equal(src.playbackRate.value, 1)
  assert.ok(kick.endTime > 2)
  // 非采样鼓件返回 null（neon808 没有 samplerPieces）
  assert.equal(
    buildSampleDrum(ctx, dest, { startTime: 0, vel: 1, pieceId: 'kick' }, { level: 1 }, { bank, kitId: 'neon808' }),
    null,
  )
})

test('SampleBank：fetch/decode 失败后不会重复请求（缓存失败）', async () => {
  let calls = 0
  const bank = new SampleBank({
    fetchImpl: async () => {
      calls += 1
      throw new Error('network down')
    },
  })
  bank.setContext({ decodeAudioData: async () => ({ duration: 1 }) })
  assert.equal(await bank.load('x.flac'), null)
  assert.equal(await bank.load('x.flac'), null)
  assert.equal(calls, 1)
})
