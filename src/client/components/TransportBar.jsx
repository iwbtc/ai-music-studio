/**
 * 顶栏：品牌 / 项目信息 / 走带控制 / 位置显示 / master 电平 / AI 动态 / 导出。
 *
 * 每帧数据（位置、master dB）直接写 DOM，不触发 React 重渲染。
 * 顶栏宽度用容器查询（.aims-host 是容器）自适应：面板比窗口窄时也能正确收窄。
 */
import { useRef } from 'react'
import {
  IconExport, IconKeyboard, IconLoop, IconPause, IconPlay, IconRecord, IconRedo, IconRewind, IconSave, IconSparkle, IconStop,
  IconUndo, IconWave, LevelMeter, clamp, fmtDb, fmtPosition, fmtClock, readLevels, useFrame,
} from './ui.jsx'
import { findScale } from '../../shared/catalog.js'

/** 录音计时 mm:ss（超过 1 小时显示 h:mm:ss）。 */
function fmtRecordElapsed(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (value) => String(value).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/* ── P12：tempoMap 在当前 beat 的 BPM（线性插值；无 tempoMap 用 project.bpm） ── */
const TEMPO_MIN_BPM = 40
const TEMPO_MAX_BPM = 200
function clampBpm(value) {
  return Math.min(TEMPO_MAX_BPM, Math.max(TEMPO_MIN_BPM, Number(value) || 128))
}
function tempoPointsOf(project) {
  const raw = Array.isArray(project?.tempoMap) ? project.tempoMap : []
  return raw
    .map((point) => ({ beat: Math.max(0, Number(point?.beat) || 0), bpm: clampBpm(point?.bpm) }))
    .sort((a, b) => a.beat - b.beat)
}
function bpmAtBeat(project, beat) {
  const points = tempoPointsOf(project)
  if (points.length === 0) return clampBpm(project?.bpm)
  if (beat <= points[0].beat) return points[0].bpm
  const last = points[points.length - 1]
  if (beat >= last.beat) return last.bpm
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const next = points[i]
    if (beat <= next.beat) {
      const span = next.beat - prev.beat
      if (span <= 1e-6) return next.bpm
      const t = (beat - prev.beat) / span
      return prev.bpm + (next.bpm - prev.bpm) * t
    }
  }
  return last.bpm
}

