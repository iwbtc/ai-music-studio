/**
 * v2.2 M2/M3：外部 VST3 实时效果器/乐器桥（AudioWorklet + SharedArrayBuffer ring + main-thread pump）。
 *
 * 数据流：
 *   effect：AudioWorklet 输入 → input ring → 主线程 pump 读 → preload process → output ring → worklet 输出。
 *   instrument：无音频输入；主线程 pump 从 MIDI SAB 队列取事件（note/cc + sampleOffset）→ preload
 *   `process({midi})` → output ring → worklet 输出。
 *
 * 无 preload / 无 AudioWorklet / 无 SAB / worklet 未就绪 → effect 直通 / instrument 静音 + warning（不崩溃）。
 * 模块加载时不做任何 Web Audio 调用；Node 单测可 import 纯函数并用 mock ctx。
 */
import { buildFxChain } from './fx.js'
import {
  EXTERNAL_PLUGIN_WORKLET_NAME,
  EXTERNAL_PLUGIN_WORKLET_SOURCE,
  EXTERNAL_CONTROL,
  EXTERNAL_CONTROL_INTS,
  EXTERNAL_RING_FRAMES,
  EXTERNAL_CHANNELS,
} from './external-plugin-worklet.js'

export {
  EXTERNAL_PLUGIN_WORKLET_NAME,
  EXTERNAL_PLUGIN_WORKLET_SOURCE,
  EXTERNAL_CONTROL,
  EXTERNAL_CONTROL_INTS,
  EXTERNAL_RING_FRAMES,
  EXTERNAL_CHANNELS,
}

/** 默认 pump 间隔（ms）：契约 3–5ms。 */
export const EXTERNAL_PUMP_INTERVAL_MS = 4
/** 默认每块帧数。 */
export const EXTERNAL_BLOCK_FRAMES = 256
/** 参数节流（ms）：UI 拖动 ≤50ms。 */
export const EXTERNAL_PARAM_THROTTLE_MS = 50
/** 每工程最多外部 effect 实例（与 model 上限一致）。 */
export const MAX_EXTERNAL_EFFECTS = 16
/** v2.2 M3：MIDI SAB 队列固定记录 int 数与默认容量。 */
export const EXTERNAL_MIDI_RECORD_INTS = 8
export const EXTERNAL_MIDI_CAPACITY = 256
export const EXTERNAL_MIDI_TYPE = Object.freeze({
  NOTE_ON: 0,
  NOTE_OFF: 1,
  CC: 2,
  PITCH_BEND: 3,
  ALL_NOTES_OFF: 4,
  ALL_SOUND_OFF: 5,
})

const workletModuleCache = new WeakMap()

/** 读取 preload bridge（无 preload 时 undefined）。 */
export function getExternalPluginApi(globalObject = typeof globalThis !== 'undefined' ? globalThis : undefined) {
  const api = globalObject && globalObject.aimsPlugins
  return api && typeof api === 'object' ? api : null
}

/** 当前环境是否有 preload 外部插件桥。 */
export function isExternalPluginSupported(globalObject) {
  return getExternalPluginApi(globalObject) !== null
}

/**
 * 创建 SAB（无 SharedArrayBuffer 时退回 ArrayBuffer；AudioWorklet 需要 SAB 才能跨线程，
 * 退回 ArrayBuffer 仅用于单测/降级路径）。
 */
export function createExternalRingBuffer({ ringFrames = EXTERNAL_RING_FRAMES, channels = EXTERNAL_CHANNELS, sab = null } = {}) {
  const frames = Math.max(256, Math.round(Number(ringFrames) || EXTERNAL_RING_FRAMES))
  const channelCount = Math.max(1, Math.min(2, Math.round(Number(channels) || EXTERNAL_CHANNELS)))
  const bytes = EXTERNAL_CONTROL_INTS * 4 + frames * channelCount * 4 * 2
  let buffer = sab
  if (!buffer) {
    try {
      buffer = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
    } catch {
      buffer = new ArrayBuffer(bytes)
    }
  }
  const control = new Int32Array(buffer, 0, EXTERNAL_CONTROL_INTS)
  const floatOffset = EXTERNAL_CONTROL_INTS * 4
  const inputLength = frames * channelCount
  const input = new Float32Array(buffer, floatOffset, inputLength)
  const output = new Float32Array(buffer, floatOffset + inputLength * 4, inputLength)
  return { buffer, control, input, output, ringFrames: frames, channels: channelCount }
}

/** 环内可用帧数（单调递增计数器取模）。 */
export function ringAvailable(control, startIndex, endIndex, ringFrames) {
  const capacity = Math.max(1, Number(ringFrames) || EXTERNAL_RING_FRAMES)
  const start = Atomics.load(control, startIndex)
  const end = Atomics.load(control, endIndex)
  return ((end - start) % capacity + capacity) % capacity
}

/** 主线程：从 input ring 读取最多 maxFrames 帧，返回 planar Float32Array[]；无数据返回 null。 */
export function readInputRing(ring, maxFrames = EXTERNAL_BLOCK_FRAMES) {
  const available = ringAvailable(ring.control, EXTERNAL_CONTROL.INPUT_READ, EXTERNAL_CONTROL.INPUT_WRITE, ring.ringFrames)
  const frames = Math.min(available, Math.max(1, Math.round(maxFrames)))
  if (frames <= 0) return null
  const planar = []
  const readStart = Atomics.load(ring.control, EXTERNAL_CONTROL.INPUT_READ) % ring.ringFrames
  for (let channel = 0; channel < ring.channels; channel++) {
    const data = new Float32Array(frames)
    const base = channel * ring.ringFrames
    const first = Math.min(frames, ring.ringFrames - readStart)
    data.set(ring.input.subarray(base + readStart, base + readStart + first), 0)
    if (first < frames) data.set(ring.input.subarray(base, base + frames - first), first)
    planar.push(data)
  }
  Atomics.add(ring.control, EXTERNAL_CONTROL.INPUT_READ, frames)
  return { inputs: planar, frames }
}

/** 主线程：把插件输出 planar 帧写入 output ring（空间不足返回 false，不覆盖）。 */
export function writeOutputRing(ring, planar, frames) {
  const count = Math.max(0, Math.round(Number(frames) || 0))
  if (count <= 0) return false
  const free = ring.ringFrames - ringAvailable(ring.control, EXTERNAL_CONTROL.OUTPUT_READ, EXTERNAL_CONTROL.OUTPUT_WRITE, ring.ringFrames)
  if (free < count) return false
  const writeStart = Atomics.load(ring.control, EXTERNAL_CONTROL.OUTPUT_WRITE) % ring.ringFrames
  for (let channel = 0; channel < ring.channels; channel++) {
    const source = planar && planar[channel] ? planar[channel] : planar && planar[0] ? planar[0] : null
    const base = channel * ring.ringFrames
    for (let i = 0; i < count; i++) {
      ring.output[base + writeStart + i] = source && i < source.length ? Number(source[i]) || 0 : 0
    }
  }
  Atomics.add(ring.control, EXTERNAL_CONTROL.OUTPUT_WRITE, count)
  try {
    Atomics.add(ring.control, EXTERNAL_CONTROL.SEQ, 1)
  } catch {
    /* ignore */
  }
  return true
}

/** 主线程读取 output ring（测试/诊断用，不推进 read 指针时传 commit:false）。 */
export function readOutputRing(ring, maxFrames = EXTERNAL_BLOCK_FRAMES, { commit = true } = {}) {
  const available = ringAvailable(ring.control, EXTERNAL_CONTROL.OUTPUT_READ, EXTERNAL_CONTROL.OUTPUT_WRITE, ring.ringFrames)
  const frames = Math.min(available, Math.max(1, Math.round(maxFrames)))
  if (frames <= 0) return null
  const readStart = Atomics.load(ring.control, EXTERNAL_CONTROL.OUTPUT_READ) % ring.ringFrames
  const planar = []
  for (let channel = 0; channel < ring.channels; channel++) {
    const data = new Float32Array(frames)
    const base = channel * ring.ringFrames
    const first = Math.min(frames, ring.ringFrames - readStart)
    data.set(ring.output.subarray(base + readStart, base + readStart + first), 0)
    if (first < frames) data.set(ring.output.subarray(base, base + frames - first), first)
    planar.push(data)
  }
  if (commit) Atomics.add(ring.control, EXTERNAL_CONTROL.OUTPUT_READ, frames)
  return { outputs: planar, frames }
}

