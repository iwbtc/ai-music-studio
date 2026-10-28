#!/usr/bin/env node
/**
 * AI 音乐工作室 — Electron portable exe 打包脚本。
 *
 * 产物：`dist/AI音乐工作室-win32-x64/AI音乐工作室.exe`（portable 文件夹，双击即用，
 * 不依赖系统 Node / Edge；数据写 `%APPDATA%\AI音乐工作室\`）。
 *
 * 关键点：
 * 1. 用临时 staging 目录（`desktop/.stage/`）组装 app 内容：根 package.json 的 `main`
 *    指向 `desktop/main.cjs`（仓库根 package.json 由 Lead 维护、不能改，这里生成副本）；
 * 2. 默认 `--asar` 模式：src/、standalone/、assets/ 全部打进 app.asar，main.cjs 用
 *    `import(import.meta 路径)` 加载 server.mjs（server.mjs 的 ROOT 在 asar 内同样成立）；
 * 3. `--mode=resources` 兜底模式：如果 asar 内 ESM 动态导入/静态资源读取在某种
 *    Electron 版本上不可用，把 src/standalone/assets/根 package.json 作为 extraResource
 *    复制到 `resources/`，main.cjs 会自动优先探测 `resources/src/standalone/server.mjs`；
 * 4. 用 @electron/packager + 本目录 devDependency 里的 electron 打包 win32-x64，
 *    图标来自 desktop/icon.ico（scripts/make-icon.mjs 生成），可执行名「AI音乐工作室.exe」。
 *
 * 用法（在 desktop/ 下）：
 *   npm install
 *   node build-exe.mjs                 # 默认 asar 模式
 *   node build-exe.mjs --mode=resources # 兜底模式（extraResource）
 *   node build-exe.mjs --m2-dev       # v2.2 M2 开发版：resources 模式 + desktop/preload.cjs +
 *                                      # VST3 Node sidecar（plugin-host-node.cjs + nvst3-host），
 *                                      # 输出 dist/m2-dev/（供 AIMS_M2_DESKTOP_EXE 测试，勿当发布包）
 *   node build-exe.mjs --m3-dev       # v2.2 M3 开发版（instrument/MIDI）：同上，输出 dist/m3-dev/，
 *                                      # 供 AIMS_M3_DESKTOP_EXE / AIMS_M2_DESKTOP_EXE 测试
 *   node build-exe.mjs --m4-dev       # v2.2 M4 开发版（freeze/导出）：同上，输出 dist/m4-dev/，
 *                                      # 供 AIMS_M4_DESKTOP_EXE / 回归测试
 *   node build-exe.mjs --v23-dev      # v2.3 P0 开发版（插件参数写回/实时同步/undo）：resources 模式，
 *                                      # 输出 dist/v23-dev/（供 AIMS_V23_DESKTOP_EXE 测试，勿当发布包）
 *   node build-exe.mjs --v24-dev      # v2.4 P0 开发版（quick_mix_check 秒级 draft / live meter / preview）：
 *                                      # resources 模式，输出 dist/v24-dev/（供 AIMS_V24_DESKTOP_EXE 测试）
 *   node build-exe.mjs                 # v2.2 M5 发布版（asar）：app.asar + resources/native/
 *                                      #   node/node.exe（Node 24 win-x64，MIT）、plugin-host-node.cjs、
 *                                      #   node_modules/{nvst3-host,node-gyp-build}（外部 node 不能读 asar）
 *   node build-exe.mjs --out=dist/xxx  # 自定义输出目录（相对仓库根或绝对路径）
 *   node build-exe.mjs --skip-icon     # 不改图标（调试用）
 *   node build-exe.mjs --require-clean # 发布构建：工作区不干净（build-info.gitDirty）时直接失败，
 *                                      # 确保 build-info.gitCommit 对齐最终 HEAD（也可用 AIMS_REQUIRE_CLEAN=1）
 *
 * 镜像：未设置 ELECTRON_MIRROR 时默认使用 https://npmmirror.com/mirrors/electron/
 * 缓存：Electron 压缩包缓存在 %LOCALAPPDATA%\electron\Cache（或 electron_config_cache）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const STAGE_DIR = path.join(HERE, '.stage')
const BUILD_LOG = path.join(HERE, 'build.log')
const APP_NAME = 'AI音乐工作室'

const args = process.argv.slice(2)
const argValue = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`${name}=`))
  if (hit) return hit.slice(name.length + 1)
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1]
  return fallback
}
/** v2.2 M2/M3/M4 + v2.3/v2.4 开发版快捷方式：resources 模式 + preload + Node sidecar 文件（非发布包）。 */
const M2_DEV = args.includes('--m2-dev')
const M3_DEV = args.includes('--m3-dev')
const M4_DEV = args.includes('--m4-dev')
const V23_DEV = args.includes('--v23-dev')
const V24_DEV = args.includes('--v24-dev')
const DEV_BUILD = M2_DEV || M3_DEV || M4_DEV || V23_DEV || V24_DEV
const MODE = DEV_BUILD ? 'resources' : argValue('--mode', 'asar') // asar | resources
const DEFAULT_OUT = V24_DEV
  ? path.join('dist', 'v24-dev')
  : V23_DEV
    ? path.join('dist', 'v23-dev')
    : M4_DEV
      ? path.join('dist', 'm4-dev')
      : M3_DEV
        ? path.join('dist', 'm3-dev')
        : M2_DEV
          ? path.join('dist', 'm2-dev')
          : 'dist'
