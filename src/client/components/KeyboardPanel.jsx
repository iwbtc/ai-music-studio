/**
 * 底部键盘 dock（P3a）：屏幕钢琴 + 电脑键盘 + Web MIDI + 录制。
 *
 * - 2 个八度钢琴键（C4 起，可 Z/X 移八度 -2..+2）；点击/按住发声（engine.previewNote，可选防护）。
 * - 电脑键盘映射 A W S E D F T G Y H U J K O L P ;（半音 0..16）；Z/X 八度。
 * - MIDI：点击连接后 requestMIDIAccess，监听 noteon/noteoff。
 * - 录制：开录自动播放；keydown 记录 {pitch,startBeat,vel}，keyup 计算 dur（吸附 1/16 可选）；
 *   停止时合并进 pattern 并一次 onCommitNotes(patternId, notes, '录制音符')。
 * - 展开时 App 会把 A/W/S… 交给这里演奏（KeyboardPanel 导出 KEYBOARD_CAPTURE_KEYS）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FX_PARAM_SPECS, NOTE_NAMES } from '../../shared/catalog.js'
import {
  IconChevronDown, IconClose, IconKeyboard, IconMidi, IconRecord, clamp, isTypingTarget,
} from './ui.jsx'

/** 电脑键盘半音映射（FL 布局）。 */
export const KEYBOARD_KEY_SEMITONES = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16,
}
/** 键盘面板展开时，App 全局快捷键需要让位的按键（含 Z/X 八度）。 */
export const KEYBOARD_CAPTURE_KEYS = new Set([...Object.keys(KEYBOARD_KEY_SEMITONES), 'z', 'x'])

const WHITE_SEMITONES = [0, 2, 4, 5, 7, 9, 11]
const BLACK_SEMITONES = [1, 3, 6, 8, 10]
const OCTAVE_MIN = -2
const OCTAVE_MAX = 2
const SNAP_STEP = 0.25
const BASE_PITCH = 60 // C4

/* ── R3c：MIDI Learn 8 槽 ── */
const MIDI_LEARN_TARGETS = [
  { value: 'volume', label: '音量' },
  { value: 'pan', label: '声像' },
  { value: 'sendReverb', label: '混响发送' },
  { value: 'sendDelay', label: '延迟发送' },
]
const MIDI_LEARN_DEFAULT_TARGETS = ['volume', 'pan', 'sendReverb', 'sendDelay', 'volume', 'pan', 'sendReverb', 'sendDelay']
const MIDI_CC_THROTTLE_MS = 30
const midiTargetLabel = (target) => MIDI_LEARN_TARGETS.find((item) => item.value === target)?.label ?? target
const MIN_DUR = 0.05
const MAP_HINT = 'A W S E D F T G Y H U J K O L P ;'

const round3 = (value) => Math.round(Number(value) * 1000) / 1000

export function noteNameOf(pitch) {
  const p = Math.round(Number(pitch))
  return `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`
}

