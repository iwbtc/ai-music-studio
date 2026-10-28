/**
 * 共享模型单测 — 自动化曲线（P2a）+ 侧链压缩（P2b）+ 返回总线（P2c-2）。
 * 运行：node --test test/model.test.mjs
 *
 * 覆盖：AUTOMATION_PARAMS 规格与映射、normalizeAutomation/Curve/Points 清洗规则、
 * automationValueAt 线性插值/端点/空点、normalizeProject 工程级规范化；
 * SIDECHAIN_DEFAULTS/normalizeSidechain/sidechainSummary 与 makeTrack/normalizeProject 的侧链保留；
 * BUS_IDS/BUS_DEFAULTS/normalizeBus/normalizeBuses 规范化与 FX 链规范化；P12：schemaVersion 2 clean break。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as catalogModule from '../src/shared/catalog.js'
import { createDemoProject } from '../src/shared/demo.js'
import { DEFAULT_MIX_TARGET_LUFS, applyMixSuggestions, buildMixSuggestions } from '../src/shared/ai-mix.js'
import { AI_JOURNAL_LIMIT, createAiJournal, diffProjectSummary } from '../src/host/ai-journal.js'
import { createTempoMap, normalizeTempoPoints, projectDurationSeconds } from '../src/shared/tempo.js'
import { PROJECT_TEMPLATES, createProjectFromTemplate, listProjectTemplates } from '../src/shared/templates.js'
import { SYNTH_INSTRUMENTS, SYNTH_INSTRUMENT_PARAM_SPECS, findSynthInstrument } from '../src/shared/catalog.js'
import {
  ALL_PLUGINS,
  EFFECT_PLUGINS,
  INSTRUMENT_PLUGINS,
  PLUGIN_SDK_VERSION,
  deserializePluginState,
  getPlugin,
  listPlugins,
  serializePluginState,
} from '../src/shared/plugins.js'
import { defaultMaster, makeEffect, masteredMaster, projectStats } from '../src/shared/model.js'
import {
  AUDIO_CLIP_FADE_MAX_SECONDS,
  AUDIO_CLIP_GAIN_DB_MAX,
  AUDIO_CLIP_GAIN_DB_MIN,
  audioClipLengthSeconds,
  audioClipPlayableSeconds,
  audioClipSourceSeconds,
  normalizeAudioClipSemitones,
  normalizeAudioClipStretchRatio,
  normalizeTakeActive,
  normalizeTakeGroup,
  normalizeTakeIndex,
  TAKE_GROUP_MAX_LENGTH,
  TAKE_INDEX_MAX,
  AUDIO_CLIP_SEMITONES_MAX,
  AUDIO_CLIP_SEMITONES_MIN,
  AUDIO_CLIP_STRETCH_RATIO_MAX,
  AUDIO_CLIP_STRETCH_RATIO_MIN,
  normalizeAudioClipFadeSeconds,
  normalizeAudioClipFields,
  normalizeAudioClipGainDb,
  normalizeAudioClipReverse,
  AUDIO_EXTS,
  AUDIO_TRACK_COLOR,
  AUTOMATION_MAX_POINTS,
  AUTOMATION_OVERVIEW_MAX_POINTS,
  AUTOMATION_CC_PARAM_IDS,
  AUTOMATION_CC_PARAMS,
  AUTOMATION_PARAM_IDS,
  AUTOMATION_PARAMS,
  AUTOMATION_VALUE_MAX,
  AUTOMATION_VALUE_MIN,
  BUS_DEFAULTS,
  BUS_IDS,
  MEDIA_DEFAULT_CLIP_BARS,
  MEDIA_MAX_BYTES,
  MEDIA_PEAKS_MAX_POINTS,
  MIGRATABLE_SCHEMA_VERSIONS,
  PROJECT_FORMAT_NAME,
  createProjectFormat,
  migrateProjectV2toV3,
  normalizeProjectFormat,
  SIDECHAIN_DEFAULTS,
  SIDECHAIN_MAX_TRIGGER_NOTES,
  SIDECHAIN_NOTE_RANGE,
  SIDECHAIN_RANGES,
  normalizeSidechainTriggerNotes,
  audioExtOf,
  automationParamSupports,
  automationSummary,
  automationValueAt,
  busSummary,
  EXPORT_HISTORY_LIMIT,
  EXPORT_JOB_LIMIT,
  normalizeExportJob,
  normalizeExportJobs,
  SUSTAIN_MAX_POINTS,
  VIBRATO_DEFAULTS,
  VIBRATO_RANGES,
  clipNotes,
  makeClip,
  mediaSummary,
  makeMedia,
  normalizeMedia,
  normalizeMediaList,
  createDefaultBuses,
  createEmptyProject,
  makeIdGen,
  MIDI_MAPPING_EFFECT_PARAMS,
  MIDI_MAPPING_MAX,
  MIDI_MAPPING_TARGETS,
  effectParamIds,
  normalizeMidiMapping,
  normalizeMidiMappings,
  GROUP_NAME_MAX,
  GROUP_OUTPUT_MASTER,
  DEFAULT_INSTRUMENT_PARAMS,
  INSTRUMENT_PARAM_SPECS,
  normalizeInstrumentParams,
  MAX_GROUPS,
  normalizeGroup,
  normalizeGroups,
  PDC_MS_MAX,
  TRACK_AUTOMATION_MODES,
  TRACK_ENGINES,
  normalizeSynthParams,
  synthPresetDefaults,
  TRACK_SEND_MODES,
  normalizePdcMs,
  MAX_SCENES,
  SCENE_NAME_MAX,
  captureSceneState,
  normalizeScene,
  normalizeScenes,
  sceneSummary,
  makeTrack,
  makePattern,
  normalizeAutomation,
  normalizeAutomationCurve,
  normalizeAutomationPoints,
  normalizeBus,
  normalizeBuses,
  normalizeClipOffset,
  normalizeEffects,
  normalizeExportHistory,
  normalizeExportHistoryEntry,
  normalizeSustainPoints,
  normalizeVibrato,
  normalizeProject,
  SCHEMA_VERSION,
  SchemaVersionError,
  isSchemaVersionError,
  normalizeSidechain,
  sidechainSummary,
  sustainSummary,
  vibratoSummary,
  CLIP_OFFSET_MAX_SECONDS,
} from '../src/shared/model.js'
import {
  DRUM_KITS,
  DRUM_PARAM_SPECS,
  SAMPLED_DRUM_KITS,
  SAMPLED_INSTRUMENTS,
  FX_PARAM_SPECS,
  FX_TYPES,
  SYNTH_PARAM_SPECS,
  SYNTH_PRESETS,
  coerceParam,
  findDrumKit,
  findFxType,
  findSynthPreset,
  fxDefaultParams,
  kitParams,
} from '../src/shared/catalog.js'

const close = (actual, expected, epsilon = 1e-9) => Math.abs(actual - expected) <= epsilon

describe('model — AUTOMATION_PARAMS 参数规格', () => {
  it('暴露 volume/pan/cutoff/pitchBend/modulation/expression + R3b cc1/cc11/cc64/cc74 十个参数与 id/label/targets/hint/map', () => {
    assert.deepEqual(AUTOMATION_PARAM_IDS, ['volume', 'pan', 'cutoff', 'pitchBend', 'modulation', 'expression', 'cc1', 'cc11', 'cc64', 'cc74'])
    for (const param of AUTOMATION_PARAM_IDS) {
      const spec = AUTOMATION_PARAMS[param]
      assert.equal(spec.id, param)
      assert.ok(typeof spec.label === 'string' && spec.label.length > 0, `${param} 需要中文 label`)
      assert.ok(typeof spec.hint === 'string' && spec.hint.length > 0, `${param} 需要映射说明`)
      assert.ok(Array.isArray(spec.targets) && spec.targets.length > 0)
      assert.equal(typeof spec.map, 'function')
      assert.equal(typeof spec.format, 'function')
    }
    assert.deepEqual(AUTOMATION_PARAMS.volume.targets, ['track', 'master'])
    assert.deepEqual(AUTOMATION_PARAMS.pan.targets, ['track'])
    assert.deepEqual(AUTOMATION_PARAMS.cutoff.targets, ['track'])
    // P13 表情类参数仅轨道
    for (const param of ['pitchBend', 'modulation', 'expression']) {
      assert.deepEqual(AUTOMATION_PARAMS[param].targets, ['track'])
    }
    assert.equal(automationParamSupports('volume', 'master'), true)
    assert.equal(automationParamSupports('pan', 'master'), false)
    assert.equal(automationParamSupports('cutoff', 'track'), true)
    assert.equal(automationParamSupports('pitchBend', 'track'), true)
    assert.equal(automationParamSupports('pitchBend', 'master'), false)
    assert.equal(automationParamSupports('modulation', 'master'), false)
    assert.equal(automationParamSupports('expression', 'master'), false)
    assert.equal(automationParamSupports('nope', 'track'), false)
  })

  it('映射函数与契约一致：音量=value、声像=value*2-1、cutoff=80→16000Hz 对数', () => {
    assert.equal(AUTOMATION_PARAMS.volume.map(0), 0)
    assert.equal(AUTOMATION_PARAMS.volume.map(0.8), 0.8)
    assert.equal(AUTOMATION_PARAMS.volume.map(2), 1) // 夹紧
    assert.equal(AUTOMATION_PARAMS.volume.map(-1), 0)

    assert.equal(AUTOMATION_PARAMS.pan.map(0), -1)
    assert.equal(AUTOMATION_PARAMS.pan.map(0.5), 0)
    assert.equal(AUTOMATION_PARAMS.pan.map(1), 1)

    assert.ok(close(AUTOMATION_PARAMS.cutoff.map(0), 80))
    assert.ok(close(AUTOMATION_PARAMS.cutoff.map(0.5), 80 * Math.sqrt(200)))
    assert.ok(close(AUTOMATION_PARAMS.cutoff.map(1), 16000))
    // 对数映射：value 越大越接近线性频率的对数刻度
    assert.ok(AUTOMATION_PARAMS.cutoff.map(0.25) > 80)
    assert.ok(AUTOMATION_PARAMS.cutoff.map(0.25) < AUTOMATION_PARAMS.cutoff.map(0.75))

    assert.equal(AUTOMATION_PARAMS.pan.format(0.5), 'C')
    assert.equal(AUTOMATION_PARAMS.pan.format(0), 'L100')
    assert.equal(AUTOMATION_PARAMS.pan.format(1), 'R100')
    assert.match(AUTOMATION_PARAMS.cutoff.format(0), /^80 Hz$/)
  })
})

describe('model — normalizeAutomationPoints / normalizeAutomationCurve', () => {
  it('过滤非法点、按 beat 升序、重复 beat 后者覆盖、value 夹 0..1', () => {
    const points = normalizeAutomationPoints([
      { beat: 8, value: 0.8 },
      null,
      { beat: 0, value: 0.2 },
      { beat: 8, value: 0.9 }, // 重复 beat：后者覆盖
      { beat: Number.NaN, value: 0.5 },
      { beat: 4, value: 'bad' },
      { beat: 4, value: 2 }, // value 夹到 1
      { beat: 12, value: -3 }, // value 夹到 0
    ])
    assert.deepEqual(points, [
      { beat: 0, value: 0.2 },
      { beat: 4, value: 1 },
      { beat: 8, value: 0.9 },
      { beat: 12, value: 0 },
    ])
  })

  it('clampBeat 把越界 beat 夹紧（夹紧后重复同样后者覆盖）', () => {
    const points = normalizeAutomationPoints(
      [
        { beat: -4, value: 0.1 },
        { beat: 100, value: 0.2 },
        { beat: 200, value: 0.3 },
      ],
      { clampBeat: 16 },
    )
    assert.deepEqual(points, [
      { beat: 0, value: 0.1 },
      { beat: 16, value: 0.3 },
    ])
  })

  it('非数组输入返回空数组；曲线规范化时超过 256 点截断', () => {
    assert.deepEqual(normalizeAutomationPoints(null), [])
    assert.deepEqual(normalizeAutomationPoints('nope'), [])
    assert.deepEqual(normalizeAutomationPoints(undefined), [])
    const many = Array.from({ length: 300 }, (_, index) => ({ beat: index, value: index / 300 }))
    const normalized = normalizeAutomationCurve({ points: many }, { maxBeat: 1000 })
    assert.equal(normalized.points.length, AUTOMATION_MAX_POINTS)
    assert.equal(normalized.points[0].beat, 0)
    assert.equal(normalized.points[AUTOMATION_MAX_POINTS - 1].beat, AUTOMATION_MAX_POINTS - 1)
  })

  it('normalizeAutomationCurve：enabled 默认 true、false 保留、空点合法、maxBeat 生效', () => {
    assert.deepEqual(normalizeAutomationCurve({ points: [] }), { enabled: true, points: [] })
    assert.deepEqual(normalizeAutomationCurve({ enabled: false, points: [] }), { enabled: false, points: [] })
    assert.deepEqual(normalizeAutomationCurve(null), { enabled: true, points: [] })
    const curved = normalizeAutomationCurve({ enabled: false, points: [{ beat: 999, value: 0.5 }] }, { maxBeat: 32 })
    assert.deepEqual(curved, { enabled: false, points: [{ beat: 32, value: 0.5 }] })
    // 默认 maxBeat = 最大曲长 256 小节 × 4 = 1024
    assert.equal(normalizeAutomationCurve({ points: [{ beat: 9999, value: 0.5 }] }).points[0].beat, 1024)
  })
})

describe('model — normalizeAutomation（整份曲线对象）', () => {
  it('只保留已知参数，未知参数丢弃；无有效参数时返回 {}', () => {
    const normalized = normalizeAutomation({
      volume: { enabled: true, points: [{ beat: 0, value: 0.5 }] },
      pan: { points: [{ beat: 4, value: 1 }] },
      unknown: { points: [{ beat: 0, value: 1 }] },
      cutoff: 'bad',
    })
    assert.deepEqual(Object.keys(normalized).sort(), ['pan', 'volume'])
    assert.equal(normalized.pan.points[0].beat, 4)
    assert.deepEqual(normalizeAutomation(null), {})
    assert.deepEqual(normalizeAutomation([]), {})
    assert.deepEqual(normalizeAutomation('x'), {})
    assert.deepEqual(normalizeAutomation({}), {})
  })

  it('allowed 限制可用参数（master 只有 volume）', () => {
    const raw = {
      volume: { points: [{ beat: 0, value: 0.3 }] },
      pan: { points: [{ beat: 0, value: 0.5 }] },
    }
    const masterOnly = normalizeAutomation(raw, { allowed: ['volume'] })
    assert.deepEqual(Object.keys(masterOnly), ['volume'])
    const all = normalizeAutomation(raw)
    assert.deepEqual(Object.keys(all).sort(), ['pan', 'volume'])
  })

  it('maxBeat 夹紧所有曲线点', () => {
    const normalized = normalizeAutomation(
      {
        volume: { points: [{ beat: -5, value: 0.2 }, { beat: 100, value: 0.9 }] },
        cutoff: { points: [{ beat: 64, value: 0.5 }] },
      },
      { maxBeat: 64 },
    )
    assert.deepEqual(normalized.volume.points, [
      { beat: 0, value: 0.2 },
      { beat: 64, value: 0.9 },
    ])
    assert.equal(normalized.cutoff.points[0].beat, 64)
  })
})

describe('model — automationValueAt 线性插值', () => {
  const points = [
    { beat: 0, value: 0.2 },
    { beat: 8, value: 0.6 },
    { beat: 16, value: 1 },
  ]

  it('无有效点时返回 null', () => {
    assert.equal(automationValueAt([], 0), null)
    assert.equal(automationValueAt(null, 0), null)
    assert.equal(automationValueAt(undefined, 4), null)
    assert.equal(automationValueAt([{ beat: 'x', value: 1 }], 4), null)
  })

  it('单点为常量', () => {
    assert.equal(automationValueAt([{ beat: 8, value: 0.42 }], 0), 0.42)
    assert.equal(automationValueAt([{ beat: 8, value: 0.42 }], 8), 0.42)
    assert.equal(automationValueAt([{ beat: 8, value: 0.42 }], 999), 0.42)
  })

  it('端点/精确点/线性中点', () => {
    assert.equal(automationValueAt(points, -10), 0.2) // 越界取端点
    assert.equal(automationValueAt(points, 0), 0.2)
    assert.ok(close(automationValueAt(points, 4), 0.4))
    assert.equal(automationValueAt(points, 8), 0.6)
    assert.ok(close(automationValueAt(points, 12), 0.8))
    assert.equal(automationValueAt(points, 16), 1)
    assert.equal(automationValueAt(points, 99), 1) // 越界取端点
  })

  it('乱序输入自动排序；重复 beat 后者覆盖；支持传曲线对象', () => {
    const unsorted = [
      { beat: 16, value: 1 },
      { beat: 0, value: 0 },
      { beat: 8, value: 0.4 },
      { beat: 8, value: 0.6 },
    ]
    assert.ok(close(automationValueAt(unsorted, 4), 0.3))
    assert.equal(automationValueAt(unsorted, 8), 0.6)
    assert.ok(close(automationValueAt({ points }, 4), 0.4))
  })

  it('beat 非数字按 0 处理', () => {
    assert.equal(automationValueAt(points, Number.NaN), 0.2)
    assert.equal(automationValueAt(points, undefined), 0.2)
  })
})

describe('model — normalizeProject 工程级规范化', () => {
  it('规范化轨道三个参数与 master volume，空 automation 删除字段', () => {
    const project = createEmptyProject({ lengthBars: 32 }) // maxBeat = 128
    const synth = makeTrack({ id: 'trk_1', name: 'Lead', kind: 'synth', preset: 'grand_piano', role: 'lead' })
    synth.automation = {
      volume: { enabled: true, points: [{ beat: 200, value: 2 }, { beat: 0, value: -1 }] },
      pan: { points: [{ beat: 8, value: 0.5 }] },
      cutoff: { enabled: false, points: [] },
      unknown: { points: [{ beat: 1, value: 1 }] },
    }
    const empty = makeTrack({ id: 'trk_2', name: 'Empty', kind: 'synth', preset: 'music_box', role: 'arp' })
    empty.automation = { volume: { points: [] }, pan: { points: [] }, cutoff: { points: [] } }
    project.tracks = [synth, empty]
    project.master.automation = {
      volume: { points: [{ beat: 64, value: 0.5 }] },
      pan: { points: [{ beat: 1, value: 0.1 }] }, // master 不支持 pan → 丢弃
    }
    const returned = normalizeProject(project)
    assert.equal(returned, project) // 原地修改
    assert.deepEqual(Object.keys(synth.automation).sort(), ['cutoff', 'pan', 'volume'])
    assert.deepEqual(synth.automation.volume.points, [
      { beat: 0, value: 0 },
      { beat: 128, value: 1 },
    ])
    assert.equal(synth.automation.cutoff.enabled, false)
    assert.deepEqual(synth.automation.cutoff.points, [])
    // 0 点曲线合法（=禁用），会被保留
    assert.deepEqual(Object.keys(empty.automation).sort(), ['cutoff', 'pan', 'volume'])
    assert.deepEqual(empty.automation.volume, { enabled: true, points: [] })
    assert.deepEqual(project.master.automation, { volume: { enabled: true, points: [{ beat: 64, value: 0.5 }] } })
    // 其它字段不受影响
    assert.equal(project.lengthBars, 32)
    assert.equal(project.tracks.length, 2)
  })

  it('maxBeat 跟随时长/拍号（3/4 拍工程同理）', () => {
    const project = createEmptyProject({ lengthBars: 4, timeSignature: [3, 4] })
    project.tracks = [
      (() => {
        const track = makeTrack({ id: 'trk_1', name: 'T', kind: 'synth', preset: 'grand_piano' })
        track.automation = { volume: { points: [{ beat: 999, value: 0.5 }] } }
        return track
      })(),
    ]
    normalizeProject(project)
    assert.equal(project.tracks[0].automation.volume.points[0].beat, 12) // 4 小节 × 3 beat
  })

  it('幂等：重复规范化结果一致；非对象安全返回', () => {
    const project = createEmptyProject()
    const track = makeTrack({ id: 'trk_1', name: 'T', kind: 'synth', preset: 'grand_piano' })
    track.automation = { volume: { points: [{ beat: 4, value: 0.25 }] } }
    project.tracks = [track]
    const once = normalizeProject(project)
    const snapshot = JSON.stringify(project)
    const twice = normalizeProject(once)
    assert.equal(JSON.stringify(twice), snapshot)
    assert.equal(normalizeProject(null), null)
    assert.equal(normalizeProject('x'), 'x')
  })

  it('新建工程与轨道默认没有 automation 字段（demo/empty 不受影响）', () => {
    const project = createEmptyProject()
    assert.equal(Object.hasOwn(project.master, 'automation'), false)
    const track = makeTrack({ id: 'trk_1', name: 'T', kind: 'synth', preset: 'grand_piano' })
    assert.equal(Object.hasOwn(track, 'automation'), false)
  })
})

describe('model — automationSummary 概览摘要', () => {
  it('默认摘要只给 enabled/pointCount/首尾；includePoints 才返回完整点', () => {
    const automation = {
      volume: { enabled: false, points: [{ beat: 0, value: 0.5 }, { beat: 4, value: 0.75 }] },
      pan: { points: [] },
      unknown: { points: [{ beat: 1, value: 1 }] },
    }
    const summary = automationSummary(automation)
    assert.deepEqual(Object.keys(summary).sort(), ['pan', 'volume'])
    assert.deepEqual(summary.volume, {
      enabled: false,
      pointCount: 2,
      firstBeat: 0,
      lastBeat: 4,
    })
    assert.equal(summary.volume.points, undefined)
    assert.deepEqual(summary.pan, { enabled: true, pointCount: 0 })
    // includePoints=true 才全量
    const full = automationSummary(automation, { includePoints: true })
    assert.deepEqual(full.volume.points, [{ beat: 0, value: 0.5 }, { beat: 4, value: 0.75 }])
    assert.deepEqual(full.pan, { enabled: true, pointCount: 0, points: [] })
    const many = {
      volume: {
        points: Array.from({ length: AUTOMATION_OVERVIEW_MAX_POINTS + 10 }, (_, index) => ({ beat: index, value: index / 100 })),
      },
    }
    assert.equal(automationSummary(many).volume.pointCount, AUTOMATION_OVERVIEW_MAX_POINTS + 10)
    assert.equal(automationSummary(many).volume.points, undefined)
    assert.equal(automationSummary(many, { includePoints: true }).volume.points.length, AUTOMATION_OVERVIEW_MAX_POINTS + 10)
    assert.deepEqual(automationSummary(null), {})
    assert.deepEqual(automationSummary('x'), {})
  })

  it('常量导出值符合契约（0..1 归一化范围）', () => {
    assert.equal(AUTOMATION_VALUE_MIN, 0)
    assert.equal(AUTOMATION_VALUE_MAX, 1)
    assert.equal(AUTOMATION_MAX_POINTS, 256)
    assert.equal(AUTOMATION_OVERVIEW_MAX_POINTS, 24)
  })
})

/* ------------------------------------------------------------------------- */
/* P2b：侧链压缩模型                                                           */
/* ------------------------------------------------------------------------- */

describe('model — SIDECHAIN_DEFAULTS / normalizeSidechain', () => {
  it('SIDECHAIN_DEFAULTS 与 SIDECHAIN_RANGES 符合契约', () => {
    assert.deepEqual({ ...SIDECHAIN_DEFAULTS }, {
      enabled: false,
      sourceTrackId: null,
      amount: 0.5,
      attack: 0.005,
      release: 0.12,
    })
    assert.deepEqual([...SIDECHAIN_RANGES.amount], [0, 1])
    assert.deepEqual([...SIDECHAIN_RANGES.attack], [0.001, 0.2])
    assert.deepEqual([...SIDECHAIN_RANGES.release], [0.02, 1])
  })

  it('normalizeSidechain：合法输入保留/夹紧，enabled 默认 true、显式 false 保留', () => {
    assert.deepEqual(
      normalizeSidechain(
        { sourceTrackId: 'trk_1', amount: 2, attack: 0, release: 9 },
        { trackIds: ['trk_1', 'trk_2'], selfId: 'trk_2' },
      ),
      { enabled: true, sourceTrackId: 'trk_1', amount: 1, attack: 0.001, release: 1, triggerNotes: [] },
    )
    assert.deepEqual(
      normalizeSidechain(
        { enabled: false, sourceTrackId: ' trk_1 ', amount: 'bad', attack: undefined, release: Number.NaN },
        { trackIds: ['trk_1', 'trk_2'], selfId: 'trk_2' },
      ),
      { enabled: false, sourceTrackId: 'trk_1', amount: 0.5, attack: 0.005, release: 0.12, triggerNotes: [] },
    )
  })

  it('normalizeSidechain：非法输入/自引用/不存在来源 → null', () => {
    assert.equal(normalizeSidechain(null), null)
    assert.equal(normalizeSidechain('x'), null)
    assert.equal(normalizeSidechain([]), null)
    assert.equal(normalizeSidechain({}), null)
    assert.equal(normalizeSidechain({ sourceTrackId: '' }), null)
    assert.equal(normalizeSidechain({ sourceTrackId: 123 }), null)
    assert.equal(
      normalizeSidechain({ sourceTrackId: 'trk_2' }, { trackIds: ['trk_1', 'trk_2'], selfId: 'trk_2' }),
      null,
    )
    assert.equal(
      normalizeSidechain({ sourceTrackId: 'trk_9' }, { trackIds: ['trk_1', 'trk_2'], selfId: 'trk_2' }),
      null,
    )
    // 未提供 trackIds/selfId 时只校验 source 非空
    assert.deepEqual(normalizeSidechain({ sourceTrackId: 'trk_9' }), {
      enabled: true,
      sourceTrackId: 'trk_9',
      amount: 0.5,
      attack: 0.005,
      release: 0.12,
      triggerNotes: [],
    })
  })

  it('sidechainSummary：无侧链返回 null，摘要夹紧', () => {
    assert.equal(sidechainSummary(null), null)
    assert.equal(sidechainSummary('x'), null)
    assert.deepEqual(sidechainSummary({ enabled: false, sourceTrackId: 'trk_1', amount: 0.6234, attack: 0.005, release: 0.15 }), {
      enabled: false,
      sourceTrackId: 'trk_1',
      amount: 0.623,
      attack: 0.005,
      release: 0.15,
      triggerNotes: [],
    })
  })

  it('makeTrack 保留合法 sidechain、丢弃自引用', () => {
    const track = makeTrack({
      id: 'trk_2',
      name: 'Bass',
      kind: 'synth',
      preset: 'finger_bass',
      sidechain: { sourceTrackId: 'trk_1', amount: 0.6 },
    })
    assert.deepEqual(track.sidechain, {
      enabled: true,
      sourceTrackId: 'trk_1',
      amount: 0.6,
      attack: 0.005,
      release: 0.12,
      triggerNotes: [],
    })
    const selfRef = makeTrack({ id: 'trk_1', name: 'Self', sidechain: { sourceTrackId: 'trk_1' } })
    assert.equal(Object.hasOwn(selfRef, 'sidechain'), false)
    const invalid = makeTrack({ id: 'trk_3', name: 'NoSource', sidechain: { amount: 0.5 } })
    assert.equal(Object.hasOwn(invalid, 'sidechain'), false)
    // 默认无 sidechain 字段
    assert.equal(Object.hasOwn(makeTrack({ id: 'trk_4', name: 'Plain' }), 'sidechain'), false)
  })

  it('normalizeProject：保留合法侧链、丢弃自引用/不存在来源、数值夹紧', () => {
    const project = createEmptyProject({ lengthBars: 16 })
    const kick = makeTrack({ id: 'trk_1', name: 'Kick', kind: 'drum', kit: 'smp_acoustic' })
    const bass = makeTrack({ id: 'trk_2', name: 'Bass', kind: 'synth', preset: 'finger_bass' })
    bass.sidechain = { sourceTrackId: 'trk_1', amount: 1.5, attack: 0, release: 2 }
    const broken = makeTrack({ id: 'trk_3', name: 'Broken', kind: 'synth', preset: 'music_box' })
    broken.sidechain = { sourceTrackId: 'trk_9' } // 不存在来源
    const selfRef = makeTrack({ id: 'trk_4', name: 'Self', kind: 'synth', preset: 'music_box' })
    selfRef.sidechain = { sourceTrackId: 'trk_4' } // 自引用
    project.tracks = [kick, bass, broken, selfRef]
    const returned = normalizeProject(project)
    assert.equal(returned, project)
    assert.deepEqual(bass.sidechain, {
      enabled: true,
      sourceTrackId: 'trk_1',
      amount: 1,
      attack: 0.001,
      release: 1,
      triggerNotes: [],
    })
    assert.equal(Object.hasOwn(broken, 'sidechain'), false)
    assert.equal(Object.hasOwn(selfRef, 'sidechain'), false)
    assert.equal(Object.hasOwn(kick, 'sidechain'), false)
    // 幂等
    const snapshot = JSON.stringify(project)
    normalizeProject(returned)
    assert.equal(JSON.stringify(project), snapshot)
  })

  it('demo/空工程默认没有 sidechain 字段（不受影响）', () => {
    const demo = createDemoProject()
    assert.ok(demo.tracks.every((track) => !Object.hasOwn(track, 'sidechain')))
    const empty = createEmptyProject()
    assert.ok(empty.tracks.every((track) => !Object.hasOwn(track, 'sidechain')))
  })
})

/* ------------------------------------------------------------------------- */
/* P2c-2：返回总线 buses 结构升级                                               */
/* ------------------------------------------------------------------------- */

