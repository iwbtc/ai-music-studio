/**
 * v2.2 M1：外部插件管理器（扫描 / 导入 / 列表 / 卸载）。
 * M1 仅管理引用与参数展示，实时音频在 M2 接入。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconClose, IconSparkle } from './ui.jsx'

export const EXTERNAL_PLUGIN_BASE = '/studio/api/plugins/external'

/** 统一外部插件请求；404/405 视为后端未启用。 */
export async function externalPluginRequest(path, options = {}) {
  const res = await fetch(EXTERNAL_PLUGIN_BASE + path, {
    cache: 'no-store',
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })
  const contentType = res.headers.get('content-type') ?? ''
  const data = contentType.includes('application/json') ? await res.json().catch(() => null) : null
  if (data?.code === 'PLUGIN_HOST_UNAVAILABLE' || data?.code === 'PLUGIN_BACKEND_UNAVAILABLE') {
    const error = new Error(data?.error || '外部插件需要桌面版/后端未启用')
    error.code = 'PLUGIN_BACKEND_UNAVAILABLE'
    throw error
  }
  if (res.status === 404 || res.status === 405) {
    const error = new Error('外部插件需要桌面版/后端未启用')
    error.code = 'PLUGIN_BACKEND_UNAVAILABLE'
    throw error
  }
  if (!res.ok || data?.ok === false) {
    const error = new Error(data?.error || `外部插件请求失败（HTTP ${res.status}）`)
    error.code = 'PLUGIN_REQUEST_FAILED'
    throw error
  }
  return data ?? { ok: true }
}

export const externalPluginApi = {
  list: () => externalPluginRequest(''),
  scan: (body = {}) => externalPluginRequest('/scan', { method: 'POST', body: JSON.stringify(body) }),
  install: (filePath) => externalPluginRequest('/install', { method: 'POST', body: JSON.stringify({ path: filePath }) }),
  uninstall: (pluginId) => externalPluginRequest('/uninstall', { method: 'POST', body: JSON.stringify({ pluginId }) }),
  parameters: (pluginId) => externalPluginRequest(`/parameters?pluginId=${encodeURIComponent(pluginId)}`),
  addTrack: (pluginId, name) => externalPluginRequest('/add-track', { method: 'POST', body: JSON.stringify({ pluginId, ...(name ? { name } : {}) }) }),
  addEffect: (trackId, pluginId) => externalPluginRequest('/add-effect', { method: 'POST', body: JSON.stringify({ trackId, pluginId }) }),
  setParam: (pluginId, paramId, value) => externalPluginRequest('/set-param', { method: 'POST', body: JSON.stringify({ pluginId, paramId, value }) }),
  bypass: (target, bypass) => externalPluginRequest('/bypass', { method: 'POST', body: JSON.stringify({ ...target, bypass }) }),
}

function pluginCategory(plugin) {
  if (plugin?.category) return String(plugin.category)
  if (plugin?.isInstrument) return 'Instrument'
  if (plugin?.isEffect) return 'Effect'
  return 'Unknown'
}

