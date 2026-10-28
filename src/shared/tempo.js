/**
 * Tempo map 纯函数（CONTRACT-P12 §1.2，schema 2）。
 *
 * 数据模型：`project.tempoMap = [{beat, bpm}]`（最多 64 点；beat ≥0 升序去重；bpm 40–200；
 * 缺省/空 = 常量 `project.bpm`）。BPM 在相邻点之间线性插值，beat↔秒用闭式积分：
 *   Δt = ∫ 60/bpm(b) db
 *      = (60/slope) * ln(bpm2/bpm1)      （slope ≠ 0，BPM 线性变化）
 *      = (b2-b1) * 60/bpm1               （slope = 0）
 * 秒→beat 为分段反解（缓存每个 tempo 点的累计秒数），O(log n)。
 *
 * 纯计算、无依赖（Node 可单测；不 import model/catalog，避免循环依赖）。
 */

export const TEMPO_MIN_BPM = 40
export const TEMPO_MAX_BPM = 200
export const MAX_TEMPO_POINTS = 64
export const DEFAULT_BPM = 120

/** BPM 钳制到 40–200；非法值回 fallback（缺省 120）。 */
export function clampTempoBpm(value, fallback = DEFAULT_BPM) {
  const bpm = Number(value)
  if (Number.isFinite(bpm)) return Math.min(TEMPO_MAX_BPM, Math.max(TEMPO_MIN_BPM, bpm))
  const fallbackBpm = Number(fallback)
  if (Number.isFinite(fallbackBpm)) return Math.min(TEMPO_MAX_BPM, Math.max(TEMPO_MIN_BPM, fallbackBpm))
  return DEFAULT_BPM
}

/** 每小节 beats（与 model.beatsPerBar 一致：取拍号分子；缺省 4/4）。 */
export function projectBeatsPerBar(project) {
  const numerator = Array.isArray(project?.timeSignature) ? Number(project.timeSignature[0]) : 4
  return Number.isFinite(numerator) && numerator > 0 ? numerator : 4
}

/**
 * 规范化 tempo 点：丢弃非法点，bpm 钳制 40–200，beat ≥0 且 <= maxBeat，
 * 按 beat 升序去重（同 beat 后者覆盖），最多 maxPoints 个。
 * @param {unknown} raw
 * @param {{baseBpm?:number, maxBeat?:number, maxPoints?:number}} [options]
 * @returns {Array<{beat:number, bpm:number}>}
 */
export function normalizeTempoPoints(raw, options = {}) {
  const fallbackBpm = clampTempoBpm(options.baseBpm)
  const limit = Math.min(
    MAX_TEMPO_POINTS,
    Math.max(1, Math.floor(Number(options.maxPoints) || MAX_TEMPO_POINTS)),
  )
  const maxBeat = Number(options.maxBeat)
  const hasMaxBeat = Number.isFinite(maxBeat) && maxBeat >= 0
  if (!Array.isArray(raw)) return []
  const valid = []
  for (const point of raw) {
    if (!point || typeof point !== 'object') continue
    const beat = Number(point.beat)
    if (!Number.isFinite(beat) || beat < 0) continue
    const clampedBeat = hasMaxBeat ? Math.min(beat, maxBeat) : beat
    valid.push({ beat: clampedBeat, bpm: clampTempoBpm(point.bpm, fallbackBpm) })
  }
  valid.sort((a, b) => a.beat - b.beat)
  const deduped = []
  for (const point of valid) {
    if (deduped.length && deduped[deduped.length - 1].beat === point.beat) {
      deduped[deduped.length - 1] = point
    } else {
      deduped.push(point)
    }
  }
  return deduped.slice(0, limit)
}

/** 一段线性 BPM 区间的时长（秒）。 */
function segmentSeconds(beatA, bpmA, beatB, bpmB) {
  const beats = beatB - beatA
  if (!(beats > 0)) return 0
  const bpmDelta = bpmB - bpmA
  if (Math.abs(bpmDelta) < 1e-9) return (beats * 60) / bpmA
  const slope = bpmDelta / beats // BPM / beat
  return (60 / slope) * Math.log(bpmB / bpmA)
}

/** 从 beatA 到 beat（段内线性 BPM）的时长（秒）。 */
function partialSeconds(beatA, bpmA, beat, bpmAt) {
  const beats = beat - beatA
  if (!(beats > 0)) return 0
  const bpmDelta = bpmAt - bpmA
  if (Math.abs(bpmDelta) < 1e-9) return (beats * 60) / bpmA
  const slope = bpmDelta / beats // BPM / beat（段内）
  return (60 / slope) * Math.log(bpmAt / bpmA)
}

