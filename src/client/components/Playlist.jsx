/**
 * 中栏：播放列表（P1 — 可编辑编排时间线）。
 *
 * 交互：
 *  - 单击片段选中；双击打开钢琴卷帘
 *  - 拖动片段 ↔ 改 startBar，↕ 改所在轨道；拖右边缘改 lengthBars
 *  - Ctrl+D 复制片段、Delete 删除、右键菜单（复制/删除/移到轨道/打开钢琴卷帘）
 *  - 手势过程只改本地 clips，松手时一次性 onCommitClips(clips, label)
 *
 * 同步：宿主 project revision 变化后，若本地编排与宿主完全一致则保留本地对象（选择不丢），
 * 否则用宿主数据覆盖（AI 编排 / 撤销重做）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DRUM_PIECES, findDrumKit, findSynthPreset } from '../../shared/catalog.js'
import { metrics, alpha, tint, shade } from '../theme.js'
import { clamp, isTypingTarget, pad, roleLabel, Switch, throttleKeydown, useFrame } from './ui.jsx'

const HEADER_W = metrics.playlistHeaderWidth
const BAR_W = metrics.playlistBarWidth
const ROW_H = metrics.playlistRowHeight

let clipSeq = 1
const nextClipId = () => {
  clipSeq += 1
  return `ui_clip_${clipSeq}`
}

const clipKey = (clip) => {
  if (clip?.id) return clip.id
  const ref = clip?.mediaId ? `media:${clip.mediaId}` : `pattern:${clip?.patternId}`
  return `${clip?.trackId}|${ref}|${clip?.startBar}`
}

const roundOffset = (value) => Math.max(0, Math.round((Number(value) || 0) * 1000) / 1000)

function clipsEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x.trackId !== y.trackId) return false
    if ((x.patternId ?? null) !== (y.patternId ?? null)) return false
    if ((x.mediaId ?? null) !== (y.mediaId ?? null)) return false
    if (Number(x.startBar) !== Number(y.startBar) || Number(x.lengthBars) !== Number(y.lengthBars)) return false
    if ((Number(x.transpose) || 0) !== (Number(y.transpose) || 0)) return false
    if (Math.abs(roundOffset(x.offsetSeconds) - roundOffset(y.offsetSeconds)) > 0.0005) return false
    /* R2a/R2b：音频属性也要参与宿主/本地一致性比较 */
    if (x.mediaId) {
      if (Math.abs((Number(x.gainDb) || 0) - (Number(y.gainDb) || 0)) > 0.0005) return false
      if (Math.abs((Number(x.fadeInSeconds) || 0) - (Number(y.fadeInSeconds) || 0)) > 0.0005) return false
      if (Math.abs((Number(x.fadeOutSeconds) || 0) - (Number(y.fadeOutSeconds) || 0)) > 0.0005) return false
      if (Boolean(x.reverse) !== Boolean(y.reverse)) return false
      if (Math.abs((Number(x.stretchRatio) || 1) - (Number(y.stretchRatio) || 1)) > 0.0005) return false
      if (Math.abs((Number(x.semitones) || 0) - (Number(y.semitones) || 0)) > 0.0005) return false
      if ((x.takeGroup ?? null) !== (y.takeGroup ?? null)) return false
      if ((Number(x.takeIndex) || 0) !== (Number(y.takeIndex) || 0)) return false
      if ((x.takeActive !== false) !== (y.takeActive !== false)) return false
    }
  }
  return true
}

/** R2c take 字段：只有带合法 takeGroup 的 media clip 才保留 index/active。 */
function takeClipFields(clip) {
  if (!clip?.mediaId) return {}
  const group = typeof clip.takeGroup === 'string' ? clip.takeGroup.trim() : ''
  if (group === '') return {}
  const fields = { takeGroup: group }
  const index = Math.floor(Number(clip.takeIndex))
  if (Number.isInteger(index) && index >= 0) fields.takeIndex = index
  if (clip.takeActive === false) fields.takeActive = false
  return fields
}

/** R2a/R2b 音频 clip 属性：范围/精度规范化，0/false/1 省略。 */
function audioClipFields(clip) {
  if (!clip?.mediaId) return {}
  const fields = {}
  const gain = Math.round(clamp(Number(clip.gainDb) || 0, -24, 24) * 10) / 10
  if (gain !== 0) fields.gainDb = gain
  const fadeIn = Math.round(clamp(Number(clip.fadeInSeconds) || 0, 0, 10) * 1000) / 1000
  if (fadeIn > 0) fields.fadeInSeconds = fadeIn
  const fadeOut = Math.round(clamp(Number(clip.fadeOutSeconds) || 0, 0, 10) * 1000) / 1000
  if (fadeOut > 0) fields.fadeOutSeconds = fadeOut
  if (clip.reverse === true) fields.reverse = true
  const stretchRatio = Math.round(clamp(Number(clip.stretchRatio) || 1, 0.25, 4) * 1000) / 1000
  if (stretchRatio !== 1) fields.stretchRatio = stretchRatio
  const semitones = Math.round(clamp(Number(clip.semitones) || 0, -12, 12) * 10) / 10
  if (semitones !== 0) fields.semitones = semitones
  return fields
}

function normalizeClip(clip) {
  return {
    id: clip.id || nextClipId(),
    trackId: clip.trackId,
    ...(clip.mediaId
      ? { mediaId: clip.mediaId, offsetSeconds: roundOffset(clip.offsetSeconds), ...audioClipFields(clip), ...takeClipFields(clip) }
      : { patternId: clip.patternId }),
    startBar: Math.max(0, Math.round(Number(clip.startBar) || 0)),
    lengthBars: Math.max(1, Math.round(Number(clip.lengthBars) || 1)),
    transpose: Math.round(Number(clip.transpose) || 0),
  }
}

function plainClips(clips) {
  return clips.map((clip) => (
    clip.mediaId
      ? {
        id: clip.id,
        trackId: clip.trackId,
        mediaId: clip.mediaId,
        startBar: Math.round(clip.startBar),
        lengthBars: Math.round(clip.lengthBars),
        ...(roundOffset(clip.offsetSeconds) > 0 ? { offsetSeconds: roundOffset(clip.offsetSeconds) } : {}),
        ...audioClipFields(clip),
        ...takeClipFields(clip),
      }
      : {
        id: clip.id,
        trackId: clip.trackId,
        patternId: clip.patternId,
        startBar: Math.round(clip.startBar),
        lengthBars: Math.round(clip.lengthBars),
        transpose: Math.round(Number(clip.transpose) || 0),
      }
  ))
}

