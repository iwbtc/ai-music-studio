/**
 * 音频分析纯函数（CONTRACT-P10 §1.5 / CONTRACT-R0 §R0B.1，audio-engine）。
 *
 * 供「渲染预览/自检」使用：把任意声道 Float32 采样（或 AudioBuffer）汇总成
 * 客观电平/响度/立体声/频谱指标，Node 无 Web Audio 环境也可单测。
 *
 * 约定：
 * - dB 一律 20·log10(x)；峰值/有效值小于 1e-6 时记为 -120 dB（便于 JSON，不出现 -Infinity）；
 * - `clipping`：峰值 >= 0.999；
 * - `silent`：RMS dBFS < -60；
 * - `lufsApprox`：**旧近似值**（未加权 RMS dBFS − 0.691），仅为兼容保留；
 * - `lufs`：ITU-R BS.1770-4 风格 K 加权积分响度（400ms 块 + 绝对/相对 gating），
 *   静音返回 null；音频短于 400ms / 无完整 gating 统计时按整段/短窗口近似，
 *   用 `lufsApprox:false` 之外由 `lufsMethod` 标注（`itu-r-bs.1770-4` / `...-short`）；
 * - `lufsMaxShortTerm`：3s 短时响度窗口最大值（音频不足 3s 时退回最响 400ms 块，
 *   `lufsShortTermApprox:true`）；
 * - `stereoBalanceDb`：20·log10(rmsL / rmsR)（单声道/静音侧 → null，钳制 ±60dB）；
 * - `correlation`：L/R 零延迟归一化互相关（-1..1；单声道或无能量 → null）；
 * - `spectralCentroidHz` / `bandEnergyPct`：基于 Hann 窗 FFT 功率谱（平均后）计算；
 * - `sectionStats`：按传入 sections（秒边界，或 beat + beatToSeconds 回调）分段给出同套指标；
 * - `dcOffset`：全部声道全部采样的算术平均值（恒定正/负偏置）。
 */

/** 峰值/有效值下限（dB 显示用）。 */
export const MIN_DB = -120
/** 小于该绝对值视为「静音底」，dB 记 -120。 */
export const SILENCE_EPSILON = 1e-6
/** 削波阈值（峰值 >= 该值即 clipping）。 */
export const CLIP_THRESHOLD = 0.999
/** silent 判定阈值（RMS dBFS < 该值）。 */
export const SILENT_DB = -60
/** lufsApprox 的偏移（RMS dBFS − 0.691，近似值）。 */
export const LUFS_APPROX_OFFSET = -0.691
/** 峰值归一默认目标（导出 normalize 用）。 */
export const DEFAULT_NORMALIZE_PEAK = 0.98

/** BS.1770 响度块长度（秒）。 */
export const LUFS_BLOCK_SECONDS = 0.4
/** BS.1770 积分响度块重叠（75%，即 hop = 0.1s）。 */
export const LUFS_BLOCK_OVERLAP = 0.75
/** 短时响度窗口（秒）。 */
export const LUFS_SHORT_TERM_SECONDS = 3
/** 绝对 gating 阈值（LUFS）。 */
export const LUFS_ABSOLUTE_GATE = -70
/** 相对 gating 阈值（低于「绝对门限以上块」均值 10 LU 的块被剔除）。 */
export const LUFS_RELATIVE_GATE_LU = 10
/** 频谱分析 FFT 长度（2 的幂）。 */
export const SPECTRAL_FFT_SIZE = 4096
/** 频谱分析最多平均帧数（限制长音频耗时）。 */
export const SPECTRAL_MAX_FRAMES = 64
/** 频段定义（Hz，左闭右开；最后一段 >8000 到 Nyquist）。 */
export const SPECTRAL_BANDS = Object.freeze([
  { key: 'sub', min: 0, max: 60, label: '<60Hz' },
  { key: 'low', min: 60, max: 250, label: '60-250Hz' },
  { key: 'lowMid', min: 250, max: 1000, label: '250-1kHz' },
  { key: 'mid', min: 1000, max: 4000, label: '1k-4kHz' },
  { key: 'highMid', min: 4000, max: 8000, label: '4k-8kHz' },
  { key: 'high', min: 8000, max: Infinity, label: '>8kHz' },
])

