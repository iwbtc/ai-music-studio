/**
 * AI 音乐工作室 — Host HTTP API 路由。
 *
 * 由 index.js / 独立窗口 server 挂在 `/studio/api` 前缀下：
 *
 * P0（观看 + AI 创作）：
 *   GET  /studio/api/state?rev=<n>       长轮询项目状态（最多 20s；有变更立即返回）
 *   POST /studio/api/action              UI 轨道操作（toggleMute/toggleSolo/setVolume/setPan）
 *   POST /studio/api/export-done?name=x  body=WAV 二进制，写入 data/exports/<name>
 *   GET  /studio/api/health              健康检查
 *   GET  /studio/api/project-file        项目 JSON 路径
 *
 * P1（手动编辑 + 工程管理 + 撤销重做 + MIDI 导出，CONTRACT-EDIT.md §2）：
 *   POST /studio/api/edit                body={ops:[...]} 整组原子编辑
 *   POST /studio/api/history/undo|redo   撤销 / 重做
 *   GET  /studio/api/history             历史状态
 *   GET  /studio/api/projects            工程列表
 *   POST /studio/api/projects/new        新建（empty|demo|electronic|piano|song 模板）
 *   GET  /studio/api/plugins?type=       插件 SDK 清单（instrument/effect）
 *   POST /studio/api/projects/save       保存 / 另存为
 *   POST /studio/api/projects/open       打开
 *   POST /studio/api/projects/delete     删除
 *   POST /studio/api/export-midi         Host 直接生成 SMF Format 1
 *   GET  /studio/api/download?path=      下载 dataDir 下的文件
 *
 * P3b（音频导入，CONTRACT-P3B.md §2）：
 *   POST /studio/api/import-audio        JSON {name,startBar?,dataBase64,...}（也支持原始字节 + query 元数据）
 *                                        → 写 <dataDir>/media/<mediaId>.<ext> + media 条目 + 音频轨 + 音频片段
 *   GET  /studio/api/media/<file>         返回媒体二进制（Content-Type 按扩展名；只允许 media 目录）
 *
 * 本文件只依赖 node: 内置模块、shared/*、host/ops.js、host/projects.js、host/midi.js，
 * 不 import 任何 @deepseek-ai 包。handler 自己读 body、自己写响应头/状态码；
 * 方法不匹配回 405，异常回 500 JSON。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createDemoProject } from '../shared/demo.js'
import { PROJECT_TEMPLATES, createProjectFromTemplate } from '../shared/templates.js'
import { PLUGIN_SDK_VERSION, listPlugins } from '../shared/plugins.js'
import { AUDIO_EXTS, MEDIA_MAX_BYTES, createEmptyProject, makeIdGen, normalizeProject } from '../shared/model.js'
import { buildAppInfo, resolveBuildInfo } from './app-info.js'
import { loadSettings, saveSettings } from './settings.js'
import { checkForUpdate, UPDATE_CHANNELS } from './update-check.js'
import { collectDiagnostics, exportDiagnosticsText } from './diagnostics.js'
import { getSharedPluginService } from './plugin-service.js'
import { freezeTarget, getFreezeStatus, setFreezeOnProject } from './plugin-freeze.js'
import { MAX_MIDI_BYTES, MidiImportError, importMidiIntoState } from './midi-import.js'
import { exportMidiFile } from './midi.js'
import { getMetricsSnapshot } from './perf.js'
import { writeUniqueMediaFile } from './media-files.js'
import * as ops from './ops.js'
import { completeMeterRequest, peekMeterRequest } from './meter-bridge.js'
import { completePreviewRequest, peekPreviewRequest } from './preview-bridge.js'
import {
  ProjectError,
  deleteProjectFile,
  listProjects,
  loadProjectFile,
  projectFileExists,
  readProjectVersion,
  sanitizeProjectName,
  saveProjectFile,
  listProjectVersions,
  writeAutobackup,
  writeProjectVersion,
} from './projects.js'

export const API_PREFIX = '/studio/api'
export const VERSION = '2.4.0'
/** 长轮询最长挂起时间（毫秒）。 */
export const LONG_POLL_MS = 20000
/** JSON body 上限 1MB。 */
export const JSON_BODY_LIMIT = 1024 * 1024
/** 插件冻结 JSON body 上限 128MB：inputPcm stereo Float32 base64（2 bars≈2MB，8 bars≈8.2MB，32 bars≈33MB）。 */
export const PLUGIN_FREEZE_BODY_LIMIT = 128 * 1024 * 1024
/** v2.3 P1：插件 state base64 上传 body 上限 4MB（state ≤2MB）。 */
export const PLUGIN_STATE_BODY_LIMIT = 4 * 1024 * 1024
/** WAV 导出 body 上限 64MB（约 10 分钟 44.1kHz 立体声 16bit）。 */
export const EXPORT_BODY_LIMIT = 64 * 1024 * 1024
export const FREEZE_JSON_BODY_LIMIT = 64 * 1024 * 1024
/** 音频导入 JSON（base64）body 上限 48MB（30MB 音频 base64 后约 40MB）。 */
export const IMPORT_JSON_BODY_LIMIT = 48 * 1024 * 1024
/** 音频导入原始字节上限（30MB）。 */
export const IMPORT_RAW_BODY_LIMIT = MEDIA_MAX_BYTES
/** MIDI 导入 JSON body 上限（10MB 文件 base64 后约 13.4MB，留余量）。 */
export const MIDI_IMPORT_JSON_BODY_LIMIT = 16 * 1024 * 1024
/** MIDI 导入原始字节上限（10MB）。 */
export const MIDI_IMPORT_RAW_BODY_LIMIT = MAX_MIDI_BYTES

/** 媒体文件 MIME（按扩展名）。 */
const MEDIA_MIME = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** UI 轨道操作 → 撤销步骤标签。 */
const ACTION_UNDO_LABELS = {
  toggleMute: '切换静音',
  toggleSolo: '切换独奏',
  setVolume: '调整音量',
  setPan: '调整声像',
}

/** 下载文件的 MIME。 */
const DOWNLOAD_MIME = {
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** 带 HTTP 状态码的路由错误。 */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/* ------------------------------------------------------------------------- */
/* 响应工具                                                                   */
/* ------------------------------------------------------------------------- */

function setCommonHeaders(res) {
  // 只读本地数据的开发接口：允许任何来源读取，方便 UI harness / 调试页面跨端口调用。
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function sendMethodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '))
  sendJson(res, 405, { ok: false, error: `方法不允许；该接口支持 ${allowed.join(' / ')}` })
}

/** 读取请求 body（带上限），返回 Buffer。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (error, value) => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      size += chunk.length
      if (size > limit) {
        settle(new HttpError(413, `请求体过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`))
        // 停止接收剩余数据，避免内存压力。
        try {
          req.destroy()
        } catch {
          /* 已销毁 */
        }
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => settle(null, Buffer.concat(chunks))
    const onError = (error) => settle(new HttpError(400, `读取请求体失败：${error?.message ?? error}`))
    const onAborted = () => settle(new HttpError(400, '请求被中断'))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/** 解析 JSON body（空 body 视为 {}）。 */
async function readJsonBody(req, limit) {
  const buffer = await readBody(req, limit)
  if (buffer.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  if (!isObject(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象')
  return parsed
}

/* ------------------------------------------------------------------------- */
/* WAV 解析（只读取文件头计算时长，用于 lastExport.seconds）                     */
/* ------------------------------------------------------------------------- */

/** 从 WAV Buffer 头解析时长（秒）；无法解析返回 0。 */
export function wavDurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return 0
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 20 <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 16)
    } else if (id === 'data') {
      if (byteRate > 0) return Math.round((size / byteRate) * 100) / 100
      return 0
    }
    offset += 8 + size + (size % 2)
  }
  return 0
}

/** 校验 WAV 文件头，返回错误信息（合法返回 null）。 */
function validateWav(buffer) {
  if (buffer.length < 44) return 'WAV 数据过短（至少 44 字节文件头）'
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return '不是合法 WAV（缺少 RIFF 头）'
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return '不是合法 WAV（缺少 WAVE 标识）'
  return null
}
/** P14b：MP3 magic（ID3 开头或 MPEG frame sync）。 */
function validateMp3(buffer) {
  if (buffer.length < 2) return 'MP3 数据过短'
  if (buffer.toString('ascii', 0, 3) === 'ID3') return null
  for (let offset = 0; offset < Math.min(buffer.length - 1, 1024); offset += 1) {
    if (buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0) return null
  }
  return '不是合法 MP3（缺少 ID3/frame sync）'
}

/** P14b：FLAC magic（fLaC）。 */
function validateFlac(buffer) {
  if (buffer.length < 4 || buffer.toString('ascii', 0, 4) !== 'fLaC') return '不是合法 FLAC（缺少 fLaC 头）'
  return null
}

/** P14b：非 WAV 导出的时长估算（UI 可传 seconds= 精确值覆盖）。 */
function estimateAudioSeconds(format, buffer) {
  if (format === 'mp3') return Math.round((buffer.length * 8 / 192000) * 100) / 100
  if (format === 'flac') return Math.round((buffer.length * 8 / 1000000) * 100) / 100
  return 0
}

/** 解析 WAV 头（P3b 导入用）：返回 { durationSeconds, channels, sampleRate, bitsPerSample }；非法返回 null。
 * @param {Buffer} buffer
 */
export function parseWavInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let fmt = null
  let dataSize = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 24 <= buffer.length) {
      fmt = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        byteRate: buffer.readUInt32LE(offset + 16),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      }
    } else if (id === 'data') {
      dataSize = size
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (!fmt || dataSize === null || !fmt.channels || !fmt.sampleRate) return null
  let seconds = 0
  if (fmt.byteRate > 0) seconds = dataSize / fmt.byteRate
  else if (fmt.bitsPerSample > 0) seconds = dataSize / (fmt.channels * fmt.sampleRate * (fmt.bitsPerSample / 8))
  return {
    durationSeconds: Math.round(Math.max(0, Number(seconds) || 0) * 1000) / 1000,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    audioFormat: fmt.audioFormat,
  }
}
/* ------------------------------------------------------------------------- */
/* 导出文件名清理                                                             */
/* ------------------------------------------------------------------------- */

