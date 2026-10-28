/**
 * R5b：采样乐器参数面板（attack/release/filter/LFO）。
 * 选中 synth 轨时显示；修改走 actions.edit updateInstrument，一次手势一次撤销。
 */
import { useEffect, useRef, useState } from 'react'
import { clamp } from './ui.jsx'
import { findSynthInstrument } from '../../shared/catalog.js'

const DEFAULTS = {
  attack: 0.005,
  release: 0.2,
  filterCutoff: 20000,
  filterQ: 0.7,
  lfoRate: 5,
  lfoDepth: 0,
}

const CONTROLS = [
  { key: 'attack', testId: 'instrument-attack', label: 'Attack', min: 0.001, max: 2, step: 0.001, unit: 's' },
  { key: 'release', testId: 'instrument-release', label: 'Release', min: 0.01, max: 4, step: 0.001, unit: 's' },
  { key: 'filterCutoff', testId: 'instrument-filter-cutoff', label: 'Filter', min: 100, max: 20000, step: 1, unit: 'Hz' },
  { key: 'filterQ', testId: 'instrument-filter-q', label: 'Q', min: 0.1, max: 12, step: 0.1, unit: '' },
  { key: 'lfoRate', testId: 'instrument-lfo-rate', label: 'LFO Rate', min: 0.1, max: 12, step: 0.1, unit: 'Hz' },
  { key: 'lfoDepth', testId: 'instrument-lfo-depth', label: 'LFO Depth', min: 0, max: 100, step: 1, unit: 'cents' },
]

const SYNTH_WAVES = ['saw', 'square', 'sine', 'triangle']
const SYNTH_WAVE_LABELS = { saw: '锯齿 Saw', square: '方波 Square', sine: '正弦 Sine', triangle: '三角 Triangle' }
const SYNTH_FALLBACK = Object.freeze({
  wave: 'saw', unison: 1, detuneCents: 0, subLevel: 0, filterCutoff: 3000, filterQ: 0.7,
  attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.25, lfoRate: 5, lfoDepth: 0, level: 0.8,
})
const SYNTH_CONTROLS = [
  { key: 'unison', testId: 'synth-unison', label: 'Unison', min: 1, max: 2, step: 1, unit: '' },
  { key: 'detuneCents', testId: 'synth-detune', label: 'Detune', min: 0, max: 30, step: 0.1, unit: 'cents' },
  { key: 'subLevel', testId: 'synth-sub', label: 'Sub', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'filterCutoff', testId: 'synth-filter-cutoff', label: 'Filter', min: 100, max: 18000, step: 1, unit: 'Hz' },
  { key: 'filterQ', testId: 'synth-filter-q', label: 'Q', min: 0.1, max: 20, step: 0.1, unit: '' },
  { key: 'attack', testId: 'synth-attack', label: 'Attack', min: 0.001, max: 2, step: 0.001, unit: 's' },
  { key: 'decay', testId: 'synth-decay', label: 'Decay', min: 0.005, max: 2, step: 0.001, unit: 's' },
  { key: 'sustain', testId: 'synth-sustain', label: 'Sustain', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'release', testId: 'synth-release', label: 'Release', min: 0.01, max: 4, step: 0.001, unit: 's' },
  { key: 'lfoRate', testId: 'synth-lfo-rate', label: 'LFO Rate', min: 0.1, max: 12, step: 0.1, unit: 'Hz' },
  { key: 'lfoDepth', testId: 'synth-lfo-depth', label: 'LFO Depth', min: 0, max: 100, step: 1, unit: 'cents' },
  { key: 'level', testId: 'synth-level', label: 'Level', min: 0, max: 1, step: 0.01, unit: '' },
]

function synthDefaultsFor(track) {
  const preset = findSynthInstrument(track?.synthPreset)
  return { ...SYNTH_FALLBACK, ...(preset?.synthPreset ?? {}) }
}

