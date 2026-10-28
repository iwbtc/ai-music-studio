/**
 * AI 音乐工作室 — 面板主体（DSH 插件与独立窗口共用）。
 *
 * 负责：轮询 `/studio/api/state`、把 AI 命令（transport/exportRequest）转成引擎动作、
 * 把 UI 操作 POST 回后端、导出离线 WAV、渲染整个 StudioApp。
 *
 * 该文件不 import 任何 DSH 包，因此也能被打进独立窗口的 IIFE bundle。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StudioApp } from './App.jsx'
import { StudioEngine } from './audio/engine.js'
import { analyzeAudioBuffer, peakNormalizeGain } from './audio/analysis.js'
import { encodeWav } from './audio/wav.js'
import { audioFormatExtension, audioFormatMime, encodeFlac, encodeMp3 } from './audio/encode.js'
import { beatsPerBar } from '../shared/model.js'
import { createTempoMap } from '../shared/tempo.js'
import styles from './styles.css'

/** 面板样式文本（CSS 文件被 esbuild 以 text 形式内联）。 */
export const panelStyles = styles

/**
 * 注入面板样式（幂等）。返回清理函数。
 * @returns {() => void}
 */
export function injectPanelStyles() {
  if (typeof document === 'undefined') return () => {}
  const selector = 'style[data-plugin="ai-music-studio"]'
  if (document.querySelector(selector)) return () => {}
  const el = document.createElement('style')
  el.setAttribute('data-plugin', 'ai-music-studio')
  el.textContent = styles
  document.head.append(el)
  return () => {
    el.remove()
  }
}

const TEXT = {
  loading: '正在连接音乐工作室…',
  hostError: '无法连接音乐工作室后端（服务未启动或正在重启）',
  retry: '重试',
}

/* ── P10：导出 / 预览辅助 ── */

const pad2 = (value) => String(value).padStart(2, '0')

/** 本地时间戳 YYYYMMDD-HHmmss（导出文件名用）。 */
function exportTimestamp(now = new Date()) {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
}

/** 文件 base 名清理：去掉路径/非法字符，保留中英文与空格。 */
function sanitizeFileBase(raw, fallback = 'ai-music') {
  const safe = String(raw ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 80)
  return safe || fallback
}

/** request.name → 安全 .wav 文件名（自动补 .wav）。 */
function ensureWavName(rawName, fallbackBase) {
  const base = sanitizeFileBase(rawName, fallbackBase || 'ai-music')
  return /\.wav$/i.test(base) ? base : `${base}.wav`
}

/** request.name → 指定音频扩展名的安全文件名。 */
function ensureAudioName(rawName, format, fallbackBase) {
  let ext = 'wav'
  try { ext = audioFormatExtension(format) } catch (err) { ext = 'wav' }
  const base = sanitizeFileBase(rawName, fallbackBase || 'ai-music').replace(/\.(wav|mp3|flac|ogg)$/i, '')
  return `${base}.${ext}`
}

/** 合并通道样本 + 峰值（从 AudioBuffer 读写）。 */
function channelsOfAudioBuffer(audioBuffer) {
  const channels = []
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    channels.push(audioBuffer.getChannelData(channel))
  }
  return channels
}

function peakOfChannels(channels) {
  let peak = 0
  for (const data of channels) {
    for (let i = 0; i < data.length; i += 1) {
      const abs = Math.abs(data[i])
      if (abs > peak) peak = abs
    }
  }
  return peak
}

/** 每小节秒数（exportRequest.tailSeconds → tailBars 换算）。 */
function secondsPerBarOf(project) {
  const barBeats = Number(project?.timeSignature?.[0]) > 0 ? Number(project.timeSignature[0]) : 4
  const bpm = Number(project?.bpm) > 0 ? Number(project.bpm) : 128
  return (barBeats * 60) / bpm
}

/** tailSeconds（0..8）→ 需要补的小节数。 */
function tailBarsOf(project, tailSeconds) {
  const tail = Math.max(0, Math.min(8, Number(tailSeconds) || 0))
  if (tail <= 0) return 0
  return Math.ceil(tail / secondsPerBarOf(project))
}

/** 克隆工程并延长 lengthBars，给混响/延迟尾音留空间。 */
function buildRenderProject(project, tailBars) {
  if (!tailBars) return project
  return {
    ...project,
    lengthBars: Math.max(1, Math.round(Number(project?.lengthBars) || 1) + tailBars),
  }
}

/** exportRequest 中的 fromBar/toBar 转成 renderWav opts（toBar 含 tail）。 */
function renderOptsOf(request, tailBars) {
  const opts = {}
  const fromBar = Number(request?.fromBar)
  const toBar = Number(request?.toBar)
  if (Number.isFinite(fromBar) && fromBar > 0) opts.fromBar = fromBar
  if (Number.isFinite(toBar) && toBar > 0) opts.toBar = toBar + (tailBars || 0)
  return Object.keys(opts).length > 0 ? opts : undefined
}

/** v2.1：桌面窗口被遮挡/最小化或渲染过慢时给出可行动的中文提示。 */
function previewErrorMessage(error) {
  const raw = String(error?.message ?? error ?? '').trim()
  if (/timeout|timed out|超时|ETIMEDOUT|aborted/i.test(raw)) {
    return '预览超时：请保持应用窗口可见（不要最小化/被遮挡）后重试；大段预览可缩小小节范围或使用快速模式'
  }
  if (/音色库|soundfont|sf2|decode|decodeAudioData/i.test(raw)) {
    return '预览音频解析失败：请重试；若持续失败可重启应用重新加载音色库（' + raw + '）'
  }
  return raw || '预览渲染失败，请重试'
}

/**
 * v2.1：AI 发起的 silent 导出默认不触发浏览器下载；手动导出仍下载。
 * - options 非空 = 手动导出（菜单/按钮），默认 download。
 * - AI exportRequest 只有显式 download:true 才下载；silent:true 强制静默。
 */
function exportDownloadPolicy(options, request) {
  const manual = options !== null && options !== undefined
  if (manual) return options.download !== false
  if (request?.silent === true) return false
  return request?.download === true
}

/** v2.1：仅当 host exportRequest 明确带 claim 字段时调用 claim，避免旧 host 404 console 噪音。 */
function requestSupportsExportClaim(request) {
  if (!request || typeof request !== 'object') return false
  return Boolean(
    Object.prototype.hasOwnProperty.call(request, 'claimedBy')
    || request.claimable === true
    || request.claimRequired === true
    || request.claimSupported === true,
  )
}