describe('model — buses 结构升级（P2c-2）', () => {
  it('BUS_IDS / BUS_DEFAULTS 符合契约；createDefaultBuses 返回独立引用', () => {
    assert.deepEqual([...BUS_IDS], ['reverb', 'delay'])
    assert.deepEqual(JSON.parse(JSON.stringify(BUS_DEFAULTS)), {
      reverb: { level: 0.35, effects: [] },
      delay: { level: 0.22, effects: [] },
    })
    const first = createDefaultBuses()
    const second = createDefaultBuses()
    first.reverb.level = 0.9
    first.reverb.effects.push({ id: 'fx_1', type: 'eq3' })
    assert.equal(second.reverb.level, 0.35)
    assert.equal(second.reverb.effects.length, 0)
    assert.equal(BUS_DEFAULTS.reverb.level, 0.35)
    assert.equal(BUS_DEFAULTS.reverb.effects.length, 0)
  })

  it('createEmptyProject 输出新 buses 结构（不再是数字）', () => {
    const project = createEmptyProject()
    assert.equal(typeof project.buses, 'object')
    assert.deepEqual(project.buses, {
      reverb: { level: 0.35, effects: [] },
      delay: { level: 0.22, effects: [] },
    })
    assert.ok(Array.isArray(project.buses.reverb.effects))
    assert.ok(Array.isArray(project.buses.delay.effects))
  })

  it('normalizeBus：只接受对象结构（P12 不再迁移旧数字）、level 夹紧、非法回退', () => {
    assert.deepEqual(normalizeBus(0.7), { level: 0.35, effects: [] })
    assert.deepEqual(normalizeBus(3, 0.22), { level: 0.22, effects: [] })
    assert.deepEqual(normalizeBus(-2, 0.22), { level: 0.22, effects: [] })
    assert.deepEqual(normalizeBus(Number.NaN, 0.22), { level: 0.22, effects: [] })
    assert.deepEqual(normalizeBus('bad', 0.22), { level: 0.22, effects: [] })
    assert.deepEqual(normalizeBus(null, 0.22), { level: 0.22, effects: [] })
    assert.deepEqual(normalizeBus({}, 0.22), { level: 0.22, effects: [] })
    assert.deepEqual(normalizeBus({ level: -1 }, 0.22), { level: 0, effects: [] })
    assert.deepEqual(normalizeBus({ level: 'x' }, 0.22), { level: 0.22, effects: [] })
  })

  it('normalizeBus 的 effects 会走 normalizeEffects（未知 type 丢弃 / id 去重 / 默认参数）', () => {
    const bus = normalizeBus({
      level: 0.5,
      effects: [
        { id: 'fx_1', type: 'eq3' },
        { id: 'fx_1', type: 'filter', params: { cutoff: 900 } },
        { type: 'nope' },
        { id: 'bad id', type: 'drive', enabled: false },
      ],
    })
    assert.equal(bus.effects.length, 3)
    assert.equal(bus.effects[0].id, 'fx_1')
    assert.equal(bus.effects[0].type, 'eq3')
    assert.equal(bus.effects[0].enabled, true)
    assert.equal(typeof bus.effects[0].params.low, 'number')
    assert.equal(bus.effects[1].id, 'fx_2')
    assert.equal(bus.effects[1].type, 'filter')
    assert.equal(bus.effects[1].params.cutoff, 900)
    assert.equal(bus.effects[2].id, 'fx_3')
    assert.equal(bus.effects[2].type, 'drive')
    assert.equal(bus.effects[2].enabled, false)
  })

  it('normalizeEffects：非数组返回空、max 截断、enabled false 保留', () => {
    assert.deepEqual(normalizeEffects(null), [])
    assert.deepEqual(normalizeEffects('x'), [])
    const many = Array.from({ length: 10 }, (_, index) => ({ id: `fx_${index + 1}`, type: 'eq3' }))
    assert.equal(normalizeEffects(many, { max: 3 }).length, 3)
    assert.equal(normalizeEffects(many).length, 8) // 默认 LIMITS.maxEffectsPerTrack
    const disabled = normalizeEffects([{ id: 'fx_1', type: 'reverb', enabled: false }])
    assert.equal(disabled.length, 1)
    assert.equal(disabled[0].enabled, false)
  })

  it('normalizeBuses：只接受对象结构、缺失/垃圾回默认、幂等', () => {
    assert.deepEqual(normalizeBuses({ reverb: 0.66, delay: 0.33 }), {
      reverb: { level: 0.35, effects: [] },
      delay: { level: 0.22, effects: [] },
    })
    assert.deepEqual(normalizeBuses({}), {
      reverb: { level: 0.35, effects: [] },
      delay: { level: 0.22, effects: [] },
    })
    assert.deepEqual(normalizeBuses(null), {
      reverb: { level: 0.35, effects: [] },
      delay: { level: 0.22, effects: [] },
    })
    const mixed = normalizeBuses({ reverb: { level: 0.9, effects: [{ type: 'filter' }] }, delay: 'x' })
    assert.equal(mixed.reverb.level, 0.9)
    assert.equal(mixed.reverb.effects.length, 1)
    assert.equal(mixed.reverb.effects[0].type, 'filter')
    assert.equal(mixed.delay.level, 0.22)
    // 幂等（对象结构）
    const once = normalizeBuses({ reverb: { level: 0.5 }, delay: { level: 2, effects: [{ id: 'fx_9', type: 'eq3' }] } })
    assert.deepEqual(normalizeBuses(once), once)
  })

  it('normalizeProject：buses 只保留对象结构（P12 旧数字回默认）；新结构幂等；track.sends 保留', () => {
    const project = createDemoProject()
    const sendsBefore = JSON.stringify(project.tracks.map((track) => track.sends))
    project.buses = { reverb: 0.8, delay: 0.1 }
    normalizeProject(project)
    assert.deepEqual(project.buses, {
      reverb: { level: 0.35, effects: [] },
      delay: { level: 0.22, effects: [] },
    })
    assert.equal(JSON.stringify(project.tracks.map((track) => track.sends)), sendsBefore)
    // 再规范化幂等
    const snapshot = JSON.stringify(project.buses)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.buses), snapshot)
    // demo / empty 默认就是新结构
    assert.equal(typeof createEmptyProject().buses.reverb, 'object')
    assert.equal(typeof createDemoProject().buses.delay, 'object')
  })

  it('makeIdGen 扫描返回总线 FX id，避免新效果器 id 冲突', () => {
    const project = createEmptyProject()
    project.buses.reverb.effects = [{ id: 'fx_5', type: 'eq3' }]
    project.buses.delay.effects = [{ id: 'fx_2', type: 'filter' }]
    assert.equal(makeIdGen(project)('fx'), 'fx_6')
  })

  it('busSummary：level 四舍五入 + effects 摘要；无值回 fallback', () => {
    assert.deepEqual(busSummary({ level: 0.6234, effects: [{ id: 'fx_1', type: 'eq3', enabled: false, params: {} }] }), {
      level: 0.623,
      effects: [{ id: 'fx_1', type: 'eq3', enabled: false }],
    })
    assert.deepEqual(busSummary(null, 0.22), { level: 0.22, effects: [] })
    assert.deepEqual(busSummary(0.4), { level: 0.35, effects: [] })
  })
})

/* ------------------------------------------------------------------------- */
/* P3b：音频媒体与音频轨                                                       */
/* ------------------------------------------------------------------------- */

describe('model — P3b 音频媒体与音频轨', () => {
  it('AUDIO_EXTS / MEDIA_* 常量符合契约', () => {
    assert.deepEqual([...AUDIO_EXTS], ['wav', 'mp3', 'flac', 'ogg'])
    assert.equal(MEDIA_MAX_BYTES, 30 * 1024 * 1024)
    assert.equal(MEDIA_PEAKS_MAX_POINTS, 512)
    assert.equal(MEDIA_DEFAULT_CLIP_BARS, 4)
    assert.match(AUDIO_TRACK_COLOR, /^#[0-9A-Fa-f]{6}$/)
  })

  it('normalizeMedia：合法值保留、duration/channels/sampleRate 夹紧、peaks 截断到 ≤512 且夹 0..1', () => {
    const media = normalizeMedia({
      id: 'med_1',
      name: '人声.wav',
      file: 'med_1.wav',
      bytes: 123456,
      durationSeconds: 3.2,
      channels: 2,
      sampleRate: 44100,
      peaks: [0.1, 2, -1],
    })
    assert.deepEqual(media, {
      id: 'med_1',
      name: '人声.wav',
      file: 'med_1.wav',
      bytes: 123456,
      durationSeconds: 3.2,
      channels: 2,
      sampleRate: 44100,
      peaks: [0.1, 1, 0],
    })
    const clamped = normalizeMedia({
      id: 'med_2',
      name: 'x',
      file: 'med_2.mp3',
      bytes: -5,
      durationSeconds: 99999,
      channels: 99,
      sampleRate: 1000,
    })
    assert.equal(clamped.durationSeconds, 3600)
    assert.equal(clamped.channels, 8)
    assert.equal(clamped.sampleRate, 8000)
    assert.equal(clamped.bytes, 0)
    assert.equal(Object.hasOwn(clamped, 'peaks'), false)
    const manyPeaks = Array.from({ length: 700 }, (_, index) => index / 700)
    assert.equal(normalizeMedia({ id: 'med_3', name: 'x', file: 'med_3.wav', peaks: manyPeaks }).peaks.length, MEDIA_PEAKS_MAX_POINTS)
  })

  it('normalizeMedia：关键字段非法返回 null（id/file/扩展名/路径穿越）', () => {
    assert.equal(normalizeMedia(null), null)
    assert.equal(normalizeMedia('x'), null)
    assert.equal(normalizeMedia([]), null)
    assert.equal(normalizeMedia({ name: 'x', file: 'a.wav' }), null)
    assert.equal(normalizeMedia({ id: '../evil', name: 'x', file: 'a.wav' }), null)
    assert.equal(normalizeMedia({ id: 'med_1', name: 'x', file: '../a.wav' }), null)
    assert.equal(normalizeMedia({ id: 'med_1', name: 'x', file: 'a/b.wav' }), null)
    assert.equal(normalizeMedia({ id: 'med_1', name: 'x', file: 'a.aiff' }), null)
    assert.equal(normalizeMedia({ id: 'med_1', name: 'x', file: 'a.wav' }).name, 'x')
    assert.equal(normalizeMedia({ id: 'med_1', name: '', file: 'a.wav' }).name, '未命名音频')
  })

  it('normalizeMediaList：丢弃非法条目与重复 id', () => {
    const list = normalizeMediaList([
      { id: 'med_1', name: 'a', file: 'med_1.wav' },
      { id: 'med_1', name: 'dup', file: 'med_1.wav' },
      { id: '../bad', name: 'b', file: 'bad.wav' },
      { id: 'med_2', name: 'c', file: 'med_2.mp3' },
    ])
    assert.deepEqual(list.map((item) => item.id), ['med_1', 'med_2'])
    assert.deepEqual(normalizeMediaList(null), [])
  })

  it('makeMedia 兜底 / mediaSummary 摘要字段', () => {
    const media = makeMedia({ id: 'med_1', name: '人声.wav', file: 'med_1.wav', bytes: 100, durationSeconds: 2.5 })
    assert.ok(media)
    assert.equal(media.id, 'med_1')
    assert.equal(media.channels, 2)
    assert.equal(media.sampleRate, 44100)
    const summary = mediaSummary({ ...media, peaks: [0.1, 0.2] })
    assert.deepEqual(summary, {
      id: 'med_1',
      name: '人声.wav',
      file: 'med_1.wav',
      bytes: 100,
      durationSeconds: 2.5,
      channels: 2,
      sampleRate: 44100,
      hasPeaks: true,
    })
    assert.equal(mediaSummary(media).hasPeaks, false)
  })

  it('audioExtOf：仅接受 wav/mp3/flac/ogg（大小写不敏感）', () => {
    assert.equal(audioExtOf('a.wav'), 'wav')
    assert.equal(audioExtOf('A.MP3'), 'mp3')
    assert.equal(audioExtOf('x.flac'), 'flac')
    assert.equal(audioExtOf('x.ogg'), 'ogg')
    assert.equal(audioExtOf('x.aiff'), null)
    assert.equal(audioExtOf('noext'), null)
    assert.equal(audioExtOf(123), null)
  })

  it('makeTrack(kind="audio")：role/颜色/无 instrument/默认发送', () => {
    const track = makeTrack({ id: 'trk_1', kind: 'audio', name: '音频 · 人声.wav' })
    assert.equal(track.id, 'trk_1')
    assert.equal(track.kind, 'audio')
    assert.equal(track.role, 'audio')
    assert.equal(track.color, AUDIO_TRACK_COLOR)
    assert.equal(Object.hasOwn(track, 'instrument'), false)
    assert.equal(track.volume, 0.78)
    assert.deepEqual(track.sends, { reverb: 0.12, delay: 0.06 })
    assert.deepEqual(track.effects, [])
    // 自定义颜色/发送/侧链
    const custom = makeTrack({ id: 'trk_2', kind: 'audio', color: '#112233', sends: { reverb: 0.5, delay: 0.2 } })
    assert.equal(custom.color, '#112233')
    assert.deepEqual(custom.sends, { reverb: 0.5, delay: 0.2 })
  })

  it('makeClip：音频片段无 patternId/transpose（P6 起带 offsetSeconds 默认 0），pattern 片段保持原样', () => {
    const audioClip = makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 6 })
    assert.deepEqual(audioClip, { id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 6, offsetSeconds: 0 })
    // P6：offsetSeconds 保留并规范到 3 位小数
    const trimmed = makeClip({ id: 'clip_3', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 4, offsetSeconds: 1.23456 })
    assert.equal(trimmed.offsetSeconds, 1.235)
    const patternClip = makeClip({ id: 'clip_2', trackId: 'trk_2', patternId: 'pat_1', startBar: 1, lengthBars: 4, transpose: 2 })
    assert.deepEqual(patternClip, {
      id: 'clip_2',
      trackId: 'trk_2',
      patternId: 'pat_1',
      startBar: 1,
      lengthBars: 4,
      transpose: 2,
    })
    // 音频片段 lengthBars 夹到 1..LIMITS.maxBars
    const clamped = makeClip({ id: 'clip_3', trackId: 'trk_1', mediaId: 'med_1', startBar: -2, lengthBars: 9999 })
    assert.equal(clamped.startBar, 0)
    assert.equal(clamped.lengthBars, 256)
  })

  it('clipNotes 对音频片段返回 []', () => {
    const project = createEmptyProject()
    const clip = { id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 4 }
    assert.deepEqual(clipNotes(project, clip), [])
    assert.deepEqual(clipNotes(project, { ...clip, mediaId: undefined }), [])
  })

  it('createEmptyProject 带 media: []；缺 media 字段 normalizeProject 补 [] 且幂等', () => {
    const project = createEmptyProject()
    assert.deepEqual(project.media, [])
    const demo = createDemoProject()
    delete demo.media
    normalizeProject(demo)
    assert.deepEqual(demo.media, [])
    const snapshot = JSON.stringify(demo.media)
    normalizeProject(demo)
    assert.equal(JSON.stringify(demo.media), snapshot)
  })

  it('normalizeProject：音频轨 role/instrument 规范化；丢弃引用缺失媒体的片段；保留 pattern 片段', () => {
    const project = createEmptyProject()
    project.media = normalizeMediaList([{ id: 'med_1', name: 'a.wav', file: 'med_1.wav' }])
    const audioTrack = makeTrack({ id: 'trk_1', kind: 'audio', name: '音频', role: 'lead' })
    audioTrack.instrument = { preset: 'grand_piano', kit: null, params: {} } // 音频轨上的异常 instrument 会被清掉
    const synthTrack = makeTrack({ id: 'trk_2', preset: 'music_box' })
    project.tracks = [audioTrack, synthTrack]
    project.patterns = [{ id: 'pat_1', name: 'P', lengthBars: 4, notes: [] }]
    project.clips = [
      { id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2 },
      { id: 'clip_2', trackId: 'trk_1', mediaId: 'med_9', startBar: 0, lengthBars: 2 },
      { id: 'clip_3', trackId: 'trk_2', patternId: 'pat_1', startBar: 0, lengthBars: 4 },
    ]
    normalizeProject(project)
    assert.equal(audioTrack.role, 'audio')
    assert.equal(Object.hasOwn(audioTrack, 'instrument'), false)
    assert.deepEqual(project.clips.map((clip) => clip.id), ['clip_1', 'clip_3'])
    assert.equal(synthTrack.kind, 'synth')
  })

  it('makeIdGen 扫描 media（med_N）', () => {
    const project = createEmptyProject()
    project.media = normalizeMediaList([
      { id: 'med_2', name: 'a.wav', file: 'med_2.wav' },
      { id: 'med_5', name: 'b.wav', file: 'med_5.wav' },
    ])
    assert.equal(makeIdGen(project)('med'), 'med_6')
  })
})

/* ------------------------------------------------------------------------- */
/* R1b：schemaVersion 3 前向兼容格式（v2 一次性迁移，v1 不兼容）              */
/* ------------------------------------------------------------------------- */

describe('model R1b — schemaVersion 3 + v2 迁移', () => {
  it('SCHEMA_VERSION = 3；createEmptyProject / demo 都写 3 + format 元信息', () => {
    assert.equal(SCHEMA_VERSION, 3)
    assert.equal(createEmptyProject().schemaVersion, 3)
    assert.equal(createDemoProject().schemaVersion, 3)
    assert.equal(normalizeProject(createEmptyProject()).schemaVersion, 3)
    const format = createEmptyProject().format
    assert.equal(format.name, 'aims')
    assert.equal(format.version, 3)
    assert.equal(Object.hasOwn(format, 'migratedFrom'), false)
    assert.equal(Object.hasOwn(format, 'migratedAt'), false)
  })

  it('normalizeProject 拒绝不可迁移旧 schemaVersion：1 / 0 / 缺失 / 字符串 1；v2 自动迁移', () => {
    for (const version of [1, 0, undefined, null, '1']) {
      const project = createEmptyProject()
      project.schemaVersion = version
      assert.throws(
        () => normalizeProject(project),
        (error) => error instanceof SchemaVersionError && error.code === 'UNSUPPORTED_SCHEMA' && /旧版本工程不支持/.test(error.message),
        `version=${String(version)} 应被拒绝`,
      )
    }
    // v2 一次性迁移
    const v2 = createEmptyProject()
    v2.schemaVersion = 2
    delete v2.format
    const migrated = normalizeProject(structuredClone(v2))
    assert.equal(migrated.schemaVersion, 3)
    assert.equal(migrated.format.name, 'aims')
    assert.equal(migrated.format.version, 3)
    assert.equal(migrated.format.migratedFrom, 2)
    assert.ok(Number.isFinite(migrated.format.migratedAt))
    assert.equal(v2.schemaVersion, 2, 'normalizeProject 不应修改原始 v2 输入引用？迁移在传入对象上进行')
    const error = new SchemaVersionError(1)
    assert.equal(isSchemaVersionError(error), true)
    assert.equal(isSchemaVersionError(new Error('x')), false)
    assert.match(error.message, /schemaVersion 1/)
  })

  it('catalog 不再导出 LEGACY 目录；findSynthPreset / findDrumKit 只查当前采样目录', () => {
    assert.equal(Object.hasOwn(catalogModule, 'LEGACY_SYNTH_PRESETS'), false)
    assert.equal(Object.hasOwn(catalogModule, 'LEGACY_DRUM_KITS'), false)
    assert.equal(findSynthPreset('supersaw'), undefined)
    assert.equal(findSynthPreset('reese'), undefined)
    assert.equal(findDrumKit('neon808'), undefined)
    assert.equal(findDrumKit('industrial'), undefined)
    assert.equal(findSynthPreset('grand_piano').id, 'grand_piano')
    assert.equal(findDrumKit('smp_acoustic').id, 'smp_acoustic')
  })

  it('makeTrack / normalizeProject 对未知 preset/kit 回退当前默认（不再有旧合成音色）', () => {
    const legacy = makeTrack({ id: 'trk_1', preset: 'supersaw' })
    assert.equal(legacy.instrument.preset, 'grand_piano')
    assert.deepEqual(legacy.instrument.params, {})
    const legacyKit = makeTrack({ id: 'trk_2', kind: 'drum', kit: 'neon808' })
    assert.equal(legacyKit.instrument.kit, 'smp_acoustic')
    assert.equal(legacyKit.instrument.params.kickPitch, 48)
  })
})

/* ------------------------------------------------------------------------- */
/* P8：真实采样音源（GeneralUser GS SoundFont，用户可见的唯一乐器/鼓组）          */
/* ------------------------------------------------------------------------- */

const P8_INSTRUMENTS = [
  ['grand_piano', 0], ['bright_piano', 1], ['tine_epiano', 4], ['harpsichord', 6], ['music_box', 10], ['marimba', 12],
  ['tonewheel_organ', 16], ['nylon_guitar', 24], ['steel_guitar', 25], ['acoustic_bass', 32], ['finger_bass', 33],
  ['violin', 40], ['cello', 42], ['strings_ensemble', 49], ['concert_choir', 52], ['trumpet', 56], ['flute', 73], ['warm_pad', 89],
  // R5a：+14 个 GeneralUser GS Bank 0 程序（旧 18 个顺序不变）
  ['vibraphone', 11], ['glockenspiel', 9], ['church_organ', 19], ['jazz_guitar', 26], ['muted_guitar', 28],
  ['picked_bass', 34], ['fretless_bass', 35], ['synth_bass', 38], ['viola', 41], ['pizzicato_strings', 45],
  ['voice_oohs', 53], ['french_horn', 60], ['trombone', 57], ['clarinet', 71],
]

describe('catalog P8 — 真实采样乐器 / 采样鼓机', () => {
  it('SYNTH_PRESETS = 32 个采样乐器；DRUM_KITS = 4 套采样鼓机；FX 15 种', () => {
    assert.equal(SYNTH_PRESETS.length, 32)
    assert.equal(SAMPLED_INSTRUMENTS.length, 32)
    assert.equal(SYNTH_PRESETS, SAMPLED_INSTRUMENTS)
    assert.equal(DRUM_KITS.length, 4)
    assert.equal(SAMPLED_DRUM_KITS, DRUM_KITS)
    assert.deepEqual(DRUM_KITS.map((kit) => kit.id), ['smp_acoustic', 'smp_electro', 'smp_lofi', 'smp_perc'])
    assert.equal(FX_TYPES.length, 15)
  })

  it('32 个采样乐器结构完整：id/name/label/category/color/desc(中文) + soundfont 程序号', () => {
    assert.deepEqual(SYNTH_PRESETS.map((preset) => [preset.id, preset.soundfont.program]), P8_INSTRUMENTS)
    for (const preset of SYNTH_PRESETS) {
      assert.ok(typeof preset.name === 'string' && preset.name.length > 0, `${preset.id}.name`)
      assert.ok(/[\u4e00-\u9fa5]/.test(preset.label), `${preset.id}.label 需要中文`)
      assert.ok(/[\u4e00-\u9fa5]/.test(preset.category), `${preset.id}.category 需要中文`)
      assert.match(preset.color, /^#[0-9A-Fa-f]{6}$/, `${preset.id}.color`)
      assert.ok(/[\u4e00-\u9fa5]/.test(preset.desc), `${preset.id}.desc 需要中文`)
      assert.equal(preset.soundfont.bank, 0, `${preset.id}.soundfont.bank`)
      assert.equal(typeof preset.soundfont.program, 'number')
      // 采样乐器没有合成参数
      assert.equal(Object.hasOwn(preset, 'params'), false, `${preset.id} 不应带合成参数`)
      assert.equal(Object.hasOwn(preset, 'sampler'), false, `${preset.id} 不是本地采样器`)
    }
    // id 唯一
    assert.equal(new Set(SYNTH_PRESETS.map((preset) => preset.id)).size, 32)
    // 音色顺序：默认音色 = 三角钢琴
    assert.equal(SYNTH_PRESETS[0].id, 'grand_piano')
    assert.equal(SYNTH_PRESETS[0].label, '三角钢琴')
  })

  it('采样乐器分类覆盖 键盘/吉他/贝斯/弦乐/合唱/铜管/木管/铺底', () => {
    const categories = new Set(SYNTH_PRESETS.map((preset) => preset.category))
    for (const category of ['键盘 Keys', '吉他 Guitar', '贝斯 Bass', '弦乐 Strings', '合唱 Choir', '铜管 Brass', '木管 Woodwind', '铺底 Pad']) {
      assert.ok(categories.has(category), `缺少分类 ${category}`)
    }
    // 分类内条目合理
    assert.ok(SYNTH_PRESETS.filter((preset) => preset.category === '键盘 Keys').length >= 5)
    assert.deepEqual(
      SYNTH_PRESETS.filter((preset) => preset.category === '吉他 Guitar').map((preset) => preset.id),
      ['nylon_guitar', 'steel_guitar', 'jazz_guitar', 'muted_guitar'],
    )
  })

  it('4 套采样鼓机：id/中文 label/中文 desc/采样文件齐全且参数合法', () => {
    const pieceIds = ['kick', 'snare', 'clap', 'rim', 'hat', 'openhat', 'tomLow', 'tomHigh', 'crash', 'ride', 'perc']
    for (const kit of DRUM_KITS) {
      assert.match(kit.id, /^smp_/)
      assert.ok(/[\u4e00-\u9fa5]/.test(kit.label), `${kit.id}.label 需要中文`)
      assert.ok(/[\u4e00-\u9fa5]/.test(kit.desc), `${kit.id}.desc 需要中文`)
      assert.match(kit.color, /^#[0-9A-Fa-f]{6}$/)
      assert.equal(Object.keys(kit.samplerPieces).sort().join(','), pieceIds.sort().join(','), `${kit.id} 采样件不完整`)
      for (const file of Object.values(kit.samplerPieces)) assert.match(file, /\.flac$/, `${kit.id} 采样文件`)
      const params = kitParams(kit)
      for (const [key, spec] of Object.entries(DRUM_PARAM_SPECS)) {
        assert.ok(Number.isFinite(params[key]) && params[key] >= spec.min && params[key] <= spec.max, `${kit.id}.${key} 越界`)
      }
    }
    // 4 套采样鼓机参数签名互不相同
    assert.equal(new Set(DRUM_KITS.map((kit) => JSON.stringify(kitParams(kit)))).size, 4)
  })

  it('findSynthPreset / findDrumKit：只在当前采样目录查找（P12 无旧回退）', () => {
    assert.equal(findSynthPreset('grand_piano').id, 'grand_piano')
    assert.equal(findSynthPreset('warm_pad').id, 'warm_pad')
    assert.equal(findSynthPreset('supersaw'), undefined)
    assert.equal(findSynthPreset('reese'), undefined)
    assert.equal(findSynthPreset('nope'), undefined)
    assert.equal(findDrumKit('smp_acoustic').id, 'smp_acoustic')
    assert.equal(findDrumKit('neon808'), undefined)
    assert.equal(findDrumKit('nope'), undefined)
  })

  it('makeTrack：默认音色 = 三角钢琴；未知 preset 回退默认不报错；采样乐器无合成参数', () => {
    const byDefault = makeTrack({ id: 'trk_1', name: '默认' })
    assert.equal(byDefault.instrument.preset, 'grand_piano')
    assert.equal(byDefault.instrument.kit, null)
    assert.equal(byDefault.kind, 'synth')
    assert.deepEqual(byDefault.instrument.params, {})
    assert.equal(byDefault.name, '默认')
    assert.equal(byDefault.color, SYNTH_PRESETS[0].color)
    // 未知 preset 回退默认、不抛错
    const unknown = makeTrack({ id: 'trk_2', preset: 'definitely_not_a_preset' })
    assert.equal(unknown.instrument.preset, 'grand_piano')
    assert.deepEqual(unknown.instrument.params, {})
    // 显式采样乐器
    const strings = makeTrack({ id: 'trk_3', preset: 'strings_ensemble' })
    assert.equal(strings.instrument.preset, 'strings_ensemble')
    assert.equal(strings.instrument.params ? Object.keys(strings.instrument.params).length : 0, 0)
    // P12：旧合成预设已移除，未知 preset 回退当前默认采样音色
    const legacy = makeTrack({ id: 'trk_4', preset: 'grand_piano' })
    assert.equal(legacy.instrument.preset, 'grand_piano')
    assert.deepEqual(legacy.instrument.params, {})
  })

  it('makeTrack 鼓机：默认 = 原声采样鼓；未知/旧合成 kit 回退默认', () => {
    const byDefault = makeTrack({ id: 'trk_1', name: '鼓', kind: 'drum' })
    assert.equal(byDefault.kind, 'drum')
    assert.equal(byDefault.role, 'drums')
    assert.equal(byDefault.instrument.kit, 'smp_acoustic')
    assert.equal(byDefault.instrument.params.kickPitch, 48)
    const unknown = makeTrack({ id: 'trk_2', kind: 'drum', kit: 'nope' })
    assert.equal(unknown.instrument.kit, 'smp_acoustic')
    const legacy = makeTrack({ id: 'trk_3', kind: 'drum', kit: 'smp_acoustic' })
    assert.equal(legacy.instrument.kit, 'smp_acoustic')
    assert.equal(legacy.instrument.params.kickPitch, 48)
  })
})

describe('demo P8 — 演示工程全部使用真实采样音色', () => {
  const project = createDemoProject()

  it('7 轨、BPM 128 / F# 小调 / 32 小节、段落与编排结构保持', () => {
    assert.equal(project.bpm, 128)
    assert.equal(project.key, 'F#')
    assert.equal(project.scale, 'minor')
    assert.equal(project.lengthBars, 32)
    assert.equal(project.tracks.length, 7)
    assert.equal(project.patterns.length, 13)
    assert.ok(project.clips.length >= 20)
    assert.equal(project.sections.length, 5)
    assert.deepEqual(project.sections.map((section) => section.name), ['Intro 前奏', 'Build 推进', 'Drop 高潮', 'Break 间奏', 'Drop 2 终章'])
  })

  it('7 轨使用预期采样乐器/采样鼓机，且无任何遗留合成 preset/kit', () => {
    const expected = {
      trk_1: { kind: 'drum', kit: 'smp_acoustic' },
      trk_2: { kind: 'synth', preset: 'finger_bass' },
      trk_3: { kind: 'synth', preset: 'grand_piano' },
      trk_4: { kind: 'synth', preset: 'strings_ensemble' },
      trk_5: { kind: 'synth', preset: 'marimba' },
      trk_6: { kind: 'synth', preset: 'tine_epiano' },
      trk_7: { kind: 'synth', preset: 'concert_choir' },
    }
    for (const [trackId, spec] of Object.entries(expected)) {
      const track = project.tracks.find((item) => item.id === trackId)
      assert.ok(track, `缺少轨道 ${trackId}`)
      assert.equal(track.kind, spec.kind, trackId)
      if (spec.kind === 'drum') {
        assert.equal(track.instrument.kit, spec.kit)
        assert.ok(DRUM_KITS.some((kit) => kit.id === track.instrument.kit), `${trackId} kit 必须是采样鼓机`)
      } else {
        assert.equal(track.instrument.preset, spec.preset)
        assert.ok(SYNTH_PRESETS.some((preset) => preset.id === track.instrument.preset), `${trackId} preset 必须是采样乐器`)
      }
    }
    // 每轨都必须能在当前采样目录中解析到
    for (const track of project.tracks) {
      if (track.kind === 'drum') assert.equal(findDrumKit(track.instrument.kit)?.id, track.instrument.kit)
      else assert.equal(findSynthPreset(track.instrument.preset)?.id, track.instrument.preset)
    }
  })

  it('轨道名称为中文采样描述，采样乐器轨不带合成参数', () => {
    const names = project.tracks.map((track) => track.name)
    for (const name of ['鼓组 · 原声采样鼓', '低音 · 指弹贝斯', '主音 · 三角钢琴', '铺底 · 弦乐合奏', '琶音 · 马林巴', '和弦 · 电钢琴', '氛围 · 合唱']) {
      assert.ok(names.includes(name), `缺少轨道名 ${name}`)
    }
    for (const track of project.tracks) {
      if (track.kind === 'synth') assert.deepEqual(track.instrument.params, {}, `${track.id} 采样乐器不应带合成参数`)
    }
  })

  it('演示工程经 normalizeProject 往返后音色不丢（保存/打开/重启兼容）', () => {
    const copy = normalizeProject(JSON.parse(JSON.stringify(project)))
    assert.deepEqual(copy.tracks.map((track) => track.instrument?.preset ?? track.instrument?.kit), [
      'smp_acoustic', 'finger_bass', 'grand_piano', 'strings_ensemble', 'marimba', 'tine_epiano', 'concert_choir',
    ])
  })
})

/* ------------------------------------------------------------------------- */
/* P6：音频片段裁切偏移 offsetSeconds                                          */
/* ------------------------------------------------------------------------- */

describe('model P6 — 音频片段 offsetSeconds 裁切偏移', () => {
  it('normalizeClipOffset：默认/非法回 0、3 位小数、按媒体时长夹紧、未知时长上限 3600', () => {
    assert.equal(CLIP_OFFSET_MAX_SECONDS, 3600)
    assert.equal(normalizeClipOffset(undefined), 0)
    assert.equal(normalizeClipOffset(null), 0)
    assert.equal(normalizeClipOffset(''), 0)
    assert.equal(normalizeClipOffset(Number.NaN), 0)
    assert.equal(normalizeClipOffset(-1), 0)
    assert.equal(normalizeClipOffset('bad'), 0)
    assert.equal(normalizeClipOffset(0), 0)
    assert.equal(normalizeClipOffset(1.23456), 1.235)
    assert.equal(normalizeClipOffset(0.0004), 0)
    assert.equal(normalizeClipOffset(9999), 3600)
    // 媒体时长已知：上限 duration - 0.01
    assert.equal(normalizeClipOffset(5, { durationSeconds: 2 }), 1.99)
    assert.equal(normalizeClipOffset(1.5, { durationSeconds: 2 }), 1.5)
    assert.equal(normalizeClipOffset(1, { durationSeconds: 1 }), 0.99)
    // 时长未知/非法：按 3600 上限
    assert.equal(normalizeClipOffset(500, { durationSeconds: null }), 500)
    assert.equal(normalizeClipOffset(500, { durationSeconds: 'bad' }), 500)
  })

  it('makeClip 音频片段保留 offsetSeconds（默认 0/3 位小数）；pattern 片段忽略该字段', () => {
    const audio = makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 6, offsetSeconds: 1.23456 })
    assert.deepEqual(audio, {
      id: 'clip_1',
      trackId: 'trk_1',
      mediaId: 'med_1',
      startBar: 2,
      lengthBars: 6,
      offsetSeconds: 1.235,
    })
    const defaulted = makeClip({ id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1' })
    assert.equal(defaulted.offsetSeconds, 0)
    const invalid = makeClip({ id: 'clip_3', trackId: 'trk_1', mediaId: 'med_1', offsetSeconds: Number.NaN })
    assert.equal(invalid.offsetSeconds, 0)
    const pattern = makeClip({ id: 'clip_4', trackId: 'trk_2', patternId: 'pat_1', offsetSeconds: 3 })
    assert.equal(Object.hasOwn(pattern, 'offsetSeconds'), false)
    assert.equal(pattern.patternId, 'pat_1')
  })

  it('normalizeProject：音频片段 offset 按媒体时长夹紧、非法回 0；pattern 片段丢弃 offset；缺字段不写入', () => {
    const project = createEmptyProject()
    project.media = normalizeMediaList([{ id: 'med_1', name: 'a.wav', file: 'med_1.wav', durationSeconds: 2 }])
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'audio', name: '音频' }),
      makeTrack({ id: 'trk_2', preset: 'music_box' }),
    ]
    project.patterns = [{ id: 'pat_1', name: 'P', lengthBars: 4, notes: [] }]
    project.clips = [
      { id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, offsetSeconds: 9 },
      { id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 2, offsetSeconds: Number.NaN },
      { id: 'clip_3', trackId: 'trk_1', mediaId: 'med_1', startBar: 4, lengthBars: 2 }, // 旧片段：无 offset 字段
      { id: 'clip_4', trackId: 'trk_2', patternId: 'pat_1', startBar: 0, lengthBars: 4, offsetSeconds: 1.5 },
    ]
    normalizeProject(project)
    const byId = Object.fromEntries(project.clips.map((clip) => [clip.id, clip]))
    assert.equal(byId.clip_1.offsetSeconds, 1.99, '按媒体时长 2s 夹紧到 1.99')
    assert.equal(byId.clip_2.offsetSeconds, 0)
    assert.equal(Object.hasOwn(byId.clip_3, 'offsetSeconds'), false, '无 offset 字段时不写入')
    assert.equal(Object.hasOwn(byId.clip_4, 'offsetSeconds'), false, 'pattern 片段丢弃 offset')
    // 幂等
    const snapshot = JSON.stringify(project.clips)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.clips), snapshot)
  })

  it('normalizeProject：引用缺失媒体的音频片段仍被丢弃（带 offset 也不保留）', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'audio', name: '音频' })]
    project.clips = [{ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_404', startBar: 0, lengthBars: 2, offsetSeconds: 1 }]
    normalizeProject(project)
    assert.deepEqual(project.clips, [])
  })

  it('clipNotes 对带 offset 的音频片段仍返回 []（引擎单独处理）', () => {
    const project = createEmptyProject()
    const clip = { id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 4, offsetSeconds: 1.2 }
    assert.deepEqual(clipNotes(project, clip), [])
  })
})

