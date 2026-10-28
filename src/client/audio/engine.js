/**
 * 音频引擎（audio-engine）— 实时播放 + 离线 WAV 渲染。
 *
 * 对外 API 严格按 CONTRACT.md 第 6 节：
 *   new StudioEngine({ onPosition?, onState? })
 *   get unlocked / async unlock() / setProject(project) / play(fromBar?) / stop() / seek(bar)
 *   get positionBar / get isPlaying / getLevels() / getSpectrum(out)
 *   previewNote(trackId, pitch, velocity?) / stopPreview(id) / stopAllPreviews()   // 键盘演奏试听
 *   async renderWav(project, opts?) / dispose()
 *   encodeWav(audioBuffer)
 *
 * 设计要点：
 * - 构造时不创建 AudioContext（浏览器自动播放限制）；unlock() 在用户手势里创建/resume。
 * - 未 unlock 时 play() 安全排队（pendingPlay），unlock 后自动开始。
 * - lookahead 调度器：25ms 定时器，提前 0.12s 把事件排进 Web Audio 时间轴。
 * - 实时与离线渲染复用 graph.js / synths.js / drums.js / fx.js 的同一套建图代码。
 *
 * 模块加载时不做任何 Web Audio 调用；Node 单测可安全 import。
 */
import {
  beatsPerBar,
  pitchToFreq,
  automationValueAt,
  AUTOMATION_PARAMS,
} from '../../shared/model.js'
import {
  buildMixGraph,
  graphSignature,
  trackGainForValue,
  emptyMeters,
  effectiveAutomationVolume,
} from './graph.js'
import { buildSynthVoice, resolveSynthParams } from './synths.js'
import { buildDrumHit, resolveDrumParams, drumPieceForPitch } from './drums.js'
import { SampleBank, buildSampleVoice, buildSampleDrum, allSampleFiles, collectSampleFiles } from './samples.js'
import { MediaBank, buildAudioClipSegments, buildClipFadeEnvelope, mediaIdentity } from './media.js'
import { SoundfontBank, voiceInstrumentOptions } from './soundfont.js'
import {
  buildSubtractiveVoice,
  resolveSubtractiveParams,
  instrumentParamsToSynthOverrides,
  MAX_SUBTRACTIVE_VOICES,
} from './synth.js'
import { findDrumKit, findSynthPreset, findSynthInstrument, SYNTH_INSTRUMENTS, presetGainScale, kitGainScale } from '../../shared/catalog.js'
import { encodeWav } from './wav.js'
import { analyzeChannels } from './analysis.js'
import {
  bpmToBps,
  expandProjectEvents,
  createPlaybackPlan,
  mapEventsToTransport,
} from './timing.js'
import { clamp, clamp01 } from './dsp.js'
import { effectiveNoteEndBeat, SUSTAIN_MAX_HOLD_SECONDS } from './sustain.js'
import { createTempoMap } from '../../shared/tempo.js'
import {
  ensureExternalPluginWorklet,
  getExternalPluginApi,
  isExternalPluginSupported,
  isExternalInstrumentTrack,
  frozenMediaEntry,
  isFrozenTrack,
  frozenTrackInfo,
  freezeStatusOf,
  unfrozenVst3Tracks,
  listFrozenTracks,
  float32PlanesToBase64,
  externalInstanceIdForEffect,
  externalInstanceIdForTrack,
} from './external-plugin.js'

export { encodeWav }

/**
 * v2.1 P0：采样峰值 + 4x Catmull-Rom 插值近似 true peak（dBTP）。
 * 线性插值不会超过相邻采样点，无法捕获 inter-sample peak，因此用三次插值近似；
 * 注：这是轻量近似（非 ITU-R BS.1770-4 附录 2 的 4x FIR 真峰值表），用于导出回传与回归对比。
 * @param {Array<Float32Array|number[]>} channels
 * @param {number} [oversample=4]
 * @returns {{peak:number, peakDb:number, truePeak:number, truePeakDb:number}}
 */
export function measureTruePeak(channels, oversample = 4) {
  const list = (Array.isArray(channels) ? channels : []).filter(
    (channel) => channel && typeof channel.length === 'number',
  )
  const steps = Math.max(1, Math.round(Number(oversample) || 4))
  let peak = 0
  let truePeak = 0
  const db = (linear) => (linear > 0 ? Math.max(-120, 20 * Math.log10(linear)) : -120)
  const at = (channel, index, fallback) => {
    if (index < 0 || index >= channel.length) return fallback
    const value = Number(channel[index])
    return Number.isFinite(value) ? value : fallback
  }
  for (const channel of list) {
    const length = Math.floor(channel.length)
    for (let i = 0; i < length; i++) {
      const value = Number(channel[i])
      if (!Number.isFinite(value)) continue
      const magnitude = Math.abs(value)
      if (magnitude > peak) peak = magnitude
    }
    if (steps <= 1) continue
    for (let i = 0; i < length; i++) {
      const x0 = at(channel, i - 1, at(channel, i, 0))
      const x1 = at(channel, i, 0)
      const x2 = at(channel, i + 1, x1)
      const x3 = at(channel, i + 2, x2)
      for (let k = 1; k < steps; k++) {
        const t = k / steps
        // Catmull-Rom（可产生 inter-sample 过冲，比线性插值更接近真峰值）
        const a0 = -0.5 * x0 + 1.5 * x1 - 1.5 * x2 + 0.5 * x3
        const a1 = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3
        const a2 = -0.5 * x0 + 0.5 * x2
        const value = ((a0 * t + a1) * t + a2) * t + x1
        const magnitude = Math.abs(value)
        if (magnitude > truePeak) truePeak = magnitude
      }
    }
  }
  truePeak = Math.max(truePeak, peak)
  return { peak, peakDb: db(peak), truePeak, truePeakDb: db(truePeak) }
}

/**
 * v2.1 P0：按 ITU-R BS.1770-4（K 加权积分 LUFS）把导出行拉向 targetLufs。
 * - 与 preview 的 analyzeChannels / lufs 同源（真 K 加权，不再用 lufsApprox）；
 * - 峰值保护：truePeak 超过 peakCeiling（默认 0.98 ≈ -0.18dBFS）时整体回退增益，achievedLufs 回传实际值；
 * - 原地缩放 channels（Float32Array）；返回本次增益与实测指标供 exportStatus 回传。
 * @param {Array<Float32Array|number[]>} channels
 * @param {number} sampleRate
 * @param {number} targetLufs
 * @param {{peakCeiling?:number, sampleRate?:number}} [options]
 * @returns {{targetLufs:number, baseLufs:number|null, gain:number, gainDb:number,
 *   achievedLufs:number|null, peak:number, peakDb:number, truePeak:number, truePeakDb:number,
 *   limited:boolean, clamped:boolean}}
 */
export function applyTargetLufsGain(channels, sampleRate, targetLufs, options = {}) {
  const list = (Array.isArray(channels) ? channels : []).filter(
    (channel) => channel && typeof channel.length === 'number',
  )
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : RENDER_SAMPLE_RATE
  const target = Number(targetLufs)
  const ceiling = Number.isFinite(Number(options?.peakCeiling))
    ? clamp(Number(options.peakCeiling), 0.05, 1)
    : 0.98
  const before = analyzeChannels(list, rate, { includeSpectrum: false })
  const baseLufs = Number.isFinite(before.lufs) ? before.lufs : null
  if (!Number.isFinite(target) || baseLufs === null) {
    const truePeak = measureTruePeak(list)
    return {
      targetLufs: Number.isFinite(target) ? target : null,
      baseLufs,
      gain: 1,
      gainDb: 0,
      achievedLufs: baseLufs,
      peak: truePeak.peak,
      peakDb: truePeak.peakDb,
      truePeak: truePeak.truePeak,
      truePeakDb: truePeak.truePeakDb,
      limited: false,
      clamped: true,
    }
  }
  const gain = Math.pow(10, (target - baseLufs) / 20)
  for (const channel of list) {
    for (let i = 0; i < channel.length; i++) {
      const value = Number(channel[i])
      channel[i] = Number.isFinite(value) ? value * gain : 0
    }
  }
  let appliedGain = gain
  let limited = false
  let truePeak = measureTruePeak(list)
  if (truePeak.truePeak > ceiling) {
    const clampGain = ceiling / truePeak.truePeak
    for (const channel of list) {
      for (let i = 0; i < channel.length; i++) channel[i] *= clampGain
    }
    appliedGain *= clampGain
    limited = true
    truePeak = measureTruePeak(list)
  }
  const after = analyzeChannels(list, rate, { includeSpectrum: false })
  return {
    targetLufs: target,
    baseLufs,
    gain: appliedGain,
    gainDb: 20 * Math.log10(Math.max(1e-12, appliedGain)),
    achievedLufs: Number.isFinite(after.lufs) ? after.lufs : null,
    peak: truePeak.peak,
    peakDb: truePeak.peakDb,
    truePeak: truePeak.truePeak,
    truePeakDb: truePeak.truePeakDb,
    limited,
    clamped: false,
  }
}

/** 调度器参数（CONTRACT 第 6 节）。 */
export const LOOKAHEAD_MS = 25
export const SCHEDULE_AHEAD_SECONDS = 0.12
/** 同时最多 voice 数（超出时优先偷最老的合成器 voice）。 */
export const MAX_VOICES = 60
/** 导出时长上限：8 分钟。 */
export const MAX_RENDER_SECONDS = 8 * 60
/** 渲染采样率。 */
/** 导出/预览离线渲染采样率（默认，保持历史行为）。 */
export const RENDER_SAMPLE_RATE = 44100
/** fast 预览模式的默认低采样率（CONTRACT-R0 §R0B.1）。 */
export const FAST_RENDER_SAMPLE_RATE = 22050
/** 离线渲染支持的采样率范围。 */
export const MIN_RENDER_SAMPLE_RATE = 8000
export const MAX_RENDER_SAMPLE_RATE = 96000
/** 乐器预览（键盘演奏）固定音量系数，避免过响。 */
export const PREVIEW_GAIN = 0.9
/** 乐器预览 voice 默认时值（秒）；键盘松开时 stopPreview 会提前切断。 */
export const PREVIEW_DURATION_SECONDS = 2

// ---------------------------------------------------------------------------
/** 统一 tempo 取值：优先 tempo map 对象，其次常量 bps（数字，兼容纯测试）。 */
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

function tempoBeatToSeconds(tempo, beat) {
  const value = Number(beat)
  if (!Number.isFinite(value)) return 0
  if (tempo && typeof tempo.beatToSeconds === 'function') return tempo.beatToSeconds(value)
  const bps = Number(tempo)
  return Number.isFinite(bps) && bps > 0 ? value / bps : 0
}

function tempoSecondsToBeat(tempo, seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return 0
  if (tempo && typeof tempo.secondsToBeat === 'function') return tempo.secondsToBeat(value)
  const bps = Number(tempo)
  return Number.isFinite(bps) && bps > 0 ? value * bps : 0
}

/** 从 beat 起算 seconds 秒后的绝对 beat。 */
function tempoBeatAfterSeconds(tempo, beat, seconds) {
  return tempoSecondsToBeat(tempo, tempoBeatToSeconds(tempo, beat) + Number(seconds))
}

/** 工程 tempo map（tempoMap 优先；无则常量 project.bpm）。 */
function tempoForProject(project) {
  try {
    return createTempoMap(project ?? {})
  } catch {
    return createTempoMap({ bpm: Number(project?.bpm) || 120 })
  }
}

/** CONTRACT-R2a：片段增益包络 → AudioParam 线性排程（首点 setValueAtTime，其余 ramp）。 */
function scheduleClipGainEnvelope(param, when, points) {
  if (!param || typeof param.setValueAtTime !== 'function') return false
  const list = Array.isArray(points) && points.length ? points : [{ time: 0, gain: 1 }]
  try {
    if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(when)
  } catch {
    /* ignore */
  }
  try {
    let first = true
    for (const point of list) {
      const time = when + Math.max(0, Number(point?.time) || 0)
      const gain = Math.max(0, Number(point?.gain) || 0)
      if (first) {
        param.setValueAtTime(gain, time)
        first = false
      } else {
        param.linearRampToValueAtTime(gain, time)
      }
    }
    return true
  } catch {
    try {
      param.setValueAtTime(Math.max(0, Number(list[0]?.gain) || 0), when)
    } catch {
      /* ignore */
    }
    return false
  }
}

/** 片段增益包络点（异常时安全回退到单点）。 */
function audioSegmentEnvelope(segment, fallbackGain = 1) {
  try {
    return buildClipFadeEnvelope(segment)
  } catch {
    return [{ time: 0, gain: fallbackGain }]
  }
}

// 自动化（CONTRACT-P2 §4）— 实时 tick 与离线 renderWav 共用这里的纯函数
// ---------------------------------------------------------------------------

/** 实时自动化应用间隔（秒）：~40ms，避免和 UI 推子打架。 */
export const AUTOMATION_APPLY_INTERVAL = 0.04
/** 离线自动化采样间隔上限（秒，CONTRACT-P2 要求 ≤0.1s）。 */
export const AUTOMATION_SAMPLE_STEP = 0.1
/** cutoff 对数映射端点（与 shared model AUTOMATION_PARAMS.cutoff.map 一致）。 */
export const CUTOFF_MIN_HZ = 80
export const CUTOFF_MAX_HZ = 16000

/** value(0..1) → cutoff Hz（80×(16000/80)^value，对数）。 */
export function cutoffHzFromAutomation(value) {
  const v = clamp(Number(value) || 0, 0, 1)
  return CUTOFF_MIN_HZ * Math.pow(CUTOFF_MAX_HZ / CUTOFF_MIN_HZ, v)
}

/** 统一走 shared model 的参数映射（实时 / 离线 / UI 一致）。 */
export function mapAutomationValue(param, value) {
  const spec = AUTOMATION_PARAMS[param]
  if (spec && typeof spec.map === 'function') return spec.map(value)
  return value
}

/** 取「启用且有点」的曲线 points；否则 null（缺省/disabled/空数组 = 不生效）。 */
export function enabledAutomationPoints(curve) {
  if (!curve || typeof curve !== 'object') return null
  if (curve.enabled === false) return null
  const points = Array.isArray(curve.points) ? curve.points : null
  return points && points.length > 0 ? points : null
}

/**
 * 计算某个绝对 beat 上需要应用的自动化目标（纯函数）。
 * 顺序：按 project.tracks 顺序，每轨 volume → pan → cutoff；最后 master volume。
 * @returns {Array<{kind:string, trackId?:string, param:string, value:number, mapped?:number, pan?:number, hz?:number}>}
 */
export function computeAutomationTargets(project, beat) {
  const out = []
  const b = Number(beat)
  for (const track of project?.tracks ?? []) {
    const automation = track?.automation
    if (!automation) continue
    const volumePoints = enabledAutomationPoints(automation.volume)
    if (volumePoints) {
      const value = automationValueAt(volumePoints, b)
      if (value !== null) {
        // v2.1 P0-5：输出乘算后的 effective volume（automation 是 track.volume 上的相对乘数）
        const effective = effectiveAutomationVolume(track, value)
        out.push({
          kind: 'setTrackVolume',
          trackId: track.id,
          param: 'volume',
          value: effective,
          automationValue: value,
          mapped: mapAutomationValue('volume', effective),
        })
      }
    }
    const panPoints = enabledAutomationPoints(automation.pan)
    if (panPoints) {
      const value = automationValueAt(panPoints, b)
      if (value !== null) {
        out.push({
          kind: 'setTrackPan',
          trackId: track.id,
          param: 'pan',
          value,
          pan: mapAutomationValue('pan', value),
        })
      }
    }
    const cutoffCurve = effectiveCutoffCurve(track)
    if (cutoffCurve) {
      const value = automationValueAt(cutoffCurve.points, b)
      if (value !== null) {
        out.push({
          kind: 'setTrackCutoff',
          trackId: track.id,
          param: cutoffCurve.param,
          value,
          hz: mapAutomationValue('cutoff', value),
        })
      }
    }
  }
  const masterPoints = enabledAutomationPoints(project?.master?.automation?.volume)
  if (masterPoints) {
    const value = automationValueAt(masterPoints, b)
    if (value !== null) {
      out.push({
        kind: 'setMasterVolume',
        param: 'volume',
        target: 'master',
        value,
        mapped: mapAutomationValue('volume', value),
      })
    }
  }
  return out
}

