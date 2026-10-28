/**
 * AI 音乐工作室 — 工程文件管理（P1）。
 *
 * 工程保存在 `<dataDir>/projects/<safe-name>.json`；当前工程仍由 state 持久化到
 * `<dataDir>/project.json`。本模块只负责工程文件的 安全命名 / 列表 / 保存 / 读取 / 删除，
 * 是普通 node: 模块，不依赖 DSH 与 client，可直接单测。
 *
 * 文件名安全规则（CONTRACT-EDIT.md §2.3）：
 * 只保留中英文/数字/空格/-/_，长度 ≤60，去掉首尾的点/空格/连字符，
 * 并规避 Windows 保留设备名（CON/PRN/AUX/NUL/COM1..9/LPT1..9）。
 */
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MIGRATABLE_SCHEMA_VERSIONS, SCHEMA_VERSION, isSchemaVersionError } from '../shared/model.js'
import { sanitizeProject } from './state.js'

/** 工程文件扩展名。 */
export const PROJECT_EXT = '.json'
/** 工程名最大长度（字符）。 */
export const MAX_PROJECT_NAME = 60
/** P10：自动备份工程名前缀（不出现在用户工程列表里）。 */
export const AUTOBACKUP_PREFIX = '_autobackup-'
/** P14a：工程版本历史目录（位于 projects/_history/<工程名>/）。 */
export const VERSION_DIR_NAME = '_history'
/** 每个工程最多保留的版本数。 */
export const MAX_PROJECT_VERSIONS = 20
/** 版本 id 格式：YYYYMMDD-HHmmss-SSS（同毫秒冲突时追加 -N）。 */
const VERSION_ID_RE = /^\d{8}-\d{6}-\d{3}(?:-\d+)?$/

/** Windows 保留设备名（大小写不敏感，扩展名无关）。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 工程文件相关错误（message 直接回给 UI）。 */
export class ProjectError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProjectError'
    this.code = 'PROJECT_FILE'
  }
}

/** P12：旧 schema 工程不支持的中文错误。 */
export function legacyProjectMessage(version) {
  const seen = version === undefined || version === null ? '未知' : String(version)
  return `旧版本工程不支持（schemaVersion ${seen}），本项目已不再兼容旧文件`
}

/** 工程目录。 */
export function projectsDir(dataDir) {
  return path.join(dataDir, 'projects')
}

/** R1b：迁移备份根目录。 */
export function migrationsDir(dataDir) {
  return path.join(dataDir, 'migrations')
}

/** 时间戳（迁移备份目录名用）。 */
function migrationTimestamp(now = Date.now()) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * R1b：把原始 v2 工程文本冷备份到 <dataDir>/migrations/v2-<ts>[-<name>]/project.json。
 * @returns {Promise<{path:string,dir:string}>}
 */
export async function backupProjectForMigration(dataDir, rawText, options = {}) {
  const fromVersion = Number(options.fromVersion) || 2
  const safeName = typeof options.name === 'string' && options.name.trim() !== '' ? sanitizeProjectName(options.name) : ''
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const dir = path.join(migrationsDir(dataDir), `v${fromVersion}-${migrationTimestamp(now)}${safeName ? `-${safeName}` : ''}`)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, 'project.json')
  await writeFile(target, rawText, 'utf8')
  return { path: target, dir }
}

