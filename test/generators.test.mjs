/** R6a：确定性生成器单测。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GENERATOR_KINDS,
  GENERATOR_STYLES,
  GM_DRUMS,
  generatePart,
  generateVariation,
  listGeneratorStyles,
} from '../src/shared/generators.js'
import { THEORY_SCALES, noteNameToPitchClass } from '../src/shared/theory.js'

const STYLES = ['house', 'techno', 'lofi', 'pop', 'cinematic']
const KINDS = ['drums', 'bass', 'chords', 'lead', 'arp']

function scalePcs(key, scale) {
  const pcs = new Set()
  const scaleDef = THEORY_SCALES[scale]
  for (const step of scaleDef.steps) pcs.add((noteNameToPitchClass(key) + step) % 12)
  return pcs
}

describe('generators R6a — 常量与结构', () => {
  it('GENERATOR_KINDS/GENERATOR_STYLES 与契约一致', () => {
    assert.deepEqual([...GENERATOR_KINDS], KINDS)
    assert.deepEqual([...GENERATOR_STYLES], STYLES)
    assert.deepEqual(GM_DRUMS, { kick: 36, snare: 38, clap: 39, closedHat: 42, openHat: 46 })
  })

  it('listGeneratorStyles：5 风格且含鼓型配置', () => {
    const styles = listGeneratorStyles()
    assert.equal(styles.length, 5)
    assert.deepEqual(styles.map((item) => item.style), STYLES)
    for (const item of styles) assert.ok(Array.isArray(item.drums.kick) && Array.isArray(item.drums.hat))
  })

  it('所有 kind × style 组合都能生成非空 notes', () => {
    for (const kind of KINDS) {
      for (const style of STYLES) {
        const result = generatePart({ kind, style, bars: 2, seed: 5, key: 'C', scale: 'minor' })
        assert.ok(result.notes.length > 0, `${kind}/${style}`)
        assert.equal(result.summary.kind, kind)
        assert.equal(result.summary.style, style)
        assert.equal(result.summary.bars, 2)
        assert.equal(result.summary.seed, 5)
        assert.equal(result.summary.noteCount, result.notes.length)
      }
    }
  })

  it('drums 只使用 GM 鼓音高', () => {
    const allowed = new Set(Object.values(GM_DRUMS))
    for (const style of STYLES) {
      const { notes } = generatePart({ kind: 'drums', style, bars: 2, seed: 3 })
      for (const note of notes) assert.ok(allowed.has(note.pitch), `${style}:${note.pitch}`)
    }
  })

  it('house drums 四踩与 clap 结构可识别', () => {
    const { notes } = generatePart({ kind: 'drums', style: 'house', bars: 2, seed: 1 })
    const kicks = notes.filter((note) => note.pitch === GM_DRUMS.kick).map((note) => note.start)
    for (const barStart of [0, 4]) {
      for (const beat of [0, 1, 2, 3]) assert.ok(kicks.includes(barStart + beat), `kick ${barStart + beat}`)
    }
    assert.ok(notes.some((note) => note.pitch === GM_DRUMS.clap))
  })

  it('cinematic 鼓比 techno 稀疏', () => {
    const cinematic = generatePart({ kind: 'drums', style: 'cinematic', bars: 4, seed: 2 }).notes.length
    const techno = generatePart({ kind: 'drums', style: 'techno', bars: 4, seed: 2 }).notes.length
    assert.ok(cinematic < techno, `${cinematic} vs ${techno}`)
  })

  it('相同参数（含 seed）完全一致；不同 seed 不同', () => {
    for (const kind of KINDS) {
      const a = generatePart({ kind, style: 'house', bars: 2, seed: 42 })
      const b = generatePart({ kind, style: 'house', bars: 2, seed: 42 })
      assert.deepEqual(a, b, kind)
      const c = generatePart({ kind, style: 'house', bars: 2, seed: 43 })
      assert.notDeepEqual(a.notes, c.notes, kind)
    }
  })

  it('不同 style 产生不同节奏/音高', () => {
    const a = generatePart({ kind: 'bass', style: 'house', bars: 2, seed: 7 })
    const b = generatePart({ kind: 'bass', style: 'cinematic', bars: 2, seed: 7 })
    assert.notDeepEqual(a.notes, b.notes)
  })

  it('音高/时值/力度全部合法且不越界', () => {
    for (const kind of KINDS) {
      for (const style of STYLES) {
        const result = generatePart({ kind, style, bars: 3, barBeats: 4, seed: 11 })
        const maxStart = 12
        for (const note of result.notes) {
          assert.ok(Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127)
          assert.ok(note.start >= 0 && note.start < maxStart)
          assert.ok(note.dur > 0 && note.start + note.dur <= maxStart + 1e-6)
          assert.ok(note.vel >= 0.3 && note.vel <= 1)
        }
        assert.ok(result.notes.length <= 3 * 16)
      }
    }
  })

  it('bass/chords/lead/arp 音高落在 key/scale 内', () => {
    for (const [key, scale] of [['C', 'major'], ['A', 'minor'], ['D', 'dorian']]) {
      const pcs = scalePcs(key, scale)
      for (const kind of ['bass', 'chords', 'lead', 'arp']) {
        const { notes } = generatePart({ kind, style: 'pop', bars: 2, key, scale, seed: 9 })
        for (const note of notes) {
          const pc = note.pitch % 12
          assert.ok(pcs.has(pc), `${kind}/${key}/${scale}:${note.pitch}`)
        }
      }
    }
  })

  it('不同 key 生成不同音高（音阶迁移）', () => {
    const c = generatePart({ kind: 'lead', style: 'pop', bars: 2, key: 'C', scale: 'major', seed: 3 })
    const d = generatePart({ kind: 'lead', style: 'pop', bars: 2, key: 'D', scale: 'major', seed: 3 })
    assert.notDeepEqual(c.notes.map((note) => note.pitch), d.notes.map((note) => note.pitch))
  })

  it('seed 复现：重复调用 deepEqual（不同 kind 均一致）', () => {
    for (const kind of KINDS) {
      assert.deepEqual(
        generatePart({ kind, style: 'techno', bars: 2, seed: 99, density: 0.9, complexity: 0.8 }),
        generatePart({ kind, style: 'techno', bars: 2, seed: 99, density: 0.9, complexity: 0.8 }),
      )
    }
  })

  it('density 影响音符数量（同 seed 下高密度更多）', () => {
    for (const kind of KINDS) {
      const low = generatePart({ kind, style: 'pop', bars: 4, seed: 1, density: 0 }).notes.length
      const high = generatePart({ kind, style: 'pop', bars: 4, seed: 1, density: 1 }).notes.length
      assert.ok(high >= low, `${kind}: ${low} -> ${high}`)
    }
  })

  it('barBeats=3/6 时时间调整正确', () => {
    for (const barBeats of [3, 6]) {
      const { notes } = generatePart({ kind: 'drums', style: 'house', bars: 2, barBeats, seed: 4 })
      for (const note of notes) assert.ok(note.start < 2 * barBeats)
    }
  })

  it('bars 上限与 64 小节生成不超 notes 上限', () => {
    const { notes, summary } = generatePart({ kind: 'drums', style: 'techno', bars: 64, seed: 6 })
    assert.equal(summary.bars, 64)
    assert.ok(notes.length <= 64 * 16)
    for (const note of notes) assert.ok(note.start < 64 * 4)
  })

  it('非法参数抛中文错误', () => {
    const cases = [
      { kind: 'nope' },
      { kind: 'drums', style: 'jazz' },
      { kind: 'drums', bars: 0 },
      { kind: 'drums', bars: 65 },
      { kind: 'drums', seed: -1 },
      { kind: 'drums', seed: 1.5 },
      { kind: 'drums', density: 2 },
      { kind: 'drums', complexity: -1 },
      { kind: 'drums', octave: 9 },
      { kind: 'drums', key: 'H' },
      { kind: 'drums', scale: 'blues' },
      { kind: 'drums', barBeats: 0 },
    ]
    for (const args of cases) assert.throws(() => generatePart(args), /[\u4e00-\u9fa5]/, JSON.stringify(args))
  })

  it('generatePart 不修改传入参数对象', () => {
    const args = { kind: 'bass', style: 'house', bars: 2, seed: 2 }
    const snapshot = JSON.stringify(args)
    generatePart(args)
    assert.equal(JSON.stringify(args), snapshot)
  })

  it('arp 基于和弦音（音高集合为和弦音/音阶子集）', () => {
    const { notes } = generatePart({ kind: 'arp', style: 'pop', bars: 2, key: 'C', scale: 'major', seed: 8 })
    assert.ok(notes.length > 0)
    const pcs = scalePcs('C', 'major')
    for (const note of notes) assert.ok(pcs.has(note.pitch % 12))
  })

  it('lead/chords/bass 在指定 octave 附近（低 octave 更低）', () => {
    const low = generatePart({ kind: 'lead', style: 'pop', bars: 2, octave: 4, seed: 5 }).notes.reduce((sum, note) => sum + note.pitch, 0) / generatePart({ kind: 'lead', style: 'pop', bars: 2, octave: 4, seed: 5 }).notes.length
    const high = generatePart({ kind: 'lead', style: 'pop', bars: 2, octave: 6, seed: 5 }).notes.reduce((sum, note) => sum + note.pitch, 0) / generatePart({ kind: 'lead', style: 'pop', bars: 2, octave: 6, seed: 5 }).notes.length
    assert.ok(high > low, `${low} -> ${high}`)
  })
})

describe('generators R6a — 变体', () => {
  const baseNotes = [
    { pitch: 60, start: 0, dur: 1, vel: 0.8 },
    { pitch: 64, start: 1, dur: 1, vel: 0.7 },
    { pitch: 67, start: 2, dur: 2, vel: 0.9 },
    { pitch: 72, start: 4, dur: 1, vel: 0.6 },
  ]

  it('generateVariation：同 seed 完全一致', () => {
    const a = generateVariation({ notes: baseNotes, seed: 12, density: 1, humanize: 0.3 })
    const b = generateVariation({ notes: baseNotes, seed: 12, density: 1, humanize: 0.3 })
    assert.deepEqual(a, b)
  })

  it('generateVariation：不同 seed 不同；transpose 生效', () => {
    const a = generateVariation({ notes: baseNotes, seed: 1, density: 0.8, humanize: 0.5 })
    const b = generateVariation({ notes: baseNotes, seed: 2, density: 0.8, humanize: 0.5 })
    assert.notDeepEqual(a, b)
    const up = generateVariation({ notes: baseNotes, seed: 3, density: 1, humanize: 0, transpose: 12 })
    for (let index = 0; index < Math.min(up.length, baseNotes.length); index += 1) {
      assert.ok(up[index].pitch >= baseNotes[index].pitch, 'transpose 应向上')
    }
  })

  it('generateVariation：density=0 最少保留 1 音；density=2 全保留', () => {
    const none = generateVariation({ notes: baseNotes, seed: 1, density: 0, humanize: 0 })
    assert.ok(none.length >= 1)
    const all = generateVariation({ notes: baseNotes, seed: 1, density: 2, humanize: 0 })
    assert.ok(all.length >= baseNotes.length)
  })

  it('generateVariation：humanize 造成微时序/力度变化但仍在原时间范围内', () => {
    const variant = generateVariation({ notes: baseNotes, seed: 5, density: 1, humanize: 1 })
    const ends = baseNotes.map((note) => note.start + note.dur)
    for (const note of variant) {
      assert.ok(note.start >= 0 && note.start <= Math.max(...ends))
      assert.ok(note.dur > 0)
      assert.ok(note.vel >= 0.3 && note.vel <= 1)
      assert.ok(note.pitch >= 0 && note.pitch <= 127)
    }
  })

  it('generateVariation：边界（单音/空 notes 错误/非法参数）', () => {
    const single = generateVariation({ notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }], seed: 1 })
    assert.equal(single.length, 1)
    assert.throws(() => generateVariation({ notes: [], seed: 1 }), /非空/)
    assert.throws(() => generateVariation({ notes: baseNotes, seed: 1, transpose: 99 }), /transpose/)
    assert.throws(() => generateVariation({ notes: baseNotes, density: 3 }), /density/)
    assert.throws(() => generateVariation({ notes: baseNotes, humanize: 2 }), /humanize/)
  })
})

/* R6a 补充：生成器边界 */
describe('generators R6a — 补充边界', () => {
  it('drums 每风格 beats 位置落在 [0,bars*barBeats)', () => {
    for (const style of STYLES) {
      const { notes } = generatePart({ kind: 'drums', style, bars: 3, seed: 3 })
      for (const note of notes) assert.ok(note.start >= 0 && note.start < 12)
    }
  })

  it('notes 按 start/pitch 升序', () => {
    for (const kind of KINDS) {
      const { notes } = generatePart({ kind, style: 'pop', bars: 2, seed: 1 })
      for (let index = 1; index < notes.length; index += 1) {
        assert.ok(notes[index].start > notes[index - 1].start || (notes[index].start === notes[index - 1].start && notes[index].pitch >= notes[index - 1].pitch))
      }
    }
  })

  it('chords 每次发声至少 3 个和弦音（同 start 计数）', () => {
    const { notes } = generatePart({ kind: 'chords', style: 'pop', bars: 2, seed: 2 })
    const byStart = new Map()
    for (const note of notes) byStart.set(note.start, (byStart.get(note.start) ?? 0) + 1)
    const polyphonic = [...byStart.values()].filter((count) => count >= 3)
    assert.ok(polyphonic.length > 0)
  })

  it('bass 音高整体低于 lead（同 seed/调）', () => {
    const bass = generatePart({ kind: 'bass', style: 'house', bars: 2, key: 'C', scale: 'minor', seed: 1 }).notes
    const lead = generatePart({ kind: 'lead', style: 'house', bars: 2, key: 'C', scale: 'minor', seed: 1 }).notes
    const avg = (list) => list.reduce((sum, note) => sum + note.pitch, 0) / list.length
    assert.ok(avg(bass) < avg(lead), `${avg(bass)} vs ${avg(lead)}`)
  })

  it('arp 时值间隔符合 rate（0.25 步进）', () => {
    const { notes } = generatePart({ kind: 'arp', style: 'pop', bars: 2, seed: 1 })
    for (const note of notes) {
      const remainder = note.start % 0.25
      assert.ok(remainder < 1e-6 || 0.25 - remainder < 1e-6, String(note.start))
    }
  })

  it('同 seed 下 density/complexity 变化仍确定（重复调用一致）', () => {
    const args = { kind: 'lead', style: 'techno', bars: 2, seed: 9, density: 0.3, complexity: 0.9 }
    assert.deepEqual(generatePart(args), generatePart(args))
  })

  it('variation density=1/humanize=0 时音符数不变', () => {
    const source = generatePart({ kind: 'bass', style: 'house', bars: 2, seed: 1 }).notes
    const variant = generateVariation({ notes: source, seed: 1, density: 1, humanize: 0 })
    assert.equal(variant.length, source.length)
  })

  it('bars=1 与 bars=4 的时间范围不同', () => {
    const one = generatePart({ kind: 'drums', style: 'house', bars: 1, seed: 1 }).notes
    const four = generatePart({ kind: 'drums', style: 'house', bars: 4, seed: 1 }).notes
    for (const note of one) assert.ok(note.start < 4)
    assert.ok(four.some((note) => note.start >= 4))
  })

  it('每个 style 的 drums 至少含 kick', () => {
    for (const style of STYLES) {
      const { notes } = generatePart({ kind: 'drums', style, bars: 2, seed: 2 })
      assert.ok(notes.some((note) => note.pitch === GM_DRUMS.kick), style)
    }
  })

  it('variation 不产生 NaN/负时值', () => {
    const source = generatePart({ kind: 'arp', style: 'lofi', bars: 2, seed: 3 }).notes
    const variant = generateVariation({ notes: source, seed: 4, density: 2, transpose: -5, humanize: 1 })
    for (const note of variant) {
      assert.ok(Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127)
      assert.ok(note.start >= 0 && note.dur > 0 && Number.isFinite(note.vel))
    }
  })
})

