/**
 * 右栏：AI 创作动态（activity 大字 + history 时间线）+ 项目统计。
 */
import { useMemo } from 'react'
import { projectStats } from '../../shared/model.js'
import { findScale } from '../../shared/catalog.js'
import {
  Panel, IconClock, IconSparkle, IconLayers, fmtClock, timeAgo, toolMeta, useNow,
} from './ui.jsx'
import { alpha, palette } from '../theme.js'

/** AI 正在创作：大字号 activity + 呼吸灯。 */
export function AiFeed({ project, playing = false, collapsed = false, onToggleCollapse = null }) {
  const now = useNow(10000)
  const activity = project?.activity ?? { text: '等待 AI 开始创作…', at: 0 }
  const history = project?.history ?? []
  const recent = activity.at > 0 && now - activity.at < 3 * 60 * 1000
  const events = useMemo(() => [...history].reverse(), [history])
  const shown = events.slice(0, 24)

  return (
    <Panel
      title="AI 创作动态"
      subtitle="LIVE FEED"
      icon={<IconSparkle size={14} />}
      badge={history.length ? `${history.length} 步` : null}
      className="aims-right-panel aims-ai-panel"
      bodyClassName="aims-ai-body"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      collapseTestId="collapse-ai-feed"
      collapseTitle={collapsed ? '展开 AI 创作动态' : '折叠 AI 创作动态'}
      actions={(
        <span className={`aims-ai-live-tag ${recent || playing ? 'is-live' : ''}`} title="AI 与界面实时同步">
          <span className="aims-ai-live-dot" />
          {recent || playing ? 'LIVE' : 'IDLE'}
        </span>
      )}
    >
      <div className={`aims-ai-now ${recent ? 'is-active' : ''}`} title={activity.text}>
        <div className="aims-ai-now-head">
          <span className="aims-ai-avatar" aria-hidden="true">
            <IconSparkle size={15} />
          </span>
          <div className="aims-ai-now-meta">
            <span className="aims-ai-now-label">{recent ? 'AI 正在创作' : 'AI 最近动态'}</span>
            <span className="aims-ai-now-time">
              <IconClock size={11} />
              <span>{timeAgo(activity.at, now)}</span>
            </span>
          </div>
          <span className="aims-ai-now-status">DeepSeek AI</span>
        </div>
        <p className="aims-ai-now-text">{activity.text || '等待 AI 开始创作…'}</p>
        <div className="aims-ai-typing" aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
      </div>

      <div className="aims-ai-history">
        <div className="aims-ai-history-head">
          <span className="aims-ai-history-title">创作时间线</span>
          <span className="aims-ai-history-count aims-mono">{history.length} STEPS</span>
        </div>
        <div className="aims-ai-history-list">
          {shown.length === 0 ? (
            <div className="aims-ai-history-empty">
              <IconLayers size={16} />
              <span>AI 的每一步创作都会实时出现在这里。</span>
            </div>
          ) : (
            shown.map((event, index) => {
              const meta = toolMeta(event.tool)
              return (
                <article key={`${event.at}-${index}`} className={`aims-ai-event ${index === 0 ? 'is-latest' : ''}`}>
                  <span className="aims-ai-event-rail" aria-hidden="true">
                    <span className="aims-ai-event-dot" style={{ background: meta.color }} />
                  </span>
                  <div className="aims-ai-event-body" title={event.text}>
                    <div className="aims-ai-event-top">
                      <span className="aims-ai-event-tool" style={{ color: meta.color, background: alpha(meta.color, 0.1) }}>{meta.label}</span>
                      <span className="aims-ai-event-tool-raw aims-mono">{String(event.tool ?? '').replace(/^studio_/, '')}</span>
                      <span className="aims-ai-event-time aims-mono">{fmtClock(event.at)}</span>
                    </div>
                    <p className="aims-ai-event-text">{event.text}</p>
                  </div>
                </article>
              )
            })
          )}
          {events.length > shown.length ? (
            <div className="aims-ai-history-more">更早的 {events.length - shown.length} 步已折叠</div>
          ) : null}
        </div>
      </div>
    </Panel>
  )
}

/** 项目统计：小节 / 轨道 / Pattern / 音符 / 时长 / 效果器。 */
export function ProjectStats({ project, collapsed = false, onToggleCollapse = null }) {
  const stats = useMemo(() => (project ? projectStats(project) : null), [project])
  if (!stats) return null
  const scaleLabel = findScale(project.scale)?.label ?? project.scale ?? ''
  const minutes = Math.floor(stats.durationSeconds / 60)
  const seconds = stats.durationSeconds % 60
  const tiles = [
    { key: 'bars', label: '小节', value: stats.bars, tone: palette.coral },
    { key: 'bpm', label: 'BPM', value: stats.bpm, tone: palette.amber },
    { key: 'tracks', label: '轨道', value: stats.tracks, tone: palette.mint },
    { key: 'patterns', label: 'PATTERN', value: stats.patterns, tone: palette.rose },
    { key: 'notes', label: '音符', value: stats.notes, tone: palette.teal },
    { key: 'fx', label: '效果器', value: stats.effects, tone: palette.caramel },
  ]
  return (
    <Panel
      title="项目统计"
      subtitle="PROJECT"
      icon={<IconLayers size={14} />}
      badge={`${stats.clips} 片段`}
      className="aims-right-panel aims-stats-panel"
      bodyClassName="aims-stats-body"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      collapseTestId="collapse-project-stats"
      collapseTitle={collapsed ? '展开项目统计' : '折叠项目统计'}
    >
      <div className="aims-stats-grid">
        {tiles.map((tile) => (
          <div className="aims-stat" key={tile.key} title={`${tile.label}：${tile.value}`}>
            <span className="aims-stat-label">{tile.label}</span>
            <span className="aims-stat-value aims-mono" style={{ color: tile.tone }}>{tile.value}</span>
            <span className="aims-stat-bar" style={{ background: tile.tone }} />
          </div>
        ))}
      </div>
      <div className="aims-stats-meta">
        <span className="aims-stats-meta-item" title="工程调性">
          <span className="aims-stats-meta-k">KEY</span>
          <span className="aims-stats-meta-v">{project.key} {scaleLabel}</span>
        </span>
        <span className="aims-stats-meta-item" title="拍号">
          <span className="aims-stats-meta-k">TIME</span>
          <span className="aims-stats-meta-v aims-mono">{(project.timeSignature ?? [4, 4]).join('/')}</span>
        </span>
        <span className="aims-stats-meta-item" title="时长">
          <span className="aims-stats-meta-k">LEN</span>
          <span className="aims-stats-meta-v aims-mono">{minutes}:{String(seconds).padStart(2, '0')}</span>
        </span>
        <span className="aims-stats-meta-item" title="Swing 摇摆量">
          <span className="aims-stats-meta-k">SWING</span>
          <span className="aims-stats-meta-v aims-mono">{Math.round((project.swing ?? 0) * 100)}%</span>
        </span>
      </div>
    </Panel>
  )
}
