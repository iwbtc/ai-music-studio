#!/usr/bin/env node
/**
 * AI 音乐工作室 — 构建脚本（双产物）
 *
 * 1) lib/client.js        DSH 插件 client 半区：window.__ModuleLoader__.load({id, factory})，
 *                         react 等宿主模块保持 external（由 DSH 模块表提供）。
 * 2) standalone/assets/app.js  独立窗口版前端：IIFE，React 等全部打包进 bundle。
 *
 * 同一份 src/client/panel.jsx / App.jsx / audio/* 被两个入口共用。
 */
import { build } from 'esbuild'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const libDir = join(root, 'lib')
const standaloneAssetsDir = join(root, 'standalone', 'assets')
mkdirSync(libDir, { recursive: true })
mkdirSync(standaloneAssetsDir, { recursive: true })

if (!existsSync(join(root, 'node_modules', 'esbuild'))) {
  console.error('[build] 找不到 esbuild，请先在项目目录运行: cmd /c npm install')
  process.exit(1)
}
if (!existsSync(join(root, 'node_modules', 'react'))) {
  console.error('[build] 找不到 react，独立窗口版需要打包 React：cmd /c npm install')
  process.exit(1)
}

const PLUGIN_ID = 'dsh-ai-music-studio'

/** DSH 宿主模块表（PLATFORM_MODULES）里的共享模块，必须 external。 */
const HOST_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  sourcemap: false,
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
}

/** 1) DSH 插件 bundle（空注册；DSH 侧只保留 AI 工具桥，不再有 DAW 面板）。 */
const dshResult = await build({
  ...common,
  entryPoints: [join(root, 'src/client/noop.jsx')],
  outfile: join(libDir, 'client.js'),
  format: 'cjs',
  external: HOST_EXTERNALS,
  banner: {
    js: `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(PLUGIN_ID)},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;`,
  },
  footer: {
    js: `\n    return module.exports;\n  },\n});`,
  },
})
if (dshResult.errors.length > 0) {
  console.error('[build] DSH bridge bundle 构建失败')
  process.exit(1)
}
console.log('[build] lib/client.js 已生成（DSH 空界面桥）')

/** 2) 独立窗口版 bundle（React 打包进 IIFE）。 */
const standaloneResult = await build({
  ...common,
  entryPoints: [join(root, 'src/standalone/main.jsx')],
  outfile: join(standaloneAssetsDir, 'app.js'),
  format: 'iife',
  minify: true,
  // libflacjs（FLAC 导出）的 asm.js 构建内含 Node 环境分支的 require('fs'/'path'/'crypto')；
  // 浏览器运行时不会进入这些分支（ENVIRONMENT_IS_NODE=false），这里把它们标记为 external，
  // 避免 esbuild 在 browser 平台下解析 Node 内建模块失败。
  external: ['fs', 'path', 'crypto'],
})
if (standaloneResult.errors.length > 0) {
  console.error('[build] 独立窗口版 bundle 构建失败')
  process.exit(1)
}
console.log('[build] standalone/assets/app.js 已生成')
