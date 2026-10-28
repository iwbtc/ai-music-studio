/**
 * 混音图构建（audio-engine）。
 *
 * 同一套代码被实时 StudioEngine 与离线 renderWav 复用：只接受 BaseAudioContext
 * （AudioContext 或 OfflineAudioContext），因此离线渲染和实时播放的信号链完全一致。
 *
 * 信号图：
 *   track voices → trackGain → duckGain(侧链) → panner → track FX 链 → (analyser) ─┬→ masterIn
 *                                                                                  ├→ reverb send → reverb bus(Convolver) ┐
 *                                                                                  └→ delay send  → delay bus(feedback)   ┤
 *   reverb bus / delay bus 的返回 → masterIn；每跳总线路由：
 *   send → Convolver/反馈延迟 → bus FX 链 → 返回电平（bus.level）→ masterIn                                                             │
 *   masterIn → master FX 链 → masterVolume → fadeVol → limiter(DynamicsCompressor) → (master analyser) → destination
 *
 * 模块加载时不做任何 Web Audio 调用，Node 单测可 import 纯函数（graphSignature 等）。
 */
import { beatsPerBar } from '../../shared/model.js'
import { createTempoMap } from '../../shared/tempo.js'
import { makeImpulseResponse } from './fx.js'
import {
  buildFxChainWithExternal,
  createExternalInstrumentNode,
  isExternalInstrumentTrack,
  isFrozenTrack,
  frozenTrackInfo,
  frozenMediaEntry,
  freezeStatusOf,
} from './external-plugin.js'
import { instrumentFilterSettings } from './soundfont.js'
import { clamp, clamp01, rmsToLevel } from './dsp.js'

/** tempo automation 时延迟总线的静态基准 BPM（取 tempoMap 在 beat 0 的速度）。 */
function delayBusBpmFor(project) {
  try {
    return createTempoMap(project ?? {}).bpmAtBeat(0)
  } catch {
    return clamp(Number(project?.bpm) || 128, 40, 200)
  }
}

/** R4a：group bus 上限/默认电平（与 shared model 一致）。 */
export const GROUPS_MAX = 8
export const GROUP_LEVEL_DEFAULT = 0.8
export const GROUP_OUTPUT_MASTER = 'master'

/**
 * R4a：防御性规范化 project.groups（引擎侧；host 已 normalize 时等价）。
 * - ≤8 组；id 非空去重（任意字符串，兼容测试/旧数据）；name 截断；
 * - level 缺省 0.8；effects 只留合法对象；mute/solo 布尔；output 固定 master。
 */
export function normalizeEngineGroups(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  const used = new Set()
  for (const item of list) {
    if (out.length >= GROUPS_MAX) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null
    if (!id || used.has(id)) continue
    used.add(id)
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 40) : `Group ${out.length + 1}`
    const level = Number.isFinite(Number(item.level)) ? clamp01(Number(item.level)) : GROUP_LEVEL_DEFAULT
    const effects = Array.isArray(item.effects)
      ? item.effects.filter((effect) => effect && typeof effect === 'object' && typeof effect.type === 'string')
      : []
    out.push({
      id,
      name,
      level,
      effects,
      mute: item.mute === true,
      solo: item.solo === true,
      // R4b：组 FX bypass + 手动 PDC（0 省略）
      bypassFx: item.bypassFx === true,
      pdcMs: normalizePdcMs(item.pdcMs),
      output: GROUP_OUTPUT_MASTER,
    })
  }
  return out
}

/** 轨道实际输出到的 group id（不存在/非法 → null = master）。 */
export function resolveTrackGroupId(project, track, groups = normalizeEngineGroups(project?.groups)) {
  const output = track?.output
  if (typeof output !== 'string' || output === '' || output === GROUP_OUTPUT_MASTER) return null
  return groups.some((group) => group.id === output) ? output : null
}

/** 组静音/独奏 + 轨道 solo 合并后的组增益（线性 level，mute/solo 决定是否出声）。 */
export function groupGainFor(project, group) {
  if (!group) return 0
  const groups = normalizeEngineGroups(project?.groups)
  const spec = groups.find((item) => item.id === group.id) ?? group
  const tracks = project?.tracks ?? []
  const anyTrackSolo = tracks.some((track) => track?.solo === true)
  const anyGroupSolo = groups.some((item) => item.solo === true)
  const soloMode = anyTrackSolo || anyGroupSolo
  let gain = clamp01(spec.level)
  if (spec.mute === true) gain = 0
  if (soloMode) {
    const anyTrackSoloInGroup = tracks.some(
      (track) => track?.solo === true && resolveTrackGroupId(project, track, groups) === spec.id,
    )
    if (!(spec.solo === true || anyTrackSoloInGroup)) gain = 0
  }
  return gain
}

/** 轨道静音/独奏（含 group mute/solo 合并）→ 线性增益。 */
export function trackGainForValue(project, track, volume) {
  if (!track) return 0
  const groups = normalizeEngineGroups(project?.groups)
  const groupId = resolveTrackGroupId(project, track, groups)
  const group = groupId ? groups.find((item) => item.id === groupId) : null
  if (track.mute === true) return 0
  if (group?.mute === true) return 0
  const anyTrackSolo = (project?.tracks ?? []).some((t) => t?.solo === true)
  const anyGroupSolo = groups.some((item) => item.solo === true)
  const soloMode = anyTrackSolo || anyGroupSolo
  if (soloMode && !(track.solo === true || group?.solo === true)) return 0
  return Math.pow(clamp01(volume), 1.35)
}

/** 轨道静态音量（track.volume）→ 线性增益。 */
export function trackAudibleGain(project, track) {
  return trackGainForValue(project, track, track?.volume)
}

/**
 * v2.1 P0-5：音量自动化的乘算语义 —— effective = track.volume × automationValue。
 * 自动化只做「推子上的相对乘数」，不再绝对替换轨道音量；两个值都 clamp 0..1。
 * （静态音量仍走 trackGainForValue 的 1.35 感知曲线；这里得到的是交给该函数的 effective volume。）
 */
export function effectiveAutomationVolume(track, automationValue) {
  const trackVolume = Number.isFinite(Number(track?.volume)) ? clamp01(Number(track.volume)) : 1
  return trackVolume * clamp01(automationValue)
}

/* ------------------------------------------------------------------------- */
/* R4b：pre/post 发送、相位、单声道、FX bypass、手动 PDC                         */
/* ------------------------------------------------------------------------- */

/** 发送模式规范化：'pre' 保留，其余（缺省/非法）→ 'post'。 */
export function normalizeSendMode(raw) {
  return raw === 'pre' ? 'pre' : 'post'
}

