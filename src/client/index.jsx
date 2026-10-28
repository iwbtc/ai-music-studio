/**
 * AI 音乐工作室 — DSH 浏览器插件入口（client 半区）。
 *
 * 职责仅剩「接入 DSH」：注册 locale、注入样式、注册侧栏图标入口 + main 全屏面板。
 * 面板主体（轮询/引擎/导出/UI）在 ./panel.jsx，独立窗口版复用同一份代码。
 */
import React from 'react'
import { StudioPanel, injectPanelStyles } from './panel.jsx'

export const NS = 'aiMusicStudio'
export const PANEL_ID = 'ai-music-studio'

export const inject = ['slots', 'locale', 'layout']

const zh = {
  panel: '音乐工作室',
}

const en = {
  panel: 'Music Studio',
}

/** 侧栏图标：三条高低不一的音柱（珊瑚橙 + 薄荷绿）。 */
function StudioIcon({ size = 20, active = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="10" width="3.4" height="10" rx="1.4" fill={active ? '#F26B3A' : '#C9C2B4'} />
      <rect x="9" y="4" width="3.4" height="16" rx="1.4" fill={active ? '#F26B3A' : '#A9A294'} />
      <rect x="15" y="7.5" width="3.4" height="12.5" rx="1.4" fill={active ? '#2FB58C' : '#C9C2B4'} />
    </svg>
  )
}

/**
 * 客户端插件 apply：注册 locale、样式、侧栏入口与主面板。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ai-music-studio: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(() => injectPanelStyles(), 'ai-music-studio: styles')

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 12,
    label: () => t('panel'),
    locale: NS,
  }, StudioIcon))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, StudioPanel))
}
