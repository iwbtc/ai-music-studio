/**
 * AI 音乐工作室 — 一键启动（P15）。
 *
 * `studio_launch_app` 的本地实现（不经过 App 代理）：窗口已在运行则直接返回；
 * 否则定位打包 exe → detached spawn → 轮询 /studio/api/health（≤20s）。
 *
 * 所有外部依赖（spawn/detect/now/wait/exists）都可注入，便于单测不真实启动进程。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT as PLUGIN_ROOT, detectApp as defaultDetectApp, getDetectedTarget } from './tool-bridge.js'

/** 打包 exe 文件名。 */
export const EXE_BASENAME = 'AI音乐工作室.exe'
/** 启动后等待窗口响应的默认超时（毫秒）。 */
export const LAUNCH_TIMEOUT_MS = 20000
/** 启动后轮询 health 的间隔（毫秒）。 */
export const LAUNCH_POLL_INTERVAL_MS = 400

const isFinitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0

/**
 * exe 候选列表（按优先级）：
 * 1) 环境变量 AIMS_EXE（便携版/自定义安装路径）
 * 2) <repo>/dist/AI音乐工作室-win32-x64/AI音乐工作室.exe
 * 3) <repo>/dist/win-unpacked/AI音乐工作室.exe
 * 4) <repo>/dist/AI音乐工作室.exe
 * @returns {Array<{path:string, source:string}>}
 */
export function candidateExecutables(options = {}) {
  const root = typeof options.root === 'string' && options.root !== '' ? options.root : PLUGIN_ROOT
  const env = options.env ?? process.env
  const list = []
  const envExe = typeof env?.AIMS_EXE === 'string' ? env.AIMS_EXE.trim() : ''
  if (envExe !== '') list.push({ path: path.resolve(envExe), source: 'AIMS_EXE' })
  list.push({ path: path.join(root, 'dist', 'AI音乐工作室-win32-x64', EXE_BASENAME), source: 'dist/win32-x64' })
  list.push({ path: path.join(root, 'dist', 'win-unpacked', EXE_BASENAME), source: 'dist/win-unpacked' })
  list.push({ path: path.join(root, 'dist', EXE_BASENAME), source: 'dist' })
  return list
}

/**
 * 找到第一个存在的 exe。
 * @param {{exists?:Function, candidates?:Array, root?:string, env?:object}} [options]
 * @returns {{path:string, source:string}|null}
 */
export function findExecutable(options = {}) {
  const exists = typeof options.exists === 'function' ? options.exists : existsSync
  const candidates = Array.isArray(options.candidates) ? options.candidates : candidateExecutables(options)
  for (const candidate of candidates) {
    const filePath = typeof candidate === 'string' ? candidate : candidate?.path
    if (typeof filePath !== 'string' || filePath === '') continue
    if (exists(filePath)) {
      return { path: filePath, source: typeof candidate === 'string' ? 'candidate' : (candidate?.source ?? 'candidate') }
    }
  }
  return null
}

/** 清理启动环境：删除 ELECTRON_RUN_AS_NODE（否则 Electron 会被当成 Node 运行）。 */
export function cleanLaunchEnv(env = process.env) {
  const clean = { ...(env ?? {}) }
  delete clean.ELECTRON_RUN_AS_NODE
  return clean
}

