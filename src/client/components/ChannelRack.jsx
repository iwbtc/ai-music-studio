/**
 * 左栏上：通道机架（轨道行）+ 步进音序器（P2c，选中鼓组轨道时展开）。
 *
 * 每行：颜色条 / 序号 / 名称 / 角色 / 静音·独奏 / 16 分步进灯（由 pattern 反推）/ 音量小条。
 * 音量条支持拖动 → actions.setVolume。
 * 步进音序器：选中鼓组轨道时挂在轨道列表下方（可折叠），编辑走 onCommitNotes → actions.edit。
 */
import { useEffect, useMemo, useState } from 'react'
import { findDrumKit, findSynthInstrument, findSynthPreset } from '../../shared/catalog.js'
import {
  Panel, EmptyState, roleLabel, pad, clamp, IconPiano, IconWave,
} from './ui.jsx'
import { StepSequencer, StepSequencerHint } from './StepSequencer.jsx'
import { fetchExternalFreezeStatuses, freezeExternalPlugin, freezeInfoFor, freezeStatusLabel, unfreezeExternalPlugin } from './ExternalPluginPanel.jsx'

function VolumeBar({ value = 0, color = '#F26B3A', onChange, title }) {
  const onPointerDown = (e) => {
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture?.(e.pointerId)
    const rect = el.getBoundingClientRect()
    const emit = (clientX) => onChange?.(clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1))
    emit(e.clientX)
    const move = (ev) => emit(ev.clientX)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div
      className="aims-volbar"
      title={title ?? `音量 ${Math.round(value * 100)}%（拖动调整）`}
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="aims-volbar-rail" />
      <div className="aims-volbar-fill" style={{ width: `${clamp(value) * 100}%`, background: color }} />
      <div className="aims-volbar-knob" style={{ left: `${clamp(value) * 100}%`, borderColor: color }} />
    </div>
  )
}

