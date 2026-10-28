/**
 * R6a：确定性音乐生成器（纯函数，不碰 fs/网络）。
 *
 * - generatePart({kind,style,bars,barBeats,key,scale,seed,density,complexity,octave})
 *   → {notes:[{pitch,start,dur,vel}], summary:{kind,style,bars,noteCount,seed}}
 * - generateVariation({notes,seed,density,transpose,humanize}) → 新 notes
 *
 * seed 使用 mulberry32 派生（同一参数完全一致）；音高来自 theory.js 音阶/和弦；
 * drums 使用 GM 鼓件（36 kick / 38 snare / 39 clap / 42 closed hat / 46 open hat）。
 */
import {
  arpNotes,
  diatonicChords,
  mulberry32,
  noteNameToPitchClass,
  scalePitches,
  THEORY_SCALES,
} from './theory.js'

export const GENERATOR_KINDS = Object.freeze(['drums', 'bass', 'chords', 'lead', 'arp'])
export const GENERATOR_STYLES = Object.freeze(['house', 'techno', 'lofi', 'pop', 'cinematic'])

/** GM 鼓音高。 */
export const GM_DRUMS = Object.freeze({ kick: 36, snare: 38, clap: 39, closedHat: 42, openHat: 46 })

const STYLE_CONFIGS = Object.freeze({
  house: {
    kick: [0, 4, 8, 12], clap: [4, 12], snare: [], hat: [2, 6, 10, 14], openHat: [6, 14],
    bassGrid: [0, 3, 6, 8, 11, 14], bassOctave: 2, leadGrid: [0, 3, 6, 8, 11, 14],
    chordHits: [0, 2], chordBars: 1, arpPattern: 'up', arpRate: 0.25, arpOctaves: 2,
    progression: ['I', 'V', 'vi', 'IV'],
  },
  techno: {
    kick: [0, 4, 8, 12], clap: [4, 12], snare: [], hat: [0, 2, 4, 6, 8, 10, 12, 14], openHat: [2, 10],
    bassGrid: [2, 6, 10, 14], bassOctave: 2, leadGrid: [0, 2, 4, 6, 8, 10, 12, 14],
    chordHits: [0], chordBars: 1, arpPattern: 'updown', arpRate: 0.25, arpOctaves: 2,
    progression: ['i', 'VI', 'III', 'VII'],
  },
  lofi: {
    kick: [0, 7, 10], clap: [4, 12], snare: [], hat: [2, 6, 10, 14], openHat: [],
    bassGrid: [0, 6, 10], bassOctave: 2, leadGrid: [0, 2, 6, 8, 12],
    chordHits: [0, 2], chordBars: 2, arpPattern: 'random', arpRate: 0.5, arpOctaves: 1,
    progression: ['I', 'vi', 'IV', 'V'],
  },
  pop: {
    kick: [0, 8], clap: [4, 12], snare: [], hat: [0, 2, 4, 6, 8, 10, 12, 14], openHat: [],
    bassGrid: [0, 2, 4, 6, 8, 10, 12, 14], bassOctave: 2, leadGrid: [0, 2, 4, 6, 8, 10, 12, 14],
    chordHits: [0, 2], chordBars: 1, arpPattern: 'up', arpRate: 0.5, arpOctaves: 1,
    progression: ['I', 'V', 'vi', 'IV'],
  },
  cinematic: {
    kick: [0], clap: [12], snare: [], hat: [], openHat: [],
    bassGrid: [0, 8], bassOctave: 1, leadGrid: [0, 4, 8, 12],
    chordHits: [0], chordBars: 2, arpPattern: 'up', arpRate: 0.5, arpOctaves: 2,
    progression: ['i', 'VI', 'III', 'VII'],
  },
})

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const clamp01 = (value) => clamp(value, 0, 1)
const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits
const midiClamp = (pitch) => Math.round(clamp(pitch, 0, 127))

function styleConfig(style) {
  return STYLE_CONFIGS[style]
}

