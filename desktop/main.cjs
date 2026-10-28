/**
 * AI 音乐工作室 — Electron 主进程（portable exe 入口）。
 *
 * 职责：
 * 1. 单实例锁（重复启动时聚焦已有窗口）；
 * 2. 数据目录：默认 `%APPDATA%\AI音乐工作室\data`，可用 `--data-dir=<path>` 覆盖；
 *    首次启动数据目录为空时，由服务端 `state.ready` 用 `createDemoProject()` 自动种子 demo 工程；
 * 3. 动态 `import()` 加载 `src/standalone/server.mjs` 的 `startServer()`（127.0.0.1，默认 41731，
 *    被占用时由 server 自动顺延），并把 app-endpoint.json 写到数据目录与
 *    `%APPDATA%\AI音乐工作室\`（供 DSH AI 桥发现，协议与独立窗口版一致）；
 * 4. BrowserWindow 1600×1000、autoHideMenuBar、标题「AI 音乐工作室」、加载本地服务页面；
 *    窗口关闭 → 隐藏到系统托盘（服务继续运行，AI 工具不断）；托盘菜单「退出」才真正关服务退出（P11）；
 *    P15 首次打包运行在桌面创建「AI音乐工作室.lnk」快捷方式；
 * 5. `--smoke-test`：只起服务、不创建窗口，HTTP 校验 `/studio/api/health` 与
 *    `/studio/api/state?rev=0`，打印 `SMOKE_OK {json}` 后 exit 0（失败打印 `SMOKE_FAIL ...` exit 1）；
 * 6. 安全：nodeIntegration:false、contextIsolation:true、sandbox:true、只监听 127.0.0.1、
 *    拒绝窗口打开/外部导航/权限请求。
 *
 * 支持参数：
 *   --smoke-test            冒烟自检（不建窗口）
 *   --data-dir=<path>       数据目录覆盖（也支持 `--data-dir <path>` 与 AIMS_DATA_DIR 环境变量）
 *   --port=<n>              起始端口（默认 41731，占用自动顺延；也支持 AIMS_PORT 环境变量）
 *   --user-data-dir=<path>  Chromium/Electron 用户数据目录（默认 %APPDATA%\AI音乐工作室）
 *
 * 说明：源码版 `server.mjs` 在仓库 `src/standalone/`，打包后位于 `resources/app.asar` 内；
 * 若 asar 内 ESM 导入不可用，构建脚本可改用 extraResource 模式，把同一份源码放到
 * `resources/app-resources/`，主进程会自动优先探测它（见 desktop/README.md）。
 */
'use strict'

// ── 0. 环境自愈：从终端继承 ELECTRON_RUN_AS_NODE=1 时 Electron 会退化成 Node 进程 ──
// 双击启动不会有这个问题；但若终端环境带了该变量，则以 Electron 模式重新拉起自身。
if (process.env.ELECTRON_RUN_AS_NODE === '1' && process.env.AIMS_NO_RELAUNCH !== '1') {
  const { spawn } = require('node:child_process')
  const env = { ...process.env, AIMS_NO_RELAUNCH: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env, windowsHide: false })
  child.on('exit', (code) => process.exit(code === null ? 1 : code))
  return
}

const { app, BrowserWindow, Menu, dialog, ipcMain, session, Tray, shell, powerSaveBlocker } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// v2.1 P0：禁止 Chromium 因窗口被遮挡/最小化而节流渲染（预览/导出 OfflineAudioContext 会超时）。
// 必须在 app ready 之前 append；--disable-features 与已存在值合并，避免覆盖用户/其它模块设置。
try {
  if (typeof app.commandLine.appendSwitch === 'function') {
    const existingFeatures = app.commandLine.getSwitchValue('disable-features')
    const features = new Set(String(existingFeatures || '').split(',').map((item) => item.trim()).filter(Boolean))
    features.add('CalculateNativeWinOcclusion')
    app.commandLine.appendSwitch('disable-features', [...features].join(','))
  }
} catch {
  /* 忽略：极端环境下 commandLine 不可用 */
}

const APP_TITLE = 'AI 音乐工作室'
/** 数据目录名（契约要求无空格：%APPDATA%\AI音乐工作室；与 src/host/tool-bridge.js 的发现路径一致）。 */
const APP_DIR_NAME = 'AI音乐工作室'
const APP_ID = 'com.aimusicstudio.desktop'
const DEFAULT_PORT = 41731
const HTTP_TIMEOUT_MS = 15000
const ENDPOINT_FILE = 'app-endpoint.json'
const DEFAULT_APPDATA_ROOT = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
/** 默认应用目录（数据、endpoint、Chromium profile 都放这里）。 */
const DEFAULT_APP_DIR = path.join(DEFAULT_APPDATA_ROOT, APP_DIR_NAME)

// ── 1. 参数解析 ────────────────────────────────────────────────────────────

