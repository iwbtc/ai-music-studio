/**
 * AI 音乐工作室 — 窗口状态本地工具（R0-16 配套）。
 *
 * `studio_app_status`：优先探测桌面窗口是否运行；运行中读 `<dataDir>/app-status.json`
 * 返回 pid/uptime/version/dataDir；未运行时读 APPDATA/仓库 data 下的状态文件，返回
 * `lastExit`（exit code / 崩溃原因）与中文说明。所有探测函数可注入，便于单测。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, detectApp as defaultDetectApp, getDetectedTarget } from './tool-bridge.js'

/** 状态文件名（由 desktop/main.cjs 写入；本工具只读）。 */
export const APP_STATUS_FILE = 'app-status.json'

/** 把 startedAt（ISO 字符串或毫秒数）转为毫秒时间戳；非法返回 null。 */
export function parseStartedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * 状态文件候选目录（按优先级）：
 * env AIMS_STATUS_FILE（完整文件路径）→ env AIMS_DATA_DIR → 探测到的 dataDir →
 * %APPDATA%/AI音乐工作室/data → %APPDATA%/AI音乐工作室 → 仓库 data。
 * @param {{env?:object, root?:string, dataDir?:string, extraDirs?:string[]}} [options]
 * @returns {string[]} 候选文件路径
 */
export function statusFileCandidates(options = {}) {
  const env = options.env ?? process.env
  const root = typeof options.root === 'string' && options.root !== '' ? options.root : ROOT
  const dirs = []
  const addDir = (dir) => {
    if (typeof dir !== 'string' || dir.trim() === '') return
    dirs.push(path.resolve(dir.trim()))
  }
  const explicitFile = typeof env.AIMS_STATUS_FILE === 'string' ? env.AIMS_STATUS_FILE.trim() : ''
  if (explicitFile !== '') return [path.resolve(explicitFile)]
  addDir(env.AIMS_DATA_DIR)
  addDir(options.dataDir)
  for (const extra of options.extraDirs ?? []) addDir(extra)
  const appData = env.APPDATA ?? env['APPDATA']
  if (typeof appData === 'string' && appData.trim() !== '') {
    addDir(path.join(appData, 'AI音乐工作室', 'data'))
    addDir(path.join(appData, 'AI音乐工作室'))
    addDir(path.join(appData, 'ai-music-studio'))
  }
  addDir(path.join(root, 'data'))
  const unique = [...new Set(dirs)]
  return unique.map((dir) => path.join(dir, APP_STATUS_FILE))
}

/** 读取单个状态文件；返回 {ok,status?,file?,error?}。 */
export async function readStatusFile(filePath) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, missing: true, file: filePath }
    return { ok: false, file: filePath, error: `读取失败：${error?.message ?? error}` }
  }
  try {
    const status = JSON.parse(raw)
    if (status === null || typeof status !== 'object' || Array.isArray(status)) {
      return { ok: false, file: filePath, error: '状态文件不是 JSON 对象' }
    }
    return { ok: true, file: filePath, status }
  } catch {
    return { ok: false, file: filePath, error: '状态文件不是合法 JSON（可能写了一半）' }
  }
}

/** 中文 lastExit 文案。 */
export function formatLastExit(lastExit) {
  if (!lastExit || typeof lastExit !== 'object') return null
  const at = parseStartedAt(lastExit.at ?? lastExit.time ?? lastExit.finishedAt)
  const timeText = at === null ? '时间未知' : new Date(at).toLocaleString('zh-CN', { hour12: false })
  const code = lastExit.code ?? lastExit.exitCode
  const reason = typeof lastExit.reason === 'string' ? lastExit.reason : ''
  const signal = typeof lastExit.signal === 'string' ? lastExit.signal : ''
  const parts = []
  if (code !== undefined && code !== null) parts.push(`exit code ${code}`)
  if (signal !== '') parts.push(`signal ${signal}`)
  if (reason !== '') parts.push(reason)
  return `上次退出：${timeText}${parts.length > 0 ? `（${parts.join(' / ')}）` : ''}`
}

/**
 * 查询窗口状态。
 * @param {object} [options]
 * @param {Function} [options.detect] 返回 app base URL 或 null（默认 tool-bridge.detectApp）
 * @param {Function} [options.getTarget] 返回最近探测目标信息（默认 getDetectedTarget）
 * @param {Function} [options.now] 时间函数
 * @param {object} [options.env] 环境变量
 * @param {string} [options.root] 插件根目录
 * @param {string[]} [options.extraDirs] 额外状态目录（测试/嵌入用）
 * @returns {Promise<object>}
 */
