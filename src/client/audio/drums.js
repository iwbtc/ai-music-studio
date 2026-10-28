/**
 * 鼓机音色合成（audio-engine）。
 *
 * 5 套 DRUM_KITS × 11 个 DRUM_PIECES：全部用「振荡器 + 白噪声 + 包络 + 滤波 + 过载」
 * 现场合成，不依赖采样文件。每个鼓件有独立的瞬态/音高/衰减设计，鼓组参数
 * （kickPitch / kickDecay / kickDrive / snareTone / clapSpread / hatDecay / drive / level）
 * 与鼓组个性（KIT_STYLE）共同决定最终听感。
 *
 * 模块加载时不做任何 Web Audio 调用，Node 单测可 import 纯参数函数。
 */
import { pitchToFreq } from '../../shared/model.js'
import { DRUM_PARAM_SPECS, findDrumKit, findDrumPiece, coerceParam } from '../../shared/catalog.js'
import { clamp, clamp01, makeDriveCurve, getNoiseBuffer, hashSeed, mulberry32 } from './dsp.js'

/** DRUM_PARAM_SPECS 默认值（catalog 是唯一权威）。 */
export const DRUM_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(DRUM_PARAM_SPECS).map(([key, spec]) => [key, spec.default])),
)

/** 按 spec 钳制鼓组参数。 */
export function coerceDrumParams(raw = {}) {
  const out = {}
  for (const [key, spec] of Object.entries(DRUM_PARAM_SPECS)) {
    const value = coerceParam(spec, raw?.[key])
    out[key] = value === undefined ? spec.default : value
  }
  return out
}

/** 解析一条鼓轨实际生效的鼓组参数：默认值 ← kit.params ← track.instrument.params。 */
export function resolveDrumParams(track) {
  const kit = findDrumKit(track?.instrument?.kit) ?? null
  return coerceDrumParams({
    ...DRUM_DEFAULTS,
    ...(kit?.params ?? {}),
    ...(track?.instrument?.params ?? {}),
  })
}

/** MIDI 音高 → 标准鼓件定义（找不到返回 null）。 */
export function drumPieceForPitch(pitch) {
  const p = Math.round(Number(pitch))
  if (!Number.isFinite(p)) return null
  return findDrumPiece(p) ?? null
}

/** 11 个鼓件的 id 列表（与 catalog 保持一致，便于 UI / 测试核对）。 */
export const DRUM_PIECE_IDS = Object.freeze([
  'kick', 'snare', 'clap', 'rim', 'hat', 'openhat', 'tomLow', 'tomHigh', 'crash', 'ride', 'perc',
])

/** 鼓组「个性」：在 kit 参数之外，给每套鼓不同的瞬态/亮度/饱和度。 */
const KIT_STYLE = {
  neon808: {
    kickPitchScale: 0.92, kickClick: 0.55, kickDecayScale: 1.0,
    snareDecayScale: 1.0, hatBright: 1.0, hatDecayScale: 1.0,
    tomPitchScale: 1.0, metallic: 1.0,
  },
  club: {
    kickPitchScale: 1.0, kickClick: 1.1, kickDecayScale: 0.82,
    snareDecayScale: 0.85, hatBright: 1.06, hatDecayScale: 0.92,
    tomPitchScale: 1.0, metallic: 0.95,
  },
  techno: {
    kickPitchScale: 0.88, kickClick: 1.55, kickDecayScale: 1.05,
    snareDecayScale: 0.9, hatBright: 1.22, hatDecayScale: 0.78,
    tomPitchScale: 0.95, metallic: 1.28,
  },
  lofi: {
    kickPitchScale: 0.94, kickClick: 0.3, kickDecayScale: 1.12,
    snareDecayScale: 1.3, hatBright: 0.72, hatDecayScale: 1.35,
    tomPitchScale: 0.97, metallic: 0.68, toneFilter: 5600,
  },
  dnb: {
    kickPitchScale: 1.02, kickClick: 1.3, kickDecayScale: 0.6,
    snareDecayScale: 0.8, hatBright: 1.28, hatDecayScale: 0.68,
    tomPitchScale: 1.05, metallic: 1.12,
  },
  retro: {
    kickPitchScale: 0.96, kickClick: 1.0, kickDecayScale: 0.9,
    snareDecayScale: 0.95, hatBright: 1.1, hatDecayScale: 0.9,
    tomPitchScale: 1.0, metallic: 1.15,
  },
  garage: {
    kickPitchScale: 0.98, kickClick: 0.8, kickDecayScale: 0.95,
    snareDecayScale: 1.1, hatBright: 0.95, hatDecayScale: 0.82,
    tomPitchScale: 1.0, metallic: 0.9,
  },
  industrial: {
    kickPitchScale: 0.9, kickClick: 1.9, kickDecayScale: 1.15,
    snareDecayScale: 0.8, hatBright: 1.3, hatDecayScale: 0.72,
    tomPitchScale: 0.95, metallic: 1.4,
  },
}

