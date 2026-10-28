/**
 * 合成器 voice 构建（audio-engine）。
 *
 * 14 个 SYNTH_PRESETS 共用同一套参数化 voice：振荡器叠层 / detune / sub / FM /
 * 音量包络 / 滤波包络 / LFO / glide / drive / 立体声扩散 都由 preset 参数驱动，
 * 因此每个 preset 的声音确实不同（而非只改电平）。
 *
 * 本文件仅在函数内部使用 AudioContext 节点，模块加载时不做任何 Web Audio 调用，
 * 因此 Node 单测可以 import 纯参数函数（resolveSynthParams 等）。
 */
import { pitchToFreq } from '../../shared/model.js'
import { SYNTH_PARAM_SPECS, findSynthPreset, coerceParam } from '../../shared/catalog.js'
import { clamp, clamp01, makeDriveCurve } from './dsp.js'

/** SYNTH_PARAM_SPECS 里所有参数的默认值（catalog 是唯一权威）。 */
export const SYNTH_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(SYNTH_PARAM_SPECS).map(([key, spec]) => [key, spec.default])),
)

/** 按 spec 钳制/归一所有合成器参数；缺失或非法值回落到默认。 */
export function coerceSynthParams(raw = {}) {
  const out = {}
  for (const [key, spec] of Object.entries(SYNTH_PARAM_SPECS)) {
    const value = coerceParam(spec, raw?.[key])
    out[key] = value === undefined ? spec.default : value
  }
  return out
}

/**
 * 解析一条 track 实际生效的合成器参数：
 * 默认值 ← preset.params ← track.instrument.params（覆盖）。
 */
export function resolveSynthParams(track) {
  const preset = findSynthPreset(track?.instrument?.preset) ?? null
  const merged = {
    ...SYNTH_DEFAULTS,
    ...(preset?.params ?? {}),
    ...(track?.instrument?.params ?? {}),
  }
  return coerceSynthParams(merged)
}

/** 少量 preset 的「硬件个性」：泛音/钟声/风琴拉杆等，参数表之外的颜色。 */
const PRESET_EXTRAS = {
  // 风琴：叠加 2/3/4 次谐波当拉杆
  organ: {
    partials: [
      { ratio: 2, gain: 0.26, type: 'sine' },
      { ratio: 3, gain: 0.13, type: 'sine' },
      { ratio: 4, gain: 0.08, type: 'sine' },
    ],
  },
  // 玻璃氛围：高频非整数泛音，透明闪亮
  glasspad: {
    partials: [
      { ratio: 2.0, gain: 0.08, type: 'sine' },
      { ratio: 3.01, gain: 0.04, type: 'sine' },
    ],
  },
  // FM 钟：额外的非整数泛音让钟声更「金属」
  bell: {
    partials: [{ ratio: 2.76, gain: 0.1, type: 'sine' }],
  },
  // 合成合唱：叠加低八度与五度泛音，制造人声团感
  choir: {
    partials: [
      { ratio: 0.5, gain: 0.16, type: 'sine' },
      { ratio: 2.0, gain: 0.06, type: 'sine' },
      { ratio: 3.0, gain: 0.03, type: 'sine' },
    ],
  },
  // 马林巴：木质敲击的高次泛音
  marimba: {
    partials: [
      { ratio: 4.0, gain: 0.16, type: 'sine' },
      { ratio: 9.2, gain: 0.05, type: 'sine' },
    ],
  },
  // 古筝：五度/八度泛音，拨弦的「亮」
  koto: {
    partials: [
      { ratio: 2.0, gain: 0.1, type: 'sine' },
      { ratio: 3.01, gain: 0.05, type: 'sine' },
    ],
  },
  // 电钢：轻微钟成分
  epiano: {
    partials: [{ ratio: 2.0, gain: 0.07, type: 'sine' }],
  },
}

/** 给某个振荡器 AudioParam 施加 glide（滑音）或直接定音。 */
function applyPitch(param, targetFreq, fromFreq, t0, glide) {
  const target = Math.max(4, Number(targetFreq) || 440)
  if (fromFreq && glide > 0) {
    param.setValueAtTime(Math.max(4, Number(fromFreq) || target), t0)
    param.exponentialRampToValueAtTime(target, t0 + Math.max(0.005, glide))
  } else {
    param.setValueAtTime(target, t0)
  }
}

/**
 * 构建一个合成器音符 voice。
 *
 * 信号流：
 *   [voices 振荡器 + sub + FM 调制] → filter(带滤波包络/LFO) → drive → 音量包络
 *     → 立体声扩散 panner → destination
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination track 输入节点
 * @param {{pitch:number,vel?:number,startTime:number,dur?:number,glideFrom?:number}} note
 * @param {ReturnType<typeof resolveSynthParams>} params
 * @param {{presetId?:string, secondsPerBeat?:number, pan?:number, gainScale?:number, pitchBendCents?:number}} opts
 * @returns {{endTime:number, stop:(when?:number)=>void, type:'synth'}}
 */
