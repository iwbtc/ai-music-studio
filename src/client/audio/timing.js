/**
 * 音乐时间 / 调度相关的纯计算（audio-engine）。
 *
 * 不依赖 AudioContext、Web Audio：Node 单测直接覆盖这里。
 * 实时引擎与离线渲染共用同一套事件展开、swing、loop、位置换算逻辑。
 */
import { beatsPerBar, clipNotes } from '../../shared/model.js'
import { clamp } from './dsp.js'

/** 每拍秒数（60 / bpm）。 */
export function secondsPerBeat(bpm) {
  return 60 / clamp(bpm, 20, 400)
}

/** bpm → beats per second。 */
export function bpmToBps(bpm) {
  return clamp(bpm, 20, 400) / 60
}

/** 16 分音符网格（单位：beat）。 */
export const GRID_BEATS = 0.25

/**
 * Swing 延迟（单位：beat）。
 *
 * 约定：只延迟落在「奇数 16 分音符」上的音符；
 * swing=1 时把 16 分音符对推进到 2:1 的三连音位置，即延迟 1/12 beat。
 * 不在 16 分网格附近（±0.02 beat）的音符不受影响。
 */
export function swingOffset(startBeat, swing, gridBeats = GRID_BEATS) {
  const s = clamp(swing, 0, 1)
  if (s <= 0) return 0
  const grid = clamp(gridBeats, 0.0625, 1)
  const beat = Number(startBeat)
  if (!Number.isFinite(beat) || beat < 0) return 0
  const snapped = Math.round(beat / grid) * grid
  if (Math.abs(beat - snapped) > grid * 0.08) return 0
  const step = Math.round(snapped / grid)
  if (step % 2 === 0) return 0
  return (s * grid) / 3
}

/**
 * 把 project.patterns/clips 展开成整首的绝对音符事件（单位：beat）。
 *
 * 依赖 shared/model.js 的 clipNotes()：clip 内 pattern 循环平铺 + transpose。
 * @returns {{ events: Array<{trackId:string,kind:string,pitch:number,vel:number,startBeat:number,durBeats:number,swingBeats:number}>, totalBeats:number, barBeats:number }}
 */
export function expandProjectEvents(project) {
  const barBeats = beatsPerBar(project)
  const lengthBars = Math.max(1, Math.round(Number(project?.lengthBars) || 1))
  const totalBeats = lengthBars * barBeats
  const swing = clamp(Number(project?.swing) || 0, 0, 1)
  const events = []
  const tracks = new Map((project?.tracks ?? []).map((t) => [t.id, t]))
  for (const clip of project?.clips ?? []) {
    const track = tracks.get(clip?.trackId)
    if (!track) continue
    let notes = []
    try {
      notes = clipNotes(project, clip)
    } catch {
      notes = []
    }
    for (const note of notes) {
      const startBeat = Number(note.start)
      if (!Number.isFinite(startBeat) || startBeat < 0) continue
      if (startBeat >= totalBeats - 1e-9) continue
      const durBeats = Math.min(
        Math.max(0.02, Number(note.dur) || 0.25),
        Math.max(0.02, totalBeats - startBeat),
      )
      events.push({
        trackId: track.id,
        kind: track.kind,
        pitch: Math.round(clamp(note.pitch, 0, 127)),
        vel: clamp(Number(note.vel) || 0, 0, 1),
        startBeat,
        durBeats,
        swingBeats: swingOffset(startBeat, swing),
      })
    }
  }
  events.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch || (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0))
  return { events, totalBeats, barBeats }
}

/**
 * 计算一次播放的区间 / loop 信息（纯函数）。
 *
 * 规则（与 CONTRACT 对齐）：
 * - `loopStartBar < loopEndBar` 且区间有效 → 在 [loopStartBar, loopEndBar) 内循环；
 * - 否则从 fromBar 播到 lengthBars 后停止。
 * - 若 fromBar 落在 loop 区间外，循环播放时从 loop 起点开始。
 */