/* ------------------------------------------------------------------------- */
/* P11：表达控制（延音踏板/揉弦）与导出历史                                     */
/* ------------------------------------------------------------------------- */

describe('model P11 — 延音踏板 / 揉弦 / 导出历史', () => {
  it('normalizeSustainPoints：clamp beat、排序去重、value 0/1、最多 256 点、非法丢弃', () => {
    assert.deepEqual(normalizeSustainPoints(null), [])
    assert.deepEqual(normalizeSustainPoints([null, 'x', [], { beat: 'bad' }]), [])
    const points = normalizeSustainPoints(
      [
        { beat: 8, value: 0.9 },
        { beat: 0, value: 1 },
        { beat: 4, value: 0.2 },
        { beat: 4, value: 1 }, // 同 beat 后者覆盖
        { beat: -5, value: 1 }, // clamp 到 0
        { beat: 99999, value: 0 }, // clamp 到 maxBeat
      ],
      { maxBeat: 64 },
    )
    assert.deepEqual(points, [
      { beat: 0, value: 1 },
      { beat: 4, value: 1 },
      { beat: 8, value: 1 },
      { beat: 64, value: 0 },
    ])
    // 3 位小数
    assert.deepEqual(normalizeSustainPoints([{ beat: 1.23456, value: 1 }]), [{ beat: 1.235, value: 1 }])
    // 上限 256
    const many = Array.from({ length: 300 }, (_, index) => ({ beat: index, value: index % 2 }))
    assert.equal(normalizeSustainPoints(many).length, SUSTAIN_MAX_POINTS)
    // 摘要
    assert.equal(SUSTAIN_MAX_POINTS, 256)
    assert.deepEqual(sustainSummary([{ beat: 0, value: 1 }, { beat: 8, value: 0 }]), {
      pointCount: 2,
      down: false,
      firstBeat: 0,
      lastBeat: 8,
    })
    assert.deepEqual(sustainSummary([{ beat: 0, value: 1 }, { beat: 8, value: 0 }], { includePoints: true }).points, [
      { beat: 0, value: 1 },
      { beat: 8, value: 0 },
    ])
    assert.equal(sustainSummary([]), null)
    assert.equal(sustainSummary(null), null)
  })

  it('normalizeVibrato：范围夹紧、缺省用默认、enabled bool、非法返回 null', () => {
    assert.deepEqual(VIBRATO_DEFAULTS, { rateHz: 5.5, depthCents: 15, enabled: true })
    assert.deepEqual([...VIBRATO_RANGES.rateHz], [0.1, 12])
    assert.deepEqual([...VIBRATO_RANGES.depthCents], [0, 100])
    assert.deepEqual(normalizeVibrato({}), { rateHz: 5.5, depthCents: 15, enabled: true })
    assert.deepEqual(normalizeVibrato({ rateHz: 99, depthCents: 999, enabled: false }), {
      rateHz: 12,
      depthCents: 100,
      enabled: false,
    })
    assert.deepEqual(normalizeVibrato({ rateHz: 0 }), { rateHz: 0.1, depthCents: 15, enabled: true })
    assert.deepEqual(normalizeVibrato({ rateHz: 6.789, depthCents: 12.345 }), {
      rateHz: 6.79,
      depthCents: 12.3,
      enabled: true,
    })
    assert.equal(normalizeVibrato(null), null)
    assert.equal(normalizeVibrato('x'), null)
    assert.equal(normalizeVibrato([]), null)
    assert.deepEqual(vibratoSummary({ rateHz: 3 }), { rateHz: 3, depthCents: 15, enabled: true })
  })

  it('makeTrack 不默认写入 sustain/vibrato；createEmptyProject 带 exportHistory: []', () => {
    const track = makeTrack({ id: 'trk_1', preset: 'grand_piano' })
    assert.equal(Object.hasOwn(track, 'sustain'), false)
    assert.equal(Object.hasOwn(track, 'vibrato'), false)
    const project = createEmptyProject()
    assert.deepEqual(project.exportHistory, [])
    assert.deepEqual(createDemoProject().exportHistory, [])
  })

  it('normalizeProject：sustain/vibrato 规范化、空/非法删除、缺省不写入、幂等', () => {
    const project = createEmptyProject({ lengthBars: 16 })
    project.tracks = [
      makeTrack({ id: 'trk_1', preset: 'grand_piano' }),
      makeTrack({ id: 'trk_2', preset: 'strings_ensemble' }),
      makeTrack({ id: 'trk_3', preset: 'finger_bass' }),
    ]
    project.tracks[0].sustain = [
      { beat: 8, value: 1 },
      { beat: 2, value: 1 },
      { beat: 64, value: 1 }, // maxBeat = 16*4 = 64
      { beat: 2, value: 0 }, // 同 beat 覆盖
    ]
    project.tracks[0].vibrato = { rateHz: 99, depthCents: -5, enabled: false }
    project.tracks[1].sustain = [] // 空 → 删除字段
    project.tracks[1].vibrato = 'bad' // 非法 → 删除字段
    // trk_3 无字段，不应新增
    normalizeProject(project)
    assert.deepEqual(project.tracks[0].sustain, [
      { beat: 2, value: 0 },
      { beat: 8, value: 1 },
      { beat: 64, value: 1 },
    ])
    assert.deepEqual(project.tracks[0].vibrato, { rateHz: 12, depthCents: 0, enabled: false })
    assert.equal(Object.hasOwn(project.tracks[1], 'sustain'), false)
    assert.equal(Object.hasOwn(project.tracks[1], 'vibrato'), false)
    assert.equal(Object.hasOwn(project.tracks[2], 'sustain'), false)
    assert.equal(Object.hasOwn(project.tracks[2], 'vibrato'), false)
    const snapshot = JSON.stringify(project.tracks)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.tracks), snapshot, '幂等')
  })

  it('normalizeExportHistory：过滤非法、最多 10 条、字段规范化、保持顺序', () => {
    assert.equal(EXPORT_HISTORY_LIMIT, 10)
    assert.deepEqual(normalizeExportHistory(null), [])
    assert.deepEqual(normalizeExportHistory([null, 'x', {}, { name: '  ' }]), [])
    const entry = normalizeExportHistoryEntry({ name: ' mix.wav ', format: 'stems', seconds: 3.456, bytes: 100.9, path: 'x/mix.wav', at: 123 })
    assert.deepEqual(entry, { name: 'mix.wav', format: 'stems', seconds: 3.46, bytes: 100, path: 'x/mix.wav', at: 123 })
    // 只有 path 也能生成 name
    const fromPath = normalizeExportHistoryEntry({ path: 'C:/data/exports/a.wav' })
    assert.equal(fromPath.name, 'a.wav')
    assert.equal(fromPath.format, 'wav')
    // P14b：mp3/flac 为合法格式；未知 format 归 wav
    assert.equal(normalizeExportHistoryEntry({ name: 'a', format: 'mp3' }).format, 'mp3')
    assert.equal(normalizeExportHistoryEntry({ name: 'a', format: 'flac' }).format, 'flac')
    assert.equal(normalizeExportHistoryEntry({ name: 'a', format: 'mp5' }).format, 'wav')
    const many = Array.from({ length: 15 }, (_, index) => ({
      name: `mix-${index}.wav`,
      format: 'wav',
      seconds: index,
      bytes: index,
      path: `mix-${index}.wav`,
      at: index,
    }))
    const limited = normalizeExportHistory(many)
    assert.equal(limited.length, 10)
    assert.equal(limited[0].name, 'mix-0.wav')
  })

  it('catalog P11：FX 15 种含 highshelf；reverb 增加 preDelay 规格', () => {
    assert.equal(FX_TYPES.length, 15)
    const highshelf = FX_TYPES.find((fx) => fx.id === 'highshelf')
    assert.ok(highshelf)
    assert.equal(highshelf.name, 'High Shelf')
    assert.equal(highshelf.label, '高频架')
    assert.equal(highshelf.category, '均衡')
    assert.match(highshelf.color, /^#[0-9A-Fa-f]{6}$/)
    assert.ok(/[\u4e00-\u9fa5]/.test(highshelf.desc))
    const specs = FX_PARAM_SPECS.highshelf
    assert.deepEqual(Object.keys(specs).sort(), ['freq', 'gain'])
    assert.deepEqual([specs.freq.min, specs.freq.max, specs.freq.default], [1000, 16000, 6000])
    assert.deepEqual([specs.gain.min, specs.gain.max, specs.gain.default], [-12, 12, 4])
    assert.equal(specs.gain.unit, 'dB')
    assert.deepEqual(fxDefaultParams('highshelf'), { freq: 6000, gain: 4 })
    // reverb preDelay
    const reverbSpecs = FX_PARAM_SPECS.reverb
    assert.deepEqual(Object.keys(reverbSpecs).sort(), ['damp', 'decay', 'mix', 'preDelay', 'size'])
    assert.deepEqual([reverbSpecs.preDelay.min, reverbSpecs.preDelay.max, reverbSpecs.preDelay.default], [0, 120, 20])
    assert.equal(reverbSpecs.preDelay.unit, 'ms')
    assert.equal(fxDefaultParams('reverb').preDelay, 20)
    // 钳制
    assert.equal(coerceParam(specs.freq, 99999), 16000)
    assert.equal(coerceParam(specs.gain, -99), -12)
    assert.equal(coerceParam(reverbSpecs.preDelay, 999), 120)
    assert.equal(coerceParam(reverbSpecs.preDelay, -1), 0)
  })
})

/* ------------------------------------------------------------------------- */
/* P12b：tempoMap 规范化                                                       */
/* ------------------------------------------------------------------------- */

describe('model P12b — tempoMap 规范化', () => {
  it('normalizeProject：排序/去重/bpm 与 beat 夹紧/非法丢弃/最多 64 点', () => {
    const project = createEmptyProject({ lengthBars: 8 }) // maxBeat = 32
    project.tempoMap = [
      { beat: 16, bpm: 180 },
      { beat: 0, bpm: 90 },
      { beat: 8, bpm: 999 },
      { beat: 8, bpm: 60 },
      { beat: -3, bpm: 120 },
      { beat: 99999, bpm: 30 },
      'bad',
      null,
    ]
    normalizeProject(project)
    assert.deepEqual(project.tempoMap, [
      { beat: 0, bpm: 90 },
      { beat: 8, bpm: 60 },
      { beat: 16, bpm: 180 },
      { beat: 32, bpm: 40 },
    ])
    // 上限 64 点
    project.tempoMap = Array.from({ length: 80 }, (_, index) => ({ beat: index * 0.1, bpm: 100 }))
    normalizeProject(project)
    assert.equal(project.tempoMap.length, 64)
  })

  it('缺省/空数组不写字段；幂等；常量 bpm 语义（无 tempoMap）', () => {
    const empty = createEmptyProject()
    assert.equal(Object.hasOwn(empty, 'tempoMap'), false)
    const project = createEmptyProject()
    project.tempoMap = []
    normalizeProject(project)
    assert.equal(Object.hasOwn(project, 'tempoMap'), false)
    project.tempoMap = [{ beat: 0, bpm: 100 }]
    normalizeProject(project)
    const snapshot = JSON.stringify(project.tempoMap)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.tempoMap), snapshot)
    assert.equal(project.bpm, 128, 'project.bpm 作为基准保留')
  })
})

/* ------------------------------------------------------------------------- */
/* P12b：tempo.js 纯函数（常量/线性 ramp/反解）                                */
/* ------------------------------------------------------------------------- */

describe('tempo P12b — createTempoMap 纯函数', () => {
  it('常量 BPM：与 60/bpm 完全一致，beat↔秒互逆', () => {
    const project = createEmptyProject({ bpm: 120, lengthBars: 8 })
    const tempo = createTempoMap(project)
    assert.equal(tempo.hasTempo, false)
    assert.equal(tempo.bpmAtBeat(0), 120)
    assert.equal(tempo.bpmAtBeat(16), 120)
    assert.equal(tempo.beatToSeconds(4), 2) // 4 beat @120 = 2s
    assert.equal(tempo.beatToSeconds(0), 0)
    assert.equal(tempo.secondsToBeat(2), 4)
    assert.equal(tempo.beatToSecondsRange(0, 8), 4)
    assert.equal(tempo.durationBeats, 32)
    // 带 tempoMap 但空数组 → 常量语义
    const withEmpty = createEmptyProject({ bpm: 90 })
    withEmpty.tempoMap = []
    assert.equal(createTempoMap(withEmpty).hasTempo, false)
  })

  it('线性 BPM ramp：中点插值、beat→秒闭式积分、秒→beat 反解', () => {
    const project = createEmptyProject({ bpm: 100, lengthBars: 8 })
    project.tempoMap = [{ beat: 0, bpm: 100 }, { beat: 16, bpm: 200 }]
    const tempo = createTempoMap(project)
    assert.equal(tempo.hasTempo, true)
    assert.equal(tempo.bpmAtBeat(0), 100)
    assert.equal(tempo.bpmAtBeat(8), 150)
    assert.equal(tempo.bpmAtBeat(16), 200)
    // 闭式积分：Δt = (60/slope) * ln(bpm2/bpm1)，slope = (200-100)/16
    const slope = (200 - 100) / 16
    const expected = (60 / slope) * Math.log(200 / 100)
    assert.ok(Math.abs(tempo.beatToSeconds(16) - expected) < 1e-9, `${tempo.beatToSeconds(16)} vs ${expected}`)
    // 反解互逆
    for (const beat of [0, 2.5, 8, 12.25, 16, 24]) {
      const seconds = tempo.beatToSeconds(beat)
      assert.ok(Math.abs(tempo.secondsToBeat(seconds) - beat) < 1e-6, `beat=${beat}`)
    }
    // 减速段：bpm 降到 50，同样 beat 数耗时更长
    const slow = createEmptyProject({ bpm: 100, lengthBars: 8 })
    slow.tempoMap = [{ beat: 0, bpm: 100 }, { beat: 16, bpm: 50 }]
    assert.ok(createTempoMap(slow).beatToSeconds(16) > expected)
  })

  it('normalizeTempoPoints：非法点丢弃、bpm 夹紧、同 beat 后者覆盖、上限', () => {
    assert.deepEqual(normalizeTempoPoints(null, { baseBpm: 120 }), [])
    assert.deepEqual(
      normalizeTempoPoints(
        [
          { beat: 8, bpm: 999 },
          { beat: 0, bpm: 90 },
          { beat: 8, bpm: 60 },
          { beat: -1, bpm: 120 },
          { beat: 'x', bpm: 100 },
          null,
        ],
        { baseBpm: 100, maxBeat: 32 },
      ),
      [{ beat: 0, bpm: 90 }, { beat: 8, bpm: 60 }],
    )
    const many = Array.from({ length: 80 }, (_, index) => ({ beat: index, bpm: 100 + (index % 100) }))
    assert.equal(normalizeTempoPoints(many, { baseBpm: 100, maxBeat: 1000 }).length, 64)
  })
})

/* ------------------------------------------------------------------------- */
/* P13：EQ3 全参数 / 表情自动化 / Master 默认                                   */
/* ------------------------------------------------------------------------- */

describe('model P13 — EQ3 全参数 / 表情自动化 / Master 默认', () => {
  it('eq3 spec：3 段 dB + lowFreq/midFreq/midQ/highFreq 范围与默认值', () => {
    const specs = FX_PARAM_SPECS.eq3
    assert.deepEqual(Object.keys(specs), ['low', 'lowFreq', 'mid', 'midFreq', 'midQ', 'high', 'highFreq'])
    assert.deepEqual([specs.lowFreq.min, specs.lowFreq.max, specs.lowFreq.default], [80, 800, 200])
    assert.deepEqual([specs.midFreq.min, specs.midFreq.max, specs.midFreq.default], [300, 5000, 1000])
    assert.deepEqual([specs.midQ.min, specs.midQ.max, specs.midQ.default], [0.3, 8, 1])
    assert.deepEqual([specs.highFreq.min, specs.highFreq.max, specs.highFreq.default], [2000, 16000, 8000])
    assert.equal(specs.lowFreq.unit, 'Hz')
    assert.equal(specs.midQ.unit, undefined)
    // 保留三段 dB 默认
    for (const key of ['low', 'mid', 'high']) {
      assert.deepEqual([specs[key].min, specs[key].max, specs[key].default], [-18, 18, 0])
    }
    // 默认参数完整 + 钳制
    assert.deepEqual(fxDefaultParams('eq3'), {
      low: 0, lowFreq: 200, mid: 0, midFreq: 1000, midQ: 1, high: 0, highFreq: 8000,
    })
    assert.equal(coerceParam(specs.lowFreq, 99999), 800)
    assert.equal(coerceParam(specs.midFreq, -5), 300)
    assert.equal(coerceParam(specs.midQ, 99), 8)
    assert.equal(coerceParam(specs.highFreq, 1), 2000)
  })

  it('defaultMaster 空链 / masteredMaster 母带链；空白工程默认空链、demo 保留母带', () => {
    const emptyMaster = defaultMaster()
    assert.equal(emptyMaster.volume, 0.82)
    assert.deepEqual(emptyMaster.effects, [])
    assert.deepEqual(createEmptyProject().master.effects, [])

    const demoMaster = masteredMaster()
    assert.equal(demoMaster.volume, 0.82)
    assert.deepEqual(demoMaster.effects.map((fx) => fx.type), ['eq3', 'compressor'])
    assert.equal(demoMaster.effects[0].params.low, 1.5)
    assert.equal(demoMaster.effects[0].params.lowFreq, 200, '演示 eq3 自动带 P13 新参数默认')
    assert.equal(demoMaster.effects[0].params.midQ, 1)

    const demo = createDemoProject()
    assert.deepEqual(demo.master.effects.map((fx) => fx.type), ['eq3', 'compressor'])
    assert.equal(demo.master.effects[0].params.highFreq, 8000)
    // 每次返回独立对象（可安全修改）
    const a = masteredMaster()
    a.effects[0].params.low = 9
    assert.equal(masteredMaster().effects[0].params.low, 1.5)
  })

  it('表情自动化映射与格式：pitchBend/modulation/expression', () => {
    const bend = AUTOMATION_PARAMS.pitchBend
    assert.equal(bend.map(0), -2)
    assert.equal(bend.map(0.5), 0)
    assert.equal(bend.map(1), 2)
    assert.equal(bend.map(2), 2) // clamp
    assert.equal(bend.map(-1), -2)
    assert.equal(bend.format(0), '-2.00 st')
    assert.equal(bend.format(0.75), '1.00 st')
    const modulation = AUTOMATION_PARAMS.modulation
    assert.equal(modulation.map(0), 0)
    assert.equal(modulation.map(0.5), 50)
    assert.equal(modulation.map(1), 100)
    assert.equal(modulation.format(0.25), '25 cents')
    const expression = AUTOMATION_PARAMS.expression
    assert.equal(expression.map(0), 0)
    assert.equal(expression.map(1), 1)
    assert.equal(expression.map(2), 1)
    assert.equal(expression.format(0.5), '50%')
  })

  it('normalizeAutomation 接受新参数曲线并丢弃未知参数；automationSummary 含新参数', () => {
    const project = createEmptyProject({ lengthBars: 8 }) // maxBeat 32
    const track = makeTrack({ id: 'trk_1', preset: 'grand_piano' })
    track.automation = {
      pitchBend: { enabled: true, points: [{ beat: 999, value: 0.5 }, { beat: 0, value: 0.25 }] },
      modulation: { points: [{ beat: 4, value: 0.8 }] },
      expression: { enabled: false, points: [{ beat: 8, value: 0.3 }] },
      unknownParam: { points: [{ beat: 1, value: 1 }] },
    }
    project.tracks = [track]
    normalizeProject(project)
    assert.deepEqual(Object.keys(track.automation).sort(), ['expression', 'modulation', 'pitchBend'])
    assert.deepEqual(track.automation.pitchBend.points, [
      { beat: 0, value: 0.25 },
      { beat: 32, value: 0.5 },
    ])
    assert.equal(track.automation.expression.enabled, false)
    const summary = automationSummary(track.automation)
    assert.deepEqual(Object.keys(summary).sort(), ['expression', 'modulation', 'pitchBend'])
    assert.equal(summary.modulation.pointCount, 1)
    // master 只允许 volume（normalize 时丢弃其它参数）
    project.master.automation = { volume: { points: [{ beat: 0, value: 1 }] }, pitchBend: { points: [{ beat: 0, value: 0 }] } }
    normalizeProject(project)
    assert.deepEqual(Object.keys(project.master.automation), ['volume'])
  })
})

describe('model P13 — 补充：eq3 默认合并 / master 独立引用 / 新自动化插值', () => {
  it('makeEffect(eq3) 合并 P13 新参数默认并保留自定义 dB/Q', () => {
    const fx = makeEffect('fx_9', 'eq3', { low: 2, midQ: 3.5 })
    assert.deepEqual(fx.params, {
      low: 2, lowFreq: 200, mid: 0, midFreq: 1000, midQ: 3.5, high: 0, highFreq: 8000,
    })
    const fx2 = makeEffect('fx_10', 'eq3', { lowFreq: 500, highFreq: 12000 })
    assert.equal(fx2.params.lowFreq, 500)
    assert.equal(fx2.params.highFreq, 12000)
    assert.equal(fx2.params.midFreq, 1000)
  })

  it('defaultMaster / masteredMaster 每次返回独立对象，effects 数组不共享', () => {
    const first = defaultMaster()
    const second = defaultMaster()
    first.effects.push({ id: 'fx_x', type: 'eq3' })
    assert.equal(second.effects.length, 0)
    const a = masteredMaster()
    const b = masteredMaster()
    a.effects[0].params.low = 9
    assert.equal(b.effects[0].params.low, 1.5)
    assert.notEqual(a.effects, b.effects)
  })

  it('projectStats：空白工程 master 空链 → effects 只统计轨道；demo 含母带链', () => {
    const empty = createEmptyProject()
    assert.equal(projectStats(empty).effects, 0)
    const demo = createDemoProject()
    const trackFx = demo.tracks.reduce((sum, track) => sum + track.effects.length, 0)
    assert.equal(projectStats(demo).effects, trackFx + 2)
  })

  it('automationValueAt 对新表情参数线性插值', () => {
    const curve = { points: [{ beat: 0, value: 0 }, { beat: 8, value: 1 }] }
    assert.equal(automationValueAt(curve, 0), 0)
    assert.equal(automationValueAt(curve, 4), 0.5)
    assert.equal(automationValueAt(curve, 8), 1)
    assert.equal(automationValueAt({ points: [] }, 4), null)
    // map 结果正确
    assert.equal(AUTOMATION_PARAMS.pitchBend.map(automationValueAt(curve, 4)), 0)
    assert.equal(AUTOMATION_PARAMS.modulation.map(automationValueAt(curve, 4)), 50)
  })

  it('eq3 新参数经 normalizeEffects 保留/合并默认（旧曲线数据也能加载）', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', preset: 'grand_piano', effects: [{ type: 'eq3', params: { low: 4 } }] })]
    normalizeProject(project)
    const eq3 = project.tracks[0].effects[0]
    assert.equal(eq3.type, 'eq3')
    assert.equal(eq3.params.low, 4)
    assert.equal(eq3.params.lowFreq, 200)
    assert.equal(eq3.params.highFreq, 8000)
    const snapshot = JSON.stringify(project.tracks[0].effects)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.tracks[0].effects), snapshot, '幂等')
  })

  it('AUTOMATION_PARAMS 新参数 hint/label 中文且仅轨道；master 自动化仍只 volume', () => {
    for (const param of ['pitchBend', 'modulation', 'expression']) {
      const spec = AUTOMATION_PARAMS[param]
      assert.ok(/[\u4e00-\u9fa5]/.test(spec.label))
      assert.ok(/[\u4e00-\u9fa5]/.test(spec.hint))
      assert.deepEqual(spec.targets, ['track'])
    }
    assert.deepEqual(AUTOMATION_PARAMS.volume.targets, ['track', 'master'])
  })
})

/* ------------------------------------------------------------------------- */
/* P14b：参考曲 reference 标记 / exportHistory 格式                            */
/* ------------------------------------------------------------------------- */

describe('model P14b — reference 轨 / 导出历史格式', () => {
  it('makeTrack 音频轨 reference：true 写字段、默认不写；其它轨道类型保留布尔', () => {
    const normal = makeTrack({ id: 'trk_1', kind: 'audio', name: '音频' })
    assert.equal(Object.hasOwn(normal, 'reference'), false)
    const reference = makeTrack({ id: 'trk_2', kind: 'audio', name: '参考', reference: true })
    assert.equal(reference.reference, true)
    const synth = makeTrack({ id: 'trk_3', preset: 'grand_piano' })
    assert.equal(Object.hasOwn(synth, 'reference'), false)
    const synthRef = makeTrack({ id: 'trk_4', preset: 'grand_piano', reference: true })
    assert.equal(synthRef.reference, true, '显式 true 保留（UI/工具一般只给音频轨）')
  })

  it('normalizeProject：reference true 保留、false/非 true 删除；幂等', () => {
    const project = createEmptyProject()
    const audio = makeTrack({ id: 'trk_1', kind: 'audio', name: '音频' })
    const ref = makeTrack({ id: 'trk_2', kind: 'audio', name: '参考', reference: true })
    ref.reference = true
    audio.reference = false
    project.tracks = [audio, ref]
    normalizeProject(project)
    assert.equal(Object.hasOwn(audio, 'reference'), false)
    assert.equal(ref.reference, true)
    const snapshot = JSON.stringify(project.tracks)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.tracks), snapshot, '幂等')
    // 非布尔 truthy 不保留
    project.tracks[1].reference = 'yes'
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[1], 'reference'), false)
  })

  it('createEmptyProject / demo 默认没有 reference 字段', () => {
    assert.ok(createEmptyProject().tracks.every((track) => !Object.hasOwn(track, 'reference')))
    assert.ok(createDemoProject().tracks.every((track) => !Object.hasOwn(track, 'reference')))
  })

  it('normalizeExportHistoryEntry：mp3/flac 保留，未知格式回 wav；历史上限 10', () => {
    assert.equal(normalizeExportHistoryEntry({ name: 'a.mp3', format: 'mp3' }).format, 'mp3')
    assert.equal(normalizeExportHistoryEntry({ name: 'a.flac', format: 'flac' }).format, 'flac')
    assert.equal(normalizeExportHistoryEntry({ name: 'a.ogg', format: 'ogg' }).format, 'wav')
    assert.equal(normalizeExportHistoryEntry({ name: 'a.wav', format: 'stems' }).format, 'stems')
    const history = Array.from({ length: 15 }, (_, index) => ({
      name: 'mix-' + index + '.' + (index % 2 === 0 ? 'mp3' : 'flac'),
      format: index % 2 === 0 ? 'mp3' : 'flac',
      seconds: index,
      bytes: index,
      path: 'mix-' + index,
      at: index,
    }))
    const normalized = normalizeExportHistory(history)
    assert.equal(normalized.length, EXPORT_HISTORY_LIMIT)
    assert.equal(normalized[0].format, 'mp3')
    assert.equal(normalized[1].format, 'flac')
  })

  it('normalizeProject 保留 tempoMap 与 reference 共存', () => {
    const project = createDemoProject()
    const referenceTrack = makeTrack({ id: 'trk_ref', kind: 'audio', name: '参考曲', reference: true })
    project.tracks.push(referenceTrack)
    project.clips.push(makeClip({ id: 'clip_ref', trackId: 'trk_ref', mediaId: 'med_missing', startBar: 0, lengthBars: 1 }))
    // media 不存在时音频片段会被丢弃，但轨道 reference 标记仍保留
    normalizeProject(project)
    assert.equal(project.tracks.find((track) => track.id === 'trk_ref').reference, true)
  })
})

/* ------------------------------------------------------------------------- */
/* R0A：导出任务 exportJobs 规范化                                             */
/* ------------------------------------------------------------------------- */

describe('model R0A — exportJobs 导出任务历史', () => {
  it('normalizeExportJob：合法字段保留、非法/未知状态与格式回退', () => {
    const job = normalizeExportJob({
      jobId: ' job_abc ',
      status: 'success',
      format: 'mp3',
      name: ' mix.mp3 ',
      path: 'C:/exports/mix.mp3',
      outputDir: 'C:/exports',
      bytes: 1234.7,
      seconds: 3.456,
      startedAt: 111,
      finishedAt: 222,
    })
    assert.equal(job.jobId, 'job_abc')
    assert.equal(job.status, 'success')
    assert.equal(job.format, 'mp3')
    assert.equal(job.name, 'mix.mp3')
    assert.equal(job.path, 'C:/exports/mix.mp3')
    assert.equal(job.outputDir, 'C:/exports')
    assert.equal(job.bytes, 1235)
    assert.equal(job.seconds, 3.46)
    assert.equal(job.startedAt, 111)
    assert.equal(job.finishedAt, 222)
    // 非法状态/格式回退，缺 jobId → null
    const fallback = normalizeExportJob({ jobId: 'job_2', status: 'weird', format: 'ogg' })
    assert.equal(fallback.status, 'pending')
    assert.equal(fallback.format, 'wav')
    assert.equal(normalizeExportJob({ status: 'success' }), null)
    assert.equal(normalizeExportJob(null), null)
    assert.equal(normalizeExportJob([]), null)
    // error 只在 error 状态保留
    assert.equal(normalizeExportJob({ jobId: 'job_3', status: 'error', error: '渲染失败' }).error, '渲染失败')
    assert.equal(Object.hasOwn(normalizeExportJob({ jobId: 'job_4', status: 'pending', error: 'ignored' }), 'error'), false)
  })

  it('normalizeExportJobs：最多 10 条、保持顺序、跳过非法项', () => {
    const jobs = Array.from({ length: 15 }, (_, index) => ({ jobId: 'job_' + index, status: 'success', format: 'wav' }))
    const normalized = normalizeExportJobs(jobs)
    assert.equal(normalized.length, EXPORT_JOB_LIMIT)
    assert.equal(normalized[0].jobId, 'job_0')
    assert.equal(normalized[9].jobId, 'job_9')
    assert.deepEqual(normalizeExportJobs([null, {}, { jobId: 'ok' }]).map((job) => job.jobId), ['ok'])
    assert.deepEqual(normalizeExportJobs('bad'), [])
  })

  it('createEmptyProject / createDemoProject：导出任务与历史默认为空数组', () => {
    const empty = createEmptyProject()
    assert.deepEqual(empty.exportJobs, [])
    assert.deepEqual(empty.exportHistory, [])
    const demo = createDemoProject()
    normalizeProject(demo)
    assert.deepEqual(demo.exportJobs, [])
  })

  it('normalizeProject：exportJobs 防御性规范化（保留合法、丢弃垃圾、限制 10 条）', () => {
    const project = createEmptyProject()
    project.exportJobs = [
      { jobId: 'job_a', status: 'success', format: 'flac', path: 'a.flac', bytes: 10, seconds: 1.2 },
      null,
      { jobId: '', status: 'success' },
      { jobId: 'job_b', status: 'error', error: 'boom' },
      ...Array.from({ length: 12 }, (_, index) => ({ jobId: 'job_x' + index, status: 'pending' })),
    ]
    normalizeProject(project)
    assert.equal(project.exportJobs.length, EXPORT_JOB_LIMIT)
    assert.equal(project.exportJobs[0].jobId, 'job_a')
    assert.equal(project.exportJobs[0].format, 'flac')
    assert.equal(project.exportJobs[1].jobId, 'job_b')
    assert.equal(project.exportJobs[1].error, 'boom')
    assert.ok(project.exportJobs.every((job) => typeof job.jobId === 'string' && job.jobId !== ''))
  })

  it('normalizeProject 幂等：exportJobs 二次规范化不变', () => {
    const project = createEmptyProject()
    project.exportJobs = [
      { jobId: 'job_1', status: 'success', format: 'mp3', name: 'a.mp3', path: 'a.mp3', bytes: 5, seconds: 1, startedAt: 1, finishedAt: 2 },
    ]
    normalizeProject(project)
    const snapshot = JSON.stringify(project.exportJobs)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.exportJobs), snapshot)
  })
})

