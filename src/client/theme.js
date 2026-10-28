/**
 * AI 音乐工作室 — 浅色主题 token（daw-ui 唯一颜色来源）。
 *
 * 设计基调：「温暖纸感工作室」。暖白纸面 + 白卡片 + 1px 细线 + 微弱阴影 + 珊瑚橙强调。
 * 硬性约束：禁止深蓝 / 深紫 / 深色背景（见 CONTRACT.md 第 7 节）。
 *
 * 用法：App 把 palette / font / shadow 写进 `.aims-root` 的 CSS 自定义属性，
 * styles.css 只消费 var(--aims-*)，不在 CSS 里写死颜色。
 */

/** 基础色板（与 CONTRACT.md 第 7 节一致）。 */
export const palette = {
  // 底色 / 面板
  bg: '#F6F4EF', // 应用底色（暖白纸）
  panel: '#FFFFFF', // 卡片 / 面板
  panelSoft: '#FBFAF6', // 次级面板（表头、输入框底）
  panelSunk: '#F2EFE7', // 凹陷区域（机架槽、表头）
  panelWarm: '#FAF6EE', // 高亮选中底
  // 线条
  line: '#E9E4DA',
  lineStrong: '#DCD5C6',
  // 文字
  ink: '#26241F',
  inkSoft: '#4B463C',
  muted: '#8B8578',
  faint: '#B7B0A1',
  // 强调色
  coral: '#F26B3A',
  coralSoft: '#FDEBE3',
  mint: '#2FB58C',
  mintSoft: '#E5F5EF',
  amber: '#EFAE3C',
  amberSoft: '#FCF1DA',
  rose: '#E85D84',
  roseSoft: '#FBE9EE',
  teal: '#4FA3A5',
  olive: '#8E9B5A',
  caramel: '#B08968',
  // 中性
  white: '#FFFFFF',
  black: '#1B1915',
  overlay: 'rgba(38, 36, 31, 0.28)',
}

/** 字体：正文系统字体，数字/小节号/参数用等宽。 */
export const font = {
  ui: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Microsoft YaHei", monospace',
}

/** 圆角（10–14px 为主，符合契约）。 */
export const radius = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
  pill: 999,
}

/** 阴影：非常克制，只做「纸片抬起一毫米」。 */
export const shadow = {
  xs: '0 1px 2px rgba(38, 36, 31, 0.05)',
  sm: '0 1px 2px rgba(38, 36, 31, 0.04), 0 6px 16px -10px rgba(38, 36, 31, 0.14)',
  md: '0 2px 6px rgba(38, 36, 31, 0.05), 0 18px 36px -20px rgba(38, 36, 31, 0.22)',
  pop: '0 14px 34px -14px rgba(38, 36, 31, 0.26)',
  inset: 'inset 0 1px 0 rgba(255, 255, 255, 0.7)',
}

/** 动效。 */
export const motion = {
  fast: '120ms cubic-bezier(0.2, 0.7, 0.3, 1)',
  base: '180ms cubic-bezier(0.2, 0.7, 0.3, 1)',
  slow: '320ms cubic-bezier(0.2, 0.7, 0.3, 1)',
}

/** 布局尺寸（供 JS 计算用，CSS 里镜像为变量）。 */
export const metrics = {
  transportHeight: 64,
  tabsHeight: 44,
  statusHeight: 30,
  leftWidth: 272,
  leftWidthNarrow: 240,
  rightWidth: 304,
  rightWidthNarrow: 264,
  gap: 12,
  pad: 14,
  playlistHeaderWidth: 158,
  playlistBarWidth: 46,
  playlistRowHeight: 52,
  rackRowHeight: 56,
}

/** #RRGGBB → rgba() 字符串；非法输入回退为中性色。 */
export function alpha(hex, a = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return `rgba(139, 133, 120, ${clamp(a, 0, 1)})`
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${round(clamp(a, 0, 1), 3)})`
}

/** 线性混合两个十六进制颜色。 */
export function mix(hexA, hexB, t = 0.5) {
  const a = parseHex(hexA)
  const b = parseHex(hexB)
  const k = clamp(Number(t) || 0, 0, 1)
  const ch = (i) => Math.round(a[i] + (b[i] - a[i]) * k)
  return toHex(ch(0), ch(1), ch(2))
}

/** 与白色混合 → 更浅（用于 clip 底色、行高亮）。 */
export const tint = (hex, t = 0.85) => mix(hex, '#FFFFFF', t)

/** 与深色墨混合 → 更深（用于 hover、文字）。 */
export const shade = (hex, t = 0.2) => mix(hex, '#26241F', t)

/** 将未知颜色兜底到主题珊瑚色。 */
export const safeColor = (hex, fallback = palette.coral) =>
  /^#[0-9a-f]{6}$/i.test(String(hex ?? '').trim()) ? String(hex).trim() : fallback

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  const n = m ? parseInt(m[1], 16) : 0xf26b3a
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(r, g, b) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase()
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

function round(v, digits) {
  const p = 10 ** digits
  return Math.round(v * p) / p
}

/** 聚合导出：组件里也可以 `import { theme } from '../theme.js'`。 */
export const theme = { palette, font, radius, shadow, motion, metrics, alpha, tint, shade, mix, safeColor }

export default theme
