/**
 * v2.2 M4：导出对话框（格式 / 响度 / 文件名 + 外部插件自动冻结提示）。
 * 打开时若工程含 VST3 轨/效果器，明确提示导出前会自动冻结；missing 插件不会阻塞导出。
 */
import { useMemo, useState } from 'react'
import { IconClose, IconWave } from './ui.jsx'

export const EXPORT_DIALOG_FORMATS = [
  { id: 'wav', label: 'WAV（无损）' },
  { id: 'mp3', label: 'MP3（192kbps）' },
  { id: 'flac', label: 'FLAC（无损压缩）' },
]

function countExternalPlugins(project) {
  let tracks = 0
  let effects = 0
  let missing = 0
  for (const track of project?.tracks ?? []) {
    if (track?.engine === 'vst3' || track?.vst3) {
      tracks += 1
      if (track.vst3?.missing === true || track.missing === true) missing += 1
    }
    for (const effect of track?.effects ?? []) {
      if (effect?.type === 'vst3' || effect?.vst3) {
        effects += 1
        if (effect.vst3?.missing === true) missing += 1
      }
    }
  }
  return { tracks, effects, missing, total: tracks + effects }
}

export function ExportDialog({ project = null, defaultFormat = 'wav', onClose, onConfirm }) {
  const [format, setFormat] = useState(defaultFormat)
  const [name, setName] = useState(String(project?.title ?? '').trim() || '')
  const [targetLufs, setTargetLufs] = useState('')
  const [normalize, setNormalize] = useState(false)
  const external = useMemo(() => countExternalPlugins(project), [project])
  const hasExternal = external.total > 0

  const confirm = () => {
    const options = { format, download: true }
    if (name.trim()) options.name = name.trim()
    if (targetLufs !== '') {
      options.targetLufs = Number(targetLufs)
      options.normalize = false
    } else if (normalize) {
      options.normalize = true
    }
    onConfirm?.(options)
  }

  return (
    <div className="aims-modal" role="dialog" aria-modal="true" aria-label="导出" data-testid="export-dialog" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="aims-modal-card aims-export-card">
        <header className="aims-modal-head">
          <div className="aims-modal-title">
            <span className="aims-modal-icon"><IconWave size={15} /></span>
            导出
          </div>
          <button type="button" className="aims-modal-close" data-testid="export-cancel" aria-label="取消导出" onClick={onClose}><IconClose size={13} /></button>
        </header>
        <div className="aims-export-body">
          <div className="aims-export-row">
            <label className="aims-export-label" htmlFor="aims-export-format">格式</label>
            <select id="aims-export-format" className="aims-settings-select" data-testid="export-format" value={format} onChange={(e) => setFormat(e.target.value)}>
              {EXPORT_DIALOG_FORMATS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
          <div className="aims-export-row">
            <label className="aims-export-label" htmlFor="aims-export-name">文件名</label>
            <input id="aims-export-name" className="aims-plugin-path-input" data-testid="export-name" placeholder="留空自动生成（工程名 + 时间戳）" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="aims-export-row">
            <label className="aims-export-label" htmlFor="aims-export-lufs">响度</label>
            <select id="aims-export-lufs" className="aims-settings-select" data-testid="export-target-lufs" value={targetLufs} onChange={(e) => { setTargetLufs(e.target.value); if (e.target.value !== '') setNormalize(false) }}>
              <option value="">不归一（保持混音）</option>
              <option value="-14">流媒体 -14 LUFS</option>
              <option value="-9">俱乐部 -9 LUFS</option>
            </select>
          </div>
          <label className="aims-export-check">
            <input type="checkbox" data-testid="export-normalize" checked={normalize} disabled={targetLufs !== ''} onChange={(e) => setNormalize(e.target.checked)} />
            <span>峰值归一化（targetLufs 优先）</span>
          </label>
          {hasExternal ? (
            <div className="aims-export-freeze" data-testid="export-freeze-notice" role="status">
              <b>外部插件将自动冻结</b>
              <span>
                检测到 {external.tracks} 条 VST3 轨、{external.effects} 个 VST3 效果器；导出前会先离线冻结为音频缓存（M4），
                {external.missing > 0 ? `其中 ${external.missing} 个插件缺失，缺失引用将保持静音/旁路。` : '冻结失败会以中文提示并中止导出。'}
              </span>
            </div>
          ) : (
            <div className="aims-export-note" data-testid="export-no-external">没有外部 VST3 插件，将直接离线渲染。</div>
          )}
        </div>
        <footer className="aims-modal-foot">
          <span className="aims-modal-foot-hint">导出在后台离线渲染；完成后提示保存路径</span>
          <div className="aims-modal-foot-actions">
            <button type="button" className="aims-dlg-btn" data-testid="export-cancel-footer" onClick={onClose}>取消</button>
            <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" data-testid="export-confirm" onClick={confirm}>开始导出</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
