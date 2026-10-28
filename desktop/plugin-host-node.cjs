/**
 * VST3 宿主（独立 Node sidecar，M0/M2 多实例）。
 * 协议：stdin/stdout 行分隔 JSON；音频帧用 base64 Float32 planar（JSON lines 便于嵌入）。
 *
 * M2 多实例：instances: Map<instanceId,{host,plugin,info}>
 * - loadInstance {instanceId,path,sampleRate,maxBlockSize,audioInputs,audioOutputs}
 * - unloadInstance / processInstance / setInstanceParam / getInstanceParams / saveInstanceState / listInstances
 * 兼容 M0/M1 单实例命令（load/process/setParam/... 映射到 __legacy__ 实例）。
 * 约束：每 sidecar 最多 8 个实例；错误中文；未加载中文错误。
 */
'use strict'

const readline = require('node:readline')
const fs = require('node:fs')
const path = require('node:path')

const MAX_INSTANCES = 8
const LEGACY_INSTANCE_ID = '__legacy__'

let native = null
let loadError = null
/** @type {Map<string,{host:any,plugin:any,info:any,path:string,sampleRate:number,maxBlockSize:number,audioInputs:number,audioOutputs:number,loadedAt:number}>} */
const instances = new Map()

/**
 * 把 .vst3 bundle 目录解析为可加载的二进制文件（nvst3 需要文件路径）；
 * E2E/M0 直接给 fixture bundle 目录时也能工作。文件原样返回。
 */
function resolveBinaryPath(rawTarget) {
  const target = String(rawTarget ?? '').trim()
  if (!target) throw new Error('缺少插件路径')
  const resolved = path.resolve(target)
  let stat
  try { stat = fs.statSync(resolved) } catch { throw new Error(`插件路径不存在：${resolved}`) }
  if (stat.isFile()) return resolved
  if (!stat.isDirectory()) throw new Error(`插件路径不是文件/目录：${resolved}`)
  const platformDirs = process.platform === 'win32'
    ? ['x86_64-win', 'x86-win']
    : process.platform === 'darwin' ? ['MacOS'] : ['x86_64-linux', 'aarch64-linux']
  for (const platformDir of platformDirs) {
    const dir = path.join(resolved, 'Contents', platformDir)
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.toLowerCase().endsWith('.vst3')) {
          const candidate = path.join(dir, name)
          if (fs.statSync(candidate).isFile()) return candidate
        }
      }
    } catch { /* 尝试下一个平台目录 */ }
  }
  function find(dir, depth) {
    if (depth > 4) return null
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.vst3')) return full
      if (entry.isDirectory()) {
        const nested = find(full, depth + 1)
        if (nested) return nested
      }
    }
    return null
  }
  const fallback = find(resolved, 0)
  if (fallback) return fallback
  throw new Error(`无法在 .vst3 bundle 中找到二进制：${resolved}`)
}

function loadNative() {
  if (native || loadError) return
  // M5：asar 外 sidecar 的 native 模块解析：优先 __dirname 同目录/资源目录，最后才走 NODE_PATH。
  const candidates = [
    process.env.AIMS_NVST3_HOST_PATH,
    path.join(__dirname, 'nvst3-host', 'index.js'),
    path.join(__dirname, 'nvst3-host'),
    path.join(__dirname, 'node_modules', 'nvst3-host'),
    path.join(__dirname, '..', 'node_modules', 'nvst3-host'),
    process.resourcesPath ? path.join(process.resourcesPath, 'native', 'nvst3-host') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'native', 'node_modules', 'nvst3-host') : null,
    'nvst3-host',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      native = require(candidate)
      loadError = null
      return
    } catch (error) {
      loadError = error
    }
  }
}

