/**
 * AI 音乐工作室 — 独立窗口版启动器（Node 进程 = 本地服务 + 窗口生命周期管理）。
 *
 * 行为：
 * 1. 若已有实例在跑（endpoint 文件 + health），只打开窗口；
 * 2. 否则在本进程启动本地服务（127.0.0.1，默认 41731，占用则顺延）；
 * 3. 用 Edge / Chrome 的 App 模式打开独立窗口（无地址栏/标签页，专用浏览器 profile）；
 * 4. 窗口关闭后关闭服务并退出；也可被「停止 AI 音乐工作室.bat」通过 /studio/api/shutdown 停止。
 *
 * 用法：node src/standalone/launch.mjs [--no-open] [--port 41731] [--data-dir <dir>]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, resolveDataDir, ENDPOINT_FILE } from './server.mjs'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const noOpen = args.includes('--no-open')
const wantPort = Number(option('--port', process.env.AIMS_PORT ?? 41731)) || 41731
const dataDir = resolveDataDir(option('--data-dir', process.env.AIMS_DATA_DIR))

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const EDGE_X64 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CHROME_X86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'

/** 本地浏览器 profile（专用，保证 app 窗口独立、不碰用户日常浏览器）。 */
const browserProfileDir =
  process.env.AIMS_BROWSER_PROFILE ||
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AIMusicStudio', 'browser-profile')

async function readEndpoint() {
  try {
    const raw = await readFile(path.join(dataDir, ENDPOINT_FILE), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/studio/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

function pickBrowser() {
  for (const candidate of [EDGE, EDGE_X64, CHROME, CHROME_X86]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** app 模式窗口参数。 */
function browserArgs(url) {
  return [
    `--app=${url}`,
    `--user-data-dir=${browserProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--start-maximized',
    '--window-size=1680,1000',
  ]
}

/** 读取窗口页面的心跳状态（页面每 3s POST 一次 heartbeat）。 */
async function readUiStatus(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/studio/api/ui-status`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function openWindow(url) {
  const browser = pickBrowser()
  if (!browser) {
    console.warn('[aims] 未找到 Edge/Chrome，使用系统默认浏览器（非 App 窗口模式）')
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    return null
  }
  await mkdir(browserProfileDir, { recursive: true })
  const child = spawn(browser, browserArgs(url), { detached: false, stdio: 'ignore' })
  child.on('error', (error) => console.warn('[aims] 打开窗口失败:', error.message))
  return child
}

async function main() {
  // 1) 已有实例：只开窗口
  const existing = await readEndpoint()
  if (existing?.port && (await healthy(existing.port))) {
    const url = `http://127.0.0.1:${existing.port}/`
    console.log(`[aims] 已有实例在运行：${url}`)
    if (!noOpen) await openWindow(url)
    return
  }

  // 2) 启动服务
  const app = await startServer({ dataDir, port: wantPort })
  console.log(`[aims] 服务已启动：${app.url}`)
  console.log(`[aims] 数据目录：${app.dataDir}`)
  console.log(`[aims] 端点文件：${path.join(app.dataDir, ENDPOINT_FILE)}`)

  if (noOpen) {
    console.log('[aims] --no-open：只启动服务。按 Ctrl+C 退出。')
  } else {
    // 3) 打开独立窗口并监听关闭。
    // 判断依据是「窗口页面心跳」：页面每 3s POST /studio/api/ui-heartbeat，
    // 连续 30s 收不到才视为窗口已关闭（P10：原来的 12s 对页面重渲染/卡顿过于敏感，
    // 容易把仍开着的窗口误判为关闭；30s 容忍 Edge 后台节流与一次长任务卡顿）。
    await openWindow(app.url)
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    let seenWindow = false
    const startedAt = Date.now()
    for (;;) {
      await sleep(2000)
      const status = await readUiStatus(app.port)
      if (status?.seen) {
        seenWindow = true
        if (Number(status.lastSeenAgoMs) > 30000) {
          console.log('[aims] 窗口已关闭，正在退出…')
          await app.close()
          process.exit(0)
        }
        continue
      }
      if (!seenWindow && Date.now() - startedAt > 30000) {
        console.warn(`[aims] 未检测到应用窗口心跳；服务继续运行，可手动打开：${app.url}`)
        break
      }
    }
  }

  // 4) 停止信号（停止脚本 / 终端 Ctrl+C）
  const shutdown = async (signal) => {
    console.log(`[aims] 收到 ${signal}，正在关闭…`)
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('[aims] 启动失败：', error?.message ?? error)
  process.exit(1)
})
