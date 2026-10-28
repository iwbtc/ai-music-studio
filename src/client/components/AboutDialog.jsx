/** R7a/R7c：关于对话框（版本/构建/Electron/平台/更新检查）+ 无障碍。 */
import { useEffect, useRef, useState } from 'react'
import { IconClose, IconSparkle } from './ui.jsx'
import { useDialogA11y, useI18n } from '../i18n.js'

export function AboutDialog({ onClose, onOpenSettings, onNotify }) {
  const { t } = useI18n()
  const cardRef = useRef(null)
  useDialogA11y(true, onClose, cardRef)
  const [info, setInfo] = useState({ loading: true, version: '1.0.0', build: {}, platform: '', electron: '' })
  const [update, setUpdate] = useState({ status: 'idle', version: '', notes: '', error: '' })
  const checkUpdate = async () => {
    setUpdate({ status: 'loading', version: '', notes: '', error: '' })
    try {
      const res = await fetch('/studio/api/update-check', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data?.error || `检查失败（HTTP ${res.status}）`)
      setUpdate({
        status: data?.status ?? 'error',
        version: data?.available?.latestVersion ?? data?.available?.version ?? '',
        notes: data?.notes ?? data?.available?.notes ?? '',
        error: '',
      })
    } catch (err) {
      setUpdate({ status: 'error', version: '', notes: '', error: err?.message ?? String(err) })
      onNotify?.('检查更新失败：' + (err?.message ?? err), 'error')
    }
  }
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/studio/api/health', { cache: 'no-store' })
        const data = await res.json()
        if (cancelled) return
        const build = data?.build && typeof data.build === 'object' ? data.build : {}
        setInfo({
          loading: false,
          version: String(data?.version ?? build.version ?? '1.0.0'),
          build: {
            version: build.version ?? data?.version ?? null,
            commit: build.commit ?? build.gitCommit ?? null,
            date: build.date ?? build.buildDate ?? null,
            channel: build.channel ?? data?.channel ?? null,
            electron: build.electron ?? data?.electronVersion ?? data?.electron ?? null,
          },
          platform: String(data?.platform ?? data?.build?.platform ?? navigator.platform ?? ''),
          electron: String(data?.electronVersion ?? build.electron ?? ''),
        })
      } catch (err) {
        if (!cancelled) setInfo({ loading: false, version: '1.0.0', build: {}, platform: navigator.platform || '', electron: '' })
      }
    }
    load()
    return () => { cancelled = true }
  }, [])
  const b = info.build ?? {}
  const updateLabel = update.status === 'loading'
    ? t('about.checking')
    : update.status === 'up-to-date'
      ? `${t('about.upToDate')}${update.version ? ` (v${update.version})` : ''}`
      : update.status === 'update-available'
        ? `${t('about.updateAvailable')}${update.version ? ` v${update.version}` : ''}`
        : update.status === 'no-source'
          ? t('about.noSource')
          : update.status === 'error'
            ? `${t('about.checkFailed')}: ${update.error || t('common.unknown')}`
            : t('about.notChecked')
  return (
    <div className="aims-modal" role="dialog" aria-modal="true" aria-label={t('about.title')} data-testid="about-dialog" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="aims-modal-card aims-about-card" ref={cardRef}>
        <header className="aims-modal-head">
          <div className="aims-modal-title">
            <span className="aims-modal-icon"><IconSparkle size={15} /></span>
            {t('about.title')}
          </div>
          <button type="button" className="aims-modal-close" data-testid="about-close" aria-label={t('common.close')} onClick={onClose}><IconClose size={13} /></button>
        </header>
        <div className="aims-about-body">
          <div className="aims-about-brand">
            <div className="aims-about-logo"><IconSparkle size={22} /></div>
            <div>
              <div className="aims-about-name">{t('app.name')}</div>
              <div className="aims-about-sub">{t('app.subtitle')}</div>
            </div>
          </div>
          <div className="aims-about-rows">
            <div className="aims-about-row"><span>{t('about.version')}</span><b data-testid="about-version" className="aims-mono">{info.version || '—'}</b></div>
            <div className="aims-about-row"><span>{t('about.build')}</span><b data-testid="about-build" className="aims-mono">{info.loading ? t('common.localBuild') : (b.commit || b.date ? `${String(b.commit ?? '').slice(0, 12)}${b.date ? ` · ${b.date}` : ''}` : t('common.localBuild'))}</b></div>
            <div className="aims-about-row"><span>{t('about.channel')}</span><b className="aims-mono">{b.channel ?? 'stable'}</b></div>
            <div className="aims-about-row"><span>{t('about.electron')}</span><b className="aims-mono">{info.electron || b.electron || '—'}</b></div>
            <div className="aims-about-row"><span>{t('about.platform')}</span><b className="aims-mono">{info.platform || navigator.platform || '—'}</b></div>
          </div>
          <div className="aims-about-update">
            <button type="button" className="aims-dlg-btn aims-dlg-btn--ghost" data-testid="about-update-check" disabled={update.status === 'loading'} onClick={checkUpdate}>
              {update.status === 'loading' ? t('about.checking') : t('about.checkUpdate')}
            </button>
            <span className={`aims-about-update-status ${update.status === 'update-available' ? 'is-new' : ''} ${update.status === 'error' ? 'is-error' : ''}`} data-testid="about-update-status" role="status">{updateLabel}</span>
          </div>
          {update.notes ? <p className="aims-about-note">{update.notes}</p> : null}
          <p className="aims-about-note">{t('about.note')}</p>
        </div>
        <footer className="aims-modal-foot">
          <span className="aims-modal-foot-hint">Esc</span>
          <div className="aims-modal-foot-actions">
            {typeof onOpenSettings === 'function' ? (
              <button type="button" className="aims-dlg-btn" data-testid="about-settings" onClick={onOpenSettings}>{t('about.settings')}</button>
            ) : null}
            <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" onClick={onClose}>{t('common.close')}</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