export function ChannelRack({
  project, tracks = [], selectedTrackId, engine, playing = false,
  selectedPatternId = null, editable = true,
  onSelectTrack, onToggleMute, onToggleSolo, onVolume,
  onSelectPattern, onCommitNotes, onOpenPattern, onRemoveTrack, onNotify,
  collapsed = false, onToggleCollapse = null, stepCollapsed, onToggleStepCollapse = null,
}) {
  const [localSeqCollapsed, setLocalSeqCollapsed] = useState(false)
  const [confirmRemoveId, setConfirmRemoveId] = useState(null)
  const [freezeStatuses, setFreezeStatuses] = useState(new Map())
  const [freezeBusyId, setFreezeBusyId] = useState(null)
  const seqCollapsed = stepCollapsed === undefined ? localSeqCollapsed : Boolean(stepCollapsed)
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
    if (track.vst3?.missing === true) { onNotify?.('插件文件缺失，无法冻结', 'error'); return }
    setFreezeBusyId(track.id)
    try {
      const current = freezeInfoFor(freezeStatuses, track.id)
      const result = current?.status === 'current'
        ? await unfreezeExternalPlugin({ trackId: track.id })
        : await freezeExternalPlugin({ trackId: track.id, track, engine })
      setFreezeStatuses((prev) => {
        const next = new Map(prev)
        next.set(track.id, result)
        return next
      })
      onNotify?.(result.frozen ? '外部插件轨道已冻结' : '外部插件轨道已解冻', 'success')
      const map = await fetchExternalFreezeStatuses()
      setFreezeStatuses(map)
    } catch (err) {
      onNotify?.('冻结操作失败：' + (err?.message ?? err), 'error')
    } finally {
      setFreezeBusyId(null)
    }
  }
  const toggleSeqCollapse = () => {
    if (typeof onToggleStepCollapse === 'function') onToggleStepCollapse()
    else setLocalSeqCollapsed((prev) => !prev)
  }
  const barBeats = project?.timeSignature?.[0] ?? 4
  const patterns = project?.patterns ?? []
  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? null
  const isDrumTrack = selectedTrack?.kind === 'drum'
  const isAudioTrack = selectedTrack?.kind === 'audio'
  const showStepSequencer = Boolean(selectedTrack && isDrumTrack && patterns.length > 0)
  const showSequencerSlot = Boolean(selectedTrack && tracks.length > 0 && !isAudioTrack)
  const expanded = showStepSequencer && !seqCollapsed

  /** 每轨 16 分步进灯（取该轨最靠前的 clip 的 pattern，只取第一小节）。 */
  const stepMap = useMemo(() => {
    const map = new Map()
    const patterns = project?.patterns ?? []
    const clips = project?.clips ?? []
    for (const track of tracks) {
      const clip = clips
        .filter((c) => c.trackId === track.id)
        .sort((a, b) => a.startBar - b.startBar)[0]
      const pattern = clip ? patterns.find((p) => p.id === clip.patternId) : null
      const steps = new Array(16).fill(0)
      if (pattern) {
        for (const note of pattern.notes) {
          if (note.start >= barBeats) continue
          const step = Math.round(note.start * 4) % 16
          steps[step] = Math.max(steps[step], Number(note.vel) || 0.6)
        }
      }
      map.set(track.id, { steps, pattern, empty: !pattern || pattern.notes.length === 0 })
    }
    return map
  }, [project, tracks, barBeats])

  return (
    <Panel
      title="通道机架"
      icon={<IconPiano size={14} />}
      badge={tracks.length ? `${tracks.length} 轨` : null}
      subtitle="CHANNEL RACK"
      className={`aims-left-panel aims-rack-panel ${expanded ? 'is-stepseq' : ''} ${collapsed ? 'is-panel-collapsed' : ''}`}
      bodyClassName="aims-panel-body--flush"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      collapseTestId="collapse-channel-rack"
      collapseTitle={collapsed ? '展开通道机架' : '折叠通道机架'}
      actions={<span className="aims-panel-hint" title="点击轨道可选中；M = 静音，S = 独奏">点击选择</span>}
    >
      {tracks.length === 0 ? (
        <EmptyState
          compact
          icon={<IconWave size={20} />}
          title="机架还是空的"
          description="AI 会在这里加入合成器与鼓机通道。"
        />
      ) : (
        <>
          <div className="aims-rack-list" role="list" aria-label="通道机架">
            {tracks.map((track, index) => {
              const info = stepMap.get(track.id) ?? { steps: new Array(16).fill(0), empty: true }
              const selected = track.id === selectedTrackId
              const isDrum = track.kind === 'drum'
              const isAudio = track.kind === 'audio'
              const vst3 = !isDrum && !isAudio && (track.engine === 'vst3' || track.vst3) ? track.vst3 : null
              const vst3Missing = vst3?.missing === true
              const preset = !isDrum && !isAudio ? findSynthPreset(track.instrument?.preset) : null
              const synthInstrument = !isDrum && !isAudio
                ? findSynthInstrument(track.engine === 'subtractive' || (!track.instrument?.preset && track.synthPreset) ? (track.synthPreset ?? track.instrument?.preset) : null)
                : null
              const kit = isDrum ? findDrumKit(track.instrument?.kit) : null
              const isSampledInstrument = Boolean(preset?.soundfont)
              const isLegacySynth = Boolean(preset && !preset.soundfont)
              const isSampledKit = Boolean(kit?.samplerPieces)
              const label = vst3
                ? (vst3Missing ? 'VST3 乐器 · missing' : `VST3 乐器 · ${vst3.name ?? vst3.pluginId ?? '外部插件'}`)
                : isDrum
                  ? (isSampledKit ? '采样鼓机' : '鼓机')
                  : isAudio ? '音频' : (synthInstrument ? (synthInstrument.label ?? synthInstrument.name) : (isSampledInstrument ? '采样乐器' : isLegacySynth ? '遗留合成音色' : '合成器'))
              const instrumentLabel = vst3 ? (vst3.name ?? vst3.pluginId ?? '') : (synthInstrument?.label ?? synthInstrument?.name ?? preset?.label ?? '')
              const hasVst3 = Boolean(vst3) || (track.effects ?? []).some((fx) => fx?.type === 'vst3')
              const vst3MissingAny = vst3Missing || (track.effects ?? []).some((fx) => fx?.type === 'vst3' && fx?.vst3?.missing === true)
              const freezeInfo = hasVst3 ? freezeInfoFor(freezeStatuses, track.id) : null
              const freezeCurrent = freezeInfo?.status === 'current'
              const armed = confirmRemoveId === track.id
              return (
                <div
                  key={track.id}
                  role="listitem"
                  className={`aims-rack-row ${selected ? 'is-selected' : ''} ${playing ? 'is-playing' : ''} ${track.mute ? 'is-muted' : ''} ${isAudio ? 'is-audio' : ''}`}
                  data-testid={isAudio ? 'audio-track' : vst3 ? 'rack-vst3-track' : undefined}
                  data-track-id={track.id}
                  data-sampled={isSampledInstrument || isSampledKit ? 'true' : 'false'}
                  data-synth-label={synthInstrument ? instrumentLabel : undefined}
                  data-vst3-missing={vst3Missing ? 'true' : undefined}
                  onClick={() => { setConfirmRemoveId(null); onSelectTrack?.(track.id) }}
                  title={`${track.name} · ${label} · ${roleLabel(track.role)}${instrumentLabel ? ` · ${instrumentLabel}` : ''}${preset?.soundfont ? ` · GM ${preset.soundfont.program}` : ''}`}
                >
                  <span className="aims-rack-color" style={{ background: track.color }} aria-hidden="true" />
                  <span className="aims-rack-dot" style={{ background: track.color }} aria-hidden="true" />
                  <div className="aims-rack-inner">
                    <div className="aims-rack-top">
                      <span className="aims-rack-idx aims-mono">{pad(index + 1)}</span>
                      <span className="aims-rack-name">{track.name}</span>
                      <span className="aims-rack-role">{roleLabel(track.role)}</span>
                      {isSampledKit ? <span className="aims-rack-sampled">采样鼓机</span> : null}
                      {isSampledInstrument ? <span className="aims-rack-sampled">采样乐器</span> : null}
                      {synthInstrument ? <span className="aims-rack-synth" data-testid="rack-synth-label">{instrumentLabel}</span> : null}
                      {vst3 ? <span className={`aims-rack-vst3 ${vst3Missing ? 'is-missing' : ''}`} data-testid="rack-vst3-label">{vst3Missing ? 'missing' : `VST3 乐器 · ${instrumentLabel}`}</span> : null}
                      {vst3 ? <span className="aims-rack-vst3-live" data-testid="rack-vst3-live">{vst3Missing ? '缺失' : (typeof window !== 'undefined' && window.aimsPlugins ? '实时乐器' : '仅桌面版')}</span> : null}
                      {hasVst3 ? (
                        <span
                          className={`aims-rack-freeze is-${freezeInfo?.status ?? 'unfrozen'}`}
                          data-testid={`freeze-status-${track.id}`}
                          data-status={freezeInfo?.status ?? 'unfrozen'}
                          title={freezeInfo?.error ?? '冻结状态'}
                        >
                          {vst3MissingAny ? '冻结不可用' : freezeStatusLabel(freezeInfo?.status)}
                        </span>
                      ) : null}
                      <div className="aims-rack-flags">
                        {hasVst3 ? (
                          <button
                            type="button"
                            className={`aims-flag aims-flag-freeze ${freezeCurrent ? 'is-on' : ''}`}
                            data-testid={`plugin-freeze-${track.id}`}
                            disabled={freezeBusyId === track.id || vst3MissingAny || freezeInfo?.status === 'freezing'}
                            title={vst3MissingAny ? '插件文件缺失，无法冻结' : (freezeCurrent ? '解冻并恢复实时插件' : (freezeInfo?.status === 'stale' ? '重新冻结（内容已修改）' : '离线冻结为音频缓存'))}
                            onClick={(event) => { event.stopPropagation(); toggleFreeze(track) }}
                          >
                            {freezeBusyId === track.id || freezeInfo?.status === 'freezing' ? '…' : 'F'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`aims-flag ${track.mute ? 'is-mute' : ''}`}
                          title={track.mute ? '取消静音' : '静音该通道'}
                          aria-label={`${track.mute ? '取消静音' : '静音'}：${track.name}`}
                          aria-pressed={Boolean(track.mute)}
                          onClick={(e) => { e.stopPropagation(); onToggleMute?.(track.id) }}
                        >M</button>
                        <button
                          type="button"
                          className={`aims-flag ${track.solo ? 'is-solo' : ''}`}
                          title={track.solo ? '取消独奏' : '独奏该通道'}
                          aria-label={`${track.solo ? '取消独奏' : '独奏'}：${track.name}`}
                          aria-pressed={Boolean(track.solo)}
                          onClick={(e) => { e.stopPropagation(); onToggleSolo?.(track.id) }}
                        >S</button>
                      </div>
                    </div>
                    <div className="aims-rack-bottom">
                      <div className="aims-steps" title={`16 分步进 · ${info.pattern?.name ?? '暂无 pattern'}`}>
                        {info.steps.map((vel, step) => (
                          <span
                            key={step}
                            className={`aims-step ${vel > 0 ? 'is-on' : ''}`}
                            style={vel > 0 ? { background: track.color, opacity: 0.34 + clamp(vel) * 0.66, animationDelay: `${step * 24}ms` } : undefined}
                          />
                        ))}
                      </div>
                      <VolumeBar
                        value={track.volume}
                        color={track.color}
                        onChange={(v) => onVolume?.(track.id, v)}
                        title={`${track.name} 音量 ${Math.round(track.volume * 100)}%（拖动调整）`}
                      />
                      {isAudio && editable && onRemoveTrack ? (
                        <button
                          type="button"
                          className={`aims-rack-remove ${armed ? 'is-armed' : ''}`}
                          data-testid={`track-remove-${track.id}`}
                          title={armed ? '再次点击确认移除该音频轨（片段一并删除，媒体文件保留）' : '移除该音频轨道'}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (!armed) { setConfirmRemoveId(track.id); return }
                            setConfirmRemoveId(null)
                            onRemoveTrack(track.id)
                            onNotify?.('已移除音频轨（Ctrl+Z 可撤销）', 'info')
                          }}
                        >
                          {armed ? '确认移除' : '移除轨道'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {showSequencerSlot ? (
            isDrumTrack ? (
              <StepSequencer
                project={project}
                track={selectedTrack}
                patterns={patterns}
                patternId={selectedPatternId}
                engine={engine}
                playing={playing}
                editable={editable}
                collapsed={seqCollapsed}
                onToggleCollapse={toggleSeqCollapse}
                onSelectPattern={onSelectPattern}
                onCommitNotes={onCommitNotes}
                onNotify={onNotify}
              />
            ) : (
              <StepSequencerHint
                track={selectedTrack}
                canOpen={patterns.length > 0}
                patternId={
                  patterns.some((pattern) => pattern.id === selectedPatternId)
                    ? selectedPatternId
                    : (patterns[0]?.id ?? null)
                }
                onOpenPattern={onOpenPattern}
              />
            )
          ) : null}
        </>
      )}
    </Panel>
  )
}
