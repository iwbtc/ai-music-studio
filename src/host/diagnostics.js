/**
 * R7b：崩溃报告 + 诊断信息（本地优先，不上传）。
 *
 * - recordCrash(dataDir,error,meta)：写 data/crash-reports/crash-<ts>.json（最多 20 条，定期清理）；
 * - listCrashReports(dataDir)：最近崩溃摘要（新在前）；
 * - collectDiagnostics()：版本/构建/设置/最近崩溃/工程规模/内存/数据目录（脱敏可选）；
 * - exportDiagnosticsText()：可复制/下载的纯文本。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveBuildInfo } from './app-info.js'
import { loadSettings } from './settings.js'

export const CRASH_REPORTS_DIR_NAME = 'crash-reports'
export const MAX_CRASH_REPORTS = 20

/** 崩溃报告目录。 */
export function crashReportsDir(dataDir) {
  return path.join(String(dataDir ?? ''), CRASH_REPORTS_DIR_NAME)
}

function safeIso(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function crashSummary(report) {
  return {
    at: typeof report?.at === 'string' ? report.at : null,
    message: typeof report?.message === 'string' ? report.message : '',
    version: typeof report?.version === 'string' ? report.version : null,
    source: typeof report?.source === 'string' ? report.source : null,
  }
}

/** 清理超出上限的旧崩溃报告（按文件名时间倒序保留最新 20 条）。 */
export async function pruneCrashReports(dataDir, limit = MAX_CRASH_REPORTS) {
  const dir = crashReportsDir(dataDir)
  let names
  try {
    names = await readdir(dir)
  } catch {
    return { removed: 0, kept: 0 }
  }
  const reports = names.filter((name) => /^crash-.*\.json$/.test(name)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const max = Number.isInteger(limit) && limit > 0 ? limit : MAX_CRASH_REPORTS
  const stale = reports.slice(max)
  for (const name of stale) await rm(path.join(dir, name), { force: true }).catch(() => {})
  return { removed: stale.length, kept: Math.min(reports.length, max) }
}

/**
 * 记录崩溃（server 钩子/测试调用）；返回报告摘要。
 * @param {string} dataDir
 * @param {unknown} error
 * @param {{version?:string, build?:object, source?:string, at?:string|Date}} [meta]
 */
export async function recordCrash(dataDir, error, meta = {}) {
  const dir = crashReportsDir(dataDir)
  await mkdir(dir, { recursive: true })
  const at = safeIso(meta.at ?? new Date())
  const errorObject = error && typeof error === 'object' ? error : null
  const report = {
    at,
    version: typeof meta.version === 'string' ? meta.version : resolveBuildInfo().version,
    message: typeof errorObject?.message === 'string' ? errorObject.message : String(error ?? '未知错误'),
    stack: typeof errorObject?.stack === 'string' ? errorObject.stack : '',
    source: typeof meta.source === 'string' ? meta.source : 'server',
    ...(meta.build && typeof meta.build === 'object' ? { build: meta.build } : {}),
    platform: process.platform,
    pid: process.pid,
  }
  const stamp = at.replace(/[:.]/g, '-')
  const file = path.join(dir, `crash-${stamp}-${Math.random().toString(16).slice(2, 8)}.json`)
  const temp = `${file}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (writeError) {
    await rm(temp, { force: true }).catch(() => {})
    throw new Error(`写入崩溃报告失败：${writeError?.message ?? writeError}`)
  }
  await pruneCrashReports(dataDir)
  return { file, ...crashSummary(report) }
}

/** 最近崩溃摘要（新在前；损坏文件跳过）。 */
export async function listCrashReports(dataDir, options = {}) {
  const limit = Number.isInteger(Number(options.limit)) && Number(options.limit) > 0 ? Number(options.limit) : 5
  const dir = crashReportsDir(dataDir)
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const reports = names.filter((name) => /^crash-.*\.json$/.test(name)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const summaries = []
  for (const name of reports) {
    if (summaries.length >= limit) break
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        summaries.push({ file: name, ...crashSummary(parsed) })
      }
    } catch {
      // 损坏的崩溃文件跳过
    }
  }
  return summaries
}

/** 脱敏路径（用户目录 → <home>）。 */
export function maskPath(value) {
  if (typeof value !== 'string' || value === '') return value
  const home = os.homedir()
  if (home && value.startsWith(home)) return value.replace(home, '<home>')
  return value
}

/** 工程规模摘要。 */
function projectScale(state) {
  const project = state?.project ?? null
  let notes = 0
  if (Array.isArray(project?.patterns)) {
    for (const pattern of project.patterns) notes += Array.isArray(pattern?.notes) ? pattern.notes.length : 0
  }
  return {
    tracks: Array.isArray(project?.tracks) ? project.tracks.length : 0,
    patterns: Array.isArray(project?.patterns) ? project.patterns.length : 0,
    clips: Array.isArray(project?.clips) ? project.clips.length : 0,
    notes,
    revision: Number(project?.revision) || 0,
    title: typeof project?.title === 'string' ? project.title : null,
  }
}

/**
 * 收集诊断信息（只读）。
 * @param {{dataDir?:string, state?:object, maskDataDir?:boolean, crashLimit?:number}} [options]
 */
export async function collectDiagnostics(options = {}) {
  const dataDir = String(options.dataDir ?? options.state?.dataDir ?? '')
  const build = resolveBuildInfo()
  const settings = await loadSettings(dataDir)
  const crashes = await listCrashReports(dataDir, { limit: Number.isInteger(options.crashLimit) ? options.crashLimit : 5 })
  const memory = typeof process.memoryUsage === 'function' ? process.memoryUsage() : {}
  return {
    generatedAt: new Date().toISOString(),
    version: build.version,
    build,
    channel: settings.channel,
    settings,
    crashes,
    crashReportsCount: crashes.length,
    project: projectScale(options.state),
    memory: {
      rssMB: memory.rss ? Math.round((memory.rss / 1024 / 1024) * 10) / 10 : null,
      heapUsedMB: memory.heapUsed ? Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10 : null,
    },
    runtime: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      node: process.versions?.node ?? null,
      electron: process.versions?.electron ?? null,
      uptimeSeconds: Math.round(process.uptime()),
    },
    dataDir: options.maskDataDir === false ? dataDir : maskPath(dataDir),
    crashReportsDir: options.maskDataDir === false ? crashReportsDir(dataDir) : maskPath(crashReportsDir(dataDir)),
  }
}

/** 生成可复制/下载的诊断文本。 */
export function exportDiagnosticsText(diagnostics) {
  const diag = diagnostics && typeof diagnostics === 'object' ? diagnostics : {}
  const build = diag.build ?? {}
  const lines = [
    'AI 音乐工作室 · 诊断报告',
    `生成时间：${diag.generatedAt ?? new Date().toISOString()}`,
    `版本：${diag.version ?? build.version ?? 'unknown'}（${diag.channel ?? 'unknown'}）`,
    `构建：${build.commit ?? 'unknown'} · ${build.date ?? 'unknown'} · Electron ${build.electron ?? 'unknown'}`,
    `平台：${diag.runtime?.platform ?? 'unknown'} ${diag.runtime?.arch ?? ''} · Node ${diag.runtime?.node ?? 'unknown'} · pid ${diag.runtime?.pid ?? '?'}`,
    `内存：RSS ${diag.memory?.rssMB ?? '?'}MB / heap ${diag.memory?.heapUsedMB ?? '?'}MB`,
    `数据目录：${diag.dataDir ?? 'unknown'}`,
    `工程：${diag.project?.title ?? '(未命名)'} · ${diag.project?.tracks ?? 0} 轨 / ${diag.project?.patterns ?? 0} pattern / ${diag.project?.clips ?? 0} clip / ${diag.project?.notes ?? 0} 音符`,
    `设置：channel=${diag.settings?.channel ?? 'stable'} · telemetryOptIn=${diag.settings?.telemetryOptIn ?? false} · crashReports=${diag.settings?.crashReports ?? true} · language=${diag.settings?.language ?? 'zh-CN'}`,
    `最近崩溃（最多 5 条，共 ${diag.crashReportsCount ?? (diag.crashes?.length ?? 0)} 条）：`,
  ]
  const crashes = Array.isArray(diag.crashes) ? diag.crashes : []
  if (crashes.length === 0) lines.push('  （无）')
  else for (const crash of crashes) lines.push(`  - ${crash.at ?? '?'} [${crash.source ?? '?'}] ${crash.message ?? ''}`)
  lines.push('', '本报告仅在本机生成，不会自动上传。')
  return `${lines.join('\n')}\n`
}

/** 供路由/工具使用：收集 + 导出一步到位。 */
export async function diagnosticsReport(options = {}) {
  const diagnostics = await collectDiagnostics(options)
  return { diagnostics, text: exportDiagnosticsText(diagnostics) }
}

/** 崩溃目录存在性/大小摘要（测试/诊断用）。 */
export async function crashReportsStats(dataDir) {
  const dir = crashReportsDir(dataDir)
  let names
  try {
    names = await readdir(dir)
  } catch {
    return { count: 0, bytes: 0 }
  }
  const files = names.filter((name) => /^crash-.*\.json$/.test(name))
  let bytes = 0
  for (const name of files) {
    try {
      bytes += (await stat(path.join(dir, name))).size
    } catch {
      // 忽略
    }
  }
  return { count: files.length, bytes }
}
