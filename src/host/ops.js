/**
 * AI 音乐工作室 — Host 项目变更纯函数层。
 *
 * 设计原则：
 * - 只操作传入的 project 对象（由 state.mutate 传入的 draft），**不碰 fs / 网络 / 定时器**，
 *   因此可被 node:test 直接单测，也可被 tools.js / routes.js 复用。
 * - 每个 op 先做完整校验、再一次性写入（校验失败抛 OpError，绝不留下半改状态）。
 * - 返回「紧凑」的 JSON 结果，供工具层直接透出给模型；概览不包含全部音符。
 *
 * 错误类型：OpError（message 为面向模型的中文说明）。
 */
import {
  DRUM_KITS,
  DRUM_PARAM_SPECS,
  DRUM_PIECES,
  FX_PARAM_SPECS,
  FX_TYPES,
  SYNTH_INSTRUMENTS,
  SYNTH_INSTRUMENT_PARAM_SPECS,
  LIMITS,
  NOTE_NAMES,
  SCALES,
  SYNTH_PRESETS,
  TRACK_COLORS,
  TRACK_ROLES,
  coerceParam,
  findFxType,
  findRole,
  findSynthInstrument,
  findScale,
  findSynthPreset,
} from '../shared/catalog.js'
import { MAX_TEMPO_POINTS, TEMPO_MAX_BPM, TEMPO_MIN_BPM, createTempoMap, normalizeTempoPoints } from '../shared/tempo.js'
import {
  CHORD_QUALITIES,
  GROOVE_TEMPLATE_IDS,
  SUGGESTED_PROGRESSIONS,
  applyGroove as applyGrooveNotes,
  arpNotes,
  buildChord,
  diatonicChords,
  getGrooveTemplate,
  noteNameToPitchClass,
  pitchClassToName,
  parseRoman,
  quantizeNotes,
  scalePitches,
  THEORY_SCALES,
} from '../shared/theory.js'
import { listProjectTemplates, createProjectFromTemplate } from '../shared/templates.js'
import { GENERATOR_KINDS, GENERATOR_STYLES, generatePart, generateVariation } from '../shared/generators.js'
import { mapProfileToGeneratorOptions } from './reference.js'
import { buildMixSuggestions, applyMixSuggestions } from '../shared/ai-mix.js'
import { PLUGIN_SDK_VERSION, listPlugins as listPluginInventory } from '../shared/plugins.js'
export { projectStats } from '../shared/model.js'

import {
  AUTOMATION_MAX_POINTS,
  MAX_PLUGIN_STATE_BYTES,
  AUTOMATION_PARAMS,
  BUS_IDS,
  MAX_MEDIA,
  MEDIA_DEFAULT_CLIP_BARS,
  SIDECHAIN_DEFAULTS,
  automationSummary,
  beatsPerBar,
  busSummary,
  captureSceneState,
  clamp01,
  clampPan,
  createEmptyProject,
  makeClip,
  makeEffect,
  makeIdGen,
  GROUP_NAME_MAX,
  INSTRUMENT_PARAM_SPECS,
  TRACK_ENGINES,
  MAX_GROUPS,
  MAX_SCENES,
  SCENE_NAME_MAX,
  PDC_MS_MAX,
  TRACK_AUTOMATION_MODES,
  TRACK_SEND_MODES,
  MIDI_MAPPING_MAX,
  MIDI_MAPPING_TARGETS,
  effectParamIds,
  makePattern,
  makeSection,
  EXPORT_HISTORY_LIMIT,
  SCHEMA_VERSION,
  makeTrack,
  mediaSummary,
  AUDIO_CLIP_FADE_MAX_SECONDS,
  AUDIO_CLIP_GAIN_DB_MAX,
  AUDIO_CLIP_GAIN_DB_MIN,
  AUDIO_CLIP_SEMITONES_MAX,
  AUDIO_CLIP_SEMITONES_MIN,
  AUDIO_CLIP_STRETCH_RATIO_MAX,
  AUDIO_CLIP_STRETCH_RATIO_MIN,
  audioClipLengthSeconds,
  audioClipPlayableSeconds,
  audioClipSourceSeconds,
  normalizeAudioClipSemitones,
  normalizeAudioClipStretchRatio,
  TAKE_INDEX_MAX,
  normalizeAudioClipFields,
  normalizePdcMs,
  normalizeAudioClipFadeSeconds,
  normalizeAudioClipGainDb,
  normalizeTakeActive,
  normalizeTakeGroup,
  normalizeTakeIndex,
  normalizeAutomation,
  normalizeBuses,
  normalizeEffects,
  normalizeInstrumentParams,
  normalizeSceneName,
  normalizeSynthParams,
  synthPresetDefaults,
  normalizeClipOffset,
  normalizeExportHistoryEntry,
  normalizeExportJobs,
  normalizeExternalPlugin,
  MAX_EXTERNAL_PLUGIN_INSTANCES,
  normalizeMedia,
  normalizeNote,
  normalizeProject,
  normalizeSidechain,
  normalizeSustainPoints,
  normalizeVibrato,
  projectStats,
  normalizeSidechainTriggerNotes,
  sceneSummary,
  sidechainSummary,
  sustainSummary,
  vibratoSummary,
} from '../shared/model.js'

/** 结构化校验错误：message 直接回给模型。 */
export class OpError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OpError'
    this.code = 'INVALID_ARGS'
  }
}

/** 抛出校验错误。 */
const fail = (message) => {
  throw new OpError(message)
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const MAX_NAME = 80
const MAX_TITLE = 120
const MAX_PATTERN_NAME = 60
const MAX_SECTION_NAME = 60
const MAX_ACTIVITY = 200
/** 概览里最多列出的 clip / pattern / media 数量（保证返回 JSON 紧凑）。 */
const OVERVIEW_MAX_CLIPS = 96
const OVERVIEW_MAX_PATTERNS = 64
const OVERVIEW_MAX_MEDIA = 32

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const round = (v, digits = 4) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  const k = 10 ** digits
  return Math.round(n * k) / k
}

/* ------------------------------------------------------------------------- */
/* 基础校验                                                                   */
/* ------------------------------------------------------------------------- */

/** 必填字符串（自动 trim，限长）。 */
function requireString(value, field, { max = MAX_NAME, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(`${field} 必须是字符串`)
  const text = value.trim()
  if (!allowEmpty && text.length === 0) fail(`${field} 不能为空`)
  if (text.length > max) fail(`${field} 太长（最多 ${max} 字符）`)
  return text
}

/** 可选字符串：undefined/null 返回 fallback，否则按必填字符串校验。 */
function optionalString(value, field, opts = {}) {
  if (value === undefined || value === null) return undefined
  return requireString(value, field, opts)
}

/** 必填有限数字，可带范围。 */
function requireNumber(value, field, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n)) fail(`${field} 必须是数字`)
  if (integer && !Number.isInteger(n)) fail(`${field} 必须是整数`)
  if (n < min || n > max) fail(`${field} 超出范围（${min} ~ ${max}），收到 ${n}`)
  return n
}

/** 可选数字，带范围。 */
function optionalNumber(value, field, opts) {
  if (value === undefined || value === null) return undefined
  return requireNumber(value, field, opts)
}

/** 必填有限数字（不做范围校验；用于会被钳制的 0..1 / -1..1 参数）。 */
function strictFiniteNumber(value, field) {
  const n = Number(value)
  if (!Number.isFinite(n)) fail(`${field} 必须是数字`)
  return n
}

/** 布尔归一：接受 true/false、"true"/"false"、1/0。 */
function coerceBool(value, field) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  fail(`${field} 必须是布尔值`)
}

/** 颜色校验：'#RRGGBB'，否则报错。 */
function requireColor(value, field = 'color') {
  const text = requireString(value, field, { max: 7 })
  if (!HEX_COLOR.test(text)) fail(`${field} 必须是 #RRGGBB 格式的十六进制颜色`)
  return text
}

/** 音名校验（如 F# / C / Bb），返回规范化大写形式。 */
function requireKey(value) {
  const text = requireString(value, 'key', { max: 4 })
  const normalized = text.replace('♯', '#').replace('♭', 'b').toUpperCase()
  const candidates = NOTE_NAMES.map((n) => n.toUpperCase())
  if (!candidates.includes(normalized)) {
    fail(`key 必须是音名（${NOTE_NAMES.join(' / ')}），收到 ${text}`)
  }
  return normalized
}

/** 找不到轨道时给出「可用 id」提示的错误。 */
function getTrack(project, trackId) {
  const id = requireString(trackId, 'trackId', { max: 64 })
  const track = project.tracks.find((t) => t.id === id)
  if (!track) {
    const ids = project.tracks.map((t) => t.id).join(', ') || '（当前没有任何轨道）'
    fail(`找不到轨道 ${id}；可用轨道：${ids}`)
  }
  return track
}

/** 找不到 pattern 时给出提示的错误。 */
function getPattern(project, patternId) {
  const id = requireString(patternId, 'patternId', { max: 64 })
  const pattern = project.patterns.find((p) => p.id === id)
  if (!pattern) {
    const ids = project.patterns.map((p) => p.id).join(', ') || '（当前没有任何 pattern）'
    fail(`找不到 pattern ${id}；可用 pattern：${ids}`)
  }
  return pattern
}

/** 找不到媒体时给出提示的错误。 */
function getMedia(project, mediaId) {
  const id = requireString(mediaId, 'mediaId', { max: 64 })
  const media = (project.media ?? []).find((item) => item.id === id)
  if (!media) {
    const ids = (project.media ?? []).map((item) => `${item.id}(${item.name})`).join(', ')
    fail(`找不到音频媒体 ${id}；可用媒体：${ids || '（当前工程没有音频媒体，请先导入音频）'}`)
  }
  return media
}

/**
 * 解析 effects 目标：'master' / 'bus'（需 busId）或轨道 id。
 * 返回 { chain, meta, label, max }；meta 用于结果里回传 target（bus 时带 busId）。
 */
function resolveEffectTarget(project, target, busId, groupId) {
  const raw = requireString(target, 'target', { max: 64 })
  if (raw === 'master') {
    return { chain: project.master.effects, meta: { target: 'master' }, label: 'master', max: LIMITS.maxMasterEffects }
  }
  // R4a：group FX 链（target='group' 必须提供 groupId）。
  // v2.1：允许 target 直接传 group id（grp_n），兼容旧调用/UI；也支持 target='group'+groupId。
  const directGroup = (project.groups ?? []).find((item) => item.id === raw)
  if (directGroup) {
    return {
      chain: directGroup.effects,
      meta: { target: 'group', groupId: directGroup.id },
      label: `group:${directGroup.id}`,
      max: LIMITS.maxEffectsPerTrack,
    }
  }
  if (raw === 'group') {
    const id = requireString(groupId, 'groupId', { max: 64 })
    const group = (project.groups ?? []).find((item) => item.id === id)
    if (!group) fail(`未知 group groupId=${id}；可用：${(project.groups ?? []).map((item) => item.id).join(' / ') || '无'}`)
    return {
      chain: group.effects,
      meta: { target: 'group', groupId: id },
      label: `group:${id}`,
      max: LIMITS.maxEffectsPerTrack,
    }
  }
  if (raw === 'bus') {
    const id = requireString(busId, 'busId', { max: 16 })
    if (!BUS_IDS.includes(id)) fail(`未知返回总线 busId=${id}；可选：${BUS_IDS.join(' / ')}`)
    ensureBusStructure(project)
    return {
      chain: project.buses[id].effects,
      meta: { target: 'bus', busId: id },
      label: `bus:${id}`,
      max: LIMITS.maxEffectsPerTrack,
    }
  }
  const track = getTrack(project, raw)
  return { chain: track.effects, meta: { target: track.id }, label: track.id, max: LIMITS.maxEffectsPerTrack }
}

/** 确保 project.buses 是对象结构（缺失/损坏时按默认规范化），返回 buses。 */
function ensureBusStructure(project) {
  if (!isObject(project.buses) || isObject(project.buses.reverb) === false || isObject(project.buses.delay) === false) {
    project.buses = normalizeBuses(project.buses)
  }
  return project.buses
}

/** 按类型校验/归一效果器参数：已知键用 catalog 规格钳制，未知键报错。 */
function coerceFxParams(type, params, field = 'params') {
  if (params === undefined || params === null) return {}
  if (!isObject(params)) fail(`${field} 必须是对象，如 { cutoff: 1200, resonance: 6 }`)
  const specs = FX_PARAM_SPECS[type] ?? {}
  const validKeys = Object.keys(specs)
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    const spec = specs[key]
    if (!spec) {
      fail(`效果器 ${type} 没有参数 ${key}；可用参数：${validKeys.join(' / ') || '（该效果器无参数）'}`)
    }
    const coerced = coerceParam(spec, value)
    if (coerced === undefined) {
      const options = spec.type === 'enum' ? `（可选值：${spec.options.join(' / ')}）` : ''
      fail(`效果器参数 ${key} 非法${options}，收到 ${JSON.stringify(value)}`)
    }
    out[key] = coerced
  }
  return out
}

/** 合成器/鼓机参数覆盖：已知键按规格钳制，未知键报错（避免模型误以为改了参数）。 */
function coerceInstrumentParams(track, params, field = 'params') {
  if (params === undefined || params === null) return {}
  if (!isObject(params)) fail(`${field} 必须是对象，如 { kickPitch: 48, kickDecay: 0.5 }`)
  // P12 clean break：旧合成音色已移除；采样乐器没有合成参数，只有采样鼓机支持参数。
  if (track.kind !== 'drum') fail('采样乐器没有合成参数（P12 起旧合成音色已移除）；params 只支持采样鼓机轨道')
  const specs = DRUM_PARAM_SPECS
  const validKeys = Object.keys(specs)
  const out = {}
  for (const [key, value] of Object.entries(params)) {
    const spec = specs[key]
    if (!spec) {
      fail(`不存在鼓组参数 ${key}；可用参数：${validKeys.join(' / ')}`)
    }
    const coerced = coerceParam(spec, value)
    if (coerced === undefined) {
      const options = spec.type === 'enum' ? `（可选值：${spec.options.join(' / ')}）` : ''
      fail(`乐器参数 ${key} 非法${options}，收到 ${JSON.stringify(value)}`)
    }
    out[key] = coerced
  }
  return out
}

/** 校验音符数组（返回归一后的数组）。 */
function validateNotes(notes) {
  if (!Array.isArray(notes)) fail('notes 必须是数组，每项形如 { pitch:60, start:0, dur:1, vel:0.8 }')
  if (notes.length > LIMITS.maxNotesPerPattern) {
    fail(`音符数量 ${notes.length} 超过上限 ${LIMITS.maxNotesPerPattern}；请精简或拆成多个 pattern`)
  }
  return notes.map((note, index) => {
    if (!isObject(note)) fail(`notes[${index}] 必须是对象，如 { pitch:60, start:0, dur:1 }`)
    const pitch = Number(note.pitch)
    const start = Number(note.start)
    const dur = Number(note.dur)
    if (!Number.isFinite(pitch)) fail(`notes[${index}].pitch 必须是数字（0-127）`)
    if (pitch < 0 || pitch > 127) fail(`notes[${index}].pitch 超出范围（0-127），收到 ${pitch}`)
    if (!Number.isFinite(start)) fail(`notes[${index}].start 必须是数字（单位 beat）`)
    if (start < 0) fail(`notes[${index}].start 不能为负数`)
    if (!Number.isFinite(dur)) fail(`notes[${index}].dur 必须是数字（单位 beat）`)
    if (dur <= 0) fail(`notes[${index}].dur 必须大于 0`)
    if (note.vel !== undefined && note.vel !== null && !Number.isFinite(Number(note.vel))) {
      fail(`notes[${index}].vel 必须是 0~1 的数字`)
    }
    return normalizeNote(note)
  })
}

/** 校验 clip 描述数组（可选保留已有 id，供 UI 增量编辑时维持选中状态）。 */
function validateClips(project, clips) {
  if (!Array.isArray(clips)) fail('clips 必须是数组')
  if (clips.length > LIMITS.maxClips) fail(`clip 数量 ${clips.length} 超过上限 ${LIMITS.maxClips}`)
  const trackIds = new Set(project.tracks.map((t) => t.id))
  const patternIds = new Set(project.patterns.map((p) => p.id))
  const mediaIds = new Set((project.media ?? []).map((m) => m.id))
  const mediaById = new Map((project.media ?? []).map((m) => [m.id, m]))
  const tracksById = new Map(project.tracks.map((t) => [t.id, t]))
  return clips.map((clip, index) => {
    const where = `clips[${index}]`
    if (!isObject(clip)) fail(`${where} 必须是对象`)
    const trackId = requireString(clip.trackId, `${where}.trackId`, { max: 64 })
    if (!trackIds.has(trackId)) fail(`${where}.trackId=${trackId} 不存在；可用轨道：${[...trackIds].join(', ') || '无'}`)
    const hasPattern = clip.patternId !== undefined && clip.patternId !== null && clip.patternId !== ''
    const hasMedia = clip.mediaId !== undefined && clip.mediaId !== null && clip.mediaId !== ''
    if (hasPattern && hasMedia) fail(`${where} 不能同时提供 patternId 与 mediaId（pattern 片段或音频片段二选一）`)
    if (!hasPattern && !hasMedia) fail(`${where} 必须提供 patternId（pattern 片段）或 mediaId（音频片段）`)
    const startBar = requireNumber(clip.startBar ?? 0, `${where}.startBar`, { min: 0, max: LIMITS.maxBars, integer: true })
    const lengthBars = requireNumber(clip.lengthBars ?? 1, `${where}.lengthBars`, { min: 1, max: LIMITS.maxBars, integer: true })
    if (hasMedia) {
      // P3b：音频片段（引用 project.media；必须放在音频轨上）
      const mediaId = requireString(clip.mediaId, `${where}.mediaId`, { max: 64 })
      if (!mediaIds.has(mediaId)) fail(`${where}.mediaId=${mediaId} 不存在；可用媒体：${[...mediaIds].join(', ') || '无'}`)
      const track = tracksById.get(trackId)
      if (track?.kind !== 'audio') fail(`${where}.trackId=${trackId} 不是音频轨；音频片段必须放在音频轨上`)
      if (startBar + lengthBars > LIMITS.maxBars) {
        fail(`${where} 结束于第 ${startBar + lengthBars} 小节，超过最大曲长 ${LIMITS.maxBars}`)
      }
      const id = typeof clip.id === 'string' && /^clip_[0-9]+$/.test(clip.id) ? clip.id : null
      // P6：offsetSeconds = 从媒体第几秒开始播放；非法/NaN/负数回 0，按媒体时长夹紧。
      const offsetSeconds = normalizeClipOffset(clip.offsetSeconds, mediaById.get(mediaId))
      // R2a：gain/fade/reverse 严格校验（setClips 显式重写不应静默丢字段）。
      let gainDb = 0
      if (clip.gainDb !== undefined && clip.gainDb !== null) {
        const numeric = Number(clip.gainDb)
        if (!Number.isFinite(numeric) || numeric < AUDIO_CLIP_GAIN_DB_MIN || numeric > AUDIO_CLIP_GAIN_DB_MAX) {
          fail(`${where}.gainDb 必须在 ${AUDIO_CLIP_GAIN_DB_MIN}..${AUDIO_CLIP_GAIN_DB_MAX} dB 之间`)
        }
        gainDb = normalizeAudioClipGainDb(numeric)
      }
      let fadeInSeconds = 0
      let fadeOutSeconds = 0
      for (const [field, setter] of [
        ['fadeInSeconds', (value) => { fadeInSeconds = value }],
        ['fadeOutSeconds', (value) => { fadeOutSeconds = value }],
      ]) {
        if (clip[field] === undefined || clip[field] === null) continue
        const numeric = Number(clip[field])
        if (!Number.isFinite(numeric) || numeric < 0 || numeric > AUDIO_CLIP_FADE_MAX_SECONDS) {
          fail(`${where}.${field} 必须在 0..${AUDIO_CLIP_FADE_MAX_SECONDS} 秒之间`)
        }
        setter(normalizeAudioClipFadeSeconds(numeric))
      }
      let reverse = false
      if (clip.reverse !== undefined && clip.reverse !== null) {
        if (typeof clip.reverse !== 'boolean') fail(`${where}.reverse 必须是布尔值`)
        reverse = clip.reverse === true
      }
      // R2b：stretchRatio 0.25..4（3 位小数、1 省略）/ semitones -12..12（1 位小数、0 省略）。
      let stretchRatio = 1
      if (clip.stretchRatio !== undefined && clip.stretchRatio !== null) {
        const numeric = Number(clip.stretchRatio)
        if (!Number.isFinite(numeric) || numeric < AUDIO_CLIP_STRETCH_RATIO_MIN || numeric > AUDIO_CLIP_STRETCH_RATIO_MAX) {
          fail(`${where}.stretchRatio 必须在 ${AUDIO_CLIP_STRETCH_RATIO_MIN}..${AUDIO_CLIP_STRETCH_RATIO_MAX} 之间`)
        }
        stretchRatio = normalizeAudioClipStretchRatio(numeric)
      }
      let semitones = 0
      if (clip.semitones !== undefined && clip.semitones !== null) {
        const numeric = Number(clip.semitones)
        if (!Number.isFinite(numeric) || numeric < AUDIO_CLIP_SEMITONES_MIN || numeric > AUDIO_CLIP_SEMITONES_MAX) {
          fail(`${where}.semitones 必须在 ${AUDIO_CLIP_SEMITONES_MIN}..${AUDIO_CLIP_SEMITONES_MAX} 半音之间`)
        }
        semitones = normalizeAudioClipSemitones(numeric)
      }
      // R2c：takeGroup/takeIndex/takeActive（无 group 时不能单独给 index/active）。
      let takeGroup = null
      let takeIndex = null
      let takeActive = true
      const hasTakeGroup = clip.takeGroup !== undefined && clip.takeGroup !== null && clip.takeGroup !== ''
      const hasTakeIndex = clip.takeIndex !== undefined && clip.takeIndex !== null
      const hasTakeActive = clip.takeActive !== undefined && clip.takeActive !== null
      if (hasTakeGroup) {
        takeGroup = normalizeTakeGroup(clip.takeGroup)
        if (takeGroup === null) fail(`${where}.takeGroup 必须是 1..64 位安全字符（字母/数字/_/-）`)
        if (hasTakeIndex) {
          takeIndex = normalizeTakeIndex(clip.takeIndex)
          if (takeIndex === null) fail(`${where}.takeIndex 必须是 0..${TAKE_INDEX_MAX} 的整数`)
        }
        if (hasTakeActive) {
          if (typeof clip.takeActive !== 'boolean') fail(`${where}.takeActive 必须是布尔值`)
          takeActive = normalizeTakeActive(clip.takeActive)
        }
      } else if (hasTakeIndex || hasTakeActive) {
        fail(`${where} 设置 takeIndex/takeActive 时必须同时提供 takeGroup`)
      }
      const audioCandidate = { mediaId, startBar, lengthBars, offsetSeconds, stretchRatio }
      const playable = audioClipPlayableSeconds(project, audioCandidate)
      if (fadeInSeconds + fadeOutSeconds > playable + 1e-6) {
        fail(`${where} fadeIn+fadeOut=${round(fadeInSeconds + fadeOutSeconds, 3)}s 超过可播放时长 ${round(playable, 3)}s`)
      }
      return {
        id,
        trackId,
        mediaId,
        startBar,
        lengthBars,
        offsetSeconds,
        ...(gainDb !== 0 ? { gainDb } : {}),
        ...(fadeInSeconds > 0 ? { fadeInSeconds } : {}),
        ...(fadeOutSeconds > 0 ? { fadeOutSeconds } : {}),
        ...(reverse ? { reverse: true } : {}),
        ...(stretchRatio !== 1 ? { stretchRatio } : {}),
        ...(semitones !== 0 ? { semitones } : {}),
        ...(takeGroup !== null
          ? {
              takeGroup,
              ...(takeIndex !== null ? { takeIndex } : {}),
              // takeActive 变量语义：true = 输入明确 false → 需要写 takeActive:false。
              ...(takeActive === true ? { takeActive: false } : {}),
            }
          : {}),
      }
    }
    // R2a：pattern 片段忽略音频字段（offset/gain/fade/reverse），与旧行为一致。
    const patternId = requireString(clip.patternId, `${where}.patternId`, { max: 64 })
    if (!patternIds.has(patternId)) fail(`${where}.patternId=${patternId} 不存在；可用 pattern：${[...patternIds].join(', ') || '无'}`)
    const transpose = optionalNumber(clip.transpose, `${where}.transpose`, { min: -48, max: 48, integer: true }) ?? 0
    if (startBar + lengthBars > LIMITS.maxBars) {
      fail(`${where} 结束于第 ${startBar + lengthBars} 小节，超过最大曲长 ${LIMITS.maxBars}`)
    }
    const id = typeof clip.id === 'string' && /^clip_[0-9]+$/.test(clip.id) ? clip.id : null
    return { id, trackId, patternId, startBar, lengthBars, transpose }
  })
}

/** 校验 section 描述数组（可选保留已有 id）。 */
function validateSections(sections) {
  if (!Array.isArray(sections)) fail('sections 必须是数组')
  if (sections.length > LIMITS.maxSections) fail(`段落数量 ${sections.length} 超过上限 ${LIMITS.maxSections}`)
  return sections.map((section, index) => {
    const where = `sections[${index}]`
    if (!isObject(section)) fail(`${where} 必须是对象`)
    const name = requireString(section.name, `${where}.name`, { max: MAX_SECTION_NAME })
    const startBar = requireNumber(section.startBar ?? 0, `${where}.startBar`, { min: 0, max: LIMITS.maxBars, integer: true })
    const lengthBars = requireNumber(section.lengthBars ?? 1, `${where}.lengthBars`, { min: 1, max: LIMITS.maxBars, integer: true })
    const color = section.color === undefined || section.color === null ? undefined : requireColor(section.color, `${where}.color`)
    const id = typeof section.id === 'string' && /^sec_[0-9]+$/.test(section.id) ? section.id : null
    return { id, name, startBar, lengthBars, color }
  })
}

/** 用校验后的 clip 数组整体替换编排（尽量保留调用方提供的 id）。 */
function replaceClips(project, clips) {
  const nextId = makeIdGen(project)
  const used = new Set()
  project.clips = clips.map((clip) => {
    let id = clip.id && !used.has(clip.id) ? clip.id : nextId('clip')
    while (used.has(id)) id = nextId('clip')
    used.add(id)
    return makeClip({
      id,
      trackId: clip.trackId,
      patternId: clip.patternId,
      mediaId: clip.mediaId,
      startBar: clip.startBar,
      lengthBars: clip.lengthBars,
      transpose: clip.transpose,
      offsetSeconds: clip.offsetSeconds,
      gainDb: clip.gainDb,
      fadeInSeconds: clip.fadeInSeconds,
      fadeOutSeconds: clip.fadeOutSeconds,
      reverse: clip.reverse,
      stretchRatio: clip.stretchRatio,
      semitones: clip.semitones,
      takeGroup: clip.takeGroup,
      takeIndex: clip.takeIndex,
      takeActive: clip.takeActive,
    })
  })
}

/** 用校验后的 section 数组整体替换段落（尽量保留调用方提供的 id）。 */
function replaceSections(project, sections) {
  const nextId = makeIdGen(project)
  const used = new Set()
  project.sections = sections.map((section) => {
    let id = section.id && !used.has(section.id) ? section.id : nextId('sec')
    while (used.has(id)) id = nextId('sec')
    used.add(id)
    return makeSection({
      id,
      name: section.name,
      startBar: section.startBar,
      lengthBars: section.lengthBars,
      color: section.color,
    })
  })
}

/* ------------------------------------------------------------------------- */
/* 摘要投影（给模型看的紧凑 JSON）                                             */
/* ------------------------------------------------------------------------- */

/**
 * 轨道摘要：不含 17 个乐器参数，只给 preset/kit 与 fx 摘要。
 * task-75：automation/sustain 默认只给摘要；options.includeAutomation/includeSustain=true 才带完整点。
 */
export function trackSummary(track, options = {}) {
  const instrument = track.instrument ?? {}
  const isAudio = track.kind === 'audio'
  return {
    id: track.id,
    name: track.name,
    role: track.role,
    kind: track.kind,
    color: track.color,
    instrument: isAudio
      ? { preset: null, kit: null }
      : (track.kind === 'drum' ? { kit: instrument.kit } : { preset: instrument.preset }),
    volume: round(track.volume, 3),
    pan: round(track.pan, 3),
    mute: Boolean(track.mute),
    solo: Boolean(track.solo),
    sends: { reverb: round(track.sends?.reverb ?? 0, 3), delay: round(track.sends?.delay ?? 0, 3) },
    effects: (track.effects ?? []).map((fx) => (fx.type === 'vst3'
      ? effectSummary(fx)
      : { id: fx.id, type: fx.type, enabled: fx.enabled !== false })),
    automation: automationSummary(track.automation, { includePoints: options?.includeAutomation === true }),
    sidechain: sidechainSummary(track.sidechain),
    // P14b：参考曲音频轨标记（默认 false）
    reference: track.reference === true,
    // R4a：输出路由（master 默认省略）。
    output: track.output ?? 'master',
    // R4b：发送点/相位/mono/FX 旁路/手动 PDC（默认值也回显，便于 UI 控件）。
    sendMode: track.sendMode ?? 'post',
    // R4d：自动化模式（read 默认）。
    automationMode: track.automationMode ?? 'read',
    // R5b：乐器参数（仅 synth 有该字段；默认返回 {}，其它轨省略以保持 overview 紧凑）。
    ...(track.kind === 'synth' ? { instrumentParams: normalizeInstrumentParams(track.instrumentParams) } : {}),
    // v2.2：外部插件轨摘要（不含 stateBase64）。
    ...(track.engine === 'vst3'
      ? {
          engine: 'vst3',
          vst3: {
            pluginId: track.vst3?.pluginId ?? '',
            name: track.vst3?.name ?? '',
            vendor: track.vst3?.vendor ?? '',
            version: track.vst3?.version ?? '',
            category: track.vst3?.category ?? '',
            subCategories: track.vst3?.subCategories ?? '',
            classId: track.vst3?.classId ?? '',
            kind: 'instrument',
            isInstrument: true,
            midiInputs: track.vst3?.midiInputs ?? 0,
            ...(track.vst3?.preset ? { preset: track.vst3.preset } : {}),
            bypass: track.vst3?.bypass === true,
            missing: track.vst3?.missing === true,
          },
          ...(track.freeze ? { freeze: freezeSummary(track.freeze) } : {}),
        }
      : {}),
    // v2.3 P2：插件参数自动化摘要（P0 仅暴露结构，工具在 P2 接）。
    ...(track.pluginAutomation && Object.keys(track.pluginAutomation).length > 0
      ? { pluginAutomation: track.pluginAutomation }
      : {}),
    // R5d：合成器引擎/音色（默认 sampler 省略，保持 overview 紧凑）。
    ...(track.engine === 'subtractive' || track.synthPreset
      ? {
          engine: track.engine === 'subtractive' ? 'subtractive' : 'sampler',
          ...(track.synthPreset ? { synthPreset: track.synthPreset } : {}),
          ...(track.synthPreset ? { synthParams: normalizeSynthParams(track.synthParams, { preset: track.synthPreset }) } : {}),
        }
      : {}),
    phaseInvert: track.phaseInvert === true,
    mono: track.mono === true,
    bypassFx: track.bypassFx === true,
    pdcMs: normalizePdcMs(track.pdcMs),
    // P11：延音踏板 / 揉弦摘要（无配置为 null；默认摘要，includeSustain=true 才带 points）
    sustain: sustainSummary(track.sustain, { includePoints: options?.includeSustain === true }),
    vibrato: vibratoSummary(track.vibrato),
  }
}

/** 效果器摘要（带参数，用于 add/update 的确认返回）。 */
/** v2.2 M4：冻结摘要（不含绝对 cachePath）。 */
export function freezeSummary(freeze) {
  if (!freeze) return null
  return {
    status: freeze.stale === true ? 'stale' : (freeze.status ?? 'current'),
    hash: freeze.hash ?? null,
    mediaId: freeze.mediaId ?? null,
    cacheFile: freeze.cacheFile ?? null,
    bars: freeze.bars ?? null,
    frames: freeze.frames ?? null,
    sampleRate: freeze.sampleRate ?? null,
    includesFx: freeze.includesFx === true,
    latencySamples: freeze.latencySamples ?? 0,
    createdAt: freeze.createdAt ?? 0,
    stale: freeze.stale === true,
    ...(freeze.error ? { error: freeze.error } : {}),
  }
}

/**
 * v2.3 P0：把插件参数写回 track.vst3.params / effect.vst3.params。
 * - 必须指定 trackId 或 effectId；effectId 可在全工程定位；
 * - pluginId 可选，仅作一致性校验；value 归一化 0..1（夹紧）。
 */
export function setPluginParameter(project, args = {}) {
  const trackIdArg = typeof args.trackId === 'string' && args.trackId.trim() !== '' ? args.trackId.trim() : null
  const effectIdArg = typeof args.effectId === 'string' && args.effectId.trim() !== '' ? args.effectId.trim() : null
  if (trackIdArg === null && effectIdArg === null) fail('setPluginParameter 需要 trackId 或 effectId')
  let track = null
  if (trackIdArg !== null) track = getTrack(project, trackIdArg)
  if (effectIdArg !== null) {
    const candidates = track ? [track] : (project.tracks ?? [])
    for (const candidate of candidates) {
      const found = (candidate.effects ?? []).find((fx) => fx.id === effectIdArg && fx.type === 'vst3')
      if (found) {
        track = candidate
        break
      }
    }
    if (!track) fail(`找不到 VST3 效果器 effectId=${effectIdArg}`)
  }
  const effect = effectIdArg === null ? null : (track.effects ?? []).find((fx) => fx.id === effectIdArg && fx.type === 'vst3')
  if (effect === null && track.engine !== 'vst3') fail(`轨道 ${track.id} 不是 VST3 乐器轨；无法写插件参数`)
  const target = effect ?? track
  const descriptor = effect ? effect.vst3 : track.vst3
  if (!descriptor || typeof descriptor.pluginId !== 'string') fail(`轨道 ${track.id} 缺少 VST3 插件引用`)
  const pluginId = typeof args.pluginId === 'string' && args.pluginId.trim() !== '' ? args.pluginId.trim() : descriptor.pluginId
  if (pluginId !== descriptor.pluginId) {
    fail(`pluginId 不匹配：目标插件为 ${descriptor.pluginId}，收到 ${pluginId}`)
  }
  const rawParamId = Number(args.paramId)
  if (!Number.isInteger(rawParamId) || rawParamId < 0) fail('paramId 必须是非负整数')
  const rawValue = Number(args.value)
  if (!Number.isFinite(rawValue)) fail('value 必须是 0..1 之间的数字')
  const value = Math.round(Math.max(0, Math.min(1, rawValue)) * 1e6) / 1e6
  if (!descriptor.params || typeof descriptor.params !== 'object' || Array.isArray(descriptor.params)) descriptor.params = {}
  descriptor.params[String(rawParamId)] = value
  const instanceKey = effect ? `effect:${effect.id}` : 'track'
  return {
    trackId: track.id,
    effectId: effect?.id ?? null,
    pluginId: descriptor.pluginId,
    paramId: rawParamId,
    value,
    instanceKey,
    params: { ...descriptor.params },
  }
}

/** v2.3 P1：解析 trackId/effectId 对应的 VST3 目标（不修改工程）。 */
export function resolvePluginTarget(project, { trackId = null, effectId = null } = {}) {
  const trackIdArg = typeof trackId === 'string' && trackId.trim() !== '' ? trackId.trim() : null
  const effectIdArg = typeof effectId === 'string' && effectId.trim() !== '' ? effectId.trim() : null
  if (trackIdArg === null && effectIdArg === null) fail('需要 trackId 或 effectId')
  let track = null
  if (trackIdArg !== null) track = getTrack(project, trackIdArg)
  if (effectIdArg !== null) {
    const candidates = track ? [track] : (project.tracks ?? [])
    for (const candidate of candidates) {
      const found = (candidate.effects ?? []).find((fx) => fx.id === effectIdArg && fx.type === 'vst3')
      if (found) { track = candidate; break }
    }
    if (!track) fail(`找不到 VST3 效果器 effectId=${effectIdArg}`)
  }
  const effect = effectIdArg === null ? null : (track.effects ?? []).find((fx) => fx.id === effectIdArg && fx.type === 'vst3')
  if (effect === null && track.engine !== 'vst3') fail(`轨道 ${track.id} 不是 VST3 乐器轨；无法操作插件`)
  const descriptor = effect ? effect.vst3 : track.vst3
  if (!descriptor || typeof descriptor.pluginId !== 'string') fail(`轨道 ${track.id} 缺少 VST3 插件引用`)
  return {
    track,
    effect,
    descriptor,
    trackId: track.id,
    effectId: effect?.id ?? null,
    pluginId: descriptor.pluginId,
    instanceKey: effect ? `effect:${effect.id}` : 'track',
    instanceId: effect ? `fx:${effect.id}` : `track:${track.id}`,
  }
}