/** 解析 `--x=y` 与 `--x y` 两种写法，返回 Map。 */
function parseArgs(argv) {
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i])
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq >= 0) {
      flags.set(token.slice(0, eq), token.slice(eq + 1))
    } else {
      const next = argv[i + 1]
      if (next !== undefined && !String(next).startsWith('--')) {
        flags.set(token, next)
        i += 1
      } else {
        flags.set(token, '')
      }
    }
  }
  return flags
}

/**
 * 取出用户参数：打包后 argv[0]=exe、argv[1..]=用户参数；
 * 开发版 argv[1]=脚本路径、argv[2..]=用户参数（先剥掉不以 -- 开头的脚本路径）。
 */
function userArgs() {
  const argv = process.argv.slice(1)
  if (!app.isPackaged && argv.length > 0 && !String(argv[0]).startsWith('--')) argv.shift()
  return argv
}

const flags = parseArgs(userArgs())
const SMOKE_TEST = flags.has('--smoke-test')

const explicitDataDir = flags.get('--data-dir') || process.env.AIMS_DATA_DIR || ''
const explicitUserDataDir = flags.get('--user-data-dir') || ''
/**
 * 冒烟模式且未显式指定数据目录/用户目录时，自动使用系统临时目录：
 * 不触碰真实 `%APPDATA%\AI音乐工作室`，且与正在运行的窗口实例互不干扰
 * （独立 userData → 单实例锁/端口各自独立），便于 CI 随时执行。
 */
const smokeTempDir =
  SMOKE_TEST && !explicitDataDir && !explicitUserDataDir
    ? path.join(os.tmpdir(), `ai-music-studio-smoke-${process.pid}`)
    : ''
const dataDir = smokeTempDir
  ? path.join(smokeTempDir, 'data')
  : explicitDataDir
    ? path.resolve(explicitDataDir)
    : path.join(DEFAULT_APP_DIR, 'data')
const wantPort =
  Number(flags.get('--port') || process.env.AIMS_PORT || DEFAULT_PORT) > 0
    ? Number(flags.get('--port') || process.env.AIMS_PORT || DEFAULT_PORT)
    : DEFAULT_PORT
/** 默认再往 `%APPDATA%\AI音乐工作室\` 写一份 endpoint 供 DSH AI 桥发现；显式 --data-dir / 冒烟临时目录时不污染真实目录。 */
const endpointDirs = explicitDataDir || smokeTempDir ? [] : [DEFAULT_APP_DIR]

// 测试/CI 用 --data-dir 时把 Chromium profile 也隔离到该数据目录下，避免动用户真实 %APPDATA%。
if (explicitUserDataDir) {
  try {
    fs.mkdirSync(path.resolve(explicitUserDataDir), { recursive: true })
    app.setPath('userData', path.resolve(explicitUserDataDir))
  } catch {
    /* 忽略：极端情况下退回默认 profile */
  }
} else if (smokeTempDir) {
  try {
    fs.mkdirSync(path.join(smokeTempDir, '.electron-profile'), { recursive: true })
    app.setPath('userData', path.join(smokeTempDir, '.electron-profile'))
  } catch {
    /* 忽略 */
  }
} else if (explicitDataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    app.setPath('userData', path.join(dataDir, '.electron-profile'))
  } catch {
    /* 忽略 */
  }
} else {
  try {
    fs.mkdirSync(DEFAULT_APP_DIR, { recursive: true })
    app.setPath('userData', DEFAULT_APP_DIR)
  } catch {
    /* 忽略 */
  }
}

app.setName(APP_TITLE)
app.setAppUserModelId(APP_ID)

// ── 2. 日志（控制台 + 数据目录 desktop.log，方便打包版排查） ───────────────

