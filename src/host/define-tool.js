/**
 * 自包含版 defineTool（与 DSH 0.2.1 `@deepseek-ai/dsh-tools` 的 defineTool 行为对齐）。
 *
 * 为什么不直接 import 官方包：插件通过 `link:` 安装在 profile 之外（工作区）时，
 * Node 从工作区解析不到 `@deepseek-ai/dsh-tools`（只有 profile/node_modules 及其
 * 上级 profiles/node_modules 才能解析）。为了让插件在任何安装位置都能加载，
 * 这里本地复刻官方行为：
 *   - 把「参数 DSL」编译成官方使用的原始 JSON Schema（parameterSchemaSpecToJsonSchema）；
 *   - execute 前校验参数，非法参数抛出 `invalid arguments: ...`（官方 ToolArgsError 的 message）；
 *   - 产出 registry 需要的 ToolDefinition 形状 { name, description, parameters, output, execute }。
 *
 * DSL 与官方一致：{ key: { type, required?, description?, enum?, default?, items?, properties?, additionalProperties? } }
 */
import { isPlainObject, isLosslessJsonValue } from './json.js'

/** 值类型允许的额外标注键（description/default/examples）。 */
const ANNOTATION_KEYS = ['description', 'default', 'examples']
const VALUE_KEYS = ['type', 'enum', 'const', 'items', 'properties', 'additionalProperties']

/**
 * 把一个 DSL 值节点编译为原始 JSON Schema 节点。
 * @param {object} spec DSL 节点
 * @param {string} path 诊断路径
 * @param {boolean} allowRequired 是否允许 required 标注（仅对象 properties 下允许）
 */
function compileValue(spec, path, allowRequired) {
  if (!isPlainObject(spec)) throw new Error(`${path} must be an object schema`)
  const type = spec.type
  if (typeof type !== 'string') throw new Error(`${path}.type must be a string`)
  const out = {}
  for (const key of Object.keys(spec)) {
    if (VALUE_KEYS.includes(key) || ANNOTATION_KEYS.includes(key)) continue
    if (key === 'required' && allowRequired) continue
    throw new Error(`${path}.${key} is not a supported schema key`)
  }
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      out.type = type
      copyAnnotations(spec, out)
      if (spec.enum !== undefined) {
        if (!Array.isArray(spec.enum) || spec.enum.length === 0) throw new Error(`${path}.enum must be a non-empty array`)
        out.enum = Array.from(spec.enum)
      }
      if (spec.const !== undefined) out.const = spec.const
      return out
    }
    case 'array': {
      out.type = 'array'
      copyAnnotations(spec, out)
      if (spec.items !== undefined) out.items = compileValue(spec.items, `${path}.items`, false)
      return out
    }
    case 'object': {
      out.type = 'object'
      copyAnnotations(spec, out)
      // 与官方编译顺序保持一致：type → annotations → additionalProperties → properties → required
      if (spec.additionalProperties !== undefined) out.additionalProperties = spec.additionalProperties
      if (spec.properties !== undefined) {
        const { properties, required } = compilePropertyMap(spec.properties, `${path}.properties`)
        out.properties = properties
        if (required.length > 0) out.required = required
      }
      return out
    }
    case 'json': {
      // 作者专用：无约束 JSON 节点（官方编译为仅标注的 schema）
      copyAnnotations(spec, out)
      return out
    }
    default:
      throw new Error(`${path}.type must be string/number/integer/boolean/null/array/object/json`)
  }
}

function copyAnnotations(spec, out) {
  for (const key of ANNOTATION_KEYS) {
    if (spec[key] !== undefined) out[key] = spec[key]
  }
}

/** 编译隐式参数对象。 */
function compilePropertyMap(spec, path) {
  if (!isPlainObject(spec)) throw new Error(`${path} must be a property map`)
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    if (!isPlainObject(value)) throw new Error(`${path}.${key} must be an object schema`)
    properties[key] = compileValue(value, `${path}.${key}`, true)
    if (value.required === true) required.push(key)
  }
  return { properties, required }
}

/**
 * 官方行为对齐：参数 DSL → 原始 JSON Schema（object 根，required 为字符串数组）。
 * @param {object} spec 参数 DSL
 */