/* ------------------------------------------------------------------------- */
/* task-75：tempo 时长积分 / 摘要契约                                          */
/* ------------------------------------------------------------------------- */

describe('model task-75 — projectStats 时长与摘要', () => {
  it('常量 BPM：durationSeconds = 小节*每小节beats/BPM（与旧算法一致，无 estimated）', () => {
    const project = createEmptyProject({ bpm: 120, lengthBars: 4 })
    project.bpm = 120
    project.lengthBars = 4
    const stats = projectStats(project)
    assert.equal(stats.durationSeconds, 8, '4 小节 4/4 @120BPM = 8 秒')
    assert.equal(Object.hasOwn(stats, 'estimated'), false)
    assert.equal(Object.hasOwn(stats, 'durationSource'), false)
  })

  it('tempoMap 积分：速度变化时按积分计算（120→60BPM 中段变速）', () => {
    const project = createEmptyProject({ bpm: 120, lengthBars: 32 })
    project.bpm = 120
    project.lengthBars = 32
    project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 64, bpm: 60 }]
    normalizeProject(project)
    const stats = projectStats(project)
    // 前 64 beat 中 BPM 从 120 线性降到 60，之后 64 beat 保持 60。
    assert.ok(stats.durationSeconds > 40 && stats.durationSeconds < 110, String(stats.durationSeconds))
    assert.equal(stats.durationSource, 'tempoMap')
    assert.equal(Object.hasOwn(stats, 'estimated'), false)
    // 与 tempo.js 积分（取整）一致
    assert.equal(stats.durationSeconds, Math.round(projectDurationSeconds(project)))
  })

  it('tempoMap 恒定点 = 常量 BPM 结果（线性插值不引入偏差）', () => {
    const base = createEmptyProject({ bpm: 100, lengthBars: 8 })
    base.bpm = 100
    base.lengthBars = 8
    const withTempo = structuredClone(base)
    withTempo.tempoMap = [{ beat: 0, bpm: 100 }]
    assert.equal(projectStats(withTempo).durationSeconds, projectStats(base).durationSeconds)
  })

  it('无法积分（lengthBars=0）时退回常量算法并标 estimated:true', () => {
    const project = createEmptyProject()
    project.lengthBars = 0
    const stats = projectStats(project)
    assert.equal(stats.estimated, true)
    assert.ok(Number.isFinite(stats.durationSeconds))
  })

  it('durationSource 仅在 tempoMap 非空时出现；estimated 仅无法计算时出现', () => {
    const project = createEmptyProject({ bpm: 90, lengthBars: 2 })
    project.bpm = 90
    project.lengthBars = 2
    const plain = projectStats(project)
    assert.equal(Object.hasOwn(plain, 'durationSource'), false)
    assert.equal(Object.hasOwn(plain, 'estimated'), false)
    project.tempoMap = [{ beat: 0, bpm: 90 }, { beat: 8, bpm: 180 }]
    const tempo = projectStats(project)
    assert.equal(tempo.durationSource, 'tempoMap')
    assert.equal(Object.hasOwn(tempo, 'estimated'), false)
  })

  it('摘要默认不含 points，includePoints 才全量（sustain/automation）', () => {
    const sustain = [{ beat: 0, value: 1 }, { beat: 8, value: 1 }, { beat: 12, value: 0 }]
    const summary = sustainSummary(sustain)
    assert.deepEqual(Object.keys(summary).sort(), ['down', 'firstBeat', 'lastBeat', 'pointCount'])
    assert.equal(summary.down, false)
    assert.equal(summary.pointCount, 3)
    assert.equal(summary.firstBeat, 0)
    assert.equal(summary.lastBeat, 12)
    const full = sustainSummary(sustain, { includePoints: true })
    assert.deepEqual(full.points, sustain)

    const automation = { volume: { points: sustain.map((point) => ({ beat: point.beat, value: point.value })) } }
    const autoSummary = automationSummary(automation)
    assert.deepEqual(autoSummary.volume, { enabled: true, pointCount: 3, firstBeat: 0, lastBeat: 12 })
    assert.deepEqual(automationSummary(automation, { includePoints: true }).volume.points, [
      { beat: 0, value: 1 },
      { beat: 8, value: 1 },
      { beat: 12, value: 0 },
    ])
  })
})

describe('model task-75 — 补充边界', () => {
  it('projectStats：多段 tempo 积分与 durationSource/estimated 组合', () => {
    const project = createEmptyProject({ bpm: 120, lengthBars: 16 })
    project.bpm = 120
    project.lengthBars = 16
    project.tempoMap = [{ beat: 0, bpm: 60 }, { beat: 32, bpm: 120 }, { beat: 48, bpm: 180 }]
    normalizeProject(project)
    const stats = projectStats(project)
    assert.equal(stats.durationSource, 'tempoMap')
    assert.equal(Object.hasOwn(stats, 'estimated'), false)
    assert.equal(stats.durationSeconds, Math.round(projectDurationSeconds(project)))
    assert.ok(stats.durationSeconds > 0)
  })

  it('projectStats：单点 tempoMap 等同于常量 BPM', () => {
    const project = createEmptyProject({ bpm: 140, lengthBars: 8 })
    project.bpm = 140
    project.lengthBars = 8
    project.tempoMap = [{ beat: 16, bpm: 140 }]
    const withPoint = projectStats(project).durationSeconds
    project.tempoMap = []
    const withoutPoint = projectStats(project).durationSeconds
    assert.equal(withPoint, withoutPoint)
  })

  it('automationSummary：enabled=false 保留；无点曲线也给 pointCount=0', () => {
    const summary = automationSummary({ volume: { enabled: false, points: [] }, pan: { points: [{ beat: 2, value: 0.4 }] } })
    assert.deepEqual(summary.volume, { enabled: false, pointCount: 0 })
    assert.deepEqual(summary.pan, { enabled: true, pointCount: 1, firstBeat: 2, lastBeat: 2 })
    assert.deepEqual(automationSummary({ volume: { enabled: false, points: [] } }, { includePoints: true }).volume, {
      enabled: false,
      pointCount: 0,
      points: [],
    })
  })
})

/* ------------------------------------------------------------------------- */
/* R0-12：侧链 triggerNotes 触发音符过滤                                        */
/* ------------------------------------------------------------------------- */

describe('model R0-12 — sidechain triggerNotes', () => {
  it('常量：最多 16 个、MIDI 0..127', () => {
    assert.equal(SIDECHAIN_MAX_TRIGGER_NOTES, 16)
    assert.deepEqual([...SIDECHAIN_NOTE_RANGE], [0, 127])
  })

  it('normalizeSidechainTriggerNotes：单数/数组/去重排序/非法过滤/上限', () => {
    assert.deepEqual(normalizeSidechainTriggerNotes(undefined), [])
    assert.deepEqual(normalizeSidechainTriggerNotes(null), [])
    assert.deepEqual(normalizeSidechainTriggerNotes([]), [])
    assert.deepEqual(normalizeSidechainTriggerNotes(36), [36])
    assert.deepEqual(normalizeSidechainTriggerNotes([38, 36, 36, 42, 36]), [36, 38, 42])
    // 非整数/越界/非数字/NaN 过滤
    assert.deepEqual(normalizeSidechainTriggerNotes([36, '38', 36.5, -1, 200, Number.NaN, null, {}]), [36])
    // 上限 16：取排序后的前 16 个
    const many = Array.from({ length: 20 }, (_, index) => index + 30)
    const capped = normalizeSidechainTriggerNotes(many)
    assert.equal(capped.length, 16)
    assert.deepEqual(capped, many.slice(0, 16))
    // 字符串单数不合法 → []
    assert.deepEqual(normalizeSidechainTriggerNotes('36'), [])
  })

  it('normalizeSidechain：默认 triggerNotes=[]；[36] 保留；非法过滤', () => {
    assert.deepEqual(normalizeSidechain({ sourceTrackId: 'trk_1' }).triggerNotes, [])
    assert.deepEqual(normalizeSidechain({ sourceTrackId: 'trk_1', triggerNotes: [38, 36, 36] }).triggerNotes, [36, 38])
    assert.deepEqual(normalizeSidechain({ sourceTrackId: 'trk_1', triggerNotes: 36 }).triggerNotes, [36])
    assert.deepEqual(normalizeSidechain({ sourceTrackId: 'trk_1', triggerNotes: ['x', 200] }).triggerNotes, [])
    assert.deepEqual(normalizeSidechain({ sourceTrackId: 'trk_1', triggerNotes: [] }).triggerNotes, [])
  })

  it('sidechainSummary 含 triggerNotes（旧对象缺字段回 []）', () => {
    const summary = sidechainSummary({ sourceTrackId: 'trk_1', amount: 0.5, triggerNotes: [36] })
    assert.deepEqual(summary.triggerNotes, [36])
    assert.deepEqual(summary.amount, 0.5)
    assert.deepEqual(sidechainSummary({ sourceTrackId: 'trk_1' }).triggerNotes, [])
  })

  it('旧工程兼容：normalizeProject 给缺 triggerNotes 的侧链补 []，幂等', () => {
    const project = createEmptyProject({ lengthBars: 8 })
    const kick = makeTrack({ id: 'trk_1', name: 'Kick', kind: 'drum', kit: 'smp_acoustic' })
    const bass = makeTrack({ id: 'trk_2', name: 'Bass', kind: 'synth', preset: 'finger_bass' })
    bass.sidechain = { sourceTrackId: 'trk_1', amount: 0.6 }
    project.tracks = [kick, bass]
    normalizeProject(project)
    assert.deepEqual(bass.sidechain.triggerNotes, [])
    const snapshot = JSON.stringify(project)
    normalizeProject(project)
    assert.equal(JSON.stringify(project), snapshot)
    // 非法 triggerNotes 被规范化
    bass.sidechain.triggerNotes = [36, 999, 'x', 36]
    normalizeProject(project)
    assert.deepEqual(bass.sidechain.triggerNotes, [36])
  })

  it('makeTrack 侧链保留 triggerNotes', () => {
    const track = makeTrack({
      id: 'trk_2',
      name: 'Bass',
      kind: 'synth',
      preset: 'finger_bass',
      sidechain: { sourceTrackId: 'trk_1', triggerNotes: [36, 38] },
    })
    assert.deepEqual(track.sidechain.triggerNotes, [36, 38])
    const plain = makeTrack({ id: 'trk_3', name: 'Plain', kind: 'synth', preset: 'music_box', sidechain: { sourceTrackId: 'trk_1' } })
    assert.deepEqual(plain.sidechain.triggerNotes, [])
  })
})

/* ------------------------------------------------------------------------- */
/* R1b：schema v3 / format 元信息 / v2→v3 迁移                                 */
/* ------------------------------------------------------------------------- */

describe('model R1b — schemaVersion 3 + v2 迁移', () => {
  it('常量：SCHEMA_VERSION=3、format.name=aims、仅 v2 可迁移', () => {
    assert.equal(SCHEMA_VERSION, 3)
    assert.equal(PROJECT_FORMAT_NAME, 'aims')
    assert.deepEqual([...MIGRATABLE_SCHEMA_VERSIONS], [2])
  })

  it('createProjectFormat / normalizeProjectFormat：默认/合法迁移字段/非法修复', () => {
    assert.deepEqual(createProjectFormat(), { name: 'aims', version: 3 })
    assert.deepEqual(createProjectFormat({ migratedFrom: 2, migratedAt: 123 }), {
      name: 'aims',
      version: 3,
      migratedFrom: 2,
      migratedAt: 123,
    })
    // 非法 name/version 一律强制为标准值；非法迁移字段丢弃
    assert.deepEqual(normalizeProjectFormat({ name: 'other', version: 99, migratedFrom: 'x', migratedAt: -5 }), {
      name: 'aims',
      version: 3,
    })
    assert.deepEqual(normalizeProjectFormat({ name: 'aims', version: 3, migratedFrom: 2, migratedAt: 456 }), {
      name: 'aims',
      version: 3,
      migratedFrom: 2,
      migratedAt: 456,
    })
    assert.deepEqual(normalizeProjectFormat(null), { name: 'aims', version: 3 })
    assert.deepEqual(normalizeProjectFormat('bad'), { name: 'aims', version: 3 })
  })

  it('migrateProjectV2toV3：写 format.migratedFrom/At、不修改入参、v3 幂等、v1 抛错', () => {
    const v2 = createEmptyProject()
    v2.schemaVersion = 2
    delete v2.format
    v2.title = 'v2 工程'
    const migrated = migrateProjectV2toV3(v2, { now: 1700000000000 })
    assert.equal(migrated.schemaVersion, 3)
    assert.deepEqual(migrated.format, {
      name: 'aims',
      version: 3,
      migrationWarnings: ['预设响度已归一化，请重新配平混音（检查 master/轨道音量与 headroom）'],
      migratedFrom: 2,
      migratedAt: 1700000000000,
    })
    assert.equal(migrated.title, 'v2 工程')
    assert.equal(v2.schemaVersion, 2, '迁移 helper 不修改入参')
    assert.equal(Object.hasOwn(v2, 'format'), false)
    // v3 幂等（返回克隆 + 规范化 format）
    const v3 = createEmptyProject()
    const again = migrateProjectV2toV3(v3)
    assert.equal(again.schemaVersion, 3)
    assert.deepEqual(again.format, { name: 'aims', version: 3 })
    assert.notEqual(again, v3)
    // v1/其它拒绝
    for (const version of [1, 0, undefined, null]) {
      assert.throws(() => migrateProjectV2toV3({ schemaVersion: version }), SchemaVersionError)
    }
  })

  it('normalizeProject：v2 就地迁移为 3 + format；再次 normalize 幂等', () => {
    const v2 = createEmptyProject()
    v2.schemaVersion = 2
    delete v2.format
    v2.title = '迁移工程'
    const normalized = normalizeProject(v2)
    assert.equal(normalized, v2)
    assert.equal(v2.schemaVersion, 3)
    assert.equal(v2.format.name, 'aims')
    assert.equal(v2.format.version, 3)
    assert.equal(v2.format.migratedFrom, 2)
    assert.ok(Number.isFinite(v2.format.migratedAt))
    const snapshot = JSON.stringify(v2.format)
    normalizeProject(v2)
    assert.equal(JSON.stringify(v2.format), snapshot, '幂等')
  })

  it('normalizeProject：v3 缺失/非法 format 自动补正，不改变内容', () => {
    const project = createEmptyProject()
    delete project.format
    project.title = '无 format'
    normalizeProject(project)
    assert.deepEqual(project.format, { name: 'aims', version: 3 })
    assert.equal(project.title, '无 format')
    project.format = { name: 'bad', version: 2, migratedFrom: 9, migratedAt: 'x' }
    normalizeProject(project)
    assert.deepEqual(project.format, { name: 'aims', version: 3 })
  })

  it('v1/missing schemaVersion 仍抛 SchemaVersionError（不迁移）', () => {
    for (const version of [1, 0, undefined, null]) {
      const project = createEmptyProject()
      project.schemaVersion = version
      assert.throws(
        () => normalizeProject(project),
        (error) => error instanceof SchemaVersionError && error.code === 'UNSUPPORTED_SCHEMA',
      )
    }
  })

  it('demo/空工程/迁移后工程 format 都符合 v3', () => {
    for (const project of [createEmptyProject(), createDemoProject()]) {
      assert.equal(project.schemaVersion, 3)
      assert.equal(project.format.name, 'aims')
      assert.equal(project.format.version, 3)
    }
  })
})

describe('model R1b — 补充边界', () => {
  it('migrateProjectV2toV3：字符串 schemaVersion "2" 按 v2 迁移；其余字符串拒绝', () => {
    const v2 = createEmptyProject()
    v2.schemaVersion = '2'
    const migrated = migrateProjectV2toV3(v2, { now: 5 })
    assert.equal(migrated.schemaVersion, 3)
    assert.equal(migrated.format.migratedFrom, 2)
    assert.equal(migrated.format.migratedAt, 5)
    assert.throws(() => migrateProjectV2toV3({ schemaVersion: '1' }), SchemaVersionError)
  })

  it('createProjectFormat：非法 migratedFrom（≥当前版本/0/字符串）丢弃，合法旧版本保留', () => {
    assert.deepEqual(createProjectFormat({ migratedFrom: 9 }), { name: 'aims', version: 3 })
    assert.deepEqual(createProjectFormat({ migratedFrom: 0 }), { name: 'aims', version: 3 })
    assert.deepEqual(createProjectFormat({ migratedFrom: 'x' }), { name: 'aims', version: 3 })
    assert.deepEqual(createProjectFormat({ migratedFrom: 1, migratedAt: 1 }), { name: 'aims', version: 3, migratedFrom: 1, migratedAt: 1 })
  })

  it('normalizeProjectFormat：version 错误也强制为 3；migratedFrom 保留合法值', () => {
    const normalized = normalizeProjectFormat({ name: 'AIMS', version: 2, migratedFrom: 2, migratedAt: 999 })
    assert.deepEqual(normalized, { name: 'aims', version: 3, migratedFrom: 2, migratedAt: 999 })
  })

  it('MIGRATABLE_SCHEMA_VERSIONS 冻结且不含 1/3', () => {
    assert.equal(Object.isFrozen(MIGRATABLE_SCHEMA_VERSIONS), true)
    assert.equal(MIGRATABLE_SCHEMA_VERSIONS.includes(1), false)
    assert.equal(MIGRATABLE_SCHEMA_VERSIONS.includes(3), false)
    assert.equal(MIGRATABLE_SCHEMA_VERSIONS.includes(2), true)
  })
})

/* ------------------------------------------------------------------------- */
/* R2a：音频 clip gain / fade / reverse 模型                                   */
/* ------------------------------------------------------------------------- */

describe('model R2a — 音频片段字段 normalize', () => {
  function audioProject({ mediaDuration = 10, bpm = 128, lengthBars = 16, timeSignature = [4, 4] } = {}) {
    const project = createEmptyProject({ bpm, lengthBars, timeSignature })
    const track = makeTrack({ id: 'trk_1', kind: 'audio', name: '音频' })
    project.tracks = [track]
    project.media = [makeMedia({ id: 'med_1', name: 'a.wav', file: 'a.wav', bytes: 100, durationSeconds: mediaDuration })]
    return project
  }

  it('常量范围：gainDb -24..24、fade 0..10', () => {
    assert.equal(AUDIO_CLIP_GAIN_DB_MIN, -24)
    assert.equal(AUDIO_CLIP_GAIN_DB_MAX, 24)
    assert.equal(AUDIO_CLIP_FADE_MAX_SECONDS, 10)
  })

  it('normalizeAudioClipGainDb：1 位小数、夹紧、0 省略语义、非法回 0', () => {
    assert.equal(normalizeAudioClipGainDb(-6.04), -6)
    assert.equal(normalizeAudioClipGainDb(-6.06), -6.1)
    assert.equal(normalizeAudioClipGainDb(99), 24)
    assert.equal(normalizeAudioClipGainDb(-99), -24)
    assert.equal(normalizeAudioClipGainDb('bad'), 0)
    assert.equal(normalizeAudioClipGainDb(0.01), 0, '四舍五入为 0 时省略')
  })

  it('normalizeAudioClipFadeSeconds：3 位小数、0..10 夹紧、0/非法回 0', () => {
    assert.equal(normalizeAudioClipFadeSeconds(1.23456), 1.235)
    assert.equal(normalizeAudioClipFadeSeconds(99), 10)
    assert.equal(normalizeAudioClipFadeSeconds(-1), 0)
    assert.equal(normalizeAudioClipFadeSeconds('x'), 0)
    assert.equal(normalizeAudioClipFadeSeconds(0), 0)
  })

  it('normalizeAudioClipReverse：仅 true', () => {
    assert.equal(normalizeAudioClipReverse(true), true)
    assert.equal(normalizeAudioClipReverse(false), false)
    assert.equal(normalizeAudioClipReverse('true'), false)
    assert.equal(normalizeAudioClipReverse(1), false)
  })

  it('makeClip：音频片段默认无新字段；有值时写入并规范化', () => {
    const project = audioProject()
    const plain = makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2 })
    for (const field of ['gainDb', 'fadeInSeconds', 'fadeOutSeconds', 'reverse']) assert.equal(Object.hasOwn(plain, field), false)
    const rich = makeClip({
      id: 'clip_2',
      trackId: 'trk_1',
      mediaId: 'med_1',
      startBar: 0,
      lengthBars: 2,
      gainDb: -6.06,
      fadeInSeconds: 1.2345,
      fadeOutSeconds: 0.5,
      reverse: true,
    })
    assert.equal(rich.gainDb, -6.1)
    assert.equal(rich.fadeInSeconds, 1.235)
    assert.equal(rich.fadeOutSeconds, 0.5)
    assert.equal(rich.reverse, true)
    void project
  })

  it('normalizeProject：音频片段字段规范化；pattern 片段删除这些字段；幂等', () => {
    const project = audioProject()
    project.clips = [
      makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, gainDb: -6, fadeInSeconds: 1, fadeOutSeconds: 1, reverse: true }),
      { id: 'clip_2', trackId: 'trk_1', patternId: 'pat_x', startBar: 2, lengthBars: 2, gainDb: -3, fadeInSeconds: 1, reverse: true, offsetSeconds: 1 },
    ]
    // pattern 片段需要 pattern 存在，否则会被过滤；补一个 pattern 并换成 pattern clip
    project.patterns = [makePattern({ id: 'pat_x', name: 'p', lengthBars: 2, notes: [] })]
    project.clips[1] = { id: 'clip_2', trackId: 'trk_1', patternId: 'pat_x', startBar: 2, lengthBars: 2, gainDb: -3, fadeInSeconds: 1, reverse: true, offsetSeconds: 1 }
    normalizeProject(project)
    const audioClip = project.clips.find((clip) => clip.id === 'clip_1')
    assert.equal(audioClip.gainDb, -6)
    assert.ok(audioClip.fadeInSeconds > 0)
    assert.equal(audioClip.reverse, true)
    const patternClip = project.clips.find((clip) => clip.id === 'clip_2')
    for (const field of ['gainDb', 'fadeInSeconds', 'fadeOutSeconds', 'reverse', 'offsetSeconds']) {
      assert.equal(Object.hasOwn(patternClip, field), false, `pattern 片段不应有 ${field}`)
    }
    const snapshot = JSON.stringify(project.clips)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.clips), snapshot)
  })

  it('v3 老工程 clip 无新字段：normalize 后保持无字段（兼容）', () => {
    const project = audioProject()
    project.clips = [makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2 })]
    normalizeProject(project)
    const clip = project.clips[0]
    assert.equal(Object.hasOwn(clip, 'gainDb'), false)
    assert.equal(Object.hasOwn(clip, 'fadeInSeconds'), false)
    assert.equal(Object.hasOwn(clip, 'reverse'), false)
  })

  it('fadeIn+fadeOut 超过可播放时长：按比例缩放且总和 ≤ 可播放时长', () => {
    const project = audioProject({ mediaDuration: 100, bpm: 120 })
    // 2 小节 @120BPM = 4s；fade 各 4s，总和 8 > 4 → 比例缩放至各 2s
    project.clips = [makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, fadeInSeconds: 4, fadeOutSeconds: 4 })]
    normalizeProject(project)
    const clip = project.clips[0]
    assert.ok(clip.fadeInSeconds + clip.fadeOutSeconds <= audioClipPlayableSeconds(project, clip) + 1e-9)
    assert.equal(clip.fadeInSeconds, 2)
    assert.equal(clip.fadeOutSeconds, 2)
  })

  it('媒体剩余时长小于片段长度：playable 取媒体剩余，fade 按比例夹紧', () => {
    const project = audioProject({ mediaDuration: 2.5, bpm: 120 })
    // 4 小节 @120 = 8s，但媒体只有 2.5s（offset 0.5 → 剩余 2s）
    project.clips = [makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 4, offsetSeconds: 0.5, fadeInSeconds: 2, fadeOutSeconds: 2 })]
    normalizeProject(project)
    const clip = project.clips[0]
    assert.equal(audioClipPlayableSeconds(project, clip), 2)
    assert.ok(clip.fadeInSeconds + clip.fadeOutSeconds <= 2 + 1e-9)
  })

  it('媒体时长未知：fade 仍允许（按片段长度），playable=片段秒数', () => {
    const project = audioProject({ mediaDuration: null, bpm: 120 })
    delete project.media[0].durationSeconds
    project.clips = [makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, fadeInSeconds: 1, fadeOutSeconds: 1 })]
    normalizeProject(project)
    const clip = project.clips[0]
    assert.equal(audioClipPlayableSeconds(project, clip), 4)
    assert.equal(clip.fadeInSeconds, 1)
    assert.equal(clip.fadeOutSeconds, 1)
  })

  it('audioClipLengthSeconds 按 tempoMap 积分（tempo 变化时与常量 BPM 不同）', () => {
    const project = audioProject({ mediaDuration: 100, bpm: 120 })
    const constant = audioClipLengthSeconds(project, 0, 2)
    assert.ok(Math.abs(constant - 4) < 1e-9)
    project.tempoMap = [{ beat: 0, bpm: 60 }, { beat: 8, bpm: 60 }]
    const slow = audioClipLengthSeconds(project, 0, 2)
    assert.ok(Math.abs(slow - 8) < 1e-6, String(slow))
  })

  it('normalizeAudioClipFields 直接使用：非法 fade 清理/反向 false 删除', () => {
    const project = audioProject()
    const clip = { id: 'c', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, fadeInSeconds: -3, fadeOutSeconds: 'x', reverse: false, gainDb: 100 }
    normalizeAudioClipFields(project, clip)
    assert.equal(clip.gainDb, 24)
    assert.equal(Object.hasOwn(clip, 'fadeInSeconds'), false)
    assert.equal(Object.hasOwn(clip, 'fadeOutSeconds'), false)
    assert.equal(Object.hasOwn(clip, 'reverse'), false)
  })

  it('makeClip pattern 分支不接受音频字段（不写入）', () => {
    const clip = makeClip({ id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 2, gainDb: -6, reverse: true })
    assert.equal(Object.hasOwn(clip, 'gainDb'), false)
    assert.equal(Object.hasOwn(clip, 'reverse'), false)
  })

  it('gainDb 边界 -24/+24 保留；±0.04 舍入后省略', () => {
    const project = audioProject()
    project.clips = [
      makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, gainDb: 24 }),
      makeClip({ id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 2, gainDb: -24 }),
      makeClip({ id: 'clip_3', trackId: 'trk_1', mediaId: 'med_1', startBar: 4, lengthBars: 2, gainDb: 0.04 }),
    ]
    normalizeProject(project)
    assert.equal(project.clips.find((clip) => clip.id === 'clip_1').gainDb, 24)
    assert.equal(project.clips.find((clip) => clip.id === 'clip_2').gainDb, -24)
    assert.equal(Object.hasOwn(project.clips.find((clip) => clip.id === 'clip_3'), 'gainDb'), false)
  })
})

/* ------------------------------------------------------------------------- */
/* R2b：音频片段 stretchRatio / semitones 模型                                 */
/* ------------------------------------------------------------------------- */

describe('model R2b — stretchRatio / semitones', () => {
  function audioProject({ mediaDuration = 10, bpm = 120, lengthBars = 16, timeSignature = [4, 4] } = {}) {
    const project = createEmptyProject({ bpm, lengthBars, timeSignature })
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'audio', name: '音频' })]
    project.media = [makeMedia({ id: 'med_1', name: 'a.wav', file: 'a.wav', bytes: 100, durationSeconds: mediaDuration })]
    return project
  }

  it('常量范围：stretchRatio 0.25..4、semitones -12..12', () => {
    assert.equal(AUDIO_CLIP_STRETCH_RATIO_MIN, 0.25)
    assert.equal(AUDIO_CLIP_STRETCH_RATIO_MAX, 4)
    assert.equal(AUDIO_CLIP_SEMITONES_MIN, -12)
    assert.equal(AUDIO_CLIP_SEMITONES_MAX, 12)
  })

  it('normalizeAudioClipStretchRatio：3 位小数、夹紧、1 表示省略、非法回 1', () => {
    assert.equal(normalizeAudioClipStretchRatio(1.2567), 1.257)
    assert.equal(normalizeAudioClipStretchRatio(9), 4)
    assert.equal(normalizeAudioClipStretchRatio(0.01), 0.25)
    assert.equal(normalizeAudioClipStretchRatio(1), 1)
    assert.equal(normalizeAudioClipStretchRatio(0.9996), 1, '四舍五入到 1 视为原速省略')
    assert.equal(normalizeAudioClipStretchRatio('bad'), 1)
    assert.equal(normalizeAudioClipStretchRatio(-1), 1)
  })

  it('normalizeAudioClipSemitones：1 位小数、夹紧、0 表示省略、非法回 0', () => {
    assert.equal(normalizeAudioClipSemitones(3.14), 3.1)
    assert.equal(normalizeAudioClipSemitones(-7.46), -7.5)
    assert.equal(normalizeAudioClipSemitones(99), 12)
    assert.equal(normalizeAudioClipSemitones(-99), -12)
    assert.equal(normalizeAudioClipSemitones(0), 0)
    assert.equal(normalizeAudioClipSemitones(0.04), 0)
    assert.equal(normalizeAudioClipSemitones('x'), 0)
  })

  it('makeClip：默认省略；有值写入并规范化', () => {
    const plain = makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2 })
    assert.equal(Object.hasOwn(plain, 'stretchRatio'), false)
    assert.equal(Object.hasOwn(plain, 'semitones'), false)
    const rich = makeClip({
      id: 'clip_2',
      trackId: 'trk_1',
      mediaId: 'med_1',
      startBar: 0,
      lengthBars: 2,
      stretchRatio: 2.3456,
      semitones: -3.14,
    })
    assert.equal(rich.stretchRatio, 2.346)
    assert.equal(rich.semitones, -3.1)
  })

  it('normalizeProject：字段规范化/1 和 0 省略/幂等', () => {
    const project = audioProject()
    project.clips = [
      makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, stretchRatio: 2, semitones: 3 }),
      makeClip({ id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 2, stretchRatio: 1, semitones: 0 }),
    ]
    normalizeProject(project)
    const rich = project.clips.find((clip) => clip.id === 'clip_1')
    assert.equal(rich.stretchRatio, 2)
    assert.equal(rich.semitones, 3)
    const plain = project.clips.find((clip) => clip.id === 'clip_2')
    assert.equal(Object.hasOwn(plain, 'stretchRatio'), false)
    assert.equal(Object.hasOwn(plain, 'semitones'), false)
    const snapshot = JSON.stringify(project.clips)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.clips), snapshot)
  })

  it('normalizeProject：pattern clip 删除 stretchRatio/semitones', () => {
    const project = audioProject()
    project.patterns = [makePattern({ id: 'pat_1', name: 'p', lengthBars: 2, notes: [] })]
    project.clips = [
      { id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 2, stretchRatio: 2, semitones: 3 },
    ]
    normalizeProject(project)
    const clip = project.clips[0]
    for (const field of ['stretchRatio', 'semitones']) assert.equal(Object.hasOwn(clip, field), false)
  })

  it('v3 老工程无字段：默认 ratio=1/semitones=0，行为与 R2a 等价', () => {
    const project = audioProject()
    project.clips = [makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2 })]
    normalizeProject(project)
    const clip = project.clips[0]
    assert.equal(clip.stretchRatio, undefined)
    assert.equal(clip.semitones, undefined)
    assert.equal(audioClipPlayableSeconds(project, clip), 4, '2 小节 @120BPM = 4s')
  })

  it('audioClipPlayableSeconds：timeline = min(clipTimeline, (mediaDuration-offset)*ratio)', () => {
    const project = audioProject({ mediaDuration: 10, bpm: 120 })
    const clip = makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, stretchRatio: 2 })
    assert.equal(audioClipPlayableSeconds(project, clip), 4, '媒体充足时受 clip timeline 限制')
    clip.stretchRatio = 0.5
    assert.equal(audioClipPlayableSeconds(project, clip), 4)
    // 媒体剩余 1s：ratio=2 → 2s；ratio=0.5 → 0.5s
    const short = audioProject({ mediaDuration: 1, bpm: 120 })
    const clip2 = makeClip({ id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, stretchRatio: 2 })
    assert.equal(audioClipPlayableSeconds(short, clip2), 2)
    clip2.stretchRatio = 0.5
    assert.equal(audioClipPlayableSeconds(short, clip2), 0.5)
  })

  it('audioClipSourceSeconds：timeline / ratio（媒体未知也可用）', () => {
    const project = audioProject({ mediaDuration: null, bpm: 120 })
    const clip = makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, stretchRatio: 2 })
    assert.equal(audioClipSourceSeconds(project, clip), 2)
    clip.stretchRatio = 0.5
    assert.equal(audioClipSourceSeconds(project, clip), 8)
    delete clip.stretchRatio
    assert.equal(audioClipSourceSeconds(project, clip), 4)
  })

  it('fade 夹紧考虑 ratio 后的可播放时长', () => {
    // 媒体剩余 1.5s、ratio=2 → playable=min(4,3)=3s；fade 4+4 应缩放到总和 ≤3
    const project = audioProject({ mediaDuration: 1.5, bpm: 120 })
    project.clips = [
      makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, stretchRatio: 2, fadeInSeconds: 4, fadeOutSeconds: 4 }),
    ]
    normalizeProject(project)
    const clip = project.clips[0]
    assert.equal(audioClipPlayableSeconds(project, clip), 3)
    assert.ok(clip.fadeInSeconds + clip.fadeOutSeconds <= 3 + 1e-9)
  })

  it('ratio=1 + semitones=0 与 R2a 行为完全一致（可播放/fade clamp/字段省略）', () => {
    const project = audioProject({ mediaDuration: 2, bpm: 120 })
    project.clips = [
      makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, fadeInSeconds: 2, fadeOutSeconds: 2 }),
    ]
    normalizeProject(project)
    const clip = project.clips[0]
    assert.equal(audioClipPlayableSeconds(project, clip), 2)
    assert.equal(clip.fadeInSeconds + clip.fadeOutSeconds, 2)
    assert.equal(Object.hasOwn(clip, 'stretchRatio'), false)
    assert.equal(Object.hasOwn(clip, 'semitones'), false)
  })

  it('normalizeAudioClipFields：非法 stretch/semitones 清理/夹紧', () => {
    const project = audioProject()
    const clip = {
      id: 'c',
      trackId: 'trk_1',
      mediaId: 'med_1',
      startBar: 0,
      lengthBars: 2,
      stretchRatio: 0.01,
      semitones: 99,
    }
    normalizeAudioClipFields(project, clip)
    assert.equal(clip.stretchRatio, 0.25)
    assert.equal(clip.semitones, 12)
    clip.stretchRatio = 1
    clip.semitones = 0
    normalizeAudioClipFields(project, clip)
    assert.equal(Object.hasOwn(clip, 'stretchRatio'), false)
    assert.equal(Object.hasOwn(clip, 'semitones'), false)
  })

  it('makeClip pattern 分支忽略 stretchRatio/semitones', () => {
    const clip = makeClip({ id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 2, stretchRatio: 2, semitones: 3 })
    assert.equal(Object.hasOwn(clip, 'stretchRatio'), false)
    assert.equal(Object.hasOwn(clip, 'semitones'), false)
  })
})