/**
 * v2.2 M3：instrument 专用 SAB 布局：
 *   控制区(128B) + output stereo ring + MIDI 固定记录队列（默认 256×8 int32）。
 * 无输入 ring；worklet 以 mode:'instrument' 只读 output ring。
 */
export function createExternalInstrumentRing({
  ringFrames = EXTERNAL_RING_FRAMES,
  channels = EXTERNAL_CHANNELS,
  midiCapacity = EXTERNAL_MIDI_CAPACITY,
  sab = null,
} = {}) {
  const frames = Math.max(256, Math.round(Number(ringFrames) || EXTERNAL_RING_FRAMES))
  const channelCount = Math.max(1, Math.min(2, Math.round(Number(channels) || EXTERNAL_CHANNELS)))
  const capacity = Math.max(16, Math.round(Number(midiCapacity) || EXTERNAL_MIDI_CAPACITY))
  const floatBytes = frames * channelCount * 4
  const midiBytes = capacity * EXTERNAL_MIDI_RECORD_INTS * 4
  const bytes = EXTERNAL_CONTROL_INTS * 4 + floatBytes + midiBytes
  let buffer = sab
  if (!buffer) {
    try {
      buffer = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
    } catch {
      buffer = new ArrayBuffer(bytes)
    }
  }
  const control = new Int32Array(buffer, 0, EXTERNAL_CONTROL_INTS)
  const floatOffset = EXTERNAL_CONTROL_INTS * 4
  const output = new Float32Array(buffer, floatOffset, frames * channelCount)
  const midi = new Int32Array(buffer, floatOffset + floatBytes, capacity * EXTERNAL_MIDI_RECORD_INTS)
  return {
    buffer,
    control,
    output,
    midi,
    ringFrames: frames,
    channels: channelCount,
    midiCapacity: capacity,
    instrument: true,
  }
}

/** 编码一条 MIDI 事件（固定 8 int32；timeMs 为 context 绝对毫秒）。 */
export function encodeMidiEvent(event = {}) {
  const type = Number.isFinite(Number(event.type)) ? Number(event.type) : EXTERNAL_MIDI_TYPE.NOTE_ON
  const pitch = Math.max(0, Math.min(127, Math.round(Number(event.pitch) || 0)))
  const velocity = Math.max(0, Math.min(127, Math.round(Number(event.velocity) || 0)))
  const controller = Math.max(0, Math.min(127, Math.round(Number(event.controller) || 0)))
  const value = Math.max(0, Math.min(127, Math.round(Number(event.value) || 0)))
  const timeMs = Math.max(0, Math.round(Number(event.timeMs) || 0))
  return [type, pitch, velocity, controller, value, timeMs, Math.max(0, Math.round(Number(event.seq) || 0)), 0]
}

/** 解码固定记录；非法类型返回 null。 */
export function decodeMidiEvent(record) {
  if (!record || record.length < EXTERNAL_MIDI_RECORD_INTS) return null
  const type = Number(record[0])
  if (!Number.isFinite(type) || type < 0 || type > 5) return null
  return {
    type,
    pitch: Number(record[1]) || 0,
    velocity: Number(record[2]) || 0,
    controller: Number(record[3]) || 0,
    value: Number(record[4]) || 0,
    timeMs: Number(record[5]) || 0,
    seq: Number(record[6]) || 0,
  }
}

/** 写入一条 MIDI 事件到 SAB 队列；队列满返回 false 并累加 MIDI_DROPPED。 */
export function writeMidiEventToRing(ring, event) {
  if (!ring || !ring.midi || !ring.instrument) return false
  const capacity = ring.midiCapacity
  // MIDI 计数器单调递增；用原始差值判断满/空（不能取模，40 条写入后取模会误判为空）
  const writeCounter = Atomics.load(ring.control, EXTERNAL_CONTROL.MIDI_WRITE)
  const readCounter = Atomics.load(ring.control, EXTERNAL_CONTROL.MIDI_READ)
  const free = capacity - (writeCounter - readCounter)
  if (free <= 0) {
    Atomics.add(ring.control, EXTERNAL_CONTROL.MIDI_DROPPED, 1)
    return false
  }
  const write = writeCounter % capacity
  const record = encodeMidiEvent(event)
  const base = write * EXTERNAL_MIDI_RECORD_INTS
  for (let i = 0; i < EXTERNAL_MIDI_RECORD_INTS; i++) ring.midi[base + i] = record[i]
  Atomics.add(ring.control, EXTERNAL_CONTROL.MIDI_WRITE, 1)
  return true
}

/**
 * 主线程读取 due 的 MIDI 事件（timeMs <= dueTimeMs）；遇到未来事件即停止（保留在队列）。
 * @returns {Array} 事件数组（timeMs 为绝对 context 毫秒）
 */
export function readDueMidiEvents(ring, dueTimeMs = Infinity) {
  if (!ring || !ring.midi || !ring.instrument) return []
  const capacity = ring.midiCapacity
  const out = []
  while (
    Atomics.load(ring.control, EXTERNAL_CONTROL.MIDI_WRITE) >
    Atomics.load(ring.control, EXTERNAL_CONTROL.MIDI_READ)
  ) {
    const readCounter = Atomics.load(ring.control, EXTERNAL_CONTROL.MIDI_READ)
    const read = readCounter % capacity
    const base = read * EXTERNAL_MIDI_RECORD_INTS
    const event = decodeMidiEvent(ring.midi.subarray(base, base + EXTERNAL_MIDI_RECORD_INTS))
    if (!event) {
      Atomics.add(ring.control, EXTERNAL_CONTROL.MIDI_READ, 1)
      continue
    }
    if (Number(event.timeMs) > Number(dueTimeMs)) break
    Atomics.add(ring.control, EXTERNAL_CONTROL.MIDI_READ, 1)
    out.push(event)
  }
  return out
}

/** 清空 MIDI 队列（stop/panic 用）；返回清除事件数。 */
export function clearMidiQueue(ring) {
  if (!ring || !ring.midi || !ring.instrument) return 0
  const pending = Math.max(
    0,
    Atomics.load(ring.control, EXTERNAL_CONTROL.MIDI_WRITE) - Atomics.load(ring.control, EXTERNAL_CONTROL.MIDI_READ),
  )
  Atomics.store(ring.control, EXTERNAL_CONTROL.MIDI_READ, Atomics.load(ring.control, EXTERNAL_CONTROL.MIDI_WRITE))
  return pending
}

/**
 * 兼容 host preload/IPC 的 process 返回：
 * - {outputs: Float32Array[]}（结构化克隆，desktop preload 实际形态）
 * - {outputs: string[]}（base64 planar，contract 兼容）
 * - {outputsBase64: string[]}（host 额外字段）
 * @returns {Float32Array[]}
 */
export function normalizePluginProcessOutputs(result) {
  if (!result || typeof result !== "object") return []
  const raw = Array.isArray(result.outputsBase64)
    ? result.outputsBase64
    : Array.isArray(result.outputs)
      ? result.outputs
      : []
  if (raw.length === 0) return []
  if (typeof raw[0] === "string") return base64PlanesToFloat32(raw)
  return raw.map((channel) => (channel instanceof Float32Array ? channel : Float32Array.from(channel ?? [])))
}

/** 规范化 host params 列表（id/name/label/min/max/value 等）。 */
export function normalizePluginParamList(payload) {
  const list = Array.isArray(payload?.params)
    ? payload.params
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload)
        ? payload
        : []
  return list
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: Number.isFinite(Number(item.id)) ? Number(item.id) : Number.isFinite(Number(item.index)) ? Number(item.index) : index,
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
      name: typeof item.name === "string" ? item.name : typeof item.title === "string" ? item.title : "参数 " + index,
      label: typeof item.label === "string" ? item.label : typeof item.shortTitle === "string" ? item.shortTitle : "",
      unit: typeof item.unit === "string" ? item.unit : typeof item.units === "string" ? item.units : "",
      min: Number.isFinite(Number(item.min)) ? Number(item.min) : 0,
      max: Number.isFinite(Number(item.max)) ? Number(item.max) : 1,
      value: Number.isFinite(Number(item.value)) ? Math.max(0, Math.min(1, Number(item.value))) : 0,
      default: Number.isFinite(Number(item.default)) ? Number(item.default) : 0,
    }))
}

