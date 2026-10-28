/**
 * 中栏：效果器链（P2b 可编辑）。
 *
 * - 目标：Master / 任意轨道（默认 Master；点 fx-target-track 进入选中轨道链）
 * - 卡片：开关、参数旋钮（拖动改值，松手一次提交）、上移/下移、删除
 * - 顶部「+ 添加效果器」下拉（11 种 FX）
 * - 所有编辑走 onEditOp(op) → App runEdit → actions.edit([op])（宿主乐观覆盖 + 撤销/保存）
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FX_PARAM_SPECS, FX_TYPES, BUSES, findFxType } from '../../shared/catalog.js'
import {
  Knob, Switch, EmptyState, IconFx, IconPlus, IconTrash, IconArrowUp, IconArrowDown,
  IconChevronDown, clamp, fmtParam, roleLabel,
} from './ui.jsx'
import { palette, tint, shade } from '../theme.js'

/** 返回总线展示名（catalog 里叫「混响发送」，这里显示为「混响返回」）。 */
function busLabelOf(bus) {
  return bus?.name ? bus.name.replace('发送', '返回') : (bus?.id ?? '返回')
}

/** 返回总线归一化（兼容旧工程数字形式）。 */
function normalizeBusEntry(raw) {
  if (typeof raw === 'number') return { level: clamp(raw, 0, 1), effects: [] }
  return {
    level: clamp(Number(raw?.level) || 0, 0, 1),
    effects: Array.isArray(raw?.effects) ? raw.effects : [],
  }
}

/** 可编辑旋钮：拖动期间只改本地草稿，松手 onCommit 一次。 */
function FxParamKnob({ effectKey, spec, value, color, defName, editable, onCommit }) {
  const hostValue = Number.isFinite(Number(value)) ? Number(value) : (spec.default ?? 0)
  const [draft, setDraft] = useState(null)
  useEffect(() => {
    setDraft(null)
  }, [hostValue, effectKey])
  const current = draft == null ? hostValue : draft
  return (
    <Knob
      value={current}
      min={spec.min ?? 0}
      max={spec.max ?? 1}
      label={spec.label}
      display={fmtParam(spec, current)}
      color={color}
      size={38}
      interactive={editable}
      testId={`fx-param-${effectKey}`}
      title={`${defName} · ${spec.label}：${fmtParam(spec, current)}${editable ? '（上下拖动/方向键调参）' : '（只读）'}`}
      onChange={(next) => setDraft(next)}
      onCommit={(next) => {
        setDraft(next)
        onCommit(effectKey, next)
      }}
    />
  )
}

