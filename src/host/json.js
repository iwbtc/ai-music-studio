/**
 * 轻量 JSON 工具函数（Host 半区自包含，不依赖外部包）。
 */

/** 是否为普通对象（非数组/null/类实例）。 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 是否是可无损往返的 JSON 值。 */
export function isLosslessJsonValue(value) {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return true
  if (kind === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (kind !== 'object') return false
  if (Array.isArray(value)) return value.every(isLosslessJsonValue)
  if (!isPlainObject(value)) return false
  return Object.values(value).every(isLosslessJsonValue)
}
