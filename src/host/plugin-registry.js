/**
 * v2.2 M1：外部 VST3 插件 registry（扫描 / 导入托管 / 卸载 / 列表）。
 *
 * - registry: <dataDir>/plugins.json（原子写）
 * - 托管副本: <dataDir>/plugins/<pluginId>[.vst3]
 * - 只做文件管理 + sidecar inspect；不执行插件 UI 代码。
 * - uninstall 只删托管副本，工程引用由 ops 标记 missing。
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'

/** Windows 下 sidecar 可能仍持有 .vst3 文件；删除/覆盖前短重试。 */
async function rmWithRetry(target, attempts = 6) {
  let lastError = null
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return true
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 120 * (index + 1)))
    }
  }
  if (lastError) throw lastError
  return true
}

async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}
import path from 'node:path'

export const PLUGIN_REGISTRY_FILE = 'plugins.json'
export const PLUGIN_MANAGED_DIR = 'plugins'
export const PLUGIN_REGISTRY_VERSION = 1
export const MAX_PLUGIN_SCAN_DEPTH = 6

function safeString(value, max = 200) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null
}

/**
 * 把 .vst3 bundle 目录解析到实际可加载的二进制文件（nvst3 inspect/load 需要文件路径）。
 * 支持 Contents/<arch>/<name>.vst3；文件直接返回。
 */
export async function resolveVst3BinaryPath(target) {
  const resolved = path.resolve(String(target ?? ''))
  let info
  try {
    info = await stat(resolved)
  } catch {
    throw new PluginRegistryError(`插件路径不存在：${resolved}`, 'PLUGIN_NOT_FOUND')
  }
  if (info.isFile()) return resolved
  const platformDirs = process.platform === 'win32'
    ? ['x86_64-win', 'x86-win']
    : process.platform === 'darwin' ? ['MacOS'] : ['x86_64-linux', 'aarch64-linux']
  for (const platformDir of platformDirs) {
    const dir = path.join(resolved, 'Contents', platformDir)
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.vst3')) return path.join(dir, entry.name)
    }
  }
  // 兜底：递归找第一个 .vst3 文件
  async function find(dir, depth) {
    if (depth > 4) return null
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return null }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.vst3')) return full
      if (entry.isDirectory()) {
        const nested = await find(full, depth + 1)
        if (nested) return nested
      }
    }
    return null
  }
  const fallback = await find(resolved, 0)
  if (fallback) return fallback
  throw new PluginRegistryError(`无法在 .vst3 bundle 中找到二进制：${resolved}`, 'PLUGIN_INVALID_PATH')
}

/** inspect 可能返回 Audio Module + Controller 两个 class；优先 Audio Module Class。 */
export function selectPrimaryPluginInfo(list) {
  const items = Array.isArray(list) ? list : [list]
  const usable = items.filter((item) => item && typeof item === 'object')
  return usable.find((item) => /audio module/i.test(String(item.category ?? ''))) ?? usable[0] ?? null
}

export class PluginRegistryError extends Error {
  constructor(message, code = 'PLUGIN_REGISTRY_ERROR') {
    super(message)
    this.name = 'PluginRegistryError'
    this.code = code
  }
}

export function plugRegistryPath(dataDir) {
  return path.join(String(dataDir ?? ''), PLUGIN_REGISTRY_FILE)
}
export function pluginManagedDir(dataDir) {
  return path.join(String(dataDir ?? ''), PLUGIN_MANAGED_DIR)
}

/** 生成稳定 pluginId（classId 优先，否则路径 hash）。 */
export function makePluginId(info = {}, sourcePath = '') {
  const seed = String(info.classId ?? '') || path.resolve(String(sourcePath ?? ''))
  const hash = createHash('sha1').update(seed).digest('hex').slice(0, 16)
  return `vst3_${hash}`
}

/** provider → 统一插件元信息（缺字段安全）。 */
export function normalizePluginInfo(raw = {}, sourcePath = '') {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const category = safeString(source.category, 120) ?? 'Audio Module Class'
  const subCategories = safeString(source.subCategories, 240) ?? ''
  const combined = `${category} ${subCategories}`
  const name = safeString(source.name, 160) ?? safeString(source.title, 160) ?? path.basename(String(sourcePath || 'VST3'), '.vst3')
  return {
    pluginId: makePluginId(source, sourcePath),
    name,
    vendor: safeString(source.vendor, 160) ?? '',
    version: safeString(source.version, 80) ?? '',
    category,
    subCategories,
    classId: safeString(source.classId, 64) ?? '',
    numAudioInputs: Number.isFinite(Number(source.numAudioInputs)) ? Number(source.numAudioInputs) : 0,
    numAudioOutputs: Number.isFinite(Number(source.numAudioOutputs)) ? Number(source.numAudioOutputs) : 0,
    isInstrument: /instrument/i.test(combined) || (Number(source.numAudioInputs) === 0 && Number(source.numAudioOutputs) > 0),
    isEffect: /fx|effect/i.test(combined) || Number(source.numAudioInputs) > 0 || Number(source.numAudioOutputs) > 0,
    hasMidiInput: Number(source.numMidiInputs) > 0 || Number.isFinite(Number(source.numMidiInputs)) === false && /instrument/i.test(combined),
  }
}