/** v2.3 P1：把 preset/params/state 写回目标 vst3 描述。 */
export function applyPluginPreset(project, { trackId = null, effectId = null, preset = null, params = null, stateBase64 = null } = {}) {
  const target = resolvePluginTarget(project, { trackId, effectId })
  const descriptor = target.descriptor
  if (preset && typeof preset === 'object') {
    descriptor.preset = {
      listId: Number.isFinite(Number(preset.listId)) ? Math.max(0, Math.round(Number(preset.listId))) : null,
      index: Number.isFinite(Number(preset.index)) ? Math.max(0, Math.round(Number(preset.index))) : null,
      name: typeof preset.name === 'string' ? preset.name.slice(0, 160) : '',
    }
  }
  if (Array.isArray(params)) {
    const next = {}
    for (const item of params.slice(0, 2048)) {
      const id = Number(item?.id ?? item?.index)
      const value = Number(item?.value)
      if (!Number.isFinite(id) || !Number.isFinite(value)) continue
      next[String(id)] = Math.round(Math.max(0, Math.min(1, value)) * 1e6) / 1e6
    }
    descriptor.params = next
  }
  if (typeof stateBase64 === 'string' && stateBase64 !== '') {
    if (Buffer.byteLength(stateBase64, 'utf8') > MAX_PLUGIN_STATE_BYTES) fail('stateBase64 超过 2MB 上限')
    descriptor.stateBase64 = stateBase64
  }
  return { ...target, preset: descriptor.preset ?? null, params: descriptor.params ?? {}, hasStateBase64: typeof descriptor.stateBase64 === 'string' }
}

export function getPluginState(project, { trackId = null, effectId = null } = {}) {
  const target = resolvePluginTarget(project, { trackId, effectId })
  const stateBase64 = typeof target.descriptor.stateBase64 === 'string' ? target.descriptor.stateBase64 : null
  return {
    trackId: target.trackId,
    effectId: target.effectId,
    pluginId: target.pluginId,
    instanceKey: target.instanceKey,
    preset: target.descriptor.preset ?? null,
    stateBase64,
    bytes: stateBase64 ? Buffer.byteLength(stateBase64, 'utf8') : 0,
    hasStateBase64: stateBase64 !== null,
  }
}

export function setPluginState(project, { trackId = null, effectId = null, stateBase64 = '' } = {}) {
  const target = resolvePluginTarget(project, { trackId, effectId })
  const state = typeof stateBase64 === 'string' ? stateBase64.trim() : ''
  if (state === '') fail('stateBase64 不能为空')
  if (Buffer.byteLength(state, 'utf8') > MAX_PLUGIN_STATE_BYTES) fail('stateBase64 超过 2MB 上限')
  target.descriptor.stateBase64 = state
  return { ...target, bytes: Buffer.byteLength(state, 'utf8') }
}

/** v2.3 P2：读取插件参数自动化（track.pluginAutomation）。 */
export function getPluginAutomation(project, { trackId = null, effectId = null, paramId = null } = {}) {
  const target = resolvePluginTarget(project, { trackId, effectId })
  const all = target.track.pluginAutomation ?? {}
  const curves = all[target.instanceKey] ?? {}
  const wanted = paramId === null || paramId === undefined || String(paramId).trim() === '' ? null : String(paramId).trim()
  const selected = wanted === null ? curves : (curves[wanted] ? { [wanted]: curves[wanted] } : {})
  return {
    trackId: target.trackId,
    effectId: target.effectId,
    pluginId: target.pluginId,
    instanceKey: target.instanceKey,
    curves: selected,
    count: Object.keys(selected).length,
  }
}

function normalizeAutomationPoints(points, maxBeat) {
  const out = []
  const seen = new Set()
  for (const point of Array.isArray(points) ? points : []) {
    if (out.length >= 256) break
    if (point === null || typeof point !== 'object') continue
    const beat = Number(point.beat)
    const value = Number(point.value)
    if (!Number.isFinite(beat) || !Number.isFinite(value)) continue
    const clampedBeat = Math.round(Math.max(0, Math.min(maxBeat, beat)) * 1e6) / 1e6
    if (seen.has(clampedBeat)) continue
    seen.add(clampedBeat)
    out.push({ beat: clampedBeat, value: Math.round(Math.max(0, Math.min(1, value)) * 1e6) / 1e6 })
  }
  return out.sort((a, b) => a.beat - b.beat)
}

/** v2.3 P2：写入/覆盖一条插件参数自动化曲线（每轨 ≤16 条、每条 ≤256 点）。 */
export function setPluginAutomation(project, { trackId = null, effectId = null, paramId, points = [], enabled = true } = {}) {
  const target = resolvePluginTarget(project, { trackId, effectId })
  const rawParamId = Number(paramId)
  if (!Number.isInteger(rawParamId) || rawParamId < 0) fail('paramId 必须是非负整数')
  const maxBeat = Math.max(1, (Number(project.lengthBars) || 1) * beatsPerBar(project))
  const curve = { enabled: enabled !== false, points: normalizeAutomationPoints(points, maxBeat) }
  const all = target.track.pluginAutomation && typeof target.track.pluginAutomation === 'object' ? target.track.pluginAutomation : {}
  const instance = all[target.instanceKey] && typeof all[target.instanceKey] === 'object' ? all[target.instanceKey] : {}
  const key = String(rawParamId)
  if (!instance[key] && Object.keys(instance).length >= 16) fail('每轨最多 16 条插件参数自动化曲线')
  instance[key] = curve
  all[target.instanceKey] = instance
  target.track.pluginAutomation = all
  return {
    trackId: target.trackId,
    effectId: target.effectId,
    pluginId: target.pluginId,
    instanceKey: target.instanceKey,
    paramId: rawParamId,
    curve,
    pointCount: curve.points.length,
    count: Object.keys(instance).length,
  }
}

/** v2.3 P2：清除一条曲线（paramId）或整个 instance（省略 paramId）。 */
export function clearPluginAutomation(project, { trackId = null, effectId = null, paramId = null } = {}) {
  const target = resolvePluginTarget(project, { trackId, effectId })
  const all = target.track.pluginAutomation && typeof target.track.pluginAutomation === 'object' ? target.track.pluginAutomation : null
  if (!all || !all[target.instanceKey]) return { trackId: target.trackId, effectId: target.effectId, instanceKey: target.instanceKey, removed: 0, cleared: false }
  const instance = all[target.instanceKey]
  if (paramId === null || paramId === undefined || String(paramId).trim() === '') {
    const removed = Object.keys(instance).length
    delete all[target.instanceKey]
    if (Object.keys(all).length === 0) delete target.track.pluginAutomation
    else target.track.pluginAutomation = all
    return { trackId: target.trackId, effectId: target.effectId, instanceKey: target.instanceKey, removed, cleared: removed > 0 }
  }
  const key = String(paramId).trim()
  const removed = instance[key] ? 1 : 0
  if (removed) delete instance[key]
  if (Object.keys(instance).length === 0) delete all[target.instanceKey]
  if (Object.keys(all).length === 0) delete target.track.pluginAutomation
  else target.track.pluginAutomation = all
  return { trackId: target.trackId, effectId: target.effectId, instanceKey: target.instanceKey, paramId: Number(paramId), removed, cleared: removed > 0 }
}

export function effectSummary(fx) {
  if (fx.type === 'vst3') {
    const vst3 = fx.vst3 ?? {}
    return {
      id: fx.id,
      type: 'vst3',
      enabled: fx.enabled !== false,
      vst3: {
        pluginId: vst3.pluginId ?? '',
        name: vst3.name ?? '',
        vendor: vst3.vendor ?? '',
        version: vst3.version ?? '',
        category: vst3.category ?? '',
        subCategories: vst3.subCategories ?? '',
        classId: vst3.classId ?? '',
        kind: 'effect',
        isInstrument: false,
        midiInputs: 0,
        bypass: vst3.bypass === true,
        missing: vst3.missing === true,
      },
      ...(fx.freeze ? { freeze: freezeSummary(fx.freeze) } : {}),
    }
  }
  return { id: fx.id, type: fx.type, enabled: fx.enabled !== false, params: fx.params ?? {} }
}

/** master 摘要（automation 只可能有 volume；默认摘要，includeAutomation=true 才带完整点）。 */
export function masterSummary(master, options = {}) {
  return {
    volume: round(master.volume, 3),
    effects: (master.effects ?? []).map((fx) => ({ id: fx.id, type: fx.type, enabled: fx.enabled !== false })),
    automation: automationSummary(master.automation, { includePoints: options?.includeAutomation === true }),
  }
}

/** pattern 摘要（不带音符）。 */
export function patternSummary(pattern) {
  return { id: pattern.id, name: pattern.name, lengthBars: pattern.lengthBars, notes: pattern.notes.length }
}

/**
 * 项目概览：给 studio_get_project 用，保证 < 8KB（长项目会截断 clips/patterns）。
 * - includeNotes=true：patterns 带完整音符；
 * - includeAutomation/includeSustain=true：轨道 automation/sustain 带完整点（默认只给摘要）；
 * - lastExportExists(path) 返回 false 时，lastExport 标记 stale 且不返回失效 path。
 */
export function getProjectOverview(project, options = {}) {
  const includeNotes = options.includeNotes === true
  const includeAutomation = options.includeAutomation === true
  const includeSustain = options.includeSustain === true
  const lastExportExists = typeof options.lastExportExists === 'function' ? options.lastExportExists : null
  const stats = projectStats(project)
  const clips = project.clips.slice(0, OVERVIEW_MAX_CLIPS).map((clip) => {
    if (typeof clip.mediaId === 'string' && clip.mediaId !== '') {
      // P3b：音频片段（无 patternId / transpose）；P6：带媒体内裁切起点 offsetSeconds。
      return {
        id: clip.id,
        trackId: clip.trackId,
        mediaId: clip.mediaId,
        startBar: clip.startBar,
        lengthBars: clip.lengthBars,
        offsetSeconds: round(clip.offsetSeconds ?? 0, 3),
        ...(Number(clip.gainDb) ? { gainDb: round(clip.gainDb, 1) } : {}),
        ...(Number(clip.fadeInSeconds) > 0 ? { fadeInSeconds: round(clip.fadeInSeconds, 3) } : {}),
        ...(Number(clip.fadeOutSeconds) > 0 ? { fadeOutSeconds: round(clip.fadeOutSeconds, 3) } : {}),
        ...(clip.reverse === true ? { reverse: true } : {}),
        ...(Number(clip.stretchRatio) && Number(clip.stretchRatio) !== 1 ? { stretchRatio: round(clip.stretchRatio, 3) } : {}),
        ...(Number(clip.semitones) ? { semitones: round(clip.semitones, 1) } : {}),
        ...(normalizeTakeGroup(clip.takeGroup) !== null
          ? {
              takeGroup: normalizeTakeGroup(clip.takeGroup),
              ...(normalizeTakeIndex(clip.takeIndex) !== null ? { takeIndex: normalizeTakeIndex(clip.takeIndex) } : {}),
              ...(clip.takeActive === false ? { takeActive: false } : {}),
            }
          : {}),
      }
    }
    return {
      id: clip.id,
      trackId: clip.trackId,
      patternId: clip.patternId,
      startBar: clip.startBar,
      lengthBars: clip.lengthBars,
      ...(clip.transpose ? { transpose: clip.transpose } : {}),
    }
  })
  // includeNotes=true：AI 一次拿全工程音符；否则仍按数量截断以控制概览大小。
  const patternSource = includeNotes ? project.patterns : project.patterns.slice(0, OVERVIEW_MAX_PATTERNS)
  const patterns = patternSource.map((pattern) => {
    const summary = patternSummary(pattern)
    if (!includeNotes) return summary
    return {
      ...summary,
      notes: (pattern.notes ?? []).map((note) => ({
        pitch: note.pitch,
        start: round(note.start, 4),
        dur: round(note.dur, 4),
        vel: round(note.vel, 3),
      })),
    }
  })
  const media = (project.media ?? []).slice(0, OVERVIEW_MAX_MEDIA).map(mediaSummary)
  const audioClipCount = project.clips.filter((clip) => typeof clip.mediaId === 'string' && clip.mediaId !== '').length
  return {
    schemaVersion: Number(project.schemaVersion),
    format: {
      name: 'aims',
      version: Number(project.schemaVersion),
      ...(Number.isInteger(Number(project.format?.migratedFrom)) ? { migratedFrom: Number(project.format.migratedFrom) } : {}),
      ...(Number.isFinite(Number(project.format?.migratedAt)) ? { migratedAt: Number(project.format.migratedAt) } : {}),
      ...(Array.isArray(project.format?.migrationWarnings) && project.format.migrationWarnings.length > 0
        ? { migrationWarnings: project.format.migrationWarnings.filter((item) => typeof item === 'string' && item.trim() !== '') }
        : {}),
    },
    title: project.title,
    artist: project.artist,
    bpm: project.bpm,
    // P12b：全局速度曲线摘要（空数组 = 常量 bpm）
    tempoMap: (project.tempoMap ?? []).map((point) => ({ beat: round(point.beat, 3), bpm: round(point.bpm, 2) })),
    hasTempo: Array.isArray(project.tempoMap) && project.tempoMap.length > 0,
    key: project.key,
    scale: project.scale,
    timeSignature: project.timeSignature,
    swing: round(project.swing, 3),
    lengthBars: project.lengthBars,
    revision: project.revision,
    contentRevision: Number(project.contentRevision) || 1,
    sections: project.sections.map((s) => ({
      id: s.id,
      name: s.name,
      startBar: s.startBar,
      lengthBars: s.lengthBars,
      color: s.color,
    })),
    tracks: project.tracks.map((track) => trackSummary(track, { includeAutomation, includeSustain })),
    media,
    mediaTotal: (project.media ?? []).length,
    midiMappings: (project.midiMappings ?? []).map((mapping) => ({ ...mapping })),
    groups: (project.groups ?? []).map((group) => groupSummary(project, group)),
    groupsTotal: (project.groups ?? []).length,
    // R4c：场景摘要（不返回完整 state）。
    scenes: (project.scenes ?? []).map(sceneSummary),
    scenesTotal: (project.scenes ?? []).length,
    midiMappingsTotal: (project.midiMappings ?? []).length,
    ...((project.media ?? []).length > OVERVIEW_MAX_MEDIA ? { mediaTruncated: true } : {}),
    audioTracks: project.tracks.filter((track) => track.kind === 'audio').length,
    patterns,
    patternsTotal: project.patterns.length,
    clips,
    clipsTotal: project.clips.length,
    audioClips: audioClipCount,
    ...(project.clips.length > OVERVIEW_MAX_CLIPS ? { clipsTruncated: true } : {}),
    ...(project.patterns.length > OVERVIEW_MAX_PATTERNS ? { patternsTruncated: true } : {}),
    master: masterSummary(project.master, { includeAutomation }),
    buses: {
      reverb: busSummary(project.buses?.reverb, 0.35),
      delay: busSummary(project.buses?.delay, 0.22),
    },
    transport: {
      playing: Boolean(project.transport?.playing),
      playheadBar: round(project.transport?.playheadBar ?? 0, 3),
      loopStartBar: project.transport?.loopStartBar ?? 0,
      loopEndBar: project.transport?.loopEndBar ?? 0,
      cmd: project.transport?.cmd
        ? {
            seq: project.transport.cmd.seq,
            action: project.transport.cmd.action,
            positionBar: project.transport.cmd.positionBar,
          }
        : null,
    },
    activity: { text: project.activity?.text ?? '', at: project.activity?.at ?? 0 },
    exportRequest: project.exportRequest
      ? {
          seq: project.exportRequest.seq,
          at: project.exportRequest.at,
          jobId: project.exportRequest.jobId ?? null,
          status: project.exportRequest.status ?? 'pending',
          claimable: project.exportRequest.claimable === true,
          claimedBy: project.exportRequest.claimedBy ?? null,
          silent: project.exportRequest.silent !== false,
          download: project.exportRequest.download === true,
          ...(project.exportRequest.format ? { format: project.exportRequest.format } : {}),
          ...(project.exportRequest.outputDir ? { outputDir: project.exportRequest.outputDir } : {}),
        }
      : null,
    // P11：最近导出历史（最多 10 条）+ 本次是否带全量音符
    exportHistory: (project.exportHistory ?? []).map((entry) => ({
      name: entry.name,
      format: entry.format,
      seconds: round(entry.seconds ?? 0, 2),
      bytes: entry.bytes ?? 0,
      path: entry.path,
      at: entry.at,
    })),
    ...(includeNotes ? { notesIncluded: true } : {}),
    lastExport: (() => {
      if (!project.lastExport) return null
      const pathOk = lastExportExists ? lastExportExists(project.lastExport.path) === true : true
      if (!pathOk) {
        return {
          stale: true,
          path: null,
          bytes: project.lastExport.bytes,
          seconds: project.lastExport.seconds,
          at: project.lastExport.at,
        }
      }
      return {
        path: project.lastExport.path,
        bytes: project.lastExport.bytes,
        seconds: project.lastExport.seconds,
        at: project.lastExport.at,
        ...Object.fromEntries(['achievedLufs', 'peak', 'peakDb', 'truePeak', 'truePeakDb', 'gainDb', 'limited']
          .filter((key) => project.lastExport[key] !== undefined)
          .map((key) => [key, project.lastExport[key]])),
      }
    })(),
    stats,
  }
}

/** 单个 pattern 详情：含全部音符 + 引用它的轨道/片段 + 鼓件映射。 */
export function getPatternView(project, args = {}) {
  const pattern = getPattern(project, isObject(args) ? args.patternId : args)
  const clips = project.clips
    .filter((clip) => clip.patternId === pattern.id)
    .map((clip) => ({ id: clip.id, trackId: clip.trackId, startBar: clip.startBar, lengthBars: clip.lengthBars, transpose: clip.transpose }))
  const trackIds = [...new Set(clips.map((clip) => clip.trackId))]
  const tracks = trackIds
    .map((id) => project.tracks.find((track) => track.id === id))
    .filter(Boolean)
    .map(trackSummary)
  const notes = pattern.notes.map((note) => ({
    pitch: note.pitch,
    start: round(note.start, 4),
    dur: round(note.dur, 4),
    vel: round(note.vel, 3),
  }))
  // 鼓轨给出实际用到的鼓件名，模型写音符时不必记 GM 音高表。
  // 有 clip 引用时按轨道 kind 判断；尚无 clip（刚建 pattern）时按音高推断。
  const isDrumContext =
    tracks.some((track) => track.kind === 'drum') ||
    (tracks.length === 0 && notes.length > 0 && notes.every((note) => DRUM_PIECES.some((piece) => piece.pitch === note.pitch)))
  const drumPieces = []
  if (isDrumContext) {
    const seen = new Set()
    for (const note of notes) {
      if (seen.has(note.pitch)) continue
      seen.add(note.pitch)
      const piece = DRUM_PIECES.find((item) => item.pitch === note.pitch)
      if (piece) drumPieces.push({ pitch: piece.pitch, name: piece.name, label: piece.label })
    }
  }
  return {
    patternId: pattern.id,
    name: pattern.name,
    lengthBars: pattern.lengthBars,
    noteCount: notes.length,
    notes,
    tracks,
    clips,
    ...(drumPieces.length ? { drumPieces } : {}),
    revision: project.revision,
  }
}

/* ------------------------------------------------------------------------- */
/* 工程级操作                                                                 */
/* ------------------------------------------------------------------------- */

/** 把 source 的全部字段搬进 target（保持 target 引用不变，供 draft 使用）。 */
function replaceInPlace(target, source) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, source)
}

/**
 * P14a：把 MIDI 导入构建出的工程应用进当前 draft。
 * - replace=true：整体替换（保留 revision/updatedAt，由 state.mutate 统一 bump）；
 * - replace=false：追加轨道/pattern/clip，并重映射 id（避免冲突）、必要时扩展曲长。
 * @param {object} project state.mutate 的 draft
 * @param {object} importedProject buildProjectFromMidi 的 project（schema2）
 * @param {{replace?:boolean}} [options]
 * @returns {{replace:boolean, tracks:number, patterns:number, clips:number, notes:number}}
 */
export function applyMidiProject(project, importedProject, options = {}) {
  if (!isObject(importedProject)) fail('MIDI 工程数据非法')
  const replace = options.replace !== false
  if (replace) {
    const fresh = normalizeProject(structuredClone(importedProject))
    fresh.schemaVersion = SCHEMA_VERSION
    fresh.revision = project.revision
    fresh.updatedAt = project.updatedAt
    replaceInPlace(project, fresh)
    return {
      replace: true,
      tracks: project.tracks.length,
      patterns: project.patterns.length,
      clips: project.clips.length,
      notes: project.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0),
    }
  }
  const importedTracks = Array.isArray(importedProject.tracks) ? importedProject.tracks : []
  const importedPatterns = Array.isArray(importedProject.patterns) ? importedProject.patterns : []
  const importedClips = Array.isArray(importedProject.clips) ? importedProject.clips : []
  if (project.tracks.length + importedTracks.length > LIMITS.maxTracks) {
    fail(`追加后轨道数超过上限 ${LIMITS.maxTracks}`)
  }
  if (project.patterns.length + importedPatterns.length > LIMITS.maxPatterns) {
    fail(`追加后 pattern 数超过上限 ${LIMITS.maxPatterns}`)
  }
  if (project.clips.length + importedClips.length > LIMITS.maxClips) {
    fail(`追加后 clip 数超过上限 ${LIMITS.maxClips}`)
  }
  const nextId = makeIdGen(project)
  const trackMap = new Map()
  const patternMap = new Map()
  for (const track of importedTracks) {
    const id = nextId('trk')
    trackMap.set(track.id, id)
    project.tracks.push({ ...structuredClone(track), id })
  }
  for (const pattern of importedPatterns) {
    const id = nextId('pat')
    patternMap.set(pattern.id, id)
    project.patterns.push({ ...structuredClone(pattern), id })
  }
  for (const clip of importedClips) {
    const trackId = trackMap.get(clip.trackId)
    const patternId = patternMap.get(clip.patternId)
    if (!trackId || !patternId) continue
    project.clips.push({
      ...structuredClone(clip),
      id: nextId('clip'),
      trackId,
      patternId,
    })
  }
  const importedEnd = importedClips.reduce((max, clip) => Math.max(max, (Number(clip.startBar) || 0) + (Number(clip.lengthBars) || 0)), 0)
  project.lengthBars = Math.min(LIMITS.maxBars, Math.max(Number(project.lengthBars) || 32, importedEnd))
  return {
    replace: false,
    tracks: project.tracks.length,
    patterns: project.patterns.length,
    clips: project.clips.length,
    notes: project.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0),
  }
}

/**
 * studio_create_project：重置为空白项目（保留调用者传入的元信息）。
 * @returns 新项目概览
 */
export function createProject(project, args = {}) {
  if (!isObject(args)) args = {}
  const templateId = args.template === undefined || args.template === null ? null : requireString(args.template, 'template', { max: 32 })
  const title = optionalString(args.title, 'title', { max: MAX_TITLE })
  const bpm = optionalNumber(args.bpm, 'bpm', { min: LIMITS.minBpm, max: LIMITS.maxBpm })
  const key = args.key === undefined || args.key === null ? undefined : requireKey(args.key)
  const scale = args.scale === undefined || args.scale === null ? undefined : requireString(args.scale, 'scale', { max: 32 })
  if (scale !== undefined && !findScale(scale)) {
    fail(`未知调式 ${scale}；可选：${SCALES.map((item) => item.id).join(' / ')}`)
  }
  const lengthBars = optionalNumber(args.lengthBars, 'lengthBars', { min: 1, max: LIMITS.maxBars, integer: true })
  let fresh
  if (templateId !== null) {
    // R5c：按模板创建（unknown id 中文错误）；显式参数覆盖模板默认。
    try {
      fresh = createProjectFromTemplate(templateId)
    } catch (error) {
      fail(error?.message ?? String(error))
    }
    if (title !== undefined) fresh.title = title
    if (bpm !== undefined) fresh.bpm = bpm
    if (key !== undefined) fresh.key = key
    if (scale !== undefined) fresh.scale = scale
    if (lengthBars !== undefined) fresh.lengthBars = lengthBars
    fresh = normalizeProject(fresh)
  } else {
    fresh = createEmptyProject({
      title: title ?? '未命名作品',
      bpm: bpm ?? 128,
      key: key ?? 'F#',
      scale: scale ?? 'minor',
      lengthBars: lengthBars ?? 32,
    })
  }
  // 保留 revision 由 state.mutate 统一 bump；这里只重置内容。
  fresh.revision = project.revision
  fresh.updatedAt = project.updatedAt
  replaceInPlace(project, fresh)
  return getProjectOverview(project)
}

/* ------------------------------------------------------------------------- */
/* R6b：一键生成可用 beat（4 轨 + 4 pattern + 4 clip + section）               */
/* ------------------------------------------------------------------------- */

/** R6e：空工程生成 beat 的安全母带（compressor + makeup gain；不动已有工程）。 */
function applyGeneratedMasterSafety(project) {
  // R6e 实测参数（audio-engine 真实 render 10 seed 校准）：peak -1.76~-1.23dB、LUFS -14.10~-13.59。
  project.master.volume = 0.77
  const effects = Array.isArray(project.master.effects) ? project.master.effects : []
  if (!effects.some((effect) => effect?.type === 'compressor')) {
    const effect = makeEffect(makeIdGen(project)('fx'), 'compressor', { threshold: -13, ratio: 3.5, attack: 0.007, release: 0.2 })
    project.master.effects = [...effects, effect]
  }
}

const BEAT_STYLE_DEFAULTS = Object.freeze({
  house: { bpm: 126, key: 'A', scale: 'minor' },
  techno: { bpm: 132, key: 'A', scale: 'minor' },
  lofi: { bpm: 86, key: 'D', scale: 'minor' },
  pop: { bpm: 100, key: 'C', scale: 'major' },
  cinematic: { bpm: 80, key: 'D', scale: 'minor' },
})

const BEAT_PARTS = Object.freeze([
  // volume 为安全增益分级：4 轨叠加时预留 headroom（R6e 实测默认 0.78 会削波）。
  { kind: 'drums', name: '鼓组', role: 'drums', kindTrack: 'drum', kit: 'smp_electro', volume: 0.58 },
  { kind: 'bass', name: '贝斯', role: 'bass', kindTrack: 'synth', engine: 'subtractive', synthPreset: 'sub_bass', volume: 0.45 },
  { kind: 'chords', name: '和弦', role: 'pad', kindTrack: 'synth', engine: 'subtractive', synthPreset: 'warm_pad', volume: 0.4 },
  { kind: 'lead', name: '主音', role: 'lead', kindTrack: 'synth', engine: 'subtractive', synthPreset: 'saw_lead', volume: 0.4 },
])

/**
 * studio_generate_beat：空工程/追加一次创建 4 轨 + 4 pattern + 4 clip + section。
 * 一次 mutate/撤销；空工程从 0 小节开始，非空从当前曲长末追加。
 */
export function generateBeatOp(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const style = args.style === undefined || args.style === null ? 'house' : String(args.style).trim()
  if (!GENERATOR_STYLES.includes(style)) fail(`style 必须是 ${GENERATOR_STYLES.join(' / ')}，收到「${style}」`)
  const bars = args.bars === undefined || args.bars === null ? 8 : Number(args.bars)
  if (!Number.isInteger(bars) || bars < 4 || bars > 16) fail('bars 必须是 4..16 的整数')
  const seed = args.seed === undefined || args.seed === null ? 1 : Number(args.seed)
  if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) fail('seed 必须是 0..2147483647 的整数')
  const defaults = BEAT_STYLE_DEFAULTS[style]
  const bpm = args.bpm === undefined || args.bpm === null ? defaults.bpm : Number(args.bpm)
  if (!Number.isFinite(bpm) || bpm < 60 || bpm > 180) fail('bpm 必须是 60..180 的数字')
  const key = args.key === undefined || args.key === null ? defaults.key : String(args.key).trim()
  if (noteNameToPitchClass(key) === null) fail(`未知调性 key=${key}`)
  const scale = args.scale === undefined || args.scale === null ? defaults.scale : String(args.scale).trim()
  if (!THEORY_SCALES[scale]) fail(`未知调式 scale=${scale}；可选：${Object.keys(THEORY_SCALES).join(' / ')}`)
  const rawSectionName = args.sectionName === undefined || args.sectionName === null ? 'AI Beat' : String(args.sectionName).trim()
  if (rawSectionName === '') fail('sectionName 不能为空')
  if (rawSectionName.length > 40) fail('sectionName 不能超过 40 字符')
  const sectionName = rawSectionName
  const wasEmpty = project.tracks.length === 0
  const startBar = wasEmpty ? 0 : project.lengthBars
  if (wasEmpty) applyGeneratedMasterSafety(project)
  if (startBar + bars > LIMITS.maxBars) fail(`追加后超出曲长上限（${startBar} + ${bars} > ${LIMITS.maxBars}）`)
  if (project.tracks.length + BEAT_PARTS.length > LIMITS.maxTracks) fail(`轨道数量不足（上限 ${LIMITS.maxTracks}，需新增 4 轨）`)
  const explicit = {
    bpm: args.bpm !== undefined && args.bpm !== null,
    key: args.key !== undefined && args.key !== null,
    scale: args.scale !== undefined && args.scale !== null,
  }
  // 空工程总是套用 style 默认；追加时仅在显式参数时覆盖，避免破坏已有工程调性。
  if (wasEmpty || explicit.bpm) project.bpm = Math.round(bpm)
  if (wasEmpty || explicit.key) project.key = key
  if (wasEmpty || explicit.scale) project.scale = scale
  const idGen = makeIdGen(project)
  const trackIds = []
  const patternIds = []
  const notesByTrack = {}
  let totalNotes = 0
  for (const [index, part] of BEAT_PARTS.entries()) {
    const trackArgs = {
      name: `${part.name} · ${style}`,
      kind: part.kindTrack,
      role: part.role,
      ...(part.kindTrack === 'drum' ? { kit: part.kit } : { engine: part.engine, synthPreset: part.synthPreset }),
    }
    const added = addTrack(project, trackArgs)
    const trackId = added.trackId
    trackIds.push(trackId)
    // R6e：按 role 安全增益分级，保证 4 轨叠加时峰值留 headroom（避免 render_preview 削波）。
    const createdTrack = project.tracks[project.tracks.length - 1]
    if (createdTrack && Number.isFinite(part.volume)) createdTrack.volume = part.volume
    const generated = generatePart({
      kind: part.kind,
      style,
      bars,
      key: project.key,
      scale: project.scale,
      seed: (Number(seed) >>> 0) * 4 + index + 1,
    })
    const pattern = makePattern({
      id: idGen('pat'),
      name: `${part.kind} · ${style}`,
      lengthBars: bars,
      notes: generated.notes,
    })
    project.patterns.push(pattern)
    patternIds.push(pattern.id)
    const clip = makeClip({
      id: idGen('clip'),
      trackId,
      patternId: pattern.id,
      startBar,
      lengthBars: bars,
    })
    project.clips.push(clip)
    notesByTrack[part.kind] = generated.notes.length
    totalNotes += generated.notes.length
  }
  project.lengthBars = wasEmpty ? bars : Math.max(project.lengthBars, startBar + bars)
  const section = makeSection({
    id: idGen('sec'),
    name: sectionName,
    startBar,
    lengthBars: bars,
  })
  project.sections.push(section)
  return {
    trackIds,
    patternIds,
    clipCount: BEAT_PARTS.length,
    section,
    summary: {
      style,
      bars,
      seed,
      totalNotes,
      notesByTrack,
      startBar,
      appended: !wasEmpty,
    },
    bpm: project.bpm,
    key: project.key,
    scale: project.scale,
  }
}

/* ------------------------------------------------------------------------- */
/* R6d：按参考 profile 生成 beat                                              */
/* ------------------------------------------------------------------------- */

const REFERENCE_PART_ROLES = Object.freeze([
  { kind: 'drums', role: 'drums', name: '鼓组', kindTrack: 'drum', volume: 0.58 },
  { kind: 'bass', role: 'bass', name: '贝斯', kindTrack: 'synth', volume: 0.45 },
  { kind: 'chords', role: 'pad', name: '和弦', kindTrack: 'synth', volume: 0.4 },
  { kind: 'lead', role: 'lead', name: '主音', kindTrack: 'synth', volume: 0.4 },
])

function pickReferenceTrack(profileTracks, predicate, fallback) {
  const list = Array.isArray(profileTracks) ? profileTracks : []
  return list.find(predicate) ?? fallback ?? null
}

function referencePresetArgs(profileTrack, fallback) {
  if (profileTrack) {
    if (profileTrack.engine === 'subtractive' && findSynthInstrument(profileTrack.synthPreset)) {
      return { engine: 'subtractive', synthPreset: profileTrack.synthPreset }
    }
    if (findSynthPreset(profileTrack.preset)) return { preset: profileTrack.preset }
  }
  return fallback
}

/**
 * studio_generate_like_reference：按参考 profile 的 BPM/key/scale/角色/音色/密度生成 4 轨。
 * @param {object} project
 * @param {object} args {bars,seed,append,sectionName}
 * @param {object} profile analyzeProjectProfile 结果
 */
