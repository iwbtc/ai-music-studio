/** R7b/R7c：设置对话框（通道 / 遥测 / 崩溃报告 / 语言）+ 无障碍。 */
import { useEffect, useRef, useState } from 'react'
import { IconClose, IconSparkle } from './ui.jsx'
import { useDialogA11y, useI18n } from '../i18n.js'

const DEFAULTS = { channel: 'stable', telemetryOptIn: false, crashReports: true, language: 'zh-CN' }

export function SettingsDialog({ onClose, onNotify, onLocaleChange }) {
  const { t } = useI18n()
  const cardRef = useRef(null)
  useDialogA11y(true, onClose, cardRef)
  const [settings, setSettings] = useState(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/studio/api/settings', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const src = data?.settings && typeof data.settings === 'object' ? data.settings : data
        setSettings({
          channel: src?.channel === 'beta' ? 'beta' : 'stable',
          telemetryOptIn: src?.telemetryOptIn === true,
          crashReports: src?.crashReports !== false,
          language: src?.language === 'en-US' ? 'en-US' : 'zh-CN',
        })
      })
      .catch(() => { if (!cancelled) setError(t('settings.loadFailed')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/studio/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data?.error || t('settings.saveFailed'))
      onNotify?.(t('settings.saved'), 'success')
      onClose?.()
    } catch (err) {
      setError(err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  const patch = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }))

  return (
    <div className="aims-modal" role="dialog" aria-modal="true" aria-label={t('settings.title')} data-testid="settings-dialog" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="aims-modal-card aims-settings-card" ref={cardRef}>
        <header className="aims-modal-head">
          <div className="aims-modal-title">
            <span className="aims-modal-icon"><IconSparkle size={15} /></span>
            {t('settings.title')}
          </div>
          <button type="button" className="aims-modal-close" data-testid="settings-close" aria-label="关闭设置" onClick={onClose}><IconClose size={13} /></button>
        </header>
        <div className="aims-settings-body">
          {loading ? <div className="aims-settings-loading">正在读取设置…</div> : (
            <>
              <div className="aims-settings-row">
                <div className="aims-settings-copy">
                  <label className="aims-settings-label" htmlFor="aims-settings-channel">{t('settings.channel')}</label>
                  <span className="aims-settings-hint">{t('settings.channelHint')}</span>
                </div>
                <select id="aims-settings-channel" className="aims-settings-select" data-testid="settings-channel" value={settings.channel} onChange={(e) => patch('channel', e.target.value)}>
                  <option value="stable">{t('common.stable')} · stable</option>
                  <option value="beta">{t('common.beta')} · beta</option>
                </select>
              </div>
              <div className="aims-settings-row">
                <div className="aims-settings-copy">
                  <label className="aims-settings-label" htmlFor="aims-settings-language">{t('settings.language')}</label>
                  <span className="aims-settings-hint">{t('settings.languageHint')}</span>
                </div>
                <select id="aims-settings-language" className="aims-settings-select" data-testid="settings-language" value={settings.language} onChange={(e) => { patch('language', e.target.value); onLocaleChange?.(e.target.value) }}>
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </div>
              <div className="aims-settings-row">
                <div className="aims-settings-copy">
                  <label className="aims-settings-label" htmlFor="aims-settings-telemetry">{t('settings.telemetry')}</label>
                  <span className="aims-settings-hint">{t('settings.telemetryHint')}</span>
                </div>
                <input id="aims-settings-telemetry" type="checkbox" className="aims-settings-check" data-testid="settings-telemetry" checked={settings.telemetryOptIn} onChange={(e) => patch('telemetryOptIn', e.target.checked)} />
              </div>
              <div className="aims-settings-row">
                <div className="aims-settings-copy">
                  <label className="aims-settings-label" htmlFor="aims-settings-crash">{t('settings.crash')}</label>
                  <span className="aims-settings-hint">{t('settings.crashHint')}</span>
                </div>
                <input id="aims-settings-crash" type="checkbox" className="aims-settings-check" data-testid="settings-crash" checked={settings.crashReports} onChange={(e) => patch('crashReports', e.target.checked)} />
              </div>
            </>
          )}
          {error ? <div className="aims-settings-error" role="alert">{error}</div> : null}
        </div>
        <footer className="aims-modal-foot">
          <span className="aims-modal-foot-hint">{t('settings.localOnly')}</span>
          <div className="aims-modal-foot-actions">
            <button type="button" className="aims-dlg-btn" data-testid="settings-cancel" disabled={saving} onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" data-testid="settings-save" disabled={saving || loading} onClick={save}>{saving ? t('common.saving') : t('common.save')}</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
