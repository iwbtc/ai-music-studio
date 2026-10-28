#!/usr/bin/env node
/**
 * AI 音乐工作室 — 桌面图标生成器（纯 Node，无重型图形依赖）。
 *
 * 输入：src/standalone/favicon.svg（珊瑚色圆角方块 + 4 根白色声波柱）
 * 输出：
 *   desktop/icon.ico  多尺寸 ICO（256/128/64/48/32/16，PNG 帧封装）
 *   desktop/icon.png  256×256 PNG（备用/预览）
 *
 * 实现：读取 SVG 里的 <rect> 定义 → 4×（小尺寸 8×）超采样绘制到 RGBA 缓冲 →
 * 盒式下采样 → 内置 PNG 编码（zlib + CRC32）→ ICO 目录封装。
 * 不依赖 canvas / sharp / 系统图形库，可在纯 Node 环境重复执行。
 *
 * 用法：node scripts/make-icon.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const HERE = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const SVG_FILE = path.join(ROOT, 'src', 'standalone', 'favicon.svg')
const OUT_DIR = path.join(ROOT, 'desktop')
const ICO_FILE = path.join(OUT_DIR, 'icon.ico')
const PNG_FILE = path.join(OUT_DIR, 'icon.png')

/** SVG viewBox 边长（favicon.svg 为 0 0 64 64）。 */
const VIEWBOX = 64
const SIZES = [256, 128, 64, 48, 32, 16]

/* ────────────────────────────── SVG 解析 ────────────────────────────── */

const num = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 从 SVG 提取 <rect> 列表（按绘制顺序）。 */
function parseRects(svg) {
  const rects = []
  const rectRe = /<rect\b([^>]*?)\/?>/g
  let match
  while ((match = rectRe.exec(svg)) !== null) {
    const attrs = {}
    for (const a of match[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2]
    rects.push({
      x: num(attrs.x, 0),
      y: num(attrs.y, 0),
      w: num(attrs.width, 0),
      h: num(attrs.height, 0),
      rx: num(attrs.rx, 0),
      fill: attrs.fill || '#000000',
      opacity: Math.max(0, Math.min(1, num(attrs.opacity, 1))),
    })
  }
  return rects
}

/** 内置兜底图形（与 src/standalone/favicon.svg 一致）。 */
const FALLBACK_RECTS = [
  { x: 0, y: 0, w: 64, h: 64, rx: 14, fill: '#F26B3A', opacity: 1 },
  { x: 12, y: 30, w: 8, h: 22, rx: 3, fill: '#FFFFFF', opacity: 0.92 },
  { x: 24, y: 14, w: 8, h: 38, rx: 3, fill: '#FFFFFF', opacity: 1 },
  { x: 36, y: 22, w: 8, h: 30, rx: 3, fill: '#FFFFFF', opacity: 0.92 },
  { x: 48, y: 34, w: 6, h: 18, rx: 3, fill: '#FFE3D6', opacity: 1 },
]

function parseColor(value) {
  const hex = String(value || '').trim().replace(/^#/, '')
  if (hex.length === 3) {
    return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)]
  }
  if (hex.length === 6) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
  }
  return [0, 0, 0]
}

/* ────────────────────────────── 位图绘制 ────────────────────────────── */

/** 点是否落在圆角矩形内。 */
function insideRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false
  if (r <= 0) return true
  const cx = Math.min(Math.max(px, x + r), x + w - r)
  const cy = Math.min(Math.max(py, y + r), y + h - r)
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

/** 以 source-over 方式把颜色叠加到直通 RGBA 缓冲。 */
function fillRoundedRect(buf, width, rect, scale, color) {
  const x = rect.x * scale
  const y = rect.y * scale
  const w = rect.w * scale
  const h = rect.h * scale
  const r = Math.min(rect.rx * scale, w / 2, h / 2)
  const alpha = rect.opacity
  if (alpha <= 0 || w <= 0 || h <= 0) return
  const x0 = Math.max(0, Math.floor(x))
  const y0 = Math.max(0, Math.floor(y))
  const x1 = Math.min(width, Math.ceil(x + w))
  const y1 = Math.min(width, Math.ceil(y + h))
  const [cr, cg, cb] = color
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      if (!insideRoundedRect(px + 0.5, py + 0.5, x, y, w, h, r)) continue
      const i = (py * width + px) * 4
      const sa = alpha
      const da = buf[i + 3] / 255
      const outA = sa + da * (1 - sa)
      if (outA <= 0) continue
      buf[i] = Math.round((cr * sa + buf[i] * da * (1 - sa)) / outA)
      buf[i + 1] = Math.round((cg * sa + buf[i + 1] * da * (1 - sa)) / outA)
      buf[i + 2] = Math.round((cb * sa + buf[i + 2] * da * (1 - sa)) / outA)
      buf[i + 3] = Math.round(outA * 255)
    }
  }
}