/** 把客户端传来的文件名清理成 data/exports 下的安全文件名（防目录穿越）。 */
export function sanitizeExportName(rawName, format = 'wav') {
  const expectedExt = format === 'mp3' ? '.mp3' : format === 'flac' ? '.flac' : '.wav'
  const fallback = "mixdown-" + Date.now() + expectedExt
  if (typeof rawName !== 'string' || rawName.trim() === '') return fallback
  // 去掉路径部分（同时处理 / 与 \），只保留文件名。
  const base = path.basename(rawName.trim().replace(/\\/g, '/'))
  // 保留中文/日文等 Unicode 字母与数字（轨道名可读），仅把路径分隔符、控制字符等替换为 '-'。
  let safe = base
    .replace(/[^\p{L}\p{N}.\-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
  if (safe === '') return fallback
  // P14b：扩展名跟随导出格式（wav/mp3/flac）。
  if (!safe.toLowerCase().endsWith(expectedExt)) {
    safe = safe.replace(/\.[A-Za-z0-9]+$/, '') + expectedExt
  }
  if (safe.length > 120) {
    const stamp = Date.now()
    safe = "mixdown-" + stamp + expectedExt
  }
  return safe
}
/** Content-Disposition（兼容中文文件名）。 */
function contentDisposition(fileName) {
  const asciiFallback = path.basename(fileName).replace(/[^\w.\-]+/g, '_') || 'download'
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(path.basename(fileName))}`
}

/* ------------------------------------------------------------------------- */
/* 路由工厂                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * 创建 Host API 路由。
 * @param {object} options
 * @param {object} options.state createState() 返回的状态实例
 * @param {number} [options.longPollMs] 长轮询上限（默认 20s；测试可调小）
 * @param {number} [options.jsonBodyLimit] JSON body 上限
 * @param {number} [options.exportBodyLimit] WAV body 上限
 * @param {string} [options.version] 健康检查返回的版本号
 */
export function createRoutes(options = {}) {
  const { state } = options
  if (!state || typeof state.mutate !== 'function') throw new TypeError('createRoutes: 缺少有效的 state')
  const longPollMs = Number.isFinite(options.longPollMs) && options.longPollMs > 0 ? options.longPollMs : LONG_POLL_MS
  const jsonBodyLimit = Number.isFinite(options.jsonBodyLimit) && options.jsonBodyLimit > 0 ? options.jsonBodyLimit : JSON_BODY_LIMIT
  const exportBodyLimit = Number.isFinite(options.exportBodyLimit) && options.exportBodyLimit > 0 ? options.exportBodyLimit : EXPORT_BODY_LIMIT
  const version = typeof options.version === 'string' ? options.version : VERSION

  /* ── P0：状态长轮询 ─────────────────────────────────────────────────── */

  /** GET /state —— 长轮询。 */
  /** 给客户端读取的工程快照：lastExport 文件不存在时标 stale 且不返回失效 path（task-75）。 */
  function clientProject() {
    const project = state.project
    if (!project || !project.lastExport || typeof project.lastExport.path !== 'string' || project.lastExport.path === '') {
      return project
    }
    if (existsSync(project.lastExport.path)) return project
    return {
      ...project,
      lastExport: { ...project.lastExport, path: null, stale: true },
    }
  }

  async function handleState(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const rawRev = url.searchParams.get('rev')
    const since = rawRev === null || rawRev.trim() === '' ? null : Number(rawRev)
    const current = state.revision
    if (since === null || !Number.isFinite(since) || current > since || current < since) {
      // 无 rev（首次连接）/ 版本落后 / 版本超前（本地数据被重置）→ 立即返回当前快照。
      return sendJson(res, 200, { rev: current, changed: true, project: clientProject() })
    }
    // 版本一致：挂起直到 revision 变化或超时。
    await new Promise((resolve) => {
      let finished = false
      let timer = null
      let unsubscribe = null
      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (unsubscribe !== null) {
          unsubscribe()
          unsubscribe = null
        }
        res.removeListener('close', onClose)
      }
      const finish = (payload) => {
        if (finished) return
        finished = true
        cleanup()
        sendJson(res, 200, payload)
        resolve()
      }
      const onClose = () => {
        // 客户端断开（刷新页面 / 组件卸载）：只清理，不再写响应。
        if (finished) return
        finished = true
        cleanup()
        resolve()
      }
      res.on('close', onClose)
      if (res.writableEnded || res.destroyed) {
        onClose()
        return
      }
      timer = setTimeout(() => finish({ rev: since, changed: false }), longPollMs)
      // 不阻止进程退出（Node 定时器默认会阻塞退出；长轮询不该影响测试/关闭）。
      timer.unref?.()
      unsubscribe = state.subscribe((revision) => {
        if (revision > since) finish({ rev: revision, changed: true, project: clientProject() })
      })
    })
  }

  /* ── P0：UI 轨道操作 ────────────────────────────────────────────────── */

  /** POST /action —— UI 轨道操作。 */
  async function handleAction(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    try {
      const undoLabel = ACTION_UNDO_LABELS[body.type] ?? '轨道操作'
      const result = state.mutate(
        // 用户操作不写入 AI 动态历史，只 bump revision + 记一条撤销步骤
        { tool: 'studio_action', text: null, undoLabel },
        (draft) => ops.applyAction(draft, body),
      )
      return sendJson(res, 200, { ok: true, rev: state.revision, ...result, canUndo: state.canUndo, canRedo: state.canRedo })
    } catch (error) {
      // P0 约定：/action 参数错误回 400（编辑 API /edit 的校验错误则回 200 + ok:false）
      if (error?.name === 'OpError') return sendJson(res, 400, { ok: false, error: error.message })
      throw error
    }
  }

  /* ── P0：WAV 导出回传 ──────────────────────────────────────────────── */

  /** 唯一导出文件路径：同名自动追加 -2/-3…（不覆盖已有文件）。 */
  async function uniqueExportPath(dir, name) {
    const ext = path.extname(name)
    const base = ext ? name.slice(0, -ext.length) : name
    for (let index = 0; index < 1000; index += 1) {
      const candidate = index === 0 ? name : `${base}-${index + 1}${ext}`
      const candidatePath = path.join(dir, candidate)
      try {
        await stat(candidatePath)
      } catch (error) {
        if (error?.code === 'ENOENT') return { name: candidate, path: candidatePath }
        throw error
      }
    }
    const stamp = Date.now()
    const fallbackName = `${base}-${stamp}${ext}`
    return { name: fallbackName, path: path.join(dir, fallbackName) }
  }

  /** POST /export-claim —— v2.1 多客户端导出 claim：{jobId,clientId}，只有首个 claim 渲染。 */
  async function handleExportClaim(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    try {
      const result = state.mutate({ tool: 'studio_export_claim', text: null }, (draft) => ops.claimExport(draft, body))
      return sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /** POST /export-done?name=<file>&jobId=<id>&seconds=<s> —— UI 渲染完成回传。 */
  async function handleExportDone(req, res, url) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const buffer = await readBody(req, exportBodyLimit)
    if (buffer.length === 0) throw new HttpError(400, '导出 body 为空（应为音频二进制）')
    const jobIdParam = url.searchParams.get('jobId')
    const queried = jobIdParam ? ops.getExportStatus(state.project, jobIdParam) : { found: false, job: null }
    // v2.1：竞态下旧 job 可能已被新请求替换；stale 时仍接受文件并回 ok:true，不制造 console error。
    const staleJob = Boolean(jobIdParam) && (!queried.found || !queried.job)
    const job = staleJob ? null : (queried.job ?? (state.project.exportRequest ? ops.getExportStatus(state.project).job : null))
    // v2.1：导出响度/峰值指标（UI 从 engine.applyTargetLufs 回传；数值容错）。
    const exportMetrics = {}
    for (const key of ['achievedLufs', 'peak', 'peakDb', 'truePeak', 'truePeakDb', 'gainDb']) {
      const raw = url.searchParams.get(key)
      const numeric = Number(raw)
      if (raw !== null && raw !== '' && Number.isFinite(numeric)) exportMetrics[key] = numeric
    }
    const limitedRaw = url.searchParams.get('limited')
    if (limitedRaw === '1' || limitedRaw === 'true') exportMetrics.limited = true
    else if (limitedRaw === '0' || limitedRaw === 'false') exportMetrics.limited = false
    const nameHint = url.searchParams.get('name') ?? job?.name ?? null
    const extHint = path.extname(String(nameHint ?? '')).toLowerCase()
    const format = job?.format === 'stems' || job?.format === 'mp3' || job?.format === 'flac'
      ? job.format
      : (extHint === '.mp3' ? 'mp3' : extHint === '.flac' ? 'flac' : 'wav')
    const name = sanitizeExportName(nameHint, format === 'stems' ? 'wav' : format)
    if (format === 'mp3') {
      const mp3Error = validateMp3(buffer)
      if (mp3Error) throw new HttpError(400, mp3Error)
    } else if (format === 'flac') {
      const flacError = validateFlac(buffer)
      if (flacError) throw new HttpError(400, flacError)
    } else {
      const wavError = validateWav(buffer)
      if (wavError) throw new HttpError(400, wavError)
    }
    const outputDir = job?.outputDir ? path.resolve(job.outputDir) : state.exportsDir
    let target
    try {
      await mkdir(outputDir, { recursive: true })
      target = await uniqueExportPath(outputDir, name)
      await writeFile(`${target.path}.tmp`, buffer)
      await rename(`${target.path}.tmp`, target.path)
    } catch (error) {
      const message = `写入导出文件失败（${outputDir}）：${error?.message ?? error}`
      if (job) {
        state.mutate({ tool: 'studio_export', text: `导出失败：${message}` }, (draft) =>
          ops.failExportJob(draft, { jobId: job.jobId, error: message }),
        )
      }
      return sendJson(res, 200, { ok: false, error: message, jobId: job?.jobId ?? null })
    }
    const querySeconds = Number(url.searchParams.get('seconds'))
    const seconds = format === 'wav' || format === 'stems'
      ? wavDurationSeconds(buffer)
      : (Number.isFinite(querySeconds) && querySeconds > 0
        ? Math.round(querySeconds * 100) / 100
        : estimateAudioSeconds(format, buffer))
    const exportFormat = format === 'stems' ? 'stems' : format
    let completedJob = null
    state.mutate({ tool: 'studio_export', text: `导出完成：${target.name}（${seconds}s）`, activity: `已导出 ${target.name}` }, (draft) => {
      ops.setLastExport(draft, { path: target.path, bytes: buffer.length, seconds, ...exportMetrics })
      ops.recordExportHistory(draft, { name: target.name, format: exportFormat, seconds, bytes: buffer.length, path: target.path, at: Date.now(), ...exportMetrics })
      if (job) {
        completedJob = ops.completeExportJob(draft, {
          jobId: job.jobId,
          status: 'success',
          path: target.path,
          name: target.name,
          bytes: buffer.length,
          seconds,
          format: exportFormat,
          ...exportMetrics,
        }).job
      } else {
        draft.exportRequest = null
        // stale job：仍然记录一条成功任务，便于 exportStatus 查询与 lastExport。
        if (staleJob && jobIdParam) {
          const staleEntry = {
            jobId: jobIdParam,
            status: 'success',
            format: exportFormat,
            name: target.name,
            path: target.path,
            bytes: buffer.length,
            seconds,
            finishedAt: Date.now(),
            stale: true,
            ...exportMetrics,
          }
          draft.exportJobs = [staleEntry, ...(Array.isArray(draft.exportJobs) ? draft.exportJobs.filter((item) => item.jobId !== jobIdParam) : [])].slice(0, 10)
        }
      }
      return { path: target.path }
    })
    return sendJson(res, 200, {
      ok: true,
      jobId: completedJob?.jobId ?? jobIdParam ?? null,
      status: 'success',
      ...(staleJob ? { stale: true } : {}),
      ...(completedJob && Object.keys(exportMetrics).length > 0 ? { analysis: exportMetrics } : {}),
      format: exportFormat,
      path: target.path,
      name: target.name,
      bytes: buffer.length,
      seconds,
      outputDir,
    })
  }

  /** POST /export-error —— body {jobId?, error}：标记导出失败。 */
  async function handleExportError(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    const jobId = typeof body.jobId === 'string' && body.jobId.trim() !== '' ? body.jobId.trim() : null
    const errorText = typeof body.error === 'string' && body.error.trim() !== '' ? body.error.trim() : '导出失败'
    try {
      let job = null
      state.mutate({ tool: 'studio_export', text: `导出失败：${errorText}` }, (draft) => {
        job = ops.failExportJob(draft, { ...(jobId ? { jobId } : {}), error: errorText }).job
        return job
      })
      return sendJson(res, 200, { ok: true, jobId: job?.jobId ?? jobId, status: 'error', error: errorText, job })
    } catch (error) {
      if (error?.name === 'OpError') return sendJson(res, 200, { ok: false, error: error.message })
      throw error
    }
  }

  /** GET /export-status?jobId= —— 查询导出任务（无 jobId 返回当前/最近任务）。 */
  async function handleExportStatus(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const jobId = url.searchParams.get('jobId')
    const result = ops.getExportStatus(state.project, jobId)
    return sendJson(res, 200, { ok: true, found: result.found, job: result.job, activeName: state.activeName })
  }

  /* ── P1：编辑（整组原子） ──────────────────────────────────────────── */

  /** POST /edit —— body={ops:[...]}，一组 op 作为一个撤销步骤。 */
  async function handleEdit(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    const opsList = body.ops
    if (!Array.isArray(opsList)) {
      return sendJson(res, 200, { ok: false, error: 'ops 必须是编辑操作数组' })
    }
    try {
      const undoLabel = ops.editLabelFor(opsList)
      const result = state.mutate({ tool: 'studio_edit', text: null, undoLabel }, (draft) => ops.applyEditOps(draft, opsList))
      return sendJson(res, 200, {
        ok: true,
        rev: state.revision,
        label: result.label,
        results: result.results,
        ...(result.warnings ? { warnings: result.warnings } : {}),
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      })
    } catch (error) {
      // 校验失败：HTTP 200 + {ok:false,error:'中文原因'}（与工具风格一致）
      if (error?.name === 'OpError') return sendJson(res, 200, { ok: false, error: error.message })
      throw error
    }
  }

  /* ── R1a：性能指标（只读，不含工程内容） ──────────────────────────── */

  /** GET /metrics —— uptime/toolCalls/state save-load/memory/工程规模。 */
  async function handleMetrics(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const project = state.project
    const stats = ops.projectStats(project)
    return sendJson(res, 200, {
      ok: true,
      ...getMetricsSnapshot(),
      revision: Number(project.revision) || 0,
      projectBytes: Buffer.byteLength(JSON.stringify(project)),
      tracks: project.tracks.length,
      patterns: project.patterns.length,
      clips: project.clips.length,
      notes: stats.notes,
      media: Array.isArray(project.media) ? project.media.length : 0,
      activeName: state.activeName,
    })
  }

  /* ── P1：撤销 / 重做 / 历史 ────────────────────────────────────────── */

  /** GET /history —— 撤销/重做状态。 */
  async function handleHistory(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    return sendJson(res, 200, { ok: true, rev: state.revision, ...state.historyState() })
  }

  /** POST /history/undo | /history/redo —— 撤销/重做一步。 */
  function makeHistoryStep(step) {
    return async function handleHistoryStep(req, res) {
      if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
      await state.ready
      const result = step === 'undo' ? state.undo() : state.redo()
      return sendJson(res, 200, {
        ok: true,
        step,
        didStep: Boolean(result.ok),
        label: result.label,
        rev: state.revision,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      })
    }
  }
  const handleUndo = makeHistoryStep('undo')
  const handleRedo = makeHistoryStep('redo')

  /* ── P1：工程管理 ──────────────────────────────────────────────────── */

  /** GET /projects —— 工程列表 + 当前工程信息。 */
  async function handleProjectsList(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const { projects, skipped, unsupported } = await listProjects(state.dataDir)
    return sendJson(res, 200, {
      ok: true,
      activeName: state.activeName,
      activeSavedAt: state.activeSavedAt,
      projects,
      ...(skipped.length > 0 ? { skipped } : {}),
      // P12 clean break：旧 schema 工程不出现 projects，单独标记 unsupported。
      ...(unsupported && unsupported.length > 0 ? { unsupported } : {}),
    })
  }

  /** R0A：破坏性操作前统一快照（命名工程写版本历史，未命名写 _autobackup-*；失败只 warning）。 */
  async function snapshotBeforeDestructive() {
    try {
      if (state.activeName) {
        const version = await writeProjectVersion(state.dataDir, state.activeName, state.project)
        return { backupPath: version.path, backupId: version.id, backupKind: 'version' }
      }
      const backup = await writeAutobackup(state.dataDir, state.project)
      return { backupPath: backup.path, backupKind: 'autobackup' }
    } catch (error) {
      return { backupPath: null, warning: `自动快照失败：${error?.message ?? error}` }
    }
  }

  /** GET /ai-changes —— R6c AI 变更日志（UI 用；只读）。 */
  async function handleAiChanges(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    const rawLimit = url?.searchParams?.get('limit')
    const parsed = Number(rawLimit)
    const limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 30) : 30
    const changes = state.aiJournal?.list({ limit, currentRevision: state.revision }) ?? []
    const history = typeof state.historyState === 'function' ? state.historyState() : {}
    return sendJson(res, 200, {
      ok: true,
      changes,
      canUndo: Boolean(history.canUndo),
      canRedo: Boolean(history.canRedo),
      undoLabel: history.undoLabel ?? '',
      redoLabel: history.redoLabel ?? '',
    })
  }

  /** GET /plugins —— 插件 SDK 清单（R5c；type 可选 instrument/effect）。 */
  async function handlePluginsList(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    const type = url?.searchParams?.get('type') ?? null
    let plugins
    try {
      plugins = listPlugins(type ? { type } : {})
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
    }
    return sendJson(res, 200, {
      ok: true,
      sdkVersion: PLUGIN_SDK_VERSION,
      type,
      count: plugins.length,
      plugins,
    })
  }

  /** POST /projects/new —— 新建（模板：empty/demo/electronic/piano/song）并切换。 */
  async function handleProjectNew(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    const rawTemplate = typeof body.template === 'string' && body.template.trim() !== '' ? body.template.trim() : 'empty'
    const templateMeta = PROJECT_TEMPLATES.find((item) => item.id === rawTemplate)
    if (!templateMeta) {
      return sendJson(res, 400, {
        ok: false,
        error: `未知工程模板 template=${rawTemplate}；可选：${PROJECT_TEMPLATES.map((item) => item.id).join(' / ')}`,
      })
    }
    const template = templateMeta.id
    const requestedName = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : null
    const snapshot = await snapshotBeforeDestructive()
    const project = normalizeProject(createProjectFromTemplate(template))
    if (requestedName) project.title = requestedName
    state.loadProject(project, {
      resetHistory: true,
      activity: template === 'empty' ? '已新建空白工程' : `已新建模板工程「${templateMeta.name}」`,
    })
    // 新工程尚未保存到 projects/，activeName 置空（保存时才确定名字）
    state.setActiveProject(null, null)
    return sendJson(res, 200, {
      ok: true,
      rev: state.revision,
      activeName: state.activeName,
      template,
      title: state.project.title,
      ...snapshot,
    })
  }

  /** POST /projects/save —— 保存 / 另存为。 */
  async function handleProjectSave(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    const project = state.project
    const requested = typeof body.name === 'string' && body.name.trim() !== '' ? body.name : state.activeName || project.title
    const safeName = sanitizeProjectName(requested, project.title)
    const overwrite = body.overwrite === true
    const exists = await projectFileExists(state.dataDir, safeName)
    if (exists && !overwrite && safeName !== state.activeName) {
      return sendJson(res, 200, { ok: false, error: `同名工程已存在：${safeName}（如需覆盖请传 overwrite:true）` })
    }
    try {
      const saved = await saveProjectFile(state.dataDir, safeName, project)
      state.setActiveProject(saved.name, saved.savedAt)
      return sendJson(res, 200, {
        ok: true,
        name: saved.name,
        activeName: saved.name,
        path: saved.path,
        bytes: saved.bytes,
        savedAt: saved.savedAt,
      })
    } catch (error) {
      if (error?.name === 'ProjectError') return sendJson(res, 200, { ok: false, error: error.message })
      throw error
    }
  }

  /** POST /projects/open —— 打开工程（替换当前工程）。 */
  async function handleProjectOpen(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return sendJson(res, 200, { ok: false, error: '缺少工程名 name' })
    }
    try {
      const snapshot = await snapshotBeforeDestructive()
      const loaded = await loadProjectFile(state.dataDir, body.name)
      state.loadProject(normalizeProject(loaded.project), { resetHistory: true, activity: `已打开工程「${loaded.name}」` })
      state.setActiveProject(loaded.name, loaded.savedAt)
      return sendJson(res, 200, {
        ok: true,
        rev: state.revision,
        activeName: state.activeName,
        title: state.project.title,
        savedAt: loaded.savedAt,
        ...snapshot,
      })
    } catch (error) {
      if (error?.name === 'ProjectError') return sendJson(res, 200, { ok: false, error: error.message })
      throw error
    }
  }

  /** POST /projects/delete —— 删除工程文件。 */
  async function handleProjectDelete(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return sendJson(res, 200, { ok: false, error: '缺少工程名 name' })
    }
    try {
      const deleted = await deleteProjectFile(state.dataDir, body.name)
      if (state.activeName === deleted.name) state.setActiveProject(null, null)
      return sendJson(res, 200, { ok: true, deleted: deleted.name, activeName: state.activeName })
    } catch (error) {
      if (error?.name === 'ProjectError') return sendJson(res, 200, { ok: false, error: error.message })
      throw error
    }
  }

  /* ── P1：MIDI 导出 + 文件下载 ──────────────────────────────────────── */

  /** POST /export-midi —— Host 直接生成 SMF Format 1。 */
  async function handleExportMidi(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    const exported = await exportMidiFile({
      exportsDir: state.exportsDir,
      project: clientProject(),
      name: typeof body.name === 'string' ? body.name : undefined,
    })
    state.mutate({ tool: 'studio_export', text: `导出 MIDI：${exported.fileName}` }, (draft) =>
      ops.setLastExport(draft, { path: exported.path, bytes: exported.bytes, seconds: exported.seconds }),
    )
    return sendJson(res, 200, { ok: true, ...exported, rev: state.revision })
  }

  /** GET /download?path= —— 仅允许下载 dataDir 下的文件。 */
  async function handleDownload(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    const rawPath = url.searchParams.get('path')
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      return sendJson(res, 400, { ok: false, error: '缺少 path 参数' })
    }
    const dataDir = path.resolve(state.dataDir)
    const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(dataDir, rawPath)
    const normalizeCase = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
    const resolvedKey = normalizeCase(resolved)
    const dataDirKey = normalizeCase(dataDir)
    if (resolvedKey !== dataDirKey && !resolvedKey.startsWith(dataDirKey + path.sep)) {
      return sendJson(res, 403, { ok: false, error: '只能下载数据目录（data）下的文件' })
    }
    let data
    let info
    try {
      ;[data, info] = await Promise.all([readFile(resolved), stat(resolved)])
      if (!info.isFile()) throw Object.assign(new Error('不是文件'), { code: 'EISDIR' })
    } catch (error) {
      if (error?.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: `文件不存在：${path.basename(resolved)}` })
      return sendJson(res, 400, { ok: false, error: `读取文件失败：${error?.message ?? error}` })
    }
    const fileName = path.basename(resolved)
    res.statusCode = 200
    res.setHeader('Content-Type', DOWNLOAD_MIME[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream')
    res.setHeader('Content-Length', data.length)
    res.setHeader('Content-Disposition', contentDisposition(fileName))
    res.setHeader('Cache-Control', 'no-store')
    res.end(data)
  }

  /* ── P3b：媒体文件二进制 ───────────────────────────────────────────── */

  /** 媒体文件 MIME（按扩展名）。 */
  function mediaContentType(fileName) {
    const ext = path.extname(String(fileName)).toLowerCase().slice(1)
    return MEDIA_MIME[ext] ?? 'application/octet-stream'
  }

  /** GET /media/<file> —— 返回 <dataDir>/media 下的媒体文件（只允许已登记媒体、禁止路径穿越）。 */
  async function handleMedia(req, res, url, rawName) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    let name
    try {
      name = decodeURIComponent(rawName)
    } catch {
      return sendJson(res, 403, { ok: false, error: '媒体文件名非法（无法解码）' })
    }
    const safe = typeof name === 'string' && name !== '' && !name.includes('/') && !name.includes('\\') &&
      !name.includes('..') && path.basename(name) === name && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,120}$/.test(name)
    if (!safe) return sendJson(res, 403, { ok: false, error: '媒体路径非法（禁止目录穿越）' })
    const media = (state.project.media ?? []).find((item) => item.file === name)
    if (!media) return sendJson(res, 404, { ok: false, error: `媒体不存在：${name}` })
    const mediaDir = state.mediaDir
    const resolved = path.resolve(mediaDir, name)
    const dirResolved = path.resolve(mediaDir)
    const normalizeCase = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
    if (!normalizeCase(resolved).startsWith(normalizeCase(dirResolved) + path.sep)) {
      return sendJson(res, 403, { ok: false, error: '媒体路径非法（禁止目录穿越）' })
    }
    let data
    try {
      data = await readFile(resolved)
    } catch (error) {
      if (error?.code === 'ENOENT') return sendJson(res, 404, { ok: false, error: `媒体文件缺失：${name}` })
      throw error
    }
    res.statusCode = 200
    res.setHeader('Content-Type', mediaContentType(name))
    res.setHeader('Content-Length', data.length)
    res.setHeader('Cache-Control', 'no-store')
    res.end(data)
  }

  /* ── P3b：导入音频 ─────────────────────────────────────────────────── */

  /** 解码 base64 音频（兼容 data URL 前缀）。 */
  function decodeBase64Audio(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') throw new HttpError(400, '缺少 dataBase64（音频文件 base64）')
    const cleaned = raw.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) throw new HttpError(400, 'dataBase64 不是合法 base64')
    const buffer = Buffer.from(cleaned, 'base64')
    if (buffer.length === 0) throw new HttpError(400, '音频数据为空')
    return buffer
  }

  /** 从文件名取音频扩展名（不支持返回 null）。 */
  function audioExtFromName(rawName) {
    if (typeof rawName !== 'string' || rawName.trim() === '') return null
    const base = path.basename(rawName.trim().replace(/\\/g, '/'))
    const match = /\.([A-Za-z0-9]+)$/.exec(base)
    if (!match) return null
    const ext = match[1].toLowerCase()
    return AUDIO_EXTS.includes(ext) ? ext : null
  }

  /**
   * POST /import-audio —— 导入音频。
   * 两种 body 任选：
   * 1) JSON：{ name, startBar?, dataBase64, durationSeconds?, channels?, sampleRate?, peaks? }
   * 2) 原始字节 + Content-Type: audio/*（元数据走 query：?name=&startBar=&durationSeconds=&channels=&sampleRate=）
   * 写 <dataDir>/media/<mediaId>.<ext>，同一步创建 media 条目 + 音频轨 + 音频片段（撤销标签「导入音频」）。
   */
  async function handleImportAudio(req, res, url) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    const isRaw = contentType.startsWith('audio/') || contentType.startsWith('application/octet-stream')
    let buffer
    let name
    let startBar
    let durationSeconds
    let channels
    let sampleRate
    let peaks
    let reference = false
    let takeGroup = null
    let takeIndex = null
    if (isRaw) {
      buffer = await readBody(req, IMPORT_RAW_BODY_LIMIT)
      name = url.searchParams.get('name') ?? '导入音频.wav'
      startBar = url.searchParams.get('startBar')
      durationSeconds = url.searchParams.get('durationSeconds')
      channels = url.searchParams.get('channels')
      sampleRate = url.searchParams.get('sampleRate')
      takeGroup = url.searchParams.get('takeGroup')
      takeIndex = url.searchParams.get('takeIndex')
      const rawReference = url.searchParams.get('reference')
      reference = rawReference === 'true' || rawReference === '1'
    } else {
      const body = await readJsonBody(req, IMPORT_JSON_BODY_LIMIT)
      name = body.name
      startBar = body.startBar
      reference = body.reference === true
      takeGroup = body.takeGroup
      takeIndex = body.takeIndex
      durationSeconds = body.durationSeconds
      channels = body.channels
      sampleRate = body.sampleRate
      peaks = body.peaks
      buffer = decodeBase64Audio(body.dataBase64 ?? body.bytesBase64)
    }
    if (buffer.length > MEDIA_MAX_BYTES) {
      throw new HttpError(413, `音频文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB，上限 30MB）`)
    }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new HttpError(400, 'name 不能为空（应是带扩展名的音频文件名，如 人声.wav）')
    }
    const trimmedName = name.trim().replace(/\\/g, '/').split('/').pop() || name.trim()
    const ext = audioExtFromName(trimmedName)
    if (!ext) throw new HttpError(400, `不支持的音频格式：${trimmedName}；支持 ${AUDIO_EXTS.join(' / ')}`)
    let parsed = { durationSeconds: null, channels: null, sampleRate: null }
    if (ext === 'wav') {
      const info = parseWavInfo(buffer)
      if (!info) throw new HttpError(400, '不是合法 WAV（缺少 RIFF/WAVE 头或数据块）')
      parsed = info
    }
    const readOptionalNumber = (value) => {
      if (value === undefined || value === null || value === '') return null
      const numeric = Number(value)
      return Number.isFinite(numeric) ? numeric : null
    }
    const duration = readOptionalNumber(durationSeconds) ?? parsed.durationSeconds
    const channelCount = readOptionalNumber(channels) ?? parsed.channels
    const rate = readOptionalNumber(sampleRate) ?? parsed.sampleRate
    let startBarValue = Math.max(0, Math.round(Number(state.project.transport?.playheadBar) || 0))
    if (startBar !== undefined && startBar !== null && startBar !== '') {
      const numeric = Number(startBar)
      if (!Number.isFinite(numeric) || numeric < 0) throw new HttpError(400, 'startBar 必须是 >= 0 的数字')
      startBarValue = Math.trunc(numeric)
    }
    const mediaId = makeIdGen(state.project)('med')
    // R2a 修复：全局唯一文件名（media id 每工程重排，不能直接当文件名）。
    const { fileName, filePath } = await writeUniqueMediaFile(state.mediaDir, buffer, { mediaId, ext })
    let result
    try {
      result = state.mutate(
        {
          tool: 'studio_import_audio',
          text: `导入音频：${trimmedName}`,
          activity: '正在导入音频',
          undoLabel: '导入音频',
        },
        (draft) => {
          const media = ops.addMedia(draft, {
            id: mediaId,
            name: trimmedName,
            file: fileName,
            bytes: buffer.length,
            durationSeconds: duration,
            channels: channelCount,
            sampleRate: rate,
            peaks,
          })
          const track = ops.addAudioTrack(draft, {
            mediaId: media.id,
            startBar: startBarValue,
            reference: reference === true,
            takeGroup: takeGroup === null || takeGroup === undefined || takeGroup === '' ? undefined : takeGroup,
            takeIndex: takeIndex === null || takeIndex === undefined || takeIndex === '' ? undefined : takeIndex,
          })
          return { media, track }
        },
      )
    } catch (error) {
      // 元数据/建轨失败：回滚已写入的媒体文件，避免磁盘残留。
      await rm(filePath, { force: true })
      throw error
    }
    return sendJson(res, 200, {
      ok: true,
      rev: state.revision,
      mediaId,
      trackId: result.track.trackId,
      clipId: result.track.clipId,
      name: result.media.name,
      file: fileName,
      bytes: buffer.length,
      durationSeconds: result.media.durationSeconds,
      channels: result.media.channels,
      sampleRate: result.media.sampleRate,
      startBar: result.track.startBar,
      lengthBars: result.track.lengthBars,
      reference: result.track.reference === true,
      ...(result.track?.takeGroup
        ? { takeGroup: result.track.takeGroup, takeIndex: result.track.takeIndex, takeActive: true }
        : {}),
    })
  }

  /* ── P14a：MIDI 导入 / 工程版本历史 ─────────────────────────────────── */

  /** 读取 /import-midi 的 payload（JSON base64 或原始字节 + query）。 */
  async function readImportMidiPayload(req, url) {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (contentType.includes('application/json')) {
      const body = await readJsonBody(req, MIDI_IMPORT_JSON_BODY_LIMIT)
      const rawBase64 = body.dataBase64 ?? body.data ?? body.bytesBase64
      if (typeof rawBase64 !== 'string' || rawBase64.trim() === '') {
        throw new HttpError(400, '缺少 dataBase64（MIDI 文件 base64）')
      }
      const cleaned = rawBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
      if (!/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) throw new HttpError(400, 'dataBase64 不是合法 base64')
      return {
        buffer: Buffer.from(cleaned, 'base64'),
        name: body.name,
        title: body.title,
        replace: body.replace,
      }
    }
    const buffer = await readBody(req, MIDI_IMPORT_RAW_BODY_LIMIT)
    return {
      buffer,
      name: url.searchParams.get('name'),
      title: url.searchParams.get('title'),
      replace: url.searchParams.get('replace'),
    }
  }

  /** POST /import-midi —— JSON {name?,dataBase64,replace?,title?} 或原始字节 + query。 */
  async function handleImportMidi(req, res, url) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const payload = await readImportMidiPayload(req, url)
    if (payload.buffer.length === 0) throw new HttpError(400, 'MIDI 文件为空')
    if (payload.buffer.length > MAX_MIDI_BYTES) {
      throw new HttpError(413, `MIDI 文件过大（${(payload.buffer.length / 1024 / 1024).toFixed(1)}MB，上限 10MB）`)
    }
    const rawReplace = payload.replace
    const replace = rawReplace === undefined || rawReplace === null || rawReplace === ''
      ? true
      : !(rawReplace === false || rawReplace === '0' || rawReplace === 'false')
    const title = typeof payload.title === 'string' && payload.title.trim() !== ''
      ? payload.title.trim()
      : (typeof payload.name === 'string' && payload.name.trim() !== '' ? payload.name.trim() : undefined)
    let result
    try {
      result = await importMidiIntoState(state, { buffer: payload.buffer, title, replace })
    } catch (error) {
      if (error instanceof MidiImportError || error?.name === 'MidiImportError') {
        return sendJson(res, 200, { ok: false, error: error.message })
      }
      throw error
    }
    return sendJson(res, 200, {
      ok: true,
      rev: state.revision,
      title: result.title,
      replace: result.replace,
      imported: result.imported,
      backupPath: result.backupPath,
      ...(result.warning ? { warning: result.warning } : {}),
      project: clientProject(),
    })
  }

  /** GET /project-versions?name= —— 列出工程版本历史（最新在前）。 */
  async function handleProjectVersions(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const requested = url.searchParams.get('name')
    const name = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : state.activeName
    if (!name) {
      return sendJson(res, 200, { ok: false, error: '当前工程还没有保存过，暂无版本历史；请先保存工程' })
    }
    const versions = await listProjectVersions(state.dataDir, name)
    return sendJson(res, 200, { ok: true, name, activeName: state.activeName, versions })
  }

  /** POST /project-versions/restore —— body {name?, id}。 */
  async function handleProjectVersionRestore(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : state.activeName
    if (!name) return sendJson(res, 200, { ok: false, error: '缺少工程名 name（当前工程未保存过，请显式传 name）' })
    if (typeof body.id !== 'string' || body.id.trim() === '') {
      return sendJson(res, 200, { ok: false, error: '缺少版本 id' })
    }
    const version = await readProjectVersion(state.dataDir, name, body.id)
    let backup = null
    let warning = null
    try {
      backup = await writeAutobackup(state.dataDir, state.project)
    } catch (error) {
      warning = `自动备份失败：${error?.message ?? error}`
    }
    state.mutate(
      {
        tool: 'studio_restore_project_version',
        text: `恢复工程「${version.name}」历史版本 ${version.id}`,
        activity: `正在恢复「${version.name}」的历史版本`,
        undoLabel: '恢复历史版本',
      },
      (draft) => ops.applyMidiProject(draft, version.project, { replace: true }),
    )
    state.setActiveProject(version.name, version.savedAt)
    return sendJson(res, 200, {
      ok: true,
      rev: state.revision,
      name: version.name,
      id: version.id,
      backupPath: backup?.path ?? null,
      ...(warning ? { warning } : {}),
      project: clientProject(),
    })
  }

  /* ── P0：健康 / 文件路径 ───────────────────────────────────────────── */

  /** GET /health。 */
  async function handleHealth(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const project = state.project
    const build = resolveBuildInfo({ fallbackVersion: version })
    return sendJson(res, 200, {
      ok: true,
      version: build.version || version,
      build,
      rev: project.revision,
      tracks: project.tracks.length,
      patterns: project.patterns.length,
    })
  }

  /** GET /project-file。 */
  async function handleProjectFile(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    return sendJson(res, 200, { path: state.filePath })
  }

  /** GET /catalog —— AI 接线信息：当前窗口/工程/数据目录 + 可用采样音色列表。 */
  async function handleCatalog(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    return sendJson(res, 200, buildAppInfo(state))
  }

  /* ── P10：渲染预览请求/回报（不写工程、不产生 revision/undo）────────── */

  /**
   * GET /preview-request?since=<seq> —— UI 轮询待处理的渲染预览请求。
   * 无待处理时返回 { ok:true, seq:<since 原值/0>, request:null }。
   */
  async function handlePreviewRequest(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const rawSince = url.searchParams.get('since')
    const since = Number.isFinite(Number(rawSince)) && Number(rawSince) >= 0 ? Math.trunc(Number(rawSince)) : 0
    const pending = peekPreviewRequest(state, since)
    return sendJson(res, 200, {
      ok: true,
      seq: pending ? pending.seq : since,
      request: pending ? pending.params : null,
    })
  }

  /**
   * POST /preview-done —— UI 回报预览渲染结果。
   * body: {seq, analysis} 或 {seq, error}；未知 seq 返回 ok:false（HTTP 200，不 500）。
   */
  /** GET /meter-request?since=<seq> —— UI 轮询待处理的实时电平测量请求。 */
  async function handleMeterRequest(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const rawSince = url.searchParams.get('since')
    const since = Number.isFinite(Number(rawSince)) && Number(rawSince) >= 0 ? Math.trunc(Number(rawSince)) : 0
    const pending = peekMeterRequest(state, since)
    return sendJson(res, 200, {
      ok: true,
      seq: pending ? pending.seq : since,
      request: pending ? { seq: pending.seq, fromBar: pending.params.fromBar, bars: pending.params.bars, revision: pending.params.revision } : null,
    })
  }

  /** POST /meter-done —— UI 回报实时电平采样/聚合结果。 */
  async function handleMeterDone(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    const seq = Number(body.seq)
    if (!Number.isInteger(seq) || seq <= 0) return sendJson(res, 200, { ok: false, error: 'seq 必须是正整数（meter 请求序号）' })
    const hasError = typeof body.error === 'string' && body.error.trim() !== ''
    const hasSamples = Array.isArray(body.samples)
    if (!hasError && !hasSamples && !isObject(body.master)) return sendJson(res, 200, { ok: false, error: '必须提供 samples（采样数组）或 error（失败原因）' })
    const completed = completeMeterRequest(state, seq, hasError ? { error: body.error.trim() } : body)
    if (!completed) return sendJson(res, 200, { ok: false, error: `未知或已超时的 meter 请求 seq=${seq}` })
    return sendJson(res, 200, { ok: true })
  }

  async function handlePreviewDone(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const body = await readJsonBody(req, jsonBodyLimit)
    const seq = Number(body.seq)
    if (!Number.isInteger(seq) || seq <= 0) {
      return sendJson(res, 200, { ok: false, error: 'seq 必须是正整数（预览请求序号）' })
    }
    const hasAnalysis = body.analysis !== undefined && body.analysis !== null
    const hasError = typeof body.error === 'string' && body.error.trim() !== ''
    if (!hasAnalysis && !hasError) {
      return sendJson(res, 200, { ok: false, error: '必须提供 analysis（渲染分析）或 error（失败原因）' })
    }
    if (hasAnalysis && !isObject(body.analysis)) {
      return sendJson(res, 200, { ok: false, error: 'analysis 必须是对象' })
    }
    const completed = completePreviewRequest(state, seq, hasError ? { error: body.error.trim() } : { analysis: body.analysis })
    if (!completed) return sendJson(res, 200, { ok: false, error: `未知或已超时的预览请求 seq=${seq}` })
    return sendJson(res, 200, { ok: true })
  }

  /* ── 分发 ──────────────────────────────────────────────────────────── */

  /** 前缀 route handler：按子路径分发。 */
  /* ── R7b：设置 / 更新检查 / 诊断 ─────────────────────────────────── */

  /** GET /settings。 */
  async function handleSettingsGet(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const settings = await loadSettings(state.dataDir)
    return sendJson(res, 200, { ok: true, settings })
  }

  /** PATCH /settings：只更新传入字段；未知字段/非法值 400。 */
  async function handleSettingsPatch(req, res) {
    if (req.method !== 'PATCH') return sendMethodNotAllowed(res, ['PATCH'])
    await state.ready
    let body
    try {
      body = await readJsonBody(req, jsonBodyLimit)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
    try {
      const settings = await saveSettings(state.dataDir, body ?? {})
      return sendJson(res, 200, { ok: true, settings })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /** GET /update-check?channel=stable|beta（本地 manifest，无网络）。 */
  async function handleUpdateCheck(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const settings = await loadSettings(state.dataDir)
    const rawChannel = url?.searchParams?.get('channel')
    const channel = typeof rawChannel === 'string' && rawChannel !== '' ? rawChannel : settings.channel
    if (!UPDATE_CHANNELS.includes(channel)) {
      return sendJson(res, 400, { ok: false, error: `channel 必须是 ${UPDATE_CHANNELS.join(' / ')}，收到「${String(channel)}」` })
    }
    try {
      const result = await checkForUpdate({ dataDir: state.dataDir, channel })
      return sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      // 损坏 manifest：返回可读错误但不崩服务
      return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /** GET /diagnostics。 */
  async function handleDiagnostics(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    const diagnostics = await collectDiagnostics({ dataDir: state.dataDir, state })
    return sendJson(res, 200, { ok: true, ...diagnostics })
  }

  /** POST /diagnostics/export：返回可下载纯文本。 */
  async function handleDiagnosticsExport(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    const diagnostics = await collectDiagnostics({ dataDir: state.dataDir, state })
    const text = exportDiagnosticsText(diagnostics)
    const body = Buffer.from(text, 'utf8')
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="ai-music-studio-diagnostics.txt"')
    res.setHeader('Content-Length', body.length)
    res.end(body)
  }

  /* ── v2.2 M1：外部 VST3 插件管理 ─────────────────────────────────── */

  const getPluginService = () => getSharedPluginService(state.dataDir)

  const pluginFailure = (res, error, status = 200) => sendJson(res, status, {
    ok: false,
    error: String(error?.message ?? error),
    ...(error?.code ? { code: error.code } : {}),
  })

  async function pluginBody(req, limit = jsonBodyLimit) {
    return readJsonBody(req, limit)
  }

  async function handleExternalPluginList(req, res) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    try {
      const service = getPluginService()
      const result = await service.list()
      return sendJson(res, 200, { ok: true, plugins: result.plugins, count: result.plugins.length, sidecar: service.status() })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginScan(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const service = getPluginService()
      const result = await service.scan({ dirs: Array.isArray(body?.dirs) ? body.dirs : [], includeDefaults: body?.includeDefaults !== false })
      return sendJson(res, 200, { ok: true, ...result, count: result.plugins.length, sidecar: service.status() })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginInstall(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const result = await getPluginService().install({ path: body?.path })
      return sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      return pluginFailure(res, error, error?.code === 'PLUGIN_INVALID_PATH' ? 400 : 200)
    }
  }

  async function handleExternalPluginUninstall(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const pluginId = String(body?.pluginId ?? '')
      const removed = await getPluginService().uninstall(pluginId)
      const affected = state.mutate(
        { tool: 'studio_remove_external_plugin', text: `卸载外部插件：${pluginId}`, activity: '正在卸载外部插件', undoLabel: '卸载外部插件' },
        (draft) => ops.markPluginMissing(draft, pluginId, true),
      )
      return sendJson(res, 200, { ok: true, ...removed, affected })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginParameters(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    try {
      const pluginId = String(url?.searchParams?.get('pluginId') ?? '')
      const result = await getPluginService().parameters(pluginId)
      return sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginSetParam(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const hasTarget = (typeof body?.trackId === 'string' && body.trackId.trim() !== '') || (typeof body?.effectId === 'string' && body.effectId.trim() !== '')
      if (!hasTarget) {
        // v2.3：保留旧 sidecar-only 调用，但标记 deprecated。
        if (typeof body?.pluginId !== 'string' || body.pluginId.trim() === '') {
          return pluginFailure(res, new Error('set-param 需要 trackId/effectId（推荐）或 pluginId（旧 sidecar-only）'))
        }
        const result = await getPluginService().setParameter({ pluginId: body.pluginId, paramId: body?.paramId, value: body?.value })
        return sendJson(res, 200, { ok: true, ...result, deprecated: true })
      }
      const mergeKey = typeof body?.mergeKey === 'string' && body.mergeKey.trim() !== '' ? body.mergeKey.trim() : undefined
      const result = state.mutate(
        { tool: 'studio_set_plugin_parameter', activity: '正在同步插件参数到工程', undoLabel: '调整插件参数', mergeKey },
        (draft) => ops.setPluginParameter(draft, body ?? {}),
      )
      try { getPluginService().noteParameterValue({ pluginId: result.pluginId, paramId: result.paramId, value: result.value }) } catch { /* ignore */ }
      return sendJson(res, 200, {
        ok: true,
        ...result,
        param: { paramId: result.paramId, value: result.value },
        revision: state.revision,
        undoLabel: '调整插件参数',
        merged: Boolean(mergeKey),
        deprecated: false,
      })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginPresets(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    try {
      const pluginIdArg = String(url?.searchParams?.get('pluginId') ?? '').trim()
      const trackId = String(url?.searchParams?.get('trackId') ?? '').trim() || null
      const effectId = String(url?.searchParams?.get('effectId') ?? '').trim() || null
      let target = null
      if (trackId || effectId) target = ops.resolvePluginTarget(state.project, { trackId, effectId })
      const pluginId = pluginIdArg || target?.pluginId || ''
      if (pluginId === '') return pluginFailure(res, new Error('presets 需要 pluginId（或 trackId/effectId）'))
      const presets = await getPluginService().listPresets({ pluginId, instanceId: target?.instanceId ?? null })
      return sendJson(res, 200, {
        ok: true,
        ...presets,
        current: target?.descriptor?.preset ?? null,
        trackId: target?.trackId ?? null,
        effectId: target?.effectId ?? null,
      })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginSelectPreset(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const target = ops.resolvePluginTarget(state.project, { trackId: body?.trackId, effectId: body?.effectId })
      const selected = await getPluginService().selectPreset({
        pluginId: target.pluginId,
        instanceId: target.instanceId,
        listId: body?.listId,
        index: body?.index,
      })
      state.mutate(
        { tool: 'studio_select_plugin_preset', activity: '正在切换插件预设', undoLabel: '选择插件预设' },
        (draft) => ops.applyPluginPreset(draft, {
          trackId: target.trackId,
          effectId: target.effectId,
          preset: selected.preset,
          params: selected.params,
          stateBase64: selected.stateBase64,
        }),
      )
      return sendJson(res, 200, {
        ok: true,
        trackId: target.trackId,
        effectId: target.effectId,
        pluginId: target.pluginId,
        listId: selected.listId,
        index: selected.index,
        preset: selected.preset,
        paramCount: Array.isArray(selected.params) ? selected.params.length : 0,
        hasStateBase64: typeof selected.stateBase64 === 'string' && selected.stateBase64 !== '',
        revision: state.revision,
        undoLabel: '选择插件预设',
      })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginStateSave(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const target = ops.resolvePluginTarget(state.project, { trackId: body?.trackId, effectId: body?.effectId })
      const saved = await getPluginService().savePluginState({ pluginId: target.pluginId, instanceId: target.instanceId })
      const stateBase64 = String(saved?.stateBase64 ?? '')
      if (stateBase64 === '') return pluginFailure(res, new Error('插件未返回 state（当前实例不可用或插件不支持 state）'))
      if (Buffer.byteLength(stateBase64, 'utf8') > 2 * 1024 * 1024) return pluginFailure(res, new Error('插件 state 超过 2MB 上限'))
      state.mutate(
        { tool: 'studio_save_plugin_state', activity: '正在保存插件状态', undoLabel: '保存插件状态' },
        (draft) => ops.applyPluginPreset(draft, { trackId: target.trackId, effectId: target.effectId, stateBase64 }),
      )
      return sendJson(res, 200, {
        ok: true,
        trackId: target.trackId,
        effectId: target.effectId,
        pluginId: target.pluginId,
        stateBase64,
        bytes: Buffer.byteLength(stateBase64, 'utf8'),
        revision: state.revision,
        undoLabel: '保存插件状态',
      })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginAutomation(req, res, url) {
    await state.ready
    try {
      const trackId = String(url?.searchParams?.get('trackId') ?? '').trim() || null
      const effectId = String(url?.searchParams?.get('effectId') ?? '').trim() || null
      const paramIdRaw = String(url?.searchParams?.get('paramId') ?? '').trim()
      const paramId = paramIdRaw === '' ? null : Number(paramIdRaw)
      if (req.method === 'GET') {
        const result = ops.getPluginAutomation(state.project, { trackId, effectId, paramId })
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'DELETE') {
        const result = state.mutate(
          { tool: 'studio_clear_plugin_automation', activity: '正在清除插件参数自动化', undoLabel: '清除插件自动化' },
          (draft) => ops.clearPluginAutomation(draft, { trackId, effectId, paramId }),
        )
        return sendJson(res, 200, { ok: true, ...result, revision: state.revision, undoLabel: '清除插件自动化' })
      }
      if (req.method !== 'POST') return sendMethodNotAllowed(res, ['GET', 'POST', 'DELETE'])
      const body = await pluginBody(req)
      const mergeKey = typeof body?.mergeKey === 'string' && body.mergeKey.trim() !== '' ? body.mergeKey.trim() : undefined
      const result = state.mutate(
        { tool: 'studio_set_plugin_automation', activity: '正在编辑插件参数自动化', undoLabel: '编辑插件自动化', mergeKey },
        (draft) => ops.setPluginAutomation(draft, body ?? {}),
      )
      return sendJson(res, 200, { ok: true, ...result, revision: state.revision, undoLabel: '编辑插件自动化', merged: Boolean(mergeKey) })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginAutomationClear(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const result = state.mutate(
        { tool: 'studio_clear_plugin_automation', activity: '正在清除插件参数自动化', undoLabel: '清除插件自动化' },
        (draft) => ops.clearPluginAutomation(draft, body ?? {}),
      )
      return sendJson(res, 200, { ok: true, ...result, revision: state.revision, undoLabel: '清除插件自动化' })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginState(req, res, url) {
    await state.ready
    try {
      if (req.method === 'GET') {
        const trackId = String(url?.searchParams?.get('trackId') ?? '').trim() || null
        const effectId = String(url?.searchParams?.get('effectId') ?? '').trim() || null
        return sendJson(res, 200, { ok: true, ...ops.getPluginState(state.project, { trackId, effectId }) })
      }
      if (req.method !== 'POST') return sendMethodNotAllowed(res, ['GET', 'POST'])
      const body = await pluginBody(req, PLUGIN_STATE_BODY_LIMIT)
      const target = ops.resolvePluginTarget(state.project, { trackId: body?.trackId, effectId: body?.effectId })
      const rawState = typeof body?.stateBase64 === 'string' ? body.stateBase64.trim() : ''
      if (rawState === '') return pluginFailure(res, new Error('stateBase64 不能为空'))
      if (Buffer.byteLength(rawState, 'utf8') > 2 * 1024 * 1024) return pluginFailure(res, new Error('stateBase64 超过 2MB 上限'))
      let loadedParams = null
      const warnings = []
      try {
        const loaded = await getPluginService().loadPluginState({ pluginId: target.pluginId, instanceId: target.instanceId, stateBase64: rawState })
        loadedParams = loaded.params ?? null
      } catch (error) {
        warnings.push(String(error?.message ?? error))
      }
      state.mutate(
        { tool: 'studio_set_plugin_state', activity: '正在载入插件状态', undoLabel: '载入插件状态' },
        (draft) => ops.applyPluginPreset(draft, { trackId: target.trackId, effectId: target.effectId, stateBase64: rawState, params: loadedParams }),
      )
      return sendJson(res, 200, {
        ok: true,
        trackId: target.trackId,
        effectId: target.effectId,
        pluginId: target.pluginId,
        revision: state.revision,
        bytes: Buffer.byteLength(rawState, 'utf8'),
        paramsSynced: Array.isArray(loadedParams),
        paramsCount: Array.isArray(loadedParams) ? loadedParams.length : 0,
        warnings,
        undoLabel: '载入插件状态',
      })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginAddTrack(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const service = getPluginService()
      const plugin = await service.getPlugin(String(body?.pluginId ?? ''))
      if (!plugin) return pluginFailure(res, new Error(`插件不存在：${String(body?.pluginId ?? '')}；请先 scan/install`))
      if (plugin.missing) return pluginFailure(res, new Error(`插件内容缺失：${plugin.pluginId}；请重新安装后再添加`))
      if (!plugin.isInstrument) return pluginFailure(res, new Error(`插件 ${plugin.pluginId} 不是 instrument（category=${plugin.category}）`))
      const vst3 = {
        pluginId: plugin.pluginId,
        name: plugin.name,
        vendor: plugin.vendor,
        version: plugin.version,
        category: plugin.category,
        subCategories: plugin.subCategories ?? '',
        classId: plugin.classId,
        kind: plugin.isInstrument ? 'instrument' : 'effect',
        isInstrument: plugin.isInstrument === true,
        midiInputs: 0,
        params: {},
        stateBase64: null,
        bypass: false,
        missing: false,
      }
      const result = state.mutate(
        { tool: 'studio_add_plugin_track', text: `添加 VST3 乐器轨：${plugin.name}`, activity: '正在添加 VST3 乐器轨', undoLabel: '添加 VST3 乐器轨' },
        (draft) => ops.addTrack(draft, { kind: 'synth', engine: 'vst3', vst3, ...(typeof body?.name === 'string' && body.name.trim() !== '' ? { name: body.name.trim() } : {}) }),
      )
      return sendJson(res, 200, { ok: true, trackId: result.trackId, track: result.track })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginAddEffect(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const service = getPluginService()
      const plugin = await service.getPlugin(String(body?.pluginId ?? ''))
      if (!plugin) return pluginFailure(res, new Error(`插件不存在：${String(body?.pluginId ?? '')}；请先 scan/install`))
      if (plugin.missing) return pluginFailure(res, new Error(`插件内容缺失：${plugin.pluginId}；请重新安装后再添加`))
      if (!plugin.isEffect) return pluginFailure(res, new Error(`插件 ${plugin.pluginId} 不是 effect（category=${plugin.category}）`))
      const vst3 = {
        pluginId: plugin.pluginId,
        name: plugin.name,
        vendor: plugin.vendor,
        version: plugin.version,
        category: plugin.category,
        subCategories: plugin.subCategories ?? '',
        classId: plugin.classId,
        kind: plugin.isInstrument ? 'instrument' : 'effect',
        isInstrument: plugin.isInstrument === true,
        midiInputs: 0,
        params: {},
        stateBase64: null,
        bypass: false,
        missing: false,
      }
      const trackId = String(body?.trackId ?? '')
      const result = state.mutate(
        { tool: 'studio_add_plugin_effect', text: `添加 VST3 效果器：${plugin.name}`, activity: '正在添加 VST3 效果器', undoLabel: '添加 VST3 效果器' },
        (draft) => ops.addEffect(draft, { target: trackId, type: 'vst3', vst3 }),
      )
      return sendJson(res, 200, { ok: true, effectId: result.effectId, trackId, chain: result.chain })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handleExternalPluginBypass(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req)
      const result = state.mutate(
        { tool: 'studio_plugin_bypass', text: '设置 VST3 旁路', undoLabel: '设置 VST3 旁路' },
        (draft) => ops.setVst3Bypass(draft, {
          bypass: body?.bypass === undefined ? true : body.bypass,
          ...(typeof body?.trackId === 'string' && body.trackId !== '' ? { trackId: body.trackId } : {}),
          ...(typeof body?.effectId === 'string' && body.effectId !== '' ? { effectId: body.effectId } : {}),
        }),
      )
      return sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  /* ── v2.2 M4：外部插件冻结（UI/audio 共用路由） ─────────────────── */

  async function handlePluginFreeze(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      // inputPcm（engine.freezeTrackAudio 干声）可能数 MB，冻结路由单独放宽 JSON body 上限。
      const body = await pluginBody(req, PLUGIN_FREEZE_BODY_LIMIT)
      const trackId = String(body?.trackId ?? '')
      const effectId = body?.effectId === undefined || body?.effectId === null || body.effectId === '' ? null : String(body.effectId)
      if (trackId === '') return pluginFailure(res, new Error('freeze 需要 trackId'))
      const service = getPluginService()
      const frozen = await freezeTarget({
        dataDir: state.dataDir,
        project: state.project,
        trackId,
        effectId,
        service,
        inputPcm: Array.isArray(body?.inputPcm) ? body.inputPcm : null,
        bars: body?.bars,
      })
      state.mutate(
        { tool: 'studio_freeze_plugin_track', text: '冻结外部插件：' + trackId, activity: '正在写入插件冻结缓存', undoLabel: '冻结外部插件' },
        (draft) => setFreezeOnProject(draft, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, trackStateBase64: frozen.trackStateBase64, effectStates: frozen.effectStates }),
      )
      return sendJson(res, 200, {
        ok: true,
        trackId,
        effectId,
        frozen: true,
        status: 'current',
        hash: frozen.freeze.hash,
        mediaId: frozen.freeze.mediaId,
        cacheFile: frozen.freeze.cacheFile,
        cacheUrl: '/studio/api/media/' + frozen.mediaEntry.file,
        bars: frozen.freeze.bars,
        frames: frozen.freeze.frames,
        sampleRate: frozen.freeze.sampleRate,
        latencySamples: frozen.freeze.latencySamples,
        createdAt: frozen.freeze.createdAt,
        includesFx: frozen.freeze.includesFx === true,
        pluginId: frozen.result?.pluginId ?? null,
        effectIds: frozen.effectIds ?? [],
        stateSaved: Boolean(frozen.trackStateBase64 || frozen.stateBase64),
      })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handlePluginUnfreeze(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req, FREEZE_JSON_BODY_LIMIT)
      const trackId = String(body?.trackId ?? '')
      if (trackId === '') return pluginFailure(res, new Error('unfreeze 需要 trackId'))
      const track = state.project.tracks.find((item) => item.id === trackId)
      if (!track) return pluginFailure(res, new Error('轨道不存在：' + trackId))
      const freeze = track.freeze
      if (!freeze) return sendJson(res, 200, { ok: true, trackId, removed: false })
      state.mutate(
        { tool: 'studio_unfreeze_plugin_track', text: '解冻外部插件：' + trackId, activity: '正在解除插件冻结', undoLabel: '解冻外部插件' },
        (draft) => {
          const draftTrack = draft.tracks.find((item) => item.id === trackId)
          if (draftTrack) delete draftTrack.freeze
          if (freeze.mediaId && Array.isArray(draft.media)) draft.media = draft.media.filter((item) => item.id !== freeze.mediaId)
        },
      )
      if (freeze.cacheFile) {
        const { rm } = await import('node:fs/promises')
        await rm(String(state.dataDir) + '/plugin-cache/' + String(freeze.cacheFile).replace(/^.*[\\/]/, ''), { force: true }).catch(() => {})
      }
      return sendJson(res, 200, { ok: true, trackId, removed: true })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handlePluginFreezeStatus(req, res, url) {
    if (req.method !== 'GET') return sendMethodNotAllowed(res, ['GET'])
    await state.ready
    try {
      const trackId = url?.searchParams?.get('trackId') ?? null
      const effectId = url?.searchParams?.get('effectId') ?? null
      const result = getFreezeStatus(state.project, { trackId: trackId || null, effectId: effectId || null, dataDir: state.dataDir })
      return sendJson(res, 200, { ok: true, tracks: result.items, items: result.items, counts: result.counts })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handlePluginSaveState(req, res) {
    if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST'])
    await state.ready
    try {
      const body = await pluginBody(req, FREEZE_JSON_BODY_LIMIT)
      const trackId = String(body?.trackId ?? '')
      const effectId = body?.effectId === undefined || body?.effectId === null || body.effectId === '' ? null : String(body.effectId)
      const stateBase64 = typeof body?.stateBase64 === 'string' ? body.stateBase64 : ''
      if (trackId === '' || stateBase64 === '') return pluginFailure(res, new Error('plugin-state 需要 trackId 与 stateBase64'))
      const updated = state.mutate(
        { tool: 'studio_plugin_save_state', text: '保存插件状态', undoLabel: '保存插件状态' },
        (draft) => {
          const track = draft.tracks.find((item) => item.id === trackId)
          if (!track) throw new Error('轨道不存在：' + trackId)
          const target = effectId === null ? track : (track.effects ?? []).find((fx) => fx.id === effectId && fx.type === 'vst3')
          if (!target || !target.vst3) throw new Error('找不到 VST3 插件：' + trackId + (effectId ? '/' + effectId : ''))
          target.vst3.stateBase64 = stateBase64
          return { trackId, effectId }
        },
      )
      return sendJson(res, 200, { ok: true, ...updated })
    } catch (error) {
      return pluginFailure(res, error)
    }
  }

  async function handler(req, res) {
    try {
      setCommonHeaders(res)
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
      const url = new URL(req.url ?? API_PREFIX, 'http://127.0.0.1')
      if (!url.pathname.startsWith(API_PREFIX)) {
        return sendJson(res, 404, { ok: false, error: `未知接口 ${url.pathname}` })
      }
      let subpath = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '')
      if (subpath === '') subpath = '/'
      // P3b：/media/<file> 是动态子路径，先于 switch 处理。
      if (subpath.startsWith('/media/')) {
        return await handleMedia(req, res, url, subpath.slice('/media/'.length))
      }
      switch (subpath) {
        // P0
        case '/state':
          return await handleState(req, res, url)
        case '/action':
          return await handleAction(req, res)
        case '/export-done':
          return await handleExportDone(req, res, url)
        case '/export-claim':
          return await handleExportClaim(req, res)
        // R0A 导出任务状态
        case '/export-error':
          return await handleExportError(req, res)
        case '/export-status':
          return await handleExportStatus(req, res, url)
        case '/health':
          return await handleHealth(req, res)
        // R1a 性能指标
        case '/metrics':
          return await handleMetrics(req, res)
        case '/catalog':
          return await handleCatalog(req, res)
        case '/project-file':
          return await handleProjectFile(req, res)
        // P1 编辑 + 历史
        case '/edit':
          return await handleEdit(req, res)
        case '/history':
          return await handleHistory(req, res)
        case '/history/undo':
          return await handleUndo(req, res)
        case '/history/redo':
          return await handleRedo(req, res)
        // P1 工程管理
        case '/projects':
          return await handleProjectsList(req, res)
        case '/projects/new':
          return await handleProjectNew(req, res)
        case '/projects/save':
          return await handleProjectSave(req, res)
        case '/projects/open':
          return await handleProjectOpen(req, res)
        case '/projects/delete':
          return await handleProjectDelete(req, res)
        case '/plugins':
          return await handlePluginsList(req, res, url)
        // v2.2 M1 外部 VST3 插件
        case '/plugins/external':
        case '/plugins/external/list':
          return await handleExternalPluginList(req, res)
        case '/plugins/external/scan':
          return await handleExternalPluginScan(req, res)
        case '/plugins/external/install':
          return await handleExternalPluginInstall(req, res)
        case '/plugins/external/uninstall':
          return await handleExternalPluginUninstall(req, res)
        case '/plugins/external/parameters':
          return await handleExternalPluginParameters(req, res, url)
        case '/plugins/external/set-param':
          return await handleExternalPluginSetParam(req, res)
        case '/plugins/external/presets':
        case '/plugins/external/programs':
          return await handleExternalPluginPresets(req, res, url)
        case '/plugins/external/select-preset':
          return await handleExternalPluginSelectPreset(req, res)
        case '/plugins/external/plugin-automation':
          return await handleExternalPluginAutomation(req, res, url)
        case '/plugins/external/plugin-automation/clear':
          return await handleExternalPluginAutomationClear(req, res)
        case '/plugins/external/state/save':
          return await handleExternalPluginStateSave(req, res)
        case '/plugins/external/state':
        case '/plugins/external/plugin-state':
          return await handleExternalPluginState(req, res, url)

        case '/plugins/external/add-track':
          return await handleExternalPluginAddTrack(req, res)
        case '/plugins/external/add-effect':
          return await handleExternalPluginAddEffect(req, res)
        case '/plugins/external/bypass':
          return await handleExternalPluginBypass(req, res)
        case '/plugin-freeze':
        case '/plugins/external/freeze':
          return await handlePluginFreeze(req, res)
        case '/plugin-unfreeze':
        case '/plugins/external/unfreeze':
          return await handlePluginUnfreeze(req, res)
        case '/plugin-freeze-status':
        case '/plugins/external/freeze-status':
          return await handlePluginFreezeStatus(req, res, url)
        case '/plugin-state':
        case '/plugins/external/state':
          return await handlePluginSaveState(req, res)
        case '/ai-changes':
          return await handleAiChanges(req, res, url)
        // R7b 设置/更新检查/诊断
        case '/settings':
          if (req.method === 'PATCH') return await handleSettingsPatch(req, res)
          return await handleSettingsGet(req, res)
        case '/update-check':
          return await handleUpdateCheck(req, res, url)
        case '/diagnostics':
          return await handleDiagnostics(req, res)
        case '/diagnostics/export':
          return await handleDiagnosticsExport(req, res)
        // P1 MIDI / 下载
        case '/export-midi':
          return await handleExportMidi(req, res)
        case '/download':
          return await handleDownload(req, res, url)
        // P3b 音频导入 / 媒体
        case '/import-audio':
          return await handleImportAudio(req, res, url)
        // P14a MIDI 导入 / 工程版本历史
        case '/import-midi':
          return await handleImportMidi(req, res, url)
        case '/project-versions':
          return await handleProjectVersions(req, res, url)
        case '/project-versions/restore':
          return await handleProjectVersionRestore(req, res)
        // P10 渲染预览请求/回报
        case '/preview-request':
          return await handlePreviewRequest(req, res, url)
        case '/preview-done':
          return await handlePreviewDone(req, res)
        case '/meter-request':
          return await handleMeterRequest(req, res, url)
        case '/meter-done':
          return await handleMeterDone(req, res)
        default:
          return sendJson(res, 404, {
            ok: false,
            error:
              `未知接口 ${API_PREFIX}${subpath}；可用：GET /state、POST /action、POST /export-done、` +
              'POST /edit、POST /history/undo|redo、GET /history、GET /projects、POST /projects/new|save|open|delete、' +
              'POST /export-midi、GET /download、GET /health、GET /catalog、GET /project-file、POST /import-audio、GET /media/<file>、' +
              'GET /preview-request、POST /preview-done、POST /import-midi、GET /project-versions、POST /project-versions/restore、GET /plugins、GET /ai-changes、GET/PATCH /settings、GET /update-check、GET /diagnostics、POST /diagnostics/export、' +
              'POST /export-error、GET /export-status、GET /metrics',
          })
      }
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(res, error.status, { ok: false, error: error.message })
      }
      // 业务校验错误统一 HTTP 200 + ok:false（与工具风格一致）
      if (error?.name === 'OpError' || error instanceof ProjectError) {
        return sendJson(res, 200, { ok: false, error: error.message })
      }
      return sendJson(res, 500, {
        ok: false,
        error: `音乐工作室服务器内部错误：${error?.message ?? String(error)}`,
      })
    }
  }

  return [{ kind: 'prefix', path: API_PREFIX, handler }]
}