/**
 * v2.3 P0/P2：插件参数自动化曲线 → 实时 external node 参数目标。
 * 模型：track.pluginAutomation = {
 *   track: { [paramId]: {enabled, points:[{beat,value}] } },          // VST3 乐器轨
 *   'effect:<effectId>': { [paramId]: {enabled, points} }             // 轨道 VST3 effect
 * }
 * 每个 tick 按当前 beat 计算曲线值（0..1），交给 graph.setExternalPluginParam（bridge 内 50ms 节流）。
 */
export function computePluginAutomationTargets(project, beat) {
  const out = []
  const b = Number(beat)
  if (!Number.isFinite(b)) return out
  for (const track of project?.tracks ?? []) {
    const automation = track?.pluginAutomation
    if (!automation || typeof automation !== 'object' || Array.isArray(automation)) continue
    for (const [instanceKey, params] of Object.entries(automation)) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) continue
      let instanceId = ''
      let effectId = null
      if (instanceKey === 'track' && isExternalInstrumentTrack(track)) {
        instanceId = externalInstanceIdForTrack(track)
      } else if (instanceKey.startsWith('effect:')) {
        effectId = instanceKey.slice('effect:'.length)
        const effect = (track.effects ?? []).find((item) => item?.id === effectId && item?.type === 'vst3')
        if (!effect) continue
        instanceId = externalInstanceIdForEffect(effect)
      } else {
        continue
      }
      if (!instanceId) continue
      for (const [paramId, curve] of Object.entries(params)) {
        if (!curve || typeof curve !== 'object') continue
        if (curve.enabled === false) continue
        const points = Array.isArray(curve) ? curve : curve.points
        const value = automationValueAt(points, b)
        if (value === null) continue
        out.push({
          kind: 'setExternalPluginParam',
          trackId: track.id,
          effectId,
          instanceId,
          paramId,
          value,
        })
      }
    }
  }
  return out
}

const AUTOMATION_TARGET_METHODS = {
  setTrackVolume: 'setTrackVolume',
  setTrackPan: 'setTrackPan',
  setTrackCutoff: 'setTrackCutoff',
  setMasterVolume: 'setMasterVolume',
  setExternalPluginParam: 'setExternalPluginParam',
}

/**
 * 把 computeAutomationTargets 的结果应用到 graph（实时 tick / mock 测试共用）。
 * graph 缺方法或抛错时安全跳过，返回成功应用的数量。
 */
export function applyAutomationTargets(graph, targets) {
  if (!graph || !Array.isArray(targets) || targets.length === 0) return 0
  let applied = 0
  for (const target of targets) {
    const method = AUTOMATION_TARGET_METHODS[target?.kind]
    if (!method || typeof graph[method] !== 'function') continue
    try {
      if (target.kind === 'setTrackVolume') graph.setTrackVolume(target.trackId, target.value)
      else if (target.kind === 'setTrackPan') graph.setTrackPan(target.trackId, target.pan)
      else if (target.kind === 'setTrackCutoff') graph.setTrackCutoff(target.trackId, target.hz)
      else if (target.kind === 'setMasterVolume') graph.setMasterVolume(target.value)
      else if (target.kind === 'setExternalPluginParam') graph.setExternalPluginParam(target.instanceId, target.paramId, target.value)
      else continue
      applied += 1
    } catch {
      /* 单参数应用失败不影响其它参数 */
    }
  }
  return applied
}

/**
 * 把一条自动化曲线按「≤maxStepSeconds 采样 + 关键点」展开成离线渲染用的采样点。
 * time 单位：秒（相对渲染区间起点）。
 *
 * `tempo` 可传 createTempoMap 对象（支持 tempo automation）或常量 bps 数字。
 * @returns {Array<{beat:number,time:number,value:number}>}
 */
export function buildAutomationSamples(points, startBeat, endBeat, tempo, maxStepSeconds = AUTOMATION_SAMPLE_STEP) {
  const start = Number(startBeat)
  const end = Number(endBeat)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
  const totalSeconds = tempoSecondsBetween(tempo, start, end)
  if (!(totalSeconds > 0)) return []
  const stepSeconds = Number(maxStepSeconds) > 0 ? Number(maxStepSeconds) : AUTOMATION_SAMPLE_STEP
  const times = new Set([0, totalSeconds])
  const steps = Math.max(1, Math.ceil(totalSeconds / stepSeconds))
  for (let i = 1; i < steps; i++) times.add((totalSeconds * i) / steps)
  // 曲线关键点的 beat → 相对秒（保证 ramp 在断点上精确落点）
  for (const point of points ?? []) {
    const beat = Number(point?.beat)
    if (!Number.isFinite(beat) || beat <= start || beat >= end) continue
    times.add(tempoSecondsBetween(tempo, start, beat))
  }
  const startSeconds = tempoBeatToSeconds(tempo, start)
  const sortedTimes = [...times].filter((time) => Number.isFinite(time) && time >= -1e-9).sort((a, b) => a - b)
  const samples = []
  for (const time of sortedTimes) {
    const beat = tempoSecondsToBeat(tempo, startSeconds + time)
    const value = automationValueAt(points, beat)
    if (value === null) continue
    samples.push({ beat, time: Math.max(0, time), value })
  }
  return samples
}

/**
 * 离线渲染的自动化排程计划（纯函数）：
 * - volume / pan / master 返回采样点，可直接排进 AudioParam（ramp）；
 * - cutoff 需要 filter 节点引用（fx 封装内部），只返回采样点与 points，由 renderWav
 *   在 suspend 回调里按 ≤0.1s 应用到 graph.setTrackCutoff。
 * 渲染区间按 beat 表示，采样时间用 tempo map 换算（支持 tempo automation）。
 */
export function buildOfflineAutomationSchedule(project, plan, options = {}) {
  const barBeats = Number(plan?.barBeats) || beatsPerBar(project)
  const tempo = plan?.tempo ?? tempoForProject(project)
  const fromBar = Number(plan?.fromBar) || 0
  const toBar = Number.isFinite(Number(plan?.toBar)) ? Number(plan.toBar) : null
  const startBeat = Number.isFinite(Number(plan?.startBeat)) ? Number(plan.startBeat) : fromBar * barBeats
  const endBeat =
    Number.isFinite(Number(plan?.endBeat)) && Number(plan.endBeat) > startBeat
      ? Number(plan.endBeat)
      : toBar !== null
        ? toBar * barBeats
        : tempoBeatAfterSeconds(tempo, startBeat, Number(plan?.seconds) || 0)
  const maxStepSeconds =
    Number(options.maxStepSeconds) > 0 ? Number(options.maxStepSeconds) : AUTOMATION_SAMPLE_STEP
  const tracks = []
  let hasCutoffDynamic = false
  for (const track of project?.tracks ?? []) {
    const automation = track?.automation
    if (!automation) continue
    const volumePoints = enabledAutomationPoints(automation.volume)
    const panPoints = enabledAutomationPoints(automation.pan)
    const cutoffCurve = effectiveCutoffCurve(track)
    if (!volumePoints && !panPoints && !cutoffCurve) continue
    const entry = { trackId: track.id }
    if (volumePoints) {
      // v2.1 P0-5：离线排程同样保存乘算后的 effective volume（track.volume × automationValue）
      entry.volume = buildAutomationSamples(volumePoints, startBeat, endBeat, tempo, maxStepSeconds).map((sample) => ({
        ...sample,
        effective: effectiveAutomationVolume(track, sample.value),
      }))
    }
    if (panPoints) {
      entry.pan = buildAutomationSamples(panPoints, startBeat, endBeat, tempo, maxStepSeconds).map((sample) => ({
        ...sample,
        mapped: mapAutomationValue('pan', sample.value),
      }))
    }
    if (cutoffCurve) {
      const samples = buildAutomationSamples(cutoffCurve.points, startBeat, endBeat, tempo, maxStepSeconds).map((sample) => ({
        ...sample,
        mapped: mapAutomationValue('cutoff', sample.value),
      }))
      const firstValue = samples.length ? samples[0].value : 0
      if (samples.some((sample) => Math.abs(sample.value - firstValue) > 1e-6)) hasCutoffDynamic = true
      entry.cutoff = { param: cutoffCurve.param, points: cutoffCurve.points, samples }
    }
    tracks.push(entry)
  }
  let master = null
  const masterPoints = enabledAutomationPoints(project?.master?.automation?.volume)
  if (masterPoints) {
    master = buildAutomationSamples(masterPoints, startBeat, endBeat, tempo, maxStepSeconds).map((sample) => ({
      ...sample,
      mapped: mapAutomationValue('volume', sample.value),
    }))
  }
  return { startBeat, endBeat, tempo, bps: bpmToBps(Number(project?.bpm) || 120), tracks, master, hasCutoffDynamic }
}

// ---------------------------------------------------------------------------
// 侧链 ducking（CONTRACT-P2B §4）— 纯函数 + 调度助手，实时/离线共用
// ---------------------------------------------------------------------------

/** 侧链默认值（模型缺省；与 host normalizeSidechain 保持一致）。 */
export const SIDECHAIN_DEFAULTS = Object.freeze({
  enabled: false,
  sourceTrackId: null,
  amount: 0.5,
  attack: 0.005,
  release: 0.12,
})

/** 侧链参数范围（秒 / 0..1）。 */
export const SIDECHAIN_LIMITS = Object.freeze({
  amount: [0, 1],
  attack: [0.001, 0.2],
  release: [0.02, 1],
})

/** 侧链 triggerNotes 上限（与 host normalizeSidechain 一致）。 */
export const MAX_TRIGGER_NOTES = 16

/**
 * 规范化侧链触发音高列表（CONTRACT-R0-12）：
 * - 只保留 0..127 的整数 MIDI pitch，去重升序，最多 MAX_TRIGGER_NOTES 个；
 * - 非数组/空数组 → []（= 任意音高都触发，兼容旧行为）。
 * @param {unknown} raw
 * @returns {number[]}
 */
export function normalizeTriggerNotes(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return []
  const notes = new Set()
  for (const value of raw) {
    const pitch = Math.round(Number(value))
    if (!Number.isFinite(pitch) || pitch < 0 || pitch > 127) continue
    notes.add(pitch)
    if (notes.size >= 128) break
  }
  return [...notes].sort((a, b) => a - b).slice(0, MAX_TRIGGER_NOTES)
}

/**
 * 规范化一条轨道侧链（引擎侧防御；host 已 normalize 时等价）。
 * enabled=false / 缺少来源 / 非法结构 → null。
 * @returns {{enabled:true, sourceTrackId:string, amount:number, attack:number, release:number,
 *   triggerNotes:number[]}|null}
 */
export function normalizeSidechain(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.enabled === false) return null
  const sourceTrackId =
    typeof raw.sourceTrackId === 'string' || typeof raw.sourceTrackId === 'number'
      ? String(raw.sourceTrackId)
      : null
  if (!sourceTrackId) return null
  const amount = Number.isFinite(Number(raw.amount))
    ? clamp(Number(raw.amount), SIDECHAIN_LIMITS.amount[0], SIDECHAIN_LIMITS.amount[1])
    : SIDECHAIN_DEFAULTS.amount
  const attack = Number.isFinite(Number(raw.attack))
    ? clamp(Number(raw.attack), SIDECHAIN_LIMITS.attack[0], SIDECHAIN_LIMITS.attack[1])
    : SIDECHAIN_DEFAULTS.attack
  const release = Number.isFinite(Number(raw.release))
    ? clamp(Number(raw.release), SIDECHAIN_LIMITS.release[0], SIDECHAIN_LIMITS.release[1])
    : SIDECHAIN_DEFAULTS.release
  return {
    enabled: true,
    sourceTrackId,
    amount,
    attack,
    release,
    triggerNotes: normalizeTriggerNotes(raw.triggerNotes),
  }
}

/**
 * 构建「源轨道 → 目标轨道数组」的侧链索引（纯函数）。
 * 只保留 enabled、来源存在且非自身的侧链。
 * @returns {Map<string, Array<{trackId:string, sourceTrackId:string, amount:number, attack:number, release:number}>>}
 */
export function buildSidechainIndex(project) {
  const index = new Map()
  const tracks = project?.tracks ?? []
  const trackIds = new Set()
  for (const track of tracks) {
    if (track?.id) trackIds.add(track.id)
  }
  for (const track of tracks) {
    if (!track?.id) continue
    const sidechain = normalizeSidechain(track.sidechain)
    if (!sidechain) continue
    if (sidechain.sourceTrackId === track.id) continue
    if (!trackIds.has(sidechain.sourceTrackId)) continue
    const target = {
      trackId: track.id,
      sourceTrackId: sidechain.sourceTrackId,
      amount: sidechain.amount,
      attack: sidechain.attack,
      release: sidechain.release,
      triggerNotes: sidechain.triggerNotes,
    }
    const list = index.get(sidechain.sourceTrackId)
    if (list) list.push(target)
    else index.set(sidechain.sourceTrackId, [target])
  }
  return index
}

/** 某源轨道会触发哪些目标轨道的 ducking（纯函数，单测入口）。 */
export function sidechainTargets(project, sourceTrackId) {
  if (sourceTrackId === null || sourceTrackId === undefined) return []
  const targets = buildSidechainIndex(project).get(String(sourceTrackId))
  return targets ? targets.map((target) => ({ ...target })) : []
}

/**
 * 把一组 duck 目标应用到 graph.scheduleDuck（实时/离线共用）。
 * CONTRACT-R0-12：target.triggerNotes 非空时，只有事件 pitch 命中才 duck；
 * pitch 未传/非法时视为不命中（有 triggerNotes 的目标跳过）。
 * 无目标 / graph 不支持时安全 no-op，返回成功调度数。
 *
 * @param {object} graph
 * @param {Array<{trackId:string, triggerNotes?:number[], amount:number, attack:number, release:number}>} targets
 * @param {number} atTime
 * @param {number} [pitch] 触发事件 MIDI pitch
 */
export function scheduleDuckTargets(graph, targets, atTime, pitch) {
  if (!graph || typeof graph.scheduleDuck !== 'function' || !Array.isArray(targets) || targets.length === 0) {
    return 0
  }
  const eventPitch = Number.isFinite(Number(pitch)) ? Math.round(Number(pitch)) : null
  let scheduled = 0
  for (const target of targets) {
    const triggerNotes = Array.isArray(target?.triggerNotes) ? target.triggerNotes : []
    if (triggerNotes.length > 0 && (eventPitch === null || !triggerNotes.includes(eventPitch))) continue
    try {
      graph.scheduleDuck(target.trackId, atTime, target.amount, target.attack, target.release)
      scheduled += 1
    } catch {
      /* 单轨 duck 失败不影响其它轨 */
    }
  }
  return scheduled
}

function getAudioContextCtor() {
  if (typeof globalThis === 'undefined') return null
  return (
    globalThis.AudioContext ||
    globalThis.webkitAudioContext ||
    (typeof globalThis.window !== 'undefined'
      ? globalThis.window.AudioContext || globalThis.window.webkitAudioContext
      : null) ||
    null
  )
}

function getOfflineAudioContextCtor() {
  if (typeof globalThis === 'undefined') return null
  return (
    globalThis.OfflineAudioContext ||
    globalThis.webkitOfflineAudioContext ||
    (typeof globalThis.window !== 'undefined'
      ? globalThis.window.OfflineAudioContext || globalThis.window.webkitOfflineAudioContext
      : null) ||
    null
  )
}

/**
 * R2b 导出可复现性：创建「解码用」AudioContext，采样率尽量等于目标渲染采样率，
 * 避免媒体在实时 48k 上下文解码后再被离线 44.1k 重采样（Chrome 重采样会有
 * 亚采样级非确定性，导致重复导出不能逐位一致）。失败时返回 null。
 */
function createDecodeContext(sampleRate) {
  const target = Number(sampleRate) > 0 ? Math.round(Number(sampleRate)) : RENDER_SAMPLE_RATE
  const Ctor = getAudioContextCtor()
  if (!Ctor) return null
  try {
    return new Ctor({ sampleRate: target })
  } catch {
    /* 部分实现不支持 sampleRate 选项，退回默认上下文 */
  }
  try {
    return new Ctor()
  } catch {
    return null
  }
}

/**
 * 计算一次离线渲染的区间 / 采样数（纯函数，Node 可单测）。
 *
 * 时长规则（CONTRACT 第 6 节）：
 * - 默认渲染整首 project.lengthBars；
 * - opts.fromBar / toBar 指定区间；
 * - 导出时长上限 MAX_RENDER_SECONDS（8 分钟）。
 */
