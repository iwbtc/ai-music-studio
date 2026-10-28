/**
 * 中栏：自动化曲线（P2a）。
 *
 * 交互：
 *  - 顶部选轨道（含 Master）/ 参数（音量 · 声像 · 滤波 Cutoff）/ 启用开关 / 清空
 *  - canvas 曲线：点击空处加点（吸附 1/4 拍）、拖动点改 beat+value、右键/Delete 删点、双击清空
 *  - 播放位置竖线 + 当前插值读数
 *  - 手势过程中只改本地 points，松手一次性 onCommit({type:'setAutomation',...})
 *
 * 数据：track.automation[param] = { enabled, points:[{beat,value}] }；master.automation.volume。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { alpha, palette, shade, tint } from '../theme.js'
import {
  IconAutomation, IconChevronDown, IconFilter, IconTrash, Switch,
  clamp, isTypingTarget, snapTo, throttleKeydown, useElementSize, useFrame,
} from './ui.jsx'

const PAD = { left: 46, top: 17, right: 16, bottom: 26 }
const SNAP = 0.25
const MAX_POINTS = 256

/** 参数元数据（对应 CONTRACT-P2 §1；shared/catalog 若提供 AUTOMATION_PARAMS 可后续改为引用）。 */
const PARAMS = {
  volume: { key: 'volume', label: '音量', en: 'VOLUME', color: palette.coral, target: 'track/master volume' },
  pan: { key: 'pan', label: '声像', en: 'PAN', color: palette.mint, target: 'track pan' },
  cutoff: { key: 'cutoff', label: '滤波 Cutoff', en: 'CUTOFF', color: palette.amber, target: 'first filter FX cutoff' },
  /* P13：轨道表情参数（value 0..1，显示映射到半音 / cents / %） */
  pitchBend: { key: 'pitchBend', label: '弯音 Pitch Bend', en: 'PITCH BEND', color: palette.rose, target: 'track pitch bend (semitone)' },
  modulation: { key: 'modulation', label: '调制 Modulation', en: 'MODULATION', color: palette.olive, target: 'track vibrato depth (cents)' },
  expression: { key: 'expression', label: '表情 Expression', en: 'EXPRESSION', color: palette.caramel, target: 'track expression gain' },
  /* R3b：MIDI CC 曲线（value 0..1 ↔ CC 0..127） */
  cc1: { key: 'cc1', label: 'CC1 调制', en: 'CC1 MOD', color: '#8B5CF6', target: 'MIDI CC1 modulation' },
  cc11: { key: 'cc11', label: 'CC11 表情', en: 'CC11 EXP', color: '#F59E0B', target: 'MIDI CC11 expression' },
  cc64: { key: 'cc64', label: 'CC64 延音', en: 'CC64 SUS', color: '#10B981', target: 'MIDI CC64 sustain (data only)' },
  cc74: { key: 'cc74', label: 'CC74 亮度', en: 'CC74 BRT', color: '#06B6D4', target: 'MIDI CC74 brightness' },
  /* P12：全局速度曲线（不是轨道参数；value 0..1 映射 BPM 40..200） */
  tempo: { key: 'tempo', label: '速度 Tempo', en: 'TEMPO', color: palette.teal, target: 'global tempo' },
}
const PARAM_KEYS = ['volume', 'pan', 'cutoff', 'pitchBend', 'modulation', 'expression', 'cc1', 'cc11', 'cc64', 'cc74', 'tempo']
const CC_PARAMS = new Set(['cc1', 'cc11', 'cc64', 'cc74'])
const CC_PARAM_HINTS = {
  cc1: 'CC1 调制：与 modulation 曲线叠加揉弦（总深度 ≤100 cents）',
  cc11: 'CC11 表情：与 expression 曲线相乘作为音符增益',
  cc64: 'CC64 延音：仅存储与 MIDI 往返，不影响音频（听感请用延音踏板）',
  cc74: 'CC74 亮度：无 cutoff 曲线时驱动滤波器 cutoff（存在 cutoff 曲线时忽略）',
}
const DEFAULT_VALUE = { volume: 0.8, pan: 0.5, cutoff: 0.5, pitchBend: 0.5, modulation: 0, expression: 1, cc1: 0, cc11: 1, cc64: 0, cc74: 1, tempo: 0.55 }
const TEMPO_MIN_BPM = 40
const TEMPO_MAX_BPM = 200

/** tempo 曲线内部 value 0..1 ↔ 实际 BPM 40..200。 */
const tempoValueOf = (bpm) => clamp((Number(bpm) - TEMPO_MIN_BPM) / (TEMPO_MAX_BPM - TEMPO_MIN_BPM), 0, 1)
const bpmOfTempoValue = (value) => Math.round(TEMPO_MIN_BPM + clamp(value, 0, 1) * (TEMPO_MAX_BPM - TEMPO_MIN_BPM))
const plainTempoPoints = (points) => points.map((point) => ({
  beat: roundBeat(point.beat),
  bpm: bpmOfTempoValue(point.value),
}))

const roundBeat = (value) => Math.round(Number(value) * 1000) / 1000
const roundValue = (value) => Math.round(Number(value) * 1000) / 1000

let uidSeq = 1
const nextUid = () => {
  uidSeq += 1
  return uidSeq
}

/** value 0..1 → Hz（与引擎一致的 80Hz..16kHz 对数映射）。 */
const hzFromValue = (value) => 80 * Math.pow(16000 / 80, clamp(value, 0, 1))

