/**
 * AI 音乐工作室 — 共享项目模型工具（唯一权威）。
 * Host 与 Client 都从这里构造/统计项目，不要重复实现。
 */
import {
  DRUM_KITS, DRUM_PIECES, FX_PARAM_SPECS, FX_TYPES, SCALES, SYNTH_INSTRUMENTS, SYNTH_INSTRUMENT_PARAM_SPECS, SYNTH_PRESETS, TRACK_COLORS,
  findDrumKit, findDrumPiece, findFxType, findScale, findSynthInstrument, findSynthPreset,
  kitParams, presetParams, fxDefaultParams, NOTE_NAMES, LIMITS,
} from './catalog.js'
import { createTempoMap, normalizeTempoPoints, projectDurationSeconds } from './tempo.js'

/** 当前工程文件 schema 版本（R1b：v3 前向兼容格式；v2 一次性迁移，v1 不兼容）。 */
export const SCHEMA_VERSION = 3
/** 工程 format 元信息标识（v3 起写顶层 format）。 */
export const PROJECT_FORMAT_NAME = 'aims'
/** 可一次性迁移到当前版本的旧 schema 版本。 */
export const MIGRATABLE_SCHEMA_VERSIONS = Object.freeze([2])

/** 新建工程的默认 format 元信息。 */
export function createProjectFormat(options = {}) {
  const migratedFrom = Number(options.migratedFrom)
  const migratedAt = Number(options.migratedAt)
  const warnings = Array.isArray(options.migrationWarnings)
    ? options.migrationWarnings.filter((item) => typeof item === 'string' && item.trim() !== '')
    : []
  return {
    name: PROJECT_FORMAT_NAME,
    version: SCHEMA_VERSION,
    ...(warnings.length > 0 ? { migrationWarnings: warnings } : {}),
    // migratedFrom 只接受合法的旧版本号（1..SCHEMA_VERSION-1；通常为 2）。
    ...(Number.isInteger(migratedFrom) && migratedFrom > 0 && migratedFrom < SCHEMA_VERSION ? { migratedFrom } : {}),
    ...(Number.isFinite(migratedAt) && migratedAt > 0 ? { migratedAt } : {}),
  }
}

/** 规范化 format 元信息（强制 name/version；迁移字段合法才保留）。 */
export function normalizeProjectFormat(raw) {
  const format = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return createProjectFormat({
    ...(Array.isArray(format.migrationWarnings)
      ? { migrationWarnings: format.migrationWarnings.filter((item) => typeof item === 'string' && item.trim() !== '') }
      : {}),
    ...(Number.isInteger(Number(format.migratedFrom)) && Number(format.migratedFrom) > 0
      ? { migratedFrom: Number(format.migratedFrom) }
      : {}),
    ...(Number.isFinite(Number(format.migratedAt)) && Number(format.migratedAt) > 0
      ? { migratedAt: Number(format.migratedAt) }
      : {}),
  })
}

/**
 * R1b：把 v2 工程迁移为 v3（不就地修改入参；调用方需再 normalizeProject）。
 * v3 入参返回结构化克隆并补 format（幂等）；v1/其它抛 SchemaVersionError。
 * @param {object} input
 * @param {{now?:number}} [options]
 * @returns {object} schemaVersion=3 + format 的新对象
 */
export function migrateProjectV2toV3(input, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new SchemaVersionError(input?.schemaVersion)
  }
  const version = Number(input.schemaVersion)
  if (version === SCHEMA_VERSION) {
    const cloned = structuredClone(input)
    cloned.format = normalizeProjectFormat(input.format)
    return cloned
  }
  if (!MIGRATABLE_SCHEMA_VERSIONS.includes(version)) throw new SchemaVersionError(version)
  const cloned = structuredClone(input)
  cloned.schemaVersion = SCHEMA_VERSION
  cloned.format = createProjectFormat({
    migratedFrom: version,
    migratedAt: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
    migrationWarnings: migrationLoudnessWarnings(cloned),
  })
  return cloned
}

/** 旧版 schema 错误：旧工程文件不再兼容（不做迁移）。 */
export class SchemaVersionError extends Error {
  constructor(version) {
    const seen = version === undefined || version === null ? '未知' : String(version)
    super(`旧版本工程不支持（schemaVersion ${seen}），本项目已不再兼容旧文件（当前 schemaVersion ${SCHEMA_VERSION}）`)
    this.name = 'SchemaVersionError'
    this.code = 'UNSUPPORTED_SCHEMA'
    this.schemaVersion = version ?? null
  }
}

/** 判断是否为旧 schema 错误。 */
export const isSchemaVersionError = (error) => error?.code === 'UNSUPPORTED_SCHEMA' || error instanceof SchemaVersionError

/** 简单 id 生成器；host 维护计数器，client 只读。 */
export function makeIdGen(project) {
  const counters = {}
  const next = (prefix) => {
    if (counters[prefix] === undefined) {
      let max = 0
      const re = new RegExp(`^${prefix}_(\\d+)$`)
      const scan = (arr) => {
        for (const item of arr ?? []) {
          const m = re.exec(item?.id ?? '')
          if (m) max = Math.max(max, Number(m[1]))
        }
      }
      scan(project?.tracks)
      scan(project?.media)
      scan(project?.patterns)
      scan(project?.clips)
      scan(project?.sections)
      scan(project?.master?.effects)
      for (const t of project?.tracks ?? []) scan(t.effects)
      // P2c-2：返回总线（reverb/delay）也有 FX 链，id 需要一并扫描避免冲突。
      if (project?.buses !== null && typeof project?.buses === 'object') {
        scan(project.buses.reverb?.effects)
        scan(project.buses.delay?.effects)
      }
      // v2.1：Group bus FX 也纳入全局 id 扫描，避免跨链重复 fx_N。
      for (const group of project?.groups ?? []) scan(group?.effects)
      counters[prefix] = max
    }
    counters[prefix] += 1
    return `${prefix}_${counters[prefix]}`
  }
  return next
}

export const beatsPerBar = (project) => (Array.isArray(project?.timeSignature) ? project.timeSignature[0] : 4)

