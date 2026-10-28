/**
 * AI 音乐工作室 — 「AI 正在控制哪个窗口/工程」的运行时信息。
 *
 * 用于 `studio_app_info` 工具与 `GET /studio/api/catalog`：
 * 明确告诉 AI/用户当前连接的窗口地址、数据目录、工程、可用采样音色列表，
 * 避免出现「工具写进了看不见的后台数据」这种疑虑。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DRUM_KITS, FX_TYPES, SYNTH_INSTRUMENTS, SYNTH_PRESETS } from '../shared/catalog.js'

/** 从 dataDir 的 app-endpoint.json 读取窗口运行信息（窗口没起时返回 null）。 */
/** R7a：构建信息兜底（未打包/开发环境）。 */
export const BUILD_INFO_FALLBACK = Object.freeze({
  version: '1.0.0',
  commit: 'unknown',
  date: null,
  channel: 'dev',
  electron: null,
})

const APP_INFO_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 候选 build-info.json 路径（env → 打包 resources → app.asar/仓库根 → cwd）。 */
export function buildInfoCandidatePaths() {
  const candidates = []
  if (typeof process.env.AIMS_BUILD_INFO === 'string' && process.env.AIMS_BUILD_INFO.trim() !== '') {
    candidates.push(path.resolve(process.env.AIMS_BUILD_INFO.trim()))
  }
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(path.join(process.resourcesPath, 'build-info.json'))
  }
  // src/host/app-info.js → 上两级即仓库根 / app.asar 根 / resources 根
  candidates.push(path.resolve(APP_INFO_DIR, '..', '..', 'build-info.json'))
  candidates.push(path.resolve(APP_INFO_DIR, '..', 'build-info.json'))
  candidates.push(path.resolve(process.cwd(), 'build-info.json'))
  candidates.push(path.resolve(process.cwd(), 'desktop', 'build-info.json'))
  return [...new Set(candidates)]
}

function normalizeBuildInfo(raw, fallbackVersion) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const read = (key, altKey) => {
    const value = data[key] ?? (altKey ? data[altKey] : undefined)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }
  const version = read('version') ?? fallbackVersion ?? BUILD_INFO_FALLBACK.version
  const commit = read('gitCommit', 'commit') ?? BUILD_INFO_FALLBACK.commit
  const date = read('buildDate', 'date') ?? (typeof data.buildDate === 'number' ? new Date(data.buildDate).toISOString() : BUILD_INFO_FALLBACK.date)
  const channel = read('channel') ?? BUILD_INFO_FALLBACK.channel
  const electron = read('electronVersion', 'electron') ?? (process.versions?.electron ? String(process.versions.electron) : BUILD_INFO_FALLBACK.electron)
  return {
    version,
    commit,
    date,
    channel,
    electron,
    ...(typeof data.gitDirty === 'boolean' ? { dirty: data.gitDirty } : {}),
  }
}

/**
 * R7a：读取/解析 build-info.json（打包资源优先；缺失或损坏回退 dev 值）。
 * @param {{fallbackVersion?:string}} [options]
 */
export function resolveBuildInfo(options = {}) {
  // candidates 仅供测试隔离（默认按 env/打包资源/仓库根顺序探测）。
  const candidates = Array.isArray(options.candidates) ? options.candidates : buildInfoCandidatePaths()
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return normalizeBuildInfo(parsed, options.fallbackVersion)
      }
    } catch {
      // 文件不存在/损坏 → 尝试下一个候选
    }
  }
  return normalizeBuildInfo(null, options.fallbackVersion)
}

export function readEndpointInfo(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') return null
  try {
    const raw = readFileSync(path.join(dataDir, 'app-endpoint.json'), 'utf8')
    const info = JSON.parse(raw)
    if (!info || typeof info !== 'object') return null
    return info
  } catch {
    return null
  }
}

/**
 * 构建应用信息（工具/HTTP 共用）。
 * @param {object} state createState() 返回值
 * @returns {object}
 */
export function buildAppInfo(state, options = {}) {
  const dataDir = String(state?.dataDir ?? '')
  const endpoint = readEndpointInfo(dataDir)
  const project = state?.project ?? null
  const mode = process.versions?.electron ? 'desktop-exe' : endpoint?.mode ?? 'window-browser'
  const build = options.buildInfo ?? resolveBuildInfo({ fallbackVersion: String(endpoint?.version ?? '1.0.0') })
  return {
    ok: true,
    tool: 'studio_app_info',
    version: build.version,
    build,
    app: {
      mode,
      version: build.version || String(endpoint?.version ?? '1.0.0'),
      url: endpoint?.url ? String(endpoint.url).replace(/\/+$/, '') : null,
      dataDir,
      pid: endpoint?.pid ?? process.pid,
      startedAt: endpoint?.startedAt ?? null,
    },
    project: project
      ? {
          title: project.title ?? null,
          revision: Number(project.revision) || 0,
          tracks: Array.isArray(project.tracks) ? project.tracks.length : 0,
          patterns: Array.isArray(project.patterns) ? project.patterns.length : 0,
        }
      : null,
    counts: {
      instruments: SYNTH_PRESETS.length,
      drumKits: DRUM_KITS.length,
      effects: FX_TYPES.length,
    },
    instruments: SYNTH_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      category: preset.category,
      program: preset.soundfont?.program ?? null,
    })),
    drumKits: DRUM_KITS.map((kit) => ({ id: kit.id, label: kit.label })),
    // R5d：内置 subtractive 合成器 8 个（counts.instruments 仍是 32 个采样乐器）。
    synthInstruments: SYNTH_INSTRUMENTS.map((instrument) => ({
      id: instrument.id,
      label: instrument.label,
      category: instrument.category,
      wave: instrument.synthPreset.wave,
    })),
    effects: FX_TYPES.map((fx) => ({ id: fx.id, label: fx.label })),
    note:
      '所有 studio_* 工具调用都会写入上面 app.dataDir 指向的当前工程，并显示在 app.url 对应的窗口里。' +
      '如果窗口没有运行，工具会直接报错，不会写入任何后台数据。',
  }
}
