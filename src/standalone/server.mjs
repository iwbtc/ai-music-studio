/**
 * AI 音乐工作室 — 独立窗口版本地服务。
 *
 * 复用 DSH 插件已有的后端模块（src/host/state.js、routes.js、tools.js），
 * 在自己进程里起一个只监听 127.0.0.1 的 HTTP 服务：
 *   · /                    独立窗口前端页面
 *   · /assets/app.js       独立前端 bundle
 *   · /favicon.svg
 *   · /studio/api/*        与 DSH 插件完全相同的状态/操作/导出 API
 *   · POST /studio/api/tool-call   AI 桥（DSH 插件）调用工具
 *   · POST /studio/api/shutdown    停止服务（启动器/停止脚本使用）
 *
 * 同时把实际端口写进 `<dataDir>/app-endpoint.json`，供 DSH 插件发现并代理 AI 工具调用。
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createState,
  AUTOSAVE_FILE_NAME,
  RECOVERY_DIR_NAME,
  SESSION_LOCK_FILE_NAME,
} from '../host/state.js'
import { createRoutes, API_PREFIX } from '../host/routes.js'
import { createTools } from '../host/tools.js'
import { resolveBuildInfo } from '../host/app-info.js'
import { recordCrash } from '../host/diagnostics.js'
import { closeSharedPluginServices, getSharedPluginService } from '../host/plugin-service.js'
import { diffProjectSummary } from '../host/ai-journal.js'
import { defineTool } from '../host/define-tool.js'
import { createDemoProject } from '../shared/demo.js'

export const VERSION = '2.4.0'
export const DEFAULT_PORT = 41731
export const ENDPOINT_FILE = 'app-endpoint.json'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))

/** R6c：这些工具会新建/打开/导入/恢复工程，成功后清空 AI 变更日志且不记录本次。 */
const RESET_JOURNAL_TOOLS = new Set([
  'studio_create_project',
  'studio_open_project',
  'studio_import_project_json',
  'studio_import_midi',
  'studio_restore_backup',
  'studio_restore_project_version',
  'studio_restore_recovery',
])
/** 插件根目录（src/standalone → src → 根）。 */
export const ROOT = path.resolve(HERE, '..', '..')
const ASSETS_DIR = path.join(ROOT, 'standalone', 'assets')
const SAMPLES_DIR = path.join(ROOT, 'assets', 'samples')
const SOUNDFONTS_DIR = path.join(ROOT, 'assets', 'soundfonts')
const PAGE_FILE = path.join(ROOT, 'src', 'standalone', 'index.html')
const FAVICON_FILE = path.join(ROOT, 'src', 'standalone', 'favicon.svg')

/** 解析数据目录：显式参数 > AIMS_DATA_DIR > 插件根/data。 */
export function resolveDataDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit)
  if (typeof process.env.AIMS_DATA_DIR === 'string' && process.env.AIMS_DATA_DIR.trim() !== '') {
    return path.resolve(process.env.AIMS_DATA_DIR)
  }
  return path.join(ROOT, 'data')
}

/**
 * v2.1：运行模式（写进 `<dataDir>/app-endpoint.json` 的 `mode` 字段）。
 *
 * - `desktop-exe`：Electron 打包 exe / Electron 开发版（`process.versions.electron` 存在）；
 * - `window`：`node src/standalone/launch.mjs` 起的浏览器 App 窗口版。
 *
 * 修复 v2.0 及以前 endpoint 一律写 `mode:'window'` 的问题：两种运行方式虽然共用同一套
 * 服务端代码，但数据目录/生命周期不同，AI 桥与诊断工具需要能区分（旧字段保留兼容）。
 */
export function detectRuntimeMode() {
  const electron = typeof process.versions?.electron === 'string' ? process.versions.electron.trim() : ''
  return electron !== '' ? 'desktop-exe' : 'window'
}