function normalizeSynth(track) {
  const source = track?.synthParams && typeof track.synthParams === 'object' ? track.synthParams : {}
  const base = synthDefaultsFor(track)
  const next = { ...base, ...source }
  for (const item of SYNTH_CONTROLS) {
    next[item.key] = clamp(Number(next[item.key]) || 0, item.min, item.max)
  }
  next.wave = SYNTH_WAVES.includes(next.wave) ? next.wave : 'saw'
  return next
}

function formatSynthValue(item, value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (item.key === 'attack' || item.key === 'decay' || item.key === 'release') {
    return number < 1 ? `${Math.round(number * 1000)} ms` : `${number.toFixed(2)} s`
  }
  if (item.key === 'filterCutoff') return number >= 1000 ? `${(number / 1000).toFixed(1)} kHz` : `${Math.round(number)} Hz`
  if (item.key === 'filterQ') return number.toFixed(1)
  if (item.key === 'lfoRate') return `${number.toFixed(1)} Hz`
  if (item.key === 'lfoDepth') return `${Math.round(number)} cents`
  if (item.key === 'detuneCents') return `${number.toFixed(1)} ct`
  if (item.key === 'unison') return `${Math.round(number)}×`
  return `${Math.round(number * 100)}%`
}

function normalizeParams(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const next = { ...DEFAULTS }
  for (const item of CONTROLS) {
    const value = Number(source[item.key])
    if (Number.isFinite(value)) next[item.key] = clamp(value, item.min, item.max)
  }
  return next
}

