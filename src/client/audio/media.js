/**
 * 音频媒体支持（audio-engine，CONTRACT-P3B §3 / R2a / R2b）。
 *
 * - MediaBank：从 `/studio/api/media/<file>` fetch + decodeAudioData，按
 *   mediaId+file+内容指纹 缓存；R2b 追加 stretch/pitch 处理后的 AudioBuffer 缓存。
 * - buildAudioClipSegments：把 audio 轨的音频片段裁剪到播放/渲染区间（纯函数，可单测）。
 *
 * 本模块在无 Web Audio 的 Node 环境下可安全 import（不自动创建 AudioContext）。
 */
import { beatsPerBar } from '../../shared/model.js'
import {
  processClipAudio,
  normalizeStretchRatio,
  normalizeSemitones,
  isIdentityProcess,
} from './stretch.js'

/** R2b：clip 拉伸/变调范围（与 Host 契约一致）。 */
export const CLIP_STRETCH_RATIO_MIN = 0.25
export const CLIP_STRETCH_RATIO_MAX = 4
export const CLIP_SEMITONES_MIN = -12
export const CLIP_SEMITONES_MAX = 12

/** 媒体文件 URL 前缀（Host webServer prefix route）。 */
export const MEDIA_BASE = '/studio/api/media/'

/** 媒体文件 URL（file 仅文件名，做编码防路径穿越）。 */
export function mediaUrlFor(file) {
  return `${MEDIA_BASE}${encodeURIComponent(String(file ?? ''))}`
}

