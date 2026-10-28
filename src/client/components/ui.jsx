/**
 * AI 音乐工作室 — UI 基础件与工具（daw-ui 内部共享）。
 *
 * 包含：
 *  - rAF 帧总线（全局唯一，播放头/电平/频谱共用，避免每个组件各自 setState）
 *  - 格式化函数（小节.拍、时间、dB、参数显示）
 *  - 图标、面板壳、旋钮、开关、电平表等原子组件
 *
 * 性能约定：所有每帧变化的数据都直接写 DOM style / canvas，不触发 React setState。
 */
import { useEffect, useRef, useState } from 'react'
import { DRUM_PIECES, FX_TYPES, findRole, findFxType, TRACK_ROLES } from '../../shared/catalog.js'
import { palette, font, tint, shade } from '../theme.js'

/* ────────────────────────────── 基础数学 / 格式化 ────────────────────────────── */

export const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, Number(v) || 0))

export const lerp = (a, b, t) => a + (b - a) * t

/** 数字补零：pad(5, 3) → "005"。 */
export const pad = (n, width = 2) => String(Math.max(0, Math.round(Number(n) || 0))).padStart(width, '0')

/** 位置 → { bar, beat }（beat 从 0 开始）。 */
export function barBeat(positionBar, beatsPerBar = 4) {
  const pos = Math.max(0, Number(positionBar) || 0)
  const bar = Math.floor(pos)
  const beat = (pos - bar) * Math.max(1, beatsPerBar)
  return { bar, beat }
}

/** 走带位置 → "005 · 1.3"（bar 三位、beat 一位小数）。 */
export function fmtPosition(positionBar, beatsPerBar = 4) {
  const { bar, beat } = barBeat(positionBar, beatsPerBar)
  return `${pad(bar + 1, 3)} · ${(beat + 1).toFixed(1)}`
}

/** 时间戳 → HH:MM:SS。 */
export function fmtClock(at) {
  const d = new Date(Number(at) || 0)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 时间戳 → 相对时间（中文）。 */
export function timeAgo(at, now = Date.now()) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return '刚刚'
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 8) return '刚刚'
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/** 0..1 线性电平 → dB 字符串。 */
export function fmtDb(level) {
  const v = clamp(level, 0, 1)
  if (v < 0.0005) return '-∞'
  const db = 20 * Math.log10(v)
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}