function formatValue(item, value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  if (item.key === 'attack' || item.key === 'release') {
    return number < 1 ? `${Math.round(number * 1000)} ms` : `${number.toFixed(2)} s`
  }
  if (item.key === 'filterCutoff') {
    return number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 1 : 2)} kHz` : `${Math.round(number)} Hz`
  }
  if (item.key === 'filterQ') return number.toFixed(1)
  if (item.key === 'lfoRate') return `${number.toFixed(1)} Hz`
  return `${Math.round(number)} cents`
}

export function InstrumentPanel({
  project, selectedTrackId, engine = null, onEdit = null, onNotify = null,
}) {
  const track = (project?.tracks ?? []).find((item) => item.id === selectedTrackId) ?? null
  const isSynth = track?.kind === 'synth'
  const trackId = track?.id ?? null
  const paramsKey = JSON.stringify(track?.instrumentParams ?? {})
  const [drafts, setDrafts] = useState(() => normalizeParams(track?.instrumentParams))
  const timerRef = useRef(null)
  const draftsRef = useRef(drafts)
  const isSubtractive = Boolean(isSynth && track?.engine === 'subtractive')
  const synthKey = JSON.stringify({ preset: track?.synthPreset ?? '', params: track?.synthParams ?? {} })
  const [synthDrafts, setSynthDrafts] = useState(() => normalizeSynth(track))
  const synthTimerRef = useRef(null)
  const synthDraftsRef = useRef(synthDrafts)

  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])

  useEffect(() => {
    synthDraftsRef.current = synthDrafts
  }, [synthDrafts])

  useEffect(() => {
    clearTimeout(timerRef.current)
    setDrafts(normalizeParams(track?.instrumentParams))
  }, [trackId, paramsKey])

  useEffect(() => {
    clearTimeout(synthTimerRef.current)
    setSynthDrafts(normalizeSynth(track))
  }, [trackId, synthKey])

  useEffect(() => () => {
    clearTimeout(timerRef.current)
    clearTimeout(synthTimerRef.current)
  }, [])

  const emit = (next, label) => {
    if (typeof onEdit !== 'function') {
      onNotify?.('编辑接口尚未就绪，无法保存乐器参数', 'error')
      return
    }
    onEdit([{ type: 'updateInstrument', trackId, params: next }], label || '调整乐器参数')
  }

  const scheduleCommit = (next) => {
    if (!isSynth || !trackId) return
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => emit(next, '调整乐器参数'), 220)
  }

  const setField = (item, raw) => {
    const value = clamp(Number(raw) || 0, item.min, item.max)
    const next = { ...draftsRef.current, [item.key]: value }
    draftsRef.current = next
    setDrafts(next)
    scheduleCommit(next)
  }

  const emitSynth = (next, label) => {
    if (typeof onEdit !== 'function') {
      onNotify?.('编辑接口尚未就绪，无法保存合成器参数', 'error')
      return
    }
    onEdit([{ type: 'updateSynth', trackId, params: next }], label || '调整合成器参数')
  }

  const scheduleSynthCommit = (next) => {
    if (!isSubtractive || !trackId) return
    clearTimeout(synthTimerRef.current)
    synthTimerRef.current = setTimeout(() => emitSynth(next, '调整合成器参数'), 220)
  }

  const setSynthField = (key, raw, item = null) => {
    const spec = item ?? SYNTH_CONTROLS.find((entry) => entry.key === key)
    const value = spec ? clamp(Number(raw) || 0, spec.min, spec.max) : raw
    const next = { ...synthDraftsRef.current, [key]: value }
    synthDraftsRef.current = next
    setSynthDrafts(next)
    scheduleSynthCommit(next)
  }

  const flushSynth = () => {
    if (!isSubtractive || !trackId) return
    clearTimeout(synthTimerRef.current)
    emitSynth(synthDraftsRef.current, '调整合成器参数')
  }

  const handleReset = () => {
    if (!isSynth || !trackId) return
    if (isSubtractive) {
      clearTimeout(synthTimerRef.current)
      const defaults = synthDefaultsFor(track)
      setSynthDrafts(defaults)
      synthDraftsRef.current = defaults
      if (typeof onEdit !== 'function') {
        onNotify?.('编辑接口尚未就绪，无法重置合成器参数', 'error')
        return
      }
      onEdit([{ type: 'updateSynth', trackId, reset: true }], '重置合成器参数')
      return
    }
    clearTimeout(timerRef.current)
    setDrafts({ ...DEFAULTS })
    draftsRef.current = { ...DEFAULTS }
    if (typeof onEdit !== 'function') {
      onNotify?.('编辑接口尚未就绪，无法重置乐器参数', 'error')
      return
    }
    onEdit([{ type: 'updateInstrument', trackId, reset: true }], '重置乐器参数')
  }

  const handlePreview = () => {
    if (!trackId || !engine || typeof engine.previewNote !== 'function') {
      onNotify?.('试听暂不可用：引擎未就绪或没有选中乐器轨道', 'info')
      return
    }
    try {
      const result = engine.previewNote(trackId, 60, 0.8)
      if (!result) onNotify?.('试听失败：请先点击界面启用音频', 'info')
    } catch (err) {
      onNotify?.('试听失败：音频未解锁或引擎不可用', 'error')
    }
  }

  return (
    <section
      className={`aims-instrument ${isSynth ? 'is-editable' : 'is-idle'}`}
      data-testid="instrument-panel"
      data-track-id={trackId ?? ''}
      data-synth={isSynth ? '1' : '0'}
      data-engine={isSubtractive ? 'subtractive' : 'sampler'}
    >
      <div className="aims-instrument-head">
        <span className="aims-instrument-title">乐器参数</span>
        <span className="aims-instrument-target" title={track?.name ?? '未选中轨道'}>
          {isSubtractive
            ? `${findSynthInstrument(track?.synthPreset)?.label ?? track?.synthPreset ?? '合成器'} · Subtractive`
            : isSynth ? (track?.instrument?.preset ?? track?.name ?? '采样乐器') : (track?.name ?? '未选中')}
        </span>
        <button
          type="button"
          className="aims-instrument-reset"
          data-testid={isSubtractive ? 'synth-reset' : 'instrument-reset'}
          onClick={handleReset}
          title={isSubtractive ? '恢复当前合成器预设默认参数' : '恢复 attack 5ms / release 200ms / cutoff 20k / Q 0.7 / LFO 5Hz depth 0'}
        >重置</button>
        <button
          type="button"
          className="aims-instrument-preview"
          data-testid="instrument-preview"
          title="试听当前乐器的 C4"
          onClick={handlePreview}
        >▶ 试听</button>
      </div>

      {isSynth ? (
        isSubtractive ? (
          <>
            <div className="aims-instrument-wave-row">
              <span className="aims-instrument-label">Wave <b className="aims-instrument-value aims-mono">{SYNTH_WAVE_LABELS[synthDrafts.wave] ?? synthDrafts.wave}</b></span>
              <select
                className="aims-instrument-wave"
                data-testid="synth-wave"
                aria-label="合成器波形"
                value={synthDrafts.wave}
                onChange={(event) => setSynthField('wave', event.target.value)}
              >
                {SYNTH_WAVES.map((wave) => <option key={wave} value={wave}>{SYNTH_WAVE_LABELS[wave] ?? wave}</option>)}
              </select>
            </div>
            <div className="aims-instrument-grid">
              {SYNTH_CONTROLS.map((item) => {
                const value = synthDrafts[item.key] ?? item.min
                const defaults = synthDefaultsFor(track)
                const isDefault = Math.abs(Number(value) - Number(defaults[item.key] ?? item.min)) < 1e-9
                return (
                  <label className={`aims-instrument-field ${isDefault ? '' : 'is-changed'}`} key={item.key}>
                    <span className="aims-instrument-label">
                      {item.label}
                      <b className="aims-instrument-value aims-mono">{formatSynthValue(item, value)}</b>
                    </span>
                    <input
                      type="range"
                      className="aims-instrument-range"
                      data-testid={item.testId}
                      min={item.min}
                      max={item.max}
                      step={item.step}
                      value={value}
                      aria-label={`${item.label}${item.unit ? `（${item.unit}）` : ''}`}
                      onChange={(event) => setSynthField(item.key, event.target.value, item)}
                      onPointerUp={flushSynth}
                      onBlur={flushSynth}
                    />
                  </label>
                )
              })}
            </div>
            <div className="aims-instrument-foot">
              <span className="aims-instrument-hint">Subtractive 合成器 · 默认与当前预设一致 · 拖动后 220ms 保存为一次撤销</span>
            </div>
          </>
        ) : (
          <>
            <div className="aims-instrument-grid">
              {CONTROLS.map((item) => {
                const value = drafts[item.key] ?? DEFAULTS[item.key]
                const isDefault = Math.abs(Number(value) - DEFAULTS[item.key]) < 1e-9
                return (
                  <label className={`aims-instrument-field ${isDefault ? '' : 'is-changed'}`} key={item.key}>
                    <span className="aims-instrument-label">
                      {item.label}
                      <b className="aims-instrument-value aims-mono">{formatValue(item, value)}</b>
                    </span>
                    <input
                      type="range"
                      className="aims-instrument-range"
                      data-testid={item.testId}
                      min={item.min}
                      max={item.max}
                      step={item.step}
                      value={value}
                      aria-label={`${item.label}${item.unit ? `（${item.unit}）` : ''}`}
                      onChange={(event) => setField(item, event.target.value)}
                      onPointerUp={() => {
                        clearTimeout(timerRef.current)
                        emit(draftsRef.current, '调整乐器参数')
                      }}
                      onBlur={() => {
                        clearTimeout(timerRef.current)
                        emit(draftsRef.current, '调整乐器参数')
                      }}
                    />
                  </label>
                )
              })}
            </div>
            <div className="aims-instrument-foot">
              <span className="aims-instrument-hint">默认值与旧工程逐位一致 · 拖动后 220ms 保存为一次撤销</span>
            </div>
          </>
        )
      ) : (
        <div className="aims-instrument-idle-hint">
          {track ? '当前轨道不是采样乐器：选中一条 synth 轨后可编辑包络/滤波/LFO' : '选中一条采样乐器轨道后可编辑包络/滤波/LFO'}
        </div>
      )}
    </section>
  )
}