/** 声像显示：0..1 → L/C/R。 */
function panLabel(value) {
  const pan = clamp(value, 0, 1) * 2 - 1
  if (Math.abs(pan) < 0.03) return 'C'
  return pan < 0 ? `L${Math.round(Math.abs(pan) * 100)}` : `R${Math.round(pan * 100)}`
}

/** 参数值的人类可读文本。 */
function formatValue(param, value) {
  const v = clamp(value, 0, 1)
  if (param === 'pan') return panLabel(v)
  if (param === 'pitchBend') {
    const semitones = v * 4 - 2
    return `${semitones > 0 ? '+' : ''}${semitones.toFixed(1)} st`
  }
  if (param === 'modulation') return `${Math.round(v * 100)} ct`
  if (param === 'expression') return `${Math.round(v * 100)}%`
  if (CC_PARAMS.has(param)) return `${Math.round(v * 127)}`
  if (param === 'tempo') return `${bpmOfTempoValue(v)} BPM`
  if (param === 'cutoff') {
    const hz = hzFromValue(v)
    if (hz >= 10000) return `${(hz / 1000).toFixed(1)}k`
    if (hz >= 1000) return `${(hz / 1000).toFixed(2)}k`
    return `${Math.round(hz)}Hz`
  }
  return `${Math.round(v * 100)}%`
}

const formatAxis = formatValue

/** 宿主数据 → 本地工作点（排序/去重/钳制/≤256）。 */
function normalizePoints(rawPoints, totalBeats) {
  if (!Array.isArray(rawPoints)) return []
  const sorted = rawPoints
    .map((point) => ({
      beat: roundBeat(clamp(Number(point?.beat) || 0, 0, totalBeats)),
      value: roundValue(clamp(Number(point?.value) || 0, 0, 1)),
    }))
    .sort((a, b) => a.beat - b.beat)
  const dedup = []
  for (const point of sorted) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1].beat - point.beat) < 1e-6) {
      dedup[dedup.length - 1] = point
    } else {
      dedup.push(point)
    }
    if (dedup.length >= MAX_POINTS) break
  }
  return dedup.map((point) => ({ ...point, uid: nextUid() }))
}

const plainPoints = (points) => points.map((point) => ({ beat: roundBeat(point.beat), value: roundValue(point.value) }))

function pointsEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i].beat - b[i].beat) > 1e-6) return false
    if (Math.abs(a[i].value - b[i].value) > 1e-6) return false
  }
  return true
}

/** 线性插值（越界取端点）；无点返回 null。 */
function valueAt(points, beat) {
  if (!points.length) return null
  if (beat <= points[0].beat) return points[0].value
  const last = points[points.length - 1]
  if (beat >= last.beat) return last.value
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const next = points[i]
    if (beat <= next.beat) {
      const span = next.beat - prev.beat
      if (span <= 1e-6) return next.value
      const t = (beat - prev.beat) / span
      return prev.value + (next.value - prev.value) * t
    }
  }
  return last.value
}