export function generateLikeReferenceOp(project, args = {}, profile = null) {
  if (!isObject(args)) fail('参数必须是对象')
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    fail('缺少参考 profile；请先用 studio_analyze_reference 分析参考工程')
  }
  const bars = args.bars === undefined || args.bars === null ? 8 : Number(args.bars)
  if (!Number.isInteger(bars) || bars < 4 || bars > 16) fail('bars 必须是 4..16 的整数')
  const seed = args.seed === undefined || args.seed === null ? 1 : Number(args.seed)
  if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) fail('seed 必须是 0..2147483647 的整数')
  const sectionName = args.sectionName === undefined || args.sectionName === null ? '参考生成' : String(args.sectionName).trim()
  if (sectionName === '') fail('sectionName 不能为空')
  if (sectionName.length > 40) fail('sectionName 不能超过 40 字符')
  const profileBpm = Number(profile.bpm)
  const bpm = Number.isFinite(profileBpm) && profileBpm >= 60 && profileBpm <= 180 ? Math.round(profileBpm) : 120
  const key = typeof profile.key === 'string' && noteNameToPitchClass(profile.key) !== null ? profile.key : 'C'
  const scale = typeof profile.scale === 'string' && THEORY_SCALES[profile.scale] ? profile.scale : 'minor'
  const mapped = mapProfileToGeneratorOptions(profile)
  const style = GENERATOR_STYLES.includes(mapped.style) ? mapped.style : 'house'
  const density = clamp01(Number(mapped.density) || 0.7)
  const complexity = clamp01(Number(mapped.complexity) || 0.5)
  const wasEmpty = project.tracks.length === 0
  const append = args.append !== false
  if (wasEmpty) applyGeneratedMasterSafety(project)
  const startBar = wasEmpty ? 0 : (append ? project.lengthBars : 0)
  if (startBar + bars > LIMITS.maxBars) fail(`追加后超出曲长上限（${startBar} + ${bars} > ${LIMITS.maxBars}）`)
  if (project.tracks.length + REFERENCE_PART_ROLES.length > LIMITS.maxTracks) fail(`轨道数量不足（上限 ${LIMITS.maxTracks}，需新增 4 轨）`)
  // 参考 profile 的轨道信息（用于角色/音色/鼓件沿用）
  const refTracks = Array.isArray(profile.tracks) ? profile.tracks : []
  const drumRef = pickReferenceTrack(refTracks, (track) => track.role === 'drums' || track.kind === 'drum')
  const bassRef = pickReferenceTrack(refTracks, (track) => track.role === 'bass')
  const chordsRef = pickReferenceTrack(refTracks, (track) => track.role === 'pad' || track.role === 'keys')
  const leadRef = pickReferenceTrack(refTracks, (track) => track.role === 'lead' || track.role === 'arp') ?? bassRef
  const partRefs = [drumRef, bassRef, chordsRef, leadRef]
  const drumPitches = Array.isArray(profile.drumPitches) ? profile.drumPitches.filter((pitch) => Number.isInteger(Number(pitch))).map(Number) : []
  const drumPitchSet = new Set(drumPitches.filter((pitch) => pitch >= 0 && pitch <= 127))
  // 设置工程 BPM/调式（沿用参考；空工程 lengthBars=bars，追加扩展）
  project.bpm = bpm
  project.key = key
  project.scale = scale
  project.lengthBars = wasEmpty ? bars : Math.max(project.lengthBars, startBar + bars)
  const idGen = makeIdGen(project)
  const trackIds = []
  const patterns = []
  let totalNotes = 0
  for (const [index, part] of REFERENCE_PART_ROLES.entries()) {
    const ref = partRefs[index]
    let trackArgs = null
    if (part.kind === 'drums') {
      const kit = ref?.kind === 'drum' && DRUM_KITS.some((item) => item.id === ref.kit) ? ref.kit : 'smp_electro'
      trackArgs = { name: `${part.name} · 参考生成`, kind: 'drum', role: part.role, kit }
    } else {
      const presetArgs = referencePresetArgs(ref, part.kind === 'bass'
        ? { engine: 'subtractive', synthPreset: 'sub_bass' }
        : part.kind === 'chords'
          ? { engine: 'subtractive', synthPreset: 'warm_pad' }
          : { engine: 'subtractive', synthPreset: 'saw_lead' })
      trackArgs = { name: `${part.name} · 参考生成`, kind: 'synth', role: part.role, ...presetArgs }
    }
    const added = addTrack(project, trackArgs)
    trackIds.push(added.trackId)
    const createdTrack = project.tracks[project.tracks.length - 1]
    if (createdTrack && Number.isFinite(part.volume)) createdTrack.volume = part.volume
    const generated = generatePart({
      kind: part.kind,
      style,
      bars,
      key,
      scale,
      seed: (Number(seed) >>> 0) * 4 + index + 1,
      density,
      complexity,
    })
    let notes = generated.notes
    if (part.kind === 'drums' && drumPitchSet.size > 0) {
      const referenceNotes = notes.filter((note) => drumPitchSet.has(note.pitch))
      notes = referenceNotes.length > 0 ? referenceNotes : notes
    }
    const pattern = makePattern({
      id: idGen('pat'),
      name: `${part.kind} · 参考生成`,
      lengthBars: bars,
      notes,
    })
    project.patterns.push(pattern)
    patterns.push(pattern.id)
    project.clips.push(makeClip({
      id: idGen('clip'),
      trackId: added.trackId,
      patternId: pattern.id,
      startBar,
      lengthBars: bars,
    }))
    totalNotes += notes.length
  }
  const section = makeSection({
    id: idGen('sec'),
    name: sectionName,
    startBar,
    lengthBars: bars,
  })
  project.sections.push(section)
  return {
    profileSummary: profile.summary ?? '',
    trackIds,
    patterns,
    clipCount: REFERENCE_PART_ROLES.length,
    section,
    bpm: project.bpm,
    key: project.key,
    scale: project.scale,
    seed,
    totalNotes,
    style,
    startBar,
    appended: !wasEmpty,
  }
}

/* ------------------------------------------------------------------------- */
/* R6a：AI 生成器 + 混音 assistant                                            */
/* ------------------------------------------------------------------------- */

/**
 * studio_generate_part：按 kind/style/seed 确定性生成 pattern 音符（一次撤销）。
 * @returns {{patternId:string, trackId:string, summary:object, noteCount:number}}
 */
export function generatePartOp(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const kind = typeof args.kind === 'string' ? args.kind.trim() : ''
  if (!GENERATOR_KINDS.includes(kind)) fail(`kind 必须是 ${GENERATOR_KINDS.join(' / ')}，收到「${kind || '?'}」`)
  if (!GENERATOR_STYLES.includes(args.style ?? 'house')) {
    fail(`style 必须是 ${GENERATOR_STYLES.join(' / ')}，收到「${String(args.style)}」`)
  }
  if (kind === 'drums' && track.kind !== 'drum') fail('drums 生成需要鼓轨（track.kind="drum"）')
  if (kind !== 'drums' && track.kind !== 'synth') fail('旋律/和声生成需要乐器轨（track.kind="synth"）')
  const barBeats = args.barBeats === undefined || args.barBeats === null ? beatsPerBar(project) : args.barBeats
  const bars = args.bars === undefined || args.bars === null ? 4 : Number(args.bars)
  if (!Number.isInteger(bars) || bars < 1 || bars > 64) fail('bars 必须是 1..64 的整数')
  const idGen = makeIdGen(project)
  let pattern = null
  if (args.patternId !== undefined && args.patternId !== null && args.patternId !== '') {
    pattern = project.patterns.find((item) => item.id === args.patternId)
    if (!pattern) fail(`找不到 pattern patternId=${String(args.patternId)}`)
    if (bars > pattern.lengthBars) fail(`bars（${bars}）不能超过目标 pattern 长度（${pattern.lengthBars} 小节）`)
  }
  const generated = generatePart({
    kind,
    style: args.style ?? 'house',
    bars,
    barBeats,
    key: args.key ?? project.key,
    scale: args.scale ?? project.scale,
    seed: args.seed,
    density: args.density,
    complexity: args.complexity,
    octave: args.octave,
  })
  if (!pattern) {
    pattern = makePattern({
      id: idGen('pat'),
      name: `${kind} · ${generated.summary.style}`,
      lengthBars: bars,
      notes: generated.notes,
    })
    project.patterns.push(pattern)
  } else {
    const existing = args.replaceExisting === false && Array.isArray(pattern.notes) ? pattern.notes : []
    pattern.notes = [...existing, ...generated.notes]
      .map((note) => normalizeNote(note))
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    if (pattern.notes.length > 4096) pattern.notes = pattern.notes.slice(0, 4096)
  }
  return {
    patternId: pattern.id,
    trackId: track.id,
    summary: { ...generated.summary, patternId: pattern.id, replaced: args.replaceExisting !== false },
    noteCount: pattern.notes.length,
  }
}

/**
 * studio_generate_variation：对现有 pattern 生成确定性变体（一次撤销）。
 * @returns {{patternId:string, noteCount:number, summary:object}}
 */
export function generateVariationOp(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const pattern = project.patterns.find((item) => item.id === args.patternId)
  if (!pattern) fail(`找不到 pattern patternId=${String(args.patternId ?? '')}`)
  if (!Array.isArray(pattern.notes) || pattern.notes.length === 0) fail('目标 pattern 没有音符，无法生成变体')
  const notes = generateVariation({
    notes: pattern.notes,
    seed: args.seed,
    density: args.density,
    transpose: args.transpose,
    humanize: args.humanize,
  })
  let nextNotes = notes
  if (args.replaceExisting === false) {
    nextNotes = [...pattern.notes, ...notes]
      .map((note) => normalizeNote(note))
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
      .slice(0, 4096)
  }
  pattern.notes = nextNotes
  return {
    patternId: pattern.id,
    noteCount: pattern.notes.length,
    summary: {
      seed: args.seed === undefined || args.seed === null ? 1 : Number(args.seed),
      sourceNotes: pattern.notes.length === nextNotes.length && args.replaceExisting === false ? pattern.notes.length - notes.length : pattern.notes.length,
      generatedNotes: notes.length,
      replaced: args.replaceExisting !== false,
    },
  }
}

/** studio_suggest_mix：只读混音建议（不写工程）。 */
export function suggestMixOp(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  return buildMixSuggestions({ project, analysis: args.analysis ?? null, targetLufs: args.targetLufs })
}

/** studio_apply_mix：安全应用混音建议（一次撤销）。 */
export function applyMixOp(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const result = applyMixSuggestions(project, {
    analysis: args.analysis ?? null,
    targetLufs: args.targetLufs,
    codes: args.codes,
  })
  // v2.1：volume 自动化曲线随 apply_mix 的轨道音量变化按比例缩放（曲线值 0..1），并给出 warning。
  const warnings = []
  let automationAdjusted = false
  for (const change of result.changes ?? []) {
    if (change.target !== 'track' || change.param !== 'volume' || !change.trackId) continue
    const track = getTrack(project, change.trackId)
    const curve = track?.automation?.volume
    if (!curve || !Array.isArray(curve.points) || curve.points.length === 0) continue
    const from = Number(change.from)
    const to = Number(change.to)
    const ratio = from > 0.0001 ? to / from : 1
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 0.001) continue
    curve.points = curve.points.map((point) => ({
      beat: point.beat,
      value: Math.max(0, Math.min(1, Math.round(Number(point.value) * ratio * 10000) / 10000)),
    }))
    automationAdjusted = true
    warnings.push({
      code: 'mix.automation.volume',
      message: `轨道「${track.name ?? track.id}」存在 volume 自动化；已按 ${ratio.toFixed(3)}× 缩放曲线点（v2.1 起音量为 track.volume × 自动化）`,
      trackId: track.id,
    })
  }
  // v2.1：同时写 activity/lastMixWarnings，UI 不依赖 MCP tool result 也能看到 warning。
  if (warnings.length > 0) {
    project.lastMixWarnings = warnings.map((warning) => ({ ...warning, at: Date.now() }))
    project.activity = {
      text: `应用混音建议：${warnings.length} 项 volume 自动化曲线已按比例缩放`,
      at: Date.now(),
    }
  }
  return {
    ...result,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(automationAdjusted ? { automationAdjusted: true } : {}),
  }
}

/** studio_list_templates：模板元数据摘要（只读）。 */
export function listTemplates() {
  const templates = listProjectTemplates()
  return { templates, count: templates.length }
}

/** studio_list_plugins：插件清单（只读；type 可选 instrument/effect）。 */
export function listPluginsOp(options = {}) {
  const type = options?.type === undefined || options?.type === null || options?.type === '' ? null : String(options.type)
  const plugins = listPluginInventory({ ...(type ? { type } : {}) })
  return { sdkVersion: PLUGIN_SDK_VERSION, plugins, count: plugins.length }
}

/* ------------------------------------------------------------------------- */
/* 轨道                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * studio_add_track：新增轨道。
 * @returns { trackId, track }
 */
/** v2.2：工程内外部插件实例数（vst3 轨 + vst3 效果器）。 */
export function countExternalPluginInstances(project) {
  const trackCount = (project?.tracks ?? []).filter((track) => track?.engine === 'vst3').length
  const effectCount = (project?.tracks ?? []).reduce((sum, track) => sum + (track?.effects ?? []).filter((fx) => fx?.type === 'vst3').length, 0)
  return trackCount + effectCount
}

/** v2.2：插件被卸载后把工程引用标记 missing（保留引用）。 */
export function markPluginMissing(project, pluginId, missing = true) {
  const id = String(pluginId ?? '')
  let affected = 0
  for (const track of project.tracks ?? []) {
    if (track.engine === 'vst3' && track.vst3?.pluginId === id) {
      track.vst3.missing = missing === true
      affected += 1
    }
    for (const fx of track.effects ?? []) {
      if (fx?.type === 'vst3' && fx.vst3?.pluginId === id) {
        fx.vst3.missing = missing === true
        affected += 1
      }
    }
  }
  return affected
}

export function addTrack(project, args = {}) {
  if (!isObject(args)) args = {}
  if (project.tracks.length >= LIMITS.maxTracks) fail(`轨道数量已达上限 ${LIMITS.maxTracks}，无法继续添加`)
  const rawKind = args.kind ?? 'synth'
  if (rawKind !== 'synth' && rawKind !== 'drum') fail(`kind 必须是 'synth' 或 'drum'，收到 ${JSON.stringify(rawKind)}`)
  const kind = rawKind
  const name = optionalString(args.name, 'name', { max: MAX_NAME })
  let preset = null
  let kit = null
  // R5d：引擎（sampler 默认 / subtractive）；采样与合成器互斥。
  const rawEngine = args.engine === undefined || args.engine === null ? 'sampler' : requireString(args.engine, 'engine', { max: 16 })
  if (!TRACK_ENGINES.includes(rawEngine)) fail(`engine 必须是 ${TRACK_ENGINES.join(' / ')}，收到「${rawEngine}」`)
  if (rawEngine === 'subtractive' && kind !== 'synth') fail('subtractive 引擎仅支持采样乐器轨（kind=synth）')
  if (rawEngine === 'vst3' && kind !== 'synth') fail('VST3 引擎仅支持乐器轨（kind=synth）')
  if (rawEngine === 'vst3') {
    if (args.preset !== undefined && args.preset !== null) fail('VST3 轨不接受采样 preset；请用 vst3 描述')
    if (args.synthPreset !== undefined && args.synthPreset !== null) fail('VST3 轨不接受 synthPreset；请用 vst3 描述')
    if (countExternalPluginInstances(project) >= MAX_EXTERNAL_PLUGIN_INSTANCES) {
      fail(`外部插件实例已达上限 ${MAX_EXTERNAL_PLUGIN_INSTANCES}`)
    }
    if (!isObject(args.vst3) || normalizeExternalPlugin(args.vst3) === null) fail('VST3 轨需要有效的 vst3 描述（pluginId 必填）')
  }
  if (rawEngine === 'sampler' && args.synthPreset !== undefined && args.synthPreset !== null) {
    fail('sampler 引擎不接受 synthPreset；请用 preset，或设置 engine="subtractive"')
  }
  if (rawEngine === 'subtractive' && args.preset !== undefined && args.preset !== null) {
    fail('subtractive 引擎不接受采样 preset；请用 synthPreset')
  }
  let synthPreset = null
  if (rawEngine === 'subtractive') {
    synthPreset = args.synthPreset === undefined || args.synthPreset === null ? SYNTH_INSTRUMENTS[0].id : requireString(args.synthPreset, 'synthPreset', { max: 32 })
    if (!findSynthInstrument(synthPreset)) {
      fail(`未知合成器 synthPreset=${synthPreset}；可选：${SYNTH_INSTRUMENTS.map((item) => item.id).join(' / ')}`)
    }
  }
  if (kind === 'drum') {
    // P8：用户可见鼓组只有 4 套采样鼓机（默认原声采样鼓）。
    kit = optionalString(args.kit, 'kit') ?? DRUM_KITS[0].id
    if (!DRUM_KITS.some((item) => item.id === kit)) {
      fail(`未知采样鼓机 kit=${kit}；可选：${DRUM_KITS.map((item) => item.id).join(' / ')}`)
    }
  } else {
    // P8：用户可见乐器只有 18 个真实采样乐器（默认三角钢琴）。
    preset = optionalString(args.preset, 'preset') ?? SYNTH_PRESETS[0].id
    if (!SYNTH_PRESETS.some((item) => item.id === preset)) {
      fail(`未知采样乐器 preset=${preset}；可选：${SYNTH_PRESETS.map((item) => item.id).join(' / ')}`)
    }
  }
  let role = args.role === undefined || args.role === null ? (kind === 'drum' ? 'drums' : 'lead') : requireString(args.role, 'role', { max: 32 })
  if (args.role !== undefined && args.role !== null && !findRole(role)) {
    fail(`未知角色 role=${role}；可选：${TRACK_ROLES.map((item) => item.id).join(' / ')}`)
  }
  if (kind === 'drum') role = 'drums'
  const volume = args.volume === undefined || args.volume === null ? 0.78 : clamp01(strictFiniteNumber(args.volume, 'volume'))
  const pan = args.pan === undefined || args.pan === null ? 0 : clampPan(strictFiniteNumber(args.pan, 'pan'))
  const color = args.color === undefined || args.color === null
    ? TRACK_COLORS[project.tracks.length % TRACK_COLORS.length]
    : requireColor(args.color)
  const nextId = makeIdGen(project)
  const id = nextId('trk')
  const track = makeTrack({ id, name, kind, preset, kit, role, volume, pan, color })
  if (rawEngine === 'subtractive') {
    track.engine = 'subtractive'
    track.synthPreset = synthPreset
    // v2.1：subtractive 不使用采样器 preset（UI 按 engine/synthPreset 显示）。
    track.instrument = { ...(track.instrument ?? {}), preset: null, kit: null }
    const synthParams = normalizeSynthParams(args.synthParams, { preset: synthPreset })
    if (Object.keys(synthParams).length > 0) track.synthParams = synthParams
  }
  if (rawEngine === 'vst3') {
    track.engine = 'vst3'
    track.vst3 = normalizeExternalPlugin(args.vst3)
    delete track.synthPreset
    delete track.synthParams
    track.instrument = { ...(track.instrument ?? {}), preset: null, kit: null }
  }
  project.tracks.push(track)
  return { trackId: id, track: trackSummary(track) }
}

/**
 * 校验并合并 instrumentParams（仅 synth）：范围校验、未知键报错、取整/默认省略。
 * @returns {object} 合并后的 normalized params
 */
function mergeInstrumentParams(track, raw) {
  if (!isObject(raw)) fail('instrumentParams 必须是对象，如 { attack: 0.05, release: 0.5 }')
  const current = normalizeInstrumentParams(track.instrumentParams)
  const merged = { ...current }
  for (const [key, value] of Object.entries(raw)) {
    const spec = INSTRUMENT_PARAM_SPECS[key]
    if (!spec) {
      fail(`未知乐器参数「${key}」；可选：${Object.keys(INSTRUMENT_PARAM_SPECS).join(' / ')}`)
    }
    const numeric = strictFiniteNumber(value, `params.${key}`)
    if (numeric < spec.min || numeric > spec.max) {
      fail(`params.${key} 必须在 ${spec.min}..${spec.max} 之间，收到 ${numeric}`)
    }
    merged[key] = numeric
  }
  return normalizeInstrumentParams(merged)
}

/**
 * studio_update_instrument：合并更新 synth 轨 instrumentParams；reset:true 清除。
 * @returns {{trackId:string, instrumentParams:object, reset:boolean}}
 */
export function updateInstrument(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  if (track.kind !== 'synth') {
    fail('只有采样乐器轨（kind=synth）支持 instrumentParams；鼓轨/音频轨不支持')
  }
  if (args.reset === true) {
    delete track.instrumentParams
    return { trackId: track.id, instrumentParams: {}, reset: true }
  }
  const merged = mergeInstrumentParams(track, args.params)
  if (Object.keys(merged).length > 0) track.instrumentParams = merged
  else delete track.instrumentParams
  return { trackId: track.id, instrumentParams: merged, reset: false }
}

/** R5d：校验并合并 subtractive synthParams（范围夹紧；未知键/非法枚举中文错误）。 */
function mergeSynthParams(track, raw, presetId) {
  if (!isObject(raw)) fail('synth params 必须是对象，如 { wave: "saw", filterCutoff: 800 }')
  const merged = { ...normalizeSynthParams(track.synthParams, { preset: presetId }) }
  for (const [key, value] of Object.entries(raw)) {
    const spec = SYNTH_INSTRUMENT_PARAM_SPECS[key]
    if (!spec) fail(`未知合成器参数「${key}」；可选：${Object.keys(SYNTH_INSTRUMENT_PARAM_SPECS).join(' / ')}`)
    if (spec.type === 'enum') {
      if (!spec.options.includes(value)) fail(`params.${key} 必须是 ${spec.options.join(' / ')} 之一`)
      merged[key] = value
      continue
    }
    const numeric = strictFiniteNumber(value, `params.${key}`)
    merged[key] = numeric
  }
  return normalizeSynthParams(merged, { preset: presetId })
}

/**
 * studio_update_synth：切换合成器 preset / 合并 synthParams / reset（仅 subtractive 轨）。
 * @returns {{trackId:string, synthPreset:string, synthParams:object, reset:boolean}}
 */
export function updateSynth(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  if (track.kind !== 'synth') fail('只有采样乐器轨（kind=synth）可切换合成器引擎')
  if (track.engine !== 'subtractive') fail('该轨当前不是 subtractive 引擎；先 studio_update_track 设置 engine="subtractive"')
  let synthPreset = track.synthPreset
  if (args.synthPreset !== undefined && args.synthPreset !== null) {
    synthPreset = requireString(args.synthPreset, 'synthPreset', { max: 32 })
    if (!findSynthInstrument(synthPreset)) {
      fail(`未知合成器 synthPreset=${synthPreset}；可选：${SYNTH_INSTRUMENTS.map((item) => item.id).join(' / ')}`)
    }
    track.synthPreset = synthPreset
  }
  if (!synthPreset) synthPreset = SYNTH_INSTRUMENTS[0].id
  if (args.reset === true) {
    delete track.synthParams
    return { trackId: track.id, synthPreset: track.synthPreset, synthParams: {}, reset: true }
  }
  let merged
  if (args.params === undefined || args.params === null) {
    merged = normalizeSynthParams(track.synthParams, { preset: synthPreset })
    if (Object.keys(merged).length > 0) track.synthParams = merged
    else delete track.synthParams
  } else {
    merged = mergeSynthParams(track, args.params, synthPreset)
    if (Object.keys(merged).length > 0) track.synthParams = merged
    else delete track.synthParams
  }
  return { trackId: track.id, synthPreset: track.synthPreset, synthParams: merged, reset: false }
}

/**
 * studio_update_track：修改轨道字段（只处理传入字段）。
 * @returns { trackId, track }
 */
export function updateTrack(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const isAudioTrack = track.kind === 'audio'
  const name = optionalString(args.name, 'name', { max: MAX_NAME })
  // 音量/声像超出范围时钳制（与 UI 推子行为一致），非数字才报错。
  const volume = args.volume === undefined || args.volume === null ? undefined : clamp01(strictFiniteNumber(args.volume, 'volume'))
  const pan = args.pan === undefined || args.pan === null ? undefined : clampPan(strictFiniteNumber(args.pan, 'pan'))
  const mute = args.mute === undefined || args.mute === null ? undefined : coerceBool(args.mute, 'mute')
  const solo = args.solo === undefined || args.solo === null ? undefined : coerceBool(args.solo, 'solo')
  const sends = args.sends === undefined || args.sends === null ? undefined : args.sends
  if (sends !== undefined && !isObject(sends)) fail('sends 必须是对象，如 { reverb: 0.2, delay: 0.1 }')
  // R4b：发送点 / 相位 / mono / FX 旁路 / 手动 PDC。
  let sendMode
  if (args.sendMode !== undefined && args.sendMode !== null) {
    const rawMode = typeof args.sendMode === 'string' ? args.sendMode.trim() : ''
    if (!TRACK_SEND_MODES.includes(rawMode)) fail(`sendMode 必须是 ${TRACK_SEND_MODES.join(' / ')}，收到「${rawMode}」`)
    sendMode = rawMode
  }
  const phaseInvert = args.phaseInvert === undefined || args.phaseInvert === null ? undefined : coerceBool(args.phaseInvert, 'phaseInvert')
  const mono = args.mono === undefined || args.mono === null ? undefined : coerceBool(args.mono, 'mono')
  const bypassFx = args.bypassFx === undefined || args.bypassFx === null ? undefined : coerceBool(args.bypassFx, 'bypassFx')
  let pdcMs
  if (args.pdcMs !== undefined && args.pdcMs !== null) {
    pdcMs = normalizePdcMs(strictFiniteNumber(args.pdcMs, 'pdcMs'))
  }
  // R4d：自动化模式（read 默认；非法值回 read，不报错）。
  let automationMode
  if (args.automationMode !== undefined && args.automationMode !== null) {
    const mode = typeof args.automationMode === 'string' ? args.automationMode.trim() : ''
    automationMode = TRACK_AUTOMATION_MODES.includes(mode) ? mode : 'read'
  }
  // R5b：乐器参数（可选；仅 synth）。
  let instrumentParams
  if (args.instrumentParams !== undefined && args.instrumentParams !== null) {
    if (track.kind !== 'synth') fail('只有采样乐器轨（kind=synth）支持 instrumentParams；鼓轨/音频轨不支持')
    instrumentParams = mergeInstrumentParams(track, args.instrumentParams)
  }
  // R5d：engine / synthPreset / synthParams。
  let engine
  if (args.engine !== undefined && args.engine !== null) {
    const rawEngine = requireString(args.engine, 'engine', { max: 16 })
    if (!TRACK_ENGINES.includes(rawEngine)) fail(`engine 必须是 ${TRACK_ENGINES.join(' / ')}，收到「${rawEngine}」`)
    if (track.kind !== 'synth') fail('engine 仅支持采样乐器轨（kind=synth）')
    engine = rawEngine
  }
  let synthPreset
  if (args.synthPreset !== undefined && args.synthPreset !== null) {
    synthPreset = requireString(args.synthPreset, 'synthPreset', { max: 32 })
    if (!findSynthInstrument(synthPreset)) {
      fail(`未知合成器 synthPreset=${synthPreset}；可选：${SYNTH_INSTRUMENTS.map((item) => item.id).join(' / ')}`)
    }
  }
  let synthParams
  if (args.synthParams !== undefined && args.synthParams !== null) {
    const presetForParams = synthPreset ?? (track.synthPreset ?? SYNTH_INSTRUMENTS[0].id)
    synthParams = mergeSynthParams(track, args.synthParams, presetForParams)
  }
  if (sends?.reverb !== undefined && sends.reverb !== null) strictFiniteNumber(sends.reverb, 'sends.reverb')
  if (sends?.delay !== undefined && sends.delay !== null) strictFiniteNumber(sends.delay, 'sends.delay')
  let preset = null
  let params = {}
  if (isAudioTrack) {
    // P3b：音频轨没有乐器参数/预设，避免模型误以为能改音色。
    if (args.preset !== undefined && args.preset !== null) fail('音频轨没有采样乐器预设；如需换音色请新建采样乐器轨道')
    if (args.params !== undefined && args.params !== null) fail('音频轨没有乐器参数（音频内容来自导入文件）')
    if (args.role !== undefined && args.role !== null && args.role !== 'audio') fail("音频轨的 role 固定为 'audio'")
  } else {
    params = coerceInstrumentParams(track, args.params)
    if (args.preset !== undefined && args.preset !== null) {
      if (track.kind === 'drum') fail('鼓组轨道不能换采样乐器预设；请用 kit（当前不支持在线换鼓组）')
      preset = requireString(args.preset, 'preset')
      if (!findSynthPreset(preset)) {
        fail(`未知采样乐器 preset=${preset}；可选：${SYNTH_PRESETS.map((item) => item.id).join(' / ')}`)
      }
    }
  }

  // 校验全部通过后再写入
  if (name !== undefined) track.name = name
  if (volume !== undefined) track.volume = clamp01(volume)
  if (pan !== undefined) track.pan = clampPan(pan)
  if (mute !== undefined) track.mute = mute
  if (solo !== undefined) track.solo = solo
  if (sends !== undefined) {
    if (!isObject(track.sends)) track.sends = { reverb: 0.18, delay: 0.12 }
    if (sends.reverb !== undefined) track.sends.reverb = clamp01(sends.reverb)
    if (sends.delay !== undefined) track.sends.delay = clamp01(sends.delay)
  }
  if (sendMode !== undefined) {
    if (sendMode === 'pre') track.sendMode = 'pre'
    else delete track.sendMode
  }
  for (const [flag, value] of [['phaseInvert', phaseInvert], ['mono', mono], ['bypassFx', bypassFx]]) {
    if (value === undefined) continue
    if (value) track[flag] = true
    else delete track[flag]
  }
  if (pdcMs !== undefined) {
    if (pdcMs > 0) track.pdcMs = pdcMs
    else delete track.pdcMs
  }
  if (automationMode !== undefined) {
    if (automationMode !== 'read') track.automationMode = automationMode
    else delete track.automationMode
  }
  if (instrumentParams !== undefined) {
    if (Object.keys(instrumentParams).length > 0) track.instrumentParams = instrumentParams
    else delete track.instrumentParams
  }
  if (engine !== undefined) {
    if (engine === 'subtractive') {
      track.engine = 'subtractive'
      if (!track.synthPreset) track.synthPreset = SYNTH_INSTRUMENTS[0].id
      // v2.1：subtractive 时 instrument.preset 必须为 null（UI 用 synthPreset label）。
      if (track.instrument && typeof track.instrument === 'object') track.instrument.preset = null
    } else {
      delete track.engine
      // 切回 sampler：preset 为空时恢复默认采样乐器，避免 UI 显示空乐器。
      if (track.instrument && typeof track.instrument === 'object' && (track.instrument.preset === null || track.instrument.preset === undefined)) {
        track.instrument.preset = SYNTH_PRESETS[0].id
      }
    }
  }
  if (synthPreset !== undefined) track.synthPreset = synthPreset
  if (synthParams !== undefined) {
    if (Object.keys(synthParams).length > 0) track.synthParams = synthParams
    else delete track.synthParams
  }
  if (preset) {
    track.instrument.preset = preset
    // P8/P12：采样乐器没有合成参数（engine 读 soundfont）。
    track.instrument.params = {}
  }
  if (Object.keys(params).length > 0) {
    track.instrument.params = { ...(track.instrument.params ?? {}), ...params }
  }
  return { trackId: track.id, track: trackSummary(track) }
}

/* ------------------------------------------------------------------------- */
/* 音频媒体与音频轨道（P3b）                                                    */
/* ------------------------------------------------------------------------- */

/**
 * 新增一条媒体条目（调用方负责先把文件写入 <dataDir>/media/<file>）。
 * @param {object} project
 * @param {{id?:string,name:string,file:string,bytes:number,durationSeconds?:number|null,channels?:number,sampleRate?:number,peaks?:number[]}} media
 * @returns {object} 规范化后的 media（含分配的 mediaId）
 */
export function addMedia(project, media = {}) {
  if (!isObject(media)) fail('媒体参数必须是对象')
  if (!Array.isArray(project.media)) project.media = []
  if (project.media.length >= MAX_MEDIA) fail(`音频媒体数量已达上限 ${MAX_MEDIA}，无法继续导入`)
  const name = requireString(media.name, 'name', { max: 120 })
  const file = requireString(media.file, 'file', { max: 128 })
  if (file.includes('..') || file.includes('/') || file.includes('\\')) fail(`媒体文件名非法：${file}`)
  const nextId = makeIdGen(project)
  const id = media.id === undefined || media.id === null || media.id === '' ? nextId('med') : requireString(media.id, 'id', { max: 64 })
  if (project.media.some((item) => item.id === id)) fail(`媒体 id 冲突：${id} 已存在`)
  const normalized = normalizeMedia({
    id,
    name,
    file,
    bytes: media.bytes,
    durationSeconds: media.durationSeconds,
    channels: media.channels,
    sampleRate: media.sampleRate,
    peaks: media.peaks,
  })
  if (!normalized) fail(`媒体信息非法：${JSON.stringify({ id, name, file })}（file 必须是 wav/mp3/flac/ogg）`)
  project.media.push(normalized)
  return normalized
}