export function computeRenderPlan(project, opts = {}) {
  const barBeats = beatsPerBar(project)
  const tempo = tempoForProject(project)
  const bpm = clamp(Number(project?.bpm) || 128, 40, 200)
  const bps = bpmToBps(bpm)
  const totalBars = Math.max(1, Math.round(Number(project?.lengthBars) || 1))
  const rawFrom = Number(opts?.fromBar)
  const rawTo = Number(opts?.toBar)
  const fromBar = clamp(Number.isFinite(rawFrom) ? rawFrom : 0, 0, totalBars - 1)
  const toBar = clamp(Number.isFinite(rawTo) ? rawTo : totalBars, fromBar + 0.05, totalBars)
  const startBeat = fromBar * barBeats
  const endBeat = toBar * barBeats
  // CONTRACT-R0 §R0B.1：预览可指定低采样率（fast）以加速渲染
  const fast = opts?.fast === true
  const rawSampleRate =
    Number(opts?.sampleRate) > 0
      ? Number(opts.sampleRate)
      : fast
        ? FAST_RENDER_SAMPLE_RATE
        : RENDER_SAMPLE_RATE
  const sampleRate = Number.isFinite(rawSampleRate)
    ? Math.round(clamp(rawSampleRate, MIN_RENDER_SAMPLE_RATE, MAX_RENDER_SAMPLE_RATE))
    : RENDER_SAMPLE_RATE
  // CONTRACT-P12：时长按 tempoMap 积分（常量 BPM 时与旧 (bars*barBeats)/bps 完全一致）
  const requestedSeconds = Math.max(0, tempo.beatToSeconds(endBeat) - tempo.beatToSeconds(startBeat))
  const fullSeconds = Math.max(0.1, tempo.beatToSeconds(totalBars * barBeats))
  let seconds = requestedSeconds > 0 ? requestedSeconds : fullSeconds
  const capped = seconds > MAX_RENDER_SECONDS
  seconds = clamp(seconds, 0.1, MAX_RENDER_SECONDS)
  const frames = Math.max(1, Math.round(sampleRate * seconds))
  const renderSeconds = frames / sampleRate
  return {
    barBeats,
    bpm,
    bps,
    tempo,
    totalBars,
    fromBar,
    toBar,
    startBeat,
    endBeat,
    seconds: renderSeconds,
    frames,
    sampleRate,
    fast,
    mode: fast ? 'fast' : 'normal',
    capped,
    requestedSeconds,
  }
}

/**
 * 考虑延音踏板（CONTRACT-P11）的音符时长（beat）。
 * 仅非鼓轨且 track.sustain 有有效点时生效；否则原样返回。
 * 8 秒上限用 tempo map 换算成 beats（tempo automation 下仍是真实 8 秒）。
 */
function sustainExtendedDurBeats(track, startBeat, durBeats, tempo) {
  const dur = Math.max(0.03, Number(durBeats) || 0.25)
  if (!track || track.kind === 'drum') return dur
  const points = Array.isArray(track.sustain) ? track.sustain : null
  if (!points || points.length === 0) return dur
  const start = Number.isFinite(Number(startBeat)) ? Number(startBeat) : 0
  const endBeat = start + dur
  const capBeat = tempoBeatAfterSeconds(tempo, endBeat, SUSTAIN_MAX_HOLD_SECONDS)
  const maxHoldBeats = Math.max(0, capBeat - endBeat)
  const end = effectiveNoteEndBeat(points, start, endBeat, maxHoldBeats)
  if (!Number.isFinite(end) || end <= endBeat) return dur
  return end - start
}

/**
 * CONTRACT-R0 §R0B.1：只渲染指定轨道的 project 视图（不改原工程对象）。
 * soloTrackIds/trackIds 为空或未传 → 原样返回。
 */
function projectForSoloTrackIds(project, trackIds) {
  if (!trackIds) return project
  const list = Array.isArray(trackIds) ? trackIds : [trackIds]
  const ids = new Set(list.map((id) => String(id)).filter((id) => id && id !== 'null' && id !== 'undefined'))
  if (!ids.size) return project
  return {
    ...project,
    tracks: (project?.tracks ?? []).filter((track) => ids.has(String(track?.id))),
    clips: (project?.clips ?? []).filter((clip) => ids.has(String(clip?.trackId))),
  }
}

/** 读取轨道揉弦设置；未启用/非法返回 null（不建任何节点）。 */
function trackVibrato(track) {
  const vibrato = track?.vibrato
  if (!vibrato || typeof vibrato !== 'object' || vibrato.enabled === false) return null
  const rateHz = Number(vibrato.rateHz)
  const depthCents = Number(vibrato.depthCents)
  if (!Number.isFinite(rateHz) || rateHz <= 0) return null
  if (!Number.isFinite(depthCents) || depthCents <= 0) return null
  return { rateHz, depthCents }
}

/** 读取轨道某自动化参数在 beat 处的值（0..1，线性插值）；无/disabled/空 → null。 */
function automationValueForTrack(track, param, beat) {
  const curve = track?.automation?.[param]
  if (!curve || typeof curve !== 'object' || curve.enabled === false) return null
  const points = Array.isArray(curve.points) ? curve.points : null
  if (!points || points.length === 0) return null
  const value = automationValueAt(points, beat)
  if (value === null || !Number.isFinite(value)) return null
  return clamp01(value)
}

/**
 * R5d：subtractive 轨实际生效参数：catalog preset.synthPreset ← track.synthParams
 * ← track.instrumentParams 共用字段（attack/release/filter/lfo）覆盖。
 * 非 subtractive / 未知 preset 回落到第一个内置音色（不抛异常）。
 */
export function resolveSubtractiveTrackParams(track) {
  const instrument = findSynthInstrument(track?.synthPreset) ?? SYNTH_INSTRUMENTS[0]
  return resolveSubtractiveParams(instrument?.synthPreset, {
    ...(track?.synthParams ?? {}),
    ...instrumentParamsToSynthOverrides(track?.instrumentParams),
  })
}

/**
 * R3b：决定驱动 filter cutoff 的曲线。
 * - `cutoff` 曲线优先；
 * - 无 cutoff 时用 `cc74`（Brightness）曲线，映射同一对数 80..16000Hz；
 * - 都没有 → null（保持现有 filter 参数）。
 * @param {{automation?:object}} track
 * @returns {{param:'cutoff'|'cc74', points:Array<{beat:number,value:number}>}|null}
 */
export function effectiveCutoffCurve(track) {
  const automation = track?.automation
  if (!automation) return null
  const cutoffPoints = enabledAutomationPoints(automation.cutoff)
  if (cutoffPoints) return { param: 'cutoff', points: cutoffPoints }
  const cc74Points = enabledAutomationPoints(automation.cc74)
  if (cc74Points) return { param: 'cc74', points: cc74Points }
  return null
}

/**
 * CONTRACT-P13 / R3b 表情自动化（在音符起始按 beat 采样，不做音符内连续弯音）：
 * - pitchBend: 0..1 → −2..+2 半音 = ±200 cents；
 * - expressionGain：`expression`（无则 1）× `cc11`（无则 1），0..1；
 * - modulationCents：`modulation`×100 + `cc1`×100，总夹到 100 cents，叠加到 track.vibrato 深度；
 * - cc64 不参与音频（仅数据/导出，沿用 track.sustain 听感）；
 * - 鼓轨不应用（expressionGain=1，pitchBend=0）。
 * @param {{kind?:string, automation?:object, vibrato?:object}} track
 * @param {number} beat
 * @returns {{pitchBendCents:number, expressionGain:number, modulationCents:number, vibrato:object|null}}
 */
export function noteExpression(track, beat) {
  const baseVibrato = trackVibrato(track)
  if (!track || track.kind === 'drum' || !track.automation) {
    return { pitchBendCents: 0, expressionGain: 1, modulationCents: 0, vibrato: baseVibrato }
  }
  const bendValue = automationValueForTrack(track, 'pitchBend', beat)
  const expressionValue = automationValueForTrack(track, 'expression', beat)
  const cc11Value = automationValueForTrack(track, 'cc11', beat)
  const modulationValue = automationValueForTrack(track, 'modulation', beat)
  const cc1Value = automationValueForTrack(track, 'cc1', beat)
  const pitchBendCents = bendValue === null ? 0 : clamp((bendValue * 4 - 2) * 100, -200, 200)
  // expression 曲线与 cc11 相乘（均缺省为 1）
  const expressionGain = clamp01(expressionValue === null ? 1 : expressionValue) * clamp01(cc11Value === null ? 1 : cc11Value)
  // modulation 曲线与 cc1 叠加，总不超过 100 cents
  const modulationCents = clamp(
    (modulationValue === null ? 0 : modulationValue) * 100 + (cc1Value === null ? 0 : cc1Value) * 100,
    0,
    100,
  )
  let vibrato = baseVibrato
  if (modulationCents > 0.01) {
    vibrato = baseVibrato
      ? {
          rateHz: baseVibrato.rateHz,
          depthCents: Math.min(100, baseVibrato.depthCents + modulationCents),
        }
      : { rateHz: 5, depthCents: Math.min(100, modulationCents) }
  }
  return { pitchBendCents, expressionGain, modulationCents, vibrato }
}

export class StudioEngine {
  /**
   * @param {{onPosition?:(bar:number)=>void, onState?:(state:{playing:boolean,unlocked:boolean})=>void}} [callbacks]
   */
  constructor(callbacks = {}) {
    const cb = callbacks && typeof callbacks === 'object' ? callbacks : {}
    this._onPosition = typeof cb.onPosition === 'function' ? cb.onPosition : null
    this._onState = typeof cb.onState === 'function' ? cb.onState : null

    this._ctx = null
    this._graph = null
    this._project = null
    this._signature = ''
    this._disposed = false
    /** v2.2 M2：AudioWorklet 外部效果器模块是否已就绪；无 preload/浏览器下为 false。 */
    this._workletReady = false
    /** v2.2 M2：最近一次建图的外部效果器降级/旁路 warning。 */
    this._externalWarnings = []

    this._playing = false
    this._pendingPlay = null
    this._positionBar = 0

    this._timer = null
    this._lastPositionNotify = 0

    this._plan = null
    this._evList = []
    this._iter = 0
    this._index = 0
    this._anchorTime = 0
    this._anchorBeat = 0
    this._u0 = 0
    this._bps = 2

    this._voices = []
    this._synthVoiceSteals = 0
    this._lastPitch = new Map()
    this._synthParams = new Map()
    this._drumParams = new Map()
    this._trackMap = new Map()
    /** 上次应用自动化参数的 ctx 时间（~40ms 节流）。 */
    this._lastAutomationAt = -Infinity
    /** 侧链索引：源轨道 id → 目标轨道 duck 参数数组（setProject 时构建）。 */
    this._sidechainIndex = new Map()
    /** 采样银行（CC0 采样，首次 unlock 后后台预加载）。 */
    this._sampleBank = new SampleBank()
    this._samplesLoading = false
    /** 音频媒体银行（audio 轨导入的 WAV/MP3，unlock 后按工程预加载）。 */
    this._mediaBank = new MediaBank()
    this._mediaLoading = false
    /** 实时音频片段调度状态（与音符共用 lookahead 时间轴）。 */
    this._audioSegments = []
    this._audioIndex = 0
    this._audioIter = 0
    this._mediaVoices = []
    /** v2.2 M4：冻结轨缓存 AudioBufferSource 活动 voice。 */
    this._frozenVoices = []
    /** SF2 真实采样音色库（GeneralUser GS；unlock 后后台加载，失败安全）。 */
    this._soundfontBank = new SoundfontBank()
    this._soundfontLoading = false
    /** 乐器预览（键盘演奏）活动 voice：previewId → { handle, endTime, ... }。 */
    this._previews = new Map()
    this._previewSeq = 0

    this._onStateChangeBound = () => this._handleStateChange()
  }

  // -------------------------------------------------------------------------
  // 公共 API
  // -------------------------------------------------------------------------

  /** AudioContext 是否已创建且处于 running。 */
  get unlocked() {
    return Boolean(this._ctx && this._ctx.state === 'running')
  }

  /** 用户手势里调用：创建 / 恢复 AudioContext；有 pendingPlay 时自动开始。 */
  async unlock() {
    if (this._disposed) return
    const Ctor = getAudioContextCtor()
    if (!Ctor) return
    try {
      if (!this._ctx) {
        this._ctx = new Ctor({ latencyHint: 'interactive' })
        try {
          this._ctx.addEventListener('statechange', this._onStateChangeBound)
        } catch {
          this._ctx.onstatechange = this._onStateChangeBound
        }
        // v2.2 M2：外部 VST3 AudioWorklet 必须在建图（含 vst3 效果器）之前 await 注册完成；
        // 失败不阻断 unlock，建图时按降级直通 + warning 处理。
        try {
          this._workletReady = await ensureExternalPluginWorklet(this._ctx)
        } catch {
          this._workletReady = false
        }
        this._buildGraph()
      } else if (!this._workletReady) {
        // 首次 unlock 时 audioWorklet 可能尚不可用；再次 unlock 时重试，就绪后重建图。
        try {
          this._workletReady = await ensureExternalPluginWorklet(this._ctx)
        } catch {
          this._workletReady = false
        }
        if (this._workletReady && this._graph) this._rebuildGraph()
      }
      if (this._ctx.state !== 'running') {
        const resumed = this._ctx.resume()
        if (resumed && typeof resumed.then === 'function') await resumed
      }
      this._sampleBank.setContext(this._ctx)
      // R2b：媒体用「与导出渲染采样率一致」的上下文解码，避免播放时重采样引入非确定性
      if (!this._mediaDecodeCtx) {
        const decodeCtx = createDecodeContext(RENDER_SAMPLE_RATE)
        if (decodeCtx && decodeCtx !== this._ctx) this._mediaDecodeCtx = decodeCtx
      }
      const mediaContext = this._mediaDecodeCtx || this._ctx
      this._mediaSampleRate = Math.round(Number(mediaContext?.sampleRate) || RENDER_SAMPLE_RATE)
      this._mediaBank.setContext(mediaContext)
      this._handleStateChange()
      void this._preloadSamples()
      void this._preloadMedia()
      void this._preloadSoundfont()
    } catch {
      /* 自动播放限制 / 音频设备不可用：不崩溃，保持可重试 */
    }
  }

