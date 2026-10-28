/**
 * AI 音乐工作室 — 内置演示工程「霓虹天际线 / Neon Skyline」。
 * 由 AI 创作的 32 小节电子音乐（F# 小调，128 BPM），用于首屏展示与 UI 验证。
 * 纯数据生成：所有音符/切片/效果都可由 Host 的 studio_* 工具再次修改。
 */
import { makeTrack, makePattern, makeClip, makeSection, makeEffect, createEmptyProject, clamp01, masteredMaster } from './model.js'

const B = 4 // 每小节 4 拍（4/4）
const T = 0.8 // 默认力度

/** 便捷音符。 */
const n = (pitch, start, dur = 0.5, vel = T) => ({ pitch, start, dur, vel })
/** 把一段音符整体平移。 */
const shift = (notes, offset) => notes.map((x) => ({ ...x, start: x.start + offset }))
/** 按 pattern 小节数平铺（每个循环平移 bar*4 拍）。 */
const repeatBars = (notes, bars, patternBars = 4) => {
  const out = []
  for (let bar = 0; bar < bars; bar += patternBars) out.push(...shift(notes, bar * B))
  return out
}

const KICK = 36
const SNARE = 38
const CLAP = 39
const RIM = 37
const HAT = 42
const OPEN = 46
const TOM_L = 45
const TOM_H = 50
const CRASH = 49
const RIDE = 51
const PERC = 60

/** 16 分音符步进 → beat。 */
const step = (s) => s / 4

/** 底鼓四四拍。 */
function fourOnFloor(bars = 4) {
  const notes = []
  for (let bar = 0; bar < bars; bar++) for (let b = 0; b < 4; b++) notes.push(n(KICK, bar * B + b, 0.24, 0.95))
  return notes
}

/** 军鼓/拍手在 2、4 拍。 */
function backbeat(bars = 4) {
  const notes = []
  for (let bar = 0; bar < bars; bar++) {
    notes.push(n(SNARE, bar * B + 1, 0.2, 0.85), n(SNARE, bar * B + 3, 0.2, 0.9))
    notes.push(n(CLAP, bar * B + 1, 0.16, 0.5), n(CLAP, bar * B + 3, 0.16, 0.58))
  }
  return notes
}

/** 16 分踩镲 + 8 分开镲。 */
function hats(bars = 4, density = '16', vel = 0.4) {
  const notes = []
  for (let bar = 0; bar < bars; bar++) {
    const perBar = density === '16' ? 16 : density === '8' ? 8 : 4
    const interval = 16 / perBar
    for (let s = 0; s < 16; s += interval) {
      const beat = bar * B + step(s)
      notes.push(n(HAT, beat, 0.06, s % 2 === 0 ? vel : vel * 0.62))
    }
    for (const s of [2, 6, 10, 14]) notes.push(n(OPEN, bar * B + step(s), 0.14, vel * 0.55))
  }
  return notes
}

/** 和弦（转位以 F# 小调级数为基础）。 */
const CHORDS = {
  Fm: [54, 57, 61], // F#3 A3 C#4
  D: [50, 54, 57], // D3 F#3 A3
  A: [57, 61, 64], // A3 C#4 E4
  E: [52, 56, 59], // E3 G#3 B3
}
const CHORD_ORDER = ['Fm', 'D', 'A', 'E']
const ROOTS = { Fm: 30, D: 26, A: 33, E: 28 } // 低音根音（F#1/D1/A1/E1）

/** 铺底：每小节整小节和弦。 */
function padChords(bars = 4) {
  const notes = []
  for (let bar = 0; bar < bars; bar++) {
    const chord = CHORDS[CHORD_ORDER[bar % 4]]
    for (const p of chord) notes.push(n(p + 12, bar * B, 3.85, 0.55))
  }
  return notes
}

/** 琶音：每小节 8 分音符循环和弦音。 */
function arpLine(bars = 4, octave = 12) {
  const notes = []
  const shape = [0, 1, 2, 1, 2, 1, 0, 1]
  for (let bar = 0; bar < bars; bar++) {
    const chord = CHORDS[CHORD_ORDER[bar % 4]]
    for (let i = 0; i < 8; i++) {
      const p = chord[shape[i]] + octave
      notes.push(n(p, bar * B + i * 0.5, 0.42, i % 2 === 0 ? 0.55 : 0.4))
    }
  }
  return notes
}