/** 由媒体时长（秒）计算片段默认长度（小节，至少 1）。 */
export function mediaClipLengthBars(project, media) {
  const seconds = Number(media?.durationSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return MEDIA_DEFAULT_CLIP_BARS
  const barSeconds = (Math.max(1, beatsPerBar(project)) * 60) / Math.max(1, Number(project.bpm) || 120)
  return Math.min(256, Math.max(1, Math.ceil(seconds / barSeconds)))
}

/**
 * 用已有媒体创建一条音频轨 + 播放列表音频片段（导入音频的公共逻辑）。
 * @returns {{trackId:string, clipId:string, mediaId:string, name:string, startBar:number, lengthBars:number}}
 */
export function addAudioTrack(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  if (project.tracks.length >= LIMITS.maxTracks) fail(`轨道数量已达上限 ${LIMITS.maxTracks}，无法导入音频`)
  const media = getMedia(project, args.mediaId)
  const reference = args.reference === true
  const nextId = makeIdGen(project)
  const name = optionalString(args.name, 'name', { max: MAX_NAME }) ?? (reference ? `参考曲 · ${media.name}` : `音频 · ${media.name}`)
  const trackId = nextId('trk')
  const track = makeTrack({ id: trackId, kind: 'audio', name, role: 'audio', reference })
  if (reference) {
    // P14b：参考曲默认静音、音量 0.9、发送量很小，便于 A/B 对比时手动开启。
    track.volume = 0.9
    track.mute = true
    track.sends = { reverb: 0.04, delay: 0.02 }
  }
  project.tracks.push(track)
  // R2c：可选 take 导入（同组旧 take 自动 inactive，新 take active；index 省略按 max+1）。
  let takeGroup = null
  let takeIndex = null
  if (args.takeGroup !== undefined && args.takeGroup !== null && args.takeGroup !== '') {
    takeGroup = normalizeTakeGroup(args.takeGroup)
    if (takeGroup === null) fail('takeGroup 必须是 1..64 位安全字符（字母/数字/_/-）')
    if (args.takeIndex !== undefined && args.takeIndex !== null) {
      takeIndex = normalizeTakeIndex(args.takeIndex)
      if (takeIndex === null) fail(`takeIndex 必须是 0..${TAKE_INDEX_MAX} 的整数`)
    } else {
      const indexes = project.clips
        .filter((clip) => clip.takeGroup === takeGroup)
        .map((clip) => normalizeTakeIndex(clip.takeIndex))
        .filter((index) => index !== null)
      takeIndex = (indexes.length > 0 ? Math.max(...indexes) : -1) + 1
      if (takeIndex > TAKE_INDEX_MAX) fail(`takeGroup「${takeGroup}」的 takeIndex 已达上限 ${TAKE_INDEX_MAX}`)
    }
    for (const clip of project.clips) {
      if (clip.takeGroup === takeGroup) clip.takeActive = false
    }
  } else if (args.takeIndex !== undefined && args.takeIndex !== null) {
    fail('takeIndex 需要与 takeGroup 一起使用')
  }
  const lengthBars = mediaClipLengthBars(project, media)
  const rawStartBar = args.startBar === undefined || args.startBar === null ? 0 : strictFiniteNumber(args.startBar, 'startBar')
  const startBar = Math.trunc(rawStartBar)
  if (startBar < 0) fail('startBar 必须 >= 0')
  if (startBar >= LIMITS.maxBars) fail(`startBar=${startBar} 超出最大曲长 ${LIMITS.maxBars}`)
  const clipLengthBars = Math.min(lengthBars, LIMITS.maxBars - startBar)
  const clipId = nextId('clip')
  project.clips.push(makeClip({
    id: clipId,
    trackId,
    mediaId: media.id,
    startBar,
    lengthBars: clipLengthBars,
    takeGroup,
    takeIndex,
    takeActive: true,
  }))
  return {
    trackId,
    clipId,
    mediaId: media.id,
    name: track.name,
    reference,
    mute: track.mute === true,
    volume: round(track.volume, 3),
    startBar,
    lengthBars: clipLengthBars,
    offsetSeconds: 0,
    ...(takeGroup !== null ? { takeGroup, takeIndex, takeActive: true } : {}),
  }
}

/**
 * 删除轨道及其全部片段（音频媒体保留，避免误删已导入素材）。
 * @returns {{trackId:string, name:string, removed:true, removedClips:number, remainingTracks:number}}
 */
export function removeTrack(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const removedClips = project.clips.filter((clip) => clip.trackId === track.id).length
  project.tracks = project.tracks.filter((item) => item.id !== track.id)
  project.clips = project.clips.filter((clip) => clip.trackId !== track.id)
  return {
    trackId: track.id,
    name: track.name,
    removed: true,
    removedClips,
    remainingTracks: project.tracks.length,
  }
}

/* ------------------------------------------------------------------------- */
/* Pattern / 音符                                                             */
/* ------------------------------------------------------------------------- */

/**
 * studio_add_pattern：新增空 pattern。
 * @returns { patternId, pattern }
 */
export function addPattern(project, args = {}) {
  if (!isObject(args)) args = {}
  if (project.patterns.length >= LIMITS.maxPatterns) fail(`pattern 数量已达上限 ${LIMITS.maxPatterns}`)
  const name = optionalString(args.name, 'name', { max: MAX_PATTERN_NAME }) ?? 'New Pattern'
  const lengthBars = requireNumber(args.lengthBars ?? 4, 'lengthBars', { min: 1, max: 64, integer: true })
  const nextId = makeIdGen(project)
  const pattern = makePattern({ id: nextId('pat'), name, lengthBars })
  project.patterns.push(pattern)
  return { patternId: pattern.id, pattern: patternSummary(pattern) }
}

/**
 * studio_set_notes：整段替换 pattern 音符。
 * @returns { patternId, noteCount, warning? }
 */
export function setNotes(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const pattern = getPattern(project, args.patternId)
  if (args.notes === undefined) fail('缺少 notes 参数（每项 { pitch, start, dur, vel }；清空可传 []）')
  const notes = validateNotes(args.notes)
  pattern.notes = notes
  // 提示模型：超出 pattern 长度的音符在循环播放时会被截断（UI 也会显示不全）。
  const patternBeats = Math.max(1, pattern.lengthBars) * beatsPerBar(project)
  const overflow = notes.filter((note) => note.start >= patternBeats - 1e-6).length
  if (overflow > 0) {
    return {
      patternId: pattern.id,
      noteCount: notes.length,
      warning: `有 ${overflow} 个音符超出 pattern 长度（${pattern.lengthBars} 小节 = ${patternBeats} beat），循环播放时不会响起；如需更长段落请用 add_pattern 设更大的 lengthBars`,
    }
  }
  return { patternId: pattern.id, noteCount: notes.length }
}

/* ------------------------------------------------------------------------- */
/* 编排                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * studio_set_arrangement：整体替换 clips（与可选 sections）。
 * @returns { clips, sections, sectionsReplaced }
 */
export function setArrangement(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  if (args.clips === undefined) fail('缺少 clips 参数（数组；传 [] 表示清空编排）')
  const clips = validateClips(project, args.clips)
  // P3b：AI 的 set_arrangement 只编排 pattern 片段；音频片段用 studio_import_audio / UI 播放列表。
  if (clips.some((clip) => clip.mediaId)) {
    fail('setArrangement 只接受 pattern 片段；音频片段请用 studio_import_audio 导入（或播放列表 UI），音频片段编排留待后续版本')
  }
  const sectionsProvided = args.sections !== undefined && args.sections !== null
  const sections = sectionsProvided ? validateSections(args.sections) : null
  replaceClips(project, clips)
  if (sections) replaceSections(project, sections)
  // 提示模型：片段超出当前曲长时，结尾部分不会被播放/导出。
  const overrun = project.clips.filter((clip) => clip.startBar + clip.lengthBars > project.lengthBars).length
  const result = { clips: project.clips.length, sections: project.sections.length, sectionsReplaced: sectionsProvided }
  if (overrun > 0) {
    result.warning = `有 ${overrun} 个片段超出曲长 ${project.lengthBars} 小节，结尾超出部分不会被播放/导出；如需更长请重新 create_project 或缩短片段`
  }
  return result
}

/** 整体替换编排片段（P1 编辑 API 用，不含 sections）。 */
export function setClips(project, args = {}) {
  // R2a：兼容直接传 clips 数组（内部工具/测试便利；等价 {clips}）。
  if (Array.isArray(args)) args = { clips: args }
  if (!isObject(args)) fail('参数必须是对象')
  if (!Array.isArray(args.clips)) fail('clips 必须是数组')
  const clips = validateClips(project, args.clips)
  replaceClips(project, clips)
  return { clips: project.clips.length }
}

/** 整体替换段落（P1 编辑 API 用）。 */
export function setSections(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  if (!Array.isArray(args.sections)) fail('sections 必须是数组')
  const sections = validateSections(args.sections)
  replaceSections(project, sections)
  return { sections: project.sections.length }
}

/** 修改 pattern 的名称/循环长度（P1 编辑 API 用）。 */
export function updatePattern(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const pattern = getPattern(project, args.patternId)
  const name = optionalString(args.name, 'name', { max: MAX_PATTERN_NAME })
  const lengthBars = optionalNumber(args.lengthBars, 'lengthBars', { min: 1, max: 64, integer: true })
  if (name === undefined && lengthBars === undefined) fail('updatePattern 需要至少提供 name 或 lengthBars')
  if (name !== undefined) pattern.name = name
  if (lengthBars !== undefined) pattern.lengthBars = lengthBars
  return { patternId: pattern.id, pattern: patternSummary(pattern) }
}

/** 删除 pattern（被 clip 引用时拒绝，P1 编辑 API 用）。 */
export function removePattern(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const pattern = getPattern(project, args.patternId)
  const refs = project.clips.filter((clip) => clip.patternId === pattern.id)
  if (refs.length > 0) {
    fail(`pattern ${pattern.id} 正被 ${refs.length} 个片段引用，不能删除；请先删除或替换这些片段（可先 setClips）`)
  }
  const index = project.patterns.indexOf(pattern)
  project.patterns.splice(index, 1)
  return { patternId: pattern.id, removed: true, patternCount: project.patterns.length }
}

/* ------------------------------------------------------------------------- */
/* P10：增量编辑（一次调用 = 一次撤销步）                                       */
/* ------------------------------------------------------------------------- */

/** 校验索引数组（0 基，允许重复但要合法）。 */
function validateIndices(raw, field, length, { allowEmpty = true } = {}) {
  if (!Array.isArray(raw)) fail(`${field} 必须是索引数组`)
  if (!allowEmpty && raw.length === 0) fail(`${field} 不能为空数组`)
  return raw.map((value, order) => {
    const numeric = Number(value)
    if (!Number.isInteger(numeric)) fail(`${field}[${order}] 必须是整数索引，收到 ${JSON.stringify(value)}`)
    if (numeric < 0 || numeric >= length) fail(`${field}[${order}]=${numeric} 越界（当前共 ${length} 项，索引 0..${Math.max(0, length - 1)}）`)
    return numeric
  })
}

/**
 * studio_edit_notes：增量编辑 pattern 音符（一次调用 = 一次撤销）。
 * 顺序：update → remove → add → transpose → velocityScale → quantize → humanize。
 * @returns {{patternId:string, noteCount:number, added:number, removed:number, updated:number, warnings?:string[]}}
 */
export function editPatternNotes(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const pattern = getPattern(project, args.patternId)
  const notes = (pattern.notes ?? []).map((note) => ({ ...note }))
  let updated = 0
  let removed = 0
  let added = 0

  // 1) update（索引基于编辑前顺序）
  if (args.update !== undefined && args.update !== null) {
    if (!Array.isArray(args.update)) fail('update 必须是数组，每项 { index, pitch?, start?, dur?, vel? }')
    for (const [order, patch] of args.update.entries()) {
      if (!isObject(patch)) fail(`update[${order}] 必须是对象`)
      const index = Number(patch.index)
      if (!Number.isInteger(index) || index < 0 || index >= notes.length) {
        fail(`update[${order}].index=${JSON.stringify(patch.index)} 越界（当前共 ${notes.length} 个音符）`)
      }
      const target = notes[index]
      if (patch.pitch !== undefined && patch.pitch !== null) {
        const pitch = Number(patch.pitch)
        if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) fail(`update[${order}].pitch 必须是 0..127 的整数，收到 ${JSON.stringify(patch.pitch)}`)
        target.pitch = pitch
      }
      if (patch.start !== undefined && patch.start !== null) {
        const start = Number(patch.start)
        if (!Number.isFinite(start) || start < 0) fail(`update[${order}].start 必须是 >= 0 的数字，收到 ${JSON.stringify(patch.start)}`)
        target.start = round(start, 6)
      }
      if (patch.dur !== undefined && patch.dur !== null) {
        const dur = Number(patch.dur)
        if (!Number.isFinite(dur) || dur <= 0) fail(`update[${order}].dur 必须是 > 0 的数字，收到 ${JSON.stringify(patch.dur)}`)
        target.dur = round(dur, 6)
      }
      if (patch.vel !== undefined && patch.vel !== null) {
        const vel = Number(patch.vel)
        if (!Number.isFinite(vel)) fail(`update[${order}].vel 必须是 0..1 的数字`)
        target.vel = clamp01(vel)
      }
      updated += 1
    }
  }

  // 2) remove（倒序删除，索引基于编辑前顺序）
  if (args.remove !== undefined && args.remove !== null) {
    const indices = validateIndices(args.remove, 'remove', notes.length)
    const unique = [...new Set(indices)].sort((a, b) => b - a)
    for (const index of unique) notes.splice(index, 1)
    removed = unique.length
  }

  // 3) add
  if (args.add !== undefined && args.add !== null) {
    const additions = validateNotes(args.add)
    notes.push(...additions)
    added = additions.length
  }
  if (notes.length > LIMITS.maxNotesPerPattern) {
    fail(`编辑后音符数量 ${notes.length} 超过上限 ${LIMITS.maxNotesPerPattern}；请精简或拆成多个 pattern`)
  }

  // 4) transpose（作用于现有全部）
  if (args.transpose !== undefined && args.transpose !== null) {
    const semitones = Number(args.transpose)
    if (!Number.isInteger(semitones) || semitones < -48 || semitones > 48) fail('transpose 必须是 -48..48 的整数（半音）')
    for (const note of notes) note.pitch = Math.min(127, Math.max(0, note.pitch + semitones))
  }

  // 5) velocityScale
  if (args.velocityScale !== undefined && args.velocityScale !== null) {
    const scale = Number(args.velocityScale)
    if (!Number.isFinite(scale) || scale < 0 || scale > 2) fail('velocityScale 必须是 0..2 的数字')
    for (const note of notes) note.vel = clamp01(note.vel * scale)
  }

  // 6) quantize（吸附 start 到最近的 beat 网格）
  if (args.quantize !== undefined && args.quantize !== null) {
    const grid = Number(args.quantize)
    if (!Number.isFinite(grid) || grid <= 0) fail('quantize 必须是 > 0 的网格（单位 beat，如 0.25 = 16 分音符）')
    for (const note of notes) note.start = Math.max(0, round(Math.round(note.start / grid) * grid, 6))
  }

  // 7) humanize（随机微扰；timing 默认 0.015 beat、velocity 默认 0.05）
  if (args.humanize !== undefined && args.humanize !== null) {
    if (!isObject(args.humanize)) fail('humanize 必须是对象，如 { timing: 0.015, velocity: 0.05 }')
    const timing = args.humanize.timing === undefined || args.humanize.timing === null ? 0.015 : Number(args.humanize.timing)
    const velocity = args.humanize.velocity === undefined || args.humanize.velocity === null ? 0.05 : Number(args.humanize.velocity)
    if (!Number.isFinite(timing) || timing < 0) fail('humanize.timing 必须是 >= 0 的数字')
    if (!Number.isFinite(velocity) || velocity < 0 || velocity > 1) fail('humanize.velocity 必须是 0..1 的数字')
    for (const note of notes) {
      note.start = Math.max(0, round(note.start + (Math.random() * 2 - 1) * timing, 6))
      note.vel = clamp01(note.vel + (Math.random() * 2 - 1) * velocity)
    }
  }

  pattern.notes = notes.map((note) => normalizeNote(note))
  return { patternId: pattern.id, noteCount: pattern.notes.length, added, removed, updated }
}

/**
 * studio_edit_clips：增量编辑播放列表片段（add/remove/update，一次调用 = 一次撤销）。
 * @returns {{clips:number}}
 */
export function editClips(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  if (args.add === undefined && args.remove === undefined && args.update === undefined) {
    fail('editClips 需要至少提供 add / remove / update 之一')
  }
  const clips = project.clips.map((clip) => ({ ...clip }))
  // 1) update（索引基于当前顺序）
  if (args.update !== undefined && args.update !== null) {
    if (!Array.isArray(args.update)) fail('update 必须是数组，每项 { index, startBar?, lengthBars?, transpose?, trackId?, patternId?, offsetSeconds?, gainDb?, fadeInSeconds?, fadeOutSeconds?, reverse?, stretchRatio?, semitones?, takeGroup?, takeIndex?, takeActive? }')
    for (const [order, patch] of args.update.entries()) {
      if (!isObject(patch)) fail(`update[${order}] 必须是对象`)
      const index = Number(patch.index)
      if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
        fail(`update[${order}].index=${JSON.stringify(patch.index)} 越界（当前共 ${clips.length} 个片段）`)
      }
      const target = clips[index]
      if (patch.trackId !== undefined) target.trackId = patch.trackId
      if (patch.patternId !== undefined) target.patternId = patch.patternId
      if (patch.startBar !== undefined) target.startBar = patch.startBar
      if (patch.lengthBars !== undefined) target.lengthBars = patch.lengthBars
      if (patch.transpose !== undefined) target.transpose = patch.transpose
      // R2a：音频片段字段（validateClips 会做类型/范围/时长校验）
      if (patch.offsetSeconds !== undefined) target.offsetSeconds = patch.offsetSeconds
      if (patch.gainDb !== undefined) target.gainDb = patch.gainDb
      if (patch.fadeInSeconds !== undefined) target.fadeInSeconds = patch.fadeInSeconds
      if (patch.fadeOutSeconds !== undefined) target.fadeOutSeconds = patch.fadeOutSeconds
      if (patch.reverse !== undefined) target.reverse = patch.reverse
      if (patch.stretchRatio !== undefined) target.stretchRatio = patch.stretchRatio
      if (patch.semitones !== undefined) target.semitones = patch.semitones
      if (patch.takeGroup !== undefined) target.takeGroup = patch.takeGroup
      if (patch.takeIndex !== undefined) target.takeIndex = patch.takeIndex
      if (patch.takeActive !== undefined) target.takeActive = patch.takeActive
    }
  }
  // 2) remove（倒序删除）
  if (args.remove !== undefined && args.remove !== null) {
    const indices = validateIndices(args.remove, 'remove', clips.length)
    const unique = [...new Set(indices)].sort((a, b) => b - a)
    for (const index of unique) clips.splice(index, 1)
  }
  // 3) add
  if (args.add !== undefined && args.add !== null) {
    if (!Array.isArray(args.add)) fail('add 必须是片段数组，如 [{ trackId, patternId, startBar, lengthBars }]')
    for (const clip of args.add) clips.push({ ...clip })
  }
  const validated = validateClips(project, clips)
  replaceClips(project, validated)
  return { clips: project.clips.length }
}

/* ------------------------------------------------------------------------- */
/* R2a：音频片段编辑（gain / fade / reverse / offset / split）                  */
/* ------------------------------------------------------------------------- */

/** 找音频片段；不存在/pattern 片段返回中文错误。 */
function getAudioClip(project, clipId) {
  const id = requireString(clipId, 'clipId', { max: 64 })
  const clip = project.clips.find((item) => item.id === id)
  if (!clip) fail(`找不到片段 clipId=${id}`)
  if (typeof clip.mediaId !== 'string' || clip.mediaId === '') fail(`片段 ${id} 不是音频片段（没有 mediaId）；pattern 片段不能用本工具编辑`)
  const media = project.media.find((item) => item.id === clip.mediaId) ?? null
  return { clip, media }
}

/** 音频 clip 摘要（给工具返回/测试断言）。 */
export function audioClipSummary(clip) {
  return {
    id: clip.id,
    trackId: clip.trackId,
    mediaId: clip.mediaId,
    startBar: clip.startBar,
    lengthBars: clip.lengthBars,
    offsetSeconds: round(Number(clip.offsetSeconds) || 0, 3),
    gainDb: Number.isFinite(Number(clip.gainDb)) ? round(clip.gainDb, 1) : 0,
    fadeInSeconds: Number.isFinite(Number(clip.fadeInSeconds)) ? round(clip.fadeInSeconds, 3) : 0,
    fadeOutSeconds: Number.isFinite(Number(clip.fadeOutSeconds)) ? round(clip.fadeOutSeconds, 3) : 0,
    reverse: clip.reverse === true,
    stretchRatio: Number.isFinite(Number(clip.stretchRatio)) && Number(clip.stretchRatio) !== 1 ? round(clip.stretchRatio, 3) : 1,
    semitones: Number.isFinite(Number(clip.semitones)) ? round(clip.semitones, 1) : 0,
    ...(normalizeTakeGroup(clip.takeGroup) !== null
      ? {
          takeGroup: normalizeTakeGroup(clip.takeGroup),
          ...(normalizeTakeIndex(clip.takeIndex) !== null ? { takeIndex: normalizeTakeIndex(clip.takeIndex) } : {}),
          takeActive: clip.takeActive !== false,
        }
      : {}),
  }
}

/** 片段可播放秒数（媒体剩余时长与片段长度取小；媒体未知用片段长度）。 */
function clipPlayableSeconds(project, clip) {
  return audioClipPlayableSeconds(project, clip)
}

/**
 * studio_update_audio_clip：编辑音频片段电平/淡变/反向/offset/位置/长度。
 * 只允许 media clip；一次 mutate；范围/媒体时长/片段长度非法返回中文错误。
 * @returns {{clipId:string, clip:object}}
 */
export function updateAudioClip(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const { clip, media } = getAudioClip(project, args.clipId)
  const editable = ['gainDb', 'fadeInSeconds', 'fadeOutSeconds', 'reverse', 'offsetSeconds', 'startBar', 'lengthBars', 'stretchRatio', 'semitones', 'takeGroup', 'takeIndex', 'takeActive']
  if (!editable.some((field) => args[field] !== undefined)) {
    fail(`至少提供一个要修改的字段：${editable.join(' / ')}`)
  }
  const nextStartBar = args.startBar === undefined ? clip.startBar : requireNumber(args.startBar, 'startBar', { min: 0, max: LIMITS.maxBars - 1, integer: true })
  const nextLengthBars = args.lengthBars === undefined ? clip.lengthBars : requireNumber(args.lengthBars, 'lengthBars', { min: 1, max: LIMITS.maxBars, integer: true })
  if (nextStartBar + nextLengthBars > LIMITS.maxBars) {
    fail(`片段结束于第 ${nextStartBar + nextLengthBars} 小节，超过最大曲长 ${LIMITS.maxBars}`)
  }
  let nextOffset = clip.offsetSeconds
  if (args.offsetSeconds !== undefined) {
    const offset = strictFiniteNumber(args.offsetSeconds, 'offsetSeconds')
    if (offset < 0) fail('offsetSeconds 必须 >= 0')
    const mediaDuration = Number(media?.durationSeconds)
    if (Number.isFinite(mediaDuration) && mediaDuration > 0 && offset >= mediaDuration) {
      fail(`offsetSeconds=${offset}s 超出媒体时长 ${mediaDuration}s`)
    }
    nextOffset = normalizeClipOffset(offset, media)
  }
  // R2b：stretchRatio 先校验（媒体源时长换算要用它）；记录原 ratio 用于“过盈 slack”。
  const previousStretchRatio = Number(clip.stretchRatio) || 1
  let nextStretchRatio = previousStretchRatio
  if (args.stretchRatio !== undefined && args.stretchRatio !== null) {
    const ratio = strictFiniteNumber(args.stretchRatio, 'stretchRatio')
    if (ratio < AUDIO_CLIP_STRETCH_RATIO_MIN || ratio > AUDIO_CLIP_STRETCH_RATIO_MAX) {
      fail(`stretchRatio 必须在 ${AUDIO_CLIP_STRETCH_RATIO_MIN}..${AUDIO_CLIP_STRETCH_RATIO_MAX} 之间`)
    }
    nextStretchRatio = normalizeAudioClipStretchRatio(ratio)
    if (nextStretchRatio !== 1) clip.stretchRatio = nextStretchRatio
    else delete clip.stretchRatio
  }
  if (args.semitones !== undefined && args.semitones !== null) {
    const pitch = strictFiniteNumber(args.semitones, 'semitones')
    if (pitch < AUDIO_CLIP_SEMITONES_MIN || pitch > AUDIO_CLIP_SEMITONES_MAX) {
      fail(`semitones 必须在 ${AUDIO_CLIP_SEMITONES_MIN}..${AUDIO_CLIP_SEMITONES_MAX} 半音之间`)
    }
    const normalized = normalizeAudioClipSemitones(pitch)
    if (normalized !== 0) clip.semitones = normalized
    else delete clip.semitones
  }
  // 媒体时长校验：只有显式改 offset/length/startBar 时才校验；允许保留导入时已有的“过盈”部分
  // （例如 8s 音频向上取整到 5 小节=9.375s，仅调 gain 不应失败）。
  // R2b：仅改 stretchRatio/semitones（含 1/0 清除）不校验源时长——实际可播放由
  // min(clipTimeline, (mediaDuration-offset)×ratio) 决定，引擎按播放窗口夹紧。
  const mediaDuration = Number(media?.durationSeconds)
  if (
    Number.isFinite(mediaDuration) && mediaDuration > 0 &&
    (args.offsetSeconds !== undefined || args.lengthBars !== undefined || args.startBar !== undefined)
  ) {
    // R2b：源消费秒数 = timeline 秒 / stretchRatio。
    const clipSeconds = audioClipLengthSeconds(project, nextStartBar, nextLengthBars) / nextStretchRatio
    const previousSeconds = audioClipLengthSeconds(project, clip.startBar, clip.lengthBars) / previousStretchRatio
    const previousOffset = Number(clip.offsetSeconds) || 0
    const previousEnd = previousOffset + previousSeconds
    const slack = 0.05 + Math.max(0, previousEnd - mediaDuration)
    if (nextOffset + clipSeconds > mediaDuration + slack + 1e-6) {
      fail(`片段长度 ${round(clipSeconds, 3)}s（源时间，offset ${round(nextOffset, 2)}s）超出媒体剩余时长 ${round(Math.max(0, mediaDuration - nextOffset), 3)}s`)
    }
  }
  // 逐字段严格校验（不静默夹紧）
  if (args.gainDb !== undefined && args.gainDb !== null) {
    const gainDb = strictFiniteNumber(args.gainDb, 'gainDb')
    if (gainDb < AUDIO_CLIP_GAIN_DB_MIN || gainDb > AUDIO_CLIP_GAIN_DB_MAX) {
      fail(`gainDb 必须在 ${AUDIO_CLIP_GAIN_DB_MIN}..${AUDIO_CLIP_GAIN_DB_MAX} dB 之间`)
    }
    clip.gainDb = normalizeAudioClipGainDb(gainDb)
    if (clip.gainDb === 0) delete clip.gainDb
  }
  for (const field of ['fadeInSeconds', 'fadeOutSeconds']) {
    if (args[field] === undefined || args[field] === null) continue
    const value = strictFiniteNumber(args[field], field)
    if (value < 0 || value > AUDIO_CLIP_FADE_MAX_SECONDS) {
      fail(`${field} 必须在 0..${AUDIO_CLIP_FADE_MAX_SECONDS} 秒之间`)
    }
    const normalized = normalizeAudioClipFadeSeconds(value)
    if (normalized > 0) clip[field] = normalized
    else delete clip[field]
  }
  if (args.reverse !== undefined && args.reverse !== null) {
    if (typeof args.reverse !== 'boolean') fail('reverse 必须是布尔值（true/false）')
    if (args.reverse) clip.reverse = true
    else delete clip.reverse
  }
  // R2c：take 字段（clearGroup=true 或 takeGroup=null/'' 清除整组）。
  if (args.takeGroup !== undefined) {
    if (args.takeGroup === null || args.takeGroup === '') {
      delete clip.takeGroup
      delete clip.takeIndex
      delete clip.takeActive
    } else {
      const group = normalizeTakeGroup(args.takeGroup)
      if (group === null) fail('takeGroup 必须是 1..64 位安全字符（字母/数字/_/-）')
      clip.takeGroup = group
    }
  }
  if (args.takeIndex !== undefined && args.takeIndex !== null) {
    if (typeof clip.takeGroup !== 'string' || clip.takeGroup === '') fail('设置 takeIndex 需要先有 takeGroup')
    const index = normalizeTakeIndex(args.takeIndex)
    if (index === null) fail(`takeIndex 必须是 0..${TAKE_INDEX_MAX} 的整数`)
    clip.takeIndex = index
  }
  if (args.takeActive !== undefined && args.takeActive !== null) {
    if (typeof clip.takeGroup !== 'string' || clip.takeGroup === '') fail('设置 takeActive 需要先有 takeGroup')
    if (typeof args.takeActive !== 'boolean') fail('takeActive 必须是布尔值')
    if (args.takeActive === false) clip.takeActive = false
    else delete clip.takeActive
  }
  if (typeof clip.takeGroup !== 'string' || clip.takeGroup === '') {
    delete clip.takeIndex
    delete clip.takeActive
  }
  clip.startBar = nextStartBar
  clip.lengthBars = nextLengthBars
  if (nextOffset !== clip.offsetSeconds) clip.offsetSeconds = nextOffset
  // fade 总和不得超过实际可播放时长
  const playable = clipPlayableSeconds(project, clip)
  const fadeSum = (Number(clip.fadeInSeconds) || 0) + (Number(clip.fadeOutSeconds) || 0)
  if (fadeSum > playable + 1e-6) {
    fail(`fadeIn+fadeOut=${round(fadeSum, 3)}s 超过片段可播放时长 ${round(playable, 3)}s`)
  }
  normalizeAudioClipFields(project, clip)
  return { clipId: clip.id, clip: audioClipSummary(clip) }
}

/**
 * studio_split_audio_clip：在绝对小节 atBar 处分割音频片段。
 * - 左段：缩短、保留 fadeIn、去掉 fadeOut；右段：startBar=atBar、offsetSeconds 增加
 *   「atBar 相对片段起点的 tempo 秒数」、保留 fadeOut、去掉 fadeIn（默认不 crossfade）；
 * - gainDb/reverse 两段都保留；一次 mutate；返回 {left,right}。
 */
export function splitAudioClip(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const { clip, media } = getAudioClip(project, args.clipId)
  const atBar = requireNumber(args.atBar, 'atBar', { min: 0, max: LIMITS.maxBars, integer: true })
  const clipEnd = clip.startBar + clip.lengthBars
  if (!(clip.startBar < atBar && atBar < clipEnd)) {
    fail(`atBar=${atBar} 必须在片段内部（${clip.startBar} < atBar < ${clipEnd}）`)
  }
  const barBeats = beatsPerBar(project)
  const tempo = createTempoMap(project)
  const splitBaseline = Math.max(0, Number(clip.startBar) || 0) * barBeats
  const deltaSeconds = Math.max(0, tempo.beatToSeconds(atBar * barBeats) - tempo.beatToSeconds(splitBaseline))
  const stretchRatio = Number(clip.stretchRatio) || 1
  // R2b：右段源 offset 增量 = timeline 增量 / stretchRatio。
  const sourceDeltaSeconds = deltaSeconds / stretchRatio
  const leftLength = atBar - clip.startBar
  const rightLength = clipEnd - atBar
  const rawNextOffset = (Number(clip.offsetSeconds) || 0) + sourceDeltaSeconds
  const nextOffset = normalizeClipOffset(rawNextOffset, media)
  const mediaDuration = Number(media?.durationSeconds)
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) {
    // 媒体时长未知：仍允许分割（offset 按 tempo 换算）
  } else if (rawNextOffset >= mediaDuration) {
    fail(`分割后右段 offsetSeconds=${round(nextOffset, 3)}s 超出媒体时长 ${mediaDuration}s（片段超出媒体剩余部分）`)
  }
  const nextId = makeIdGen(project)
  const rightId = nextId('clip')
  // 左段（原 clip 原地缩短）
  const originalFadeIn = Number(clip.fadeInSeconds) || 0
  const originalFadeOut = Number(clip.fadeOutSeconds) || 0
  const gainDb = Number(clip.gainDb) || 0
  const reverse = clip.reverse === true
  const semitones = Number(clip.semitones) || 0
  const takeGroup = normalizeTakeGroup(clip.takeGroup)
  const takeIndex = normalizeTakeIndex(clip.takeIndex)
  const takeActive = clip.takeActive !== false
  clip.lengthBars = leftLength
  delete clip.fadeOutSeconds
  if (originalFadeIn > 0) clip.fadeInSeconds = originalFadeIn
  else delete clip.fadeInSeconds
  normalizeAudioClipFields(project, clip)
  const right = makeClip({
    id: rightId,
    trackId: clip.trackId,
    mediaId: clip.mediaId,
    startBar: atBar,
    lengthBars: rightLength,
    offsetSeconds: nextOffset,
    gainDb,
    fadeInSeconds: 0,
    fadeOutSeconds: originalFadeOut,
    reverse,
    stretchRatio,
    semitones,
    takeGroup,
    takeIndex,
    takeActive,
  })
  normalizeAudioClipFields(project, right)
  project.clips.push(right)
  return {
    splitAtBar: atBar,
    offsetDeltaSeconds: round(deltaSeconds, 3),
    sourceOffsetDeltaSeconds: round(sourceDeltaSeconds, 3),
    stretchRatio,
    left: audioClipSummary(clip),
    right: audioClipSummary(right),
  }
}

/**
 * studio_set_take_active：激活指定 take（R2c）。
 * - 指定 clipId：只激活该 clip（不自动取消其他 active，便于多段 comp）；
 * - 指定 takeGroup + takeIndex（可选 trackId 过滤）：同组内该 takeIndex 的 clip 全部 active=true，
 *   同组其余 clip active=false（一次 mutate/撤销）。
 * @returns {{takeGroup:string, takeIndex?:number, activeClipIds:string[], deactivatedClipIds:string[]}}
 */
export function setTakeActive(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const hasClipId = args.clipId !== undefined && args.clipId !== null && args.clipId !== ''
  const hasTakeIndex = args.takeIndex !== undefined && args.takeIndex !== null
  const hasTakeGroup = args.takeGroup !== undefined && args.takeGroup !== null && args.takeGroup !== ''
  const hasTrackId = args.trackId !== undefined && args.trackId !== null && args.trackId !== ''
  if (hasClipId && hasTakeIndex) fail('clipId 与 takeIndex 不能同时指定（clipId 模式只激活该片段）')
  let takeGroup = null
  if (hasTakeGroup) {
    takeGroup = normalizeTakeGroup(args.takeGroup)
    if (takeGroup === null) fail('takeGroup 必须是 1..64 位安全字符（字母/数字/_/-）')
  }
  let trackId = null
  if (hasTrackId) {
    trackId = String(args.trackId)
    if (!project.tracks.some((track) => track.id === trackId)) fail(`找不到轨道 trackId=${trackId}`)
  }
  // 模式 A：clipId 只激活该片段
  if (hasClipId) {
    const clipId = String(args.clipId)
    const clip = project.clips.find((item) => item.id === clipId)
    if (!clip) fail(`找不到片段 clipId=${clipId}`)
    if (typeof clip.mediaId !== 'string' || clip.mediaId === '') fail(`片段 ${clipId} 不是音频片段`)
    if (takeGroup !== null && normalizeTakeGroup(clip.takeGroup) !== takeGroup) {
      fail(`片段 ${clipId} 不属于 takeGroup「${takeGroup}」`)
    }
    if (trackId !== null && clip.trackId !== trackId) fail(`片段 ${clipId} 不在轨道 ${trackId} 上`)
    delete clip.takeActive
    return {
      takeGroup: normalizeTakeGroup(clip.takeGroup),
      ...(normalizeTakeIndex(clip.takeIndex) !== null ? { takeIndex: normalizeTakeIndex(clip.takeIndex) } : {}),
      activeClipIds: [clip.id],
      deactivatedClipIds: [],
    }
  }
  // 模式 B：takeGroup（+takeIndex）批量激活
  if (takeGroup === null) fail('需要 takeGroup（或用 clipId 指定单个片段）')
  if (!hasTakeIndex) fail('需要 takeIndex（或用 clipId 指定单个片段）')
  const takeIndex = normalizeTakeIndex(args.takeIndex)
  if (takeIndex === null) fail(`takeIndex 必须是 0..${TAKE_INDEX_MAX} 的整数`)
  let candidates = project.clips.filter((clip) => normalizeTakeGroup(clip.takeGroup) === takeGroup && typeof clip.mediaId === 'string')
  if (trackId !== null) candidates = candidates.filter((clip) => clip.trackId === trackId)
  if (candidates.length === 0) fail(`takeGroup「${takeGroup}」不存在（或该轨道没有 take 片段）`)
  const targets = candidates.filter((clip) => normalizeTakeIndex(clip.takeIndex) === takeIndex)
  if (targets.length === 0) fail(`takeGroup「${takeGroup}」下没有 takeIndex=${takeIndex} 的片段`)
  const activeClipIds = []
  const deactivatedClipIds = []
  for (const clip of candidates) {
    if (targets.includes(clip)) {
      delete clip.takeActive
      activeClipIds.push(clip.id)
    } else if (clip.takeActive === false) {
      // 已经是 inactive 的不重复计入
    } else {
      clip.takeActive = false
      deactivatedClipIds.push(clip.id)
    }
  }
  return { takeGroup, takeIndex, activeClipIds, deactivatedClipIds }
}

/* ------------------------------------------------------------------------- */
/* R3a：乐理 / 和弦 / 琶音 / Groove                                            */
/* ------------------------------------------------------------------------- */

/** 解析进行项（罗马数字字符串或 {roman?, quality?, rootPitch?}）→ 和弦描述。 */
function resolveChordItem(project, item, options = {}) {
  const octave = Number.isFinite(Number(options.octave)) ? Math.round(Number(options.octave)) : 4
  const voicing = options.voicing === 'open' ? 'open' : 'close'
  const inversion = Math.max(0, Math.round(Number(options.inversion) || 0))
  const key = project.key ?? 'C'
  const scale = project.scale ?? 'major'
  let rootPitch
  let quality
  let roman = null
  if (typeof item === 'string' && item.trim() !== '') {
    const parsed = parseRoman(item, key, scale)
    if (!parsed) fail(`无法解析罗马数字「${item}」；示例：I / V / vi / IV / ii / bIII / V7`)
    if (!CHORD_QUALITIES[parsed.quality]) fail(`罗马数字「${item}」解析出未知和弦性质 ${parsed.quality}`)
    roman = item.trim()
    quality = parsed.quality
    rootPitch = 12 * (octave + 1) + parsed.rootPitchClass
  } else if (isObject(item)) {
    if (typeof item.roman === 'string' && item.roman.trim() !== '') {
      const parsed = parseRoman(item.roman, key, scale)
      if (!parsed) fail(`无法解析罗马数字「${item.roman}」`)
      roman = item.roman.trim()
      quality = typeof item.quality === 'string' ? item.quality : parsed.quality
      rootPitch = 12 * (octave + 1) + parsed.rootPitchClass
    } else if (item.rootPitch !== undefined && item.rootPitch !== null) {
      quality = typeof item.quality === 'string' ? item.quality : 'major'
      rootPitch = item.rootPitch
    } else {
      fail('进行项必须提供 roman 或 rootPitch（可带 quality）')
    }
    if (!CHORD_QUALITIES[quality]) fail(`未知和弦性质「${quality}」；可选：${Object.keys(CHORD_QUALITIES).join(' / ')}`)
  } else {
    fail('进行项必须是罗马数字字符串或 {roman?,quality?,rootPitch?} 对象')
  }
  const pitches = buildChord({ rootPitch, quality, voicing, inversion, octave })
  return {
    ...(roman !== null ? { roman } : {}),
    quality,
    rootPitch: Math.max(0, Math.min(127, Math.round(Number(rootPitch) || 0))),
    pitches,
    name: `${pitchClassToName(((Number(rootPitch) % 12) + 12) % 12)}${CHORD_QUALITIES[quality].label.includes('小') ? 'm' : ''}`,
  }
}

/* ------------------------------------------------------------------------- */
/* R4c：混音场景（project.scenes）                                             */
/* ------------------------------------------------------------------------- */

/** studio_list_scenes：只读摘要（不含完整 state）。 */
export function listScenes(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : []
  return { scenes: scenes.map(sceneSummary), count: scenes.length }
}

function findScene(project, args = {}) {
  const scenes = Array.isArray(project.scenes) ? project.scenes : []
  const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : null
  const rawName = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null
  if (id === null && rawName === null) fail('需要 id 或 name 之一来指定场景')
  const scene = id !== null
    ? scenes.find((item) => item.id === id)
    : scenes.find((item) => item.name === rawName)
  if (!scene) fail(id !== null ? `找不到场景 id=${id}` : `找不到场景 name=${rawName}`)
  return scene
}