function finiteSample(value) {
  return Number.isFinite(value) ? value : 0
}

/** 线性幅度 → dB（<1e-6 记 -120）。 */
export function linearToDb(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < SILENCE_EPSILON) return MIN_DB
  return 20 * Math.log10(number)
}

// ---------------------------------------------------------------------------
// ITU-R BS.1770 K 加权（双二阶：高架 + RLB 高通；按采样率重新推导系数）
// ---------------------------------------------------------------------------

/**
 * 计算 K 加权双二阶级联系数（pyloudnorm / libebur128 同款解析推导）。
 * 48kHz 时与 BS.1770-4 给出的标准系数一致（误差 <1e-6）。
 * @param {number} sampleRate
 * @returns {{pre:{b0:number,b1:number,b2:number,a1:number,a2:number},
 *            rlb:{b0:number,b1:number,b2:number,a1:number,a2:number}}}
 */
export function kWeightingCoefficients(sampleRate) {
  const rate = Number(sampleRate)
  const fs = Number.isFinite(rate) && rate > 0 ? rate : 48000
  // 高架滤波器（~+4dB @1.5kHz）
  const G = 3.999843853973347
  const Q = 0.7071752369554196
  const fc = 1681.974450955533
  const K = Math.tan((Math.PI * fc) / fs)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const a0 = 1 + K / Q + K * K
  const pre = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  // RLB 高通（~38Hz）；BS.1770-4 Table 1 的 b 系数为 [1,-2,1]（不除 a0），a 为归一化极点系数
  const fc2 = 38.13547087602444
  const Q2 = 0.5003270373238773
  const K2 = Math.tan((Math.PI * fc2) / fs)
  const a02 = 1 + K2 / Q2 + K2 * K2
  const rlb = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K2 * K2 - 1)) / a02,
    a2: (1 - K2 / Q2 + K2 * K2) / a02,
  }
  return { pre, rlb }
}