/** 各鼓件的声像（让鼓组有立体声宽度）。 */
const PIECE_PAN = {
  kick: 0, snare: 0.02, clap: -0.06, rim: 0.24, hat: 0.16, openhat: 0.2,
  tomLow: -0.32, tomHigh: 0.3, crash: -0.22, ride: 0.28, perc: 0.1,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function makeFilter(ctx, type, frequency, Q = 0.8, gainDb = 0) {
  const filter = ctx.createBiquadFilter()
  filter.type = type
  filter.frequency.value = clamp(frequency, 20, 20000)
  filter.Q.value = clamp(Q, 0.0001, 30)
  if (type === 'lowshelf' || type === 'highshelf' || type === 'peaking') filter.gain.value = clamp(gainDb, -40, 40)
  return filter
}

/** 噪声源（循环白噪声，按确定性偏移起播避免所有鼓件相位一致；同工程重复渲染逐位一致）。 */
function makeNoise(ctx, sources, t0, duration) {
  const buffer = getNoiseBuffer(ctx, 2)
  if (!buffer) return null
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.loop = true
  const dur = Math.max(0.01, duration)
  try {
    // 确定性偏移：由起播时间/时长/缓冲区时长派生，不再用 Math.random()
    const maxOffset = Math.max(0.01, (buffer.duration || 2) - dur - 0.1)
    const random = mulberry32(hashSeed('drum-noise-offset', Math.round(t0 * 1e6), Math.round(dur * 1e6), Number(buffer.duration) || 2))
    const offset = random() * maxOffset
    src.start(t0, offset)
  } catch {
    try {
      src.start(t0)
    } catch {
      return null
    }
  }
  try {
    src.stop(t0 + dur + 0.08)
  } catch {
    /* ignore */
  }
  sources.push(src)
  return src
}

function makeOsc(ctx, sources, type, frequency, t0, stopAt) {
  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.value = clamp(frequency, 4, 20000)
  try {
    osc.start(t0)
    osc.stop(stopAt)
  } catch {
    /* ignore */
  }
  sources.push(osc)
  return osc
}

/** AD 包络（用于鼓的瞬态）：极快 attack + 指数衰减。 */
function makeEnv(ctx, t0, peak, attack, decay) {
  const gain = ctx.createGain()
  const p = Math.max(0.0004, peak)
  const a = Math.max(0.0004, attack)
  const d = Math.max(a + 0.003, decay)
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.linearRampToValueAtTime(p, t0 + a)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + d)
  return gain
}

function chain(from, nodes, to) {
  let prev = from
  for (const node of nodes) {
    prev.connect(node)
    prev = node
  }
  prev.connect(to)
}

// ---------------------------------------------------------------------------
// 11 个鼓件
// ---------------------------------------------------------------------------

