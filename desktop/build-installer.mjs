#!/usr/bin/env node
/**
 * R7a：把便携版打包成「自解压安装程序」Setup.exe（7-Zip SFX）。
 *
 * 流程：
 *   1. 确保 dist/AI音乐工作室-win32-x64 最新（默认复用 desktop/build-exe.mjs；--skip-exe 跳过）；
 *   2. staging 到 dist/installer/staging：app 全部文件 + Install.ps1 + Uninstall.ps1 +
 *      installer-meta.json + installer-config.txt；
 *   3. 7z a -mx=5 app.7z * → copy /b 7z.sfx + app.7z + installer-config.txt =
 *      dist/installer/AI音乐工作室-Setup-<version>.exe；
 *   4. SFX 解压后运行 Install.ps1（用户级安装，无需管理员）。
 *
 * 用法（仓库根）：
 *   node desktop/build-installer.mjs                # 先构建便携版再打安装包
 *   node desktop/build-installer.mjs --skip-exe     # 复用现有 dist 便携版（更快）
 *   node desktop/build-installer.mjs --keep-staging # 保留 dist/installer/staging 便于排查
 *   node desktop/build-installer.mjs --app-dir=dist/m5-preview/AI音乐工作室-win32-x64 \
 *        --installer-dir=dist/m5-preview/installer   # M5 预览：复用指定便携版并输出到指定目录（不覆盖发布 dist）
 *
 * 环境变量：
 *   AIMS_7Z   自定义 7z.exe 路径（默认 C:\Program Files\7-Zip\7z.exe）
 *
 * 7-Zip 缺失时：输出中文错误 + 替代 zip 方案（并尝试生成便携 zip），退出码 1。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const argValue = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`${name}=`))
  if (hit) return hit.slice(name.length + 1)
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1]
  return fallback
}
/** v2.2 M5：可指定便携版目录/安装包输出目录（预览构建不覆盖发布 dist）。 */
const APP_DIR = path.resolve(REPO_ROOT, argValue('--app-dir', path.join('dist', 'AI音乐工作室-win32-x64')))
const INSTALLER_DIR = path.resolve(REPO_ROOT, argValue('--installer-dir', path.join('dist', 'installer')))
const STAGING_DIR = path.join(INSTALLER_DIR, 'staging')
const INSTALLER_SRC = path.join(HERE, 'installer')
const APP_NAME = 'AI音乐工作室'
const EXE_NAME = `${APP_NAME}.exe`

const SKIP_EXE = args.includes('--skip-exe') || argValue('--app-dir', '') !== ''
const KEEP_STAGING = args.includes('--keep-staging')
const SEVEN_ZIP = process.env.AIMS_7Z || 'C:\\Program Files\\7-Zip\\7z.exe'
const SEVEN_ZIP_SFX_CANDIDATES = [
  path.join(path.dirname(SEVEN_ZIP), '7z.sfx'),
  path.join(path.dirname(SEVEN_ZIP), '7zCon.sfx'),
]

const log = (...parts) => console.log(`[installer] ${parts.join(' ')}`)
function die(message, hint = '') {
  console.error(`\n[installer] 错误：${message}`)
  if (hint) console.error(hint)
  process.exit(1)
}

/** 读取根 package.json 版本（打包 exe 用的就是它）。 */
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version || '1.0.0')
  } catch {
    return '1.0.0'
  }
}

function ensurePortableBuild() {
  if (SKIP_EXE) {
    if (!existsSync(path.join(APP_DIR, EXE_NAME))) {
      die(`--skip-exe 但未找到便携版：${APP_DIR}\\${EXE_NAME}`, '请先运行 node desktop/build-exe.mjs，或不加 --skip-exe 重新构建。')
    }
    log('跳过便携版构建（--skip-exe），复用', APP_DIR)
    return
  }
  log('正在构建便携版（desktop/build-exe.mjs）…')
  const result = spawnSync(process.execPath, [path.join(HERE, 'build-exe.mjs')], { cwd: REPO_ROOT, stdio: 'inherit' })
  if (result.status !== 0) die(`便携版构建失败（退出码 ${result.status}）`)
  if (!existsSync(path.join(APP_DIR, EXE_NAME))) die(`便携版构建后仍未找到 ${APP_DIR}\\${EXE_NAME}`)
}