export async function getAppStatus(options = {}) {
  const detect = typeof options.detect === 'function' ? options.detect : () => defaultDetectApp({ force: true })
  const getTarget = typeof options.getTarget === 'function' ? options.getTarget : getDetectedTarget
  const now = typeof options.now === 'function' ? options.now : Date.now
  const env = options.env ?? process.env
  let url = null
  try {
    url = await detect()
  } catch {
    url = null
  }
  const target = (() => {
    try {
      return getTarget() ?? {}
    } catch {
      return {}
    }
  })()
  const candidates = statusFileCandidates({
    env,
    root: options.root,
    dataDir: target?.dataDir ?? env?.AIMS_DATA_DIR,
    extraDirs: options.extraDirs,
  })
  let valid = null
  let firstError = null
  for (const file of candidates) {
    const read = await readStatusFile(file)
    if (read.ok) {
      valid = { ...read, status: read.status }
      break
    }
    if (!read.missing && firstError === null) firstError = read
  }
  const parsed = valid?.status ?? {}
  const statusFile = valid?.file ?? firstError?.file ?? null
  const warnings = []
  if (!valid && firstError?.error) warnings.push(`状态文件损坏：${firstError.error}`)

  if (url) {
    const startedAt = parseStartedAt(parsed.startedAt ?? parsed.startTime) ?? parseStartedAt(target?.startedAt)
    const uptimeMs = startedAt === null ? null : Math.max(0, Math.round(now() - startedAt))
    return {
      ok: true,
      running: true,
      status: 'running',
      url,
      pid: Number.isFinite(Number(parsed.pid)) ? Number(parsed.pid) : (Number.isFinite(Number(target?.pid)) ? Number(target.pid) : null),
      uptimeMs,
      version: typeof parsed.version === 'string' ? parsed.version : (typeof target?.version === 'string' ? target.version : '1.0.0'),
      dataDir: typeof target?.dataDir === 'string' ? target.dataDir : (typeof parsed.dataDir === 'string' ? parsed.dataDir : null),
      ...(statusFile ? { statusFile } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join('；') } : {}),
      hint: '窗口正在运行；可直接调用 studio_* 工具。需要看上次退出原因时可在窗口关闭后再调用本工具。',
    }
  }

  const lastExitRaw = parsed.lastExit ?? (parsed.running === false ? parsed.lastExit : null)
  const lastExit = lastExitRaw
    ? {
        ...lastExitRaw,
        ...(parseStartedAt(lastExitRaw.at ?? lastExitRaw.time ?? lastExitRaw.finishedAt) !== null
          ? { at: parseStartedAt(lastExitRaw.at ?? lastExitRaw.time ?? lastExitRaw.finishedAt) }
          : {}),
      }
    : (Number.isFinite(Number(parsed.exitCode)) || typeof parsed.reason === 'string'
      ? {
          ...(Number.isFinite(Number(parsed.exitCode)) ? { code: Number(parsed.exitCode) } : {}),
          ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
          ...(parseStartedAt(parsed.exitedAt) !== null ? { at: parseStartedAt(parsed.exitedAt) } : {}),
        }
      : null)
  const lastExitText = formatLastExit(lastExit)
  return {
    ok: true,
    running: false,
    status: valid || lastExit ? 'stopped' : 'unknown',
    url: null,
    pid: null,
    uptimeMs: null,
    version: typeof parsed.version === 'string' ? parsed.version : null,
    dataDir: typeof parsed.dataDir === 'string' ? parsed.dataDir : (typeof target?.dataDir === 'string' ? target.dataDir : null),
    ...(lastExit ? { lastExit } : { lastExit: null }),
    ...(lastExitText ? { lastExitText } : {}),
    ...(statusFile ? { statusFile } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join('；') } : {}),
    ...(!valid && !firstError ? { note: '无运行记录（窗口从未启动过，或状态文件已被清理）' } : {}),
    hint: '窗口未运行：可调用 studio_launch_app 一键启动；若上次异常退出，可把 lastExit 信息告诉用户。',
  }
}

const STATUS_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * 创建本地工具 `studio_app_status`（不经过 App 代理：窗口没开时也必须可用）。
 * @param {{defineTool:Function, getStatus?:Function}} options
 */
export function createAppStatusTool(options = {}) {
  const defineTool = options?.defineTool
  if (typeof defineTool !== 'function') throw new TypeError('createAppStatusTool: defineTool 必须是函数')
  const getStatus = typeof options.getStatus === 'function' ? options.getStatus : getAppStatus
  return defineTool({
    name: 'studio_app_status',
    description:
      '**询问窗口状态/上次退出原因时先调用我**（本地工具，窗口没开也能用）：优先探测桌面窗口是否运行；' +
      '运行中返回 {running:true,url,pid,uptimeMs,version,dataDir}（读 dataDir/app-status.json）；' +
      '未运行时读取 %APPDATA%/AI音乐工作室/data/app-status.json 或仓库 data/app-status.json，返回 lastExit（exit code/崩溃原因）与中文说明；' +
      '若从未运行过则返回「无运行记录」。窗口未运行时可用 studio_launch_app 一键启动。不会写工程、不创建隐藏数据。',
    parameters: {},
    output: STATUS_OUTPUT,
    execute: async () => {
      try {
        return await getStatus()
      } catch (error) {
        return { ok: false, error: `读取窗口状态失败：${error?.message ?? error}` }
      }
    },
  })
}