/** 单个双二阶（Direct Form I）滤波一个声道。 */
function biquadFilter(input, coeff) {
  const out = new Float32Array(input.length)
  const { b0, b1, b2, a1, a2 } = coeff
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = finiteSample(input[i])
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    out[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return out
}

/** 对全部声道做 K 加权（两级双二阶级联）。 */
export function applyKWeighting(channels, sampleRate) {
  const { pre, rlb } = kWeightingCoefficients(sampleRate)
  const list = Array.isArray(channels) ? channels : []
  return list.map((channel) => {
    if (!channel || typeof channel.length !== 'number') return new Float32Array(0)
    const stage1 = biquadFilter(channel, pre)
    return biquadFilter(stage1, rlb)
  })
}

function loudnessFromMeanSquare(z) {
  if (!Number.isFinite(z) || z <= 0) return null
  return -0.691 + 10 * Math.log10(z)
}

/**
 * 真 K 加权积分响度 + 最大短时响度（BS.1770 风格）。
 *
 * 简化/近似说明（文档同款）：
 * - 400ms 块、75% 重叠；块内各声道 mean-square 相加后取 −0.691+10log10；
 * - 绝对门限 −70 LUFS；相对门限 = 过绝对门限块均值 −10 LU；
 * - 音频不足 400ms 时用整段单块（近似，`short:true`）；不足 3s 时
 *   `maxShortTerm` 退回最响 400ms 块（`shortTermApprox:true`）；
 * - 5.1/多声道按 BS.1770 只按声道求和（不做 surround 权重，本应用只有 mono/stereo）。
 *
 * @param {Array<Float32Array|number[]>} channels
 * @param {number} sampleRate
 * @returns {{integrated:number|null, maxShortTerm:number|null, method:string,
 *   short:boolean, shortTermApprox:boolean, blockCount:number, gatedBlockCount:number,
 *   durationSeconds:number}}
 */
export function computeKWeightedLoudness(channels, sampleRate) {
  const rate = Number(sampleRate)
  const fs = Number.isFinite(rate) && rate > 0 ? rate : 44100
  const list = (Array.isArray(channels) ? channels : []).filter(
    (channel) => channel && typeof channel.length === 'number' && channel.length > 0,
  )
  const frames = list.reduce((max, channel) => Math.max(max, Math.floor(channel.length)), 0)
  const empty = {
    integrated: null,
    maxShortTerm: null,
    method: 'itu-r-bs.1770-4',
    short: true,
    shortTermApprox: true,
    blockCount: 0,
    gatedBlockCount: 0,
    durationSeconds: frames / fs,
  }
  if (!frames) return empty

  const filtered = applyKWeighting(list, fs)
  const durationSeconds = frames / fs
  const blockSize = Math.max(1, Math.round(LUFS_BLOCK_SECONDS * fs))
  const hop = Math.max(1, Math.round(blockSize * (1 - LUFS_BLOCK_OVERLAP)))
  const shortBlocks = durationSeconds < LUFS_BLOCK_SECONDS

  // 400ms 块能量（各声道 mean-square 求和）
  const blockEnergies = []
  if (shortBlocks) {
    let z = 0
    for (const channel of filtered) {
      const length = Math.min(channel.length, blockSize)
      let sum = 0
      for (let i = 0; i < length; i++) sum += channel[i] * channel[i]
      z += length > 0 ? sum / length : 0
    }
    blockEnergies.push(z)
  } else {
    for (let start = 0; start + blockSize <= frames; start += hop) {
      let z = 0
      for (const channel of filtered) {
        let sum = 0
        const length = Math.min(channel.length, start + blockSize)
        for (let i = start; i < length; i++) sum += channel[i] * channel[i]
        z += sum / blockSize
      }
      blockEnergies.push(z)
    }
  }

  const blockLoudness = blockEnergies
    .map((z) => loudnessFromMeanSquare(z))
    .filter((value) => value !== null)
  const gated = blockEnergies.filter(
    (z) => loudnessFromMeanSquare(z) !== null && loudnessFromMeanSquare(z) > LUFS_ABSOLUTE_GATE,
  )
  let integrated = null
  if (gated.length) {
    const meanZ = gated.reduce((sum, value) => sum + value, 0) / gated.length
    const relativeThreshold = loudnessFromMeanSquare(meanZ)
    const relativeGate =
      relativeThreshold === null ? LUFS_ABSOLUTE_GATE : Math.max(LUFS_ABSOLUTE_GATE, relativeThreshold - LUFS_RELATIVE_GATE_LU)
    const finalBlocks = blockEnergies.filter((z) => {
      const loudness = loudnessFromMeanSquare(z)
      return loudness !== null && loudness > relativeGate
    })
    if (finalBlocks.length) {
      const finalMean = finalBlocks.reduce((sum, value) => sum + value, 0) / finalBlocks.length
      integrated = loudnessFromMeanSquare(finalMean)
    }
  }

  // 最大短时响度：优先 3s 滑窗（100ms 步进），不足 3s 用最响 400ms 块
  let maxShortTerm = null
  let shortTermApprox = true
  const shortWindow = Math.max(1, Math.round(LUFS_SHORT_TERM_SECONDS * fs))
  if (frames >= shortWindow) {
    shortTermApprox = false
    // 前缀平方和（每声道）→ O(1) 滑窗
    const prefixes = filtered.map((channel) => {
      const prefix = new Float64Array(channel.length + 1)
      for (let i = 0; i < channel.length; i++) prefix[i + 1] = prefix[i] + channel[i] * channel[i]
      return prefix
    })
    const hopSamples = Math.max(1, Math.round(0.1 * fs))
    for (let start = 0; start + shortWindow <= frames; start += hopSamples) {
      let z = 0
      for (const prefix of prefixes) {
        const end = Math.min(prefix.length - 1, start + shortWindow)
        const from = Math.min(start, end)
        z += (prefix[end] - prefix[from]) / shortWindow
      }
      const loudness = loudnessFromMeanSquare(z)
      if (loudness !== null && (maxShortTerm === null || loudness > maxShortTerm)) maxShortTerm = loudness
    }
  } else if (blockLoudness.length) {
    maxShortTerm = Math.max(...blockLoudness)
  }

  const short = shortBlocks || durationSeconds < LUFS_SHORT_TERM_SECONDS
  return {
    integrated,
    maxShortTerm,
    method: short ? 'itu-r-bs.1770-4-short' : 'itu-r-bs.1770-4',
    short,
    shortTermApprox,
    blockCount: blockEnergies.length,
    gatedBlockCount: gated.length,
    durationSeconds,
  }
}

// ---------------------------------------------------------------------------
// 立体声宽度 / 相关度
// ---------------------------------------------------------------------------

function channelRms(channel) {
  if (!channel || typeof channel.length !== 'number' || !channel.length) return 0
  let sum = 0
  for (let i = 0; i < channel.length; i++) {
    const value = finiteSample(channel[i])
    sum += value * value
  }
  return Math.sqrt(sum / channel.length)
}

/**
 * 立体声平衡（L/R RMS 差，dB）与零延迟归一化互相关。
 * 单声道返回 {stereoBalanceDb:null, correlation:null}；单侧静音 → balance 钳制 ±60dB。
 */
export function computeStereoMetrics(channels) {
  const list = Array.isArray(channels) ? channels.filter((channel) => channel && typeof channel.length === 'number') : []
  if (list.length < 2) return { stereoBalanceDb: null, correlation: null }
  const [left, right] = list
  const rmsLeft = channelRms(left)
  const rmsRight = channelRms(right)
  const leftSilent = rmsLeft < SILENCE_EPSILON
  const rightSilent = rmsRight < SILENCE_EPSILON
  let stereoBalanceDb = null
  if (!leftSilent && !rightSilent) {
    stereoBalanceDb = Math.max(-60, Math.min(60, 20 * Math.log10(rmsLeft / rmsRight)))
  } else if (!leftSilent || !rightSilent) {
    stereoBalanceDb = leftSilent ? -60 : 60
  }
  const frames = Math.min(left.length, right.length)
  let sumLR = 0
  let sumLL = 0
  let sumRR = 0
  for (let i = 0; i < frames; i++) {
    const l = finiteSample(left[i])
    const r = finiteSample(right[i])
    sumLR += l * r
    sumLL += l * l
    sumRR += r * r
  }
  const denom = Math.sqrt(sumLL * sumRR)
  const correlation = denom > SILENCE_EPSILON ? Math.max(-1, Math.min(1, sumLR / denom)) : null
  return { stereoBalanceDb, correlation }
}

// ---------------------------------------------------------------------------
// 频谱：Hann 窗 FFT → 谱质心 + 六段能量占比
// ---------------------------------------------------------------------------

/** 原地 radix-2 FFT（输入长度必须 2 的幂）。 */
function fftInPlace(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let tmp = re[i]
      re[i] = re[j]
      re[j] = tmp
      tmp = im[i]
      im[i] = im[j]
      im[j] = tmp
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    for (let start = 0; start < n; start += length) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < length / 2; k++) {
        const even = start + k
        const odd = even + length / 2
        const oddRe = re[odd] * curRe - im[odd] * curIm
        const oddIm = re[odd] * curIm + im[odd] * curRe
        re[odd] = re[even] - oddRe
        im[odd] = im[even] - oddIm
        re[even] += oddRe
        im[even] += oddIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/**
 * 平均功率谱（Hann 窗 + 多帧平均；长音频均匀抽样最多 SPECTRAL_MAX_FRAMES 帧）。
 * @returns {{power:Float64Array, binHz:number, fftSize:number, frames:number}|null}
 */
export function computeAverageSpectrum(channels, sampleRate) {
  const rate = Number(sampleRate)
  const fs = Number.isFinite(rate) && rate > 0 ? rate : 44100
  const list = (Array.isArray(channels) ? channels : []).filter(
    (channel) => channel && typeof channel.length === 'number' && channel.length > 0,
  )
  if (!list.length) return null
  const fftSize = SPECTRAL_FFT_SIZE
  const half = fftSize / 2
  const window = new Float64Array(fftSize)
  for (let i = 0; i < fftSize; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1))
  const powerSum = new Float64Array(half + 1)
  let frameCount = 0
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  for (const channel of list) {
    const length = Math.floor(channel.length)
    if (length <= 0) continue
    let starts = []
    if (length < fftSize) {
      starts = [0]
    } else {
      const stride = Math.max(half, Math.ceil((length - fftSize) / Math.max(1, SPECTRAL_MAX_FRAMES - 1)))
      for (let start = 0; start + fftSize <= length && starts.length < SPECTRAL_MAX_FRAMES; start += stride) {
        starts.push(start)
      }
    }
    for (const start of starts) {
      re.fill(0)
      im.fill(0)
      const count = Math.min(fftSize, length - start)
      for (let i = 0; i < count; i++) re[i] = finiteSample(channel[start + i]) * window[i]
      fftInPlace(re, im)
      for (let bin = 0; bin <= half; bin++) powerSum[bin] += re[bin] * re[bin] + im[bin] * im[bin]
      frameCount += 1
    }
  }
  if (!frameCount) return null
  const power = new Float64Array(half + 1)
  for (let bin = 0; bin <= half; bin++) power[bin] = powerSum[bin] / frameCount
  return { power, binHz: fs / fftSize, fftSize, frames: frameCount }
}

/** 谱质心（Hz，幅度加权）。 */
export function spectralCentroid(spectrum) {
  if (!spectrum || !spectrum.power || !spectrum.power.length) return null
  let weighted = 0
  let total = 0
  for (let bin = 0; bin < spectrum.power.length; bin++) {
    const magnitude = Math.sqrt(Math.max(0, spectrum.power[bin]))
    if (!Number.isFinite(magnitude)) continue
    weighted += bin * spectrum.binHz * magnitude
    total += magnitude
  }
  if (total <= SILENCE_EPSILON) return null
  return weighted / total
}

/** 六段能量占比（%），总和约 100（无能量 → 全 0）。 */
export function bandEnergyPct(spectrum) {
  const bands = Object.fromEntries(SPECTRAL_BANDS.map((band) => [band.key, 0]))
  if (!spectrum || !spectrum.power || !spectrum.power.length) return bands
  const totals = Object.fromEntries(SPECTRAL_BANDS.map((band) => [band.key, 0]))
  let totalPower = 0
  for (let bin = 0; bin < spectrum.power.length; bin++) {
    const power = Math.max(0, spectrum.power[bin])
    if (!Number.isFinite(power)) continue
    const frequency = bin * spectrum.binHz
    totalPower += power
    for (const band of SPECTRAL_BANDS) {
      if (frequency >= band.min && frequency < band.max) {
        totals[band.key] += power
        break
      }
    }
  }
  if (totalPower <= 0) return bands
  for (const band of SPECTRAL_BANDS) bands[band.key] = (totals[band.key] / totalPower) * 100
  return bands
}

// ---------------------------------------------------------------------------
// section（按秒区间分段统计）
// ---------------------------------------------------------------------------

/**
 * 规范化 sections 输入：支持 {startSeconds,endSeconds} 或 {startBeat,endBeat}+beatToSeconds 回调。
 * @returns {Array<{name:string,startSeconds:number,endSeconds:number}>}
 */
export function normalizeSectionBounds(sections, options = {}) {
  if (!Array.isArray(sections)) return []
  const beatToSeconds = typeof options.beatToSeconds === 'function' ? options.beatToSeconds : null
  const out = []
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue
    let startSeconds = Number(section.startSeconds)
    let endSeconds = Number(section.endSeconds)
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      if (!beatToSeconds) continue
      startSeconds = Number(beatToSeconds(Number(section.startBeat) || 0))
      endSeconds = Number(beatToSeconds(Number(section.endBeat) || 0))
    }
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) continue
    out.push({
      name: String(section.name ?? section.label ?? `section-${out.length + 1}`),
      startSeconds: Math.max(0, startSeconds),
      endSeconds: Math.max(0, endSeconds),
    })
    if (out.length >= 32) break
  }
  return out
}

