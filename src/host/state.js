/**
 * AI 音乐工作室 — Host 项目状态。
 *
 * 职责：
 * 1. 加载 / 保存 `<dataDir>/project.json`（原子写：先写 `.tmp` 再 rename）。
 * 2. 首次启动（没有已保存项目时）用 fallbackInitial() 的返回值（由 index.js 提供
 *    createDemoProject）；若不可用则由本模块回退到 createEmptyProject()。
 * 3. 提供事务式 `mutate(meta, fn)`：在项目副本上执行变更，成功才 bump revision、
 *    更新 updatedAt / history / activity，然后持久化并通知长轮询订阅者；
 *    变更函数抛错时项目保持原样。
 * 4. **撤销 / 重做（P1）**：mutate 成功且「可撤销内容」真的变化时，把变更前的
 *    内容快照压入深度 100 的撤销栈（AI 工具调用同样入栈）；`undo()/redo()` 只恢复
 *    内容字段，保留 revision / history / activity / transport / 导出等会话级字段。
 *    撤销/重做本身不再入栈；打开/新建工程时清空两个栈。
 * 5. 提供 `subscribe(fn)` 给 routes 的长轮询使用，`flush()` 给测试与优雅退出使用。
 *
 * 本文件只依赖 node: 内置模块与 src/shared/model.js，**不 import 任何 @deepseek-ai 包**，
 * 因此可以被 `node --test` 直接单测。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LIMITS, MIGRATABLE_SCHEMA_VERSIONS, SCHEMA_VERSION, SchemaVersionError, clamp01, createEmptyProject, isSchemaVersionError, normalizeProject } from '../shared/model.js'
import { recordLoad, recordSave } from './perf.js'
import { createAiJournal } from './ai-journal.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** R1a：恢复目录/文件名（<dataDir>/recovery）。 */
export const RECOVERY_DIR_NAME = 'recovery'
export const AUTOSAVE_FILE_NAME = 'autosave.json'
export const SESSION_LOCK_FILE_NAME = 'session.lock'
/** 自动保存节流（毫秒；至少 750ms）。 */
export const AUTOSAVE_INTERVAL_MS = 750
/** 自动保存时间戳副本最多保留数。 */
export const MAX_AUTOSAVE_COPIES = 3

/** 撤销栈深度上限（契约：100）。 */
export const MAX_UNDO = 100
/** 撤销栈快照总字节预算（防止超大工程 ×100 快照吃光内存；超出丢弃最旧快照）。 */
export const MAX_UNDO_BYTES = 32 * 1024 * 1024

/**
 * 参与撤销/重做的内容字段。
 * 不包含 revision/updatedAt/history/activity/transport/exportRequest/lastExport
 * 等会话级字段——撤销编辑不应倒退 revision、清掉 AI 动态或重放旧的播放命令。
 */
export const CONTENT_KEYS = [
  'schemaVersion',
  'title',
  'artist',
  'composer',
  'bpm',
  'key',
  'scale',
  'timeSignature',
  'swing',
  'lengthBars',
  'tempoMap',
  'tracks',
  'media',
  'patterns',
  'clips',
  'sections',
  'master',
  'buses',
  // R3c：MIDI Learn 映射参与撤销/重做/内容快照。
  'midiMappings',
  // R4a：Group bus 路由参与撤销/重做/内容快照。
  'groups',
  // R4c：混音场景参与撤销/重做/内容快照。
  'scenes',
]

/** 默认数据目录：环境变量优先，否则 `<cwd>/data`（index.js 会显式传插件目录下的 data）。 */
export function resolveDataDir(dataDir) {
  if (typeof dataDir === 'string' && dataDir.trim() !== '') return path.resolve(dataDir)
  const fromEnv = process.env.DSH_STUDIO_DATA_DIR || process.env.AIMS_DATA_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.resolve(process.cwd(), 'data')
}

/**
 * 把磁盘上的 JSON 归一成完整项目对象：
 * 缺字段用 createEmptyProject() 补默认值，坏字段回退，保证工具层永远拿到可用结构。
 */
