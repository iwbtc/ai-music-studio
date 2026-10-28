/**
 * R7c：核心外壳轻量 i18n（zh-CN / en-US）。
 *
 * - 只覆盖主菜单/工具栏关键动作、About/Help/Settings/Onboarding/CommandPalette、
 *   常用按钮/状态/空状态；专业面板细项仍保留中文。
 * - `t(key, vars)`：当前语言 → zh-CN → key 回退；`{name}` 插值。
 * - data-testid 不随语言变化。
 */
import { createContext, useContext, useEffect } from 'react'

export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en-US'])
export const DEFAULT_LOCALE = 'zh-CN'

export const MESSAGES = Object.freeze({
  'zh-CN': Object.freeze({
    'app.name': 'AI 音乐工作室',
    'app.subtitle': 'DeepSeek AI Music Studio · 独立窗口版',
    'app.local': '本地运行 · 工程数据保存在本机',
    'menu.file': '文件',
    'menu.edit': '编辑',
    'menu.view': '视图',
    'menu.help': '帮助',
    'menu.new': '新建工程…',
    'menu.open': '打开工程…',
    'menu.save': '保存',
    'menu.saveAs': '另存为…',
    'menu.exportWav': '导出 WAV…',
    'menu.exportMidi': '导出 MIDI…',
    'menu.importAudio': '导入音频…',
    'menu.importMidi': '导入 MIDI…',
    'menu.projects': '工程管理…',
    'menu.undo': '撤销',
    'menu.redo': '重做',
    'menu.settings': '设置…',
    'menu.about': '关于 AI 音乐工作室',
    'menu.helpCenter': '帮助中心…',
    'menu.shortcuts': '快捷键列表…',
    'menu.commandPalette': '命令面板…',
    'menu.toggleSpectrum': '折叠 / 展开 Master 频谱',
    'menu.resetLayout': '重置布局',
    'menu.compact': '紧凑模式',
    'common.close': '关闭',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.saving': '保存中…',
    'common.ok': '知道了',
    'common.back': '返回',
    'common.loading': '载入中…',
    'common.unknown': '未知',
    'common.localBuild': '本地构建',
    'common.stable': '稳定版',
    'common.beta': '测试版',
    'common.enabled': '已启用',
    'common.disabled': '已关闭',
    'common.copy': '复制',
    'common.retry': '重试',
    'common.dismiss': '稍后',
    'common.start': '开始创作',
    'about.title': '关于 AI 音乐工作室',
    'about.version': '版本',
    'about.build': '构建',
    'about.channel': '渠道',
    'about.electron': 'Electron',
    'about.platform': '平台',
    'about.update': '更新',
    'about.checkUpdate': '检查更新',
    'about.checking': '检查中…',
    'about.notChecked': '未检查',
    'about.upToDate': '已是最新',
    'about.updateAvailable': '发现新版本',
    'about.noSource': '本地构建 · 暂无更新源',
    'about.checkFailed': '检查失败',
    'about.settings': '设置…',
    'about.note': '本地运行 · 真实采样音色（GeneralUser GS）· 详情见仓库 docs/ 目录。',
    'help.title': '帮助中心',
    'help.quickStart': '快速开始',
    'help.quickStart1': '从「文件 → 新建工程」选择一个模板。',
    'help.quickStart2': '让 AI 生成节奏、旋律或编曲；AI 修改可在面板中接受或撤销。',
    'help.quickStart3': '点击播放试听，满意后导出 WAV / MP3 / FLAC / MIDI。',
    'help.shortcuts': '快捷键',
    'help.faq': '常见问题',
    'help.faqSound': '没有声音怎么办？',
    'help.faqSoundAnswer': '首次使用请点击界面任意位置启用音频（浏览器自动播放限制），再点击播放。',
    'help.faqExport': '导出文件在哪里？',
    'help.faqExportAnswer': '默认在工程 data/exports 目录，导出成功会提示文件名。',
    'help.faqUndo': '如何恢复误删？',
    'help.faqUndoAnswer': '用 Ctrl+Z 撤销，或在「工程管理 → 保存历史」中恢复之前的版本。',
    'help.faqAi': 'AI 会覆盖我的修改吗？',
    'help.faqAiAnswer': 'AI 每次写操作都会出现在「AI 修改」面板，可接受或撤销；工程也可随时保存。',
    'help.usage': 'AI 使用与导出',
    'help.usageText': 'AI 通过工具建轨、写音符、编排与混音；导出默认保存到 data/exports。',
    'help.diagnostics': '导出诊断日志',
    'help.diagnosticsDone': '诊断日志已导出',
    'help.diagnosticsNoUpload': '诊断内容在本机生成，不上传',
    'help.guide': '用户手册 / FAQ / 可访问性说明见仓库 docs/ 目录。',
    'settings.title': '设置',
    'settings.channel': '更新通道',
    'settings.channelHint': '稳定版优先；测试通道可能包含未完成功能',
    'settings.language': '语言',
    'settings.languageHint': '核心外壳双语；专业面板细项随版本完善',
    'settings.telemetry': '本地使用记录',
    'settings.telemetryHint': '仅保存在本机，不上传、不包含工程内容',
    'settings.crash': '崩溃报告',
    'settings.crashHint': '保存最近崩溃日志到本机 data/crash-reports，最多 20 条',
    'settings.localOnly': '设置保存在本机 data/settings.json · 不改变工程与撤销栈',
    'settings.loadFailed': '读取设置失败，将使用默认设置',
    'settings.saveFailed': '保存设置失败',
    'settings.saved': '设置已保存',
    'onboarding.title': '欢迎使用 AI 音乐工作室',
    'onboarding.step1': '新建一个工程模板',
    'onboarding.step2': '让 AI 生成节奏 / 旋律 / 编曲',
    'onboarding.step3': '试听满意后导出 WAV / MIDI',
    'onboarding.help': '需要帮助？按 Ctrl+K 打开命令面板',
    'cmd.title': '命令面板',
    'cmd.placeholder': '输入命令…（↑↓ 选择 · Enter 执行 · Esc 关闭）',
    'cmd.empty': '没有匹配的命令',
    'cmd.new': '新建工程…',
    'cmd.open': '打开工程…',
    'cmd.save': '保存工程',
    'cmd.exportWav': '导出 WAV…',
    'cmd.play': '播放',
    'cmd.stop': '停止',
    'cmd.undo': '撤销',
    'cmd.redo': '重做',
    'cmd.help': '帮助中心',
    'cmd.settings': '设置…',
    'cmd.about': '关于 AI 音乐工作室',
    'cmd.command': '命令面板',
    'shortcut.playPause': '播放 / 暂停',
    'shortcut.commandPalette': '命令面板',
    'shortcut.undoRedo': '撤销 / 重做',
    'shortcut.save': '保存工程',
    'shortcut.newOpen': '新建 / 打开工程',
    'shortcut.keyboard': '键盘面板展开时演奏',
    'shortcut.escape': '关闭对话框 / 取消',
    'export.exporting': '正在导出…',
    'export.success': '导出完成',
    'export.failed': '导出失败',
    'project.unsaved': '未保存',
    'project.saved': '已保存',
    'project.saving': '保存中…',
    'status.ready': '就绪',
    'status.playing': '播放中',
    'status.error': '出错',
    'error.generic': '操作失败',
    'error.audioLocked': '请先点击界面启用音频',
    'empty.noTracks': '还没有轨道，让 AI 创作或从模板开始。',
    'empty.noSelection': '请选择一个工程或轨道。',
  }),
  'en-US': Object.freeze({
    'app.name': 'AI Music Studio',
    'app.subtitle': 'DeepSeek AI Music Studio · Desktop',
    'app.local': 'Runs locally · project data stays on this device',
    'menu.file': 'File',
    'menu.edit': 'Edit',
    'menu.view': 'View',
    'menu.help': 'Help',
    'menu.new': 'New Project…',
    'menu.open': 'Open Project…',
    'menu.save': 'Save',
    'menu.saveAs': 'Save As…',
    'menu.exportWav': 'Export WAV…',
    'menu.exportMidi': 'Export MIDI…',
    'menu.importAudio': 'Import Audio…',
    'menu.importMidi': 'Import MIDI…',
    'menu.projects': 'Manage Projects…',
    'menu.undo': 'Undo',
    'menu.redo': 'Redo',
    'menu.settings': 'Settings…',
    'menu.about': 'About AI Music Studio',
    'menu.helpCenter': 'Help Center…',
    'menu.shortcuts': 'Keyboard Shortcuts…',
    'menu.commandPalette': 'Command Palette…',
    'menu.toggleSpectrum': 'Toggle Master Spectrum',
    'menu.resetLayout': 'Reset Layout',
    'menu.compact': 'Compact Mode',
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'common.ok': 'Got it',
    'common.back': 'Back',
    'common.loading': 'Loading…',
    'common.unknown': 'Unknown',
    'common.localBuild': 'Local build',
    'common.stable': 'Stable',
    'common.beta': 'Beta',
    'common.enabled': 'Enabled',
    'common.disabled': 'Disabled',
    'common.copy': 'Copy',
    'common.retry': 'Retry',
    'common.dismiss': 'Later',
    'common.start': 'Start Creating',
    'about.title': 'About AI Music Studio',
    'about.version': 'Version',
    'about.build': 'Build',
    'about.channel': 'Channel',
    'about.electron': 'Electron',
    'about.platform': 'Platform',
    'about.update': 'Updates',
    'about.checkUpdate': 'Check for Updates',
    'about.checking': 'Checking…',
    'about.notChecked': 'Not checked',
    'about.upToDate': 'Up to date',
    'about.updateAvailable': 'New version available',
    'about.noSource': 'Local build · no update source',
    'about.checkFailed': 'Check failed',
    'about.settings': 'Settings…',
    'about.note': 'Runs locally · GeneralUser GS sampled instruments · see docs/ for details.',
    'help.title': 'Help Center',
    'help.quickStart': 'Quick Start',
    'help.quickStart1': 'Open File → New Project and pick a template.',
    'help.quickStart2': 'Let AI generate drums, melody or arrangement; accept or undo changes in the AI panel.',
    'help.quickStart3': 'Play to audition, then export WAV / MP3 / FLAC / MIDI.',
    'help.shortcuts': 'Keyboard Shortcuts',
    'help.faq': 'FAQ',
    'help.faqSound': 'Why is there no sound?',
    'help.faqSoundAnswer': 'Click anywhere in the app first to unlock audio (browser autoplay policy), then press play.',
    'help.faqExport': 'Where are exported files?',
    'help.faqExportAnswer': 'They are saved under data/exports by default; a toast shows the file name.',
    'help.faqUndo': 'How do I recover a mistake?',
    'help.faqUndoAnswer': 'Press Ctrl+Z, or restore a previous version in Project Manager → History.',
    'help.faqAi': 'Will AI overwrite my edits?',
    'help.faqAiAnswer': 'Every AI write appears in the AI Changes panel where you can accept or undo it; save anytime.',
    'help.usage': 'AI Workflow & Export',
    'help.usageText': 'AI uses tools to create tracks, notes, arrangement and mixing; exports go to data/exports.',
    'help.diagnostics': 'Export Diagnostics',
    'help.diagnosticsDone': 'Diagnostics exported',
    'help.diagnosticsNoUpload': 'Generated locally; never uploaded',
    'help.guide': 'See docs/ for the user manual, FAQ and accessibility notes.',
    'settings.title': 'Settings',
    'settings.channel': 'Update Channel',
    'settings.channelHint': 'Stable is recommended; beta may include unfinished features',
    'settings.language': 'Language',
    'settings.languageHint': 'Core shell is bilingual; detailed panels are being translated',
    'settings.telemetry': 'Local usage log',
    'settings.telemetryHint': 'Stored only on this device; never uploaded; no project content',
    'settings.crash': 'Crash reports',
    'settings.crashHint': 'Keep recent crash logs under data/crash-reports (up to 20)',
    'settings.localOnly': 'Settings are stored in data/settings.json · no project/undo changes',
    'settings.loadFailed': 'Failed to load settings; using defaults',
    'settings.saveFailed': 'Failed to save settings',
    'settings.saved': 'Settings saved',
    'onboarding.title': 'Welcome to AI Music Studio',
    'onboarding.step1': 'Create a project from a template',
    'onboarding.step2': 'Let AI generate drums / melody / arrangement',
    'onboarding.step3': 'Audition and export to WAV / MIDI',
    'onboarding.help': 'Need help? Press Ctrl+K to open the command palette',
    'cmd.title': 'Command Palette',
    'cmd.placeholder': 'Type a command… (↑↓ select · Enter run · Esc close)',
    'cmd.empty': 'No matching commands',
    'cmd.new': 'New Project…',
    'cmd.open': 'Open Project…',
    'cmd.save': 'Save Project',
    'cmd.exportWav': 'Export WAV…',
    'cmd.play': 'Play',
    'cmd.stop': 'Stop',
    'cmd.undo': 'Undo',
    'cmd.redo': 'Redo',
    'cmd.help': 'Help Center',
    'cmd.settings': 'Settings…',
    'cmd.about': 'About AI Music Studio',
    'cmd.command': 'Command Palette',
    'shortcut.playPause': 'Play / Pause',
    'shortcut.commandPalette': 'Command Palette',
    'shortcut.undoRedo': 'Undo / Redo',
    'shortcut.save': 'Save Project',
    'shortcut.newOpen': 'New / Open Project',
    'shortcut.keyboard': 'Play while keyboard panel is open',
    'shortcut.escape': 'Close dialog / cancel',
    'export.exporting': 'Exporting…',
    'export.success': 'Export complete',
    'export.failed': 'Export failed',
    'project.unsaved': 'Unsaved',
    'project.saved': 'Saved',
    'project.saving': 'Saving…',
    'status.ready': 'Ready',
    'status.playing': 'Playing',
    'status.error': 'Error',
    'error.generic': 'Operation failed',
    'error.audioLocked': 'Click the app to enable audio first',
    'empty.noTracks': 'No tracks yet. Let AI create, or start from a template.',
    'empty.noSelection': 'Select a project or track.',
  }),
})

