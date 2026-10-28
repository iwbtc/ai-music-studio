/**
 * AI 音乐工作室 — 采样器支持（CC0 免费采样）。
 *
 * 采样文件放在 <项目根>/assets/samples/，由独立版服务器以 `/samples/<file>` 提供。
 * 采样来源：Sonic Pi 采样库（全部 CC0 / 公有领域），详见 assets/samples/LICENSES.md。
 *
 * 该模块在无 Web Audio 的 Node 环境下可安全 import（只做纯计算/数据）。
 */
import { DRUM_KITS, SYNTH_PRESETS, findDrumKit, findSynthPreset } from '../../shared/catalog.js'

/** 采样 URL 前缀（独立版服务器路由）。 */
export const SAMPLE_BASE = '/samples/'

/** 采样鼓件相对增益（让原声鼓/电子鼓采样混音平衡）。 */
const PIECE_GAIN = {
  kick: 1.0,
  snare: 0.85,
  clap: 0.62,
  rim: 0.42,
  hat: 0.42,
  openhat: 0.38,
  tomLow: 0.62,
  tomHigh: 0.58,
  crash: 0.5,
  ride: 0.42,
  perc: 0.52,
}

/** 采样鼓组里每个鼓件的文件名（供引擎/测试使用）。 */
export function samplerPieceFile(kitId, pieceId) {
  const kit = findDrumKit(kitId)
  return kit?.samplerPieces?.[pieceId] ?? null
}

/** 采样乐器对应的采样定义（preset.sampler）。 */
export function samplerForPreset(presetId) {
  return findSynthPreset(presetId)?.sampler ?? null
}

/**
 * 音高 → 播放速率（root 为原始音高，十二平均律）。
 * @param {number} pitch MIDI 音高
 * @param {number} root 采样原始音高
 */
export function samplePlaybackRate(pitch, root = 60) {
  return Math.pow(2, (Number(pitch) - Number(root)) / 12)
}

/** 收集一个工程用到的全部采样文件（去重）。 */
export function collectSampleFiles(project) {
  const files = new Set()
  for (const track of project?.tracks ?? []) {
    const instrument = track?.instrument ?? {}
    if (track?.kind === 'drum') {
      const kit = findDrumKit(instrument.kit)
      for (const file of Object.values(kit?.samplerPieces ?? {})) files.add(file)
    } else {
      const preset = findSynthPreset(instrument.preset)
      if (preset?.sampler?.file) files.add(preset.sampler.file)
    }
  }
  return [...files]
}

/** 目录里全部采样文件（用于启动时后台预加载）。 */
export function allSampleFiles() {
  const files = new Set()
  for (const preset of listSamplerPresets()) if (preset.sampler?.file) files.add(preset.sampler.file)
  for (const kit of listSamplerKits()) for (const file of Object.values(kit.samplerPieces ?? {})) files.add(file)
  return [...files]
}

function listSamplerPresets() {
  return SYNTH_PRESETS.filter((preset) => Boolean(preset?.sampler))
}

function listSamplerKits() {
  return DRUM_KITS.filter((kit) => Boolean(kit?.samplerPieces))
}

/**
 * 采样银行：fetch + decodeAudioData 缓存。
 * 同一个 AudioBuffer 可被实时 AudioContext 与 OfflineAudioContext 共用。
 */
export class SampleBank {
  /**
   * @param {{ fetchImpl?: typeof fetch }} [options]
   */
  constructor(options = {}) {
    this._fetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
    this._ctx = null
    this._buffers = new Map()
    this._pending = new Map()
    this._failed = new Set()
  }

  /** 设置用于 decodeAudioData 的上下文。 */
  setContext(ctx) {
    this._ctx = ctx
  }

  get context() {
    return this._ctx
  }

  get loadedCount() {
    return this._buffers.size
  }

  has(file) {
    return this._buffers.has(file)
  }

  get(file) {
    return this._buffers.get(file) ?? null
  }

