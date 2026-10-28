/**
 * 中栏：钢琴卷帘（P1 — 可编辑 canvas）。
 *
 * 交互：
 *  - 空白处点击/拖动：画音符（网格吸附，拖动决定时值）
 *  - 拖动音符：改音高 / 起点；拖右边缘：改时值
 *  - Shift+拖动：框选；Ctrl+A 全选；Delete 删除；Ctrl+C/V 复制粘贴；Q 量化
 *  - H / Shift+H 或工具栏 ±：横轴缩放；Shift+滚轮：横向滚动
 *  - 手势过程只改本地 notes，**松手时一次性** onCommitNotes(patternId, notes, label)
 *
 * 绘制：离屏静态层（网格/键列/音符/选择框）+ 每帧动态层（播放头/当前音符高亮）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DRUM_PIECES, findDrumKit, findDrumPiece, findScale, findSynthPreset } from '../../shared/catalog.js'
import { inKey, noteName } from '../../shared/model.js'
import { font, palette, tint } from '../theme.js'
import {
  IconWave, IconZoomIn, IconZoomOut, clamp, fmtPosition, isTypingTarget, pad, snapTo,
  throttleKeydown, useElementSize, useFrame,
} from './ui.jsx'

const RULER_H = 24
const BLACK_KEYS = new Set([1, 3, 6, 8, 10])
const SNAP_OPTIONS = [
  { key: '1/4', step: 1 },
  { key: '1/8', step: 0.5 },
  { key: '1/16', step: 0.25 },
  { key: '1/32', step: 0.125 },
]
const ZOOM_LEVELS = [1, 2, 4]

/* ── R3a：乐理 popover 的本地级数表（写操作仍由 host theory ops 计算） ── */
const THEORY_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const THEORY_SCALES = {
  major: {
    offsets: [0, 2, 4, 5, 7, 9, 11],
    romans: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'],
    qualities: ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'],
  },
  minor: {
    offsets: [0, 2, 3, 5, 7, 8, 10],
    romans: ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'],
    qualities: ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'],
  },
  dorian: {
    offsets: [0, 2, 3, 5, 7, 9, 10],
    romans: ['i', 'ii', 'III', 'IV', 'v', 'vi°', 'VII'],
    qualities: ['min', 'min', 'maj', 'maj', 'min', 'dim', 'maj'],
  },
  phrygian: {
    offsets: [0, 1, 3, 5, 7, 8, 10],
    romans: ['i', 'II', 'III', 'iv', 'v°', 'VI', 'vii'],
    qualities: ['min', 'maj', 'maj', 'min', 'dim', 'maj', 'min'],
  },
  harmonicMinor: {
    offsets: [0, 2, 3, 5, 7, 8, 11],
    romans: ['i', 'ii°', 'III+', 'iv', 'V', 'VI', 'vii°'],
    qualities: ['min', 'dim', 'aug', 'min', 'maj', 'maj', 'dim'],
  },
}

function theoryPitchClass(key) {
  const text = String(key ?? 'C').trim()
  const match = text.match(/^([A-Ga-g])([#b♯♭]?)/)
  if (!match) return 0
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1].toUpperCase()] ?? 0
  const accidental = match[2] === '#' || match[2] === '♯' ? 1 : (match[2] === 'b' || match[2] === '♭' ? -1 : 0)
  return ((base + accidental) % 12 + 12) % 12
}

function theoryChordSuffix(quality) {
  if (quality === 'min') return 'm'
  if (quality === 'dim') return 'dim'
  if (quality === 'aug') return 'aug'
  return ''
}

function theoryDiatonicChords(project) {
  const scaleId = String(project?.scale ?? 'minor')
  const spec = THEORY_SCALES[scaleId] ?? THEORY_SCALES.minor
  const root = theoryPitchClass(project?.key)
  return spec.offsets.map((offset, index) => {
    const pc = (root + offset) % 12
    const quality = spec.qualities[index]
    return {
      roman: spec.romans[index],
      quality,
      name: `${THEORY_NOTE_NAMES[pc]}${theoryChordSuffix(quality)}`,
      pitchClass: pc,
      degree: index + 1,
    }
  })
}

const THEORY_PROGRESSIONS = [
  { id: '1-5-6-4', label: 'I–V–vi–IV', progression: ['I', 'V', 'vi', 'IV'] },
  { id: '2-5-1', label: 'ii–V–I', progression: ['ii', 'V', 'I'] },
]


let uidSeq = 1
const nextUid = () => {
  uidSeq += 1
  return uidSeq
}

const roundBeat = (value) => Math.round(Number(value) * 1000) / 1000

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

/** 项目音符 → 带本地 uid 的工作副本。 */
function toWorkingNotes(notes) {
  return (notes ?? []).map((note) => ({
    uid: nextUid(),
    pitch: clamp(Math.round(Number(note.pitch) || 0), 0, 127),
    start: Math.max(0, Number(note.start) || 0),
    dur: Math.max(0.02, Number(note.dur) || 0.25),
    vel: clamp(note.vel ?? 0.8, 0.05, 1),
  }))
}

/** 工作副本 → 提交给宿主的纯数据。 */
function toPlainNotes(notes) {
  return notes.map((note) => ({
    pitch: Math.round(clamp(note.pitch, 0, 127)),
    start: roundBeat(Math.max(0, note.start)),
    dur: roundBeat(Math.max(0.02, note.dur)),
    vel: Math.round(clamp(note.vel, 0.05, 1) * 100) / 100,
  }))
}

function notesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].pitch !== b[i].pitch) return false
    if (Math.abs(a[i].start - b[i].start) > 1e-4) return false
    if (Math.abs(a[i].dur - b[i].dur) > 1e-4) return false
    if (Math.abs(a[i].vel - b[i].vel) > 1e-3) return false
  }
  return true
}

/** 鼓组音高吸附到最近的 GM 鼓件。 */
function nearestDrumPitch(pitch) {
  let best = DRUM_PIECES[0].pitch
  let bestDistance = Infinity
  for (const piece of DRUM_PIECES) {
    const distance = Math.abs(piece.pitch - pitch)
    if (distance < bestDistance) {
      bestDistance = distance
      best = piece.pitch
    }
  }
  return best
}

/** 计算卷帘布局（行 = 音高 / 鼓件）。 */
function buildLayout({ pattern, track, project, width, height }) {
  const beats = project?.timeSignature?.[0] ?? 4
  const kind = track?.kind === 'drum' ? 'drum' : 'synth'
  const patBars = Math.max(1, Number(pattern?.lengthBars) || 4)
  const totalBeats = patBars * beats
  const keyW = kind === 'drum' ? 96 : 64
  const gridW = Math.max(24, width - keyW)
  const availH = Math.max(24, height - RULER_H)
  const notes = pattern?.notes ?? []

  if (kind === 'drum') {
    const rows = [...DRUM_PIECES]
      .sort((a, b) => b.pitch - a.pitch)
      .map((piece) => ({ pitch: piece.pitch, label: piece.label, name: piece.name, color: piece.color, black: false, inScale: true }))
    const rowH = clamp(availH / rows.length, 15, 72)
    const top = RULER_H + Math.max(0, (availH - rowH * rows.length) / 2)
    const pitchIndex = new Map(rows.map((row, i) => [row.pitch, i]))
    return { kind, rows, rowH, top, keyW, gridW, totalBeats, beats, patBars, pitchIndex, availH }
  }

  let minPitch = 127
  let maxPitch = 0
  for (const note of notes) {
    minPitch = Math.min(minPitch, note.pitch)
    maxPitch = Math.max(maxPitch, note.pitch)
  }
  if (minPitch > maxPitch) {
    minPitch = 60
    maxPitch = 67
  }
  const rowH = clamp(availH / 30, 10, 16)
  const visible = Math.max(13, Math.round(availH / rowH))
  const mid = Math.round((minPitch + maxPitch) / 2)
  let topPitch = mid + Math.floor(visible / 2)
  topPitch = Math.min(127, Math.max(topPitch, maxPitch + 1))
  topPitch = Math.max(visible - 1, Math.min(127, topPitch))
  const rows = []
  for (let i = 0; i < visible; i += 1) {
    const pitch = topPitch - i
    rows.push({
      pitch,
      label: noteName(pitch),
      name: noteName(pitch),
      color: track?.color ?? palette.coral,
      black: BLACK_KEYS.has(((pitch % 12) + 12) % 12),
      inScale: inKey(project, pitch),
    })
  }
  const top = RULER_H
  const pitchIndex = new Map(rows.map((row, i) => [row.pitch, i]))
  return { kind, rows, rowH, top, keyW, gridW, totalBeats, beats, patBars, pitchIndex, availH, minPitch, maxPitch }
}