/** 把任意名称清理成安全的工程名（不含 .json 后缀）。 */
export function sanitizeProjectName(rawName, fallback = '未命名工程') {
  const source = typeof rawName === 'string' ? rawName : ''
  let safe = source
    .trim()
    // 去除路径分隔符 / 非法字符 / 控制字符
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    // 只保留中英文、数字、空格、- 和 _
    .replace(/[^\w\u4e00-\u9fa5 -]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, MAX_PROJECT_NAME)
    .trim()
  if (safe === '') {
    safe = sanitizeProjectName(fallback, '未命名工程')
    // 避免 fallback 也非法时报错递归；最终兜底固定名。
    if (safe === '') safe = `未命名工程-${Date.now()}`
  }
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`
  return safe
}

/** 工程文件绝对路径（保证在 projectsDir 内）。 */
export function projectFilePath(dataDir, name) {
  const safeName = sanitizeProjectName(name)
  const dir = projectsDir(dataDir)
  const filePath = path.join(dir, `${safeName}${PROJECT_EXT}`)
  const normalizedDir = path.resolve(dir)
  if (!path.resolve(filePath).startsWith(normalizedDir + path.sep)) {
    throw new ProjectError(`非法工程名：${String(name)}`)
  }
  return filePath
}

/** 工程文件是否存在。 */
export async function projectFileExists(dataDir, name) {
  try {
    const info = await stat(projectFilePath(dataDir, name))
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * 列出全部工程（按 updatedAt 倒序）。
 * @param {string} dataDir
 * @returns {Promise<{projects:object[], skipped:Array<{name:string,error:string}>}>}
 */
export async function listProjects(dataDir) {
  const dir = projectsDir(dataDir)
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { projects: [], skipped: [] }
    throw new ProjectError(`读取工程目录失败：${error?.message ?? error}`)
  }
  const projects = []
  const skipped = []
  const unsupported = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(PROJECT_EXT)) continue
    const name = entry.name.slice(0, -PROJECT_EXT.length)
    // P10：自动备份文件不算用户工程。
    if (name.startsWith(AUTOBACKUP_PREFIX)) continue
    const filePath = path.join(dir, entry.name)
    try {
      const [raw, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new ProjectError(`工程文件损坏（不是合法 JSON）：${name}`)
      }
      // R1b：v3 直接列出；v2 可列出并标记 needsMigration（打开时迁移）；v1/其它仍 unsupported。
      const version = parsed && typeof parsed === 'object' ? Number(parsed.schemaVersion) : Number.NaN
      const needsMigration = MIGRATABLE_SCHEMA_VERSIONS.includes(version)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (version !== SCHEMA_VERSION && !needsMigration)) {
        unsupported.push({
          name,
          schemaVersion: parsed && typeof parsed === 'object' ? parsed.schemaVersion ?? null : null,
          reason: legacyProjectMessage(parsed && typeof parsed === 'object' ? parsed.schemaVersion : null),
        })
        continue
      }
      const project = sanitizeProject(parsed)
      const updatedAt = Number.isFinite(Number(project.updatedAt)) ? Number(project.updatedAt) : info.mtimeMs
      projects.push({
        name,
        schemaVersion: project.schemaVersion,
        title: project.title,
        bpm: project.bpm,
        lengthBars: project.lengthBars,
        trackCount: project.tracks.length,
        patternCount: project.patterns.length,
        updatedAt,
        savedAt: info.mtimeMs,
        size: info.size,
        ...(needsMigration ? { needsMigration: true, migrationFrom: version } : {}),
      })
    } catch (error) {
      if (isSchemaVersionError(error)) {
        unsupported.push({ name, schemaVersion: error.schemaVersion ?? null, reason: legacyProjectMessage(error.schemaVersion) })
      } else {
        skipped.push({ name, error: String(error?.message ?? error) })
      }
    }
  }
  unsupported.sort((a, b) => a.name.localeCompare(b.name))
  projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.name.localeCompare(b.name))
  return { projects, skipped, unsupported }
}

/**
 * 保存工程到 projects/<safe-name>.json（原子写）。
 * @returns {Promise<{name:string,path:string,bytes:number,savedAt:number}>}
 */
export async function saveProjectFile(dataDir, name, project) {
  // R1b：内存工程应是 v3；若仍是 v2（旧调用方）先迁移，只写 v3。v1/其它拒绝。
  if (Number(project?.schemaVersion) !== SCHEMA_VERSION) {
    if (MIGRATABLE_SCHEMA_VERSIONS.includes(Number(project?.schemaVersion))) {
      project = sanitizeProject(project)
    } else {
      throw new ProjectError(`工程 schemaVersion 必须为 ${SCHEMA_VERSION}（当前 ${project?.schemaVersion ?? '未知'}）`)
    }
  }
  const safeName = sanitizeProjectName(name)
  const filePath = projectFilePath(dataDir, safeName)
  const dir = projectsDir(dataDir)
  await mkdir(dir, { recursive: true })
  const body = JSON.stringify(project)
  const tmpPath = `${filePath}.tmp`
  await writeFile(tmpPath, body, 'utf8')
  await rename(tmpPath, filePath)
  const info = await stat(filePath)
  // P14a：保存成功后写版本历史（失败不阻塞保存；自动备份不写）。
  if (!isAutobackupName(safeName)) {
    try {
      await writeProjectVersion(dataDir, safeName, project)
    } catch {
      /* 版本历史失败不影响保存 */
    }
  }
  return { name: safeName, path: filePath, bytes: info.size, savedAt: Date.now() }
}

/**
 * 读取工程文件（校验 JSON 与基本模型结构）。
 * @returns {Promise<{name:string,project:object,savedAt:number,bytes:number,path:string}>}
 */
export async function loadProjectFile(dataDir, name) {
  const safeName = sanitizeProjectName(name)
  const filePath = projectFilePath(dataDir, safeName)
  let raw
  let info
  try {
    ;[raw, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ProjectError(`工程不存在：${safeName}`)
    throw new ProjectError(`读取工程失败：${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ProjectError(`工程文件损坏（不是合法 JSON）：${safeName}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectError(`工程文件结构错误：${safeName}`)
  }
  // P12 clean break：旧 schema 直接中文拒绝，不读取、不迁移。
  const sourceVersion = Number(parsed?.schemaVersion)
  const needsMigration = MIGRATABLE_SCHEMA_VERSIONS.includes(sourceVersion)
  if (sourceVersion !== SCHEMA_VERSION && !needsMigration) {
    throw new ProjectError(legacyProjectMessage(parsed?.schemaVersion))
  }
  let backupPath = null
  if (needsMigration) {
    // R1b：v2 命名工程迁移前先冷备份原始文本（不静默丢内容）。
    const backup = await backupProjectForMigration(dataDir, raw, { fromVersion: sourceVersion, name: safeName })
    backupPath = backup.path
  }
  const project = sanitizeProject(parsed)
  return {
    name: safeName,
    project,
    savedAt: info.mtimeMs,
    bytes: info.size,
    path: filePath,
    ...(needsMigration ? { migratedFrom: sourceVersion, backupPath } : {}),
  }
}

/** 删除工程文件。 */
export async function deleteProjectFile(dataDir, name) {
  const safeName = sanitizeProjectName(name)
  const filePath = projectFilePath(dataDir, safeName)
  try {
    await unlink(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ProjectError(`工程不存在：${safeName}`)
    throw new ProjectError(`删除工程失败：${error?.message ?? error}`)
  }
  return { name: safeName, deleted: true }
}

/** 是否为自动备份工程名。 */
export function isAutobackupName(name) {
  return typeof name === 'string' && name.startsWith(AUTOBACKUP_PREFIX)
}

/** 把毫秒时间戳格式化为 YYYYMMDD-HHmmss（本地时区，用于自动备份名）。 */
export function formatBackupTimestamp(now = Date.now()) {
  const date = new Date(now)
  const pad = (value, length = 2) => String(value).padStart(length, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * P10：把当前工程写入 projects/_autobackup-<YYYYMMDD-HHmmss>.json。
 * @returns {Promise<{name:string,path:string,bytes:number,savedAt:number}>}
 */
export async function writeAutobackup(dataDir, project, now = Date.now()) {
  const name = `${AUTOBACKUP_PREFIX}${formatBackupTimestamp(now)}`
  return saveProjectFile(dataDir, name, project)
}

/* ------------------------------------------------------------------------- */
/* P14a：工程版本历史（projects/_history/<sanitized-name>/<timestamp>.json）  */
/* ------------------------------------------------------------------------- */

/** 某个工程的版本目录（保证在 projects/_history 内）。 */
export function projectVersionsDir(dataDir, name) {
  const root = path.resolve(path.join(projectsDir(dataDir), VERSION_DIR_NAME))
  const safeName = sanitizeProjectName(name)
  const dir = path.resolve(path.join(root, safeName))
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new ProjectError(`非法版本目录：${String(name)}`)
  return dir
}

function formatVersionTimestamp(now = Date.now()) {
  const date = new Date(now)
  const pad = (value, length = 2) => String(value).padStart(length, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
}

/**
 * 写入一个工程版本（最多保留 MAX_PROJECT_VERSIONS 个，最新的在前）。
 * @returns {Promise<{id:string,path:string,bytes:number,at:number,timestamp:string}>}
 */
export async function writeProjectVersion(dataDir, name, project, options = {}) {
  const safeName = sanitizeProjectName(name)
  if (isAutobackupName(safeName)) throw new ProjectError('自动备份工程不写版本历史')
  const dir = projectVersionsDir(dataDir, safeName)
  await mkdir(dir, { recursive: true })
  const base = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const body = JSON.stringify(project)
  let id = null
  let target = null
  for (let offset = 0; offset < 100; offset += 1) {
    const candidate = formatVersionTimestamp(base + offset)
    const filePath = path.join(dir, `${candidate}.json`)
    try {
      await stat(filePath)
      continue
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new ProjectError(`读取版本文件失败：${error?.message ?? error}`)
    }
    id = candidate
    target = filePath
    break
  }
  if (!id) throw new ProjectError('无法分配版本 id（同一毫秒版本过多）')
  const tmpPath = `${target}.tmp`
  await writeFile(tmpPath, body, 'utf8')
  await rename(tmpPath, target)
  const info = await stat(target)
  // 修剪旧版本：按文件名倒序保留最新 20 个
  try {
    const entries = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort().reverse()
    for (const stale of entries.slice(MAX_PROJECT_VERSIONS)) {
      await unlink(path.join(dir, stale))
    }
  } catch {
    /* 修剪失败不影响保存 */
  }
  return { id, path: target, bytes: info.size, at: info.mtimeMs, timestamp: id }
}

/**
 * 列出工程版本（最新在前）：[{id,timestamp,title,bytes,at}]。
 */
export async function listProjectVersions(dataDir, name) {
  const safeName = sanitizeProjectName(name)
  const dir = projectVersionsDir(dataDir, safeName)
  let entries = []
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new ProjectError(`读取版本目录失败：${error?.message ?? error}`)
  }
  const versions = []
  for (const entry of entries.filter((file) => file.endsWith('.json')).sort().reverse()) {
    const id = entry.slice(0, -'.json'.length)
    if (!VERSION_ID_RE.test(id)) continue
    const filePath = path.join(dir, entry)
    try {
      const [raw, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
      const project = JSON.parse(raw)
      versions.push({
        id,
        timestamp: id,
        title: typeof project?.title === 'string' ? project.title : '',
        bytes: info.size,
        at: info.mtimeMs,
      })
    } catch {
      /* 损坏版本跳过 */
    }
  }
  return versions
}

/**
 * 读取一个工程版本（含 schema 校验）。
 * @returns {Promise<{id:string,name:string,project:object,savedAt:number,bytes:number,path:string}>}
 */
export async function readProjectVersion(dataDir, name, id) {
  const safeName = sanitizeProjectName(name)
  const versionId = typeof id === 'string' ? id.trim() : ''
  if (!VERSION_ID_RE.test(versionId)) throw new ProjectError(`版本 id 非法：${String(id)}`)
  const dir = projectVersionsDir(dataDir, safeName)
  const filePath = path.resolve(path.join(dir, `${versionId}.json`))
  if (!filePath.startsWith(dir + path.sep)) throw new ProjectError(`版本路径非法：${String(id)}`)
  let raw
  let info
  try {
    ;[raw, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ProjectError(`版本不存在：${safeName} / ${versionId}`)
    throw new ProjectError(`读取版本失败：${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ProjectError(`版本文件损坏：${safeName} / ${versionId}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectError(`版本文件结构错误：${safeName} / ${versionId}`)
  }
  const project = sanitizeProject(parsed)
  return { id: versionId, name: safeName, project, savedAt: info.mtimeMs, bytes: info.size, path: filePath }
}