/** 二分查找：返回满足 array[i] <= value 的最大 i（array 升序；value < array[0] 返回 -1）。 */
function lastIndexAtOrBefore(array, value) {
  let lo = 0
  let hi = array.length - 1
  let answer = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (array[mid] <= value + 1e-12) {
      answer = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return answer
}

/**
 * 创建 tempo map 访问器。
 * 常量 BPM（tempoMap 缺省/空）时所有换算与旧 `60/bpm` 完全一致。
 *
 * @param {object} project 工程（使用 tempoMap/bpm/lengthBars/timeSignature）
 * @returns {{
 *   hasTempo:boolean, baseBpm:number, points:Array<{beat:number,bpm:number}>, durationBeats:number,
 *   bpmAtBeat:(beat:number)=>number,
 *   beatToSeconds:(beat:number)=>number,
 *   secondsToBeat:(seconds:number)=>number,
 *   beatToSecondsRange:(from:number,to:number)=>number
 * }}
 */
export function createTempoMap(project) {
  const baseBpm = clampTempoBpm(project?.bpm)
  const barBeats = projectBeatsPerBar(project)
  const lengthBars = Number(project?.lengthBars)
  const durationBeats =
    Number.isFinite(lengthBars) && lengthBars > 0 ? lengthBars * barBeats : Number.POSITIVE_INFINITY
  const maxBeat = Number.isFinite(durationBeats) ? durationBeats : undefined
  const points = normalizeTempoPoints(project?.tempoMap, { baseBpm, maxBeat })

  const beatToSecondsConst = (beat) => {
    const b = Number(beat)
    return Number.isFinite(b) ? (b * 60) / baseBpm : 0
  }
  const secondsToBeatConst = (seconds) => {
    const s = Number(seconds)
    return Number.isFinite(s) ? (s * baseBpm) / 60 : 0
  }

  if (points.length === 0) {
    return {
      hasTempo: false,
      baseBpm,
      points,
      durationBeats,
      bpmAtBeat: () => baseBpm,
      beatToSeconds: beatToSecondsConst,
      secondsToBeat: secondsToBeatConst,
      beatToSecondsRange: (from, to) => beatToSecondsConst(Number(to) || 0) - beatToSecondsConst(Number(from) || 0),
    }
  }

  // 断点表：若首个 tempo 点不在 beat 0，则用其 BPM 从 beat 0 常量延伸（向前保持首点速度）。
  const breakpoints = []
  if (points[0].beat > 0) breakpoints.push({ beat: 0, bpm: points[0].bpm })
  for (const point of points) breakpoints.push({ beat: point.beat, bpm: point.bpm })
  const beats = breakpoints.map((point) => point.beat)
  const bpmList = breakpoints.map((point) => point.bpm)
  const cumulative = new Array(breakpoints.length).fill(0)
  for (let i = 1; i < breakpoints.length; i++) {
    cumulative[i] =
      cumulative[i - 1] + segmentSeconds(beats[i - 1], bpmList[i - 1], beats[i], bpmList[i])
  }
  const lastIndex = breakpoints.length - 1
  const lastBeat = beats[lastIndex]
  const lastBpm = bpmList[lastIndex]
  const lastCumulative = cumulative[lastIndex]

  function bpmAtBeat(beat) {
    const target = Number(beat)
    if (!Number.isFinite(target)) return bpmList[0]
    if (target <= beats[0]) return bpmList[0]
    if (target >= lastBeat) return lastBpm
    const index = lastIndexAtOrBefore(beats, target)
    const a = Math.max(0, index)
    const b = Math.min(lastIndex, a + 1)
    if (b <= a) return bpmList[a]
    const span = beats[b] - beats[a]
    if (!(span > 1e-12)) return bpmList[b]
    const ratio = (target - beats[a]) / span
    return bpmList[a] + (bpmList[b] - bpmList[a]) * ratio
  }

  function beatToSeconds(beat) {
    const target = Number(beat)
    if (!Number.isFinite(target)) return 0
    if (target <= beats[0]) return ((target - beats[0]) * 60) / bpmList[0]
    if (target >= lastBeat) {
      return lastCumulative + ((target - lastBeat) * 60) / lastBpm
    }
    const index = Math.max(0, lastIndexAtOrBefore(beats, target))
    const b = Math.min(lastIndex, index + 1)
    const within = partialSeconds(beats[index], bpmList[index], target, bpmAtBeat(target))
    return cumulative[index] + within
  }

  function secondsToBeat(seconds) {
    const target = Number(seconds)
    if (!Number.isFinite(target)) return 0
    if (target <= 0) return (target * bpmList[0]) / 60
    if (target >= lastCumulative) {
      return lastBeat + ((target - lastCumulative) * lastBpm) / 60
    }
    const index = Math.max(0, lastIndexAtOrBefore(cumulative, target))
    const b = Math.min(lastIndex, index + 1)
    if (b <= index) return beats[index]
    const elapsed = target - cumulative[index]
    const bpmA = bpmList[index]
    const bpmB = bpmList[b]
    const beatSpan = beats[b] - beats[index]
    const bpmDelta = bpmB - bpmA
    if (Math.abs(bpmDelta) < 1e-9 || beatSpan <= 1e-12) {
      return beats[index] + (elapsed * bpmA) / 60
    }
    const slope = bpmDelta / beatSpan // BPM / beat
    const bpmAtTarget = bpmA * Math.exp((elapsed * slope) / 60)
    return beats[index] + (bpmAtTarget - bpmA) / slope
  }

  return {
    hasTempo: true,
    baseBpm,
    points,
    durationBeats,
    bpmAtBeat,
    beatToSeconds,
    secondsToBeat,
    beatToSecondsRange: (from, to) => beatToSeconds(Number(to) || 0) - beatToSeconds(Number(from) || 0),
  }
}

/** 便捷：工程在某个 beat 的当前 BPM（tempoMap 优先，否则 project.bpm）。 */
export function bpmAtBeat(project, beat) {
  return createTempoMap(project).bpmAtBeat(beat)
}

/** 便捷：`lengthBars * barBeats` 对应的秒数（tempoMap 积分）。 */
export function projectDurationSeconds(project) {
  const tempo = createTempoMap(project)
  const beats = tempo.durationBeats
  return Number.isFinite(beats) ? tempo.beatToSeconds(beats) : Number.POSITIVE_INFINITY
}
