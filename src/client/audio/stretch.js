/**
 * R2b 时间拉伸 / 保持音高变调（CONTRACT-R2B，audio-engine 预研模块）。
 *
 * 纯函数、无 Web Audio 依赖，Node 可单测：
 * - `wsolaChannels`：WSOLA（Waveform Similarity Overlap-Add）时间拉伸，保持音高；
 * - `resampleLinear`：线性重采样（音高随播放速率变化）；
 * - `pitchShiftChannels`：重采样 + WSOLA 时长补偿 → 「时长不变、音高改变」；
 * - `processClipAudio`：按 clip 的 stretchRatio/semitones（可选 reverse 前置）生成处理后的声道数据。
 *
 * 设计口径（与 Host 对齐草案）：
 * - `stretchRatio`：timeline 秒 = 源秒 × ratio；1=原速，2=慢放一倍，0.5=加速一倍；
 * - `semitones`：独立变调（-12..+12，1 位小数）；
 * - `reverse`：先取源区间反转，再做 stretch/pitch；
 * - 第一刀质量档：WSOLA 级（可听/可导出/无爆音；瞬态会有轻微 smear，录音级后续）。
 */

/** 合法 stretchRatio 范围（与 Host 对齐）。 */
export const MIN_STRETCH_RATIO = 0.25
export const MAX_STRETCH_RATIO = 4
/** 合法 semitones 范围。 */
export const MIN_SEMITONES = -12
export const MAX_SEMITONES = 12
/** WSOLA 默认帧参数。 */
export const WSOLA_FRAME_SIZE = 2048
export const WSOLA_OVERLAP = 0.5
export const WSOLA_SEARCH_RADIUS = 256
export const WSOLA_CORRELATION_SIZE = 512

/** stretchRatio 规范化：非有限/非法 → 1，钳制 [0.25,4]，保留 3 位小数。 */
export function normalizeStretchRatio(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 1
  const clamped = Math.max(MIN_STRETCH_RATIO, Math.min(MAX_STRETCH_RATIO, value))
  return Math.round(clamped * 1000) / 1000
}

/** semitones 规范化：非有限/非法 → 0，钳制 [-12,12]，保留 1 位小数。 */
export function normalizeSemitones(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0
  const clamped = Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, value))
  return Math.round(clamped * 10) / 10
}

/** 是否是「无需处理」的原始参数（ratio=1 且 semitones=0）。 */
export function isIdentityProcess({ stretchRatio, semitones } = {}) {
  return normalizeStretchRatio(stretchRatio) === 1 && normalizeSemitones(semitones) === 0
}

function hannWindow(size) {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1 || 1))
  return window
}

/** 线性插值重采样：输出长度 ≈ input.length / factor；factor>1 → 变短且音高升高。 */
export function resampleLinear(input, factor) {
  const source = input instanceof Float32Array ? input : Float32Array.from(input ?? [])
  const ratio = Number(factor)
  if (!(ratio > 0)) return Float32Array.from(source)
  const outLength = Math.max(1, Math.round(source.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const frac = position - index
    const a = source[Math.min(source.length - 1, index)] ?? 0
    const b = source[Math.min(source.length - 1, index + 1)] ?? 0
    out[i] = a + (b - a) * frac
  }
  return out
}

/** 互相关（最大化相似度）：在两个等长窗口上计算归一化点积。 */
function correlation(a, b, size) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < size; i++) {
    const va = a[i]
    const vb = b[i]
    dot += va * vb
    na += va * va
    nb += vb * vb
  }
  if (na <= 1e-12 || nb <= 1e-12) return 0
  return dot / Math.sqrt(na * nb)
}

/** 取输入窗口（越界补 0）。 */
function frameAt(input, start, size) {
  const out = new Float32Array(size)
  const from = Math.max(0, Math.min(input.length, start))
  const count = Math.max(0, Math.min(size, input.length - from))
  for (let i = 0; i < count; i++) out[i] = input[from + i]
  return out
}

/**
 * 单声道 WSOLA 时间拉伸（保持音高）。
 * @param {Float32Array|number[]} input
 * @param {number} stretch 输出/输入时长比例（>1 变长）
 * @param {{frameSize?:number, overlap?:number, searchRadius?:number, correlationSize?:number,
 *   templateSource?:Float32Array}} [options]
 *   templateSource：多声道时由共用声道决定对齐偏移（传入同一参考信号）。
 * @returns {Float32Array}
 */