/** v2.3：--out 可覆盖 dev 输出目录（如 --v23-dev --out=dist/v23-dev2 保留旧包）。 */
const DIST_DIR = path.resolve(REPO_ROOT, argValue('--out', DEFAULT_OUT))
/** M2 开发版：sidecar 脚本/native 依赖放在 asar 外的真实目录（external node 不能读 asar 虚拟路径）。 */
const M2_EXTRA_DIR = path.join(HERE, '.m2-extra')
/** M5 发布版：Node runtime + sidecar + native addon 放 resources/native（asar 外）。 */
const NATIVE_STAGE_ROOT = path.join(HERE, '.native-stage')
const NATIVE_STAGE_DIR = path.join(NATIVE_STAGE_ROOT, 'native')
const NODE_RUNTIME_CACHE_DIR = path.join(os.tmpdir(), 'aims-build-cache', 'node-runtime')
const NODE_RUNTIME_VERSION = 'v24.19.0'
const NODE_RUNTIME_ZIP_NAME = `node-${NODE_RUNTIME_VERSION}-win-x64.zip`
const NODE_RUNTIME_ZIP = path.join(NODE_RUNTIME_CACHE_DIR, NODE_RUNTIME_ZIP_NAME)
const NODE_RUNTIME_URL = `https://nodejs.org/dist/${NODE_RUNTIME_VERSION}/${NODE_RUNTIME_ZIP_NAME}`
/** 官方 node-v24.19.0-win-x64.zip 的 SHA256（nodejs.org SHASUMS256.txt）。 */
const NODE_RUNTIME_ZIP_SHA256 = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'
const SKIP_ICON = args.includes('--skip-icon')
const BUILD_INFO_ONLY = args.includes('--build-info-only')
/** v2.1：发布构建要求 git 工作区干净（build-info.gitCommit 才能对齐最终 HEAD）。 */
const REQUIRE_CLEAN = args.includes('--require-clean') || process.env.AIMS_REQUIRE_CLEAN === '1'