/** clip 内迷你音符/波形预览（每次编排 / pattern / media 变化时计算一次）。 */
function buildClipViews(project, barBeats) {
  const out = new Map()
  const patterns = new Map((project?.patterns ?? []).map((p) => [p.id, p]))
  const tracks = new Map((project?.tracks ?? []).map((t) => [t.id, t]))
  const media = new Map((project?.media ?? []).map((m) => [m.id, m]))
  const drumColor = new Map(DRUM_PIECES.map((piece) => [piece.pitch, piece.color]))
  const bpm = Math.max(1, Number(project?.bpm) || 128)
  const secondsPerBar = (barBeats * 60) / bpm
  for (const clip of project?.clips ?? []) {
    const track = tracks.get(clip.trackId)
    if (!track) continue
    /* P3b/P6：音频片段用 media.peaks 的 offset 子区段画小波形 */
    if (clip.mediaId) {
      const item = media.get(clip.mediaId)
      if (!item) continue
      const mediaDuration = Number(item.durationSeconds) > 0 ? Number(item.durationSeconds) : 3600
      const offsetSeconds = Math.min(roundOffset(clip.offsetSeconds), Math.max(0, mediaDuration - 0.001))
      const clipSeconds = Math.max(0.001, clip.lengthBars * secondsPerBar)
      const allPeaks = Array.isArray(item.peaks) ? item.peaks : []
      let wavePeaks = []
      if (allPeaks.length > 0) {
        const startFrac = clamp(offsetSeconds / mediaDuration, 0, 1)
        const endFrac = clamp((offsetSeconds + clipSeconds) / mediaDuration, startFrac, 1)
        const startIndex = Math.floor(startFrac * allPeaks.length)
        const endIndex = Math.max(startIndex + 1, Math.ceil(endFrac * allPeaks.length))
        const slice = allPeaks.slice(startIndex, Math.min(allPeaks.length, endIndex))
        /* 小片段里 256 点会糊成色块：等距采样到 ≤72 根波形条 */
        wavePeaks = slice.length > 72
          ? Array.from({ length: 72 }, (_, index) => slice[Math.floor((index * slice.length) / 72)] ?? 0)
          : slice
      }
      out.set(clipKey(clip), {
        kind: 'audio',
        track,
        media: item,
        mediaDuration,
        secondsPerBar,
        clipSeconds,
        offsetSeconds,
        peaks: wavePeaks,
        empty: wavePeaks.length === 0,
      })
      continue
    }
    const pattern = patterns.get(clip.patternId)
    if (!pattern) continue
    const patBeats = Math.max(1, pattern.lengthBars) * barBeats
    const clipBeats = Math.max(1, clip.lengthBars) * barBeats
    const transpose = Number(clip.transpose) || 0
    const notes = pattern.notes ?? []
    let minPitch = 127
    let maxPitch = 0
    for (const note of notes) {
      minPitch = Math.min(minPitch, note.pitch + transpose)
      maxPitch = Math.max(maxPitch, note.pitch + transpose)
    }
    if (minPitch > maxPitch) {
      minPitch = 60
      maxPitch = 60
    }
    const range = Math.max(6, maxPitch - minPitch)
    const stride = Math.max(1, Math.ceil(notes.length / 70))
    const tiles = Math.min(4, Math.max(1, Math.round(clipBeats / patBeats)))
    const rects = []
    for (let tile = 0; tile < tiles; tile += 1) {
      for (let i = 0; i < notes.length; i += stride) {
        const note = notes[i]
        const rel = tile * patBeats + note.start
        if (rel >= clipBeats - 1e-6) continue
        const pitch = note.pitch + transpose
        rects.push({
          x: (rel / clipBeats) * 100,
          w: Math.max(0.8, (Math.min(note.dur, 2) / clipBeats) * 100),
          y: 93 - ((pitch - minPitch) / range) * 82,
          vel: clamp(note.vel ?? 0.7),
          color: track.kind === 'drum' ? (drumColor.get(note.pitch) ?? track.color) : shade(track.color, 0.08),
        })
      }
    }
    out.set(clipKey(clip), {
      kind: 'pattern',
      pattern,
      track,
      rects,
      repeat: Math.max(1, Math.round(clipBeats / patBeats)),
      empty: notes.length === 0,
    })
  }
  return out
}