const FALLBACK_LOCALE = DEFAULT_LOCALE

/** 兼容测试/外部读取：DICTS['zh-CN'] / dictionaries / zhCN / enUS。 */
export const DICTS = MESSAGES
export const dictionaries = MESSAGES
export const zhCN = MESSAGES['zh-CN']
export const enUS = MESSAGES['en-US']

export function normalizeLocale(locale) {
  return SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE
}

/** t(key, vars?, locale?) —— 面板/测试通用；locale 省略用默认中文。 */
export function t(key, vars = {}, locale = DEFAULT_LOCALE) {
  return translate(locale, key, vars)
}

export function translate(locale, key, vars = {}) {
  const active = normalizeLocale(locale)
  const activeDict = MESSAGES[active] ?? MESSAGES[DEFAULT_LOCALE]
  const fallbackDict = MESSAGES[FALLBACK_LOCALE] ?? {}
  let text = activeDict[key] ?? fallbackDict[key] ?? key
  if (vars && typeof vars === 'object') {
    text = String(text).replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match))
  }
  return text
}

export const I18nContext = createContext({
  locale: DEFAULT_LOCALE,
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
  setLocale: () => {},
})

export function useI18n() {
  return useContext(I18nContext)
}

/** 对话框无障碍：Esc 关闭 + Tab 循环 + 关闭后焦点回到触发元素。 */
export function useDialogA11y(open, onClose, containerRef) {
  useEffect(() => {
    if (!open) return undefined
    const previous = typeof document !== 'undefined' ? document.activeElement : null
    const focusables = () => {
      const root = containerRef?.current
      if (!root) return []
      return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null)
    }
    const focusTimer = null
    const focusInitial = () => {
      const items = focusables()
      ;(items[0] ?? containerRef?.current)?.focus?.()
    }
    focusInitial()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose?.()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      if (focusTimer) clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown, true)
      try {
        const usable = previous && previous !== document.body && previous !== document.documentElement && previous.isConnected
        if (usable) previous.focus?.()
        else document.querySelector('[data-testid="menu-help"]')?.focus?.()
      } catch (err) { /* ignore */ }
    }
  }, [open, onClose, containerRef])
}

/** 默认导出（测试/工具 import default 时读取字典与 t）。 */
export default { MESSAGES, DICTS: MESSAGES, zhCN, enUS, translate, t, normalizeLocale, SUPPORTED_LOCALES }