/** 参数规格 + 值 → 人类可读文本（旋钮下方 / tooltip 用）。 */
export function fmtParam(spec, value) {
  if (!spec) return String(value ?? '')
  if (spec.type === 'bool') return value ? '开' : '关'
  if (spec.type === 'enum') {
    const table = { lowpass: '低通', highpass: '高通', bandpass: '带通', saw: '锯齿', square: '方波', sine: '正弦', triangle: '三角' }
    return table[value] ?? String(value ?? '')
  }
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const unit = spec.unit ?? ''
  if (unit === '%') return `${Math.round(n * 100)}%`
  if (unit === 'Hz') return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${Math.round(n)}`
  if (unit === 's') return n < 1 ? `${Math.round(n * 1000)}ms` : `${n.toFixed(2)}s`
  if (unit === 'dB') return `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}`
  if ((spec.step ?? 0) >= 1) return `${Math.round(n)}`
  return `${Math.round(n * 100) / 100}`
}

/** 参数规格 + 值 → 0..1（旋钮比例）。 */
export function paramRatio(spec, value) {
  if (!spec) return 0
  if (spec.type === 'bool') return value ? 1 : 0
  if (spec.type === 'enum') return 0
  const min = Number(spec.min ?? 0)
  const max = Number(spec.max ?? 1)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return 0
  return clamp((Number(value) - min) / (max - min), 0, 1)
}

/** 音轨角色中文名。 */
export function roleLabel(role) {
  // P3b：音频轨的 role 是 'audio'，catalog 的轨道角色表里没有该条
  if (role === 'audio') return '音频'
  return findRole(role)?.label ?? role ?? ''
}

/** 角色顺序（用于排序提示，不强制）。 */
export function roleIndex(role) {
  const i = TRACK_ROLES.findIndex((r) => r.id === role)
  return i < 0 ? 99 : i
}

/** 效果器类型信息。 */
export function fxMeta(type) {
  return findFxType(type) ?? FX_TYPES[0]
}

/** 鼓件信息（标准 GM 鼓音高）。 */
export function drumPiece(pitch) {
  return DRUM_PIECES.find((d) => d.pitch === pitch)
}

/** 工具名 → { label, color }（AI 动态流用）。 */
const TOOL_META = {
  create_project: { label: '新建工程', color: palette.coral },
  get_project: { label: '查看工程', color: palette.muted },
  get_pattern: { label: '读取音符', color: palette.muted },
  add_track: { label: '加入轨道', color: palette.mint },
  update_track: { label: '调整轨道', color: palette.mint },
  add_pattern: { label: '新建 Pattern', color: palette.amber },
  set_notes: { label: '写入音符', color: palette.amber },
  set_arrangement: { label: '编排结构', color: palette.rose },
  add_effect: { label: '加入效果器', color: palette.coral },
  update_effect: { label: '调校效果器', color: palette.coral },
  remove_effect: { label: '移除效果器', color: palette.muted },
  set_master: { label: '母带处理', color: palette.rose },
  transport: { label: '走带控制', color: palette.mint },
  export: { label: '导出音频', color: palette.amber },
  set_activity: { label: '创作动态', color: palette.muted },
}

export function toolMeta(tool) {
  const key = String(tool ?? '').replace(/^studio_/, '')
  return TOOL_META[key] ?? { label: key || 'AI', color: palette.muted }
}

/* ────────────────────────────── rAF 帧总线 ────────────────────────────── */

const bus = {
  listeners: new Set(),
  raf: 0,
  engine: null,
  frame: 0,
}

let levelFrame = -1
let levelCache = { master: 0, tracks: {} }

/** 同一帧内只调用一次 engine.getLevels()，供所有电平表共用。 */
export function readLevels(engine, frame) {
  if (!engine || typeof engine.getLevels !== 'function') return { master: 0, tracks: {} }
  if (levelFrame !== frame) {
    levelFrame = frame
    const raw = engine.getLevels()
    levelCache = raw && typeof raw === 'object' ? raw : { master: 0, tracks: {} }
  }
  return levelCache
}

let meterFrame = -1
let meterCache = { master: null, tracks: {}, groups: {} }

/** R4c：同一帧内只调用一次 engine.getMeters()（rms/peak/dB/LUFS）；无 getMeters 时回退 null。 */
export function readMeters(engine, frame) {
  if (!engine || typeof engine.getMeters !== 'function') return { master: null, tracks: {}, groups: {} }
  if (meterFrame !== frame) {
    meterFrame = frame
    const raw = engine.getMeters()
    meterCache = raw && typeof raw === 'object'
      ? { master: raw.master ?? null, tracks: raw.tracks ?? {}, groups: raw.groups ?? {} }
      : { master: null, tracks: {}, groups: {} }
  }
  return meterCache
}

function frameTick(now) {
  bus.frame += 1
  const engine = bus.engine
  for (const listener of bus.listeners) {
    try {
      listener(engine, now, bus.frame)
    } catch (err) {
      // 单个订阅者出错不应拖垮整个 UI（控制台留痕，不刷屏）
      if (!frameTick._warned) {
        frameTick._warned = true
        console.error('[ai-music-studio] frame listener error', err)
      }
    }
  }
  bus.raf = bus.listeners.size > 0 ? requestAnimationFrame(frameTick) : 0
}

/**
 * 订阅每帧回调：(engine, now, frame) => void。
 * 回调里只做 DOM/canvas 更新，不要 setState。
 */
export function useFrame(engine, callback) {
  const cbRef = useRef(callback)
  cbRef.current = callback
  useEffect(() => {
    bus.engine = engine ?? null
    const listener = (e, now, frame) => cbRef.current(e, now, frame)
    bus.listeners.add(listener)
    if (!bus.raf) bus.raf = requestAnimationFrame(frameTick)
    return () => {
      bus.listeners.delete(listener)
      if (bus.listeners.size === 0 && bus.raf) {
        cancelAnimationFrame(bus.raf)
        bus.raf = 0
        bus.frame = 0
        levelFrame = -1
      }
    }
  }, [engine])
}

/** 播放状态（只在变化时 setState，避免每帧渲染）。 */
export function usePlaying(engine, fallback = false) {
  const read = () => Boolean(engine ? engine.isPlaying : fallback)
  const [playing, setPlaying] = useState(read)
  const last = useRef(playing)

  useEffect(() => {
    const v = Boolean(engine ? engine.isPlaying : fallback)
    if (v !== last.current) {
      last.current = v
      setPlaying(v)
    }
  }, [engine, fallback])

  useFrame(engine, (e) => {
    const v = Boolean(e ? e.isPlaying : fallback)
    if (v !== last.current) {
      last.current = v
      setPlaying(v)
    }
  })

  return playing
}

/** 每 interval 毫秒重渲染一次的「当前时间」（相对时间展示用）。 */
export function useNow(interval = 15000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(id)
  }, [interval])
  return now
}

/** 元素尺寸观察（canvas 自适应用）。 */
export function useElementSize() {
  const ref = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const apply = (rect) => {
      if (!rect) return
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }
    apply({ width: el.clientWidth, height: el.clientHeight })
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => apply(entries[0]?.contentRect))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

/* ────────────────────────────── 图标 ────────────────────────────── */

function Svg({ size = 16, children, className = '', fill = 'none' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={fill === 'none' ? 'currentColor' : 'none'}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const IconPlay = ({ size = 16, className }) => (
  <Svg size={size} className={className} fill="currentColor">
    <path d="M8 5.2c0-.7.8-1.2 1.4-.8l9 6.1c.6.4.6 1.2 0 1.6l-9 6.1c-.6.4-1.4 0-1.4-.8V5.2Z" />
  </Svg>
)
export const IconPause = ({ size = 16, className }) => (
  <Svg size={size} className={className} fill="currentColor">
    <rect x="7" y="5.5" width="3.6" height="13" rx="1.2" />
    <rect x="13.4" y="5.5" width="3.6" height="13" rx="1.2" />
  </Svg>
)
export const IconStop = ({ size = 16, className }) => (
  <Svg size={size} className={className} fill="currentColor">
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.4" />
  </Svg>
)
export const IconRewind = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M6 5.5v13" />
    <path d="M18 5.8c0-.7-.8-1-1.3-.6L9 12l7.7 6.8c.5.4 1.3.1 1.3-.6V5.8Z" fill="currentColor" stroke="none" />
  </Svg>
)
export const IconLoop = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M4.5 12a5 5 0 0 1 5-5h7l-2.2-2.2M19.5 12a5 5 0 0 1-5 5h-7l2.2 2.2" />
  </Svg>
)
export const IconExport = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M12 3.8v10.4m0 0 4-4m-4 4-4-4" />
    <path d="M4.8 15.5v2.7c0 .9.7 1.6 1.6 1.6h11.2c.9 0 1.6-.7 1.6-1.6v-2.7" />
  </Svg>
)
export const IconSparkle = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M12 3.2c.7 4.9 2.6 6.8 7.5 7.5-4.9.7-6.8 2.6-7.5 7.5-.7-4.9-2.6-6.8-7.5-7.5 4.9-.7 6.8-2.6 7.5-7.5Z" />
    <path d="M18.6 3.4c.2 1.5.8 2.1 2.3 2.3-1.5.2-2.1.8-2.3 2.3-.2-1.5-.8-2.1-2.3-2.3 1.5-.2 2.1-.8 2.3-2.3Z" />
  </Svg>
)
export const IconWave = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M2.5 12c2 0 2-6.5 4.2-6.5S9 18.5 11.2 18.5 13.5 5.5 15.7 5.5 18 12 21.5 12" />
  </Svg>
)
export const IconPlaylist = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <rect x="3.8" y="5" width="7" height="6" rx="1.6" />
    <rect x="13.2" y="5" width="7" height="6" rx="1.6" />
    <rect x="3.8" y="13" width="7" height="6" rx="1.6" />
    <rect x="13.2" y="13" width="7" height="6" rx="1.6" />
  </Svg>
)
export const IconPiano = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <path d="M8.2 4.5v9.2M12 4.5v9.2M15.8 4.5v9.2" />
  </Svg>
)
export const IconMixer = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M6 4v16M12 4v16M18 4v16" />
    <path d="M3.6 8.6h4.8M9.6 15.2h4.8M15.6 6.8h4.8" />
  </Svg>
)
export const IconFx = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M4 7.5h6M14 7.5h6M4 16.5h10M18 16.5h2" />
    <circle cx="12" cy="7.5" r="2" />
    <circle cx="16" cy="16.5" r="2" />
  </Svg>
)
export const IconSearch = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 4.5 4.5" />
  </Svg>
)
export const IconChevron = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="m9 5.5 6.5 6.5L9 18.5" />
  </Svg>
)
export const IconPlus = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconCheck = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="m4.8 12.6 4.6 4.6L19.2 7" />
  </Svg>
)
export const IconAlert = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M12 3.8 21 20H3L12 3.8Z" />
    <path d="M12 9.5v4.4M12 16.9v.2" />
  </Svg>
)
export const IconClock = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.4V12l3.1 2" />
  </Svg>
)
export const IconLayers = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="m12 3.6 8.2 4.5L12 12.6 3.8 8.1 12 3.6Z" />
    <path d="m4.4 12.3 7.6 4.2 7.6-4.2M4.4 16.4l7.6 4.2 7.6-4.2" />
  </Svg>
)
export const IconUndo = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="m9.4 5.4-4.9 4.9 4.9 4.9" />
    <path d="M4.8 10.3h8.4a5.4 5.4 0 0 1 0 10.8h-3" />
  </Svg>
)
export const IconRedo = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="m14.6 5.4 4.9 4.9-4.9 4.9" />
    <path d="M19.2 10.3h-8.4a5.4 5.4 0 0 0 0 10.8h3" />
  </Svg>
)
export const IconSave = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M5 4.8h10.6L19.2 8.4V19a.8.8 0 0 1-.8.8H5.6a.8.8 0 0 1-.8-.8V5.6a.8.8 0 0 1 .8-.8Z" />
    <path d="M8.2 4.8v5h7.2v-5M8 19.4v-5.2h8v5.2" />
  </Svg>
)
export const IconFolder = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M3.4 6.6c0-.8.6-1.4 1.4-1.4h4l2 2.2h7.4c.8 0 1.4.6 1.4 1.4v8.6c0 .8-.6 1.4-1.4 1.4H4.8c-.8 0-1.4-.6-1.4-1.4V6.6Z" />
  </Svg>
)
export const IconFilePlus = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M6 3.8h7.4L18 8.4v11.4a.8.8 0 0 1-.8.8H6.8a.8.8 0 0 1-.8-.8V4.6a.8.8 0 0 1 .8-.8Z" />
    <path d="M13.2 3.8v4.8H18" />
    <path d="M12.2 11.4v5M9.7 13.9h5" />
  </Svg>
)
export const IconTrash = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M4.6 6.6h14.8M9 6.6V4.8c0-.5.4-.8.9-.8h4.2c.5 0 .9.3.9.8v1.8" />
    <path d="M6.4 6.6 7.2 19c0 .5.4.8.9.8h7.8c.5 0 .9-.3.9-.8l.8-12.4" />
    <path d="M10.2 10v6.4M13.8 10v6.4" />
  </Svg>
)
export const IconCopy = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <rect x="8.4" y="8.4" width="11" height="11" rx="2" />
    <path d="M15.6 8.4V6.4a2 2 0 0 0-2-2H6.4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 2 2h2" />
  </Svg>
)
export const IconClose = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
)
export const IconHelp = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 3.4c-.7.5-1.1 1-1.1 1.8v.4" />
    <path d="M12 17.5v.2" />
  </Svg>
)
export const IconZoomIn = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <circle cx="10.6" cy="10.6" r="6.2" />
    <path d="m15.2 15.2 4.4 4.4M10.6 8v5.2M8 10.6h5.2" />
  </Svg>
)
export const IconZoomOut = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <circle cx="10.6" cy="10.6" r="6.2" />
    <path d="m15.2 15.2 4.4 4.4M8 10.6h5.2" />
  </Svg>
)
export const IconChevronDown = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
)
export const IconAutomation = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M3.4 17.2c2.4 0 2.4-2.6 4.8-2.6s2.4-4.6 4.8-4.6 2.4 4.2 4.8 4.2 2.4-6.4 4.8-6.4" />
    <circle cx="8.2" cy="14.6" r="1.5" />
    <circle cx="13" cy="10" r="1.5" />
    <circle cx="17.8" cy="14.2" r="1.5" />
  </Svg>
)
export const IconFilter = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M3.6 5.4h16.8L14 12.6v6.6l-4-2v-4.6L3.6 5.4Z" />
  </Svg>
)
export const IconRefresh = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M19.2 10.4A7.4 7.4 0 0 0 5.6 7.2L3.8 9M3.8 9V4.8M3.8 9h4.2" />
    <path d="M4.8 13.6a7.4 7.4 0 0 0 13.6 3.2l1.8-1.8M20.2 15v4.2H16" />
  </Svg>
)
export const IconArrowUp = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M12 19.2V5.2M6.4 10.8 12 5.2l5.6 5.6" />
  </Svg>
)
export const IconArrowDown = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M12 4.8v14M6.4 13.2 12 18.8l5.6-5.6" />
  </Svg>
)
export const IconSidechain = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M4 7.5h7.2a4.3 4.3 0 0 1 0 8.6H4" />
    <path d="m7.4 12.9-3-3 3-3" />
    <circle cx="18.2" cy="7.5" r="2.3" />
  </Svg>
)
export const IconStems = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M12 3.6 4 7.4v3l8 3.8 8-3.8v-3l-8-3.8Z" />
    <path d="m4 13.2 8 3.8 8-3.8M4 17.2l8 3.8 8-3.8" />
  </Svg>
)
export const IconSteps = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <rect x="4" y="4" width="6.4" height="6.4" rx="1.4" />
    <rect x="13.6" y="4" width="6.4" height="6.4" rx="1.4" />
    <rect x="4" y="13.6" width="6.4" height="6.4" rx="1.4" />
    <path d="M13.6 13.6h6.4v2.6a3.8 3.8 0 0 1-3.8 3.8h-2.6v-6.4Z" />
  </Svg>
)
export const IconKeyboard = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <rect x="2.8" y="6" width="18.4" height="12" rx="2.2" />
    <path d="M6.4 9.6h.01M9.8 9.6h.01M13.2 9.6h.01M16.6 9.6h.01M6.4 12.8h.01M9.8 12.8h.01M13.2 12.8h.01M16.6 12.8h.01M8.6 15.6h6.8" />
  </Svg>
)
export const IconRecord = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="12" r="5.6" fill="currentColor" stroke="none" />
  </Svg>
)
export const IconMidi = ({ size = 16, className }) => (
  <Svg size={size} className={className}>
    <path d="M4.6 9.2V7.4a1.6 1.6 0 0 1 1.6-1.6h11.6a1.6 1.6 0 0 1 1.6 1.6v1.8" />
    <path d="M4.6 9.2v5.2M9.4 9.2v5.2M14.2 9.2v5.2M19 9.2v5.2" />
    <path d="M3.2 14.4h17.6v2.8a1.4 1.4 0 0 1-1.4 1.4H4.6a1.4 1.4 0 0 1-1.4-1.4v-2.8Z" />
  </Svg>
)

/* ────────────────────────────── 快捷键 / 编辑工具 ────────────────────────────── */

/** 事件目标是否在输入控件内：这些情况下不拦截快捷键。 */
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false
  const tag = String(target.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return Boolean(target.isContentEditable)
}

/** 吸附到 step 的整数倍（step<=0 时原样返回）。 */
export function snapTo(value, step) {
  const s = Number(step)
  if (!Number.isFinite(s) || s <= 0) return Number(value) || 0
  return Math.round(Number(value) / s) * s
}

/** 键盘事件防抖：同一组 key 在 ms 内只放行一次（ref 由调用方持有）。 */
export function throttleKeydown(ref, key, ms = 200) {
  const now = Date.now()
  const last = ref.current?.[key] ?? 0
  if (now - last < ms) return true
  if (ref.current) ref.current[key] = now
  return false
}

/** 快捷键展示用修饰键（Windows 版本统一显示 Ctrl）。 */
export const MOD_LABEL = 'Ctrl'

/* ────────────────────────────── 原子组件 ────────────────────────────── */

/** 面板壳：标题 / 副标题 / 右上操作 / 内容；可选折叠（P7）。 */
export function Panel({
  title, subtitle, icon, badge, actions, children, className = '', bodyClassName = '', dense = false,
  collapsed = false, onToggleCollapse = null, collapseTestId, collapseTitle = '',
}) {
  const collapsible = typeof onToggleCollapse === 'function'
  return (
    <section className={`aims-panel ${dense ? 'aims-panel--dense' : ''} ${collapsed ? 'is-panel-collapsed' : ''} ${className}`}>
      {(title || actions || collapsible) && (
        <header className="aims-panel-head">
          <div className="aims-panel-headline">
            {icon ? <span className="aims-panel-icon">{icon}</span> : null}
            <h2 className="aims-panel-title">{title}</h2>
            {badge != null && badge !== '' ? <span className="aims-panel-badge">{badge}</span> : null}
          </div>
          {subtitle ? <span className="aims-panel-sub">{subtitle}</span> : null}
          {actions ? <div className="aims-panel-actions">{actions}</div> : null}
          {collapsible ? (
            <button
              type="button"
              className={`aims-panel-collapse ${collapsed ? 'is-collapsed' : ''}`}
              data-testid={collapseTestId}
              aria-expanded={!collapsed}
              title={collapseTitle || (collapsed ? '展开面板' : '折叠面板')}
              aria-label={collapseTitle || (collapsed ? '展开面板' : '折叠面板')}
              onClick={onToggleCollapse}
            >
              <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            </button>
          ) : null}
        </header>
      )}
      {collapsed ? null : <div className={`aims-panel-body ${bodyClassName}`}>{children}</div>}
    </section>
  )
}

/** 小胶囊标签。 */
export function Chip({ children, color = palette.muted, tone = 'soft', title, className = '', onClick }) {
  const style = tone === 'soft'
    ? { color: shade(color, 0.28), background: tint(color, 0.86), borderColor: tint(color, 0.68) }
    : { color: '#FFFFFF', background: color, borderColor: color }
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`aims-chip aims-chip--${tone} ${onClick ? 'aims-chip--button' : ''} ${className}`}
      style={style}
      title={title}
      onClick={onClick}
    >
      {children}
    </Tag>
  )
}

/**
 * 旋钮（纯展示 + 可选拖动）。
 * interactive 时拖动上下改变值；onChange(value) 收到真实参数值。
 */
export function Knob({
  value = 0, min = 0, max = 1, label, display, color = palette.coral,
  size = 40, thin = false, title, interactive = false, onChange, onCommit, testId, disabled = false,
}) {
  const ratio = max === min ? 0 : clamp((Number(value) - min) / (max - min), 0, 1)
  const angle = -135 + 270 * ratio
  const r = 15.2
  const center = 20
  const polar = (deg) => {
    const rad = ((deg - 90) * Math.PI) / 180
    return [center + r * Math.cos(rad), center + r * Math.sin(rad)]
  }
  const arc = (from, to) => {
    const [x1, y1] = polar(from)
    const [x2, y2] = polar(to)
    const large = Math.abs(to - from) > 180 ? 1 : 0
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
  }
  const [ix, iy] = polar(angle)
  const [px, py] = polar(0) // 12 点方向
  const dotX = center + (ix - center) * 0.72
  const dotY = center + (iy - center) * 0.72

  const drag = useRef(null)
  const lastRef = useRef(null)
  const interactiveNow = interactive && !disabled
  const onPointerDown = (e) => {
    if (!interactiveNow) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { y: e.clientY, value: Number(value) }
    lastRef.current = Number(value)
  }
  const onPointerMove = (e) => {
    if (!interactiveNow || !drag.current) return
    const span = Math.max(1e-6, (max - min))
    const delta = ((drag.current.y - e.clientY) / 180) * span
    const next = clamp(drag.current.value + delta, min, max)
    lastRef.current = next
    onChange?.(next)
  }
  const onPointerUp = (e) => {
    if (!drag.current) return
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (lastRef.current != null) {
      onCommit?.(lastRef.current)
      lastRef.current = null
    }
  }
  const onKeyDown = (e) => {
    if (!interactiveNow) return
    const span = Math.max(1e-6, (max - min))
    let delta = 0
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') delta = span * 0.04
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') delta = -span * 0.04
    else return
    e.preventDefault()
    const next = clamp(Number(value) + delta, min, max)
    onChange?.(next)
    onCommit?.(next)
  }

  return (
    <div
      className={`aims-knob ${interactiveNow ? 'aims-knob--interactive' : ''} ${disabled ? 'is-disabled' : ''}`}
      title={title ?? `${label ?? ''} ${display ?? ''}`.trim()}
      style={{ '--knob-color': color, width: size + 12 }}
      role={interactiveNow ? 'slider' : undefined}
      aria-label={interactiveNow ? (label ? `${label} 旋钮` : '参数旋钮') : undefined}
      aria-valuemin={interactiveNow ? min : undefined}
      aria-valuemax={interactiveNow ? max : undefined}
      aria-valuenow={interactiveNow ? Number(value) : undefined}
      aria-valuetext={interactiveNow ? String(display ?? value) : undefined}
      data-testid={testId}
      data-value={Number(value)}
      data-disabled={disabled ? '1' : undefined}
      tabIndex={interactiveNow ? 0 : undefined}
      onKeyDown={onKeyDown}
    >
      <svg
        viewBox="0 0 40 40"
        width={size + 10}
        height={size + 10}
        className="aims-knob-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <path d={arc(-135, 135)} className="aims-knob-track" fill="none" strokeWidth={thin ? 2.4 : 3.4} strokeLinecap="round" />
        <path d={arc(-135, Math.max(-134.5, angle))} fill="none" stroke={color} strokeWidth={thin ? 2.4 : 3.4} strokeLinecap="round" />
        <circle cx={center} cy={center} r={11.6} className="aims-knob-face" />
        <line
          x1={center + (px - center) * 0.32} y1={center + (py - center) * 0.32}
          x2={dotX} y2={dotY}
          stroke={color} strokeWidth="2.2" strokeLinecap="round"
        />
      </svg>
      {label ? <span className="aims-knob-label">{label}</span> : null}
      {display != null ? <span className="aims-knob-value">{display}</span> : null}
    </div>
  )
}

/** 小型开关（展示 / 可选受控）。 */
export function Switch({ checked = false, onChange, title, color = palette.coral, disabled = false, label, testId }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? title ?? '开关'}
      title={title}
      data-testid={testId}
      className={`aims-switch ${checked ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}
      style={checked ? { background: color, borderColor: color } : undefined}
      onClick={(e) => {
        e.stopPropagation()
        if (!disabled) onChange?.(!checked)
      }}
    >
      <span className="aims-switch-dot" />
    </button>
  )
}

