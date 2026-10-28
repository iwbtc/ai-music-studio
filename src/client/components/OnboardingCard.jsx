/** R7a/R7c：首次启动新手引导（非阻塞横幅，localStorage aims:onboarding:v2）。 */
import { IconSparkle, IconClose } from './ui.jsx'
import { useI18n } from '../i18n.js'

export const ONBOARDING_STORAGE_KEY = 'aims:onboarding:v2'

export function OnboardingCard({ onStart, onDismiss }) {
  const { t } = useI18n()
  return (
    <aside className="aims-onboarding" data-testid="onboarding-card" role="status" aria-label={t('onboarding.title')}>
      <span className="aims-onboarding-icon"><IconSparkle size={16} /></span>
      <div className="aims-onboarding-main">
        <div className="aims-onboarding-title">{t('onboarding.title')}</div>
        <ol className="aims-onboarding-steps">
          <li>{t('onboarding.step1')}</li>
          <li>{t('onboarding.step2')}</li>
          <li>{t('onboarding.step3')}</li>
        </ol>
      </div>
      <div className="aims-onboarding-actions">
        <button type="button" className="aims-onboarding-btn is-primary" data-testid="onboarding-start" onClick={onStart}>{t('common.start')}</button>
        <button type="button" className="aims-onboarding-btn" data-testid="onboarding-dismiss" onClick={onDismiss}>{t('common.dismiss')}</button>
      </div>
      <button type="button" className="aims-onboarding-icon-close" data-testid="onboarding-close" aria-label={t('common.close')} title={t('common.close')} onClick={onDismiss}><IconClose size={11} /></button>
    </aside>
  )
}