export function TransportBar({
  project, engine, playing = false, activity = null, exporting = false, exportPhase = '', hostError = false,
  onPlay, onStop, onRewind, onExport, onLoopInfo, audioUnlocked = true,
  history = null, projectInfo = null, saveState = 'saved', onUndo, onRedo, onSave,
  keyboardOpen = false, onToggleKeyboard,
  recordState = 'idle', recordElapsed = 0, recordLevel = 0, onToggleRecord,
  overdub = false, monitoring = false, onToggleOverdub = null, onToggleMonitor = null,
  hasReference = false, abMode = false, onToggleAB = null,
  inputDevices = [], inputDeviceId = '', onSelectInputDevice = null,
}) {
  const beats = project?.timeSignature?.[0] ?? 4
  const fallbackBar = Number(project?.transport?.playheadBar) || 0
  const positionRef = useRef(null)
  const dbRef = useRef(null)
  const bpmValueRef = useRef(null)
  const fallbackRef = useRef(fallbackBar)
  fallbackRef.current = fallbackBar
  const beatsRef = useRef(beats)
  beatsRef.current = beats
  const projectRef = useRef(project)
  projectRef.current = project

  useFrame(engine, (e, now, frame) => {
    if (frame % 2 === 0) {
      const pos = e ? e.positionBar : fallbackRef.current
      if (positionRef.current) positionRef.current.textContent = fmtPosition(pos, beatsRef.current)
    }
    if (frame % 3 === 0 && bpmValueRef.current) {
      const pos = e ? e.positionBar : fallbackRef.current
      bpmValueRef.current.textContent = String(Math.round(bpmAtBeat(projectRef.current, pos * beatsRef.current)))
    }
    if (frame % 3 === 0 && dbRef.current) {
      const levels = readLevels(e, frame)
      dbRef.current.textContent = fmtDb(levels?.master ?? 0)
    }
  })

  const scaleLabel = findScale(project?.scale)?.label ?? project?.scale ?? ''
  const title = project?.title ?? '未命名作品'
  const activityText = activity?.text ?? '等待 AI 开始创作…'
  const loopStart = project?.transport?.loopStartBar ?? 0
  const loopEnd = project?.transport?.loopEndBar ?? project?.lengthBars ?? 0
  const loopLabel = `循环范围：第 ${loopStart + 1} 至 ${loopEnd} 小节（由 AI 设置）`
  const canUndo = Boolean(history?.canUndo)
  const canRedo = Boolean(history?.canRedo)
  const undoTitle = '撤销'
  const redoTitle = '重做'
  const fileName = projectInfo?.name || ''
  const savedLabel = saveState === 'saving' ? '保存中…' : saveState === 'dirty' ? '未保存' : '已保存'
  const savedTitle = projectInfo?.activeSavedAt
    ? `${savedLabel} · 最近保存 ${fmtClock(projectInfo.activeSavedAt)}`
    : savedLabel

  const selectedInputDevice = (inputDevices ?? []).find((device) => device.deviceId === inputDeviceId) ?? null
  const inputDeviceTitle = `录音输入设备：${selectedInputDevice?.label || (inputDeviceId ? '已保存的输入设备' : '系统默认输入')}（点击下拉选择，下次录音生效）`

  return (
    <header className="aims-transport">
      <div className="aims-brand">
        <div className="aims-brand-mark" title="AI 音乐工作室" aria-hidden="true">
          <IconWave size={18} />
        </div>
        <div className="aims-brand-text">
          <div className="aims-brand-title">AI 音乐工作室</div>
          <div className="aims-brand-sub">DEEPSEEK · AI MUSIC STUDIO</div>
        </div>
      </div>

      <div className="aims-project">
        <div className="aims-project-title-row">
          <div className="aims-project-title" title={fileName ? `${title} · ${fileName}` : title}>{title}</div>
          <span className={`aims-save-badge is-${saveState}`} title={savedTitle}>
            <span className="aims-save-badge-dot" />
            {savedLabel}
          </span>
        </div>
        <div className="aims-project-meta">
          <span className="aims-meta-chip aims-meta-chip--bpm" data-testid="bpm-chip" title="当前播放头 BPM（存在速度自动化时随播放变化）">
            <span className="aims-meta-key">BPM</span>
            <span className="aims-meta-val aims-mono" ref={bpmValueRef}>{Math.round(bpmAtBeat(project, fallbackBar * beats))}</span>
          </span>
          <span className="aims-meta-chip aims-meta-chip--key" title={`调性：${project?.key ?? '—'} ${scaleLabel}`}>
            <span className="aims-meta-key">KEY</span>
            <span className="aims-meta-val">{project?.key ?? '—'} {scaleLabel}</span>
          </span>
          <span className="aims-meta-chip aims-meta-chip--bars" title="工程总小节数">
            <span className="aims-meta-key">BARS</span>
            <span className="aims-meta-val aims-mono">{project?.lengthBars ?? '—'}</span>
          </span>
          <span
            className={`aims-meta-chip aims-meta-chip--audio ${audioUnlocked ? 'is-on' : 'is-off'}`}
            title={audioUnlocked ? '音频上下文已启用' : '音频未启用：点击界面任意处启用'}
          >
            <span className="aims-dot" />
            <span className="aims-meta-val">{audioUnlocked ? '音频就绪' : '音频未启用'}</span>
          </span>
          {fileName ? (
            <span className="aims-meta-chip aims-meta-chip--file" title={`工程文件：${fileName}`}>
              <span className="aims-meta-key">FILE</span>
              <span className="aims-meta-val">{fileName}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="aims-transport-center">
        <div className="aims-transport-btns" role="group" aria-label="走带控制">
          <button type="button" className="aims-tbtn" onClick={onRewind} title="回到开头（Home）" aria-label="回到开头">
            <IconRewind size={15} />
          </button>
          <button
            type="button"
            className={`aims-tbtn aims-tbtn--play ${playing ? 'is-playing' : ''}`}
            onClick={onPlay}
            title={playing ? '暂停 / 停止播放' : '播放（空格）'}
            aria-label={playing ? '暂停播放' : '播放'}
            aria-pressed={playing}
          >
            {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
          </button>
          <button type="button" className="aims-tbtn" onClick={onStop} title="停止（再按回到播放头）" aria-label="停止播放">
            <IconStop size={14} />
          </button>
          <button
            type="button"
            className={`aims-tbtn aims-tbtn--ghost ${loopEnd > loopStart ? 'is-active' : ''}`}
            title={loopLabel}
            aria-label={loopLabel}
            onClick={() => onLoopInfo?.(loopStart, loopEnd)}
          >
            <IconLoop size={15} />
          </button>
          <span className="aims-tbtn-divider" aria-hidden="true" />
          <button
            type="button"
            className="aims-tbtn aims-tbtn--sm"
            onClick={onUndo}
            disabled={!canUndo}
            title={undoTitle}
            aria-label={history?.undoLabel ? `撤销：${history.undoLabel}` : '撤销'}
          >
            <IconUndo size={14} />
          </button>
          <button
            type="button"
            className="aims-tbtn aims-tbtn--sm"
            onClick={onRedo}
            disabled={!canRedo}
            title={redoTitle}
            aria-label={history?.redoLabel ? `重做：${history.redoLabel}` : '重做'}
          >
            <IconRedo size={14} />
          </button>
          <button
            type="button"
            className="aims-tbtn aims-tbtn--sm"
            onClick={onSave}
            disabled={saveState === 'saving'}
            title="保存工程（Ctrl+S）"
            aria-label="保存工程"
          >
            <IconSave size={14} />
          </button>
        </div>

        <div className="aims-position" title="播放头位置：小节 · 拍">
          <span className="aims-position-value aims-mono" ref={positionRef}>{fmtPosition(fallbackBar, beats)}</span>
          <span className="aims-position-label">BAR · BEAT</span>
        </div>

        <div className="aims-master" title="Master 输出电平">
          <div className="aims-master-head">
            <span className="aims-master-label">MASTER</span>
            <span className="aims-master-db aims-mono" ref={dbRef}>-∞</span>
          </div>
          <LevelMeter engine={engine} orientation="horizontal" />
        </div>
      </div>

      <div className="aims-transport-right">
        <span className="aims-input-device-wrap" title={inputDeviceTitle}>
          <select
            className="aims-input-device"
            data-testid="input-device-select"
            aria-label="录音输入设备"
            title={inputDeviceTitle}
            value={inputDeviceId}
            onChange={(event) => onSelectInputDevice?.(event.target.value)}
            disabled={recordState === 'recording'}
          >
            <option value="">系统默认输入</option>
            {(inputDevices ?? []).map((device, index) => (
              <option key={device.deviceId || `audioinput-${index}`} value={device.deviceId}>
                {device.label || `输入设备 ${index + 1}`}
              </option>
            ))}
            {inputDeviceId && !(inputDevices ?? []).some((device) => device.deviceId === inputDeviceId) ? (
              <option value={inputDeviceId}>已保存的输入设备（未授权/不可用）</option>
            ) : null}
          </select>
        </span>
        <button
          type="button"
          className={`aims-ab-toggle ${abMode ? 'is-on' : ''} ${!hasReference ? 'is-unavailable' : ''}`}
          data-testid="ab-toggle"
          data-active={abMode ? '1' : '0'}
          data-has-reference={hasReference ? '1' : '0'}
          aria-pressed={abMode}
          aria-disabled={!hasReference}
          onClick={() => onToggleAB?.()}
          title={hasReference
            ? (abMode ? 'A/B：当前为参考曲；点击恢复工程 mute/solo' : 'A/B：切到参考曲（静音所有工程轨）')
            : '先导入参考曲（文件 → 导入参考曲…）'}
        >
          <span className="aims-ab-dot" aria-hidden="true" />
          A/B
        </button>
        <button
          type="button"
          className={`aims-record-audio ${recordState === 'recording' ? 'is-recording' : ''}`}
          data-testid="record-audio"
          data-state={recordState === 'recording' ? 'recording' : 'idle'}
          data-elapsed={Number(recordElapsed || 0).toFixed(2)}
          aria-pressed={recordState === 'recording'}
          onClick={onToggleRecord}
          title={recordState === 'recording'
            ? `停止录音（已录 ${fmtRecordElapsed(recordElapsed)}，点击或 Space 停止播放即结束）`
            : '录音：麦克风输入 → 停止后自动生成音频轨与音频片段'}
        >
          <span className="aims-record-audio-dot" aria-hidden="true" />
          {recordState === 'recording' ? (
            <>
              <span className="aims-record-audio-time aims-mono">{fmtRecordElapsed(recordElapsed)}</span>
              <span className="aims-record-audio-meter" aria-hidden="true">
                <span style={{ width: `${Math.round(clamp(Number(recordLevel) || 0, 0, 1) * 100)}%` }} />
              </span>
            </>
          ) : (
            <span className="aims-record-audio-label">录音</span>
          )}
          {/* R2c：叠录/监听嵌入录音按钮内（绝对定位，不占顶栏流宽度，P7 多尺寸不压右栏）。 */}
          <span
            className="aims-rec-modes"
            role="group"
            aria-label="录音模式"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span
              role="button"
              tabIndex={-1}
              className={`aims-rec-mode ${overdub ? 'is-on' : ''}`}
              data-testid="record-overdub"
              data-active={overdub ? '1' : '0'}
              aria-pressed={overdub}
              aria-label="叠录"
              onClick={(event) => { event.stopPropagation(); onToggleOverdub?.() }}
              title={overdub
                ? '叠录开启：同轨道/同位置再次录音会加入同一组 take（再次点击关闭）'
                : '叠录关闭：每次录音新建一组 take（点击开启，同位置录音成多 take）'}
            >
              <span className="aims-rec-mode-char" aria-hidden="true">叠</span>
            </span>
            <span
              role="button"
              tabIndex={-1}
              className={`aims-rec-mode ${monitoring ? 'is-on' : ''}`}
              data-testid="record-monitor"
              data-active={monitoring ? '1' : '0'}
              aria-pressed={monitoring}
              aria-label="监听"
              onClick={(event) => { event.stopPropagation(); onToggleMonitor?.() }}
              title={monitoring
                ? '录音监听开启：输入以 35% 低增益送到输出；请戴耳机防啸叫（再次点击关闭）'
                : '录音监听关闭：录音时不回放麦克风输入（点击开启，默认 35%）'}
            >
              <span className="aims-rec-mode-char" aria-hidden="true">听</span>
            </span>
          </span>
        </button>
        <span className="aims-visually-hidden" data-testid="record-audio-status" aria-live="polite">
          {recordState === 'recording' ? `录音中 · 已录 ${Number(recordElapsed || 0).toFixed(1)} 秒` : '录音待机'}
        </span>
        <button
          type="button"
          className={`aims-keyboard-toggle ${keyboardOpen ? 'is-open' : ''}`}
          data-testid="keyboard-toggle"
          aria-pressed={keyboardOpen}
          onClick={onToggleKeyboard}
          title="键盘面板：电脑键盘 / 鼠标 / MIDI 演奏与录制"
        >
          <IconKeyboard size={14} />
          <span className="aims-keyboard-toggle-label">键盘</span>
        </button>
        <div className="aims-ai-status" title={activityText}>
          <span className={`aims-ai-pulse ${playing ? 'is-live' : ''}`} aria-hidden="true">
            <IconSparkle size={13} />
          </span>
          <div className="aims-ai-status-text">
            <span className="aims-ai-status-label">AI 创作动态</span>
            <span className="aims-ai-status-line">{activityText}</span>
          </div>
        </div>
        {hostError ? (
          <span className="aims-host-warn" title="与宿主连接不稳定，正在自动重试同步项目">
            同步中断
          </span>
        ) : null}
        {exporting ? <span className="aims-export-note" data-testid="export-note">{exportPhase || '正在离线渲染…'}</span> : null}
        <button
          type="button"
          className={`aims-export ${exporting ? 'is-busy' : ''}`}
          onClick={onExport}
          disabled={exporting}
          title="离线渲染整首作品并导出 WAV（由宿主保存）"
          aria-label={exporting ? '正在导出 WAV' : '导出 WAV'}
        >
          {exporting ? <span className="aims-spinner" aria-hidden="true" /> : <IconExport size={15} />}
          <span className="aims-export-label">{exporting ? '渲染中' : '导出 WAV'}</span>
        </button>
      </div>
    </header>
  )
}