function buildKick(rig) {
  const { ctx, bus, t0, p, style, sources, owned } = rig
  const base = Math.max(28, pitchToFreq(clamp(p.kickPitch, 30, 80)) * (style.kickPitchScale ?? 1))
  const decay = Math.max(0.08, clamp(p.kickDecay, 0.1, 1.5) * (style.kickDecayScale ?? 1))
  const bodyStop = t0 + decay + 0.12

  const body = makeOsc(ctx, sources, 'sine', base, t0, bodyStop)
  const clickAmt = style.kickClick ?? 0.6
  body.frequency.setValueAtTime(base * (2.4 + clickAmt * 1.2), t0)
  body.frequency.exponentialRampToValueAtTime(base, t0 + 0.055)
  body.frequency.exponentialRampToValueAtTime(base * 0.93, t0 + decay * 0.85)

  const bodyGain = makeEnv(ctx, t0, 0.95, 0.003, decay)
  const kickDrive = clamp01(p.kickDrive)
  if (kickDrive > 0.04) {
    const pre = ctx.createGain()
    pre.gain.value = 1 + kickDrive * 4
    const shaper = ctx.createWaveShaper()
    shaper.curve = makeDriveCurve(kickDrive * 0.9)
    shaper.oversample = '2x'
    const post = ctx.createGain()
    post.gain.value = 1 / (1 + kickDrive * 1.6)
    chain(body, [pre, shaper, post], bodyGain)
    owned.push(pre, shaper, post)
  } else {
    body.connect(bodyGain)
  }
  bodyGain.connect(bus)
  owned.push(bodyGain)

  // 808 长尾次低频
  const subDecay = decay * 1.15
  const sub = makeOsc(ctx, sources, 'sine', base / 2, t0, t0 + subDecay + 0.12)
  const subGain = makeEnv(ctx, t0, 0.3, 0.004, subDecay)
  sub.connect(subGain)
  subGain.connect(bus)
  owned.push(subGain)

  // 打点 click（高通过滤噪声，给底鼓「冲击感」）
  const noise = makeNoise(ctx, sources, t0, 0.035)
  if (noise) {
    const hp = makeFilter(ctx, 'highpass', 1500 + clickAmt * 1700, 0.9)
    const ng = makeEnv(ctx, t0, 0.16 + clickAmt * 0.24, 0.0006, 0.014)
    chain(noise, [hp, ng], bus)
    owned.push(hp, ng)
  }
  return bodyStop + 0.05
}

function buildSnare(rig) {
  const { ctx, bus, t0, p, style, sources, owned } = rig
  const tone = clamp01(p.snareTone)
  const scale = style.snareDecayScale ?? 1

  // 噪声主体
  const noise = makeNoise(ctx, sources, t0, 0.45)
  if (noise) {
    const hp = makeFilter(ctx, 'highpass', 380, 0.7)
    const bp = makeFilter(ctx, 'bandpass', 1300 + tone * 2600, 0.85)
    const ng = makeEnv(ctx, t0, 0.58 + (1 - tone) * 0.12, 0.0008, 0.15 * scale)
    chain(noise, [hp, bp, ng], bus)
    owned.push(hp, bp, ng)
  }

  // 两个鼓腔正弦：音高下滑，提供「军鼓体」
  const body = makeOsc(ctx, sources, 'triangle', 200 + tone * 70, t0, t0 + 0.35)
  body.frequency.setValueAtTime(250 + tone * 80, t0)
  body.frequency.exponentialRampToValueAtTime(168 + tone * 42, t0 + 0.06)
  const bodyGain = makeEnv(ctx, t0, 0.5, 0.0012, 0.1 * scale)
  body.connect(bodyGain)
  bodyGain.connect(bus)
  owned.push(bodyGain)

  const body2 = makeOsc(ctx, sources, 'sine', 330 + tone * 60, t0, t0 + 0.25)
  body2.frequency.exponentialRampToValueAtTime(250, t0 + 0.05)
  const body2Gain = makeEnv(ctx, t0, 0.22, 0.001, 0.06 * scale)
  body2.connect(body2Gain)
  body2Gain.connect(bus)
  owned.push(body2Gain)
  return t0 + 0.5
}

