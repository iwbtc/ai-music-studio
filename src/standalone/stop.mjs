/**
 * AI 音乐工作室 — 停止本地服务与窗口。
 * 优先通过 endpoint 文件找到实例并 POST /studio/api/shutdown；失败时按 pid 结束进程。
 */
import { readFile, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDataDir, ENDPOINT_FILE } from './server.mjs'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const dataDir = resolveDataDir(process.env.AIMS_DATA_DIR)
const endpointPath = path.join(dataDir, ENDPOINT_FILE)

async function main() {
  let info = null
  try {
    info = JSON.parse(await readFile(endpointPath, 'utf8'))
  } catch {
    console.log('[aims] 未发现运行中的实例（没有 app-endpoint.json）。')
    return
  }

  const port = Number(info?.port)
  let stopped = false
  if (port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/studio/api/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      })
      stopped = res.ok
    } catch {
      stopped = false
    }
  }
  if (!stopped && info?.pid) {
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(info.pid), '/F', '/T'], () => resolve())
    })
    stopped = true
  }
  try {
    await unlink(endpointPath)
  } catch {}
  console.log(stopped ? '[aims] 已停止 AI 音乐工作室。' : '[aims] 停止请求已发送（实例可能已退出）。')
}

main().catch((error) => {
  console.error('[aims] 停止失败：', error?.message ?? error)
  process.exitCode = 1
})