function ClipBlock({ clip, view, takeInfo, selected, barW, rowH, onPointerDown, onTrimLeft, onDoubleClick, onContextMenu }) {
  if (!view) return null
  const isAudio = view.kind === 'audio'
  const left = clip.startBar * barW + 1
  const width = Math.max(8, clip.lengthBars * barW - 2)
  const color = view.track.color
  const name = isAudio ? view.media.name : view.pattern.name
  const peaks = isAudio ? (view.peaks ?? []) : []
  const offsetSeconds = isAudio ? roundOffset(clip.offsetSeconds) : 0
  const mediaDuration = isAudio ? view.mediaDuration : 0
  const clipSeconds = isAudio ? view.clipSeconds : 0
  const audioProps = isAudio ? audioClipFields(clip) : {}
  const hasAudioProps = Object.keys(audioProps).length > 0
  const fmtSecs = (seconds) => `${Number(seconds).toFixed(2).replace(/\.?0+$/, '')}s`
  const propParts = []
  if (audioProps.gainDb !== undefined) propParts.push(`${audioProps.gainDb > 0 ? '+' : ''}${audioProps.gainDb.toFixed(1)}dB`)
  if (audioProps.fadeInSeconds !== undefined && audioProps.fadeOutSeconds !== undefined) {
    propParts.push(`F ${fmtSecs(audioProps.fadeInSeconds)} / ${fmtSecs(audioProps.fadeOutSeconds)}`)
  } else if (audioProps.fadeInSeconds !== undefined) {
    propParts.push(`F↑ ${fmtSecs(audioProps.fadeInSeconds)}`)
  } else if (audioProps.fadeOutSeconds !== undefined) {
    propParts.push(`F↓ ${fmtSecs(audioProps.fadeOutSeconds)}`)
  }
  if (audioProps.stretchRatio !== undefined) propParts.push(`×${Number(audioProps.stretchRatio).toFixed(3).replace(/\.?0+$/, '')}`)
  if (audioProps.semitones !== undefined) propParts.push(`${audioProps.semitones > 0 ? '+' : ''}${Number(audioProps.semitones).toFixed(1).replace(/\.0$/, '')}st`)
  if (audioProps.reverse) propParts.push('REV')
  const propSummary = propParts.join(' · ')
  return (
    <button
      type="button"
      className={`aims-clip ${isAudio ? 'aims-clip--audio' : ''} ${selected ? 'is-selected' : ''} ${takeInfo && !takeInfo.active ? 'is-take-inactive' : ''}`}
      style={{
        left,
        width,
        '--clip-color': color,
        background: isAudio
          ? `linear-gradient(180deg, ${tint(color, 0.9)}, ${tint(color, 0.82)})`
          : `linear-gradient(180deg, ${tint(color, 0.88)}, ${tint(color, 0.79)})`,
        borderColor: selected ? color : tint(color, 0.5),
        borderLeft: `3px solid ${color}`,
      }}
      data-clip-id={clip.id}
      data-track-id={clip.trackId}
      data-testid={isAudio ? 'audio-clip' : undefined}
      data-media-id={isAudio ? view.media.id : undefined}
      data-pattern-id={isAudio ? undefined : clip.patternId}
      data-start-bar={clip.startBar}
      data-length-bars={clip.lengthBars}
      data-offset-seconds={isAudio ? offsetSeconds : undefined}
      data-gain-db={isAudio && audioProps.gainDb !== undefined ? audioProps.gainDb : undefined}
      data-fade-in={isAudio && audioProps.fadeInSeconds !== undefined ? audioProps.fadeInSeconds : undefined}
      data-fade-out={isAudio && audioProps.fadeOutSeconds !== undefined ? audioProps.fadeOutSeconds : undefined}
      data-reverse={isAudio && audioProps.reverse ? '1' : undefined}
      data-stretch-ratio={isAudio && audioProps.stretchRatio !== undefined ? audioProps.stretchRatio : undefined}
      data-semitones={isAudio && audioProps.semitones !== undefined ? audioProps.semitones : undefined}
      data-take-group={takeInfo?.group || undefined}
      data-take-index={takeInfo ? takeInfo.index : undefined}
      data-take-active={takeInfo ? (takeInfo.active ? '1' : '0') : undefined}
      aria-label={`${isAudio ? '音频片段' : '片段'}：${name}，第 ${clip.startBar + 1} 小节，共 ${clip.lengthBars} 小节${selected ? '（已选中）' : ''}`}
      aria-pressed={Boolean(selected)}
      title={isAudio
        ? `音频片段 · ${name} · 第 ${clip.startBar + 1}–${clip.startBar + clip.lengthBars} 小节 · ${clip.lengthBars} 小节\n起点 ${offsetSeconds.toFixed(2)}s / 时长 ${Math.min(clipSeconds, Math.max(0, mediaDuration - offsetSeconds)).toFixed(2)}s · 媒体 ${mediaDuration.toFixed(2)}s${propSummary ? `\n${propSummary}` : ''}\n拖动改位置/轨道 · 左边缘裁切 · 拖右边缘改长度 · 右键「音频属性」编辑增益/淡变/反向/拉伸/变调`
        : `${name} · 第 ${clip.startBar + 1}–${clip.startBar + clip.lengthBars} 小节 · ${clip.lengthBars} 小节${clip.transpose ? ` · 移调 ${clip.transpose > 0 ? '+' : ''}${clip.transpose}` : ''}\n拖动改位置/轨道 · 拖右边缘改长度 · 双击打开钢琴卷帘`}
      onPointerDown={(event) => onPointerDown(event, clip)}
      onDoubleClick={(event) => { event.stopPropagation(); onDoubleClick?.(clip) }}
      onContextMenu={(event) => onContextMenu?.(event, clip)}
    >
      {isAudio ? (
        <span
          className="aims-clip-trim-left"
          data-testid="audio-clip-trim-left"
          title="拖动裁切片段开头（向右拖丢弃开头，保留媒体 offset）"
          onPointerDown={(event) => onTrimLeft?.(event, clip)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ) : null}
      <span className="aims-clip-head">
        <span className="aims-clip-dot" style={{ background: color }} />
        <span className="aims-clip-name" style={{ color: shade(color, 0.36) }}>{name}</span>
        {isAudio ? <span className="aims-clip-badge">音频</span> : null}
        {isAudio && hasAudioProps ? (
          <span className="aims-clip-props-badge" data-testid="audio-clip-badge" title={`音频属性：${propSummary}`}>{propSummary}</span>
        ) : null}
        {isAudio && takeInfo ? (
          <span
            className={`aims-clip-take-badge ${takeInfo.active ? '' : 'is-inactive'}`}
            data-testid="audio-clip-take"
            data-take-index={takeInfo.index}
            data-take-active={takeInfo.active ? '1' : '0'}
            title={`Take ${takeInfo.index + 1}/${takeInfo.count}${takeInfo.active ? '（激活播放）' : '（未激活，不播放）'}`}
          >
            Take {takeInfo.index + 1}/{takeInfo.count}
          </span>
        ) : null}
        {!isAudio && view.repeat > 1 ? <span className="aims-clip-repeat" style={{ color: shade(color, 0.3) }} title={`pattern 循环 ${view.repeat} 次`}>×{view.repeat}</span> : null}
      </span>
      <span className="aims-clip-preview" aria-hidden="true">
        {isAudio ? (
          <svg className="aims-clip-wave" viewBox="0 0 100 100" preserveAspectRatio="none">
            {peaks.length > 0 ? peaks.map((peak, index) => {
              const step = 100 / peaks.length
              const height = Math.max(1.4, clamp(Number(peak) || 0) * 82)
              return (
                <rect
                  key={index}
                  x={index * step}
                  y={50 - height / 2}
                  width={Math.max(0.35, step * 0.64)}
                  height={height}
                  rx={0.6}
                  fill={shade(color, 0.18)}
                  opacity={0.62}
                />
              )
            }) : <text x="50" y="55" textAnchor="middle" fontSize="13" fill={shade(color, 0.24)}>音频</text>}
          </svg>
        ) : view.empty ? <span className="aims-clip-empty" style={{ color: shade(color, 0.2) }}>空 pattern</span> : (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            {view.rects.map((rect, index) => (
              <rect
                key={index}
                x={rect.x}
                y={rect.y}
                width={rect.w}
                height={9.5}
                rx={1.6}
                fill={rect.color}
                opacity={0.42 + rect.vel * 0.52}
              />
            ))}
          </svg>
        )}
      </span>
      <span className="aims-clip-resize" aria-hidden="true" title="拖动改变片段长度" />
      <span className="aims-clip-hint" style={{ opacity: selected ? 1 : 0 }} aria-hidden="true">
        {clip.lengthBars}B · 第{clip.startBar + 1}小节
      </span>
    </button>
  )
}

export const Playlist = memo(function Playlist({
  project, tracks = [], selectedTrackId, selectedPatternId, engine, playing = false,
  onSelectTrack, onSelectClip, onOpenClip, onCommitClips, onUpdateAudioClip, onSetTakeActive, onNotify,
  editable = false, keyboardEnabled = true, editorCommand = null,
}) {
  const barBeats = project?.timeSignature?.[0] ?? 4
  const lengthBars = Math.max(1, Number(project?.lengthBars) || 1)
  const timelineW = lengthBars * BAR_W
  const totalW = HEADER_W + timelineW

  const scrollRef = useRef(null)
  const rowsRef = useRef(null)
  const playheadHeadRef = useRef(null)
  const playheadLineRef = useRef(null)
  const playheadBarRef = useRef(null)
  const clipsRef = useRef([])
  const gestureRef = useRef(null)
  const clipboardRef = useRef(null)
  const keyThrottleRef = useRef({})
  const propsRef = useRef({})
  propsRef.current = { editable, keyboardEnabled, onCommitClips, onUpdateAudioClip, onSetTakeActive, onSelectClip, onOpenClip, onNotify, tracks, lengthBars, project }
  const liveRef = useRef({ lengthBars, timelineW, headerW: HEADER_W })
  liveRef.current = { lengthBars, timelineW, headerW: HEADER_W }

  const [clips, setClips] = useState([])
  const [selectedKey, setSelectedKey] = useState(null)
  const [contextMenu, setContextMenu] = useState(null)
  const [audioProps, setAudioProps] = useState(null)

  /* ── 宿主 → 本地 clips 同步（内容一致时保留本地对象，选择不丢） ── */
  useEffect(() => {
    const incoming = (project?.clips ?? []).map(normalizeClip)
    if (!clipsEqual(clipsRef.current, incoming)) {
      clipsRef.current = incoming
      setClips(incoming)
      setSelectedKey((prev) => (prev && incoming.some((clip) => clipKey(clip) === prev) ? prev : null))
    }
  }, [project])

  const setLocalClips = useCallback((next) => {
    clipsRef.current = next
    setClips(next)
  }, [])

  const commit = useCallback((next, label) => {
    const handler = propsRef.current.onCommitClips
    if (typeof handler === 'function') handler(plainClips(next), label)
    else propsRef.current.onSelectClip?.(null)
  }, [])

  const selectClip = useCallback((clip, { open = false } = {}) => {
    setSelectedKey(clip ? clipKey(clip) : null)
    propsRef.current.onSelectClip?.(clip ? { ...clip } : null)
    if (open && clip) propsRef.current.onOpenClip?.({ ...clip })
  }, [])

  /* ── 行高自适应 ── */
  const [viewportH, setViewportH] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const apply = () => setViewportH(el.clientHeight)
    apply()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => apply())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowH = useMemo(() => {
    const count = Math.max(1, tracks.length)
    if (viewportH < 40 || tracks.length === 0) return ROW_H
    const available = viewportH - 64 - 10
    return clamp(Math.round(available / count), ROW_H, 100)
  }, [viewportH, tracks.length])

  /* ── 播放头（每帧直接写 DOM） ── */
  const fallbackBar = Number(project?.transport?.playheadBar) || 0
  const fallbackRef = useRef(fallbackBar)
  fallbackRef.current = fallbackBar

  useFrame(engine, (e, now, frame) => {
    const pos = e ? e.positionBar : fallbackRef.current
    const { lengthBars: bars, timelineW: width, headerW } = liveRef.current
    const ratio = clamp(pos / bars, 0, 1)
    const offset = ratio * width
    if (playheadHeadRef.current) playheadHeadRef.current.style.transform = `translateX(${offset.toFixed(1)}px)`
    if (playheadLineRef.current) playheadLineRef.current.style.transform = `translateX(${(headerW + offset).toFixed(1)}px)`
    if (frame % 4 === 0 && playheadBarRef.current) {
      playheadBarRef.current.textContent = String(Math.min(bars, Math.floor(pos) + 1))
    }
    if (e?.isPlaying && scrollRef.current) {
      const scroller = scrollRef.current
      const px = headerW + offset
      const left = scrollLeftSafe(scroller)
      const right = left + scroller.clientWidth
      if (px > right - 70) scroller.scrollLeft = px - scroller.clientWidth * 0.32
      else if (px < left + headerW) scroller.scrollLeft = Math.max(0, px - headerW - 24)
    }
  })

  const scrollLeftSafe = (el) => Number(el?.scrollLeft) || 0

  /* ── 视图项目（本地 clips 覆盖宿主） ── */
  const viewProject = useMemo(() => ({ ...project, clips }), [project, clips])
  const clipViews = useMemo(() => buildClipViews(viewProject, barBeats), [viewProject, barBeats])

  /* R2c：take 组索引（同组 distinct takeIndex 数 = M，徽标 Take N/M） */
  const takeMeta = useMemo(() => {
    const groups = new Map()
    for (const clip of clips) {
      if (!clip?.mediaId || typeof clip.takeGroup !== 'string' || clip.takeGroup === '') continue
      if (!groups.has(clip.takeGroup)) groups.set(clip.takeGroup, new Set())
      groups.get(clip.takeGroup).add(Math.max(0, Math.floor(Number(clip.takeIndex) || 0)))
    }
    const out = new Map()
    for (const clip of clips) {
      if (!clip?.mediaId || typeof clip.takeGroup !== 'string' || clip.takeGroup === '') continue
      const indexes = groups.get(clip.takeGroup) ?? new Set([0])
      out.set(clipKey(clip), {
        group: clip.takeGroup,
        index: Math.max(0, Math.floor(Number(clip.takeIndex) || 0)),
        count: Math.max(1, indexes.size),
        active: clip.takeActive !== false,
      })
    }
    return out
  }, [clips])

  const clipsByTrack = useMemo(() => {
    const map = new Map()
    for (const clip of clips) {
      if (!map.has(clip.trackId)) map.set(clip.trackId, [])
      map.get(clip.trackId).push(clip)
    }
    for (const list of map.values()) list.sort((a, b) => a.startBar - b.startBar)
    return map
  }, [clips])

  const sections = useMemo(
    () => [...(project?.sections ?? [])].sort((a, b) => a.startBar - b.startBar),
    [project],
  )
  const bars = useMemo(() => Array.from({ length: lengthBars }, (_, i) => i), [lengthBars])
  const loopStart = clamp(project?.transport?.loopStartBar ?? 0, 0, lengthBars)
  const loopEnd = clamp(project?.transport?.loopEndBar ?? lengthBars, loopStart, lengthBars)

  const seekAt = (event) => {
    if (!engine || typeof engine.seek !== 'function') return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
    const bar = Math.min(lengthBars - 0.001, ratio * lengthBars)
    try {
      engine.seek(Math.max(0, bar))
    } catch (err) {
      /* seek 失败不影响展示 */
    }
  }

  /* ── 拖拽手势（window 级监听，跨轨道重渲染也不丢） ── */

  const notify = (text, tone) => propsRef.current.onNotify?.(text, tone)

  const findSelectedClip = useCallback(() => {
    const key = selectedKey
    if (!key) return null
    return clipsRef.current.find((clip) => clipKey(clip) === key) ?? null
  }, [selectedKey])

  /* ── R2a/R2b：音频片段属性（gain / fade / reverse / stretch / semitones） ── */
  const formatNum = (value) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n === 0) return ''
    return String(Math.round(n * 1000) / 1000)
  }
  const formatStretch = (value) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n === 1) return ''
    return String(Math.round(n * 1000) / 1000)
  }

  const openAudioProperties = useCallback((clip) => {
    if (!clip?.mediaId) return
    setContextMenu(null)
    setAudioProps({
      key: clipKey(clip),
      clip: { ...clip },
      gainDb: formatNum(clip.gainDb),
      fadeInSeconds: formatNum(clip.fadeInSeconds),
      fadeOutSeconds: formatNum(clip.fadeOutSeconds),
      stretchRatio: formatStretch(clip.stretchRatio),
      semitones: formatNum(clip.semitones),
      reverse: clip.reverse === true,
      error: '',
    })
  }, [])

  const updateAudioPropsField = useCallback((field, value) => {
    setAudioProps((prev) => (prev ? { ...prev, [field]: value, error: '' } : prev))
  }, [])

  const closeAudioProperties = useCallback(() => setAudioProps(null), [])

  const saveAudioProperties = useCallback(() => {
    const state = audioProps
    if (!state) return
    if (!propsRef.current.editable) { notify('只读模式：宿主编辑接口未就绪', 'error'); return }
    const clip = clipsRef.current.find((item) => clipKey(item) === state.key) ?? state.clip
    if (!clip?.mediaId) { closeAudioProperties(); return }
    const parseNumber = (raw, label, min, max, emptyValue = 0) => {
      const text = String(raw ?? '').trim()
      if (text === '') return { ok: true, value: emptyValue }
      const value = Number(text)
      if (!Number.isFinite(value)) return { ok: false, error: `${label}必须是数字` }
      if (value < min || value > max) return { ok: false, error: `${label}必须在 ${min}–${max} 之间` }
      return { ok: true, value }
    }
    const gain = parseNumber(state.gainDb, '增益', -24, 24)
    if (!gain.ok) { setAudioProps((prev) => ({ ...prev, error: gain.error })); return }
    const fadeIn = parseNumber(state.fadeInSeconds, '淡入', 0, 10)
    if (!fadeIn.ok) { setAudioProps((prev) => ({ ...prev, error: fadeIn.error })); return }
    const fadeOut = parseNumber(state.fadeOutSeconds, '淡出', 0, 10)
    if (!fadeOut.ok) { setAudioProps((prev) => ({ ...prev, error: fadeOut.error })); return }
    const stretch = parseNumber(state.stretchRatio, '拉伸倍率', 0.25, 4, 1)
    if (!stretch.ok) { setAudioProps((prev) => ({ ...prev, error: stretch.error })); return }
    const semitones = parseNumber(state.semitones, '变调', -12, 12, 0)
    if (!semitones.ok) { setAudioProps((prev) => ({ ...prev, error: semitones.error })); return }
    const project = propsRef.current.project
    const media = (project?.media ?? []).find((item) => item.id === clip.mediaId) ?? null
    const bpm = Math.max(1, Number(project?.bpm) || 128)
    const secondsPerBar = (barBeats * 60) / bpm
    const clipSeconds = Math.max(0, Number(clip.lengthBars) || 1) * secondsPerBar
    const mediaDuration = Number(media?.durationSeconds) > 0 ? Number(media.durationSeconds) : clipSeconds
    const offset = Math.max(0, Number(clip.offsetSeconds) || 0)
    const playable = Math.max(0, Math.min(clipSeconds, Math.max(0, mediaDuration - offset) * stretch.value))
    if (fadeIn.value + fadeOut.value > playable + 0.001) {
      setAudioProps((prev) => ({ ...prev, error: `淡入 + 淡出（${(fadeIn.value + fadeOut.value).toFixed(2)}s）不能超过片段可播放时长 ${playable.toFixed(2)}s` }))
      return
    }
    const nextClip = normalizeClip({
      ...clip,
      gainDb: Math.round(gain.value * 10) / 10,
      fadeInSeconds: Math.round(fadeIn.value * 1000) / 1000,
      fadeOutSeconds: Math.round(fadeOut.value * 1000) / 1000,
      stretchRatio: Math.round(stretch.value * 1000) / 1000,
      semitones: Math.round(semitones.value * 10) / 10,
      reverse: state.reverse === true,
    })
    const next = clipsRef.current.map((item) => (clipKey(item) === state.key ? nextClip : item))
    setLocalClips(next)
    const updateHandler = propsRef.current.onUpdateAudioClip
    if (typeof updateHandler === 'function') {
      /* 走 /edit editClips update；显式传 0/false/1 以清除字段。 */
      updateHandler(clip.id, {
        gainDb: nextClip.gainDb ?? 0,
        fadeInSeconds: nextClip.fadeInSeconds ?? 0,
        fadeOutSeconds: nextClip.fadeOutSeconds ?? 0,
        reverse: nextClip.reverse === true,
        stretchRatio: nextClip.stretchRatio ?? 1,
        semitones: nextClip.semitones ?? 0,
      }, '调整音频片段属性')
    } else {
      commit(next, '调整音频片段属性')
    }
    setSelectedKey(state.key)
    propsRef.current.onSelectClip?.({ ...nextClip })
    closeAudioProperties()
    notify('已更新音频片段属性（Ctrl+Z 可撤销）', 'info')
  }, [audioProps, barBeats, closeAudioProperties, commit, notify, setLocalClips])

  const applyGestureMove = useCallback((event) => {
    const gesture = gestureRef.current
    if (!gesture) return
    const { tracks: trackList, lengthBars: totalBars } = propsRef.current
    if (gesture.type === 'move') {
      const deltaBars = Math.round((event.clientX - gesture.startX) / BAR_W)
      const nextStart = clamp(gesture.startBar + deltaBars, 0, Math.max(0, totalBars - gesture.lengthBars))
      let trackIndex = gesture.trackIndex
      const rowsEl = rowsRef.current
      if (rowsEl && trackList.length) {
        const rect = rowsEl.getBoundingClientRect()
        const index = Math.floor((event.clientY - rect.top) / Math.max(1, rowH))
        trackIndex = clamp(index, 0, trackList.length - 1)
      }
      const targetTrack = trackList[trackIndex]
      const changed = nextStart !== gesture.currentStart || (targetTrack && targetTrack.id !== gesture.currentTrackId)
      if (!changed) return
      gesture.dirty = true
      gesture.currentStart = nextStart
      gesture.currentTrackId = targetTrack?.id ?? gesture.currentTrackId
      setLocalClips(clipsRef.current.map((clip) => (
        clipKey(clip) === gesture.key
          ? { ...clip, startBar: nextStart, trackId: targetTrack?.id ?? clip.trackId }
          : clip
      )))
      return
    }
    if (gesture.type === 'resize') {
      const deltaBars = Math.round((event.clientX - gesture.startX) / BAR_W)
      const nextLength = clamp(gesture.lengthBars + deltaBars, 1, Math.max(1, totalBars - gesture.startBar))
      if (nextLength === gesture.currentLength) return
      gesture.dirty = true
      gesture.currentLength = nextLength
      setLocalClips(clipsRef.current.map((clip) => (
        clipKey(clip) === gesture.key ? { ...clip, lengthBars: nextLength } : clip
      )))
      return
    }
    if (gesture.type === 'trim-left') {
      const deltaBars = Math.round((event.clientX - gesture.startX) / BAR_W)
      /* 只允许向右裁（丢弃开头）；至少留 1 小节，且 offset 不超过媒体剩余 */
      const capped = clamp(deltaBars, 0, Math.min(gesture.lengthBars - 1, gesture.maxOffsetBars))
      if (capped === gesture.currentDelta) return
      gesture.dirty = true
      gesture.currentDelta = capped
      const nextStart = gesture.startBar + capped
      const nextLength = gesture.lengthBars - capped
      const nextOffset = roundOffset(gesture.offsetSeconds + capped * gesture.secondsPerBar)
      setLocalClips(clipsRef.current.map((clip) => (
        clipKey(clip) === gesture.key
          ? { ...clip, startBar: nextStart, lengthBars: nextLength, offsetSeconds: nextOffset }
          : clip
      )))
    }
  }, [rowH, setLocalClips])

  const endGesture = useCallback(() => {
    const gesture = gestureRef.current
    gestureRef.current = null
    document.body.style.cursor = ''
    if (!gesture) return
    const moved = clipsRef.current.find((clip) => clipKey(clip) === gesture.key) ?? null
    if (gesture.dirty && moved) {
      const label = gesture.type === 'move'
        ? '移动片段'
        : gesture.type === 'trim-left' ? '裁切音频片段' : '调整片段长度'
      setSelectedKey(clipKey(moved))
      propsRef.current.onSelectClip?.({ ...moved })
      commit(clipsRef.current, label)
    }
  }, [commit])

  const onClipPointerDown = useCallback((event, clip) => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (contextMenu) setContextMenu(null)
    selectClip(clip)
    if (!propsRef.current.editable) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const edge = event.clientX >= rect.right - 9
    gestureRef.current = {
      type: edge ? 'resize' : 'move',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      key: clipKey(clip),
      startBar: clip.startBar,
      lengthBars: clip.lengthBars,
      currentStart: clip.startBar,
      currentLength: clip.lengthBars,
      currentTrackId: clip.trackId,
      trackIndex: Math.max(0, tracks.findIndex((track) => track.id === clip.trackId)),
      dirty: false,
    }
    document.body.style.cursor = edge ? 'ew-resize' : 'grabbing'
    const onMove = (ev) => applyGestureMove(ev)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      endGesture()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [applyGestureMove, endGesture, contextMenu, selectClip, tracks])

  /* P6：音频片段左边缘裁切（bar 粒度，同步 offsetSeconds / lengthBars） */
  const onClipTrimLeftPointerDown = useCallback((event, clip) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    if (contextMenu) setContextMenu(null)
    selectClip(clip)
    if (!propsRef.current.editable) return
    const project = propsRef.current.project
    const media = (project?.media ?? []).find((item) => item.id === clip.mediaId) ?? null
    const mediaDuration = Number(media?.durationSeconds) > 0 ? Number(media.durationSeconds) : 3600
    const bpm = Math.max(1, Number(project?.bpm) || 128)
    const secondsPerBarNow = (barBeats * 60) / bpm
    const offsetSeconds = roundOffset(clip.offsetSeconds)
    const stretchRatio = Math.max(0.25, Math.min(4, Number(clip.stretchRatio) || 1))
    /* R2b：裁切按 timeline 小节拖动，但 offset 是媒体源秒数，需除以 stretchRatio。 */
    const secondsPerBarSource = secondsPerBarNow / stretchRatio
    const maxOffsetBars = Math.max(0, Math.floor(((mediaDuration - 0.01) - offsetSeconds) / secondsPerBarSource + 1e-6))
    gestureRef.current = {
      type: 'trim-left',
      pointerId: event.pointerId,
      startX: event.clientX,
      key: clipKey(clip),
      startBar: clip.startBar,
      lengthBars: clip.lengthBars,
      offsetSeconds,
      secondsPerBar: secondsPerBarSource,
      maxOffsetBars,
      currentDelta: 0,
      dirty: false,
    }
    document.body.style.cursor = 'ew-resize'
    const onMove = (ev) => applyGestureMove(ev)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      endGesture()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [applyGestureMove, barBeats, contextMenu, endGesture, selectClip])

  /* P6：在播放头处分割选中的音频片段 */
  const splitSelectedAtPlayhead = useCallback(() => {
    if (!propsRef.current.editable) { notify('只读模式：宿主编辑接口未就绪', 'error'); return }
    const clip = findSelectedClip()
    if (!clip || !clip.mediaId) { notify('请先选择一个音频片段', 'info'); return }
    const project = propsRef.current.project
    const position = Number(engine?.positionBar ?? project?.transport?.playheadBar ?? 0) || 0
    const splitBar = Math.floor(position)
    const startBar = clip.startBar
    const endBar = clip.startBar + clip.lengthBars
    if (splitBar <= startBar || splitBar >= endBar) {
      notify('播放头不在该音频片段内，无法分割', 'info')
      return
    }
    if (splitBar - startBar < 1 || endBar - splitBar < 1) {
      notify('分割后片段不足 1 小节，已取消', 'info')
      return
    }
    const media = (project?.media ?? []).find((item) => item.id === clip.mediaId) ?? null
    const mediaDuration = Number(media?.durationSeconds) > 0 ? Number(media.durationSeconds) : 3600
    const bpm = Math.max(1, Number(project?.bpm) || 128)
    const secondsPerBarNow = (barBeats * 60) / bpm
    const offsetSeconds = roundOffset(clip.offsetSeconds)
    const stretchRatio = Math.max(0.25, Math.min(4, Number(clip.stretchRatio) || 1))
    const secondOffset = Math.min(
      roundOffset(offsetSeconds + ((splitBar - startBar) * secondsPerBarNow) / stretchRatio),
      Math.max(0, mediaDuration - 0.001),
    )
    /* R2a：分割时 fade 归属：淡入只留左段，淡出只留右段；gain/reverse 两段保留。 */
    const first = normalizeClip({
      ...clip,
      id: clip.id,
      lengthBars: splitBar - startBar,
      fadeOutSeconds: 0,
    })
    const second = normalizeClip({
      ...clip,
      id: nextClipId(),
      startBar: splitBar,
      lengthBars: endBar - splitBar,
      offsetSeconds: secondOffset,
      fadeInSeconds: 0,
    })
    const index = clipsRef.current.findIndex((item) => clipKey(item) === clipKey(clip))
    if (index < 0) return
    const next = [
      ...clipsRef.current.slice(0, index),
      first,
      second,
      ...clipsRef.current.slice(index + 1),
    ]
    setLocalClips(next)
    setSelectedKey(clipKey(second))
    propsRef.current.onSelectClip?.({ ...second })
    commit(next, '分割音频片段')
    notify('已在播放头处分割音频片段（Ctrl+Z 可撤销）', 'info')
  }, [barBeats, commit, engine, findSelectedClip, notify, setLocalClips])

  const playheadBarNow = useCallback(() => {
    const project = propsRef.current.project
    return Math.floor(Number(engine?.positionBar ?? project?.transport?.playheadBar ?? 0) || 0)
  }, [engine])

  const canSplitClip = useCallback((clip) => {
    if (!clip?.mediaId) return false
    const splitBar = playheadBarNow()
    return splitBar > clip.startBar && splitBar < clip.startBar + clip.lengthBars
  }, [playheadBarNow])

  const onClipDoubleClick = useCallback((clip) => {
    if (clip?.mediaId) {
      selectClip(clip)
      propsRef.current.onNotify?.('音频片段：不打开钢琴卷帘，可在播放列表拖动 / 裁剪', 'info')
      return
    }
    selectClip(clip, { open: true })
  }, [selectClip])

  const onClipContextMenu = useCallback((event, clip) => {
    event.preventDefault()
    event.stopPropagation()
    selectClip(clip)
    const x = Math.min(event.clientX, (window.innerWidth || 1200) - 230)
    const y = Math.min(event.clientY, (window.innerHeight || 800) - 300)
    setContextMenu({ x: Math.max(6, x), y: Math.max(6, y), clip: { ...clip } })
  }, [selectClip])

  useEffect(() => {
    if (!contextMenu) return undefined
    const close = (event) => {
      const menu = document.querySelector('.aims-ctxmenu')
      if (menu && menu.contains(event.target)) return
      setContextMenu(null)
    }
    const onKey = (event) => { if (event.key === 'Escape') setContextMenu(null) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  /* ── 编辑操作 ── */

  const deleteSelected = useCallback(() => {
    if (!propsRef.current.editable) { notify('只读模式：宿主编辑接口未就绪', 'error'); return }
    const key = selectedKey
    if (!key) return
    const next = clipsRef.current.filter((clip) => clipKey(clip) !== key)
    if (next.length === clipsRef.current.length) return
    setLocalClips(next)
    setSelectedKey(null)
    propsRef.current.onSelectClip?.(null)
    commit(next, '删除片段')
    notify('已删除片段（Ctrl+Z 可撤销）', 'info')
  }, [commit, notify, selectedKey, setLocalClips])

  const duplicateSelected = useCallback(() => {
    if (!propsRef.current.editable) { notify('只读模式：宿主编辑接口未就绪', 'error'); return }
    const clip = findSelectedClip()
    if (!clip) return
    const { lengthBars: totalBars } = propsRef.current
    let startBar = clip.startBar + clip.lengthBars
    if (startBar + clip.lengthBars > totalBars) startBar = Math.max(0, clip.startBar - clip.lengthBars)
    if (startBar === clip.startBar) startBar = clamp(clip.startBar + 1, 0, Math.max(0, totalBars - clip.lengthBars))
    const copy = normalizeClip({ ...clip, id: nextClipId(), startBar })
    const next = [...clipsRef.current, copy]
    setLocalClips(next)
    setSelectedKey(clipKey(copy))
    propsRef.current.onSelectClip?.({ ...copy })
    commit(next, '复制片段')
    notify('已复制片段', 'info')
  }, [commit, findSelectedClip, notify, setLocalClips])

  const copyClip = useCallback(() => {
    const clip = findSelectedClip()
    if (!clip) return
    clipboardRef.current = { ...clip }
    notify('已复制片段到剪贴板', 'info')
  }, [findSelectedClip, notify])

  const pasteClip = useCallback(() => {
    if (!propsRef.current.editable) { notify('只读模式：宿主编辑接口未就绪', 'error'); return }
    const source = clipboardRef.current
    if (!source) { notify('剪贴板为空', 'info'); return }
    const { lengthBars: totalBars } = propsRef.current
    const eng = engine
    const positionBar = eng ? eng.positionBar : (Number(propsRef.current.project?.transport?.playheadBar) || 0)
    const startBar = clamp(Math.round(positionBar), 0, Math.max(0, totalBars - source.lengthBars))
    const clip = normalizeClip({ ...source, id: nextClipId(), startBar })
    const next = [...clipsRef.current, clip]
    setLocalClips(next)
    setSelectedKey(clipKey(clip))
    propsRef.current.onSelectClip?.({ ...clip })
    commit(next, '粘贴片段')
  }, [commit, engine, notify, setLocalClips])

  const moveSelectedToTrack = useCallback((trackId) => {
    const clip = findSelectedClip()
    if (!clip || !propsRef.current.editable) return
    const next = clipsRef.current.map((item) => (
      clipKey(item) === clipKey(clip) ? { ...item, trackId } : item
    ))
    setLocalClips(next)
    setContextMenu(null)
    commit(next, '移动片段到轨道')
  }, [commit, findSelectedClip, setLocalClips])

  const editorHandlersRef = useRef({})
  editorHandlersRef.current = {
    delete: deleteSelected,
    copy: copyClip,
    paste: pasteClip,
    duplicate: duplicateSelected,
    split: splitSelectedAtPlayhead,
  }

  useEffect(() => {
    const seq = editorCommand?.seq
    if (!seq) return
    const handlers = editorHandlersRef.current
    const type = editorCommand.type
    if (type === 'delete') handlers.delete()
    else if (type === 'copy') handlers.copy()
    else if (type === 'paste') handlers.paste()
    else if (type === 'splitAudio') handlers.split()
  }, [editorCommand])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      if (isTypingTarget(event.target)) return
      if (!propsRef.current.keyboardEnabled) return
      const meta = event.ctrlKey || event.metaKey
      const key = String(event.key || '').toLowerCase()
      if (throttleKeydown(keyThrottleRef, meta ? `meta:${key}` : key, 200)) return
      if (meta && key === 'd') { event.preventDefault(); duplicateSelected() }
      else if (meta && key === 'c') { event.preventDefault(); copyClip() }
      else if (meta && key === 'v') { event.preventDefault(); pasteClip() }
      else if (meta && key === 'e') { event.preventDefault(); splitSelectedAtPlayhead() }
      else if (!meta && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); deleteSelected() }
      else if (!meta && event.key === 'Enter') {
        const clip = findSelectedClip()
        if (clip) {
          event.preventDefault()
          if (clip.mediaId) propsRef.current.onNotify?.('音频片段：不打开钢琴卷帘，可在播放列表拖动 / 裁剪', 'info')
          else propsRef.current.onOpenClip?.({ ...clip })
        }
      } else if (!meta && event.key === 'Escape') {
        setContextMenu(null)
        setSelectedKey(null)
        propsRef.current.onSelectClip?.(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [copyClip, deleteSelected, duplicateSelected, findSelectedClip, pasteClip, splitSelectedAtPlayhead])

  /* ── 右键菜单 ── */

  const contextTrackId = contextMenu?.clip?.trackId
  const contextMenuView = contextMenu ? (() => {
    const items = []
    items.push({ id: 'duplicate', label: '复制片段', hint: 'Ctrl+D', action: () => { setContextMenu(null); duplicateSelected() } })
    items.push({ id: 'copy', label: '复制到剪贴板', hint: 'Ctrl+C', action: () => { setContextMenu(null); copyClip() } })
    items.push({ id: 'delete', label: '删除片段', hint: 'Delete', danger: true, action: () => { setContextMenu(null); deleteSelected() } })
    if (contextMenu.clip?.mediaId) {
      const clip = contextMenu.clip
      const canSplit = canSplitClip(clip)
      items.push({
        id: 'audio-props',
        label: '音频属性…（增益/淡变/反向）',
        testId: 'audio-clip-props-open',
        action: () => openAudioProperties(clip),
      })
      items.push({
        id: 'split',
        label: '在播放头处分割',
        hint: 'Ctrl+E',
        disabled: !canSplit,
        action: () => {
          setContextMenu(null)
          if (!canSplit) { notify('播放头不在该音频片段内，无法分割', 'info'); return }
          splitSelectedAtPlayhead()
        },
      })
      items.push({ id: 'audio-info', label: '音频片段（无钢琴卷帘）', disabled: true, action: () => {} })
    } else {
      items.push({ id: 'open', label: '在钢琴卷帘中打开', hint: 'Enter', action: () => { const clip = contextMenu.clip; setContextMenu(null); propsRef.current.onOpenClip?.({ ...clip }) } })
    }
    return items
  })() : []

  /* ── R2a：音频属性弹层 Esc 关闭（捕获阶段，避免清掉片段选择） ── */
  useEffect(() => {
    if (!audioProps) return undefined
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setAudioProps(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [audioProps])

  return (
    <div className="aims-playlist">
      <div className="aims-pl-scroll" ref={scrollRef}>
        <div className="aims-pl-canvas" style={{ width: totalW, '--bar-w': `${BAR_W}px`, '--header-w': `${HEADER_W}px`, '--row-h': `${rowH}px` }}>
          {/* ── 小节标尺 ── */}
          <div className="aims-pl-ruler">
            <div className="aims-pl-corner">
              <span className="aims-pl-corner-label">小节</span>
              <span className="aims-pl-corner-sub aims-mono">BARS · 4/4</span>
            </div>
            <div
              className="aims-pl-ruler-bars"
              style={{ width: timelineW }}
              title="点击标尺可定位播放头"
              onClick={seekAt}
            >
              {bars.map((bar) => (
                <div
                  key={bar}
                  className={`aims-pl-tick ${bar % 4 === 0 ? 'is-major' : ''} ${bar % 8 === 0 ? 'is-strong' : ''}`}
                  style={{ width: BAR_W }}
                >
                  <span className="aims-pl-tick-num aims-mono">{bar + 1}</span>
                </div>
              ))}
              {loopEnd > loopStart ? (
                <div
                  className="aims-pl-loop"
                  style={{ left: loopStart * BAR_W, width: (loopEnd - loopStart) * BAR_W }}
                  title={`循环范围：第 ${loopStart + 1} – ${loopEnd} 小节（由 AI 设置）`}
                >
                  <span className="aims-pl-loop-cap" />
                  <span className="aims-pl-loop-cap is-end" />
                </div>
              ) : null}
              <div className="aims-pl-playhead" ref={playheadHeadRef}>
                <span className="aims-pl-playhead-pill aims-mono" ref={playheadBarRef}>1</span>
              </div>
            </div>
          </div>

          {/* ── 段落色带 ── */}
          <div className="aims-pl-sections">
            <div className="aims-pl-corner aims-pl-corner--sections">
              <span className="aims-pl-corner-label">段落</span>
              <span className="aims-pl-corner-sub">SECTIONS</span>
            </div>
            <div className="aims-pl-section-lane" style={{ width: timelineW }}>
              {sections.length === 0 ? (
                <span className="aims-pl-section-hint">AI 尚未划分段落（Intro / Build / Drop…）</span>
              ) : (
                sections.map((section) => {
                  const width = Math.max(24, section.lengthBars * BAR_W - 6)
                  const narrow = width < 96
                  return (
                    <div
                      key={section.id}
                      className={`aims-pl-section ${narrow ? 'is-narrow' : ''}`}
                      style={{
                        left: section.startBar * BAR_W + 3,
                        width,
                        color: shade(section.color, 0.34),
                        background: tint(section.color, 0.84),
                        borderColor: tint(section.color, 0.6),
                      }}
                      title={`${section.name} · 第 ${section.startBar + 1}–${section.startBar + section.lengthBars} 小节`}
                    >
                      <span className="aims-pl-section-dot" style={{ background: section.color }} />
                      <span className="aims-pl-section-name">{section.name}</span>
                      <span className="aims-pl-section-bars aims-mono">{section.lengthBars}B</span>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* ── 轨道 + clip ── */}
          <div className="aims-pl-rows" ref={rowsRef}>
            <div className="aims-pl-bands" style={{ left: HEADER_W, width: timelineW }}>
              {sections.map((section) => (
                <div
                  key={section.id}
                  className="aims-pl-band"
                  style={{
                    left: section.startBar * BAR_W,
                    width: section.lengthBars * BAR_W,
                    background: alpha(section.color, 0.05),
                    borderLeftColor: alpha(section.color, 0.28),
                  }}
                />
              ))}
              {bars.map((bar) => (bar % 4 === 0 ? (
                <div key={`g${bar}`} className="aims-pl-band-major" style={{ left: bar * BAR_W }} />
              ) : null))}
            </div>

            {tracks.length === 0 ? (
              <div className="aims-pl-notracks">
                <span className="aims-pl-notracks-icon">✦</span>
                <span>还没有轨道。让 AI 加入合成器与鼓机后，编排片段会出现在这里。</span>
              </div>
            ) : (
              tracks.map((track, index) => {
                const trackClips = clipsByTrack.get(track.id) ?? []
                const instrument = track.kind === 'drum'
                  ? findDrumKit(track.instrument?.kit)?.name
                  : track.kind === 'audio'
                    ? '音频文件'
                    : findSynthPreset(track.instrument?.preset)?.name
                return (
                  <div
                    key={track.id}
                    className={`aims-pl-row ${track.id === selectedTrackId ? 'is-selected' : ''} ${track.mute ? 'is-muted' : ''}`}
                  >
                    <div
                      className="aims-pl-track-head"
                      style={{ width: HEADER_W, '--track-color': track.color }}
                      title={`${track.name} · ${roleLabel(track.role)} · ${instrument ?? ''}`}
                      onClick={() => onSelectTrack?.(track.id)}
                    >
                      <span className="aims-pl-track-color" style={{ background: track.color }} />
                      <div className="aims-pl-track-info">
                        <div className="aims-pl-track-name">
                          <span className="aims-pl-track-idx aims-mono">{pad(index + 1)}</span>
                          <span className="aims-pl-track-title">{track.name}</span>
                        </div>
                        <div className="aims-pl-track-meta">
                          <span>{roleLabel(track.role)}</span>
                          <span className="aims-pl-track-sep">·</span>
                          <span className="aims-pl-track-inst">{instrument ?? track.kind}</span>
                        </div>
                      </div>
                      <div className="aims-pl-track-flags">
                        <span className={`aims-pl-flag ${track.mute ? 'is-on is-mute' : ''}`}>M</span>
                        <span className={`aims-pl-flag ${track.solo ? 'is-on is-solo' : ''}`}>S</span>
                      </div>
                    </div>
                    <div className="aims-pl-lane" style={{ width: timelineW }}>
                      {trackClips.length === 0 ? (
                        <span className="aims-pl-lane-empty">—</span>
                      ) : (
                        trackClips.map((clip) => (
                          <ClipBlock
                            key={clip.id}
                            clip={clip}
                            view={clipViews.get(clipKey(clip))}
                            takeInfo={takeMeta.get(clipKey(clip))}
                            barW={BAR_W}
                            rowH={rowH}
                            selected={clipKey(clip) === selectedKey}
                            onPointerDown={onClipPointerDown}
                            onTrimLeft={onClipTrimLeftPointerDown}
                            onDoubleClick={onClipDoubleClick}
                            onContextMenu={onClipContextMenu}
                          />
                        ))
                      )}
                    </div>
                  </div>
                )
              })
            )}

            <div className="aims-pl-playline" ref={playheadLineRef}>
              <span className={`aims-pl-playline-gradient ${playing ? 'is-playing' : ''}`} />
            </div>
          </div>
        </div>
      </div>

      <footer className="aims-pl-foot">
        <span className="aims-pl-foot-item"><span className="aims-pl-foot-dot" style={{ background: '#F26B3A' }} />拖动片段改位置/轨道 · 拖右边缘改长度</span>
        <span className="aims-pl-foot-item"><span className="aims-pl-foot-dot" style={{ background: '#2FB58C' }} />双击片段打开钢琴卷帘（音频片段仅提示）· 音频左边缘裁切 / Ctrl+E 在播放头分割</span>
        <span className="aims-pl-foot-item aims-pl-foot-meta">
          {clips.length} 个片段 · {(project?.sections ?? []).length} 个段落 · {editable ? '可编辑（松手一次性写回）' : '只读'} · Ctrl+D 复制 / Delete 删除
        </span>
      </footer>

      {audioProps ? (() => {
        const clip = audioProps.clip
        const mediaName = (project?.media ?? []).find((item) => item.id === clip.mediaId)?.name ?? clip.mediaId
        const trackColor = (tracks ?? []).find((track) => track.id === clip.trackId)?.color ?? '#F26B3A'
        return (
          <div
            className="aims-audio-props-backdrop"
            onPointerDown={(event) => { if (event.target === event.currentTarget) setAudioProps(null) }}
          >
            <div
              className="aims-audio-props"
              data-testid="audio-clip-props"
              role="dialog"
              aria-modal="true"
              aria-label="音频片段属性"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <header className="aims-audio-props-head">
                <span className="aims-audio-props-dot" style={{ background: trackColor }} />
                <span className="aims-audio-props-title">音频属性</span>
                <span className="aims-audio-props-name" title={mediaName}>{mediaName}</span>
                <button type="button" className="aims-audio-props-close" aria-label="关闭音频属性" onClick={() => setAudioProps(null)}>×</button>
              </header>
              <div className="aims-audio-props-grid">
                <label className="aims-audio-props-field">
                  <span>增益 Gain（dB）</span>
                  <input
                    type="number"
                    data-testid="audio-clip-gain"
                    min={-24}
                    max={24}
                    step={0.1}
                    value={audioProps.gainDb}
                    placeholder="0"
                    onChange={(event) => updateAudioPropsField('gainDb', event.target.value)}
                  />
                  <small>−24 ~ +24 dB；0 = 原始电平</small>
                </label>
                <label className="aims-audio-props-field">
                  <span>淡入 Fade In（秒）</span>
                  <input
                    type="number"
                    data-testid="audio-clip-fade-in"
                    min={0}
                    max={10}
                    step={0.01}
                    value={audioProps.fadeInSeconds}
                    placeholder="0"
                    onChange={(event) => updateAudioPropsField('fadeInSeconds', event.target.value)}
                  />
                  <small>0 ~ 10s；0 = 无淡入</small>
                </label>
                <label className="aims-audio-props-field">
                  <span>淡出 Fade Out（秒）</span>
                  <input
                    type="number"
                    data-testid="audio-clip-fade-out"
                    min={0}
                    max={10}
                    step={0.01}
                    value={audioProps.fadeOutSeconds}
                    placeholder="0"
                    onChange={(event) => updateAudioPropsField('fadeOutSeconds', event.target.value)}
                  />
                  <small>0 ~ 10s；0 = 无淡出</small>
                </label>
                <label className="aims-audio-props-field">
                  <span>拉伸 Ratio（×）</span>
                  <input
                    type="number"
                    data-testid="audio-clip-stretch"
                    min={0.25}
                    max={4}
                    step={0.01}
                    value={audioProps.stretchRatio}
                    placeholder="1"
                    onChange={(event) => updateAudioPropsField('stretchRatio', event.target.value)}
                  />
                  <small>0.25 ~ 4；1 = 原速（2 放慢一倍）</small>
                </label>
                <label className="aims-audio-props-field">
                  <span>变调 Pitch（st）</span>
                  <input
                    type="number"
                    data-testid="audio-clip-semitones"
                    min={-12}
                    max={12}
                    step={0.1}
                    value={audioProps.semitones}
                    placeholder="0"
                    onChange={(event) => updateAudioPropsField('semitones', event.target.value)}
                  />
                  <small>−12 ~ +12 半音；0 = 不变调</small>
                </label>
                <div className="aims-audio-props-field aims-audio-props-field--switch">
                  <span>反向播放 Reverse</span>
                  <Switch
                    checked={audioProps.reverse}
                    onChange={(next) => updateAudioPropsField('reverse', next)}
                    testId="audio-clip-reverse"
                    color={trackColor}
                    label="音频片段反向播放"
                    title="反向播放该片段（临时反转音频，不改原媒体）"
                  />
                  <small>反转片段音频内容；关闭恢复正向</small>
                </div>
                {audioProps.clip?.takeGroup ? (() => {
                  const groupClips = (project?.clips ?? []).filter((item) => item?.mediaId && item.takeGroup === audioProps.clip.takeGroup)
                  const indexes = [...new Set(groupClips.map((item) => Math.max(0, Math.floor(Number(item.takeIndex) || 0))))].sort((a, b) => a - b)
                  const activeClip = groupClips.find((item) => item.takeActive !== false) ?? audioProps.clip
                  const activeIndex = Math.max(0, Math.floor(Number(activeClip?.takeIndex) || 0))
                  return (
                    <label className="aims-audio-props-field aims-audio-props-field--switch">
                      <span>Take 选择</span>
                      <select
                        className="aims-audio-take-select"
                        data-testid="audio-clip-take-select"
                        value={activeIndex}
                        aria-label="选择激活的 take"
                        onChange={(event) => {
                          const nextIndex = Number(event.target.value)
                          const handler = propsRef.current.onSetTakeActive
                          if (typeof handler !== 'function') {
                            notify('Take 切换接口尚未就绪', 'error')
                            return
                          }
                          handler({ takeGroup: audioProps.clip.takeGroup, takeIndex: nextIndex }, '切换 take')
                          setAudioProps(null)
                          notify(`已切换到 Take ${nextIndex + 1}（Ctrl+Z 可撤销）`, 'info')
                        }}
                      >
                        {indexes.map((index) => (
                          <option key={index} value={index}>Take {index + 1}</option>
                        ))}
                      </select>
                      <small>切换后同组其他 take 自动停用；inactive 片段仍保留</small>
                    </label>
                  )
                })() : null}
              </div>
              {audioProps.error ? (
                <div className="aims-audio-props-error" role="alert" data-testid="audio-clip-props-error">{audioProps.error}</div>
              ) : null}
              <footer className="aims-audio-props-foot">
                <span className="aims-audio-props-hint">保存后一次撤销；0 / 1 / 关闭 = 清除对应字段</span>
                <button type="button" className="aims-ctxmenu-item aims-audio-props-cancel" onClick={() => setAudioProps(null)}>取消</button>
                <button type="button" className="aims-audio-props-save" data-testid="audio-clip-props-save" onClick={saveAudioProperties}>保存属性</button>
              </footer>
            </div>
          </div>
        )
      })() : null}

      {contextMenu ? (
        <div className="aims-ctxmenu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" aria-label="片段菜单">
          {contextMenuView.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`aims-ctxmenu-item ${item.danger ? 'is-danger' : ''} ${item.disabled ? 'is-disabled' : ''}`}
              disabled={Boolean(item.disabled)}
              data-testid={item.testId}
              onClick={item.action}
            >
              <span className="aims-ctxmenu-label">{item.label}</span>
              {item.hint ? <span className="aims-ctxmenu-hint aims-mono">{item.hint}</span> : null}
            </button>
          ))}
          <div className="aims-ctxmenu-sep" />
          <div className="aims-ctxmenu-title">移到轨道</div>
          {tracks.map((track) => (
            <button
              key={track.id}
              type="button"
              role="menuitem"
              className={`aims-ctxmenu-item ${track.id === contextTrackId ? 'is-current' : ''}`}
              onClick={() => moveSelectedToTrack(track.id)}
            >
              <span className="aims-ctxmenu-dot" style={{ background: track.color }} />
              <span className="aims-ctxmenu-label">{track.name}</span>
              {track.id === contextTrackId ? <span className="aims-ctxmenu-hint">当前</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
})

export default Playlist
