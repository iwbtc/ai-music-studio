/**
 * 内置 subtractive 合成器 voice（CONTRACT-R5D）。
 *
 * 信号流：
 *   [unison 振荡器(1..2) + sub sine] → Biquad lowpass(cutoff/Q) → ADSR Gain → level
 *   其中 LFO(sine, lfoRate) → Gain(lfoDepth cents) → 所有振荡器 detune。
 *
 * 模块加载时不做任何 Web Audio 调用；Node 单测可 import 纯参数函数并用 mock ctx 构建 voice。
 */
import { clamp, clamp01 } from './dsp.js'
import { SYNTH_INSTRUMENT_PARAM_SPECS, SYNTH_INSTRUMENTS, findSynthInstrument } from '../../shared/catalog.js'

/** 每轨最大 subtractive 复音数（超出丢最旧）。 */
export const MAX_SUBTRACTIVE_VOICES = 16

/** subtractive 参数规格（catalog 为唯一权威；wave 枚举默认 saw）。 */
export const SUBTRACTIVE_PARAM_SPECS = SYNTH_INSTRUMENT_PARAM_SPECS
export { SYNTH_INSTRUMENTS, findSynthInstrument }

/** 默认 subtractive 参数（catalog spec 默认；wave 默认 saw）。 */
export const SUBTRACTIVE_DEFAULTS = Object.freeze({
  wave: 'saw',
  ...Object.fromEntries(
    Object.entries(SYNTH_INSTRUMENT_PARAM_SPECS)
      .filter(([key]) => key !== 'wave')
      .map(([key, spec]) => [key, spec.default]),
  ),
})