function respond(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function encodeFloat32(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64')
}

function decodeFloat32(base64) {
  const buffer = Buffer.from(base64, 'base64')
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
}

function requireInstanceId(raw) {
  const instanceId = typeof raw === 'string' ? raw.trim() : ''
  if (instanceId === '' || instanceId.length > 80) throw new Error('instanceId 非法（需 1..80 字符）')
  return instanceId
}

function infoOf(instance) {
  return {
    plugin: instance.plugin.getInfo(),
    latencySamples: instance.plugin.getLatency?.() ?? 0,
    host: instance.host.getOptions?.() ?? {},
    sampleRate: instance.sampleRate,
    maxBlockSize: instance.maxBlockSize,
    audioInputs: instance.audioInputs,
    audioOutputs: instance.audioOutputs,
    kind: instance.kind,
    midiInputs: instance.midiInputs ?? 0,
    loadedAt: instance.loadedAt,
  }
}

function disposeInstance(instanceId) {
  const instance = instances.get(instanceId)
  if (!instance) return false
  try { instance.plugin.dispose() } catch { /* ignore */ }
  instances.delete(instanceId)
  return true
}

function createInstance(instanceId, payload = {}) {
  if (!instances.has(instanceId) && instances.size >= MAX_INSTANCES) {
    throw new Error(`实例数量已达上限 ${MAX_INSTANCES}；请先 unloadInstance`)
  }
  if (instances.has(instanceId)) disposeInstance(instanceId)
  const rawKind = payload?.kind === undefined || payload?.kind === null ? '' : String(payload.kind)
  if (rawKind !== '' && rawKind !== 'instrument' && rawKind !== 'effect') throw new Error("kind 必须是 'instrument' 或 'effect'")
  const kind = rawKind === 'instrument'
    ? 'instrument'
    : rawKind === 'effect'
      ? 'effect'
      : (Number(payload?.audioInputs) === 0 ? 'instrument' : 'effect')
  const sampleRate = Number(payload?.sampleRate ?? 48000)
  const maxBlockSize = Number(payload?.maxBlockSize ?? 256)
  const audioInputs = Number(payload?.audioInputs ?? (kind === 'instrument' ? 0 : 2))
  const audioOutputs = Number(payload?.audioOutputs ?? 2)
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('sampleRate 必须在 8000..192000')
  if (!Number.isInteger(maxBlockSize) || maxBlockSize < 16 || maxBlockSize > 4096) throw new Error('maxBlockSize 必须在 16..4096')
  if (!Number.isInteger(audioInputs) || audioInputs < 0 || audioInputs > 16) throw new Error('audioInputs 必须在 0..16')
  if (!Number.isInteger(audioOutputs) || audioOutputs < 1 || audioOutputs > 16) throw new Error('audioOutputs 必须在 1..16')
  const target = resolveBinaryPath(payload?.path)
  const host = new native.Host({
    sampleRate,
    maxBlockSize,
    audioInputs,
    audioOutputs,
    processMode: payload?.processMode ?? 'realtime',
  })
  const plugin = host.load(target)
  plugin.setActive(true)
  plugin.setProcessing(true)
  const pluginInfo = plugin.getInfo()
  const midiInputs = Number(pluginInfo?.numMidiInputs ?? 0) || 0
  const isInstrumentPlugin = midiInputs > 0
    || /instrument/i.test(String(pluginInfo?.category ?? ''))
    || /instrument/i.test(String(pluginInfo?.subCategories ?? ''))
  if (kind === 'instrument' && !isInstrumentPlugin) {
    try { plugin.dispose() } catch { /* ignore */ }
    throw new Error(`插件不是 MIDI 乐器（numMidiInputs=${midiInputs} category=${pluginInfo?.category ?? ''}）；不能按 kind='instrument' 加载`)
  }
  if (kind === 'effect' && isInstrumentPlugin) {
    try { plugin.dispose() } catch { /* ignore */ }
    throw new Error(`插件是乐器（numMidiInputs=${midiInputs}）；不能按 kind='effect' 加载`)
  }
  const instance = {
    host,
    plugin,
    info: null,
    path: target,
    kind,
    midiInputs,
    midiEventCount: 0,
    sampleRate,
    maxBlockSize,
    audioInputs,
    audioOutputs,
    loadedAt: Date.now(),
  }
  instance.info = infoOf(instance)
  instances.set(instanceId, instance)
  return instance
}

function getInstance(raw) {
  const instanceId = requireInstanceId(raw)
  const instance = instances.get(instanceId)
  if (!instance) throw new Error(`插件实例未加载：${instanceId}`)
  return { instanceId, instance }
}

function parameterList(plugin, payload = {}) {
  const count = plugin.getParameterCount()
  const offset = Math.max(0, Math.min(count, Number(payload?.offset ?? 0) || 0))
  const limit = Math.max(1, Math.min(count - offset, Number(payload?.limit ?? count) || count))
  const items = []
  for (let index = offset; index < offset + limit; index += 1) {
    const info = plugin.getParameterInfo(index)
    const id = Number(info?.id)
    let value = Number.isFinite(id) ? plugin.getParameter(id) : null
    let formatted = null
    try { formatted = plugin.formatParameter(id, value) } catch { formatted = null }
    items.push({ index, ...info, id, value, formatted })
  }
  return { count, offset, items }
}

/** v2.3 P1：读取插件 IUnitInfo 的 program lists/programs。 */
function programSnapshot(plugin) {
  const listCount = typeof plugin.getProgramListCount === 'function' ? Number(plugin.getProgramListCount()) || 0 : 0
  const lists = []
  const presets = []
  for (let listIndex = 0; listIndex < Math.min(listCount, 64); listIndex += 1) {
    let info
    try { info = plugin.getProgramListInfo(listIndex) } catch { continue }
    if (!info) continue
    const listId = Number(info.id)
    const count = Math.max(0, Number(info.programCount) || 0)
    const programs = []
    for (let index = 0; index < Math.min(count, 4096); index += 1) {
      let name = ''
      try { name = String(plugin.getProgramName(listId, index) ?? '') } catch { name = '' }
      programs.push({ index, name, programName: name })
      presets.push({ listId, listIndex, index, name, programName: name, listName: String(info.name ?? '') })
    }
    let unitId = null
    try {
      const unitCount = typeof plugin.getUnitCount === 'function' ? Number(plugin.getUnitCount()) || 0 : 0
      for (let unitIndex = 0; unitIndex < unitCount; unitIndex += 1) {
        const unit = plugin.getUnitInfo(unitIndex)
        if (Number(unit?.programListId) === listId) { unitId = Number(unit.id); break }
      }
    } catch { unitId = null }
    lists.push({ listId, listIndex, name: String(info.name ?? ''), programCount: count, unitId, programs })
  }
  return { lists, presets }
}

/** v2.3 P1：选择 program；selectProgram 需要 unitId（programListId 所属 unit）。 */
function selectProgramOnPlugin(plugin, listIdRaw, indexRaw) {
  const listId = Number(listIdRaw)
  const index = Number(indexRaw)
  if (!Number.isFinite(listId) || listId < 0) throw new Error('listId 必须是非负整数')
  if (!Number.isInteger(index) || index < 0) throw new Error('index 必须是非负整数')
  const snapshot = programSnapshot(plugin)
  const list = snapshot.lists.find((item) => item.listId === listId) || snapshot.lists.find((item) => item.listIndex === listId)
  if (!list) throw new Error(`program list 不存在：${listId}`)
  if (index >= list.programCount) throw new Error(`program index 越界：${index}（0..${list.programCount - 1}）`)
  const unitId = Number.isFinite(Number(list.unitId)) ? Number(list.unitId) : 0
  try {
    plugin.selectProgram(unitId, index)
  } catch (error) {
    // 部分插件（如 TAL-Reverb）IUnitInfo 暴露 1 个 program 列表但 selectUnit(root) 返回 false；
    // 单 program 列表且选 index 0 时视为“已选中”，继续读取当前参数/state。
    const selectUnitFailed = /selectUnit failed/i.test(String(error?.message ?? error))
    if (!(selectUnitFailed && list.programCount === 1 && index === 0)) throw error
  }
  const preset = { listId: list.listId, index, name: list.programs[index]?.name ?? '' }
  return { listId: list.listId, index, unitId, preset, params: parameterList(plugin), stateBase64: plugin.saveState().toString('base64') }
}

/** v2.2 M3：把高层 MIDI 事件转成插件 addMidiBytes 需要的 bytes。 */
function midiEventsToBytes(events) {
  const out = []
  for (const raw of Array.isArray(events) ? events : []) {
    if (raw === null || typeof raw !== 'object') continue
    const channel = Number.isInteger(Number(raw.channel)) ? Math.max(0, Math.min(15, Number(raw.channel))) : 0
    const sampleOffset = Math.max(0, Math.floor(Number(raw.sampleOffset ?? 0) || 0))
    if (Array.isArray(raw.bytes)) {
      out.push({ sampleOffset, bytes: Uint8Array.from(raw.bytes) })
      continue
    }
    const type = String(raw.type ?? '')
    if (type === 'noteOn' || type === 'noteOff') {
      const pitch = Math.max(0, Math.min(127, Math.round(Number(raw.pitch ?? 60))))
      const rawVelocity = Number(raw.velocity ?? (type === 'noteOn' ? 0.8 : 0))
      const velocity = type === 'noteOff'
        ? 0
        : (rawVelocity >= 0 && rawVelocity <= 1
            ? Math.max(1, Math.min(127, Math.round(rawVelocity * 127)))
            : Math.max(1, Math.min(127, Math.round(rawVelocity))))
      out.push({ sampleOffset, bytes: Uint8Array.from([(type === 'noteOn' ? 0x90 : 0x80) | channel, pitch, velocity]) })
      continue
    }
    if (type === 'cc') {
      const controller = Math.max(0, Math.min(127, Math.round(Number(raw.controller ?? raw.cc ?? 0))))
      const value = Math.max(0, Math.min(127, Math.round(Number(raw.value ?? 0))))
      out.push({ sampleOffset, bytes: Uint8Array.from([0xb0 | channel, controller, value]) })
      continue
    }
    if (type === 'pitchBend') {
      const numeric = Number(raw.value ?? 0)
      let bend
      if (numeric >= -1 && numeric <= 1) bend = Math.round(((numeric + 1) / 2) * 16383)
      else bend = Math.round(numeric)
      bend = Math.max(0, Math.min(16383, bend))
      out.push({ sampleOffset, bytes: Uint8Array.from([0xe0 | channel, bend & 0x7f, (bend >> 7) & 0x7f]) })
    }
  }
  return out
}

function processInstance(instance, payload = {}) {
  const numSamples = Number(payload?.numSamples ?? 0)
  if (!Number.isInteger(numSamples) || numSamples <= 0 || numSamples > instance.maxBlockSize) {
    throw new Error(`numSamples 必须为 1..maxBlockSize（${instance.maxBlockSize}）`)
  }
  const inputs = Array.isArray(payload?.inputs) ? payload.inputs.map(decodeFloat32) : []
  if (inputs.length > instance.audioInputs) throw new Error(`inputs 通道数超过实例 audioInputs=${instance.audioInputs}`)
  for (const input of inputs) {
    if (input.length !== numSamples) throw new Error(`inputs 每通道长度必须是 numSamples=${numSamples}`)
  }
  const outputs = Array.from({ length: instance.audioOutputs }, () => new Float32Array(numSamples))
  const midiEvents = midiEventsToBytes(payload?.midi)
  for (const event of midiEvents) instance.plugin.addMidiBytes(event.sampleOffset, event.bytes)
  if (midiEvents.length > 0) instance.midiEventCount = (instance.midiEventCount ?? 0) + midiEvents.length
  const started = Date.now()
  instance.plugin.process({ inputs, outputs, numSamples })
  return {
    instanceId: payload?.instanceId ?? null,
    ms: Date.now() - started,
    sampleRate: instance.sampleRate,
    numSamples,
    outputs: outputs.map(encodeFloat32),
    outputEvents: instance.plugin.takeOutputEvents?.() ?? [],
    midiEventCount: midiEvents.length,
  }
}

/** v2.2 M4：16-bit PCM stereo WAV writer（离线冻结用，避免大 JSON 返回）。 */
function writePcm16Wav(filePath, channels, sampleRate) {
  const frames = channels[0]?.length ?? 0
  const channelCount = channels.length
  const dataBytes = frames * channelCount * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channelCount, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channelCount * 2, 28)
  buffer.writeUInt16LE(channelCount * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  let offset = 44
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = Math.max(-1, Math.min(1, Number(channels[channel][frame]) || 0))
      buffer.writeInt16LE(Math.round(value * 32767), offset)
      offset += 2
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, buffer)
  return { bytes: buffer.length, frames, channels: channelCount, sampleRate }
}

