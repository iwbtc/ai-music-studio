/**
 * R6c：AI 变更日志（纯 diff + 有界日志）。
 *
 * - diffProjectSummary(before, after)：比较 tracks/patterns/clips/sections/bpm/lengthBars/notes，
 *   返回给 UI 的中文摘要数据；
 * - createAiJournal({limit=30})：{record,list,clear}，最多保留 limit 条（新在前）；
 * - 由 standalone server 在 /tool-call 成功且 revision 变化时记录；
 *   读取类工具（revision 不变）与错误调用不记录。
 */
export const AI_JOURNAL_LIMIT = 30

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function byId(list) {
  const map = new Map()
  for (const item of safeArray(list)) {
    if (item && typeof item === 'object' && typeof item.id === 'string') map.set(item.id, item)
  }
  return map
}

function notesCount(patterns) {
  let total = 0
  for (const pattern of safeArray(patterns)) total += safeArray(pattern?.notes).length
  return total
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * 比较两份工程摘要（before/after 可为 null；缺失字段按空/0 处理）。
 * @param {object|null} before
 * @param {object|null} after
 * @returns {object}
 */
export function diffProjectSummary(before, after) {
  const beforeProject = before && typeof before === 'object' ? before : {}
  const afterProject = after && typeof after === 'object' ? after : {}
  const beforeTracks = byId(beforeProject.tracks)
  const afterTracks = byId(afterProject.tracks)
  const beforePatterns = byId(beforeProject.patterns)
  const afterPatterns = byId(afterProject.patterns)
  let tracksAdded = 0
  let tracksRemoved = 0
  let tracksChanged = 0
  const trackNames = []
  for (const [id, track] of afterTracks) {
    if (!beforeTracks.has(id)) {
      tracksAdded += 1
      trackNames.push(track.name ?? id)
    } else if (JSON.stringify(beforeTracks.get(id)) !== JSON.stringify(track)) {
      tracksChanged += 1
      trackNames.push(track.name ?? id)
    }
  }
  for (const [id, track] of beforeTracks) {
    if (!afterTracks.has(id)) {
      tracksRemoved += 1
      trackNames.push(track.name ?? id)
    }
  }
  let patternsAdded = 0
  let patternsRemoved = 0
  let patternsChanged = 0
  const patternDeltas = []
  for (const [id, pattern] of afterPatterns) {
    const previous = beforePatterns.get(id)
    const afterNotes = safeArray(pattern?.notes).length
    if (!previous) {
      patternsAdded += 1
      patternDeltas.push({ patternId: id, name: pattern.name ?? id, beforeNotes: 0, afterNotes })
    } else {
      const beforeNotes = safeArray(previous?.notes).length
      const changed = JSON.stringify(previous) !== JSON.stringify(pattern)
      if (changed) {
        patternsChanged += 1
        patternDeltas.push({ patternId: id, name: pattern.name ?? id, beforeNotes, afterNotes })
      }
    }
  }
  for (const [id, pattern] of beforePatterns) {
    if (!afterPatterns.has(id)) {
      patternsRemoved += 1
      patternDeltas.push({ patternId: id, name: pattern.name ?? id, beforeNotes: safeArray(pattern?.notes).length, afterNotes: 0 })
    }
  }
  patternDeltas.sort((a, b) => String(a.patternId).localeCompare(String(b.patternId)))
  if (patternDeltas.length > 20) patternDeltas.length = 20
  const beforeNotes = notesCount(beforeProject.patterns)
  const afterNotes = notesCount(afterProject.patterns)
  return {
    tracksAdded,
    tracksRemoved,
    tracksChanged,
    patternsAdded,
    patternsRemoved,
    patternsChanged,
    clipsDelta: safeArray(afterProject.clips).length - safeArray(beforeProject.clips).length,
    sectionsDelta: safeArray(afterProject.sections).length - safeArray(beforeProject.sections).length,
    bpm: { before: Number(beforeProject.bpm) || 0, after: Number(afterProject.bpm) || 0 },
    lengthBars: { before: Number(beforeProject.lengthBars) || 0, after: Number(afterProject.lengthBars) || 0 },
    notesDelta: afterNotes - beforeNotes,
    trackNames: [...new Set(trackNames.filter((name) => typeof name === 'string' && name.trim() !== ''))],
    patternDeltas,
  }
}

/**
 * 创建有界 AI 变更日志。
 * @param {{limit?:number}} [options] 最多保留条数（默认 30）
 */
export function createAiJournal(options = {}) {
  const limit = Number.isInteger(Number(options.limit)) && Number(options.limit) > 0 ? Number(options.limit) : AI_JOURNAL_LIMIT
  let entries = []
  let sequence = 0

  /** 记录一条变更（新在前）；返回记录副本。 */
  function record(input = {}) {
    sequence += 1
    const entry = {
      id: `chg_${sequence}`,
      at: new Date().toISOString(),
      tool: typeof input.tool === 'string' ? input.tool : '',
      title: typeof input.title === 'string' && input.title.trim() !== '' ? input.title : input.tool ?? '',
      beforeRev: Number(input.beforeRev) || 0,
      afterRev: Number(input.afterRev) || 0,
      diff: input.diff && typeof input.diff === 'object' ? cloneJson(input.diff) : diffProjectSummary(null, null),
      canUndo: input.canUndo !== false,
      canRedo: input.canRedo === true,
    }
    entries.unshift(entry)
    if (entries.length > limit) entries = entries.slice(0, limit)
    return cloneJson(entry)
  }

  /** 列出变更（新在前；limit/currentRevision 可选过滤）。 */
  function list(options = {}) {
    let result = entries.slice()
    const maxRev = Number(options.currentRevision)
    if (Number.isFinite(maxRev)) result = result.filter((entry) => entry.afterRev <= maxRev)
    const listLimit = Number.isInteger(Number(options.limit)) && Number(options.limit) > 0 ? Number(options.limit) : null
    if (listLimit !== null) result = result.slice(0, listLimit)
    return cloneJson(result)
  }

  /** 清空全部日志。 */
  function clear() {
    entries = []
  }

  return { record, list, clear, get size() { return entries.length }, get limit() { return limit } }
}
