/**
 * R6d：参考工程分析（纯函数 + 已保存工程读取）。
 *
 * - analyzeProjectProfile(project, {source, title})：BPM/key/scale/tracks(role/engine/preset)/
 *   noteDensity/drumPitches/effectTypes/sendsAvg/sections/summary；
 * - loadReferenceProfile(dataDir, name)：只读已保存工程（不打开、不改 revision）；
 * - 未知/损坏工程抛中文错误。
 */
import { loadProjectFile } from './projects.js'

const clamp01 = (value) => Math.max(0, Math.min(1, value))
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

/** 轨道实际参与编排的音符数（只统计被 clip 引用的 pattern，去重 pattern）。 */
function notesForTrack(project, trackId) {
  const clipPatternIds = new Set()
  for (const clip of safeArray(project.clips)) {
    if (clip?.trackId === trackId && typeof clip.patternId === 'string') clipPatternIds.add(clip.patternId)
  }
  let count = 0
  for (const pattern of safeArray(project.patterns)) {
    if (clipPatternIds.has(pattern.id)) count += safeArray(pattern.notes).length
  }
  return count
}

/** 轨道覆盖的编排长度（小节；无 clip 时按工程长度）。 */
function arrangedBarsForTrack(project, trackId) {
  let bars = 0
  for (const clip of safeArray(project.clips)) {
    if (clip?.trackId === trackId) bars = Math.max(bars, (Number(clip.startBar) || 0) + (Number(clip.lengthBars) || 0))
  }
  return bars > 0 ? bars : Math.max(1, Number(project.lengthBars) || 1)
}

/**
 * 分析工程得到参考 profile（纯函数，不修改工程）。
 * @param {object} project
 * @param {{source?:string, title?:string}} [options]
 */
export function analyzeProjectProfile(project, options = {}) {
  if (project === null || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error('参考分析需要工程对象')
  }
  const tracks = safeArray(project.tracks)
  const trackProfiles = tracks.map((track) => {
    const notes = notesForTrack(project, track.id)
    const bars = arrangedBarsForTrack(project, track.id)
    return {
      role: track.role ?? 'lead',
      kind: track.kind ?? 'synth',
      engine: track.engine === 'subtractive' ? 'subtractive' : 'sampler',
      preset: track.kind === 'synth' ? (track.instrument?.preset ?? null) : null,
      synthPreset: track.kind === 'synth' ? (track.synthPreset ?? null) : null,
      ...(track.kind === 'drum' ? { kit: track.instrument?.kit ?? null } : {}),
      noteCount: notes,
      notesPerBar: round(notes / Math.max(1, bars), 3),
    }
  })
  const drumPitches = [...new Set(
    tracks
      .filter((track) => track.kind === 'drum')
      .flatMap((track) => (track.effects ? [] : []))
      .concat([]),
  )]
  // 鼓音高来自实际编排的 pattern 音符
  for (const track of tracks) {
    if (track.kind !== 'drum') continue
    const clipPatternIds = new Set(safeArray(project.clips).filter((clip) => clip.trackId === track.id).map((clip) => clip.patternId))
    for (const pattern of safeArray(project.patterns)) {
      if (!clipPatternIds.has(pattern.id)) continue
      for (const note of safeArray(pattern.notes)) {
        if (Number.isFinite(Number(note?.pitch))) drumPitches.push(Number(note.pitch))
      }
    }
  }
  const effectTypes = new Set()
  const collectEffects = (chain) => {
    for (const effect of safeArray(chain)) if (typeof effect?.type === 'string') effectTypes.add(effect.type)
  }
  for (const track of tracks) collectEffects(track.effects)
  for (const group of safeArray(project.groups)) collectEffects(group.effects)
  collectEffects(project.master?.effects)
  for (const bus of Object.values(project.buses ?? {})) collectEffects(bus?.effects)
  const sendsValues = tracks.flatMap((track) => [Number(track.sends?.reverb), Number(track.sends?.delay)]).filter((value) => Number.isFinite(value))
  const sendsAvg = sendsValues.length === 0 ? 0 : round(sendsValues.reduce((sum, value) => sum + value, 0) / sendsValues.length, 3)
  let totalPatternNotes = 0
  for (const pattern of safeArray(project.patterns)) totalPatternNotes += safeArray(pattern.notes).length
  const lengthBars = Math.max(1, Number(project.lengthBars) || 1)
  const avgNotesPerBar = round(totalPatternNotes / lengthBars, 3)
  const title = options.title ?? project.title ?? '未命名工程'
  const sectionSummaries = safeArray(project.sections).map((section) => ({
    name: section.name ?? '段落',
    startBar: Number(section.startBar) || 0,
    lengthBars: Number(section.lengthBars) || 0,
  }))
  const summary = `「${title}」：${project.bpm ?? 0} BPM · ${project.key ?? '?'} ${project.scale ?? '?'} · ` +
    `${tracks.length} 轨 · 平均 ${avgNotesPerBar} 音符/小节 · ${sectionSummaries.length} 段`
  return {
    source: options.source ?? 'current',
    title,
    bpm: Number(project.bpm) || 0,
    key: typeof project.key === 'string' ? project.key : 'C',
    scale: typeof project.scale === 'string' ? project.scale : 'minor',
    lengthBars,
    sections: sectionSummaries,
    tracks: trackProfiles,
    avgNotesPerBar,
    drumPitches: [...new Set(drumPitches)].sort((a, b) => a - b),
    effectTypes: [...effectTypes].sort(),
    sendsAvg,
    summary,
  }
}

/**
 * 读取已保存工程并分析（只读，不打开、不改 state）。
 * @param {string} dataDir
 * @param {string} name 工程名
 */
export async function loadReferenceProfile(dataDir, name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('参考工程名不能为空')
  const safeName = name.trim()
  let loaded
  try {
    loaded = await loadProjectFile(dataDir, safeName)
  } catch (error) {
    throw new Error(`无法读取参考工程「${safeName}」：${error?.message ?? error}`)
  }
  const profile = analyzeProjectProfile(loaded.project, { source: `saved:${loaded.name}`, title: loaded.project.title ?? loaded.name })
  return { profile, savedAt: loaded.savedAt, bytes: loaded.bytes }
}

/** 根据 profile 推断生成风格（仅内部用于节奏模板）。 */
export function inferStyleFromProfile(profile) {
  const density = Number(profile?.avgNotesPerBar) || 0
  if (density < 5) return 'cinematic'
  if (density < 9) return 'lofi'
  if (density > 22) return 'techno'
  return 'house'
}

/** 密度/复杂度映射（参考 avgNotesPerBar → generator 参数）。 */
export function mapProfileToGeneratorOptions(profile) {
  const density = Number(profile?.avgNotesPerBar) || 0
  return {
    style: inferStyleFromProfile(profile),
    density: round(clamp01(density / 18), 2),
    complexity: round(clamp01(0.25 + density / 40), 2),
  }
}