/** FNV-1a 32 位哈希（媒体内容指纹用）。 */
export function fnv1a(text) {
  let hash = 0x811c9dc5
  const value = String(text)
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

/**
 * 媒体内容身份（缓存键的一部分）：mediaId+file+bytes+时长+声道/采样率+peaks 指纹。
 * 跨工程重新导入时 media id/file 可能重复（甚至落盘文件被覆盖），但 peaks/bytes
 * 等元数据能区分内容；缺元数据的旧工程退化为 mediaId+file。
 */
export function mediaIdentity(entry) {
  if (!entry || typeof entry !== 'object') return ''
  const parts = [
    entry.id,
    entry.file,
    entry.bytes,
    entry.durationSeconds,
    entry.channels,
    entry.sampleRate,
  ].map((value) => (value === null || value === undefined ? '' : String(value)))
  const peaks = Array.isArray(entry.peaks) ? entry.peaks : null
  if (peaks && peaks.length) {
    const fingerprint = peaks.map((value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(4) : 'x')).join(',')
    parts.push(`${peaks.length}:${fnv1a(fingerprint)}`)
  } else {
    parts.push('')
  }
  return parts.join('\u0000')
}

/**
 * 收集工程里可加载的媒体文件。
 * @returns {Array<{mediaId:string, file:string, identity:string}>}
 */
export function collectMediaFiles(project) {
  const out = []
  const media = Array.isArray(project?.media) ? project.media : []
  for (const entry of media) {
    if (!entry || typeof entry !== 'object') continue
    const rawId = entry.id
    const mediaId = rawId === null || rawId === undefined ? null : String(rawId)
    const file = typeof entry.file === 'string' && entry.file ? entry.file : null
    if (mediaId && file) out.push({ mediaId, file, identity: mediaIdentity(entry) })
  }
  return out
}

/** mediaId → 元数据 durationSeconds（有限正数才收录）。 */
export function mediaDurationMap(project) {
  const map = new Map()
  const media = Array.isArray(project?.media) ? project.media : []
  for (const entry of media) {
    if (!entry || typeof entry !== 'object') continue
    const rawId = entry.id
    const mediaId = rawId === null || rawId === undefined ? null : String(rawId)
    const duration = Number(entry.durationSeconds)
    if (mediaId && Number.isFinite(duration) && duration > 0) map.set(mediaId, duration)
  }
  return map
}

/**
 * 媒体银行：fetch + decodeAudioData 缓存（类似 SampleBank）。
 *
 * 缓存身份 = mediaId + file 复合键：不同工程/重新导入时 media id 会从 `med_1`
 * 重新编号，但文件可能不同；同 id 不同 file 必须视为不同媒体，不能复用旧 buffer
 * （否则切工程后播放/导出会串媒体，reverse 缓存同样会错）。
 */
export class MediaBank {
  /**
   * @param {{fetchImpl?: typeof fetch, decodeAudioData?: (data:ArrayBuffer)=>Promise<AudioBuffer>}} [options]
   */
  constructor(options = {}) {
    const fetchImpl = Object.prototype.hasOwnProperty.call(options, 'fetchImpl') ? options.fetchImpl : undefined
    this._fetch = fetchImpl !== undefined ? fetchImpl : typeof fetch === 'function' ? fetch.bind(globalThis) : null
    this._decode = typeof options.decodeAudioData === 'function' ? options.decodeAudioData : null
    this._ctx = null
    /** 媒体缓存：`mediaId\0file` → AudioBuffer。 */
    this._buffers = new Map()
    /** mediaId → 最近一次 load 的缓存键（仅用于 `get(mediaId)` 旧调用兼容）。 */
    this._latestKeyById = new Map()
    this._pending = new Map()
    this._failed = new Set()
    /** CONTRACT-R2a：反转后的 AudioBuffer 缓存（媒体缓存键 → AudioBuffer，不修改原 buffer）。 */
    this._reversed = new Map()
    /** CONTRACT-R2b：stretch/semitones 处理后的 AudioBuffer 缓存（processedKey → AudioBuffer）。 */
    this._processed = new Map()
  }

  /** 媒体缓存键：mediaId + file + 内容身份哈希（同 id/文件但内容不同也不串用）。 */
  static cacheKey(mediaId, file, identity, sampleRate) {
    const id = mediaId === null || mediaId === undefined ? '' : String(mediaId)
    const fileName = file === null || file === undefined ? '' : String(file)
    const identityHash = identity ? fnv1a(identity) : ''
    const rate = Number(sampleRate) > 0 ? `|sr${Math.round(Number(sampleRate))}` : ''
    return `${id}\u0000${fileName}\u0000${identityHash}${rate}`
  }

  /** 解析缓存键：优先 file（有 identity 时用身份哈希；缺失时回退最近加载）。 */
  _keyFor(mediaId, file, identity, sampleRate) {
    const id = mediaId === null || mediaId === undefined ? '' : String(mediaId)
    if (!id) return null
    if (file !== null && file !== undefined && String(file) !== '') return MediaBank.cacheKey(id, file, identity, sampleRate)
    return this._latestKeyById.get(id) ?? null
  }

  /** 旧无身份缓存键（兼容测试/旧调用）。 */
  _legacyKeyFor(mediaId, file, sampleRate) {
    return MediaBank.cacheKey(mediaId, file, '', sampleRate)
  }

  /** 设置用于 decodeAudioData / createBuffer 的 AudioContext（实时或临时解码 ctx）。 */
  setContext(ctx) {
    this._ctx = ctx || null
  }

  get context() {
    return this._ctx
  }

  get loadedCount() {
    return this._buffers.size
  }

  /** 是否存在缓存媒体（file/identity/sampleRate 精确匹配；不传 file 时看该 id 最近加载）。 */
  has(mediaId, file, identity, sampleRate) {
    return this.get(mediaId, file, identity, sampleRate) !== null
  }

  /**
   * 取缓存媒体。
   * - 传 file：优先按 identity(+采样率) 精确键，找不到回退无采样率/无身份旧键（兼容旧调用）；
   * - 不传 file：返回该 id 最近加载的 buffer（兼容旧调用）。
   */
  get(mediaId, file, identity, sampleRate) {
    const key = this._keyFor(mediaId, file, identity, sampleRate)
    if (key === null) return null
    const exact = this._buffers.get(key)
    if (exact) return exact
    if (file !== null && file !== undefined && String(file) !== '') {
      const noRate = this._buffers.get(MediaBank.cacheKey(mediaId, file, identity, null))
      if (noRate) return noRate
      return (
        this._buffers.get(this._legacyKeyFor(mediaId, file, sampleRate)) ??
        this._buffers.get(this._legacyKeyFor(mediaId, file)) ??
        null
      )
    }
    return null
  }

  /**
   * CONTRACT-R2a：取媒体反转后的 AudioBuffer（缓存键与原始媒体一致）。
   * 未加载 / 无 AudioContext（无法 createBuffer）→ null。
   * @param {string} mediaId
   * @param {string} [file] 媒体文件名（跨工程必须传）
   * @param {string} [identity] 媒体内容身份（跨工程同 file 不同内容时必须传）
   * @returns {AudioBuffer|null}
   */
  getReversed(mediaId, file, identity, sampleRate) {
    if (file === null || file === undefined || String(file) === '') {
      const latestKey = this._latestKeyById.get(mediaId === null || mediaId === undefined ? '' : String(mediaId))
      if (!latestKey) return null
      return this._reversed.get(latestKey) ?? this._createReversed(latestKey)
    }
    const candidates = [
      MediaBank.cacheKey(mediaId, file, identity, sampleRate),
      MediaBank.cacheKey(mediaId, file, identity, null),
      this._legacyKeyFor(mediaId, file, sampleRate),
      this._legacyKeyFor(mediaId, file),
    ]
    const key = candidates.find((candidate) => this._buffers.has(candidate))
    if (!key) return null
    if (this._reversed.has(key)) return this._reversed.get(key)
    return this._createReversed(key)
  }

  /** 由缓存键对应的原 buffer 生成反转 buffer（内部）。 */
  _createReversed(key) {
    const source = this._buffers.get(key)
    if (!source) return null
    const ctx = this._ctx
    if (!ctx || typeof ctx.createBuffer !== 'function') return null
    let out = null
    try {
      const channels = Math.max(1, Number(source.numberOfChannels) || 1)
      const length = Math.max(0, Number(source.length) || 0)
      if (length <= 0) return null
      out = ctx.createBuffer(channels, length, source.sampleRate)
      for (let channel = 0; channel < channels; channel++) {
        const from = source.getChannelData(channel)
        const to = out.getChannelData(channel)
        for (let i = 0; i < length; i++) to[i] = from[length - 1 - i] || 0
      }
    } catch {
      out = null
    }
    this._reversed.set(key, out)
    return out
  }

  /** R2b 处理缓存键：媒体键（含采样率）+ stretchRatio + semitones + reverse。 */
  static processedKey(mediaId, file, identity, options = {}) {
    const ratio = normalizeStretchRatio(options.stretchRatio)
    const semitones = normalizeSemitones(options.semitones)
    const reverse = options.reverse === true ? 1 : 0
    return `${MediaBank.cacheKey(mediaId, file, identity, options.sampleRate)}|r${ratio}|s${semitones}|rev${reverse}`
  }

  /** 根据媒体缓存键拿原始/反转 buffer（processed 计算用）。 */
  _sourceBufferFor(mediaId, file, identity, reverse, sampleRate) {
    if (file === null || file === undefined || String(file) === '') {
      const id = mediaId === null || mediaId === undefined ? '' : String(mediaId)
      const latestKey = this._latestKeyById.get(id)
      if (!latestKey) return null
      return reverse ? this._reversed.get(latestKey) ?? this._createReversed(latestKey) : this._buffers.get(latestKey) ?? null
    }
    const candidates = [
      MediaBank.cacheKey(mediaId, file, identity, sampleRate),
      MediaBank.cacheKey(mediaId, file, identity, null),
      this._legacyKeyFor(mediaId, file, sampleRate),
      this._legacyKeyFor(mediaId, file),
    ]
    const key = candidates.find((candidate) => this._buffers.has(candidate))
    if (!key) return null
    if (reverse) return this._reversed.has(key) ? this._reversed.get(key) : this._createReversed(key)
    return this._buffers.get(key) ?? null
  }

  /**
   * CONTRACT-R2b：取 stretch/pitch 处理后的 AudioBuffer（按媒体+参数缓存；不修改原 buffer）。
   * ratio=1 且 semitones=0 时直接返回原 buffer（reverse 时返回反转 buffer），与 R2a 完全一致。
   * 处理需要 AudioContext（createBuffer）；未加载/无 ctx → null。
   * @param {string} mediaId
   * @param {string} file
   * @param {string} identity
   * @param {{stretchRatio?:number, semitones?:number, reverse?:boolean}} [options]
   * @returns {AudioBuffer|null}
   */
  getProcessed(mediaId, file, identity, options = {}) {
    const ratio = normalizeStretchRatio(options.stretchRatio)
    const semitones = normalizeSemitones(options.semitones)
    const reverse = options.reverse === true
    const sampleRate = Number(options.sampleRate) > 0 ? Number(options.sampleRate) : undefined
    if (isIdentityProcess({ stretchRatio: ratio, semitones })) {
      return reverse ? this.getReversed(mediaId, file, identity, sampleRate) : this.get(mediaId, file, identity, sampleRate)
    }
    const key = MediaBank.processedKey(mediaId, file, identity, { stretchRatio: ratio, semitones, reverse, sampleRate })
    if (this._processed.has(key)) return this._processed.get(key)
    const source = this._sourceBufferFor(mediaId, file, identity, reverse, sampleRate)
    if (!source) return null
    const ctx = this._ctx
    if (!ctx || typeof ctx.createBuffer !== 'function') return null
    let out = null
    try {
      const channelCount = Math.max(1, Number(source.numberOfChannels) || 1)
      const channels = []
      for (let channel = 0; channel < channelCount; channel++) {
        channels.push(Float32Array.from(source.getChannelData(channel) ?? []))
      }
      const processed = processClipAudio(channels, { stretchRatio: ratio, semitones })
      const length = processed[0]?.length ?? 0
      if (length <= 0) return null
      out = ctx.createBuffer(processed.length, length, source.sampleRate)
      for (let channel = 0; channel < processed.length; channel++) {
        out.getChannelData(channel).set(processed[channel])
      }
    } catch {
      out = null
    }
    this._processed.set(key, out)
    return out
  }

  /**
   * R2b：为工程的音频片段预计算 stretch/pitch 变体（实时/离线共用），避免首次调度时卡顿。
   * @param {object} project
   * @returns {Promise<number>} 预计算/命中的变体数
   */
  async ensureProcessedForProject(project, sampleRate) {
    if (!this._ctx || typeof this._ctx.createBuffer !== 'function') return 0
    const sr = Number(sampleRate) > 0 ? Math.round(Number(sampleRate)) : undefined
    // 音频轨集合 + 媒体条目映射
    const audioTrackIds = new Set()
    for (const track of project?.tracks ?? []) {
      if (track && track.kind === 'audio' && track.id !== undefined) audioTrackIds.add(String(track.id))
    }
    const mediaById = new Map()
    for (const entry of project?.media ?? []) {
      if (!entry || typeof entry !== 'object' || entry.id === undefined || entry.id === null) continue
      const mediaId = String(entry.id)
      const file = typeof entry.file === 'string' && entry.file ? entry.file : null
      if (!file) continue
      mediaById.set(mediaId, { file, identity: mediaIdentity(entry) })
    }
    const variants = new Map()
    for (const clip of project?.clips ?? []) {
      if (!clip || !clip.mediaId || !audioTrackIds.has(String(clip.trackId))) continue
      const media = mediaById.get(String(clip.mediaId))
      if (!media) continue
      const ratio = normalizeStretchRatio(clip.stretchRatio)
      const semitones = normalizeSemitones(clip.semitones)
      const reverse = clip.reverse === true
      if (isIdentityProcess({ stretchRatio: ratio, semitones }) && !reverse) continue
      const key = MediaBank.processedKey(clip.mediaId, media.file, media.identity, { stretchRatio: ratio, semitones, reverse, sampleRate: sr })
      variants.set(key, { mediaId: String(clip.mediaId), file: media.file, identity: media.identity, ratio, semitones, reverse })
    }
    let done = 0
    for (const variant of variants.values()) {
      if (!this.get(variant.mediaId, variant.file, variant.identity, sr)) {
        await this.load(variant.mediaId, variant.file, variant.identity, sr)
      }
      const options = { stretchRatio: variant.ratio, semitones: variant.semitones, reverse: variant.reverse, sampleRate: sr }
      if (this.getProcessed(variant.mediaId, variant.file, variant.identity, options)) done += 1
      // 让出主线程，避免长媒体处理阻塞 UI
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return done
  }

  /** 清空缓存/失败记录（测试或重新加载用）；反转/处理缓存一并清空。 */
  clear() {
    this._buffers.clear()
    this._latestKeyById.clear()
    this._pending.clear()
    this._failed.clear()
    this._reversed.clear()
    this._processed.clear()
  }

  _decoder() {
    if (this._decode) return this._decode
    if (this._ctx && typeof this._ctx.decodeAudioData === 'function') return this._ctx.decodeAudioData.bind(this._ctx)
    return null
  }

  /**
   * 加载并解码一个媒体文件；失败返回 null（缓存失败避免重复请求），不抛异常。
   * 缓存键 = mediaId + file + 内容身份哈希（同 id/文件但内容不同会分别加载）。
   * @param {string} mediaId
   * @param {string} file
   * @param {string} [identity] 媒体内容身份（mediaIdentity(entry)）
   * @returns {Promise<AudioBuffer|null>}
   */
  async load(mediaId, file, identity, sampleRate) {
    const id = mediaId === null || mediaId === undefined ? '' : String(mediaId)
    if (!id) return null
    if (!file) return null
    const sr = Number(sampleRate) > 0 ? Math.round(Number(sampleRate)) : undefined
    const cacheKey = MediaBank.cacheKey(id, file, identity, sr)
    if (this._buffers.has(cacheKey)) {
      this._latestKeyById.set(id, cacheKey)
      return this._buffers.get(cacheKey)
    }
    if (this._failed.has(cacheKey)) return null
    if (!this._fetch) return null
    const decode = this._decoder()
    if (!decode) return null
    if (this._pending.has(cacheKey)) return this._pending.get(cacheKey)
    const task = (async () => {
      try {
        const response = await this._fetch(mediaUrlFor(file))
        if (!response || response.ok === false) throw new Error(`HTTP ${response?.status ?? 0}`)
        const data = await response.arrayBuffer()
        const buffer = await decode(data)
        if (!buffer) throw new Error('decode failed')
        this._buffers.set(cacheKey, buffer)
        this._latestKeyById.set(id, cacheKey)
        return buffer
      } catch {
        this._failed.add(cacheKey)
        return null
      } finally {
        this._pending.delete(cacheKey)
      }
    })()
    this._pending.set(cacheKey, task)
    return task
  }

  /** 预加载一批 {mediaId,file,identity?}（并行，失败静默；sampleRate 用于解码目标采样率）。 */
  async preload(entries, sampleRate) {
    if (!this._decoder() || !this._fetch || !Array.isArray(entries) || entries.length === 0) return 0
    const results = await Promise.all(entries.map((entry) => this.load(entry.mediaId, entry.file, entry.identity, sampleRate)))
    return results.filter(Boolean).length
  }

  /** 预加载工程用到的全部音频媒体（可指定解码采样率，保证离线渲染无重采样 ⇒ 可复现）。 */
  async preloadForProject(project, sampleRate) {
    return this.preload(collectMediaFiles(project), sampleRate)
  }
}

/** 最小值：短于该秒数的裁剪片段不调度。 */
export const MIN_AUDIO_CLIP_SECONDS = 0.01

/** CONTRACT-R2a：音频 clip 电平范围（dB）。 */
export const CLIP_GAIN_DB_MIN = -24
export const CLIP_GAIN_DB_MAX = 24
/** CONTRACT-R2a：fade in/out 单侧上限（秒）。 */
export const CLIP_FADE_SECONDS_MAX = 10

/** clip.gainDb 规范化：非有限数/缺省 → 0，钳制 [-24,24]。 */
export function normalizeClipGainDb(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0
  return Math.max(CLIP_GAIN_DB_MIN, Math.min(CLIP_GAIN_DB_MAX, value))
}

/** clip.fadeInSeconds/fadeOutSeconds 规范化：非有限数/负值 → 0，钳制 [0,10]。 */
export function normalizeClipFadeSeconds(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(0, Math.min(CLIP_FADE_SECONDS_MAX, value))
}

/**
 * CONTRACT-R2a/R2b：计算片段在「实际播放窗口」内的增益包络点（相对片段起点）。
 *
 * - R2b：fade 在 timeline/输出播放窗口上定义（fadeIn = [0, fadeIn]，
 *   fadeOut = [playDur-fadeOut, playDur]，单位 output 秒）；
 * - 片段被渲染区间裁剪时（从 fade 中间开始/结束），首/尾取对应包络值，不重新从 0 淡入；
 * - ratio=1 时与 R2a 的媒体时间轴结果完全一致（playStart = offset - trim）；
 * - 返回按 time 升序的 `[{time, gain}]`（time 秒，相对片段 start；gain 线性倍数）。
 *
 * @param {{offsetSeconds:number, durationSeconds:number, gainScale?:number,
 *   fadeInSeconds?:number, fadeOutSeconds?:number,
 *   clipPlayStartSeconds?:number, clipPlayDurationSeconds?:number,
 *   stretchRatio?:number, playStartSeconds?:number, playDurationSeconds?:number}} segment
 * @returns {Array<{time:number, gain:number}>}
 */
export function buildClipFadeEnvelope(segment) {
  const gainScaleRaw = Number(segment?.gainScale)
  const gainScale = Number.isFinite(gainScaleRaw) ? Math.max(0, gainScaleRaw) : 1
  const duration = Math.max(0, Number(segment?.durationSeconds) || 0)
  if (!(duration > 1e-9)) return [{ time: 0, gain: gainScale }]
  const ratio = normalizeStretchRatio(segment?.stretchRatio)
  const offset = Math.max(0, Number(segment?.offsetSeconds) || 0)
  const clipPlayStart = Number.isFinite(Number(segment?.clipPlayStartSeconds))
    ? Math.max(0, Number(segment.clipPlayStartSeconds))
    : offset
  // 输出轴（timeline 秒，相对 clip 起点）
  const axisStart = Number.isFinite(Number(segment?.playStartSeconds))
    ? Math.max(0, Number(segment.playStartSeconds))
    : (offset - clipPlayStart) * ratio
  const clipPlayDurationRaw = Number(segment?.clipPlayDurationSeconds)
  const playDuration = Number.isFinite(Number(segment?.playDurationSeconds))
    ? Math.max(0, Number(segment.playDurationSeconds))
    : Number.isFinite(clipPlayDurationRaw)
      ? Math.max(0, clipPlayDurationRaw)
      : duration
  const fadeIn = Math.max(0, Math.min(Number(segment?.fadeInSeconds) || 0, playDuration))
  const fadeOut = Math.max(0, Math.min(Number(segment?.fadeOutSeconds) || 0, playDuration))
  if (fadeIn <= 1e-9 && fadeOut <= 1e-9) return [{ time: 0, gain: gainScale }]
  const axisEnd = axisStart + duration
  const envelopeAt = (axisTime) => {
    let gain = gainScale
    if (fadeIn > 1e-9) gain *= Math.max(0, Math.min(1, axisTime / fadeIn))
    if (fadeOut > 1e-9) gain *= Math.max(0, Math.min(1, (playDuration - axisTime) / fadeOut))
    return Math.max(0, gain)
  }
  const times = new Set([axisStart, axisEnd])
  const candidates = [fadeIn, playDuration - fadeOut]
  for (const candidate of candidates) {
    if (Number.isFinite(candidate) && candidate > axisStart + 1e-9 && candidate < axisEnd - 1e-9) times.add(candidate)
  }
  const sorted = [...times].sort((a, b) => a - b)
  const points = sorted.map((axisTime) => ({ time: axisTime - axisStart, gain: envelopeAt(axisTime) }))
  // 全平包络（无 fade 或 fade 未进入片段窗口）→ 单点，等价旧行为（引擎只 setValue）
  if (points.length > 1 && points.every((point) => Math.abs(point.gain - points[0].gain) < 1e-9)) {
    return [{ time: 0, gain: points[0].gain }]
  }
  return points
}

/** 秒数换算：tempo 可为 createTempoMap 对象（tempo automation）或常量 bps 数字。 */
function tempoSecondsBetween(tempo, fromBeat, toBeat) {
  const from = Number(fromBeat)
  const to = Number(toBeat)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  if (tempo && typeof tempo.beatToSeconds === 'function') {
    return tempo.beatToSeconds(to) - tempo.beatToSeconds(from)
  }
  const bps = Number(tempo)
  return Number.isFinite(bps) && bps > 0 ? (to - from) / bps : 0
}

/** 从 beat 起算 seconds 秒后的 beat（tempo map 反解或常量 bps）。 */
function tempoBeatAfterSeconds(tempo, beat, seconds) {
  const value = Number(beat)
  const offset = Number(seconds)
  if (!Number.isFinite(value) || !Number.isFinite(offset)) return value
  if (tempo && typeof tempo.secondsToBeat === 'function' && typeof tempo.beatToSeconds === 'function') {
    return tempo.secondsToBeat(tempo.beatToSeconds(value) + offset)
  }
  const bps = Number(tempo)
  return Number.isFinite(bps) && bps > 0 ? value + offset * bps : value
}

/**
 * 把 audio 轨的音频片段裁剪到 [rangeStartBeat, rangeEndBeat) 播放区间（纯函数）。
 *
 * 实时与离线共用：
 * - `whenSeconds`：从区间起点算起的调度时间（秒，按 tempo map 积分）；
 * - `offsetSeconds`：从媒体文件内开始播放的位置（秒）= 片段存储的
 *   `clip.offsetSeconds`（左裁切）+ 片段与区间交集起点相对片段起点的「tempo 秒数」；
 * - `durationSeconds`：本次要播放的时长（受 clip 长度、媒体剩余时长、区间末尾三者约束）。
 * - `clip.offsetSeconds` 缺省/非法（非有限数）按 0 处理；实际媒体起点超出媒体时长 → 跳过。
 *
 * @param {object} project
 * @param {number} rangeStartBeat 播放/渲染区间起点（绝对 beat）
 * @param {number} rangeEndBeat 播放/渲染区间终点（绝对 beat）
 * @param {object|number} tempo createTempoMap 对象（tempo automation）或常量 bps（数字）
 * @returns {Array<{trackId:string, mediaId:string, clipId:string, startBeat:number, endBeat:number,
 *   whenSeconds:number, offsetSeconds:number, durationSeconds:number, relBeats:number}>}
 */
export function buildAudioClipSegments(project, rangeStartBeat, rangeEndBeat, tempo) {
  const rangeStart = Number(rangeStartBeat)
  const rangeEnd = Number(rangeEndBeat)
  const hasTempo = tempo && typeof tempo.beatToSeconds === 'function'
  const rate = Number(tempo)
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) return []
  if (!hasTempo && (!Number.isFinite(rate) || rate <= 0)) return []
  const barBeats = beatsPerBar(project)
  const mediaDurations = mediaDurationMap(project)
  // 媒体条目存在即可播放（duration 元数据可为 null，如 mp3）；库里没有对应条目才跳过
  const mediaEntryIds = new Set()
  const mediaFiles = new Map()
  const mediaIdentities = new Map()
  for (const entry of project?.media ?? []) {
    if (!entry || typeof entry !== 'object') continue
    const rawId = entry.id
    if (rawId !== null && rawId !== undefined) {
      const entryId = String(rawId)
      mediaEntryIds.add(entryId)
      mediaFiles.set(entryId, typeof entry.file === 'string' && entry.file ? entry.file : null)
      mediaIdentities.set(entryId, mediaIdentity(entry))
    }
  }
  const tracks = new Map((project?.tracks ?? []).map((track) => [track?.id, track]))
  const segments = []
  for (const clip of project?.clips ?? []) {
    if (!clip || !clip.mediaId) continue
    const track = tracks.get(clip.trackId)
    if (!track || track.kind !== 'audio') continue
    if (track.mute) continue
    // CONTRACT-R2C：inactive take（takeActive===false）不参与播放/导出；无字段=激活（旧行为）
    if (clip.takeActive === false) continue
    const mediaId = String(clip.mediaId)
    if (!mediaEntryIds.has(mediaId)) continue // 媒体不存在（旧工程/已被删除）→ 跳过
    const startBar = Math.max(0, Number(clip.startBar) || 0)
    const lengthBars = Math.max(1, Math.round(Number(clip.lengthBars) || 1))
    const clipStartBeat = startBar * barBeats
    const clipLengthBeats = lengthBars * barBeats
    const clipEndBeat = clipStartBeat + clipLengthBeats
    const interStart = Math.max(clipStartBeat, rangeStart)
    const interEnd = Math.min(clipEndBeat, rangeEnd)
    if (interEnd <= interStart + 1e-9) continue
    // 左裁切：片段从媒体内 clip.offsetSeconds 秒处开始；区间从片段中间开始时再叠加 tempo 秒数
    const rawTrimOffset = Number(clip.offsetSeconds)
    const trimOffsetSeconds = Number.isFinite(rawTrimOffset) && rawTrimOffset > 0 ? rawTrimOffset : 0
    const mediaDuration = mediaDurations.get(mediaId)
    // CONTRACT-R2a/R2b：gain / fade / reverse / stretch / semitones（缺省 → 与旧行为一致）
    const gainDb = normalizeClipGainDb(clip.gainDb)
    const gainScale = Math.pow(10, gainDb / 20)
    const reverse = clip.reverse === true
    const stretchRatio = normalizeStretchRatio(clip.stretchRatio)
    const semitones = normalizeSemitones(clip.semitones)
    const clipLengthSeconds = tempoSecondsBetween(tempo, clipStartBeat, clipEndBeat)
    // R2b：可播放 timeline 秒 = min(clip 长度, (媒体时长 - trim) × ratio)；ratio=1 时与 R2a 一致
    const clipPlayDurationSeconds = Math.max(
      0,
      Math.min(
        clipLengthSeconds,
        Number.isFinite(mediaDuration) ? (mediaDuration - trimOffsetSeconds) * stretchRatio : Infinity,
      ),
    )
    let fadeInSeconds = normalizeClipFadeSeconds(clip.fadeInSeconds)
    let fadeOutSeconds = normalizeClipFadeSeconds(clip.fadeOutSeconds)
    if (fadeInSeconds + fadeOutSeconds > clipPlayDurationSeconds) {
      if (clipPlayDurationSeconds > 0) {
        const scale = clipPlayDurationSeconds / (fadeInSeconds + fadeOutSeconds)
        fadeInSeconds *= scale
        fadeOutSeconds *= scale
      } else {
        fadeInSeconds = 0
        fadeOutSeconds = 0
      }
    }
    // 片段在这次渲染窗口内的 timeline 起点（相对 clip 起点）→ 源媒体偏移按 ratio 换算
    const playStartSeconds = tempoSecondsBetween(tempo, clipStartBeat, interStart)
    const offsetSeconds = trimOffsetSeconds + playStartSeconds / stretchRatio
    const whenSeconds = tempoSecondsBetween(tempo, rangeStart, interStart)
    if (Number.isFinite(mediaDuration) && offsetSeconds >= mediaDuration - MIN_AUDIO_CLIP_SECONDS) {
      continue // 已裁切到媒体末尾之后 → 无可播放内容
    }
    // durationSeconds 始终是 timeline/输出秒；源剩余时长 × ratio 限制输出长度
    const remainingTimeline = Number.isFinite(mediaDuration) ? (mediaDuration - offsetSeconds) * stretchRatio : Infinity
    const durationSeconds = Math.min(tempoSecondsBetween(tempo, interStart, interEnd), remainingTimeline)
    if (!(durationSeconds > MIN_AUDIO_CLIP_SECONDS)) continue
    segments.push({
      trackId: track.id,
      mediaId,
      mediaFile: mediaFiles.get(mediaId) ?? null,
      mediaIdentity: mediaIdentities.get(mediaId) ?? '',
      clipId: String(clip.id ?? ''),
      startBeat: interStart,
      endBeat: tempoBeatAfterSeconds(tempo, interStart, durationSeconds),
      whenSeconds,
      offsetSeconds,
      durationSeconds,
      relBeats: interStart - rangeStart,
      gainDb,
      gainScale,
      fadeInSeconds,
      fadeOutSeconds,
      reverse,
      stretchRatio,
      semitones,
      clipPlayStartSeconds: trimOffsetSeconds,
      clipPlayDurationSeconds,
      // R2b：fade 在 timeline/输出播放窗口上定义（相对 clip 起点）
      playStartSeconds,
      playDurationSeconds: clipPlayDurationSeconds,
    })
  }
  segments.sort((a, b) => a.whenSeconds - b.whenSeconds || (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0))
  return segments
}