/** 水平滑杆（侧链 amount / attack / release）。拖动时连续 onChange，松手 onCommit 一次。 */
export function Slider({
  value = 0, min = 0, max = 1, step = 0.01, label, display, color = palette.coral,
  testId, title, disabled = false, onChange, onCommit,
}) {
  const lastRef = useRef(null)
  const emit = (next) => {
    lastRef.current = next
    onChange?.(next)
  }
  const commit = () => {
    if (lastRef.current == null) return
    onCommit?.(lastRef.current)
    lastRef.current = null
  }
  const percent = max === min ? 0 : clamp(((Number(value) - min) / (max - min)) * 100, 0, 100)
  return (
    <div className={`aims-slider ${disabled ? 'is-disabled' : ''}`} title={title}>
      <div className="aims-slider-head">
        <span className="aims-slider-label">{label}</span>
        <span className="aims-slider-value aims-mono">{display}</span>
      </div>
      <input
        type="range"
        className="aims-slider-input"
        style={{ '--slider-color': color, '--slider-pct': `${percent}%` }}
        data-testid={testId}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => emit(Number(e.target.value))}
        onPointerUp={commit}
        onPointerCancel={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </div>
  )
}

/** 电平表：垂直（混音台）或水平（顶栏 master）。 */
export function LevelMeter({ engine, trackId = null, groupId = null, orientation = 'vertical', className = '' }) {
  const fillRef = useRef(null)
  const peakRef = useRef(null)
  const state = useRef({ value: 0, peak: 0, peakAt: 0 })

  useFrame(engine, (e, now, frame) => {
    const levels = readLevels(e, frame)
    const meters = readMeters(e, frame)
    const entry = groupId ? meters?.groups?.[groupId] : trackId ? meters?.tracks?.[trackId] : meters?.master
    const raw = entry ? (Number(entry.peak) || 0) : (trackId ? levels?.tracks?.[trackId] : levels?.master)
    const v = clamp(Number(raw) || 0, 0, 1)
    const s = state.current
    // 快起慢落
    s.value = v >= s.value ? v : s.value * 0.82 + v * 0.18
    if (s.value >= s.peak) {
      s.peak = s.value
      s.peakAt = now
    } else if (now - s.peakAt > 1100) {
      s.peak = Math.max(s.value, s.peak - 0.012)
    }
    if (fillRef.current) {
      fillRef.current.style.transform = orientation === 'vertical'
        ? `scaleY(${Math.max(0.001, s.value).toFixed(4)})`
        : `scaleX(${Math.max(0.001, s.value).toFixed(4)})`
    }
    if (peakRef.current) {
      peakRef.current.style.opacity = s.peak > 0.02 ? '0.85' : '0'
      if (orientation === 'vertical') peakRef.current.style.bottom = `${(s.peak * 100).toFixed(2)}%`
      else peakRef.current.style.left = `${(s.peak * 100).toFixed(2)}%`
    }
  })

  return (
    <div className={`aims-meter aims-meter--${orientation} ${className}`} title="实时电平">
      <div className="aims-meter-track">
        <div className="aims-meter-fill" ref={fillRef} />
        <div className="aims-meter-peak" ref={peakRef} />
      </div>
    </div>
  )
}