function rowIndexAtY(layout, y) {
  if (!layout || y < layout.top) return -1
  const index = Math.floor((y - layout.top) / layout.rowH)
  return index >= 0 && index < layout.rows.length ? index : -1
}

/** 音符 → 屏幕几何（超出视野/音域返回 null）。 */
function noteGeometry(layout, view, note) {
  const row = layout.pitchIndex.get(note.pitch)
  if (row === undefined) return null
  const x = layout.keyW + ((note.start - view.startBeat) / view.visibleBeats) * layout.gridW
  const w = Math.max(4, (note.dur / view.visibleBeats) * layout.gridW - 1)
  const y = layout.top + row * layout.rowH + Math.max(1, layout.rowH * 0.14)
  const h = Math.max(3, layout.rowH - Math.max(2, layout.rowH * 0.28))
  if (x + w < layout.keyW || x > layout.keyW + layout.gridW) return null
  return { x, y, w, h, row }
}

function hitTestNotes(notes, layout, view, px, py) {
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i]
    const geometry = noteGeometry(layout, view, note)
    if (!geometry) continue
    if (py >= geometry.y - 1 && py <= geometry.y + geometry.h + 1 && px >= geometry.x - 2 && px <= geometry.x + geometry.w + 2) {
      return { note, geometry, edge: px >= geometry.x + geometry.w - 6 }
    }
  }
  return null
}

/** 静态层：网格 / 键列 / 音符 / 选中 / 框选。 */
function drawStatic(ctx, layout, view, notes, selected, marquee, track) {
  const { kind, rows, rowH, top, keyW, gridW, totalBeats, beats, patBars } = layout
  const trackColor = track?.color ?? palette.coral
  const viewEnd = view.startBeat + view.visibleBeats
  const pxPerBeat = gridW / view.visibleBeats
  const px16 = pxPerBeat / 4
  const xOfBeat = (beat) => keyW + ((beat - view.startBeat) / view.visibleBeats) * gridW

  ctx.clearRect(0, 0, layout.keyW + gridW, top + rows.length * rowH + 20)
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, layout.keyW + gridW, 20000)

  // ── 行底色 ──
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const y = Math.round(top + i * rowH)
    if (kind === 'synth') {
      if (row.black) ctx.fillStyle = '#F7F4ED'
      else if (row.inScale) ctx.fillStyle = '#FDFCF9'
      else ctx.fillStyle = '#FFFFFF'
    } else {
      ctx.fillStyle = i % 2 === 0 ? '#FDFCF9' : '#FAF8F2'
    }
    ctx.fillRect(keyW, y, gridW, Math.ceil(rowH))
    ctx.fillStyle = row.black && kind === 'synth' ? '#E7E1D4' : '#F1EDE3'
    ctx.fillRect(keyW, y + Math.ceil(rowH) - 1, gridW, 1)
  }

  // ── 纵向网格（只画可见区间）──
  const firstBar = Math.max(0, Math.floor(view.startBeat / beats))
  const lastBar = Math.min(patBars, Math.ceil(viewEnd / beats))
  for (let bar = firstBar; bar <= lastBar; bar += 1) {
    const beat = bar * beats
    if (beat < view.startBeat - 1e-6 || beat > viewEnd + 1e-6) continue
    const x = Math.round(xOfBeat(beat))
    ctx.fillStyle = '#DDD6C7'
    ctx.fillRect(x, RULER_H, 1, layout.availH)
  }
  for (let beatIndex = Math.ceil(view.startBeat) - 1; beatIndex <= Math.floor(viewEnd); beatIndex += 1) {
    if (beatIndex < 0) continue
    const x = Math.round(xOfBeat(beatIndex))
    if (x < keyW || x > keyW + gridW) continue
    if (beatIndex % beats === 0) continue
    ctx.fillStyle = '#EAE5DA'
    ctx.fillRect(x, RULER_H, 1, layout.availH)
  }
  if (px16 >= 5) {
    for (let step = Math.ceil(view.startBeat * 4) - 1; step <= Math.ceil(viewEnd * 4); step += 1) {
      if (step < 0 || step % 4 === 0) continue
      const x = Math.round(keyW + (step / 4 - view.startBeat) * pxPerBeat)
      if (x < keyW || x > keyW + gridW) continue
      ctx.fillStyle = '#F5F1E9'
      ctx.fillRect(x, RULER_H, 1, layout.availH)
    }
  }

  // ── 标尺 ──
  ctx.fillStyle = '#FBFAF6'
  ctx.fillRect(0, 0, keyW + gridW, RULER_H)
  ctx.fillStyle = '#E9E4DA'
  ctx.fillRect(0, RULER_H - 1, keyW + gridW, 1)
  ctx.save()
  ctx.beginPath()
  ctx.rect(keyW, 0, gridW, RULER_H)
  ctx.clip()
  ctx.font = `500 9px ${font.mono}`
  ctx.textBaseline = 'middle'
  for (let bar = firstBar; bar <= lastBar; bar += 1) {
    const beat = bar * beats
    if (beat < view.startBeat - 1e-6 || beat > viewEnd + 1e-6) continue
    const x = Math.round(xOfBeat(beat))
    ctx.fillStyle = '#DCD5C6'
    ctx.fillRect(x, RULER_H - 9, 1, 9)
    ctx.fillStyle = '#8B8578'
    ctx.textAlign = 'left'
    ctx.fillText(String(bar + 1), x + 4, RULER_H / 2)
  }
  // 缩放后的小节内拍号提示
  if (view.zoom > 1) {
    ctx.font = `400 7px ${font.mono}`
    for (let beatIndex = Math.ceil(view.startBeat); beatIndex <= Math.floor(viewEnd); beatIndex += 1) {
      if (beatIndex < 0 || beatIndex % beats === 0) continue
      const x = Math.round(xOfBeat(beatIndex))
      ctx.fillStyle = '#C9C2B4'
      ctx.textAlign = 'left'
      ctx.fillText(`.${(beatIndex % beats) + 1}`, x + 3, RULER_H / 2 + 1)
    }
  }
  ctx.restore()

  // ── 左侧键列 ──
  ctx.fillStyle = '#F8F5EE'
  ctx.fillRect(0, RULER_H, keyW, layout.availH)
  if (kind === 'synth') {
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      const y = Math.round(top + i * rowH)
      const h = Math.ceil(rowH)
      ctx.fillStyle = row.black ? '#EDE6D8' : '#FFFFFF'
      ctx.fillRect(0, y, row.black ? keyW - 12 : keyW, h)
      ctx.fillStyle = '#E9E4DA'
      ctx.fillRect(0, y + h - 1, keyW, 1)
      if (row.black) {
        ctx.fillStyle = '#DCD5C6'
        ctx.fillRect(keyW - 12, y, 1, h)
      }
      ctx.fillStyle = row.inScale ? '#6B6558' : '#A9A294'
      ctx.font = `${row.pitch % 12 === 0 ? 600 : 400} 9px ${font.mono}`
      ctx.textAlign = 'right'
      ctx.fillText(row.label, keyW - 8, y + h / 2 + 0.5)
    }
  } else {
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      const y = Math.round(top + i * rowH)
      const h = Math.ceil(rowH)
      ctx.fillStyle = '#FBFAF6'
      ctx.fillRect(0, y, keyW, h)
      ctx.fillStyle = '#E9E4DA'
      ctx.fillRect(0, y + h - 1, keyW, 1)
      ctx.fillStyle = row.color
      roundRect(ctx, 8, y + h / 2 - 3, 6, 6, 2)
      ctx.fill()
      ctx.fillStyle = '#4B463C'
      ctx.font = `500 10px ${font.ui}`
      ctx.textAlign = 'left'
      ctx.fillText(row.label, 20, y + h / 2 + 0.5)
      ctx.fillStyle = '#B7B0A1'
      ctx.font = `400 8px ${font.mono}`
      ctx.textAlign = 'right'
      ctx.fillText(row.name.toUpperCase(), keyW - 7, y + h / 2 + 0.5)
    }
  }
  ctx.fillStyle = '#E9E4DA'
  ctx.fillRect(keyW - 1, RULER_H, 1, layout.availH)

  // ── 音符 ──
  for (const note of notes) {
    const geometry = noteGeometry(layout, view, note)
    if (!geometry) continue
    const piece = kind === 'drum' ? findDrumPiece(note.pitch) : null
    const color = piece?.color ?? trackColor
    const isSelected = selected.has(note.uid)
    ctx.globalAlpha = isSelected ? 0.98 : 0.52 + note.vel * 0.44
    ctx.fillStyle = color
    roundRect(ctx, geometry.x, geometry.y, geometry.w, geometry.h, Math.min(3.5, geometry.h / 2))
    ctx.fill()
    ctx.globalAlpha = 1
    // 顶部高光
    ctx.fillStyle = 'rgba(255,255,255,0.34)'
    roundRect(ctx, geometry.x + 1, geometry.y + 1, Math.max(1, geometry.w - 2), Math.max(1, geometry.h * 0.3), Math.min(2.5, geometry.h / 3))
    ctx.fill()
    // 力度线
    if (geometry.w > 14 && geometry.h > 7) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fillRect(geometry.x + 2, geometry.y + geometry.h - 3, Math.max(1, Math.min(geometry.w - 4, note.vel * (geometry.w - 4))), 1.5)
    }
    if (isSelected) {
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 1.6
      roundRect(ctx, geometry.x + 0.5, geometry.y + 0.5, geometry.w - 1, geometry.h - 1, Math.min(3.5, geometry.h / 2))
      ctx.stroke()
      ctx.strokeStyle = palette.coral
      ctx.lineWidth = 1
      roundRect(ctx, geometry.x - 0.5, geometry.y - 0.5, geometry.w + 1, geometry.h + 1, Math.min(4, geometry.h / 2))
      ctx.stroke()
      // 右边缘时值手柄
      if (geometry.w > 10) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.fillRect(geometry.x + geometry.w - 3.5, geometry.y + 2.5, 1.5, Math.max(2, geometry.h - 5))
      }
    }
  }

  // ── 框选矩形 ──
  if (marquee && marquee.x2 - marquee.x1 > 1 && marquee.y2 - marquee.y1 > 1) {
    ctx.fillStyle = 'rgba(242,107,58,0.08)'
    ctx.fillRect(marquee.x1, marquee.y1, marquee.x2 - marquee.x1, marquee.y2 - marquee.y1)
    ctx.strokeStyle = 'rgba(242,107,58,0.72)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeRect(marquee.x1 + 0.5, marquee.y1 + 0.5, marquee.x2 - marquee.x1, marquee.y2 - marquee.y1)
    ctx.setLineDash([])
  }
}

