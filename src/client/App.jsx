/**
 * AI 音乐工作室 — 顶层界面（P1：手动编辑 / 撤销重做 / 工程管理 / MIDI 导出入口）。
 *
 * 布局：
 *   MenuBar（文件/编辑/视图/帮助）
 *   TransportBar（走带 + 撤销/重做/保存 + 工程/保存状态）
 *   左栏 通道机架 + 插件库
 *   中栏 tabs：播放列表 / 钢琴卷帘 / 混音台 / 效果器（前两者可编辑）
 *   右栏 AI 创作动态 + 项目统计 + Master 频谱
 *   底部 StatusBar
 *
 * props（由 src/client/panel.jsx 传入）：
 *   project / engine / actions（含 P1 的 edit/undo/redo/history/saveProject/... /exportMidi）
 *   history?     { canUndo, canRedo, undoLabel, redoLabel }
 *   projectInfo? { name, activeSavedAt, title?, bpm? }
 *   audioUnlocked? / exporting? / hostError? / standalone?
 *
 * 编辑策略：本地乐观应用 ops → 松手/操作结束时调用一次 actions.edit(ops)；
 * 宿主 revision 回来后丢弃乐观覆盖，保证 AI 编辑 / 撤销重做 / 手动编辑最终一致。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { font, palette, shadow } from './theme.js'
import { findSynthInstrument, fxDefaultParams } from '../shared/catalog.js'
import { InputRecorder } from './audio/recorder.js'
import {
  IconAutomation, IconChevron, IconFx, IconMixer, IconPiano, IconPlay, IconPlaylist,
  IconSparkle, IconWave, clamp, isTypingTarget, throttleKeydown, usePlaying,
} from './components/ui.jsx'
import { MenuBar, ShortcutsDialog } from './components/MenuBar.jsx'
import { ProjectDialog } from './components/ProjectDialog.jsx'
import { AboutDialog } from './components/AboutDialog.jsx'
import { HelpDialog } from './components/HelpDialog.jsx'
import { OnboardingCard, ONBOARDING_STORAGE_KEY } from './components/OnboardingCard.jsx'
import { SettingsDialog } from './components/SettingsDialog.jsx'
import { CommandPalette } from './components/CommandPalette.jsx'
import { ExportDialog } from './components/ExportDialog.jsx'
import { DEFAULT_LOCALE, I18nContext, normalizeLocale, translate } from './i18n.js'
import { TransportBar } from './components/TransportBar.jsx'
import { ChannelRack } from './components/ChannelRack.jsx'
import { PluginBrowser } from './components/PluginBrowser.jsx'
import { Playlist } from './components/Playlist.jsx'
import { PianoRoll } from './components/PianoRoll.jsx'
import { Mixer } from './components/Mixer.jsx'
import { FxRack } from './components/FxRack.jsx'
import { AutomationPanel } from './components/AutomationPanel.jsx'
import { AiChangePanel } from './components/AiChangePanel.jsx'
import { KeyboardPanel, KEYBOARD_CAPTURE_KEYS } from './components/KeyboardPanel.jsx'
import { AiFeed, ProjectStats } from './components/AiFeed.jsx'
import { Visualizer } from './components/Visualizer.jsx'
import { StatusBar } from './components/StatusBar.jsx'

const ROOT_STYLE = {
  '--aims-bg': palette.bg,
  '--aims-panel': palette.panel,
  '--aims-panel-soft': palette.panelSoft,
  '--aims-panel-sunk': palette.panelSunk,
  '--aims-panel-warm': palette.panelWarm,
  '--aims-line': palette.line,
  '--aims-line-strong': palette.lineStrong,
  '--aims-ink': palette.ink,
  '--aims-ink-soft': palette.inkSoft,
  '--aims-muted': palette.muted,
  '--aims-faint': palette.faint,
  '--aims-coral': palette.coral,
  '--aims-coral-soft': palette.coralSoft,
  '--aims-mint': palette.mint,
  '--aims-mint-soft': palette.mintSoft,
  '--aims-amber': palette.amber,
  '--aims-amber-soft': palette.amberSoft,
  '--aims-rose': palette.rose,
  '--aims-rose-soft': palette.roseSoft,
  '--aims-teal': palette.teal,
  '--aims-white': palette.white,
  '--aims-font-ui': font.ui,
  '--aims-font-mono': font.mono,
  '--aims-shadow-xs': shadow.xs,
  '--aims-shadow-sm': shadow.sm,
  '--aims-shadow-md': shadow.md,
  '--aims-shadow-pop': shadow.pop,
}

const TAB_DEFS = [
  { id: 'playlist', label: '播放列表', en: 'PLAYLIST', icon: <IconPlaylist size={14} /> },
  { id: 'pianoroll', label: '钢琴卷帘', en: 'PIANO ROLL', icon: <IconPiano size={14} /> },
  { id: 'mixer', label: '混音台', en: 'MIXER', icon: <IconMixer size={14} /> },
  { id: 'fx', label: '效果器', en: 'FX RACK', icon: <IconFx size={14} /> },
  { id: 'automation', label: '自动化', en: 'AUTOMATION', icon: <IconAutomation size={14} /> },
]

/** v2.1：dirty 只跟内容 revision；旧 host 无 contentRevision 时回退 revision。 */
function contentRevisionOf(project) {
  const content = Number(project?.contentRevision)
  if (Number.isFinite(content)) return content
  const rev = Number(project?.revision)
  return Number.isFinite(rev) ? rev : 0
}

/** M4：导出前若含外部 VST3，先打开导出对话框提示自动冻结。 */
function projectHasExternalPlugins(project) {
  for (const track of project?.tracks ?? []) {
    if (track?.engine === 'vst3' || track?.vst3) return true
    if ((track?.effects ?? []).some((fx) => fx?.type === 'vst3' || fx?.vst3)) return true
  }
  return false
}

/* ── P7：可定制布局（宽度/高度/折叠/紧凑，localStorage 记忆） ── */

const LAYOUT_STORAGE_KEY = 'aims.layout.v2'
const LAYOUT_LIMITS = {
  left: [220, 460],
  right: [260, 460],
  keyboard: [120, 360],
}
const LAYOUT_DEFAULTS = {
  leftWidth: 300,
  rightWidth: 320,
  keyboardHeight: 185,
  compact: false,
  collapsed: {
    leftRail: false,
    rightRail: false,
    pluginBrowser: false,
    aiFeed: false,
    projectStats: false,
    spectrum: false,
    channelRack: false,
    stepSequencer: false,
  },
}

const clampLayoutNumber = (value, range, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return clamp(number, range[0], range[1])
}

function sanitizeLayout(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const collapsedSource = source.collapsed !== null && typeof source.collapsed === 'object' ? source.collapsed : {}
  const collapsed = {}
  for (const key of Object.keys(LAYOUT_DEFAULTS.collapsed)) {
    collapsed[key] = Boolean(collapsedSource[key])
  }
  return {
    leftWidth: Math.round(clampLayoutNumber(source.leftWidth, LAYOUT_LIMITS.left, LAYOUT_DEFAULTS.leftWidth)),
    rightWidth: Math.round(clampLayoutNumber(source.rightWidth, LAYOUT_LIMITS.right, LAYOUT_DEFAULTS.rightWidth)),
    keyboardHeight: Math.round(clampLayoutNumber(source.keyboardHeight, LAYOUT_LIMITS.keyboard, LAYOUT_DEFAULTS.keyboardHeight)),
    compact: Boolean(source.compact),
    collapsed,
  }
}

function readStoredLayout() {
  if (typeof window === 'undefined') return sanitizeLayout(LAYOUT_DEFAULTS)
  try {
    const raw = window.localStorage?.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return sanitizeLayout(LAYOUT_DEFAULTS)
    return sanitizeLayout(JSON.parse(raw))
  } catch (err) {
    return sanitizeLayout(LAYOUT_DEFAULTS)
  }
}

function persistLayout(layout) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(sanitizeLayout(layout)))
  } catch (err) { /* localStorage 不可用时静默降级 */ }
}

const ZOOM_LEVELS = [1, 2, 4]
const cycleZoom = (current, direction) => {
  const index = ZOOM_LEVELS.indexOf(current)
  const base = index < 0 ? 0 : index
  return ZOOM_LEVELS[clamp(base + direction, 0, ZOOM_LEVELS.length - 1)]
}

const EMPTY_PROMPTS = [
  {
    title: '写一首 128 BPM 的 Melodic Techno',
    desc: 'F# 小调 · 32 小节 · Intro / Build / Drop',
    prompt: '帮我写一首 128 BPM 的 Melodic Techno，F# 小调，32 小节，包含 Intro、Build、Drop、Break 段落，用 Supersaw 主音、Reese 低音和 Warm Pad。',
  },
  {
    title: '给主音写一段旋律动机',
    desc: '按当前调性 · 4 小节 · Drop 升八度',
    prompt: '根据当前工程的调性，给主音轨道写一段 4 小节的旋律动机，Drop 段落升八度重复，加一点延迟。',
  },
  {
    title: '做一段 808 鼓组律动',
    desc: '四四拍 · 16 分踩镲 · 加过门',
    prompt: '用 Neon 808 鼓组做一段四四拍律动：2、4 拍军鼓和拍手，16 分踩镲，第 4 小节加嗵鼓过门。',
  },
]

/** 返回总线归一化（兼容旧工程的数字形式 buses.reverb = 0.35）。 */
function normalizeBusLocal(raw) {
  if (typeof raw === 'number') return { level: clamp(raw, 0, 1), effects: [] }
  return {
    level: clamp(Number(raw?.level) || 0, 0, 1),
    effects: Array.isArray(raw?.effects) ? raw.effects : [],
  }
}

/* ── P3b：音频导入（客户端解码元数据 + 256 点绝对峰值 + base64 上传） ── */

const AUDIO_PEAK_BUCKETS = 256
const AUDIO_IMPORT_MAX_BYTES = 30 * 1024 * 1024

/** 从解码后的 AudioBuffer 取 256 点绝对峰值，归一化到 0..1。 */
function peaksFromAudioBuffer(audioBuffer, buckets = AUDIO_PEAK_BUCKETS) {
  const length = Math.max(1, audioBuffer?.length ?? 0)
  const channels = Math.max(1, audioBuffer?.numberOfChannels ?? 1)
  const data = []
  for (let ch = 0; ch < channels; ch += 1) {
    try { data.push(audioBuffer.getChannelData(ch)) } catch (err) { /* 某些环境无 channel */ }
  }
  const peaks = new Array(buckets).fill(0)
  if (data.length === 0) return peaks
  const perBucket = length / buckets
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor(i * perBucket)
    const end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * perBucket)))
    const stride = Math.max(1, Math.floor((end - start) / 96))
    let peak = 0
    for (const channel of data) {
      for (let j = start; j < end; j += stride) {
        const value = Math.abs(channel[j] ?? 0)
        if (value > peak) peak = value
      }
    }
    peaks[i] = peak
  }
  const maxPeak = peaks.reduce((max, value) => Math.max(max, value), 0)
  if (maxPeak > 0) {
    for (let i = 0; i < peaks.length; i += 1) peaks[i] = clamp(peaks[i] / maxPeak, 0, 1)
  }
  return peaks
}

/** 用 AudioContext / OfflineAudioContext 解码音频文件，返回元数据 + 波形峰值。 */
async function decodeAudioMetadata(arrayBuffer) {
  const Ctx = typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext)
    : null
  let ctx = null
  try {
    if (Ctx) ctx = new Ctx()
    else if (typeof OfflineAudioContext !== 'undefined') ctx = new OfflineAudioContext(1, 1, 44100)
    else throw new Error('当前环境不支持音频解码')
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
    return {
      durationSeconds: Number(audioBuffer.duration) || 0,
      channels: Number(audioBuffer.numberOfChannels) || 1,
      sampleRate: Number(audioBuffer.sampleRate) || 44100,
      peaks: peaksFromAudioBuffer(audioBuffer),
    }
  } finally {
    try { await ctx?.close?.() } catch (err) { /* AudioContext 关闭失败不影响导入 */ }
  }
}

/** FileReader → dataURL → base64（比手写 chunk 拼接更省内存）。 */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/* ── P3b-2：麦克风录音（接口与 CONTRACT-P3B2 §1 的 InputRecorder 对齐，audio-engine 模块就绪后可替换） ── */

/** ArrayBuffer → base64（分块，避免大录音爆栈）。 */
function arrayBufferToBase64Chunked(buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/** 录音文件名：录音-YYYYMMDD-HHmmss.wav */
function recordingFileName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `录音-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.wav`
}

/** 创建录音器实例：使用 audio-engine 的 InputRecorder（CONTRACT-P3B2 §1）。 */
function createInputRecorder() {
  return new InputRecorder({ maxSeconds: 300 })
}