export function buildSynthVoice(ctx, destination, note, params, opts = {}) {
  const p = params ?? SYNTH_DEFAULTS
  const pitch = Math.round(clamp(note?.pitch, 0, 127))
  const vel = clamp01(note?.vel ?? 0.8)
  const dur = Math.max(0.03, Number(note?.dur) || 0.25)
  const sampleRate = Number(ctx.sampleRate) || 44100
  const now = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0
  const t0 = Math.max(Number(note?.startTime) || 0, now + 0.002)
  const freq = pitchToFreq(pitch)
  const presetId = opts.presetId ?? null
  // CONTRACT-P13：pitchBend 在音符起始采样（±200 cents，叠加到各载波 detune）
  const pitchBendCents = Math.max(-200, Math.min(200, Number(opts.pitchBendCents) || 0))
  const glide = clamp(p.glide, 0, 0.5)
  const glideFrom = glide > 0 && Number(note?.glideFrom) > 0 ? Number(note.glideFrom) : null

  const sources = [] // AudioScheduledSourceNode
  const owned = [] // 需要 disconnect 的普通节点

  // ---- 输出：音量包络 → （panner） → destination -------------------------
  const out = ctx.createGain()
  out.gain.value = 0.0001
  owned.push(out)

  // 高音音符按音高做轻微左右扩散（低音保持居中，稳定低频）
  let tail = out
  const detuneWidth = clamp01(p.detune)
  if (typeof ctx.createStereoPanner === 'function' && pitch >= 48 && detuneWidth > 0.02) {
    const hash = Math.sin(pitch * 12.9898) * 43758.5453
    const jitter = hash - Math.floor(hash) - 0.5
    const pan = clamp((Number(opts.pan) || 0) + jitter * 2 * detuneWidth * 0.4, -0.85, 0.85)
    const panner = ctx.createStereoPanner()
    panner.pan.value = pan
    out.connect(panner)
    tail = panner
    owned.push(panner)
  }
  tail.connect(destination)

  // ---- 音量包络（ADSR） ---------------------------------------------------
  // 滤波 Q 很高时补偿电平，避免共振峰刺耳 / 削波
  const resonance = clamp(Number(p.resonance) || 1, 0.1, 20)
  const resComp = 1 / Math.sqrt(1 + Math.max(0, resonance - 1) * 0.22)
  const peak = clamp01(p.level) * vel * resComp * clamp(Number(opts.gainScale) || 1, 0, 4)
  // attack 上限跟随 catalog specs（P5 riser2 attack=2.2 后 spec.max 已从 2 → 3）
  const attackMax = Number(SYNTH_PARAM_SPECS.attack?.max) > 0 ? Number(SYNTH_PARAM_SPECS.attack.max) : 3
  const attack = Math.max(0.001, clamp(p.attack, 0, attackMax))
  const decay = Math.max(0.002, clamp(p.decay, 0.01, 3))
  const sustain = clamp01(p.sustain)
  const release = Math.max(0.01, clamp(p.release, 0.01, 3))
  const attackEnd = t0 + attack
  const holdEnd = t0 + Math.max(0.03, dur)
  out.gain.setValueAtTime(0.0001, t0)
  const firstHold = Math.min(attackEnd, holdEnd)
  out.gain.linearRampToValueAtTime(Math.max(0.0004, peak), firstHold)
  if (holdEnd > firstHold + 0.001) {
    const decayEnd = Math.min(firstHold + decay, holdEnd)
    out.gain.linearRampToValueAtTime(Math.max(0.0002, peak * sustain), decayEnd)
    if (holdEnd > decayEnd + 0.001) out.gain.setValueAtTime(Math.max(0.0002, peak * sustain), holdEnd)
  }
  const releaseEnd = holdEnd + release
  out.gain.linearRampToValueAtTime(0.0001, releaseEnd)
  const stopAt = releaseEnd + 0.06

  // ---- 滤波器 + 滤波包络 + LFO -------------------------------------------
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = resonance
  const nyquist = sampleRate / 2
  const maxCut = Math.min(nyquist * 0.92, 18000)
  const cutoff = Math.min(maxCut, Math.max(40, clamp(p.cutoff, 80, 16000)))
  filter.frequency.value = cutoff
  owned.push(filter)

  const envAmount = clamp01(p.envAmount)
  if (envAmount > 0.001) {
    const peakCut = Math.min(maxCut, Math.max(cutoff * 1.15, cutoff * (1 + envAmount * 9)))
    const sweepEnd = Math.max(t0 + attack + 0.02, t0 + attack + decay)
    filter.frequency.setValueAtTime(Math.max(40, cutoff), t0)
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, peakCut), t0 + attack + 0.006)
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, cutoff), sweepEnd)
  }

  const lfoAmount = clamp01(p.lfoAmount)
  const lfoRate = clamp(Number(p.lfoRate) || 0, 0, 20)
  if (lfoAmount > 0.005 && lfoRate > 0.01) {
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = lfoRate
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = lfoAmount * Math.min(2600, Math.max(60, cutoff * 1.1))
    lfo.connect(lfoGain)
    lfoGain.connect(filter.frequency)
    lfo.start(t0)
    lfo.stop(stopAt)
    sources.push(lfo)
    owned.push(lfoGain)
  }

  // ---- 振荡器层 ----------------------------------------------------------
  const oscBus = ctx.createGain()
  const voiceCount = Math.max(1, Math.min(9, Math.round(Number(p.voices) || 1)))
  oscBus.gain.value = 0.82 / Math.sqrt(voiceCount)
  oscBus.connect(filter)
  owned.push(oscBus)

  // drive 插在 filter 与音量包络之间
  const driveAmount = clamp01(p.drive)
  if (driveAmount > 0.02) {
    const pre = ctx.createGain()
    pre.gain.value = 1 + driveAmount * 5
    const shaper = ctx.createWaveShaper()
    shaper.curve = makeDriveCurve(driveAmount)
    shaper.oversample = '2x'
    const post = ctx.createGain()
    post.gain.value = 1 / (1 + driveAmount * 1.9)
    filter.connect(pre)
    pre.connect(shaper)
    shaper.connect(post)
    post.connect(out)
    owned.push(pre, shaper, post)
  } else {
    filter.connect(out)
  }

  const oscType = ['saw', 'square', 'sine', 'triangle'].includes(p.osc) ? p.osc : 'saw'
  const detuneSpread = clamp01(p.detune) * 55 // 单位：音分（±）
  const carriers = []
  for (let i = 0; i < voiceCount; i++) {
    const osc = ctx.createOscillator()
    osc.type = oscType
    const cents = voiceCount > 1 ? ((i / (voiceCount - 1)) * 2 - 1) * detuneSpread : 0
    osc.detune.value = cents + pitchBendCents
    applyPitch(osc.frequency, freq, glideFrom, t0, glide)
    osc.connect(oscBus)
    osc.start(t0)
    osc.stop(stopAt)
    sources.push(osc)
    carriers.push(osc)
  }

  // sub 振荡器（低八度正弦，低音/铺底厚度）
  const subAmount = clamp01(p.sub)
  if (subAmount > 0.01) {
    const subOsc = ctx.createOscillator()
    subOsc.type = 'sine'
    if (Math.abs(pitchBendCents) > 1e-9) subOsc.detune.value = pitchBendCents
    applyPitch(subOsc.frequency, freq / 2, glideFrom ? glideFrom / 2 : null, t0, glide)
    const subGain = ctx.createGain()
    subGain.gain.value = subAmount * 0.6
    subOsc.connect(subGain)
    subGain.connect(oscBus)
    subOsc.start(t0)
    subOsc.stop(stopAt)
    sources.push(subOsc)
    owned.push(subGain)
  }

  // FM 调制：一个调制器接所有载波频率，深度随包络衰减（金属感 attack）
  const fmAmount = clamp01(p.fmAmount)
  if (fmAmount > 0.01 && carriers.length) {
    const mod = ctx.createOscillator()
    mod.type = 'sine'
    const ratio = clamp(Number(p.fmRatio) || 2, 0.5, 8)
    mod.frequency.value = Math.max(4, Math.min(nyquist * 0.9, freq * ratio))
    const modGain = ctx.createGain()
    const depth = Math.max(1, Math.min(sampleRate / 3, freq * fmAmount * 6))
    modGain.gain.setValueAtTime(depth, t0)
    modGain.gain.setTargetAtTime(depth * 0.16, t0 + 0.002, Math.max(0.03, Math.min(0.5, decay)))
    mod.connect(modGain)
    for (const carrier of carriers) modGain.connect(carrier.frequency)
    mod.start(t0)
    mod.stop(stopAt)
    sources.push(mod)
    owned.push(modGain)
  }

  // preset 个性泛音
  const extras = PRESET_EXTRAS[presetId]
  if (extras?.partials) {
    for (const part of extras.partials) {
      const target = freq * part.ratio
      if (target <= 0 || target >= nyquist * 0.95) continue
      const partial = ctx.createOscillator()
      partial.type = part.type ?? 'sine'
      partial.frequency.value = target
      const gain = ctx.createGain()
      gain.gain.value = clamp01(part.gain) * vel
      partial.connect(gain)
      gain.connect(oscBus)
      partial.start(t0)
      partial.stop(stopAt)
      sources.push(partial)
      owned.push(gain)
    }
  }

  // ---- cleanup / stop ----------------------------------------------------
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    for (const node of owned) {
      try {
        node.disconnect()
      } catch {
        /* ignore */
      }
    }
  }
  if (sources.length) sources[0].onended = cleanup

  const stop = (when) => {
    const w = Math.max(now, Number(when) || now)
    try {
      out.gain.cancelScheduledValues(w)
    } catch {
      /* ignore */
    }
    try {
      out.gain.setTargetAtTime(0.0001, w, 0.005)
    } catch {
      try {
        out.gain.value = 0
      } catch {
        /* ignore */
      }
    }
    for (const src of sources) {
      try {
        src.stop(w + 0.04)
      } catch {
        /* ignore */
      }
    }
  }

  return { type: 'synth', endTime: stopAt, stop, cleanup, release: cleanup }
}