/** 读 registry（缺失/损坏 → 空 registry，不抛错）。 */
export async function loadPluginRegistry(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(plugRegistryPath(dataDir), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.plugins)) return { version: PLUGIN_REGISTRY_VERSION, plugins: [] }
    return {
      version: PLUGIN_REGISTRY_VERSION,
      plugins: parsed.plugins.filter((item) => item && typeof item === 'object' && typeof item.pluginId === 'string'),
    }
  } catch {
    return { version: PLUGIN_REGISTRY_VERSION, plugins: [] }
  }
}

/** 写 registry（原子）。 */
export async function savePluginRegistry(dataDir, registry) {
  const file = plugRegistryPath(dataDir)
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  const payload = { version: PLUGIN_REGISTRY_VERSION, plugins: Array.isArray(registry?.plugins) ? registry.plugins : [] }
  try {
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw new PluginRegistryError(`保存插件 registry 失败：${error?.message ?? error}`)
  }
  return payload
}

/** 默认 VST3 扫描目录（平台常见位置 + AIMS_VST3_DIRS）。 */
export function defaultVst3Dirs(env = process.env) {
  const dirs = []
  const fromEnv = typeof env.AIMS_VST3_DIRS === 'string' ? env.AIMS_VST3_DIRS.split(path.delimiter) : []
  for (const item of fromEnv) if (item && item.trim() !== '') dirs.push(path.resolve(item.trim()))
  const testPlugin = typeof env.AIMS_VST3_TEST_PLUGIN === 'string' ? env.AIMS_VST3_TEST_PLUGIN.trim() : ''
  if (testPlugin) dirs.push(path.dirname(path.resolve(testPlugin)))
  if (process.platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env.LOCALAPPDATA ?? ''
    dirs.push(path.join(programFiles, 'Common Files', 'VST3'))
    dirs.push(path.join(programFilesX86, 'Common Files', 'VST3'))
    if (localAppData) dirs.push(path.join(localAppData, 'Programs', 'Common', 'VST3'))
  } else if (process.platform === 'darwin') {
    dirs.push('/Library/Audio/Plug-Ins/VST3', path.join(env.HOME ?? '', 'Library/Audio/Plug-Ins/VST3'))
  } else {
    dirs.push('/usr/lib/vst3', '/usr/local/lib/vst3', path.join(env.HOME ?? '', '.vst3'))
  }
  return [...new Set(dirs.filter((dir) => typeof dir === 'string' && dir !== ''))]
}

/** 递归收集 .vst3 候选（目录 bundle 或文件），返回去重绝对路径。 */
export async function findVst3Candidates(dirs = []) {
  const results = new Set()
  async function walk(dir, depth) {
    if (depth > MAX_PLUGIN_SCAN_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.vst3')) {
        results.add(path.resolve(full))
        continue
      }
      if (entry.isDirectory() && !lower.startsWith('.')) await walk(full, depth + 1)
    }
  }
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir.trim() === '') continue
    const resolved = path.resolve(dir)
    try {
      const info = await stat(resolved)
      if (info.isDirectory()) await walk(resolved, 0)
      else if (resolved.toLowerCase().endsWith('.vst3')) results.add(resolved)
    } catch {
      // 目录不存在：扫描时跳过
    }
  }
  return [...results].sort()
}

/** 校验安装路径（.vst3 文件/目录；必须是绝对/相对合法路径且存在）。 */
export async function validatePluginSource(sourcePath) {
  const resolved = path.resolve(String(sourcePath ?? ''))
  if (!/\.vst3$/i.test(resolved)) throw new PluginRegistryError(`插件路径必须以 .vst3 结尾：${resolved}`, 'PLUGIN_INVALID_PATH')
  let info
  try {
    info = await stat(resolved)
  } catch {
    throw new PluginRegistryError(`插件路径不存在：${resolved}`, 'PLUGIN_NOT_FOUND')
  }
  if (!info.isDirectory() && !info.isFile()) throw new PluginRegistryError(`插件路径不是文件/目录：${resolved}`, 'PLUGIN_INVALID_PATH')
  return { path: resolved, isDirectory: info.isDirectory(), bytes: info.size }
}

