/**
 * R3a：theory.js 纯函数单测。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CHORD_QUALITIES,
  CHORD_QUALITY_IDS,
  FLAT_NOTE_NAMES,
  GROOVE_TEMPLATES,
  GROOVE_TEMPLATE_IDS,
  NOTE_NAMES,
  SUGGESTED_PROGRESSIONS,
  THEORY_SCALES,
  applyGroove,
  arpNotes,
  buildChord,
  diatonicChords,
  getGrooveTemplate,
  midiToName,
  mulberry32,
  noteNameToPitchClass,
  parseRoman,
  pitchClassToName,
  quantizeNotes,
  scalePitches,
} from '../src/shared/theory.js'

describe('R3a theory — 音名/音阶', () => {
  it('NOTE_NAMES / FLAT_NOTE_NAMES 为 12 个音，C=0', () => {
    assert.equal(NOTE_NAMES.length, 12)
    assert.equal(FLAT_NOTE_NAMES.length, 12)
    assert.equal(NOTE_NAMES[0], 'C')
    assert.equal(NOTE_NAMES[10], 'A#')
    assert.equal(FLAT_NOTE_NAMES[10], 'Bb')
  })

  it('noteNameToPitchClass：升号/降号/带八度/大小写/非法', () => {
    assert.equal(noteNameToPitchClass('C'), 0)
    assert.equal(noteNameToPitchClass('F#'), 6)
    assert.equal(noteNameToPitchClass('Gb'), 6)
    assert.equal(noteNameToPitchClass('Bb'), 10)
    assert.equal(noteNameToPitchClass('C4'), 0)
    assert.equal(noteNameToPitchClass('f#3'), 6)
    for (const bad of ['H', '', 'C##', null, 42, '八']) assert.equal(noteNameToPitchClass(bad), null)
  })

  it('pitchClassToName：升/降拼写、模 12', () => {
    assert.equal(pitchClassToName(0), 'C')
    assert.equal(pitchClassToName(6), 'F#')
    assert.equal(pitchClassToName(6, true), 'Gb')
    assert.equal(pitchClassToName(13), 'C#')
    assert.equal(pitchClassToName(-1), 'B')
    assert.equal(pitchClassToName('x'), null)
  })

  it('midiToName：60=C4、69=A4、0=C-1、127=G9，越界夹紧', () => {
    assert.equal(midiToName(60), 'C4')
    assert.equal(midiToName(69), 'A4')
    assert.equal(midiToName(0), 'C-1')
    assert.equal(midiToName(127), 'G9')
    assert.equal(midiToName(200), 'G9')
    assert.equal(midiToName(-5), 'C-1')
    assert.equal(midiToName(null), null)
  })

  it('THEORY_SCALES 与 catalog 的 5 个调式一致', () => {
    assert.deepEqual(Object.keys(THEORY_SCALES), ['major', 'minor', 'dorian', 'phrygian', 'harmonicMinor'])
    assert.deepEqual(THEORY_SCALES.major.steps, [0, 2, 4, 5, 7, 9, 11])
    assert.deepEqual(THEORY_SCALES.harmonicMinor.steps, [0, 2, 3, 5, 7, 8, 11])
  })

  it('scalePitches：C 大调/自然小调/和声小调与移调', () => {
    assert.deepEqual(scalePitches('C', 'major', 4), [60, 62, 64, 65, 67, 69, 71])
    assert.deepEqual(scalePitches('A', 'minor', 4), [69, 71, 72, 74, 76, 77, 79])
    assert.deepEqual(scalePitches('C', 'harmonicMinor', 4), [60, 62, 63, 65, 67, 68, 71])
    assert.deepEqual(scalePitches('F#', 'major', 3), [54, 56, 58, 59, 61, 63, 65])
  })
})

describe('R3a theory — 和弦/级数/罗马数字', () => {
  it('CHORD_QUALITIES ≥10 种，含契约要求全部性质', () => {
    assert.ok(CHORD_QUALITY_IDS.length >= 10)
    for (const id of ['major', 'minor', 'dim', 'aug', 'sus2', 'sus4', 'dom7', 'maj7', 'min7', 'add9']) {
      assert.ok(CHORD_QUALITIES[id], id)
    }
    assert.deepEqual(CHORD_QUALITIES.major.intervals, [0, 4, 7])
    assert.deepEqual(CHORD_QUALITIES.add9.intervals, [0, 4, 7, 14])
  })

  it('buildChord：大三/小三/七和弦、升序、音程正确', () => {
    assert.deepEqual(buildChord({ rootPitch: 60, quality: 'major' }), [60, 64, 67])
    assert.deepEqual(buildChord({ rootPitch: 'C4', quality: 'minor' }), [60, 63, 67])
    assert.deepEqual(buildChord({ rootPitch: 60, quality: 'maj7' }), [60, 64, 67, 71])
    assert.deepEqual(buildChord({ rootPitch: 60, quality: 'sus4' }), [60, 65, 67])
  })

  it('buildChord：转位（0/1/2）改变低音并保持升序', () => {
    assert.deepEqual(buildChord({ rootPitch: 60, quality: 'major', inversion: 0 }), [60, 64, 67])
    assert.deepEqual(buildChord({ rootPitch: 60, quality: 'major', inversion: 1 }), [64, 67, 72])
    assert.deepEqual(buildChord({ rootPitch: 60, quality: 'major', inversion: 2 }), [67, 72, 76])
    // 越界转位夹紧到最大合法值
    assert.deepEqual(buildChord({ rootPitch: 60, quality: 'major', inversion: 9 }), [67, 72, 76])
  })

  it('buildChord：open 排列可跨八度且仍升序', () => {
    const open = buildChord({ rootPitch: 60, quality: 'major', voicing: 'open' })
    assert.ok(open.length === 3)
    assert.ok(open[2] - open[0] > 7, JSON.stringify(open))
    for (let i = 1; i < open.length; i += 1) assert.ok(open[i] >= open[i - 1])
  })

  it('buildChord：pitch 夹紧 0..127；未知性质抛中文错误', () => {
    const high = buildChord({ rootPitch: 125, quality: 'maj7' })
    assert.ok(high.every((pitch) => pitch >= 0 && pitch <= 127))
    const low = buildChord({ rootPitch: 2, quality: 'minor', inversion: 1 })
    assert.ok(low.every((pitch) => pitch >= 0 && pitch <= 127))
    assert.throws(() => buildChord({ rootPitch: 60, quality: 'bogus' }), /未知和弦性质/)
  })

  it('diatonicChords：C 大调 I ii iii IV V vi vii° 名称/性质/音高', () => {
    const chords = diatonicChords('C', 'major')
    assert.equal(chords.length, 7)
    assert.deepEqual(chords.map((chord) => chord.roman), ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'])
    assert.deepEqual(chords.map((chord) => chord.quality), ['major', 'minor', 'minor', 'major', 'major', 'minor', 'dim'])
    assert.deepEqual(chords.map((chord) => chord.name), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim'])
    assert.deepEqual(chords[0].pitches, [60, 64, 67])
    assert.deepEqual(chords[5].pitches, [69, 72, 76])
    assert.equal(chords[0].degree, 1)
  })

  it('diatonicChords：A 自然小调 i ii° III iv v VI VII', () => {
    const chords = diatonicChords('A', 'minor')
    assert.deepEqual(chords.map((chord) => chord.roman), ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'])
    assert.deepEqual(chords.map((chord) => chord.quality), ['minor', 'dim', 'major', 'minor', 'minor', 'major', 'major'])
    assert.equal(chords[0].name, 'Am')
    assert.equal(chords[2].name, 'C')
  })

  it('diatonicChords：和声小调 III+/V 大调变体；dorian/phrygian 可用', () => {
    const harmonic = diatonicChords('A', 'harmonicMinor')
    assert.equal(harmonic[2].quality, 'aug')
    assert.equal(harmonic[4].quality, 'major')
    assert.equal(diatonicChords('D', 'dorian').length, 7)
    assert.equal(diatonicChords('E', 'phrygian').length, 7)
  })

  it('parseRoman：I/V/vi/IV/bIII/V7/ii°', () => {
    assert.deepEqual(parseRoman('I', 'C', 'major'), { degree: 1, quality: 'major', rootPitchClass: 0 })
    assert.deepEqual(parseRoman('V', 'C', 'major'), { degree: 5, quality: 'major', rootPitchClass: 7 })
    assert.deepEqual(parseRoman('vi', 'C', 'major'), { degree: 6, quality: 'minor', rootPitchClass: 9 })
    assert.deepEqual(parseRoman('IV', 'C', 'major'), { degree: 4, quality: 'major', rootPitchClass: 5 })
    assert.deepEqual(parseRoman('bIII', 'C', 'major'), { degree: 3, quality: 'minor', rootPitchClass: 3 })
    assert.deepEqual(parseRoman('V7', 'C', 'major'), { degree: 5, quality: 'dom7', rootPitchClass: 7 })
    assert.equal(parseRoman('ii°', 'C', 'major').quality, 'dim')
    assert.equal(parseRoman('i', 'A', 'minor').quality, 'minor')
    for (const bad of ['', 'VIII', 'H', 'Ix', null, 7]) assert.equal(parseRoman(bad, 'C', 'major'), null)
  })

  it('SUGGESTED_PROGRESSIONS 含 I-V-vi-IV / ii-V-I 等', () => {
    assert.ok(SUGGESTED_PROGRESSIONS.length >= 3)
    assert.ok(SUGGESTED_PROGRESSIONS.some((item) => item.romans.join('-') === 'I-V-vi-IV'))
    assert.ok(SUGGESTED_PROGRESSIONS.some((item) => item.romans.join('-') === 'ii-V-I'))
    assert.ok(SUGGESTED_PROGRESSIONS.every((item) => item.id && item.label && Array.isArray(item.romans)))
  })
})

describe('R3a theory — 琶音', () => {
  const chord = [60, 64, 67]

  it('arpNotes up：数量/起点/时值/力度/音高顺序', () => {
    const notes = arpNotes({ chordPitches: chord, pattern: 'up', rate: 0.25, beats: 1, gate: 0.8, velocity: 0.6 })
    assert.equal(notes.length, 4)
    assert.deepEqual(notes.map((note) => note.start), [0, 0.25, 0.5, 0.75])
    assert.deepEqual(notes.map((note) => note.pitch), [60, 64, 67, 60])
    for (const note of notes) {
      assert.equal(note.dur, 0.2)
      assert.equal(note.vel, 0.6)
    }
  })

  it('arpNotes down：音高倒序；updown 首尾折返', () => {
    const down = arpNotes({ chordPitches: chord, pattern: 'down', rate: 0.25, beats: 1 })
    assert.deepEqual(down.map((note) => note.pitch), [67, 64, 60, 67])
    const updown = arpNotes({ chordPitches: chord, pattern: 'updown', rate: 0.25, beats: 1.5 })
    assert.equal(updown.length, 6)
    assert.deepEqual(updown.map((note) => note.pitch), [60, 64, 67, 64, 60, 64])
  })

  it('arpNotes random：同 seed 确定性、不同 seed 可不同', () => {
    const a = arpNotes({ chordPitches: chord, pattern: 'random', rate: 0.25, beats: 2, seed: 7 })
    const b = arpNotes({ chordPitches: chord, pattern: 'random', rate: 0.25, beats: 2, seed: 7 })
    assert.deepEqual(a, b)
    const c = arpNotes({ chordPitches: chord, pattern: 'random', rate: 0.25, beats: 4, seed: 99 })
    assert.equal(c.length, 16)
    assert.ok(c.every((note) => chord.includes(note.pitch)))
  })

  it('arpNotes octaves：扩展音域；空和弦/非法输入安全', () => {
    const notes = arpNotes({ chordPitches: chord, pattern: 'up', rate: 0.25, beats: 1, octaves: 2 })
    assert.equal(notes.length, 4)
    assert.ok(notes.some((note) => note.pitch >= 72))
    assert.deepEqual(arpNotes({ chordPitches: [], pattern: 'up' }), [])
    assert.deepEqual(arpNotes({ chordPitches: [null, 'x'], pattern: 'up' }), [])
    const clamped = arpNotes({ chordPitches: [60, 64, 67], rate: 0, beats: 1, gate: 2, velocity: 2, octaves: 99 })
    assert.ok(clamped.length > 0)
    assert.ok(clamped.every((note) => note.dur > 0 && note.vel <= 1 && note.pitch <= 127))
  })
})

describe('R3a theory — Groove / 量化', () => {
  const notes = [
    { pitch: 60, start: 0, dur: 1, vel: 0.8 },
    { pitch: 62, start: 0.5, dur: 0.5, vel: 0.7 },
    { pitch: 64, start: 1, dur: 1, vel: 0.9 },
    { pitch: 65, start: 1.25, dur: 0.5, vel: 0.6 },
  ]

  it('GROOVE_TEMPLATES 含契约 6 个模板，delay 最大 ±1/6', () => {
    assert.deepEqual(GROOVE_TEMPLATE_IDS, ['straight', 'swing55', 'swing60', 'shuffle', 'mpc54', 'mpc58'])
    for (const template of GROOVE_TEMPLATES) assert.ok(Math.abs(template.delay) <= 1 / 6 + 1e-9)
    assert.equal(getGrooveTemplate('nope').id, 'straight')
    assert.equal(getGrooveTemplate({ id: 'swing60' }).id, 'swing60')
  })

  it('applyGroove straight：幂等且返回新数组/不改 pitch/dur/vel', () => {
    const result = applyGroove(notes, 'straight')
    assert.deepEqual(result, notes)
    assert.notEqual(result, notes)
  })

  it('applyGroove swing60：只偏移反拍、onbeat 不变、强度按比例', () => {
    const full = applyGroove(notes, 'swing60', 1)
    assert.equal(full[0].start, 0)
    assert.ok(Math.abs(full[1].start - 0.6) < 1e-9)
    assert.equal(full[2].start, 1)
    const half = applyGroove(notes, 'swing60', 0.5)
    assert.ok(Math.abs(half[1].start - 0.55) < 1e-9)
    for (let i = 0; i < notes.length; i += 1) {
      assert.equal(full[i].pitch, notes[i].pitch)
      assert.equal(full[i].dur, notes[i].dur)
      assert.equal(full[i].vel, notes[i].vel)
    }
  })

  it('applyGroove：mpc54 提前但不产生负 start；未知模板回退 straight', () => {
    const early = applyGroove([{ pitch: 60, start: 0.5, dur: 1, vel: 1 }], 'mpc54')
    assert.ok(early[0].start >= 0 && early[0].start < 0.5)
    const unknown = applyGroove(notes, 'bogus')
    assert.deepEqual(unknown, notes)
  })

  it('quantizeNotes：strength 0/0.5/1 插值', () => {
    const input = [{ pitch: 60, start: 0.33, dur: 1, vel: 1 }]
    assert.equal(quantizeNotes(input, 0.25, 0)[0].start, 0.33)
    assert.ok(Math.abs(quantizeNotes(input, 0.25, 0.5)[0].start - 0.29) < 1e-9)
    assert.equal(quantizeNotes(input, 0.25, 1)[0].start, 0.25)
    // 不改 pitch/dur/vel
    assert.equal(quantizeNotes(input, 0.25, 1)[0].pitch, 60)
    assert.equal(quantizeNotes(input, 0.25, 1)[0].dur, 1)
  })

  it('quantizeNotes：swing 对反拍偏移、偶数步不偏移、grid 生效', () => {
    const input = [
      { pitch: 60, start: 0, dur: 1, vel: 1 },
      { pitch: 62, start: 0.25, dur: 1, vel: 1 },
      { pitch: 64, start: 1, dur: 1, vel: 1 },
    ]
    const swung = quantizeNotes(input, 0.25, 1, 1)
    assert.equal(swung[0].start, 0)
    assert.equal(swung[1].start, 0.25 + 0.25 * 0.5)
    assert.equal(swung[2].start, 1)
    const grid = quantizeNotes([{ pitch: 60, start: 0.4, dur: 1, vel: 1 }], 0.5, 1, 0)
    assert.equal(grid[0].start, 0.5)
    const clamped = quantizeNotes([{ pitch: 60, start: 0.01, dur: 1, vel: 1 }], 0.25, 1, 0)
    assert.ok(clamped[0].start >= 0)
  })

  it('mulberry32：同 seed 同序列、不同 seed 不同序列', () => {
    const a = [mulberry32(3)(), mulberry32(3)(), mulberry32(3)()]
    assert.deepEqual(a, a.map(() => a[0]))
    const rng3 = mulberry32(3)
    const seq3 = [rng3(), rng3(), rng3()]
    const rng4 = mulberry32(4)
    const seq4 = [rng4(), rng4(), rng4()]
    assert.notDeepEqual(seq3, seq4)
  })
})
describe('R3a theory — 补充边界', () => {
  it('scalePitches：极低/极高八度仍夹在 0..127', () => {
    const low = scalePitches('C', 'major', 0)
    assert.ok(low.every((pitch) => pitch >= 0 && pitch <= 127))
    const high = scalePitches('B', 'major', 9)
    assert.ok(high.every((pitch) => pitch >= 0 && pitch <= 127))
    assert.ok(high.every((pitch) => pitch >= 120))
  })

  it('buildChord：数字根音与音名根音等价；不同转位保持音数', () => {
    assert.deepEqual(buildChord({ rootPitch: 60, quality: 'min7' }), buildChord({ rootPitch: 'C4', quality: 'min7' }))
    for (let inversion = 0; inversion <= 3; inversion += 1) {
      const chord = buildChord({ rootPitch: 60, quality: 'min7', inversion })
      assert.equal(chord.length, 4)
      for (let i = 1; i < chord.length; i += 1) assert.ok(chord[i] >= chord[i - 1])
    }
  })

  it('applyGroove：strength=0 不改动；未知模板回退 straight', () => {
    const notes = [{ pitch: 60, start: 0.5, dur: 1, vel: 0.8 }]
    assert.deepEqual(applyGroove(notes, 'shuffle', 0), notes)
    assert.deepEqual(applyGroove(notes, 'unknown-template', 1), notes)
    assert.equal(GROOVE_TEMPLATES.length, 6)
  })

  it('parseRoman：#IV / sus2 / bVII 等扩展；quantize 不改音高/力度', () => {
    assert.deepEqual(parseRoman('#IV', 'C', 'major'), { degree: 4, quality: 'major', rootPitchClass: 6 })
    assert.equal(parseRoman('Isus2', 'C', 'major').quality, 'sus2')
    assert.equal(parseRoman('bVII', 'C', 'major').rootPitchClass, 10)
    const notes = [{ pitch: 64, start: 0.1, dur: 2, vel: 0.42 }]
    const quantized = quantizeNotes(notes, 0.25, 1, 0)
    assert.equal(quantized[0].pitch, 64)
    assert.equal(quantized[0].dur, 2)
    assert.equal(quantized[0].vel, 0.42)
    assert.equal(quantized[0].start, 0)
  })
})