export function wsolaChannel(input, stretch, options = {}) {
  const source = input instanceof Float32Array ? input : Float32Array.from(input ?? [])
  const ratio = Number(stretch)
  if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-9 || source.length === 0) return Float32Array.from(source)
  const frameSize = Math.max(64, Math.round(options.frameSize ?? WSOLA_FRAME_SIZE))
  const rawOverlap = Number(options.overlap)
  const overlap = Math.max(0.1, Math.min(0.9, Number.isFinite(rawOverlap) ? rawOverlap : WSOLA_OVERLAP))
  const hopOut = Math.max(1, Math.round(frameSize * (1 - overlap)))
  const hopIn = hopOut / ratio
  const searchRadius = Math.max(0, Math.round(options.searchRadius ?? WSOLA_SEARCH_RADIUS))
  const correlationSize = Math.max(16, Math.min(frameSize, Math.round(options.correlationSize ?? WSOLA_CORRELATION_SIZE)))
  const templateSource = options.templateSource instanceof Float32Array ? options.templateSource : source
  const outLength = Math.max(1, Math.round(source.length * ratio))
  const out = new Float64Array(outLength)
  const weightSum = new Float64Array(outLength)
  const window = hannWindow(frameSize)
  let previousStart = null
  let frameIndex = 0
  for (let outPos = 0; outPos < outLength; outPos += hopOut, frameIndex++) {
    const target = Math.round(frameIndex * hopIn)
    let chosen = target
    if (previousStart !== null && searchRadius > 0) {
      // 期望波形：上一帧在输入流的自然延续（prevStart + hopOut）
      const template = frameAt(templateSource, previousStart + hopOut, correlationSize)
      let bestScore = -Infinity
      const minStart = Math.max(0, target - searchRadius)
      const maxStart = Math.max(minStart, target + searchRadius)
      for (let candidate = minStart; candidate <= maxStart; candidate += 1) {
        const frame = frameAt(templateSource, candidate, correlationSize)
        const score = correlation(template, frame, correlationSize)
        if (score > bestScore) {
          bestScore = score
          chosen = candidate
        }
        // 搜索窗较大时步进 2 加速（质量损失可接受，第一刀）
        if (searchRadius > 128) {
          candidate += 1
        }
      }
    }
    const frame = frameAt(source, chosen, frameSize)
    const limit = Math.min(frameSize, outLength - outPos)
    for (let i = 0; i < limit; i++) {
      out[outPos + i] += frame[i] * window[i]
      weightSum[outPos + i] += window[i]
    }
    previousStart = chosen
  }
  const result = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const weight = weightSum[i]
    result[i] = weight > 1e-6 ? out[i] / weight : 0
  }
  return result
}

/**
 * 多声道 WSOLA：用 reference 声道（默认第 1 声道）决定对齐偏移，各声道共用，保持立体声相位。
 * @returns {Float32Array[]}
 */
export function wsolaChannels(channels, stretch, options = {}) {
  const list = Array.isArray(channels) ? channels : []
  const ratio = Number(stretch)
  if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-9 || list.length === 0) {
    return list.map((channel) => Float32Array.from(channel ?? []))
  }
  const reference = list[0] instanceof Float32Array ? list[0] : Float32Array.from(list[0] ?? [])
  const referenceOut = wsolaChannel(reference, ratio, options)
  if (list.length === 1) return [referenceOut]
  const outLength = referenceOut.length
  const out = []
  for (let channel = 0; channel < list.length; channel++) {
    const source = list[channel] instanceof Float32Array ? list[channel] : Float32Array.from(list[channel] ?? [])
    // 用同一组帧偏移处理该声道：重新跑一次 WSOLA，但模板/搜索由 reference 驱动
    out.push(wsolaChannelWithReference(source, reference, ratio, options, outLength))
  }
  return out
}