function EnumPills({ spec, effectKey, value, color, editable, defName, onCommit }) {
  const options = spec.options ?? []
  return (
    <div className="aims-fx-enum" data-testid={`fx-param-${effectKey}`} data-value={value} title={`${spec.label}：${fmtParam(spec, value)}`}>
      <span className="aims-fx-param-label">{spec.label}</span>
      <div className="aims-fx-enum-row">
        {options.map((option) => {
          const active = option === value
          const content = fmtParam(spec, option)
          if (!editable) {
            return <span key={option} className={`aims-fx-enum-pill ${active ? 'is-on' : ''}`}>{content}</span>
          }
          return (
            <button
              key={option}
              type="button"
              className={`aims-fx-enum-pill is-action ${active ? 'is-on' : ''}`}
              style={active ? { borderColor: tint(color, 0.5), background: tint(color, 0.86), color: shade(color, 0.3) } : undefined}
              aria-pressed={active}
              data-testid={`fx-param-${effectKey}-${option}`}
              title={`${defName} · ${spec.label} → ${content}`}
              onClick={() => { if (!active) onCommit(effectKey, option) }}
            >
              {content}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FxCard({
  effect, index, total, def, editable, onToggle, onParam, onMove, onRemove,
}) {
  const specs = FX_PARAM_SPECS[effect.type] ?? {}
  const entries = Object.entries(specs)
  const enabled = effect.enabled !== false
  return (
    <article
      className={`aims-fx-card ${enabled ? '' : 'is-bypassed'} ${editable ? '' : 'is-readonly'}`}
      style={{ '--fx-color': def.color, borderColor: enabled ? tint(def.color, 0.62) : palette.line }}
      data-testid={`fx-effect-${effect.id}`}
      data-fx-id={effect.id}
      data-fx-type={effect.type}
      data-fx-index={index}
      data-fx-enabled={enabled ? '1' : '0'}
    >
      <span className="aims-fx-card-stripe" style={{ background: enabled ? def.color : palette.lineStrong }} />
      <header className="aims-fx-card-head">
        <span className="aims-fx-order aims-mono" title={`链路位置 ${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>
        <span className="aims-fx-icon" style={{ color: enabled ? shade(def.color, 0.2) : palette.muted, background: enabled ? tint(def.color, 0.84) : palette.panelSunk }}>
          <IconFx size={14} />
        </span>
        <div className="aims-fx-names">
          <span className="aims-fx-name">{def.name}</span>
          <span className="aims-fx-label">{def.label} · {def.category}</span>
        </div>
        <div className="aims-fx-card-actions">
          <button
            type="button"
            className="aims-fx-iconbtn"
            data-testid={`fx-up-${effect.id}`}
            disabled={index === 0 || !editable}
            title="上移（更靠前处理）"
            aria-label={`上移 ${def.name}`}
            onClick={() => onMove(effect.id, index - 1)}
          ><IconArrowUp size={12} /></button>
          <button
            type="button"
            className="aims-fx-iconbtn"
            data-testid={`fx-down-${effect.id}`}
            disabled={index >= total - 1 || !editable}
            title="下移（更靠后处理）"
            aria-label={`下移 ${def.name}`}
            onClick={() => onMove(effect.id, index + 1)}
          ><IconArrowDown size={12} /></button>
          <Switch
            checked={enabled}
            color={def.color}
            disabled={!editable}
            onChange={() => onToggle(effect.id, !enabled)}
            title={`${enabled ? '关闭' : '开启'} ${def.name}`}
            label={`${def.name} 开关`}
            testId={`fx-toggle-${effect.id}`}
          />
          <button
            type="button"
            className="aims-fx-iconbtn is-danger"
            data-testid={`fx-remove-${effect.id}`}
            disabled={!editable}
            title={`从链路移除 ${def.name}（可撤销）`}
            aria-label={`删除 ${def.name}`}
            onClick={() => onRemove(effect.id)}
          ><IconTrash size={12} /></button>
        </div>
      </header>

      <div className="aims-fx-params">
        {entries.map(([key, spec]) => {
          const value = effect.params?.[key]
          if (spec.type === 'enum') {
            return (
              <EnumPills
                key={key}
                spec={spec}
                effectKey={key}
                value={value}
                color={def.color}
                editable={editable}
                defName={def.name}
                onCommit={onParam.bind(null, effect.id)}
              />
            )
          }
          if (spec.type === 'bool') {
            return (
              <div key={key} className="aims-fx-bool" title={`${spec.label}：${fmtParam(spec, value)}`} data-testid={`fx-param-${key}`} data-value={Boolean(value) ? '1' : '0'}>
                <Switch
                  checked={Boolean(value)}
                  color={def.color}
                  disabled={!editable}
                  title={`${spec.label}${editable ? '' : '（只读）'}`}
                  label={spec.label}
                  onChange={() => onParam(effect.id, key, !value)}
                />
                <span className="aims-fx-param-label">{spec.label}</span>
              </div>
            )
          }
          return (
            <FxParamKnob
              key={key}
              effectKey={key}
              spec={spec}
              value={value}
              color={def.color}
              defName={def.name}
              editable={editable}
              onCommit={onParam.bind(null, effect.id)}
            />
          )
        })}
        {entries.length === 0 ? <span className="aims-fx-no-params">无参数</span> : null}
      </div>

      <footer className="aims-fx-card-foot">
        <span className="aims-fx-desc" title={def.desc}>{def.desc}</span>
        <span className={`aims-fx-state ${enabled ? 'is-on' : ''}`}>{enabled ? '启用' : '旁通'}</span>
      </footer>
    </article>
  )
}

export const FxRack = memo(function FxRack({
  project, tracks = [], selectedTrackId = null, fxTarget = 'master', onSelectTarget,
  editable = false, onEditOp, onNotify,
}) {
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef(null)

  useEffect(() => {
    if (!addOpen) return undefined
    const onPointerDown = (event) => {
      if (addRef.current && !addRef.current.contains(event.target)) setAddOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setAddOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [addOpen])

  const isBusTarget = typeof fxTarget === 'string' && fxTarget.startsWith('bus:')
  const busId = isBusTarget ? fxTarget.slice(4) : null
  const busDef = isBusTarget ? (BUSES.find((item) => item.id === busId) ?? null) : null
  const busInfo = isBusTarget ? normalizeBusEntry(project?.buses?.[busId]) : null
  const isGroupTarget = typeof fxTarget === 'string' && fxTarget.startsWith('group:')
  const groupId = isGroupTarget ? fxTarget.slice(6) : null
  const group = isGroupTarget ? ((project?.groups ?? []).find((item) => item.id === groupId) ?? null) : null
  const isMaster = !isBusTarget && !isGroupTarget && (fxTarget === 'master' || !fxTarget)
  const track = isMaster || isBusTarget || isGroupTarget ? null : tracks.find((t) => t.id === fxTarget)
  const effects = isGroupTarget
    ? (group?.effects ?? [])
    : isBusTarget
      ? (busInfo?.effects ?? [])
      : isMaster ? (project?.master?.effects ?? []) : (track?.effects ?? [])
  const sends = track?.sends ?? null
  const enabledCount = useMemo(() => effects.filter((fx) => fx.enabled !== false).length, [effects])

  const emit = useCallback((op, label) => {
    if (!editable) {
      onNotify?.('只读模式：宿主编辑接口尚未就绪', 'error')
      return
    }
    onEditOp?.(op, label)
  }, [editable, onEditOp, onNotify])

  const fields = useCallback(() => {
    if (isGroupTarget && groupId) return { target: 'group', groupId }
    if (isBusTarget && busId) return { target: 'bus', busId }
    if (isMaster) return { target: 'master' }
    return { target: 'track', trackId: fxTarget }
  }, [busId, fxTarget, groupId, isBusTarget, isGroupTarget, isMaster])

  const addEffect = useCallback((typeId) => {
    const def = findFxType(typeId)
    if (!def) return
    setAddOpen(false)
    emit({ type: 'addEffect', ...fields(), fxType: def.id, position: effects.length }, '添加效果器')
  }, [effects.length, emit, fields])

  const toggleEffect = useCallback((effectId, enabled) => {
    emit({ type: 'updateEffect', ...fields(), effectId, enabled }, '调整效果器')
  }, [emit, fields])

  const updateParam = useCallback((effectId, key, value) => {
    const effect = effects.find((fx) => fx.id === effectId)
    if (!effect) return
    emit({ type: 'updateEffect', ...fields(), effectId, params: { ...(effect.params ?? {}), [key]: value } }, '调整效果器')
  }, [effects, emit, fields])

  const moveEffect = useCallback((effectId, position) => {
    const index = effects.findIndex((fx) => fx.id === effectId)
    if (index < 0) return
    const next = Math.max(0, Math.min(effects.length - 1, Number(position)))
    if (next === index) return
    emit({ type: 'updateEffect', ...fields(), effectId, position: next }, '调整效果器顺序')
  }, [effects, emit, fields])

  const removeEffect = useCallback((effectId) => {
    emit({ type: 'removeEffect', ...fields(), effectId }, '移除效果器')
  }, [emit, fields])

  const title = isGroupTarget
    ? `${group?.name ?? groupId ?? '编组'} 编组效果链`
    : isBusTarget
      ? `${busLabelOf(busDef)} 效果链`
      : isMaster ? 'Master 效果链' : `${track?.name ?? '轨道'} 效果链`
  const accent = isGroupTarget
    ? palette.teal
    : isBusTarget
      ? (busDef?.color ?? palette.mint)
      : isMaster ? palette.coral : (track?.color ?? palette.coral)
  const activeTrackTestId = (item) => (item.id === (selectedTrackId ?? tracks[0]?.id) ? 'fx-target-track' : undefined)

  return (
    <div className="aims-fxrack">
      <div className="aims-fx-head">
        <div className="aims-fx-headline">
          <span className="aims-fx-eyebrow">FX RACK · 效果器链</span>
          <div className="aims-fx-title-row">
            <h2 className="aims-fx-title" style={{ color: shade(accent, 0.22) }}>
              <span className="aims-fx-title-dot" style={{ background: accent }} />
              {title}
            </h2>
            <span className="aims-fx-summary aims-mono">{enabledCount}/{effects.length} 启用</span>
            {editable
              ? <span className="aims-fx-editable">可编辑 · 拖动旋钮调参 · 松手写回</span>
              : <span className="aims-fx-readonly">只读 · 宿主编辑接口未就绪</span>}
          </div>
        </div>
        <div className="aims-fx-targets" role="tablist" aria-label="选择效果链目标">
          <button
            type="button"
            role="tab"
            aria-selected={isMaster}
            data-testid="fx-target-master"
            className={`aims-fx-target ${isMaster ? 'is-active' : ''}`}
            style={{ '--target-color': palette.coral }}
            title="查看 Master 母带效果链"
            aria-label="查看 Master 母带效果链"
            onClick={() => onSelectTarget?.('master')}
          >
            <span className="aims-fx-target-dot" style={{ background: palette.coral }} />
            MASTER
          </button>
          {BUSES.map((bus) => {
            const busEffects = normalizeBusEntry(project?.buses?.[bus.id]).effects
            const busLevel = normalizeBusEntry(project?.buses?.[bus.id]).level
            const active = fxTarget === `bus:${bus.id}`
            const label = busLabelOf(bus)
            return (
              <button
                key={bus.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`fx-target-${bus.id}`}
                data-bus-id={bus.id}
                className={`aims-fx-target aims-fx-target--bus ${active ? 'is-active' : ''}`}
                style={{ '--target-color': bus.color }}
                title={`${label}总线 · 返回电平 ${Math.round(busLevel * 100)}% · ${busEffects.length} 个效果器`}
                aria-label={`编辑 ${label}总线的效果链，${busEffects.length} 个效果器`}
                onClick={() => onSelectTarget?.(`bus:${bus.id}`)}
              >
                <span className="aims-fx-target-dot" style={{ background: bus.color }} />
                <span className="aims-fx-target-name">{label}</span>
                <span className="aims-fx-target-fxcount aims-mono">{busEffects.length}</span>
              </button>
            )
          })}
          {tracks.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={fxTarget === item.id}
              data-testid={activeTrackTestId(item)}
              data-track-id={item.id}
              className={`aims-fx-target ${fxTarget === item.id ? 'is-active' : ''}`}
              style={{ '--target-color': item.color }}
              title={`${item.name} · ${roleLabel(item.role)} · ${(item.effects ?? []).length} 个效果器`}
              aria-label={`查看 ${item.name} 的效果链，${(item.effects ?? []).length} 个效果器`}
              onClick={() => onSelectTarget?.(item.id)}
            >
              <span className="aims-fx-target-dot" style={{ background: item.color }} />
              <span className="aims-fx-target-name">{item.name}</span>
            </button>
          ))}
          {(project?.groups ?? []).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={fxTarget === `group:${item.id}`}
              data-testid={`fx-target-${item.id}`}
              data-group-id={item.id}
              className={`aims-fx-target aims-fx-target--group ${fxTarget === `group:${item.id}` ? 'is-active' : ''}`}
              style={{ '--target-color': palette.teal }}
              title={`${item.name} 编组 · ${(item.effects ?? []).length} 个效果器 · 输入 ${item.inputTracks ?? 0} 轨`}
              aria-label={`查看 ${item.name} 编组效果链，${(item.effects ?? []).length} 个效果器`}
              onClick={() => onSelectTarget?.(`group:${item.id}`)}
            >
              <span className="aims-fx-target-dot" style={{ background: palette.teal }} />
              <span className="aims-fx-target-name">G · {item.name}</span>
              <span className="aims-fx-target-fxcount aims-mono">{item.effects?.length ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="aims-fx-toolbar">
        <div className="aims-fx-add" ref={addRef}>
          <button
            type="button"
            className={`aims-fx-add-btn ${addOpen ? 'is-open' : ''}`}
            data-testid="fx-add"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            title="在当前链尾部添加一个效果器"
            onClick={() => setAddOpen((prev) => !prev)}
          >
            <IconPlus size={13} />
            添加效果器
            <IconChevronDown size={11} className="aims-fx-add-caret" />
          </button>
          {addOpen ? (
            <div className="aims-fx-add-menu" role="menu" aria-label="添加效果器">
              <div className="aims-fx-add-head">选择效果器类型 <span className="aims-mono">{FX_TYPES.length}</span></div>
              <div className="aims-fx-add-grid">
                {FX_TYPES.map((type) => (
                  <button
                    key={type.id}
                    type="button"
                    role="menuitem"
                    className="aims-fx-add-item"
                    data-testid={`fx-add-${type.id}`}
                    title={type.desc}
                    onClick={() => addEffect(type.id)}
                  >
                    <span className="aims-fx-add-dot" style={{ background: type.color }} />
                    <span className="aims-fx-add-names">
                      <span className="aims-fx-add-name">{type.name}</span>
                      <span className="aims-fx-add-label">{type.label}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="aims-fx-add-foot">也可直接对 AI 说「给{isMaster ? '母带' : '这条轨道'}加一个 Reverb」</div>
            </div>
          ) : null}
        </div>
        <span className="aims-fx-toolbar-hint">
          {editable ? '点击卡片开关旁通 · 拖动旋钮调参 · ↑↓ 调整顺序 · 删除可撤销' : '效果链当前只读'}
        </span>
      </div>

      <div className="aims-fx-flow">
        <span className="aims-fx-flow-node">输入</span>
        <span className="aims-fx-flow-line" />
        <span className="aims-fx-flow-text">
          {effects.length === 0 ? '无处理' : effects.map((fx) => findFxType(fx.type)?.name ?? fx.type).join(' → ')}
        </span>
        <span className="aims-fx-flow-line" />
        <span className="aims-fx-flow-node">输出</span>
        <span className="aims-fx-flow-sends">
          {isBusTarget ? (
            <>
              返回电平 <b className="aims-mono">{Math.round((busInfo?.level ?? 0) * 100)}%</b>
              {' '}· <b className="aims-mono">{effects.length}</b> 个总线效果器
            </>
          ) : isMaster ? (
            <>母带链输出 → Master</>
          ) : (
            <>
              发送 · 混响 <b className="aims-mono">{Math.round((sends?.reverb ?? 0) * 100)}%</b>
              {' '}延迟 <b className="aims-mono">{Math.round((sends?.delay ?? 0) * 100)}%</b>
            </>
          )}
        </span>
      </div>

      <div className="aims-fxchain">
        {effects.length === 0 ? (
          <div className="aims-fx-empty">
            <EmptyState
              icon={<IconFx size={22} />}
              title="这条链上还没有效果器"
              description={isBusTarget
                ? `点击右上「+ 添加效果器」给${busLabelOf(busDef)}总线加 EQ / 滤波 / 失真，例如「给混响返回加一个 EQ」。`
                : isMaster
                  ? '点击右上「+ 添加效果器」给母带加压缩 / EQ，或直接对 AI 说「给母带加一点压缩」。'
                  : '点击右上「+ 添加效果器」，或对 AI 说「给这条轨道加一个延迟」。'}
              hints={['Filter / Drive / Chorus / Phaser / Delay / Reverb / Bitcrush / Compressor / EQ3 / Tremolo / Auto Filter']}
            />
          </div>
        ) : null}
        <div className="aims-fx-cards" data-testid="fx-effects-list" data-count={effects.length}>
          {effects.map((effect, index) => {
            const def = findFxType(effect.type) ?? FX_TYPES[0]
            return (
              <FxCard
                key={effect.id}
                effect={effect}
                index={index}
                total={effects.length}
                def={def}
                editable={editable}
                onToggle={toggleEffect}
                onParam={updateParam}
                onMove={moveEffect}
                onRemove={removeEffect}
              />
            )
          })}
        </div>
        {effects.length > 0 ? (
          <div className="aims-fx-slot">
            <div className="aims-fx-slot-inner">
              <span className="aims-fx-slot-icon"><IconPlus size={18} /></span>
              <span className="aims-fx-slot-title">链尾 · 下一个效果器</span>
              <span className="aims-fx-slot-sub">
                也可以让 AI 加：对它说「给{isMaster ? '母带' : '这条轨道'}加一点 Tape 饱和 / 自动滤波」
              </span>
              <span className="aims-fx-slot-chips">
                {FX_TYPES.map((type) => (
                  <button
                    type="button"
                    className="aims-fx-slot-chip"
                    key={type.id}
                    data-testid={`fx-slot-${type.id}`}
                    style={{ color: shade(type.color, 0.28), background: tint(type.color, 0.86), borderColor: tint(type.color, 0.62) }}
                    title={`${type.desc}（点击添加）`}
                    onClick={() => addEffect(type.id)}
                  >
                    <IconPlus size={9} />
                    {type.name}
                  </button>
                ))}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
})
