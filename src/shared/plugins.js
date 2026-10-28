/**
 * R5c：插件 SDK 清单（内部音色/效果器抽象为可枚举、可序列化的插件）。
 *
 * - PLUGIN_SDK_VERSION：插件状态序列化版本；
 * - INSTRUMENT_PLUGINS：32 个采样乐器（参数来自 INSTRUMENT_PARAM_SPECS）；
 * - EFFECT_PLUGINS：15 个效果器（参数来自 FX_PARAM_SPECS，全量 schema）；
 * - getPlugin / listPlugins / serializePluginState / deserializePluginState。
 */
import { FX_PARAM_SPECS, FX_TYPES, SYNTH_PRESETS } from './catalog.js'
import { INSTRUMENT_PARAM_SPECS } from './model.js'

/** 插件状态序列化 SDK 版本。 */
export const PLUGIN_SDK_VERSION = '1.0'

const INSTRUMENT_PARAM_META = {
  attack: { label: '起音', unit: 's', step: 0.001 },
  release: { label: '释音', unit: 's', step: 0.001 },
  filterCutoff: { label: '滤波截止', unit: 'Hz', step: 1 },
  filterQ: { label: '滤波 Q', unit: '', step: 0.1 },
  lfoRate: { label: 'LFO 速率', unit: 'Hz', step: 0.1 },
  lfoDepth: { label: 'LFO 深度', unit: 'cents', step: 1 },
}

function instrumentParamSchema() {
  return Object.entries(INSTRUMENT_PARAM_SPECS).map(([key, spec]) => ({
    key,
    label: INSTRUMENT_PARAM_META[key].label,
    type: 'number',
    min: spec.min,
    max: spec.max,
    default: spec.default,
    unit: INSTRUMENT_PARAM_META[key].unit,
    step: INSTRUMENT_PARAM_META[key].step,
  }))
}

function effectParamSchema(effectType) {
  const specs = FX_PARAM_SPECS[effectType] ?? {}
  return Object.entries(specs).map(([key, spec]) => {
    const type = spec.type ?? 'number'
    const numeric = type === 'number' || type === 'integer'
    return {
      key,
      label: spec.label ?? key,
      type,
      ...(Array.isArray(spec.options) ? { options: [...spec.options] } : {}),
      ...(Number.isFinite(spec.min) ? { min: spec.min } : {}),
      ...(Number.isFinite(spec.max) ? { max: spec.max } : {}),
      ...(spec.default !== undefined ? { default: spec.default } : {}),
      // 插件参数 schema 对数值参数必须带 unit/step；FX 规格未标注时给安全的占位值。
      ...(numeric ? { unit: spec.unit ?? '', step: Number.isFinite(spec.step) ? spec.step : 1 } : {}),
      ...(spec.group ? { group: spec.group } : {}),
    }
  })
}

/** 32 个采样乐器插件。 */
export const INSTRUMENT_PLUGINS = Object.freeze(
  SYNTH_PRESETS.map((preset) => Object.freeze({
    id: preset.id,
    name: preset.name,
    kind: 'instrument',
    category: preset.category,
    params: Object.freeze(instrumentParamSchema()),
    stateVersion: 1,
  })),
)

/** 15 个效果器插件。 */
export const EFFECT_PLUGINS = Object.freeze(
  FX_TYPES.map((fxType) => Object.freeze({
    id: fxType.id,
    name: fxType.label ?? fxType.name ?? fxType.id,
    kind: 'effect',
    category: fxType.category ?? '效果器',
    params: Object.freeze(effectParamSchema(fxType.id)),
    stateVersion: 1,
  })),
)

/** 全部插件（乐器在前、效果器在后）。 */
export const ALL_PLUGINS = Object.freeze([...INSTRUMENT_PLUGINS, ...EFFECT_PLUGINS])

/**
 * 按 id 查插件（未知返回 null）。
 * @param {string} pluginId
 * @returns {object|null}
 */
export function getPlugin(pluginId) {
  return ALL_PLUGINS.find((plugin) => plugin.id === pluginId) ?? null
}