/** PDC 毫秒规范化：非有限/负 → 0；钳制 0..500；保留 1 位小数。 */
export function normalizePdcMs(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(Math.min(500, Math.max(0, value)) * 10) / 10
}

/** 相位反相增益：phaseInvert=true → -1，否则 1。 */
export function phaseGainFor(track) {
  return track?.phaseInvert === true ? -1 : 1
}

/** 轨道结构签名片段（sendMode/bypassFx/mono/pdc/instrumentFilter 节点存在性 → 需要重建图）。 */
export function trackRoutingSignature(track) {
  const sendMode = normalizeSendMode(track?.sendMode)
  const bypassFx = track?.bypassFx === true ? 1 : 0
  const mono = track?.mono === true ? 1 : 0
  const pdc = normalizePdcMs(track?.pdcMs) > 0 ? 1 : 0
  const instrumentFilter = instrumentFilterSettings(track) ? 1 : 0
  return `s:${sendMode}|b:${bypassFx}|m:${mono}|p:${pdc}|i:${instrumentFilter}`
}

/** 组结构签名片段（bypassFx/pdc 是否存在节点 → 需要重建图）。 */
export function groupRoutingSignature(group) {
  const bypassFx = group?.bypassFx === true ? 1 : 0
  const pdc = normalizePdcMs(group?.pdcMs) > 0 ? 1 : 0
  return `b:${bypassFx}|p:${pdc}`
}

/** 主音量 → 线性增益。 */
export function masterGainFor(project) {
  return Math.pow(clamp01(project?.master?.volume ?? 0.82), 1.2)
}

/**
 * 找到效果器链中第一个 type==='filter' 的效果器 wrapper（无则 null）。
 * buildFxChain 内部用 Map 保存，迭代顺序即链内顺序。
 */
export function findFirstFilterEffect(fxChain) {
  const effects = fxChain?.effects
  if (!effects || typeof effects.values !== 'function') return null
  for (const wrapper of effects.values()) {
    if (wrapper && wrapper.type === 'filter') return wrapper
  }
  return null
}

const paramScheduleTimes = new WeakMap()

/**
 * 自动化参数调度（实时与离线共用）：
 * - 省略 time → 实时平滑（setTargetAtTime）；
 * - 给定 time（秒，相对渲染起点）→ 离线排程：首个点 setValueAtTime，
 *   之后 linearRampToValueAtTime（时间回退时重新 setValueAtTime）。
 */
export function scheduleAudioParamValue(param, value, time, now = 0) {
  if (!param) return false
  const target = Number(value)
  if (!Number.isFinite(target)) return false
  if (time === undefined || time === null) {
    try {
      param.setTargetAtTime(target, Math.max(0, Number(now) || 0), 0.02)
      return true
    } catch {
      try {
        param.value = target
      } catch {
        /* ignore */
      }
      return false
    }
  }
  const when = Math.max(0, Number(time) || 0)
  try {
    const last = paramScheduleTimes.get(param)
    if (last === undefined || when <= last + 1e-9) param.setValueAtTime(target, when)
    else param.linearRampToValueAtTime(target, when)
    paramScheduleTimes.set(param, when)
    return true
  } catch {
    try {
      param.value = target
    } catch {
      /* ignore */
    }
    return false
  }
}

/** 发送总线返回增益。 */
export function busReturnGain(level) {
  return Math.pow(clamp01(level), 0.85)
}

/** 两条固定返回总线。 */
export const BUS_IDS = Object.freeze(['reverb', 'delay'])

/** 返回总线默认值（与 model BUS_DEFAULTS 一致）。 */
export const BUS_DEFAULTS = Object.freeze({
  reverb: Object.freeze({ level: 0.35, effects: [] }),
  delay: Object.freeze({ level: 0.22, effects: [] }),
})

/**
 * 防御性规范化单条返回总线（CONTRACT-P2C2 §3）：
 * - 旧工程数字（如 `buses.reverb = 0.35`）→ `{level, effects: []}`；
 * - 新结构 `{level, effects}`；非法 level 回落 fallbackLevel，effects 只留合法对象；
 * - 任何输入都不抛异常，不崩。
 */
export function normalizeBus(raw, fallbackLevel = BUS_DEFAULTS.reverb.level) {
  const fallback = Number.isFinite(Number(fallbackLevel)) ? clamp01(fallbackLevel) : 0.35
  if (typeof raw === 'number' || typeof raw === 'string') {
    const level = Number(raw)
    return { level: Number.isFinite(level) ? clamp01(level) : fallback, effects: [] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { level: fallback, effects: [] }
  }
  const rawLevel = Number(raw.level)
  const level = Number.isFinite(rawLevel) ? clamp01(rawLevel) : fallback
  const effects = Array.isArray(raw.effects)
    ? raw.effects.filter((effect) => effect && typeof effect === 'object' && typeof effect.type === 'string')
    : []
  return { level, effects }
}

/** 规范化两条返回总线（旧数字结构自动升级为 {level, effects: []}）。 */
export function normalizeBuses(raw) {
  const buses = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    reverb: normalizeBus(buses.reverb, BUS_DEFAULTS.reverb.level),
    delay: normalizeBus(buses.delay, BUS_DEFAULTS.delay.level),
  }
}

/**
 * 侧链 duck 包络（纯函数，可用 mock AudioParam 单测）：
 * - atTime 起用 setTargetAtTime 压到 1-amount（timeConstant ≈ attack/3，attack 内基本到位）；
 * - atTime+attack 起用 setTargetAtTime 平滑回 1（timeConstant = release，符合压缩器 release 语义，
 *   保证 kick 后 50–150ms 有可测凹陷/泵感）。
 * amount<=0 或参数非法时 no-op（返回 false）。
 */