function buildClap(rig) {
  const { ctx, bus, t0, p, sources, owned } = rig
  const spread = clamp01(p.clapSpread)
  const spacing = 0.006 + spread * 0.016
  let stopAt = t0 + 0.3
  for (let i = 0; i < 3; i++) {
    const at = t0 + i * spacing
    const noise = makeNoise(ctx, sources, at, 0.1)
    if (!noise) continue
    const bp = makeFilter(ctx, 'bandpass', 1100 + spread * 700, 1.15)
    const g = makeEnv(ctx, at, 0.46 - i * 0.07, 0.0006, 0.032)
    chain(noise, [bp, g], bus)
    owned.push(bp, g)
  }
  // 拍手尾音（短混响感）
  const tail = makeNoise(ctx, sources, t0 + spacing * 2, 0.32)
  if (tail) {
    const bp = makeFilter(ctx, 'bandpass', 1250 + spread * 500, 0.9)
    const g = makeEnv(ctx, t0 + spacing * 2, 0.2, 0.001, 0.17)
    chain(tail, [bp, g], bus)
    owned.push(bp, g)
    stopAt = t0 + spacing * 2 + 0.4
  }
  return stopAt
}

function buildRim(rig) {
  const { ctx, bus, t0, sources, owned } = rig
  const noise = makeNoise(ctx, sources, t0, 0.06)
  if (noise) {
    const bp = makeFilter(ctx, 'bandpass', 2800, 1.6)
    const g = makeEnv(ctx, t0, 0.3, 0.0005, 0.018)
    chain(noise, [bp, g], bus)
    owned.push(bp, g)
  }
  const osc = makeOsc(ctx, sources, 'triangle', 860, t0, t0 + 0.09)
  osc.frequency.exponentialRampToValueAtTime(640, t0 + 0.025)
  const og = makeEnv(ctx, t0, 0.24, 0.0005, 0.03)
  osc.connect(og)
  og.connect(bus)
  owned.push(og)
  return t0 + 0.12
}

function buildHat(rig, open) {
  const { ctx, bus, t0, p, style, sources, owned } = rig
  const hatDecay = clamp(p.hatDecay, 0.01, 0.4)
  const decay = open ? 0.2 + hatDecay * 3.4 : Math.max(0.02, hatDecay * (style.hatDecayScale ?? 1))
  const bright = style.hatBright ?? 1
  const stopAt = t0 + decay + 0.2

  const noise = makeNoise(ctx, sources, t0, decay + 0.12)
  if (noise) {
    const hp = makeFilter(ctx, 'highpass', (open ? 6200 : 7400) * bright, 0.85)
    const bp = makeFilter(ctx, 'bandpass', (open ? 9000 : 10600) * bright, 0.55)
    const g = makeEnv(ctx, t0, open ? 0.3 : 0.42, 0.0006, decay)
    chain(noise, [hp, bp, g], bus)
    owned.push(hp, bp, g)
  }

  // 808 式金属泛音（方波 + 高通）：让踩镲有「金属质感」而不是纯噪声
  const ratios = open ? [2.1, 3.2, 4.7, 6.1] : [2.1, 3.4, 5.2]
  const metal = 0.032 * (style.metallic ?? 1)
  for (const ratio of ratios) {
    const osc = makeOsc(ctx, sources, 'square', 317 * ratio * bright, t0, stopAt)
    const hp = makeFilter(ctx, 'highpass', (open ? 6800 : 7800) * bright, 0.7)
    const g = makeEnv(ctx, t0, metal, 0.0006, decay * 0.85)
    chain(osc, [hp, g], bus)
    owned.push(hp, g)
  }
  return stopAt
}