/**
 * R4c：数值电平读数（peak/rms dB；Master 可显示 LUFS≈）。
 * 每帧直接写 DOM，不触发 React 重渲染；无数据/停止时显示 —。
 */
export function MeterReadout({
  engine, trackId = null, groupId = null, fallbackTrackIds = [], meterId, mode = 'peak',
  showLufs = false, lufsTestId = 'master-lufs', title = '实时电平（peak dB）', className = '',
}) {
  const dbRef = useRef(null)
  const lufsRef = useRef(null)
  useFrame(engine, (e, now, frame) => {
    const meters = readMeters(e, frame)
    let entry = groupId ? meters?.groups?.[groupId] : trackId ? meters?.tracks?.[trackId] : meters?.master
    /* 引擎暂未提供 group meters 时，用组内输入轨的最大 peak/rms 近似。 */
    if (!entry && (fallbackTrackIds ?? []).length > 0) {
      let peak = 0
      let rms = 0
      for (const id of fallbackTrackIds) {
        const item = meters?.tracks?.[id]
        if (!item) continue
        peak = Math.max(peak, Number(item.peak) || 0)
        rms = Math.max(rms, Number(item.rms) || 0)
      }
      const dbOf = (value) => (value > 0 ? Math.max(-120, Math.min(0, 20 * Math.log10(value))) : -120)
      entry = { peak, peakDb: dbOf(peak), rms, rmsDb: dbOf(rms) }
    }
    let db = entry ? (mode === 'rms' ? entry.rmsDb : entry.peakDb) : null
    if (!Number.isFinite(Number(db))) {
      const levels = readLevels(e, frame)
      const raw = trackId ? levels?.tracks?.[trackId] : levels?.master
      db = Number(raw) > 0 ? 20 * Math.log10(Number(raw)) : -Infinity
    }
    if (dbRef.current) {
      /* 停止/静音：-120 dB 视作无信号，显示占位 —（与顶栏契约一致）。 */
      const display = Number.isFinite(Number(db)) && Number(db) > -119.5 ? `${Number(db).toFixed(1)} dB` : '—'
      dbRef.current.textContent = display
    }
    if (lufsRef.current) {
      const lufs = entry?.lufsApprox ?? entry?.lufsShortTerm
      lufsRef.current.textContent = Number.isFinite(Number(lufs)) && Number(lufs) > -119.5
        ? `LUFS≈ ${Number(lufs).toFixed(1)}`
        : 'LUFS≈ —'
    }
  })
  return (
    <span className={`aims-meter-readout ${className}`} data-testid={meterId} title={title}>
      <b className="aims-meter-db aims-mono" ref={dbRef}>—</b>
      {showLufs ? <span className="aims-meter-lufs aims-mono" data-testid={lufsTestId} ref={lufsRef}>LUFS≈ —</span> : null}
    </span>
  )
}

/** 空状态（面板内）。 */
export function EmptyState({ icon, title, description, hints = [], compact = false }) {
  return (
    <div className={`aims-empty ${compact ? 'aims-empty--compact' : ''}`}>
      {icon ? <div className="aims-empty-icon">{icon}</div> : null}
      <h3 className="aims-empty-title">{title}</h3>
      {description ? <p className="aims-empty-desc">{description}</p> : null}
      {hints.length ? (
        <ul className="aims-empty-hints">
          {hints.map((hint) => <li key={hint}>{hint}</li>)}
        </ul>
      ) : null}
    </div>
  )
}

/** 工具按钮（图标 + 文案）。 */
export function ToolButton({ icon, children, onClick, active = false, title, className = '', disabled = false }) {
  return (
    <button
      type="button"
      className={`aims-toolbtn ${active ? 'is-active' : ''} ${className}`}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {icon ? <span className="aims-toolbtn-icon">{icon}</span> : null}
      {children != null ? <span className="aims-toolbtn-label">{children}</span> : null}
    </button>
  )
}

export { font, palette }
