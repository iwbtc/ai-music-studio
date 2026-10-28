/**
 * v2.2 M1：插件服务（registry + Node sidecar 的高层门面）。
 *
 * M1 做管理/参数读取/参数试写；M2 增加多实例实时处理（loadInstance/processInstance/...）。
 */
import path from 'node:path'
import { createPluginHostClient, resolveNodeBin, PluginHostError } from './plugin-host-client.js'
import {
  PluginRegistryError,
  getPluginEntry,
  installPlugin,
  listPlugins,
  scanPlugins,
  uninstallPlugin,
  resolveVst3BinaryPath,
} from './plugin-registry.js'

function toBase64Float32(arrayLike) {
  const array = arrayLike instanceof Float32Array ? arrayLike : Float32Array.from(arrayLike ?? [])
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64')
}

function fromBase64Float32(base64) {
  const buffer = Buffer.from(String(base64 ?? ''), 'base64')
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  return new Float32Array(copy)
}

function roundMs(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 1000) / 1000 : null
}

function pluginTarget(entry) {
  if (!entry) throw new PluginRegistryError('插件不存在', 'PLUGIN_NOT_FOUND')
  const target = entry.managedPath ?? entry.path
  if (typeof target !== 'string' || target === '') throw new PluginRegistryError(`插件 ${entry.pluginId} 缺少可用路径`, 'PLUGIN_NOT_FOUND')
  return target
}

function normalizeParameter(item, indexFallback = 0) {
  const index = Number.isInteger(Number(item?.index)) ? Number(item.index) : indexFallback
  const id = Number.isFinite(Number(item?.id)) ? Number(item.id) : index
  const title = typeof item?.title === 'string' && item.title.trim() !== '' ? item.title.trim() : `参数 ${index}`
  const value = Number.isFinite(Number(item?.value)) ? Math.max(0, Math.min(1, Number(item.value))) : 0
  const def = Number.isFinite(Number(item?.defaultNormalizedValue))
    ? Math.max(0, Math.min(1, Number(item.defaultNormalizedValue)))
    : Number.isFinite(Number(item?.default)) ? Math.max(0, Math.min(1, Number(item.default))) : 0
  return {
    index,
    id,
    name: title,
    label: typeof item?.shortTitle === 'string' && item.shortTitle.trim() !== '' ? item.shortTitle.trim() : title,
    unit: typeof item?.units === 'string' ? item.units : '',
    min: 0,
    max: 1,
    default: def,
    value,
    ...(typeof item?.formatted === 'string' && item.formatted !== '' ? { formatted: item.formatted } : {}),
    ...(Number.isFinite(Number(item?.stepCount)) ? { stepCount: Number(item.stepCount) } : {}),
  }
}

/**
 * 创建插件服务（每个 Host 进程一个；lazy 启动 sidecar）。
 * @param {{dataDir:string, client?:object, env?:object, nodeBin?:string}} options
 */
/** 每个 dataDir 共享一个 service（tools/routes 共用 sidecar，避免多进程同时锁同一 .vst3）。 */
const sharedPluginServices = new Map()
export function getSharedPluginService(dataDir) {
  const key = path.resolve(String(dataDir ?? ''))
  if (!sharedPluginServices.has(key)) sharedPluginServices.set(key, createPluginService({ dataDir: key }))
  return sharedPluginServices.get(key)
}

export async function closeSharedPluginServices() {
  for (const service of sharedPluginServices.values()) await service.close().catch(() => {})
  sharedPluginServices.clear()
}

function StateBytes(value) { return Buffer.byteLength(String(value ?? ''), 'utf8') }