const startedAt = Date.now()
const logLines = []
function log(...parts) {
  const line = `[build-exe] ${parts.join(' ')}`
  console.log(line)
  logLines.push(`${new Date().toISOString()} ${line}`)
}
function flushLog() {
  try {
    writeFileSync(BUILD_LOG, `${logLines.join('\n')}\n`, 'utf8')
  } catch {
    /* 日志失败不影响构建 */
  }
}
function appendLog(text) {
  try {
    appendFileSync(BUILD_LOG, `${text}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

/** 读取 git 提交与工作区状态（非 git 环境/缺少 git → unknown/false 回退）。 */
function readGitState() {
  let gitCommit = 'unknown'
  let gitDirty = false
  try {
    gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown'
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    gitDirty = String(status).trim() !== ''
  } catch {
    // 非 git 环境/缺少 git → unknown 回退
  }
  return { gitCommit, gitDirty }
}

/** R7a：采集构建信息（version/gitCommit/gitDirty/buildDate/channel/electronVersion）。 */
function collectBuildInfo(version, electronVersion) {
  const { gitCommit, gitDirty } = readGitState()
  return {
    version: String(version ?? '1.0.0'),
    gitCommit,
    gitDirty,
    buildDate: new Date().toISOString(),
    channel: typeof process.env.AIMS_CHANNEL === 'string' && process.env.AIMS_CHANNEL !== '' ? process.env.AIMS_CHANNEL : 'stable',
    electronVersion: electronVersion ? String(electronVersion) : null,
  }
}

/** R7a：写出 build-info.json（供 app_info / GET /health 读取）。 */
function writeBuildInfo(outPath, version, electronVersion) {
  const info = collectBuildInfo(version, electronVersion)
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(info, null, 2) + '\n', 'utf8')
  return info
}

/** R7a：--build-info-only：只生成 build-info.json（不打包，便于 CI/单测）。 */
async function runBuildInfoOnly() {
  const rootPackage = readJson(path.join(REPO_ROOT, 'package.json'))
  const version = typeof rootPackage?.version === 'string' ? rootPackage.version : '1.0.0'
  let electronVersion = null
  try {
    electronVersion = installedElectronVersion()
  } catch {
    electronVersion = null
  }
  const outPath = path.resolve(argValue('--build-info-out', path.join(REPO_ROOT, 'build-info.json')))
  const info = writeBuildInfo(outPath, version, electronVersion)
  console.log('[build-info] ' + outPath)
  console.log(JSON.stringify(info, null, 2))
  return info
}

function die(message) {
  log(`ERROR: ${message}`)
  flushLog()
  process.exit(1)
}

/** 去掉目录（幂等）。 */
function resetDir(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/** 复制文件/目录，目标不存在时自动创建。 */
function copy(source, target) {
  if (!existsSync(source)) die(`缺少构建输入：${source}`)
  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, dereference: true })
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 读 desktop/node_modules/electron/package.json 的版本（与打包运行时一致）。 */
function installedElectronVersion() {
  const candidates = [
    path.join(HERE, 'node_modules', 'electron', 'package.json'),
    path.join(REPO_ROOT, 'node_modules', 'electron', 'package.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readJson(candidate).version
  }
  die('未找到已安装的 electron：请先在 desktop/ 下执行 npm install')
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * M5：确保官方 Node runtime zip 在缓存目录（%TEMP%/aims-build-cache/node-runtime，不入库）。
 * 已缓存则校验 SHA256；缺失则从 nodejs.org 下载并校验官方 SHA256。
 */
function ensureNodeRuntimeZip() {
  if (existsSync(NODE_RUNTIME_ZIP)) {
    const sha = sha256File(NODE_RUNTIME_ZIP)
    if (sha !== NODE_RUNTIME_ZIP_SHA256) die(`Node runtime zip SHA256 不匹配：${sha}（期望 ${NODE_RUNTIME_ZIP_SHA256}；可删除后重试：${NODE_RUNTIME_ZIP}）`)
    return true
  }
  mkdirSync(NODE_RUNTIME_CACHE_DIR, { recursive: true })
  log(`M5 Node runtime：下载官方 ${NODE_RUNTIME_URL} …`)
  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Invoke-WebRequest -Uri '${NODE_RUNTIME_URL}' -OutFile '${NODE_RUNTIME_ZIP.replace(/'/g, "''")}' -UseBasicParsing -TimeoutSec 300`,
    ], { stdio: ['ignore', 'inherit', 'inherit'] })
  } catch (error) {
    die(`下载 Node runtime 失败：${error?.message ?? error}（可手动下载 ${NODE_RUNTIME_URL} 放到 ${NODE_RUNTIME_ZIP}）`)
  }
  const sha = sha256File(NODE_RUNTIME_ZIP)
  if (sha !== NODE_RUNTIME_ZIP_SHA256) die(`下载的 Node runtime zip SHA256 不匹配：${sha}（期望 ${NODE_RUNTIME_ZIP_SHA256}）`)
  return true
}

/**
 * M5：组装 resources/native（asar 外）资源。
 * - node/node.exe：优先官方 node-v24.19.0-win-x64.zip（SHA 对齐官方 SHASUMS），其次 AIMS_NODE_RUNTIME 指定文件；
 * - node/LICENSE：来自官方 zip 的 LICENSE（MIT，合规）；本机复制源无 LICENSE 时写来源说明文件；
 * - plugin-host-node.cjs + node_modules/{nvst3-host,node-gyp-build}：external node 不能读 asar。
 * 返回 { nodeRuntime, files } 写入构建日志/摘要。
 */
