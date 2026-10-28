/**
 * 顶部菜单栏（P1）：文件 / 编辑 / 视图 / 帮助 + 工程名与保存状态。
 *
 * 菜单是个纯受控的轻量下拉：点击打开、悬停切换、Esc/点击外部关闭；
 * 所有实际动作通过 onCommand(id) 交给 App 处理，菜单本身不碰后端。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconCheck, IconChevronDown, IconClose, IconHelp, IconSparkle,
} from './ui.jsx'
import { useI18n, useDialogA11y } from '../i18n.js'

const SEP = { sep: true }

function buildMenus({ activeTab, layout = null, showRightRail = true, canUndo, canRedo, undoLabel, redoLabel }) {
  const collapsed = layout?.collapsed ?? {}
  const compact = Boolean(layout?.compact)
  const rightVisible = layout ? !collapsed.rightRail : showRightRail
  return [
    {
      id: 'file',
      label: '文件',
      items: [
        { id: 'new', label: '新建工程…', shortcut: 'Ctrl+N' },
        { id: 'open', label: '打开工程…', shortcut: 'Ctrl+O' },
        { id: 'save', label: '保存', shortcut: 'Ctrl+S' },
        { id: 'saveAs', label: '另存为…', shortcut: 'Ctrl+Shift+S' },
        SEP,
        { id: 'exportWav', label: '导出 WAV（整首渲染）' },
        { id: 'exportMp3', label: '导出 MP3（192kbps）', testId: 'menu-export-mp3' },
        { id: 'exportFlac', label: '导出 FLAC（无损）', testId: 'menu-export-flac' },
        { id: 'exportMidi', label: '导出 MIDI（.mid）' },
        { id: 'exportStems', label: '导出分轨…（每轨 WAV）', testId: 'menu-export-stems' },
        SEP,
        { id: 'exportLufs', label: '导出 WAV（−14 LUFS 目标）…', testId: 'menu-export-lufs' },
        SEP,
        { id: 'importAudio', label: '导入音频…', testId: 'menu-import-audio' },
        { id: 'importMidi', label: '导入 MIDI…', testId: 'menu-import-midi' },
        { id: 'importReference', label: '导入参考曲…', testId: 'menu-import-reference' },
        SEP,
        { id: 'projects', label: '工程管理…' },
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        { id: 'undo', label: undoLabel ? `撤销「${undoLabel}」` : '撤销', shortcut: 'Ctrl+Z', disabled: !canUndo },
        { id: 'redo', label: redoLabel ? `重做「${redoLabel}」` : '重做', shortcut: 'Ctrl+Y', disabled: !canRedo },
        SEP,
        { id: 'copy', label: '复制', shortcut: 'Ctrl+C' },
        { id: 'paste', label: '粘贴', shortcut: 'Ctrl+V' },
        { id: 'delete', label: '删除', shortcut: 'Delete' },
        { id: 'splitAudio', label: '在播放头处分割音频片段', shortcut: 'Ctrl+E' },
        { id: 'selectAll', label: '全选', shortcut: 'Ctrl+A' },
        SEP,
        { id: 'quantize', label: '量化到网格', shortcut: 'Q' },
      ],
    },
    {
      id: 'view',
      label: '视图',
      items: [
        { id: 'command-palette', label: '命令面板…', shortcut: 'Ctrl+K' },
        SEP,
        { id: 'view:playlist', label: '播放列表', check: activeTab === 'playlist' },
        { id: 'view:pianoroll', label: '钢琴卷帘', check: activeTab === 'pianoroll' },
        { id: 'view:mixer', label: '混音台', check: activeTab === 'mixer' },
        { id: 'view:fx', label: '效果器', check: activeTab === 'fx' },
        { id: 'view:automation', label: '自动化', shortcut: 'A', check: activeTab === 'automation' },
        SEP,
        { id: 'zoomIn', label: '钢琴卷帘放大', shortcut: 'H' },
        { id: 'zoomOut', label: '钢琴卷帘缩小', shortcut: 'Shift+H' },
        { id: 'zoomReset', label: '重置钢琴卷帘缩放' },
        SEP,
        { id: 'toggleRightRail', label: rightVisible ? '隐藏右栏' : '显示右栏', check: rightVisible },
        { id: 'layout:toggleLeft', label: collapsed.leftRail ? '显示左栏' : '隐藏左栏', check: !collapsed.leftRail },
        SEP,
        { id: 'layout:togglePlugin', label: collapsed.pluginBrowser ? '展开插件库' : '折叠插件库', check: !collapsed.pluginBrowser },
        { id: 'layout:toggleAiFeed', label: collapsed.aiFeed ? '展开 AI 创作动态' : '折叠 AI 创作动态', check: !collapsed.aiFeed },
        { id: 'layout:toggleProjectStats', label: collapsed.projectStats ? '展开项目统计' : '折叠项目统计', check: !collapsed.projectStats },
        { id: 'layout:toggleSpectrum', label: collapsed.spectrum ? '展开 Master 频谱' : '折叠 Master 频谱', check: !collapsed.spectrum },
        SEP,
        { id: 'layout:compact', label: '紧凑模式', check: compact },
        { id: 'layout:reset', label: '重置布局' },
      ],
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        { id: 'help', label: '帮助中心…' },
        { id: 'settings', label: '设置…' },
        { id: 'shortcuts', label: '快捷键列表…', shortcut: '?' },
        { id: 'about', label: '关于 AI 音乐工作室' },
      ],
    },
  ]
}

export function MenuBar({
  projectName = '', projectTitle = '', saveState = 'saved', standalone = false,
  canUndo = false, canRedo = false, undoLabel = '', redoLabel = '',
  activeTab = 'playlist', showRightRail = true, layout = null,
  onCommand = () => {},
}) {
  const [openId, setOpenId] = useState(null)
  const barRef = useRef(null)
  const { t } = useI18n()
  const MENU_LABEL_KEYS = { file: 'menu.file', edit: 'menu.edit', view: 'menu.view', help: 'menu.help' }
  const ITEM_LABEL_KEYS = {
    new: 'menu.new', open: 'menu.open', save: 'menu.save', saveAs: 'menu.saveAs',
    exportWav: 'menu.exportWav', exportMidi: 'menu.exportMidi', importAudio: 'menu.importAudio',
    importMidi: 'menu.importMidi', projects: 'menu.projects', undo: 'menu.undo', redo: 'menu.redo',
    settings: 'menu.settings', about: 'menu.about', help: 'menu.helpCenter',
    shortcuts: 'menu.shortcuts', 'command-palette': 'menu.commandPalette',
  }
  const menus = buildMenus({ activeTab, layout, showRightRail, canUndo, canRedo, undoLabel, redoLabel }).map((menu) => ({
    ...menu,
    label: MENU_LABEL_KEYS[menu.id] ? t(MENU_LABEL_KEYS[menu.id]) : menu.label,
    items: menu.items.map((item) => (!item.sep && ITEM_LABEL_KEYS[item.id] ? { ...item, label: t(ITEM_LABEL_KEYS[item.id]) } : item)),
  }))

  // 点击外部 / Esc 关闭菜单
  useEffect(() => {
    if (!openId) return undefined
    const onPointerDown = (event) => {
      if (barRef.current && !barRef.current.contains(event.target)) setOpenId(null)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpenId(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openId])

  const run = useCallback((item) => {
    if (!item || item.disabled) return
    setOpenId(null)
    onCommand(item.id)
  }, [onCommand])

  const saveLabel = saveState === 'dirty' ? '未保存' : saveState === 'saving' ? '保存中…' : '已保存'

  return (
    <div className="aims-menubar" ref={barRef} role="menubar" aria-label="主菜单">
      <div className="aims-menubar-left">
        {menus.map((menu) => {
          const open = openId === menu.id
          return (
            <div className="aims-menu" key={menu.id}>
              <button
                type="button"
                className={`aims-menu-btn ${open ? 'is-open' : ''}`}
                data-testid={menu.id === 'file' ? 'menu-file' : menu.id === 'edit' ? 'menu-edit' : `menu-${menu.id}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpenId((prev) => (prev === menu.id ? null : menu.id))}
                onMouseEnter={() => { if (openId) setOpenId(menu.id) }}
              >
                {menu.label}
                <IconChevronDown size={9} className="aims-menu-caret" />
              </button>
              {open ? (
                <div className="aims-menu-dropdown" role="menu" aria-label={menu.label}>
                  {menu.items.map((item, index) => {
                    if (item.sep) return <div className="aims-menu-sep" key={`sep-${index}`} role="separator" />
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        className={`aims-menu-item ${item.disabled ? 'is-disabled' : ''}`}
                        data-testid={item.testId || `menu-item-${item.id}`}
                        disabled={item.disabled}
                        onClick={() => run(item)}
                        title={item.label}
                      >
                        <span className="aims-menu-check">{item.check ? <IconCheck size={11} /> : null}</span>
                        <span className="aims-menu-label">{item.label}</span>
                        {item.shortcut ? <span className="aims-menu-shortcut aims-mono">{item.shortcut}</span> : null}
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="aims-menubar-center">
        <span className="aims-menubar-app">
          <IconSparkle size={11} />
          AI 音乐工作室
        </span>
        <span className="aims-menubar-divider" aria-hidden="true" />
        <span className="aims-menubar-project" title={`当前工程：${projectName || projectTitle || '未命名工程'}`}>
          {projectName || projectTitle || '未命名工程'}
        </span>
        <span className={`aims-menubar-save is-${saveState}`} title={saveLabel}>
          <span className="aims-menubar-save-dot" />
          {saveLabel}
        </span>
        {standalone ? <span className="aims-menubar-badge" title="独立窗口版">独立版</span> : null}
      </div>

      <div className="aims-menubar-right">
        <button
          type="button"
          className="aims-menubar-textbtn"
          data-testid="settings-topbar"
          title={t('settings.title')}
          aria-label={t('settings.title')}
          onClick={() => onCommand('settings')}
        >
          {t('menu.settings')}
        </button>
        <button
          type="button"
          className="aims-menubar-iconbtn"
          title="快捷键列表（?）"
          aria-label="快捷键列表"
          onClick={() => onCommand('shortcuts')}
        >
          <IconHelp size={14} />
        </button>
      </div>
    </div>
  )
}

const SHORTCUT_GROUPS = [
  {
    title: '走带',
    items: [
      ['Space', '播放 / 停止'],
      ['Home', '回到开头'],
    ],
  },
  {
    title: '编辑',
    items: [
      ['Ctrl+Z', '撤销'],
      ['Ctrl+Y', '重做'],
      ['Ctrl+C', '复制（钢琴卷帘：音符 / 播放列表：片段）'],
      ['Ctrl+V', '粘贴（钢琴卷帘）'],
      ['Ctrl+D', '复制片段（播放列表）'],
      ['Ctrl+A', '全选'],
      ['Delete', '删除选中'],
      ['Q', '量化到当前网格'],
      ['Shift+拖动', '框选音符（钢琴卷帘）'],
    ],
  },
  {
    title: '工程',
    items: [
      ['Ctrl+N', '新建工程'],
      ['Ctrl+O', '打开工程'],
      ['Ctrl+S', '保存'],
      ['Ctrl+Shift+S', '另存为'],
      ['文件 → 导入 MIDI', '导入 .mid 为轨道 / pattern / clip（替换当前工程）'],
      ['文件 → 导入参考曲', '作为参考音轨参与 A/B 对照（默认静音）'],
      ['文件 → 导出 MP3 / FLAC', 'MP3 192kbps / FLAC 无损；分轨仍为 WAV'],
      ['文件 → 导出 WAV（−14 LUFS）', '按目标 LUFS 增益后导出，峰值限制 ≤0.98'],
      ['工程管理 → 历史', '查看并恢复最近 20 个保存版本'],
    ],
  },
  {
    title: '效果器 / 侧链',
    items: [
      ['拖动旋钮', '效果器参数（松手一次性写回）'],
      ['↑ / ↓', '效果器链顺序（更靠前 / 更靠后处理）'],
      ['卡片开关', '启用 / 旁通效果器'],
      ['SC 按钮', '混音台 → 侧链（来源轨道 / 压缩量 / attack / release）'],
      ['文件 → 导出分轨', '每轨一个 WAV（含效果器与 Master 链）'],
    ],
  },
  {
    title: '音频片段',
    items: [
      ['左边缘拖动', '裁切片段开头（保留媒体 offset）'],
      ['Ctrl+E', '在播放头处分割音频片段'],
      ['双击', '音频片段不打开钢琴卷帘（仅提示）'],
    ],
  },
  {
    title: '视图 / 缩放',
    items: [
      ['A', '切换到自动化视图'],
      ['H', '钢琴卷帘放大'],
      ['Shift+H', '钢琴卷帘缩小'],
      ['Shift+滚轮', '钢琴卷帘横向滚动'],
      ['Ctrl+滚轮', '窗口界面缩放（独立版）'],
      ['?', '打开本快捷键列表'],
    ],
  },
]

/** 快捷键 / 关于对话框。 */
export function ShortcutsDialog({ onClose }) {
  const { t } = useI18n()
  const cardRef = useRef(null)
  useDialogA11y(true, onClose, cardRef)
  return (
    <div className="aims-modal" role="dialog" aria-modal="true" aria-label={t('menu.shortcuts')} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="aims-modal-card aims-shortcuts-card" ref={cardRef}>
        <header className="aims-modal-head">
          <div className="aims-modal-title">
            <span className="aims-modal-icon"><IconHelp size={15} /></span>
            {t('menu.shortcuts')}
          </div>
          <button type="button" className="aims-modal-close" aria-label={t('common.close')} onClick={onClose}>
            <IconClose size={14} />
          </button>
        </header>
        <div className="aims-modal-body aims-shortcuts-body">
          <div className="aims-shortcuts-grid">
            {SHORTCUT_GROUPS.map((group) => (
              <section className="aims-shortcuts-group" key={group.title}>
                <h3 className="aims-shortcuts-title">{group.title}</h3>
                <dl className="aims-shortcuts-list">
                  {group.items.map(([keys, text]) => (
                    <div className="aims-shortcut-row" key={keys + text}>
                      <dt><kbd>{keys}</kbd></dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <footer className="aims-shortcuts-foot">
            <span>AI 音乐工作室 v1.0 · 独立窗口版 / DSH 插件共用同一套界面</span>
            <span className="aims-mono">P1 EDIT</span>
          </footer>
        </div>
      </div>
    </div>
  )
}