/** v2.1：多客户端导出 claim；旧 host 无此路由（404）时继续本地渲染。 */
async function claimExportJob(jobId, clientId) {
  if (!jobId) return { claimed: true, supported: false }
  try {
    const res = await fetch('/studio/api/export-claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, clientId }),
    })
    if (res.status === 404 || res.status === 405) return { claimed: true, supported: false }
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.ok === false) {
      if (res.status === 409 || data?.claimed === false) {
        return { claimed: false, supported: true, claimedBy: data?.claimedBy ?? null, error: data?.error ?? '' }
      }
      return { claimed: true, supported: false, error: data?.error || `claim HTTP ${res.status}` }
    }
    return { claimed: data?.claimed !== false, supported: true, claimedBy: data?.claimedBy ?? null }
  } catch (error) {
    // 网络/旧 host：不因 claim 失败阻断导出
    return { claimed: true, supported: false, error: String(error?.message ?? error) }
  }
}

/** Blob(WAV) → AudioBuffer（导出 normalize / 预览分析共用）。 */
async function decodeWavBlob(blob) {
  const Ctor = typeof window !== 'undefined'
    ? (window.OfflineAudioContext || window.webkitOfflineAudioContext || window.AudioContext || window.webkitAudioContext)
    : null
  if (!Ctor) throw new Error('当前环境不支持音频解码')
  const ctx = new Ctor(1, 1, 44100)
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer())
  } finally {
    try { await ctx.close?.() } catch (err) { /* ignore */ }
  }
}

/** 就近峰值归一化：返回缩放后的 WAV Blob；无需/无法缩放时返回 null。 */
function normalizeWavBlob(audioBuffer) {
  if (!audioBuffer) return null
  const channels = []
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    channels.push(audioBuffer.getChannelData(channel))
  }
  const gain = peakNormalizeGain(channels, 0.98)
  if (!Number.isFinite(gain) || gain <= 0 || Math.abs(gain - 1) < 1e-4) return null
  for (const data of channels) {
    for (let i = 0; i < data.length; i += 1) data[i] *= gain
  }
  const result = encodeWav(audioBuffer)
  return result instanceof Blob ? result : new Blob([result], { type: 'audio/wav' })
}

/** 轮询后端状态：长轮询，有变更立即返回；网络失败后退避重试。 */
function useStudioState() {
  const [project, setProject] = useState(null)
  const [hostError, setHostError] = useState(false)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    let disposed = false
    let controller = null
    let rev = 0

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    const loop = async () => {
      while (!disposed) {
        controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 30000)
        try {
          const res = await fetch(`/studio/api/state?rev=${rev}`, {
            signal: controller.signal,
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          clearTimeout(timer)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          if (disposed) return
          if (data?.changed && data.project) {
            rev = data.project.revision ?? rev
            setProject(data.project)
            setHostError(false)
          } else {
            if (typeof data?.rev === 'number') rev = data.rev
            setHostError(false)
          }
        } catch {
          clearTimeout(timer)
          if (disposed) return
          setHostError(true)
          await sleep(1800)
        }
      }
    }

    loop()
    return () => {
      disposed = true
      try {
        controller?.abort()
      } catch {}
    }
  }, [retryTick])

  return { project, hostError, retry: () => setRetryTick((x) => x + 1) }
}

/**
 * 面板主体：后端桥 + StudioApp。
 * @param {{ showHeaderBadge?: boolean }} [props]
 */
