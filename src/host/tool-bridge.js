/**
 * AI 音乐工作室 — DSH 工具到「独立窗口 App」的桥。
 *
 * 重要：工具**只操作正在运行的桌面窗口**。窗口没开时直接报错，绝不回退到
 * 插件内嵌后端（避免 AI 把内容写进用户看不到的后台数据）。
 *
 * 发现顺序：环境变量 AIMS_APP_URL → data/app-endpoint.json
 *          → %APPDATA%\AI音乐工作室\app-endpoint.json → 默认 http://127.0.0.1:41731。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
/** 插件根目录（src/host → src → 根）。 */
export const ROOT = path.resolve(HERE, '..', '..')
export const DEFAULT_PORT = Number(process.env.AIMS_PORT) || 41731
export const ENDPOINT_FILE = 'app-endpoint.json'

/** 窗口没开时给用户/模型的可操作错误信息。 */
export const NO_APP_MESSAGE =
  '桌面窗口「AI 音乐工作室」没有运行，本次工具调用已取消（不会写入任何后台数据）。' +
  '可先调用 studio_app_status 查看窗口状态/上次退出原因，或调用 studio_launch_app 一键启动窗口（自动定位 exe 并等待响应，最长 20 秒）；' +
  '也可手动双击打开 AI音乐工作室（exe 或「启动 AI 音乐工作室.vbs」），确认窗口显示后重试；' +
  '窗口启动后可用 studio_app_info 查看当前写入目标（app.url / app.dataDir）。'

/** App 发现结果缓存（成功 3s / 失败 2s，避免每次工具调用都探测）。 */
const cache = { at: 0, url: null, info: null, ok: false }

/** 读取 app-endpoint.json（包含 port/url/dataDir/mode/pid/startedAt）。 */
export async function readEndpointInfo() {
  const dirs = [
    process.env.AIMS_ENDPOINT_DIR,
    path.join(ROOT, 'data'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'AI音乐工作室') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'AI音乐工作室', 'data') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'ai-music-studio') : null,
  ].filter(Boolean)
  for (const dir of dirs) {
    try {
      const raw = await readFile(path.join(dir, ENDPOINT_FILE), 'utf8')
      const info = JSON.parse(raw)
      const port = Number(info?.port)
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        return { ...info, url: `http://127.0.0.1:${port}` }
      }
    } catch {
      /* 尝试下一个目录 */
    }
  }
  return null
}

/**
 * 探测独立窗口 App 是否可达。
 * @param {{ force?: boolean, timeoutMs?: number }} [options]
 * @returns {Promise<string|null>} 可用的 base URL，或 null
 */
export async function detectApp(options = {}) {
  const now = Date.now()
  const ttl = cache.ok ? 3000 : 2000
  if (!options.force && now - cache.at < ttl) return cache.url

  const candidates = []
  if (process.env.AIMS_APP_URL) candidates.push(String(process.env.AIMS_APP_URL).replace(/\/+$/, ''))
  const endpoint = await readEndpointInfo()
  if (endpoint?.url) candidates.push(endpoint.url)
  candidates.push(`http://127.0.0.1:${DEFAULT_PORT}`)

  for (const url of [...new Set(candidates)]) {
    try {
      const res = await fetch(`${url}/studio/api/health`, { signal: AbortSignal.timeout(options.timeoutMs ?? 1200) })
      if (res.ok) {
        cache.at = now
        cache.url = url
        cache.info = endpoint?.url === url ? endpoint : { url }
        cache.ok = true
        return url
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  cache.at = now
  cache.url = null
  cache.info = null
  cache.ok = false
  return null
}

/** 最近一次探测到的目标信息（url/dataDir 等；没有则为 null）。 */
export function getDetectedTarget() {
  return cache.ok ? { url: cache.url, ...(cache.info ?? {}) } : null
}

/**
 * 通过 App 后端执行一个工具。
 * @param {string} baseUrl App base URL
 * @param {string} name 工具名
 * @param {object} args 参数
 * @returns {Promise<object>} 工具结果（App 侧返回的 {ok:true,...} 或 {ok:false,error}）
 */
export async function callAppTool(baseUrl, name, args) {
  const res = await fetch(`${baseUrl}/studio/api/tool-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args: args ?? {} }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`App tool-call HTTP ${res.status}`)
  const data = await res.json()
  if (data && data.ok) return data.result
  return { ok: false, error: data?.error ?? 'App 工具调用失败' }
}

/**
 * 给工具定义包一层「只代理到 App」的执行器：
 * - App 可达 → 转发到 App 后端（真正写入窗口工程）；
 * - App 不可达 → 抛错（NO_APP_MESSAGE），**不回退本地**。
 *
 * @param {object} definition 本地工具定义（保留 name/description/parameters/output）
 * @param {{ onProxy?: (name:string, baseUrl:string)=>void, onError?: (error:Error)=>void }} [options]
 * @returns {object} ToolDefinition
 */
export function withAppProxy(definition, options = {}) {
  return {
    ...definition,
    async execute(args) {
      const baseUrl = await detectApp()
      if (!baseUrl) throw new Error(NO_APP_MESSAGE)
      try {
        options.onProxy?.(definition.name, baseUrl)
        return await callAppTool(baseUrl, definition.name, args)
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)))
        throw new Error(
          `与桌面窗口的连接失败（${baseUrl}）：${error?.message ?? error}。` +
            '请确认窗口还开着；如需重新连接可再调用 studio_app_info。' +
            '本次调用没有写入任何数据。',
        )
      }
    },
  }
}
