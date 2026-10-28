/**
 * 效果器 Web Audio 图构建 + 实时参数更新（audio-engine）。
 *
 * 覆盖 catalog.FX_TYPES 的全部 15 种：
 *   filter / drive / chorus / phaser / delay / reverb / bitcrush /
 *   compressor / eq3 / tremolo / autofilter / flanger / ringmod / autopan / highshelf
 *
 * 每个效果器都是「input → (dry / wet 并行) → output」的通用外壳：
 * - 有 mix 参数的效果器（见 catalog.FX_PARAM_SPECS）用 mix 控制干湿比；
 * - 没有 mix 参数的（compressor/eq3/tremolo）启用时全湿；
 * - enabled=false 时旁通（dry=1，wet=0）。
 * 所有参数更新走 setTargetAtTime 平滑，播放中改参数不会爆音。
 *
 * 模块加载时不做任何 Web Audio 调用；`makeImpulseResponse` 内部用纯函数
 * generateImpulseData 生成数据，Node 单测可直接测纯计算部分。
 */
import { FX_PARAM_SPECS, coerceParam, fxDefaultParams } from '../../shared/catalog.js'
import {
  clamp,
  clamp01,
  makeDriveCurve,
  makeBitCrushCurve,
  generateImpulseData,
  setAudioParam,
  rampAudioParam,
} from './dsp.js'