/**
 * 列表（可按 type='instrument'|'effect' 过滤；未知 type 抛中文错误）。
 * @param {{type?:string}} [options]
 */
export function listPlugins(options = {}) {
  const type = options.type
  if (type !== undefined && type !== null && type !== '') {
    if (type !== 'instrument' && type !== 'effect') {
      throw new Error(`未知插件类型 type=${String(type)}；可选：instrument / effect`)
    }
    return (type === 'instrument' ? INSTRUMENT_PLUGINS : EFFECT_PLUGINS).map(clonePlugin)
  }
  return ALL_PLUGINS.map(clonePlugin)
}

function clonePlugin(plugin) {
  return {
    ...plugin,
    category: plugin.category,
    params: plugin.params.map((param) => ({ ...param, ...(param.options ? { options: [...param.options] } : {}) })),
  }
}

function pluginParamMap(plugin) {
  return new Map(plugin.params.map((param) => [param.key, param]))
}

/** 序列化插件状态：校验插件与字段/范围；返回 JSON 字符串。 */
export function serializePluginState(pluginId, state) {
  const plugin = getPlugin(pluginId)
  if (!plugin) throw new Error(`未知插件 pluginId=${String(pluginId)}`)
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('插件状态必须是对象，如 { attack: 0.1 }')
  }
  const paramMap = pluginParamMap(plugin)
  const normalized = {}
  for (const [key, value] of Object.entries(state)) {
    const spec = paramMap.get(key)
    if (!spec) throw new Error(`插件 ${pluginId} 不支持参数「${key}」；可选：${[...paramMap.keys()].join(' / ')}`)
    if (spec.type === 'enum') {
      if (!spec.options.includes(value)) throw new Error(`插件 ${pluginId} 参数 ${key} 必须是 ${spec.options.join(' / ')} 之一`)
      normalized[key] = value
      continue
    }
    if (spec.type === 'bool') {
      if (typeof value !== 'boolean') throw new Error(`插件 ${pluginId} 参数 ${key} 必须是布尔值`)
      normalized[key] = value
      continue
    }
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) throw new Error(`插件 ${pluginId} 参数 ${key} 必须是数字`)
    if (Number.isFinite(spec.min) && numeric < spec.min) throw new Error(`插件 ${pluginId} 参数 ${key} 不能小于 ${spec.min}`)
    if (Number.isFinite(spec.max) && numeric > spec.max) throw new Error(`插件 ${pluginId} 参数 ${key} 不能大于 ${spec.max}`)
    normalized[key] = numeric
  }
  return JSON.stringify({
    sdkVersion: PLUGIN_SDK_VERSION,
    pluginId: plugin.id,
    stateVersion: plugin.stateVersion,
    state: normalized,
  })
}

/** 反序列化插件状态：校验版本/字段；返回 normalized state 对象。 */
export function deserializePluginState(pluginId, json) {
  const plugin = getPlugin(pluginId)
  if (!plugin) throw new Error(`未知插件 pluginId=${String(pluginId)}`)
  if (typeof json !== 'string' || json.trim() === '') throw new Error('插件状态 JSON 不能为空')
  let payload
  try {
    payload = JSON.parse(json)
  } catch (error) {
    throw new Error(`插件状态不是合法 JSON：${error?.message ?? error}`)
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('插件状态 JSON 必须是对象')
  }
  if (payload.sdkVersion !== PLUGIN_SDK_VERSION) {
    throw new Error(`插件 SDK 版本不兼容：期望 ${PLUGIN_SDK_VERSION}，收到 ${String(payload.sdkVersion)}`)
  }
  if (payload.pluginId !== plugin.id) {
    throw new Error(`插件 ID 不匹配：期望 ${plugin.id}，收到 ${String(payload.pluginId)}`)
  }
  if (payload.stateVersion !== plugin.stateVersion) {
    throw new Error(`插件状态版本不匹配：期望 ${plugin.stateVersion}，收到 ${String(payload.stateVersion)}`)
  }
  // 复用序列化校验逻辑（state 字段/范围）
  const validated = JSON.parse(serializePluginState(pluginId, payload.state))
  return validated.state
}