function entryFromInfo(info, sourcePath, extra = {}) {
  return {
    pluginId: info.pluginId,
    name: info.name,
    vendor: info.vendor,
    version: info.version,
    category: info.category,
    subCategories: info.subCategories,
    classId: info.classId,
    isInstrument: info.isInstrument,
    isEffect: info.isEffect,
    path: path.resolve(String(sourcePath)),
    managedPath: extra.managedPath ?? null,
    managedRoot: extra.managedRoot ?? (extra.managedPath ? path.dirname(extra.managedPath) : null),
    managed: Boolean(extra.managedPath),
    source: extra.source ?? 'scan',
    installedAt: extra.installedAt ?? Date.now(),
    missing: false,
  }
}

function userPluginView(entry) {
  return {
    pluginId: entry.pluginId,
    name: entry.name,
    vendor: entry.vendor,
    version: entry.version,
    category: entry.category,
    subCategories: entry.subCategories,
    classId: entry.classId,
    isInstrument: Boolean(entry.isInstrument),
    isEffect: Boolean(entry.isEffect),
    managed: Boolean(entry.managed),
    sourcePath: entry.path ?? null,
    managedPath: entry.managedPath ?? null,
    missing: entry.missing === true,
  }
}

function refreshMissing(entries) {
  // 托管副本可能在外部被删；同步 missing 标记（清单变化写回由调用方负责）。
  return entries.map((entry) => {
    const target = entry.managedPath ?? entry.path
    let missing = false
    try {
      // 同步 exists 在异步函数里只做轻量检查，避免额外 IO 链。
      missing = !requireExists(target)
    } catch {
      missing = true
    }
    return { ...entry, missing }
  })
}

import { existsSync } from 'node:fs'
function requireExists(target) {
  try { return existsSync(target) } catch { return false }
}

/** 列表（刷新 missing）。 */
export async function listPlugins(dataDir) {
  const registry = await loadPluginRegistry(dataDir)
  const plugins = refreshMissing(registry.plugins)
  return { plugins: plugins.map(userPluginView), entries: plugins }
}

/** 按 pluginId 获取（内部 registry entry；不存在返回 null）。 */
export async function getPluginEntry(dataDir, pluginId) {
  const registry = await loadPluginRegistry(dataDir)
  const id = String(pluginId ?? '').trim()
  return registry.plugins.find((item) => item.pluginId === id) ?? null
}

/** 扫描候选并 upsert registry（托管副本保留；需要 sidecar client.inspect）。 */
export async function scanPlugins({ dataDir, client, dirs = [], includeDefaults = true }) {
  if (!client || typeof client.inspect !== 'function') throw new PluginRegistryError('插件 sidecar 不可用，无法扫描 VST3', 'PLUGIN_HOST_UNAVAILABLE')
  const scanDirs = [...(includeDefaults ? defaultVst3Dirs() : []), ...(Array.isArray(dirs) ? dirs : [])]
  const candidates = await findVst3Candidates(scanDirs)
  const registry = await loadPluginRegistry(dataDir)
  const byId = new Map(registry.plugins.map((entry) => [entry.pluginId, entry]))
  const errors = []
  let inspected = 0
  for (const candidate of candidates) {
    try {
      const binary = await resolveVst3BinaryPath(candidate)
      const raw = await client.inspect(binary)
      const primary = selectPrimaryPluginInfo(raw)
      if (primary) {
        const info = normalizePluginInfo(primary, candidate)
        inspected += 1
        const existing = byId.get(info.pluginId)
        byId.set(info.pluginId, entryFromInfo(info, candidate, {
          managedPath: existing?.managedPath ?? null,
          source: existing?.source ?? 'scan',
          installedAt: existing?.installedAt ?? Date.now(),
        }))
      }
    } catch (error) {
      errors.push({ path: candidate, error: String(error?.message ?? error) })
    }
  }
  const saved = await savePluginRegistry(dataDir, { plugins: [...byId.values()] })
  return { scanned: candidates.length, inspected, errors, ...(await listPlugins(dataDir)) }
}