/** v2.2 M4：离线渲染（instrument 用 MIDI events，effect 用 inputPcm；不进入实例表/实时路径）。 */
function renderOffline(payload = {}) {
  const rawKind = String(payload?.kind ?? '')
  if (rawKind !== 'instrument' && rawKind !== 'effect') throw new Error("renderOffline kind 必须是 'instrument' 或 'effect'")
  const target = resolveBinaryPath(payload?.pluginPath)
  const sampleRate = Number(payload?.sampleRate ?? 48000)
  const maxBlockSize = Math.max(16, Math.min(4096, Number(payload?.maxBlockSize ?? 256) || 256))
  const frames = Math.floor(Number(payload?.frames ?? 0))
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('renderOffline sampleRate 必须在 8000..192000')
  if (!Number.isInteger(frames) || frames <= 0 || frames > sampleRate * 900) throw new Error('renderOffline frames 必须在 1..900 秒')
  const audioInputs = rawKind === 'effect' ? 2 : 0
  const audioOutputs = 2
  const outputPath = String(payload?.outputPath ?? '').trim()
  if (!outputPath || !/\.wav$/i.test(outputPath)) throw new Error('renderOffline 需要 .wav outputPath')
  const host = new native.Host({ sampleRate, maxBlockSize, audioInputs, audioOutputs, processMode: 'offline' })
  let plugin = null
  try {
    plugin = host.load(target)
    plugin.setActive(true)
    plugin.setProcessing(true)
    if (typeof payload?.stateBase64 === 'string' && payload.stateBase64 !== '') {
      plugin.loadState(Buffer.from(payload.stateBase64, 'base64'))
    }
    const params = payload?.params && typeof payload.params === 'object' ? payload.params : {}
    for (const [rawId, rawValue] of Object.entries(params)) {
      const id = Number(rawId)
      const value = Number(rawValue)
      if (Number.isFinite(id) && Number.isFinite(value)) plugin.setParameter(id, Math.max(0, Math.min(1, value)))
    }
    const events = Array.isArray(payload?.events) ? payload.events : []
    const eventBytes = events.map((event) => {
      const frame = Math.max(0, Math.min(frames - 1, Math.floor(Number(event?.frame ?? event?.startFrame ?? 0) || 0)))
      const one = midiEventsToBytes([{ ...event, sampleOffset: 0 }])[0]
      return one ? { frame, bytes: one.bytes } : null
    }).filter(Boolean)
    const rawInputs = Array.isArray(payload?.inputPcm) ? payload.inputPcm.map(decodeFloat32) : []
    if (rawKind === 'effect' && rawInputs.length === 0) throw new Error('renderOffline effect 需要 inputPcm（干声通道数组）')
    const outputChannels = Array.from({ length: audioOutputs }, () => new Float32Array(frames))
    let eventIndex = 0
    for (let offset = 0; offset < frames; offset += maxBlockSize) {
      const numSamples = Math.min(maxBlockSize, frames - offset)
      const inputs = rawInputs.length > 0
        ? rawInputs.map((channel) => channel.subarray(offset, offset + numSamples))
        : []
      const outputs = Array.from({ length: audioOutputs }, () => new Float32Array(numSamples))
      while (eventIndex < eventBytes.length && eventBytes[eventIndex].frame < offset + numSamples) {
        const event = eventBytes[eventIndex]
        if (event.frame >= offset) plugin.addMidiBytes(event.frame - offset, event.bytes)
        eventIndex += 1
      }
      plugin.process({ inputs, outputs, numSamples })
      for (let channel = 0; channel < audioOutputs; channel += 1) outputChannels[channel].set(outputs[channel], offset)
    }
    const wav = writePcm16Wav(outputPath, outputChannels, sampleRate)
    let peak = 0
    let sum = 0
    let count = 0
    for (const channel of outputChannels) {
      for (const sample of channel) {
        const abs = Math.abs(sample)
        if (abs > peak) peak = abs
        sum += sample * sample
        count += 1
      }
    }
    const stateBase64 = payload?.saveState === false ? null : plugin.saveState().toString('base64')
    return {
      path: outputPath,
      bytes: wav.bytes,
      frames,
      sampleRate,
      channels: audioOutputs,
      durationSeconds: frames / sampleRate,
      peak: Number(peak.toFixed(6)),
      rms: Number(Math.sqrt(count > 0 ? sum / count : 0).toFixed(6)),
      latencySamples: plugin.getLatency?.() ?? 0,
      stateBase64,
    }
  } finally {
    try { plugin?.dispose?.() } catch { /* ignore */ }
    try { host.dispose?.() } catch { /* ignore */ }
  }
}