export function sanitizeProject(input) {
  const base = createEmptyProject()
  if (!isObject(input)) return base
  // R1b：v3 直接加载；v2 一次性迁移（normalizeProject 会写 format）；v1/其它仍拒绝。
  const sourceVersion = Number(input.schemaVersion)
  if (sourceVersion !== SCHEMA_VERSION && !MIGRATABLE_SCHEMA_VERSIONS.includes(sourceVersion)) {
    throw new SchemaVersionError(input.schemaVersion)
  }
  const project = { ...base, ...input }
  for (const key of ['tracks', 'patterns', 'clips', 'sections']) {
    project[key] = Array.isArray(input[key]) ? input[key] : base[key]
  }
  // P3b：音频媒体列表（缺失补 []；逐条规范化由 normalizeProject 完成）。
  project.media = Array.isArray(input.media) ? input.media : base.media
  project.title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title : base.title
  project.artist = typeof input.artist === 'string' ? input.artist : base.artist
  project.composer = typeof input.composer === 'string' ? input.composer : base.composer
  project.bpm = Number.isFinite(Number(input.bpm)) && Number(input.bpm) > 0 ? Number(input.bpm) : base.bpm
  project.key = typeof input.key === 'string' && input.key !== '' ? input.key : base.key
  project.scale = typeof input.scale === 'string' ? input.scale : base.scale
  project.timeSignature = Array.isArray(input.timeSignature) && input.timeSignature.length === 2 ? input.timeSignature : base.timeSignature
  project.swing = clamp01(input.swing)
  project.lengthBars = Number.isFinite(Number(input.lengthBars)) && Number(input.lengthBars) >= 1
    ? Math.min(LIMITS.maxBars, Math.round(Number(input.lengthBars)))
    : base.lengthBars
  project.master = isObject(input.master)
    ? {
        volume: clamp01(input.master.volume ?? base.master.volume),
        effects: Array.isArray(input.master.effects) ? input.master.effects : [],
        // P2a：master 音量自动化必须跨保存/打开/重启保留（否则会丢曲线）
        ...(isObject(input.master.automation) ? { automation: input.master.automation } : {}),
      }
    : base.master
  // P2c-2：buses 交给 model.normalizeProject 做结构规范化，这里只透传原始值。
  project.buses = input.buses === undefined || input.buses === null ? base.buses : input.buses
  project.transport = isObject(input.transport) ? { ...base.transport, ...input.transport } : base.transport
  project.activity = isObject(input.activity) && typeof input.activity.text === 'string'
    ? { text: input.activity.text, at: Number(input.activity.at) || Date.now() }
    : base.activity
  project.history = Array.isArray(input.history)
    ? input.history.filter((entry) => isObject(entry)).slice(-LIMITS.maxHistory)
    : []
  project.exportRequest = isObject(input.exportRequest) ? input.exportRequest : null
  project.lastExport = isObject(input.lastExport) ? input.lastExport : null
  project.revision = Number.isFinite(Number(input.revision)) && Number(input.revision) >= 1
    ? Math.trunc(Number(input.revision))
    : 1
  // v2.1：内容 revision（仅内容编辑/undo/redo 增加；activity/export/transport 等 meta 不增加）。
  project.contentRevision = Number.isFinite(Number(input.contentRevision)) && Number(input.contentRevision) >= 1
    ? Math.trunc(Number(input.contentRevision))
    : 1
  project.updatedAt = Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : Date.now()
  // P2a：加载/切换工程时规范化自动化曲线（排序/去重/夹紧/未知参数丢弃）。
  return normalizeProject(project)
}

/** 内容快照（JSON 字符串）：只含可撤销的内容字段。 */
export function contentSnapshot(project) {
  const content = {}
  for (const key of CONTENT_KEYS) content[key] = project?.[key]
  return JSON.stringify(content)
}

/**
 * 创建项目状态实例。
 * @param {object} options
 * @param {string} [options.dataDir] 数据目录（优先于 DSH_STUDIO_DATA_DIR 环境变量）
 * @param {() => (object|Promise<object|null>)} [options.fallbackInitial]
 *   没有已保存项目时用于初始化工程的工厂（返回 null 则用空工程）
 * @param {(message: string) => void} [options.onError] 非致命错误上报（index.js 会转到 ctx.logger）
 */