/* ------------------------------------------------------------------------- */
/* R2c：音频 clip takeGroup / takeIndex / takeActive 模型                      */
/* ------------------------------------------------------------------------- */

describe('model R2c — take 字段', () => {
  function audioProject({ mediaDuration = 10 } = {}) {
    const project = createEmptyProject({ bpm: 120, lengthBars: 16 })
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'audio', name: '音频' })]
    project.media = [makeMedia({ id: 'med_1', name: 'a.wav', file: 'a.wav', bytes: 100, durationSeconds: mediaDuration })]
    return project
  }

  it('常量：takeGroup 1..64、takeIndex 0..99', () => {
    assert.equal(TAKE_GROUP_MAX_LENGTH, 64)
    assert.equal(TAKE_INDEX_MAX, 99)
  })

  it('normalizeTakeGroup：安全字符/长度；非法、空、非字符串 → null', () => {
    assert.equal(normalizeTakeGroup('take-2026_01'), 'take-2026_01')
    assert.equal(normalizeTakeGroup('  take  '), 'take')
    assert.equal(normalizeTakeGroup(''), null)
    assert.equal(normalizeTakeGroup('带空格 group'), null)
    assert.equal(normalizeTakeGroup('中文组'), null)
    assert.equal(normalizeTakeGroup('../evil'), null)
    assert.equal(normalizeTakeGroup('a'.repeat(64)), 'a'.repeat(64))
    assert.equal(normalizeTakeGroup('a'.repeat(65)), null)
    assert.equal(normalizeTakeGroup(123), null)
  })

  it('normalizeTakeIndex：0..99 整数；越界/小数/非法 → null', () => {
    assert.equal(normalizeTakeIndex(0), 0)
    assert.equal(normalizeTakeIndex(99), 99)
    assert.equal(normalizeTakeIndex('3'), 3)
    assert.equal(normalizeTakeIndex(100), null)
    assert.equal(normalizeTakeIndex(-1), null)
    assert.equal(normalizeTakeIndex(1.5), null)
    assert.equal(normalizeTakeIndex('x'), null)
  })

  it('normalizeTakeActive：默认 true（true 省略），只有 false 返回 true 标记', () => {
    assert.equal(normalizeTakeActive(false), true)
    assert.equal(normalizeTakeActive(true), false)
    assert.equal(normalizeTakeActive(undefined), false)
    assert.equal(normalizeTakeActive(0), false)
  })

  it('makeClip：有 takeGroup 才写 takeIndex/takeActive；无 group 时不写', () => {
    const rich = makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, takeGroup: 'g1', takeIndex: 2, takeActive: false })
    assert.equal(rich.takeGroup, 'g1')
    assert.equal(rich.takeIndex, 2)
    assert.equal(rich.takeActive, false)
    const active = makeClip({ id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 2, takeGroup: 'g1', takeIndex: 0 })
    assert.equal(Object.hasOwn(active, 'takeActive'), false, 'active 默认省略')
    const noGroup = makeClip({ id: 'clip_3', trackId: 'trk_1', mediaId: 'med_1', startBar: 4, lengthBars: 2, takeIndex: 2, takeActive: false })
    for (const field of ['takeGroup', 'takeIndex', 'takeActive']) assert.equal(Object.hasOwn(noGroup, field), false)
  })

  it('normalizeProject：保留有效 take 字段；无 group 删除 index/active；幂等', () => {
    const project = audioProject()
    project.clips = [
      makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, takeGroup: 'g1', takeIndex: 0 }),
      makeClip({ id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 2, takeGroup: 'g1', takeIndex: 1, takeActive: false }),
      { id: 'clip_3', trackId: 'trk_1', mediaId: 'med_1', startBar: 4, lengthBars: 2, takeIndex: 3, takeActive: false },
    ]
    normalizeProject(project)
    const a = project.clips.find((clip) => clip.id === 'clip_1')
    assert.equal(a.takeGroup, 'g1')
    assert.equal(a.takeIndex, 0)
    assert.equal(Object.hasOwn(a, 'takeActive'), false)
    const b = project.clips.find((clip) => clip.id === 'clip_2')
    assert.equal(b.takeActive, false)
    const c = project.clips.find((clip) => clip.id === 'clip_3')
    for (const field of ['takeGroup', 'takeIndex', 'takeActive']) assert.equal(Object.hasOwn(c, field), false)
    const snapshot = JSON.stringify(project.clips)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.clips), snapshot)
  })

  it('normalizeProject：非法 takeGroup/takeIndex 被丢弃/夹紧为合法值', () => {
    const project = audioProject()
    project.clips = [
      { id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, takeGroup: 'bad group!', takeIndex: 2, takeActive: false },
      { id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 2, takeGroup: 'g2', takeIndex: 200, takeActive: false },
    ]
    normalizeProject(project)
    const a = project.clips.find((clip) => clip.id === 'clip_1')
    for (const field of ['takeGroup', 'takeIndex', 'takeActive']) assert.equal(Object.hasOwn(a, field), false)
    const b = project.clips.find((clip) => clip.id === 'clip_2')
    assert.equal(b.takeGroup, 'g2')
    assert.equal(Object.hasOwn(b, 'takeIndex'), false)
    assert.equal(b.takeActive, false)
  })

  it('pattern clip 删除 take 字段', () => {
    const project = audioProject()
    project.patterns = [makePattern({ id: 'pat_1', name: 'p', lengthBars: 2, notes: [] })]
    project.clips = [
      { id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 2, takeGroup: 'g1', takeIndex: 1, takeActive: false },
    ]
    normalizeProject(project)
    const clip = project.clips[0]
    for (const field of ['takeGroup', 'takeIndex', 'takeActive']) assert.equal(Object.hasOwn(clip, field), false)
  })

  it('v3 老工程无 take 字段：完全兼容，不写默认字段', () => {
    const project = audioProject()
    project.clips = [makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2 })]
    normalizeProject(project)
    const clip = project.clips[0]
    for (const field of ['takeGroup', 'takeIndex', 'takeActive']) assert.equal(Object.hasOwn(clip, field), false)
  })

  it('不强制同组只能一个 active（comping 多段 active 允许）', () => {
    const project = audioProject()
    project.clips = [
      makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, takeGroup: 'g1', takeIndex: 0 }),
      makeClip({ id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 2, takeGroup: 'g1', takeIndex: 1 }),
    ]
    normalizeProject(project)
    for (const clip of project.clips) assert.equal(Object.hasOwn(clip, 'takeActive'), false)
  })

  it('takeIndex 边界 0/99 保留；100 丢弃；takeActive false 保留', () => {
    const project = audioProject()
    project.clips = [
      makeClip({ id: 'clip_1', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, takeGroup: 'g1', takeIndex: 0, takeActive: false }),
      makeClip({ id: 'clip_2', trackId: 'trk_1', mediaId: 'med_1', startBar: 2, lengthBars: 2, takeGroup: 'g1', takeIndex: 99 }),
      makeClip({ id: 'clip_3', trackId: 'trk_1', mediaId: 'med_1', startBar: 4, lengthBars: 2, takeGroup: 'g1', takeIndex: 100 }),
    ]
    normalizeProject(project)
    const a = project.clips.find((clip) => clip.id === 'clip_1')
    assert.equal(a.takeIndex, 0)
    assert.equal(a.takeActive, false)
    assert.equal(project.clips.find((clip) => clip.id === 'clip_2').takeIndex, 99)
    assert.equal(Object.hasOwn(project.clips.find((clip) => clip.id === 'clip_3'), 'takeIndex'), false)
  })

  it('normalizeAudioClipFields：take 字段规范化可直接调用', () => {
    const project = audioProject()
    const clip = { id: 'c', trackId: 'trk_1', mediaId: 'med_1', startBar: 0, lengthBars: 2, takeGroup: 'g1', takeIndex: 5, takeActive: false }
    normalizeAudioClipFields(project, clip)
    assert.equal(clip.takeGroup, 'g1')
    assert.equal(clip.takeIndex, 5)
    assert.equal(clip.takeActive, false)
    clip.takeGroup = 'bad group'
    normalizeAudioClipFields(project, clip)
    for (const field of ['takeGroup', 'takeIndex', 'takeActive']) assert.equal(Object.hasOwn(clip, field), false)
  })
})

/* ------------------------------------------------------------------------- */
/* R3b：CC automation 参数模型                                                 */
/* ------------------------------------------------------------------------- */

describe('model R3b — CC automation 参数', () => {
  it('cc1/cc11/cc64/cc74 在 AUTOMATION_PARAMS 中且带 cc/label/hint/color/format', () => {
    const expected = { cc1: 1, cc11: 11, cc64: 64, cc74: 74 }
    for (const [param, cc] of Object.entries(expected)) {
      const spec = AUTOMATION_PARAMS[param]
      assert.ok(spec, param)
      assert.equal(spec.id, param)
      assert.equal(spec.cc, cc)
      assert.ok(typeof spec.label === 'string' && spec.label.length > 0)
      assert.ok(typeof spec.hint === 'string' && spec.hint.length > 0)
      assert.ok(typeof spec.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(spec.color))
      assert.deepEqual(spec.targets, ['track'])
      assert.equal(typeof spec.format, 'function')
    }
  })

  it('AUTOMATION_CC_PARAMS / AUTOMATION_CC_PARAM_IDS 映射正确且总参数为 10', () => {
    assert.deepEqual(AUTOMATION_CC_PARAM_IDS, ['cc1', 'cc11', 'cc64', 'cc74'])
    assert.deepEqual({ ...AUTOMATION_CC_PARAMS }, { 1: 'cc1', 11: 'cc11', 64: 'cc64', 74: 'cc74' })
    assert.equal(AUTOMATION_PARAM_IDS.length, 10)
    assert.ok(Object.isFrozen(AUTOMATION_CC_PARAMS))
    assert.ok(Object.isFrozen(AUTOMATION_CC_PARAM_IDS))
  })

  it('CC 参数 map/format：0..1 ↔ 0..127；cc74 使用 cutoff 对数映射', () => {
    for (const param of ['cc1', 'cc11', 'cc64']) {
      assert.equal(AUTOMATION_PARAMS[param].map(0), 0)
      assert.equal(AUTOMATION_PARAMS[param].map(1), 127)
      assert.equal(AUTOMATION_PARAMS[param].map(0.5), 63.5)
      assert.match(AUTOMATION_PARAMS[param].format(1), /127/)
    }
    const cc74 = AUTOMATION_PARAMS.cc74
    assert.equal(cc74.map(0), 80)
    assert.ok(Math.abs(cc74.map(1) - 16000) < 1e-6)
    assert.equal(cc74.map(0.5), AUTOMATION_PARAMS.cutoff.map(0.5))
    assert.match(cc74.format(0), /^[0-9]+ Hz$/)
  })

  it('normalizeAutomation：保留 4 个 CC 曲线、未知参数丢弃、点排序/去重', () => {
    const normalized = normalizeAutomation({
      cc1: { points: [{ beat: 2, value: 0.7 }, { beat: 0, value: 0.2 }, { beat: 2, value: 0.9 }] },
      cc11: { enabled: false, points: [{ beat: 1, value: 1.2 }] },
      bogus: { points: [{ beat: 0, value: 0 }] },
    }, { maxBeat: 8 })
    assert.deepEqual(Object.keys(normalized).sort(), ['cc1', 'cc11'])
    assert.deepEqual(normalized.cc1.points, [{ beat: 0, value: 0.2 }, { beat: 2, value: 0.9 }])
    assert.equal(normalized.cc11.enabled, false)
    assert.equal(normalized.cc11.points[0].value, 1)
  })

  it('normalizeAutomationCurve：点上限 256、beat 夹紧、cc 值 0..1', () => {
    const points = Array.from({ length: 300 }, (_, index) => ({ beat: index * 0.1, value: index % 2 }))
    const curve = normalizeAutomationCurve({ points, enabled: true }, { maxBeat: 64 })
    assert.equal(curve.points.length, 256)
    assert.ok(curve.points.every((point) => point.beat >= 0 && point.beat <= 64 && point.value >= 0 && point.value <= 1))
  })

  it('automationValueAt：cc1 线性插值', () => {
    const points = [{ beat: 0, value: 0 }, { beat: 4, value: 1 }]
    assert.equal(automationValueAt(points, 0), 0)
    assert.equal(automationValueAt(points, 2), 0.5)
    assert.equal(automationValueAt(points, 3), 0.75)
    assert.equal(automationValueAt(points, 9), 1)
    assert.equal(automationValueAt([], 3), null)
  })

  it('automationParamSupports：4 个 CC 仅 track，不支持 master', () => {
    for (const param of ['cc1', 'cc11', 'cc64', 'cc74']) {
      assert.equal(automationParamSupports(param, 'track'), true)
      assert.equal(automationParamSupports(param, 'master'), false)
    }
    assert.equal(automationParamSupports('volume', 'master'), true)
  })

  it('旧 6 参数工程不受新增字段影响：normalizeAutomation 幂等', () => {
    const raw = {
      volume: { enabled: true, points: [{ beat: 0, value: 0.2 }, { beat: 8, value: 1 }] },
      pitchBend: { enabled: true, points: [{ beat: 0, value: 0.5 }] },
    }
    const once = normalizeAutomation(raw, { maxBeat: 16 })
    const twice = normalizeAutomation(once, { maxBeat: 16 })
    assert.deepEqual(once, twice)
    assert.deepEqual(Object.keys(once).sort(), ['pitchBend', 'volume'])
  })

  it('normalizeProject：工程/轨道保存 CC 曲线；master 不接受 cc', () => {
    const project = createEmptyProject({ lengthBars: 8 })
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'Synth' })]
    project.tracks[0].automation = {
      cc1: { enabled: true, points: [{ beat: 0, value: 0.1 }, { beat: 4, value: 0.6 }] },
      cc74: { enabled: false, points: [{ beat: 1, value: 0.4 }] },
    }
    const normalized = normalizeProject(project)
    assert.deepEqual(Object.keys(normalized.tracks[0].automation).sort(), ['cc1', 'cc74'])
    assert.equal(normalized.tracks[0].automation.cc74.enabled, false)
    assert.equal(normalized.tracks[0].automation.cc1.points[1].value, 0.6)
  })
})

/* ------------------------------------------------------------------------- */
/* R3c：project.midiMappings 模型                                              */
/* ------------------------------------------------------------------------- */

describe('model R3c — MIDI Learn 映射', () => {
  function mappingProject() {
    const project = createEmptyProject({ title: 'R3c', lengthBars: 8 })
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'Synth' })]
    project.tracks[0].effects = [{ id: 'fx_1', type: 'filter', enabled: true, params: {} }]
    return project
  }

  it('常量：最多 16 条、5 个 target、effect 参数并集包含 cutoff', () => {
    assert.equal(MIDI_MAPPING_MAX, 16)
    assert.deepEqual([...MIDI_MAPPING_TARGETS], ['volume', 'pan', 'sendReverb', 'sendDelay', 'effectParam'])
    assert.ok(MIDI_MAPPING_EFFECT_PARAMS.includes('cutoff'))
    assert.deepEqual(effectParamIds('filter').includes('cutoff'), true)
    assert.deepEqual(effectParamIds('bogus'), [])
  })

  it('normalizeMidiMapping：volume 默认值（id 自动、channel null、min 0/max 1）', () => {
    const project = mappingProject()
    const mapping = normalizeMidiMapping({ cc: 1, target: 'volume', trackId: 'trk_1' }, { index: 0, tracks: project.tracks })
    assert.deepEqual(mapping, { id: 'map_1', cc: 1, channel: null, target: 'volume', trackId: 'trk_1', min: 0, max: 1 })
  })

  it('normalizeMidiMapping：channel 0..15/null，超出丢弃', () => {
    const project = mappingProject()
    assert.equal(normalizeMidiMapping({ cc: 1, channel: 15, target: 'volume', trackId: 'trk_1' }, { index: 0, tracks: project.tracks }).channel, 15)
    assert.equal(normalizeMidiMapping({ cc: 1, channel: 'x', target: 'volume', trackId: 'trk_1' }, { index: 0, tracks: project.tracks }), null)
    assert.equal(normalizeMidiMapping({ cc: 1, channel: 16, target: 'volume', trackId: 'trk_1' }, { index: 0, tracks: project.tracks }), null)
    assert.equal(normalizeMidiMapping({ cc: 1, channel: -1, target: 'volume', trackId: 'trk_1' }, { index: 0, tracks: project.tracks }), null)
  })

  it('normalizeMidiMapping：cc 0..127 整数、target 白名单、track 必须存在', () => {
    const project = mappingProject()
    const base = { target: 'volume', trackId: 'trk_1' }
    for (const cc of [-1, 128, 1.5, 'x', null]) {
      assert.equal(normalizeMidiMapping({ ...base, cc }, { index: 0, tracks: project.tracks }), null, String(cc))
    }
    assert.equal(normalizeMidiMapping({ ...base, cc: 0 }, { index: 0, tracks: project.tracks }).cc, 0)
    assert.equal(normalizeMidiMapping({ ...base, cc: 127 }, { index: 0, tracks: project.tracks }).cc, 127)
    assert.equal(normalizeMidiMapping({ cc: 1, target: 'bogus', trackId: 'trk_1' }, { index: 0, tracks: project.tracks }), null)
    assert.equal(normalizeMidiMapping({ cc: 1, target: 'volume', trackId: 'trk_404' }, { index: 0, tracks: project.tracks }), null)
  })

  it('normalizeMidiMapping：effectParam 校验 effectId 与 param', () => {
    const project = mappingProject()
    const base = { cc: 2, target: 'effectParam', trackId: 'trk_1', effectId: 'fx_1', param: 'cutoff' }
    assert.ok(normalizeMidiMapping(base, { index: 0, tracks: project.tracks }))
    assert.equal(normalizeMidiMapping({ ...base, effectId: 'fx_404' }, { index: 0, tracks: project.tracks }), null)
    assert.equal(normalizeMidiMapping({ ...base, param: 'bogus' }, { index: 0, tracks: project.tracks }), null)
    // 非 effectParam 目标忽略 effect/param 字段
    const volume = normalizeMidiMapping({ cc: 3, target: 'volume', trackId: 'trk_1', effectId: 'fx_1', param: 'cutoff' }, { index: 0, tracks: project.tracks })
    assert.equal(Object.hasOwn(volume, 'effectId'), false)
  })

  it('normalizeMidiMapping：min/max 默认/夹紧/必须 min<max', () => {
    const project = mappingProject()
    const base = { cc: 1, target: 'volume', trackId: 'trk_1' }
    assert.deepEqual([normalizeMidiMapping(base, { index: 0, tracks: project.tracks }).min, normalizeMidiMapping(base, { index: 0, tracks: project.tracks }).max], [0, 1])
    const clamped = normalizeMidiMapping({ ...base, min: -1, max: 2 }, { index: 0, tracks: project.tracks })
    assert.deepEqual([clamped.min, clamped.max], [0, 1])
    assert.equal(normalizeMidiMapping({ ...base, min: 0.8, max: 0.2 }, { index: 0, tracks: project.tracks }), null)
    assert.equal(normalizeMidiMapping({ ...base, min: 0.5, max: 0.5 }, { index: 0, tracks: project.tracks }), null)
    assert.equal(normalizeMidiMapping({ ...base, min: 'x' }, { index: 0, tracks: project.tracks }), null)
  })

  it('normalizeMidiMappings：≤16 条、id 唯一、cc+channel 唯一（不同 channel 可同 cc）', () => {
    const project = mappingProject()
    const raw = [
      { id: 'map_1', cc: 1, target: 'volume', trackId: 'trk_1' },
      { id: 'map_1', cc: 2, target: 'pan', trackId: 'trk_1' },
      { cc: 1, target: 'volume', trackId: 'trk_1' },
      { cc: 1, channel: 0, target: 'pan', trackId: 'trk_1' },
      { cc: 1, channel: 0, target: 'volume', trackId: 'trk_1' },
      { cc: 3, channel: 1, target: 'volume', trackId: 'trk_1' },
    ]
    const mappings = normalizeMidiMappings(raw, { tracks: project.tracks })
    assert.equal(mappings.length, 4, JSON.stringify(mappings))
    assert.equal(new Set(mappings.map((mapping) => mapping.id)).size, mappings.length)
    assert.equal(mappings.filter((mapping) => mapping.cc === 1 && (mapping.channel ?? null) === null).length, 1)
    assert.equal(mappings.filter((mapping) => mapping.cc === 1 && mapping.channel === 0).length, 1)
  })

  it('normalizeMidiMappings：超过 16 条截断', () => {
    const project = mappingProject()
    const raw = Array.from({ length: 20 }, (_, index) => ({ cc: index, target: 'volume', trackId: 'trk_1' }))
    assert.equal(normalizeMidiMappings(raw, { tracks: project.tracks }).length, 16)
  })

  it('normalizeProject：持久化合法映射；非法/无轨道映射被清理', () => {
    const project = mappingProject()
    project.midiMappings = [
      { cc: 1, target: 'volume', trackId: 'trk_1' },
      { cc: 2, channel: 0, target: 'pan', trackId: 'trk_1' },
      { cc: 3, target: 'volume', trackId: 'trk_404' },
      { cc: 4, target: 'effectParam', trackId: 'trk_1', effectId: 'fx_404', param: 'cutoff' },
    ]
    normalizeProject(project)
    assert.equal(project.midiMappings.length, 2)
    assert.equal(project.midiMappings[0].id, 'map_1')
    assert.equal(project.midiMappings[1].cc, 2)
    assert.equal(project.midiMappings[1].channel, 0)
  })

  it('createEmptyProject 带 midiMappings=[]；缺字段旧工程 normalize 后为 []', () => {
    assert.deepEqual(createEmptyProject().midiMappings, [])
    const project = createEmptyProject()
    delete project.midiMappings
    normalizeProject(project)
    assert.deepEqual(project.midiMappings, [])
  })

  it('normalizeProject 幂等：映射规范化后再次 normalize 不变', () => {
    const project = mappingProject()
    project.midiMappings = [
      { cc: 1, target: 'volume', trackId: 'trk_1', min: 0.2, max: 0.8 },
      { cc: 2, target: 'effectParam', trackId: 'trk_1', effectId: 'fx_1', param: 'cutoff' },
    ]
    normalizeProject(project)
    const snapshot = JSON.stringify(project.midiMappings)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.midiMappings), snapshot)
  })

  it('channel null 与 channel 0 被视为不同映射', () => {
    const project = mappingProject()
    project.midiMappings = [
      { cc: 7, target: 'volume', trackId: 'trk_1' },
      { cc: 7, channel: 0, target: 'pan', trackId: 'trk_1' },
    ]
    normalizeProject(project)
    assert.equal(project.midiMappings.length, 2)
    assert.equal(project.midiMappings[0].channel, null)
    assert.equal(project.midiMappings[1].channel, 0)
  })
})

/* R3c 补充：边界回归 */
describe('model R3c — 补充边界', () => {
  it('MIDI_MAPPING_* 常量冻结；effect 参数并集无重复', () => {
    assert.equal(Object.isFrozen(MIDI_MAPPING_TARGETS), true)
    assert.equal(Object.isFrozen(MIDI_MAPPING_EFFECT_PARAMS), true)
    assert.equal(new Set(MIDI_MAPPING_EFFECT_PARAMS).size, MIDI_MAPPING_EFFECT_PARAMS.length)
    assert.ok(MIDI_MAPPING_EFFECT_PARAMS.includes('cutoff'))
  })

  it('normalizeMidiMappings：非法 id 自动分配 map_n 且不重复', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'S' })]
    const mappings = normalizeMidiMappings([
      { id: 'bad-id', cc: 1, target: 'volume', trackId: 'trk_1' },
      { id: 'map_1', cc: 2, target: 'volume', trackId: 'trk_1' },
      { id: 'map_1', cc: 3, target: 'volume', trackId: 'trk_1' },
    ], { tracks: project.tracks })
    assert.equal(mappings.length, 3)
    assert.equal(new Set(mappings.map((mapping) => mapping.id)).size, 3)
    assert.equal(mappings[0].id, 'map_1')
  })

  it('normalizeProject：轨道被删除后对应映射被清理', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'S' })]
    project.midiMappings = [
      { cc: 1, target: 'volume', trackId: 'trk_1' },
      { cc: 2, target: 'pan', trackId: 'trk_2' },
    ]
    normalizeProject(project)
    assert.equal(project.midiMappings.length, 1)
    assert.equal(project.midiMappings[0].trackId, 'trk_1')
  })

  it('normalizeMidiMapping：effectParam 参数在效果器类型变更后失效', () => {
    const project = createEmptyProject()
    const track = makeTrack({ id: 'trk_1', kind: 'synth', name: 'S' })
    track.effects = [{ id: 'fx_1', type: 'filter', enabled: true, params: {} }]
    project.tracks = [track]
    assert.ok(normalizeMidiMapping({ cc: 1, target: 'effectParam', trackId: 'trk_1', effectId: 'fx_1', param: 'cutoff' }, { tracks: project.tracks }))
    track.effects = [{ id: 'fx_1', type: 'drive', enabled: true, params: {} }]
    assert.equal(normalizeMidiMapping({ cc: 1, target: 'effectParam', trackId: 'trk_1', effectId: 'fx_1', param: 'cutoff' }, { tracks: project.tracks }), null)
  })
})

/* ------------------------------------------------------------------------- */
/* R4a：project.groups + track.output 模型                                     */
/* ------------------------------------------------------------------------- */

describe('model R4a — Group bus / 轨道输出', () => {
  function groupProject() {
    const project = createEmptyProject({ title: 'R4a', lengthBars: 8 })
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'synth', name: 'Synth' }),
      makeTrack({ id: 'trk_2', kind: 'drum', name: 'Drums' }),
      makeTrack({ id: 'trk_3', kind: 'audio', name: 'Audio' }),
    ]
    return project
  }

  it('常量：最多 8 组、name 40、组 output 固定 master', () => {
    assert.equal(MAX_GROUPS, 8)
    assert.equal(GROUP_NAME_MAX, 40)
    assert.equal(GROUP_OUTPUT_MASTER, 'master')
  })

  it('normalizeGroup：默认 id/name/level/effects/mute/solo/output', () => {
    const group = normalizeGroup({}, { index: 0 })
    assert.deepEqual(group, {
      id: 'grp_1',
      name: 'Group 1',
      level: 0.8,
      effects: [],
      mute: false,
      solo: false,
      output: 'master',
    })
  })

  it('normalizeGroup：非法对象返回 null', () => {
    for (const raw of [null, undefined, [], 'x', 3]) assert.equal(normalizeGroup(raw, { index: 0 }), null)
  })

  it('normalizeGroup：name 默认/trim/长度截断/控制字符清理；level 夹紧；mute/solo 布尔', () => {
    assert.equal(normalizeGroup({ name: '  鼓组  ' }, { index: 0 }).name, '鼓组')
    assert.equal(normalizeGroup({ name: '' }, { index: 2 }).name, 'Group 3')
    assert.equal(normalizeGroup({ name: 'a'.repeat(60) }, { index: 0 }).name.length, GROUP_NAME_MAX)
    assert.equal(normalizeGroup({ name: 'bad' + String.fromCharCode(1) + 'name' }, { index: 0 }).name, 'badname')
    assert.equal(normalizeGroup({ level: 5 }, { index: 0 }).level, 1)
    assert.equal(normalizeGroup({ level: -1 }, { index: 0 }).level, 0)
    assert.equal(normalizeGroup({ level: 'x' }, { index: 0 }).level, 0.8)
    assert.equal(normalizeGroup({ mute: 1, solo: 'true' }, { index: 0 }).mute, false)
    assert.equal(normalizeGroup({ mute: true, solo: true }, { index: 0 }).mute, true)
    assert.equal(normalizeGroup({ output: 'bus' }, { index: 0 }).output, 'master', 'R4a group output 固定 master')
  })

  it('normalizeGroup：effects 使用现有 FX 链规范化（非法/重复 type 处理）', () => {
    const group = normalizeGroup({
      effects: [
        { id: 'fx_1', type: 'filter', enabled: true, params: { cutoff: 800 } },
        { id: 'fx_99', type: 'bogus', params: {} },
      ],
    }, { index: 0 })
    assert.equal(group.effects.length, 1)
    assert.equal(group.effects[0].type, 'filter')
    assert.equal(group.effects[0].params.cutoff, 800)
  })

  it('normalizeGroups：≤8 截断、id 唯一、非法丢弃', () => {
    const raw = Array.from({ length: 10 }, (_, index) => ({ id: 'grp_1', name: `G${index}` }))
    const groups = normalizeGroups(raw)
    assert.equal(groups.length, MAX_GROUPS)
    assert.equal(new Set(groups.map((group) => group.id)).size, MAX_GROUPS)
    const mixed = normalizeGroups([null, { name: 'A' }, 'bad', { name: 'B' }])
    assert.equal(mixed.length, 2)
    assert.deepEqual(mixed.map((group) => group.name), ['A', 'B'].map((name, index) => normalizeGroup({ name }, { index }).name))
  })

  it('normalizeGroups：自动 id grp_n 从 1 开始且跳过已占用', () => {
    const groups = normalizeGroups([{ id: 'grp_2', name: 'B' }, { name: 'A' }, { id: 'bad', name: 'C' }])
    assert.deepEqual(groups.map((group) => group.id), ['grp_2', 'grp_3', 'grp_4'])
  })

  it('normalizeProject：groups 持久化；缺字段旧工程=[]', () => {
    const project = groupProject()
    project.groups = [{ id: 'grp_1', name: '鼓组', level: 0.5, mute: true }]
    normalizeProject(project)
    assert.equal(project.groups.length, 1)
    assert.equal(project.groups[0].name, '鼓组')
    assert.equal(project.groups[0].level, 0.5)
    assert.equal(project.groups[0].mute, true)
    const old = createEmptyProject()
    delete old.groups
    normalizeProject(old)
    assert.deepEqual(old.groups, [])
  })

  it('normalizeProject：track.output 合法 group 保留；master 省略；未知 group 清除', () => {
    const project = groupProject()
    project.groups = [{ id: 'grp_1', name: 'G' }]
    project.tracks[0].output = 'grp_1'
    project.tracks[1].output = 'master'
    project.tracks[2].output = 'grp_404'
    normalizeProject(project)
    assert.equal(project.tracks[0].output, 'grp_1')
    assert.equal(Object.hasOwn(project.tracks[1], 'output'), false)
    assert.equal(Object.hasOwn(project.tracks[2], 'output'), false)
  })

  it('normalizeProject：群组删除后轨道 output 自动回 master（无效 output 移除）', () => {
    const project = groupProject()
    project.tracks[0].output = 'grp_1'
    project.tracks[1].output = 'grp_1'
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'output'), false)
    assert.equal(Object.hasOwn(project.tracks[1], 'output'), false)
  })

  it('normalizeProject：groups 幂等', () => {
    const project = groupProject()
    project.groups = [{ id: 'grp_1', name: 'G', level: 0.3, effects: [{ id: 'fx_1', type: 'filter', params: {} }] }]
    project.tracks[0].output = 'grp_1'
    normalizeProject(project)
    const snapshot = JSON.stringify({ groups: project.groups, outputs: project.tracks.map((track) => track.output) })
    normalizeProject(project)
    assert.equal(JSON.stringify({ groups: project.groups, outputs: project.tracks.map((track) => track.output) }), snapshot)
  })

  it('normalizeGroup：effects 链持久化且 id 唯一', () => {
    const group = normalizeGroup({
      effects: [
        { id: 'fx_1', type: 'filter', params: {} },
        { id: 'fx_1', type: 'drive', params: {} },
      ],
    }, { index: 0 })
    assert.equal(group.effects.length, 2)
    assert.equal(new Set(group.effects.map((fx) => fx.id)).size, 2)
  })

  it('createEmptyProject 带 groups=[]', () => {
    assert.deepEqual(createEmptyProject().groups, [])
  })

  it('track.output 支持 synth/drum/audio 三类轨道（规范层不限制 kind）', () => {
    const project = groupProject()
    project.groups = [{ id: 'grp_1', name: 'G' }]
    for (const track of project.tracks) track.output = 'grp_1'
    normalizeProject(project)
    assert.deepEqual(project.tracks.map((track) => track.output), ['grp_1', 'grp_1', 'grp_1'])
  })
})

