/**
 * 底部状态栏：音频状态 / 工程信息 / 同步状态 / 最近导出 / 版本。
 */
import { useMemo, useRef } from 'react'
import { projectStats } from '../../shared/model.js'
import { findScale } from '../../shared/catalog.js'
import { IconClock, IconExport, fmtClock, pad, useFrame } from './ui.jsx'
import { palette } from '../theme.js'

function basename(path) {
  if (!path) return ''
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] || String(path)
}

/* P12：tempoMap 当前播放头 BPM（线性插值；无 tempoMap 用 project.bpm）。 */
function bpmAtBeat(project, beat) {
  const points = (Array.isArray(project?.tempoMap) ? project.tempoMap : [])
    .map((point) => ({ beat: Math.max(0, Number(point?.beat) || 0), bpm: Math.min(200, Math.max(40, Number(point?.bpm) || 128)) }))
    .sort((a, b) => a.beat - b.beat)
  if (points.length === 0) return Math.min(200, Math.max(40, Number(project?.bpm) || 128))
  if (beat <= points[0].beat) return points[0].bpm
  const last = points[points.length - 1]
  if (beat >= last.beat) return last.bpm
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const next = points[i]
    if (beat <= next.beat) {
      const span = next.beat - prev.beat
      if (span <= 1e-6) return next.bpm
      return prev.bpm + (next.bpm - prev.bpm) * ((beat - prev.beat) / span)
    }
  }
  return last.bpm
}

export function StatusBar({ project, engine = null, playing = false, unlocked = false, lastExport = null, hostError = false, soundfontStatus = null }) {
  const stats = useMemo(() => (project ? projectStats(project) : null), [project])
  const scaleLabel = findScale(project?.scale)?.label ?? ''
  const exportName = basename(lastExport?.path)
  const exportSize = lastExport?.bytes ? `${(lastExport.bytes / 1024 / 1024).toFixed(1)} MB` : ''
  const projectRef = useRef(project)
  projectRef.current = project
  const bpmRef = useRef(null)
  const beats = Number(project?.timeSignature?.[0]) || 4

  useFrame(engine, (e, now, frame) => {
    if (frame % 4 !== 0 || !bpmRef.current) return
    const pos = e ? e.positionBar : (Number(projectRef.current?.transport?.playheadBar) || 0)
    bpmRef.current.textContent = String(Math.round(bpmAtBeat(projectRef.current, pos * beats)))
  })

  return (
    <footer className="aims-status">
      <div className="aims-status-left">
        <span className={`aims-status-audio ${unlocked ? 'is-on' : 'is-off'}`} title={unlocked ? 'Web Audio 上下文已启动' : '点击界面任意处启用音频'}>
          <span className="aims-status-dot" />
          {unlocked ? '音频引擎就绪' : '音频未启用'}
        </span>
        <span className={`aims-status-play ${playing ? 'is-playing' : ''}`} title={playing ? '正在播放' : '已停止'}>
          <span className="aims-status-eq" aria-hidden="true"><i /><i /><i /></span>
          {playing ? '播放中' : '已停止'}
        </span>
        {soundfontStatus?.state === 'loading' ? (
          <span
            className="aims-status-soundfont"
            data-testid="soundfont-status"
            data-state="loading"
            title="正在加载 GeneralUser GS 采样音色库（约 32MB，不阻塞界面）"
          >
            <span className="aims-status-soundfont-spin" aria-hidden="true" />
            正在加载音色库…
          </span>
        ) : null}
        <span className="aims-status-sep" aria-hidden="true" />
        {stats ? (
          <>
            <span className="aims-status-item" title="当前播放头 BPM（存在速度自动化时随播放变化）"><b className="aims-mono" ref={bpmRef}>{Math.round(bpmAtBeat(project, (Number(project?.transport?.playheadBar) || 0) * beats))}</b> BPM</span>
            <span className="aims-status-item"><b className="aims-mono">{(project.timeSignature ?? [4, 4]).join('/')}</b> 拍</span>
            <span className="aims-status-item"><b>{project.key}</b> {scaleLabel}</span>
            <span className="aims-status-item"><b className="aims-mono">{pad(stats.bars, 2)}</b> 小节</span>
            <span className="aims-status-item"><b className="aims-mono">{pad(stats.tracks, 2)}</b> 轨</span>
            <span className="aims-status-item"><b className="aims-mono">{stats.clips}</b> 片段</span>
            <span className="aims-status-item"><b className="aims-mono">{stats.notes.toLocaleString('en-US')}</b> 音符</span>
          </>
        ) : (
          <span className="aims-status-item">正在等待项目…</span>
        )}
      </div>

      <div className="aims-status-right">
        {exportName ? (
          <span className="aims-status-export" title={`最近导出：${lastExport.path}`}>
            <IconExport size={11} />
            <span className="aims-status-export-name">{exportName}</span>
            {exportSize ? <span className="aims-mono">{exportSize}</span> : null}
            {lastExport.seconds ? <span className="aims-mono">{Math.round(lastExport.seconds)}s</span> : null}
          </span>
        ) : null}
        {hostError ? (
          <span className="aims-status-warn" title="与宿主连接不稳定，正在自动重试">同步中断</span>
        ) : (
          <span className="aims-status-sync" title="通过 /studio/api/state 长轮询与宿主同步">
            <span className="aims-status-sync-dot" />
            已同步
          </span>
        )}
        <span className="aims-status-sep" aria-hidden="true" />
        <span className="aims-status-item aims-mono" title="项目 revision">REV {project?.revision ?? '—'}</span>
        <span className="aims-status-item aims-mono" title="最后更新时间">
          <IconClock size={11} />
          {project?.updatedAt ? fmtClock(project.updatedAt) : '--:--:--'}
        </span>
        <span className="aims-status-brand" title="DeepSeek AI 音乐工作室 v1.0">
          <span className="aims-status-brand-dot" style={{ background: palette.coral }} />
          AI MUSIC STUDIO v1.0
        </span>
      </div>
    </footer>
  )
}