export function PluginManager({ onClose, onNotify, onChanged }) {
  const [plugins, setPlugins] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [backendUnavailable, setBackendUnavailable] = useState(false)
  const [installPath, setInstallPath] = useState('')
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    try {
      const data = await externalPluginApi.list()
      if (!mountedRef.current) return
      const list = Array.isArray(data?.plugins) ? data.plugins : Array.isArray(data) ? data : []
      setPlugins(list)
      setBackendUnavailable(false)
      setError('')
    } catch (err) {
      if (!mountedRef.current) return
      if (err?.code === 'PLUGIN_BACKEND_UNAVAILABLE') setBackendUnavailable(true)
      setError(err?.message ?? String(err))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const run = async (action, successMessage) => {
    if (busy) return
    setBusy(action)
    setError('')
    try {
      const result = await action()
      if (successMessage) onNotify?.(successMessage, 'success')
      await load({ silent: true })
      onChanged?.(result)
      return result
    } catch (err) {
      if (err?.code === 'PLUGIN_BACKEND_UNAVAILABLE') setBackendUnavailable(true)
      setError(err?.message ?? String(err))
      return null
    } finally {
      if (mountedRef.current) setBusy('')
    }
  }

  const scan = () => run(() => externalPluginApi.scan({ includeDefaults: true }), '外部插件扫描完成')
  const install = async () => {
    const path = installPath.trim()
    if (!path) { setError('请先填写 .vst3 文件或目录路径'); return }
    const result = await run(() => externalPluginApi.install(path).then((payload) => { setInstallPath(''); return payload }), '外部插件已导入')
    const plugin = result?.plugin ?? null
    if (plugin) {
      const pluginId = plugin.pluginId ?? plugin.id
      setPlugins((prev) => {
        const rest = prev.filter((item) => (item.pluginId ?? item.id) !== pluginId)
        return [plugin, ...rest]
      })
    }
  }
  const uninstall = async (pluginId) => {
    const result = await run(() => externalPluginApi.uninstall(pluginId), '外部插件已卸载（工程引用保留为 missing）')
    if (result?.removed) setPlugins((prev) => prev.filter((item) => (item.pluginId ?? item.id) !== pluginId))
  }

  return (
    <div className="aims-modal" role="dialog" aria-modal="true" aria-label="外部插件管理" data-testid="plugin-manager" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="aims-modal-card aims-plugin-manager-card">
        <header className="aims-modal-head">
          <div className="aims-modal-title">
            <span className="aims-modal-icon"><IconSparkle size={15} /></span>
            外部插件管理
            <span className="aims-plugin-manager-badge aims-mono">VST3 · M1</span>
          </div>
          <button type="button" className="aims-modal-close" data-testid="plugin-close" aria-label="关闭外部插件管理" onClick={onClose}><IconClose size={13} /></button>
        </header>
        <div className="aims-plugin-manager-toolbar">
          <button type="button" className="aims-dlg-btn" data-testid="plugin-scan" disabled={Boolean(busy) || backendUnavailable} onClick={scan}>
            {busy === 'scan' ? '扫描中…' : '扫描 VST3'}
          </button>
          <input
            type="text"
            className="aims-plugin-path-input"
            data-testid="plugin-path"
            placeholder=".vst3 文件或目录路径（开发版可从本机导入）"
            aria-label="VST3 文件或目录路径"
            value={installPath}
            onChange={(e) => setInstallPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') install() }}
          />
          <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" data-testid="plugin-install" disabled={Boolean(busy) || backendUnavailable} onClick={install}>
            {busy === 'install' ? '导入中…' : '导入'}
          </button>
          <button type="button" className="aims-dlg-btn" data-testid="plugin-refresh" disabled={Boolean(busy)} onClick={() => load()}>刷新</button>
        </div>
        {backendUnavailable ? (
          <div className="aims-plugin-note" role="status">外部插件需要桌面版/后端未启用。M1 实时音频将在后续版本接入。</div>
        ) : null}
        {error ? <div className="aims-settings-error" role="alert">{error}</div> : null}
        <div className="aims-plugin-manager-list" role="list" aria-label="外部插件列表">
          {loading ? <div className="aims-plugin-empty">正在读取外部插件…</div>
            : plugins.length === 0 ? <div className="aims-plugin-empty">还没有外部插件。点击「扫描 VST3」或输入路径导入。</div>
              : plugins.map((plugin) => {
                const pluginId = plugin.pluginId ?? plugin.id ?? plugin.classId ?? plugin.name
                const missing = plugin.missing === true || plugin.available === false
                return (
                  <div key={pluginId} className="aims-plugin-manager-item" data-testid={`plugin-item-${pluginId}`} data-missing={missing ? 'true' : 'false'} role="listitem">
                    <span className={`aims-plugin-manager-dot ${missing ? 'is-missing' : ''}`} aria-hidden="true" />
                    <div className="aims-plugin-manager-main">
                      <div className="aims-plugin-manager-name">{plugin.name ?? pluginId}{missing ? <span className="aims-plugin-missing">missing</span> : null}</div>
                      <div className="aims-plugin-manager-meta">
                        {plugin.vendor ? <span>{plugin.vendor}</span> : null}
                        {plugin.version ? <span>v{plugin.version}</span> : null}
                        <span>{pluginCategory(plugin)}</span>
                        {plugin.classId ? <span className="aims-mono" title={plugin.classId}>{String(plugin.classId).slice(0, 10)}</span> : null}
                      </div>
                    </div>
                    <button type="button" className="aims-plugin-uninstall" data-testid={`plugin-uninstall-${pluginId}`} disabled={Boolean(busy)} onClick={() => uninstall(pluginId)} title="卸载托管副本（工程引用保留为 missing）">卸载</button>
                  </div>
                )
              })}
        </div>
        <footer className="aims-modal-foot">
          <span className="aims-modal-foot-hint">只删除托管副本，不动工程；M1 插件音频实时处理在 M2 接入</span>
          <div className="aims-modal-foot-actions">
            <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" onClick={onClose}>完成</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