  /** 后台预加载全部 CC0 采样（约 40 个文件）；完成后如正在播放则重排。 */
  async _preloadSamples() {
    if (this._disposed || this._samplesLoading || !this._ctx) return
    this._samplesLoading = true
    try {
      await this._sampleBank.preload(allSampleFiles())
    } finally {
      this._samplesLoading = false
      if (!this._disposed && this._playing && this._ctx && this._graph) {
        try {
          this._reschedule()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 后台预加载工程里的音频媒体；完成后如正在播放则重排（让音频片段开始发声）。 */
  async _preloadMedia() {
    if (this._disposed || this._mediaLoading || !this._ctx) return
    this._mediaLoading = true
    try {
      const sampleRate = this._mediaSampleRate || Math.round(Number(this._mediaBank.context?.sampleRate) || RENDER_SAMPLE_RATE)
      await this._mediaBank.preloadForProject(this._project, sampleRate)
      // R2b：预先算好 stretch/pitch 变体，避免首次调度时在音频线程同步处理造成卡顿
      await this._mediaBank.ensureProcessedForProject(this._project, sampleRate)
    } finally {
      this._mediaLoading = false
      if (!this._disposed && this._playing && this._ctx && this._graph) {
        try {
          this._reschedule()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 离线渲染前确保采样已解码（没有实时上下文时临时建一个用于解码）。 */
  async _ensureSamplesForRender(project) {
    try {
      if (!this._sampleBank.context) {
        const Ctor = getAudioContextCtor()
        if (!Ctor) return
        this._sampleBank.setContext(new Ctor())
      }
      await this._sampleBank.preloadForProject(project)
    } catch {
      /* 采样加载失败时渲染其余部分 */
    }
  }

  /** 离线渲染前确保音频媒体已解码（解码采样率对齐本次渲染，保证重复导出可复现）。 */
  async _ensureMediaForRender(project, sampleRate) {
    try {
      const target = Number(sampleRate) > 0 ? Math.round(Number(sampleRate)) : RENDER_SAMPLE_RATE
      const current = this._mediaBank.context
      const currentRate = Math.round(Number(current?.sampleRate) || 0)
      if (!current || currentRate !== target) {
        const decodeCtx = createDecodeContext(target)
        if (decodeCtx) this._mediaBank.setContext(decodeCtx)
      }
      await this._mediaBank.preloadForProject(project, target)
      // R2b：离线前预计算 stretch/pitch 变体（与实时共用同一套缓存/纯函数）
      await this._mediaBank.ensureProcessedForProject(project, target)
    } catch {
      /* 媒体加载失败时渲染其余部分（未加载片段跳过） */
    }
  }

  /**
   * 后台加载 SF2 真实采样音色库（GeneralUser GS，~32MB；失败安全）。
   * 完成后如正在播放则重排，让采样音色立即发声。
   */
  async _preloadSoundfont() {
    if (this._disposed || this._soundfontLoading || this._soundfontBank.isLoaded) return
    this._soundfontLoading = true
    try {
      await this._soundfontBank.load()
    } catch {
      /* 音色库加载失败：轨道静音，不崩溃 */
    } finally {
      this._soundfontLoading = false
      if (!this._disposed && this._playing && this._ctx && this._graph) {
        try {
          this._reschedule()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 离线渲染前确保 SF2 已加载（失败安全；未加载时采样乐器轨道静音）。 */
  async _ensureSoundfontForRender(project) {
    if (!project) return
    try {
      if (!this._soundfontBank.isLoaded) await this._soundfontBank.load()
    } catch {
      /* 音色库加载失败：渲染其余部分 */
    }
  }

  /** SF2 音色库是否已加载（UI 可显示“正在加载音色库…”状态）。 */
  get soundfontLoaded() {
    return this._soundfontBank.isLoaded
  }

  /** SF2 音色库是否正在加载。 */
  get soundfontLoading() {
    return this._soundfontLoading
  }

  /** 已加载的 SF2 预设数（0 表示未加载）。 */
  get soundfontPresetCount() {
    return this._soundfontBank.presetCount
  }

  /** 更新项目。播放中重建调度，并保持播放位置连续。 */
  setProject(project) {
    if (this._disposed || !project || typeof project !== 'object') return
    this._project = project
    this._refreshCaches()
    if (this._ctx) {
      if (!this._graph) {
        this._buildGraph()
      } else if (graphSignature(project) !== this._signature) {
        this._rebuildGraph()
      } else {
        try {
          this._graph.update(project)
        } catch {
          /* ignore */
        }
      }
      void this._preloadMedia()
      void this._preloadSoundfont()
    }
    if (this._playing && this._ctx && this._graph) this._reschedule()
  }

  /** 播放。未解锁时排队；fromBar 省略则从当前位置开始。 */
  play(fromBar) {
    if (this._disposed || !this._project) return
    const lengthBars = Math.max(1, Math.round(Number(this._project.lengthBars) || 1))
    const bar =
      fromBar === undefined || fromBar === null
        ? clamp(this._positionBar, 0, lengthBars)
        : clamp(Number(fromBar) || 0, 0, lengthBars)
    if (!this._ctx) {
      this._pendingPlay = { fromBar: bar }
      this._positionBar = bar
      this._emitState()
      return
    }
    if (this._ctx.state !== 'running') {
      this._pendingPlay = { fromBar: bar }
      try {
        const resumed = this._ctx.resume()
        if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {})
      } catch {
        /* ignore */
      }
      return
    }
    this._startPlayback(bar)
  }

  /** 停止播放（保留当前位置，回零请用 seek(0)）。 */
  stop() {
    if (this._disposed) return
    if (this._playing) this._positionBar = this.positionBar
    this._clearTimer()
    this._playing = false
    this._pendingPlay = null
    this._playbackReset()
    this._stopAllVoices(0.06)
    this._stopAllMediaVoices(0.06)
    this._stopAllFrozenVoices(0.06)
    this.stopAllPreviews()
    this._restoreStaticParams()
    this._emitState()
    this._emitPosition(true)
  }

  /** 跳到指定小节（播放中则从该小节继续播放）。 */
  seek(bar) {
    if (this._disposed || !this._project) return
    const lengthBars = Math.max(1, Math.round(Number(this._project.lengthBars) || 1))
    const target = clamp(Number(bar) || 0, 0, lengthBars)
    if (this._playing && this._ctx && this._graph) {
      this._stopAllVoices(0.02)
      this._startPlayback(target)
    } else {
      this._positionBar = target
      this._emitPosition(true)
    }
  }

  /** 当前播放位置（单位：bar，浮点）。 */
  get positionBar() {
    if (this._playing && this._ctx && this._plan) {
      const beats = this._positionBeatAt(Number(this._ctx.currentTime) || 0)
      return clamp(beats / this._plan.barBeats, 0, this._plan.lengthBars)
    }
    return this._positionBar
  }

  get isPlaying() {
    return this._playing
  }

  /** 实时电平：{ master: 0..1, tracks: { [trackId]: 0..1 } }。 */
  getLevels() {
    const tracks = {}
    for (const id of this._trackMap.keys()) tracks[id] = 0
    if (!this._graph) return { master: 0, tracks }
    let levels = null
    try {
      levels = this._graph.getLevels()
    } catch {
      levels = null
    }
    if (!levels) return { master: 0, tracks }
    for (const [id, value] of Object.entries(levels.tracks ?? {})) tracks[id] = value
    return { master: levels.master || 0, tracks }
  }

  /** 把 master 频谱写入 out（Uint8Array）。 */
  getSpectrum(out) {
    if (!out) return
    if (this._graph) {
      try {
        this._graph.getSpectrum(out)
        return
      } catch {
        /* fallthrough */
      }
    }
    if (typeof out.fill === 'function') out.fill(0)
  }

  /**
   * R4c 实时电平表数值（只读；复用现有 analyser，不新增节点/不改声音）：
   * - tracks[id]: {rms, rmsDb, peak, peakDb}
   * - groups[id]: {rms, rmsDb, peak, peakDb}（由组内轨道表值聚合，组 mute/未 solo 命中为 0/-120）
   * - master: {rms, rmsDb, peak, peakDb, lufsApprox}（LUFS≈，K-weighting 省略）
   * 无图/未解锁/无 analyser 时全部 0/-120；不改变工程 revision/undo。
   */
  getMeters() {
    const base = emptyMeters(this._project)
    if (!this._graph) return base
    let meters = null
    try {
      meters = this._graph.getMeters()
    } catch {
      meters = null
    }
    if (!meters) return base
    const tracks = { ...base.tracks }
    for (const [id, value] of Object.entries(meters.tracks ?? {})) tracks[id] = value
    const groups = { ...base.groups }
    for (const [id, value] of Object.entries(meters.groups ?? {})) groups[id] = value
    return { tracks, groups, master: meters.master ?? base.master }
  }

  /**
   * v2.1 P0：导出响度归一（真 K 加权 LUFS，与 preview 的 analyzeChannels 同源）。
   * 原地缩放 AudioBuffer 的声道数据并回传 achievedLufs/peak/truePeak，供 /export-done 回传。
   * @param {AudioBuffer} audioBuffer
   * @param {number} targetLufs -24..-5 LUFS
   * @param {{peakCeiling?:number}} [options]
   * @returns {ReturnType<typeof applyTargetLufsGain>}
   */
  applyTargetLufs(audioBuffer, targetLufs, options = {}) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
      throw new Error('applyTargetLufs: 需要 AudioBuffer')
    }
    const channels = []
    for (let index = 0; index < audioBuffer.numberOfChannels; index++) {
      channels.push(audioBuffer.getChannelData(index))
    }
    return applyTargetLufsGain(channels, audioBuffer.sampleRate, targetLufs, options)
  }

  /** v2.1 P0：直接测量 AudioBuffer 的 peak/truePeak（导出与 preview 对比用，只读）。 */
  measureBufferPeak(audioBuffer, oversample = 4) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
      throw new Error('measureBufferPeak: 需要 AudioBuffer')
    }
    const channels = []
    for (let index = 0; index < audioBuffer.numberOfChannels; index++) {
      channels.push(audioBuffer.getChannelData(index))
    }
    return measureTruePeak(channels, oversample)
  }

  // -------------------------------------------------------------------------
  // 公共 API：外部 VST3 实时效果器（v2.2 M2；UI 只读状态 + setParam/旁路，不重复 load）
  // -------------------------------------------------------------------------

  /**
   * 外部插件能力与实例状态（UI 每 500ms 轮询）：
   * {supported, reason, items:[{instanceId,pluginId,effectId,trackId,target,loaded,degraded,bypass,
   *   underrun,bufferMs,latencyMs,sampleRate,maxBlockSize,error,params}], summary, warnings}
   */
  getExternalPlugins() {
    const supported = this._workletReady === true && isExternalPluginSupported()
    let items = []
    let summary = null
    try {
      items = this._graph?.listExternalPlugins?.() ?? []
      summary = this._graph?.getExternalSummary?.() ?? null
    } catch {
      items = []
      summary = null
    }
    if (!summary) {
      summary = {
        count: items.length,
        loaded: items.filter((item) => item.loaded === true).length,
        degraded: items.filter((item) => item.degraded === true).length,
        underrun: 0,
        maxLatencyMs: 0,
      }
    }
    return {
      supported,
      reason: supported
        ? ''
        : isExternalPluginSupported()
          ? 'AudioWorklet 尚未就绪，请先 unlock/恢复音频上下文'
          : '外部插件仅桌面版（缺少 window.aimsPlugins preload bridge）',
      items,
      summary,
      warnings: (this._externalWarnings ?? []).slice(),
    }
  }

  /** 单个外部效果器/乐器状态（instanceId = `fx:<effectId>` / `track:<trackId>`）。 */
  getExternalPluginStatus(instanceId) {
    try {
      return this._graph?.getExternalPluginStatus?.(instanceId) ?? null
    } catch {
      return null
    }
  }

  /**
   * v2.2 M4：冻结状态只读聚合（UI 显示 current/stale/error；动作走 host）。
   * @returns {{tracks:Array<{trackId,frozen,status,hash,mediaId,cachedAt,error}>}}
   */
  getFreezeStatus() {
    try {
      const fromGraph = this._graph?.getFreezeStatus?.()
      if (fromGraph && Array.isArray(fromGraph.tracks)) return fromGraph
    } catch {
      /* fallthrough */
    }
    const tracks = (this._project?.tracks ?? []).map((track) => {
      const info = frozenTrackInfo(track)
      return {
        trackId: track?.id ?? null,
        frozen: isFrozenTrack(track),
        status: info?.status ?? freezeStatusOf(track),
        hash: info?.hash ?? '',
        mediaId: info?.mediaId ?? '',
        cachedAt: info?.cachedAt ?? null,
        error: info?.error ?? '',
      }
    })
    return { tracks }
  }

  /**
   * v2.2 M4：导出前收集 vst3 实例 state（host 写 track/effect.vst3.stateBase64 持久化）。
   * @returns {Promise<{ok:boolean, states:Array<{instanceId,pluginId,kind,trackId,effectId,stateBase64}>, failed:Array}>}
   */
  async getExternalPluginStates() {
    const nodes = []
    try {
      nodes.push(...(this._graph?.externalNodes ?? []))
      nodes.push(...(this._graph?.instrumentNodes ?? []))
    } catch {
      /* ignore */
    }
    const states = []
    const failed = []
    for (const node of nodes) {
      const base = {
        instanceId: node.instanceId ?? null,
        pluginId: node.pluginId ?? null,
        kind: node.kind ?? (node.effectId ? 'effect' : 'instrument'),
        trackId: node.trackId ?? null,
        effectId: node.effectId ?? null,
      }
      let stateBase64 = null
      try {
        stateBase64 = (await node.bridge?.saveState?.()) ?? node.bridge?.stateBase64 ?? null
      } catch (error) {
        failed.push({ ...base, error: String(error?.message ?? error) })
        continue
      }
      if (typeof stateBase64 === 'string' && stateBase64 !== '') states.push({ ...base, stateBase64 })
      else failed.push({ ...base, error: '实例未返回 stateBase64' })
    }
    return { ok: failed.length === 0, states, failed }
  }

  /** 实时参数写入（bridge 内节流 ≤50ms，不进 undo；effect/instrument 均可）。 */
  setExternalPluginParam(instanceId, paramId, value) {
    try {
      return this._graph?.setExternalPluginParam?.(instanceId, paramId, value) === true
    } catch {
      return false
    }
  }

  /** 实时旁路（worklet 直通/静音，不改工程模型/undo）。 */
  setExternalPluginBypass(instanceId, bypass) {
    try {
      return this._graph?.setExternalPluginBypass?.(instanceId, bypass === true) === true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // 公共 API：乐器预览（CONTRACT-P3A §1，键盘/鼠标/MIDI 演奏试听）
  // -------------------------------------------------------------------------

  /**
   * 实时演奏预览：按该轨道乐器建一次性 voice，直接连到该轨 GraphTrack.input
   * （经过轨道音量/duck/FX/发送，听到真实音色）。
   * - synth：buildSynthVoice + resolveSynthParams；
   * - drum：drumPieceForPitch → 采样鼓或 buildDrumHit（pitch 不是鼓件 → null）；
   * - 采样器预设：buildSampleVoice（buffer 未加载 → null，不报错）。
   * 未 unlock / 无 ctx / 未知轨道 / 无可用音色 → null，不抛异常。
   * @returns {string|null} previewId（如 pv-1）
   */
  previewNote(trackId, pitch, velocity = 0.8) {
    if (this._disposed || !this._ctx || !this._graph) return null
    if (typeof this._ctx.state === 'string' && this._ctx.state !== 'running') return null
    const track = this._trackMap.get(trackId)
    const destination = this._graph.tracks.get(trackId)?.input
    if (!track || !destination) return null
    if (track.kind === 'audio') return null // 音频轨没有可演奏音色
    this._prunePreviews()
    const ctx = this._ctx
    const now = Number(ctx.currentTime) || 0
    const startTime = now + 0.006
    const pitchValue = Math.round(clamp(Number(pitch) || 0, 0, 127))
    const vel = clamp01(velocity === undefined || velocity === null ? 0.8 : velocity)
    // v2.2 M3：VST3 instrument 轨预览 → MIDI noteOn/noteOff，不建采样器 voice。
    if (isExternalInstrumentTrack(track)) {
      const instrument = this._graph.tracks.get(trackId)?.externalInstrument
      if (!instrument || instrument.degraded === true) return null
      this._previewSeq += 1
      const id = `pv-${this._previewSeq}`
      const previewDurSeconds = PREVIEW_DURATION_SECONDS
      try {
        if (!instrument.noteOn(pitchValue, clamp01(vel * PREVIEW_GAIN), startTime)) return null
        instrument.noteOff(pitchValue, startTime + previewDurSeconds)
      } catch {
        return null
      }
      this._previews.set(id, {
        id,
        trackId: track.id,
        pitch: pitchValue,
        startTime,
        endTime: startTime + previewDurSeconds,
        handle: {
          type: 'external-instrument',
          endTime: startTime + previewDurSeconds,
          stop(at) {
            try {
              instrument.noteOff(pitchValue, at)
            } catch {
              /* ignore */
            }
          },
          release() {},
        },
      })
      return id
    }
    // 预览也遵守延音踏板/揉弦（CONTRACT-P11）+ tempo automation（CONTRACT-P12）
    const tempo = this._tempo ?? tempoForProject(this._project)
    const barBeats = beatsPerBar(this._project)
    const positionBeat = this._plan ? this._currentBeat() : (Number(this._positionBar) || 0) * barBeats
    const previewDurBeatsRaw = Math.max(
      0.01,
      tempoBeatAfterSeconds(tempo, positionBeat, PREVIEW_DURATION_SECONDS) - positionBeat,
    )
    const previewDurBeats = sustainExtendedDurBeats(track, positionBeat, previewDurBeatsRaw, tempo)
    const previewDurSeconds = Math.max(
      0.05,
      tempoSecondsBetween(tempo, positionBeat, positionBeat + previewDurBeats),
    )
    const expression = noteExpression(track, positionBeat)
    let handle = null
    try {
      if (track.kind === 'drum') {
        const piece = drumPieceForPitch(pitchValue)
        if (!piece) return null
        const kit = findDrumKit(track.instrument?.kit)
        const kitParams = this._drumParams.get(track.id)
        if (kit?.samplerPieces?.[piece.id]) {
          handle = buildSampleDrum(
            ctx,
            destination,
            { startTime, vel: clamp01(vel * PREVIEW_GAIN), pieceId: piece.id },
            kitParams,
            { bank: this._sampleBank, kitId: kit.id, gainScale: kitGainScale(kit) },
          )
        }
        if (!handle) {
          handle = buildDrumHit(
            ctx,
            destination,
            { pitch: pitchValue, vel, startTime, piece },
            kitParams,
            { kitId: track.instrument?.kit, gainScale: PREVIEW_GAIN },
          )
        }
      } else if (track.engine === 'subtractive') {
        handle = buildSubtractiveVoice(
          ctx,
          destination,
          {
            pitch: pitchValue,
            vel: clamp01(vel * PREVIEW_GAIN),
            startTime,
            dur: previewDurSeconds,
            pitchBendCents: expression.pitchBendCents,
            expressionGain: expression.expressionGain,
          },
          resolveSubtractiveTrackParams(track),
        )
      } else {
        const preset = findSynthPreset(track.instrument?.preset)
        if (preset?.soundfont) {
          handle = this._soundfontBank.buildVoice(ctx, destination, {
            program: preset.soundfont.program,
            bank: preset.soundfont.bank ?? 0,
            pitch: pitchValue,
            vel: clamp01(vel * PREVIEW_GAIN),
            startTime,
            dur: previewDurSeconds,
            vibrato: expression.vibrato,
            pitchBendCents: expression.pitchBendCents,
            expressionGain: expression.expressionGain,
            gainScale: presetGainScale(preset),
            ...voiceInstrumentOptions(track),
          })
        } else if (preset?.sampler) {
          handle = buildSampleVoice(
            ctx,
            destination,
            {
              pitch: pitchValue,
              vel: clamp01(vel * PREVIEW_GAIN) * expression.expressionGain,
              startTime,
              dur: previewDurSeconds,
            },
            preset.sampler,
            { bank: this._sampleBank, gainScale: presetGainScale(preset) },
          )
        } else {
          const params = this._synthParams.get(track.id) ?? resolveSynthParams(track)
          handle = buildSynthVoice(
            ctx,
            destination,
            { pitch: pitchValue, vel, startTime, dur: previewDurSeconds },
            params,
            {
              presetId: track.instrument?.preset,
              gainScale: PREVIEW_GAIN * expression.expressionGain * presetGainScale(preset),
              pitchBendCents: expression.pitchBendCents,
            },
          )
        }
      }
    } catch {
      handle = null
    }
    if (!handle) return null
    this._previewSeq += 1
    const id = `pv-${this._previewSeq}`
    this._previews.set(id, {
      id,
      trackId: track.id,
      pitch: pitchValue,
      startTime,
      endTime: Number(handle.endTime) || startTime + previewDurSeconds,
      handle,
    })
    return id
  }

  /** 停止一个预览 voice（短 release）；未知/重复 id 安全返回 false。 */
  stopPreview(id) {
    if (typeof id !== 'string') return false
    const preview = this._previews.get(id)
    if (!preview) return false
    this._previews.delete(id)
    const at = (Number(this._ctx?.currentTime) || 0) + 0.03
    try {
      preview.handle?.stop?.(at)
    } catch {
      /* ignore */
    }
    return true
  }

  /** 停止全部预览 voice（面板关闭 / stop() / dispose() 调用）；返回停止数量。 */
  stopAllPreviews() {
    if (!this._previews.size) return 0
    const at = (Number(this._ctx?.currentTime) || 0) + 0.03
    const count = this._previews.size
    for (const preview of this._previews.values()) {
      try {
        preview.handle?.stop?.(at)
      } catch {
        /* ignore */
      }
    }
    this._previews.clear()
    return count
  }

  /** 清理已自然结束的预览 voice 记录（不重复 stop）。 */
  _prunePreviews() {
    if (!this._previews.size) return
    const now = Number(this._ctx?.currentTime) || 0
    for (const [id, preview] of this._previews) {
      if (preview.endTime > now + 0.2) continue
      this._previews.delete(id)
      try {
        preview.handle?.release?.()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * v2.2 M4：通过 host 路由自动冻结未冻结的 vst3 轨（同源渲染页）；返回刷新后的 project。
   * 无 fetch/location（Node 单测）或 autoFreeze:false 时安全跳过。
   */
  async _autoFreezeTracksForRender(project, opts = {}) {
    const warnings = []
    const tracks = unfrozenVst3Tracks(project)
    if (tracks.length === 0) return { project, warnings }
    if (opts.autoFreeze === false) return { project, warnings }
    const canFetch =
      typeof fetch === 'function' &&
      typeof location !== 'undefined' &&
      Boolean(location) &&
      /^https?:$/.test(String(location.protocol ?? ''))
    if (!canFetch) return { project, warnings }
    let frozenCount = 0
    for (const track of tracks) {
      try {
        const body = { trackId: track.id }
        if (Number.isFinite(Number(opts.freezeBars))) body.bars = Math.round(Number(opts.freezeBars))
        // 普通轨 + VST3 effect：先由 engine 渲染干声 PCM 随请求提交，host 用它跑 effect 链。
        const hasVst3Effect = (track.effects ?? []).some((effect) => effect?.type === 'vst3')
        if (track.engine !== 'vst3' && hasVst3Effect) {
          try {
            const dry = await this.freezeTrackAudio(track.id, {
              project,
              bars: body.bars ?? project?.lengthBars,
            })
            body.inputPcm = dry.inputPcm
            body.bars = dry.bars
          } catch (dryError) {
            warnings.push({
              code: 'freeze-dry-failed',
              message: `渲染轨道「${track.name ?? track.id}」干声失败：${String(dryError?.message ?? dryError)}`,
              trackId: track.id ?? null,
            })
          }
        }
        const response = await fetch('/studio/api/plugin-freeze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok === false) {
          throw new Error(String(payload?.error ?? `HTTP ${response.status}`))
        }
        frozenCount += 1
      } catch (error) {
        warnings.push({
          code: 'freeze-auto-failed',
          message: `自动冻结轨道「${track.name ?? track.id}」失败：${String(error?.message ?? error)}`,
          trackId: track.id ?? null,
        })
      }
    }
    if (frozenCount === 0) return { project, warnings }
    try {
      const stateResponse = await fetch('/studio/api/state?rev=0', { cache: 'no-store' })
      const state = await stateResponse.json()
      const next = state?.project ?? state?.result?.project
      if (next && typeof next === 'object') return { project: next, warnings }
      warnings.push({ code: 'freeze-auto-failed', message: '自动冻结后读取工程状态失败，继续用原工程导出' })
    } catch (error) {
      warnings.push({
        code: 'freeze-auto-failed',
        message: `自动冻结后读取工程状态失败：${String(error?.message ?? error)}，继续用原工程导出`,
      })
    }
    return { project, warnings }
  }

  /**
   * v2.2 M4：渲染普通轨（非 VST3 乐器轨）的**干声 PCM**，用于 host `/plugin-freeze` 的 inputPcm 路径。
   * - 只渲染该轨的乐器/采样/音频片段内部声音；**排除**轨道内置 FX、外部 VST3 节点、trackGain/pan/sends/master；
   * - 输出 48k（默认）stereo base64 planar，frames 与 host freeze 的 bars/sampleRate 公式一致；
   * - includesFx:false 语义：host 缓存 external effect 输出，audio 冻结播放时保留轨道内置 FX。
   * @returns {Promise<{ok:boolean,trackId:string,bars:number,frames:number,sampleRate:number,channels:string[],inputPcm:string[]}>}
   */
  async freezeTrackAudio(trackId, opts = {}) {
    const project = opts.project || this._project
    if (!project) throw new Error('freezeTrackAudio: 缺少 project')
    const track = (project.tracks ?? []).find((item) => item?.id === trackId)
    if (!track) throw new Error(`轨道不存在：${String(trackId)}`)
    if (isExternalInstrumentTrack(track)) throw new Error('VST3 乐器轨请直接整轨冻结，无需渲染干声')
    const vst3Effects = (track.effects ?? []).filter((effect) => effect?.type === 'vst3')
    if (vst3Effects.length === 0) throw new Error('该轨道没有 VST3 效果器，无需渲染干声')
    const Ctor = getOfflineAudioContextCtor()
    if (!Ctor) throw new Error('当前环境不支持 OfflineAudioContext')
    const sampleRate = Math.max(8000, Math.min(192000, Math.round(Number(opts.sampleRate) || 48000)))
    const bars = Math.max(1, Math.min(256, Math.round(Number(opts.bars ?? project.lengthBars) || project.lengthBars || 1)))
    const barBeats = beatsPerBar(project)
    const bpm = clamp(Number(project.bpm) || 120, 40, 200)
    const frames = Math.max(1, Math.min(sampleRate * 300, Math.round(bars * barBeats * (60 / bpm) * sampleRate)))
    const renderSeconds = frames / sampleRate
    const rangeEndBeat = bars * barBeats
    await this._ensureSamplesForRender(project)
    await this._ensureMediaForRender(project, sampleRate)
    await this._ensureSoundfontForRender(project)
    const offline = new Ctor(2, frames, sampleRate)
    const dry = offline.createGain()
    dry.gain.value = 1
    dry.connect(offline.destination)
    const tempo = tempoForProject(project)
    const barBeatsNow = beatsPerBar(project)
    const events = expandProjectEvents(project).events ?? []
    const drumParams = track.kind === 'drum' ? resolveDrumParams(track) : null
    const synthParams = track.kind === 'drum' ? null : resolveSynthParams(track)
    const subtractiveParams = track.engine === 'subtractive' ? resolveSubtractiveTrackParams(track) : null
    const lastPitch = new Map()
    let scheduled = 0
    for (const ev of events) {
      if (ev.trackId !== trackId) continue
      if (ev.startBeat < 0 || ev.startBeat >= rangeEndBeat - 1e-9) continue
      const when = tempoSecondsBetween(tempo, 0, ev.startBeat)
      if (!(when >= 0) || when >= renderSeconds) continue
      const durBeats = sustainExtendedDurBeats(track, ev.startBeat, ev.durBeats, tempo)
      const durSeconds = Math.max(0.03, tempoSecondsBetween(tempo, ev.startBeat, ev.startBeat + durBeats))
      const expression = noteExpression(track, ev.startBeat)
      try {
        if (track.kind === 'drum') {
          const piece = drumPieceForPitch(ev.pitch)
          if (!piece) continue
          const kit = findDrumKit(track.instrument?.kit)
          if (kit?.samplerPieces?.[piece.id]) {
            buildSampleDrum(
              offline,
              dry,
              { startTime: when, vel: ev.vel, pieceId: piece.id },
              drumParams,
              { bank: this._sampleBank, kitId: kit.id, gainScale: kitGainScale(kit) },
            )
          } else {
            buildDrumHit(offline, dry, { pitch: ev.pitch, vel: ev.vel, startTime: when, piece }, drumParams, { kitId: track.instrument?.kit })
          }
        } else if (track.engine === 'subtractive') {
          buildSubtractiveVoice(
            offline,
            dry,
            {
              pitch: ev.pitch,
              vel: ev.vel,
              startTime: when,
              dur: durSeconds,
              pitchBendCents: expression.pitchBendCents,
              expressionGain: expression.expressionGain,
            },
            subtractiveParams,
          )
        } else {
          const preset = findSynthPreset(track.instrument?.preset)
          if (preset?.soundfont) {
            this._soundfontBank.buildVoice(offline, dry, {
              program: preset.soundfont.program,
              bank: preset.soundfont.bank ?? 0,
              pitch: ev.pitch,
              vel: ev.vel,
              startTime: when,
              dur: durSeconds,
              vibrato: expression.vibrato,
              pitchBendCents: expression.pitchBendCents,
              expressionGain: expression.expressionGain,
              gainScale: presetGainScale(preset),
              ...voiceInstrumentOptions(track),
            })
          } else if (preset?.sampler) {
            buildSampleVoice(
              offline,
              dry,
              {
                pitch: ev.pitch,
                vel: clamp01(ev.vel * expression.expressionGain),
                startTime: when,
                dur: durSeconds,
              },
              preset.sampler,
              { bank: this._sampleBank, gainScale: presetGainScale(preset) },
            )
          } else {
            const params = synthParams ?? resolveSynthParams(track)
            const prevPitch = lastPitch.get(track.id)
            const glideFrom = params.glide > 0 && prevPitch !== undefined ? pitchToFreq(prevPitch) : null
            buildSynthVoice(
              offline,
              dry,
              { pitch: ev.pitch, vel: ev.vel, startTime: when, dur: durSeconds, glideFrom },
              params,
              {
                presetId: track.instrument?.preset,
                pitchBendCents: expression.pitchBendCents,
                gainScale: expression.expressionGain * presetGainScale(preset),
              },
            )
            lastPitch.set(track.id, ev.pitch)
          }
        }
        scheduled += 1
      } catch {
        /* 单个 voice 失败不阻断其它事件 */
      }
    }
    // 音频轨片段（若该轨是 audio 且挂 VST3 effect）
    if (track.kind === 'audio') {
      const segments = buildAudioClipSegments(project, 0, rangeEndBeat, tempo)
      for (const segment of segments) {
        if (segment.trackId !== trackId || segment.whenSeconds >= renderSeconds) continue
        const buffer = this._mediaBank.getProcessed(segment.mediaId, segment.mediaFile, segment.mediaIdentity, {
          stretchRatio: segment.stretchRatio,
          semitones: segment.semitones,
          reverse: segment.reverse,
          sampleRate,
        })
        if (!buffer) continue
        const ratio = Number.isFinite(Number(segment.stretchRatio)) && Number(segment.stretchRatio) > 0 ? Number(segment.stretchRatio) : 1
        const processedOffset = (Number(segment.offsetSeconds) || 0) * ratio
        const offset = Math.min(Math.max(0, processedOffset), Math.max(0, buffer.duration - 0.001))
        const duration = Math.min(segment.durationSeconds, Math.max(0, buffer.duration - offset), Math.max(0, renderSeconds - segment.whenSeconds))
        if (!(duration > 0.01)) continue
        try {
          const source = offline.createBufferSource()
          source.buffer = buffer
          const clipGain = offline.createGain()
          source.connect(clipGain)
          clipGain.connect(dry)
          scheduleClipGainEnvelope(clipGain.gain, segment.whenSeconds, audioSegmentEnvelope(segment))
          source.start(segment.whenSeconds, offset, duration)
          scheduled += 1
        } catch {
          /* ignore */
        }
      }
    }
    if (scheduled === 0) throw new Error('该轨道在冻结区间内没有可渲染内容')
    const rendered = await offline.startRendering()
    const channels = [0, 1].map((index) => {
      const source = typeof rendered.getChannelData === 'function' ? rendered.getChannelData(index) : new Float32Array(frames)
      const data = new Float32Array(frames)
      if (source) data.set(source.subarray(0, Math.min(frames, source.length)), 0)
      return data
    })
    const inputPcm = float32PlanesToBase64(channels)
    return {
      ok: true,
      trackId: track.id,
      bars,
      frames,
      sampleRate,
      effectIds: vst3Effects.map((effect) => effect.id),
      channels: inputPcm,
      inputPcm,
    }
  }

  /**
   * 离线渲染 WAV。
   * @param {object} project
   * @param {{fromBar?:number, toBar?:number}} [opts]
   * @returns {Promise<{blob: Blob, seconds: number}>}
   */
  async renderWav(project, opts = {}) {
    const proj = project || this._project
    if (!proj) throw new Error('renderWav: 缺少 project')
    const Ctor = getOfflineAudioContextCtor()
    if (!Ctor) throw new Error('renderWav: 当前环境不支持 OfflineAudioContext')

    const plan = computeRenderPlan(proj, opts)
    const { barBeats, tempo, fromBar, frames, seconds: renderSeconds } = plan
    // CONTRACT-R0 §R0B.1：预览 solo / 只渲染指定轨（不改工程）
    const soloTrackIds = opts?.soloTrackIds ?? opts?.trackIds ?? null
    let renderProject = projectForSoloTrackIds(proj, soloTrackIds)
    const externalWarnings = []
    // v2.2 M4：导出前若仍有未冻结的 vst3 轨，尝试通过宿主提供的冻结钩子自动冻结后重试。
    const unfrozen = unfrozenVst3Tracks(renderProject)
    if (unfrozen.length > 0) {
      const freezeHook =
        (typeof opts.ensureFrozen === 'function' ? opts.ensureFrozen : null) ??
        (typeof opts.freezeProject === 'function' ? opts.freezeProject : null) ??
        (typeof globalThis !== 'undefined' && typeof globalThis.aimsFreeze?.freezeForExport === 'function'
          ? globalThis.aimsFreeze.freezeForExport.bind(globalThis.aimsFreeze)
          : null) ??
        (typeof globalThis !== 'undefined' && typeof globalThis.aimsPlugins?.freezeForExport === 'function'
          ? globalThis.aimsPlugins.freezeForExport.bind(globalThis.aimsPlugins)
          : null)
      if (freezeHook) {
        try {
          const prepared = await freezeHook(renderProject, { fromBar, toBar: plan.toBar, reason: 'export' })
          if (prepared && typeof prepared === 'object') renderProject = prepared
        } catch (error) {
          externalWarnings.push({
            code: 'freeze-auto-failed',
            message: `自动冻结外部插件失败：${String(error?.message ?? error)}`,
          })
        }
      } else if (opts.autoFreeze !== false) {
        // 默认走 host 路由 POST /studio/api/plugin-freeze（同源页面），冻结后重新取 state.project。
        const auto = await this._autoFreezeTracksForRender(renderProject, opts)
        renderProject = auto.project
        externalWarnings.push(...auto.warnings)
      }
      if (unfrozenVst3Tracks(renderProject).length > 0) {
        externalWarnings.push({
          code: 'freeze-unfrozen',
          message: '仍有外部插件轨未冻结，导出将 bypass 外部插件；请先在通道/插件面板冻结或重试',
        })
      }
    }

    // 离线渲染前先把用到的 CC0 采样解码好（与实时共用同一个 AudioBuffer）
    await this._ensureSamplesForRender(renderProject)
    // 音频媒体同样提前解码（解码采样率对齐本次渲染，保证重复导出逐位可复现）
    await this._ensureMediaForRender(renderProject, plan.sampleRate)
    // SF2 真实采样音色库提前加载（失败则采样乐器轨道静音，不中断渲染）
    await this._ensureSoundfontForRender(renderProject)

    const offline = new Ctor(2, frames, plan.sampleRate)
    // v2.2 M2/M4：冻结轨在离线图里 bypass 外部节点 + 轨道 FX，缓存 WAV 由下面单独调度；
    // 未冻结 vst3 仍降级直通并收集 warning。
    const graph = buildMixGraph(offline, renderProject, {
      analysers: false,
      workletReady: false,
      getApi: () => null,
      warnings: externalWarnings,
    })
    try {
      // ---- 离线自动化（CONTRACT-P2 §4）------------------------------------
      // volume / pan / master：按 ≤0.1s 采样 + 线性 ramp 直接排进 AudioParam；
      // cutoff：fx 封装内部拿不到 filter 节点，改为在 suspend 回调里按 ≤0.1s 应用。
      const automationSchedule = buildOfflineAutomationSchedule(renderProject, plan)
      const cutoffTracks = []
      for (const entry of automationSchedule.tracks) {
        if (entry.volume) {
          for (const sample of entry.volume) {
            graph.setTrackVolume(entry.trackId, sample.effective ?? sample.value, sample.time)
          }
        }
        if (entry.pan) {
          for (const sample of entry.pan) graph.setTrackPan(entry.trackId, sample.mapped, sample.time)
        }
        if (entry.cutoff && entry.cutoff.samples.length) {
          cutoffTracks.push(entry)
          // 渲染起点先落一次值（后续在 suspend 里按采样更新）
          graph.setTrackCutoff(entry.trackId, entry.cutoff.samples[0].mapped)
        }
      }
      if (automationSchedule.master) {
        for (const sample of automationSchedule.master) graph.setMasterVolume(sample.value, sample.time)
      }
      const hasDynamicCutoff = automationSchedule.hasCutoffDynamic && cutoffTracks.length > 0
      const applyCutoffAutomation = (now) => {
        if (!hasDynamicCutoff) return
        const beat = tempoSecondsToBeat(tempo, tempoBeatToSeconds(tempo, automationSchedule.startBeat) + now)
        for (const entry of cutoffTracks) {
          const value = automationValueAt(entry.cutoff.points, beat)
          if (value === null) continue
          graph.setTrackCutoff(entry.trackId, mapAutomationValue('cutoff', value))
        }
      }

      const rangeStartBeat = fromBar * barBeats
      const rangeEndBeat = plan.endBeat ?? rangeStartBeat + (tempoSecondsToBeat(tempo, renderSeconds) - tempoSecondsToBeat(tempo, 0))
      const { events } = expandProjectEvents(renderProject)

      // 离线渲染用独立的参数缓存，不改动实时引擎状态
      const trackMap = new Map((renderProject?.tracks ?? []).map((t) => [t?.id, t]))
      const synthParams = new Map()
      const drumParams = new Map()
      for (const track of renderProject?.tracks ?? []) {
        if (!track?.id) continue
        if (track.kind === 'drum') drumParams.set(track.id, resolveDrumParams(track))
        else synthParams.set(track.id, resolveSynthParams(track))
      }
      const lastPitch = new Map()
      const sidechainIndex = buildSidechainIndex(renderProject)
      let renderVoices = []
      // R5d：离线渲染同样按轨限制 subtractive 16 复音（丢最旧，与实时一致）
      const subtractiveVoices = new Map()

      // ---- 音频片段（audio 轨，CONTRACT-P3B §3）----------------------------
      // 与实时同一 buildAudioClipSegments：按渲染区间裁剪 + offset 修正；
      // 直接排进 OfflineAudioContext（AudioBufferSourceNode → 该轨 GraphTrack.input）。
      const audioSegments = buildAudioClipSegments(renderProject, rangeStartBeat, rangeEndBeat, tempo)
      for (const segment of audioSegments) {
        const audioTrack = trackMap.get(segment.trackId)
        const destination = graph.tracks.get(segment.trackId)?.input
        if (!audioTrack || !destination || audioTrack.mute) continue
        const ratio = Number.isFinite(Number(segment.stretchRatio)) && Number(segment.stretchRatio) > 0 ? Number(segment.stretchRatio) : 1
        const buffer = this._mediaBank.getProcessed(segment.mediaId, segment.mediaFile, segment.mediaIdentity, {
          stretchRatio: segment.stretchRatio,
          semitones: segment.semitones,
          reverse: segment.reverse,
          sampleRate: plan.sampleRate,
        })
        if (!buffer) continue // 未加载/处理失败 → 跳过不崩
        // R2b：offset 是源媒体时间 → 处理时间轴位置 = offset × ratio；duration 是 timeline 秒
        const processedOffset = (Number(segment.offsetSeconds) || 0) * ratio
        const offset = Math.min(Math.max(0, processedOffset), Math.max(0, buffer.duration - 0.001))
        const duration = Math.min(segment.durationSeconds, Math.max(0, buffer.duration - offset))
        if (!(duration > 0.01)) continue
        try {
          const source = offline.createBufferSource()
          source.buffer = buffer
          const gainNode = offline.createGain()
          source.connect(gainNode)
          gainNode.connect(destination)
          scheduleClipGainEnvelope(gainNode.gain, segment.whenSeconds, audioSegmentEnvelope(segment))
          source.start(segment.whenSeconds, offset, duration)
        } catch {
          /* 单片段失败不影响整首渲染 */
        }
      }

      // ---- 冻结轨缓存 WAV（M4）：替代外部节点 + 轨道 FX，从 bar0 缓存偏移到渲染起点 ----
      for (const frozenEntry of graph.getFrozenTracks?.() ?? []) {
        const frozenTrack = trackMap.get(frozenEntry.trackId)
        const destination = graph.tracks.get(frozenEntry.trackId)?.input
        if (!frozenTrack || !destination || frozenTrack.mute) continue
        const media = frozenMediaEntry(renderProject, frozenTrack)
        if (!media || !media.file) {
          externalWarnings.push({
            code: 'freeze-media-missing',
            message: '冻结缓存缺少 media 条目，导出时该轨静音，请重新冻结',
            trackId: frozenEntry.trackId,
          })
          continue
        }
        const buffer = this._mediaBank.get(media.id, media.file, mediaIdentity(media), plan.sampleRate)
        if (!buffer) {
          externalWarnings.push({
            code: 'freeze-cache-missing',
            message: '冻结缓存 WAV 未加载/缺失，导出时该轨静音，请重新冻结',
            trackId: frozenEntry.trackId,
          })
          continue
        }
        const offset = Math.max(0, Math.min(tempoBeatToSeconds(tempo, plan.startBeat), Math.max(0, buffer.duration - 0.001)))
        const duration = Math.max(0, Math.min(renderSeconds, buffer.duration - offset))
        if (!(duration > 0.01)) continue
        try {
          const source = offline.createBufferSource()
          source.buffer = buffer
          source.connect(destination)
          source.start(0, offset, duration)
        } catch {
          externalWarnings.push({
            code: 'freeze-playback-failed',
            message: '冻结缓存播放调度失败，该轨静音',
            trackId: frozenEntry.trackId,
          })
        }
      }

      // 把事件换算成「绝对秒」并排序；离线渲染时临近才创建 voice（见下）。
      const pending = []
      for (const ev of events) {
        if (ev.startBeat < rangeStartBeat - 1e-9 || ev.startBeat >= rangeEndBeat - 1e-9) continue
        const track = trackMap.get(ev.trackId)
        const destination = graph.tracks.get(ev.trackId)?.input
        if (!track || !destination) continue
        if (graph.tracks.get(ev.trackId)?.frozen === true) continue
        const swingBeats = Number(ev.swingBeats) || 0
        const when = tempoSecondsBetween(tempo, rangeStartBeat, ev.startBeat + swingBeats)
        if (!(when >= 0) || when >= renderSeconds - 1e-4) continue
        pending.push({ ev, track, destination, when })
      }
      pending.sort((a, b) => a.when - b.when)
      let pendingCursor = 0

      // 构建单个 voice；单个失败不影响整首渲染。
      const spawn = (item, startTime) => {
        const { ev, track, destination } = item
        // 侧链 ducking：源事件时间点给目标轨道排 duck（与实时 _scheduleEvent 一致）
        const duckTargets = sidechainIndex.get(ev.trackId)
        if (duckTargets && duckTargets.length) scheduleDuckTargets(graph, duckTargets, startTime, ev.pitch)
        const durBeats = sustainExtendedDurBeats(track, ev.startBeat, ev.durBeats, tempo)
        const durTargetSeconds = tempoSecondsBetween(tempo, ev.startBeat, ev.startBeat + durBeats)
        const durSeconds = Math.max(
          0.03,
          Math.min(durTargetSeconds, Math.max(0.03, renderSeconds - startTime)),
        )
        const expression = noteExpression(track, ev.startBeat)
        let handle = null
        try {
          if (track.kind === 'drum') {
            const piece = drumPieceForPitch(ev.pitch)
            if (!piece) return
            const kit = findDrumKit(track.instrument?.kit)
            if (kit?.samplerPieces?.[piece.id]) {
              handle = buildSampleDrum(
                offline,
                destination,
                { startTime, vel: ev.vel, pieceId: piece.id },
                drumParams.get(track.id),
                { bank: this._sampleBank, kitId: kit.id, gainScale: kitGainScale(kit) },
              )
            } else {
              handle = buildDrumHit(
                offline,
                destination,
                { pitch: ev.pitch, vel: ev.vel, startTime, piece },
                drumParams.get(track.id),
                { kitId: track.instrument?.kit },
              )
            }
          } else if (track.engine === 'subtractive') {
            handle = buildSubtractiveVoice(
              offline,
              destination,
              {
                pitch: ev.pitch,
                vel: ev.vel,
                startTime,
                dur: durSeconds,
                pitchBendCents: expression.pitchBendCents,
                expressionGain: expression.expressionGain,
              },
              resolveSubtractiveTrackParams(track),
            )
          } else {
            const preset = findSynthPreset(track.instrument?.preset)
            if (preset?.soundfont) {
              handle = this._soundfontBank.buildVoice(offline, destination, {
                program: preset.soundfont.program,
                bank: preset.soundfont.bank ?? 0,
                pitch: ev.pitch,
                vel: ev.vel,
                startTime,
                dur: durSeconds,
                vibrato: expression.vibrato,
                pitchBendCents: expression.pitchBendCents,
                expressionGain: expression.expressionGain,
                gainScale: presetGainScale(preset),
                ...voiceInstrumentOptions(track),
              })
            } else {
              const params = synthParams.get(track.id)
              if (!params) return
              if (preset?.sampler) {
                handle = buildSampleVoice(
                  offline,
                  destination,
                  {
                    pitch: ev.pitch,
                    vel: ev.vel * expression.expressionGain,
                    startTime,
                    dur: durSeconds,
                  },
                  preset.sampler,
                  { bank: this._sampleBank, gainScale: presetGainScale(preset) },
                )
              } else {
                const prevPitch = lastPitch.get(track.id)
                const glideFrom = params.glide > 0 && prevPitch !== undefined ? pitchToFreq(prevPitch) : null
                handle = buildSynthVoice(
                  offline,
                  destination,
                  { pitch: ev.pitch, vel: ev.vel, startTime, dur: durSeconds, glideFrom },
                  params,
                  {
                    presetId: track.instrument?.preset,
                    pitchBendCents: expression.pitchBendCents,
                    gainScale: expression.expressionGain * presetGainScale(preset),
                  },
                )
                lastPitch.set(track.id, ev.pitch)
              }
            }
          }
        } catch {
          handle = null
        }
        if (handle) {
          if (handle.type === 'subtractive') {
            const list = subtractiveVoices.get(track.id) ?? []
            while (list.length >= MAX_SUBTRACTIVE_VOICES) {
              const victim = list.shift()
              try {
                victim.handle?.stop?.(startTime)
              } catch {
                /* ignore */
              }
            }
            list.push({ handle, startTime })
            subtractiveVoices.set(track.id, list)
          }
          renderVoices.push({ endTime: Number(handle.endTime) || startTime + durSeconds, handle })
        }
      }

      // 创建所有开始时间 <= horizon 的 voice。
      const createUpTo = (horizon) => {
        while (pendingCursor < pending.length && pending[pendingCursor].when <= horizon + 1e-9) {
          const item = pending[pendingCursor]
          pendingCursor += 1
          spawn(item, Math.max(item.when, Number(offline.currentTime) || 0))
        }
      }

      // 释放已经结束的 voice，让音频图里只保留「正在响 + 即将响」的节点。
      const releaseFinished = (now) => {
        if (!renderVoices.length) return
        renderVoices = renderVoices.filter((entry) => {
          if (entry.endTime > now + 0.2) return true
          try {
            entry.handle.release?.()
          } catch {
            /* ignore */
          }
          return false
        })
      }

      // 关键：不能一次性把整首 1000+ 个 voice 全建进 OfflineAudioContext —— 已排程但尚未
      // 开始（甚至很久之后才结束）的节点会一直挂在音频图里参与每个渲染量子，导致渲染耗时
      // 随曲长超线性增长（真实 demo 60s 曾卡 75s+）。这里用 suspend()/resume() 每 1s
      // 只创建未来 2s 内的事件并释放已结束的 voice，使图规模恒定在 ~同时发声量级。
      // 有动态 cutoff 自动化时改为每 0.1s suspend 一次，顺带按采样应用滤波扫频。
      const canSuspend =
        typeof offline.suspend === 'function' && typeof offline.resume === 'function' && renderSeconds > 3.5
      if (canSuspend) {
        const STEP_SECONDS = hasDynamicCutoff ? 0.1 : 1
        const LOOKAHEAD_SECONDS = 2
        createUpTo(LOOKAHEAD_SECONDS)
        for (let t = STEP_SECONDS; t < renderSeconds - 0.05; t += STEP_SECONDS) {
          try {
            offline
              .suspend(t)
              .then(() => {
                const now = Number(offline.currentTime) || t
                try {
                  applyCutoffAutomation(now)
                  releaseFinished(now)
                  createUpTo(now + LOOKAHEAD_SECONDS)
                } catch {
                  /* 创建失败不阻断渲染 */
                }
                return offline.resume()
              })
              .catch(() => {})
          } catch {
            // 该实现不支持按时间 suspend：退化为一次性预排程（正确但可能更慢）
            createUpTo(renderSeconds)
            break
          }
        }
      } else {
        createUpTo(renderSeconds)
      }

      // master 淡入/淡出，避免导出文件首尾爆音（独立 fadeVol 节点，不与 master 音量自动化冲突）
      try {
        const fadeIn = Math.min(0.01, renderSeconds * 0.1)
        const fadeOut = Math.min(0.09, renderSeconds * 0.2)
        const gainParam = graph.fadeVol.gain
        gainParam.cancelScheduledValues(0)
        gainParam.setValueAtTime(0.0001, 0)
        gainParam.linearRampToValueAtTime(1, fadeIn)
        gainParam.setValueAtTime(1, Math.max(fadeIn, renderSeconds - fadeOut))
        gainParam.linearRampToValueAtTime(0.0001, renderSeconds)
      } catch {
        /* ignore */
      }

      const audioBuffer = await offline.startRendering()
      const blob = encodeWav(audioBuffer)
      return {
        blob,
        seconds: renderSeconds,
        sampleRate: plan.sampleRate,
        frames: plan.frames,
        mode: plan.mode,
        fast: plan.fast,
        fromBar: plan.fromBar,
        toBar: plan.toBar,
        startBeat: plan.startBeat,
        endBeat: plan.endBeat,
        renderedTrackIds: Array.isArray(renderProject?.tracks) && renderProject !== proj
          ? renderProject.tracks.map((track) => track.id)
          : null,
        warnings: externalWarnings.slice(),
        externalEffectsBypassed: externalWarnings.length > 0,
      }
    } finally {
      try {
        graph.dispose()
      } catch {
        /* ignore */
      }
    }
  }

  /** 释放全部资源（清定时器、停 voice、关 AudioContext）。 */
  dispose() {
    if (this._disposed) return
    this._disposed = true
    this._clearTimer()
    this._playing = false
    this._pendingPlay = null
    this._stopAllVoices(0.005)
    this._stopAllMediaVoices(0.005)
    this._stopAllFrozenVoices(0.005)
    this.stopAllPreviews()
    if (this._ctx) {
      try {
        this._ctx.removeEventListener('statechange', this._onStateChangeBound)
      } catch {
        /* ignore */
      }
      try {
        this._ctx.onstatechange = null
      } catch {
        /* ignore */
      }
    }
    if (this._graph) {
      try {
        this._graph.dispose()
      } catch {
        /* ignore */
      }
      this._graph = null
    }
    const ctx = this._ctx
    this._ctx = null
    if (ctx && typeof ctx.close === 'function') {
      try {
        const closed = ctx.close()
        if (closed && typeof closed.catch === 'function') closed.catch(() => {})
      } catch {
        /* ignore */
      }
    }
    const decodeCtx = this._mediaDecodeCtx
    this._mediaDecodeCtx = null
    if (decodeCtx && decodeCtx !== ctx && typeof decodeCtx.close === 'function') {
      try {
        const closed = decodeCtx.close()
        if (closed && typeof closed.catch === 'function') closed.catch(() => {})
      } catch {
        /* ignore */
      }
    }
    this._mediaSampleRate = undefined
    this._project = null
    this._trackMap.clear()
    this._synthParams.clear()
    this._drumParams.clear()
    this._lastPitch.clear()
    this._sidechainIndex.clear()
    this._audioSegments = []
    this._audioIndex = 0
    this._audioIter = 0
    this._mediaVoices = []
    try {
      this._mediaBank.clear()
    } catch {
      /* ignore */
    }
    try {
      this._soundfontBank.dispose()
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // 内部：graph / caches
  // -------------------------------------------------------------------------

  _refreshCaches() {
    const project = this._project
    this._trackMap = new Map((project?.tracks ?? []).map((t) => [t?.id, t]))
    this._synthParams = new Map()
    this._drumParams = new Map()
    for (const track of project?.tracks ?? []) {
      if (!track?.id) continue
      if (track.kind === 'drum') this._drumParams.set(track.id, resolveDrumParams(track))
      else this._synthParams.set(track.id, resolveSynthParams(track))
    }
    this._sidechainIndex = buildSidechainIndex(project)
  }

  _ensureGraph() {
    if (!this._ctx || !this._project) return
    if (!this._graph) this._buildGraph()
  }

  _buildGraph() {
    if (!this._ctx || !this._project) return
    if (this._graph) {
      try {
        this._graph.dispose()
      } catch {
        /* ignore */
      }
      this._graph = null
    }
    try {
      const warnings = []
      this._graph = buildMixGraph(this._ctx, this._project, {
        analysers: true,
        workletReady: this._workletReady === true,
        getApi: () => getExternalPluginApi(),
        warnings,
      })
      this._externalWarnings = warnings
      this._signature = graphSignature(this._project)
    } catch {
      this._graph = null
      this._externalWarnings = []
      this._signature = ''
    }
  }

  _rebuildGraph() {
    this.stopAllPreviews()
    this._stopAllVoices(0.012)
    this._stopAllMediaVoices(0.012)
    this._stopAllFrozenVoices(0.012)
    this._buildGraph()
  }

  _handleStateChange() {
    if (this._disposed) return
    const running = Boolean(this._ctx && this._ctx.state === 'running')
    if (running && this._pendingPlay && !this._playing) {
      const bar = this._pendingPlay.fromBar
      this._pendingPlay = null
      this._startPlayback(bar)
    }
    this._emitState()
  }

  // -------------------------------------------------------------------------
  // 内部：播放控制 / lookahead 调度
  // -------------------------------------------------------------------------

  _startPlayback(fromBar) {
    if (!this._ctx || !this._project) {
      this._pendingPlay = { fromBar }
      return
    }
    this._ensureGraph()
    if (!this._graph) {
      this._pendingPlay = { fromBar }
      return
    }
    this._refreshCaches()
    const project = this._project
    const plan = createPlaybackPlan(project, fromBar)
    const tempo = tempoForProject(project)
    const bps = bpmToBps(project.bpm)
    const anchorBeat = plan.startBeat
    const { events } = expandProjectEvents(project)
    const evList = mapEventsToTransport(events, plan, anchorBeat)

    this._stopAllVoices(0.012)
    this._stopAllMediaVoices(0.012)
    this._stopAllFrozenVoices(0.012)
    this._plan = plan
    this._evList = evList
    this._tempo = tempo
    this._bps = bps
    this._anchorBeat = anchorBeat
    this._anchorTime = Number(this._ctx.currentTime) || 0
    this._u0 = anchorBeat - plan.rangeStartBeat
    this._iter = 0
    this._index = 0
    // 音频片段：按播放区间 [rangeStartBeat, rangeEndBeat) 裁剪（loop 时逐圈重排；tempo map 感知）
    this._audioSegments = buildAudioClipSegments(project, plan.rangeStartBeat, plan.rangeEndBeat, tempo)
    this._audioIndex = 0
    this._audioIter = 0
    this._lastPitch.clear()
    this._lastAutomationAt = -Infinity
    this._positionBar = anchorBeat / plan.barBeats
    this._playing = true
    this._lastPositionNotify = this._anchorTime
    this._clearTimer()
    this._timer = setInterval(() => this._tick(), LOOKAHEAD_MS)
    this._scheduleHorizon(this._anchorTime + SCHEDULE_AHEAD_SECONDS)
    this._scheduleAudioHorizon(this._anchorTime + SCHEDULE_AHEAD_SECONDS)
    this._scheduleFrozenTracks(this._anchorTime)
    this._applyAutomation(true)
    this._emitState()
    this._emitPosition(true)
  }

  /** 播放中重建调度（保持位置连续；正在响的 voice 不打断，只清掉未开始的）。 */
  _reschedule() {
    if (!this._playing || !this._ctx || !this._graph || !this._project) return
    const bar = this.positionBar
    const now = Number(this._ctx.currentTime) || 0
    this._voices = this._voices.filter((voice) => {
      if (voice.startTime > now + 0.004) {
        try {
          voice.handle?.stop?.(now + 0.005)
        } catch {
          /* ignore */
        }
        return false
      }
      return voice.endTime > now - 0.05
    })
    // 音频片段统一从当前位置重排（offset 修正由 buildAudioClipSegments 计算）
    this._stopAllMediaVoices(0.01)
    this._stopAllFrozenVoices(0.01)

    this._refreshCaches()
    const project = this._project
    const plan = createPlaybackPlan(project, bar)
    const tempo = tempoForProject(project)
    const bps = bpmToBps(project.bpm)
    const anchorBeat = clamp(bar * plan.barBeats, plan.rangeStartBeat, plan.rangeEndBeat)
    const { events } = expandProjectEvents(project)
    this._plan = plan
    this._evList = mapEventsToTransport(events, plan, anchorBeat)
    this._tempo = tempo
    this._bps = bps
    this._anchorBeat = anchorBeat
    this._anchorTime = now
    this._u0 = anchorBeat - plan.rangeStartBeat
    this._iter = 0
    this._index = 0
    this._audioSegments = buildAudioClipSegments(project, plan.rangeStartBeat, plan.rangeEndBeat, tempo)
    this._audioIndex = 0
    this._audioIter = 0
    this._scheduleHorizon(now + SCHEDULE_AHEAD_SECONDS)
    this._scheduleAudioHorizon(now + SCHEDULE_AHEAD_SECONDS)
    this._scheduleFrozenTracks(now)
    this._applyAutomation(true)
    this._emitPosition(true)
  }

  _tick() {
    if (!this._playing || !this._ctx || !this._graph || !this._plan) return
    const now = Number(this._ctx.currentTime) || 0
    if (!this._plan.looping) {
      const beatNow = this._positionBeatAt(now)
      if (beatNow >= this._plan.rangeEndBeat - 1e-6) {
        this._finishAtEnd()
        return
      }
    }
    this._pruneVoices(now)
    this._pruneMediaVoices(now)
    this._scheduleHorizon(now + SCHEDULE_AHEAD_SECONDS)
    this._scheduleAudioHorizon(now + SCHEDULE_AHEAD_SECONDS)
    this._applyAutomation()
    if (now - this._lastPositionNotify >= 0.045) {
      this._lastPositionNotify = now
      this._emitPosition()
    }
  }

  _finishAtEnd() {
    const plan = this._plan
    this._positionBar = plan ? clamp(plan.rangeEndBar, 0, plan.lengthBars) : this._positionBar
    this._playing = false
    this._clearTimer()
    this._playbackReset()
    this._stopAllVoices(0.12)
    this._stopAllMediaVoices(0.12)
    this._stopAllFrozenVoices(0.12)
    this._restoreStaticParams()
    this._emitState()
    this._emitPosition(true)
  }

  _playbackReset() {
    this._plan = null
    this._evList = []
    this._iter = 0
    this._index = 0
    this._audioSegments = []
    this._audioIndex = 0
    this._audioIter = 0
    this._frozenVoices = []
  }

  /** 当前播放位置的绝对 beat（自动化曲线时间轴，单位 beat；tempo automation 感知）。 */
  _currentBeat() {
    if (!this._plan) return (Number(this._positionBar) || 0) * beatsPerBar(this._project)
    return this._positionBeatAt(Number(this._ctx?.currentTime) || 0)
  }

  /**
   * 由播放锚点 + tempo map 推算当前绝对 beat（考虑 loop 回绕）。
   * 常量 BPM 时与原 positionBeatAt(bps) 结果一致；循环时按「循环区间的积分秒数」回绕
   * （tempoMap 在循环区间外继续变化也不会影响循环内的速度）。
   */
  _positionBeatAt(now) {
    const plan = this._plan
    if (!plan) return (Number(this._positionBar) || 0) * beatsPerBar(this._project)
    const tempo = this._tempo ?? tempoForProject(this._project)
    const elapsed = Math.max(0, (Number(now) || 0) - this._anchorTime)
    const loopStartSeconds = tempoBeatToSeconds(tempo, plan.rangeStartBeat)
    const loopEndSeconds = tempoBeatToSeconds(tempo, plan.rangeEndBeat)
    if (plan.looping) {
      const loopSeconds = Math.max(1e-9, loopEndSeconds - loopStartSeconds)
      const anchorOffsetSeconds = tempoBeatToSeconds(tempo, this._anchorBeat) - loopStartSeconds
      const withinSeconds =
        (((anchorOffsetSeconds + elapsed) % loopSeconds) + loopSeconds) % loopSeconds
      return tempoSecondsToBeat(tempo, loopStartSeconds + withinSeconds)
    }
    const anchorSeconds = tempoBeatToSeconds(tempo, this._anchorBeat)
    const absoluteBeat = tempoSecondsToBeat(tempo, anchorSeconds + elapsed)
    return plan.rangeStartBeat + clamp(absoluteBeat - plan.rangeStartBeat, 0, plan.rangeLenBeats)
  }

  /**
   * 计算某个 transport 位置（relU，相对播放区间起点）在第 iteration 圈的 ctx 时间。
   * - 非循环：按 tempo map 全局积分；
   * - 循环：每圈用循环区间的积分秒数，避免区间外 tempoMap 影响循环速度。
   */
  _timeForTransport(relU, iteration = 0) {
    const plan = this._plan
    if (!plan) return this._anchorTime
    const tempo = this._tempo ?? tempoForProject(this._project)
    const loopStartSeconds = tempoBeatToSeconds(tempo, plan.rangeStartBeat)
    const anchorSeconds = tempoBeatToSeconds(tempo, this._anchorBeat)
    if (!plan.looping) {
      const absoluteBeat = this._anchorBeat + Number(relU || 0)
      return this._anchorTime + tempoBeatToSeconds(tempo, absoluteBeat) - anchorSeconds
    }
    const loopEndSeconds = tempoBeatToSeconds(tempo, plan.rangeEndBeat)
    const loopSeconds = Math.max(1e-9, loopEndSeconds - loopStartSeconds)
    const withinSeconds = tempoBeatToSeconds(tempo, plan.rangeStartBeat + Number(relU || 0)) - loopStartSeconds
    const anchorOffsetSeconds = anchorSeconds - loopStartSeconds
    return (
      this._anchorTime +
      Number(iteration || 0) * loopSeconds +
      withinSeconds -
      anchorOffsetSeconds
    )
  }

  /** 实时应用自动化：~40ms 节流；只写 enabled 且有点的参数（其余保持静态值）。 */
  _applyAutomation(force = false) {
    if (!this._playing || !this._graph || !this._project || !this._plan) return 0
    const now = Number(this._ctx?.currentTime) || 0
    if (!force && now - this._lastAutomationAt < AUTOMATION_APPLY_INTERVAL) return 0
    this._lastAutomationAt = now
    try {
      const targets = [
        ...computeAutomationTargets(this._project, this._currentBeat()),
        ...computePluginAutomationTargets(this._project, this._currentBeat()),
      ]
      return applyAutomationTargets(this._graph, targets)
    } catch {
      return 0
    }
  }

  /** 停止 / 播完后恢复工程静态参数（音量/声像/master/效果器 cutoff），避免卡在自动化半路。 */
  _restoreStaticParams() {
    this._lastAutomationAt = -Infinity
    if (!this._graph || !this._project) return
    try {
      this._graph.update(this._project)
    } catch {
      /* ignore */
    }
  }

  _scheduleHorizon(horizonCtxTime) {
    const plan = this._plan
    if (!plan || !this._graph || !this._evList.length) return
    const n = this._evList.length
    const now = Number(this._ctx.currentTime) || 0
    let guard = 0
    while (guard < 1024) {
      guard += 1
      if (this._index >= n) {
        if (!plan.looping) break
        this._iter += 1
        this._index = 0
      }
      const ev = this._evList[this._index]
      const t = this._timeForTransport(ev.relU, this._iter)
      if (t > horizonCtxTime + 1e-9) break
      this._index += 1
      // 首轮循环里「播放起点之前」的音符要等下一轮；已经错过的（标签页节流）不补播
      if (t < this._anchorTime - 0.001) continue
      if (t < now - 0.08) continue
      this._scheduleEvent(ev, Math.max(t, now + 0.004))
    }
  }

  /**
   * 实时音频片段 lookahead 调度（与音符共用 _anchorTime/_alpha 时间轴）。
   * loop 时每个循环重新排一遍；播放起点之前的片段第一轮跳过，下一轮再播。
   */
  _scheduleAudioHorizon(horizonCtxTime) {
    const plan = this._plan
    if (!plan || !this._graph || !this._audioSegments.length || !this._ctx) return
    const n = this._audioSegments.length
    const now = Number(this._ctx.currentTime) || 0
    let guard = 0
    while (guard < 256) {
      guard += 1
      if (this._audioIndex >= n) {
        if (!plan.looping) break
        this._audioIter += 1
        this._audioIndex = 0
      }
      const segment = this._audioSegments[this._audioIndex]
      const t = this._timeForTransport(segment.relBeats, this._audioIter)
      if (t > horizonCtxTime + 1e-9) break
      this._audioIndex += 1
      if (t < this._anchorTime - 0.001) continue
      if (t < now - 0.08) continue
      this._scheduleAudioSegment(segment, Math.max(t, now + 0.004))
    }
  }

  /**
   * 调度一个音频片段：AudioBufferSourceNode.start(when, offset, duration) 连到该轨 GraphTrack.input。
   * media 未加载 / 轨道 mute / 片段已被裁剪为空 → 跳过（不崩）。
   * @returns {boolean} 是否成功调度
   */
  _scheduleAudioSegment(segment, when) {
    const ctx = this._ctx
    const graph = this._graph
    if (!ctx || !graph || !segment) return false
    const track = this._trackMap.get(segment.trackId)
    if (!track || track.kind !== 'audio' || track.mute) return false
    // R4a：group mute/solo 与轨道 solo 合并（静音/未被选中 → 不调度，图节点也会静音）
    if (trackGainForValue(this._project, track, track.volume) <= 0) return false
    const destination = graph.tracks.get(segment.trackId)?.input
    if (!destination) return false
    const ratio = Number.isFinite(Number(segment.stretchRatio)) && Number(segment.stretchRatio) > 0 ? Number(segment.stretchRatio) : 1
    const buffer = this._mediaBank.getProcessed(segment.mediaId, segment.mediaFile, segment.mediaIdentity, {
      stretchRatio: segment.stretchRatio,
      semitones: segment.semitones,
      reverse: segment.reverse,
      sampleRate: this._mediaSampleRate || Math.round(Number(this._mediaBank.context?.sampleRate) || 0) || undefined,
    })
    if (!buffer) return false // 未加载/处理失败 → 跳过不崩
    // R2b：offset 是源媒体时间 → 处理时间轴位置 = offset × ratio；duration 是 timeline 秒
    const processedOffset = (Number(segment.offsetSeconds) || 0) * ratio
    const offset = Math.min(Math.max(0, processedOffset), Math.max(0, buffer.duration - 0.001))
    const maxDuration = Math.max(0, buffer.duration - offset)
    const duration = Math.min(segment.durationSeconds, maxDuration)
    if (!(duration > 0.01)) return false
    let source = null
    let gainNode = null
    try {
      source = ctx.createBufferSource()
      source.buffer = buffer
      gainNode = ctx.createGain()
      source.connect(gainNode)
      gainNode.connect(destination)
      scheduleClipGainEnvelope(gainNode.gain, when, audioSegmentEnvelope(segment))
      source.start(when, offset, duration)
    } catch {
      try {
        source?.disconnect?.()
      } catch {
        /* ignore */
      }
      try {
        gainNode?.disconnect?.()
      } catch {
        /* ignore */
      }
      return false
    }
    const handle = {
      source,
      gainNode,
      trackId: segment.trackId,
      mediaId: segment.mediaId,
      endTime: when + duration,
      stop(at) {
        try {
          source.stop(at)
        } catch {
          /* ignore */
        }
      },
      release() {
        try {
          source.disconnect()
        } catch {
          /* ignore */
        }
        try {
          gainNode?.disconnect?.()
        } catch {
          /* ignore */
        }
      },
    }
    this._mediaVoices.push({ startTime: when, endTime: handle.endTime, handle })
    try {
      source.onended = () => {
        try {
          source.disconnect()
        } catch {
          /* ignore */
        }
        const index = this._mediaVoices.findIndex((voice) => voice.handle === handle)
        if (index >= 0) this._mediaVoices.splice(index, 1)
      }
    } catch {
      /* ignore */
    }
    return true
  }

  _pruneMediaVoices(now) {
    if (!this._mediaVoices.length) return
    this._mediaVoices = this._mediaVoices.filter((voice) => {
      if (voice.endTime > now - 0.05) return true
      try {
        voice.handle.release?.()
      } catch {
        /* ignore */
      }
      return false
    })
  }

  _stopAllMediaVoices(fadeSeconds = 0.02) {
    if (!this._mediaVoices.length) return 0
    const now = this._ctx ? Number(this._ctx.currentTime) || 0 : 0
    const count = this._mediaVoices.length
    for (const voice of this._mediaVoices) {
      try {
        voice.handle.stop(now + Math.max(0, fadeSeconds))
      } catch {
        /* ignore */
      }
    }
    this._mediaVoices = []
    return count
  }

  /** v2.2 M4：冻结缓存 AudioBuffer（media 条目由 host 冻结时登记）。 */
  _frozenTrackBuffer(frozenEntry) {
    const project = this._project
    const trackId = frozenEntry?.trackId
    const track = this._trackMap.get(trackId)
    if (!project || !track) return null
    const media = frozenMediaEntry(project, track)
    if (!media || !media.file) return null
    const sampleRate = this._mediaSampleRate || Math.round(Number(this._mediaBank.context?.sampleRate) || 0) || undefined
    return this._mediaBank.get(media.id, media.file, mediaIdentity(media), sampleRate) ?? null
  }

  /**
   * v2.2 M4：冻结轨播放缓存 WAV（替代外部节点 + 轨道 FX）。
   * 缓存从 bar0 渲染；loop 时设置 buffer loopStart/loopEnd 为播放区间，offset 按当前 anchor。
   */
  _scheduleFrozenTracks(whenBase) {
    if (!this._playing && !this._plan) return 0
    if (!this._ctx || !this._graph || !this._project || !this._plan) return 0
    const frozenTracks = this._graph.getFrozenTracks?.() ?? []
    if (!frozenTracks.length) return 0
    const plan = this._plan
    const tempo = this._tempo ?? tempoForProject(this._project)
    const when = Math.max(Number(whenBase) || Number(this._ctx.currentTime) || 0, Number(this._ctx.currentTime) || 0)
    const rangeStartSeconds = Math.max(0, tempoBeatToSeconds(tempo, plan.rangeStartBeat))
    const rangeEndSeconds = Math.max(rangeStartSeconds + 0.01, tempoBeatToSeconds(tempo, plan.rangeEndBeat))
    const anchorSeconds = Math.max(0, tempoBeatToSeconds(tempo, this._anchorBeat))
    const loopSeconds = Math.max(0.01, rangeEndSeconds - rangeStartSeconds)
    let scheduled = 0
    for (const frozenEntry of frozenTracks) {
      const buffer = this._frozenTrackBuffer(frozenEntry)
      const graphTrack = this._graph.tracks.get(frozenEntry.trackId)
      if (!buffer || !graphTrack?.input) continue
      let offset = anchorSeconds
      if (plan.looping) offset = rangeStartSeconds + (((anchorSeconds - rangeStartSeconds) % loopSeconds) + loopSeconds) % loopSeconds
      offset = Math.max(0, Math.min(offset, Math.max(0, buffer.duration - 0.001)))
      try {
        const source = this._ctx.createBufferSource()
        source.buffer = buffer
        if (plan.looping && rangeEndSeconds > rangeStartSeconds && rangeEndSeconds <= buffer.duration + 0.001) {
          source.loop = true
          source.loopStart = rangeStartSeconds
          source.loopEnd = Math.min(rangeEndSeconds, buffer.duration)
        }
        source.connect(graphTrack.input)
        const duration = plan.looping ? undefined : Math.max(0.01, Math.min(rangeEndSeconds - anchorSeconds, buffer.duration - offset))
        if (duration === undefined) source.start(when, offset)
        else source.start(when, offset, duration)
        const voice = {
          source,
          trackId: frozenEntry.trackId,
          startTime: when,
          endTime: when + (duration ?? loopSeconds),
          release() {
            try {
              source.disconnect()
            } catch {
              /* ignore */
            }
          },
        }
        source.onended = () => {
          try {
            source.disconnect()
          } catch {
            /* ignore */
          }
        }
        this._frozenVoices.push(voice)
        scheduled += 1
      } catch {
        /* 单个冻结轨调度失败不阻断其他轨道 */
      }
    }
    return scheduled
  }

  _stopAllFrozenVoices(fadeSeconds = 0.02) {
    if (!this._frozenVoices.length) return 0
    const now = this._ctx ? Number(this._ctx.currentTime) || 0 : 0
    const count = this._frozenVoices.length
    for (const voice of this._frozenVoices) {
      try {
        voice.source.stop(now + Math.max(0, fadeSeconds))
      } catch {
        /* ignore */
      }
      try {
        voice.source.disconnect()
      } catch {
        /* ignore */
      }
    }
    this._frozenVoices = []
    return count
  }

  _scheduleEvent(ev, startTime) {
    const ctx = this._ctx
    const graph = this._graph
    if (!ctx || !graph) return
    const track = this._trackMap.get(ev.trackId)
    const graphTrack = graph.tracks.get(ev.trackId)
    const destination = graphTrack?.input
    if (!track || !destination) return
    // v2.2 M4：冻结轨播放缓存 WAV，不再调度音符/MIDI（缓存已含轨道 FX）
    if (graphTrack?.frozen === true) return
    const now = Number(ctx.currentTime) || 0
    const tempo = this._tempo ?? tempoForProject(this._project)
    // swing 以 beat 表示 → 按 tempo map 换算成秒
    const swingBeats = Number(ev.swingBeats) || 0
    const swingSeconds = swingBeats > 0 ? tempoSecondsBetween(tempo, ev.startBeat, ev.startBeat + swingBeats) : 0
    let when = startTime + swingSeconds
    if (!(when >= now)) when = now + 0.004
    // CONTRACT-P11：非鼓轨按延音踏板延长音符时长；无 track.sustain 时与原行为一致
    const durBeats = sustainExtendedDurBeats(track, ev.startBeat, ev.durBeats, tempo)
    const durSeconds = Math.max(0.03, tempoSecondsBetween(tempo, ev.startBeat, ev.startBeat + durBeats))
    const vibrato = trackVibrato(track)

    // 侧链：源轨道事件触发所有目标轨的 ducking（无侧链时索引为空 → 零开销）
    const duckTargets = this._sidechainIndex.get(ev.trackId)
    if (duckTargets && duckTargets.length) scheduleDuckTargets(graph, duckTargets, when, ev.pitch)

    // v2.2 M3：VST3 instrument 轨 → MIDI noteOn/noteOff；不建采样器 voice（16 复音由插件负责）
    if (isExternalInstrumentTrack(track)) {
      const instrument = graph.tracks.get(ev.trackId)?.externalInstrument
      if (instrument && instrument.degraded !== true && typeof instrument.noteOn === 'function') {
        try {
          const velocity = clamp01(Number(ev.vel) || 0.8)
          instrument.noteOn(ev.pitch, velocity, when)
          instrument.noteOff(ev.pitch, when + durSeconds)
        } catch {
          /* ignore */
        }
      }
      return
    }

    if (this._voices.length >= MAX_VOICES) this._stealVoice(now)

    let handle = null
    const expression = noteExpression(track, ev.startBeat)
    try {
      if (track.kind === 'drum') {
        const piece = drumPieceForPitch(ev.pitch)
        if (!piece) return
        const kit = findDrumKit(track.instrument?.kit)
        if (kit?.samplerPieces?.[piece.id]) {
          handle = buildSampleDrum(
            ctx,
            destination,
            { startTime: when, vel: ev.vel, pieceId: piece.id },
            this._drumParams.get(track.id),
            { bank: this._sampleBank, kitId: kit.id, gainScale: kitGainScale(kit) },
          )
        } else {
          handle = buildDrumHit(
            ctx,
            destination,
            { pitch: ev.pitch, vel: ev.vel, startTime: when, piece },
            this._drumParams.get(track.id),
            { kitId: track.instrument?.kit },
          )
        }
      } else if (track.engine === 'subtractive') {
        this._enforceSubtractiveVoices(track.id, now)
        handle = buildSubtractiveVoice(
          ctx,
          destination,
          {
            pitch: ev.pitch,
            vel: ev.vel,
            startTime: when,
            dur: durSeconds,
            pitchBendCents: expression.pitchBendCents,
            expressionGain: expression.expressionGain,
          },
          resolveSubtractiveTrackParams(track),
        )
      } else {
        const preset = findSynthPreset(track.instrument?.preset)
        if (preset?.soundfont) {
          handle = this._soundfontBank.buildVoice(ctx, destination, {
            program: preset.soundfont.program,
            bank: preset.soundfont.bank ?? 0,
            pitch: ev.pitch,
            vel: ev.vel,
            startTime: when,
            dur: durSeconds,
            vibrato: expression.vibrato,
            pitchBendCents: expression.pitchBendCents,
            expressionGain: expression.expressionGain,
            gainScale: presetGainScale(preset),
            ...voiceInstrumentOptions(track),
          })
        } else {
          const params = this._synthParams.get(track.id)
          if (!params) return
          if (preset?.sampler) {
            handle = buildSampleVoice(
              ctx,
              destination,
              {
                pitch: ev.pitch,
                vel: ev.vel * expression.expressionGain,
                startTime: when,
                dur: durSeconds,
              },
              preset.sampler,
              { bank: this._sampleBank, gainScale: presetGainScale(preset) },
            )
          } else {
            const prevPitch = this._lastPitch.get(track.id)
            const glideFrom = params.glide > 0 && prevPitch !== undefined ? pitchToFreq(prevPitch) : null
            handle = buildSynthVoice(
              ctx,
              destination,
              { pitch: ev.pitch, vel: ev.vel, startTime: when, dur: durSeconds, glideFrom },
              params,
              {
                presetId: track.instrument?.preset,
                pitchBendCents: expression.pitchBendCents,
                gainScale: expression.expressionGain * presetGainScale(preset),
              },
            )
            if (handle) this._lastPitch.set(track.id, ev.pitch)
          }
        }
      }
    } catch {
      handle = null
    }
    if (handle) {
      this._voices.push({
        startTime: when,
        endTime: Number(handle.endTime) || when + durSeconds,
        handle,
        trackId: ev.trackId,
        trackKind: track.kind,
        engineKind: handle.type === 'subtractive' ? 'subtractive' : track.engine === 'subtractive' ? 'subtractive' : 'sampler',
      })
    }
  }

  _pruneVoices(now) {
    if (!this._voices.length) return
    this._voices = this._voices.filter((voice) => voice.endTime > now - 0.05)
  }

  /** R5d：每轨 subtractive 最多 16 复音，超出停止最旧并计数。 */
  _enforceSubtractiveVoices(trackId, now) {
    if (!this._voices.length) return 0
    const active = this._voices.filter((voice) => voice.trackId === trackId && voice.engineKind === 'subtractive')
    let stolen = 0
    while (active.length >= MAX_SUBTRACTIVE_VOICES) {
      const victim = active.shift()
      try {
        victim.handle?.stop?.(now + 0.01)
      } catch {
        /* ignore */
      }
      this._voices = this._voices.filter((voice) => voice !== victim)
      this._synthVoiceSteals = (this._synthVoiceSteals ?? 0) + 1
      stolen += 1
    }
    return stolen
  }

  _stealVoice(now) {
    if (!this._voices.length) return
    let victimIndex = -1
    for (let i = 0; i < this._voices.length; i++) {
      if (this._voices[i].trackKind === 'drum') continue
      if (victimIndex < 0 || this._voices[i].startTime < this._voices[victimIndex].startTime) victimIndex = i
    }
    if (victimIndex < 0) victimIndex = 0
    const victim = this._voices[victimIndex]
    try {
      victim.handle?.stop?.(now + 0.01)
    } catch {
      /* ignore */
    }
    this._voices.splice(victimIndex, 1)
  }

  _stopAllVoices(fadeSeconds = 0.02) {
    const now = this._ctx ? Number(this._ctx.currentTime) || 0 : 0
    for (const voice of this._voices) {
      try {
        voice.handle?.stop?.(now + Math.max(0, fadeSeconds))
      } catch {
        /* ignore */
      }
    }
    this._voices = []
    // v2.2 M3：停止/切歌时清空 VST3 instrument 的 MIDI 队列并 all-notes-off，避免残余长音
    if (this._graph) {
      for (const entry of this._graph.tracks?.values?.() ?? []) {
        try {
          entry.externalInstrument?.panic?.(now + Math.max(0, fadeSeconds))
        } catch {
          /* ignore */
        }
      }
    }
  }

  _clearTimer() {
    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  _emitPosition() {
    if (!this._onPosition) return
    try {
      this._onPosition(this.positionBar)
    } catch {
      /* 回调异常不影响音频 */
    }
  }

  _emitState() {
    if (!this._onState) return
    try {
      this._onState({ playing: this._playing, unlocked: this.unlocked })
    } catch {
      /* ignore */
    }
  }
}
