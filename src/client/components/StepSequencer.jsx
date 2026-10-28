/**
 * 左栏步进音序器（P2c）。
 *
 * - 选中鼓组轨道时挂在通道机架轨道列表下方；11 鼓件 × (lengthBars×16) 步。
 * - 左键点格子开关、按住拖动连续刷（按下第一格决定加/删）、右键删除/右键拖动删除刷。
 * - 拖动中只改本地面板；pointerup / pointercancel 时一次性 onCommitNotes(patternId, notes)。
 * - 播放时按 engine.positionBar 取模 pattern 长度，高亮播放头列。
 * - 数据映射：beat = step * (barBeats/16)；pitch 用 DRUM_PIECES；dur = stepBeats；vel = 0.85。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DRUM_PIECES } from '../../shared/catalog.js'
import {
  IconChevronDown, IconPiano, IconSteps, clamp, useFrame,
} from './ui.jsx'
import { tint } from '../theme.js'

const LABEL_WIDTH = 54
const CELL_STEP = 16
const MAX_STEPS = 64
const VELOCITY = 0.85

const beatOfStep = (step, stepBeats) => Math.round(step * stepBeats * 10000) / 10000

const sameStart = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01

function addNoteTo(notes, piece, step, stepBeats) {
  const beat = beatOfStep(step, stepBeats)
  if (notes.some((note) => Number(note.pitch) === piece.pitch && sameStart(note.start, beat))) return notes
  return [...notes, { pitch: piece.pitch, start: beat, dur: stepBeats, vel: VELOCITY }]
    .sort((a, b) => (Number(a.start) - Number(b.start)) || (Number(a.pitch) - Number(b.pitch)))
}

function removeNoteFrom(notes, piece, step, stepBeats) {
  const beat = beatOfStep(step, stepBeats)
  return notes.filter((note) => !(Number(note.pitch) === piece.pitch && sameStart(note.start, beat)))
}

export const StepSequencer = memo(function StepSequencer({
  project, track, patterns = [], patternId = null, engine, playing = false,
  editable = true, collapsed = false, onToggleCollapse, onSelectPattern,
  onCommitNotes, onNotify,
}) {
  const barBeats = Number(project?.timeSignature?.[0]) || 4
  const stepBeats = barBeats / 16
  const validPattern = useMemo(
    () => (patterns ?? []).find((item) => item.id === patternId) ?? null,
    [patterns, patternId],
  )
  const currentPattern = validPattern ?? (patterns ?? [])[0] ?? null
  const patternSteps = currentPattern
    ? clamp(Math.round((Number(currentPattern.lengthBars) || 1) * 16), 16, MAX_STEPS)
    : 0
  const patternBeats = currentPattern
    ? Math.max(barBeats, (Number(currentPattern.lengthBars) || 1) * barBeats)
    : barBeats

  const [draftNotes, setDraftNotes] = useState(null)
  const draftRef = useRef(null)
  const gestureRef = useRef(null)
  const lastGestureAtRef = useRef(0)
  const bodyRef = useRef(null)
  const lastPlayingStepRef = useRef(-2)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const engineRef = useRef(engine)
  engineRef.current = engine

  const sourceNotes = draftNotes ?? currentPattern?.notes ?? []
  const notesRef = useRef(sourceNotes)
  notesRef.current = sourceNotes

  const onSet = useMemo(() => {
    const set = new Set()
    for (const note of sourceNotes) {
      const piece = DRUM_PIECES.find((item) => item.pitch === Number(note.pitch))
      if (!piece) continue
      const step = Math.round(Number(note.start) / stepBeats)
      if (step < 0 || step >= patternSteps) continue
      if (Math.abs(Number(note.start) - beatOfStep(step, stepBeats)) < 0.01) set.add(`${piece.id}:${step}`)
    }
    return set
  }, [sourceNotes, stepBeats, patternSteps])

  // 切换 pattern / 宿主 revision 回来后丢弃本地草稿
  useEffect(() => {
    if (gestureRef.current) return
    draftRef.current = null
    setDraftNotes(null)
  }, [currentPattern?.id, project?.revision])

  const commitNotes = useCallback((nextNotes, label) => {
    if (!currentPattern) return
    if (!editable) {
      onNotify?.('只读模式：宿主编辑接口尚未就绪', 'error')
      return
    }
    onCommitNotes?.(currentPattern.id, nextNotes, label || '步进音序器')
  }, [currentPattern, editable, onCommitNotes, onNotify])

  const setDraft = useCallback((next) => {
    draftRef.current = next
    setDraftNotes(next)
  }, [])

  const findCell = (target) => {
    if (!(target instanceof Element)) return null
    const cell = target.closest('[data-testid="step-cell"]')
    if (!cell) return null
    const piece = DRUM_PIECES.find((item) => item.id === cell.dataset.piece)
    if (!piece) return null
    const step = Number(cell.dataset.step)
    if (!Number.isFinite(step)) return null
    return { cell, piece, step }
  }

  const toggleCell = useCallback((piece, step, mode) => {
    const base = draftRef.current ?? (currentPattern?.notes ?? [])
    const next = mode === 'remove'
      ? removeNoteFrom(base, piece, step, stepBeats)
      : addNoteTo(base, piece, step, stepBeats)
    setDraft(next)
    return next
  }, [currentPattern, setDraft, stepBeats])

  const onPointerDown = (event) => {
    if (!currentPattern || collapsed) return
    if (event.button !== 0 && event.button !== 2) return
    const hit = findCell(event.target)
    if (!hit) return
    event.preventDefault()
    if (!editable) {
      onNotify?.('只读模式：宿主编辑接口尚未就绪', 'error')
      return
    }
    const mode = event.button === 2 ? 'remove' : (hit.cell.dataset.on === 'true' ? 'remove' : 'add')
    const base = [...(currentPattern.notes ?? [])]
    const next = mode === 'remove'
      ? removeNoteFrom(base, hit.piece, hit.step, stepBeats)
      : addNoteTo(base, hit.piece, hit.step, stepBeats)
    setDraft(next)
    gestureRef.current = {
      mode,
      notes: next,
      visited: new Set([`${hit.piece.id}:${hit.step}`]),
      pointerId: event.pointerId,
      dirty: true,
    }
    try { bodyRef.current?.setPointerCapture?.(event.pointerId) } catch (err) { /* ignore */ }
  }

  const onPointerMove = (event) => {
    const gesture = gestureRef.current
    if (!gesture) return
    const target = document.elementFromPoint(event.clientX, event.clientY)
    const hit = findCell(target)
    if (!hit) return
    const key = `${hit.piece.id}:${hit.step}`
    if (gesture.visited.has(key)) return
    gesture.visited.add(key)
    const noteStep = hit.step
    gesture.notes = gesture.mode === 'remove'
      ? removeNoteFrom(gesture.notes, hit.piece, noteStep, stepBeats)
      : addNoteTo(gesture.notes, hit.piece, noteStep, stepBeats)
    gesture.dirty = true
    setDraft(gesture.notes)
  }

  const finishGesture = (event) => {
    const gesture = gestureRef.current
    if (!gesture) return
    gestureRef.current = null
    try { bodyRef.current?.releasePointerCapture?.(event?.pointerId) } catch (err) { /* ignore */ }
    lastGestureAtRef.current = Date.now()
    const finalNotes = gesture.notes
    setDraft(null)
    if (gesture.dirty) commitNotes(finalNotes, '步进音序器')
  }

  const onPointerUp = (event) => finishGesture(event)
  const onPointerCancel = (event) => finishGesture(event)

  // 兼容 programmatic .click()（无 pointer 事件）：真实点击时上方手势已处理，用时间窗避免双触发
  const onClick = (event) => {
    if (!currentPattern || collapsed) return
    if (Date.now() - lastGestureAtRef.current < 350) return
    const hit = findCell(event.target)
    if (!hit) return
    if (!editable) {
      onNotify?.('只读模式：宿主编辑接口尚未就绪', 'error')
      return
    }
    const mode = hit.cell.dataset.on === 'true' ? 'remove' : 'add'
    const next = toggleCell(hit.piece, hit.step, mode)
    setDraft(null)
    commitNotes(next, '步进音序器')
  }

  const onContextMenu = (event) => {
    event.preventDefault()
    if (!currentPattern || collapsed) return
    if (gestureRef.current || Date.now() - lastGestureAtRef.current < 350) return
    const hit = findCell(event.target)
    if (!hit || !editable) return
    const next = removeNoteFrom(notesRef.current, hit.piece, hit.step, stepBeats)
    if (next.length === notesRef.current.length) return
    setDraft(null)
    commitNotes(next, '步进音序器')
  }

  // 播放头列高亮（直接改 DOM class / data-playing，避免每帧 React 渲染）
  const propsRef = useRef({})
  propsRef.current = { barBeats, stepBeats, patternBeats, patternSteps, playing }
  useFrame(engine, (e, now, frame) => {
    const body = bodyRef.current
    if (!body || frame % 3 !== 0) return
    const info = propsRef.current
    let step = -1
    const isPlaying = Boolean(e?.isPlaying ?? playingRef.current)
    if (isPlaying && info.patternSteps > 0) {
      const eng = engineRef.current
      const bar = e ? Number(e.positionBar) || 0 : (Number(eng?.positionBar) || 0)
      const beat = Math.max(0, bar * info.barBeats)
      const mod = ((beat % info.patternBeats) + info.patternBeats) % info.patternBeats
      const computed = Math.floor(mod / info.stepBeats)
      if (computed >= 0 && computed < info.patternSteps) step = computed
    }
    if (step === lastPlayingStepRef.current) return
    lastPlayingStepRef.current = step
    for (const cell of body.querySelectorAll('.aims-stepseq-cell.is-playing')) {
      cell.classList.remove('is-playing')
      cell.dataset.playing = 'false'
    }
    if (step >= 0) {
      for (const cell of body.querySelectorAll(`[data-step="${step}"]`)) {
        cell.classList.add('is-playing')
        cell.dataset.playing = 'true'
      }
    }
  })

  // 卸载时清掉列高亮（防止复用时残留）
  useEffect(() => () => {
    const body = bodyRef.current
    if (!body) return
    for (const cell of body.querySelectorAll('.aims-stepseq-cell.is-playing')) {
      cell.classList.remove('is-playing')
      cell.dataset.playing = 'false'
    }
  }, [])

  const handlePatternChange = (event) => {
    const next = event.target.value
    setDraft(null)
    if (next) onSelectPattern?.(next)
  }

  const hasPatterns = (patterns ?? []).length > 0
  const header = (
    <header className="aims-stepseq-head">
      <span className="aims-stepseq-title">
        <IconSteps size={11} className="aims-stepseq-title-icon" />
        步进音序器
      </span>
      {currentPattern ? (
        <span className="aims-stepseq-pattern">
          <select
            className="aims-stepseq-select"
            data-testid="stepseq-pattern"
            aria-label="选择步进音序器 pattern"
            value={currentPattern.id}
            onChange={handlePatternChange}
            title="选择要编辑的 pattern（工程内所有 pattern）"
          >
            {(patterns ?? []).map((pattern) => (
              <option key={pattern.id} value={pattern.id}>{pattern.name}</option>
            ))}
          </select>
          <IconChevronDown size={10} className="aims-stepseq-select-caret" />
        </span>
      ) : null}
      <span className="aims-stepseq-track" title={track?.name ?? ''}>{track?.name ?? '未选择轨道'}</span>
      <button
        type="button"
        className={`aims-stepseq-collapse ${collapsed ? 'is-collapsed' : ''}`}
        data-testid="stepseq-collapse"
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开步进音序器' : '折叠步进音序器'}
        title={collapsed ? '展开步进音序器' : '折叠步进音序器'}
        onClick={() => onToggleCollapse?.()}
      >
        <IconChevronDown size={12} />
      </button>
    </header>
  )

  if (collapsed) {
    return (
      <section className="aims-stepseq is-collapsed" data-testid="stepseq" data-collapsed="true" data-pattern-id={currentPattern?.id ?? ''} data-track-id={track?.id ?? ''}>
        {header}
      </section>
    )
  }

  if (!hasPatterns) {
    return (
      <section className="aims-stepseq" data-testid="stepseq" data-pattern-id="" data-track-id={track?.id ?? ''}>
        {header}
        <div className="aims-stepseq-hint" data-testid="stepseq-hint">
          <span className="aims-stepseq-hint-title">还没有 pattern</span>
          <span className="aims-stepseq-hint-sub">让 AI 或播放列表先创建一个 pattern，再回来点鼓型。</span>
        </div>
      </section>
    )
  }

  return (
    <section
      className="aims-stepseq"
      data-testid="stepseq"
      data-pattern-id={currentPattern?.id ?? ''}
      data-track-id={track?.id ?? ''}
      data-steps={patternSteps}
      data-bar-beats={barBeats}
      data-step-beats={stepBeats}
      data-editable={editable ? '1' : '0'}
    >
      {header}
      <div
        className="aims-stepseq-body"
        data-testid="stepseq-body"
        ref={bodyRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <div className="aims-stepseq-grid" style={{ width: LABEL_WIDTH + patternSteps * CELL_STEP }}>
          <div className="aims-stepseq-row aims-stepseq-row--ruler" aria-hidden="true">
            <span className="aims-stepseq-label aims-stepseq-label--ruler">BEAT</span>
            <div className="aims-stepseq-cells">
              {Array.from({ length: patternSteps }).map((_, step) => (
                <span
                  key={step}
                  className={`aims-stepseq-tick ${step % 16 === 0 ? 'is-bar' : ''} ${step % 4 === 0 ? 'is-beat' : ''}`}
                >
                  {step % 16 === 0 ? Math.floor(step / 16) + 1 : ''}
                </span>
              ))}
            </div>
          </div>
          {DRUM_PIECES.map((piece, rowIndex) => (
            <div className={`aims-stepseq-row ${rowIndex % 2 === 1 ? 'is-alt' : ''}`} key={piece.id} data-piece-row={piece.id}>
              <span className="aims-stepseq-label" title={`${piece.name} · ${piece.label} · MIDI ${piece.pitch}`}>
                {piece.label}
              </span>
              <div className="aims-stepseq-cells">
                {Array.from({ length: patternSteps }).map((_, step) => {
                  const on = onSet.has(`${piece.id}:${step}`)
                  return (
                    <button
                      key={step}
                      type="button"
                      className={`aims-stepseq-cell ${on ? 'is-on' : ''} ${step % 16 === 0 ? 'is-bar' : ''} ${step % 4 === 0 ? 'is-beat' : ''}`}
                      data-testid="step-cell"
                      data-piece={piece.id}
                      data-step={step}
                      data-on={on ? 'true' : 'false'}
                      data-beat={beatOfStep(step, stepBeats)}
                      data-pitch={piece.pitch}
                      data-playing="false"
                      aria-label={`${piece.label} 第 ${step + 1} 步${on ? '（已开）' : ''}`}
                      aria-pressed={on}
                      style={on ? { background: piece.color, borderColor: tint(piece.color, 0.42) } : undefined}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <footer className="aims-stepseq-foot">
        <span className="aims-stepseq-foot-item">
          {currentPattern?.name ?? '—'} · {Math.round(patternSteps / 16)} 小节 · {patternSteps} 步
        </span>
        <span className="aims-stepseq-foot-item aims-stepseq-foot-meta">
          {patternSteps >= MAX_STEPS ? '最多显示 4 小节 · ' : ''}拖动刷格子 · 右键删除
        </span>
      </footer>
    </section>
  )
})

/** 合成器 / 采样器轨道：提示去钢琴卷帘编辑。 */
export function StepSequencerHint({ track, canOpen = true, onOpenPattern, patternId }) {
  return (
    <section className="aims-stepseq-hint" data-testid="stepseq-hint" data-track-id={track?.id ?? ''}>
      <span className="aims-stepseq-hint-icon"><IconPiano size={15} /></span>
      <span className="aims-stepseq-hint-title">请在钢琴卷帘编辑</span>
      <span className="aims-stepseq-hint-sub">
        {track?.name ?? '当前轨道'} 是{(track?.kind === 'drum') ? '鼓组' : (track?.preset ? '合成器' : '乐器')}轨道，步进音序器只用于鼓件；旋律/和弦请打开钢琴卷帘。
      </span>
      <button
        type="button"
        className="aims-stepseq-hint-btn"
        data-testid="stepseq-open-pianoroll"
        disabled={!canOpen}
        onClick={() => onOpenPattern?.(patternId)}
        title="切换到钢琴卷帘并编辑该轨道的 pattern"
      >
        <IconPiano size={12} />
        打开钢琴卷帘
      </button>
    </section>
  )
}

export default StepSequencer