function hashSeed(text) {
  let hash = 2166136261
  for (let index = 0; index < String(text).length; index += 1) {
    hash ^= String(text).charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function makeRng(seed, salt = '') {
  return mulberry32((Number(seed) >>> 0) ^ hashSeed(salt))
}

/** 校验并规范化 generatePart 参数（导出供 Host 复用）。 */
export function normalizeGenerateOptions(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('生成器参数必须是对象')
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  if (!GENERATOR_KINDS.includes(kind)) throw new Error(`未知生成类型 kind=${kind || '?'}；可选：${GENERATOR_KINDS.join(' / ')}`)
  const style = raw.style === undefined || raw.style === null || raw.style === '' ? 'house' : String(raw.style).trim()
  if (!GENERATOR_STYLES.includes(style)) throw new Error(`未知风格 style=${style}；可选：${GENERATOR_STYLES.join(' / ')}`)
  const bars = raw.bars === undefined || raw.bars === null ? 4 : Number(raw.bars)
  if (!Number.isInteger(bars) || bars < 1 || bars > 64) throw new Error('bars 必须是 1..64 的整数')
  const barBeats = raw.barBeats === undefined || raw.barBeats === null ? 4 : Number(raw.barBeats)
  if (!Number.isInteger(barBeats) || barBeats < 1 || barBeats > 12) throw new Error('barBeats 必须是 1..12 的整数')
  const key = raw.key === undefined || raw.key === null || raw.key === '' ? 'C' : String(raw.key).trim()
  if (noteNameToPitchClass(key) === null) throw new Error(`未知调性 key=${key}`)
  const scale = raw.scale === undefined || raw.scale === null || raw.scale === '' ? 'minor' : String(raw.scale).trim()
  if (!THEORY_SCALES[scale]) throw new Error(`未知调式 scale=${scale}；可选：${Object.keys(THEORY_SCALES).join(' / ')}`)
  const seed = raw.seed === undefined || raw.seed === null ? 1 : Number(raw.seed)
  if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) throw new Error('seed 必须是 0..2147483647 的整数')
  const density = raw.density === undefined || raw.density === null ? 0.7 : Number(raw.density)
  if (!Number.isFinite(density) || density < 0 || density > 1) throw new Error('density 必须是 0..1 的数字')
  const complexity = raw.complexity === undefined || raw.complexity === null ? 0.5 : Number(raw.complexity)
  if (!Number.isFinite(complexity) || complexity < 0 || complexity > 1) throw new Error('complexity 必须是 0..1 的数字')
  const defaultOctave = kind === 'bass' ? 2 : kind === 'chords' ? 4 : kind === 'drums' ? 4 : 5
  const octave = raw.octave === undefined || raw.octave === null ? defaultOctave : Number(raw.octave)
  if (!Number.isInteger(octave) || octave < 0 || octave > 8) throw new Error('octave 必须是 0..8 的整数')
  return { kind, style, bars, barBeats, key, scale, seed, density, complexity, octave }
}

function stepTime(step, barBeats) {
  return round((step * barBeats) / 16, 4)
}

function velocity(rng, base = 0.7, spread = 0.15) {
  return round(clamp(base + (rng() - 0.5) * 2 * spread, 0.3, 1), 3)
}

function progressionChords(key, scale, octave, progression, barIndex) {
  const chords = diatonicChords(key, scale, octave)
  const roman = progression[barIndex % progression.length]
  const degreeIndex = chords.findIndex((chord) => chord.roman === roman || chord.roman.toLowerCase() === roman.toLowerCase())
  return chords[degreeIndex >= 0 ? degreeIndex : 0]
}

function driftPitch(pitch, candidates, rng, chance = 0.15) {
  if (rng() > chance) return midiClamp(pitch)
  return midiClamp(candidates[Math.floor(rng() * candidates.length)] ?? pitch)
}

function generateDrums(options, config) {
  const { bars, barBeats, seed, density, complexity } = options
  const rng = makeRng(seed, 'drums')
  const notes = []
  for (let bar = 0; bar < bars; bar += 1) {
    const barStart = bar * barBeats
    const add = (step, pitch, baseVel, spread) => {
      const start = barStart + stepTime(step, barBeats)
      if (start >= bars * barBeats) return
      notes.push({ pitch, start: round(start, 4), dur: round(Math.min(barBeats / 16, 0.25), 4), vel: velocity(rng, baseVel, spread) })
    }
    for (const step of config.kick) if (rng() < 0.7 + density * 0.3) add(step, GM_DRUMS.kick, 0.9, 0.08)
    for (const step of config.clap) if (rng() < 0.5 + density * 0.5) add(step, GM_DRUMS.clap, 0.78, 0.12)
    for (const step of config.snare) if (rng() < 0.5 + density * 0.5) add(step, GM_DRUMS.snare, 0.8, 0.1)
    for (const step of config.hat) {
      if (rng() < 0.45 + density * 0.55) add(step, GM_DRUMS.closedHat, 0.55, 0.14)
    }
    for (const step of config.openHat) if (rng() < 0.35 + density * 0.5) add(step, GM_DRUMS.openHat, 0.6, 0.12)
    // complexity：偶发 16 分鬼音/额外 kick
    const extras = Math.round(complexity * 3)
    for (let index = 0; index < extras; index += 1) {
      if (rng() < density * 0.5) add(Math.floor(rng() * 16), GM_DRUMS.closedHat, 0.45, 0.1)
    }
  }
  return notes
}

function generateBass(options, config) {
  const { bars, barBeats, key, scale, seed, density, complexity, octave } = options
  const rng = makeRng(seed, 'bass')
  const scaleNotes = scalePitches(key, scale, octave)
  const notes = []
  for (let bar = 0; bar < bars; bar += 1) {
    const barStart = bar * barBeats
    const chord = progressionChords(key, scale, octave, config.progression, bar)
    const rootBase = chord.pitches[0]
    for (const baseStep of config.bassGrid) {
      if (rng() > 0.5 + density * 0.5) continue
      const step = baseStep + (complexity > 0.6 && rng() < 0.2 ? 1 : 0)
      const start = barStart + stepTime(step, barBeats)
      if (start >= bars * barBeats) continue
      let pitch = rootBase
      if (rng() < complexity * 0.4) pitch = driftPitch(rootBase + 12, scaleNotes, rng, 0.6)
      else if (rng() < 0.2) pitch = rootBase + 7
      notes.push({ pitch: midiClamp(pitch), start: round(start, 4), dur: round(Math.min(barBeats / 8, 0.5), 4), vel: velocity(rng, 0.72, 0.12) })
    }
  }
  return notes
}

function generateChords(options, config) {
  const { bars, barBeats, key, scale, seed, density, octave } = options
  const rng = makeRng(seed, 'chords')
  const notes = []
  for (let bar = 0; bar < bars; bar += 1) {
    if (bar % config.chordBars !== 0) continue
    const chord = progressionChords(key, scale, octave, config.progression, bar)
    const span = Math.min(config.chordBars, bars - bar) * barBeats
    const hits = config.chordHits.filter((hit) => (hit / barBeats) * barBeats < barBeats)
    if (hits.length === 0) hits.push(0)
    for (const beat of hits) {
      if (rng() > 0.55 + density * 0.45) continue
      const start = bar * barBeats + beat
      if (start >= bars * barBeats) continue
      const dur = round(Math.min(Math.max(barBeats / 2, 0.5), bars * barBeats - start), 4)
      chord.pitches.forEach((pitch, index) => {
        const velocityValue = velocity(rng, 0.6 - index * 0.02, 0.08)
        notes.push({ pitch: midiClamp(pitch), start: round(start, 4), dur, vel: velocityValue })
      })
    }
    // 长音铺底：每和弦首拍加低八度
    if (rng() < 0.4 + density * 0.3) {
      const start = bar * barBeats
      notes.push({ pitch: midiClamp(chord.pitches[0] - 12), start, dur: round(Math.max(span, barBeats), 4), vel: velocity(rng, 0.5, 0.07) })
    }
  }
  return notes
}

function generateLead(options, config) {
  const { bars, barBeats, key, scale, seed, density, complexity, octave } = options
  const rng = makeRng(seed, 'lead')
  const scaleNotes = scalePitches(key, scale, octave)
  const notes = []
  for (let bar = 0; bar < bars; bar += 1) {
    const barStart = bar * barBeats
    const chord = progressionChords(key, scale, octave, config.progression, bar)
    const chordTones = chord.pitches.map((pitch) => midiClamp(pitch + (octave >= 5 ? 0 : 12)))
    const pool = [...new Set([...chordTones, ...scaleNotes])]
    for (const baseStep of config.leadGrid) {
      if (rng() > 0.35 + density * 0.65) continue
      const step = baseStep + (complexity > 0.5 && rng() < 0.25 ? 1 : 0)
      const start = barStart + stepTime(step, barBeats)
      if (start >= bars * barBeats) continue
      let pitch = pool[Math.floor(rng() * pool.length)] ?? scaleNotes[0]
      if (rng() < 0.15) pitch += 12
      const gate = 0.5 + complexity * 0.4
      notes.push({
        pitch: midiClamp(pitch),
        start: round(start, 4),
        dur: round(Math.max(0.1, (barBeats / 8) * gate), 4),
        vel: velocity(rng, 0.7, 0.14),
      })
    }
  }
  return notes
}

function generateArp(options, config) {
  const { bars, barBeats, key, scale, seed, density, octave } = options
  const notes = []
  for (let bar = 0; bar < bars; bar += 1) {
    const chord = progressionChords(key, scale, octave, config.progression, bar)
    const base = chord.pitches.map((pitch) => midiClamp(pitch))
    const patternIndex = Math.floor(makeRng(seed, `arp-pattern-${bar}`)() * 4)
    const pattern = config.arpPattern === 'random' ? ['up', 'down', 'updown'][patternIndex] : config.arpPattern
    const generated = arpNotes({
      chordPitches: base,
      pattern,
      rate: config.arpRate,
      beats: barBeats,
      octaves: config.arpOctaves,
      gate: 0.6 + density * 0.3,
      velocity: 0.55 + density * 0.25,
      seed: (Number(seed) >>> 0) + bar * 7919,
    })
    const velRng = makeRng((Number(seed) >>> 0) + bar * 104729, 'arp-vel')
    for (const note of generated) {
      if (note.start >= barBeats) continue
      const start = bar * barBeats + note.start
      if (start >= bars * barBeats) continue
      const jitter = (velRng() - 0.5) * 0.08
      notes.push({
        pitch: midiClamp(note.pitch),
        start: round(start, 4),
        dur: round(Math.min(note.dur, bars * barBeats - start), 4),
        vel: round(clamp(note.vel + jitter, 0.3, 1), 3),
      })
    }
  }
  return notes
}

function normalizeNotes(notes, maxStart, maxCount) {
  const output = []
  for (const note of notes) {
    if (output.length >= maxCount) break
    const start = Number(note.start)
    const dur = Number(note.dur)
    const pitch = Number(note.pitch)
    const vel = Number(note.vel)
    if (![start, dur, pitch, vel].every((value) => Number.isFinite(value))) continue
    if (start < 0 || start >= maxStart || dur <= 0) continue
    output.push({
      pitch: midiClamp(pitch),
      start: round(start, 4),
      dur: round(Math.min(dur, maxStart - start), 4),
      vel: round(clamp(vel, 0.3, 1), 3),
    })
  }
  output.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return output
}

/**
 * 确定性生成一个声部。
 * @returns {{notes:Array<{pitch:number,start:number,dur:number,vel:number}>, summary:object}}
 */
export function generatePart(raw = {}) {
  const options = normalizeGenerateOptions(raw)
  const config = styleConfig(options.style)
  const total = options.bars * options.barBeats
  const maxCount = options.bars * 16
  let notes
  if (options.kind === 'drums') notes = generateDrums(options, config)
  else if (options.kind === 'bass') notes = generateBass(options, config)
  else if (options.kind === 'chords') notes = generateChords(options, config)
  else if (options.kind === 'lead') notes = generateLead(options, config)
  else notes = generateArp(options, config)
  const normalized = normalizeNotes(notes, total, maxCount)
  return {
    notes: normalized,
    summary: {
      kind: options.kind,
      style: options.style,
      bars: options.bars,
      noteCount: normalized.length,
      seed: options.seed,
    },
  }
}

/**
 * 确定性变体：按 density 保留/删除、transpose 移调、humanize 微时序/力度抖动、
 * 偶发八度跳变；不越出原 notes 的时间范围/音高 0..127。
 * @returns {Array<{pitch:number,start:number,dur:number,vel:number}>}
 */
export function generateVariation(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('variation 参数必须是对象')
  const source = Array.isArray(raw.notes) ? raw.notes : []
  if (source.length === 0) throw new Error('variation 需要非空 notes')
  const seed = raw.seed === undefined || raw.seed === null ? 1 : Number(raw.seed)
  if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) throw new Error('variation seed 必须是 0..2147483647 的整数')
  const density = raw.density === undefined || raw.density === null ? 0.8 : Number(raw.density)
  if (!Number.isFinite(density) || density < 0 || density > 2) throw new Error('variation density 必须是 0..2 的数字')
  const transpose = raw.transpose === undefined || raw.transpose === null ? 0 : Number(raw.transpose)
  if (!Number.isInteger(transpose) || transpose < -24 || transpose > 24) throw new Error('variation transpose 必须是 -24..24 的整数')
  const humanize = raw.humanize === undefined || raw.humanize === null ? 0.1 : Number(raw.humanize)
  if (!Number.isFinite(humanize) || humanize < 0 || humanize > 1) throw new Error('variation humanize 必须是 0..1 的数字')
  const bounds = source.reduce((acc, note) => {
    const start = Number(note?.start)
    const dur = Number(note?.dur)
    if (!Number.isFinite(start) || !Number.isFinite(dur)) return acc
    return { start: Math.min(acc.start, start), end: Math.max(acc.end, start + dur) }
  }, { start: 0, end: 0 })
  const rng = makeRng(seed, 'variation')
  const output = []
  for (const note of source) {
    const keepChance = Math.min(1, density)
    if (rng() > keepChance) continue
    const startJitter = humanize * 0.06 * (rng() - 0.5) * 2
    const velJitter = humanize * 0.12 * (rng() - 0.5) * 2
    let pitch = Number(note.pitch) + transpose
    if (rng() < humanize * 0.25) pitch += rng() < 0.5 ? -12 : 12
    let start = Number(note.start) + startJitter
    start = Math.max(bounds.start, Math.min(Math.max(bounds.start, bounds.end - 0.01), start))
    const dur = Math.max(0.01, Number(note.dur))
    output.push({
      pitch: midiClamp(pitch),
      start: round(start, 4),
      dur: round(Math.min(dur, Math.max(0.01, bounds.end - start)), 4),
      vel: round(clamp(Number(note.vel) + velJitter, 0.3, 1), 3),
    })
  }
  if (output.length === 0) {
    const first = source[0]
    return [{
      pitch: midiClamp(Number(first.pitch) + transpose),
      start: round(Math.max(bounds.start, Number(first.start)), 4),
      dur: round(Math.max(0.01, Number(first.dur)), 4),
      vel: round(clamp(Number(first.vel), 0.3, 1), 3),
    }]
  }
  output.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return output
}

/** 供测试/工具读取风格配置摘要。 */
export function listGeneratorStyles() {
  return GENERATOR_STYLES.map((style) => ({
    style,
    drums: { ...STYLE_CONFIGS[style], kick: [...STYLE_CONFIGS[style].kick], clap: [...STYLE_CONFIGS[style].clap] },
  }))
}