export function parameterSchemaSpecToJsonSchema(spec) {
  const { properties, required } = compilePropertyMap(spec, 'parameters')
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  assertSupportedJsonSchema(schema)
  return schema
}
/** 官方支持的 JSON Schema 子集断言（用于尽早暴露 schema 错误）。 */
export function assertSupportedJsonSchema(node, path = 'schema') {
  if (!isPlainObject(node)) throw new Error(`${path} must be an object`)
  const type = node.type
  const allowed = ['type', 'description', 'default', 'examples', 'enum', 'const', 'items', 'properties', 'required', 'additionalProperties']
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not a supported JSON Schema key`)
  }
  if (type === undefined) return
  if (type === 'object') {
    if (node.properties !== undefined) {
      if (!isPlainObject(node.properties)) throw new Error(`${path}.properties must be an object`)
      const req = node.required
      if (req !== undefined && (!Array.isArray(req) || req.some((k) => typeof k !== 'string'))) {
        throw new Error(`${path}.required must be a string array`)
      }
      for (const [key, child] of Object.entries(node.properties)) assertSupportedJsonSchema(child, `${path}.properties.${key}`)
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
      throw new Error(`${path}.additionalProperties must be a boolean`)
    }
    return
  }
  if (type === 'array') {
    if (node.items !== undefined) assertSupportedJsonSchema(node.items, `${path}.items`)
    return
  }
  if (!['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    throw new Error(`${path}.type is not a supported JSON Schema type`)
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    throw new Error(`${path}.enum must be a non-empty array`)
  }
}

/** 参数校验：返回违规路径列表（空 = 合法）。 */
export function validateJsonSchemaValue(schema, value, path = '') {
  const errors = []
  if (schema === undefined) return errors
  const type = schema.type
  const here = path === '' ? 'arguments' : path
  if (type === 'object') {
    if (!isPlainObject(value)) return [`${here} must be an object`]
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${here}.${key} is required`)
    }
    for (const [key, child] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) errors.push(...validateJsonSchemaValue(child, value[key], `${here}.${key}`))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) errors.push(`${here}.${key} is not allowed`)
      }
    }
    return errors
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${here} must be an array`]
    if (schema.items) value.forEach((item, index) => errors.push(...validateJsonSchemaValue(schema.items, item, `${here}[${index}]`)))
    return errors
  }
  if (type === 'string') {
    if (typeof value !== 'string') return [`${here} must be a string`]
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${here} must be a number`]
  } else if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return [`${here} must be an integer`]
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [`${here} must be a boolean`]
  } else if (type === 'null') {
    if (value !== null) return [`${here} must be null`]
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${here} must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (schema.const !== undefined && !Object.is(schema.const, value)) errors.push(`${here} must equal ${JSON.stringify(schema.const)}`)
  return errors
}

/**
 * 与官方 defineTool 对齐的本地实现。
 * @param {object} options { name, description, parameters, output:{schema,render}, execute, ... }
 */
export function defineTool(options) {
  if (options === null || typeof options !== 'object') throw new Error('defineTool(options) requires an object')
  const { name, description, parameters, output } = options
  if (typeof name !== 'string' || name.length === 0) throw new Error('defineTool: name must be a non-empty string')
  if (typeof description !== 'string') throw new Error(`defineTool(${name}): description must be a string`)
  if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
    throw new Error(`tool "${name}" must declare output { schema, render }`)
  }
  const parameterSchema = parameterSchemaSpecToJsonSchema(parameters ?? {})
  assertSupportedJsonSchema(output.schema, 'output.schema')
  const userExecute = options.execute
  if (typeof userExecute !== 'function') throw new Error(`defineTool(${name}): execute must be a function`)
  return {
    name,
    description,
    parameters: parameterSchema,
    output: { schema: output.schema, render: output.render },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.isConcurrencySafe ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    async execute(args, exec) {
      const violations = validateJsonSchemaValue(parameterSchema, args, '')
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return userExecute(args, exec)
    },
  }
}

/** 官方 ToolDefinition 还需满足：成功返回值是 lossless JSON（这里做一次断言辅助）。 */
export function assertLosslessJson(value, path = 'value') {
  if (!isLosslessJsonValue(value)) throw new Error(`${path} is not lossless JSON`)
  return value
}