const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 默认 base URL（AIMS_APP_URL > 端口环境变量 > 41731）。 */
function defaultBaseUrl() {
  const fromEnv = typeof process.env.AIMS_APP_URL === 'string' ? process.env.AIMS_APP_URL.trim() : ''
  if (fromEnv !== '') return fromEnv.replace(/\/+$/, '')
  const port = Number(process.env.AIMS_PORT)
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 41731}`
}

/**
 * 用注入的 fetch 探测 /studio/api/health（供单测/嵌入场景；默认仍用 tool-bridge 的完整发现逻辑）。
 * @returns {Promise<string|null>} 可用的 base URL
 */
async function probeHealthWithFetch(fetchImpl, baseUrl) {
  try {
    const res = await fetchImpl(`${baseUrl}/studio/api/health`, { signal: AbortSignal.timeout(1200) })
    return res?.ok ? baseUrl : null
  } catch {
    return null
  }
}

/**
 * 启动（或确认已启动）桌面窗口。
 * @param {object} [options]
 * @param {Function} [options.spawn] child_process.spawn 注入
 * @param {Function} [options.detect] 检测函数：返回 app base URL 或 null（优先于 fetch）
 * @param {Function} [options.fetch] fetch 注入（提供时用 /studio/api/health 探测；默认用 tool-bridge 发现逻辑）
 * @param {string} [options.baseUrl] 配合 fetch 注入的 base URL（默认 AIMS_APP_URL/127.0.0.1:41731）
 * @param {Function} [options.now] 时间函数（毫秒）
 * @param {Function} [options.wait] 等待函数 (ms) => Promise
 * @param {Function} [options.exists] 文件存在判断
 * @param {Function} [options.getTarget] 返回最近一次探测的 {url,dataDir}
 * @param {Array} [options.candidates] 自定义 exe 候选
 * @param {object} [options.env] 环境变量对象（默认 process.env，测试可注入）
 * @param {string} [options.exePath] 显式指定 exe 路径（覆盖候选）
 * @param {number} [options.timeoutMs] 等待超时毫秒（默认 20000）
 * @param {number} [options.pollIntervalMs] 轮询间隔毫秒（默认 400）
 * @returns {Promise<{ok:boolean,running?:boolean,launched?:boolean,url?:string,dataDir?:string|null,exePath?:string,waitedMs?:number,error?:string}>}
 */
export async function launchApp(options = {}) {
  const spawn = typeof options.spawn === 'function' ? options.spawn : nodeSpawn
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : null
  const detect = typeof options.detect === 'function'
    ? options.detect
    : (fetchImpl
      ? () => probeHealthWithFetch(fetchImpl, typeof options.baseUrl === 'string' && options.baseUrl !== '' ? options.baseUrl.replace(/\/+$/, '') : defaultBaseUrl())
      : () => defaultDetectApp({ force: true }))
  const now = typeof options.now === 'function' ? options.now : Date.now
  const wait = typeof options.wait === 'function' ? options.wait : defaultWait
  const exists = typeof options.exists === 'function' ? options.exists : existsSync
  const getTarget = typeof options.getTarget === 'function' ? options.getTarget : getDetectedTarget
  const env = options.env ?? process.env
  const timeoutMs = isFinitePositive(options.timeoutMs) ? Number(options.timeoutMs) : LAUNCH_TIMEOUT_MS
  const pollIntervalMs = isFinitePositive(options.pollIntervalMs) ? Number(options.pollIntervalMs) : LAUNCH_POLL_INTERVAL_MS

  // 1) 已运行：直接返回（不 spawn）。
  let currentUrl = null
  try {
    currentUrl = await detect()
  } catch {
    currentUrl = null
  }
  if (currentUrl) {
    const target = getTarget() ?? {}
    return {
      ok: true,
      running: true,
      launched: false,
      url: currentUrl,
      dataDir: target.dataDir ?? null,
    }
  }

  // 2) 定位 exe（显式 exePath 优先；否则候选列表）。
  let exe = null
  if (typeof options.exePath === 'string' && options.exePath.trim() !== '') {
    const explicit = path.resolve(options.exePath.trim())
    if (!exists(explicit)) {
      return { ok: false, error: `指定的 AI 音乐工作室 exe 不存在：${explicit}` }
    }
    exe = { path: explicit, source: 'exePath' }
  } else {
    exe = findExecutable({ exists, candidates: options.candidates, root: options.root, env })
  }
  if (!exe) {
    return {
      ok: false,
      error:
        '未找到「AI 音乐工作室」exe：请把 exe 放在仓库 dist/AI音乐工作室-win32-x64/AI音乐工作室.exe，' +
        '或设置环境变量 AIMS_EXE 指向 exe（便携版）；也可以在参数 exe 里传完整路径。',
    }
  }

  // 3) 启动（detached，不接管 stdio；清理 ELECTRON_RUN_AS_NODE）。
  try {
    const child = spawn(exe.path, [], {
      detached: true,
      stdio: 'ignore',
      env: cleanLaunchEnv(env),
      windowsHide: false,
    })
    child?.unref?.()
  } catch (error) {
    return {
      ok: false,
      error: `启动 AI 音乐工作室失败（${exe.path}）：${error?.message ?? error}。请手动双击 exe 后重试。`,
      exePath: exe.path,
    }
  }

  // 4) 轮询 health，最长 timeoutMs。
  const startedAt = now()
  for (;;) {
    if (now() - startedAt >= timeoutMs) break
    await wait(pollIntervalMs)
    let url = null
    try {
      url = await detect()
    } catch {
      url = null
    }
    if (url) {
      const target = getTarget() ?? {}
      return {
        ok: true,
        running: true,
        launched: true,
        url,
        dataDir: target.dataDir ?? null,
        exePath: exe.path,
        waitedMs: Math.max(0, now() - startedAt),
      }
    }
  }
  const seconds = Math.round(timeoutMs / 1000)
  return {
    ok: false,
    error:
      `已尝试启动「${exe.path}」，但 ${seconds} 秒内没有检测到窗口响应。` +
      '请检查窗口是否弹出（可能被安全软件拦截/端口占用），或手动双击 exe 后重试；' +
      '便携版可用环境变量 AIMS_EXE 或参数 exe 指定路径。',
    exePath: exe.path,
    timeoutMs,
  }
}

/** 工具输出声明（与 studio_* 工具一致：开放对象 + JSON 文本渲染）。 */
const LAUNCH_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * 创建本地工具 `studio_launch_app`（**不经过 withAppProxy**：窗口没开时它必须能工作）。
 * @param {{defineTool:Function, launch?:Function}} options
 */
export function createLaunchTool(options = {}) {
  const defineTool = options?.defineTool
  if (typeof defineTool !== 'function') throw new TypeError('createLaunchTool: defineTool 必须是函数')
  const launch = typeof options.launch === 'function' ? options.launch : launchApp
  return defineTool({
    name: 'studio_launch_app',
    description:
      '**窗口没开时先调用我**：一键启动「AI 音乐工作室」桌面窗口（或确认它已在运行）。' +
      '先探测当前窗口：已运行 → 返回 {ok:true,running:true,url}；未运行 → 自动定位打包 exe（环境变量 AIMS_EXE 或仓库 dist/AI音乐工作室-win32-x64/）并启动，' +
      '然后轮询 /studio/api/health 最长 20 秒，成功返回 url/dataDir，失败返回中文错误与排查提示。' +
      '当 studio_app_info 或其他 studio_* 工具报「桌面窗口没有运行」、而用户说「打开音乐工作室 / 开始做音乐 / 试听」时，先调用本工具；' +
      '启动成功后即可正常调用其余 studio_* 工具。不会创建隐藏数据、不会写入工程。',
    parameters: {
      exe: { type: 'string', description: '可选：exe 完整路径（覆盖默认候选；便携版也可用环境变量 AIMS_EXE）' },
      timeoutMs: { type: 'integer', description: '等待窗口响应的超时毫秒数（默认 20000）' },
    },
    output: LAUNCH_OUTPUT,
    execute: async (args = {}) => {
      try {
        const result = await launch({
          ...(typeof args?.exe === 'string' && args.exe.trim() !== '' ? { exePath: args.exe.trim() } : {}),
          ...(isFinitePositive(args?.timeoutMs) ? { timeoutMs: Number(args.timeoutMs) } : {}),
        })
        return result ?? { ok: false, error: '启动 AI 音乐工作室失败：没有返回结果' }
      } catch (error) {
        return { ok: false, error: `启动 AI 音乐工作室失败：${error?.message ?? error}` }
      }
    },
  })
}