/** 和弦短音：反拍。 */
function stabs(bars = 4) {
  const notes = []
  for (let bar = 0; bar < bars; bar++) {
    const chord = CHORDS[CHORD_ORDER[bar % 4]]
    for (const off of [0.5, 1.5, 2.5, 3.5]) {
      for (const p of chord) notes.push(n(p + 24, bar * B + off, 0.2, 0.42))
    }
  }
  return notes
}

/** 低音律动。 */
function bassLine(bars = 4, style = 'drive') {
  const notes = []
  for (let bar = 0; bar < bars; bar++) {
    const root = ROOTS[CHORD_ORDER[bar % 4]]
    if (style === 'drive') {
      notes.push(n(root, bar * B, 0.7, 0.9), n(root, bar * B + 1.5, 0.45, 0.7))
      notes.push(n(root, bar * B + 2.5, 0.45, 0.78), n(root + 12, bar * B + 3.25, 0.4, 0.55))
    } else if (style === 'roll') {
      for (let i = 0; i < 8; i++) notes.push(n(i % 4 === 0 ? root : root + 12, bar * B + i * 0.5, 0.32, i % 2 === 0 ? 0.8 : 0.5))
    } else {
      notes.push(n(root, bar * B, 1.9, 0.85), n(root, bar * B + 2, 0.9, 0.65))
    }
  }
  return notes
}

/** 主旋律 motif（4 小节）。 */
const LEAD_MOTIF = [
  n(66, 0, 0.45), n(69, 0.5, 0.45), n(73, 1, 0.9), n(76, 2, 0.45), n(73, 2.5, 0.45), n(69, 3, 0.9),
  n(69, 4, 0.45), n(74, 4.5, 0.45), n(78, 5, 0.9), n(76, 6, 0.45), n(74, 6.5, 0.45), n(69, 7, 0.9),
  n(69, 8, 0.9), n(73, 9, 0.45), n(76, 9.5, 0.9), n(73, 10.5, 0.45), n(69, 11, 0.9),
  n(68, 12, 0.45), n(71, 12.5, 0.45), n(76, 13, 0.9), n(74, 14, 0.45), n(71, 14.5, 0.45), n(68, 15, 0.9),
]

/** Drop 主音：高八度 + 16 分律动变体。 */
function leadDrop(bars = 4) {
  const out = []
  for (let bar = 0; bar < bars; bar++) {
    const base = shift(LEAD_MOTIF, -0).filter((x) => x.start >= bar * B && x.start < (bar + 1) * B)
    for (const note of base) {
      out.push({ pitch: Math.min(127, note.pitch + 12), start: note.start, dur: Math.min(note.dur, 0.3), vel: 0.72 })
      if (note.dur >= 0.9) out.push({ pitch: Math.min(127, note.pitch + 12), start: note.start + note.dur * 0.6, dur: 0.2, vel: 0.38 })
    }
  }
  return out
}

/** Break 主音：长音。 */
function leadBreak(bars = 4) {
  const notes = []
  for (let bar = 0; bar < bars; bar++) {
    const chord = CHORDS[CHORD_ORDER[bar % 4]]
    notes.push(n(chord[2] + 12, bar * B, 3.6, 0.5))
    if (bar % 2 === 1) notes.push(n(chord[1] + 12, bar * B + 2, 1.4, 0.35))
  }
  return notes
}

/** 鼓：主 Drop。 */
function drumDrop() {
  const notes = [...fourOnFloor(), ...backbeat(), ...hats(4, '16', 0.46), n(CRASH, 0, 1.2, 0.5)]
  // 反拍底鼓加花
  for (let bar = 0; bar < 4; bar++) {
    notes.push(n(KICK, bar * B + 2.75, 0.22, 0.7))
    notes.push(n(RIM, bar * B + 1.25, 0.08, 0.3), n(RIM, bar * B + 3.75, 0.08, 0.34))
  }
  // 第 4 小节尾的嗵鼓过门
  notes.push(n(TOM_L, 13, 0.2, 0.6), n(TOM_H, 13.25, 0.2, 0.65), n(TOM_L, 13.5, 0.2, 0.6), n(TOM_H, 13.75, 0.2, 0.7))
  return notes
}