function prepareNativeRuntime() {
  resetDir(NATIVE_STAGE_DIR)
  let nodeSource = ''
  let nodeLicenseSource = ''
  let zipSha256 = null
  let extractDir = ''
  const envRuntime = typeof process.env.AIMS_NODE_RUNTIME === 'string' && process.env.AIMS_NODE_RUNTIME.trim() !== ''
    ? path.resolve(process.env.AIMS_NODE_RUNTIME.trim())
    : ''
  if (!(envRuntime && existsSync(envRuntime))) ensureNodeRuntimeZip()
  if (envRuntime && existsSync(envRuntime)) {
    nodeSource = envRuntime
    log(`M5 Node runtime：使用 AIMS_NODE_RUNTIME=${nodeSource}`)
  } else if (existsSync(NODE_RUNTIME_ZIP)) {
    zipSha256 = sha256File(NODE_RUNTIME_ZIP)
    extractDir = path.join(NATIVE_STAGE_DIR, '.node-extract')
    mkdirSync(extractDir, { recursive: true })
    log(`M5 Node runtime：解压官方 ${path.basename(NODE_RUNTIME_ZIP)}（sha256=${zipSha256}）…`)
    try {
      execFileSync('tar', ['-xf', NODE_RUNTIME_ZIP, '-C', extractDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      // 兜底：PowerShell Expand-Archive
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${NODE_RUNTIME_ZIP}' -DestinationPath '${extractDir}' -Force`], { stdio: ['ignore', 'pipe', 'pipe'] })
      log('（tar 解压失败，已用 PowerShell Expand-Archive 兜底）')
    }
    const extractedRoot = path.join(extractDir, `node-${NODE_RUNTIME_VERSION}-win-x64`)
    nodeSource = path.join(extractedRoot, 'node.exe')
    nodeLicenseSource = path.join(extractedRoot, 'LICENSE')
    if (!existsSync(nodeSource)) die(`M5 Node runtime zip 中未找到 node.exe：${nodeSource}`)
  } else if (process.platform === 'win32' && !process.versions?.electron && existsSync(process.execPath)) {
    nodeSource = process.execPath
    log(`M5 Node runtime：官方 zip 未缓存，回退本机 Node（${nodeSource}；发布前建议执行 desktop/fetch-node-runtime.mjs 下载官方 zip）`)
  } else {
    die(`M5 需要 Node runtime：请先下载官方 zip 到 ${NODE_RUNTIME_ZIP}（${NODE_RUNTIME_URL}），或设置 AIMS_NODE_RUNTIME 指向 node.exe`)
  }
  const nodeVersion = String(execFileSync(nodeSource, ['--version'], { encoding: 'utf8', windowsHide: true })).trim()
  if (!/^v24\./.test(nodeVersion)) die(`M5 bundled Node 必须是 24.x（当前 ${nodeVersion}，来源 ${nodeSource}）`)
  const nodeDir = path.join(NATIVE_STAGE_DIR, 'node')
  mkdirSync(nodeDir, { recursive: true })
  copy(nodeSource, path.join(nodeDir, 'node.exe'))
  if (nodeLicenseSource && existsSync(nodeLicenseSource)) copy(nodeLicenseSource, path.join(nodeDir, 'LICENSE'))
  else writeFileSync(path.join(nodeDir, 'LICENSE-NOTE.txt'), `Node.js ${nodeVersion} (MIT) 来源：${nodeSource}\n官方发布：${NODE_RUNTIME_URL}\n`, 'utf8')
  copy(path.join(HERE, 'plugin-host-node.cjs'), path.join(NATIVE_STAGE_DIR, 'plugin-host-node.cjs'))
  for (const moduleName of ['node-gyp-build']) {
    const source = path.join(REPO_ROOT, 'node_modules', moduleName)
    if (!existsSync(source)) die(`缺少 VST3 sidecar 依赖：${source}（请先在仓库根执行 npm install）`)
    copy(source, path.join(NATIVE_STAGE_DIR, 'node_modules', moduleName))
  }
  {
    // nvst3-host 同时放 native/nvst3-host（sidecar __dirname 候选）与 native/node_modules/nvst3-host
    // （M5 E2E 校验安装目录含 resources/native/node_modules/nvst3-host，二者兼容）。
    const source = path.join(REPO_ROOT, 'node_modules', 'nvst3-host')
    if (!existsSync(source)) die(`缺少 VST3 sidecar 依赖：${source}（请先在仓库根执行 npm install）`)
    copy(source, path.join(NATIVE_STAGE_DIR, 'nvst3-host'))
    copy(source, path.join(NATIVE_STAGE_DIR, 'node_modules', 'nvst3-host'))
  }
  const meta = {
    nodeVersion,
    nodeSource,
    nodeSha256: sha256File(path.join(nodeDir, 'node.exe')),
    officialZip: existsSync(NODE_RUNTIME_ZIP) ? path.basename(NODE_RUNTIME_ZIP) : null,
    officialZipUrl: existsSync(NODE_RUNTIME_ZIP) ? NODE_RUNTIME_URL : null,
    officialZipSha256: zipSha256,
    electronVersion: installedElectronVersion(),
    license: existsSync(path.join(nodeDir, 'LICENSE')) ? 'LICENSE (from official zip)' : 'LICENSE-NOTE.txt',
  }
  writeFileSync(path.join(NATIVE_STAGE_DIR, 'runtime-info.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  log(
    `M5 native 资源：resources/native/node/node.exe（${nodeVersion}，sha256=${meta.nodeSha256}） + ` +
      'plugin-host-node.cjs + node_modules/{nvst3-host,node-gyp-build}',
  )
  // 清理 zip 解压临时目录（只保留待 extraResource 的 native 目录）。
  if (extractDir) rmSync(extractDir, { recursive: true, force: true })
  return meta
}

/** M5：读取 asar 文件列表（dist 内 app.asar），用于 preload/main/server 打包校验。 */
async function listAsarFiles(asarPath) {
  const asar = await import('@electron/asar')
  const list = typeof asar.listPackage === 'function' ? asar.listPackage(asarPath) : null
  return Array.isArray(list) ? list.map((entry) => String(entry).replaceAll('\\', '/').replace(/^\//, '')) : null
}

async function main() {
  log(`模式：${MODE}${SKIP_ICON ? '（跳过图标）' : ''}`)
  log(`仓库根目录：${REPO_ROOT}`)

  // 0) 检查关键输入
  const rootPackage = readJson(path.join(REPO_ROOT, 'package.json'))
  const version = typeof rootPackage.version === 'string' ? rootPackage.version : '1.0.0'
  const electronVersion = installedElectronVersion()
  /** @type {null | { nodeVersion:string, nodeSource:string, nodeSha256:string }} */
  let nativeMeta = null

  // 0.5) 发布构建前置检查（v2.1）：工作区必须干净，确保 build-info.gitCommit 对齐最终 HEAD。
  // 放在组装 staging 之前，避免脏工作区留下半成品 staging 目录。
  if (REQUIRE_CLEAN) {
    const git = readGitState()
    if (git.gitDirty) {
      die(
        '发布构建要求工作区干净（--require-clean）：检测到未提交改动。' +
          `当前 HEAD=${git.gitCommit}；请先提交全部改动后再重建，使 build-info.gitCommit 对齐最终 HEAD。`,
      )
    }
    log(`工作区干净：gitCommit=${git.gitCommit}（build-info 将对齐最终 HEAD）`)
  }

  const iconSource = path.join(HERE, 'icon.ico')
  if (!SKIP_ICON && !existsSync(iconSource)) {
    log('未发现 desktop/icon.ico，先运行 node ../scripts/make-icon.mjs 生成')
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'make-icon.mjs')], { stdio: 'inherit' })
  }

  // 1) 镜像（打包时 @electron/get 需要下载 Electron 压缩包，缓存命中则不重复下载）
  if (!process.env.ELECTRON_MIRROR) {
    process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  }
  log(`Electron 版本：${electronVersion}；镜像：${process.env.ELECTRON_MIRROR}`)

  // 2) 组装 staging 目录
  log('组装 staging 目录…')
  resetDir(STAGE_DIR)

  const stagePackage = {
    name: APP_NAME,
    productName: APP_NAME,
    version,
    description: rootPackage.description ?? 'AI 音乐工作室',
    author: rootPackage.author ?? 'AI 音乐工作室',
    license: rootPackage.license ?? 'MIT',
    type: 'module',
    main: 'desktop/main.cjs',
  }
  writeFileSync(path.join(STAGE_DIR, 'package.json'), `${JSON.stringify(stagePackage, null, 2)}\n`, 'utf8')
  copy(path.join(HERE, 'main.cjs'), path.join(STAGE_DIR, 'desktop', 'main.cjs'))
  // v2.2 M2：preload 与 main.cjs 同目录进包（main.cjs 用 __dirname/preload.cjs 定位，asar 内同样成立）。
  copy(path.join(HERE, 'preload.cjs'), path.join(STAGE_DIR, 'desktop', 'preload.cjs'))
  // R7a：生成 build-info.json（仓库根供开发/测试读取，staging 根随 app 打包进 exe）。
  const buildInfo = writeBuildInfo(path.join(REPO_ROOT, 'build-info.json'), version, electronVersion)
  writeBuildInfo(path.join(STAGE_DIR, 'build-info.json'), version, electronVersion)
  log('build-info.json：版本 ' + buildInfo.version + ' · ' + buildInfo.gitCommit + (buildInfo.gitDirty ? ' (dirty)' : '') + ' · ' + buildInfo.buildDate)
  if (buildInfo.gitDirty) {
    const message =
      '工作区有未提交改动：build-info.gitDirty=true，gitCommit 可能不对应最终发布 HEAD。' +
      '发布构建请先提交全部改动（或用 --require-clean 强制拦截），再重新打包。'
    if (REQUIRE_CLEAN) die(message)
    log('警告：' + message)
  }
  if (existsSync(iconSource)) copy(iconSource, path.join(STAGE_DIR, 'desktop', 'icon.ico'))

  if (MODE === 'resources') {
    // 兜底模式：源码/静态资源复制到 resources/，asar 内只留主进程入口。
    log('extraResource 模式：src/standalone/assets/package.json 将复制到 resources/')
    // v2.2 M2 开发版：VST3 Node sidecar 由外部 PATH node 执行，脚本/native addon 必须是真实文件路径。
    // 打包后 server.mjs 的 ROOT = <app>/resources → 默认 sidecar = resources/desktop/plugin-host-node.cjs。
    resetDir(M2_EXTRA_DIR)
    copy(path.join(HERE, 'plugin-host-node.cjs'), path.join(M2_EXTRA_DIR, 'desktop', 'plugin-host-node.cjs'))
    for (const moduleName of ['nvst3-host', 'node-gyp-build']) {
      const source = path.join(REPO_ROOT, 'node_modules', moduleName)
      if (!existsSync(source)) die(`缺少 VST3 sidecar 依赖：${source}（请先在仓库根执行 npm install）`)
      copy(source, path.join(M2_EXTRA_DIR, 'node_modules', moduleName))
    }
    log(
      'M2/M3 开发版 sidecar 资源：resources/desktop/plugin-host-node.cjs + ' +
        'resources/node_modules/{nvst3-host,node-gyp-build}（运行需 PATH 中的 node）',
    )
  } else {
    // 默认 asar 模式：应用源码全部进 app.asar
    copy(path.join(REPO_ROOT, 'src'), path.join(STAGE_DIR, 'src'))
    copy(path.join(REPO_ROOT, 'standalone'), path.join(STAGE_DIR, 'standalone'))
    copy(path.join(REPO_ROOT, 'assets'), path.join(STAGE_DIR, 'assets'))
    // v2.2 M5：Node runtime + sidecar/native addon 放 resources/native（asar 外，外部 node 不能读 asar）。
    nativeMeta = prepareNativeRuntime()
  }

  // 3) @electron/packager 打包
  const { packager } = await import('@electron/packager')
  /** @type {any} */
  const options = {
    dir: STAGE_DIR,
    out: DIST_DIR,
    name: APP_NAME,
    executableName: APP_NAME,
    platform: 'win32',
    arch: 'x64',
    electronVersion,
    appVersion: version,
    appCopyright: `Copyright © ${new Date().getFullYear()} AI 音乐工作室`,
    asar: MODE !== 'resources',
    overwrite: true,
    prune: true,
    derefSymlinks: true,
    junk: true,
    quiet: false,
    win32metadata: {
      CompanyName: 'AI 音乐工作室',
      FileDescription: 'AI 音乐工作室 — 独立窗口版音乐工作站',
      ProductName: 'AI 音乐工作室',
      InternalName: APP_NAME,
      OriginalFilename: `${APP_NAME}.exe`,
      'requested-execution-level': 'asInvoker',
    },
  }
  if (!SKIP_ICON && existsSync(iconSource)) options.icon = iconSource
  if (MODE === 'resources') {
    // extraResource 会复制到 <dist app>/resources/ 下，main.cjs 优先探测 resources/src/standalone/server.mjs
    options.extraResource = [
      path.join(REPO_ROOT, 'src'),
      path.join(REPO_ROOT, 'standalone'),
      path.join(REPO_ROOT, 'assets'),
      path.join(REPO_ROOT, 'package.json'),
      path.join(REPO_ROOT, 'build-info.json'),
      // v2.2 M2 开发版：sidecar 脚本 + native addon 依赖放 asar 外（真实文件路径）。
      ...(existsSync(M2_EXTRA_DIR)
        ? [path.join(M2_EXTRA_DIR, 'desktop'), path.join(M2_EXTRA_DIR, 'node_modules')]
        : []),
    ]
  } else {
    // v2.2 M5 发布版：native 目录（node/node.exe + sidecar + node_modules）复制到 resources/native。
    options.extraResource = [NATIVE_STAGE_DIR]
  }

  log('开始打包（若首次运行会下载 Electron 压缩包，约 150MB）…')
  const buildStartedAt = Date.now()
  let appPaths
  try {
    appPaths = await packager(options)
  } catch (error) {
    die(`打包失败：${error?.stack ?? error?.message ?? error}`)
  }
  const buildMs = Date.now() - buildStartedAt
  log(`packager 输出：${Array.isArray(appPaths) ? appPaths.join(' | ') : appPaths}`)
  if (!Array.isArray(appPaths) || appPaths.length === 0) die('packager 未返回输出目录')

  const appDir = appPaths[0]
  const exePath = path.join(appDir, `${APP_NAME}.exe`)
  if (!existsSync(exePath)) die(`未找到可执行文件：${exePath}`)

  // 4) 产物自检 & 汇总
  const exeSize = statSync(exePath).size
  const resourcesDir = path.join(appDir, 'resources')
  const asarPath = path.join(resourcesDir, 'app.asar')
  /** v2.2 M2：resources 模式下 preload/sidecar/native 依赖必须是 asar 外真实文件。 */
  const m2Checks = {
    preload: existsSync(path.join(resourcesDir, 'app', 'desktop', 'preload.cjs')),
    sidecar: existsSync(path.join(resourcesDir, 'desktop', 'plugin-host-node.cjs')),
    nvst3: existsSync(path.join(resourcesDir, 'node_modules', 'nvst3-host', 'package.json')),
    nodeGypBuild: existsSync(path.join(resourcesDir, 'node_modules', 'node-gyp-build', 'package.json')),
  }
  const checks = {
    exe: existsSync(exePath),
    asar: existsSync(asarPath),
    resourcesSrc: existsSync(path.join(resourcesDir, 'src', 'standalone', 'server.mjs')),
  }
  if (!checks.exe || (!checks.asar && !checks.resourcesSrc)) {
    die(`产物不完整：${JSON.stringify(checks)}\n目录：${appDir}`)
  }
  if (DEV_BUILD && !(m2Checks.preload && m2Checks.sidecar && m2Checks.nvst3 && m2Checks.nodeGypBuild)) {
    die(`M2/M3/M4 开发版产物缺少 preload/sidecar 资源：${JSON.stringify(m2Checks)}\n目录：${appDir}`)
  }
  // v2.2 M5：发布版必须内含 Node runtime/sidecar/native 依赖（asar 外），且 asar 内有 preload/main/server。
  const nativeChecks = {
    node: existsSync(path.join(resourcesDir, 'native', 'node', 'node.exe')),
    nodeLicense: existsSync(path.join(resourcesDir, 'native', 'node', 'LICENSE')) || existsSync(path.join(resourcesDir, 'native', 'node', 'LICENSE-NOTE.txt')),
    sidecar: existsSync(path.join(resourcesDir, 'native', 'plugin-host-node.cjs')),
    nvst3: existsSync(path.join(resourcesDir, 'native', 'node_modules', 'nvst3-host', 'package.json')),
    nodeGypBuild: existsSync(path.join(resourcesDir, 'native', 'node_modules', 'node-gyp-build', 'package.json')),
    nvst3Root: existsSync(path.join(resourcesDir, 'native', 'nvst3-host', 'package.json')),
    runtimeInfo: existsSync(path.join(resourcesDir, 'native', 'runtime-info.json')),
  }
  let asarChecks = null
  if (checks.asar) {
    try {
      const files = await listAsarFiles(asarPath)
      if (files) {
        asarChecks = {
          preload: files.includes('desktop/preload.cjs'),
          main: files.includes('desktop/main.cjs'),
          server: files.includes('src/standalone/server.mjs'),
          buildInfo: files.includes('build-info.json'),
        }
      }
    } catch (error) {
      log(`警告：读取 app.asar 列表失败（跳过 asar 静态校验）：${error?.message ?? error}`)
    }
  }
  if (MODE === 'asar') {
    const missingNative = Object.entries(nativeChecks).filter(([, ok]) => !ok).map(([name]) => name)
    if (missingNative.length > 0) die(`M5 发布版缺少 resources/native 资源：${missingNative.join(', ')}\n目录：${appDir}`)
    if (asarChecks && !(asarChecks.preload && asarChecks.main && asarChecks.server)) {
      die(`M5 发布版 app.asar 缺少关键文件：${JSON.stringify(asarChecks)}\n目录：${appDir}`)
    }
  }

  const dirSize = (() => {
    let total = 0
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) total += statSync(full).size
      }
    }
    walk(appDir)
    return total
  })()

  const summary = {
    ok: true,
    mode: MODE,
    devBuild: DEV_BUILD,
    m2Dev: M2_DEV,
    m3Dev: M3_DEV,
    m4Dev: M4_DEV,
    v23Dev: V23_DEV,
    v24Dev: V24_DEV,
    outDir: DIST_DIR,
    exePath,
    appDir,
    exeSize,
    exeSizeMB: Number((exeSize / 1024 / 1024).toFixed(2)),
    appDirSizeMB: Number((dirSize / 1024 / 1024).toFixed(2)),
    electronVersion,
    appVersion: version,
    asar: checks.asar,
    asarMB: checks.asar ? Number((statSync(asarPath).size / 1024 / 1024).toFixed(2)) : 0,
    ...(DEV_BUILD ? { m2: m2Checks, m3: M3_DEV, m4: M4_DEV, v23: V23_DEV, v24: V24_DEV, sidecarPath: path.join(resourcesDir, 'desktop', 'plugin-host-node.cjs') } : {}),
    ...(MODE === 'asar' ? { native: nativeChecks, asarFiles: asarChecks, nodeRuntime: nativeMeta } : {}),
    buildMs,
    totalMs: Date.now() - startedAt,
  }
  log(`BUILD_OK ${JSON.stringify(summary)}`)
  appendLog(`${new Date().toISOString()} ${JSON.stringify(summary)}`)
  flushLog()

  // 清理 staging（失败时保留便于排查；成功即删）
  if (process.env.AIMS_KEEP_STAGE !== '1') {
    rmSync(STAGE_DIR, { recursive: true, force: true })
    rmSync(M2_EXTRA_DIR, { recursive: true, force: true })
    rmSync(NATIVE_STAGE_ROOT, { recursive: true, force: true })
  }
  if (nativeMeta) {
    console.log(`\n✅ 打包完成：${exePath}（${summary.exeSizeMB} MB，Node ${nativeMeta.nodeVersion} bundled，耗时 ${(summary.buildMs / 1000).toFixed(1)}s）`)
  } else {
    console.log(`\n✅ 打包完成：${exePath}（${summary.exeSizeMB} MB，耗时 ${(summary.buildMs / 1000).toFixed(1)}s）`)
  }
}

if (BUILD_INFO_ONLY) {
  try {
    await runBuildInfoOnly()
  } catch (error) {
    die('生成 build-info 失败：' + (error?.message ?? error))
    process.exitCode = 1
  }
} else {
main().catch((error) => {
  die(`未捕获错误：${error?.stack ?? error}`)
})
}
