/**
 * AI 音乐工作室 — DSH 插件入口（AI 工具桥）。
 *
 * 职责：向 ctx.tools 注册 studio_* 工具，并把它们**全部代理到正在运行的桌面窗口**。
 *
 * 设计变更（P9）：
 * - **不再创建内嵌后端、不再注册 HTTP 路由、不再写 data/project.json**：
 *   窗口没运行时工具直接报错（见 tool-bridge.NO_APP_MESSAGE），
 *   保证 AI 的每一次写入都发生在用户能看到的窗口工程里。
 * - 新增 studio_app_info 工具：让 AI 先确认「窗口地址 / 数据目录 / 当前工程 / 可用采样音色」。
 * - preset/kit 参数不再用静态 enum，避免 DSH 插件版本落后于窗口音色库时 id 对不上。
 *
 * 注：本插件**不 import 任何 @deepseek-ai 包**（link 安装时 Node 解析不到
 * profile 的 flat fallback）。工具定义用自包含的 ./define-tool.js。
 */
import { createAppStatusTool } from './app-status.js'
import { defineTool } from './define-tool.js'
import { createLaunchTool } from './launch.js'
import { createTools } from './tools.js'
import { NO_APP_MESSAGE, detectApp, withAppProxy } from './tool-bridge.js'

/** Host 插件名（诊断用；package.json 的 name 才是 DSH 安装标识）。 */
export const name = 'ai-music-studio'
/** 依赖的宿主服务：只需工具注册表（HTTP 由桌面窗口自己提供）。 */
export const inject = ['tools']
/** 供外部（健康检查 / 文档）引用的版本号。 */
export const VERSION = '2.4.0'

/**
 * 插件挂载入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      const fn = ctx.logger?.[level]
      if (typeof fn === 'function') fn(`[ai-music-studio] ${message}`)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
  const warn = (message) => log('warn', message)
  const info = (message) => log('info', message)

  // 工具定义只需要一个占位 state：本地 execute 永远不会被调用（withAppProxy 只代理/报错）。
  // 这样 DSH 进程内不会创建项目文件、不会出现「看不见的后台数据」。
  const proxyOnlyState = {
    dataDir: '',
    project: null,
    revision: 0,
    async ensureReady() {
      throw new Error(NO_APP_MESSAGE)
    },
    mutate() {
      throw new Error(NO_APP_MESSAGE)
    },
  }

  const tools = createTools({ defineTool, state: proxyOnlyState, onError: warn }).map((tool) =>
    withAppProxy(tool, {
      onProxy: (toolName, baseUrl) => info(`${toolName} → ${baseUrl}（用户窗口）`),
      onError: (error) => warn(`代理失败：${error?.message ?? error}`),
    }),
  )
  // P15：本地工具（不代理）——窗口没开时也必须能调用，用于一键启动桌面窗口。
  const launchTool = createLaunchTool({ defineTool })
  // R0-16：本地工具——查询窗口运行状态/上次退出原因（窗口没开也可用）。
  const appStatusTool = createAppStatusTool({ defineTool })

  ctx.effect(() => {
    const disposers = []
    for (const tool of tools) {
      const dispose = ctx.tools.register(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    // App 代理工具之外，单独注册本地工具（studio_launch_app / studio_app_status）。
    const disposeLaunch = ctx.tools.register(launchTool)
    if (typeof disposeLaunch === 'function') disposers.push(disposeLaunch)
    const disposeAppStatus = ctx.tools.register(appStatusTool)
    if (typeof disposeAppStatus === 'function') disposers.push(disposeAppStatus)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已卸载 */
        }
      }
    }
  }, 'ai-music-studio: tools')

  // 启动时探测一次桌面窗口，告诉用户/AI 当前目标（不阻塞加载）。
  info('本地工具已注册：studio_launch_app（一键启动）/ studio_app_status（窗口状态/上次退出）')
  detectApp({ force: true })
    .then((url) => {
      if (url) info(`已连接桌面窗口：${url}（所有 studio_* 工具都会写入该窗口工程）`)
      else warn(`未检测到桌面窗口：${NO_APP_MESSAGE}`)
    })
    .catch((error) => warn(`探测桌面窗口失败：${error?.message ?? error}`))
}