export const KeyboardPanel = memo(function KeyboardPanel({
  project, tracks = [], selectedTrackId = null, selectedPatternId = null,
  engine, playing = false, expanded = true, tab = 'playlist', audioUnlocked = true,
  editable = true, height = 0, onToggleExpand, onClose, onCommitNotes, onEdit, onNotify, onEnsurePlaying,
}) {
  const patterns = project?.patterns ?? []
  const pattern = patterns.find((item) => item.id === selectedPatternId) ?? null
  const track = tracks.find((item) => item.id === selectedTrackId) ?? null
  const midiMappings = useMemo(() => (Array.isArray(project?.midiMappings) ? project.midiMappings : []), [project?.midiMappings])
  const slotMappings = useMemo(() => midiMappings.slice(0, 8), [midiMappings])
  const barBeats = Number(project?.timeSignature?.[0]) || 4
  const patternBeats = pattern ? Math.max(barBeats, (Number(pattern.lengthBars) || 1) * barBeats) : barBeats * 4

  const [octave, setOctave] = useState(0)
  const [velocity, setVelocity] = useState(0.8)
  const [snap, setSnap] = useState(true)
  const [recording, setRecording] = useState(false)
  const [recordedCount, setRecordedCount] = useState(0)
  const [pressedPitches, setPressedPitches] = useState([])
  const [midi, setMidi] = useState({ state: 'idle', message: '未连接', devices: [], selectedId: null })
  const [learningSlot, setLearningSlot] = useState(null)
  const [slotTargets, setSlotTargets] = useState(() => [...MIDI_LEARN_DEFAULT_TARGETS])

  const engineRef = useRef(engine)
  const projectRef = useRef(project)
  const patternsRef = useRef(patterns)
  const tracksRef = useRef(tracks)
  const selectedTrackIdRef = useRef(selectedTrackId)
  const selectedPatternIdRef = useRef(selectedPatternId)
  const playingRef = useRef(playing)
  const editableRef = useRef(editable)
  const expandedRef = useRef(expanded)
  const velocityRef = useRef(velocity)
  const snapRef = useRef(snap)
  const octaveRef = useRef(octave)
  const recordingRef = useRef(false)
  const recordedRef = useRef([])
  const noteOnRef = useRef(new Map())
  const activeRef = useRef(new Map())
  const pressCountRef = useRef(new Map())
  const barBeatsRef = useRef(barBeats)
  const patternBeatsRef = useRef(patternBeats)
  const onNotifyRef = useRef(onNotify)
  const onCommitNotesRef = useRef(onCommitNotes)
  const onEditRef = useRef(onEdit)
  const onEnsurePlayingRef = useRef(onEnsurePlaying)
  const midiAccessRef = useRef(null)
  const midiInputsRef = useRef([])
  const finishRef = useRef(null)
  const learningSlotRef = useRef(null)
  const slotTargetsRef = useRef(slotTargets)
  const lastMidiApplyRef = useRef(new Map())
  const handleMidiCCRef = useRef(null)

  engineRef.current = engine
  projectRef.current = project
  patternsRef.current = patterns
  tracksRef.current = tracks
  selectedTrackIdRef.current = selectedTrackId
  selectedPatternIdRef.current = selectedPatternId
  playingRef.current = playing
  editableRef.current = editable
  expandedRef.current = expanded
  velocityRef.current = velocity
  snapRef.current = snap
  octaveRef.current = octave
  barBeatsRef.current = barBeats
  patternBeatsRef.current = patternBeats
  onNotifyRef.current = onNotify
  onCommitNotesRef.current = onCommitNotes
  onEditRef.current = onEdit
  onEnsurePlayingRef.current = onEnsurePlaying
  learningSlotRef.current = learningSlot
  slotTargetsRef.current = slotTargets

  const basePitch = BASE_PITCH + octave * 12

  /* ── 时间换算 ── */
  const absBeat = useCallback(() => {
    const eng = engineRef.current
    const bar = eng ? Number(eng.positionBar) || 0 : (Number(projectRef.current?.transport?.playheadBar) || 0)
    return Math.max(0, bar * barBeatsRef.current)
  }, [])
  const patternBeatNow = useCallback(() => {
    const total = patternBeatsRef.current || 4
    const beat = absBeat()
    return ((beat % total) + total) % total
  }, [absBeat])
  const snapBeat = useCallback((value) => (
    snapRef.current ? Math.round(value / SNAP_STEP) * SNAP_STEP : value
  ), [])

  /* ── 按下高亮（多来源计数） ── */
  const addPressed = useCallback((pitch) => {
    const prev = pressCountRef.current.get(pitch) ?? 0
    pressCountRef.current.set(pitch, prev + 1)
    if (prev === 0) setPressedPitches((list) => (list.includes(pitch) ? list : [...list, pitch]))
  }, [])
  const removePressed = useCallback((pitch) => {
    const prev = pressCountRef.current.get(pitch) ?? 0
    if (prev <= 1) {
      pressCountRef.current.delete(pitch)
      setPressedPitches((list) => list.filter((item) => item !== pitch))
    } else {
      pressCountRef.current.set(pitch, prev - 1)
    }
  }, [])

  /* ── 发声 / 停止（电脑键盘 / 鼠标 / MIDI 共用） ── */
  const playSource = useCallback((source, pitch, vel) => {
    if (activeRef.current.has(source)) return
    const eng = engineRef.current
    const trackId = selectedTrackIdRef.current
    let previewId = null
    if (eng && trackId && typeof eng.previewNote === 'function') {
      try { previewId = eng.previewNote(trackId, pitch, vel) } catch (err) { previewId = null }
    }
    activeRef.current.set(source, { pitch, previewId })
    addPressed(pitch)
    if (recordingRef.current && selectedTrackIdRef.current) {
      const start = round3(snapBeat(patternBeatNow()))
      noteOnRef.current.set(source, {
        pitch,
        startAbs: absBeat(),
        start,
        vel: round3(clamp(Number(vel) || 0.8, 0.05, 1)),
      })
    }
  }, [absBeat, addPressed, patternBeatNow, snapBeat])

  const stopSource = useCallback((source) => {
    const info = activeRef.current.get(source)
    if (!info) return
    activeRef.current.delete(source)
    const eng = engineRef.current
    if (info.previewId != null) {
      try { eng?.stopPreview?.(info.previewId) } catch (err) { /* ignore */ }
    }
    removePressed(info.pitch)
    const note = noteOnRef.current.get(source)
    if (!note) return
    noteOnRef.current.delete(source)
    if (!recordingRef.current) return
    const endAbs = absBeat()
    let dur = Math.max(MIN_DUR, endAbs - note.startAbs)
    dur = snapRef.current
      ? Math.max(SNAP_STEP, Math.round(dur / SNAP_STEP) * SNAP_STEP)
      : Math.max(MIN_DUR, dur)
    const next = [...recordedRef.current, {
      pitch: note.pitch,
      start: note.start,
      dur: round3(dur),
      vel: note.vel,
    }]
    recordedRef.current = next
    setRecordedCount(next.length)
  }, [absBeat, removePressed])

  const stopAllSources = useCallback(() => {
    for (const source of [...activeRef.current.keys()]) stopSource(source)
  }, [stopSource])

  /* ── 录制 ── */
  const finishRecording = useCallback((options = {}) => {
    if (!recordingRef.current) return
    // 仍在按住的音符先收尾（此时 recordingRef 仍为 true）
    for (const source of [...noteOnRef.current.keys()]) stopSource(source)
    recordingRef.current = false
    if (!options.silent) setRecording(false)
    try { engineRef.current?.stopAllPreviews?.() } catch (err) { /* ignore */ }
    const notes = [...recordedRef.current]
    const patternId = selectedPatternIdRef.current
    const pat = (patternsRef.current ?? []).find((item) => item.id === patternId)
    if (!notes.length) {
      if (!options.silent) onNotifyRef.current?.('没有录到音符：按住琴键再松开即可录制', 'info')
      return
    }
    if (!pat) return
    let merged = [...(pat.notes ?? [])]
    for (const note of notes) {
      merged = merged.filter((item) => !(Number(item.pitch) === note.pitch && Math.abs(Number(item.start) - note.start) < 0.01))
      merged.push({ pitch: note.pitch, start: note.start, dur: note.dur, vel: note.vel })
    }
    merged.sort((a, b) => (Number(a.start) - Number(b.start)) || (Number(a.pitch) - Number(b.pitch)))
    onCommitNotesRef.current?.(patternId, merged, '录制音符')
    if (!options.silent) {
      onNotifyRef.current?.(`已录制 ${notes.length} 个音符到「${pat.name}」（Ctrl+Z 可撤销）`, 'success')
    }
  }, [stopSource])
  finishRef.current = finishRecording

  const startRecording = useCallback(async () => {
    if (recordingRef.current) return
    if (!tracksRef.current.some((item) => item.id === selectedTrackIdRef.current)) {
      onNotifyRef.current?.('先选中一条轨道再录制', 'info')
      return
    }
    const pat = (patternsRef.current ?? []).find((item) => item.id === selectedPatternIdRef.current)
    if (!pat) {
      onNotifyRef.current?.('先选择一个 pattern 再录制', 'info')
      return
    }
    if (!editableRef.current) {
      onNotifyRef.current?.('只读模式：宿主编辑接口尚未就绪', 'error')
      return
    }
    recordedRef.current = []
    noteOnRef.current.clear()
    setRecordedCount(0)
    recordingRef.current = true
    setRecording(true)
    if (!playingRef.current) {
      try { await onEnsurePlayingRef.current?.() } catch (err) { /* ignore */ }
    }
    onNotifyRef.current?.('开始录制：用电脑键盘 / 鼠标 / MIDI 弹奏，录完点停止', 'info')
  }, [])

  const toggleRecord = useCallback(() => {
    if (recordingRef.current) finishRecording()
    else startRecording()
  }, [finishRecording, startRecording])

  // 播放停止 / 切 tab / 折叠 → 结束录制并提交
  const prevPlayingRef = useRef(playing)
  useEffect(() => {
    const prev = prevPlayingRef.current
    prevPlayingRef.current = playing
    if (prev && !playing && recordingRef.current) finishRecording()
  }, [playing, finishRecording])

  const prevTabRef = useRef(tab)
  useEffect(() => {
    if (prevTabRef.current !== tab) {
      prevTabRef.current = tab
      if (recordingRef.current) finishRecording()
    }
  }, [tab, finishRecording])

  useEffect(() => {
    if (!expanded && recordingRef.current) finishRecording()
  }, [expanded, finishRecording])

  // 卸载 / 关闭：静默提交录制 & 释放预览/MIDI
  useEffect(() => () => {
    finishRef.current?.({ silent: true })
    try { engineRef.current?.stopAllPreviews?.() } catch (err) { /* ignore */ }
    for (const input of midiInputsRef.current ?? []) {
      try { input.onmidimessage = null } catch (err) { /* ignore */ }
    }
  }, [])

  /* ── 电脑键盘演奏 ── */
  useEffect(() => {
    if (!expanded) return undefined
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      const key = String(event.key || '').toLowerCase()
      if (key === 'z' || key === 'x') {
        event.preventDefault()
        setOctave((prev) => clamp(prev + (key === 'z' ? -1 : 1), OCTAVE_MIN, OCTAVE_MAX))
        return
      }
      const semi = KEYBOARD_KEY_SEMITONES[key]
      if (semi === undefined) return
      event.preventDefault()
      playSource(`key:${key}`, BASE_PITCH + octaveRef.current * 12 + semi, velocityRef.current)
    }
    const onKeyUp = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = String(event.key || '').toLowerCase()
      if (KEYBOARD_KEY_SEMITONES[key] === undefined) return
      stopSource(`key:${key}`)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      for (const source of [...activeRef.current.keys()]) {
        if (source.startsWith('key:')) stopSource(source)
      }
    }
  }, [expanded, playSource, stopSource])

  /* ── MIDI Learn：8 槽 → project.midiMappings，CC 应用走 actions.edit ── */
  const runMidiEdit = useCallback((op, label) => {
    const handler = onEditRef.current
    if (typeof handler !== 'function') {
      onNotifyRef.current?.('编辑接口尚未就绪，无法保存 MIDI 映射', 'error')
      return false
    }
    handler([op], label || 'MIDI 映射')
    return true
  }, [])

  const beginMidiLearn = useCallback((slotIndex) => {
    if (!editableRef.current) {
      onNotifyRef.current?.('只读模式：无法学习 MIDI 映射', 'error')
      return
    }
    setLearningSlot((current) => {
      const next = current === slotIndex ? null : slotIndex
      learningSlotRef.current = next
      onNotifyRef.current?.(
        next === null ? '已取消 MIDI 学习' : `MIDI 学习中：请发送 CC 消息绑定槽位 ${slotIndex + 1}（${midiTargetLabel(slotTargetsRef.current[slotIndex])}）`,
        'info',
      )
      return next
    })
  }, [])

  const handleMidiCC = useCallback((cc, rawValue, channel = 0) => {
    const controller = Math.max(0, Math.min(127, Math.round(Number(cc) || 0)))
    const value = Math.max(0, Math.min(127, Math.round(Number(rawValue) || 0)))
    const midiChannel = Number.isInteger(Number(channel)) ? Math.max(0, Math.min(15, Number(channel))) : 0
    const learningIndex = learningSlotRef.current
    const mappings = Array.isArray(projectRef.current?.midiMappings) ? projectRef.current.midiMappings : []

    if (learningIndex !== null && learningIndex !== undefined) {
      const existing = mappings.slice(0, 8)[learningIndex] ?? null
      const target = existing?.target ?? slotTargetsRef.current?.[learningIndex] ?? 'volume'
      const trackId = existing?.trackId ?? selectedTrackIdRef.current ?? tracksRef.current?.[0]?.id ?? null
      if (!trackId) {
        onNotifyRef.current?.('请先选择一条轨道，再学习 MIDI 映射', 'info')
        return
      }
      if (target === 'effectParam' && (!existing?.effectId || !existing?.param)) {
        onNotifyRef.current?.('effectParam 目标需要已有 effectId/param 映射', 'error')
        return
      }
      const ok = runMidiEdit({
        type: 'setMidiMapping',
        ...(existing?.id ? { id: existing.id } : {}),
        cc: controller,
        channel: midiChannel,
        target,
        trackId,
        ...(existing?.effectId ? { effectId: existing.effectId } : {}),
        ...(existing?.param ? { param: existing.param } : {}),
        min: existing?.min ?? 0,
        max: existing?.max ?? 1,
      }, `学习 MIDI CC${controller} → ${midiTargetLabel(target)}`)
      if (ok) {
        setLearningSlot(null)
        learningSlotRef.current = null
        onNotifyRef.current?.(`已学习 CC${controller}（通道 ${midiChannel + 1}）→ 槽位 ${learningIndex + 1}`, 'success')
      }
      return
    }

    const mapping = mappings.find((item) => (
      item && Number(item.cc) === controller
      && (item.channel === null || item.channel === undefined || Number(item.channel) === midiChannel)
    ))
    if (!mapping) return
    const now = Date.now()
    const throttleKey = mapping.id ?? `${controller}:${midiChannel}`
    if (now - (lastMidiApplyRef.current.get(throttleKey) ?? 0) < MIDI_CC_THROTTLE_MS) return
    lastMidiApplyRef.current.set(throttleKey, now)
    const min = Number.isFinite(Number(mapping.min)) ? Number(mapping.min) : 0
    const max = Number.isFinite(Number(mapping.max)) ? Number(mapping.max) : 1
    const normalized = Math.max(0, Math.min(1, (value / 127) * (max - min) + min))
    const trackId = mapping.trackId
    let op = null
    if (mapping.target === 'volume') {
      op = { type: 'updateTrack', trackId, volume: normalized }
    } else if (mapping.target === 'pan') {
      op = { type: 'updateTrack', trackId, pan: normalized * 2 - 1 }
    } else if (mapping.target === 'sendReverb') {
      op = { type: 'setTrackSends', trackId, reverb: normalized }
    } else if (mapping.target === 'sendDelay') {
      op = { type: 'setTrackSends', trackId, delay: normalized }
    } else if (mapping.target === 'effectParam' && mapping.effectId && mapping.param) {
      /* updateEffect 的 target 是 track/master/bus，轨道 id 放 trackId。 */
      const trackNow = (projectRef.current?.tracks ?? []).find((item) => item.id === trackId)
      const effectNow = (trackNow?.effects ?? []).find((item) => item.id === mapping.effectId)
      const spec = FX_PARAM_SPECS[effectNow?.type]?.[mapping.param]
      let effectValue = normalized
      if (spec?.type === 'number' && Number.isFinite(Number(spec.min)) && Number.isFinite(Number(spec.max))) {
        const minValue = Number(spec.min)
        const maxValue = Number(spec.max)
        /* Hz 类参数（cutoff/frequency）按对数映射，其余线性映射到 FX_PARAM_SPECS 实际范围。 */
        const isHz = spec.unit === 'Hz' && maxValue / Math.max(1, minValue) >= 10
        effectValue = isHz
          ? minValue * Math.pow(maxValue / Math.max(1, minValue), normalized)
          : minValue + (maxValue - minValue) * normalized
      }
      op = {
        type: 'updateEffect',
        target: 'track',
        trackId,
        effectId: mapping.effectId,
        params: { [mapping.param]: effectValue },
      }
    }
    if (op) runMidiEdit(op, `MIDI CC${controller} → ${midiTargetLabel(mapping.target)}`)
  }, [runMidiEdit])

  handleMidiCCRef.current = handleMidiCC

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const host = window.__AIMS_E2E__ ?? (window.__AIMS_E2E__ = {})
    const previous = host.midiCC
    const bridge = (cc, value, channel = 0) => handleMidiCCRef.current?.(cc, value, channel)
    host.midiCC = bridge
    return () => {
      if (host.midiCC !== bridge) return
      if (typeof previous === 'function') host.midiCC = previous
      else delete host.midiCC
    }
  }, [])

  const handleMidiTargetChange = useCallback((slotIndex, nextTarget) => {
    setSlotTargets((prev) => {
      const next = [...prev]
      next[slotIndex] = nextTarget
      slotTargetsRef.current = next
      return next
    })
    const mapping = (projectRef.current?.midiMappings ?? []).slice(0, 8)[slotIndex]
    if (!mapping) return
    if (nextTarget === 'effectParam' && (!mapping.effectId || !mapping.param)) {
      onNotifyRef.current?.('effectParam 需要已有 effectId/param；当前槽位保持原目标', 'error')
      return
    }
    runMidiEdit({
      type: 'setMidiMapping',
      id: mapping.id,
      cc: mapping.cc,
      channel: mapping.channel ?? null,
      target: nextTarget,
      trackId: mapping.trackId,
      ...(nextTarget === 'effectParam' ? { effectId: mapping.effectId, param: mapping.param } : {}),
      min: mapping.min ?? 0,
      max: mapping.max ?? 1,
    }, '修改 MIDI 映射目标')
  }, [runMidiEdit])

  const clearMidiSlot = useCallback((mapping) => {
    if (!mapping?.id) return
    runMidiEdit({ type: 'clearMidiMapping', id: mapping.id }, '清除 MIDI 映射')
    setLearningSlot((current) => {
      if (current === null) return current
      return current
    })
  }, [runMidiEdit])

  /* ── MIDI ── */
  const handleMidiMessage = useCallback((event) => {
    const data = event?.data
    if (!data || data.length < 3) return
    const [status, pitch, rawVel] = data
    const command = status & 0xf0
    if (command === 0xb0) {
      handleMidiCCRef.current?.(pitch, rawVel, status & 0x0f)
      return
    }
    if (command === 0x90 && rawVel > 0) {
      playSource(`midi:${pitch}`, pitch, clamp(rawVel / 127, 0.05, 1))
    } else if (command === 0x80 || (command === 0x90 && rawVel === 0)) {
      stopSource(`midi:${pitch}`)
    }
  }, [playSource, stopSource])

  const connectMidi = useCallback(async () => {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      setMidi({ state: 'unsupported', message: '浏览器不支持 Web MIDI', devices: [], selectedId: null })
      onNotifyRef.current?.('当前浏览器不支持 Web MIDI（电脑键盘/鼠标仍可演奏）', 'info')
      return
    }
    setMidi((prev) => ({ ...prev, state: 'connecting', message: '正在请求 MIDI 权限…' }))
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false })
      midiAccessRef.current = access
      const inputs = [...access.inputs.values()]
      for (const input of inputs) {
        try { input.onmidimessage = handleMidiMessage } catch (err) { /* ignore */ }
      }
      midiInputsRef.current = inputs
      setMidi({
        state: inputs.length ? 'connected' : 'no-devices',
        message: inputs.length ? inputs.map((item) => item.name || item.id).join(' / ') : '未发现 MIDI 输入设备',
        devices: inputs.map((item) => ({ id: item.id, name: item.name || item.id })),
        selectedId: inputs[0]?.id ?? null,
      })
      onNotifyRef.current?.(inputs.length ? `MIDI 已连接：${inputs.map((item) => item.name).join(' / ')}` : '没有发现 MIDI 输入设备（电脑键盘仍可演奏）', 'info')
    } catch (error) {
      setMidi({ state: 'error', message: `MIDI 连接失败：${error?.message ?? error}`, devices: [], selectedId: null })
      onNotifyRef.current?.(`MIDI 连接失败：${error?.message ?? error}`, 'error')
    }
  }, [handleMidiMessage])

  /* ── 钢琴键渲染数据 ── */
  const keyboard = useMemo(() => {
    const whites = []
    const blacks = []
    for (let oct = 0; oct < 2; oct += 1) {
      for (const semi of WHITE_SEMITONES) whites.push({ pitch: basePitch + oct * 12 + semi, isWhite: true })
    }
    for (let oct = 0; oct < 2; oct += 1) {
      for (const semi of BLACK_SEMITONES) {
        const pitch = basePitch + oct * 12 + semi
        const whiteBefore = whites.filter((item) => item.pitch < pitch).length
        blacks.push({ pitch, whiteBefore })
      }
    }
    return { whites, blacks, whiteCount: whites.length }
  }, [basePitch])

  const pressedSet = useMemo(() => new Set(pressedPitches), [pressedPitches])
  const canRecord = Boolean(track && pattern && editable)
  const previewReady = typeof engine?.previewNote === 'function'
  const midiLabel = midi.state === 'connected' ? (midi.devices[0]?.name ?? 'MIDI 已连接')
    : midi.state === 'connecting' ? '连接中…'
      : midi.state === 'unsupported' ? '不支持 MIDI'
        : midi.state === 'no-devices' ? '无 MIDI 设备'
          : midi.state === 'error' ? 'MIDI 失败'
            : '连接 MIDI'
  let statusText = '就绪'
  if (recording) statusText = `录音中 · 已录 ${recordedCount} 个音符`
  else if (!track) statusText = '先选中一条轨道'
  else if (!pattern) statusText = '先选择一个 pattern'
  else if (!previewReady) statusText = '预览未就绪（仍可录制）'
  const active = Boolean(expanded)

  const handleClose = () => {
    finishRecording()
    try { engineRef.current?.stopAllPreviews?.() } catch (err) { /* ignore */ }
    onClose?.()
  }

  const keyPointerDown = (event, pitch) => {
    event.preventDefault()
    event.stopPropagation()
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch (err) { /* ignore */ }
    playSource(`ptr:${event.pointerId}`, pitch, velocityRef.current)
  }
  const keyPointerUp = (event) => {
    stopSource(`ptr:${event.pointerId}`)
  }
  const keyPointerLeave = (event) => {
    if (event.buttons === 0) return
    stopSource(`ptr:${event.pointerId}`)
  }

  return (
    <section
      className={`aims-keyboard ${active ? 'is-expanded' : 'is-collapsed'} ${recording ? 'is-recording' : ''}`}
      data-testid="keyboard-panel"
      data-expanded={active ? 'true' : 'false'}
      data-recording={recording ? 'true' : 'false'}
      data-recorded={recordedCount}
      data-track-id={selectedTrackId ?? ''}
      data-pattern-id={pattern?.id ?? ''}
      data-preview={previewReady ? '1' : '0'}
      style={height > 0 ? { height: `${height}px`, flex: '0 0 auto' } : undefined}
    >
      <header className="aims-keyboard-head">
        <span className="aims-keyboard-title">
          <IconKeyboard size={14} />
          键盘
        </span>
        <span className="aims-keyboard-target" data-testid="keyboard-target" title="目标轨道 / pattern">
          <span className={`aims-keyboard-dot ${track ? 'is-on' : ''}`} />
          {track?.name ?? '未选轨道'}
          <span className="aims-keyboard-target-sep">·</span>
          {pattern?.name ?? '未选 pattern'}
        </span>
        {track?.engine === 'vst3' || track?.vst3 ? (
          <span
            className="aims-keyboard-vst3"
            data-testid="keyboard-vst3-target"
            title="VST3 乐器实时：键盘按键/播放 MIDI 由 engine 路由到插件实例"
          >
            VST3 乐器 · {typeof window !== 'undefined' && window.aimsPlugins ? '实时' : '仅桌面版'}
          </span>
        ) : null}
        <button
          type="button"
          className={`aims-keyboard-midi-btn ${midi.state === 'connected' ? 'is-on' : ''}`}
          data-testid="keyboard-midi"
          title={midi.message}
          onClick={connectMidi}
        >
          <IconMidi size={12} />
          {midiLabel}
        </button>
        {midi.devices.length > 1 ? (
          <select
            className="aims-keyboard-midi-select"
            data-testid="keyboard-midi-device"
            value={midi.selectedId ?? ''}
            onChange={(event) => {
              const nextId = event.target.value
              setMidi((prev) => ({ ...prev, selectedId: nextId }))
              event.currentTarget.blur()
            }}
            title="MIDI 输入设备"
          >
            {midi.devices.map((device) => (
              <option key={device.id} value={device.id}>{device.name}</option>
            ))}
          </select>
        ) : null}
        <div className="aims-keyboard-learn" data-testid="midi-learn" title={midi.state === 'connected' ? 'MIDI Learn：选择槽位后发送 CC 消息完成学习' : '未连接 MIDI：可点击“连接 MIDI”，或用 E2E __AIMS_E2E__.midiCC() 钩子'}>
          {midi.state !== 'connected' ? <span className="aims-midi-learn-hint" title="未连接 MIDI：可点击连接 MIDI，或用 E2E __AIMS_E2E__.midiCC() 钩子">MIDI</span> : null}
          {Array.from({ length: 8 }, (_, index) => {
            const mapping = slotMappings[index] ?? null
            const target = mapping?.target ?? slotTargets[index] ?? MIDI_LEARN_DEFAULT_TARGETS[index]
            const learning = learningSlot === index
            return (
              <span
                key={index}
                className={`aims-midi-slot ${mapping ? 'is-mapped' : ''} ${learning ? 'is-learning' : ''}`}
                data-testid={`midi-learn-slot-${index + 1}`}
                data-cc={mapping?.cc ?? ''}
                data-target={target}
                data-learning={learning ? '1' : '0'}
              >
                <span className="aims-midi-slot-index">{index + 1}</span>
                <span className="aims-midi-slot-cc" title={mapping ? `CC${mapping.cc}${mapping.channel === null || mapping.channel === undefined ? '' : ` · ch${Number(mapping.channel) + 1}`}` : '未学习'}>{mapping ? `CC${mapping.cc}` : '—'}</span>
                <select
                  className="aims-midi-slot-target"
                  data-testid={`midi-learn-target-${index + 1}`}
                  aria-label={`槽位 ${index + 1} 映射目标`}
                  value={target}
                  onChange={(event) => handleMidiTargetChange(index, event.target.value)}
                  title="映射目标（学习时绑定当前选中轨道）"
                >
                  {MIDI_LEARN_TARGETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  {target === 'effectParam' ? <option value="effectParam">效果参数</option> : null}
                  {!MIDI_LEARN_TARGETS.some((item) => item.value === target) && target !== 'effectParam'
                    ? <option value={target}>{target}</option> : null}
                </select>
                <button
                  type="button"
                  className={`aims-midi-learn-btn ${learning ? 'is-learning' : ''}`}
                  data-testid={`midi-learn-${index + 1}`}
                  aria-pressed={learning}
                  onClick={() => beginMidiLearn(index)}
                  title={learning ? `学习中：发送 CC 绑定槽位 ${index + 1}` : `学习槽位 ${index + 1}（${midiTargetLabel(target)}）`}
                >{learning ? '…' : 'L'}</button>
                {mapping ? (
                  <button
                    type="button"
                    className="aims-midi-clear-btn"
                    data-testid={`midi-learn-clear-${index + 1}`}
                    onClick={() => clearMidiSlot(mapping)}
                    title={`清除槽位 ${index + 1} 映射`}
                    aria-label={`清除槽位 ${index + 1} MIDI 映射`}
                  >×</button>
                ) : null}
              </span>
            )
          })}
        </div>
        {recording ? <span className="aims-keyboard-recdot" title="正在录音" /> : null}
        <span className="aims-keyboard-head-spacer" />
        <button
          type="button"
          className="aims-keyboard-iconbtn"
          data-testid="keyboard-collapse"
          aria-expanded={active}
          title={active ? '折叠键盘面板' : '展开键盘面板'}
          onClick={() => onToggleExpand?.()}
        >
          <IconChevronDown size={13} />
        </button>
        <button
          type="button"
          className="aims-keyboard-iconbtn"
          data-testid="keyboard-close"
          title="关闭键盘面板"
          onClick={handleClose}
        >
          <IconClose size={12} />
        </button>
      </header>

      {active ? (
        <>
          <div className="aims-keyboard-body">
            <div className="aims-keyboard-keys" role="group" aria-label="钢琴键盘（2 个八度）">
              <div className="aims-keyboard-whites">
                {keyboard.whites.map(({ pitch }) => {
                  const label = noteNameOf(pitch)
                  const isPressed = pressedSet.has(pitch)
                  return (
                    <button
                      key={pitch}
                      type="button"
                      className={`aims-pkey aims-pkey--white ${isPressed ? 'is-pressed' : ''}`}
                      data-testid="keyboard-key"
                      data-pitch={pitch}
                      data-note={label}
                      data-kind="white"
                      aria-pressed={isPressed}
                      aria-label={`${label}${isPressed ? '（按下）' : ''}`}
                      title={`${label}（MIDI ${pitch}）`}
                      onPointerDown={(event) => keyPointerDown(event, pitch)}
                      onPointerUp={keyPointerUp}
                      onPointerCancel={keyPointerUp}
                      onPointerLeave={keyPointerLeave}
                    >
                      {pitch % 12 === 0 ? <span className="aims-pkey-label">{label}</span> : null}
                    </button>
                  )
                })}
              </div>
              {keyboard.blacks.map(({ pitch, whiteBefore }) => {
                const label = noteNameOf(pitch)
                const isPressed = pressedSet.has(pitch)
                const unit = 100 / keyboard.whiteCount
                return (
                  <button
                    key={pitch}
                    type="button"
                    className={`aims-pkey aims-pkey--black ${isPressed ? 'is-pressed' : ''}`}
                    data-testid="keyboard-key"
                    data-pitch={pitch}
                    data-note={label}
                    data-kind="black"
                    aria-pressed={isPressed}
                    aria-label={`${label}${isPressed ? '（按下）' : ''}`}
                    title={`${label}（MIDI ${pitch}）`}
                    style={{ left: `calc(${whiteBefore * unit}% - ${unit * 0.3}%)`, width: `${unit * 0.62}%` }}
                    onPointerDown={(event) => keyPointerDown(event, pitch)}
                    onPointerUp={keyPointerUp}
                    onPointerCancel={keyPointerUp}
                    onPointerLeave={keyPointerLeave}
                  >
                    {pitch % 12 === 1 ? <span className="aims-pkey-label">{label}</span> : null}
                  </button>
                )
              })}
            </div>

            <div className="aims-keyboard-side">
              <div className="aims-keyboard-map" title="电脑键盘映射（半音顺序）">
                <span className="aims-keyboard-map-label">键盘</span>
                {MAP_HINT.split(' ').map((key, index) => (
                  <kbd key={`${key}-${index}`} className="aims-keyboard-keycap">{key}</kbd>
                ))}
                <span className="aims-keyboard-map-extra">Z/X 八度</span>
              </div>
              <div className="aims-keyboard-midi-hint" title={midi.message}>
                <span className={`aims-keyboard-dot ${midi.state === 'connected' ? 'is-on' : ''}`} />
                MIDI：{midi.message}
              </div>
              <div className="aims-keyboard-audio-hint">
                <span className={`aims-keyboard-dot ${audioUnlocked ? 'is-on' : ''}`} />
                {audioUnlocked ? '音频已启用 · 监听真实音色' : '音频未启用：点击界面启用后可听到声音'}
                {!previewReady ? <span className="aims-keyboard-audio-warn">（引擎预览接口未就绪）</span> : null}
              </div>
            </div>
          </div>

          <div className="aims-keyboard-controls">
            <div className="aims-keyboard-octave" title="八度移调（Z / X）">
              <button
                type="button"
                className="aims-keyboard-step"
                data-testid="keyboard-octave-down"
                disabled={octave <= OCTAVE_MIN}
                onClick={() => setOctave((prev) => clamp(prev - 1, OCTAVE_MIN, OCTAVE_MAX))}
                aria-label="降低八度"
              >−</button>
              <span className="aims-keyboard-octave-value aims-mono" title="当前八度（C 起始）">
                {noteNameOf(basePitch)}
              </span>
              <button
                type="button"
                className="aims-keyboard-step"
                data-testid="keyboard-octave-up"
                disabled={octave >= OCTAVE_MAX}
                onClick={() => setOctave((prev) => clamp(prev + 1, OCTAVE_MIN, OCTAVE_MAX))}
                aria-label="升高八度"
              >+</button>
              <span className="aims-keyboard-octave-range aims-mono">C4±{octave}</span>
            </div>

            <label className="aims-keyboard-field" title="演奏/录制的力度">
              <span className="aims-keyboard-field-label">力度</span>
              <input
                type="range"
                className="aims-keyboard-range"
                data-testid="keyboard-velocity"
                min={0.2}
                max={1}
                step={0.01}
                value={velocity}
                onChange={(event) => setVelocity(Number(event.target.value))}
                onPointerUp={(event) => event.currentTarget.blur()}
                aria-label="力度"
              />
              <b className="aims-keyboard-value aims-mono">{Math.round(velocity * 100)}</b>
            </label>

            <label className="aims-keyboard-field aims-keyboard-field--snap" title="录制时把音符位置吸附到 1/16（0.25 beat）">
              <input
                type="checkbox"
                data-testid="keyboard-snap"
                checked={snap}
                onChange={(event) => {
                  setSnap(event.target.checked)
                  event.currentTarget.blur()
                }}
              />
              吸附 1/16
            </label>

            <button
              type="button"
              className={`aims-keyboard-record ${recording ? 'is-recording' : ''}`}
              data-testid="keyboard-record"
              aria-pressed={recording}
              disabled={!canRecord}
              title={!track ? '先选中一条轨道' : !pattern ? '先选择一个 pattern' : recording ? '停止录制并写入 pattern' : '开始录制（自动播放）'}
              onClick={toggleRecord}
            >
              <IconRecord size={11} />
              {recording ? '停止录制' : '录制'}
            </button>

            <span
              className={`aims-keyboard-status ${recording ? 'is-recording' : ''}`}
              data-testid="keyboard-status"
              data-recorded={recordedCount}
              role="status"
            >
              <span className={`aims-keyboard-dot ${recording ? 'is-rec' : ''}`} />
              {statusText}
            </span>
          </div>
        </>
      ) : (
        <div className="aims-keyboard-collapsed-hint">
          <span className="aims-keyboard-collapsed-text">键盘面板已折叠</span>
          <button
            type="button"
            className="aims-keyboard-collapsed-btn"
            onClick={() => onToggleExpand?.()}
          >
            展开演奏 / 录制
          </button>
        </div>
      )}
    </section>
  )
})

export default KeyboardPanel
