/**
 * 纯 DSP / 数学辅助函数（audio-engine）。
 *
 * 本文件不依赖 AudioContext / DOM，Node 中可直接 import 做单测。
 * 只放「可被实时引擎与离线渲染共用」的纯计算逻辑。
 */

/** 数值钳制（非法值按 0 处理）。 */
export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** 0..1 钳制。 */
export function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * 确定性种子哈希（FNV-1a 混合）：同一组参数 → 同一 seed。
 * 用于替代 Math.random()，保证实时/离线/重复导出逐位可复现。
 */
export function hashSeed(...parts) {
  let hash = 0x811c9dc5
  for (const part of parts) {
    const text = typeof part === 'number'
      ? (Number.isFinite(part) ? part.toFixed(6) : 'nan')
      : String(part)
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0x9e3779b9
    hash = Math.imul(hash, 0x85ebca6b) >>> 0
  }
  return hash >>> 0
}

/** mulberry32 确定性 PRNG（返回 0..1 的函数）。 */
export function mulberry32(seed) {
  let state = hashSeed(seed)
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 确定性缓存上限（IR / 噪声）。 */
const DSP_CACHE_MAX = 32
const impulseCache = new Map()
const noiseDataCache = new Map()
/** 白噪声 AudioBuffer 缓存（按 BaseAudioContext 分别缓存）。 */
let noiseCache = new WeakMap()

/** 清空确定性 DSP 缓存（测试用；正式运行由 LRU 上限控制）。 */
export function clearDspCaches() {
  impulseCache.clear()
  noiseDataCache.clear()
  noiseCache = new WeakMap()
}

/** 当前缓存条目数（测试/诊断）。 */
export function dspCacheSizes() {
  return { impulse: impulseCache.size, noiseData: noiseDataCache.size }
}

/** dB → 线性增益。 */
export const dbToGain = (db) => Math.pow(10, clamp(db, -96, 24) / 20)

/** 线性增益 → dB（下限 -140dB，避免 -Infinity）。 */
export const gainToDb = (gain) => 20 * Math.log10(Math.max(1e-7, Number(gain) || 0))

/** 电平表下限（dB）：-54dB 以下算 0。 */
export const LEVEL_FLOOR_DB = -54

/** RMS 0..1 → 电平表 0..1（对数映射，-54dB→0，0dB→1）。 */
export function rmsToLevel(rms, floorDb = LEVEL_FLOOR_DB) {
  const v = Number(rms)
  if (!(v > 0)) return 0
  const db = gainToDb(v)
  return clamp((db - floorDb) / -floorDb, 0, 1)
}

/**
 * 软削波失真曲线（WaveShaper 用）。
 * amount 0..1 → 0 为近似线性，1 为强饱和；曲线归一化到 ±1。
 */
export function makeDriveCurve(amount = 0.35, length = 1024) {
  const n = Math.max(2, Math.round(Number(length) || 1024))
  const k = 1 + clamp01(amount) * 28
  const curve = new Float32Array(n)
  const norm = Math.tanh(k)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / norm
  }
  return curve
}

/**
 * 位深量化曲线（WaveShaper 用）。bits 1..16。
 * 例如 bits=2 → 每个样本只保留 4 个台阶。
 */
export function makeBitCrushCurve(bits = 8, length = 4096) {
  const n = Math.max(2, Math.round(Number(length) || 4096))
  const levels = Math.pow(2, Math.round(clamp(bits, 1, 16)))
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.round(x * levels) / levels
  }
  return curve
}

/**
 * 程序化生成混响脉冲响应数据（纯计算，不创建 AudioBuffer）。
 *
 * 确定性：同一参数（采样率/size/decay/damp/channels）→ 完全相同的 IR；
 * 结果按参数缓存（≤32 组），重复导出/实时与离线共用，不再使用 Math.random()。
 * @param {number} sampleRate
 * @param {{size?:number, decay?:number, damp?:number, channels?:number}} opts
 * @returns {{ data: Float32Array[], sampleRate: number, length: number, seconds: number }}
 */