/** 动态层：播放头 + 当前播放音符高亮。 */
function drawOverlay(ctx, layout, view, notes, positionBar, playing, track) {
  const { kind, rowH, top, keyW, gridW, totalBeats, patBars } = layout
  const patBeats = Math.max(1, totalBeats)
  const localBar = ((positionBar % patBars) + patBars) % patBars
  const localBeat = localBar * (patBeats / patBars)
  const inView = localBeat >= view.startBeat - 1e-6 && localBeat <= view.startBeat + view.visibleBeats + 1e-6
  const x = keyW + ((localBeat - view.startBeat) / view.visibleBeats) * gridW
  const trackColor = track?.color ?? palette.coral

  if (playing) {
    for (const note of notes) {
      if (localBeat < note.start - 1e-6 || localBeat >= note.start + note.dur) continue
      const row = layout.pitchIndex.get(note.pitch)
      if (row === undefined) continue
      const nx = keyW + ((note.start - view.startBeat) / view.visibleBeats) * gridW
      const nw = Math.max(4, (note.dur / view.visibleBeats) * gridW - 1)
      const ny = top + row * rowH + Math.max(1, rowH * 0.14)
      const nh = Math.max(3, rowH - Math.max(2, rowH * 0.28))
      const piece = kind === 'drum' ? findDrumPiece(note.pitch) : null
      const color = piece?.color ?? trackColor
      ctx.save()
      ctx.shadowColor = color
      ctx.shadowBlur = 12
      ctx.fillStyle = tint(color, 0.12)
      roundRect(ctx, nx - 1, ny - 1, nw + 2, nh + 2, Math.min(4, nh / 2))
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 1.2
      roundRect(ctx, nx - 0.5, ny - 0.5, nw + 1, nh + 1, Math.min(4, nh / 2))
      ctx.stroke()
    }
  }

  if (!inView) return
  ctx.save()
  ctx.globalAlpha = playing ? 1 : 0.58
  ctx.fillStyle = 'rgba(242,107,58,0.92)'
  ctx.fillRect(Math.round(x), RULER_H, 2, layout.availH)
  ctx.beginPath()
  ctx.moveTo(x - 5, 2)
  ctx.lineTo(x + 5, 2)
  ctx.lineTo(x + 5, 7)
  ctx.lineTo(x, 13)
  ctx.lineTo(x - 5, 7)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

export const PianoRoll = memo(function PianoRoll({
  project, tracks = [], selectedTrackId, selectedPatternId, engine,
  onSelectTrack, onSelectPattern,
  editable = false, zoom = 1, onZoomChange, onCommitNotes, onEdit, onNotify,
  editorCommand = null, keyboardEnabled = true,
}) {
  const [wrapRef, size] = useElementSize()
  const canvasRef = useRef(null)
  const layoutRef = useRef(null)
  const ctxRef = useRef(null)
  const staticRef = useRef(null)
  const notesRef = useRef([])
  const selectionRef = useRef(new Set())
  const gestureRef = useRef(null)
  const scrollRef = useRef(0)
  const clipboardRef = useRef(null)
  const patternIdRef = useRef(null)
  const keyThrottleRef = useRef({})
  const followAtRef = useRef(0)
  const sizeRef = useRef(size)
  sizeRef.current = size

  const [noteCount, setNoteCount] = useState(0)
  const [selCount, setSelCount] = useState(0)
  const [snapIndex, setSnapIndex] = useState(2)
  /* R3a：乐理/和弦/琶音/Groove popover */
  const [theoryOpen, setTheoryOpen] = useState(false)
  const [theoryChordRoman, setTheoryChordRoman] = useState('I')
  const [arpPattern, setArpPattern] = useState('up')
  const [arpRate, setArpRate] = useState('0.25')
  const [arpOctaves, setArpOctaves] = useState('1')
  const [grooveTemplate, setGrooveTemplate] = useState('straight')
  const [grooveStrength, setGrooveStrength] = useState('1')
  const theoryRef = useRef(null)

  const propsRef = useRef({})
  propsRef.current = { project, pattern: null, track: null, editable, onCommitNotes, onEdit, onNotify, keyboardEnabled, zoom }

  const track = useMemo(() => tracks.find((t) => t.id === selectedTrackId) ?? tracks[0] ?? null, [tracks, selectedTrackId])
  const pattern = useMemo(() => {
    const patterns = project?.patterns ?? []
    return patterns.find((p) => p.id === selectedPatternId) ?? patterns[0] ?? null
  }, [project, selectedPatternId])
  propsRef.current.pattern = pattern
  propsRef.current.track = track

  const layout = useMemo(
    () => buildLayout({ pattern, track, project, width: size.width, height: size.height }),
    [pattern, track, project, size.width, size.height],
  )
  layoutRef.current = layout

  const diatonicChords = useMemo(
    () => theoryDiatonicChords(project),
    [project?.key, project?.scale],
  )
  const theoryScaleLabel = useMemo(() => {
    const labels = { major: '大调', minor: '自然小调', dorian: 'Dorian', phrygian: 'Phrygian', harmonicMinor: '和声小调' }
    return labels[String(project?.scale ?? 'minor')] ?? String(project?.scale ?? 'minor')
  }, [project?.scale])
  const theorySelectedChord = diatonicChords.find((chord) => chord.roman === theoryChordRoman) ?? diatonicChords[0]

  const theoryPlayheadBeat = useCallback(() => {
    const projectNow = projectRef.current
    const barBeats = Number(projectNow?.timeSignature?.[0]) || 4
    const eng = engineRef.current
    const bar = Number(eng?.positionBar ?? projectNow?.transport?.playheadBar ?? 0) || 0
    const patternNow = propsRef.current.pattern
    const maxBeat = Math.max(0, (Number(patternNow?.lengthBars) || 4) * barBeats - 0.25)
    return clamp(Math.round(bar * barBeats * 4) / 4, 0, maxBeat)
  }, [])

  const runTheoryEdit = useCallback((op, label) => {
    const handler = propsRef.current.onEdit
    if (!propsRef.current.editable) { propsRef.current.onNotify?.('只读模式：无法写乐理', 'error'); return }
    if (!propsRef.current.pattern) { propsRef.current.onNotify?.('请先选择一个 Pattern', 'info'); return }
    if (typeof handler !== 'function') { propsRef.current.onNotify?.('编辑接口尚未就绪', 'error'); return }
    handler([op], label || '乐理编辑')
  }, [])

  const insertTheoryChord = (chord) => {
    setTheoryChordRoman(chord.roman)
    runTheoryEdit({
      type: 'writeChords',
      patternId: propsRef.current.pattern.id,
      progression: [chord.roman],
      startBeat: theoryPlayheadBeat(),
      beatsPerChord: 4,
      octave: 4,
      velocity: 0.8,
      voicing: 'close',
      inversion: 0,
      replaceExisting: false,
    }, `插入和弦 ${chord.roman}`)
  }

  const insertTheoryProgression = (item) => {
    runTheoryEdit({
      type: 'writeChords',
      patternId: propsRef.current.pattern.id,
      progression: item.progression,
      startBeat: theoryPlayheadBeat(),
      beatsPerChord: 4,
      octave: 4,
      velocity: 0.8,
      voicing: 'close',
      inversion: 0,
      replaceExisting: false,
    }, `插入和弦进行 ${item.label}`)
  }

  const generateTheoryArp = () => {
    runTheoryEdit({
      type: 'generateArp',
      patternId: propsRef.current.pattern.id,
      progression: [theorySelectedChord?.roman ?? 'I'],
      pattern: arpPattern,
      rate: Number(arpRate) || 0.25,
      beats: 4,
      octaves: Number(arpOctaves) || 1,
      gate: 0.9,
      velocity: 0.75,
      seed: 1,
      replaceExisting: false,
    }, '生成琶音')
  }

  const applyTheoryGroove = () => {
    runTheoryEdit({
      type: 'applyGroove',
      patternId: propsRef.current.pattern.id,
      template: grooveTemplate,
      strength: Number(grooveStrength) || 0,
    }, `应用 Groove ${grooveTemplate}`)
  }

  useEffect(() => {
    if (!theoryOpen) return undefined
    const onPointerDown = (event) => {
      if (theoryRef.current && theoryRef.current.contains(event.target)) return
      setTheoryOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setTheoryOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [theoryOpen])

  const engineRef = useRef(engine)
  engineRef.current = engine
  const projectRef = useRef(project)
  projectRef.current = project

  const getView = useCallback(() => {
    const currentLayout = layoutRef.current
    const total = currentLayout?.totalBeats ?? 16
    const z = clamp(Number(propsRef.current.zoom) || 1, 1, 8)
    const visible = total / z
    const maxStart = Math.max(0, total - visible)
    const start = clamp(scrollRef.current, 0, maxStart)
    scrollRef.current = start
    return { zoom: z, visibleBeats: visible, startBeat: start, maxStart, totalBeats: total }
  }, [])

  const getSnap = () => SNAP_OPTIONS[snapIndex]?.step ?? 0.25
  const snapRef = useRef(0.25)
  snapRef.current = SNAP_OPTIONS[snapIndex]?.step ?? 0.25

  /* ── 绘制 ─────────────────────────────────────────────── */

  const paint = useCallback((playingOverride) => {
    const ctx = ctxRef.current
    const offscreen = staticRef.current
    const currentLayout = layoutRef.current
    const { width, height } = sizeRef.current
    if (!ctx || !offscreen || !currentLayout || width < 8) return
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(offscreen.canvas, 0, 0, width, height)
    const eng = engineRef.current
    const preference = eng ? eng.positionBar : (Number(projectRef.current?.transport?.playheadBar) || 0)
    const playing = playingOverride === undefined ? Boolean(eng?.isPlaying) : Boolean(playingOverride)
    drawOverlay(ctx, currentLayout, getView(), notesRef.current, preference, playing, propsRef.current.track)
  }, [getView])

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
    drawStatic(offscreen.ctx, currentLayout, getView(), notesRef.current, selectionRef.current, gestureRef.current?.marquee ?? null, propsRef.current.track)
    paint()
  }, [getView, paint])

  const applySelection = useCallback((next) => {
    selectionRef.current = next
    setSelCount(next.size)
    redraw()
  }, [redraw])

  const commit = useCallback((label) => {
    const currentPattern = propsRef.current.pattern
    if (!currentPattern) return
    if (typeof propsRef.current.onCommitNotes !== 'function') {
      propsRef.current.onNotify?.('编辑接口未就绪：请更新宿主后端后重试', 'error')
      return
    }
    propsRef.current.onCommitNotes(currentPattern.id, toPlainNotes(notesRef.current), label)
  }, [])

  /* ── props → 本地 notes 同步 ───────────────────────────── */

  useEffect(() => {
    const incoming = toWorkingNotes(pattern?.notes ?? [])
    const changedPattern = patternIdRef.current !== (pattern?.id ?? null)
    if (changedPattern || (!gestureRef.current && !notesEqual(notesRef.current, incoming))) {
      notesRef.current = incoming
      selectionRef.current = new Set()
      patternIdRef.current = pattern?.id ?? null
      setNoteCount(incoming.length)
      setSelCount(0)
    } else if (!gestureRef.current && notesRef.current.length === incoming.length) {
      // 同步自其他来源的力度/微调（保持 uid 与选择）
      const byIndex = new Map(incoming.map((note) => [`${note.pitch}:${roundBeat(note.start)}:${roundBeat(note.dur)}`, note]))
      notesRef.current = notesRef.current.map((note) => {
        const match = byIndex.get(`${note.pitch}:${roundBeat(note.start)}:${roundBeat(note.dur)}`)
        return match ? { ...note, vel: match.vel } : note
      })
    }
    redraw()
  }, [pattern, project?.revision, layout, size.width, size.height, redraw])

  useEffect(() => {
    // 缩放变化：保证 scroll 合法并重绘
    getView()
    redraw()
  }, [zoom, getView, redraw])

  useEffect(() => {
    if (!editable) {
      gestureRef.current = null
      canvasRef.current?.style.setProperty('cursor', 'default')
    }
  }, [editable])

  /* ── 滚轮：横向平移 ────────────────────────────────────── */

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (event) => {
      const view = getView()
      if (view.maxStart <= 0) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!delta) return
      event.preventDefault()
      const step = (delta / 100) * Math.max(0.25, view.visibleBeats * 0.18)
      scrollRef.current = clamp(scrollRef.current + step, 0, view.maxStart)
      redraw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [getView, redraw])

  /* ── 播放帧：播放头 / 高亮 / 自动跟随 ──────────────────── */

  useFrame(engine, (e, now) => {
    paint(e ? e.isPlaying : undefined)
    if (!e?.isPlaying) return
    const view = getView()
    if (view.zoom <= 1) return
    const currentLayout = layoutRef.current
    if (!currentLayout) return
    const localBar = ((e.positionBar % currentLayout.patBars) + currentLayout.patBars) % currentLayout.patBars
    const localBeat = localBar * (currentLayout.totalBeats / currentLayout.patBars)
    const low = view.startBeat + view.visibleBeats * 0.08
    const high = view.startBeat + view.visibleBeats * 0.9
    if (localBeat < low || localBeat > high) {
      if (now - followAtRef.current < 220) return
      followAtRef.current = now
      scrollRef.current = clamp(localBeat - view.visibleBeats * 0.45, 0, view.maxStart)
      redraw()
    }
  })

  /* ── 指针几何 ──────────────────────────────────────────── */

  const pointOf = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    // 画布可能被 CSS transform / UI 缩放 / 高分屏缩放改变显示尺寸；
    // 布局按 CSS 逻辑尺寸（sizeRef）计算，指针必须换算回同一坐标系，
    // 否则点击位置与落点会出现成比例偏移。
    const layoutWidth = Math.max(1, Number(sizeRef.current.width) || rect.width || 1)
    const layoutHeight = Math.max(1, Number(sizeRef.current.height) || rect.height || 1)
    const scaleX = rect.width > 0 ? layoutWidth / rect.width : 1
    const scaleY = rect.height > 0 ? layoutHeight / rect.height : 1
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    }
  }

  const xToBeat = (x) => {
    const currentLayout = layoutRef.current
    const view = getView()
    if (!currentLayout) return view.startBeat
    return view.startBeat + ((x - currentLayout.keyW) / Math.max(1, currentLayout.gridW)) * view.visibleBeats
  }

  const updateCursor = (x, y) => {
    const canvas = canvasRef.current
    const currentLayout = layoutRef.current
    if (!canvas || !currentLayout) return
    if (x < currentLayout.keyW || y < RULER_H) {
      canvas.style.cursor = 'default'
      return
    }
    const hit = hitTestNotes(notesRef.current, currentLayout, getView(), x, y)
    if (!propsRef.current.editable) {
      canvas.style.cursor = hit ? 'pointer' : 'default'
      return
    }
    if (!hit) canvas.style.cursor = 'crosshair'
    else if (hit.edge) canvas.style.cursor = 'ew-resize'
    else canvas.style.cursor = 'grab'
  }

  const snapshotSelection = (mainUid) => {
    const selected = selectionRef.current
    const ids = selected.size ? selected : new Set([mainUid])
    const map = new Map()
    for (const note of notesRef.current) if (ids.has(note.uid)) map.set(note.uid, { ...note })
    return map
  }

  const notifyReadOnly = () => propsRef.current.onNotify?.('只读模式：宿主编辑接口尚未就绪', 'error')

  const onPointerDown = (event) => {
    if (event.button !== 0) return
    const currentLayout = layoutRef.current
    if (!currentLayout || !propsRef.current.pattern) return
    const { x, y } = pointOf(event)
    if (x < currentLayout.keyW || y < RULER_H) return
    const view = getView()
    const rowIndex = rowIndexAtY(currentLayout, y)
    if (rowIndex < 0) return
    const hit = hitTestNotes(notesRef.current, currentLayout, getView(), x, y)
    const isEditable = Boolean(propsRef.current.editable)
    const canvas = canvasRef.current

    if (hit) {
      const alreadySelected = selectionRef.current.has(hit.note.uid)
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        const next = new Set(selectionRef.current)
        if (next.has(hit.note.uid)) next.delete(hit.note.uid)
        else next.add(hit.note.uid)
        applySelection(next)
      } else if (!alreadySelected) {
        applySelection(new Set([hit.note.uid]))
      }
      if (!isEditable) return
      event.preventDefault()
      try { canvas?.setPointerCapture(event.pointerId) } catch { /* ignore */ }
      canvas.style.cursor = hit.edge ? 'ew-resize' : 'grabbing'
      gestureRef.current = {
        type: hit.edge ? 'resize' : 'move',
        pointerId: event.pointerId,
        startX: x,
        startY: y,
        mainUid: hit.note.uid,
        startPitch: currentLayout.rows[rowIndex].pitch,
        orig: snapshotSelection(hit.note.uid),
        dirty: false,
      }
      return
    }

    if (event.shiftKey) {
      event.preventDefault()
      try { canvas?.setPointerCapture(event.pointerId) } catch { /* ignore */ }
      gestureRef.current = {
        type: 'marquee',
        pointerId: event.pointerId,
        startX: x,
        startY: y,
        base: new Set(selectionRef.current),
        marquee: { x1: x, y1: y, x2: x, y2: y },
        dirty: false,
      }
      redraw()
      return
    }

    if (!isEditable) {
      applySelection(new Set())
      return
    }

    // 空白处画音符
    event.preventDefault()
    const step = snapRef.current
    const rawBeat = xToBeat(x)
    const noteStart = clamp(roundBeat(snapTo(rawBeat, step)), 0, Math.max(0, currentLayout.totalBeats - step))
    const duration = Math.min(Math.max(step, step * 2), currentLayout.totalBeats - noteStart)
    const note = {
      uid: nextUid(),
      pitch: currentLayout.rows[rowIndex].pitch,
      start: noteStart,
      dur: roundBeat(duration),
      vel: 0.8,
    }
    notesRef.current = [...notesRef.current, note]
    applySelection(new Set([note.uid]))
    setNoteCount(notesRef.current.length)
    try { canvas?.setPointerCapture(event.pointerId) } catch { /* ignore */ }
    canvas.style.cursor = 'crosshair'
    gestureRef.current = {
      type: 'draw',
      pointerId: event.pointerId,
      mainUid: note.uid,
      startBeat: note.start,
      step,
      dirty: true,
    }
    redraw()
  }

  const onPointerMove = (event) => {
    const currentLayout = layoutRef.current
    if (!currentLayout) return
    const { x, y } = pointOf(event)
    const gesture = gestureRef.current
    if (!gesture) {
      updateCursor(x, y)
      return
    }
    const view = getView()
    const step = snapRef.current

    if (gesture.type === 'marquee') {
      gesture.marquee = {
        x1: Math.min(gesture.startX, x),
        y1: Math.min(gesture.startY, y),
        x2: Math.max(gesture.startX, x),
        y2: Math.max(gesture.startY, y),
      }
      redraw()
      return
    }

    if (gesture.type === 'draw') {
      const raw = xToBeat(x)
      const dur = clamp(roundBeat(snapTo(raw - gesture.startBeat, step)), step, currentLayout.totalBeats - gesture.startBeat)
      notesRef.current = notesRef.current.map((note) => (note.uid === gesture.mainUid ? { ...note, dur } : note))
      gesture.dirty = true
      redraw()
      return
    }

    const deltaBeats = ((x - gesture.startX) / Math.max(1, currentLayout.gridW)) * view.visibleBeats
    const currentPitch = (() => {
      const rowIndex = rowIndexAtY(currentLayout, y)
      return rowIndex >= 0 ? currentLayout.rows[rowIndex].pitch : gesture.startPitch
    })()
    const deltaPitch = currentPitch - gesture.startPitch

    if (gesture.type === 'move') {
      const mainOriginal = gesture.orig.get(gesture.mainUid)
      if (!mainOriginal) return
      const snappedStart = clamp(
        roundBeat(snapTo(mainOriginal.start + deltaBeats, step)),
        0,
        Math.max(0, currentLayout.totalBeats - mainOriginal.dur),
      )
      const deltaStart = snappedStart - mainOriginal.start
      notesRef.current = notesRef.current.map((note) => {
        const original = gesture.orig.get(note.uid)
        if (!original) return note
        let pitch = clamp(original.pitch + deltaPitch, 0, 127)
        if (currentLayout.kind === 'drum') pitch = nearestDrumPitch(pitch)
        const start = clamp(roundBeat(original.start + deltaStart), 0, Math.max(0, currentLayout.totalBeats - original.dur))
        return { ...note, pitch, start }
      })
      if (deltaStart !== 0 || deltaPitch !== 0) gesture.dirty = true
      redraw()
      return
    }

    if (gesture.type === 'resize') {
      const mainOriginal = gesture.orig.get(gesture.mainUid)
      if (!mainOriginal) return
      const snappedDur = clamp(
        roundBeat(snapTo(mainOriginal.dur + deltaBeats, step)),
        step,
        Math.max(step, currentLayout.totalBeats - mainOriginal.start),
      )
      const deltaDur = snappedDur - mainOriginal.dur
      notesRef.current = notesRef.current.map((note) => {
        const original = gesture.orig.get(note.uid)
        if (!original) return note
        const dur = clamp(roundBeat(original.dur + deltaDur), step, Math.max(step, currentLayout.totalBeats - original.start))
        return { ...note, dur }
      })
      if (deltaDur !== 0) gesture.dirty = true
      redraw()
    }
  }

  const onPointerUp = (event) => {
    const gesture = gestureRef.current
    const canvas = canvasRef.current
    if (!gesture) return
    try { canvas?.releasePointerCapture?.(event.pointerId) } catch { /* ignore */ }
    gestureRef.current = null
    if (gesture.type === 'marquee') {
      const currentLayout = layoutRef.current
      const view = getView()
      const marquee = gesture.marquee
      const picked = new Set(gesture.base)
      if (marquee && currentLayout && (marquee.x2 - marquee.x1 > 3 || marquee.y2 - marquee.y1 > 3)) {
        for (const note of notesRef.current) {
          const geometry = noteGeometry(currentLayout, view, note)
          if (!geometry) continue
          if (geometry.x + geometry.w >= marquee.x1 && geometry.x <= marquee.x2 && geometry.y + geometry.h >= marquee.y1 && geometry.y <= marquee.y2) {
            picked.add(note.uid)
          }
        }
      }
      applySelection(picked)
      return
    }
    if (gesture.dirty) {
      const label = gesture.type === 'draw' ? '画音符' : gesture.type === 'move' ? '移动音符' : '调整时值'
      commit(label)
    }
    setNoteCount(notesRef.current.length)
    redraw()
  }

  const onPointerLeave = () => {
    if (!gestureRef.current && canvasRef.current) canvasRef.current.style.cursor = 'default'
  }

  /* ── 编辑操作 ──────────────────────────────────────────── */

  const deleteSelected = useCallback(() => {
    if (!propsRef.current.editable) { notifyReadOnly(); return }
    const selected = selectionRef.current
    if (!selected.size) return
    notesRef.current = notesRef.current.filter((note) => !selected.has(note.uid))
    applySelection(new Set())
    setNoteCount(notesRef.current.length)
    commit('删除音符')
  }, [applySelection, commit])

  const selectAll = useCallback(() => {
    applySelection(new Set(notesRef.current.map((note) => note.uid)))
  }, [applySelection])

  const clearSelection = useCallback(() => applySelection(new Set()), [applySelection])

  const copySelected = useCallback(() => {
    const selected = selectionRef.current
    if (!selected.size) {
      propsRef.current.onNotify?.('先框选或点击选中音符', 'info')
      return
    }
    const notes = notesRef.current.filter((note) => selected.has(note.uid)).map((note) => ({ ...note }))
    const anchorStart = Math.min(...notes.map((note) => note.start))
    clipboardRef.current = { notes, anchorStart }
    propsRef.current.onNotify?.(`已复制 ${notes.length} 个音符`, 'info')
  }, [])

  const pasteNotes = useCallback(() => {
    if (!propsRef.current.editable) { notifyReadOnly(); return }
    const clip = clipboardRef.current
    const currentLayout = layoutRef.current
    if (!clip || !clip.notes.length || !currentLayout) {
      propsRef.current.onNotify?.('剪贴板为空', 'info')
      return
    }
    const step = snapRef.current
    const eng = engineRef.current
    const positionBar = eng ? eng.positionBar : (Number(projectRef.current?.transport?.playheadBar) || 0)
    const localBar = ((positionBar % currentLayout.patBars) + currentLayout.patBars) % currentLayout.patBars
    const localBeat = localBar * (currentLayout.totalBeats / currentLayout.patBars)
    const targetStart = clamp(roundBeat(snapTo(localBeat, step)), 0, Math.max(0, currentLayout.totalBeats - step))
    const offset = targetStart - clip.anchorStart
    const pasted = clip.notes.map((note) => ({
      uid: nextUid(),
      pitch: clamp(note.pitch, 0, 127),
      start: clamp(roundBeat(note.start + offset), 0, Math.max(0, currentLayout.totalBeats - 0.02)),
      dur: Math.max(0.02, Math.min(note.dur, currentLayout.totalBeats)),
      vel: note.vel,
    }))
    notesRef.current = [...notesRef.current, ...pasted]
    applySelection(new Set(pasted.map((note) => note.uid)))
    setNoteCount(notesRef.current.length)
    commit('粘贴音符')
    propsRef.current.onNotify?.(`已粘贴 ${pasted.length} 个音符`, 'success')
  }, [applySelection, commit])

  const quantize = useCallback(() => {
    if (!propsRef.current.editable) { notifyReadOnly(); return }
    const currentLayout = layoutRef.current
    if (!currentLayout) return
    const step = snapRef.current
    const selected = selectionRef.current
    const targets = selected.size ? notesRef.current.filter((note) => selected.has(note.uid)) : notesRef.current
    if (!targets.length) return
    const targetIds = new Set(targets.map((note) => note.uid))
    let changed = false
    notesRef.current = notesRef.current.map((note) => {
      if (!targetIds.has(note.uid)) return note
      const start = clamp(roundBeat(snapTo(note.start, step)), 0, Math.max(0, currentLayout.totalBeats - step))
      const dur = clamp(roundBeat(snapTo(note.dur, step)), step, Math.max(step, currentLayout.totalBeats - start))
      if (Math.abs(start - note.start) > 1e-6 || Math.abs(dur - note.dur) > 1e-6) changed = true
      return { ...note, start, dur }
    })
    if (!changed) {
      propsRef.current.onNotify?.('所选音符已在网格上', 'info')
      return
    }
    redraw()
    commit('量化音符')
  }, [commit, redraw])

  /* ── 编辑器命令（菜单栏 Edit 菜单）/ 快捷键 ─────────────── */

  const handlersRef = useRef({})
  handlersRef.current = { delete: deleteSelected, copy: copySelected, paste: pasteNotes, selectAll, quantize, clear: clearSelection }

  useEffect(() => {
    const seq = editorCommand?.seq
    if (!seq) return
    const handlers = handlersRef.current
    const type = editorCommand.type
    if (type === 'copy') handlers.copy()
    else if (type === 'paste') handlers.paste()
    else if (type === 'delete') handlers.delete()
    else if (type === 'selectAll') handlers.selectAll()
    else if (type === 'quantize') handlers.quantize()
  }, [editorCommand])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      if (isTypingTarget(event.target)) return
      if (!propsRef.current.keyboardEnabled) return
      const meta = event.ctrlKey || event.metaKey
      const key = String(event.key || '').toLowerCase()
      const throttleKey = meta ? `meta:${key}` : key
      if (throttleKeydown(keyThrottleRef, throttleKey, 200)) return
      const handlers = handlersRef.current
      if (meta) {
        if (key === 'c') { event.preventDefault(); handlers.copy() }
        else if (key === 'v') { event.preventDefault(); handlers.paste() }
        else if (key === 'a') { event.preventDefault(); handlers.selectAll() }
        return
      }
      if (event.altKey) return
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); handlers.delete() }
      else if (key === 'q') { event.preventDefault(); handlers.quantize() }
      else if (event.key === 'Escape') handlers.clear()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /* ── 缩放 ──────────────────────────────────────────────── */

  const requestZoom = (direction) => {
    const current = clamp(Number(propsRef.current.zoom) || 1, 1, 8)
    let index = ZOOM_LEVELS.indexOf(current)
    if (index < 0) index = 0
    const nextIndex = clamp(index + direction, 0, ZOOM_LEVELS.length - 1)
    const next = ZOOM_LEVELS[nextIndex]
    if (next !== current) onZoomChange?.(next)
  }

  /* ── E2E 只读钩子（无头 CDP 验证用，不影响交互/性能） ──── */

  const e2eRef = useRef(null)
  e2eRef.current = {
    gridPoint: (beat, pitch) => {
      const currentLayout = layoutRef.current
      const currentView = getView()
      if (!currentLayout) return null
      const row = currentLayout.pitchIndex.get(Number(pitch))
      if (row === undefined) return null
      return {
        x: currentLayout.keyW + ((Number(beat) - currentView.startBeat) / currentView.visibleBeats) * currentLayout.gridW,
        y: currentLayout.top + row * currentLayout.rowH + currentLayout.rowH / 2,
      }
    },
    noteRect: (note) => {
      const currentLayout = layoutRef.current
      if (!currentLayout || !note) return null
      const geometry = noteGeometry(currentLayout, getView(), {
        pitch: Number(note.pitch) || 0,
        start: Number(note.start) || 0,
        dur: Math.max(0.02, Number(note.dur) || 0.25),
      })
      return geometry ? { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h } : null
    },
    notes: () => toPlainNotes(notesRef.current),
  }

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!window.__AIMS_STANDALONE__ && !window.__AIMS_E2E_FORCE__) return undefined
    const api = {
      gridPoint: (beat, pitch) => e2eRef.current?.gridPoint(beat, pitch) ?? null,
      noteRect: (note) => e2eRef.current?.noteRect(note) ?? null,
      notes: () => e2eRef.current?.notes() ?? [],
    }
    // 合并而不是覆盖：App 的 importAudioBase64 等钩子必须保留（P3b）
    window.__AIMS_E2E__ = { ...(window.__AIMS_E2E__ ?? {}), ...api }
    return () => {
      const current = window.__AIMS_E2E__
      if (!current) return
      for (const key of Object.keys(api)) {
        if (key in current) delete current[key]
      }
      if (Object.keys(current).length === 0) {
        try { delete window.__AIMS_E2E__ } catch (err) { window.__AIMS_E2E__ = undefined }
      }
    }
  }, [])

  /* ── 派生展示数据 ──────────────────────────────────────── */

  const patterns = project?.patterns ?? []
  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])
  const patternOwners = useMemo(() => {
    const owners = new Map()
    for (const clip of project?.clips ?? []) {
      if (!owners.has(clip.patternId)) owners.set(clip.patternId, [])
      owners.get(clip.patternId).push(clip.trackId)
    }
    return owners
  }, [project])

  const scaleLabel = findScale(project?.scale)?.label ?? ''
  const instrument = track
    ? track.kind === 'drum'
      ? findDrumKit(track.instrument?.kit)?.name
      : findSynthPreset(track.instrument?.preset)?.name
    : ''
  const isDrum = track?.kind === 'drum'
  const isAudioTrack = track?.kind === 'audio'
  const view = getView()
  const snapLabel = SNAP_OPTIONS[snapIndex]?.key ?? '1/16'
  const viewStartBar = Math.floor(view.startBeat / (project?.timeSignature?.[0] ?? 4)) + 1
  const viewEndBar = Math.min(
    pattern?.lengthBars ?? 1,
    Math.ceil((view.startBeat + view.visibleBeats) / (project?.timeSignature?.[0] ?? 4)),
  )

  /* P3b：音频轨没有音符，给一个明确的引导页而不是空钢琴卷帘 */
  if (isAudioTrack) {
    const mediaCount = (project?.clips ?? []).filter((clip) => clip.trackId === track?.id && clip.mediaId).length
    return (
      <div className="aims-pianoroll aims-pianoroll--audio" data-testid="pianoroll-audio-hint">
        <div className="aims-pr-audio-hint">
          <div className="aims-pr-audio-icon"><IconWave size={30} /></div>
          <h2 className="aims-pr-audio-title">音频轨无音符</h2>
          <p className="aims-pr-audio-text">音频轨无音符，请在播放列表编排音频片段</p>
          <div className="aims-pr-audio-meta">
            <span className="aims-pr-audio-dot" style={{ background: track?.color }} />
            <span>{track?.name ?? '音频轨'}</span>
            <span className="aims-pr-meta-sep">·</span>
            <span>{mediaCount} 个音频片段</span>
            <span className="aims-pr-meta-sep">·</span>
            <span>可拖动/裁剪片段，双击不打开钢琴卷帘</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="aims-pianoroll">
      <div className="aims-pr-head">
        <div className="aims-pr-headline">
          <span className="aims-pr-eyebrow">PIANO ROLL · {isDrum ? '鼓件视图' : '音高视图'}</span>
          <div className="aims-pr-title-row">
            <h2 className="aims-pr-title" title={pattern?.name}>{pattern?.name ?? '未选择 Pattern'}</h2>
            <span className="aims-pr-badge">{noteCount} 个音符</span>
            {selCount ? <span className="aims-pr-badge aims-pr-badge--sel">已选 {selCount}</span> : null}
            {editable
              ? <span className="aims-pr-editable">可编辑 · 网格 {snapLabel}</span>
              : <span className="aims-pr-readonly">只读 · 宿主编辑接口未就绪</span>}
          </div>
          <div className="aims-pr-meta">
            <span className="aims-pr-meta-item" style={{ color: track?.color }}>
              <span className="aims-pr-meta-dot" style={{ background: track?.color }} />
              {track?.name ?? '—'}
            </span>
            <span className="aims-pr-meta-sep">·</span>
            <span className="aims-pr-meta-item">{pattern?.lengthBars ?? 0} 小节</span>
            <span className="aims-pr-meta-sep">·</span>
            <span className="aims-pr-meta-item">{instrument ?? (isDrum ? '鼓机' : '合成器')}</span>
            <span className="aims-pr-meta-sep">·</span>
            <span className="aims-pr-meta-item">{project?.key ?? '—'} {scaleLabel}</span>
          </div>
        </div>
        <div className="aims-pr-patterns" role="tablist" aria-label="Pattern 列表">
          {patterns.length === 0 ? (
            <span className="aims-pr-patterns-empty">暂无 Pattern</span>
          ) : (
            patterns.map((pat) => {
              const owners = patternOwners.get(pat.id) ?? []
              const owner = trackById.get(owners[0])
              return (
                <button
                  key={pat.id}
                  type="button"
                  role="tab"
                  aria-selected={pat.id === pattern?.id}
                  className={`aims-pr-pattern ${pat.id === pattern?.id ? 'is-active' : ''} ${pat.notes.length === 0 ? 'is-empty' : ''}`}
                  style={{ '--pattern-color': owner?.color ?? palette.muted }}
                  title={`${pat.name} · ${pat.lengthBars} 小节 · ${pat.notes.length} 音符${owner ? ` · ${owner.name}` : ''}`}
                  aria-label={`${pat.name}，${pat.notes.length} 个音符`}
                  onClick={() => {
                    onSelectPattern?.(pat.id)
                    if (owner && owner.id !== selectedTrackId) onSelectTrack?.(owner.id)
                  }}
                >
                  <span className="aims-pr-pattern-dot" />
                  {pat.name}
                </button>
              )
            })
          )}
        </div>

        <div className="aims-pr-toolbar">
          <div className="aims-pr-theory-wrap" ref={theoryRef}>
            <button
              type="button"
              className={`aims-pr-tool aims-pr-theory-toggle ${theoryOpen ? 'is-open' : ''}`}
              data-testid="theory-open"
              aria-expanded={theoryOpen}
              aria-haspopup="dialog"
              title="乐理：和弦 / 进行 / 琶音 / Groove"
              onClick={() => setTheoryOpen((open) => !open)}
            >
              <span className="aims-pr-tool-glyph">♪</span>乐理
            </button>
            {theoryOpen ? (
              <div
                className="aims-pr-theory-popover"
                data-testid="theory-popover"
                role="dialog"
                aria-label="乐理工具"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <header className="aims-pr-theory-head">
                  <span className="aims-pr-theory-title">乐理工具</span>
                  <span className="aims-pr-theory-key">{project?.key ?? 'C'} · {theoryScaleLabel}</span>
                  <button type="button" className="aims-pr-theory-close" aria-label="关闭乐理工具" onClick={() => setTheoryOpen(false)}>×</button>
                </header>

                <div className="aims-pr-theory-section">
                  <span className="aims-pr-theory-section-title">Diatonic 和弦（点击插入）</span>
                  <div className="aims-pr-theory-chords">
                    {diatonicChords.map((chord) => (
                      <button
                        key={`${chord.roman}-${chord.name}`}
                        type="button"
                        className={`aims-pr-theory-chord ${chord.roman === theoryChordRoman ? 'is-active' : ''}`}
                        data-testid={`theory-chord-${chord.roman}`}
                        title={`${chord.roman} · ${chord.name}（点击插入当前 Pattern）`}
                        aria-pressed={chord.roman === theoryChordRoman}
                        onClick={() => insertTheoryChord(chord)}
                      >
                        <b>{chord.roman}</b>
                        <span>{chord.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="aims-pr-theory-section">
                  <span className="aims-pr-theory-section-title">常见进行</span>
                  <div className="aims-pr-theory-progressions">
                    {THEORY_PROGRESSIONS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="aims-pr-theory-progression"
                        data-testid={`theory-progression-${item.id}`}
                        title={`插入 ${item.label}`}
                        onClick={() => insertTheoryProgression(item)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="aims-pr-theory-section">
                  <span className="aims-pr-theory-section-title">琶音器 <small>当前和弦：{theorySelectedChord?.roman ?? 'I'}</small></span>
                  <div className="aims-pr-theory-row">
                    <select
                      className="aims-pr-theory-select"
                      data-testid="arp-pattern"
                      aria-label="琶音模式"
                      value={arpPattern}
                      onChange={(event) => setArpPattern(event.target.value)}
                    >
                      <option value="up">上行 up</option>
                      <option value="down">下行 down</option>
                      <option value="updown">上下 updown</option>
                      <option value="random">随机 random</option>
                    </select>
                    <select
                      className="aims-pr-theory-select"
                      data-testid="arp-rate"
                      aria-label="琶音速率"
                      value={arpRate}
                      onChange={(event) => setArpRate(event.target.value)}
                    >
                      <option value="0.5">1/8</option>
                      <option value="0.25">1/16</option>
                    </select>
                    <select
                      className="aims-pr-theory-select"
                      data-testid="arp-octaves"
                      aria-label="琶音八度"
                      value={arpOctaves}
                      onChange={(event) => setArpOctaves(event.target.value)}
                    >
                      <option value="1">1 八度</option>
                      <option value="2">2 八度</option>
                    </select>
                    <button type="button" className="aims-pr-theory-action" data-testid="arp-generate" onClick={generateTheoryArp}>生成琶音</button>
                  </div>
                </div>

                <div className="aims-pr-theory-section">
                  <span className="aims-pr-theory-section-title">Groove / 律动</span>
                  <div className="aims-pr-theory-row">
                    <select
                      className="aims-pr-theory-select"
                      data-testid="groove-template"
                      aria-label="Groove 模板"
                      value={grooveTemplate}
                      onChange={(event) => setGrooveTemplate(event.target.value)}
                    >
                      <option value="straight">straight</option>
                      <option value="swing55">swing 55%</option>
                      <option value="swing60">swing 60%</option>
                      <option value="shuffle">shuffle</option>
                      <option value="mpc54">MPC 54%</option>
                      <option value="mpc58">MPC 58%</option>
                    </select>
                    <label className="aims-pr-theory-strength">
                      <span>强度</span>
                      <input
                        type="range"
                        data-testid="groove-strength"
                        min="0"
                        max="1"
                        step="0.05"
                        value={grooveStrength}
                        onChange={(event) => setGrooveStrength(event.target.value)}
                      />
                      <b>{Math.round(Number(grooveStrength) * 100)}%</b>
                    </label>
                    <button type="button" className="aims-pr-theory-action" data-testid="groove-apply" onClick={applyTheoryGroove}>应用 Groove</button>
                  </div>
                </div>
                <footer className="aims-pr-theory-foot">写操作都通过一次 /edit 撤销 · 插入到当前 Pattern 的播放头位置</footer>
              </div>
            ) : null}
          </div>
          <div className="aims-pr-tools-group" title="编辑吸附网格">
            <span className="aims-pr-tools-label">吸附</span>
            {SNAP_OPTIONS.map((option, index) => (
              <button
                key={option.key}
                type="button"
                className={`aims-pr-tool-chip ${snapIndex === index ? 'is-active' : ''}`}
                aria-pressed={snapIndex === index}
                aria-label={`吸附到 ${option.key} 音符`}
                onClick={() => setSnapIndex(index)}
              >{option.key}</button>
            ))}
          </div>
          <div className="aims-pr-tools-group">
            <button type="button" className="aims-pr-tool" onClick={quantize} title="量化到当前网格（Q）" aria-label="量化音符">
              <span className="aims-pr-tool-glyph">Q</span>量化
            </button>
            <button type="button" className="aims-pr-tool" onClick={copySelected} title="复制选中音符（Ctrl+C）" aria-label="复制音符">复制</button>
            <button type="button" className="aims-pr-tool" onClick={pasteNotes} title="在播放头处粘贴（Ctrl+V）" aria-label="粘贴音符">粘贴</button>
            <button type="button" className="aims-pr-tool" onClick={deleteSelected} title="删除选中音符（Delete）" aria-label="删除音符">删除</button>
            <button type="button" className="aims-pr-tool" onClick={selectAll} title="全选（Ctrl+A）" aria-label="全选音符">全选</button>
          </div>
          <div className="aims-pr-tools-group aims-pr-tools-right">
            <span className="aims-pr-tools-hint">
              {selCount ? `拖动移动 · 拖右边缘改时值` : '点击网格画音符 · Shift+拖动框选'}
            </span>
            <button type="button" className="aims-pr-zoom" onClick={() => requestZoom(-1)} disabled={view.zoom <= 1} title="缩小（Shift+H）" aria-label="缩小钢琴卷帘">
              <IconZoomOut size={14} />
            </button>
            <span className="aims-pr-zoom-val aims-mono" title="横轴缩放倍数">×{view.zoom}</span>
            <button type="button" className="aims-pr-zoom" onClick={() => requestZoom(1)} disabled={view.zoom >= 4} title="放大（H）" aria-label="放大钢琴卷帘">
              <IconZoomIn size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className="aims-pr-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="aims-pr-canvas"
          data-testid="piano-roll-canvas"
          data-px-per-beat={(layout.gridW / Math.max(1, view.visibleBeats)).toFixed(4)}
          data-row-height={layout.rowH.toFixed(4)}
          data-pad-left={layout.keyW}
          data-pad-top={layout.top.toFixed(4)}
          data-pitch-top={layout.rows[0]?.pitch ?? 0}
          data-pitch-rows={layout.rows.length}
          data-note-count={noteCount}
          data-editable={editable ? '1' : '0'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          aria-label={`钢琴卷帘，${isDrum ? '鼓件视图' : '音高视图'}，${noteCount} 个音符${editable ? '，可编辑' : '，只读'}`}
          role="application"
          tabIndex={0}
        />
        {pattern && noteCount === 0 ? (
          <div className="aims-pr-canvas-empty">
            <span>{editable ? '点击网格画下第一个音符' : '这个 Pattern 还没有音符'}</span>
            <small>{editable ? '拖动决定时值 · Delete 删除 · Q 量化 · Shift+拖动框选' : '对 AI 说「给这个 Pattern 写一段旋律」即可填入'}</small>
          </div>
        ) : null}
        <div className="aims-pr-canvas-corner" title={editable ? '编辑已启用：松手后一次性写回宿主' : '只读展示'}>
          <span className={`aims-pr-canvas-corner-dot ${editable ? 'is-live' : ''}`} />
          {isDrum ? `${DRUM_PIECES.length} 鼓件行` : '12 平均律'} · {fmtPosition(view.startBeat, project?.timeSignature?.[0] ?? 4)}
        </div>
      </div>

      <footer className="aims-pr-foot">
        <span className="aims-pr-foot-item"><span className="aims-pr-foot-swatch" style={{ background: track?.color ?? palette.coral }} />音符颜色跟随轨道</span>
        <span className="aims-pr-foot-item">点击画音符 · 拖动移动 · 拖右边缘改时值 · Shift 框选</span>
        <span className="aims-pr-foot-item">Delete 删除 · Ctrl+C/V 复制粘贴 · Q 量化 · H 缩放</span>
        <span className="aims-pr-foot-item aims-pr-foot-meta">
          {pad(pattern?.lengthBars ?? 0, 2)} 小节 · 视窗 {viewStartBar}–{viewEndBar} · {snapLabel} 栅格
        </span>
      </footer>
    </div>
  )
})

export default PianoRoll