function nextSceneId(project) {
  let max = 0
  for (const scene of project.scenes ?? []) {
    const match = /^scene_([0-9]+)$/.exec(scene.id ?? '')
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `scene_${max + 1}`
}

/**
 * studio_save_scene：保存当前混音字段快照（同名覆盖/新增，≤8）；一次撤销。
 * state 只含 tracks/groups/master/buses 混音字段与 effects 深拷贝。
 */
export function saveScene(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const rawName = typeof args.name === 'string' ? args.name.trim() : ''
  if (rawName === '') fail('name 不能为空')
  if (rawName.length > SCENE_NAME_MAX) fail(`name 不能超过 ${SCENE_NAME_MAX} 字符`)
  const name = normalizeSceneName(rawName)
  const scenes = Array.isArray(project.scenes) ? project.scenes : []
  const at = new Date().toISOString()
  const state = captureSceneState(project)
  const existing = scenes.find((scene) => scene.name === name)
  if (existing) {
    existing.state = state
    existing.at = at
    return { scene: sceneSummary(existing), overwritten: true, count: scenes.length }
  }
  if (scenes.length >= MAX_SCENES) fail(`场景数量已达上限 ${MAX_SCENES}`)
  const scene = { id: nextSceneId(project), name, at, state }
  project.scenes = [...scenes, scene]
  return { scene: sceneSummary(scene), overwritten: false, count: project.scenes.length }
}

/**
 * studio_recall_scene：恢复场景混音字段；只恢复仍存在的 track/group id，缺失跳过；
 * notes/clips/编排/自动化不动；一次撤销。
 */
export function recallScene(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const scene = findScene(project, args)
  const state = scene.state ?? {}
  let restoredTracks = 0
  let skippedTracks = 0
  for (const snapshot of Array.isArray(state.tracks) ? state.tracks : []) {
    const track = project.tracks.find((item) => item.id === snapshot.id)
    if (!track) {
      skippedTracks += 1
      continue
    }
    track.volume = clamp01(Number(snapshot.volume ?? track.volume ?? 0.78))
    track.pan = clampPan(Number(snapshot.pan ?? track.pan ?? 0))
    track.mute = snapshot.mute === true
    track.solo = snapshot.solo === true
    track.sends = {
      reverb: clamp01(Number(snapshot.sends?.reverb ?? 0.18)),
      delay: clamp01(Number(snapshot.sends?.delay ?? 0.12)),
    }
    if (snapshot.sendMode === 'pre') track.sendMode = 'pre'
    else delete track.sendMode
    for (const flag of ['phaseInvert', 'mono', 'bypassFx']) {
      if (snapshot[flag] === true) track[flag] = true
      else delete track[flag]
    }
    if (Number(snapshot.pdcMs) > 0) track.pdcMs = Number(snapshot.pdcMs)
    else delete track.pdcMs
    const output = typeof snapshot.output === 'string' ? snapshot.output : 'master'
    if (output !== 'master' && (project.groups ?? []).some((group) => group.id === output)) track.output = output
    else delete track.output
    track.effects = normalizeEffects(snapshot.effects)
    restoredTracks += 1
  }
  let restoredGroups = 0
  let skippedGroups = 0
  for (const snapshot of Array.isArray(state.groups) ? state.groups : []) {
    const group = (project.groups ?? []).find((item) => item.id === snapshot.id)
    if (!group) {
      skippedGroups += 1
      continue
    }
    group.level = clamp01(Number(snapshot.level ?? group.level ?? 0.8))
    group.mute = snapshot.mute === true
    group.solo = snapshot.solo === true
    if (snapshot.bypassFx === true) group.bypassFx = true
    else delete group.bypassFx
    if (Number(snapshot.pdcMs) > 0) group.pdcMs = Number(snapshot.pdcMs)
    else delete group.pdcMs
    group.effects = normalizeEffects(snapshot.effects)
    restoredGroups += 1
  }
  if (state.master !== null && typeof state.master === 'object') {
    project.master.volume = clamp01(Number(state.master.volume ?? project.master.volume ?? 0.82))
    project.master.effects = normalizeEffects(state.master.effects)
  }
  ensureBusStructure(project)
  if (state.buses !== null && typeof state.buses === 'object') {
    for (const busId of BUS_IDS) {
      const snapshot = state.buses[busId]
      if (snapshot === null || typeof snapshot !== 'object') continue
      project.buses[busId].level = clamp01(Number(snapshot.level ?? project.buses[busId].level))
      project.buses[busId].effects = normalizeEffects(snapshot.effects)
    }
  }
  return {
    sceneId: scene.id,
    sceneName: scene.name,
    restoredTracks,
    skippedTracks,
    restoredGroups,
    skippedGroups,
  }
}

/** studio_delete_scene：按 id 或 name 删除；返回 {deleted, sceneId, sceneName, count}。 */
export function deleteScene(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const scene = findScene(project, args)
  project.scenes = (project.scenes ?? []).filter((item) => item !== scene)
  return { deleted: true, sceneId: scene.id, sceneName: scene.name, count: project.scenes.length }
}

/* ------------------------------------------------------------------------- */
/* R4a：Group bus（project.groups / track.output）                             */
/* ------------------------------------------------------------------------- */

/** group 摘要（带 FX 链摘要与输入轨数）。 */
export function groupSummary(project, group) {
  return {
    id: group.id,
    name: group.name,
    level: round(group.level, 3),
    mute: group.mute === true,
    solo: group.solo === true,
    output: 'master',
    // R4b：组 FX 旁路 / 手动 PDC。
    bypassFx: group.bypassFx === true,
    pdcMs: normalizePdcMs(group.pdcMs),
    effects: compactEffectChain(group.effects),
    effectCount: (group.effects ?? []).length,
    inputTracks: project.tracks.filter((track) => track.output === group.id).length,
  }
}

function getGroup(project, groupId) {
  const id = requireString(groupId, 'groupId', { max: 64 })
  const group = (project.groups ?? []).find((item) => item.id === id)
  if (!group) fail(`找不到 group groupId=${id}；可用：${(project.groups ?? []).map((item) => item.id).join(' / ') || '无'}`)
  return group
}

function nextGroupId(project) {
  let max = 0
  for (const group of project.groups ?? []) {
    const match = /^grp_([0-9]+)$/.exec(group.id ?? '')
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `grp_${max + 1}`
}

function validateGroupName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') fail('group name 不能为空')
  if (name.length > GROUP_NAME_MAX) fail(`group name 不能超过 ${GROUP_NAME_MAX} 字符`)
  if (/[\u0000-\u001f]/.test(name)) fail('group name 不能包含控制字符')
  return name
}

/** studio_add_group：新增 group bus（≤8）。 */
export function addGroup(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const groups = Array.isArray(project.groups) ? project.groups : []
  if (groups.length >= MAX_GROUPS) fail(`group 数量已达上限 ${MAX_GROUPS}`)
  const name = args.name === undefined || args.name === null ? `Group ${groups.length + 1}` : validateGroupName(args.name)
  const group = { id: nextGroupId(project), name, level: 0.8, effects: [], mute: false, solo: false, output: 'master' }
  project.groups = [...groups, group]
  return { groupId: group.id, group: groupSummary(project, group), count: project.groups.length }
}

/** studio_update_group：更新 name/level/mute/solo。 */
export function updateGroup(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const group = getGroup(project, args.groupId)
  if (args.name !== undefined) group.name = validateGroupName(args.name)
  if (args.level !== undefined && args.level !== null) {
    group.level = Math.max(0, Math.min(1, requireNumber(args.level, 'level', { min: 0, max: 1 })))
  }
  if (args.mute !== undefined && args.mute !== null) {
    if (typeof args.mute !== 'boolean') fail('mute 必须是布尔值')
    group.mute = args.mute
  }
  if (args.solo !== undefined && args.solo !== null) {
    if (typeof args.solo !== 'boolean') fail('solo 必须是布尔值')
    group.solo = args.solo
  }
  // R4b：组 FX 旁路 / 手动 PDC。
  if (args.bypassFx !== undefined && args.bypassFx !== null) {
    const bypassFx = coerceBool(args.bypassFx, 'bypassFx')
    if (bypassFx) group.bypassFx = true
    else delete group.bypassFx
  }
  if (args.pdcMs !== undefined && args.pdcMs !== null) {
    const pdcMs = normalizePdcMs(strictFiniteNumber(args.pdcMs, 'pdcMs'))
    if (pdcMs > 0) group.pdcMs = pdcMs
    else delete group.pdcMs
  }
  return { groupId: group.id, group: groupSummary(project, group) }
}

/** studio_remove_group：删除 group，输入轨道输出回 master。 */
export function removeGroup(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const group = getGroup(project, args.groupId)
  project.groups = (project.groups ?? []).filter((item) => item !== group)
  let tracksReset = 0
  for (const track of project.tracks) {
    if (track.output === group.id) {
      delete track.output
      tracksReset += 1
    }
  }
  return { groupId: group.id, removed: true, tracksReset, count: project.groups.length }
}

/** studio_set_track_output：轨道输出到 master 或已存在 group。 */
export function setTrackOutput(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const output = requireString(args.output, 'output', { max: 64 })
  if (output === 'master') {
    delete track.output
  } else {
    const group = (project.groups ?? []).find((item) => item.id === output)
    if (!group) fail(`output 必须是 'master' 或已存在 group id，收到「${output}」；可用 group：${(project.groups ?? []).map((item) => item.id).join(' / ') || '无'}`)
    track.output = group.id
  }
  return { trackId: track.id, output: track.output ?? 'master' }
}

/* ------------------------------------------------------------------------- */
/* R3c：MIDI Learn 映射（project.midiMappings）                                 */
/* ------------------------------------------------------------------------- */

/** 当前工程的 MIDI 映射列表（只读拷贝）。 */
export function listMidiMappings(project) {
  const mappings = Array.isArray(project?.midiMappings) ? project.midiMappings : []
  return { midiMappings: mappings.map((mapping) => ({ ...mapping })), count: mappings.length }
}

/** 下一个 map_n id。 */
function nextMidiMappingId(project) {
  let max = 0
  for (const mapping of project.midiMappings ?? []) {
    const match = /^map_([0-9]+)$/.exec(mapping.id ?? '')
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `map_${max + 1}`
}

/**
 * studio_set_midi_mapping：新增/更新（同 id 或同 cc+channel）；一次撤销。
 * 校验 cc/channel/target/track/effect/param/min/max；最多 16 条。
 */
export function setMidiMapping(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const cc = requireNumber(args.cc, 'cc', { min: 0, max: 127, integer: true })
  let channel = null
  if (args.channel !== undefined && args.channel !== null) {
    channel = requireNumber(args.channel, 'channel', { min: 0, max: 15, integer: true })
  }
  const target = requireString(args.target, 'target', { max: 32 })
  if (!MIDI_MAPPING_TARGETS.includes(target)) {
    fail(`target 必须是 ${MIDI_MAPPING_TARGETS.join(' / ')}，收到「${target}」`)
  }
  const trackId = requireString(args.trackId, 'trackId', { max: 64 })
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track) fail(`找不到轨道 trackId=${trackId}`)
  let effectId = null
  let param = null
  if (target === 'effectParam') {
    effectId = requireString(args.effectId, 'effectId', { max: 64 })
    const effect = (track.effects ?? []).find((fx) => fx.id === effectId)
    if (!effect) fail(`轨道「${track.name ?? trackId}」的效果器链中找不到 effectId=${effectId}`)
    const allowed = effectParamIds(effect.type)
    if (allowed.length === 0) fail(`效果器 ${effectId}（type=${effect.type}）没有可映射参数`)
    param = requireString(args.param, 'param', { max: 64 })
    if (!allowed.includes(param)) {
      fail(`效果器 ${effectId} 不支持参数「${param}」；可选：${allowed.join(' / ')}`)
    }
  }
  const min = args.min === undefined || args.min === null ? 0 : requireNumber(args.min, 'min', { min: 0, max: 1 })
  const max = args.max === undefined || args.max === null ? 1 : requireNumber(args.max, 'max', { min: 0, max: 1 })
  if (!(min < max)) fail('min 必须小于 max（0..1）')
  const mappings = project.midiMappings ?? []
  const requestedId = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : null
  if (requestedId !== null && !/^map_[0-9]+$/.test(requestedId)) fail(`id 格式非法（应形如 map_1），收到「${requestedId}」`)
  let existing = null
  if (requestedId !== null) existing = mappings.find((mapping) => mapping.id === requestedId) ?? null
  if (existing === null) {
    existing = mappings.find((mapping) => mapping.cc === cc && (mapping.channel ?? null) === channel) ?? null
  }
  // cc+channel 唯一（排除自身）
  const conflict = mappings.find((mapping) => mapping !== existing && mapping.cc === cc && (mapping.channel ?? null) === channel)
  if (conflict) fail(`CC${cc}（channel ${channel === null ? '任意' : channel}）已被映射 ${conflict.id} 使用`)
  let mapping
  if (existing) {
    mapping = {
      id: existing.id,
      cc,
      channel,
      target,
      trackId,
      ...(target === 'effectParam' ? { effectId, param } : {}),
      min,
      max,
    }
    project.midiMappings = mappings.map((item) => (item === existing ? mapping : item))
  } else {
    if (mappings.length >= MIDI_MAPPING_MAX) fail(`MIDI 映射已达上限 ${MIDI_MAPPING_MAX} 条；请先清除旧映射`)
    mapping = {
      id: requestedId ?? nextMidiMappingId(project),
      cc,
      channel,
      target,
      trackId,
      ...(target === 'effectParam' ? { effectId, param } : {}),
      min,
      max,
    }
    project.midiMappings = [...mappings, mapping]
  }
  return { mapping: { ...mapping }, count: project.midiMappings.length }
}

/**
 * studio_clear_midi_mapping：按 id 或 cc(+channel) 删除；幂等。
 * - id：删除该条；
 * - cc：删除该 cc 的映射；channel 提供时只删同 channel，否则删该 cc 的所有 channel。
 * @returns {{cleared:boolean, removed:number}}
 */
export function clearMidiMapping(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const hasId = typeof args.id === 'string' && args.id.trim() !== ''
  const hasCc = args.cc !== undefined && args.cc !== null
  if (!hasId && !hasCc) fail('需要 id 或 cc 之一来指定要清除的映射')
  const mappings = Array.isArray(project.midiMappings) ? project.midiMappings : []
  let removed = []
  if (hasId) {
    const id = args.id.trim()
    removed = mappings.filter((mapping) => mapping.id === id)
  } else {
    const cc = requireNumber(args.cc, 'cc', { min: 0, max: 127, integer: true })
    const hasChannel = args.channel !== undefined && args.channel !== null
    const channel = hasChannel ? requireNumber(args.channel, 'channel', { min: 0, max: 15, integer: true }) : null
    removed = mappings.filter((mapping) => mapping.cc === cc && (!hasChannel || (mapping.channel ?? null) === channel))
  }
  if (removed.length > 0) {
    const removeSet = new Set(removed)
    project.midiMappings = mappings.filter((mapping) => !removeSet.has(mapping))
  }
  return { cleared: removed.length > 0, removed: removed.length, ...(hasId ? { id: args.id.trim() } : { cc: Number(args.cc) }) }
}

/** studio_get_theory：只读返回音阶/级数/和弦/建议进行。 */
export function getTheory(project, args = {}) {
  const key = typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : (project.key ?? 'C')
  if (noteNameToPitchClass(key) === null) fail(`key 必须是合法音名（如 C / F# / Bb），收到「${key}」`)
  const scale = typeof args.scale === 'string' && args.scale.trim() !== '' ? args.scale.trim() : (project.scale ?? 'major')
  const scaleInfo = THEORY_SCALES[scale]
  if (!scaleInfo) fail(`scale 必须是 ${Object.keys(THEORY_SCALES).join(' / ')}，收到「${scale}」`)
  const chords = diatonicChords(key, scale)
  const progressions = SUGGESTED_PROGRESSIONS.map((progression) => ({
    id: progression.id,
    label: progression.label,
    romans: progression.romans,
    chords: progression.romans.map((roman) => {
      const parsed = parseRoman(roman, key, scale)
      return {
        roman,
        quality: parsed?.quality ?? 'major',
        pitches: parsed ? buildChord({ rootPitch: 12 * 5 + parsed.rootPitchClass, quality: parsed.quality }) : [],
      }
    }),
  }))
  return {
    key,
    scale,
    scaleLabel: scaleInfo.label,
    scaleNotes: scalePitches(key, scale),
    diatonicChords: chords,
    suggestedProgressions: progressions,
  }
}

/** 把生成音符写回 pattern（整段替换/追加；一次 mutate 内的纯步骤）。 */
function appendPatternNotes(project, patternId, generatedNotes, replaceExisting) {
  const pattern = project.patterns.find((item) => item.id === patternId)
  if (!pattern) fail(`找不到 patternId=${patternId}`)
  const baseNotes = replaceExisting ? [] : pattern.notes
  const notes = [...baseNotes, ...generatedNotes]
  if (notes.length > LIMITS.maxNotesPerPattern) {
    fail(`音符数 ${notes.length} 超过单 pattern 上限 ${LIMITS.maxNotesPerPattern}`)
  }
  const result = setNotes(project, { patternId, notes })
  return result
}

/** studio_write_chords：按进行写入和弦。 */
export function writeChords(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const patternId = requireString(args.patternId, 'patternId', { max: 64 })
  const pattern = project.patterns.find((item) => item.id === patternId)
  if (!pattern) fail(`找不到 patternId=${patternId}`)
  if (!Array.isArray(args.progression) || args.progression.length === 0) {
    fail('progression 必须是非空数组（罗马数字字符串或 {roman?,quality?,rootPitch?}）')
  }
  if (args.progression.length > LIMITS.maxPatterns + 64) fail('progression 过长')
  const startBeat = optionalNumber(args.startBeat, 'startBeat', { min: 0, max: LIMITS.maxBars * 16 }) ?? 0
  const beatsPerChord = optionalNumber(args.beatsPerChord, 'beatsPerChord', { min: 0.25, max: 32 }) ?? 4
  const octave = optionalNumber(args.octave, 'octave', { min: 0, max: 9, integer: true }) ?? 4
  const velocity = optionalNumber(args.velocity, 'velocity', { min: 0, max: 1 }) ?? 0.8
  const voicing = args.voicing === 'open' ? 'open' : args.voicing === 'close' || args.voicing === undefined ? 'close' : (() => { fail('voicing 必须是 close 或 open') })()
  const inversion = optionalNumber(args.inversion, 'inversion', { min: 0, max: 4, integer: true }) ?? 0
  const chords = args.progression.map((item) => resolveChordItem(project, item, { octave, voicing, inversion }))
  const dur = Math.max(0.05, Math.round(beatsPerChord * 0.95 * 1e6) / 1e6)
  const notes = []
  chords.forEach((chord, index) => {
    const chordStart = startBeat + index * beatsPerChord
    for (const pitch of chord.pitches) {
      notes.push({ pitch, start: Math.round(chordStart * 1e6) / 1e6, dur, vel: Math.round(velocity * 1000) / 1000 })
    }
  })
  const result = appendPatternNotes(project, patternId, notes, args.replaceExisting === true)
  return {
    patternId,
    chords: chords.map((chord, index) => ({
      ...(chord.roman ? { roman: chord.roman } : {}),
      quality: chord.quality,
      rootPitch: chord.rootPitch,
      pitches: chord.pitches,
      startBeat: Math.round((startBeat + index * beatsPerChord) * 1e6) / 1e6,
    })),
    noteCount: result.noteCount,
  }
}

/** studio_generate_arp：从和弦/进行生成琶音。 */
export function generateArp(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const patternId = requireString(args.patternId, 'patternId', { max: 64 })
  const pattern = project.patterns.find((item) => item.id === patternId)
  if (!pattern) fail(`找不到 patternId=${patternId}`)
  const arpPattern = typeof args.pattern === 'string' ? args.pattern : 'up'
  if (!['up', 'down', 'updown', 'random'].includes(arpPattern)) fail('pattern 必须是 up / down / updown / random')
  const rate = optionalNumber(args.rate, 'rate', { min: 0.03125, max: 4 }) ?? 0.25
  const beats = optionalNumber(args.beats, 'beats', { min: 0.25, max: 256 }) ?? 4
  const octaves = optionalNumber(args.octaves, 'octaves', { min: 1, max: 4, integer: true }) ?? 1
  const gate = optionalNumber(args.gate, 'gate', { min: 0.05, max: 1 }) ?? 0.9
  const velocity = optionalNumber(args.velocity, 'velocity', { min: 0, max: 1 }) ?? 0.75
  const seed = optionalNumber(args.seed, 'seed', { min: 0, max: 2 ** 31 }) ?? 1
  let generated
  let chordNotes
  if (Array.isArray(args.chordPitches) && args.chordPitches.length > 0) {
    const pitches = args.chordPitches.map((pitch) => {
      const value = Number(pitch)
      if (!Number.isFinite(value)) fail('chordPitches 必须是数字数组')
      return Math.max(0, Math.min(127, Math.round(value)))
    })
    generated = arpNotes({ chordPitches: pitches, pattern: arpPattern, rate, beats, octaves, gate, velocity, seed })
    chordNotes = [{ pitches }]
  } else if (Array.isArray(args.progression) && args.progression.length > 0) {
    const octave = optionalNumber(args.octave, 'octave', { min: 0, max: 9, integer: true }) ?? 4
    const voicing = args.voicing === 'open' ? 'open' : 'close'
    const inversion = optionalNumber(args.inversion, 'inversion', { min: 0, max: 4, integer: true }) ?? 0
    const chords = args.progression.map((item) => resolveChordItem(project, item, { octave, voicing, inversion }))
    const segmentBeats = beats / chords.length
    const buffer = []
    chords.forEach((chord, index) => {
      const segment = arpNotes({
        chordPitches: chord.pitches,
        pattern: arpPattern,
        rate,
        beats: segmentBeats,
        octaves,
        gate,
        velocity,
        seed: seed + index,
      })
      for (const note of segment) {
        const start = index * segmentBeats + note.start
        if (start < beats - 1e-9) buffer.push({ ...note, start: Math.round(start * 1e6) / 1e6 })
      }
    })
    generated = buffer
    chordNotes = chords.map((chord) => ({ pitches: chord.pitches }))
  } else {
    fail('需要 chordPitches 或 progression（至少一个）')
  }
  const result = appendPatternNotes(project, patternId, generated, args.replaceExisting === true)
  return { patternId, pattern: arpPattern, noteCount: result.noteCount, chords: chordNotes }
}

/** studio_apply_groove：先可选量化，再应用 groove 模板。 */
export function applyGrooveOp(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const patternId = requireString(args.patternId, 'patternId', { max: 64 })
  const pattern = project.patterns.find((item) => item.id === patternId)
  if (!pattern) fail(`找不到 patternId=${patternId}`)
  const template = typeof args.template === 'string' ? args.template : 'straight'
  if (!GROOVE_TEMPLATE_IDS.includes(template)) {
    fail(`未知 groove 模板「${template}」；可选：${GROOVE_TEMPLATE_IDS.join(' / ')}`)
  }
  const strength = optionalNumber(args.strength, 'strength', { min: 0, max: 1 }) ?? 1
  const quantizeGrid = args.quantizeGrid === undefined || args.quantizeGrid === null
    ? null
    : requireNumber(args.quantizeGrid, 'quantizeGrid', { min: 0.03125, max: 4 })
  const before = JSON.stringify(pattern.notes)
  let notes = pattern.notes.map((note) => ({ ...note }))
  if (quantizeGrid !== null) notes = quantizeNotes(notes, quantizeGrid, 1, 0)
  notes = applyGrooveNotes(notes, template, strength)
  const after = JSON.stringify(notes)
  setNotes(project, { patternId, notes })
  return {
    patternId,
    template,
    templateLabel: getGrooveTemplate(template).label,
    changed: before !== after,
    noteCount: notes.length,
  }
}

/**
 * studio_copy_pattern：复制 pattern（含全部音符）；不自动加 clip（一次撤销）。
 * @returns {{patternId:string, name:string, noteCount:number}}
 */
export function copyPattern(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const pattern = getPattern(project, args.patternId)
  if (project.patterns.length >= LIMITS.maxPatterns) fail(`pattern 数量已达上限 ${LIMITS.maxPatterns}`)
  const name = optionalString(args.name, 'name', { max: MAX_PATTERN_NAME }) ?? `${pattern.name} 副本`
  const nextId = makeIdGen(project)
  const copy = makePattern({
    id: nextId('pat'),
    name,
    lengthBars: pattern.lengthBars,
    notes: (pattern.notes ?? []).map((note) => ({ ...note })),
  })
  project.patterns.push(copy)
  return { patternId: copy.id, name: copy.name, noteCount: copy.notes.length }
}

/* ------------------------------------------------------------------------- */
/* P10：工程自检（只读，不修改工程/revision）                                  */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* R0-09：混音 lint（includeMix；只读，不渲染/不下载文件）                       */
/* ------------------------------------------------------------------------- */

/** 低频乐器 preset（静态低频占比估算用）。 */
const LOW_PRESETS = new Set(['acoustic_bass', 'finger_bass'])
/** master 上可降低削波风险的 effect 类型。 */
const CLIP_SAFE_FX = new Set(['compressor', 'limiter'])

/** 每轨的估计算法：音量 × 平均力度（无音符时 0.8）；鼓机略提。 */
function mixTrackSignal(track, project) {
  let totalVel = 0
  let noteCount = 0
  for (const clip of project.clips) {
    if (clip.trackId !== track.id || typeof clip.patternId !== 'string') continue
    const pattern = project.patterns.find((item) => item.id === clip.patternId)
    for (const note of pattern?.notes ?? []) {
      totalVel += Number(note.vel)
      noteCount += 1
    }
  }
  const meanVel = noteCount > 0 ? totalVel / noteCount : 0.8
  const volume = Math.min(1, Math.max(0, Number(track.volume) || 0))
  const kindBoost = track.kind === 'drum' ? 1.12 : 1
  return Math.max(1e-6, volume * Math.min(1, Math.max(0.05, meanVel)) * kindBoost)
}

/** 估计算法下每轨 dB（只用于同工程内相对比较）。 */
function mixTrackDb(track, project) {
  return 20 * Math.log10(mixTrackSignal(track, project))
}

/** 分析结果的 stems 归一化为 [{trackId, rmsDb, peakDb}]（数组或对象都兼容）。 */
function mixAnalysisStems(analysis) {
  const raw = analysis?.stems
  const out = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isObject(entry)) continue
      const trackId = typeof entry.trackId === 'string' ? entry.trackId : (typeof entry.id === 'string' ? entry.id : null)
      if (!trackId) continue
      out.push({
        trackId,
        rmsDb: Number.isFinite(Number(entry.rmsDb)) ? Number(entry.rmsDb) : null,
        peakDb: Number.isFinite(Number(entry.peakDb)) ? Number(entry.peakDb) : null,
      })
    }
  } else if (isObject(raw)) {
    for (const [trackId, entry] of Object.entries(raw)) {
      if (!isObject(entry)) continue
      out.push({
        trackId,
        rmsDb: Number.isFinite(Number(entry.rmsDb)) ? Number(entry.rmsDb) : null,
        peakDb: Number.isFinite(Number(entry.peakDb)) ? Number(entry.peakDb) : null,
      })
    }
  }
  return out
}

/**
 * 混音 lint（R0-09）：静态估算 + 可选 preview analysis（真实音频指标）。
 * issue 形状：{level, severity, code, message, suggestion, trackId?, value?}
 * @param {object} project
 * @param {object|null} analysis studio_render_preview 的 analysis（可含 stems/lufs/stereoBalanceDb/bandEnergyPct/correlation/clipping）
 * @returns {{issues:Array, mode:'analysis'|'static'|'analysis-partial', stats:object}}
 */
export function buildMixLint(project, analysis = null) {
  const issues = []
  const add = (severity, code, message, options = {}) => {
    issues.push({
      level: severity,
      severity,
      code,
      message,
      ...(options.trackId ? { trackId: options.trackId } : {}),
      ...(options.suggestion ? { suggestion: options.suggestion } : {}),
      ...(options.value !== undefined ? { value: options.value } : {}),
    })
  }
  const mixAnalysis = isObject(analysis) ? analysis : null
  const stems = mixAnalysis ? mixAnalysisStems(mixAnalysis) : []
  const hasRealAudio = Boolean(mixAnalysis)
  const anySolo = project.tracks.some((track) => track.solo === true)
  const audible = project.tracks.filter((track) => {
    if (track.mute === true) return false
    if (!(Number(track.volume) > 0.0001)) return false
    if (anySolo && track.solo !== true) return false
    return true
  })

  // 1) 轨道响度差（真实 stems 优先；否则静态估算）
  const trackDb = new Map()
  for (const track of audible) trackDb.set(track.id, mixTrackDb(track, project))
  const realStems = stems.filter((entry) => entry.rmsDb !== null && trackDb.has(entry.trackId))
  if (realStems.length >= 2) {
    const sorted = [...realStems].sort((a, b) => b.rmsDb - a.rmsDb)
    const median = sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2].rmsDb
      : (sorted[sorted.length / 2 - 1].rmsDb + sorted[sorted.length / 2].rmsDb) / 2
    for (const entry of realStems) {
      const gap = median - entry.rmsDb
      if (gap > 20) {
        const track = project.tracks.find((item) => item.id === entry.trackId)
        add('warn', 'mix_track_too_quiet', `轨道「${track?.name ?? entry.trackId}」RMS 比中位数低 ${Math.round(gap)}dB（中位 ${round(median, 1)}dBFS）`, {
          trackId: entry.trackId,
          value: round(entry.rmsDb, 1),
          suggestion: '提升该轨音量/力度，或加压缩/饱和让它在 mix 里可闻；参考 R0-10 preset 响度基线',
        })
      }
    }
  } else if (trackDb.size >= 3) {
    const values = [...trackDb.values()].sort((a, b) => a - b)
    const median = values[Math.floor(values.length / 2)]
    for (const [trackId, db] of trackDb.entries()) {
      const gap = median - db
      if (gap > 20) {
        const track = project.tracks.find((item) => item.id === trackId)
        add('warn', 'mix_track_too_quiet', `轨道「${track?.name ?? trackId}」估算响度比中位数低约 ${Math.round(gap)}dB（音量/力度偏低）`, {
          trackId,
          value: round(db, 1),
          suggestion: '提升该轨 volume 或音符力度；若为铺底/点缀可忽略，但独奏时容易被埋',
        })
      }
    }
  }

  // 2) 低频过量（<250Hz 占比 >80%；优先真实频段分析）
  const bands = isObject(mixAnalysis?.bandEnergyPct) ? mixAnalysis.bandEnergyPct : null
  let lowShare = null
  if (bands) {
    const sub = Number(bands.sub)
    const low = Number(bands.low)
    if (Number.isFinite(sub) || Number.isFinite(low)) {
      lowShare = (Number.isFinite(sub) ? sub : 0) + (Number.isFinite(low) ? low : 0)
      if (lowShare > 80) {
        add('warn', 'mix_low_excess', `低频（<250Hz）能量占比 ${Math.round(lowShare)}% > 80%，Drop/主段容易浑浊`, {
          value: round(lowShare, 1),
          suggestion: '给贝斯/底鼓加高通（filter cutoff 30–60Hz 以上）、降低低频轨或 EQ3 low，留空间给中高频',
        })
      }
    }
  } else if (audible.length > 0) {
    let lowWeight = 0
    let totalWeight = 0
    for (const track of audible) {
      const signal = mixTrackSignal(track, project)
      totalWeight += signal
      const preset = track.instrument?.preset
      const kit = track.instrument?.kit
      let weight = 0.15
      if (LOW_PRESETS.has(preset)) weight = 1
      else if (track.kind === 'drum' && kit) weight = 0.65
      const eqLow = (track.effects ?? []).find((fx) => fx.type === 'eq3')?.params?.low
      if (Number.isFinite(Number(eqLow)) && Number(eqLow) > 0.7) weight = Math.max(weight, 0.8)
      lowWeight += signal * weight
    }
    lowShare = totalWeight > 0 ? (lowWeight / totalWeight) * 100 : 0
    if (lowShare > 80) {
      add('warn', 'mix_low_excess', `估算低频能量占比约 ${Math.round(lowShare)}%（>80%）：低频乐器过多或 EQ3 low 过强`, {
        value: round(lowShare, 1),
        suggestion: '减少贝斯/底鼓重叠或降低 EQ3 low；加高通/高频 pad 平衡；可用 render_preview includeStems 看真实分配',
      })
    }
  }

  // 3) L/R 平衡（真实 stereoBalanceDb 优先；否则按 pan × 估算响度加权）
  let stereoBalanceDb = null
  const realBalance = Number(mixAnalysis?.stereoBalanceDb)
  if (Number.isFinite(realBalance)) {
    stereoBalanceDb = realBalance
    if (Math.abs(stereoBalanceDb) > 3) {
      add('warn', 'mix_stereo_imbalance', `立体声平衡 ${stereoBalanceDb > 0 ? '偏右' : '偏左'} ${Math.abs(stereoBalanceDb).toFixed(1)}dB（>3dB）`, {
        value: round(stereoBalanceDb, 2),
        suggestion: '调整 pan/立体声宽度：把偏重侧元素稍拉回中间，或给另一侧补 pad/延迟',
      })
    }
  } else if (audible.length > 0) {
    let weighted = 0
    let total = 0
    for (const track of audible) {
      const signal = mixTrackSignal(track, project)
      weighted += signal * Math.max(-1, Math.min(1, Number(track.pan) || 0))
      total += signal
    }
    const balance = total > 0 ? weighted / total : 0
    if (Math.abs(balance) > 0.99) stereoBalanceDb = balance > 0 ? 40 : -40
    else if (balance !== 0) stereoBalanceDb = 20 * Math.log10((1 + balance) / (1 - balance))
    if (stereoBalanceDb !== null && Math.abs(stereoBalanceDb) > 3) {
      add('warn', 'mix_stereo_imbalance', `估算声像明显偏${stereoBalanceDb > 0 ? '右' : '左'}（约 ${Math.abs(stereoBalanceDb).toFixed(1)}dB）`, {
        value: round(stereoBalanceDb, 2),
        suggestion: '把整体 pan 往中间拉，或在对侧补一条轨道；独奏/参考曲对比检查',
      })
    }
  }

  // 4) 削波 / 峰值 / LUFS（analysis 优先；静态只给风险提示）
  if (mixAnalysis?.clipping === true) {
    add('error', 'mix_clipping', '预览分析检测到削波（clipping=true），成品会失真', {
      suggestion: '降低 master/track 音量或加 compressor/限制器；重新 render_preview 确认 clipping=false',
    })
  } else {
    const peakDb = Number(mixAnalysis?.peakDb ?? (Number.isFinite(Number(mixAnalysis?.peak)) ? 20 * Math.log10(Number(mixAnalysis.peak)) : NaN))
    if (Number.isFinite(peakDb) && peakDb > -0.1) {
      add('warn', 'mix_peak_hot', `预览峰值 ${peakDb.toFixed(2)}dBFS 接近 0dB，导出/编码可能削波`, {
        value: round(peakDb, 2),
        suggestion: '总增益留 -1dB 余量（master volume 下调或加限制器）',
      })
    } else if (!mixAnalysis) {
      const masterFx = (project.master?.effects ?? []).map((fx) => fx.type)
      const hasClipSafe = masterFx.some((type) => CLIP_SAFE_FX.has(type))
      const masterVolume = Number(project.master?.volume ?? 1)
      const loudTracks = audible.filter((track) => mixTrackSignal(track, project) > 0.75).length
      if (!hasClipSafe && (masterVolume >= 0.99 || loudTracks >= 4) && audible.length > 0) {
        add('warn', 'mix_clipping_risk', '估算存在削波风险：master 无压缩/限制器且高电平轨较多', {
          suggestion: '给 master 加 compressor（或降低 master volume 到 0.9 左右），再用 render_preview 检查 peak/clipping',
        })
      }
    }
  }
  const lufs = Number(mixAnalysis?.lufs)
  if (Number.isFinite(lufs)) {
    if (lufs > -9) {
      add('warn', 'mix_loudness', `积分响度 ${lufs.toFixed(1)} LUFS 偏响（> -9），动态可能被压扁/平台响度受限`, {
        value: round(lufs, 1),
        suggestion: '目标约 -14 LUFS（流媒体）；降低总增益或减少压缩，导出可用 targetLufs=-14',
      })
    } else if (lufs < -28) {
      add('info', 'mix_loudness', `积分响度 ${lufs.toFixed(1)} LUFS 偏轻（< -28），用户可能觉得小声`, {
        value: round(lufs, 1),
        suggestion: '提高 master 音量或加压缩/饱和；参考目标 -14 LUFS',
      })
    }
  }
  const correlation = Number(mixAnalysis?.correlation)
  if (Number.isFinite(correlation) && correlation < 0) {
    add('warn', 'mix_phase', `左右声道相关度 ${correlation.toFixed(2)} < 0，单声道兼容时可能相互抵消`, {
      value: round(correlation, 2),
      suggestion: '检查反相层/宽立体声效果；用 correlation 接近 +1 的素材重测',
    })
  }

  // 5) 静音 / solo 状态
  const mutedWithContent = project.tracks.filter((track) => {
    if (track.mute !== true) return false
    const hasClip = project.clips.some((clip) => clip.trackId === track.id)
    const hasNotes = project.clips.some((clip) => {
      if (clip.trackId !== track.id || typeof clip.patternId !== 'string') return false
      const pattern = project.patterns.find((item) => item.id === clip.patternId)
      return (pattern?.notes?.length ?? 0) > 0
    })
    return hasClip || hasNotes
  })
  for (const track of mutedWithContent) {
    add('warn', 'mix_muted_track', `轨道「${track.name ?? track.id}」有内容但被静音，导出/预览不会发声`, {
      trackId: track.id,
      suggestion: '确认是否有意静音；A/B 对比时可用 solo 代替静音，检查完记得恢复',
    })
  }
  const soloTracks = project.tracks.filter((track) => track.solo === true)
  if (soloTracks.length > 0) {
    add('info', 'mix_solo_active', `当前 ${soloTracks.length} 条轨道 solo：预览/导出通常只包含 solo 轨`, {
      suggestion: '确认 solo 状态符合预期；导出成品前用 get_project 检查 solo/mute',
    })
  }

  const stats = {
    audibleTracks: audible.length,
    mutedTracks: project.tracks.filter((track) => track.mute === true).length,
    soloTracks: soloTracks.length,
    ...(trackDb.size > 0
      ? {
          trackDbRange: (() => {
            const values = [...trackDb.values()]
            return round(Math.max(...values) - Math.min(...values), 1)
          })(),
        }
      : {}),
    ...(lowShare !== null ? { lowSharePct: round(lowShare, 1) } : {}),
    ...(stereoBalanceDb !== null ? { stereoBalanceDb: round(stereoBalanceDb, 2) } : {}),
    ...(Number.isFinite(lufs) ? { lufs: round(lufs, 2) } : {}),
  }
  return {
    issues,
    mode: hasRealAudio ? (realStems.length > 0 ? 'analysis' : 'analysis-partial') : 'static',
    stats,
  }
}