  /**
   * 加载并解码一个采样文件。
   * @param {string} file 文件名（如 'bd_808.flac'）
   * @returns {Promise<AudioBuffer|null>}
   */
  async load(file) {
    if (this._buffers.has(file)) return this._buffers.get(file)
    if (this._failed.has(file) || !this._ctx || !this._fetch) return null
    if (this._pending.has(file)) return this._pending.get(file)
    const task = (async () => {
      try {
        const res = await this._fetch(`${SAMPLE_BASE}${encodeURIComponent(file)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.arrayBuffer()
        const buffer = await this._ctx.decodeAudioData(data)
        this._buffers.set(file, buffer)
        return buffer
      } catch {
        this._failed.add(file)
        return null
      } finally {
        this._pending.delete(file)
      }
    })()
    this._pending.set(file, task)
    return task
  }

  /**
   * 预加载一批采样文件（并行，失败静默）。
   * @param {string[]} files
   * @returns {Promise<number>} 成功数量
   */
  async preload(files) {
    if (!this._ctx || !files?.length) return 0
    const results = await Promise.all(files.map((file) => this.load(file)))
    return results.filter(Boolean).length
  }

  /** 预加载工程用到的采样。 */
  async preloadForProject(project) {
    return this.preload(collectSampleFiles(project))
  }
}

/**
 * 构建一个采样音符 voice。
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @param {{pitch:number, vel?:number, startTime:number, dur?:number}} note
 * @param {{file:string, root?:number, loop?:boolean, gain?:number, attack?:number, release?:number}} sampler
 * @param {{bank:SampleBank, pan?:number}} opts
 * @returns {{endTime:number, stop:(at?:number)=>void, release:()=>void}|null}
 */
export function buildSampleVoice(ctx, destination, note, sampler, opts = {}) {
  const bank = opts.bank
  if (!bank || !sampler?.file) return null
  const buffer = bank.get(sampler.file)
  if (!buffer) return null

  const t0 = Math.max(0, Number(note.startTime) || 0)
  const vel = Math.min(1, Math.max(0, Number(note.vel) ?? 0.8))
  const gainValue = Math.max(0, Math.min(1.5, Number(sampler.gain) ?? 0.85))
  // CONTRACT-R0-10：采样预设响度归一基线（未知 → 1）
  const outputGain = Math.max(0.01, Math.min(64, Number(opts.gainScale) || 1))
  const attack = Math.max(0.001, Number(sampler.attack) ?? 0.004)
  const release = Math.max(0.02, Number(sampler.release) ?? Math.max(0.08, Number(sampler.tail) ?? 0.4))

  const src = ctx.createBufferSource()
  src.buffer = buffer
  const rate = samplePlaybackRate(note.pitch, sampler.root ?? 60)
  src.playbackRate.value = Math.min(8, Math.max(0.06, rate))
  src.loop = Boolean(sampler.loop)

  const gain = ctx.createGain()
  const peak = Math.max(0.0001, vel * gainValue * outputGain)
  const dur = Math.max(0.05, Number(note.dur) || 0.4)
  const playSeconds = Math.max(dur, release)
  const stopAt = t0 + playSeconds + 0.02
  try {
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.linearRampToValueAtTime(peak, t0 + attack)
    if (sampler.loop) {
      gain.gain.setValueAtTime(peak * 0.92, t0 + Math.max(attack, playSeconds - release))
      gain.gain.linearRampToValueAtTime(0.0001, t0 + playSeconds)
    } else {
      const decayStart = Math.max(t0 + attack, t0 + playSeconds - release)
      gain.gain.setValueAtTime(peak, decayStart)
      gain.gain.linearRampToValueAtTime(0.0001, t0 + playSeconds)
    }
  } catch {
    gain.gain.value = peak
  }

  src.connect(gain)
  gain.connect(destination)
  try {
    src.start(t0)
    src.stop(stopAt)
  } catch {
    return null
  }
  return {
    endTime: stopAt,
    stop(at) {
      try {
        src.stop(at ?? t0)
      } catch {
        /* already stopped */
      }
    },
    release() {
      /* 采样 voice 需要自然释放，这里不提前切断，交给调度结束时间 */
    },
  }
}

/**
 * 构建一个采样鼓击（鼓件采样不改变音高）。
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @param {{startTime:number, vel?:number, pieceId:string}} hit
 * @param {{level?:number, drive?:number}} kitParams
 * @param {{bank:SampleBank, kitId:string, pan?:number}} opts
 * @returns {{endTime:number, stop:(at?:number)=>void, release:()=>void}|null}
 */
export function buildSampleDrum(ctx, destination, hit, kitParams, opts = {}) {
  const file = samplerPieceFile(opts.kitId, hit.pieceId)
  if (!file) return null
  const bank = opts.bank
  if (!bank || !bank.has(file)) return null
  const buffer = bank.get(file)
  const t0 = Math.max(0, Number(hit.startTime) || 0)
  const vel = Math.min(1, Math.max(0, Number(hit.vel) ?? 0.8))
  const pieceGain = PIECE_GAIN[hit.pieceId] ?? 0.5
  const kitLevel = Math.min(1, Math.max(0, Number(kitParams?.level) ?? 0.8))
  // CONTRACT-R0-10：采样鼓机响度归一基线（未知 → 1）
  const outputGain = Math.max(0.01, Math.min(64, Number(opts.gainScale) || 1))
  const peak = Math.max(0.0001, vel * pieceGain * (0.55 + kitLevel * 0.6) * outputGain)

  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.playbackRate.value = 1
  const gain = ctx.createGain()
  gain.gain.value = peak
  src.connect(gain)
  gain.connect(destination)
  const t1 = t0 + 0.01
  try {
    src.start(t0)
    src.stop(t1 + buffer.duration)
  } catch {
    return null
  }
  return {
    endTime: t1 + buffer.duration,
    stop(at) {
      try {
        src.stop(at ?? t0)
      } catch {
        /* ignore */
      }
    },
    release() {
      /* 采样自然衰减 */
    },
  }
}