/** Float32 planar → base64（每声道一个字符串，host 协议用）。 */
export function float32PlanesToBase64(planar) {
  const list = Array.isArray(planar) ? planar : []
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return list.map((channel) => {
      const data = channel instanceof Float32Array ? channel : new Float32Array(channel)
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
    })
  }
  return list.map((channel) => {
    const data = channel instanceof Float32Array ? channel : new Float32Array(channel)
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return typeof btoa === 'function' ? btoa(binary) : ''
  })
}

/** base64 声道 → Float32 planar。 */
export function base64PlanesToFloat32(list) {
  const planes = Array.isArray(list) ? list : []
  return planes.map((encoded) => {
    const text = typeof encoded === 'string' ? encoded : ''
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      const buffer = Buffer.from(text, 'base64')
      const copy = new Float32Array(Math.floor(buffer.byteLength / 4))
      for (let i = 0; i < copy.length; i++) copy[i] = buffer.readFloatLE(i * 4)
      return copy
    }
    const binary = typeof atob === 'function' ? atob(text) : ''
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4))
  })
}

/** 创建 worklet module URL（Blob → data URL 兜底）；不可用返回 null。 */
export function createWorkletModuleUrl(source = EXTERNAL_PLUGIN_WORKLET_SOURCE) {
  try {
    if (typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    }
  } catch {
    /* fallthrough */
  }
  try {
    return `data:text/javascript;base64,${typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(source))) : ''}`
  } catch {
    return null
  }
}

/**
 * 为某个 AudioContext 加载一次 worklet 模块（unlock 中 await，构建图之前）。
 * @returns {Promise<boolean>} 是否 ready
 */
export async function ensureExternalPluginWorklet(ctx) {
  if (!ctx || !ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') return false
  if (workletModuleCache.get(ctx) === true) return true
  const existing = workletModuleCache.get(ctx)
  if (existing && typeof existing.then === 'function') return existing
  const promise = (async () => {
    const url = createWorkletModuleUrl()
    if (!url) return false
    try {
      await ctx.audioWorklet.addModule(url)
      return true
    } catch {
      return false
    } finally {
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
      } catch {
        /* ignore */
      }
    }
  })()
  workletModuleCache.set(ctx, promise)
  const ready = await promise
  workletModuleCache.set(ctx, ready)
  return ready
}

/** 外部插件实例 id：effect = `fx:${effect.id}`；M3 instrument = `track:${track.id}`。 */
export function externalInstanceIdForEffect(effect) {
  const effectId = effect && typeof effect.id === 'string' ? effect.id.trim() : ''
  return effectId ? `fx:${effectId}` : ''
}