/** 渲染一个尺寸的 RGBA 位图（超采样后盒式下采样，预乘 alpha 平均避免暗边）。 */
function renderIcon(rects, size) {
  const SS = size <= 32 ? 8 : 4 // 超采样倍率
  const big = size * SS
  const buf = new Uint8ClampedArray(big * big * 4)
  const scale = big / VIEWBOX
  for (const rect of rects) fillRoundedRect(buf, big, rect, scale, parseColor(rect.fill))

  const out = Buffer.alloc(size * size * 4)
  const samples = SS * SS
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sr = 0
      let sg = 0
      let sb = 0
      let sa = 0
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const i = ((y * SS + dy) * big + (x * SS + dx)) * 4
          const a = buf[i + 3] / 255
          sr += buf[i] * a
          sg += buf[i + 1] * a
          sb += buf[i + 2] * a
          sa += a
        }
      }
      const a = sa / samples
      const o = (y * size + x) * 4
      out[o] = sa > 0 ? Math.round(sr / sa) : 0
      out[o + 1] = sa > 0 ? Math.round(sg / sa) : 0
      out[o + 2] = sa > 0 ? Math.round(sb / sa) : 0
      out[o + 3] = Math.round(a * 255)
    }
  }
  return out
}

/* ────────────────────────────── PNG 编码 ────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 编码 8bit RGBA PNG。 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(6, 9) // color type: RGBA
  ihdr.writeUInt8(0, 10) // compression
  ihdr.writeUInt8(0, 11) // filter
  ihdr.writeUInt8(0, 12) // interlace
  const stride = 1 + width * 4
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0 // filter type: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

/* ────────────────────────────── ICO 封装 ────────────────────────────── */

/** frames: [{ size, png }] → Windows ICO（PNG 帧，Vista+ 支持，Electron/rcedit 可用）。 */
function encodeIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)

  const entries = Buffer.alloc(16 * frames.length)
  let offset = header.length + entries.length
  frames.forEach((frame, index) => {
    const at = index * 16
    entries.writeUInt8(frame.size >= 256 ? 0 : frame.size, at) // width（0 表示 256）
    entries.writeUInt8(frame.size >= 256 ? 0 : frame.size, at + 1) // height
    entries.writeUInt8(0, at + 2) // 调色板数
    entries.writeUInt8(0, at + 3) // reserved
    entries.writeUInt16LE(1, at + 4) // planes
    entries.writeUInt16LE(32, at + 6) // bpp
    entries.writeUInt32LE(frame.png.length, at + 8)
    entries.writeUInt32LE(offset, at + 12)
    offset += frame.png.length
  })

  return Buffer.concat([header, entries, ...frames.map((frame) => frame.png)])
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

function loadRects() {
  try {
    const svg = readFileSync(SVG_FILE, 'utf8')
    const rects = parseRects(svg)
    if (rects.length >= 2) {
      console.log(`[icon] 读取 ${path.relative(ROOT, SVG_FILE)}：${rects.length} 个 rect`)
      return rects
    }
    console.warn(`[icon] ${SVG_FILE} 中 rect 不足，使用内置图形`)
  } catch (error) {
    console.warn(`[icon] 无法读取 ${SVG_FILE}（${error?.message ?? error}），使用内置图形`)
  }
  return FALLBACK_RECTS
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const rects = loadRects()
  const frames = SIZES.map((size) => {
    const png = encodePng(size, size, renderIcon(rects, size))
    return { size, png }
  })
  const ico = encodeIco(frames)
  writeFileSync(ICO_FILE, ico)
  writeFileSync(PNG_FILE, frames[0].png)

  // 回读校验 ICO 头与目录
  const header = readFileSync(ICO_FILE)
  const count = header.readUInt16LE(4)
  const listed = []
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16
    const w = header.readUInt8(at) || 256
    listed.push(`${w}x${w}(${header.readUInt32LE(at + 8)}B)`)
  }
  console.log(`[icon] sizes: ${listed.join(' ')}`)
  console.log(`[icon] wrote ${path.relative(ROOT, ICO_FILE)} (${ico.length} bytes)`)
  console.log(`[icon] wrote ${path.relative(ROOT, PNG_FILE)} (${frames[0].png.length} bytes)`)
  if (count !== SIZES.length) {
    console.error(`[icon] ICO 目录条目数异常：${count} != ${SIZES.length}`)
    process.exit(1)
  }
}

main()