export function createState(options = {}) {
  const dataDir = resolveDataDir(options.dataDir)
  const filePath = path.join(dataDir, 'project.json')
  const tmpPath = path.join(dataDir, 'project.json.tmp')
  const exportsDir = path.join(dataDir, 'exports')
  const mediaDir = path.join(dataDir, 'media')
  const projectsDir = path.join(dataDir, 'projects')
  const activeMetaPath = path.join(dataDir, 'active-project.json')
  const report = (message) => {
    try {
      options.onError?.(message)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  // ── R1a：恢复目录 / 自动保存 / 会话锁 ────────────────────────────────
  const recoveryDir = path.join(dataDir, RECOVERY_DIR_NAME)
  const autosavePath = path.join(recoveryDir, AUTOSAVE_FILE_NAME)
  const lockPath = path.join(recoveryDir, SESSION_LOCK_FILE_NAME)
  const autosaveVersionPattern = /^autosave-(\d{8}-\d{6}-\d{3})\.json$/
  /** 启动时检测出的恢复信息（不自动覆盖项目，只暴露给工具/UI）。 */
  const recoveryInfo = {
    detected: false,
    available: false,
    autosave: null,
    projectRevision: 0,
    lock: null,
  }
  let lastOperationTool = null
  let autosaveTimer = null
  let lastAutosaveAt = 0
  let autosaveChain = Promise.resolve()

  /** 读取已有 session.lock（上次是否异常退出）。 */
  const readExistingLock = () => {
    try {
      const rawLock = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (isObject(rawLock)) return rawLock
      return { corrupt: true }
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      return { corrupt: true }
    }
  }
  /** 写入本次会话锁（失败只日志）。 */
  const writeSessionLock = () => {
    try {
      mkdirSync(recoveryDir, { recursive: true })
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: Date.now(), version: '1.0.0', dataDir }),
        'utf8',
      )
    } catch (error) {
      report(`写入会话锁失败：${error?.message ?? error}`)
    }
  }
  /** 删除本次会话锁（正常退出/dispose）。 */
  const removeSessionLock = () => {
    try {
      unlinkSync(lockPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') report(`删除会话锁失败：${error?.message ?? error}`)
    }
  }
  /** 读取 autosave.json 并校验（读文件本身在启动时同步做）。 */
  const readAutosaveMeta = () => {
    let rawText
    try {
      rawText = readFileSync(autosavePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, missing: true }
      return { ok: false, error: `读取自动保存失败：${error?.message ?? error}` }
    }
    let parsed
    try {
      parsed = JSON.parse(rawText)
    } catch {
      return { ok: false, error: '自动保存文件不是合法 JSON（可能写了一半）' }
    }
    if (!isObject(parsed) || !isObject(parsed.project)) {
      return { ok: false, error: '自动保存文件格式非法（缺少 project）' }
    }
    if (Number(parsed.schemaVersion) !== SCHEMA_VERSION && !MIGRATABLE_SCHEMA_VERSIONS.includes(Number(parsed.schemaVersion))) {
      return { ok: false, error: `自动保存 schemaVersion 必须为 ${SCHEMA_VERSION}（或可迁移的 2）` }
    }
    let projectSnapshot = null
    try {
      projectSnapshot = sanitizeProject(parsed.project)
    } catch {
      return { ok: false, error: '自动保存的工程内容非法（schema 校验失败）' }
    }
    return {
      ok: true,
      meta: {
        revision: Number.isFinite(Number(parsed.revision)) ? Number(parsed.revision) : Number(projectSnapshot.revision) || 0,
        at: Number.isFinite(Number(parsed.at)) ? Number(parsed.at) : 0,
        bytes: Number.isFinite(Number(parsed.bytes ?? parsed.projectBytes)) ? Number(parsed.bytes ?? parsed.projectBytes) : Buffer.byteLength(rawText),
        activeName: typeof parsed.activeName === 'string' ? parsed.activeName : null,
        tool: typeof parsed.tool === 'string' ? parsed.tool : null,
      },
      project: projectSnapshot,
    }
  }

  // ── R1b：v2→v3 迁移目录/元信息 ─────────────────────────────────────
  const migrationsDir = path.join(dataDir, 'migrations')
  /** state.migration：{from:2,to:3,at,backupPath} 或失败 {failed:true,error,backupPath?}；未迁移为 null。 */
  let migrationInfo = null
  /** 迁移成功后需要在 ready 时写回 v3 project.json。 */
  let needsMigrationSave = false
  /** 迁移失败时不要用 fallback demo 覆盖原 project.json（已备份原始文本）。 */
  let skipInitialSave = false
  /** 把原始 v2 文本冷备份到 <dataDir>/migrations/v2-<ts>/project.json。 */
  const backupProjectForMigration = (rawText, fromVersion, now = Date.now()) => {
    const dir = path.join(migrationsDir, `v${fromVersion}-${backupTimestamp(now)}`)
    mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'project.json')
    writeFileSync(target, rawText, 'utf8')
    return { path: target, dir }
  }

  /** P12：旧 schema 工程冷备份目录与最近一次备份路径。 */
  const legacyBackupDir = path.join(dataDir, 'legacy-v1')
  let legacyBackupPath = null
  const backupTimestamp = (now = Date.now()) => {
    const date = new Date(now)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  }
  /**
   * 把旧 schema 的 project.json 原样冷备份到 <dataDir>/legacy-v1/project-<时间戳>.json。
   * 不读取、不迁移、不恢复；备份失败只记日志（继续用新 demo 启动）。
   */
  const backupLegacyProject = (rawText, parsedVersion) => {
    try {
      mkdirSync(legacyBackupDir, { recursive: true })
      const target = path.join(legacyBackupDir, `project-${backupTimestamp()}.json`)
      writeFileSync(target, rawText, 'utf8')
      legacyBackupPath = target
      report(`旧版本工程（schemaVersion ${parsedVersion ?? '未知'}）已冷备份到 ${target}（不兼容旧文件，将重新生成当前版本演示工程）`)
      return target
    } catch (error) {
      report(`旧版本工程冷备份失败：${error?.message ?? error}`)
      return null
    }
  }

  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    report(`无法创建数据目录 ${dataDir}：${error?.message ?? error}`)
  }

  /** @type {object|null} */
  let project = null
  let loadedFromDisk = false
  let disposed = false
  /** @type {Set<(rev:number, project:object) => void>} */
  const listeners = new Set()
  let saveChain = Promise.resolve()

  /** 撤销栈：每项 { label, snapshot }（snapshot = 变更前内容快照） */
  const undoStack = []
  /** v2.3：最近一次连续编辑的 mergeKey（同 key 连续 mutate 合并为一个 undo 步骤）。 */
  let lastMergeKey = null
  /** 重做栈：每项 { label, snapshot }（snapshot = 撤销前内容快照） */
  const redoStack = []
  /** 撤销栈快照总字节数（内存预算用）。 */
  let undoBytes = 0

  /** 当前工程名（保存到 projects/<name>.json 的名字）与最近保存时间。 */
  let activeName = null
  let activeSavedAt = null
  try {
    const rawActive = JSON.parse(readFileSync(activeMetaPath, 'utf8'))
    if (isObject(rawActive)) {
      if (typeof rawActive.name === 'string' && rawActive.name.trim() !== '') activeName = rawActive.name
      if (Number.isFinite(Number(rawActive.savedAt))) activeSavedAt = Number(rawActive.savedAt)
    }
  } catch {
    /* 没有活跃工程元信息文件：正常情况（首次启动） */
  }

  // ── 0) 会话锁：先读上次的锁（检测异常退出），再写本次会话锁 ─────────────
  const previousLock = readExistingLock()
  if (previousLock !== null) {
    recoveryInfo.detected = true
    recoveryInfo.lock = previousLock
  }
  writeSessionLock()

  // ── 1) 同步加载已保存项目（文件很小；同步读保证 apply() 返回后立即可用） ──
  const loadStartedAt = Date.now()
  let raw = null
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') report(`读取项目文件失败 ${filePath}：${error?.message ?? error}`)
  }
  if (raw !== null) {
    let parsed = null
    let parseFailed = false
    try {
      parsed = JSON.parse(raw)
    } catch {
      parseFailed = true
    }
    if (parseFailed) {
      // 文件损坏：归档后按首次启动处理，避免把坏数据覆盖掉（可人工恢复）。
      try {
        renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      } catch {
        /* 归档失败也不阻塞启动 */
      }
      report(`项目文件损坏已归档（${filePath}）`)
      project = null
    } else if (!isObject(parsed) || ![SCHEMA_VERSION, ...MIGRATABLE_SCHEMA_VERSIONS].includes(Number(parsed.schemaVersion))) {
      // P12：v1/其它旧 schema 保持不兼容（冷备份到 legacy-v1，不加载不迁移）。
      backupLegacyProject(raw, isObject(parsed) ? parsed.schemaVersion : null)
      project = null
    } else {
      const sourceVersion = Number(parsed.schemaVersion)
      const isV2 = sourceVersion === 2
      let migrationBackup = null
      if (isV2) {
        // R1b：迁移前先冷备份原始 v2 文本（迁移目录不自动删除）。
        try {
          migrationBackup = backupProjectForMigration(raw, sourceVersion)
        } catch (error) {
          migrationInfo = { from: 2, to: 3, at: Date.now(), failed: true, error: `迁移前备份失败：${error?.message ?? error}` }
          skipInitialSave = true
          report(`v2→v3 迁移前备份失败（不覆盖原文件）：${error?.message ?? error}`)
        }
      }
      if (!skipInitialSave) {
        try {
          project = sanitizeProject(parsed)
          loadedFromDisk = true
          if (isV2) {
            migrationInfo = { from: 2, to: 3, at: Date.now(), backupPath: migrationBackup?.path ?? null }
            needsMigrationSave = true
            report(`已把 v2 工程迁移到 schemaVersion 3（原文件备份：${migrationBackup?.path ?? '无'}）`)
          }
        } catch (error) {
          if (isSchemaVersionError(error)) {
            backupLegacyProject(raw, error.schemaVersion)
            project = null
          } else if (isV2) {
            // 迁移失败：原始文件已备份，不覆盖、不在本次启动写回 fallback。
            migrationInfo = {
              from: 2,
              to: 3,
              at: Date.now(),
              failed: true,
              backupPath: migrationBackup?.path ?? null,
              error: `v2→v3 迁移失败：${error?.message ?? error}`,
            }
            skipInitialSave = true
            project = null
            report(`v2→v3 迁移失败（原文件备份：${migrationBackup?.path ?? '无'}，未覆盖）：${error?.message ?? error}`)
          } else {
            try {
              renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
            } catch {
              /* 归档失败也不阻塞启动 */
            }
            report(`项目文件损坏已归档（${filePath}）：${error?.message ?? error}`)
            project = null
          }
        }
      }
    }
  }

  // 启动加载计时（含无文件/损坏回退场景）。
  recordLoad(Date.now() - loadStartedAt)

  // ── 1.5) 自动保存检测（只暴露恢复信息，绝不自动覆盖当前项目） ────────────
  const startupAutosave = readAutosaveMeta()
  recoveryInfo.projectRevision = Number(project?.revision ?? 0)
  if (startupAutosave.ok) {
    const baseRevision = loadedFromDisk ? Number(project?.revision ?? 0) : 0
    const revision = Number(startupAutosave.meta.revision) || 0
    recoveryInfo.autosave = startupAutosave.meta
    recoveryInfo.available = revision >= baseRevision
    recoveryInfo.autosaveError = null
  } else if (!startupAutosave.missing && startupAutosave.error) {
    recoveryInfo.autosaveError = startupAutosave.error
  }

  // ── 2) 序列化保存（原子写：.tmp → rename） ──
  function scheduleSave() {
    if (disposed) return saveChain
    let text
    try {
      text = JSON.stringify(project)
    } catch (error) {
      report(`序列化项目失败：${error?.message ?? error}`)
      return saveChain
    }
    saveChain = saveChain.then(async () => {
      const startedAt = Date.now()
      try {
        await mkdir(dataDir, { recursive: true })
        await writeFile(tmpPath, text, 'utf8')
        await rename(tmpPath, filePath)
      } catch (error) {
        report(`保存项目失败 ${filePath}：${error?.message ?? error}`)
      } finally {
        recordSave(Date.now() - startedAt)
      }
    })
    return saveChain
  }

  /** 写活跃工程元信息（异步、串行；失败只记日志）。 */
  function scheduleActiveMetaSave() {
    if (disposed) return saveChain
    const text = JSON.stringify({ name: activeName, savedAt: activeSavedAt })
    saveChain = saveChain.then(async () => {
      try {
        await mkdir(dataDir, { recursive: true })
        await writeFile(`${activeMetaPath}.tmp`, text, 'utf8')
        await rename(`${activeMetaPath}.tmp`, activeMetaPath)
      } catch (error) {
        report(`保存活跃工程信息失败：${error?.message ?? error}`)
      }
    })
    return saveChain
  }

  /** 时间戳（autosave 副本名）：YYYYMMDD-HHmmss-SSS。 */
  const autosaveStamp = (now = Date.now()) => {
    const date = new Date(now)
    const pad = (value, length = 2) => String(value).padStart(length, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  }

  /** 修剪 recovery 下的 autosave-*.json，只保留最新 MAX_AUTOSAVE_COPIES 个。 */
  const pruneAutosaveCopies = async () => {
    let files = []
    try {
      files = await readdir(recoveryDir)
    } catch {
      return
    }
    const copies = files.filter((name) => autosaveVersionPattern.test(name)).sort().reverse()
    for (const name of copies.slice(MAX_AUTOSAVE_COPIES)) {
      try {
        await unlink(path.join(recoveryDir, name))
      } catch {
        /* 清理失败只忽略 */
      }
    }
  }

  /** 立即写一次自动保存（原子写 + 时间戳副本，最多 MAX_AUTOSAVE_COPIES 个副本）。 */
  function writeAutosaveNow() {
    if (disposed || project === null) return autosaveChain
    lastAutosaveAt = Date.now()
    const stamp = autosaveStamp()
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      revision: Number(project.revision) || 0,
      at: lastAutosaveAt,
      activeName,
      tool: lastOperationTool,
      projectBytes: 0,
      project,
    }
    let text
    try {
      text = JSON.stringify(snapshot)
      snapshot.projectBytes = Buffer.byteLength(JSON.stringify(project))
      text = JSON.stringify({ ...snapshot, projectBytes: snapshot.projectBytes })
    } catch (error) {
      report(`自动保存序列化失败：${error?.message ?? error}`)
      return autosaveChain
    }
    const versionPath = path.join(recoveryDir, `autosave-${stamp}.json`)
    autosaveChain = autosaveChain
      .then(async () => {
        try {
          await mkdir(recoveryDir, { recursive: true })
          const tmp = `${autosavePath}.tmp`
          await writeFile(tmp, text, 'utf8')
          await rename(tmp, autosavePath)
          await writeFile(versionPath, text, 'utf8')
          await pruneAutosaveCopies()
        } catch (error) {
          report(`自动保存失败：${error?.message ?? error}`)
        }
      })
    return autosaveChain
  }

  /** 节流排队自动保存（≥AUTOSAVE_INTERVAL_MS；多次变更合并成一次）。 */
  function scheduleAutosave(tool) {
    if (disposed) return
    if (typeof tool === 'string' && tool !== '') lastOperationTool = tool
    const elapsed = Date.now() - lastAutosaveAt
    if (elapsed >= AUTOSAVE_INTERVAL_MS) {
      writeAutosaveNow()
      return
    }
    if (autosaveTimer !== null) return
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null
      writeAutosaveNow()
    }, Math.max(0, AUTOSAVE_INTERVAL_MS - elapsed))
    autosaveTimer.unref?.()
  }

  /** 删除 recovery 下的 autosave 主文件与副本（正常退出/恢复消费后）。 */
  const removeAutosaveFiles = () => {
    try {
      rmSync(autosavePath, { force: true })
    } catch {
      /* ignore */
    }
    try {
      for (const name of readdirSync(recoveryDir)) {
        if (autosaveVersionPattern.test(name)) {
          try {
            rmSync(path.join(recoveryDir, name), { force: true })
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* recovery 目录不存在 */
    }
  }

  function notify() {
    const revision = project.revision
    for (const listener of [...listeners]) {
      try {
        listener(revision, project)
      } catch (error) {
        report(`长轮询回调异常：${error?.message ?? error}`)
      }
    }
  }

  // ── 3) 首次启动：异步加载演示工程（或空工程），然后落盘 ──
  // v2.1：保存时的内容 revision 基线（用于 UI dirty；meta 变化不影响）。
  let savedContentRevision = null
  const currentContentRevision = () => Math.max(1, Number(project?.contentRevision) || 1)
  const markSaved = () => {
    savedContentRevision = currentContentRevision()
    return savedContentRevision
  }
  const ensureSavedBaseline = () => {
    if (savedContentRevision === null) savedContentRevision = currentContentRevision()
  }

  const ready = (async () => {
    if (project !== null) {
      // R1b：v2→v3 迁移成功后把 v3 写回 project.json。
      if (needsMigrationSave) scheduleSave()
      ensureSavedBaseline()
      return
    }
    let initial = null
    try {
      initial = typeof options.fallbackInitial === 'function' ? await options.fallbackInitial() : null
    } catch (error) {
      report(`初始化演示工程失败，回退空白工程：${error?.message ?? error}`)
    }
    project = sanitizeProject(initial ?? createEmptyProject())
    // 迁移失败时：原文件已冷备份，本次启动不覆盖 project.json（等用户手动处理/下次保存）。
    if (!skipInitialSave) scheduleSave()
    ensureSavedBaseline()
  })()

  /** 确保项目已就绪（工具/路由在操作前 await）。 */
  async function ensureReady() {
    await ready
    if (disposed) throw new Error('音乐工作室已卸载')
    if (project === null) throw new Error('项目尚未加载完成')
    return project
  }

  /** 压入撤销栈（保持深度 ≤ MAX_UNDO，且快照总字节 ≤ MAX_UNDO_BYTES；至少保留最新 1 条）。 */
  function pushUndoEntry(entry) {
    undoStack.push(entry)
    undoBytes += entry.snapshot.length
    while (undoStack.length > MAX_UNDO || (undoBytes > MAX_UNDO_BYTES && undoStack.length > 1)) {
      const dropped = undoStack.shift()
      undoBytes -= dropped.snapshot.length
    }
  }

  /** 压入撤销栈并清空重做栈（新的变更）；meta.mergeKey 用于连续拖动合并。 */
  function pushUndo(label, snapshot, meta = {}) {
    const entry = { label, snapshot }
    if (typeof meta.mergeKey === 'string' && meta.mergeKey.trim() !== '') entry.mergeKey = meta.mergeKey.trim()
    pushUndoEntry(entry)
    redoStack.length = 0
  }

  /**
   * 把内容快照恢复进当前项目（撤销/重做共用）：只替换内容字段，保留会话级字段。
   * @returns {object} 恢复后的新项目对象
   */
  function restoreContent(snapshot) {
    const content = JSON.parse(snapshot)
    const draft = structuredClone(project)
    for (const key of CONTENT_KEYS) {
      // 快照里没有的可选字段（如 tempoMap/sidechain）要删除，撤销才能恢复「字段原本不存在」。
      if (Object.hasOwn(content, key)) draft[key] = content[key]
      else delete draft[key]
    }
    draft.revision = (Number(project.revision) || 0) + 1
    draft.contentRevision = (Number(project.contentRevision) || 1) + 1
    draft.updatedAt = Date.now()
    return draft
  }

  /**
   * 事务式变更：在项目深拷贝上执行 mutator，成功后才替换当前项目并持久化。
   * mutator 抛错 → 当前项目不受影响，错误原样抛给调用方（工具层转成 ok:false）。
   * 成功后若「可撤销内容」确实变化，会把变更前快照压入撤销栈（AI 工具同样生效）。
   * @param {{tool?:string, text?:string|null, activity?:string|null, undoLabel?:string, mergeKey?:string}} meta
   *   持久化元信息：tool 写进 history；text 为 history 文案（null 表示不写）；
   *   activity 为 UI 顶部动态文案（未传则保持不变）；
   *   undoLabel 为撤销步骤标签（省略时用 text / tool）；
   *   mergeKey 为连续编辑合并键（同 key 连续 mutate 只保留第一次 undo 快照）。
   * @param {(draft: object) => any} mutator 变更函数（只改 draft）
   * @returns {any} mutator 的返回值
   */
  function mutate(meta = {}, mutator = () => undefined) {
    if (disposed) throw new Error('音乐工作室已卸载')
    if (project === null) throw new Error('项目尚未加载完成，请稍后重试')
    const beforeContent = contentSnapshot(project)
    const draft = structuredClone(project)
    const result = mutator(draft) // 抛错则整个变更丢弃
    const at = Date.now()
    draft.revision = (Number(project.revision) || 0) + 1
    draft.updatedAt = at
    if (meta.activity !== undefined && meta.activity !== null) {
      draft.activity = { text: String(meta.activity), at }
    }
    if (meta.text) {
      const history = Array.isArray(draft.history) ? draft.history : []
      history.push({ at, tool: String(meta.tool ?? 'studio'), text: String(meta.text) })
      draft.history = history.length > LIMITS.maxHistory ? history.slice(-LIMITS.maxHistory) : history
    }
    const contentChanged = contentSnapshot(draft) !== beforeContent
    if (contentChanged) draft.contentRevision = (Number(project.contentRevision) || 1) + 1
    else draft.contentRevision = Number(project.contentRevision) || 1
    project = draft
    if (contentChanged) {
      const label = String(meta.undoLabel ?? meta.text ?? meta.tool ?? '编辑工程')
      const mergeKey = typeof meta.mergeKey === 'string' && meta.mergeKey.trim() !== '' ? meta.mergeKey.trim() : null
      const top = undoStack[undoStack.length - 1]
      const canMerge = mergeKey !== null && lastMergeKey === mergeKey && top?.mergeKey === mergeKey
      if (!canMerge) pushUndo(label, beforeContent, { mergeKey })
      lastMergeKey = mergeKey
    } else {
      lastMergeKey = null
    }
    scheduleSave()
    scheduleAutosave(typeof meta.tool === 'string' ? meta.tool : null)
    notify()
    return result
  }

  /** 只提交元信息（不改项目内容）的便捷方法，例如记录一次导出。 */
  function commit(meta = {}) {
    mutate(meta, () => undefined)
    return project.revision
  }

  /** 历史状态（GET /history 用）。 */
  function historyState() {
    return {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      undoLabel: undoStack.length > 0 ? undoStack[undoStack.length - 1].label : '',
      redoLabel: redoStack.length > 0 ? redoStack[redoStack.length - 1].label : '',
      undoDepth: undoStack.length,
      redoDepth: redoStack.length,
    }
  }

  /**
   * 撤销一步。撤销本身不入栈、不改 history；恢复内容后 bump revision 并持久化。
   * @returns {{ok:boolean,label:string,rev:number,canUndo:boolean,canRedo:boolean}}
   */
  function undo() {
    lastMergeKey = null
    if (disposed) throw new Error('音乐工作室已卸载')
    if (project === null) throw new Error('项目尚未加载完成，请稍后重试')
    if (undoStack.length === 0) return { ok: false, label: '', ...publicHistory(), rev: project.revision }
    const entry = undoStack.pop()
    undoBytes -= entry.snapshot.length
    redoStack.push({ label: entry.label, snapshot: contentSnapshot(project) })
    project = restoreContent(entry.snapshot)
    scheduleSave()
    scheduleAutosave('undo')
    notify()
    return { ok: true, label: entry.label, ...publicHistory(), rev: project.revision }
  }

  /**
   * 重做一步。
   * @returns {{ok:boolean,label:string,rev:number,canUndo:boolean,canRedo:boolean}}
   */
  function redo() {
    lastMergeKey = null
    if (disposed) throw new Error('音乐工作室已卸载')
    if (project === null) throw new Error('项目尚未加载完成，请稍后重试')
    if (redoStack.length === 0) return { ok: false, label: '', ...publicHistory(), rev: project.revision }
    const entry = redoStack.pop()
    pushUndoEntry({ label: entry.label, snapshot: contentSnapshot(project) })
    project = restoreContent(entry.snapshot)
    scheduleSave()
    scheduleAutosave('redo')
    notify()
    return { ok: true, label: entry.label, ...publicHistory(), rev: project.revision }
  }

  /** 只暴露 canUndo/canRedo/labels 的公开历史状态。 */
  function publicHistory() {
    const state = historyState()
    return {
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      undoLabel: state.undoLabel,
      redoLabel: state.redoLabel,
    }
  }

  /** 清空撤销/重做栈（打开/新建工程时使用）。 */
  function clearHistory() {
    lastMergeKey = null
    undoStack.length = 0
    redoStack.length = 0
    undoBytes = 0
  }

  /**
   * 切换/替换整个工程（打开工程、新建工程）。
   * 替换内容 + bump revision + 持久化；默认清空撤销/重做栈（不同工程之间不共享历史）。
   * @param {object} nextProject 新工程（会被 sanitizeProject 归一）
   * @param {{resetHistory?:boolean, activity?:string}} [opts]
   * @returns {number} 新 revision
   */
  // R6c：AI 变更日志（由 standalone server 记录；新建/打开工程时清空）。
  const aiJournal = createAiJournal({ limit: 30 })

  function loadProject(nextProject, opts = {}) {
    if (disposed) throw new Error('音乐工作室已卸载')
    if (project === null) throw new Error('项目尚未加载完成，请稍后重试')
    const draft = sanitizeProject(nextProject)
    draft.revision = (Number(project.revision) || 0) + 1
    draft.updatedAt = Date.now()
    // 会话级字段：保留 AI 动态流/上次导出，清空播放命令与导出请求，避免切换工程后重放旧命令。
    draft.history = Array.isArray(project.history) ? project.history.slice(-LIMITS.maxHistory) : []
    draft.activity = { text: String(opts.activity ?? '工程已就绪'), at: Date.now() }
    draft.exportRequest = null
    draft.lastExport = project.lastExport ?? null
    draft.transport = { ...draft.transport, playing: false, playheadBar: 0, cmd: null }
    project = draft
    // 不同工程之间不共享撤销历史（契约：打开/新建后撤销栈清空）。
    clearHistory()
    // R6c：新工程/打开工程清空 AI 变更日志（旧工程条目不再有意义）。
    aiJournal.clear()
    // v2.1：打开/新建工程后 dirty 基线同步为当前内容 revision。
    if (savedContentRevision !== null) savedContentRevision = currentContentRevision()
    scheduleSave()
    scheduleAutosave(typeof opts.tool === 'string' ? opts.tool : 'load-project')
    notify()
    return project.revision
  }

  /** 设置当前活跃工程名/保存时间（保存、打开时调用）。 */
  function setActiveProject(name, savedAt = null) {
    activeName = typeof name === 'string' && name.trim() !== '' ? name : null
    activeSavedAt = Number.isFinite(Number(savedAt)) ? Number(savedAt) : null
    scheduleActiveMetaSave()
  }

  return {
    // 路径
    get dataDir() {
      return dataDir
    },
    get exportsDir() {
      return exportsDir
    },
    /** P3b：音频媒体文件目录 <dataDir>/media。 */
    get mediaDir() {
      return mediaDir
    },
    get projectsDir() {
      return projectsDir
    },
    get filePath() {
      return filePath
    },
    /** 是否有已保存的项目文件被成功加载（false = 本次是首次启动）。 */
    get loadedFromDisk() {
      return loadedFromDisk
    },
    /** P12：本次启动是否冷备份了旧 schema 工程（路径；无则 null）。 */
    get legacyBackupPath() {
      return legacyBackupPath
    },
    /** 初始化 Promise（首次启动时会加载演示工程并落盘）。 */
    get ready() {
      return ready
    },
    /** R1b：v2→v3 迁移信息（未迁移为 null）：{from:2,to:3,at,backupPath} 或失败 {failed:true,error,backupPath?}。 */
    get migration() {
      return migrationInfo ? { ...migrationInfo } : null
    },
    /** R1a：恢复信息（只读；{detected,available,autosave,projectRevision,lock?,autosaveError?}）。 */
    get recovery() {
      return {
        detected: Boolean(recoveryInfo.detected),
        available: Boolean(recoveryInfo.available),
        autosave: recoveryInfo.autosave ? { ...recoveryInfo.autosave } : null,
        projectRevision: Number(project?.revision ?? recoveryInfo.projectRevision ?? 0),
        ...(recoveryInfo.lock ? { lock: { ...recoveryInfo.lock } } : {}),
        ...(recoveryInfo.autosaveError ? { autosaveError: recoveryInfo.autosaveError } : {}),
      }
    },
    /** R1a：恢复目录路径（<dataDir>/recovery）。 */
    get recoveryDir() {
      return recoveryDir
    },
    /**
     * R1a：恢复被消费后清理自动保存文件并更新内存状态（供 studio_restore_recovery 调用）。
     * 不删 session.lock（当前会话仍在运行）。
     */
    consumeRecovery() {
      if (autosaveTimer !== null) {
        clearTimeout(autosaveTimer)
        autosaveTimer = null
      }
      removeAutosaveFiles()
      recoveryInfo.available = false
      recoveryInfo.detected = false
      recoveryInfo.autosave = null
      recoveryInfo.lock = null
      return { consumed: true }
    },
    /** 当前项目（活引用；只读使用，修改请走 mutate）。 */
    get project() {
      return project
    },
    get revision() {
      return project?.revision ?? 0
    },
    /** v2.1：内容 revision（meta 操作不增加；UI dirty 用它）。 */
    get contentRevision() {
      return project?.contentRevision ?? 0
    },
    /** v2.1：最近一次保存/open 时的内容 revision 基线。 */
    get savedContentRevision() {
      return savedContentRevision ?? project?.contentRevision ?? 0
    },
    /** v2.1：保存成功后同步 dirty 基线。 */
    markSaved,
    /** 当前活跃工程名（未保存过的工程为 null）。 */
    get activeName() {
      return activeName
    },
    get activeSavedAt() {
      return activeSavedAt
    },
    // 撤销/重做
    get canUndo() {
      return undoStack.length > 0
    },
    get canRedo() {
      return redoStack.length > 0
    },
    get undoDepth() {
      return undoStack.length
    },
    get redoDepth() {
      return redoStack.length
    },
    historyState,
    undo,
    redo,
    clearHistory,
    loadProject,
    setActiveProject,
    /** 当前项目的深拷贝（需要安全快照时使用）。 */
    getSnapshot() {
      return project === null ? null : structuredClone(project)
    },
    ensureReady,
    mutate,
    commit,
    /**
     * 等待所有挂起的持久化写完（测试 / 优雅退出用）。
     * R1a：若有排队中的自动保存定时器，先立即写入再等待两条链。
     */
    async flush() {
      if (autosaveTimer !== null && !disposed) {
        clearTimeout(autosaveTimer)
        autosaveTimer = null
        writeAutosaveNow()
      }
      await Promise.all([saveChain, autosaveChain])
      return saveChain
    },
    /**
     * 订阅 revision 变化（长轮询用）。
     * @param {(revision:number, project:object) => void} listener
     * @returns {() => void} 取消订阅
     */
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe(listener) 需要函数')
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** 当前等待中的订阅者数量（测试用，确认长轮询没有泄漏）。 */
    get subscriberCount() {
      return listeners.size
    },
    /** R6c：AI 变更日志（{record,list,clear,size,limit}；只读接口供工具/路由读取）。 */
    get aiJournal() {
      return aiJournal
    },
    /** 卸载：清空订阅者、忽略后续保存。 */
    dispose() {
      // R1a：正常退出（server close/desktop quit）→ 删除 session.lock 与自动保存文件。
      // 异常崩溃不会走到这里，下次启动即可通过 lock+autosave 检测恢复。
      if (autosaveTimer !== null) {
        clearTimeout(autosaveTimer)
        autosaveTimer = null
      }
      removeSessionLock()
      removeAutosaveFiles()
      recoveryInfo.detected = false
      recoveryInfo.available = false
      recoveryInfo.autosave = null
      disposed = true
      listeners.clear()
      undoStack.length = 0
      redoStack.length = 0
      undoBytes = 0
    },
  }
}
