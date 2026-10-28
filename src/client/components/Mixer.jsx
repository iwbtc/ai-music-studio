/**
 * 中栏：混音台（P2b 增加侧链压缩配置）。
 *
 * 每条轨道一个通道条：彩色顶条 / 名称 / FX 槽 / PAN 旋钮（可拖）/ 发送旋钮（只读）/
 * 推子（可拖，actions.setVolume）/ 实时电平表 + master 条；
 * P2b：SC 按钮打开侧链弹层（启用、来源轨道、amount/attack/release、清除）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BUSES, findFxType } from '../../shared/catalog.js'
import { BUS_DEFAULTS, SIDECHAIN_DEFAULTS, SIDECHAIN_RANGES } from '../../shared/model.js'
import { LevelMeter, MeterReadout, Knob, Switch, Slider, clamp, pad, roleLabel } from './ui.jsx'
import { findSynthInstrument } from '../../shared/catalog.js'
import { palette } from '../theme.js'
import { fetchExternalFreezeStatuses, freezeExternalPlugin, freezeInfoFor, freezeStatusLabel, unfreezeExternalPlugin } from './ExternalPluginPanel.jsx'

/** 侧链默认值与合法范围（与 host / shared model 保持单一来源）。 */
const SC_DEFAULTS = { ...SIDECHAIN_DEFAULTS, triggerNotes: [] }
const SC_RANGES = SIDECHAIN_RANGES
const numberOr = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** R0 触发音高：去重、排序、只保留 0..127 整数；空数组 = 全部音高。 */
function normalizeTriggerNotes(raw) {
  if (!Array.isArray(raw)) return []
  const notes = raw
    .map((note) => Number(note))
    .filter((note) => Number.isInteger(note) && note >= 0 && note <= 127)
  return [...new Set(notes)].sort((a, b) => a - b)
}

function formatTriggerNotes(notes) {
  const list = normalizeTriggerNotes(notes)
  return list.length === 0 ? '' : list.join(', ')
}

function triggerNotesLabel(notes) {
  const list = normalizeTriggerNotes(notes)
  if (list.length === 0) return '全部音高'
  if (list.length === 1 && list[0] === 36) return '只底鼓 36'
  return list.join(', ')
}

/** 读取并规范化一条轨道的侧链配置（非法来源/自引用 → 视为无来源）。 */
function readSidechain(track, tracks) {
  const raw = track?.sidechain && typeof track.sidechain === 'object' ? track.sidechain : null
  if (!raw) return { ...SC_DEFAULTS }
  const sourceTrackId = raw.sourceTrackId
    && raw.sourceTrackId !== track.id
    && (tracks ?? []).some((item) => item.id === raw.sourceTrackId)
    ? raw.sourceTrackId
    : null
  return {
    enabled: raw.enabled !== false && Boolean(sourceTrackId),
    sourceTrackId,
    amount: clamp(numberOr(raw.amount, SC_DEFAULTS.amount), ...SC_RANGES.amount),
    attack: clamp(numberOr(raw.attack, SC_DEFAULTS.attack), ...SC_RANGES.attack),
    release: clamp(numberOr(raw.release, SC_DEFAULTS.release), ...SC_RANGES.release),
    triggerNotes: normalizeTriggerNotes(raw.triggerNotes),
  }
}

