/**
 * R7b：本地更新检查（无网络请求）。
 *
 * - manifest：data/update-manifest.json 或 env AIMS_UPDATE_MANIFEST；
 *   {stable:{latestVersion,buildDate,notes,url}, beta:{...}}；
 * - 语义版本比较（x.y.z；预发布同 core 时按字符串比较）；
 * - 返回 status:'update-available' | 'up-to-date' | 'no-source'。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveBuildInfo } from './app-info.js'

export const UPDATE_MANIFEST_FILE_NAME = 'update-manifest.json'
export const UPDATE_CHANNELS = Object.freeze(['stable', 'beta'])

/** manifest 路径：env 优先，其次 dataDir/update-manifest.json。 */
export function updateManifestPath(dataDir) {
  const fromEnv = typeof process.env.AIMS_UPDATE_MANIFEST === 'string' ? process.env.AIMS_UPDATE_MANIFEST.trim() : ''
  if (fromEnv !== '') return path.resolve(fromEnv)
  return path.join(String(dataDir ?? ''), UPDATE_MANIFEST_FILE_NAME)
}

/** 解析版本字符串为 {core:[n,n,n], prerelease:string|null}；非法返回 null。 */
export function parseVersion(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim().replace(/^v/i, '')
  if (text === '') return null
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null }
}

/**
 * 语义版本比较：a>b → 1，a<b → -1，相等 → 0；非法版本抛中文错误。
 * 预发布：x.y.z 正式版 > x.y.z-alpha；同 core 的预发布按字符串比较。
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null) throw new Error(`非法版本号：${String(a)}（需要 x.y.z）`)
  if (right === null) throw new Error(`非法版本号：${String(b)}（需要 x.y.z）`)
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1
  }
  const leftPre = left.prerelease
  const rightPre = right.prerelease
  if (leftPre === null && rightPre === null) return 0
  if (leftPre === null) return 1
  if (rightPre === null) return -1
  if (leftPre === rightPre) return 0
  return leftPre > rightPre ? 1 : -1
}

/**
 * 读取本地 manifest；文件不存在返回 null（no-source）；损坏/结构错误抛中文错误。
 * @param {string} dataDir
 */
export async function loadUpdateManifest(dataDir) {
  const file = updateManifestPath(dataDir)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`读取更新清单失败：${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`更新清单不是合法 JSON（${file}）：${error?.message ?? error}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`更新清单结构错误（${file}）：需要 {stable:{...},beta:{...}}`)
  }
  for (const [channel, entry] of Object.entries(parsed)) {
    if (!UPDATE_CHANNELS.includes(channel)) continue
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`更新清单 channel=${channel} 结构错误：需要 {latestVersion,buildDate,notes,url}`)
    }
    if (typeof entry.latestVersion !== 'string' || parseVersion(entry.latestVersion) === null) {
      throw new Error(`更新清单 channel=${channel} 的 latestVersion 非法：${String(entry.latestVersion)}`)
    }
  }
  return parsed
}

/**
 * 检查更新（本地 manifest；无网络）。
 * @param {{dataDir?:string, channel?:string, currentVersion?:string, currentCommit?:string}} [options]
 */
export async function checkForUpdate(options = {}) {
  const dataDir = String(options.dataDir ?? '')
  const build = resolveBuildInfo({ fallbackVersion: options.currentVersion })
  const channel = UPDATE_CHANNELS.includes(options.channel) ? options.channel : 'stable'
  const currentVersion = typeof options.currentVersion === 'string' && options.currentVersion.trim() !== '' ? options.currentVersion.trim() : build.version
  const currentCommit = typeof options.currentCommit === 'string' && options.currentCommit.trim() !== '' ? options.currentCommit.trim() : build.commit
  const checkedAt = new Date().toISOString()
  const current = { version: currentVersion, commit: currentCommit, channel }
  const manifest = await loadUpdateManifest(dataDir)
  if (manifest === null) return { status: 'no-source', current, checkedAt }
  const entry = manifest[channel]
  if (entry === null || typeof entry !== 'object' || typeof entry.latestVersion !== 'string') {
    return { status: 'no-source', current, checkedAt }
  }
  const comparison = compareVersions(entry.latestVersion, currentVersion)
  if (comparison <= 0) return { status: 'up-to-date', current, checkedAt }
  return {
    status: 'update-available',
    current,
    available: {
      version: entry.latestVersion,
      buildDate: typeof entry.buildDate === 'string' ? entry.buildDate : null,
      notes: typeof entry.notes === 'string' ? entry.notes : '',
      url: typeof entry.url === 'string' ? entry.url : '',
    },
    ...(typeof entry.notes === 'string' && entry.notes !== '' ? { notes: entry.notes } : {}),
    ...(typeof entry.url === 'string' && entry.url !== '' ? { url: entry.url } : {}),
    checkedAt,
  }
}