/* ────────────────────────────── 绘制 ────────────────────────────── */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 静态层：网格 / 坐标轴 / 曲线 / 点 / 引导线。 */
function drawStatic(ctx, layout, state) {
  const { width, height, gridW, gridH } = layout
  const { points, enabled, param, beatsPerBar, totalBeats, selectedUid, hoverUid, baseline } = state
  const color = PARAMS[param]?.color ?? palette.coral
  const curveColor = enabled ? color : palette.faint

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, width, height)

  // 绘图区
  ctx.fillStyle = '#FDFCF9'
  ctx.fillRect(PAD.left, PAD.top, gridW, gridH)

  // 横向网格 + 左侧值刻度
  ctx.textBaseline = 'middle'
  for (const value of [0, 0.25, 0.5, 0.75, 1]) {
    const y = Math.round(layout.yOf(value))
    ctx.fillStyle = value === 0 || value === 1 ? '#DDD6C7' : '#EFEAE0'
    ctx.fillRect(PAD.left, y, gridW, 1)
    ctx.fillStyle = '#8B8578'
    ctx.font = `400 8px ${'ui-monospace, monospace'}`
    ctx.textAlign = 'right'
    ctx.fillText(formatAxis(param, value), PAD.left - 8, y)
  }

  // 纵向小节 / 拍刻度
  const barCount = Math.max(1, Math.round(totalBeats / beatsPerBar))
  const barPx = beatsPerBar * layout.pxPerBeat
  const labelStep = barPx >= 34 ? 1 : barPx >= 20 ? 2 : 4
  for (let bar = 0; bar <= barCount; bar += 1) {
    const beat = bar * beatsPerBar
    const x = Math.round(layout.xOf(beat))
    const isEdge = bar === 0 || bar === barCount
    ctx.fillStyle = isEdge ? '#DDD6C7' : bar % 4 === 0 ? '#DCD5C6' : '#EDE8DD'
    ctx.fillRect(x, PAD.top, 1, gridH)
    if (bar < barCount && (bar % labelStep === 0 || bar === 0)) {
      ctx.fillStyle = '#B7B0A1'
      ctx.font = `400 8px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.fillText(String(bar + 1), x + Math.min(barPx / 2, 14), PAD.top - 6)
    }
  }
  // 拍刻度（只画小 tick，避免过密）
  const beatPx = layout.pxPerBeat
  if (beatPx >= 5) {
    for (let beat = 0; beat <= totalBeats; beat += 1) {
      if (beat % beatsPerBar === 0) continue
      const x = Math.round(layout.xOf(beat))
      ctx.fillStyle = '#D7D0C2'
      ctx.fillRect(x, PAD.top - 4, 1, 4)
    }
  }

  // 空曲线基线（当前静态参数值）
  if (!points.length) {
    const y = Math.round(layout.yOf(baseline))
    ctx.strokeStyle = '#C8C0B1'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(PAD.left + 1, y)
    ctx.lineTo(PAD.left + gridW - 1, y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // 曲线（两端延伸到工程首尾）
  if (points.length) {
    const series = []
    if (points[0].beat > 1e-6) series.push({ beat: 0, value: points[0].value })
    series.push(...points)
    const last = points[points.length - 1]
    if (last.beat < totalBeats - 1e-6) series.push({ beat: totalBeats, value: last.value })

    // 面积
    ctx.beginPath()
    ctx.moveTo(layout.xOf(series[0].beat), layout.yOf(series[0].value))
    for (let i = 1; i < series.length; i += 1) ctx.lineTo(layout.xOf(series[i].beat), layout.yOf(series[i].value))
    ctx.lineTo(layout.xOf(totalBeats), PAD.top + gridH)
    ctx.lineTo(layout.xOf(0), PAD.top + gridH)
    ctx.closePath()
    ctx.fillStyle = enabled ? alpha(color, 0.09) : 'rgba(183,176,161,0.07)'
    ctx.fill()

    // 折线
    ctx.beginPath()
    ctx.moveTo(layout.xOf(series[0].beat), layout.yOf(series[0].value))
    for (let i = 1; i < series.length; i += 1) ctx.lineTo(layout.xOf(series[i].beat), layout.yOf(series[i].value))
    ctx.strokeStyle = curveColor
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    if (!enabled) ctx.setLineDash([5, 4])
    ctx.stroke()
    ctx.setLineDash([])
  }

  // 自动化点
  for (const point of points) {
    const x = layout.xOf(point.beat)
    const y = layout.yOf(point.value)
    const isSelected = point.uid === selectedUid
    const isHover = point.uid === hoverUid
    if (isSelected) {
      // 十字引导线
      ctx.strokeStyle = alpha(color, 0.4)
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x, PAD.top + gridH)
      ctx.moveTo(x, y)
      ctx.lineTo(PAD.left + 1, y)
      ctx.stroke()
      ctx.setLineDash([])
    }
    const radius = isSelected ? 5.6 : isHover ? 5.2 : 4.2
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fillStyle = enabled ? color : '#FFFFFF'
    ctx.fill()
    ctx.lineWidth = isSelected ? 2.4 : 1.8
    ctx.strokeStyle = isSelected ? '#FFFFFF' : enabled ? tint(color, 0.35) : palette.faint
    ctx.stroke()
    if (isSelected) {
      ctx.beginPath()
      ctx.arc(x, y, radius + 2.2, 0, Math.PI * 2)
      ctx.strokeStyle = alpha(color, 0.55)
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  // 悬停/选中的点信息气泡
  const tipPoint = points.find((point) => point.uid === (hoverUid ?? selectedUid))
  if (tipPoint) {
    const text = `${formatValue(param, tipPoint.value)} @ ${tipPoint.beat.toFixed(2).replace(/\.?0+$/, '') || '0'} 拍`
    const x = layout.xOf(tipPoint.beat)
    const y = layout.yOf(tipPoint.value)
    ctx.font = `500 8px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`
    const textWidth = ctx.measureText(text).width
    const chipW = Math.ceil(textWidth + 12)
    const chipH = 16
    let chipX = x - chipW / 2
    chipX = clamp(chipX, PAD.left + 2, width - PAD.right - chipW - 2)
    const above = y - chipH - 10 >= 0
    const chipY = above ? y - chipH - 9 : y + 9
    ctx.fillStyle = 'rgba(255,255,255,0.96)'
    ctx.strokeStyle = tint(color, 0.55)
    ctx.lineWidth = 1
    roundRect(ctx, chipX, chipY, chipW, chipH, 4)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = shade(color, 0.34)
    ctx.textAlign = 'center'
    ctx.fillText(text, chipX + chipW / 2, chipY + chipH / 2 + 0.5)
  }
}

/** 动态层：播放位置竖线 + 当前值。 */
function drawOverlay(ctx, layout, state, playheadBeat) {
  const { points, param, enabled } = state
  if (!Number.isFinite(playheadBeat) || playheadBeat < -1e-6 || playheadBeat > layout.totalBeats + 1e-6) return
  const color = PARAMS[param]?.color ?? palette.coral
  const x = layout.xOf(playheadBeat)
  const value = valueAt(points, playheadBeat)
  const current = value === null ? state.baseline : value

  ctx.save()
  ctx.fillStyle = 'rgba(242,107,58,0.9)'
  ctx.fillRect(Math.round(x), PAD.top - 6, 2, layout.gridH + 6)
  // 顶端三角
  ctx.beginPath()
  ctx.moveTo(x - 5, PAD.top - 12)
  ctx.lineTo(x + 5, PAD.top - 12)
  ctx.lineTo(x + 5, PAD.top - 8)
  ctx.lineTo(x, PAD.top - 3)
  ctx.lineTo(x - 5, PAD.top - 8)
  ctx.closePath()
  ctx.fill()
  // 当前插值点
  const y = layout.yOf(current)
  ctx.beginPath()
  ctx.arc(x, y, 4, 0, Math.PI * 2)
  ctx.fillStyle = enabled ? '#FFFFFF' : '#FFFFFF'
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = enabled ? color : palette.faint
  ctx.stroke()
  ctx.restore()
}

export const AutomationPanel = memo(function AutomationPanel({
  project, tracks = [], selectedTrackId, engine,
  editable = false, onSelectTrack, onCommit, onClear, onCommitTempo, onClearTempo, onNotify, keyboardEnabled = true,
}) {
  const totalBeats = Math.max(4, Math.round((Number(project?.lengthBars) || 1) * ((project?.timeSignature?.[0]) || 4)))
  const beatsPerBar = (project?.timeSignature?.[0]) || 4
  const trackById = useMemo(() => new Map((tracks ?? []).map((track) => [track.id, track])), [tracks])

  const [target, setTarget] = useState(() => (
    selectedTrackId && tracks.some((track) => track.id === selectedTrackId) ? selectedTrackId : (tracks[0]?.id ?? 'master')
  ))
  const [param, setParam] = useState('volume')
  const [points, setPoints] = useState([])
  const [enabled, setEnabled] = useState(true)
  const [selectedUid, setSelectedUid] = useState(null)
  const [hoverUid, setHoverUid] = useState(null)
  const [hasEntry, setHasEntry] = useState(false)

  const pointsRef = useRef([])
  const enabledRef = useRef(true)
  const selectedRef = useRef(null)
  const hoverRef = useRef(null)
  const entryRef = useRef(false)
  const gestureRef = useRef(null)
  const keyThrottleRef = useRef({})
  const propsRef = useRef({})
  const [wrapRef, size] = useElementSize()
  const canvasRef = useRef(null)
  const ctxRef = useRef(null)
  const staticRef = useRef(null)
  const sizeRef = useRef(size)
  sizeRef.current = size

  const track = target === 'master' ? null : (trackById.get(target) ?? null)
  const isMaster = target === 'master'
  const paramMeta = PARAMS[param] ?? PARAMS.volume
  const isTempo = param === 'tempo'
  const sourceAutomation = isMaster ? (project?.master?.automation ?? {}) : (track?.automation ?? {})
  const tempoEntry = useMemo(() => {
    if (!isTempo) return null
    const raw = Array.isArray(project?.tempoMap) ? project.tempoMap : []
    if (raw.length === 0) return null
    return {
      enabled: true,
      points: raw.map((point) => ({ beat: Number(point?.beat) || 0, value: tempoValueOf(point?.bpm) })),
    }
  }, [isTempo, project?.tempoMap])
  const entry = isTempo ? tempoEntry : (sourceAutomation?.[param] ?? null)

  propsRef.current = {
    target, param, editable, onCommit, onClear, onCommitTempo, onClearTempo, onNotify,
    track, project, totalBeats, beatsPerBar, keyboardEnabled,
  }

  const baseline = useMemo(() => {
    if (isTempo) return tempoValueOf(project?.bpm ?? 128)
    if (param === 'pitchBend') return DEFAULT_VALUE.pitchBend
    if (param === 'modulation') return DEFAULT_VALUE.modulation
    if (param === 'expression') return DEFAULT_VALUE.expression
    if (isMaster) return clamp(Number(project?.master?.volume ?? DEFAULT_VALUE.volume) || 0, 0, 1)
    if (!track) return DEFAULT_VALUE[param] ?? 0.5
    if (param === 'volume') return clamp(Number(track.volume ?? 0.8) || 0, 0, 1)
    if (param === 'pan') return clamp((Number(track.pan ?? 0) || 0) * 0.5 + 0.5, 0, 1)
    return DEFAULT_VALUE.cutoff
  }, [isTempo, project?.bpm, isMaster, project?.master?.volume, track, param])
  const baselineRef = useRef(baseline)
  baselineRef.current = baseline

  const layout = useMemo(() => {
    const width = size.width
    const height = size.height
    const gridW = Math.max(20, width - PAD.left - PAD.right)
    const gridH = Math.max(20, height - PAD.top - PAD.bottom)
    const pxPerBeat = gridW / totalBeats
    return {
      width,
      height,
      gridW,
      gridH,
      pxPerBeat,
      totalBeats,
      xOf: (beat) => PAD.left + (clamp(Number(beat) || 0, 0, totalBeats) / totalBeats) * gridW,
      yOf: (value) => PAD.top + (1 - clamp(Number(value) || 0, 0, 1)) * gridH,
      beatOf: (x) => clamp(((x - PAD.left) / gridW) * totalBeats, 0, totalBeats),
      valueOf: (y) => clamp(1 - ((y - PAD.top) / gridH), 0, 1),
    }
  }, [size.width, size.height, totalBeats])
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const engineRef = useRef(engine)
  engineRef.current = engine
  const projectRef = useRef(project)
  projectRef.current = project

  /* ── target / param 合法性 ── */
  useEffect(() => {
    if (target === 'master' || trackById.has(target)) return
    const fallback = selectedTrackId && trackById.has(selectedTrackId) ? selectedTrackId : (tracks[0]?.id ?? 'master')
    setTarget(fallback)
  }, [target, trackById, selectedTrackId, tracks])

  useEffect(() => {
    if (isMaster && param !== 'volume' && param !== 'tempo') setParam('volume')
  }, [isMaster, param])

  /* ── 宿主数据 → 本地 points 同步（内容一致时保留本地 uid/选择） ── */
  useEffect(() => {
    if (gestureRef.current) return
    const next = normalizePoints(entry?.points, totalBeats)
    if (!pointsEqual(pointsRef.current, next)) {
      pointsRef.current = next
      setPoints(next)
      selectedRef.current = null
      setSelectedUid(null)
      hoverRef.current = null
      setHoverUid(null)
    }
    const nextEnabled = entry?.enabled !== false
    if (enabledRef.current !== nextEnabled) {
      enabledRef.current = nextEnabled
      setEnabled(nextEnabled)
    }
    entryRef.current = Boolean(entry)
    setHasEntry(Boolean(entry))
    redraw()
  }, [entry, totalBeats, project?.revision]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 绘制基础设施 ── */
  const paint = useCallback((positionBar) => {
    const ctx = ctxRef.current
    const offset = staticRef.current
    const currentLayout = layoutRef.current
    const { width, height } = sizeRef.current
    if (!ctx || !offset || !currentLayout || width < 8) return
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(offset.canvas, 0, 0, width, height)
    const bars = Number.isFinite(positionBar)
      ? positionBar
      : (engineRef.current ? engineRef.current.positionBar : (Number(projectRef.current?.transport?.playheadBar) || 0))
    drawOverlay(ctx, currentLayout, {
      points: pointsRef.current,
      param: propsRef.current.param,
      enabled: enabledRef.current,
      baseline: baselineRef.current,
    }, bars * propsRef.current.beatsPerBar)
  }, [])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const currentLayout = layoutRef.current
    const { width, height } = sizeRef.current
    if (!canvas || !currentLayout || width < 8 || height < 8) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const pixelWidth = Math.round(width * dpr)
    const pixelHeight = Math.round(height * dpr)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctxRef.current = ctx
    let offscreen = staticRef.current
    if (!offscreen || offscreen.canvas.width !== pixelWidth || offscreen.canvas.height !== pixelHeight) {
      const offCanvas = document.createElement('canvas')
      offCanvas.width = pixelWidth
      offCanvas.height = pixelHeight
      const offCtx = offCanvas.getContext('2d')
      offCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      offscreen = { canvas: offCanvas, ctx: offCtx }
      staticRef.current = offscreen
    }
    drawStatic(offscreen.ctx, currentLayout, {
      points: pointsRef.current,
      enabled: enabledRef.current,
      param: propsRef.current.param,
      beatsPerBar: propsRef.current.beatsPerBar,
      totalBeats: propsRef.current.totalBeats,
      selectedUid: selectedRef.current,
      hoverUid: hoverRef.current,
      baseline: baselineRef.current,
    })
    paint()
  }, [paint])

  // 布局/参数/选中变化 → 重绘
  useEffect(() => {
    redraw()
  }, [layout, redraw, param, target, points, enabled, selectedUid, hoverUid])

  /* ── 每帧：播放头 + 顶部读数 ── */
  const beatReadoutRef = useRef(null)
  const valueReadoutRef = useRef(null)
  useFrame(engine, (e, now, frame) => {
    paint(e ? e.positionBar : undefined)
    if (frame % 4 !== 0) return
    const eng = engineRef.current
    const positionBar = e ? e.positionBar : (eng ? eng.positionBar : (Number(projectRef.current?.transport?.playheadBar) || 0))
    const beat = Math.max(0, positionBar * propsRef.current.beatsPerBar)
    const value = valueAt(pointsRef.current, beat)
    const current = value === null ? baselineRef.current : value
    if (beatReadoutRef.current) beatReadoutRef.current.textContent = `${beat.toFixed(1)} 拍`
    if (valueReadoutRef.current) valueReadoutRef.current.textContent = formatValue(propsRef.current.param, current)
  })

  /* ── E2E 钩子（standalone / 显式开启时） ── */
  const e2eRef = useRef(null)
  e2eRef.current = (beat, value) => {
    const currentLayout = layoutRef.current
    if (!currentLayout) return null
    return { x: currentLayout.xOf(beat), y: currentLayout.yOf(value) }
  }
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!window.__AIMS_STANDALONE__ && !window.__AIMS_E2E_FORCE__) return undefined
    const previous = window.__AIMS_E2E__
    const exposed = {
      ...(previous || {}),
      automationPoint: (beat, value) => e2eRef.current?.(beat, value) ?? null,
    }
    window.__AIMS_E2E__ = exposed
    return () => {
      try {
        if (window.__AIMS_E2E__ === exposed) {
          if (previous) window.__AIMS_E2E__ = previous
          else delete window.__AIMS_E2E__
        }
      } catch (err) { /* ignore */ }
    }
  }, [])

  /* ── 写回宿主 ── */
  const commitPoints = useCallback((nextPoints, nextEnabled, label) => {
    const { param: currentParam, onCommit: commit, onCommitTempo: commitTempo } = propsRef.current
    if (!currentParam) return
    if (currentParam === 'tempo') {
      commitTempo?.({ type: 'setTempoMap', points: plainTempoPoints(nextPoints) }, label || '编辑速度')
      return
    }
    const { target: currentTarget } = propsRef.current
    if (!currentTarget) return
    const payload = {
      type: 'setAutomation',
      target: currentTarget === 'master' ? 'master' : 'track',
      param: currentParam,
      points: plainPoints(nextPoints),
      enabled: nextEnabled !== false,
    }
    if (currentTarget !== 'master') payload.trackId = currentTarget
    commit?.(payload, label || '编辑自动化')
  }, [])

  const notifyReadOnly = useCallback(() => {
    propsRef.current.onNotify?.('只读模式：宿主编辑接口尚未就绪', 'error')
  }, [])

  const handleClear = useCallback(() => {
    if (!propsRef.current.editable) { notifyReadOnly(); return }
    const { target: currentTarget, param: currentParam } = propsRef.current
    if (!currentTarget) return
    const hadAnything = pointsRef.current.length > 0 || enabledRef.current === false || entryRef.current
    pointsRef.current = []
    setPoints([])
    enabledRef.current = true
    setEnabled(true)
    selectedRef.current = null
    setSelectedUid(null)
    hoverRef.current = null
    setHoverUid(null)
    setHasEntry(false)
    redraw()
    if (!hadAnything) {
      propsRef.current.onNotify?.('当前参数没有自动化数据', 'info')
      return
    }
    if (currentParam === 'tempo') {
      propsRef.current.onClearTempo?.({ type: 'clearTempoMap' }, '清除速度')
      propsRef.current.onNotify?.('已清空速度曲线（Ctrl+Z 可撤销）', 'info')
      return
    }
    const payload = {
      type: 'clearAutomation',
      target: currentTarget === 'master' ? 'master' : 'track',
      param: currentParam,
    }
    if (currentTarget !== 'master') payload.trackId = currentTarget
    propsRef.current.onClear?.(payload, '清除自动化')
    propsRef.current.onNotify?.('已清空自动化（Ctrl+Z 可撤销）', 'info')
  }, [notifyReadOnly, redraw])

  const handleToggleEnabled = useCallback((next) => {
    if (!propsRef.current.editable) { notifyReadOnly(); return }
    if (propsRef.current.param === 'tempo') {
      propsRef.current.onNotify?.('速度曲线始终生效，无需启用开关', 'info')
      return
    }
    enabledRef.current = next
    setEnabled(next)
    redraw()
    if (pointsRef.current.length || entryRef.current) {
      commitPoints(pointsRef.current, next, next ? '启用自动化' : '禁用自动化')
    }
  }, [commitPoints, notifyReadOnly, redraw])

  const deletePoint = useCallback((uid) => {
    if (!propsRef.current.editable) { notifyReadOnly(); return }
    const next = pointsRef.current.filter((point) => point.uid !== uid)
    if (next.length === pointsRef.current.length) return
    pointsRef.current = next
    setPoints(next)
    if (selectedRef.current === uid) { selectedRef.current = null; setSelectedUid(null) }
    if (hoverRef.current === uid) { hoverRef.current = null; setHoverUid(null) }
    redraw()
    commitPoints(next, enabledRef.current, '删除自动化点')
  }, [commitPoints, notifyReadOnly, redraw])

  /* ── 指针交互 ── */
  const pointOf = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const hitPoint = (px, py) => {
    const currentLayout = layoutRef.current
    if (!currentLayout) return null
    let best = null
    let bestDistance = 10 * 10
    for (const point of pointsRef.current) {
      const dx = px - currentLayout.xOf(point.beat)
      const dy = py - currentLayout.yOf(point.value)
      const distance = dx * dx + dy * dy
      if (distance <= bestDistance) {
        bestDistance = distance
        best = point
      }
    }
    return best
  }

  const onPointerDown = (event) => {
    if (event.button !== 0) return
    const currentLayout = layoutRef.current
    const canvas = canvasRef.current
    if (!currentLayout || !canvas) return
    const { x, y } = pointOf(event)
    if (x < PAD.left || x > currentLayout.width - PAD.right || y < PAD.top || y > currentLayout.height - PAD.bottom) return
    if (event.detail >= 2) {
      event.preventDefault()
      handleClear()
      return
    }
    if (!propsRef.current.editable) { notifyReadOnly(); return }
    const hit = hitPoint(x, y)
    event.preventDefault()
    try { canvas.setPointerCapture(event.pointerId) } catch (err) { /* ignore */ }
    if (hit) {
      selectedRef.current = hit.uid
      setSelectedUid(hit.uid)
      gestureRef.current = { type: 'move', pointerId: event.pointerId, dirty: false }
      canvas.style.cursor = 'grabbing'
      redraw()
      return
    }
    if (pointsRef.current.length >= MAX_POINTS) {
      propsRef.current.onNotify?.(`自动化点最多 ${MAX_POINTS} 个`, 'info')
      return
    }
    const beat = roundBeat(clamp(snapTo(currentLayout.beatOf(x), SNAP), 0, currentLayout.totalBeats))
    const value = roundValue(currentLayout.valueOf(y))
    const point = { uid: nextUid(), beat, value }
    const next = [...pointsRef.current, point].sort((a, b) => a.beat - b.beat)
    pointsRef.current = next
    setPoints(next)
    selectedRef.current = point.uid
    setSelectedUid(point.uid)
    gestureRef.current = { type: 'move', pointerId: event.pointerId, dirty: true }
    canvas.style.cursor = 'grabbing'
    redraw()
  }

  const onPointerMove = (event) => {
    const currentLayout = layoutRef.current
    const canvas = canvasRef.current
    if (!currentLayout || !canvas) return
    const { x, y } = pointOf(event)
    const gesture = gestureRef.current
    if (!gesture) {
      const hit = hitPoint(x, y)
      const nextHover = hit ? hit.uid : null
      if (nextHover !== hoverRef.current) {
        hoverRef.current = nextHover
        setHoverUid(nextHover)
        canvas.style.cursor = hit ? 'grab' : 'crosshair'
      }
      return
    }
    const beat = roundBeat(clamp(snapTo(currentLayout.beatOf(x), SNAP), 0, currentLayout.totalBeats))
    const value = roundValue(currentLayout.valueOf(y))
    const dragged = pointsRef.current.filter((point) => point.uid === selectedRef.current)
    if (!dragged.length) return
    const others = pointsRef.current.filter((point) => point.uid !== selectedRef.current && Math.abs(point.beat - beat) > 1e-6)
    const next = [...others, ...dragged.map((point) => ({ ...point, beat, value }))].sort((a, b) => a.beat - b.beat)
    pointsRef.current = next
    setPoints(next)
    gesture.dirty = true
    redraw()
  }

  const onPointerUp = (event) => {
    const gesture = gestureRef.current
    if (!gesture) return
    gestureRef.current = null
    const canvas = canvasRef.current
    try { canvas?.releasePointerCapture?.(event.pointerId) } catch (err) { /* ignore */ }
    canvas.style.cursor = 'crosshair'
    if (gesture.dirty) commitPoints(pointsRef.current, enabledRef.current, '编辑自动化')
    redraw()
  }

  const onContextMenu = (event) => {
    event.preventDefault()
    const { x, y } = pointOf(event)
    const hit = hitPoint(x, y)
    if (!hit) return
    deletePoint(hit.uid)
  }

  const onDoubleClick = (event) => {
    event.preventDefault()
    handleClear()
  }

  /* ── 键盘：Delete 删点 / Esc 取消选择 ── */
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      if (isTypingTarget(event.target)) return
      if (!propsRef.current.keyboardEnabled) return
      const key = String(event.key || '').toLowerCase()
      if (throttleKeydown(keyThrottleRef, key, 200)) return
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        if (selectedRef.current != null) deletePoint(selectedRef.current)
        return
      }
      if (event.key === 'Escape') {
        selectedRef.current = null
        setSelectedUid(null)
        hoverRef.current = null
        setHoverUid(null)
        redraw()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deletePoint, redraw])

  /* ── 选择 / 清除 ── */
  const handleTrackChange = (event) => {
    const next = event.target.value
    setTarget(next)
    selectedRef.current = null
    setSelectedUid(null)
    if (next !== 'master' && typeof onSelectTrack === 'function') onSelectTrack(next)
  }
  const handleParamChange = (event) => {
    const next = event.target.value
    if (next === 'cutoff' && isMaster) return
    setParam(next)
    selectedRef.current = null
    setSelectedUid(null)
  }

  const showFilterWarning = param === 'cutoff' && !isMaster && !(track?.effects ?? []).some((fx) => fx.type === 'filter')
  const trackColor = isTempo ? palette.teal : (track?.color ?? palette.coral)
  const accent = paramMeta.color
  const valueRangeText = isTempo
    ? `值域 ${TEMPO_MIN_BPM}–${TEMPO_MAX_BPM} BPM`
    : param === 'pitchBend' ? '值域 −2..+2 st'
      : param === 'modulation' ? '值域 0..100 ct'
        : param === 'expression' ? '值域 0..100%'
          : '值域 0..1'

  return (
    <div className="aims-automation" data-testid="automation-panel">
      <div className="aims-auto-head">
        <div className="aims-auto-headline">
          <span className="aims-auto-eyebrow">AUTOMATION · 自动化曲线</span>
          <div className="aims-auto-title-row">
            <h2 className="aims-auto-title" style={{ color: shade(accent, 0.24) }}>
              <span className="aims-auto-title-icon" style={{ color: accent, background: tint(accent, 0.86), borderColor: tint(accent, 0.6) }}>
                <IconAutomation size={14} />
              </span>
              <span className="aims-auto-title-target">{isTempo ? '全局速度' : isMaster ? 'Master' : (track?.name ?? '未选择轨道')}</span>
              <span className="aims-auto-title-sep">·</span>
              <span>{paramMeta.label}</span>
            </h2>
            <span className="aims-auto-badge aims-mono">{points.length} 点</span>
            {points.length === 0 && !hasEntry ? <span className="aims-auto-badge is-empty">未设置</span> : null}
            {enabled
              ? <span className="aims-auto-state is-on">已启用</span>
              : <span className="aims-auto-state is-off">已禁用</span>}
            {isTempo ? <span className="aims-auto-global-badge" data-testid="automation-tempo-global">全局 · {TEMPO_MIN_BPM}–{TEMPO_MAX_BPM} BPM</span> : null}
            {editable
              ? <span className="aims-auto-editable">可编辑 · 吸附 1/4 拍</span>
              : <span className="aims-auto-readonly">只读 · 宿主编辑接口未就绪</span>}
          </div>
          <div className="aims-auto-meta">
            <span className="aims-auto-meta-item" style={{ color: trackColor }}>
              <span className="aims-auto-meta-dot" style={{ background: trackColor }} />
              {isTempo ? '全局速度（所有轨道 / Master 共用）' : isMaster ? 'Master 总线音量' : `轨道 ${track?.name ?? '—'}`}
            </span>
            <span className="aims-auto-meta-sep">·</span>
            <span className="aims-auto-meta-item">0 – {totalBeats} 拍（{Math.round(totalBeats / beatsPerBar)} 小节）</span>
            <span className="aims-auto-meta-sep">·</span>
            <span className="aims-auto-meta-item">{valueRangeText}</span>
            <span className="aims-auto-meta-sep">·</span>
            <span className="aims-auto-meta-item">{isTempo ? '分段线性插值 · 随播放实时生效' : '线性插值 · 随播放实时生效'}</span>
          </div>
        </div>
        <div className="aims-auto-current" title="播放位置与该参数当前的自动化插值">
          <div className="aims-auto-current-item">
            <span className="aims-auto-current-label">播放位置</span>
            <span className="aims-auto-current-value aims-mono" ref={beatReadoutRef}>0.0 拍</span>
          </div>
          <div className="aims-auto-current-item is-accent">
            <span className="aims-auto-current-label">当前值</span>
            <span className="aims-auto-current-value aims-mono" ref={valueReadoutRef} style={{ color: shade(accent, 0.26) }}>
              {formatValue(param, baseline)}
            </span>
          </div>
        </div>
      </div>

      <div className="aims-auto-toolbar">
        <label className="aims-auto-field">
          <span className="aims-auto-label">轨道</span>
          {isTempo ? (
            <span className="aims-auto-global-target" data-testid="automation-tempo-target" title="速度曲线是全局的，不属于某条轨道">
              全局速度
            </span>
          ) : (
            <span className="aims-auto-select">
              <select
                data-testid="automation-track-select"
                aria-label="选择自动化目标轨道"
                value={target}
                onChange={handleTrackChange}
                title="选择要编辑自动化的轨道（含 Master）"
              >
                <option value="master">Master（总线音量）</option>
                {(tracks ?? []).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              <IconChevronDown size={11} className="aims-auto-select-caret" />
            </span>
          )}
        </label>

        <label className="aims-auto-field">
          <span className="aims-auto-label">参数</span>
          <span className="aims-auto-select">
            <select
              data-testid="automation-param-select"
              aria-label="选择自动化参数"
              value={param}
              onChange={handleParamChange}
              title="音量 / 声像 / 滤波 Cutoff / 弯音 / 调制 / 表情 / CC1/11/64/74 / 速度 Tempo（速度曲线为全局，Master 仅音量）"
            >
              {PARAM_KEYS.map((key) => (
                <option key={key} value={key} disabled={isMaster && key !== 'volume' && key !== 'tempo'}>
                  {PARAMS[key].label}
                </option>
              ))}
            </select>
            <IconChevronDown size={11} className="aims-auto-select-caret" />
          </span>
        </label>

        <div className="aims-auto-field aims-auto-field--switch">
          <span className="aims-auto-label">启用</span>
          <Switch
            checked={enabled}
            onChange={handleToggleEnabled}
            testId="automation-enable"
            color={accent}
            disabled={isTempo}
            title={isTempo ? '速度曲线始终生效（无启用开关）' : enabled ? '禁用该参数自动化（保留曲线）' : '启用该参数自动化'}
            label={`${paramMeta.label} 自动化启用`}
          />
        </div>

        <div className="aims-auto-field-actions">
          <button
            type="button"
            className="aims-auto-clear"
            data-testid="automation-clear"
            onClick={handleClear}
            title={isTempo ? '清空全局速度曲线（可撤销）' : '清空该参数的所有自动化点（可撤销）'}
            aria-label="清空自动化"
          >
            <IconTrash size={12} />
            清空
          </button>
        </div>

        <span className="aims-auto-toolbar-hint">
          {isTempo
            ? '速度曲线为全局 tempoMap · 点击加点 · 拖动改 beat/BPM · 右键删除 · 双击清空'
            : `${CC_PARAM_HINTS[param] ? `${CC_PARAM_HINTS[param]} · ` : ''}点击空处加点 · 拖动改 beat/value · 右键删除 · 双击清空`}
        </span>
      </div>

      {showFilterWarning ? (
        <div className="aims-auto-warning" role="status">
          <IconFilter size={13} />
          该轨还没有 Filter 效果器，可先在效果器视图添加（否则 Cutoff 自动化不会生效）
        </div>
      ) : null}

      <div className="aims-auto-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="aims-auto-canvas"
          data-testid="automation-canvas"
          data-pad-left={PAD.left}
          data-pad-top={PAD.top}
          data-pad-right={PAD.right}
          data-pad-bottom={PAD.bottom}
          data-px-per-beat={layout.pxPerBeat.toFixed(4)}
          data-value-height={layout.gridH.toFixed(4)}
          data-total-beats={totalBeats}
          data-points-count={points.length}
          data-param={param}
          data-target={isTempo ? 'global' : target}
          data-tempo-map={isTempo ? '1' : '0'}
          data-tempo-min={TEMPO_MIN_BPM}
          data-tempo-max={TEMPO_MAX_BPM}
          data-enabled={enabled ? '1' : '0'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            if (gestureRef.current) return
            if (hoverRef.current !== null) {
              hoverRef.current = null
              setHoverUid(null)
              redraw()
            }
          }}
          onContextMenu={onContextMenu}
          onDoubleClick={onDoubleClick}
          aria-label={`自动化曲线：${isTempo ? '全局速度' : isMaster ? 'Master' : track?.name ?? ''} ${paramMeta.label}，${points.length} 个点`}
          role="application"
          tabIndex={0}
        />
        {points.length === 0 ? (
          <div className="aims-auto-empty" aria-hidden="true">
            <span className="aims-auto-empty-title">{isTempo ? '点一下添加速度点' : '点一下曲线添加自动化点'}</span>
            <small>{isTempo ? `拖动点调整 beat / BPM（${TEMPO_MIN_BPM}–${TEMPO_MAX_BPM}）；右键或 Delete 删除；双击清空速度曲线` : '拖动点可调整 beat / value；右键或 Delete 删除；双击清空该参数'}</small>
          </div>
        ) : null}
        <div className="aims-auto-corner" title="坐标轴信息">
          <span className={`aims-auto-corner-dot ${enabled ? 'is-live' : ''}`} />
          {beatsPerBar}/4 · {Math.round(totalBeats / beatsPerBar)} 小节 · 1/4 拍吸附
        </div>
      </div>

      <footer className="aims-auto-foot">
        <span className="aims-auto-foot-item">
          <span className="aims-auto-foot-swatch" style={{ background: accent }} />
          {paramMeta.label} 自动化
          {isMaster ? ' · 作用于 master.volume' : param === 'cutoff' ? ' · 作用于该轨第一个 Filter' : ''}
        </span>
        <span className="aims-auto-foot-item">手势结束一次性写回宿主 · Ctrl+Z 可撤销</span>
        <span className="aims-auto-foot-item aims-auto-foot-meta">
          A 切到自动化 · 右键/Delete 删点 · 双击清空
        </span>
      </footer>
    </div>
  )
})

export default AutomationPanel