/* ------------------------------------------------------------------------- */
/* R1a：工程 doctor（只读检查 + 可选安全修复；不删除有内容的轨道/pattern）      */
/* ------------------------------------------------------------------------- */

/**
 * studio_doctor_project：深度自检工程（schema/引用/音符/媒体/效果器/自动化/
 * tempo/sustain/sidechain/master/clip 越界），可选安全修复。
 * @param {object} project state.mutate draft（repair=true 时会被原地修复）
 * @param {{repair?:boolean}} [options]
 * @returns {{issues:object[], counts:object, summary:object, repaired?:object}}
 */
export function doctorProject(project, options = {}) {
  const repair = options?.repair === true
  const scan = (target, allowFixes) => {
    const issues = []
    const fixes = []
    const add = (level, code, message, extra = {}) => {
      const issue = { level, code, message, ...extra, canRepair: false }
      issues.push(issue)
      return issue
    }
    const addFixable = (level, code, message, extra, apply, changeText) => {
      const issue = add(level, code, message, extra)
      issue.canRepair = true
      if (allowFixes) fixes.push({ issue, apply, changeText: changeText ?? message })
      return issue
    }
    const barBeats = Math.max(1, beatsPerBar(target))
    const lengthBars = Math.max(1, Number(target.lengthBars) || 32)
    const lengthBeats = lengthBars * barBeats
    const maxBeat = (LIMITS.maxBars) * barBeats
    const uniqueId = (prefix, existing) => {
      let index = existing.size + 1
      for (;;) {
        const candidate = `${prefix}_${index}`
        if (!existing.has(candidate)) return candidate
        index += 1
      }
    }

    // schema / revision / 基本字段
    const schemaVersion = Number(target.schemaVersion)
    if (schemaVersion !== SCHEMA_VERSION && schemaVersion === 2) {
      addFixable('info', 'doctor.schema_migration', 'schemaVersion=2（R1b 可一次性迁移到 3）', { path: 'schemaVersion' },
        () => {
          target.schemaVersion = SCHEMA_VERSION
          target.format = { name: 'aims', version: SCHEMA_VERSION, migratedFrom: 2, migratedAt: Date.now() }
        }, 'schemaVersion → 3（v2 迁移）')
    } else if (schemaVersion !== SCHEMA_VERSION) {
      add('error', 'doctor.schema_version', `schemaVersion=${target.schemaVersion ?? '未知'} 不受支持（仅支持 3，v2 可迁移，v1 不兼容）`, { path: 'schemaVersion' })
    }
    if (!Number.isInteger(Number(target.revision)) || Number(target.revision) < 1) {
      addFixable('error', 'doctor.revision', `revision 非法（${JSON.stringify(target.revision)}）`, { path: 'revision' },
        () => { target.revision = Math.max(1, Number(target.revision) || 1) }, 'revision 修正为 ≥1')
    }
    if (!Number.isFinite(Number(target.lengthBars)) || Number(target.lengthBars) < 1 || Number(target.lengthBars) > LIMITS.maxBars) {
      addFixable('error', 'doctor.length_bars', `lengthBars 非法（${JSON.stringify(target.lengthBars)}）`, { path: 'lengthBars' },
        () => { target.lengthBars = Math.min(LIMITS.maxBars, Math.max(1, Math.round(Number(target.lengthBars) || 1))) }, 'lengthBars 夹紧到 1..256')
    }
    if (!Array.isArray(target.tracks)) {
      addFixable('error', 'doctor.tracks', 'tracks 不是数组', { path: 'tracks' }, () => { target.tracks = [] }, 'tracks 重置为 []')
    }

    // tracks：id 重复/kind/preset/kit/effects/参数
    const trackIds = new Set()
    const duplicateTracks = new Set()
    for (const [index, track] of (Array.isArray(target.tracks) ? target.tracks : []).entries()) {
      if (!isObject(track)) {
        addFixable('error', 'doctor.track_entry', `tracks[${index}] 不是对象`, { path: `tracks[${index}]` }, () => {
          target.tracks[index] = makeTrack({ id: uniqueId('trk', trackIds), name: '修复轨道', preset: 'grand_piano' })
        }, '非法轨道替换为默认静音轨')
        continue
      }
      const trackId = typeof track.id === 'string' && track.id !== '' ? track.id : null
      if (!trackId) {
        addFixable('error', 'doctor.track_id', `tracks[${index}] 缺少 id`, { path: `tracks[${index}]` }, () => {
          track.id = uniqueId('trk', trackIds)
          trackIds.add(track.id)
        }, '补齐轨道 id')
      } else if (trackIds.has(trackId)) {
        duplicateTracks.add(trackId)
        addFixable('error', 'doctor.track_duplicate', `轨道 id 重复：${trackId}`, { trackId, path: `tracks.${trackId}` }, () => {
          const replacement = uniqueId('trk', trackIds)
          trackIds.add(replacement)
          track.id = replacement
        }, `重复轨道 ${trackId} 改为唯一 id`)
      } else {
        trackIds.add(trackId)
      }
      if (!['synth', 'drum', 'audio'].includes(track.kind)) {
        addFixable('error', 'doctor.track_kind', `轨道 ${track.id} kind 非法（${String(track.kind)}）`, { trackId: track.id, path: `tracks.${track.id}` }, () => { track.kind = 'synth' }, 'kind 修正为 synth')
      }
      // v2.1：subtractive 轨不使用采样器 preset（instrument.preset=null 合法），跳过采样 preset 校验。
      if (track.kind === 'synth' && track.engine !== 'subtractive' && track.engine !== 'vst3' && !SYNTH_PRESETS.some((preset) => preset.id === track.instrument?.preset)) {
        addFixable('error', 'doctor.track_preset', `轨道 ${track.id} 未知采样乐器 ${String(track.instrument?.preset)}`, { trackId: track.id, path: `tracks.${track.id}.instrument` }, () => {
          track.instrument = { preset: 'grand_piano' }
          track.kind = 'synth'
        }, '未知 preset 回退 grand_piano')
      }
      if (track.kind === 'drum' && !DRUM_KITS.some((kit) => kit.id === track.instrument?.kit)) {
        addFixable('error', 'doctor.track_kit', `轨道 ${track.id} 未知采样鼓机 ${String(track.instrument?.kit)}`, { trackId: track.id, path: `tracks.${track.id}.instrument` }, () => {
          track.instrument = { kit: 'smp_acoustic' }
          track.kind = 'drum'
        }, '未知 kit 回退 smp_acoustic')
      }
      if (!(Number(track.volume) >= 0 && Number(track.volume) <= 1)) {
        addFixable('warn', 'doctor.track_volume', `轨道 ${track.id} 音量越界（${JSON.stringify(track.volume)}）`, { trackId: track.id, path: `tracks.${track.id}.volume` }, () => { track.volume = clamp01(Number(track.volume) || 0) }, '音量夹紧 0..1')
      }
      if (!(Number(track.pan) >= -1 && Number(track.pan) <= 1)) {
        addFixable('warn', 'doctor.track_pan', `轨道 ${track.id} 声像越界（${JSON.stringify(track.pan)}）`, { trackId: track.id, path: `tracks.${track.id}.pan` }, () => { track.pan = clampPan(Number(track.pan) || 0) }, '声像夹紧 -1..1')
      }
    }

    // patterns：id 重复 / 音符
    if (!Array.isArray(target.patterns)) {
      addFixable('error', 'doctor.patterns', 'patterns 不是数组', { path: 'patterns' }, () => { target.patterns = [] }, 'patterns 重置为 []')
    }
    const patternIds = new Set()
    let emptyPatterns = 0
    for (const [patternIndex, pattern] of (Array.isArray(target.patterns) ? target.patterns : []).entries()) {
      if (!isObject(pattern)) {
        addFixable('error', 'doctor.pattern_entry', `patterns[${patternIndex}] 不是对象`, { path: `patterns[${patternIndex}]` }, () => {
          target.patterns[patternIndex] = makePattern({ id: uniqueId('pat', patternIds), name: '修复 pattern', lengthBars: 4 })
        }, '非法 pattern 替换')
        continue
      }
      const patternId = typeof pattern.id === 'string' && pattern.id !== '' ? pattern.id : null
      if (!patternId) {
        addFixable('error', 'doctor.pattern_id', `patterns[${patternIndex}] 缺少 id`, { path: `patterns[${patternIndex}]` }, () => { pattern.id = uniqueId('pat', patternIds) }, '补齐 pattern id')
      } else if (patternIds.has(patternId)) {
        addFixable('error', 'doctor.pattern_duplicate', `pattern id 重复：${patternId}`, { path: `patterns.${patternId}` }, () => { pattern.id = uniqueId('pat', patternIds) }, '重复 pattern 改为唯一 id')
      } else {
        patternIds.add(patternId)
      }
      if (!Array.isArray(pattern.notes)) {
        addFixable('error', 'doctor.pattern_notes', `pattern ${pattern.id} notes 不是数组`, { path: `patterns.${pattern.id}.notes` }, () => { pattern.notes = [] }, 'notes 重置为 []')
        continue
      }
      if (pattern.notes.length === 0) emptyPatterns += 1
      const patternBeats = Math.max(1, Number(pattern.lengthBars) || 4) * barBeats
      const nextNotes = []
      for (const [noteIndex, note] of pattern.notes.entries()) {
        if (!isObject(note)) {
          addFixable('warn', 'doctor.note_entry', `pattern ${pattern.id} notes[${noteIndex}]（0 基）音符非法`, { path: `patterns.${pattern.id}.notes[${noteIndex}]` }, () => { /* 由 rebuild 删除 */ }, '删除非法音符')
          continue
        }
        let pitch = Number(note.pitch)
        let start = Number(note.start)
        let dur = Number(note.dur)
        let changed = false
        if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) {
          pitch = Math.min(127, Math.max(0, Math.round(Number.isFinite(pitch) ? pitch : 60)))
          changed = true
          addFixable('warn', 'doctor.note_pitch', `pattern ${pattern.id} notes[${noteIndex}]（0 基）音符 pitch 非法`, { path: `patterns.${pattern.id}.notes[${noteIndex}].pitch` }, () => {}, 'pitch 夹紧 0..127')
        }
        if (!Number.isFinite(start) || start < 0) {
          start = Math.max(0, Number.isFinite(start) ? start : 0)
          changed = true
          addFixable('warn', 'doctor.note_start', `pattern ${pattern.id} notes[${noteIndex}]（0 基）音符 start 非法`, { path: `patterns.${pattern.id}.notes[${noteIndex}].start` }, () => {}, 'start 夹紧 ≥0')
        }
        if (!Number.isFinite(dur) || dur <= 0) {
          dur = 0.25
          changed = true
          addFixable('warn', 'doctor.note_dur', `pattern ${pattern.id} notes[${noteIndex}]（0 基）音符 dur 非法`, { path: `patterns.${pattern.id}.notes[${noteIndex}].dur` }, () => {}, 'dur 修正为 0.25')
        }
        if (start >= patternBeats) {
          addFixable('warn', 'doctor.note_overflow', `pattern ${pattern.id} notes[${noteIndex}]（0 基）音符起点超出 pattern 长度`, { path: `patterns.${pattern.id}.notes[${noteIndex}]` }, () => {}, '删除起点越界音符')
          continue
        }
        if (start + dur > patternBeats) {
          dur = Math.max(0.0625, patternBeats - start)
          changed = true
          addFixable('warn', 'doctor.note_overflow', `pattern ${pattern.id} notes[${noteIndex}]（0 基）音符尾部越界（裁剪）`, { path: `patterns.${pattern.id}.notes[${noteIndex}].dur` }, () => {}, '裁剪越界音符时值')
        }
        nextNotes.push({ pitch, start, dur, vel: clamp01(Number.isFinite(Number(note.vel)) ? Number(note.vel) : 0.8) })
        void changed
      }
      if (allowFixes && nextNotes.length !== pattern.notes.length) {
        pattern.notes = nextNotes
      } else if (allowFixes) {
        pattern.notes = nextNotes
      }
    }

    // media
    if (!Array.isArray(target.media)) {
      addFixable('warn', 'doctor.media', 'media 不是数组', { path: 'media' }, () => { target.media = [] }, 'media 重置为 []')
    }
    const mediaIds = new Set()
    for (const [mediaIndex, media] of (Array.isArray(target.media) ? target.media : []).entries()) {
      if (!isObject(media) || typeof media.id !== 'string' || media.id === '' || typeof media.file !== 'string' || media.file === '') {
        addFixable('error', 'doctor.media_entry', `media[${mediaIndex}] 非法（缺 id/file）`, { path: `media[${mediaIndex}]` }, () => {
          target._dropMedia = [...(target._dropMedia ?? []), mediaIndex]
        }, '删除非法媒体条目')
        continue
      }
      mediaIds.add(media.id)
    }

    // clips
    if (!Array.isArray(target.clips)) {
      addFixable('error', 'doctor.clips', 'clips 不是数组', { path: 'clips' }, () => { target.clips = [] }, 'clips 重置为 []')
    }
    const keepClips = []
    for (const [clipIndex, clip] of (Array.isArray(target.clips) ? target.clips : []).entries()) {
      if (!isObject(clip)) {
        addFixable('error', 'doctor.clip_entry', `clips[${clipIndex}] 不是对象`, { path: `clips[${clipIndex}]` }, () => {}, '删除非法 clip')
        continue
      }
      const track = (target.tracks ?? []).find((item) => item.id === clip.trackId)
      const trackId = typeof clip.trackId === 'string' ? clip.trackId : null
      let invalid = false
      if (!track || !trackId) {
        invalid = true
        addFixable('error', 'doctor.clip_track', `clip 引用的轨道 ${String(clip.trackId)} 不存在`, { path: `clips[${clipIndex}]` }, () => {}, '删除引用丢失的 clip')
      }
      const startBar = Number(clip.startBar)
      const lengthBarsClip = Number(clip.lengthBars)
      if (!Number.isFinite(startBar) || startBar < 0 || !Number.isFinite(lengthBarsClip) || lengthBarsClip < 1) {
        invalid = true
        addFixable('error', 'doctor.clip_bounds', `clip 起点/长度非法（startBar=${JSON.stringify(clip.startBar)}, lengthBars=${JSON.stringify(clip.lengthBars)}）`, { path: `clips[${clipIndex}]` }, () => {}, '删除越界 clip')
      }
      if (typeof clip.mediaId === 'string' && clip.mediaId !== '') {
        if (!mediaIds.has(clip.mediaId)) {
          invalid = true
          addFixable('error', 'doctor.clip_media', `clip 引用的媒体 ${clip.mediaId} 不存在`, { path: `clips[${clipIndex}]` }, () => {}, '删除媒体缺失的音频 clip（保留轨道）')
        }
        if (track && track.kind !== 'audio') {
          invalid = true
          addFixable('error', 'doctor.clip_media_track', `音频 clip 放在非音频轨 ${clip.trackId}`, { path: `clips[${clipIndex}]` }, () => {}, '删除放错轨道的音频 clip')
        }
      } else if (typeof clip.patternId === 'string' && clip.patternId !== '') {
        if (!patternIds.has(clip.patternId)) {
          invalid = true
          addFixable('error', 'doctor.clip_pattern', `clip 引用的 pattern ${clip.patternId} 不存在`, { path: `clips[${clipIndex}]` }, () => {}, '删除引用丢失的 clip')
        }
        if (track && track.kind === 'audio') {
          invalid = true
          addFixable('error', 'doctor.clip_pattern_track', `pattern clip 放在音频轨 ${clip.trackId}`, { path: `clips[${clipIndex}]` }, () => {}, '删除放错轨道的 pattern clip')
        }
      } else {
        invalid = true
        addFixable('error', 'doctor.clip_source', `clip 既无 patternId 也无 mediaId`, { path: `clips[${clipIndex}]` }, () => {}, '删除无来源 clip')
      }
      if (invalid) continue
      const endBar = startBar + lengthBarsClip
      if (endBar > Number(target.lengthBars || 32)) {
        addFixable('warn', 'doctor.clip_overrun', `clip 结束于第 ${round(endBar, 3)} 小节，超出曲长`, { path: `clips[${clipIndex}]` }, () => { target.lengthBars = Math.min(LIMITS.maxBars, Math.round(endBar)) }, '扩展曲长到 clip 结尾（≤256）')
      }
      keepClips.push(clip)
    }

    // effects / master / automation / tempo / sustain / sidechain / sections / buses（仅在 repair 时安全规范化）
    const effectCleanup = (chain, where, maxCount) => {
      if (!Array.isArray(chain)) return Array.isArray(chain) ? chain : []
      const seenTypes = new Set()
      const next = []
      for (const [fxIndex, fx] of chain.entries()) {
        const isVst3Effect = isObject(fx) && fx.type === 'vst3' && normalizeExternalPlugin(fx.vst3) !== null
        if (!isObject(fx) || (!isVst3Effect && !FX_TYPES.some((type) => type.id === fx.type))) {
          addFixable('warn', 'doctor.effect_invalid', `${where} 第 ${fxIndex} 个效果器类型非法`, { path: where }, () => {}, '删除非法效果器')
          continue
        }
        if (!isVst3Effect && seenTypes.has(fx.type)) {
          addFixable('warn', 'doctor.effect_duplicate', `${where} 重复效果器 ${fx.type}`, { path: where }, () => {}, '删除重复效果器')
          continue
        }
        if (!isVst3Effect) seenTypes.add(fx.type)
        next.push(fx)
      }
      if (next.length > maxCount) {
        addFixable('warn', 'doctor.effect_too_many', `${where} 效果器过多（${next.length} > ${maxCount}）`, { path: where }, () => {}, '截断到上限')
        next.length = maxCount
      }
      return next
    }
    for (const track of (target.tracks ?? [])) {
      if (!isObject(track)) continue
      const cleaned = effectCleanup(track.effects, `tracks.${track.id}.effects`, LIMITS.maxEffectsPerTrack)
      if (allowFixes) track.effects = cleaned
      if (isObject(track.automation)) {
        const automation = normalizeAutomation(track.automation, { maxBeat, allowed: Object.keys(AUTOMATION_PARAMS) })
        if (JSON.stringify(automation) !== JSON.stringify(track.automation)) {
          addFixable('warn', 'doctor.automation', `轨道 ${track.id} 自动化曲线非法/越界（将规范化）`, { trackId: track.id, path: `tracks.${track.id}.automation` }, () => {
            if (Object.keys(automation).length > 0) track.automation = automation
            else delete track.automation
          }, '规范化 automation')
        }
      }
      if (Object.hasOwn(track, 'sustain')) {
        const sustain = normalizeSustainPoints(track.sustain, { maxBeat })
        if (JSON.stringify(sustain) !== JSON.stringify(track.sustain)) {
          addFixable('warn', 'doctor.sustain', `轨道 ${track.id} 延音踏板点非法/越界`, { trackId: track.id, path: `tracks.${track.id}.sustain` }, () => {
            if (sustain.length > 0) track.sustain = sustain
            else delete track.sustain
          }, '规范化延音踏板')
        }
      }
      if (Object.hasOwn(track, 'vibrato')) {
        const vibrato = normalizeVibrato(track.vibrato)
        if (vibrato === null || JSON.stringify(vibrato) !== JSON.stringify(track.vibrato)) {
          addFixable('warn', 'doctor.vibrato', `轨道 ${track.id} 揉弦配置非法`, { trackId: track.id, path: `tracks.${track.id}.vibrato` }, () => {
            if (vibrato) track.vibrato = vibrato
            else delete track.vibrato
          }, '规范化揉弦')
        }
      }
      if (Object.hasOwn(track, 'sidechain')) {
        const sourceTrackId = track.sidechain?.sourceTrackId
        const sidechain = normalizeSidechain(track.sidechain, { trackIds })
        if (sidechain === null || JSON.stringify(sidechain) !== JSON.stringify(track.sidechain) || sourceTrackId === track.id) {
          addFixable('warn', 'doctor.sidechain', `轨道 ${track.id} 侧链配置非法（来源缺失/自引用/越界）`, { trackId: track.id, path: `tracks.${track.id}.sidechain` }, () => {
            if (sidechain && sidechain.sourceTrackId !== track.id) track.sidechain = sidechain
            else delete track.sidechain
          }, '规范化/删除非法侧链')
        }
      }
    }
    if (isObject(target.master)) {
      const cleanedMaster = effectCleanup(target.master.effects, 'master.effects', LIMITS.maxMasterEffects)
      if (allowFixes) target.master.effects = cleanedMaster
      if (Number(target.master.volume) < 0 || Number(target.master.volume) > 1) {
        addFixable('warn', 'doctor.master_volume', `master.volume 越界（${JSON.stringify(target.master.volume)}）`, { path: 'master.volume' }, () => { target.master.volume = clamp01(Number(target.master.volume) || 0) }, 'master 音量夹紧')
      }
      if (isObject(target.master.automation) && allowFixes) {
        const automation = normalizeAutomation(target.master.automation, { maxBeat, allowed: ['volume'] })
        if (JSON.stringify(automation) !== JSON.stringify(target.master.automation)) {
          addFixable('warn', 'doctor.master_automation', 'master 自动化曲线非法/越界', { path: 'master.automation' }, () => {
            if (Object.keys(automation).length > 0) target.master.automation = automation
            else delete target.master.automation
          }, '规范化 master automation')
        }
      }
    } else {
      addFixable('error', 'doctor.master', 'master 不是对象', { path: 'master' }, () => { target.master = createEmptyProject().master }, 'master 重置为默认')
    }
    if (Array.isArray(target.tempoMap)) {
      const normalizedTempo = normalizeTempoPoints(target.tempoMap, { baseBpm: target.bpm, maxBeat })
      if (JSON.stringify(normalizedTempo) !== JSON.stringify(target.tempoMap)) {
        addFixable('warn', 'doctor.tempo', '速度曲线点非法/越界/乱序', { path: 'tempoMap' }, () => {
          if (normalizedTempo.length > 0) target.tempoMap = normalizedTempo
          else delete target.tempoMap
        }, '规范化速度曲线')
      }
    }
    if (Array.isArray(target.sections)) {
      const nextSections = []
      for (const [sectionIndex, section] of target.sections.entries()) {
        if (!isObject(section) || typeof section.name !== 'string' || Number(section.startBar) < 0 || Number(section.lengthBars) < 1) {
          addFixable('warn', 'doctor.section', `sections[${sectionIndex}] 非法`, { path: `sections[${sectionIndex}]` }, () => {}, '删除非法 section')
          continue
        }
        nextSections.push(section)
      }
      if (nextSections.length > LIMITS.maxSections) {
        addFixable('warn', 'doctor.section_too_many', `sections 过多（${nextSections.length}）`, { path: 'sections' }, () => {}, '截断到上限')
        nextSections.length = LIMITS.maxSections
      }
      if (allowFixes) target.sections = nextSections
    } else if (target.sections !== undefined) {
      addFixable('error', 'doctor.sections', 'sections 不是数组', { path: 'sections' }, () => { target.sections = [] }, 'sections 重置为 []')
    }
    if (!isObject(target.buses)) {
      addFixable('warn', 'doctor.buses', 'buses 不是对象', { path: 'buses' }, () => { target.buses = normalizeBuses(target.buses) }, 'buses 重置为默认')
    } else if (allowFixes) {
      target.buses = normalizeBuses(target.buses)
    }
    // 媒体/片段清理（repair 时应用）
    if (allowFixes) {
      const dropMedia = new Set(target._dropMedia ?? [])
      if (dropMedia.size > 0) target.media = (target.media ?? []).filter((_, index) => !dropMedia.has(index))
      delete target._dropMedia
      const validTrackIds = new Set((target.tracks ?? []).filter(isObject).map((track) => track.id))
      const validPatternIds = new Set((target.patterns ?? []).filter(isObject).map((pattern) => pattern.id))
      const validMediaIds = new Set((target.media ?? []).filter(isObject).map((media) => media.id))
      target.clips = (target.clips ?? []).filter((clip) => {
        if (!isObject(clip) || !validTrackIds.has(clip.trackId)) return false
        const track = (target.tracks ?? []).find((item) => item.id === clip.trackId)
        if (!Number.isFinite(Number(clip.startBar)) || Number(clip.startBar) < 0 || !Number.isFinite(Number(clip.lengthBars)) || Number(clip.lengthBars) < 1) return false
        if (typeof clip.mediaId === 'string' && clip.mediaId !== '') {
          return validMediaIds.has(clip.mediaId) && track?.kind === 'audio'
        }
        if (typeof clip.patternId === 'string' && clip.patternId !== '') {
          return validPatternIds.has(clip.patternId) && track?.kind !== 'audio'
        }
        return false
      })
      if (typeof target.title !== 'string' || target.title.trim() === '') target.title = '未命名作品'
    }

    // counts/summary
    const summary = {
      errors: issues.filter((issue) => issue.level === 'error').length,
      warns: issues.filter((issue) => issue.level === 'warn').length,
      infos: issues.filter((issue) => issue.level === 'info').length,
      repairable: issues.filter((issue) => issue.canRepair).length,
    }
    return { issues, fixes, counts: summary }
  }

  const before = scan(project, repair)
  if (!repair) {
    return {
      ok: true,
      issues: before.issues,
      counts: before.counts,
      summary: { errors: before.counts.errors, warns: before.counts.warns, infos: before.counts.infos, repairable: before.counts.repairable },
    }
  }
  const changes = []
  for (const fix of before.fixes) {
    try {
      fix.apply()
      changes.push(fix.changeText)
    } catch (error) {
      changes.push(`修复失败：${fix.changeText}（${error?.message ?? error}）`)
    }
  }
  // 修复后再扫一次（不收集 fix），得到剩余 issue
  const after = scan(project, false)
  return {
    ok: true,
    issues: after.issues,
    counts: after.counts,
    summary: { errors: after.counts.errors, warns: after.counts.warns, infos: after.counts.infos, repairable: after.counts.repairable },
    repaired: {
      applied: changes.length,
      changes,
      before: { errors: before.counts.errors, warns: before.counts.warns, infos: before.counts.infos, repairable: before.counts.repairable },
      after: { errors: after.counts.errors, warns: after.counts.warns, infos: after.counts.infos, repairable: after.counts.repairable },
    },
  }
}

/**
 * studio_validate_project：检查工程常见问题，返回 issues/counts/summary。
 * @param {object} project
 * @param {{includeMix?:boolean, mixAnalysis?:object|null}} [options] R0-09：includeMix 追加混音 lint
 * @returns {{issues:object[], counts:object, summary:{errors:number,warns:number,infos:number}, mix?:object}}
 */