/** 进程是否存活（EPERM = 存在但无权探测，视为存活；ESRCH = 已退出）。 */
export function isProcessAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 读取自动保存摘要（只读；缺失/损坏/无 project 返回 null）。供陈旧锁判断使用。 */
function readAutosaveSummary(recoveryDir) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path.join(recoveryDir, AUTOSAVE_FILE_NAME), 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (!parsed.project || typeof parsed.project !== 'object' || Array.isArray(parsed.project)) return null
  const revisionRaw = Number(parsed.revision ?? parsed.project.revision)
  const revision = Number.isFinite(revisionRaw) ? Math.trunc(revisionRaw) : 0
  return {
    revision,
    at: Number.isFinite(Number(parsed.at)) ? Number(parsed.at) : 0,
    tool: typeof parsed.tool === 'string' ? parsed.tool : null,
    activeName: typeof parsed.activeName === 'string' ? parsed.activeName : null,
  }
}

/** 读取当前 project.json 的 revision（缺失/损坏按 0）。 */
function readProjectRevision(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, 'project.json'), 'utf8'))
    return Number.isFinite(Number(parsed?.revision)) ? Math.trunc(Number(parsed.revision)) : 0
  } catch {
    return 0
  }
}

/**
 * v2.1：识别并清理「陈旧」恢复锁（`recovery/session.lock`）。
 *
 * 背景：`createState()` 启动时只要看到 session.lock 就标记「上次异常退出（detected=true）」；
 * 但正常关闭服务/窗口会删锁，只有进程被强制结束（任务管理器 / taskkill /F / 断电）才会残留。
 * 残留锁若对应的进程早已退出、又没有比当前工程更新的 autosave，就属于**陈旧锁**：
 * 再启动会反复误报「上次异常退出」且无可恢复内容。本函数在 `startServer()` 创建
 * state 之前做一次只读探测 + 安全清理：
 *
 * - 锁文件不存在 → 不处理；
 * - 锁坏 JSON / 缺合法 pid / pid 等于当前进程（同进程自锁异常）→ 删除（removed-corrupt）；
 * - pid 仍存活（另一个实例正在用同一数据目录）→ **保留**（kept-foreign，多客户端选举是 v2.1 后续项）；
 * - pid 已退出，但 autosave 可恢复（revision ≥ 当前工程 revision）→ **保留**（kept-crash，
 *   让 createState 正常上报 studio_get_recovery / 恢复流程）；
 * - pid 已退出且无可恢复 autosave → 删除（removed-stale），避免下次启动重复误报。
 *
 * @param {string} dataDir 数据目录
 * @returns {{checked:boolean, action:'none'|'removed-corrupt'|'removed-stale'|'kept-crash'|'kept-foreign',
 *   reason:string, lockPath:string, lock:object|null, autosave:object|null, projectRevision:number}}
 */
export function cleanupStaleRecoveryLock(dataDir) {
  const recoveryDir = path.join(dataDir, RECOVERY_DIR_NAME)
  const lockPath = path.join(recoveryDir, SESSION_LOCK_FILE_NAME)
  /** @type {{checked:boolean, action:string, reason:string, lockPath:string, lock:object|null, autosave:object|null, projectRevision:number}} */
  const result = {
    checked: false,
    action: 'none',
    reason: '',
    lockPath,
    lock: null,
    autosave: null,
    projectRevision: 0,
  }
  let rawLock
  try {
    rawLock = readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...result, reason: '没有残留会话锁' }
    return { ...result, checked: true, reason: `无法读取会话锁（保留不动）：${error?.message ?? error}` }
  }
  result.checked = true

  let lock
  try {
    lock = JSON.parse(rawLock)
  } catch {
    lock = null
  }
  const removeLock = (action, reason) => {
    try {
      unlinkSync(lockPath)
      return { ...result, action, reason }
    } catch (error) {
      return { ...result, action: 'none', reason: `${reason}（删除失败：${error?.message ?? error}）` }
    }
  }

  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    return removeLock('removed-corrupt', '会话锁内容损坏，已自动清理')
  }
  result.lock = lock
  const pid = Number(lock.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    return removeLock('removed-corrupt', '会话锁缺少合法 pid，已自动清理')
  }
  if (pid === process.pid) {
    return removeLock('removed-corrupt', '会话锁属于当前进程的残留记录，已自动清理')
  }
  if (isProcessAlive(pid)) {
    return {
      ...result,
      action: 'kept-foreign',
      reason: `另一进程（pid=${pid}）正在使用同一数据目录，保留其会话锁（建议同一时间只运行一个实例）`,
    }
  }

  // pid 已退出：只有存在可恢复的自动保存时才保留锁（真正的崩溃恢复场景）。
  const autosave = readAutosaveSummary(recoveryDir)
  const projectRevision = readProjectRevision(dataDir)
  result.autosave = autosave
  result.projectRevision = projectRevision
  if (autosave && autosave.revision >= projectRevision) {
    return {
      ...result,
      action: 'kept-crash',
      reason: `上次异常退出（pid=${pid}）且存在可恢复自动保存（revision ${autosave.revision}），保留锁等待恢复`,
    }
  }
  return removeLock('removed-stale', `已清理陈旧会话锁（pid=${pid} 已退出，无更新自动保存）`)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