export function createPlaybackPlan(project, fromBar) {
  const barBeats = beatsPerBar(project)
  const lengthBars = Math.max(1, Math.round(Number(project?.lengthBars) || 1))
  const totalBeats = lengthBars * barBeats
  const tr = project?.transport ?? {}
  const rawLoopStart = Number(tr.loopStartBar)
  const rawLoopEnd = Number(tr.loopEndBar)
  const loopStartBar = clamp(Number.isFinite(rawLoopStart) ? rawLoopStart : 0, 0, lengthBars)
  const loopEndBar = clamp(Number.isFinite(rawLoopEnd) ? rawLoopEnd : 0, 0, lengthBars)
  const looping = loopEndBar - loopStartBar >= 0.999 && loopEndBar <= lengthBars

  let startBar = clamp(Number(fromBar) || 0, 0, lengthBars)
  if (looping) {
    if (startBar < loopStartBar || startBar >= loopEndBar - 1e-9) startBar = loopStartBar
  } else if (startBar >= lengthBars - 1e-9) {
    startBar = 0
  }

  const rangeStartBar = looping ? loopStartBar : startBar
  const rangeEndBar = looping ? loopEndBar : lengthBars
  const rangeStartBeat = rangeStartBar * barBeats
  const rangeEndBeat = rangeEndBar * barBeats
  return {
    barBeats,
    lengthBars,
    totalBeats,
    looping,
    startBar,
    startBeat: startBar * barBeats,
    rangeStartBar,
    rangeEndBar,
    rangeStartBeat,
    rangeEndBeat,
    rangeLenBeats: Math.max(barBeats * 0.25, rangeEndBeat - rangeStartBeat),
  }
}

/**
 * 把整首事件映射为「相对当前播放锚点」的调度列表（单位：beat）。
 *
 * - `relU`：该事件在 loop 周期内的相对位置（0..rangeLenBeats）。播放开始后
 *   第 k 次循环里实际 transport 位置是 k*rangeLenBeats + relU。
 * - 循环时区间外的音符被丢弃，跨越 loop 末尾的音符被截断到区间末尾；
 *   非循环时，锚点之前的音符被丢弃。
 */
export function mapEventsToTransport(events, plan, anchorBeat) {
  const out = []
  const loopLen = plan.rangeLenBeats
  const u0 = clamp(Number(anchorBeat) || 0, plan.rangeStartBeat, plan.rangeEndBeat) - plan.rangeStartBeat
  for (const ev of events ?? []) {
    const start = Number(ev.startBeat)
    if (!Number.isFinite(start)) continue
    if (start < plan.rangeStartBeat - 1e-9 || start >= plan.rangeEndBeat - 1e-9) continue
    let relU = start - plan.rangeStartBeat - u0
    if (plan.looping) relU = ((relU % loopLen) + loopLen) % loopLen
    else if (relU < -1e-9) continue
    let durBeats = Math.max(0.02, Number(ev.durBeats) || 0.25)
    const room = loopLen - relU
    if (durBeats > room) durBeats = Math.max(0.02, room)
    out.push({ ...ev, relU, durBeats })
  }
  out.sort((a, b) => a.relU - b.relU)
  return out
}

/**
 * 由播放锚点推算当前 transport 所在的绝对 beat（考虑 loop 回绕）。
 * @returns {number} 绝对 beat（歌曲时间轴上，非 transport 偏移）
 */
export function positionBeatAt(plan, { anchorBeat, anchorTime, now, bps }) {
  const elapsed = Math.max(0, (Number(now) || 0) - (Number(anchorTime) || 0))
  const u0 = clamp(Number(anchorBeat) || 0, plan.rangeStartBeat, plan.rangeEndBeat) - plan.rangeStartBeat
  const u = u0 + elapsed * Math.max(0.01, Number(bps) || 2)
  if (plan.looping) {
    const wrapped = ((u % plan.rangeLenBeats) + plan.rangeLenBeats) % plan.rangeLenBeats
    return plan.rangeStartBeat + wrapped
  }
  return plan.rangeStartBeat + clamp(u, 0, plan.rangeLenBeats)
}

/** 当前 transport 速度（beats per second）下的「播放还剩余多少 beat」（非循环用）。 */
export function remainingBeats(plan, { anchorBeat, anchorTime, now, bps }) {
  const elapsed = Math.max(0, (Number(now) || 0) - (Number(anchorTime) || 0))
  const u0 = clamp(Number(anchorBeat) || 0, plan.rangeStartBeat, plan.rangeEndBeat) - plan.rangeStartBeat
  return Math.max(0, plan.rangeLenBeats - (u0 + elapsed * Math.max(0.01, Number(bps) || 2)))
}