/* R4a 补充：模型边界 */
describe('model R4a — 补充边界', () => {
  it('normalizeGroup：效果器参数与位置保留', () => {
    const group = normalizeGroup({
      effects: [
        { id: 'fx_1', type: 'filter', enabled: true, params: { cutoff: 500, resonance: 2 } },
        { id: 'fx_2', type: 'compressor', enabled: false, params: { threshold: -12 } },
      ],
    }, { index: 0 })
    assert.deepEqual(group.effects.map((fx) => fx.type), ['filter', 'compressor'])
    assert.equal(group.effects[0].params.cutoff, 500)
    assert.equal(group.effects[1].enabled, false)
  })

  it('normalizeGroups：组 id 全唯一且按 grp_n 形式', () => {
    const groups = normalizeGroups([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    assert.deepEqual(groups.map((group) => group.id), ['grp_1', 'grp_2', 'grp_3'])
  })

  it('track.output 空字符串/非字符串被清除', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'S' })]
    project.groups = [{ id: 'grp_1', name: 'G' }]
    for (const value of ['', null, 42, {}]) {
      project.tracks[0].output = value
      normalizeProject(project)
      assert.equal(Object.hasOwn(project.tracks[0], 'output'), false, JSON.stringify(value))
    }
  })

  it('normalizeGroup：效果器链超过上限时截断', () => {
    const effects = Array.from({ length: 20 }, (_, index) => ({ id: `fx_${index + 1}`, type: 'filter', params: {} }))
    const group = normalizeGroup({ effects }, { index: 0 })
    assert.ok(group.effects.length <= 16)
    assert.ok(group.effects.every((fx) => fx.type === 'filter'))
  })

  it('normalizeGroup：中文组名 trim 后保留', () => {
    assert.equal(normalizeGroup({ name: '  鼓组 A  ' }, { index: 0 }).name, '鼓组 A')
  })

  it('normalizeProject：组 FX 在工程规范化后保持链顺序', () => {
    const project = createEmptyProject()
    project.groups = [{ id: 'grp_1', name: 'G', effects: [
      { id: 'fx_1', type: 'filter', params: { cutoff: 700 } },
      { id: 'fx_2', type: 'drive', params: {} },
    ] }]
    normalizeProject(project)
    assert.deepEqual(project.groups[0].effects.map((fx) => fx.type), ['filter', 'drive'])
  })
})

/* ------------------------------------------------------------------------- */
/* R4b：sendMode / 相位 / mono / bypassFx / pdcMs 模型                         */
/* ------------------------------------------------------------------------- */

describe('model R4b — 混音控制字段', () => {
  function r4bProject() {
    const project = createEmptyProject({ title: 'R4b', lengthBars: 8 })
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'synth', name: 'Synth' }),
      makeTrack({ id: 'trk_2', kind: 'drum', name: 'Drums' }),
    ]
    return project
  }

  it('常量：sendMode 仅 post/pre、pdcMs 上限 500', () => {
    assert.deepEqual([...TRACK_SEND_MODES], ['post', 'pre'])
    assert.equal(PDC_MS_MAX, 500)
  })

  it('normalizePdcMs：默认/1 位小数/夹紧/非法', () => {
    assert.equal(normalizePdcMs(undefined), 0)
    assert.equal(normalizePdcMs(null), 0)
    assert.equal(normalizePdcMs(0), 0)
    assert.equal(normalizePdcMs(12.34), 12.3)
    assert.equal(normalizePdcMs(12.35), 12.4)
    assert.equal(normalizePdcMs(999), PDC_MS_MAX)
    assert.equal(normalizePdcMs(-5), 0)
    assert.equal(normalizePdcMs('x'), 0)
  })

  it('normalizeProject：默认值全部省略（旧工程零变化）', () => {
    const project = r4bProject()
    project.tracks[0].sendMode = 'post'
    project.tracks[0].phaseInvert = false
    project.tracks[0].mono = false
    project.tracks[0].bypassFx = false
    project.tracks[0].pdcMs = 0
    normalizeProject(project)
    for (const key of ['sendMode', 'phaseInvert', 'mono', 'bypassFx', 'pdcMs']) {
      assert.equal(Object.hasOwn(project.tracks[0], key), false, key)
    }
  })

  it('normalizeProject：sendMode=pre 保留；非法模式删除', () => {
    const project = r4bProject()
    project.tracks[0].sendMode = 'pre'
    project.tracks[1].sendMode = 'POST'
    normalizeProject(project)
    assert.equal(project.tracks[0].sendMode, 'pre')
    assert.equal(Object.hasOwn(project.tracks[1], 'sendMode'), false)
  })

  it('normalizeProject：phaseInvert/mono/bypassFx 仅 true 保留', () => {
    const project = r4bProject()
    project.tracks[0].phaseInvert = true
    project.tracks[0].mono = true
    project.tracks[0].bypassFx = true
    project.tracks[1].phaseInvert = 1
    project.tracks[1].mono = 'true'
    project.tracks[1].bypassFx = false
    normalizeProject(project)
    assert.equal(project.tracks[0].phaseInvert, true)
    assert.equal(project.tracks[0].mono, true)
    assert.equal(project.tracks[0].bypassFx, true)
    for (const key of ['phaseInvert', 'mono', 'bypassFx']) assert.equal(Object.hasOwn(project.tracks[1], key), false, key)
  })

  it('normalizeProject：pdcMs 保留 1 位小数、0 省略、>500 夹紧', () => {
    const project = r4bProject()
    project.tracks[0].pdcMs = 123.456
    project.tracks[1].pdcMs = 900
    normalizeProject(project)
    assert.equal(project.tracks[0].pdcMs, 123.5)
    assert.equal(project.tracks[1].pdcMs, 500)
  })

  it('normalizeProject：轨道字段幂等', () => {
    const project = r4bProject()
    Object.assign(project.tracks[0], { sendMode: 'pre', phaseInvert: true, mono: true, bypassFx: true, pdcMs: 42.26 })
    normalizeProject(project)
    const snapshot = JSON.stringify(project.tracks[0])
    normalizeProject(project)
    assert.equal(JSON.stringify(project.tracks[0]), snapshot)
  })

  it('normalizeGroup：bypassFx/pdcMs 规范化（0/非法省略，>500 夹紧）', () => {
    const group = normalizeGroup({ bypassFx: true, pdcMs: 250.55 }, { index: 0 })
    assert.equal(group.bypassFx, true)
    assert.equal(group.pdcMs, 250.6)
    const zero = normalizeGroup({ bypassFx: false, pdcMs: 0 }, { index: 0 })
    assert.equal(Object.hasOwn(zero, 'bypassFx'), false)
    assert.equal(Object.hasOwn(zero, 'pdcMs'), false)
    const invalid = normalizeGroup({ bypassFx: 'yes', pdcMs: 'x' }, { index: 0 })
    assert.equal(Object.hasOwn(invalid, 'bypassFx'), false)
    assert.equal(Object.hasOwn(invalid, 'pdcMs'), false)
  })

  it('normalizeProject：audio 轨也支持 R4b 字段', () => {
    const project = createEmptyProject()
    const audio = makeTrack({ id: 'trk_1', kind: 'audio', name: 'Audio' })
    audio.sendMode = 'pre'
    audio.phaseInvert = true
    audio.pdcMs = 10
    project.tracks = [audio]
    normalizeProject(project)
    assert.equal(project.tracks[0].sendMode, 'pre')
    assert.equal(project.tracks[0].phaseInvert, true)
    assert.equal(Object.hasOwn(project.tracks[0], 'mono'), false)
    assert.equal(project.tracks[0].pdcMs, 10)
  })

  it('makeTrack 新建轨道默认不写 R4b 字段', () => {
    const track = makeTrack({ id: 'trk_1', kind: 'synth', name: 'S' })
    for (const key of ['sendMode', 'phaseInvert', 'mono', 'bypassFx', 'pdcMs']) {
      assert.equal(Object.hasOwn(track, key), false, key)
    }
  })

  it('normalizeProject：字段组合全部保留（pre+phase+mono+bypass+pdc）', () => {
    const project = r4bProject()
    Object.assign(project.tracks[0], { sendMode: 'pre', phaseInvert: true, mono: true, bypassFx: true, pdcMs: 7.5 })
    normalizeProject(project)
    assert.deepEqual(
      {
        sendMode: project.tracks[0].sendMode,
        phaseInvert: project.tracks[0].phaseInvert,
        mono: project.tracks[0].mono,
        bypassFx: project.tracks[0].bypassFx,
        pdcMs: project.tracks[0].pdcMs,
      },
      { sendMode: 'pre', phaseInvert: true, mono: true, bypassFx: true, pdcMs: 7.5 },
    )
  })

  it('pdcMs 小数边界：0.04 → 0、0.05 → 0.1、499.96 → 500', () => {
    assert.equal(normalizePdcMs(0.04), 0)
    assert.equal(normalizePdcMs(0.05), 0.1)
    assert.equal(normalizePdcMs(499.96), 500)
  })

  it('normalizeProject：sendMode 非字符串删除', () => {
    const project = r4bProject()
    project.tracks[0].sendMode = 1
    project.tracks[1].sendMode = { mode: 'pre' }
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'sendMode'), false)
    assert.equal(Object.hasOwn(project.tracks[1], 'sendMode'), false)
  })

  it('normalizeGroup：默认组无 bypassFx/pdcMs', () => {
    const group = normalizeGroup({}, { index: 0 })
    assert.equal(Object.hasOwn(group, 'bypassFx'), false)
    assert.equal(Object.hasOwn(group, 'pdcMs'), false)
  })
})

/* R4b 补充：边界 */
describe('model R4b — 补充边界', () => {
  it('normalizePdcMs：数字字符串也可规范化', () => {
    assert.equal(normalizePdcMs('12.5'), 12.5)
    assert.equal(normalizePdcMs(''), 0)
    assert.equal(normalizePdcMs(true), 1)
  })

  it('normalizeGroup：pdcMs 小数四舍五入', () => {
    assert.equal(normalizeGroup({ pdcMs: 0.04 }, { index: 0 }).pdcMs, undefined)
    assert.equal(normalizeGroup({ pdcMs: 0.05 }, { index: 0 }).pdcMs, 0.1)
  })

  it('normalizeProject：多轨 R4b 字段互不影响', () => {
    const project = createEmptyProject()
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'synth', name: 'A' }),
      makeTrack({ id: 'trk_2', kind: 'drum', name: 'B' }),
    ]
    project.tracks[0].sendMode = 'pre'
    project.tracks[0].mono = true
    project.tracks[1].phaseInvert = true
    project.tracks[1].pdcMs = 60
    normalizeProject(project)
    assert.equal(project.tracks[0].sendMode, 'pre')
    assert.equal(project.tracks[0].mono, true)
    assert.equal(project.tracks[0].phaseInvert, undefined)
    assert.equal(project.tracks[1].sendMode, undefined)
    assert.equal(project.tracks[1].phaseInvert, true)
    assert.equal(project.tracks[1].pdcMs, 60)
  })
})

/* ------------------------------------------------------------------------- */
/* R4c：project.scenes 混音场景快照模型                                        */
/* ------------------------------------------------------------------------- */

describe('model R4c — 混音场景', () => {
  function sceneProject() {
    const project = createEmptyProject({ title: 'R4c', lengthBars: 8 })
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'synth', name: 'Synth' }),
      makeTrack({ id: 'trk_2', kind: 'drum', name: 'Drums' }),
    ]
    project.tracks[0].volume = 0.5
    project.tracks[0].pan = -0.2
    project.tracks[0].sendMode = 'pre'
    project.tracks[0].phaseInvert = true
    project.tracks[0].pdcMs = 12.5
    project.tracks[0].effects = [{ id: 'fx_1', type: 'filter', enabled: true, params: { cutoff: 900 } }]
    project.groups = [{ id: 'grp_1', name: 'G', level: 0.4, effects: [{ id: 'fx_2', type: 'drive', params: { amount: 0.3 } }] }]
    project.tracks[1].output = 'grp_1'
    project.master.volume = 0.7
    project.master.effects = [{ id: 'fx_3', type: 'eq3', params: { low: 1 } }]
    project.buses.reverb.level = 0.2
    project.buses.reverb.effects = [{ id: 'fx_4', type: 'filter', params: { mode: 'highpass' } }]
    project.buses.delay.level = 0.3
    return project
  }

  it('常量：最多 8 场景、名称 40 字符', () => {
    assert.equal(MAX_SCENES, 8)
    assert.equal(SCENE_NAME_MAX, 40)
  })

  it('captureSceneState：track/group/master/buses 混音字段与 effects 深拷贝', () => {
    const project = sceneProject()
    const state = captureSceneState(project)
    assert.equal(state.tracks.length, 2)
    const track = state.tracks[0]
    assert.equal(track.id, 'trk_1')
    assert.equal(track.volume, 0.5)
    assert.equal(track.pan, -0.2)
    assert.equal(track.sendMode, 'pre')
    assert.equal(track.phaseInvert, true)
    assert.equal(track.pdcMs, 12.5)
    assert.equal(track.output, 'master')
    assert.equal(track.effects[0].params.cutoff, 900)
    assert.notEqual(track.effects, project.tracks[0].effects, 'effects 必须深拷贝')
    assert.notEqual(track.effects[0].params, project.tracks[0].effects[0].params)
    assert.equal(state.tracks[1].output, 'grp_1')
    assert.equal(state.groups[0].level, 0.4)
    assert.equal(state.groups[0].effects[0].params.amount, 0.3)
    assert.equal(state.master.volume, 0.7)
    assert.equal(state.master.effects[0].params.low, 1)
    assert.equal(state.buses.reverb.level, 0.2)
    assert.equal(state.buses.reverb.effects[0].params.mode, 'highpass')
    assert.equal(state.buses.delay.level, 0.3)
  })

  it('captureSceneState：缺省字段使用默认值', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'S' })]
    const state = captureSceneState(project)
    const track = state.tracks[0]
    assert.equal(track.sendMode, 'post')
    assert.equal(track.phaseInvert, false)
    assert.equal(track.mono, false)
    assert.equal(track.bypassFx, false)
    assert.equal(track.pdcMs, 0)
    assert.equal(track.output, 'master')
    assert.deepEqual(track.effects, [])
    assert.equal(state.groups.length, 0)
    assert.ok(state.master.volume > 0)
    assert.ok(state.buses.reverb.level >= 0)
  })

  it('captureSceneState：state 不含 notes/clips/编排/自动化字段', () => {
    const project = sceneProject()
    const state = captureSceneState(project)
    assert.equal(Object.hasOwn(state, 'clips'), false)
    assert.equal(Object.hasOwn(state, 'patterns'), false)
    const track = state.tracks[0]
    for (const key of Object.keys(track)) {
      assert.ok([
        'id', 'volume', 'pan', 'mute', 'solo', 'sends', 'sendMode', 'phaseInvert',
        'mono', 'bypassFx', 'pdcMs', 'output', 'effects',
      ].includes(key), key)
    }
  })

  it('captureSceneState：修改快照不影响工程（深拷贝）', () => {
    const project = sceneProject()
    const state = captureSceneState(project)
    state.tracks[0].effects[0].params.cutoff = 1
    state.tracks[0].volume = 0.01
    state.groups[0].effects[0].params.amount = 0.99
    state.master.effects[0].params.low = -5
    state.buses.reverb.effects[0].params.mode = 'lowpass'
    assert.equal(project.tracks[0].effects[0].params.cutoff, 900)
    assert.equal(project.tracks[0].volume, 0.5)
    assert.equal(project.groups[0].effects[0].params.amount, 0.3)
    assert.equal(project.master.effects[0].params.low, 1)
    assert.equal(project.buses.reverb.effects[0].params.mode, 'highpass')
  })

  it('normalizeScene：默认 id/name/at 与 state 规范化', () => {
    const project = sceneProject()
    const state = captureSceneState(project)
    const scene = normalizeScene({ state }, { index: 0 })
    assert.equal(scene.id, 'scene_1')
    assert.equal(scene.name, 'Scene 1')
    assert.equal(Object.hasOwn(scene, 'at'), false)
    assert.equal(scene.state.tracks.length, 2)
    assert.equal(scene.state.tracks[0].effects[0].type, 'filter')
  })

  it('normalizeScene：非法返回 null', () => {
    for (const raw of [null, undefined, [], 'x', 3]) assert.equal(normalizeScene(raw, { index: 0 }), null)
  })

  it('normalizeScene：at 字符串保留；非字符串丢弃', () => {
    assert.equal(normalizeScene({ name: 'A', at: '2026-01-01T00:00:00.000Z', state: {} }, { index: 0 }).at, '2026-01-01T00:00:00.000Z')
    assert.equal(Object.hasOwn(normalizeScene({ name: 'A', at: 123, state: {} }, { index: 0 }), 'at'), false)
  })

  it('normalizeScenes：≤8 截断、id/名称唯一', () => {
    const raw = Array.from({ length: 12 }, (_, index) => ({ id: 'scene_1', name: `S${index}`, state: {} }))
    const scenes = normalizeScenes(raw)
    assert.equal(scenes.length, MAX_SCENES)
    assert.equal(new Set(scenes.map((scene) => scene.id)).size, MAX_SCENES)
    // 全部同名时只保留第一条
    assert.equal(normalizeScenes([{ name: 'X' }, { name: 'X' }, { name: 'Y' }]).length, 2)
  })

  it('normalizeScenes：自动 id scene_n 从 1 开始并跳过占用', () => {
    const scenes = normalizeScenes([
      { id: 'scene_2', name: 'B' },
      { name: 'A' },
      { id: 'bad', name: 'C' },
    ])
    assert.deepEqual(scenes.map((scene) => scene.id), ['scene_2', 'scene_3', 'scene_4'])
  })

  it('normalizeScene：名称 trim/控制字符清理/长度截断/空回退', () => {
    assert.equal(normalizeScene({ name: '  鼓组场景  ', state: {} }, { index: 0 }).name, '鼓组场景')
    assert.equal(normalizeScene({ name: 'a'.repeat(60), state: {} }, { index: 0 }).name.length, SCENE_NAME_MAX)
    assert.equal(normalizeScene({ name: 'bad' + String.fromCharCode(1) + 'name', state: {} }, { index: 0 }).name, 'badname')
    assert.equal(normalizeScene({ name: '   ', state: {} }, { index: 2 }).name, 'Scene 3')
  })

  it('normalizeProject：scenes 持久化；旧工程 scenes=[]', () => {
    const project = sceneProject()
    project.scenes = [{ name: 'A', state: captureSceneState(project) }]
    normalizeProject(project)
    assert.equal(project.scenes.length, 1)
    assert.equal(project.scenes[0].id, 'scene_1')
    assert.equal(project.scenes[0].state.tracks.length, 2)
    const old = createEmptyProject()
    delete old.scenes
    normalizeProject(old)
    assert.deepEqual(old.scenes, [])
  })

  it('normalizeProject：scenes 幂等', () => {
    const project = sceneProject()
    project.scenes = [{ name: 'A', at: '2026-01-01T00:00:00.000Z', state: captureSceneState(project) }]
    normalizeProject(project)
    const snapshot = JSON.stringify(project.scenes)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.scenes), snapshot)
  })

  it('normalizeScene：state 中缺 id 的 track/group 条目丢弃、未知字段不保留', () => {
    const scene = normalizeScene({
      name: 'A',
      state: {
        tracks: [{ id: 'trk_1', volume: 0.3, notes: [{ pitch: 60 }], bogus: true }, { volume: 0.4 }],
        groups: [{ level: 0.2 }, { id: 'grp_1', level: 0.6 }],
        master: { volume: 0.5 },
        buses: { reverb: { level: 0.1 }, delay: { level: 0.2 } },
      },
    }, { index: 0 })
    assert.equal(scene.state.tracks.length, 1)
    assert.deepEqual(Object.keys(scene.state.tracks[0]).sort(), [
      'bypassFx', 'effects', 'id', 'mono', 'mute', 'output', 'pan', 'pdcMs', 'phaseInvert', 'sendMode', 'sends', 'solo', 'volume',
    ])
    assert.equal(scene.state.groups.length, 1)
    assert.equal(scene.state.groups[0].id, 'grp_1')
    assert.equal(scene.state.groups[0].level, 0.6)
  })

  it('sceneSummary：只含摘要字段，不含 state', () => {
    const summary = sceneSummary({ id: 'scene_1', name: 'A', at: 'x', state: { tracks: [1, 2], groups: [1] } })
    assert.deepEqual(summary, { id: 'scene_1', name: 'A', at: 'x', trackCount: 2, groupCount: 1 })
    assert.equal(Object.hasOwn(summary, 'state'), false)
  })

  it('captureSceneState：非法 effects 被规范化丢弃；track sends 默认值', () => {
    const project = createEmptyProject()
    const track = makeTrack({ id: 'trk_1', kind: 'synth', name: 'S' })
    track.effects = [{ id: 'fx_1', type: 'bogus', params: {} }]
    project.tracks = [track]
    const state = captureSceneState(project)
    assert.deepEqual(state.tracks[0].effects, [])
    assert.deepEqual(state.tracks[0].sends, { reverb: 0.18, delay: 0.12 })
  })
})

/* ------------------------------------------------------------------------- */
/* R4d：track.automationMode 模型                                             */
/* ------------------------------------------------------------------------- */

describe('model R4d — 自动化模式', () => {
  function automationProject() {
    const project = createEmptyProject()
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'synth', name: 'Synth' }),
      makeTrack({ id: 'trk_2', kind: 'drum', name: 'Drums' }),
      makeTrack({ id: 'trk_3', kind: 'audio', name: 'Audio' }),
    ]
    return project
  }

  it('常量：read/touch/latch/write 四种模式', () => {
    assert.deepEqual([...TRACK_AUTOMATION_MODES], ['read', 'touch', 'latch', 'write'])
  })

  it('默认/缺省：工程对象不写字段', () => {
    const project = automationProject()
    normalizeProject(project)
    for (const track of project.tracks) assert.equal(Object.hasOwn(track, 'automationMode'), false)
  })

  it('合法模式全部保留', () => {
    const project = automationProject()
    project.tracks[0].automationMode = 'touch'
    project.tracks[1].automationMode = 'latch'
    project.tracks[2].automationMode = 'write'
    normalizeProject(project)
    assert.deepEqual(project.tracks.map((track) => track.automationMode), ['touch', 'latch', 'write'])
  })

  it('非法模式回 read（字段删除）', () => {
    const project = automationProject()
    for (const value of ['bogus', 'TOUCH', 'Read', 123, null, {}, true]) {
      project.tracks[0].automationMode = value
      normalizeProject(project)
      assert.equal(Object.hasOwn(project.tracks[0], 'automationMode'), false, JSON.stringify(value))
    }
  })

  it('显式 read 被省略（默认即可）', () => {
    const project = automationProject()
    project.tracks[0].automationMode = 'read'
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'automationMode'), false)
  })

  it('normalizeProject：幂等', () => {
    const project = automationProject()
    project.tracks[0].automationMode = 'write'
    normalizeProject(project)
    const snapshot = JSON.stringify(project.tracks)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.tracks), snapshot)
  })

  it('旧工程缺字段：normalize 后仍无字段（read 默认）', () => {
    const project = automationProject()
    delete project.tracks[0].automationMode
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'automationMode'), false)
  })

  it('synth/drum/audio 三类轨道均支持', () => {
    const project = automationProject()
    for (const track of project.tracks) track.automationMode = 'latch'
    normalizeProject(project)
    assert.deepEqual(project.tracks.map((track) => track.kind), ['synth', 'drum', 'audio'])
    assert.deepEqual(project.tracks.map((track) => track.automationMode), ['latch', 'latch', 'latch'])
  })

  it('与 R4b 混音字段共存', () => {
    const project = automationProject()
    Object.assign(project.tracks[0], {
      automationMode: 'touch',
      sendMode: 'pre',
      phaseInvert: true,
      mono: true,
      bypassFx: true,
      pdcMs: 12.5,
    })
    normalizeProject(project)
    assert.equal(project.tracks[0].automationMode, 'touch')
    assert.equal(project.tracks[0].sendMode, 'pre')
    assert.equal(project.tracks[0].phaseInvert, true)
    assert.equal(project.tracks[0].pdcMs, 12.5)
  })

  it('多轨模式互不影响（逐轨独立字段）', () => {
    const project = automationProject()
    project.tracks[0].automationMode = 'write'
    project.tracks[1].automationMode = 'read'
    project.tracks[2].automationMode = 'touch'
    normalizeProject(project)
    assert.equal(project.tracks[0].automationMode, 'write')
    assert.equal(Object.hasOwn(project.tracks[1], 'automationMode'), false)
    assert.equal(project.tracks[2].automationMode, 'touch')
  })
})

/* ------------------------------------------------------------------------- */
/* R5a：音色库 18→32                                                          */
/* ------------------------------------------------------------------------- */

describe('catalog R5a — 32 个采样乐器', () => {
  const R5A_NEW = [
    ['vibraphone', 11], ['glockenspiel', 9], ['church_organ', 19], ['jazz_guitar', 26], ['muted_guitar', 28],
    ['picked_bass', 34], ['fretless_bass', 35], ['synth_bass', 38], ['viola', 41], ['pizzicato_strings', 45],
    ['voice_oohs', 53], ['french_horn', 60], ['trombone', 57], ['clarinet', 71],
  ]

  it('SYNTH_PRESETS 共 32 个；旧 18 个 id/顺序保持不变', () => {
    assert.equal(SYNTH_PRESETS.length, 32)
    assert.equal(SAMPLED_INSTRUMENTS.length, 32)
    assert.equal(SYNTH_PRESETS, SAMPLED_INSTRUMENTS)
    assert.deepEqual(SYNTH_PRESETS.slice(0, 18).map((preset) => preset.id), [
      'grand_piano', 'bright_piano', 'tine_epiano', 'harpsichord', 'music_box', 'marimba',
      'tonewheel_organ', 'nylon_guitar', 'steel_guitar', 'acoustic_bass', 'finger_bass',
      'violin', 'cello', 'strings_ensemble', 'concert_choir', 'trumpet', 'flute', 'warm_pad',
    ])
  })

  it('14 个新增 preset 的 id/程序号与契约一致', () => {
    assert.deepEqual(SYNTH_PRESETS.slice(18).map((preset) => [preset.id, preset.soundfont.program]), R5A_NEW)
  })

  it('全部 32 个程序号唯一，bank 均为 0', () => {
    const programs = SYNTH_PRESETS.map((preset) => preset.soundfont.program)
    assert.equal(new Set(programs).size, 32)
    assert.ok(SYNTH_PRESETS.every((preset) => preset.soundfont.bank === 0))
  })

  it('全部 id 唯一且为小写 snake_case', () => {
    const ids = SYNTH_PRESETS.map((preset) => preset.id)
    assert.equal(new Set(ids).size, 32)
    for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]*$/)
  })

  it('新增 preset 结构完整：name/label/中文 category/color/desc/gainDb', () => {
    for (const [id] of R5A_NEW) {
      const preset = findSynthPreset(id)
      assert.ok(preset, id)
      assert.equal(preset.id, id)
      assert.ok(typeof preset.name === 'string' && preset.name.length > 0, `${id}.name`)
      assert.ok(/[\u4e00-\u9fa5]/.test(preset.label), `${id}.label`)
      assert.ok(/[\u4e00-\u9fa5]/.test(preset.category), `${id}.category`)
      assert.match(preset.color, /^#[0-9A-Fa-f]{6}$/, `${id}.color`)
      assert.ok(/[\u4e00-\u9fa5]/.test(preset.desc), `${id}.desc`)
      assert.ok(Number.isFinite(preset.gainDb), `${id}.gainDb`)
      assert.ok(preset.gainDb > -30 && preset.gainDb < 40, `${id}.gainDb 范围`)
      assert.equal(Object.hasOwn(preset, 'params'), false)
      assert.equal(Object.hasOwn(preset, 'sampler'), false)
    }
  })

  it('新增分类覆盖：Keys/Guitar/Bass/Strings/Brass/Woodwind/Choir', () => {
    const categories = new Map()
    for (const preset of SYNTH_PRESETS) categories.set(preset.category, (categories.get(preset.category) ?? 0) + 1)
    for (const category of ['键盘 Keys', '吉他 Guitar', '贝斯 Bass', '弦乐 Strings', '合唱 Choir', '铜管 Brass', '木管 Woodwind', '铺底 Pad']) {
      assert.ok(categories.has(category), category)
    }
    assert.equal(categories.get('吉他 Guitar'), 4)
    assert.equal(categories.get('贝斯 Bass'), 5)
    assert.equal(categories.get('弦乐 Strings'), 5)
    assert.equal(categories.get('合唱 Choir'), 2)
    assert.equal(categories.get('铜管 Brass'), 3)
    assert.equal(categories.get('木管 Woodwind'), 2)
    assert.ok(categories.get('键盘 Keys') >= 8)
  })

  it('新增 preset 的 findSynthPreset 查找命中；未知仍 undefined', () => {
    for (const [id] of R5A_NEW) assert.equal(findSynthPreset(id).id, id)
    assert.equal(findSynthPreset('vibraphone').soundfont.program, 11)
    assert.equal(findSynthPreset('nope'), undefined)
    assert.equal(findSynthPreset('supersaw'), undefined)
  })

  it('旧 18 个 preset 的 name/label/gainDb 未被改动', () => {
    assert.deepEqual(SYNTH_PRESETS.slice(0, 5).map((preset) => preset.label), ['三角钢琴', '亮音钢琴', '电钢琴', '羽管键琴', '八音盒'])
    assert.deepEqual(SYNTH_PRESETS.slice(0, 5).map((preset) => preset.gainDb), [10.5, 10.5, 1, 32.5, 2])
    assert.equal(SYNTH_PRESETS[15].id, 'trumpet')
    assert.equal(SYNTH_PRESETS[16].id, 'flute')
  })

  it('默认 preset 仍为 grand_piano；旧 id 查找不变', () => {
    assert.equal(SYNTH_PRESETS[0].id, 'grand_piano')
    assert.equal(findSynthPreset('grand_piano').soundfont.program, 0)
    assert.equal(findSynthPreset('warm_pad').soundfont.program, 89)
  })

  it('新增 id 与旧 id 不冲突，且不在旧 18 中', () => {
    const oldIds = new Set(SYNTH_PRESETS.slice(0, 18).map((preset) => preset.id))
    for (const [id] of R5A_NEW) assert.equal(oldIds.has(id), false, id)
  })
})

