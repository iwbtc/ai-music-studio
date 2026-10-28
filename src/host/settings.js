/**
 * R7b：产品设置（data/settings.json）。
 *
 * - 默认 {channel:'stable', telemetryOptIn:false, crashReports:true, language:'zh-CN'}；
 * - 缺失/损坏 JSON/非法字段 → 逐字段回默认；
 * - save 原子写（临时文件 + rename），不触碰工程 revision / undo。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const SETTINGS_FILE_NAME = 'settings.json'
export const SETTINGS_CHANNELS = Object.freeze(['stable', 'beta'])
export const SETTINGS_LANGUAGES = Object.freeze(['zh-CN', 'en-US'])
export const DEFAULT_SETTINGS = Object.freeze({
  channel: 'stable',
  telemetryOptIn: false,
  crashReports: true,
  language: 'zh-CN',
})
export const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS))

/** 设置文件路径。 */
export function settingsFilePath(dataDir) {
  return path.join(String(dataDir ?? ''), SETTINGS_FILE_NAME)
}

function normalizeField(key, value) {
  if (key === 'channel') return SETTINGS_CHANNELS.includes(value) ? value : DEFAULT_SETTINGS.channel
  if (key === 'language') return SETTINGS_LANGUAGES.includes(value) ? value : DEFAULT_SETTINGS.language
  if (key === 'telemetryOptIn' || key === 'crashReports') return typeof value === 'boolean' ? value : DEFAULT_SETTINGS[key]
  return DEFAULT_SETTINGS[key]
}

/** 逐字段规范化为完整设置（非法值回默认）。 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const settings = {}
  for (const key of SETTINGS_KEYS) settings[key] = normalizeField(key, source[key])
  return settings
}

/** 读取设置（缺失/损坏/越权 → 默认；不抛错）。 */
export async function loadSettings(dataDir) {
  try {
    const raw = await readFile(settingsFilePath(dataDir), 'utf8')
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 严格校验一个 patch（未知字段/非法值 → 中文错误）。 */
export function validateSettingsPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置参数必须是对象')
  const keys = Object.keys(patch)
  if (keys.length === 0) throw new Error('至少需要提供一个设置字段')
  const unknown = keys.filter((key) => !SETTINGS_KEYS.includes(key))
  if (unknown.length > 0) throw new Error(`未知设置字段：${unknown.join(' / ')}；可选：${SETTINGS_KEYS.join(' / ')}`)
  const normalized = {}
  for (const key of keys) {
    const value = patch[key]
    if (key === 'channel' && !SETTINGS_CHANNELS.includes(value)) {
      throw new Error(`channel 必须是 ${SETTINGS_CHANNELS.join(' / ')}，收到「${String(value)}」`)
    }
    if (key === 'language' && !SETTINGS_LANGUAGES.includes(value)) {
      throw new Error(`language 必须是 ${SETTINGS_LANGUAGES.join(' / ')}，收到「${String(value)}」`)
    }
    if ((key === 'telemetryOptIn' || key === 'crashReports') && typeof value !== 'boolean') {
      throw new Error(`${key} 必须是布尔值`)
    }
    normalized[key] = value
  }
  return normalized
}

/** 保存设置（patch 合并；原子写）。返回完整设置。 */
export async function saveSettings(dataDir, patch = {}) {
  const normalizedPatch = validateSettingsPatch(patch)
  const current = await loadSettings(dataDir)
  const next = normalizeSettings({ ...current, ...normalizedPatch })
  const dir = String(dataDir ?? '')
  await mkdir(dir, { recursive: true })
  const file = settingsFilePath(dir)
  const temp = path.join(dir, `.settings-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw new Error(`保存设置失败：${error?.message ?? error}`)
  }
  return next
}

/** 整体替换设置（测试/恢复用；同样原子写）。 */
export async function writeSettings(dataDir, settings) {
  return saveSettings(dataDir, normalizeSettings(settings))
}
