/** R7a/R7c：帮助中心（快捷键 / AI 用法 / FAQ / 导出路径 / 版本）+ 无障碍。 */
import { useEffect, useRef, useState } from 'react'
import { IconClose, IconHelp } from './ui.jsx'
import { useDialogA11y, useI18n } from '../i18n.js'

const SHORTCUTS = [
  ['空格 / Space', 'shortcut.playPause'],
  ['Ctrl+K', 'shortcut.commandPalette'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'shortcut.undoRedo'],
  ['Ctrl+S', 'shortcut.save'],
  ['Ctrl+N / Ctrl+O', 'shortcut.newOpen'],
  ['A W S E D F…', 'shortcut.keyboard'],
  ['Esc', 'shortcut.escape'],
]

const FAQ = [
  ['help.faqExport', 'help.faqExportAnswer'],
  ['help.faqSound', 'help.faqSoundAnswer'],
  ['help.faqAi', 'help.faqAiAnswer'],
  ['help.faqUndo', 'help.faqUndoAnswer'],
]

export function HelpDialog({ onClose, onNotify }) {
  const { t } = useI18n()
  const cardRef = useRef(null)
  useDialogA11y(true, onClose, cardRef)
  const [version, setVersion] = useState('')
  const [diagStatus, setDiagStatus] = useState('')
  const downloadText = (text, name) => {
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      setTimeout(() => { try { anchor.remove(); URL.revokeObjectURL(url) } catch (err) { /* ignore */ } }, 50)
    } catch (err) {
      onNotify?.('导出诊断失败：浏览器不允许下载', 'error')
    }
  }
  const exportDiagnostics = async () => {
    setDiagStatus('正在生成诊断…')
    try {
      const res = await fetch('/studio/api/diagnostics/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const contentType = res.headers.get('content-type') || ''
      let text = ''
      if (contentType.includes('application/json')) {
        const data = await res.json().catch(() => null)
        if (data?.ok === false) throw new Error(data?.error || '导出失败')
        text = String(data?.text ?? data?.diagnostics ?? '')
        if (!text && data?.path) text = `诊断文件已生成：${data.path}`
      } else {
        text = await res.text()
      }
      if (!text.trim()) {
        const fallback = await fetch('/studio/api/diagnostics', { cache: 'no-store' })
        const data = await fallback.json()
        text = String(data?.text ?? JSON.stringify(data, null, 2))
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      downloadText(text, `aims-diagnostics-${stamp}.txt`)
      setDiagStatus('诊断日志已导出')
      onNotify?.('诊断日志已导出（本地生成，不含上传）', 'success')
    } catch (err) {
      setDiagStatus('导出失败：' + (err?.message ?? err))
      onNotify?.('导出诊断失败：' + (err?.message ?? err), 'error')
    }
  }
  useEffect(() => {
    let cancelled = false
    fetch('/studio/api/health', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setVersion(String(data?.version ?? '')) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  return (
    <div className="aims-modal" role="dialog" aria-modal="true" aria-label={t('help.title')} data-testid="help-dialog" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="aims-modal-card aims-help-card" ref={cardRef}>
        <header className="aims-modal-head">
          <div className="aims-modal-title">
            <span className="aims-modal-icon"><IconHelp size={15} /></span>
            {t('help.title')}
            {version ? <span className="aims-help-version aims-mono">v{version}</span> : null}
          </div>
          <button type="button" className="aims-modal-close" data-testid="help-close" aria-label={t('common.close')} onClick={onClose}><IconClose size={13} /></button>
        </header>
        <div className="aims-help-body">
          <section className="aims-help-section">
            <h3>{t('help.quickStart')}</h3>
            <ol className="aims-help-steps">
              <li>{t('help.quickStart1')}</li>
              <li>{t('help.quickStart2')}</li>
              <li>{t('help.quickStart3')}</li>
            </ol>
          </section>
          <section className="aims-help-section">
            <h3>{t('help.shortcuts')}</h3>
            <div className="aims-help-keys">
              {SHORTCUTS.map(([key, labelKey]) => (
                <div className="aims-help-key" key={key}><kbd>{key}</kbd><span>{t(labelKey)}</span></div>
              ))}
            </div>
          </section>
          <section className="aims-help-section">
            <h3>{t('help.faq')}</h3>
            <div className="aims-help-faq">
              {FAQ.map(([qKey, aKey]) => (
                <details key={qKey}><summary>{t(qKey)}</summary><p>{t(aKey)}</p></details>
              ))}
            </div>
          </section>
          <section className="aims-help-section">
            <h3>{t('help.usage')}</h3>
            <p>{t('help.usageText')} {t('help.guide')}</p>
          </section>
        </div>
        <footer className="aims-modal-foot">
          <span className="aims-modal-foot-hint">{t('help.diagnosticsNoUpload')} · Esc</span>
          <div className="aims-modal-foot-actions">
            <button type="button" className="aims-dlg-btn" data-testid="help-diagnostics" onClick={exportDiagnostics}>{t('help.diagnostics')}</button>
            {diagStatus ? <span className="aims-help-diag-status" role="status">{diagStatus}</span> : null}
            <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" onClick={onClose}>{t('common.ok')}</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