export function validateProject(project, options = {}) {
  const issues = []
  const add = (level, code, message, path) => {
    const issue = { level, code, message }
    if (path) issue.path = path
    issues.push(issue)
  }
  const barBeats = Math.max(1, beatsPerBar(project))
  const lengthBeats = Math.max(1, Number(project.lengthBars) || 32) * barBeats
  const trackById = new Map(project.tracks.map((track) => [track.id, track]))
  const patternById = new Map(project.patterns.map((pattern) => [pattern.id, pattern]))
  const mediaById = new Map((project.media ?? []).map((media) => [media.id, media]))
  const notesByTrack = new Map()
  const clipsByTrack = new Map()

  // ── 音符 / pattern ───────────────────────────────────────────────
  let emptyPatterns = 0
  let noteTotal = 0
  for (const pattern of project.patterns) {
    const notes = Array.isArray(pattern.notes) ? pattern.notes : []
    noteTotal += notes.length
    if (notes.length === 0) {
      emptyPatterns += 1
      add('warn', 'empty_pattern', `pattern ${pattern.id}「${pattern.name}」没有音符（循环时无声）`, `patterns.${pattern.id}`)
    }
    const patternBeats = Math.max(1, Number(pattern.lengthBars) || 4) * barBeats
    const seen = new Set()
    for (const [index, note] of notes.entries()) {
      const where = `patterns.${pattern.id}.notes[${index}]`
      if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
        add('error', 'note_pitch', `pattern ${pattern.id} 第 ${index} 个音符 pitch=${JSON.stringify(note.pitch)} 非法（0..127）`, where)
      }
      if (!Number.isFinite(Number(note.dur)) || Number(note.dur) <= 0) {
        add('error', 'note_dur', `pattern ${pattern.id} 第 ${index} 个音符 dur=${JSON.stringify(note.dur)} 必须 > 0`, where)
      }
      if (!Number.isFinite(Number(note.start)) || Number(note.start) < 0) {
        add('error', 'note_start', `pattern ${pattern.id} 第 ${index} 个音符 start=${JSON.stringify(note.start)} 必须 >= 0`, where)
      }
      const end = Number(note.start) + Number(note.dur)
      if (Number.isFinite(end) && end > patternBeats + 1e-6) {
        add('warn', 'note_overflow', `pattern ${pattern.id} 第 ${index} 个音符结束于 beat ${round(end, 3)}，超出 pattern 长度 ${patternBeats}（循环时会被截断）`, where)
      }
      const key = `${note.pitch}@${round(Number(note.start), 4)}`
      if (seen.has(key)) add('info', 'duplicate_note', `pattern ${pattern.id} 第 ${index} 个音符与前面的音符完全重叠（${key}）`, where)
      seen.add(key)
    }
  }
  if (project.patterns.length === 0 && project.tracks.length > 0) {
    add('info', 'no_patterns', '工程有轨道但没有任何 pattern；可以先 add_pattern + set_notes，或用 edit_notes 建 pattern', 'patterns')
  }

  // ── clips ────────────────────────────────────────────────────────
  for (const [index, clip] of project.clips.entries()) {
    const where = `clips[${index}]`
    const track = trackById.get(clip.trackId)
    if (!track) add('error', 'clip_track_missing', `clip ${clip.id ?? index} 引用的轨道 ${clip.trackId} 不存在`, where)
    if (typeof clip.mediaId === 'string' && clip.mediaId !== '') {
      if (!mediaById.has(clip.mediaId)) add('error', 'clip_media_missing', `音频片段 ${clip.id ?? index} 引用的媒体 ${clip.mediaId} 不存在`, where)
      if (track && track.kind !== 'audio') add('error', 'clip_media_track', `音频片段 ${clip.id ?? index} 放在非音频轨 ${clip.trackId} 上（不会发声）`, where)
    } else if (typeof clip.patternId === 'string' && clip.patternId !== '') {
      if (!patternById.has(clip.patternId)) add('error', 'clip_pattern_missing', `clip ${clip.id ?? index} 引用的 pattern ${clip.patternId} 不存在`, where)
      if (track && track.kind === 'audio') add('error', 'clip_pattern_audio_track', `pattern 片段 ${clip.id ?? index} 放在音频轨 ${clip.trackId} 上（音频轨不能编排 pattern）`, where)
    } else {
      add('error', 'clip_no_source', `clip ${clip.id ?? index} 既没有 patternId 也没有 mediaId`, where)
    }
    const startBar = Number(clip.startBar)
    const lengthBars = Number(clip.lengthBars)
    if (!Number.isFinite(startBar) || startBar < 0) add('error', 'clip_start', `clip ${clip.id ?? index} startBar 非法（${JSON.stringify(clip.startBar)}）`, where)
    if (!Number.isFinite(lengthBars) || lengthBars < 1) add('error', 'clip_length', `clip ${clip.id ?? index} lengthBars 非法（${JSON.stringify(clip.lengthBars)}）`, where)
    if (Number.isFinite(startBar) && Number.isFinite(lengthBars)) {
      const endBar = startBar + lengthBars
      if (endBar > (Number(project.lengthBars) || 32)) {
        add('warn', 'clip_overrun', `clip ${clip.id ?? index} 结束于第 ${round(endBar, 3)} 小节，超出曲长 ${project.lengthBars}（结尾不会被播放/导出）`, where)
      }
      const key = clip.trackId
      if (!clipsByTrack.has(key)) clipsByTrack.set(key, [])
      clipsByTrack.get(key).push(index)
    }
  }

  // ── 轨道 ─────────────────────────────────────────────────────────
  let mutedTracks = 0
  let emptyTracks = 0
  let duplicateFx = 0
  for (const track of project.tracks) {
    const where = `tracks.${track.id}`
    if (Boolean(track.mute) || Number(track.volume) === 0) {
      mutedTracks += 1
      add('warn', 'muted_track', `轨道 ${track.id}「${track.name}」被静音或音量为 0（播放时无声）`, where)
    }
    const trackClips = clipsByTrack.get(track.id) ?? []
    const hasNotes = project.patterns.some((pattern) => (pattern.notes ?? []).length > 0)
    const usedPattern = trackClips.some((clipIndex) => {
      const clip = project.clips[clipIndex]
      return typeof clip?.patternId === 'string' && (patternById.get(clip.patternId)?.notes?.length ?? 0) > 0
    })
    if (trackClips.length === 0 && track.kind !== 'audio' && !usedPattern) {
      emptyTracks += 1
      add('warn', 'empty_track', `轨道 ${track.id}「${track.name}」没有任何片段或音符（占位轨）`, where)
    }
    if (hasNotes && track.kind === 'audio' && trackClips.length === 0) {
      add('info', 'unused_audio_track', `音频轨 ${track.id}「${track.name}」没有片段`, where)
    }
    if (track.kind === 'audio') {
      for (const clipIndex of trackClips) {
        const clip = project.clips[clipIndex]
        if (typeof clip.mediaId === 'string' && !mediaById.has(clip.mediaId)) {
          add('error', 'audio_track_media_missing', `音频轨 ${track.id} 的片段引用了不存在的媒体 ${clip.mediaId}`, `tracks.${track.id}.clips[${clipIndex}]`)
        }
      }
    }
    if (Array.isArray(track.automation)) {
      // 异常数据防御：automation 若为数组则跳过
    }
  }
  for (const track of project.tracks) {
    // automation 点越界 / master 音量一致性
    const automation = track.automation
    if (isObject(automation)) {
      for (const [param, curve] of Object.entries(automation)) {
        const points = Array.isArray(curve?.points) ? curve.points : []
        for (const [index, point] of points.entries()) {
          const beat = Number(point?.beat)
          if (!Number.isFinite(beat) || beat < 0 || beat > lengthBeats + 1e-6) {
            add('warn', 'automation_point', `轨道 ${track.id} 的自动化 ${param} 第 ${index} 个点 beat=${JSON.stringify(point?.beat)} 超出曲长（0..${round(lengthBeats, 3)}）`, `tracks.${track.id}.automation.${param}.points[${index}]`)
          }
          if (!Number.isFinite(Number(point?.value))) {
            add('warn', 'automation_value', `轨道 ${track.id} 的自动化 ${param} 第 ${index} 个点 value 非法`, `tracks.${track.id}.automation.${param}.points[${index}]`)
          }
        }
      }
    }
    if (isObject(track.sidechain) && track.sidechain.sourceTrackId && !trackById.has(track.sidechain.sourceTrackId)) {
      add('warn', 'sidechain_source_missing', `轨道 ${track.id} 的侧链来源 ${track.sidechain.sourceTrackId} 不存在（不会触发 ducking）`, `tracks.${track.id}.sidechain`)
    }
    // 重复效果器
    const fxTypes = new Map()
    for (const fx of track.effects ?? []) fxTypes.set(fx.type, (fxTypes.get(fx.type) ?? 0) + 1)
    for (const [type, count] of fxTypes) {
      if (count > 1) {
        duplicateFx += count - 1
        add('warn', 'duplicate_effect', `轨道 ${track.id} 上有 ${count} 个同类效果器 ${type}（检查是否重复添加）`, `tracks.${track.id}.effects`)
      }
    }
    // P12：未知采样乐器/鼓机（schema 2 下不应出现，防御检查）
    if (track.kind === 'synth' && typeof track.instrument?.preset === 'string' && !findSynthPreset(track.instrument.preset)) {
      add('warn', 'unknown_instrument', `轨道 ${track.id}「${track.name}」引用了未知采样乐器 ${track.instrument.preset}`, `tracks.${track.id}.instrument`)
    }
    if (track.kind === 'drum' && typeof track.instrument?.kit === 'string' && !DRUM_KITS.some((kit) => kit.id === track.instrument.kit)) {
      add('warn', 'unknown_instrument', `轨道 ${track.id}「${track.name}」引用了未知采样鼓机 ${track.instrument.kit}`, `tracks.${track.id}.instrument`)
    }
  }
  // 重复效果器（master / buses）
  const masterFx = new Map()
  for (const fx of project.master?.effects ?? []) masterFx.set(fx.type, (masterFx.get(fx.type) ?? 0) + 1)
  for (const [type, count] of masterFx) {
    if (count > 1) {
      duplicateFx += count - 1
      add('warn', 'duplicate_effect', `master 上有 ${count} 个同类效果器 ${type}（检查是否重复添加）`, 'master.effects')
    }
  }
  if ((project.master?.effects ?? []).length > 4) {
    add('warn', 'master_chain_long', `master 效果器链有 ${project.master.effects.length} 个（建议 ≤4，过多可能影响性能/音质）`, 'master.effects')
  }
  for (const busId of BUS_IDS) {
    const effects = project.buses?.[busId]?.effects ?? []
    const types = new Map()
    for (const fx of effects) types.set(fx.type, (types.get(fx.type) ?? 0) + 1)
    for (const [type, count] of types) {
      if (count > 1) {
        duplicateFx += count - 1
        add('warn', 'duplicate_effect', `返回总线 ${busId} 上有 ${count} 个同类效果器 ${type}（检查是否重复添加）`, `buses.${busId}.effects`)
      }
    }
  }
  // v2.1：track.volume 自动化改为乘算（track.volume × 曲线值）；首点与轨道音量不一致时给出 warning。
  for (const track of project.tracks) {
    const curve = track.automation?.volume
    if (!isObject(curve) || !Array.isArray(curve.points) || curve.points.length === 0) continue
    const first = curve.points[0]?.value
    if (!Number.isFinite(Number(first))) continue
    if (Math.abs(clamp01(Number(first)) - clamp01(track.volume ?? 0)) > 0.05) {
      add('warn', 'automation.volume_multiplier', `轨道「${track.name ?? track.id}」volume 自动化为乘算（track.volume × 曲线），首点 ${round(first, 3)} 与当前音量 ${round(track.volume, 3)} 不一致`, `tracks.${track.id}.automation.volume`)
    }
  }
  // master.volume 与自动化 volume 起点/稳态差异
  const masterAutomation = project.master?.automation?.volume
  if (isObject(masterAutomation) && Array.isArray(masterAutomation.points) && masterAutomation.points.length > 0) {
    const first = masterAutomation.points[0]?.value
    if (Number.isFinite(Number(first)) && Math.abs(clamp01(first) - clamp01(project.master?.volume ?? 0)) > 0.05) {
      add('info', 'master_volume_mismatch', `master.volume=${round(project.master.volume, 3)} 与自动化首点 ${round(first, 3)} 相差较大（自动化生效时以曲线为准）`, 'master')
    }
  }

  // ── P12b：全局速度曲线检查 ───────────────────────────────────────
  const tempoMapRaw = Array.isArray(project.tempoMap) ? project.tempoMap : []
  if (tempoMapRaw.length > MAX_TEMPO_POINTS) {
    add('warn', 'tempo_point', `速度曲线有 ${tempoMapRaw.length} 个点，超过上限 ${MAX_TEMPO_POINTS}`, 'tempoMap')
  }
  let lastTempoBeat = -1
  for (const [index, point] of tempoMapRaw.entries()) {
    const where = `tempoMap[${index}]`
    const beat = Number(point?.beat)
    const bpm = Number(point?.bpm)
    if (!Number.isFinite(beat) || beat < 0 || beat > lengthBeats + 1e-6) {
      add('warn', 'tempo_point', `速度曲线第 ${index} 点 beat=${JSON.stringify(point?.beat)} 非法（应在 0..${round(lengthBeats, 3)}）`, where)
    } else if (beat <= lastTempoBeat) {
      add('warn', 'tempo_point', `速度曲线第 ${index} 点 beat=${beat} 未按升序排列`, where)
    }
    if (Number.isFinite(beat)) lastTempoBeat = beat
    if (!Number.isFinite(bpm) || bpm < TEMPO_MIN_BPM || bpm > TEMPO_MAX_BPM) {
      add('warn', 'tempo_point', `速度曲线第 ${index} 点 bpm=${JSON.stringify(point?.bpm)} 非法（应在 ${TEMPO_MIN_BPM}..${TEMPO_MAX_BPM}）`, where)
    }
  }
  // ── 工程整体 ─────────────────────────────────────────────────────
  if (project.tracks.length === 0) add('warn', 'no_tracks', '工程没有任何轨道（空工程）', 'tracks')
  let maxClipEnd = 0
  for (const clip of project.clips) {
    const end = Number(clip.startBar) + Number(clip.lengthBars)
    if (Number.isFinite(end)) maxClipEnd = Math.max(maxClipEnd, end)
  }
  if (maxClipEnd > (Number(project.lengthBars) || 32)) {
    add('error', 'project_length_too_short', `曲长 ${project.lengthBars} 小节小于最长片段结尾 ${round(maxClipEnd, 3)} 小节（结尾内容不会被播放/导出）`, 'lengthBars')
  }

  // R0-09：可选混音 lint（默认不改变原行为）
  let mix = null
  if (options?.includeMix === true) {
    const mixResult = buildMixLint(project, options?.mixAnalysis ?? null)
    issues.push(...mixResult.issues)
    mix = {
      mode: mixResult.mode,
      stats: mixResult.stats,
      issueCount: mixResult.issues.length,
    }
  }

  const summary = {
    errors: issues.filter((issue) => issue.level === 'error').length,
    warns: issues.filter((issue) => issue.level === 'warn').length,
    infos: issues.filter((issue) => issue.level === 'info').length,
  }
  const counts = {
    tracks: project.tracks.length,
    patterns: project.patterns.length,
    notes: noteTotal,
    clips: project.clips.length,
    media: (project.media ?? []).length,
    effects: project.tracks.reduce((sum, track) => sum + (track.effects?.length ?? 0), 0) + (project.master?.effects?.length ?? 0),
    mutedTracks,
    emptyTracks,
    emptyPatterns,
    tempoPoints: tempoMapRaw.length,
    duplicateEffects: duplicateFx,
    automationCurves: project.tracks.reduce((sum, track) => sum + Object.keys(track.automation ?? {}).length, 0),
    ...(mix ? { mixIssues: mix.issueCount } : {}),
  }
  return { issues, counts, summary, ...(mix ? { mix } : {}) }
}

/* ------------------------------------------------------------------------- */
/* P1 编辑 API（POST /studio/api/edit 的 op 实现）                             */
/* ------------------------------------------------------------------------- */

/** 编辑操作 → 撤销步骤标签。 */
export const EDIT_OP_LABELS = {
  setPatternNotes: '编辑音符',
  setClips: '编辑片段',
  editClips: '编辑片段',
  setSections: '编辑段落',
  addPattern: '新建 pattern',
  updatePattern: '修改 pattern',
  removePattern: '删除 pattern',
  updateTrack: '修改轨道',
  setTempoMap: '设置速度曲线',
  clearTempoMap: '清除速度曲线',
  setAutomation: '编辑自动化',
  clearAutomation: '清除自动化',
  addEffect: '添加效果器',
  updateEffect: '调整效果器',
  removeEffect: '移除效果器',
  setSidechain: '设置侧链',
  clearSidechain: '清除侧链',
  setTrackSends: '调整发送',
  setBus: '调整返回总线',
  addAudioTrack: '添加音频轨',
  removeTrack: '移除轨道',
  setTakeActive: '切换 take',
  writeChords: '写和弦',
  generateArp: '生成琶音',
  applyGroove: '应用 Groove',
  setMidiMapping: '设置 MIDI 映射',
  clearMidiMapping: '清除 MIDI 映射',
  addGroup: '添加编组',
  updateGroup: '更新编组',
  removeGroup: '删除编组',
  setTrackOutput: '设置轨道输出',
  updateInstrument: '更新乐器参数',
  updateSynth: '更新合成器音色',
  saveScene: '保存场景',
  recallScene: '召回场景',
  deleteScene: '删除场景',
}

/** 支持的编辑操作类型（错误信息用）。 */
export const EDIT_OP_TYPES = Object.keys(EDIT_OP_LABELS)

/** 一次 edit 最多多少个 op（防止异常大的请求）。 */
const MAX_EDIT_OPS = 200

/** 根据一组 edit op 推导撤销步骤标签。 */
export function editLabelFor(opsList) {
  if (!Array.isArray(opsList) || opsList.length === 0) return '编辑工程'
  const types = new Set(opsList.map((op) => op?.type))
  if (types.size === 1) {
    const [type] = types
    return EDIT_OP_LABELS[type] ?? '编辑工程'
  }
  return '编辑工程'
}

/** 效果器链紧凑摘要（编辑结果返回用，避免 params 撑大响应）。 */
function compactEffectChain(chain) {
  return (chain ?? []).map((fx) => ({ id: fx.id, type: fx.type, enabled: fx.enabled !== false }))
}

/** 解析编辑 op 的效果器目标，返回 ops.addEffect 等需要的 { target, busId? }。 */
function editEffectTargetArgs(op) {
  const rawTarget = op.target === undefined || op.target === null ? 'track' : String(op.target)
  if (rawTarget === 'master') return { target: 'master' }
  if (rawTarget === 'group') {
    const groupId = typeof op.groupId === 'string' && op.groupId.trim() !== '' ? op.groupId.trim() : null
    if (!groupId) fail('target=group 时必须提供 groupId（grp_n）')
    return { target: 'group', groupId }
  }
  if (rawTarget === 'bus') {
    const busId = typeof op.busId === 'string' && op.busId.trim() !== '' ? op.busId.trim() : null
    if (!busId) fail('target=bus 时必须提供 busId（reverb / delay）')
    if (!BUS_IDS.includes(busId)) fail(`未知返回总线 busId=${busId}；可选：${BUS_IDS.join(' / ')}`)
    return { target: 'bus', busId }
  }
  if (rawTarget !== 'track') fail(`target 必须是 'track' / 'master' / 'bus'，收到 ${String(op.target)}`)
  if (typeof op.trackId !== 'string' || op.trackId.trim() === '') fail('target=track 时必须提供 trackId')
  return { target: op.trackId }
}

/**
 * 应用单个编辑 op（直接改传入的 project/draft）。
 * @param {object} project 项目（state.mutate 的 draft）
 * @param {object} op 编辑操作
 * @returns {object} 紧凑结果（供 UI 使用）
 */
export function applyEditOp(project, op) {
  if (!isObject(op)) fail('编辑操作必须是对象')
  const type = op.type
  switch (type) {
    case 'setPatternNotes': {
      const result = setNotes(project, { patternId: op.patternId, notes: op.notes })
      return {
        type,
        patternId: result.patternId,
        noteCount: result.noteCount,
        ...(result.warning ? { warning: result.warning } : {}),
      }
    }
    case 'setClips': {
      const result = setClips(project, { clips: op.clips })
      return { type, clips: result.clips }
    }
    case 'editClips': {
      const result = editClips(project, op)
      return { type, ...result }
    }
    case 'setSections': {
      const result = setSections(project, { sections: op.sections })
      return { type, sections: result.sections }
    }
    case 'addPattern': {
      const result = addPattern(project, { name: op.name, lengthBars: op.lengthBars })
      return { type, patternId: result.patternId, pattern: result.pattern }
    }
    case 'updatePattern': {
      const result = updatePattern(project, {
        patternId: op.patternId,
        name: op.name,
        lengthBars: op.lengthBars,
      })
      return { type, patternId: result.patternId, pattern: result.pattern }
    }
    case 'removePattern': {
      const result = removePattern(project, { patternId: op.patternId })
      return { type, patternId: result.patternId, removed: true }
    }
    case 'updateTrack': {
      const result = updateTrack(project, {
        trackId: op.trackId,
        name: op.name,
        volume: op.volume,
        pan: op.pan,
        mute: op.mute,
        solo: op.solo,
        sends: op.sends,
        sendMode: op.sendMode,
        phaseInvert: op.phaseInvert,
        mono: op.mono,
        bypassFx: op.bypassFx,
        pdcMs: op.pdcMs,
        automationMode: op.automationMode,
        instrumentParams: op.instrumentParams,
        engine: op.engine,
        synthPreset: op.synthPreset,
        synthParams: op.synthParams,
      })
      return { type, trackId: result.trackId, track: result.track }
    }
    case 'updateInstrument': {
      const result = updateInstrument(project, op)
      return { type, ...result }
    }
    case 'updateSynth': {
      const result = updateSynth(project, op)
      return { type, ...result }
    }
    case 'setAutomation': {
      const result = setAutomation(project, op)
      return { type, ...result }
    }
    case 'clearAutomation': {
      const result = clearAutomation(project, op)
      return { type, ...result }
    }
    case 'addEffect': {
      if (typeof op.fxType !== 'string' || op.fxType.trim() === '') {
        fail('addEffect 需要 fxType（效果器类型 id，如 filter/drive/delay/reverb…）')
      }
      const targetArgs = editEffectTargetArgs(op)
      const result = addEffect(project, {
        ...targetArgs,
        type: op.fxType.trim(),
        params: op.params,
        position: op.position,
      })
      const created = result.chain.find((fx) => fx.id === result.effectId)
      return {
        type,
        effectId: result.effectId,
        target: result.target,
        ...(result.busId ? { busId: result.busId } : {}),
        ...(result.groupId ? { groupId: result.groupId } : {}),
        position: result.position,
        effect: created
          ? { id: created.id, type: created.type, enabled: created.enabled !== false, params: created.params }
          : null,
        chain: compactEffectChain(result.chain),
      }
    }
    case 'updateEffect': {
      const targetArgs = editEffectTargetArgs(op)
      const result = updateEffect(project, {
        ...targetArgs,
        effectId: op.effectId,
        params: op.params,
        enabled: op.enabled,
        move: op.position,
      })
      const updated = result.chain.find((fx) => fx.id === result.effectId)
      return {
        type,
        effectId: result.effectId,
        target: result.target,
        ...(result.busId ? { busId: result.busId } : {}),
        ...(result.groupId ? { groupId: result.groupId } : {}),
        position: result.position,
        effect: updated
          ? { id: updated.id, type: updated.type, enabled: updated.enabled !== false, params: updated.params }
          : null,
      }
    }
    case 'removeEffect': {
      const targetArgs = editEffectTargetArgs(op)
      const result = removeEffect(project, { ...targetArgs, effectId: op.effectId })
      return {
        type,
        effectId: result.effectId,
        target: result.target,
        ...(result.busId ? { busId: result.busId } : {}),
        removed: true,
        chain: compactEffectChain(result.chain),
      }
    }
    case 'setSidechain': {
      const result = setSidechain(project, op)
      return { type, ...result }
    }
    case 'clearSidechain': {
      const result = clearSidechain(project, op)
      return { type, ...result }
    }
    case 'setTempoMap': {
      const result = setTempoMap(project, op)
      return { type, points: result.points, hasTempo: result.hasTempo }
    }
    case 'clearTempoMap': {
      const result = clearTempoMap(project, op)
      return { type, cleared: result.cleared }
    }
    case 'setTrackSends': {
      const result = setTrackSends(project, op)
      return { type, ...result }
    }
    case 'setBus': {
      const result = setBus(project, op)
      return { type, ...result }
    }
    case 'addAudioTrack': {
      const result = addAudioTrack(project, {
        mediaId: op.mediaId,
        name: op.name,
        startBar: op.startBar,
      })
      return { type, ...result }
    }
    case 'removeTrack': {
      const result = removeTrack(project, op)
      return { type, ...result }
    }
    case 'setTakeActive': {
      const result = setTakeActive(project, op)
      return { type, ...result }
    }
    case 'writeChords': {
      const result = writeChords(project, op)
      return { type, ...result }
    }
    case 'generateArp': {
      const result = generateArp(project, op)
      return { type, ...result }
    }
    case 'applyGroove': {
      const result = applyGrooveOp(project, op)
      return { type, ...result }
    }
    case 'setMidiMapping': {
      const result = setMidiMapping(project, op)
      return { type, ...result }
    }
    case 'clearMidiMapping': {
      const result = clearMidiMapping(project, op)
      return { type, ...result }
    }
    case 'addGroup': {
      const result = addGroup(project, op)
      return { type, ...result }
    }
    case 'updateGroup': {
      const result = updateGroup(project, op)
      return { type, ...result }
    }
    case 'removeGroup': {
      const result = removeGroup(project, op)
      return { type, ...result }
    }
    case 'setTrackOutput': {
      const result = setTrackOutput(project, op)
      return { type, ...result }
    }
    case 'saveScene': {
      const result = saveScene(project, op)
      return { type, ...result }
    }
    case 'recallScene': {
      const result = recallScene(project, op)
      return { type, ...result }
    }
    case 'deleteScene': {
      const result = deleteScene(project, op)
      return { type, ...result }
    }
    default:
      fail(`不支持的编辑操作 type=${String(type)}；可选：${EDIT_OP_TYPES.join(' / ')}`)
  }
}

/**
 * 一次应用一组编辑操作（整组原子：任一 op 失败，调用方丢弃整个 draft）。
 * @param {object} project 项目 draft
 * @param {object[]} opsList 编辑操作数组
 * @returns {{label:string, results:object[], warnings?:string[]}}
 */