/* R6b 补充：生成器规模/边界 */
describe('generators R6b — 补充边界', () => {
  const STYLES = [...GENERATOR_STYLES]
  const KINDS = [...GENERATOR_KINDS]

  it('每个 kind 默认生成非空且 summary 完整', () => {
    for (const kind of KINDS) {
      const result = generatePart({ kind })
      assert.ok(result.notes.length > 0, kind)
      assert.deepEqual(Object.keys(result.summary).sort(), ['bars', 'kind', 'noteCount', 'seed', 'style'])
    }
  })

  it('bars=1..16 全部可生成且不越界', () => {
    for (const bars of [1, 2, 3, 5, 7, 9, 12, 16]) {
      for (const kind of KINDS) {
        const { notes } = generatePart({ kind, bars, seed: 2 })
        assert.ok(notes.length > 0)
        for (const note of notes) assert.ok(note.start < bars * 4)
      }
    }
  })

  it('barBeats=2/8 生成时间正确', () => {
    for (const barBeats of [2, 8]) {
      const { notes } = generatePart({ kind: 'drums', barBeats, bars: 2, seed: 1 })
      for (const note of notes) assert.ok(note.start < 2 * barBeats)
    }
  })

  it('octave 0/8 极值不崩且音高合法', () => {
    for (const octave of [0, 8]) {
      const { notes } = generatePart({ kind: 'lead', octave, bars: 2, seed: 1 })
      for (const note of notes) assert.ok(note.pitch >= 0 && note.pitch <= 127)
    }
  })

  it('seed 0 与最大 seed 可用', () => {
    assert.ok(generatePart({ kind: 'drums', seed: 0 }).notes.length > 0)
    assert.ok(generatePart({ kind: 'drums', seed: 0x7fffffff }).notes.length > 0)
  })

  it('density/complexity 极端值确定且合法', () => {
    for (const [density, complexity] of [[0, 0], [1, 1]]) {
      const a = generatePart({ kind: 'lead', density, complexity, seed: 1 })
      const b = generatePart({ kind: 'lead', density, complexity, seed: 1 })
      assert.deepEqual(a, b)
      for (const note of a.notes) assert.ok(note.vel >= 0.3 && note.vel <= 1)
    }
  })

  it('每个 style 的 chords 至少一次性 ≥3 音叠置', () => {
    for (const style of STYLES) {
      const { notes } = generatePart({ kind: 'chords', style, bars: 2, seed: 3 })
      const counts = new Map()
      for (const note of notes) counts.set(note.start, (counts.get(note.start) ?? 0) + 1)
      assert.ok([...counts.values()].some((count) => count >= 3), style)
    }
  })

  it('每个 style 的 bass 音符时值 ≤ barBeats', () => {
    for (const style of STYLES) {
      const { notes } = generatePart({ kind: 'bass', style, bars: 2, seed: 1 })
      for (const note of notes) assert.ok(note.dur <= 4)
    }
  })

  it('drums 总音符 ≤ bars*16（各 style/bars）', () => {
    for (const style of STYLES) {
      for (const bars of [1, 4, 8]) {
        assert.ok(generatePart({ kind: 'drums', style, bars, seed: 2 }).notes.length <= bars * 16)
      }
    }
  })

  it('所有 kind/style 的 start 非负、dur>0', () => {
    for (const kind of KINDS) {
      for (const style of STYLES) {
        const { notes } = generatePart({ kind, style, bars: 2, seed: 2 })
        for (const note of notes) assert.ok(note.start >= 0 && note.dur > 0)
      }
    }
  })

  it('同 seed 跨 style 的 notes 一般不同（house vs cinematic）', () => {
    for (const kind of KINDS) {
      assert.notDeepEqual(
        generatePart({ kind, style: 'house', bars: 2, seed: 4 }).notes,
        generatePart({ kind, style: 'cinematic', bars: 2, seed: 4 }).notes,
        kind,
      )
    }
  })

  it('variation：source 为各 style 生成结果时均合法', () => {
    for (const style of STYLES) {
      const source = generatePart({ kind: 'lead', style, bars: 2, seed: 1 }).notes
      const variant = generateVariation({ notes: source, seed: 2, density: 0.9, humanize: 0.4 })
      for (const note of variant) {
        assert.ok(note.pitch >= 0 && note.pitch <= 127)
        assert.ok(note.vel >= 0.3 && note.vel <= 1)
        assert.ok(note.dur > 0)
      }
    }
  })

  it('variation transpose -12/+12 生效', () => {
    const source = [{ pitch: 72, start: 0, dur: 1, vel: 0.8 }]
    assert.equal(generateVariation({ notes: source, seed: 1, density: 1, humanize: 0, transpose: -12 })[0].pitch, 60)
    assert.equal(generateVariation({ notes: source, seed: 1, density: 1, humanize: 0, transpose: 12 })[0].pitch, 84)
  })

  it('variation density=2 全保留（数量≥源）', () => {
    const source = generatePart({ kind: 'arp', bars: 2, seed: 1 }).notes
    assert.ok(generateVariation({ notes: source, seed: 1, density: 2, humanize: 0 }).length >= source.length)
  })

  it('variation seed 极限值可用', () => {
    const source = [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }]
    assert.equal(generateVariation({ notes: source, seed: 0 }).length, 1)
    assert.equal(generateVariation({ notes: source, seed: 0x7fffffff }).length, 1)
  })

  it('listGeneratorStyles 每次返回新对象', () => {
    const a = listGeneratorStyles()
    const b = listGeneratorStyles()
    a[0].drums.kick.push(99)
    assert.equal(b[0].drums.kick.includes(99), false)
  })

  it('drums 各 style 都含 kick；house 四踩 ≥ 4 次/2小节', () => {
    for (const style of STYLES) {
      const { notes } = generatePart({ kind: 'drums', style, bars: 2, seed: 1 })
      assert.ok(notes.some((note) => note.pitch === GM_DRUMS.kick), style)
    }
    const house = generatePart({ kind: 'drums', style: 'house', bars: 2, seed: 1 }).notes.filter((note) => note.pitch === GM_DRUMS.kick)
    assert.ok(house.length >= 4)
  })

  it('chords 最低音随 octave 提升', () => {
    const low = generatePart({ kind: 'chords', octave: 3, bars: 2, seed: 1 }).notes
    const high = generatePart({ kind: 'chords', octave: 5, bars: 2, seed: 1 }).notes
    assert.ok(Math.min(...low.map((note) => note.pitch)) < Math.min(...high.map((note) => note.pitch)))
  })

  it('bass 音高通常低于 chords/lead', () => {
    const avg = (notes) => notes.reduce((sum, note) => sum + note.pitch, 0) / notes.length
    const bass = generatePart({ kind: 'bass', key: 'C', scale: 'minor', seed: 2 }).notes
    const lead = generatePart({ kind: 'lead', key: 'C', scale: 'minor', seed: 2 }).notes
    assert.ok(avg(bass) < avg(lead))
  })

  it('bars 越大 notes 越多（至少不减少，drums）', () => {
    const one = generatePart({ kind: 'drums', bars: 2, seed: 3 }).notes.length
    const four = generatePart({ kind: 'drums', bars: 8, seed: 3 }).notes.length
    assert.ok(four > one)
  })

  it('arp 音高在 0..127 且为八度/和弦音', () => {
    const { notes } = generatePart({ kind: 'arp', bars: 2, key: 'G', scale: 'major', seed: 4 })
    for (const note of notes) {
      assert.ok(note.pitch >= 0 && note.pitch <= 127)
      assert.ok([7, 9, 11, 0, 2, 4, 6].includes(note.pitch % 12), String(note.pitch))
    }
  })

  it('seed 复现：同 seed 同 style/kind/bars 深度相等（含 summary）', () => {
    for (const style of STYLES) {
      assert.deepEqual(
        generatePart({ kind: 'chords', style, bars: 3, seed: 12 }),
        generatePart({ kind: 'chords', style, bars: 3, seed: 12 }),
      )
    }
  })

  it('非法 bars/seed/density 全类型错误', () => {
    assert.throws(() => generatePart({ kind: 'lead', bars: 1.5 }), /bars/)
    assert.throws(() => generatePart({ kind: 'lead', bars: 'x' }), /bars/)
    assert.throws(() => generatePart({ kind: 'lead', seed: 'x' }), /seed/)
    assert.throws(() => generatePart({ kind: 'lead', density: 'x' }), /density/)
    assert.throws(() => generatePart({ kind: 'lead', complexity: 2 }), /complexity/)
    assert.throws(() => generatePart({ kind: 'lead', octave: -1 }), /octave/)
  })

  it('generatePart 返回 notes 与 summary 均纯数据（JSON 可序列化）', () => {
    const result = generatePart({ kind: 'drums', bars: 2 })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  })

  it('全部 kinds×styles 的 summary.noteCount 与 notes.length 一致', () => {
    for (const kind of KINDS) {
      for (const style of STYLES) {
        const result = generatePart({ kind, style, bars: 2, seed: 6 })
        assert.equal(result.summary.noteCount, result.notes.length, `${kind}/${style}`)
      }
    }
  })
})