export function StudioPanel(props = {}) {
  const { project, hostError, retry } = useStudioState()
  const engineRef = useRef(null)
  const [audioUnlocked, setAudioUnlocked] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportPhase, setExportPhase] = useState('')
  const [toast, setToast] = useState(null)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' })
  const [projectInfo, setProjectInfo] = useState({ name: '', activeSavedAt: null })
  const lastCmdSeq = useRef(0)
  const lastExportSeq = useRef(0)
  const exportClientIdRef = useRef(`ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
  const firstProjectRef = useRef(true)
  const projectRef = useRef(null)
  projectRef.current = project

  // 引擎单例
  if (engineRef.current === null) engineRef.current = new StudioEngine()

  useEffect(() => () => {
    try {
      engineRef.current?.dispose()
    } catch {}
    engineRef.current = null
  }, [])

  // 项目变化 → 同步给引擎
  useEffect(() => {
    if (!project || !engineRef.current) return
    try {
      engineRef.current.setProject(project)
    } catch (error) {
      console.warn('[ai-music-studio] setProject failed', error)
    }
  }, [project])

  const showToast = useCallback((text) => {
    setToast(text)
    setTimeout(() => setToast(null), 4200)
  }, [])

  /** 统一 JSON 请求：成功返回 payload，失败抛错（带后端中文原因）。 */
  const requestJson = useCallback(async (url, options = {}) => {
    const res = await fetch(url, {
      cache: 'no-store',
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        accept: 'application/json',
        ...(options.headers ?? {}),
      },
    })
    let payload = null
    try {
      payload = await res.json()
    } catch {
      throw new Error(`后端返回异常（HTTP ${res.status}）`)
    }
    if (!res.ok) throw new Error(payload?.error || `请求失败（HTTP ${res.status}）`)
    if (payload && payload.ok === false) throw new Error(payload.error || '操作失败')
    return payload
  }, [])

  /** 刷新撤销/重做状态与当前工程信息（编辑后调用，轻量）。 */
  const refreshMeta = useCallback(async () => {
    try {
      const [hist, info] = await Promise.all([
        requestJson('/studio/api/history'),
        requestJson('/studio/api/projects'),
      ])
      setHistory({
        canUndo: Boolean(hist?.canUndo),
        canRedo: Boolean(hist?.canRedo),
        undoLabel: hist?.undoLabel ?? '',
        redoLabel: hist?.redoLabel ?? '',
      })
      setProjectInfo({ name: info?.activeName ?? '', activeSavedAt: info?.activeSavedAt ?? null })
    } catch {
      /* 元信息刷新失败不打断编辑 */
    }
  }, [requestJson])

  // 工程 revision 变化（AI 或 UI 改动）后刷新元信息
  useEffect(() => {
    if (!project) return
    refreshMeta()
  }, [project?.revision, refreshMeta])

  // AI 的播放/停止/跳转命令（transport.cmd.seq 变化时只执行一次）。
  // 首次加载工程时只记录当前 seq，避免把历史命令重放（重新打开面板不自动播放）。
  useEffect(() => {
    const cmd = project?.transport?.cmd
    if (firstProjectRef.current) {
      firstProjectRef.current = false
      lastCmdSeq.current = cmd?.seq ?? 0
      return
    }
    if (!cmd || typeof cmd.seq !== 'number' || cmd.seq === lastCmdSeq.current) return
    lastCmdSeq.current = cmd.seq
    const engine = engineRef.current
    if (!engine) return
    try {
      if (cmd.action === 'play') {
        if (typeof cmd.positionBar === 'number') engine.play(cmd.positionBar)
        else engine.play()
      } else if (cmd.action === 'stop') {
        engine.stop()
      } else if (cmd.action === 'seek') {
        engine.seek(Number(cmd.positionBar) || 0)
      }
    } catch (error) {
      console.warn('[ai-music-studio] transport command failed', error)
    }
  }, [project?.transport?.cmd?.seq])

  // 导出：离线渲染 → 可选 normalize/targetLufs → WAV/MP3/FLAC 编码 → 下载 + 回传后端
  // P14b：支持 mp3/flac、targetLufs；分轨仍为 WAV。
  // R0：AI 导出 jobId → 轮询 /export-status，成功/失败有回执；同名导出显示最终文件名。
  const doExport = useCallback(async (options = null) => {
    const engine = engineRef.current
    const current = projectRef.current
    if (!engine || !current || exporting) return
    setExporting(true)
    const request = current.exportRequest ?? null
    const jobId = request?.jobId ?? options?.jobId ?? null
    let statusTimer = null
    const stopStatusPolling = () => {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
    }
    /** 其他客户端已 claim：只等待结果，不重复渲染；超时返回 'timeout' 由本端补渲染。 */
    const waitForClaimedExport = async (timeoutMs = 15000) => {
      setExportPhase('另一客户端正在导出，等待结果…')
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`/studio/api/export-status?jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' })
          if (res.ok) {
            const payload = await res.json().catch(() => null)
            const job = payload?.job ?? payload ?? null
            const status = String(job?.status ?? payload?.status ?? '').toLowerCase()
            if (status === 'success') {
              const finalPath = typeof job?.path === 'string' ? job.path : ''
              const finalName = (typeof job?.name === 'string' && job.name) || (finalPath ? finalPath.split(/[\\/]/).pop() : '') || '导出文件'
              setExportPhase(finalName)
              showToast(`导出完成（由另一客户端渲染）：${finalName}${finalPath ? ` → ${finalPath}` : ''}`, 'info')
              return 'success'
            }
            if (status === 'error') {
              throw new Error(String(job?.error ?? payload?.error ?? '另一客户端导出失败'))
            }
          }
        } catch (err) {
          if (err && !/HTTP|fetch|network|Failed/i.test(String(err.message ?? ''))) throw err
        }
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
      return 'timeout'
    }
    try {
      const manualExport = options !== null && options !== undefined
      const jobIdForClaim = request?.jobId ?? options?.jobId ?? null
      const shouldDownload = exportDownloadPolicy(options, request)
      if (!manualExport && jobIdForClaim && requestSupportsExportClaim(request)) {
        const claim = await claimExportJob(jobIdForClaim, exportClientIdRef.current)
        if (claim.claimed === false) {
          const outcome = await waitForClaimedExport(15000)
          if (outcome !== 'timeout') return
          // claim 持有者长时间未完成：本端补渲染，避免导出永久挂起（仍保持 silent）。
          setExportPhase('其他客户端未响应，本端补渲染…')
          showToast('另一个客户端未完成导出，已由本端继续渲染', 'info')
        }
      }
      if (jobId) {
        const pollStatus = async () => {
          try {
            const res = await fetch(`/studio/api/export-status?jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' })
            if (!res.ok) return
            const payload = await res.json().catch(() => null)
            const job = payload?.job ?? payload ?? null
            const status = String(job?.status ?? payload?.status ?? '').toLowerCase()
            if (status === 'rendering' || status === 'pending') setExportPhase('AI 导出任务：渲染中…')
            else if (status === 'success') setExportPhase('AI 导出任务：已完成')
            else if (status === 'error') setExportPhase('AI 导出任务：失败')
          } catch (err) { /* 轮询失败不影响本地渲染 */ }
        }
        setExportPhase('AI 导出任务：准备中…')
        statusTimer = setInterval(pollStatus, 800)
        pollStatus()
      } else {
        setExportPhase('正在离线渲染…')
      }
      const rawFormat = String(options?.format ?? request?.format ?? 'wav').toLowerCase()
      const format = rawFormat === 'mp3' || rawFormat === 'flac' ? rawFormat : 'wav'
      const tailSeconds = options?.tailSeconds ?? request?.tailSeconds
      const tailBars = tailBarsOf(current, tailSeconds)
      const renderProject = buildRenderProject(current, tailBars)
      const requestedNormalize = (options?.normalize ?? request?.normalize) === true
      const rawTargetLufs = options?.targetLufs ?? request?.targetLufs
      const targetLufs = rawTargetLufs === undefined || rawTargetLufs === null ? null : Number(rawTargetLufs)
      if (targetLufs !== null && (!Number.isFinite(targetLufs) || targetLufs < -24 || targetLufs > -5)) {
        throw new Error('目标 LUFS 必须在 −24 到 −5 之间')
      }
      const hadBoth = requestedNormalize && targetLufs !== null
      const normalize = requestedNormalize && targetLufs === null
      const slug = sanitizeFileBase(current.title || 'ai-music', 'ai-music').replace(/\s+/g, '-').slice(0, 60)
      const timestamp = exportTimestamp()
      const ext = format === 'wav' ? 'wav' : audioFormatExtension(format)
      const mime = format === 'wav' ? 'audio/wav' : audioFormatMime(format)
      const fallbackName = `${slug}-${timestamp}.${ext}`
      const requestedName = options?.name ?? request?.name
      const name = requestedName ? ensureAudioName(requestedName, format, fallbackName) : fallbackName
      const targetNote = targetLufs !== null ? ` · 目标 ${targetLufs} LUFS` : normalize ? ' · 已归一化' : ''
      setExportPhase('正在离线渲染…')
      showToast(`正在离线渲染 ${format.toUpperCase()}…${tailBars ? `（含 ${Number(tailSeconds) || 0}s 尾音）` : ''}${targetNote}`)
      const { blob: rawBlob, seconds } = await engine.renderWav(renderProject, renderOptsOf(request, tailBars))
      // v2.1：始终解码一次，用于导出响度/峰值回传（achievedLufs/peak/truePeak）。
      let audioBuffer = null
      try {
        audioBuffer = await decodeWavBlob(rawBlob)
      } catch (decodeError) {
        audioBuffer = null
      }
      setExportPhase(format === 'wav' ? '正在处理音频…' : `正在编码 ${format.toUpperCase()}…`)
      let achievedLufs = null
      let exportMetrics = null
      if (audioBuffer && targetLufs !== null) {
        if (typeof engine.applyTargetLufs === 'function') {
          exportMetrics = engine.applyTargetLufs(audioBuffer, targetLufs, { peakCeiling: 0.98 })
          const measured = Number(exportMetrics?.achievedLufs)
          achievedLufs = Number.isFinite(measured) ? measured : null
        } else {
          const before = analyzeAudioBuffer(audioBuffer)
          const baseLufs = Number(before?.lufsApprox)
          if (Number.isFinite(baseLufs) && baseLufs > -119) {
            const gain = Math.pow(10, (targetLufs - baseLufs) / 20)
            const channels = channelsOfAudioBuffer(audioBuffer)
            for (const data of channels) {
              for (let i = 0; i < data.length; i += 1) data[i] *= gain
            }
            const peak = peakOfChannels(channels)
            if (peak > 0.98) {
              const clampGain = 0.98 / peak
              for (const data of channels) {
                for (let i = 0; i < data.length; i += 1) data[i] *= clampGain
              }
            }
            achievedLufs = analyzeAudioBuffer(audioBuffer)?.lufsApprox ?? null
          }
        }
      } else if (audioBuffer && normalize) {
        const channels = channelsOfAudioBuffer(audioBuffer)
        const gain = peakNormalizeGain(channels, 0.98)
        if (Number.isFinite(gain) && gain > 0 && Math.abs(gain - 1) > 1e-4) {
          for (const data of channels) {
            for (let i = 0; i < data.length; i += 1) data[i] *= gain
          }
        }
      }
      let blob = rawBlob
      if (format === 'wav') {
        if (audioBuffer) blob = encodeWav(audioBuffer)
      } else {
        const channels = channelsOfAudioBuffer(audioBuffer)
        const sampleRate = audioBuffer.sampleRate
        const encoded = format === 'mp3'
          ? encodeMp3(channels, sampleRate, { bitrateKbps: 192 })
          : await encodeFlac(channels, sampleRate)
        blob = new Blob([encoded], { type: mime })
      }
      // v2.1：所有导出都回传播放/峰值指标（targetLufs 已返回时补充实测 peak/truePeak）。
      if (audioBuffer) {
        const measured = typeof engine.measureBufferPeak === 'function'
          ? engine.measureBufferPeak(audioBuffer)
          : null
        const loud = analyzeAudioBuffer(audioBuffer)
        const measuredLufs = Number(exportMetrics?.achievedLufs ?? loud?.lufs)
        if (exportMetrics === null) exportMetrics = {}
        if (Number.isFinite(measuredLufs)) {
          exportMetrics.achievedLufs = Math.round(measuredLufs * 100) / 100
          if (achievedLufs === null) achievedLufs = measuredLufs
        }
        for (const key of ['peak', 'peakDb', 'truePeak', 'truePeakDb']) {
          const value = Number(measured?.[key])
          if (Number.isFinite(value)) exportMetrics[key] = Math.round(value * 1000) / 1000
        }
      }
      if (shouldDownload) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 120000)
      }
      setExportPhase('正在保存到 workspaces/exports…')
      let savedPayload = null
      try {
        const secondsParam = encodeURIComponent(String(Math.round(Number(seconds) * 1000) / 1000))
        const jobParam = jobId ? `&jobId=${encodeURIComponent(jobId)}` : ''
        const exportMetricKeys = ['achievedLufs', 'peak', 'peakDb', 'truePeak', 'truePeakDb', 'gainDb', 'limited', 'baseLufs', 'targetLufs']
        const metricParam = exportMetrics
          ? exportMetricKeys
            .filter((key) => exportMetrics[key] !== undefined && exportMetrics[key] !== null)
            .map((key) => `&${key}=${encodeURIComponent(String(exportMetrics[key]))}`)
            .join('')
          : ''
        const res = await fetch(`/studio/api/export-done?name=${encodeURIComponent(name)}&seconds=${secondsParam}${jobParam}${metricParam}`, {
          method: 'POST',
          headers: { 'content-type': mime },
          body: blob,
        })
        savedPayload = await res.json().catch(() => null)
        if (!res.ok || (savedPayload && savedPayload.ok === false)) {
          const message = savedPayload?.error || `保存导出文件失败（HTTP ${res.status}）`
          const staleJob = /找不到导出任务|stale|任务已结束|jobId=.*不存在/i.test(String(message))
          const error = new Error(message)
          error.staleJob = staleJob
          throw error
        }
      } catch (error) {
        throw error
      }
      if (savedPayload?.stale === true) {
        stopStatusPolling()
        setExportPhase('导出任务已由其他客户端完成')
        showToast('导出任务已由其他客户端完成，已忽略本端陈旧回传（文件未重复保存）', 'info')
        return
      }
      const pathText = typeof savedPayload?.path === 'string' ? savedPayload.path : ''
      const finalName = (typeof savedPayload?.name === 'string' && savedPayload.name)
        || (pathText ? pathText.split(/[\\/]/).pop() : '')
        || name
      const renamed = finalName !== name
      const lufsNote = achievedLufs !== null ? ` · 实测 ${Number(achievedLufs).toFixed(1)} LUFS` : ''
      const pathNote = pathText ? ` → ${pathText}` : ''
      const silentNote = shouldDownload ? '' : ' · AI 静默导出：未触发浏览器下载'
      stopStatusPolling()
      setExportPhase(finalName)
      showToast(`导出完成：${finalName}（${seconds}s${targetNote}${lufsNote}${hadBoth ? ' · targetLufs 优先，已忽略 normalize' : ''}${renamed ? ` · 同名文件已自动改名，未覆盖「${name}」` : ''}${pathNote}${silentNote}）`, 'info')
    } catch (error) {
      stopStatusPolling()
      if (error?.staleJob) {
        // v2.1：另一个客户端/任务已收尾时旧 jobId 的 export-done 会返回「找不到任务」，
        // 这是可恢复的并发情况，不写 console error、不重复报 error job。
        showToast('导出任务已由其他客户端完成，已忽略陈旧 jobId：' + (error?.message ?? error), 'info')
        return
      }
      console.error('[ai-music-studio] export failed', error)
      if (jobId) {
        try {
          await fetch('/studio/api/export-error', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId, error: String(error?.message ?? error) }),
          })
        } catch (reportError) { /* ignore */ }
      }
      showToast('导出失败：' + (error?.message ?? error), 'error')
    } finally {
      stopStatusPolling()
      setExporting(false)
      setExportPhase('')
    }
  }, [exporting, showToast])

  /**
   * 分轨导出：逐轨渲染（其余轨静音，保留该轨效果器与 Master 链）→ 上传保存。
   * 注意：每轨都要完整离线渲染一次，轨道越多耗时越长（界面有进度提示）。
   */
  const exportStems = useCallback(async () => {
    const engine = engineRef.current
    const current = projectRef.current
    if (!engine || !current || exporting) return { ok: false }
    setExporting(true)
    const request = current.exportRequest ?? null
    const tailBars = tailBarsOf(current, request?.tailSeconds)
    const renderProject = buildRenderProject(current, tailBars)
    const slug = sanitizeFileBase(current.title || 'ai-music', 'ai-music').replace(/\s+/g, '-').slice(0, 40)
    const timestamp = exportTimestamp()
    const tracks = (current.tracks ?? []).filter((track) => track && !track.mute)
    if (tracks.length === 0) {
      setExporting(false)
      showToast('没有可导出的轨道（全部静音）')
      return { ok: false }
    }
    const files = []
    try {
      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index]
        const label = `${index + 1}/${tracks.length}：${track.name || track.id}`
        showToast(`正在导出分轨 ${label}…${tailBars ? '（含尾音）' : ''}`)
        const only = {
          ...renderProject,
          tracks: (renderProject.tracks ?? []).map((item) => ({
            ...item,
            mute: item.id !== track.id,
            solo: false,
          })),
        }
        const { blob: rawBlob, seconds } = await engine.renderWav(only, renderOptsOf(request, tailBars))
        let blob = rawBlob
        if (request?.normalize) {
          try {
            const decoded = await decodeWavBlob(rawBlob)
            const normalized = normalizeWavBlob(decoded)
            if (normalized) blob = normalized
          } catch (error) {
            console.warn('[ai-music-studio] stem normalize failed', error)
          }
        }
        const safeName = sanitizeFileBase(track.name || track.id, track.id || 'track').replace(/\s+/g, '-').slice(0, 40)
        const fileName = `stems-${String(index + 1).padStart(2, '0')}-${slug}-${safeName}-${timestamp}.wav`
        const res = await fetch(`/studio/api/export-done?name=${encodeURIComponent(fileName)}`, {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body: blob,
        })
        if (!res.ok) throw new Error(`保存 ${fileName} 失败（HTTP ${res.status}）`)
        files.push({ name: fileName, seconds })
      }
      showToast(`分轨导出完成：${files.length} 个文件（${Math.round(files[0]?.seconds ?? 0)}s）→ data/exports/`)
      return { ok: true, files }
    } catch (error) {
      console.error('[ai-music-studio] stems export failed', error)
      showToast('分轨导出失败：' + (error?.message ?? error) + (files.length ? `（已完成 ${files.length} 轨）` : ''))
      return { ok: false, error: error?.message ?? String(error), files }
    } finally {
      setExporting(false)
    }
  }, [exporting, showToast])

  // AI 请求导出（exportRequest.seq 变化；format=stems 走分轨导出）
  useEffect(() => {
    const request = project?.exportRequest
    const seq = request?.seq
    if (typeof seq !== 'number' || seq === lastExportSeq.current) return
    // 上一个导出还在渲染：不丢请求，等 exporting 变 false 后本 effect 会再跑。
    if (exporting) return
    lastExportSeq.current = seq
    if (request?.format === 'stems') exportStems()
    else doExport()
  }, [project?.exportRequest?.seq, project?.exportRequest?.format, exporting, doExport, exportStems])

  /* ── P10：AI 渲染预览（页面存活每 300ms 轮询；不写文件 / 不改工程 / 不入撤销） ── */
  const previewSeqRef = useRef(0)
  const previewBusyRef = useRef(false)
  /* ── v2.4 P1：AI 实时电平测量（播放 1–4 小节，50ms 采样 getMeters；不改工程/undo） ── */
  const meterSeqRef = useRef(0)
  const meterBusyRef = useRef(false)
  const [meterState, setMeterState] = useState('idle')

  const renderPreviewRequest = useCallback(async (request, current) => {
    const engine = engineRef.current
    if (!engine || !current) throw new Error('预览渲染环境未就绪')
    const tailBars = tailBarsOf(current, request?.tailSeconds)
    const renderProject = buildRenderProject(current, tailBars)
    const fromBar = Math.max(0, Math.floor(Number(request?.fromBar) || 0))
    const toBar = Math.max(fromBar + 1, Math.floor(Number(request?.toBar) || (fromBar + 4)))
    const rawSoloIds = request?.soloTrackIds ?? request?.trackIds
    const soloTrackIds = Array.isArray(rawSoloIds)
      ? rawSoloIds.filter((id) => typeof id === 'string' && id.trim() !== '')
      : []
    const sampleRate = Number(request?.sampleRate)
    const renderOpts = {
      fromBar,
      toBar: toBar + tailBars,
      ...(request?.fast === true ? { fast: true } : {}),
      ...(Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000 ? { sampleRate } : {}),
      ...(soloTrackIds.length > 0 ? { soloTrackIds } : {}),
    }
    const renderResult = await engine.renderWav(renderProject, renderOpts)
    const { blob, seconds } = renderResult
    const audioBuffer = await decodeWavBlob(blob)
    let analysisOpts = undefined
    if (request?.includeSectionStats) {
      const tempo = createTempoMap(renderProject)
      const barBeats = beatsPerBar(renderProject)
      const rawSections = Array.isArray(request.sections) ? request.sections : (renderProject.sections ?? [])
      const sections = rawSections
        .map((section) => ({
          name: section.name,
          startBeat: (Number(section.startBar) || 0) * barBeats,
          endBeat: ((Number(section.startBar) || 0) + (Number(section.lengthBars) || 0)) * barBeats,
        }))
        .filter((section) => section.endBeat > section.startBeat)
      analysisOpts = {
        includeSectionStats: true,
        sections,
        // v2.1：预览从 fromBar 开始时，sectionStats 的时间轴也要从 0 开始。
        beatToSeconds: (beat) => Math.max(0, tempo.beatToSeconds(beat) - tempo.beatToSeconds(fromBar * barBeats)),
      }
    }
    const metrics = analyzeAudioBuffer(audioBuffer, analysisOpts)
    const analysis = {
      ...metrics,
      seconds: Number(metrics?.seconds) || Number(seconds) || 0,
      mode: renderResult?.mode ?? (request?.fast ? 'fast' : 'normal'),
      fast: request?.fast === true,
      sampleRate: Number(renderResult?.sampleRate) || Number(audioBuffer.sampleRate) || 44100,
      ...(Array.isArray(renderResult?.renderedTrackIds) ? { renderedTrackIds: renderResult.renderedTrackIds } : {}),
    }
    if (request?.includeStems) {
      const stems = []
      const soloSet = soloTrackIds.length > 0 ? new Set(soloTrackIds) : null
      const stemTracks = (renderProject.tracks ?? []).filter((track) => track && !track.mute && (!soloSet || soloSet.has(track.id)))
      const stemRenderOpts = { ...renderOpts }
      delete stemRenderOpts.soloTrackIds
      for (const track of stemTracks) {
        try {
          showToast(`AI 正在渲染预览…（分轨 ${track.name || track.id}）`)
          const only = {
            ...renderProject,
            tracks: (renderProject.tracks ?? []).map((item) => ({
              ...item,
              mute: item.id !== track.id,
              solo: false,
            })),
            /* 分轨预览不启用 master FX，避免母带处理掩盖单轨电平 */
            master: { ...(renderProject.master ?? {}), effects: [] },
          }
          const { blob: stemBlob } = await engine.renderWav(only, stemRenderOpts)
          const stemBuffer = await decodeWavBlob(stemBlob)
          const stemMetrics = analyzeAudioBuffer(stemBuffer)
          stems.push({
            trackId: track.id,
            name: track.name ?? track.id,
            peakDb: stemMetrics?.peakDb ?? -120,
            rmsDb: stemMetrics?.rmsDb ?? -120,
            clipping: Boolean(stemMetrics?.clipping),
          })
        } catch (error) {
          console.warn('[ai-music-studio] preview stem failed', track?.id, error)
        }
      }
      analysis.stems = stems
    }
    return analysis
  }, [showToast])

  useEffect(() => {
    let disposed = false
    const poll = async () => {
      if (disposed || previewBusyRef.current) return
      const current = projectRef.current
      if (!current) return
      try {
        const res = await fetch(`/studio/api/preview-request?since=${previewSeqRef.current}`, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) return
        const payload = await res.json().catch(() => null)
        if (!payload || payload.ok === false) return
        const seq = Number(payload.seq) || 0
        if (seq > previewSeqRef.current) previewSeqRef.current = seq
        const request = payload.request
        if (!request || previewBusyRef.current) return
        previewBusyRef.current = true
        const isDraft = request?.draft === true || request?.quick === true || request?.mode === 'draft'
        showToast(isDraft ? 'AI 正在快速 draft 混音检查…' : 'AI 正在渲染预览…')
        try {
          const syncedProject = await waitForRequestRevision(request, current)
          const analysis = await renderPreviewRequest(request, syncedProject)
          const fmtMetric = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '—')
          const draftLabel = isDraft ? 'AI draft 检查完成' : 'AI 预览完成'
          const cachedLabel = analysis?.cached === true || request?.cached === true ? ' · 缓存命中' : ''
          showToast(`${draftLabel}${cachedLabel}：峰值 ${fmtMetric(analysis?.peakDb)} dB · RMS ${fmtMetric(analysis?.rmsDb)} dB${analysis?.stems ? ` · ${analysis.stems.length} 条分轨` : ''}`, 'info')
          try {
            await fetch('/studio/api/preview-done', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ seq, analysis }),
            })
          } catch (error) {
            console.warn('[ai-music-studio] preview-done failed', error)
          }
        } catch (error) {
          const friendly = previewErrorMessage(error)
          showToast('AI 预览渲染失败：' + friendly, 'error')
          try {
            await fetch('/studio/api/preview-done', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ seq, error: friendly }),
            })
          } catch (postError) {
            console.warn('[ai-music-studio] preview error report failed', postError)
          }
        } finally {
          previewBusyRef.current = false
        }
      } catch (error) {
        /* Host 未就绪/窗口关闭时静默；页面存活时会继续重试 */
      }
    }
    const timer = setInterval(poll, 300)
    poll()
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [renderPreviewRequest, showToast])

  /* v2.4 P1：捕获 meter-request 指定的 1–4 小节，50ms 采样 engine.getMeters()。 */
  const captureMeterRequest = useCallback(async (request, current) => {
    const engine = engineRef.current
    if (!engine || !current) throw new Error('实时电平测量环境未就绪')
    if (engine.unlocked === false) throw new Error('音频未启用，请先点击界面或播放一次后再试')
    const bars = Math.max(1, Math.min(4, Math.floor(Number(request?.bars) || 1)))
    const fromBar = Math.max(0, Math.floor(Number(request?.fromBar) || 0))
    const barBeats = Number(current?.timeSignature?.[0]) || 4
    const bpm = Math.max(40, Number(current?.bpm) || 128)
    const durationMs = Math.max(400, Math.round((bars * barBeats * 60 * 1000) / bpm))
    const wasPlaying = Boolean(engine.isPlaying)
    const prevBar = Number(engine.positionBar) || 0
    const samples = []
    let started = false
    try {
      engine.seek(fromBar)
      engine.play(fromBar)
      started = true
      await new Promise((resolve) => {
        const startedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now())
        const timer = setInterval(() => {
          try {
            const meters = engine.getMeters()
            samples.push({
              t: Math.round((((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt)) * 10) / 10,
              tracks: meters?.tracks ?? {},
              master: meters?.master ?? {},
            })
          } catch (error) {
            console.warn('[ai-music-studio] meter sample failed', error)
          }
          const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
          if (elapsed >= durationMs + 120) {
            clearInterval(timer)
            resolve()
          }
        }, 50)
        setTimeout(() => { clearInterval(timer); resolve() }, Math.max(5000, durationMs + 4000))
      })
    } finally {
      if (started) {
        try { engine.stop() } catch (error) { console.warn('[ai-music-studio] meter stop failed', error) }
        try { engine.seek(prevBar) } catch (error) { console.warn('[ai-music-studio] meter restore seek failed', error) }
        if (wasPlaying) {
          try { engine.play(prevBar) } catch (error) { console.warn('[ai-music-studio] meter restore play failed', error) }
        }
      }
    }
    const avg = (values) => (values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0)
    const masterRms = samples.map((sample) => Number(sample?.master?.rms) || 0)
    const masterPeak = samples.map((sample) => Number(sample?.master?.peak) || 0)
    const masterLufs = samples.map((sample) => Number(sample?.master?.lufsApprox) || 0).filter((value) => Number.isFinite(value))
    const trackIds = new Set()
    for (const sample of samples) for (const id of Object.keys(sample?.tracks ?? {})) trackIds.add(id)
    const tracks = {}
    for (const id of trackIds) {
      const rmsValues = samples.map((sample) => Number(sample?.tracks?.[id]?.rms) || 0)
      const peakValues = samples.map((sample) => Number(sample?.tracks?.[id]?.peak) || 0)
      tracks[id] = {
        maxRms: Math.max(0, ...rmsValues),
        maxPeak: Math.max(0, ...peakValues),
        maxRmsDb: Number(samples.reduce((max, sample) => Math.max(max, Number(sample?.tracks?.[id]?.rmsDb) || -120), -120).toFixed(2)),
        maxPeakDb: Number(samples.reduce((max, sample) => Math.max(max, Number(sample?.tracks?.[id]?.peakDb) || -120), -120).toFixed(2)),
      }
    }
    return {
      fromBar,
      bars,
      durationMs,
      sampleCount: samples.length,
      samples,
      master: {
        rmsAvg: avg(masterRms),
        rmsMin: Math.min(...masterRms),
        rmsMax: Math.max(...masterRms),
        peakMax: Math.max(0, ...masterPeak),
        lufsApproxAvg: avg(masterLufs),
        lufsApproxMax: masterLufs.length ? Math.max(...masterLufs) : -120,
      },
      tracks,
      transport: { wasPlaying, prevBar },
      ...(samples.length === 0 ? { warning: '未采集到有效电平样本（音频可能未启用）' } : {}),
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const poll = async () => {
      if (disposed || meterBusyRef.current) return
      const current = projectRef.current
      if (!current) return
      try {
        const res = await fetch(`/studio/api/meter-request?since=${meterSeqRef.current}`, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) return
        const payload = await res.json().catch(() => null)
        if (!payload || payload.ok === false) return
        const seq = Number(payload.seq) || 0
        if (seq > meterSeqRef.current) meterSeqRef.current = seq
        const request = payload.request
        if (!request || meterBusyRef.current) return
        meterBusyRef.current = true
        setMeterState('capturing')
        const bars = Math.max(1, Math.min(4, Math.floor(Number(request?.bars) || 1)))
        showToast(`AI 正在测量实时电平…（播放 ${bars} 小节，50ms 采样）`)
        try {
          const syncedProject = await waitForRequestRevision(request, current)
          const captured = await captureMeterRequest(request, syncedProject)
          setMeterState('done')
          const fmtDb = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? (20 * Math.log10(Number(value))).toFixed(1) : '-120.0')
          showToast(`实时电平测量完成：master 最大 RMS ${fmtDb(captured.master.rmsMax)} dBFS · 峰值 ${fmtDb(captured.master.peakMax)} dBFS（${captured.sampleCount} 样本）`)
          try {
            await fetch('/studio/api/meter-done', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ seq, ...captured }),
            })
          } catch (error) {
            console.warn('[ai-music-studio] meter-done failed', error)
          }
        } catch (error) {
          setMeterState('error')
          const friendly = error?.message ?? String(error)
          showToast('实时电平测量失败：' + friendly)
          try {
            await fetch('/studio/api/meter-done', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ seq, error: friendly }),
            })
          } catch (postError) {
            console.warn('[ai-music-studio] meter error report failed', postError)
          }
        } finally {
          meterBusyRef.current = false
        }
      } catch (error) {
        /* Host 未就绪/窗口关闭时静默；页面存活会继续重试 */
      }
    }
    const timer = setInterval(poll, 300)
    poll()
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [captureMeterRequest, showToast])

  /* v2.4：host preview request 带 revision 时，等工程状态追上再渲染，避免旧 project 渲染静音。 */
  const waitForRequestRevision = useCallback(async (request, current) => {
    const requested = Number(request?.revision)
    if (!Number.isFinite(requested) || requested <= 0) return current
    let project = current
    const currentRev = () => Number(project?.revision) || 0
    if (currentRev() >= requested) return project
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      try {
        const res = await fetch('/studio/api/state?rev=0', { cache: 'no-store', headers: { accept: 'application/json' } })
        if (res.ok) {
          const data = await res.json().catch(() => null)
          if (data?.project) project = data.project
        }
      } catch (error) {
        /* 继续重试到 2s 上限 */
      }
      if (currentRev() >= requested) return project
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    throw new Error(`工程状态尚未同步（需要 revision ${requested}，当前 ${currentRev()}），请稍后重试`)
  }, [])

  const postAction = useCallback(async (payload) => {    try {
      await fetch('/studio/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (error) {
      console.warn('[ai-music-studio] action failed', error)
    }
  }, [])

  /** 执行一组编辑 op（手势结束时一次调用）；失败返回 {ok:false,error}。 */
  const edit = useCallback(
    async (ops) => {
      if (!Array.isArray(ops) || ops.length === 0) return { ok: true }
      try {
        const payload = await requestJson('/studio/api/edit', {
          method: 'POST',
          body: JSON.stringify({ ops }),
        })
        refreshMeta()
        return { ok: true, ...payload }
      } catch (error) {
        showToast('编辑失败：' + (error?.message ?? error))
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
    [requestJson, refreshMeta, showToast],
  )

  const undo = useCallback(async () => {
    try {
      const payload = await requestJson('/studio/api/history/undo', { method: 'POST' })
      const label = history.undoLabel ? `撤销：${history.undoLabel}` : '已撤销'
      showToast(label)
      refreshMeta()
      return { ok: true, ...payload }
    } catch (error) {
      showToast('撤销失败：' + (error?.message ?? error))
      return { ok: false }
    }
  }, [requestJson, refreshMeta, showToast, history.undoLabel])

  const redo = useCallback(async () => {
    try {
      const payload = await requestJson('/studio/api/history/redo', { method: 'POST' })
      const label = history.redoLabel ? `重做：${history.redoLabel}` : '已重做'
      showToast(label)
      refreshMeta()
      return { ok: true, ...payload }
    } catch (error) {
      showToast('重做失败：' + (error?.message ?? error))
      return { ok: false }
    }
  }, [requestJson, refreshMeta, showToast, history.redoLabel])

  /** R6c：读取 AI 变更日志（只读，不改变 revision）。 */
  const getAiChanges = useCallback(async (limit = 10) => {
    try {
      const payload = await requestJson(`/studio/api/ai-changes?limit=${encodeURIComponent(limit)}`)
      return { ok: true, ...payload }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) }
    }
  }, [requestJson])

  /** 取历史状态（ProjectDialog / 顶栏按钮在需要时主动刷新）。 */
  const getHistory = useCallback(async () => {
    try {
      const payload = await requestJson('/studio/api/history')
      setHistory({
        canUndo: Boolean(payload?.canUndo),
        canRedo: Boolean(payload?.canRedo),
        undoLabel: payload?.undoLabel ?? '',
        redoLabel: payload?.redoLabel ?? '',
      })
      return payload
    } catch {
      return history
    }
  }, [requestJson, history])

  const listProjects = useCallback(async () => {
    try {
      return await requestJson('/studio/api/projects')
    } catch (error) {
      showToast('读取工程列表失败：' + (error?.message ?? error))
      return { projects: [] }
    }
  }, [requestJson, showToast])

  const saveProject = useCallback(
    async (name) => {
      try {
        const payload = await requestJson('/studio/api/projects/save', {
          method: 'POST',
          body: JSON.stringify({ name: name || projectInfo.name || undefined }),
        })
        setProjectInfo({ name: payload?.activeName ?? name ?? '', activeSavedAt: payload?.savedAt ?? Date.now() })
        refreshMeta()
        showToast(`已保存：${payload?.activeName ?? name ?? '当前工程'}`)
        return { ok: true, ...payload }
      } catch (error) {
        showToast('保存失败：' + (error?.message ?? error))
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
    [requestJson, projectInfo.name, refreshMeta, showToast],
  )

  const openProject = useCallback(
    async (name) => {
      try {
        const payload = await requestJson('/studio/api/projects/open', {
          method: 'POST',
          body: JSON.stringify({ name }),
        })
        refreshMeta()
        showToast(`已打开工程：${name}`)
        return { ok: true, ...payload }
      } catch (error) {
        showToast('打开失败：' + (error?.message ?? error))
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
    [requestJson, refreshMeta, showToast],
  )

  const newProject = useCallback(
    async ({ name, template } = {}) => {
      try {
        const payload = await requestJson('/studio/api/projects/new', {
          method: 'POST',
          body: JSON.stringify({ name, template }),
        })
        refreshMeta()
        showToast(template === 'demo' ? '已新建演示工程' : template && template !== 'empty' ? `已新建模板工程（${template}）` : '已新建空工程')
        return { ok: true, ...payload }
      } catch (error) {
        showToast('新建失败：' + (error?.message ?? error))
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
    [requestJson, refreshMeta, showToast],
  )

  const deleteProject = useCallback(
    async (name) => {
      try {
        const payload = await requestJson('/studio/api/projects/delete', {
          method: 'POST',
          body: JSON.stringify({ name }),
        })
        refreshMeta()
        showToast(`已删除工程：${name}`)
        return { ok: true, ...payload }
      } catch (error) {
        showToast('删除失败：' + (error?.message ?? error))
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
    [requestJson, refreshMeta, showToast],
  )

  /** 导出 MIDI：Host 生成文件 → 下载到浏览器。 */
  const exportMidi = useCallback(async (name) => {
    try {
      const payload = await requestJson('/studio/api/export-midi', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      if (payload?.path) {
        const file = String(payload.path).replace(/\\/g, '/').split('/').pop()
        const res = await fetch(`/studio/api/download?path=${encodeURIComponent(payload.path)}`, {
          cache: 'no-store',
        })
        if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = file || 'ai-music.mid'
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      }
      showToast(`已导出 MIDI${payload?.tracks ? `：${payload.tracks} 轨 / ${payload.notes} 音符` : ''}`)
      return { ok: true, ...payload }
    } catch (error) {
      showToast('导出 MIDI 失败：' + (error?.message ?? error))
      return { ok: false, error: error?.message ?? String(error) }
    }
  }, [requestJson, showToast])

  /** 导入音频：上传文件字节 + 客户端解码的元数据 → Host 存 media、建 audio 轨与片段。 */
  const importAudio = useCallback(
    async ({ name, bytesBase64, durationSeconds, channels, sampleRate, peaks, startBar, reference, takeGroup, takeIndex } = {}) => {
      try {
        const payload = await requestJson('/studio/api/import-audio', {
          method: 'POST',
          body: JSON.stringify({
            name,
            dataBase64: bytesBase64,
            durationSeconds,
            channels,
            sampleRate,
            peaks,
            startBar,
            ...(reference === true ? { reference: true } : {}),
            ...(typeof takeGroup === 'string' && takeGroup !== '' ? { takeGroup } : {}),
            ...(Number.isInteger(Number(takeIndex)) && takeIndex !== undefined && takeIndex !== null ? { takeIndex: Number(takeIndex) } : {}),
          }),
        })
        refreshMeta()
        showToast(reference === true ? `已导入参考曲：${payload?.name ?? name ?? '未命名'}` : `已导入音频：${payload?.name ?? name ?? '未命名'}`)
        return { ok: true, ...payload }
      } catch (error) {
        showToast((reference === true ? '导入参考曲失败：' : '导入音频失败：') + (error?.message ?? error))
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
    [requestJson, refreshMeta, showToast],
  )

  const actions = {
    toggleMute: (trackId) => postAction({ type: 'toggleMute', trackId }),
    toggleSolo: (trackId) => postAction({ type: 'toggleSolo', trackId }),
    setVolume: (trackId, value) => postAction({ type: 'setVolume', trackId, value }),
    setPan: (trackId, value) => postAction({ type: 'setPan', trackId, value }),
    exportWav: (options) => doExport(options || null),
    exportStems,
    importAudio,
    unlockAudio: () => {
      const engine = engineRef.current
      if (!engine) return
      engine.unlock().then(() => setAudioUnlocked(engine.unlocked)).catch(() => {})
    },
    // P1 编辑 / 工程 / MIDI
    edit,
    undo,
    redo,
    history: getHistory,
    aiChanges: getAiChanges,
    saveProject,
    saveProjectAs: saveProject,
    listProjects,
    openProject,
    newProject,
    deleteProject,
    exportMidi,
  }

  // 面板内任意点击都尝试解锁音频（浏览器自动播放策略）
  const onPointerDown = () => {
    const engine = engineRef.current
    if (!engine || engine.unlocked) return
    engine.unlock().then(() => setAudioUnlocked(engine.unlocked)).catch(() => {})
  }

  return (
    <div className="aims-host" onClick={onPointerDown}>
      {hostError && !project ? (
        <div className="aims-host-state">
          <div className="aims-host-state-card">
            <div className="aims-host-state-title">音乐工作室</div>
            <div className="aims-host-state-text">{TEXT.hostError}</div>
            <button className="aims-btn aims-btn-primary" onClick={retry}>{TEXT.retry}</button>
          </div>
        </div>
      ) : !project ? (
        <div className="aims-host-state">
          <div className="aims-host-state-card">
            <div className="aims-spinner" />
            <div className="aims-host-state-text">{TEXT.loading}</div>
          </div>
        </div>
      ) : (
        <StudioApp
          project={project}
          engine={engineRef.current}
          actions={actions}
          audioUnlocked={audioUnlocked}
          exporting={exporting}
          exportPhase={exportPhase}
          hostError={hostError}
          standalone={Boolean(props.showHeaderBadge)}
          history={history}
          projectInfo={projectInfo}
        />
      )}
      {toast ? <div className="aims-toast" data-testid="panel-toast">{toast}</div> : null}
      <div
        data-testid="meter-capture-status"
        data-state={meterState}
        style={{ position: 'fixed', left: '-9999px', top: 0, width: 1, height: 1, overflow: 'hidden' }}
        aria-hidden="true"
      >{meterState}</div>
    </div>
  )
}