/** 用参考声道决定帧对齐偏移，处理其它声道（保持声道间时间对齐）。 */
function wsolaChannelWithReference(input, reference, stretch, options, outLengthHint) {
  const source = input instanceof Float32Array ? input : Float32Array.from(input ?? [])
  const ratio = Number(stretch)
  const frameSize = Math.max(64, Math.round(options.frameSize ?? WSOLA_FRAME_SIZE))
  const rawOverlap = Number(options.overlap)
  const overlap = Math.max(0.1, Math.min(0.9, Number.isFinite(rawOverlap) ? rawOverlap : WSOLA_OVERLAP))
  const hopOut = Math.max(1, Math.round(frameSize * (1 - overlap)))
  const hopIn = hopOut / ratio
  const searchRadius = Math.max(0, Math.round(options.searchRadius ?? WSOLA_SEARCH_RADIUS))
  const correlationSize = Math.max(16, Math.min(frameSize, Math.round(options.correlationSize ?? WSOLA_CORRELATION_SIZE)))
  const outLength = Math.max(1, Math.round(source.length * ratio))
  const out = new Float64Array(outLength)
  const weightSum = new Float64Array(outLength)
  const window = hannWindow(frameSize)
  let previousStart = null
  let frameIndex = 0
  for (let outPos = 0; outPos < outLength; outPos += hopOut, frameIndex++) {
    const target = Math.round(frameIndex * hopIn)
    let chosen = target
    if (previousStart !== null && searchRadius > 0) {
      const template = frameAt(reference, previousStart + hopOut, correlationSize)
      let bestScore = -Infinity
      const minStart = Math.max(0, target - searchRadius)
      const maxStart = Math.max(minStart, target + searchRadius)
      for (let candidate = minStart; candidate <= maxStart; candidate += 1) {
        const frame = frameAt(reference, candidate, correlationSize)
        const score = correlation(template, frame, correlationSize)
        if (score > bestScore) {
          bestScore = score
          chosen = candidate
        }
      }
    }
    const frame = frameAt(source, chosen, frameSize)
    const limit = Math.min(frameSize, outLength - outPos)
    for (let i = 0; i < limit; i++) {
      out[outPos + i] += frame[i] * window[i]
      weightSum[outPos + i] += window[i]
    }
    previousStart = chosen
  }
  const result = new Float32Array(outLengthHint ?? outLength)
  for (let i = 0; i < result.length; i++) {
    const weight = weightSum[i]
    result[i] = weight > 1e-6 ? out[i] / weight : 0
  }
  return result
}

/**
 * 独立变调（保持时长）：重采样改变音高，再用 WSOLA 补偿时长。
 * @param {Array<Float32Array|number[]>} channels
 * @param {number} semitones -12..12
 * @param {number} stretchRatio 与 clip 的时间拉伸组合（默认 1）
 * @returns {Float32Array[]}
 */
export function pitchShiftChannels(channels, semitones, stretchRatio = 1) {
  const list = (Array.isArray(channels) ? channels : []).map((channel) =>
    channel instanceof Float32Array ? channel : Float32Array.from(channel ?? []),
  )
  const st = normalizeSemitones(semitones)
  const ratio = normalizeStretchRatio(stretchRatio)
  if (!list.length || (Math.abs(st) < 1e-9 && ratio === 1)) return list
  if (Math.abs(st) < 1e-9) return wsolaChannels(list, ratio)
  const pitchFactor = Math.pow(2, st / 12)
  const resampled = list.map((channel) => resampleLinear(channel, pitchFactor))
  // 目标输出长度 = 原长 × stretchRatio；重采样后长度=原长/p，需拉伸 × ratio*p
  return wsolaChannels(resampled, ratio * pitchFactor)
}

/**
 * 处理 clip 音频（reverse 已在调用方处理或经 reverseChannels 前置）：
 * 返回处理后的声道数组，时长 ≈ 源时长 × stretchRatio，音高按 semitones 改变。
 * @param {Array<Float32Array|number[]>} channels
 * @param {{stretchRatio?:number, semitones?:number}} [options]
 * @returns {Float32Array[]}
 */
export function processClipAudio(channels, options = {}) {
  const list = (Array.isArray(channels) ? channels : []).map((channel) =>
    channel instanceof Float32Array ? channel : Float32Array.from(channel ?? []),
  )
  const ratio = normalizeStretchRatio(options.stretchRatio)
  const semitones = normalizeSemitones(options.semitones)
  if (!list.length) return []
  if (ratio === 1 && Math.abs(semitones) < 1e-9) return list
  return pitchShiftChannels(list, semitones, ratio)
}

/** 反转一组声道（生成新数组，不修改输入）。 */
export function reverseChannels(channels) {
  return (Array.isArray(channels) ? channels : []).map((channel) => {
    const source = channel instanceof Float32Array ? channel : Float32Array.from(channel ?? [])
    const out = new Float32Array(source.length)
    for (let i = 0; i < source.length; i++) out[i] = source[source.length - 1 - i]
    return out
  })
}
