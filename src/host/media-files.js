/**
 * R2a 修复：媒体文件全局唯一命名（跨工程不覆盖）。
 *
 * 背景：旧实现用 `<mediaId>.<ext>`（med_1.wav）命名；media id 每个工程从 med_1 重排，
 * 新建工程导入会覆盖旧工程同名媒体文件，造成数据损坏（旧工程再打开播放错误音频）。
 *
 * 约定：`<mediaId>-<Date.now().toString(36)>-<random4>.<ext>`；media.id 仍为 med_N，
 * project.media[].file 存该唯一文件名；写文件用 `wx` 排他，冲突时换随机/序号重试，绝不覆盖。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 允许的扩展名（音频导入已在外层校验，这里再防御一次）。 */
const SAFE_EXT_RE = /^[a-z0-9]{1,8}$/

/** 文件名中允许的安全字符（media id / 扩展名）。 */
function safePart(value, fallback) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
  return text === '' ? fallback : text
}

/** 4 位十六进制随机串。 */
export function randomMediaSuffix(bytes = randomBytes(2)) {
  return Buffer.from(bytes).toString('hex').slice(0, 4).padEnd(4, '0')
}

/**
 * 生成媒体文件名（不含存在性检查）：`<mediaId>-<base36 时间戳>-<random4>.<ext>`。
 * @param {string} mediaId 例如 med_1
 * @param {string} ext 扩展名（wav/mp3/flac/ogg）
 * @param {{now?:number, suffix?:string}} [options]
 */
export function makeMediaFileName(mediaId, ext, options = {}) {
  const id = safePart(mediaId, 'media')
  const normalizedExt = String(ext ?? '').toLowerCase().replace(/^\./, '')
  const safeExt = SAFE_EXT_RE.test(normalizedExt) ? normalizedExt : 'wav'
  const stamp = (Number.isFinite(Number(options.now)) ? Math.trunc(Number(options.now)) : Date.now()).toString(36)
  const suffix = typeof options.suffix === 'string' && options.suffix !== ''
    ? safePart(options.suffix, randomMediaSuffix())
    : randomMediaSuffix()
  return `${id}-${stamp}-${suffix}.${safeExt}`
}

/**
 * 把音频字节写入 mediaDir 下全局唯一的文件，返回 {fileName,filePath}。
 * 若目标名已存在（极小概率随机碰撞/并发），换随机后缀重试；始终不覆盖已有文件。
 * @param {string} mediaDir
 * @param {Buffer|Uint8Array} buffer
 * @param {{mediaId?:string, ext?:string, maxAttempts?:number}} [options]
 * @returns {Promise<{fileName:string,filePath:string}>}
 */
export async function writeUniqueMediaFile(mediaDir, buffer, options = {}) {
  await mkdir(mediaDir, { recursive: true })
  const mediaId = options.mediaId ?? 'media'
  const ext = options.ext ?? 'wav'
  const maxAttempts = Math.max(1, Math.min(50, Number(options.maxAttempts) || 20))
  let lastError = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // 第 1 次用随机后缀；冲突后换随机 + 序号（两者都不同，避免同毫秒碰撞）。
    const fileName = makeMediaFileName(mediaId, ext, attempt === 0 ? {} : { suffix: `${randomMediaSuffix()}-${attempt}` })
    const filePath = path.join(mediaDir, fileName)
    try {
      // wx：目标已存在时 EEXIST，绝不覆盖（跨工程/并发导入安全）。
      await writeFile(filePath, buffer, { flag: 'wx' })
      return { fileName, filePath }
    } catch (error) {
      if (error?.code === 'EEXIST') {
        lastError = error
        continue
      }
      throw error
    }
  }
  throw new Error(`媒体文件重名次数过多（${maxAttempts} 次），请稍后重试：${lastError?.message ?? ''}`)
}