async function sendFile(res, filePath, cacheControl = 'no-store') {
  try {
    const data = await readFile(filePath)
    res.statusCode = 200
    res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream')
    res.setHeader('Content-Length', data.length)
    res.setHeader('Cache-Control', cacheControl)
    res.end(data)
    return true
  } catch {
    return false
  }
}

/** 读取请求 body（limit 字节），返回 Buffer。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过上限 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 端口被占用时向后探测若干次。 */
async function listenWithFallback(server, host, startPort, tries = 10) {
  let lastError = null
  for (let i = 0; i < tries; i += 1) {
    const port = startPort + i
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
      return port
    } catch (error) {
      lastError = error
      if (error?.code !== 'EADDRINUSE') throw error
    }
  }
  throw lastError ?? new Error('找不到可用端口')
}

/** 写 endpoint 文件（窗口版写在 dataDir，exe 版可传额外目录）。 */
async function writeEndpointFile(dataDir, info, extraDirs = []) {
  const body = JSON.stringify(info, null, 2)
  const dirs = [dataDir, ...extraDirs]
  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, ENDPOINT_FILE), body, 'utf8')
    } catch {
      /* 某个目录不可写不影响主流程 */
    }
  }
}

/**
 * 启动独立版服务。
 * @param {object} [options]
 * @param {string} [options.dataDir] 数据目录（默认 resolveDataDir()）
 * @param {number} [options.port] 起始端口（默认 41731）
 * @param {string} [options.host] 监听地址（默认 127.0.0.1）
 * @param {string[]} [options.endpointDirs] 额外写 app-endpoint.json 的目录
 * @param {string} [options.mode] 覆盖 endpoint 的运行模式（默认 detectRuntimeMode()：desktop-exe / window）
 * @returns {Promise<{server:import('node:http').Server, port:number, url:string, state:object, tools:Map<string,object>,
 *   close:()=>Promise<void>, dataDir:string, endpointInfo:object, recoveryLock:object}>}
 */
/** R7b：崩溃钩子（每个进程只安装一次；记录到所有已启动的 dataDir）。 */
const crashDataDirs = new Set()
let crashHooksInstalled = false

export function installCrashHooks(dataDir) {
  if (typeof dataDir === 'string' && dataDir !== '') crashDataDirs.add(dataDir)
  if (crashHooksInstalled) return
  crashHooksInstalled = true
  const handleCrash = (source, error) => {
    try {
      console.error('[AI音乐工作室] ' + source + '：' + (error?.stack ?? error?.message ?? String(error)))
    } catch {
      // 忽略 console 失败
    }
    for (const dir of crashDataDirs) {
      // 异步落盘，不阻塞当前 tick；单条失败不影响服务。
      void recordCrash(dir, error, { version: resolveBuildInfo().version, source }).catch(() => {})
    }
  }
  process.on('uncaughtException', (error) => handleCrash('uncaughtException', error))
  process.on('unhandledRejection', (reason) => handleCrash('unhandledRejection', reason))
}

