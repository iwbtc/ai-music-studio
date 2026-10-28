/**
 * R6c：AI 修改面板（最近 1–3 条工具写操作）。
 * 接受=仅隐藏卡片；撤销/重做走现有 history undo/redo。
 */
import { IconClose, IconUndo, IconRedo, IconCheck } from './ui.jsx'

function number(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function signed(value) {
  const n = number(value)
  return n > 0 ? `+${n}` : String(n)
}

/** 把 host diff 摘要成一句中文。 */
export function summarizeChange(change) {
  const diff = change?.diff ?? {}
  const parts = []
  if (number(diff.tracksAdded) > 0) parts.push(`轨道 +${number(diff.tracksAdded)}`)
  if (number(diff.tracksRemoved) > 0) parts.push(`轨道 −${number(diff.tracksRemoved)}`)
  if (number(diff.tracksChanged) > 0) parts.push(`轨道改动 ${number(diff.tracksChanged)}`)
  if (number(diff.patternsAdded) > 0) parts.push(`Pattern +${number(diff.patternsAdded)}`)
  if (number(diff.patternsRemoved) > 0) parts.push(`Pattern −${number(diff.patternsRemoved)}`)
  if (number(diff.patternsChanged) > 0) parts.push(`Pattern 改动 ${number(diff.patternsChanged)}`)
  if (number(diff.clipsDelta) !== 0) parts.push(`片段 ${signed(diff.clipsDelta)}`)
  if (number(diff.sectionsDelta) !== 0) parts.push(`段落 ${signed(diff.sectionsDelta)}`)
  if (number(diff.notesDelta) !== 0) parts.push(`音符 ${signed(diff.notesDelta)}`)
  if (diff.bpm && number(diff.bpm.before) !== number(diff.bpm.after)) {
    parts.push(`BPM ${number(diff.bpm.before)}→${number(diff.bpm.after)}`)
  }
  if (diff.lengthBars && number(diff.lengthBars.before) !== number(diff.lengthBars.after)) {
    parts.push(`长度 ${number(diff.lengthBars.before)}→${number(diff.lengthBars.after)} 小节`)
  }
  if (Array.isArray(diff.trackNames) && diff.trackNames.length > 0) {
    parts.push(`涉及：${diff.trackNames.slice(0, 3).join(' / ')}${diff.trackNames.length > 3 ? '…' : ''}`)
  }
  if (Array.isArray(diff.patternDeltas) && diff.patternDeltas.length > 0) {
    const total = diff.patternDeltas.reduce((sum, item) => sum + Math.abs(number(item.afterNotes) - number(item.beforeNotes)), 0)
    if (parts.length === 0) parts.push(`Pattern 音符变化 ${total}`)
  }
  return parts.join(' · ') || '工程已修改'
}

export function AiChangePanel({
  changes = [],
  canUndo = false,
  canRedo = false,
  bottomOffset = null,
  onAccept,
  onUndo,
  onRedo,
  onClose,
}) {
  const list = (Array.isArray(changes) ? changes : []).slice(0, 3)
  if (list.length === 0) return null
  return (
    <aside
      className="aims-ai-change"
      data-testid="ai-change-panel"
      aria-label="AI 修改"
      style={bottomOffset != null ? { bottom: `${bottomOffset}px` } : undefined}
    >
      <header className="aims-ai-change-head">
        <span className="aims-ai-change-eyebrow">AI 修改</span>
        <span className="aims-ai-change-count aims-mono">{list.length}</span>
        <span className="aims-ai-change-head-spacer" />
        <button type="button" className="aims-ai-change-icon" data-testid="ai-change-close" title="关闭面板（保留修改）" aria-label="关闭 AI 修改面板" onClick={onClose}>
          <IconClose size={12} />
        </button>
      </header>
      <div className="aims-ai-change-list">
        {list.map((change, index) => (
          <div className={`aims-ai-change-item ${index === 0 ? 'is-latest' : ''}`} key={change?.id ?? index} data-change-id={change?.id ?? ''}>
            <span className="aims-ai-change-dot" />
            <div className="aims-ai-change-main">
              <div className="aims-ai-change-title" data-testid={index === 0 ? 'ai-change-title' : undefined}>
                {change?.title || change?.tool || 'AI 修改'}
              </div>
              <div className="aims-ai-change-summary" data-testid={index === 0 ? 'ai-change-summary' : undefined}>
                {summarizeChange(change)}
              </div>
            </div>
            {index === 0 ? <span className="aims-ai-change-tag">最近</span> : null}
          </div>
        ))}
      </div>
      <footer className="aims-ai-change-actions">
        <button type="button" className="aims-ai-change-btn" data-testid="ai-change-undo" disabled={!canUndo} title={canUndo ? '撤销这次 AI 修改（保留面板）' : '没有可撤销操作'} onClick={onUndo}>
          <IconUndo size={12} />撤销
        </button>
        <button type="button" className="aims-ai-change-btn" data-testid="ai-change-redo" disabled={!canRedo} title={canRedo ? '重做 AI 修改' : '没有可重做操作'} onClick={onRedo}>
          <IconRedo size={12} />重做
        </button>
        <button type="button" className="aims-ai-change-btn" data-testid="ai-change-accept" title="接受修改并关闭面板" onClick={onAccept}>
          <IconCheck size={12} />接受
        </button>
        <button type="button" className="aims-ai-change-btn is-ghost" data-testid="ai-change-close-footer" title="关闭面板（保留修改）" onClick={onClose}>
          关闭
        </button>
      </footer>
    </aside>
  )
}