/** 生成 SFX 配置（7z SFX 模块读取；UTF-8 无 BOM）。 */
function writeInstallerConfig(target, version) {
  const lines = [
    ';!@Install@!UTF-8!',
    `Title=${APP_NAME} ${version} 安装`,
    `BeginPrompt=将安装 ${APP_NAME} 到当前用户目录（无需管理员），是否继续？`,
    'Progress=yes',
    'RunProgram="powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install.ps1"',
    ';!@InstallEnd@!',
    '',
  ]
  writeFileSync(target, lines.join('\r\n'), 'utf8')
}

function main() {
  const version = readVersion()
  log(`版本 ${version}；7-Zip：${SEVEN_ZIP}`)

  // 0) 7-Zip 检查（缺失时给中文错误 + zip 替代方案）
  const has7z = existsSync(SEVEN_ZIP)
  const sfxPath = SEVEN_ZIP_SFX_CANDIDATES.find((item) => existsSync(item)) || ''
  if (!has7z || !sfxPath) {
    const detail = !has7z ? `未找到 7z.exe：${SEVEN_ZIP}` : `未找到 7z.sfx / 7zCon.sfx（目录 ${path.dirname(SEVEN_ZIP)}）`
    // 尝试生成替代 zip（staging 里只有 app 文件 + 安装脚本）
    try {
      ensurePortableBuild()
      rmSync(STAGING_DIR, { recursive: true, force: true })
      mkdirSync(STAGING_DIR, { recursive: true })
      stageAppFiles()
      const zipPath = path.join(INSTALLER_DIR, `${APP_NAME}-${version}.zip`)
      const zip = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Compress-Archive -Path '${STAGING_DIR.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ], { cwd: REPO_ROOT, stdio: 'inherit' })
      const zipText = zip.status === 0 && existsSync(zipPath) ? `已生成替代 zip：${zipPath}` : '替代 zip 生成失败。'
      die(detail, `替代方案：安装 7-Zip（https://www.7-zip.org/）后重试；或手动打包 zip：\n  ${zipText}\n  Compress-Archive -Path "${STAGING_DIR}\\*" -DestinationPath "${zipPath}" -Force`)
    } catch (error) {
      die(detail, `替代方案：安装 7-Zip（https://www.7-zip.org/）后重试；或把 dist\\AI音乐工作室-win32-x64 与 desktop\\installer 脚本一起打成 zip 分发。\n（${String(error?.message ?? error)}）`)
    }
  }

  // 1) 便携版最新
  ensurePortableBuild()

  // 2) staging
  log('正在 staging 安装文件…')
  rmSync(STAGING_DIR, { recursive: true, force: true })
  mkdirSync(STAGING_DIR, { recursive: true })
  stageAppFiles()
  const scriptNames = ['Install.ps1', 'Uninstall.ps1']
  for (const name of scriptNames) {
    const src = path.join(INSTALLER_SRC, name)
    if (!existsSync(src)) die(`缺少安装脚本：${src}`)
    cpSync(src, path.join(STAGING_DIR, name))
  }
  writeInstallerConfig(path.join(INSTALLER_DIR, 'installer-config.txt'), version)
  writeFileSync(path.join(STAGING_DIR, 'installer-meta.json'), JSON.stringify({
    name: APP_NAME,
    version,
    channel: 'stable',
    builtAt: new Date().toISOString(),
    builtBy: 'desktop/build-installer.mjs',
  }, null, 2) + '\n', 'utf8')

  // staging 完整性自检
  const stagedExe = path.join(STAGING_DIR, EXE_NAME)
  const stagedResources = path.join(STAGING_DIR, 'resources')
  if (!existsSync(stagedExe)) die(`staging 缺少 ${EXE_NAME}`)
  if (!existsSync(stagedResources)) die('staging 缺少 resources 目录')
  if (!existsSync(path.join(STAGING_DIR, 'Install.ps1')) || !existsSync(path.join(STAGING_DIR, 'Uninstall.ps1'))) {
    die('staging 缺少安装/卸载脚本')
  }
  // v2.2 M5：安装包必须内含 Node runtime（resources/native/node/node.exe），不依赖 PATH node。
  const stagedNode = path.join(stagedResources, 'native', 'node', 'node.exe')
  const stagedSidecar = path.join(stagedResources, 'native', 'plugin-host-node.cjs')
  if (!existsSync(stagedNode) || !existsSync(stagedSidecar)) {
    die(
      `M5 安装包缺少 resources/native 资源（node=${existsSync(stagedNode)}，sidecar=${existsSync(stagedSidecar)}）` +
        `；请用新版 build-exe.mjs 构建便携版（${APP_DIR}）。`,
    )
  }

  // 3) 7z 压缩（-mx=5，保持相对路径）
  const archive = path.join(INSTALLER_DIR, 'app.7z')
  rmSync(archive, { force: true })
  log('正在压缩 app.7z（-mx=5，约 1–2 分钟）…')
  const compress = spawnSync(SEVEN_ZIP, ['a', '-mx=5', '-y', archive, '.\\*'], { cwd: STAGING_DIR, stdio: 'inherit' })
  if (compress.status !== 0 || !existsSync(archive)) die(`7z 压缩失败（退出码 ${compress.status}）`)

  // 4) 拼接 SFX：7z.sfx + app.7z + installer-config.txt
  const setupName = `${APP_NAME}-Setup-${version}.exe`
  const setupPath = path.join(INSTALLER_DIR, setupName)
  const sfx = readFileSync(sfxPath)
  const payload = readFileSync(archive)
  const config = readFileSync(path.join(INSTALLER_DIR, 'installer-config.txt'))
  writeFileSync(setupPath, Buffer.concat([sfx, payload, config]))

  // 5) 产物校验（PE 头 + 大小）
  const bytes = readFileSync(setupPath).subarray(0, 2)
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) die('Setup.exe 头不是 PE（MZ），打包可能失败')
  const setupSize = statSync(setupPath).size
  if (setupSize < 5 * 1024 * 1024) die(`Setup.exe 过小（${setupSize} 字节），疑似不完整`)

  const summary = {
    ok: true,
    version,
    appDir: APP_DIR,
    setupPath,
    setupSize,
    setupSizeMB: Number((setupSize / 1024 / 1024).toFixed(2)),
    archive,
    archiveSizeMB: Number((statSync(archive).size / 1024 / 1024).toFixed(2)),
    staging: STAGING_DIR,
    sevenZip: { exe: SEVEN_ZIP, sfx: sfxPath },
    nativeNode: existsSync(stagedNode),
  }
  log(`SETUP_OK ${JSON.stringify(summary)}`)
  console.log(`\n✅ 安装包已生成：${setupPath}（${summary.setupSizeMB} MB，版本 ${version}）`)

  if (!KEEP_STAGING) rmSync(STAGING_DIR, { recursive: true, force: true })
  process.exit(0)
}

/** 复制便携版 app 内容到 staging（不包含 app 目录本身）。 */
function stageAppFiles() {
  for (const entry of readdirSync(APP_DIR, { withFileTypes: true })) {
    const src = path.join(APP_DIR, entry.name)
    const dest = path.join(STAGING_DIR, entry.name)
    cpSync(src, dest, { recursive: true, dereference: true })
  }
}

try {
  main()
} catch (error) {
  die(`未捕获错误：${String(error?.stack ?? error)}`)
}