/** 按 catalog 的参数规格解析一套效果器参数（非法值回落默认、越界钳制）。 */
export function resolveFxParams(type, raw = {}) {
  const specs = FX_PARAM_SPECS[type] ?? {}
  const out = fxDefaultParams(type)
  for (const [key, spec] of Object.entries(specs)) {
    const value = coerceParam(spec, raw?.[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

/** 该 FX 类型是否有 mix 参数（唯一权威：catalog.FX_PARAM_SPECS）。 */
export function fxHasMix(type) {
  return Object.prototype.hasOwnProperty.call(FX_PARAM_SPECS[type] ?? {}, 'mix')
}

function setP(param, value, ctx, immediate, tc = 0.02) {
  if (!param) return
  if (immediate) setAudioParam(param, value)
  else rampAudioParam(param, value, Number(ctx.currentTime) || 0, tc)
}

/** 构建一条效果器链（空链也可以，退化为直通）。 */
export function buildFxChain(ctx, effects) {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const nodes = new Map()
  const list = []
  let prev = input
  for (const effect of effects ?? []) {
    const wrapper = buildEffect(ctx, effect)
    prev.connect(wrapper.input)
    prev = wrapper.output
    const id = effect?.id ?? `fx_${nodes.size}`
    nodes.set(id, wrapper)
    list.push(wrapper)
  }
  prev.connect(output)
  return {
    input,
    output,
    effects: nodes,
    list,
    /** 只更新参数/开关；链结构变化需要重建（引擎用 graphSignature 判断）。 */
    update(nextEffects) {
      const byId = new Map((nextEffects ?? []).map((e) => [e?.id, e]))
      for (const [id, wrapper] of nodes) {
        const effect = byId.get(id)
        if (!effect) continue
        wrapper.update(effect.params, effect.enabled !== false)
      }
    },
    dispose() {
      for (const wrapper of list) {
        try {
          wrapper.dispose()
        } catch {
          /* ignore */
        }
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

/** 用纯函数生成的脉冲响应构造 AudioBuffer（ConvolverNode 用）。 */
export function makeImpulseResponse(ctx, opts = {}) {
  const { data, sampleRate, length } = generateImpulseData(Number(ctx.sampleRate) || 44100, opts)
  const buffer = ctx.createBuffer(data.length, length, sampleRate)
  for (let c = 0; c < data.length; c++) {
    let copied = false
    if (typeof buffer.copyToChannel === 'function') {
      try {
        buffer.copyToChannel(data[c], c)
        copied = true
      } catch {
        copied = false
      }
    }
    if (!copied) {
      const chan = buffer.getChannelData(c)
      chan.set(data[c])
    }
  }
  return buffer
}

// ---------------------------------------------------------------------------
// 各效果器 builder：返回 { update(params, immediate), dispose() }
// ---------------------------------------------------------------------------

function buildFilter(ctx, io, initial) {
  const filter = ctx.createBiquadFilter()
  io.input.connect(filter)
  filter.connect(io.output)
  return {
    update(p, immediate) {
      filter.type = ['lowpass', 'highpass', 'bandpass'].includes(p.mode) ? p.mode : 'lowpass'
      setP(filter.frequency, clamp(p.cutoff, 20, 20000), ctx, immediate)
      setP(filter.Q, clamp(p.resonance, 0.1, 20), ctx, immediate)
    },
    dispose() {},
  }
}

function buildDrive(ctx, io, initial) {
  const pre = ctx.createGain()
  const shaper = ctx.createWaveShaper()
  shaper.oversample = '2x'
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.Q.value = 0.6
  const post = ctx.createGain()
  io.input.connect(pre)
  pre.connect(shaper)
  shaper.connect(tone)
  tone.connect(post)
  post.connect(io.output)
  return {
    update(p, immediate) {
      const amount = clamp01(p.amount)
      shaper.curve = makeDriveCurve(amount)
      setP(pre.gain, 1 + amount * 7, ctx, immediate)
      setP(tone.frequency, 600 + clamp01(p.tone) * 11500, ctx, immediate)
      setP(post.gain, 1 / (1 + amount * 1.4), ctx, immediate)
    },
    dispose() {},
  }
}

function buildChorus(ctx, io, initial) {
  const delayA = ctx.createDelay(0.2)
  const delayB = ctx.createDelay(0.2)
  delayA.delayTime.value = 0.018
  delayB.delayTime.value = 0.011
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  const modA = ctx.createGain()
  const modB = ctx.createGain()
  lfo.connect(modA)
  modA.connect(delayA.delayTime)
  lfo.connect(modB)
  modB.connect(delayB.delayTime)
  try {
    lfo.start(0)
  } catch {
    /* ignore */
  }
  io.input.connect(delayA)
  io.input.connect(delayB)
  let outA = delayA
  let outB = delayB
  if (typeof ctx.createStereoPanner === 'function') {
    const panA = ctx.createStereoPanner()
    panA.pan.value = -0.55
    const panB = ctx.createStereoPanner()
    panB.pan.value = 0.55
    delayA.connect(panA)
    delayB.connect(panB)
    outA = panA
    outB = panB
  }
  outA.connect(io.output)
  outB.connect(io.output)
  return {
    update(p, immediate) {
      setP(lfo.frequency, clamp(p.rate, 0.05, 8), ctx, immediate)
      const depth = clamp01(p.depth)
      const swing = 0.0012 + depth * 0.012
      setP(modA.gain, swing, ctx, immediate)
      setP(modB.gain, -swing * 0.82, ctx, immediate)
    },
    dispose() {
      try {
        lfo.stop()
      } catch {
        /* ignore */
      }
    },
  }
}

function buildPhaser(ctx, io, initial) {
  const stages = []
  const baseFreqs = [320, 560, 890, 1350]
  let prev = io.input
  for (const freq of baseFreqs) {
    const stage = ctx.createBiquadFilter()
    stage.type = 'allpass'
    stage.frequency.value = freq
    stage.Q.value = 1.2
    prev.connect(stage)
    prev = stage
    stages.push(stage)
  }
  prev.connect(io.output)
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  const lfoGain = ctx.createGain()
  lfo.connect(lfoGain)
  for (const stage of stages) lfoGain.connect(stage.frequency)
  try {
    lfo.start(0)
  } catch {
    /* ignore */
  }
  return {
    update(p, immediate) {
      setP(lfo.frequency, clamp(p.rate, 0.02, 8), ctx, immediate)
      setP(lfoGain.gain, 180 + clamp01(p.depth) * 1400, ctx, immediate)
      for (const stage of stages) setP(stage.Q, 0.8 + clamp01(p.depth) * 2.4, ctx, immediate)
    },
    dispose() {
      try {
        lfo.stop()
      } catch {
        /* ignore */
      }
    },
  }
}

function buildDelay(ctx, io, initial) {
  const delayL = ctx.createDelay(2.5)
  const delayR = ctx.createDelay(2.5)
  const fbSelf = ctx.createGain()
  const fbLR = ctx.createGain()
  const fbRL = ctx.createGain()
  const outL0 = ctx.createGain()
  const outL1 = ctx.createGain()
  const outR0 = ctx.createGain()
  const outR1 = ctx.createGain()
  const merger = ctx.createChannelMerger(2)

  io.input.connect(delayL)
  // 自反馈（普通延迟）
  delayL.connect(fbSelf)
  fbSelf.connect(delayL)
  // 交叉反馈（乒乓）
  delayL.connect(fbLR)
  fbLR.connect(delayR)
  delayR.connect(fbRL)
  fbRL.connect(delayL)
  // 输出路由
  delayL.connect(outL0)
  outL0.connect(merger, 0, 0)
  delayL.connect(outL1)
  outL1.connect(merger, 0, 1)
  delayR.connect(outR0)
  outR0.connect(merger, 0, 0)
  delayR.connect(outR1)
  outR1.connect(merger, 0, 1)
  merger.connect(io.output)
  return {
    update(p, immediate) {
      const time = clamp(p.time, 0.02, 2)
      setP(delayL.delayTime, time, ctx, immediate)
      setP(delayR.delayTime, time, ctx, immediate)
      const feedback = clamp(p.feedback, 0, 0.95)
      const pingpong = p.pingpong === true
      if (pingpong) {
        setP(fbSelf.gain, 0, ctx, immediate)
        setP(fbLR.gain, feedback, ctx, immediate)
        setP(fbRL.gain, feedback, ctx, immediate)
        setP(outL0.gain, 1, ctx, immediate)
        setP(outL1.gain, 0, ctx, immediate)
        setP(outR0.gain, 0, ctx, immediate)
        setP(outR1.gain, 1, ctx, immediate)
      } else {
        setP(fbSelf.gain, feedback, ctx, immediate)
        setP(fbLR.gain, 0, ctx, immediate)
        setP(fbRL.gain, 0, ctx, immediate)
        setP(outL0.gain, 1, ctx, immediate)
        setP(outL1.gain, 1, ctx, immediate)
        setP(outR0.gain, 0, ctx, immediate)
        setP(outR1.gain, 0, ctx, immediate)
      }
    },
    dispose() {},
  }
}

function buildReverb(ctx, io, initial) {
  // 预延迟（CONTRACT-P11）：干声 → DelayNode → Convolver；preDelay=0 时延迟 0（直通语义）。
  const preDelay = ctx.createDelay(0.25)
  preDelay.delayTime.value = 0.02
  const convolver = ctx.createConvolver()
  convolver.normalize = true
  io.input.connect(preDelay)
  preDelay.connect(convolver)
  convolver.connect(io.output)
  let lastKey = ''
  const load = (p) => {
    const size = Number(p.size) || 0.6
    const decay = Number(p.decay) || 0.55
    const damp = Number(p.damp) || 0.4
    const key = `${size.toFixed(3)}|${decay.toFixed(3)}|${damp.toFixed(3)}`
    if (key === lastKey) return
    lastKey = key
    try {
      convolver.buffer = makeImpulseResponse(ctx, { size, decay, damp })
    } catch {
      /* 某些环境不支持 createBuffer 时静默降级 */
    }
  }
  return {
    update(p, immediate) {
      const rawPreDelay = p?.preDelay === undefined || p?.preDelay === null ? 20 : Number(p.preDelay)
      const preDelayMs = clamp(Number.isFinite(rawPreDelay) ? rawPreDelay : 20, 0, 120)
      setP(preDelay.delayTime, preDelayMs / 1000, ctx, immediate)
      load(p)
    },
    dispose() {
      try {
        preDelay.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

function buildBitcrush(ctx, io, initial) {
  const shaper = ctx.createWaveShaper()
  const lowpass = ctx.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.Q.value = 0.5
  io.input.connect(shaper)
  shaper.connect(lowpass)
  lowpass.connect(io.output)
  return {
    update(p, immediate) {
      shaper.curve = makeBitCrushCurve(p.bits)
      const sampleRate = Number(ctx.sampleRate) || 44100
      const cutoff = clamp((sampleRate * clamp(p.rate, 0.02, 1)) / 2, 220, 20000)
      setP(lowpass.frequency, cutoff, ctx, immediate)
    },
    dispose() {},
  }
}

function buildCompressor(ctx, io, initial) {
  const comp = ctx.createDynamicsCompressor()
  comp.knee.value = 6
  io.input.connect(comp)
  comp.connect(io.output)
  return {
    update(p, immediate) {
      setP(comp.threshold, clamp(p.threshold, -100, 0), ctx, immediate)
      setP(comp.ratio, clamp(p.ratio, 1, 20), ctx, immediate)
      setP(comp.attack, clamp(p.attack, 0, 1), ctx, immediate)
      setP(comp.release, clamp(p.release, 0.01, 1), ctx, immediate)
    },
    dispose() {},
  }
}

function buildEq3(ctx, io, initial) {
  // CONTRACT-P13：三段 EQ 全频点/Q 可调（low=lowshelf/mid=peaking/high=highshelf）
  const low = ctx.createBiquadFilter()
  low.type = 'lowshelf'
  low.frequency.value = 200
  const mid = ctx.createBiquadFilter()
  mid.type = 'peaking'
  mid.frequency.value = 1000
  mid.Q.value = 1
  const high = ctx.createBiquadFilter()
  high.type = 'highshelf'
  high.frequency.value = 8000
  io.input.connect(low)
  low.connect(mid)
  mid.connect(high)
  high.connect(io.output)
  return {
    update(p, immediate) {
      setP(low.gain, clamp(p.low, -18, 18), ctx, immediate)
      setP(mid.gain, clamp(p.mid, -18, 18), ctx, immediate)
      setP(high.gain, clamp(p.high, -18, 18), ctx, immediate)
      const lowFreq = Number(p?.lowFreq)
      const midFreq = Number(p?.midFreq)
      const midQ = Number(p?.midQ)
      const highFreq = Number(p?.highFreq)
      setP(low.frequency, clamp(Number.isFinite(lowFreq) ? lowFreq : 200, 80, 800), ctx, immediate)
      setP(mid.frequency, clamp(Number.isFinite(midFreq) ? midFreq : 1000, 300, 5000), ctx, immediate)
      setP(mid.Q, clamp(Number.isFinite(midQ) ? midQ : 1, 0.3, 8), ctx, immediate)
      setP(high.frequency, clamp(Number.isFinite(highFreq) ? highFreq : 8000, 2000, 16000), ctx, immediate)
    },
    dispose() {},
  }
}

function buildTremolo(ctx, io, initial) {
  const vca = ctx.createGain()
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  const lfoGain = ctx.createGain()
  lfo.connect(lfoGain)
  lfoGain.connect(vca.gain)
  try {
    lfo.start(0)
  } catch {
    /* ignore */
  }
  io.input.connect(vca)
  vca.connect(io.output)
  return {
    update(p, immediate) {
      const depth = clamp01(p.depth)
      setP(lfo.frequency, clamp(p.rate, 0.2, 20), ctx, immediate)
      setP(vca.gain, 1 - depth / 2, ctx, immediate)
      setP(lfoGain.gain, depth / 2, ctx, immediate)
    },
    dispose() {
      try {
        lfo.stop()
      } catch {
        /* ignore */
      }
    },
  }
}

function buildHighshelf(ctx, io, initial) {
  // 高频架（CONTRACT-P11）：提亮钢琴/弦乐；freq 1000..16000、gain -12..12 dB
  const shelf = ctx.createBiquadFilter()
  shelf.type = 'highshelf'
  shelf.frequency.value = 6000
  shelf.gain.value = 0
  io.input.connect(shelf)
  shelf.connect(io.output)
  return {
    update(p, immediate) {
      const freq = Number(p?.freq)
      const gain = Number(p?.gain)
      setP(shelf.frequency, clamp(Number.isFinite(freq) ? freq : 6000, 1000, 16000), ctx, immediate)
      setP(shelf.gain, clamp(Number.isFinite(gain) ? gain : 0, -12, 12), ctx, immediate)
    },
    dispose() {},
  }
}

function buildAutofilter(ctx, io, initial) {
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = 3
  io.input.connect(filter)
  filter.connect(io.output)
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  const lfoGain = ctx.createGain()
  lfo.connect(lfoGain)
  lfoGain.connect(filter.frequency)
  try {
    lfo.start(0)
  } catch {
    /* ignore */
  }
  return {
    update(p, immediate) {
      const cutoff = clamp(p.cutoff, 80, 12000)
      const depth = clamp01(p.depth)
      setP(filter.frequency, cutoff, ctx, immediate)
      setP(lfo.frequency, clamp(p.rate, 0.02, 8), ctx, immediate)
      setP(lfoGain.gain, cutoff * depth * 0.78, ctx, immediate)
    },
    dispose() {
      try {
        lfo.stop()
      } catch {
        /* ignore */
      }
    },
  }
}

function buildFlanger(ctx, io, initial) {
  // 短延迟（base 3ms）被正弦 LFO 调制 ±depth*2ms；feedback 回延迟输入形成镶边梳状滤波
  const delay = ctx.createDelay(0.05)
  delay.delayTime.value = 0.003
  const feedback = ctx.createGain()
  feedback.gain.value = 0
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  const depthGain = ctx.createGain()
  lfo.connect(depthGain)
  depthGain.connect(delay.delayTime)
  io.input.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(io.output)
  try {
    lfo.start(0)
  } catch {
    /* ignore */
  }
  return {
    update(p, immediate) {
      setP(delay.delayTime, 0.003, ctx, immediate)
      setP(lfo.frequency, clamp(p.rate, 0.05, 5), ctx, immediate)
      setP(depthGain.gain, clamp01(p.depth) * 0.002, ctx, immediate)
      setP(feedback.gain, clamp(p.feedback, 0, 0.9), ctx, immediate)
    },
    dispose() {
      try {
        lfo.stop()
      } catch {
        /* ignore */
      }
    },
  }
}

function buildRingmod(ctx, io, initial) {
  // 环形调制：GainNode.gain 初始 0，Oscillator 直接连到 gain 参数做双极性乘法
  const ring = ctx.createGain()
  ring.gain.value = 0
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.connect(ring.gain)
  io.input.connect(ring)
  ring.connect(io.output)
  try {
    osc.start(0)
  } catch {
    /* ignore */
  }
  return {
    update(p, immediate) {
      // 基值保持 0，输出 = input × osc（真正的环形调制）
      setP(ring.gain, 0, ctx, immediate)
      setP(osc.frequency, clamp(p.frequency, 20, 2000), ctx, immediate)
    },
    dispose() {
      try {
        osc.stop()
      } catch {
        /* ignore */
      }
    },
  }
}

function buildAutopan(ctx, io, initial) {
  // 无 StereoPanner 的环境降级为直通（mix 干湿外壳仍生效）
  if (typeof ctx.createStereoPanner !== 'function') {
    io.input.connect(io.output)
    return {
      update() {},
      dispose() {},
    }
  }
  const panner = ctx.createStereoPanner()
  panner.pan.value = 0
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  const depthGain = ctx.createGain()
  lfo.connect(depthGain)
  depthGain.connect(panner.pan)
  io.input.connect(panner)
  panner.connect(io.output)
  try {
    lfo.start(0)
  } catch {
    /* ignore */
  }
  return {
    update(p, immediate) {
      // 基值 0 + LFO×depth → 声像在 -depth..+depth 之间摆动
      setP(panner.pan, 0, ctx, immediate)
      setP(lfo.frequency, clamp(p.rate, 0.05, 8), ctx, immediate)
      setP(depthGain.gain, clamp01(p.depth), ctx, immediate)
    },
    dispose() {
      try {
        lfo.stop()
      } catch {
        /* ignore */
      }
    },
  }
}

const BUILDERS = {
  filter: buildFilter,
  drive: buildDrive,
  chorus: buildChorus,
  phaser: buildPhaser,
  delay: buildDelay,
  reverb: buildReverb,
  bitcrush: buildBitcrush,
  compressor: buildCompressor,
  eq3: buildEq3,
  tremolo: buildTremolo,
  autofilter: buildAutofilter,
  flanger: buildFlanger,
  ringmod: buildRingmod,
  autopan: buildAutopan,
  highshelf: buildHighshelf,
}

/** 已实现的 FX 类型列表（与 catalog.FX_TYPES 对齐，单测校验）。 */
export const IMPLEMENTED_FX_TYPES = Object.freeze(Object.keys(BUILDERS))

/**
 * 构建单个效果器（含 dry/wet 外壳）。
 * @param {BaseAudioContext} ctx
 * @param {{id?:string,type:string,enabled?:boolean,params?:object}} effect
 */
export function buildEffect(ctx, effect) {
  const type = effect?.type
  const builder = BUILDERS[type] ?? null
  const input = ctx.createGain()
  const output = ctx.createGain()
  const dry = ctx.createGain()
  const wet = ctx.createGain()
  const procIn = ctx.createGain()
  const procOut = ctx.createGain()
  input.connect(dry)
  dry.connect(output)
  input.connect(procIn)
  procOut.connect(wet)
  wet.connect(output)
  dry.gain.value = 1
  wet.gain.value = 0

  const hasMix = fxHasMix(type)
  let initialized = false
  let unit = null
  if (builder) {
    try {
      unit = builder(ctx, { input: procIn, output: procOut }, resolveFxParams(type, effect?.params))
    } catch {
      unit = null
    }
  }

  const wrapper = {
    id: effect?.id,
    type,
    input,
    output,
    _params: resolveFxParams(type, effect?.params),
    _enabled: effect?.enabled !== false,
    get enabled() {
      return wrapper._enabled
    },
    update(nextParams, enabled) {
      const immediate = !initialized
      const immediateMix = !initialized
      const params = nextParams === undefined ? wrapper._params : resolveFxParams(type, nextParams)
      wrapper._params = params
      wrapper._enabled = enabled === undefined ? wrapper._enabled : enabled !== false
      if (unit) {
        try {
          unit.update(params, immediate)
        } catch {
          /* 单个 FX 参数更新失败不影响整条链 */
        }
      }
      const on = wrapper._enabled
      if (hasMix) {
        const mix = on ? clamp01(params.mix) : 0
        if (immediateMix) {
          setAudioParam(wet.gain, mix)
          setAudioParam(dry.gain, 1 - mix)
        } else {
          rampAudioParam(wet.gain, mix, Number(ctx.currentTime) || 0, 0.02)
          rampAudioParam(dry.gain, 1 - mix, Number(ctx.currentTime) || 0, 0.02)
        }
      } else {
        const target = on ? 1 : 0
        if (immediateMix) {
          setAudioParam(wet.gain, target)
          setAudioParam(dry.gain, 1 - target)
        } else {
          rampAudioParam(wet.gain, target, Number(ctx.currentTime) || 0, 0.02)
          rampAudioParam(dry.gain, 1 - target, Number(ctx.currentTime) || 0, 0.02)
        }
      }
      initialized = true
    },
    dispose() {
      try {
        unit?.dispose?.()
      } catch {
        /* ignore */
      }
      for (const node of [input, output, dry, wet, procIn, procOut]) {
        try {
          node.disconnect()
        } catch {
          /* ignore */
        }
      }
      unit = null
    },
  }
  wrapper.update(effect?.params, effect?.enabled !== false)
  return wrapper
}
