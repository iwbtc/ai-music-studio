/**
 * 延音踏板（CC64）纯函数（CONTRACT-P11 §3，audio-engine）。
 *
 * 轨道数据：`track.sustain = [{beat, value}]`（value 0/1；缺省/空 = 无踏板）。
 * 语义：采样保持（step）——某 beat 处的踏板状态 = 该 beat 之前（含）最后一个点的值；
 * value >= 0.5 视为「按下」。音符结束时踏板按下，则延长到下一次抬起（value<0.5）
 * 的 beat，最多延长 `SUSTAIN_MAX_HOLD_SECONDS`（8 秒）对应的 beats。
 *
 * 纯计算，Node 可单测；非法点（非对象/NaN/非数组）全部忽略，不抛异常。
 */

/** 踏板最多延长的秒数（引擎换算成 beats 传入）。 */
export const SUSTAIN_MAX_HOLD_SECONDS = 8

/** 踏板按下判定阈值（value >= 0.5 视为按下）。 */
export const SUSTAIN_DOWN_THRESHOLD = 0.5

/**
 * 规范化踏板点：只保留 `{beat:finite, value:finite}`，按 beat 升序，同 beat 后者覆盖。
 * 返回新数组（不修改输入）。
 * @param {unknown} points
 * @returns {Array<{beat:number, value:number}>}
 */
export function normalizeSustainPoints(points) {
  if (!Array.isArray(points)) return []
  const valid = []
  for (const point of points) {
    if (!point || typeof point !== 'object') continue
    const beat = Number(point.beat)
    const value = Number(point.value)
    if (!Number.isFinite(beat) || !Number.isFinite(value)) continue
    valid.push({ beat, value: value >= SUSTAIN_DOWN_THRESHOLD ? 1 : 0 })
  }
  valid.sort((a, b) => a.beat - b.beat)
  // 同一 beat 保留最后一个（与「按 beat 升序去重」语义一致）
  const out = []
  for (const point of valid) {
    if (out.length && out[out.length - 1].beat === point.beat) out[out.length - 1] = point
    else out.push(point)
  }
  return out
}

/**
 * 指定 beat 处的踏板值（0/1，采样保持）。
 * @param {unknown} points
 * @param {number} beat
 * @returns {number} 0 或 1
 */
export function sustainAt(points, beat) {
  const list = normalizeSustainPoints(points)
  const target = Number(beat)
  if (!list.length || !Number.isFinite(target)) return 0
  let value = 0
  for (const point of list) {
    if (point.beat > target) break
    value = point.value
  }
  return value
}

/**
 * 计算考虑延音踏板后的音符结束 beat。
 * - 音符结束时踏板未按下 → 原样返回 endBeat；
 * - 按下 → 延长到下一次 value<0.5 的 beat；若之后不再抬起，则用 maxHoldBeats 封顶
 *   （maxHoldBeats 有限时；省略/非有限时表示不封顶，返回 Infinity）。
 * @param {unknown} points 踏板点
 * @param {number} startBeat 音符开始 beat（用于边界校验/保留签名）
 * @param {number} endBeat 音符原本结束 beat
 * @param {number} [maxHoldBeats=Infinity] 最多延长多少 beat（引擎传 8s × bps）
 * @returns {number} 延长后的结束 beat（可能为 Infinity）
 */
export function effectiveNoteEndBeat(points, startBeat, endBeat, maxHoldBeats = Number.POSITIVE_INFINITY) {
  const rawStart = Number(startBeat)
  const rawEnd = Number(endBeat)
  const safeStart = Number.isFinite(rawStart) ? rawStart : 0
  const safeEnd = Number.isFinite(rawEnd) ? Math.max(safeStart, rawEnd) : safeStart
  const list = normalizeSustainPoints(points)
  if (!list.length) return safeEnd
  if (sustainAt(list, safeEnd) < SUSTAIN_DOWN_THRESHOLD) return safeEnd
  const maxHold = Number(maxHoldBeats)
  const maxHoldValue = Number.isFinite(maxHold) && maxHold >= 0 ? maxHold : Number.POSITIVE_INFINITY
  // 找音符结束之后第一次抬起
  let releaseBeat = Number.POSITIVE_INFINITY
  for (const point of list) {
    if (point.beat > safeEnd && point.value < SUSTAIN_DOWN_THRESHOLD) {
      releaseBeat = point.beat
      break
    }
  }
  const capped = Math.min(releaseBeat, safeEnd + maxHoldValue)
  return Math.max(safeEnd, capped)
}

/** 8 秒对应的 beats（引擎用）。 */
export function sustainMaxHoldBeats(bps) {
  const rate = Number(bps)
  if (!Number.isFinite(rate) || rate <= 0) return SUSTAIN_MAX_HOLD_SECONDS
  return SUSTAIN_MAX_HOLD_SECONDS * rate
}
