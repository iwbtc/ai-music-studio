/**
 * AI 音乐工作室 — 独立窗口前端入口（IIFE bundle，React 打包进 bundle）。
 * 与 DSH 插件共用同一个 StudioPanel / StudioApp / 音频引擎。
 *
 * 显示比例：Windows 150% 缩放下 1.15 倍界面更舒服。
 * Ctrl + / Ctrl - / Ctrl 0 调整并记住（localStorage），窗口默认最大化。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { StudioPanel, injectPanelStyles } from '../client/panel.jsx'

injectPanelStyles()

// 窗口存活心跳：启动器据此判断「窗口是否还开着」；页面关闭后自动停止。
setInterval(() => {
  fetch('/studio/api/ui-heartbeat', { method: 'POST', cache: 'no-store' }).catch(() => {})
}, 3000)

/* ── 界面缩放（CSS zoom）────────────────────────────────────────────── */
const ZOOM_KEY = 'aims.uiZoom'
const DEFAULT_ZOOM = 1.15
const MIN_ZOOM = 0.7
const MAX_ZOOM = 1.8

function readZoom() {
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY))
    if (Number.isFinite(value) && value >= MIN_ZOOM && value <= MAX_ZOOM) return value
  } catch {
    /* localStorage 不可用 */
  }
  return DEFAULT_ZOOM
}

let currentZoom = readZoom()

function applyZoom(value, persist = true) {
  currentZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))))
  document.documentElement.style.zoom = String(currentZoom)
  if (persist) {
    try {
      localStorage.setItem(ZOOM_KEY, String(currentZoom))
    } catch {
      /* 忽略 */
    }
  }
}

applyZoom(currentZoom, false)

window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return
  const key = event.key
  if (key === '+' || key === '=') {
    event.preventDefault()
    applyZoom(currentZoom + 0.05)
  } else if (key === '-' || key === '_') {
    event.preventDefault()
    applyZoom(currentZoom - 0.05)
  } else if (key === '0') {
    event.preventDefault()
    applyZoom(DEFAULT_ZOOM)
  }
}, { capture: true })

const container = document.getElementById('root')
if (container) {
  // 独立窗口标记：供 UI 在顶栏显示「独立版」之类的小徽标（可选消费）。
  window.__AIMS_STANDALONE__ = true
  createRoot(container).render(<StudioPanel showHeaderBadge />)
} else {
  document.body.textContent = 'AI 音乐工作室：找不到挂载点 #root'
}