const logFile = path.join(dataDir, 'desktop.log')
/** 给已有日志补 UTF-8 BOM，避免 Windows PowerShell/记事本按 GBK 打开乱码。 */
function ensureLogBom() {
  try {
    if (!fs.existsSync(logFile)) return
    const data = fs.readFileSync(logFile)
    if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return
    fs.writeFileSync(logFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data]))
  } catch {
    /* 日志修复失败不影响主流程 */
  }
}
function log(...parts) {
  const line = `[aims-desktop] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`
  // eslint-disable-next-line no-console
  console.log(line)
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    let prefix = ''
    try {
      if (!fs.existsSync(logFile) || fs.statSync(logFile).size === 0) prefix = '\uFEFF'
    } catch {
      prefix = ''
    }
    fs.appendFileSync(logFile, `${prefix}${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

ensureLogBom()

/** 冒烟模式结果也落盘一份，便于 CI 在拿不到 stdout 时取证。 */
function writeSmokeResult(payload) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'smoke-result.json'), JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    /* 忽略 */
  }
}

// ── 2.5 运行状态 / 退出原因（P0 反馈：窗口消失后 AI/用户无法判断为什么退出） ──

const appStartedAt = Date.now()
function writeAppStatus(extra = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const payload = {
      pid: process.pid,
      startedAt: appStartedAt,
      version: app.getVersion(),
      packaged: app.isPackaged,
      updatedAt: Date.now(),
      ...extra,
    }
    fs.writeFileSync(path.join(dataDir, 'app-status.json'), JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    /* 状态文件失败不影响主流程 */
  }
}

function recordExit(reason, exitCode = null, detail = null) {
  const lastExit = { reason: String(reason), exitCode, at: Date.now(), ...(detail ? { detail } : {}) }
  log(`退出原因：${JSON.stringify(lastExit)}`)
  writeAppStatus({ running: false, lastExit })
}

// ── 3. 资源定位（开发版仓库根 / asar 内 / extraResource 目录） ──────────────

/** 应用根目录：打包后为 app.asar；开发版为仓库根。 */
function appRootDir() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..')
}

/** 找到 server.mjs：优先 extraResource 的 app-resources/，其次 asar 内/仓库内。 */
function resolveServerEntry() {
  const candidates = []
  if (app.isPackaged) {
    // extraResource 兜底模式（resources/src/standalone/server.mjs）优先；
    // 其次才是 asar 内路径（resources/app.asar/src/standalone/server.mjs）。
    candidates.push(path.join(process.resourcesPath, 'app-resources', 'src', 'standalone', 'server.mjs'))
    candidates.push(path.join(process.resourcesPath, 'src', 'standalone', 'server.mjs'))
    candidates.push(path.join(app.getAppPath(), 'src', 'standalone', 'server.mjs'))
  } else {
    candidates.push(path.join(appRootDir(), 'src', 'standalone', 'server.mjs'))
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 下一个候选 */
    }
  }
  throw new Error(`找不到独立窗口服务端 src/standalone/server.mjs；候选：\n${candidates.join('\n')}`)
}

/** 窗口图标（打包后在 asar 的 desktop/icon.ico；开发版 desktop/icon.ico）。 */
function resolveIconPath() {
  const candidates = app.isPackaged
    ? [
        path.join(app.getAppPath(), 'desktop', 'icon.ico'),
        path.join(process.resourcesPath, 'icon.ico'),
        path.join(path.dirname(process.execPath), 'icon.ico'),
      ]
    : [path.join(__dirname, 'icon.ico')]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 下一个候选 */
    }
  }
  return null
}

// ── 4. 本地服务生命周期 ────────────────────────────────────────────────────

/** @type {null | {url:string, port:number, close:()=>Promise<void>, dataDir:string}} */
let serverHandle = null
/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {Tray | null} 系统托盘（关闭窗口后服务常驻，托盘可恢复/退出）。 */
let tray = null
let isQuitting = false
let shuttingDown = null
/** v2.1 P0：powerSaveBlocker id（prevent-app-suspension，避免系统休眠中断预览/导出）。 */
let powerSaveBlockerId = -1

/** 动态 import ESM 的 server.mjs 并启动服务。 */
async function startLocalServer() {
  const entry = resolveServerEntry()
  log(`加载服务端模块：${entry}`)
  const mod = await import(pathToFileURL(entry).href)
  if (typeof mod.startServer !== 'function') {
    throw new Error(`src/standalone/server.mjs 未导出 startServer（实际导出：${Object.keys(mod).join(', ')}）`)
  }
  const handle = await mod.startServer({
    dataDir,
    host: '127.0.0.1',
    port: wantPort,
    endpointDirs,
  })
  log(`服务已启动：${handle.url}（数据目录 ${handle.dataDir}，端口 ${handle.port}）`)
  return handle
}

/** 删除 endpointDirs 里补充写的 app-endpoint.json（server.close 只清理 dataDir 里的那份）。 */
async function removeExtraEndpointFiles() {
  const fsp = fs.promises
  for (const dir of endpointDirs) {
    try {
      await fsp.unlink(path.join(dir, ENDPOINT_FILE))
    } catch {
      /* 不存在/不可写都忽略 */
    }
  }
}

/** 关闭服务；重复调用安全。 */
function shutdownServer() {
  if (shuttingDown) return shuttingDown
  shuttingDown = (async () => {
    if (!serverHandle) {
      await removeExtraEndpointFiles()
      return
    }
    const current = serverHandle
    serverHandle = null
    try {
      await current.close()
      log('服务已关闭')
    } catch (error) {
      log('关闭服务失败：', error?.message ?? String(error))
    }
    await removeExtraEndpointFiles()
  })()
  return shuttingDown
}

/** 创建系统托盘：显示窗口 / 隐藏窗口 / 退出（退出时才关闭服务）。 */
function createTray(win) {
  const iconPath = resolveIconPath()
  if (!iconPath) return null
  try {
    const nextTray = new Tray(iconPath)
    nextTray.setToolTip(`${APP_TITLE}（关闭窗口后仍在后台运行）`)
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示 AI 音乐工作室',
        click: () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          }
        },
      },
      { label: '隐藏窗口（服务继续运行）', click: () => mainWindow?.hide() },
      {
        label: '打开数据目录',
        click: () => {
          void shell.openPath(dataDir)
        },
      },
      {
        label: '查看日志（desktop.log）',
        click: () => {
          void shell.openPath(logFile)
        },
      },
      { type: 'separator' },
      {
        label: '退出（停止后台服务）',
        click: () => {
          void shutdownAndQuit()
        },
      },
    ])
    nextTray.setContextMenu(contextMenu)
    nextTray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
    nextTray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) mainWindow.focus()
        else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    })
    log(`系统托盘已创建；关闭窗口不会停止服务（托盘退出才停止）：${iconPath}`)
    return nextTray
  } catch (error) {
    log(`系统托盘创建失败（关闭窗口将退化为退出应用）：${error?.message ?? error}`)
    return null
  }
}

/** 关闭服务后退出应用（窗口 close 事件调用）。 */
async function shutdownAndQuit() {
  isQuitting = true
  try {
    tray?.destroy()
    tray = null
  } catch {
    /* 忽略 */
  }
  try {
    await Promise.race([shutdownServer(), new Promise((resolve) => setTimeout(resolve, 4000))])
  } catch {
    /* 忽略 */
  }
  app.quit()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 简易 HTTP GET JSON（不引入额外依赖）。 */
function getJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          finish(reject, new Error(`GET ${url} → HTTP ${res.statusCode}: ${text.slice(0, 300)}`))
          return
        }
        try {
          finish(resolve, JSON.parse(text))
        } catch (error) {
          finish(reject, new Error(`GET ${url} 返回非 JSON：${text.slice(0, 300)}（${error?.message ?? error}）`))
        }
      })
      res.on('error', (error) => finish(reject, error))
    })
    req.on('timeout', () => {
      req.destroy()
      finish(reject, new Error(`GET ${url} 超时（${timeoutMs}ms）`))
    })
    req.on('error', (error) => finish(reject, error))
  })
}

// ── 5. 冒烟自检（--smoke-test，不创建窗口） ────────────────────────────────

/** 清理此前冒烟运行遗留的临时目录（当时 Chromium profile 被进程占用，退出时删不干净）。 */
function cleanupStaleSmokeDirs() {
  const prefix = 'ai-music-studio-smoke-'
  try {
    const tmpRoot = os.tmpdir()
    for (const name of fs.readdirSync(tmpRoot)) {
      if (!name.startsWith(prefix)) continue
      const full = path.join(tmpRoot, name)
      if (full === smokeTempDir) continue
      try {
        fs.rmSync(full, { recursive: true, force: true })
      } catch {
        /* 被占用则跳过，下次再清 */
      }
    }
  } catch {
    /* 忽略 */
  }
}

async function runSmokeTest() {
  const startedAt = Date.now()
  try {
    cleanupStaleSmokeDirs()
    serverHandle = await startLocalServer()
    const base = serverHandle.url.replace(/\/+$/, '')
    const health = await getJson(`${base}/studio/api/health`)
    if (!health || health.ok !== true) {
      throw new Error(`health 校验失败：${JSON.stringify(health)}`)
    }
    const state = await getJson(`${base}/studio/api/state?rev=0`)
    const project = state?.project
    if (!project || !Array.isArray(project.tracks) || !Array.isArray(project.patterns)) {
      throw new Error(`state 校验失败：project.tracks/patterns 缺失（${JSON.stringify(state)?.slice(0, 300)}）`)
    }
    const result = {
      ok: true,
      mode: app.isPackaged ? 'packaged' : 'dev',
      url: serverHandle.url,
      port: serverHandle.port,
      dataDir: serverHandle.dataDir,
      autoTempDataDir: Boolean(smokeTempDir),
      endpointDirs,
      rev: state.rev,
      tracks: project.tracks.length,
      patterns: project.patterns.length,
      title: project.title,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      appVersion: app.getVersion(),
      elapsedMs: Date.now() - startedAt,
    }
    writeSmokeResult(result)
    // 先落盘/打印，等 stdout 冲刷后再退出，避免 GUI 子系统进程截断输出。
    log('SMOKE_OK', JSON.stringify(result))
    await shutdownServer()
    // 自动临时目录：成功即清理（失败保留便于排查）。
    if (smokeTempDir) {
      try {
        fs.rmSync(smokeTempDir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
    await sleep(200)
    app.exit(0)
  } catch (error) {
    const failure = {
      ok: false,
      mode: app.isPackaged ? 'packaged' : 'dev',
      dataDir,
      error: String(error?.stack ?? error?.message ?? error),
      elapsedMs: Date.now() - startedAt,
    }
    writeSmokeResult(failure)
    log('SMOKE_FAIL', JSON.stringify(failure))
    await shutdownServer().catch(() => {})
    await sleep(200)
    app.exit(1)
  }
}

// ── 6. 窗口模式 ────────────────────────────────────────────────────────────

function createMainWindow(handle) {
  const iconPath = resolveIconPath()
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 640,
    title: APP_TITLE,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F6F4EF',
    icon: iconPath ?? undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      // v2.1 P0：窗口遮挡/最小化时也不节流渲染（预览/导出依赖 Web Audio 离线渲染）。
      backgroundThrottling: false,
      // v2.2 M2：暴露受限 window.aimsPlugins（VST3 实时桥），contextIsolation 下安全。
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  mainWindow = win
  win.setMenuBarVisibility(false)
  // 双保险：即使 webPreferences 被旧 Electron 忽略，也显式关闭该 webContents 的后台节流。
  try {
    win.webContents.setBackgroundThrottling(false)
  } catch {
    /* 忽略：旧版本无此 API */
  }

  // 固定窗口标题（页面 title 也是同名，双保险）。
  win.on('page-title-updated', (event) => {
    event.preventDefault()
    win.setTitle(APP_TITLE)
  })
  win.once('ready-to-show', () => {
    win.show()
    log('窗口已显示')
  })
  win.on('closed', () => {
    mainWindow = null
  })
  // 窗口关闭 → 隐藏到托盘（服务常驻，AI 工具不中断）；没有托盘时退回退出。
  win.on('close', (event) => {
    if (isQuitting) return
    if (tray) {
      event.preventDefault()
      win.hide()
      log('窗口已隐藏到系统托盘；服务继续运行（托盘菜单「退出」才停止）')
      return
    }
    event.preventDefault()
    void shutdownAndQuit()
  })

  // 安全：禁止新窗口、禁止导航到外部 URL。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith(handle.url)) event.preventDefault()
  })
  win.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
    log(`页面加载失败：${code} ${description} ${validatedURL}`)
  })

  win.loadURL(handle.url).catch((error) => {
    log('加载本地页面失败：', error?.message ?? String(error))
    dialog.showErrorBox(APP_TITLE, `无法加载本地页面：${error?.message ?? error}\n${handle.url}`)
  })
}

/** P15：首次运行在桌面创建快捷方式（便携 exe 也方便固定到桌面/开始菜单）。失败只记日志。 */
function ensureDesktopShortcut() {
  if (!app.isPackaged) return
  try {
    const desktopDir = app.getPath('desktop')
    const lnkPath = path.join(desktopDir, `${APP_TITLE}.lnk`)
    const target = process.execPath
    const options = {
      target,
      cwd: path.dirname(target),
      description: APP_TITLE,
      icon: target,
      iconIndex: 0,
    }
    let created = false
    try {
      created = shell.writeShortcutLink(lnkPath, 'create', options)
    } catch {
      created = false
    }
    if (!created) shell.writeShortcutLink(lnkPath, 'update', options)
    log(`桌面快捷方式已就绪：${lnkPath}`)
  } catch (error) {
    log(`桌面快捷方式创建失败（忽略）：${error?.message ?? error}`)
  }
}

/* ── v2.2 M2：外部 VST3 实时桥 IPC（window.aimsPlugins） ───────────────── */

let pluginIpcRegistered = false

function pluginFailure(error) {
  const message = String(error?.message ?? error ?? '外部插件调用失败')
  log('插件 IPC 失败：', message)
  return { ok: false, error: message, code: error?.code ?? 'PLUGIN_HOST_ERROR' }
}

function withPluginTimeout(promise, timeoutMs, label) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, error: `外部插件${label}超时（${timeoutMs}ms）`, code: 'PLUGIN_HOST_TIMEOUT' })
      }, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function pluginService() {
  return serverHandle?.plugins ?? null
}

function registerPluginIpc() {
  if (pluginIpcRegistered) return
  pluginIpcRegistered = true

  ipcMain.handle('aims-plugin:status', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) {
      return { ok: false, supported: true, loaded: false, error: '外部插件服务未就绪（本地服务尚未启动）；请稍后重试或重启桌面版', code: 'PLUGIN_HOST_UNAVAILABLE', instances: [], sidecar: { available: false } }
    }
    try {
      const sidecar = plugins.status()
      const list = await withPluginTimeout(plugins.listInstances(), 4000, '状态查询')
      if (list?.ok === false) return list
      const instances = list.instances ?? []
      const wanted = typeof args?.instanceId === 'string' ? args.instanceId : ''
      if (wanted !== '') {
        const item = instances.find((entry) => entry.instanceId === wanted)
        if (!item) return { ok: true, supported: true, loaded: false, instanceId: wanted }
        return {
          ok: true,
          supported: true,
          loaded: true,
          instanceId: item.instanceId,
          pluginId: item.pluginId,
          sampleRate: item.sampleRate,
          maxBlockSize: item.maxBlockSize,
          underrun: item.underrun === true,
          underruns: item.underruns ?? 0,
          bufferMs: item.bufferMs,
          latencyMs: item.latencyMs,
          latencySamples: item.latencySamples,
          error: item.lastError ?? null,
          params: null,
          bypass: false,
          effectId: item.effectId ?? null,
          trackId: item.trackId ?? null,
        }
      }
      return {
        ok: true,
        supported: true,
        sidecar,
        instances: instances.map((item) => ({ ...item, loaded: true, latencyMs: item.latencyMs, error: item.lastError ?? null, bypass: false, params: null })),
        count: instances.length,
        maxInstances: list.maxInstances ?? 8,
      }
    } catch (error) {
      return pluginFailure(error)
    }
  })

  ipcMain.handle('aims-plugin:load', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) return { ok: false, error: '外部插件服务未就绪（本地服务尚未启动）', code: 'PLUGIN_HOST_UNAVAILABLE' }
    const pluginId = String(args?.pluginId ?? '')
    const instanceId = String(args?.instanceId ?? '')
    if (pluginId === '') return { ok: false, error: 'load 需要 pluginId', code: 'PLUGIN_INVALID_INSTANCE' }
    if (instanceId === '') return { ok: false, error: 'load 需要 instanceId（effect=fx:<effectId>；instrument=track:<trackId>）', code: 'PLUGIN_INVALID_INSTANCE' }
    const kind = args?.kind === undefined || args?.kind === null ? '' : String(args.kind)
    if (kind !== '' && kind !== 'instrument' && kind !== 'effect') {
      return { ok: false, error: "kind 必须是 'instrument' 或 'effect'", code: 'PLUGIN_INVALID_INSTANCE' }
    }
    try {
      const result = await withPluginTimeout(plugins.loadInstance(pluginId, {
        instanceId,
        effectId: args?.effectId,
        trackId: args?.trackId,
        kind: kind === '' ? undefined : kind,
        sampleRate: args?.sampleRate,
        maxBlockSize: args?.maxBlockSize,
        audioInputs: args?.audioInputs,
        audioOutputs: args?.audioOutputs,
        stateBase64: typeof args?.stateBase64 === 'string' ? args.stateBase64 : (typeof args?.state === 'string' ? args.state : undefined),
      }), 20000, '加载')
      if (result?.ok === false) return result
      return { ok: true, ...result }
    } catch (error) {
      return pluginFailure(error)
    }
  })

  ipcMain.handle('aims-plugin:process', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) return { ok: false, error: '外部插件服务未就绪（本地服务尚未启动）', code: 'PLUGIN_HOST_UNAVAILABLE' }
    const instanceId = String(args?.instanceId ?? '')
    const numSamples = Number(args?.numSamples)
    if (instanceId === '') return { ok: false, error: 'process 需要 instanceId', code: 'PLUGIN_INVALID_INSTANCE' }
    if (!Number.isInteger(numSamples) || numSamples <= 0 || numSamples > 2048) {
      return { ok: false, error: 'process 的 numSamples 必须为 1..2048', code: 'PLUGIN_INVALID_BLOCK' }
    }
    if (!Array.isArray(args?.inputs)) return { ok: false, error: 'process 需要 inputs 通道数组', code: 'PLUGIN_INVALID_BLOCK' }
    const midi = Array.isArray(args?.midi) ? args.midi : []
    if (midi.length > 1024) return { ok: false, error: 'process 的 midi 事件过多（≤1024）', code: 'PLUGIN_INVALID_BLOCK' }
    for (const event of midi) {
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        return { ok: false, error: 'process 的 midi 事件必须是对象', code: 'PLUGIN_INVALID_BLOCK' }
      }
    }
    try {
      // audio-engine 契约：inputs 为 Float32 planar base64 字符串（service 同时兼容 Float32Array）。
      // outputs 返回 base64 字符串数组；outputsF32 额外给调试/E2E 用。
      const result = await withPluginTimeout(plugins.processInstance({
        instanceId,
        inputs: args.inputs,
        numSamples,
        midi,
        outputFormat: 'f32',
      }), 5000, '处理')
      if (result?.ok === false) return result
      return {
        ok: true,
        instanceId: result.instanceId,
        numSamples: result.numSamples,
        sampleRate: result.sampleRate,
        outputs: result.outputsBase64 ?? [],
        outputsF32: result.outputs ?? [],
        events: result.outputEvents ?? [],
        outputEvents: result.outputEvents ?? [],
        midiEventCount: result.midiEventCount ?? 0,
        ms: result.ms,
        latencySamples: result.latencySamples,
        latencyMs: result.latencyMs,
      }
    } catch (error) {
      return pluginFailure(error)
    }
  })

  ipcMain.handle('aims-plugin:set-param', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) return { ok: false, error: '外部插件服务未就绪（本地服务尚未启动）', code: 'PLUGIN_HOST_UNAVAILABLE' }
    try {
      const result = await withPluginTimeout(plugins.setInstanceParam({
        instanceId: String(args?.instanceId ?? ''),
        paramId: args?.paramId,
        value: args?.value,
      }), 5000, '参数写入')
      if (result?.ok === false) return result
      return { ok: true, ...result }
    } catch (error) {
      return pluginFailure(error)
    }
  })

  ipcMain.handle('aims-plugin:unload', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) return { ok: false, error: '外部插件服务未就绪（本地服务尚未启动）', code: 'PLUGIN_HOST_UNAVAILABLE' }
    try {
      const result = await plugins.unloadInstance(String(args?.instanceId ?? ''))
      return { ok: true, ...result }
    } catch (error) {
      return pluginFailure(error)
    }
  })

  ipcMain.handle('aims-plugin:params', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) return { ok: false, error: '外部插件服务未就绪（本地服务尚未启动）', code: 'PLUGIN_HOST_UNAVAILABLE' }
    try {
      const result = await withPluginTimeout(plugins.getInstanceParams(String(args?.instanceId ?? '')), 8000, '参数读取')
      return { ok: true, ...result }
    } catch (error) {
      return pluginFailure(error)
    }
  })

  ipcMain.handle('aims-plugin:select-program', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) return { ok: false, error: '外部插件服务未就绪（本地服务尚未启动）', code: 'PLUGIN_HOST_UNAVAILABLE' }
    const instanceId = String(args?.instanceId ?? '')
    if (instanceId === '') return { ok: false, error: 'select-program 需要 instanceId', code: 'PLUGIN_INVALID_INSTANCE' }
    const listId = Number(args?.listId)
    const index = Number(args?.index)
    if (!Number.isFinite(listId) || !Number.isInteger(index)) return { ok: false, error: 'select-program 需要 listId/index', code: 'PLUGIN_INVALID_PARAM' }
    try {
      const result = await withPluginTimeout(plugins.selectProgram({ instanceId, listId, index }), 8000, '选择预设')
      return { ok: true, instanceId, ...result }
    } catch (error) {
      return pluginFailure(error)
    }
  })

  ipcMain.handle('aims-plugin:load-state', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) return { ok: false, error: '外部插件服务未就绪（本地服务尚未启动）', code: 'PLUGIN_HOST_UNAVAILABLE' }
    const instanceId = String(args?.instanceId ?? '')
    const stateBase64 = String(args?.stateBase64 ?? args?.state ?? '')
    if (instanceId === '') return { ok: false, error: 'load-state 需要 instanceId', code: 'PLUGIN_INVALID_INSTANCE' }
    if (stateBase64 === '') return { ok: false, error: 'load-state 需要 stateBase64', code: 'PLUGIN_STATE_INVALID' }
    if (Buffer.byteLength(stateBase64, 'utf8') > 2 * 1024 * 1024) return { ok: false, error: 'stateBase64 超过 2MB 上限', code: 'PLUGIN_STATE_INVALID' }
    try {
      const result = await withPluginTimeout(plugins.loadInstanceState(instanceId, stateBase64), 8000, '加载状态')
      return { ok: true, instanceId, ...result }
    } catch (error) {
      return pluginFailure(error)
    }
  })

  ipcMain.handle('aims-plugin:save-state', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) return { ok: false, error: '外部插件服务未就绪（本地服务尚未启动）', code: 'PLUGIN_HOST_UNAVAILABLE' }
    const instanceId = String(args?.instanceId ?? '')
    if (instanceId === '') return { ok: false, error: 'save-state 需要 instanceId', code: 'PLUGIN_INVALID_INSTANCE' }
    try {
      const result = await withPluginTimeout(plugins.saveInstanceState(instanceId), 8000, '状态保存')
      return { ok: true, instanceId, stateBase64: result.stateBase64 }
    } catch (error) {
      return pluginFailure(error)
    }
  })

  ipcMain.handle('aims-plugin:report-status', async (_event, args = {}) => {
    const plugins = pluginService()
    if (!plugins) return { ok: false, error: '外部插件服务未就绪（本地服务尚未启动）', code: 'PLUGIN_HOST_UNAVAILABLE' }
    try {
      const result = plugins.reportInstanceStatus({
        instanceId: String(args?.instanceId ?? ''),
        underrun: args?.underrun,
        underruns: args?.underruns,
        bufferMs: args?.bufferMs,
        error: args?.error,
      })
      return result
    } catch (error) {
      return pluginFailure(error)
    }
  })
}

/** v2.2 M2：桌面 session 兜底注入 COOP/COEP/CORP（服务端已加；双保险，确保 crossOriginIsolated=true）。 */
function installCrossOriginIsolation() {
  try {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...(details.responseHeaders || {}) }
      headers['Cross-Origin-Opener-Policy'] = ['same-origin']
      headers['Cross-Origin-Embedder-Policy'] = ['require-corp']
      headers['Cross-Origin-Resource-Policy'] = ['same-origin']
      callback({ responseHeaders: headers })
    })
    log('已启用跨源隔离响应头（COOP=same-origin / COEP=require-corp），SharedArrayBuffer 实时桥可用')
  } catch (error) {
    log('跨源隔离响应头注入失败（忽略，由服务端头兜底）：', error?.message ?? String(error))
  }
}

/** 窗口模式主流程：起服务 → 建窗口 → 建托盘。 */
async function startWindowMode() {
  serverHandle = await startLocalServer()
  // v2.2 M2：跨源隔离（SharedArrayBuffer）+ preload IPC。
  installCrossOriginIsolation()
  registerPluginIpc()
  // v2.1 P0：阻止系统因空闲/休眠挂起应用，保证后台预览/导出持续渲染。
  try {
    if (
      typeof powerSaveBlocker?.start === 'function' &&
      (powerSaveBlockerId < 0 || powerSaveBlocker.isStarted(powerSaveBlockerId) !== true)
    ) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      log(`已启用 powerSaveBlocker(prevent-app-suspension) id=${powerSaveBlockerId}`)
    }
  } catch (error) {
    log(`powerSaveBlocker 启动失败（忽略）：${error?.message ?? error}`)
  }
  createMainWindow(serverHandle)
  tray = createTray(mainWindow)
  ensureDesktopShortcut()
  writeAppStatus({
    running: true,
    mode: 'window',
    url: serverHandle.url,
    dataDir: serverHandle.dataDir,
    pid: process.pid,
  })
}

// ── 7. 应用生命周期 ────────────────────────────────────────────────────────

// 单实例锁：重复启动时聚焦/恢复已有窗口后退出。冒烟模式同样使用（使用独立 profile 时不会冲突）。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // 安全：所有 webContents 一律禁止开新窗口。
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

  app.whenReady().then(async () => {
    // 安全：本地应用不需要摄像头/麦克风/通知等权限。
    try {
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    } catch {
      /* 忽略 */
    }
    try {
      Menu.setApplicationMenu(null)
    } catch {
      /* 忽略 */
    }
    if (SMOKE_TEST) {
      await runSmokeTest()
      return
    }
    try {
      await startWindowMode()
    } catch (error) {
      log('启动失败：', error?.stack ?? String(error))
      if (!SMOKE_TEST) {
        dialog.showErrorBox(APP_TITLE, `启动失败：\n${error?.message ?? error}`)
      }
      await shutdownServer().catch(() => {})
      app.exit(1)
    }
  })

  // P11：有托盘时关闭窗口只是隐藏，服务常驻；无托盘（创建失败）才按旧行为退出。
  app.on('window-all-closed', () => {
    if (!tray && !SMOKE_TEST) app.quit()
  })

  // 退出前确保服务关闭（例如从系统菜单/任务管理器触发退出）。
  app.on('before-quit', (event) => {
    if (SMOKE_TEST) return
    if (serverHandle && !isQuitting) {
      event.preventDefault()
      void shutdownAndQuit()
    }
  })

  app.on('will-quit', () => {
    // 兜底：同步标记（异步 close 已在 before-quit/window close 流程中处理）。
    recordExit('will-quit', null)
    serverHandle = null
    // v2.1 P0：退出时释放 powerSaveBlocker（未启动/已停止时安全跳过）。
    try {
      if (
        powerSaveBlockerId >= 0 &&
        typeof powerSaveBlocker?.isStarted === 'function' &&
        powerSaveBlocker.isStarted(powerSaveBlockerId)
      ) {
        powerSaveBlocker.stop(powerSaveBlockerId)
      }
      powerSaveBlockerId = -1
    } catch {
      /* 忽略 */
    }
  })

  // P0：记录渲染进程/子进程崩溃原因，避免“窗口人间蒸发但没有日志”。
  app.on('render-process-gone', (_event, _webContents, details) => {
    log(`渲染进程退出：reason=${details?.reason ?? 'unknown'} exitCode=${details?.exitCode ?? '?'}`)
    recordExit('render-process-gone', details?.exitCode ?? null, details ?? null)
  })
  app.on('child-process-gone', (_event, details) => {
    log(`子进程退出：type=${details?.type ?? '?'} reason=${details?.reason ?? '?'} exitCode=${details?.exitCode ?? '?'}`)
    recordExit('child-process-gone', details?.exitCode ?? null, details ?? null)
  })

  process.on('SIGINT', () => {
    recordExit('SIGINT')
    void shutdownAndQuit()
  })
  process.on('SIGTERM', () => {
    recordExit('SIGTERM')
    void shutdownAndQuit()
  })
  process.on('uncaughtException', (error) => {
    log('未捕获异常：', error?.stack ?? String(error))
    recordExit('uncaughtException', 1, String(error?.stack ?? error))
    app.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log('未处理 Promise 拒绝：', String(reason?.stack ?? reason))
    recordExit('unhandledRejection', 1, String(reason?.stack ?? reason))
  })
}