/** 取声道在 [startFrame,endFrame) 的切片（subarray，零复制）。 */
function sliceChannel(channel, startFrame, endFrame) {
  if (!channel || typeof channel.length !== 'number') return new Float32Array(0)
  const from = Math.max(0, Math.min(channel.length, Math.floor(startFrame)))
  const to = Math.max(from, Math.min(channel.length, Math.floor(endFrame)))
  return typeof channel.subarray === 'function' ? channel.subarray(from, to) : Array.prototype.slice.call(channel, from, to)
}

// ---------------------------------------------------------------------------
// 全量分析
// ---------------------------------------------------------------------------

/**
 * 汇总多声道采样指标（兼容旧字段 + R0B 新增字段）。
 * @param {Array<Float32Array|number[]>} channels 各声道采样（长度可不同；非有限值按 0 处理）
 * @param {number} [sampleRate=44100]
 * @param {{sections?:Array, includeSectionStats?:boolean, beatToSeconds?:(beat:number)=>number,
 *   includeSpectrum?:boolean, includeLoudness?:boolean}} [options]
 * @returns {ReturnType<typeof analyzeChannels>}
 */
export function analyzeChannels(channels, sampleRate = 44100, options = {}) {
  const rate = Number(sampleRate)
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 44100
  const list = (Array.isArray(channels) ? channels : []).filter(
    (channel) => channel && typeof channel.length === 'number',
  )
  let peak = 0
  let sumSquares = 0
  let sum = 0
  let sampleCount = 0
  let clippedSamples = 0
  let maxFrames = 0
  for (const channel of list) {
    const length = Math.max(0, Math.floor(channel.length))
    maxFrames = Math.max(maxFrames, length)
    for (let i = 0; i < length; i++) {
      const value = finiteSample(channel[i])
      const magnitude = Math.abs(value)
      if (magnitude > peak) peak = magnitude
      if (magnitude >= CLIP_THRESHOLD) clippedSamples += 1
      sumSquares += value * value
      sum += value
      sampleCount += 1
    }
  }
  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0
  const peakDb = linearToDb(peak)
  const rmsDb = linearToDb(rms)
  const crestDb = peakDb - rmsDb

  // ---- R0B：真 LUFS / 立体声 / 频谱 --------------------------------------
  const includeLoudness = options?.includeLoudness !== false
  const loudness = includeLoudness
    ? computeKWeightedLoudness(list, safeRate)
    : { integrated: null, maxShortTerm: null, method: 'disabled', short: true, shortTermApprox: true, blockCount: 0, gatedBlockCount: 0, durationSeconds: maxFrames / safeRate }
  const stereo = computeStereoMetrics(list)
  const includeSpectrum = options?.includeSpectrum !== false
  const spectrum = includeSpectrum ? computeAverageSpectrum(list, safeRate) : null

  const result = {
    seconds: maxFrames / safeRate,
    sampleRate: safeRate,
    channels: list.length,
    peak,
    peakDb,
    rms,
    rmsDb,
    crestDb,
    lufsApprox: rmsDb + LUFS_APPROX_OFFSET,
    lufs: loudness.integrated,
    lufsMaxShortTerm: loudness.maxShortTerm,
    lufsMethod: loudness.method,
    lufsShort: loudness.short,
    lufsShortTermApprox: loudness.shortTermApprox,
    lufsBlockCount: loudness.blockCount,
    lufsGatedBlockCount: loudness.gatedBlockCount,
    stereoBalanceDb: stereo.stereoBalanceDb,
    correlation: stereo.correlation,
    spectralCentroidHz: spectrum ? spectralCentroid(spectrum) : null,
    bandEnergyPct: spectrum ? bandEnergyPct(spectrum) : null,
    clippedSamples,
    clipping: peak >= CLIP_THRESHOLD,
    silent: rmsDb < SILENT_DB,
    dcOffset: sampleCount > 0 ? sum / sampleCount : 0,
  }

  // ---- section 分段统计（按秒边界；beat 由 beatToSeconds 回调换算）-------
  const sectionsRequested =
    options?.includeSectionStats === true || (Array.isArray(options?.sections) && options.sections.length > 0)
  if (sectionsRequested) {
    const bounds = normalizeSectionBounds(options?.sections, options)
    result.sectionStats = bounds.map((section) => {
      const startFrame = Math.floor(section.startSeconds * safeRate)
      const endFrame = Math.min(maxFrames, Math.ceil(section.endSeconds * safeRate))
      const sliced = list.map((channel) => sliceChannel(channel, startFrame, endFrame))
      const metrics = analyzeChannels(sliced, safeRate, {
        includeSectionStats: false,
        includeSpectrum: true,
        includeLoudness: true,
      })
      return {
        name: section.name,
        startSeconds: section.startSeconds,
        endSeconds: section.endSeconds,
        seconds: metrics.seconds,
        silent: metrics.silent,
        clipping: metrics.clipping,
        peak: metrics.peak,
        peakDb: metrics.peakDb,
        rms: metrics.rms,
        rmsDb: metrics.rmsDb,
        lufs: metrics.lufs,
        lufsMaxShortTerm: metrics.lufsMaxShortTerm,
        lufsMethod: metrics.lufsMethod,
        stereoBalanceDb: metrics.stereoBalanceDb,
        correlation: metrics.correlation,
        spectralCentroidHz: metrics.spectralCentroidHz,
        bandEnergyPct: metrics.bandEnergyPct,
        dcOffset: metrics.dcOffset,
      }
    })
  }
  return result
}

