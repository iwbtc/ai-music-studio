#!/usr/bin/env node
/**
 * AI 音乐工作室 — 安装 / 卸载脚本。
 *
 * 把当前插件目录以 `link:` 依赖装进指定 DSH profile，并把包名追加到
 * profile package.json 的 `dsh.profile.bundles`（DSH 会热重载 profile，
 * 插件通常在几秒内自动挂载，无需重启）。
 *
 * 用法（在插件目录下）：
 *   node scripts/install.mjs                 # 装进 desktop profile（默认）
 *   node scripts/install.mjs --profile web   # 装进指定的其它 profile
 *   node scripts/install.mjs --uninstall     # 卸载
 *   node scripts/install.mjs --dry-run       # 只打印将做什么
 *
 * 安全：修改 profile 前会备份 package.json；失败会提示备份位置。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_EXE_CANDIDATES = [
  process.env.DSH_EXE,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'DeepSeek Harness', 'DeepSeek Harness.exe'),
].filter(Boolean)
const EXE = DSH_EXE_CANDIDATES.find((candidate) => existsSync(candidate)) || null
const CLI = process.env.DSH_CLI || (EXE
  ? join(dirname(EXE), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  : '')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const flag = (name) => args.includes(name)

const profileName = option('--profile', 'desktop')
const uninstallMode = flag('--uninstall')
const dryRun = flag('--dry-run')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profileName)
const profilePkgPath = join(profileDir, 'package.json')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')

const pluginPkg = readJson(join(PLUGIN_ROOT, 'package.json'))
const PLUGIN_NAME = pluginPkg.name
const linkSpec = 'link:' + PLUGIN_ROOT.replace(/\\/g, '/')

function fail(message) {
  console.error('\n[install] 失败：' + message)
  process.exit(1)
}

if (!existsSync(profilePkgPath)) fail(`找不到 profile：${profilePkgPath}（DSH_HOME=${dshHome}）`)
// 注意：CLI 入口在 app.asar 内部，普通 Node 的 existsSync 看不到 asar 虚拟文件，
// 因此只校验桌面可执行文件；CLI 路径交给 Electron 解析。
if (!EXE) fail('找不到 DeepSeek Harness 桌面程序。请设置环境变量 DSH_EXE 指向 DeepSeek Harness.exe（可选 DSH_CLI 指向 dsh-desktop-host/lib/cli.js）。')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = profilePkgPath + '.bak-aims-' + stamp
copyFileSync(profilePkgPath, backup)
console.log(`[install] profile: ${profileDir}`)
console.log(`[install] 插件: ${PLUGIN_NAME} @ ${PLUGIN_ROOT}`)
console.log(`[install] package.json 备份: ${backup}`)

function runCli(cliArgs) {
  console.log(`[install] 执行: dsh ${cliArgs.join(' ')}`)
  return execFileSync(EXE, ['--expose-internals', CLI, ...cliArgs], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 300000,
  })
}

function readProfilePkg() {
  return readJson(profilePkgPath)
}

/** 确保 dsh.profile.bundles 含插件名（保持原有顺序，追加到末尾）。 */
function ensureBundle(pkg) {
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME)
  pkg.dsh.profile.bundles = bundles
  return pkg
}

function removeBundle(pkg) {
  const bundles = pkg?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) pkg.dsh.profile.bundles = bundles.filter((b) => b !== PLUGIN_NAME)
  return pkg
}

/** 检查依赖是否已写进 profile（pnpm add 之后）。 */
function ensureDependency(pkg) {
  pkg.dependencies = pkg.dependencies || {}
  if (!pkg.dependencies[PLUGIN_NAME]) pkg.dependencies[PLUGIN_NAME] = linkSpec
  return pkg
}

async function healthCheck(label) {
  const url = (process.env.DSH_WEB_URL || '').replace(/\/$/, '')
  if (!url) {
    console.log('[install] 未发现 DSH_WEB_URL 环境变量，跳过健康检查（可从 GUI 打开面板确认）')
    return false
  }
  const target = `${url}/studio/api/health`
  const deadline = Date.now() + 45000
  process.stdout.write(`[install] 等待 ${label}（最多 45s）`)
  while (Date.now() < deadline) {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(2500) })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        console.log(`\n[install] ✅ 插件已挂载：${JSON.stringify(data)}`)
        return true
      }
    } catch {}
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 1500))
  }
  console.log('\n[install] ⚠️ 健康检查超时：插件可能尚未热挂载；如果 GUI 里看不到入口，请重启 DeepSeek Harness。')
  return false
}

async function install() {
  // 1) 用 DSH desktop CLI（内部转发 pnpm）把 link 依赖装进 profile
  if (!dryRun) {
    try {
      runCli(['plugin', '--profile', profileName, 'add', linkSpec])
    } catch {
      console.warn('[install] CLI pnpm 安装失败，尝试手动复制安装…')
      manualCopyInstall()
    }
    // 2) 确保依赖与 bundles 条目（CLI 只做 pnpm；bundles 由本脚本维护）
    const pkg = ensureBundle(ensureDependency(readProfilePkg()))
    writeJson(profilePkgPath, pkg)
    console.log(`[install] 已把 ${PLUGIN_NAME} 加入 dsh.profile.bundles`)
  } else {
    console.log('[install] dry-run：将执行的步骤 1) CLI pnpm add 2) 写入 bundles 3) 健康检查')
    return
  }
  // 3) 热挂载健康检查
  await healthCheck('Host 热挂载')
  console.log('\n[install] 完成。GUI 侧栏应出现「音乐工作室」入口。')
}

/** 兜底：直接把插件目录复制进 profile/node_modules 并写依赖。 */
function manualCopyInstall() {
  const target = join(profileDir, 'node_modules', PLUGIN_NAME)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  cpSync(PLUGIN_ROOT, target, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(PLUGIN_ROOT.length).replace(/\\/g, '/')
      if (rel.startsWith('/node_modules')) return false
      if (rel.startsWith('/.git')) return false
      if (rel.startsWith('/data/exports')) return false
      return true
    },
  })
  console.log(`[install] 已复制插件到 ${target}`)
}

function uninstall() {
  if (dryRun) {
    console.log('[install] dry-run：将移除 bundles 条目并执行 pnpm remove')
    return
  }
  const pkg = removeBundle(readProfilePkg())
  writeJson(profilePkgPath, pkg)
  try {
    runCli(['plugin', '--profile', profileName, 'remove', PLUGIN_NAME])
  } catch {
    console.warn('[install] pnpm remove 失败，可能已不存在；尝试手动清理 node_modules')
    rmSync(join(profileDir, 'node_modules', PLUGIN_NAME), { recursive: true, force: true })
  }
  console.log(`[install] 已从 profile ${profileName} 卸载 ${PLUGIN_NAME}（备份：${backup}）`)
}

if (uninstallMode) uninstall()
else await install()
