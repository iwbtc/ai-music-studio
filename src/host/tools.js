/**
 * AI 音乐工作室 — 23 个 `studio_*` Agent 工具定义。
 *
 * 由 index.js 传入真实的 `defineTool`（来自 @deepseek-ai/dsh-tools）并注册到 ctx.tools；
 * 单测可传入 `(options) => options` 的 mock，从而不依赖 DSH 运行时。
 * 本文件不 import 任何 @deepseek-ai 包。
 *
 * 约定：
 * - name 统一 studio_ 前缀；description 用中文、从模型视角写清「何时调用 / 怎么填 / 工作流」。
 * - 每次开始创作前先调用 studio_app_info 确认写入目标与可用采样音色。
 * - parameters 用 DSH 参数 DSL；数组/对象显式写 items / additionalProperties。
 * - output.schema 为开放对象（additionalProperties:true），成功/失败都返回 JSON。
 * - execute 捕获所有异常：成功 `{ok:true, ...}`，失败 `{ok:false, error:'...'}`，绝不裸抛。
 * - 每次成功变更都会 bump revision / 记录 history / 更新 activity / 持久化（由 state.mutate 完成）。
 */
import { existsSync } from 'node:fs'
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DRUM_KITS,
  FX_TYPES,
  LIMITS,
  SCALES,
  SYNTH_INSTRUMENTS,
  SYNTH_PRESETS,
  TRACK_ROLES,
} from '../shared/catalog.js'
import { AUDIO_EXTS, AUTOMATION_PARAMS, MEDIA_MAX_BYTES, SCHEMA_VERSION, makeIdGen, normalizeProject } from '../shared/model.js'
import { buildAppInfo } from './app-info.js'
import { defaultMetrics } from './perf.js'
import { AUTOSAVE_FILE_NAME, RECOVERY_DIR_NAME, SESSION_LOCK_FILE_NAME } from './state.js'
import { MAX_MIDI_BYTES, importMidiIntoState } from './midi-import.js'
import { exportMidiFile } from './midi.js'
import { writeUniqueMediaFile } from './media-files.js'
import * as ops from './ops.js'
import { VERSION_DIR_NAME, listProjectVersions, listProjects, loadProjectFile, projectFileExists, projectVersionsDir, projectsDir, readProjectVersion, sanitizeProjectName, saveProjectFile, writeAutobackup, writeProjectVersion } from './projects.js'
import { requestMeter } from './meter-bridge.js'
import { QUICK_MIX_CACHE_LIMIT, QUICK_MIX_MAX_SPAN, QUICK_MIX_SAMPLE_RATES, getQuickMixCache, quickMixCacheKey, requestPreview, setQuickMixCache } from './preview-bridge.js'
import { parseWavInfo } from './routes.js'
import { evaluateAudioAnalysis } from '../shared/ai-quality.js'
import { analyzeProjectProfile, loadReferenceProfile } from './reference.js'
import { loadSettings, saveSettings } from './settings.js'
import { checkForUpdate, UPDATE_CHANNELS } from './update-check.js'
import { collectDiagnostics, exportDiagnosticsText } from './diagnostics.js'
import { getSharedPluginService } from './plugin-service.js'
import { autoFreezeForExport, freezeTarget, getFreezeStatus, setFreezeOnProject } from './plugin-freeze.js'

/** 所有工具统一的输出声明。 */
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const idList = (items) => items.map((item) => item.id).join(' / ')
const SYNTH_IDS = idList(SYNTH_PRESETS)
const KIT_IDS = idList(DRUM_KITS)
const FX_IDS = FX_TYPES.map((fx) => `${fx.id}(${fx.label})`).join('、')
const ROLE_IDS = idList(TRACK_ROLES)
const SCALE_IDS = idList(SCALES)

/** 音符 item 参数（set_notes 用）。 */
const NOTE_ITEM = {
  type: 'object',
  additionalProperties: true,
  description: '单个音符',
  properties: {
    pitch: { type: 'integer', required: true, description: 'MIDI 音高 0-127；鼓轨用标准鼓件音高（36 底鼓 / 38 军鼓 / 42 闭镲 / 46 开镲 / 39 拍手…）' },
    start: { type: 'number', required: true, description: '起始位置（单位 beat，0 = pattern 开头；1 小节 = 4 beat）' },
    dur: { type: 'number', required: true, description: '时值（单位 beat，必须 > 0）' },
    vel: { type: 'number', description: '力度 0-1，默认 0.8' },
  },
}

/** clip item 参数（set_arrangement 用）。 */
const CLIP_ITEM = {
  type: 'object',
  additionalProperties: true,
  description: '一个片段（track 通道上循环播放的 pattern）',
  properties: {
    trackId: { type: 'string', required: true, description: '轨道 id，如 trk_1' },
    patternId: { type: 'string', description: 'pattern id（pattern 片段；音频片段改用 mediaId）' },
    mediaId: { type: 'string', description: '媒体 id（音频片段；来自 get_project 的 media[].id）' },
    startBar: { type: 'integer', required: true, description: '起始小节（0 基）' },
    lengthBars: { type: 'integer', required: true, description: '片段长度（小节，pattern 会循环平铺）' },
    transpose: { type: 'integer', description: '移调半音数，可负，默认 0（仅 pattern 片段）' },
    offsetSeconds: { type: 'number', description: '音频片段媒体内起点（秒，仅 mediaId 片段）' },
    gainDb: { type: 'number', description: '音频片段增益 dB -24..24（仅 mediaId 片段）' },
    fadeInSeconds: { type: 'number', description: '音频片段淡入秒 0..10（仅 mediaId 片段）' },
    fadeOutSeconds: { type: 'number', description: '音频片段淡出秒 0..10（仅 mediaId 片段）' },
    reverse: { type: 'boolean', description: '音频片段是否反向（仅 mediaId 片段）' },
    stretchRatio: { type: 'number', description: '音频片段时间拉伸 0.25..4（timeline=源×ratio；1=原速省略；仅 mediaId 片段）' },
    semitones: { type: 'number', description: '音频片段变调 -12..+12 半音（1 位小数；0 省略；仅 mediaId 片段）' },
    takeGroup: { type: 'string', description: 'R2c：take 组名（1..64 安全字符；仅 mediaId 片段）' },
    takeIndex: { type: 'integer', description: 'R2c：take 序号 0..99（需 takeGroup）' },
    takeActive: { type: 'boolean', description: 'R2c：false=inactive（省略=true；需 takeGroup）' },
  },
}

/** section item 参数（set_arrangement 用）。 */
const SECTION_ITEM = {
  type: 'object',
  additionalProperties: true,
  description: '一个段落标签（Intro / Build / Drop…）',
  properties: {
    name: { type: 'string', required: true, description: '段落名，如「Drop 高潮」' },
    startBar: { type: 'integer', required: true, description: '起始小节（0 基）' },
    lengthBars: { type: 'integer', required: true, description: '段落长度（小节）' },
    color: { type: 'string', description: '#RRGGBB 颜色（浅色主题友好），省略自动取珊瑚橙' },
  },
}

/** 效果器参数对象（add_effect / update_effect / set_master 共用）。 */
const FX_PARAMS_OBJECT = {
  type: 'object',
  additionalProperties: true,
  description: '覆盖效果器默认参数；键随 type 而定（filter: mode/cutoff/resonance/mix；drive: amount/tone/mix；delay: time/feedback/mix/pingpong；reverb: size/decay/damp/mix；compressor: threshold/ratio/attack/release；eq3: low/mid/high 等）。数值会被钳制到合法范围。',
}

/**
 * 创建全部工具定义。
 * @param {{ defineTool: Function, state: object, onError?: (message: string) => void }} options
 * @returns {object[]} ToolDefinition[]
 */