/* R5a 补充：新增音色细节 */
describe('catalog R5a — 补充细节', () => {
  const GAIN_TABLE = {
    vibraphone: -2,
    glockenspiel: 14.5,
    church_organ: 17.5,
    jazz_guitar: 12.5,
    muted_guitar: 17.5,
    picked_bass: 18.5,
    fretless_bass: 6,
    synth_bass: -6.5,
    viola: 9.5,
    pizzicato_strings: 19.5,
    voice_oohs: 15.5,
    french_horn: 27.5,
    trombone: 7,
    clarinet: 1.5,
  }

  it('新增 14 个 preset 的 gainDb 使用 SF2 实测归一键值', () => {
    for (const [id, gainDb] of Object.entries(GAIN_TABLE)) {
      const preset = findSynthPreset(id)
      assert.ok(preset, id)
      assert.equal(preset.gainDb, gainDb, id)
    }
  })

  it('新增程序号与旧 18 个不冲突', () => {
    const oldPrograms = new Set(SYNTH_PRESETS.slice(0, 18).map((preset) => preset.soundfont.program))
    for (const preset of SYNTH_PRESETS.slice(18)) {
      assert.equal(oldPrograms.has(preset.soundfont.program), false, preset.id)
    }
  })

  it('新增 preset color 两两不同（便于 UI 区分）', () => {
    const colors = SYNTH_PRESETS.slice(18).map((preset) => preset.color)
    assert.equal(new Set(colors).size, colors.length)
    for (const color of colors) assert.match(color, /^#[0-9A-Fa-f]{6}$/)
  })

  it('findSynthPreset 大小写敏感：仅小写 id 命中', () => {
    assert.ok(findSynthPreset('vibraphone'))
    assert.equal(findSynthPreset('Vibraphone'), undefined)
    assert.equal(findSynthPreset('VIBRAPHONE'), undefined)
  })

  it('新增 preset 的 desc/label 非空且中文', () => {
    for (const preset of SYNTH_PRESETS.slice(18)) {
      assert.ok(preset.label.trim().length > 0)
      assert.ok(preset.desc.trim().length > 0)
      assert.ok(/[\u4e00-\u9fa5]/.test(preset.desc), preset.id)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* R5b：track.instrumentParams 模型                                           */
/* ------------------------------------------------------------------------- */

describe('model R5b — 采样器乐器参数', () => {
  function instrProject() {
    const project = createEmptyProject()
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'synth', name: 'Synth' }),
      makeTrack({ id: 'trk_2', kind: 'drum', name: 'Drums' }),
      makeTrack({ id: 'trk_3', kind: 'audio', name: 'Audio' }),
    ]
    return project
  }

  it('规格/默认值：attack .005 / release .2 / cutoff 20000 / Q .7 / rate 5 / depth 0', () => {
    assert.deepEqual(Object.keys(INSTRUMENT_PARAM_SPECS), ['attack', 'release', 'filterCutoff', 'filterQ', 'lfoRate', 'lfoDepth'])
    assert.deepEqual({ ...DEFAULT_INSTRUMENT_PARAMS }, {
      attack: 0.005,
      release: 0.2,
      filterCutoff: 20000,
      filterQ: 0.7,
      lfoRate: 5,
      lfoDepth: 0,
    })
    assert.deepEqual(
      Object.fromEntries(Object.entries(INSTRUMENT_PARAM_SPECS).map(([key, spec]) => [key, [spec.min, spec.max]])),
      {
        attack: [0.001, 2],
        release: [0.01, 4],
        filterCutoff: [100, 20000],
        filterQ: [0.1, 12],
        lfoRate: [0.1, 12],
        lfoDepth: [0, 100],
      },
    )
  })

  it('normalizeInstrumentParams：全默认值返回 {}', () => {
    assert.deepEqual(normalizeInstrumentParams({ ...DEFAULT_INSTRUMENT_PARAMS }), {})
    assert.deepEqual(normalizeInstrumentParams({ attack: 0.005, release: 0.2, filterCutoff: 20000, filterQ: 0.7, lfoRate: 5, lfoDepth: 0 }), {})
  })

  it('normalizeInstrumentParams：非默认字段保留并按规格取整', () => {
    assert.deepEqual(normalizeInstrumentParams({ attack: 0.5, release: 1.25 }), { attack: 0.5, release: 1.25 })
    assert.deepEqual(normalizeInstrumentParams({ attack: 0.0055 }), { attack: 0.006 })
    assert.deepEqual(normalizeInstrumentParams({ release: 0.2 + 0.0004 }), {})
    assert.deepEqual(normalizeInstrumentParams({ release: 0.2 + 0.0006 }), { release: 0.201 })
  })

  it('normalizeInstrumentParams：filterCutoff/filterQ/lfoRate 1 位小数', () => {
    assert.deepEqual(normalizeInstrumentParams({ filterCutoff: 1234.56 }), { filterCutoff: 1234.6 })
    assert.deepEqual(normalizeInstrumentParams({ filterQ: 2.34 }), { filterQ: 2.3 })
    assert.deepEqual(normalizeInstrumentParams({ lfoRate: 5.55 }), { lfoRate: 5.6 })
  })

  it('normalizeInstrumentParams：lfoDepth 整数（四舍五入）', () => {
    assert.deepEqual(normalizeInstrumentParams({ lfoDepth: 50.6 }), { lfoDepth: 51 })
    assert.deepEqual(normalizeInstrumentParams({ lfoDepth: 49.4 }), { lfoDepth: 49 })
    assert.deepEqual(normalizeInstrumentParams({ lfoDepth: 0.4 }), {})
  })

  it('normalizeInstrumentParams：越界夹紧到 min/max', () => {
    assert.deepEqual(normalizeInstrumentParams({ attack: -1 }), { attack: 0.001 })
    assert.deepEqual(normalizeInstrumentParams({ attack: 99 }), { attack: 2 })
    assert.deepEqual(normalizeInstrumentParams({ release: 0 }), { release: 0.01 })
    assert.deepEqual(normalizeInstrumentParams({ release: 99 }), { release: 4 })
    assert.deepEqual(normalizeInstrumentParams({ filterCutoff: 1 }), { filterCutoff: 100 })
    assert.deepEqual(normalizeInstrumentParams({ filterCutoff: 99999 }), {}, '夹到默认值 20000 时省略字段')
    assert.deepEqual(normalizeInstrumentParams({ lfoDepth: 999 }), { lfoDepth: 100 })
  })

  it('normalizeInstrumentParams：未知字段/非法值忽略', () => {
    assert.deepEqual(normalizeInstrumentParams({ bogus: 1, attack: 'x', release: NaN, filterQ: {} }), {})
    assert.deepEqual(normalizeInstrumentParams({ attack: 0.5, unknown: true }), { attack: 0.5 })
  })

  it('normalizeInstrumentParams：非对象返回 {}', () => {
    for (const raw of [null, undefined, [], 'x', 3, true]) assert.deepEqual(normalizeInstrumentParams(raw), {})
  })

  it('normalizeProject：synth 轨保留参数；drum/audio 轨删除', () => {
    const project = instrProject()
    project.tracks[0].instrumentParams = { attack: 0.5, lfoDepth: 30 }
    project.tracks[1].instrumentParams = { attack: 0.5 }
    project.tracks[2].instrumentParams = { release: 1 }
    normalizeProject(project)
    assert.deepEqual(project.tracks[0].instrumentParams, { attack: 0.5, lfoDepth: 30 })
    assert.equal(Object.hasOwn(project.tracks[1], 'instrumentParams'), false)
    assert.equal(Object.hasOwn(project.tracks[2], 'instrumentParams'), false)
  })

  it('normalizeProject：默认值省略 instrumentParams 字段', () => {
    const project = instrProject()
    project.tracks[0].instrumentParams = { attack: 0.005, release: 0.2, filterCutoff: 20000, filterQ: 0.7, lfoRate: 5, lfoDepth: 0 }
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'instrumentParams'), false)
  })

  it('normalizeProject：旧工程无字段默认；幂等', () => {
    const project = instrProject()
    project.tracks[0].instrumentParams = { attack: 0.05, filterCutoff: 800 }
    normalizeProject(project)
    assert.deepEqual(project.tracks[0].instrumentParams, { attack: 0.05, filterCutoff: 800 })
    const snapshot = JSON.stringify(project.tracks)
    normalizeProject(project)
    assert.equal(JSON.stringify(project.tracks), snapshot)
  })

  it('边界值精确保留', () => {
    const project = instrProject()
    project.tracks[0].instrumentParams = { attack: 2, release: 4, filterCutoff: 100, filterQ: 12, lfoRate: 0.1, lfoDepth: 100 }
    normalizeProject(project)
    assert.deepEqual(project.tracks[0].instrumentParams, { attack: 2, release: 4, filterCutoff: 100, filterQ: 12, lfoRate: 0.1, lfoDepth: 100 })
  })

  it('多轨参数互不影响', () => {
    const project = instrProject()
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'synth', name: 'A' }),
      makeTrack({ id: 'trk_2', kind: 'synth', name: 'B' }),
    ]
    project.tracks[0].instrumentParams = { attack: 0.1 }
    project.tracks[1].instrumentParams = { release: 2 }
    normalizeProject(project)
    assert.deepEqual(project.tracks[0].instrumentParams, { attack: 0.1 })
    assert.deepEqual(project.tracks[1].instrumentParams, { release: 2 })
  })

  it('normalizeInstrumentParams：只返回非默认字段（部分参数）', () => {
    assert.deepEqual(normalizeInstrumentParams({ attack: 0.005, release: 1, lfoRate: 5, lfoDepth: 10 }), { release: 1, lfoDepth: 10 })
  })

  it('normalizeProject：保留其他轨道字段（volume/preset/automationMode）', () => {
    const project = instrProject()
    project.tracks[0].volume = 0.4
    project.tracks[0].automationMode = 'write'
    project.tracks[0].instrumentParams = { attack: 0.3 }
    normalizeProject(project)
    assert.equal(project.tracks[0].volume, 0.4)
    assert.equal(project.tracks[0].automationMode, 'write')
    assert.deepEqual(project.tracks[0].instrumentParams, { attack: 0.3 })
  })

  it('new makeTrack 默认不写 instrumentParams', () => {
    assert.equal(Object.hasOwn(makeTrack({ id: 'trk_1', kind: 'synth', name: 'S' }), 'instrumentParams'), false)
  })
})

/* ------------------------------------------------------------------------- */
/* R5c：工程模板                                                              */
/* ------------------------------------------------------------------------- */

describe('templates R5c — 工程模板', () => {
  it('PROJECT_TEMPLATES：5 个模板、顺序与元数据字段完整', () => {
    assert.deepEqual(PROJECT_TEMPLATES.map((template) => template.id), ['empty', 'demo', 'electronic', 'piano', 'song'])
    for (const template of PROJECT_TEMPLATES) {
      assert.ok(typeof template.name === 'string' && template.name.length > 0)
      assert.ok(typeof template.desc === 'string' && template.desc.length > 0)
      assert.ok(Number.isFinite(template.bpm))
      assert.match(template.key, /^[A-G]#?$/)
      assert.ok(['major', 'minor', 'dorian', 'phrygian', 'harmonicMinor'].includes(template.scale))
      assert.ok(Number.isInteger(template.lengthBars) && template.lengthBars > 0)
      assert.ok(Array.isArray(template.tracks))
    }
  })

  it('listProjectTemplates：返回深拷贝（修改不影响模板）', () => {
    const templates = listProjectTemplates()
    assert.equal(templates.length, 5)
    templates[0].name = '改坏'
    templates[2].tracks[0].name = '改坏'
    assert.notEqual(PROJECT_TEMPLATES[0].name, '改坏')
    assert.notEqual(PROJECT_TEMPLATES[2].tracks[0].name, '改坏')
  })

  it('empty 模板：schema3、0 轨、128 BPM/F# minor/32 小节', () => {
    const project = createProjectFromTemplate('empty')
    assert.equal(project.schemaVersion, 3)
    assert.equal(project.tracks.length, 0)
    assert.equal(project.bpm, 128)
    assert.equal(project.key, 'F#')
    assert.equal(project.scale, 'minor')
    assert.equal(project.lengthBars, 32)
  })

  it('demo 模板：7 轨、32 小节、含母带链', () => {
    const project = createProjectFromTemplate('demo')
    assert.equal(project.schemaVersion, 3)
    assert.equal(project.tracks.length, 7)
    assert.equal(project.bpm, 128)
    assert.equal(project.lengthBars, 32)
    assert.ok(project.master.effects.length > 0)
  })

  it('electronic 模板：5 轨、16 小节、鼓+拨片贝斯+合成贝斯+Pad+Lead', () => {
    const project = createProjectFromTemplate('electronic')
    assert.equal(project.schemaVersion, 3)
    assert.equal(project.tracks.length, 5)
    assert.equal(project.lengthBars, 16)
    assert.equal(project.bpm, 128)
    const drums = project.tracks.find((track) => track.kind === 'drum')
    assert.equal(drums.instrument.kit, 'smp_electro')
    const presets = project.tracks.filter((track) => track.kind === 'synth').map((track) => track.instrument.preset)
    for (const id of ['picked_bass', 'synth_bass', 'warm_pad', 'trumpet']) assert.ok(presets.includes(id), id)
  })

  it('piano 模板：2 轨、C 大调、96 BPM、16 小节、无鼓', () => {
    const project = createProjectFromTemplate('piano')
    assert.equal(project.tracks.length, 2)
    assert.equal(project.bpm, 96)
    assert.equal(project.key, 'C')
    assert.equal(project.scale, 'major')
    assert.equal(project.lengthBars, 16)
    assert.equal(project.tracks.some((track) => track.kind === 'drum'), false)
    assert.deepEqual(project.tracks.map((track) => track.instrument.preset), ['grand_piano', 'strings_ensemble'])
  })

  it('song 模板：5 轨、100 BPM、G 大调、piano/bass/strings/lead/drums', () => {
    const project = createProjectFromTemplate('song')
    assert.equal(project.tracks.length, 5)
    assert.equal(project.bpm, 100)
    assert.equal(project.key, 'G')
    assert.equal(project.scale, 'major')
    assert.equal(project.lengthBars, 16)
    const presets = project.tracks.map((track) => track.instrument.preset ?? track.instrument.kit)
    for (const id of ['grand_piano', 'finger_bass', 'strings_ensemble', 'violin', 'smp_acoustic']) {
      assert.ok(presets.includes(id), id)
    }
  })

  it('模板轨道均有合法 preset/kit 与唯一 track id', () => {
    for (const template of PROJECT_TEMPLATES) {
      if (template.id === 'demo') continue
      const project = createProjectFromTemplate(template.id)
      assert.equal(new Set(project.tracks.map((track) => track.id)).size, project.tracks.length, template.id)
      for (const track of project.tracks) {
        assert.ok(track.name.length > 0, template.id)
        if (track.kind === 'drum') assert.ok(track.instrument.kit, `${template.id}/${track.id}`)
        else assert.ok(track.instrument.preset, `${template.id}/${track.id}`)
      }
    }
  })

  it('createProjectFromTemplate：每次返回新对象（互不共享引用）', () => {
    const first = createProjectFromTemplate('piano')
    const second = createProjectFromTemplate('piano')
    assert.notEqual(first, second)
    assert.notEqual(first.tracks[0], second.tracks[0])
    first.tracks[0].volume = 0.1
    assert.notEqual(second.tracks[0].volume, 0.1)
  })

  it('createProjectFromTemplate：未知 id 中文错误', () => {
    for (const id of ['nope', '', null, 'DEMO']) {
      assert.throws(() => createProjectFromTemplate(id), /未知工程模板/)
    }
  })

  it('元数据与创建结果一致（BPM/调式/曲长/轨道数）', () => {
    for (const template of PROJECT_TEMPLATES) {
      const project = createProjectFromTemplate(template.id)
      assert.equal(project.bpm, template.bpm, template.id)
      assert.equal(project.key, template.key, template.id)
      assert.equal(project.scale, template.scale, template.id)
      assert.equal(project.lengthBars, template.lengthBars, template.id)
      assert.equal(project.tracks.length, template.tracks.length, template.id)
    }
  })

  it('模板工程 normalizeProject 幂等', () => {
    const project = createProjectFromTemplate('electronic')
    const snapshot = JSON.stringify(project)
    normalizeProject(project)
    assert.equal(JSON.stringify(project), snapshot)
  })
})

/* ------------------------------------------------------------------------- */
/* R5c：插件 SDK 清单                                                         */
/* ------------------------------------------------------------------------- */

describe('plugins R5c — 插件 SDK', () => {
  it('SDK 版本 1.0；乐器 32 / 效果器 15 / 全部 47', () => {
    assert.equal(PLUGIN_SDK_VERSION, '1.0')
    assert.equal(INSTRUMENT_PLUGINS.length, 32)
    assert.equal(EFFECT_PLUGINS.length, 15)
    assert.equal(ALL_PLUGINS.length, 47)
  })

  it('乐器插件：id/name/kind/category/stateVersion 与 catalog 一致', () => {
    for (const [index, plugin] of INSTRUMENT_PLUGINS.entries()) {
      const preset = SYNTH_PRESETS[index]
      assert.equal(plugin.id, preset.id)
      assert.equal(plugin.name, preset.name)
      assert.equal(plugin.kind, 'instrument')
      assert.equal(plugin.category, preset.category)
      assert.equal(plugin.stateVersion, 1)
      assert.ok(Array.isArray(plugin.params))
    }
  })

  it('乐器参数 schema：6 项且与 INSTRUMENT_PARAM_SPECS 对齐', () => {
    for (const plugin of INSTRUMENT_PLUGINS) {
      assert.equal(plugin.params.length, 6)
      for (const param of plugin.params) {
        const spec = INSTRUMENT_PARAM_SPECS[param.key]
        assert.ok(spec, `${plugin.id}.${param.key}`)
        assert.equal(param.min, spec.min)
        assert.equal(param.max, spec.max)
        assert.equal(param.default, spec.default)
        assert.ok(typeof param.label === 'string' && param.label.length > 0)
        assert.equal(param.type, 'number')
      }
      assert.deepEqual(plugin.params.map((param) => param.key), Object.keys(INSTRUMENT_PARAM_SPECS))
    }
  })

  it('效果器插件：id/name/kind 与 FX_TYPES 一致，参数为全量 schema', () => {
    for (const [index, plugin] of EFFECT_PLUGINS.entries()) {
      const fxType = FX_TYPES[index]
      assert.equal(plugin.id, fxType.id)
      assert.equal(plugin.kind, 'effect')
      assert.equal(plugin.stateVersion, 1)
      assert.deepEqual(plugin.params.map((param) => param.key), Object.keys(FX_PARAM_SPECS[fxType.id]))
    }
  })

  it('效果器参数 schema：数字字段有 min/max/default，枚举字段有 options', () => {
    for (const plugin of EFFECT_PLUGINS) {
      for (const param of plugin.params) {
        assert.ok(param.label.length > 0)
        if (param.type === 'enum') {
          assert.ok(Array.isArray(param.options) && param.options.length > 0, `${plugin.id}.${param.key}`)
        } else if (param.type === 'bool') {
          assert.equal(typeof param.default, 'boolean', `${plugin.id}.${param.key}`)
        } else {
          assert.ok(Number.isFinite(param.min) && Number.isFinite(param.max))
          assert.ok(Number.isFinite(param.default))
        }
      }
    }
  })

  it('getPlugin：已知 id 返回插件，未知返回 null', () => {
    assert.equal(getPlugin('grand_piano').kind, 'instrument')
    assert.equal(getPlugin('filter').kind, 'effect')
    assert.equal(getPlugin('nope'), null)
  })

  it('listPlugins：全部/类型过滤；未知类型中文错误', () => {
    assert.equal(listPlugins().length, 47)
    assert.equal(listPlugins({ type: 'instrument' }).length, 32)
    assert.equal(listPlugins({ type: 'effect' }).length, 15)
    assert.throws(() => listPlugins({ type: 'drum' }), /未知插件类型/)
  })

  it('serializePluginState：乐器状态 JSON 结构/roundtrip', () => {
    const json = serializePluginState('grand_piano', { attack: 0.1, filterCutoff: 800, lfoDepth: 20 })
    const payload = JSON.parse(json)
    assert.equal(payload.sdkVersion, '1.0')
    assert.equal(payload.pluginId, 'grand_piano')
    assert.equal(payload.stateVersion, 1)
    assert.deepEqual(payload.state, { attack: 0.1, filterCutoff: 800, lfoDepth: 20 })
    assert.deepEqual(deserializePluginState('grand_piano', json), { attack: 0.1, filterCutoff: 800, lfoDepth: 20 })
  })

  it('serializePluginState：效果器含 enum 参数（filter mode）', () => {
    const json = serializePluginState('filter', { mode: 'highpass', cutoff: 1200, resonance: 2, mix: 1 })
    assert.equal(deserializePluginState('filter', json).mode, 'highpass')
    assert.throws(() => serializePluginState('filter', { mode: 'bogus' }), /必须是/)
  })

  it('serializePluginState：未知插件/未知参数/越界/非数字中文错误', () => {
    assert.throws(() => serializePluginState('nope', {}), /未知插件/)
    assert.throws(() => serializePluginState('grand_piano', { bogus: 1 }), /不支持参数/)
    assert.throws(() => serializePluginState('grand_piano', { attack: 99 }), /不能大于/)
    assert.throws(() => serializePluginState('grand_piano', { attack: 'x' }), /必须是数字/)
    assert.throws(() => serializePluginState('grand_piano', null), /必须是对象/)
  })

  it('deserializePluginState：非法 JSON/版本/插件/状态版本错误', () => {
    assert.throws(() => deserializePluginState('grand_piano', '{bad'), /合法 JSON/)
    assert.throws(() => deserializePluginState('grand_piano', ''), /不能为空/)
    const good = JSON.parse(serializePluginState('grand_piano', { attack: 0.2 }))
    assert.throws(() => deserializePluginState('grand_piano', JSON.stringify({ ...good, sdkVersion: '2.0' })), /SDK 版本/)
    assert.throws(() => deserializePluginState('grand_piano', JSON.stringify({ ...good, pluginId: 'filter' })), /插件 ID 不匹配/)
    assert.throws(() => deserializePluginState('grand_piano', JSON.stringify({ ...good, stateVersion: 9 })), /状态版本/)
    assert.throws(() => deserializePluginState('nope', JSON.stringify(good)), /未知插件/)
  })

  it('deserializePluginState：roundtrip 多个插件/空状态', () => {
    const cases = [
      ['vibraphone', { release: 1.5 }],
      ['filter', { mode: 'lowpass', cutoff: 5000 }],
      ['compressor', { threshold: -12, ratio: 4 }],
      ['grand_piano', {}],
    ]
    for (const [id, state] of cases) {
      const json = serializePluginState(id, state)
      assert.deepEqual(deserializePluginState(id, json), state, id)
    }
  })

  it('插件清单是冻结的（防止运行时被改）', () => {
    assert.ok(Object.isFrozen(INSTRUMENT_PLUGINS))
    assert.ok(Object.isFrozen(EFFECT_PLUGINS))
    assert.ok(Object.isFrozen(ALL_PLUGINS))
  })
})

/* ------------------------------------------------------------------------- */
/* R5d：subtractive 合成器 catalog / 模型                                     */
/* ------------------------------------------------------------------------- */

describe('catalog R5d — 内置合成器', () => {
  it('SYNTH_INSTRUMENTS：8 个、顺序固定', () => {
    assert.equal(SYNTH_INSTRUMENTS.length, 8)
    assert.deepEqual(SYNTH_INSTRUMENTS.map((item) => item.id), [
      'sub_bass', 'saw_lead', 'square_lead', 'supersaw', 'warm_pad', 'pluck', 'acid_bass', 'sine_keys',
    ])
  })

  it('每个合成器元数据完整：name/label/中文 category/color/desc', () => {
    for (const instrument of SYNTH_INSTRUMENTS) {
      assert.ok(typeof instrument.name === 'string' && instrument.name.length > 0)
      assert.ok(/[\u4e00-\u9fa5]/.test(instrument.label), instrument.id)
      assert.equal(instrument.category, '合成器 Synth')
      assert.match(instrument.color, /^#[0-9A-Fa-f]{6}$/)
      assert.ok(/[\u4e00-\u9fa5]/.test(instrument.desc), instrument.id)
    }
  })

  it('synthPreset 字段完整且都在 spec 范围内', () => {
    for (const instrument of SYNTH_INSTRUMENTS) {
      const preset = instrument.synthPreset
      assert.deepEqual(Object.keys(preset).sort(), Object.keys(SYNTH_INSTRUMENT_PARAM_SPECS).sort())
      for (const [key, spec] of Object.entries(SYNTH_INSTRUMENT_PARAM_SPECS)) {
        const value = preset[key]
        if (spec.type === 'enum') {
          assert.ok(spec.options.includes(value), `${instrument.id}.${key}`)
        } else {
          assert.ok(Number.isFinite(value), `${instrument.id}.${key}`)
          assert.ok(value >= spec.min && value <= spec.max, `${instrument.id}.${key}`)
        }
      }
    }
  })

  it('合成器参数 spec：13 个键、范围正确', () => {
    assert.deepEqual(Object.keys(SYNTH_INSTRUMENT_PARAM_SPECS), [
      'wave', 'unison', 'detuneCents', 'subLevel', 'filterCutoff', 'filterQ',
      'attack', 'decay', 'sustain', 'release', 'lfoRate', 'lfoDepth', 'level',
    ])
    assert.deepEqual([...SYNTH_INSTRUMENT_PARAM_SPECS.wave.options], ['saw', 'square', 'sine', 'triangle'])
    assert.deepEqual(
      Object.fromEntries(Object.entries(SYNTH_INSTRUMENT_PARAM_SPECS).filter(([, spec]) => spec.type !== 'enum').map(([key, spec]) => [key, [spec.min, spec.max]])),
      {
        unison: [1, 2],
        detuneCents: [0, 30],
        subLevel: [0, 1],
        filterCutoff: [100, 18000],
        filterQ: [0.1, 20],
        attack: [0.001, 2],
        decay: [0.005, 2],
        sustain: [0, 1],
        release: [0.01, 4],
        lfoRate: [0.1, 12],
        lfoDepth: [0, 100],
        level: [0, 1],
      },
    )
  })

  it('音色特征：saw/square/sine 波形覆盖；supersaw 双 saw 失谐；sub_bass 有 sub', () => {
    assert.equal(SYNTH_INSTRUMENTS.find((item) => item.id === 'saw_lead').synthPreset.wave, 'saw')
    assert.equal(SYNTH_INSTRUMENTS.find((item) => item.id === 'square_lead').synthPreset.wave, 'square')
    assert.equal(SYNTH_INSTRUMENTS.find((item) => item.id === 'sine_keys').synthPreset.wave, 'sine')
    const supersaw = SYNTH_INSTRUMENTS.find((item) => item.id === 'supersaw').synthPreset
    assert.equal(supersaw.wave, 'saw')
    assert.equal(supersaw.unison, 2)
    assert.ok(supersaw.detuneCents > 0)
    const subBass = SYNTH_INSTRUMENTS.find((item) => item.id === 'sub_bass').synthPreset
    assert.ok(subBass.subLevel > 0)
    assert.ok(subBass.filterCutoff <= 800)
  })

  it('findSynthInstrument：已知命中、未知 undefined', () => {
    assert.equal(findSynthInstrument('saw_lead').label, '锯齿主音')
    assert.equal(findSynthInstrument('nope'), undefined)
    assert.equal(findSynthInstrument('grand_piano'), undefined)
  })

  it('SYNTH_INSTRUMENTS/spec 冻结（防运行时改）', () => {
    assert.ok(Object.isFrozen(SYNTH_INSTRUMENTS))
    assert.ok(Object.isFrozen(SYNTH_INSTRUMENT_PARAM_SPECS))
    assert.ok(Object.isFrozen(SYNTH_INSTRUMENTS[0].synthPreset))
  })

  it('8 个音色的 filterCutoff/ADSR 有区分度', () => {
    const cutoffs = SYNTH_INSTRUMENTS.map((item) => item.synthPreset.filterCutoff)
    assert.ok(new Set(cutoffs).size >= 5)
    const acids = SYNTH_INSTRUMENTS.find((item) => item.id === 'acid_bass').synthPreset
    assert.ok(acids.filterQ >= 8)
    const pads = SYNTH_INSTRUMENTS.find((item) => item.id === 'warm_pad').synthPreset
    assert.ok(pads.attack >= 0.3)
    const pluck = SYNTH_INSTRUMENTS.find((item) => item.id === 'pluck').synthPreset
    assert.equal(pluck.sustain, 0)
  })
})

describe('model R5d — engine/synthPreset/synthParams', () => {
  function synthProject() {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'Synth' })]
    return project
  }

  it('TRACK_ENGINES：sampler/subtractive', () => {
    assert.deepEqual([...TRACK_ENGINES], ['sampler', 'subtractive', 'vst3'])
  })

  it('默认 sampler：省略 engine/synthPreset/synthParams', () => {
    const project = synthProject()
    normalizeProject(project)
    for (const key of ['engine', 'synthPreset', 'synthParams']) assert.equal(Object.hasOwn(project.tracks[0], key), false, key)
  })

  it('subtractive：保留 engine + synthPreset；缺失 preset 回退第一个', () => {
    const project = synthProject()
    project.tracks[0].engine = 'subtractive'
    normalizeProject(project)
    assert.equal(project.tracks[0].engine, 'subtractive')
    assert.equal(project.tracks[0].synthPreset, 'sub_bass')
  })

  it('非法 engine 回 sampler（删除字段）', () => {
    const project = synthProject()
    for (const value of ['bogus', 'subtract', 1, true]) {
      project.tracks[0].engine = value
      normalizeProject(project)
      assert.equal(Object.hasOwn(project.tracks[0], 'engine'), false, String(value))
    }
  })

  it('非法 synthPreset 删除；sampler 轨保留合法 synthPreset（切换保留）', () => {
    const project = synthProject()
    project.tracks[0].synthPreset = 'nope'
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'synthPreset'), false)
    project.tracks[0].engine = 'subtractive'
    project.tracks[0].synthPreset = 'saw_lead'
    normalizeProject(project)
    assert.equal(project.tracks[0].synthPreset, 'saw_lead')
    project.tracks[0].engine = 'sampler'
    normalizeProject(project)
    assert.equal(project.tracks[0].synthPreset, 'saw_lead', '切换回 sampler 保留 synthPreset')
  })

  it('synthParams：与 preset 默认相等时省略、非默认保留', () => {
    const project = synthProject()
    project.tracks[0].engine = 'subtractive'
    project.tracks[0].synthPreset = 'saw_lead'
    const defaults = findSynthInstrument('saw_lead').synthPreset
    project.tracks[0].synthParams = { ...defaults }
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'synthParams'), false)
    project.tracks[0].synthParams = { wave: 'square', attack: 0.5 }
    normalizeProject(project)
    assert.deepEqual(project.tracks[0].synthParams, { wave: 'square', attack: 0.5 })
  })

  it('synthParams：数值夹紧/取整；未知键忽略；非法 wave 忽略', () => {
    const project = synthProject()
    Object.assign(project.tracks[0], {
      engine: 'subtractive',
      synthPreset: 'sub_bass',
      synthParams: { wave: 'bogus', unison: 9, detuneCents: 8.44, attack: 0.0001, filterCutoff: 99999, bogus: 1 },
    })
    normalizeProject(project)
    assert.deepEqual(project.tracks[0].synthParams, { unison: 2, detuneCents: 8.4, attack: 0.001, filterCutoff: 18000 })
  })

  it('normalizeSynthParams：默认参数等价 {}；preset 对象也可作基准', () => {
    assert.deepEqual(normalizeSynthParams({ ...findSynthInstrument('warm_pad').synthPreset }, { preset: 'warm_pad' }), {})
    assert.deepEqual(normalizeSynthParams({ filterCutoff: 500 }, { preset: { filterCutoff: 500 } }), {})
    assert.deepEqual(normalizeSynthParams({ filterCutoff: 600 }, { preset: { filterCutoff: 500 } }), { filterCutoff: 600 })
  })

  it('synthPresetDefaults：返回副本（修改不影响 catalog）', () => {
    const defaults = synthPresetDefaults('saw_lead')
    defaults.wave = 'square'
    assert.equal(findSynthInstrument('saw_lead').synthPreset.wave, 'saw')
    assert.equal(synthPresetDefaults('nope').wave, 'sine')
  })

  it('非 synth（drum/audio）删除 engine/synthPreset/synthParams', () => {
    const project = createEmptyProject()
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'drum', name: 'D' }),
      makeTrack({ id: 'trk_2', kind: 'audio', name: 'A' }),
    ]
    for (const track of project.tracks) Object.assign(track, { engine: 'subtractive', synthPreset: 'saw_lead', synthParams: { wave: 'sine' } })
    normalizeProject(project)
    for (const track of project.tracks) {
      for (const key of ['engine', 'synthPreset', 'synthParams']) assert.equal(Object.hasOwn(track, key), false, key)
    }
  })

  it('旧工程无字段默认；normalize 幂等', () => {
    const project = synthProject()
    project.tracks[0].engine = 'subtractive'
    project.tracks[0].synthPreset = 'pluck'
    project.tracks[0].synthParams = { filterQ: 8 }
    normalizeProject(project)
    const snapshot = JSON.stringify(project.tracks[0])
    normalizeProject(project)
    assert.equal(JSON.stringify(project.tracks[0]), snapshot)
  })

  it('subtractive 与 instrumentParams 共存', () => {
    const project = synthProject()
    Object.assign(project.tracks[0], {
      engine: 'subtractive',
      synthPreset: 'saw_lead',
      synthParams: { wave: 'square' },
      instrumentParams: { attack: 0.2 },
    })
    normalizeProject(project)
    assert.equal(project.tracks[0].engine, 'subtractive')
    assert.deepEqual(project.tracks[0].instrumentParams, { attack: 0.2 })
    assert.deepEqual(project.tracks[0].synthParams, { wave: 'square' })
  })

  it('subtractive：instrument.preset 规范化为 null（v2.1）', () => {
    const project = synthProject()
    project.tracks[0].instrument.preset = 'grand_piano'
    project.tracks[0].engine = 'subtractive'
    project.tracks[0].synthPreset = 'acid_bass'
    normalizeProject(project)
    assert.equal(project.tracks[0].instrument.preset, null)
    assert.equal(project.tracks[0].synthPreset, 'acid_bass')
  })

  it('makeTrack 新建默认无 engine 字段', () => {
    assert.equal(Object.hasOwn(makeTrack({ id: 'trk_1', kind: 'synth', name: 'S' }), 'engine'), false)
  })
})