function handle(message) {
  const { id, type, payload } = message ?? {}
  try {
    loadNative()
    if (loadError) throw loadError
    if (type === 'ping') {
      return respond({ id, ok: true, result: { pid: process.pid, node: process.versions.node, nvst3: native.version ?? null, instances: instances.size, maxInstances: MAX_INSTANCES } })
    }
    if (type === 'scan') {
      const defaultItems = native.Host.scanDefaultLocations()
      const extra = []
      for (const dir of payload?.dirs ?? []) {
        try { extra.push(...native.Host.scanDirectory(String(dir))) } catch (error) { extra.push({ path: String(dir), error: String(error?.message ?? error) }) }
      }
      return respond({ id, ok: true, result: { defaultCount: defaultItems.length, items: [...defaultItems, ...extra] } })
    }
    if (type === 'inspect') {
      const target = resolveBinaryPath(payload?.path)
      return respond({ id, ok: true, result: native.Host.inspectPlugin(target) })
    }

    /* ── M2：多实例协议 ─────────────────────────────────────────── */
    if (type === 'renderOffline') {
      return respond({ id, ok: true, result: renderOffline(payload) })
    }
    if (type === 'loadInstance') {
      const instanceId = requireInstanceId(payload?.instanceId)
      const instance = createInstance(instanceId, payload)
      return respond({ id, ok: true, result: { instanceId, ...instance.info } })
    }
    if (type === 'unloadInstance') {
      const instanceId = requireInstanceId(payload?.instanceId)
      const removed = disposeInstance(instanceId)
      if (!removed) throw new Error(`插件实例未加载：${instanceId}`)
      return respond({ id, ok: true, result: { instanceId, unloaded: true } })
    }
    if (type === 'processInstance') {
      const { instanceId, instance } = getInstance(payload?.instanceId)
      return respond({ id, ok: true, result: { ...processInstance(instance, payload), instanceId } })
    }
    if (type === 'setInstanceParam') {
      const { instanceId, instance } = getInstance(payload?.instanceId)
      const paramId = Number(payload?.paramId)
      const value = Number(payload?.value)
      if (!Number.isFinite(paramId)) throw new Error('paramId 必须是数字')
      if (!Number.isFinite(value)) throw new Error('value 必须是数字')
      instance.plugin.setParameter(paramId, value)
      return respond({ id, ok: true, result: { instanceId, paramId, value } })
    }
    if (type === 'getInstanceParams') {
      const { instanceId, instance } = getInstance(payload?.instanceId)
      return respond({ id, ok: true, result: { instanceId, ...parameterList(instance.plugin, payload) } })
    }
    if (type === 'saveInstanceState') {
      const { instanceId, instance } = getInstance(payload?.instanceId)
      return respond({ id, ok: true, result: { instanceId, state: instance.plugin.saveState().toString('base64') } })
    }
    if (type === 'loadInstanceState') {
      const { instanceId, instance } = getInstance(payload?.instanceId)
      instance.plugin.loadState(Buffer.from(String(payload?.state ?? ''), 'base64'))
      return respond({ id, ok: true, result: { instanceId, loaded: true } })
    }
    if (type === 'listPrograms') {
      const target = payload?.instanceId ? getInstance(payload.instanceId) : getInstance(LEGACY_INSTANCE_ID)
      return respond({ id, ok: true, result: { instanceId: target.instanceId, ...programSnapshot(target.instance.plugin) } })
    }
    if (type === 'selectProgram') {
      const target = payload?.instanceId ? getInstance(payload.instanceId) : getInstance(LEGACY_INSTANCE_ID)
      return respond({ id, ok: true, result: { instanceId: target.instanceId, ...selectProgramOnPlugin(target.instance.plugin, payload?.listId, payload?.index) } })
    }
    if (type === 'listInstances') {
      const items = [...instances.entries()].map(([instanceId, instance]) => ({
        instanceId,
        path: instance.path,
        sampleRate: instance.sampleRate,
        maxBlockSize: instance.maxBlockSize,
        audioInputs: instance.audioInputs,
        audioOutputs: instance.audioOutputs,
        kind: instance.kind,
        midiInputs: instance.midiInputs ?? 0,
        midiEventCount: instance.midiEventCount ?? 0,
        latencySamples: instance.plugin.getLatency?.() ?? 0,
        loadedAt: instance.loadedAt,
      }))
      return respond({ id, ok: true, result: { count: items.length, maxInstances: MAX_INSTANCES, instances: items } })
    }

    /* ── M0/M1 兼容：单实例命令映射到 __legacy__ ───────────────── */
    if (type === 'load') {
      const instance = createInstance(LEGACY_INSTANCE_ID, payload)
      return respond({ id, ok: true, result: { ...instance.info, params: instance.plugin.getParameterTree?.() ?? [] } })
    }
    if (type === 'process') {
      const { instance } = getInstance(LEGACY_INSTANCE_ID)
      const outputs = Array.isArray(payload?.outputs) ? payload.outputs.map(decodeFloat32) : []
      if (outputs.length === 0) throw new Error('缺少 outputs 录音缓冲')
      const numSamples = Number(payload?.numSamples ?? 0)
      if (!Number.isInteger(numSamples) || numSamples <= 0 || numSamples > 4096) throw new Error('numSamples 必须 1..4096')
      const inputs = Array.isArray(payload?.inputs) ? payload.inputs.map(decodeFloat32) : []
      for (const event of payload?.midi ?? []) {
        if (event?.bytes) instance.plugin.addMidiBytes(Number(event.sampleOffset ?? 0), Uint8Array.from(event.bytes))
      }
      const started = Date.now()
      instance.plugin.process({ inputs, outputs, numSamples })
      return respond({ id, ok: true, result: { ms: Date.now() - started, outputs: outputs.map(encodeFloat32), outputEvents: instance.plugin.takeOutputEvents?.() ?? [] } })
    }
    if (type === 'setParam') {
      const { instance } = getInstance(LEGACY_INSTANCE_ID)
      instance.plugin.setParameter(Number(payload?.paramId), Number(payload?.value))
      return respond({ id, ok: true, result: { paramId: payload?.paramId, value: payload?.value } })
    }
    if (type === 'getParams') {
      const { instance } = getInstance(LEGACY_INSTANCE_ID)
      return respond({ id, ok: true, result: instance.plugin.getParameterTree?.() ?? [] })
    }
    if (type === 'getParameterCount' || type === 'getParameterInfo' || type === 'getParamsList' || type === 'getParam') {
      const { instance } = getInstance(LEGACY_INSTANCE_ID)
      const plugin = instance.plugin
      if (type === 'getParameterCount') return respond({ id, ok: true, result: { count: plugin.getParameterCount() } })
      if (type === 'getParameterInfo') {
        const index = Number(payload?.index)
        const count = plugin.getParameterCount()
        if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error(`参数索引越界：${String(payload?.index)}（0..${count - 1}）`)
        const info = plugin.getParameterInfo(index)
        const value = Number.isFinite(Number(info?.id)) ? plugin.getParameter(Number(info.id)) : null
        let formatted = null
        try { formatted = plugin.formatParameter(Number(info?.id), value) } catch { formatted = null }
        return respond({ id, ok: true, result: { index, info, value, formatted } })
      }
      if (type === 'getParamsList') return respond({ id, ok: true, result: parameterList(plugin, payload) })
      const paramId = Number(payload?.paramId)
      if (!Number.isFinite(paramId)) throw new Error('paramId 必须是数字')
      return respond({ id, ok: true, result: { paramId, value: plugin.getParameter(paramId) } })
    }
    if (type === 'getProgramListCount') {
      const { instance } = getInstance(LEGACY_INSTANCE_ID)
      return respond({ id, ok: true, result: { count: typeof instance.plugin.getProgramListCount === 'function' ? instance.plugin.getProgramListCount() : 0 } })
    }
    if (type === 'listProgramsLegacy') {
      const { instance } = getInstance(LEGACY_INSTANCE_ID)
      return respond({ id, ok: true, result: programSnapshot(instance.plugin) })
    }
    if (type === 'saveState') {
      const { instance } = getInstance(LEGACY_INSTANCE_ID)
      return respond({ id, ok: true, result: { state: instance.plugin.saveState().toString('base64') } })
    }
    if (type === 'loadState') {
      const { instance } = getInstance(LEGACY_INSTANCE_ID)
      instance.plugin.loadState(Buffer.from(String(payload?.state ?? ''), 'base64'))
      return respond({ id, ok: true, result: { loaded: true } })
    }
    if (type === 'unload') {
      const removed = disposeInstance(LEGACY_INSTANCE_ID)
      return respond({ id, ok: true, result: { unloaded: removed } })
    }
    throw new Error(`未知消息 type=${type}`)
  } catch (error) {
    respond({ id, ok: false, error: String(error?.message ?? error), code: error?.code ?? null })
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try { handle(JSON.parse(line)) } catch (error) { respond({ id: null, ok: false, error: `无效 JSON：${error.message}` }) }
})
process.stdout.write(`${JSON.stringify({ type: 'ready', pid: process.pid, node: process.versions.node, maxInstances: MAX_INSTANCES })}\n`)