export function createPluginService(options = {}) {
  const dataDir = String(options.dataDir ?? '')
  let client = options.client ?? null
  let loadedPluginId = null
  const parametersCache = new Map()
  /** v2.3 P1：pluginId → program/preset 列表缓存（install/uninstall 时清空）。 */
  const presetsCache = new Map()
  /** M2：instanceId → 实例元信息（侧车进程内真实实例由 sidecar 持有）。 */
  const instances = new Map()

  const ensureClient = () => {
    if (!client) client = createPluginHostClient({ nodeBin: options.nodeBin, env: options.env })
    return client
  }

  const status = () => {
    try {
      const node = resolveNodeBin({ nodeBin: options.nodeBin, env: options.env })
      return {
        available: true,
        node,
        started: Boolean(loadedPluginId || instances.size > 0),
        loadedPluginId,
        instances: instances.size,
        maxInstances: 8,
      }
    } catch (error) {
      return {
        available: false,
        node: null,
        started: instances.size > 0,
        instances: instances.size,
        error: String(error?.message ?? error),
        code: error?.code ?? 'PLUGIN_HOST_UNAVAILABLE',
      }
    }
  }

  /** 重新安装/卸载前释放 sidecar 对托管 .vst3 的实例句柄（Windows 文件锁）。 */
  const releaseInstances = async (predicate = () => true) => {
    if (!client) return 0
    let released = 0
    for (const [instanceId, meta] of [...instances.entries()]) {
      if (!predicate(meta)) continue
      await client.unloadInstance(instanceId).catch(() => {})
      instances.delete(instanceId)
      released += 1
    }
    return released
  }

  const ensureLoaded = async (entry) => {
    const target = await resolveVst3BinaryPath(pluginTarget(entry))
    const active = ensureClient()
    if (loadedPluginId !== entry.pluginId) {
      // M3：parameters/setParam 也按 registry 的 instrument/effect 选择正确加载模式。
      await active.load(target, entry.isInstrument
        ? { kind: 'instrument', audioInputs: 0, audioOutputs: 2 }
        : { kind: 'effect', audioInputs: 2, audioOutputs: 2 })
      loadedPluginId = entry.pluginId
    }
    return active
  }

  return {
    status,
    get client() { return client },

    async scan({ dirs = [], includeDefaults = true } = {}) {
      const active = ensureClient()
      return scanPlugins({ dataDir, client: active, dirs, includeDefaults })
    },

    async list() {
      return listPlugins(dataDir)
    },

    async install({ path: sourcePath } = {}) {
      const active = ensureClient()
      // 重新安装/覆盖托管副本前释放所有 sidecar 实例/文件锁（Windows EPERM）。
      await releaseInstances()
      if (loadedPluginId !== null) {
        await active.unload().catch(() => {})
        loadedPluginId = null
      }
      parametersCache.clear()
      presetsCache.clear()
      return installPlugin({ dataDir, client: active, sourcePath })
    },

    async uninstall(pluginId) {
      await releaseInstances((meta) => meta.pluginId === pluginId)
      if (client && loadedPluginId === pluginId) {
        await client.unload().catch(() => {})
        loadedPluginId = null
      }
      parametersCache.clear()
      presetsCache.clear()
      return uninstallPlugin(dataDir, pluginId)
    },

    async getPlugin(pluginId) {
      const entry = await getPluginEntry(dataDir, pluginId)
      if (!entry) return null
      return {
        pluginId: entry.pluginId,
        name: entry.name,
        vendor: entry.vendor,
        version: entry.version,
        category: entry.category,
        subCategories: entry.subCategories,
        classId: entry.classId,
        isInstrument: Boolean(entry.isInstrument),
        isEffect: Boolean(entry.isEffect),
        managed: Boolean(entry.managed),
        managedPath: entry.managedPath ?? null,
        sourcePath: entry.path ?? null,
        missing: entry.missing === true,
      }
    },

    async parameters(pluginId) {
      const entry = await getPluginEntry(dataDir, pluginId)
      if (!entry) throw new PluginRegistryError(`插件不存在：${String(pluginId)}`, 'PLUGIN_NOT_FOUND')
      if (parametersCache.has(entry.pluginId) && loadedPluginId === entry.pluginId) {
        return parametersCache.get(entry.pluginId)
      }
      const active = await ensureLoaded(entry)
      const result = await active.getParamsList()
      const items = Array.isArray(result?.items) ? result.items : []
      const params = items.map((item, index) => normalizeParameter(item, index))
      const payload = {
        pluginId: entry.pluginId,
        name: entry.name,
        count: params.length,
        params,
      }
      parametersCache.set(entry.pluginId, payload)
      return payload
    },

    async setParameter({ pluginId, paramId, value } = {}) {
      const entry = await getPluginEntry(dataDir, pluginId)
      if (!entry) throw new PluginRegistryError(`插件不存在：${String(pluginId)}`, 'PLUGIN_NOT_FOUND')
      const numericId = Number(paramId)
      const numericValue = Number(value)
      if (!Number.isFinite(numericId)) throw new PluginHostError('paramId 必须是数字', 'PLUGIN_INVALID_PARAM')
      if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1) {
        throw new PluginHostError('value 必须在 0..1 之间（归一化参数值）', 'PLUGIN_INVALID_PARAM')
      }
      const active = await ensureLoaded(entry)
      await active.setParameter(numericId, numericValue)
      if (parametersCache.has(entry.pluginId)) {
        const cached = parametersCache.get(entry.pluginId)
        const param = cached.params.find((item) => item.id === numericId || item.index === numericId)
        if (param) param.value = numericValue
      }
      return { pluginId: entry.pluginId, paramId: numericId, value: numericValue }
    },

    /** v2.3 P1：列出插件 program/preset（优先使用已加载实例；否则加载 legacy 实例缓存）。 */
    async listPresets({ pluginId, instanceId = null } = {}) {
      const entry = await getPluginEntry(dataDir, pluginId)
      if (!entry) throw new PluginRegistryError(`插件不存在：${String(pluginId)}`, 'PLUGIN_NOT_FOUND')
      if (entry.missing) throw new PluginRegistryError(`插件内容缺失：${entry.pluginId}；请重新安装`, 'PLUGIN_MISSING')
      const cacheKey = instanceId ? `${entry.pluginId}@${instanceId}` : entry.pluginId
      if (presetsCache.has(cacheKey)) return presetsCache.get(cacheKey)
      const active = instanceId && instances.has(String(instanceId)) ? ensureClient() : await ensureLoaded(entry)
      const result = instanceId && instances.has(String(instanceId))
        ? await active.listPrograms({ instanceId: String(instanceId) })
        : await active.listPrograms({})
      const lists = Array.isArray(result?.lists) ? result.lists : []
      const presets = Array.isArray(result?.presets) ? result.presets : []
      const payload = {
        pluginId: entry.pluginId,
        name: entry.name,
        count: presets.length,
        lists,
        presets,
      }
      presetsCache.set(cacheKey, payload)
      return payload
    },

    /** v2.3 P1：选择 program（会返回选择后的 params/state）。 */
    async selectPreset({ pluginId, instanceId = null, listId, index } = {}) {
      const entry = await getPluginEntry(dataDir, pluginId)
      if (!entry) throw new PluginRegistryError(`插件不存在：${String(pluginId)}`, 'PLUGIN_NOT_FOUND')
      if (entry.missing) throw new PluginRegistryError(`插件内容缺失：${entry.pluginId}；请重新安装`, 'PLUGIN_MISSING')
      const active = instanceId && instances.has(String(instanceId)) ? ensureClient() : await ensureLoaded(entry)
      const result = instanceId && instances.has(String(instanceId))
        ? await active.selectProgram({ instanceId: String(instanceId), listId, index })
        : await active.selectProgram({ listId, index })
      const items = Array.isArray(result?.params?.items) ? result.params.items : []
      const params = items.map((item, paramIndex) => normalizeParameter(item, paramIndex))
      presetsCache.delete(instanceId ? `${entry.pluginId}@${instanceId}` : entry.pluginId)
      if (parametersCache.has(entry.pluginId)) parametersCache.delete(entry.pluginId)
      return {
        pluginId: entry.pluginId,
        instanceId: instanceId ? String(instanceId) : null,
        listId: Number(result?.listId ?? listId),
        index: Number(result?.index ?? index),
        preset: result?.preset ?? { listId: Number(listId), index: Number(index), name: '' },
        params,
        stateBase64: typeof result?.stateBase64 === 'string' ? result.stateBase64 : null,
      }
    },

    /** v2.3 P1：保存实例 state（audio 实时节点或 legacy 实例）。 */
    async saveInstanceState(instanceId) {
      const id = String(instanceId ?? '')
      if (!instances.has(id)) throw new PluginHostError(`插件实例未加载：${id}`, 'PLUGIN_INSTANCE_NOT_FOUND')
      const result = await ensureClient().saveInstanceState(id)
      return { instanceId: id, stateBase64: String(result?.state ?? '') }
    },

    /** v2.3 P1：加载实例 state（audio 实时节点）。 */
    async loadInstanceState(instanceId, stateBase64) {
      const id = String(instanceId ?? '')
      if (!instances.has(id)) throw new PluginHostError(`插件实例未加载：${id}`, 'PLUGIN_INSTANCE_NOT_FOUND')
      const state = String(stateBase64 ?? '')
      if (state === '') throw new PluginHostError('stateBase64 不能为空', 'PLUGIN_STATE_INVALID')
      await ensureClient().loadInstanceState(id, state)
      return { instanceId: id, loaded: true }
    },

    /** v2.3 P1：从工程/调用方载入插件 state；优先已加载实例，否则 legacy 实例。 */
    async loadPluginState({ pluginId, instanceId = null, stateBase64 } = {}) {
      const entry = await getPluginEntry(dataDir, pluginId)
      if (!entry) throw new PluginRegistryError(`插件不存在：${String(pluginId)}`, 'PLUGIN_NOT_FOUND')
      const state = String(stateBase64 ?? '')
      if (state === '') throw new PluginHostError('stateBase64 不能为空', 'PLUGIN_STATE_INVALID')
      if (StateBytes(state) > 2 * 1024 * 1024) throw new PluginHostError('stateBase64 超过 2MB 上限', 'PLUGIN_STATE_INVALID')
      if (instanceId && instances.has(String(instanceId))) {
        await ensureClient().loadInstanceState(String(instanceId), state)
        const list = await ensureClient().getInstanceParams(String(instanceId))
        return { pluginId: entry.pluginId, instanceId: String(instanceId), loaded: true, params: (list?.items ?? []).map((item, index) => normalizeParameter(item, index)) }
      }
      const active = await ensureLoaded(entry)
      await active.loadState(state)
      const list = await active.getParamsList()
      if (parametersCache.has(entry.pluginId)) parametersCache.delete(entry.pluginId)
      return { pluginId: entry.pluginId, instanceId: null, loaded: true, params: (list?.items ?? []).map((item, index) => normalizeParameter(item, index)) }
    },

    /** v2.3 P1：保存插件 state（优先已加载实例，否则 legacy 实例）。 */
    async savePluginState({ pluginId, instanceId = null } = {}) {
      const entry = await getPluginEntry(dataDir, pluginId)
      if (!entry) throw new PluginRegistryError(`插件不存在：${String(pluginId)}`, 'PLUGIN_NOT_FOUND')
      if (instanceId && instances.has(String(instanceId))) {
        const result = await ensureClient().saveInstanceState(String(instanceId))
        return { pluginId: entry.pluginId, instanceId: String(instanceId), stateBase64: String(result?.state ?? '') }
      }
      const active = await ensureLoaded(entry)
      const result = await active.saveState()
      return { pluginId: entry.pluginId, instanceId: null, stateBase64: String(result?.state ?? '') }
    },

    /** v2.3 P1：选择已加载实例的 program（preload/audio 用）。 */
    async selectProgram({ instanceId, listId, index } = {}) {
      const id = String(instanceId ?? '')
      if (!instances.has(id)) throw new PluginHostError(`插件实例未加载：${id}`, 'PLUGIN_INSTANCE_NOT_FOUND')
      const result = await ensureClient().selectProgram({ instanceId: id, listId, index })
      return { ...result, instanceId: id }
    },

    /* ── M2：实时多实例（桌面 exe 内通过 preload/main IPC 调用） ───────── */

    async loadInstance(pluginIdOrOptions, maybeOptions = {}) {
      const args = pluginIdOrOptions !== null && typeof pluginIdOrOptions === 'object'
        ? pluginIdOrOptions
        : { ...maybeOptions, pluginId: pluginIdOrOptions }
      const pluginId = String(args.pluginId ?? '')
      const instanceId = typeof args.instanceId === 'string' ? args.instanceId.trim() : ''
      if (instanceId === '') throw new PluginHostError('loadInstance 需要 instanceId（约定 effect: fx:<effectId>）', 'PLUGIN_INVALID_INSTANCE')
      if (instanceId.length > 80) throw new PluginHostError('instanceId 过长（≤80 字符）', 'PLUGIN_INVALID_INSTANCE')
      const entry = await getPluginEntry(dataDir, pluginId)
      if (!entry) throw new PluginRegistryError(`插件不存在：${pluginId}`, 'PLUGIN_NOT_FOUND')
      if (entry.missing) throw new PluginRegistryError(`插件内容缺失：${pluginId}；请重新安装`, 'PLUGIN_MISSING')
      const rawKind = args.kind === undefined || args.kind === null ? '' : String(args.kind)
      if (rawKind !== '' && rawKind !== 'instrument' && rawKind !== 'effect') {
        throw new PluginHostError("kind 必须是 'instrument' 或 'effect'", 'PLUGIN_INVALID_INSTANCE')
      }
      const kind = rawKind === 'instrument'
        ? 'instrument'
        : rawKind === 'effect'
          ? 'effect'
          : (Number(args.audioInputs) === 0 ? 'instrument' : 'effect')
      const sampleRate = Number(args.sampleRate ?? 48000)
      const maxBlockSize = Number(args.maxBlockSize ?? 256)
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new PluginHostError('sampleRate 必须在 8000..192000', 'PLUGIN_INVALID_INSTANCE')
      if (!Number.isInteger(maxBlockSize) || maxBlockSize < 16 || maxBlockSize > 4096) throw new PluginHostError('maxBlockSize 必须在 16..4096', 'PLUGIN_INVALID_INSTANCE')
      const active = ensureClient()
      if (instances.has(instanceId)) {
        await active.unloadInstance(instanceId).catch(() => {})
        instances.delete(instanceId)
      }
      let binary
      try {
        binary = await resolveVst3BinaryPath(pluginTarget(entry))
      } catch (error) {
        throw new PluginRegistryError(`插件内容缺失：${entry.pluginId}；请重新安装后再加载`, 'PLUGIN_MISSING')
      }
      const result = await active.loadInstance({
        instanceId,
        path: binary,
        sampleRate,
        maxBlockSize,
        audioInputs: Number(args.audioInputs ?? (kind === 'instrument' ? 0 : 2)),
        audioOutputs: Number(args.audioOutputs ?? 2),
        kind,
      })
      if (typeof args.stateBase64 === 'string' && args.stateBase64 !== '') {
        try {
          await active.loadInstanceState(instanceId, args.stateBase64)
        } catch (error) {
          await active.unloadInstance(instanceId).catch(() => {})
          throw new PluginHostError(`加载插件状态失败：${error?.message ?? error}`, 'PLUGIN_STATE_INVALID')
        }
      }
      const meta = {
        instanceId,
        pluginId: entry.pluginId,
        pluginName: entry.name,
        vendor: entry.vendor,
        version: entry.version,
        category: entry.category,
        classId: entry.classId,
        effectId: typeof args.effectId === 'string' ? args.effectId : null,
        trackId: typeof args.trackId === 'string' ? args.trackId : null,
        sampleRate,
        maxBlockSize,
        kind,
        stateBase64: typeof args.stateBase64 === 'string' ? args.stateBase64 : null,
        midiInputs: Number(result?.midiInputs ?? result?.plugin?.numMidiInputs ?? 0) || 0,
        audioInputs: Number(args.audioInputs ?? (kind === 'instrument' ? 0 : 2)),
        audioOutputs: Number(args.audioOutputs ?? 2),
        midiEventCount: 0,
        latencySamples: Number(result?.latencySamples ?? 0) || 0,
        loadedAt: Date.now(),
        underrun: false,
        underruns: 0,
        bufferMs: null,
        lastError: null,
      }
      instances.set(instanceId, meta)
      return {
        instanceId,
        pluginId: meta.pluginId,
        pluginName: meta.pluginName,
        vendor: meta.vendor,
        version: meta.version,
        category: meta.category,
        classId: meta.classId,
        kind: meta.kind,
        midiInputs: meta.midiInputs,
        latencySamples: meta.latencySamples,
        latencyMs: (meta.latencySamples / sampleRate) * 1000,
        sampleRate,
        maxBlockSize,
        audioInputs: meta.audioInputs,
        audioOutputs: meta.audioOutputs,
      }
    },

    async processInstance({ instanceId, inputs = [], numSamples, midi = [], outputFormat = 'f32' } = {}) {
      const id = String(instanceId ?? '')
      const meta = instances.get(id)
      if (!meta) throw new PluginHostError(`插件实例未加载：${id}`, 'PLUGIN_INSTANCE_NOT_FOUND')
      const count = Number(numSamples)
      if (!Number.isInteger(count) || count <= 0 || count > meta.maxBlockSize) {
        throw new PluginHostError(`numSamples 必须为 1..${meta.maxBlockSize}`, 'PLUGIN_INVALID_BLOCK')
      }
      const encoded = (Array.isArray(inputs) ? inputs : []).map((input) => (
        typeof input === 'string' ? input : toBase64Float32(input)
      ))
      const active = ensureClient()
      try {
        const result = await active.processInstance({ instanceId: id, inputs: encoded, numSamples: count, midi: Array.isArray(midi) ? midi : [] })
        const rawOutputs = Array.isArray(result?.outputs) ? result.outputs : []
        const decoded = rawOutputs.map(fromBase64Float32)
        const outputs = outputFormat === 'base64' ? rawOutputs : decoded
        const midiEventCount = Number(result?.midiEventCount ?? 0) || 0
        meta.midiEventCount = (meta.midiEventCount ?? 0) + midiEventCount
        return {
          instanceId: id,
          numSamples: count,
          sampleRate: meta.sampleRate,
          outputs,
          ...(outputFormat === 'base64' ? {} : { outputsBase64: rawOutputs }),
          outputEvents: Array.isArray(result?.outputEvents) ? result.outputEvents : [],
          midiEventCount,
          ms: roundMs(result?.ms),
          latencySamples: meta.latencySamples,
          latencyMs: (meta.latencySamples / meta.sampleRate) * 1000,
        }
      } catch (error) {
        meta.lastError = String(error?.message ?? error)
        throw error
      }
    },

    async setInstanceParam({ instanceId, paramId, value } = {}) {
      const id = String(instanceId ?? '')
      const meta = instances.get(id)
      if (!meta) throw new PluginHostError(`插件实例未加载：${id}`, 'PLUGIN_INSTANCE_NOT_FOUND')
      const numericId = Number(paramId)
      const numericValue = Number(value)
      if (!Number.isFinite(numericId)) throw new PluginHostError('paramId 必须是数字', 'PLUGIN_INVALID_PARAM')
      if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1) {
        throw new PluginHostError('value 必须在 0..1 之间（归一化参数值）', 'PLUGIN_INVALID_PARAM')
      }
      await ensureClient().setInstanceParam({ instanceId: id, paramId: numericId, value: numericValue })
      return { instanceId: id, pluginId: meta.pluginId, paramId: numericId, value: numericValue }
    },

    async getInstanceParams(instanceId) {
      const id = String(instanceId ?? '')
      const meta = instances.get(id)
      if (!meta) throw new PluginHostError(`插件实例未加载：${id}`, 'PLUGIN_INSTANCE_NOT_FOUND')
      const result = await ensureClient().getInstanceParams(id)
      const params = (Array.isArray(result?.items) ? result.items : []).map((item, index) => normalizeParameter(item, index))
      return { instanceId: id, pluginId: meta.pluginId, count: params.length, params }
    },

    async saveInstanceState(instanceId) {
      const id = String(instanceId ?? '')
      if (!instances.has(id)) throw new PluginHostError(`插件实例未加载：${id}`, 'PLUGIN_INSTANCE_NOT_FOUND')
      const result = await ensureClient().saveInstanceState(id)
      return { instanceId: id, stateBase64: String(result?.state ?? '') }
    },

    async unloadInstance(instanceId) {
      const id = String(instanceId ?? '')
      const meta = instances.get(id)
      if (!meta) return { instanceId: id, unloaded: false }
      if (client) await client.unloadInstance(id).catch(() => {})
      instances.delete(id)
      return { instanceId: id, unloaded: true, pluginId: meta.pluginId }
    },

    async listInstances() {
      const items = [...instances.values()].map((meta) => ({
        instanceId: meta.instanceId,
        pluginId: meta.pluginId,
        pluginName: meta.pluginName,
        effectId: meta.effectId,
        trackId: meta.trackId,
        sampleRate: meta.sampleRate,
        maxBlockSize: meta.maxBlockSize,
        kind: meta.kind,
        midiInputs: meta.midiInputs ?? 0,
        midiEventCount: meta.midiEventCount ?? 0,
        audioInputs: meta.audioInputs,
        audioOutputs: meta.audioOutputs,
        latencySamples: meta.latencySamples,
        latencyMs: (meta.latencySamples / meta.sampleRate) * 1000,
        loadedAt: meta.loadedAt,
        underrun: meta.underrun,
        underruns: meta.underruns,
        bufferMs: meta.bufferMs,
        lastError: meta.lastError,
      }))
      return { count: items.length, maxInstances: 8, instances: items }
    },

    getInstanceInfo(instanceId) {
      const meta = instances.get(String(instanceId ?? ''))
      if (!meta) return null
      return {
        ...meta,
        latencyMs: (meta.latencySamples / meta.sampleRate) * 1000,
      }
    },

    /** 音频桥上报 underrun/缓冲占用等运行状态（供 UI status 显示，不进入工程）。 */
    reportInstanceStatus({ instanceId, underrun, underruns, bufferMs, error } = {}) {
      const meta = instances.get(String(instanceId ?? ''))
      if (!meta) return { ok: false, error: `插件实例未加载：${String(instanceId ?? '')}` }
      if (typeof underrun === 'boolean') meta.underrun = underrun
      if (Number.isFinite(Number(underruns))) meta.underruns = Math.max(0, Number(underruns))
      if (Number.isFinite(Number(bufferMs))) meta.bufferMs = Math.max(0, Number(bufferMs))
      if (typeof error === 'string' && error !== '') meta.lastError = error.slice(0, 400)
      return { ok: true, instance: { ...meta, latencyMs: (meta.latencySamples / meta.sampleRate) * 1000 } }
    },

    /** M4：离线渲染（instrument 用 events，effect 用 inputPcm）到 outputPath。 */
    async renderOffline({ pluginId, kind = 'instrument', outputPath, frames, sampleRate = 48000, maxBlockSize = 256, events = [], inputPcm = [], params, stateBase64, saveState = true } = {}) {
      const entry = await getPluginEntry(dataDir, pluginId)
      if (!entry) throw new PluginRegistryError(`插件不存在：${String(pluginId)}`, 'PLUGIN_NOT_FOUND')
      if (entry.missing) throw new PluginRegistryError(`插件内容缺失：${entry.pluginId}；请重新安装`, 'PLUGIN_MISSING')
      if (typeof outputPath !== 'string' || !/\.wav$/i.test(outputPath)) throw new PluginHostError('renderOffline 需要 .wav outputPath', 'PLUGIN_INVALID_ARGS')
      const binary = await resolveVst3BinaryPath(pluginTarget(entry))
      const active = ensureClient()
      const result = await active.renderOffline({
        kind: kind === 'instrument' ? 'instrument' : 'effect',
        pluginPath: binary,
        outputPath,
        frames,
        sampleRate,
        maxBlockSize,
        events,
        inputPcm,
        params: params && typeof params === 'object' ? params : undefined,
        stateBase64,
        saveState,
      })
      return {
        ...result,
        pluginId: entry.pluginId,
        name: entry.name,
        vendor: entry.vendor,
        version: entry.version,
      }
    },

    /** v2.3 P0：工程写回参数后同步参数缓存（sidecar/UI 立即读到最新值）。 */
    noteParameterValue({ pluginId, paramId, value } = {}) {
      const id = String(pluginId ?? '')
      if (!parametersCache.has(id)) return false
      const cached = parametersCache.get(id)
      const numericId = Number(paramId)
      const numericValue = Number(value)
      if (!Number.isFinite(numericId) || !Number.isFinite(numericValue)) return false
      const param = cached.params.find((item) => item.id === numericId || item.index === numericId)
      if (!param) return false
      param.value = Math.max(0, Math.min(1, numericValue))
      return true
    },

    async close() {
      loadedPluginId = null
      parametersCache.clear()
      presetsCache.clear()
      instances.clear()
      if (client) await client.close()
      client = null
    },
  }
}