/** 鼓：Build。 */
function drumBuild() {
  const notes = [...fourOnFloor(4), ...hats(4, '16', 0.4)]
  for (let bar = 0; bar < 3; bar++) {
    notes.push(n(SNARE, bar * B + 1, 0.2, 0.7), n(SNARE, bar * B + 3, 0.2, 0.75))
  }
  // 最后一小节军鼓 16 分滚奏
  for (let i = 0; i < 16; i++) notes.push(n(SNARE, 12 + step(i), 0.08, 0.35 + i * 0.035))
  notes.push(n(CRASH, 0, 1.4, 0.4))
  return notes
}

/** 鼓：Intro（只有踩镲/ride/perc）。 */
function drumIntro() {
  const notes = []
  for (let bar = 0; bar < 4; bar++) {
    for (let s = 0; s < 16; s += 4) notes.push(n(HAT, bar * B + step(s), 0.05, 0.22))
    for (let b = 0; b < 4; b++) notes.push(n(RIDE, bar * B + b + 0.5, 0.2, 0.16))
    if (bar >= 2) notes.push(n(PERC, bar * B + 3.5, 0.1, 0.3))
  }
  return notes
}

/** 鼓：Break（半速）。 */
function drumBreak() {
  const notes = []
  for (let bar = 0; bar < 4; bar++) {
    notes.push(n(KICK, bar * B, 0.4, 0.85))
    notes.push(n(KICK, bar * B + 2.5, 0.3, 0.6))
    notes.push(n(SNARE, bar * B + 2, 0.24, 0.8))
    for (let s = 0; s < 16; s += 2) notes.push(n(HAT, bar * B + step(s), 0.05, s % 4 === 0 ? 0.28 : 0.16))
    if (bar === 3) notes.push(n(CRASH, bar * B, 1.6, 0.35))
  }
  return notes
}

/** FX：Break 氛围和弦。 */
function fxBreak() {
  const notes = []
  const chords = [
    [78, 81, 85], // F#5 A5 C#6
    [74, 78, 81], // D5 F#5 A5
  ]
  for (let i = 0; i < 2; i++) for (const p of chords[i]) notes.push(n(p, i * 8, 7.6, 0.3))
  return notes
}