export function scheduleDuckEnvelope(param, atTime, amount, attack, release, now = 0) {
  if (!param || typeof param.setTargetAtTime !== 'function') return false
  const depth = clamp01(amount)
  if (!(depth > 0.0001)) return false
  const attackSeconds = clamp(Number(attack) || 0, 0.001, 0.2)
  const releaseSeconds = clamp(Number(release) || 0, 0.02, 1)
  const start = Math.max(Number(now) || 0, Number(atTime) || 0)
  try {
    param.setTargetAtTime(1 - depth, start, Math.max(0.0005, attackSeconds / 3))
    param.setTargetAtTime(1, start + attackSeconds, Math.max(0.01, releaseSeconds))
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------------- */
/* R4c：实时电平表数值（getMeters，只读；复用现有 analyser，不新增节点）          */
/* ------------------------------------------------------------------------- */

/** 线性 0..1 → dB（0 → -120；钳制 -120..0）。 */
export function meterDbFromLinear(value) {
  const linear = clamp01(Number(value) || 0)
  if (linear <= 0) return -120
  return Math.max(-120, Math.min(0, 20 * Math.log10(linear)))
}

/** 近似 LUFS（省略 K-weighting；Master 顶栏 LUFS≈ 用）：-0.691 + 20log10(rms)，静音 -120。 */
export function lufsApproxFromRms(rms) {
  const linear = clamp01(Number(rms) || 0)
  if (linear <= 0) return -120
  return Math.max(-120, Math.min(0, -0.691 + 20 * Math.log10(linear)))
}

/**
 * 从 AnalyserNode 的时域数据读取 rms/peak（只读）。
 * 支持 float 时域；仅有 byte 时域时按 (v-128)/128 还原；无 analyser/异常 → {0,0}。
 * 不创建节点、不写 AudioParam，可安全在动画帧中调用。
 */
export function readAnalyserTimeStats(analyser, scratch) {
  if (!analyser || !scratch) return { rms: 0, peak: 0 }
  try {
    if (typeof analyser.getFloatTimeDomainData === 'function') {
      analyser.getFloatTimeDomainData(scratch)
    } else if (typeof analyser.getByteTimeDomainData === 'function') {
      const bytes = new Uint8Array(scratch.length)
      analyser.getByteTimeDomainData(bytes)
      for (let i = 0; i < bytes.length; i++) scratch[i] = (bytes[i] - 128) / 128
    } else {
      return { rms: 0, peak: 0 }
    }
  } catch {
    return { rms: 0, peak: 0 }
  }
  let sum = 0
  let peak = 0
  for (let i = 0; i < scratch.length; i++) {
    const value = scratch[i]
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    sum += value * value
  }
  return { rms: Math.sqrt(sum / Math.max(1, scratch.length)), peak }
}

/** {rms,peak} → 表值（钳制 0..1，输出 rmsDb/peakDb，静音 -120）。 */
export function meterSnapshot(stats) {
  const rms = clamp01(Number(stats?.rms) || 0)
  const peak = clamp01(Number(stats?.peak) || 0)
  return { rms, rmsDb: meterDbFromLinear(rms), peak, peakDb: meterDbFromLinear(peak) }
}

/** 无图/未解锁时的空表：当前工程每轨 + 每组 + master 全部 0/-120。 */
export function emptyMeters(project) {
  const tracks = {}
  for (const track of project?.tracks ?? []) {
    if (track?.id) tracks[track.id] = meterSnapshot({ rms: 0, peak: 0 })
  }
  const groups = {}
  for (const group of normalizeEngineGroups(project?.groups)) {
    groups[group.id] = meterSnapshot({ rms: 0, peak: 0 })
  }
  return {
    tracks,
    groups,
    master: { ...meterSnapshot({ rms: 0, peak: 0 }), lufsApprox: -120 },
  }
}

/**
 * R4c：组电平表（只读，不新增 analyser 节点）——由组内轨道的 analyser 表值聚合：
 * - 组 mute / 未 solo 命中（groupGainFor=0）→ 全部 0/-120；
 * - 否则组内轨道 rms 按能量相加（sqrt(Σ(rms×组增益)²)）、peak 取最大后乘组增益；
 * - 组 FX 的增益/滤波不在近似内（无组 analyser，保持「不新增节点」）。
 * @param {{tracks?:object[], groups?:object[]}} project
 * @param {Record<string,{rms:number,peak:number}>} trackMeters
 * @returns {Record<string,{rms:number,rmsDb:number,peak:number,peakDb:number}>}
 */
export function aggregateGroupMeters(project, trackMeters) {
  const groups = normalizeEngineGroups(project?.groups)
  const out = {}
  for (const group of groups) {
    const groupGain = groupGainFor(project, group)
    if (!(groupGain > 0)) {
      out[group.id] = meterSnapshot({ rms: 0, peak: 0 })
      continue
    }
    let energy = 0
    let peak = 0
    for (const track of project?.tracks ?? []) {
      if (resolveTrackGroupId(project, track, groups) !== group.id) continue
      const meter = trackMeters?.[track.id]
      if (!meter) continue
      const rms = clamp01(Number(meter.rms) || 0) * groupGain
      const trackPeak = clamp01(Number(meter.peak) || 0) * groupGain
      energy += rms * rms
      if (trackPeak > peak) peak = trackPeak
    }
    out[group.id] = meterSnapshot({ rms: Math.sqrt(energy), peak })
  }
  return out
}

/** FX 链结构签名：vst3 额外包含 pluginId（换插件必须重建图；参数变化走 update）。 */
function fxSignature(effects) {
  return (Array.isArray(effects) ? effects : [])
    .map((effect) => (effect?.type === 'vst3' ? `${effect?.id}:vst3:${effect?.vst3?.pluginId ?? ''}` : `${effect?.id}:${effect?.type}`))
    .join(',')
}

/**
 * 图结构签名：变了才需要重建音频图；参数/音量/发送/总线电平变化可以原地 update。
 * 返回总线 FX 链的 id/type 纳入签名（链变化才重建图，参数变化走 update）。
 */
export function graphSignature(project) {
  const parts = []
  for (const track of project?.tracks ?? []) {
    const fx = fxSignature(track?.effects)
    const freeze = track?.freeze && typeof track.freeze === 'object'
      ? `fz:${track.freeze.hash ?? ''}|${track.freeze.mediaId ?? ''}|${track.freeze.stale === true ? 1 : 0}|fx:${track.freeze.includesFx === true ? 1 : 0}`
      : 'fz:'
    parts.push(
      `${track?.id}|${track?.kind}|${track?.engine ?? 'sampler'}|${track?.instrument?.preset ?? ''}|${track?.instrument?.kit ?? ''}|vst3:${track?.vst3?.pluginId ?? ''}|${freeze}|${fx}|out:${track?.output ?? ''}|${trackRoutingSignature(track)}`,
    )
  }
  const masterFx = fxSignature(project?.master?.effects)
  parts.push(`master|${masterFx}`)
  const buses = normalizeBuses(project?.buses)
  const busFx = (bus) => fxSignature(bus?.effects)
  parts.push(`buses|${busFx(buses.reverb)}|${busFx(buses.delay)}`)
  // R4a：group 集合与 FX 链结构纳入签名（level/mute/solo 走 update 原地更新）
  const groups = normalizeEngineGroups(project?.groups)
  const groupParts = groups
    .map(
      (group) =>
        `${group.id}|${fxSignature(group.effects)}|${groupRoutingSignature(group)}`,
    )
    .join(';')
  parts.push(`groups|${groupParts}`)
  return parts.join(';')
}

/** 创建一个简单的 send 总线声像/宽度（预留）。 */
function createBusReturn(ctx, gainValue, destination) {
  const gain = ctx.createGain()
  gain.gain.value = gainValue
  gain.connect(destination)
  return gain
}

/**
 * 混响返回总线：输入 → Convolver(程序化 IR) → bus FX 链 → 返回增益 → master。
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination 通常 masterIn
 * @param {{level:number,effects:object[]}|number} bus 新结构或旧数字（防御性 normalize）
 */
function buildReverbBus(ctx, destination, bus, options = {}) {
  const spec = normalizeBus(bus, BUS_DEFAULTS.reverb.level)
  const input = ctx.createGain()
  const output = createBusReturn(ctx, busReturnGain(spec.level), destination)
  const convolver = ctx.createConvolver()
  convolver.normalize = true
  try {
    convolver.buffer = makeImpulseResponse(ctx, { size: 0.62, decay: 0.6, damp: 0.34 })
  } catch {
    /* ignore */
  }
  const fx = buildFxChainWithExternal(ctx, spec.effects, { ...options, target: 'bus' })
  input.connect(convolver)
  convolver.connect(fx.input)
  fx.output.connect(output)
  return {
    input,
    output,
    convolver,
    fx,
    bus: spec,
    setLevel(nextLevel) {
      try {
        output.gain.setTargetAtTime(busReturnGain(nextLevel), Number(ctx.currentTime) || 0, 0.03)
      } catch {
        output.gain.value = busReturnGain(nextLevel)
      }
    },
    dispose() {
      try {
        fx.dispose()
      } catch {
        /* ignore */
      }
      try {
        input.disconnect()
      } catch {
        /* ignore */
      }
      try {
        output.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * 延迟返回总线：输入 → 反馈延迟网络(附点八分) → bus FX 链 → 返回增益 → master。
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination 通常 masterIn
 * @param {{level:number,effects:object[]}|number} bus 新结构或旧数字
 * @param {number} bpm
 */
function buildDelayBus(ctx, destination, bus, bpm, options = {}) {
  const spec = normalizeBus(bus, BUS_DEFAULTS.delay.level)
  const input = ctx.createGain()
  const output = createBusReturn(ctx, busReturnGain(spec.level), destination)
  const delay = ctx.createDelay(3)
  const feedback = ctx.createGain()
  const damp = ctx.createBiquadFilter()
  damp.type = 'lowpass'
  damp.frequency.value = 4200
  delay.delayTime.value = Math.min(2, Math.max(0.05, (60 / clamp(bpm, 40, 200)) * 0.75))
  feedback.gain.value = 0.36
  const fx = buildFxChainWithExternal(ctx, spec.effects, { ...options, target: 'bus' })
  input.connect(delay)
  delay.connect(damp)
  damp.connect(feedback)
  feedback.connect(delay)
  delay.connect(fx.input)
  fx.output.connect(output)
  return {
    input,
    output,
    delay,
    fx,
    bus: spec,
    setLevel(nextLevel) {
      try {
        output.gain.setTargetAtTime(busReturnGain(nextLevel), Number(ctx.currentTime) || 0, 0.03)
      } catch {
        output.gain.value = busReturnGain(nextLevel)
      }
    },
    setBpm(nextBpm) {
      try {
        delay.delayTime.setTargetAtTime(
          Math.min(2, Math.max(0.05, (60 / clamp(nextBpm, 40, 200)) * 0.75)),
          Number(ctx.currentTime) || 0,
          0.05,
        )
      } catch {
        /* ignore */
      }
    },
    dispose() {
      try {
        fx.dispose()
      } catch {
        /* ignore */
      }
      try {
        input.disconnect()
      } catch {
        /* ignore */
      }
      try {
        output.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * 构建整首混音图。
 *
 * @param {BaseAudioContext} ctx
 * @param {object} project 项目 JSON
 * @param {{analysers?:boolean, renderFade?:number}} opts
 *        analysers=false 用于离线渲染省节点；renderFade=秒数时给 master 加淡入淡出。
 * @returns {object} graph
 */
export function buildMixGraph(ctx, project, opts = {}) {
  const useAnalysers = opts.analysers !== false
  const currentProject = project ?? { tracks: [], master: { volume: 0.82, effects: [] }, buses: {} }
  // v2.2 M2：外部 VST3 实时效果器（AudioWorklet 只在实时 ctx 可用；离线渲染强制降级直通 + warning）
  const externalNodes = []
  const instrumentNodes = []
  const warnings = Array.isArray(opts.warnings) ? opts.warnings : []
  const fxOptions = {
    workletReady: opts.workletReady === true,
    warnings,
    externalNodes,
    getApi: opts.getApi,
    AudioWorkletNode: opts.AudioWorkletNode,
    ringFrames: opts.ringFrames,
    channels: opts.channels,
    pumpIntervalMs: opts.pumpIntervalMs,
    paramThrottleMs: opts.paramThrottleMs,
  }

  // ---- master 链 ---------------------------------------------------------
  const masterIn = ctx.createGain()
  const masterFx = buildFxChainWithExternal(ctx, currentProject?.master?.effects ?? [], { ...fxOptions, target: 'master' })
  const masterVol = ctx.createGain()
  masterVol.gain.value = masterGainFor(currentProject)
  // 导出淡入/淡出用的独立节点：master 音量自动化与淡入淡出互不覆盖
  const fadeVol = ctx.createGain()
  fadeVol.gain.value = 1
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -2.5
  limiter.knee.value = 1
  limiter.ratio.value = 20
  limiter.attack.value = 0.002
  limiter.release.value = 0.12
  let masterAnalyser = null
  masterIn.connect(masterFx.input)
  masterFx.output.connect(masterVol)
  masterVol.connect(fadeVol)
  fadeVol.connect(limiter)
  if (useAnalysers) {
    masterAnalyser = ctx.createAnalyser()
    masterAnalyser.fftSize = 1024
    masterAnalyser.smoothingTimeConstant = 0.72
    limiter.connect(masterAnalyser)
    masterAnalyser.connect(ctx.destination)
  } else {
    limiter.connect(ctx.destination)
  }

  // ---- 两条发送总线（旧数字 buses 防御性升级为 {level, effects}）---------
  const buses = normalizeBuses(currentProject?.buses)
  const reverbBus = buildReverbBus(ctx, masterIn, buses.reverb, fxOptions)
  const delayBus = buildDelayBus(ctx, masterIn, buses.delay, delayBusBpmFor(currentProject), fxOptions)

  // ---- R4a/R4b：group bus（groupInput → FX/直通 → level → [PDC] → masterIn）--
  const groupSpecs = normalizeEngineGroups(currentProject?.groups)
  const groups = new Map()
  for (const spec of groupSpecs) {
    const input = ctx.createGain()
    const groupFx = buildFxChainWithExternal(ctx, spec.effects ?? [], { ...fxOptions, target: 'group' })
    const bypassFx = spec.bypassFx === true
    let dryGroup = null
    let afterFx
    if (bypassFx) {
      dryGroup = ctx.createGain()
      input.connect(dryGroup)
      afterFx = dryGroup
    } else {
      input.connect(groupFx.input)
      afterFx = groupFx.output
    }
    const level = ctx.createGain()
    level.gain.value = groupGainFor(currentProject, spec)
    afterFx.connect(level)
    const pdcMs = normalizePdcMs(spec.pdcMs)
    let pdcDelay = null
    let outputNode = level
    if (pdcMs > 0) {
      pdcDelay = ctx.createDelay(0.5)
      pdcDelay.delayTime.value = pdcMs / 1000
      level.connect(pdcDelay)
      outputNode = pdcDelay
    }
    outputNode.connect(masterIn)
    groups.set(spec.id, {
      id: spec.id,
      spec,
      input,
      fx: groupFx,
      level,
      bypassFx,
      dry: dryGroup,
      pdcDelay,
      outputNode,
      /** 组电平/静音/独奏合并后的线性增益（level*mute/solo 因子）。 */
      setGain(value, time) {
        return scheduleAudioParamValue(level.gain, value, time, Number(ctx.currentTime) || 0)
      },
      /** R4b：组手动 PDC（ms → DelayNode.delayTime，实时平滑 / 离线排程）。 */
      setPdc(nextPdcMs, time) {
        if (!pdcDelay) return false
        return scheduleAudioParamValue(
          pdcDelay.delayTime,
          normalizePdcMs(nextPdcMs) / 1000,
          time,
          Number(ctx.currentTime) || 0,
        )
      },
      /** 原地更新组参数（FX 参数/level/mute/solo/pdc；结构变化由签名触发重建）。 */
      update(nextSpec) {
        this.spec = nextSpec
        this.setGain(groupGainFor(graph.project, nextSpec))
        this.setPdc(nextSpec.pdcMs)
        try {
          groupFx.update(nextSpec.effects ?? [])
        } catch {
          /* ignore */
        }
      },
      dispose() {
        try {
          groupFx.dispose()
        } catch {
          /* ignore */
        }
        for (const node of [input, dryGroup, level, pdcDelay]) {
          try {
            node?.disconnect()
          } catch {
            /* ignore */
          }
        }
      },
    })
  }

  // ---- 每轨通道 ----------------------------------------------------------
  const tracks = new Map()
  const frozenTracks = []
  for (const track of currentProject?.tracks ?? []) {
    const input = ctx.createGain()
    // v2.2 M4：冻结轨用缓存 WAV（engine 调度）替代外部节点 + 轨道 FX；仍走 trackGain/pan/duck/sends/group。
    const frozen = isFrozenTrack(track)
    const frozenInfo = frozen ? frozenTrackInfo(track) : null
    if (frozen && !frozenMediaEntry(currentProject, track)) {
      warnings.push({
        code: 'freeze-media-missing',
        message: '冻结缓存缺少 media 条目，无法播放，请重新冻结',
        trackId: track?.id ?? null,
      })
    }
    if (frozenInfo) frozenTracks.push({ ...frozenInfo, trackId: track.id })
    // M4 B 方案：host 首版冻结缓存只含外部插件（includesFx:false）→ 保留轨道内置 FX，仅 bypass 外部节点；
    // 若 host 将来把内置 FX 也渲染进缓存（includesFx:true）→ 整条 FX 链 bypass。
    const freezeIncludesFx = frozen && track?.freeze?.includesFx === true
    const frozenBuiltInEffects = frozen && !freezeIncludesFx
      ? (track?.effects ?? []).filter((effect) => effect && effect.type !== 'vst3')
      : []
    // v2.2 M3：VST3 instrument 轨 → ExternalInstrumentNode（无采样器 voice；MIDI 由 engine 写入）
    let externalInstrument = null
    if (!frozen && isExternalInstrumentTrack(track)) {
      externalInstrument = createExternalInstrumentNode(ctx, track, {
        ...fxOptions,
        target: 'instrument',
        trackId: track.id,
      })
      try {
        externalInstrument.output?.connect?.(input)
      } catch {
        /* ignore */
      }
      if (Array.isArray(instrumentNodes)) instrumentNodes.push(externalInstrument)
    }
    if (frozen) {
      // host 冻结整轨外部插件链（instrument → 所有 VST3 effect）；M4 首版 includesFx=false，内置 FX 由 audio 后处理。
    }
    const gain = ctx.createGain()
    gain.gain.value = trackAudibleGain(currentProject, track)
    // 侧链 ducking：track gain 之后、FX 之前（音量后乘 duck，不影响 master/发送总线）
    const duck = ctx.createGain()
    duck.gain.value = 1
    const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null
    if (panner) panner.pan.value = clamp(Number(track.pan) || 0, -1, 1)
    const fx = buildFxChainWithExternal(
      ctx,
      frozen ? frozenBuiltInEffects : track?.effects ?? [],
      { ...fxOptions, target: 'track', trackId: track?.id },
    )

    // R4b：发送模式 / bypass / 相位 / mono / PDC
    const sendMode = normalizeSendMode(track?.sendMode)
    const bypassFx = freezeIncludesFx || track?.bypassFx === true
    const mono = track?.mono === true
    const phaseInvert = track?.phaseInvert === true
    const pdcMs = normalizePdcMs(track?.pdcMs)

    input.connect(gain)
    gain.connect(duck)
    // FX 前、轨道音量后（pre 发送点）
    const preFx = ctx.createGain()
    if (panner) {
      duck.connect(panner)
      panner.connect(preFx)
    } else {
      duck.connect(preFx)
    }

    // FX 链或直通（bypassFx）；R5b：synth 轨可插入 instrumentFilter（voice→filter→track FX）
    const filterSettings = freezeIncludesFx ? null : instrumentFilterSettings(track)
    let instrumentFilter = null
    let dry = null
    let postFx
    if (bypassFx) {
      dry = ctx.createGain()
      preFx.connect(dry)
      postFx = dry
    } else {
      if (filterSettings) {
        instrumentFilter = ctx.createBiquadFilter()
        instrumentFilter.type = 'lowpass'
        instrumentFilter.frequency.value = clamp(filterSettings.cutoff, 100, 20000)
        instrumentFilter.Q.value = clamp(filterSettings.q, 0.1, 12)
        preFx.connect(instrumentFilter)
        instrumentFilter.connect(fx.input)
      } else {
        preFx.connect(fx.input)
      }
      postFx = fx.output
    }

    let analyser = null
    let scratch = null
    if (useAnalysers) {
      analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      scratch = new Float32Array(analyser.fftSize)
      postFx.connect(analyser)
      postFx = analyser
    }

    const sendReverb = ctx.createGain()
    const sends = track?.sends ?? {}
    sendReverb.gain.value = clamp01(sends.reverb) * 0.95
    const sendDelay = ctx.createGain()
    sendDelay.gain.value = clamp01(sends.delay) * 0.95

    // 发送点：pre = FX 前（track 音量后）；post = FX 后（现状）
    const sendSource = sendMode === 'pre' ? preFx : postFx
    sendSource.connect(sendReverb)
    sendReverb.connect(reverbBus.input)
    sendSource.connect(sendDelay)
    sendDelay.connect(delayBus.input)

    // 相位反相（postFx 后、PDC 前）
    const phase = ctx.createGain()
    phase.gain.value = phaseGainFor(track)
    postFx.connect(phase)
    let outputNode = phase
    // 单声道下混：GainNode explicit mono（Chrome 按 0.5*(L+R) 下混，再上混回双声道）
    let monoNode = null
    if (mono) {
      monoNode = ctx.createGain()
      try {
        monoNode.channelCount = 1
        monoNode.channelCountMode = 'explicit'
        monoNode.channelInterpretation = 'speakers'
      } catch {
        /* 平台不支持时退化为立体声（不崩） */
      }
      phase.connect(monoNode)
      outputNode = monoNode
    }
    // 手动 PDC：最终路由（group/master）前插 DelayNode
    let pdcDelay = null
    if (pdcMs > 0) {
      pdcDelay = ctx.createDelay(0.5)
      pdcDelay.delayTime.value = pdcMs / 1000
      outputNode.connect(pdcDelay)
      outputNode = pdcDelay
    }

    // R4a：track 输出 → 目标 groupInput（无 output/master → masterIn）
    const outputGroupId = resolveTrackGroupId(currentProject, track, groupSpecs)
    const trackDestination = outputGroupId ? groups.get(outputGroupId)?.input ?? masterIn : masterIn
    outputNode.connect(trackDestination)

    tracks.set(track.id, {
      track,
      outputGroupId,
      input,
      externalInstrument,
      frozen,
      frozenInfo,
      freezeIncludesFx,
      gain,
      duck,
      panner,
      preFx,
      fx,
      dry,
      instrumentFilter,
      filterSettings,
      postFx,
      analyser,
      scratch,
      sendReverb,
      sendDelay,
      sendMode,
      bypassFx,
      phase,
      phaseInvert,
      monoNode,
      bypassMono: mono,
      pdcDelay,
      pdcMs,
      outputNode,
    })
  }

  // ---- 电平表 ------------------------------------------------------------
  const levels = new Map() // key -> 平滑后的 0..1 电平
  const masterScratch = useAnalysers && masterAnalyser ? new Float32Array(masterAnalyser.fftSize) : null

  function readRms(analyser, scratch) {
    return readAnalyserTimeStats(analyser, scratch).rms
  }

  function smoothLevel(key, rms) {
    const cur = rmsToLevel(rms)
    const prev = levels.get(key) ?? 0
    // 起音快、释放慢：电平表不抖
    const next = cur >= prev ? prev + (cur - prev) * 0.65 : prev * 0.86 + cur * 0.14
    const clamped = clamp(next, 0, 1)
    levels.set(key, clamped)
    return clamped
  }

  const graph = {
    ctx,
    project: currentProject,
    tracks,
    masterIn,
    masterFx,
    masterVol,
    fadeVol,
    limiter,
    masterAnalyser,
    reverbBus,
    delayBus,
    buses,
    groups,
    warnings,
    externalNodes,
    instrumentNodes,
    frozenTracks,
    masterGainValue: masterVol.gain.value,

    /** v2.2 M4：冻结轨状态（只读，UI 显示 current/stale；动作由 host 负责）。 */
    getFreezeStatus() {
      return {
        tracks: [...tracks.values()].map((entry) => {
          const info = entry.frozenInfo
          return {
            trackId: entry.track?.id ?? null,
            frozen: entry.frozen === true,
            status: info?.status ?? freezeStatusOf(entry.track),
            hash: info?.hash ?? '',
            mediaId: info?.mediaId ?? '',
            cachedAt: info?.cachedAt ?? null,
            error: info?.error ?? '',
          }
        }),
      }
    },

    /** 冻结轨（engine 实时/离线调度缓存 WAV 用）。 */
    getFrozenTracks() {
      return frozenTracks.map((item) => ({ ...item }))
    },

    /** v2.2 M2/M3：列出外部 effect + instrument 状态（UI/engine 只读轮询用）。 */
    listExternalInstruments() {
      return instrumentNodes.map((node) => {
        let status = {}
        try {
          status = node.status ? node.status() : {}
        } catch {
          status = { error: '无法读取外部乐器状态' }
        }
        return {
          ...status,
          kind: 'instrument',
          trackId: node.trackId ?? status.trackId ?? null,
          pluginId: node.pluginId ?? status.pluginId ?? null,
          target: node.target ?? 'instrument',
          degraded: node.degraded === true || status.degraded === true,
          ...this.getTrackFreezeFields(node.trackId ?? status.trackId),
        }
      })
    },

    /** 所有外部实例（effect + instrument）。 */
    listExternalPlugins() {
      return [...this.listExternalEffects(), ...this.listExternalInstruments()]
    },

    /** 按实例 id 查外部 effect 或 instrument 状态。 */
    getExternalPluginStatus(instanceId) {
      const id = String(instanceId ?? '')
      return this.listExternalPlugins().find((item) => item.instanceId === id) ?? null
    },

    /** 查找外部 effect/instrument 节点（engine 设置参数/旁路用）。 */
    findExternalPlugin(instanceId) {
      const id = String(instanceId ?? '')
      return (
        externalNodes.find((node) => node.instanceId === id) ??
        instrumentNodes.find((node) => node.instanceId === id) ??
        null
      )
    },

    /** v2.2 M2/M3：实时参数（节流，不进 undo）；支持 effect 与 instrument。 */
    setExternalPluginParam(instanceId, paramId, value) {
      const node = this.findExternalPlugin(instanceId)
      if (!node || !node.bridge) return false
      return node.bridge.setParam(paramId, value)
    },

    /** v2.2 M2/M3：实时旁路（worklet 直通/静音，不改工程模型）。 */
    setExternalPluginBypass(instanceId, bypass) {
      const node = this.findExternalPlugin(instanceId)
      if (!node) return false
      if (node.bridge) return node.bridge.setBypass(bypass === true)
      return false
    },

    /** 外部 effect 实例状态（兼容 M2 名称）。 */
    listExternalEffects() {
      return externalNodes.map((node) => {
        let status = {}
        try {
          status = node.status ? node.status() : {}
        } catch {
          status = { error: '无法读取外部插件状态' }
        }
        return {
          ...status,
          effectId: node.effectId ?? status.effectId ?? null,
          pluginId: node.pluginId ?? status.pluginId ?? null,
          trackId: node.trackId ?? status.trackId ?? null,
          target: node.target ?? status.target ?? 'track',
          degraded: node.degraded === true || status.degraded === true,
          ...this.getTrackFreezeFields(node.trackId ?? status.trackId),
        }
      })
    },

    /** 外部项附带其轨道的冻结字段（UI 通道/面板只读显示）。 */
    getTrackFreezeFields(trackId) {
      const entry = trackId ? tracks.get(trackId) : null
      if (!entry) return {}
      const info = entry.frozenInfo
      return {
        frozen: entry.frozen === true,
        freezeStatus: info?.status ?? freezeStatusOf(entry.track),
        freezeHash: info?.hash ?? '',
        freezeMediaId: info?.mediaId ?? '',
        freezeCachedAt: info?.cachedAt ?? null,
        freezeIncludesFx: info?.includesFx === true,
      }
    },

    /** 按实例 id 查外部效果器状态。 */
    getExternalEffectStatus(instanceId) {
      const id = String(instanceId ?? '')
      return this.listExternalEffects().find((item) => item.instanceId === id) ?? null
    },

    /** 查找外部效果器节点（engine 设置参数/旁路用）。 */
    findExternalEffect(instanceId) {
      const id = String(instanceId ?? '')
      return externalNodes.find((node) => node.instanceId === id) ?? null
    },

    /** v2.2 M2：实时参数（节流，不进 undo）。 */
    setExternalEffectParam(instanceId, paramId, value) {
      const node = this.findExternalEffect(instanceId)
      if (!node || !node.bridge) return false
      return node.bridge.setParam(paramId, value)
    },

    /** v2.2 M2：实时旁路（worklet 直通，不改工程模型）。 */
    setExternalEffectBypass(instanceId, bypass) {
      const node = this.findExternalEffect(instanceId)
      if (!node) return false
      if (node.bridge) return node.bridge.setBypass(bypass === true)
      return false
    },

    /** 外部 effect/instrument 总计（UI 判断「外部插件仅桌面版」/降级状态）。 */
    getExternalSummary() {
      const items = this.listExternalPlugins()
      return {
        count: items.length,
        effectCount: items.filter((item) => item.kind !== 'instrument').length,
        instrumentCount: items.filter((item) => item.kind === 'instrument').length,
        loaded: items.filter((item) => item.loaded === true).length,
        degraded: items.filter((item) => item.degraded === true).length,
        underrun: items.reduce((sum, item) => sum + (Number(item.underrun) || 0), 0),
        maxLatencyMs: items.reduce((max, item) => Math.max(max, Number(item.latencyMs) || 0), 0),
      }
    },

    // ---- 自动化参数写入（CONTRACT-P2 §4）------------------------------------
    // 实时：省略 time，用 setTargetAtTime 平滑；离线：传 time（秒）排程 ramp。
    // 找不到轨道/节点时安全 no-op（返回 false）。

    setTrackVolume(trackId, value, time) {
      const entry = tracks.get(trackId)
      if (!entry) return false
      // v2.1 P0-5：value 为「已乘 track.volume」的 effective volume（由 engine 自动化排程/实时目标统一给出）；
      // 静态音量仍由 trackAudibleGain(graph.project, track) 初始化。
      const gainValue = trackGainForValue(graph.project, entry.track, value)
      return scheduleAudioParamValue(entry.gain.gain, gainValue, time, Number(ctx.currentTime) || 0)
    },

    setTrackPan(trackId, pan, time) {
      const entry = tracks.get(trackId)
      if (!entry || !entry.panner) return false
      return scheduleAudioParamValue(entry.panner.pan, clamp(Number(pan) || 0, -1, 1), time, Number(ctx.currentTime) || 0)
    },

    /** 作用在该轨效果器链第一个 type==='filter' 的 cutoff；无 filter 时安全 no-op。 */
    setTrackCutoff(trackId, hz) {
      const entry = tracks.get(trackId)
      if (!entry) return false
      const wrapper = findFirstFilterEffect(entry.fx)
      if (!wrapper) return false
      const cutoff = clamp(Number(hz) || 0, 80, 16000)
      try {
        wrapper.update({ ...(wrapper._params ?? {}), cutoff }, wrapper._enabled !== false)
        return true
      } catch {
        return false
      }
    },

    setMasterVolume(value, time) {
      const gainValue = Math.pow(clamp01(value), 1.2)
      return scheduleAudioParamValue(masterVol.gain, gainValue, time, Number(ctx.currentTime) || 0)
    },

    // ---- 侧链 ducking（CONTRACT-P2B §4）------------------------------------
    /** atTime 时把该轨 duck 压到 1-amount（attack），随后按 release 平滑回 1。 */
    scheduleDuck(trackId, atTime, amount, attack, release) {
      const entry = tracks.get(trackId)
      if (!entry || !entry.duck) return false
      return scheduleDuckEnvelope(entry.duck.gain, atTime, amount, attack, release, Number(ctx.currentTime) || 0)
    },

    /** 快速设置 duck 增益（停止/关闭侧链时回 1）。 */
    setDuckGain(trackId, value) {
      const entry = tracks.get(trackId)
      if (!entry || !entry.duck) return false
      const target = clamp01(value)
      try {
        entry.duck.gain.setTargetAtTime(target, Number(ctx.currentTime) || 0, 0.02)
        return true
      } catch {
        try {
          entry.duck.gain.value = target
        } catch {
          /* ignore */
        }
        return false
      }
    },

    /** 更新参数（图结构不变时调用）。 */
    update(nextProject) {
      const p = nextProject ?? graph.project
      graph.project = p
      graph.masterGainValue = masterGainFor(p)
      const now = Number(ctx.currentTime) || 0
      try {
        masterVol.gain.setTargetAtTime(graph.masterGainValue, now, 0.02)
      } catch {
        masterVol.gain.value = graph.masterGainValue
      }
      try {
        masterFx.update(p?.master?.effects ?? [])
      } catch {
        /* ignore */
      }
      // 返回总线：level 平滑更新 + bus FX 链参数更新（与 master FX 同方式）
      const buses = normalizeBuses(p?.buses)
      graph.buses = buses
      reverbBus.bus = buses.reverb
      delayBus.bus = buses.delay
      reverbBus.setLevel(buses.reverb.level)
      delayBus.setLevel(buses.delay.level)
      try {
        reverbBus.fx.update(buses.reverb.effects)
      } catch {
        /* ignore */
      }
      try {
        delayBus.fx.update(buses.delay.effects)
      } catch {
        /* ignore */
      }
      delayBus.setBpm(delayBusBpmFor(p))
      // R4a：group level/mute/solo + group FX 参数原地更新（结构变化由 graphSignature 触发重建）
      const nextGroups = normalizeEngineGroups(p?.groups)
      for (const [id, entry] of groups) {
        const spec = nextGroups.find((item) => item.id === id)
        if (!spec) {
          entry.setGain(0)
          continue
        }
        try {
          entry.update(spec)
        } catch {
          /* ignore */
        }
      }
      for (const [id, entry] of tracks) {
        const track = (p?.tracks ?? []).find((t) => t?.id === id)
        if (!track) {
          try {
            entry.gain.gain.setTargetAtTime(0, now, 0.02)
          } catch {
            /* ignore */
          }
          continue
        }
        entry.track = track
        try {
          entry.gain.gain.setTargetAtTime(trackAudibleGain(p, track), now, 0.02)
        } catch {
          entry.gain.gain.value = trackAudibleGain(p, track)
        }
        // 恢复 duck 到 1（停止/暂停/关闭侧链后不残留半路音量）
        if (entry.duck) {
          try {
            entry.duck.gain.setTargetAtTime(1, now, 0.02)
          } catch {
            try {
              entry.duck.gain.value = 1
            } catch {
              /* ignore */
            }
          }
        }
        if (entry.panner) {
          try {
            entry.panner.pan.setTargetAtTime(clamp(Number(track.pan) || 0, -1, 1), now, 0.02)
          } catch {
            entry.panner.pan.value = clamp(Number(track.pan) || 0, -1, 1)
          }
        }
        try {
          entry.sendReverb.gain.setTargetAtTime(clamp01(track?.sends?.reverb) * 0.95, now, 0.02)
          entry.sendDelay.gain.setTargetAtTime(clamp01(track?.sends?.delay) * 0.95, now, 0.02)
        } catch {
          /* ignore */
        }
        // R5b：instrumentFilter 参数平滑更新（节点存在性入签名，结构变化才重建）
        if (entry.instrumentFilter) {
          const filterSettings = instrumentFilterSettings(track)
          if (filterSettings) {
            try {
              entry.instrumentFilter.frequency.setTargetAtTime(clamp(filterSettings.cutoff, 100, 20000), now, 0.02)
              entry.instrumentFilter.Q.setTargetAtTime(clamp(filterSettings.q, 0.1, 12), now, 0.02)
            } catch {
              try {
                entry.instrumentFilter.frequency.value = clamp(filterSettings.cutoff, 100, 20000)
                entry.instrumentFilter.Q.value = clamp(filterSettings.q, 0.1, 12)
              } catch {
                /* ignore */
              }
            }
          }
        }
        // R4b：相位反相 / PDC 参数平滑更新（结构开关由签名触发重建）
        try {
          entry.phase.gain.setTargetAtTime(phaseGainFor(track), now, 0.02)
        } catch {
          try {
            entry.phase.gain.value = phaseGainFor(track)
          } catch {
            /* ignore */
          }
        }
        if (entry.pdcDelay) {
          try {
            entry.pdcDelay.delayTime.setTargetAtTime(normalizePdcMs(track?.pdcMs) / 1000, now, 0.02)
          } catch {
            try {
              entry.pdcDelay.delayTime.value = normalizePdcMs(track?.pdcMs) / 1000
            } catch {
              /* ignore */
            }
          }
        }
        try {
          entry.fx.update(track?.effects ?? [])
        } catch {
          /* ignore */
        }
        try {
          entry.externalInstrument?.update?.(track)
        } catch {
          /* ignore */
        }
      }
    },

    /** 实时电平：{ master: 0..1, tracks: { [trackId]: 0..1 } }。 */
    getLevels() {
      const tracksOut = {}
      for (const [id, entry] of tracks) {
        tracksOut[id] = smoothLevel(id, readRms(entry.analyser, entry.scratch))
      }
      const master = smoothLevel('__master__', readRms(masterAnalyser, masterScratch))
      return { master, tracks: tracksOut }
    },

    /**
     * R4c 实时电平表数值（只读）：复用现有 analyser，不新增节点/不改声音。
     * groups 由组内轨道表值聚合（见 aggregateGroupMeters），不新增组 analyser。
     * @returns {{tracks: Record<string,{rms:number,rmsDb:number,peak:number,peakDb:number}>,
     *   groups: Record<string,{rms:number,rmsDb:number,peak:number,peakDb:number}>,
     *   master:{rms:number,rmsDb:number,peak:number,peakDb:number,lufsApprox:number}>}}
     */
    getMeters() {
      const tracksOut = {}
      for (const [id, entry] of tracks) {
        tracksOut[id] = meterSnapshot(readAnalyserTimeStats(entry.analyser, entry.scratch))
      }
      const masterStats = readAnalyserTimeStats(masterAnalyser, masterScratch)
      const master = meterSnapshot(masterStats)
      master.lufsApprox = lufsApproxFromRms(masterStats.rms)
      return { tracks: tracksOut, groups: aggregateGroupMeters(graph.project, tracksOut), master }
    },

    /** 把 master 频谱写入 out（Uint8Array，长度任意，建议 64/128）。 */
    getSpectrum(out) {
      if (!out || typeof out.fill !== 'function') return
      out.fill(0)
      if (!masterAnalyser || typeof masterAnalyser.getByteFrequencyData !== 'function') return
      try {
        masterAnalyser.getByteFrequencyData(out)
      } catch {
        /* ignore */
      }
    },

    dispose() {
      for (const entry of tracks.values()) {
        try {
          entry.externalInstrument?.dispose?.()
        } catch {
          /* ignore */
        }
        try {
          entry.fx.dispose()
        } catch {
          /* ignore */
        }
        for (const node of [
          entry.input,
          entry.gain,
          entry.duck,
          entry.panner,
          entry.preFx,
          entry.dry,
          entry.instrumentFilter,
          entry.postFx,
          entry.analyser,
          entry.sendReverb,
          entry.sendDelay,
          entry.phase,
          entry.monoNode,
          entry.pdcDelay,
        ]) {
          try {
            node?.disconnect()
          } catch {
            /* ignore */
          }
        }
      }
      tracks.clear()
      instrumentNodes.length = 0
      for (const entry of groups.values()) {
        try {
          entry.dispose()
        } catch {
          /* ignore */
        }
      }
      groups.clear()
      try {
        masterFx.dispose()
      } catch {
        /* ignore */
      }
      reverbBus.dispose()
      delayBus.dispose()
      for (const node of [masterIn, masterVol, fadeVol, limiter, masterAnalyser]) {
        try {
          node?.disconnect()
        } catch {
          /* ignore */
        }
      }
    },
  }
  return graph
}
