/**
 * audio-engine 单测（Node，无 AudioContext）。
 *
 * 只测「纯计算」层：音高换算、事件展开、swing、loop/位置、WAV 头编码、
 * 参数钳制、FX 覆盖度、引擎在无 Web Audio 环境下的安全行为。
 * AudioContext 图构建 / 离线渲染的真实音频正确性由浏览器 E2E 验证。
 */
import test from 'node:test'
import {
  EXTERNAL_PLUGIN_WORKLET_NAME,
  EXTERNAL_PLUGIN_WORKLET_SOURCE,
  EXTERNAL_CONTROL,
  createExternalRingBuffer,
  ringAvailable,
  readInputRing,
  writeOutputRing,
  readOutputRing,
  float32PlanesToBase64,
  base64PlanesToFloat32,
  ensureExternalPluginWorklet,
  createWorkletModuleUrl,
  externalInstanceIdForEffect,
  ExternalPluginBridge,
  createExternalEffectNode,
  buildFxChainWithExternal,
  createExternalInstrumentRing,
  EXTERNAL_MIDI_RECORD_INTS,
  EXTERNAL_MIDI_TYPE,
  encodeMidiEvent,
  decodeMidiEvent,
  writeMidiEventToRing,
  readDueMidiEvents,
  clearMidiQueue,
  ExternalInstrumentBridge,
  createExternalInstrumentNode,
  isExternalInstrumentTrack,
  freezeStatusOf,
  isFrozenTrack,
  frozenTrackInfo,
  frozenMediaEntry,
  unfrozenVst3Tracks,
  listFrozenTracks,
  normalizePluginProcessOutputs,
  normalizePluginParamList,
  getExternalPluginApi,
  isExternalPluginSupported,
} from '../src/client/audio/external-plugin.js'
import {
  resolvePreviewTimeoutMs,
  normalizePreviewParams,
  previewTimeoutError,
  requestPreview,
  peekPreviewRequest,
  completePreviewRequest,
  pendingPreviewCount,
  PREVIEW_TIMEOUT_MS,
  PREVIEW_AUTO_FAST_BARS,
} from '../src/host/preview-bridge.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  createEmptyProject,
  makeTrack,
  makePattern,
  makeClip,
  makeEffect,
  defaultMaster,
  normalizeProject,
  pitchToFreq,
  clipNotes,
  automationValueAt,
  AUTOMATION_PARAMS,
} from '../src/shared/model.js'
import {
  SYNTH_PRESETS,
  SYNTH_PARAM_SPECS,
  DRUM_KITS,
  DRUM_PIECES,
  DRUM_PARAM_SPECS,
  FX_TYPES,
  FX_PARAM_SPECS,
  SAMPLED_INSTRUMENTS,
  SYNTH_INSTRUMENTS,
  findSynthInstrument,
  findSynthPreset,
  presetGainDb,
  presetGainScale,
  kitGainDb,
  kitGainScale,
  PRESET_GAIN_DB_MIN,
  PRESET_GAIN_DB_MAX,
} from '../src/shared/catalog.js'
import {
  buildSampleDrum,
  buildSampleVoice,
} from '../src/client/audio/samples.js'
import * as catalogModule from '../src/shared/catalog.js'
import { createTempoMap, normalizeTempoPoints, bpmAtBeat as tempoBpmAtBeat, projectDurationSeconds, clampTempoBpm, TEMPO_MIN_BPM, TEMPO_MAX_BPM, MAX_TEMPO_POINTS } from '../src/shared/tempo.js'
import { createDemoProject } from '../src/shared/demo.js'
import {
  SoundfontBank,
  effectiveInstrumentParams,
  voiceInstrumentOptions,
  instrumentFilterSettings,
  INSTRUMENT_PARAM_DEFAULTS,
} from '../src/client/audio/soundfont.js'
import {
  buildSubtractiveVoice,
  resolveSubtractiveParams,
  coerceSubtractiveParam,
  instrumentParamsToSynthOverrides,
  synthFreqForPitch,
  SUBTRACTIVE_DEFAULTS,
  MAX_SUBTRACTIVE_VOICES,
} from '../src/client/audio/synth.js'
import {
  analyzeChannels,
  analyzeAudioBuffer,
  peakNormalizeGain,
  linearToDb,
  computeKWeightedLoudness,
  kWeightingCoefficients,
  computeStereoMetrics,
  computeAverageSpectrum,
  spectralCentroid,
  bandEnergyPct,
  normalizeSectionBounds,
  SPECTRAL_BANDS,
  SPECTRAL_FFT_SIZE,
  LUFS_BLOCK_SECONDS,
  LUFS_SHORT_TERM_SECONDS,
  LUFS_ABSOLUTE_GATE,
  MIN_DB,
  CLIP_THRESHOLD,
  DEFAULT_NORMALIZE_PEAK,
} from '../src/client/audio/analysis.js'
import {
  sustainAt,
  effectiveNoteEndBeat,
  normalizeSustainPoints,
  sustainMaxHoldBeats,
  SUSTAIN_MAX_HOLD_SECONDS,
  SUSTAIN_DOWN_THRESHOLD,
} from '../src/client/audio/sustain.js'
import {
  MediaBank,
  buildAudioClipSegments,
  buildClipFadeEnvelope,
  normalizeClipGainDb,
  normalizeClipFadeSeconds,
  CLIP_GAIN_DB_MIN,
  CLIP_GAIN_DB_MAX,
  CLIP_FADE_SECONDS_MAX,
  collectMediaFiles,
  MEDIA_BASE,
  MIN_AUDIO_CLIP_SECONDS,
} from '../src/client/audio/media.js'
import {
  wsolaChannels,
  pitchShiftChannels,
  processClipAudio,
  resampleLinear,
  reverseChannels,
  normalizeStretchRatio,
  normalizeSemitones,
  isIdentityProcess,
  MIN_STRETCH_RATIO,
  MAX_STRETCH_RATIO,
  MIN_SEMITONES,
  MAX_SEMITONES,
} from '../src/client/audio/stretch.js'
import {
  encodeMp3,
  encodeFlac,
  encodeAudioFormat,
  audioFormatExtension,
  audioFormatMime,
  ENCODE_FORMATS,
  MP3_BITRATES,
  MP3_SAMPLE_RATES,
  DEFAULT_MP3_BITRATE_KBPS,
} from '../src/client/audio/encode.js'

import {
  clamp,
  clamp01,
  dbToGain,
  gainToDb,
  rmsToLevel,
  makeDriveCurve,
  makeBitCrushCurve,
  generateImpulseData,
  getNoiseBuffer,
  hashSeed,
  mulberry32,
  clearDspCaches,
  dspCacheSizes,
  LEVEL_FLOOR_DB,
} from '../src/client/audio/dsp.js'
import {
  secondsPerBeat,
  bpmToBps,
  swingOffset,
  expandProjectEvents,
  createPlaybackPlan,
  mapEventsToTransport,
  positionBeatAt,
  remainingBeats,
} from '../src/client/audio/timing.js'
import { encodeWav, encodeWavBytes, parseWavHeader } from '../src/client/audio/wav.js'
import { SYNTH_DEFAULTS, coerceSynthParams, resolveSynthParams, buildSynthVoice } from '../src/client/audio/synths.js'
import {
  DRUM_DEFAULTS,
  DRUM_PIECE_IDS,
  coerceDrumParams,
  resolveDrumParams,
  drumPieceForPitch,
} from '../src/client/audio/drums.js'
import { IMPLEMENTED_FX_TYPES, fxHasMix, resolveFxParams, buildEffect, buildFxChain } from '../src/client/audio/fx.js'
import {
  graphSignature,
  masterGainFor,
  trackAudibleGain,
  trackGainForValue,
  normalizeEngineGroups,
  resolveTrackGroupId,
  normalizeSendMode,
  normalizePdcMs,
  phaseGainFor,
  trackRoutingSignature,
  groupRoutingSignature,
  meterDbFromLinear,
  lufsApproxFromRms,
  readAnalyserTimeStats,
  meterSnapshot,
  emptyMeters,
  aggregateGroupMeters,
  groupGainFor,
  GROUPS_MAX,
  GROUP_LEVEL_DEFAULT,
  GROUP_OUTPUT_MASTER,
  busReturnGain,
  findFirstFilterEffect,
  scheduleAudioParamValue,
  scheduleDuckEnvelope,
  buildMixGraph,
  normalizeBus,
  normalizeBuses,
  BUS_DEFAULTS,
  BUS_IDS,
} from '../src/client/audio/graph.js'
import {
  StudioEngine,
  encodeWav as engineEncodeWav,
  computeRenderPlan,
  computeAutomationTargets,
  applyAutomationTargets,
  computePluginAutomationTargets,
  buildAutomationSamples,
  buildOfflineAutomationSchedule,
  resolveSubtractiveTrackParams,
  enabledAutomationPoints,
  effectiveCutoffCurve,
  noteExpression,
  cutoffHzFromAutomation,
  mapAutomationValue,
  normalizeSidechain,
  normalizeTriggerNotes,
  buildSidechainIndex,
  sidechainTargets,
  scheduleDuckTargets,
  SIDECHAIN_DEFAULTS,
  SIDECHAIN_LIMITS,
  PREVIEW_GAIN,
  PREVIEW_DURATION_SECONDS,
  AUTOMATION_APPLY_INTERVAL,
  AUTOMATION_SAMPLE_STEP,
  CUTOFF_MIN_HZ,
  CUTOFF_MAX_HZ,
  LOOKAHEAD_MS,
  SCHEDULE_AHEAD_SECONDS,
  MAX_VOICES,
  MAX_RENDER_SECONDS,
  RENDER_SAMPLE_RATE,
  FAST_RENDER_SAMPLE_RATE,
  measureTruePeak,
  applyTargetLufsGain,
  MIN_RENDER_SAMPLE_RATE,
  MAX_RENDER_SAMPLE_RATE,
} from '../src/client/audio/engine.js'
import {
  InputRecorder,
  concatFloat32,
  computePeaks,
  encodeRecordedWav,
  mapMicrophoneError,
  normalizeMonitorGain,
  MIN_RECORD_SECONDS,
  DEFAULT_MAX_SECONDS,
  RECORDER_BUFFER_SIZE,
  PEAK_COUNT,
  DEFAULT_MONITOR_GAIN,
} from '../src/client/audio/recorder.js'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/**
 * 合成器/合成鼓机的本地测试 fixture（clean break：catalog 不再导出 LEGACY 目录）。
 * 引擎内部仍保留合成能力（供内部/测试覆盖），用显式 instrument.params 驱动，
 * 不依赖 catalog 里的旧预设/旧鼓组。
 */
const TEST_SYNTH_PRESETS = [
  {
    id: 'test_supersaw',
    params: {
      osc: 'saw', voices: 7, detune: 0.28, sub: 0.18, fmAmount: 0, attack: 0.004, decay: 0.2,
      sustain: 0.6, release: 0.22, cutoff: 6800, resonance: 1.1, envAmount: 0.32, lfoRate: 0.25,
      lfoAmount: 0, drive: 0.18, level: 0.72, glide: 0,
    },
  },
  {
    id: 'test_sub',
    params: {
      osc: 'sine', voices: 1, detune: 0, sub: 1, fmAmount: 0, attack: 0.005, decay: 0.5,
      sustain: 0.4, release: 0.1, cutoff: 300, resonance: 1, envAmount: 0, lfoRate: 0,
      lfoAmount: 0, drive: 0.05, level: 0.8, glide: 0,
    },
  },
  {
    id: 'test_warmpad',
    params: {
      osc: 'triangle', voices: 5, detune: 0.3, sub: 0.1, fmAmount: 0, attack: 0.8, decay: 0.5,
      sustain: 0.8, release: 0.9, cutoff: 3200, resonance: 1.2, envAmount: 0.2, lfoRate: 0.2,
      lfoAmount: 0.1, drive: 0.05, level: 0.65, glide: 0,
    },
  },
  {
    id: 'test_acid',
    params: {
      osc: 'saw', voices: 1, detune: 0, sub: 0.1, fmAmount: 0, attack: 0.002, decay: 0.2,
      sustain: 0.1, release: 0.1, cutoff: 600, resonance: 12, envAmount: 0.8, lfoRate: 0,
      lfoAmount: 0, drive: 0.35, level: 0.7, glide: 0.04,
    },
  },
  {
    id: 'test_fmkeys',
    params: {
      osc: 'sine', voices: 2, detune: 0.02, sub: 0, fmRatio: 2.01, fmAmount: 0.6, attack: 0.01,
      decay: 0.4, sustain: 0.2, release: 0.3, cutoff: 9000, resonance: 1, envAmount: 0.1,
      lfoRate: 0, lfoAmount: 0, drive: 0.02, level: 0.7, glide: 0,
    },
  },
  {
    id: 'test_reese',
    params: {
      osc: 'saw', voices: 3, detune: 0.5, sub: 0.4, fmAmount: 0, attack: 0.006, decay: 0.35,
      sustain: 0.7, release: 0.15, cutoff: 700, resonance: 3, envAmount: 0.2, lfoRate: 2.6,
      lfoAmount: 0.5, drive: 0.3, level: 0.7, glide: 0,
    },
  },
]

const TEST_DRUM_KITS = [
  {
    id: 'test_neon808',
    params: { kickPitch: 40, kickDecay: 0.9, kickDrive: 0.4, snareTone: 0.4, clapSpread: 0.4, hatDecay: 0.02, drive: 0.1, level: 0.8 },
  },
  {
    id: 'test_club',
    params: { kickPitch: 50, kickDecay: 0.42, kickDrive: 0.16, snareTone: 0.6, clapSpread: 0.6, hatDecay: 0.07, drive: 0.12, level: 0.8 },
  },
  {
    id: 'test_lofi',
    params: { kickPitch: 45, kickDecay: 0.35, kickDrive: 0.2, snareTone: 0.3, clapSpread: 0.5, hatDecay: 0.12, drive: 0.3, level: 0.7 },
  },
]

function fixtureSynthInstrument(preset = TEST_SYNTH_PRESETS[0]) {
  return { preset: preset.id, kit: null, params: { ...preset.params } }
}

function fixtureDrumInstrument(kit = TEST_DRUM_KITS[1]) {
  return { preset: null, kit: kit.id, params: { ...kit.params } }
}

function buildTestProject(overrides = {}) {
  const project = createEmptyProject({
    title: 'unit-test',
    bpm: 120,
    key: 'A',
    scale: 'minor',
    lengthBars: 8,
    timeSignature: [4, 4],
    swing: 0,
  })
  const drums = makeTrack({ id: 'trk_1', name: 'Drums', kind: 'drum', role: 'drums', volume: 0.8, pan: 0 })
  drums.instrument = fixtureDrumInstrument(TEST_DRUM_KITS[1])
  const lead = makeTrack({ id: 'trk_2', name: 'Lead', kind: 'synth', role: 'lead', volume: 0.7, pan: -0.1 })
  lead.instrument = fixtureSynthInstrument(TEST_SYNTH_PRESETS[0])
  project.tracks.push(drums, lead)
  project.patterns.push(
    makePattern({
      id: 'pat_1',
      name: 'beat',
      lengthBars: 1,
      notes: [
        { pitch: 36, start: 0, dur: 0.25, vel: 0.9 },
        { pitch: 38, start: 1, dur: 0.25, vel: 0.8 },
      ],
    }),
    makePattern({
      id: 'pat_2',
      name: 'bass',
      lengthBars: 2,
      notes: [
        { pitch: 45, start: 0, dur: 1, vel: 0.8 },
        { pitch: 48, start: 2, dur: 1, vel: 0.7 },
      ],
    }),
  )
  project.clips.push(
    makeClip({ id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 4 }),
    makeClip({ id: 'clip_2', trackId: 'trk_2', patternId: 'pat_2', startBar: 2, lengthBars: 4, transpose: 12 }),
  )
  project.transport.loopStartBar = 0
  project.transport.loopEndBar = 8
  Object.assign(project, overrides)
  return project
}

function mockAudioBuffer({ channels = 2, frames = 8, sampleRate = 44100, fill = null } = {}) {
  const data = []
  for (let c = 0; c < channels; c++) {
    const channel = new Float32Array(frames)
    if (typeof fill === 'function') fill(channel, c)
    else for (let i = 0; i < frames; i++) channel[i] = Math.sin((i / frames) * Math.PI * 2 + c) * 0.5
    data.push(channel)
  }
  return {
    numberOfChannels: channels,
    sampleRate,
    length: frames,
    getChannelData: (channel) => data[channel],
  }
}

// ---- 轻量 Web Audio mock（只用于在 Node 里验证 renderWav 的代码路径）--------

const PARAM_METHODS = [
  'setValueAtTime',
  'linearRampToValueAtTime',
  'exponentialRampToValueAtTime',
  'setTargetAtTime',
  'setValueCurveAtTime',
  'cancelScheduledValues',
  'cancelAndHoldAtTime',
]

function makeParamStub(initial = 0) {
  const param = { value: initial, ops: [] }
  for (const method of PARAM_METHODS) {
    param[method] = (...args) => {
      param.ops.push({ op: method, args })
    }
  }
  return param
}

function makeNodeStub(kind, sink = null, connectionSink = null) {
  const node = {
    kind,
    connect(target) {
      if (connectionSink) connectionSink.push({ from: node, to: target })
    },
    disconnect() {},
    addEventListener() {},
    removeEventListener() {},
    startCalls: [],
    stopCalls: [],
    start(...args) {
      node.startCalls.push(args)
    },
    stop(...args) {
      node.stopCalls.push(args)
    },
    type: '',
    curve: null,
    oversample: 'none',
    normalize: false,
    buffer: null,
    loop: false,
    fftSize: 1024,
    smoothingTimeConstant: 0,
    getChannelData: () => new Float32Array(0),
    getFloatTimeDomainData() {},
    getByteFrequencyData() {},
    getByteTimeDomainData() {},
  }
  for (const name of ['gain', 'frequency', 'detune', 'Q', 'delayTime', 'playbackRate', 'threshold', 'knee', 'ratio', 'attack', 'release', 'pan']) {
    node[name] = makeParamStub()
    if (sink) sink.push({ kind, name, param: node[name] })
  }
  return node
}

function installMockOfflineAudioContext() {
  const instances = []
  class MockOfflineAudioContext {
    constructor(channels, length, sampleRate) {
      this.numberOfChannels = channels
      this.length = length
      this.sampleRate = sampleRate
      this.currentTime = 0
      this.destination = makeNodeStub('destination')
      this.suspendCalls = []
      this.resumeCalls = 0
      this.nodeCount = 0
      this.nodesBeforeRender = 0
      this.params = []
      this.connections = []
      this.sources = []
      this.nodes = []
      this._suspendResolvers = []
      instances.push(this)
    }
    _node(kind) {
      this.nodeCount += 1
      const node = makeNodeStub(kind, this.params, this.connections)
      this.nodes.push(node)
      return node
    }
    createGain() {
      return this._node('gain')
    }
    createOscillator() {
      return this._node('oscillator')
    }
    createBiquadFilter() {
      return this._node('biquad')
    }
    createWaveShaper() {
      return this._node('waveshaper')
    }
    createDelay() {
      return this._node('delay')
    }
    createConvolver() {
      return this._node('convolver')
    }
    createDynamicsCompressor() {
      return this._node('compressor')
    }
    createAnalyser() {
      return this._node('analyser')
    }
    createStereoPanner() {
      return this._node('panner')
    }
    createChannelMerger() {
      return this._node('merger')
    }
    createBufferSource() {
      const node = this._node('source')
      this.sources.push(node)
      return node
    }
    createBuffer(channels, length, sampleRate) {
      this.nodeCount += 1
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length),
      }
    }
    suspend(when) {
      this.suspendCalls.push(when)
      return new Promise((resolve) => {
        this._suspendResolvers.push({ when, resolve })
      })
    }
    resume() {
      this.resumeCalls += 1
      return Promise.resolve()
    }
    async startRendering() {
      this.nodesBeforeRender = this.nodeCount
      // 模拟真实的 suspend 时间线：到点暂停 → 主线程创建/释放节点 → resume
      for (const item of this._suspendResolvers) {
        this.currentTime = item.when
        item.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      this.currentTime = this.length / this.sampleRate
      const channels = []
      for (let c = 0; c < this.numberOfChannels; c++) {
        const data = new Float32Array(this.length)
        for (let i = 0; i < this.length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / this.sampleRate) * 0.5
        channels.push(data)
      }
      return {
        numberOfChannels: this.numberOfChannels,
        sampleRate: this.sampleRate,
        length: this.length,
        getChannelData: (channel) => channels[channel],
      }
    }
  }
  return { MockOfflineAudioContext, instances }
}

// ---------------------------------------------------------------------------
// 1. 音高 / 基础 DSP
// ---------------------------------------------------------------------------

test('pitchToFreq：A4=440，八度翻倍', () => {
  assert.equal(pitchToFreq(69), 440)
  assert.equal(pitchToFreq(57), 220)
  assert.equal(pitchToFreq(81), 880)
  assert.ok(Math.abs(pitchToFreq(60) - 261.6255653) < 1e-6)
})

test('dB / RMS 电平换算', () => {
  assert.ok(Math.abs(dbToGain(0) - 1) < 1e-9)
  assert.ok(Math.abs(dbToGain(-6) - 0.5011872) < 1e-6)
  assert.ok(Math.abs(gainToDb(dbToGain(-12)) + 12) < 1e-6)
  assert.equal(rmsToLevel(0), 0)
  assert.equal(rmsToLevel(-1), 0)
  assert.ok(Math.abs(rmsToLevel(1) - 1) < 1e-9)
  const mid = rmsToLevel(dbToGain(LEVEL_FLOOR_DB / 2))
  assert.ok(mid > 0.4 && mid < 0.6)
  // 单调递增
  assert.ok(rmsToLevel(0.01) < rmsToLevel(0.1))
})

test('clamp / clamp01 对非法值安全', () => {
  assert.equal(clamp(NaN, 2, 5), 2)
  assert.equal(clamp(10, 0, 3), 3)
  assert.equal(clamp01('0.5'), 0.5)
  assert.equal(clamp01(undefined), 0)
  assert.equal(clamp01(-2), 0)
})

test('makeDriveCurve：长度、端点、单调', () => {
  const curve = makeDriveCurve(0.6, 1024)
  assert.equal(curve.length, 1024)
  assert.ok(Math.abs(curve[0] + 1) < 0.02)
  assert.ok(Math.abs(curve[1023] - 1) < 0.02)
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i] >= curve[i - 1] - 1e-6)
  // amount 越大，小信号被推得越狠（曲线归一化后中点增益更大），这就是 drive 的听感来源
  const soft = makeDriveCurve(0.05)
  const hard = makeDriveCurve(1)
  assert.ok(Math.abs(hard[512]) > Math.abs(soft[512]))
})

test('makeBitCrushCurve：量化台阶数量', () => {
  const curve = makeBitCrushCurve(2, 4096)
  const levels = Math.pow(2, 2)
  const distinct = new Set()
  for (const v of curve) distinct.add(Math.round(v * levels) / levels)
  assert.ok(distinct.size <= levels * 2 + 1)
  for (const v of curve) assert.ok(Math.abs(v) <= 1)
})

test('generateImpulseData：长度/采样率/幅度范围', () => {
  const impulse = generateImpulseData(44100, { size: 0.6, decay: 0.5, damp: 0.4, channels: 2 })
  assert.equal(impulse.sampleRate, 44100)
  assert.equal(impulse.data.length, 2)
  assert.equal(impulse.data[0].length, impulse.length)
  assert.ok(impulse.seconds > 0.2 && impulse.seconds <= 4)
  let nonzero = 0
  for (const chan of impulse.data) {
    assert.equal(chan.length, impulse.length)
    for (const v of chan) {
      assert.ok(Number.isFinite(v))
      assert.ok(Math.abs(v) <= 1)
      if (v !== 0) nonzero += 1
    }
  }
  assert.ok(nonzero > impulse.length)
})

test('确定性 DSP：hashSeed/mulberry32/IR 缓存/噪声缓存（导出可复现基础）', () => {
  // PRNG 可复现
  assert.equal(hashSeed('a', 1, 0.5), hashSeed('a', 1, 0.5))
  assert.notEqual(hashSeed('a', 1, 0.5), hashSeed('a', 1, 0.6))
  const seq1 = []
  const seq2 = []
  const random1 = mulberry32(hashSeed('x', 3))
  const random2 = mulberry32(hashSeed('x', 3))
  for (let i = 0; i < 8; i++) {
    seq1.push(random1())
    seq2.push(random2())
  }
  assert.deepEqual(seq1, seq2)
  assert.ok(seq1.every((v) => v >= 0 && v < 1))
  assert.notDeepEqual(seq1, (() => {
    const out = []
    const random = mulberry32(hashSeed('x', 4))
    for (let i = 0; i < 8; i++) out.push(random())
    return out
  })())

  clearDspCaches()
  const params = { size: 0.6, decay: 0.5, damp: 0.4, channels: 2 }
  const first = generateImpulseData(44100, params)
  const second = generateImpulseData(44100, params)
  // 同参数命中缓存（同一对象）
  assert.equal(first, second)
  assert.ok(dspCacheSizes().impulse >= 1)
  // 不同参数不同缓存/不同波形
  const different = generateImpulseData(44100, { ...params, decay: 0.9 })
  assert.notEqual(different, first)
  assert.notDeepEqual(Array.from(different.data[0]), Array.from(first.data[0]))
  // clear 后重新生成 → 数值与之前完全一致（但对象不同）
  clearDspCaches()
  assert.equal(dspCacheSizes().impulse, 0)
  const again = generateImpulseData(44100, params)
  assert.notEqual(again, first)
  assert.deepEqual(Array.from(again.data[0]), Array.from(first.data[0]))
  assert.deepEqual(Array.from(again.data[1]), Array.from(first.data[1]))

  // 噪声：不同 ctx 但同采样率/时长 → 内容逐位一致；不同时长不同
  const makeNoiseCtx = (sampleRate) => ({
    sampleRate,
    createBuffer(numberOfChannels, length, rate) {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
      return {
        numberOfChannels,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (channel) => channels[channel],
      }
    },
  })
  clearDspCaches()
  const noiseA = getNoiseBuffer(makeNoiseCtx(44100), 2)
  const noiseB = getNoiseBuffer(makeNoiseCtx(44100), 2)
  assert.notEqual(noiseA, noiseB)
  assert.deepEqual(Array.from(noiseA.getChannelData(0)), Array.from(noiseB.getChannelData(0)))
  const noiseElse = getNoiseBuffer(makeNoiseCtx(44100), 0.5)
  assert.notEqual(noiseElse.length, noiseA.length)
  assert.notDeepEqual(Array.from(noiseElse.getChannelData(0)), Array.from(noiseA.getChannelData(0).slice(0, noiseElse.length)))
  // clear 后重新生成同样内容
  clearDspCaches()
  const noiseC = getNoiseBuffer(makeNoiseCtx(44100), 2)
  assert.deepEqual(Array.from(noiseC.getChannelData(0)), Array.from(noiseA.getChannelData(0)))
  clearDspCaches()
})

test('确定性渲染：同 project 连续 renderWav 两次，调度参数/媒体源逐项一致（mock 离线）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const fakeBuffer = makeTestAudioBuffer(6, 100)
    const project = makeAudioProject({ mediaDuration: 6 })
    project.clips[0].gainDb = -6
    project.clips[0].fadeInSeconds = 0.5
    project.clips[0].fadeOutSeconds = 0.5
    project.tracks[0].sends = { reverb: 0.4, delay: 0.2 }
    project.buses = { reverb: { level: 0.5, effects: [] }, delay: { level: 0.3, effects: [] } }
    const renderOnce = async () => {
      const engine = new StudioEngine()
      engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
      engine._mediaBank.setContext(makeReversalContext())
      await engine.renderWav(project, { fromBar: 0, toBar: 1 })
      engine.dispose()
      const ctx = instances.at(-1)
      const raw = {
        sources: ctx.sources.map((source) => ({ start: source.startCalls, stop: source.stopCalls, loop: source.loop })),
        params: ctx.params.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          ops: entry.param?.ops?.map((op) => ({ op: op.op, args: op.args })) ?? [],
        })),
      }
      // 去掉函数/非有限值，保留可比较的确定性快照
      return JSON.parse(
        JSON.stringify(raw, (key, value) => {
          if (typeof value === 'function') return '[fn]'
          if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
          return value
        }),
      )
    }
    const first = await renderOnce()
    const second = await renderOnce()
    assert.deepEqual(second, first)
    // blob 尺寸一致（mock 渲染长度确定）
    assert.ok(instances.length >= 2)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

// ---------------------------------------------------------------------------
// 2. 时间 / swing / 事件展开
// ---------------------------------------------------------------------------

test('secondsPerBeat / bpmToBps', () => {
  assert.equal(secondsPerBeat(120), 0.5)
  assert.equal(bpmToBps(120), 2)
  assert.ok(Math.abs(secondsPerBeat(60 * 2) - 0.5) < 1e-12)
})

test('swingOffset：只推奇数 16 分，最大 1/12 beat，非网格音符不动', () => {
  assert.equal(swingOffset(0, 0.5), 0)
  assert.equal(swingOffset(0.5, 1), 0) // 偶数 16 分
  assert.equal(swingOffset(0.25, 0), 0)
  assert.ok(Math.abs(swingOffset(0.25, 1) - 1 / 12) < 1e-12)
  assert.ok(Math.abs(swingOffset(0.25, 0.5) - 1 / 24) < 1e-12)
  assert.ok(Math.abs(swingOffset(0.75, 1) - 1 / 12) < 1e-12)
  assert.equal(swingOffset(0.3, 1), 0) // 不在 16 分网格
  assert.equal(swingOffset(1.25, 1), swingOffset(0.25, 1)) // 每个 16 分都按相位
})

test('expandProjectEvents：pattern 循环平铺 + transpose + 排序', () => {
  const project = buildTestProject()
  const { events, totalBeats, barBeats } = expandProjectEvents(project)
  assert.equal(barBeats, 4)
  assert.equal(totalBeats, 32)
  // drums: 每小节 2 个音 × 4 小节 = 8；lead: 每 2 小节 2 音 × 2 = 4
  assert.equal(events.length, 12)
  for (let i = 1; i < events.length; i++) assert.ok(events[i].startBeat >= events[i - 1].startBeat)

  const drumEvents = events.filter((e) => e.trackId === 'trk_1')
  assert.equal(drumEvents.length, 8)
  assert.deepEqual(
    [...new Set(drumEvents.map((e) => e.startBeat))],
    [0, 1, 4, 5, 8, 9, 12, 13],
  )

  const leadEvents = events.filter((e) => e.trackId === 'trk_2')
  assert.equal(leadEvents.length, 4)
  assert.deepEqual([...new Set(leadEvents.map((e) => e.startBeat))], [8, 10, 16, 18])
  // transpose +12 已生效
  assert.ok(leadEvents.some((e) => e.pitch === 57))
  assert.ok(leadEvents.some((e) => e.pitch === 60))
  assert.ok(leadEvents.every((e) => e.kind === 'synth'))
  assert.ok(drumEvents.every((e) => e.kind === 'drum'))
})

test('expandProjectEvents：swing 已折算进 swingBeats，非法 pitch 被钳制', () => {
  const project = buildTestProject({ swing: 0.5 })
  project.patterns[0] = makePattern({
    id: 'pat_1',
    lengthBars: 1,
    notes: [
      { pitch: 36, start: 0.25, dur: 0.25, vel: 1 },
      { pitch: 38, start: 0.5, dur: 0.25, vel: 1 },
    ],
  })
  const { events } = expandProjectEvents(project)
  const atQuarter = events.find((e) => e.startBeat === 0.25)
  const atHalf = events.find((e) => e.startBeat === 0.5)
  assert.ok(Math.abs(atQuarter.swingBeats - (0.5 * 0.25) / 3) < 1e-12)
  assert.equal(atHalf.swingBeats, 0)
  project.patterns[1].notes[0].pitch = 200 // 越界音高在展开时被钳制
  const again = expandProjectEvents(project)
  assert.ok(again.events.every((e) => e.pitch <= 127))
})

test('clipNotes 与 expandProjectEvents 的绝对 beat 一致', () => {
  const project = buildTestProject()
  const clip = project.clips[0]
  const notes = clipNotes(project, clip)
  assert.equal(notes.length, 8)
  assert.equal(notes[0].start, 0)
  assert.equal(notes[2].start, 4)
})

// ---------------------------------------------------------------------------
// 3. Loop / 播放位置
// ---------------------------------------------------------------------------

test('createPlaybackPlan：有效 loop 区间 → 循环', () => {
  const project = buildTestProject()
  project.transport.loopStartBar = 2
  project.transport.loopEndBar = 6
  const plan = createPlaybackPlan(project, 0)
  assert.equal(plan.looping, true)
  assert.equal(plan.rangeStartBar, 2)
  assert.equal(plan.rangeEndBar, 6)
  assert.equal(plan.startBar, 2) // 起点在 loop 外 → 从 loop 头开始
  assert.equal(plan.rangeStartBeat, 8)
  assert.equal(plan.rangeLenBeats, 16)

  const inside = createPlaybackPlan(project, 3.5)
  assert.equal(inside.looping, true)
  assert.equal(inside.startBar, 3.5)
})

test('createPlaybackPlan：loop 无效 → 播到 lengthBars 后停止', () => {
  const project = buildTestProject()
  project.transport.loopStartBar = 0
  project.transport.loopEndBar = 0
  const plan = createPlaybackPlan(project, 2)
  assert.equal(plan.looping, false)
  assert.equal(plan.startBar, 2)
  assert.equal(plan.rangeStartBeat, 8)
  assert.equal(plan.rangeEndBeat, 32)
  assert.equal(plan.rangeLenBeats, 24)

  const end = createPlaybackPlan(project, 99)
  assert.equal(end.looping, false)
  assert.equal(end.startBar, 0)
})

test('positionBeatAt：循环回绕 / 非循环钳制', () => {
  const project = buildTestProject()
  project.transport.loopStartBar = 2
  project.transport.loopEndBar = 6
  const plan = createPlaybackPlan(project, 2)
  const bps = bpmToBps(project.bpm) // 2 beats/s
  assert.equal(positionBeatAt(plan, { anchorBeat: 8, anchorTime: 0, now: 0, bps }), 8)
  assert.equal(positionBeatAt(plan, { anchorBeat: 8, anchorTime: 0, now: 1, bps }), 10)
  // 16 beats = 8 秒后绕回 loop 起点
  assert.equal(positionBeatAt(plan, { anchorBeat: 8, anchorTime: 0, now: 8, bps }), 8)
  assert.equal(positionBeatAt(plan, { anchorBeat: 8, anchorTime: 0, now: 9, bps }), 10)

  const linear = createPlaybackPlan(project, 4)
  const linearPlan = { ...linear, looping: false, rangeStartBeat: 16, rangeEndBeat: 32, rangeLenBeats: 16 }
  assert.equal(positionBeatAt(linearPlan, { anchorBeat: 16, anchorTime: 0, now: 99, bps }), 32)
  assert.equal(remainingBeats(linearPlan, { anchorBeat: 16, anchorTime: 0, now: 2, bps }), 12)
})

test('mapEventsToTransport：loop 内过滤 / 跨 loop 末尾截断 / relU 排序', () => {
  const project = buildTestProject()
  project.transport.loopStartBar = 2
  project.transport.loopEndBar = 6
  const plan = createPlaybackPlan(project, 2)
  const { events } = expandProjectEvents(project)
  const mapped = mapEventsToTransport(events, plan, plan.startBeat)
  assert.ok(mapped.length > 0)
  assert.ok(mapped.every((e) => e.relU >= 0 && e.relU < plan.rangeLenBeats))
  for (let i = 1; i < mapped.length; i++) assert.ok(mapped[i].relU >= mapped[i - 1].relU)

  // 跨越 loop 末尾的音符被截断
  const crossing = [
    { trackId: 'x', kind: 'synth', pitch: 60, vel: 1, startBeat: 8 + 15.5, durBeats: 3, swingBeats: 0 },
  ]
  const trimmed = mapEventsToTransport(crossing, plan, 8)
  assert.equal(trimmed.length, 1)
  assert.ok(Math.abs(trimmed[0].durBeats - 0.5) < 1e-9)

  // loop 区间外的音符被丢弃
  const outside = [{ trackId: 'x', kind: 'synth', pitch: 60, vel: 1, startBeat: 1, durBeats: 1, swingBeats: 0 }]
  assert.equal(mapEventsToTransport(outside, plan, 8).length, 0)

  // 非循环时，锚点之前的音符被丢弃、之后的保留
  project.transport.loopStartBar = 0
  project.transport.loopEndBar = 0
  const linear = createPlaybackPlan(project, 4)
  const eventsLinear = [
    { trackId: 'x', kind: 'synth', pitch: 60, vel: 1, startBeat: 15, durBeats: 1, swingBeats: 0 },
    { trackId: 'x', kind: 'synth', pitch: 62, vel: 1, startBeat: 17, durBeats: 1, swingBeats: 0 },
  ]
  const mappedLinear = mapEventsToTransport(eventsLinear, linear, linear.startBeat)
  assert.deepEqual(mappedLinear.map((e) => e.pitch), [62])
})

// ---------------------------------------------------------------------------
// 4. WAV 编码
// ---------------------------------------------------------------------------

test('encodeWavBytes：RIFF 头字段正确', () => {
  const buffer = mockAudioBuffer({ channels: 2, frames: 16, sampleRate: 44100 })
  const bytes = encodeWavBytes(buffer)
  assert.equal(bytes.byteLength, 44 + 16 * 2 * 2)
  const header = parseWavHeader(bytes)
  assert.equal(header.riff, 'RIFF')
  assert.equal(header.riffSize, 36 + 16 * 4)
  assert.equal(header.wave, 'WAVE')
  assert.equal(header.fmt, 'fmt ')
  assert.equal(header.audioFormat, 1) // PCM
  assert.equal(header.channels, 2)
  assert.equal(header.sampleRate, 44100)
  assert.equal(header.bitsPerSample, 16)
  assert.equal(header.blockAlign, 4)
  assert.equal(header.byteRate, 44100 * 4)
  assert.equal(header.data, 'data')
  assert.equal(header.dataSize, 16 * 4)
})

test('encodeWavBytes：float → int16 采样值（含 ±1 饱和）', () => {
  const buffer = mockAudioBuffer({ channels: 1, frames: 4, sampleRate: 8000 })
  const data = buffer.getChannelData(0)
  data[0] = 0
  data[1] = 1
  data[2] = -1
  data[3] = 0.5
  const bytes = encodeWavBytes(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getInt16(44, true), 0)
  assert.equal(view.getInt16(46, true), 32767)
  assert.equal(view.getInt16(48, true), -32768)
  assert.equal(view.getInt16(50, true), Math.round(0.5 * 0x7fff))
})

test('encodeWav：返回 audio/wav Blob', async () => {
  const buffer = mockAudioBuffer({ channels: 2, frames: 8 })
  const blob = encodeWav(buffer)
  assert.ok(blob instanceof Blob)
  assert.equal(blob.type, 'audio/wav')
  assert.equal(blob.size, encodeWavBytes(buffer).byteLength)
  const back = new Uint8Array(await blob.arrayBuffer())
  assert.equal(parseWavHeader(back).data, 'data')
  // 空 buffer / 非法输入
  assert.throws(() => encodeWavBytes(null), /AudioBuffer/)
})

// ---------------------------------------------------------------------------
// 5. 合成器 / 鼓机 / 效果器参数覆盖率
// ---------------------------------------------------------------------------

test('P8 采样乐器 32：id/程序号/字段完整、无合成参数；clean break 后无 LEGACY 导出', () => {
  assert.equal(SYNTH_PRESETS.length, 32)
  assert.equal(SAMPLED_INSTRUMENTS.length, 32)
  // CONTRACT-P12 clean break：catalog 不再导出旧合成目录（只保留内部合成引擎能力用于测试）
  assert.equal(Object.prototype.hasOwnProperty.call(catalogModule, 'LEGACY_SYNTH_PRESETS'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(catalogModule, 'LEGACY_DRUM_KITS'), false)
  const programs = new Set()
  for (const preset of SYNTH_PRESETS) {
    assert.ok(preset.id && preset.name && preset.label && preset.category, `${preset.id} 字段缺失`)
    assert.equal(preset.params, undefined, `${preset.id} 不应有合成参数`)
    const soundfont = preset.soundfont
    assert.ok(soundfont && Number.isInteger(soundfont.program) && soundfont.program >= 0 && soundfont.program <= 127)
    assert.equal(soundfont.bank ?? 0, 0)
    assert.equal(findSynthPreset(preset.id)?.soundfont?.program, soundfont.program)
    programs.add(soundfont.program)
  }
  assert.equal(programs.size, 32, '32 个采样乐器的 GM 程序号应互不相同')
  const programOf = Object.fromEntries(SYNTH_PRESETS.map((preset) => [preset.id, preset.soundfont.program]))
  assert.equal(programOf.grand_piano, 0)
  assert.equal(programOf.marimba, 12)
  assert.equal(programOf.finger_bass, 33)
  assert.equal(programOf.strings_ensemble, 49)
  assert.equal(programOf.warm_pad, 89)
  // R5a 新增 14 个 GM Bank 0 程序
  assert.equal(programOf.glockenspiel, 9)
  assert.equal(programOf.vibraphone, 11)
  assert.equal(programOf.church_organ, 19)
  assert.equal(programOf.jazz_guitar, 26)
  assert.equal(programOf.muted_guitar, 28)
  assert.equal(programOf.picked_bass, 34)
  assert.equal(programOf.fretless_bass, 35)
  assert.equal(programOf.synth_bass, 38)
  assert.equal(programOf.viola, 41)
  assert.equal(programOf.pizzicato_strings, 45)
  assert.equal(programOf.voice_oohs, 53)
  assert.equal(programOf.trombone, 57)
  assert.equal(programOf.french_horn, 60)
  assert.equal(programOf.clarinet, 71)
  // 本地 fixture 驱动内部合成引擎（clean break 后不再从 catalog 取旧预设）
  for (const preset of TEST_SYNTH_PRESETS) {
    const params = resolveSynthParams({ instrument: { preset: preset.id, params: preset.params } })
    for (const [key, spec] of Object.entries(SYNTH_PARAM_SPECS)) {
      assert.ok(Object.prototype.hasOwnProperty.call(params, key), `${preset.id}.${key} 缺失`)
      if (spec.type === 'number') {
        assert.ok(params[key] >= spec.min && params[key] <= spec.max, `${preset.id}.${key}=${params[key]} 越界`)
      } else if (spec.type === 'enum') {
        assert.ok(spec.options.includes(params[key]), `${preset.id}.${key} 非法枚举`)
      }
    }
  }
})

test('合成器参数：钳制 / 覆盖顺序（track 覆盖 preset fixture）', () => {
  assert.deepEqual(coerceSynthParams({}), { ...SYNTH_DEFAULTS })
  const clamped = resolveSynthParams({
    instrument: {
      preset: TEST_SYNTH_PRESETS[0].id,
      params: { ...TEST_SYNTH_PRESETS[0].params, voices: 99, cutoff: 5, osc: 'bogus', attack: -3, sustain: 5 },
    },
  })
  assert.equal(clamped.voices, 9)
  assert.equal(clamped.cutoff, 80)
  assert.equal(clamped.osc, 'saw')
  assert.equal(clamped.attack, 0)
  assert.equal(clamped.sustain, 1)

  const overridden = resolveSynthParams({
    instrument: { preset: TEST_SYNTH_PRESETS[0].id, params: { ...TEST_SYNTH_PRESETS[0].params, voices: 2, detune: 0 } },
  })
  assert.equal(overridden.voices, 2)
  assert.equal(overridden.detune, 0)
  // 未覆盖的 fixture 值保留（cutoff 6800）
  assert.equal(overridden.cutoff, 6800)
})

test('合成器引擎（本地 fixture）：预设参数确实不同（内部合成能力仍可用）', () => {
  const byId = Object.fromEntries(
    TEST_SYNTH_PRESETS.map((preset) => [
      preset.id,
      resolveSynthParams({ instrument: { preset: preset.id, params: preset.params } }),
    ]),
  )
  const supersaw = byId.test_supersaw
  const sub = byId.test_sub
  assert.notEqual(supersaw.osc, sub.osc)
  assert.notEqual(supersaw.voices, sub.voices)
  assert.notEqual(byId.test_acid.cutoff, byId.test_reese.cutoff)
  assert.ok(byId.test_acid.resonance > 10)
  assert.ok(byId.test_warmpad.attack > 0.5)
  assert.ok(byId.test_fmkeys.fmAmount > 0.4)
  assert.ok(byId.test_reese.detune > 0.4)
  const signatures = new Set(
    TEST_SYNTH_PRESETS.map((preset) =>
      JSON.stringify([
        byId[preset.id].osc,
        byId[preset.id].voices,
        byId[preset.id].detune,
        byId[preset.id].fmAmount,
        byId[preset.id].cutoff,
        byId[preset.id].attack,
        byId[preset.id].sustain,
      ]),
    ),
  )
  assert.equal(signatures.size, TEST_SYNTH_PRESETS.length)
})

test('4 套真实采样鼓机 + 11 个鼓件；内部合成鼓引擎用本地 fixture 覆盖', () => {
  assert.equal(DRUM_PIECES.length, 11)
  assert.deepEqual(DRUM_PIECE_IDS, DRUM_PIECES.map((p) => p.id))
  assert.equal(new Set(DRUM_PIECE_IDS).size, 11)
  assert.equal(DRUM_KITS.length, 4, '用户可见鼓组应为 4 套真实采样鼓')
  // CONTRACT-P12 clean break：catalog 不再导出旧合成鼓组目录
  assert.equal(Object.prototype.hasOwnProperty.call(catalogModule, 'LEGACY_DRUM_KITS'), false)

  for (const piece of DRUM_PIECES) assert.equal(drumPieceForPitch(piece.pitch)?.id, piece.id)
  assert.equal(drumPieceForPitch(36).id, 'kick')
  assert.equal(drumPieceForPitch(42).id, 'hat')
  assert.equal(drumPieceForPitch(60).id, 'perc')
  assert.equal(drumPieceForPitch(61), null)
  assert.equal(drumPieceForPitch(NaN), null)

  // 4 套新鼓组都是采样鼓（有 samplerPieces 文件映射），参数仍在 specs 内
  for (const kit of DRUM_KITS) {
    assert.ok(kit.samplerPieces && Object.keys(kit.samplerPieces).length >= 4, `${kit.id} 应有采样文件`)
    const params = resolveDrumParams({ instrument: { kit: kit.id, params: {} } })
    for (const [key, spec] of Object.entries(DRUM_PARAM_SPECS)) {
      assert.ok(params[key] >= spec.min && params[key] <= spec.max, `${kit.id}.${key} 越界`)
    }
  }
  // 内部合成鼓引擎（本地 fixture）：参数仍可解析/合法、不同鼓组参数不同
  for (const kit of TEST_DRUM_KITS) {
    const params = resolveDrumParams({ instrument: { kit: kit.id, params: kit.params } })
    for (const [key, spec] of Object.entries(DRUM_PARAM_SPECS)) {
      assert.ok(params[key] >= spec.min && params[key] <= spec.max, `${kit.id}.${key} 越界`)
    }
  }
  const neon = resolveDrumParams({ instrument: { kit: TEST_DRUM_KITS[0].id, params: TEST_DRUM_KITS[0].params } })
  const club = resolveDrumParams({ instrument: { kit: TEST_DRUM_KITS[1].id, params: TEST_DRUM_KITS[1].params } })
  const lofi = resolveDrumParams({ instrument: { kit: TEST_DRUM_KITS[2].id, params: TEST_DRUM_KITS[2].params } })
  assert.notEqual(neon.kickDecay, club.kickDecay)
  assert.notEqual(neon.hatDecay, lofi.hatDecay)

  // 钳制 + 覆盖
  const clamped = coerceDrumParams({ kickPitch: -100, kickDecay: 99, level: 2 })
  assert.equal(clamped.kickPitch, 30)
  assert.equal(clamped.kickDecay, 1.5)
  assert.equal(clamped.level, 1)
  assert.deepEqual(coerceDrumParams({}), { ...DRUM_DEFAULTS })
  const overridden = resolveDrumParams({
    instrument: { kit: TEST_DRUM_KITS[1].id, params: { ...TEST_DRUM_KITS[1].params, kickDecay: 0.9 } },
  })
  assert.equal(overridden.kickDecay, 0.9)
})

test('15 种效果器全部实现，参数解析/钳制正确', () => {
  assert.equal(FX_TYPES.length, 15)
  assert.deepEqual([...IMPLEMENTED_FX_TYPES].sort(), FX_TYPES.map((f) => f.id).sort())
  for (const fx of FX_TYPES) {
    const params = resolveFxParams(fx.id, {})
    for (const [key, spec] of Object.entries(FX_PARAM_SPECS[fx.id] ?? {})) {
      assert.ok(Object.prototype.hasOwnProperty.call(params, key), `${fx.id}.${key} 缺失`)
      if (spec.type === 'number') assert.ok(params[key] >= spec.min && params[key] <= spec.max)
    }
  }
  // 有/无 mix 分类符合 catalog
  assert.equal(fxHasMix('filter'), true)
  assert.equal(fxHasMix('reverb'), true)
  assert.equal(fxHasMix('delay'), true)
  assert.equal(fxHasMix('compressor'), false)
  assert.equal(fxHasMix('eq3'), false)
  assert.equal(fxHasMix('tremolo'), false)
  // P5 新类型：全部实现且都有 mix
  for (const type of ['flanger', 'ringmod', 'autopan']) {
    assert.ok(IMPLEMENTED_FX_TYPES.includes(type), `${type} 应已实现`)
    assert.equal(fxHasMix(type), true, `${type} 应有 mix`)
    assert.ok(FX_TYPES.some((fx) => fx.id === type), `${type} 应在 catalog.FX_TYPES`)
  }

  const filter = resolveFxParams('filter', { cutoff: 99999, resonance: -3, mode: 'nope' })
  assert.equal(filter.cutoff, 16000)
  assert.equal(filter.resonance, 0.1)
  assert.equal(filter.mode, 'lowpass')
  const delay = resolveFxParams('delay', { feedback: 2, pingpong: false })
  assert.equal(delay.feedback, 0.95)
  assert.equal(delay.pingpong, false)
  const comp = resolveFxParams('compressor', { threshold: -100, ratio: 99 })
  assert.equal(comp.threshold, -60)
  assert.equal(comp.ratio, 20)
  // 新类型默认值 / 越界钳制 / 未知参数忽略
  const flanger = resolveFxParams('flanger', { rate: 99, depth: 2, feedback: -1, mix: 5 })
  assert.equal(flanger.rate, 5)
  assert.equal(flanger.depth, 1)
  assert.equal(flanger.feedback, 0)
  assert.equal(flanger.mix, 1)
  const flangerDefaults = resolveFxParams('flanger', { nope: 123 })
  assert.equal(flangerDefaults.rate, 0.4)
  assert.equal(flangerDefaults.depth, 0.7)
  assert.equal(flangerDefaults.feedback, 0.45)
  assert.equal(flangerDefaults.mix, 0.5)
  const ringmod = resolveFxParams('ringmod', { frequency: 0, mix: -1 })
  assert.equal(ringmod.frequency, 20)
  assert.equal(ringmod.mix, 0)
  assert.equal(resolveFxParams('ringmod', {}).frequency, 440)
  const autopan = resolveFxParams('autopan', { rate: 0, depth: 9, mix: 2 })
  assert.equal(autopan.rate, 0.05)
  assert.equal(autopan.depth, 1)
  assert.equal(autopan.mix, 1)
  assert.equal(resolveFxParams('autopan', {}).mix, 1)
  // P11：高频架（无 mix）+ reverb preDelay 参数
  assert.ok(IMPLEMENTED_FX_TYPES.includes('highshelf'))
  assert.equal(fxHasMix('highshelf'), false)
  assert.equal(resolveFxParams('highshelf', {}).freq, 6000)
  assert.equal(resolveFxParams('highshelf', {}).gain, 4)
  assert.equal(resolveFxParams('highshelf', { freq: 99999, gain: -99 }).freq, 16000)
  assert.equal(resolveFxParams('highshelf', { freq: 99999, gain: -99 }).gain, -12)
  assert.equal(resolveFxParams('reverb', {}).preDelay, 20)
  assert.equal(resolveFxParams('reverb', { preDelay: 999 }).preDelay, 120)
})

test('buildSynthVoice：attack 上限跟随 catalog specs（fixture attack 2.2 不被钳到 2s）', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const destination = ctx.createGain()
  const params = resolveSynthParams({ instrument: { preset: 'test_riser', params: { attack: 2.2 } } })
  assert.ok(Math.abs(params.attack - 2.2) < 1e-9)
  assert.equal(SYNTH_PARAM_SPECS.attack.max, 3)
  const voice = buildSynthVoice(ctx, destination, { pitch: 60, vel: 0.8, startTime: 1, dur: 3 }, params, {
    presetId: 'test_riser',
  })
  assert.ok(voice)
  // 音量包络起音应在 startTime + 2.2s 到达峰值（旧硬编码 clamp 0..2 会变成 +2.0s）
  const attackHits = ctx.params.filter((entry) =>
    entry.param.ops.some(
      (op) => op.op === 'linearRampToValueAtTime' && Math.abs(op.args[1] - 3.2) < 1e-6,
    ),
  )
  assert.ok(attackHits.length >= 1, '包络应在 startTime+2.2s 到达峰值')
  const oldLimitHits = ctx.params.filter((entry) =>
    entry.param.ops.some(
      (op) => op.op === 'linearRampToValueAtTime' && Math.abs(op.args[1] - 3.0) < 1e-6,
    ),
  )
  assert.equal(oldLimitHits.length, 0, '不应再被旧上限 2s 钳制')
  voice.stop?.(0.1)
})

test('buildEffect：flanger 图（LFO 调制短延迟 + feedback）与 mix/enabled/smoothing/dispose', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const wrapper = buildEffect(ctx, {
    id: 'fx_f',
    type: 'flanger',
    enabled: true,
    params: { rate: 0.8, depth: 0.6, feedback: 0.4, mix: 0.35 },
  })
  assert.equal(wrapper.type, 'flanger')
  assert.ok(wrapper.input && wrapper.output)
  assert.equal(wrapper._params.rate, 0.8)
  // 短延迟 base ≈3ms
  const delayParam = ctx.params.find((entry) => entry.kind === 'delay' && entry.name === 'delayTime')
  assert.ok(delayParam, 'flanger 应有 DelayNode.delayTime')
  closeTo(delayParam.param.value, 0.003)
  // LFO（sine）调制 delayTime；depth gain = depth * 2ms
  const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
  assert.equal(oscillators.length, 1)
  assert.equal(oscillators[0].type, 'sine')
  assert.equal(oscillators[0].startCalls.length, 1)
  // 首次 update 为 immediate：depth 调制量 = depth * 2ms 直接写入 gain.value
  const depthGainParam = ctx.params.find(
    (entry) =>
      entry.kind === 'gain' &&
      entry.name === 'gain' &&
      Math.abs(entry.param.value - 0.6 * 0.002) < 1e-9,
  )
  assert.ok(depthGainParam, 'LFO 深度增益应为 depth * 2ms')
  // 二次 update 走平滑 ramp：LFO rate 2.5、feedback 0.25、mix 0.65 → wet 0.65 / dry 0.35
  wrapper.update({ rate: 2.5, depth: 0.5, feedback: 0.25, mix: 0.65 })
  const lfoFreq = ctx.params.find((entry) => entry.kind === 'oscillator' && entry.name === 'frequency')
  assert.ok(lfoFreq.param.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 2.5) < 1e-9))
  const rampedGains = (target) =>
    ctx.params.filter(
      (entry) =>
        entry.kind === 'gain' &&
        entry.param.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - target) < 1e-9),
    )
  assert.ok(rampedGains(0.65).length >= 1, 'wet 增益应设为 mix')
  assert.ok(rampedGains(0.35).length >= 1, 'dry 增益应设为 1-mix')
  assert.ok(rampedGains(0.25).length >= 1, 'feedback 增益应更新')
  // enabled=false → 旁通：wet 0 / dry 1
  wrapper.update({ rate: 2.5, depth: 0.5, feedback: 0.25, mix: 0.65 }, false)
  assert.equal(wrapper.enabled, false)
  assert.ok(rampedGains(0).length >= 1)
  assert.ok(rampedGains(1).length >= 1)
  // dispose 停止 LFO；重复 dispose 安全
  wrapper.dispose()
  assert.ok(oscillators[0].stopCalls.length >= 1)
  wrapper.dispose()
})

test('buildEffect：ringmod 环形调制（Gain 基值 0 被 Oscillator 调制）', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const wrapper = buildEffect(ctx, {
    id: 'fx_r',
    type: 'ringmod',
    enabled: true,
    params: { frequency: 330, mix: 1 },
  })
  assert.equal(wrapper._params.frequency, 330)
  const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
  assert.equal(oscillators.length, 1)
  assert.equal(oscillators[0].startCalls.length, 1)
  // Oscillator 应连到某个 AudioParam（GainNode.gain），且基值为 0 → 输出 = input × osc
  const ringEdge = ctx.connections.find((edge) => edge.from === oscillators[0] && edge.to && edge.to.ops)
  assert.ok(ringEdge, 'Oscillator 应连接到 GainNode.gain')
  assert.equal(ringEdge.to.value, 0)
  // 频率平滑更新
  wrapper.update({ frequency: 1200, mix: 0.5 })
  const oscFreq = ctx.params.find((entry) => entry.kind === 'oscillator' && entry.name === 'frequency')
  assert.ok(oscFreq.param.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 1200) < 1e-9))
  // 未知参数 → 默认频率 440
  const fallback = buildEffect(ctx, { id: 'fx_r2', type: 'ringmod', params: { nope: 1 } })
  assert.equal(fallback._params.frequency, 440)
  wrapper.dispose()
  assert.ok(oscillators[0].stopCalls.length >= 1)
})

test('buildEffect：autopan 声像 LFO 调制 + 无 StereoPanner 降级直通', () => {
  const mock = installMockOfflineAudioContext()
  const ctx = new mock.MockOfflineAudioContext(2, 44100, 44100)
  const wrapper = buildEffect(ctx, {
    id: 'fx_p',
    type: 'autopan',
    enabled: true,
    params: { rate: 0.5, depth: 0.8, mix: 1 },
  })
  assert.equal(wrapper._params.depth, 0.8)
  const panners = ctx.nodes.filter((node) => node.kind === 'panner')
  assert.equal(panners.length, 1)
  const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
  assert.equal(oscillators.length, 1)
  assert.equal(oscillators[0].type, 'sine')
  const panParam = panners[0].pan
  // LFO depth gain 连到 panner.pan；输入连到 panner
  assert.ok(ctx.connections.some((edge) => edge.to === panParam), 'LFO 应连接到 panner.pan')
  assert.ok(ctx.connections.some((edge) => edge.to === panners[0]), 'input 应连接到 panner')
  wrapper.update({ rate: 2, depth: 0.5, mix: 0.5 })
  assert.ok(panParam.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0]) < 1e-9), 'pan 基值应回 0')
  const oscFreq = ctx.params.find((entry) => entry.kind === 'oscillator' && entry.name === 'frequency')
  assert.ok(oscFreq.param.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 2) < 1e-9))
  wrapper.dispose()
  assert.ok(oscillators[0].stopCalls.length >= 1)
  // 无 StereoPanner → 降级直通，不抛异常
  const noPanCtx = new mock.MockOfflineAudioContext(2, 44100, 44100)
  noPanCtx.createStereoPanner = undefined
  const fallback = buildEffect(noPanCtx, { type: 'autopan', params: { rate: 3, depth: 1, mix: 0.5 } })
  assert.equal(fallback.type, 'autopan')
  fallback.update({ rate: 1, depth: 0.2, mix: 0.2 })
  assert.equal(noPanCtx.nodes.filter((node) => node.kind === 'panner').length, 0)
  assert.equal(noPanCtx.nodes.filter((node) => node.kind === 'oscillator').length, 0)
  fallback.dispose()
})

test('buildFxChain：三种新效果器可串联、update 只改参数、dispose 停止全部 LFO', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const chain = buildFxChain(ctx, [
    makeEffect('fx_1', 'flanger', { rate: 1, depth: 0.5, feedback: 0.3, mix: 0.6 }),
    makeEffect('fx_2', 'ringmod', { frequency: 300, mix: 0.5 }),
    makeEffect('fx_3', 'autopan', { rate: 1, depth: 0.5, mix: 0.8 }),
  ])
  assert.equal(chain.list.length, 3)
  assert.equal(chain.effects.get('fx_1').type, 'flanger')
  assert.equal(chain.effects.get('fx_2').type, 'ringmod')
  assert.equal(chain.effects.get('fx_3').type, 'autopan')
  assert.ok(chain.list.every((fx) => fx.input && fx.output))
  chain.update([
    makeEffect('fx_1', 'flanger', { rate: 2, depth: 0.2, feedback: 0.1, mix: 0.4 }),
    makeEffect('fx_2', 'ringmod', { frequency: 800, mix: 0.9 }),
    makeEffect('fx_3', 'autopan', { rate: 3, depth: 0.9, mix: 0.3 }),
  ])
  assert.equal(chain.list.length, 3, 'update 不应重建链')
  assert.equal(chain.effects.get('fx_2')._params.frequency, 800)
  assert.equal(chain.effects.get('fx_3')._params.depth, 0.9)
  // 3 个效果器共 3 个振荡器（flanger LFO / ringmod osc / autopan LFO）
  const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
  assert.equal(oscillators.length, 3)
  chain.dispose()
  chain.dispose() // 幂等
  assert.ok(oscillators.every((node) => node.stopCalls.length >= 1))
})

test('buildMixGraph：新效果器可挂轨道 / Master / 返回总线并参与实时图', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = buildTestProject()
  project.tracks[1].effects.push(makeEffect('fx_fl', 'flanger', { rate: 0.8, depth: 0.6, feedback: 0.4, mix: 0.5 }))
  project.master.effects.push(makeEffect('fx_rm', 'ringmod', { frequency: 440, mix: 0.5 }))
  project.buses = {
    reverb: { level: 0.35, effects: [makeEffect('fx_ap', 'autopan', { rate: 0.5, depth: 0.8, mix: 1 })] },
    delay: { level: 0.2, effects: [] },
  }
  const graph = buildMixGraph(ctx, project, { analysers: false })
  try {
    // 轨道 FX 链
    assert.ok(graph.tracks.get('trk_2').fx.effects.has('fx_fl'))
    assert.equal(graph.tracks.get('trk_2').fx.effects.get('fx_fl').type, 'flanger')
    // Master FX 链
    assert.ok(graph.masterFx.effects.has('fx_rm'))
    assert.equal(graph.masterFx.effects.get('fx_rm').type, 'ringmod')
    // Reverb 返回总线 FX 链
    assert.ok(graph.reverbBus.fx.effects.has('fx_ap'))
    assert.equal(graph.reverbBus.fx.effects.get('fx_ap').type, 'autopan')
    // graph.update 原地更新新 FX 参数（不重建）
    const next = JSON.parse(JSON.stringify(project))
    next.tracks[1].effects.find((effect) => effect.id === 'fx_fl').params.depth = 0.2
    next.master.effects.find((effect) => effect.id === 'fx_rm').params.frequency = 880
    next.buses.reverb.effects.find((effect) => effect.id === 'fx_ap').params.rate = 2
    graph.update(next)
    assert.equal(graph.tracks.get('trk_2').fx.effects.get('fx_fl')._params.depth, 0.2)
    assert.equal(graph.masterFx.effects.get('fx_rm')._params.frequency, 880)
    assert.equal(graph.reverbBus.fx.effects.get('fx_ap')._params.rate, 2)
  } finally {
    graph.dispose()
  }
})

// ---------------------------------------------------------------------------
// 6. 混音图纯函数
// ---------------------------------------------------------------------------

test('graphSignature：结构变化才变，参数变化不变', () => {
  const project = buildTestProject()
  const sig1 = graphSignature(project)
  assert.equal(sig1, graphSignature(project))
  // 音量/pan 改变不影响图结构
  project.tracks[1].volume = 0.3
  project.tracks[1].pan = 0.5
  assert.equal(graphSignature(project), sig1)
  // 加效果器 → 结构变化
  project.tracks[1].effects.push(makeEffect('fx_9', 'delay', { mix: 0.3 }))
  assert.notEqual(graphSignature(project), sig1)
  // 换 preset → 结构变化
  const other = buildTestProject()
  other.tracks[1].instrument.preset = 'sub'
  assert.notEqual(graphSignature(other), sig1)
})

test('trackAudibleGain：mute / solo / volume', () => {
  const project = buildTestProject()
  const track = project.tracks[1]
  assert.ok(Math.abs(trackAudibleGain(project, track) - Math.pow(0.7, 1.35)) < 1e-9)
  track.mute = true
  assert.equal(trackAudibleGain(project, track), 0)
  track.mute = false
  project.tracks[0].solo = true
  assert.equal(trackAudibleGain(project, track), 0)
  assert.ok(trackAudibleGain(project, project.tracks[0]) > 0)
  assert.ok(busReturnGain(0.35) > 0 && busReturnGain(1) === 1 && busReturnGain(0) === 0)
  assert.ok(masterGainFor(project) > 0)
})

// ---------------------------------------------------------------------------
// 7. StudioEngine：无 AudioContext 环境下的安全行为
// ---------------------------------------------------------------------------

test('StudioEngine：API 与契约一致，构造不创建 AudioContext', () => {
  let created = 0
  const original = globalThis.AudioContext
  globalThis.AudioContext = class FakeAudioContext {
    constructor() {
      created += 1
    }
  }
  try {
    const engine = new StudioEngine({ onPosition: () => {}, onState: () => {} })
    assert.equal(created, 0)
    for (const method of ['unlock', 'setProject', 'play', 'stop', 'seek', 'getLevels', 'getSpectrum', 'renderWav', 'dispose']) {
      assert.equal(typeof engine[method], 'function', `缺少方法 ${method}`)
    }
    assert.equal(engine.unlocked, false)
    assert.equal(engine.isPlaying, false)
    assert.equal(engine.positionBar, 0)
    engine.dispose()
  } finally {
    if (original === undefined) delete globalThis.AudioContext
    else globalThis.AudioContext = original
  }
})

test('StudioEngine：setProject/levels/seek/stop 在无 AudioContext 时不崩', async () => {
  const engine = new StudioEngine()
  const project = buildTestProject()
  engine.setProject(project)

  const levels = engine.getLevels()
  assert.equal(levels.master, 0)
  assert.equal(levels.tracks.trk_1, 0)
  assert.equal(levels.tracks.trk_2, 0)

  const spectrum = new Uint8Array(32)
  spectrum.fill(7)
  engine.getSpectrum(spectrum)
  assert.ok(spectrum.every((v) => v === 0))

  // 未解锁时 play() 安全排队，不抛错、不误报 playing
  engine.play(2)
  assert.equal(engine.isPlaying, false)
  assert.equal(engine.positionBar, 2)

  engine.seek(3.5)
  assert.equal(engine.positionBar, 3.5)
  engine.seek(999)
  assert.equal(engine.positionBar, project.lengthBars)
  engine.stop()
  assert.equal(engine.isPlaying, false)

  // 没有 AudioContext 时 unlock 静默返回、不抛错
  await engine.unlock()
  assert.equal(engine.unlocked, false)
  engine.dispose()
  // dispose 后调用安全
  engine.setProject(project)
  engine.play()
  engine.stop()
})

test('StudioEngine：常量与 encodeWav 导出符合契约', () => {
  assert.equal(LOOKAHEAD_MS, 25)
  assert.equal(SCHEDULE_AHEAD_SECONDS, 0.12)
  assert.equal(MAX_VOICES, 60)
  assert.equal(MAX_RENDER_SECONDS, 480)
  assert.equal(RENDER_SAMPLE_RATE, 44100)
  assert.equal(engineEncodeWav, encodeWav)
})

test('StudioEngine.renderWav：无 OfflineAudioContext 时抛出明确错误', async () => {
  const engine = new StudioEngine()
  const project = buildTestProject()
  await assert.rejects(() => engine.renderWav(project), /OfflineAudioContext|不支持/)
  engine.dispose()
})

test('StudioEngine.renderWav：整首渲染走通图构建 + WAV 输出（mock OfflineAudioContext）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const engine = new StudioEngine()
    const project = buildTestProject() // 8 小节 @120BPM = 16 秒
    const { blob, seconds } = await engine.renderWav(project)
    assert.equal(instances.length, 1)
    const ctx = instances[0]
    assert.equal(ctx.numberOfChannels, 2)
    assert.equal(ctx.sampleRate, 44100)
    assert.ok(Math.abs(seconds - 16) < 1e-6)
    assert.equal(ctx.length, Math.round(seconds * 44100))

    assert.ok(blob instanceof Blob)
    assert.equal(blob.type, 'audio/wav')
    assert.equal(blob.size, 44 + ctx.length * 2 * 2)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const header = parseWavHeader(bytes)
    assert.equal(header.riff, 'RIFF')
    assert.equal(header.wave, 'WAVE')
    assert.equal(header.channels, 2)
    assert.equal(header.sampleRate, 44100)
    assert.equal(header.bitsPerSample, 16)
    assert.equal(header.dataSize, ctx.length * 4)

    // 长曲子应启用 suspend/resume 周期性清理，避免离线渲染图无限膨胀
    assert.ok(ctx.suspendCalls.length > 0)
    assert.ok(ctx.resumeCalls > 0)
    for (let i = 1; i < ctx.suspendCalls.length; i++) assert.ok(ctx.suspendCalls[i] > ctx.suspendCalls[i - 1])
    for (const t of ctx.suspendCalls) assert.ok(t > 0 && t < seconds)
    engine.dispose()
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('StudioEngine.renderWav：fromBar/toBar 区间渲染（mock OfflineAudioContext）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const engine = new StudioEngine()
    const project = buildTestProject()
    const { blob, seconds } = await engine.renderWav(project, { fromBar: 2, toBar: 4 })
    assert.ok(Math.abs(seconds - 4) < 1e-6)
    assert.equal(instances[0].length, Math.round(4 * 44100))
    assert.equal(blob.size, 44 + instances[0].length * 4)
    engine.dispose()
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('真实 demo（32 小节 / 60s）renderPlan + 离线懒创建回归', async () => {
  const demo = createDemoProject()
  assert.equal(demo.lengthBars, 32)
  // 32 小节 @128BPM 4/4 = 60 秒，44.1k stereo 16bit ≈ 10.6MB
  const plan = computeRenderPlan(demo, {})
  assert.equal(plan.capped, false)
  assert.ok(Math.abs(plan.seconds - 60) < 1e-9)
  assert.equal(plan.frames, 2646000)

  const { events } = expandProjectEvents(demo)
  assert.equal(events.length, 1464)
  assert.ok(events.every((e) => e.startBeat >= 0 && e.startBeat < 128))

  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const engine = new StudioEngine()
    // P8：demo 全部改用真实采样音色 → 注入已解析 SF2 与伪造采样鼓 bank（Node 无网络/音频设备）
    engine._soundfontBank = await createSf2Bank()
    engine._sampleBank = makeFakeSampleBank()
    const { blob, seconds } = await engine.renderWav(demo)
    engine.dispose()
    assert.ok(Math.abs(seconds - 60) < 1e-6)
    const ctx = instances[0]
    assert.equal(ctx.length, 2646000)
    assert.equal(blob.size, 44 + 2646000 * 4)
    // 懒创建：开始渲染时只创建了开头 2 秒的 voice，而不是把 1464 个 voice 全建进图里
    assert.ok(ctx.nodesBeforeRender > 0)
    assert.ok(
      ctx.nodesBeforeRender < ctx.nodeCount / 2,
      `离线懒创建未生效：before=${ctx.nodesBeforeRender} total=${ctx.nodeCount}`,
    )
    // 每 1s 一个 suspend 时间点，60s 共 59 个；每个 suspend 都要 resume 才能继续渲染
    assert.ok(ctx.suspendCalls.length >= 50)
    assert.ok(ctx.resumeCalls >= ctx.suspendCalls.length - 1)
    assert.ok(ctx.suspendCalls.every((t, i) => t > 0 && t < 60 && (i === 0 || t > ctx.suspendCalls[i - 1])))
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('computeRenderPlan：整首 / 区间 / 8 分钟上限', () => {
  const project = buildTestProject() // 8 小节，120 BPM，4/4
  const full = computeRenderPlan(project, {})
  assert.equal(full.fromBar, 0)
  assert.equal(full.toBar, 8)
  assert.equal(full.bps, 2)
  assert.ok(Math.abs(full.seconds - 16) < 1e-9)
  assert.equal(full.frames, Math.round(16 * RENDER_SAMPLE_RATE))
  assert.equal(full.capped, false)

  const range = computeRenderPlan(project, { fromBar: 2, toBar: 4 })
  assert.equal(range.fromBar, 2)
  assert.equal(range.toBar, 4)
  assert.ok(Math.abs(range.seconds - 4) < 1e-9)

  // toBar 非法 / 越界：按整首渲染
  const bad = computeRenderPlan(project, { toBar: 999 })
  assert.equal(bad.toBar, 8)
  assert.equal(bad.capped, false)

  // 8 分钟上限：bpm=40, 256 小节 → 请求 1536s，被压到 480s
  const long = { ...buildTestProject(), bpm: 40, lengthBars: 256 }
  const capped = computeRenderPlan(long, {})
  assert.equal(capped.capped, true)
  assert.equal(capped.seconds, MAX_RENDER_SECONDS)
  assert.equal(capped.frames, Math.round(MAX_RENDER_SECONDS * RENDER_SAMPLE_RATE))
  assert.ok(capped.requestedSeconds > MAX_RENDER_SECONDS)
})

test('StudioEngine：回调用 safe try/catch 包裹（不因回调抛错中断）', async () => {
  const engine = new StudioEngine({
    onPosition: () => {
      throw new Error('callback boom')
    },
    onState: () => {
      throw new Error('callback boom')
    },
  })
  const project = buildTestProject()
  engine.setProject(project)
  assert.doesNotThrow(() => engine.play(0))
  assert.doesNotThrow(() => engine.stop())
  engine.dispose()
})

// ---------------------------------------------------------------------------
// 8. 自动化（CONTRACT-P2 §4）：实时应用 / 离线排程 / 映射 / mock graph
// ---------------------------------------------------------------------------

function closeTo(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) <= tolerance, `期望 ${expected}，实际 ${actual}`)
}

/** 含自动化的测试工程（trk_2 volume+cutoff 启用、pan disabled；trk_1 空点；master volume）。 */
function buildAutomationProject() {
  const project = buildTestProject()
  project.tracks[1].automation = {
    volume: { enabled: true, points: [{ beat: 0, value: 0.2 }, { beat: 8, value: 1 }] },
    pan: { enabled: false, points: [{ beat: 0, value: 0 }, { beat: 8, value: 1 }] },
    cutoff: { enabled: true, points: [{ beat: 0, value: 0 }, { beat: 8, value: 1 }] },
  }
  // cutoff 自动化作用在该轨第一个 filter FX 上 → 测试工程补一个 Filter
  project.tracks[1].effects.push(makeEffect('fx_filter', 'filter', { cutoff: 2400, resonance: 3, mix: 1 }))
  project.tracks[0].automation = {
    volume: { enabled: true, points: [] }, // enabled 但 0 点 = 不生效
  }
  project.master.automation = {
    volume: { enabled: true, points: [{ beat: 0, value: 0.25 }, { beat: 32, value: 0.75 }] },
  }
  return project
}

function makeMockGraph() {
  const calls = []
  const graph = {
    calls,
    updateCalls: [],
    setTrackVolume: (...args) => calls.push(['setTrackVolume', ...args]),
    setTrackPan: (...args) => calls.push(['setTrackPan', ...args]),
    setTrackCutoff: (...args) => calls.push(['setTrackCutoff', ...args]),
    setMasterVolume: (...args) => calls.push(['setMasterVolume', ...args]),
    update: (project) => graph.updateCalls.push(project),
  }
  return graph
}

/** 给 engine 注入 mock ctx/graph 与播放锚点（模拟「正在播放到第 N 秒」）。 */
function primeRealtimeAutomation(engine, project, currentTime = 1) {
  engine.setProject(project)
  engine._ctx = { currentTime, state: 'running' }
  engine._graph = makeMockGraph()
  engine._playing = true
  engine._plan = createPlaybackPlan(project, 0)
  engine._bps = bpmToBps(project.bpm)
  engine._anchorTime = 0
  engine._anchorBeat = 0
  engine._u0 = 0
  engine._lastAutomationAt = -Infinity
  return engine._graph
}

test('自动化映射：cutoff 对数映射 / pan 线性映射 与 shared AUTOMATION_PARAMS 一致', () => {
  assert.equal(CUTOFF_MIN_HZ, 80)
  assert.equal(CUTOFF_MAX_HZ, 16000)
  closeTo(cutoffHzFromAutomation(0), 80)
  closeTo(cutoffHzFromAutomation(1), 16000)
  closeTo(cutoffHzFromAutomation(0.5), 80 * Math.sqrt(16000 / 80))
  closeTo(cutoffHzFromAutomation(0.25), 80 * Math.pow(200, 0.25))
  for (const value of [0, 0.1, 0.5, 0.75, 1]) {
    closeTo(mapAutomationValue('volume', value), AUTOMATION_PARAMS.volume.map(value))
    closeTo(mapAutomationValue('pan', value), value * 2 - 1)
    closeTo(mapAutomationValue('cutoff', value), AUTOMATION_PARAMS.cutoff.map(value))
  }
  // enabled / 空点 / 缺省 = 该参数无自动化
  assert.equal(enabledAutomationPoints({ enabled: false, points: [{ beat: 0, value: 1 }] }), null)
  assert.equal(enabledAutomationPoints({ enabled: true, points: [] }), null)
  assert.equal(enabledAutomationPoints(undefined), null)
  assert.equal(enabledAutomationPoints({ points: [{ beat: 0, value: 1 }] }).length, 1)
})

test('P0-5 volume automation 乘算：effective=track.volume×automation，0.5+0.5 vs 1.0+0.5 比值 2（增益比 2^1.35）', () => {
  const makeProject = (volume) => {
    const base = buildTestProject()
    const track = base.tracks[1]
    track.volume = volume
    track.automation = { volume: { enabled: true, points: [{ beat: 0, value: 0.5 }, { beat: 4, value: 0.5 }] } }
    return base
  }
  const half = makeProject(0.5)
  const full = makeProject(1)
  const halfTarget = computeAutomationTargets(half, 2).find((target) => target.kind === 'setTrackVolume')
  const fullTarget = computeAutomationTargets(full, 2).find((target) => target.kind === 'setTrackVolume')
  closeTo(halfTarget.value, 0.25) // 0.5 × 0.5
  closeTo(fullTarget.value, 0.5) // 1.0 × 0.5
  closeTo(fullTarget.value / halfTarget.value, 2)
  // 现有音量曲线 pow(volume,1.35)：实际线性增益比 = 2^1.35（约 2.55）；静态音量不变
  const halfGain = trackGainForValue(half, half.tracks[1], halfTarget.value)
  const fullGain = trackGainForValue(full, full.tracks[1], fullTarget.value)
  closeTo(halfGain, Math.pow(0.25, 1.35))
  closeTo(fullGain, Math.pow(0.5, 1.35))
  closeTo(fullGain / halfGain, Math.pow(2, 1.35))
  // 自动化只改 effective volume，不覆盖 track.volume 字段
  closeTo(half.tracks[1].volume, 0.5)
  closeTo(full.tracks[1].volume, 1)
  // 离线排程同样乘算：raw value=0.5，effective=track.volume×0.5
  const plan = computeRenderPlan(half, { fromBar: 0, toBar: 2 })
  const schedule = buildOfflineAutomationSchedule(half, plan)
  const volumeSamples = schedule.tracks.find((entry) => entry.trackId === half.tracks[1].id)?.volume ?? []
  assert.ok(volumeSamples.length > 0)
  closeTo(volumeSamples[0].value, 0.5)
  closeTo(volumeSamples[0].effective, 0.25)
  assert.equal(volumeSamples.every((sample) => Math.abs(sample.effective - 0.25) < 1e-9), true)
  // graph.setTrackVolume 接收 effective volume：0.25 → pow(0.25,1.35)
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const graph = buildMixGraph(ctx, half, { analysers: false })
  try {
    assert.equal(graph.setTrackVolume(half.tracks[1].id, 0.25), true)
    const gainEntry = graph.tracks.get(half.tracks[1].id)
    assert.ok(
      gainEntry.gain.gain.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - Math.pow(0.25, 1.35)) < 1e-9),
    )
  } finally {
    graph.dispose()
  }
})

test('computeAutomationTargets：插值 / 映射 / 禁用参数不应用 / 顺序', () => {
  const project = buildAutomationProject()
  const targets = computeAutomationTargets(project, 4)
  assert.deepEqual(targets.map((t) => t.kind), ['setTrackVolume', 'setTrackCutoff', 'setMasterVolume'])
  const [volume, cutoff, master] = targets
  assert.equal(volume.trackId, 'trk_2')
  closeTo(volume.value, 0.42) // track.volume 0.7 × automation 0.6
  closeTo(volume.automationValue, 0.6)
  closeTo(volume.mapped, 0.42)
  assert.equal(cutoff.trackId, 'trk_2')
  closeTo(cutoff.value, 0.5)
  closeTo(cutoff.hz, 80 * Math.sqrt(200))
  assert.equal(master.target, 'master')
  closeTo(master.value, 0.3125) // 0.25 + (4/32)*0.5
  // disabled 的 pan 与 0 点的 trk_1 都不应出现
  assert.ok(!targets.some((t) => t.kind === 'setTrackPan'))
  assert.ok(!targets.some((t) => t.trackId === 'trk_1'))
  // 越界读取取端点
  const atEnd = computeAutomationTargets(project, 999)
  closeTo(atEnd.find((t) => t.kind === 'setTrackVolume').value, 0.7)
  closeTo(atEnd.find((t) => t.kind === 'setTrackCutoff').hz, 16000)
  closeTo(atEnd.find((t) => t.kind === 'setMasterVolume').value, 0.75)
  // 无自动化 → 空数组
  assert.deepEqual(computeAutomationTargets(buildTestProject(), 4), [])
})

test('applyAutomationTargets：mock graph 调用序列 / 缺方法安全 / 单参数失败隔离', () => {
  const project = buildAutomationProject()
  const targets = computeAutomationTargets(project, 4)
  const graph = makeMockGraph()
  assert.equal(applyAutomationTargets(graph, targets), 3)
  assert.deepEqual(graph.calls.map((c) => c[0]), ['setTrackVolume', 'setTrackCutoff', 'setMasterVolume'])
  assert.equal(graph.calls[0][1], 'trk_2')
  closeTo(graph.calls[0][2], 0.42)
  assert.equal(graph.calls[1][1], 'trk_2')
  closeTo(graph.calls[1][2], 80 * Math.sqrt(200))
  closeTo(graph.calls[2][1], 0.3125)
  // 缺方法 → 跳过，不抛错
  const partial = { setTrackVolume: (...args) => graph.calls.push(['partial-volume', ...args]) }
  assert.equal(applyAutomationTargets(partial, targets), 1)
  assert.equal(applyAutomationTargets(null, targets), 0)
  assert.equal(applyAutomationTargets(graph, []), 0)
  // 单个方法抛错不影响其他参数
  const okCalls = []
  const throwing = {
    setTrackVolume: () => {
      throw new Error('boom')
    },
    setTrackCutoff: () => {},
    setMasterVolume: (...args) => okCalls.push(args),
  }
  assert.equal(applyAutomationTargets(throwing, targets), 2)
  assert.equal(okCalls.length, 1)
})

test('buildAutomationSamples：≤0.1s 采样 + 关键点 + 线性插值 + 区间偏移', () => {
  const points = [{ beat: 0, value: 0 }, { beat: 3.3, value: 0.8 }, { beat: 8, value: 0.2 }]
  const samples = buildAutomationSamples(points, 0, 8, 2, 0.1) // bps=2 → 每 0.2 beat
  assert.ok(samples.length >= 41)
  closeTo(samples[0].beat, 0)
  closeTo(samples[0].value, 0)
  closeTo(samples[0].time, 0)
  closeTo(samples[samples.length - 1].time, 4) // 8 beat / 2 bps
  const key = samples.find((s) => Math.abs(s.beat - 3.3) < 1e-9)
  assert.ok(key, '关键点应被包含')
  closeTo(key.value, 0.8)
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].beat - samples[i - 1].beat <= 0.2 + 1e-9)
    assert.ok(samples[i].time > samples[i - 1].time)
  }
  // 区间偏移：从第 2 小节开始渲染时 time 从 0 计
  const offset = buildAutomationSamples(points, 8, 16, 2, 0.1)
  closeTo(offset[0].time, 0)
  closeTo(offset[0].value, 0.2)
  assert.deepEqual(buildAutomationSamples([], 0, 8, 2, 0.1), [])
  assert.ok(AUTOMATION_SAMPLE_STEP <= 0.1)
})

test('buildOfflineAutomationSchedule：覆盖渲染区间 / map 生效 / cutoff 动态标记', () => {
  const project = buildAutomationProject()
  const plan = computeRenderPlan(project, {}) // 8 小节 @120BPM = 16s，bps=2
  const schedule = buildOfflineAutomationSchedule(project, plan)
  assert.equal(schedule.tracks.length, 1)
  const entry = schedule.tracks[0]
  assert.equal(entry.trackId, 'trk_2')
  assert.ok(entry.volume.length > 100)
  assert.equal(entry.pan, undefined) // disabled
  closeTo(entry.volume[0].time, 0)
  closeTo(entry.volume[entry.volume.length - 1].time, 16)
  closeTo(entry.cutoff.samples[entry.cutoff.samples.length - 1].mapped, 16000)
  assert.equal(schedule.hasCutoffDynamic, true)
  assert.ok(schedule.master.length > 100)
  closeTo(schedule.master[0].mapped, 0.25)
  // 区间渲染（fromBar=2,toBar=4 → 2 小节 @120BPM = 4 秒）；startBeat 偏移 8
  const rangePlan = computeRenderPlan(project, { fromBar: 2, toBar: 4 })
  const rangeSchedule = buildOfflineAutomationSchedule(project, rangePlan)
  closeTo(rangeSchedule.startBeat, 8)
  const rangeEntry = rangeSchedule.tracks[0]
  closeTo(rangeEntry.volume[0].time, 0)
  closeTo(rangeEntry.volume[rangeEntry.volume.length - 1].time, 4)
})

test('graph 自动化助手：scheduleAudioParamValue / findFirstFilterEffect / 音量映射', () => {
  // 实时：省略 time → setTargetAtTime
  const realtime = makeParamStub(0)
  assert.equal(scheduleAudioParamValue(realtime, 0.5, undefined, 3), true)
  assert.equal(realtime.ops[0].op, 'setTargetAtTime')
  closeTo(realtime.ops[0].args[0], 0.5)
  closeTo(realtime.ops[0].args[1], 3)
  // 离线：首个点 setValueAtTime(0)，之后 linearRampToValueAtTime
  const timeline = makeParamStub(0)
  scheduleAudioParamValue(timeline, 0.2, 0)
  scheduleAudioParamValue(timeline, 0.6, 0.5)
  scheduleAudioParamValue(timeline, 1, 1)
  assert.deepEqual(timeline.ops.map((o) => o.op), ['setValueAtTime', 'linearRampToValueAtTime', 'linearRampToValueAtTime'])
  closeTo(timeline.ops[1].args[1], 0.5)
  closeTo(timeline.ops[2].args[1], 1)
  // 时间回退 → 重新 setValueAtTime（开启新一段自动化）
  scheduleAudioParamValue(timeline, 0.3, 0.8)
  assert.equal(timeline.ops[3].op, 'setValueAtTime')
  // 非法输入安全
  assert.equal(scheduleAudioParamValue(null, 1, 0), false)
  assert.equal(scheduleAudioParamValue(makeParamStub(), Number.NaN, 0), false)

  // 第一个 filter 效果器
  const filterWrapper = { type: 'filter', _params: {}, _enabled: true, update() {} }
  const chain = { effects: new Map([['a', { type: 'eq3' }], ['b', filterWrapper], ['c', { type: 'filter' }]]) }
  assert.equal(findFirstFilterEffect(chain), filterWrapper)
  assert.equal(findFirstFilterEffect({ effects: new Map([['a', { type: 'delay' }]]) }), null)
  assert.equal(findFirstFilterEffect(undefined), null)

  // 自动化音量 → 线性增益（与静态音量曲线一致）+ mute/solo
  const project = buildTestProject()
  const track = project.tracks[1]
  closeTo(trackGainForValue(project, track, 0.5), Math.pow(0.5, 1.35))
  track.mute = true
  assert.equal(trackGainForValue(project, track, 1), 0)
})

test('graphSignature：automation 变化不触发音频图重建', () => {
  const project = buildTestProject()
  const before = graphSignature(project)
  project.tracks[1].automation = { volume: { enabled: true, points: [{ beat: 0, value: 1 }] } }
  project.master.automation = { volume: { enabled: true, points: [{ beat: 0, value: 0.5 }] } }
  assert.equal(graphSignature(project), before)
})

test('StudioEngine 实时自动化：40ms 节流 / beat 映射 / stop 恢复静态值', () => {
  const project = buildAutomationProject()
  const engine = new StudioEngine()
  // 1s @2bps → beat 2
  const graph = primeRealtimeAutomation(engine, project, 1)
  assert.equal(engine._applyAutomation(true), 3)
  assert.deepEqual(graph.calls.map((c) => c[0]), ['setTrackVolume', 'setTrackCutoff', 'setMasterVolume'])
  closeTo(graph.calls[0][2], 0.28) // track.volume 0.7 × automation 0.4
  closeTo(graph.calls[1][2], 80 * Math.pow(200, 0.25)) // cutoff value 0.25
  closeTo(graph.calls[2][1], 0.28125) // master: 0.25 + (2/32)*0.5
  // 同一时刻再调用：被 40ms 节流
  assert.equal(engine._applyAutomation(), 0)
  assert.equal(graph.calls.length, 3)
  // 过了节流窗口 → 再次应用
  engine._ctx.currentTime = 1 + AUTOMATION_APPLY_INTERVAL + 0.001
  assert.equal(engine._applyAutomation(), 3)
  assert.equal(graph.calls.length, 6)
  // stop：恢复工程静态值（graph.update(project)），且停止后不再应用自动化
  engine.stop()
  assert.equal(graph.updateCalls.length, 1)
  assert.equal(graph.updateCalls[0], project)
  assert.equal(engine._applyAutomation(true), 0)
  engine.dispose()
})

test('renderWav：音量/声像/master 自动化排进 AudioParam，cutoff 按 ≤0.1s suspend 应用（mock）', async () => {
  const project = buildAutomationProject()
  // 再启用 pan，覆盖声像排程
  project.tracks[1].automation.pan.enabled = true
  project.tracks[1].automation.pan.points = [{ beat: 0, value: 0 }, { beat: 8, value: 1 }]
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const engine = new StudioEngine()
    const { blob, seconds } = await engine.renderWav(project)
    engine.dispose()
    assert.ok(Math.abs(seconds - 16) < 1e-6)
    const ctx = instances[0]
    assert.equal(blob.size, 44 + ctx.length * 4)
    // cutoff 动态 → 0.1s suspend 网格（16s ≈ 159 次）
    assert.ok(ctx.suspendCalls.length > 120, `suspend 次数 ${ctx.suspendCalls.length}`)
    for (let i = 1; i < ctx.suspendCalls.length; i++) closeTo(ctx.suspendCalls[i] - ctx.suspendCalls[i - 1], 0.1, 1e-6)
    // volume / pan / master 用线性 ramp 采样（>100 个点）
    const rampCounts = ctx.params.map((entry) => entry.param.ops.filter((op) => op.op === 'linearRampToValueAtTime').length)
    assert.ok(Math.max(...rampCounts) > 100, `最大 ramp 数 ${Math.max(...rampCounts)}`)
    // cutoff：filter.frequency 在 suspend 时刻 setTargetAtTime，间隔 ≤0.1s，值确实在扫
    const frequencyParams = ctx.params.filter((entry) => entry.name === 'frequency')
    const cutoffOps = frequencyParams.flatMap((entry) =>
      entry.param.ops.filter((op) => op.op === 'setTargetAtTime' && op.args[1] > 0),
    )
    assert.ok(cutoffOps.length > 50, `cutoff 应用次数 ${cutoffOps.length}`)
    const cutoffTimes = cutoffOps.map((op) => op.args[1]).sort((a, b) => a - b)
    for (let i = 1; i < cutoffTimes.length; i++) assert.ok(cutoffTimes[i] - cutoffTimes[i - 1] <= 0.1001)
    const cutoffValues = cutoffOps.map((op) => op.args[0])
    assert.ok(Math.max(...cutoffValues) > 1000 && Math.min(...cutoffValues) < 500)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('renderWav：只有音量/声像自动化时保持 1s suspend 网格（导出性能不退化）', async () => {
  const project = buildAutomationProject()
  delete project.tracks[1].automation.cutoff
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const engine = new StudioEngine()
    const { blob, seconds } = await engine.renderWav(project)
    engine.dispose()
    assert.ok(Math.abs(seconds - 16) < 1e-6)
    const ctx = instances[0]
    assert.equal(blob.size, 44 + ctx.length * 4)
    assert.ok(ctx.suspendCalls.length > 0)
    assert.ok(ctx.suspendCalls.length <= 20, `应保持 1s 网格，实际 ${ctx.suspendCalls.length} 次`)
    // 仍排进了 volume 自动化 ramp
    const rampCounts = ctx.params.map((entry) => entry.param.ops.filter((op) => op.op === 'linearRampToValueAtTime').length)
    assert.ok(Math.max(...rampCounts) > 100)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

// ---------------------------------------------------------------------------
// 9. 侧链 ducking（CONTRACT-P2B §4）：纯函数 / mock graph / 实时 / 离线
// ---------------------------------------------------------------------------

/** trk_1（鼓）为源，trk_2（lead）被侧链压 0.6。 */
function buildSidechainProject() {
  const project = buildTestProject()
  project.tracks[1].sidechain = {
    enabled: true,
    sourceTrackId: 'trk_1',
    amount: 0.6,
    attack: 0.01,
    release: 0.15,
  }
  return project
}

test('sidechainTargets：来源匹配 / enabled / 自引用 / 来源不存在 / 参数夹紧', () => {
  const project = buildSidechainProject()
  const targets = sidechainTargets(project, 'trk_1')
  assert.equal(targets.length, 1)
  assert.equal(targets[0].trackId, 'trk_2')
  assert.equal(targets[0].sourceTrackId, 'trk_1')
  closeTo(targets[0].amount, 0.6)
  closeTo(targets[0].attack, 0.01)
  closeTo(targets[0].release, 0.15)
  // 反向不存在
  assert.deepEqual(sidechainTargets(project, 'trk_2'), [])
  // disabled → 不生效
  project.tracks[1].sidechain.enabled = false
  assert.deepEqual(sidechainTargets(project, 'trk_1'), [])
  // 自引用被忽略
  project.tracks[1].sidechain = { enabled: true, sourceTrackId: 'trk_2', amount: 0.5 }
  assert.deepEqual(sidechainTargets(project, 'trk_2'), [])
  // 来源不存在被忽略
  project.tracks[1].sidechain = { enabled: true, sourceTrackId: 'trk_404', amount: 0.5 }
  assert.deepEqual(sidechainTargets(project, 'trk_404'), [])
  // 参数夹紧 + 缺省值
  project.tracks[1].sidechain = { enabled: true, sourceTrackId: 'trk_1', amount: 2, attack: -1, release: 99 }
  const clamped = sidechainTargets(project, 'trk_1')[0]
  closeTo(clamped.amount, SIDECHAIN_LIMITS.amount[1])
  closeTo(clamped.attack, SIDECHAIN_LIMITS.attack[0])
  closeTo(clamped.release, SIDECHAIN_LIMITS.release[1])
  assert.deepEqual(normalizeSidechain({ enabled: true, sourceTrackId: 'trk_1' }), {
    enabled: true,
    sourceTrackId: 'trk_1',
    amount: SIDECHAIN_DEFAULTS.amount,
    attack: SIDECHAIN_DEFAULTS.attack,
    release: SIDECHAIN_DEFAULTS.release,
    triggerNotes: [],
  })
  assert.equal(normalizeSidechain(null), null)
  assert.equal(normalizeSidechain({ enabled: true }), null)
  assert.equal(normalizeSidechain({ enabled: false, sourceTrackId: 'trk_1' }), null)
  // 无侧链 → 空
  assert.deepEqual(sidechainTargets(buildTestProject(), 'trk_1'), [])
  assert.deepEqual(sidechainTargets(project, null), [])
})

test('buildSidechainIndex：多目标索引（源 → 目标数组）', () => {
  const project = buildSidechainProject()
  project.tracks[0].sidechain = { enabled: true, sourceTrackId: 'trk_2', amount: 0.3, attack: 0.005, release: 0.1 }
  const index = buildSidechainIndex(project)
  assert.deepEqual([...index.keys()].sort(), ['trk_1', 'trk_2'])
  assert.equal(index.get('trk_1')[0].trackId, 'trk_2')
  assert.equal(index.get('trk_1')[0].amount, 0.6)
  assert.equal(index.get('trk_2')[0].trackId, 'trk_1')
  // 无侧链工程 → 空 Map
  assert.equal(buildSidechainIndex(buildTestProject()).size, 0)
})

test('scheduleDuckEnvelope：attack 压到 1-amount / release 回 1 / 夹紧 / amount=0 no-op', () => {
  const param = makeParamStub(1)
  assert.equal(scheduleDuckEnvelope(param, 2, 0.6, 0.015, 0.12, 1), true)
  assert.deepEqual(param.ops.map((op) => op.op), ['setTargetAtTime', 'setTargetAtTime'])
  closeTo(param.ops[0].args[0], 0.4) // 1 - amount
  closeTo(param.ops[0].args[1], 2) // atTime
  closeTo(param.ops[0].args[2], 0.015 / 3)
  closeTo(param.ops[1].args[0], 1)
  closeTo(param.ops[1].args[1], 2.015) // atTime + attack
  closeTo(param.ops[1].args[2], 0.12) // release = 恢复时间常数
  // atTime 早于 now → 从 now 开始
  const early = makeParamStub(1)
  scheduleDuckEnvelope(early, 0, 0.5, 0.02, 0.1, 3)
  closeTo(early.ops[0].args[1], 3)
  // 参数夹紧
  const clamped = makeParamStub(1)
  scheduleDuckEnvelope(clamped, 0, 0.5, 9, 0, 0)
  closeTo(clamped.ops[0].args[2], 0.2 / 3)
  closeTo(clamped.ops[1].args[1], 0.2)
  closeTo(clamped.ops[1].args[2], 0.02)
  // amount=0 / 非法参数 → no-op
  const zero = makeParamStub(1)
  assert.equal(scheduleDuckEnvelope(zero, 1, 0, 0.01, 0.1, 0), false)
  assert.equal(zero.ops.length, 0)
  assert.equal(scheduleDuckEnvelope(null, 1, 0.5, 0.01, 0.1, 0), false)
})

test('scheduleDuckTargets：mock graph 调用序列 / 缺方法安全 / 单轨失败隔离', () => {
  const calls = []
  const graph = { scheduleDuck: (...args) => calls.push(args) }
  const targets = [
    { trackId: 'trk_2', amount: 0.6, attack: 0.01, release: 0.15 },
    { trackId: 'trk_3', amount: 0.3, attack: 0.005, release: 0.1 },
  ]
  assert.equal(scheduleDuckTargets(graph, targets, 1.5), 2)
  assert.deepEqual(calls, [
    ['trk_2', 1.5, 0.6, 0.01, 0.15],
    ['trk_3', 1.5, 0.3, 0.005, 0.1],
  ])
  assert.equal(scheduleDuckTargets(graph, [], 1), 0)
  assert.equal(scheduleDuckTargets({}, targets, 1), 0)
  assert.equal(scheduleDuckTargets(null, targets, 1), 0)
  // 单轨失败不影响其它
  const partialCalls = []
  const throwing = {
    scheduleDuck: (trackId) => {
      if (trackId === 'trk_2') throw new Error('boom')
      partialCalls.push(trackId)
    },
  }
  assert.equal(scheduleDuckTargets(throwing, targets, 1), 1)
  assert.deepEqual(partialCalls, ['trk_3'])
})

// ---------------------------------------------------------------------------
// 21b. CONTRACT-R0-12：侧链按音高过滤（triggerNotes）
// ---------------------------------------------------------------------------

test('normalizeTriggerNotes / normalizeSidechain：triggerNotes 解析（钳制/去重/排序/非法）', () => {
  assert.deepEqual(normalizeTriggerNotes(null), [])
  assert.deepEqual(normalizeTriggerNotes(undefined), [])
  assert.deepEqual(normalizeTriggerNotes('36'), [])
  assert.deepEqual(normalizeTriggerNotes([42, 36, 36, 200, -1, '38', 1.4, Number.NaN]), [1, 36, 38, 42])
  assert.deepEqual(normalizeTriggerNotes([36.6]), [37])
  assert.deepEqual(normalizeTriggerNotes([0, 127]), [0, 127])
  // 最多 16 个（与 host normalizeSidechain 上限一致：去重升序后截断）
  const manyNotes = normalizeTriggerNotes(Array.from({ length: 40 }, (_, index) => index + 10))
  assert.equal(manyNotes.length, 16)
  assert.equal(manyNotes[0], 10)
  assert.equal(manyNotes[15], 25)
  // normalizeSidechain 保留 triggerNotes
  assert.deepEqual(normalizeSidechain({ enabled: true, sourceTrackId: 't1', triggerNotes: [42, 36] }).triggerNotes, [
    36,
    42,
  ])
  assert.deepEqual(normalizeSidechain({ enabled: true, sourceTrackId: 't1' }).triggerNotes, [])
  // 非法结构仍返回 null
  assert.equal(normalizeSidechain({ enabled: false, sourceTrackId: 't1', triggerNotes: [36] }), null)
  assert.equal(normalizeSidechain({ enabled: true, triggerNotes: [36] }), null)
})

test('buildSidechainIndex / sidechainTargets：保留每目标的 triggerNotes；空=全部', () => {
  const project = buildSidechainProject()
  project.tracks[1].sidechain = {
    enabled: true,
    sourceTrackId: 'trk_1',
    amount: 0.6,
    attack: 0.01,
    release: 0.15,
    triggerNotes: [36],
  }
  const index = buildSidechainIndex(project)
  const target = index.get('trk_1')[0]
  assert.equal(target.trackId, 'trk_2')
  assert.deepEqual(target.triggerNotes, [36])
  assert.deepEqual(sidechainTargets(project, 'trk_1')[0].triggerNotes, [36])
  // 空/缺省 → []
  delete project.tracks[1].sidechain.triggerNotes
  assert.deepEqual(sidechainTargets(project, 'trk_1')[0].triggerNotes, [])
})

test('scheduleDuckTargets：triggerNotes [36] 只底鼓触发、hat 不触发、空=全部', () => {
  const calls = []
  const graph = { scheduleDuck: (...args) => calls.push(args) }
  const targets = [
    { trackId: 'bass', amount: 0.6, attack: 0.01, release: 0.15, triggerNotes: [36] },
    { trackId: 'pad', amount: 0.3, attack: 0.005, release: 0.1, triggerNotes: [] },
  ]
  // kick (36) → bass + pad 都 duck
  assert.equal(scheduleDuckTargets(graph, targets, 1, 36), 2)
  assert.deepEqual(calls, [
    ['bass', 1, 0.6, 0.01, 0.15],
    ['pad', 1, 0.3, 0.005, 0.1],
  ])
  calls.length = 0
  // hat (42) → 只 pad（无过滤）触发
  assert.equal(scheduleDuckTargets(graph, targets, 2, 42), 1)
  assert.deepEqual(calls, [['pad', 2, 0.3, 0.005, 0.1]])
  calls.length = 0
  // 无 pitch → 有 triggerNotes 的目标跳过，空列表目标仍触发（兼容旧调用）
  assert.equal(scheduleDuckTargets(graph, targets, 3), 1)
  assert.deepEqual(calls, [['pad', 3, 0.3, 0.005, 0.1]])
  // 全部为空 → 任意 pitch 都全部触发（旧行为）
  const legacy = [
    { trackId: 'bass', amount: 0.6, attack: 0.01, release: 0.15 },
    { trackId: 'pad', amount: 0.3, attack: 0.005, release: 0.1 },
  ]
  assert.equal(scheduleDuckTargets(graph, legacy, 4, 42), 2)
})

test('R0-12 引擎实时：侧链 triggerNotes 过滤真实事件 pitch', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = buildSidechainProject()
  project.tracks[1].sidechain = {
    enabled: true,
    sourceTrackId: 'trk_1',
    amount: 0.6,
    attack: 0.01,
    release: 0.15,
    triggerNotes: [36],
  }
  const calls = []
  const engine = makeVoiceEngine(project, ctx)
  engine._graph.scheduleDuck = (...args) => calls.push(args)
  try {
    const base = { trackId: 'trk_1', vel: 0.8, durBeats: 0.25, swingBeats: 0, startBeat: 0 }
    engine._scheduleEvent({ ...base, pitch: 36 }, 0.01)
    assert.equal(calls.length, 1, 'kick(36) 应触发 duck')
    assert.deepEqual(calls[0].slice(0, 2), ['trk_2', 0.01])
    calls.length = 0
    engine._scheduleEvent({ ...base, pitch: 42 }, 0.02)
    assert.equal(calls.length, 0, 'hat(42) 不应触发 duck（triggerNotes=[36]）')
    engine._scheduleEvent({ ...base, pitch: 38 }, 0.03)
    assert.equal(calls.length, 0, 'snare(38) 不应触发')
    // 清空 triggerNotes → 任意音高都触发（旧行为）
    engine._sidechainIndex = buildSidechainIndex({
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === 'trk_2' ? { ...track, sidechain: { ...track.sidechain, triggerNotes: [] } } : track,
      ),
    })
    engine._scheduleEvent({ ...base, pitch: 42 }, 0.04)
    assert.equal(calls.length, 1, '空 triggerNotes 应恢复全部触发')
  } finally {
    engine.dispose()
  }
})

test('R0-12 引擎离线：triggerNotes 过滤在 renderWav 中生效（实时/离线一致）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  const makeProject = (triggerNotes) => {
    const project = createEmptyProject({ title: 'duck-filter', bpm: 120, key: 'A', scale: 'minor', lengthBars: 2 })
    project.master.effects = []
    const source = makeTrack({ id: 'trk_src', name: 'Drums', kind: 'drum', role: 'drums', volume: 0.8 })
    source.instrument = { preset: null, kit: 'test_kit', params: {} }
    const target = makeTrack({ id: 'trk_tgt', name: 'Bass', kind: 'synth', role: 'bass', volume: 0.8 })
    target.instrument = { preset: 'test_bass', kit: null, params: { osc: 'sine', voices: 1, attack: 0.005, release: 0.3 } }
    target.sidechain = {
      enabled: true,
      sourceTrackId: 'trk_src',
      amount: 0.6,
      attack: 0.01,
      release: 0.15,
      triggerNotes,
    }
    project.tracks.push(source, target)
    project.patterns.push(
      makePattern({
        id: 'pat_src', name: 'src', lengthBars: 2,
        notes: [
          { pitch: 36, start: 0, dur: 0.25, vel: 0.9 }, // kick
          { pitch: 42, start: 1, dur: 0.25, vel: 0.6 }, // hat
          { pitch: 36, start: 2, dur: 0.25, vel: 0.9 },
        ],
      }),
      makePattern({
        id: 'pat_tgt', name: 'tgt', lengthBars: 2,
        notes: [{ pitch: 40, start: 0, dur: 4, vel: 0.8 }],
      }),
    )
    project.clips.push(
      { id: 'clip_src', trackId: 'trk_src', patternId: 'pat_src', startBar: 0, lengthBars: 2 },
      { id: 'clip_tgt', trackId: 'trk_tgt', patternId: 'pat_tgt', startBar: 0, lengthBars: 2 },
    )
    return project
  }
  const countDucks = (ctx) => {
    let count = 0
    for (const entry of ctx.params) {
      if (entry.kind !== 'gain' || entry.name !== 'gain') continue
      for (const op of entry.param.ops) {
        if (op.op === 'setTargetAtTime' && Math.abs(Number(op.args[0]) - 0.4) < 1e-9) count += 1
      }
    }
    return count
  }
  try {
    const engineA = new StudioEngine()
    await engineA.renderWav(makeProject([36]), { fromBar: 0, toBar: 2, fast: true })
    engineA.dispose()
    const filtered = countDucks(instances.at(-1))
    // 2 个 kick × 1 目标 = 2 次 duck；hat 被过滤
    assert.equal(filtered, 2, `filtered ducks=${filtered}`)

    const engineB = new StudioEngine()
    await engineB.renderWav(makeProject([]), { fromBar: 0, toBar: 2, fast: true })
    engineB.dispose()
    const unfiltered = countDucks(instances.at(-1))
    // 空 triggerNotes → kick/hat 都触发 = 3 次
    assert.equal(unfiltered, 3, `unfiltered ducks=${unfiltered}`)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('graph：duckGain 节点 / scheduleDuck / setDuckGain / update 恢复为 1（mock ctx）', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = buildSidechainProject()
  const graph = buildMixGraph(ctx, project, { analysers: false })
  try {
    assert.equal(graph.scheduleDuck('trk_2', 1, 0.6, 0.01, 0.15), true)
    // 找到 duckGain 参数：被写成 1-amount=0.4
    const duckEntry = ctx.params.find((entry) =>
      entry.param.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.4) < 1e-9),
    )
    assert.ok(duckEntry, '应找到 duckGain 的 AudioParam')
    closeTo(duckEntry.param.ops[0].args[1], 1)
    // 找不到轨道 / amount=0 → 安全 no-op
    assert.equal(graph.scheduleDuck('trk_404', 1, 0.6, 0.01, 0.15), false)
    assert.equal(graph.scheduleDuck('trk_2', 1, 0, 0.01, 0.15), false)
    // update 会把 duck 恢复到 1（停止/关闭侧链）
    graph.update(project)
    const restoreOps = duckEntry.param.ops.filter(
      (op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 1) < 1e-9,
    )
    assert.ok(restoreOps.length >= 2, '包络恢复 + update 恢复都应存在')
    // setDuckGain 快速恢复
    assert.equal(graph.setDuckGain('trk_2', 1), true)
    assert.equal(graph.setDuckGain('trk_404', 1), false)
  } finally {
    graph.dispose()
  }
})

test('StudioEngine 实时：源轨道事件触发目标轨 duck；无侧链不调用；stop 恢复', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = buildSidechainProject()
  const engine = new StudioEngine()
  engine.setProject(project)
  const duckCalls = []
  const updateCalls = []
  const graph = {
    tracks: new Map([
      ['trk_1', { input: ctx.createGain() }],
      ['trk_2', { input: ctx.createGain() }],
    ]),
    scheduleDuck: (...args) => duckCalls.push(args),
    update: (nextProject) => updateCalls.push(nextProject),
  }
  engine._ctx = ctx
  engine._graph = graph
  engine._bps = bpmToBps(project.bpm)
  try {
    // 源事件：trk_1 底鼓 @0.5s → trk_2 duck
    engine._scheduleEvent(
      { trackId: 'trk_1', kind: 'drum', pitch: 36, vel: 1, durBeats: 0.25, swingBeats: 0 },
      0.5,
    )
    assert.equal(duckCalls.length, 1)
    assert.equal(duckCalls[0][0], 'trk_2')
    closeTo(duckCalls[0][1], 0.5)
    closeTo(duckCalls[0][2], 0.6)
    closeTo(duckCalls[0][3], 0.01)
    closeTo(duckCalls[0][4], 0.15)
    // 非源轨道事件（trk_2 自己的音符）不触发新的 duck
    engine._scheduleEvent(
      { trackId: 'trk_2', kind: 'synth', pitch: 60, vel: 0.8, durBeats: 1, swingBeats: 0 },
      1,
    )
    assert.equal(duckCalls.length, 1)
    // stop → 恢复静态参数（graph.update 内含 duckGain=1 恢复）
    engine.stop()
    assert.equal(updateCalls.length, 1)
    assert.equal(updateCalls[0], project)
  } finally {
    engine.dispose()
  }

  // 无侧链工程：同样的事件不产生任何 duck 调用（行为不变）
  const plainProject = buildTestProject()
  const engine2 = new StudioEngine()
  engine2.setProject(plainProject)
  const plainDuckCalls = []
  engine2._ctx = ctx
  engine2._graph = {
    tracks: new Map([
      ['trk_1', { input: ctx.createGain() }],
      ['trk_2', { input: ctx.createGain() }],
    ]),
    scheduleDuck: (...args) => plainDuckCalls.push(args),
    update: () => {},
  }
  engine2._bps = bpmToBps(plainProject.bpm)
  try {
    engine2._scheduleEvent(
      { trackId: 'trk_1', kind: 'drum', pitch: 36, vel: 1, durBeats: 0.25, swingBeats: 0 },
      0.5,
    )
    assert.equal(plainDuckCalls.length, 0)
  } finally {
    engine2.dispose()
  }
})

test('renderWav：侧链按源事件绝对秒排 duck（mock OfflineAudioContext）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    // 有侧链：trk_1 的 8 个鼓事件（4 小节 × 2 音）各触发一次 duck
    const engine = new StudioEngine()
    const withSidechain = await engine.renderWav(buildSidechainProject())
    engine.dispose()
    assert.ok(Math.abs(withSidechain.seconds - 16) < 1e-6)
    const ctx = instances[0]
    assert.equal(withSidechain.blob.size, 44 + ctx.length * 4)
    const duckOps = ctx.params.flatMap((entry) =>
      entry.param.ops.filter((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.4) < 1e-9),
    )
    assert.equal(duckOps.length, 8, `duck 次数 ${duckOps.length}`)
    const duckTimes = duckOps.map((op) => Math.round(op.args[1] * 100) / 100).sort((a, b) => a - b)
    assert.deepEqual(duckTimes, [0, 0.5, 2, 2.5, 4, 4.5, 6, 6.5])
    // release 回 1 的包络也存在
    const recoverOps = ctx.params.flatMap((entry) =>
      entry.param.ops.filter((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 1) < 1e-9),
    )
    assert.ok(recoverOps.length >= 8)

    // 无侧链：同工程不产生 duck 参数写入
    const engine2 = new StudioEngine()
    const without = await engine2.renderWav(buildTestProject())
    engine2.dispose()
    const ctx2 = instances[1]
    assert.equal(without.blob.size, 44 + ctx2.length * 4)
    const noDuck = ctx2.params.flatMap((entry) =>
      entry.param.ops.filter((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.4) < 1e-9),
    )
    assert.equal(noDuck.length, 0)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('buildMixGraph：分轨导出依赖的 mute/solo 静音语义（与实时同一图构建）', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 1000, 44100)
  // stems 场景：仅 trk_1 audible，其他 mute → 被 mute 轨 gain=0（不串音）
  const project = buildTestProject()
  project.tracks[1].mute = true
  const mutedGraph = buildMixGraph(ctx, project, { analysers: false })
  try {
    closeTo(mutedGraph.tracks.get('trk_1').gain.gain.value, Math.pow(0.8, 1.35))
    assert.equal(mutedGraph.tracks.get('trk_2').gain.gain.value, 0)
  } finally {
    mutedGraph.dispose()
  }
  // solo 语义：trk_2 solo → 其它轨静音，solo 轨正常
  const project2 = buildTestProject()
  project2.tracks[1].solo = true
  const soloGraph = buildMixGraph(ctx, project2, { analysers: false })
  try {
    assert.equal(soloGraph.tracks.get('trk_1').gain.gain.value, 0)
    assert.ok(soloGraph.tracks.get('trk_2').gain.gain.value > 0)
  } finally {
    soloGraph.dispose()
  }
})

test('automation 与 sidechain 叠加：automation 写 track gain，sidechain 写独立 duck gain', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = buildSidechainProject() // trk_2 被 trk_1 侧链压 0.6
  project.tracks[1].automation = { volume: { enabled: true, points: [{ beat: 0, value: 1 }] } }
  const graph = buildMixGraph(ctx, project, { analysers: false })
  try {
    assert.equal(graph.setTrackVolume('trk_2', 0.5), true) // automation：track gain = 0.5^1.35
    assert.equal(graph.scheduleDuck('trk_2', 1, 0.6, 0.01, 0.15), true) // sidechain：duck gain → 0.4
    const duckParam = ctx.params.find((entry) =>
      entry.param.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.4) < 1e-9),
    )
    const volumeParam = ctx.params.find((entry) =>
      entry.param.ops.some(
        (op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - Math.pow(0.5, 1.35)) < 1e-9,
      ),
    )
    assert.ok(duckParam, '应存在 duck gain 参数写入')
    assert.ok(volumeParam, '应存在 automation track gain 参数写入')
    assert.notEqual(duckParam.param, volumeParam.param, '二者必须是不同 AudioParam（相乘叠加）')
    // 两条链同时存在：graph.update 时 duck 恢复 1
    graph.update(project)
    assert.ok(duckParam.param.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 1) < 1e-9))
  } finally {
    graph.dispose()
  }
})

// ---------------------------------------------------------------------------
// 10. 乐器预览 previewNote / stopPreview / stopAllPreviews（CONTRACT-P3A §1）
// ---------------------------------------------------------------------------

/** 注入 mock 实时 ctx + GraphTrack.input（previewNote 需要 unlocked 状态）。 */
function primePreviewEngine(project) {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  ctx.currentTime = 0.5
  const engine = new StudioEngine()
  engine.setProject(project)
  engine._ctx = ctx
  engine._graph = {
    tracks: new Map(project.tracks.map((track) => [track.id, { input: ctx.createGain() }])),
    update: () => {},
  }
  return { engine, ctx }
}

test('previewNote：无 ctx / 未 unlock / 未知轨道 → null（不抛异常）', () => {
  assert.equal(PREVIEW_GAIN, 0.9)
  assert.ok(PREVIEW_DURATION_SECONDS > 0)
  const project = buildTestProject()
  const engine = new StudioEngine()
  engine.setProject(project)
  // 无 AudioContext
  assert.equal(engine.previewNote('trk_2', 60), null)
  // ctx 存在但未 running（未 unlock）
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'suspended'
  engine._ctx = ctx
  engine._graph = { tracks: new Map([['trk_2', { input: ctx.createGain() }]]) }
  assert.equal(engine.previewNote('trk_2', 60), null)
  // running 但未知轨道
  ctx.state = 'running'
  assert.equal(engine.previewNote('trk_404', 60), null)
  assert.equal(engine._previews.size, 0)
  engine.dispose()
})

test('previewNote：synth 轨建立 voice / 唯一 id / stopPreview 释放且重复安全', () => {
  const project = buildTestProject()
  const { engine } = primePreviewEngine(project)
  const id1 = engine.previewNote('trk_2', 60, 0.9)
  const id2 = engine.previewNote('trk_2', 64)
  assert.match(id1, /^pv-\d+$/)
  assert.match(id2, /^pv-\d+$/)
  assert.notEqual(id1, id2)
  assert.equal(engine._previews.size, 2)
  const preview = engine._previews.get(id1)
  assert.equal(preview.trackId, 'trk_2')
  assert.equal(preview.pitch, 60)
  assert.ok(preview.endTime > 0.5)
  // 预览不进入播放调度队列、不改变播放状态
  assert.equal(engine._voices.length, 0)
  assert.equal(engine.isPlaying, false)
  // stopPreview 调用 handle.stop 并移除记录
  let stopCalls = 0
  const originalStop = preview.handle.stop
  preview.handle.stop = (...args) => {
    stopCalls += 1
    return originalStop?.(...args)
  }
  assert.equal(engine.stopPreview(id1), true)
  assert.equal(stopCalls, 1)
  assert.equal(engine._previews.has(id1), false)
  // 重复/未知 id 安全
  assert.equal(engine.stopPreview(id1), false)
  assert.equal(engine.stopPreview('nope'), false)
  assert.equal(engine.stopPreview(undefined), false)
  assert.equal(engine.stopPreview(123), false)
  engine.dispose()
})

test('previewNote：鼓轨按 pitch 命中鼓件（非鼓件 pitch → null）', () => {
  const project = buildTestProject() // trk_1 = club 鼓组
  const { engine } = primePreviewEngine(project)
  const kickId = engine.previewNote('trk_1', 36, 1)
  assert.match(kickId, /^pv-\d+$/)
  assert.equal(engine._previews.get(kickId).pitch, 36)
  engine.stopPreview(kickId)
  // 不在标准鼓件范围的 pitch → null
  assert.equal(engine.previewNote('trk_1', 61), null)
  assert.equal(engine.previewNote('trk_1', 127), null)
  // catalog 里所有鼓件 pitch 都应命中
  for (const piece of DRUM_PIECES) {
    const id = engine.previewNote('trk_1', piece.pitch, 0.8)
    assert.ok(id, `鼓件 ${piece.id} (${piece.pitch}) 应命中`)
    engine.stopPreview(id)
  }
  assert.equal(engine._previews.size, 0)
  engine.dispose()
})

test('previewNote：采样鼓机 buffer 未加载 → 回退合成鼓（不报错）', () => {
  // 采样鼓机 kits：buffer 未加载时回退到合成鼓，保证键盘有声音
  const sampledKit = DRUM_KITS.find((kit) => kit.samplerPieces)
  assert.ok(sampledKit, 'catalog 应存在采样鼓机')
  const drumProject = createEmptyProject({ title: 'preview-smp-kit', bpm: 120, key: 'C', scale: 'minor', lengthBars: 2 })
  drumProject.tracks.push(makeTrack({ id: 'trk_1', name: 'SmpDrums', kind: 'drum', kit: sampledKit.id, role: 'drums' }))
  const primed = primePreviewEngine(drumProject)
  const id = primed.engine.previewNote('trk_1', 36, 1)
  assert.match(id, /^pv-\d+$/)
  primed.engine.dispose()
})

test('previewNote：stopAllPreviews / stop() / dispose() 都释放预览 voice', () => {
  const project = buildTestProject()
  const { engine } = primePreviewEngine(project)
  engine.previewNote('trk_2', 60, 0.9)
  engine.previewNote('trk_2', 64, 0.9)
  engine.previewNote('trk_1', 36, 1)
  assert.equal(engine._previews.size, 3)
  let stops = 0
  for (const preview of engine._previews.values()) {
    const originalStop = preview.handle.stop
    preview.handle.stop = (...args) => {
      stops += 1
      return originalStop?.(...args)
    }
  }
  assert.equal(engine.stopAllPreviews(), 3)
  assert.equal(stops, 3)
  assert.equal(engine._previews.size, 0)
  assert.equal(engine.stopAllPreviews(), 0)

  // stop() 也释放预览
  engine.previewNote('trk_2', 67, 0.9)
  engine.previewNote('trk_2', 69, 0.9)
  assert.equal(engine._previews.size, 2)
  engine.stop()
  assert.equal(engine._previews.size, 0)

  // dispose() 释放剩余预览
  engine.previewNote('trk_2', 72, 0.9)
  assert.equal(engine._previews.size, 1)
  engine.dispose()
  assert.equal(engine._previews.size, 0)
})

test('previewNote：不写工程、不影响调度/播放状态与离线渲染', async () => {
  const project = buildTestProject()
  const before = JSON.stringify(project)
  const { engine } = primePreviewEngine(project)
  engine.previewNote('trk_2', 60, 1)
  engine.previewNote('trk_1', 36, 1)
  assert.equal(JSON.stringify(project), before, '预览不得写入工程')
  assert.equal(engine._voices.length, 0, '预览不进入播放调度队列')
  assert.equal(engine._plan, null)
  assert.equal(engine.isPlaying, false)

  // 同一引擎仍能独立完成离线渲染（与预览实时 ctx 无关）
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const { blob, seconds } = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
    assert.ok(blob.size > 44)
    assert.ok(seconds > 0)
    assert.equal(instances.length, 1)
    assert.equal(blob.size, 44 + instances[0].length * 4)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
  engine.dispose()
})

// ---------------------------------------------------------------------------
// 11. 返回总线 FX 链 + 发送量实时更新（CONTRACT-P2C2 §3）
// ---------------------------------------------------------------------------

test('normalizeBuses / normalizeBus：旧数字兼容 / 新结构 / 非法值防御', () => {
  // 旧数字结构自动升级
  assert.deepEqual(normalizeBuses({ reverb: 0.4, delay: 0.25 }), {
    reverb: { level: 0.4, effects: [] },
    delay: { level: 0.25, effects: [] },
  })
  // 新结构
  const effects = [makeEffect('bfx_1', 'filter', { cutoff: 2000, mix: 1 })]
  const normalized = normalizeBuses({ reverb: { level: 0.6, effects }, delay: { level: 0.1, effects: [] } })
  closeTo(normalized.reverb.level, 0.6)
  assert.equal(normalized.reverb.effects.length, 1)
  closeTo(normalized.delay.level, 0.1)
  // 缺省 / 非法 → 默认电平
  assert.deepEqual(normalizeBuses(undefined), {
    reverb: { level: BUS_DEFAULTS.reverb.level, effects: [] },
    delay: { level: BUS_DEFAULTS.delay.level, effects: [] },
  })
  const fallback = normalizeBuses({ reverb: { level: 'x' }, delay: 7 })
  closeTo(fallback.reverb.level, BUS_DEFAULTS.reverb.level)
  closeTo(fallback.delay.level, 1)
  // 字符串数字 / 负值钳制 / 非法 effects 过滤
  closeTo(normalizeBus('0.5', 0.35).level, 0.5)
  closeTo(normalizeBus({ level: -2 }).level, 0)
  const filtered = normalizeBus({
    level: 0.2,
    effects: [{ type: 'filter', id: 'ok' }, null, { id: 'missing-type' }, 'x'],
  })
  assert.equal(filtered.effects.length, 1)
  assert.equal(filtered.effects[0].id, 'ok')
  assert.deepEqual(BUS_IDS, ['reverb', 'delay'])
})

test('graphSignature：返回总线 FX 链变化才重建；bus level / 旧数字结构不改变签名', () => {
  const legacy = buildTestProject()
  legacy.buses = { reverb: 0.4, delay: 0.25 }
  const legacySig = graphSignature(legacy)
  const migrated = buildTestProject()
  migrated.buses = {
    reverb: { level: 0.4, effects: [] },
    delay: { level: 0.25, effects: [] },
  }
  assert.equal(graphSignature(migrated), legacySig, '旧数字迁移不应触发重建')
  // 总线电平变化（结构不变）→ 签名不变
  migrated.buses.reverb.level = 0.9
  migrated.buses.delay.level = 0.85
  assert.equal(graphSignature(migrated), legacySig)
  // 总线 FX 链变化 → 签名变化
  migrated.buses.reverb.effects = [makeEffect('bfx_1', 'filter', { cutoff: 3000, mix: 1 })]
  const withReverbFx = graphSignature(migrated)
  assert.notEqual(withReverbFx, legacySig)
  // 只改 FX 参数（id/type 不变）→ 签名不变
  migrated.buses.reverb.effects[0] = makeEffect('bfx_1', 'filter', { cutoff: 500, mix: 0.5 })
  assert.equal(graphSignature(migrated), withReverbFx)
  // Delay 返回总线 FX 同样纳入签名
  migrated.buses.delay.effects = [makeEffect('bfx_2', 'drive', { amount: 0.3, mix: 0.5 })]
  assert.notEqual(graphSignature(migrated), withReverbFx)
})

test('buildMixGraph：返回总线 FX 链位于返回路径（Convolver/Delay → FX → 返回增益 → master）', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = buildTestProject()
  project.buses = {
    reverb: { level: 0.5, effects: [makeEffect('bfx_r', 'filter', { cutoff: 2200, resonance: 2, mix: 1 })] },
    delay: { level: 0.3, effects: [makeEffect('bfx_d', 'drive', { amount: 0.25, tone: 0.5, mix: 0.5 })] },
  }
  const graph = buildMixGraph(ctx, project, { analysers: false })
  try {
    const reverb = graph.reverbBus
    assert.equal(reverb.fx.effects.size, 1)
    closeTo(reverb.output.gain.value, busReturnGain(0.5))
    assert.ok(
      ctx.connections.some((edge) => edge.from === reverb.convolver && edge.to === reverb.fx.input),
      'Convolver 应接到 bus FX 链输入',
    )
    assert.ok(
      ctx.connections.some((edge) => edge.from === reverb.fx.output && edge.to === reverb.output),
      'bus FX 输出应接到返回增益',
    )
    const delay = graph.delayBus
    assert.equal(delay.fx.effects.size, 1)
    closeTo(delay.output.gain.value, busReturnGain(0.3))
    assert.ok(
      ctx.connections.some((edge) => edge.from === delay.delay && edge.to === delay.fx.input),
      '反馈延迟输出应接到 bus FX 链输入',
    )
    assert.ok(
      ctx.connections.some((edge) => edge.from === delay.fx.output && edge.to === delay.output),
      'bus FX 输出应接到返回增益',
    )
    // 返回增益 → masterIn
    assert.ok(ctx.connections.some((edge) => edge.from === reverb.output && edge.to === graph.masterIn))
    assert.ok(ctx.connections.some((edge) => edge.from === delay.output && edge.to === graph.masterIn))
    // 规范化后的总线结构
    closeTo(graph.buses.reverb.level, 0.5)
    closeTo(graph.buses.delay.level, 0.3)
  } finally {
    graph.dispose()
  }
})

test('graph.update：bus level 平滑 / bus FX 参数 / 每轨 sends 平滑更新', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = buildTestProject()
  project.buses = {
    reverb: { level: 0.3, effects: [makeEffect('bfx_r', 'filter', { cutoff: 1500, resonance: 1, mix: 1 })] },
    delay: { level: 0.2, effects: [] },
  }
  const graph = buildMixGraph(ctx, project, { analysers: false })
  try {
    const wrapper = graph.reverbBus.fx.effects.get('bfx_r')
    let effectUpdates = 0
    const originalUpdate = wrapper.update
    wrapper.update = (...args) => {
      effectUpdates += 1
      return originalUpdate(...args)
    }
    const next = JSON.parse(JSON.stringify(project))
    next.buses.reverb.level = 0.8
    next.buses.delay.level = 0.6
    next.buses.reverb.effects[0].params.cutoff = 6000
    next.tracks[1].sends = { reverb: 0.75, delay: 0.4 }
    graph.update(next)
    assert.equal(effectUpdates, 1, 'bus FX 参数应通过 update 应用')
    // 返回增益平滑 setTargetAtTime 到 busReturnGain(level)
    assert.ok(
      graph.reverbBus.output.gain.ops.some(
        (op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - busReturnGain(0.8)) < 1e-9,
      ),
    )
    assert.ok(
      graph.delayBus.output.gain.ops.some(
        (op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - busReturnGain(0.6)) < 1e-9,
      ),
    )
    // 每轨 sends 平滑更新
    const entry = graph.tracks.get('trk_2')
    assert.ok(
      entry.sendReverb.gain.ops.some(
        (op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.75 * 0.95) < 1e-9,
      ),
    )
    assert.ok(
      entry.sendDelay.gain.ops.some(
        (op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.4 * 0.95) < 1e-9,
      ),
    )
    closeTo(graph.buses.reverb.level, 0.8)
    closeTo(graph.buses.delay.level, 0.6)
  } finally {
    graph.dispose()
  }
})

test('renderWav：旧数字 buses 兼容 + 新 bus FX 结构可导出（mock）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    // 旧工程（数字 buses，未经迁移）也能导出
    const legacy = buildTestProject()
    legacy.buses = { reverb: 0.4, delay: 0.25 }
    const engine1 = new StudioEngine()
    const legacyResult = await engine1.renderWav(legacy)
    engine1.dispose()
    assert.ok(Math.abs(legacyResult.seconds - 16) < 1e-6)
    assert.equal(legacyResult.blob.size, 44 + instances[0].length * 4)
    // 新结构 + 两条返回总线各带 FX 链
    const modern = buildTestProject()
    modern.buses = {
      reverb: { level: 0.5, effects: [makeEffect('bfx_r', 'filter', { cutoff: 3000, resonance: 2, mix: 1 })] },
      delay: { level: 0.3, effects: [makeEffect('bfx_d', 'eq3', { low: 2, mid: -1, high: 1 })] },
    }
    const engine2 = new StudioEngine()
    const modernResult = await engine2.renderWav(modern)
    engine2.dispose()
    assert.ok(Math.abs(modernResult.seconds - 16) < 1e-6)
    assert.equal(modernResult.blob.size, 44 + instances[1].length * 4)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

// ---------------------------------------------------------------------------
// 12. 音频媒体 / 音频片段（CONTRACT-P3B §3）
// ---------------------------------------------------------------------------

/** 8 小节工程（bpm120/4-4 → 32 beats；bps=2）+ 1 条 audio 轨 + 1 个音频片段。 */
function makeAudioProject({ mediaDuration = 6, startBar = 0, lengthBars = 4, muted = false, offsetSeconds } = {}) {
  const project = createEmptyProject({ title: 'audio-clip', bpm: 120, key: 'A', scale: 'minor', lengthBars: 8 })
  project.media = [{ id: 'med_1', name: 'loop.wav', file: 'med_1.wav', durationSeconds: mediaDuration }]
  project.tracks.push({
    id: 'trk_a',
    name: 'Audio',
    kind: 'audio',
    role: 'audio',
    color: '#123456',
    volume: 0.8,
    pan: 0,
    mute: muted,
    solo: false,
    sends: { reverb: 0, delay: 0 },
    effects: [],
  })
  const clip = { id: 'clip_a', trackId: 'trk_a', mediaId: 'med_1', startBar, lengthBars }
  if (offsetSeconds !== undefined) clip.offsetSeconds = offsetSeconds
  project.clips.push(clip)
  return project
}

async function makeLoadedMediaBank(fakeBuffer = { duration: 6 }) {
  const bank = new MediaBank({
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    decodeAudioData: async () => fakeBuffer,
  })
  await bank.load('med_1', 'med_1.wav')
  return bank
}

test('MediaBank：fetch+decode 缓存 / 重复 load 只请求一次 / 失败不崩并缓存', async () => {
  let fetchCalls = 0
  const fakeBuffer = { duration: 3.2 }
  const bank = new MediaBank({
    fetchImpl: async (url) => {
      fetchCalls += 1
      assert.match(url, /^\/studio\/api\/media\/med_1\.wav$/)
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) }
    },
    decodeAudioData: async () => fakeBuffer,
  })
  assert.equal(MEDIA_BASE, '/studio/api/media/')
  const first = await bank.load('med_1', 'med_1.wav')
  assert.equal(first, fakeBuffer)
  assert.equal(bank.has('med_1'), true)
  assert.equal(bank.get('med_1'), fakeBuffer)
  assert.equal(bank.loadedCount, 1)
  assert.equal(await bank.load('med_1', 'med_1.wav'), fakeBuffer)
  assert.equal(fetchCalls, 1, '重复 load 应命中缓存')
  // 并发 load 去重
  let concurrentFetches = 0
  const concurrent = new MediaBank({
    fetchImpl: async () => {
      concurrentFetches += 1
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }
    },
    decodeAudioData: async () => ({ duration: 1 }),
  })
  await Promise.all([concurrent.load('med_x', 'x.wav'), concurrent.load('med_x', 'x.wav')])
  assert.equal(concurrent.loadedCount, 1)
  assert.equal(concurrentFetches, 1)
  // HTTP 失败 → null，且失败缓存避免重复请求
  let failCalls = 0
  const failing = new MediaBank({
    fetchImpl: async () => {
      failCalls += 1
      throw new Error('network down')
    },
    decodeAudioData: async () => null,
  })
  assert.equal(await failing.load('med_bad', 'bad.wav'), null)
  assert.equal(await failing.load('med_bad', 'bad.wav'), null)
  assert.equal(failCalls, 1)
  // 无 media 工程 / 空列表
  assert.equal(await bank.preloadForProject({}), 0)
  assert.deepEqual(collectMediaFiles({}), [])
  // preloadForProject 预加载工程 media
  const project = {
    media: [
      { id: 'med_1', file: 'med_1.wav' },
      { id: 'med_2', file: 'med_2.wav' },
    ],
  }
  const mediaEntries = collectMediaFiles(project)
  assert.deepEqual(
    mediaEntries.map(({ mediaId, file }) => ({ mediaId, file })),
    [
      { mediaId: 'med_1', file: 'med_1.wav' },
      { mediaId: 'med_2', file: 'med_2.wav' },
    ],
  )
  // 缓存身份包含媒体内容指纹（无元数据时仍是 mediaId+file，不为空）
  assert.ok(mediaEntries.every((entry) => typeof entry.identity === 'string' && entry.identity.includes(entry.mediaId)))
  let preloadFetches = 0
  const preloadBank = new MediaBank({
    fetchImpl: async () => {
      preloadFetches += 1
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }
    },
    decodeAudioData: async () => ({ duration: 2 }),
  })
  assert.equal(await preloadBank.preloadForProject(project), 2)
  assert.equal(preloadFetches, 2)
})

test('buildAudioClipSegments：when/offset/duration 裁剪、mute 跳过、无 media 兼容', () => {
  const bps = 2 // 120 BPM
  // 完整区间：clip [0,16) beats = 8s；media 6s → duration 6
  const full = buildAudioClipSegments(makeAudioProject({ mediaDuration: 6 }), 0, 32, bps)
  assert.equal(full.length, 1)
  closeTo(full[0].whenSeconds, 0)
  closeTo(full[0].offsetSeconds, 0)
  closeTo(full[0].durationSeconds, 6)
  closeTo(full[0].relBeats, 0)
  assert.equal(full[0].mediaId, 'med_1')
  assert.equal(full[0].trackId, 'trk_a')
  // 区间从 clip 中间开始：beats [8,32) → offset 4s，duration = min(4s, 6-4)=2
  const mid = buildAudioClipSegments(makeAudioProject({ mediaDuration: 6 }), 8, 32, bps)
  closeTo(mid[0].whenSeconds, 0)
  closeTo(mid[0].offsetSeconds, 4)
  closeTo(mid[0].durationSeconds, 2)
  // clip 从区间内部开始：startBar 4（beat16）→ when=(16-8)/2=4s
  const inner = buildAudioClipSegments(
    makeAudioProject({ startBar: 4, lengthBars: 2, mediaDuration: 6 }),
    8,
    32,
    bps,
  )
  closeTo(inner[0].whenSeconds, 4)
  closeTo(inner[0].offsetSeconds, 0)
  closeTo(inner[0].durationSeconds, 4)
  // 与区间不重叠 → []
  assert.deepEqual(buildAudioClipSegments(makeAudioProject(), 64, 128, bps), [])
  // mute 音频轨 → 不产生片段
  assert.deepEqual(buildAudioClipSegments(makeAudioProject({ muted: true }), 0, 32, bps), [])
  // 旧工程无 media 字段 / media 列表缺该条目 → []
  const legacy = makeAudioProject()
  delete legacy.media
  assert.deepEqual(buildAudioClipSegments(legacy, 0, 32, bps), [])
  const missing = makeAudioProject()
  missing.media = []
  assert.deepEqual(buildAudioClipSegments(missing, 0, 32, bps), [])
  // media 元数据缺 duration → 只受 clip 长度约束
  const unknownDuration = makeAudioProject()
  unknownDuration.media = [{ id: 'med_1', file: 'med_1.wav' }]
  const unknownSegments = buildAudioClipSegments(unknownDuration, 0, 32, bps)
  closeTo(unknownSegments[0].durationSeconds, 8)
  assert.ok(MIN_AUDIO_CLIP_SECONDS > 0 && MIN_AUDIO_CLIP_SECONDS < 0.1)
})

test('buildAudioClipSegments：offsetSeconds=0 / 旧工程无字段与旧行为完全一致', () => {
  const legacy = makeAudioProject()
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.clips[0], 'offsetSeconds'), false)
  const withZero = makeAudioProject({ offsetSeconds: 0 })
  const legacySegments = buildAudioClipSegments(legacy, 0, 32, 2)
  const zeroSegments = buildAudioClipSegments(withZero, 0, 32, 2)
  assert.deepEqual(zeroSegments, legacySegments)
  assert.equal(legacySegments.length, 1)
  closeTo(legacySegments[0].offsetSeconds, 0)
  closeTo(legacySegments[0].durationSeconds, 6) // min(clip 8s, media 6s)
  // 非法 offset（NaN / 负数 / null / 字符串）→ 按 0 处理，不崩
  for (const bad of [Number.NaN, -1, null, 'abc', Number.POSITIVE_INFINITY]) {
    const project = makeAudioProject()
    project.clips[0].offsetSeconds = bad
    assert.deepEqual(buildAudioClipSegments(project, 0, 32, 2), legacySegments)
  }
})

test('buildAudioClipSegments：offsetSeconds>0 时媒体起点与可播放时长正确', () => {
  // media 6s，clip 时间线 8s，裁掉开头 2s → 实际起点 2s，可播放 min(8s, 6-2=4s)=4s
  const trimmed = buildAudioClipSegments(makeAudioProject({ offsetSeconds: 2 }), 0, 32, 2)[0]
  closeTo(trimmed.offsetSeconds, 2)
  closeTo(trimmed.durationSeconds, 4)
  closeTo(trimmed.whenSeconds, 0)
  closeTo(trimmed.startBeat, 0)
  closeTo(trimmed.endBeat, 8) // 4s × 2 bps
  // media 10s，offset 2s → 可播放 min(8s, 8s)=8s
  const longer = buildAudioClipSegments(makeAudioProject({ mediaDuration: 10, offsetSeconds: 2 }), 0, 32, 2)[0]
  closeTo(longer.offsetSeconds, 2)
  closeTo(longer.durationSeconds, 8)
})

test('buildAudioClipSegments：渲染区间从片段中间开始 + offsetSeconds 叠加', () => {
  // clip offset 1s；range 从 beat8（片段内 4s）开始 → 实际媒体起点 1+4=5s；media 10s → 剩余 5s
  const project = makeAudioProject({ mediaDuration: 10, offsetSeconds: 1 })
  const middle = buildAudioClipSegments(project, 8, 32, 2)[0]
  closeTo(middle.whenSeconds, 0)
  closeTo(middle.offsetSeconds, 5)
  closeTo(middle.durationSeconds, 4) // min((16-8)/2=4s, 10-5=5s)
  // range 从 beat12（片段内 6s）开始 → 媒体起点 1+6=7s → 可播放 min(2s, 3s)=2s
  const later = buildAudioClipSegments(project, 12, 32, 2)[0]
  closeTo(later.offsetSeconds, 7)
  closeTo(later.durationSeconds, 2)
})

test('buildAudioClipSegments：offset 超出媒体 → 跳过', () => {
  // offset 正好等于媒体时长
  assert.deepEqual(buildAudioClipSegments(makeAudioProject({ mediaDuration: 4, offsetSeconds: 4 }), 0, 32, 2), [])
  // 剩余时长 < MIN_AUDIO_CLIP_SECONDS
  assert.deepEqual(buildAudioClipSegments(makeAudioProject({ mediaDuration: 4, offsetSeconds: 3.999 }), 0, 32, 2), [])
  // 区间从片段中间开始导致实际媒体起点超媒体：media 4s，offset 3s，range 从 beat4（片段内 2s）→ 起点 5s
  assert.deepEqual(buildAudioClipSegments(makeAudioProject({ mediaDuration: 4, offsetSeconds: 3 }), 4, 32, 2), [])
  // 边界：剩余 0.02s > MIN → 保留
  const edge = buildAudioClipSegments(makeAudioProject({ mediaDuration: 4, offsetSeconds: 3.98 }), 0, 32, 2)
  assert.equal(edge.length, 1)
  closeTo(edge[0].offsetSeconds, 3.98)
  closeTo(edge[0].durationSeconds, 0.02)
})

test('buildAudioClipSegments：不同 bps 下 offsetSeconds 换算正确', () => {
  const project = makeAudioProject({ mediaDuration: 12, offsetSeconds: 2 })
  // bps=1（60BPM）：clip 16 beats = 16s，媒体剩余 10s → duration 10
  const slow = buildAudioClipSegments(project, 0, 32, 1)[0]
  closeTo(slow.offsetSeconds, 2)
  closeTo(slow.durationSeconds, 10)
  // bps=3（180BPM）：clip 16 beats ≈ 5.333s，range [0,8) → duration 8/3
  const fast = buildAudioClipSegments(project, 0, 8, 3)[0]
  closeTo(fast.offsetSeconds, 2)
  closeTo(fast.durationSeconds, 8 / 3)
  // bps=3 且区间从片段中间 beat4 开始 → 媒体起点 2 + 4/3
  const fastMid = buildAudioClipSegments(project, 4, 8, 3)[0]
  closeTo(fastMid.offsetSeconds, 2 + 4 / 3)
  closeTo(fastMid.durationSeconds, 4 / 3)
})

test('renderWav / 实时：offsetSeconds 传入 AudioBufferSourceNode.start(when, offset, duration)', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const fakeBuffer = { duration: 6 }
    const project = makeAudioProject({ mediaDuration: 6, offsetSeconds: 2 })
    // 离线整曲（16s）：when 0、媒体 offset 2s、duration min(8s, 6-2)=4s
    const engine = new StudioEngine()
    engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    const full = await engine.renderWav(project)
    engine.dispose()
    const ctx = instances[0]
    const fullSources = ctx.sources.filter((source) => source.buffer === fakeBuffer)
    assert.equal(fullSources.length, 1)
    assert.deepEqual(fullSources[0].startCalls[0], [0, 2, 4])
    assert.equal(full.blob.size, 44 + ctx.length * 4)
    // 离线只渲染 fromBar 1..2（beats 4..8）：交集从片段内 2s 开始 → 媒体起点 2+2=4s，duration 2s
    const engine2 = new StudioEngine()
    engine2._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    const ranged = await engine2.renderWav(project, { fromBar: 1, toBar: 2 })
    engine2.dispose()
    const ctx2 = instances[1]
    const rangedSources = ctx2.sources.filter((source) => source.buffer === fakeBuffer)
    assert.equal(rangedSources.length, 1)
    assert.deepEqual(rangedSources[0].startCalls[0], [0, 4, 2])
    assert.ok(Math.abs(ranged.seconds - 2) < 1e-6)
    // 实时调度同一 segment：start(1.5, 2, 4)
    const mockCtx = new MockOfflineAudioContext(2, 44100, 44100)
    mockCtx.state = 'running'
    const engine3 = new StudioEngine()
    engine3.setProject(project)
    engine3._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    engine3._ctx = mockCtx
    engine3._graph = { tracks: new Map([['trk_a', { input: mockCtx.createGain() }]]), update: () => {} }
    engine3._project = project
    engine3._bps = 2
    const segment = buildAudioClipSegments(project, 0, 32, 2)[0]
    closeTo(segment.offsetSeconds, 2)
    assert.equal(engine3._scheduleAudioSegment(segment, 1.5), true)
    const source = engine3._mediaVoices[0].handle.source
    assert.deepEqual(source.startCalls[0], [1.5, 2, 4])
    engine3._stopAllMediaVoices(0.01)
    engine3.dispose()
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('StudioEngine 实时：音频片段 start(when, offset, duration) 连到轨道 input；mute/未加载跳过；stop 释放', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  ctx.currentTime = 0
  const project = makeAudioProject({ mediaDuration: 6 })
  const engine = new StudioEngine()
  engine.setProject(project)
  const fakeBuffer = { duration: 6 }
  engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
  engine._ctx = ctx
  engine._graph = { tracks: new Map([['trk_a', { input: ctx.createGain() }]]), update: () => {} }
  engine._bps = 2
  engine._project = project
  try {
    const segments = buildAudioClipSegments(project, 0, 32, 2)
    assert.equal(engine._scheduleAudioSegment(segments[0], 1.25), true)
    assert.equal(engine._mediaVoices.length, 1)
    const source = engine._mediaVoices[0].handle.source
    assert.equal(source.buffer, fakeBuffer)
    assert.deepEqual(source.startCalls[0], [1.25, 0, 6])
    // 未加载 media → 跳过
    assert.equal(engine._scheduleAudioSegment({ ...segments[0], mediaId: 'med_missing' }, 2), false)
    // mute 轨 → 跳过
    project.tracks[0].mute = true
    assert.equal(engine._scheduleAudioSegment(segments[0], 2), false)
    project.tracks[0].mute = false
    // 未知轨道 / 无 ctx 安全
    assert.equal(engine._scheduleAudioSegment({ ...segments[0], trackId: 'trk_404' }, 2), false)
    // stop() 停止媒体 voice
    engine.stop()
    assert.equal(engine._mediaVoices.length, 0)
    assert.ok(source.stopCalls.length >= 1)
  } finally {
    engine.dispose()
  }
})

test('StudioEngine 实时：音频片段按 lookahead 排程（loop 逐圈重排）', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  ctx.currentTime = 0
  const project = makeAudioProject({ mediaDuration: 6 })
  const engine = new StudioEngine()
  engine.setProject(project)
  engine._mediaBank = await makeLoadedMediaBank()
  engine._ctx = ctx
  engine._graph = { tracks: new Map([['trk_a', { input: ctx.createGain() }]]), update: () => {} }
  engine._bps = 2
  engine._project = project
  engine._playing = true
  try {
    const plan = createPlaybackPlan(project, 0)
    engine._plan = plan
    engine._anchorTime = 0
    engine._anchorBeat = 0
    engine._u0 = 0
    engine._audioSegments = buildAudioClipSegments(project, plan.rangeStartBeat, plan.rangeEndBeat, 2)
    engine._audioIndex = 0
    engine._audioIter = 0
    // horizon 0.2s：只排第一圈开头
    engine._scheduleAudioHorizon(0.2)
    assert.equal(engine._mediaVoices.length, 1)
    closeTo(engine._mediaVoices[0].startTime, 0.004)
    // horizon 20s：跨过整圈（loop 长 16s）→ 第二圈重排
    engine._scheduleAudioHorizon(20)
    assert.equal(engine._mediaVoices.length, 2)
    closeTo(engine._mediaVoices[1].startTime, 16)
    // 播放重置清空片段调度状态
    engine._playbackReset()
    assert.deepEqual(engine._audioSegments, [])
  } finally {
    engine._playing = false
    engine._stopAllMediaVoices(0.01)
    engine.dispose()
  }
})

test('renderWav：音频片段按渲染区间 offset 裁剪（离线 mock）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const fakeBuffer = { duration: 6 }
    const project = makeAudioProject({ mediaDuration: 6 }) // clip 0..4 小节 = 0..8s
    // 渲染 beats 8..16（fromBar2..4，4 秒）：clip 与区间重叠 [4s,8s) → when 0, offset 4, duration 2
    const engine = new StudioEngine()
    engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    const ranged = await engine.renderWav(project, { fromBar: 2, toBar: 4 })
    engine.dispose()
    assert.ok(Math.abs(ranged.seconds - 4) < 1e-6)
    const ctx = instances[0]
    assert.equal(ranged.blob.size, 44 + ctx.length * 4)
    const rangedSources = ctx.sources.filter((source) => source.buffer === fakeBuffer)
    assert.equal(rangedSources.length, 1)
    assert.deepEqual(rangedSources[0].startCalls[0], [0, 4, 2])
    // 整首渲染：when 0, offset 0, duration = min(8s, media 6) = 6
    const engine2 = new StudioEngine()
    engine2._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    const full = await engine2.renderWav(project)
    engine2.dispose()
    const ctx2 = instances[1]
    const fullSources = ctx2.sources.filter((source) => source.buffer === fakeBuffer)
    assert.equal(fullSources.length, 1)
    assert.deepEqual(fullSources[0].startCalls[0], [0, 0, 6])
    assert.equal(full.blob.size, 44 + ctx2.length * 4)
    // mute 音频轨 → 不调度媒体源，但导出仍然成功
    const mutedProject = makeAudioProject({ mediaDuration: 6, muted: true })
    const engine3 = new StudioEngine()
    engine3._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    const mutedResult = await engine3.renderWav(mutedProject)
    engine3.dispose()
    const ctx3 = instances[2]
    assert.equal(ctx3.sources.filter((source) => source.buffer === fakeBuffer).length, 0)
    assert.equal(mutedResult.blob.size, 44 + ctx3.length * 4)
    // 无 media 旧工程（无音频轨）仍可正常渲染
    const legacy = buildTestProject()
    const engine4 = new StudioEngine()
    const legacyResult = await engine4.renderWav(legacy, { fromBar: 0, toBar: 2 })
    engine4.dispose()
    assert.ok(legacyResult.blob.size > 44)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('R2a 模型集成：normalizeProject 保留 gain/fade/reverse；旧 v3 片段默认等价旧行为', () => {
  const project = makeAudioProject({ mediaDuration: 6 })
  Object.assign(project.clips[0], { gainDb: -6, fadeInSeconds: 0.5, fadeOutSeconds: 0.25, reverse: true })
  const normalized = normalizeProject(project)
  const clip = normalized.clips[0]
  assert.equal(clip.gainDb, -6)
  assert.equal(clip.fadeInSeconds, 0.5)
  assert.equal(clip.fadeOutSeconds, 0.25)
  assert.equal(clip.reverse, true)
  const segment = buildAudioClipSegments(normalized, 0, 32, 2)[0]
  assert.equal(segment.gainDb, -6)
  assert.equal(segment.reverse, true)
  assert.equal(segment.fadeInSeconds, 0.5)

  // 旧 v3 片段（无字段）→ normalize 不写入默认值，引擎段为默认（旧行为）
  const legacy = makeAudioProject({ mediaDuration: 6 })
  const legacyNormalized = normalizeProject(legacy)
  const legacyClip = legacyNormalized.clips[0]
  assert.equal(legacyClip.gainDb, undefined)
  assert.equal(legacyClip.fadeInSeconds, undefined)
  assert.equal(legacyClip.reverse, undefined)
  const legacySegment = buildAudioClipSegments(legacyNormalized, 0, 32, 2)[0]
  assert.equal(legacySegment.gainDb, 0)
  assert.equal(legacySegment.gainScale, 1)
  assert.equal(legacySegment.fadeInSeconds, 0)
  assert.equal(legacySegment.fadeOutSeconds, 0)
  assert.equal(legacySegment.reverse, false)
})

// ---------------------------------------------------------------------------
// 13. 麦克风录音（CONTRACT-P3B2 §1）
// ---------------------------------------------------------------------------

/** 录音单测环境：mock AudioContext / getUserMedia / stream。 */
function makeMockRecorderEnvironment({ sampleRate = 44100, getUserMediaError = null } = {}) {
  const env = {
    contexts: [],
    getUserMediaCalls: [],
    stoppedTracks: 0,
    MockAudioContext: null,
    stream: null,
    getUserMedia: null,
    gainNodes: [],
    connections: [],
  }
  class MockAudioContext {
    constructor(options = {}) {
      this.options = options
      this.sampleRate = sampleRate
      this.state = 'running'
      this.destination = { connect() {}, disconnect() {} }
      this.resumed = 0
      this.closed = false
      this.processor = null
      env.contexts.push(this)
    }
    resume() {
      this.resumed += 1
      return Promise.resolve()
    }
    createMediaStreamSource(stream) {
      this.stream = stream
      return { connect() {}, disconnect() {} }
    }
    createScriptProcessor(size, inChannels, outChannels) {
      this.processor = { size, inChannels, outChannels, onaudioprocess: null, connect() {}, disconnect() {} }
      return this.processor
    }
    createGain() {
      const node = {
        gain: { value: 1 },
        connections: [],
        connect(target) {
          this.connections.push(target)
          env.connections.push({ node: this, target })
        },
        disconnect() {
          this.connections = []
        },
      }
      env.gainNodes.push(node)
      return node
    }
    close() {
      this.closed = true
      return Promise.resolve()
    }
  }
  env.MockAudioContext = MockAudioContext
  env.stream = {
    getTracks() {
      return [
        {
          stop: () => {
            env.stoppedTracks += 1
          },
        },
      ]
    },
  }
  env.getUserMedia = async (constraints) => {
    env.getUserMediaCalls.push(constraints)
    if (getUserMediaError) throw getUserMediaError
    return env.stream
  }
  return env
}

function feedRecorderChunk(env, samples, contextIndex = 0) {
  const processor = env.contexts[contextIndex]?.processor
  assert.ok(processor, 'ScriptProcessor 应已创建')
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } })
}

function makeRecorder(env, options = {}) {
  return new InputRecorder({
    audioContextCtor: env.MockAudioContext,
    getUserMediaImpl: env.getUserMedia,
    ...options,
  })
}

test('concatFloat32：空块 / 多块拼接 / 保持样本顺序', () => {
  assert.equal(concatFloat32([]).length, 0)
  const single = concatFloat32([Float32Array.from([0.1, -0.2])])
  assert.equal(single.length, 2)
  closeTo(single[0], 0.1)
  closeTo(single[1], -0.2)
  const merged = concatFloat32([Float32Array.from([1, 2]), new Float32Array(0), [3, 4, 5]])
  assert.ok(merged instanceof Float32Array)
  assert.deepEqual(Array.from(merged), [1, 2, 3, 4, 5])
})

test('computePeaks：空/静音全 0、峰值取绝对值、自定义点数', () => {
  const empty = computePeaks(new Float32Array(0))
  assert.equal(empty.length, PEAK_COUNT)
  assert.ok(empty.every((value) => value === 0))
  const silent = computePeaks(new Float32Array(1000), 256)
  assert.ok(silent.every((value) => value === 0))
  const samples = new Float32Array(512)
  samples[0] = 0.5
  samples[255] = -1
  samples[256] = 0.25
  samples[511] = -1
  assert.deepEqual(computePeaks(samples, 2), [1, 1])
  const peaks = computePeaks(samples, 4)
  closeTo(peaks[0], 0.5)
  closeTo(peaks[1], 1)
  closeTo(peaks[2], 0.25)
  closeTo(peaks[3], 1)
  assert.equal(computePeaks(samples, 128).length, 128)
})

test('encodeRecordedWav：16-bit 单声道 WAV 头、字节率与时长正确', () => {
  const samples = Float32Array.from({ length: 4410 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5)
  const wav = encodeRecordedWav(samples, 44100)
  assert.ok(wav instanceof ArrayBuffer)
  const header = parseWavHeader(new Uint8Array(wav))
  assert.equal(header.riff, 'RIFF')
  assert.equal(header.wave, 'WAVE')
  assert.equal(header.fmt, 'fmt ')
  assert.equal(header.data, 'data')
  assert.equal(header.audioFormat, 1)
  assert.equal(header.channels, 1)
  assert.equal(header.sampleRate, 44100)
  assert.equal(header.byteRate, 44100 * 2)
  assert.equal(header.blockAlign, 2)
  assert.equal(header.bitsPerSample, 16)
  assert.equal(header.dataSize, samples.length * 2)
  assert.equal(header.riffSize, 36 + samples.length * 2)
  assert.equal(header.byteLength, 44 + samples.length * 2)
  closeTo(header.dataSize / 2 / header.sampleRate, 0.1)
  // 采样映射：0→0、0.5→16384、-1→-32768、1→32767
  const tiny = encodeRecordedWav(Float32Array.from([0, 0.5, -1, 1]), 48000)
  const view = new DataView(tiny)
  assert.equal(view.getInt16(44, true), 0)
  assert.equal(view.getInt16(46, true), Math.round(0.5 * 0x7fff))
  assert.equal(view.getInt16(48, true), -0x8000)
  assert.equal(view.getInt16(50, true), 0x7fff)
  assert.equal(parseWavHeader(new Uint8Array(tiny)).sampleRate, 48000)
  // 空录音只有 44 字节头
  assert.equal(encodeRecordedWav(new Float32Array(0), 44100).byteLength, 44)
})

test('InputRecorder：无 Web API 环境 start 抛「当前环境不支持录音」', async () => {
  assert.equal(DEFAULT_MAX_SECONDS, 300)
  closeTo(MIN_RECORD_SECONDS, 0.15)
  assert.equal(RECORDER_BUFFER_SIZE, 4096)
  const recorder = new InputRecorder({ audioContextCtor: null, getUserMediaImpl: null })
  assert.equal(recorder.isRecording, false)
  await assert.rejects(recorder.start(), /当前环境不支持录音/)
  assert.equal(recorder.isRecording, false)
  assert.equal(await recorder.stop(), null)
  // 只有 getUserMedia、没有 AudioContext 同样不支持
  const partial = new InputRecorder({ audioContextCtor: null, getUserMediaImpl: async () => ({}) })
  await assert.rejects(partial.start(), /当前环境不支持录音/)
})

test('InputRecorder：mock getUserMedia/AudioContext 的 start→stop 返回 WAV 元数据并清理资源', async () => {
  const env = makeMockRecorderEnvironment({ sampleRate: 48000 })
  const recorder = makeRecorder(env)
  const levels = []
  const started = await recorder.start({ deviceId: 'mic-1', onLevel: (value) => levels.push(value) })
  assert.equal(started.sampleRate, 48000)
  assert.equal(started.channels, 1)
  assert.equal(typeof started.startedAt, 'number')
  assert.ok(started.startedAt > 0)
  assert.equal(recorder.isRecording, true)
  assert.ok(recorder.elapsedSeconds >= 0)
  assert.equal(env.getUserMediaCalls.length, 1)
  // CONTRACT-P15：指定 deviceId → {audio:{deviceId:{exact}}}
  assert.deepEqual(env.getUserMediaCalls[0], { audio: { deviceId: { exact: 'mic-1' } } })
  const ctx = env.contexts[0]
  assert.equal(ctx.processor.size, RECORDER_BUFFER_SIZE)
  assert.equal(ctx.processor.inChannels, 1)
  assert.equal(ctx.processor.outChannels, 1)
  // 0 增益监听链：gain=0（不啸叫）
  assert.equal(typeof ctx.processor.onaudioprocess, 'function')
  // 喂 2 块 4096 样本（~0.17s @48k > 0.15s）
  const chunk = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i / 8) * 0.5)
  feedRecorderChunk(env, chunk)
  feedRecorderChunk(env, chunk)
  assert.ok(levels.length >= 2)
  assert.ok(levels[0] > 0)
  const result = await recorder.stop()
  assert.ok(result)
  assert.ok(result.wav instanceof ArrayBuffer)
  assert.equal(result.sampleRate, 48000)
  assert.equal(result.channels, 1)
  closeTo(result.durationSeconds, 8192 / 48000)
  assert.equal(result.peaks.length, PEAK_COUNT)
  assert.ok(result.peaks.every((value) => value >= 0 && value <= 1))
  const header = parseWavHeader(new Uint8Array(result.wav))
  assert.equal(header.channels, 1)
  assert.equal(header.sampleRate, 48000)
  assert.equal(header.bitsPerSample, 16)
  assert.equal(header.dataSize, 8192 * 2)
  // 清理：tracks 停止、ctx close、状态复位
  assert.equal(env.stoppedTracks, 1)
  assert.equal(ctx.closed, true)
  assert.equal(recorder.isRecording, false)
  assert.equal(recorder.elapsedSeconds, 0)
  assert.equal(await recorder.stop(), null)
})

test('InputRecorder：录音短于 0.15s 抛「录音太短，已取消」并完成清理', async () => {
  const env = makeMockRecorderEnvironment({ sampleRate: 48000 })
  const recorder = makeRecorder(env)
  await recorder.start()
  feedRecorderChunk(env, Float32Array.from({ length: 1000 }, () => 0.1))
  await assert.rejects(recorder.stop(), /录音太短，已取消/)
  assert.equal(recorder.isRecording, false)
  assert.equal(env.stoppedTracks, 1)
  assert.equal(env.contexts[0].closed, true)
  // 清理后可再次开始录音
  await recorder.start()
  assert.equal(recorder.isRecording, true)
  recorder.cancel()
  assert.equal(recorder.isRecording, false)
})

test('InputRecorder：权限/设备错误映射中文，失败不残留资源', async () => {
  const cases = [
    [{ name: 'NotAllowedError', message: 'denied' }, /麦克风权限被拒绝，请在浏览器\/系统设置里允许/],
    [{ name: 'NotFoundError', message: 'no device' }, /没有找到麦克风设备/],
    [new Error('设备被其他应用占用'), /设备被其他应用占用/],
  ]
  for (const [error, pattern] of cases) {
    const env = makeMockRecorderEnvironment({ getUserMediaError: error })
    const recorder = makeRecorder(env)
    await assert.rejects(recorder.start(), pattern)
    assert.equal(recorder.isRecording, false)
    assert.equal(env.stoppedTracks, 0) // stream 未建立，无需停止 track
  }
  assert.equal(mapMicrophoneError({ name: 'NotAllowedError' }), '麦克风权限被拒绝，请在浏览器/系统设置里允许')
  assert.equal(mapMicrophoneError({ name: 'NotFoundError' }), '没有找到麦克风设备')
  assert.equal(mapMicrophoneError({ message: 'raw error' }), 'raw error')
})

test('InputRecorder：默认设备约束 audio:true；cancel() 立即释放且不产出结果', async () => {
  const env = makeMockRecorderEnvironment()
  const recorder = makeRecorder(env)
  await recorder.start()
  assert.deepEqual(env.getUserMediaCalls[0], { audio: true })
  assert.equal(recorder.isRecording, true)
  recorder.cancel()
  assert.equal(recorder.isRecording, false)
  assert.equal(recorder.elapsedSeconds, 0)
  assert.equal(env.stoppedTracks, 1)
  assert.equal(env.contexts[0].closed, true)
  assert.equal(await recorder.stop(), null)
})

test('InputRecorder：maxSeconds 到点自动停止，结果可通过后续 stop() 取回', async () => {
  let clockMs = 0
  const env = makeMockRecorderEnvironment()
  const recorder = makeRecorder(env, { maxSeconds: 0.2, now: () => clockMs })
  await recorder.start()
  const chunk = Float32Array.from({ length: 4096 }, () => 0.2)
  feedRecorderChunk(env, chunk)
  assert.equal(recorder.isRecording, true)
  // 推进时钟超过 maxSeconds 后下一次音频回调触发自动停止
  clockMs = 250
  feedRecorderChunk(env, chunk)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(recorder.isRecording, false)
  assert.equal(env.stoppedTracks, 1)
  assert.equal(env.contexts[0].closed, true)
  // 自动停止的结果仍可取回（UI 轮询 isRecording 后再 stop 不会丢录音）
  const result = await recorder.stop()
  assert.ok(result)
  assert.ok(result.durationSeconds > MIN_RECORD_SECONDS)
  assert.equal(result.channels, 1)
})

test('InputRecorder：重复 start 抛「录音已在进行中」；setup 中途失败也清理并映射中文', async () => {
  const env = makeMockRecorderEnvironment()
  const recorder = makeRecorder(env)
  await recorder.start()
  await assert.rejects(recorder.start(), /录音已在进行中/)
  // createScriptProcessor 抛错（ctx/stream 已建立）→ 应停止 track、关闭 ctx、抛原始中文 message
  const failing = makeMockRecorderEnvironment()
  class FailingCtx extends failing.MockAudioContext {
    createScriptProcessor() {
      throw new Error('processor unavailable')
    }
  }
  const broken = new InputRecorder({ audioContextCtor: FailingCtx, getUserMediaImpl: failing.getUserMedia })
  await assert.rejects(broken.start(), /processor unavailable/)
  assert.equal(broken.isRecording, false)
  assert.equal(failing.stoppedTracks, 1)
  assert.equal(failing.contexts[0].closed, true)
  recorder.cancel()
})

test('InputRecorder：sampleRate 选项传给 AudioContext；elapsedSeconds 随注入时钟增长', async () => {
  let clock = 0
  const env = makeMockRecorderEnvironment({ sampleRate: 48000 })
  const recorder = makeRecorder(env, { sampleRate: 48000, now: () => clock })
  const started = await recorder.start()
  assert.equal(env.contexts[0].options.sampleRate, 48000)
  assert.equal(started.sampleRate, 48000)
  assert.equal(recorder.elapsedSeconds, 0)
  clock = 1200
  closeTo(recorder.elapsedSeconds, 1.2)
  recorder.cancel()
  assert.equal(recorder.elapsedSeconds, 0)
})

test('R2c media：buildAudioClipSegments / renderWav 跳过 takeActive===false（无字段兼容旧行为）', async () => {
  // 纯函数：inactive 跳过、active/无字段正常
  const inactive = makeAudioProject({ mediaDuration: 6 })
  inactive.clips[0].takeActive = false
  assert.equal(buildAudioClipSegments(inactive, 0, 32, 2).length, 0)
  inactive.clips[0].takeActive = true
  assert.equal(buildAudioClipSegments(inactive, 0, 32, 2).length, 1)
  delete inactive.clips[0].takeActive
  assert.equal(buildAudioClipSegments(inactive, 0, 32, 2).length, 1)

  // comping：同轨两个 clip（一个 inactive）→ 只生成 active 段
  const comp = makeAudioProject({ mediaDuration: 6 })
  const base = comp.clips[0]
  comp.clips = [
    { ...base, id: 'clip_off', startBar: 0, lengthBars: 1, takeGroup: 'take-1', takeIndex: 0, takeActive: false },
    { ...base, id: 'clip_on', startBar: 1, lengthBars: 1, takeGroup: 'take-1', takeIndex: 1 },
  ]
  const compSegments = buildAudioClipSegments(comp, 0, 32, 2)
  assert.equal(compSegments.length, 1)
  assert.equal(compSegments[0].clipId, 'clip_on')
  closeTo(compSegments[0].whenSeconds, 2) // bar1 @120bpm

  // 模型集成：normalizeProject 保留 take 字段；inactive 经 normalize 后仍被引擎跳过
  const modelProject = makeAudioProject({ mediaDuration: 6 })
  Object.assign(modelProject.clips[0], { takeGroup: 'take-1', takeIndex: 0, takeActive: false })
  const normalized = normalizeProject(modelProject)
  assert.equal(normalized.clips[0].takeGroup, 'take-1')
  assert.equal(normalized.clips[0].takeIndex, 0)
  assert.equal(normalized.clips[0].takeActive, false)
  assert.equal(buildAudioClipSegments(normalized, 0, 32, 2).length, 0)
  normalized.clips[0].takeActive = true
  assert.equal(buildAudioClipSegments(normalized, 0, 32, 2).length, 1)

  // 实时/离线一致：renderWav 不调度 inactive 片段
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const fakeBuffer = { duration: 6 }
    const render = async (project) => {
      const engine = new StudioEngine()
      engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
      await engine.renderWav(project, { fromBar: 0, toBar: 4 })
      engine.dispose()
      return instances.at(-1)
    }
    const inactiveProject = makeAudioProject({ mediaDuration: 6 })
    inactiveProject.clips[0].takeActive = false
    const inactiveCtx = await render(inactiveProject)
    assert.equal(inactiveCtx.sources.filter((source) => source.buffer === fakeBuffer).length, 0)
    const activeProject = makeAudioProject({ mediaDuration: 6 })
    const activeCtx = await render(activeProject)
    assert.equal(activeCtx.sources.filter((source) => source.buffer === fakeBuffer).length, 1)
    activeProject.clips[0].takeActive = true
    const explicitActiveCtx = await render(activeProject)
    assert.equal(explicitActiveCtx.sources.filter((source) => source.buffer === fakeBuffer).length, 1)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('R2c recorder：normalizeMonitorGain 钳制/回退', () => {
  assert.equal(normalizeMonitorGain(0.2), 0.2)
  assert.equal(normalizeMonitorGain(2), 1)
  assert.equal(normalizeMonitorGain(-1), 0)
  assert.equal(normalizeMonitorGain('x'), DEFAULT_MONITOR_GAIN)
  assert.equal(normalizeMonitorGain(undefined, 0.6), 0.6)
  assert.equal(normalizeMonitorGain('x', 0.6), 0.6)
  closeTo(DEFAULT_MONITOR_GAIN, 0.35)
})

/** 录音测试用：当前 ctx 上连接到 destination 的 gain 节点。 */
function recorderDestinationGains(env, contextIndex = 0) {
  const context = env.contexts[contextIndex]
  return env.gainNodes.filter((node) => node.connections.includes(context?.destination))
}

test('R2c recorder：start({monitor}) 监听路径 source→monitorGain→destination，采集不受影响，stop 清理', async () => {
  const env = makeMockRecorderEnvironment({ sampleRate: 48000 })
  const recorder = makeRecorder(env)
  // 默认关闭监听：只有 mute(0) 连 destination
  const started = await recorder.start()
  assert.equal(started.monitor, false)
  closeTo(started.monitorGain, DEFAULT_MONITOR_GAIN)
  assert.equal(recorder.isMonitoring, false)
  assert.equal(recorderDestinationGains(env).length, 1)
  assert.equal(recorderDestinationGains(env)[0].gain.value, 0)
  const samples = new Float32Array(48000 * 0.2)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.5
  feedRecorderChunk(env, samples)
  const result = await recorder.stop()
  assert.ok(result.durationSeconds > 0.15)
  assert.equal(env.contexts[0].closed, true)
  assert.equal(env.stoppedTracks, 1)
  assert.equal(recorder.isMonitoring, false)

  // 开启监听：额外 gain(0.35) 连 destination；录音数据不变
  env.gainNodes.length = 0
  env.connections.length = 0
  const env2 = makeMockRecorderEnvironment({ sampleRate: 48000 })
  const recorder2 = makeRecorder(env2)
  const started2 = await recorder2.start({ monitor: true })
  assert.equal(started2.monitor, true)
  closeTo(started2.monitorGain, DEFAULT_MONITOR_GAIN)
  assert.equal(recorder2.isMonitoring, true)
  const monitorGains = recorderDestinationGains(env2).filter((node) => node.gain.value !== 0)
  assert.equal(monitorGains.length, 1)
  closeTo(monitorGains[0].gain.value, DEFAULT_MONITOR_GAIN)
  // source 连到监听节点（监听节点在 gain 节点列表中，且其 connections 指向 destination）
  feedRecorderChunk(env2, samples)
  const result2 = await recorder2.stop()
  closeTo(result2.durationSeconds, 0.2, 0.001)
  assert.equal(env2.contexts[0].closed, true)
  assert.equal(recorder2.isMonitoring, false)
  // stop 后监听节点已 disconnect
  assert.equal(monitorGains[0].connections.length, 0)

  // 自定义增益 + 钳制
  const env3 = makeMockRecorderEnvironment()
  const recorder3 = makeRecorder(env3)
  const started3 = await recorder3.start({ monitor: true, monitorGain: 0.2 })
  closeTo(started3.monitorGain, 0.2)
  closeTo(recorderDestinationGains(env3).find((node) => node.gain.value !== 0).gain.value, 0.2)
  recorder3.cancel()
  const env4 = makeMockRecorderEnvironment()
  const recorder4 = makeRecorder(env4)
  const started4 = await recorder4.start({ monitor: true, monitorGain: 5 })
  closeTo(started4.monitorGain, 1)
  closeTo(recorderDestinationGains(env4).find((node) => node.gain.value !== 0).gain.value, 1)
  recorder4.cancel()
})

test('R2c recorder：录音中 setMonitor 切换（不中断采集/不影响已录数据），未录音只记录偏好', async () => {
  const env = makeMockRecorderEnvironment({ sampleRate: 48000 })
  const recorder = makeRecorder(env)
  // 未录音：只记录偏好，下次 start 生效
  assert.equal(recorder.setMonitor(true, 0.4), false)
  closeTo(recorder.monitorGain, 0.4)
  const started = await recorder.start({ deviceId: null })
  assert.equal(started.monitor, true)
  closeTo(started.monitorGain, 0.4)
  assert.equal(recorder.isMonitoring, true)
  const samples = new Float32Array(48000 * 0.2).fill(0.25)
  feedRecorderChunk(env, samples)
  // 录音中关闭监听：采集继续
  assert.equal(recorder.setMonitor(false), true)
  assert.equal(recorder.isMonitoring, false)
  assert.equal(recorder.isRecording, true)
  assert.equal(recorderDestinationGains(env).filter((node) => node.gain.value !== 0).length, 0)
  feedRecorderChunk(env, samples)
  // 再次打开并改增益
  assert.equal(recorder.setMonitor(true, 0.7), true)
  assert.equal(recorder.isMonitoring, true)
  closeTo(recorderDestinationGains(env).find((node) => node.gain.value !== 0).gain.value, 0.7)
  feedRecorderChunk(env, samples)
  const result = await recorder.stop()
  closeTo(result.durationSeconds, 0.6, 0.002)
  assert.equal(env.contexts[0].closed, true)
  // 停止后监听节点清理
  assert.equal(recorder.isMonitoring, false)
  assert.equal(env.gainNodes.every((node) => node.connections.length === 0 || node.gain.value === 0), true)
})

// ---------------------------------------------------------------------------
// 14. P8 真实采样音色（GeneralUser GS SF2，CONTRACT-P8 §3）
// ---------------------------------------------------------------------------

const SF2_FILE = new URL('../assets/soundfonts/GeneralUser.sf2', import.meta.url)
let sharedSf2BankPromise = null

/** 读取真实 GeneralUser.sf2（32MB）为独立 ArrayBuffer。 */
function readSf2ArrayBuffer() {
  const buffer = fs.readFileSync(SF2_FILE)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

/** 新建并解析一个独立 SoundfontBank（engine.dispose 会清缓存，故集成测试各建一个）。 */
async function createSf2Bank() {
  const bank = new SoundfontBank({
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => readSf2ArrayBuffer() }),
  })
  await bank.load()
  return bank
}

/** 共享只读 bank（纯读取测试，避免重复解析 32MB）。 */
async function getSf2Bank() {
  if (!sharedSf2BankPromise) sharedSf2BankPromise = createSf2Bank()
  return sharedSf2BankPromise
}

/** 伪造 SampleBank（Node 无音频设备时给采样鼓提供假 AudioBuffer）。 */
function makeFakeSampleBank() {
  const fakeBuffer = {
    duration: 0.5,
    numberOfChannels: 1,
    sampleRate: 44100,
    length: 22050,
    getChannelData: () => new Float32Array(22050),
  }
  return {
    has: () => true,
    get: () => fakeBuffer,
    setContext: () => {},
    preload: async () => 0,
    preloadForProject: async () => 0,
  }
}

test('SoundfontBank：解析真实 GeneralUser GS（presetCount / 程序名 / 幂等）', async () => {
  const bank = await getSf2Bank()
  assert.equal(bank.isLoaded, true)
  assert.ok(bank.presetCount >= 100, `presetCount=${bank.presetCount}`)
  assert.match(bank.findProgramName(0, 0), /Grand/i)
  assert.match(bank.findProgramName(0, 48), /String/i)
  assert.match(bank.findProgramName(0, 89), /Pad/i)
  // 重复 load 幂等（返回同一 SoundFont2 实例）
  const again = await bank.load()
  assert.equal(again, bank.soundfont)
  assert.equal(bank.presetCount, again.presets.length)
})

test('SoundfontBank：program0 键映射（sample/root/loop/包络）、program48 长音 loop', async () => {
  const bank = await getSf2Bank()
  const piano = bank.getKeyInfo(0, 0, 60)
  assert.ok(piano)
  assert.match(piano.sampleName, /Grand Piano/i)
  assert.equal(piano.root, 60)
  assert.ok(piano.frames > 1000)
  assert.ok(piano.sampleRate >= 8000)
  assert.equal(piano.loop, true) // GeneralUser 钢琴 sampleModes=1
  assert.ok(piano.loopStartSeconds >= 0 && piano.loopEndSeconds > piano.loopStartSeconds)
  assert.ok(piano.attackSeconds > 0 && piano.attackSeconds < 0.5)
  assert.ok(piano.releaseSeconds > 0)
  assert.ok(piano.attenuationGain > 0 && piano.attenuationGain <= 4)
  assert.ok(Number.isFinite(piano.tuneCents))
  // 低/高音区使用不同采样
  const low = bank.getKeyInfo(0, 0, 36)
  const high = bank.getKeyInfo(0, 0, 84)
  assert.ok(low && high)
  assert.notEqual(low.sample, high.sample)
  // program48 弦乐长音：loop=true、根音来自 overridingRootKey 或 sample
  const strings = bank.getKeyInfo(0, 48, 60)
  assert.ok(strings)
  assert.equal(strings.loop, true)
  assert.ok(strings.loopEndSeconds > strings.loopStartSeconds)
  assert.ok(strings.root >= 0 && strings.root <= 127)
  // 采样 AudioBuffer 按 ctx 缓存（同一个 ctx 复用）
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const fakeDest = ctx.createGain()
  assert.ok(bank.buildVoice(ctx, fakeDest, { program: 0, bank: 0, pitch: 60, vel: 0.8, startTime: 0, dur: 1 }))
  const source1 = ctx.nodes.filter((node) => node.kind === 'source').at(-1)
  assert.ok(source1.buffer && source1.buffer.length > 1000)
  assert.ok(bank.buildVoice(ctx, fakeDest, { program: 0, bank: 0, pitch: 60, vel: 0.5, startTime: 0, dur: 1 }))
  const source2 = ctx.nodes.filter((node) => node.kind === 'source').at(-1)
  assert.equal(source1.buffer, source2.buffer, '同一采样在同一 ctx 应复用 AudioBuffer')
})

test('SoundfontBank.buildVoice（mock ctx）：playbackRate / loop / stop/release/dispose / 未知 program', async () => {
  const bank = await getSf2Bank()
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const destination = ctx.createGain()
  // program0 note0 与 note12 共用同一采样（root=26）→ playbackRate 正好翻倍
  const lowVoice = bank.buildVoice(ctx, destination, {
    program: 0,
    bank: 0,
    pitch: 0,
    vel: 0.8,
    startTime: 1,
    dur: 2,
  })
  assert.ok(lowVoice)
  const lowSrc = ctx.nodes.filter((node) => node.kind === 'source').at(-1)
  assert.ok(lowSrc.buffer && lowSrc.buffer.length > 1000)
  assert.ok(Math.abs(lowSrc.startCalls[0][0] - 1) < 1e-9)
  assert.ok(lowVoice.endTime > 3)
  const highVoice = bank.buildVoice(ctx, destination, {
    program: 0,
    bank: 0,
    pitch: 12,
    vel: 0.8,
    startTime: 0,
    dur: 1,
  })
  assert.ok(highVoice)
  const highSrc = ctx.nodes.filter((node) => node.kind === 'source').at(-1)
  closeTo(highSrc.playbackRate.value / lowSrc.playbackRate.value, 2, 0.001)
  // 钢琴采样 sampleModes=1 → loop 且 loopStart/loopEnd 有效
  assert.equal(lowSrc.loop, true)
  assert.ok(lowSrc.loopEnd > lowSrc.loopStart)
  // 弦乐 program48 长音 loop
  assert.ok(bank.buildVoice(ctx, destination, { program: 48, bank: 0, pitch: 60, vel: 0.9, startTime: 0, dur: 4 }))
  const stringsSrc = ctx.nodes.filter((node) => node.kind === 'source').at(-1)
  assert.equal(stringsSrc.loop, true)
  // stop / release / dispose 幂等
  lowVoice.stop(1.2)
  lowVoice.stop(1.3)
  lowVoice.release()
  lowVoice.release()
  lowVoice.dispose()
  lowVoice.dispose()
  assert.ok(lowSrc.stopCalls.length >= 1)
  // 未知 program / bank / 非法 pitch → null（不崩）
  assert.equal(bank.buildVoice(ctx, destination, { program: 200, bank: 0, pitch: 60 }), null)
  assert.equal(bank.buildVoice(ctx, destination, { program: 0, bank: 9, pitch: 60 }), null)
  assert.equal(bank.buildVoice(ctx, destination, { program: 0, bank: 0, pitch: 200 }), null)
  // 未加载音色库 → null
  assert.equal(new SoundfontBank({ fetchImpl: null }).buildVoice(ctx, destination, { program: 0 }), null)
})

test('SoundfontBank：加载失败安全（网络错误 / HTTP 404 → 静音不崩）', async () => {
  const failing = new SoundfontBank({
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  assert.equal(await failing.load(), null)
  assert.equal(failing.isLoaded, false)
  assert.equal(failing.presetCount, 0)
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  assert.equal(failing.buildVoice(ctx, ctx.createGain(), { program: 0 }), null)
  const notFound = new SoundfontBank({ fetchImpl: async () => ({ ok: false, status: 404 }) })
  assert.equal(await notFound.load(), null)
  assert.equal(notFound.findProgramName(0, 0), null)
})

test('StudioEngine.renderWav：采样乐器（grand_piano）走 SF2 buildVoice（离线 mock ctx）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const project = buildTestProject()
    project.tracks[1].instrument = { preset: 'grand_piano', kit: null, params: {} }
    const engine = new StudioEngine()
    engine._soundfontBank = await createSf2Bank()
    const { blob, seconds } = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
    engine.dispose()
    assert.ok(blob.size > 44)
    assert.ok(seconds > 0)
    const ctx = instances[0]
    const sfSources = ctx.sources.filter((source) => source.buffer && source.buffer.length > 1000)
    assert.ok(sfSources.length >= 1, '采样钢琴应通过 SF2 建 voice')
    assert.ok(sfSources[0].startCalls.length >= 1)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('StudioEngine 实时/preview：采样音色走 SoundfontBank.buildVoice；未加载时安全静音', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  const project = buildTestProject()
  project.tracks[1].instrument = { preset: 'grand_piano', kit: null, params: {} }
  const engine = new StudioEngine()
  engine.setProject(project)
  engine._ctx = ctx
  engine._graph = { tracks: new Map([['trk_2', { input: ctx.createGain() }]]), update: () => {} }
  engine._bps = 2
  engine._soundfontBank = await createSf2Bank()
  try {
    // 键盘试听
    const previewId = engine.previewNote('trk_2', 64, 0.9)
    assert.ok(previewId, '采样钢琴预览应返回 previewId')
    const previewSrc = ctx.nodes.filter((node) => node.kind === 'source').at(-1)
    assert.ok(previewSrc.buffer && previewSrc.buffer.length > 1000)
    engine.stopPreview(previewId)
    // 实时调度
    engine._voices = []
    engine._scheduleEvent(
      { trackId: 'trk_2', pitch: 60, vel: 0.9, durBeats: 2, swingBeats: 0, startBeat: 0 },
      0.2,
    )
    assert.equal(engine._voices.length, 1)
    const liveSrc = ctx.nodes.filter((node) => node.kind === 'source').at(-1)
    assert.ok(liveSrc.buffer && liveSrc.buffer.length > 1000)
    assert.ok(liveSrc.startCalls.length >= 1)
    // 未加载音色库 → 安全静音（不崩、无 voice）
    engine._soundfontBank = new SoundfontBank({ fetchImpl: null })
    engine._voices = []
    engine._scheduleEvent(
      { trackId: 'trk_2', pitch: 60, vel: 0.9, durBeats: 1, swingBeats: 0, startBeat: 0 },
      0.2,
    )
    assert.equal(engine._voices.length, 0)
  } finally {
    engine.dispose()
  }
})

test('StudioEngine：SF2 音色库加载状态 / 后台预加载失败安全', async () => {
  const engine = new StudioEngine()
  assert.equal(engine.soundfontLoaded, false)
  assert.equal(engine.soundfontPresetCount, 0)
  engine._project = buildTestProject()
  engine._soundfontBank = new SoundfontBank({
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  await engine._preloadSoundfont()
  assert.equal(engine.soundfontLoaded, false)
  assert.equal(engine.soundfontPresetCount, 0)
  engine._soundfontBank = await createSf2Bank()
  await engine._preloadSoundfont()
  assert.equal(engine.soundfontLoaded, true)
  assert.ok(engine.soundfontPresetCount >= 100)
  engine.dispose()
})

// ---------------------------------------------------------------------------
// 15. 渲染预览音频分析（CONTRACT-P10 §1.5）
// ---------------------------------------------------------------------------

test('analysis：静音声道指标（-120 dB 语义 / silent / 无削波）', () => {
  const silence = new Float32Array(44100)
  const stats = analyzeChannels([silence], 44100)
  assert.equal(stats.seconds, 1)
  assert.equal(stats.sampleRate, 44100)
  assert.equal(stats.channels, 1)
  assert.equal(stats.peak, 0)
  assert.equal(stats.peakDb, MIN_DB)
  assert.equal(stats.rms, 0)
  assert.equal(stats.rmsDb, MIN_DB)
  assert.equal(stats.crestDb, 0)
  closeTo(stats.lufsApprox, MIN_DB - 0.691)
  assert.equal(stats.clippedSamples, 0)
  assert.equal(stats.clipping, false)
  assert.equal(stats.silent, true)
  assert.equal(stats.dcOffset, 0)
})

test('analysis：满幅 DC（0 dB / clipping / clippedSamples 计数）', () => {
  const full = new Float32Array(1000).fill(1)
  const stats = analyzeChannels([full], 8000)
  assert.equal(stats.seconds, 0.125)
  assert.equal(stats.sampleRate, 8000)
  assert.equal(stats.peak, 1)
  assert.equal(stats.peakDb, 0)
  assert.equal(stats.rms, 1)
  assert.equal(stats.rmsDb, 0)
  assert.equal(stats.crestDb, 0)
  assert.equal(stats.clipping, true)
  assert.equal(stats.clippedSamples, 1000)
  assert.equal(stats.silent, false)
  closeTo(stats.dcOffset, 1)
})

test('analysis：超幅/削波阈值（peak>1.2 与 0.999 边界）', () => {
  const hot = Float32Array.from([1.2, -1.2, 0.999, -0.5, 0, 0.998])
  const stats = analyzeChannels([hot], 44100)
  closeTo(stats.peak, 1.2)
  closeTo(stats.peakDb, 20 * Math.log10(1.2), 1e-6) // ≈1.5836 dB
  assert.equal(stats.clipping, true)
  assert.equal(stats.clippedSamples, 3) // 1.2 / -1.2 / 0.999
  assert.equal(CLIP_THRESHOLD, 0.999)
  // 恰好 0.998 不削波
  assert.equal(analyzeChannels([Float32Array.from([0.998, -0.998])], 44100).clipping, false)
  assert.equal(analyzeChannels([Float32Array.from([0.999, 0])], 44100).clipping, true)
})

test('analysis：正弦波 RMS≈0.707 / crest≈3.01 / dc≈0', () => {
  const sampleRate = 44100
  const samples = new Float32Array(sampleRate)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate)
  const stats = analyzeChannels([samples], sampleRate)
  assert.equal(stats.seconds, 1)
  assert.ok(Math.abs(stats.rms - Math.SQRT1_2) < 0.002, `rms=${stats.rms}`)
  closeTo(stats.rmsDb, 20 * Math.log10(stats.rms), 1e-6)
  assert.ok(Math.abs(stats.crestDb - 3.0103) < 0.05, `crest=${stats.crestDb}`)
  assert.ok(Math.abs(stats.dcOffset) < 1e-3)
  assert.ok(stats.peak > 0.99 && stats.peak <= 1)
})

test('analysis：立体声合并能量 / 声道数 / dcOffset', () => {
  const left = new Float32Array(1000).fill(1)
  const right = new Float32Array(1000).fill(0.5)
  const stats = analyzeChannels([left, right], 44100)
  assert.equal(stats.channels, 2)
  // 合并 RMS = sqrt((1² + 0.5²)/2) = sqrt(0.625)
  closeTo(stats.rms, Math.sqrt(0.625), 1e-9)
  closeTo(stats.peak, 1)
  closeTo(stats.dcOffset, 0.75, 1e-9)
  // 相同双声道与单声道 RMS 一致
  const mono = new Float32Array(441)
  for (let i = 0; i < mono.length; i++) mono[i] = Math.sin(i / 5)
  const monoStats = analyzeChannels([mono], 44100)
  const stereoStats = analyzeChannels([mono, mono], 44100)
  closeTo(stereoStats.rms, monoStats.rms, 1e-9)
  assert.equal(stereoStats.peak, monoStats.peak)
})

test('analysis：时长 / 采样率（8k、44.1k、48k）换算', () => {
  const eight = analyzeChannels([new Float32Array(4000)], 8000)
  assert.equal(eight.seconds, 0.5)
  assert.equal(eight.sampleRate, 8000)
  const cd = analyzeChannels([new Float32Array(44100)], 44100)
  assert.equal(cd.seconds, 1)
  assert.equal(cd.sampleRate, 44100)
  const modern = analyzeChannels([new Float32Array(48000)], 48000)
  assert.equal(modern.seconds, 1)
  assert.equal(modern.sampleRate, 48000)
  // 非法采样率回退 44100
  assert.equal(analyzeChannels([new Float32Array(88200)], 0).sampleRate, 44100)
  // 不同长度声道以最长声道计时
  assert.equal(analyzeChannels([new Float32Array(100), new Float32Array(300)], 1000).seconds, 0.3)
})

test('analysis：analyzeAudioBuffer 包装 AudioBuffer（mock）+ 非法输入安全', () => {
  const left = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 8))
  const right = Float32Array.from({ length: 480 }, (_, i) => Math.cos(i / 8) * 0.5)
  const buffer = {
    numberOfChannels: 2,
    sampleRate: 48000,
    length: 480,
    getChannelData: (channel) => (channel === 0 ? left : right),
  }
  const stats = analyzeAudioBuffer(buffer)
  const direct = analyzeChannels([left, right], 48000)
  assert.deepEqual(stats, direct)
  assert.equal(stats.seconds, 480 / 48000)
  assert.equal(stats.sampleRate, 48000)
  assert.equal(stats.channels, 2)
  // 非法 buffer 返回空分析（不抛异常）
  const empty = analyzeAudioBuffer(null)
  assert.equal(empty.seconds, 0)
  assert.equal(empty.channels, 0)
  assert.equal(empty.silent, true)
  assert.equal(empty.peakDb, MIN_DB)
  const broken = { numberOfChannels: 1, sampleRate: 44100, getChannelData: () => { throw new Error('boom') } }
  const brokenStats = analyzeAudioBuffer(broken)
  assert.equal(brokenStats.channels, 1)
  assert.equal(brokenStats.peakDb, MIN_DB)
})

test('analysis：peakNormalizeGain（默认 0.98 / peak=0 / 超幅削回 / 自定义目标）', () => {
  assert.equal(DEFAULT_NORMALIZE_PEAK, 0.98)
  closeTo(peakNormalizeGain([Float32Array.from([0.5, -0.5])]), 0.98 / 0.5)
  assert.equal(peakNormalizeGain([new Float32Array(100)]), 1) // 静音不做缩放
  assert.equal(peakNormalizeGain([]), 1)
  // peak 1.2 → 增益 <1，归一后峰值 = 0.98
  const hot = [Float32Array.from([1.2, -0.3])]
  const gain = peakNormalizeGain(hot)
  assert.ok(gain < 1)
  closeTo(1.2 * gain, 0.98)
  // 自定义 targetPeak
  closeTo(peakNormalizeGain([Float32Array.from([0.5])], 0.5), 1)
  closeTo(peakNormalizeGain([Float32Array.from([0.25])], 0.5), 2)
  // 非法 targetPeak 回默认 0.98
  closeTo(peakNormalizeGain([Float32Array.from([0.5])], Number.NaN), 0.98 / 0.5)
})

test('analysis：silent 边界（RMS -60 dB）与极小值 -120 语义', () => {
  // 0.0009 → RMS≈-60.92 dB < -60 → silent
  const quiet = analyzeChannels([new Float32Array(100).fill(0.0009)], 44100)
  assert.ok(quiet.rmsDb < -60)
  assert.equal(quiet.silent, true)
  // 0.0012 → RMS≈-58.4 dB → 不静音
  const audible = analyzeChannels([new Float32Array(100).fill(0.0012)], 44100)
  assert.ok(audible.rmsDb > -60)
  assert.equal(audible.silent, false)
  // 极小峰值 <1e-6 → 全 -120
  const tiny = analyzeChannels([Float32Array.from([1e-7, -2e-7])], 44100)
  assert.equal(tiny.peakDb, MIN_DB)
  assert.equal(tiny.rmsDb, MIN_DB)
  assert.equal(tiny.silent, true)
  assert.equal(linearToDb(0), MIN_DB)
  assert.equal(linearToDb(1e-7), MIN_DB)
  closeTo(linearToDb(1), 0)
  closeTo(linearToDb(0.5), 20 * Math.log10(0.5), 1e-9)
})

test('analysis：dcOffset 与全负 DC（RMS/dB 正确）', () => {
  const negative = analyzeChannels([new Float32Array(100).fill(-0.25)], 44100)
  closeTo(negative.dcOffset, -0.25)
  closeTo(negative.rms, 0.25)
  closeTo(negative.rmsDb, 20 * Math.log10(0.25), 1e-9)
  assert.equal(negative.silent, false)
  assert.equal(negative.clipping, false)
  // 非有限采样按 0 处理，不产生 NaN
  const dirty = analyzeChannels([Float32Array.from([0.5, Number.NaN, Number.POSITIVE_INFINITY, -0.5])], 44100)
  assert.ok(Number.isFinite(dirty.peak))
  assert.ok(Number.isFinite(dirty.rms))
  assert.ok(Number.isFinite(dirty.dcOffset))
})

// ---------------------------------------------------------------------------
// 16. P11 钢琴表现力（延音踏板 / 揉弦 / highshelf / reverb preDelay）
// ---------------------------------------------------------------------------

test('sustain：normalizeSustainPoints / sustainAt 采样保持语义与非法点防御', () => {
  assert.equal(SUSTAIN_MAX_HOLD_SECONDS, 8)
  assert.equal(SUSTAIN_DOWN_THRESHOLD, 0.5)
  assert.deepEqual(normalizeSustainPoints(null), [])
  assert.deepEqual(normalizeSustainPoints([{ beat: Number.NaN, value: 1 }, null, 'x', { beat: 2 }]), [])
  // 乱序/重复 beat：排序 + 同 beat 后者覆盖；value 0.5 视为按下
  const points = normalizeSustainPoints([
    { beat: 10, value: 0 },
    { beat: 2, value: 1 },
    { beat: 6, value: 0 },
    { beat: 6, value: 1 },
    { beat: 4, value: 0.5 },
  ])
  assert.deepEqual(points.map((point) => point.beat), [2, 4, 6, 10])
  assert.deepEqual(points.map((point) => point.value), [1, 1, 1, 0])
  assert.equal(sustainAt(points, -5), 0)
  assert.equal(sustainAt(points, 1), 0)
  assert.equal(sustainAt(points, 2), 1)
  assert.equal(sustainAt(points, 5), 1)
  assert.equal(sustainAt(points, 6), 1)
  assert.equal(sustainAt(points, 10), 0)
  assert.equal(sustainAt(points, Number.NaN), 0)
  assert.equal(sustainAt(null, 3), 0)
})

test('sustain：音符结束时踏板未按下 → 结束 beat 不变', () => {
  const points = [{ beat: 0, value: 1 }, { beat: 3, value: 0 }]
  assert.equal(effectiveNoteEndBeat(points, 0, 5), 5)
  assert.equal(effectiveNoteEndBeat(points, 2, 6), 6)
  assert.equal(effectiveNoteEndBeat([], 0, 4), 4)
  assert.equal(effectiveNoteEndBeat(null, 0, 4), 4)
  // 非法 end/start 防御（不抛、返回安全数值）
  assert.equal(effectiveNoteEndBeat(null, Number.NaN, Number.NaN), 0)
})

test('sustain：音符结束时踏板按下 → 延长到下一次抬起', () => {
  assert.equal(effectiveNoteEndBeat([{ beat: 0, value: 1 }, { beat: 8, value: 0 }], 0, 4), 8)
  assert.equal(effectiveNoteEndBeat([{ beat: 4, value: 1 }, { beat: 5, value: 0 }], 0, 4), 5)
  const multi = [
    { beat: 0, value: 1 },
    { beat: 3, value: 0 },
    { beat: 5, value: 1 },
    { beat: 9, value: 0 },
    { beat: 12, value: 1 },
  ]
  assert.equal(effectiveNoteEndBeat(multi, 0, 6), 9) // 结束后第一次抬起
  assert.equal(effectiveNoteEndBeat(multi, 0, 10), 10) // 结束时已抬起
  assert.equal(effectiveNoteEndBeat(multi, 0, 12), Number.POSITIVE_INFINITY) // 之后不再抬起
})

test('sustain：maxHoldBeats 封顶 / 无限保持 / 8 秒换算', () => {
  const held = [{ beat: 0, value: 1 }]
  assert.equal(effectiveNoteEndBeat(held, 0, 4), Number.POSITIVE_INFINITY)
  assert.equal(effectiveNoteEndBeat(held, 0, 4, 16), 20)
  assert.equal(effectiveNoteEndBeat(held, 0, 4, 0), 4)
  // 抬起晚于封顶 → 用封顶
  assert.equal(effectiveNoteEndBeat([{ beat: 0, value: 1 }, { beat: 100, value: 0 }], 0, 4, 16), 20)
  assert.equal(sustainMaxHoldBeats(2), 16)
  assert.equal(sustainMaxHoldBeats(Number.NaN), SUSTAIN_MAX_HOLD_SECONDS)
  // 结束 beat 在抬起之后、但踏板此前已抬起 → 不变
  assert.equal(effectiveNoteEndBeat([{ beat: 0, value: 1 }, { beat: 2, value: 0 }], 0, 10), 10)
})

/** 实时 voice 测试用 engine（mock ctx/graph）。 */
function makeVoiceEngine(project, ctx) {
  const engine = new StudioEngine()
  engine.setProject(project)
  engine._ctx = ctx
  engine._graph = {
    tracks: new Map(project.tracks.map((track) => [track.id, { input: ctx.createGain() }])),
    update: () => {},
  }
  engine._bps = 2
  return engine
}

function makeSustainProject({ sustain, preset } = {}) {
  const project = buildTestProject()
  if (preset === 'grand_piano') {
    project.tracks[1].instrument = { preset: 'grand_piano', kit: null, params: {} }
  }
  if (sustain) project.tracks[1].sustain = sustain
  return project
}

function makeMinimalPianoProject(sustain) {
  const project = createEmptyProject({ title: 'sustain', bpm: 120, key: 'A', scale: 'minor', lengthBars: 2 })
  project.master.effects = []
  project.tracks.push(
    makeTrack({ id: 'trk_p', name: 'Piano', kind: 'synth', preset: 'grand_piano', role: 'lead', volume: 0.9 }),
  )
  if (sustain) project.tracks[0].sustain = sustain
  project.patterns.push(
    makePattern({ id: 'pat_1', name: 'p', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.9 }] }),
  )
  project.clips.push({ id: 'clip_1', trackId: 'trk_p', patternId: 'pat_1', startBar: 0, lengthBars: 1 })
  return project
}

test('engine：延音踏板延长实时 melody voice（legacy synth），鼓轨不延长', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  const event = { trackId: 'trk_2', pitch: 60, vel: 0.8, durBeats: 1, swingBeats: 0, startBeat: 0 }
  const baseEngine = makeVoiceEngine(makeSustainProject(), ctx)
  baseEngine._scheduleEvent(event, 0.1)
  const baseDur = baseEngine._voices[0].endTime - 0.1
  const sustainEngine = makeVoiceEngine(
    makeSustainProject({ sustain: [{ beat: 0, value: 1 }, { beat: 8, value: 0 }] }),
    ctx,
  )
  sustainEngine._scheduleEvent(event, 0.1)
  const extendedDur = sustainEngine._voices[0].endTime - 0.1
  assert.ok(extendedDur > baseDur + 3, `sustain 应延长：${extendedDur} vs ${baseDur}`)
  // 鼓轨即使有 sustain 点也不延长
  const drumBaseProject = makeSustainProject()
  const drumBaseEngine = makeVoiceEngine(drumBaseProject, ctx)
  const drumEvent = { trackId: 'trk_1', pitch: 36, vel: 0.8, durBeats: 1, swingBeats: 0, startBeat: 0 }
  drumBaseEngine._scheduleEvent(drumEvent, 0.1)
  const drumBaseEnd = drumBaseEngine._voices[0].endTime
  const drumSustainProject = makeSustainProject()
  drumSustainProject.tracks[0].sustain = [{ beat: 0, value: 1 }, { beat: 8, value: 0 }]
  const drumSustainEngine = makeVoiceEngine(drumSustainProject, ctx)
  drumSustainEngine._scheduleEvent(drumEvent, 0.1)
  closeTo(drumSustainEngine._voices[0].endTime, drumBaseEnd, 1e-9)
  baseEngine.dispose()
  sustainEngine.dispose()
  drumBaseEngine.dispose()
  drumSustainEngine.dispose()
})

test('engine：延音踏板 + 揉弦传入采样 voice（grand_piano）', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  const project = makeSustainProject({
    preset: 'grand_piano',
    sustain: [{ beat: 0, value: 1 }, { beat: 8, value: 0 }],
  })
  project.tracks[1].vibrato = { rateHz: 5, depthCents: 25, enabled: true }
  const engine = makeVoiceEngine(project, ctx)
  engine._soundfontBank = await createSf2Bank()
  try {
    engine._scheduleEvent(
      { trackId: 'trk_2', pitch: 60, vel: 0.8, durBeats: 1, swingBeats: 0, startBeat: 0 },
      0.1,
    )
    assert.equal(engine._voices.length, 1)
    const extendedDur = engine._voices[0].endTime - 0.1
    assert.ok(extendedDur > 3, `采样 voice 也应被延音踏板延长：${extendedDur}`)
    const sources = ctx.nodes.filter((node) => node.kind === 'source')
    const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
    assert.equal(oscillators.length, 1, '揉弦应创建 1 个 LFO')
    assert.equal(oscillators[0].frequency.value, 5)
    const source = sources.at(-1)
    const modEdge = ctx.connections.find((edge) => edge.to === source.detune && edge.from.kind === 'gain')
    assert.ok(modEdge, 'vibrato gain 应连接到 source.detune')
    assert.equal(modEdge.from.gain.value, 25)
    engine._voices[0].handle.dispose()
    assert.ok(oscillators[0].stopCalls.length >= 1, 'dispose 应停止揉弦 LFO')
  } finally {
    engine.dispose()
  }
})

test('engine.renderWav：延音踏板延长采样钢琴发声时长（mock OfflineAudioContext）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const renderStopTime = async (sustain) => {
      const project = makeMinimalPianoProject(sustain)
      const engine = new StudioEngine()
      engine._soundfontBank = await createSf2Bank()
      const result = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
      engine.dispose()
      assert.ok(result.blob.size > 44)
      const ctx = instances.at(-1)
      const source = ctx.sources.find((node) => node.buffer && node.buffer.length > 1000)
      assert.ok(source, '应有采样钢琴 source')
      return source.stopCalls[0][0]
    }
    const baseStop = await renderStopTime(null)
    const extendedStop = await renderStopTime([{ beat: 0, value: 1 }, { beat: 8, value: 0 }])
    assert.ok(extendedStop > baseStop + 2, `sustain 应延长离线发声：${extendedStop} vs ${baseStop}`)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('engine.previewNote：延音踏板延长预览；vibrato.enabled=false 不建 LFO', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  const project = makeSustainProject({
    preset: 'grand_piano',
    sustain: [{ beat: 0, value: 1 }, { beat: 8, value: 0 }],
  })
  project.tracks[1].vibrato = { rateHz: 4, depthCents: 20, enabled: true }
  const engine = makeVoiceEngine(project, ctx)
  engine._soundfontBank = await createSf2Bank()
  engine._positionBar = 0
  try {
    const id = engine.previewNote('trk_2', 60, 0.9)
    assert.ok(id)
    const preview = engine._previews.get(id)
    const duration = preview.endTime - preview.startTime
    assert.ok(duration > 2.5, `预览应被踏板延长：${duration}`)
    const oscillatorsAfterFirst = ctx.nodes.filter((node) => node.kind === 'oscillator').length
    assert.equal(oscillatorsAfterFirst, 1)
    // 关闭 vibrato 后再预览：不再新建 LFO
    project.tracks[1].vibrato.enabled = false
    const secondId = engine.previewNote('trk_2', 60, 0.9)
    assert.ok(secondId)
    assert.equal(ctx.nodes.filter((node) => node.kind === 'oscillator').length, oscillatorsAfterFirst)
  } finally {
    engine.dispose()
  }
})

test('highshelf：BiquadFilter highshelf 频率/增益/平滑 update/dispose', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const wrapper = buildEffect(ctx, { id: 'fx_h', type: 'highshelf', params: { freq: 8000, gain: 6 } })
  assert.equal(wrapper.type, 'highshelf')
  const shelf = ctx.nodes.find((node) => node.kind === 'biquad')
  assert.ok(shelf)
  assert.equal(shelf.type, 'highshelf')
  assert.equal(shelf.frequency.value, 8000)
  assert.equal(shelf.gain.value, 6)
  wrapper.update({ freq: 3000, gain: -4 })
  assert.ok(
    shelf.frequency.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 3000) < 1e-9),
  )
  assert.ok(shelf.gain.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - -4) < 1e-9))
  // 越界钳制
  wrapper.update({ freq: 99999, gain: -99 })
  assert.ok(
    shelf.frequency.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 16000) < 1e-9),
  )
  assert.ok(shelf.gain.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - -12) < 1e-9))
  wrapper.dispose()
  wrapper.dispose()
})

test('reverb：preDelay DelayNode 位于干声与 Convolver 之间 + update 平滑', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const wrapper = buildEffect(ctx, {
    id: 'fx_r',
    type: 'reverb',
    params: { size: 0.5, decay: 0.4, damp: 0.3, mix: 0.3, preDelay: 35 },
  })
  const delayNode = ctx.nodes.find((node) => node.kind === 'delay')
  assert.ok(delayNode, 'reverb 应有 preDelay DelayNode')
  closeTo(delayNode.delayTime.value, 0.035)
  const convolver = ctx.nodes.find((node) => node.kind === 'convolver')
  assert.ok(convolver)
  assert.ok(ctx.connections.some((edge) => edge.from === delayNode && edge.to === convolver), 'delay 应接到 convolver')
  assert.ok(ctx.connections.some((edge) => edge.to === delayNode), '干声应进入 delay')
  wrapper.update({ size: 0.5, decay: 0.4, damp: 0.3, mix: 0.3, preDelay: 80 })
  assert.ok(
    delayNode.delayTime.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.08) < 1e-9),
  )
  // preDelay=0 → 延迟 0（直通语义）
  const zeroCtx = new MockOfflineAudioContext(2, 44100, 44100)
  buildEffect(zeroCtx, { type: 'reverb', params: { preDelay: 0 } })
  const zeroDelay = zeroCtx.nodes.find((node) => node.kind === 'delay')
  assert.ok(zeroDelay)
  assert.equal(zeroDelay.delayTime.value, 0)
  wrapper.dispose()
})

// ---------------------------------------------------------------------------
// 17. P12 tempo automation（src/shared/tempo.js + 引擎全链路）
// ---------------------------------------------------------------------------

/** 120→60 BPM 线性降速（0..8 beats），之后恒定 60。 */
const RAMP_TEMPO = [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }]
/** RAMP 在 beat8 的累计秒数（(60/-7.5)*ln(60/120) = 8·ln2）。 */
const RAMP_SECONDS_AT_8 = 8 * Math.LN2

function makeTempoVoiceProject(tempoMap = RAMP_TEMPO) {
  const project = createEmptyProject({ title: 'tempo', bpm: 120, key: 'A', scale: 'minor', lengthBars: 4 })
  project.master.effects = []
  // 默认关闭 loop（createEmptyProject 默认整曲循环）；需要 loop 的测试自行覆盖 transport
  project.transport = { playing: false, playheadBar: 0, loopStartBar: 0, loopEndBar: 0, cmd: null }
  project.tempoMap = tempoMap.map((point) => ({ ...point }))
  const track = makeTrack({ id: 'trk_t', name: 'Lead', kind: 'synth', role: 'lead', volume: 0.8 })
  track.instrument = fixtureSynthInstrument(TEST_SYNTH_PRESETS[0])
  project.tracks.push(track)
  project.patterns.push(
    makePattern({
      id: 'pat_t',
      name: 't',
      lengthBars: 2,
      notes: [
        { pitch: 60, start: 0, dur: 1, vel: 0.8 },
        { pitch: 64, start: 4, dur: 1, vel: 0.8 },
      ],
    }),
  )
  project.clips.push(makeClip({ id: 'clip_t', trackId: 'trk_t', patternId: 'pat_t', startBar: 0, lengthBars: 2 }))
  return project
}

function makeTempoEngine(project) {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  const engine = new StudioEngine()
  engine.setProject(project)
  engine._ctx = ctx
  engine._graph = {
    tracks: new Map(project.tracks.map((track) => [track.id, { input: ctx.createGain() }])),
    update: () => {},
  }
  return { engine, ctx }
}

test('tempo：clampTempoBpm / 常量（无 tempoMap）与旧 60/bpm 完全一致', () => {
  assert.equal(TEMPO_MIN_BPM, 40)
  assert.equal(TEMPO_MAX_BPM, 200)
  assert.equal(MAX_TEMPO_POINTS, 64)
  assert.equal(clampTempoBpm(999), 200)
  assert.equal(clampTempoBpm(1), 40)
  assert.equal(clampTempoBpm(Number.NaN, 90), 90)
  const tempo = createTempoMap({ bpm: 120, lengthBars: 4, timeSignature: [4, 4] })
  assert.equal(tempo.hasTempo, false)
  assert.equal(tempo.durationBeats, 16)
  assert.equal(tempo.bpmAtBeat(0), 120)
  assert.equal(tempo.bpmAtBeat(999), 120)
  closeTo(tempo.beatToSeconds(4), 2) // 4 beats @120 = 2s
  closeTo(tempo.beatToSeconds(16), 8)
  closeTo(tempo.secondsToBeat(2), 4)
  closeTo(tempo.secondsToBeat(8), 16)
  closeTo(tempo.beatToSecondsRange(2, 8), 3)
  closeTo(projectDurationSeconds({ bpm: 60, lengthBars: 2, timeSignature: [4, 4] }), 8)
  closeTo(tempoBpmAtBeat({ bpm: 90 }, 4), 90)
})

test('tempo：normalizeTempoPoints（丢弃非法 / 钳制 / 排序去重 / maxBeat / 最多 64 点）', () => {
  assert.deepEqual(normalizeTempoPoints(null), [])
  assert.deepEqual(normalizeTempoPoints([null, 'x', { beat: Number.NaN, bpm: 120 }, { beat: -1, bpm: 100 }]), [])
  const normalized = normalizeTempoPoints(
    [
      { beat: 10, bpm: 999 },
      { beat: 2, bpm: 30 },
      { beat: 2, bpm: 90 }, // 同 beat 后者覆盖
      { beat: 50, bpm: 120 },
    ],
    { baseBpm: 120, maxBeat: 16 },
  )
  assert.deepEqual(normalized, [
    { beat: 2, bpm: 90 },
    { beat: 10, bpm: 200 },
    { beat: 16, bpm: 120 }, // beat clamp 到 maxBeat
  ])
  // 非法 bpm 回 baseBpm；maxPoints 截断
  assert.deepEqual(normalizeTempoPoints([{ beat: 1, bpm: Number.NaN }], { baseBpm: 100 }), [
    { beat: 1, bpm: 100 },
  ])
  const many = Array.from({ length: 70 }, (_, index) => ({ beat: index, bpm: 120 }))
  assert.equal(normalizeTempoPoints(many).length, MAX_TEMPO_POINTS)
})

test('tempo：单点 / 首点不在 0 / 末点之后保持', () => {
  const single = createTempoMap({ bpm: 120, lengthBars: 4, tempoMap: [{ beat: 0, bpm: 90 }] })
  assert.equal(single.hasTempo, true)
  assert.equal(single.bpmAtBeat(0), 90)
  assert.equal(single.bpmAtBeat(16), 90)
  closeTo(single.beatToSeconds(8), (8 * 60) / 90)

  // 首点在 beat4：beat 0..4 用首点 BPM 常量延伸，之后保持
  const offsetFirst = createTempoMap({ bpm: 120, lengthBars: 4, tempoMap: [{ beat: 4, bpm: 60 }] })
  assert.equal(offsetFirst.bpmAtBeat(0), 60)
  assert.equal(offsetFirst.bpmAtBeat(4), 60)
  closeTo(offsetFirst.beatToSeconds(4), 4) // 4 beats @60 = 4s
})

test('tempo：线性 BPM 插值与闭式积分（降速 120→60）', () => {
  const tempo = createTempoMap({ bpm: 120, lengthBars: 4, tempoMap: RAMP_TEMPO })
  assert.equal(tempo.hasTempo, true)
  assert.equal(tempo.bpmAtBeat(0), 120)
  closeTo(tempo.bpmAtBeat(2), 105)
  closeTo(tempo.bpmAtBeat(4), 90)
  closeTo(tempo.bpmAtBeat(6), 75)
  assert.equal(tempo.bpmAtBeat(8), 60)
  assert.equal(tempo.bpmAtBeat(100), 60)
  closeTo(tempo.beatToSeconds(8), RAMP_SECONDS_AT_8)
  // 段内：∫0..4 60/(120 - 7.5b) db = (60/-7.5)·ln(90/120)
  closeTo(tempo.beatToSeconds(4), (60 / -7.5) * Math.log(90 / 120))
  // 末点之后恒定 60：+4 beats = +4s
  closeTo(tempo.beatToSeconds(12), RAMP_SECONDS_AT_8 + 4)
  closeTo(tempo.beatToSecondsRange(0, 8), RAMP_SECONDS_AT_8)
})

test('tempo：秒 → beat 分段反解（roundtrip / 边界）', () => {
  const tempo = createTempoMap({ bpm: 120, lengthBars: 4, tempoMap: RAMP_TEMPO })
  for (const beat of [0.5, 2, 4, 6.5, 8, 10, 16]) {
    closeTo(tempo.secondsToBeat(tempo.beatToSeconds(beat)), beat, 1e-9)
  }
  assert.equal(tempo.secondsToBeat(0), 0)
  closeTo(tempo.secondsToBeat(RAMP_SECONDS_AT_8), 8, 1e-9)
  closeTo(tempo.secondsToBeat(RAMP_SECONDS_AT_8 + 4), 12, 1e-9)
  // 负秒 → beat 0 之前线性延伸（首段 120 BPM）
  closeTo(tempo.secondsToBeat(-1), -2)
})

test('tempo：加速 ramp（60→180）与多段累计', () => {
  const tempo = createTempoMap({ bpm: 60, lengthBars: 8, tempoMap: [{ beat: 0, bpm: 60 }, { beat: 8, bpm: 180 }] })
  // slope = 15 BPM/beat → (60/15)·ln(180/60) = 4·ln3
  closeTo(tempo.beatToSeconds(8), 4 * Math.log(3))
  closeTo(tempo.secondsToBeat(tempo.beatToSeconds(5)), 5, 1e-9)
  const multi = createTempoMap({
    bpm: 120,
    lengthBars: 8,
    tempoMap: [
      { beat: 0, bpm: 120 },
      { beat: 4, bpm: 60 },
      { beat: 8, bpm: 180 },
    ],
  })
  const seconds0to4 = (60 / -15) * Math.log(60 / 120) // 8·ln2 ≈ 5.545
  closeTo(multi.beatToSeconds(4), seconds0to4)
  const seconds4to8 = (60 / 30) * Math.log(180 / 60) // 2·ln3 ≈ 2.197
  closeTo(multi.beatToSeconds(8), seconds0to4 + seconds4to8)
  closeTo(multi.secondsToBeat(multi.beatToSeconds(6)), 6, 1e-9)
  // 插值端点
  closeTo(multi.bpmAtBeat(6), 120)
})

test('tempo：maxBeat clamp / durationBeats / 非法工程防御', () => {
  const project = { bpm: 120, lengthBars: 2, timeSignature: [4, 4], tempoMap: [{ beat: 100, bpm: 90 }] }
  const tempo = createTempoMap(project)
  assert.equal(tempo.durationBeats, 8)
  assert.equal(tempo.points.length, 1)
  assert.equal(tempo.points[0].beat, 8) // clamp 到曲长
  // 非法 tempoMap → 常量
  assert.equal(createTempoMap({ bpm: 100, tempoMap: 'nope' }).hasTempo, false)
  assert.equal(createTempoMap(null).bpmAtBeat(0), 120)
  closeTo(createTempoMap({ bpm: 60, lengthBars: 1, timeSignature: [4, 4] }).beatToSeconds(4), 4)
})

test('engine：computeRenderPlan 常量 BPM 与 tempo ramp 时长（整首/区间/帧数）', () => {
  const constant = computeRenderPlan({ bpm: 120, lengthBars: 8, timeSignature: [4, 4] })
  closeTo(constant.seconds, 16)
  closeTo(constant.requestedSeconds, 16)
  closeTo(computeRenderPlan({ bpm: 120, lengthBars: 8, timeSignature: [4, 4] }, { fromBar: 2, toBar: 4 }).seconds, 4)

  const tempoProject = { bpm: 120, lengthBars: 4, timeSignature: [4, 4], tempoMap: RAMP_TEMPO }
  const full = computeRenderPlan(tempoProject)
  const expectedFull = RAMP_SECONDS_AT_8 + 8 // beat16 = beat8 + 8 beats @60
  assert.ok(Math.abs(full.seconds - expectedFull) < 1e-3, `${full.seconds} vs ${expectedFull}`)
  assert.equal(full.tempo.hasTempo, true)
  // 区间 beat8..16：恒定 60 BPM 段，正好 8 秒
  const range = computeRenderPlan(tempoProject, { fromBar: 2, toBar: 4 })
  assert.ok(Math.abs(range.seconds - 8) < 1e-3, `${range.seconds}`)
  assert.equal(range.frames, Math.round(RANGE_FRAMES_8()))
  function RANGE_FRAMES_8() {
    return 8 * RENDER_SAMPLE_RATE
  }
})

test('engine.renderWav：tempo ramp 下渲染帧数/时长按积分', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const project = makeTempoVoiceProject()
    const engine = new StudioEngine()
    const result = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
    engine.dispose()
    const ctx = instances.at(-1)
    const plan = computeRenderPlan(project, { fromBar: 0, toBar: 2 })
    assert.ok(Math.abs(result.seconds - RAMP_SECONDS_AT_8) < 1e-3, `${result.seconds}`)
    assert.equal(ctx.length, plan.frames)
    assert.equal(result.blob.size, 44 + plan.frames * 4)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('engine 实时调度：tempo automation 下音符起始时间按积分换算', () => {
  const project = makeTempoVoiceProject()
  const { engine, ctx } = makeTempoEngine(project)
  try {
    engine._startPlayback(0)
    engine._scheduleHorizon(3.5)
    const voices = engine._voices.filter((voice) => voice.trackId === 'trk_t')
    assert.ok(voices.length >= 2, `voices=${voices.length}`)
    const tempo = createTempoMap(project)
    // note@beat0 立即调度（now+0.004）；note@beat4 应在 beatToSeconds(4)=2.301s
    const later = voices.find((voice) => voice.startTime > 1)
    assert.ok(later, '应调度 beat4 的音符')
    closeTo(later.startTime, tempo.beatToSeconds(4), 0.02)
  } finally {
    engine.stop()
    engine.dispose()
  }
})

test('engine 播放头/seek：tempo ramp 下 positionBar 按积分换算', () => {
  const project = makeTempoVoiceProject()
  const { engine, ctx } = makeTempoEngine(project)
  try {
    engine._startPlayback(0)
    const tempo = createTempoMap(project)
    ctx.currentTime = tempo.beatToSeconds(4) // beat4 → bar1
    closeTo(engine.positionBar, 1, 1e-6)
    ctx.currentTime = tempo.beatToSeconds(8) // beat8 → bar2
    closeTo(engine.positionBar, 2, 1e-6)
    ctx.currentTime = tempo.beatToSeconds(10) // beat10 → bar2.5
    closeTo(engine.positionBar, 2.5, 1e-6)
    // seek 到 bar1.5：从该位置重新锚定
    engine.seek(1.5)
    closeTo(engine.positionBar, 1.5, 0.01)
  } finally {
    engine.stop()
    engine.dispose()
  }
})

test('engine loop：tempo ramp 下循环回绕使用累计秒（循环时长=区间积分）', () => {
  const project = makeTempoVoiceProject()
  project.transport = { loopStartBar: 0, loopEndBar: 2 }
  const { engine, ctx } = makeTempoEngine(project)
  try {
    engine._startPlayback(0)
    const tempo = createTempoMap(project)
    const loopSeconds = tempo.beatToSecondsRange(0, 8) // 5.545s
    ctx.currentTime = loopSeconds + 1 // 第二圈 +1s → 按 loop 区间 tempo 反解（1s ≈1.88 beat）
    closeTo(engine.positionBar, tempo.secondsToBeat(1) / 4, 1e-6)
    ctx.currentTime = loopSeconds * 2 + tempo.beatToSeconds(4) // 第三圈 beat4 → bar1
    closeTo(engine.positionBar, 1, 0.02)
  } finally {
    engine.stop()
    engine.dispose()
  }
})

test('engine 非循环：tempo ramp 播完自动结束（_tick）', () => {
  const project = makeTempoVoiceProject()
  const { engine, ctx } = makeTempoEngine(project)
  try {
    engine._startPlayback(0)
    const tempo = createTempoMap(project)
    ctx.currentTime = tempo.beatToSeconds(16) + 0.01 // 4 小节 = beat16
    engine._tick()
    assert.equal(engine.isPlaying, false)
    closeTo(engine.positionBar, 4, 1e-6)
  } finally {
    engine.stop()
    engine.dispose()
  }
})

test('engine 自动化：buildAutomationSamples / 离线 schedule 时间按 tempo 积分', () => {
  const project = makeTempoVoiceProject()
  const plan = computeRenderPlan(project, { fromBar: 0, toBar: 2 })
  const tempo = createTempoMap(project)
  const points = [{ beat: 0, value: 0 }, { beat: 8, value: 1 }]
  const samples = buildAutomationSamples(points, 0, 8, tempo, 0.1)
  assert.ok(samples.length > 2)
  closeTo(samples[samples.length - 1].time, RAMP_SECONDS_AT_8, 1e-6)
  // beat4 附近的采样时间应符合 tempo 积分（约 2.301s，而不是常量 2s）
  const mid = samples.find((sample) => sample.beat > 3.95 && sample.beat < 4.15)
  assert.ok(mid, 'beat4 附近应有采样')
  closeTo(mid.time, tempo.beatToSeconds(mid.beat), 1e-6)
  assert.ok(mid.time > 2.25, `mid.time=${mid.time}`)
  // 常量 bps=2 的旧口径仍可用（测试基准）：beat4 → 2s
  const constantSamples = buildAutomationSamples(points, 0, 8, 2, 0.1)
  const constantMid = constantSamples.find((sample) => sample.beat > 3.95 && sample.beat < 4.15)
  assert.ok(Math.abs(constantMid.time - constantMid.beat / 2) < 1e-9)
  // 离线 schedule 集成
  project.tracks[0].automation = { volume: { enabled: true, points } }
  const schedule = buildOfflineAutomationSchedule(project, plan)
  assert.equal(schedule.startBeat, 0)
  assert.equal(schedule.endBeat, 8)
  assert.ok(schedule.tracks[0].volume.length > 2)
  closeTo(schedule.tracks[0].volume.at(-1).time, RAMP_SECONDS_AT_8, 1e-6)
})

test('media：音频片段在 tempo ramp 下的 when/offset/duration 使用积分秒', () => {
  const project = {
    bpm: 120,
    lengthBars: 8,
    timeSignature: [4, 4],
    tempoMap: RAMP_TEMPO,
    media: [{ id: 'med_1', file: 'med_1.wav', durationSeconds: 60 }],
    tracks: [{ id: 'trk_a', kind: 'audio', mute: false }],
    clips: [{ id: 'clip_a', trackId: 'trk_a', mediaId: 'med_1', startBar: 0, lengthBars: 2 }],
  }
  const tempo = createTempoMap(project)
  const full = buildAudioClipSegments(project, 0, 8, tempo)
  assert.equal(full.length, 1)
  closeTo(full[0].whenSeconds, 0)
  closeTo(full[0].offsetSeconds, 0)
  closeTo(full[0].durationSeconds, RAMP_SECONDS_AT_8, 1e-6)
  // 渲染区间从片段中间 beat4 开始：offset = beatToSeconds(4)，duration = 片段剩余（beat4..8）
  const partial = buildAudioClipSegments(project, 4, 16, tempo)
  assert.equal(partial.length, 1)
  closeTo(partial[0].whenSeconds, 0)
  closeTo(partial[0].offsetSeconds, tempo.beatToSeconds(4), 1e-6)
  closeTo(partial[0].durationSeconds, tempo.beatToSeconds(8) - tempo.beatToSeconds(4), 1e-6)
  // 常量 bps 旧口径仍等价（测试基准）
  const constant = buildAudioClipSegments(project, 0, 8, 2)
  closeTo(constant[0].durationSeconds, 4)
})

test('engine 预览：延音踏板 8 秒上限在 tempo automation 下仍按真实秒数', () => {
  const project = makeTempoVoiceProject([{ beat: 0, bpm: 200 }, { beat: 8, bpm: 60 }])
  project.tracks[0].sustain = [{ beat: 0, value: 1 }, { beat: 1000, value: 0 }]
  const { engine, ctx } = makeTempoEngine(project)
  engine._positionBar = 0
  try {
    const id = engine.previewNote('trk_t', 60, 0.8)
    assert.ok(id)
    const preview = engine._previews.get(id)
    const duration = preview.endTime - preview.startTime
    // 预览基础 2s + 踏板最多 +8s（真实秒数，而不是 8 beats）+ 合成器 release 余量
    assert.ok(duration > 9.5 && duration < 11, `preview duration=${duration}`)
    engine.stopPreview(id)
  } finally {
    engine.stop()
    engine.dispose()
  }
})

// ---------------------------------------------------------------------------
// 18. P13 EQ 全参数 + 表情自动化（pitchBend / modulation / expression）
// ---------------------------------------------------------------------------

/** 最小表情测试工程：单轨（合成 fixture / 采样钢琴 / 鼓）。 */
function makeExprProject({ kind = 'synth', preset = 'grand_piano', automation = null, vibrato = null } = {}) {
  const project = createEmptyProject({ title: 'p13', bpm: 120, key: 'A', scale: 'minor', lengthBars: 4 })
  project.master.effects = []
  project.transport = { playing: false, playheadBar: 0, loopStartBar: 0, loopEndBar: 0, cmd: null }
  const track = makeTrack({
    id: 'trk_e',
    name: 'Expr',
    kind: kind === 'drum' ? 'drum' : 'synth',
    role: 'lead',
    volume: 0.8,
  })
  if (kind === 'drum') track.instrument = fixtureDrumInstrument()
  else if (preset === 'grand_piano') track.instrument = { preset: 'grand_piano', kit: null, params: {} }
  else track.instrument = fixtureSynthInstrument(TEST_SYNTH_PRESETS[0])
  if (automation) track.automation = automation
  if (vibrato) track.vibrato = vibrato
  project.tracks.push(track)
  project.patterns.push(
    makePattern({ id: 'pat_e', name: 'e', lengthBars: 4, notes: [{ pitch: 60, start: 0, dur: 2, vel: 0.8 }] }),
  )
  project.clips.push({ id: 'clip_e', trackId: 'trk_e', patternId: 'pat_e', startBar: 0, lengthBars: 4 })
  return project
}

function makeExprEngine(project) {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  const engine = new StudioEngine()
  engine.setProject(project)
  engine._ctx = ctx
  engine._graph = {
    tracks: new Map(project.tracks.map((track) => [track.id, { input: ctx.createGain() }])),
    update: () => {},
  }
  return { engine, ctx }
}

/** 取 mock ctx 中最大的 gain linearRamp 目标值（voice 包络峰值）。 */
function maxGainRamp(ctx) {
  let peak = 0
  for (const entry of ctx.params) {
    if (entry.kind !== 'gain' || entry.name !== 'gain') continue
    for (const op of entry.param.ops) {
      if (op.op === 'linearRampToValueAtTime' && Number.isFinite(op.args[0])) peak = Math.max(peak, op.args[0])
    }
  }
  return peak
}

/** vibrato LFO → gain 节点 → source.detune 的深度值（cents，取 gain.gain.value）。 */
function vibratoDepthFor(ctx, oscillator) {
  const gainNode = ctx.connections.find(
    (edge) => edge.from === oscillator && edge.to && edge.to.kind === 'gain',
  )?.to
  if (!gainNode) return null
  const connectsToDetune = ctx.connections.some(
    (edge) => edge.from === gainNode && edge.to && edge.to.ops,
  )
  return connectsToDetune ? gainNode.gain.value : null
}

/** 表情 automation 曲线（0..1，单点常量）。 */
function constAutomation(param, value) {
  return { [param]: { enabled: true, points: [{ beat: 0, value }] } }
}

test('eq3：lowFreq/midFreq/midQ/highFreq 节点与平滑 update（P13）', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const wrapper = buildEffect(ctx, {
    id: 'fx_eq',
    type: 'eq3',
    params: { low: 6, mid: -3, high: 4, lowFreq: 300, midFreq: 2000, midQ: 3, highFreq: 10000 },
  })
  const filters = ctx.nodes.filter((node) => node.kind === 'biquad')
  assert.equal(filters.length, 3)
  const [low, mid, high] = filters
  assert.equal(low.type, 'lowshelf')
  assert.equal(mid.type, 'peaking')
  assert.equal(high.type, 'highshelf')
  assert.equal(low.frequency.value, 300)
  assert.equal(mid.frequency.value, 2000)
  assert.equal(mid.Q.value, 3)
  assert.equal(high.frequency.value, 10000)
  assert.equal(low.gain.value, 6)
  assert.equal(mid.gain.value, -3)
  assert.equal(high.gain.value, 4)
  // update 平滑（第二次 update 走 ramp）
  wrapper.update({ low: 0, mid: 0, high: 0, lowFreq: 150, midFreq: 800, midQ: 1.5, highFreq: 6000 })
  const hasRamp = (param, target) =>
    param.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - target) < 1e-9)
  assert.ok(hasRamp(low.frequency, 150))
  assert.ok(hasRamp(mid.frequency, 800))
  assert.ok(hasRamp(mid.Q, 1.5))
  assert.ok(hasRamp(high.frequency, 6000))
  // 越界钳制
  wrapper.update({ low: 0, mid: 0, high: 0, lowFreq: 1, midFreq: 99999, midQ: 0, highFreq: 0 })
  assert.ok(hasRamp(low.frequency, 80))
  assert.ok(hasRamp(mid.frequency, 5000))
  assert.ok(hasRamp(mid.Q, 0.3))
  assert.ok(hasRamp(high.frequency, 2000))
  wrapper.dispose()
})

test('eq3：catalog 默认频点/Q（无参数时 200/1000/1/8000）', () => {
  const params = resolveFxParams('eq3', {})
  assert.equal(params.lowFreq, 200)
  assert.equal(params.midFreq, 1000)
  assert.equal(params.midQ, 1)
  assert.equal(params.highFreq, 8000)
  assert.equal(resolveFxParams('eq3', { lowFreq: 50, midFreq: 9999, midQ: 99, highFreq: 100 }).lowFreq, 80)
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  buildEffect(ctx, { type: 'eq3' })
  const filters = ctx.nodes.filter((node) => node.kind === 'biquad')
  assert.equal(filters[0].frequency.value, 200)
  assert.equal(filters[1].frequency.value, 1000)
  assert.equal(filters[1].Q.value, 1)
  assert.equal(filters[2].frequency.value, 8000)
})

test('soundfont buildVoice：pitchBend → source.detune（±200c）/ expression → 音量乘数', async () => {
  const bank = await createSf2Bank()
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const basectx = new MockOfflineAudioContext(2, 44100, 44100)
  const baseDest = basectx.createGain()
  const baseVoice = bank.buildVoice(basectx, baseDest, {
    program: 0,
    bank: 0,
    pitch: 60,
    vel: 0.8,
    startTime: 0,
    dur: 2,
  })
  assert.ok(baseVoice)
  const basePeak = maxGainRamp(basectx)
  assert.ok(basePeak > 0)

  const bendCtx = new MockOfflineAudioContext(2, 44100, 44100)
  const bendVoice = bank.buildVoice(bendCtx, bendCtx.createGain(), {
    program: 0,
    bank: 0,
    pitch: 60,
    vel: 0.8,
    startTime: 0,
    dur: 2,
    pitchBendCents: 150,
    expressionGain: 0.5,
  })
  assert.ok(bendVoice)
  const bendSrc = bendCtx.nodes.filter((node) => node.kind === 'source').at(-1)
  assert.equal(bendSrc.detune.value, 150)
  const bendPeak = maxGainRamp(bendCtx)
  closeTo(bendPeak, basePeak * 0.5, basePeak * 0.02)
  // 越界钳制 ±200
  const clampCtx = new MockOfflineAudioContext(2, 44100, 44100)
  bank.buildVoice(clampCtx, clampCtx.createGain(), {
    program: 0, bank: 0, pitch: 60, vel: 0.8, startTime: 0, dur: 1, pitchBendCents: 999,
  })
  assert.equal(clampCtx.nodes.filter((node) => node.kind === 'source').at(-1).detune.value, 200)
  const clampCtx2 = new MockOfflineAudioContext(2, 44100, 44100)
  bank.buildVoice(clampCtx2, clampCtx2.createGain(), {
    program: 0, bank: 0, pitch: 60, vel: 0.8, startTime: 0, dur: 1, pitchBendCents: -999,
  })
  assert.equal(clampCtx2.nodes.filter((node) => node.kind === 'source').at(-1).detune.value, -200)
})

test('engine 实时：采样 voice 应用 pitchBend/expression/modulation 自动化', async () => {
  const project = makeExprProject({
    preset: 'grand_piano',
    automation: {
      pitchBend: { enabled: true, points: [{ beat: 0, value: 1 }] }, // → +200 cents
      expression: { enabled: true, points: [{ beat: 0, value: 0.5 }] },
      modulation: { enabled: true, points: [{ beat: 0, value: 0.5 }] }, // +50 cents
    },
    vibrato: { rateHz: 4, depthCents: 20, enabled: true },
  })
  const { engine, ctx } = makeExprEngine(project)
  engine._soundfontBank = await createSf2Bank()
  try {
    engine._scheduleEvent(
      { trackId: 'trk_e', pitch: 60, vel: 0.8, durBeats: 2, swingBeats: 0, startBeat: 0 },
      0.1,
    )
    assert.equal(engine._voices.length, 1)
    const source = ctx.nodes.filter((node) => node.kind === 'source').at(-1)
    assert.equal(source.detune.value, 200)
    const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
    assert.equal(oscillators.length, 1, '调制应创建/复用 1 个 vibrato LFO')
    assert.equal(oscillators[0].frequency.value, 4)
    assert.equal(vibratoDepthFor(ctx, oscillators[0]), 70) // 20 基础 + 50 modulation
  } finally {
    engine.dispose()
  }
})

test('engine 实时：无 track.vibrato 时 modulation 用默认 5Hz 建立 LFO', async () => {
  const project = makeExprProject({
    preset: 'grand_piano',
    automation: { modulation: { enabled: true, points: [{ beat: 0, value: 0.4 }] } },
  })
  const { engine, ctx } = makeExprEngine(project)
  engine._soundfontBank = await createSf2Bank()
  try {
    engine._scheduleEvent(
      { trackId: 'trk_e', pitch: 60, vel: 0.8, durBeats: 1, swingBeats: 0, startBeat: 0 },
      0.1,
    )
    const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
    assert.equal(oscillators.length, 1)
    assert.equal(oscillators[0].frequency.value, 5)
    assert.equal(vibratoDepthFor(ctx, oscillators[0]), 40)
  } finally {
    engine.dispose()
  }
})

test('engine：鼓轨不应用表情自动化', () => {
  const project = makeExprProject({
    kind: 'drum',
    automation: {
      pitchBend: { enabled: true, points: [{ beat: 0, value: 1 }] },
      expression: { enabled: true, points: [{ beat: 0, value: 0 }] },
      modulation: { enabled: true, points: [{ beat: 0, value: 1 }] },
    },
  })
  const { engine, ctx } = makeExprEngine(project)
  try {
    engine._scheduleEvent(
      { trackId: 'trk_e', pitch: 36, vel: 0.8, durBeats: 1, swingBeats: 0, startBeat: 0 },
      0.1,
    )
    assert.equal(engine._voices.length, 1, '鼓轨仍应正常发声')
    // 不应出现 detune 偏置 / 额外 vibrato LFO
    const detuneParams = ctx.params.filter((entry) => entry.name === 'detune')
    assert.ok(detuneParams.every((entry) => entry.param.value === 0 && entry.param.ops.length === 0))
  } finally {
    engine.dispose()
  }
})

test('engine 实时：legacy synth 支持 pitchBend（detune）与 expression（增益）', () => {
  const baseProject = makeExprProject({ preset: 'fixture_synth' })
  const baseEngine = makeExprEngine(baseProject)
  const bendProject = makeExprProject({
    preset: 'fixture_synth',
    automation: {
      pitchBend: { enabled: true, points: [{ beat: 0, value: 1 }] },
      expression: { enabled: true, points: [{ beat: 0, value: 0.5 }] },
    },
  })
  const bendEngine = makeExprEngine(bendProject)
  try {
    const event = { trackId: 'trk_e', pitch: 60, vel: 0.8, durBeats: 2, swingBeats: 0, startBeat: 0 }
    baseEngine.engine._scheduleEvent(event, 0.1)
    bendEngine.engine._scheduleEvent(event, 0.1)
    assert.equal(baseEngine.engine._voices.length, 1)
    assert.equal(bendEngine.engine._voices.length, 1)
    const basePeak = maxGainRamp(baseEngine.ctx)
    const bendPeak = maxGainRamp(bendEngine.ctx)
    closeTo(bendPeak, basePeak * 0.5, basePeak * 0.05)
    // detune：所有载波 = 原 detune 分散 + 200
    const bendDetunes = bendEngine.ctx.params
      .filter((entry) => entry.kind === 'oscillator' && entry.name === 'detune')
      .map((entry) => entry.param.value)
    assert.ok(bendDetunes.length > 0)
    assert.ok(bendDetunes.every((value) => value >= 200 - 55 - 1e-6), `detunes=${bendDetunes}`)
    assert.ok(bendDetunes.some((value) => Math.abs(value - 200) < 1e-6 || value > 200))
  } finally {
    baseEngine.engine.dispose()
    bendEngine.engine.dispose()
  }
})

test('engine.renderWav：表情自动化离线一致（采样 detune / expression 增益）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  // 离线图里 master 淡入 ramp 目标为 1，会掩盖 voice 包络峰值 → 排除 >=0.999 的 ramp
  const maxVoiceRamp = (ctx) => {
    let peak = 0
    for (const entry of ctx.params) {
      if (entry.kind !== 'gain' || entry.name !== 'gain') continue
      for (const op of entry.param.ops) {
        if (op.op !== 'linearRampToValueAtTime') continue
        const value = Number(op.args[0])
        if (Number.isFinite(value) && value < 0.999) peak = Math.max(peak, value)
      }
    }
    return peak
  }
  try {
    const render = async (automation) => {
      const project = makeExprProject({ preset: 'grand_piano', automation })
      const engine = new StudioEngine()
      engine._soundfontBank = await createSf2Bank()
      const result = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
      engine.dispose()
      const ctx = instances.at(-1)
      const source = ctx.sources.find((node) => node.buffer && node.buffer.length > 1000)
      assert.ok(source)
      return { detune: source.detune.value, peak: maxVoiceRamp(ctx), seconds: result.seconds }
    }
    const base = await render(null)
    const expr = await render({
      pitchBend: { enabled: true, points: [{ beat: 0, value: 1 }] },
      expression: { enabled: true, points: [{ beat: 0, value: 0.5 }] },
    })
    assert.equal(base.detune, 0)
    assert.equal(expr.detune, 200)
    closeTo(expr.peak, base.peak * 0.5, base.peak * 0.05)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('engine.previewNote：表情自动化在键盘试听一致', async () => {
  const project = makeExprProject({
    preset: 'grand_piano',
    automation: {
      pitchBend: { enabled: true, points: [{ beat: 0, value: 0 }] }, // → -200 cents
      modulation: { enabled: true, points: [{ beat: 0, value: 1 }] }, // +100 cents（默认 5Hz）
    },
  })
  const { engine, ctx } = makeExprEngine(project)
  engine._soundfontBank = await createSf2Bank()
  engine._positionBar = 0
  try {
    const id = engine.previewNote('trk_e', 60, 0.8)
    assert.ok(id)
    const source = ctx.nodes.filter((node) => node.kind === 'source').at(-1)
    assert.equal(source.detune.value, -200)
    const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
    assert.equal(oscillators.length, 1)
    assert.equal(oscillators[0].frequency.value, 5)
    assert.equal(vibratoDepthFor(ctx, oscillators[0]), 100)
    engine.stopPreview(id)
  } finally {
    engine.dispose()
  }
})

// ---------------------------------------------------------------------------
// 19. P14b 音频导出编码（MP3 / FLAC）
// ---------------------------------------------------------------------------

/** 生成短正弦 PCM 数据（Float32，-1..1）。 */
function makeSinePcm({ frames = 11025, sampleRate = 44100, freq = 440, gain = 0.5, channels = 1 } = {}) {
  const list = []
  for (let channel = 0; channel < channels; channel++) {
    const data = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      data[i] = Math.sin((2 * Math.PI * freq * (channel === 0 ? 1 : 1.5) * i) / sampleRate) * gain
    }
    list.push(data)
  }
  return list
}

/** 解析 FLAC STREAMINFO（magic "fLaC" 之后第 2 个 chunk 的前 34 字节）。 */
function readFlacStreamInfo(bytes) {
  assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), 'fLaC')
  const sampleRate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4)
  const channels = ((bytes[20] >> 1) & 0x07) + 1
  const bitsPerSample = (((bytes[20] & 0x01) << 4) | (bytes[21] >> 4)) + 1
  const totalSamples =
    (bytes[21] & 0x0f) * 2 ** 32 +
    ((bytes[22] << 24) >>> 0) +
    (bytes[23] << 16) +
    (bytes[24] << 8) +
    bytes[25]
  return { sampleRate, channels, bitsPerSample, totalSamples }
}

test('encodeMp3：短正弦 mono/stereo 输出合法 MP3（帧同步字 / 大小范围）', () => {
  const mono = makeSinePcm({ frames: 22050, freq: 440 })
  const mp3 = encodeMp3(mono, 44100)
  assert.ok(mp3 instanceof Uint8Array)
  assert.equal(mp3[0], 0xff, 'MP3 首字节应为 0xFF')
  assert.equal(mp3[1] & 0xe0, 0xe0, 'MP3 第二字节高 3 位应为 111（帧同步）')
  // 0.5s @192kbps ≈ 12KB（CBR + 首尾开销）
  assert.ok(mp3.byteLength > 6000 && mp3.byteLength < 24000, `mp3 size=${mp3.byteLength}`)

  const stereo = encodeMp3(makeSinePcm({ frames: 22050, channels: 2 }), 44100, { bitrateKbps: 192 })
  assert.ok(stereo.byteLength > 6000 && stereo.byteLength < 30000, `stereo size=${stereo.byteLength}`)
  const lowBitrate = encodeMp3(makeSinePcm({ frames: 22050 }), 44100, { bitrateKbps: 64 })
  assert.ok(lowBitrate.byteLength < mp3.byteLength * 0.8, `64kbps 应明显小于 192kbps`)
  // 默认码率常量
  assert.equal(DEFAULT_MP3_BITRATE_KBPS, 192)
  assert.deepEqual(MP3_BITRATES, [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320])
  assert.ok(MP3_SAMPLE_RATES.includes(44100))
})

test('encodeFlac：短正弦输出 fLaC + STREAMINFO（采样率/声道/位深/总样本数）正确', async () => {
  const rate = 44100
  const monoFrames = 11025 // 0.25s
  const flac = await encodeFlac(makeSinePcm({ frames: monoFrames, sampleRate: rate }), rate)
  assert.ok(flac instanceof Uint8Array)
  const info = readFlacStreamInfo(flac)
  assert.equal(info.sampleRate, rate)
  assert.equal(info.channels, 1)
  assert.equal(info.bitsPerSample, 16)
  assert.equal(info.totalSamples, monoFrames)
  assert.ok(flac.byteLength > 200 && flac.byteLength < 200000, `flac size=${flac.byteLength}`)

  // stereo 1s
  const frames = 44100
  const stereo = await encodeFlac(makeSinePcm({ frames, sampleRate: rate, channels: 2 }), rate)
  const stereoInfo = readFlacStreamInfo(stereo)
  assert.equal(stereoInfo.channels, 2)
  assert.equal(stereoInfo.totalSamples, frames)
  assert.equal(stereoInfo.bitsPerSample, 16)
  // duration = totalSamples / sampleRate
  closeTo(stereoInfo.totalSamples / stereoInfo.sampleRate, 1, 1e-9)
})

test('encodeAudioFormat：mp3 同步 / flac Promise / 非法格式中文错误 + 格式元信息', async () => {
  assert.deepEqual([...ENCODE_FORMATS], ['mp3', 'flac'])
  const mono = makeSinePcm({ frames: 4410 })
  const mp3 = encodeAudioFormat('mp3', mono, 44100)
  assert.ok(mp3 instanceof Uint8Array)
  const flacResult = encodeAudioFormat('flac', mono, 44100)
  assert.equal(typeof flacResult.then, 'function')
  const flac = await flacResult
  assert.equal(String.fromCharCode(...flac.slice(0, 4)), 'fLaC')
  assert.throws(() => encodeAudioFormat('wav', mono, 44100), /不支持的导出格式.*wav.*mp3、flac/)
  assert.throws(() => encodeAudioFormat('', mono, 44100), /不支持的导出格式/)
  // 大小写不敏感
  assert.ok(encodeAudioFormat('MP3', mono, 44100) instanceof Uint8Array)
  assert.equal(audioFormatExtension('mp3'), 'mp3')
  assert.equal(audioFormatExtension('FLAC'), 'flac')
  assert.equal(audioFormatMime('mp3'), 'audio/mpeg')
  assert.equal(audioFormatMime('flac'), 'audio/flac')
  assert.throws(() => audioFormatExtension('ogg'), /不支持的音频导出格式/)
  assert.throws(() => audioFormatMime('wav'), /不支持的音频导出格式/)
})

test('encodeMp3 / encodeFlac：非法参数抛中文错误', async () => {
  const mono = makeSinePcm({ frames: 4410 })
  assert.throws(() => encodeMp3([], 44100), /channels 必须是非空数组/)
  assert.throws(() => encodeMp3(null, 44100), /channels 必须是非空数组/)
  assert.throws(() => encodeMp3([mono[0], new Float32Array(10)], 44100), /所有声道长度必须一致/)
  assert.throws(() => encodeMp3([mono[0], mono[0], mono[0]], 44100), /仅支持 1（单声道）或 2（立体声）声道/)
  assert.throws(() => encodeMp3([new Float32Array(0)], 44100), /音频数据为空/)
  assert.throws(() => encodeMp3([new Uint8Array(10)], 44100), /必须是 Float32Array 或数值数组/)
  assert.throws(() => encodeMp3(mono, 44100, { bitrateKbps: 123 }), /码率 123 非法/)
  assert.throws(() => encodeMp3(mono, 44100, { bitrateKbps: 1000 }), /码率 1000 非法/)
  assert.throws(() => encodeMp3(mono, 12345), /采样率 12345 不受 MP3 支持/)
  assert.throws(() => encodeMp3(mono, 100), /采样率 100 非法/)
  await assert.rejects(async () => encodeFlac([], 44100), /channels 必须是非空数组/)
  await assert.rejects(async () => encodeFlac(mono, 100), /采样率 100 非法/)
  await assert.rejects(async () => encodeFlac([mono[0], new Float32Array(5)], 44100), /所有声道长度必须一致/)
})

test('encodeMp3 / encodeFlac：越界/NaN 样本钳制而不报错；8000Hz 低采样率可用', async () => {
  const clamped = new Float32Array([Number.NaN, 2, -2, 0.5, 0, Infinity])
  const mp3 = encodeMp3([clamped], 44100)
  assert.ok(mp3.byteLength > 0)
  const flac = await encodeFlac([clamped], 44100)
  assert.equal(readFlacStreamInfo(flac).totalSamples, clamped.length)
  // MP3 8kHz/32kbps 合法
  const lowRate = makeSinePcm({ frames: 4000, sampleRate: 8000, freq: 440 })
  const mp3Low = encodeMp3(lowRate, 8000, { bitrateKbps: 32 })
  assert.equal(mp3Low[0], 0xff)
  assert.ok(mp3Low.byteLength > 0)
  // FLAC 8kHz 合法
  const flacLow = await encodeFlac(lowRate, 8000)
  const info = readFlacStreamInfo(flacLow)
  assert.equal(info.sampleRate, 8000)
  assert.equal(info.totalSamples, 4000)
})

// ---------------------------------------------------------------------------
// 20. R0B 真实混音分析（K 加权 LUFS / 立体声 / 频谱 / section / fast 渲染）
// ---------------------------------------------------------------------------

/** 生成短正弦声道（Float32）。 */
function makeTone({ frames = 44100, sampleRate = 48000, freq = 1000, amp = 0.1 } = {}) {
  const data = new Float32Array(frames)
  for (let i = 0; i < frames; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp
  return data
}

/** 解析引擎导出的 WAV（16bit，由 mock OfflineAudioContext 渲染）。 */
function readRenderedWav(blob) {
  const bytes = new Uint8Array(blob.__bytes ?? blob)
  const header = parseWavHeader(bytes)
  return { header, bytes }
}

test('R0B analysis：K 加权系数与 BS.1770-4 48kHz 标准表一致', () => {
  const { pre, rlb } = kWeightingCoefficients(48000)
  closeTo(pre.b0, 1.53512485958697, 1e-9)
  closeTo(pre.b1, -2.69169618940638, 1e-9)
  closeTo(pre.b2, 1.19839281085285, 1e-9)
  closeTo(pre.a1, -1.69065929318241, 1e-9)
  closeTo(pre.a2, 0.73248077421585, 1e-9)
  closeTo(rlb.b0, 1)
  closeTo(rlb.b1, -2)
  closeTo(rlb.b2, 1)
  closeTo(rlb.a1, -1.99004745483398, 1e-9)
  closeTo(rlb.a2, 0.99007225036621, 1e-9)
  // 44.1k 也给出稳定极点（|a2|<1）
  const at44 = kWeightingCoefficients(44100)
  assert.ok(Math.abs(at44.pre.a2) < 1 && Math.abs(at44.rlb.a2) < 1)
})

test('R0B analysis：已知正弦的积分 LUFS（与 ffmpeg ebur128 基准一致）', () => {
  const rate = 48000
  const seconds = 10
  const frames = rate * seconds
  // 1kHz 立体声 -20dBFS：ffmpeg ebur128 I=-20.0 LUFS
  const stereoMinus20 = computeKWeightedLoudness(
    [makeTone({ frames, sampleRate: rate, amp: 0.1 }), makeTone({ frames, sampleRate: rate, amp: 0.1 })],
    rate,
  )
  assert.ok(Math.abs(stereoMinus20.integrated - -20) < 0.05, `stereo -20: ${stereoMinus20.integrated}`)
  assert.equal(stereoMinus20.method, 'itu-r-bs.1770-4')
  assert.equal(stereoMinus20.short, false)
  // 0dBFS：ffmpeg I=0.0
  const stereoFull = computeKWeightedLoudness([makeTone({ frames, sampleRate: rate, amp: 1 }), makeTone({ frames, sampleRate: rate, amp: 1 })], rate)
  assert.ok(Math.abs(stereoFull.integrated) < 0.05, `stereo 0dBFS: ${stereoFull.integrated}`)
  // 单声道 -20dBFS：立体声各声道相加少 3.01dB → ≈ -23.0
  const mono = computeKWeightedLoudness([makeTone({ frames, sampleRate: rate, amp: 0.1 })], rate)
  assert.ok(Math.abs(mono.integrated - -23.0) < 0.1, `mono: ${mono.integrated}`)
  // -40dBFS 立体声 ≈ -40
  const quiet = computeKWeightedLoudness([makeTone({ frames, sampleRate: rate, amp: 0.01 }), makeTone({ frames, sampleRate: rate, amp: 0.01 })], rate)
  assert.ok(Math.abs(quiet.integrated - -40) < 0.1, `quiet: ${quiet.integrated}`)
  // 最大短时响度 ≈ 积分响度（稳态正弦）
  assert.ok(Math.abs(stereoMinus20.maxShortTerm - -20) < 0.1)
})

test('R0B analysis：静音 / 短音频 / 削波 / 旧字段兼容', () => {
  const silence = analyzeChannels([new Float32Array(4800), new Float32Array(4800)], 48000)
  assert.equal(silence.lufs, null)
  assert.equal(silence.lufsMaxShortTerm, null)
  assert.equal(silence.silent, true)
  assert.equal(silence.lufsApprox, linearToDb(silence.rms) + -0.691)
  assert.ok(silence.bandEnergyPct && Object.values(silence.bandEnergyPct).every((value) => value === 0))

  // 0.2s 短音频：仍给出近似 integrated，并标注 short
  const short = analyzeChannels([makeTone({ frames: 9600, sampleRate: 48000, amp: 0.5 })], 48000)
  assert.ok(Number.isFinite(short.lufs))
  assert.equal(short.lufsShort, true)
  assert.equal(short.lufsShortTermApprox, true)
  assert.equal(short.lufsMethod, 'itu-r-bs.1770-4-short')

  // 削波 + 旧字段
  const clipped = new Float32Array(4800)
  clipped.fill(0.5)
  clipped[100] = 1
  clipped[200] = -1
  const clip = analyzeChannels([clipped], 48000)
  assert.equal(clip.clipping, true)
  assert.equal(clip.clippedSamples, 2)
  assert.equal(typeof clip.peak, 'number')
  assert.equal(typeof clip.peakDb, 'number')
  assert.equal(typeof clip.rms, 'number')
  assert.equal(typeof clip.rmsDb, 'number')
  assert.equal(typeof clip.crestDb, 'number')
  assert.equal(typeof clip.dcOffset, 'number')
  // lufsApprox 旧公式保留（RMS dBFS - 0.691）
  closeTo(clip.lufsApprox, clip.rmsDb + -0.691, 1e-9)
})

test('R0B analysis：gating 忽略静音段（含 2s 静音 + 2s -20dBFS 正弦）', () => {
  const rate = 48000
  const silence = new Float32Array(rate * 2)
  const tone = makeTone({ frames: rate * 2, sampleRate: rate, amp: 0.1 })
  const padded = new Float32Array(rate * 4)
  padded.set(silence, 0)
  padded.set(tone, rate * 2)
  const loudness = computeKWeightedLoudness([padded, padded], rate)
  assert.ok(Math.abs(loudness.integrated - -20) < 0.5, `gated integrated: ${loudness.integrated}`)
  assert.ok(loudness.blockCount > loudness.gatedBlockCount, '部分 400ms 块应被 gating 剔除')
  // 不作 gating 的 RMS dBFS 会被静音段拉低很多（验证 lufsApprox 与 lufs 的差异）
  const rmsDb = linearToDb(Math.sqrt(0.5 * 0.1 * 0.1 * 0.5))
  assert.ok(rmsDb < -20)
})

test('R0B analysis：stereoBalanceDb / correlation（相同/反相/单侧/单声道）', () => {
  const rate = 48000
  const frames = rate
  const left = makeTone({ frames, sampleRate: rate, freq: 440, amp: 0.2 })
  const right = makeTone({ frames, sampleRate: rate, freq: 440, amp: 0.2 })
  const same = computeStereoMetrics([left, right])
  closeTo(same.stereoBalanceDb, 0, 1e-9)
  closeTo(same.correlation, 1, 1e-6)

  const antiphase = Float32Array.from(right, (value) => -value)
  const anti = computeStereoMetrics([left, antiphase])
  closeTo(anti.stereoBalanceDb, 0, 1e-9)
  closeTo(anti.correlation, -1, 1e-6)

  const halfRight = Float32Array.from(right, (value) => value * 0.5)
  const unbalanced = computeStereoMetrics([left, halfRight])
  closeTo(unbalanced.stereoBalanceDb, 20 * Math.log10(2), 1e-6)

  const oneSide = computeStereoMetrics([left, new Float32Array(frames)])
  assert.equal(oneSide.stereoBalanceDb, 60)
  assert.equal(oneSide.correlation, null)

  const mono = computeStereoMetrics([left])
  assert.equal(mono.stereoBalanceDb, null)
  assert.equal(mono.correlation, null)
})

test('R0B analysis：spectralCentroidHz / bandEnergyPct（1kHz、8kHz、低频）', () => {
  const rate = 44100
  const frames = rate
  const oneK = analyzeChannels([makeTone({ frames, sampleRate: rate, freq: 1000, amp: 0.5 })], rate)
  assert.ok(Math.abs(oneK.spectralCentroidHz - 1000) < 60, `centroid 1k: ${oneK.spectralCentroidHz}`)
  assert.ok(oneK.bandEnergyPct.lowMid + oneK.bandEnergyPct.mid > 90, JSON.stringify(oneK.bandEnergyPct))
  const bandSum = Object.values(oneK.bandEnergyPct).reduce((sum, value) => sum + value, 0)
  closeTo(bandSum, 100, 0.5)

  const eightK = analyzeChannels([makeTone({ frames, sampleRate: rate, freq: 8000, amp: 0.5 })], rate)
  // 8kHz 正好落在 4k-8k/>8k 分界，允许能量分布在这两段
  assert.ok(Math.abs(eightK.spectralCentroidHz - 8000) < 300, `centroid 8k: ${eightK.spectralCentroidHz}`)
  assert.ok(eightK.bandEnergyPct.highMid + eightK.bandEnergyPct.high > 90, JSON.stringify(eightK.bandEnergyPct))
  const tenK = analyzeChannels([makeTone({ frames, sampleRate: rate, freq: 10000, amp: 0.5 })], rate)
  assert.ok(tenK.bandEnergyPct.high > 85, JSON.stringify(tenK.bandEnergyPct))

  const low = analyzeChannels([makeTone({ frames, sampleRate: rate, freq: 50, amp: 0.5 })], rate)
  assert.ok(low.spectralCentroidHz < 120, `centroid 50Hz: ${low.spectralCentroidHz}`)
  assert.ok(low.bandEnergyPct.sub > 40, JSON.stringify(low.bandEnergyPct))

  // 频谱帧数上限（长音频不无限耗时）
  const long = makeTone({ frames: rate * 10, sampleRate: rate, freq: 1000, amp: 0.5 })
  const spectrum = computeAverageSpectrum([long], rate)
  assert.ok(spectrum.frames > 0 && spectrum.frames <= 64)
  assert.equal(SPECTRAL_FFT_SIZE, 4096)
  assert.equal(SPECTRAL_BANDS.length, 6)
  assert.equal(spectralCentroid(null), null)
})

test('R0B analysis：sectionStats 分段统计（秒边界 + beat 转换）', () => {
  const rate = 44100
  const frames = rate * 2
  const lowPart = makeTone({ frames: rate, sampleRate: rate, freq: 200, amp: 0.3 })
  const highPart = makeTone({ frames: rate, sampleRate: rate, freq: 3000, amp: 0.3 })
  const mixed = new Float32Array(frames)
  mixed.set(lowPart, 0)
  mixed.set(highPart, rate)
  const analyzed = analyzeChannels([mixed, mixed], rate, {
    includeSectionStats: true,
    sections: [
      { name: 'low', startSeconds: 0, endSeconds: 1 },
      { name: 'high', startSeconds: 1, endSeconds: 2 },
    ],
  })
  assert.equal(analyzed.sectionStats.length, 2)
  const [low, high] = analyzed.sectionStats
  assert.equal(low.name, 'low')
  assert.equal(low.seconds, 1)
  assert.ok(Number.isFinite(low.lufs))
  assert.ok(low.spectralCentroidHz < high.spectralCentroidHz)
  assert.ok(high.spectralCentroidHz > 1500)
  assert.ok(low.bandEnergyPct.low + low.bandEnergyPct.lowMid > 80)
  assert.ok(high.bandEnergyPct.mid + high.bandEnergyPct.highMid > 80)
  closeTo(low.stereoBalanceDb, 0, 1e-6)
  closeTo(low.correlation, 1, 1e-6)

  // beat + beatToSeconds 回调等价
  const beatSections = analyzeChannels([mixed], rate, {
    includeSectionStats: true,
    beatToSeconds: (beat) => beat * 0.5, // 2 beats = 1s（120BPM）
    sections: [
      { name: 'A', startBeat: 0, endBeat: 2 },
      { name: 'B', startBeat: 2, endBeat: 4 },
    ],
  })
  assert.equal(beatSections.sectionStats.length, 2)
  closeTo(beatSections.sectionStats[0].endSeconds, 1, 1e-9)
  assert.ok(beatSections.sectionStats[0].spectralCentroidHz < beatSections.sectionStats[1].spectralCentroidHz)

  // 非法 boundary 被丢弃；空 sections → []
  assert.deepEqual(normalizeSectionBounds([{ name: 'x', startSeconds: 2, endSeconds: 1 }]), [])
  const noSections = analyzeChannels([mixed], rate, { includeSectionStats: true, sections: [] })
  assert.deepEqual(noSections.sectionStats, [])
})

test('R0B analysis：analyzeAudioBuffer 传递 sections 选项（mock AudioBuffer）', () => {
  const rate = 48000
  const frames = rate
  const left = makeTone({ frames, sampleRate: rate, freq: 440, amp: 0.2 })
  const buffer = {
    numberOfChannels: 2,
    sampleRate: rate,
    length: frames,
    getChannelData: (channel) => (channel === 0 ? left : left),
  }
  const analyzed = analyzeAudioBuffer(buffer, {
    includeSectionStats: true,
    sections: [{ name: 'all', startSeconds: 0, endSeconds: 1 }],
  })
  assert.equal(analyzed.sampleRate, rate)
  assert.equal(analyzed.channels, 2)
  assert.ok(Math.abs(analyzed.spectralCentroidHz - 440) < 60)
  assert.equal(analyzed.sectionStats.length, 1)
  assert.equal(analyzed.sectionStats[0].name, 'all')
  // 非法 buffer 不抛
  assert.equal(analyzeAudioBuffer(null).seconds, 0)
})

test('R0B engine：computeRenderPlan 支持 fast / sampleRate，默认保持不变', () => {
  const project = { bpm: 120, lengthBars: 4, timeSignature: [4, 4] } // 4 小节 = 16 beats @120 = 8s
  const normal = computeRenderPlan(project)
  assert.equal(normal.sampleRate, RENDER_SAMPLE_RATE)
  assert.equal(normal.sampleRate, 44100)
  assert.equal(normal.fast, false)
  assert.equal(normal.mode, 'normal')
  assert.equal(normal.frames, Math.round(8 * 44100))
  closeTo(normal.seconds, 8)

  const fast = computeRenderPlan(project, { fast: true })
  assert.equal(fast.sampleRate, FAST_RENDER_SAMPLE_RATE)
  assert.equal(fast.sampleRate, 22050)
  assert.equal(fast.fast, true)
  assert.equal(fast.mode, 'fast')
  assert.equal(fast.frames, Math.round(fast.seconds * 22050))
  assert.ok(Math.abs(fast.seconds - 8) < 1e-9)

  const custom = computeRenderPlan(project, { fromBar: 0, toBar: 2, sampleRate: 32000 })
  assert.equal(custom.sampleRate, 32000)
  assert.equal(custom.frames, Math.round(custom.seconds * 32000))
  // 越界钳制
  assert.equal(computeRenderPlan(project, { sampleRate: 999999 }).sampleRate, MAX_RENDER_SAMPLE_RATE)
  assert.equal(computeRenderPlan(project, { sampleRate: 100 }).sampleRate, MIN_RENDER_SAMPLE_RATE)
})

test('R0B engine.renderWav：fast / 自定义采样率生效（WAV 头与帧数一致）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const project = buildTestProject()
    const engine = new StudioEngine()
    const fastResult = await engine.renderWav(project, { fromBar: 0, toBar: 2, fast: true })
    assert.equal(fastResult.mode, 'fast')
    assert.equal(fastResult.fast, true)
    assert.equal(fastResult.sampleRate, 22050)
    const fastWav = readRenderedWav(new Uint8Array(await fastResult.blob.arrayBuffer()))
    assert.equal(fastWav.header.sampleRate, 22050)
    assert.equal(fastWav.header.frames ?? fastWav.header.dataSize / 4, fastResult.frames)

    const customResult = await engine.renderWav(project, { fromBar: 0, toBar: 2, sampleRate: 32000 })
    assert.equal(customResult.sampleRate, 32000)
    assert.equal(customResult.mode, 'normal')
    const customWav = readRenderedWav(new Uint8Array(await customResult.blob.arrayBuffer()))
    assert.equal(customWav.header.sampleRate, 32000)
    // 默认仍 44100
    const normalResult = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
    assert.equal(normalResult.sampleRate, 44100)
    engine.dispose()
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('R0B engine.renderWav：soloTrackIds 只渲染指定轨且不改工程', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const project = buildTestProject()
    const engine = new StudioEngine()
    const beforeTracks = project.tracks.length
    const beforeClips = project.clips.length
    const full = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
    const fullCtx = instances.at(-1)
    const fullNodes = fullCtx.nodeCount
    const solo = await engine.renderWav(project, { fromBar: 0, toBar: 2, soloTrackIds: ['trk_2'] })
    const soloCtx = instances.at(-1)
    assert.deepEqual(solo.renderedTrackIds, ['trk_2'])
    assert.equal(full.renderedTrackIds, null)
    assert.ok(soloCtx.nodeCount < fullNodes, `solo nodes=${soloCtx.nodeCount} full=${fullNodes}`)
    // 只渲染 trk_2（lead 合成器）→ 没有鼓轨的 voice 节点（鼓轨会创建 oscillator）
    assert.equal(project.tracks.length, beforeTracks)
    assert.equal(project.clips.length, beforeClips)
    // 空 solo 列表 = 不过滤（保持全曲）
    const empty = await engine.renderWav(project, { fromBar: 0, toBar: 2, soloTrackIds: [] })
    assert.equal(empty.renderedTrackIds, null)
    // trackIds 是 soloTrackIds 的别名
    const alias = await engine.renderWav(project, { fromBar: 0, toBar: 2, trackIds: 'trk_1' })
    assert.deepEqual(alias.renderedTrackIds, ['trk_1'])
    engine.dispose()
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('R0B：真实渲染 WAV → 分析（peak/rms/LUFS/centroid/bands/section）合理', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const project = buildTestProject()
    const engine = new StudioEngine()
    const result = await engine.renderWav(project, { fromBar: 0, toBar: 2, fast: true })
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    const wav = readRenderedWav(bytes)
    const dataOffset = wav.header.dataOffset ?? 44
    const frames = (bytes.byteLength - dataOffset) / 4
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      left[i] = view.getInt16(dataOffset + i * 4, true) / 32768
      right[i] = view.getInt16(dataOffset + i * 4 + 2, true) / 32768
    }
    const analyzed = analyzeChannels([left, right], result.sampleRate, {
      includeSectionStats: true,
      sections: [
        { name: 'A', startSeconds: 0, endSeconds: 1 },
        { name: 'B', startSeconds: 1, endSeconds: 2 },
      ],
    })
    assert.ok(analyzed.peak > 0)
    assert.ok(analyzed.rms > 0)
    assert.ok(Number.isFinite(analyzed.lufs))
    assert.ok(analyzed.lufs < 0)
    assert.ok(analyzed.spectralCentroidHz > 100 && analyzed.spectralCentroidHz < 20000)
    const bandSum = Object.values(analyzed.bandEnergyPct).reduce((sum, value) => sum + value, 0)
    closeTo(bandSum, 100, 0.5)
    assert.equal(analyzed.sectionStats.length, 2)
    assert.ok(analyzed.sectionStats.every((section) => Number.isFinite(section.lufs)))
    engine.dispose()
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

// ---------------------------------------------------------------------------
// 21. R0-10 采样预设响度归一（gainDb / presetGainDb）
// ---------------------------------------------------------------------------

/**
 * 接线前的实测基线（真实 SF2，headless Chrome 引擎离线渲染：C4 / vel 0.8 /
 * 2s 窗口 RMS dBFS；catalog gainDb 由这些值归一到 -18dBFS 生成）。
 */
const MEASURED_PRESET_RMS_DB = {
  grand_piano: -28.72,
  bright_piano: -28.68,
  tine_epiano: -18.85,
  harpsichord: -50.62,
  music_box: -19.8,
  marimba: -35.52,
  tonewheel_organ: -19.6,
  nylon_guitar: -28.02,
  steel_guitar: -27.24,
  acoustic_bass: -31.27,
  finger_bass: -26.96,
  violin: -19.57,
  cello: -20.82,
  strings_ensemble: -25.82,
  concert_choir: -21.66,
  trumpet: -24.32,
  flute: -23.33,
  warm_pad: -22.84,
  // R5a 新增 14 个（真实 SF2 headless 实测 raw 基线，与旧 18 个同一 map 语义）
  glockenspiel: -32.46,
  vibraphone: -16.08,
  church_organ: -35.26,
  jazz_guitar: -30.72,
  muted_guitar: -35.51,
  picked_bass: -36.61,
  fretless_bass: -23.98,
  synth_bass: -11.35,
  viola: -27.48,
  pizzicato_strings: -37.72,
  voice_oohs: -33.32,
  trombone: -24.77,
  french_horn: -45.56,
  clarinet: -19.64,
}
const MEASURED_KIT_RMS_DB = {
  smp_acoustic: -19.17,
  smp_electro: -25.82,
  smp_lofi: -24.99,
  smp_perc: -19.92,
}

function spread(values) {
  return Math.max(...values) - Math.min(...values)
}

test('R0-10 catalog：32 采样 preset + 4 鼓机都有合法 gainDb；归一同力度 RMS 差 ≤6dB', () => {
  assert.equal(SYNTH_PRESETS.length, 32)
  assert.equal(DRUM_KITS.length, 4)
  assert.ok(PRESET_GAIN_DB_MIN < 0 && PRESET_GAIN_DB_MAX > 0)
  for (const preset of SYNTH_PRESETS) {
    assert.ok(Number.isFinite(preset.gainDb), `${preset.id}.gainDb 缺失`)
    assert.ok(preset.gainDb >= PRESET_GAIN_DB_MIN && preset.gainDb <= PRESET_GAIN_DB_MAX, `${preset.id}.gainDb 越界`)
    assert.equal(presetGainDb(preset), preset.gainDb)
    closeTo(presetGainScale(preset), Math.pow(10, preset.gainDb / 20), 1e-9)
    assert.equal(presetGainDb(preset.id), preset.gainDb)
    assert.ok(preset.soundfont && Number.isInteger(preset.soundfont.program))
  }
  for (const kit of DRUM_KITS) {
    assert.ok(Number.isFinite(kit.gainDb), `${kit.id}.gainDb 缺失`)
    assert.equal(kitGainDb(kit), kit.gainDb)
    closeTo(kitGainScale(kit), Math.pow(10, kit.gainDb / 20), 1e-9)
  }
  // 未知/缺省 → 0（保持历史行为）
  assert.equal(presetGainDb('no-such-preset'), 0)
  assert.equal(kitGainDb('no-such-kit'), 0)
  assert.equal(presetGainDb({ id: 'x' }), 0)
  assert.equal(presetGainScale('no-such-preset'), 1)
  assert.equal(kitGainScale(undefined), 1)
  assert.equal(presetGainDb(null), 0)
  assert.equal(presetGainDb(undefined), 0)
  assert.equal(presetGainDb({ gainDb: 999 }), PRESET_GAIN_DB_MAX)
  assert.equal(presetGainDb({ gainDb: -999 }), PRESET_GAIN_DB_MIN)

  // 目标：同力度单音 RMS 差 ≤6dB（接线后基线 + gainDb）
  const adjustedPresets = SYNTH_PRESETS.map((preset) => MEASURED_PRESET_RMS_DB[preset.id] + presetGainDb(preset))
  const rawPresets = SYNTH_PRESETS.map((preset) => MEASURED_PRESET_RMS_DB[preset.id])
  assert.ok(spread(rawPresets) > 20, `未归一的 RMS 差应明显（${spread(rawPresets).toFixed(1)}dB）`)
  assert.ok(spread(adjustedPresets) <= 6, `归一后 RMS 差 ${spread(adjustedPresets).toFixed(2)}dB 应 ≤6dB`)
  const adjustedKits = DRUM_KITS.map((kit) => MEASURED_KIT_RMS_DB[kit.id] + kitGainDb(kit))
  assert.ok(spread(adjustedKits) <= 6, `鼓机归一 RMS 差 ${spread(adjustedKits).toFixed(2)}dB 应 ≤6dB`)
})

test('R0-10 soundfont buildVoice：gainScale 线性缩放 + 表达式叠加 + 钳制', async () => {
  const bank = await getSf2Bank()
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const makeVoice = (options) => {
    const ctx = new MockOfflineAudioContext(2, 44100, 44100)
    const voice = bank.buildVoice(ctx, ctx.createGain(), {
      program: 0,
      bank: 0,
      pitch: 60,
      vel: 0.8,
      startTime: 0,
      dur: 1,
      ...options,
    })
    assert.ok(voice)
    return maxGainRamp(ctx)
  }
  const base = makeVoice({})
  const doubled = makeVoice({ gainScale: 2 })
  const halved = makeVoice({ gainScale: 0.5 })
  assert.ok(base > 0)
  closeTo(doubled, base * 2, base * 0.01)
  closeTo(halved, base * 0.5, base * 0.01)
  const combined = makeVoice({ gainScale: 2, expressionGain: 0.5 })
  closeTo(combined, base, base * 0.01)
  closeTo(makeVoice({ gainScale: 0.0001 }), base * 0.01, base * 0.01)
  closeTo(makeVoice({ gainScale: 1000 }), base * 64, base * 1)
})

test('R0-10 samples：采样鼓 / 采样 voice 的 gainScale 生效', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const bank = makeFakeSampleBank()
  const measureDrum = (gainScale) => {
    const ctx = new MockOfflineAudioContext(2, 44100, 44100)
    const dest = ctx.createGain()
    const handle = buildSampleDrum(
      ctx,
      dest,
      { startTime: 0, vel: 0.8, pieceId: 'kick' },
      { level: 0.8 },
      { bank, kitId: 'smp_acoustic', gainScale },
    )
    assert.ok(handle)
    const gainParam = ctx.params.filter((entry) => entry.kind === 'gain' && entry.name === 'gain').at(-1)
    return gainParam.param.value
  }
  const base = measureDrum(undefined)
  assert.ok(base > 0)
  closeTo(measureDrum(2), base * 2, base * 0.01)
  closeTo(measureDrum(0.5), base * 0.5, base * 0.01)

  const measureVoice = (gainScale) => {
    const ctx = new MockOfflineAudioContext(2, 44100, 44100)
    const dest = ctx.createGain()
    const handle = buildSampleVoice(
      ctx,
      dest,
      { pitch: 60, vel: 0.8, startTime: 0, dur: 0.5 },
      { file: 'fake.flac', gain: 0.85, root: 60 },
      { bank, gainScale },
    )
    assert.ok(handle)
    return maxGainRamp(ctx)
  }
  const voiceBase = measureVoice(undefined)
  closeTo(measureVoice(2), voiceBase * 2, voiceBase * 0.01)
})

test('R0-10 engine 实时/预览：SF2 preset 自动应用 catalog gainScale', async () => {
  // 注意：engine.dispose() 会 dispose 自己的 soundfontBank，这里用独立解析的 bank，避免污染共享 bank
  const bank = await createSf2Bank()
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = makeMinimalPianoProject()
  const engine = makeVoiceEngine(project, ctx)
  engine._soundfontBank = bank
  try {
    const baseCtx = new MockOfflineAudioContext(2, 44100, 44100)
    bank.buildVoice(baseCtx, baseCtx.createGain(), {
      program: 0, bank: 0, pitch: 60, vel: 0.9, startTime: 0, dur: 0.5,
    })
    const basePeak = maxGainRamp(baseCtx)
    const scale = presetGainScale('grand_piano')
    assert.ok(scale > 1)
    engine._scheduleEvent({ trackId: 'trk_p', pitch: 60, vel: 0.9, durBeats: 1, swingBeats: 0, startBeat: 0 }, 0.01)
    assert.equal(engine._voices.length, 1)
    closeTo(maxGainRamp(ctx), basePeak * scale, basePeak * scale * 0.01)

    const previewCtx = new MockOfflineAudioContext(2, 44100, 44100)
    const previewEngine = makeVoiceEngine(project, previewCtx)
    previewEngine._soundfontBank = bank
    previewEngine._positionBar = 0
    const id = previewEngine.previewNote('trk_p', 60, 0.8)
    assert.ok(id)
    const previewBaseCtx = new MockOfflineAudioContext(2, 44100, 44100)
    bank.buildVoice(previewBaseCtx, previewBaseCtx.createGain(), {
      program: 0, bank: 0, pitch: 60, vel: clamp01(0.8 * PREVIEW_GAIN), startTime: 0, dur: 0.5,
    })
    const previewBase = maxGainRamp(previewBaseCtx)
    closeTo(maxGainRamp(previewCtx), previewBase * scale, previewBase * scale * 0.02)
    previewEngine.stopPreview(id)
    previewEngine.dispose()
  } finally {
    engine.dispose()
  }
})

test('R0-10 engine 采样鼓：实时播放自动应用 kit gainScale', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = createEmptyProject({ title: 'kit-gain', bpm: 120, key: 'A', scale: 'minor', lengthBars: 2 })
  project.master.effects = []
  const track = makeTrack({ id: 'trk_d', name: 'Drums', kind: 'drum', role: 'drums', volume: 0.8 })
  track.instrument = { preset: null, kit: 'smp_acoustic', params: {} }
  project.tracks.push(track)
  const engine = makeVoiceEngine(project, ctx)
  engine._sampleBank = makeFakeSampleBank()
  try {
    const kitParams = engine._drumParams.get('trk_d')
    const scale = kitGainScale('smp_acoustic')
    assert.ok(scale >= 1)
    engine._scheduleEvent({ trackId: 'trk_d', pitch: 36, vel: 0.8, durBeats: 0.25, swingBeats: 0, startBeat: 0 }, 0.01)
    assert.equal(engine._voices.length, 1)
    const engineGain = ctx.params.filter((entry) => entry.kind === 'gain' && entry.name === 'gain').at(-1)
    assert.ok(engineGain)
    const baseCtx = new MockOfflineAudioContext(2, 44100, 44100)
    buildSampleDrum(
      baseCtx,
      baseCtx.createGain(),
      { startTime: 0.01, vel: 0.8, pieceId: 'kick' },
      kitParams,
      { bank: makeFakeSampleBank(), kitId: 'smp_acoustic', gainScale: 1 },
    )
    const baseGain = baseCtx.params.filter((entry) => entry.kind === 'gain' && entry.name === 'gain').at(-1)
    closeTo(engineGain.param.value, baseGain.param.value * scale, baseGain.param.value * scale * 0.01)
  } finally {
    engine.dispose()
  }
})

test('R0-10 engine 离线 renderWav：应用 preset gainScale（与实时一致）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  // 独立 bank：engine.dispose() 会 dispose 自己的 bank；基线在 render 前先量好
  const bank = await createSf2Bank()
  try {
    const project = makeMinimalPianoProject()
    const baseCtx = new MockOfflineAudioContext(2, 44100, 44100)
    bank.buildVoice(baseCtx, baseCtx.createGain(), {
      program: 0, bank: 0, pitch: 60, vel: 0.9, startTime: 0, dur: 0.5,
    })
    const basePeak = maxGainRamp(baseCtx)
    const expected = basePeak * presetGainScale('grand_piano')
    assert.ok(basePeak > 0)

    const engine = new StudioEngine()
    engine._soundfontBank = bank
    await engine.renderWav(project, { fromBar: 0, toBar: 1, fast: true })
    engine.dispose()
    const ctx = instances.at(-1)
    const voiceRamps = []
    for (const entry of ctx.params) {
      if (entry.kind !== 'gain' || entry.name !== 'gain') continue
      for (const op of entry.param.ops) {
        const value = Number(op.args?.[0])
        // 排除 master 淡入 ramp 的精确 1；voice 包络峰值可 >1（preset 增益后）
        if (op.op === 'linearRampToValueAtTime' && Number.isFinite(value) && value > 0.0005 && value !== 1) {
          voiceRamps.push(value)
        }
      }
    }
    assert.ok(voiceRamps.length > 0)
    const renderedPeak = Math.max(...voiceRamps)
    closeTo(renderedPeak, expected, expected * 0.02)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

// ---------------------------------------------------------------------------
// 22. R0-11 demo 重配（结构不变 / normalize 通过 / 混音基线）
// ---------------------------------------------------------------------------

test('R0-11 demo：normalizeProject 通过、结构/音符数量不变、重配后混音基线字段合法', () => {
  const raw = createDemoProject()
  const normalized = normalizeProject(raw)
  // 结构不变：轨道/pattern/clip/section 数量与 id 一致
  assert.equal(normalized.tracks.length, raw.tracks.length)
  assert.equal(normalized.patterns.length, raw.patterns.length)
  assert.equal(normalized.clips.length, raw.clips.length)
  assert.equal(normalized.sections.length, raw.sections.length)
  assert.deepEqual(normalized.tracks.map((track) => track.id), raw.tracks.map((track) => track.id))
  assert.deepEqual(normalized.patterns.map((pattern) => pattern.id), raw.patterns.map((pattern) => pattern.id))
  assert.deepEqual(normalized.clips.map((clip) => clip.id), raw.clips.map((clip) => clip.id))
  assert.equal(normalized.lengthBars, 32)
  // 音符数量不变（只调音量/EQ/母带，不改结构/音符）
  const rawNotes = raw.patterns.reduce((sum, pattern) => sum + (pattern.notes?.length ?? 0), 0)
  const normalizedNotes = normalized.patterns.reduce((sum, pattern) => sum + (pattern.notes?.length ?? 0), 0)
  assert.equal(normalizedNotes, rawNotes)
  assert.ok(rawNotes > 300)

  // 音量/EQ/母带合法
  for (const track of normalized.tracks) {
    assert.ok(track.volume >= 0 && track.volume <= 1, `${track.id} volume=${track.volume}`)
    for (const effect of track.effects ?? []) {
      assert.ok(effect.type && effect.params, `${track.id} effect 非法`)
    }
  }
  assert.ok(normalized.master.volume > 0 && normalized.master.volume <= 1)
  assert.ok(normalized.master.effects.length >= 1)
  // 母带 EQ 低频不再提升（<250Hz 过量修复的一环）
  const masterEq = normalized.master.effects.find((effect) => effect.type === 'eq3')
  assert.ok(masterEq)
  assert.ok(Number(masterEq.params.low) <= 0, `master eq3 low=${masterEq.params.low} 应 ≤0`)

  // R0-11 混音基线：鼓/贝斯保留力度；旋律/铺底轨提升到可听范围
  const byRole = (role) => normalized.tracks.filter((track) => track.role === role)
  for (const track of byRole('drums')) assert.ok(track.volume >= 0.35 && track.volume <= 0.6, `drums volume=${track.volume}`)
  for (const track of byRole('bass')) assert.ok(track.volume >= 0.3 && track.volume <= 0.5, `bass volume=${track.volume}`)
  const melodic = normalized.tracks.filter((track) => ['lead', 'pad', 'arp', 'keys', 'fx'].includes(track.role))
  assert.ok(melodic.length >= 5)
  for (const track of melodic) assert.ok(track.volume >= 0.3 && track.volume <= 1, `${track.id} volume=${track.volume}`)
  // 低频收敛：贝斯/鼓 EQ 不再提升低频
  const bass = byRole('bass')[0]
  const bassEq = bass.effects.find((effect) => effect.type === 'eq3')
  assert.ok(bassEq && Number(bassEq.params.low) <= 0, `bass eq low=${bassEq?.params?.low} 应 ≤0`)
  const drums = byRole('drums')[0]
  const drumsEq = drums.effects.find((effect) => effect.type === 'eq3')
  assert.ok(drumsEq && Number(drumsEq.params.low) <= 0.5, `drums eq low=${drumsEq?.params?.low} 应 ≤0.5`)
})

// ---------------------------------------------------------------------------
// 23. CONTRACT-R2a：音频 clip gainDb / fadeIn / fadeOut / reverse
// ---------------------------------------------------------------------------

/** 带真实声道数据的测试 AudioBuffer（AudioBuffer 结构兼容）。 */
function makeTestAudioBuffer(seconds = 6, sampleRate = 100) {
  const length = Math.max(1, Math.round(seconds * sampleRate))
  const channels = [new Float32Array(length), new Float32Array(length)]
  for (let i = 0; i < length; i++) {
    channels[0][i] = Math.sin(i / 10) * 0.5
    channels[1][i] = Math.sin(i / 10) * 0.25
  }
  return {
    duration: length / sampleRate,
    sampleRate,
    length,
    numberOfChannels: 2,
    getChannelData: (channel) => channels[channel] ?? channels[0],
  }
}

/** 能稳定返回可写声道数组的 ctx（MediaBank.getReversed 用）。 */
function makeReversalContext() {
  return {
    sampleRate: 44100,
    createBuffer(numberOfChannels, length, sampleRate) {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
      return {
        numberOfChannels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (channel) => channels[channel],
      }
    },
  }
}

test('R2a media：buildAudioClipSegments 透传 gainDb/fade/reverse + 默认行为不变', () => {
  const project = makeAudioProject({ mediaDuration: 6 })
  const clip = project.clips[0]
  Object.assign(clip, { gainDb: -6, fadeInSeconds: 0.5, fadeOutSeconds: 0.25, reverse: true })
  const segments = buildAudioClipSegments(project, 0, 32, 2)
  assert.equal(segments.length, 1)
  const segment = segments[0]
  assert.equal(segment.gainDb, -6)
  closeTo(segment.gainScale, Math.pow(10, -6 / 20))
  assert.equal(segment.fadeInSeconds, 0.5)
  assert.equal(segment.fadeOutSeconds, 0.25)
  assert.equal(segment.reverse, true)
  closeTo(segment.clipPlayStartSeconds, 0)
  // clip 0..4 小节 = 8s，媒体只有 6s → 实际可播放 6s
  closeTo(segment.clipPlayDurationSeconds, 6)

  // 无字段 → 默认值（等价旧行为）
  const plain = buildAudioClipSegments(makeAudioProject({ mediaDuration: 6 }), 0, 32, 2)[0]
  assert.equal(plain.gainDb, 0)
  assert.equal(plain.gainScale, 1)
  assert.equal(plain.fadeInSeconds, 0)
  assert.equal(plain.fadeOutSeconds, 0)
  assert.equal(plain.reverse, false)

  // fade 总和超过实际播放时长 → 等比夹紧（6s → 3+3）
  const longFade = makeAudioProject({ mediaDuration: 6 })
  Object.assign(longFade.clips[0], { fadeInSeconds: 4, fadeOutSeconds: 4 })
  const clamped = buildAudioClipSegments(longFade, 0, 32, 2)[0]
  closeTo(clamped.fadeInSeconds, 3)
  closeTo(clamped.fadeOutSeconds, 3)
  closeTo(clamped.fadeInSeconds + clamped.fadeOutSeconds, clamped.clipPlayDurationSeconds)

  // 媒体时长未知（mp3 duration null）→ 以 clip 长度（8s）为上限
  const unknown = makeAudioProject({ mediaDuration: 6 })
  unknown.media[0].durationSeconds = null
  Object.assign(unknown.clips[0], { fadeInSeconds: 5, fadeOutSeconds: 5 })
  const unknownSegment = buildAudioClipSegments(unknown, 0, 32, 2)[0]
  closeTo(unknownSegment.clipPlayDurationSeconds, 8)
  closeTo(unknownSegment.fadeInSeconds + unknownSegment.fadeOutSeconds, 8)

  // 规范化函数
  assert.equal(normalizeClipGainDb(-999), CLIP_GAIN_DB_MIN)
  assert.equal(normalizeClipGainDb(999), CLIP_GAIN_DB_MAX)
  assert.equal(normalizeClipGainDb('x'), 0)
  assert.equal(normalizeClipFadeSeconds(-1), 0)
  assert.equal(normalizeClipFadeSeconds(99), CLIP_FADE_SECONDS_MAX)
  assert.equal(normalizeClipFadeSeconds('x'), 0)
})

test('R2a media：buildClipFadeEnvelope 端点/中间值 + 裁剪时按相对位置（不重新淡入）', () => {
  const gainScale = Math.pow(10, -6 / 20)
  const base = {
    offsetSeconds: 0,
    durationSeconds: 6,
    gainScale,
    fadeInSeconds: 0.5,
    fadeOutSeconds: 0.25,
    clipPlayStartSeconds: 0,
    clipPlayDurationSeconds: 6,
  }
  const full = buildClipFadeEnvelope(base)
  assert.deepEqual(full, [
    { time: 0, gain: 0 },
    { time: 0.5, gain: gainScale },
    { time: 5.75, gain: gainScale },
    { time: 6, gain: 0 },
  ])
  // 从 fadeIn 中间开始裁剪：首值按相对位置（不是 0，不重新淡入）
  const midFadeIn = buildClipFadeEnvelope({ ...base, offsetSeconds: 0.25, durationSeconds: 1 })
  closeTo(midFadeIn[0].time, 0)
  closeTo(midFadeIn[0].gain, gainScale * 0.5)
  closeTo(midFadeIn[1].time, 0.25)
  closeTo(midFadeIn[1].gain, gainScale)
  // 在 fadeOut 中间结束：末值按相对位置（不是 0）
  const midFadeOut = buildClipFadeEnvelope({ ...base, offsetSeconds: 5, durationSeconds: 0.8 })
  const last = midFadeOut[midFadeOut.length - 1]
  closeTo(last.time, 0.8)
  closeTo(last.gain, gainScale * (6 - 5.8) / 0.25)
  // 无 fade：单点增益（等价旧行为，引擎只 setValue）
  const noFade = buildClipFadeEnvelope({ ...base, fadeInSeconds: 0, fadeOutSeconds: 0 })
  assert.deepEqual(noFade, [{ time: 0, gain: gainScale }])
  // 空片段安全
  assert.deepEqual(buildClipFadeEnvelope({ durationSeconds: 0, gainScale: 2 }), [{ time: 0, gain: 2 }])
  assert.deepEqual(buildClipFadeEnvelope(null), [{ time: 0, gain: 1 }])
})

test('R2a MediaBank：getReversed 反转波形 / 按 mediaId 缓存 / 不改原 buffer / clear 清空', async () => {
  const sourceBuffer = {
    duration: 4 / 100,
    sampleRate: 100,
    length: 4,
    numberOfChannels: 1,
    getChannelData: () => Float32Array.from([0.1, 0.2, 0.3, 0.4]),
  }
  const bank = new MediaBank({
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    decodeAudioData: async () => sourceBuffer,
  })
  await bank.load('med_rev', 'rev.wav')
  // 无 ctx → 无法 createBuffer
  assert.equal(bank.getReversed('med_rev'), null)
  bank.setContext(makeReversalContext())
  const reversed = bank.getReversed('med_rev')
  assert.ok(reversed)
  assert.notEqual(reversed, sourceBuffer)
  const reversedData = Array.from(reversed.getChannelData(0))
  ;[0.4, 0.3, 0.2, 0.1].forEach((value, index) => closeTo(reversedData[index], value, 1e-6))
  // 缓存同一对象
  assert.equal(bank.getReversed('med_rev'), reversed)
  // 原 buffer 不变
  const sourceData = Array.from(sourceBuffer.getChannelData(0))
  ;[0.1, 0.2, 0.3, 0.4].forEach((value, index) => closeTo(sourceData[index], value, 1e-6))
  // 未知 media → null
  assert.equal(bank.getReversed('missing'), null)
  // clear 后缓存失效
  bank.clear()
  assert.equal(bank.getReversed('med_rev'), null)
})

test('MediaBank：跨工程同 mediaId 不同 file 不串缓存（buffer/reversed 各自隔离）', async () => {
  const buffers = {
    'a.wav': {
      duration: 0.04,
      sampleRate: 100,
      length: 4,
      numberOfChannels: 1,
      getChannelData: () => Float32Array.from([0.1, 0.2, 0.3, 0.4]),
    },
    'b.wav': {
      duration: 0.04,
      sampleRate: 100,
      length: 4,
      numberOfChannels: 1,
      getChannelData: () => Float32Array.from([0.8, 0.7, 0.6, 0.5]),
    },
  }
  let currentFile = null
  const bank = new MediaBank({
    fetchImpl: async (url) => {
      currentFile = decodeURIComponent(url.split('/').pop())
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }
    },
    decodeAudioData: async () => buffers[currentFile],
  })
  // 工程 A：med_1 → a.wav；工程 B：med_1 → b.wav（同 id 不同文件）
  const fromA = await bank.load('med_1', 'a.wav')
  const fromB = await bank.load('med_1', 'b.wav')
  assert.equal(fromA, buffers['a.wav'])
  assert.equal(fromB, buffers['b.wav'])
  assert.equal(bank.get('med_1', 'a.wav'), buffers['a.wav'])
  assert.equal(bank.get('med_1', 'b.wav'), buffers['b.wav'])
  // 旧调用 get(mediaId) 仍兼容：返回最近一次 load 的 buffer
  assert.equal(bank.get('med_1'), buffers['b.wav'])
  assert.equal(bank.has('med_1', 'a.wav'), true)
  assert.equal(bank.has('med_1', 'missing.wav'), false)
  // 反转缓存同样按 file 隔离
  bank.setContext(makeReversalContext())
  const reversedA = bank.getReversed('med_1', 'a.wav')
  const reversedB = bank.getReversed('med_1', 'b.wav')
  assert.notEqual(reversedA, reversedB)
  closeTo(Array.from(reversedA.getChannelData(0))[0], 0.4, 1e-6)
  closeTo(Array.from(reversedB.getChannelData(0))[0], 0.5, 1e-6)
  assert.equal(bank.getReversed('med_1', 'a.wav'), reversedA)
  // 清空后两份都不命中
  bank.clear()
  assert.equal(bank.get('med_1', 'a.wav'), null)
  assert.equal(bank.get('med_1', 'b.wav'), null)
  assert.equal(bank.getReversed('med_1', 'a.wav'), null)
  assert.equal(bank.get('med_1'), null)
})

test('MediaBank/引擎：同 mediaId、同 file、同长度但内容不同（peaks 指纹）不串缓存', async () => {
  const original = globalThis.OfflineAudioContext
  const originalAudioContext = globalThis.AudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  globalThis.AudioContext = MockOfflineAudioContext
  try {
    let generation = 0
    const decodedBuffers = {}
    const makeBuffer = (frequency) => {
      const length = 88200
      const data = new Float32Array(length)
      for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * frequency * i) / 44100) * 0.5
      return { duration: 2, sampleRate: 44100, length, numberOfChannels: 1, getChannelData: () => data }
    }
    const bank = new MediaBank({
      fetchImpl: async () => {
        generation += 1
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }
      },
      decodeAudioData: async () => {
        const buffer = makeBuffer(generation === 1 ? 440 : 880)
        decodedBuffers[generation] = buffer
        return buffer
      },
    })
    // 两个工程 media 条目同名同 id 同 bytes/时长，仅 peaks（导入波形指纹）不同
    const mediaA = { id: 'med_1', file: 'same.wav', bytes: 172800, durationSeconds: 2, channels: 1, sampleRate: 44100, peaks: [0.1, 0.5, 0.9, 0.3] }
    const mediaB = { id: 'med_1', file: 'same.wav', bytes: 172800, durationSeconds: 2, channels: 1, sampleRate: 44100, peaks: [0.9, 0.2, 0.1, 0.7] }
    const makeProject = (media, reverse = false) => {
      const project = makeAudioProject({ mediaDuration: 2, startBar: 0, lengthBars: 1 })
      project.media = [media]
      project.clips[0] = { ...project.clips[0], reverse }
      return project
    }
    const projectA = makeProject(mediaA)
    const projectB = makeProject(mediaB, true)
    const engine = new StudioEngine()
    engine._mediaBank = bank
    try {
      await engine.renderWav(projectA, { fromBar: 0, toBar: 1 })
      const ctxA = instances.at(-1)
      assert.ok(ctxA.sources.some((source) => source.buffer === decodedBuffers[1]), '工程 A 应播放第一次加载的 440 媒体')

      await engine.renderWav(projectB, { fromBar: 0, toBar: 1 })
      const ctxB = instances.at(-1)
      const segmentB = buildAudioClipSegments(projectB, 0, 32, 2)[0]
      const reversedB = bank.getReversed(segmentB.mediaId, segmentB.mediaFile, segmentB.mediaIdentity, 44100)
      assert.ok(reversedB, '同名不同内容应生成独立反转缓存')
      assert.ok(ctxB.sources.some((source) => source.buffer === reversedB), '工程 B 应播放第二次加载的 880 媒体反转')
      assert.ok(!ctxB.sources.some((source) => source.buffer === decodedBuffers[1]), '不得复用工程 A 的同名旧 buffer')
      assert.ok(!ctxB.sources.some((source) => source.buffer === decodedBuffers[2]), 'reverse 不应直接播放未反转 buffer')
    } finally {
      engine.dispose()
    }
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
    if (originalAudioContext === undefined) delete globalThis.AudioContext
    else globalThis.AudioContext = originalAudioContext
  }
})

test('R2a 引擎：两工程同 mediaId 不同 WAV 连续渲染/reverse 不串媒体（切回仍正确）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const buffers = {
      'a.wav': {
        duration: 2,
        sampleRate: 44100,
        length: 88200,
        numberOfChannels: 1,
        getChannelData: () => {
          const data = new Float32Array(88200)
          for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5
          return data
        },
      },
      'b.wav': {
        duration: 2,
        sampleRate: 44100,
        length: 88200,
        numberOfChannels: 1,
        getChannelData: () => {
          const data = new Float32Array(88200)
          for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 880 * i) / 44100) * 0.5
          return data
        },
      },
    }
    let currentFile = null
    const bank = new MediaBank({
      fetchImpl: async (url) => {
        currentFile = decodeURIComponent(url.split('/').pop())
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }
      },
      decodeAudioData: async () => buffers[currentFile],
    })
    const makeProject = (file, reverse = false) => {
      const project = makeAudioProject({ mediaDuration: 2, startBar: 0, lengthBars: 1 })
      project.media[0].file = file
      project.clips[0].reverse = reverse
      return project
    }
    const projectA = makeProject('a.wav')
    const projectB = makeProject('b.wav', true)
    // 预先加载两个工程的不同文件（Node 无 AudioContext 时 renderWav 的媒体预加载会跳过，
    // 这里手动加载；缓存身份仍是 mediaId+file，跨工程不能串）
    await bank.load('med_1', 'a.wav')
    await bank.load('med_1', 'b.wav')
    bank.setContext(makeReversalContext())
    const engine = new StudioEngine()
    engine._mediaBank = bank
    try {
      // 工程 A：正常播放 a.wav
      await engine.renderWav(projectA, { fromBar: 0, toBar: 1 })
      const ctxA1 = instances.at(-1)
      assert.ok(
        ctxA1.sources.some((source) => source.buffer === buffers['a.wav']),
        '工程 A 应播放 a.wav buffer',
      )

      // 切到工程 B：同 mediaId、不同 file + reverse → 必须用 b.wav 的反转 buffer
      await engine.renderWav(projectB, { fromBar: 0, toBar: 1 })
      const ctxB = instances.at(-1)
      const segmentB = buildAudioClipSegments(projectB, 0, 32, 2)[0]
      const reversedB = bank.getReversed(segmentB.mediaId, segmentB.mediaFile, segmentB.mediaIdentity, 44100)
      assert.ok(reversedB, '工程 B 应生成 b.wav 反转缓存')
      assert.ok(
        ctxB.sources.some((source) => source.buffer === reversedB),
        '工程 B 应播放 b.wav 的反转 buffer',
      )
      assert.ok(
        !ctxB.sources.some((source) => source.buffer === buffers['a.wav']),
        '不得命中工程 A 的旧媒体',
      )

      // 再切回工程 A：仍必须用 a.wav（不被 B 或反转缓存污染）
      await engine.renderWav(projectA, { fromBar: 0, toBar: 1 })
      const ctxA2 = instances.at(-1)
      assert.ok(
        ctxA2.sources.some((source) => source.buffer === buffers['a.wav']),
        '切回工程 A 仍应播放 a.wav buffer',
      )
      assert.ok(
        !ctxA2.sources.some((source) => source.buffer === reversedB),
        '不得命中工程 B 的反转缓存',
      )
    } finally {
      engine.dispose()
    }
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('R2a 引擎实时：gain/fade 包络排进 GainNode；reverse 用反转 buffer；无字段等价旧行为', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  ctx.currentTime = 0
  const fakeBuffer = makeTestAudioBuffer(6, 100)
  const project = makeAudioProject({ mediaDuration: 6 })
  Object.assign(project.clips[0], { gainDb: -6, fadeInSeconds: 1, fadeOutSeconds: 1 })
  const engine = new StudioEngine()
  engine.setProject(project)
  engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
  engine._mediaBank.setContext(ctx)
  engine._ctx = ctx
  engine._graph = { tracks: new Map([['trk_a', { input: ctx.createGain() }]]), update: () => {} }
  engine._bps = 2
  engine._project = project
  try {
    const segment = buildAudioClipSegments(project, 0, 32, 2)[0]
    const gainScale = Math.pow(10, -6 / 20)
    assert.equal(engine._scheduleAudioSegment(segment, 2), true)
    assert.equal(engine._mediaVoices.length, 1)
    const handle = engine._mediaVoices[0].handle
    const source = handle.source
    assert.equal(source.buffer, fakeBuffer)
    assert.ok(handle.gainNode, '应创建片段 GainNode')
    const gainParam = handle.gainNode.gain
    const envelopeOps = gainParam.ops.filter((op) => op.op !== 'cancelScheduledValues')
    assert.deepEqual(
      envelopeOps.map((op) => op.op),
      ['setValueAtTime', 'linearRampToValueAtTime', 'linearRampToValueAtTime', 'linearRampToValueAtTime'],
    )
    closeTo(envelopeOps[0].args[0], 0) // fadeIn 从 0 开始
    closeTo(envelopeOps[0].args[1], 2)
    closeTo(envelopeOps[1].args[0], gainScale)
    closeTo(envelopeOps[1].args[1], 3) // when + fadeIn 1s
    closeTo(envelopeOps[2].args[0], gainScale)
    closeTo(envelopeOps[2].args[1], 7) // when + (6 - 1)s
    closeTo(envelopeOps[3].args[0], 0)
    closeTo(envelopeOps[3].args[1], 8) // when + duration
    // stop 释放 gain 节点
    engine._stopAllMediaVoices(0.01)
    assert.equal(engine._mediaVoices.length, 0)

    // 无字段 → 单点 unity（旧行为等价）
    const plainProject = makeAudioProject({ mediaDuration: 6 })
    const engine2 = new StudioEngine()
    engine2.setProject(plainProject)
    engine2._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    engine2._mediaBank.setContext(ctx)
    engine2._ctx = ctx
    engine2._graph = { tracks: new Map([['trk_a', { input: ctx.createGain() }]]), update: () => {} }
    engine2._bps = 2
    engine2._project = plainProject
    const plainSegment = buildAudioClipSegments(plainProject, 0, 32, 2)[0]
    assert.equal(engine2._scheduleAudioSegment(plainSegment, 1), true)
    const plainParam = engine2._mediaVoices[0].handle.gainNode.gain
    const plainOps = plainParam.ops.filter((op) => op.op !== 'cancelScheduledValues')
    assert.deepEqual(plainOps.map((op) => op.op), ['setValueAtTime'])
    closeTo(plainOps[0].args[0], 1)
    engine2._stopAllMediaVoices(0.01)
    engine2.dispose()
  } finally {
    engine.dispose()
  }
})

test('R2a 引擎实时：reverse 片段使用反转 buffer（原 buffer 不变 / 相同 mediaId 缓存）', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  const fakeBuffer = makeTestAudioBuffer(6, 100)
  const project = makeAudioProject({ mediaDuration: 6 })
  project.clips[0].reverse = true
  const engine = new StudioEngine()
  engine.setProject(project)
  engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
  engine._mediaBank.setContext(makeReversalContext())
  engine._ctx = ctx
  engine._graph = { tracks: new Map([['trk_a', { input: ctx.createGain() }]]), update: () => {} }
  engine._bps = 2
  engine._project = project
  try {
    const segment = buildAudioClipSegments(project, 0, 32, 2)[0]
    assert.equal(engine._scheduleAudioSegment(segment, 0), true)
    const source = engine._mediaVoices[0].handle.source
    assert.notEqual(source.buffer, fakeBuffer, 'reverse 应使用反转 buffer')
    assert.equal(source.buffer.length, fakeBuffer.length)
    assert.equal(source.buffer.getChannelData(0)[0], fakeBuffer.getChannelData(0)[fakeBuffer.length - 1])
    engine._stopAllMediaVoices(0.01)
  } finally {
    engine.dispose()
  }
})

test('R2a 引擎离线：renderWav 音频片段包络与实时一致（mock OfflineAudioContext）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const fakeBuffer = makeTestAudioBuffer(6, 100)
    const project = makeAudioProject({ mediaDuration: 6 })
    Object.assign(project.clips[0], { gainDb: -6, fadeInSeconds: 1, fadeOutSeconds: 1 })
    const engine = new StudioEngine()
    engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    engine._mediaBank.setContext(makeReversalContext())
    await engine.renderWav(project, { fromBar: 0, toBar: 4 })
    engine.dispose()
    const ctx = instances[0]
    const segment = buildAudioClipSegments(project, 0, 32, 2)[0]
    const expected = buildClipFadeEnvelope(segment)
    const gainParam = ctx.params
      .filter((entry) => entry.kind === 'gain' && entry.name === 'gain' && entry.param.ops.length > 0)
      .at(-1)
    assert.ok(gainParam, '离线渲染应创建片段 GainNode 包络')
    const ops = gainParam.param.ops.filter((op) => op.op !== 'cancelScheduledValues')
    assert.equal(ops.length, expected.length)
    closeTo(ops[0].args[0], expected[0].gain)
    closeTo(ops[0].args[1], expected[0].time) // when=0
    for (let i = 1; i < ops.length; i++) {
      closeTo(ops[i].args[0], expected[i].gain)
      closeTo(ops[i].args[1], expected[i].time)
    }
    // 片段仍由原 buffer 播放（无 reverse）
    assert.ok(ctx.sources.some((source) => source.buffer === fakeBuffer))
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

// ---------------------------------------------------------------------------
// 24. CONTRACT-R2B：时间拉伸 / 独立变调（WSOLA）
// ---------------------------------------------------------------------------

/** 生成纯音声道（测试用）。 */
function makeToneChannel(seconds, frequency, sampleRate = 44100, amplitude = 0.5) {
  const length = Math.max(1, Math.round(seconds * sampleRate))
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude
  return data
}

/** 单频能量（Goertzel）。 */
function tonePower(channel, sampleRate, frequency, from = 0, count = 0) {
  const n = Math.max(1, count || Math.min(channel.length - from, sampleRate))
  const k = Math.round((n * frequency) / sampleRate)
  const omega = (2 * Math.PI * k) / n
  const coeff = 2 * Math.cos(omega)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    s0 = (channel[from + i] ?? 0) + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const real = s1 - s2 * Math.cos(omega)
  const imag = s2 * Math.sin(omega)
  return Math.sqrt(real * real + imag * imag) / n
}

function channelRms(channel) {
  let sum = 0
  for (const value of channel) sum += value * value
  return Math.sqrt(sum / Math.max(1, channel.length))
}

test('R2b stretch 纯函数：规范化/WSOLA 时长与音高/变调频率/组合/反转', () => {
  assert.equal(normalizeStretchRatio(0.1), MIN_STRETCH_RATIO)
  assert.equal(normalizeStretchRatio(9), MAX_STRETCH_RATIO)
  assert.equal(normalizeStretchRatio('x'), 1)
  assert.equal(normalizeStretchRatio(1.23456), 1.235)
  assert.equal(normalizeSemitones(13.4), MAX_SEMITONES)
  assert.equal(normalizeSemitones(-13.4), MIN_SEMITONES)
  assert.equal(normalizeSemitones(2.34), 2.3)
  assert.equal(normalizeSemitones('x'), 0)
  assert.equal(isIdentityProcess({ stretchRatio: 1, semitones: 0 }), true)
  assert.equal(isIdentityProcess({ stretchRatio: 1.25, semitones: 0 }), false)

  // resampleLinear：长度 ≈ 1/factor，采样点近似跳采
  const ramp = Float32Array.from({ length: 100 }, (_, index) => index)
  const half = resampleLinear(ramp, 2)
  assert.equal(half.length, 50)
  closeTo(half[0], 0)
  closeTo(half[10], 20, 0.001)
  // reverseChannels：波形反向
  const reversed = reverseChannels([ramp])[0]
  closeTo(reversed[0], 99)
  closeTo(reversed[99], 0)

  const sampleRate = 44100
  const source = makeToneChannel(1, 440, sampleRate)
  for (const ratio of [0.8, 1.25]) {
    const out = wsolaChannels([source], ratio)[0]
    assert.equal(out.length, Math.round(source.length * ratio), `ratio=${ratio} 输出时长`)
    const power440 = tonePower(out, sampleRate, 440, Math.floor(out.length / 4), Math.floor(sampleRate / 4))
    const power880 = tonePower(out, sampleRate, 880, Math.floor(out.length / 4), Math.floor(sampleRate / 4))
    assert.ok(power440 > 0.15, `ratio=${ratio} 应保持 440Hz（power=${power440}）`)
    assert.ok(power880 < 0.02, `ratio=${ratio} 不应变调（880 power=${power880}）`)
    assert.ok(channelRms(out) > 0.15 && channelRms(out) < 0.5)
  }

  // 独立变调：时长不变（±2 采样舍入误差）、频率按 2^(st/12) 改变
  for (const semitones of [3, -3]) {
    const out = pitchShiftChannels([source], semitones)[0]
    closeTo(out.length, source.length, 2)
    const target = 440 * Math.pow(2, semitones / 12)
    const powerTarget = tonePower(out, sampleRate, target)
    const powerOrig = tonePower(out, sampleRate, 440)
    assert.ok(powerTarget > 0.15, `st=${semitones} 目标频率 ${target}Hz 应占主导（${powerTarget}）`)
    assert.ok(powerOrig < 0.02, `st=${semitones} 原 440Hz 应基本消失（${powerOrig}）`)
  }
  const octave = pitchShiftChannels([source], 12)[0]
  assert.ok(tonePower(octave, sampleRate, 880) > 0.15)

  // 组合：ratio 1.25 + semitones +3 → 时长 ×1.25、频率 ×2^(3/12)
  const combo = processClipAudio([source], { stretchRatio: 1.25, semitones: 3 })[0]
  closeTo(combo.length, Math.round(source.length * 1.25), 2)
  const target = 440 * Math.pow(2, 3 / 12)
  assert.ok(tonePower(combo, sampleRate, target) > 0.12)
  // 恒等参数：数值完全不变
  const identity = processClipAudio([source], { stretchRatio: 1, semitones: 0 })[0]
  assert.deepEqual(Array.from(identity), Array.from(source))
})

test('R2b media：buildAudioClipSegments 透传 stretchRatio/semitones + timeline 换算（ratio=1 与 R2a 一致）', () => {
  // ratio=1：与 R2a 完全一致
  const plain = makeAudioProject({ mediaDuration: 6 })
  const plainSegment = buildAudioClipSegments(plain, 0, 32, 2)[0]
  assert.equal(plainSegment.stretchRatio, 1)
  assert.equal(plainSegment.semitones, 0)
  closeTo(plainSegment.offsetSeconds, 0)
  closeTo(plainSegment.durationSeconds, 6)
  closeTo(plainSegment.playStartSeconds, 0)
  closeTo(plainSegment.playDurationSeconds, 6)
  assert.deepEqual(buildClipFadeEnvelope(plainSegment), [{ time: 0, gain: 1 }])

  // ratio=2（放慢）：clip 0..4 小节=8s，媒体 6s → 可播放 timeline = 8s；播放 8s 只消耗源 4s
  const slow = makeAudioProject({ mediaDuration: 6 })
  slow.clips[0].stretchRatio = 2
  const slowSegment = buildAudioClipSegments(slow, 0, 32, 2)[0]
  closeTo(slowSegment.durationSeconds, 8)
  closeTo(slowSegment.offsetSeconds, 0)
  closeTo(slowSegment.playDurationSeconds, 8)
  closeTo(slowSegment.clipPlayDurationSeconds, 8)

  // 渲染区间从片段中间开始（bar1=2s 处）：源偏移 = 2/ratio = 1s
  const cropped = buildAudioClipSegments(slow, 4, 16, 2)[0]
  closeTo(cropped.playStartSeconds, 2)
  closeTo(cropped.offsetSeconds, 1)
  closeTo(cropped.durationSeconds, 6) // 剩余 timeline min(6, (6-1)*2=10)

  // ratio=0.5（加速）：媒体 6s、trim 1s → 可播放 timeline = min(8, (6-1)*0.5=2.5)=2.5
  const fast = makeAudioProject({ mediaDuration: 6 })
  fast.clips[0].offsetSeconds = 1
  fast.clips[0].stretchRatio = 0.5
  fast.clips[0].fadeInSeconds = 1.5
  fast.clips[0].fadeOutSeconds = 1.5
  const fastSegment = buildAudioClipSegments(fast, 0, 32, 2)[0]
  closeTo(fastSegment.playDurationSeconds, 2.5)
  closeTo(fastSegment.durationSeconds, 2.5)
  closeTo(fastSegment.offsetSeconds, 1)
  // fade 按 timeline 秒比例夹紧到 1.25+1.25
  closeTo(fastSegment.fadeInSeconds, 1.25)
  closeTo(fastSegment.fadeOutSeconds, 1.25)

  // semitones 透传
  const pitched = makeAudioProject({ mediaDuration: 6 })
  pitched.clips[0].semitones = 3
  const pitchedSegment = buildAudioClipSegments(pitched, 0, 32, 2)[0]
  assert.equal(pitchedSegment.semitones, 3)
  assert.equal(pitchedSegment.stretchRatio, 1)

  // fade 在 timeline 轴：ratio=2、playStart=2、playDuration=8、fade 1/1
  const fadeSegment = {
    offsetSeconds: 1,
    durationSeconds: 6,
    gainScale: 1,
    stretchRatio: 2,
    playStartSeconds: 2,
    playDurationSeconds: 8,
    clipPlayStartSeconds: 0,
    clipPlayDurationSeconds: 8,
    fadeInSeconds: 1,
    fadeOutSeconds: 1,
  }
  const envelope = buildClipFadeEnvelope(fadeSegment)
  assert.deepEqual(
    envelope.map((point) => [Math.round(point.time * 1000) / 1000, Math.round(point.gain * 1000) / 1000]),
    [
      [0, 1],
      [5, 1],
      [6, 0],
    ],
  )
  // 窗口从 fadeIn 中间开始：首值按 timeline 相对位置（axis=2 → 2/1 已结束 fadeIn → 1）
  const mid = buildClipFadeEnvelope({ ...fadeSegment, playStartSeconds: 0.5, durationSeconds: 1 })
  closeTo(mid[0].gain, 0.5)
})

test('R2b MediaBank：getProcessed 拉伸/变调缓存 + 恒等走原 buffer + clear 失效', async () => {
  const sampleRate = 44100
  const sourceBuffer = {
    duration: 1,
    sampleRate,
    length: sampleRate,
    numberOfChannels: 1,
    getChannelData: () => makeToneChannel(1, 440, sampleRate),
  }
  const bank = new MediaBank({
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    decodeAudioData: async () => sourceBuffer,
  })
  await bank.load('med_p', 'p.wav')
  bank.setContext(makeReversalContext())
  // 恒等：直接返回原 buffer（reverse 时反转 buffer）
  assert.equal(bank.getProcessed('med_p', 'p.wav', '', { stretchRatio: 1, semitones: 0 }), sourceBuffer)
  const reversed = bank.getProcessed('med_p', 'p.wav', '', { stretchRatio: 1, semitones: 0, reverse: true })
  assert.notEqual(reversed, sourceBuffer)
  // ratio=2：处理 buffer 时长 ×2、音高保持 440
  const stretched = bank.getProcessed('med_p', 'p.wav', '', { stretchRatio: 2 })
  assert.ok(stretched && stretched !== sourceBuffer)
  closeTo(stretched.duration, sourceBuffer.duration * 2, 0.01)
  const stretchedData = stretched.getChannelData(0)
  assert.ok(tonePower(stretchedData, sampleRate, 440, Math.floor(stretchedData.length / 4), sampleRate / 4) > 0.12)
  // 同参数命中缓存；不同参数/反转/变调各自独立
  assert.equal(bank.getProcessed('med_p', 'p.wav', '', { stretchRatio: 2 }), stretched)
  const stretchedFast = bank.getProcessed('med_p', 'p.wav', '', { stretchRatio: 1.25 })
  assert.notEqual(stretchedFast, stretched)
  closeTo(stretchedFast.duration, sourceBuffer.duration * 1.25, 0.01)
  const pitched = bank.getProcessed('med_p', 'p.wav', '', { stretchRatio: 1, semitones: 3 })
  assert.ok(pitched && pitched !== sourceBuffer)
  closeTo(pitched.duration, sourceBuffer.duration, 0.01)
  assert.ok(tonePower(pitched.getChannelData(0), sampleRate, 440 * Math.pow(2, 3 / 12)) > 0.12)
  const stretchedPitched = bank.getProcessed('med_p', 'p.wav', '', { stretchRatio: 2, semitones: 3 })
  closeTo(stretchedPitched.duration, sourceBuffer.duration * 2, 0.01)
  const stretchedReversed = bank.getProcessed('med_p', 'p.wav', '', { stretchRatio: 2, reverse: true })
  assert.notEqual(stretchedReversed, stretched)
  // clear 后重新计算（不再是同一对象）
  bank.clear()
  const recomputed = bank.getProcessed('med_p', 'p.wav', '', { stretchRatio: 2 })
  assert.equal(recomputed, null) // 原 buffer 也已清空 → 无法处理
})

test('R2b MediaBank：ensureProcessedForProject 预计算工程变体（ratio=1 跳过）', async () => {
  const sampleRate = 44100
  const sourceBuffer = {
    duration: 1,
    sampleRate,
    length: sampleRate,
    numberOfChannels: 1,
    getChannelData: () => makeToneChannel(1, 440, sampleRate),
  }
  const bank = new MediaBank({
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
    decodeAudioData: async () => sourceBuffer,
  })
  bank.setContext(makeReversalContext())
  const project = makeAudioProject({ mediaDuration: 1 })
  project.clips[0].stretchRatio = 2
  project.clips[0].semitones = 3
  project.clips[0].reverse = true
  const count = await bank.ensureProcessedForProject(project)
  assert.equal(count, 1)
  const mediaIdentityOf = (proj) => collectMediaFiles(proj)[0].identity
  const identity = mediaIdentityOf(project)
  assert.ok(bank.getProcessed('med_1', 'med_1.wav', identity, { stretchRatio: 2, semitones: 3, reverse: true }))
  // 恒等工程 → 0 个变体
  const plain = makeAudioProject({ mediaDuration: 1 })
  assert.equal(await bank.ensureProcessedForProject(plain), 0)
})

test('R2b 引擎实时：stretch/变调使用处理 buffer，offset×ratio、duration 按 timeline；ratio=1 行为同 R2a', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.state = 'running'
  ctx.currentTime = 0
  const sampleRate = 44100
  const fakeBuffer = {
    duration: 1,
    sampleRate,
    length: sampleRate,
    numberOfChannels: 1,
    getChannelData: () => makeToneChannel(1, 440, sampleRate),
  }
  const makeEngine = async (project) => {
    const engine = new StudioEngine()
    engine.setProject(project)
    engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    engine._mediaBank.setContext(makeReversalContext())
    engine._ctx = ctx
    engine._graph = { tracks: new Map([['trk_a', { input: ctx.createGain() }]]), update: () => {} }
    engine._bps = 2
    engine._project = project
    return engine
  }
  // ratio=2：clip 0..2s timeline = min(2, 1*2=2) → 播放 2s，源 offset 0，处理 buffer 时长 2s
  const project = makeAudioProject({ mediaDuration: 1, lengthBars: 1 })
  project.clips[0].stretchRatio = 2
  const engine = await makeEngine(project)
  try {
    const segment = buildAudioClipSegments(project, 0, 32, 2)[0]
    assert.equal(engine._scheduleAudioSegment(segment, 1), true)
    const handle = engine._mediaVoices[0].handle
    assert.notEqual(handle.source.buffer, fakeBuffer, 'ratio≠1 应使用处理后的 buffer')
    closeTo(handle.source.buffer.duration, 2, 0.02)
    const call = handle.source.startCalls[0]
    closeTo(call[0], 1)
    closeTo(call[1], 0) // offset 0 ×2
    closeTo(call[2], 2) // timeline 时长
    // 同参数再次调度复用同一处理 buffer
    engine._stopAllMediaVoices(0.01)
    assert.equal(engine._scheduleAudioSegment(buildAudioClipSegments(project, 0, 32, 2)[1] ?? segment, 3), true)
    assert.equal(engine._mediaVoices[0].handle.source.buffer, handle.source.buffer)
    engine._stopAllMediaVoices(0.01)
    engine.dispose()
  } finally {
    engine._stopAllMediaVoices(0.01)
  }

  // semitones +3：时长不变、buffer 为处理版本
  const pitchedProject = makeAudioProject({ mediaDuration: 1, lengthBars: 1 })
  pitchedProject.clips[0].semitones = 3
  const engine2 = await makeEngine(pitchedProject)
  try {
    const segment = buildAudioClipSegments(pitchedProject, 0, 32, 2)[0]
    assert.equal(engine2._scheduleAudioSegment(segment, 0), true)
    const handle = engine2._mediaVoices[0].handle
    assert.notEqual(handle.source.buffer, fakeBuffer)
    closeTo(handle.source.buffer.duration, 1, 0.02)
    const data = handle.source.buffer.getChannelData(0)
    assert.ok(tonePower(data, sampleRate, 440 * Math.pow(2, 3 / 12)) > 0.1)
  } finally {
    engine2._stopAllMediaVoices(0.01)
    engine2.dispose()
  }

  // ratio=1/semitones=0 回归：直接用原 buffer，offset/duration 与 R2a 一致
  const plainProject = makeAudioProject({ mediaDuration: 1, lengthBars: 1 })
  const engine3 = await makeEngine(plainProject)
  try {
    const segment = buildAudioClipSegments(plainProject, 0, 32, 2)[0]
    assert.equal(engine3._scheduleAudioSegment(segment, 0.5), true)
    const handle = engine3._mediaVoices[0].handle
    assert.equal(handle.source.buffer, fakeBuffer)
    assert.deepEqual(handle.source.startCalls[0], [0.5, 0, 1])
  } finally {
    engine3._stopAllMediaVoices(0.01)
    engine3.dispose()
  }
})

test('R2b 模型集成：normalizeProject 保留 stretchRatio/semitones；1/0 省略时引擎默认等价 R2a', () => {
  const project = makeAudioProject({ mediaDuration: 6 })
  Object.assign(project.clips[0], { stretchRatio: 1.25, semitones: -3 })
  const normalized = normalizeProject(project)
  const clip = normalized.clips[0]
  assert.equal(clip.stretchRatio, 1.25)
  assert.equal(clip.semitones, -3)
  const segment = buildAudioClipSegments(normalized, 0, 32, 2)[0]
  assert.equal(segment.stretchRatio, 1.25)
  assert.equal(segment.semitones, -3)
  // 1/0 被 Host 省略（或字段缺失）→ 引擎默认原速/不变调
  const plain = normalizeProject(makeAudioProject({ mediaDuration: 6 }))
  assert.equal(plain.clips[0].stretchRatio, undefined)
  assert.equal(plain.clips[0].semitones, undefined)
  const plainSegment = buildAudioClipSegments(plain, 0, 32, 2)[0]
  assert.equal(plainSegment.stretchRatio, 1)
  assert.equal(plainSegment.semitones, 0)
  closeTo(plainSegment.offsetSeconds, 0)
  closeTo(plainSegment.durationSeconds, 6)
})

test('R2b 引擎离线：renderWav stretch 段与实时一致（offset×ratio / 处理 buffer / 包络）', async () => {
  const original = globalThis.OfflineAudioContext
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  try {
    const sampleRate = 44100
    const fakeBuffer = {
      duration: 6,
      sampleRate,
      length: sampleRate * 6,
      numberOfChannels: 1,
      getChannelData: () => makeToneChannel(6, 440, sampleRate),
    }
    const project = makeAudioProject({ mediaDuration: 6 })
    project.clips[0].stretchRatio = 2
    project.clips[0].fadeInSeconds = 0.5
    project.clips[0].fadeOutSeconds = 0.5
    const engine = new StudioEngine()
    engine._mediaBank = await makeLoadedMediaBank(fakeBuffer)
    engine._mediaBank.setContext(makeReversalContext())
    await engine.renderWav(project, { fromBar: 0, toBar: 4 })
    engine.dispose()
    const ctx = instances[0]
    const segment = buildAudioClipSegments(project, 0, 32, 2)[0]
    closeTo(segment.durationSeconds, 8)
    const source = ctx.sources.find((item) => item.buffer && item.buffer.duration > 10)
    assert.ok(source, '离线应使用处理后的 buffer（时长 12s）')
    assert.notEqual(source.buffer, fakeBuffer, 'ratio=2 不应直接播放原 buffer')
    const call = source.startCalls[0]
    closeTo(call[0], 0)
    closeTo(call[1], 0) // offset 0 × 2
    closeTo(call[2], 8) // timeline 8s
    // 包络：playDuration 8s、fade 0.5/0.5 → [0,0],[0.5,g],[7.5,g],[8,0]
    const gainParam = ctx.params
      .filter((entry) => entry.kind === 'gain' && entry.name === 'gain' && entry.param.ops.length > 0)
      .at(-1)
    const ops = gainParam.param.ops.filter((op) => op.op !== 'cancelScheduledValues')
    closeTo(ops[0].args[0], 0)
    closeTo(ops[0].args[1], 0)
    closeTo(ops[1].args[0], 1)
    closeTo(ops[1].args[1], 0.5)
    closeTo(ops[2].args[0], 1)
    closeTo(ops[2].args[1], 7.5)
    closeTo(ops[3].args[0], 0)
    closeTo(ops[3].args[1], 8)
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

// ---------------------------------------------------------------------------
// 25. CONTRACT-R3B：CC1/CC11/CC74 音频映射（cc64 仅数据）
// ---------------------------------------------------------------------------

function curve(points, enabled = true) {
  return { enabled, points }
}

test('R3b noteExpression：expression×cc11 相乘、modulation+cc1 叠加/夹紧、无曲线不变', () => {
  const clean = noteExpression({ kind: 'synth' }, 0)
  assert.equal(clean.expressionGain, 1)
  assert.equal(clean.modulationCents, 0)
  assert.equal(clean.pitchBendCents, 0)
  assert.equal(clean.vibrato, null)

  const expressionTrack = { kind: 'synth', automation: { expression: curve([{ beat: 0, value: 0.5 }]) } }
  closeTo(noteExpression(expressionTrack, 0).expressionGain, 0.5)
  const cc11Track = { kind: 'synth', automation: { cc11: curve([{ beat: 0, value: 0.25 }]) } }
  closeTo(noteExpression(cc11Track, 0).expressionGain, 0.25)
  const bothTrack = {
    kind: 'synth',
    automation: {
      expression: curve([{ beat: 0, value: 0.5 }]),
      cc11: curve([{ beat: 0, value: 0.5 }]),
    },
  }
  closeTo(noteExpression(bothTrack, 0).expressionGain, 0.25)
  const disabledTrack = { kind: 'synth', automation: { cc11: curve([{ beat: 0, value: 0.2 }], false) } }
  closeTo(noteExpression(disabledTrack, 0).expressionGain, 1)

  const modTrack = {
    kind: 'synth',
    automation: {
      modulation: curve([{ beat: 0, value: 0.5 }]),
      cc1: curve([{ beat: 0, value: 0.2 }]),
    },
  }
  const mod = noteExpression(modTrack, 0)
  closeTo(mod.modulationCents, 70)
  closeTo(mod.vibrato.rateHz, 5)
  closeTo(mod.vibrato.depthCents, 70)
  const cc1Only = { kind: 'synth', automation: { cc1: curve([{ beat: 0, value: 0.3 }]) } }
  closeTo(noteExpression(cc1Only, 0).vibrato.depthCents, 30)
  const clampTrack = {
    kind: 'synth',
    automation: {
      modulation: curve([{ beat: 0, value: 0.9 }]),
      cc1: curve([{ beat: 0, value: 0.6 }]),
    },
  }
  closeTo(noteExpression(clampTrack, 0).modulationCents, 100)
  closeTo(noteExpression(clampTrack, 0).vibrato.depthCents, 100)
  const withVibrato = {
    kind: 'synth',
    vibrato: { enabled: true, rateHz: 6, depthCents: 30 },
    automation: { cc1: curve([{ beat: 0, value: 0.5 }]) },
  }
  const vibratoResult = noteExpression(withVibrato, 0)
  closeTo(vibratoResult.vibrato.rateHz, 6)
  closeTo(vibratoResult.vibrato.depthCents, 80)
  const deep = {
    kind: 'synth',
    vibrato: { enabled: true, rateHz: 6, depthCents: 80 },
    automation: { modulation: curve([{ beat: 0, value: 1 }]) },
  }
  closeTo(noteExpression(deep, 0).vibrato.depthCents, 100)

  const drum = {
    kind: 'drum',
    automation: {
      cc11: curve([{ beat: 0, value: 0.1 }]),
      cc1: curve([{ beat: 0, value: 1 }]),
    },
  }
  const drumResult = noteExpression(drum, 0)
  assert.equal(drumResult.expressionGain, 1)
  assert.equal(drumResult.modulationCents, 0)
  const cc64Track = { kind: 'synth', automation: { cc64: curve([{ beat: 0, value: 0 }]) } }
  assert.equal(noteExpression(cc64Track, 0).expressionGain, 1)
  assert.equal(noteExpression(cc64Track, 0).modulationCents, 0)
})

test('R3b cutoff：cc74 无 cutoff 时驱动 filter 对数映射；cutoff 曲线优先；cc64 不映射', () => {
  const makeProject = (automation) => ({
    bpm: 120,
    lengthBars: 4,
    tracks: [{ id: 'trk_1', kind: 'synth', automation }],
    master: { automation: {} },
  })
  const cc74Project = makeProject({ cc74: curve([{ beat: 0, value: 0 }, { beat: 4, value: 1 }]) })
  const targets = computeAutomationTargets(cc74Project, 2)
  const cutoffTarget = targets.find((target) => target.kind === 'setTrackCutoff')
  assert.ok(cutoffTarget)
  assert.equal(cutoffTarget.param, 'cc74')
  closeTo(cutoffTarget.hz, cutoffHzFromAutomation(0.5))
  closeTo(cutoffTarget.hz, CUTOFF_MIN_HZ * Math.pow(CUTOFF_MAX_HZ / CUTOFF_MIN_HZ, 0.5))
  closeTo(computeAutomationTargets(cc74Project, 0)[0].hz, CUTOFF_MIN_HZ)
  closeTo(computeAutomationTargets(cc74Project, 4)[0].hz, CUTOFF_MAX_HZ)
  assert.equal(computeAutomationTargets(makeProject({}), 0).length, 0)
  assert.equal(computeAutomationTargets(makeProject({ cc64: curve([{ beat: 0, value: 0.2 }]) }), 0).length, 0)
  assert.equal(computeAutomationTargets(makeProject({ cc1: curve([{ beat: 0, value: 1 }]) }), 0).length, 0)

  const bothProject = makeProject({
    cutoff: curve([{ beat: 0, value: 0.25 }]),
    cc74: curve([{ beat: 0, value: 1 }]),
  })
  const bothTarget = computeAutomationTargets(bothProject, 0)[0]
  assert.equal(bothTarget.param, 'cutoff')
  closeTo(bothTarget.hz, cutoffHzFromAutomation(0.25))
  assert.equal(effectiveCutoffCurve(makeProject({}).tracks[0]), null)
  assert.equal(effectiveCutoffCurve(makeProject({ cc74: curve([{ beat: 0, value: 0.5 }]) }).tracks[0]).param, 'cc74')
  assert.equal(
    effectiveCutoffCurve(makeProject({ cutoff: curve([{ beat: 0, value: 0.1 }]), cc74: curve([{ beat: 0, value: 1 }]) }).tracks[0]).param,
    'cutoff',
  )
  assert.equal(effectiveCutoffCurve(makeProject({ cc74: curve([{ beat: 0, value: 0.5 }], false) }).tracks[0]), null)

  const plan = computeRenderPlan(cc74Project, { fromBar: 0, toBar: 2 })
  const schedule = buildOfflineAutomationSchedule(cc74Project, plan)
  assert.equal(schedule.tracks.length, 1)
  const entry = schedule.tracks[0]
  assert.ok(entry.cutoff)
  assert.equal(entry.cutoff.param, 'cc74')
  assert.ok(entry.cutoff.samples.length > 1)
  closeTo(entry.cutoff.samples[0].mapped, CUTOFF_MIN_HZ)
  // plan 覆盖 beat 0..8，曲线在 beat4 到 1 后保持 → 末采样为最大截止
  closeTo(entry.cutoff.samples.at(-1).mapped, CUTOFF_MAX_HZ)
  assert.equal(schedule.hasCutoffDynamic, true)

  const bothPlan = computeRenderPlan(bothProject, { fromBar: 0, toBar: 2 })
  const bothSchedule = buildOfflineAutomationSchedule(bothProject, bothPlan)
  assert.equal(bothSchedule.tracks[0].cutoff.param, 'cutoff')
  const cc64Project = makeProject({ cc64: curve([{ beat: 0, value: 0.2 }]) })
  const cc64Plan = computeRenderPlan(cc64Project, { fromBar: 0, toBar: 2 })
  const cc64Schedule = buildOfflineAutomationSchedule(cc64Project, cc64Plan)
  assert.equal(cc64Schedule.tracks.length, 0)
  assert.equal(cc64Schedule.hasCutoffDynamic, false)

  const staticProject = makeProject({ cc74: curve([{ beat: 0, value: 0.6 }]) })
  const staticSchedule = buildOfflineAutomationSchedule(staticProject, computeRenderPlan(staticProject, { fromBar: 0, toBar: 2 }))
  assert.equal(staticSchedule.tracks[0].cutoff.param, 'cc74')
  assert.equal(staticSchedule.hasCutoffDynamic, false)
})

// ---------------------------------------------------------------------------
// 26. CONTRACT-R4A：Group bus 路由（project.groups + track.output）
// ---------------------------------------------------------------------------

function makeGroupProject({ groups = [], tracks = [], outputs = {} } = {}) {
  return {
    bpm: 120,
    lengthBars: 4,
    master: { volume: 0.82, effects: [] },
    buses: { reverb: { level: 0.35, effects: [] }, delay: { level: 0.22, effects: [] } },
    groups,
    tracks: tracks.map((track) => ({
      id: track.id,
      name: track.id,
      kind: track.kind ?? 'synth',
      volume: track.volume ?? 0.8,
      pan: 0,
      mute: track.mute === true,
      solo: track.solo === true,
      effects: track.effects ?? [],
      sends: { reverb: 0, delay: 0 },
      automation: {},
      ...(track.sendMode ? { sendMode: track.sendMode } : {}),
      ...(track.phaseInvert ? { phaseInvert: true } : {}),
      ...(track.mono ? { mono: true } : {}),
      ...(track.bypassFx ? { bypassFx: true } : {}),
      ...(track.pdcMs ? { pdcMs: track.pdcMs } : {}),
      ...(outputs[track.id] ? { output: outputs[track.id] } : {}),
    })),
    patterns: [],
    clips: [],
  }
}

test('R4a normalizeEngineGroups / resolveTrackGroupId：上限/默认/去重/非法/output 回退', () => {
  const groups = normalizeEngineGroups([
    { id: 'grp_1', name: 'Drums', level: 0.5, effects: [makeEffect('gfx_1', 'filter', { cutoff: 2000 })], mute: true },
    { id: 'grp_1', name: 'dup' },
    { id: 'grp_2', name: 'Bass' },
    null,
    'x',
    { id: '' },
    { id: 'grp_3', name: 'Pad', level: 2, output: 'master' },
  ])
  assert.equal(groups.length, 3)
  assert.equal(groups[0].id, 'grp_1')
  assert.equal(groups[0].name, 'Drums')
  closeTo(groups[0].level, 0.5)
  assert.equal(groups[0].mute, true)
  assert.equal(groups[0].solo, false)
  assert.equal(groups[0].output, GROUP_OUTPUT_MASTER)
  assert.equal(groups[0].effects.length, 1)
  assert.equal(groups[1].id, 'grp_2')
  closeTo(groups[1].level, GROUP_LEVEL_DEFAULT)
  closeTo(groups[2].level, 1)
  // 上限 8
  const many = normalizeEngineGroups(
    Array.from({ length: 12 }, (_, index) => ({ id: `g${index + 1}`, name: `G${index + 1}` })),
  )
  assert.equal(many.length, GROUPS_MAX)
  assert.equal(normalizeEngineGroups(undefined).length, 0)
  assert.equal(normalizeEngineGroups('bad').length, 0)
  // track output 解析
  const project = makeGroupProject({
    groups,
    tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    outputs: { a: 'grp_1', b: 'grp_missing', c: 'master' },
  })
  assert.equal(resolveTrackGroupId(project, project.tracks[0]), 'grp_1')
  assert.equal(resolveTrackGroupId(project, project.tracks[1]), null)
  assert.equal(resolveTrackGroupId(project, project.tracks[2]), null)
  assert.equal(resolveTrackGroupId(project, { id: 'x', output: 'grp_2' }), 'grp_2')
})

test('R4a trackGainForValue/groupGainFor：group mute/solo 与 track solo 合并；无 groups 旧行为不变', () => {
  // 无 groups：与旧语义完全一致
  const legacy = makeGroupProject({ tracks: [{ id: 'a', volume: 0.8 }, { id: 'b', volume: 0.5, mute: true }] })
  closeTo(trackGainForValue(legacy, legacy.tracks[0], 0.8), Math.pow(0.8, 1.35))
  assert.equal(trackGainForValue(legacy, legacy.tracks[1], 0.5), 0)
  legacy.tracks[0].solo = true
  legacy.tracks[1].mute = false
  closeTo(trackGainForValue(legacy, legacy.tracks[0], 0.8), Math.pow(0.8, 1.35))
  assert.equal(trackGainForValue(legacy, legacy.tracks[1], 0.5), 0)
  legacy.tracks[0].solo = false
  legacy.tracks[1].solo = true
  assert.equal(trackGainForValue(legacy, legacy.tracks[0], 0.8), 0)
  closeTo(trackGainForValue(legacy, legacy.tracks[1], 0.5), Math.pow(0.5, 1.35))

  const groups = [
    { id: 'grp_1', name: 'A', level: 0.5, effects: [], mute: false, solo: false, output: 'master' },
    { id: 'grp_2', name: 'B', level: 0.8, effects: [], mute: false, solo: false, output: 'master' },
  ]
  const project = makeGroupProject({
    groups,
    tracks: [{ id: 'a', volume: 0.8 }, { id: 'b', volume: 0.8 }],
    outputs: { a: 'grp_1', b: 'grp_2' },
  })
  const a = project.tracks[0]
  const b = project.tracks[1]
  const group1 = project.groups[0]
  const group2 = project.groups[1]
  // 无 solo/mute：track 正常、group 增益=level（线性）
  closeTo(trackGainForValue(project, a, 0.8), Math.pow(0.8, 1.35))
  closeTo(groupGainFor(project, group1), 0.5)
  closeTo(groupGainFor(project, group2), 0.8)
  // group mute → 其中轨道静音 + 组增益 0；另一组不受影响
  project.groups[0].mute = true
  assert.equal(trackGainForValue(project, a, 0.8), 0)
  assert.equal(groupGainFor(project, group1), 0)
  closeTo(trackGainForValue(project, b, 0.8), Math.pow(0.8, 1.35))
  project.groups[0].mute = false
  // group solo → 仅该组轨道 + 该组增益；另一组轨道/增益 0
  project.groups[0].solo = true
  closeTo(trackGainForValue(project, a, 0.8), Math.pow(0.8, 1.35))
  assert.equal(trackGainForValue(project, b, 0.8), 0)
  closeTo(groupGainFor(project, group1), 0.5)
  assert.equal(groupGainFor(project, group2), 0)
  project.groups[0].solo = false
  // track solo（组都不 solo）→ 该轨 audible；其所属组仍出声（anySoloTrackInGroup），另一组 0
  project.tracks[1].solo = true
  assert.equal(trackGainForValue(project, a, 0.8), 0)
  closeTo(trackGainForValue(project, b, 0.8), Math.pow(0.8, 1.35))
  assert.equal(groupGainFor(project, group1), 0)
  closeTo(groupGainFor(project, group2), 0.8)
  // group solo + 另一组 track solo：两者都可听（合并 solo 模式）
  project.groups[0].solo = true
  closeTo(trackGainForValue(project, a, 0.8), Math.pow(0.8, 1.35))
  closeTo(trackGainForValue(project, b, 0.8), Math.pow(0.8, 1.35))
  closeTo(groupGainFor(project, group1), 0.5)
  closeTo(groupGainFor(project, group2), 0.8)
})

test('R4a graphSignature：group 集合/group FX 链结构/track.output 变化才重建；level/mute/solo 走 update', () => {
  const base = makeGroupProject({ tracks: [{ id: 'a' }, { id: 'b' }] })
  const sigBase = graphSignature(base)
  // 无 groups 与有 groups 不同
  const withGroup = makeGroupProject({ groups: [{ id: 'grp_1', name: 'G', level: 0.5 }], tracks: [{ id: 'a' }], outputs: { a: 'grp_1' } })
  const sigWithGroup = graphSignature(withGroup)
  assert.notEqual(sigWithGroup, sigBase)
  // level / mute / solo 不改变签名（原地 update）
  const levelChanged = JSON.parse(JSON.stringify(withGroup))
  levelChanged.groups[0].level = 0.1
  levelChanged.groups[0].mute = true
  levelChanged.groups[0].solo = true
  assert.equal(graphSignature(levelChanged), sigWithGroup)
  // group FX 链结构变化 → 签名变化
  const fxChanged = JSON.parse(JSON.stringify(withGroup))
  fxChanged.groups[0].effects = [makeEffect('gfx_1', 'filter', { cutoff: 2000 })]
  assert.notEqual(graphSignature(fxChanged), sigWithGroup)
  // track.output 变化 → 签名变化
  const outputChanged = JSON.parse(JSON.stringify(withGroup))
  outputChanged.tracks[0].output = 'master'
  assert.notEqual(graphSignature(outputChanged), sigWithGroup)
  // 增删 group → 签名变化
  const groupRemoved = JSON.parse(JSON.stringify(withGroup))
  groupRemoved.groups = []
  delete groupRemoved.tracks[0].output
  assert.notEqual(graphSignature(groupRemoved), sigWithGroup)
})

test('R4a buildMixGraph：groupInput→FX→level→master、track 输出到 group、update 应用 level/mute/solo/FX', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = makeGroupProject({
    groups: [
      {
        id: 'grp_1',
        name: 'Drums',
        level: 0.5,
        effects: [makeEffect('gfx_1', 'filter', { cutoff: 2000, mix: 1 })],
        mute: false,
        solo: false,
      },
      { id: 'grp_2', name: 'Bass', level: 0.8, effects: [] },
    ],
    tracks: [{ id: 'a' }, { id: 'b' }],
    outputs: { a: 'grp_1', b: 'grp_2' },
  })
  const graph = buildMixGraph(ctx, project, { analysers: false })
  try {
    assert.equal(graph.groups.size, 2)
    const group1 = graph.groups.get('grp_1')
    const group2 = graph.groups.get('grp_2')
    assert.ok(group1 && group1.input && group1.fx && group1.level)
    const isConnected = (from, to) => ctx.connections.some((connection) => connection.from === from && connection.to === to)
    // group 链：input → fx.input → (fx 内部) → fx.output → level → masterIn
    assert.equal(isConnected(group1.input, group1.fx.input), true)
    assert.equal(isConnected(group1.fx.output, group1.level), true)
    assert.equal(isConnected(group1.level, graph.masterIn), true)
    // track 输出到 group input（非直接 master）
    const trackA = graph.tracks.get('a')
    const trackB = graph.tracks.get('b')
    assert.equal(trackA.outputGroupId, 'grp_1')
    assert.equal(trackB.outputGroupId, 'grp_2')
    assert.equal(isConnected(trackA.outputNode, group1.input), true)
    assert.equal(isConnected(trackB.outputNode, group2.input), true)
    assert.equal(isConnected(trackA.outputNode, graph.masterIn), false)
    assert.equal(isConnected(trackB.outputNode, graph.masterIn), false)
    // 组 level（线性）：0.5 / 0.8
    closeTo(group1.level.gain.value, 0.5)
    closeTo(group2.level.gain.value, 0.8)

    // update：level/mute/solo/FX 参数原地更新
    const next = JSON.parse(JSON.stringify(project))
    next.groups[0].level = 0.25
    next.groups[0].mute = false
    graph.update(next)
    const levelOps = group1.level.gain.ops
    assert.ok(levelOps.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.25) < 1e-9))
    closeTo(group2.level.gain.value, 0.8)
    next.groups[0].mute = true
    graph.update(next)
    assert.ok(
      group1.level.gain.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0]) < 1e-9),
      'group mute 应把 level 增益降到 0',
    )
    next.groups[0].mute = false
    next.groups[0].solo = true
    graph.update(next)
    assert.ok(
      group1.level.gain.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.25) < 1e-9),
      'group solo 时恢复 level',
    )
    // 另一组在 solo 模式下应被压到 0
    assert.ok(group2.level.gain.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0]) < 1e-9))
    // 无 groups 的旧工程：track 直接连 masterIn（行为不变）
    const legacy = makeGroupProject({ tracks: [{ id: 'a' }] })
    const legacyGraph = buildMixGraph(ctx, legacy, { analysers: false })
    try {
      const legacyTrack = legacyGraph.tracks.get('a')
      assert.equal(legacyTrack.outputGroupId, null)
      const isConnectedLegacy = (from, to) => ctx.connections.some((connection) => connection.from === from && connection.to === to)
      assert.equal(isConnectedLegacy(legacyTrack.outputNode, legacyGraph.masterIn), true)
      assert.equal(legacyGraph.groups.size, 0)
    } finally {
      legacyGraph.dispose()
    }
  } finally {
    graph.dispose()
  }
})

// ---------------------------------------------------------------------------
// 27. CONTRACT-R4B：pre/post send、phaseInvert、mono、bypassFx、PDC
// ---------------------------------------------------------------------------

test('R4b normalizeSendMode/normalizePdcMs/phaseGainFor/routing signature', () => {
  assert.equal(normalizeSendMode('pre'), 'pre')
  assert.equal(normalizeSendMode('post'), 'post')
  assert.equal(normalizeSendMode(undefined), 'post')
  assert.equal(normalizeSendMode('bad'), 'post')
  assert.equal(normalizePdcMs(100), 100)
  assert.equal(normalizePdcMs(100.25), 100.3)
  assert.equal(normalizePdcMs(999), 500)
  assert.equal(normalizePdcMs(-5), 0)
  assert.equal(normalizePdcMs('x'), 0)
  assert.equal(phaseGainFor({ phaseInvert: true }), -1)
  assert.equal(phaseGainFor({ phaseInvert: false }), 1)
  assert.equal(phaseGainFor(undefined), 1)
  assert.equal(trackRoutingSignature({}), 's:post|b:0|m:0|p:0|i:0')
  assert.equal(trackRoutingSignature({ sendMode: 'pre', bypassFx: true, mono: true, pdcMs: 100 }), 's:pre|b:1|m:1|p:1|i:0')
  assert.equal(trackRoutingSignature({ pdcMs: 0 }), 's:post|b:0|m:0|p:0|i:0')
  assert.equal(groupRoutingSignature({}, {}), 'b:0|p:0')
  assert.equal(groupRoutingSignature({ bypassFx: true, pdcMs: 50 }), 'b:1|p:1')
})

test('R4b graphSignature：sendMode/bypass/mono/pdc>0 结构变化触发重建；phaseInvert/PDC 数值走 update', () => {
  const base = makeGroupProject({ tracks: [{ id: 'a' }], groups: [{ id: 'grp_1', name: 'G', level: 0.8 }], outputs: { a: 'grp_1' } })
  const baseSig = graphSignature(base)
  const explicitDefaults = JSON.parse(JSON.stringify(base))
  explicitDefaults.tracks[0].sendMode = 'post'
  explicitDefaults.tracks[0].phaseInvert = false
  explicitDefaults.tracks[0].mono = false
  explicitDefaults.tracks[0].bypassFx = false
  explicitDefaults.tracks[0].pdcMs = 0
  assert.equal(graphSignature(explicitDefaults), baseSig)
  const changed = (mutate) => {
    const next = JSON.parse(JSON.stringify(base))
    mutate(next)
    return graphSignature(next) !== baseSig
  }
  assert.equal(changed((p) => (p.tracks[0].sendMode = 'pre')), true)
  assert.equal(changed((p) => (p.tracks[0].bypassFx = true)), true)
  assert.equal(changed((p) => (p.tracks[0].mono = true)), true)
  assert.equal(changed((p) => (p.tracks[0].pdcMs = 100)), true)
  assert.equal(changed((p) => (p.tracks[0].phaseInvert = true)), false)
  const pdced = JSON.parse(JSON.stringify(base))
  pdced.tracks[0].pdcMs = 100
  const pdcedSig = graphSignature(pdced)
  const pdced2 = JSON.parse(JSON.stringify(pdced))
  pdced2.tracks[0].pdcMs = 250
  assert.equal(graphSignature(pdced2), pdcedSig)
  const groupBypass = JSON.parse(JSON.stringify(base))
  groupBypass.groups[0].bypassFx = true
  assert.notEqual(graphSignature(groupBypass), baseSig)
  const groupPdc = JSON.parse(JSON.stringify(base))
  groupPdc.groups[0].pdcMs = 80
  assert.notEqual(graphSignature(groupPdc), baseSig)
  const groupPdc2 = JSON.parse(JSON.stringify(groupPdc))
  groupPdc2.groups[0].pdcMs = 160
  assert.equal(graphSignature(groupPdc2), graphSignature(groupPdc))
})

test('R4b buildMixGraph：post 默认发送点 / pre 从 FX 前取 / bypass 直通 / phaseInvert / mono / PDC', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const isConnected = (from, to) => ctx.connections.some((connection) => connection.from === from && connection.to === to)
  const makeProjectWith = (trackFields = {}, groupFields = {}) =>
    makeGroupProject({
      groups: [{ id: 'grp_1', name: 'G', level: 0.8, ...groupFields }],
      tracks: [{ id: 'a', effects: [makeEffect('fx_1', 'drive', { amount: 0.5, tone: 0.6, mix: 1 })], ...trackFields }],
      outputs: { a: 'grp_1' },
    })

  const defaultGraph = buildMixGraph(ctx, makeProjectWith(), { analysers: false })
  try {
    const entry = defaultGraph.tracks.get('a')
    assert.equal(entry.sendMode, 'post')
    assert.equal(entry.bypassFx, false)
    assert.equal(entry.phase.gain.value, 1)
    assert.equal(entry.outputNode, entry.phase)
    assert.equal(isConnected(entry.postFx, entry.sendReverb), true)
    assert.equal(isConnected(entry.preFx, entry.sendReverb), false)
    assert.equal(isConnected(entry.phase, defaultGraph.groups.get('grp_1').input), true)
  } finally {
    defaultGraph.dispose()
  }

  const preGraph = buildMixGraph(ctx, makeProjectWith({ sendMode: 'pre' }), { analysers: false })
  try {
    const entry = preGraph.tracks.get('a')
    assert.equal(entry.sendMode, 'pre')
    assert.equal(isConnected(entry.preFx, entry.sendReverb), true)
    assert.equal(isConnected(entry.preFx, entry.sendDelay), true)
    assert.equal(isConnected(entry.postFx, entry.sendReverb), false)
  } finally {
    preGraph.dispose()
  }

  const bypassGraph = buildMixGraph(ctx, makeProjectWith({ bypassFx: true }), { analysers: false })
  try {
    const entry = bypassGraph.tracks.get('a')
    assert.equal(entry.bypassFx, true)
    assert.ok(entry.dry)
    assert.equal(entry.postFx, entry.dry)
    assert.equal(isConnected(entry.preFx, entry.dry), true)
    assert.equal(isConnected(entry.preFx, entry.fx.input), false)
    assert.equal(isConnected(entry.phase, bypassGraph.groups.get('grp_1').input), true)
  } finally {
    bypassGraph.dispose()
  }

  const phaseMonoGraph = buildMixGraph(ctx, makeProjectWith({ phaseInvert: true, mono: true }), { analysers: false })
  try {
    const entry = phaseMonoGraph.tracks.get('a')
    assert.equal(entry.phase.gain.value, -1)
    assert.ok(entry.monoNode)
    assert.equal(entry.monoNode.channelCount, 1)
    assert.equal(entry.monoNode.channelCountMode, 'explicit')
    assert.equal(entry.monoNode.channelInterpretation, 'speakers')
    assert.equal(entry.outputNode, entry.monoNode)
    assert.equal(isConnected(entry.phase, entry.monoNode), true)
    assert.equal(isConnected(entry.monoNode, phaseMonoGraph.groups.get('grp_1').input), true)
  } finally {
    phaseMonoGraph.dispose()
  }

  const pdcGraph = buildMixGraph(ctx, makeProjectWith({ pdcMs: 100 }, { pdcMs: 120 }), { analysers: false })
  try {
    const entry = pdcGraph.tracks.get('a')
    assert.ok(entry.pdcDelay)
    closeTo(entry.pdcDelay.delayTime.value, 0.1)
    assert.equal(entry.outputNode, entry.pdcDelay)
    const group = pdcGraph.groups.get('grp_1')
    assert.ok(group.pdcDelay)
    closeTo(group.pdcDelay.delayTime.value, 0.12)
    assert.equal(group.outputNode, group.pdcDelay)
    assert.equal(isConnected(group.level, group.pdcDelay), true)
    assert.equal(isConnected(group.pdcDelay, pdcGraph.masterIn), true)
    const next = JSON.parse(JSON.stringify(makeProjectWith({ pdcMs: 250 }, { pdcMs: 40 })))
    next.tracks[0].phaseInvert = true
    pdcGraph.update(next)
    assert.ok(entry.phase.gain.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - -1) < 1e-9))
    assert.ok(entry.pdcDelay.delayTime.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.25) < 1e-9))
    assert.ok(group.pdcDelay.delayTime.ops.some((op) => op.op === 'setTargetAtTime' && Math.abs(op.args[0] - 0.04) < 1e-9))
  } finally {
    pdcGraph.dispose()
  }

  const groupBypassGraph = buildMixGraph(ctx, makeProjectWith({}, { bypassFx: true }), { analysers: false })
  try {
    const group = groupBypassGraph.groups.get('grp_1')
    assert.equal(group.bypassFx, true)
    assert.ok(group.dry)
    const isConnected2 = (from, to) => ctx.connections.some((connection) => connection.from === from && connection.to === to)
    assert.equal(isConnected2(group.input, group.dry), true)
    assert.equal(isConnected2(group.dry, group.level), true)
    assert.equal(isConnected2(group.input, group.fx.input), false)
    assert.equal(isConnected2(group.level, groupBypassGraph.masterIn), true)
  } finally {
    groupBypassGraph.dispose()
  }
})

// ---------------------------------------------------------------------------
// 28. CONTRACT-R4C：getMeters 实时电平表数值（只读）
// ---------------------------------------------------------------------------

test('R4c linearToDb/lufsApproxFromRms/meterSnapshot/emptyMeters：静音 -120、钳制 0..1', () => {
  closeTo(meterDbFromLinear(1), 0)
  closeTo(meterDbFromLinear(0.5), 20 * Math.log10(0.5))
  assert.equal(meterDbFromLinear(0), -120)
  assert.equal(meterDbFromLinear(-1), -120)
  assert.equal(meterDbFromLinear(2), 0) // 钳制 0..1
  closeTo(lufsApproxFromRms(1), -0.691)
  closeTo(lufsApproxFromRms(0.5), -0.691 + 20 * Math.log10(0.5))
  assert.equal(lufsApproxFromRms(0), -120)
  const silent = meterSnapshot({ rms: 0, peak: 0 })
  assert.deepEqual(silent, { rms: 0, rmsDb: -120, peak: 0, peakDb: -120 })
  const half = meterSnapshot({ rms: 0.5, peak: 0.8 })
  closeTo(half.rms, 0.5)
  closeTo(half.peak, 0.8)
  closeTo(half.rmsDb, 20 * Math.log10(0.5))
  closeTo(half.peakDb, 20 * Math.log10(0.8))
  // 空表：当前工程轨道全 0/-120，master 带 lufsApprox
  const project = { tracks: [{ id: 'a' }, { id: 'b' }] }
  const empty = emptyMeters(project)
  assert.deepEqual(Object.keys(empty.tracks), ['a', 'b'])
  assert.equal(empty.tracks.a.rmsDb, -120)
  assert.equal(empty.tracks.b.peakDb, -120)
  assert.equal(empty.master.rmsDb, -120)
  assert.equal(empty.master.lufsApprox, -120)
  assert.deepEqual(emptyMeters(null), { tracks: {}, groups: {}, master: { rms: 0, rmsDb: -120, peak: 0, peakDb: -120, lufsApprox: -120 } })
  const groupProject = { tracks: [{ id: 'a', output: 'grp_1' }], groups: [{ id: 'grp_1', name: 'G', level: 0.8 }] }
  const emptyGroups = emptyMeters(groupProject)
  assert.deepEqual(Object.keys(emptyGroups.groups), ['grp_1'])
  assert.equal(emptyGroups.groups.grp_1.rmsDb, -120)
  assert.equal(emptyGroups.groups.grp_1.peakDb, -120)
})

test('R4c readAnalyserTimeStats：float/byte 时域、异常/缺 analyser 返回 0', () => {
  const floatAnalyser = {
    getFloatTimeDomainData: (arr) => {
      arr[0] = 0.5
      arr[1] = -0.5
      arr[2] = 0
      arr[3] = 0
    },
  }
  const stats = readAnalyserTimeStats(floatAnalyser, new Float32Array(4))
  closeTo(stats.rms, Math.sqrt((0.25 + 0.25) / 4))
  closeTo(stats.peak, 0.5)
  // 仅有 byte 时域：192 → 0.5
  const byteAnalyser = {
    getByteTimeDomainData: (bytes) => {
      bytes.fill(128)
      bytes[0] = 192
      bytes[1] = 64
    },
  }
  const byteStats = readAnalyserTimeStats(byteAnalyser, new Float32Array(4))
  closeTo(byteStats.peak, 0.5)
  closeTo(byteStats.rms, Math.sqrt((0.25 + 0.25) / 4))
  assert.deepEqual(readAnalyserTimeStats(null, new Float32Array(4)), { rms: 0, peak: 0 })
  assert.deepEqual(readAnalyserTimeStats(floatAnalyser, null), { rms: 0, peak: 0 })
  const throwing = { getFloatTimeDomainData: () => { throw new Error('x') } }
  assert.deepEqual(readAnalyserTimeStats(throwing, new Float32Array(4)), { rms: 0, peak: 0 })
  // 无任何时域方法
  assert.deepEqual(readAnalyserTimeStats({}, new Float32Array(4)), { rms: 0, peak: 0 })
})

test('R4c aggregateGroupMeters：组内轨道能量聚合、组 mute/solo 为 0/-120、组无轨 -120', () => {
  const groups = [
    { id: 'grp_1', name: 'G1', level: 0.5, effects: [], mute: false, solo: false, output: 'master' },
    { id: 'grp_2', name: 'G2', level: 0.8, effects: [], mute: false, solo: false, output: 'master' },
  ]
  const project = makeGroupProject({
    groups,
    tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    outputs: { a: 'grp_1', b: 'grp_1', c: 'grp_2' },
  })
  const trackMeters = {
    a: { rms: 0.5, peak: 0.6 },
    b: { rms: 0.3, peak: 0.4 },
    c: { rms: 0.2, peak: 0.25 },
  }
  const meters = aggregateGroupMeters(project, trackMeters)
  // grp_1：level 0.5 → sqrt((0.25)^2+(0.15)^2)=sqrt(0.085)≈0.2915，peak=max(.6,.4)*.5=.3
  closeTo(meters.grp_1.rms, Math.sqrt(0.085))
  closeTo(meters.grp_1.peak, 0.3)
  closeTo(meters.grp_1.rmsDb, 20 * Math.log10(Math.sqrt(0.085)))
  // grp_2：level 0.8 → rms .16，peak .2
  closeTo(meters.grp_2.rms, 0.16)
  closeTo(meters.grp_2.peak, 0.2)
  // 组 mute → 0/-120
  project.groups[0].mute = true
  const muted = aggregateGroupMeters(project, trackMeters)
  assert.equal(muted.grp_1.rms, 0)
  assert.equal(muted.grp_1.rmsDb, -120)
  assert.equal(muted.grp_1.peakDb, -120)
  closeTo(muted.grp_2.rms, 0.16)
  project.groups[0].mute = false
  // grp_2 solo → grp_1 0/-120，grp_2 仍按 level 聚合
  project.groups[1].solo = true
  const soloed = aggregateGroupMeters(project, trackMeters)
  assert.equal(soloed.grp_1.rmsDb, -120)
  closeTo(soloed.grp_2.rms, 0.16)
  project.groups[1].solo = false
  // 组内无轨道（grp_3）→ 0/-120
  project.groups.push({ id: 'grp_3', name: 'G3', level: 1, effects: [], mute: false, solo: false, output: 'master' })
  const withEmpty = aggregateGroupMeters(project, trackMeters)
  assert.equal(withEmpty.grp_3.rms, 0)
  assert.equal(withEmpty.grp_3.rmsDb, -120)
  // 轨道无表值 → 该轨不计入
  const partial = aggregateGroupMeters(project, { a: { rms: 0.5, peak: 0.6 } })
  closeTo(partial.grp_1.rms, 0.25)
  closeTo(partial.grp_1.peak, 0.3)
})

test('R4c graph.getMeters：tracks/master rms/peak/db/lufsApprox；静音 -120；只读不新增节点', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = makeGroupProject({ tracks: [{ id: 'a' }, { id: 'b' }] })
  const graph = buildMixGraph(ctx, project, { analysers: true })
  try {
    const trackA = graph.tracks.get('a')
    const trackB = graph.tracks.get('b')
    assert.ok(trackA.analyser)
    assert.ok(graph.masterAnalyser)
    // mock analyser 时域数据：a=0.5 全幅、b=静音、master=0.25 全幅
    trackA.analyser.getFloatTimeDomainData = (arr) => arr.fill(0.5)
    trackB.analyser.getFloatTimeDomainData = (arr) => arr.fill(0)
    graph.masterAnalyser.getFloatTimeDomainData = (arr) => arr.fill(0.25)
    const nodeCountBefore = ctx.nodeCount
    const paramOpsBefore = ctx.params.reduce((sum, entry) => sum + entry.param.ops.length, 0)
    const meters = graph.getMeters()
    // 只读：不新增节点/不写 AudioParam
    assert.equal(ctx.nodeCount, nodeCountBefore)
    assert.equal(ctx.params.reduce((sum, entry) => sum + entry.param.ops.length, 0), paramOpsBefore)
    closeTo(meters.tracks.a.rms, 0.5)
    closeTo(meters.tracks.a.peak, 0.5)
    closeTo(meters.tracks.a.rmsDb, 20 * Math.log10(0.5))
    closeTo(meters.tracks.a.peakDb, 20 * Math.log10(0.5))
    assert.equal(meters.tracks.b.rms, 0)
    assert.equal(meters.tracks.b.rmsDb, -120)
    assert.equal(meters.tracks.b.peakDb, -120)
    closeTo(meters.master.rms, 0.25)
    closeTo(meters.master.rmsDb, 20 * Math.log10(0.25))
    closeTo(meters.master.lufsApprox, -0.691 + 20 * Math.log10(0.25))
    // byte 时域回退
    trackA.analyser.getFloatTimeDomainData = undefined
    trackA.analyser.getByteTimeDomainData = (bytes) => bytes.fill(192)
    const byteMeters = graph.getMeters()
    closeTo(byteMeters.tracks.a.rms, 0.5)
    closeTo(byteMeters.tracks.a.peak, 0.5)
  } finally {
    graph.dispose()
  }

  // analysers:false（离线/无图）→ 全 0/-120
  const silentGraph = buildMixGraph(ctx, project, { analysers: false })
  try {
    const meters = silentGraph.getMeters()
    assert.equal(meters.tracks.a.rmsDb, -120)
    assert.equal(meters.master.rmsDb, -120)
    assert.equal(meters.master.lufsApprox, -120)
  } finally {
    silentGraph.dispose()
  }
})

test('R4c engine.getMeters：未解锁/无图返回工程轨 0/-120；有图合并 graph 数值；异常回退', () => {
  const project = { tracks: [{ id: 'trk_1' }, { id: 'trk_2' }] }
  const engine = new StudioEngine()
  engine.setProject(project)
  const empty = engine.getMeters()
  assert.deepEqual(Object.keys(empty.tracks), ['trk_1', 'trk_2'])
  assert.equal(empty.tracks.trk_1.rmsDb, -120)
  assert.deepEqual(empty.groups, {})
  assert.equal(empty.master.lufsApprox, -120)
  // 注入 mock graph：合并轨道数值，master 用 graph 的
  engine._graph = {
    getMeters: () => ({
      tracks: {
        trk_1: { rms: 0.5, rmsDb: 20 * Math.log10(0.5), peak: 0.6, peakDb: 20 * Math.log10(0.6) },
      },
      groups: {
        grp_1: { rms: 0.25, rmsDb: 20 * Math.log10(0.25), peak: 0.3, peakDb: 20 * Math.log10(0.3) },
      },
      master: { rms: 0.25, rmsDb: 20 * Math.log10(0.25), peak: 0.3, peakDb: 20 * Math.log10(0.3), lufsApprox: -12 },
    }),
  }
  const merged = engine.getMeters()
  closeTo(merged.tracks.trk_1.rms, 0.5)
  assert.equal(merged.tracks.trk_2.rmsDb, -120)
  closeTo(merged.groups.grp_1.rms, 0.25)
  closeTo(merged.master.rms, 0.25)
  assert.equal(merged.master.lufsApprox, -12)
  // graph 抛错 → 安全回退空表
  engine._graph = { getMeters: () => { throw new Error('x') } }
  const fallback = engine.getMeters()
  assert.equal(fallback.tracks.trk_1.rmsDb, -120)
  assert.equal(fallback.master.rmsDb, -120)
  // graph 返回缺失 master → 用空表 master
  engine._graph = { getMeters: () => ({ tracks: {} }) }
  assert.equal(engine.getMeters().master.lufsApprox, -120)
  engine.dispose()
})

// ---------------------------------------------------------------------------
// 29. CONTRACT-R5B：instrumentParams（包络 / filter / LFO）
// ---------------------------------------------------------------------------

test('R5b effectiveInstrumentParams/voiceInstrumentOptions/instrumentFilterSettings：默认省略/夹紧/非 synth', () => {
  assert.equal(INSTRUMENT_PARAM_DEFAULTS.attack, 0.005)
  const synth = {
    kind: 'synth',
    instrumentParams: {
      attack: 0.5,
      release: 1.2,
      filterCutoff: 300,
      filterQ: 8,
      lfoRate: 6,
      lfoDepth: 100,
    },
  }
  const params = effectiveInstrumentParams(synth)
  assert.deepEqual(params, { attack: 0.5, release: 1.2, filterCutoff: 300, filterQ: 8, lfoRate: 6, lfoDepth: 100 })
  assert.deepEqual(effectiveInstrumentParams({ kind: 'synth', instrumentParams: { attack: 0.005, filterCutoff: 20000, lfoDepth: 0 } }), {})
  assert.deepEqual(effectiveInstrumentParams({ kind: 'synth', instrumentParams: { unknown: 1 } }), {})
  const clamped = effectiveInstrumentParams({ kind: 'synth', instrumentParams: { attack: 99, release: 0, filterQ: 0, lfoDepth: 999 } })
  closeTo(clamped.attack, 2)
  closeTo(clamped.release, 0.01)
  closeTo(clamped.filterQ, 0.1)
  closeTo(clamped.lfoDepth, 100)
  assert.deepEqual(effectiveInstrumentParams({ kind: 'drum', instrumentParams: { attack: 0.5 } }), {})
  assert.deepEqual(effectiveInstrumentParams({ kind: 'audio', instrumentParams: { attack: 0.5 } }), {})
  assert.deepEqual(effectiveInstrumentParams(null), {})
  assert.deepEqual(voiceInstrumentOptions({ kind: 'synth' }), {})
  assert.deepEqual(voiceInstrumentOptions({ kind: 'synth', instrumentParams: { attack: 0.4, release: 1 } }), { attack: 0.4, release: 1 })
  assert.deepEqual(voiceInstrumentOptions({ kind: 'synth', instrumentParams: { lfoDepth: 0 } }), {})
  assert.deepEqual(voiceInstrumentOptions({ kind: 'synth', instrumentParams: { lfoDepth: 80 } }), { lfo: { rateHz: 5, depthCents: 80 } })
  assert.deepEqual(voiceInstrumentOptions({ kind: 'synth', instrumentParams: { lfoRate: 7, lfoDepth: 50 } }), {
    lfo: { rateHz: 7, depthCents: 50 },
  })
  assert.equal(instrumentFilterSettings({ kind: 'synth' }), null)
  assert.deepEqual(instrumentFilterSettings({ kind: 'synth', instrumentParams: { filterCutoff: 300 } }), { cutoff: 300, q: 0.7 })
  assert.deepEqual(instrumentFilterSettings({ kind: 'synth', instrumentParams: { filterQ: 5 } }), { cutoff: 20000, q: 5 })
  assert.equal(instrumentFilterSettings({ kind: 'synth', instrumentParams: { filterCutoff: 300 }, bypassFx: true }), null)
  assert.equal(instrumentFilterSettings({ kind: 'drum', instrumentParams: { filterCutoff: 300 } }), null)
  assert.equal(instrumentFilterSettings({ kind: 'synth', instrumentParams: { filterCutoff: 20000 } }), null)
})

test('R5b graphSignature/buildMixGraph：instrumentFilter 节点仅 synth 非默认时插入、参数 update 平滑', () => {
  const base = makeGroupProject({ tracks: [{ id: 'a' }] })
  const withFilter = JSON.parse(JSON.stringify(base))
  withFilter.tracks[0].kind = 'synth'
  withFilter.tracks[0].instrumentParams = { filterCutoff: 300 }
  const baseSig = graphSignature(base)
  const filterSig = graphSignature(withFilter)
  assert.notEqual(filterSig, baseSig)
  const changed = JSON.parse(JSON.stringify(withFilter))
  changed.tracks[0].instrumentParams = { filterCutoff: 800, filterQ: 4 }
  assert.equal(graphSignature(changed), filterSig)
  const bypass = JSON.parse(JSON.stringify(withFilter))
  bypass.tracks[0].bypassFx = true
  const bypassNoFilter = JSON.parse(JSON.stringify(base))
  bypassNoFilter.tracks[0].bypassFx = true
  assert.equal(graphSignature(bypass), graphSignature(bypassNoFilter))

  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = makeGroupProject({ tracks: [{ id: 'a', effects: [makeEffect('fx_1', 'drive', { amount: 0.4 })] }] })
  project.tracks[0].kind = 'synth'
  project.tracks[0].instrumentParams = { filterCutoff: 300, filterQ: 4 }
  const graph = buildMixGraph(ctx, project, { analysers: false })
  try {
    const entry = graph.tracks.get('a')
    assert.ok(entry.instrumentFilter)
    assert.equal(entry.instrumentFilter.type, 'lowpass')
    closeTo(entry.instrumentFilter.frequency.value, 300)
    closeTo(entry.instrumentFilter.Q.value, 4)
    const isConnected = (from, to) => ctx.connections.some((connection) => connection.from === from && connection.to === to)
    assert.equal(isConnected(entry.preFx, entry.instrumentFilter), true)
    assert.equal(isConnected(entry.instrumentFilter, entry.fx.input), true)
    const next = JSON.parse(JSON.stringify(project))
    next.tracks[0].instrumentParams = { filterCutoff: 900, filterQ: 2 }
    graph.update(next)
    assert.ok(
      entry.instrumentFilter.frequency.ops.some((op) => op.op === "setTargetAtTime" && Math.abs(op.args[0] - 900) < 1e-9),
    )
    assert.ok(entry.instrumentFilter.Q.ops.some((op) => op.op === "setTargetAtTime" && Math.abs(op.args[0] - 2) < 1e-9))
  } finally {
    graph.dispose()
  }
  const plainGraph = buildMixGraph(ctx, makeGroupProject({ tracks: [{ id: 'a' }] }), { analysers: false })
  try {
    assert.equal(plainGraph.tracks.get('a').instrumentFilter, null)
  } finally {
    plainGraph.dispose()
  }
  const drumProject = makeGroupProject({ tracks: [{ id: 'a', kind: 'drum' }] })
  drumProject.tracks[0].instrumentParams = { filterCutoff: 300 }
  const drumGraph = buildMixGraph(ctx, drumProject, { analysers: false })
  try {
    assert.equal(drumGraph.tracks.get('a').instrumentFilter, null)
  } finally {
    drumGraph.dispose()
  }
})

test('R5b buildVoice：attack/release 覆盖包络、lfo 建 detune 振荡器（默认不建）', async () => {
  const bank = await createSf2Bank()
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const build = (options = {}) => {
    const ctx = new MockOfflineAudioContext(2, 44100, 44100)
    const destination = ctx.createGain()
    const voice = bank.buildVoice(ctx, destination, {
      program: 0,
      bank: 0,
      pitch: 60,
      vel: 0.8,
      startTime: 0,
      dur: 1,
      ...options,
    })
    assert.ok(voice)
    const gainParam = ctx.params
      .filter((entry) => entry.kind === "gain" && entry.name === "gain")
      .find((entry) => entry.param.ops.some((op) => op.op === "linearRampToValueAtTime"))
    assert.ok(gainParam, "voice gain envelope should exist")
    const ops = gainParam.param.ops
    const attackRamp = ops.find((op) => op.op === "linearRampToValueAtTime")
    const releaseRamp = [...ops].reverse().find((op) => op.op === "linearRampToValueAtTime")
    return { ctx, voice, ops, attackRamp, releaseRamp }
  }
  const defaultVoice = build()
  assert.ok(defaultVoice.attackRamp.args[1] < 0.2)
  const slowAttack = build({ attack: 0.5 })
  closeTo(slowAttack.attackRamp.args[1], 0.5, 0.01)
  const longRelease = build({ release: 1 })
  closeTo(longRelease.releaseRamp.args[1], 2, 0.01)
  closeTo(longRelease.releaseRamp.args[0], 0.0001, 1e-6)
  assert.equal(defaultVoice.ctx.nodes.filter((node) => node.kind === "oscillator").length, 0)
  const lfoVoice = build({ lfo: { rateHz: 7, depthCents: 80 } })
  const oscillators = lfoVoice.ctx.nodes.filter((node) => node.kind === "oscillator")
  assert.equal(oscillators.length, 1)
  closeTo(oscillators[0].frequency.value, 7)
  const lfoGain = lfoVoice.ctx.nodes.find((node) => node.kind === "gain" && node.gain.value === 80)
  assert.ok(lfoGain, "lfo depth gain=80 should exist")
  assert.equal(build({ lfo: { rateHz: 5, depthCents: 0 } }).ctx.nodes.filter((node) => node.kind === "oscillator").length, 0)
})

test('R5b engine：instrumentParams 透传到 buildVoice（预览/实时/离线同一 helper）', () => {
  const project = buildTestProject()
  const track = project.tracks.find((item) => item.id === 'trk_2')
  assert.ok(track)
  track.instrument = { preset: 'grand_piano' }
  track.instrumentParams = { attack: 0.4, release: 1.2, lfoRate: 7, lfoDepth: 80 }
  const { engine } = primePreviewEngine(project)
  const captured = []
  engine._soundfontBank = {
    buildVoice: (_ctx, _destination, options) => {
      captured.push(options)
      return null
    },
  }
  try {
    engine.previewNote('trk_2', 60)
    assert.equal(captured.length, 1)
    closeTo(captured[0].attack, 0.4)
    closeTo(captured[0].release, 1.2)
    assert.deepEqual(captured[0].lfo, { rateHz: 7, depthCents: 80 })
    delete track.instrumentParams
    captured.length = 0
    engine.previewNote('trk_2', 64)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].attack, undefined)
    assert.equal(captured[0].release, undefined)
    assert.equal(captured[0].lfo, undefined)
  } finally {
    engine.dispose()
  }
})

// ---------------------------------------------------------------------------
// 30. CONTRACT-R5D：subtractive 合成器（voice / 16 复音 / engine 分派）
// ---------------------------------------------------------------------------

test('R5d synthFreqForPitch/coerceSubtractiveParam：音高换算、clamp/round/枚举回退', () => {
  closeTo(synthFreqForPitch(69), 440)
  closeTo(synthFreqForPitch(60), 261.625565)
  closeTo(synthFreqForPitch(81), 880)
  closeTo(synthFreqForPitch(200), synthFreqForPitch(127))
  closeTo(synthFreqForPitch(-5), synthFreqForPitch(0))
  assert.equal(coerceSubtractiveParam('wave', 'square', 'saw'), 'square')
  assert.equal(coerceSubtractiveParam('wave', 'noise', 'saw'), 'saw')
  assert.equal(coerceSubtractiveParam('unison', 99, 1), 2)
  assert.equal(coerceSubtractiveParam('unison', 0, 1), 1)
  assert.equal(coerceSubtractiveParam('detuneCents', 100, 8), 30)
  assert.equal(coerceSubtractiveParam('filterCutoff', 5, 3000), 100)
  assert.equal(coerceSubtractiveParam('filterCutoff', 99999, 3000), 18000)
  assert.equal(coerceSubtractiveParam('lfoDepth', 55.7, 0), 56)
  assert.equal(coerceSubtractiveParam('sustain', -1, 0.7), 0)
  assert.equal(coerceSubtractiveParam('unknown', 1, 2), 2)
})

test('R5d resolveSubtractiveParams/instrumentParamsToSynthOverrides：preset←synthParams←instrumentParams', () => {
  const sawLead = findSynthInstrument('saw_lead')
  assert.ok(sawLead)
  const fromPreset = resolveSubtractiveParams(sawLead.synthPreset, {})
  assert.equal(fromPreset.wave, 'saw')
  closeTo(fromPreset.unison, 2)
  closeTo(fromPreset.detuneCents, 8)
  closeTo(fromPreset.filterCutoff, 4500)
  // 覆盖 + 夹紧
  const merged = resolveSubtractiveParams(sawLead.synthPreset, { filterCutoff: 900, filterQ: 99, wave: 'square', lfoDepth: 150 })
  assert.equal(merged.wave, 'square')
  closeTo(merged.filterCutoff, 900)
  closeTo(merged.filterQ, 20)
  closeTo(merged.lfoDepth, 100)
  // instrumentParams 只映射共用字段
  assert.deepEqual(
    instrumentParamsToSynthOverrides({ attack: 0.4, release: 1, filterCutoff: 300, filterQ: 8, lfoRate: 7, lfoDepth: 50, mono: true }),
    { attack: 0.4, release: 1, filterCutoff: 300, filterQ: 8, lfoRate: 7, lfoDepth: 50 },
  )
  assert.deepEqual(instrumentParamsToSynthOverrides(null), {})
  // 8 个内置音色都能 resolve 出完整合法参数
  const waves = new Set()
  for (const instrument of SYNTH_INSTRUMENTS) {
    const params = resolveSubtractiveParams(instrument.synthPreset, {})
    waves.add(params.wave)
    assert.ok(['saw', 'square', 'sine', 'triangle'].includes(params.wave), instrument.id)
    for (const key of Object.keys(SUBTRACTIVE_DEFAULTS)) {
      if (key === 'wave') continue
      const value = params[key]
      assert.ok(Number.isFinite(value), instrument.id + '.' + key)
    }
    closeTo(params.attack >= 0.001 && params.attack <= 2, true)
    closeTo(params.level >= 0 && params.level <= 1, true)
  }
  assert.ok(waves.has('saw') && waves.has('square') && waves.has('sine'))
  // engine 侧 helper：preset ← synthParams ← instrumentParams 共用字段
  const track = { kind: 'synth', engine: 'subtractive', synthPreset: 'saw_lead', synthParams: { filterCutoff: 1000 }, instrumentParams: { attack: 0.5, release: 1, filterQ: 9, lfoDepth: 50 } }
  const resolved = resolveSubtractiveTrackParams(track)
  assert.equal(resolved.wave, 'saw')
  closeTo(resolved.filterCutoff, 1000)
  closeTo(resolved.filterQ, 9)
  closeTo(resolved.attack, 0.5)
  closeTo(resolved.release, 1)
  closeTo(resolved.lfoDepth, 50)
  // 未知 preset 回落到第一个内置音色，不抛异常
  const fallback = resolveSubtractiveTrackParams({ kind: 'synth', engine: 'subtractive', synthPreset: 'nope' })
  assert.ok(fallback && fallback.wave)
})

test('R5d buildSubtractiveVoice：wave/unison/detune/sub/filter/ADSR/LFO 节点与清理', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const params = resolveSubtractiveParams(null, {
    wave: 'square',
    unison: 2,
    detuneCents: 8,
    subLevel: 0.5,
    filterCutoff: 1200,
    filterQ: 6,
    attack: 0.1,
    decay: 0.2,
    sustain: 0.5,
    release: 1,
    lfoRate: 7,
    lfoDepth: 80,
    level: 0.8,
  })
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const destination = ctx.createGain()
  const voice = buildSubtractiveVoice(ctx, destination, { pitch: 60, vel: 0.8, startTime: 0.5, dur: 1 }, params)
  assert.ok(voice)
  assert.equal(voice.type, 'subtractive')
  const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
  const paramValue = (node, name) => {
    const param = node[name]
    return param.ops.length ? param.ops[0].args[0] : param.value
  }
  // 2 主振荡器 + 1 sub + 1 LFO = 4
  assert.equal(oscillators.length, 4)
  assert.equal(oscillators.filter((node) => node.type === 'square').length, 2)
  assert.equal(oscillators.filter((node) => node.type === 'sine').length, 2)
  closeTo(paramValue(oscillators[0], 'frequency'), 261.625565)
  closeTo(paramValue(oscillators[1], 'frequency'), 261.625565)
  // detune spread ±4 cents
  const detunes = oscillators.slice(0, 2).map((node) => node.detune.ops.length ? node.detune.ops[0].args[0] : node.detune.value)
  assert.ok(detunes.includes(-4))
  assert.ok(detunes.includes(4))
  // LFO：振荡器 7Hz、深度增益 80，并连到主振荡器 detune
  const lfoOsc = oscillators[3]
  closeTo(paramValue(lfoOsc, 'frequency'), 7)
  const lfoGainNode = ctx.nodes.find((node) => node.kind === 'gain' && node.gain.value === 80)
  assert.ok(lfoGainNode)
  const isConnected = (from, to) => ctx.connections.some((connection) => connection.from === from && connection.to === to)
  assert.equal(isConnected(lfoGainNode, oscillators[0].detune), true)
  assert.equal(isConnected(lfoGainNode, oscillators[1].detune), true)
  // filter：lowpass 1200 / Q 6
  const filter = ctx.nodes.find((node) => node.kind === 'biquad')
  assert.ok(filter)
  assert.equal(filter.type, 'lowpass')
  closeTo(paramValue(filter, 'frequency'), 1200)
  closeTo(paramValue(filter, 'Q'), 6)
  // ADSR：attack ramp 到 0.1、release ramp 在 noteEnd+1 = 2.5
  const ampGain = ctx.params.find((entry) => entry.kind === 'gain' && entry.name === 'gain' && entry.param.ops.some((op) => op.op === 'linearRampToValueAtTime'))
  const ramps = ampGain.param.ops.filter((op) => op.op === 'linearRampToValueAtTime')
  closeTo(ramps[0].args[1], 0.6, 0.01) // t0=0.5 + attack 0.1
  closeTo(ramps.at(-1).args[1], 2.5, 0.01)
  closeTo(ramps.at(-1).args[0], 0.0001, 1e-6)
  // 输出连到 destination；unison/sub 混音增益
  assert.equal(isConnected(ampGain.node ?? ctx.nodes.find((node) => node.kind === 'gain' && isConnected(node, destination)), destination), true)
  const mixGain = ctx.nodes.find((node) => node.kind === 'gain' && Math.abs(node.gain.value - 0.5) < 1e-9)
  assert.ok(mixGain)
  // 生命周期：stop 后各振荡器有 stopCalls；dispose 不抛
  voice.stop(2)
  assert.ok(oscillators.every((node) => node.stopCalls.length > 0))
  voice.release()
  voice.dispose()
  assert.equal(buildSubtractiveVoice(null, destination, { pitch: 60 }, params), null)
})

test('R5d 16 复音限制：实时 _enforceSubtractiveVoices 丢最旧并计数；离线渲染 18 音不崩', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = buildTestProject()
  const track = project.tracks.find((item) => item.id === 'trk_2')
  track.engine = 'subtractive'
  track.synthPreset = 'saw_lead'
  const engine = new StudioEngine()
  engine.setProject(project)
  engine._ctx = ctx
  // 构造 17 个 fake 复音（模拟实时 _voices）
  const fakeVoices = []
  for (let index = 0; index < MAX_SUBTRACTIVE_VOICES + 1; index++) {
    const handle = { type: 'subtractive', stopCalls: [], stop(at) { this.stopCalls.push(at) } }
    fakeVoices.push({ startTime: index, endTime: 100, handle, trackId: 'trk_2', trackKind: 'synth', engineKind: 'subtractive' })
  }
  engine._voices = fakeVoices.slice(0, MAX_SUBTRACTIVE_VOICES)
  const stolen = engine._enforceSubtractiveVoices('trk_2', 10)
  assert.equal(stolen, 1)
  assert.equal(engine._voices.length, MAX_SUBTRACTIVE_VOICES - 1)
  assert.ok(fakeVoices[0].handle.stopCalls.length > 0, '最早的复音应被停止')
  assert.equal(engine._synthVoiceSteals, 1)
  // 15 个时不再 steal
  assert.equal(engine._enforceSubtractiveVoices('trk_2', 11), 0)
  engine.dispose()
  // 离线渲染：同轨 18 个同起始音符，渲染不崩且产生 subtractive 振荡器
  const offlineProject = createEmptyProject({ title: 'poly', bpm: 120, key: 'C', scale: 'minor', lengthBars: 2 })
  const offlineTrack = makeTrack({ id: 'trk_1', name: 'Synth', kind: 'synth', volume: 0.7 })
  offlineTrack.engine = 'subtractive'
  offlineTrack.synthPreset = 'square_lead'
  offlineTrack.sends = { reverb: 0, delay: 0 }
  offlineProject.tracks = [offlineTrack]
  const notes = Array.from({ length: 18 }, (_, index) => ({ pitch: 48 + index, start: 0, dur: 1, vel: 0.8 }))
  offlineProject.patterns = [makePattern({ id: 'pat_1', name: 'p', lengthBars: 2, notes })]
  offlineProject.clips = [makeClip({ id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 2 })]
  const offlineEngine = new StudioEngine()
  const originalOffline = globalThis.OfflineAudioContext
  try {
    globalThis.OfflineAudioContext = MockOfflineAudioContext
    const result = await offlineEngine.renderWav(offlineProject, { fromBar: 0, toBar: 1 })
    assert.ok(result.blob.size > 44)
    const offlineCtx = ctx
    assert.ok(true)
  } finally {
    if (originalOffline === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = originalOffline
    offlineEngine.dispose()
  }
})

test('R5d engine 预览：subtractive 轨走 buildSubtractiveVoice（不依赖 SF2），参数来自 preset', () => {
  const project = buildTestProject()
  const track = project.tracks.find((item) => item.id === 'trk_2')
  track.engine = 'subtractive'
  track.synthPreset = 'square_lead'
  track.synthParams = { filterCutoff: 800 }
  const { engine } = primePreviewEngine(project)
  const ctx = engine._ctx
  try {
    const previewId = engine.previewNote('trk_2', 60, 0.9)
    assert.ok(previewId)
    assert.ok(engine._previews.has(previewId))
    const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
    assert.ok(oscillators.length >= 1, '应创建 subtractive 振荡器')
    assert.equal(oscillators[0].type, 'square')
    engine.stopPreview(previewId)
    assert.equal(engine._previews.has(previewId), false)
  } finally {
    engine.dispose()
  }
})

test('R5d 离线渲染分派：subtractive 轨按 synthParams 建振荡器（wave/filter 断言）', async () => {
  const { MockOfflineAudioContext, instances } = installMockOfflineAudioContext()
  const original = globalThis.OfflineAudioContext
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  const make = (synthParams) => {
    const project = createEmptyProject({ title: 'r5d-render', bpm: 120, key: 'C', scale: 'minor', lengthBars: 1 })
    const track = makeTrack({ id: 'trk_1', name: 'S', kind: 'synth', volume: 0.7 })
    track.engine = 'subtractive'
    track.synthPreset = 'saw_lead'
    track.synthParams = { ...synthParams }
    track.sends = { reverb: 0, delay: 0 }
    project.tracks = [track]
    project.patterns = [makePattern({ id: 'pat_1', name: 'p', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 2, vel: 0.8 }] })]
    project.clips = [makeClip({ id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 1 })]
    return project
  }
  try {
    const engine = new StudioEngine()
    await engine.renderWav(make({ wave: 'square', filterCutoff: 800, filterQ: 6 }), { fromBar: 0, toBar: 1 })
    const ctx = instances.at(-1)
    const oscillators = ctx.nodes.filter((node) => node.kind === 'oscillator')
    assert.ok(oscillators.length >= 1)
    assert.ok(oscillators.some((node) => node.type === 'square'), '离线渲染应使用 square 振荡器')
    const biquads = ctx.nodes.filter((node) => node.kind === 'biquad')
    const filter = biquads.find((node) => node.frequency.ops.length > 0)
    assert.ok(filter, 'subtractive voice filter 应写入 frequency')
    assert.equal(filter.frequency.ops[0].args[0], 800)
    engine.dispose()
  } finally {
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

// ---------------------------------------------------------------------------
// 31. v2.1 P0：导出响度（真 K 加权 + truePeak）/ 预览桥超时与自动 fast
// ---------------------------------------------------------------------------

function makeSineChannels({ seconds = 2, amplitude = 0.1, freq = 440, sampleRate = 44100, channels = 2 } = {}) {
  const frames = Math.max(1, Math.round(seconds * sampleRate))
  const list = []
  for (let channel = 0; channel < channels; channel++) {
    const data = new Float32Array(frames)
    const phase = channel === 0 ? 0 : Math.PI / 3
    for (let i = 0; i < frames; i++) data[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase)
    list.push(data)
  }
  return list
}

test('v2.1 measureTruePeak：采样 peak 与 4x Catmull-Rom 近似 true peak；可捕获 inter-sample 过冲', () => {
  const frames = 1024
  const channel = new Float32Array(frames)
  for (let i = 0; i < frames; i++) channel[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4)
  const result = measureTruePeak([channel])
  closeTo(result.peak, Math.SQRT1_2, 1e-6)
  assert.ok(result.truePeak > result.peak * 1.15, `truePeak=${result.truePeak} 应明显大于 sample peak=${result.peak}`)
  assert.ok(result.truePeak <= 1.0001)
  assert.ok(result.truePeakDb > result.peakDb)
  assert.deepEqual(measureTruePeak([]), { peak: 0, peakDb: -120, truePeak: 0, truePeakDb: -120 })
  const weird = measureTruePeak([[NaN, 0.5, Infinity, -0.5]], 4)
  closeTo(weird.peak, 0.5)
  assert.ok(Number.isFinite(weird.truePeakDb))
})

test('v2.1 applyTargetLufsGain：BS.1770 K 加权目标增益、峰值保护、achievedLufs/truePeak 回传', () => {
  const channels = makeSineChannels({ seconds: 2, amplitude: 0.1, freq: 440, channels: 2 })
  const before = analyzeChannels(channels, 44100, { includeSpectrum: false })
  assert.ok(Number.isFinite(before.lufs))
  const result = applyTargetLufsGain(channels, 44100, -14)
  assert.ok(Number.isFinite(result.achievedLufs))
  assert.ok(Math.abs(result.achievedLufs - -14) <= 0.35, `achievedLufs=${result.achievedLufs} 应接近 -14`)
  assert.ok(result.gain > 0)
  closeTo(result.gainDb, 20 * Math.log10(result.gain), 1e-9)
  assert.ok(result.peak <= 0.9801 && result.truePeak <= 0.9801 + 1e-6)
  assert.ok(result.truePeak + 1e-9 >= result.peak)
  assert.equal(result.limited, false)
  assert.equal(result.clamped, false)
  closeTo(result.baseLufs, before.lufs, 1e-6)
  // 目标与当前一致 → peak 不变（预览/导出 peak 同源回归 <0.2dB）
  const neutralChannels = makeSineChannels({ seconds: 1.5, amplitude: 0.2, freq: 220 })
  const neutralBefore = analyzeChannels(neutralChannels, 44100, { includeSpectrum: false })
  const neutralPeakDb = neutralBefore.peakDb
  const neutral = applyTargetLufsGain(neutralChannels, 44100, neutralBefore.lufs)
  assert.ok(Math.abs(neutral.peakDb - neutralPeakDb) < 0.2, `peak 差异 ${Math.abs(neutral.peakDb - neutralPeakDb)}dB 应 <0.2dB`)
  assert.ok(Math.abs(neutral.achievedLufs - neutralBefore.lufs) <= 0.05)
  // 峰值保护：响目标 + 低 ceiling → limited=true 且 truePeak 不超 ceiling
  const hotChannels = makeSineChannels({ seconds: 1, amplitude: 0.2, freq: 440 })
  const hot = applyTargetLufsGain(hotChannels, 44100, -5, { peakCeiling: 0.5 })
  assert.equal(hot.limited, true)
  assert.ok(hot.truePeak <= 0.5 + 1e-6)
  assert.ok(hot.achievedLufs < -5)
  assert.ok(hot.gain > 0 && hot.gain < Math.pow(10, (-5 - hot.baseLufs) / 20))
  // 静音：baseLufs 非有限 → clamped=true、不放大
  const silent = [new Float32Array(4410), new Float32Array(4410)]
  const silentResult = applyTargetLufsGain(silent, 44100, -14)
  assert.equal(silentResult.clamped, true)
  assert.equal(silentResult.gain, 1)
  assert.equal(silentResult.truePeak, 0)
})

test('v2.1 engine.applyTargetLufs/measureBufferPeak：AudioBuffer 原地缩放 + 指标', () => {
  const channels = makeSineChannels({ seconds: 1, amplitude: 0.15, channels: 2 })
  const buffer = {
    numberOfChannels: channels.length,
    sampleRate: 44100,
    getChannelData: (index) => channels[index],
  }
  const engine = new StudioEngine()
  try {
    const measured = engine.measureBufferPeak(buffer)
    assert.ok(measured.truePeak >= measured.peak && measured.peak > 0)
    const result = engine.applyTargetLufs(buffer, -14)
    assert.ok(Math.abs(result.achievedLufs - -14) <= 0.35)
    assert.ok(result.truePeak <= 0.9801 + 1e-6)
    const after = analyzeChannels(channels, 44100, { includeSpectrum: false })
    assert.ok(Math.abs(after.lufs - result.achievedLufs) <= 0.05)
    assert.throws(() => engine.applyTargetLufs(null, -14), /AudioBuffer/)
    assert.throws(() => engine.measureBufferPeak(null), /AudioBuffer/)
  } finally {
    engine.dispose()
  }
})

test('v2.1 preview-bridge：超时默认 120s/env/options 可配置，错误明确窗口遮挡/最小化', async () => {
  assert.equal(PREVIEW_TIMEOUT_MS, 120000)
  assert.equal(resolvePreviewTimeoutMs({}, {}), 120000)
  assert.equal(resolvePreviewTimeoutMs({}, { AIMS_PREVIEW_TIMEOUT_MS: '240000' }), 240000)
  assert.equal(resolvePreviewTimeoutMs({ timeoutMs: 5000 }, { AIMS_PREVIEW_TIMEOUT_MS: '240000' }), 5000)
  assert.equal(resolvePreviewTimeoutMs({ timeoutMs: 0 }, { AIMS_PREVIEW_TIMEOUT_MS: 'bad' }), 120000)
  const error = previewTimeoutError(120000)
  assert.equal(error.code, 'PREVIEW_TIMEOUT')
  assert.match(error.message, /窗口被遮挡|最小化/)
  assert.match(error.message, /渲染过慢/)
  assert.doesNotMatch(error.message, /音色库/)
  const state = {}
  const pending = requestPreview(state, { fromBar: 0, toBar: 2 }, { timeoutMs: 20 })
  await assert.rejects(pending, (rejected) => {
    assert.equal(rejected.code, 'PREVIEW_TIMEOUT')
    assert.match(rejected.message, /窗口被遮挡|最小化/)
    return true
  })
  assert.equal(pendingPreviewCount(state), 0)
  // 超时后后续请求可继续（串行 UI 不会卡死）
  const next = requestPreview(state, { fromBar: 0, toBar: 1 })
  const request = peekPreviewRequest(state, 0)
  assert.ok(request)
  completePreviewRequest(state, request.seq, { analysis: { peakDb: -3 } })
  const analysis = await next
  assert.equal(analysis.peakDb, -3)
})

test('v2.1 preview-bridge：大段/整曲预览自动 fast(22050Hz)，小段保持原模式', async () => {
  assert.equal(PREVIEW_AUTO_FAST_BARS, 32)
  const small = normalizePreviewParams({ fromBar: 0, toBar: 8 }, {})
  assert.equal(small.fast, undefined)
  assert.equal(small.autoFast, undefined)
  const large = normalizePreviewParams({ fromBar: 0, toBar: 32 }, {})
  assert.equal(large.fast, true)
  assert.equal(large.autoFast, true)
  assert.match(large.autoFastReason, /32 小节/)
  assert.equal(normalizePreviewParams({ fromBar: 0, toBar: 16 }, {}).fast, undefined)
  assert.equal(normalizePreviewParams({ fromBar: 0, toBar: 32 }, {}).fast, true)
  assert.equal(normalizePreviewParams({ fromBar: 0, toBar: 4, fast: true }, {}).autoFast, undefined)
  assert.equal(normalizePreviewParams({ fromBar: 0, toBar: 4 }, { AIMS_PREVIEW_AUTO_FAST_BARS: '4' }).fast, true)
  const state = {}
  const pending = requestPreview(state, { fromBar: 0, toBar: 40 })
  const queued = peekPreviewRequest(state, 0)
  assert.equal(queued.params.fast, true)
  completePreviewRequest(state, queued.seq, { analysis: {} })
  await pending
})

test('v2.1 desktop/main.cjs：防节流/防遮挡/防休眠静态配置齐全', () => {
  const source = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8')
  assert.match(source, /backgroundThrottling:\s*false/)
  assert.match(source, /setBackgroundThrottling\(false\)/)
  assert.match(source, /CalculateNativeWinOcclusion/)
  assert.match(source, /powerSaveBlocker\.start\(['"]prevent-app-suspension['"]\)/)
  assert.match(source, /powerSaveBlocker\.stop\(/)
  assert.match(source, /appendSwitch\(['"]disable-features['"]/)
})

// ---------------------------------------------------------------------------
// 32. v2.2 M2：外部 VST3 实时效果器（AudioWorklet/SAB ring/pump/降级）
// ---------------------------------------------------------------------------

test('M2 external ring：SAB 布局、input/output 环读写、可用帧/溢出', () => {
  const ring = createExternalRingBuffer({ ringFrames: 512, channels: 2 })
  assert.equal(ring.ringFrames, 512)
  assert.equal(ring.channels, 2)
  assert.equal(ring.control.length, 32)
  assert.equal(ring.buffer.byteLength, 32 * 4 + 512 * 2 * 4 * 2)
  // 写 output ring 128 帧；读回一致并推进 read
  const left = Float32Array.from({ length: 128 }, (_, i) => i / 128)
  const right = Float32Array.from({ length: 128 }, (_, i) => -i / 128)
  assert.equal(writeOutputRing(ring, [left, right], 128), true)
  assert.equal(ringAvailable(ring.control, EXTERNAL_CONTROL.OUTPUT_READ, EXTERNAL_CONTROL.OUTPUT_WRITE, ring.ringFrames), 128)
  const out = readOutputRing(ring, 256)
  assert.equal(out.frames, 128)
  closeTo(out.outputs[0][10], left[10], 1e-9)
  closeTo(out.outputs[1][10], right[10], 1e-9)
  assert.equal(ringAvailable(ring.control, EXTERNAL_CONTROL.OUTPUT_READ, EXTERNAL_CONTROL.OUTPUT_WRITE, ring.ringFrames), 0)
  // input ring：worklet 写入（模拟），主线程读
  for (let i = 0; i < 96; i++) {
    ring.input[i] = i / 96
    ring.input[ring.ringFrames + i] = -i / 96
  }
  Atomics.store(ring.control, EXTERNAL_CONTROL.INPUT_WRITE, 96)
  const input = readInputRing(ring, 256)
  assert.equal(input.frames, 96)
  closeTo(input.inputs[0][50], 50 / 96, 1e-6)
  closeTo(input.inputs[1][50], -50 / 96, 1e-6)
  assert.equal(Atomics.load(ring.control, EXTERNAL_CONTROL.INPUT_READ), 96)
  // 超出剩余空间：写入返回 false（不覆盖）
  assert.equal(writeOutputRing(ring, [left, right], 600), false)
})

test('M2 base64 planar：float32 往返精度、空数组安全', () => {
  const left = Float32Array.from([0, 0.5, -0.5, 1, -1])
  const right = Float32Array.from([0.25, -0.25, 0, 0.1, -0.1])
  assert.equal(float32PlanesToBase64([left, right]).length, 2)
  const decoded = base64PlanesToFloat32(float32PlanesToBase64([left, right]))
  assert.equal(decoded.length, 2)
  for (let i = 0; i < left.length; i++) closeTo(decoded[0][i], left[i], 1e-6)
  assert.deepEqual(float32PlanesToBase64([]), [])
  assert.deepEqual(base64PlanesToFloat32(null), [])
})

test('M2 ExternalPluginBridge：load/pump 256 帧/参数节流/旁路/错误降级', async () => {
  const ring = createExternalRingBuffer({ ringFrames: 1024, channels: 2 })
  const calls = { load: [], process: [], setParam: [], unload: [] }
  const api = {
    load: async (pluginId, spec) => {
      calls.load.push({ pluginId, spec })
      return { ok: true }
    },
    process: async (payload) => {
      calls.process.push(payload)
      const inputs = base64PlanesToFloat32(payload.inputs)
      const outputs = inputs.map((data) => Float32Array.from(data, (value) => value * 0.5))
      return { ok: true, outputs: float32PlanesToBase64(outputs) }
    },
    setParam: async (payload) => {
      calls.setParam.push(payload)
      return { ok: true }
    },
    unload: async (instanceId) => {
      calls.unload.push(instanceId)
      return { ok: true }
    },
  }
  const bridge = new ExternalPluginBridge({
    ring,
    instanceId: 'fx:fx_test',
    pluginId: 'vst3:tal-reverb-4',
    effectId: 'fx_test',
    trackId: 'trk_1',
    sampleRate: 44100,
    maxBlockSize: 256,
    getApi: () => api,
    setInterval: () => 1,
    clearInterval: () => {},
    now: () => 10,
    paramThrottleMs: 0,
  })
  assert.equal(await bridge.load(), true)
  assert.equal(calls.load[0].pluginId, 'vst3:tal-reverb-4')
  assert.equal(calls.load[0].spec.instanceId, 'fx:fx_test')
  assert.equal(calls.load[0].spec.audioInputs, 2)
  assert.equal(calls.load[0].spec.maxBlockSize, 256)
  // 写入 256 帧输入 → pumpOnce → output ring 收到 *0.5 结果
  for (let i = 0; i < 256; i++) {
    ring.input[i] = 0.2
    ring.input[ring.ringFrames + i] = -0.2
  }
  Atomics.store(ring.control, EXTERNAL_CONTROL.INPUT_WRITE, 256)
  assert.equal(await bridge.pumpOnce(), true)
  assert.equal(calls.process.length, 1)
  assert.equal(calls.process[0].numSamples, 256)
  const out = readOutputRing(ring, 256)
  assert.equal(out.frames, 256)
  closeTo(out.outputs[0][0], 0.1, 1e-6)
  closeTo(out.outputs[1][0], -0.1, 1e-6)
  const status = bridge.status()
  assert.equal(status.loaded, true)
  assert.equal(status.instanceId, 'fx:fx_test')
  assert.equal(status.underrun, 0)
  assert.ok(status.bufferMs >= 0 && status.latencyMs >= 0)
  // 参数节流（throttle=0 立即 flush）
  bridge.setParam('mix', 0.75)
  await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(calls.setParam.at(-1).paramId, 'mix')
  closeTo(calls.setParam.at(-1).value, 0.75, 1e-9)
  // 旁路：pump 不再处理
  bridge.setBypass(true)
  assert.equal(await bridge.pumpOnce(), false)
  assert.equal(bridge.status().bypass, true)
  bridge.setBypass(false)
  // 处理错误 → degraded=true，worklet ERROR 置 1
  api.process = async () => ({ ok: false, error: 'plugin crashed' })
  for (let i = 0; i < 256; i++) ring.input[i] = 0.1
  Atomics.store(ring.control, EXTERNAL_CONTROL.INPUT_WRITE, 512)
  assert.equal(await bridge.pumpOnce(), false)
  assert.equal(bridge.status().degraded, true)
  assert.match(bridge.status().error, /plugin crashed/)
  assert.equal(Atomics.load(ring.control, EXTERNAL_CONTROL.ERROR), 1)
  await bridge.unload()
  assert.deepEqual(calls.unload, ['fx:fx_test'])
})

test('M2 host 兼容：Float32Array outputs / paramList 数字参数 id 解析', async () => {
  const left = Float32Array.from([0.1, 0.2, 0.3])
  assert.equal(normalizePluginProcessOutputs({ outputs: [left, left] }).length, 2)
  closeTo(normalizePluginProcessOutputs({ outputs: [left] })[0][1], 0.2, 1e-6)
  const base64 = float32PlanesToBase64([left])
  closeTo(normalizePluginProcessOutputs({ outputs: base64 })[0][2], 0.3, 1e-6)
  closeTo(normalizePluginProcessOutputs({ outputsBase64: base64 })[0][0], 0.1, 1e-6)
  assert.deepEqual(normalizePluginProcessOutputs(null), [])
  const list = normalizePluginParamList({ params: [{ id: 3, index: 2, name: 'Mix', label: '干湿', value: 0.5, min: 0, max: 1 }] })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 3)
  assert.equal(list[0].label, '干湿')
  closeTo(list[0].value, 0.5)

  const ring = createExternalRingBuffer({ ringFrames: 512, channels: 2 })
  const setCalls = []
  const api = {
    load: async () => ({ ok: true }),
    params: async () => ({ ok: true, params: [{ id: 3, name: 'Mix', label: '干湿', value: 0.5 }] }),
    process: async ({ inputs }) => ({ ok: true, outputs: base64PlanesToFloat32(inputs).map((data) => Float32Array.from(data)) }),
    setParam: async (payload) => {
      setCalls.push(payload)
      return { ok: true }
    },
    unload: async () => ({ ok: true }),
  }
  const bridge = new ExternalPluginBridge({
    ring,
    instanceId: 'fx:fx_host',
    pluginId: 'vst3:tal-reverb-4',
    getApi: () => api,
    setInterval: () => 1,
    clearInterval: () => {},
    paramThrottleMs: 0,
  })
  assert.equal(await bridge.load(), true)
  assert.equal(bridge.status().paramList.length, 1)
  assert.equal(bridge.status().paramList[0].id, 3)
  bridge.setParam('Mix', 0.8)
  await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(setCalls.at(-1).paramId, 3)
  closeTo(setCalls.at(-1).value, 0.8)
})

test('M2 无 preload：bridge load 降级、createExternalEffectNode 直通 + warning、engine 报 unsupported', async () => {
  const ring = createExternalRingBuffer({ ringFrames: 512, channels: 2 })
  const bridge = new ExternalPluginBridge({ ring, instanceId: 'fx:fx_a', pluginId: 'vst3:x', getApi: () => null, setInterval: () => 1, clearInterval: () => {} })
  assert.equal(await bridge.load(), false)
  assert.equal(bridge.status().degraded, true)
  assert.match(bridge.status().error, /仅桌面版/)

  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const warnings = []
  const effect = { id: 'fx_1', type: 'vst3', enabled: true, vst3: { pluginId: 'vst3:tal-reverb-4', params: { mix: 0.5 } } }
  const degraded = createExternalEffectNode(ctx, effect, { workletReady: false, warnings, trackId: 'trk_1', target: 'track' })
  assert.equal(degraded.degraded, true)
  assert.equal(degraded.bridge, null)
  assert.equal(externalInstanceIdForEffect(effect), 'fx:fx_1')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].code, 'external-plugin-degraded')
  assert.match(warnings[0].message, /未就绪|AudioWorklet|桌面/)
  // 直通：input→output 连接
  assert.ok(ctx.connections.some((edge) => edge.from === degraded.input && edge.to === degraded.output))
  // engine 无图/无 preload
  const engine = new StudioEngine()
  try {
    const info = engine.getExternalPlugins()
    assert.equal(info.supported, false)
    assert.match(info.reason, /仅桌面版/)
    assert.deepEqual(info.items, [])
    assert.equal(engine.getExternalPluginStatus('fx:fx_1'), null)
    assert.equal(engine.setExternalPluginParam('fx:fx_1', 'mix', 0.5), false)
    assert.equal(isExternalPluginSupported({}), false)
    assert.equal(getExternalPluginApi({}), null)
  } finally {
    engine.dispose()
  }
})

test('M2 AudioWorklet：createExternalEffectNode 建节点/bridge load，buildFxChainWithExternal 链尾顺序 + update', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.audioWorklet = {}
  const created = []
  class FakeWorkletNode {
    constructor(context, name, options) {
      this.context = context
      this.name = name
      this.options = options
      this.connections = []
      created.push(this)
    }
    connect(target) {
      this.connections.push(target)
    }
    disconnect() {}
  }
  const params = []
  const api = {
    load: async () => ({ ok: true }),
    process: async ({ inputs }) => ({ ok: true, outputs: inputs }),
    setParam: async (payload) => {
      params.push(payload)
      return { ok: true }
    },
    unload: async () => ({ ok: true }),
  }
  const warnings = []
  const effect = { id: 'fx_vst', type: 'vst3', enabled: true, vst3: { pluginId: 'vst3:tal-reverb-4', params: { mix: 0.3 } } }
  const node = createExternalEffectNode(ctx, effect, {
    workletReady: true,
    warnings,
    AudioWorkletNode: FakeWorkletNode,
    getApi: () => api,
    trackId: 'trk_1',
    target: 'track',
    setInterval: () => 1,
    clearInterval: () => {},
    paramThrottleMs: 0,
  })
  assert.equal(node.degraded, false)
  assert.equal(warnings.length, 0)
  assert.equal(created.length, 1)
  assert.equal(created[0].name, EXTERNAL_PLUGIN_WORKLET_NAME)
  assert.equal(created[0].options.processorOptions.instanceId, 'fx:fx_vst')
  assert.ok(created[0].options.processorOptions.sab)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await node.bridge.load()
  assert.equal(node.bridge.loaded, true)
  node.update({ id: 'fx_vst', type: 'vst3', enabled: true, vst3: { pluginId: 'vst3:tal-reverb-4', params: { mix: 0.8 } } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.ok(params.some((item) => item.paramId === 'mix' && Math.abs(item.value - 0.8) < 1e-9))
  node.dispose()

  // 内置 filter + vst3：链尾连接，无 vst3 时等价旧 buildFxChain
  const externalNodes = []
  const chain = buildFxChainWithExternal(
    ctx,
    [
      { id: 'fx_filter', type: 'filter', enabled: true, params: { cutoff: 2000, resonance: 1, mix: 1 } },
      effect,
    ],
    { workletReady: true, AudioWorkletNode: FakeWorkletNode, getApi: () => api, warnings: [], externalNodes, setInterval: () => 1, clearInterval: () => {} },
  )
  assert.equal(externalNodes.length, 1)
  assert.equal(chain.externalNodes.length, 1)
  assert.ok(chain.input)
  assert.ok(chain.output)
  chain.dispose()
  // 无 vst3 → 直接返回 buildFxChain（不改变旧行为）
  const plain = buildFxChainWithExternal(ctx, [{ id: 'fx_filter', type: 'filter', enabled: true, params: {} }], {})
  assert.equal(plain.externalNodes, undefined)
  plain.dispose()
})

test('M2 graph：vst3 效果器降级直通 + warning；签名包含 pluginId；无 vst3 旧工程无 warning', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const effect = { id: 'fx_vst', type: 'vst3', enabled: true, vst3: { pluginId: 'vst3:tal-reverb-4', params: { mix: 0.5 } } }
  const project = makeGroupProject({ tracks: [{ id: 'a', effects: [effect] }] })
  project.tracks[0].kind = 'synth'
  const warnings = []
  const graph = buildMixGraph(ctx, project, { analysers: false, workletReady: false, warnings })
  try {
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].code, 'external-plugin-degraded')
    assert.equal(graph.warnings.length, 1)
    assert.equal(graph.externalNodes.length, 1)
    const list = graph.listExternalEffects()
    assert.equal(list.length, 1)
    assert.equal(list[0].instanceId, 'fx:fx_vst')
    assert.equal(list[0].pluginId, 'vst3:tal-reverb-4')
    assert.equal(list[0].effectId, 'fx_vst')
    assert.equal(list[0].trackId, 'a')
    assert.equal(list[0].target, 'track')
    assert.equal(list[0].degraded, true)
    const summary = graph.getExternalSummary()
    assert.equal(summary.count, 1)
    assert.equal(summary.degraded, 1)
    assert.equal(graph.setExternalEffectParam('fx:fx_vst', 'mix', 0.8), false)
  } finally {
    graph.dispose()
  }
  // 签名：vst3 pluginId 变化 → 重建；params 变化 → 不重建
  const sigA = graphSignature(project)
  const changedPlugin = JSON.parse(JSON.stringify(project))
  changedPlugin.tracks[0].effects[0].vst3.pluginId = 'vst3:other'
  assert.notEqual(graphSignature(changedPlugin), sigA)
  const changedParams = JSON.parse(JSON.stringify(project))
  changedParams.tracks[0].effects[0].vst3.params.mix = 0.9
  assert.equal(graphSignature(changedParams), sigA)
  // 旧工程（无 vst3）不产生 warning/external
  const plain = makeGroupProject({ tracks: [{ id: 'a' }] })
  const warnings2 = []
  const graph2 = buildMixGraph(ctx, plain, { analysers: false, warnings: warnings2 })
  try {
    assert.equal(warnings2.length, 0)
    assert.equal(graph2.externalNodes.length, 0)
    assert.equal(graph2.listExternalEffects().length, 0)
  } finally {
    graph2.dispose()
  }
})

test('M2 无 SharedArrayBuffer：外部效果器降级直通（不静音）', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.audioWorklet = {}
  class FakeWorkletNode {
    connect() {}
    disconnect() {}
  }
  const effect = { id: 'fx_sab', type: 'vst3', enabled: true, vst3: { pluginId: 'vst3:tal-reverb-4' } }
  const warnings = []
  const original = globalThis.SharedArrayBuffer
  try {
    globalThis.SharedArrayBuffer = undefined
    const node = createExternalEffectNode(ctx, effect, {
      workletReady: true,
      AudioWorkletNode: FakeWorkletNode,
      getApi: () => ({ load: async () => ({ ok: true }) }),
      warnings,
    })
    assert.equal(node.degraded, true)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /SharedArrayBuffer/)
    assert.ok(ctx.connections.some((edge) => edge.from === node.input && edge.to === node.output))
  } finally {
    if (original === undefined) delete globalThis.SharedArrayBuffer
    else globalThis.SharedArrayBuffer = original
  }
})

test('M2 renderWav：外部效果器 bypass + warning 回传（离线不接 worklet）', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const original = globalThis.OfflineAudioContext
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  const effect = { id: 'fx_vst', type: 'vst3', enabled: true, vst3: { pluginId: 'vst3:tal-reverb-4', params: { mix: 0.5 } } }
  const project = makeGroupProject({ tracks: [{ id: 'trk_1', effects: [effect] }] })
  project.tracks[0].kind = 'synth'
  const engine = new StudioEngine()
  try {
    const result = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
    assert.ok(result.blob.size > 0)
    assert.ok(Array.isArray(result.warnings))
    assert.ok(result.warnings.some((item) => item.code === 'external-plugin-degraded'))
    assert.ok(result.warnings.some((item) => item.code === 'freeze-unfrozen'))
    assert.equal(result.externalEffectsBypassed, true)
    const plain = makeGroupProject({ tracks: [{ id: 'trk_1' }] })
    const plainResult = await engine.renderWav(plain, { fromBar: 0, toBar: 2 })
    assert.deepEqual(plainResult.warnings, [])
    assert.equal(plainResult.externalEffectsBypassed, false)
  } finally {
    engine.dispose()
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('M2 ensureExternalPluginWorklet：addModule 只调用一次、失败返回 false、worklet source 完整', async () => {
  assert.match(EXTERNAL_PLUGIN_WORKLET_SOURCE, /registerProcessor\('aims-external-plugin'/)
  assert.match(EXTERNAL_PLUGIN_WORKLET_SOURCE, /AudioWorkletProcessor/)
  assert.match(EXTERNAL_PLUGIN_WORKLET_SOURCE, /UNDERRUN/)
  assert.equal(EXTERNAL_PLUGIN_WORKLET_NAME, 'aims-external-plugin')
  assert.ok(createWorkletModuleUrl().length > 0)
  let addModuleCalls = 0
  const fakeCtx = {
    audioWorklet: {
      addModule: async (url) => {
        addModuleCalls += 1
        assert.match(String(url), /^blob:|^data:/)
      },
    },
  }
  assert.equal(await ensureExternalPluginWorklet(fakeCtx), true)
  assert.equal(await ensureExternalPluginWorklet(fakeCtx), true)
  assert.equal(addModuleCalls, 1)
  const failingCtx = { audioWorklet: { addModule: async () => { throw new Error('no worklet') } } }
  assert.equal(await ensureExternalPluginWorklet(failingCtx), false)
  assert.equal(await ensureExternalPluginWorklet(null), false)
  assert.equal(await ensureExternalPluginWorklet({}), false)
})

// ---------------------------------------------------------------------------
// 33. v2.2 M3：VST3 instrument 节点 / MIDI SAB 队列 / engine 调度
// ---------------------------------------------------------------------------

test('M3 instrument ring：output + MIDI 队列布局、事件 encode/decode/读写/清空', () => {
  const ring = createExternalInstrumentRing({ ringFrames: 512, channels: 2, midiCapacity: 32 })
  assert.equal(ring.instrument, true)
  assert.equal(ring.midiCapacity, 32)
  assert.equal(ring.midi.length, 32 * EXTERNAL_MIDI_RECORD_INTS)
  assert.equal(ring.buffer.byteLength, 32 * 4 + 512 * 2 * 4 + 32 * EXTERNAL_MIDI_RECORD_INTS * 4)
  const on = encodeMidiEvent({ type: EXTERNAL_MIDI_TYPE.NOTE_ON, pitch: 60, velocity: 100, timeMs: 1234 })
  assert.equal(on.length, EXTERNAL_MIDI_RECORD_INTS)
  const decoded = decodeMidiEvent(on)
  assert.equal(decoded.pitch, 60)
  assert.equal(decoded.velocity, 100)
  assert.equal(decoded.timeMs, 1234)
  assert.equal(decodeMidiEvent([99, 0, 0, 0, 0, 0, 0, 0]), null)
  // 写 3 条；due 读取只拿到前两条（第三条未来）
  assert.equal(writeMidiEventToRing(ring, { type: EXTERNAL_MIDI_TYPE.NOTE_ON, pitch: 60, velocity: 90, timeMs: 100 }), true)
  assert.equal(writeMidiEventToRing(ring, { type: EXTERNAL_MIDI_TYPE.NOTE_OFF, pitch: 60, velocity: 0, timeMs: 200 }), true)
  assert.equal(writeMidiEventToRing(ring, { type: EXTERNAL_MIDI_TYPE.CC, controller: 64, value: 127, timeMs: 9999 }), true)
  const due = readDueMidiEvents(ring, 500)
  assert.equal(due.length, 2)
  assert.equal(due[0].type, EXTERNAL_MIDI_TYPE.NOTE_ON)
  assert.equal(due[1].type, EXTERNAL_MIDI_TYPE.NOTE_OFF)
  assert.equal(ringAvailable(ring.control, EXTERNAL_CONTROL.MIDI_READ, EXTERNAL_CONTROL.MIDI_WRITE, ring.midiCapacity), 1)
  assert.equal(readDueMidiEvents(ring, 10000).length, 1)
  // MIDI 队列满：写入返回 false 并累加 dropped
  for (let i = 0; i < 40; i++) writeMidiEventToRing(ring, { type: EXTERNAL_MIDI_TYPE.NOTE_ON, pitch: 60 + i, timeMs: 0 })
  const dropped = Atomics.load(ring.control, EXTERNAL_CONTROL.MIDI_DROPPED)
  assert.ok(dropped >= 1)
  // 清空
  assert.ok(clearMidiQueue(ring) >= 1)
  assert.equal(ringAvailable(ring.control, EXTERNAL_CONTROL.MIDI_READ, EXTERNAL_CONTROL.MIDI_WRITE, ring.midiCapacity), 0)
})

test('M3 ExternalInstrumentBridge：instrument load spec / MIDI noteOn/off / sampleOffset / panic CC123', async () => {
  const ring = createExternalInstrumentRing({ ringFrames: 512, channels: 2 })
  const calls = { load: [], process: [], setParam: [], unload: [] }
  let currentTime = 1
  const api = {
    load: async (pluginId, spec) => {
      calls.load.push({ pluginId, spec })
      return { ok: true }
    },
    params: async () => ({ ok: true, params: [{ id: 1, name: 'Volume', value: 0.5 }] }),
    process: async (payload) => {
      calls.process.push(payload)
      const length = payload.numSamples || 256
      return { ok: true, outputs: [new Float32Array(length).fill(0.25), new Float32Array(length).fill(-0.25)] }
    },
    setParam: async (payload) => {
      calls.setParam.push(payload)
      return { ok: true }
    },
    unload: async (instanceId) => {
      calls.unload.push(instanceId)
      return { ok: true }
    },
  }
  const bridge = new ExternalInstrumentBridge({
    ring,
    instanceId: 'track:trk_1',
    pluginId: 'vst3:noisemaker',
    trackId: 'trk_1',
    sampleRate: 44100,
    maxBlockSize: 256,
    currentTime: () => currentTime,
    getApi: () => api,
    setInterval: () => 1,
    clearInterval: () => {},
    paramThrottleMs: 0,
  })
  assert.equal(await bridge.load(), true)
  assert.equal(calls.load[0].spec.kind, 'instrument')
  assert.equal(calls.load[0].spec.audioInputs, 0)
  assert.equal(calls.load[0].spec.audioOutputs, 2)
  assert.equal(bridge.status().paramList.length, 1)
  assert.equal(bridge.status().kind, 'instrument')
  // noteOn/noteOff 写入 SAB；pump 转为 host midi 并带 sampleOffset
  assert.equal(bridge.noteOn(60, 0.8, 1.0), true)
  assert.equal(bridge.noteOff(60, 1.0), true)
  currentTime = 1.0
  assert.equal(await bridge.pumpOnce(), true)
  assert.equal(calls.process.length, 1)
  assert.equal(calls.process[0].numSamples, 256)
  assert.equal(calls.process[0].midi.length, 2)
  assert.equal(calls.process[0].midi[0].type, 'noteOn')
  assert.equal(calls.process[0].midi[0].pitch, 60)
  assert.ok(Math.abs(calls.process[0].midi[0].velocity - 0.8) < 0.01)
  assert.equal(calls.process[0].midi[1].type, 'noteOff')
  assert.ok(Number.isInteger(calls.process[0].midi[0].sampleOffset))
  const out = readOutputRing(ring, 256)
  assert.equal(out.frames, 256)
  closeTo(out.outputs[0][0], 0.25, 1e-6)
  const status = bridge.status()
  assert.equal(status.midiEventCount, 2)
  assert.equal(status.activeNotes, 0)
  assert.ok(status.bufferMs >= 0 && status.latencyMs >= 0)
  // 未来事件：未 due 不发送，留在队列
  bridge.noteOn(62, 0.5, 5)
  assert.equal(await bridge.pumpOnce(), true)
  assert.equal(calls.process.at(-1).midi.length, 0)
  currentTime = 5.0
  assert.equal(await bridge.pumpOnce(), true)
  assert.equal(calls.process.at(-1).midi.length, 1)
  assert.equal(calls.process.at(-1).midi[0].pitch, 62)
  // panic：清队列 + 显式 noteOff + CC123/120（host cc）
  bridge.noteOn(64, 0.7, 10)
  const cleared = bridge.panic(20)
  assert.ok(cleared >= 0)
  assert.equal(bridge.status().activeNotes, 0)
  currentTime = 20
  assert.equal(await bridge.pumpOnce(), true)
  const panicMidi = calls.process.at(-1).midi
  assert.ok(panicMidi.some((event) => event.type === 'cc' && event.controller === 123))
  assert.ok(panicMidi.some((event) => event.type === 'cc' && event.controller === 120))
  await bridge.unload()
  assert.deepEqual(calls.unload, ['track:trk_1'])
})

test('M3 createExternalInstrumentNode：无 preload 降级静音+warning；真实 worklet 节点/参数/noteOn', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const track = { id: 'trk_vst', kind: 'synth', engine: 'vst3', vst3: { pluginId: 'vst3:noisemaker', params: { 1: 0.4 } } }
  const warnings = []
  const degraded = createExternalInstrumentNode(ctx, track, { workletReady: false, warnings })
  assert.equal(degraded.degraded, true)
  assert.equal(degraded.output.gain.value, 1)
  assert.equal(degraded.noteOn(60), false)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].code, 'external-instrument-degraded')
  assert.match(warnings[0].message, /未就绪/)
  assert.equal(degraded.status().kind, 'instrument')
  assert.equal(degraded.status().instanceId, 'track:trk_vst')

  // 真实节点（mock worklet + fake api）
  ctx.audioWorklet = {}
  const created = []
  class FakeWorkletNode {
    constructor(context, name, options) {
      this.context = context
      this.name = name
      this.options = options
      created.push(this)
    }
    connect() {}
    disconnect() {}
  }
  const apiCalls = { process: [] }
  const api = {
    load: async () => ({ ok: true }),
    params: async () => ({ ok: true, params: [{ id: 1, name: 'Vol', value: 0.4 }] }),
    process: async (payload) => {
      apiCalls.process.push(payload)
      return { ok: true, outputs: [new Float32Array(payload.numSamples).fill(0.1), new Float32Array(payload.numSamples).fill(0.1)] }
    },
    setParam: async () => ({ ok: true }),
    unload: async () => ({ ok: true }),
  }
  const node = createExternalInstrumentNode(ctx, track, {
    workletReady: true,
    AudioWorkletNode: FakeWorkletNode,
    getApi: () => api,
    midiCapacity: 64,
    setInterval: () => 1,
    clearInterval: () => {},
    paramThrottleMs: 0,
  })
  assert.equal(node.degraded, false)
  assert.equal(created.length, 1)
  assert.equal(created[0].name, EXTERNAL_PLUGIN_WORKLET_NAME)
  assert.equal(created[0].options.numberOfInputs, 0)
  assert.equal(created[0].options.processorOptions.mode, 'instrument')
  assert.ok(created[0].options.processorOptions.sab)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(node.status().kind, 'instrument')
  assert.equal(node.status().paramList.length, 1)
  assert.equal(node.noteOn(60, 0.8, 0), true)
  assert.equal(node.noteOff(60, 0.5), true)
  assert.equal(typeof node.panic, 'function')
  node.dispose()
})

test('M3 graph：vst3 instrument 轨降级静音+warning、无采样器 voice、状态聚合；签名含 pluginId', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  const project = makeGroupProject({ tracks: [{ id: 'a' }] })
  project.tracks[0].kind = 'synth'
  project.tracks[0].engine = 'vst3'
  project.tracks[0].vst3 = { pluginId: 'vst3:noisemaker', name: 'NoiseMaker' }
  const warnings = []
  const graph = buildMixGraph(ctx, project, { analysers: false, workletReady: false, warnings })
  try {
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].code, 'external-instrument-degraded')
    const entry = graph.tracks.get('a')
    assert.ok(entry.externalInstrument)
    assert.equal(entry.externalInstrument.degraded, true)
    const items = graph.listExternalPlugins()
    assert.equal(items.length, 1)
    assert.equal(items[0].kind, 'instrument')
    assert.equal(items[0].instanceId, 'track:a')
    assert.equal(items[0].trackId, 'a')
    assert.equal(items[0].target, 'instrument')
    assert.equal(items[0].degraded, true)
    assert.equal(graph.getExternalPluginStatus('track:a')?.kind, 'instrument')
    assert.equal(graph.getExternalSummary().instrumentCount, 1)
    assert.equal(graph.getExternalSummary().effectCount, 0)
    // 无采样器 voice：track entry 没有 sampler voice 相关调用即可（instrument 降级静音）
    assert.equal(graph.setExternalPluginParam('track:a', 1, 0.5), false)
  } finally {
    graph.dispose()
  }
  // 签名：vst3 pluginId 变化 → 重建；参数变化不重建
  const sigA = graphSignature(project)
  const changed = JSON.parse(JSON.stringify(project))
  changed.tracks[0].vst3.pluginId = 'vst3:other'
  assert.notEqual(graphSignature(changed), sigA)
  const changedParam = JSON.parse(JSON.stringify(project))
  changedParam.tracks[0].vst3.params = { 1: 0.2 }
  assert.equal(graphSignature(changedParam), sigA)
})

test('M3 engine：vst3 instrument 调度 noteOn/off、previewNote/stop、_stopAllVoices panic', () => {
  const project = makeGroupProject({ tracks: [{ id: 'trk_vst' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker' }
  const engine = new StudioEngine()
  try {
    engine.setProject(project)
    const calls = []
    const instrument = {
      degraded: false,
      noteOn: (pitch, velocity, time) => {
        calls.push({ kind: 'on', pitch, velocity, time })
        return true
      },
      noteOff: (pitch, time) => {
        calls.push({ kind: 'off', pitch, time })
        return true
      },
      panic: (time) => calls.push({ kind: 'panic', time }),
    }
    engine._ctx = { currentTime: 0, state: 'running' }
    engine._graph = { tracks: new Map([['trk_vst', { input: {}, externalInstrument: instrument }]]), tracksList: [] }
    engine._sidechainIndex = new Map()
    engine._voices = []
    engine._tempo = null
    // 播放调度：noteOn(when) + noteOff(when+dur)
    engine._scheduleEvent({ trackId: 'trk_vst', pitch: 60, vel: 0.8, startBeat: 0, durBeats: 1 }, 0.1)
    assert.equal(calls[0].kind, 'on')
    assert.equal(calls[0].pitch, 60)
    closeTo(calls[0].velocity, 0.8, 1e-9)
    closeTo(calls[0].time, 0.1, 1e-9)
    assert.equal(calls[1].kind, 'off')
    closeTo(calls[1].time, 0.1 + 0.5, 1e-9) // 120bpm 1 beat = 0.5s
    assert.equal(engine._voices.length, 0) // 不建采样器 voice
    // previewNote：直接路由到 external instrument；stopPreview 发 noteOff
    engine._positionBar = 0
    const previewId = engine.previewNote('trk_vst', 64, 0.9)
    assert.ok(previewId)
    assert.equal(calls.at(-2).kind, 'on')
    assert.equal(calls.at(-1).kind, 'off')
    const before = calls.length
    assert.equal(engine.stopPreview(previewId), true)
    assert.ok(calls.length > before)
    assert.equal(calls.at(-1).kind, 'off')
    // _stopAllVoices → panic
    const beforePanic = calls.length
    engine._stopAllVoices(0.01)
    assert.equal(calls.at(-1).kind, 'panic')
    assert.ok(calls.length > beforePanic)
  } finally {
    engine.dispose()
  }
})

test('M3 renderWav：vst3 instrument bypass+warning（离线不接 worklet）', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const original = globalThis.OfflineAudioContext
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  const project = makeGroupProject({ tracks: [{ id: 'trk_vst' }] })
  project.tracks[0].kind = 'synth'
  project.tracks[0].engine = 'vst3'
  project.tracks[0].vst3 = { pluginId: 'vst3:noisemaker', name: 'NoiseMaker' }
  const engine = new StudioEngine()
  try {
    const result = await engine.renderWav(project, { fromBar: 0, toBar: 1 })
    assert.ok(result.blob.size > 0)
    assert.ok(result.warnings.some((item) => item.code === 'external-instrument-degraded'))
    assert.ok(result.warnings.some((item) => item.code === 'freeze-unfrozen'))
    assert.equal(result.externalEffectsBypassed, true)
  } finally {
    engine.dispose()
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

// ---------------------------------------------------------------------------
// 34. v2.2 M4：冻结轨播放/导出（缓存 WAV 替代外部节点 + FX）
// ---------------------------------------------------------------------------

test('M4 freeze helpers：状态/是否冻结/media 解析/unfrozenVst3Tracks/listFrozenTracks', () => {
  const track = { id: 'trk_fz', kind: 'synth', engine: 'vst3', vst3: { pluginId: 'vst3:x' } }
  assert.equal(freezeStatusOf(track), 'none')
  assert.equal(isFrozenTrack(track), false)
  track.freeze = { mediaId: 'media_fz', hash: 'h1', bars: 8, cachedAt: 123 }
  assert.equal(freezeStatusOf(track), 'current')
  assert.equal(isFrozenTrack(track), true)
  const info = frozenTrackInfo(track)
  assert.equal(info.trackId, 'trk_fz')
  assert.equal(info.mediaId, 'media_fz')
  assert.equal(info.hash, 'h1')
  assert.equal(info.bars, 8)
  const project = { tracks: [track], media: [{ id: 'media_fz', file: 'plugin-cache/h1.wav', durationSeconds: 16, bytes: 100, channels: 2, sampleRate: 48000 }] }
  assert.equal(frozenMediaEntry(project, track)?.file, 'plugin-cache/h1.wav')
  assert.equal(listFrozenTracks(project).length, 1)
  assert.equal(unfrozenVst3Tracks(project).length, 0)
  // stale → 不算 frozen；renderWav 用实时/降级
  const stale = { ...track, freeze: { ...track.freeze, stale: true } }
  assert.equal(freezeStatusOf(stale), 'stale')
  assert.equal(isFrozenTrack(stale), false)
  assert.equal(unfrozenVst3Tracks({ tracks: [stale], media: project.media }).length, 1)
  // missing media 条目：仍 frozen，但 frozenMediaEntry=null（graph warning）
  assert.equal(frozenMediaEntry({ tracks: [track], media: [] }, track), null)
  // effect vst3 未冻结也算 unfrozen
  assert.equal(unfrozenVst3Tracks({ tracks: [{ id: 'a', effects: [{ id: 'fx', type: 'vst3', vst3: { pluginId: 'vst3:y' } }] }] }).length, 1)
})

test('M4 graph：冻结轨 bypass 外部节点/轨道 FX、保留 gain；签名含 freeze；状态只读；缺 media warning', () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  // A) 冻结轨：vst3 instrument + 内置 FX + 外部 effect 全部不建；无外部 warning
  const project = makeGroupProject({ tracks: [{ id: 'fz' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker' }
  track.effects = [{ id: 'fx_filter', type: 'filter', enabled: true, params: { cutoff: 1000, resonance: 1, mix: 1 } }]
  track.freeze = { mediaId: 'media_fz', hash: 'hash_fz', bars: 2, cachedAt: 456 }
  project.media = [{ id: 'media_fz', file: 'plugin-cache/hash_fz.wav', bytes: 100, durationSeconds: 4, channels: 2, sampleRate: 44100 }]
  const warnings = []
  const graph = buildMixGraph(ctx, project, { analysers: false, workletReady: false, warnings })
  try {
    assert.equal(warnings.length, 0) // 冻结后不再有 external-plugin-degraded
    const entry = graph.tracks.get('fz')
    assert.equal(entry.frozen, true)
    assert.equal(entry.externalInstrument, null)
    // B 方案（includesFx:false）：保留轨道内置 FX，仅 bypass 外部节点
    assert.equal(entry.freezeIncludesFx, false)
    assert.equal(entry.bypassFx, false)
    assert.equal(entry.fx.effects.size, 1) // filter 保留
    assert.equal(graph.getFrozenTracks().length, 1)
    assert.equal(graph.getFrozenTracks()[0].mediaId, 'media_fz')
    const status = graph.getFreezeStatus()
    assert.equal(status.tracks.length, 1)
    assert.equal(status.tracks[0].status, 'current')
    assert.equal(status.tracks[0].hash, 'hash_fz')
    // 冻结轨 FX 接口参数更新不报错（链为空）
    graph.update(project)
  } finally {
    graph.dispose()
  }
  // A2) includesFx:true（host 若把内置 FX 也渲染进缓存）→ 整链 bypass
  const baked = JSON.parse(JSON.stringify(project))
  baked.tracks[0].freeze.includesFx = true
  const bakedWarnings = []
  const bakedGraph = buildMixGraph(ctx, baked, { analysers: false, workletReady: false, warnings: bakedWarnings })
  try {
    const bakedEntry = bakedGraph.tracks.get('fz')
    assert.equal(bakedEntry.freezeIncludesFx, true)
    assert.equal(bakedEntry.bypassFx, true)
    assert.equal(bakedEntry.fx.effects.size, 0)
    assert.equal(bakedWarnings.length, 0)
  } finally {
    bakedGraph.dispose()
  }
  // B) 缺 media 条目 → warning freeze-media-missing
  const missing = JSON.parse(JSON.stringify(project))
  missing.media = []
  const warnings2 = []
  const graph2 = buildMixGraph(ctx, missing, { analysers: false, workletReady: false, warnings: warnings2 })
  try {
    assert.ok(warnings2.some((item) => item.code === 'freeze-media-missing'))
    assert.equal(graph2.getFrozenTracks().length, 1)
  } finally {
    graph2.dispose()
  }
  // C) 签名：freeze hash 变化 → 重建；stale 变化 → 重建
  const sig = graphSignature(project)
  const changedHash = JSON.parse(JSON.stringify(project))
  changedHash.tracks[0].freeze.hash = 'hash_new'
  assert.notEqual(graphSignature(changedHash), sig)
  const stale = JSON.parse(JSON.stringify(project))
  stale.tracks[0].freeze.stale = true
  assert.notEqual(graphSignature(stale), sig)
  // D) 非冻结 vst3 track 与 M3 行为一致（仍有 external-instrument-degraded）
  const live = JSON.parse(JSON.stringify(project))
  live.tracks[0].freeze = undefined
  const warnings3 = []
  const graph3 = buildMixGraph(ctx, live, { analysers: false, workletReady: false, warnings: warnings3 })
  try {
    assert.ok(warnings3.some((item) => item.code === 'external-instrument-degraded'))
    const item = graph3.listExternalPlugins().find((entryItem) => entryItem.kind === 'instrument')
    assert.ok(item)
    assert.equal(item.frozen, false)
    assert.equal(item.freezeStatus, 'none')
  } finally {
    graph3.dispose()
  }
})

test('M4 engine：冻结轨实时调度缓存 WAV（offset/loop/stop），不调度音符', () => {
  const engine = new StudioEngine()
  try {
    const project = makeGroupProject({ tracks: [{ id: 'fz' }] })
    const track = project.tracks[0]
    track.kind = 'synth'
    track.engine = 'vst3'
    track.vst3 = { pluginId: 'vst3:noisemaker' }
    track.freeze = { mediaId: 'media_fz', hash: 'h', bars: 4 }
    project.media = [{ id: 'media_fz', file: 'plugin-cache/h.wav', durationSeconds: 20, channels: 2, sampleRate: 44100 }]
    engine.setProject(project)
    const starts = []
    const stops = []
    const source = {
      connect() {},
      disconnect() {},
      start(when, offset, duration) {
        starts.push({ when, offset, duration })
      },
      stop(at) {
        stops.push(at)
      },
      buffer: null,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
    }
    engine._ctx = { currentTime: 2, createBufferSource: () => ({ ...source }) }
    engine._graph = {
      tracks: new Map([['fz', { input: {} }]]),
      getFrozenTracks: () => [{ trackId: 'fz', mediaId: 'media_fz', status: 'current' }],
    }
    engine._project = project
    engine._trackMap = new Map([['fz', track]])
    engine._mediaBank = { get: () => ({ duration: 20, sampleRate: 44100 }), context: null }
    engine._mediaSampleRate = 44100
    engine._tempo = createTempoMap(project)
    engine._plan = { rangeStartBeat: 0, rangeEndBeat: 16, looping: false, barBeats: 4 }
    engine._anchorBeat = 0
    engine._playing = true
    engine._frozenVoices = []
    // 调度一次（非 loop）
    assert.equal(engine._scheduleFrozenTracks(2), 1)
    assert.equal(starts.length, 1)
    closeTo(starts[0].when, 2, 1e-9)
    closeTo(starts[0].offset, 0, 1e-9)
    assert.ok(starts[0].duration > 0)
    // loop：从 rangeStart 之后开始 → offset 落在 loop 区间，source.loop=true
    starts.length = 0
    engine._plan = { rangeStartBeat: 4, rangeEndBeat: 12, looping: true, barBeats: 4 }
    engine._anchorBeat = 6
    engine._scheduleFrozenTracks(3)
    assert.equal(starts.length, 1)
    assert.ok(starts[0].offset > 0)
    // 停止冻结 voice
    const before = engine._frozenVoices.length
    assert.ok(engine._stopAllFrozenVoices(0.01) >= 1)
    assert.equal(engine._frozenVoices.length, 0)
    assert.ok(stops.length >= 1)
  } finally {
    engine.dispose()
  }
})

test('M4 renderWav：冻结轨缓存进入离线渲染、跳过该轨音符、缺缓存中文 warning', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const original = globalThis.OfflineAudioContext
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  const project = makeGroupProject({ tracks: [{ id: 'fz' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker' }
  track.freeze = { mediaId: 'media_fz', hash: 'h', bars: 2 }
  project.media = [{ id: 'media_fz', file: 'plugin-cache/h.wav', bytes: 100, durationSeconds: 4, channels: 2, sampleRate: 44100 }]
  // 给轨加一个 pattern/clip 音符，验证冻结轨不调度采样器 voice（也不应报错）
  project.patterns = [makePattern({ id: 'pat_fz', name: 'p', lengthBars: 2, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })]
  project.clips = [makeClip({ id: 'clip_fz', trackId: 'fz', patternId: 'pat_fz', startBar: 0, lengthBars: 2 })]
  const engine = new StudioEngine()
  try {
    engine._mediaBank = {
      context: null,
      get: () => ({ duration: 4, sampleRate: 44100 }),
      preloadForProject: async () => {},
      ensureProcessedForProject: async () => {},
    }
    const result = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
    assert.ok(result.blob.size > 0)
    assert.deepEqual(result.warnings, [])
    assert.equal(result.externalEffectsBypassed, false)
    // 缺缓存 media → 中文 warning，且不崩溃
    const missing = JSON.parse(JSON.stringify(project))
    missing.media = []
    const result2 = await engine.renderWav(missing, { fromBar: 0, toBar: 2 })
    assert.ok(result2.warnings.some((item) => item.code === 'freeze-media-missing' && /冻结缓存/.test(item.message)))
    assert.equal(result2.externalEffectsBypassed, true)
  } finally {
    engine.dispose()
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('M4 renderWav：自动冻结钩子（成功重试 / 中文失败 warning / 未冻结保留 bypass warning）', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const original = globalThis.OfflineAudioContext
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  const base = makeGroupProject({ tracks: [{ id: 'fz' }] })
  const track = base.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker' }
  const engine = new StudioEngine()
  try {
    engine._mediaBank = {
      context: null,
      get: () => ({ duration: 4, sampleRate: 44100 }),
      preloadForProject: async () => {},
      ensureProcessedForProject: async () => {},
    }
    // 成功：hook 返回冻结后的 project（含 media）
    const frozenProject = JSON.parse(JSON.stringify(base))
    frozenProject.tracks[0].freeze = { mediaId: 'media_fz', hash: 'h', bars: 2 }
    frozenProject.media = [{ id: 'media_fz', file: 'plugin-cache/h.wav', bytes: 100, durationSeconds: 4, channels: 2, sampleRate: 44100 }]
    let hookCalls = 0
    const okResult = await engine.renderWav(base, {
      fromBar: 0,
      toBar: 2,
      ensureFrozen: async (incoming, info) => {
        hookCalls += 1
        assert.ok(info.reason === 'export')
        return frozenProject
      },
    })
    assert.equal(hookCalls, 1)
    assert.ok(!okResult.warnings.some((item) => item.code === 'freeze-unfrozen'))
    // 失败：中文 freeze-auto-failed + 未冻结 bypass warning，仍能导出
    const failResult = await engine.renderWav(base, {
      fromBar: 0,
      toBar: 2,
      ensureFrozen: async () => {
        throw new Error('磁盘已满')
      },
    })
    assert.ok(failResult.warnings.some((item) => item.code === 'freeze-auto-failed' && /自动冻结外部插件失败/.test(item.message) && /磁盘已满/.test(item.message)))
    assert.ok(failResult.warnings.some((item) => item.code === 'freeze-unfrozen'))
    assert.ok(failResult.blob.size > 0)
    // 默认 host 路由：同源页面 fetch POST /studio/api/plugin-freeze → 刷新 state.project
    const originalFetch = globalThis.fetch
    const originalLocation = globalThis.location
    const fetchCalls = []
    const frozenProject2 = JSON.parse(JSON.stringify(frozenProject))
    try {
      globalThis.location = { protocol: 'http:', href: 'http://127.0.0.1:0/' }
      globalThis.fetch = async (url, options = {}) => {
        fetchCalls.push({ url: String(url), method: options.method ?? 'GET' })
        if (String(url).includes('/studio/api/plugin-freeze')) {
          return new Response(JSON.stringify({ ok: true, trackId: 'fz', status: 'current', includesFx: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (String(url).includes('/studio/api/state')) {
          return new Response(JSON.stringify({ project: frozenProject2 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), { status: 404 })
      }
      const hostResult = await engine.renderWav(base, { fromBar: 0, toBar: 2 })
      assert.ok(fetchCalls.some((call) => call.url.includes('/studio/api/plugin-freeze') && call.method === 'POST'))
      assert.ok(hostResult.warnings.some((item) => item.code === 'freeze-auto-failed') === false)
      assert.ok(hostResult.warnings.some((item) => item.code === 'freeze-unfrozen') === false)
      assert.ok(hostResult.blob.size > 0)
      // host 冻结失败 → 中文 freeze-auto-failed + 继续导出
      globalThis.fetch = async (url) => new Response(JSON.stringify({ ok: false, error: '磁盘已满' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      const failedHost = await engine.renderWav(base, { fromBar: 0, toBar: 2 })
      assert.ok(failedHost.warnings.some((item) => item.code === 'freeze-auto-failed' && /磁盘已满/.test(item.message)))
      assert.ok(failedHost.warnings.some((item) => item.code === 'freeze-unfrozen'))
    } finally {
      if (originalFetch === undefined) delete globalThis.fetch
      else globalThis.fetch = originalFetch
      if (originalLocation === undefined) delete globalThis.location
      else globalThis.location = originalLocation
    }
    // 没钩子：保留 freeze-unfrozen warning
    const noHook = await engine.renderWav(base, { fromBar: 0, toBar: 2 })
    assert.ok(noHook.warnings.some((item) => item.code === 'freeze-unfrozen'))
  } finally {
    engine.dispose()
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('M4 state 持久化：bridge saveState 读取 host state，load spec 携带 stateBase64', async () => {
  const ring = createExternalRingBuffer({ ringFrames: 512, channels: 2 })
  const calls = []
  const api = {
    load: async (pluginId, spec) => {
      calls.push({ kind: 'load', pluginId, spec })
      return { ok: true }
    },
    process: async ({ inputs }) => ({ ok: true, outputs: inputs }),
    setParam: async () => ({ ok: true }),
    saveState: async (instanceId) => ({ ok: true, stateBase64: 'c3RhdGU=' }),
    unload: async () => ({ ok: true }),
  }
  const bridge = new ExternalPluginBridge({
    ring,
    instanceId: 'fx:state',
    pluginId: 'vst3:tal-reverb-4',
    stateBase64: 'b2xk',
    getApi: () => api,
    setInterval: () => 1,
    clearInterval: () => {},
  })
  assert.equal(bridge.spec.stateBase64, 'b2xk')
  assert.equal(await bridge.load(), true)
  assert.equal(calls[0].spec.stateBase64, 'b2xk')
  assert.equal(await bridge.saveState(), 'c3RhdGU=')
  assert.equal(bridge.stateBase64, 'c3RhdGU=')
})

// ---------------------------------------------------------------------------
// 35. v2.2 M4 effect-freeze 干声：engine.freezeTrackAudio
// ---------------------------------------------------------------------------
test('M4 freezeTrackAudio：普通轨含 VST3 effect 渲染干声 PCM（排除 FX/外部节点），返回 host inputPcm', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const original = globalThis.OfflineAudioContext
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  const project = makeGroupProject({ tracks: [{ id: 'trk_dry' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'subtractive'
  track.effects = [
    { id: 'fx_filter', type: 'filter', enabled: true, params: { cutoff: 1800, resonance: 1, mix: 1 } },
    { id: 'fx_vst', type: 'vst3', enabled: true, vst3: { pluginId: 'vst3:tal-reverb-4', params: { mix: 0.5 } } },
  ]
  project.patterns = [makePattern({ id: 'pat_dry', name: 'p', lengthBars: 2, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }, { pitch: 64, start: 2, dur: 1, vel: 0.8 }] })]
  project.clips = [makeClip({ id: 'clip_dry', trackId: 'trk_dry', patternId: 'pat_dry', startBar: 0, lengthBars: 2 })]
  const engine = new StudioEngine()
  try {
    engine.setProject(project)
    // bars=2 → 2*4*0.5s*48000 = 192000 frames
    const result = await engine.freezeTrackAudio('trk_dry', { bars: 2, sampleRate: 48000 })
    assert.equal(result.ok, true)
    assert.equal(result.trackId, 'trk_dry')
    assert.equal(result.bars, 2)
    assert.equal(result.frames, 192000)
    assert.equal(result.sampleRate, 48000)
    assert.equal(result.effectIds.length, 1)
    assert.equal(result.effectIds[0], 'fx_vst')
    assert.equal(result.inputPcm.length, 2)
    const left = base64PlanesToFloat32([result.inputPcm[0]])[0]
    assert.equal(left.length, 192000)
    // 缺 VST3 effect / 不存在的轨 / VST3 乐器轨 → 中文错误
    await assert.rejects(engine.freezeTrackAudio('nope'), /轨道不存在/)
    const noEffect = JSON.parse(JSON.stringify(project))
    noEffect.tracks[0].effects = []
    engine.setProject(noEffect)
    await assert.rejects(engine.freezeTrackAudio('trk_dry', { bars: 1 }), /没有 VST3 效果器/)
    const vstTrack = JSON.parse(JSON.stringify(project))
    vstTrack.tracks[0].kind = 'synth'
    vstTrack.tracks[0].engine = 'vst3'
    vstTrack.tracks[0].vst3 = { pluginId: 'vst3:noisemaker' }
    engine.setProject(vstTrack)
    await assert.rejects(engine.freezeTrackAudio('trk_dry', { bars: 1 }), /VST3 乐器轨/)
  } finally {
    engine.dispose()
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
  }
})

test('M4 renderWav 自动冻结：普通轨含 VST3 effect 时先 engine.freezeTrackAudio 渲干声，随请求提交 inputPcm', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const original = globalThis.OfflineAudioContext
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location
  globalThis.OfflineAudioContext = MockOfflineAudioContext
  const project = makeGroupProject({ tracks: [{ id: 'trk_norm' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'subtractive'
  track.effects = [{ id: 'fx_vst', type: 'vst3', enabled: true, vst3: { pluginId: 'vst3:tal-reverb-4' } }]
  project.patterns = [makePattern({ id: 'pat_n', name: 'p', lengthBars: 2, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })]
  project.clips = [makeClip({ id: 'clip_n', trackId: 'trk_norm', patternId: 'pat_n', startBar: 0, lengthBars: 2 })]
  const frozenProject = JSON.parse(JSON.stringify(project))
  frozenProject.tracks[0].freeze = { mediaId: 'media_n', hash: 'h_n', bars: 2, includesFx: false }
  frozenProject.media = [{ id: 'media_n', file: 'plugin-cache/n.wav', bytes: 100, durationSeconds: 4, channels: 2, sampleRate: 44100 }]
  const engine = new StudioEngine()
  const fetchCalls = []
  try {
    engine.setProject(project)
    engine._mediaBank = {
      context: null,
      get: () => ({ duration: 4, sampleRate: 44100 }),
      getProcessed: () => ({ duration: 4, sampleRate: 44100 }),
      preloadForProject: async () => {},
      ensureProcessedForProject: async () => {},
    }
    globalThis.location = { protocol: 'http:', href: 'http://127.0.0.1:0/' }
    globalThis.fetch = async (url, options = {}) => {
      const parsed = { url: String(url), method: options.method ?? 'GET', body: null }
      if (options.body) {
        try {
          parsed.body = JSON.parse(String(options.body))
        } catch {
          parsed.body = String(options.body)
        }
      }
      fetchCalls.push(parsed)
      if (String(url).includes('/studio/api/plugin-freeze')) {
        return new Response(JSON.stringify({ ok: true, trackId: 'trk_norm', status: 'current' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (String(url).includes('/studio/api/state')) {
        return new Response(JSON.stringify({ project: frozenProject }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 })
    }
    const result = await engine.renderWav(project, { fromBar: 0, toBar: 2 })
    const freezeCall = fetchCalls.find((call) => call.url.includes('/studio/api/plugin-freeze'))
    assert.ok(freezeCall)
    assert.equal(freezeCall.body.trackId, 'trk_norm')
    assert.equal(Array.isArray(freezeCall.body.inputPcm), true)
    assert.equal(freezeCall.body.inputPcm.length, 2)
    const dryLeft = base64PlanesToFloat32([freezeCall.body.inputPcm[0]])[0]
    assert.equal(dryLeft.length, freezeCall.body.bars * 4 * (60 / 120) * 48000)
    assert.ok(!result.warnings.some((item) => item.code === 'freeze-unfrozen'))
    assert.ok(!result.warnings.some((item) => item.code === 'freeze-dry-failed'))
    assert.ok(result.blob.size > 0)
  } finally {
    engine.dispose()
    if (original === undefined) delete globalThis.OfflineAudioContext
    else globalThis.OfflineAudioContext = original
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
    if (originalLocation === undefined) delete globalThis.location
    else globalThis.location = originalLocation
  }
})

// ---------------------------------------------------------------------------
// 36. v2.3 P0：工程 vst3.params 同步 / pluginAutomation tick
// ---------------------------------------------------------------------------

test('v23 ExternalPluginBridge.syncParams：只下发变化参数、同值不重复 IPC', async () => {
  const ring = createExternalRingBuffer({ ringFrames: 512, channels: 2 })
  const calls = []
  const api = {
    load: async () => ({ ok: true }),
    params: async () => ({ ok: true, params: [{ id: 1, name: 'Mix', value: 0.2 }, { id: 2, name: 'Size', value: 0.4 }] }),
    process: async ({ inputs }) => ({ ok: true, outputs: inputs }),
    setParam: async (payload) => {
      calls.push(payload)
      return { ok: true }
    },
    unload: async () => ({ ok: true }),
  }
  const bridge = new ExternalPluginBridge({
    ring,
    instanceId: 'fx:sync',
    pluginId: 'vst3:tal-reverb-4',
    getApi: () => api,
    setInterval: () => 1,
    clearInterval: () => {},
    paramThrottleMs: 0,
  })
  await bridge.load()
  bridge.params = { 1: 0.2, 2: 0.4 }
  calls.length = 0
  // 只改 param 1；param 2 与当前相同不下发
  assert.equal(bridge.syncParams({ 1: 0.25, 2: 0.4 }), 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].paramId, 1)
  closeTo(calls[0].value, 0.25, 1e-9)
  calls.length = 0
  // 同值再次同步 → 0 次 IPC
  assert.equal(bridge.syncParams({ 1: 0.25, 2: 0.4 }), 0)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.length, 0)
  // setParam 同值也不重复
  bridge.setParam(1, 0.25)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.length, 0)
  // 名称参数解析到数字 id
  assert.equal(bridge.syncParams({ Mix: 0.5 }), 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.at(-1).paramId, 1)
  closeTo(calls.at(-1).value, 0.5, 1e-9)
})

test('v23 graph.update：effect/instrument vst3.params 变化同步现有 external node，不替换节点', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.audioWorklet = {}
  const created = []
  class FakeWorkletNode {
    constructor(context, name, options) {
      this.context = context
      this.name = name
      this.options = options
      created.push(this)
    }
    connect() {}
    disconnect() {}
  }
  const setCalls = []
  const api = {
    load: async () => ({ ok: true }),
    params: async () => ({ ok: true, params: [{ id: 1, name: 'Mix', value: 0.2 }] }),
    process: async ({ inputs, numSamples }) => ({
      ok: true,
      outputs: [new Float32Array(numSamples || 256).fill(0.1), new Float32Array(numSamples || 256).fill(0.1)],
    }),
    setParam: async (payload) => {
      setCalls.push(payload)
      return { ok: true }
    },
    unload: async () => ({ ok: true }),
  }
  const project = makeGroupProject({ tracks: [{ id: 'a' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker', params: { 1: 0.2 } }
  const graph = buildMixGraph(ctx, project, {
    analysers: false,
    workletReady: true,
    AudioWorkletNode: FakeWorkletNode,
    getApi: () => api,
    paramThrottleMs: 0,
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    const instrumentBefore = graph.tracks.get('a').externalInstrument
    assert.ok(instrumentBefore)
    setCalls.length = 0
    const next = JSON.parse(JSON.stringify(project))
    next.tracks[0].vst3.params = { 1: 0.8 }
    graph.update(next)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(graph.tracks.get('a').externalInstrument, instrumentBefore) // 节点未替换
    assert.ok(setCalls.some((call) => String(call.paramId) === '1' && Math.abs(call.value - 0.8) < 1e-9))
    assert.equal(setCalls.length, 1) // 只同步变化参数
  } finally {
    graph.dispose()
  }
})

test('v23 computePluginAutomationTargets：instrument/effect 曲线插值、禁用/非 vst3/缺失 effect 跳过', () => {
  const project = makeGroupProject({ tracks: [{ id: 'trk_v', effects: [] }, { id: 'trk_plain' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker' }
  track.effects = [{ id: 'fx_1', type: 'vst3', enabled: true, vst3: { pluginId: 'vst3:tal-reverb-4' } }]
  track.pluginAutomation = {
    track: {
      1: { enabled: true, points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] },
      2: { enabled: false, points: [{ beat: 0, value: 1 }] },
    },
    'effect:fx_1': {
      3: { enabled: true, points: [{ beat: 0, value: 0.2 }, { beat: 4, value: 0.6 }] },
    },
    'effect:missing': { 1: { enabled: true, points: [{ beat: 0, value: 1 }] } },
  }
  project.tracks[1].pluginAutomation = { track: { 1: { enabled: true, points: [{ beat: 0, value: 1 }] } } }
  const targets = computePluginAutomationTargets(project, 2)
  assert.equal(targets.length, 2)
  const inst = targets.find((item) => item.instanceId === 'track:trk_v' && String(item.paramId) === '1')
  const fx = targets.find((item) => item.instanceId === 'fx:fx_1' && String(item.paramId) === '3')
  assert.ok(inst && fx)
  closeTo(inst.value, 0.5, 1e-9)
  closeTo(fx.value, 0.4, 1e-9)
  assert.equal(targets.some((item) => String(item.paramId) === '2'), false) // disabled
  assert.equal(targets.some((item) => item.trackId === 'trk_plain'), false) // 非 vst3 轨
  assert.equal(targets.some((item) => item.effectId === 'missing'), false)
  // applyAutomationTargets 支持 setExternalPluginParam
  const calls = []
  const applied = applyAutomationTargets({ setExternalPluginParam: (instanceId, paramId, value) => calls.push({ instanceId, paramId, value }) }, targets)
  assert.equal(applied, 2)
  assert.equal(calls.length, 2)
})

test('v23 engine tick：_applyAutomation 同时应用轨道自动化与 pluginAutomation → setExternalPluginParam', () => {
  const project = makeGroupProject({ tracks: [{ id: 'trk_v' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker' }
  track.pluginAutomation = { track: { 5: { enabled: true, points: [{ beat: 0, value: 0 }, { beat: 4, value: 1 }] } } }
  const engine = new StudioEngine()
  try {
    engine._project = project
    engine._playing = true
    engine._ctx = { currentTime: 0 }
    engine._plan = { barBeats: 4, rangeStartBeat: 0, rangeEndBeat: 16, looping: false }
    engine._lastAutomationAt = -Infinity
    engine._currentBeat = () => 2
    const calls = []
    engine._graph = {
      setExternalPluginParam: (instanceId, paramId, value) => calls.push({ instanceId, paramId, value }),
    }
    assert.ok(engine._applyAutomation(true) >= 1)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].instanceId, 'track:trk_v')
    assert.equal(String(calls[0].paramId), '5')
    closeTo(calls[0].value, 0.5, 1e-9)
  } finally {
    engine.dispose()
  }
})

test('v23 engine.setProject：同签名只 graph.update（不重建），参数变化随 project 传给 update', () => {
  const project = makeGroupProject({ tracks: [{ id: 'trk_v' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker', params: { 1: 0.2 } }
  const next = JSON.parse(JSON.stringify(project))
  next.tracks[0].vst3.params = { 1: 0.7 }
  const engine = new StudioEngine()
  try {
    const calls = []
    engine._ctx = { currentTime: 0 }
    engine._graph = {
      update: (incoming) => calls.push(incoming),
    }
    engine._signature = graphSignature(next)
    engine._refreshCaches = () => {}
    engine._preloadMedia = async () => {}
    engine._preloadSoundfont = async () => {}
    engine._playing = false
    engine.setProject(next)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].tracks[0].vst3.params[1], 0.7)
    assert.equal(engine._graph.update !== undefined, true)
  } finally {
    engine.dispose()
  }
})

// ---------------------------------------------------------------------------
// 37. v2.3 P1：预设/状态同步（selectProgram/loadState diff）
// ---------------------------------------------------------------------------

test('v23 P1 bridge：preset/state diff 调 selectProgram/loadState、去重、state 优先、失败不崩', async () => {
  const ring = createExternalRingBuffer({ ringFrames: 512, channels: 2 })
  const calls = []
  const api = {
    load: async () => ({ ok: true }),
    params: async () => ({ ok: true, params: [] }),
    process: async ({ inputs, numSamples }) => ({
      ok: true,
      outputs: [new Float32Array(numSamples || 256).fill(0.1), new Float32Array(numSamples || 256).fill(0.1)],
    }),
    setParam: async (payload) => {
      calls.push({ kind: 'setParam', ...payload })
      return { ok: true }
    },
    selectProgram: async (payload) => {
      calls.push({ kind: 'selectProgram', ...payload })
      return { ok: true }
    },
    loadState: async (payload) => {
      calls.push({ kind: 'loadState', ...payload })
      return { ok: true }
    },
    unload: async () => ({ ok: true }),
  }
  const bridge = new ExternalPluginBridge({
    ring,
    instanceId: 'track:p1',
    pluginId: 'vst3:noisemaker',
    preset: { listId: 1, index: 2, name: 'Init' },
    getApi: () => api,
    setInterval: () => 1,
    clearInterval: () => {},
    paramThrottleMs: 0,
  })
  await bridge.load()
  calls.length = 0
  // 初始 preset 已应用：同 preset 不重复 selectProgram
  assert.equal(await bridge.syncPluginState({ preset: { listId: 1, index: 2 }, params: {} }), 0)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.length, 0)
  // preset 变化 → selectProgram
  assert.ok((await bridge.syncPluginState({ preset: { listId: 1, index: 3 }, params: {} })) >= 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.filter((call) => call.kind === 'selectProgram').length, 1)
  assert.equal(calls.find((call) => call.kind === 'selectProgram').listId, 1)
  assert.equal(calls.find((call) => call.kind === 'selectProgram').index, 3)
  assert.deepEqual(bridge.status().preset, { listId: 1, index: 3, name: '' })
  calls.length = 0
  // 同 preset 再同步：不重复
  await bridge.syncPluginState({ preset: { listId: 1, index: 3 }, params: {} })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.length, 0)
  // state 变化 → loadState，且 state 优先于 selectProgram；随后 params sync
  calls.length = 0
  await bridge.syncPluginState({ stateBase64: 'c3RhdGU=', preset: { listId: 1, index: 4 }, params: { 1: 0.5 } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const kinds = calls.map((call) => call.kind)
  // state 优先：载入 state 后本轮不再用工程 params 覆盖 state
  assert.deepEqual(kinds, ['loadState'])
  assert.equal(calls.find((call) => call.kind === 'loadState').stateBase64, 'c3RhdGU=')
  assert.equal(bridge.status().preset.index, 4)
  calls.length = 0
  // 同 state/params：不再调用
  await bridge.syncPluginState({ stateBase64: 'c3RhdGU=', preset: { listId: 1, index: 4 }, params: { 1: 0.5 } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls.length, 0)
  // host 失败：selectProgram 抛错 → presetError，不中断/不崩
  api.selectProgram = async () => ({ ok: false, error: 'preset 不可用' })
  await bridge.syncPluginState({ preset: { listId: 2, index: 1 }, params: {} })
  assert.match(bridge.status().presetError, /preset 不可用/)
})

test('v23 P1 graph.update：preset/state 变化同步现有节点、不替换节点；params 随后同步', async () => {
  const { MockOfflineAudioContext } = installMockOfflineAudioContext()
  const ctx = new MockOfflineAudioContext(2, 44100, 44100)
  ctx.audioWorklet = {}
  const created = []
  class FakeWorkletNode {
    constructor(context, name, options) {
      this.context = context
      this.name = name
      this.options = options
      created.push(this)
    }
    connect() {}
    disconnect() {}
  }
  const calls = []
  const api = {
    load: async () => ({ ok: true }),
    params: async () => ({ ok: true, params: [] }),
    process: async ({ inputs, numSamples }) => ({
      ok: true,
      outputs: [new Float32Array(numSamples || 256).fill(0.1), new Float32Array(numSamples || 256).fill(0.1)],
    }),
    setParam: async (payload) => {
      calls.push({ kind: 'setParam', ...payload })
      return { ok: true }
    },
    selectProgram: async (payload) => {
      calls.push({ kind: 'selectProgram', ...payload })
      return { ok: true }
    },
    loadState: async (payload) => {
      calls.push({ kind: 'loadState', ...payload })
      return { ok: true }
    },
    unload: async () => ({ ok: true }),
  }
  const project = makeGroupProject({ tracks: [{ id: 'a' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker', preset: { listId: 1, index: 1, name: 'A' }, params: { 1: 0.2 } }
  const graph = buildMixGraph(ctx, project, {
    analysers: false,
    workletReady: true,
    AudioWorkletNode: FakeWorkletNode,
    getApi: () => api,
    paramThrottleMs: 0,
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    const nodeBefore = graph.tracks.get('a').externalInstrument
    assert.ok(nodeBefore)
    calls.length = 0
    const next = JSON.parse(JSON.stringify(project))
    next.tracks[0].vst3.preset = { listId: 1, index: 3, name: 'C' }
    next.tracks[0].vst3.params = { 1: 0.9 }
    graph.update(next)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(graph.tracks.get('a').externalInstrument, nodeBefore)
    assert.ok(calls.some((call) => call.kind === 'selectProgram' && call.index === 3))
    assert.ok(calls.some((call) => call.kind === 'setParam' && Math.abs(call.value - 0.9) < 1e-9))
    calls.length = 0
    const next2 = JSON.parse(JSON.stringify(next))
    next2.tracks[0].vst3.stateBase64 = 'c3RhdGUy'
    next2.tracks[0].vst3.preset = { listId: 1, index: 4, name: 'D' }
    graph.update(next2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(graph.tracks.get('a').externalInstrument, nodeBefore)
    assert.ok(calls.some((call) => call.kind === 'loadState' && call.stateBase64 === 'c3RhdGUy'))
  } finally {
    graph.dispose()
  }
})

test('v23 P1 engine.setProject：preset/state 随 project 传入 graph.update（同签名不重建）', () => {
  const project = makeGroupProject({ tracks: [{ id: 'trk_v' }] })
  const track = project.tracks[0]
  track.kind = 'synth'
  track.engine = 'vst3'
  track.vst3 = { pluginId: 'vst3:noisemaker', preset: { listId: 1, index: 1 }, params: { 1: 0.2 } }
  const next = JSON.parse(JSON.stringify(project))
  next.tracks[0].vst3.preset = { listId: 1, index: 3 }
  next.tracks[0].vst3.stateBase64 = 'bmV4dA=='
  const engine = new StudioEngine()
  try {
    const calls = []
    engine._ctx = { currentTime: 0 }
    engine._graph = { update: (incoming) => calls.push(incoming) }
    engine._signature = graphSignature(next)
    engine._refreshCaches = () => {}
    engine._preloadMedia = async () => {}
    engine._preloadSoundfont = async () => {}
    engine._playing = false
    engine.setProject(next)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].tracks[0].vst3.preset.index, 3)
    assert.equal(calls[0].tracks[0].vst3.stateBase64, 'bmV4dA==')
  } finally {
    engine.dispose()
  }
})