export async function startServer(options = {}) {
  const host = options.host ?? '127.0.0.1'
  const dataDir = resolveDataDir(options.dataDir)
  // v2.1：创建 state 之前清理陈旧恢复锁（真正崩溃场景会保留锁，交给 createState 上报恢复）。
  const recoveryLock = cleanupStaleRecoveryLock(dataDir)
  if (recoveryLock.checked) console.log('[aims] recovery：' + recoveryLock.reason)
  const state = createState({ dataDir, fallbackInitial: async () => createDemoProject() })
  await state.ready
  installCrashHooks(dataDir)

  // 工具运行时：与 DSH 插件相同的 studio_* 工具定义（数量以 tools.js 的 TOOL_NAMES 为准）。
  const toolDefinitions = createTools({ defineTool, state })
  const tools = new Map(toolDefinitions.map((tool) => [tool.name, tool]))

  const routes = createRoutes({ state })
  const apiHandler = routes[0].handler

  /** 最近一次收到窗口页面心跳的时间（用于启动器判断窗口是否关闭）。 */
  let lastUiSeen = 0

  /** 处理 /studio/api/tool-call：AI 桥调用工具。 */
  const handleToolCall = async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    }
    let payload
    try {
      const raw = await readBody(req, 2 * 1024 * 1024)
      payload = JSON.parse(raw.toString('utf8') || '{}')
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error?.message ?? error}` })
    }
    const name = payload?.name
    const args = payload?.args ?? {}
    const tool = tools.get(name)
    if (!tool) {
      return sendJson(res, 404, {
        ok: false,
        error: `未知工具 ${String(name)}；可用：${[...tools.keys()].join(' / ')}`,
      })
    }
    const beforeRev = state.revision
    const beforeSnapshot = JSON.parse(JSON.stringify(state.project ?? null))
    try {
      const result = await tool.execute(args, { signal: AbortSignal.timeout(120000) })
      // R6c：成功且工程 revision 变化 → 记录 AI 变更日志（读取类/错误不记录）。
      try {
        const afterRev = state.revision
        if (result && typeof result === 'object' && result.ok !== false && RESET_JOURNAL_TOOLS.has(String(name))) {
          state.aiJournal?.clear?.()
        } else if (result && typeof result === 'object' && result.ok !== false && afterRev !== beforeRev) {
          const history = typeof state.historyState === 'function' ? state.historyState() : {}
          state.aiJournal?.record({
            tool: String(name),
            title: history.undoLabel ?? String(name),
            beforeRev,
            afterRev,
            diff: diffProjectSummary(beforeSnapshot, state.project),
            canUndo: Boolean(history.canUndo),
            canRedo: Boolean(history.canRedo),
          })
        }
      } catch {
        // 日志记录失败不影响工具结果。
      }
      // 工具自身返回 ok:false（校验/业务错误）时，信封也返回 ok:false，
      // 让 DSH 桥 / E2E 能直接按 ok 判断失败，而不是把错误埋在 result 里。
      if (result && typeof result === 'object' && result.ok === false) {
        return sendJson(res, 200, {
          ok: false,
          error: result.error ?? '工具调用失败',
          result,
          rev: state.revision,
        })
      }
      return sendJson(res, 200, { ok: true, result, rev: state.revision })
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }

  const server = createServer(async (req, res) => {
    // v2.2 M2：跨源隔离响应头 → crossOriginIsolated=true，AudioWorklet 可用 SharedArrayBuffer ring。
    // COEP=require-corp 对同源 assets/worklet/blob 无影响；如未来引入跨域资源可改 credentialless。
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    try {
      // v2.2 M2：AudioWorklet + SharedArrayBuffer 需要跨源隔离；本地服务所有响应统一加头。
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      const url = new URL(req.url ?? '/', `http://${host}`)
      const pathname = url.pathname

      if (pathname === `${API_PREFIX}/tool-call`) {
        return await handleToolCall(req, res)
      }
      if (pathname === `${API_PREFIX}/ui-heartbeat`) {
        lastUiSeen = Date.now()
        return sendJson(res, 200, { ok: true })
      }
      if (pathname === `${API_PREFIX}/ui-status`) {
        return sendJson(res, 200, {
          ok: true,
          seen: lastUiSeen > 0,
          lastSeenAgoMs: lastUiSeen > 0 ? Date.now() - lastUiSeen : -1,
        })
      }
      if (pathname === `${API_PREFIX}/shutdown`) {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
        }
        sendJson(res, 200, { ok: true })
        setTimeout(() => {
          void close()
        }, 30)
        return
      }
      if (pathname === '/' || pathname === '/index.html') {
        const ok = await sendFile(res, PAGE_FILE)
        if (!ok) sendJson(res, 500, { ok: false, error: '缺少独立窗口页面（src/standalone/index.html）' })
        return
      }
      if (pathname === '/favicon.svg') {
        const ok = await sendFile(res, FAVICON_FILE, 'public, max-age=3600')
        if (!ok) sendJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      if (pathname.startsWith('/samples/')) {
        // CC0 采样文件（assets/samples，来源见 LICENSES.md）
        const rel = decodeURIComponent(pathname.slice('/samples/'.length))
        const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '')
        const filePath = path.join(SAMPLES_DIR, safe)
        if (!filePath.startsWith(SAMPLES_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        if (!existsSync(filePath)) return sendJson(res, 404, { ok: false, error: `缺少采样 ${pathname}` })
        const ok = await sendFile(res, filePath, 'public, max-age=86400')
        if (!ok) sendJson(res, 500, { ok: false, error: '读取采样失败' })
        return
      }
      if (pathname.startsWith('/soundfonts/')) {
        // 真实采样音色库（GeneralUser GS；来源与许可见 assets/soundfonts/README.md）
        const rel = decodeURIComponent(pathname.slice('/soundfonts/'.length))
        const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '')
        const filePath = path.join(SOUNDFONTS_DIR, safe)
        if (!filePath.startsWith(SOUNDFONTS_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        if (!existsSync(filePath)) return sendJson(res, 404, { ok: false, error: `缺少音色库 ${pathname}` })
        const ok = await sendFile(res, filePath, 'public, max-age=86400')
        if (!ok) sendJson(res, 500, { ok: false, error: '读取音色库失败' })
        return
      }
      if (pathname.startsWith('/assets/')) {
        const rel = pathname.slice('/assets/'.length)
        const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '')
        const filePath = path.join(ASSETS_DIR, safe)
        if (!filePath.startsWith(ASSETS_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        if (!existsSync(filePath)) {
          return sendJson(res, 404, {
            ok: false,
            error: `缺少前端资源 ${pathname}，请先运行 node build.mjs`,
          })
        }
        const ok = await sendFile(res, filePath)
        if (!ok) sendJson(res, 500, { ok: false, error: '读取资源失败' })
        return
      }
      if (pathname.startsWith(API_PREFIX)) {
        return await apiHandler(req, res)
      }
      return sendJson(res, 404, { ok: false, error: `未知路径 ${pathname}` })
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      else res.destroy()
    }
  })

  let port
  try {
    port = await listenWithFallback(server, host, Number(options.port) || DEFAULT_PORT)
  } catch (error) {
    state.dispose()
    throw error
  }

  const url = `http://${host}:${port}/`
  const buildInfo = resolveBuildInfo({ fallbackVersion: VERSION })
  const runtimeMode =
    typeof options.mode === 'string' && options.mode.trim() !== '' ? options.mode.trim() : detectRuntimeMode()
  const endpointInfo = {
    version: buildInfo.version,
    build: buildInfo,
    mode: runtimeMode,
    port,
    host,
    pid: process.pid,
    dataDir,
    startedAt: new Date().toISOString(),
    url,
  }
  await writeEndpointFile(dataDir, endpointInfo, options.endpointDirs ?? [])

  let closing = null
  const close = async () => {
    if (closing) return closing
    closing = (async () => {
      try {
        await unlink(path.join(dataDir, ENDPOINT_FILE))
      } catch {}
      await new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
        setTimeout(resolve, 1500)
      })
      // v2.2：关闭共享 plugin sidecar（避免测试/退出后残留 node 子进程与文件锁）。
      await closeSharedPluginServices().catch(() => {})
      try {
        state.dispose()
      } catch {}
    })()
    return closing
  }

  // v2.2 M2：桌面主进程通过 handle.plugins 提供 window.aimsPlugins IPC（多实例实时效果器）。
  return { server, port, url, host, state, tools, plugins: getSharedPluginService(dataDir), close, dataDir, endpointInfo, recoveryLock }
}