/**
 * 分析 AudioBuffer（浏览器 AudioBuffer 或同形状 mock）。
 * 非法/空 buffer 返回空分析（不抛异常）。
 * @param {{numberOfChannels?:number, sampleRate?:number, length?:number,
 *   getChannelData?:(channel:number)=>Float32Array}|null} buffer
 * @param {object} [options] 同 analyzeChannels（sections/includeSectionStats/beatToSeconds…）
 * @returns {ReturnType<typeof analyzeChannels>}
 */
export function analyzeAudioBuffer(buffer, options = {}) {
  if (!buffer || typeof buffer.getChannelData !== 'function') {
    return analyzeChannels([], Number(buffer?.sampleRate) || 44100, options)
  }
  const channelCount = Math.max(0, Math.min(32, Math.floor(Number(buffer.numberOfChannels) || 1)))
  const channels = []
  for (let channel = 0; channel < channelCount; channel++) {
    try {
      channels.push(buffer.getChannelData(channel))
    } catch {
      channels.push(new Float32Array(0))
    }
  }
  if (channels.length === 0) channels.push(new Float32Array(0))
  return analyzeChannels(channels, Number(buffer.sampleRate) || 44100, options)
}

/**
 * 峰值归一化增益：把整体峰值缩放到 targetPeak（默认 0.98）。
 * peak 为 0（静音）→ 返回 1（不做任何缩放）。
 * @param {Array<Float32Array|number[]>} channels
 * @param {number} [targetPeak=0.98]
 * @returns {number}
 */
export function peakNormalizeGain(channels, targetPeak = DEFAULT_NORMALIZE_PEAK) {
  const target = Number(targetPeak)
  const safeTarget = Number.isFinite(target) && target > 0 ? target : DEFAULT_NORMALIZE_PEAK
  const list = Array.isArray(channels) ? channels : []
  let peak = 0
  for (const channel of list) {
    if (!channel || typeof channel.length !== 'number') continue
    const length = Math.max(0, Math.floor(channel.length))
    for (let i = 0; i < length; i++) {
      const magnitude = Math.abs(finiteSample(channel[i]))
      if (magnitude > peak) peak = magnitude
    }
  }
  if (peak < SILENCE_EPSILON) return 1
  return safeTarget / peak
}