/** 导入（复制到托管目录）；同 classId 去重更新。 */
export async function installPlugin({ dataDir, client, sourcePath }) {
  if (!client || typeof client.inspect !== 'function') throw new PluginRegistryError('插件 sidecar 不可用，无法导入 VST3', 'PLUGIN_HOST_UNAVAILABLE')
  const source = await validatePluginSource(sourcePath)
  const binary = await resolveVst3BinaryPath(source.path)
  const raw = await client.inspect(binary)
  const primary = selectPrimaryPluginInfo(raw)
  if (!primary) throw new PluginRegistryError(`无法识别插件：${source.path}`, 'PLUGIN_INSPECT_FAILED')
  const info = normalizePluginInfo(primary, source.path)
  const managedDir = pluginManagedDir(dataDir)
  await mkdir(managedDir, { recursive: true })
  // v2.2 M2：托管目录用 pluginId 区分，bundle 保留原始目录/文件名（TAL 等插件依赖原始 module 名）。
  const bundleName = path.basename(source.path)
  const targetRoot = path.join(managedDir, info.pluginId)
  const target = path.join(targetRoot, bundleName)
  const registry = await loadPluginRegistry(dataDir)
  const existing = registry.plugins.find((entry) => entry.pluginId === info.pluginId || (info.classId && entry.classId === info.classId))
  if (existing?.managedPath) {
    const oldRoot = existing.managedRoot
      ? path.resolve(existing.managedRoot)
      : (path.basename(path.dirname(existing.managedPath)) === info.pluginId ? path.dirname(path.resolve(existing.managedPath)) : path.resolve(existing.managedPath))
    if (oldRoot !== path.resolve(targetRoot)) await rmWithRetry(oldRoot).catch(() => {})
  }
  // 兼容 M1 旧布局 <plugins>/<pluginId>.vst3。
  await rmWithRetry(path.join(managedDir, `${info.pluginId}.vst3`)).catch(() => {})
  // Windows 下 sidecar/杀软可能短暂锁住旧托管副本：先复制到 staging，再 rename 旧目录后切换，
  // 最后异步清理旧目录；保证重复安装幂等且不因 EPERM unlink 失败。
  const stagingRoot = `${targetRoot}.staging-${process.pid}-${Date.now()}`
  const staging = path.join(stagingRoot, bundleName)
  const backupRoot = `${targetRoot}.old-${process.pid}-${Date.now()}`
  try {
    await rmWithRetry(stagingRoot).catch(() => {})
    await mkdir(stagingRoot, { recursive: true })
    await cp(source.path, staging, { recursive: true, force: true })
  } catch (error) {
    await rmWithRetry(stagingRoot).catch(() => {})
    throw new PluginRegistryError(`复制插件到托管目录失败：${error?.message ?? error}`, 'PLUGIN_COPY_FAILED')
  }
  try {
    if (await pathExists(targetRoot)) {
      try {
        await rename(targetRoot, backupRoot)
      } catch {
        // rename 也被锁：再尝试删除旧目录（带重试）。
        await rmWithRetry(targetRoot)
      }
    }
    await rename(stagingRoot, targetRoot)
  } catch (error) {
    await rmWithRetry(stagingRoot).catch(() => {})
    throw new PluginRegistryError(`切换托管插件目录失败：${error?.message ?? error}`, 'PLUGIN_COPY_FAILED')
  }
  // 旧目录清理失败不影响本次安装（留待下次重试/手动清理）。
  await rmWithRetry(backupRoot).catch(() => {})
  const entry = entryFromInfo(info, source.path, { managedPath: target, managedRoot: targetRoot, source: 'install', installedAt: Date.now() })
  const next = registry.plugins.filter((item) => item.pluginId !== info.pluginId && (!info.classId || item.classId !== info.classId))
  next.push(entry)
  await savePluginRegistry(dataDir, { plugins: next })
  return { plugin: userPluginView(entry), entry }
}

/** 卸载（只删托管副本；工程引用由 ops 标 missing）。 */
export async function uninstallPlugin(dataDir, pluginId) {
  const registry = await loadPluginRegistry(dataDir)
  const id = String(pluginId ?? '').trim()
  const entry = registry.plugins.find((item) => item.pluginId === id)
  if (!entry) throw new PluginRegistryError(`插件不存在：${id}`, 'PLUGIN_NOT_FOUND')
  const managedDir = path.resolve(pluginManagedDir(dataDir))
  const managedPath = entry.managedPath ? path.resolve(entry.managedPath) : null
  let target = entry.managedRoot ? path.resolve(entry.managedRoot) : managedPath
  if (!target && managedPath) target = managedPath
  if (target && target !== managedDir && target.startsWith(managedDir + path.sep)) {
    await rmWithRetry(target).catch(() => {})
  } else if (managedPath && managedPath !== target && managedPath.startsWith(managedDir + path.sep)) {
    await rmWithRetry(managedPath).catch(() => {})
  }
  await savePluginRegistry(dataDir, { plugins: registry.plugins.filter((item) => item.pluginId !== id) })
  return { pluginId: id, removed: true, managedRemoved: Boolean(target) }
}