export function generateImpulseData(sampleRate = 44100, opts = {}) {
  const sr = clamp(sampleRate, 8000, 192000)
  const size = clamp01(opts.size ?? 0.6)
  const decay = clamp01(opts.decay ?? 0.55)
  const damp = clamp01(opts.damp ?? 0.4)
  const channels = Math.max(1, Math.min(4, Math.round(Number(opts.channels) || 2)))
  const cacheKey = `${Math.round(sr)}|${Math.round(size * 10000)}|${Math.round(decay * 10000)}|${Math.round(damp * 10000)}|${channels}`
  const cached = impulseCache.get(cacheKey)
  if (cached) return cached
  const seconds = clamp(0.22 + size * 2.6 * (0.6 + decay * 0.8), 0.18, 4)
  const length = Math.max(8, Math.round(seconds * sr))
  const power = 1.4 + decay * 3.2
  // 一阶低通：damp 越大越暗（系数越小）
  const coeff = Math.max(0.02, 1 - damp * 0.96)
  const data = []
  for (let c = 0; c < channels; c++) {
    const chan = new Float32Array(length)
    const random = mulberry32(hashSeed('impulse', sr, size, decay, damp, c))
    let lp = 0
    for (let i = 0; i < length; i++) {
      const t = i / length
      lp += coeff * (random() * 2 - 1 - lp)
      const env = Math.pow(1 - t, power) * Math.exp(-t * (0.4 + damp * 1.8))
      chan[i] = lp * env
    }
    // 直达声瞬态，让混响起点更结实
    chan[0] += 0.4
    // 峰值归一化，避免 ConvolverNode 增益失控
    let peak = 0
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(chan[i]))
    if (peak > 0) {
      const scale = 0.88 / peak
      for (let i = 0; i < length; i++) chan[i] *= scale
    }
    data.push(chan)
  }
  const result = { data, sampleRate: sr, length, seconds }
  if (impulseCache.size >= DSP_CACHE_MAX) impulseCache.delete(impulseCache.keys().next().value)
  impulseCache.set(cacheKey, result)
  return result
}

/** 确定性噪声数据（按采样率+时长缓存；跨 context/render 完全一致）。 */
function deterministicNoiseData(sampleRate, dur) {
  const sr = Math.max(8000, Math.round(Number(sampleRate) || 44100))
  const seconds = Math.max(0.1, Math.min(8, Number(dur) || 2))
  const cacheKey = `${sr}|${Math.round(seconds * 1000)}`
  let data = noiseDataCache.get(cacheKey)
  if (!data) {
    const length = Math.max(1, Math.round(sr * seconds))
    data = new Float32Array(length)
    const random = mulberry32(hashSeed('noise', sr, seconds))
    for (let i = 0; i < length; i++) data[i] = random() * 2 - 1
    if (noiseDataCache.size >= DSP_CACHE_MAX) noiseDataCache.delete(noiseDataCache.keys().next().value)
    noiseDataCache.set(cacheKey, data)
  }
  return data
}

/**
 * 取得（并缓存）一段白噪声 AudioBuffer。
 * 内容由确定性 PRNG 生成（同采样率/时长跨 render 完全一致），不再使用 Math.random()。
 * @param {BaseAudioContext} ctx
 * @param {number} seconds
 */
export function getNoiseBuffer(ctx, seconds = 2) {
  if (!ctx || typeof ctx.createBuffer !== 'function') return null
  const dur = clamp(seconds, 0.1, 8)
  let perContext = noiseCache.get(ctx)
  if (!perContext) {
    perContext = new Map()
    noiseCache.set(ctx, perContext)
  }
  let buffer = perContext.get(dur)
  if (!buffer) {
    const sampleRate = Math.round(Number(ctx.sampleRate) || 44100)
    const data = deterministicNoiseData(sampleRate, dur)
    buffer = ctx.createBuffer(1, data.length, sampleRate)
    const target = buffer.getChannelData(0)
    target.set(data)
    perContext.set(dur, buffer)
  }
  return buffer
}

/**
 * 平滑地设置 AudioParam；非 AudioParam 环境安全降级为赋值。
 * 实时参数更新统一走这里，避免爆音。
 */
export function rampAudioParam(param, value, now = 0, timeConstant = 0.02) {
  if (!param) return
  const v = Number(value)
  if (!Number.isFinite(v)) return
  try {
    if (typeof param.setTargetAtTime === 'function') {
      param.setTargetAtTime(v, Math.max(0, Number(now) || 0), Math.max(0.001, Number(timeConstant) || 0.02))
      return
    }
  } catch {
    /* 某些实现 / 已关闭的 context 会抛错，降级 */
  }
  try {
    param.value = v
  } catch {
    /* ignore */
  }
}

/** 立即设置 AudioParam（用于图构建初始值，不做平滑）。 */
export function setAudioParam(param, value) {
  if (!param) return
  const v = Number(value)
  if (!Number.isFinite(v)) return
  try {
    param.value = v
  } catch {
    /* ignore */
  }
}
