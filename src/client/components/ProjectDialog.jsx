/**
 * 工程对话框（P1）：工程列表 / 新建（空工程·演示工程）/ 保存 / 另存为 / 打开 / 删除。
 *
 * 纯 UI + 宿主 actions 调用；不直接 fetch。数据通过 props.api 传入，便于测试与复用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconClose, IconFilePlus, IconFolder, IconTrash, IconCheck, IconAlert, IconSave,
  timeAgo,
} from './ui.jsx'
import { PROJECT_TEMPLATES } from '../../shared/templates.js'

const MODE_TITLE = {
  browse: '工程管理',
  new: '新建工程',
  saveAs: '另存为',
}

const fmtSize = (bytes) => {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

export function ProjectDialog({
  mode = 'browse',
  api = {},
  activeName = '',
  projectTitle = '',
  initialName = '',
  onClose,
  onComplete,
  onNotify,
}) {
  const [view, setView] = useState(mode)
  const [projects, setProjects] = useState([])
  const [serverActive, setServerActive] = useState(activeName)
  const [activeSavedAt, setActiveSavedAt] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [name, setName] = useState(initialName || (mode === 'saveAs' ? activeName || projectTitle : '新工程'))
  const [template, setTemplate] = useState('empty')
  const templateRef = useRef('empty')
  const autoCreateTimerRef = useRef(null)
  const [confirmDelete, setConfirmDelete] = useState('')
  const nameRef = useRef(null)
  const hasApi = typeof api.listProjects === 'function'

  const cancelAutoCreate = useCallback(() => {
    if (autoCreateTimerRef.current) {
      clearTimeout(autoCreateTimerRef.current)
      autoCreateTimerRef.current = null
    }
  }, [])
  useEffect(() => cancelAutoCreate, [cancelAutoCreate])

  const available = {
    list: typeof api.listProjects === 'function',
    create: typeof api.newProject === 'function',
    save: typeof api.saveProject === 'function',
    saveAs: typeof api.saveProjectAs === 'function',
    open: typeof api.openProject === 'function',
    remove: typeof api.deleteProject === 'function',
    versions: typeof api.listProjectVersions === 'function',
    restoreVersion: typeof api.restoreProjectVersion === 'function',
  }

  const [historyName, setHistoryName] = useState('')
  const [versionsByName, setVersionsByName] = useState({})
  const [versionsLoading, setVersionsLoading] = useState('')
  const [versionsError, setVersionsError] = useState('')
  const [confirmRestore, setConfirmRestore] = useState('')

  const refresh = useCallback(async () => {
    if (!available.list) return
    setLoading(true)
    setError('')
    try {
      const result = await api.listProjects()
      if (result && result.ok === false) {
        setError(result.error || '读取工程列表失败')
      } else if (result) {
        setProjects(Array.isArray(result.projects) ? result.projects : [])
        setServerActive(result.activeName || '')
        setActiveSavedAt(Number(result.activeSavedAt) || 0)
      }
    } catch (err) {
      setError('读取工程列表失败：' + (err?.message ?? err))
    } finally {
      setLoading(false)
    }
  }, [api, available.list])

  useEffect(() => { refresh() }, [refresh])

  // 模式切换（内部从 browse 进入 new）
  useEffect(() => { setView(mode) }, [mode])

  useEffect(() => {
    if (view !== 'browse' && nameRef.current) {
      const timer = setTimeout(() => nameRef.current?.focus(), 30)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [view])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onClose?.()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const notify = (text, tone) => onNotify?.(text, tone)

  const finish = (result) => {
    onComplete?.(result)
  }

  const doCreate = async () => {
    if (!available.create || busy) return
    cancelAutoCreate()
    const trimmed = name.trim()
    setBusy('create')
    setError('')
    try {
      const result = await api.newProject({ name: trimmed || undefined, template: templateRef.current })
      if (result && result.ok === false) {
        setError(result.error || '新建工程失败')
      } else {
        finish({ type: 'new', name: result?.activeName || trimmed })
      }
    } catch (err) {
      setError('新建工程失败：' + (err?.message ?? err))
    } finally {
      setBusy('')
    }
  }

  /* R5c：点击模板卡片后自动创建（保留“创建工程”按钮；输入工程名会取消自动创建，兼容旧流程）。 */
  const pickTemplate = (templateId) => {
    templateRef.current = templateId
    setTemplate(templateId)
    cancelAutoCreate()
    autoCreateTimerRef.current = setTimeout(() => {
      autoCreateTimerRef.current = null
      doCreate()
    }, 1200)
  }

  const doSaveAs = async () => {
    if (!available.saveAs || busy) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请输入工程名称')
      return
    }
    setBusy('saveAs')
    setError('')
    try {
      const result = await api.saveProjectAs(trimmed)
      if (result && result.ok === false) {
        setError(result.error || '保存失败')
      } else {
        finish({ type: 'saveAs', name: result?.activeName || trimmed })
      }
    } catch (err) {
      setError('保存失败：' + (err?.message ?? err))
    } finally {
      setBusy('')
    }
  }

  const doSaveCurrent = async () => {
    if (!available.save || busy) return
    setBusy('save')
    setError('')
    try {
      const result = await api.saveProject()
      if (result && result.ok === false) {
        setError(result.error || '保存失败')
      } else {
        finish({ type: 'save', name: result?.activeName })
      }
    } catch (err) {
      setError('保存失败：' + (err?.message ?? err))
    } finally {
      setBusy('')
    }
  }

  const doOpen = async (item) => {
    if (!available.open || busy) return
    setBusy(`open:${item.name}`)
    setError('')
    try {
      const result = await api.openProject(item.name)
      if (result && result.ok === false) {
        setError(result.error || '打开工程失败')
      } else {
        finish({ type: 'open', name: item.name })
      }
    } catch (err) {
      setError('打开工程失败：' + (err?.message ?? err))
    } finally {
      setBusy('')
    }
  }

  const doDelete = async (item) => {
    if (!available.remove || busy) return
    setBusy(`delete:${item.name}`)
    setError('')
    try {
      const result = await api.deleteProject(item.name)
      if (result && result.ok === false) {
        setError(result.error || '删除失败')
      } else {
        setConfirmDelete('')
        finish({ type: 'delete', name: item.name })
        await refresh()
      }
    } catch (err) {
      setError('删除失败：' + (err?.message ?? err))
    } finally {
      setBusy('')
    }
  }

  const startNew = () => {
    cancelAutoCreate()
    templateRef.current = 'empty'
    setName('新工程')
    setTemplate('empty')
    setError('')
    setView('new')
  }

  /* ── P14a：工程版本历史 ── */
  const formatVersionTime = (version) => {
    const at = Number(version?.at) || 0
    if (at > 0) {
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }
    return String(version?.timestamp || version?.id || '—')
  }

  const toggleHistory = async (item) => {
    if (!available.versions || busy) return
    const name = item.name
    if (historyName === name) {
      setHistoryName('')
      setConfirmRestore('')
      return
    }
    setHistoryName(name)
    setVersionsLoading(name)
    setVersionsError('')
    setConfirmRestore('')
    try {
      const result = await api.listProjectVersions(name)
      if (result && result.ok === false) {
        setVersionsError(result.error || '读取历史版本失败')
      } else {
        const versions = Array.isArray(result?.versions)
          ? result.versions
          : Array.isArray(result?.items) ? result.items : []
        setVersionsByName((prev) => ({ ...prev, [name]: versions }))
      }
    } catch (err) {
      setVersionsError('读取历史版本失败：' + (err?.message ?? err))
    } finally {
      setVersionsLoading('')
    }
  }

  const doRestoreVersion = async (item, version) => {
    if (!available.restoreVersion || busy) return
    const versionId = version?.id ?? version?.name ?? ''
    if (!versionId) return
    setBusy(`restore:${item.name}:${versionId}`)
    setError('')
    try {
      const result = await api.restoreProjectVersion(item.name, versionId)
      if (result && result.ok === false) {
        setError(result.error || '恢复历史版本失败')
      } else {
        notify('已恢复历史版本', 'info')
        finish({ type: 'restore', name: item.name })
      }
    } catch (err) {
      setError('恢复历史版本失败：' + (err?.message ?? err))
    } finally {
      setBusy('')
      setConfirmRestore('')
    }
  }

  const enterSaveAs = () => {
    setName(serverActive || activeName || projectTitle || '未命名工程')
    setError('')
    setView('saveAs')
  }

  return (
    <div
      className="aims-modal"
      role="dialog"
      aria-modal="true"
      data-testid="project-dialog"
      aria-label={MODE_TITLE[view]}
      onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.() }}
    >
      <div className="aims-modal-card aims-project-card" data-testid="project-dialog-card">
        <header className="aims-modal-head">
          <div className="aims-modal-title">
            <span className="aims-modal-icon"><IconFolder size={15} /></span>
            {MODE_TITLE[view]}
            {view === 'browse' && serverActive ? <span className="aims-modal-sub">当前：{serverActive}</span> : null}
          </div>
          <button type="button" className="aims-modal-close" aria-label="关闭" onClick={onClose} disabled={Boolean(busy)}>
            <IconClose size={14} />
          </button>
        </header>

        {!hasApi ? (
          <div className="aims-modal-body">
            <div className="aims-dialog-notice">
              <IconAlert size={16} />
              <div>
                <b>工程管理接口尚未就绪</b>
                <p>当前宿主没有提供工程 API（需重启独立窗口版或更新 P1 后端）。</p>
              </div>
            </div>
          </div>
        ) : view === 'browse' ? (
          <div className="aims-modal-body aims-dialog-body--list">
            <div className="aims-dialog-toolbar">
              <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" data-testid="project-new" onClick={startNew} disabled={!available.create || Boolean(busy)}>
                <IconFilePlus size={13} /> 新建工程
              </button>
              <button type="button" className="aims-dlg-btn" data-testid="project-save" onClick={doSaveCurrent} disabled={!available.save || Boolean(busy)}>
                <IconSave size={13} /> 保存当前
              </button>
              <button type="button" className="aims-dlg-btn" data-testid="project-save-as" onClick={enterSaveAs} disabled={!available.saveAs || Boolean(busy)}>
                另存为…
              </button>
              <button type="button" className="aims-dlg-btn aims-dlg-btn--ghost" data-testid="project-refresh" onClick={refresh} disabled={loading || Boolean(busy)}>
                刷新
              </button>
              <span className="aims-dialog-toolbar-meta">
                {activeSavedAt ? `最近保存 ${timeAgo(activeSavedAt)}` : '尚未手动保存'}
              </span>
            </div>

            <div className="aims-project-list" role="list">
              {loading && projects.length === 0 ? (
                <div className="aims-dialog-empty"><span className="aims-spinner" /> 正在读取工程列表…</div>
              ) : projects.length === 0 ? (
                <div className="aims-dialog-empty">
                  <IconFolder size={22} />
                  <b>还没有已保存的工程</b>
                  <span>点击「新建工程」创建空工程或演示工程；也可以在工具栏点保存。</span>
                </div>
              ) : (
                projects.map((item) => {
                  const isActive = item.name === serverActive
                  const deleting = confirmDelete === item.name
                  return (
                    <div className={`aims-project-item ${isActive ? 'is-active' : ''} ${historyName === item.name ? 'is-history-open' : ''}`} role="listitem" key={item.name} data-testid="project-item" data-project-name={item.name}>
                      <span className="aims-project-item-icon"><IconFolder size={16} /></span>
                      <div className="aims-project-item-main">
                        <div className="aims-project-item-title">
                          <span className="aims-project-item-name aims-mono">{item.name}</span>
                          {isActive ? <span className="aims-project-item-active"><IconCheck size={10} />当前</span> : null}
                        </div>
                        <div className="aims-project-item-meta">
                          <span>{item.title || '未命名作品'}</span>
                          <span className="aims-project-item-sep">·</span>
                          <span className="aims-mono">{item.bpm ?? '—'} BPM</span>
                          <span className="aims-project-item-sep">·</span>
                          <span className="aims-mono">{item.trackCount ?? 0} 轨</span>
                          <span className="aims-project-item-sep">·</span>
                          <span>更新于 {timeAgo(item.updatedAt)}</span>
                          <span className="aims-project-item-sep">·</span>
                          <span className="aims-mono">{fmtSize(item.size)}</span>
                        </div>
                      </div>
                      <div className="aims-project-item-actions">
                        {deleting ? (
                          <>
                            <span className="aims-project-item-confirm">确认删除？</span>
                            <button type="button" className="aims-dlg-btn aims-dlg-btn--danger" data-testid="project-delete-confirm" disabled={Boolean(busy)} onClick={() => doDelete(item)}>
                              删除
                            </button>
                            <button type="button" className="aims-dlg-btn aims-dlg-btn--ghost" disabled={Boolean(busy)} onClick={() => setConfirmDelete('')}>
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" data-testid="project-open" disabled={!available.open || Boolean(busy)} onClick={() => doOpen(item)}>
                              {busy === `open:${item.name}` ? '打开中…' : isActive ? '重新载入' : '打开'}
                            </button>
                            <button
                              type="button"
                              className="aims-dlg-btn aims-dlg-btn--ghost"
                              data-testid="project-history"
                              title="查看并恢复该工程的保存历史（最近 20 版）"
                              disabled={!available.versions || Boolean(busy)}
                              onClick={() => toggleHistory(item)}
                            >
                              历史
                            </button>
                            <button
                              type="button"
                              className="aims-dlg-btn aims-dlg-btn--ghost"
                              data-testid="project-delete"
                              title={isActive ? '删除当前工程后界面会切换到空状态' : '删除工程'}
                              disabled={!available.remove || Boolean(busy)}
                              onClick={() => setConfirmDelete(item.name)}
                            >
                              <IconTrash size={12} />
                            </button>
                          </>
                        )}
                      </div>
                      {historyName === item.name ? (
                        <div className="aims-project-history" data-testid="project-history-panel" data-project-name={item.name}>
                          <div className="aims-project-history-head">
                            <span className="aims-project-history-title">保存历史 · {item.name}</span>
                            <span className="aims-project-history-meta">最近 20 版 · 恢复前自动备份当前工程</span>
                            <button type="button" className="aims-project-history-close" data-testid="project-history-close" onClick={() => setHistoryName('')}>
                              收起
                            </button>
                          </div>
                          {versionsLoading === item.name ? (
                            <div className="aims-project-history-empty" data-testid="project-history-loading"><span className="aims-spinner" /> 正在读取历史版本…</div>
                          ) : versionsError ? (
                            <div className="aims-project-history-empty is-error" data-testid="project-history-error">{versionsError}</div>
                          ) : (versionsByName[item.name] ?? []).length === 0 ? (
                            <div className="aims-project-history-empty" data-testid="project-history-empty">暂无历史版本（保存工程后会生成，最多保留最近 20 版）</div>
                          ) : (
                            <div className="aims-project-version-list" role="list">
                              {(versionsByName[item.name] ?? []).map((version) => {
                                const versionId = version.id ?? version.timestamp ?? ''
                                const confirmKey = `${item.name}:${version.id}`
                                return (
                                  <div className="aims-project-version" role="listitem" key={versionId} data-testid="project-version-item" data-version-id={versionId}>
                                    <span className="aims-project-version-time aims-mono">{formatVersionTime(version)}</span>
                                    <span className="aims-project-version-title" title={version.title || item.name}>{version.title || item.name}</span>
                                    <span className="aims-project-version-size aims-mono">{fmtSize(version.bytes)}</span>
                                    {confirmRestore === confirmKey ? (
                                      <span className="aims-project-version-confirm">
                                        <span>确认恢复？</span>
                                        <button
                                          type="button"
                                          className="aims-dlg-btn aims-dlg-btn--primary"
                                          data-testid="project-version-restore-confirm"
                                          disabled={Boolean(busy)}
                                          onClick={() => doRestoreVersion(item, version)}
                                        >
                                          {busy === `restore:${item.name}:${versionId}` ? '恢复中…' : '恢复'}
                                        </button>
                                        <button type="button" className="aims-dlg-btn aims-dlg-btn--ghost" disabled={Boolean(busy)} onClick={() => setConfirmRestore('')}>
                                          取消
                                        </button>
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        className="aims-dlg-btn aims-dlg-btn--ghost"
                                        data-testid="project-version-restore"
                                        disabled={Boolean(busy)}
                                        onClick={() => setConfirmRestore(confirmKey)}
                                      >
                                        恢复
                                      </button>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        ) : view === 'new' ? (
          <div className="aims-modal-body">
            <div className="aims-dialog-field">
              <label className="aims-dialog-label" htmlFor="aims-project-name">工程名称</label>
              <input
                id="aims-project-name"
                ref={nameRef}
                className="aims-dialog-input"
                data-testid="project-name-input"
                value={name}
                maxLength={60}
                placeholder="例如：霓虹天际线"
                onChange={(e) => { cancelAutoCreate(); setName(e.target.value) }}
                onFocus={cancelAutoCreate}
                onKeyDown={(e) => { if (e.key === 'Enter') doCreate() }}
              />
              <span className="aims-dialog-hint">会保存为 projects/{name.trim() || '未命名工程'}.json（允许中英文、数字、空格、-、_）</span>
            </div>
            <div className="aims-dialog-field">
              <span className="aims-dialog-label">模板</span>
              <div className="aims-template-grid">
                {PROJECT_TEMPLATES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`aims-template-card ${template === item.id ? 'is-active' : ''}`}
                    data-testid={`project-template-${item.id}`}
                    data-template-id={item.id}
                    data-template-tracks={item.tracks.length}
                    data-template-bpm={item.bpm}
                    onClick={() => pickTemplate(item.id)}
                  >
                    <span className="aims-template-title">{item.name}</span>
                    <span className="aims-template-desc">{item.desc}</span>
                    <span className="aims-template-meta aims-mono">
                      {item.bpm} BPM · {item.tracks.length} 轨 · {item.lengthBars} 小节 · {item.key} {item.scale === 'minor' ? '小调' : '大调'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="aims-modal-body">
            <div className="aims-dialog-field">
              <label className="aims-dialog-label" htmlFor="aims-project-name">另存为</label>
              <input
                id="aims-project-name"
                ref={nameRef}
                className="aims-dialog-input"
                data-testid="project-name-input"
                value={name}
                maxLength={60}
                placeholder="工程名称"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doSaveAs() }}
              />
              <span className="aims-dialog-hint">保存后会切换为该工程；同名工程需要换一个名字。</span>
            </div>
          </div>
        )}

        {error ? (
          <div className="aims-dialog-error" role="alert">
            <IconAlert size={13} />
            {error}
          </div>
        ) : null}

        <footer className="aims-modal-foot">
          <span className="aims-modal-foot-hint">
            {view === 'browse' ? '双击列表项也可以打开工程' : 'Esc 取消'}
          </span>
          <div className="aims-modal-foot-actions">
            {view !== 'browse' ? (
              <button type="button" className="aims-dlg-btn aims-dlg-btn--ghost" disabled={Boolean(busy)} onClick={() => { setView('browse'); setError('') }}>
                返回
              </button>
            ) : null}
            <button type="button" className="aims-dlg-btn" disabled={Boolean(busy)} onClick={onClose}>
              关闭
            </button>
            {view === 'new' ? (
              <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" data-testid="project-create" disabled={!available.create || Boolean(busy)} onClick={() => { cancelAutoCreate(); doCreate() }}>
                {busy === 'create' ? '创建中…' : '创建工程'}
              </button>
            ) : view === 'saveAs' ? (
              <button type="button" className="aims-dlg-btn aims-dlg-btn--primary" data-testid="project-save-as-confirm" disabled={!available.saveAs || Boolean(busy)} onClick={doSaveAs}>
                {busy === 'saveAs' ? '保存中…' : '保存'}
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  )
}

export default ProjectDialog