/* R5d 补充：边界 */
describe('model R5d — 补充边界', () => {
  function synthProject() {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'S', preset: 'grand_piano' })]
    return project
  }

  it('normalizeSynthParams：preset 对象基准下 enum 等于默认省略', () => {
    assert.deepEqual(normalizeSynthParams({ wave: 'saw' }, { preset: { wave: 'saw' } }), {})
    assert.deepEqual(normalizeSynthParams({ wave: 'square' }, { preset: { wave: 'saw' } }), { wave: 'square' })
  })

  it('normalizeProject：subtractive + synthParams 子集保留', () => {
    const project = synthProject()
    Object.assign(project.tracks[0], { engine: 'subtractive', synthPreset: 'warm_pad', synthParams: { wave: 'sine', level: 0.5 } })
    normalizeProject(project)
    assert.deepEqual(project.tracks[0].synthParams, { wave: 'sine', level: 0.5 })
  })

  it('normalizeProject：非对象 synthParams 删除', () => {
    const project = synthProject()
    Object.assign(project.tracks[0], { engine: 'subtractive', synthPreset: 'saw_lead', synthParams: [1, 2] })
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'synthParams'), false)
  })

  it('normalizeProject：sampler 引擎仍保留 synthParams/synthPreset（切换 retention）', () => {
    const project = synthProject()
    Object.assign(project.tracks[0], { engine: 'sampler', synthPreset: 'pluck', synthParams: { filterCutoff: 500 } })
    normalizeProject(project)
    assert.equal(project.tracks[0].synthPreset, 'pluck')
    assert.deepEqual(project.tracks[0].synthParams, { filterCutoff: 500 })
  })

  it('normalizeProject：subtractive 非法数值全部省略后字段删除', () => {
    const project = synthProject()
    Object.assign(project.tracks[0], {
      engine: 'subtractive',
      synthPreset: 'acid_bass',
      synthParams: { wave: 'bogus', unison: 'x', filterQ: NaN },
    })
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'synthParams'), false)
  })

  it('synthPresetDefaults：多次调用互不影响', () => {
    const a = synthPresetDefaults('supersaw')
    a.detuneCents = 1
    assert.equal(synthPresetDefaults('supersaw').detuneCents, 20)
  })

  it('normalizeSynthParams：未知 preset 用第一个默认（不崩）', () => {
    assert.deepEqual(normalizeSynthParams({ wave: 'sine' }, { preset: 'nope' }), { wave: 'sine' })
  })

  it('normalizeProject：subtractive 时 instrument.preset=null（v2.1）', () => {
    const project = synthProject()
    project.tracks[0].engine = 'subtractive'
    project.tracks[0].synthPreset = 'square_lead'
    normalizeProject(project)
    assert.equal(project.tracks[0].instrument.preset, null)
    assert.equal(project.tracks[0].engine, 'subtractive')
    assert.equal(project.tracks[0].synthPreset, 'square_lead')
  })
})

/* ------------------------------------------------------------------------- */
/* R6a：混音 assistant                                                        */
/* ------------------------------------------------------------------------- */

describe('ai-mix R6a — 混音建议', () => {
  function mixProject() {
    const project = createDemoProject()
    project.master.volume = 0.8
    project.tracks[0].volume = 0.78
    project.tracks[0].kind = 'drum'
    project.tracks[1].volume = 0.78
    return project
  }

  const loudAnalysis = {
    lufs: -8,
    peak: 1.02,
    clipping: true,
    stereoBalanceDb: 5,
    bandEnergyPct: { low: 70, high: 20 },
    stems: [],
  }

  it('默认 targetLufs=-14，返回 score/summary/recommendations', () => {
    assert.equal(DEFAULT_MIX_TARGET_LUFS, -14)
    const result = buildMixSuggestions({ project: mixProject() })
    assert.equal(result.targetLufs, -14)
    assert.ok(Number.isFinite(result.score) && result.score >= 0 && result.score <= 100)
    assert.ok(typeof result.summary === 'string' && result.summary.length > 0)
    assert.ok(Array.isArray(result.recommendations))
  })

  it('只读：不修改工程', () => {
    const project = mixProject()
    const before = JSON.stringify(project)
    buildMixSuggestions({ project, analysis: loudAnalysis })
    assert.equal(JSON.stringify(project), before)
  })

  it('响度偏高 → mix.loudness.high（warn, master volume 下调）', () => {
    const result = buildMixSuggestions({ project: mixProject(), analysis: { lufs: -6 } })
    const rec = result.recommendations.find((item) => item.code === 'mix.loudness.high')
    assert.ok(rec)
    assert.equal(rec.severity, 'warn')
    assert.equal(rec.target, 'master')
    assert.equal(rec.param, 'volume')
    assert.ok(rec.suggested < rec.current)
  })

  it('响度偏低 → mix.loudness.low', () => {
    const result = buildMixSuggestions({ project: mixProject(), analysis: { lufs: -22 } })
    const rec = result.recommendations.find((item) => item.code === 'mix.loudness.low')
    assert.ok(rec)
    assert.equal(rec.severity, 'info')
    assert.ok(rec.suggested > rec.current)
  })

  it('clipping → mix.clipping；peak 接近 1 也触发', () => {
    const a = buildMixSuggestions({ project: mixProject(), analysis: { clipping: true } })
    assert.ok(a.recommendations.some((item) => item.code === 'mix.clipping'))
    const b = buildMixSuggestions({ project: mixProject(), analysis: { peak: 0.99 } })
    assert.ok(b.recommendations.some((item) => item.code === 'mix.clipping'))
  })

  it('立体声平衡偏 → pan 建议', () => {
    const result = buildMixSuggestions({ project: mixProject(), analysis: { stereoBalanceDb: -4 } })
    const rec = result.recommendations.find((item) => item.code === 'mix.stereo.balance')
    assert.ok(rec)
    assert.equal(rec.param, 'pan')
    assert.equal(rec.target, 'track')
    assert.ok(rec.suggested >= -1 && rec.suggested <= 1)
  })

  it('低频过量 + 轨有 filter → filter.cutoff 建议', () => {
    const project = mixProject()
    project.tracks[0].effects = [{ id: 'fx_1', type: 'filter', enabled: true, params: { cutoff: 800 } }]
    const result = buildMixSuggestions({ project, analysis: { bandEnergyPct: { low: 75, high: 10 } } })
    const rec = result.recommendations.find((item) => item.code === 'mix.band.low')
    assert.ok(rec)
    assert.equal(rec.param, 'filter.cutoff')
    assert.equal(rec.effectId, 'fx_1')
    assert.ok(rec.suggested > rec.current)
  })

  it('低频过量但无 filter：不产生 filter 建议', () => {
    const project = mixProject()
    for (const track of project.tracks) track.effects = []
    const result = buildMixSuggestions({ project, analysis: { bandEnergyPct: { low: 75 } } })
    assert.equal(result.recommendations.some((item) => item.code === 'mix.band.low'), false)
  })

  it('高频过量 + filter → filter.cutoff 下调建议', () => {
    const project = mixProject()
    project.tracks[0].effects = [{ id: 'fx_1', type: 'filter', enabled: true, params: { cutoff: 4000 } }]
    const result = buildMixSuggestions({ project, analysis: { bandEnergyPct: { high: 45 } } })
    const rec = result.recommendations.find((item) => item.code === 'mix.band.high')
    assert.ok(rec)
    assert.ok(rec.suggested < rec.current)
  })

  it('stems 显著超出中位数 → track volume 下调', () => {
    const project = mixProject()
    const stems = project.tracks.map((track, index) => ({ trackId: track.id, rmsDb: index === 0 ? -6 : -28 }))
    const result = buildMixSuggestions({ project, analysis: { stems } })
    const rec = result.recommendations.find((item) => item.code === 'mix.stem.loud')
    assert.ok(rec)
    assert.equal(rec.trackId, project.tracks[0].id)
    assert.equal(rec.param, 'volume')
    assert.ok(rec.suggested < rec.current)
  })

  it('发送量 >0.5 → sends.reverb/sends.delay 建议', () => {
    const project = mixProject()
    project.tracks[1].sends = { reverb: 0.8, delay: 0.7 }
    const result = buildMixSuggestions({ project })
    assert.ok(result.recommendations.some((item) => item.code === 'mix.send.reverb'))
    assert.ok(result.recommendations.some((item) => item.code === 'mix.send.delay'))
  })

  it('score 随警告数下降；warn 排在 info 前', () => {
    const clean = buildMixSuggestions({ project: mixProject() })
    const dirty = buildMixSuggestions({ project: mixProject(), analysis: loudAnalysis })
    assert.ok(dirty.score <= clean.score)
    const severities = dirty.recommendations.map((item) => item.severity)
    const firstInfo = severities.indexOf('info')
    if (firstInfo >= 0) assert.ok(severities.slice(firstInfo).every((item) => item === 'info'))
  })

  it('非法参数错误：project/targetLufs', () => {
    assert.throws(() => buildMixSuggestions({ project: null }), /工程对象/)
    assert.throws(() => buildMixSuggestions({ project: mixProject(), targetLufs: -30 }), /targetLufs/)
    assert.throws(() => buildMixSuggestions({ project: mixProject(), targetLufs: -4 }), /targetLufs/)
  })

  it('applyMixSuggestions：应用 master volume 并返回 changes', () => {
    const project = mixProject()
    const result = applyMixSuggestions(project, { analysis: { lufs: -6 }, codes: ['mix.loudness.high'] })
    assert.equal(result.applied, 1)
    assert.equal(result.changes[0].target, 'master')
    assert.equal(result.changes[0].param, 'volume')
    assert.ok(project.master.volume < 0.8)
  })

  it('applyMixSuggestions：codes 过滤只应用指定项', () => {
    const project = mixProject()
    const result = applyMixSuggestions(project, { analysis: loudAnalysis, codes: ['mix.clipping'] })
    assert.equal(result.applied, 1)
    assert.equal(result.changes[0].code, 'mix.clipping')
    assert.equal(result.changes.some((item) => item.code === 'mix.loudness.high'), false)
  })

  it('applyMixSuggestions：stems 建议降低对应轨音量、undo 可回滚', () => {
    const project = mixProject()
    project.tracks[0].volume = 0.8
    const stems = project.tracks.map((track, index) => ({ trackId: track.id, rmsDb: index === 0 ? 0 : -30 }))
    const result = applyMixSuggestions(project, { analysis: { stems }, codes: ['mix.stem.loud'] })
    assert.ok(result.applied >= 1)
    assert.ok(project.tracks[0].volume < 0.8)
  })

  it('applyMixSuggestions：pan/sends 安全应用', () => {
    const project = mixProject()
    project.tracks[1].sends = { reverb: 0.9, delay: 0.2 }
    const result = applyMixSuggestions(project, { codes: ['mix.send.reverb'] })
    assert.equal(result.applied, 1)
    assert.equal(project.tracks[1].sends.reverb, 0.35)
  })

  it('applyMixSuggestions：filter.cutoff 只改已存在的 filter', () => {
    const project = mixProject()
    project.tracks[0].effects = [{ id: 'fx_1', type: 'filter', enabled: true, params: { cutoff: 800 } }]
    const result = applyMixSuggestions(project, { analysis: { bandEnergyPct: { low: 75 } }, codes: ['mix.band.low'] })
    assert.equal(result.applied, 1)
    assert.ok(project.tracks[0].effects[0].params.cutoff > 800)
  })

  it('applyMixSuggestions：无建议/未知 codes → applied=0 不破坏字段', () => {
    const project = mixProject()
    const before = JSON.stringify(project)
    const result = applyMixSuggestions(project, { codes: ['mix.nope'] })
    assert.equal(result.applied, 0)
    assert.equal(JSON.stringify(project), before)
  })

  it('静态（无 analysis）：低风险工程建议很少', () => {
    const project = mixProject()
    const result = buildMixSuggestions({ project })
    assert.ok(result.recommendations.every((item) => ['info', 'warn'].includes(item.severity)))
    assert.ok(result.score > 50)
  })
})

/* R6a 补充：混音建议边界 */
describe('ai-mix R6a — 补充边界', () => {
  function project() {
    return createDemoProject()
  }

  it('score 与 warn 数量关系（每条 warn -8）', () => {
    const result = buildMixSuggestions({ project: project(), analysis: { clipping: true, lufs: -5 } })
    const warnings = result.recommendations.filter((item) => item.severity === 'warn').length
    assert.equal(result.score, Math.max(0, 100 - result.recommendations.reduce((sum, item) => sum + (item.severity === 'warn' ? 8 : 3), 0)))
    assert.ok(warnings >= 1)
  })

  it('自定义 targetLufs 生效', () => {
    const lowTarget = buildMixSuggestions({ project: project(), analysis: { lufs: -10 }, targetLufs: -20 })
    assert.equal(lowTarget.targetLufs, -20)
    assert.ok(lowTarget.recommendations.some((item) => item.code === 'mix.loudness.high'))
  })

  it('静态 master 音量 >0.95 触发建议', () => {
    const demo = project()
    demo.master.volume = 0.99
    const result = buildMixSuggestions({ project: demo })
    assert.ok(result.recommendations.some((item) => item.code === 'mix.static.master'))
  })

  it('静态 track 音量 >0.98 触发建议', () => {
    const demo = project()
    demo.tracks[0].volume = 1
    const result = buildMixSuggestions({ project: demo })
    assert.ok(result.recommendations.some((item) => item.code === 'mix.static.track'))
  })

  it('applyMixSuggestions：sends.delay 建议应用', () => {
    const demo = project()
    demo.tracks[1].sends = { reverb: 0.1, delay: 0.9 }
    const result = applyMixSuggestions(demo, { codes: ['mix.send.delay'] })
    assert.equal(result.applied, 1)
    assert.equal(demo.tracks[1].sends.delay, 0.3)
  })

  it('applyMixSuggestions：filter 建议在无 filter 时不改工程', () => {
    const demo = project()
    for (const track of demo.tracks) track.effects = []
    const before = JSON.stringify(demo)
    const result = applyMixSuggestions(demo, { analysis: { bandEnergyPct: { low: 80 } }, codes: ['mix.band.low'] })
    assert.equal(result.applied, 0)
    assert.equal(JSON.stringify(demo), before)
  })

  it('recommendations 排序：warn 在前', () => {
    const result = buildMixSuggestions({ project: project(), analysis: { lufs: -5, bandEnergyPct: { low: 80 } } })
    const severities = result.recommendations.map((item) => item.severity)
    const firstInfo = severities.indexOf('info')
    if (firstInfo >= 0) assert.ok(severities.slice(firstInfo).every((item) => item === 'info'))
  })

  it('applyMixSuggestions：changes 仅含白名单 param', () => {
    const demo = project()
    const result = applyMixSuggestions(demo, { analysis: { lufs: -5, clipping: true, stereoBalanceDb: 5 } })
    const allowed = new Set(['volume', 'pan', 'sends.reverb', 'sends.delay', 'filter.cutoff'])
    for (const change of result.changes) assert.ok(allowed.has(change.param), change.param)
  })
})

/* ------------------------------------------------------------------------- */
/* R6c：AI 变更日志（纯 diff + 有界日志）                                      */
/* ------------------------------------------------------------------------- */

describe('ai-journal R6c — diff 与日志', () => {
  function demo() {
    return createDemoProject()
  }

  it('AI_JOURNAL_LIMIT=30', () => {
    assert.equal(AI_JOURNAL_LIMIT, 30)
  })

  it('diffProjectSummary：null/缺失 → 全 0 且字段完整', () => {
    const diff = diffProjectSummary(null, null)
    assert.deepEqual(diff, {
      tracksAdded: 0,
      tracksRemoved: 0,
      tracksChanged: 0,
      patternsAdded: 0,
      patternsRemoved: 0,
      patternsChanged: 0,
      clipsDelta: 0,
      sectionsDelta: 0,
      bpm: { before: 0, after: 0 },
      lengthBars: { before: 0, after: 0 },
      notesDelta: 0,
      trackNames: [],
      patternDeltas: [],
    })
  })

  it('diffProjectSummary：轨道增/删/改与 trackNames', () => {
    const before = demo()
    const after = JSON.parse(JSON.stringify(before))
    const removed = after.tracks.pop()
    after.tracks.push(makeTrack({ id: 'trk_99', kind: 'synth', name: '新增轨', preset: 'grand_piano' }))
    after.tracks[0].volume = 0.12
    const diff = diffProjectSummary(before, after)
    assert.equal(diff.tracksAdded, 1)
    assert.equal(diff.tracksRemoved, 1)
    assert.equal(diff.tracksChanged, 1)
    assert.ok(diff.trackNames.includes('新增轨'))
    assert.ok(diff.trackNames.includes(removed.name))
    assert.ok(diff.trackNames.includes(after.tracks[0].name))
  })

  it('diffProjectSummary：pattern 增/改/删、notesDelta、patternDeltas', () => {
    const before = demo()
    const after = JSON.parse(JSON.stringify(before))
    after.patterns[0].notes.push({ pitch: 64, start: 0, dur: 1, vel: 0.8 })
    const removed = after.patterns.pop()
    after.patterns.push(makePattern({ id: 'pat_99', name: '新 pattern', lengthBars: 2, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }, { pitch: 62, start: 1, dur: 1, vel: 0.8 }] }))
    const beforeNotes = before.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0)
    const afterNotes = after.patterns.reduce((sum, pattern) => sum + pattern.notes.length, 0)
    const diff = diffProjectSummary(before, after)
    assert.equal(diff.patternsAdded, 1)
    assert.equal(diff.patternsRemoved, 1)
    assert.equal(diff.patternsChanged, 1)
    assert.equal(diff.notesDelta, afterNotes - beforeNotes)
    const byId = new Map(diff.patternDeltas.map((item) => [item.patternId, item]))
    assert.ok(byId.has('pat_99'))
    assert.equal(byId.get('pat_99').beforeNotes, 0)
    assert.equal(byId.get('pat_99').afterNotes, 2)
    assert.ok(byId.has(removed.id))
    assert.equal(byId.get(removed.id).afterNotes, 0)
    assert.ok(byId.has(before.patterns[0].id))
  })

  it('diffProjectSummary：clipsDelta/sectionsDelta/bpm/lengthBars', () => {
    const before = demo()
    const after = JSON.parse(JSON.stringify(before))
    after.clips.pop()
    after.sections.push({ id: 'sec_99', name: '新段', startBar: 0, lengthBars: 4, color: '#F26B3A' })
    after.bpm = 100
    after.lengthBars += 8
    const diff = diffProjectSummary(before, after)
    assert.equal(diff.clipsDelta, -1)
    assert.equal(diff.sectionsDelta, 1)
    assert.deepEqual(diff.bpm, { before: 128, after: 100 })
    assert.deepEqual(diff.lengthBars, { before: before.lengthBars, after: after.lengthBars })
  })

  it('diffProjectSummary：不修改输入对象', () => {
    const before = demo()
    const after = demo()
    after.tracks[0].volume = 0.1
    const snapshotBefore = JSON.stringify(before)
    const snapshotAfter = JSON.stringify(after)
    diffProjectSummary(before, after)
    assert.equal(JSON.stringify(before), snapshotBefore)
    assert.equal(JSON.stringify(after), snapshotAfter)
  })

  it('diffProjectSummary：patternDeltas 最多 20 条', () => {
    const before = demo()
    const after = JSON.parse(JSON.stringify(before))
    for (let index = 0; index < 30; index += 1) {
      after.patterns.push(makePattern({ id: `pat_x${index}`, name: `P${index}`, lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] }))
    }
    assert.equal(diffProjectSummary(before, after).patternDeltas.length, 20)
  })

  it('createAiJournal：record 返回 id/at/title/diff；新在前', () => {
    const journal = createAiJournal()
    const first = journal.record({ tool: 'a', title: '一', beforeRev: 1, afterRev: 2, diff: { tracksAdded: 1 } })
    const second = journal.record({ tool: 'b', title: '二', beforeRev: 2, afterRev: 3, diff: { tracksAdded: 2 } })
    assert.equal(first.id, 'chg_1')
    assert.equal(second.id, 'chg_2')
    assert.ok(!Number.isNaN(Date.parse(first.at)))
    assert.equal(journal.list()[0].title, '二')
    assert.equal(journal.list()[1].title, '一')
  })

  it('createAiJournal：默认上限 30', () => {
    const journal = createAiJournal()
    for (let index = 0; index < 35; index += 1) journal.record({ tool: 't', title: String(index), beforeRev: index, afterRev: index + 1 })
    const entries = journal.list()
    assert.equal(entries.length, 30)
    assert.equal(entries[0].title, '34')
    assert.equal(entries[29].title, '5')
  })

  it('createAiJournal：自定义 limit（3）', () => {
    const journal = createAiJournal({ limit: 3 })
    for (let index = 0; index < 6; index += 1) journal.record({ tool: 't', title: String(index), beforeRev: index, afterRev: index + 1 })
    assert.equal(journal.list().length, 3)
    assert.equal(journal.limit, 3)
  })

  it('createAiJournal：list limit 与 currentRevision 过滤', () => {
    const journal = createAiJournal()
    journal.record({ tool: 'a', title: 'a', beforeRev: 1, afterRev: 2 })
    journal.record({ tool: 'b', title: 'b', beforeRev: 2, afterRev: 9 })
    assert.equal(journal.list({ limit: 1 }).length, 1)
    assert.equal(journal.list({ limit: 1 })[0].title, 'b')
    const filtered = journal.list({ currentRevision: 5 })
    assert.deepEqual(filtered.map((entry) => entry.title), ['a'])
  })

  it('createAiJournal：clear 清空、size 反映条数', () => {
    const journal = createAiJournal()
    assert.equal(journal.size, 0)
    journal.record({ tool: 'a', title: 'a', beforeRev: 1, afterRev: 2 })
    assert.equal(journal.size, 1)
    journal.clear()
    assert.equal(journal.size, 0)
    assert.deepEqual(journal.list(), [])
  })

  it('createAiJournal：返回/读取均为副本（外部修改不影响内部）', () => {
    const journal = createAiJournal()
    const entry = journal.record({ tool: 'a', title: 'a', beforeRev: 1, afterRev: 2, diff: { tracksAdded: 1 } })
    entry.diff.tracksAdded = 99
    entry.title = '改坏'
    const listed = journal.list()
    listed[0].title = '改坏2'
    assert.equal(journal.list()[0].title, 'a')
    assert.equal(journal.list()[0].diff.tracksAdded, 1)
  })

  it('createAiJournal：canUndo/canRedo 记录', () => {
    const journal = createAiJournal()
    const entry = journal.record({ tool: 'a', title: 'a', beforeRev: 1, afterRev: 2, canUndo: true, canRedo: false })
    assert.equal(entry.canUndo, true)
    assert.equal(entry.canRedo, false)
  })

  it('diffProjectSummary：bpm/lengthBars 缺失回退 0', () => {
    const before = { tracks: [], patterns: [], clips: [], sections: [] }
    const after = { tracks: [], patterns: [], clips: [], sections: [] }
    const diff = diffProjectSummary(before, after)
    assert.deepEqual(diff.bpm, { before: 0, after: 0 })
    assert.deepEqual(diff.lengthBars, { before: 0, after: 0 })
  })

  it('diffProjectSummary：只改 notes 时 patternsChanged=1、谱面差分记录', () => {
    const before = demo()
    const after = JSON.parse(JSON.stringify(before))
    after.patterns[0].notes[0].pitch += 1
    const diff = diffProjectSummary(before, after)
    assert.equal(diff.patternsChanged, 1)
    assert.equal(diff.patternDeltas.length, 1)
    assert.equal(diff.patternDeltas[0].patternId, before.patterns[0].id)
  })

  it('diffProjectSummary：clips/sections 增量为前后长度差', () => {
    const before = demo()
    const after = JSON.parse(JSON.stringify(before))
    after.clips.push({ ...before.clips[0], id: 'clip_x' })
    after.sections = (after.sections ?? []).slice(0, 1)
    const diff = diffProjectSummary(before, after)
    assert.equal(diff.clipsDelta, 1)
    assert.equal(diff.sectionsDelta, (after.sections?.length ?? 0) - (before.sections?.length ?? 0))
  })
})

/* R6c 补充：日志边界 */
describe('ai-journal R6c — 补充边界', () => {
  it('patternDeltas 保留 name 字段', () => {
    const before = createDemoProject()
    const after = JSON.parse(JSON.stringify(before))
    after.patterns[0].notes.push({ pitch: 60, start: 0, dur: 1, vel: 0.8 })
    const diff = diffProjectSummary(before, after)
    assert.equal(diff.patternDeltas[0].name, before.patterns[0].name)
  })

  it('record：title 缺省回退 tool 名；diff 缺省为空摘要', () => {
    const journal = createAiJournal()
    const entry = journal.record({ tool: 'studio_x', beforeRev: 1, afterRev: 2 })
    assert.equal(entry.title, 'studio_x')
    assert.deepEqual(entry.diff.tracksAdded, 0)
    assert.deepEqual(entry.diff.trackNames, [])
  })

  it('list：currentRevision 边界包含等值条目', () => {
    const journal = createAiJournal()
    journal.record({ tool: 'a', title: 'a', beforeRev: 1, afterRev: 4 })
    journal.record({ tool: 'b', title: 'b', beforeRev: 4, afterRev: 5 })
    assert.deepEqual(journal.list({ currentRevision: 4 }).map((entry) => entry.title), ['a'])
  })
})

/* ------------------------------------------------------------------------- */
/* v2.1 Host P0：subtractive preset / effectId / automation / contentRevision / */
/* apply_mix 曲线 / noteIndex / 迁移 headroom 警告                             */
/* ------------------------------------------------------------------------- */

describe('v2.1 — model 数据/ID/迁移', () => {
  it('subtractive：instrument.preset 规范化为 null；sampler 缺 preset 时补默认', () => {
    const project = createEmptyProject()
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'synth', name: 'S', preset: 'grand_piano' }),
      makeTrack({ id: 'trk_2', kind: 'synth', name: 'T', preset: 'grand_piano' }),
    ]
    project.tracks[0].engine = 'subtractive'
    project.tracks[0].synthPreset = 'saw_lead'
    project.tracks[1].instrument.preset = null
    normalizeProject(project)
    assert.equal(project.tracks[0].instrument.preset, null)
    assert.equal(project.tracks[0].instrument.kit, null)
    assert.equal(project.tracks[0].synthPreset, 'saw_lead')
    assert.equal(project.tracks[1].instrument.preset, 'grand_piano')
    normalizeProject(project)
    assert.equal(project.tracks[0].instrument.preset, null, 'normalize 幂等')
  })

  it('effectId 全局唯一：master/轨道/返回总线/组链重复 id 重分配', () => {
    const project = createEmptyProject()
    project.tracks = [
      makeTrack({ id: 'trk_1', kind: 'synth', name: 'A', preset: 'grand_piano', effects: [makeEffect('fx_1', 'filter', {})] }),
      makeTrack({ id: 'trk_2', kind: 'synth', name: 'B', preset: 'grand_piano', effects: [makeEffect('fx_1', 'drive', {})] }),
    ]
    project.master.effects = [makeEffect('fx_1', 'compressor', {})]
    project.buses.reverb.effects = [makeEffect('fx_1', 'eq3', {})]
    project.groups = [normalizeProject({
      ...createEmptyProject(),
      tracks: [],
      groups: [{ id: 'grp_1', name: 'G', level: 0.8, effects: [makeEffect('fx_1', 'chorus', {})] }],
    }).groups[0]]
    normalizeProject(project)
    const all = [
      ...project.master.effects,
      ...project.tracks.flatMap((track) => track.effects),
      ...project.buses.reverb.effects,
      ...project.groups.flatMap((group) => group.effects),
    ].map((effect) => effect.id)
    assert.equal(new Set(all).size, all.length, JSON.stringify(all))
    assert.equal(project.master.effects[0].id, 'fx_1', '首个保留')
  })

  it('makeIdGen 扫描 group FX（下一个 fx 不冲突）', () => {
    const project = createEmptyProject()
    project.groups = [{ id: 'grp_1', name: 'G', effects: [makeEffect('fx_7', 'filter', {})] }]
    assert.equal(makeIdGen(project)('fx'), 'fx_8')
  })

  it('迁移 v2→v3：migrationWarnings 含响度 headroom 提示；高音量追加提示', () => {
    const low = { schemaVersion: 2, title: 'old', bpm: 120, key: 'C', scale: 'major', lengthBars: 8, tracks: [], patterns: [], clips: [], sections: [] }
    const migrated = migrateProjectV2toV3(low)
    assert.ok(Array.isArray(migrated.format.migrationWarnings))
    assert.ok(migrated.format.migrationWarnings.some((item) => item.includes('预设响度已归一化')))
    const loud = { ...low, master: { volume: 0.98, effects: [] }, tracks: [{ id: 'trk_1', volume: 0.95 }] }
    const migratedLoud = migrateProjectV2toV3(loud)
    assert.ok(migratedLoud.format.migrationWarnings.some((item) => item.includes('headroom')))
  })

  it('normalizeProjectFormat：保留 migrationWarnings；v3 迁移幂等', () => {
    const format = normalizeProjectFormat({ migrationWarnings: ['a', 'b', 3, ''], migratedFrom: 2, migratedAt: 1700000000000 })
    assert.deepEqual(format.migrationWarnings, ['a', 'b'])
    const v3 = { schemaVersion: 3, title: 'x', bpm: 120, key: 'C', scale: 'major', lengthBars: 8, tracks: [], patterns: [], clips: [], sections: [] }
    assert.equal(migrateProjectV2toV3(v3).schemaVersion, 3)
  })

  it('normalizeExportJob：保留 achievedLufs/peak/peakDb/truePeak/truePeakDb/gainDb/limited', () => {
    const job = normalizeExportJob({
      jobId: 'job_1',
      status: 'success',
      achievedLufs: -14.12,
      peak: 0.78,
      peakDb: -1.25,
      truePeak: 0.82,
      truePeakDb: -0.9,
      gainDb: 2.35,
      limited: true,
    })
    assert.equal(job.achievedLufs, -14.12)
    assert.equal(job.peak, 0.78)
    assert.equal(job.peakDb, -1.25)
    assert.equal(job.truePeak, 0.82)
    assert.equal(job.truePeakDb, -0.9)
    assert.equal(job.gainDb, 2.35)
    assert.equal(job.limited, true)
    const invalid = normalizeExportJob({ jobId: 'job_2', achievedLufs: 'bad', peak: null, limited: 'yes' })
    assert.equal(Object.hasOwn(invalid, 'achievedLufs'), false)
    assert.equal(Object.hasOwn(invalid, 'peak'), false)
    assert.equal(Object.hasOwn(invalid, 'limited'), false)
  })
})