/** 把 UI 编辑 ops 应用到本地项目（乐观覆盖，不修改宿主对象）。 */
function applyOpsLocal(project, ops) {
  if (!project) return project
  let next = project
  for (const op of ops ?? []) {
    if (!op || typeof op !== 'object') continue
    if (op.type === 'setPatternNotes' && op.patternId) {
      const notes = Array.isArray(op.notes) ? op.notes : []
      next = {
        ...next,
        patterns: (next.patterns ?? []).map((pattern) => (
          pattern.id === op.patternId
            ? {
              ...pattern,
              notes: notes.map((note) => ({
                pitch: Math.round(clamp(note.pitch, 0, 127)),
                start: Math.max(0, Number(note.start) || 0),
                dur: Math.max(0.02, Number(note.dur) || 0.25),
                vel: clamp(note.vel ?? 0.8, 0.05, 1),
              })),
            }
            : pattern
        )),
      }
    } else if (op.type === 'setClips') {
      const clips = Array.isArray(op.clips) ? op.clips : []
      const base = Date.now().toString(36)
      next = {
        ...next,
        clips: clips.map((clip, index) => {
          const isAudioClip = Boolean(clip.mediaId)
          const offsetSeconds = Math.max(0, Math.round((Number(clip.offsetSeconds) || 0) * 1000) / 1000)
          return {
            id: clip.id || `ui_clip_${base}_${index}`,
            trackId: clip.trackId,
            ...(isAudioClip
              ? { mediaId: clip.mediaId, ...(offsetSeconds > 0 ? { offsetSeconds } : {}) }
              : { patternId: clip.patternId }),
            startBar: Math.max(0, Math.round(Number(clip.startBar) || 0)),
            lengthBars: Math.max(1, Math.round(Number(clip.lengthBars) || 1)),
            ...(isAudioClip ? {} : { transpose: Math.round(Number(clip.transpose) || 0) }),
          }
        }),
      }
    } else if (op.type === 'setSections') {
      next = {
        ...next,
        sections: (Array.isArray(op.sections) ? op.sections : []).map((section, index) => ({
          id: section.id || `ui_sec_${index}`,
          name: section.name || `Section ${index + 1}`,
          startBar: Math.max(0, Math.round(Number(section.startBar) || 0)),
          lengthBars: Math.max(1, Math.round(Number(section.lengthBars) || 1)),
          color: section.color || palette.coral,
        })),
      }
    } else if (op.type === 'setAutomation') {
      const rawPoints = Array.isArray(op.points) ? op.points : []
      const points = rawPoints
        .map((point) => ({
          beat: Math.max(0, Number(point?.beat) || 0),
          value: clamp(Number(point?.value) || 0, 0, 1),
        }))
        .sort((a, b) => a.beat - b.beat)
        .slice(0, 256)
      const entry = { enabled: op.enabled !== false, points }
      if ((op.target || 'track') === 'master') {
        next = {
          ...next,
          master: {
            ...(next.master ?? {}),
            automation: { ...(next.master?.automation ?? {}), [op.param]: entry },
          },
        }
      } else if (op.trackId) {
        next = {
          ...next,
          tracks: (next.tracks ?? []).map((track) => (
            track.id === op.trackId
              ? { ...track, automation: { ...(track.automation ?? {}), [op.param]: entry } }
              : track
          )),
        }
      }
    } else if (op.type === 'clearAutomation') {
      const stripParam = (automation) => {
        if (!automation || typeof automation !== 'object') return automation
        const copy = { ...automation }
        delete copy[op.param]
        return copy
      }
      if ((op.target || 'track') === 'master') {
        next = {
          ...next,
          master: { ...(next.master ?? {}), automation: stripParam(next.master?.automation) },
        }
      } else if (op.trackId) {
        next = {
          ...next,
          tracks: (next.tracks ?? []).map((track) => (
            track.id === op.trackId ? { ...track, automation: stripParam(track.automation) } : track
          )),
        }
      }
    } else if (op.type === 'setTempoMap') {
      /* P12：全局速度曲线 points [{beat,bpm}]；同 beat 后者覆盖，最多 64 点。 */
      const sorted = (Array.isArray(op.points) ? op.points : [])
        .map((point) => ({
          beat: Math.max(0, Number(point?.beat) || 0),
          bpm: Math.round(clamp(Number(point?.bpm) || 128, 40, 200)),
        }))
        .sort((a, b) => a.beat - b.beat)
      const dedup = []
      for (const point of sorted) {
        if (dedup.length && Math.abs(dedup[dedup.length - 1].beat - point.beat) < 1e-6) {
          dedup[dedup.length - 1] = point
        } else {
          dedup.push(point)
        }
        if (dedup.length >= 64) break
      }
      next = { ...next, tempoMap: dedup }
    } else if (op.type === 'clearTempoMap') {
      const { tempoMap: _tempoMap, ...rest } = next
      next = rest
    } else if (op.type === 'addEffect' && op.fxType) {
      const isMaster = (op.target || 'track') === 'master'
      const isBus = op.target === 'bus' && Boolean(op.busId)
      const effect = {
        id: `ui_fx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: op.fxType,
        enabled: true,
        params: { ...(fxDefaultParams(op.fxType) ?? {}), ...(op.params ?? {}) },
      }
      const insert = (chain) => {
        const list = [...(chain ?? [])]
        const at = Number.isFinite(Number(op.position))
          ? clamp(Math.trunc(Number(op.position)), 0, list.length)
          : list.length
        list.splice(at, 0, effect)
        return list.slice(0, 8)
      }
      if (isMaster) {
        next = { ...next, master: { ...(next.master ?? {}), effects: insert(next.master?.effects) } }
      } else if (isBus) {
        const bus = normalizeBusLocal(next.buses?.[op.busId])
        next = { ...next, buses: { ...(next.buses ?? {}), [op.busId]: { ...bus, effects: insert(bus.effects) } } }
      } else if (op.trackId) {
        next = {
          ...next,
          tracks: (next.tracks ?? []).map((track) => (
            track.id === op.trackId ? { ...track, effects: insert(track.effects) } : track
          )),
        }
      }
    } else if (op.type === 'updateEffect' && op.effectId) {
      const isMaster = (op.target || 'track') === 'master'
      const isBus = op.target === 'bus' && Boolean(op.busId)
      const patch = (chain) => {
        const list = [...(chain ?? [])]
        const index = list.findIndex((item) => item.id === op.effectId)
        if (index < 0) return list
        const current = list[index]
        const updated = {
          ...current,
          ...(op.enabled != null ? { enabled: Boolean(op.enabled) } : {}),
          ...(op.params ? { params: { ...(current.params ?? {}), ...op.params } } : {}),
        }
        list.splice(index, 1)
        const at = Number.isFinite(Number(op.position))
          ? clamp(Math.trunc(Number(op.position)), 0, list.length)
          : index
        list.splice(at, 0, updated)
        return list
      }
      if (isMaster) {
        next = { ...next, master: { ...(next.master ?? {}), effects: patch(next.master?.effects) } }
      } else if (isBus) {
        const bus = normalizeBusLocal(next.buses?.[op.busId])
        next = { ...next, buses: { ...(next.buses ?? {}), [op.busId]: { ...bus, effects: patch(bus.effects) } } }
      } else if (op.trackId) {
        next = {
          ...next,
          tracks: (next.tracks ?? []).map((track) => (
            track.id === op.trackId ? { ...track, effects: patch(track.effects) } : track
          )),
        }
      }
    } else if (op.type === 'removeEffect' && op.effectId) {
      const isMaster = (op.target || 'track') === 'master'
      const isBus = op.target === 'bus' && Boolean(op.busId)
      const remove = (chain) => (chain ?? []).filter((item) => item.id !== op.effectId)
      if (isMaster) {
        next = { ...next, master: { ...(next.master ?? {}), effects: remove(next.master?.effects) } }
      } else if (isBus) {
        const bus = normalizeBusLocal(next.buses?.[op.busId])
        next = { ...next, buses: { ...(next.buses ?? {}), [op.busId]: { ...bus, effects: remove(bus.effects) } } }
      } else if (op.trackId) {
        next = {
          ...next,
          tracks: (next.tracks ?? []).map((track) => (
            track.id === op.trackId ? { ...track, effects: remove(track.effects) } : track
          )),
        }
      }
    } else if (op.type === 'setTrackSends' && op.trackId) {
      next = {
        ...next,
        tracks: (next.tracks ?? []).map((track) => {
          if (track.id !== op.trackId) return track
          const sends = { ...(track.sends ?? {}) }
          if (op.reverb != null) sends.reverb = clamp(Number(op.reverb) || 0, 0, 1)
          if (op.delay != null) sends.delay = clamp(Number(op.delay) || 0, 0, 1)
          return { ...track, sends }
        }),
      }
    } else if (op.type === 'setBus' && op.busId) {
      const bus = normalizeBusLocal(next.buses?.[op.busId])
      next = {
        ...next,
        buses: {
          ...(next.buses ?? {}),
          [op.busId]: { ...bus, ...(op.level != null ? { level: clamp(Number(op.level) || 0, 0, 1) } : {}) },
        },
      }
    } else if (op.type === 'setSidechain' && op.trackId) {
      next = {
        ...next,
        tracks: (next.tracks ?? []).map((track) => {
          if (track.id !== op.trackId) return track
          const validSource = op.sourceTrackId
            && op.sourceTrackId !== track.id
            && (next.tracks ?? []).some((item) => item.id === op.sourceTrackId)
          if (!validSource) return track
          return {
            ...track,
            sidechain: {
              enabled: op.enabled !== false,
              sourceTrackId: op.sourceTrackId,
              amount: clamp(Number(op.amount ?? 0.5) || 0, 0, 1),
              attack: clamp(Number(op.attack ?? 0.005) || 0.005, 0.001, 0.2),
              release: clamp(Number(op.release ?? 0.12) || 0.12, 0.02, 1),
            },
          }
        }),
      }
    } else if (op.type === 'clearSidechain' && op.trackId) {
      next = {
        ...next,
        tracks: (next.tracks ?? []).map((track) => {
          if (track.id !== op.trackId || !track.sidechain) return track
          const { sidechain: _removed, ...rest } = track
          return rest
        }),
      }
    } else if (op.type === 'updatePattern' && op.patternId) {
      next = {
        ...next,
        patterns: (next.patterns ?? []).map((pattern) => (
          pattern.id === op.patternId
            ? {
              ...pattern,
              ...(op.name != null ? { name: op.name } : {}),
              ...(op.lengthBars != null ? { lengthBars: Math.max(1, Math.round(Number(op.lengthBars) || 1)) } : {}),
            }
            : pattern
        )),
      }
    }
  }
  return next
}

/** 空工程：漂亮的引导页。 */
function EmptyStudio({ onCopyPrompt }) {
  return (
    <div className="aims-empty-studio">
      <div className="aims-empty-hero">
        <div className="aims-empty-mark">
          <IconSparkle size={26} />
        </div>
        <span className="aims-empty-eyebrow">AI MUSIC STUDIO · 空工程</span>
        <h2 className="aims-empty-hero-title">让 AI 开始创作</h2>
        <p className="aims-empty-lead">
          在对话框里描述你想要的音乐，AI 会在这里实时搭建轨道、编排段落、写入音符。
          <br />
          也可以打开顶部菜单：新建 / 打开工程、导出 MIDI，或直接开始手动编辑。
        </p>
        <div className="aims-empty-steps">
          <span className="aims-empty-step"><b className="aims-mono">01</b>描述风格与情绪</span>
          <IconChevron size={12} className="aims-empty-step-arrow" />
          <span className="aims-empty-step"><b className="aims-mono">02</b>AI 建立轨道与段落</span>
          <IconChevron size={12} className="aims-empty-step-arrow" />
          <span className="aims-empty-step"><b className="aims-mono">03</b>手动编辑并导出</span>
        </div>
      </div>
      <div className="aims-empty-prompts">
        {EMPTY_PROMPTS.map((item, index) => (
          <button
            key={item.title}
            type="button"
            className="aims-empty-prompt"
            title={`点击复制提示词：${item.prompt}`}
            onClick={() => onCopyPrompt(item)}
          >
            <span className="aims-empty-prompt-top">
              <span className="aims-empty-prompt-no aims-mono">0{index + 1}</span>
              <span className="aims-empty-prompt-copy">复制提示词</span>
            </span>
            <span className="aims-empty-prompt-title">{item.title}</span>
            <span className="aims-empty-prompt-desc">{item.desc}</span>
          </button>
        ))}
      </div>
      <div className="aims-empty-hint">
        <IconSparkle size={12} />
        提示：按 Ctrl+N 新建空工程或演示工程；AI 添加轨道后，播放列表 / 钢琴卷帘就会亮起来。
      </div>
    </div>
  )
}

export function StudioApp({
  project, state, engine, actions, audioUnlocked, exporting: exportingProp, exportPhase = '', hostError,
  history: historyProp, projectInfo: projectInfoProp, standalone = false,
}) {
  /* ── refs：回调里读最新值 ── */
  const engineRef = useRef(engine)
  engineRef.current = engine
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const projectRef = useRef(project)
  projectRef.current = project

  /* ── 基础 UI 状态 ── */
  const [tab, setTab] = useState('playlist')
  const [selectedTrackId, setSelectedTrackId] = useState(null)
  const [selectedPatternId, setSelectedPatternId] = useState(null)
  const [selectedClip, setSelectedClip] = useState(null)
  const [fxTarget, setFxTarget] = useState('master')
  const [pending, setPending] = useState({})
  const [exportBusy, setExportBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [aiChangeData, setAiChangeData] = useState({ changes: [], canUndo: false, canRedo: false })
  const [aiChangeDismissed, setAiChangeDismissed] = useState(null)
  const [onboardingVisible, setOnboardingVisible] = useState(() => {
    try { return !window.localStorage.getItem(ONBOARDING_STORAGE_KEY) } catch (err) { return false }
  })
  const [commandOpen, setCommandOpen] = useState(false)
  const [locale, setLocale] = useState(() => {
    try { return normalizeLocale(window.localStorage.getItem('aims:locale') || DEFAULT_LOCALE) } catch (err) { return DEFAULT_LOCALE }
  })
  const t = useCallback((key, vars) => translate(locale, key, vars), [locale])
  useEffect(() => {
    let cancelled = false
    fetch('/studio/api/settings', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const next = normalizeLocale(data?.settings?.language)
        setLocale(next)
        try { window.localStorage.setItem('aims:locale', next) } catch (err) { /* ignore */ }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const [layout, setLayout] = useState(readStoredLayout)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const [pianoZoom, setPianoZoom] = useState(1)
  const [editorCommand, setEditorCommand] = useState(null)
  /* P3a：底部键盘面板 */
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [keyboardExpanded, setKeyboardExpanded] = useState(true)
  /* P3b-2：麦克风录音 */
  const [recordState, setRecordState] = useState('idle')
  const [recordElapsed, setRecordElapsed] = useState(0)
  const [recordLevel, setRecordLevel] = useState(0)
  /* P15：录音输入设备（enumerateDevices audioinput，localStorage 持久化） */
  const INPUT_DEVICE_STORAGE_KEY = 'aims:inputDeviceId'
  const [inputDevices, setInputDevices] = useState([])
  const [inputDeviceId, setInputDeviceId] = useState(() => {
    try { return localStorage.getItem(INPUT_DEVICE_STORAGE_KEY) || '' } catch (err) { return '' }
  })
  const inputDeviceIdRef = useRef(inputDeviceId)
  inputDeviceIdRef.current = inputDeviceId
  /* R2c：叠录 / 录音监听（localStorage 持久化；监听默认 0.35 防啸叫） */
  const OVERDUB_STORAGE_KEY = 'aims:recordOverdub'
  const MONITOR_STORAGE_KEY = 'aims:recordMonitor'
  const MONITOR_GAIN = 0.35
  const [recordOverdub, setRecordOverdub] = useState(() => {
    try { return localStorage.getItem(OVERDUB_STORAGE_KEY) === '1' } catch (err) { return false }
  })
  const [recordMonitor, setRecordMonitor] = useState(() => {
    try { return localStorage.getItem(MONITOR_STORAGE_KEY) === '1' } catch (err) { return false }
  })
  const recordOverdubRef = useRef(recordOverdub)
  recordOverdubRef.current = recordOverdub
  const recordMonitorRef = useRef(recordMonitor)
  recordMonitorRef.current = recordMonitor

  /* P1：本地乐观编辑 / 历史 / 保存状态 / 工程名 */
  const [overrideProject, setOverrideProject] = useState(null)
  const [historyLocal, setHistoryLocal] = useState({ canUndo: false, canRedo: false, undoLabel: '', redoLabel: '' })
  const [saveState, setSaveState] = useState('saved')
  const [savedName, setSavedName] = useState('')

  const exportBusyRef = useRef(false)
  const fileInputRef = useRef(null)
  const midiInputRef = useRef(null)
  const referenceInputRef = useRef(null)
  const recordRef = useRef({
    recorder: null,
    startBar: 0,
    startedAt: 0,
    timer: null,
    level: 0,
    active: false,
    starting: false,
    stopping: false,
    pendingStart: false,
    takeGroup: null,
    takeIndex: 0,
  })
  const toastTimer = useRef(null)
  const volTimers = useRef({})
  const panTimers = useRef({})
  const editorSeqRef = useRef(0)
  const shortcutThrottleRef = useRef({})
  const runEditRef = useRef(null)
  const recordAutomationRef = useRef(null)
  const playingRef = useRef(false)
  const automationLastWriteRef = useRef(new Map())
  const automationPendingRef = useRef(new Map())
  const lastSpaceRef = useRef(0)
  const cleanRevisionRef = useRef(null)
  const dialogRef = useRef(null)
  dialogRef.current = dialog
  /* P3a：键盘面板展开时，A/W/S… 交给演奏，不触发全局快捷键 */
  const keyboardActiveRef = useRef(false)
  keyboardActiveRef.current = keyboardOpen && keyboardExpanded

  const playing = usePlaying(engine, Boolean(project?.transport?.playing))
  playingRef.current = playing
  /* P14b：参考曲 A/B */
  const [abMode, setAbMode] = useState(false)
  const abSavedRef = useRef(null)

  /* ── 有效项目：本地乐观覆盖 → 宿主 project ── */
  const viewProject = useMemo(() => {
    if (!project) return project
    if (overrideProject && overrideProject.rev === project.revision) return overrideProject.project
    return project
  }, [project, overrideProject])
  const viewProjectRef = useRef(viewProject)
  viewProjectRef.current = viewProject
  const referenceTrack = useMemo(
    () => (viewProject?.tracks ?? []).find((track) => track && track.reference === true) ?? null,
    [viewProject?.tracks],
  )
  useEffect(() => {
    if (!referenceTrack && abMode) {
      setAbMode(false)
      abSavedRef.current = null
    }
  }, [referenceTrack, abMode])

  useEffect(() => {
    setOverrideProject(null)
  }, [project?.revision])

  /* ── 音频解锁状态 ── */
  const [engineUnlocked, setEngineUnlocked] = useState(() => Boolean(engine?.unlocked))
  useEffect(() => {
    if (!engine) return undefined
    const id = setInterval(() => {
      const value = Boolean(engine.unlocked)
      setEngineUnlocked((prev) => (prev === value ? prev : value))
    }, 400)
    return () => clearInterval(id)
  }, [engine])
  const unlocked = audioUnlocked !== undefined ? Boolean(audioUnlocked) : engineUnlocked

  /* ── P13：AI 要求播放但音频尚未解锁 → 提示条脉冲高亮（请求本身不吞，解锁后自动继续） ── */
  const [aiPlayBlocked, setAiPlayBlocked] = useState(false)
  const lastTransportCmdSeqRef = useRef(null)
  useEffect(() => {
    if (!project) return
    /* 首次拿到工程时只记录历史命令 seq，避免页面打开就误报；之后的新 play 命令才提示。 */
    if (lastTransportCmdSeqRef.current === null) {
      lastTransportCmdSeqRef.current = Number(project?.transport?.cmd?.seq) || 0
      return
    }
    const cmd = project?.transport?.cmd
    const seq = Number(cmd?.seq)
    if (!Number.isFinite(seq)) return
    if (seq <= lastTransportCmdSeqRef.current) return
    lastTransportCmdSeqRef.current = seq
    if (cmd?.action === 'play') {
      const isUnlocked = Boolean(engineRef.current?.unlocked) || unlocked
      if (!isUnlocked) setAiPlayBlocked(true)
    } else if (cmd?.action === 'stop') {
      setAiPlayBlocked(false)
    }
  }, [project, project?.transport?.cmd?.seq, unlocked])
  useEffect(() => {
    if (unlocked) setAiPlayBlocked(false)
  }, [unlocked])

  /* ── R0：AI 操作活动横幅（切工程/导出/渲染/预览等 activity 变化时短暂可见） ── */
  const [aiBanner, setAiBanner] = useState(null)
  const lastActivityKeyRef = useRef(null)
  const aiBannerTimerRef = useRef(null)
  useEffect(() => {
    const activity = viewProject?.activity
    const text = typeof activity?.text === 'string' ? activity.text.trim() : ''
    if (!text) return
    const key = `${Number(activity?.at) || 0}:${text}`
    if (lastActivityKeyRef.current === null) {
      lastActivityKeyRef.current = key
      return
    }
    if (lastActivityKeyRef.current === key) return
    lastActivityKeyRef.current = key
    setAiBanner({ text, at: Number(activity?.at) || Date.now() })
    clearTimeout(aiBannerTimerRef.current)
    aiBannerTimerRef.current = setTimeout(() => setAiBanner(null), 5200)
  }, [viewProject?.activity?.at, viewProject?.activity?.text])
  useEffect(() => () => clearTimeout(aiBannerTimerRef.current), [])

  /* ── v2.1：apply_mix 对自动化曲线的 warning（host 字段/活动文案存在时显示） ── */
  const [mixWarning, setMixWarning] = useState(null)
  const lastMixWarningKeyRef = useRef(null)
  const mixWarningTimerRef = useRef(null)
  useEffect(() => {
    const raw = viewProject?.lastMixWarnings ?? viewProject?.mixWarnings ?? viewProject?.warnings
    const activityText = typeof viewProject?.activity?.text === 'string' ? viewProject.activity.text : ''
    const activityWarning = /自动化/.test(activityText) && /(警告|缩放|乘算|未生效)/.test(activityText) ? activityText : ''
    const warnings = Array.isArray(raw) ? raw.map((item) => (typeof item === 'string' ? item : item?.message)).filter(Boolean) : raw ? [String(raw)] : []
    if (activityWarning) warnings.push(activityWarning)
    if (warnings.length === 0) return
    const key = warnings.join('|') + `:${Number(viewProject?.contentRevision ?? viewProject?.revision) || 0}`
    if (lastMixWarningKeyRef.current === key) return
    lastMixWarningKeyRef.current = key
    setMixWarning(warnings.join('；'))
    clearTimeout(mixWarningTimerRef.current)
    mixWarningTimerRef.current = setTimeout(() => setMixWarning(null), 8000)
  }, [viewProject?.lastMixWarnings, viewProject?.mixWarnings, viewProject?.warnings, viewProject?.activity?.text, viewProject?.contentRevision, viewProject?.revision])
  useEffect(() => () => clearTimeout(mixWarningTimerRef.current), [])

  /* ── P8：GeneralUser GS 音色库加载状态（轻量提示，失败静默降级） ── */
  const [soundfontStatus, setSoundfontStatus] = useState({ state: 'unknown', error: null })
  const sawSoundfontLoadingRef = useRef(false)
  const soundfontHintStartedRef = useRef(false)
  const soundfontEventStateRef = useRef(null)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const apply = (state, error = null) => {
      if (state !== 'loading' && state !== 'ready' && state !== 'error') return
      setSoundfontStatus((prev) => (prev.state === state && prev.error === error ? prev : { state, error }))
    }
    const onStatus = (event) => {
      try {
        const detail = event?.detail ?? {}
        const state = String(detail.state ?? '').toLowerCase()
        if (state === 'loading') soundfontEventStateRef.current = 'loading'
        else soundfontEventStateRef.current = null
        apply(state, detail.error ?? null)
      } catch (err) { /* 自定义事件 detail 异常时忽略 */ }
    }
    window.addEventListener('aims-soundfont-status', onStatus)
    let ticks = 0
    const poll = setInterval(() => {
      ticks += 1
      if (ticks > 150) { clearInterval(poll); return }
      /* 事件驱动的状态优先（audio-engine 若主动 dispatch，则不让轮询覆盖 loading） */
      if (soundfontEventStateRef.current === 'loading') return
      const engineInstance = engineRef.current
      if (!engineInstance) return
      try {
        const status = engineInstance.soundfontStatus ?? engineInstance.soundFontStatus ?? null
        if (status && typeof status === 'object') {
          const state = String(status.state ?? '').toLowerCase()
          if (status.ready === true || state === 'ready') apply('ready')
          else if (status.loading === true || state === 'loading') apply('loading')
          else if (state === 'error' || status.error) apply('error', status.error ?? null)
          return
        }
        /* audio-engine 现有 getter：soundfontLoading / soundfontLoaded / soundfontPresetCount */
        const loading = engineInstance.soundfontLoading === true || engineInstance.isSoundfontLoading === true
        const loaded = engineInstance.soundfontLoaded === true
          || engineInstance.isSoundfontReady === true
          || engineInstance.soundfontReady === true
          || (Number(engineInstance.soundfontPresetCount) || 0) > 0
        if (loaded) {
          sawSoundfontLoadingRef.current = false
          soundfontHintStartedRef.current = false
          apply('ready')
        } else if (loading) {
          sawSoundfontLoadingRef.current = true
          soundfontHintStartedRef.current = true
          apply('loading')
        } else if (sawSoundfontLoadingRef.current) {
          /* 加载结束但未成功（失败降级）：隐藏 loading 提示，不阻塞界面 */
          sawSoundfontLoadingRef.current = false
          setSoundfontStatus((prev) => (prev.state === 'loading' ? { state: 'error', error: null } : prev))
        } else if (!soundfontHintStartedRef.current && engineInstance.unlocked === true) {
          /* 引擎解锁即开始预载 SF2：本地服务器加载可能很快，先给一次轻量提示 */
          soundfontHintStartedRef.current = true
          sawSoundfontLoadingRef.current = true
          apply('loading')
        }
      } catch (err) { /* engine 无该字段时静默降级 */ }
    }, 700)
    return () => {
      window.removeEventListener('aims-soundfont-status', onStatus)
      clearInterval(poll)
    }
  }, [])

  /* ── 提示条 ── */
  const showToast = useCallback((text, tone = 'info') => {
    setToast({ text, tone })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4200)
  }, [])
  useEffect(() => () => {
    clearTimeout(toastTimer.current)
    Object.values(volTimers.current).forEach(clearTimeout)
    Object.values(panTimers.current).forEach(clearTimeout)
  }, [])

  /* ── 历史状态 ── */
  const refreshHistory = useCallback(async () => {
    const fn = actionsRef.current?.history
    if (typeof fn !== 'function') return
    try {
      const result = await fn()
      if (result) {
        setHistoryLocal({
          canUndo: Boolean(result.canUndo),
          canRedo: Boolean(result.canRedo),
          undoLabel: result.undoLabel || '',
          redoLabel: result.redoLabel || '',
        })
      }
    } catch (err) {
      /* 历史查询失败不打扰用户 */
    }
  }, [])

  useEffect(() => {
    refreshHistory()
    const id = setInterval(refreshHistory, 3000)
    return () => clearInterval(id)
  }, [refreshHistory])

  useEffect(() => {
    if (project?.revision) refreshHistory()
  }, [project?.revision, refreshHistory])

  const history = historyProp || historyLocal

  /** 记录「已保存版本」；内容 revision 变化后（AI 或手动编辑）→ 标记未保存。 */
  useEffect(() => {
    const contentRevision = contentRevisionOf(project)
    if (!project || !contentRevision) return
    if (cleanRevisionRef.current === null) {
      cleanRevisionRef.current = contentRevision
      return
    }
    if (cleanRevisionRef.current !== contentRevision) setSaveState((prev) => (prev === 'saving' ? prev : 'dirty'))
  }, [project?.contentRevision, project?.revision])

  /* ── 轨道乐观覆盖（音量/静音） ── */
  useEffect(() => {
    setPending({})
  }, [viewProject?.revision])

  const tracks = useMemo(
    () => (viewProject?.tracks ?? []).map((track) => (pending[track.id] ? { ...track, ...pending[track.id] } : track)),
    [viewProject, pending],
  )
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks

  /* ── 选中项校正 ── */
  useEffect(() => {
    if (!viewProject) return
    const projectTracks = viewProject.tracks ?? []
    const patterns = viewProject.patterns ?? []
    const clips = [...(viewProject.clips ?? [])].sort((a, b) => a.startBar - b.startBar)
    const firstClip = clips[0]
    setSelectedTrackId((prev) => (
      projectTracks.some((t) => t.id === prev) ? prev : (firstClip?.trackId ?? projectTracks[0]?.id ?? null)
    ))
    setSelectedPatternId((prev) => (
      patterns.some((p) => p.id === prev) ? prev : (firstClip?.patternId ?? patterns[0]?.id ?? null)
    ))
    setFxTarget((prev) => (
      prev === 'master'
      || String(prev).startsWith('bus:')
      || (String(prev).startsWith('group:') && (project?.groups ?? []).some((group) => `group:${group.id}` === prev))
      || projectTracks.some((t) => t.id === prev)
        ? prev
        : 'master'
    ))
    setSelectedClip((prev) => {
      if (!prev) return prev
      const found = clips.find((clip) => (
        (prev.id && clip.id === prev.id) ||
        (clip.trackId === prev.trackId && clip.patternId === prev.patternId && Number(clip.startBar) === Number(prev.startBar))
      ))
      return found ? { ...found } : null
    })
  }, [viewProject])

  /* ── 播放控制 ── */
  /** P8：首次解锁音频时立即给「正在加载音色库…」轻量提示（引擎轮询 ready 后自动消失）。 */
  const markSoundfontLoadingHint = useCallback(() => {
    const eng = engineRef.current
    if (!eng || eng.unlocked) return
    let loaded = false
    let count = 0
    try {
      loaded = eng.soundfontLoaded === true
      count = Number(eng.soundfontPresetCount) || 0
    } catch (err) { /* engine 无该字段 */ }
    if (loaded || count > 0) return
    soundfontHintStartedRef.current = true
    sawSoundfontLoadingRef.current = true
    setSoundfontStatus((prev) => (prev.state === 'loading' ? prev : { state: 'loading', error: null }))
  }, [])

  const unlockAudio = useCallback(() => {
    const eng = engineRef.current
    if (!eng || eng.unlocked) return
    markSoundfontLoadingHint()
    try {
      actionsRef.current?.unlockAudio?.()
    } catch (err) { /* ignore */ }
  }, [markSoundfontLoadingHint])

  const togglePlay = useCallback(async () => {
    const eng = engineRef.current
    if (!eng) {
      showToast('音频引擎尚未就绪', 'error')
      return
    }
    try {
      if (!eng.unlocked) {
        markSoundfontLoadingHint()
        await actionsRef.current?.unlockAudio?.()
      }
      if (eng.isPlaying) {
        eng.stop()
      } else {
        const engineBar = Number(eng.positionBar)
        const projectBar = Number(projectRef.current?.transport?.playheadBar) || 0
        eng.play(Number.isFinite(engineBar) && engineBar > 0.001 ? engineBar : projectBar)
      }
    } catch (err) {
      showToast('播放失败：请先点击界面启用音频', 'error')
    }
  }, [markSoundfontLoadingHint, showToast])

  /** P3a：录制开始时确保从当前位置播放（不切换停止）。 */
  const startPlayback = useCallback(async () => {
    const eng = engineRef.current
    if (!eng) return false
    try {
      if (!eng.unlocked) {
        markSoundfontLoadingHint()
        await actionsRef.current?.unlockAudio?.()
      }
      if (!eng.isPlaying) {
        const engineBar = Number(eng.positionBar)
        const projectBar = Number(projectRef.current?.transport?.playheadBar) || 0
        eng.play(Number.isFinite(engineBar) && engineBar > 0.001 ? engineBar : projectBar)
      }
      return true
    } catch (err) {
      showToast('播放失败：请先点击界面启用音频', 'error')
      return false
    }
  }, [showToast])

  const toggleKeyboard = useCallback(() => {
    setKeyboardOpen((prev) => {
      if (prev) return false
      setKeyboardExpanded(true)
      return true
    })
  }, [])

  const stopPlayback = useCallback(() => {
    try { engineRef.current?.stop() } catch (err) { /* ignore */ }
  }, [])

  const rewindPlayback = useCallback(() => {
    try { engineRef.current?.seek?.(0) } catch (err) { /* ignore */ }
  }, [])

  /* ── P7：可拖布局 / 折叠 / 紧凑模式（localStorage 记忆） ── */

  const patchLayout = useCallback((patch, options = {}) => {
    setLayout((prev) => {
      const next = sanitizeLayout({
        ...prev,
        ...patch,
        collapsed: { ...prev.collapsed, ...(patch.collapsed ?? {}) },
      })
      layoutRef.current = next
      if (options.persist !== false) persistLayout(next)
      return next
    })
  }, [])

  const toggleCollapsed = useCallback((key) => {
    const current = layoutRef.current?.collapsed ?? {}
    patchLayout({ collapsed: { [key]: !current[key] } })
  }, [patchLayout])

  const toggleCompact = useCallback(() => {
    patchLayout({ compact: !layoutRef.current.compact })
  }, [patchLayout])

  const resetLayout = useCallback(() => {
    const next = sanitizeLayout(LAYOUT_DEFAULTS)
    layoutRef.current = next
    setLayout(next)
    persistLayout(next)
    showToast('布局已重置为默认', 'info')
  }, [showToast])

  const beginColumnDrag = useCallback((side, event) => {
    if (event.button !== 0) return
    if (Number(event.detail) >= 2) {
      /* 双击分隔条：恢复默认宽度（pointerdown detail 在第二次按下时为 2） */
      event.preventDefault()
      patchLayout({ [side === 'left' ? 'leftWidth' : 'rightWidth']: side === 'left' ? LAYOUT_DEFAULTS.leftWidth : LAYOUT_DEFAULTS.rightWidth })
      return
    }
    event.preventDefault()
    const startX = event.clientX
    const startWidth = side === 'left' ? layoutRef.current.leftWidth : layoutRef.current.rightWidth
    const [min, max] = side === 'left' ? LAYOUT_LIMITS.left : LAYOUT_LIMITS.right
    document.body.style.cursor = 'col-resize'
    const onMove = (moveEvent) => {
      const delta = side === 'left' ? moveEvent.clientX - startX : startX - moveEvent.clientX
      const width = Math.round(clamp(startWidth + delta, min, max))
      setLayout((prev) => {
        const next = { ...prev, [side === 'left' ? 'leftWidth' : 'rightWidth']: width }
        layoutRef.current = next
        return next
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      persistLayout(layoutRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  const resetColumnWidth = useCallback((side) => {
    patchLayout({
      [side === 'left' ? 'leftWidth' : 'rightWidth']: side === 'left' ? LAYOUT_DEFAULTS.leftWidth : LAYOUT_DEFAULTS.rightWidth,
    })
  }, [patchLayout])

  const beginKeyboardDrag = useCallback((event) => {
    if (event.button !== 0) return
    if (Number(event.detail) >= 2) {
      event.preventDefault()
      patchLayout({ keyboardHeight: LAYOUT_DEFAULTS.keyboardHeight })
      return
    }
    event.preventDefault()
    const startY = event.clientY
    const startHeight = layoutRef.current.keyboardHeight
    document.body.style.cursor = 'row-resize'
    const onMove = (moveEvent) => {
      const height = Math.round(clamp(startHeight + (startY - moveEvent.clientY), LAYOUT_LIMITS.keyboard[0], LAYOUT_LIMITS.keyboard[1]))
      setLayout((prev) => {
        const next = { ...prev, keyboardHeight: height }
        layoutRef.current = next
        return next
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      persistLayout(layoutRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  /* ── P3b-2：麦克风录音（开始/停止 → 自动导入成音频轨 + 片段） ── */

  /* ── P15：录音输入设备枚举/持久化 ── */
  const refreshInputDevices = useCallback(async () => {
    if (typeof navigator === 'undefined') return
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') return
    try {
      const devices = await mediaDevices.enumerateDevices()
      setInputDevices((devices ?? []).filter((device) => device && device.kind === 'audioinput'))
    } catch (err) {
      /* 无权限/不支持时保留系统默认 */
    }
  }, [])

  useEffect(() => {
    refreshInputDevices()
    if (typeof navigator === 'undefined') return undefined
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices || typeof mediaDevices.addEventListener !== 'function') return undefined
    mediaDevices.addEventListener('devicechange', refreshInputDevices)
    return () => {
      try { mediaDevices.removeEventListener('devicechange', refreshInputDevices) } catch (err) { /* ignore */ }
    }
  }, [refreshInputDevices])

  const selectInputDevice = useCallback((deviceId) => {
    const next = typeof deviceId === 'string' ? deviceId : ''
    setInputDeviceId(next)
    try {
      if (next) localStorage.setItem(INPUT_DEVICE_STORAGE_KEY, next)
      else localStorage.removeItem(INPUT_DEVICE_STORAGE_KEY)
    } catch (err) { /* ignore */ }
    const selected = inputDevices.find((device) => device.deviceId === next)
    showToast(next ? `录音输入设备：${selected?.label || '已选设备'}` : '录音输入设备：系统默认输入', 'info')
  }, [inputDevices, showToast])

  /* R2c：叠录 / 监听开关（监听状态可在录音中切换） */
  const toggleRecordOverdub = useCallback(() => {
    setRecordOverdub((prev) => {
      const next = !prev
      try { localStorage.setItem(OVERDUB_STORAGE_KEY, next ? '1' : '0') } catch (err) { /* ignore */ }
      showToast(next ? '叠录已开启：同位置再次录音将加入同一组 take' : '叠录已关闭：每次录音生成新的 take 组', 'info')
      return next
    })
  }, [showToast, OVERDUB_STORAGE_KEY])

  const toggleRecordMonitor = useCallback(() => {
    setRecordMonitor((prev) => {
      const next = !prev
      try { localStorage.setItem(MONITOR_STORAGE_KEY, next ? '1' : '0') } catch (err) { /* ignore */ }
      const activeRecorder = recordRef.current.recorder
      if (typeof activeRecorder?.setMonitor === 'function') {
        try { activeRecorder.setMonitor(next, MONITOR_GAIN) } catch (err) { /* ignore */ }
      }
      showToast(next
        ? `录音监听已开启（${Math.round(MONITOR_GAIN * 100)}%，请戴耳机防啸叫）`
        : '录音监听已关闭', 'info')
      return next
    })
  }, [showToast, MONITOR_GAIN, MONITOR_STORAGE_KEY])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!window.__AIMS_STANDALONE__ && !window.__AIMS_E2E_FORCE__) return undefined
    const hook = (deviceId) => { selectInputDevice(deviceId) }
    window.__aims = { ...(window.__aims ?? {}), setInputDevice: hook }
    window.__AIMS_E2E__ = { ...(window.__AIMS_E2E__ ?? {}), setInputDevice: hook }
    return () => {
      try {
        if (window.__aims?.setInputDevice === hook) {
          const { setInputDevice: _drop, ...rest } = window.__aims
          if (Object.keys(rest).length > 0) window.__aims = rest
          else delete window.__aims
        }
      } catch (err) { /* ignore */ }
      try {
        if (window.__AIMS_E2E__?.setInputDevice === hook) {
          const { setInputDevice: _drop2, ...rest2 } = window.__AIMS_E2E__
          if (Object.keys(rest2).length > 0) window.__AIMS_E2E__ = rest2
          else delete window.__AIMS_E2E__
        }
      } catch (err) { /* ignore */ }
    }
  }, [selectInputDevice])

  const finishAudioRecording = useCallback(async () => {
    const ref = recordRef.current
    if (!ref.active || ref.stopping || !ref.recorder) return
    ref.stopping = true
    ref.active = false
    clearInterval(ref.timer)
    ref.timer = null
    const recorder = ref.recorder
    const startBar = ref.startBar
    try {
      const result = await recorder.stop()
      /* R2c：录音停止时同时停住 transport，避免播放头继续走导致下一次叠录 startBar 漂移。 */
      try { stopPlayback() } catch (stopError) { /* ignore */ }
      const raw = result?.wav
      const buffer = raw instanceof ArrayBuffer
        ? raw
        : (raw?.buffer instanceof ArrayBuffer ? raw.buffer : null)
      if (!buffer) throw new Error('录音数据为空')
      const fn = actionsRef.current?.importAudio
      if (typeof fn !== 'function') {
        showToast('导入音频接口尚未就绪，录音未保存', 'error')
        return
      }
      const name = recordingFileName()
      const imported = await fn({
        name,
        bytesBase64: arrayBufferToBase64Chunked(buffer),
        durationSeconds: result.durationSeconds,
        channels: result.channels,
        sampleRate: result.sampleRate,
        peaks: result.peaks,
        startBar,
        ...(ref.takeGroup ? { takeGroup: ref.takeGroup, takeIndex: ref.takeIndex } : {}),
      })
      if (imported?.ok === false) {
        showToast('录音保存失败：' + (imported.error || '未知错误'), 'error')
        return
      }
      if (imported?.trackId) setSelectedTrackId(imported.trackId)
      if (imported?.clipId) {
        setSelectedClip({
          id: imported.clipId,
          trackId: imported.trackId,
          mediaId: imported.mediaId,
          startBar: Number(imported.startBar ?? startBar) || 0,
          lengthBars: Number(imported.lengthBars) || 4,
          ...(imported.takeGroup ? { takeGroup: imported.takeGroup } : {}),
          ...(imported.takeIndex !== undefined ? { takeIndex: imported.takeIndex } : {}),
        })
      }
      setTab('playlist')
      const takeNote = ref.takeGroup ? ` · Take ${Number(ref.takeIndex) + 1}` : ''
      showToast(`录音完成：${Number(result.durationSeconds || 0).toFixed(1)}s，已加入音频轨${takeNote}`, 'info')
    } catch (err) {
      showToast('录音结束失败：' + (err?.message ?? err), 'error')
    } finally {
      ref.recorder = null
      ref.stopping = false
      ref.takeGroup = null
      ref.takeIndex = 0
      setRecordState('idle')
      setRecordElapsed(0)
      setRecordLevel(0)
      /* 若用户在上一轮收尾/导入尚未完成时又点了录音，这里安全地启动下一轮。 */
      if (ref.pendingStart) {
        ref.pendingStart = false
        setTimeout(() => {
          const current = recordRef.current
          if (!current.active && !current.starting && !current.stopping) {
            current.startRecording?.()
          }
        }, 0)
      }
    }
  }, [showToast, stopPlayback])

  const startAudioRecording = useCallback(async () => {
    const ref = recordRef.current
    if (ref.active || ref.starting) return
    if (ref.stopping) { ref.pendingStart = true; return }
    ref.starting = true
    const wasPlaying = Boolean(engineRef.current?.isPlaying)
    try {
      const eng = engineRef.current
      if (!eng) {
        showToast('音频引擎尚未就绪', 'error')
        return
      }
      if (!eng.unlocked) {
        markSoundfontLoadingHint()
        try { await actionsRef.current?.unlockAudio?.() } catch (err) { /* 继续尝试录音 */ }
      }
      const started = await startPlayback()
      if (started === false && !engineRef.current?.isPlaying) {
        showToast('无法开始播放，录音已取消', 'error')
        return
      }
      const startBar = Math.max(0, Math.floor(Number(
        engineRef.current?.positionBar ?? projectRef.current?.transport?.playheadBar ?? 0,
      ) || 0))
      /* R2c：叠录时优先同轨道/同 startBar 复用 takeGroup；Host 每次 import 会新建 audio 轨，
         因此找不到同轨时允许跨 audio 轨按同 startBar 复用（优先离当前选中轨最近的组）。 */
      let takeGroup = `take-${Date.now()}`
      let takeIndex = 0
      const currentProject = projectRef.current
      const allTracks = currentProject?.tracks ?? []
      const selectedTrack = allTracks.find((track) => track.id === selectedTrackId)
      if (recordOverdubRef.current) {
        const allClips = currentProject?.clips ?? []
        const candidates = allClips.filter((clip) => (
          clip?.mediaId
          && typeof clip.takeGroup === 'string'
          && clip.takeGroup !== ''
          && Number(clip.startBar) === startBar
        ))
        let chosen = candidates.find((clip) => selectedTrack?.kind === 'audio' && clip.trackId === selectedTrackId) ?? null
        if (!chosen && candidates.length > 0) {
          const order = new Map(allTracks.map((track, index) => [track.id, index]))
          const selectedOrder = selectedTrackId && order.has(selectedTrackId) ? order.get(selectedTrackId) : -1
          chosen = [...candidates].sort((a, b) => (
            Math.abs((order.get(a.trackId) ?? 0) - selectedOrder)
            - Math.abs((order.get(b.trackId) ?? 0) - selectedOrder)
          ))[0] ?? candidates[0]
        }
        if (chosen) {
          takeGroup = chosen.takeGroup
          const indexes = allClips
            .filter((clip) => clip?.mediaId && clip.takeGroup === takeGroup)
            .map((clip) => Math.max(0, Math.floor(Number(clip.takeIndex) || 0)))
          takeIndex = (indexes.length > 0 ? Math.max(...indexes) : -1) + 1
        }
      }
      const recorder = createInputRecorder()
      await recorder.start({
        ...(inputDeviceIdRef.current ? { deviceId: inputDeviceIdRef.current } : {}),
        monitor: recordMonitorRef.current === true,
        monitorGain: MONITOR_GAIN,
        onLevel: (level) => { recordRef.current.level = level },
      })
      ref.recorder = recorder
      ref.startBar = startBar
      ref.takeGroup = takeGroup
      ref.takeIndex = takeIndex
      ref.startedAt = performance.now()
      ref.level = 0
      ref.active = true
      ref.stopping = false
      setRecordState('recording')
      setRecordElapsed(0)
      setRecordLevel(0)
      /* 录音授权成功后设备标签才可见，刷新一次下拉 */
      refreshInputDevices()
      clearInterval(ref.timer)
      ref.timer = setInterval(() => {
        const current = recordRef.current
        if (!current.active) return
        /* 录音器到达 maxSeconds 自动停止时，主动收尾提交 */
        if (current.recorder && current.recorder.isRecording === false) {
          finishAudioRecording()
          return
        }
        const elapsed = current.recorder?.elapsedSeconds
          ?? (performance.now() - current.startedAt) / 1000
        if (elapsed >= 299.9) {
          finishAudioRecording()
          return
        }
        setRecordElapsed(elapsed)
        setRecordLevel(current.level ?? 0)
      }, 120)
    } catch (err) {
      const current = recordRef.current
      try { current.recorder?.cancel?.() } catch (cancelError) { /* ignore */ }
      current.recorder = null
      current.active = false
      clearInterval(current.timer)
      current.timer = null
      setRecordState('idle')
      setRecordElapsed(0)
      setRecordLevel(0)
      refreshInputDevices()
      const deviceError = err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError'
      showToast('录音失败：' + (deviceError
        ? '所选输入设备不可用，请重新选择或使用系统默认输入'
        : (err?.message ?? '无法开始录音')), 'error')
      /* 失败时不留下「为录音而启动」的播放 */
      if (!wasPlaying) {
        try { engineRef.current?.stop?.() } catch (stopError) { /* ignore */ }
      }
    } finally {
      ref.starting = false
    }
  }, [finishAudioRecording, refreshInputDevices, selectedTrackId, showToast, startPlayback])

  recordRef.current.startRecording = startAudioRecording

  const toggleAudioRecording = useCallback(() => {
    const ref = recordRef.current
    if (ref.active) { finishAudioRecording(); return }
    if (ref.stopping) { ref.pendingStart = true; return }
    if (!ref.starting) startAudioRecording()
  }, [finishAudioRecording, startAudioRecording])

  /* 播放自然停止（Space/停止按钮/到结尾）时自动结束录音并提交 */
  const prevPlayingRef = useRef(playing)
  useEffect(() => {
    const was = prevPlayingRef.current
    prevPlayingRef.current = playing
    if (was && !playing && recordRef.current.active) finishAudioRecording()
  }, [playing, finishAudioRecording])

  /* 卸载 / 关闭页面：取消录音、释放麦克风 */
  useEffect(() => {
    const cleanup = () => {
      const ref = recordRef.current
      if (!ref) return
      clearInterval(ref.timer)
      ref.timer = null
      if (ref.recorder) {
        try { ref.recorder.cancel?.() } catch (err) { /* ignore */ }
        ref.recorder = null
      }
      ref.active = false
      ref.starting = false
      ref.stopping = false
    }
    window.addEventListener('beforeunload', cleanup)
    window.addEventListener('pagehide', cleanup)
    return () => {
      window.removeEventListener('beforeunload', cleanup)
      window.removeEventListener('pagehide', cleanup)
      cleanup()
    }
  }, [])

  /* ── 轨道参数写回（乐观 + 去抖） ── */
  const callAction = useCallback(function callActionImpl(name, ...args) {
    const fn = actionsRef.current?.[name]
    if (typeof fn !== 'function') return
    try {
      const result = fn(...args)
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch (err) { /* 宿主不可用：保留乐观状态 */ }
  }, [])

  const toggleMute = useCallback((trackId) => {
    const track = tracksRef.current.find((t) => t.id === trackId)
    if (!track) return
    setPending((prev) => ({ ...prev, [trackId]: { ...prev[trackId], mute: !track.mute } }))
    callAction('toggleMute', trackId)
  }, [callAction])

  const toggleSolo = useCallback((trackId) => {
    const track = tracksRef.current.find((t) => t.id === trackId)
    if (!track) return
    setPending((prev) => ({ ...prev, [trackId]: { ...prev[trackId], solo: !track.solo } }))
    callAction('toggleSolo', trackId)
  }, [callAction])

  const setTrackVolume = useCallback((trackId, value) => {
    const next = clamp(value, 0, 1)
    setPending((prev) => ({ ...prev, [trackId]: { ...prev[trackId], volume: next } }))
    recordAutomationRef.current?.(trackId, 'volume', next)
    clearTimeout(volTimers.current[trackId])
    volTimers.current[trackId] = setTimeout(() => callAction('setVolume', trackId, next), 120)
  }, [callAction])

  const setTrackPan = useCallback((trackId, value) => {
    const next = clamp(value, -1, 1)
    setPending((prev) => ({ ...prev, [trackId]: { ...prev[trackId], pan: next } }))
    recordAutomationRef.current?.(trackId, 'pan', next)
    clearTimeout(panTimers.current[trackId])
    panTimers.current[trackId] = setTimeout(() => callAction('setPan', trackId, next), 150)
  }, [callAction])

  /* ── 编辑：本地乐观 + 一次性写回 ── */
  const applyEditLocally = useCallback((ops) => {
    const current = viewProjectRef.current
    if (!current) return
    const next = applyOpsLocal(current, ops)
    setOverrideProject({ rev: projectRef.current?.revision ?? 0, project: next })
    setSaveState('dirty')
  }, [])

  const runEdit = useCallback(async (ops, label) => {
    const fn = actionsRef.current?.edit
    if (typeof fn !== 'function') {
      showToast('编辑接口尚未就绪（宿主后端需要更新到 P1）', 'error')
      return { ok: false, error: 'edit unavailable' }
    }
    applyEditLocally(ops)
    try {
      const result = await fn(ops)
      if (result && result.ok === false) {
        setOverrideProject(null)
        showToast(result.error || `${label || '编辑'}失败`, 'error')
        return result
      }
      refreshHistory()
      return result || { ok: true }
    } catch (err) {
      setOverrideProject(null)
      showToast(`${label || '编辑'}失败：${err?.message ?? err}`, 'error')
      return { ok: false, error: String(err?.message ?? err) }
    }
  }, [applyEditLocally, refreshHistory, showToast])

  /* R4d：播放中且 track.automationMode !== read 时，把用户音量/声像变化写入当前播放头 beat。
     连续拖动合并为一次 edit（最后一次操作后 200ms 提交），避免每个像素/每次节流一次撤销。 */
  const recordAutomationPoint = useCallback((trackId, param, rawValue) => {
    if (!playingRef.current) return
    const current = viewProjectRef.current
    if (!current) return
    const track = (current.tracks ?? []).find((item) => item.id === trackId)
    if (!track || (track.automationMode ?? 'read') === 'read') return
    const key = `${trackId}:${param}`
    const barBeats = Number(current.timeSignature?.[0]) || 4
    const positionBar = Number(engineRef.current?.positionBar ?? current.transport?.playheadBar ?? 0) || 0
    const totalBeats = Math.max(barBeats, (Number(current.lengthBars) || 1) * barBeats)
    const beat = Math.max(0, Math.min(totalBeats, Math.round(positionBar * barBeats * 4) / 4))
    const existing = automationPendingRef.current.get(key)
    clearTimeout(existing?.timer)
    const timer = setTimeout(() => {
      const pending = automationPendingRef.current.get(key)
      if (!pending) return
      automationPendingRef.current.delete(key)
      if (!playingRef.current) return
      const latest = viewProjectRef.current
      const latestTrack = (latest?.tracks ?? []).find((item) => item.id === trackId)
      if (!latestTrack || (latestTrack.automationMode ?? 'read') === 'read') return
      const currentValue = param === 'pan' ? (Number(pending.rawValue) + 1) / 2 : Number(pending.rawValue)
      const entry = latestTrack.automation?.[param]
      const points = (Array.isArray(entry?.points) ? entry.points : [])
        .filter((point) => point && Math.abs(Number(point.beat) - pending.beat) > 0.01)
        .map((point) => ({ beat: Number(point.beat), value: clamp(point.value, 0, 1) }))
      points.push({ beat: pending.beat, value: clamp(currentValue, 0, 1) })
      points.sort((a, b) => a.beat - b.beat)
      if (points.length > 256) points.splice(0, points.length - 256)
      runEditRef.current?.(
        [{ type: 'setAutomation', target: 'track', trackId, param, points, enabled: true }],
        `写入${param === 'volume' ? '音量' : '声像'}自动化`,
      )
    }, 200)
    automationPendingRef.current.set(key, { trackId, param, rawValue, beat, timer })
  }, [])
  recordAutomationRef.current = recordAutomationPoint
  runEditRef.current = runEdit

  const commitPatternNotes = useCallback((patternId, notes, label) => (
    runEdit([{ type: 'setPatternNotes', patternId, notes }], label || '编辑音符')
  ), [runEdit])

  /** R5d：从插件库点击合成器卡片 → 把当前选中的采样乐器轨切换为 subtractive（或提示先选轨）。 */
  const createSynthTrack = useCallback((presetId) => {
    const instrument = findSynthInstrument(presetId)
    if (!instrument) {
      showToast('未知合成器音色', 'error')
      return
    }
    const current = viewProjectRef.current
    const selected = (current?.tracks ?? []).find((item) => item.id === selectedTrackId)
    if (!selected || selected.kind !== 'synth') {
      showToast('请先选中一条采样乐器轨道，再点击合成器卡片切换为合成器', 'info')
      return
    }
    runEdit([{
      type: 'updateTrack',
      trackId: selected.id,
      engine: 'subtractive',
      synthPreset: presetId,
    }], `切换为合成器 · ${instrument.name}`)
  }, [runEdit, selectedTrackId, showToast])

  const commitClips = useCallback((clips, label) => (
    runEdit([{ type: 'setClips', clips }], label || '移动片段')
  ), [runEdit])

  /* R2a：音频 clip 属性用 /edit editClips update 单点写回（一次撤销）。 */
  const updateAudioClipProps = useCallback(async (clipId, patch, label) => {
    const index = (project?.clips ?? []).findIndex((clip) => clip.id === clipId)
    if (index < 0) return { ok: false }
    const edit = actionsRef.current?.edit
    if (typeof edit !== 'function') {
      showToast('编辑接口尚未就绪（宿主后端需要更新到 P1）', 'error')
      return { ok: false }
    }
    try {
      const result = await edit([{ type: 'editClips', update: [{ index, ...patch }] }])
      if (result && result.ok === false) {
        showToast(result.error || `${label || '调整音频片段属性'}失败`, 'error')
        return result
      }
      refreshHistory()
      return result || { ok: true }
    } catch (error) {
      showToast(`${label || '调整音频片段属性'}失败：${error?.message ?? error}`, 'error')
      return { ok: false }
    }
  }, [project, refreshHistory, showToast])

  /* R2c：切换同组 take 激活（/edit setTakeActive，一次撤销）。 */
  const setTakeActive = useCallback((payload, label) => (
    runEdit([{ type: 'setTakeActive', ...payload }], label || '切换 take')
  ), [runEdit])

  const commitAutomation = useCallback((payload, label) => (
    runEdit([payload], label || '编辑自动化')
  ), [runEdit])

  const clearAutomation = useCallback((payload, label) => (
    runEdit([payload], label || '清除自动化')
  ), [runEdit])

  /** P12：全局速度曲线（优先走 panel 新增的 tempo action；未就绪时回退 setTempoMap 编辑 op）。 */
  const commitTempoMap = useCallback((payload, label) => {
    const points = Array.isArray(payload?.points) ? payload.points : []
    const action = actionsRef.current?.setTempoMap
    if (typeof action === 'function') {
      try {
        const result = action(points)
        if (result && typeof result.catch === 'function') {
          result.catch((error) => showToast?.('速度曲线保存失败：' + (error?.message ?? error), 'error'))
        }
        return result
      } catch (error) {
        showToast?.('速度曲线保存失败：' + (error?.message ?? error), 'error')
        return undefined
      }
    }
    return runEdit([{ type: 'setTempoMap', points }], label || '编辑速度')
  }, [runEdit, showToast])

  const clearTempoMap = useCallback((payload, label) => {
    const action = actionsRef.current?.clearTempoMap
    if (typeof action === 'function') {
      try {
        const result = action()
        if (result && typeof result.catch === 'function') {
          result.catch((error) => showToast?.('清除速度曲线失败：' + (error?.message ?? error), 'error'))
        }
        return result
      } catch (error) {
        showToast?.('清除速度曲线失败：' + (error?.message ?? error), 'error')
        return undefined
      }
    }
    return runEdit([{ type: 'clearTempoMap' }], label || '清除速度')
  }, [runEdit, showToast])

  /** 通用编辑 op（P2b：效果器链 / 侧链）。 */
  const commitEditOp = useCallback((payload, label) => (
    runEdit([payload], label || '编辑')
  ), [runEdit])

  /** P3b：移除轨道（音频轨的「移除轨道」按钮；其它轨道也走同一 op）。 */
  const removeTrack = useCallback((trackId) => (
    runEdit([{ type: 'removeTrack', trackId }], '移除轨道')
  ), [runEdit])

  /* ── P3b：音频导入 ── */

  /** 当前播放头所在小节（导入片段默认落点）。 */
  const currentStartBar = useCallback(() => (
    Math.max(0, Math.floor(Number(engineRef.current?.positionBar ?? viewProjectRef.current?.transport?.playheadBar ?? 0) || 0))
  ), [])

  /** 统一导入入口：文件选择与 E2E 钩子都走这里 → actions.importAudio。 */
  const runAudioImport = useCallback(async (payload) => {
    const fn = actionsRef.current?.importAudio
    if (typeof fn !== 'function') {
      showToast('导入音频接口尚未就绪（宿主需要更新到 P3b）', 'error')
      return { ok: false, error: 'importAudio action unavailable' }
    }
    try {
      const result = await fn(payload)
      if (result?.ok === false) {
        showToast('导入音频失败：' + (result.error || '未知错误'), 'error')
        return result
      }
      // 成功后自动选中新音频轨 + 片段、切回播放列表，便于继续编排
      if (result?.trackId) setSelectedTrackId(result.trackId)
      if (result?.clipId) {
        setSelectedClip({
          id: result.clipId,
          trackId: result.trackId,
          mediaId: result.mediaId,
          startBar: Number(result.startBar ?? payload?.startBar ?? 0) || 0,
          lengthBars: Number(result.lengthBars ?? 4) || 4,
        })
      }
      setTab('playlist')
      return result
    } catch (err) {
      showToast('导入音频失败：' + (err?.message ?? err), 'error')
      return { ok: false, error: err?.message ?? String(err) }
    }
  }, [showToast])

  /** 隐藏 <input type=file> 变化：解码元数据后上传。 */
  const handleAudioFileChange = useCallback(async (event) => {
    const input = event?.currentTarget
    const file = input?.files?.[0] ?? null
    if (!file) return
    try {
      if (file.size > AUDIO_IMPORT_MAX_BYTES) {
        showToast('音频文件过大（上限 30MB）', 'error')
        return
      }
      const startedAt = performance.now()
      let metadata
      try {
        metadata = await decodeAudioMetadata(await file.arrayBuffer())
      } catch (err) {
        showToast('无法解码该音频文件（格式不支持或文件损坏）', 'error')
        return
      }
      const base64 = await readFileAsBase64(file)
      await runAudioImport({
        name: file.name,
        bytesBase64: base64,
        durationSeconds: metadata.durationSeconds,
        channels: metadata.channels,
        sampleRate: metadata.sampleRate,
        peaks: metadata.peaks,
        startBar: currentStartBar(),
        clientDecodeMs: Math.round(performance.now() - startedAt),
      })
    } catch (err) {
      showToast('导入音频失败：' + (err?.message ?? err), 'error')
    } finally {
      if (input) input.value = ''
    }
  }, [currentStartBar, runAudioImport, showToast])

  const triggerImportAudio = useCallback(() => {
    const input = fileInputRef.current
    if (!input) {
      showToast('找不到文件输入框（界面未就绪）', 'error')
      return
    }
    try { input.click() } catch (err) {
      showToast('无法打开文件选择器', 'error')
    }
  }, [showToast])

  const importRunnerRef = useRef(runAudioImport)
  importRunnerRef.current = runAudioImport
  const startBarRef = useRef(currentStartBar)
  startBarRef.current = currentStartBar

  /* ── P14a：MIDI 导入（菜单 / 隐藏 input / 无头钩子共用） ── */
  const MIDI_IMPORT_MAX_BYTES = 10 * 1024 * 1024
  const runMidiImport = useCallback(async (name, base64) => {
    if (!base64 || typeof base64 !== 'string') {
      showToast('导入 MIDI 失败：没有收到文件数据', 'error')
      return { ok: false, error: 'empty base64' }
    }
    try {
      const res = await fetch('/studio/api/import-midi', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name: name || '导入.mid', dataBase64: base64, replace: true }),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok || (payload && payload.ok === false)) {
        throw new Error(payload?.error || `导入 MIDI 失败（HTTP ${res.status}）`)
      }
      setTab('playlist')
      setSelectedClip(null)
      showToast(`MIDI 导入完成：${name || '导入.mid'}`, 'info')
      return { ok: true, payload }
    } catch (err) {
      showToast('导入 MIDI 失败：' + (err?.message ?? err), 'error')
      return { ok: false, error: err?.message ?? String(err) }
    }
  }, [showToast])
  const midiRunnerRef = useRef(runMidiImport)
  midiRunnerRef.current = runMidiImport

  const handleMidiFileChange = useCallback(async (event) => {
    const input = event?.currentTarget
    const file = input?.files?.[0] ?? null
    if (!file) return
    try {
      if (file.size > MIDI_IMPORT_MAX_BYTES) {
        showToast('MIDI 文件过大（上限 10MB）', 'error')
        return
      }
      const base64 = await readFileAsBase64(file)
      await runMidiImport(file.name, base64)
    } catch (err) {
      showToast('导入 MIDI 失败：' + (err?.message ?? err), 'error')
    } finally {
      if (input) input.value = ''
    }
  }, [runMidiImport, showToast])

  const triggerImportMidi = useCallback(() => {
    const input = midiInputRef.current
    if (!input) {
      showToast('找不到 MIDI 文件输入框（界面未就绪）', 'error')
      return
    }
    try { input.click() } catch (err) {
      showToast('无法打开文件选择器', 'error')
    }
  }, [showToast])

  /** 无头 E2E：window.__aims.importMidiBase64(name, base64)（同时挂到 __AIMS_E2E__ 兼容旧测试）。 */
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!window.__AIMS_STANDALONE__ && !window.__AIMS_E2E_FORCE__) return undefined
    const hook = async (name, base64) => midiRunnerRef.current(name || 'import.mid', base64)
    window.__aims = { ...(window.__aims ?? {}), importMidiBase64: hook }
    window.__AIMS_E2E__ = { ...(window.__AIMS_E2E__ ?? {}), importMidiBase64: hook }
    return () => {
      try {
        if (window.__aims?.importMidiBase64 === hook) {
          const { importMidiBase64: _drop, ...rest } = window.__aims
          if (Object.keys(rest).length > 0) window.__aims = rest
          else delete window.__aims
        }
      } catch (err) { /* ignore */ }
      try {
        if (window.__AIMS_E2E__?.importMidiBase64 === hook) {
          const { importMidiBase64: _drop2, ...rest2 } = window.__AIMS_E2E__
          if (Object.keys(rest2).length > 0) window.__AIMS_E2E__ = rest2
          else delete window.__AIMS_E2E__
        }
      } catch (err) { /* ignore */ }
    }
  }, [])

  /* ── P14b：参考曲导入（reference 音频轨） ── */
  const runReferenceImport = useCallback(async ({ name, base64, meta = {} } = {}) => {
    const fn = actionsRef.current?.importAudio
    if (typeof fn !== 'function') {
      showToast('导入参考曲失败：导入接口尚未就绪', 'error')
      return { ok: false, error: 'importAudio unavailable' }
    }
    try {
      const result = await fn({
        name: name || '参考曲.wav',
        bytesBase64: base64,
        durationSeconds: meta.durationSeconds ?? meta.duration ?? 0,
        channels: meta.channels ?? 2,
        sampleRate: meta.sampleRate ?? 44100,
        peaks: Array.isArray(meta.peaks) ? meta.peaks : [],
        startBar: 0,
        reference: true,
      })
      if (result?.ok === false) return result
      if (result?.trackId) setSelectedTrackId(result.trackId)
      setTab('playlist')
      return result ?? { ok: true }
    } catch (err) {
      showToast('导入参考曲失败：' + (err?.message ?? err), 'error')
      return { ok: false, error: err?.message ?? String(err) }
    }
  }, [showToast])
  const referenceRunnerRef = useRef(runReferenceImport)
  referenceRunnerRef.current = runReferenceImport

  const handleReferenceFileChange = useCallback(async (event) => {
    const input = event?.currentTarget
    const file = input?.files?.[0] ?? null
    if (!file) return
    try {
      if (file.size > AUDIO_IMPORT_MAX_BYTES) {
        showToast('参考曲文件过大（上限 30MB）', 'error')
        return
      }
      let metadata = {}
      try { metadata = await decodeAudioMetadata(await file.arrayBuffer()) } catch (err) { metadata = {} }
      const base64 = await readFileAsBase64(file)
      await runReferenceImport({ name: file.name, base64, meta: metadata })
    } catch (err) {
      showToast('导入参考曲失败：' + (err?.message ?? err), 'error')
    } finally {
      if (input) input.value = ''
    }
  }, [runReferenceImport, showToast])

  const triggerImportReference = useCallback(() => {
    const input = referenceInputRef.current
    if (!input) {
      showToast('找不到参考曲文件输入框（界面未就绪）', 'error')
      return
    }
    try { input.click() } catch (err) {
      showToast('无法打开文件选择器', 'error')
    }
  }, [showToast])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!window.__AIMS_STANDALONE__ && !window.__AIMS_E2E_FORCE__) return undefined
    const hook = async (name, base64, meta = {}) => {
      let info = { ...meta }
      if (info.durationSeconds === undefined && info.duration === undefined && base64) {
        try {
          const binary = atob(String(base64).replace(/\s+/g, ''))
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
          info = { ...(await decodeAudioMetadata(bytes.buffer)), ...meta }
        } catch (err) { /* 交给 host 处理 */ }
      }
      return referenceRunnerRef.current({ name: name || '参考曲.wav', base64, meta: info })
    }
    window.__aims = { ...(window.__aims ?? {}), importReferenceBase64: hook }
    window.__AIMS_E2E__ = { ...(window.__AIMS_E2E__ ?? {}), importReferenceBase64: hook }
    return () => {
      try {
        if (window.__aims?.importReferenceBase64 === hook) {
          const { importReferenceBase64: _drop, ...rest } = window.__aims
          if (Object.keys(rest).length > 0) window.__aims = rest
          else delete window.__aims
        }
      } catch (err) { /* ignore */ }
      try {
        if (window.__AIMS_E2E__?.importReferenceBase64 === hook) {
          const { importReferenceBase64: _drop2, ...rest2 } = window.__AIMS_E2E__
          if (Object.keys(rest2).length > 0) window.__AIMS_E2E__ = rest2
          else delete window.__AIMS_E2E__
        }
      } catch (err) { /* ignore */ }
    }
  }, [])

  /** 无头 E2E：直接传 base64 + 元数据，走与文件导入相同的 action。 */
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!window.__AIMS_STANDALONE__ && !window.__AIMS_E2E_FORCE__) return undefined
    const hook = async (name, base64, meta = {}) => importRunnerRef.current({
      name: name || '导入音频.wav',
      bytesBase64: base64,
      durationSeconds: meta.durationSeconds ?? meta.duration ?? 0,
      channels: meta.channels ?? 2,
      sampleRate: meta.sampleRate ?? 44100,
      peaks: Array.isArray(meta.peaks) ? meta.peaks : [],
      startBar: meta.startBar ?? startBarRef.current(),
    })
    window.__AIMS_E2E__ = { ...(window.__AIMS_E2E__ ?? {}), importAudioBase64: hook }
    return () => {
      const api = window.__AIMS_E2E__
      if (!api) return
      if (api.importAudioBase64 === hook) {
        const { importAudioBase64: _drop, ...rest } = api
        if (Object.keys(rest).length > 0) window.__AIMS_E2E__ = rest
        else {
          try { delete window.__AIMS_E2E__ } catch (err) { window.__AIMS_E2E__ = undefined }
        }
      }
    }
  }, [])

  /* ── 撤销 / 重做 ── */
  const doUndo = useCallback(async () => {
    const fn = actionsRef.current?.undo
    if (typeof fn !== 'function') {
      showToast('撤销接口尚未就绪（宿主后端需要更新到 P1）', 'error')
      return
    }
    setOverrideProject(null)
    try {
      const result = await fn()
      if (result && result.ok === false) {
        showToast(result.error || '撤销失败', 'error')
        return
      }
      setSaveState('dirty')
      setHistoryLocal((prev) => ({ ...prev, canUndo: result?.canUndo ?? false, canRedo: result?.canRedo ?? true }))
      refreshHistory()
    } catch (err) {
      showToast('撤销失败：' + (err?.message ?? err), 'error')
    }
  }, [refreshHistory, showToast])

  const doRedo = useCallback(async () => {
    const fn = actionsRef.current?.redo
    if (typeof fn !== 'function') {
      showToast('重做接口尚未就绪（宿主后端需要更新到 P1）', 'error')
      return
    }
    setOverrideProject(null)
    try {
      const result = await fn()
      if (result && result.ok === false) {
        showToast(result.error || '重做失败', 'error')
        return
      }
      setSaveState('dirty')
      setHistoryLocal((prev) => ({ ...prev, canUndo: result?.canUndo ?? true, canRedo: result?.canRedo ?? false }))
      refreshHistory()
    } catch (err) {
      showToast('重做失败：' + (err?.message ?? err), 'error')
    }
  }, [refreshHistory, showToast])

  /* ── R6c：AI 变更日志（只读轮询；revision 变化后刷新） ── */
  const refreshAiChanges = useCallback(async () => {
    const fn = actionsRef.current?.aiChanges
    if (typeof fn !== 'function') return
    try {
      const result = await fn(10)
      if (result && result.ok !== false) {
        setAiChangeData({
          changes: Array.isArray(result.changes) ? result.changes : [],
          canUndo: Boolean(result.canUndo),
          canRedo: Boolean(result.canRedo),
        })
      }
    } catch (err) {
      /* 日志读取失败不影响主界面 */
    }
  }, [])

  useEffect(() => {
    refreshAiChanges()
  }, [project?.revision, refreshAiChanges])

  const latestAiChange = aiChangeData.changes[0] ?? null
  const aiChangeVisible = Boolean(latestAiChange) && aiChangeDismissed !== latestAiChange.id
  const dismissAiChange = useCallback(() => {
    if (latestAiChange) setAiChangeDismissed(latestAiChange.id)
  }, [latestAiChange])
  const aiChangeUndo = useCallback(async () => {
    await doUndo()
    refreshAiChanges()
  }, [doUndo, refreshAiChanges])
  const aiChangeRedo = useCallback(async () => {
    await doRedo()
    refreshAiChanges()
  }, [doRedo, refreshAiChanges])

  /* ── R7a：首次启动新手引导（非阻塞） ── */
  const dismissOnboarding = useCallback(() => {
    setOnboardingVisible(false)
    try { window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1') } catch (err) { /* ignore */ }
  }, [])
  const startOnboarding = useCallback(() => {
    dismissOnboarding()
    setDialog({ type: 'projects', mode: 'new' })
  }, [dismissOnboarding])

  /* ── 选择 ── */
  const selectTrack = useCallback((trackId) => {
    if (!trackId) return
    setSelectedTrackId(trackId)
    setFxTarget(trackId)
  }, [])

  const selectClip = useCallback((clip) => {
    if (!clip) {
      setSelectedClip(null)
      return
    }
    setSelectedClip({ ...clip })
    setSelectedTrackId(clip.trackId)
    setSelectedPatternId(clip.patternId)
    setFxTarget(clip.trackId)
  }, [])

  const openClip = useCallback((clip) => {
    selectClip(clip)
    if (clip?.mediaId) {
      showToast('音频片段：请在播放列表拖动/裁剪，不支持钢琴卷帘', 'info')
      return
    }
    setTab('pianoroll')
  }, [selectClip, showToast])

  const selectPattern = useCallback((patternId) => {
    if (!patternId) return
    setSelectedPatternId(patternId)
  }, [])

  /** P2c：从通道机架（步进音序器/合成器提示）跳到钢琴卷帘编辑当前 pattern。 */
  const openPatternInPianoRoll = useCallback((patternId) => {
    if (patternId) setSelectedPatternId(patternId)
    setTab('pianoroll')
  }, [])

  const selectFxTarget = useCallback((target) => {
    setFxTarget(target)
    if (target !== 'master' && !String(target).startsWith('bus:') && !String(target).startsWith('group:')) setSelectedTrackId(target)
  }, [])

  /** R4a：选中编组通道 → FxRack target group。 */
  const selectGroup = useCallback((groupId) => {
    if (!groupId) return
    setFxTarget(`group:${groupId}`)
  }, [])

  /** P2c-2：返回总线（reverb/delay）选中状态，供 Mixer 高亮 & FxRack 联动。 */
  const selectBus = useCallback((busId) => {
    if (!busId) return
    setFxTarget(`bus:${busId}`)
  }, [])

  /* ── 导出 WAV / MIDI / MP3 / FLAC / LUFS ── */
  const handleExport = useCallback(async (options = null) => {
    if (exportBusyRef.current) return
    if (typeof actionsRef.current?.exportWav !== 'function') {
      showToast('导出接口尚未就绪', 'error')
      return
    }
    exportBusyRef.current = true
    setExportBusy(true)
    try {
      // v2.1：手动导出（菜单/命令面板）默认触发浏览器下载；AI silent 导出不经过这里。
      const manualOptions = { download: true, ...(options && typeof options === 'object' ? options : {}) }
      await actionsRef.current.exportWav(manualOptions)
    } catch (err) {
      /* 宿主 toast 提示失败原因 */
    } finally {
      exportBusyRef.current = false
      setExportBusy(false)
    }
  }, [showToast])

  /* P14b：A/B 参考曲（保存原 mute/solo；开启时非参考轨静音，关闭恢复） */
  const toggleAB = useCallback(() => {
    const current = viewProjectRef.current
    const ref = (current?.tracks ?? []).find((track) => track && track.reference === true)
    if (!ref) {
      showToast('先导入参考曲：文件 → 导入参考曲…', 'error')
      return
    }
    if (!abMode) {
      const saved = {}
      const ops = []
      for (const track of current?.tracks ?? []) {
        if (!track?.id) continue
        saved[track.id] = { mute: Boolean(track.mute), solo: Boolean(track.solo) }
        const mute = track.id !== ref.id
        if (Boolean(track.mute) !== mute || Boolean(track.solo)) {
          ops.push({ type: 'updateTrack', trackId: track.id, mute, solo: false })
        }
      }
      abSavedRef.current = saved
      setAbMode(true)
      showToast('A/B：参考曲（非参考轨已静音）', 'info')
      if (ops.length) runEdit(ops, 'A/B 切换到参考曲')
    } else {
      const saved = abSavedRef.current
      const ops = []
      if (saved) {
        for (const track of current?.tracks ?? []) {
          const prev = saved[track?.id]
          if (!prev) continue
          ops.push({ type: 'updateTrack', trackId: track.id, mute: Boolean(prev.mute), solo: Boolean(prev.solo) })
        }
      }
      abSavedRef.current = null
      setAbMode(false)
      showToast('A/B：工程（已恢复原 mute/solo）', 'info')
      if (ops.length) runEdit(ops, 'A/B 恢复工程')
    }
  }, [abMode, runEdit, showToast])

  const handleExportMidi = useCallback(async () => {
    const fn = actionsRef.current?.exportMidi
    if (typeof fn !== 'function') {
      showToast('MIDI 导出接口尚未就绪（宿主后端需要更新到 P1）', 'error')
      return
    }
    try {
      const result = await fn()
      if (result && result.ok === false) showToast(result.error || '导出 MIDI 失败', 'error')
    } catch (err) {
      showToast('导出 MIDI 失败：' + (err?.message ?? err), 'error')
    }
  }, [showToast])

  const handleExportStems = useCallback(async () => {
    const fn = actionsRef.current?.exportStems
    if (typeof fn !== 'function') {
      showToast('分轨导出接口尚未就绪（宿主后端需要更新到 P2b）', 'error')
      return
    }
    try {
      const result = await fn()
      if (result && result.ok === false) showToast(result.error || '分轨导出失败', 'error')
    } catch (err) {
      showToast('分轨导出失败：' + (err?.message ?? err), 'error')
    }
  }, [showToast])

  /* ── 工程保存 / 对话框 ── */
  const currentProjectName = projectInfoProp?.name || savedName || ''
  const projectInfo = useMemo(() => ({
    name: currentProjectName,
    activeSavedAt: projectInfoProp?.activeSavedAt ?? 0,
    title: viewProject?.title ?? project?.title ?? '',
    bpm: viewProject?.bpm ?? project?.bpm ?? 0,
  }), [currentProjectName, projectInfoProp?.activeSavedAt, viewProject?.title, viewProject?.bpm, project?.title, project?.bpm])

  const doSave = useCallback(async () => {
    const fn = actionsRef.current?.saveProject
    if (typeof fn !== 'function') {
      showToast('保存接口尚未就绪（宿主后端需要更新到 P1）', 'error')
      return
    }
    setSaveState('saving')
    try {
      const result = await fn()
      if (result && result.ok === false) {
        setSaveState('dirty')
        showToast(result.error || '保存失败', 'error')
        return
      }
      const name = result?.activeName || currentProjectName || projectRef.current?.title || '当前工程'
      const savedContent = Number(result?.savedContentRevision ?? result?.contentRevision)
      cleanRevisionRef.current = Number.isFinite(savedContent) ? savedContent : contentRevisionOf(projectRef.current)
      setSaveState('saved')
      setSavedName(name)
      refreshHistory()
    } catch (err) {
      setSaveState('dirty')
      showToast('保存失败：' + (err?.message ?? err), 'error')
    }
  }, [currentProjectName, refreshHistory, showToast])

  /** 工程对话框 API 桥：全部走 actionsRef，避免 panel 每帧重建 actions 导致的引用抖动。 */
  const projectApi = useMemo(() => {
    const call = async (name, ...args) => {
      const fn = actionsRef.current?.[name]
      if (typeof fn !== 'function') return { ok: false, error: '宿主工程接口尚未就绪，请重启独立窗口版' }
      try {
        const result = await fn(...args)
        return result ?? { ok: true }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    }
    return {
      listProjects: () => call('listProjects'),
      newProject: (opts) => call('newProject', opts),
      saveProject: () => call('saveProject'),
      saveProjectAs: (name) => call('saveProjectAs', name),
      openProject: (name) => call('openProject', name),
      deleteProject: (name) => call('deleteProject', name),
      /* P14a：工程版本历史（host 路由直连；成功后 state 长轮询会自动刷新） */
      listProjectVersions: async (name) => {
        try {
          const res = await fetch(`/studio/api/project-versions?name=${encodeURIComponent(name)}`, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok) return { ok: false, error: payload?.error || `读取历史失败（HTTP ${res.status}）` }
          return payload ?? { ok: true, versions: [] }
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) }
        }
      },
      restoreProjectVersion: async (name, id) => {
        try {
          const res = await fetch('/studio/api/project-versions/restore', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ name, id }),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || (payload && payload.ok === false)) {
            return { ok: false, error: payload?.error || `恢复历史失败（HTTP ${res.status}）` }
          }
          return payload ?? { ok: true }
        } catch (err) {
          return { ok: false, error: String(err?.message ?? err) }
        }
      },
    }
  }, [])

  const handleProjectComplete = useCallback((result) => {
    setDialog(null)
    if (!result) return
    setOverrideProject(null)
    if (result.type === 'open' || result.type === 'new') {
      setSelectedClip(null)
      setTab('playlist')
      if (result.name) setSavedName(result.name)
      setSaveState('saved')
      cleanRevisionRef.current = null
      refreshHistory()
    } else if (result.type === 'save' || result.type === 'saveAs') {
      if (result.name) setSavedName(result.name)
      setSaveState('saved')
      cleanRevisionRef.current = contentRevisionOf(projectRef.current)
      refreshHistory()
    } else if (result.type === 'restore') {
      if (result.name) setSavedName(result.name)
      setSelectedClip(null)
      setTab('playlist')
      setSaveState('saved')
      cleanRevisionRef.current = null
      refreshHistory()
      showToast?.('已恢复历史版本', 'info')
    }
  }, [refreshHistory, showToast])

  /* ── 编辑器命令（菜单栏 Edit 菜单 → 当前编辑视图） ── */
  const sendEditorCommand = useCallback((type) => {
    editorSeqRef.current += 1
    setEditorCommand({ seq: editorSeqRef.current, type })
  }, [])

  /* ── 菜单栏命令 ── */
  const onMenuCommand = useCallback((id) => {
    switch (id) {
      case 'new': setDialog({ type: 'projects', mode: 'new' }); break
      case 'open': case 'projects': setDialog({ type: 'projects', mode: 'browse' }); break
      case 'save': doSave(); break
      case 'saveAs': setDialog({ type: 'projects', mode: 'saveAs' }); break
      case 'exportWav': if (projectHasExternalPlugins(viewProject)) setDialog({ type: 'export', format: 'wav' }); else handleExport(); break
      case 'exportMp3': if (projectHasExternalPlugins(viewProject)) setDialog({ type: 'export', format: 'mp3' }); else handleExport({ format: 'mp3' }); break
      case 'exportFlac': if (projectHasExternalPlugins(viewProject)) setDialog({ type: 'export', format: 'flac' }); else handleExport({ format: 'flac' }); break
      case 'exportLufs': if (projectHasExternalPlugins(viewProject)) setDialog({ type: 'export', format: 'wav', targetLufs: -14 }); else handleExport({ format: 'wav', targetLufs: -14 }); break
      case 'exportMidi': handleExportMidi(); break
      case 'exportStems': handleExportStems(); break
      case 'importAudio': triggerImportAudio(); break
      case 'importMidi': triggerImportMidi(); break
      case 'importReference': triggerImportReference(); break
      case 'undo': doUndo(); break
      case 'redo': doRedo(); break
      case 'copy': case 'paste': case 'delete': case 'selectAll': case 'quantize':
        sendEditorCommand(id)
        break
      case 'splitAudio':
        setTab('playlist')
        sendEditorCommand('splitAudio')
        break
      case 'view:playlist': case 'view:pianoroll': case 'view:mixer': case 'view:fx': case 'view:automation':
        setTab(id.slice(5))
        break
      case 'zoomIn': setPianoZoom((prev) => cycleZoom(prev, 1)); break
      case 'zoomOut': setPianoZoom((prev) => cycleZoom(prev, -1)); break
      case 'zoomReset': setPianoZoom(1); break
      case 'toggleRightRail': toggleCollapsed('rightRail'); break
      case 'layout:toggleLeft': toggleCollapsed('leftRail'); break
      case 'layout:togglePlugin': toggleCollapsed('pluginBrowser'); break
      case 'layout:toggleAiFeed': toggleCollapsed('aiFeed'); break
      case 'layout:toggleProjectStats': toggleCollapsed('projectStats'); break
      case 'layout:toggleSpectrum': toggleCollapsed('spectrum'); break
      case 'layout:compact': toggleCompact(); break
      case 'layout:reset': resetLayout(); break
      case 'shortcuts': setDialog({ type: 'shortcuts' }); break
      case 'help': setDialog({ type: 'help' }); break
      case 'about': setDialog({ type: 'about' }); break
      case 'settings': setDialog({ type: 'settings' }); break
      case 'command-palette': setCommandOpen(true); break
      default: break
    }
  }, [doRedo, doSave, doUndo, handleExport, handleExportMidi, handleExportStems, resetLayout, sendEditorCommand, toggleCollapsed, toggleCompact, triggerImportAudio, triggerImportMidi, triggerImportReference, viewProject])

  /* ── 快捷键（Space/Home/Ctrl+Z/Y/S/Shift+S/N/O/?/H；忽略 repeat 与输入框） ── */
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      if (isTypingTarget(event.target)) return
      if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key || '').toLowerCase() === 'k') {
        event.preventDefault()
        if (!dialogRef.current) setCommandOpen(true)
        return
      }
      if (dialogRef.current) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setDialog(null)
        }
        return
      }
      const meta = event.ctrlKey || event.metaKey
      const key = String(event.key || '').toLowerCase()

      // P3a：键盘面板展开时，A/W/S…/Z/X 交给演奏，不触发全局快捷键（Space/Home/Ctrl 保留）
      if (!meta && !event.altKey && keyboardActiveRef.current && KEYBOARD_CAPTURE_KEYS.has(key)) return

      if (!meta && !event.altKey && (event.code === 'Space' || event.code === 'Home')) {
        if (Date.now() - lastSpaceRef.current < 250) return
        lastSpaceRef.current = Date.now()
        event.preventDefault()
        if (event.code === 'Space') togglePlay()
        else rewindPlayback()
        return
      }
      if (!meta && !event.altKey && tab === 'pianoroll' && key === 'h') {
        if (throttleKeydown(shortcutThrottleRef, event.shiftKey ? 'shift+h' : 'h', 200)) return
        event.preventDefault()
        setPianoZoom((prev) => cycleZoom(prev, event.shiftKey ? -1 : 1))
        return
      }
      if (!meta && !event.altKey && (key === 'a' || event.code === 'KeyA')) {
        if (throttleKeydown(shortcutThrottleRef, 'a', 200)) return
        event.preventDefault()
        setTab('automation')
        return
      }
      if (!meta && !event.altKey && (event.key === '?' || (event.key === '/' && event.shiftKey))) {
        event.preventDefault()
        setDialog({ type: 'help' })
        return
      }
      if (!meta || event.altKey) return
      const combo = `${key}${event.shiftKey ? '+shift' : ''}`
      if (throttleKeydown(shortcutThrottleRef, combo, 200)) return
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        doUndo()
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault()
        doRedo()
      } else if (key === 's' && event.shiftKey) {
        event.preventDefault()
        setDialog({ type: 'projects', mode: 'saveAs' })
      } else if (key === 's') {
        event.preventDefault()
        doSave()
      } else if (key === 'n') {
        event.preventDefault()
        setDialog({ type: 'projects', mode: 'new' })
      } else if (key === 'o') {
        event.preventDefault()
        setDialog({ type: 'projects', mode: 'browse' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [doRedo, doSave, doUndo, rewindPlayback, tab, togglePlay])

  const copyPrompt = useCallback(async (item) => {
    const text = item?.prompt ?? item?.title ?? ''
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        showToast('提示词已复制，粘贴到对话框发给 AI 即可', 'success')
      } else {
        showToast('请手动在对话框描述你的想法', 'info')
      }
    } catch (err) {
      showToast('复制失败，请手动输入提示词', 'error')
    }
  }, [showToast])

  const showLoopInfo = useCallback((loopStart, loopEnd) => {
    const bars = Math.max(0, Number(loopEnd) - Number(loopStart))
    const songBars = Number(projectRef.current?.lengthBars) || 0
    if (bars <= 0) showToast('当前没有启用的循环区间，AI 可通过 studio_transport 设置循环', 'info')
    else if (bars >= songBars) showToast(`循环范围：整首（第 1 至 ${loopEnd} 小节）· 由 AI 设置`, 'info')
    else showToast(`循环范围：第 ${Number(loopStart) + 1} 至 ${loopEnd} 小节（${bars} 小节）· 由 AI 设置`, 'info')
  }, [showToast])

  /* ── 派生数据 ── */
  const trackList = viewProject?.tracks ?? []
  const isEmpty = !viewProject || trackList.length === 0
  const selectedPattern = useMemo(
    () => (viewProject?.patterns ?? []).find((p) => p.id === selectedPatternId) ?? null,
    [viewProject, selectedPatternId],
  )
  const fxEffectCount = useMemo(() => {
    if (!viewProject) return 0
    if (fxTarget === 'master') return (viewProject.master?.effects ?? []).length
    if (typeof fxTarget === 'string' && fxTarget.startsWith('bus:')) {
      const busId = fxTarget.slice(4)
      const rawBus = viewProject.buses?.[busId]
      const bus = typeof rawBus === 'number' ? { level: rawBus, effects: [] } : rawBus
      return (bus?.effects ?? []).length
    }
    if (typeof fxTarget === 'string' && fxTarget.startsWith('group:')) {
      const groupId = fxTarget.slice(6)
      return ((viewProject.groups ?? []).find((group) => group.id === groupId)?.effects ?? []).length
    }
    return (viewProject.tracks.find((t) => t.id === fxTarget)?.effects ?? []).length
  }, [viewProject, fxTarget])

  const selectedBus = typeof fxTarget === 'string' && fxTarget.startsWith('bus:') ? fxTarget.slice(4) : null
  const selectedGroup = typeof fxTarget === 'string' && fxTarget.startsWith('group:') ? fxTarget.slice(6) : null

  /** 已存在的自动化曲线数量（有点或显式禁用的参数算 1 条）。 */
  const automationCount = useMemo(() => {
    if (!viewProject) return 0
    let count = 0
    const countEntry = (entry) => {
      if (!entry) return
      if ((entry.points?.length ?? 0) > 0 || entry.enabled === false) count += 1
    }
    for (const track of viewProject.tracks ?? []) {
      for (const key of ['volume', 'pan', 'cutoff']) countEntry(track.automation?.[key])
    }
    countEntry(viewProject.master?.automation?.volume)
    return count
  }, [viewProject])

  const tabCounts = {
    playlist: viewProject?.clips?.length ?? 0,
    pianoroll: selectedPattern?.notes?.length ?? 0,
    mixer: trackList.length,
    fx: fxEffectCount,
    automation: automationCount,
  }

  const editable = typeof actions?.edit === 'function'
  const exporting = exportBusy || Boolean(exportingProp)

  const paletteCommands = [
    { id: 'new', label: translate(locale, 'cmd.new'), shortcut: 'Ctrl+N', run: () => setDialog({ type: 'projects', mode: 'new' }) },
    { id: 'open', label: translate(locale, 'cmd.open'), shortcut: 'Ctrl+O', run: () => setDialog({ type: 'projects', mode: 'browse' }) },
    { id: 'save', label: translate(locale, 'cmd.save'), shortcut: 'Ctrl+S', run: () => doSave() },
    { id: 'export-wav', label: translate(locale, 'cmd.exportWav'), keywords: 'export render audio', run: () => { if (projectHasExternalPlugins(viewProject)) setDialog({ type: 'export', format: 'wav' }); else handleExport() } },
    { id: 'play', label: translate(locale, 'cmd.play'), shortcut: 'Space', run: () => startPlayback() },
    { id: 'stop', label: translate(locale, 'cmd.stop'), run: () => stopPlayback() },
    { id: 'undo', label: translate(locale, 'cmd.undo'), shortcut: 'Ctrl+Z', run: () => doUndo() },
    { id: 'redo', label: translate(locale, 'cmd.redo'), shortcut: 'Ctrl+Shift+Z', run: () => doRedo() },
    { id: 'help', label: translate(locale, 'cmd.help'), run: () => setDialog({ type: 'help' }) },
    { id: 'settings', label: translate(locale, 'cmd.settings'), keywords: 'preferences channel telemetry crash 遥测 崩溃', run: () => setDialog({ type: 'settings' }) },
    { id: 'about', label: translate(locale, 'cmd.about'), keywords: 'version update', run: () => setDialog({ type: 'about' }) },
    { id: 'command', label: translate(locale, 'cmd.command'), shortcut: 'Ctrl+K', run: () => setCommandOpen(true) },
  ]

  /* ── 加载骨架 ── */
  if (!project) {
    return (
      <div className="aims-root" style={ROOT_STYLE}>
        <div className="aims-boot">
          <div className="aims-boot-mark"><IconWave size={26} /></div>
          <div className="aims-boot-title">AI 音乐工作室</div>
          <div className="aims-boot-sub">正在载入工程与音频引擎…</div>
          <div className="aims-boot-bar"><span /></div>
          <div className="aims-boot-hint">连接宿主 /studio/api/state</div>
        </div>
      </div>
    )
  }

  return (
    <I18nContext.Provider value={{ locale, t, setLocale }}>
    <div
      className={`aims-root ${hostError ? 'has-host-error' : ''} ${layout.compact ? 'is-compact' : ''}`}
      style={ROOT_STYLE}
      onClick={unlockAudio}
    >
      <MenuBar
        projectName={currentProjectName || viewProject?.title || ''}
        projectTitle={viewProject?.title ?? ''}
        saveState={saveState}
        standalone={Boolean(standalone)}
        canUndo={Boolean(history?.canUndo)}
        canRedo={Boolean(history?.canRedo)}
        undoLabel={history?.undoLabel ?? ''}
        redoLabel={history?.redoLabel ?? ''}
        activeTab={tab}
        showRightRail={!layout.collapsed.rightRail}
        layout={layout}
        onCommand={onMenuCommand}
      />

      <TransportBar
        project={viewProject}
        engine={engine}
        playing={playing}
        activity={viewProject.activity}
        exporting={exporting}
        exportPhase={exportPhase}
        hostError={Boolean(hostError)}
        audioUnlocked={unlocked}
        history={history}
        projectInfo={projectInfo}
        saveState={saveState}
        onPlay={togglePlay}
        onStop={stopPlayback}
        onRewind={rewindPlayback}
        onExport={handleExport}
        onLoopInfo={showLoopInfo}
        onUndo={doUndo}
        onRedo={doRedo}
        onSave={doSave}
        keyboardOpen={keyboardOpen}
        onToggleKeyboard={toggleKeyboard}
        recordState={recordState}
        recordElapsed={recordElapsed}
        recordLevel={recordLevel}
        onToggleRecord={toggleAudioRecording}
        overdub={recordOverdub}
        monitoring={recordMonitor}
        onToggleOverdub={toggleRecordOverdub}
        onToggleMonitor={toggleRecordMonitor}
        hasReference={Boolean(referenceTrack)}
        abMode={abMode}
        onToggleAB={toggleAB}
        inputDevices={inputDevices}
        inputDeviceId={inputDeviceId}
        onSelectInputDevice={selectInputDevice}
      />

      {!unlocked ? (
        <div
          className={`aims-unlock-bar ${aiPlayBlocked ? 'is-ai-play-blocked' : ''}`}
          role="status"
          data-testid="unlock-bar"
          {...(aiPlayBlocked ? { 'data-ai-play-blocked': 'true' } : {})}
          title={aiPlayBlocked ? 'AI 已请求播放；浏览器需要一次用户手势，点击后自动继续' : '浏览器要求用户手势后才能启动 Web Audio'}
        >
          <span className="aims-unlock-pill">
            <span className="aims-unlock-dot" />
            {aiPlayBlocked ? 'AI 想开始播放 · 点击启用音频' : '点击界面任意处启用音频'}
          </span>
          <span className="aims-unlock-sub">
            {aiPlayBlocked
              ? 'AI 播放请求已排队：点击任意处启用音频后会自动继续播放'
              : '浏览器需要一次用户手势来启动 Web Audio · 启用后即可播放与导出'}
          </span>
          <button type="button" className="aims-unlock-btn" aria-label="启用音频" onClick={unlockAudio}>
            <IconPlay size={12} />
            立即启用
          </button>
        </div>
      ) : null}

      {aiBanner ? (
        <div className="aims-ai-banner" data-testid="ai-activity-banner" role="status" title="AI 正在执行的操作">
          <span className="aims-ai-banner-dot" aria-hidden="true" />
          <span className="aims-ai-banner-label">AI</span>
          <span className="aims-ai-banner-text">{aiBanner.text}</span>
        </div>
      ) : null}

      {mixWarning ? (
        <div className="aims-mix-warning" data-testid="mix-warning" role="alert" title="混音建议提醒">
          <span className="aims-mix-warning-tag">混音提醒</span>
          <span className="aims-mix-warning-text">{mixWarning}</span>
        </div>
      ) : null}

      <div
        className={`aims-body ${layout.compact ? 'is-compact' : ''} ${layout.collapsed.rightRail || layout.compact ? 'is-no-right' : ''} ${layout.collapsed.leftRail ? 'is-no-left' : ''}`}
        style={{
          '--layout-left-w': `${layout.leftWidth}px`,
          '--layout-right-w': `${layout.rightWidth}px`,
          '--layout-keyboard-h': `${layout.keyboardHeight}px`,
        }}
      >
        {!layout.collapsed.leftRail ? (
          <>
            <aside className="aims-col aims-col--left" style={{ width: layout.leftWidth }}>
              <ChannelRack
                project={viewProject}
                tracks={tracks}
                selectedTrackId={selectedTrackId}
                engine={engine}
                playing={playing}
                selectedPatternId={selectedPatternId}
                editable={editable}
                collapsed={layout.collapsed.channelRack}
                onToggleCollapse={() => toggleCollapsed('channelRack')}
                stepCollapsed={layout.collapsed.stepSequencer}
                onToggleStepCollapse={() => toggleCollapsed('stepSequencer')}
                onSelectTrack={selectTrack}
                onToggleMute={toggleMute}
                onToggleSolo={toggleSolo}
                onVolume={setTrackVolume}
                onSelectPattern={selectPattern}
                onCommitNotes={commitPatternNotes}
                onOpenPattern={openPatternInPianoRoll}
                onRemoveTrack={removeTrack}
                onNotify={showToast}
              />
              <PluginBrowser
                project={viewProject}
                selectedTrackId={selectedTrackId}
                engine={engine}
                onNotify={showToast}
                onEdit={runEdit}
                onCreateSynth={createSynthTrack}
                collapsed={layout.collapsed.pluginBrowser}
                onToggleCollapse={() => toggleCollapsed('pluginBrowser')}
              />
            </aside>
            <div
              className="aims-splitter aims-splitter--v"
              data-testid="splitter-left"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整左栏宽度"
              title="拖动调整左栏宽度（双击重置）"
              onPointerDown={(event) => beginColumnDrag('left', event)}
              onDoubleClick={() => resetColumnWidth('left')}
            />
          </>
        ) : null}

        <main className="aims-col aims-col--center">
          <div className="aims-tabs">
            <div className="aims-layout-bar" role="group" aria-label="布局控制">
              <button
                type="button"
                className={`aims-layout-btn ${layout.collapsed.leftRail ? 'is-off' : ''}`}
                data-testid="collapse-left"
                aria-expanded={!layout.collapsed.leftRail}
                aria-label={layout.collapsed.leftRail ? '显示左栏' : '隐藏左栏'}
                title={layout.collapsed.leftRail ? '显示左栏' : '隐藏左栏'}
                onClick={() => toggleCollapsed('leftRail')}
              >
                <span aria-hidden="true">◧</span>
                <span className="aims-layout-btn-label">左栏</span>
              </button>
              <button
                type="button"
                className={`aims-layout-btn ${layout.collapsed.rightRail ? 'is-off' : ''}`}
                data-testid="collapse-right"
                aria-expanded={!layout.collapsed.rightRail}
                aria-label={layout.collapsed.rightRail ? '显示右栏' : '隐藏右栏'}
                title={layout.collapsed.rightRail ? '显示右栏' : '隐藏右栏'}
                onClick={() => toggleCollapsed('rightRail')}
              >
                <span aria-hidden="true">◨</span>
                <span className="aims-layout-btn-label">右栏</span>
              </button>
              <button
                type="button"
                className={`aims-layout-btn ${layout.compact ? 'is-active' : ''}`}
                data-testid="layout-compact"
                aria-pressed={layout.compact}
                title="紧凑模式：收起右栏 AI 动态/统计，中央视图最大化"
                onClick={toggleCompact}
              >
                <span aria-hidden="true">▦</span>
                <span className="aims-layout-btn-label">紧凑</span>
              </button>
              <button
                type="button"
                className="aims-layout-btn"
                data-testid="layout-reset"
                title="重置布局（宽度 / 高度 / 折叠 / 紧凑）"
                onClick={resetLayout}
              >
                <span aria-hidden="true">⟲</span>
                <span className="aims-layout-btn-label">重置</span>
              </button>
            </div>
            <div className="aims-tabs-list" role="tablist" aria-label="工作区">
              {TAB_DEFS.map((def) => (
                <button
                  key={def.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === def.id}
                  aria-label={`${def.label}（${tabCounts[def.id]}）`}
                  className={`aims-tab ${tab === def.id ? 'is-active' : ''}`}
                  title={`${def.label} · ${def.en}`}
                  onClick={() => setTab(def.id)}
                >
                  <span className="aims-tab-icon">{def.icon}</span>
                  <span className="aims-tab-label">{def.label}</span>
                  <span className="aims-tab-badge aims-mono">{tabCounts[def.id]}</span>
                </button>
              ))}
            </div>
            <div className="aims-tabs-right">
              <span className="aims-tabs-sync" title="通过长轮询与宿主实时同步项目">
                <span className="aims-tabs-sync-dot" />
                自动同步
              </span>
              <span className="aims-tabs-version aims-mono" title="项目 revision">REV {viewProject.revision ?? 1}</span>
            </div>
          </div>

          <div className="aims-center-body">
            {isEmpty ? (
              <EmptyStudio onCopyPrompt={copyPrompt} />
            ) : tab === 'playlist' ? (
              <Playlist
                project={viewProject}
                tracks={trackList}
                selectedTrackId={selectedTrackId}
                selectedPatternId={selectedPatternId}
                engine={engine}
                playing={playing}
                onSelectTrack={selectTrack}
                onSelectClip={selectClip}
                onOpenClip={openClip}
                onCommitClips={commitClips}
                onUpdateAudioClip={updateAudioClipProps}
                onSetTakeActive={setTakeActive}
                editable={editable}
                keyboardEnabled={!dialog}
                editorCommand={editorCommand}
                onNotify={showToast}
              />
            ) : tab === 'pianoroll' ? (
              <PianoRoll
                project={viewProject}
                tracks={trackList}
                selectedTrackId={selectedTrackId}
                selectedPatternId={selectedPatternId}
                engine={engine}
                onSelectTrack={selectTrack}
                onSelectPattern={selectPattern}
                editable={editable}
                zoom={pianoZoom}
                onZoomChange={setPianoZoom}
                onCommitNotes={commitPatternNotes}
                onEdit={runEdit}
                onNotify={showToast}
                editorCommand={editorCommand}
                keyboardEnabled={!dialog}
              />
            ) : tab === 'automation' ? (
              <AutomationPanel
                project={viewProject}
                tracks={trackList}
                selectedTrackId={selectedTrackId}
                engine={engine}
                editable={editable}
                keyboardEnabled={!dialog}
                onSelectTrack={selectTrack}
                onCommit={commitAutomation}
                onClear={clearAutomation}
                onCommitTempo={commitTempoMap}
                onClearTempo={clearTempoMap}
                onNotify={showToast}
              />
            ) : tab === 'mixer' ? (
              <Mixer
                project={viewProject}
                tracks={tracks}
                selectedTrackId={selectedTrackId}
                engine={engine}
                selectedBus={selectedBus}
                onSelectBus={selectBus}
                selectedGroup={selectedGroup}
                onSelectGroup={selectGroup}
                onSelectTrack={selectTrack}
                onVolume={setTrackVolume}
                onPan={setTrackPan}
                onToggleMute={toggleMute}
                onToggleSolo={toggleSolo}
                editable={editable}
                onEditOp={commitEditOp}
                onNotify={showToast}
              />
            ) : (
              <FxRack
                project={viewProject}
                tracks={trackList}
                selectedTrackId={selectedTrackId}
                fxTarget={fxTarget}
                onSelectTarget={selectFxTarget}
                editable={editable}
                onEditOp={commitEditOp}
                onNotify={showToast}
              />
            )}
          </div>
        </main>

        {!layout.collapsed.rightRail && !layout.compact ? (
          <>
            <div
              className="aims-splitter aims-splitter--v"
              data-testid="splitter-right"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整右栏宽度"
              title="拖动调整右栏宽度（双击重置）"
              onPointerDown={(event) => beginColumnDrag('right', event)}
              onDoubleClick={() => resetColumnWidth('right')}
            />
            <aside className="aims-col aims-col--right" style={{ width: layout.rightWidth }}>
              <AiFeed
                project={viewProject}
                playing={playing}
                collapsed={layout.collapsed.aiFeed}
                onToggleCollapse={() => toggleCollapsed('aiFeed')}
              />
              <ProjectStats
                project={viewProject}
                collapsed={layout.collapsed.projectStats}
                onToggleCollapse={() => toggleCollapsed('projectStats')}
              />
              <Visualizer
                engine={engine}
                playing={playing}
                collapsed={layout.collapsed.spectrum}
                onToggleCollapse={() => toggleCollapsed('spectrum')}
              />
            </aside>
          </>
        ) : null}
      </div>

      {keyboardOpen ? (
        <div
          className="aims-splitter aims-splitter--h"
          data-testid="splitter-keyboard"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整键盘面板高度"
          title="拖动调整键盘高度（双击重置）"
          onPointerDown={beginKeyboardDrag}
          onDoubleClick={() => patchLayout({ keyboardHeight: LAYOUT_DEFAULTS.keyboardHeight })}
        />
      ) : null}
      {keyboardOpen ? (
        <KeyboardPanel
          project={viewProject}
          tracks={tracks}
          selectedTrackId={selectedTrackId}
          selectedPatternId={selectedPatternId}
          engine={engine}
          playing={playing}
          expanded={keyboardExpanded}
          tab={tab}
          audioUnlocked={unlocked}
          editable={editable}
          height={layout.keyboardHeight}
          onToggleExpand={() => setKeyboardExpanded((prev) => !prev)}
          onClose={() => setKeyboardOpen(false)}
          onCommitNotes={commitPatternNotes}
          onEdit={runEdit}
          onNotify={showToast}
          onEnsurePlaying={startPlayback}
        />
      ) : null}

      <StatusBar
        project={viewProject}
        engine={engine}
        playing={playing}
        unlocked={unlocked}
        lastExport={viewProject.lastExport}
        hostError={Boolean(hostError)}
        soundfontStatus={soundfontStatus}
      />

      {toast ? (
        <div className={`aims-toast is-${toast.tone}`} role="status">
          <span className="aims-toast-dot" />
          {toast.text}
        </div>
      ) : null}

      {/* P3b：导入音频的隐藏文件选择器（由 文件 → 导入音频… 触发） */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aiff"
        className="aims-import-input"
        data-testid="import-audio-input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleAudioFileChange}
      />

      {/* P14a：导入 MIDI 的隐藏文件选择器（由 文件 → 导入 MIDI… 触发） */}
      <input
        ref={midiInputRef}
        type="file"
        accept=".mid,.midi,audio/midi,audio/x-midi"
        className="aims-import-input"
        data-testid="import-midi-input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleMidiFileChange}
      />

      {/* P14b：导入参考曲的隐藏文件选择器（由 文件 → 导入参考曲… 触发） */}
      <input
        ref={referenceInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aiff"
        className="aims-import-input"
        data-testid="import-reference-input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleReferenceFileChange}
      />

      {dialog?.type === 'projects' ? (
        <ProjectDialog
          mode={dialog.mode || 'browse'}
          api={projectApi}
          activeName={currentProjectName}
          projectTitle={viewProject?.title ?? ''}
          initialName={dialog.mode === 'saveAs' ? (currentProjectName || viewProject?.title || '') : ''}
          onClose={() => setDialog(null)}
          onComplete={handleProjectComplete}
          onNotify={showToast}
        />
      ) : null}

      {aiChangeVisible ? (
        <AiChangePanel
          changes={aiChangeData.changes.slice(0, 3)}
          canUndo={Boolean(aiChangeData.canUndo)}
          canRedo={Boolean(aiChangeData.canRedo)}
          bottomOffset={keyboardOpen
            ? (keyboardExpanded ? (Number(layout.keyboardHeight) || 185) + 96 : 128)
            : null}
          onAccept={dismissAiChange}
          onClose={dismissAiChange}
          onUndo={aiChangeUndo}
          onRedo={aiChangeRedo}
        />
      ) : null}
      {onboardingVisible && !dialog && !keyboardOpen && !commandOpen ? (
        <OnboardingCard onStart={startOnboarding} onDismiss={dismissOnboarding} />
      ) : null}
      {dialog?.type === 'shortcuts' ? <ShortcutsDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.type === 'help' ? <HelpDialog onClose={() => setDialog(null)} onNotify={showToast} /> : null}
      {dialog?.type === 'about' ? (
        <AboutDialog
          onClose={() => setDialog(null)}
          onNotify={showToast}
          onOpenSettings={() => setDialog({ type: 'settings' })}
        />
      ) : null}
      {dialog?.type === 'settings' ? (
        <SettingsDialog
          onClose={() => setDialog(null)}
          onNotify={showToast}
          onLocaleChange={(next) => {
            const normalized = normalizeLocale(next)
            setLocale(normalized)
            try { window.localStorage.setItem('aims:locale', normalized) } catch (err) { /* ignore */ }
          }}
        />
      ) : null}
      {dialog?.type === 'export' ? (
        <ExportDialog
          project={viewProject}
          defaultFormat={dialog.format || 'wav'}
          onClose={() => setDialog(null)}
          onConfirm={(options) => {
            setDialog(null)
            const merged = { ...options }
            if (dialog.targetLufs !== undefined && merged.targetLufs === undefined) {
              merged.targetLufs = dialog.targetLufs
              merged.normalize = false
            }
            handleExport(merged)
          }}
        />
      ) : null}
      <CommandPalette
        open={commandOpen}
        commands={paletteCommands}
        onClose={() => setCommandOpen(false)}
        onRun={(cmd) => cmd.run?.()}
      />
    </div>
    </I18nContext.Provider>
  )
}

export default StudioApp
