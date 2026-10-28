/** R6d：参考工程分析单测。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  analyzeProjectProfile,
  inferStyleFromProfile,
  loadReferenceProfile,
  mapProfileToGeneratorOptions,
} from '../src/host/reference.js'
import { saveProjectFile } from '../src/host/projects.js'
import { createDemoProject } from '../src/shared/demo.js'
import { createEmptyProject } from '../src/shared/model.js'

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'aims-r6d-ref-'))
}

describe('reference R6d — profile 分析', () => {
  it('demo：BPM/key/scale/lengthBars/source/title', () => {
    const project = createDemoProject()
    const profile = analyzeProjectProfile(project, { source: 'current' })
    assert.equal(profile.bpm, project.bpm)
    assert.equal(profile.key, project.key)
    assert.equal(profile.scale, project.scale)
    assert.equal(profile.lengthBars, project.lengthBars)
    assert.equal(profile.source, 'current')
    assert.equal(profile.title, project.title)
  })

  it('tracks：role/kind/engine/preset 字段完整', () => {
    const profile = analyzeProjectProfile(createDemoProject())
    assert.equal(profile.tracks.length, createDemoProject().tracks.length)
    for (const track of profile.tracks) {
      assert.ok(typeof track.role === 'string')
      assert.ok(['drum', 'synth', 'audio'].includes(track.kind))
      assert.ok(['sampler', 'subtractive'].includes(track.engine))
      assert.ok(Number.isFinite(track.noteCount) && track.noteCount >= 0)
      assert.ok(Number.isFinite(track.notesPerBar) && track.notesPerBar >= 0)
      if (track.kind === 'synth') {
        assert.ok(track.preset === null || typeof track.preset === 'string')
        assert.ok(track.synthPreset === null || typeof track.synthPreset === 'string')
      }
    }
  })

  it('noteCount 求和 = 所有 pattern 音符（只算被 clip 引用）', () => {
    const project = createDemoProject()
    const profile = analyzeProjectProfile(project)
    const total = profile.tracks.reduce((sum, track) => sum + track.noteCount, 0)
    assert.ok(total > 0)
    let patternNotes = 0
    for (const pattern of project.patterns) patternNotes += pattern.notes.length
    assert.ok(total <= patternNotes)
  })

  it('avgNotesPerBar = 全部 pattern notes / lengthBars', () => {
    const project = createDemoProject()
    const profile = analyzeProjectProfile(project)
    let notes = 0
    for (const pattern of project.patterns) notes += pattern.notes.length
    assert.equal(profile.avgNotesPerBar, Math.round((notes / project.lengthBars) * 1000) / 1000)
  })

  it('drumPitches：GM 鼓音高唯一升序', () => {
    const profile = analyzeProjectProfile(createDemoProject())
    assert.ok(profile.drumPitches.length > 0)
    assert.ok(profile.drumPitches.includes(36))
    const sorted = [...new Set(profile.drumPitches)].sort((a, b) => a - b)
    assert.deepEqual(profile.drumPitches, sorted)
    for (const pitch of profile.drumPitches) assert.ok(pitch >= 0 && pitch <= 127)
  })

  it('effectTypes：去重排序，含参考效果器', () => {
    const profile = analyzeProjectProfile(createDemoProject())
    assert.ok(profile.effectTypes.length > 0)
    assert.deepEqual(profile.effectTypes, [...new Set(profile.effectTypes)].sort())
    assert.ok(profile.effectTypes.every((type) => typeof type === 'string'))
  })

  it('sendsAvg：0..1 数字', () => {
    const profile = analyzeProjectProfile(createDemoProject())
    assert.ok(profile.sendsAvg >= 0 && profile.sendsAvg <= 1)
  })

  it('sections：name/startBar/lengthBars 摘要', () => {
    const project = createDemoProject()
    const profile = analyzeProjectProfile(project)
    assert.equal(profile.sections.length, (project.sections ?? []).length)
    for (const section of profile.sections) {
      assert.ok(typeof section.name === 'string')
      assert.ok(Number.isFinite(section.startBar))
      assert.ok(Number.isFinite(section.lengthBars))
    }
  })

  it('summary：含 BPM/轨数/平均音符', () => {
    const profile = analyzeProjectProfile(createDemoProject())
    assert.ok(profile.summary.includes(String(profile.bpm)))
    assert.ok(profile.summary.includes(`${profile.tracks.length} 轨`))
    assert.ok(profile.summary.includes(String(profile.avgNotesPerBar)))
  })

  it('空工程：0 轨/avgNotesPerBar=0，不崩', () => {
    const profile = analyzeProjectProfile(createEmptyProject())
    assert.equal(profile.tracks.length, 0)
    assert.equal(profile.drumPitches.length, 0)
    assert.equal(profile.avgNotesPerBar, 0)
    assert.equal(profile.sendsAvg, 0)
  })

  it('不修改传入工程', () => {
    const project = createDemoProject()
    const before = JSON.stringify(project)
    analyzeProjectProfile(project)
    assert.equal(JSON.stringify(project), before)
  })

  it('非法工程对象抛中文错误', () => {
    for (const value of [null, 'x', 42, []]) {
      assert.throws(() => analyzeProjectProfile(value), /[\u4e00-\u9fa5]/)
    }
  })

  it('自定义工程：每轨 notesPerBar 按该轨编排长度计算', () => {
    const project = createDemoProject()
    const track = project.tracks[0]
    const trackClips = project.clips.filter((clip) => clip.trackId === track.id)
    const bars = Math.max(...trackClips.map((clip) => clip.startBar + clip.lengthBars))
    const profile = analyzeProjectProfile(project)
    const trackProfile = profile.tracks.find((item) => item.role === track.role)
    assert.ok(trackProfile)
    const patternIds = new Set(trackClips.map((clip) => clip.patternId))
    const expectedNotes = [...patternIds]
      .map((patternId) => project.patterns.find((pattern) => pattern.id === patternId)?.notes.length ?? 0)
      .reduce((sum, count) => sum + count, 0)
    assert.equal(trackProfile.noteCount, expectedNotes)
    assert.equal(trackProfile.notesPerBar, Math.round((expectedNotes / bars) * 1000) / 1000)
  })

  it('source/title 可覆盖；title 缺省回退工程标题', () => {
    const project = createDemoProject()
    const custom = analyzeProjectProfile(project, { source: 'saved:X', title: 'X' })
    assert.equal(custom.source, 'saved:X')
    assert.equal(custom.title, 'X')
    assert.equal(analyzeProjectProfile(project).title, project.title)
  })
})

describe('reference R6d — 已保存工程读取', () => {
  it('保存 demo 后 loadReferenceProfile 返回 profile 与 savedAt', async () => {
    const dir = await tempDir()
    try {
      const project = createDemoProject()
      await saveProjectFile(dir, '参考A', project)
      const loaded = await loadReferenceProfile(dir, '参考A')
      assert.equal(loaded.profile.source, 'saved:参考A')
      assert.equal(loaded.profile.bpm, project.bpm)
      assert.equal(loaded.profile.key, project.key)
      assert.ok(loaded.savedAt > 0)
      assert.ok(loaded.bytes > 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('未知工程中文错误', async () => {
    const dir = await tempDir()
    try {
      await assert.rejects(loadReferenceProfile(dir, '不存在'), /[\u4e00-\u9fa5]/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('损坏 JSON 中文错误', async () => {
    const dir = await tempDir()
    try {
      const projectsDir = path.join(dir, 'projects')
      await mkdir(projectsDir, { recursive: true })
      await writeFile(path.join(projectsDir, '坏工程.json'), '{ not json', 'utf8')
      await assert.rejects(loadReferenceProfile(dir, '坏工程'), /[\u4e00-\u9fa5]/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('工程名为空中文错误', async () => {
    const dir = await tempDir()
    try {
      await assert.rejects(loadReferenceProfile(dir, '   '), /[\u4e00-\u9fa5]/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('读取不修改文件内容', async () => {
    const dir = await tempDir()
    try {
      const project = createDemoProject()
      await saveProjectFile(dir, '只读', project)
      const file = path.join(dir, 'projects', '只读.json')
      const before = await (await import('node:fs/promises')).readFile(file, 'utf8')
      await loadReferenceProfile(dir, '只读')
      const after = await (await import('node:fs/promises')).readFile(file, 'utf8')
      assert.equal(after, before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('reference R6d — 风格/密度映射', () => {
  it('inferStyleFromProfile：低/中/高密度', () => {
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 2 }), 'cinematic')
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 6 }), 'lofi')
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 12 }), 'house')
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 30 }), 'techno')
  })

  it('mapProfileToGeneratorOptions：density/complexity 在 0..1', () => {
    for (const avgNotesPerBar of [0, 3, 8, 16, 30, 60]) {
      const mapped = mapProfileToGeneratorOptions({ avgNotesPerBar })
      assert.ok(['house', 'techno', 'lofi', 'pop', 'cinematic'].includes(mapped.style))
      assert.ok(mapped.density >= 0 && mapped.density <= 1)
      assert.ok(mapped.complexity >= 0 && mapped.complexity <= 1)
    }
  })

  it('mapProfileToGeneratorOptions：密度越高 complexity 越大', () => {
    const low = mapProfileToGeneratorOptions({ avgNotesPerBar: 2 })
    const high = mapProfileToGeneratorOptions({ avgNotesPerBar: 30 })
    assert.ok(high.complexity >= low.complexity)
    assert.ok(high.density >= low.density)
  })

  it('空 profile 不崩（默认值）', () => {
    const mapped = mapProfileToGeneratorOptions({})
    assert.equal(mapped.style, 'cinematic')
    assert.equal(mapped.density, 0)
  })
})

/* R6d 补充：profile 边界（reference.test 追加） */
describe('reference R6d — 补充边界', () => {
  it('已保存空工程 profile：0 轨', async () => {
    const dir = await tempDir()
    try {
      await saveProjectFile(dir, '空参考', createEmptyProject())
      const loaded = await loadReferenceProfile(dir, '空参考')
      assert.equal(loaded.profile.tracks.length, 0)
      assert.equal(loaded.profile.avgNotesPerBar, 0)
      assert.ok(loaded.profile.summary.length > 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('工程名首尾空格自动 trim', async () => {
    const dir = await tempDir()
    try {
      await saveProjectFile(dir, 'Trim参考', createDemoProject())
      const loaded = await loadReferenceProfile(dir, '  Trim参考  ')
      assert.equal(loaded.profile.source, 'saved:Trim参考')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('无鼓轨工程：drumPitches=[]', () => {
    const project = createEmptyProject()
    project.tracks = [{ id: 'trk_1', kind: 'synth', role: 'lead', name: 'L', engine: 'sampler', instrument: { preset: 'grand_piano' } }]
    const profile = analyzeProjectProfile(project)
    assert.deepEqual(profile.drumPitches, [])
  })

  it('未使用的 pattern 计入 avgNotesPerBar，但不计入 track noteCount', () => {
    const project = createDemoProject()
    const extra = JSON.parse(JSON.stringify(project.patterns[0]))
    extra.id = 'pat_unused_1'
    extra.notes = Array.from({ length: 10 }, (_, index) => ({ pitch: 60, start: index, dur: 0.5, vel: 0.8 }))
    project.patterns.push(extra)
    const profile = analyzeProjectProfile(project)
    const trackTotal = profile.tracks.reduce((sum, track) => sum + track.noteCount, 0)
    let patternNotes = 0
    for (const pattern of project.patterns) patternNotes += pattern.notes.length
    assert.ok(trackTotal < patternNotes)
    assert.equal(profile.avgNotesPerBar, Math.round((patternNotes / project.lengthBars) * 1000) / 1000)
  })

  it('master/bus 效果器计入 effectTypes', () => {
    const project = createEmptyProject()
    project.master.effects = [{ id: 'fx_m1', type: 'compressor', enabled: true, params: {} }]
    project.buses = { reverb: { level: 0.3, effects: [{ id: 'fx_b1', type: 'eq3', enabled: true, params: {} }] }, delay: { level: 0.2, effects: [] } }
    const profile = analyzeProjectProfile(project)
    assert.ok(profile.effectTypes.includes('compressor'))
    assert.ok(profile.effectTypes.includes('eq3'))
  })

  it('sendsAvg 为所有轨 (reverb+delay)/2 的均值', () => {
    const project = createEmptyProject()
    project.tracks = [
      { id: 'a', kind: 'synth', role: 'lead', name: 'A', sends: { reverb: 0.4, delay: 0.2 } },
      { id: 'b', kind: 'synth', role: 'bass', name: 'B', sends: { reverb: 0.2, delay: 0.4 } },
    ]
    const profile = analyzeProjectProfile(project)
    assert.equal(profile.sendsAvg, 0.3)
  })

  it('自定义 section 摘要', () => {
    const project = createEmptyProject()
    project.sections = [{ id: 'sec_1', name: 'Intro', startBar: 0, lengthBars: 4, color: '#123456' }]
    const profile = analyzeProjectProfile(project)
    assert.deepEqual(profile.sections, [{ name: 'Intro', startBar: 0, lengthBars: 4 }])
  })

  it('mapProfileToGeneratorOptions：超高密度 density 上限 1', () => {
    const mapped = mapProfileToGeneratorOptions({ avgNotesPerBar: 100 })
    assert.equal(mapped.density, 1)
    assert.ok(mapped.complexity <= 1)
  })

  it('inferStyleFromProfile：边界值', () => {
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 4.99 }), 'cinematic')
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 5 }), 'lofi')
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 8.99 }), 'lofi')
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 9 }), 'house')
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 22 }), 'house')
    assert.equal(inferStyleFromProfile({ avgNotesPerBar: 22.01 }), 'techno')
  })

  it('tracks 缺 role 时回退 lead', () => {
    const project = createEmptyProject()
    project.tracks = [{ id: 'trk_x', kind: 'synth', name: 'X' }]
    assert.equal(analyzeProjectProfile(project).tracks[0].role, 'lead')
  })

  it('音效/发送缺失时安全回退', () => {
    const project = createEmptyProject()
    project.tracks = [{ id: 'trk_x', kind: 'synth', name: 'X' }]
    const profile = analyzeProjectProfile(project)
    assert.deepEqual(profile.effectTypes, [])
    assert.equal(profile.sendsAvg, 0)
  })
})