function degrade(ctx, reason, options = {}, extra = {}) {
  const input = ctx.createGain()
  const output = ctx.createGain()
  try {
    output.gain.value = 1
  } catch {
    /* ignore */
  }
  try {
    input.connect(output)
  } catch {
    /* ignore */
  }
  const trackId = options.trackId ?? extra.trackId ?? null
  const target = options.target ?? extra.target ?? 'track'
  const warning = {
    code: 'external-plugin-degraded',
    message: reason,
    effectId: extra.effectId ?? null,
    pluginId: extra.pluginId ?? null,
  }
  if (Array.isArray(options.warnings)) options.warnings.push(warning)
  return {
    input,
    output,
    node: null,
    bridge: null,
    degraded: true,
    warning,
    effectId: extra.effectId ?? null,
    pluginId: extra.pluginId ?? null,
    instanceId: extra.instanceId ?? null,
    trackId,
    target,
    update() {},
    status() {
      return {
        loaded: false,
        degraded: true,
        bypass: true,
        instanceId: extra.instanceId ?? null,
        pluginId: extra.pluginId ?? null,
        effectId: extra.effectId ?? null,
        trackId,
        target,
        error: reason,
        underrun: 0,
        bufferMs: 0,
        latencyMs: 0,
        params: {},
      }
    },
    dispose() {
      try {
        input.disconnect()
      } catch {
        /* ignore */
      }
      try {
        output.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * v2.3 P1：vst3.preset = {listId,index,name} 引用规范化/去重 key。
 */
export function normalizePluginPresetRef(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const listId = Number.isFinite(Number(raw.listId)) ? Math.max(0, Math.round(Number(raw.listId))) : null
  const index = Number.isFinite(Number(raw.index)) ? Math.max(0, Math.round(Number(raw.index))) : null
  if (listId === null && index === null) return null
  return {
    listId,
    index,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim().slice(0, 160) : '',
  }
}

export function pluginPresetKey(preset) {
  const ref = normalizePluginPresetRef(preset)
  if (!ref) return ''
  return `${ref.listId ?? '?'}:${ref.index ?? '?'}`
}

/**
 * 外部 effect 主线程桥。
 * 可注入 scheduler/getApi 便于单测（不依赖 window/定时器）。
 */
export class ExternalPluginBridge {
  constructor(options = {}) {
    this.ring = options.ring
    this.instanceId = options.instanceId
    this.pluginId = options.pluginId
    this.effectId = options.effectId ?? null
    this.trackId = options.trackId ?? null
    this.target = options.target ?? 'track'
    this.sampleRate = Math.max(1, Number(options.sampleRate) || 44100)
    this.maxBlockSize = Math.max(64, Math.round(Number(options.maxBlockSize) || EXTERNAL_BLOCK_FRAMES))
    this.intervalMs = Math.max(1, Number(options.pumpIntervalMs) || EXTERNAL_PUMP_INTERVAL_MS)
    const throttleOption = Number(options.paramThrottleMs)
    this.throttleMs = Number.isFinite(throttleOption)
      ? Math.max(0, throttleOption)
      : EXTERNAL_PARAM_THROTTLE_MS
    this.stateBase64 = typeof options.stateBase64 === 'string' ? options.stateBase64 : null
    // v2.3 P1：preset/state 已应用快照（避免 setProject 每轮重复 selectProgram/loadState）
    this.presetRef = normalizePluginPresetRef(options.preset)
    this.appliedPresetKey = pluginPresetKey(this.presetRef)
    this.appliedStateBase64 = this.stateBase64
    this.presetError = null
    this._pluginStateSync = Promise.resolve()
    this.getApi = typeof options.getApi === 'function' ? options.getApi : () => getExternalPluginApi()
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null
    this.setIntervalImpl = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIntervalImpl = options.clearInterval ?? ((id) => clearInterval(id))
    this.now = typeof options.now === 'function' ? options.now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    this.timer = null
    this.inFlight = false
    this.loaded = false
    this.loading = false
    this.degraded = false
    this.error = null
    this.bypass = false
    this.params = {}
    /** host getInstanceParams 返回的参数描述（UI 滑块用）。 */
    this.paramList = []
    this.pendingParams = new Map()
    this.paramTimer = null
    this.bufferMs = 0
    this.latencyMs = 0
    this.lastProcessMs = 0
    this.stats = { underrun: 0, processedBlocks: 0, droppedInputBlocks: 0, errors: 0 }
  }

  get spec() {
    return {
      instanceId: this.instanceId,
      pluginId: this.pluginId,
      sampleRate: this.sampleRate,
      maxBlockSize: this.maxBlockSize,
      audioInputs: this.ring?.channels ?? EXTERNAL_CHANNELS,
      audioOutputs: this.ring?.channels ?? EXTERNAL_CHANNELS,
      ...(this.stateBase64 ? { stateBase64: this.stateBase64 } : {}),
    }
  }

  async load() {
    const api = this.getApi()
    if (!api || typeof api.load !== 'function') {
      this.degraded = true
      this.error = '外部插件仅桌面版：缺少 window.aimsPlugins preload bridge'
      this._emit()
      return false
    }
    if (this.loaded || this.loading) return this.loaded
    this.loading = true
    try {
      const result = await api.load(this.pluginId, this.spec)
      if (result && result.ok === false) throw new Error(String(result.error || '加载外部插件失败'))
      this.loaded = true
      this.error = null
      // host 返回真实参数描述（id/name/label/min/max/value），UI 用 paramList 渲染滑块
      if (typeof api.params === 'function') {
        try {
          this.paramList = normalizePluginParamList(await api.params({ instanceId: this.instanceId }))
        } catch {
          this.paramList = []
        }
      }
      if (Object.keys(this.params).length > 0 && typeof api.setParam === 'function') {
        for (const [paramId, value] of Object.entries(this.params)) {
          try {
            await api.setParam({ instanceId: this.instanceId, paramId, value })
          } catch {
            /* 单参数失败忽略 */
          }
        }
      }
      this._emit()
      return true
    } catch (error) {
      this.loaded = false
      this.degraded = true
      this.error = String(error?.message ?? error)
      this._emit()
      return false
    } finally {
      this.loading = false
    }
  }

  start() {
    if (this.timer !== null) return
    this.timer = this.setIntervalImpl(() => {
      void this.pumpOnce()
    }, this.intervalMs)
  }

  stop() {
    if (this.timer !== null) {
      try {
        this.clearIntervalImpl(this.timer)
      } catch {
        /* ignore */
      }
      this.timer = null
    }
    if (this.paramTimer !== null) {
      try {
        clearTimeout(this.paramTimer)
      } catch {
        /* ignore */
      }
      this.paramTimer = null
    }
  }

  /** 单次 pump（测试直接调用；真实运行由 setInterval 驱动）。 */
  async pumpOnce() {
    const api = this.getApi()
    if (this.inFlight || !this.ring || this.bypass || this.error || this.degraded) return false
    if (!this.loaded || !api || typeof api.process !== 'function') return false
    if (ringAvailable(this.ring.control, EXTERNAL_CONTROL.INPUT_READ, EXTERNAL_CONTROL.INPUT_WRITE, this.ring.ringFrames) < this.maxBlockSize) return false
    const free = this.ring.ringFrames - ringAvailable(this.ring.control, EXTERNAL_CONTROL.OUTPUT_READ, EXTERNAL_CONTROL.OUTPUT_WRITE, this.ring.ringFrames)
    if (free < this.maxBlockSize) {
      this.stats.droppedInputBlocks += 1
      return false
    }
    const block = readInputRing(this.ring, this.maxBlockSize)
    if (!block) return false
    this.inFlight = true
    const started = this.now()
    try {
      const result = await api.process({
        instanceId: this.instanceId,
        inputs: float32PlanesToBase64(block.inputs),
        numSamples: block.frames,
      })
      if (result && result.ok === false) throw new Error(String(result.error || '外部插件处理失败'))
      const outputs = normalizePluginProcessOutputs(result)
      if (!outputs || outputs.length === 0) throw new Error('外部插件未返回音频输出')
      if (!writeOutputRing(this.ring, outputs, block.frames)) {
        this.stats.underrun += 1
        throw new Error('外部插件输出环空间不足')
      }
      this.stats.processedBlocks += 1
      this.lastProcessMs = Math.max(0, this.now() - started)
      const buffered = ringAvailable(this.ring.control, EXTERNAL_CONTROL.OUTPUT_READ, EXTERNAL_CONTROL.OUTPUT_WRITE, this.ring.ringFrames)
      this.bufferMs = Math.round((buffered / this.sampleRate) * 1000 * 100) / 100
      this.latencyMs = Math.round((this.lastProcessMs + this.bufferMs) * 100) / 100
      this.stats.underrun = Math.max(this.stats.underrun, Atomics.load(this.ring.control, EXTERNAL_CONTROL.UNDERRUN))
      this.error = null
      this._emit()
      return true
    } catch (error) {
      this.stats.errors += 1
      this.error = String(error?.message ?? error)
      this.degraded = true
      Atomics.store(this.ring.control, EXTERNAL_CONTROL.ERROR, 1)
      this._emit()
      return false
    } finally {
      this.inFlight = false
    }
  }

  /** host 参数 id 解析：数字直接用；名称/label 先在 paramList 中查找对应 id。 */
  _resolveParamId(paramId) {
    const numeric = Number(paramId)
    if (Number.isFinite(numeric)) return numeric
    const text = typeof paramId === 'string' ? paramId : String(paramId ?? '')
    const found = this.paramList.find((item) => String(item.id) === text || item.name === text || item.label === text)
    return found ? found.id : text
  }

  /** 节流写单个参数（≤50ms；实时参数不进 undo）。 */
  setParam(paramId, value) {
    const resolved = this._resolveParamId(paramId)
    const id = String(resolved ?? '')
    if (id === '') return false
    const numeric = Math.max(0, Math.min(1, Number(value)))
    if (!Number.isFinite(numeric)) return false
    const normalized = Math.round(numeric * 1e6) / 1e6
    // 同值且没有待发送的新值：无需再次下发（自动化 tick 每 40ms 调用也不会刷爆 IPC）
    if (this.params[id] === normalized && !this.pendingParams.has(resolved)) return true
    this.params[id] = normalized
    this.pendingParams.set(resolved, this.params[id])
    if (this.throttleMs === 0) return this._flushParams()
    if (this.paramTimer === null) {
      this.paramTimer = setTimeout(() => {
        this.paramTimer = null
        this._flushParams()
      }, this.throttleMs)
      this.paramTimer?.unref?.()
    }
    return true
  }

  /**
   * v2.3 P0：把工程 vst3.params 同步到已有实例 —— **只下发变化参数**（diff），
   * 供 setProject/graph.update 使用；不触发音频图重建。返回实际提交的参数数。
   */
  syncParams(params) {
    if (!params || typeof params !== 'object') return 0
    let changed = 0
    for (const [key, value] of Object.entries(params)) {
      const numeric = Math.max(0, Math.min(1, Number(value)))
      if (!Number.isFinite(numeric)) continue
      const normalized = Math.round(numeric * 1e6) / 1e6
      const resolved = this._resolveParamId(key)
      const id = String(resolved ?? '')
      if (id === '') continue
      if (this.params[id] === normalized && !this.pendingParams.has(resolved)) continue
      if (this.setParam(resolved, normalized)) changed += 1
    }
    return changed
  }

  setParams(params) {
    if (!params || typeof params !== 'object') return false
    for (const [key, value] of Object.entries(params)) this.setParam(key, value)
    return true
  }

  /** 调用 preload selectProgram；host 未暴露时返回 false（不崩）。 */
  async selectProgram(listId, index) {
    const api = this.getApi()
    const fn = api && (api.selectProgram || api.setProgram)
    if (typeof fn !== 'function' || !this.instanceId) return false
    const payload = {
      instanceId: this.instanceId,
      listId: Number.isFinite(Number(listId)) ? Math.max(0, Math.round(Number(listId))) : 0,
      index: Number.isFinite(Number(index)) ? Math.max(0, Math.round(Number(index))) : 0,
    }
    const result = await fn.call(api, payload)
    if (result && result.ok === false) throw new Error(String(result.error || 'selectProgram 失败'))
    return true
  }

  /** 调用 preload loadState（base64）；host 未暴露时返回 false（不崩）。 */
  async loadState(stateBase64) {
    const api = this.getApi()
    const fn = api && (api.loadState || api.loadInstanceState)
    if (typeof fn !== 'function' || !this.instanceId || typeof stateBase64 !== 'string' || stateBase64 === '') return false
    const result = await fn.call(api, { instanceId: this.instanceId, stateBase64 })
    if (result && result.ok === false) throw new Error(String(result.error || 'loadState 失败'))
    this.stateBase64 = stateBase64
    return true
  }

  /** state 载入后采用工程 params 作为已应用快照（不再发送 IPC，避免覆盖刚载入的 state）。 */
  _adoptParams(params) {
    if (!params || typeof params !== 'object') return
    for (const [key, value] of Object.entries(params)) {
      const numeric = Math.max(0, Math.min(1, Number(value)))
      if (!Number.isFinite(numeric)) continue
      const resolved = this._resolveParamId(key)
      const id = String(resolved ?? '')
      if (id === '') continue
      this.params[id] = Math.round(numeric * 1e6) / 1e6
    }
  }

  /**
   * v2.3 P1：setProject/graph.update 的 preset/state diff 同步（串行、不重建音频图）。
   * - stateBase64 变化 → loadState（state 已包含整个 preset 状态，优先于 selectProgram）；
   * - 仅 preset 变化 → selectProgram；
   * - state 载入后采用工程 params 作为已应用快照；否则以工程 vst3.params 为准 syncParams。
   */
  syncPluginState(vst3 = {}) {
    if (!vst3 || typeof vst3 !== 'object') return Promise.resolve(0)
    const preset = normalizePluginPresetRef(vst3.preset)
    const presetKey = pluginPresetKey(preset)
    const stateBase64 = typeof vst3.stateBase64 === 'string' && vst3.stateBase64 !== '' ? vst3.stateBase64 : null
    this.presetRef = preset
    const run = this._pluginStateSync
      .then(async () => {
        if (this.degraded) return 0
        if (!this.loaded) await this.load()
        if (this.degraded) return 0
        let applied = 0
        let stateApplied = false
        if (stateBase64 && stateBase64 !== this.appliedStateBase64) {
          try {
            const ok = await this.loadState(stateBase64)
            if (ok) {
              applied += 1
              stateApplied = true
              this.appliedStateBase64 = stateBase64
              // 载入 state 后 preset 选择也视为已应用，避免重复 selectProgram
              if (presetKey) this.appliedPresetKey = presetKey
              // state 已包含完整参数；把工程 params 记为已应用，避免后续 setProject 用旧 params 覆盖
              this._adoptParams(vst3.params)
            }
          } catch (error) {
            this.presetError = String(error?.message ?? error)
          }
        } else if (presetKey && presetKey !== this.appliedPresetKey) {
          try {
            const ok = await this.selectProgram(preset?.listId ?? 0, preset?.index ?? 0)
            if (ok) {
              applied += 1
              this.appliedPresetKey = presetKey
            }
          } catch (error) {
            this.presetError = String(error?.message ?? error)
          }
        }
        // stateBase64 已包含完整插件状态；此时不能再用工程 params 覆盖刚载入的 state。
        // 后续 revision 若只改 params，会走正常 diff 同步。
        if (!stateApplied && vst3.params && typeof vst3.params === 'object') {
          applied += this.syncParams(vst3.params)
        }
        if (applied > 0) this._emit()
        return applied
      })
      .catch((error) => {
        this.presetError = String(error?.message ?? error)
        return 0
      })
    this._pluginStateSync = run
    return run
  }

  async _flushParams() {
    const api = this.getApi()
    if (!api || typeof api.setParam !== 'function' || this.pendingParams.size === 0) return false
    const entries = [...this.pendingParams.entries()]
    this.pendingParams.clear()
    for (const [paramId, value] of entries) {
      try {
        await api.setParam({ instanceId: this.instanceId, paramId, value })
      } catch {
        /* 单参数失败不阻断 */
      }
    }
    return true
  }

  setBypass(bypass) {
    this.bypass = bypass === true
    if (this.ring) Atomics.store(this.ring.control, EXTERNAL_CONTROL.BYPASS, this.bypass ? 1 : 0)
    this._emit()
    return this.bypass
  }

  status() {
    let underrun = this.stats.underrun
    try {
      if (this.ring) underrun = Math.max(underrun, Atomics.load(this.ring.control, EXTERNAL_CONTROL.UNDERRUN))
    } catch {
      /* ignore */
    }
    const buffered = this.ring
      ? ringAvailable(this.ring.control, EXTERNAL_CONTROL.OUTPUT_READ, EXTERNAL_CONTROL.OUTPUT_WRITE, this.ring.ringFrames)
      : 0
    return {
      loaded: this.loaded && !this.degraded,
      degraded: this.degraded,
      bypass: this.bypass,
      instanceId: this.instanceId,
      pluginId: this.pluginId,
      effectId: this.effectId,
      trackId: this.trackId,
      target: this.target,
      sampleRate: this.sampleRate,
      maxBlockSize: this.maxBlockSize,
      underrun,
      bufferFrames: buffered,
      bufferMs: this.bufferMs,
      latencyMs: this.latencyMs,
      processMs: this.lastProcessMs,
      error: this.error,
      params: { ...this.params },
      preset: this.presetRef ? { ...this.presetRef } : null,
      presetError: this.presetError,
      paramList: this.paramList.map((item) => ({ ...item })),
    }
  }

  _emit() {
    if (this.onStatus) {
      try {
        this.onStatus(this.status())
      } catch {
        /* ignore */
      }
    }
  }

  /** v2.2 M4：读取插件实例状态（host saveState/saveInstanceState，供工程保存持久化）。 */
  async saveState() {
    const api = this.getApi()
    const fn = api && (api.saveState || api.saveInstanceState)
    if (typeof fn !== 'function' || !this.instanceId) return null
    try {
      const result = await fn.call(api, this.instanceId)
      const state = typeof result === 'string' ? result : result?.stateBase64 ?? result?.state ?? result?.data ?? null
      if (typeof state === 'string' && state !== '') {
        this.stateBase64 = state
        return state
      }
    } catch {
      /* ignore */
    }
    return null
  }

  async unload() {
    this.stop()
    const api = this.getApi()
    if (api && typeof api.unload === 'function' && this.instanceId) {
      try {
        await api.unload(this.instanceId)
      } catch {
        /* ignore */
      }
    }
    this.loaded = false
    return true
  }
}

/**
 * v2.2 M4：冻结轨检测/缓存 media 解析。
 * 冻结动作由 host 完成（写 plugin-cache WAV + track.freeze + project.media 条目）；
 * audio 只读 track.freeze 并播放缓存。
 */
export function freezeStatusOf(track) {
  const freeze = track?.freeze
  if (!freeze || typeof freeze !== 'object') return 'none'
  const status = typeof freeze.status === 'string' ? freeze.status : ''
  if (['current', 'stale', 'freezing', 'error'].includes(status)) return status
  if (freeze.stale === true) return 'stale'
  if (freeze.error) return 'error'
  return 'current'
}

/** 冻结轨是否为可播放 current（stale/freezing/error 时恢复实时外部节点）。 */
export function isFrozenTrack(track) {
  const freeze = track?.freeze
  if (!freeze || typeof freeze !== 'object') return false
  if (freezeStatusOf(track) !== 'current') return false
  return Boolean(
    (typeof freeze.mediaId === 'string' && freeze.mediaId) ||
      (typeof freeze.cacheFile === 'string' && freeze.cacheFile) ||
      (typeof freeze.cachePath === 'string' && freeze.cachePath),
  )
}

/** 冻结轨展示/调度信息（只读）。 */
export function frozenTrackInfo(track) {
  const freeze = track?.freeze
  if (!freeze || typeof freeze !== 'object') return null
  return {
    trackId: typeof track?.id === 'string' ? track.id : '',
    frozen: isFrozenTrack(track),
    status: freezeStatusOf(track),
    mediaId: typeof freeze.mediaId === 'string' ? freeze.mediaId : '',
    cacheFile: typeof freeze.cacheFile === 'string' ? freeze.cacheFile : '',
    cachePath: typeof freeze.cachePath === 'string' ? freeze.cachePath : '',
    hash: typeof freeze.hash === 'string' ? freeze.hash : '',
    bars: Number.isFinite(Number(freeze.bars)) ? Number(freeze.bars) : null,
    frames: Number.isFinite(Number(freeze.frames)) ? Number(freeze.frames) : null,
    sampleRate: Number.isFinite(Number(freeze.sampleRate)) ? Number(freeze.sampleRate) : null,
    includesFx: freeze.includesFx === true,
    latencySamples: Number.isFinite(Number(freeze.latencySamples)) ? Number(freeze.latencySamples) : 0,
    cachedAt: Number.isFinite(Number(freeze.cachedAt))
      ? Number(freeze.cachedAt)
      : Number.isFinite(Number(freeze.createdAt))
        ? Number(freeze.createdAt)
        : null,
    error: typeof freeze.error === 'string' ? freeze.error : '',
  }
}

/** 在 project.media 中查冻结缓存条目（host 需登记 media，audio 才能通过 MediaBank 解码）。 */
export function frozenMediaEntry(project, track) {
  const freeze = track?.freeze
  if (!freeze || typeof freeze !== 'object') return null
  const media = Array.isArray(project?.media) ? project.media : []
  const mediaId = typeof freeze.mediaId === 'string' ? freeze.mediaId : ''
  if (mediaId !== '') return media.find((entry) => entry && entry.id === mediaId) ?? null
  // mediaId 缺失时按 cacheFile 文件名匹配（host 可能只登记 file）
  const cacheFile = typeof freeze.cacheFile === 'string' ? freeze.cacheFile : ''
  if (cacheFile === '') return null
  const baseName = cacheFile.split(/[\\/]/).pop()
  return (
    media.find(
      (entry) =>
        entry &&
        (entry.file === cacheFile ||
          entry.file === baseName ||
          entry.file?.split(/[\\/]/).pop() === baseName),
    ) ?? null
  )
}

/** 工程内所有 vst3 外部插件轨是否都已冻结（用于 renderWav 自动冻结判断）。 */
export function unfrozenVst3Tracks(project) {
  return (project?.tracks ?? []).filter((track) => {
    if (!track || typeof track !== 'object') return false
    const hasVst3Instrument = isExternalInstrumentTrack(track)
    const hasVst3Effect = (track.effects ?? []).some((effect) => effect?.type === 'vst3')
    if (!hasVst3Instrument && !hasVst3Effect) return false
    return !isFrozenTrack(track)
  })
}

/** 工程内冻结轨计划列表（engine 实时/离线调度用）。 */
export function listFrozenTracks(project) {
  return (project?.tracks ?? [])
    .filter((track) => isFrozenTrack(track))
    .map((track) => ({ track, info: frozenTrackInfo(track), media: frozenMediaEntry(project, track) }))
}

/**
 * v2.2 M3：instrument 轨判断/实例 id（host 约定 effect=fx:<id>，instrument=track:<id>）。
 */
export function isExternalInstrumentTrack(track) {
  return (
    track?.kind !== 'drum' &&
    track?.engine === 'vst3' &&
    typeof track?.vst3?.pluginId === 'string' &&
    track.vst3.pluginId.trim() !== ''
  )
}

export function externalInstanceIdForTrack(track) {
  const trackId = track && typeof track.id === 'string' ? track.id.trim() : ''
  return trackId ? `track:${trackId}` : ''
}

/**
 * v2.2 M3：VST3 instrument 主线程桥（无音频输入；MIDI SAB 队列 → preload process({midi}) → output ring）。
 */
export class ExternalInstrumentBridge extends ExternalPluginBridge {
  constructor(options = {}) {
    super(options)
    this.kind = 'instrument'
    this.instrument = true
    this.midiEventCount = 0
    this.midiDropped = 0
    this.activeNotes = new Set()
    this.lastMidiEvents = 0
    this.currentTime = typeof options.currentTime === 'function'
      ? options.currentTime
      : () => 0
    this.midiSeq = 0
  }

  get spec() {
    return {
      instanceId: this.instanceId,
      pluginId: this.pluginId,
      kind: 'instrument',
      sampleRate: this.sampleRate,
      maxBlockSize: this.maxBlockSize,
      audioInputs: 0,
      audioOutputs: this.ring?.channels ?? EXTERNAL_CHANNELS,
      ...(this.stateBase64 ? { stateBase64: this.stateBase64 } : {}),
    }
  }

  _queueMidi(event) {
    if (!this.ring || !this.ring.instrument) return false
    this.midiSeq += 1
    const written = writeMidiEventToRing(this.ring, { ...event, seq: this.midiSeq })
    if (!written) {
      this.midiDropped += 1
      return false
    }
    return true
  }

  /** 写 noteOn（time 为 context 绝对秒；velocity 0..1）。 */
  noteOn(pitch, velocity = 0.8, timeSec = this.currentTime()) {
    const pitchValue = Math.max(0, Math.min(127, Math.round(Number(pitch) || 0)))
    const vel = Math.max(0, Math.min(1, Number(velocity)))
    this.activeNotes.add(pitchValue)
    return this._queueMidi({
      type: EXTERNAL_MIDI_TYPE.NOTE_ON,
      pitch: pitchValue,
      velocity: Math.round((Number.isFinite(vel) ? vel : 0.8) * 127),
      timeMs: Math.max(0, Number(timeSec) || 0) * 1000,
    })
  }

  /** 写 noteOff（time 为 context 绝对秒）。 */
  noteOff(pitch, timeSec = this.currentTime()) {
    const pitchValue = Math.max(0, Math.min(127, Math.round(Number(pitch) || 0)))
    this.activeNotes.delete(pitchValue)
    return this._queueMidi({
      type: EXTERNAL_MIDI_TYPE.NOTE_OFF,
      pitch: pitchValue,
      velocity: 0,
      timeMs: Math.max(0, Number(timeSec) || 0) * 1000,
    })
  }

  cc(controller, value, timeSec = this.currentTime()) {
    return this._queueMidi({
      type: EXTERNAL_MIDI_TYPE.CC,
      controller: Math.max(0, Math.min(127, Math.round(Number(controller) || 0))),
      value: Math.max(0, Math.min(127, Math.round(Number(value) || 0))),
      timeMs: Math.max(0, Number(timeSec) || 0) * 1000,
    })
  }

  pitchBend(value, timeSec = this.currentTime()) {
    return this._queueMidi({
      type: EXTERNAL_MIDI_TYPE.PITCH_BEND,
      value: Math.max(0, Math.min(127, Math.round((Number(value) + 1) * 63.5))),
      timeMs: Math.max(0, Number(timeSec) || 0) * 1000,
    })
  }

  /**
   * 停止/切歌 panic：清空未来 MIDI 队列，显式 noteOff 所有活动音，并补 CC123/CC120。
   * 避免 stop 之后队列里已排的 noteOn 再发声。
   */
  panic(timeSec = this.currentTime()) {
    const cleared = clearMidiQueue(this.ring)
    const pitches = [...this.activeNotes]
    this.activeNotes.clear()
    const timeMs = Math.max(0, Number(timeSec) || 0) * 1000
    for (const pitch of pitches) {
      this._queueMidi({ type: EXTERNAL_MIDI_TYPE.NOTE_OFF, pitch, velocity: 0, timeMs })
    }
    // CC123 All Notes Off / CC120 All Sound Off（host 支持 cc）
    this._queueMidi({ type: EXTERNAL_MIDI_TYPE.CC, controller: 123, value: 0, timeMs })
    this._queueMidi({ type: EXTERNAL_MIDI_TYPE.CC, controller: 120, value: 0, timeMs })
    return cleared
  }

  _hostMidiForEvents(events, nowSeconds, blockSeconds) {
    const out = []
    for (const event of events) {
      const eventSeconds = Number(event.timeMs) / 1000
      const sampleOffset = Math.max(
        0,
        Math.min(this.maxBlockSize - 1, Math.round((eventSeconds - nowSeconds) * this.sampleRate)),
      )
      if (event.type === EXTERNAL_MIDI_TYPE.NOTE_ON) {
        out.push({ type: 'noteOn', pitch: event.pitch, velocity: Math.max(1, event.velocity) / 127, sampleOffset })
      } else if (event.type === EXTERNAL_MIDI_TYPE.NOTE_OFF) {
        out.push({ type: 'noteOff', pitch: event.pitch, velocity: 0, sampleOffset })
      } else if (event.type === EXTERNAL_MIDI_TYPE.CC) {
        out.push({ type: 'cc', controller: event.controller, value: event.value, sampleOffset })
      } else if (event.type === EXTERNAL_MIDI_TYPE.PITCH_BEND) {
        out.push({ type: 'pitchBend', value: (event.value / 127) * 2 - 1, sampleOffset })
      } else if (event.type === EXTERNAL_MIDI_TYPE.ALL_NOTES_OFF) {
        out.push({ type: 'cc', controller: 123, value: 0, sampleOffset })
      } else if (event.type === EXTERNAL_MIDI_TYPE.ALL_SOUND_OFF) {
        out.push({ type: 'cc', controller: 120, value: 0, sampleOffset })
      }
    }
    return out
  }

  /** instrument pump：即使没有 MIDI 也持续 process（渲染尾音/静音），避免 underrun。 */
  async pumpOnce() {
    const api = this.getApi()
    if (this.inFlight || !this.ring || !this.ring.instrument || this.bypass || this.error || this.degraded) return false
    if (!this.loaded || !api || typeof api.process !== 'function') return false
    const free = this.ring.ringFrames - ringAvailable(
      this.ring.control,
      EXTERNAL_CONTROL.OUTPUT_READ,
      EXTERNAL_CONTROL.OUTPUT_WRITE,
      this.ring.ringFrames,
    )
    if (free < this.maxBlockSize) return false
    this.inFlight = true
    const started = this.now()
    try {
      const nowSeconds = Number(this.currentTime()) || 0
      const blockSeconds = this.maxBlockSize / this.sampleRate
      const dueEvents = readDueMidiEvents(this.ring, (nowSeconds + blockSeconds) * 1000)
      const midi = this._hostMidiForEvents(dueEvents, nowSeconds, blockSeconds)
      this.lastMidiEvents = midi.length
      const result = await api.process({
        instanceId: this.instanceId,
        // v2.3：main IPC 校验 process={inputs:Array}；无输入乐器也必须显式传空数组
        inputs: [],
        midi,
        numSamples: this.maxBlockSize,
      })
      if (result && result.ok === false) throw new Error(String(result.error || '外部乐器处理失败'))
      const outputs = normalizePluginProcessOutputs(result)
      if (!outputs || outputs.length === 0) throw new Error('外部乐器未返回音频输出')
      if (!writeOutputRing(this.ring, outputs, this.maxBlockSize)) {
        this.stats.underrun += 1
        throw new Error('外部乐器输出环空间不足')
      }
      this.midiEventCount += dueEvents.length
      this.stats.processedBlocks += 1
      this.lastProcessMs = Math.max(0, this.now() - started)
      const buffered = ringAvailable(this.ring.control, EXTERNAL_CONTROL.OUTPUT_READ, EXTERNAL_CONTROL.OUTPUT_WRITE, this.ring.ringFrames)
      this.bufferMs = Math.round((buffered / this.sampleRate) * 1000 * 100) / 100
      this.latencyMs = Math.round((this.lastProcessMs + this.bufferMs) * 100) / 100
      this.stats.underrun = Math.max(this.stats.underrun, Atomics.load(this.ring.control, EXTERNAL_CONTROL.UNDERRUN))
      this.error = null
      this._emit()
      return true
    } catch (error) {
      this.stats.errors += 1
      this.error = String(error?.message ?? error)
      this.degraded = true
      Atomics.store(this.ring.control, EXTERNAL_CONTROL.ERROR, 1)
      this._emit()
      return false
    } finally {
      this.inFlight = false
    }
  }

  status() {
    const base = super.status()
    let midiDropped = this.midiDropped
    try {
      if (this.ring) midiDropped = Math.max(midiDropped, Atomics.load(this.ring.control, EXTERNAL_CONTROL.MIDI_DROPPED))
    } catch {
      /* ignore */
    }
    return {
      ...base,
      kind: 'instrument',
      instrument: true,
      midiEventCount: this.midiEventCount,
      midiLastEvents: this.lastMidiEvents,
      midiDropped,
      activeNotes: this.activeNotes.size,
    }
  }
}

/**
 * v2.2 M3：创建一个外部 VST3 乐器节点（无输入、stereo 输出）。
 * 无 preload/AudioWorklet/SAB/worklet ready → 静音 Gain + warning（不崩溃）。
 */
export function createExternalInstrumentNode(ctx, track, options = {}) {
  const trackId = typeof track?.id === 'string' ? track.id : ''
  const pluginId = typeof track?.vst3?.pluginId === 'string' ? track.vst3.pluginId : ''
  const instanceId = externalInstanceIdForTrack(track)
  const extra = { pluginId, trackId, instanceId, target: 'instrument' }
  const degradeInstrument = (reason) => {
    const output = ctx && typeof ctx.createGain === 'function' ? ctx.createGain() : null
    if (output) {
      try {
        output.gain.value = 1
      } catch {
        /* ignore */
      }
    }
    const warning = {
      code: 'external-instrument-degraded',
      message: reason,
      trackId,
      pluginId,
    }
    if (Array.isArray(options.warnings)) options.warnings.push(warning)
    return {
      output,
      node: null,
      bridge: null,
      degraded: true,
      warning,
      trackId,
      pluginId,
      instanceId,
      kind: 'instrument',
      noteOn: () => false,
      noteOff: () => false,
      panic: () => 0,
      update() {},
      status() {
        return {
          kind: 'instrument',
          instrument: true,
          loaded: false,
          degraded: true,
          bypass: false,
          instanceId,
          pluginId,
          trackId,
          target: 'instrument',
          error: reason,
          underrun: 0,
          bufferMs: 0,
          latencyMs: 0,
          midiEventCount: 0,
          midiDropped: 0,
          activeNotes: 0,
          params: {},
          paramList: [],
        }
      },
      dispose() {
        try {
          output?.disconnect?.()
        } catch {
          /* ignore */
        }
      },
    }
  }
  if (!ctx || typeof ctx.createGain !== 'function') return degradeInstrument('当前环境不支持外部乐器（缺少音频上下文）')
  if (!pluginId) return degradeInstrument('外部乐器缺少 pluginId，已静音')
  if (!options.workletReady) return degradeInstrument('外部乐器实时未就绪（AudioWorklet/桌面 preload 不可用），已静音')
  const AudioWorkletNodeCtor =
    options.AudioWorkletNode ?? (typeof AudioWorkletNode === 'function' ? AudioWorkletNode : null)
  if (!AudioWorkletNodeCtor || !ctx.audioWorklet) return degradeInstrument('当前环境不支持 AudioWorklet，已静音')
  if (typeof SharedArrayBuffer !== 'function') return degradeInstrument('SharedArrayBuffer 不可用（需要桌面环境/跨源隔离），已静音')
  const ring = createExternalInstrumentRing({
    ringFrames: options.ringFrames ?? EXTERNAL_RING_FRAMES,
    channels: options.channels ?? EXTERNAL_CHANNELS,
    midiCapacity: options.midiCapacity ?? EXTERNAL_MIDI_CAPACITY,
  })
  if (!(ring.buffer instanceof SharedArrayBuffer)) return degradeInstrument('无法创建 SharedArrayBuffer ring，已静音')
  let node = null
  try {
    node = new AudioWorkletNodeCtor(ctx, EXTERNAL_PLUGIN_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [ring.channels],
      channelCount: ring.channels,
      channelCountMode: 'explicit',
      processorOptions: {
        sab: ring.buffer,
        ringFrames: ring.ringFrames,
        channels: ring.channels,
        mode: 'instrument',
        instanceId,
      },
    })
  } catch (error) {
    return degradeInstrument(`外部乐器 AudioWorklet 初始化失败：${String(error?.message ?? error)}`)
  }
  const bridge = new ExternalInstrumentBridge({
    ring,
    instanceId,
    pluginId,
    effectId: null,
    trackId,
    target: 'instrument',
    sampleRate: Number(ctx.sampleRate) || 44100,
    maxBlockSize: options.maxBlockSize ?? EXTERNAL_BLOCK_FRAMES,
    pumpIntervalMs: options.pumpIntervalMs,
    paramThrottleMs: options.paramThrottleMs,
    stateBase64: options.stateBase64 ?? track?.vst3?.stateBase64,
    preset: options.preset ?? track?.vst3?.preset,
    getApi: options.getApi ?? (() => getExternalPluginApi()),
    currentTime: () => Number(ctx.currentTime) || 0,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    now: options.now,
    onStatus: options.onStatus,
  })
  bridge.params = { ...(track?.vst3?.params ?? {}) }
  bridge.setBypass(track?.vst3?.bypass === true)
  void bridge.load().then(() => {
    if (!bridge.degraded && !bridge.bypass) bridge.start()
  })
  return {
    output: node,
    node,
    bridge,
    ring,
    degraded: false,
    warning: null,
    trackId,
    pluginId,
    instanceId,
    kind: 'instrument',
    noteOn: (pitch, velocity, timeSec) => bridge.noteOn(pitch, velocity, timeSec),
    noteOff: (pitch, timeSec) => bridge.noteOff(pitch, timeSec),
    panic: (timeSec) => bridge.panic(timeSec),
    cc: (controller, value, timeSec) => bridge.cc(controller, value, timeSec),
    pitchBend: (value, timeSec) => bridge.pitchBend(value, timeSec),
    update(nextTrack) {
      const vst3 = nextTrack?.vst3 && typeof nextTrack.vst3 === 'object' ? nextTrack.vst3 : {}
      bridge.setBypass(vst3.bypass === true)
      void bridge.syncPluginState(vst3)
    },
    status() {
      return bridge.status()
    },
    dispose() {
      bridge.stop()
      void bridge.unload()
      try {
        node.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * 创建一个外部 VST3 效果器节点（链尾约束由 model/normalizeEffects 保证）。
 * @returns {{input:AudioNode,output:AudioNode,node:AudioWorkletNode|null,bridge:ExternalPluginBridge|null,
 *   degraded:boolean,warning:object|null,instanceId:string,pluginId:string,effectId:string,
 *   update(effect:object):void,status():object,dispose():void}}
 */
export function createExternalEffectNode(ctx, effect, options = {}) {
  const vst3 = effect?.vst3 && typeof effect.vst3 === 'object' ? effect.vst3 : {}
  const pluginId = typeof vst3.pluginId === 'string' ? vst3.pluginId : ''
  const effectId = typeof effect?.id === 'string' ? effect.id : ''
  const instanceId = externalInstanceIdForEffect(effect) || (effectId ? `fx:${effectId}` : '')
  const extra = { effectId, pluginId, instanceId }
  if (!ctx || typeof ctx.createGain !== 'function') return degrade(ctx ?? { createGain() {} }, '当前环境不支持外部插件（缺少音频上下文）', options, extra)
  if (!pluginId) return degrade(ctx, '外部插件缺少 pluginId，已直通', options, extra)
  if (!options.workletReady) {
    return degrade(ctx, '外部插件实时效果器未就绪（AudioWorklet/桌面 preload 不可用），已直通', options, extra)
  }
  const AudioWorkletNodeCtor =
    options.AudioWorkletNode ?? (typeof AudioWorkletNode === 'function' ? AudioWorkletNode : null)
  if (!AudioWorkletNodeCtor || !ctx.audioWorklet) {
    return degrade(ctx, '当前环境不支持 AudioWorklet，已直通', options, extra)
  }
  // AudioWorklet 需要 SharedArrayBuffer 与主线程共享 ring；无 SAB 时 worklet 拿到的是
  // 结构化克隆的副本（主线程写入不可见），必须直通而不是静音。
  if (typeof SharedArrayBuffer !== 'function') {
    return degrade(ctx, 'SharedArrayBuffer 不可用（需要桌面环境/跨源隔离），已直通', options, extra)
  }
  const ring = createExternalRingBuffer({
    ringFrames: options.ringFrames ?? EXTERNAL_RING_FRAMES,
    channels: options.channels ?? EXTERNAL_CHANNELS,
  })
  if (!(ring.buffer instanceof SharedArrayBuffer)) {
    return degrade(ctx, '无法创建 SharedArrayBuffer ring，已直通', options, extra)
  }
  let node = null
  try {
    node = new AudioWorkletNodeCtor(ctx, EXTERNAL_PLUGIN_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [ring.channels],
      channelCount: ring.channels,
      channelCountMode: 'explicit',
      processorOptions: {
        sab: ring.buffer,
        ringFrames: ring.ringFrames,
        channels: ring.channels,
        instanceId,
      },
    })
  } catch (error) {
    return degrade(ctx, `外部插件 AudioWorklet 初始化失败：${String(error?.message ?? error)}`, options, extra)
  }
  const bridge = new ExternalPluginBridge({
    ring,
    instanceId,
    pluginId,
    effectId,
    trackId: options.trackId ?? null,
    target: options.target ?? 'track',
    sampleRate: Number(ctx.sampleRate) || 44100,
    maxBlockSize: options.maxBlockSize ?? EXTERNAL_BLOCK_FRAMES,
    pumpIntervalMs: options.pumpIntervalMs,
    paramThrottleMs: options.paramThrottleMs,
    stateBase64: options.stateBase64 ?? vst3.stateBase64,
    preset: options.preset ?? vst3.preset,
    getApi: options.getApi ?? (() => getExternalPluginApi()),
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    now: options.now,
    onStatus: options.onStatus,
  })
  bridge.params = { ...(vst3.params ?? {}) }
  bridge.setBypass(vst3.bypass === true || effect.enabled === false)
  void bridge.load().then(() => {
    if (!bridge.degraded && !bridge.bypass) bridge.start()
  })
  return {
    input: node,
    output: node,
    node,
    bridge,
    ring,
    degraded: false,
    warning: null,
    effectId,
    pluginId,
    instanceId,
    trackId: options.trackId ?? null,
    target: options.target ?? 'track',
    update(nextEffect) {
      const nextVst3 = nextEffect?.vst3 && typeof nextEffect.vst3 === 'object' ? nextEffect.vst3 : {}
      if (nextVst3.pluginId && nextVst3.pluginId !== pluginId) return // 插件替换需重建图（签名变化）
      bridge.setBypass(nextVst3.bypass === true || nextEffect?.enabled === false)
      void bridge.syncPluginState(nextVst3)
    },
    status() {
      return bridge.status()
    },
    dispose() {
      bridge.stop()
      void bridge.unload()
      try {
        node.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * 构建包含外部 VST3 的效果链：内置效果器用 buildFxChain；vst3 按顺序接在链尾。
 * 无 vst3 时等价 buildFxChain（旧行为不变）。
 * @param {BaseAudioContext} ctx
 * @param {Array} effects
 * @param {{workletReady?:boolean, warnings?:Array, externalNodes?:Array, trackId?:string, target?:string,
 *   getApi?:Function, AudioWorkletNode?:Function, ringFrames?:number, channels?:number}} [options]
 */
export function buildFxChainWithExternal(ctx, effects, options = {}) {
  const list = Array.isArray(effects) ? effects : []
  const builtIn = list.filter((effect) => effect && effect.type !== 'vst3')
  const externalEffects = list.filter((effect) => effect && effect.type === 'vst3')
  if (externalEffects.length === 0) return buildFxChain(ctx, builtIn)
  const chain = buildFxChain(ctx, builtIn)
  const externalNodes = []
  let tail = chain.output
  for (const effect of externalEffects) {
    const externalNode = createExternalEffectNode(ctx, effect, { ...options, trackId: options.trackId })
    tail.connect(externalNode.input)
    tail = externalNode.output
    externalNodes.push(externalNode)
    if (Array.isArray(options.externalNodes)) options.externalNodes.push(externalNode)
  }
  const output = ctx.createGain()
  tail.connect(output)
  const byId = new Map(externalNodes.map((node) => [node.effectId, node]))
  return {
    input: chain.input,
    output,
    effects: chain.effects,
    list: chain.list,
    externalNodes,
    update(nextEffects) {
      chain.update((Array.isArray(nextEffects) ? nextEffects : []).filter((effect) => effect && effect.type !== 'vst3'))
      const effectById = new Map(
        (Array.isArray(nextEffects) ? nextEffects : []).filter((effect) => effect && effect.type === 'vst3').map((effect) => [effect.id, effect]),
      )
      for (const [id, node] of byId) {
        const nextEffect = effectById.get(id)
        if (!nextEffect) continue
        node.update(nextEffect)
      }
    },
    dispose() {
      for (const node of externalNodes) {
        try {
          node.dispose()
        } catch {
          /* ignore */
        }
      }
      try {
        chain.dispose()
      } catch {
        /* ignore */
      }
      try {
        output.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}