function Fader({ value = 0, color = palette.coral, onChange, onCommit, title, readOnly = false, testId }) {
  const ref = useRef(null)
  const dragging = useRef(false)
  const lastRef = useRef(null)

  const emit = (clientY) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const v = clamp(1 - (clientY - rect.top) / Math.max(1, rect.height), 0, 1)
    lastRef.current = v
    onChange?.(v)
  }

  const onPointerDown = (e) => {
    if (readOnly) return
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    lastRef.current = Number(value) || 0
    e.currentTarget.setPointerCapture?.(e.pointerId)
    emit(e.clientY)
  }
  const onPointerMove = (e) => {
    if (!dragging.current) return
    emit(e.clientY)
  }
  const onPointerUp = (e) => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (lastRef.current != null) {
      onCommit?.(lastRef.current)
      lastRef.current = null
    }
  }

  const percent = clamp(value) * 100
  return (
    <div
      className={`aims-fader ${readOnly ? 'is-readonly' : ''}`}
      ref={ref}
      data-testid={testId}
      data-value={Number(clamp(value)).toFixed(3)}
      title={title ?? `音量 ${Math.round(percent)}%${readOnly ? '（由 AI 控制）' : '（上下拖动）'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="aims-fader-rail" />
      <div className="aims-fader-fill" style={{ height: `${percent}%`, background: color }} />
      <div className="aims-fader-thumb" style={{ bottom: `calc(${percent}% - 6px)` }}>
        <span style={{ background: color }} />
      </div>
      <div className="aims-fader-ticks" aria-hidden="true">
        {[0, 25, 50, 75, 100].map((tick) => <span key={tick} style={{ bottom: `${tick}%` }} />)}
      </div>
    </div>
  )
}

/** 可拖动发送量旋钮：拖动中本地草稿，松手一次 onCommit。 */
function SendKnob({ label, value, color, title, testId, onCommit }) {
  const hostValue = clamp(Number(value) || 0)
  const [draft, setDraft] = useState(null)
  useEffect(() => {
    setDraft(null)
  }, [hostValue])
  const current = draft == null ? hostValue : draft
  return (
    <Knob
      value={current}
      min={0}
      max={1}
      label={label}
      display={`${Math.round(current * 100)}`}
      color={color}
      size={24}
      thin
      interactive
      testId={testId}
      title={title}
      onChange={(next) => setDraft(next)}
      onCommit={(next) => {
        setDraft(next)
        onCommit?.(next)
      }}
    />
  )
}

/** 返回总线（Reverb / Delay）归一化（兼容旧工程的数字形式）。 */
function normalizeBusEntry(raw, busId) {
  const fallbackLevel = BUS_DEFAULTS[busId]?.level ?? 0
  if (typeof raw === 'number') return { level: clamp(raw, 0, 1), effects: [] }
  return {
    level: clamp(numberOr(raw?.level, fallbackLevel), 0, 1),
    effects: Array.isArray(raw?.effects) ? raw.effects : [],
  }
}

/** 返回总线展示名（catalog 里叫「混响发送」，Mixer 显示为「混响返回」）。 */
function busDisplayName(busDef) {
  return busDef?.name ? busDef.name.replace('发送', '返回') : (busDef?.id ?? '返回')
}

/** 返回总线通道条：返回电平可拖动 + FX 数量，点击选中（供效果器视图联动）。 */
function BusStrip({ busId, bus, busDef, incoming = 0, selected, onSelect, onEditOp }) {
  const level = clamp(Number(bus?.level) || 0)
  const effects = bus?.effects ?? []
  const color = busDef?.color ?? palette.mint
  const [draft, setDraft] = useState(null)
  useEffect(() => {
    setDraft(null)
  }, [level])
  const current = draft == null ? level : draft
  const percent = Math.round(current * 100)
  return (
    <div
      className={`aims-strip aims-strip--bus ${selected ? 'is-selected-bus' : ''}`}
      style={{ '--strip-color': color }}
      data-bus-id={busId}
      title={`${busDisplayName(busDef)}总线：返回电平 ${percent}% · ${effects.length} 个效果器`}
      onClick={() => onSelect?.(busId)}
    >
      <span className="aims-strip-color" />
      <div className="aims-strip-top">
        <span className="aims-strip-index aims-mono">R</span>
        <span className="aims-strip-role">返回</span>
      </div>
      <div className="aims-strip-name" title={busDisplayName(busDef)}>{busDisplayName(busDef)}</div>

      <div className="aims-strip-fx">
        {effects.length === 0 ? (
          <span className="aims-fxslot is-empty">+ FX</span>
        ) : (
          <>
            {effects.slice(0, 2).map((fx) => <FxSlot key={fx.id} type={fx.type} effect={fx} />)}
            {effects.length > 2 ? <span className="aims-strip-fx-more">+{effects.length - 2}</span> : null}
          </>
        )}
      </div>

      <div className="aims-strip-knobs aims-strip-knobs--bus">
        <span className="aims-strip-bus-badge" title={`返回总线 FX：${effects.length} 个`}>
          FX <b className="aims-mono">{effects.length}</b>
        </span>
        <span className="aims-strip-bus-sendsum" title="该总线接收的发送总量（各轨发送量之和）">
          入 <b className="aims-mono">{Math.round(clamp(incoming) * 100)}</b>
        </span>
      </div>

      <div className="aims-strip-body">
        <Fader
          value={current}
          color={color}
          testId={`bus-level-${busId}`}
          title={`${busDisplayName(busDef)}电平 ${percent}%（上下拖动）`}
          onChange={(next) => setDraft(next)}
          onCommit={(next) => {
            setDraft(next)
            onEditOp?.({ type: 'setBus', busId, level: next }, '调整返回总线')
          }}
        />
        <div className="aims-strip-meter aims-strip-meter--bus">
          <span className="aims-bus-fx-count aims-mono">{effects.length} FX</span>
        </div>
      </div>

      <div className="aims-strip-value aims-mono" title="返回电平（0–100）">{percent}</div>

      <div className="aims-strip-flags">
        <span className="aims-strip-bus-tag">RET</span>
      </div>
    </div>
  )
}

function FxSlot({ type, effect = null }) {
  const vst3 = type === 'vst3' ? effect?.vst3 ?? null : null
  const def = findFxType(type)
  const deskPreload = typeof window !== 'undefined' && Boolean(window.aimsPlugins)
  const name = vst3
    ? `VST3 · ${vst3.name ?? vst3.pluginId ?? '外部插件'}`
    : (def?.name ?? type)
  return (
    <span className={`aims-fxslot ${vst3?.missing ? 'is-missing' : ''}`} title={`${name} · ${def?.label ?? ''}`} data-testid={vst3 ? 'fxslot-vst3' : undefined}>
      <span className="aims-fxslot-dot" style={{ background: def?.color ?? (vst3 ? '#4FA3A5' : palette.muted) }} />
      <span className="aims-fxslot-name">{name}</span>
      {vst3 ? (
        <span className={`aims-fxslot-vst3-tag ${deskPreload ? 'is-live' : ''}`} data-testid="fxslot-vst3-live">
          {vst3.missing ? 'missing' : deskPreload ? '实时' : '桌面版'}
        </span>
      ) : null}
    </span>
  )
}

/** R4b：手动 PDC 毫秒输入（失焦/回车提交，0..500，1 位小数）。 */
function PdcField({ testId, value, onCommit, label = 'PDC', title = '手动延迟补偿（0..500 ms，失焦提交）' }) {
  const [draft, setDraft] = useState(() => String(Number(value) || 0))
  const timerRef = useRef(null)
  useEffect(() => { setDraft(String(Number(value) || 0)) }, [value])
  useEffect(() => () => clearTimeout(timerRef.current), [])
  const commit = (event) => {
    clearTimeout(timerRef.current)
    /* 失焦时优先读 DOM 当前值：自动化（value setter + 同 tick blur）也能拿到最新输入。 */
    const raw = event?.target?.value ?? draft
    const parsed = Math.round(clamp(Number(raw) || 0, 0, 500) * 10) / 10
    setDraft(String(parsed))
    if (parsed !== (Number(value) || 0)) onCommit?.(parsed)
  }
  /* 输入后 400ms 自动提交（E2E / 无失焦场景；同一手势合并为一次撤销）。 */
  useEffect(() => {
    if (draft === '' || Math.abs((Number(draft) || 0) - (Number(value) || 0)) < 0.0001) return undefined
    clearTimeout(timerRef.current)
    const parsed = Math.round(clamp(Number(draft) || 0, 0, 500) * 10) / 10
    timerRef.current = setTimeout(() => {
      if (parsed !== (Number(value) || 0)) onCommit?.(parsed)
    }, 400)
    return () => clearTimeout(timerRef.current)
  }, [draft, value, onCommit])
  return (
    <label className="aims-strip-pdc" title={title} onClick={(event) => event.stopPropagation()}>
      <span className="aims-strip-pdc-label">{label}</span>
      <input
        type="number"
        className="aims-strip-pdc-input aims-mono"
        data-testid={testId}
        min={0}
        max={500}
        step={0.1}
        value={draft}
        aria-label={title}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <span className="aims-strip-pdc-unit">ms</span>
    </label>
  )
}

/** R4a：Group 通道条（轨道输出编组；FX/电平/M/S/输入数）。 */
function GroupStrip({ group, inputs = 0, inputTrackIds = [], selected, engine, onSelect, onEditOp, onNotify }) {
  const level = clamp(Number(group?.level) || 0)
  const effects = group?.effects ?? []
  const color = palette.teal
  const [draft, setDraft] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => { setDraft(null) }, [level])
  const current = draft == null ? level : draft
  const percent = Math.round(current * 100)
  return (
    <div
      className={`aims-strip aims-strip--group ${selected ? 'is-selected-group' : ''}`}
      style={{ '--strip-color': color }}
      data-group-id={group.id}
      data-testid={`group-strip-${group.id}`}
      title={`编组 ${group.name}：输出到 Master · ${inputs} 条输入轨 · ${effects.length} 个效果器`}
      onClick={() => onSelect?.(group.id)}
    >
      <span className="aims-strip-color" />
      <div className="aims-strip-top">
        <span className="aims-strip-index aims-mono">G</span>
        <span className="aims-strip-role">编组</span>
      </div>
      <div className="aims-strip-name" title={group.name}>{group.name}</div>

      <div className="aims-strip-fx">
        {effects.length === 0 ? (
          <span className="aims-fxslot is-empty">+ FX</span>
        ) : (
          <>
            {effects.slice(0, 2).map((fx) => <FxSlot key={fx.id} type={fx.type} effect={fx} />)}
            {effects.length > 2 ? <span className="aims-strip-fx-more">+{effects.length - 2}</span> : null}
          </>
        )}
      </div>

      <div className="aims-strip-knobs aims-strip-knobs--bus">
        <span className="aims-strip-bus-badge" title={`编组 FX：${effects.length} 个`}>FX <b className="aims-mono">{effects.length}</b></span>
        <span className="aims-strip-bus-sendsum" title="输入到该编组的轨道数">入 <b className="aims-mono">{inputs}</b></span>
      </div>

      <div className="aims-strip-body">
        <Fader
          value={current}
          color={color}
          testId={`group-level-${group.id}`}
          title={`${group.name} 编组电平 ${percent}%（上下拖动）`}
          onChange={(next) => setDraft(next)}
          onCommit={(next) => {
            setDraft(next)
            onEditOp?.({ type: 'updateGroup', groupId: group.id, level: next }, '调整编组电平')
          }}
        />
        <div className="aims-strip-meter aims-strip-meter--bus">
          <span className="aims-bus-fx-count aims-mono">{effects.length} FX</span>
          <MeterReadout
            engine={engine}
            groupId={group.id}
            fallbackTrackIds={inputTrackIds}
            meterId={`meter-group-${group.id}`}
            title={`${group.name} 编组实时 peak dB`}
          />
        </div>
      </div>

      <div className="aims-strip-value aims-mono" title="编组电平（0–100）">{percent}</div>

      <PdcField
        testId={`group-pdc-${group.id}`}
        value={group.pdcMs ?? 0}
        label="PDC"
        title="编组手动延迟补偿（0..500 ms，失焦提交）"
        onCommit={(next) => onEditOp?.({ type: 'updateGroup', groupId: group.id, pdcMs: next }, '调整编组 PDC')}
      />

      <div className="aims-strip-flags">
        <button
          type="button"
          className={`aims-strip-flag aims-strip-flag--bypass ${group.bypassFx ? 'is-on is-bypass' : ''}`}
          data-testid={`group-bypass-${group.id}`}
          aria-pressed={Boolean(group.bypassFx)}
          title={group.bypassFx ? '取消编组 FX 旁路' : '旁路编组 FX 链（直通）'}
          onClick={(event) => { event.stopPropagation(); onEditOp?.({ type: 'updateGroup', groupId: group.id, bypassFx: !group.bypassFx }, '切换编组 FX 旁路') }}
        >BYP</button>
        <button
          type="button"
          className={`aims-strip-flag aims-strip-flag--mute ${group.mute ? 'is-on is-mute' : ''}`}
          data-testid={`group-mute-${group.id}`}
          aria-pressed={Boolean(group.mute)}
          title={group.mute ? '取消编组静音' : '编组静音（其下轨道无声）'}
          onClick={(event) => { event.stopPropagation(); onEditOp?.({ type: 'updateGroup', groupId: group.id, mute: !group.mute }, '切换编组静音') }}
        >M</button>
        <button
          type="button"
          className={`aims-strip-flag aims-strip-flag--solo ${group.solo ? 'is-on is-solo' : ''}`}
          data-testid={`group-solo-${group.id}`}
          aria-pressed={Boolean(group.solo)}
          title={group.solo ? '取消编组 Solo' : '编组 Solo（仅该组可听）'}
          onClick={(event) => { event.stopPropagation(); onEditOp?.({ type: 'updateGroup', groupId: group.id, solo: !group.solo }, '切换编组 Solo') }}
        >S</button>
        <button
          type="button"
          className={`aims-group-remove ${confirmRemove ? 'is-confirm' : ''}`}
          data-testid={`group-remove-${group.id}`}
          title={confirmRemove ? '再次点击确认删除编组（轨道将回到 Master）' : '删除编组'}
          onClick={(event) => {
            event.stopPropagation()
            if (!confirmRemove) {
              setConfirmRemove(true)
              onNotify?.('再点一次确认删除编组（轨道会回到 Master）', 'info')
              return
            }
            setConfirmRemove(false)
            onEditOp?.({ type: 'removeGroup', groupId: group.id }, '删除编组')
          }}
        >{confirmRemove ? '确认' : '×'}</button>
      </div>
    </div>
  )
}

function ChannelStrip({
  track, tracks, groups = [], index, selected, engine, sidechain, freezeInfo = null, freezeBusy = false, onFreeze,
  onSelect, onVolume, onPan,
  onToggleMute, onToggleSolo, onOpenSidechain, onEditOp,
}) {
  const effects = track.effects ?? []
  const vst3 = track.engine === 'vst3' || track.vst3 ? track.vst3 : null
  const synthInstrument = track.kind === 'synth' && !vst3 && (track.engine === 'subtractive' || (!track.instrument?.preset && track.synthPreset))
    ? findSynthInstrument(track.synthPreset ?? track.instrument?.preset)
    : null
  const instrumentLabel = vst3
    ? (vst3.missing === true ? 'VST3 乐器 · missing' : `VST3 乐器 · ${vst3.name ?? vst3.pluginId ?? '外部插件'}`)
    : (synthInstrument?.label ?? synthInstrument?.name ?? '')
  const hasVst3 = Boolean(vst3) || (track.effects ?? []).some((fx) => fx?.type === 'vst3')
  const vst3MissingAny = vst3?.missing === true || (track.effects ?? []).some((fx) => fx?.type === 'vst3' && fx?.vst3?.missing === true)
  const freezeCurrent = freezeInfo?.status === 'current'
  const sourceName = sidechain?.sourceTrackId
    ? (tracks ?? []).find((item) => item.id === sidechain.sourceTrackId)?.name ?? sidechain.sourceTrackId
    : ''
  return (
    <div
      className={`aims-strip ${selected ? 'is-selected' : ''} ${track.mute ? 'is-muted' : ''}`}
      style={{ '--strip-color': track.color }}
      title={`${track.name} · ${roleLabel(track.role)}${instrumentLabel ? ` · ${instrumentLabel}` : ''}`}
      data-synth-label={instrumentLabel || undefined}
      data-testid={vst3 ? 'strip-vst3-track' : undefined}
      data-vst3-missing={vst3?.missing === true ? 'true' : undefined}
      onClick={() => onSelect?.(track.id)}
    >
      <span className="aims-strip-color" />
      <div className="aims-strip-top">
        <span className="aims-strip-index aims-mono">{pad(index + 1)}</span>
        <span className="aims-strip-role">{roleLabel(track.role)}</span>
      </div>
      <div className="aims-strip-name" title={track.name}>{track.name}</div>
      {instrumentLabel ? <div className={`aims-strip-instrument ${vst3 ? 'is-vst3' : ''} ${vst3?.missing ? 'is-missing' : ''}`} data-testid={vst3 ? 'strip-vst3-label' : 'strip-synth-label'} title={instrumentLabel}>{instrumentLabel}</div> : null}
      {hasVst3 ? (
        <div className="aims-strip-freeze">
          <button
            type="button"
            className={`aims-strip-freeze-btn ${freezeCurrent ? 'is-on' : ''}`}
            data-testid={`plugin-freeze-mix-${track.id}`}
            disabled={freezeBusy || vst3MissingAny || freezeInfo?.status === 'freezing'}
            title={vst3MissingAny ? '插件文件缺失，无法冻结' : (freezeCurrent ? '解冻并恢复实时插件' : (freezeInfo?.status === 'stale' ? '重新冻结（内容已修改）' : '离线冻结为音频缓存'))}
            onClick={(event) => { event.stopPropagation(); onFreeze?.() }}
          >
            F
          </button>
          <span
            className={`aims-strip-freeze-status is-${freezeInfo?.status ?? 'unfrozen'}`}
            data-testid={`freeze-status-mix-${track.id}`}
            data-status={freezeInfo?.status ?? 'unfrozen'}
            title={freezeInfo?.error ?? '冻结状态'}
          >{vst3MissingAny ? '不可冻结' : freezeStatusLabel(freezeInfo?.status)}</span>
        </div>
      ) : null}

      <div className="aims-strip-fx">
        {effects.length === 0 ? (
          <span className="aims-fxslot is-empty">+ FX</span>
        ) : (
          <>
            {effects.slice(0, 3).map((fx) => <FxSlot key={fx.id} type={fx.type} effect={fx} />)}
            {effects.length > 3 ? <span className="aims-strip-fx-more" title={effects.slice(3).map((fx) => findFxType(fx.type)?.name).join(' / ')}>+{effects.length - 3}</span> : null}
          </>
        )}
      </div>

      <label className="aims-strip-output" title="轨道输出：Master 或编组（Group）" onClick={(event) => event.stopPropagation()}>
        <span className="aims-strip-output-label">OUT</span>
        <select
          className="aims-strip-output-select"
          data-testid={`track-output-${track.id}`}
          aria-label={`${track.name} 输出`}
          value={track.output ?? 'master'}
          onChange={(event) => onEditOp?.({ type: 'setTrackOutput', trackId: track.id, output: event.target.value }, '设置轨道输出')}
        >
          <option value="master">Master</option>
          {(groups ?? []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
      </label>

      <label className={`aims-strip-automode ${track.automationMode && track.automationMode !== 'read' ? 'is-armed' : ''}`} title="自动化模式：READ 只读；TOUCH/LATCH/WRITE 本轮统一为「播放中改音量/声像即写当前 beat」（Touch/Latch 手势细化留后续）" onClick={(event) => event.stopPropagation()}>
        <span className="aims-strip-output-label">AUTO</span>
        <select
          className="aims-strip-output-select"
          data-testid={`track-automation-${track.id}`}
          aria-label={`${track.name} 自动化模式`}
          value={track.automationMode ?? 'read'}
          onChange={(event) => onEditOp?.({ type: 'updateTrack', trackId: track.id, automationMode: event.target.value }, '设置自动化模式')}
        >
          <option value="read">READ</option>
          <option value="touch">TOUCH</option>
          <option value="latch">LATCH</option>
          <option value="write">WRITE</option>
        </select>
      </label>

      <div className="aims-strip-chan" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className={`aims-chan-btn ${track.phaseInvert ? 'is-on is-phase' : ''}`}
          data-testid={`track-phase-${track.id}`}
          aria-pressed={Boolean(track.phaseInvert)}
          title={track.phaseInvert ? '取消相位反转（Ø）' : '相位反转 Ø（输出 × −1）'}
          onClick={() => onEditOp?.({ type: 'updateTrack', trackId: track.id, phaseInvert: !track.phaseInvert }, '切换相位反转')}
        >Ø</button>
        <button
          type="button"
          className={`aims-chan-btn ${track.mono ? 'is-on is-mono' : ''}`}
          data-testid={`track-mono-${track.id}`}
          aria-pressed={Boolean(track.mono)}
          title={track.mono ? '取消单声道下混' : '单声道下混（L/R 各 0.5 求和）'}
          onClick={() => onEditOp?.({ type: 'updateTrack', trackId: track.id, mono: !track.mono }, '切换单声道')}
        >MONO</button>
        <button
          type="button"
          className={`aims-chan-btn ${track.bypassFx ? 'is-on is-bypass' : ''}`}
          data-testid={`track-bypass-${track.id}`}
          aria-pressed={Boolean(track.bypassFx)}
          title={track.bypassFx ? '取消 FX 旁路' : '旁路该轨 FX 链（直通）'}
          onClick={() => onEditOp?.({ type: 'updateTrack', trackId: track.id, bypassFx: !track.bypassFx }, '切换 FX 旁路')}
        >BYP</button>
        <button
          type="button"
          className={`aims-chan-btn aims-chan-btn--send ${track.sendMode === 'pre' ? 'is-on is-pre' : ''}`}
          data-testid={`track-sendmode-${track.id}`}
          aria-pressed={track.sendMode === 'pre'}
          title={`发送点：${track.sendMode === 'pre' ? 'PRE（FX 前、轨道音量后）' : 'POST（FX 后）'}，点击切换`}
          onClick={() => onEditOp?.({ type: 'updateTrack', trackId: track.id, sendMode: track.sendMode === 'pre' ? 'post' : 'pre' }, '切换发送点')}
        >{track.sendMode === 'pre' ? 'PRE' : 'POST'}</button>
      </div>

      <PdcField
        testId={`track-pdc-${track.id}`}
        value={track.pdcMs ?? 0}
        label="PDC"
        title="轨道手动延迟补偿（0..500 ms，失焦提交）"
        onCommit={(next) => onEditOp?.({ type: 'updateTrack', trackId: track.id, pdcMs: next }, '调整轨道 PDC')}
      />

      <div className="aims-strip-knobs">
        <div className="aims-strip-knob-pan">
          <Knob
            value={track.pan ?? 0}
            min={-1}
            max={1}
            label="PAN"
            display={panLabel(track.pan ?? 0)}
            color={track.color}
            size={32}
            interactive
            title="声像（拖动旋钮）"
            onChange={(v) => onPan?.(track.id, v)}
          />
        </div>
        <div className="aims-strip-sends">
          <SendKnob
            label="REV"
            value={track.sends?.reverb ?? 0}
            color={palette.mint}
            testId={`send-reverb-${track.id}`}
            title={`混响发送 ${Math.round((track.sends?.reverb ?? 0) * 100)}%（拖动旋钮，松手写回）`}
            onCommit={(next) => onEditOp?.({ type: 'setTrackSends', trackId: track.id, reverb: next }, '调整发送')}
          />
          <SendKnob
            label="DLY"
            value={track.sends?.delay ?? 0}
            color={palette.teal}
            testId={`send-delay-${track.id}`}
            title={`延迟发送 ${Math.round((track.sends?.delay ?? 0) * 100)}%（拖动旋钮，松手写回）`}
            onCommit={(next) => onEditOp?.({ type: 'setTrackSends', trackId: track.id, delay: next }, '调整发送')}
          />
        </div>
      </div>

      {sidechain?.enabled ? (
        <div className="aims-strip-sc-info" title={`侧链：${sourceName} → ${track.name} · 深度 ${Math.round(sidechain.amount * 100)}% · 触发 ${triggerNotesLabel(sidechain.triggerNotes)}`}>
          <span className="aims-strip-sc-info-dot" />
          <span className="aims-strip-sc-info-text">SC ← {sourceName}{normalizeTriggerNotes(sidechain.triggerNotes).length > 0 ? ` · ${triggerNotesLabel(sidechain.triggerNotes)}` : ''}</span>
          <span className="aims-strip-sc-info-pct aims-mono">{Math.round(sidechain.amount * 100)}%</span>
        </div>
      ) : null}

      <div className="aims-strip-body">
        <Fader
          value={track.volume ?? 0}
          color={track.color}
          onChange={(v) => onVolume?.(track.id, v)}
        />
        <div className="aims-strip-meter">
          <LevelMeter engine={engine} trackId={track.id} />
          <MeterReadout
            engine={engine}
            trackId={track.id}
            meterId={`meter-track-${track.id}`}
            title={`${track.name} 实时 peak dB`}
          />
        </div>
      </div>

      <div className="aims-strip-value aims-mono" title="推子位置（0–100）">{Math.round((track.volume ?? 0) * 100)}</div>

      <div className="aims-strip-flags">
        <button
          type="button"
          className={`aims-strip-flag aims-strip-flag--sc ${sidechain?.enabled ? 'is-sc' : ''}`}
          title={sidechain?.enabled ? `侧链：来源 ${sourceName} · 深度 ${Math.round(sidechain.amount * 100)}% · 触发 ${triggerNotesLabel(sidechain.triggerNotes)}（点击编辑）` : '配置侧链压缩（来源轨触发时压低本轨音量）'}
          aria-label={`${sidechain?.enabled ? '编辑' : '添加'}侧链：${track.name}`}
          aria-pressed={Boolean(sidechain?.enabled)}
          data-testid={`sc-button-${track.id}`}
          data-sc-enabled={sidechain?.enabled ? '1' : '0'}
          onClick={(e) => { e.stopPropagation(); onOpenSidechain?.(track.id, e.currentTarget) }}
        >
          SC
          <span className="aims-strip-flag-dot" />
        </button>
        <button
          type="button"
          className={`aims-strip-flag ${track.mute ? 'is-mute' : ''}`}
          title="静音"
          aria-label={`${track.mute ? '取消静音' : '静音'}：${track.name}`}
          aria-pressed={Boolean(track.mute)}
          onClick={(e) => { e.stopPropagation(); onToggleMute?.(track.id) }}
        >M</button>
        <button
          type="button"
          className={`aims-strip-flag ${track.solo ? 'is-solo' : ''}`}
          title="独奏"
          aria-label={`${track.solo ? '取消独奏' : '独奏'}：${track.name}`}
          aria-pressed={Boolean(track.solo)}
          onClick={(e) => { e.stopPropagation(); onToggleSolo?.(track.id) }}
        >S</button>
      </div>
    </div>
  )
}

function MasterStrip({ project, engine }) {
  const master = project?.master ?? { volume: 0.8, effects: [] }
  const effects = master.effects ?? []
  return (
    <div className="aims-strip aims-strip--master" title="Master 总线：所有轨道汇总输出">
      <span className="aims-strip-color" />
      <div className="aims-strip-top">
        <span className="aims-strip-index aims-mono">M</span>
        <span className="aims-strip-role">总输出</span>
      </div>
      <div className="aims-strip-name">Master</div>

      <div className="aims-strip-fx">
        {effects.length === 0 ? <span className="aims-fxslot is-empty">无 FX</span> : (
          <>
            {effects.slice(0, 3).map((fx) => <FxSlot key={fx.id} type={fx.type} effect={fx} />)}
            {effects.length > 3 ? <span className="aims-strip-fx-more">+{effects.length - 3}</span> : null}
          </>
        )}
      </div>

      <div className="aims-strip-knobs aims-strip-knobs--master">
        <span className="aims-strip-bus-hint" title="返回总线在 Master 左侧的 R 通道条上编辑">
          返回总线 → 左侧 R 条
        </span>
      </div>

      <div className="aims-strip-body">
        <Fader value={master.volume ?? 0} color={palette.ink} readOnly title="Master 音量（由 AI 控制）" />
        <div className="aims-strip-meter">
          <LevelMeter engine={engine} />
          <MeterReadout
            engine={engine}
            meterId="meter-master"
            showLufs
            lufsTestId="master-lufs"
            title="Master 实时 peak dB / LUFS≈（播放时更新）"
          />
        </div>
      </div>

      <div className="aims-strip-value aims-mono">{Math.round((master.volume ?? 0) * 100)}</div>
      <div className="aims-strip-flags">
        <span className="aims-strip-master-tag">OUT</span>
      </div>
    </div>
  )
}

function panLabel(pan) {
  const v = Number(pan) || 0
  if (Math.abs(v) < 0.02) return 'C'
  return v < 0 ? `L${Math.round(Math.abs(v) * 100)}` : `R${Math.round(v * 100)}`
}

/** 侧链弹层：启用 / 来源轨道 / amount / attack / release / 清除。 */
function SidechainPopover({
  track, tracks, sidechain, initial, position, onEditOp, onNotify, onClose,
}) {
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const popoverRef = useRef(null)
  const draftRef = useRef(initial)
  const [draft, setDraft] = useState(initial)
  const [triggerNotesText, setTriggerNotesText] = useState(() => formatTriggerNotes(initial?.triggerNotes))
  const [triggerNotesError, setTriggerNotesError] = useState('')
  const timerRef = useRef(null)

  const commitNow = useCallback((nextDraft, label) => {
    clearTimeout(timerRef.current)
    timerRef.current = null
    const next = nextDraft ?? draftRef.current
    if (!next) return
    if (!next.sourceTrackId) {
      onEditOp?.({ type: 'clearSidechain', trackId: track.id }, label || '清除侧链')
      return
    }
    onEditOp?.({
      type: 'setSidechain',
      trackId: track.id,
      sourceTrackId: next.sourceTrackId,
      amount: clamp(numberOr(next.amount, SC_DEFAULTS.amount), ...SC_RANGES.amount),
      attack: clamp(numberOr(next.attack, SC_DEFAULTS.attack), ...SC_RANGES.attack),
      release: clamp(numberOr(next.release, SC_DEFAULTS.release), ...SC_RANGES.release),
      triggerNotes: normalizeTriggerNotes(next.triggerNotes),
      enabled: Boolean(next.enabled && next.sourceTrackId),
    }, label || '设置侧链')
  }, [onEditOp, track.id])

  const scheduleCommit = useCallback((nextDraft, delay = 180) => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      commitNow(nextDraft, '调整侧链')
    }, delay)
  }, [commitNow])

  const updateDraft = useCallback((patch, { debounce = true } = {}) => {
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraft(next)
    if (debounce) scheduleCommit(next)
    return next
  }, [scheduleCommit])

  // 弹层位置：优先放在 SC 按钮下方；空间不足则放上方；渲染后再做一次视口内修正
  useEffect(() => {
    const el = popoverRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let dx = 0
    let dy = 0
    if (rect.bottom > vh - 8) dy = vh - 8 - rect.bottom
    if (rect.top + dy < 8) dy = 8 - rect.top
    if (rect.right > vw - 8) dx = vw - 8 - rect.right
    if (rect.left + dx < 8) dx = 8 - rect.left
    if (dx !== 0 || dy !== 0) el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`
  })

  // 关闭时清掉未提交的 debounce
  useEffect(() => () => clearTimeout(timerRef.current), [])

  // 点外部 / Esc / 滚动 关闭
  useEffect(() => {
    const onPointerDown = (event) => {
      if (popoverRef.current && popoverRef.current.contains(event.target)) return
      if (event.target instanceof Element && event.target.closest('[data-testid^="sc-button-"]')) return
      onClose?.()
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    const onScroll = () => onClose?.()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  const sourceOptions = (tracks ?? []).filter((item) => item.id !== track.id)
  const sourceName = draft.sourceTrackId
    ? (tracks ?? []).find((item) => item.id === draft.sourceTrackId)?.name ?? draft.sourceTrackId
    : '未选择'
  const active = Boolean(draft.enabled && draft.sourceTrackId)

  const handleToggle = (checked) => {
    if (checked && !draftRef.current.sourceTrackId) {
      const fallback = sourceOptions[0]?.id ?? null
      if (!fallback) {
        onNotify?.('工程里还没有其它轨道可以作为侧链来源', 'info')
        return
      }
      const next = updateDraft({ enabled: true, sourceTrackId: fallback }, { debounce: false })
      commitNow(next, '设置侧链')
      return
    }
    const next = updateDraft({ enabled: checked }, { debounce: false })
    if (next.sourceTrackId) commitNow(next, checked ? '启用侧链' : '禁用侧链')
  }

  const handleSource = (value) => {
    clearTimeout(timerRef.current)
    timerRef.current = null
    if (!value) {
      const next = { ...draftRef.current, sourceTrackId: null, enabled: false }
      draftRef.current = next
      setDraft(next)
      onEditOp?.({ type: 'clearSidechain', trackId: track.id }, '清除侧链')
      return
    }
    const next = { ...draftRef.current, sourceTrackId: value, enabled: true }
    draftRef.current = next
    setDraft(next)
    commitNow(next, '设置侧链')
  }

  const handleClear = () => {
    clearTimeout(timerRef.current)
    timerRef.current = null
    const next = { ...SC_DEFAULTS }
    draftRef.current = next
    setDraft(next)
    setTriggerNotesText('')
    setTriggerNotesError('')
    onEditOp?.({ type: 'clearSidechain', trackId: track.id }, '清除侧链')
    onNotify?.('已清除侧链（Ctrl+Z 可撤销）', 'info')
  }

  /* R0 侧链 UI：触发音高（MIDI 0..127；空 = 全部音高） */
  const parseTriggerNotes = (rawText) => {
    const text = String(rawText ?? '').trim()
    if (text === '') return { ok: true, notes: [] }
    const parts = text.split(/[,，\s]+/).filter(Boolean)
    const notes = []
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return { ok: false, error: `「${part}」不是合法 MIDI 音高（0–127 整数）` }
      const note = Number(part)
      if (!Number.isInteger(note) || note < 0 || note > 127) {
        return { ok: false, error: `${part} 超出 MIDI 音高范围 0–127` }
      }
      notes.push(note)
    }
    const normalized = normalizeTriggerNotes(notes)
    if (normalized.length > 16) return { ok: false, error: '触发音高最多 16 个（请精简）' }
    return { ok: true, notes: normalized }
  }

  const handleTriggerNotesInput = (value) => {
    setTriggerNotesText(value)
    const parsed = parseTriggerNotes(value)
    if (!parsed.ok) {
      setTriggerNotesError(parsed.error)
      return
    }
    setTriggerNotesError('')
    updateDraft({ triggerNotes: parsed.notes })
  }

  const applyTriggerNotesPreset = (notes) => {
    const normalized = normalizeTriggerNotes(notes)
    setTriggerNotesText(formatTriggerNotes(normalized))
    setTriggerNotesError('')
    const next = updateDraft({ triggerNotes: normalized }, { debounce: false })
    commitNow(next, '设置侧链触发音高')
  }

  return (
    <div
      className="aims-sc-popover"
      data-testid="sc-popover"
      ref={popoverRef}
      role="dialog"
      aria-label={`侧链设置：${track.name}`}
      style={{ left: position.left, top: position.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="aims-sc-head">
        <span className={`aims-sc-dot ${active ? 'is-on' : ''}`} />
        <span className="aims-sc-title">侧链压缩</span>
        <span className="aims-sc-track" title={track.name}>{track.name}</span>
        <button type="button" className="aims-sc-close" aria-label="关闭侧链设置" title="关闭" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="aims-sc-row">
        <span className="aims-sc-label">启用</span>
        <Switch
          checked={Boolean(draft.enabled)}
          onChange={handleToggle}
          testId="sc-enable"
          color={track.color ?? palette.coral}
          title={draft.enabled ? '禁用侧链（保留配置）' : '启用侧链'}
          label={`${track.name} 侧链启用`}
        />
        <span className={`aims-sc-state ${active ? 'is-on' : ''}`}>{active ? '生效中' : '未生效'}</span>
      </div>

      <label className="aims-sc-field">
        <span className="aims-sc-label">来源轨道</span>
        <span className="aims-sc-select-wrap">
          <select
            className="aims-sc-select"
            data-testid="sc-source"
            value={draft.sourceTrackId ?? ''}
            aria-label="选择侧链来源轨道"
            onChange={(e) => handleSource(e.target.value)}
            title="触发侧链压缩的源轨道（不能选择自身）"
          >
            <option value="">无（不使用侧链）</option>
            {sourceOptions.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <span className="aims-sc-select-caret" aria-hidden="true">▾</span>
        </span>
      </label>

      <label className="aims-sc-field">
        <span className="aims-sc-label">触发音高</span>
        <input
          type="text"
          className={`aims-sc-input ${triggerNotesError ? 'is-invalid' : ''}`}
          data-testid="sidechain-trigger-notes"
          value={triggerNotesText}
          placeholder="空=全部音高；如 36"
          aria-label="侧链触发音高（逗号分隔 MIDI 0–127，空=全部）"
          aria-invalid={triggerNotesError ? 'true' : undefined}
          onChange={(event) => handleTriggerNotesInput(event.target.value)}
        />
        <span className="aims-sc-preset-row">
          <button type="button" className="aims-sc-preset" data-testid="sc-trigger-kick" onClick={() => applyTriggerNotesPreset([36])}>
            只底鼓 36
          </button>
          <button type="button" className="aims-sc-preset" data-testid="sc-trigger-all" onClick={() => applyTriggerNotesPreset([])}>
            全部音高
          </button>
          <span className="aims-sc-trigger-hint">逗号分隔 MIDI；空=全部</span>
        </span>
        {triggerNotesError ? (
          <span className="aims-sc-error" data-testid="sidechain-trigger-notes-error" role="alert">{triggerNotesError}</span>
        ) : null}
      </label>

      <Slider
        label="压缩量"
        value={numberOr(draft.amount, SC_DEFAULTS.amount)}
        min={SC_RANGES.amount[0]}
        max={SC_RANGES.amount[1]}
        step={0.01}
        display={`${Math.round(numberOr(draft.amount, SC_DEFAULTS.amount) * 100)}%`}
        color={track.color ?? palette.coral}
        testId="sc-amount"
        onChange={(v) => updateDraft({ amount: v })}
        onCommit={() => commitNow(draftRef.current, '调整侧链')}
      />
      <Slider
        label="Attack"
        value={numberOr(draft.attack, SC_DEFAULTS.attack)}
        min={SC_RANGES.attack[0]}
        max={SC_RANGES.attack[1]}
        step={0.001}
        display={`${Math.round(numberOr(draft.attack, SC_DEFAULTS.attack) * 1000)} ms`}
        color={palette.mint}
        testId="sc-attack"
        title="Attack / 起音时间常数：值越大，压缩动作越慢"
        onChange={(v) => updateDraft({ attack: v })}
        onCommit={() => commitNow(draftRef.current, '调整侧链')}
      />
      <Slider
        label="Release"
        value={numberOr(draft.release, SC_DEFAULTS.release)}
        min={SC_RANGES.release[0]}
        max={SC_RANGES.release[1]}
        step={0.01}
        display={`${Math.round(numberOr(draft.release, SC_DEFAULTS.release) * 1000)} ms`}
        color={palette.teal}
        testId="sc-release"
        title="Release / 恢复时间常数：值越大，压缩后恢复越慢（不是固定秒数后完全恢复）"
        onChange={(v) => updateDraft({ release: v })}
        onCommit={() => commitNow(draftRef.current, '调整侧链')}
      />

      <div className="aims-sc-summary" data-testid="sc-summary">
        来源 <b>{sourceName}</b> · 深度 <b>{Math.round(numberOr(draft.amount, SC_DEFAULTS.amount) * 100)}%</b>
        {' · '}触发 <b>{triggerNotesLabel(draft.triggerNotes)}</b>
        {' · '}A <b>{Math.round(numberOr(draft.attack, SC_DEFAULTS.attack) * 1000)}ms</b>
        {' / '}R <b>{Math.round(numberOr(draft.release, SC_DEFAULTS.release) * 1000)}ms</b>
      </div>

      <footer className="aims-sc-foot">
        <button type="button" className="aims-sc-clear" data-testid="sc-clear" onClick={handleClear}>
          清除侧链
        </button>
        <span className="aims-sc-hint">源轨每次击打都会压低本轨音量（track 音量之后、FX 之前）</span>
      </footer>
    </div>
  )
}

export function Mixer({
  project, tracks = [], selectedTrackId, engine,
  selectedBus = null, onSelectBus, selectedGroup = null, onSelectGroup,
  onSelectTrack, onVolume, onPan, onToggleMute, onToggleSolo,
  editable = false, onEditOp, onNotify,
}) {
  const [scPopover, setScPopover] = useState(null)
  const [freezeStatuses, setFreezeStatuses] = useState(new Map())
  const [freezeBusyId, setFreezeBusyId] = useState(null)
  const hasExternal = (tracks ?? []).some((track) => track?.engine === 'vst3' || track?.vst3 || (track?.effects ?? []).some((fx) => fx?.type === 'vst3'))
  useEffect(() => {
    if (!hasExternal) { setFreezeStatuses(new Map()); return undefined }
    let cancelled = false
    const read = async () => {
      const map = await fetchExternalFreezeStatuses()
      if (!cancelled) setFreezeStatuses(map)
    }
    read()
    const timer = setInterval(read, 1200)
    return () => { cancelled = true; clearInterval(timer) }
  }, [hasExternal, tracks])
  const toggleFreeze = async (track) => {
    if (!track || freezeBusyId) return
    setFreezeBusyId(track.id)
    try {
      const current = freezeInfoFor(freezeStatuses, track.id)
      const result = current?.status === 'current'
        ? await unfreezeExternalPlugin({ trackId: track.id })
        : await freezeExternalPlugin({ trackId: track.id, track, engine })
      setFreezeStatuses((prev) => { const next = new Map(prev); next.set(track.id, result); return next })
      onNotify?.(result.frozen ? '外部插件轨道已冻结' : '外部插件轨道已解冻', 'success')
      setFreezeStatuses(await fetchExternalFreezeStatuses())
    } catch (err) {
      onNotify?.('冻结操作失败：' + (err?.message ?? err), 'error')
    } finally {
      setFreezeBusyId(null)
    }
  }
  const scPopoverRef = useRef(null)
  scPopoverRef.current = scPopover
  const groups = useMemo(() => (Array.isArray(project?.groups) ? project.groups : []), [project?.groups])
  const groupInputs = useMemo(() => {
    const counts = new Map()
    for (const track of tracks ?? []) {
      const output = track?.output
      if (typeof output === 'string' && output !== 'master') counts.set(output, (counts.get(output) ?? 0) + 1)
    }
    return counts
  }, [tracks])
  const groupInputTracks = useMemo(() => {
    const result = new Map()
    for (const track of tracks ?? []) {
      const output = track?.output
      if (typeof output !== 'string' || output === 'master') continue
      if (!result.has(output)) result.set(output, [])
      result.get(output).push(track.id)
    }
    return result
  }, [tracks])
  const scenes = useMemo(() => (Array.isArray(project?.scenes) ? project.scenes : []), [project?.scenes])
  const [sceneId, setSceneId] = useState('')
  const [sceneName, setSceneName] = useState('')
  useEffect(() => {
    if (sceneId && scenes.some((scene) => scene.id === sceneId)) return
    setSceneId(scenes[0]?.id ?? '')
  }, [scenes, sceneId])
  const saveScene = useCallback(() => {
    const name = sceneName.trim() || `${String(project?.title ?? '').trim() || '未命名工程'} 场景`
    onEditOp?.({ type: 'saveScene', name }, '保存场景')
    setSceneName('')
  }, [onEditOp, project?.title, sceneName])
  const recallScene = useCallback(() => {
    if (!sceneId) return
    onEditOp?.({ type: 'recallScene', id: sceneId }, '召回场景')
  }, [onEditOp, sceneId])
  const deleteScene = useCallback(() => {
    if (!sceneId) return
    onEditOp?.({ type: 'deleteScene', id: sceneId }, '删除场景')
  }, [onEditOp, sceneId])

  /* P2c-2：返回总线（兼容旧工程数字形式）与各轨发送汇总 */
  const buses = useMemo(() => ({
    reverb: normalizeBusEntry(project?.buses?.reverb, 'reverb'),
    delay: normalizeBusEntry(project?.buses?.delay, 'delay'),
  }), [project?.buses?.reverb, project?.buses?.delay])
  const busIncoming = useMemo(() => {
    let reverb = 0
    let delay = 0
    for (const track of tracks ?? []) {
      reverb += clamp(Number(track?.sends?.reverb) || 0, 0, 1)
      delay += clamp(Number(track?.sends?.delay) || 0, 0, 1)
    }
    return { reverb, delay }
  }, [tracks])

  const openSidechain = useCallback((trackId, anchorEl) => {
    const track = (tracks ?? []).find((item) => item.id === trackId)
    if (!track) return
    if (scPopoverRef.current?.trackId === trackId) {
      setScPopover(null)
      return
    }
    const rect = anchorEl.getBoundingClientRect()
    const width = 272
    const estimatedHeight = 436
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = rect.right + 10
    if (left + width > vw - 12) left = rect.left - width - 10
    left = clamp(left, 12, Math.max(12, vw - width - 12))
    const spaceBelow = vh - rect.bottom
    const top = spaceBelow >= estimatedHeight + 12
      ? rect.bottom + 8
      : clamp(rect.top - estimatedHeight - 8, 12, Math.max(12, vh - estimatedHeight - 12))
    const initial = readSidechain(track, tracks)
    setScPopover({ trackId, left, top, initial })
  }, [tracks])

  const closeSidechain = useCallback(() => setScPopover(null), [])
  const popoverTrack = scPopover ? (tracks ?? []).find((item) => item.id === scPopover.trackId) : null

  return (
    <div className="aims-mixer">
      <div className="aims-mixer-scroll">
        <div className="aims-mixer-strips">
          {tracks.length === 0 ? (
            <div className="aims-mixer-empty">还没有轨道，混音台将在 AI 建立轨道后出现。</div>
          ) : (
            tracks.map((track, index) => (
              <ChannelStrip
                key={track.id}
                track={track}
                tracks={tracks}
                groups={groups}
                index={index}
                selected={track.id === selectedTrackId}
                engine={engine}
                sidechain={readSidechain(track, tracks)}
                freezeInfo={freezeInfoFor(freezeStatuses, track.id)}
                freezeBusy={freezeBusyId === track.id}
                onFreeze={() => toggleFreeze(track)}
                onSelect={onSelectTrack}
                onVolume={onVolume}
                onPan={onPan}
                onToggleMute={onToggleMute}
                onToggleSolo={onToggleSolo}
                onOpenSidechain={openSidechain}
                onEditOp={onEditOp}
              />
            ))
          )}
          <div className="aims-mixer-divider" aria-hidden="true" />
          {BUSES.map((busDef) => (
            <BusStrip
              key={busDef.id}
              busId={busDef.id}
              bus={buses[busDef.id]}
              busDef={busDef}
              incoming={busIncoming[busDef.id] ?? 0}
              selected={selectedBus === busDef.id}
              onSelect={onSelectBus}
              onEditOp={onEditOp}
            />
          ))}
          <div className="aims-mixer-divider" aria-hidden="true" />
          {groups.map((group) => (
            <GroupStrip
              key={group.id}
              group={group}
              inputs={groupInputs.get(group.id) ?? 0}
              inputTrackIds={groupInputTracks.get(group.id) ?? []}
              selected={selectedGroup === group.id}
              onSelect={onSelectGroup}
              onEditOp={onEditOp}
              onNotify={onNotify}
            />
          ))}
          <div className="aims-mixer-divider" aria-hidden="true" />
          <MasterStrip project={project} engine={engine} />
        </div>
      </div>
      {scPopover && popoverTrack ? (
        <SidechainPopover
          track={popoverTrack}
          tracks={tracks}
          sidechain={readSidechain(popoverTrack, tracks)}
          initial={scPopover.initial}
          position={scPopover}
          onEditOp={onEditOp}
          onNotify={onNotify}
          onClose={closeSidechain}
        />
      ) : null}
      <div className="aims-mixer-scenes" data-testid="scene-bar" title="混音场景：只快照音量/声像/M/S/发送/FX/路由等混音字段，不含音符与编排">
        <span className="aims-mixer-scenes-label">场景</span>
        <select
          className="aims-mixer-scene-select"
          data-testid="scene-select"
          value={sceneId}
          aria-label="选择混音场景"
          onChange={(event) => setSceneId(event.target.value)}
        >
          <option value="">选择场景…</option>
          {scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
        </select>
        <input
          className="aims-mixer-scene-name"
          data-testid="scene-name"
          value={sceneName}
          onChange={(event) => setSceneName(event.target.value)}
          placeholder={`${String(project?.title ?? '').trim() || '工程'} 场景`}
          aria-label="新场景名称"
        />
        <button type="button" className="aims-mixer-scene-btn is-save" data-testid="scene-save" onClick={saveScene} title="保存当前混音参数为场景（同名覆盖）">保存场景</button>
        <button type="button" className="aims-mixer-scene-btn" data-testid="scene-recall" onClick={recallScene} disabled={!sceneId} title="召回选中场景（一次撤销）">召回</button>
        <button type="button" className="aims-mixer-scene-btn is-delete" data-testid="scene-delete" onClick={deleteScene} disabled={!sceneId} title="删除选中场景">删除</button>
        <span className="aims-mixer-scenes-count aims-mono">{scenes.length}/8</span>
      </div>
      <footer className="aims-mixer-foot">
        <button
          type="button"
          className="aims-mixer-add-group"
          data-testid="mixer-add-group"
          disabled={groups.length >= 8}
          title={groups.length >= 8 ? '编组数量已达上限 8' : '添加一个 Group 编组通道'}
          onClick={() => onEditOp?.({ type: 'addGroup' }, '添加编组')}
        >+ 编组</button>
        <span className="aims-mixer-foot-item"><span className="aims-mixer-foot-dot" style={{ background: palette.coral }} />推子/PAN/发送量可拖动（写回宿主）</span>
        <span className="aims-mixer-foot-item"><span className="aims-mixer-foot-dot" style={{ background: palette.mint }} />SC 配置侧链压缩</span>
        <span
          className="aims-mixer-foot-item aims-mixer-foot-buses"
          data-testid="bus-sends-summary"
          data-reverb-level={buses.reverb.level}
          data-delay-level={buses.delay.level}
          title="返回总线电平（点击 R 通道条可选中并在效果器视图编辑其 FX 链）"
        >
          返回：混响 {Math.round(buses.reverb.level * 100)}% · 延迟 {Math.round(buses.delay.level * 100)}%
        </span>
        <span className="aims-mixer-foot-item aims-mixer-foot-meta">
          返回总线 FX 在效果器视图编辑 · 电平表实时读取引擎
        </span>
      </footer>
    </div>
  )
}