function buildTom(rig) {
  const { ctx, bus, t0, p, style, piece, sources, owned } = rig
  const base = Math.max(30, pitchToFreq(piece.pitch) * (style.tomPitchScale ?? 1))
  const decay = (piece.id === 'tomLow' ? 0.34 : 0.24) * (style.kickDecayScale ?? 1)
  const stopAt = t0 + decay + 0.12
  const osc = makeOsc(ctx, sources, 'sine', base, t0, stopAt)
  osc.frequency.setValueAtTime(base * 1.7, t0)
  osc.frequency.exponentialRampToValueAtTime(base, t0 + 0.07)
  osc.frequency.exponentialRampToValueAtTime(base * 0.94, t0 + decay)
  const g = makeEnv(ctx, t0, 0.78, 0.002, decay)
  osc.connect(g)
  g.connect(bus)
  owned.push(g)

  const noise = makeNoise(ctx, sources, t0, 0.05)
  if (noise) {
    const bp = makeFilter(ctx, 'bandpass', 900 + clamp(p.snareTone, 0, 1) * 900, 1.1)
    const ng = makeEnv(ctx, t0, 0.14, 0.0006, 0.022)
    chain(noise, [bp, ng], bus)
    owned.push(bp, ng)
  }
  return stopAt
}

function buildCrash(rig) {
  const { ctx, bus, t0, style, sources, owned } = rig
  const metal = style.metallic ?? 1
  const stopAt = t0 + 1.45
  const noise = makeNoise(ctx, sources, t0, 1.25)
  if (noise) {
    const hp = makeFilter(ctx, 'highpass', 4200, 0.7)
    const bp = makeFilter(ctx, 'bandpass', 7200, 0.5)
    const g = makeEnv(ctx, t0, 0.34, 0.001, 1.2)
    chain(noise, [hp, bp, g], bus)
    owned.push(hp, bp, g)
  }
  for (const ratio of [3.2, 4.1, 5.3, 6.4, 7.8]) {
    const osc = makeOsc(ctx, sources, 'square', 317 * ratio, t0, stopAt)
    const hp = makeFilter(ctx, 'highpass', 4600, 0.6)
    const g = makeEnv(ctx, t0, 0.026 * metal, 0.001, 1.05)
    chain(osc, [hp, g], bus)
    owned.push(hp, g)
  }
  return stopAt
}

function buildRide(rig) {
  const { ctx, bus, t0, style, sources, owned } = rig
  const metal = style.metallic ?? 1
  const stopAt = t0 + 0.85
  // 叮叮的「ping」
  const ping = makeOsc(ctx, sources, 'sine', 3150, t0, stopAt)
  const pingG = makeEnv(ctx, t0, 0.1, 0.001, 0.55)
  ping.connect(pingG)
  pingG.connect(bus)
  owned.push(pingG)

  for (const ratio of [3.3, 4.9, 6.6]) {
    const osc = makeOsc(ctx, sources, 'square', 317 * ratio, t0, stopAt)
    const bp = makeFilter(ctx, 'bandpass', 5200, 1.2)
    const g = makeEnv(ctx, t0, 0.045 * metal, 0.0008, 0.42)
    chain(osc, [bp, g], bus)
    owned.push(bp, g)
  }
  const noise = makeNoise(ctx, sources, t0, 0.5)
  if (noise) {
    const bp = makeFilter(ctx, 'bandpass', 7800, 0.7)
    const g = makeEnv(ctx, t0, 0.09, 0.0008, 0.36)
    chain(noise, [bp, g], bus)
    owned.push(bp, g)
  }
  return stopAt
}

function buildPerc(rig) {
  const { ctx, bus, t0, sources, owned } = rig
  const osc = makeOsc(ctx, sources, 'sine', 1180, t0, t0 + 0.12)
  osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.045)
  const g = makeEnv(ctx, t0, 0.46, 0.0008, 0.07)
  osc.connect(g)
  g.connect(bus)
  owned.push(g)

  const noise = makeNoise(ctx, sources, t0, 0.06)
  if (noise) {
    const bp = makeFilter(ctx, 'bandpass', 2600, 1.4)
    const ng = makeEnv(ctx, t0, 0.26, 0.0006, 0.03)
    chain(noise, [bp, ng], bus)
    owned.push(bp, ng)
  }
  return t0 + 0.14
}