/** MIDI 音高 → 频率（A4=440）。 */
export function pitchToFreq(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

/** MIDI 音高 → 音名，如 69 → "A4"。 */
export function noteName(pitch) {
  const p = Math.max(0, Math.min(127, Math.round(pitch)))
  return `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`
}

/** 音名（如 "F#"）→ pitch class 0..11。 */
export function keyToPitchClass(key) {
  const idx = NOTE_NAMES.indexOf(String(key).toUpperCase().replace('♯', '#'))
  return idx >= 0 ? idx : 0
}

/** 音阶内音级 → 绝对半音（相对主音）。 */
export function scaleDegree(scaleId, degree) {
  const scale = findScale(scaleId) ?? findScale('minor')
  const steps = scale.steps
  const n = steps.length
  const octave = Math.floor(degree / n)
  const idx = ((degree % n) + n) % n
  return steps[idx] + octave * 12
}

/** 判断某音高是否在给定调内。 */
export function inKey(project, pitch) {
  const scale = findScale(project?.scale) ?? findScale('minor')
  const root = keyToPitchClass(project?.key ?? 'C')
  return scale.steps.includes((pitch - root - 0 + 120) % 12)
}

/* ------------------------------------------------------------------------- */
/* 自动化曲线（P2a）                                                          */
/*                                                                            */
/* track.automation = { volume:{enabled,points}, pan:{...}, cutoff:{...} }    */
/* master.automation = { volume:{...} }（master 只支持 volume）                */
/* 点：{ beat: 绝对 beat, value: 0..1 归一化 }；引擎/UI 负责 value→实际参数。  */
/* ------------------------------------------------------------------------- */

/** 每个自动化参数最多点数。 */
export const AUTOMATION_MAX_POINTS = 256
/** 自动化 value 的归一化范围（所有参数统一 0..1）。 */
export const AUTOMATION_VALUE_MIN = 0
export const AUTOMATION_VALUE_MAX = 1
/** 概览（studio_get_project）里每条曲线最多返回的点数（大小防护）。 */
export const AUTOMATION_OVERVIEW_MAX_POINTS = 24

/**
 * 自动化参数规格：label / 适用目标 / 映射说明 / value→实际参数的纯函数映射。
 * 引擎（实时与离线）与 UI 都应使用这里的映射，保证听感一致。
 */
export const AUTOMATION_PARAMS = {
  volume: {
    id: 'volume',
    label: '音量',
    hint: 'value → 轨道音量（0..1）；master 音量也使用该参数',
    targets: ['track', 'master'],
    /** value(0..1) → 实际音量 0..1 */
    map: (value) => clamp01(value),
    format: (value) => `${Math.round(clamp01(value) * 100)}%`,
  },
  pan: {
    id: 'pan',
    label: '声像',
    hint: 'value×2−1 → 声像（−1 左 / 0 中 / 1 右）',
    targets: ['track'],
    /** value(0..1) → pan(-1..1) */
    map: (value) => clampPan(clamp01(value) * 2 - 1),
    format: (value) => {
      const pan = clampPan(clamp01(value) * 2 - 1)
      if (Math.abs(pan) < 0.005) return 'C'
      return pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`
    },
  },
  cutoff: {
    id: 'cutoff',
    label: '滤波截止',
    hint: '80×(16000/80)^value Hz（对数映射：0→80Hz、1→16000Hz），作用于该轨道效果器链中第一个 filter',
    targets: ['track'],
    /** value(0..1) → cutoff Hz(80..16000) 对数映射 */
    map: (value) => 80 * Math.pow(16000 / 80, clamp01(value)),
    format: (value) => `${Math.round(80 * Math.pow(16000 / 80, clamp01(value)))} Hz`,
  },
  // P13：表情类自动化（value 统一 0..1；仅轨道；引擎在音符起始采样）
  pitchBend: {
    id: 'pitchBend',
    label: '弯音',
    hint: 'value → −2..+2 半音（map: value×4−2）；引擎在音符起始应用',
    targets: ['track'],
    /** value(0..1) → 半音 -2..+2 */
    map: (value) => {
      const semitones = clamp01(value) * 4 - 2
      return Math.round(semitones * 1000) / 1000
    },
    format: (value) => `${(clamp01(value) * 4 - 2).toFixed(2)} st`,
  },
  modulation: {
    id: 'modulation',
    label: '调制',
    hint: 'value → 0..100 cents 揉弦深度（与 track.vibrato.rateHz 配合，默认 5Hz）',
    targets: ['track'],
    /** value(0..1) → 揉弦深度 cents 0..100 */
    map: (value) => Math.round(clamp01(value) * 1000) / 10,
    format: (value) => `${Math.round(clamp01(value) * 100)} cents`,
  },
  expression: {
    id: 'expression',
    label: '表情',
    hint: 'value → 音符增益 0..1（aftertouch/表情）',
    targets: ['track'],
    /** value(0..1) → 增益 0..1 */
    map: (value) => clamp01(value),
    format: (value) => `${Math.round(clamp01(value) * 100)}%`,
  },
  // R3b：MIDI CC lanes（复用 automation 结构：points value 统一 0..1，CC 值按 round(value*127) 显示/导出）。
  cc1: {
    id: 'cc1',
    label: 'CC1 调制',
    hint: 'MIDI CC1（Modulation，0..127 → value/127）；引擎与 modulation 曲线叠加揉弦，总深度 ≤100 cents',
    targets: ['track'],
    cc: 1,
    color: '#8B5CF6',
    /** value(0..1) → 0..127 */
    map: (value) => clamp01(value) * 127,
    format: (value) => `CC1 ${Math.round(clamp01(value) * 127)}`,
  },
  cc11: {
    id: 'cc11',
    label: 'CC11 表情',
    hint: 'MIDI CC11（Expression，0..127 → value/127）；引擎与 expression 曲线相乘作为音符增益',
    targets: ['track'],
    cc: 11,
    color: '#F59E0B',
    map: (value) => clamp01(value) * 127,
    format: (value) => `CC11 ${Math.round(clamp01(value) * 127)}`,
  },
  cc64: {
    id: 'cc64',
    label: 'CC64 延音',
    hint: 'MIDI CC64（Sustain 数据曲线，0..127 → value/127）；仅存储/导出，听感请用 studio_set_sustain',
    targets: ['track'],
    cc: 64,
    color: '#10B981',
    map: (value) => clamp01(value) * 127,
    format: (value) => `CC64 ${Math.round(clamp01(value) * 127)}`,
  },
  cc74: {
    id: 'cc74',
    label: 'CC74 亮度',
    hint: 'MIDI CC74（Brightness，0..127 → value/127）；无 cutoff 曲线时引擎映射到 filter cutoff（80..16000Hz）',
    targets: ['track'],
    cc: 74,
    color: '#06B6D4',
    map: (value) => 80 * Math.pow(16000 / 80, clamp01(value)),
    format: (value) => `${Math.round(80 * Math.pow(16000 / 80, clamp01(value)))} Hz`,
  },
}

/** R3b：CC 编号 → automation 参数 id。 */
export const AUTOMATION_CC_PARAMS = Object.freeze({ 1: 'cc1', 11: 'cc11', 64: 'cc64', 74: 'cc74' })
/** R3b：4 个 CC lane 参数 id。 */
export const AUTOMATION_CC_PARAM_IDS = Object.freeze(['cc1', 'cc11', 'cc64', 'cc74'])

/** 全部自动化参数 id（volume / pan / cutoff）。 */
export const AUTOMATION_PARAM_IDS = Object.keys(AUTOMATION_PARAMS)

/** 某个参数是否允许作用于 target（'track' | 'master'）。 */
export function automationParamSupports(param, target) {
  const spec = AUTOMATION_PARAMS[param]
  return Boolean(spec && Array.isArray(spec.targets) && spec.targets.includes(target))
}

/**
 * 把任意点数组清洗成规范化点：只保留有限数字、按 beat 升序、重复 beat 后者覆盖。
 * @param {Array<{beat:number,value:number}>} points
 * @param {{clampBeat?:number}} [options] 提供 clampBeat 时把 beat 夹到 [0, clampBeat]
 * @returns {{beat:number,value:number}[]}
 */
export function normalizeAutomationPoints(points, options = {}) {
  if (!Array.isArray(points)) return []
  const clampBeat = Number.isFinite(Number(options.clampBeat)) ? Math.max(0, Number(options.clampBeat)) : null
  const cleaned = []
  for (const point of points) {
    if (point === null || typeof point !== 'object' || Array.isArray(point)) continue
    let beat = Number(point.beat)
    const value = Number(point.value)
    if (!Number.isFinite(beat) || !Number.isFinite(value)) continue
    if (clampBeat !== null) beat = clamp(beat, 0, clampBeat)
    cleaned.push({ beat, value: clamp01(value) })
  }
  // 稳定排序：相同 beat 保持输入顺序，便于「后者覆盖」
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
 * 规范化单条自动化曲线（{enabled, points}）。
 * @param {object} raw
 * @param {{maxBeat?:number}} [options]
 * @returns {{enabled:boolean, points:{beat:number,value:number}[]}}
 */
export function normalizeAutomationCurve(raw, options = {}) {
  const maxBeat = Number.isFinite(Number(options.maxBeat))
    ? Math.max(1, Number(options.maxBeat))
    : LIMITS.maxBars * beatsPerBar(null)
  const points = normalizeAutomationPoints(raw?.points, { clampBeat: maxBeat }).slice(0, AUTOMATION_MAX_POINTS)
  return { enabled: raw?.enabled !== false, points }
}

/**
 * 规范化整个 automation 对象：
 * - 只保留 AUTOMATION_PARAMS 中的已知参数；
 * - 每个参数规范化 enabled / points（排序、重复覆盖、夹紧、最多 256 点）；
 * - 无有效参数时返回 {}。
 * @param {object} raw 轨道或 master 的 automation
 * @param {{maxBeat?:number, allowed?:string[]}} [options]
 * @returns {object}
 */
export function normalizeAutomation(raw, options = {}) {
  const output = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return output
  const allowed = Array.isArray(options.allowed) ? options.allowed : AUTOMATION_PARAM_IDS
  for (const param of allowed) {
    if (!AUTOMATION_PARAMS[param]) continue
    const curve = raw[param]
    if (curve === null || typeof curve !== 'object' || Array.isArray(curve)) continue
    output[param] = normalizeAutomationCurve(curve, { maxBeat: options.maxBeat })
  }
  return output
}

/**
 * 曲线线性插值：越界取端点；无有效点时返回 null（调用方据此判断「该参数无自动化」）。
 * @param {Array<{beat:number,value:number}>|{points:Array}} points
 * @param {number} beat 绝对 beat
 * @returns {number|null} 0..1 的值
 */
export function automationValueAt(points, beat) {
  const list = normalizeAutomationPoints(Array.isArray(points) ? points : points?.points)
  if (list.length === 0) return null
  const first = list[0]
  const last = list[list.length - 1]
  const x = Number.isFinite(Number(beat)) ? Number(beat) : 0
  if (x <= first.beat) return first.value
  if (x >= last.beat) return last.value
  for (let index = 1; index < list.length; index += 1) {
    const a = list[index - 1]
    const b = list[index]
    if (x <= b.beat) {
      const span = b.beat - a.beat
      if (span <= 0) return b.value
      const t = (x - a.beat) / span
      return a.value + (b.value - a.value) * t
    }
  }
  return last.value
}

/**
 * 规范化整个工程里的自动化（原地修改并返回同一对象）：
 * - 每条轨道：track.automation 只保留 volume/pan/cutoff，点按工程曲长（lengthBars×每小节 beat）夹紧；
 * - master：master.automation 只保留 volume；
 * - 无有效自动化时删除对应字段，保持工程 JSON 精简。
 * @param {object} project
 * @returns {object} project
 */
/**
 * v2.1：迁移旧工程时的响度/headroom 提示（不修改内容，只用于 UI 提示重新配平）。
 * 旧版预设响度归一化后同一工程可能整体偏响，需要用户重新配平混音。
 */
export function migrationLoudnessWarnings(project) {
  const warnings = ['预设响度已归一化，请重新配平混音（检查 master/轨道音量与 headroom）']
  const masterVolume = Number(project?.master?.volume)
  const loudTracks = Array.isArray(project?.tracks)
    ? project.tracks.filter((track) => Number(track?.volume) > 0.9)
    : []
  if ((Number.isFinite(masterVolume) && masterVolume > 0.9) || loudTracks.length > 0) {
    warnings.push('检测到 master/轨道音量偏高（>0.9），迁移后可能出现削波；建议先降低 master 音量并重新检查 peak/headroom')
  }
  return warnings
}

/**
 * v2.1：effectId 全局唯一化（master/返回总线/轨道/组链共享同一 fx_N 命名空间）。
 * 保留首次出现的合法 id；重复/非法 id 按全局最大序号重新分配。
 * @returns {{renumbered:number, maxSuffix:number}}
 */
export function normalizeGlobalEffectIds(project) {
  const seen = new Set()
  let maxSuffix = 0
  const collect = (effects) => {
    if (!Array.isArray(effects)) return
    for (const effect of effects) {
      const match = /^fx_(\d+)$/.exec(String(effect?.id ?? ''))
      if (match) maxSuffix = Math.max(maxSuffix, Number(match[1]))
    }
  }
  collect(project?.master?.effects)
  for (const bus of Object.values(project?.buses ?? {})) collect(bus?.effects)
  for (const track of project?.tracks ?? []) collect(track?.effects)
  for (const group of project?.groups ?? []) collect(group?.effects)
  let renumbered = 0
  const normalizeChain = (effects) => {
    if (!Array.isArray(effects)) return
    for (const effect of effects) {
      if (effect === null || typeof effect !== 'object' || Array.isArray(effect)) continue
      const current = String(effect.id ?? '')
      if (/^fx_(\d+)$/.test(current) && !seen.has(current)) {
        seen.add(current)
        continue
      }
      let next
      do {
        maxSuffix += 1
        next = `fx_${maxSuffix}`
      } while (seen.has(next))
      seen.add(next)
      effect.id = next
      renumbered += 1
    }
  }
  normalizeChain(project?.master?.effects)
  for (const busId of ['reverb', 'delay']) normalizeChain(project?.buses?.[busId]?.effects)
  for (const track of project?.tracks ?? []) normalizeChain(track?.effects)
  for (const group of project?.groups ?? []) normalizeChain(group?.effects)
  return { renumbered, maxSuffix }
}

export function normalizeProject(project) {
  if (project === null || typeof project !== 'object' || Array.isArray(project)) return project
  // R1b：v3 为唯一写入格式；v2 一次性迁移；v1/其它仍拒绝（调用方负责冷备份）。
  const sourceVersion = Number(project.schemaVersion)
  if (sourceVersion === SCHEMA_VERSION) {
    // 已是 v3
  } else if (MIGRATABLE_SCHEMA_VERSIONS.includes(sourceVersion)) {
    const migrated = migrateProjectV2toV3(project)
    project.schemaVersion = migrated.schemaVersion
    project.format = migrated.format
  } else {
    throw new SchemaVersionError(project.schemaVersion)
  }
  project.format = normalizeProjectFormat(project.format)
  const barBeats = Array.isArray(project.timeSignature) && Number.isFinite(Number(project.timeSignature[0]))
    ? Math.max(1, Number(project.timeSignature[0]))
    : 4
  const maxBeat = Math.max(1, Number(project.lengthBars) || 32) * barBeats
  // P12b：全局速度曲线（tempoMap）；缺省/空 = 常量 project.bpm（不写字段）。
  if (Object.hasOwn(project, 'tempoMap')) {
    const tempoMap = normalizeTempoPoints(project.tempoMap, { baseBpm: project.bpm, maxBeat })
    if (tempoMap.length > 0) project.tempoMap = tempoMap
    else delete project.tempoMap
  }
  if (Array.isArray(project.tracks)) {
    const trackIds = new Set(
      project.tracks
        .map((track) => (track !== null && typeof track === 'object' ? track.id : null))
        .filter((id) => typeof id === 'string' && id !== ''),
    )
    for (const track of project.tracks) {
      if (track === null || typeof track !== 'object' || Array.isArray(track)) continue
      // v2.2：轨道 FX 链统一规范化（vst3 只允许在链尾；内置效果器参数默认合并）。
      track.effects = normalizeEffects(track.effects, { max: LIMITS.maxEffectsPerTrack })
      const freeze = normalizeFreeze(track.freeze)
      if (freeze) track.freeze = freeze
      else delete track.freeze
      // v2.3 P2：插件参数自动化（P0 先做 normalize/持久化；工具在 P2 接）。
      const pluginAutomation = normalizePluginAutomation(track.pluginAutomation, { maxBeat: LIMITS.maxBars * 4 })
      if (Object.keys(pluginAutomation).length > 0) track.pluginAutomation = pluginAutomation
      else delete track.pluginAutomation
      const automation = normalizeAutomation(track.automation, { maxBeat })
      if (Object.keys(automation).length > 0) track.automation = automation
      else delete track.automation
      // P2b：侧链来源必须存在且不能是自身，否则丢弃
      const sidechain = normalizeSidechain(track.sidechain, { trackIds, selfId: track.id })
      if (sidechain) track.sidechain = sidechain
      else delete track.sidechain
      // P11：延音踏板 / 揉弦（缺省 = 无）。
      if (Object.hasOwn(track, 'sustain')) {
        const sustain = normalizeSustainPoints(track.sustain, { maxBeat })
        if (sustain.length > 0) track.sustain = sustain
        else delete track.sustain
      }
      if (Object.hasOwn(track, 'vibrato')) {
        const vibrato = normalizeVibrato(track.vibrato)
        if (vibrato) track.vibrato = vibrato
        else delete track.vibrato
      }
      // P14b：参考曲标记（默认 false 不写字段）。
      if (track.reference === true) track.reference = true
      else delete track.reference
      // R4b：发送点（默认 post 省略）/ 相位 / mono / FX 旁路 / 手动 PDC。
      if (track.sendMode === 'pre') track.sendMode = 'pre'
      else delete track.sendMode
      for (const flag of ['phaseInvert', 'mono', 'bypassFx']) {
        if (track[flag] === true) track[flag] = true
        else delete track[flag]
      }
      const pdcMs = normalizePdcMs(track.pdcMs)
      if (pdcMs > 0) track.pdcMs = pdcMs
      else delete track.pdcMs
      // R4d：自动化模式（read 默认省略；非法回 read）。
      if (TRACK_AUTOMATION_MODES.includes(track.automationMode) && track.automationMode !== 'read') {
        track.automationMode = track.automationMode
      } else {
        delete track.automationMode
      }
      // R5b：采样器乐器参数（仅 synth；全默认省略；非 synth 删除）。
      if (track.kind === 'synth') {
        const instrumentParams = normalizeInstrumentParams(track.instrumentParams)
        if (Object.keys(instrumentParams).length > 0) track.instrumentParams = instrumentParams
        else delete track.instrumentParams
      } else {
        delete track.instrumentParams
      }
      // R5d：引擎/合成器 preset/参数（sampler 默认省略；非 synth 删除）。
      if (track.kind === 'synth') {
        const engine = track.engine === 'subtractive' ? 'subtractive' : track.engine === 'vst3' ? 'vst3' : 'sampler'
        if (engine === 'subtractive' || engine === 'vst3') track.engine = engine
        else delete track.engine
        // v2.2：VST3 乐器轨（M1 只保存引用/参数，不接音频）。
        if (engine === 'vst3') {
          const vst3 = normalizeExternalPlugin(track.vst3)
          if (vst3) track.vst3 = { ...vst3, kind: 'instrument', isInstrument: true }
          else delete track.vst3
          delete track.synthPreset
          delete track.synthParams
          track.instrument = { ...(track.instrument && typeof track.instrument === 'object' ? track.instrument : {}), preset: null, kit: null }
          continue
        }
        delete track.vst3
        let synthPreset = typeof track.synthPreset === 'string' && findSynthInstrument(track.synthPreset)
          ? track.synthPreset
          : null
        if (engine === 'subtractive' && synthPreset === null) synthPreset = SYNTH_INSTRUMENTS[0].id
        if (synthPreset !== null) track.synthPreset = synthPreset
        else delete track.synthPreset
        if (synthPreset !== null) {
          const synthParams = normalizeSynthParams(track.synthParams, { preset: synthPreset })
          if (Object.keys(synthParams).length > 0) track.synthParams = synthParams
          else delete track.synthParams
        } else {
          delete track.synthParams
        }
        // v2.1：subtractive 轨不使用采样器 preset；instrument.preset 必须为 null（UI 按 synthPreset 显示）。
        const instrument = track.instrument !== null && typeof track.instrument === 'object' && !Array.isArray(track.instrument)
          ? { ...track.instrument }
          : { preset: null, kit: null, params: {} }
        if (engine === 'subtractive') {
          track.instrument = { ...instrument, preset: null, kit: null }
        } else if (instrument.preset === null || instrument.preset === undefined) {
          track.instrument = { ...instrument, preset: SYNTH_PRESETS[0].id, kit: null }
        } else {
          track.instrument = instrument
        }
      } else {
        delete track.engine
        delete track.synthPreset
        delete track.synthParams
        delete track.vst3
      }
      // P3b：音频轨固定 role='audio'、无 instrument（preset/kit 概念不适用）。
      if (track.kind === 'audio') {
        track.role = 'audio'
        delete track.instrument
        delete track.vst3
        if (typeof track.name !== 'string' || track.name.trim() === '') track.name = '音频轨'
      }
    }
  }
  if (project.master !== null && typeof project.master === 'object' && !Array.isArray(project.master)) {
    const automation = normalizeAutomation(project.master.automation, { maxBeat, allowed: ['volume'] })
    if (Object.keys(automation).length > 0) project.master.automation = automation
    else delete project.master.automation
  }
  // P3b：媒体列表规范化，并丢弃引用不存在媒体的音频片段。
  project.media = normalizeMediaList(project.media)
  if (Array.isArray(project.clips)) {
    const mediaById = new Map(project.media.map((media) => [media.id, media]))
    const liveTrackIds = new Set(
      Array.isArray(project.tracks)
        ? project.tracks.map((track) => (track !== null && typeof track === 'object' ? track.id : null)).filter(Boolean)
        : [],
    )
    project.clips = project.clips.filter((clip) => {
      if (clip === null || typeof clip !== 'object' || Array.isArray(clip)) return false
      if (typeof clip.mediaId === 'string' && clip.mediaId !== '') {
        return mediaById.has(clip.mediaId) && liveTrackIds.has(clip.trackId)
      }
      return true
    })
    // P6/R2a：音频片段 offsetSeconds 规范化夹紧（按媒体时长）；gain/fade/reverse 规范化。
    // pattern 片段不允许这些音频字段（旧数据/手改数据防御性删除）。
    const AUDIO_CLIP_FIELDS = ['offsetSeconds', 'gainDb', 'fadeInSeconds', 'fadeOutSeconds', 'reverse', 'stretchRatio', 'semitones', 'takeGroup', 'takeIndex', 'takeActive']
    for (const clip of project.clips) {
      if (typeof clip.mediaId === 'string' && clip.mediaId !== '') {
        if (Object.hasOwn(clip, 'offsetSeconds')) {
          clip.offsetSeconds = normalizeClipOffset(clip.offsetSeconds, mediaById.get(clip.mediaId))
        }
        normalizeAudioClipFields(project, clip)
      } else {
        for (const field of AUDIO_CLIP_FIELDS) {
          if (Object.hasOwn(clip, field)) delete clip[field]
        }
      }
    }
  }
  // P2c-2：返回总线结构规范化 + FX 链规范化。
  project.buses = normalizeBuses(project.buses)
  // P11：导出历史（最近 10 条）防御性规范化。
  project.exportHistory = normalizeExportHistory(project.exportHistory)
  // R0A：导出任务历史（最近 10 条）防御性规范化。
  project.exportJobs = normalizeExportJobs(project.exportJobs)
  // R3c：MIDI Learn 映射（≤16、cc+channel 唯一、轨道/效果器/参数校验）。
  project.midiMappings = normalizeMidiMappings(project.midiMappings, { tracks: project.tracks })
  // R4c：混音场景（≤8、名称唯一、混音字段快照）。
  project.scenes = normalizeScenes(project.scenes)
  // R4a：Group bus（≤8）+ 轨道输出路由（只允许 master 或已存在 group；master 省略字段）。
  project.groups = normalizeGroups(project.groups)
  const groupIds = new Set(project.groups.map((group) => group.id))
  for (const track of project.tracks) {
    if (typeof track.output === 'string' && groupIds.has(track.output)) continue
    delete track.output
  }
  // v2.1：所有链（master/返回总线/轨道/组）的 effectId 全局唯一，旧工程加载时自动重分配。
  normalizeGlobalEffectIds(project)
  return project
}

/**
 * 自动化曲线概览（studio_get_project 用）：
 * - 默认只给摘要：enabled / pointCount / firstBeat / lastBeat（不含 points）；
 * - options.includePoints=true（studio_get_project includeAutomation）才返回完整 points（每曲线 1..256 点）。
 */
export function automationSummary(automation, options = {}) {
  const summary = {}
  if (automation === null || typeof automation !== 'object' || Array.isArray(automation)) return summary
  const includePoints = options?.includePoints === true
  for (const param of AUTOMATION_PARAM_IDS) {
    const curve = automation[param]
    if (curve === null || typeof curve !== 'object' || Array.isArray(curve)) continue
    const points = Array.isArray(curve.points) ? curve.points : []
    const normalized = points.map((point) => ({
      beat: Math.round(Number(point.beat) * 1000) / 1000,
      value: Math.round(clamp01(point.value) * 1000) / 1000,
    }))
    summary[param] = {
      enabled: curve.enabled !== false,
      pointCount: normalized.length,
      ...(normalized.length > 0
        ? { firstBeat: normalized[0].beat, lastBeat: normalized[normalized.length - 1].beat }
        : {}),
      ...(includePoints ? { points: normalized } : {}),
    }
  }
  return summary
}


/* ------------------------------------------------------------------------- */
/* 侧链压缩（P2b）                                                             */
/* track.sidechain = { enabled, sourceTrackId, amount, attack, release }      */
/* 来源轨道的事件会压低目标轨道（ducking），通常用底鼓压贝斯。                    */
/* ------------------------------------------------------------------------- */

/** 侧链压缩默认值（UI 新建表单缺省：未启用、无来源；amount/attack/release 为常用起点）。 */
export const SIDECHAIN_DEFAULTS = Object.freeze({
  enabled: false,
  sourceTrackId: null,
  amount: 0.5,
  attack: 0.005,
  release: 0.12,
})

/** sidechain 数值参数的合法范围（越界夹紧）。 */
export const SIDECHAIN_RANGES = Object.freeze({
  amount: [0, 1],
  attack: [0.001, 0.2],
  release: [0.02, 1],
})

/** R0-12：侧链触发音符过滤最多保留多少个音高。 */
export const SIDECHAIN_MAX_TRIGGER_NOTES = 16
/** R0-12：触发音符合法 MIDI 音高范围。 */
export const SIDECHAIN_NOTE_RANGE = Object.freeze([0, 127])

/**
 * R0-12：规范化侧链触发音符过滤。
 * - 接受 number 或 number[]（单数归一为数组）；空/非法 = []（不触发过滤，任意音符都算）；
 * - 只保留 0..127 的整数，去重、升序、最多 SIDECHAIN_MAX_TRIGGER_NOTES 个；
 * - 例如 [36] 表示只有底鼓（GM kick）触发 ducking，避免踩镲误触发。
 * @param {unknown} raw number | number[] | undefined
 * @returns {number[]}
 */
export function normalizeSidechainTriggerNotes(raw) {
  const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw])
  const notes = new Set()
  for (const value of list) {
    // 只接受真正的 number（'36'/null/{} 等字符串或对象不参与；负数/小数/越界过滤）。
    if (typeof value !== 'number' || !Number.isInteger(value)) continue
    if (value < SIDECHAIN_NOTE_RANGE[0] || value > SIDECHAIN_NOTE_RANGE[1]) continue
    notes.add(value)
  }
  return [...notes].sort((a, b) => a - b).slice(0, SIDECHAIN_MAX_TRIGGER_NOTES)
}

/** 数值夹紧：非有限数字用 fallback，越界夹到 range 内。 */
function clampSidechainNumber(value, range, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return clamp(n, range[0], range[1])
}

/**
 * 规范化轨道侧链配置：
 * - 非法输入 / 缺少有效 sourceTrackId / 自引用 / 来源不存在 → 返回 null（丢弃）；
 * - amount/attack/release 夹紧到合法范围（非法数字用默认值）；
 * - R0-12：triggerNotes 过滤触发音符（空数组 = 任意音符；最多 16 个、去重升序）；
 * - enabled 默认 true（存在有效侧链即视为启用），显式 false 保留。
 * @param {object} raw
 * @param {{trackIds?: Iterable<string>, selfId?: string}} [options]
 * @returns {{enabled:boolean, sourceTrackId:string, amount:number, attack:number, release:number, triggerNotes:number[]}|null}
 */
export function normalizeSidechain(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  let trackIdSet = null
  if (options.trackIds instanceof Set) trackIdSet = options.trackIds
  else if (Array.isArray(options.trackIds)) trackIdSet = new Set(options.trackIds)
  const rawSource = typeof raw.sourceTrackId === 'string' ? raw.sourceTrackId.trim() : ''
  if (rawSource === '') return null
  if (options.selfId !== undefined && options.selfId !== null && rawSource === options.selfId) return null
  if (trackIdSet !== null && !trackIdSet.has(rawSource)) return null
  return {
    enabled: raw.enabled !== false,
    sourceTrackId: rawSource,
    amount: clampSidechainNumber(raw.amount, SIDECHAIN_RANGES.amount, SIDECHAIN_DEFAULTS.amount),
    attack: clampSidechainNumber(raw.attack, SIDECHAIN_RANGES.attack, SIDECHAIN_DEFAULTS.attack),
    release: clampSidechainNumber(raw.release, SIDECHAIN_RANGES.release, SIDECHAIN_DEFAULTS.release),
    triggerNotes: normalizeSidechainTriggerNotes(raw.triggerNotes),
  }
}

/** 侧链摘要（studio_get_project 概览用；无侧链返回 null）。 */
export function sidechainSummary(sidechain) {
  if (sidechain === null || typeof sidechain !== 'object' || Array.isArray(sidechain)) return null
  return {
    enabled: sidechain.enabled !== false,
    sourceTrackId: typeof sidechain.sourceTrackId === 'string' ? sidechain.sourceTrackId : null,
    amount: Math.round(clamp01(sidechain.amount) * 1000) / 1000,
    attack: Math.round(clampSidechainNumber(sidechain.attack, SIDECHAIN_RANGES.attack, SIDECHAIN_DEFAULTS.attack) * 1000) / 1000,
    release: Math.round(clampSidechainNumber(sidechain.release, SIDECHAIN_RANGES.release, SIDECHAIN_DEFAULTS.release) * 1000) / 1000,
    // R0-12：触发音符过滤（[] = 任意音符触发）
    triggerNotes: normalizeSidechainTriggerNotes(sidechain.triggerNotes),
  }
}


/* ------------------------------------------------------------------------- */
/* 表达控制（P11）：延音踏板 / 揉弦                                            */
/* track.sustain?: [{ beat, value:0|1 }, ...]（最多 256 点，按 beat 升序）     */
/* track.vibrato?: { rateHz:0.1..12, depthCents:0..100, enabled:boolean }      */
/* ------------------------------------------------------------------------- */

/** 延音踏板曲线最多点数。 */
export const SUSTAIN_MAX_POINTS = 256
/** 揉弦默认值（新建/部分更新时使用）。 */
export const VIBRATO_DEFAULTS = Object.freeze({ rateHz: 5.5, depthCents: 15, enabled: true })
/** 揉弦参数范围。 */
export const VIBRATO_RANGES = Object.freeze({
  rateHz: Object.freeze([0.1, 12]),
  depthCents: Object.freeze([0, 100]),
})

/** 弹奏力度值归一：>=0.5 → 1，否则 0。 */
const clampSustainValue = (value) => (Number(value) >= 0.5 ? 1 : 0)

/**
 * 规范化延音踏板曲线：beat clamp 到 [0,maxBeat]、排序、同 beat 去重（后者覆盖）、value 0/1、最多 256 点。
 * @param {*} raw
 * @param {{maxBeat?:number}} [options]
 * @returns {{beat:number, value:number}[]}
 */
export function normalizeSustainPoints(raw, options = {}) {
  if (!Array.isArray(raw)) return []
  const rawMaxBeat = Number(options.maxBeat)
  const maxBeat = Number.isFinite(rawMaxBeat) && rawMaxBeat > 0 ? rawMaxBeat : 256 * 4
  const byBeat = new Map()
  for (const point of raw) {
    if (point === null || typeof point !== 'object' || Array.isArray(point)) continue
    const beat = Number(point.beat)
    if (!Number.isFinite(beat)) continue
    const clipped = Math.round(Math.min(maxBeat, Math.max(0, beat)) * 1000) / 1000
    byBeat.set(clipped, clampSustainValue(point.value))
  }
  const points = [...byBeat.entries()]
    .map(([beat, value]) => ({ beat, value }))
    .sort((a, b) => a.beat - b.beat)
    .slice(0, SUSTAIN_MAX_POINTS)
  return points
}

/** 延音踏板摘要（get_project 概览用；无踏板返回 null）：points + down（末点状态）。 */
export function sustainSummary(sustain, options = {}) {
  const points = normalizeSustainPoints(sustain)
  if (points.length === 0) return null
  const includePoints = options?.includePoints === true
  return {
    pointCount: points.length,
    down: points[points.length - 1].value === 1,
    firstBeat: points[0].beat,
    lastBeat: points[points.length - 1].beat,
    ...(includePoints ? { points } : {}),
  }
}

/**
 * 规范化揉弦参数（缺省字段用默认值）；非法输入返回 null。
 * @param {*} raw
 * @returns {{rateHz:number, depthCents:number, enabled:boolean}|null}
 */
export function normalizeVibrato(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rateNumeric = Number(raw.rateHz)
  const depthNumeric = Number(raw.depthCents)
  const rateHz = Number.isFinite(rateNumeric)
    ? Math.round(Math.min(VIBRATO_RANGES.rateHz[1], Math.max(VIBRATO_RANGES.rateHz[0], rateNumeric)) * 100) / 100
    : VIBRATO_DEFAULTS.rateHz
  const depthCents = Number.isFinite(depthNumeric)
    ? Math.round(Math.min(VIBRATO_RANGES.depthCents[1], Math.max(VIBRATO_RANGES.depthCents[0], depthNumeric)) * 10) / 10
    : VIBRATO_DEFAULTS.depthCents
  const enabled = raw.enabled === undefined || raw.enabled === null ? VIBRATO_DEFAULTS.enabled : raw.enabled !== false
  return { rateHz, depthCents, enabled }
}

/** 揉弦摘要（get_project 概览用；无配置返回 null）。 */
export function vibratoSummary(vibrato) {
  return normalizeVibrato(vibrato)
}

/* ------------------------------------------------------------------------- */
/* 导出历史（P11）：project.exportHistory（最近 10 条）                         */
/* ------------------------------------------------------------------------- */

/** 导出历史最多保留条数。 */
export const EXPORT_HISTORY_LIMIT = 10

/**
 * 规范化单条导出历史；非法返回 null。
 * @returns {{name:string, format:'wav'|'mp3'|'flac'|'midi'|'stems', seconds:number, bytes:number, path:string, at:number}|null}
 */
export function normalizeExportHistoryEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 160) : ''
  const filePath = typeof raw.path === 'string' ? raw.path.trim().slice(0, 512) : ''
  if (name === '' && filePath === '') return null
  const format = raw.format === 'midi' || raw.format === 'stems' || raw.format === 'mp3' || raw.format === 'flac'
    ? raw.format
    : 'wav'
  const seconds = Number.isFinite(Number(raw.seconds)) ? Math.round(Math.max(0, Number(raw.seconds)) * 100) / 100 : 0
  const bytes = Number.isFinite(Number(raw.bytes)) ? Math.max(0, Math.trunc(Number(raw.bytes))) : 0
  const at = Number.isFinite(Number(raw.at)) ? Math.trunc(Number(raw.at)) : Date.now()
  return { name: name || filePath.split(/[\\/]/).pop() || 'export', format, seconds, bytes, path: filePath, at }
}

/** 规范化导出历史数组（最多 EXPORT_HISTORY_LIMIT 条，保持顺序）。 */
export function normalizeExportHistory(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    const normalized = normalizeExportHistoryEntry(entry)
    if (!normalized) continue
    out.push(normalized)
    if (out.length >= EXPORT_HISTORY_LIMIT) break
  }
  return out
}

/* ------------------------------------------------------------------------- */
/* R0A：导出任务（job）历史                                                    */
/* project.exportJobs = [{ jobId, status, format, name, path, bytes, seconds,  */
/*                        outputDir, error, startedAt, finishedAt }]           */
/* ------------------------------------------------------------------------- */

/** 导出任务状态枚举。 */
export const EXPORT_JOB_STATUSES = Object.freeze(['pending', 'rendering', 'success', 'error'])
/** 保留的已完成导出任务数。 */
export const EXPORT_JOB_LIMIT = 10

/**
 * 规范化单条导出任务；非法返回 null。
 * @returns {object|null}
 */
export function normalizeExportJob(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const jobId = typeof raw.jobId === 'string' ? raw.jobId.trim().slice(0, 64) : ''
  if (jobId === '') return null
  const status = EXPORT_JOB_STATUSES.includes(raw.status) ? raw.status : 'pending'
  const format = raw.format === 'stems' || raw.format === 'mp3' || raw.format === 'flac' || raw.format === 'wav' || raw.format === 'midi'
    ? raw.format
    : 'wav'
  const readText = (value, max) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined)
  const readNumber = (value, { min = 0, round: roundDigits } = {}) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric < min) return undefined
    return roundDigits === undefined ? Math.round(numeric) : Math.round(numeric * 10 ** roundDigits) / 10 ** roundDigits
  }
  const job = {
    jobId,
    status,
    format,
    startedAt: readNumber(raw.startedAt) ?? Date.now(),
  }
  const finishedAt = readNumber(raw.finishedAt)
  if (finishedAt !== undefined) job.finishedAt = finishedAt
  const name = readText(raw.name, 160)
  if (name) job.name = name
  const filePath = readText(raw.path, 512)
  if (filePath) job.path = filePath
  const outputDir = readText(raw.outputDir, 512)
  if (outputDir) job.outputDir = outputDir
  const error = readText(raw.error, 512)
  if (error && status === 'error') job.error = error
  const bytes = readNumber(raw.bytes)
  if (bytes !== undefined) job.bytes = bytes
  const seconds = readNumber(raw.seconds, { round: 2 })
  if (seconds !== undefined) job.seconds = seconds
  // v2.1：导出响度/峰值指标（真 K 加权，与 preview 同源），用于 exportStatus/get_project 对比。
  const readMetric = (value, digits = 2) => {
    if (value === null || value === undefined || value === '') return undefined
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return undefined
    return Math.round(numeric * 10 ** digits) / 10 ** digits
  }
  for (const key of ['achievedLufs', 'peak', 'peakDb', 'truePeak', 'truePeakDb', 'gainDb']) {
    const metric = readMetric(raw[key])
    if (metric !== undefined) job[key] = metric
  }
  if (typeof raw.limited === 'boolean') job.limited = raw.limited
  return job
}

/** 规范化导出任务数组（最多 EXPORT_JOB_LIMIT 条，最新在前）。 */
export function normalizeExportJobs(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    const normalized = normalizeExportJob(entry)
    if (!normalized) continue
    out.push(normalized)
    if (out.length >= EXPORT_JOB_LIMIT) break
  }
  return out
}


/* ------------------------------------------------------------------------- */
/* 返回总线（P2c-2）                                                           */
/* project.buses = { reverb:{ level, effects:[] }, delay:{ level, effects:[] } } */
/* P12 clean break：旧数字结构不再迁移，非对象输入直接回默认值。                  */
/* ------------------------------------------------------------------------- */

/** 返回总线 id。 */
export const BUS_IDS = Object.freeze(['reverb', 'delay'])

/** 返回总线默认值（level 0..1；effects 为 FX 链）。 */
export const BUS_DEFAULTS = Object.freeze({
  reverb: Object.freeze({ level: 0.35, effects: Object.freeze([]) }),
  delay: Object.freeze({ level: 0.22, effects: Object.freeze([]) }),
})

/** 创建一个全新的默认 buses（避免共享引用）。 */
export function createDefaultBuses() {
  return {
    reverb: { level: BUS_DEFAULTS.reverb.level, effects: [] },
    delay: { level: BUS_DEFAULTS.delay.level, effects: [] },
  }
}

/**
 * 规范化效果器链数组（总线 / master 用）：
 * - 丢弃非法项（非对象 / 未知 type）；
 * - id 非法或重复时重新分配 fx_N；enabled 默认 true；params 合并类型默认值；
 * - 截断到 max 个（默认 LIMITS.maxEffectsPerTrack）。
 * @param {Array} rawEffects
 * @param {{max?:number}} [options]
 * @returns {Array}
 */
/** v2.2：外部 VST3 插件数量/state 上限。 */
export const MAX_EXTERNAL_PLUGIN_INSTANCES = 16
export const MAX_PLUGIN_STATE_BYTES = 2 * 1024 * 1024

/**
 * 规范化外部插件引用（track.vst3 / effect.vst3）。
 * - pluginId 必填（缺失返回 null）；元信息截断；params 只保留 0..1 数值；
 * - stateBase64 超 2MB 丢弃；bypass/missing 布尔。
 */
/** v2.2 M4：冻结缓存描述（track.freeze / effect.freeze）。 */
export function normalizeFreeze(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const hash = typeof raw.hash === 'string' && /^[a-f0-9]{8,64}$/i.test(raw.hash.trim()) ? raw.hash.trim().toLowerCase() : ''
  const mediaId = typeof raw.mediaId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.mediaId) ? raw.mediaId : null
  const cacheFile = typeof raw.cacheFile === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(raw.cacheFile) ? raw.cacheFile : null
  if (hash === '') return null
  const readInt = (value, min, max, fallback = null) => {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : fallback
  }
  return {
    status: ['current', 'stale', 'freezing', 'error'].includes(raw.status) ? raw.status : (raw.stale === true ? 'stale' : 'current'),
    hash,
    mediaId,
    cacheFile,
    cachePath: typeof raw.cachePath === 'string' ? raw.cachePath : null,
    bars: readInt(raw.bars, 1, 256),
    frames: readInt(raw.frames, 1, 192000 * 900),
    sampleRate: readInt(raw.sampleRate, 8000, 192000, 48000),
    includesFx: raw.includesFx === true,
    latencySamples: readInt(raw.latencySamples, 0, 100000, 0),
    createdAt: readInt(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
    stale: raw.stale === true || raw.status === 'stale',
    ...(typeof raw.error === 'string' && raw.error !== '' ? { error: raw.error.slice(0, 400) } : {}),
  }
}

/** v2.3 P1：插件预设引用 {listId,index,name}（可选）。 */
export function normalizePluginPreset(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const listId = Number.isFinite(Number(raw.listId)) ? Math.max(0, Math.round(Number(raw.listId))) : null
  const index = Number.isFinite(Number(raw.index)) ? Math.max(0, Math.round(Number(raw.index))) : null
  if (listId === null && index === null) return null
  return {
    listId,
    index,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 160) : '',
  }
}

/**
 * v2.3 P2：插件参数自动化 normalize。
 * track.pluginAutomation = { [instanceKey]: { [paramId]: {enabled,points:[{beat,value}]} } }
 * instanceKey: 'track'（vst3 乐器）或 'effect:<effectId>'；每轨 ≤16 条曲线、每条 ≤256 点。
 */
export function normalizePluginAutomation(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const maxBeat = Number.isFinite(Number(options.maxBeat)) ? Math.max(0, Number(options.maxBeat)) : 1024
  const out = {}
  let curves = 0
  for (const [instanceKey, paramsRaw] of Object.entries(raw)) {
    if (curves >= 16) break
    if (!(instanceKey === 'track' || /^effect:[A-Za-z0-9_-]{1,64}$/.test(instanceKey))) continue
    if (paramsRaw === null || typeof paramsRaw !== 'object' || Array.isArray(paramsRaw)) continue
    const params = {}
    for (const [paramKey, curveRaw] of Object.entries(paramsRaw)) {
      if (curves >= 16) break
      const paramId = String(paramKey).trim().slice(0, 64)
      if (paramId === '') continue
      if (curveRaw === null || typeof curveRaw !== 'object' || Array.isArray(curveRaw)) continue
      const points = []
      const seenBeats = new Set()
      for (const point of Array.isArray(curveRaw.points) ? curveRaw.points : []) {
        if (points.length >= 256) break
        if (point === null || typeof point !== 'object') continue
        const beat = Number(point.beat)
        const value = Number(point.value)
        if (!Number.isFinite(beat) || !Number.isFinite(value)) continue
        const clampedBeat = Math.round(Math.max(0, Math.min(maxBeat, beat)) * 1e6) / 1e6
        if (seenBeats.has(clampedBeat)) continue
        seenBeats.add(clampedBeat)
        points.push({ beat: clampedBeat, value: Math.round(Math.max(0, Math.min(1, value)) * 1e6) / 1e6 })
      }
      points.sort((a, b) => a.beat - b.beat)
      params[paramId] = { enabled: curveRaw.enabled !== false, points }
      curves += 1
    }
    if (Object.keys(params).length > 0) out[instanceKey] = params
  }
  return out
}

export function normalizeExternalPlugin(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const pluginId = typeof raw.pluginId === 'string' ? raw.pluginId.trim().slice(0, 80) : ''
  if (pluginId === '') return null
  const readText = (value, max) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : '')
  const params = {}
  if (raw.params !== null && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
    for (const [key, value] of Object.entries(raw.params).slice(0, 512)) {
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) continue
      params[String(key).slice(0, 64)] = Math.round(Math.max(0, Math.min(1, numeric)) * 1e6) / 1e6
    }
  }
  let stateBase64 = null
  if (typeof raw.stateBase64 === 'string' && raw.stateBase64 !== '') {
    if (Buffer.byteLength(raw.stateBase64, 'utf8') <= MAX_PLUGIN_STATE_BYTES) stateBase64 = raw.stateBase64
  }
  const category = readText(raw.category, 120)
  const subCategories = readText(raw.subCategories, 240)
  const midiInputs = Number.isFinite(Number(raw.midiInputs)) ? Math.max(0, Math.min(64, Math.round(Number(raw.midiInputs)))) : 0
  const inferredInstrument = midiInputs > 0 || /instrument|synth/i.test(`${category} ${subCategories}`)
  const kind = raw.kind === 'instrument' || raw.kind === 'effect'
    ? raw.kind
    : (raw.isInstrument === true || (raw.isInstrument === undefined && inferredInstrument) ? 'instrument' : 'effect')
  const isInstrument = kind === 'instrument'
  return {
    pluginId,
    name: readText(raw.name, 160),
    vendor: readText(raw.vendor, 160),
    version: readText(raw.version, 80),
    category,
    subCategories,
    classId: readText(raw.classId, 64),
    kind,
    isInstrument,
    midiInputs: isInstrument ? midiInputs : 0,
    params,
    preset: normalizePluginPreset(raw.preset),
    stateBase64,
    bypass: raw.bypass === true,
    missing: raw.missing === true,
  }
}

export function normalizeEffects(rawEffects, options = {}) {
  const max = Number.isFinite(Number(options.max)) ? Math.max(0, Number(options.max)) : LIMITS.maxEffectsPerTrack
  if (!Array.isArray(rawEffects)) return []
  const out = []
  const used = new Set()
  let nextSuffix = 0
  for (const fx of rawEffects) {
    if (out.length >= max) break
    if (fx === null || typeof fx !== 'object' || Array.isArray(fx)) continue
    const isVst3 = fx.type === 'vst3'
    const typeDef = isVst3 ? null : findFxType(fx.type)
    if (!isVst3 && !typeDef) continue
    let vst3 = null
    if (isVst3) {
      vst3 = normalizeExternalPlugin(fx.vst3)
      if (!vst3) continue
    }
    let id = typeof fx.id === 'string' && /^[A-Za-z0-9_-]+$/.test(fx.id) && !used.has(fx.id) ? fx.id : null
    if (id === null) {
      do {
        nextSuffix += 1
        id = `fx_${nextSuffix}`
      } while (used.has(id))
    }
    used.add(id)
    const suffix = /^fx_(\d+)$/.exec(id)
    if (suffix) nextSuffix = Math.max(nextSuffix, Number(suffix[1]))
    if (isVst3) {
      const freeze = normalizeFreeze(fx.freeze)
      out.push({ id, type: 'vst3', enabled: fx.enabled !== false, vst3: { ...vst3, kind: 'effect', isInstrument: false }, ...(freeze ? { freeze } : {}) })
    } else {
      out.push(makeEffect(id, typeDef.id, fx.params, fx.enabled !== false))
    }
  }
  // v2.2：外部插件效果器只允许位于轨道 FX 链末尾（后面还有内置 FX 时后移，保持稳定顺序）。
  const builtIn = out.filter((fx) => fx.type !== 'vst3')
  const vst3Effects = out.filter((fx) => fx.type === 'vst3')
  return [...builtIn, ...vst3Effects]
}

/**
 * 规范化单条返回总线（P12：只接受对象结构，旧数字结构不再迁移）：
 * - 对象 → level 夹 0..1（非法/缺失回 fallbackLevel）、effects 规范化；
 * - 非法输入 → { level: fallbackLevel, effects: [] }。
 * @param {object} raw
 * @param {number} [fallbackLevel]
 * @returns {{level:number, effects:Array}}
 */
export function normalizeBus(raw, fallbackLevel = BUS_DEFAULTS.reverb.level) {
  const fallback = Number.isFinite(Number(fallbackLevel)) ? clamp01(fallbackLevel) : BUS_DEFAULTS.reverb.level
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { level: fallback, effects: [] }
  const level = raw.level === undefined || raw.level === null
    ? fallback
    : (Number.isFinite(Number(raw.level)) ? clamp01(raw.level) : fallback)
  return { level, effects: normalizeEffects(raw.effects) }
}

/**
 * 规范化整个 project.buses（缺失/非法字段回默认），幂等。
 * @param {object} raw
 * @returns {{reverb:{level:number,effects:Array}, delay:{level:number,effects:Array}}}
 */
export function normalizeBuses(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const buses = {}
  for (const busId of BUS_IDS) {
    buses[busId] = normalizeBus(source[busId], BUS_DEFAULTS[busId].level)
  }
  return buses
}

/** 返回总线摘要（studio_get_project 概览用：level + effects 摘要）。 */
export function busSummary(bus, fallbackLevel) {
  const normalized = normalizeBus(bus, fallbackLevel)
  return {
    level: Math.round(normalized.level * 1000) / 1000,
    effects: normalized.effects.map((fx) => ({ id: fx.id, type: fx.type, enabled: fx.enabled !== false })),
  }
}


/* ------------------------------------------------------------------------- */
/* 音频媒体（P3b）                                                             */
/* project.media = [{ id:'med_1', name:'人声.wav', file:'med_1.wav', bytes,     */
/*                    durationSeconds, channels, sampleRate, peaks? }]         */
/* 音频轨道 kind='audio'（role='audio'，无 preset/kit）；音频片段用 mediaId。     */
/* ------------------------------------------------------------------------- */

/** 支持的音频扩展名（导入校验用）。 */
export const AUDIO_EXTS = Object.freeze(['wav', 'mp3', 'flac', 'ogg'])

/** 单个音频文件大小上限（30MB）。 */
export const MEDIA_MAX_BYTES = 30 * 1024 * 1024

/** 工程内 audio 媒体数量上限。 */
export const MAX_MEDIA = 64

/** 波形 peaks 最多点数（契约 ≤512）。 */
export const MEDIA_PEAKS_MAX_POINTS = 512

/** 未知时长音频的片段默认长度（小节）。 */
export const MEDIA_DEFAULT_CLIP_BARS = 4

/** 音频轨默认颜色（与合成器/鼓组区分）。 */
export const AUDIO_TRACK_COLOR = '#4E9AA6'

const MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MEDIA_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,120}$/

/** 取音频文件安全扩展名（不含点）；不支持返回 null。 */
export function audioExtOf(fileName) {
  if (typeof fileName !== 'string') return null
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())
  if (!match) return null
  const ext = match[1].toLowerCase()
  return AUDIO_EXTS.includes(ext) ? ext : null
}

/**
 * 规范化一条媒体条目；关键字段（id/name/file）非法时返回 null。
 * @param {object} raw
 * @returns {{id:string,name:string,file:string,bytes:number,durationSeconds:number|null,channels:number,sampleRate:number,peaks?:number[]}|null}
 */
export function normalizeMedia(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!MEDIA_ID_RE.test(id)) return null
  let name = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f]/g, ' ').trim() : ''
  if (name === '') name = '未命名音频'
  if (name.length > 120) name = name.slice(0, 120)
  const file = typeof raw.file === 'string' ? raw.file.trim() : ''
  if (!MEDIA_FILE_RE.test(file) || file.includes('..') || file.includes('/') || file.includes('\\')) return null
  const fileExt = audioExtOf(file)
  if (!fileExt) return null
  const bytes = Number.isFinite(Number(raw.bytes)) && Number(raw.bytes) >= 0
    ? Math.min(Math.trunc(Number(raw.bytes)), 1024 * 1024 * 1024)
    : 0
  let durationSeconds = null
  if (raw.durationSeconds !== undefined && raw.durationSeconds !== null && Number.isFinite(Number(raw.durationSeconds))) {
    durationSeconds = Math.round(Math.min(3600, Math.max(0.01, Number(raw.durationSeconds))) * 1000) / 1000
  }
  const channels = Number.isFinite(Number(raw.channels))
    ? Math.min(8, Math.max(1, Math.trunc(Number(raw.channels))))
    : 2
  const sampleRate = Number.isFinite(Number(raw.sampleRate))
    ? Math.min(192000, Math.max(8000, Math.trunc(Number(raw.sampleRate))))
    : 44100
  const media = { id, name, file, bytes, durationSeconds, channels, sampleRate }
  if (Array.isArray(raw.peaks)) {
    const peaks = []
    for (const value of raw.peaks) {
      if (peaks.length >= MEDIA_PEAKS_MAX_POINTS) break
      if (!Number.isFinite(Number(value))) continue
      peaks.push(Math.round(clamp01(Number(value)) * 1000) / 1000)
    }
    if (peaks.length > 0) media.peaks = peaks
  }
  return media
}

/** 规范化整个 media 列表（丢弃非法条目、重复 id 只留第一个）。 */
export function normalizeMediaList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const used = new Set()
  for (const item of raw) {
    const media = normalizeMedia(item)
    if (!media || used.has(media.id)) continue
    used.add(media.id)
    out.push(media)
  }
  return out
}

/** 构造一条媒体条目（假校验前提：调用方已校验文件写入成功）。非法返回 null。 */
export function makeMedia({ id, name, file, bytes, durationSeconds, channels, sampleRate, peaks } = {}) {
  const media = normalizeMedia({ id, name, file, bytes, durationSeconds, channels, sampleRate, peaks })
  if (media) return media
  return normalizeMedia({
    id,
    name: typeof name === 'string' && name.trim() !== '' ? name : '未命名音频',
    file: typeof file === 'string' && file.trim() !== '' ? file.trim() : (typeof id === 'string' ? `${id}.wav` : ''),
    bytes: Number.isFinite(Number(bytes)) ? Number(bytes) : 0,
    durationSeconds,
    channels,
    sampleRate,
    peaks,
  })
}

/** 媒体摘要（studio_get_project 概览用）。 */
export function mediaSummary(media) {
  return {
    id: media.id,
    name: media.name,
    file: media.file,
    bytes: media.bytes,
    durationSeconds: media.durationSeconds,
    channels: media.channels,
    sampleRate: media.sampleRate,
    hasPeaks: Array.isArray(media.peaks) && media.peaks.length > 0,
  }
}


/** 默认 master 配置。 */
/**
 * P13：空白工程默认 master —— volume 0.82、**空 FX 链**（不再默认 eq3+compressor，
 * 避免 AI 新建工程时母带被预置效果影响；需要母带链时用 masteredMaster()）。
 */
export function defaultMaster() {
  return { volume: 0.82, effects: [] }
}

/**
 * 演示工程母带链（保持 demo 听感）：eq3（含 P13 全参数默认）+ compressor。
 * 仅 createDemoProject / 演示模板使用；新工程用 defaultMaster()（空链）。
 */
export function masteredMaster() {
  return {
    volume: 0.82,
    effects: [
      makeEffect('fx_1', 'eq3', { low: 1.5, mid: -1, high: 1 }),
      makeEffect('fx_2', 'compressor', { threshold: -16, ratio: 3, attack: 0.008, release: 0.18 }),
    ],
  }
}

/** 构造一条轨道（校验前提：preset/kit 存在）。可传 sidechain（P2b，来源校验由 normalizeProject 负责）。 */
export function makeTrack({ id, name, kind = 'synth', preset, kit, role = 'lead', volume = 0.78, pan = 0, color, effects = [], sends, sidechain, reference = false } = {}) {
  if (kind === 'audio') {
    // P3b：音频轨没有 preset/kit/instrument，默认 role='audio'。
    const track = {
      id,
      name: name || '音频轨',
      role: 'audio',
      kind: 'audio',
      color: color || AUDIO_TRACK_COLOR,
      volume: clamp01(volume),
      pan: clampPan(pan),
      mute: false,
      solo: false,
      sends: {
        reverb: clamp01(sends?.reverb ?? 0.12),
        delay: clamp01(sends?.delay ?? 0.06),
      },
      effects: effects.map((fx, i) => makeEffect(`fx_${i + 1}`, fx.type, fx.params, fx.enabled)),
    }
    const audioSidechain = normalizeSidechain(sidechain, { selfId: id })
    if (audioSidechain) track.sidechain = audioSidechain
    // P14b：参考曲音频轨标记（默认 false 不写字段）
    if (reference === true) track.reference = true
    return track
  }
  const isDrum = kind === 'drum'
  // P8/P12：默认音色 = SYNTH_PRESETS[0]（三角钢琴，真实采样）；未知 preset 回退默认、不报错。
  const presetDef = isDrum ? null : (findSynthPreset(preset) ?? SYNTH_PRESETS[0])
  // 鼓组默认 = 4 套采样鼓机第一套（原声采样鼓）；未知 kit 回退默认。
  const kitDef = isDrum ? (findDrumKit(kit) ?? DRUM_KITS[0]) : null
  // 采样乐器没有合成参数（engine 读 preset.soundfont）。
  const instrumentParams = presetDef?.soundfont ? {} : presetParams(presetDef)
  const track = {
    id,
    name: name || (isDrum ? kitDef.label : presetDef.label),
    role: isDrum ? 'drums' : role,
    kind: isDrum ? 'drum' : 'synth',
    color: color || (isDrum ? kitDef.color : presetDef.color) || TRACK_COLORS[0],
    instrument: isDrum
      ? { preset: null, kit: kitDef.id, params: kitParams(kitDef) }
      : { preset: presetDef.id, kit: null, params: instrumentParams },
    volume: clamp01(volume),
    pan: clampPan(pan),
    mute: false,
    solo: false,
    sends: {
      reverb: clamp01(sends?.reverb ?? (isDrum ? 0.08 : 0.18)),
      delay: clamp01(sends?.delay ?? (isDrum ? 0.04 : 0.12)),
    },
    effects: effects.map((fx, i) => makeEffect(`fx_${i + 1}`, fx.type, fx.params, fx.enabled)),
  }
  const normalizedSidechain = normalizeSidechain(sidechain, { selfId: id })
  if (normalizedSidechain) track.sidechain = normalizedSidechain
  if (reference === true) track.reference = true
  return track
}

/** 构造一个效果器。 */
export function makeEffect(id, type, params, enabled = true, extra = {}) {
  const def = findFxType(type)
  const defaults = fxDefaultParams(def?.id ?? type)
  return {
    id,
    type: def?.id ?? type,
    enabled: enabled !== false,
    params: { ...defaults, ...(params ?? {}) },
    ...extra,
  }
}

/** 构造一个 pattern。 */
export function makePattern({ id, name = 'New Pattern', lengthBars = 4, notes = [] } = {}) {
  return { id, name, lengthBars: Math.max(1, Math.round(lengthBars)), notes: notes.map(normalizeNote) }
}

/** 音符归一：pitch 整数 0..127，start>=0，dur>0，vel 0..1。 */
export function normalizeNote(n) {
  return {
    pitch: Math.max(0, Math.min(127, Math.round(Number(n.pitch) || 0))),
    start: Math.max(0, Number(n.start) || 0),
    dur: Math.max(0.02, Number(n.dur) || 0.25),
    vel: clamp01(Number(n.vel) || 0.8),
  }
}

/* ------------------------------------------------------------------------- */
/* R2a：音频片段电平/淡变/反向（gainDb/fadeInSeconds/fadeOutSeconds/reverse）    */
/* ------------------------------------------------------------------------- */

/** 音频片段 gainDb 合法范围（dB；0 省略字段）。 */
export const AUDIO_CLIP_GAIN_DB_MIN = -24
export const AUDIO_CLIP_GAIN_DB_MAX = 24
/** 音频片段淡入/淡出最大秒数。 */
export const AUDIO_CLIP_FADE_MAX_SECONDS = 10
/** R2b：时间拉伸比例（timeline 秒 = 源秒 × ratio；1 省略）。 */
export const AUDIO_CLIP_STRETCH_RATIO_MIN = 0.25
export const AUDIO_CLIP_STRETCH_RATIO_MAX = 4
/** R2b：独立变调半音数（-12..+12，0 省略）。 */
export const AUDIO_CLIP_SEMITONES_MIN = -12
export const AUDIO_CLIP_SEMITONES_MAX = 12
/** R2c：take 组名最大长度、takeIndex 上限与安全字符。 */
export const TAKE_GROUP_MAX_LENGTH = 64
export const TAKE_INDEX_MAX = 99
export const TAKE_GROUP_RE = /^[A-Za-z0-9_-]{1,64}$/

/** 规范化 gainDb（-24..24，保留 1 位小数；0 返回 0 表示省略）。 */
export function normalizeAudioClipGainDb(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0
  const clamped = Math.min(AUDIO_CLIP_GAIN_DB_MAX, Math.max(AUDIO_CLIP_GAIN_DB_MIN, value))
  const rounded = Math.round(clamped * 10) / 10
  return rounded === 0 ? 0 : rounded
}

/** 规范化 fadeIn/fadeOut 秒（0..10，保留 3 位小数；0 返回 0 表示省略）。 */
export function normalizeAudioClipFadeSeconds(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  const clamped = Math.min(AUDIO_CLIP_FADE_MAX_SECONDS, value)
  return Math.round(clamped * 1000) / 1000
}

/** 规范化 reverse 布尔（仅 true 保留）。 */
export function normalizeAudioClipReverse(raw) {
  return raw === true
}

/**
 * R2b：规范化 stretchRatio（0.25..4，3 位小数；返回 1 表示省略/原速）。
 * 非法/非有限值返回 1（原速）。
 */
export function normalizeAudioClipStretchRatio(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 1
  const clamped = Math.min(AUDIO_CLIP_STRETCH_RATIO_MAX, Math.max(AUDIO_CLIP_STRETCH_RATIO_MIN, value))
  const rounded = Math.round(clamped * 1000) / 1000
  return rounded === 1 ? 1 : rounded
}

/**
 * R2b：规范化 semitones（-12..+12，1 位小数；返回 0 表示省略/无变调）。
 * 非法/非有限值返回 0。
 */
export function normalizeAudioClipSemitones(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0
  const clamped = Math.min(AUDIO_CLIP_SEMITONES_MAX, Math.max(AUDIO_CLIP_SEMITONES_MIN, value))
  const rounded = Math.round(clamped * 10) / 10
  return rounded === 0 ? 0 : rounded
}

/**
 * R2c：规范化 takeGroup（1..64 安全字符）；非法返回 null（表示无组）。
 * @param {*} raw
 * @returns {string|null}
 */
export function normalizeTakeGroup(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  return TAKE_GROUP_RE.test(text) ? text : null
}

/**
 * R2c：规范化 takeIndex（0..99 整数）；非法返回 null。
 * @param {*} raw
 * @returns {number|null}
 */
export function normalizeTakeIndex(raw) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > TAKE_INDEX_MAX) return null
  return value
}

/**
 * R2c：规范化 takeActive；默认 true（true 省略字段，只有 false 写入）。
 * @param {*} raw
 * @returns {boolean}
 */
export function normalizeTakeActive(raw) {
  return raw === false
}

/** 片段时长（秒，按当前 tempoMap 积分）：用于 fade 上限/媒体剩余时长校验。 */
export function audioClipLengthSeconds(project, startBar, lengthBars) {
  return clipSecondsForBars(project, startBar, lengthBars)
}

function clipSecondsForBars(project, startBar, lengthBars) {
  const barBeats = beatsPerBar(project)
  const tempo = createTempoMap(project)
  const startBeat = Math.max(0, Number(startBar) || 0) * barBeats
  const endBeat = startBeat + Math.max(0, Number(lengthBars) || 0) * barBeats
  return Math.max(0, tempo.beatToSeconds(endBeat) - tempo.beatToSeconds(startBeat))
}

/**
 * 音频片段实际可播放秒数（考虑媒体剩余时长与片段长度的小者）。
 * 媒体时长未知时只用片段长度；fade 仍允许，由引擎按实际时长夹紧。
 * @param {object} project
 * @param {object} clip 音频 clip（mediaId）
 * @returns {number}
 */
export function audioClipPlayableSeconds(project, clip) {
  const clipSeconds = clipSecondsForBars(project, clip?.startBar, clip?.lengthBars)
  const media = Array.isArray(project?.media) ? project.media.find((item) => item.id === clip?.mediaId) : null
  const mediaDuration = Number(media?.durationSeconds)
  const offset = Math.max(0, Number(clip?.offsetSeconds) || 0)
  const ratio = normalizeAudioClipStretchRatio(clip?.stretchRatio)
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
    const remaining = Math.max(0, mediaDuration - offset)
    // R2b：源剩余秒数映射到 timeline 秒 = remaining × stretchRatio。
    return Math.max(0, Math.min(clipSeconds, remaining * ratio))
  }
  return clipSeconds
}

/**
 * R2b：片段需要的源媒体秒数 = timeline 秒 / stretchRatio。
 * @param {object} project
 * @param {object} clip
 * @returns {number}
 */
export function audioClipSourceSeconds(project, clip) {
  const timeline = clipSecondsForBars(project, clip?.startBar, clip?.lengthBars)
  return timeline / normalizeAudioClipStretchRatio(clip?.stretchRatio)
}

/**
 * 规范化音频片段的新字段（就地修改）：
 * - gainDb -24..24（0 省略）、fadeIn/fadeOut 0..10（0 省略）、reverse true 才写；
 * - fadeIn+fadeOut 超过可播放时长时按比例缩放（保留 3 位小数）；
 * - 非音频片段由调用方删除这些字段。
 * @param {object} project
 * @param {object} clip
 * @returns {object} clip
 */
export function normalizeAudioClipFields(project, clip) {
  if (clip === null || typeof clip !== 'object') return clip
  const playable = audioClipPlayableSeconds(project, clip)
  const gainDb = normalizeAudioClipGainDb(clip.gainDb)
  if (gainDb !== 0) clip.gainDb = gainDb
  else delete clip.gainDb
  let fadeIn = normalizeAudioClipFadeSeconds(clip.fadeInSeconds)
  let fadeOut = normalizeAudioClipFadeSeconds(clip.fadeOutSeconds)
  if (playable <= 0) {
    fadeIn = 0
    fadeOut = 0
  } else if (fadeIn + fadeOut > playable) {
    const ratio = playable / (fadeIn + fadeOut)
    fadeIn = Math.round(fadeIn * ratio * 1000) / 1000
    fadeOut = Math.round(fadeOut * ratio * 1000) / 1000
    // 浮点误差兜底：总和绝不大于可播放时长
    if (fadeIn + fadeOut > playable) {
      if (fadeIn >= fadeOut) fadeIn = Math.max(0, Math.round((playable - fadeOut) * 1000) / 1000)
      else fadeOut = Math.max(0, Math.round((playable - fadeIn) * 1000) / 1000)
    }
  }
  if (fadeIn > 0) clip.fadeInSeconds = fadeIn
  else delete clip.fadeInSeconds
  if (fadeOut > 0) clip.fadeOutSeconds = fadeOut
  else delete clip.fadeOutSeconds
  if (normalizeAudioClipReverse(clip.reverse)) clip.reverse = true
  else delete clip.reverse
  // R2b：stretchRatio（1 省略）/ semitones（0 省略）。
  const stretchRatio = normalizeAudioClipStretchRatio(clip.stretchRatio)
  if (stretchRatio !== 1) clip.stretchRatio = stretchRatio
  else delete clip.stretchRatio
  const semitones = normalizeAudioClipSemitones(clip.semitones)
  if (semitones !== 0) clip.semitones = semitones
  else delete clip.semitones
  // R2c：take 字段只对 media clip 生效；无 takeGroup 时删除 takeIndex/takeActive。
  const takeGroup = normalizeTakeGroup(clip.takeGroup)
  if (takeGroup !== null) {
    clip.takeGroup = takeGroup
    const takeIndex = normalizeTakeIndex(clip.takeIndex)
    if (takeIndex !== null) clip.takeIndex = takeIndex
    else delete clip.takeIndex
    if (normalizeTakeActive(clip.takeActive)) clip.takeActive = false
    else delete clip.takeActive
  } else {
    delete clip.takeGroup
    delete clip.takeIndex
    delete clip.takeActive
  }
  return clip
}

/** 音频片段 offsetSeconds 上限（媒体时长未知时使用）。 */
export const CLIP_OFFSET_MAX_SECONDS = 3600

/**
 * 规范化音频片段裁切偏移（P6）：片段从媒体第几秒开始播放。
 * - 非法/NaN/负数 → 0；保留最多 3 位小数；
 * - 媒体时长已知时上限 = durationSeconds - 0.01，未知时上限 CLIP_OFFSET_MAX_SECONDS。
 * @param {*} rawOffset
 * @param {{durationSeconds?:number|null}|null} [media]
 * @returns {number}
 */
export function normalizeClipOffset(rawOffset, media = null) {
  if (rawOffset === undefined || rawOffset === null || rawOffset === '') return 0
  const numeric = Number(rawOffset)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  const duration = Number(media?.durationSeconds)
  const max = Number.isFinite(duration) && duration > 0
    ? Math.max(0, duration - 0.01)
    : CLIP_OFFSET_MAX_SECONDS
  const clamped = Math.min(numeric, max)
  if (!(clamped > 0)) return 0
  return Math.round(clamped * 1000) / 1000
}

export function makeClip({ id, trackId, patternId, mediaId, startBar = 0, lengthBars = 4, transpose = 0, offsetSeconds = 0, gainDb = 0, fadeInSeconds = 0, fadeOutSeconds = 0, reverse = false, stretchRatio = 1, semitones = 0, takeGroup = null, takeIndex = null, takeActive = true } = {}) {
  const clipStartBar = Math.max(0, Math.round(Number(startBar) || 0))
  const clipLengthBars = Math.min(LIMITS.maxBars, Math.max(1, Math.round(Number(lengthBars) || 1)))
  if (mediaId !== undefined && mediaId !== null && mediaId !== '') {
    // P3b：音频片段（无 patternId/transpose，引用 project.media 的 id）；
    // P6：offsetSeconds = 从媒体第几秒开始播放（默认 0）。
    const audioClip = {
      id,
      trackId,
      mediaId,
      startBar: clipStartBar,
      lengthBars: clipLengthBars,
      offsetSeconds: normalizeClipOffset(offsetSeconds),
    }
    // R2a：新字段先做范围规范化；fade 与媒体/片段时长的最终夹紧由 normalizeProject 完成。
    const gain = normalizeAudioClipGainDb(gainDb)
    if (gain !== 0) audioClip.gainDb = gain
    const fadeIn = normalizeAudioClipFadeSeconds(fadeInSeconds)
    if (fadeIn > 0) audioClip.fadeInSeconds = fadeIn
    const fadeOut = normalizeAudioClipFadeSeconds(fadeOutSeconds)
    if (fadeOut > 0) audioClip.fadeOutSeconds = fadeOut
    if (normalizeAudioClipReverse(reverse)) audioClip.reverse = true
    const stretch = normalizeAudioClipStretchRatio(stretchRatio)
    if (stretch !== 1) audioClip.stretchRatio = stretch
    const pitch = normalizeAudioClipSemitones(semitones)
    if (pitch !== 0) audioClip.semitones = pitch
    // R2c：take 字段（有 takeGroup 才写 takeIndex/takeActive）。
    const group = normalizeTakeGroup(takeGroup)
    if (group !== null) {
      audioClip.takeGroup = group
      const index = normalizeTakeIndex(takeIndex)
      if (index !== null) audioClip.takeIndex = index
      if (normalizeTakeActive(takeActive)) audioClip.takeActive = false
    }
    return audioClip
  }
  return {
    id,
    trackId,
    patternId,
    startBar: clipStartBar,
    lengthBars: clipLengthBars,
    transpose: Math.round(transpose || 0),
  }
}

export function makeSection({ id, name = 'Section', startBar = 0, lengthBars = 8, color } = {}) {
  return { id, name, startBar: Math.max(0, Math.round(startBar)), lengthBars: Math.max(1, Math.round(lengthBars)), color: color || '#F26B3A' }
}

/* ------------------------------------------------------------------------- */
/* R4b：发送模式 / 相位 / Mono / FX 旁路 / 手动 PDC                             */
/* ------------------------------------------------------------------------- */

/** 发送点：post（FX 后，默认）| pre（FX 前、轨道音量后）。 */
export const TRACK_SEND_MODES = Object.freeze(['post', 'pre'])
/** pdcMs 上限（毫秒）。 */
export const PDC_MS_MAX = 500
/** 规范化 pdcMs：0..500、1 位小数；非法/0 返回 0（字段省略）。 */
export function normalizePdcMs(raw) {
  if (raw === undefined || raw === null) return 0
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0
  const clamped = Math.max(0, Math.min(PDC_MS_MAX, value))
  return Math.round(clamped * 10) / 10
}

/* ------------------------------------------------------------------------- */
/* R4a：Group bus 路由（project.groups + track.output）                        */
/* ------------------------------------------------------------------------- */

/** 最多 group 数。 */
export const MAX_GROUPS = 8
/** group 名称最大长度。 */
export const GROUP_NAME_MAX = 40
/** R4a：group output 固定 master（防止环）。 */
export const GROUP_OUTPUT_MASTER = 'master'

/**
 * 规范化单个 group；非法返回 null。
 * @param {*} raw
 * @param {{index?:number, usedIds?:Set<string>}} [options]
 */
export function normalizeGroup(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const index = Number.isInteger(Number(options.index)) ? Number(options.index) : 0
  const usedIds = options.usedIds instanceof Set ? options.usedIds : new Set()
  let id = typeof raw.id === 'string' && /^grp_[0-9]+$/.test(raw.id) ? raw.id : null
  if (id === null || usedIds.has(id)) {
    let suffix = index + 1
    while (usedIds.has(`grp_${suffix}`)) suffix += 1
    id = `grp_${suffix}`
  }
  const rawName = typeof raw.name === 'string' ? raw.name.trim().replace(/[\u0000-\u001f]/g, '') : ''
  const name = rawName !== '' ? rawName.slice(0, GROUP_NAME_MAX) : `Group ${index + 1}`
  const level = Number.isFinite(Number(raw.level)) ? clamp01(Number(raw.level)) : 0.8
  return {
    id,
    name,
    level,
    effects: normalizeEffects(raw.effects),
    mute: raw.mute === true,
    solo: raw.solo === true,
    // R4b：组 FX 旁路 / 手动 PDC（0 省略）。
    ...(raw.bypassFx === true ? { bypassFx: true } : {}),
    ...(normalizePdcMs(raw.pdcMs) > 0 ? { pdcMs: normalizePdcMs(raw.pdcMs) } : {}),
    // R4a：本轮 output 固定 master（组不允许串联成环）。
    output: GROUP_OUTPUT_MASTER,
  }
}

/**
 * 规范化 project.groups：≤8、id 唯一、每组合法 FX 链。
 * @param {*} raw
 * @returns {object[]}
 */
export function normalizeGroups(raw) {
  const list = Array.isArray(raw) ? raw : []
  const groups = []
  const usedIds = new Set()
  for (const [index, item] of list.entries()) {
    if (groups.length >= MAX_GROUPS) break
    const group = normalizeGroup(item, { index, usedIds })
    if (!group) continue
    usedIds.add(group.id)
    groups.push(group)
  }
  return groups
}

/* ------------------------------------------------------------------------- */
/* R5d：内置 subtractive 合成器（track.engine/synthPreset/synthParams）         */
/* ------------------------------------------------------------------------- */

/** 轨道引擎：sampler（默认，SF2 采样）/ subtractive（内置合成器）。 */
export const TRACK_ENGINES = Object.freeze(['sampler', 'subtractive', 'vst3'])

/**
 * 规范化 subtractive synthParams：只保留非默认参数、未知字段忽略、数值夹紧/取整。
 * @param {*} raw
 * @param {{preset?:string|object}} [options] preset id 或默认参数对象
 * @returns {object}
 */
export function normalizeSynthParams(raw, options = {}) {
  const output = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return output
  let defaults = null
  if (typeof options.preset === 'string') defaults = findSynthInstrument(options.preset)?.synthPreset ?? null
  else if (options.preset !== null && typeof options.preset === 'object') defaults = options.preset
  for (const [key, spec] of Object.entries(SYNTH_INSTRUMENT_PARAM_SPECS)) {
    if (!Object.hasOwn(raw, key) || raw[key] === null || raw[key] === undefined) continue
    if (spec.type === 'enum') {
      if (!spec.options.includes(raw[key])) continue
      if (defaults && defaults[key] === raw[key]) continue
      output[key] = raw[key]
      continue
    }
    const value = Number(raw[key])
    if (!Number.isFinite(value)) continue
    const factor = 10 ** spec.round
    const clamped = Math.round(Math.max(spec.min, Math.min(spec.max, value)) * factor) / factor
    if (defaults && defaults[key] === clamped) continue
    output[key] = clamped
  }
  return output
}

/** 合成器默认参数（按 preset id；未知回退第一个）。 */
export function synthPresetDefaults(synthPresetId) {
  return { ...(findSynthInstrument(synthPresetId)?.synthPreset ?? SYNTH_INSTRUMENTS[0].synthPreset) }
}

/* ------------------------------------------------------------------------- */
/* R5b：采样器乐器参数（track.instrumentParams，仅 kind='synth'）               */
/* ------------------------------------------------------------------------- */

/** 乐器参数规格：range/default/round（round=小数位，0=整数）。 */
export const INSTRUMENT_PARAM_SPECS = Object.freeze({
  attack: { min: 0.001, max: 2, default: 0.005, round: 3 },
  release: { min: 0.01, max: 4, default: 0.2, round: 3 },
  filterCutoff: { min: 100, max: 20000, default: 20000, round: 1 },
  filterQ: { min: 0.1, max: 12, default: 0.7, round: 1 },
  lfoRate: { min: 0.1, max: 12, default: 5, round: 1 },
  lfoDepth: { min: 0, max: 100, default: 0, round: 0 },
})

/** 默认乐器参数（全部默认时省略 instrumentParams 字段）。 */
export const DEFAULT_INSTRUMENT_PARAMS = Object.freeze(
  Object.fromEntries(Object.entries(INSTRUMENT_PARAM_SPECS).map(([key, spec]) => [key, spec.default])),
)

function roundTo(value, places) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * 规范化 track.instrumentParams：未知字段忽略、数值夹紧/按规格取整、默认值省略。
 * @param {*} raw
 * @returns {object} 只含非默认字段（可能为 {}）
 */
export function normalizeInstrumentParams(raw) {
  const output = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return output
  for (const [key, spec] of Object.entries(INSTRUMENT_PARAM_SPECS)) {
    if (!Object.hasOwn(raw, key) || raw[key] === null || raw[key] === undefined) continue
    const value = Number(raw[key])
    if (!Number.isFinite(value)) continue
    const clamped = roundTo(Math.max(spec.min, Math.min(spec.max, value)), spec.round)
    if (clamped !== spec.default) output[key] = clamped
  }
  return output
}

/* ------------------------------------------------------------------------- */
/* R4d：轨道自动化模式（track.automationMode）                                  */
/* ------------------------------------------------------------------------- */

/** 自动化模式：read（默认，仅回放）/ touch / latch / write。 */
export const TRACK_AUTOMATION_MODES = Object.freeze(['read', 'touch', 'latch', 'write'])

/* ------------------------------------------------------------------------- */
/* R4c：混音场景快照（project.scenes）                                         */
/* ------------------------------------------------------------------------- */

/** 最多保存的混音场景数。 */
export const MAX_SCENES = 8
/** 场景名称最大长度。 */
export const SCENE_NAME_MAX = 40

const SCENE_TRACK_FIELDS = Object.freeze([
  'id', 'volume', 'pan', 'mute', 'solo', 'sends', 'sendMode', 'phaseInvert',
  'mono', 'bypassFx', 'pdcMs', 'output', 'effects',
])
const SCENE_GROUP_FIELDS = Object.freeze(['id', 'level', 'mute', 'solo', 'bypassFx', 'pdcMs', 'effects'])

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 深拷贝一条 FX 链（含参数；非法效果器丢弃）。 */
function cloneEffects(raw) {
  return normalizeEffects(raw).map((fx) => ({ ...fx, params: { ...(fx.params ?? {}) } }))
}

function sceneTrackSnapshot(track) {
  return {
    id: track.id,
    volume: clamp01(Number(track.volume ?? 0.78)),
    pan: clampPan(Number(track.pan ?? 0)),
    mute: track.mute === true,
    solo: track.solo === true,
    sends: {
      reverb: clamp01(Number(track.sends?.reverb ?? 0.18)),
      delay: clamp01(Number(track.sends?.delay ?? 0.12)),
    },
    sendMode: track.sendMode === 'pre' ? 'pre' : 'post',
    phaseInvert: track.phaseInvert === true,
    mono: track.mono === true,
    bypassFx: track.bypassFx === true,
    pdcMs: normalizePdcMs(track.pdcMs),
    output: typeof track.output === 'string' && track.output !== '' ? track.output : 'master',
    effects: cloneEffects(track.effects),
  }
}

function sceneGroupSnapshot(group) {
  return {
    id: group.id,
    level: clamp01(Number(group.level ?? 0.8)),
    mute: group.mute === true,
    solo: group.solo === true,
    bypassFx: group.bypassFx === true,
    pdcMs: normalizePdcMs(group.pdcMs),
    effects: cloneEffects(group.effects),
  }
}

/**
 * 采集当前工程混音字段快照（不含音符/编排/自动化；effects 深拷贝）。
 * @param {object} project
 */
export function captureSceneState(project) {
  return {
    tracks: (project.tracks ?? []).map(sceneTrackSnapshot),
    groups: (project.groups ?? []).map(sceneGroupSnapshot),
    master: {
      volume: clamp01(Number(project.master?.volume ?? 0.9)),
      effects: cloneEffects(project.master?.effects),
    },
    buses: {
      reverb: {
        level: clamp01(Number(project.buses?.reverb?.level ?? 0.35)),
        effects: cloneEffects(project.buses?.reverb?.effects),
      },
      delay: {
        level: clamp01(Number(project.buses?.delay?.level ?? 0.25)),
        effects: cloneEffects(project.buses?.delay?.effects),
      },
    },
  }
}

function sanitizeSceneState(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const tracks = []
  for (const item of Array.isArray(source.tracks) ? source.tracks : []) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id === '') continue
    const track = sceneTrackSnapshot(item)
    tracks.push(track)
  }
  const groups = []
  for (const item of Array.isArray(source.groups) ? source.groups : []) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id === '') continue
    groups.push(sceneGroupSnapshot(item))
  }
  return {
    tracks,
    groups,
    master: {
      volume: clamp01(Number(source.master?.volume ?? 0.9)),
      effects: cloneEffects(source.master?.effects),
    },
    buses: {
      reverb: {
        level: clamp01(Number(source.buses?.reverb?.level ?? 0.35)),
        effects: cloneEffects(source.buses?.reverb?.effects),
      },
      delay: {
        level: clamp01(Number(source.buses?.delay?.level ?? 0.25)),
        effects: cloneEffects(source.buses?.delay?.effects),
      },
    },
  }
}

/** 场景名称校验：trim 后 1..40、无控制字符。 */
export function normalizeSceneName(raw, fallback = '') {
  const name = typeof raw === 'string' ? raw.trim().replace(/[\u0000-\u001f]/g, '') : ''
  if (name !== '') return name.slice(0, SCENE_NAME_MAX)
  return fallback
}

/**
 * 规范化单个场景；非法返回 null。
 * @param {*} raw
 * @param {{index?:number, usedIds?:Set<string>, usedNames?:Set<string>}} [options]
 */
export function normalizeScene(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const index = Number.isInteger(Number(options.index)) ? Number(options.index) : 0
  const usedIds = options.usedIds instanceof Set ? options.usedIds : new Set()
  const usedNames = options.usedNames instanceof Set ? options.usedNames : new Set()
  let id = typeof raw.id === 'string' && /^scene_[0-9]+$/.test(raw.id) ? raw.id : null
  if (id === null || usedIds.has(id)) {
    let suffix = index + 1
    while (usedIds.has(`scene_${suffix}`)) suffix += 1
    id = `scene_${suffix}`
  }
  const name = normalizeSceneName(raw.name, `Scene ${index + 1}`)
  if (usedNames.has(name)) return null
  const at = typeof raw.at === 'string' && raw.at !== '' ? raw.at : null
  return {
    id,
    name,
    ...(at ? { at } : {}),
    state: sanitizeSceneState(raw.state),
  }
}

/**
 * 规范化 project.scenes：≤8、id/名称唯一。
 * @param {*} raw
 */
export function normalizeScenes(raw) {
  const list = Array.isArray(raw) ? raw : []
  const scenes = []
  const usedIds = new Set()
  const usedNames = new Set()
  for (const [index, item] of list.entries()) {
    if (scenes.length >= MAX_SCENES) break
    const scene = normalizeScene(item, { index, usedIds, usedNames })
    if (!scene) continue
    usedIds.add(scene.id)
    usedNames.add(scene.name)
    scenes.push(scene)
  }
  return scenes
}

/** 场景摘要（get_project/列表用；不含 state）。 */
export function sceneSummary(scene) {
  return {
    id: scene.id,
    name: scene.name,
    ...(scene.at ? { at: scene.at } : {}),
    trackCount: Array.isArray(scene.state?.tracks) ? scene.state.tracks.length : 0,
    groupCount: Array.isArray(scene.state?.groups) ? scene.state.groups.length : 0,
  }
}

/* ------------------------------------------------------------------------- */
/* R3c：MIDI Learn / 外部控制器映射（project.midiMappings）                    */
/* ------------------------------------------------------------------------- */

/** 项目最多保存多少条 MIDI 映射。 */
export const MIDI_MAPPING_MAX = 16
/** 支持的映射目标。 */
export const MIDI_MAPPING_TARGETS = Object.freeze(['volume', 'pan', 'sendReverb', 'sendDelay', 'effectParam'])
/** effectParam 目标可映射的连续参数 id（所有效果器类型的参数并集）。 */
export const MIDI_MAPPING_EFFECT_PARAMS = Object.freeze([
  ...new Set(Object.values(FX_PARAM_SPECS).flatMap((spec) => Object.keys(spec))),
])

/** 某个效果器类型可映射的参数 id 列表。 */
export function effectParamIds(effectType) {
  const spec = FX_PARAM_SPECS[effectType]
  return spec ? Object.keys(spec) : []
}

function clampMappingValue(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) ? clamp01(value) : fallback
}

/**
 * 规范化单条 MIDI 映射；非法返回 null。
 * @param {object} raw
 * @param {{index?:number, tracks?:object[]}} [options]
 */
export function normalizeMidiMapping(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const index = Number.isInteger(Number(options.index)) ? Number(options.index) : 0
  const tracks = Array.isArray(options.tracks) ? options.tracks : []
  if (raw.cc === null || raw.cc === undefined || raw.cc === '') return null
  const cc = Number(raw.cc)
  if (!Number.isInteger(cc) || cc < 0 || cc > 127) return null
  let channel = null
  if (raw.channel !== undefined && raw.channel !== null) {
    const numeric = Number(raw.channel)
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 15) return null
    channel = numeric
  }
  const target = typeof raw.target === 'string' ? raw.target : ''
  if (!MIDI_MAPPING_TARGETS.includes(target)) return null
  const trackId = typeof raw.trackId === 'string' ? raw.trackId : ''
  const track = tracks.find((item) => item.id === trackId)
  if (!track) return null
  const idRaw = typeof raw.id === 'string' && /^map_[0-9]+$/.test(raw.id) ? raw.id : null
  const mapping = {
    id: idRaw ?? `map_${index + 1}`,
    cc,
    channel,
    target,
    trackId,
  }
  if (target === 'effectParam') {
    const effects = Array.isArray(track.effects) ? track.effects : []
    const effectId = typeof raw.effectId === 'string' ? raw.effectId : ''
    const effect = effects.find((fx) => fx.id === effectId)
    const param = typeof raw.param === 'string' ? raw.param : ''
    const paramSpecs = effect ? FX_PARAM_SPECS[effect.type] : null
    if (!effect || !paramSpecs || !Object.hasOwn(paramSpecs, param)) return null
    mapping.effectId = effectId
    mapping.param = param
  }
  let min = 0
  let max = 1
  if (raw.min !== undefined && raw.min !== null) {
    const value = Number(raw.min)
    if (!Number.isFinite(value)) return null
    min = clamp01(value)
  }
  if (raw.max !== undefined && raw.max !== null) {
    const value = Number(raw.max)
    if (!Number.isFinite(value)) return null
    max = clamp01(value)
  }
  mapping.min = min
  mapping.max = max
  if (!(mapping.min < mapping.max)) return null
  return mapping
}

/**
 * 规范化 project.midiMappings：≤16 条、cc+channel 唯一、id 唯一、轨道/效果器合法性。
 * @param {*} raw
 * @param {{tracks?:object[]}} [options]
 * @returns {object[]}
 */
export function normalizeMidiMappings(raw, options = {}) {
  const list = Array.isArray(raw) ? raw : []
  const tracks = Array.isArray(options.tracks) ? options.tracks : []
  const mappings = []
  const usedIds = new Set()
  const usedKeys = new Set()
  for (const [index, item] of list.entries()) {
    if (mappings.length >= MIDI_MAPPING_MAX) break
    const mapping = normalizeMidiMapping(item, { index, tracks })
    if (!mapping) continue
    if (usedIds.has(mapping.id)) {
      let suffix = index + 1
      while (usedIds.has(`map_${suffix}`)) suffix += 1
      mapping.id = `map_${suffix}`
    }
    const key = `${mapping.channel === null ? 'any' : mapping.channel}:${mapping.cc}`
    if (usedKeys.has(key)) continue
    usedIds.add(mapping.id)
    usedKeys.add(key)
    mappings.push(mapping)
  }
  return mappings
}

/** 空白项目。 */
export function createEmptyProject({ title = '未命名作品', bpm = 128, key = 'F#', scale = 'minor', lengthBars = 32, timeSignature = [4, 4], swing = 0, artist = 'DeepSeek AI' } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    format: createProjectFormat(),
    title,
    artist,
    composer: 'DeepSeek AI',
    bpm: clamp(Number(bpm) || 128, LIMITS.minBpm, LIMITS.maxBpm),
    key,
    scale,
    timeSignature,
    swing: clamp01(swing),
    lengthBars: clamp(Math.round(Number(lengthBars) || 32), 1, LIMITS.maxBars),
    tracks: [],
    media: [],
    patterns: [],
    clips: [],
    sections: [],
    master: defaultMaster(),
    buses: createDefaultBuses(),
    // R3c：MIDI Learn 映射（缺字段=[]）。
    midiMappings: [],
    // R4a：Group bus（缺字段=[]）。
    groups: [],
    // R4c：混音场景快照（缺字段=[]）。
    scenes: [],
    transport: {
      playing: false,
      playheadBar: 0,
      loopStartBar: 0,
      loopEndBar: Math.min(16, Math.max(1, Number(lengthBars) || 32)),
      cmd: null,
    },
    activity: { text: '等待 AI 开始创作…', at: Date.now() },
    history: [],
    exportRequest: null,
    lastExport: null,
    // P11：最近 10 次导出记录（name/format/seconds/bytes/path/at）。
    exportHistory: [],
    // R0A：导出任务历史（jobId/status/path/outputDir…，最近 10 条）。
    exportJobs: [],
    revision: 1,
    updatedAt: Date.now(),
  }
}

/** 项目统计（UI 与工具共用）。 */
export function projectStats(project) {
  const notes = project.patterns.reduce((sum, p) => sum + p.notes.length, 0)
  // task-75：时长按 tempoMap 积分（BPM 线性插值）；无法积分时退回常量 BPM 并标 estimated。
  const duration = projectDurationSeconds(project)
  const exact = Number.isFinite(duration)
  const fallback = (project.lengthBars * beatsPerBar(project) / project.bpm) * 60
  return {
    bars: project.lengthBars,
    bpm: project.bpm,
    tracks: project.tracks.length,
    patterns: project.patterns.length,
    clips: project.clips.length,
    notes,
    effects: project.tracks.reduce((s, t) => s + t.effects.length, 0) + project.master.effects.length,
    sections: project.sections.length,
    durationSeconds: Math.round(exact ? duration : fallback),
    ...(exact ? {} : { estimated: true }),
    ...(Array.isArray(project.tempoMap) && project.tempoMap.length > 0 ? { durationSource: 'tempoMap' } : {}),
  }
}

/** 片段内实际响起的音符（把 pattern 循环平铺 + 移调）。音频片段没有音符，返回 []。 */
export function clipNotes(project, clip) {
  if (clip?.mediaId !== undefined && clip?.mediaId !== null && clip?.mediaId !== '') return []
  const pattern = project.patterns.find((p) => p.id === clip.patternId)
  const track = project.tracks.find((t) => t.id === clip.trackId)
  if (!pattern || !track) return []
  const barBeats = beatsPerBar(project)
  const patBeats = Math.max(1, pattern.lengthBars) * barBeats
  const clipBeats = Math.max(1, clip.lengthBars) * barBeats
  const startBeat = clip.startBar * barBeats
  const out = []
  for (let offset = 0; offset < clipBeats - 1e-6; offset += patBeats) {
    for (const n of pattern.notes) {
      const at = offset + n.start
      if (at >= clipBeats - 1e-6) continue
      out.push({
        trackId: track.id,
        pitch: n.pitch + (clip.transpose || 0),
        start: startBeat + at,
        dur: Math.min(n.dur, clipBeats - at),
        vel: n.vel,
        kind: track.kind,
      })
    }
  }
  return out
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
export const clamp01 = (v) => clamp(Number(v) || 0, 0, 1)
export const clampPan = (v) => clamp(Number(v) || 0, -1, 1)
export const isDrumPitch = (pitch) => Boolean(findDrumPiece(pitch))
export { findDrumKit, findDrumPiece, findFxType, findScale, findSynthPreset, presetParams, kitParams, fxDefaultParams, SYNTH_PRESETS, DRUM_KITS, FX_TYPES, TRACK_COLORS, SCALES, DRUM_PIECES, LIMITS }