/** 按 catalog 规格夹紧/取整单个参数；非法 → fallback（缺省 spec 默认）。 */
export function coerceSubtractiveParam(key, raw, fallback) {
  const spec = SYNTH_INSTRUMENT_PARAM_SPECS[key]
  if (!spec) return fallback
  if (spec.type === 'enum') {
    return typeof raw === 'string' && spec.options.includes(raw) ? raw : (fallback ?? 'saw')
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback ?? spec.default
  let clamped = Math.max(spec.min, Math.min(spec.max, value))
  const round = Number.isInteger(spec.round) ? spec.round : 2
  clamped = Math.round(clamped * 10 ** round) / 10 ** round
  return clamped
}

/**
 * 合并/规范化 subtractive 参数：默认值 ← preset（可选）← track.synthParams（可选）← overrides。
 * 所有字段完整返回、均已夹紧；未知参数忽略。
 * @param {object} [preset] catalog SYNTH_INSTRUMENTS 项的 synthPreset（或完整参数对象）
 * @param {object} [overrides]
 * @returns {typeof SUBTRACTIVE_DEFAULTS}
 */
export function resolveSubtractiveParams(preset, overrides) {
  const base = { ...SUBTRACTIVE_DEFAULTS }
  if (preset && typeof preset === 'object') {
    for (const key of Object.keys(SUBTRACTIVE_PARAM_SPECS)) {
      if (preset[key] !== undefined) base[key] = coerceSubtractiveParam(key, preset[key], base[key])
    }
  }
  if (overrides && typeof overrides === 'object') {
    for (const key of Object.keys(SUBTRACTIVE_PARAM_SPECS)) {
      if (overrides[key] !== undefined) base[key] = coerceSubtractiveParam(key, overrides[key], base[key])
    }
  }
  return base
}

/**
 * R5b instrumentParams → subtractive 覆盖（attack/release/filter/lfo 共用字段映射）。
 * 只映射存在的字段；返回可直接合并进 resolveSubtractiveParams 的对象。
 * @param {object} instrumentParams
 * @returns {object}
 */
export function instrumentParamsToSynthOverrides(instrumentParams) {
  const out = {}
  if (!instrumentParams || typeof instrumentParams !== 'object') return out
  if (instrumentParams.attack !== undefined) out.attack = instrumentParams.attack
  if (instrumentParams.release !== undefined) out.release = instrumentParams.release
  if (instrumentParams.filterCutoff !== undefined) out.filterCutoff = instrumentParams.filterCutoff
  if (instrumentParams.filterQ !== undefined) out.filterQ = instrumentParams.filterQ
  if (instrumentParams.lfoRate !== undefined) out.lfoRate = instrumentParams.lfoRate
  if (instrumentParams.lfoDepth !== undefined) out.lfoDepth = instrumentParams.lfoDepth
  return out
}

/** subtractive wave id → Web Audio OscillatorType。 */
const WAVE_TYPES = Object.freeze({ saw: 'sawtooth', square: 'square', sine: 'sine', triangle: 'triangle' })

/** 音高 → Hz（MIDI note 69 = 440Hz）。 */
export function synthFreqForPitch(pitch) {
  const note = Number(pitch)
  if (!Number.isFinite(note)) return 440
  return 440 * Math.pow(2, (Math.max(0, Math.min(127, note)) - 69) / 12)
}

/**
 * 构建一个 subtractive 音符 voice（实时/离线/预览共用）。
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @param {{pitch:number, vel?:number, startTime:number, dur?:number,
 *   pitchBendCents?:number, expressionGain?:number, gainScale?:number}} note
 * @param {typeof SUBTRACTIVE_DEFAULTS} params 已 resolve 的完整参数
 * @returns {{endTime:number, type:'subtractive', stop:(at?:number)=>void, release:()=>void, dispose:()=>void}|null}
 */
export function buildSubtractiveVoice(ctx, destination, note, params) {
  if (!ctx || !destination) return null
  const p = params && typeof params === 'object' ? params : SUBTRACTIVE_DEFAULTS
  try {
    const t0 = Math.max(0, Number(note?.startTime) || Number(ctx.currentTime) || 0)
    const dur = Math.max(0.02, Number(note?.dur) || 0.4)
    const pitch = Math.max(0, Math.min(127, Math.round(Number(note?.pitch) || 60)))
    const vel = clamp01(note?.vel === undefined || note?.vel === null ? 0.8 : note.vel)
    const pitchBendCents = Math.max(-200, Math.min(200, Number(note?.pitchBendCents) || 0))
    const expressionGain = Math.max(
      0,
      Math.min(1, note?.expressionGain === undefined || note?.expressionGain === null ? 1 : Number(note.expressionGain)),
    )
    const gainScale = Math.max(
      0.01,
      Math.min(64, note?.gainScale === undefined || note?.gainScale === null ? 1 : Number(note.gainScale)),
    )
    const freq = synthFreqForPitch(pitch)
    const peak = Math.max(0.0001, Math.pow(vel, 1.5) * clamp01(p.level) * expressionGain * gainScale)

    const oscs = []
    const unison = p.unison >= 2 ? 2 : 1
    const detune = clamp(Number(p.detuneCents) || 0, 0, 30)
    for (let index = 0; index < unison; index++) {
      const osc = ctx.createOscillator()
      osc.type = WAVE_TYPES[p.wave] ?? 'sine'
      const spread = unison === 1 ? 0 : (index === 0 ? -detune / 2 : detune / 2)
      osc.frequency.setValueAtTime(Math.max(1, freq), t0)
      osc.detune.setValueAtTime(pitchBendCents + spread, t0)
      oscs.push(osc)
    }
    // sub sine（低八度）
    let sub = null
    const subLevel = clamp01(p.subLevel)
    if (subLevel > 0.0001) {
      sub = ctx.createOscillator()
      sub.type = 'sine'
      sub.frequency.setValueAtTime(Math.max(1, freq / 2), t0)
      sub.detune.setValueAtTime(pitchBendCents, t0)
    }

    // LFO：lfoDepth > 0 才建节点
    let lfoOsc = null
    let lfoGain = null
    const lfoDepth = clamp(Number(p.lfoDepth) || 0, 0, 100)
    if (lfoDepth > 0.0001) {
      lfoOsc = ctx.createOscillator()
      lfoOsc.type = 'sine'
      lfoOsc.frequency.setValueAtTime(clamp(Number(p.lfoRate) || 5, 0.1, 12), t0)
      lfoGain = ctx.createGain()
      lfoGain.gain.value = lfoDepth
      lfoOsc.connect(lfoGain)
      for (const osc of oscs) lfoGain.connect(osc.detune)
      if (sub) lfoGain.connect(sub.detune)
    }

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(clamp(Number(p.filterCutoff) || 2400, 100, 18000), t0)
    filter.Q.setValueAtTime(clamp(Number(p.filterQ) || 3, 0.1, 20), t0)

    const amp = ctx.createGain()
    const attack = clamp(Number(p.attack) || 0.01, 0.001, 2)
    const decay = clamp(Number(p.decay) || 0.18, 0.005, 2)
    const sustain = clamp01(p.sustain)
    const release = clamp(Number(p.release) || 0.25, 0.01, 4)
    const noteEnd = t0 + dur
    const attackEnd = t0 + Math.min(attack, dur)
    const decayEnd = attackEnd + decay
    const sustainGain = Math.max(0.0002, peak * sustain)
    try {
      amp.gain.setValueAtTime(0.0001, t0)
      amp.gain.linearRampToValueAtTime(peak, Math.max(t0 + 0.001, attackEnd))
      if (noteEnd >= decayEnd - 0.001) {
        amp.gain.linearRampToValueAtTime(sustainGain, Math.max(attackEnd + 0.002, decayEnd))
        amp.gain.setValueAtTime(sustainGain, Math.max(noteEnd, decayEnd))
      } else {
        const progress = Math.max(0, Math.min(1, (noteEnd - attackEnd) / decay))
        amp.gain.linearRampToValueAtTime(Math.max(0.0002, peak + (sustainGain - peak) * progress), noteEnd)
      }
      amp.gain.linearRampToValueAtTime(0.0001, noteEnd + release)
    } catch {
      amp.gain.value = peak
    }

    // 混音节点：每个 osc → oscMix；sub → subMix；两 mix → filter → amp → destination
    const oscMix = ctx.createGain()
    oscMix.gain.value = 1 / unison
    const subMix = ctx.createGain()
    subMix.gain.value = subLevel
    for (const osc of oscs) osc.connect(oscMix)
    if (sub) sub.connect(subMix)
    oscMix.connect(filter)
    subMix.connect(filter)
    filter.connect(amp)
    amp.connect(destination)

    const stopAt = noteEnd + release + 0.02
    try {
      for (const osc of oscs) {
        osc.start(t0)
        osc.stop(stopAt)
      }
      sub?.start(t0)
      sub?.stop(stopAt)
      if (lfoOsc) {
        lfoOsc.start(t0)
        lfoOsc.stop(stopAt)
      }
    } catch {
      for (const node of [amp, filter, oscMix, subMix, lfoGain, ...oscs, sub, lfoOsc]) {
        try {
          node?.disconnect()
        } catch {
          /* ignore */
        }
      }
      return null
    }

    let disposed = false
    return {
      type: 'subtractive',
      endTime: stopAt,
      stop(at) {
        const when = Number.isFinite(Number(at)) ? Math.max(t0, Number(at)) : t0
        for (const osc of oscs) {
          try {
            osc.stop(when)
          } catch {
            /* ignore */
          }
        }
        try {
          sub?.stop(when)
        } catch {
          /* ignore */
        }
        try {
          lfoOsc?.stop(when)
        } catch {
          /* ignore */
        }
      },
      release() {
        try {
          amp.gain.cancelScheduledValues(Number(ctx.currentTime) || 0)
        } catch {
          /* ignore */
        }
        try {
          for (const osc of oscs) osc.stop()
        } catch {
          /* ignore */
        }
        try {
          sub?.stop()
        } catch {
          /* ignore */
        }
        try {
          lfoOsc?.stop()
        } catch {
          /* ignore */
        }
      },
      dispose() {
        if (disposed) return
        disposed = true
        try {
          for (const osc of oscs) osc.stop()
        } catch {
          /* ignore */
        }
        try {
          sub?.stop()
        } catch {
          /* ignore */
        }
        try {
          lfoOsc?.stop()
        } catch {
          /* ignore */
        }
        for (const node of [oscMix, subMix, filter, amp, lfoGain, ...oscs, sub, lfoOsc]) {
          try {
            node?.disconnect()
          } catch {
            /* ignore */
          }
        }
      },
    }
  } catch {
    return null
  }
}