export function createTools(options = {}) {
  const { defineTool, state, onError } = options
  if (typeof defineTool !== 'function') throw new TypeError('createTools: defineTool 必须是函数')
  /** R1a：性能埋点实例（默认进程级共享；测试可注入独立实例）。 */
  const metrics = options.metrics ?? defaultMetrics
  if (!state || typeof state.mutate !== 'function') throw new TypeError('createTools: state 必须是 createState() 实例')

  /** 未预期异常上报（index.js 会转到 ctx.logger；单测可注入）。 */
  const report = (message) => {
    try {
      onError?.(message)
    } catch {
      /* 忽略日志失败 */
    }
  }

  /** 统一把异常转成结构化失败结果（校验错误直接透出中文 message）。 */
  const toFailure = (error) => {
    if (error?.name === 'OpError' || error instanceof ops.OpError || error?.name === 'ProjectError') {
      return { ok: false, error: error.message }
    }
    report(`studio tool 内部错误：${error?.stack ?? error}`)
    return { ok: false, error: `内部错误：${error?.message ?? String(error)}` }
  }

  /** 成功结果：附上当前 revision，方便模型确认变更已生效。 */
  const ok = (result) => ({ ok: true, ...(result ?? {}), rev: state.revision })

  /** P10：解析期望 revision（未传返回 undefined；非法抛 OpError）。 */
  const readExpectedRevision = (args) => {
    if (args?.expectedRevision === undefined || args?.expectedRevision === null) return undefined
    const numeric = Number(args.expectedRevision)
    if (!Number.isInteger(numeric) || numeric < 0) throw new ops.OpError('expectedRevision 必须是非负整数（get_project 返回的 revision）')
    return numeric
  }

  /** P10：并发冲突检查（返回冲突结果或 null）。 */
  const revisionConflict = (args) => {
    const expectedRevision = readExpectedRevision(args)
    if (expectedRevision === undefined || expectedRevision === state.revision) return null
    return {
      ok: false,
      error: `版本冲突：当前 revision=${state.revision}，你基于 ${expectedRevision}；请重新 get_project 后重试`,
      currentRevision: state.revision,
      expectedRevision,
      retry: true,
    }
  }

  /** 读取类工具。 */
  /** v2.1：导出结果统一的 claim/silent 摘要（UI/多客户端用）。 */
  const claimedFields = (request) => (request && typeof request === 'object'
    ? {
        // 保留 exportRequest 旧字段（tailSeconds/normalize/name/targetLufs/format/fromBar/toBar/outputDir/status），
        // 供 p10/旧断言与 UI 直接使用；再附加 v2.1 claim/silent 字段。
        exportRequest: {
          jobId: request.jobId ?? null,
          seq: request.seq ?? null,
          status: request.status ?? 'pending',
          ...(request.format ? { format: request.format } : {}),
          ...(request.name ? { name: request.name } : {}),
          ...(Number.isFinite(Number(request.tailSeconds)) ? { tailSeconds: Number(request.tailSeconds) } : {}),
          ...(request.normalize !== undefined ? { normalize: request.normalize } : {}),
          ...(Number.isFinite(Number(request.targetLufs)) ? { targetLufs: Number(request.targetLufs) } : {}),
          ...(Number.isFinite(Number(request.fromBar)) ? { fromBar: Number(request.fromBar) } : {}),
          ...(Number.isFinite(Number(request.toBar)) ? { toBar: Number(request.toBar) } : {}),
          ...(request.outputDir ? { outputDir: request.outputDir } : {}),
          claimable: request.claimable === true,
          claimedBy: request.claimedBy ?? null,
          silent: request.silent !== false,
          download: request.download === true,
        },
        claimedBy: request.claimedBy ?? null,
        claimed: Boolean(request.claimedBy),
        claimable: request.claimable === true,
        silent: request.silent !== false,
        download: request.download === true,
      }
    : {})

  /** v2.2：外部插件服务（lazy；dataDir 固定）。 */
  const getPluginService = () => getSharedPluginService(state.dataDir)

  const readTool = (reader) => async (args) => {
    try {
      await state.ensureReady()
      return ok(reader(state.project, args ?? {}))
    } catch (error) {
      return toFailure(error)
    }
  }

  /** 变更类工具：meta 提供 history/activity 文案，mutator 在项目副本上执行。 */
  const writeTool = (metaFactory, mutator) => async (args) => {
    try {
      await state.ensureReady()
      const conflict = revisionConflict(args)
      if (conflict !== null) return conflict
      const meta = typeof metaFactory === 'function' ? metaFactory(args ?? {}) : metaFactory
      const result = state.mutate(meta, (draft) => mutator(draft, args ?? {}))
      return ok(result)
    } catch (error) {
      return toFailure(error)
    }
  }

  /**
   * R0A：破坏性操作前统一快照（命名工程→版本历史；未命名→_autobackup-*；失败只 warning）。
   * @returns {Promise<{backupPath:string|null, backupId?:string, backupKind:string, backupName?:string|null, warning?:string}>}
   */
  const snapshotBeforeDestructive = async () => {
    try {
      if (state.activeName) {
        const version = await writeProjectVersion(state.dataDir, state.activeName, state.project)
        return { backupPath: version.path, backupId: version.id, backupKind: 'version', backupName: version.id }
      }
      const backup = await writeAutobackup(state.dataDir, state.project)
      return { backupPath: backup.path, backupKind: 'autobackup', backupName: backup.name }
    } catch (error) {
      return { backupPath: null, backupKind: 'none', backupName: null, warning: `自动快照失败：${error?.message ?? error}` }
    }
  }

  /** R0A：导出 outputDir 校验（绝对路径、存在、可写、拒绝系统目录/盘符根）。 */
  const resolveOutputDir = async (raw) => {
    const text = String(raw).trim()
    if (text === '') throw new ops.OpError('outputDir 不能为空字符串')
    if (!path.isAbsolute(text)) throw new ops.OpError('outputDir 必须是绝对路径（如 C:\\Users\\me\\Music\\作品）')
    const resolved = path.resolve(text)
    let info = null
    try {
      info = await stat(resolved)
    } catch {
      throw new ops.OpError(`outputDir 不存在：${resolved}（请先创建作品文件夹）`)
    }
    if (!info.isDirectory()) throw new ops.OpError(`outputDir 不是文件夹：${resolved}`)
    const lower = resolved.toLowerCase()
    const forbidden = [
      path.parse(resolved).root.toLowerCase(),
      process.env.WINDIR?.toLowerCase(),
      process.env.ProgramFiles?.toLowerCase(),
      process.env['ProgramFiles(x86)']?.toLowerCase(),
    ].filter(Boolean)
    if (forbidden.some((root) => lower === root || lower.startsWith(root + path.sep))) {
      throw new ops.OpError('outputDir 不允许指向系统目录/盘符根目录，请选择作品文件夹（如 C:\\Users\\你\\Music\\作品）')
    }
    try {
      await access(resolved, 2)
    } catch {
      throw new ops.OpError(`outputDir 不可写：${resolved}`)
    }
    return resolved
  }

  /** 统一概览：lastExport 失效时标记 stale 且不返回失效 path（task-75）。 */
  const overview = () => ops.getProjectOverview(state.project, { lastExportExists: existsSync })

  /** 列出 data/projects 下的 _autobackup-* 与 _history/<name> 版本（最新在前）。 */
  const listBackupEntries = async () => {
    const dataDir = state.dataDir
    const entries = []
    // 版本历史：扫描 _history 下所有工程目录 + 当前 activeName。
    const names = new Set()
    if (state.activeName) names.add(state.activeName)
    try {
      const historyRoot = path.join(projectsDir(dataDir), VERSION_DIR_NAME)
      const dirs = await readdir(historyRoot, { withFileTypes: true })
      for (const dir of dirs) if (dir.isDirectory()) names.add(dir.name)
    } catch {
      /* 没有 _history 目录 */
    }
    for (const name of names) {
      const versions = await listProjectVersions(dataDir, name).catch(() => [])
      for (const version of versions) {
        entries.push({
          kind: 'version',
          id: version.id,
          name,
          title: version.title,
          timestamp: version.timestamp,
          at: version.at,
          path: path.join(projectVersionsDir(dataDir, name), `${version.id}.json`),
          bytes: version.bytes,
        })
      }
    }
    // 自动备份：projects/_autobackup-*.json
    let files = []
    try {
      files = await readdir(projectsDir(dataDir))
    } catch {
      files = []
    }
    for (const filename of files.filter((item) => item.startsWith('_autobackup-') && item.endsWith('.json'))) {
      const filePath = path.join(projectsDir(dataDir), filename)
      let info = null
      try {
        info = await stat(filePath)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      let title = ''
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'))
        title = typeof parsed?.title === 'string' ? parsed.title : ''
      } catch {
        title = ''
      }
      entries.push({
        kind: 'autobackup',
        id: filename.replace(/\.json$/, ''),
        name: filename.replace(/\.json$/, ''),
        title,
        timestamp: String(Math.round(info.mtimeMs)),
        at: info.mtimeMs,
        path: filePath,
        bytes: info.size,
      })
    }
    entries.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
    return entries
  }

  /** 校验/读取备份文件为 schema2 工程。 */
  const readBackupProject = async (filePath) => {
    let raw
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      return { ok: false, error: `读取备份文件失败：${error?.message ?? error}` }
    }
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, error: '备份文件不是合法 JSON' }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '备份文件不是工程对象' }
    }
    if (Number(parsed.schemaVersion) !== SCHEMA_VERSION && Number(parsed.schemaVersion) !== 2) {
      return { ok: false, error: `备份文件 schemaVersion 必须为 ${SCHEMA_VERSION}（或可迁移的 2），收到 ${parsed.schemaVersion ?? '未知'}；v1 不兼容` }
    }
    try {
      return { ok: true, project: normalizeProject(parsed) }
    } catch (error) {
      return { ok: false, error: `备份工程数据非法：${error?.message ?? error}` }
    }
  }

  const tools = [
    /* ── 0. AI 接线信息（先确认在操作哪个窗口/工程）────────────────── */
    defineTool({
      name: 'studio_app_info',
      description:
        '**开始创作前先调用一次**：确认 AI 当前控制的是哪个窗口/工程，以及可用的真实采样音色列表。' +
        '返回 version/build（版本、git 提交、构建日期、渠道、Electron 版本）、app.mode/url/dataDir/pid、当前工程标题与 revision、instruments（采样乐器 id/中文名/GM 程序号）、drumKits、effects、counts。' +
        '所有 studio_* 写入都会进入 app.dataDir 指向的工程并显示在 app.url 窗口里；' +
        '如果桌面窗口没有运行，工具会直接报错（不会写进任何后台数据）——此时先让用户打开「AI 音乐工作室」窗口再重试。' +
        'preset/kit 的合法 id 以本工具返回的 instruments/drumKits 为准（如 grand_piano / finger_bass / strings_ensemble / smp_acoustic）。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const info = buildAppInfo(state)
          return ok({
            ...info,
            project: info.project
              ? {
                  ...info.project,
                  schemaVersion: Number(state.project?.schemaVersion),
                  format: {
                    name: 'aims',
                    version: Number(state.project?.schemaVersion),
                    ...(Number.isInteger(Number(state.project?.format?.migratedFrom))
                      ? { migratedFrom: Number(state.project.format.migratedFrom) }
                      : {}),
                  },
                }
              : null,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── 1. 读取工程概览 ───────────────────────────────────────────── */
    defineTool({
      name: 'studio_get_project',
      description:
        '读取当前 AI 音乐工程概览：BPM、调性、曲长、段落、轨道（乐器/效果器摘要、发送量、自动化曲线、侧链）、pattern 列表（只有音符数）、' +
        '播放列表 clips、master、返回总线 buses（reverb/delay 的 level 与 FX 链摘要）、播放状态、最近导出。开始创作或修改前先调用它了解现状；读取不会改动工程。' +
        '轨道的 automation 字段含每条自动化曲线的 enabled 与完整 points（点很多时会被截断并标 pointsTruncated；参数可为 volume/pan/cutoff/pitchBend/modulation/expression）；' +
        'sidechain 字段为侧链摘要（enabled/sourceTrackId/amount/attack/release，无侧链为 null）；sends 为 {reverb,delay} 发送量。' +
        '概览不含具体音符，需要音符时用 studio_get_pattern。典型流程：get_project → add_track → add_pattern → set_notes → set_arrangement；' +
        '需要参数随时间变化时用 studio_set_automation，需要鼓压贝斯泵感时用 studio_set_sidechain；' +
        '调发送/返回电平用 studio_set_track_sends / studio_set_bus，返回总线加 FX 用 studio_add_effect（target="bus"）。' +
        'media 是已导入的音频媒体（id/name/file/durationSeconds/…），音频轨 kind="audio"，音频片段在 clips 里带 mediaId（无 patternId）；' +
        '导入本机音频用 studio_import_audio。' +
        '轨道的 sustain 为延音踏板点（{beat,value 0/1}，无则 null）、vibrato 为揉弦（rateHz/depthCents/enabled，无则 null）；exportHistory 为最近导出记录。' +
        '全局速度曲线在 tempoMap（[{beat,bpm}]，空数组 = 常量 bpm；bpm 为基准/缺省速度）。' +
        'contentRevision 为内容版本（meta：activity/exportRequest/transport 不增加；dirty = contentRevision != savedContentRevision）；' +
        'includeNotes=true 时 patterns 每项带完整 notes（AI 一次拿全工程音符，不必逐个 get_pattern；工程很大时响应会变大）。' +
        '默认 sustain/automation 只给摘要（pointCount/down/firstBeat/lastBeat 等）；需要完整点传 includeSustain/includeAutomation=true。' +
        'midiMappings 为 R3c MIDI Learn 映射（全部，≤16 条）；groups 为 R4a Group bus（≤8，含 FX 摘要/输入轨数/bypassFx/pdcMs），每轨 output=\'master\' 或 group id、sendMode/phaseInvert/mono/bypassFx/pdcMs/automationMode/instrumentParams（仅 synth）；subtractive 轨额外 engine/synthPreset/synthParams；scenes 为 R4c 混音场景摘要（id/name/at/trackCount/groupCount，不返回完整 state）。lastExport 文件已不存在时会标 stale:true 且不返回失效 path。',
      parameters: {
        includeNotes: { type: 'boolean', description: '是否返回每个 pattern 的完整音符（默认 false；需要一次拿全工程旋律时传 true）' },
        includeSustain: { type: 'boolean', description: '是否返回轨道延音踏板的完整 points（默认 false，只给 pointCount/down/首尾）' },
        includeAutomation: { type: 'boolean', description: '是否返回轨道/master 自动化的完整 points（默认 false，只给摘要）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const overview = ops.getProjectOverview(state.project, {
            includeNotes: args?.includeNotes === true,
            includeSustain: args?.includeSustain === true,
            includeAutomation: args?.includeAutomation === true,
            lastExportExists: existsSync,
          })
          return ok({
            ...overview,
            contentRevision: state.contentRevision,
            savedContentRevision: state.savedContentRevision,
            dirty: state.contentRevision !== state.savedContentRevision,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── 2. 读取 pattern 音符 ──────────────────────────────────────── */
    defineTool({
      name: 'studio_get_pattern',
      description:
        '读取一个 pattern 的完整音符列表与引用它的轨道/片段信息。音符格式 {pitch,start,dur,vel}，时间单位 beat（1 小节 = 4 beat）。' +
        'patternId 来自 studio_get_project 的 patterns 列表。修改旋律/鼓型之前先用它看清现有音符，避免整段覆盖时丢内容。',
      parameters: {
        patternId: { type: 'string', required: true, description: 'pattern id，如 pat_3（来自 studio_get_project）' },
      },
      output: OUTPUT,
      execute: readTool((project, args) => ops.getPatternView(project, args)),
    }),

    /* ── 3. 重置工程 ──────────────────────────────────────────────── */
    defineTool({
      name: 'studio_create_project',
      description:
        '新建工程并设置标题/BPM/调式/曲长，或按模板创建（R5c）。会清空现有全部轨道、pattern、编排、场景与 MIDI 映射（不可恢复），' +
        '只应在用户明确要求「新建工程 / 从头开始」时调用；正常创作时不要调用它。template 可选 empty/demo/electronic/piano/song；' +
        '显式 title/bpm/key/scale/lengthBars 会覆盖模板默认。',
      parameters: {
        template: { type: 'string', enum: ['empty', 'demo', 'electronic', 'piano', 'song'], description: '工程模板：empty 空白/demo 演示/electronic 电子/piano 钢琴/song 歌曲；省略=空白' },
        title: { type: 'string', description: '作品标题（省略：模板名或「未命名作品」）' },
        bpm: { type: 'number', description: `速度，${LIMITS.minBpm}-${LIMITS.maxBpm}，默认 128` },
        key: { type: 'string', description: '调性主音，如 F# / C / A，默认 F#' },
        scale: { type: 'string', enum: SCALES.map((s) => s.id), description: `调式（${SCALE_IDS}），默认 minor` },
        lengthBars: { type: 'integer', description: `曲长（小节），1-${LIMITS.maxBars}，默认 32` },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发修改时避免误覆盖）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const conflict = revisionConflict(args)
          if (conflict !== null) return conflict
          // R0A：重置前统一快照（命名工程→版本历史；未命名→autobackup；失败只 warning）。
          const snapshot = await snapshotBeforeDestructive()
          state.mutate(
            {
              tool: 'studio_create_project',
              text: `创建工程「${args?.title ?? '未命名作品'}」${snapshot.backupName ? `（已快照旧工程：${snapshot.backupName}）` : ''}`,
              activity: `创建新工程「${args?.title ?? '未命名作品'}」`,
            },
            (draft) => ops.createProject(draft, args ?? {}),
          )
          // 新工程未保存过：清空活跃工程名，避免继续指向旧文件。
          state.setActiveProject(null, null)
          // R5c：新工程重置撤销/重做历史。
          if (typeof state.clearHistory === 'function') state.clearHistory()
          // R6c：新工程清空 AI 变更日志。
          state.aiJournal?.clear?.()
          return ok({
            project: overview(),
            backupPath: snapshot.backupPath ?? null,
            backupKind: snapshot.backupKind,
            ...(snapshot.warning ? { warning: snapshot.warning } : {}),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── 4. 添加轨道 ──────────────────────────────────────────────── */
    defineTool({
      name: 'studio_add_track',
      description:
        '新建一条轨道并返回 trackId。kind="synth" 使用真实采样乐器（GeneralUser GS SoundFont），kind="drum" 使用采样鼓机。' +
        `preset 可选：${SYNTH_IDS}。kit 可选：${KIT_IDS}。` +
        '**写之前先调用 studio_app_info 确认窗口/工程与合法 id**；' +
        '典型工作流：studio_app_info 确认目标 → add_track 拿 trackId → add_pattern 建 pattern → set_notes 写音符 → set_arrangement 编排。' +
        `R5d：engine="subtractive" 时用 synthPreset（可选：${SYNTH_INSTRUMENTS.map((item) => item.id).join(' / ')}），preset 与 synthPreset 互斥；engine 默认 sampler。` +
        'color 省略时自动使用乐器配色。',
      parameters: {
        name: { type: 'string', required: true, description: '轨道名，如「低音 · 指弹贝斯」，会显示在通道机架' },
        kind: { type: 'string', required: true, enum: ['synth', 'drum'], description: 'synth=乐器轨道（采样器或合成器），drum=采样鼓机轨道' },
        engine: { type: 'string', enum: ['sampler', 'subtractive'], description: 'R5d 引擎：sampler（默认，SF2 采样）/subtractive（内置合成器）' },
        synthPreset: { type: 'string', enum: SYNTH_INSTRUMENTS.map((item) => item.id), description: 'engine="subtractive" 时的合成器音色 id' },
        synthParams: { type: 'object', additionalProperties: true, description: '可选：合成器参数覆盖（wave/unison/detuneCents/subLevel/filterCutoff/filterQ/ADSR/lfo/level）' },
        preset: {
          type: 'string',
          enum: SYNTH_PRESETS.map((preset) => preset.id),
          description:
            `采样乐器 id（kind=synth 时用）。合法 id 以 studio_app_info 返回的 instruments 为准，常用：${SYNTH_IDS}；` +
            '默认 grand_piano（三角钢琴）',
        },
        kit: {
          type: 'string',
          description:
            `采样鼓机 id（kind=drum 时用）。合法 id 以 studio_app_info 返回的 drumKits 为准，常用：${KIT_IDS}；` +
            '默认 smp_acoustic',
        },
        role: { type: 'string', enum: TRACK_ROLES.map((r) => r.id), description: `轨道角色（${ROLE_IDS}），默认 lead（鼓轨固定 drums）` },
        volume: { type: 'number', description: '音量 0-1，默认 0.78' },
        pan: { type: 'number', description: '声像 -1（左）~ 1（右），默认 0' },
        color: { type: 'string', description: '#RRGGBB 颜色，省略自动取调色板/乐器配色' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_add_track',
          text: `添加轨道 ${args.kind === 'drum' ? `鼓组「${args.name}」` : `「${args.name}」`}`,
          activity: `正在搭建「${args.name ?? '新轨道'}」声部`,
        }),
        (draft, args) => ops.addTrack(draft, args),
      ),
    }),

    /* ── 4.5 导入音频（P3b） ──────────────────────────────────────── */
    defineTool({
      name: 'studio_import_audio',
      description:
        '把本机音频文件（wav / mp3 / flac / ogg，≤30MB）导入成一条音频轨 + 播放列表音频片段。' +
        'path 是 Host 所在机器的本地路径（绝对路径，或相对 Host 进程工作目录）；name 省略时用文件名；startBar 省略从 0 小节开始。' +
        'WAV 会解析文件头得到时长/声道/采样率；mp3/flac/ogg 时长未知时片段默认 4 小节（可之后用 setClips 调整 lengthBars）。' +
        '导入后可以用 studio_set_clips 移动/裁剪音频片段、用 studio_update_track / studio_set_track_sends 调整音频轨；' +
        '音频轨的移除由 UI（播放列表 / 通道机架「移除轨道」）操作，媒体文件保留。示例：{path:"C:\\\\Users\\\\me\\\\Music\\\\vocal.wav", name:"人声", startBar:8}。',
      parameters: {
        path: { type: 'string', required: true, description: '本机音频文件路径（wav/mp3/flac/ogg，≤30MB）' },
        name: { type: 'string', description: '导入后的媒体/轨道显示名；省略用文件名' },
        startBar: { type: 'integer', description: '音频片段起始小节（0 基，省略=0）' },
        takeGroup: { type: 'string', description: 'R2c：可选 take 组名（1..64 安全字符）；同组旧 take 自动 inactive' },
        takeIndex: { type: 'integer', description: 'R2c：可选 take 序号 0..99；省略按同组现有 max+1' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const rawPath = typeof args?.path === 'string' ? args.path.trim() : ''
          if (rawPath === '') return { ok: false, error: 'path 必须是本机音频文件路径（wav/mp3/flac/ogg）' }
          const resolved = path.resolve(rawPath)
          let info
          try {
            info = await stat(resolved)
          } catch {
            return { ok: false, error: `音频文件不存在：${rawPath}` }
          }
          if (!info.isFile()) return { ok: false, error: `不是文件：${rawPath}` }
          if (info.size === 0) return { ok: false, error: '音频文件为空' }
          if (info.size > MEDIA_MAX_BYTES) {
            return { ok: false, error: `音频文件过大（${(info.size / 1024 / 1024).toFixed(1)}MB，上限 30MB）` }
          }
          const ext = path.extname(resolved).slice(1).toLowerCase()
          if (!AUDIO_EXTS.includes(ext)) {
            return { ok: false, error: `不支持的音频格式 .${ext || '（无扩展名）'}；支持 ${AUDIO_EXTS.join(' / ')}` }
          }
          let buffer
          try {
            buffer = await readFile(resolved)
          } catch (error) {
            return { ok: false, error: `读取音频文件失败：${error?.message ?? error}` }
          }
          const parsed = ext === 'wav' ? parseWavInfo(buffer) : null
          if (ext === 'wav' && !parsed) return { ok: false, error: '不是合法 WAV（缺少 RIFF/WAVE 头或数据块）' }
          const fileNameFromDisk = path.basename(resolved)
          const mediaName = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : fileNameFromDisk
          const mediaId = makeIdGen(state.project)('med')
          // R2a 修复：media id 每工程从 med_1 重排，文件名必须全局唯一，避免跨工程覆盖。
          const { fileName: storedFile, filePath } = await writeUniqueMediaFile(state.mediaDir, buffer, { mediaId, ext })
          let result
          try {
            result = state.mutate(
              {
                tool: 'studio_import_audio',
                text: `导入音频：${mediaName}`,
                activity: '正在导入音频',
                undoLabel: '导入音频',
              },
              (draft) => {
                const media = ops.addMedia(draft, {
                  id: mediaId,
                  name: mediaName,
                  file: storedFile,
                  bytes: buffer.length,
                  durationSeconds: parsed?.durationSeconds ?? null,
                  channels: parsed?.channels,
                  sampleRate: parsed?.sampleRate,
                })
                const track = ops.addAudioTrack(draft, {
                  mediaId: media.id,
                  startBar: args?.startBar,
                  takeGroup: args?.takeGroup,
                  takeIndex: args?.takeIndex,
                })
                return { media, track }
              },
            )
          } catch (error) {
            await rm(filePath, { force: true })
            throw error
          }
          return {
            ok: true,
            mediaId,
            trackId: result.track.trackId,
            clipId: result.track.clipId,
            name: result.media.name,
            file: storedFile,
            bytes: buffer.length,
            durationSeconds: result.media.durationSeconds,
            channels: result.media.channels,
            sampleRate: result.media.sampleRate,
            startBar: result.track.startBar,
            lengthBars: result.track.lengthBars,
            ...(result.track.takeGroup ? { takeGroup: result.track.takeGroup, takeIndex: result.track.takeIndex, takeActive: true } : {}),
            rev: state.revision,
          }
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── 5. 修改轨道 ──────────────────────────────────────────────── */
    defineTool({
      name: 'studio_update_track',
      description:
        '修改已有轨道：名称、音量、声像、静音、独奏、采样乐器预设、reverb/delay 发送量，以及 R4b 混音控制：' +
        'sendMode（post 默认/pre=FX 前发送）、phaseInvert、mono、bypassFx（跳过轨道 FX）、pdcMs（0..500 毫秒手动延迟补偿，0 清除）、automationMode（read 默认/touch/latch/write）、instrumentParams（R5b 采样器参数，仅 synth）、engine/synthPreset/synthParams（R5d 合成器）。只传需要修改的字段。' +
        '采样乐器（SoundFont）没有合成参数；params 仅支持采样鼓机轨道（kickPitch/kickDecay/kickDrive/snareTone/clapSpread/hatDecay/drive/level），采样乐器轨道传 params 会报错；' +
        '采样鼓机 params 键：kickPitch/kickDecay/kickDrive/snareTone/clapSpread/hatDecay/drive/level。数值会被钳制到合法范围。',
      parameters: {
        trackId: { type: 'string', required: true, description: '轨道 id，如 trk_2' },
        name: { type: 'string', description: '新轨道名' },
        volume: { type: 'number', description: '音量 0-1' },
        pan: { type: 'number', description: '声像 -1~1' },
        mute: { type: 'boolean', description: '静音开关' },
        solo: { type: 'boolean', description: '独奏开关' },
        preset: { type: 'string', description: `采样乐器 id（仅 synth 轨），可选：${SYNTH_IDS}；换预设会切换采样音色` },
        params: {
          type: 'object',
          additionalProperties: true,
          description: '乐器参数覆盖对象，只写要改的键（见工具描述中的键名）；未知键会返回错误',
        },
        sends: {
          type: 'object',
          additionalProperties: true,
          properties: {
            reverb: { type: 'number', description: '混响发送量 0-1' },
            delay: { type: 'number', description: '延迟发送量 0-1' },
          },
        },
        sendMode: { type: 'string', enum: ['post', 'pre'], description: '发送点：post（默认，FX 后）/ pre（FX 前、轨道音量后）' },
        phaseInvert: { type: 'boolean', description: '相位反转（输出乘 -1）' },
        mono: { type: 'boolean', description: '单声道下混（L/R 各 0.5 求和）' },
        bypassFx: { type: 'boolean', description: '旁路整条轨道 FX 链' },
        pdcMs: { type: 'number', description: '手动延迟补偿 0..500 毫秒（1 位小数，0 清除）' },
        automationMode: { type: 'string', enum: ['read', 'touch', 'latch', 'write'], description: '自动化模式：read 默认（仅回放）/touch/latch/write（播放中记录参数变化；非法值回 read）' },
        instrumentParams: {
          type: 'object',
          additionalProperties: true,
          description: 'R5b：采样器参数合并更新（attack/release/filterCutoff/filterQ/lfoRate/lfoDepth；仅 synth 轨）',
        },
        engine: { type: 'string', enum: ['sampler', 'subtractive'], description: 'R5d：切换引擎（切换保留另一种音色配置）' },
        synthPreset: { type: 'string', enum: SYNTH_INSTRUMENTS.map((item) => item.id), description: 'R5d：合成器音色 id（subtractive）' },
        synthParams: { type: 'object', additionalProperties: true, description: 'R5d：合成器参数合并更新（仅 subtractive 生效）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_update_track',
          text: `调整轨道 ${args.trackId}`,
          activity: `正在调整「${args.trackId}」的音色与电平`,
        }),
        (draft, args) => ops.updateTrack(draft, args),
      ),
    }),

    /* ── 5.5 自动化曲线（P2a） ────────────────────────────────────── */
    defineTool({
      name: 'studio_set_automation',
      description:
        '设置一条自动化曲线（整条替换）：让轨道音量/声像/滤波截止/弯音/调制/表情随时间变化，播放与导出 WAV 都会生效。' +
        'target 省略="track"（需要 trackId）；target="master" 只支持 param="volume"（母带音量自动化）；表情类参数只能用于轨道。' +
        'points 是 {beat,value} 数组：beat 为**绝对 beat**（1 小节 = 4 beat，0 = 曲首），value 统一 0..1；' +
        '映射规则：音量=value；声像=value*2−1（0=左/0.5=中/1=右）；cutoff=80→16000Hz 对数映射（0=80Hz，1=16kHz）；' +
        'pitchBend=value*4−2 半音（−2..+2）；modulation=0..100 cents 揉弦深度；expression=0..1 音符增益。' +
        '表情值在音符起始采样（不做音符内连续弯音）。最多 256 点，beat 超界会自动夹到 [0, 曲长×4]，重复 beat 后者覆盖，传 [] 等同清空。' +
        'cutoff 自动化需要该轨道效果器链里已有 filter 效果器（用 studio_add_effect target=该轨 type="filter"），否则不会生效。' +
        '典型用法：Drop 前 8 小节做滤波扫频 [{beat:8,value:0.15},{beat:16,value:0.9}]；音量渐强 [{beat:0,value:0.2},{beat:16,value:1}]；' +
        '声像从左滑到右 [{beat:0,value:0.1},{beat:32,value:0.9}]；弯音下滑 [{beat:0,value:0.5},{beat:4,value:0}]。' +
        '已有曲线可用 studio_get_project 每轨的 automation 字段查看。',
      parameters: {
        target: {
          type: 'string',
          enum: ['track', 'master'],
          description: '作用目标：track（默认，需 trackId）或 master（仅 volume）',
        },
        trackId: { type: 'string', description: '轨道 id（target=track 时必填），如 trk_2' },
        param: {
          type: 'string',
          required: true,
          enum: Object.keys(AUTOMATION_PARAMS),
          description: '自动化参数：volume 音量 / pan 声像 / cutoff 滤波截止 / pitchBend 弯音（−2..+2 半音）/ modulation 调制（0..100 cents）/ expression 表情（增益 0..1，仅轨道）',
        },
        points: {
          type: 'array',
          required: true,
          description: '曲线点数组（整条替换），按 beat 升序；传 [] 表示清空该参数曲线',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              beat: { type: 'number', required: true, description: '绝对 beat（1 小节 = 4 beat，0 = 曲首）' },
              value: { type: 'number', required: true, description: '归一化值 0..1' },
            },
          },
        },
        enabled: { type: 'boolean', description: '是否启用该曲线，默认 true（false = 保留点但暂停生效）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const param = String(args?.param ?? '')
          const target = args?.target === 'master' ? 'master' : 'track'
          const paramLabel = AUTOMATION_PARAMS[param]?.label ?? param
          const ownerLabel = target === 'master' ? 'master' : String(args?.trackId ?? '轨道')
          const pointCount = Array.isArray(args?.points) ? args.points.length : 0
          const result = state.mutate(
            {
              tool: 'studio_set_automation',
              text: `设置自动化：${ownerLabel} · ${paramLabel}（${pointCount} 点）`,
              activity: `正在绘制「${paramLabel}」自动化曲线`,
              undoLabel: '编辑自动化',
            },
            (draft) => ops.setAutomation(draft, args ?? {}),
          )
          const warnings = []
          if (result.target === 'track' && result.param === 'cutoff') {
            const liveTrack = state.project.tracks.find((track) => track.id === result.trackId)
            if (!liveTrack?.effects?.some((fx) => fx.type === 'filter')) {
              warnings.push(
                '该轨道还没有 filter 效果器，cutoff 自动化不会生效；请先用 studio_add_effect（target=该轨, type="filter"）添加滤波器',
              )
            }
          }
          return ok({ ...result, ...(warnings.length > 0 ? { warnings } : {}) })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    defineTool({
      name: 'studio_clear_automation',
      description:
        '清除一条自动化曲线（删除该参数的全部点），可用撤销恢复。target 省略="track"（需要 trackId）；target="master" 只支持 volume。' +
        '如果只是想暂停曲线而保留画好的点，改用 studio_set_automation 传 enabled:false。',
      parameters: {
        target: {
          type: 'string',
          enum: ['track', 'master'],
          description: '作用目标：track（默认，需 trackId）或 master（仅 volume）',
        },
        trackId: { type: 'string', description: '轨道 id（target=track 时必填）' },
        param: {
          type: 'string',
          required: true,
          enum: Object.keys(AUTOMATION_PARAMS),
          description: '要清除的自动化参数（volume/pan/cutoff/pitchBend/modulation/expression/cc1/cc11/cc64/cc74）',
        },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const param = String(args?.param ?? '')
          const target = args?.target === 'master' ? 'master' : 'track'
          const paramLabel = AUTOMATION_PARAMS[param]?.label ?? param
          const ownerLabel = target === 'master' ? 'master' : String(args?.trackId ?? '轨道')
          const result = state.mutate(
            {
              tool: 'studio_clear_automation',
              text: `清除自动化：${ownerLabel} · ${paramLabel}`,
              activity: `正在清理「${paramLabel}」自动化曲线`,
              undoLabel: '清除自动化',
            },
            (draft) => ops.clearAutomation(draft, args ?? {}),
          )
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── 5.6 侧链压缩（P2b） ──────────────────────────────────────── */
    defineTool({
      name: 'studio_set_sidechain',
      description:
        '给一条轨道设置侧链压缩（ducking）：当「来源轨道」有音符事件时，目标轨道音量被快速压低再恢复，做出电子乐常见的"泵感"。' +
        '典型示例：底鼓压贝斯——trackId=贝斯轨（被压）、sourceTrackId=底鼓轨（触发）、amount 0.6、attack 0.005、release 0.15。' +
        '参数：amount 压缩深度 0..1（默认 0.5，越大压得越深）；attack 起音时间 0.001..0.2 秒（默认 0.005，越短越"抽"）；' +
        'release 恢复时间 0.02..1 秒（默认 0.12，0.15~0.2 泵感明显）；enabled 默认 true。' +
        'triggerNotes：可选触发音符过滤数组（0..127，最多 16 个，去重升序；例如 [36] 只让底鼓触发、避免踩镲误压；空数组 = 任意音符触发；省略该参数时保留既有过滤）；' +
        '单数用 triggerNote（如 36，等价 triggerNotes:[36]；两者同传会合并）。来源必须是同工程内另一条轨道且不能是自身；播放与导出 WAV 都会生效。清除用 studio_clear_sidechain。',
      parameters: {
        trackId: { type: 'string', required: true, description: '目标轨道 id（被压的轨道），如贝斯 trk_2' },
        sourceTrackId: { type: 'string', required: true, description: '来源轨道 id（触发压制的轨道），如底鼓 trk_1' },
        amount: { type: 'number', description: '压缩深度 0..1，默认 0.5；越大压得越深' },
        attack: { type: 'number', description: '起音时间（秒）0.001..0.2，默认 0.005' },
        release: { type: 'number', description: '恢复时间（秒）0.02..1，默认 0.12；0.15~0.2 泵感明显' },
        enabled: { type: 'boolean', description: '是否启用侧链，默认 true' },
        triggerNotes: {
          type: 'array',
          items: { type: 'integer' },
          description: '可选：触发过滤 MIDI 音高数组（0..127，最多 16，去重升序；如 [36] 只底鼓触发；空数组=任意音符）。单数可用 triggerNote',
        },
        triggerNote: {
          type: 'integer',
          description: '可选：单个触发音高（等价 triggerNotes:[x]，如 36=只底鼓；与 triggerNotes 同传时合并）',
        },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          // R0-12：DSH 参数 schema 无法声明 number|array，因此数组走 triggerNotes、单数走 triggerNote；
          // execute 内合并（直接调用时也兼容 triggerNotes 传单数）。
          const sidechainArgs = { ...(args ?? {}) }
          if (args?.triggerNote !== undefined && args.triggerNote !== null) {
            const existing = args.triggerNotes === undefined || args.triggerNotes === null
              ? []
              : (Array.isArray(args.triggerNotes) ? args.triggerNotes : [args.triggerNotes])
            sidechainArgs.triggerNotes = [...existing, args.triggerNote]
          }
          const triggerText = Array.isArray(sidechainArgs.triggerNotes)
            ? sidechainArgs.triggerNotes.join(',')
            : (sidechainArgs.triggerNotes === undefined || sidechainArgs.triggerNotes === null ? '保留' : String(sidechainArgs.triggerNotes))
          const result = state.mutate(
            {
              tool: 'studio_set_sidechain',
              text: `设置侧链：${args?.trackId ?? '轨道'} ← ${args?.sourceTrackId ?? '来源'}（amount ${args?.amount ?? 0.5}，triggerNotes ${triggerText}）`,
              activity: '正在配置侧链压缩（ducking）',
              undoLabel: '设置侧链',
            },
            (draft) => ops.setSidechain(draft, sidechainArgs),
          )
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    defineTool({
      name: 'studio_clear_sidechain',
      description:
        '清除一条轨道的侧链压缩配置（撤销可恢复）。如果只是想暂停侧链而保留参数，改用 studio_set_sidechain 传 enabled:false。',
      parameters: {
        trackId: { type: 'string', required: true, description: '要清除侧链的轨道 id' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const result = state.mutate(
            {
              tool: 'studio_clear_sidechain',
              text: `清除侧链：${args?.trackId ?? '轨道'}`,
              activity: '正在清除侧链压缩',
              undoLabel: '清除侧链',
            },
            (draft) => ops.clearSidechain(draft, args ?? {}),
          )
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── 6. 添加 pattern ──────────────────────────────────────────── */
    defineTool({
      name: 'studio_add_pattern',
      description:
        '新建一个空 pattern（音符容器）并返回 patternId。lengthBars 决定循环长度（通常 1/2/4/8 小节）。' +
        '之后用 studio_set_notes 填入音符，再用 studio_set_arrangement 把它作为 clip 放到时间线。' +
        '鼓型与旋律建议分别建 pattern，便于在不同段落复用。',
      parameters: {
        name: { type: 'string', required: true, description: 'pattern 名，如「鼓 · Drop」「主音 · 主题」' },
        lengthBars: { type: 'integer', required: true, description: 'pattern 循环长度（小节），常用 4' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_add_pattern',
          text: `新建 pattern「${args.name}」（${args.lengthBars} 小节）`,
          activity: `正在新建 pattern「${args.name ?? '新 pattern'}」`,
        }),
        (draft, args) => ops.addPattern(draft, args),
      ),
    }),

    /* ── 7. 写入音符 ──────────────────────────────────────────────── */
    defineTool({
      name: 'studio_set_notes',
      description:
        '用一个新数组整段替换 pattern 的全部音符（不是追加）。notes 每项 {pitch,start,dur,vel}，时间单位 beat：1 小节 = 4 beat，16 分音符 = 0.25 beat。' +
        '鼓轨用标准鼓件音高：36 底鼓、38 军鼓、39 拍手、42 闭镲、46 开镲、37 边击、45 低嗵、50 高嗵、49 吊镲。最多 4096 个音符。' +
        '音符 start 应落在 pattern 长度内（lengthBars×4 beat），超出部分不会循环播放；修改已有 pattern 前先 get_pattern，避免覆盖时丢音符。',
      parameters: {
        patternId: { type: 'string', required: true, description: '目标 pattern id，如 pat_3' },
        notes: {
          type: 'array',
          required: true,
          description: '完整音符数组；传 [] 表示清空该 pattern',
          items: NOTE_ITEM,
        },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_set_notes',
          text: `编写 ${args.patternId} 的 ${Array.isArray(args.notes) ? args.notes.length : 0} 个音符`,
          activity: `正在编写音符（${args.patternId ?? 'pattern'}）`,
        }),
        (draft, args) => ops.setNotes(draft, args),
      ),
    }),

    /* ── 8. 编排 ──────────────────────────────────────────────────── */
    defineTool({
      name: 'studio_set_arrangement',
      description:
        '整体替换播放列表编排：clips 决定每条轨道在哪些小节循环哪个 pattern、循环多长、是否移调；可选 sections 定义段落标签（Intro/Build/Drop/Break/Outro）。' +
        'clips 是整体替换而不是追加，适合一次性写完整首歌结构。音频片段（mediaId）支持 offsetSeconds/gainDb/fadeInSeconds/fadeOutSeconds/reverse/stretchRatio/semitones；pattern 片段忽略这些音频字段。' +
        '写作思路：先用各 track 的 pattern 铺满段落，再调整过渡与留白；片段结束不应超过 project.lengthBars。',
      parameters: {
        clips: {
          type: 'array',
          required: true,
          description: '完整片段数组（整体替换）；传 [] 表示清空编排',
          items: CLIP_ITEM,
        },
        sections: {
          type: 'array',
          description: '段落标签数组；提供则整体替换 sections，省略则保持原段落',
          items: SECTION_ITEM,
        },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_set_arrangement',
          text: `编排播放列表：${Array.isArray(args.clips) ? args.clips.length : 0} 个片段`,
          activity: '正在编排歌曲结构（段落 / 过渡 / 留白）',
        }),
        (draft, args) => ops.setArrangement(draft, args),
      ),
    }),

    /* ── 9. 添加效果器 ────────────────────────────────────────────── */
    defineTool({
      name: 'studio_add_effect',
      description:
        `给 master、某条轨道或返回总线（Reverb/Delay 返回）添加效果器并返回 effectId。` +
        `target 传 "master"、轨道 id、"bus"（此时必须再传 busId="reverb"|"delay"）或 "group"（此时必须再传 groupId）。type 可选：${FX_IDS}。` +
        'position 是效果器链中的插入位置（0 基，省略追加到末尾）；params 覆盖默认参数。' +
        '主要效果建议放在轨道插入链；整体空间感用 master 或发送量；返回总线可加 EQ/滤波/失真（如给混响返回加 filter 只留高频）。',
      parameters: {
        target: { type: 'string', required: true, description: '"master"、轨道 id（如 trk_2）、"bus" 或 "group"' },
        busId: { type: 'string', enum: ['reverb', 'delay'], description: 'target="bus" 时必填：返回总线 id' },
        groupId: { type: 'string', description: 'target="group" 时必填：编组 id（grp_n）' },
        type: { type: 'string', required: true, enum: FX_TYPES.map((fx) => fx.id), description: `效果器类型 id：${FX_IDS}` },
        params: FX_PARAMS_OBJECT,
        position: { type: 'integer', description: '链内插入位置（0 基），省略为末尾' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_add_effect',
          text: `为 ${args.target === 'bus' ? `返回总线 ${args.busId}` : args.target} 添加效果器 ${args.type}`,
          activity: `正在添加效果器 ${args.type ?? ''}`,
        }),
        (draft, args) => ops.addEffect(draft, args),
      ),
    }),

    /* ── 10. 修改效果器 ───────────────────────────────────────────── */
    defineTool({
      name: 'studio_update_effect',
      description:
        '修改已有效果器：开关 enabled、合并参数 params、调整链内位置 move（0 基）。target 与 effectId 来自 studio_get_project 或 add_effect 的返回。' +
        'target 支持 "master" / 轨道 id / "bus"（需 busId）/ "group"（需 groupId）。常用手法：自动化前的静态 reshape（调 filter cutoff）、降低 delay mix、压缩器阈值。',
      parameters: {
        target: { type: 'string', required: true, description: '"master"、轨道 id、"bus" 或 "group"' },
        busId: { type: 'string', enum: ['reverb', 'delay'], description: 'target="bus" 时必填：返回总线 id' },
        groupId: { type: 'string', description: 'target="group" 时必填：编组 id（grp_n）' },
        effectId: { type: 'string', required: true, description: '效果器 id，如 fx_2' },
        enabled: { type: 'boolean', description: '启用/旁路该效果器' },
        params: FX_PARAMS_OBJECT,
        move: { type: 'integer', description: '新的 0 基位置（在链内移动）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_update_effect',
          text: `调整 ${args.target === 'bus' ? `返回总线 ${args.busId}` : args.target} 的效果器 ${args.effectId}`,
          activity: '正在调整效果器参数',
        }),
        (draft, args) => ops.updateEffect(draft, args),
      ),
    }),

    /* ── 11. 移除效果器 ───────────────────────────────────────────── */
    defineTool({
      name: 'studio_remove_effect',
      description:
        '从 master、某条轨道、返回总线（target="bus" + busId）或编组（target="group" + groupId）的效果器链移除一个效果器，返回剩余链条。用于清理不再需要的效果或给新效果腾出槽位。',
      parameters: {
        target: { type: 'string', required: true, description: '"master"、轨道 id、"bus" 或 "group"' },
        busId: { type: 'string', enum: ['reverb', 'delay'], description: 'target="bus" 时必填：返回总线 id' },
        groupId: { type: 'string', description: 'target="group" 时必填：编组 id（grp_n）' },
        effectId: { type: 'string', required: true, description: '要移除的效果器 id，如 fx_1' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_remove_effect',
          text: `移除 ${args.target === 'bus' ? `返回总线 ${args.busId}` : args.target} 的效果器 ${args.effectId}`,
          activity: '正在精简效果器链',
        }),
        (draft, args) => ops.removeEffect(draft, args),
      ),
    }),

    /* ── 12. Master ───────────────────────────────────────────────── */
    defineTool({
      name: 'studio_set_master',
      description:
        '设置 master 音量，或用 effects 整链替换 master 效果器链。日常建议直接用 studio_add_effect / update_effect（target="master"）增量修改；' +
        'effects 整链替换只在需要重建母带链时使用。',
      parameters: {
        volume: { type: 'number', description: 'master 音量 0-1' },
        effects: {
          type: 'array',
          description: '整链替换 master 效果器（最多 8 个），每项 {type, params?, enabled?}；省略则不变',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              type: { type: 'string', required: true, description: `效果器类型 id，可选：${FX_IDS}` },
              params: FX_PARAMS_OBJECT,
              enabled: { type: 'boolean', description: '是否启用，默认 true' },
            },
          },
        },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_set_master',
          text: args.volume !== undefined ? `设置 master 音量 ${args.volume}` : '重建 master 效果器链',
          activity: '正在调整母带总线',
        }),
        (draft, args) => ops.setMaster(draft, args),
      ),
    }),

    /* ── 12.5 混音路由：轨道发送量（P2c-2） ───────────────────────── */
    defineTool({
      name: 'studio_set_track_sends',
      description:
        '设置某条轨道的发送量（send）：reverb（混响发送）/ delay（延迟发送）均为 0..1，只改传入的字段、未传保持不变。' +
        '发送越大该轨的混响/延迟湿声越多。示例：把长音 Pad 的混响发送调到 0.6 做出空间尾音；鼓只给 reverb 0.08~0.12 避免浑浊；' +
        '想要「大而远」的主音可 reverb 0.35 + delay 0.25。返回更新后的 sends。混响/延迟返回总电平用 studio_set_bus 调。',
      parameters: {
        trackId: { type: 'string', required: true, description: '轨道 id，如 trk_4（Pad）' },
        reverb: { type: 'number', description: '混响发送量 0..1（省略则不变）' },
        delay: { type: 'number', description: '延迟发送量 0..1（省略则不变）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => {
          const parts = []
          if (args.reverb !== undefined) parts.push(`reverb=${args.reverb}`)
          if (args.delay !== undefined) parts.push(`delay=${args.delay}`)
          return {
            tool: 'studio_set_track_sends',
            text: `调整发送：${args.trackId} ${parts.join(' ')}`,
            activity: '正在调整混响/延迟发送量',
            undoLabel: '调整发送',
          }
        },
        (draft, args) => ops.setTrackSends(draft, args),
      ),
    }),

    /* ── 12.6 混音路由：返回总线电平（P2c-2） ─────────────────────── */
    defineTool({
      name: 'studio_set_bus',
      description:
        '设置返回总线（Reverb Send / Delay Send）的返回电平 level：0..1，控制湿声整体音量。' +
        '典型：整首混响太湿时把 reverb 返回从 0.35 调到 0.2；想要更明显的延迟回声把 delay 返回调到 0.3。' +
        '返回总线的效果器链用 studio_add_effect / update_effect / remove_effect（target="bus", busId="reverb"|"delay"）编辑。',
      parameters: {
        bus: { type: 'string', required: true, enum: ['reverb', 'delay'], description: '返回总线：reverb 混响 / delay 延迟' },
        level: { type: 'number', description: '返回电平 0..1（省略则只读取当前值）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          if (args?.bus !== 'reverb' && args?.bus !== 'delay') {
            return { ok: false, error: "bus 必须是 'reverb' 或 'delay'" }
          }
          const busId = args.bus
          const busLabel = busId === 'delay' ? 'Delay 返回' : 'Reverb 返回'
          const result = state.mutate(
            {
              tool: 'studio_set_bus',
              text: `调整返回总线：${busLabel} level=${args?.level ?? '(未改)'}`,
              activity: `正在调整${busLabel}电平`,
              undoLabel: '调整返回总线',
            },
            (draft) => ops.setBus(draft, { busId, level: args?.level }),
          )
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── 13. 播放控制 ─────────────────────────────────────────────── */
    defineTool({
      name: 'studio_transport',
      description:
        '控制用户界面的播放：action="play" 从 positionBar（省略=当前播放头）开始播放，action="stop" 停止，action="seek" 定位到 positionBar。' +
        '写 transport 与命令序列号，浏览器端 UI 会执行并更新播放头。想让用户「听到」刚写的内容时调用 play；写完大段素材后建议先 stop 再 play 从头试听。',
      parameters: {
        action: { type: 'string', required: true, enum: ['play', 'stop', 'seek'], description: 'play=播放 / stop=停止 / seek=定位' },
        positionBar: { type: 'number', description: `目标小节（0 基，0-${LIMITS.maxBars}）；seek 时必填` },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_transport',
          text:
            args.action === 'play'
              ? `播放（从第 ${args.positionBar ?? '当前'} 小节）`
              : args.action === 'stop'
                ? '停止播放'
                : `定位到第 ${args.positionBar} 小节`,
          activity:
            args.action === 'play'
              ? '开始播放试听'
              : args.action === 'stop'
                ? '停止播放'
                : `正在定位到第 ${args.positionBar ?? 0} 小节`,
        }),
        (draft, args) => ops.transport(draft, args),
      ),
    }),

    /* ── 14. 导出（WAV/stems 走 UI 渲染 / MIDI 由 Host 直接生成） ────── */
    defineTool({
      name: 'studio_export',
      description:
        '把整首工程导出为文件。format="wav"（默认）：写入导出请求，浏览器端用 OfflineAudioContext 渲染并回传保存为 data/exports/*.wav，完成后 lastExport 更新（用户能看到下载）。' +
        'format="mp3" / "flac"：UI 渲染后编码为 MP3（lamejs，192kbps）/ FLAC（libflacjs）再回传，保存为 data/exports/*.mp3 / *.flac（含混响尾音/normalize/targetLufs 逻辑）。' +
        'format="midi"：Host 直接生成标准 MIDI 文件（Format 1 / PPQ 480 / 鼓轨通道 10 / 含 BPM 与拍号）保存到 data/exports/*.mid，不需要 UI 参与，适合「导出 MIDI、拿到别的 DAW 继续做」。' +
        'format="stems"：请求导出分轨——UI 会逐轨渲染为 data/exports/stems-<序号>-<轨道名>.wav（含效果器与 master 链，跳过静音轨），Host 只写导出请求，不触发整首 WAV 渲染。' +
        'targetLufs（-24..-5，如 -14）：按 LUFS 目标归一响度（UI 分析后加增益并钳制峰值≤0.98）；与 normalize 同时传时以 targetLufs 为主。' +
        'outputDir：可选作品文件夹（绝对路径、必须已存在且可写；不允许系统目录）；缺省 data/exports。' +
        '返回 jobId/status:"pending"：用 studio_export_status {jobId} 或 GET /export-status 查询任务；同名文件不会覆盖（自动追加 -2/-3）。' +
        '音频渲染需要几秒到几十秒，不要连续重复调用；完成后用 studio_get_project 或 studio_export_status 查看结果。用户说「导出 / 下载 / 保存成品」时调用；说「导出分轨 / 分轨文件 / stems」时用 format="stems"。',
      parameters: {
        format: {
          type: 'string',
          enum: ['wav', 'mp3', 'flac', 'midi', 'stems'],
          description: 'wav=离线渲染整首 WAV（默认）；mp3/flac=UI 编码为 MP3/FLAC；midi=Host 直接导出标准 MIDI；stems=UI 逐轨渲染分轨 WAV',
        },
        name: { type: 'string', description: '可选导出文件名（省略时用工程标题+时间戳自动生成；stems 命名由 UI 按轨道生成）' },
        tailSeconds: { type: 'number', description: '额外渲染的混响尾音秒数 0..8（默认 0；混响较长时传 1~3 避免尾音被切）' },
        normalize: { type: 'boolean', description: '是否峰值归一化（默认 false；开启时 UI 会把峰值缩放到约 -0.2dB）' },
        targetLufs: { type: 'number', description: '目标响度 LUFS（-24..-5，如 -14；与 normalize 同传时以 targetLufs 为主）' },
        outputDir: { type: 'string', description: '可选：作品输出文件夹绝对路径（须存在且可写；不允许系统目录；缺省 data/exports）' },
        silent: { type: 'boolean', description: 'AI 导出默认 true：只存盘/提示路径，不触发浏览器下载；false=允许下载' },
        download: { type: 'boolean', description: 'AI 导出默认 false；silent=false 且 download=true 时才触发下载' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          // v2.2 M4：导出前自动冻结未冻结/过期 VST3 乐器轨；效果器需引擎干声，未冻结时保留 bypass+warning。
          let autoFreezeWarnings = []
          try {
            const frozenForExport = await autoFreezeForExport({ dataDir: state.dataDir, project: state.project, service: getPluginService(), bars: args?.freezeBars })
            autoFreezeWarnings = frozenForExport.warnings ?? []
            if (frozenForExport.applied.length > 0) {
              const revision = state.revision
              state.mutate(
                { tool: 'studio_export', text: '导出前自动冻结外部插件', activity: '正在自动冻结外部插件', undoLabel: '导出前自动冻结' },
                (draft) => {
                  for (const item of frozenForExport.applied) {
                    setFreezeOnProject(draft, {
                      trackId: item.trackId,
                      effectId: item.effectId,
                      freeze: item.freeze,
                      mediaEntry: item.mediaEntry,
                      stateBase64: item.stateBase64,
                    })
                  }
                },
              )
              if (state.revision === revision) autoFreezeWarnings = [...autoFreezeWarnings]
            }
          } catch (error) {
            autoFreezeWarnings = [{ code: 'auto_freezee_failed', error: String(error?.message ?? error) }]
          }
          const rawFormat = args?.format
          const format = rawFormat === 'midi' || rawFormat === 'stems' || rawFormat === 'mp3' || rawFormat === 'flac' ? rawFormat : 'wav'
          const hasTargetLufs = args?.targetLufs !== undefined && args?.targetLufs !== null
          if (format === 'midi' && hasTargetLufs) {
            return { ok: false, error: 'targetLufs 只支持音频导出（wav/mp3/flac/stems），MIDI 导出不支持' }
          }
          if (hasTargetLufs) {
            const numericTarget = Number(args.targetLufs)
            if (!Number.isFinite(numericTarget) || numericTarget < -24 || numericTarget > -5) {
              return { ok: false, error: 'targetLufs 必须在 -24..-5 LUFS 之间（如 -14）' }
            }
          }
          if (format === 'midi') {
            const exported = await exportMidiFile({
              exportsDir: state.exportsDir,
              project: state.project,
              name: args?.name,
            })
            state.mutate({ tool: 'studio_export', text: `导出 MIDI：${exported.fileName}` }, (draft) =>
              ops.setLastExport(draft, { path: exported.path, bytes: exported.bytes, seconds: exported.seconds }),
            )
            return ok({ format: 'midi', ...exported })
          }
          let outputDir = null
          if (args?.outputDir !== undefined && args?.outputDir !== null && String(args.outputDir).trim() !== '') {
            try {
              outputDir = await resolveOutputDir(args.outputDir)
            } catch (error) {
              if (error?.name === 'OpError' || error instanceof ops.OpError) return { ok: false, error: error.message }
              throw error
            }
          }
          // v2.1：已有 pending 导出请求时复用（多客户端/连续调用只渲染一个 job，避免第一个 job 丢失）。
          const currentRequest = state.project.exportRequest
          if (currentRequest && currentRequest.status === 'pending') {
            return ok({
              requested: false,
              busy: true,
              jobId: currentRequest.jobId,
              seq: currentRequest.seq,
              ...claimedFields(currentRequest),
              hint: '已有导出任务进行中，请用 studio_export_status 查询；当前请求未被替换',
            })
          }
          const exportOptions = {
            tailSeconds: args?.tailSeconds,
            normalize: args?.normalize === true,
            ...(hasTargetLufs ? { targetLufs: args.targetLufs } : {}),
            ...(format !== 'wav' ? { format } : {}),
            ...(outputDir ? { outputDir } : {}),
            ...(typeof args?.name === 'string' && args.name.trim() !== '' ? { name: args.name.trim() } : {}),
            // v2.1：AI 导出默认 silent=true/download=false（只存盘+提示路径，不触发浏览器下载）。
            silent: args?.silent !== false,
            download: args?.download === true && args?.silent === false,
          }
          if (format === 'stems') {
            const result = state.mutate(
              {
                tool: 'studio_export',
                text: '请求导出分轨 WAV',
                activity: '正在准备分轨导出…',
              },
              (draft) => ops.exportRequest(draft, { ...exportOptions, format: 'stems' }),
            )
            return ok({
              format: 'stems',
              ...result,
              ...claimedFields(state.project.exportRequest),
              hint: 'UI 会逐轨渲染并保存到 data/exports/stems-<序号>-<轨道名>.wav（跳过静音轨）；可用 studio_export_status {jobId} 查询状态',
            })
          }
          const label = format === 'mp3' ? 'MP3' : format === 'flac' ? 'FLAC' : 'WAV'
          const result = state.mutate(
            { tool: 'studio_export', text: `请求导出整首 ${label} 母带`, activity: `正在导出 ${label} 母带…` },
            (draft) => ops.exportRequest(draft, exportOptions),
          )
          return ok({
            format,
            ...result,
            ...claimedFields(state.project.exportRequest),
            hint: format === 'wav'
              ? '导出请求已发出：UI 渲染完成后会保存并自动下载；用 studio_export_status 查询 jobId 状态（成功后 lastExport 更新）'
              : `导出请求已发出：UI 将编码为 ${label} 并保存；用 studio_export_status 查询 jobId 状态（成功后 lastExport 更新）`,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── 15. AI 动态 ──────────────────────────────────────────────── */
    defineTool({
      name: 'studio_set_activity',
      description:
        '更新 UI 顶部「AI 正在做什么」的动态文案（短句、≤60 字），让用户看到创作过程。每个创作阶段调用一次即可（如「正在编排 Drop 段落的鼓组」），' +
        '不要每次小改动都调用；文案用中文、口语化、有画面感。',
      parameters: {
        text: { type: 'string', required: true, description: '动态文案，如「正在编排 Drop 段落的鼓组」' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const text = String(args?.text ?? '')
          const result = state.mutate(
            { tool: 'studio_set_activity', text: `AI 动态：${text}`, activity: text },
            (draft) => ops.setActivity(draft, args ?? {}),
          )
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── P10.1 渲染预览（写完/改完先听效果）────────────────────────── */
    defineTool({
      name: 'studio_render_preview',
      description:
        '**写完/改完先预览再下结论**：让桌面窗口离线渲染指定小节区间（不写文件、不改工程、不占撤销步），返回客观电平分析：' +
        'peak/peakDb/rms/rmsDb/lufsApprox/crestDb/clipping/clippedSamples/silent（旧字段），' +
        '以及新版分析字段：真 K 加权 lufs / lufsMaxShortTerm / lufsMethod、stereoBalanceDb、correlation、spectralCentroidHz、bandEnergyPct（6 段）、sectionStats（includeSectionStats=true 时）。' +
        'includeStems=true 时返回逐轨 stems 峰值/RMS；soloTrackIds 只渲染指定轨（不改工程，用于单独听某轨）；' +
        'fast=true 低采样率快速预览（mode:"fast"，约 2x 加速，响度近似）；sampleRate 可显式覆盖（8000–96000）。' +
        '用它检查是否削波（clipping=true）、段落起伏、混响尾音是否够（tailSeconds）、轨道平衡/频谱；再决定改音量/效果器。' +
        '窗口未打开或 UI 未响应会超时（默认 120s，env AIMS_PREVIEW_TIMEOUT_MS 可配置；窗口被遮挡/最小化或大段预览已自动 fast）。lufsApprox 仅兼容旧字段，响度判断优先用 lufs。',
      parameters: {
        fromBar: { type: 'integer', description: '起始小节（0 基，默认 0）' },
        toBar: { type: 'integer', description: '结束小节（不含；默认 min(曲长, fromBar+4)，必须 > fromBar）' },
        tailSeconds: { type: 'number', description: '额外渲染的尾音秒数 0..8（默认 0；检查混响尾巴时传 1~3）' },
        includeStems: { type: 'boolean', description: '是否逐轨渲染分析（返回 stems 每轨 peakDb/rmsDb/clipping；较慢）' },
        soloTrackIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：只渲染这些轨道 id（不改工程；空数组/省略=全曲）。用 studio_get_project 的 tracks[].id',
        },
        trackIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：soloTrackIds 的别名（数组；执行时也兼容传单个 string），与 soloTrackIds 二选一即可',
        },
        fast: { type: 'boolean', description: '可选：低采样率快速预览（默认 22050Hz，返回 mode:"fast"；响度仍为近似）' },
        sampleRate: { type: 'number', description: '可选：显式采样率 8000–96000（优先于 fast 默认；越界返回中文错误）' },
        includeSectionStats: { type: 'boolean', description: '可选：按工程 sections 输出每段 peak/rms/lufs 等分析（Host 会附 sections 原始边界）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const lengthBars = Math.max(1, Number(state.project.lengthBars) || 32)
          const rawFrom = args?.fromBar === undefined || args.fromBar === null ? 0 : Number(args.fromBar)
          if (!Number.isInteger(rawFrom) || rawFrom < 0) return { ok: false, error: 'fromBar 必须是 >= 0 的整数小节' }
          if (rawFrom >= lengthBars) return { ok: false, error: `fromBar=${rawFrom} 超出曲长 ${lengthBars} 小节` }
          const rawTo = args?.toBar === undefined || args.toBar === null ? Math.min(lengthBars, rawFrom + 4) : Number(args.toBar)
          if (!Number.isInteger(rawTo) || rawTo <= rawFrom) return { ok: false, error: 'toBar 必须是 > fromBar 的整数小节' }
          const toBar = Math.min(lengthBars, rawTo)
          const rawTail = args?.tailSeconds === undefined || args.tailSeconds === null ? 0 : Number(args.tailSeconds)
          if (!Number.isFinite(rawTail) || rawTail < 0 || rawTail > 8) return { ok: false, error: 'tailSeconds 必须是 0..8 的数字（秒）' }
          // task-78：soloTrackIds（别名 trackIds）→ 校验现有轨道、去重。
          const soloInput = args?.soloTrackIds !== undefined ? args.soloTrackIds : args?.trackIds
          let soloTrackIds
          if (soloInput !== undefined && soloInput !== null) {
            const list = Array.isArray(soloInput) ? soloInput : [soloInput]
            if (!list.every((item) => typeof item === 'string')) {
              return { ok: false, error: 'soloTrackIds 必须是轨道 id 字符串数组（别名 trackIds 可传 string）' }
            }
            const wanted = [...new Set(list.map((item) => item.trim()).filter((item) => item !== ''))]
            const known = new Set(state.project.tracks.map((track) => track.id))
            const missing = wanted.filter((trackId) => !known.has(trackId))
            if (missing.length > 0) {
              return { ok: false, error: `soloTrackIds 包含不存在的轨道 id：${missing.join(', ')}（可用 studio_get_project 的 tracks[].id）` }
            }
            soloTrackIds = wanted
          }
          if (args?.fast !== undefined && typeof args.fast !== 'boolean') {
            return { ok: false, error: 'fast 必须是布尔值（true/false）' }
          }
          if (args?.includeSectionStats !== undefined && typeof args.includeSectionStats !== 'boolean') {
            return { ok: false, error: 'includeSectionStats 必须是布尔值（true/false）' }
          }
          let sampleRate
          if (args?.sampleRate !== undefined && args?.sampleRate !== null) {
            const rate = Number(args.sampleRate)
            if (!Number.isFinite(rate) || rate < 8000 || rate > 96000) {
              return { ok: false, error: 'sampleRate 必须在 8000–96000 Hz 之间（如 22050/44100/48000）' }
            }
            sampleRate = Math.round(rate)
          }
          const includeSectionStats = args?.includeSectionStats === true
          const params = {
            fromBar: rawFrom,
            toBar,
            tailSeconds: Math.round(rawTail * 1000) / 1000,
            includeStems: args?.includeStems === true,
            ...(soloTrackIds !== undefined ? { soloTrackIds } : {}),
            ...(args?.fast === true ? { fast: true } : {}),
            ...(sampleRate !== undefined ? { sampleRate } : {}),
            ...(includeSectionStats
              ? {
                  includeSectionStats: true,
                  // task-78：附原始 sections 边界（不做 tempo 积分；UI 用 shared/tempo.js 转秒）
                  sections: state.project.sections.map((section) => ({
                    name: section.name,
                    startBar: section.startBar,
                    lengthBars: section.lengthBars,
                  })),
                }
              : {}),
          }
          let analysis
          try {
            analysis = await requestPreview(state, params)
          } catch (error) {
            if (error?.code === 'PREVIEW_TIMEOUT') {
              return {
                ok: false,
                error: '渲染预览超时：可能窗口被遮挡/最小化、系统休眠或渲染过慢；请保持窗口可见后重试（大段预览已自动 fast）',
              }
            }
            return { ok: false, error: `预览渲染失败：${error?.message ?? error}` }
          }
          if (analysis === null || typeof analysis !== 'object' || Array.isArray(analysis)) {
            return { ok: false, error: '预览结果格式无效（UI 应返回 analysis 对象）' }
          }
          return ok({ preview: { ...params, ...analysis } })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── P10.2 工程自检（只读）───────────────────────────────────── */
    /* ── v2.4 P0：秒级 draft 混音检查 ───────────────────────────── */
    defineTool({
      name: 'studio_quick_mix_check',
      description:
        '**改参后的秒级 draft 混音检查**（v2.4 P0）：{fromBar?,toBar?,bars?=1,sampleRate?=8000,includeStems?=false}。' +
        '默认 1 小节 / 8000Hz / fast / 无 tail / 无 stems；bars 1–4、单次范围 ≤8 小节、sampleRate 仅 8000/11025/16000。' +
        '复用 preview bridge 渲染，返回精简 peak/rms/lufs/crest/clipping/stereoBalance/pbandEnergy/centroid + renderMs/cached/revision/range。' +
        '按 {revision,range,sampleRate,soloTrackIds,stems} 缓存最近 16 条；同 key 第二次 cached=true、renderMs=0；不写工程/不改 revision/undo。' +
        '**draft 只用于快速平衡/削波/频段粗查**；最终混音/导出仍用 studio_render_preview（full/44.1k/stems）。窗口未开/预览桥不可用时中文错误。',
      parameters: {
        fromBar: { type: 'integer', description: '起始小节（0 基，默认 0）' },
        toBar: { type: 'integer', description: '结束小节（不含；省略时=fromBar+bars）' },
        bars: { type: 'integer', description: '小节数 1–4（默认 1；与 toBar 同时给时以 toBar 为准）' },
        sampleRate: { type: 'number', description: '采样率 8000/11025/16000（默认 8000）' },
        includeStems: { type: 'boolean', description: '是否附带逐轨 stems（默认 false；draft 不建议开）' },
        soloTrackIds: { type: 'array', items: { type: 'string' }, description: '可选：只渲染这些轨道 id（缓存 key 含 solo）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const lengthBars = Math.max(1, Number(state.project.lengthBars) || 32)
          const rawFrom = args?.fromBar === undefined || args.fromBar === null ? 0 : Number(args.fromBar)
          if (!Number.isInteger(rawFrom) || rawFrom < 0) return { ok: false, error: 'fromBar 必须是 >= 0 的整数小节' }
          if (rawFrom >= lengthBars) return { ok: false, error: `fromBar=${rawFrom} 超出曲长 ${lengthBars} 小节` }
          const rawBars = args?.bars === undefined || args.bars === null ? 1 : Number(args.bars)
          if (!Number.isInteger(rawBars) || rawBars < 1 || rawBars > 4) return { ok: false, error: 'bars 必须是 1–4 的整数小节' }
          let toBar
          if (args?.toBar !== undefined && args.toBar !== null) {
            const rawTo = Number(args.toBar)
            if (!Number.isInteger(rawTo) || rawTo <= rawFrom) return { ok: false, error: 'toBar 必须是 > fromBar 的整数小节' }
            toBar = Math.min(lengthBars, rawTo)
          } else {
            toBar = Math.min(lengthBars, rawFrom + rawBars)
          }
          if (toBar <= rawFrom) return { ok: false, error: '渲染范围为空（fromBar 已到曲尾）' }
          const span = toBar - rawFrom
          if (span > QUICK_MIX_MAX_SPAN) return { ok: false, error: `quick_mix_check 单次范围最大 ${QUICK_MIX_MAX_SPAN} 小节（当前 ${span}）` }
          const rawRate = args?.sampleRate === undefined || args.sampleRate === null ? 8000 : Number(args.sampleRate)
          const sampleRate = Math.round(rawRate)
          if (!QUICK_MIX_SAMPLE_RATES.includes(sampleRate)) {
            return { ok: false, error: `sampleRate 仅支持 ${QUICK_MIX_SAMPLE_RATES.join('/')} Hz（quick draft）` }
          }
          if (args?.includeStems !== undefined && typeof args.includeStems !== 'boolean') {
            return { ok: false, error: 'includeStems 必须是布尔值（true/false）' }
          }
          const includeStems = args?.includeStems === true
          const soloInput = args?.soloTrackIds === undefined ? args?.trackIds : args.soloTrackIds
          let soloTrackIds = []
          if (soloInput !== undefined && soloInput !== null) {
            const list = Array.isArray(soloInput) ? soloInput : [soloInput]
            if (!list.every((item) => typeof item === 'string')) {
              return { ok: false, error: 'soloTrackIds 必须是轨道 id 字符串数组' }
            }
            const wanted = [...new Set(list.map((item) => item.trim()).filter((item) => item !== ''))]
            const known = new Set(state.project.tracks.map((track) => track.id))
            const missing = wanted.filter((trackId) => !known.has(trackId))
            if (missing.length > 0) return { ok: false, error: `soloTrackIds 包含不存在的轨道 id：${missing.join(', ')}` }
            soloTrackIds = wanted
          }
          const revision = state.revision
          const key = quickMixCacheKey({ revision, fromBar: rawFrom, toBar, sampleRate, soloTrackIds, stems: includeStems })
          const cached = getQuickMixCache(state, key)
          const range = { fromBar: rawFrom, toBar, bars: span }
          if (cached) {
            return ok({
              ok: true,
              mode: 'quick-draft',
              cached: true,
              renderMs: 0,
              revision,
              range,
              sampleRate,
              stems: includeStems,
              note: 'draft 近似结果（8k/fast）；最终混音/导出前请用 studio_render_preview 做 full 质量检查',
              ...cached.analysis,
            })
          }
          const startedAt = Date.now()
          let analysis
          try {
            analysis = await requestPreview(state, {
              fromBar: rawFrom,
              toBar,
              fast: true,
              sampleRate,
              includeStems,
              draft: true,
              quick: true,
              mode: 'draft',
              tailSeconds: 0,
              ...(soloTrackIds.length > 0 ? { soloTrackIds } : {}),
            })
          } catch (error) {
            return { ok: false, error: `quick_mix_check 渲染失败：${error?.message ?? error}；请确认桌面窗口已打开，或改用 studio_render_preview` }
          }
          const renderMs = Math.max(0, Date.now() - startedAt)
          if (analysis === null || typeof analysis !== 'object' || Array.isArray(analysis)) {
            return { ok: false, error: 'quick_mix_check 结果格式无效（UI 应返回 analysis 对象）；请改用 studio_render_preview' }
          }
          const condensed = {
            peak: analysis.peak ?? null,
            peakDb: analysis.peakDb ?? null,
            rms: analysis.rms ?? null,
            rmsDb: analysis.rmsDb ?? null,
            lufs: analysis.lufs ?? null,
            lufsApprox: analysis.lufsApprox ?? null,
            lufsMaxShortTerm: analysis.lufsMaxShortTerm ?? null,
            crestDb: analysis.crestDb ?? null,
            clipping: analysis.clipping === true,
            clippedSamples: Number(analysis.clippedSamples ?? 0) || 0,
            silent: analysis.silent === true,
            stereoBalanceDb: analysis.stereoBalanceDb ?? null,
            correlation: analysis.correlation ?? null,
            spectralCentroidHz: analysis.spectralCentroidHz ?? null,
            bandEnergyPct: analysis.bandEnergyPct ?? null,
            pbandEnergy: analysis.bandEnergyPct ?? null,
            dcOffset: analysis.dcOffset ?? null,
            ...(includeStems && Array.isArray(analysis.stems) ? { stems: analysis.stems } : {}),
          }
          setQuickMixCache(state, key, { analysis: condensed, renderMs, analysisRevision: revision })
          return ok({
            ok: true,
            mode: 'quick-draft',
            cached: false,
            renderMs,
            revision,
            range,
            sampleRate,
            stems: includeStems,
            cacheEntries: QUICK_MIX_CACHE_LIMIT,
            note: 'draft 近似结果（8k/fast）；最终混音/导出前请用 studio_render_preview 做 full 质量检查',
            ...condensed,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── v2.4 P1：实时电平测量（需要 UI 播放采样） ───────────────── */
    defineTool({
      name: 'studio_measure_live',
      description:
        '**实时电平测量**（v2.4 P1）：{fromBar?,bars?=1}；让桌面 UI 从 fromBar 播放 1–4 小节，每 50ms 采样 engine.getMeters()，停止并恢复 transport，阻塞返回 master/track RMS/peak/lufsApprox 聚合。' +
        '不改工程/undo；无 UI/音频未启用时中文错误（15s 超时）。适合看动态/低频泵感；频谱/响度终检仍用 studio_render_preview。',
      parameters: {
        fromBar: { type: 'integer', description: '起始小节（0 基，默认 0）' },
        bars: { type: 'integer', description: '播放小节数 1–4（默认 1）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const lengthBars = Math.max(1, Number(state.project.lengthBars) || 32)
          const fromBar = args?.fromBar === undefined || args.fromBar === null ? 0 : Number(args.fromBar)
          if (!Number.isInteger(fromBar) || fromBar < 0) return { ok: false, error: 'fromBar 必须是 >= 0 的整数小节' }
          if (fromBar >= lengthBars) return { ok: false, error: `fromBar=${fromBar} 超出曲长 ${lengthBars} 小节` }
          const bars = args?.bars === undefined || args.bars === null ? 1 : Number(args.bars)
          if (!Number.isInteger(bars) || bars < 1 || bars > 4) return { ok: false, error: 'bars 必须是 1–4 的整数小节' }
          if (fromBar + bars > lengthBars) return { ok: false, error: `测量范围超出曲长（${fromBar}+${bars} > ${lengthBars}）` }
          let result
          try {
            result = await requestMeter(state, { fromBar, bars })
          } catch (error) {
            return { ok: false, error: `studio_measure_live 失败：${error?.message ?? error}` }
          }
          return ok({
            ok: true,
            fromBar,
            bars,
            revision: state.revision,
            durationMs: result.durationMs,
            sampleCount: result.sampleCount,
            master: result.master,
            tracks: result.tracks,
            underruns: result.underruns,
            transport: result.transport,
            note: '实时电平近似（50ms 采样、不替代频谱分析）；最终响度/频谱请用 studio_render_preview',
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    defineTool({
      name: 'studio_validate_project',
      description:
        '只读自检当前工程，返回问题列表 issues（level=error/warn/info + code/message/path）与 counts/summary：' +
        '音符越界/时值、空 pattern/空轨、静音轨、clip 引用不存在或越界、音频媒体缺失、重复同类效果器、master 链过长、' +
        '自动化点越界、速度曲线点越界/乱序、未知采样乐器/鼓机等。写完后调用它自检，再针对性修复；不修改工程/不产生撤销步。' +
        'includeMix=true 时追加混音 lint（只读）：轨道响度差（RMS 比中位数低 >20dB）、低频过量（<250Hz 占比 >80%）、' +
        'L/R 平衡（|stereoBalanceDb|>3dB）、削波/峰值过载、响度异常、相位相关、静音/ solo 状态；issues 带 code/trackId/severity/suggestion。' +
        '混音 lint 优先用真实音频指标——把最近一次 studio_render_preview 的 analysis 作为 mixAnalysis 传入（含 stems/lufs/stereoBalanceDb/' +
        'bandEnergyPct/correlation/clipping 时最准）；不传则用工程音量/力度/乐器/EQ 做静态估算（mode:"static"）。',
      parameters: {
        includeMix: { type: 'boolean', description: '是否追加混音 lint（默认 false；只读，不渲染/不下载文件）' },
        mixAnalysis: {
          type: 'object',
          additionalProperties: true,
          description: '可选：studio_render_preview 返回的 analysis（真实音频指标；不传则静态估算）。含 stems 时可按轨比较 RMS',
        },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const includeMix = args?.includeMix === true
          const mixAnalysis = args?.mixAnalysis && typeof args.mixAnalysis === 'object' && !Array.isArray(args.mixAnalysis)
            ? args.mixAnalysis
            : null
          return ok(ops.validateProject(state.project, { includeMix, mixAnalysis }))
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── P10.3 增量编辑音符 ──────────────────────────────────────── */
    defineTool({
      name: 'studio_edit_notes',
      description:
        '增量编辑 pattern 音符（一次调用 = 一次撤销步「增量编辑音符」），避免整段重写；' +
        'update/remove 的 index 为 **0 基 noteIndex**（第 1 个音符 index=0；validate/doctor 的 notes[i] 同为 0 基）：' +
        'update 按索引改 pitch/start/dur/vel；remove 删除索引（0 基，顺序同 studio_get_pattern）；add 追加音符；' +
        'transpose 全部移调；velocityScale 力度整体缩放；quantize 吸附到网格（beat）；humanize 随机人性化（timing/velocity）。' +
        '执行顺序：update → remove → add → transpose → velocityScale → quantize → humanize。返回 noteCount，可用 get_pattern 查看。',
      parameters: {
        patternId: { type: 'string', required: true, description: '目标 pattern id' },
        add: { type: 'array', description: '要追加的音符数组（同 set_notes 结构）', items: NOTE_ITEM },
        remove: { type: 'array', description: '要删除的音符索引（0 基）', items: { type: 'integer' } },
        update: {
          type: 'array',
          description: '按索引修改音符 [{index,pitch?,start?,dur?,vel?}]',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              index: { type: 'integer', required: true, description: '音符索引（0 基）' },
              pitch: { type: 'integer', description: '新 MIDI 音高 0-127' },
              start: { type: 'number', description: '新起始 beat（>=0）' },
              dur: { type: 'number', description: '新时值 beat（>0）' },
              vel: { type: 'number', description: '新力度 0-1' },
            },
          },
        },
        transpose: { type: 'integer', description: '全部音符移调半音数（-48..48）' },
        velocityScale: { type: 'number', description: '力度乘数（0..2，结果钳制 0..1）' },
        quantize: { type: 'number', description: '量化网格（beat，如 0.25 = 16 分音符；>0）' },
        humanize: {
          type: 'object',
          additionalProperties: true,
          description: '随机人性化 {timing?,velocity?}（timing 默认 0.015 beat，velocity 默认 0.05）',
          properties: {
            timing: { type: 'number', description: '时间抖动（beat，默认 0.015）' },
            velocity: { type: 'number', description: '力度抖动（0..1，默认 0.05）' },
          },
        },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发修改时返回冲突，不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_edit_notes',
          text: `增量编辑 pattern ${args.patternId} 的音符`,
          activity: '正在增量编辑音符',
          undoLabel: '增量编辑音符',
        }),
        (draft, args) => ops.editPatternNotes(draft, args),
      ),
    }),

    /* ── P10.4 增量编辑片段 ──────────────────────────────────────── */
    defineTool({
      name: 'studio_edit_clips',
      description:
        '增量编辑播放列表片段（一次调用 = 一次撤销步「增量编辑片段」）：add 追加片段、remove 删除索引、' +
        'update 按索引改 trackId/patternId/mediaId/startBar/lengthBars/transpose/offsetSeconds/gainDb/fadeInSeconds/fadeOutSeconds/reverse/stretchRatio/semitones/takeGroup/takeIndex/takeActive。' +
        '音频片段（mediaId）支持 offset/gain/fade/reverse；pattern 片段不支持音频字段。校验同 set_arrangement（引用必须存在；音频片段必须放音频轨，音频轨不能放 pattern 片段）。',
      parameters: {
        add: {
          type: 'array',
          description: '要追加的片段 [{trackId,patternId 或 mediaId,startBar,lengthBars,transpose?,offsetSeconds?,gainDb?,fadeInSeconds?,fadeOutSeconds?,reverse?,stretchRatio?,semitones?,takeGroup?,takeIndex?,takeActive?}]',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              trackId: { type: 'string', required: true, description: '轨道 id' },
              patternId: { type: 'string', description: 'pattern id（pattern 片段）' },
              mediaId: { type: 'string', description: '媒体 id（音频片段）' },
              startBar: { type: 'integer', description: '起始小节（0 基）' },
              lengthBars: { type: 'integer', description: '长度（小节）' },
              transpose: { type: 'integer', description: '移调半音数（仅 pattern 片段）' },
              offsetSeconds: { type: 'number', description: '音频片段媒体内起点秒' },
              gainDb: { type: 'number', description: '音频片段增益 dB' },
              fadeInSeconds: { type: 'number', description: '音频片段淡入秒' },
              fadeOutSeconds: { type: 'number', description: '音频片段淡出秒' },
              reverse: { type: 'boolean', description: '音频片段反向' },
              stretchRatio: { type: 'number', description: '音频片段时间拉伸 0.25..4' },
              semitones: { type: 'number', description: '音频片段变调 -12..+12 半音' },
            },
          },
        },
        remove: { type: 'array', description: '要删除的片段全局索引（0 基，按当前顺序）', items: { type: 'integer' } },
        update: {
          type: 'array',
          description: '按索引修改片段 [{index,startBar?,lengthBars?,transpose?,trackId?,patternId?,mediaId?,offsetSeconds?,gainDb?,fadeInSeconds?,fadeOutSeconds?,reverse?,stretchRatio?,semitones?,takeGroup?,takeIndex?,takeActive?}]',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              index: { type: 'integer', required: true, description: '片段索引（0 基）' },
              trackId: { type: 'string', description: '新轨道 id' },
              patternId: { type: 'string', description: '新 pattern id' },
              mediaId: { type: 'string', description: '新媒体 id（音频片段）' },
              startBar: { type: 'integer', description: '新起始小节' },
              lengthBars: { type: 'integer', description: '新长度小节' },
              transpose: { type: 'integer', description: '新移调半音数' },
              offsetSeconds: { type: 'number', description: '音频片段媒体内起点秒' },
              gainDb: { type: 'number', description: '音频片段增益 dB' },
              fadeInSeconds: { type: 'number', description: '音频片段淡入秒' },
              fadeOutSeconds: { type: 'number', description: '音频片段淡出秒' },
              reverse: { type: 'boolean', description: '音频片段反向' },
              stretchRatio: { type: 'number', description: '音频片段时间拉伸 0.25..4' },
              semitones: { type: 'number', description: '音频片段变调 -12..+12 半音' },
              takeGroup: { type: 'string', description: 'R2c：take 组名' },
              takeIndex: { type: 'integer', description: 'R2c：take 序号 0..99' },
              takeActive: { type: 'boolean', description: 'R2c：false=inactive' },
            },
          },
        },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        () => ({ tool: 'studio_edit_clips', text: '增量编辑片段', activity: '正在增量编辑播放列表', undoLabel: '增量编辑片段' }),
        (draft, args) => ops.editClips(draft, args),
      ),
    }),

    /* ── P10.5 复制 pattern ─────────────────────────────────────── */
    defineTool({
      name: 'studio_copy_pattern',
      description: '复制一个 pattern（含全部音符，新 id；name 缺省「原 name 副本」）。不自动加 clip，需要自行 set_arrangement/edit_clips 引用。一次撤销步「复制 pattern」。',
      parameters: {
        patternId: { type: 'string', required: true, description: '要复制的 pattern id' },
        name: { type: 'string', description: '副本名称（省略 = 原名 + 副本）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({ tool: 'studio_copy_pattern', text: `复制 pattern ${args.patternId}`, activity: '正在复制 pattern', undoLabel: '复制 pattern' }),
        (draft, args) => ops.copyPattern(draft, args),
      ),
    }),

    /* ── P10.6 工程管理：保存 / 列出 / 打开 ─────────────────────── */
    defineTool({
      name: 'studio_save_project',
      description:
        '把当前工程保存为命名工程（data/projects/<name>.json），不修改工程内容/revision，并更新 activeName。' +
        'name 省略时用当前 activeName 或工程标题；同名已存在且不是当前活跃工程时默认拒绝（传 overwrite:true 覆盖）。' +
        '列表用 studio_list_projects，打开用 studio_open_project。',
      parameters: {
        name: { type: 'string', description: '工程名（省略：当前活跃工程名或工程标题）' },
        overwrite: { type: 'boolean', description: '同名工程已存在时是否覆盖（默认 false）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const requested = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : (state.activeName ?? state.project.title)
          const safeName = sanitizeProjectName(requested)
          const exists = await projectFileExists(state.dataDir, safeName)
          const isActive = state.activeName !== null && sanitizeProjectName(state.activeName) === safeName
          if (exists && !isActive && args?.overwrite !== true) {
            return { ok: false, error: `工程已存在：${safeName}；如需覆盖请传 overwrite:true，或换一个名字` }
          }
          const saved = await saveProjectFile(state.dataDir, safeName, state.project)
          state.setActiveProject(saved.name, saved.savedAt)
          // v2.1：保存成功后同步 dirty 基线（contentRevision 不因保存变化）。
          if (typeof state.markSaved === 'function') state.markSaved()
          return ok({
            name: saved.name,
            path: saved.path,
            bytes: saved.bytes,
            activeName: state.activeName,
            contentRevision: state.contentRevision,
            savedContentRevision: state.savedContentRevision,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_list_projects',
      description: '列出 data/projects 下的用户工程（自动备份 _autobackup-* 不显示）：name/title/savedAt/bytes/bpm/lengthBars/更新时间和轨道/pattern 数。' +
        'schemaVersion=2 的旧工程仍可列出（needsMigration:true，打开时一次性迁移到 3，迁移前备份到 data/migrations/）；schemaVersion=1/其它放在 unsupported 数组（不兼容，无法打开）。返回 activeName 便于确认当前保存到哪个工程。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const { projects, skipped, unsupported } = await listProjects(state.dataDir)
          return ok({
            activeName: state.activeName,
            projects: projects.map((project) => ({
              name: project.name,
              title: project.title,
              savedAt: project.savedAt,
              bytes: project.size,
              bpm: project.bpm,
              lengthBars: project.lengthBars,
              trackCount: project.trackCount,
              patternCount: project.patternCount,
              updatedAt: project.updatedAt,
              schemaVersion: project.schemaVersion,
              ...(project.needsMigration ? { needsMigration: true, migrationFrom: project.migrationFrom } : {}),
            })),
            ...(skipped.length > 0 ? { skipped } : {}),
            ...(unsupported && unsupported.length > 0 ? { unsupported } : {}),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_open_project',
      description:
        '打开命名工程（data/projects/<name>.json），替换当前工程并清空撤销历史；打开后自动设置 activeName。' +
        '先用 studio_list_projects 查看可用工程名；schemaVersion=2 旧工程会在打开时一次性迁移到 3（迁移前自动备份到 data/migrations/，返回 backupPath），schemaVersion=1/其它返回中文错误「旧版本工程不支持」。打开前如需保留当前工作请先 studio_save_project。',
      parameters: {
        name: { type: 'string', required: true, description: '工程名（studio_list_projects 返回的 name）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const name = typeof args?.name === 'string' ? args.name.trim() : ''
          if (name === '') return { ok: false, error: 'name 必须是工程名（可用 studio_list_projects 查看）' }
          const snapshot = await snapshotBeforeDestructive()
          const loaded = await loadProjectFile(state.dataDir, name)
          state.loadProject(loaded.project, { resetHistory: true, activity: `已打开工程「${loaded.name}」` })
          state.setActiveProject(loaded.name, loaded.savedAt)
          return ok({
            name: loaded.name,
            savedAt: loaded.savedAt,
            // 当前工程快照 + （若该命名工程为 v2）迁移前原文件备份
            backupPath: snapshot.backupPath ?? null,
            backupKind: snapshot.backupKind,
            ...(snapshot.warning ? { warning: snapshot.warning } : {}),
            ...(loaded.migratedFrom
              ? { migratedFrom: loaded.migratedFrom, migrationBackupPath: loaded.backupPath ?? null }
              : {}),
            project: overview(),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── P11：延音踏板 / 揉弦 ───────────────────────────────────── */
    defineTool({
      name: 'studio_set_sustain',
      description:
        '设置轨道的延音踏板曲线（整条替换；一次撤销步「设置延音踏板」）：points=[{beat,value}]，value 0=抬起 / 1=按下；' +
        '按 beat 升序（Host 自动排序/去重/夹紧到曲长/最多 256 点）。钢琴/弦乐等采样乐器会在音符结束时按踏板状态延长发声（最多 +8s）。' +
        '传空数组 [] 等于清除踏板（也可用 studio_clear_sustain）。',
      parameters: {
        trackId: { type: 'string', required: true, description: '轨道 id，如 trk_3（钢琴/弦乐轨）' },
        points: {
          type: 'array',
          description: '踏板点数组 [{beat,value}]（beat 绝对 beat，1 小节 = 4 beat；value 0/1）',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              beat: { type: 'number', required: true, description: '绝对 beat（0 = 曲首）' },
              value: { type: 'number', required: true, description: '0=抬起 / 1=按下（>=0.5 视为按下）' },
            },
          },
        },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        () => ({ tool: 'studio_set_sustain', text: '设置延音踏板', activity: '正在设置延音踏板', undoLabel: '设置延音踏板' }),
        (draft, args) => ops.setSustain(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_clear_sustain',
      description: '清除轨道的延音踏板曲线（幂等；一次撤销步「清除延音踏板」）。',
      parameters: {
        trackId: { type: 'string', required: true, description: '轨道 id' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        () => ({ tool: 'studio_clear_sustain', text: '清除延音踏板', activity: '正在清除延音踏板', undoLabel: '清除延音踏板' }),
        (draft, args) => ops.clearSustain(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_set_vibrato',
      description:
        '设置轨道揉弦（部分更新；一次撤销步「设置揉弦」）：rateHz 0.1..12（默认 5.5）、depthCents 0..100（默认 15）、enabled 开关。' +
        '采样乐器（弦乐/长笛/人声等）发声时会用 LFO 调制音高；鼓/音频轨一般不需要。只传要改的字段。',
      parameters: {
        trackId: { type: 'string', required: true, description: '轨道 id' },
        rateHz: { type: 'number', description: '揉弦速率 0.1..12 Hz（默认 5.5）' },
        depthCents: { type: 'number', description: '揉弦深度 0..100 音分（默认 15）' },
        enabled: { type: 'boolean', description: '是否启用（默认 true）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        () => ({ tool: 'studio_set_vibrato', text: '设置揉弦', activity: '正在设置揉弦', undoLabel: '设置揉弦' }),
        (draft, args) => ops.setVibrato(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_clear_vibrato',
      description: '清除轨道揉弦配置（幂等；一次撤销步「清除揉弦」）。',
      parameters: {
        trackId: { type: 'string', required: true, description: '轨道 id' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        () => ({ tool: 'studio_clear_vibrato', text: '清除揉弦', activity: '正在清除揉弦', undoLabel: '清除揉弦' }),
        (draft, args) => ops.clearVibrato(draft, args),
      ),
    }),

    /* ── P12b：全局速度曲线（tempo automation/rubato）────────────── */
    defineTool({
      name: 'studio_set_tempo_map',
      description:
        '设置全局速度曲线（整条替换；一次撤销步「设置速度曲线」）：points=[{beat,bpm}]，beat 为绝对 beat（1 小节 = 4 beat）、bpm 40..200；' +
        'Host 自动排序/去重（同 beat 后者覆盖）/夹紧到曲长/最多 64 点。播放/导出/MIDI 以曲线为准（相邻点之间线性插值），' +
        'point 之间是渐变速度，适合 ritardando/rubato/段落加速；空数组=清除（也可用 studio_clear_tempo_map）。',
      parameters: {
        points: {
          type: 'array',
          description: '速度点数组 [{beat,bpm}]（按 beat 升序；bpm 40..200）',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              beat: { type: 'number', required: true, description: '绝对 beat（0 = 曲首）' },
              bpm: { type: 'number', required: true, description: '该点速度 40..200 BPM' },
            },
          },
        },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        () => ({ tool: 'studio_set_tempo_map', text: '设置速度曲线', activity: '正在设置速度曲线', undoLabel: '设置速度曲线' }),
        (draft, args) => ops.setTempoMap(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_clear_tempo_map',
      description: '清除全局速度曲线（幂等；一次撤销步「清除速度曲线」）；清除后使用常量 bpm。',
      parameters: {
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        () => ({ tool: 'studio_clear_tempo_map', text: '清除速度曲线', activity: '正在清除速度曲线', undoLabel: '清除速度曲线' }),
        (draft, args) => ops.clearTempoMap(draft, args),
      ),
    }),

    /* ── P13：批量编辑（一次撤销）────────────────────────────────── */
    defineTool({
      name: 'studio_batch',
      description:
        '一次执行多个编辑操作（**一次 mutate / 一次撤销**，默认撤销步「批量编辑」）：ops=[{type,args}]，任一操作非法则整批不写入并返回中文错误。' +
        '适合 AI 一次完成「写鼓型 + 加贝斯 + 编排」或用户一次调整多个参数，避免几十次工具调用产生几十个撤销步。' +
        '白名单 type：' +
        `${ops.BATCH_OP_TYPES.join(' / ')}` +
        '；args 为对应 host op 的参数（与单独工具一致：如 updateTrack 的 {trackId,volume}、addEffect 的 {target,type,params}、' +
        `setAutomation 的 {trackId,param,points}、copyPattern 的 {patternId}）。最多 ${ops.BATCH_MAX_OPS} 个操作；label 可选自定义撤销步名称。`,
      parameters: {
        ops: {
          type: 'array',
          required: true,
          description: `操作数组 [{type,args}]（最多 ${ops.BATCH_MAX_OPS} 个；白名单见工具描述）`,
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              type: {
                type: 'string',
                required: true,
                enum: [...ops.BATCH_OP_TYPES],
                description: '操作类型（白名单）',
              },
              args: { type: 'object', additionalProperties: true, description: '对应 host op 的参数对象' },
            },
          },
        },
        label: { type: 'string', description: '可选：撤销步名称（默认「批量编辑」，≤60 字）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_batch',
          text: `批量编辑（${Array.isArray(args?.ops) ? args.ops.length : 0} 个操作）${args?.label ? `：${args.label}` : ''}`,
          activity: '正在批量编辑工程…',
          undoLabel: typeof args?.label === 'string' && args.label.trim() !== '' ? args.label.trim() : '批量编辑',
        }),
        (draft, args) => ops.applyBatchOps(draft, args),
      ),
    }),

    /* ── P14a：MIDI 导入 + 工程版本历史 ──────────────────────────── */
    defineTool({
      name: 'studio_import_midi',
      description:
        '导入一个标准 MIDI 文件（SMF Format 0/1，≤10MB）为工程或追加轨道：解析 note/program/tempo/拍号/轨名；' +
        '首 tempo → BPM，tempo 点 → tempoMap；channel 10 → 采样鼓；GM program → 最近的采样乐器（自动选 role）；每轨生成一个 pattern + clip。' +
        'replace=true（默认）会先自动备份当前工程再整体替换（activeName 清空）；replace=false 追加轨道/pattern/clip（id 自动重映射）。' +
        '一次撤销「导入 MIDI」；旧工程可通过 data/legacy-v1 或工程版本历史找回。path 为 Host 本机文件路径（绝对路径或相对 Host 工作目录）。',
      parameters: {
        path: { type: 'string', required: true, description: 'MIDI 文件路径（.mid/.midi，≤10MB，Host 本机路径）' },
        replace: { type: 'boolean', description: 'true（默认）=替换当前工程；false=追加轨道/编排' },
        title: { type: 'string', description: '可选：导入后工程标题（replace=true 时用；默认「MIDI 导入」）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const conflict = revisionConflict(args)
          if (conflict !== null) return conflict
          const filePath = typeof args?.path === 'string' ? args.path.trim() : ''
          if (filePath === '') return { ok: false, error: 'path 必须是 MIDI 文件路径（.mid/.midi）' }
          const resolved = path.resolve(filePath)
          let info
          try {
            info = await stat(resolved)
          } catch (error) {
            return { ok: false, error: `无法读取 MIDI 文件：${resolved}（${error?.message ?? error}）` }
          }
          if (!info.isFile()) return { ok: false, error: `不是文件：${resolved}` }
          if (info.size > MAX_MIDI_BYTES) {
            return { ok: false, error: `MIDI 文件过大（${(info.size / 1024 / 1024).toFixed(1)}MB，上限 10MB）` }
          }
          const buffer = await readFile(resolved)
          const result = await importMidiIntoState(state, {
            buffer,
            title: typeof args?.title === 'string' && args.title.trim() !== '' ? args.title.trim() : undefined,
            replace: args?.replace !== false,
            name: path.basename(resolved).replace(/\.midi?$/i, ''),
          })
          return ok({
            ...result.imported,
            title: result.title,
            replace: result.replace,
            backupPath: result.backupPath,
            ...(result.warning ? { warning: result.warning } : {}),
            project: overview(),
          })
        } catch (error) {
          if (error?.name === 'MidiImportError') return { ok: false, error: error.message }
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_list_project_versions',
      description:
        '列出一个命名工程的版本历史（每次 studio_save_project / UI 保存都会自动写入一个版本，保留最新 20 个；不含自动备份）：' +
        '返回 versions:[{id,timestamp,title,bytes,at}]（最新在前）。name 省略时用当前活跃工程名；用于找回误改前的工程，恢复用 studio_restore_project_version。',
      parameters: {
        name: { type: 'string', description: '工程名（省略 = 当前活跃工程名）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const name = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : state.activeName
          if (!name) return { ok: false, error: '当前工程还没有保存过，暂无版本历史；请先 studio_save_project 保存工程' }
          const versions = await listProjectVersions(state.dataDir, name)
          return ok({ name, activeName: state.activeName, versions })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_restore_project_version',
      description:
        '恢复一个工程历史版本到当前工程（先自动备份当前工程，再整体替换；一次撤销「恢复历史版本」，activeName 设为该工程名）：' +
        'name=工程名（省略=当前 activeName），id=studio_list_project_versions 返回的版本 id（如 20261022-213045-123）。' +
        '适合误删/误改后回滚；恢复的版本仍保持 schema2。',
      parameters: {
        name: { type: 'string', description: '工程名（省略 = 当前活跃工程名）' },
        id: { type: 'string', required: true, description: '版本 id（studio_list_project_versions 返回）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const conflict = revisionConflict(args)
          if (conflict !== null) return conflict
          const name = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : state.activeName
          if (!name) return { ok: false, error: '缺少工程名 name（当前工程未保存过，请显式传 name）' }
          const id = typeof args?.id === 'string' ? args.id.trim() : ''
          if (id === '') return { ok: false, error: 'id 必须是版本 id（studio_list_project_versions 返回）' }
          const version = await readProjectVersion(state.dataDir, name, id)
          let backup = null
          let warning = null
          try {
            backup = await writeAutobackup(state.dataDir, state.project)
          } catch (error) {
            warning = `自动备份失败：${error?.message ?? error}`
          }
          state.mutate(
            {
              tool: 'studio_restore_project_version',
              text: `恢复工程「${version.name}」历史版本 ${id}`,
              activity: `正在恢复「${version.name}」的历史版本`,
              undoLabel: '恢复历史版本',
            },
            (draft) => ops.applyMidiProject(draft, version.project, { replace: true }),
          )
          state.setActiveProject(version.name, version.savedAt)
          return ok({
            name: version.name,
            id,
            backupPath: backup?.path ?? null,
            ...(warning ? { warning } : {}),
            project: overview(),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── P14b：参考曲导入（A/B 对比）──────────────────────────────── */
    defineTool({
      name: 'studio_import_reference',
      description:
        '导入一条参考曲音频轨（用于 A/B 对比）：读取本机音频（wav/mp3/flac/ogg，≤30MB），创建 reference:true 的音频轨 + 音频片段，' +
        '默认命名「参考曲 · <文件名>」、音量 0.9、发送量很小、默认静音（mute:true），避免直接混入工程。' +
        'path 为 Host 本机路径（绝对路径或相对工作目录）；startBar 省略从 0 小节开始；一次撤销「导入参考曲」。' +
        'UI 可用 A/B 按钮临时只播放参考轨；导入后可 studio_update_track 调音量或取消静音。',
      parameters: {
        path: { type: 'string', required: true, description: '本机音频文件路径（wav/mp3/flac/ogg，≤30MB）' },
        startBar: { type: 'integer', description: '音频片段起始小节（0 基，省略=0）' },
        takeGroup: { type: 'string', description: 'R2c：可选 take 组名（1..64 安全字符）' },
        takeIndex: { type: 'integer', description: 'R2c：可选 take 序号 0..99；省略按同组 max+1' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const rawPath = typeof args?.path === 'string' ? args.path.trim() : ''
          if (rawPath === '') return { ok: false, error: 'path 必须是本机音频文件路径（wav/mp3/flac/ogg）' }
          const resolved = path.resolve(rawPath)
          let info
          try {
            info = await stat(resolved)
          } catch {
            return { ok: false, error: `参考曲文件不存在：${rawPath}` }
          }
          if (!info.isFile()) return { ok: false, error: `不是文件：${rawPath}` }
          if (info.size === 0) return { ok: false, error: '参考曲文件为空' }
          if (info.size > MEDIA_MAX_BYTES) {
            return { ok: false, error: `参考曲文件过大（${(info.size / 1024 / 1024).toFixed(1)}MB，上限 30MB）` }
          }
          const ext = path.extname(resolved).slice(1).toLowerCase()
          if (!AUDIO_EXTS.includes(ext)) {
            return { ok: false, error: `不支持的音频格式 .${ext || '（无扩展名）'}；支持 ${AUDIO_EXTS.join(' / ')}` }
          }
          let buffer
          try {
            buffer = await readFile(resolved)
          } catch (error) {
            return { ok: false, error: `读取参考曲失败：${error?.message ?? error}` }
          }
          const parsed = ext === 'wav' ? parseWavInfo(buffer) : null
          if (ext === 'wav' && !parsed) return { ok: false, error: '不是合法 WAV（缺少 RIFF/WAVE 头或数据块）' }
          const fileNameFromDisk = path.basename(resolved)
          const mediaId = makeIdGen(state.project)('med')
          // R2a 修复：参考曲导入同样使用全局唯一文件名。
          const { fileName: storedFile, filePath } = await writeUniqueMediaFile(state.mediaDir, buffer, { mediaId, ext })
          let result
          try {
            result = state.mutate(
              {
                tool: 'studio_import_reference',
                text: `导入参考曲：${fileNameFromDisk}`,
                activity: '正在导入参考曲',
                undoLabel: '导入参考曲',
              },
              (draft) => {
                const media = ops.addMedia(draft, {
                  id: mediaId,
                  name: fileNameFromDisk,
                  file: storedFile,
                  bytes: buffer.length,
                  durationSeconds: parsed?.durationSeconds ?? null,
                  channels: parsed?.channels,
                  sampleRate: parsed?.sampleRate,
                })
                const track = ops.addAudioTrack(draft, {
                  mediaId: media.id,
                  startBar: args?.startBar,
                  reference: true,
                  takeGroup: args?.takeGroup,
                  takeIndex: args?.takeIndex,
                })
                return { media, track }
              },
            )
          } catch (error) {
            await rm(filePath, { force: true })
            throw error
          }
          return ok({
            reference: true,
            mediaId,
            trackId: result.track.trackId,
            clipId: result.track.clipId,
            name: result.track.name,
            fileName: fileNameFromDisk,
            file: storedFile,
            bytes: buffer.length,
            durationSeconds: result.media.durationSeconds,
            channels: result.media.channels,
            sampleRate: result.media.sampleRate,
            mute: result.track.mute,
            volume: result.track.volume,
            startBar: result.track.startBar,
            lengthBars: result.track.lengthBars,
            ...(result.track.takeGroup ? { takeGroup: result.track.takeGroup, takeIndex: result.track.takeIndex, takeActive: true } : {}),
            hint: '参考轨默认静音；用 A/B 按钮或 studio_update_track {mute:false} 试听，避免混入成品导出。',
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),

    /* ── R0A：导出任务状态 / undo / redo / 历史 / 原子工程导入 / 小节结构 ── */
    defineTool({
      name: 'studio_export_status',
      description:
        '查询导出任务状态（R0A）：studio_export 会返回 jobId（status=pending）；渲染/编码完成后由 UI 回传 /export-done 变为 success，失败为 error。' +
        'jobId 省略时返回当前/最近一个任务；返回 status/format/path/bytes/seconds/outputDir/error/startedAt/finishedAt。' +
        'AI 导出后可用本工具确认是否完成、文件在哪；失败时把 error 告诉用户。',
      parameters: {
        jobId: { type: 'string', description: '可选：导出任务 id（studio_export 返回的 jobId）；省略=当前/最近任务' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const result = ops.getExportStatus(state.project, typeof args?.jobId === 'string' ? args.jobId : undefined)
          return ok({ found: result.found, job: result.job, activeName: state.activeName })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_undo',
      description:
        '撤销上一步 AI/用户编辑（与 UI 的 /history/undo 共享同一撤销栈）：一次调用撤销一步，返回 label、undoDepth/redoDepth 与新的工程概览。' +
        '撤销栈为空时返回中文错误；可先 studio_get_history 查看栈深度/最近操作。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const result = state.undo()
          if (!result.ok) {
            const history = state.historyState()
            return { ok: false, error: '没有可撤销的操作（撤销栈为空）', undoDepth: history.undoDepth, redoDepth: history.redoDepth, rev: state.revision }
          }
          return ok({
            label: result.label,
            ...state.historyState(),
            project: overview(),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_redo',
      description:
        '重做上一步被撤销的编辑（与 UI 的 /history/redo 共享同一撤销栈）：一次调用重做一步，返回 label、undoDepth/redoDepth 与新的工程概览。' +
        '重做栈为空时返回中文错误；可先 studio_get_history 查看栈状态。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const result = state.redo()
          if (!result.ok) {
            const history = state.historyState()
            return { ok: false, error: '没有可重做的操作（重做栈为空）', undoDepth: history.undoDepth, redoDepth: history.redoDepth, rev: state.revision }
          }
          return ok({
            label: result.label,
            ...state.historyState(),
            project: overview(),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_get_history',
      description:
        '读取撤销/重做栈摘要与最近操作（R0A）：返回 canUndo/canRedo、undoLabel/redoLabel（下一次操作名）、undoDepth/redoDepth、revision、activeName，' +
        '以及 recentActions（最近 20 条工程操作记录）。只读；撤销/重做用 studio_undo / studio_redo。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const history = state.historyState()
          const recent = Array.isArray(state.project.history) ? state.project.history.slice(-20) : []
          return ok({
            ...history,
            revision: state.revision,
            activeName: state.activeName,
            recentActions: recent,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_import_project_json',
      description:
        '原子导入一整份工程 JSON（R0A，schemaVersion 必须为 3）：一次校验（schema/字段/上限）→ 先自动快照当前工程 → 一次 mutate 整份替换 → 一次撤销「导入工程」。' +
        '不接收 schemaVersion=2（旧格式）：请先打开该工程完成迁移，或用 studio_get_project 拿当前 v3 工程；v1 不兼容。' +
        '用于 AI 一次性生成/复制工程（替代几十次建轨调用）；project 为完整工程对象（可来自 studio_get_project + includeNotes 或外部生成）。' +
        'title 可选覆盖标题；replace 默认 true（当前仅支持 true）；非法 schema/超限返回中文错误且不写入。',
      parameters: {
        project: { type: 'object', additionalProperties: true, required: true, description: '完整 schemaVersion 3 工程对象（tracks/patterns/clips/master…）' },
        title: { type: 'string', description: '可选：导入后工程标题' },
        replace: { type: 'boolean', description: '是否整份替换（默认 true；当前仅支持 true）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const conflict = revisionConflict(args)
          if (conflict !== null) return conflict
          if (!args || args.project === undefined) return { ok: false, error: '缺少 project（完整工程 JSON 对象）' }
          const snapshot = await snapshotBeforeDestructive()
          const result = state.mutate(
            { tool: 'studio_import_project_json', text: '导入工程 JSON', activity: '正在导入工程', undoLabel: '导入工程' },
            (draft) => ops.importProjectJson(draft, args.project, { replace: args.replace !== false, title: args.title }),
          )
          state.setActiveProject(null, null)
          return ok({
            ...result,
            backupPath: snapshot.backupPath ?? null,
            backupKind: snapshot.backupKind,
            ...(snapshot.warning ? { warning: snapshot.warning } : {}),
            project: overview(),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_insert_bars',
      description:
        '在 atBar 处插入 count 个小节（R0A 结构编辑）：clips 起点右移、跨边界片段延长；automation beat、sections、tempoMap beat 同步右移；曲长 +count。' +
        '一次撤销「插入小节」；atBar 为 0 基插入位置（0=曲首），超出上限返回中文错误。返回摘要（clips/sections/tempoPoints 处理数）。',
      parameters: {
        atBar: { type: 'integer', required: true, description: '插入位置（0 基小节；0=曲首）' },
        count: { type: 'integer', required: true, description: '插入小节数（1..曲长上限）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({ tool: 'studio_insert_bars', text: `插入 ${args?.count ?? 0} 小节（atBar=${args?.atBar ?? 0}）`, activity: '正在插入小节', undoLabel: '插入小节' }),
        (draft, args) => ops.insertBars(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_delete_bars',
      description:
        '删除 [atBar, atBar+count) 小节（R0A 结构编辑）：完全在删除区的 clips/sections 移除，跨边界片段裁剪/拼接；automation beat、tempoMap beat 左移，删除区内自动化点移除；曲长 -count。' +
        '一次撤销「删除小节」；atBar 0 基、范围不能超出曲长，非法返回中文错误。返回摘要（removedClips/removedSections/removedTempoPoints）。',
      parameters: {
        atBar: { type: 'integer', required: true, description: '删除起点（0 基小节）' },
        count: { type: 'integer', required: true, description: '删除小节数（1..曲长）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({ tool: 'studio_delete_bars', text: `删除 ${args?.count ?? 0} 小节（atBar=${args?.atBar ?? 0}）`, activity: '正在删除小节', undoLabel: '删除小节' }),
        (draft, args) => ops.deleteBars(draft, args),
      ),
    }),

    defineTool({
      name: 'studio_list_backups',
      description:
        '列出可恢复的工程备份（task-75）：包括自动备份 projects/_autobackup-*.json 与命名工程版本历史 projects/_history/<name>/（最新在前）。' +
        '返回 kind（version/autobackup）、id、name、title、at/timestamp、bytes、path。name 省略时默认当前 activeName（仍会列出所有历史工程）；' +
        '恢复用 studio_restore_backup {name,id} / {path}。只读，不会改动工程。',
      parameters: {
        name: { type: 'string', description: '可选：只看某个工程的版本历史（默认当前活跃工程 + 所有历史工程）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const filterName = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null
          const all = await listBackupEntries()
          const backups = filterName
            ? all.filter((entry) => entry.kind === 'autobackup' || entry.name === filterName)
            : all
          return ok({
            activeName: state.activeName,
            filterName,
            backups,
            counts: {
              version: backups.filter((entry) => entry.kind === 'version').length,
              autobackup: backups.filter((entry) => entry.kind === 'autobackup').length,
            },
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_restore_backup',
      description:
        '恢复一个工程备份到当前工程（task-75）：支持 {name,id}（命名工程版本历史）、{path}（data/projects 下的 _autobackup-*.json 或版本文件）、' +
        '或省略参数恢复最近一次自动备份。恢复前自动快照当前工程（backupPath），之后整体替换（撤销历史清空）；' +
        '版本历史恢复会把 activeName 设回该工程名，自动备份恢复则 activeName=null。非法路径/schema 返回中文错误。',
      parameters: {
        name: { type: 'string', description: '可选：工程名（配合 id 使用；省略时用当前 activeName）' },
        id: { type: 'string', description: '可选：备份 id（studio_list_backups 返回的 id；版本历史 id 形如 20261023-181500-123）' },
        path: { type: 'string', description: '可选：备份文件绝对路径（必须在 data/projects 下；与 name/id 二选一）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const projectsRoot = path.resolve(projectsDir(state.dataDir))
          let entry = null
          const rawPath = typeof args?.path === 'string' ? args.path.trim() : ''
          if (rawPath !== '') {
            const resolved = path.resolve(rawPath)
            const normalizeCase = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
            const resolvedKey = normalizeCase(resolved)
            const rootKey = normalizeCase(projectsRoot)
            if (resolvedKey !== rootKey && !resolvedKey.startsWith(rootKey + path.sep)) {
              return { ok: false, error: '只能恢复 data/projects 下的备份文件' }
            }
            let info = null
            try {
              info = await stat(resolved)
            } catch {
              return { ok: false, error: `备份文件不存在：${resolved}` }
            }
            if (!info.isFile()) return { ok: false, error: `不是文件：${resolved}` }
            const filename = path.basename(resolved)
            const isAutobackup = filename.startsWith('_autobackup-')
            entry = {
              kind: isAutobackup ? 'autobackup' : 'version',
              id: filename.replace(/\.json$/, ''),
              name: isAutobackup ? filename.replace(/\.json$/, '') : (() => {
                const parent = path.basename(path.dirname(resolved))
                return parent === VERSION_DIR_NAME ? (path.basename(path.dirname(path.dirname(resolved))) || state.activeName) : (state.activeName ?? '')
              })(),
              path: resolved,
              at: info.mtimeMs,
              bytes: info.size,
            }
          } else {
            const wantedId = typeof args?.id === 'string' && args.id.trim() !== '' ? args.id.trim() : null
            const wantedName = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : state.activeName
            const all = await listBackupEntries()
            if (wantedId) {
              entry = all.find((item) => item.id === wantedId && (!wantedName || item.name === wantedName || item.kind === 'version')) ?? null
              if (!entry && wantedName) {
                entry = all.find((item) => item.id === wantedId) ?? null
              }
            } else if (wantedName) {
              entry = all.find((item) => item.kind === 'version' && item.name === wantedName) ?? null
            } else {
              entry = all.find((item) => item.kind === 'autobackup') ?? null
            }
            if (!entry) {
              return { ok: false, error: '没有找到可恢复的备份（可先 studio_list_backups 查看；或用 studio_save_project 保存工程后产生版本历史）' }
            }
          }
          const loaded = await readBackupProject(entry.path)
          if (!loaded.ok) return loaded
          const snapshot = await snapshotBeforeDestructive()
          state.loadProject(loaded.project, { resetHistory: true, activity: '已恢复工程备份' })
          if (entry.kind === 'version' && entry.name) {
            state.setActiveProject(entry.name, Date.now())
          } else {
            state.setActiveProject(null, null)
          }
          return ok({
            restored: true,
            kind: entry.kind,
            id: entry.id,
            name: entry.name ?? null,
            path: entry.path,
            title: state.project.title,
            backupPath: snapshot.backupPath ?? null,
            backupKind: snapshot.backupKind,
            ...(snapshot.warning ? { warning: snapshot.warning } : {}),
            project: overview(),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── R1a：自动保存恢复 / 工程 doctor / 性能指标 ─────────────── */
    defineTool({
      name: 'studio_get_recovery',
      description:
        '查询上次异常退出后的自动保存恢复信息（只读）：{detected, available, autosave:{revision,at,bytes,activeName,tool}|null, projectRevision, lock?}。' +
        'detected=true 表示上次未正常退出（session.lock 残留）；available=true 表示有比当前项目更新（或当前项目损坏回退）的 autosave.json 可恢复，' +
        '**不会自动覆盖当前项目**。恢复用 studio_restore_recovery；正常无异常时 available=false。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const recovery = state.recovery
          return ok({
            ...recovery,
            autosavePath: path.join(state.dataDir, RECOVERY_DIR_NAME, AUTOSAVE_FILE_NAME),
            lockPath: path.join(state.dataDir, RECOVERY_DIR_NAME, SESSION_LOCK_FILE_NAME),
            hint: recovery.available
              ? '检测到可恢复的自动保存：确认后调用 studio_restore_recovery 恢复（会先备份当前项目）。'
              : (recovery.detected ? '上次可能异常退出，但没有可用的自动保存。' : '没有异常退出记录，无需恢复。'),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_restore_recovery',
      description:
        '恢复上次异常退出时的自动保存内容（R1a）：读取 recovery/autosave.json → 校验 schema2 → 先备份当前项目到 _autobackup（返回 backupPath）→ ' +
        '一次 mutate 整体替换（撤销步「恢复自动保存」）→ 清理 autosave。discardCurrent=true 时跳过当前项目备份（仅在明确丢弃时使用）。' +
        '无 autosave/内容非法时返回中文错误；不自动恢复、必须显式调用。',
      parameters: {
        discardCurrent: { type: 'boolean', description: '默认 false（恢复前备份当前项目）；true=跳过备份直接丢弃当前内容' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const autosavePath = path.join(state.dataDir, RECOVERY_DIR_NAME, AUTOSAVE_FILE_NAME)
          let raw
          try {
            raw = await readFile(autosavePath, 'utf8')
          } catch (error) {
            if (error?.code === 'ENOENT') return { ok: false, error: '没有可恢复的自动保存（recovery/autosave.json 不存在）' }
            return { ok: false, error: `读取自动保存失败：${error?.message ?? error}` }
          }
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch {
            return { ok: false, error: '自动保存文件不是合法 JSON（可能写了一半），无法恢复' }
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.project !== 'object' || parsed.project === null) {
            return { ok: false, error: '自动保存文件格式非法（缺少 project 对象）' }
          }
          const autosaveSchemaVersion = Number(parsed.project.schemaVersion)
          if (autosaveSchemaVersion !== SCHEMA_VERSION && autosaveSchemaVersion !== 2) {
            return { ok: false, error: `自动保存的工程 schemaVersion 必须为 ${SCHEMA_VERSION}（或可迁移的 2）；v1 不兼容` }
          }
          let restoredProject
          try {
            restoredProject = normalizeProject(parsed.project)
          } catch (error) {
            return { ok: false, error: `自动保存的工程内容非法：${error?.message ?? error}` }
          }
          const discardCurrent = args?.discardCurrent === true
          let backupPath = null
          let warning = null
          if (!discardCurrent) {
            try {
              const backup = await writeAutobackup(state.dataDir, state.project)
              backupPath = backup.path
            } catch (error) {
              return { ok: false, error: `恢复前备份当前项目失败：${error?.message ?? error}` }
            }
          } else {
            warning = 'discardCurrent=true：已跳过当前项目备份，当前未保存内容将被丢弃'
          }
          const autosaveMeta = {
            revision: Number(parsed.revision) || 0,
            at: Number(parsed.at) || 0,
            bytes: Number(parsed.projectBytes ?? parsed.bytes) || Buffer.byteLength(raw),
            activeName: typeof parsed.activeName === 'string' ? parsed.activeName : null,
            tool: typeof parsed.tool === 'string' ? parsed.tool : null,
          }
          state.mutate(
            { tool: 'studio_restore_recovery', text: '恢复自动保存', activity: '正在恢复自动保存…', undoLabel: '恢复自动保存' },
            (draft) => ops.applyMidiProject(draft, restoredProject, { replace: true }),
          )
          if (autosaveMeta.activeName) state.setActiveProject(autosaveMeta.activeName, null)
          state.consumeRecovery()
          return ok({
            restored: true,
            autosave: autosaveMeta,
            backupPath,
            ...(warning ? { warning } : {}),
            activeName: state.activeName,
            project: overview(),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_doctor_project',
      description:
        '深度自检工程（R1a，默认只读）：检查 schemaVersion/revision、tracks/patterns/clips 引用、媒体缺失、音符越界/时值、空 pattern/空轨、' +
        '重复/非法效果器、automation/tempo/sustain/vibrato/sidechain 越界、master 链长度、重复 track id、clip 越界等。' +
        '返回 issues:[{code,level,message,path,trackId?,canRepair}] + counts/summary。' +
        'repair=true 时做安全修复（删除非法 clip/媒体引用、裁剪越界音符、删除重复/非法效果器、规范化 automation/tempo/sustain/sidechain；' +
        '不删除有内容的轨道/pattern，媒体缺失只删 clip 不删轨），先备份当前工程、一次 mutate（撤销步「修复工程」），返回 repaired 前后统计。',
      parameters: {
        repair: { type: 'boolean', description: '是否执行安全修复（默认 false=只读）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const repair = args?.repair === true
          if (!repair) return ok(ops.doctorProject(state.project))
          const snapshot = await snapshotBeforeDestructive()
          const result = state.mutate(
            { tool: 'studio_doctor_project', text: '修复工程问题', activity: '正在安全修复工程…', undoLabel: '修复工程' },
            (draft) => ops.doctorProject(draft, { repair: true }),
          )
          return ok({
            ...result,
            backupPath: snapshot.backupPath ?? null,
            backupKind: snapshot.backupKind,
            ...(snapshot.warning ? { warning: snapshot.warning } : {}),
            project: overview(),
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_get_metrics',
      description:
        '读取 Host 性能/规模指标（R1a，只读）：uptimeMs、revision、projectBytes、tracks/patterns/clips/notes/media、' +
        'toolCalls:{total,avgMs,maxMs,last}、state:{saveMs,loadMs,saveCount,loadCount}、memory:{rss,heapUsed}。' +
        '用于判断卡顿/工程规模/工具耗时；不包含工程内容或敏感信息。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const project = state.project
          const snapshot = metrics.snapshot()
          const stats = ops.projectStats(project)
          return ok({
            ...snapshot,
            revision: Number(project.revision) || 0,
            projectBytes: Buffer.byteLength(JSON.stringify(project)),
            tracks: project.tracks.length,
            patterns: project.patterns.length,
            clips: project.clips.length,
            notes: stats.notes,
            media: Array.isArray(project.media) ? project.media.length : 0,
            activeName: state.activeName,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── R2a：音频片段电平/淡变/反向/分割 ───────────────────────── */
    defineTool({
      name: 'studio_update_audio_clip',
      description:
        '编辑一个音频片段（media clip）的电平/淡变/反向/起点/长度（R2a，一次 mutate/一次撤销）：' +
        'gainDb -24..24 dB（0 清除）、fadeInSeconds/fadeOutSeconds 0..10 秒（0 清除）、reverse 布尔、offsetSeconds 媒体内起点（秒）、' +
        'startBar/lengthBars 片段位置与长度、stretchRatio 0.25..4（timeline=源×ratio，1 清除）、semitones -12..12（1 位小数，0 清除）。' +
        '只允许音频片段（pattern 片段会中文拒绝）；会校验范围/精度、媒体源时长与片段长度、fadeIn+fadeOut ≤ 实际可播放时长；返回更新后的完整 clip 字段。' +
        '引擎（实时/导出）会按 gain/fade/reverse/stretch/semitones 生效；相邻片段默认不自动 crossfade。',
      parameters: {
        clipId: { type: 'string', required: true, description: '音频片段 id（get_project 的 clips[].id，必须带 mediaId）' },
        gainDb: { type: 'number', description: '片段增益 dB（-24..24，默认 0；0 清除）' },
        fadeInSeconds: { type: 'number', description: '淡入秒数 0..10（默认 0；超过可播放时长会中文拒绝）' },
        fadeOutSeconds: { type: 'number', description: '淡出秒数 0..10（默认 0；fadeIn+fadeOut ≤ 可播放时长）' },
        reverse: { type: 'boolean', description: '是否反向播放（true=反向；offset/duration 从反转后音频头部算）' },
        offsetSeconds: { type: 'number', description: '媒体内起点秒（>=0，须小于媒体时长）' },
        startBar: { type: 'integer', description: '片段起始小节（0 基）' },
        lengthBars: { type: 'integer', description: '片段长度（小节，需在媒体剩余时长内）' },
        stretchRatio: { type: 'number', description: '时间拉伸 0.25..4（timeline 秒=源秒×ratio；1=原速/清除）' },
        semitones: { type: 'number', description: '独立变调 -12..+12 半音（1 位小数；0=无变调/清除）' },
        takeGroup: { type: 'string', description: 'R2c：take 组名（空串清除整组 take 字段）' },
        takeIndex: { type: 'integer', description: 'R2c：take 序号 0..99（需 takeGroup）' },
        takeActive: { type: 'boolean', description: 'R2c：false=inactive；true=激活（需 takeGroup）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_update_audio_clip',
          text: `编辑音频片段：${args?.clipId ?? '片段'}`,
          activity: '正在编辑音频片段的电平/淡变/反向',
          undoLabel: '编辑音频片段',
        }),
        (draft, args) => ops.updateAudioClip(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_split_audio_clip',
      description:
        '在绝对小节 atBar 处把一个音频片段切成两个（R2a，一次 mutate/一次撤销）：要求 clipStart < atBar < clipEnd。' +
        '左段缩短并保留原 fadeIn、去掉 fadeOut；右段 startBar=atBar、lengthBars 相应，offsetSeconds 增加「按当前 tempo/tempoMap 积分' +
        '得到的 timeline 秒数 ÷ stretchRatio」（源媒体时间增量），保留原 fadeOut、去掉 fadeIn（默认不自动 crossfade，避免爆音）；' +
        'gainDb/reverse/stretchRatio/semitones 两段都保留；fade 仍按 timeline 秒分配。返回 {left,right,splitAtBar,offsetDeltaSeconds,sourceOffsetDeltaSeconds}。',
      parameters: {
        clipId: { type: 'string', required: true, description: '要分割的音频片段 id' },
        atBar: { type: 'integer', required: true, description: '分割位置（绝对小节，必须在片段内部）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_split_audio_clip',
          text: `分割音频片段：${args?.clipId ?? '片段'} @ 第 ${args?.atBar ?? '?'} 小节`,
          activity: '正在按 tempo 精确分割音频片段',
          undoLabel: '分割音频片段',
        }),
        (draft, args) => ops.splitAudioClip(draft, args),
      ),
    }),
    /* ── R2c：多 take 激活（comping） ─────────────────────────────── */
    defineTool({
      name: 'studio_set_take_active',
      description:
        '激活指定 take（R2c）：两种模式——' +
        '1) 只传 clipId：只激活该音频片段（不取消其他 active，便于 comping 多段共存）；' +
        '2) 传 takeGroup + takeIndex（可选 trackId 过滤）：同组内该 takeIndex 的片段全部 active=true，' +
        '同组其余片段 active=false。一次 mutate/一次撤销；返回 {takeGroup,takeIndex?,activeClipIds,deactivatedClipIds}。' +
        '不存在/参数冲突（clipId 与 takeIndex 同时给等）返回中文错误。',
      parameters: {
        takeGroup: { type: 'string', description: 'take 组名（1..64 安全字符：字母/数字/_/-）；clipId 模式可省略' },
        takeIndex: { type: 'integer', description: '要激活的 take 序号 0..99（模式 2 必填；与 clipId 互斥）' },
        clipId: { type: 'string', description: '只激活该音频片段（与 takeIndex 互斥）' },
        trackId: { type: 'string', description: '可选：只在该轨道的片段中激活/取消（模式 2）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_set_take_active',
          text: `切换 take：${args?.takeGroup ?? args?.clipId ?? ''}`,
          activity: '正在切换 take（comping）',
          undoLabel: '切换 take',
        }),
        (draft, args) => ops.setTakeActive(draft, args),
      ),
    }),
    /* ── R3a：乐理 / 和弦 / 琶音 / Groove ─────────────────────────── */
    defineTool({
      name: 'studio_get_theory',
      description:
        '读取乐理信息（R3a，只读）：返回 key/scale、一个八度音阶音高、7 个自然音级和弦（罗马数字/名称/性质/音高），' +
        '以及建议和弦进行（I-V-vi-IV、ii-V-I、50s、Andalusian）。key/scale 省略时用当前工程设置。' +
        '用于写和弦/生成琶音前确认调性与级数；不修改工程/不占撤销步。',
      parameters: {
        key: { type: 'string', description: '可选：调性主音（如 C / F# / Bb），省略用工程 key' },
        scale: { type: 'string', enum: ['major', 'minor', 'dorian', 'phrygian', 'harmonicMinor'], description: '可选：调式，省略用工程 scale' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          return ok(ops.getTheory(state.project, args ?? {}))
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_write_chords',
      description:
        '按和弦进行向 pattern 写入和弦（R3a，一次 mutate/一次撤销）：progression 为罗马数字数组（如 ["I","V","vi","IV"]，' +
        '支持 bIII/V7/ii° 等）或 [{roman?|rootPitch?, quality?}]；每个和弦的 pitches 同时落在 startBeat + i*beatsPerChord，' +
        'dur=beatsPerChord*0.95。默认追加，replaceExisting=true 整体替换 pattern 音符；返回 {chords,noteCount}。' +
        '不修改轨道/音色；pitch 夹紧 0..127；pattern 必须存在。',
      parameters: {
        patternId: { type: 'string', required: true, description: '目标 pattern id' },
        progression: {
          type: 'array',
          required: true,
          description: '和弦进行：罗马数字字符串数组（如 ["I","V","vi","IV"]），或 [{roman?,quality?,rootPitch?}] 对象数组',
        },
        startBeat: { type: 'number', description: '第一个和弦起始 beat（默认 0）' },
        beatsPerChord: { type: 'number', description: '每个和弦占几 beat（默认 4）' },
        octave: { type: 'integer', description: '和弦根音八度（默认 4；MIDI C4=60）' },
        velocity: { type: 'number', description: '力度 0..1（默认 0.8）' },
        voicing: { type: 'string', enum: ['close', 'open'], description: '排列方式（默认 close）' },
        inversion: { type: 'integer', description: '转位 0..4（默认 0）' },
        replaceExisting: { type: 'boolean', description: 'true=替换 pattern 现有音符（默认 false 追加）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_write_chords',
          text: `写入和弦：${Array.isArray(args?.progression) ? args.progression.length : 0} 个和弦`,
          activity: '正在按和弦进行写作',
          undoLabel: '写和弦',
        }),
        (draft, args) => ops.writeChords(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_generate_arp',
      description:
        '生成琶音写入 pattern（R3a，一次 mutate/一次撤销）：从 chordPitches（MIDI 数组）或 progression（罗马数字/和弦对象，按进行分段时间）' +
        '生成 pattern=up/down/updown/random 的琶音；rate 为步长 beat，beats 总长，octaves 1..4，gate/velocity 控制时值与力度，' +
        'seed 保证 random 确定性。默认追加，replaceExisting=true 替换；返回 {noteCount,pattern}。',
      parameters: {
        patternId: { type: 'string', required: true, description: '目标 pattern id' },
        chordPitches: { type: 'array', items: { type: 'number' }, description: '和弦 MIDI 音高数组（与 progression 二选一）' },
        progression: {
          type: 'array',
          description: '可选：和弦进行（罗马数字字符串或 {roman?,quality?,rootPitch?} 对象数组），按 beats 均分逐和弦琶音',
        },
        pattern: { type: 'string', enum: ['up', 'down', 'updown', 'random'], description: '琶音方向（默认 up）' },
        rate: { type: 'number', description: '步长 beat（默认 0.25=16 分音符）' },
        beats: { type: 'number', description: '总长度 beat（默认 4）' },
        octaves: { type: 'integer', description: '八度层数 1..4（默认 1）' },
        gate: { type: 'number', description: '音符时值比例 0.05..1（默认 0.9）' },
        velocity: { type: 'number', description: '力度 0..1（默认 0.75）' },
        seed: { type: 'integer', description: '随机种子（默认 1；random 模式确定性）' },
        replaceExisting: { type: 'boolean', description: 'true=替换 pattern 现有音符（默认 false 追加）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_generate_arp',
          text: `生成琶音：${args?.pattern ?? 'up'}`,
          activity: '正在生成琶音',
          undoLabel: '生成琶音',
        }),
        (draft, args) => ops.generateArp(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_apply_groove',
      description:
        '对 pattern 应用 Groove/量化（R3a，一次 mutate/一次撤销）：template 可选 straight/swing55/swing60/shuffle/mpc54/mpc58；' +
        'strength 0..1 控制 timing 偏移比例（最多 ±1/6 beat，不改 pitch/dur/vel）；quantizeGrid 可选（先量化到网格再加 groove）。' +
        '返回 {notes,changed}；straight 幂等（changed=false）。',
      parameters: {
        patternId: { type: 'string', required: true, description: '目标 pattern id' },
        template: { type: 'string', enum: ['straight', 'swing55', 'swing60', 'shuffle', 'mpc54', 'mpc58'], description: 'Groove 模板' },
        strength: { type: 'number', description: '强度 0..1（默认 1）' },
        quantizeGrid: { type: 'number', description: '可选：先量化到该网格（beat，如 0.25=16 分音符）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_apply_groove',
          text: `应用 Groove：${args?.template ?? 'straight'}`,
          activity: '正在应用 Groove',
          undoLabel: '应用 Groove',
        }),
        (draft, args) => ops.applyGrooveOp(draft, args),
      ),
    }),
    /* ── R3c：MIDI Learn 外部控制器映射 ───────────────────────────── */
    defineTool({
      name: 'studio_set_midi_mapping',
      description:
        '新增/更新一条 MIDI Learn 映射（R3c，一次 mutate/一次撤销，最多 16 条）：' +
        '把外部控制器的 CC（0..127，可选 channel 0..15/null）映射到 target=volume/pan/sendReverb/sendDelay/effectParam；' +
        'trackId 必须存在；effectParam 需 effectId（该轨效果器链中）+ param（该效果器类型支持的参数）；min/max 0..1 且 min<max。' +
        '同 id 或同 cc+channel 时更新，否则新增（自动 map_n id）。返回 {mapping,count}。',
      parameters: {
        cc: { type: 'integer', required: true, description: 'MIDI CC 编号 0..127' },
        channel: { type: 'integer', description: '可选 MIDI 通道 0..15（省略/null=任意通道）' },
        target: { type: 'string', required: true, enum: ['volume', 'pan', 'sendReverb', 'sendDelay', 'effectParam'], description: '映射目标' },
        trackId: { type: 'string', required: true, description: '目标轨道 id' },
        effectId: { type: 'string', description: 'target=effectParam 时必须：效果器 id（该轨链中）' },
        param: { type: 'string', description: 'target=effectParam 时必须：参数 id（该效果器类型支持）' },
        min: { type: 'number', description: '值域下限 0..1（默认 0）' },
        max: { type: 'number', description: '值域上限 0..1（默认 1，需 > min）' },
        id: { type: 'string', description: '可选：更新已有映射 id（map_n）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_set_midi_mapping',
          text: `设置 MIDI 映射：CC${args?.cc ?? '?'} → ${args?.target ?? '?'}`,
          activity: '正在设置 MIDI Learn 映射',
          undoLabel: '设置 MIDI 映射',
        }),
        (draft, args) => ops.setMidiMapping(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_clear_midi_mapping',
      description:
        '清除一条/多条 MIDI Learn 映射（R3c，一次 mutate/一次撤销，幂等）：按 id 删除单条，或按 cc（可选 channel）删除匹配的映射；' +
        '没有匹配时 cleared=false 不报错。返回 {cleared,removed}。',
      parameters: {
        id: { type: 'string', description: '要删除的映射 id（map_n）' },
        cc: { type: 'integer', description: '按 CC 删除（0..127；与 channel 一起可精确匹配）' },
        channel: { type: 'integer', description: '可选：限定 CC 的 MIDI 通道 0..15' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_clear_midi_mapping',
          text: '清除 MIDI 映射：' + (args?.id ?? ('CC' + (args?.cc ?? '?'))),
          activity: '正在清除 MIDI Learn 映射',
          undoLabel: '清除 MIDI 映射',
        }),
        (draft, args) => ops.clearMidiMapping(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_list_midi_mappings',
      description:
        '列出当前工程全部 MIDI Learn 映射（R3c，只读）：返回 {midiMappings:[{id,cc,channel,target,trackId,effectId?,param?,min,max}],count}；不修改工程/不占撤销步。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          return ok(ops.listMidiMappings(state.project))
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── R4a：Group bus / 轨道输出路由 ───────────────────────────── */
    defineTool({
      name: 'studio_add_group',
      description:
        '新增一个编组 bus（R4a，一次 mutate/一次撤销，最多 8 个）：默认 level 0.8、无 FX、output=master、非 mute/solo；' +
        'name 可选（1..40 字符，默认 Group N）。返回 {groupId,group,count}。用 studio_set_track_output 把轨道送入该组，' +
        '用 effect 工具 target="group"+groupId 编辑组 FX。',
      parameters: {
        name: { type: 'string', description: '组名（1..40 字符，省略为 Group N）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_add_group',
          text: `添加编组：${args?.name ?? ''}`,
          activity: '正在添加编组 bus',
          undoLabel: '添加编组',
        }),
        (draft, args) => ops.addGroup(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_update_group',
      description:
        '更新编组 bus（R4a/R4b，一次 mutate/一次撤销）：修改 name（1..40）/level（0..1）/mute/solo/bypassFx/pdcMs（0..500ms）；组 FX 用 effect 工具 target="group" + groupId。' +
        '返回 {groupId,group}；不存在中文错误。',
      parameters: {
        groupId: { type: 'string', required: true, description: '编组 id（grp_n）' },
        name: { type: 'string', description: '新组名（1..40 字符）' },
        level: { type: 'number', description: '组电平 0..1（默认 0.8）' },
        mute: { type: 'boolean', description: '是否静音该组' },
        solo: { type: 'boolean', description: '是否独奏该组' },
        bypassFx: { type: 'boolean', description: '旁路整条组 FX 链' },
        pdcMs: { type: 'number', description: '组手动延迟补偿 0..500 毫秒（1 位小数，0 清除）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_update_group',
          text: `更新编组：${args?.groupId ?? ''}`,
          activity: '正在更新编组 bus',
          undoLabel: '更新编组',
        }),
        (draft, args) => ops.updateGroup(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_remove_group',
      description:
        '删除编组 bus（R4a，一次 mutate/一次撤销）：该组作为输出的轨道自动回 master（tracksReset 计数）；组 FX 一并删除。' +
        '返回 {groupId,removed,tracksReset,count}；不存在中文错误。',
      parameters: {
        groupId: { type: 'string', required: true, description: '要删除的编组 id（grp_n）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_remove_group',
          text: `删除编组：${args?.groupId ?? ''}`,
          activity: '正在删除编组 bus',
          undoLabel: '删除编组',
        }),
        (draft, args) => ops.removeGroup(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_set_track_output',
      description:
        '设置轨道输出路由（R4a，一次 mutate/一次撤销）：output 为 "master" 或已存在 groupId（grp_n）；轨道可以是 synth/drum/audio。' +
        '输出到 group 时信号经组 FX/level 后进 master；返回 {trackId,output}。',
      parameters: {
        trackId: { type: 'string', required: true, description: '轨道 id（trk_n）' },
        output: { type: 'string', required: true, description: '"master" 或 group id（grp_n；需已存在）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_set_track_output',
          text: `设置轨道输出：${args?.trackId ?? ''} → ${args?.output ?? 'master'}`,
          activity: '正在设置轨道输出路由',
          undoLabel: '设置轨道输出',
        }),
        (draft, args) => ops.setTrackOutput(draft, args),
      ),
    }),
    /* ── R4c：混音场景快照 ───────────────────────────────────────── */
    defineTool({
      name: 'studio_save_scene',
      description:
        '保存当前混音场景快照（R4c，一次 mutate/一次撤销，最多 8 个）：快照仅含混音字段——' +
        'tracks（volume/pan/mute/solo/sends/sendMode/phaseInvert/mono/bypassFx/pdcMs/output/effects 深拷贝）、' +
        'groups（level/mute/solo/bypassFx/pdcMs/effects）、master（volume/effects）、buses（reverb/delay 的 level/effects）；' +
        '不含音符/编排/自动化。同名场景覆盖（保留 id），否则新增 scene_n。name 1..40 字符。返回 {scene,overwritten,count}。',
      parameters: {
        name: { type: 'string', required: true, description: '场景名（1..40 字符；同名覆盖）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_save_scene',
          text: `保存混音场景：${args?.name ?? ''}`,
          activity: '正在保存混音场景',
          undoLabel: '保存场景',
        }),
        (draft, args) => ops.saveScene(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_list_scenes',
      description:
        '列出当前工程混音场景摘要（R4c，只读）：返回 {scenes:[{id,name,at,trackCount,groupCount}],count}；不含完整 state，不修改工程/不占撤销步。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          return ok(ops.listScenes(state.project))
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_recall_scene',
      description:
        '召回混音场景（R4c，一次 mutate/一次撤销）：按 id 或 name 指定；只恢复仍存在的 track/group id（缺失跳过并计数），' +
        '恢复 tracks/groups/master/buses 的混音字段与 effects 链（深拷贝、参数校验）；不改音符/编排/自动化，不创建/删除轨道或组。' +
        '返回 {sceneId,sceneName,restoredTracks,skippedTracks,restoredGroups,skippedGroups}。',
      parameters: {
        id: { type: 'string', description: '场景 id（scene_n）' },
        name: { type: 'string', description: '场景名（与 id 二选一）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_recall_scene',
          text: `召回混音场景：${args?.id ?? args?.name ?? ''}`,
          activity: '正在召回混音场景',
          undoLabel: '召回场景',
        }),
        (draft, args) => ops.recallScene(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_delete_scene',
      description:
        '删除混音场景（R4c，一次 mutate/一次撤销）：按 id 或 name 指定；返回 {deleted,sceneId,sceneName,count}；不存在中文错误。',
      parameters: {
        id: { type: 'string', description: '场景 id（scene_n）' },
        name: { type: 'string', description: '场景名（与 id 二选一）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_delete_scene',
          text: `删除混音场景：${args?.id ?? args?.name ?? ''}`,
          activity: '正在删除混音场景',
          undoLabel: '删除场景',
        }),
        (draft, args) => ops.deleteScene(draft, args),
      ),
    }),
    /* ── R5b：采样器乐器参数 ─────────────────────────────────────── */
    defineTool({
      name: 'studio_update_instrument',
      description:
        '更新采样乐器轨的内置采样器参数（R5b，仅 kind="synth"，一次 mutate/一次撤销）：params 合并更新 attack（0.001..2s）/release（0.01..4s）/' +
        'filterCutoff（100..20000Hz）/filterQ（0.1..12）/lfoRate（0.1..12Hz）/lfoDepth（0..100 cents）；reset:true 清除全部回默认。' +
        '范围外返回中文错误；全部为默认值时省略 instrumentParams 字段。返回 {trackId,instrumentParams,reset}；鼓轨/音频轨拒绝。',
      parameters: {
        trackId: { type: 'string', required: true, description: '采样乐器轨道 id（kind="synth"）' },
        params: {
          type: 'object',
          additionalProperties: true,
          description: '要合并更新的参数（attack/release/filterCutoff/filterQ/lfoRate/lfoDepth；未知键报错）',
        },
        reset: { type: 'boolean', description: 'true 时清除全部乐器参数回默认（与 params 二选一）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_update_instrument',
          text: `更新乐器参数：${args?.trackId ?? ''}`,
          activity: '正在调整采样器参数',
          undoLabel: '更新乐器参数',
        }),
        (draft, args) => ops.updateInstrument(draft, args),
      ),
    }),
    /* ── R5c：工程模板 / 插件 SDK 清单 ──────────────────────────── */
    defineTool({
      name: 'studio_list_templates',
      description:
        '列出工程模板（R5c，只读）：返回 {templates:[{id,name,desc,bpm,key,scale,lengthBars,trackCount,tracks}],count}；' +
        '可用模板：empty/demo/electronic/piano/song；不修改工程/不占撤销步。用 studio_create_project 的 template 参数创建。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          return ok(ops.listTemplates())
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_list_plugins',
      description:
        '列出插件 SDK 清单（R5c，只读）：返回 {sdkVersion,plugins,count}；每项 {id,name,kind:instrument|effect,category,params:[{key,label,min,max,default,unit,step}],stateVersion}。' +
        'type 可选 instrument/effect 过滤；参数 schema 来自真实 catalog（32 乐器 / 15 效果器）。',
      parameters: {
        type: { type: 'string', enum: ['instrument', 'effect'], description: '可选：只列某类插件' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          return ok(ops.listPluginsOp(args ?? {}))
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── R5d：内置 subtractive 合成器 ─────────────────────────────── */
    defineTool({
      name: 'studio_update_synth',
      description:
        '更新 subtractive 合成器轨（R5d，一次 mutate/一次撤销，仅 track.engine="subtractive"）：' +
        'synthPreset 切换音色（sub_bass/saw_lead/square_lead/supersaw/warm_pad/pluck/acid_bass/sine_keys）；' +
        'params 合并覆盖参数（wave/unison/detuneCents/subLevel/filterCutoff/filterQ/attack/decay/sustain/release/lfoRate/lfoDepth/level；越界夹紧）；' +
        'reset:true 清除覆盖回 preset 默认。返回 {trackId,synthPreset,synthParams,reset}。',
      parameters: {
        trackId: { type: 'string', required: true, description: 'subtractive 合成器轨 id' },
        synthPreset: { type: 'string', enum: SYNTH_INSTRUMENTS.map((item) => item.id), description: '切换合成器音色 id' },
        params: { type: 'object', additionalProperties: true, description: '要合并覆盖的合成器参数（未知键报错；数值夹紧）' },
        reset: { type: 'boolean', description: 'true 时清除 synthParams 覆盖（保留 synthPreset）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_update_synth',
          text: `更新合成器音色：${args?.trackId ?? ''}`,
          activity: '正在调整合成器音色',
          undoLabel: '更新合成器音色',
        }),
        (draft, args) => ops.updateSynth(draft, args),
      ),
    }),
    /* ── R6a：AI 生成器 + 混音 assistant ─────────────────────────── */
    defineTool({
      name: 'studio_generate_part',
      description:
        '用确定性算法生成一个声部并写入 pattern（R6a，一次 mutate/一次撤销）：kind=drums/bass/chords/lead/arp；' +
        'style=house/techno/lofi/pop/cinematic；同参数（含 seed）完全可复现。trackId 指定轨道（drums 需鼓轨，其它需 synth 轨）；' +
        'patternId 省略时新建 pattern，否则写入现有 pattern（bars 不能超过 pattern 长度）；replaceExisting=false 时追加。' +
        '返回 {patternId,trackId,summary,noteCount}；drums 使用 GM 36/38/39/42/46。',
      parameters: {
        trackId: { type: 'string', required: true, description: '目标轨道 id（drums 需鼓轨；其它需 synth 轨）' },
        patternId: { type: 'string', description: '可选：写入现有 pattern（省略则新建）' },
        kind: { type: 'string', required: true, enum: ['drums', 'bass', 'chords', 'lead', 'arp'], description: '声部类型' },
        style: { type: 'string', enum: ['house', 'techno', 'lofi', 'pop', 'cinematic'], description: '风格（默认 house）' },
        bars: { type: 'integer', description: '小节数 1..64（默认 4）' },
        seed: { type: 'integer', description: '随机种子（同 seed 完全一致，默认 1）' },
        density: { type: 'number', description: '密度 0..1（默认 0.7）' },
        complexity: { type: 'number', description: '复杂度 0..1（默认 0.5）' },
        octave: { type: 'integer', description: '八度 0..8（默认按 kind）' },
        key: { type: 'string', description: '可选：覆盖工程调性（如 C / F#）' },
        scale: { type: 'string', enum: ['major', 'minor', 'dorian', 'phrygian', 'harmonicMinor'], description: '可选：覆盖工程调式' },
        replaceExisting: { type: 'boolean', description: '现有 pattern 时 true 替换（默认）/false 追加' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_generate_part',
          text: `生成声部：${args?.kind ?? ''} · ${args?.style ?? 'house'}`,
          activity: '正在生成声部',
          undoLabel: '生成声部',
        }),
        (draft, args) => ops.generatePartOp(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_generate_variation',
      description:
        '对现有 pattern 生成确定性变体（R6a，一次 mutate/一次撤销）：seed/density/transpose/humanize 控制加删音、移调、力度与微时序抖动、偶发八度跳变；' +
        '不越出原音符时间范围/0..127。replaceExisting=true（默认）替换，false 追加。返回 {patternId,noteCount,summary}。',
      parameters: {
        patternId: { type: 'string', required: true, description: '目标 pattern id' },
        seed: { type: 'integer', description: '变体种子（默认 1）' },
        density: { type: 'number', description: '保留概率 0..2（默认 0.8）' },
        transpose: { type: 'integer', description: '整体移调 -24..24（默认 0）' },
        humanize: { type: 'number', description: '人性化 0..1（默认 0.1）' },
        replaceExisting: { type: 'boolean', description: 'true 替换（默认）/false 追加' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_generate_variation',
          text: `生成变体：${args?.patternId ?? ''}`,
          activity: '正在生成变体',
          undoLabel: '生成变体',
        }),
        (draft, args) => ops.generateVariationOp(draft, args),
      ),
    }),
    defineTool({
      name: 'studio_suggest_mix',
      description:
        '只读混音建议（R6a）：输入最近 studio_render_preview 的 analysis（lufs/peak/clipping/stereoBalanceDb/bandEnergyPct/stems），' +
        '无 analysis 时用工程静态值；输出 {score,summary,recommendations:[{code,severity,target,trackId?,param,current,suggested,reason}]}；' +
        '不修改工程/不占撤销步。用 studio_apply_mix 应用建议。',
      parameters: {
        analysis: { type: 'object', additionalProperties: true, description: '可选：studio_render_preview 返回的 analysis（真实电平指标）' },
        targetLufs: { type: 'number', description: '目标响度 LUFS（-24..-5，默认 -14）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          return ok(ops.suggestMixOp(state.project, args ?? {}))
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_apply_mix',
      description:
        '应用混音建议（R6a，一次 mutate/一次撤销）：按 analysis/静态检测出的建议安全调整 track/master volume、pan、sends、已存在的 filter cutoff；' +
        'codes 可限定只应用某些建议 code；不做不可逆破坏。返回 {applied,changes,score,summary}。',
      parameters: {
        analysis: { type: 'object', additionalProperties: true, description: '可选：studio_render_preview 的 analysis' },
        targetLufs: { type: 'number', description: '目标响度 LUFS（-24..-5，默认 -14）' },
        codes: { type: 'array', description: '可选：只应用这些建议 code（字符串数组）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const conflict = revisionConflict(args)
          if (conflict !== null) return conflict
          const result = state.mutate(
            { tool: 'studio_apply_mix', text: '应用混音建议', activity: '正在应用混音建议', undoLabel: '应用混音建议' },
            (draft) => ops.applyMixOp(draft, args),
          )
          // v2.1：apply_mix 调整了 volume 自动化时，activity 写明确 warning（writeTool 的固定 activity 会覆盖 mutator 内设置）。
          if (result?.automationAdjusted) {
            const count = Array.isArray(result.warnings) ? result.warnings.length : 1
            state.mutate(
              { tool: 'studio_apply_mix', text: null, activity: `应用混音建议：${count} 项 volume 自动化曲线已按比例缩放` },
              () => {},
            )
          }
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── R6b：一键生成可用 beat ──────────────────────────────────── */
    defineTool({
      name: 'studio_generate_beat',
      description:
        '一键生成可播放的 beat（R6b，一次 mutate/一次撤销）：空工程从 0 小节创建，非空工程从当前曲长末追加，不覆盖已有 notes。' +
        '创建 4 轨（鼓组 smp_electro、贝斯 subtractive sub_bass、和弦 warm_pad、主音 saw_lead）+ 4 个 bars 小节 pattern + 4 个 clip + 1 个 section（默认「AI Beat」）；' +
        '空工程套用 style 默认 BPM/key/scale，追加时仅在显式传参时覆盖工程设置。返回 {trackIds,patternIds,clipCount,section,summary:{style,bars,seed,totalNotes,notesByTrack},bpm,key,scale}。',
      parameters: {
        style: { type: 'string', enum: ['house', 'techno', 'lofi', 'pop', 'cinematic'], description: '风格（默认 house）' },
        bars: { type: 'integer', description: '小节数 4..16（默认 8）' },
        seed: { type: 'integer', description: '随机种子（同 seed 完全可复现，默认 1）' },
        bpm: { type: 'number', description: '速度 60..180（默认按风格）' },
        key: { type: 'string', description: '调性主音（如 C / F#，默认按风格）' },
        scale: { type: 'string', enum: ['major', 'minor', 'dorian', 'phrygian', 'harmonicMinor'], description: '调式（默认按风格）' },
        sectionName: { type: 'string', description: '段落名（默认 AI Beat，1..40 字符）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: writeTool(
        (args) => ({
          tool: 'studio_generate_beat',
          text: `生成 beat：${args?.style ?? 'house'} · ${args?.bars ?? 8} 小节`,
          activity: '正在生成完整 beat',
          undoLabel: '生成 beat',
        }),
        (draft, args) => ops.generateBeatOp(draft, args),
      ),
    }),
    /* ── R6c：AI 变更日志 ────────────────────────────────────────── */
    defineTool({
      name: 'studio_get_ai_changes',
      description:
        '读取最近 AI 变更日志（R6c，只读）：返回 {changes:[{id,at,tool,title,beforeRev,afterRev,diff,canUndo,canRedo}],canUndo,canRedo,undoLabel,redoLabel}；' +
        'diff 含 tracks/patterns 增删改、clips/sections 差值、bpm/lengthBars 前后、notesDelta、trackNames、patternDeltas；limit 默认 30。' +
        '不修改工程/不占撤销步。',
      parameters: {
        limit: { type: 'integer', description: '最多返回条数（1..30，默认 30）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const history = typeof state.historyState === 'function' ? state.historyState() : {}
          const rawLimit = Number(args?.limit)
          const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 30) : 30
          return ok({
            changes: state.aiJournal?.list({ limit, currentRevision: state.revision }) ?? [],
            canUndo: Boolean(history.canUndo),
            canRedo: Boolean(history.canRedo),
            undoLabel: history.undoLabel ?? '',
            redoLabel: history.redoLabel ?? '',
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── R6d：参考曲风格分析 + 按参考生成 ────────────────────────── */
    defineTool({
      name: 'studio_analyze_reference',
      description:
        '分析参考工程（R6d，只读）：name 省略时分析当前工程，否则只读 data/projects/<name>.json（不打开工程、不改 revision）。' +
        '返回 profile：{source,title,bpm,key,scale,lengthBars,sections,tracks:[{role,kind,engine,preset,synthPreset,noteCount,notesPerBar}],' +
        'avgNotesPerBar,drumPitches,effectTypes,sendsAvg,summary}；未知/损坏工程中文错误。',
      parameters: {
        name: { type: 'string', description: '可选：已保存工程名；省略=分析当前工程' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const name = typeof args?.name === 'string' ? args.name.trim() : ''
          if (name !== '') {
            const loaded = await loadReferenceProfile(state.dataDir, name)
            return ok(loaded.profile)
          }
          return ok(analyzeProjectProfile(state.project, { source: 'current', title: state.project?.title ?? '当前工程' }))
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_generate_like_reference',
      description:
        '按参考 profile 生成 beat（R6d，一次 mutate/一次撤销）：reference 指定已保存工程名，省略则用当前工程（当前工程为空且未给 reference 时中文错误）；' +
        '沿用参考 BPM/key/scale、角色/preset（无则默认 sub_bass/warm_pad/saw_lead）、密度与 GM 鼓音高，生成 4 轨 + 4 pattern + 4 clip + 1 section（默认「参考生成」）。' +
        '空工程从 0 开始；非空/append 从曲长末追加（append=false 时从 0 叠加）。返回 {profileSummary,trackIds,patterns,clipCount,section,bpm,key,scale,seed,totalNotes}。',
      parameters: {
        reference: { type: 'string', description: '可选：参考工程名（省略=当前工程）' },
        bars: { type: 'integer', description: '小节数 4..16（默认 8）' },
        seed: { type: 'integer', description: '随机种子（默认 1，同 seed 可复现）' },
        append: { type: 'boolean', description: '非空工程是否追加到曲末（默认 true）' },
        sectionName: { type: 'string', description: '段落名（默认 参考生成）' },
        expectedRevision: { type: 'number', description: '可选：期望的当前 revision（并发冲突时不写入）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const conflict = revisionConflict(args)
          if (conflict !== null) return conflict
          const referenceName = typeof args?.reference === 'string' ? args.reference.trim() : ''
          let profile
          if (referenceName !== '') {
            profile = (await loadReferenceProfile(state.dataDir, referenceName)).profile
          } else {
            if (state.project.tracks.length === 0) {
              return toFailure(new Error('当前工程为空，无法作为参考；请先 studio_analyze_reference 指定已保存工程（reference）或先创建/生成内容'))
            }
            profile = analyzeProjectProfile(state.project, { source: 'current', title: state.project?.title ?? '当前工程' })
          }
          const meta = {
            tool: 'studio_generate_like_reference',
            text: `按参考生成：${referenceName || profile.title || '当前工程'}`,
            activity: '正在按参考生成 beat',
            undoLabel: '按参考生成',
          }
          const result = state.mutate(meta, (draft) => ops.generateLikeReferenceOp(draft, args ?? {}, profile))
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── R6e：AI 音频级质量报告 ─────────────────────────────────── */
    defineTool({
      name: 'studio_ai_quality_report',
      description:
        'AI 音频级质量报告（R6e，只读）：输入最近 studio_render_preview 的 analysis（lufs/lufsMaxShortTerm/peakDb/crestDb/stereoBalanceDb/' +
        'correlation/bandEnergyPct/clipping/clippedSamples/rms/rmsDb），返回 {score,grade,metrics,findings,recommendations,summary}；' +
        '评分权重：响度 25/峰值削波 20/crest 15/立体声 15/频段 15/削波样本 10；不写工程、不改 revision。缺 lufs/peakDb 中文错误。',
      parameters: {
        analysis: { type: 'object', additionalProperties: true, required: true, description: 'studio_render_preview 返回的 analysis 对象' },
        targetLufs: { type: 'number', description: '目标响度 LUFS（-24..-5，默认 -14）' },
        genre: { type: 'string', description: '风格标签（仅用于报告文案，默认 electronic）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const report = evaluateAudioAnalysis(args?.analysis, { targetLufs: args?.targetLufs, genre: args?.genre })
          return ok(report)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── R7b：设置 / 更新检查 / 诊断 ─────────────────────────────── */
    defineTool({
      name: 'studio_get_settings',
      description:
        '读取产品设置（R7b，只读）：返回 {settings:{channel,telemetryOptIn,crashReports,language}}；' +
        '默认 channel=stable、telemetryOptIn=false、crashReports=true、language=zh-CN；不写工程、不改 revision。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const settings = await loadSettings(state.dataDir)
          return ok({ settings })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_update_settings',
      description:
        '更新产品设置（R7b）：可传 channel(stable|beta)、telemetryOptIn(boolean)、crashReports(boolean)、language(zh-CN|en-US)，只写入 data/settings.json（原子写）；' +
        '未知字段/非法值中文错误；不产生工程 undo、不改变 revision。返回 {settings,changed}。',
      parameters: {
        channel: { type: 'string', enum: ['stable', 'beta'], description: '更新通道' },
        telemetryOptIn: { type: 'boolean', description: '遥测 opt-in（默认 false；本机记录，不上传）' },
        crashReports: { type: 'boolean', description: '是否记录崩溃报告（本机）' },
        language: { type: 'string', enum: ['zh-CN', 'en-US'], description: '界面语言（持久化）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const patch = args && typeof args === 'object' ? args : {}
          const settings = await saveSettings(state.dataDir, patch)
          return ok({ settings, changed: Object.keys(patch) })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_check_update',
      description:
        '检查更新（R7b，只读，无网络请求）：读取本地 data/update-manifest.json（或 env AIMS_UPDATE_MANIFEST），按 semantic version 比较当前版本；' +
        '返回 {status:"update-available"|"up-to-date"|"no-source", current:{version,commit,channel}, available?:{version,buildDate,notes,url}, notes?,url?,checkedAt}；' +
        '无源返回 no-source，损坏 manifest 中文错误。',
      parameters: {
        channel: { type: 'string', enum: ['stable', 'beta'], description: '可选：检查通道（默认读设置 channel）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const settings = await loadSettings(state.dataDir)
          const channel = typeof args?.channel === 'string' ? args.channel : settings.channel
          if (!UPDATE_CHANNELS.includes(channel)) {
            return toFailure(new Error(`channel 必须是 ${UPDATE_CHANNELS.join(' / ')}，收到「${String(channel)}」`))
          }
          const result = await checkForUpdate({ dataDir: state.dataDir, channel })
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_get_diagnostics',
      description:
        '读取本机诊断信息（R7b，只读）：返回版本/构建/设置/最近崩溃摘要/工程规模（轨道/pattern/clip/音符）/内存/Runtime/数据目录（默认脱敏），' +
        '以及可复制的 text 诊断文本；不写工程、不上传。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const diagnostics = await collectDiagnostics({ dataDir: state.dataDir, state })
          return ok({ ...diagnostics, text: exportDiagnosticsText(diagnostics) })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── v2.2 M1：外部 VST3 插件管理 ─────────────────────────────── */
    defineTool({
      name: 'studio_scan_plugins',
      description:
        '扫描本机 VST3 插件（写 registry，只读工程）：dirs 可选自定义目录，includeDefaults 默认 true（平台默认 VST3 目录 + AIMS_VST3_DIRS/AIMS_VST3_TEST_PLUGIN 目录）。' +
        '返回 {scanned,inspected,added,count,plugins,errors}；需要桌面版 Node sidecar，未启用时中文错误。',
      parameters: {
        dirs: { type: 'array', description: '自定义扫描目录（可选）' },
        includeDefaults: { type: 'boolean', description: '是否扫描平台默认 VST3 目录（默认 true）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const service = getPluginService()
          const result = await service.scan({ dirs: Array.isArray(args?.dirs) ? args.dirs : [], includeDefaults: args?.includeDefaults !== false })
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_install_plugin',
      description:
        '导入 VST3 插件（.vst3 文件或目录，一次 mutate 仅写 registry/托管副本）：复制到 dataDir/plugins 托管目录并 inspect；同 classId 去重更新。返回 {plugin:{pluginId,name,...}}。',
      parameters: {
        path: { type: 'string', required: true, description: '本机 .vst3 文件/目录路径' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const result = await getPluginService().install({ path: args?.path })
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_list_external_plugins',
      description: '列出已扫描/已导入的外部 VST3 插件（读 registry；missing 表示托管副本/路径已不可用）。返回 {plugins,count}。',
      parameters: {},
      output: OUTPUT,
      execute: async () => {
        try {
          await state.ensureReady()
          const result = await getPluginService().list()
          return ok({ plugins: result.plugins, count: result.plugins.length })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_get_plugin_parameters',
      description:
        '读取外部 VST3 插件参数（Node sidecar getParameterCount()+getParameterInfo(i)；M1 只读/试写，不接实时音频）：返回 {pluginId,count,params:[{index,id,name,label,unit,min,max,default,value,formatted?}]}。',
      parameters: {
        pluginId: { type: 'string', required: true, description: '插件 id（来自 list/install/scan）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const result = await getPluginService().parameters(String(args?.pluginId ?? ''))
          return ok(result)
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_add_plugin_track',
      description:
        '新建 VST3 乐器轨（M1 仅保存工程引用，实时处理 M2）：pluginId 必须为已扫描/导入的 instrument 插件；写入 track.engine="vst3" + track.vst3 描述。返回 {trackId,track}。',
      parameters: {
        pluginId: { type: 'string', required: true, description: 'instrument 插件 id' },
        name: { type: 'string', description: '轨道名（可选）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const service = getPluginService()
          const plugin = await service.getPlugin(String(args?.pluginId ?? ''))
          if (!plugin) return { ok: false, error: `插件不存在：${String(args?.pluginId ?? '')}；请先 scan/install` }
          if (plugin.missing) return { ok: false, error: `插件内容缺失：${plugin.pluginId}；请重新安装后再添加` }
          if (!plugin.isInstrument) return { ok: false, error: `插件 ${plugin.pluginId} 不是 instrument（category=${plugin.category}）` }
          const vst3 = {
            pluginId: plugin.pluginId,
            name: plugin.name,
            vendor: plugin.vendor,
            version: plugin.version,
            category: plugin.category,
            subCategories: plugin.subCategories ?? '',
            classId: plugin.classId,
            kind: plugin.isInstrument ? 'instrument' : 'effect',
            isInstrument: plugin.isInstrument === true,
            midiInputs: 0,
            params: {},
            stateBase64: null,
            bypass: false,
            missing: false,
          }
          const result = state.mutate(
            { tool: 'studio_add_plugin_track', text: `添加 VST3 乐器轨：${plugin.name}`, activity: '正在添加 VST3 乐器轨', undoLabel: '添加 VST3 乐器轨' },
            (draft) => ops.addTrack(draft, { kind: 'synth', engine: 'vst3', vst3, ...(typeof args?.name === 'string' && args.name.trim() !== '' ? { name: args.name.trim() } : {}) }),
          )
          return ok({ trackId: result.trackId, track: result.track })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_add_plugin_effect',
      description:
        '给轨道 FX 链末尾添加 VST3 效果器（M1 仅保存引用，实时处理 M2）：pluginId 必须为已扫描/导入的 effect 插件；只允许轨道 FX（不支持 master/bus/group）。返回 {effectId,chain}。',
      parameters: {
        trackId: { type: 'string', required: true, description: '目标轨道 id' },
        pluginId: { type: 'string', required: true, description: 'effect 插件 id' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const service = getPluginService()
          const plugin = await service.getPlugin(String(args?.pluginId ?? ''))
          if (!plugin) return { ok: false, error: `插件不存在：${String(args?.pluginId ?? '')}；请先 scan/install` }
          if (plugin.missing) return { ok: false, error: `插件内容缺失：${plugin.pluginId}；请重新安装后再添加` }
          if (!plugin.isEffect) return { ok: false, error: `插件 ${plugin.pluginId} 不是 effect（category=${plugin.category}）` }
          const vst3 = {
            pluginId: plugin.pluginId,
            name: plugin.name,
            vendor: plugin.vendor,
            version: plugin.version,
            category: plugin.category,
            subCategories: plugin.subCategories ?? '',
            classId: plugin.classId,
            kind: plugin.isInstrument ? 'instrument' : 'effect',
            isInstrument: plugin.isInstrument === true,
            midiInputs: 0,
            params: {},
            stateBase64: null,
            bypass: false,
            missing: false,
          }
          const result = state.mutate(
            { tool: 'studio_add_plugin_effect', text: `添加 VST3 效果器：${plugin.name}`, activity: '正在添加 VST3 效果器', undoLabel: '添加 VST3 效果器' },
            (draft) => ops.addEffect(draft, { target: String(args?.trackId ?? ''), type: 'vst3', vst3 }),
          )
          return ok({ effectId: result.effectId, trackId: String(args?.trackId ?? ''), chain: result.chain })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_remove_external_plugin',
      description:
        '卸载外部 VST3 插件（只删除托管副本；工程里的引用保留并标记 missing:true，可撤销）。返回 {pluginId,removed,affected}。',
      parameters: {
        pluginId: { type: 'string', required: true, description: '插件 id' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const removed = await getPluginService().uninstall(String(args?.pluginId ?? ''))
          const affected = state.mutate(
            { tool: 'studio_remove_external_plugin', text: `卸载外部插件：${removed.pluginId}`, activity: '正在卸载外部插件', undoLabel: '卸载外部插件' },
            (draft) => ops.markPluginMissing(draft, removed.pluginId, true),
          )
          return ok({ ...removed, affected })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_set_plugin_parameter',
      description:
        '设置外部 VST3 插件参数并写回工程（v2.3 P0）：{trackId|effectId,paramId,value(0..1),pluginId?,mergeKey?}。' +
        'trackId 为 vst3 乐器轨；effectId 用于轨道上的 VST3 效果器（可只给 effectId 自动定位轨道）。写入 track.vst3.params/effect.vst3.params，一次 state.mutate 进 undo（label「调整插件参数」）；同 mergeKey 连续拖动合并为一个 undo 步骤。' +
        '未指定 trackId/effectId 时保留 sidecar-only 旧行为并返回 deprecated:true。',
      parameters: {
        pluginId: { type: 'string', description: '可选：插件 id（校验用；省略则从目标推断）' },
        paramId: { type: 'number', required: true, description: '参数 id（来自 get_plugin_parameters）' },
        value: { type: 'number', required: true, description: '归一化值 0..1（夹紧）' },
        trackId: { type: 'string', description: '可选：VST3 乐器轨 id' },
        effectId: { type: 'string', description: '可选：轨道上的 VST3 效果器 id' },
        mergeKey: { type: 'string', description: '可选：连续拖动合并键（同 key 合并 undo；新手势用新 key）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const hasTarget = (typeof args?.trackId === 'string' && args.trackId.trim() !== '') || (typeof args?.effectId === 'string' && args.effectId.trim() !== '')
          if (!hasTarget) {
            if (typeof args?.pluginId !== 'string' || args.pluginId.trim() === '') {
              return { ok: false, error: '需要 trackId 或 effectId；sidecar-only 旧行为还需 pluginId' }
            }
            const result = await getPluginService().setParameter({ pluginId: String(args.pluginId), paramId: args?.paramId, value: args?.value })
            return ok({ ...result, deprecated: true, hint: '未指定 trackId/effectId：仅写 sidecar，不写工程；请改用 trackId/effectId' })
          }
          const mergeKey = typeof args?.mergeKey === 'string' && args.mergeKey.trim() !== '' ? args.mergeKey.trim() : undefined
          const result = state.mutate(
            { tool: 'studio_set_plugin_parameter', text: `调整插件参数：${String(args?.paramId)}`, activity: '正在同步插件参数到工程', undoLabel: '调整插件参数', mergeKey },
            (draft) => ops.setPluginParameter(draft, args ?? {}),
          )
          try { getPluginService().noteParameterValue({ pluginId: result.pluginId, paramId: result.paramId, value: result.value }) } catch { /* sidecar 不可用不影响写工程 */ }
          return ok({
            ...result,
            param: { paramId: result.paramId, value: result.value },
            revision: state.revision,
            undoLabel: '调整插件参数',
            merged: Boolean(mergeKey),
            deprecated: false,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── v2.3 P1：插件预设/状态 ─────────────────────────────────── */
    defineTool({
      name: 'studio_list_plugin_presets',
      description:
        '列出外部 VST3 插件的 program/preset（sidecar IUnitInfo）：{pluginId?,trackId?,effectId?}。' +
        '可只给 trackId/effectId 自动推断 pluginId，并使用该插件已加载实例（否则加载 legacy 实例）。返回 {pluginId,count,presets:[{listId,listIndex,index,name,programName,listName}],lists,current}。',
      parameters: {
        pluginId: { type: 'string', description: '插件 id（可选：有 trackId/effectId 时可省略）' },
        trackId: { type: 'string', description: '可选：VST3 乐器轨 id' },
        effectId: { type: 'string', description: '可选：VST3 效果器 id' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          let pluginId = typeof args?.pluginId === 'string' ? args.pluginId.trim() : ''
          let target = null
          if (args?.trackId || args?.effectId) {
            target = ops.resolvePluginTarget(state.project, { trackId: args?.trackId, effectId: args?.effectId })
            if (pluginId === '') pluginId = target.pluginId
          }
          if (pluginId === '') return { ok: false, error: 'list_plugin_presets 需要 pluginId 或 trackId/effectId' }
          const service = getPluginService()
          const presets = await service.listPresets({ pluginId, instanceId: target?.instanceId ?? null })
          return ok({
            ...presets,
            current: target?.descriptor?.preset ?? null,
            trackId: target?.trackId ?? null,
            effectId: target?.effectId ?? null,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_select_plugin_preset',
      description:
        '选择外部 VST3 插件 program/preset（v2.3 P1）：{trackId|effectId,listId,index}。' +
        'sidecar selectProgram → 读取 params/state → 写回 vst3.params/preset/stateBase64；一次 state.mutate（undoLabel「选择插件预设」）。返回 {ok,revision,preset,paramCount,hasStateBase64,listId,index}。',
      parameters: {
        trackId: { type: 'string', description: 'VST3 乐器轨 id（与 effectId 二选一）' },
        effectId: { type: 'string', description: 'VST3 效果器 id（可只给 effectId 自动定位轨道）' },
        listId: { type: 'number', required: true, description: 'program list id' },
        index: { type: 'number', required: true, description: 'program index' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const target = ops.resolvePluginTarget(state.project, { trackId: args?.trackId, effectId: args?.effectId })
          const service = getPluginService()
          const selected = await service.selectPreset({
            pluginId: target.pluginId,
            instanceId: target.instanceId,
            listId: args?.listId,
            index: args?.index,
          })
          state.mutate(
            { tool: 'studio_select_plugin_preset', text: `选择插件预设：${selected.preset?.name ?? ''}`, activity: '正在切换插件预设', undoLabel: '选择插件预设' },
            (draft) => ops.applyPluginPreset(draft, {
              trackId: target.trackId,
              effectId: target.effectId,
              preset: selected.preset,
              params: selected.params,
              stateBase64: selected.stateBase64,
            }),
          )
          return ok({
            trackId: target.trackId,
            effectId: target.effectId,
            pluginId: target.pluginId,
            listId: selected.listId,
            index: selected.index,
            preset: selected.preset,
            paramCount: Array.isArray(selected.params) ? selected.params.length : 0,
            hasStateBase64: typeof selected.stateBase64 === 'string' && selected.stateBase64 !== '',
            revision: state.revision,
            undoLabel: '选择插件预设',
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_get_plugin_state',
      description:
        '读取工程中外部 VST3 插件的 state（base64）：{trackId?,effectId?,live?}。live=true 时从已加载插件实例读取当前 live state（不写工程）；默认读工程 stateBase64。返回 {stateBase64,bytes,hasStateBase64,preset,pluginId,instanceKey,source}。',
      parameters: {
        trackId: { type: 'string', description: 'VST3 乐器轨 id' },
        effectId: { type: 'string', description: 'VST3 效果器 id' },
        live: { type: 'boolean', description: 'true=从 live 实例读取当前 state（不写工程）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const target = ops.resolvePluginTarget(state.project, { trackId: args?.trackId, effectId: args?.effectId })
          if (args?.live === true) {
            const live = await getPluginService().savePluginState({ pluginId: target.pluginId, instanceId: target.instanceId })
            const stateBase64 = String(live?.stateBase64 ?? '')
            return ok({ ...ops.getPluginState(state.project, { trackId: args?.trackId, effectId: args?.effectId }), stateBase64, bytes: Buffer.byteLength(stateBase64, 'utf8'), hasStateBase64: stateBase64 !== '', source: 'live' })
          }
          return ok({ ...ops.getPluginState(state.project, { trackId: args?.trackId, effectId: args?.effectId }), source: 'project' })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_set_plugin_state',
      description:
        '写入外部 VST3 插件 state（base64 ≤2MB）：{trackId?,effectId?,stateBase64}。' +
        '写入 vst3.stateBase64；若 sidecar 可用会 loadState 并同步最新 params；一次 state.mutate（undoLabel「载入插件状态」）。实时节点由 engine 按 stateBase64 变化 loadState。',
      parameters: {
        trackId: { type: 'string', description: 'VST3 乐器轨 id' },
        effectId: { type: 'string', description: 'VST3 效果器 id' },
        stateBase64: { type: 'string', required: true, description: '插件 state（base64，≤2MB）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const target = ops.resolvePluginTarget(state.project, { trackId: args?.trackId, effectId: args?.effectId })
          const rawState = typeof args?.stateBase64 === 'string' ? args.stateBase64.trim() : ''
          if (rawState === '') return { ok: false, error: 'stateBase64 不能为空' }
          if (Buffer.byteLength(rawState, 'utf8') > 2 * 1024 * 1024) return { ok: false, error: 'stateBase64 超过 2MB 上限' }
          let loadedParams = null
          const warnings = []
          try {
            const loaded = await getPluginService().loadPluginState({ pluginId: target.pluginId, instanceId: target.instanceId, stateBase64: rawState })
            loadedParams = loaded.params ?? null
          } catch (error) {
            warnings.push(String(error?.message ?? error))
          }
          state.mutate(
            { tool: 'studio_set_plugin_state', text: '载入插件状态', activity: '正在载入插件状态', undoLabel: '载入插件状态' },
            (draft) => ops.applyPluginPreset(draft, { trackId: target.trackId, effectId: target.effectId, stateBase64: rawState, params: loadedParams }),
          )
          return ok({
            trackId: target.trackId,
            effectId: target.effectId,
            pluginId: target.pluginId,
            revision: state.revision,
            bytes: Buffer.byteLength(rawState, 'utf8'),
            paramsSynced: Array.isArray(loadedParams),
            paramsCount: Array.isArray(loadedParams) ? loadedParams.length : 0,
            warnings,
            undoLabel: '载入插件状态',
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── v2.3 P2：插件参数自动化 ─────────────────────────────────── */
    defineTool({
      name: 'studio_set_plugin_automation',
      description:
        '写入/覆盖一条插件参数自动化曲线（v2.3 P2）：{trackId,effectId?,paramId,points:[{beat,value 0..1}],enabled?,mergeKey?}。' +
        '写入 track.pluginAutomation[instanceKey][paramId]；每轨 ≤16 条、每条 ≤256 点；一次 state.mutate（undoLabel「编辑插件自动化」）；同 mergeKey 连续调用合并 undo。返回 {ok,instanceKey,paramId,curve,revision}。',
      parameters: {
        trackId: { type: 'string', required: true, description: 'VST3 乐器轨 id' },
        effectId: { type: 'string', description: '可选：轨道上的 VST3 效果器 id；省略则作用于 track（乐器）实例' },
        paramId: { type: 'number', required: true, description: '参数 id（来自 get_plugin_parameters）' },
        points: { type: 'array', description: '曲线点 [{beat,value}]（beat 绝对 beat，value 0..1；最多 256 点）' },
        enabled: { type: 'boolean', description: '是否启用（默认 true）' },
        mergeKey: { type: 'string', description: '可选：连续拖动画布合并键' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const mergeKey = typeof args?.mergeKey === 'string' && args.mergeKey.trim() !== '' ? args.mergeKey.trim() : undefined
          const result = state.mutate(
            { tool: 'studio_set_plugin_automation', activity: '正在编辑插件参数自动化', undoLabel: '编辑插件自动化', mergeKey },
            (draft) => ops.setPluginAutomation(draft, args ?? {}),
          )
          return ok({ ...result, revision: state.revision, undoLabel: '编辑插件自动化', merged: Boolean(mergeKey) })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_clear_plugin_automation',
      description:
        '清除插件参数自动化（v2.3 P2）：{trackId,effectId?,paramId?}；给 paramId 删一条曲线，省略则清空该实例全部曲线。一次 state.mutate（undoLabel「清除插件自动化」）。返回 {removed,cleared,revision}。',
      parameters: {
        trackId: { type: 'string', required: true, description: 'VST3 乐器轨 id' },
        effectId: { type: 'string', description: '可选：VST3 效果器 id' },
        paramId: { type: 'number', description: '可选：只清一条曲线；省略=清空该实例' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const result = state.mutate(
            { tool: 'studio_clear_plugin_automation', activity: '正在清除插件参数自动化', undoLabel: '清除插件自动化' },
            (draft) => ops.clearPluginAutomation(draft, args ?? {}),
          )
          return ok({ ...result, revision: state.revision, undoLabel: '清除插件自动化' })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_get_plugin_automation',
      description:
        '读取插件参数自动化（v2.3 P2，只读）：{trackId?,effectId?,paramId?}。返回 {instanceKey,curves:{[paramId]:{enabled,points}},count}；不修改工程。',
      parameters: {
        trackId: { type: 'string', description: 'VST3 乐器轨 id' },
        effectId: { type: 'string', description: '可选：VST3 效果器 id' },
        paramId: { type: 'number', description: '可选：只读一条曲线' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          return ok(ops.getPluginAutomation(state.project, { trackId: args?.trackId, effectId: args?.effectId, paramId: args?.paramId }))
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    /* ── v2.2 M4：外部插件冻结 ─────────────────────────────────── */
    defineTool({
      name: 'studio_freeze_plugin_track',
      description:
        '冻结外部 VST3 乐器轨为音频缓存（M4）：Host 离线渲染 track.freeze + project.media，导出/播放走缓存，不再实时跑插件。' +
        'trackId 为 engine="vst3" 乐器轨；传 effectId 可冻结该轨上的 VST3 效果器（VST3 乐器轨可自动生成干声）。missing 插件中文错误。',
      parameters: {
        trackId: { type: 'string', required: true, description: 'VST3 乐器轨 id' },
        effectId: { type: 'string', description: '可选：该轨上的 VST3 效果器 id（效果器冻结）' },
        bars: { type: 'number', description: '冻结小节数（默认工程曲长，1..256）' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const revision = state.revision
          const pluginService = getPluginService()
          const frozen = await freezeTarget({
            dataDir: state.dataDir,
            project: state.project,
            trackId: String(args?.trackId ?? ''),
            effectId: args?.effectId === undefined || args?.effectId === null ? null : String(args.effectId),
            service: pluginService,
            bars: args?.bars,
          })
          if (state.revision !== revision) return { ok: false, error: '工程在冻结期间被修改，请重试', retry: true, currentRevision: state.revision }
          state.mutate(
            { tool: 'studio_freeze_plugin_track', text: `冻结外部插件：${String(args?.trackId ?? '')}`, activity: '正在写入插件冻结缓存', undoLabel: '冻结外部插件' },
            (draft) => setFreezeOnProject(draft, {
              trackId: String(args?.trackId ?? ''),
              freeze: frozen.freeze,
              mediaEntry: frozen.mediaEntry,
              trackStateBase64: frozen.trackStateBase64,
              effectStates: frozen.effectStates,
            }),
          )
          return ok({
            trackId: String(args?.trackId ?? ''),
            effectId: args?.effectId ?? null,
            freeze: ops.freezeSummary(frozen.freeze),
            mediaId: frozen.freeze.mediaId,
            includesFx: frozen.freeze.includesFx === true,
            effectIds: frozen.effectIds ?? [],
            stateSaved: Boolean(frozen.trackStateBase64 || frozen.stateBase64),
            cacheFile: frozen.freeze.cacheFile,
            bars: frozen.freeze.bars,
            frames: frozen.freeze.frames,
            sampleRate: frozen.freeze.sampleRate,
          })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_unfreeze_plugin_track',
      description: '解除外部插件冻结（保留工程/插件引用与 state，仅移除缓存描述与 media）。返回 {removed:boolean}。',
      parameters: {
        trackId: { type: 'string', required: true, description: '轨道 id' },
        effectId: { type: 'string', description: '可选：效果器 id' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          const trackId = String(args?.trackId ?? '')
          const effectId = args?.effectId === undefined || args?.effectId === null ? null : String(args.effectId)
          const track = state.project.tracks.find((item) => item.id === trackId)
          if (!track) return { ok: false, error: `轨道不存在：${trackId}` }
          const target = effectId === null ? track : (track.effects ?? []).find((fx) => fx.id === effectId && fx.type === 'vst3')
          if (!target) return { ok: false, error: `找不到 VST3 效果器：${effectId}` }
          const freeze = target.freeze
          if (!freeze) return ok({ trackId, effectId, removed: false })
          state.mutate(
            { tool: 'studio_unfreeze_plugin_track', text: `解冻外部插件：${trackId}`, activity: '正在解除插件冻结', undoLabel: '解冻外部插件' },
            (draft) => {
              const draftTrack = draft.tracks.find((item) => item.id === trackId)
              const draftTarget = effectId === null ? draftTrack : (draftTrack.effects ?? []).find((fx) => fx.id === effectId && fx.type === 'vst3')
              if (draftTarget) delete draftTarget.freeze
              if (freeze.mediaId && Array.isArray(draft.media)) draft.media = draft.media.filter((item) => item.id !== freeze.mediaId)
            },
          )
          if (freeze.cacheFile) await rm(path.join(state.dataDir, 'plugin-cache', path.basename(freeze.cacheFile)), { force: true }).catch(() => {})
          if (freeze.hash) await rm(path.join(state.dataDir, 'media', `freeze-${freeze.hash}.wav`), { force: true }).catch(() => {})
          return ok({ trackId, effectId, removed: true })
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
    defineTool({
      name: 'studio_get_freeze_status',
      description:
        '读取外部插件冻结状态（只读）：无参返回所有 vst3 轨/效果器 {status:unfrozen|current|stale|missing|error,frozen,hash,currentHash,mediaId,cacheFile,missing}；' +
        '可选 trackId/effectId 过滤。stale 表示工程/参数/state/FX 已变化，需要重新冻结。',
      parameters: {
        trackId: { type: 'string', description: '可选：轨道 id' },
        effectId: { type: 'string', description: '可选：效果器 id' },
      },
      output: OUTPUT,
      execute: async (args) => {
        try {
          await state.ensureReady()
          return ok(getFreezeStatus(state.project, {
            trackId: typeof args?.trackId === 'string' ? args.trackId : null,
            effectId: typeof args?.effectId === 'string' ? args.effectId : null,
            dataDir: state.dataDir,
          }))
        } catch (error) {
          return toFailure(error)
        }
      },
    }),
  ]

  // R1a：统一给所有工具 execute 埋点（名称/耗时/成功失败均计数，不改变返回值/错误）。
  return tools.map((tool) => metrics.instrumentToolDefinition(tool))
}

/** 工具名清单（index.js 日志/诊断可用，测试也据此核对契约）。 */
export const TOOL_NAMES = [
  'studio_app_info',
  'studio_get_project',
  'studio_get_pattern',
  'studio_create_project',
  'studio_add_track',
  'studio_import_audio',
  'studio_update_track',
  'studio_set_automation',
  'studio_clear_automation',
  'studio_set_sidechain',
  'studio_clear_sidechain',
  'studio_add_pattern',
  'studio_set_notes',
  'studio_set_arrangement',
  'studio_add_effect',
  'studio_update_effect',
  'studio_remove_effect',
  'studio_set_master',
  'studio_set_track_sends',
  'studio_set_bus',
  'studio_transport',
  'studio_export',
  'studio_set_activity',
  'studio_render_preview',
  'studio_quick_mix_check',
  'studio_measure_live',
  'studio_validate_project',
  'studio_edit_notes',
  'studio_edit_clips',
  'studio_copy_pattern',
  'studio_save_project',
  'studio_list_projects',
  'studio_open_project',
  'studio_set_sustain',
  'studio_clear_sustain',
  'studio_set_vibrato',
  'studio_clear_vibrato',
  'studio_set_tempo_map',
  'studio_clear_tempo_map',
  'studio_batch',
  'studio_import_midi',
  'studio_list_project_versions',
  'studio_restore_project_version',
  'studio_import_reference',
  'studio_export_status',
  'studio_undo',
  'studio_redo',
  'studio_get_history',
  'studio_import_project_json',
  'studio_insert_bars',
  'studio_delete_bars',
  'studio_list_backups',
  'studio_restore_backup',
  'studio_get_recovery',
  'studio_restore_recovery',
  'studio_doctor_project',
  'studio_get_metrics',
  'studio_update_audio_clip',
  'studio_split_audio_clip',
  'studio_set_take_active',
  'studio_get_theory',
  'studio_write_chords',
  'studio_generate_arp',
  'studio_apply_groove',
  'studio_set_midi_mapping',
  'studio_clear_midi_mapping',
  'studio_list_midi_mappings',
  'studio_add_group',
  'studio_update_group',
  'studio_remove_group',
  'studio_set_track_output',
  'studio_save_scene',
  'studio_list_scenes',
  'studio_recall_scene',
  'studio_delete_scene',
  'studio_update_instrument',
  'studio_list_templates',
  'studio_list_plugins',
  'studio_update_synth',
  'studio_generate_part',
  'studio_generate_variation',
  'studio_suggest_mix',
  'studio_apply_mix',
  'studio_generate_beat',
  'studio_get_ai_changes',
  'studio_analyze_reference',
  'studio_generate_like_reference',
  'studio_ai_quality_report',
  'studio_get_settings',
  'studio_update_settings',
  'studio_check_update',
  'studio_get_diagnostics',
  'studio_scan_plugins',
  'studio_install_plugin',
  'studio_list_external_plugins',
  'studio_get_plugin_parameters',
  'studio_add_plugin_track',
  'studio_add_plugin_effect',
  'studio_remove_external_plugin',
  'studio_set_plugin_parameter',
  'studio_list_plugin_presets',
  'studio_select_plugin_preset',
  'studio_get_plugin_state',
  'studio_set_plugin_state',
  'studio_set_plugin_automation',
  'studio_clear_plugin_automation',
  'studio_get_plugin_automation',
  'studio_freeze_plugin_track',
  'studio_unfreeze_plugin_track',
  'studio_get_freeze_status',
]