/** 组装演示工程。 */
export function createDemoProject() {
  const project = createEmptyProject({
    title: '霓虹天际线 Neon Skyline',
    bpm: 128,
    key: 'F#',
    scale: 'minor',
    lengthBars: 32,
    artist: 'DeepSeek AI',
  })
  // P13：空白工程默认空母带链；演示工程显式使用母带链（eq3 + compressor）保持听感。
  project.master = masteredMaster()
  // R0-11：采样预设归一后重配母带总电平 + 低频收敛（<250Hz 占比目标 <80%）
  project.master.volume = 0.6
  project.master.effects[0].params.low = -0.5
  project.master.effects[0].params.mid = 0
  project.master.effects[0].params.high = 1.5

  // ── 轨道（P8：全部使用真实采样音色，无代码合成预设）─────────────────
  const drums = makeTrack({
    id: 'trk_1', name: '鼓组 · 原声采样鼓', kind: 'drum', kit: 'smp_acoustic', role: 'drums', volume: 0.58, pan: 0,
    effects: [
      makeEffect('fx_1', 'compressor', { threshold: -20, ratio: 5, attack: 0.004, release: 0.12 }),
      makeEffect('fx_2', 'eq3', { low: 0, mid: -1, high: 2.5 }),
    ],
    sends: { reverb: 0.06, delay: 0.03 },
  })
  const bass = makeTrack({
    id: 'trk_2', name: '低音 · 指弹贝斯', kind: 'synth', preset: 'finger_bass', role: 'bass', volume: 0.36, pan: 0,
    effects: [
      makeEffect('fx_1', 'eq3', { low: -1.5, mid: 0, high: 1.5 }),
      makeEffect('fx_2', 'drive', { amount: 0.28, tone: 0.4, mix: 0.5 }),
    ],
    sends: { reverb: 0.02, delay: 0.02 },
  })
  const lead = makeTrack({
    id: 'trk_3', name: '主音 · 三角钢琴', kind: 'synth', preset: 'grand_piano', role: 'lead', volume: 0.34, pan: 0.05,
    effects: [
      makeEffect('fx_1', 'chorus', { rate: 0.6, depth: 0.35, mix: 0.3 }),
      makeEffect('fx_2', 'delay', { time: 0.36, feedback: 0.28, mix: 0.2, pingpong: true }),
      makeEffect('fx_3', 'eq3', { low: -3, mid: 1.5, high: 1.5 }),
    ],
    sends: { reverb: 0.22, delay: 0.16 },
  })
  const pad = makeTrack({
    id: 'trk_4', name: '铺底 · 弦乐合奏', kind: 'synth', preset: 'strings_ensemble', role: 'pad', volume: 0.55, pan: -0.12,
    effects: [makeEffect('fx_1', 'chorus', { rate: 0.25, depth: 0.5, mix: 0.4 })],
    sends: { reverb: 0.38, delay: 0.08 },
  })
  const arp = makeTrack({
    id: 'trk_5', name: '琶音 · 马林巴', kind: 'synth', preset: 'marimba', role: 'arp', volume: 1.0, pan: 0.24,
    effects: [
      makeEffect('fx_1', 'delay', { time: 0.1875, feedback: 0.34, mix: 0.26, pingpong: true }),
      makeEffect('fx_2', 'eq3', { low: -1, mid: 2, high: 4 }),
    ],
    sends: { reverb: 0.24, delay: 0.18 },
  })
  const keys = makeTrack({
    id: 'trk_6', name: '和弦 · 电钢琴', kind: 'synth', preset: 'tine_epiano', role: 'keys', volume: 1.0, pan: -0.2,
    effects: [
      makeEffect('fx_1', 'phaser', { rate: 0.4, depth: 0.5, mix: 0.3 }),
      makeEffect('fx_2', 'eq3', { low: 0, mid: 3, high: 5 }),
    ],
    sends: { reverb: 0.3, delay: 0.12 },
  })
  const fx = makeTrack({
    id: 'trk_7', name: '氛围 · 合唱', kind: 'synth', preset: 'concert_choir', role: 'fx', volume: 0.7, pan: 0,
    effects: [makeEffect('fx_1', 'reverb', { size: 0.85, decay: 0.8, damp: 0.3, mix: 0.5 })],
    sends: { reverb: 0.5, delay: 0.2 },
  })
  project.tracks = [drums, bass, lead, pad, arp, keys, fx]

  // ── Pattern ───────────────────────────────────────────────────────
  project.patterns = [
    makePattern({ id: 'pat_1', name: '鼓 · Intro', lengthBars: 4, notes: drumIntro() }),
    makePattern({ id: 'pat_2', name: '鼓 · Build', lengthBars: 4, notes: drumBuild() }),
    makePattern({ id: 'pat_3', name: '鼓 · Drop', lengthBars: 4, notes: drumDrop() }),
    makePattern({ id: 'pat_4', name: '鼓 · Break', lengthBars: 4, notes: drumBreak() }),
    makePattern({ id: 'pat_5', name: '低音 · Drive', lengthBars: 4, notes: bassLine(4, 'drive') }),
    makePattern({ id: 'pat_6', name: '低音 · Roll', lengthBars: 4, notes: bassLine(4, 'roll') }),
    makePattern({ id: 'pat_7', name: '主音 · 主题', lengthBars: 4, notes: LEAD_MOTIF }),
    makePattern({ id: 'pat_8', name: '主音 · Drop', lengthBars: 4, notes: leadDrop() }),
    makePattern({ id: 'pat_9', name: '主音 · Break', lengthBars: 4, notes: leadBreak() }),
    makePattern({ id: 'pat_10', name: '铺底 · 和弦', lengthBars: 4, notes: padChords() }),
    makePattern({ id: 'pat_11', name: '琶音 · 16 分', lengthBars: 4, notes: arpLine() }),
    makePattern({ id: 'pat_12', name: '和弦 · 反拍', lengthBars: 4, notes: stabs() }),
    makePattern({ id: 'pat_13', name: '氛围 · Break', lengthBars: 4, notes: fxBreak() }),
  ]

  // ── 编排 ──────────────────────────────────────────────────────────
  const clips = []
  let clipNo = 0
  const clip = (trackId, patternId, startBar, lengthBars = 8, transpose = 0) => {
    clips.push(makeClip({ id: `clip_${++clipNo}`, trackId, patternId, startBar, lengthBars, transpose }))
  }

  // Intro 0-8
  clip('trk_1', 'pat_1', 0, 8)
  clip('trk_4', 'pat_10', 0, 8)
  clip('trk_5', 'pat_11', 4, 4)
  // Build 8-16
  clip('trk_1', 'pat_2', 8, 8)
  clip('trk_2', 'pat_5', 8, 4)
  clip('trk_2', 'pat_6', 12, 4)
  clip('trk_4', 'pat_10', 8, 8)
  clip('trk_5', 'pat_11', 8, 8)
  clip('trk_6', 'pat_12', 12, 4)
  // Drop 16-24
  clip('trk_1', 'pat_3', 16, 8)
  clip('trk_2', 'pat_6', 16, 8)
  clip('trk_3', 'pat_8', 16, 8)
  clip('trk_4', 'pat_10', 16, 8)
  clip('trk_5', 'pat_11', 16, 8)
  clip('trk_6', 'pat_12', 16, 8)
  // Break 24-28
  clip('trk_1', 'pat_4', 24, 4)
  clip('trk_3', 'pat_9', 24, 4)
  clip('trk_4', 'pat_10', 24, 4)
  clip('trk_7', 'pat_13', 24, 4)
  // Drop 2 28-32
  clip('trk_1', 'pat_3', 28, 4)
  clip('trk_2', 'pat_6', 28, 4)
  clip('trk_3', 'pat_8', 28, 4)
  clip('trk_5', 'pat_11', 28, 4)
  clip('trk_6', 'pat_12', 28, 4)
  clip('trk_7', 'pat_13', 28, 4)
  project.clips = clips

  project.sections = [
    makeSection({ id: 'sec_1', name: 'Intro 前奏', startBar: 0, lengthBars: 8, color: '#7FC8A9' }),
    makeSection({ id: 'sec_2', name: 'Build 推进', startBar: 8, lengthBars: 8, color: '#EFAE3C' }),
    makeSection({ id: 'sec_3', name: 'Drop 高潮', startBar: 16, lengthBars: 8, color: '#F26B3A' }),
    makeSection({ id: 'sec_4', name: 'Break 间奏', startBar: 24, lengthBars: 4, color: '#4FA3A5' }),
    makeSection({ id: 'sec_5', name: 'Drop 2 终章', startBar: 28, lengthBars: 4, color: '#E85D84' }),
  ]

  project.transport.loopStartBar = 0
  project.transport.loopEndBar = project.lengthBars
  project.transport.playheadBar = 0
  project.activity = { text: '演示工程已就绪 · 按播放试听「霓虹天际线」（真实采样音色）', at: Date.now() }
  project.history = [
    { at: Date.now() - 60000, tool: 'studio_create_project', text: '创建工程「霓虹天际线」· F# 小调 · 128 BPM' },
    { at: Date.now() - 45000, tool: 'studio_add_track', text: '加入 7 条轨道：原声采样鼓 / 指弹贝斯 / 三角钢琴 / 弦乐合奏 / 马林巴 / 电钢琴 / 合唱' },
    { at: Date.now() - 30000, tool: 'studio_set_arrangement', text: '编排 32 小节：Intro → Build → Drop → Break → Drop 2（GeneralUser GS 采样音色）' },
  ]
  project.revision = 1
  project.updatedAt = Date.now()
  return project
}

export { CHORD_ORDER, CHORDS, LEAD_MOTIF }