const PIECE_BUILDERS = {
  kick: buildKick,
  snare: buildSnare,
  clap: buildClap,
  rim: buildRim,
  hat: (rig) => buildHat(rig, false),
  openhat: (rig) => buildHat(rig, true),
  tomLow: buildTom,
  tomHigh: buildTom,
  crash: buildCrash,
  ride: buildRide,
  perc: buildPerc,
}

/**
 * 构建一次鼓击。
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination track 输入节点
 * @param {{pitch:number, vel?:number, startTime:number, piece?:object}} hit
 * @param {ReturnType<typeof resolveDrumParams>} params
 * @param {{kitId?:string, pan?:number, gainScale?:number}} opts
 * @returns {{type:'drum', endTime:number, stop:(when?:number)=>void}|null}
 */
export function buildDrumHit(ctx, destination, hit, params, opts = {}) {
  const piece = hit?.piece ?? drumPieceForPitch(hit?.pitch)
  const builder = piece ? PIECE_BUILDERS[piece.id] : null
  if (!builder) return null
  const p = params ?? DRUM_DEFAULTS
  const kit = findDrumKit(opts.kitId) ?? null
  const style = KIT_STYLE[kit?.id] ?? KIT_STYLE.neon808
  const now = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0
  const t0 = Math.max(Number(hit?.startTime) || 0, now + 0.001)
  const vel = clamp01(hit?.vel ?? 0.8)
  const sources = []
  const owned = []

  // 总输出：电平 → （Lo-Fi 低通）→ 鼓组过载 → 声像 → destination
  const bus = ctx.createGain()
  bus.gain.value = clamp(p.level, 0, 1) * (0.55 + vel * 0.6) * clamp(Number(opts.gainScale) || 1, 0, 3)
  owned.push(bus)
  let tail = bus

  if (style.toneFilter) {
    const lp = makeFilter(ctx, 'lowpass', style.toneFilter, 0.6)
    tail.connect(lp)
    tail = lp
    owned.push(lp)
  }

  const drive = clamp01(p.drive)
  if (drive > 0.04) {
    const pre = ctx.createGain()
    pre.gain.value = 1 + drive * 3
    const shaper = ctx.createWaveShaper()
    shaper.curve = makeDriveCurve(drive * 0.85)
    shaper.oversample = '2x'
    const post = ctx.createGain()
    post.gain.value = 1 / (1 + drive * 1.3)
    tail.connect(pre)
    pre.connect(shaper)
    shaper.connect(post)
    tail = post
    owned.push(pre, shaper, post)
  }

  if (typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner()
    panner.pan.value = clamp((Number(opts.pan) || 0) + (PIECE_PAN[piece.id] ?? 0), -1, 1)
    tail.connect(panner)
    tail = panner
    owned.push(panner)
  }
  tail.connect(destination)

  const rig = { ctx, bus, t0, p, style, piece, sources, owned }
  const endTime = Math.max(builder(rig) || t0 + 0.2, t0 + 0.1) + 0.05

  // 所有 source 结束后断开节点，及时释放音频图
  let live = sources.length
  const cleanup = () => {
    for (const node of owned) {
      try {
        node.disconnect()
      } catch {
        /* ignore */
      }
    }
  }
  if (live === 0) cleanup()
  else {
    const onEnded = () => {
      live -= 1
      if (live <= 0) cleanup()
    }
    for (const src of sources) {
      try {
        src.addEventListener('ended', onEnded)
      } catch {
        src.onended = onEnded
      }
    }
  }

  const stop = (when) => {
    const w = Math.max(now, Number(when) || now)
    try {
      bus.gain.cancelScheduledValues(w)
      bus.gain.setTargetAtTime(0.0001, w, 0.004)
    } catch {
      try {
        bus.gain.value = 0
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

  return { type: 'drum', endTime, stop, release: cleanup, piece: piece.id }
}
