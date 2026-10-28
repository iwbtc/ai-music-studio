/**
 * R3a：乐理纯函数（音名 / 音阶 / 级数 / 和弦 / 罗马数字 / 琶音 / Groove / 量化）。
 *
 * 本模块不依赖 DOM/宿主，可被 Host 工具、UI 与单测共同使用。
 * 约定：
 * - pitch = MIDI 音高 0..127；pitch class = 0..11（C=0）。
 * - 和弦音高数组一律升序（0..127 夹紧）。
 * - arp/groove/quantize 都是纯函数，返回新数组，不修改入参；random 用固定 seed（mulberry32）。
 */

/** 12 音名（升号优先）。 */
export const NOTE_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])
/** 12 音名（降号拼写，用于 pitchClassToName(pc, true) 与展示）。 */
export const FLAT_NOTE_NAMES = Object.freeze(['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'])

/** 音名 → pitch class（支持 C/C#/Db/Bb 等，大小写、带八度均可；非法返回 null）。 */
export function noteNameToPitchClass(name) {
  if (typeof name !== 'string') return null
  const text = name.trim()
  if (text === '') return null
  // 允许 C4 / F#3 / Bb-1 这类写法：去掉尾部八度。
  const match = /^([A-Ga-g])([#b♯♭]?)(-?\d+)?$/.exec(text)
  if (!match) return null
  const letter = match[1].toUpperCase()
  const accidental = match[2]
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter]
  if (base === undefined) return null
  const delta = accidental === '#' || accidental === '♯' ? 1 : accidental === 'b' || accidental === '♭' ? -1 : 0
  return ((base + delta) % 12 + 12) % 12
}

/** pitch class → 音名（preferFlat=true 用降号拼写）。 */
export function pitchClassToName(pc, preferFlat = false) {
  const value = Number(pc)
  if (!Number.isFinite(value)) return null
  const index = ((Math.round(value) % 12) + 12) % 12
  return (preferFlat ? FLAT_NOTE_NAMES : NOTE_NAMES)[index]
}

/** MIDI 音高 → 音名（如 60 → C4；61 → C#4）。 */
export function midiToName(pitch) {
  if (pitch === null || pitch === undefined || pitch === '') return null
  const value = Number(pitch)
  if (!Number.isFinite(value)) return null
  const clamped = Math.max(0, Math.min(127, Math.round(value)))
  return `${NOTE_NAMES[clamped % 12]}${Math.floor(clamped / 12) - 1}`
}

/** 音阶定义（与 catalog.SCALES 的 id/steps 保持一致）。 */
export const THEORY_SCALES = Object.freeze({
  major: { id: 'major', label: '自然大调', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { id: 'minor', label: '自然小调', steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { id: 'dorian', label: '多利亚', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { id: 'phrygian', label: '弗里几亚', steps: [0, 1, 3, 5, 7, 8, 10] },
  harmonicMinor: { id: 'harmonicMinor', label: '和声小调', steps: [0, 2, 3, 5, 7, 8, 11] },
})

/** 和弦性质表：id → { id,label,intervals }（至少 10 种）。 */
export const CHORD_QUALITIES = Object.freeze({
  major: { id: 'major', label: '大三和弦', intervals: [0, 4, 7] },
  minor: { id: 'minor', label: '小三和弦', intervals: [0, 3, 7] },
  dim: { id: 'dim', label: '减三和弦', intervals: [0, 3, 6] },
  aug: { id: 'aug', label: '增三和弦', intervals: [0, 4, 8] },
  sus2: { id: 'sus2', label: '挂二和弦', intervals: [0, 2, 7] },
  sus4: { id: 'sus4', label: '挂四和弦', intervals: [0, 5, 7] },
  dom7: { id: 'dom7', label: '属七和弦', intervals: [0, 4, 7, 10] },
  maj7: { id: 'maj7', label: '大七和弦', intervals: [0, 4, 7, 11] },
  min7: { id: 'min7', label: '小七和弦', intervals: [0, 3, 7, 10] },
  add9: { id: 'add9', label: '加九和弦', intervals: [0, 4, 7, 14] },
  six: { id: 'six', label: '六和弦', intervals: [0, 4, 7, 9] },
  min6: { id: 'min6', label: '小六和弦', intervals: [0, 3, 7, 9] },
  dim7: { id: 'dim7', label: '减七和弦', intervals: [0, 3, 6, 9] },
  nine: { id: 'nine', label: '属九和弦', intervals: [0, 4, 7, 10, 14] },
})
export const CHORD_QUALITY_IDS = Object.freeze(Object.keys(CHORD_QUALITIES))

/** 和弦性质 → 显示后缀。 */
const QUALITY_SUFFIX = Object.freeze({
  major: '',
  minor: 'm',
  dim: 'dim',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  dom7: '7',
  maj7: 'maj7',
  min7: 'm7',
  add9: 'add9',
  six: '6',
  min6: 'm6',
  dim7: 'dim7',
  nine: '9',
})

/** 各级和弦的罗马数字/性质（按音阶）。 */
const DIATONIC_TABLE = Object.freeze({
  major: {
    romans: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'],
    qualities: ['major', 'minor', 'minor', 'major', 'major', 'minor', 'dim'],
  },
  minor: {
    romans: ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'],
    qualities: ['minor', 'dim', 'major', 'minor', 'minor', 'major', 'major'],
  },
  harmonicMinor: {
    romans: ['i', 'ii°', 'III+', 'iv', 'V', 'VI', 'vii°'],
    qualities: ['minor', 'dim', 'aug', 'minor', 'major', 'major', 'dim'],
  },
  dorian: {
    romans: ['i', 'ii', 'III', 'IV', 'v', 'vi°', 'VII'],
    qualities: ['minor', 'minor', 'major', 'major', 'minor', 'dim', 'major'],
  },
  phrygian: {
    romans: ['i', 'II', 'III', 'iv', 'v°', 'VI', 'vii'],
    qualities: ['minor', 'major', 'major', 'minor', 'dim', 'major', 'minor'],
  },
})

function scaleDef(scaleId) {
  return THEORY_SCALES[scaleId] ?? THEORY_SCALES.major
}

function resolvePitchClass(root) {
  if (typeof root === 'number' && Number.isFinite(root)) return ((Math.round(root) % 12) + 12) % 12
  const pc = noteNameToPitchClass(root)
  return pc === null ? 0 : pc
}

/** 根音（音名/数字）→ 带八度的绝对音高；默认 C4=60 体系（octave 4 = 60..71）。 */
function resolveRootPitch(root, fallbackOctave = 4) {
  if (typeof root === 'number' && Number.isFinite(root)) return Math.max(0, Math.min(127, Math.round(root)))
  if (typeof root === 'string') {
    const match = /^([A-Ga-g])([#b♯♭]?)(-?\d+)?$/.exec(root.trim())
    if (match) {
      const pc = noteNameToPitchClass(root)
      const octave = match[3] !== undefined ? Number(match[3]) : fallbackOctave
      const pitch = 12 * (octave + 1) + pc
      return Math.max(0, Math.min(127, pitch))
    }
  }
  return 12 * (fallbackOctave + 1) + resolvePitchClass(root)
}

/** 列出音阶（一个八度内绝对音高；octave 省略时按 C4 起始）。 */
export function scalePitches(root, scaleId = 'major', octave = 4) {
  const scale = scaleDef(scaleId)
  const pc = resolvePitchClass(root)
  const base = 12 * (octave + 1) + pc
  return scale.steps.map((step) => Math.min(127, Math.max(0, base + step)))
}

/** 7 个自然音级和弦（含罗马数字/名称/性质/音高）。 */
export function diatonicChords(key, scaleId = 'major', octave = 4) {
  const scale = scaleDef(scaleId)
  const table = DIATONIC_TABLE[scale.id] ?? DIATONIC_TABLE.major
  const rootPc = resolvePitchClass(key)
  const rootPitch = 12 * (octave + 1) + rootPc
  return table.romans.map((roman, index) => {
    const quality = table.qualities[index]
    const degree = index + 1
    const chordRoot = rootPitch + scale.steps[index]
    const pitches = buildChord({ rootPitch: chordRoot, quality })
    const rootName = pitchClassToName((rootPc + scale.steps[index]) % 12)
    return {
      roman,
      degree,
      name: `${rootName}${QUALITY_SUFFIX[quality] ?? ''}`,
      quality,
      pitches,
    }
  })
}

/** 构造和弦（升序、0..127 夹紧；voicing='close'|'open'，inversion 0..N-1）。 */
export function buildChord({ rootPitch = 60, quality = 'major', voicing = 'close', inversion = 0, octave } = {}) {
  const def = CHORD_QUALITIES[quality]
  if (!def) throw new Error(`未知和弦性质：${String(quality)}；可选：${CHORD_QUALITY_IDS.join(' / ')}`)
  const base = resolveRootPitch(rootPitch, Number.isFinite(Number(octave)) ? Number(octave) : 4)
  let pitches = def.intervals.map((interval) => base + interval)
  const invert = Math.max(0, Math.min(pitches.length - 1, Math.round(Number(inversion) || 0)))
  for (let index = 0; index < invert; index += 1) pitches[index] += 12
  // 先按转位后的音高排序，再做开放排列（否则排列方向会随转位改变）。
  pitches.sort((a, b) => a - b)
  if (voicing === 'open') {
    pitches = pitches.map((pitch, index) => (index > 0 && index % 2 === 1 ? pitch + 12 : pitch))
  }
  pitches = pitches
    .map((pitch) => Math.min(127, Math.max(0, pitch)))
    .sort((a, b) => a - b)
  return pitches
}

/** 解析罗马数字（如 I / ii / bIII / V7 / vi°）→ {degree,quality,rootPitchClass}；非法返回 null。 */
export function parseRoman(roman, key, scaleId = 'major') {
  if (typeof roman !== 'string') return null
  const text = roman.trim()
  const match = /^([b#♭♯]?)([IViv]+)(.*)$/.exec(text)
  if (!match) return null
  const accidental = match[1] === 'b' || match[1] === '♭' ? -1 : match[1] === '#' || match[1] === '♯' ? 1 : 0
  const numeral = match[2].toUpperCase()
  const romanValues = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 }
  const degree = romanValues[numeral]
  if (!degree) return null
  const scale = scaleDef(scaleId)
  const table = DIATONIC_TABLE[scale.id] ?? DIATONIC_TABLE.major
  const suffix = match[3].trim().toLowerCase()
  const suffixQuality = {
    '': table.qualities[degree - 1],
    '°': 'dim',
    o: 'dim',
    dim: 'dim',
    '+': 'aug',
    aug: 'aug',
    7: 'dom7',
    maj7: 'maj7',
    m7: 'min7',
    min7: 'min7',
    sus2: 'sus2',
    sus4: 'sus4',
    add9: 'add9',
  }[suffix]
  if (!suffixQuality) return null
  const rootPitchClass = ((resolvePitchClass(key) + scale.steps[degree - 1] + accidental) % 12 + 12) % 12
  return { degree, quality: suffixQuality, rootPitchClass }
}

/** 确定性 PRNG（mulberry32）：同 seed 同序列。 */
export function mulberry32(seed) {
  let state = (Number(seed) >>> 0) || 1
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const ARP_PATTERNS = Object.freeze(['up', 'down', 'updown', 'random'])

/**
 * 琶音生成（确定性）。
 * @param {{chordPitches:number[], pattern?:string, rate?:number, beats?:number, octaves?:number, gate?:number, velocity?:number, seed?:number}} args
 * @returns {{pitch:number,start:number,dur:number,vel:number}[]}
 */
export function arpNotes({
  chordPitches = [],
  pattern = 'up',
  rate = 0.25,
  beats = 4,
  octaves = 1,
  gate = 0.9,
  velocity = 0.8,
  seed = 1,
} = {}) {
  const base = (Array.isArray(chordPitches) ? chordPitches : [])
    .map((pitch) => (pitch === null || pitch === undefined || pitch === '' ? Number.NaN : Number(pitch)))
    .filter((pitch) => Number.isFinite(pitch))
    .map((pitch) => Math.max(0, Math.min(127, Math.round(pitch))))
    .sort((a, b) => a - b)
  if (base.length === 0) return []
  const safePattern = ARP_PATTERNS.includes(pattern) ? pattern : 'up'
  const safeRate = Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 0.25
  const safeBeats = Number.isFinite(Number(beats)) && Number(beats) > 0 ? Number(beats) : 4
  const octaveCount = Math.max(1, Math.min(4, Math.round(Number(octaves) || 1)))
  const safeGate = Number.isFinite(Number(gate)) ? Math.max(0.05, Math.min(1, Number(gate))) : 0.9
  const safeVelocity = Number.isFinite(Number(velocity)) ? Math.max(0, Math.min(1, Number(velocity))) : 0.8
  const extended = []
  for (let octave = 0; octave < octaveCount; octave += 1) {
    for (const pitch of base) {
      const shifted = pitch + 12 * octave
      if (shifted <= 127) extended.push(shifted)
    }
  }
  if (extended.length === 0) return []
  let order
  if (safePattern === 'down') order = [...extended].sort((a, b) => b - a)
  else if (safePattern === 'updown') {
    const down = [...extended].sort((a, b) => b - a).slice(1, -1)
    order = [...extended, ...down]
  } else order = extended
  const steps = Math.max(1, Math.floor(safeBeats / safeRate))
  const random = mulberry32(seed)
  const notes = []
  for (let index = 0; index < steps; index += 1) {
    const start = Math.round(index * safeRate * 1e6) / 1e6
    const pitch = safePattern === 'random'
      ? extended[Math.min(extended.length - 1, Math.floor(random() * extended.length))]
      : order[index % order.length]
    notes.push({
      pitch,
      start,
      dur: Math.max(0.01, Math.round(safeRate * safeGate * 1e6) / 1e6),
      vel: Math.round(safeVelocity * 1000) / 1000,
    })
  }
  return notes
}

/** Groove 模板：delay 单位为 beat（最大 ±1/6），只改 timing。 */
export const GROOVE_TEMPLATES = Object.freeze([
  { id: 'straight', label: '直拍', delay: 0 },
  { id: 'swing55', label: 'Swing 55%', delay: 0.05 },
  { id: 'swing60', label: 'Swing 60%', delay: 0.1 },
  { id: 'shuffle', label: 'Shuffle', delay: 1 / 6 },
  { id: 'mpc54', label: 'MPC 54%（提前）', delay: -0.04 },
  { id: 'mpc58', label: 'MPC 58%（靠后）', delay: 0.08 },
])
export const GROOVE_TEMPLATE_IDS = Object.freeze(GROOVE_TEMPLATES.map((template) => template.id))

/** 取 groove 模板（未知回退 straight）。 */
export function getGrooveTemplate(template) {
  const id = typeof template === 'string' ? template : template?.id
  return GROOVE_TEMPLATES.find((item) => item.id === id) ?? GROOVE_TEMPLATES[0]
}

/**
 * 应用 groove：按模板 timing 偏移（最多 ±1/6 beat），不改 pitch/dur/vel。
 * 只偏移反拍（beat 内相位 0.5 全额，0.25/0.75 半额），结果不早于 0。
 * @param {{pitch:number,start:number,dur:number,vel:number}[]} notes
 * @param {string} template
 * @param {number} [strength=1]
 */
export function applyGroove(notes, template = 'straight', strength = 1) {
  const list = Array.isArray(notes) ? notes : []
  const def = getGrooveTemplate(template)
  const safeStrength = Number.isFinite(Number(strength)) ? Math.max(0, Math.min(1, Number(strength))) : 1
  const amount = Math.max(-1 / 6, Math.min(1 / 6, def.delay)) * safeStrength
  return list.map((note) => {
    const start = Number(note?.start) || 0
    const phase = ((start % 1) + 1) % 1
    let delta = 0
    if (Math.abs(phase - 0.5) < 1e-6) delta = amount
    else if (Math.abs(phase - 0.25) < 1e-6 || Math.abs(phase - 0.75) < 1e-6) delta = amount / 2
    return {
      ...note,
      start: Math.max(0, Math.round((start + delta) * 1e6) / 1e6),
    }
  })
}

/**
 * 量化音符：strength 插值 + swing 对反拍偏移（确定性）。
 * @param {{pitch:number,start:number,dur:number,vel:number}[]} notes
 * @param {number} [grid=0.25]
 * @param {number} [strength=1]
 * @param {number} [swing=0]
 */
export function quantizeNotes(notes, grid = 0.25, strength = 1, swing = 0) {
  const list = Array.isArray(notes) ? notes : []
  const safeGrid = Number.isFinite(Number(grid)) && Number(grid) > 0 ? Number(grid) : 0.25
  const safeStrength = Number.isFinite(Number(strength)) ? Math.max(0, Math.min(1, Number(strength))) : 1
  const safeSwing = Number.isFinite(Number(swing)) ? Math.max(0, Math.min(1, Number(swing))) : 0
  return list.map((note) => {
    const start = Number(note?.start) || 0
    const target = Math.round(start / safeGrid) * safeGrid
    let next = start + (target - start) * safeStrength
    const step = Math.round(target / safeGrid)
    if (step % 2 === 1) next += safeSwing * safeGrid * 0.5
    return {
      ...note,
      start: Math.max(0, Math.round(next * 1e6) / 1e6),
    }
  })
}

/** 建议和弦进行（供 studio_get_theory / UI）。 */
export const SUGGESTED_PROGRESSIONS = Object.freeze([
  { id: 'pop', label: '流行 I-V-vi-IV', romans: ['I', 'V', 'vi', 'IV'] },
  { id: 'jazz251', label: 'ii-V-I', romans: ['ii', 'V', 'I'] },
  { id: 'doowop', label: '50s I-vi-IV-V', romans: ['I', 'vi', 'IV', 'V'] },
  { id: 'andalusian', label: 'i-VII-VI-V', romans: ['i', 'VII', 'VI', 'V'] },
])