export function applyEditOps(project, opsList) {
  if (!Array.isArray(opsList)) fail('ops 必须是数组')
  if (opsList.length === 0) fail('ops 不能为空（至少提交一个编辑操作）')
  if (opsList.length > MAX_EDIT_OPS) fail(`一次最多提交 ${MAX_EDIT_OPS} 个编辑操作，收到 ${opsList.length} 个`)
  const results = []
  const warnings = []
  for (let index = 0; index < opsList.length; index += 1) {
    const op = opsList[index]
    try {
      const result = applyEditOp(project, op)
      if (result?.warning) warnings.push(`ops[${index}]：${result.warning}`)
      results.push(result)
    } catch (error) {
      if (error?.name === 'OpError') {
        fail(`ops[${index}]（${String(op?.type)}）失败：${error.message}`)
      }
      throw error
    }
  }
  return {
    label: editLabelFor(opsList),
    results,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/* ------------------------------------------------------------------------- */
/* P13：批量编辑 studio_batch（白名单 host ops，一次 mutate / 一次撤销）       */
/* ------------------------------------------------------------------------- */

/** 一次批量编辑最多多少个 op。 */
export const BATCH_MAX_OPS = 200

/** 批量编辑允许的操作类型（与 CONTRACT-P13 §3 一致）。 */
export const BATCH_OP_TYPES = Object.freeze([
  'addTrack',
  'addPattern',
  'setPatternNotes',
  'editPatternNotes',
  'setClips',
  'editClips',
  'setArrangement',
  'updateTrack',
  'setAutomation',
  'clearAutomation',
  'setSustain',
  'clearSustain',
  'setVibrato',
  'clearVibrato',
  'addEffect',
  'updateEffect',
  'removeEffect',
  'setTempoMap',
  'clearTempoMap',
  'copyPattern',
  'setTakeActive',
  'writeChords',
  'generateArp',
  'applyGroove',
  'setMidiMapping',
  'clearMidiMapping',
  'addGroup',
  'updateGroup',
  'removeGroup',
  'setTrackOutput',
  'updateInstrument',
  'updateSynth',
  'saveScene',
  'recallScene',
  'deleteScene',
])

/** 批量编辑结果里保留的紧凑字段（避免大量 op 撑大工具响应）。 */
const BATCH_RESULT_KEYS = [
  'trackId', 'patternId', 'clipId', 'effectId', 'busId', 'target', 'type', 'name',
  'noteCount', 'clips', 'sections', 'points', 'hasTempo', 'cleared', 'removed', 'count',
  'activeClipIds', 'deactivatedClipIds', 'takeGroup', 'takeIndex',
  'chords', 'pattern', 'template', 'templateLabel', 'changed',
  'mapping', 'midiMappings', 'cc', 'channel', 'cleared',
  'groupId', 'group', 'output', 'tracksReset', 'count',
  'scene', 'sceneId', 'sceneName', 'overwritten', 'deleted',
  'restoredTracks', 'skippedTracks', 'restoredGroups', 'skippedGroups',
  'instrumentParams', 'reset', 'synthPreset', 'synthParams', 'engine',
]

/** 把单个 op 的结果压成紧凑对象。 */
function compactBatchResult(opType, result) {
  const compact = { type: opType }
  if (isObject(result)) {
    for (const key of BATCH_RESULT_KEYS) {
      if (result[key] !== undefined) compact[key] = result[key]
    }
  }
  return compact
}

/**
 * studio_batch：按白名单顺序执行多个 host op（同一 draft 上），任一失败整体不写入。
 * @param {object} project state.mutate 的 draft
 * @param {{ops:Array<{type:string,args?:object}>, label?:string}} args
 * @returns {{label:string, count:number, results:object[]}}
 */
export function applyBatchOps(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const label = optionalString(args.label, 'label', { max: 60 }) ?? '批量编辑'
  if (!Array.isArray(args.ops)) fail('ops 必须是数组，每项 { type, args }')
  if (args.ops.length === 0) fail('ops 不能为空（至少一个批量编辑操作）')
  if (args.ops.length > BATCH_MAX_OPS) {
    fail(`一次批量编辑最多 ${BATCH_MAX_OPS} 个操作，收到 ${args.ops.length} 个`)
  }
  const results = []
  for (const [index, op] of args.ops.entries()) {
    if (!isObject(op)) fail(`ops[${index}] 必须是对象 { type, args }`)
    const type = requireString(op.type, `ops[${index}].type`, { max: 32 })
    const handler = BATCH_OP_HANDLERS[type]
    if (!handler) {
      fail(`ops[${index}] 不支持的操作类型 ${type}；可用：${BATCH_OP_TYPES.join(' / ')}`)
    }
    const opArgs = op.args === undefined || op.args === null ? {} : op.args
    if (!isObject(opArgs)) fail(`ops[${index}].args 必须是对象`)
    let result
    try {
      result = handler(project, opArgs)
    } catch (error) {
      if (error?.name === 'OpError') {
        fail(`ops[${index}]（${type}）失败：${error.message}（整批未写入）`)
      }
      throw error
    }
    results.push(compactBatchResult(type, result))
  }
  return { label, count: results.length, results }
}

/** 白名单 op → host ops 函数（函数声明提升，可在此引用）。 */
const BATCH_OP_HANDLERS = Object.freeze({
  addTrack: (project, args) => addTrack(project, args),
  addPattern: (project, args) => addPattern(project, args),
  setPatternNotes: (project, args) => setNotes(project, { patternId: args.patternId, notes: args.notes }),
  editPatternNotes: (project, args) => editPatternNotes(project, args),
  setClips: (project, args) => setClips(project, { clips: args.clips }),
  editClips: (project, args) => editClips(project, args),
  setArrangement: (project, args) => setArrangement(project, args),
  updateTrack: (project, args) => updateTrack(project, args),
  setAutomation: (project, args) => setAutomation(project, args),
  clearAutomation: (project, args) => clearAutomation(project, args),
  setSustain: (project, args) => setSustain(project, args),
  clearSustain: (project, args) => clearSustain(project, args),
  setVibrato: (project, args) => setVibrato(project, args),
  clearVibrato: (project, args) => clearVibrato(project, args),
  addEffect: (project, args) => addEffect(project, args),
  updateEffect: (project, args) => updateEffect(project, args),
  removeEffect: (project, args) => removeEffect(project, args),
  setTempoMap: (project, args) => setTempoMap(project, args),
  clearTempoMap: (project, args) => clearTempoMap(project, args),
  copyPattern: (project, args) => copyPattern(project, args),
  setTakeActive: (project, args) => setTakeActive(project, args),
  writeChords: (project, args) => writeChords(project, args),
  generateArp: (project, args) => generateArp(project, args),
  applyGroove: (project, args) => applyGrooveOp(project, args),
  setMidiMapping: (project, args) => setMidiMapping(project, args),
  clearMidiMapping: (project, args) => clearMidiMapping(project, args),
  addGroup: (project, args) => addGroup(project, args),
  updateGroup: (project, args) => updateGroup(project, args),
  removeGroup: (project, args) => removeGroup(project, args),
  setTrackOutput: (project, args) => setTrackOutput(project, args),
  updateInstrument: (project, args) => updateInstrument(project, args),
  updateSynth: (project, args) => updateSynth(project, args),
  saveScene: (project, args) => saveScene(project, args),
  recallScene: (project, args) => recallScene(project, args),
  deleteScene: (project, args) => deleteScene(project, args),
})

/* ------------------------------------------------------------------------- */
/* 自动化曲线（P2a，编辑 op 与 AI 工具共用）                                   */
/* ------------------------------------------------------------------------- */

/** 解析自动化 op 的 target / param，并校验 master 只支持 volume。 */
function resolveAutomationContext(project, args) {
  if (!isObject(args)) fail('参数必须是对象')
  const target = args.target === undefined || args.target === null
    ? 'track'
    : requireString(args.target, 'target', { max: 16 })
  if (target !== 'track' && target !== 'master') fail(`target 必须是 'track' 或 'master'，收到 ${target}`)
  const param = requireString(args.param, 'param', { max: 16 })
  const spec = AUTOMATION_PARAMS[param]
  if (!spec) fail(`未知自动化参数 ${param}；可选：${Object.keys(AUTOMATION_PARAMS).join(' / ')}`)
  const maxBeat = Math.max(1, Number(project.lengthBars) || 32) * beatsPerBar(project)
  if (target === 'master') {
    if (!Array.isArray(spec.targets) || !spec.targets.includes('master')) {
      fail(`master 只支持 volume 自动化，不支持 ${param}；${param} 只能作用于轨道`)
    }
    return { target, param, spec, maxBeat }
  }
  const track = getTrack(project, args.trackId)
  return { target, param, spec, maxBeat, track }
}

/**
 * 校验自动化点数组：数字校验、beat 夹紧到 [0, maxBeat]、value 夹 0..1、
 * 按 beat 升序、重复 beat 后者覆盖；超过 256 个点报错。
 */
export function validateAutomationPoints(points, maxBeat) {
  if (!Array.isArray(points)) fail('points 必须是数组，每项 { beat:number, value:number }')
  if (points.length > AUTOMATION_MAX_POINTS) fail(`自动化点数量 ${points.length} 超过上限 ${AUTOMATION_MAX_POINTS}`)
  const limit = Number.isFinite(Number(maxBeat)) ? Math.max(0, Number(maxBeat)) : Number.POSITIVE_INFINITY
  const cleaned = []
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (!isObject(point)) fail(`points[${index}] 必须是对象，如 { beat: 0, value: 0.5 }`)
    const beat = Number(point.beat)
    const value = Number(point.value)
    if (!Number.isFinite(beat)) fail(`points[${index}].beat 必须是数字（绝对 beat，1 小节 = 4 beat）`)
    if (!Number.isFinite(value)) fail(`points[${index}].value 必须是 0..1 的数字`)
    cleaned.push({ beat: Math.min(limit, Math.max(0, beat)), value: clamp01(value) })
  }
  cleaned.sort((a, b) => a.beat - b.beat)
  const deduped = []
  for (const point of cleaned) {
    const last = deduped[deduped.length - 1]
    if (last && last.beat === point.beat) deduped[deduped.length - 1] = point
    else deduped.push(point)
  }
  return deduped
}

/**
 * 设置一条自动化曲线（整条替换）。
 * @param {object} project
 * @param {{target?:'track'|'master', trackId?:string, param:string, points:Array, enabled?:boolean}} args
 * @returns {{target:string, trackId?:string, param:string, enabled:boolean, pointCount:number}}
 */
export function setAutomation(project, args = {}) {
  const { target, param, maxBeat, track } = resolveAutomationContext(project, args)
  const points = validateAutomationPoints(args.points, maxBeat)
  const enabled = args.enabled === undefined || args.enabled === null ? true : coerceBool(args.enabled, 'enabled')
  const curve = { enabled, points }
  if (target === 'master') {
    const current = isObject(project.master.automation) ? project.master.automation : {}
    project.master.automation = normalizeAutomation({ ...current, [param]: curve }, { maxBeat, allowed: ['volume'] })
    return { target, param, enabled, pointCount: points.length }
  }
  const current = isObject(track.automation) ? track.automation : {}
  track.automation = normalizeAutomation({ ...current, [param]: curve }, { maxBeat })
  return { target, trackId: track.id, param, enabled, pointCount: points.length }
}

/**
 * 清除一条自动化曲线（幂等：不存在时返回 cleared:false 而不是报错）。
 * @returns {{target:string, trackId?:string, param:string, cleared:boolean}}
 */
export function clearAutomation(project, args = {}) {
  const { target, param, track } = resolveAutomationContext(project, args)
  if (target === 'master') {
    const automation = isObject(project.master.automation) ? project.master.automation : {}
    const cleared = Object.hasOwn(automation, param)
    delete automation[param]
    if (Object.keys(automation).length === 0) delete project.master.automation
    return { target, param, cleared }
  }
  const automation = isObject(track.automation) ? track.automation : {}
  const cleared = Object.hasOwn(automation, param)
  delete automation[param]
  if (Object.keys(automation).length === 0) delete track.automation
  return { target, trackId: track.id, param, cleared }
}

/* ------------------------------------------------------------------------- */
/* 侧链压缩（P2b，编辑 op 与 AI 工具共用）                                     */
/* ------------------------------------------------------------------------- */

/**
 * 设置轨道侧链压缩：来源必须是同工程内另一条轨道。
 * amount/attack/release 省略时用 SIDECHAIN_DEFAULTS，越界自动夹紧；enabled 默认 true。
 * R0-12：triggerNotes 可传 number 或 number[]（0..127、≤16、去重升序；[] = 任意音符触发）。
 * @returns {{trackId:string, enabled:boolean, sourceTrackId:string, amount:number, attack:number, release:number, triggerNotes:number[]}}
 */
export function setSidechain(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const sourceTrackId = requireString(args.sourceTrackId, 'sourceTrackId', { max: 64 })
  const trackIds = new Set(project.tracks.map((item) => item.id))
  if (sourceTrackId === track.id) fail('侧链来源不能是轨道自身；请选择另一条轨道')
  if (!trackIds.has(sourceTrackId)) {
    const candidates = project.tracks.map((item) => item.id).filter((id) => id !== track.id)
    fail(`找不到侧链来源轨道 ${sourceTrackId}；可选来源：${candidates.join(', ') || '（没有其它轨道）'}`)
  }
  const enabled = args.enabled === undefined || args.enabled === null ? true : coerceBool(args.enabled, 'enabled')
  // R0-12：triggerNotes 可传数组或单数；省略时保留既有过滤（新建默认 [] = 任意音符）。
  const triggerNotes = args.triggerNotes === undefined || args.triggerNotes === null
    ? (Array.isArray(track.sidechain?.triggerNotes) ? track.sidechain.triggerNotes : [])
    : normalizeSidechainTriggerNotes(args.triggerNotes)
  const raw = {
    enabled,
    sourceTrackId,
    amount: args.amount === undefined || args.amount === null ? SIDECHAIN_DEFAULTS.amount : strictFiniteNumber(args.amount, 'amount'),
    attack: args.attack === undefined || args.attack === null ? SIDECHAIN_DEFAULTS.attack : strictFiniteNumber(args.attack, 'attack'),
    release: args.release === undefined || args.release === null ? SIDECHAIN_DEFAULTS.release : strictFiniteNumber(args.release, 'release'),
    triggerNotes,
  }
  const sidechain = normalizeSidechain(raw, { trackIds, selfId: track.id })
  if (!sidechain) fail('侧链参数非法：来源轨道必须存在且不能是轨道自身')
  track.sidechain = sidechain
  return { trackId: track.id, ...sidechain }
}

/**
 * 清除轨道侧链（幂等：不存在时返回 cleared:false 而不是报错）。
 * @returns {{trackId:string, cleared:boolean}}
 */
export function clearSidechain(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const cleared = Object.hasOwn(track, 'sidechain')
  delete track.sidechain
  return { trackId: track.id, cleared }
}

/* ------------------------------------------------------------------------- */
/* 混音路由：轨道发送量 + 返回总线电平（P2c-2）                                 */
/* ------------------------------------------------------------------------- */

/**
 * 设置轨道发送量（只改传入的字段，0..1 夹紧；未传保持不变）。
 * @returns {{trackId:string, sends:{reverb:number, delay:number}}}
 */
export function setTrackSends(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const hasReverb = args.reverb !== undefined && args.reverb !== null
  const hasDelay = args.delay !== undefined && args.delay !== null
  if (!hasReverb && !hasDelay) fail('setTrackSends 需要至少提供 reverb 或 delay（0..1）')
  const reverb = hasReverb ? clamp01(strictFiniteNumber(args.reverb, 'reverb')) : undefined
  const delay = hasDelay ? clamp01(strictFiniteNumber(args.delay, 'delay')) : undefined
  if (!isObject(track.sends)) track.sends = { reverb: 0.18, delay: 0.12 }
  if (reverb !== undefined) track.sends.reverb = reverb
  if (delay !== undefined) track.sends.delay = delay
  return {
    trackId: track.id,
    sends: { reverb: round(track.sends.reverb, 3), delay: round(track.sends.delay, 3) },
  }
}

/**
 * 设置返回总线电平（level 省略时仅返回当前值，不做变更）。
 * @returns {{busId:string, level:number}}
 */
export function setBus(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const busId = requireString(args.busId, 'busId', { max: 16 })
  if (!BUS_IDS.includes(busId)) fail(`未知返回总线 busId=${busId}；可选：${BUS_IDS.join(' / ')}`)
  ensureBusStructure(project)
  const hasLevel = args.level !== undefined && args.level !== null
  if (hasLevel) project.buses[busId].level = clamp01(strictFiniteNumber(args.level, 'level'))
  return { busId, level: round(project.buses[busId].level, 3) }
}

/* ------------------------------------------------------------------------- */
/* 表达控制：延音踏板 / 揉弦（P11）                                            */
/* ------------------------------------------------------------------------- */

/**
 * studio_set_sustain：整条替换轨道延音踏板曲线（一次撤销）。
 * @returns {{trackId:string, points:{beat:number,value:number}[]}}
 */
export function setSustain(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  if (!Array.isArray(args.points)) fail('points 必须是数组，每项 { beat, value }（value 0/1）')
  const maxBeat = Math.max(1, beatsPerBar(project)) * Math.max(1, Number(project.lengthBars) || 32)
  const points = normalizeSustainPoints(args.points, { maxBeat })
  if (points.length > 0) track.sustain = points
  else delete track.sustain
  return { trackId: track.id, points }
}

/** studio_clear_sustain：清除轨道延音踏板（幂等）。 */
export function clearSustain(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const cleared = Object.hasOwn(track, 'sustain')
  delete track.sustain
  return { trackId: track.id, cleared }
}

/**
 * studio_set_vibrato：部分更新轨道揉弦参数（一次撤销）。
 * @returns {{trackId:string, rateHz:number, depthCents:number, enabled:boolean}}
 */
export function setVibrato(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const hasRate = args.rateHz !== undefined && args.rateHz !== null
  const hasDepth = args.depthCents !== undefined && args.depthCents !== null
  const hasEnabled = args.enabled !== undefined && args.enabled !== null
  if (!hasRate && !hasDepth && !hasEnabled) fail('setVibrato 需要至少提供 rateHz / depthCents / enabled 之一')
  const merged = { ...(track.vibrato ?? {}) }
  if (hasRate) merged.rateHz = strictFiniteNumber(args.rateHz, 'rateHz')
  if (hasDepth) merged.depthCents = strictFiniteNumber(args.depthCents, 'depthCents')
  if (hasEnabled) merged.enabled = coerceBool(args.enabled, 'enabled')
  const vibrato = normalizeVibrato(merged)
  if (!vibrato) fail('vibrato 参数非法')
  track.vibrato = vibrato
  return { trackId: track.id, ...vibrato }
}

/** studio_clear_vibrato：清除轨道揉弦（幂等）。 */
export function clearVibrato(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const track = getTrack(project, args.trackId)
  const cleared = Object.hasOwn(track, 'vibrato')
  delete track.vibrato
  return { trackId: track.id, cleared }
}

/**
 * 记录一次导出到 project.exportHistory（最近 10 条，最新在前）。
 * @returns {{entry:object, count:number}}
 */
export function recordExportHistory(project, entry = {}) {
  const normalized = normalizeExportHistoryEntry(entry)
  if (!normalized) fail('导出历史条目非法（至少需要 name 或 path）')
  const history = Array.isArray(project.exportHistory) ? project.exportHistory : []
  project.exportHistory = [normalized, ...history].slice(0, EXPORT_HISTORY_LIMIT)
  return { entry: normalized, count: project.exportHistory.length }
}

/* ------------------------------------------------------------------------- */
/* 效果器                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * studio_add_effect：给 master / 返回总线（busId）或轨道插入效果器。
 * @returns { effectId, target, busId?, position, chain }
 */
export function addEffect(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const { chain, meta, label, max } = resolveEffectTarget(project, args.target, args.busId, args.groupId)
  if (chain.length >= max) fail(`${label} 的效果器数量已达上限 ${max}`)
  const type = requireString(args.type, 'type', { max: 32 })
  if (type === 'vst3') {
    if (!/^trk_/.test(String(meta.target ?? ''))) fail('VST3 效果器只允许添加到轨道 FX 链（不支持 master/bus/group）')
    if (countExternalPluginInstances(project) >= MAX_EXTERNAL_PLUGIN_INSTANCES) fail(`外部插件实例已达上限 ${MAX_EXTERNAL_PLUGIN_INSTANCES}`)
    const vst3 = normalizeExternalPlugin(args.vst3)
    if (!vst3) fail('VST3 效果器需要有效的 vst3 描述（pluginId 必填）')
    const effect = { id: makeIdGen(project)('fx'), type: 'vst3', enabled: true, vst3 }
    chain.push(effect)
    return { effectId: effect.id, ...meta, position: chain.length - 1, chain: chain.map(effectSummary), vst3: effectSummary(effect).vst3 }
  }
  const fxType = findFxType(type)
  if (!fxType) fail(`未知效果器 type=${type}；可选：${FX_TYPES.map((fx) => fx.id).join(' / ')}`)
  const params = coerceFxParams(type, args.params)
  // position 越界时钳制到 [0, chain.length]（追加/头插），而不是报错。
  const rawPosition = args.position === undefined || args.position === null
    ? chain.length
    : Math.trunc(strictFiniteNumber(args.position, 'position'))
  let position = Math.min(chain.length, Math.max(0, rawPosition))
  const firstVst3 = chain.findIndex((fx) => fx.type === 'vst3')
  if (firstVst3 >= 0 && position > firstVst3) position = firstVst3
  const nextId = makeIdGen(project)
  const effect = makeEffect(nextId('fx'), fxType.id, params)
  chain.splice(position, 0, effect)
  // P10：同目标已存在同 type 时给出重复提示（不阻止添加）。
  const sameTypeCount = chain.filter((fx) => fx.type === fxType.id).length
  const warnings = sameTypeCount > 1
    ? [`已存在同类效果器 ${fxType.label}（当前链内有 ${sameTypeCount} 个 ${fxType.id}），检查是否重复添加`]
    : []
  return { effectId: effect.id, ...meta, position, chain: chain.map(effectSummary), ...(warnings.length > 0 ? { warnings } : {}) }
}

/**
 * studio_update_effect：更新开关 / 合并参数 / 调整链内位置。
 * @returns { effectId, target, busId?, position, chain }
 */
export function updateEffect(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const { chain, meta, label } = resolveEffectTarget(project, args.target, args.busId, args.groupId)
  const effectId = requireString(args.effectId, 'effectId', { max: 64 })
  const index = chain.findIndex((fx) => fx.id === effectId)
  if (index < 0) fail(`${label} 的效果器链里找不到 ${effectId}；现有：${chain.map((fx) => `${fx.id}(${fx.type})`).join(', ') || '空'}`)
  const effect = chain[index]
  const enabled = args.enabled === undefined || args.enabled === null ? undefined : coerceBool(args.enabled, 'enabled')
  if (effect.type === 'vst3') {
    if (enabled !== undefined) effect.enabled = enabled
    if (args.vst3Bypass !== undefined) effect.vst3.bypass = coerceBool(args.vst3Bypass, 'vst3Bypass')
    if (isObject(args.vst3Params)) {
      const merged = normalizeExternalPlugin({ ...effect.vst3, params: { ...(effect.vst3.params ?? {}), ...args.vst3Params } })
      if (merged) effect.vst3 = merged
    }
    const lastVst3Index = chain.map((fx) => fx.type).lastIndexOf('vst3')
    if (index !== lastVst3Index) {
      chain.splice(index, 1)
      chain.push(effect)
    }
    return { effectId, ...meta, position: chain.indexOf(effect), chain: chain.map(effectSummary) }
  }
  const params = coerceFxParams(effect.type, args.params)
  const rawMove = args.move === undefined || args.move === null
    ? undefined
    : Math.trunc(strictFiniteNumber(args.move, 'move'))
  const move = rawMove === undefined ? undefined : Math.min(chain.length - 1, Math.max(0, rawMove))
  if (enabled !== undefined) effect.enabled = enabled
  if (Object.keys(params).length > 0) effect.params = { ...(effect.params ?? {}), ...params }
  if (move !== undefined && move !== index) {
    chain.splice(index, 1)
    chain.splice(Math.min(move, chain.length), 0, effect)
  }
  return { effectId, ...meta, position: chain.indexOf(effect), chain: chain.map(effectSummary) }
}

/**
 * studio_remove_effect：移除效果器。
 * @returns { effectId, target, busId?, removed, chain }
 */
/** v2.2：设置 VST3 轨/效果器旁路（M1 只写工程标记，音频 M2 生效）。 */
export function setVst3Bypass(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  if (typeof args.bypass !== 'boolean') fail('bypass 必须是布尔值')
  const effectId = typeof args.effectId === 'string' && args.effectId !== '' ? args.effectId : null
  const trackId = typeof args.trackId === 'string' && args.trackId !== '' ? args.trackId : null
  if (effectId) {
    for (const track of project.tracks ?? []) {
      const effect = (track.effects ?? []).find((fx) => fx?.id === effectId && fx.type === 'vst3')
      if (effect) {
        effect.vst3.bypass = args.bypass
        return { effectId, trackId: track.id, bypass: args.bypass }
      }
    }
    fail(`找不到 VST3 效果器 effectId=${effectId}`)
  }
  if (trackId) {
    const track = getTrack(project, trackId)
    if (track.engine !== 'vst3') fail(`轨道 ${trackId} 不是 VST3 乐器轨`)
    track.vst3.bypass = args.bypass
    return { trackId, bypass: args.bypass }
  }
  fail('需要 trackId 或 effectId')
}

export function removeEffect(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const { chain, meta, label } = resolveEffectTarget(project, args.target, args.busId, args.groupId)
  const effectId = requireString(args.effectId, 'effectId', { max: 64 })
  const index = chain.findIndex((fx) => fx.id === effectId)
  if (index < 0) fail(`${label} 的效果器链里找不到 ${effectId}`)
  chain.splice(index, 1)
  return { effectId, ...meta, removed: true, chain: chain.map(effectSummary) }
}

/* ------------------------------------------------------------------------- */
/* Master                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * studio_set_master：设置 master 音量 / 整链替换效果器。
 * @returns { master }
 */
export function setMaster(project, args = {}) {
  if (!isObject(args)) args = {}
  const volume = args.volume === undefined || args.volume === null ? undefined : clamp01(strictFiniteNumber(args.volume, 'volume'))
  let effects = null
  if (args.effects !== undefined && args.effects !== null) {
    if (!Array.isArray(args.effects)) fail('effects 必须是数组（整链替换），每项形如 { type:\'eq3\', params:{} }')
    if (args.effects.length > LIMITS.maxMasterEffects) fail(`master 效果器数量超过上限 ${LIMITS.maxMasterEffects}`)
    effects = args.effects.map((item, index) => {
      if (!isObject(item)) fail(`effects[${index}] 必须是对象`)
      const type = requireString(item.type, `effects[${index}].type`, { max: 32 })
      if (!findFxType(type)) fail(`effects[${index}].type=${type} 不是有效效果器；可选：${FX_TYPES.map((fx) => fx.id).join(' / ')}`)
      const enabled = item.enabled === undefined || item.enabled === null ? true : coerceBool(item.enabled, `effects[${index}].enabled`)
      const params = coerceFxParams(type, item.params, `effects[${index}].params`)
      return makeEffect(`fx_${index + 1}`, type, params, enabled)
    })
  }
  if (volume !== undefined) project.master.volume = clamp01(volume)
  if (effects) project.master.effects = effects
  return { master: masterSummary(project.master) }
}

/* ------------------------------------------------------------------------- */
/* 全局速度曲线（P12b）：project.tempoMap = [{beat, bpm}]                     */
/* ------------------------------------------------------------------------- */

/**
 * studio_set_tempo_map：整条替换速度曲线（一次撤销）；空数组 = 清除。
 * @returns {{points:Array<{beat:number,bpm:number}>, hasTempo:boolean}}
 */
export function setTempoMap(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  if (!Array.isArray(args.points)) fail('points 必须是数组，每项 { beat, bpm }（bpm 40..200）')
  const barBeats = Math.max(1, beatsPerBar(project))
  const maxBeat = Math.max(1, Number(project.lengthBars) || 32) * barBeats
  const points = normalizeTempoPoints(args.points, { baseBpm: project.bpm, maxBeat })
  if (points.length > 0) project.tempoMap = points
  else delete project.tempoMap
  return { points, hasTempo: points.length > 0, bpm: project.bpm }
}

/** studio_clear_tempo_map：清除速度曲线（幂等）。 */
export function clearTempoMap(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const cleared = Object.hasOwn(project, 'tempoMap')
  delete project.tempoMap
  return { cleared, bpm: project.bpm }
}

/* ------------------------------------------------------------------------- */
/* 播放 / 导出 / 动态                                                          */
/* ------------------------------------------------------------------------- */

/**
 * 单调递增的命令序列号：客户端用「seq 是否变化」判断是否执行，
 * 因此即使 create_project 重置了项目、或 UI 重新连接，序列号也必须继续变大，
 * 不能从 1 重新计数（否则新命令会被 UI 当成旧命令忽略）。
 */
function nextSeq(previous) {
  return Math.max(Date.now(), (Number(previous?.seq) || 0) + 1)
}

/**
 * studio_transport：写 transport 状态与 cmd 序列号，UI 依此执行播放/停止/跳转。
 * @returns { action, playing, positionBar, seq }
 */
export function transport(project, args = {}) {
  if (!isObject(args)) args = {}
  const action = requireString(args.action, 'action', { max: 16 })
  if (!['play', 'stop', 'seek'].includes(action)) fail(`action 必须是 'play' / 'stop' / 'seek'，收到 ${action}`)
  const maxBar = Math.max(1, project.lengthBars)
  let positionBar = args.positionBar === undefined || args.positionBar === null
    ? undefined
    : Math.min(maxBar, Math.max(0, strictFiniteNumber(args.positionBar, 'positionBar')))
  if (action === 'seek' && positionBar === undefined) fail("action='seek' 时必须提供 positionBar（单位：小节）")
  if (positionBar === undefined) positionBar = project.transport.playheadBar ?? 0
  const at = Date.now()
  if (action === 'play') {
    project.transport.playing = true
    project.transport.playheadBar = positionBar
  } else if (action === 'stop') {
    project.transport.playing = false
    project.transport.playheadBar = positionBar
  } else {
    project.transport.playheadBar = positionBar
  }
  const seq = nextSeq(project.transport.cmd)
  project.transport.cmd = { seq, action, positionBar, at }
  return { action, playing: project.transport.playing, positionBar: round(positionBar, 3), seq }
}

/**
 * 请求导出：写入 exportRequest，UI 轮询发现 seq 变化后执行。
 * - format 省略/'wav'：离线渲染整首 WAV（历史行为）；
 * - format='stems'：UI 逐轨渲染分轨 WAV（P2b）；
 * - MIDI 由 Host 直接生成，不走这里。
 * P10：额外支持 fromBar/toBar（区间导出）、tailSeconds（保留混响尾音）、normalize（峰值归一）、name（文件名）。
 * @param {object} project
 * @param {{format?:'wav'|'stems'|'mp3'|'flac',fromBar?:number,toBar?:number,tailSeconds?:number,normalize?:boolean,name?:string,outputDir?:string,jobId?:string}} [options]
 * @returns {{requested:true, seq:number, jobId:string, status:'pending', ...}}
 */
export function exportRequest(project, options = {}) {
  const opts = isObject(options) ? options : {}
  const seq = nextSeq(project.exportRequest)
  const format = opts.format === 'stems' || opts.format === 'mp3' || opts.format === 'flac' ? opts.format : undefined
  const jobId = typeof opts.jobId === 'string' && opts.jobId.trim() !== ''
    ? opts.jobId.trim().slice(0, 64)
    : `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  // v2.1：claimable 让多客户端只有首个 claim 渲染；claimedBy 初始 null。
  const request = {
    seq,
    at: Date.now(),
    jobId,
    status: 'pending',
    startedAt: Date.now(),
    claimable: true,
    claimedBy: null,
    // v2.1：AI 触发默认 silent（不触发浏览器下载）；手动导出可显式传 false。
    silent: opts.silent !== false,
    download: opts.download === true,
  }
  if (format) request.format = format
  if (typeof opts.outputDir === 'string' && opts.outputDir.trim() !== '') {
    request.outputDir = opts.outputDir.trim().slice(0, 512)
  }
  const warnings = []
  let targetLufs = undefined
  if (opts.targetLufs !== undefined && opts.targetLufs !== null) {
    const numeric = Number(opts.targetLufs)
    if (!Number.isFinite(numeric) || numeric < -24 || numeric > -5) {
      fail('targetLufs 必须在 -24..-5 LUFS 之间（如 -14）')
    }
    targetLufs = Math.round(numeric * 10) / 10
    request.targetLufs = targetLufs
    // 契约：LUFS 目标与 normalize 同时传时以 targetLufs 为主
    if (opts.normalize === true) warnings.push('同时传了 normalize 与 targetLufs：以 targetLufs 目标归一为主，忽略 normalize')
  }
  const readBar = (value, field) => {
    if (value === undefined || value === null) return undefined
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < 0) fail(`${field} 必须是 >= 0 的数字（小节）`)
    return Math.min(LIMITS.maxBars, Math.round(numeric))
  }
  const fromBar = readBar(opts.fromBar, 'fromBar')
  const toBar = readBar(opts.toBar, 'toBar')
  if (fromBar !== undefined && toBar !== undefined && toBar <= fromBar) fail('toBar 必须大于 fromBar')
  if (fromBar !== undefined) request.fromBar = fromBar
  if (toBar !== undefined) request.toBar = toBar
  const rawTail = Number(opts.tailSeconds)
  const tailSeconds = opts.tailSeconds === undefined || opts.tailSeconds === null
    ? 0
    : Math.min(8, Math.max(0, rawTail))
  if (!Number.isFinite(tailSeconds)) fail('tailSeconds 必须是 0..8 的数字（秒）')
  request.tailSeconds = Math.round(tailSeconds * 1000) / 1000
  request.normalize = targetLufs === undefined && opts.normalize === true
  if (typeof opts.name === 'string' && opts.name.trim() !== '') {
    request.name = opts.name.trim().slice(0, 120)
  }
  // v2.1：若已有未完成请求，先保留到 exportJobs，旧 job 的 /export-done 仍能找到（不会报找不到任务）。
  if (isObject(project.exportRequest) && typeof project.exportRequest.jobId === 'string' && project.exportRequest.status === 'pending') {
    project.exportJobs = normalizeExportJobs([project.exportRequest, ...(Array.isArray(project.exportJobs) ? project.exportJobs : [])])
  }
  project.exportRequest = request
  return {
    requested: true,
    seq,
    jobId,
    status: 'pending',
    ...(format ? { format } : {}),
    ...(request.outputDir ? { outputDir: request.outputDir } : {}),
    tailSeconds: request.tailSeconds,
    normalize: request.normalize,
    ...(targetLufs !== undefined ? { targetLufs } : {}),
    ...(request.name ? { name: request.name } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/* ------------------------------------------------------------------------- */
/* R0A：导出任务状态（pending → success/error，最近 10 条）                    */
/* ------------------------------------------------------------------------- */

/** 查询导出任务：优先当前 exportRequest，再查 exportJobs（最新在前）。 */
/**
 * v2.1：多客户端导出 claim（只有首个 claim 渲染，其余只轮询结果）。
 * @returns {{claimed:boolean, claimedBy:string|null, jobId:string}}
 */
export function claimExport(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const jobId = requireString(args.jobId, 'jobId', { max: 64 })
  const clientId = requireString(args.clientId, 'clientId', { max: 64 })
  const current = isObject(project.exportRequest) ? project.exportRequest : null
  if (!current || current.jobId !== jobId) {
    return { claimed: false, claimedBy: current?.claimedBy ?? null, jobId }
  }
  if (!current.claimable) return { claimed: false, claimedBy: null, jobId }
  if (typeof current.claimedBy === 'string' && current.claimedBy !== '' && current.claimedBy !== clientId) {
    return { claimed: false, claimedBy: current.claimedBy, jobId }
  }
  current.claimedBy = clientId
  current.claimedAt = Date.now()
  return { claimed: true, claimedBy: clientId, jobId }
}

export function getExportStatus(project, jobId) {
  const target = typeof jobId === 'string' && jobId.trim() !== '' ? jobId.trim() : null
  const current = isObject(project.exportRequest) ? project.exportRequest : null
  const history = Array.isArray(project.exportJobs) ? project.exportJobs : []
  if (target) {
    if (current && current.jobId === target) {
      return { found: true, job: normalizeExportJobs([current])[0] ?? current }
    }
    const found = history.find((job) => job.jobId === target)
    return found ? { found: true, job: found } : { found: false, job: null }
  }
  if (current) return { found: true, job: normalizeExportJobs([current])[0] ?? current }
  return { found: history.length > 0, job: history[0] ?? null }
}

/**
 * 完成/失败一个导出任务：从 exportRequest 移入 exportJobs（最近 10 条），并清空当前请求。
 * @param {{jobId?:string, status:'success'|'error', path?:string, name?:string, bytes?:number, seconds?:number, format?:string, error?:string}} payload
 * @returns {{job:object}}
 */
export function completeExportJob(project, payload = {}) {
  if (!isObject(payload)) fail('导出任务参数必须是对象')
  const status = payload.status === 'success' ? 'success' : payload.status === 'error' ? 'error' : null
  if (!status) fail(`导出任务状态非法：${String(payload.status)}`)
  const requestedId = typeof payload.jobId === 'string' && payload.jobId.trim() !== '' ? payload.jobId.trim() : null
  const current = isObject(project.exportRequest) ? project.exportRequest : null
  const history = Array.isArray(project.exportJobs) ? project.exportJobs : []
  let sourceJob = null
  if (requestedId) {
    if (current && current.jobId === requestedId) sourceJob = current
    else sourceJob = history.find((job) => job.jobId === requestedId) ?? null
    if (!sourceJob) fail(`找不到导出任务 jobId=${requestedId}`)
  } else {
    sourceJob = current
    if (!sourceJob) fail('没有进行中的导出任务（缺少 exportRequest）')
  }
  const base = normalizeExportJobs([sourceJob])[0] ?? sourceJob
  const job = {
    ...base,
    status,
    finishedAt: Date.now(),
  }
  if (status === 'success') {
    if (typeof payload.path === 'string' && payload.path.trim() !== '') job.path = payload.path.trim().slice(0, 512)
    if (typeof payload.name === 'string' && payload.name.trim() !== '') job.name = payload.name.trim().slice(0, 160)
    if (Number.isFinite(Number(payload.bytes))) job.bytes = Math.max(0, Math.trunc(Number(payload.bytes)))
    if (Number.isFinite(Number(payload.seconds))) job.seconds = Math.max(0, Math.round(Number(payload.seconds) * 100) / 100)
    if (typeof payload.format === 'string' && payload.format !== '') job.format = payload.format
    // v2.1：响度/峰值指标（容错：仅有限数值写入）
    for (const key of ['achievedLufs', 'peak', 'peakDb', 'truePeak', 'truePeakDb', 'gainDb']) {
      const numeric = Number(payload[key])
      if (Number.isFinite(numeric)) job[key] = Math.round(numeric * 100) / 100
    }
    if (typeof payload.limited === 'boolean') job.limited = payload.limited
  } else {
    job.error = (typeof payload.error === 'string' && payload.error.trim() !== '' ? payload.error.trim() : '导出失败').slice(0, 512)
  }
  if (current && current.jobId === job.jobId) project.exportRequest = null
  project.exportJobs = normalizeExportJobs([job, ...history.filter((item) => item.jobId !== job.jobId)])
  return { job }
}

/** 标记导出失败（对外语义化封装）。 */
export function failExportJob(project, payload = {}) {
  return completeExportJob(project, { ...payload, status: 'error' })
}

/**
 * 记录最近一次导出（由 routes 的 /export-done 调用，模型侧也会从概览看到）。
 * @returns { lastExport }
 */
export function setLastExport(project, payload = {}) {
  if (!isObject(payload)) fail('导出信息必须是对象')
  const filePath = requireString(payload.path, 'path', { max: 512 })
  const bytes = requireNumber(payload.bytes ?? 0, 'bytes', { min: 0 })
  const seconds = Number(payload.seconds)
  project.lastExport = {
    path: filePath,
    at: payload.at === undefined ? Date.now() : Number(payload.at),
    bytes: Math.round(bytes),
    seconds: Number.isFinite(seconds) && seconds >= 0 ? round(seconds, 2) : 0,
    ...Object.fromEntries(['achievedLufs', 'peak', 'peakDb', 'truePeak', 'truePeakDb', 'gainDb']
      .map((key) => [key, Math.round(Number(payload[key]) * 100) / 100])
      .filter(([, value]) => Number.isFinite(value))),
    ...(typeof payload.limited === 'boolean' ? { limited: payload.limited } : {}),
  }
  return { lastExport: project.lastExport }
}

/* ------------------------------------------------------------------------- */
/* R0A：小节结构编辑（插入/删除小节，同步 clips/automation/sections/tempoMap）  */
/* ------------------------------------------------------------------------- */

/** 把 beat 夹到 [0, maxBeat]。 */
function clampBeat(beat, maxBeat) {
  const numeric = Number(beat)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(maxBeat, Math.max(0, round(numeric, 6)))
}

/** 平移/裁剪所有自动化曲线（track + master）。 */
function shiftAutomationBars(project, barBeats, mutateBeat) {
  const apply = (automation) => {
    if (!isObject(automation)) return
    for (const curve of Object.values(automation)) {
      if (!isObject(curve) || !Array.isArray(curve.points)) continue
      curve.points = curve.points
        .map((point) => ({ ...point, beat: mutateBeat(Number(point.beat) || 0) }))
        .filter((point) => point.beat !== null)
        .sort((a, b) => a.beat - b.beat)
    }
  }
  for (const track of project.tracks) apply(track.automation)
  apply(project.master?.automation)
}

/**
 * studio_insert_bars：在 atBar 处插入 count 小节。
 * - clips：起点 >= atBar 右移；跨边界片段长度 +count；
 * - automation / tempoMap：beat >= atBar*barBeats 右移 count*barBeats；
 * - sections：起点 >= atBar 右移；跨边界段落长度 +count；
 * @returns {{atBar:number,count:number,lengthBars:number,clips:number,sections:number,tempoPoints:number}}
 */
export function insertBars(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const barBeats = Math.max(1, beatsPerBar(project))
  const oldBars = Math.max(1, Number(project.lengthBars) || 32)
  const atBar = requireNumber(args.atBar, 'atBar', { min: 0, max: oldBars, integer: true })
  const count = requireNumber(args.count, 'count', { min: 1, max: LIMITS.maxBars, integer: true })
  if (oldBars + count > LIMITS.maxBars) fail(`插入后曲长 ${oldBars + count} 超过上限 ${LIMITS.maxBars}`)
  const shiftBeats = count * barBeats
  const atBeat = atBar * barBeats
  const maxBeat = (oldBars + count) * barBeats
  let clipCount = 0
  for (const clip of project.clips) {
    const start = Number(clip.startBar) || 0
    const length = Number(clip.lengthBars) || 1
    if (start >= atBar) {
      clip.startBar = start + count
      clipCount += 1
    } else if (start + length > atBar) {
      clip.lengthBars = length + count
      clipCount += 1
    }
  }
  let sectionCount = 0
  for (const section of project.sections) {
    const start = Number(section.startBar) || 0
    const length = Number(section.lengthBars) || 1
    if (start >= atBar) {
      section.startBar = start + count
      sectionCount += 1
    } else if (start + length > atBar) {
      section.lengthBars = length + count
      sectionCount += 1
    }
  }
  shiftAutomationBars(project, barBeats, (beat) => (beat >= atBeat ? clampBeat(beat + shiftBeats, maxBeat) : beat))
  let tempoPoints = 0
  if (Array.isArray(project.tempoMap)) {
    for (const point of project.tempoMap) {
      if (Number(point.beat) >= atBeat) {
        point.beat = clampBeat(Number(point.beat) + shiftBeats, maxBeat)
        tempoPoints += 1
      }
    }
    project.tempoMap.sort((a, b) => a.beat - b.beat)
  }
  project.lengthBars = oldBars + count
  return { atBar, count, lengthBars: project.lengthBars, clips: clipCount, sections: sectionCount, tempoPoints }
}

/**
 * studio_delete_bars：删除 [atBar, atBar+count) 小节。
 * - clips：完全在删除区 → 移除；跨边界 → 裁剪/拼接（删除中段时前后合并）；
 * - automation / tempoMap：删除区内点移除，之后 beat 左移 count*barBeats；
 * - sections：完全在删除区 → 移除；跨边界裁剪/拼接。
 * @returns {{atBar:number,count:number,lengthBars:number,removedClips:number,removedSections:number,removedTempoPoints:number}}
 */
export function deleteBars(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const barBeats = Math.max(1, beatsPerBar(project))
  const oldBars = Math.max(1, Number(project.lengthBars) || 32)
  const atBar = requireNumber(args.atBar, 'atBar', { min: 0, max: oldBars - 1, integer: true })
  const count = requireNumber(args.count, 'count', { min: 1, max: oldBars, integer: true })
  if (atBar + count > oldBars) fail(`删除范围超出曲长（atBar=${atBar} + count=${count} > ${oldBars}）`)
  if (oldBars - count < 1) fail('不能删除全部小节（删除后至少保留 1 小节）')
  const shiftBeats = count * barBeats
  const atBeat = atBar * barBeats
  const endBeat = (atBar + count) * barBeats
  const maxBeat = (oldBars - count) * barBeats
  const deleteEndBar = atBar + count
  let removedClips = 0
  project.clips = project.clips.filter((clip) => {
    const start = Number(clip.startBar) || 0
    const length = Number(clip.lengthBars) || 1
    const end = start + length
    if (end <= atBar) return true
    if (start >= deleteEndBar) {
      // 删除区之后的片段整体左移 count。
      clip.startBar = start - count
      return true
    }
    if (start >= atBar && end <= deleteEndBar) {
      removedClips += 1
      return false
    }
    // 跨边界：删除中段 → 前后拼接；只覆盖一侧 → 裁剪。
    const keepBefore = Math.max(0, atBar - start)
    const keepAfter = Math.max(0, end - deleteEndBar)
    const nextLength = keepBefore + keepAfter
    if (nextLength <= 0) {
      removedClips += 1
      return false
    }
    clip.startBar = Math.min(start, atBar)
    clip.lengthBars = nextLength
    return true
  })
  let removedSections = 0
  project.sections = project.sections.filter((section) => {
    const start = Number(section.startBar) || 0
    const length = Number(section.lengthBars) || 1
    const end = start + length
    if (end <= atBar) return true
    if (start >= deleteEndBar) {
      // 删除区之后的段落整体左移 count。
      section.startBar = start - count
      return true
    }
    if (start >= atBar && end <= deleteEndBar) {
      removedSections += 1
      return false
    }
    const keepBefore = Math.max(0, atBar - start)
    const keepAfter = Math.max(0, end - deleteEndBar)
    const nextLength = keepBefore + keepAfter
    if (nextLength <= 0) {
      removedSections += 1
      return false
    }
    section.startBar = Math.min(start, atBar)
    section.lengthBars = nextLength
    return true
  })
  let removedPoints = 0
  shiftAutomationBars(project, barBeats, (beat) => {
    if (beat >= atBeat && beat < endBeat) {
      removedPoints += 1
      return null
    }
    return beat >= endBeat ? clampBeat(beat - shiftBeats, maxBeat) : beat
  })
  let removedTempoPoints = 0
  if (Array.isArray(project.tempoMap)) {
    const kept = []
    for (const point of project.tempoMap) {
      const beat = Number(point.beat) || 0
      if (beat >= atBeat && beat < endBeat) {
        removedTempoPoints += 1
        continue
      }
      point.beat = beat >= endBeat ? clampBeat(beat - shiftBeats, maxBeat) : beat
      kept.push(point)
    }
    kept.sort((a, b) => a.beat - b.beat)
    project.tempoMap = kept
    if (kept.length === 0) delete project.tempoMap
  }
  project.lengthBars = oldBars - count
  return {
    atBar,
    count,
    lengthBars: project.lengthBars,
    removedClips,
    removedSections,
    removedTempoPoints,
  }
}

/**
 * R0A：整份工程 JSON 导入（replace=true；schema2 校验 + 上限检查）。
 * @param {object} project state.mutate draft
 * @param {object} nextProject 导入的工程 JSON
 * @param {{replace?:boolean, title?:string}} [options]
 */
export function importProjectJson(project, nextProject, options = {}) {
  if (!isObject(nextProject)) fail('project 必须是工程对象（schemaVersion 3）')
  const replace = options.replace !== false
  if (!replace) fail('studio_import_project_json 暂只支持 replace=true（整份替换）；追加请用 batch/MIDI 导入')
  if (Number(nextProject.schemaVersion) === 2) {
    fail('工程 schemaVersion 为 2（旧格式）：请先打开该工程完成一次性迁移，或传 schemaVersion=3 的工程 JSON；studio_import_project_json 不做静默迁移')
  }
  if (Number(nextProject.schemaVersion) !== SCHEMA_VERSION) {
    fail(`工程 schemaVersion 必须为 ${SCHEMA_VERSION}（收到 ${nextProject.schemaVersion ?? '未知'}）；v1/其它旧版本不兼容`)
  }
  let fresh
  try {
    fresh = normalizeProject(structuredClone(nextProject))
  } catch (error) {
    fail(`工程数据非法：${error?.message ?? error}`)
  }
  const checks = [
    ['tracks', LIMITS.maxTracks],
    ['patterns', LIMITS.maxPatterns],
    ['clips', LIMITS.maxClips],
    ['sections', LIMITS.maxSections],
  ]
  for (const [key, max] of checks) {
    if (!Array.isArray(fresh[key])) fail(`工程字段 ${key} 必须是数组`)
    if (fresh[key].length > max) fail(`工程 ${key} 数量 ${fresh[key].length} 超过上限 ${max}`)
  }
  for (const pattern of fresh.patterns) {
    if (Array.isArray(pattern.notes) && pattern.notes.length > LIMITS.maxNotesPerPattern) {
      fail(`pattern「${pattern.name}」音符数 ${pattern.notes.length} 超过上限 ${LIMITS.maxNotesPerPattern}`)
    }
  }
  if (typeof options.title === 'string' && options.title.trim() !== '') fresh.title = options.title.trim().slice(0, 120)
  fresh.schemaVersion = SCHEMA_VERSION
  fresh.revision = project.revision
  fresh.updatedAt = project.updatedAt
  replaceInPlace(project, fresh)
  return {
    title: project.title,
    lengthBars: project.lengthBars,
    tracks: project.tracks.length,
    patterns: project.patterns.length,
    clips: project.clips.length,
    notes: project.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0),
  }
}

/**
 * studio_set_activity：更新 UI 顶部「AI 正在做什么」。
 * @returns { text }
 */
export function setActivity(project, args = {}) {
  if (!isObject(args)) fail('参数必须是对象')
  const text = requireString(args.text, 'text', { max: MAX_ACTIVITY })
  project.activity = { text, at: Date.now() }
  return { text }
}

/* ------------------------------------------------------------------------- */
/* UI 操作（POST /studio/api/action）                                          */
/* ------------------------------------------------------------------------- */

/**
 * 处理 UI 发来的轨道操作（静音/独奏/音量/声像）。
 * @returns { type, trackId, value }
 */
export function applyAction(project, body = {}) {
  if (!isObject(body)) fail('请求体必须是 JSON 对象')
  const type = requireString(body.type, 'type', { max: 32 })
  const track = getTrack(project, body.trackId)
  switch (type) {
    case 'toggleMute': {
      track.mute = !track.mute
      return { type, trackId: track.id, value: track.mute }
    }
    case 'toggleSolo': {
      track.solo = !track.solo
      return { type, trackId: track.id, value: track.solo }
    }
    case 'setVolume': {
      // UI 推子可能给出越界值：钳制而不是报错。
      const value = clamp01(strictFiniteNumber(body.value, 'value'))
      track.volume = value
      return { type, trackId: track.id, value: round(track.volume, 4) }
    }
    case 'setPan': {
      const value = clampPan(strictFiniteNumber(body.value, 'value'))
      track.pan = value
      return { type, trackId: track.id, value: round(track.pan, 4) }
    }
    default:
      fail(`不支持的操作 type=${type}；可选：toggleMute / toggleSolo / setVolume / setPan`)
  }
}

/** 直接读取某轨道的当前值（方便 routes / 测试做断言）。 */
export function getTrackState(project, trackId) {
  const track = getTrack(project, trackId)
  return trackSummary(track)
}

/** 项目节拍数（供 routes 计算导出时长等，避免各处重复 import）。 */
export function projectBeatsPerBar(project) {
  return beatsPerBar(project)
}
