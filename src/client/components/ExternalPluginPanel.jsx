/**
 * v2.2 M2：外部插件实例面板（实时状态 / 参数 / 旁路 / missing）。
 * - 优先消费 engine 聚合 API：getExternalPlugins/getExternalPluginStatus/
 *   setExternalPluginParam/setExternalPluginBypass（audio ExternalPluginBridge 持有实例）。
 * - 无 AudioWorklet/preload 或浏览器/standalone：engine.supported=false/reason 显示
 *   「外部插件仅桌面版」；degraded 显示「实时不可用/已直通」+ error，不崩溃。
 * - M2 只支持 effect；instrument 实时在 M3。
 */
import { useEffect, useRef, useState } from 'react'
import { IconSparkle, fmtParam } from './ui.jsx'
import { externalPluginApi } from './PluginManager.jsx'

const FREEZE_BASE = '/studio/api'

const FREEZE_ROUTES = {
  freeze: '/plugin-freeze',
  unfreeze: '/plugin-unfreeze',
  status: '/plugin-freeze-status',
}

function freezeKey(trackId, effectId) {
  return effectId ? `${trackId}:${effectId}` : trackId
}

export function normalizeFreeze(raw) {
  const data = raw?.freeze ?? raw?.item ?? raw ?? {}
  const status = String(data.status ?? data.freezeStatus ?? '').toLowerCase()
  const missing = data.missing === true
  const frozen = data.frozen === true || ['current', 'stale', 'freezing'].includes(status)
  return {
    trackId: data.trackId ?? null,
    effectId: data.effectId ?? null,
    status: missing ? 'missing' : (status || (frozen ? 'current' : 'unfrozen')),
    frozen,
    missing,
    hash: data.hash ?? null,
    currentHash: data.currentHash ?? null,
    cacheFile: data.cacheFile ?? null,
    cacheUrl: data.cacheUrl ?? null,
    error: typeof data.error === 'string' ? data.error : '',
    createdAt: data.createdAt ?? data.cachedAt ?? null,
  }
}

async function requestFreezeJson(path, options = {}) {
  const res = await fetch(FREEZE_BASE + path, {
    cache: 'no-store',
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })
  if (res.status === 404 || res.status === 405) {
    const error = new Error('冻结接口尚未启用')
    error.code = 'FREEZE_UNAVAILABLE'
    throw error
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.ok === false) {
    const error = new Error(data?.error || `冻结请求失败（HTTP ${res.status}）`)
    error.code = data?.code ?? 'FREEZE_FAILED'
    throw error
  }
  return data ?? { ok: true }
}

/** M4：冻结动作必须走 host（engine 无磁盘/sidecar 权限）。
 *  - vst3 乐器轨 track.engine==='vst3'：直接 host freeze；
 *  - 普通轨含 vst3 effect：先 engine.freezeTrackAudio 渲染干声，再带 inputPcm POST host；
 *  - effect 传 trackId+effectId。
 */
export async function freezeExternalPlugin({ trackId, effectId = null, track = null, engine = null, bars = null }) {
  let dry = null
  const needsDryInput = track && track.engine !== 'vst3' && (track.effects ?? []).some((fx) => fx?.type === 'vst3')
  if (needsDryInput) {
    if (typeof engine?.freezeTrackAudio !== 'function') {
      throw new Error('当前音频引擎不支持生成干声，无法冻结该轨道上的 VST3 效果器')
    }
    dry = await engine.freezeTrackAudio(trackId, bars ? { bars } : {})
    if (!dry || dry.ok === false) throw new Error(dry?.error || '渲染轨道干声失败')
  }
  const payload = {
    trackId,
    ...(effectId ? { effectId } : {}),
    ...(dry?.bars ?? bars ? { bars: dry?.bars ?? bars } : {}),
    ...(dry?.inputPcm ? { inputPcm: dry.inputPcm } : {}),
  }
  const body = JSON.stringify(payload)
  let data
  try {
    data = await requestFreezeJson(FREEZE_ROUTES.freeze, { method: 'POST', body })
  } catch (err) {
    if (err?.code !== 'FREEZE_UNAVAILABLE') throw err
    const res = await fetch('/studio/api/tool-call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'studio_freeze_plugin_track', args: { trackId } }),
    })
    const fallback = await res.json().catch(() => null)
    if (!res.ok || fallback?.ok === false) throw new Error(fallback?.error || `冻结失败（HTTP ${res.status}）`)
    data = fallback?.result ?? fallback
  }
  return normalizeFreeze(data?.freeze ?? data?.result ?? data)
}

export async function unfreezeExternalPlugin({ trackId, effectId = null }) {
  const body = JSON.stringify({ trackId, ...(effectId ? { effectId } : {}) })
  let data
  try {
    data = await requestFreezeJson(FREEZE_ROUTES.unfreeze, { method: 'POST', body })
  } catch (err) {
    if (err?.code !== 'FREEZE_UNAVAILABLE') throw err
    const res = await fetch('/studio/api/tool-call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'studio_unfreeze_plugin_track', args: { trackId } }),
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `解冻失败（HTTP ${res.status}）`)
    data = payload?.result ?? payload
  }
  return normalizeFreeze(data?.freeze ?? { trackId, effectId, status: 'unfrozen' })
}

export async function fetchExternalFreezeStatuses(trackId = null) {
  try {
    const query = trackId ? `?trackId=${encodeURIComponent(trackId)}` : ''
    const data = await requestFreezeJson(`${FREEZE_ROUTES.status}${query}`)
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.tracks) ? data.tracks : Array.isArray(data) ? data : []
    const map = new Map()
    for (const item of items) {
      const normalized = normalizeFreeze(item)
      if (normalized.trackId) map.set(freezeKey(normalized.trackId, normalized.effectId), normalized)
    }
    return map
  } catch (err) {
    return new Map()
  }
}

export function freezeInfoFor(map, trackId, effectId = null) {
  if (!map) return null
  return map.get(freezeKey(trackId, effectId)) ?? map.get(trackId) ?? null
}

export function freezeStatusLabel(status) {
  switch (status) {
    case 'current': return '已冻结'
    case 'stale': return '需更新'
    case 'freezing': return '冻结中'
    case 'error': return '冻结失败'
    case 'missing': return '插件缺失'
    default: return '未冻结'
  }
}

/** v2.3 P0：面板调参写回工程（host set-param，进 undo；mergeKey 合并一次拖动）。 */
export async function setExternalPluginParameter({ trackId = null, effectId = null, paramId, value, mergeKey = null }) {
  const res = await fetch('/studio/api/plugins/external/set-param', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      ...(trackId ? { trackId } : {}),
      ...(effectId ? { effectId } : {}),
      paramId,
      value,
      ...(mergeKey ? { mergeKey } : {}),
    }),
  })
  if (res.status === 404 || res.status === 405) {
    const error = new Error('参数写回接口尚未启用')
    error.code = 'SET_PARAM_UNAVAILABLE'
    throw error
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `参数写回失败（HTTP ${res.status}）`)
  return data ?? { ok: true }
}

/** v2.3 P1：工厂程序列表 / 选择预设 / state 保存载入（host 路由）。 */
async function externalPluginJson(path, options = {}) {
  const res = await fetch('/studio/api/plugins/external' + path, {
    cache: 'no-store',
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `插件预设请求失败（HTTP ${res.status}）`)
  return data ?? { ok: true }
}

export async function listExternalPluginPresets({ pluginId = null, trackId = null, effectId = null } = {}) {
  const query = new URLSearchParams()
  if (pluginId) query.set('pluginId', pluginId)
  if (trackId) query.set('trackId', trackId)
  if (effectId) query.set('effectId', effectId)
  return externalPluginJson(`/presets?${query.toString()}`)
}

export async function selectExternalPluginPreset({ trackId = null, effectId = null, listId, index }) {
  return externalPluginJson('/select-preset', {
    method: 'POST',
    body: JSON.stringify({ ...(trackId ? { trackId } : {}), ...(effectId ? { effectId } : {}), listId, index }),
  })
}

export async function getExternalPluginState({ trackId = null, effectId = null } = {}) {
  const query = new URLSearchParams()
  if (trackId) query.set('trackId', trackId)
  if (effectId) query.set('effectId', effectId)
  return externalPluginJson(`/state?${query.toString()}`)
}

/** 优先让 host 从当前 live 实例抓取 state 并写工程；旧 host 回退读工程 state。 */
export async function captureExternalPluginState({ trackId = null, effectId = null } = {}) {
  try {
    return await externalPluginJson('/state/save', {
      method: 'POST',
      body: JSON.stringify({ ...(trackId ? { trackId } : {}), ...(effectId ? { effectId } : {}) }),
    })
  } catch (err) {
    if (!/404|405|不存在|未找到/i.test(String(err?.message ?? err))) throw err
    return getExternalPluginState({ trackId, effectId })
  }
}

export async function setExternalPluginState({ trackId = null, effectId = null, stateBase64 }) {
  return externalPluginJson('/state', {
    method: 'POST',
    body: JSON.stringify({ ...(trackId ? { trackId } : {}), ...(effectId ? { effectId } : {}), stateBase64 }),
  })
}

/** v2.3 P2：插件参数自动化（host 工程写回，一次手势/一个 undo）。 */
export async function fetchExternalPluginAutomation({ trackId = null, effectId = null } = {}) {
  const query = new URLSearchParams()
  if (trackId) query.set('trackId', trackId)
  if (effectId) query.set('effectId', effectId)
  return externalPluginJson(`/plugin-automation?${query.toString()}`)
}

export async function setExternalPluginAutomation({ trackId = null, effectId = null, paramId, points, enabled = true }) {
  return externalPluginJson('/plugin-automation', {
    method: 'POST',
    body: JSON.stringify({ ...(trackId ? { trackId } : {}), ...(effectId ? { effectId } : {}), paramId, points, enabled }),
  })
}

export async function clearExternalPluginAutomation({ trackId = null, effectId = null, paramId = null }) {
  const query = new URLSearchParams()
  if (trackId) query.set('trackId', trackId)
  if (effectId) query.set('effectId', effectId)
  if (paramId !== null && paramId !== undefined) query.set('paramId', String(paramId))
  return externalPluginJson(`/plugin-automation?${query.toString()}`, { method: 'DELETE' })
}

function infoOf(track, effect) {
  return effect?.vst3 ?? track?.vst3 ?? null
}

function getPreload() {
  if (typeof window === 'undefined') return null
  const api = window.aimsPlugins
  return api && typeof api === 'object' ? api : null
}

function instanceIdOf(track, effect) {
  if (effect?.id) return `fx:${effect.id}`
  if (track?.id) return `track:${track.id}`
  return null
}

function normalizeItem(raw) {
  const data = raw?.item && typeof raw.item === 'object' ? raw.item : raw ?? {}
  const text = String(data?.status ?? data?.state ?? '').toLowerCase()
  return {
    loaded: data.loaded === true || data.active === true || text === 'loaded' || text === 'running' || text === 'ready',
    degraded: data.degraded === true,
    bypass: data.bypass === true,
    underrun: Number(data.underrun ?? data.underruns ?? data.underrunCount ?? 0) || 0,
    bufferMs: Number.isFinite(Number(data.bufferMs ?? data.buffer ?? data.bufferDurationMs)) ? Number(data.bufferMs ?? data.buffer ?? data.bufferDurationMs) : null,
    latencyMs: Number.isFinite(Number(data.latencyMs ?? data.latency ?? data.pdcMs)) ? Number(data.latencyMs ?? data.latency ?? data.pdcMs) : null,
    sampleRate: Number.isFinite(Number(data.sampleRate)) ? Number(data.sampleRate) : null,
    maxBlockSize: Number.isFinite(Number(data.maxBlockSize ?? data.blockSize)) ? Number(data.maxBlockSize ?? data.blockSize) : null,
    error: typeof data.error === 'string' ? data.error : '',
    params: data.params ?? null,
    paramList: Array.isArray(data.paramList) ? data.paramList : null,
    bufferFrames: Number.isFinite(Number(data.bufferFrames)) ? Number(data.bufferFrames) : null,
    processMs: Number.isFinite(Number(data.processMs)) ? Number(data.processMs) : null,
    midiEvents: Number(data.midiEventCount ?? data.midiEvents ?? data.midiEventTotal ?? data.midiCount ?? 0) || 0,
    midiLastEvents: Number(data.midiLastEvents ?? 0) || 0,
    midiDropped: Number(data.midiDropped ?? data.midiDrops ?? 0) || 0,
    activeNotes: Number(data.activeNotes ?? data.activeNoteCount ?? 0) || 0,
    kind: data.kind === 'instrument' ? 'instrument' : (data.kind === 'effect' ? 'effect' : null),
  }
}

export function ExternalPluginPanel({ track = null, effect = null, engine = null, project = null, onNotify = null, onToggleBypass = null, compact = false }) {
  const vst3 = infoOf(track, effect)
  const pluginId = vst3?.pluginId ?? vst3?.id ?? null
  const isEffect = Boolean(effect?.id)
  const instanceId = instanceIdOf(track, effect)
  const hasEngineApi = Boolean(engine && typeof engine.getExternalPlugins === 'function')
  const preload = getPreload()
  const statusApi = preload?.status ?? preload?.getStatus ?? null
  const preloadSetParam = preload?.setParam ?? null

  const [params, setParams] = useState([])
  const [paramValues, setParamValues] = useState({})
  const [localParamOverrides, setLocalParamOverrides] = useState({})
  const [loading, setLoading] = useState(Boolean(pluginId))
  const [error, setError] = useState('')
  const [backendUnavailable, setBackendUnavailable] = useState(false)
  const [runtime, setRuntime] = useState({
    supported: hasEngineApi ? true : Boolean(preload),
    realtime: false,
    reason: '',
    loaded: false,
    degraded: false,
    bypass: vst3?.bypass === true,
    underrun: 0,
    bufferMs: null,
    latencyMs: null,
    sampleRate: null,
    maxBlockSize: null,
    error: '',
    midiEvents: 0,
    midiLastEvents: 0,
    midiDropped: 0,
    activeNotes: 0,
    kind: null,
  })
  const [liveBypass, setLiveBypass] = useState(vst3?.bypass === true)
  const [freezeInfo, setFreezeInfo] = useState(null)
  const [freezeBusy, setFreezeBusy] = useState(false)
  const freezeCurrent = freezeInfo?.status === 'current'
  const freezeFreezing = freezeInfo?.status === 'freezing'
  const freezeBusyNow = freezeBusy || freezeFreezing
  const freezeTrackId = effect?.trackId ?? track?.id ?? null
  const freezeEffectId = effect?.id ?? null
  const paramTimersRef = useRef(new Map())
  const paramMergeRef = useRef(new Map())
  const [syncState, setSyncState] = useState('idle')
  const [syncError, setSyncError] = useState('')
  const [presets, setPresets] = useState([])
  const [presetChoice, setPresetChoice] = useState('')
  const [presetLoading, setPresetLoading] = useState(false)
  const [presetBusy, setPresetBusy] = useState(false)
  const [presetError, setPresetError] = useState('')
  const [presetMessage, setPresetMessage] = useState('')
  const [stateText, setStateText] = useState('')
  const [stateBusy, setStateBusy] = useState(false)
  const [stateMessage, setStateMessage] = useState('')
  const [automationCurves, setAutomationCurves] = useState({})
  const [automationParam, setAutomationParam] = useState(null)
  const [automationDraft, setAutomationDraft] = useState([])
  const [automationEnabled, setAutomationEnabled] = useState(true)
  const [automationBusy, setAutomationBusy] = useState(false)
  const [automationMessage, setAutomationMessage] = useState('')
  const automationCanvasRef = useRef(null)
  const automationDragRef = useRef(null)
  const totalBeats = Math.max(4, (Number(project?.lengthBars) || 4) * (Number(project?.timeSignature?.[0]) || 4))

  const refreshPresets = async () => {
    if (!pluginId) return
    setPresetLoading(true)
    setPresetError('')
    try {
      const data = await listExternalPluginPresets({
        pluginId,
        trackId: freezeTrackId,
        effectId: freezeEffectId,
      })
      const list = Array.isArray(data?.presets) ? data.presets : []
      setPresets(list)
      const current = data?.current ?? vst3?.preset ?? null
      const currentKey = current && current.listId !== undefined && current.index !== undefined
        ? `${current.listId}:${current.index}`
        : ''
      setPresetChoice((prev) => (prev && list.some((item) => `${item.listId}:${item.index}` === prev) ? prev : (currentKey && list.some((item) => `${item.listId}:${item.index}` === currentKey) ? currentKey : (list[0] ? `${list[0].listId}:${list[0].index}` : ''))))
    } catch (err) {
      setPresetError(err?.message ?? String(err))
      setPresets([])
    } finally {
      setPresetLoading(false)
    }
  }

  useEffect(() => { refreshPresets() }, [pluginId, freezeTrackId, freezeEffectId])
  useEffect(() => {
    const preset = vst3?.preset
    if (preset && preset.listId !== undefined && preset.index !== undefined) {
      setPresetChoice(`${preset.listId}:${preset.index}`)
    }
  }, [vst3?.preset?.listId, vst3?.preset?.index])

  const loadPreset = async () => {
    if (!presetChoice || presetBusy) return
    const [listIdRaw, indexRaw] = presetChoice.split(':')
    const listId = Number(listIdRaw)
    const index = Number(indexRaw)
    setPresetBusy(true)
    setPresetError('')
    try {
      const result = await selectExternalPluginPreset({ trackId: freezeTrackId, effectId: freezeEffectId, listId, index })
      setPresetError('')
      setPresetMessage(`已载入预设：${result?.preset?.name ?? result?.preset?.programName ?? `#${index}`}`)
      onNotify?.('插件预设已载入工程（可撤销）', 'success')
      if (Array.isArray(result?.params)) {
        setParamValues((prev) => ({ ...prev, ...Object.fromEntries(result.params.map((item, i) => [String(item.id ?? item.index ?? i), Number(item.value ?? 0)])) }))
      }
    } catch (err) {
      setPresetError(err?.message ?? String(err))
      onNotify?.('载入插件预设失败：' + (err?.message ?? err), 'error')
    } finally {
      setPresetBusy(false)
    }
  }

  const saveState = async () => {
    if (stateBusy) return
    setStateBusy(true)
    setStateMessage('')
    try {
      const data = await captureExternalPluginState({ trackId: freezeTrackId, effectId: freezeEffectId })
      const text = typeof data?.stateBase64 === 'string' ? data.stateBase64 : ''
      setStateText(text)
      setStateMessage(text ? `已保存当前插件 state（${data?.bytes ?? text.length} 字节，可复制备份）` : '该插件未返回 state 内容')
    } catch (err) {
      setStateMessage('保存 state 失败：' + (err?.message ?? err))
    } finally {
      setStateBusy(false)
    }
  }

  const loadState = async () => {
    const text = stateText.trim()
    if (!text || stateBusy) return
    setStateBusy(true)
    setStateMessage('')
    try {
      const result = await setExternalPluginState({ trackId: freezeTrackId, effectId: freezeEffectId, stateBase64: text })
      const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : []
      setStateMessage(`已载入插件 state（${result?.bytes ?? text.length} 字节）${warnings.length > 0 ? `；警告：${warnings.join('；')}` : ''}`)
      onNotify?.('插件 state 已载入工程（可撤销）', 'success')
    } catch (err) {
      setStateMessage('载入 state 失败：' + (err?.message ?? err))
      onNotify?.('载入插件 state 失败：' + (err?.message ?? err), 'error')
    } finally {
      setStateBusy(false)
    }
  }

  const refreshAutomation = async () => {
    if (!pluginId) return
    try {
      const data = await fetchExternalPluginAutomation({ trackId: freezeTrackId, effectId: freezeEffectId })
      setAutomationCurves(data?.curves && typeof data.curves === 'object' ? data.curves : {})
    } catch (err) {
      /* 无自动化时静默 */
    }
  }
  useEffect(() => { refreshAutomation() }, [pluginId, freezeTrackId, freezeEffectId, project?.revision])

  const openAutomation = (paramId, currentValue) => {
    const key = String(paramId)
    const curve = automationCurves[key]
    setAutomationParam(key)
    setAutomationEnabled(curve?.enabled !== false)
    setAutomationMessage('')
    setAutomationDraft(Array.isArray(curve?.points) && curve.points.length > 0
      ? curve.points.map((point) => ({ beat: Number(point.beat) || 0, value: Math.max(0, Math.min(1, Number(point.value) || 0)) }))
      : [{ beat: 0, value: Number(currentValue) || 0 }, { beat: totalBeats, value: Number(currentValue) || 0 }])
  }

  const commitAutomation = async (points = automationDraft, enabled = automationEnabled, paramId = automationParam) => {
    if (!paramId || automationBusy) return
    const normalized = (Array.isArray(points) ? points : [])
      .filter((point) => Number.isFinite(Number(point.beat)) && Number.isFinite(Number(point.value)))
      .map((point) => ({
        beat: Math.round(Math.max(0, Math.min(totalBeats, Number(point.beat))) * 1000) / 1000,
        value: Math.max(0, Math.min(1, Number(point.value))),
      }))
      .sort((a, b) => a.beat - b.beat)
      .slice(0, 256)
    if (normalized.length === 0) {
      setAutomationMessage('至少需要一个自动化点')
      return
    }
    setAutomationBusy(true)
    setAutomationMessage('')
    try {
      const result = await setExternalPluginAutomation({
        trackId: freezeTrackId,
        effectId: freezeEffectId,
        paramId: Number(paramId),
        points: normalized,
        enabled: enabled !== false,
      })
      setAutomationDraft(normalized)
      setAutomationEnabled(enabled !== false)
      const savedCurve = result?.curve ?? { enabled: enabled !== false, points: normalized }
      setAutomationCurves((prev) => ({ ...prev, [String(paramId)]: savedCurve }))
      setAutomationMessage(`已写入工程（${normalized.length} 个点${enabled ? '' : ' · 已禁用'}）`)
    } catch (err) {
      setAutomationMessage('写入自动化失败：' + (err?.message ?? err))
      onNotify?.('插件自动化写入失败：' + (err?.message ?? err), 'error')
    } finally {
      setAutomationBusy(false)
    }
  }

  const removeAutomationPoint = (index) => {
    const next = automationDraft.filter((_, i) => i !== index)
    setAutomationDraft(next)
    commitAutomation(next)
  }

  const clearAutomationCurve = async () => {
    if (!automationParam || automationBusy) return
    setAutomationBusy(true)
    try {
      await clearExternalPluginAutomation({ trackId: freezeTrackId, effectId: freezeEffectId, paramId: Number(automationParam) })
      setAutomationCurves((prev) => { const next = { ...prev }; delete next[String(automationParam)]; return next })
      setAutomationDraft([])
      setAutomationMessage('已清除该参数自动化')
      onNotify?.('插件参数自动化已清除', 'success')
    } catch (err) {
      setAutomationMessage('清除失败：' + (err?.message ?? err))
    } finally {
      setAutomationBusy(false)
    }
  }

  const automationPointFromEvent = (event) => {
    const el = automationCanvasRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
    const y = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / Math.max(1, rect.height)))
    return {
      beat: Math.round(x * totalBeats * 1000) / 1000,
      value: Math.round(y * 1000) / 1000,
    }
  }

  const addAutomationPoint = (event) => {
    const point = automationPointFromEvent(event)
    if (!point) return
    const next = [...automationDraft, point].sort((a, b) => a.beat - b.beat)
    setAutomationDraft(next)
    commitAutomation(next)
  }

  const onAutomationPointDown = (event, index) => {
    event.stopPropagation()
    event.preventDefault()
    automationDragRef.current = index
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch (err) { /* ignore */ }
    setAutomationDraft((prev) => prev.map((point, i) => (i === index ? { ...point } : point)))
  }

  const onAutomationCanvasMove = (event) => {
    if (automationDragRef.current === null) return
    const point = automationPointFromEvent(event)
    if (!point) return
    const index = automationDragRef.current
    setAutomationDraft((prev) => prev.map((item, i) => (i === index ? point : item)).sort((a, b) => a.beat - b.beat))
  }

  const onAutomationCanvasUp = () => {
    if (automationDragRef.current === null) return
    automationDragRef.current = null
    setAutomationDraft((prev) => {
      commitAutomation(prev)
      return prev
    })
  }

  /* v2.3：工程参数变化（AI/工具/其他客户端）→ 刷新 slider 值。 */
  useEffect(() => {
    const stored = vst3?.params
    if (!stored || typeof stored !== 'object') return
    setParamValues((prev) => {
      const next = { ...prev }
      for (const [id, value] of Object.entries(stored)) {
        if (Number.isFinite(Number(value))) next[String(id)] = Number(value)
      }
      return next
    })
    // 工程已追上本地拖动值时清掉本地覆盖，之后以工程值为准。
    setLocalParamOverrides((prev) => {
      const next = { ...prev }
      let changed = false
      for (const [id, value] of Object.entries(prev)) {
        const storedValue = stored[id] ?? stored[Number(id)]
        if (storedValue !== undefined && Math.abs(Number(storedValue) - Number(value)) <= 1e-6) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [vst3?.params, pluginId])

  const mergeKeyFor = (paramId) => {
    const keyText = String(paramId)
    const now = Date.now()
    const existing = paramMergeRef.current.get(keyText)
    // 同一参数连续拖动（300ms 内）复用 mergeKey；停顿/换参数开始新的 undo 步。
    if (existing && now - existing.lastAt <= 300) {
      existing.lastAt = now
      return existing.mergeKey
    }
    const mergeKey = `ui:${freezeTrackId ?? 'track'}:${freezeEffectId ?? ''}:${keyText}:${now}`
    paramMergeRef.current.set(keyText, { mergeKey, lastAt: now })
    return mergeKey
  }

  /* M4：冻结状态只读轮询（动作走 host 路由）。 */
  useEffect(() => {
    if (!freezeTrackId) return undefined
    let cancelled = false
    const read = async () => {
      const map = await fetchExternalFreezeStatuses(freezeTrackId)
      if (!cancelled) setFreezeInfo(freezeInfoFor(map, freezeTrackId, freezeEffectId))
    }
    read()
    const timer = setInterval(read, 1000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [freezeTrackId, freezeEffectId])

  const runFreeze = async (mode) => {
    if (!freezeTrackId || freezeBusy) return
    if (vst3?.missing === true) {
      onNotify?.('插件文件缺失，无法冻结', 'error')
      return
    }
    setFreezeBusy(true)
    try {
      const result = mode === 'unfreeze'
        ? await unfreezeExternalPlugin({ trackId: freezeTrackId, effectId: freezeEffectId })
        : await freezeExternalPlugin({ trackId: freezeTrackId, effectId: freezeEffectId, track, engine })
      setFreezeInfo(result)
      onNotify?.(mode === 'unfreeze' ? '已解冻外部插件轨道/效果器' : '外部插件已冻结（M4 缓存）', 'success')
      const map = await fetchExternalFreezeStatuses(freezeTrackId)
      setFreezeInfo(freezeInfoFor(map, freezeTrackId, freezeEffectId))
    } catch (err) {
      onNotify?.((mode === 'unfreeze' ? '解冻失败：' : '冻结失败：') + (err?.message ?? err), 'error')
    } finally {
      setFreezeBusy(false)
    }
  }

  /* 参数定义仍走 host registry（M1 API）；实时值来自 engine/instance。 */
  useEffect(() => {
    let cancelled = false
    if (!pluginId) { setLoading(false); return undefined }
    setLoading(true)
    setError('')
    externalPluginApi.parameters(pluginId)
      .then((data) => {
        if (cancelled) return
        const list = Array.isArray(data?.parameters) ? data.parameters : Array.isArray(data?.params) ? data.params : []
        setParams(list)
        const values = {}
        for (const [index, param] of list.entries()) {
          const id = param.id ?? param.index ?? index
          values[String(id)] = Number(param.value ?? param.defaultValue ?? param.default ?? 0)
        }
        setParamValues(values)
        setBackendUnavailable(false)
      })
      .catch((err) => {
        if (cancelled) return
        if (err?.code === 'PLUGIN_BACKEND_UNAVAILABLE') setBackendUnavailable(true)
        setError(err?.message ?? String(err))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [pluginId])

  /* M2：优先轮询 engine 聚合状态（500ms）。 */
  useEffect(() => {
    if (!instanceId) return undefined
    let cancelled = false
    let timer = null
    const applyRuntime = (partial) => setRuntime((prev) => ({ ...prev, ...partial }))

    const readEngine = async () => {
      if (!hasEngineApi) return false
      try {
        const all = await engine.getExternalPlugins()
        if (cancelled) return true
        const supported = all?.supported !== false
        const items = Array.isArray(all?.items) ? all.items : []
        const item = items.find((entry) => entry?.instanceId === instanceId) ?? null
        const normalized = item ? normalizeItem(item) : normalizeItem({})
        applyRuntime({
          supported,
          realtime: supported && Boolean(item) && !normalized.degraded,
          reason: typeof all?.reason === 'string' ? all.reason : '',
          ...normalized,
          bypass: normalized.bypass,
        })
        if (normalized.bypass !== liveBypass) setLiveBypass(normalized.bypass)
        const itemParams = normalized.paramList
        if (Array.isArray(itemParams) && itemParams.length > 0) {
          // M2/M3：host 真实参数描述（paramList）优先；值域 0..1。
          setParams((prev) => (prev.length === itemParams.length ? prev : itemParams))
          setParamValues((prev) => {
            const next = { ...prev }
            for (const [index, param] of itemParams.entries()) {
              const id = param.id ?? param.index ?? index
              if (param.value !== undefined && param.value !== null) next[String(id)] = Number(param.value)
            }
            return next
          })
          setError('')
          setLoading(false)
          setBackendUnavailable(false)
        } else if (normalized.params && typeof normalized.params === 'object' && !Array.isArray(normalized.params)) {
          setParamValues((prev) => ({ ...prev, ...normalized.params }))
        } else if (Array.isArray(normalized.params) && normalized.params.length > 0) {
          setParamValues((prev) => {
            const next = { ...prev }
            for (const [index, param] of normalized.params.entries()) {
              const id = param.id ?? param.index ?? index
              if (param.value !== undefined && param.value !== null) next[String(id)] = Number(param.value)
            }
            return next
          })
        }
        return true
      } catch (err) {
        if (!cancelled) applyRuntime({ supported: true, realtime: false, error: String(err?.message ?? err) })
        return true
      }
    }

    const readPreload = async () => {
      if (!statusApi) return
      try {
        let raw = null
        try { raw = await statusApi({ instanceId }) } catch (outer) { raw = await statusApi(instanceId) }
        if (cancelled) return
        const normalized = normalizeItem(raw)
        applyRuntime({ supported: true, realtime: true, reason: '', ...normalized, bypass: normalized.bypass })
      } catch (err) {
        if (!cancelled) applyRuntime({ supported: true, realtime: false, error: String(err?.message ?? err) })
      }
    }

    const tick = async () => {
      const usedEngine = await readEngine()
      if (!usedEngine) await readPreload()
    }
    tick()
    timer = setInterval(tick, 500)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [engine, hasEngineApi, instanceId, statusApi, liveBypass])

  useEffect(() => () => {
    for (const timer of paramTimersRef.current.values()) clearTimeout(timer)
    paramTimersRef.current.clear()
  }, [])

  const sendParam = (id, value) => {
    if (!freezeTrackId) {
      setSyncState('error')
      setSyncError('缺少轨道/效果器目标，无法写回工程')
      return
    }
    const key = String(id)
    const existing = paramTimersRef.current.get(key)
    if (existing) clearTimeout(existing)
    // 每次 input 都续同一 mergeKey（300ms 内复用），确保整段拖动合并为一次 undo。
    const mergeKey = mergeKeyFor(id)
    // v2.3：≤50ms 节流写回工程（host set-param + mergeKey 合并 undo）；
    // 实时由 revision → engine.setProject/graph.update 同步，UI 不再直接写实例。
    const timer = setTimeout(async () => {
      paramTimersRef.current.delete(key)
      setSyncState('syncing')
      try {
        const result = await setExternalPluginParameter({
          trackId: freezeTrackId,
          effectId: freezeEffectId,
          paramId: id,
          value,
          mergeKey,
        })
        const nextParams = result?.params && typeof result.params === 'object' ? result.params : null
        if (nextParams) {
          setParamValues((prev) => {
            const next = { ...prev }
            for (const [paramId, paramValue] of Object.entries(nextParams)) {
              if (Number.isFinite(Number(paramValue))) next[String(paramId)] = Number(paramValue)
            }
            return next
          })
        } else {
          setParamValues((prev) => ({ ...prev, [key]: value }))
        }
        setSyncState('synced')
        setSyncError('')
      } catch (err) {
        setSyncState('error')
        setSyncError(err?.message ?? String(err))
        onNotify?.('外部插件参数写回失败：' + (err?.message ?? err), 'error')
      }
    }, 50)
    paramTimersRef.current.set(key, timer)
  }

  const toggleBypass = async (next) => {
    setLiveBypass(next)
    try {
      if (runtime.realtime && hasEngineApi && typeof engine.setExternalPluginBypass === 'function' && instanceId) {
        const changed = await engine.setExternalPluginBypass(instanceId, next)
        if (changed !== false) return
      }
      if (typeof onToggleBypass === 'function') {
        await onToggleBypass(next)
        return
      }
      // M1 回退：面板独立挂载时直接走 host bypass 路由（仍不改实时 engine）。
      if (effect?.id) await externalPluginApi.bypass({ effectId: effect.id }, next)
      else if (track?.id) await externalPluginApi.bypass({ trackId: track.id }, next)
    } catch (err) {
      setLiveBypass(!next)
      onNotify?.('外部插件旁路失败：' + (err?.message ?? err), 'error')
    }
  }

  if (!vst3) return null
  const missing = vst3.missing === true
  const bypass = liveBypass
  const runtimeUnsupported = !runtime.supported || (!hasEngineApi && !statusApi)
  const degraded = runtime.degraded
  const runtimeLabel = missing
    ? '引用缺失'
    : runtimeUnsupported
      ? '外部插件仅桌面版'
      : degraded
        ? (track && !isEffect ? '实时不可用（乐器已静音）' : '实时不可用（已直通）')
        : runtime.error
          ? `实时错误：${runtime.error}`
          : runtime.loaded ? '实时已加载' : '实时未加载'
  const unsupportedReason = runtime.reason || '外部插件仅桌面版（缺少 desktop preload / AudioWorklet 实时桥）'
  const paramDisabled = missing
  const runtimeParams = Array.isArray(runtime.params) ? runtime.params : null

  return (
    <section
      className={`aims-external-plugin ${compact ? 'is-compact' : ''}`}
      data-testid="external-plugin-panel"
      data-plugin-id={pluginId ?? ''}
      data-missing={missing ? 'true' : 'false'}
      data-runtime={runtimeUnsupported ? 'unsupported' : degraded ? 'degraded' : runtime.loaded ? 'loaded' : 'idle'}
      data-instance-id={instanceId ?? ''}
      aria-label="外部插件实例"
    >
      <header className="aims-external-head">
        <span className="aims-external-dot" aria-hidden="true" />
        <span className="aims-external-badge">VST3</span>
        <span className="aims-external-name" title={vst3.name ?? ''}>{vst3.name ?? '外部插件'}</span>
        {missing ? <span className="aims-plugin-missing" data-testid="external-plugin-missing">missing</span> : null}
        {bypass ? <span className="aims-external-bypassed">旁路</span> : null}
        {typeof onToggleBypass === 'function' || (hasEngineApi && typeof engine.setExternalPluginBypass === 'function') ? (
          <button
            type="button"
            className={`aims-external-bypass ${bypass ? 'is-on' : ''}`}
            data-testid="plugin-bypass"
            aria-pressed={bypass}
            onClick={() => toggleBypass(!bypass)}
            title={bypass ? '启用插件处理' : '旁路插件处理'}
          >
            {bypass ? 'BYPASS ON' : 'BYPASS'}
          </button>
        ) : null}
      </header>
      <div className="aims-external-meta" data-testid="external-plugin-info">
        {vst3.vendor ? <span>{vst3.vendor}</span> : null}
        {vst3.version ? <span>v{vst3.version}</span> : null}
        {vst3.category ? <span>{vst3.category}</span> : null}
        {instanceId ? <span className="aims-mono" title="实时实例 id">{instanceId}</span> : null}
      </div>
      {freezeTrackId ? (
        <div className="aims-external-freeze" data-testid="external-plugin-freeze">
          <button
            type="button"
            className={`aims-external-freeze-btn ${freezeInfo?.frozen ? 'is-frozen' : ''}`}
            data-testid={`plugin-freeze-${freezeTrackId}${freezeEffectId ? `-${freezeEffectId}` : ''}`}
            disabled={freezeBusyNow || vst3.missing === true}
            title={vst3.missing === true ? '插件文件缺失，无法冻结' : (freezeCurrent ? '解冻并恢复实时插件' : (freezeInfo?.status === 'stale' ? '重新冻结（内容已修改）' : '离线冻结为音频缓存'))}
            onClick={() => runFreeze(freezeCurrent ? 'unfreeze' : 'freeze')}
          >
            {freezeBusyNow ? '冻结中…' : (freezeCurrent ? '解冻' : (freezeInfo?.status === 'stale' ? '重新冻结' : '冻结'))}
          </button>
          <span
            className={`aims-external-freeze-status is-${freezeInfo?.status ?? 'unfrozen'}`}
            data-testid={`freeze-status-${freezeTrackId}${freezeEffectId ? `-${freezeEffectId}` : ''}`}
            data-status={freezeInfo?.status ?? 'unfrozen'}
            title={freezeInfo?.error ?? '冻结状态'}
          >
            {freezeStatusLabel(freezeInfo?.status)}
          </span>
          {freezeInfo?.status === 'stale' ? <span className="aims-external-freeze-hint">内容已修改，需重新冻结</span> : null}
          {freezeInfo?.status === 'error' ? <span className="aims-external-freeze-hint is-error" role="alert">{freezeInfo.error || '冻结失败'}</span> : null}
          {vst3.missing === true ? <span className="aims-external-freeze-hint is-error">插件文件缺失，无法冻结</span> : null}
        </div>
      ) : null}

      <div className="aims-preset-browser" data-testid="plugin-preset-browser">
        <div className="aims-preset-head">
          <span className="aims-preset-title">预设</span>
          <span className="aims-preset-current" data-testid="plugin-preset-current">
            {vst3?.preset?.name ?? vst3?.preset?.programName ?? (presetChoice ? presets.find((item) => `${item.listId}:${item.index}` === presetChoice)?.name ?? '' : '未选择')}
          </span>
          <button type="button" className="aims-preset-refresh" data-testid="plugin-preset-refresh" disabled={presetLoading || missing} onClick={refreshPresets} title="从插件读取工厂程序列表">刷新</button>
        </div>
        {presetLoading ? <div className="aims-preset-note">正在读取工厂预设…</div>
          : presetError ? <div className="aims-preset-note is-error" data-testid="plugin-preset-error" role="alert">{presetError}</div>
            : presets.length === 0 ? <div className="aims-preset-note">该插件没有可列出的工厂预设（或后端未启用）</div>
              : (
                <div className="aims-preset-row">
                  <select
                    className="aims-preset-select"
                    data-testid="plugin-preset-select"
                    aria-label="工厂预设"
                    value={presetChoice}
                    onChange={(e) => { setPresetChoice(e.target.value); setPresetMessage('') }}
                  >
                    {presets.map((item, index) => (
                      <option key={`${item.listId}-${item.index}-${index}`} value={`${item.listId}:${item.index}`}>
                        {item.name ?? item.programName ?? `Program ${item.index}`}{item.listName ? ` · ${item.listName}` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="aims-preset-load"
                    data-testid="plugin-preset-load"
                    disabled={!presetChoice || presetBusy || missing}
                    onClick={loadPreset}
                  >{presetBusy ? '载入中…' : '载入预设'}</button>
                </div>
              )}
        {presetMessage ? <div className="aims-preset-note is-ok" data-testid="plugin-preset-message" role="status">{presetMessage}</div> : null}
        <div className="aims-preset-state">
          <span className="aims-preset-state-label">插件 state</span>
          <button type="button" className="aims-preset-state-btn" data-testid="plugin-state-save" disabled={stateBusy || missing} onClick={saveState}>{stateBusy ? '…' : '保存 state'}</button>
          <button type="button" className="aims-preset-state-btn" data-testid="plugin-state-load" disabled={stateBusy || !stateText.trim() || missing} onClick={loadState}>{stateBusy ? '…' : '载入 state'}</button>
        </div>
        <textarea
          className="aims-preset-state-text"
          data-testid="plugin-state-text"
          aria-label="插件 state（base64，可复制/粘贴载入）"
          placeholder="点击「保存 state」读取当前插件状态 base64；或粘贴 state 后载入"
          value={stateText}
          onChange={(e) => setStateText(e.target.value)}
          spellCheck={false}
        />
        {stateMessage ? <div className="aims-preset-note" data-testid="plugin-state-message" role="status">{stateMessage}</div> : null}
      </div>

      <div className="aims-external-runtime" data-testid="plugin-runtime" data-loaded={runtime.loaded ? 'true' : 'false'} data-degraded={degraded ? 'true' : 'false'}>
        <span className={`aims-external-runtime-dot ${runtime.loaded && !degraded ? 'is-loaded' : ''} ${degraded ? 'is-degraded' : ''}`} aria-hidden="true" />
        <span data-testid="plugin-runtime-status">实时：{runtimeLabel}</span>
        {runtimeUnsupported ? null : (
          <>
            <span data-testid="plugin-runtime-underrun" title="输出 underrun 次数">underrun {runtime.underrun}</span>
            <span data-testid="plugin-runtime-buffer" title="插件桥缓冲">{runtime.bufferMs === null ? '缓冲 —' : `缓冲 ${runtime.bufferMs.toFixed(1)}ms`}</span>
            <span data-testid="plugin-runtime-latency" title="插件 latency（M2/M3 仅显示，不做全局补偿）">{runtime.latencyMs === null ? 'latency —' : `latency ${runtime.latencyMs.toFixed(1)}ms`}</span>
            {track && !isEffect ? <span data-testid="plugin-midi-count" title="累计发送 MIDI 事件数">MIDI {runtime.midiEvents}</span> : null}
            {track && !isEffect ? <span data-testid="plugin-active-notes" title="当前活动音数">活动音 {runtime.activeNotes}</span> : null}
            {runtime.sampleRate ? <span className="aims-mono">{runtime.sampleRate}Hz</span> : null}
            {runtime.maxBlockSize ? <span className="aims-mono">{runtime.maxBlockSize}f</span> : null}
          </>
        )}
      </div>
      {runtimeUnsupported ? (
        <div className="aims-external-note is-warn" data-testid="plugin-runtime-unsupported" role="status">
          {unsupportedReason}
        </div>
      ) : null}
      {!runtimeUnsupported && degraded ? (
        <div className="aims-external-note is-warn" data-testid="plugin-runtime-degraded" role="status">
          {track && !isEffect ? '实时不可用，乐器已静音' : '实时不可用，音频已直通'}{runtime.error ? `：${runtime.error}` : '。'}
        </div>
      ) : null}
      {track && !isEffect ? (
        <div className="aims-external-note" data-testid="plugin-instrument-live" role="status">
          VST3 乐器实时：键盘/播放 MIDI 由 engine 调度{runtime.realtime ? '，当前实例已接入' : '；当前仅桌面版可用（M3 实时）'}。
        </div>
      ) : null}

      {missing ? (
        <div className="aims-external-note is-warn" role="status">插件副本缺失或未安装；工程引用保留，重新导入后可恢复。</div>
      ) : backendUnavailable ? (
        <div className="aims-external-note" role="status">外部插件需要桌面版/后端未启用。</div>
      ) : loading ? (
        <div className="aims-external-note">正在读取参数…</div>
      ) : error ? (
        <div className="aims-external-note is-warn" role="alert">{error}</div>
      ) : params.length === 0 ? (
        <div className="aims-external-note">没有可显示参数（M1 通用参数来自 sidecar）</div>
      ) : (
        <div className="aims-external-params" role="list" aria-label="插件参数">
          {params.slice(0, 64).map((param, index) => {
            const id = param.id ?? param.index ?? index
            const name = param.name ?? param.label ?? `参数 ${id}`
            const storedValue = vst3?.params?.[String(id)] ?? vst3?.params?.[Number(id)]
            const value = localParamOverrides[String(id)] ?? (Number.isFinite(Number(storedValue)) ? Number(storedValue) : (paramValues[String(id)] ?? runtimeParams?.find((entry) => String(entry?.id ?? entry?.index) === String(id))?.value ?? param.value ?? param.defaultValue ?? param.default ?? 0))
            const min = Number(param.min ?? 0)
            const max = Number(param.max ?? 1)
            const ratio = Number.isFinite(min) && Number.isFinite(max) && max > min
              ? Math.max(0, Math.min(1, (Number(value) - min) / (max - min)))
              : 0
            return (
              <div className="aims-external-param" role="listitem" key={`${id}-${index}`} data-testid={`plugin-param-${id}`}>
                <button
                  type="button"
                  className={`aims-external-param-auto ${automationCurves[String(id)]?.enabled ? 'is-on' : ''}`}
                  data-testid={`plugin-automation-toggle-${id}`}
                  title="编辑该参数的自动化曲线"
                  onClick={() => openAutomation(id, value)}
                >A</button>
                <span className="aims-external-param-name" title={name}>{name}</span>
                {automationCurves[String(id)]?.enabled ? <span className="aims-external-param-auto-tag" data-testid={`plugin-automation-active-${id}`}>自动</span> : null}
                <input
                  type="range"
                  className="aims-external-param-range"
                  data-testid={`plugin-param-input-${id}`}
                  min={0}
                  max={1}
                  step={0.001}
                  value={ratio}
                  disabled={paramDisabled}
                  aria-label={`${name}（写回工程，50ms 节流；实时由 revision 同步）`}
                  onChange={(e) => {
                    const nextRatio = Math.max(0, Math.min(1, Number(e.target.value) || 0))
                    const nextValue = min + nextRatio * (max - min)
                    setParamValues((prev) => ({ ...prev, [String(id)]: nextValue }))
                    setLocalParamOverrides((prev) => ({ ...prev, [String(id)]: nextValue }))
                    sendParam(id, nextValue)
                  }}
                />
                <span className="aims-external-param-value aims-mono">{typeof value === 'number' ? fmtParam({ min, max, step: param.step ?? 0.01, unit: param.unit ?? '' }, value) : String(value)}</span>
              </div>
            )
          })}
        </div>
      )}
      {automationParam !== null ? (
        <div className="aims-plugin-auto" data-testid="plugin-automation-panel">
          <div className="aims-plugin-auto-head">
            <span className="aims-plugin-auto-title">自动化 · {params.find((param, index) => String(param.id ?? param.index ?? index) === automationParam)?.name ?? `参数 ${automationParam}`}</span>
            <label className="aims-plugin-auto-enable">
              <input
                type="checkbox"
                data-testid="plugin-automation-enable"
                checked={automationEnabled}
                onChange={(e) => {
                  const next = e.target.checked
                  setAutomationEnabled(next)
                  commitAutomation(automationDraft, next)
                }}
              />
              启用
            </label>
            <button type="button" className="aims-plugin-auto-close" data-testid="plugin-automation-close" aria-label="关闭自动化编辑器" onClick={() => setAutomationParam(null)}>×</button>
          </div>
          <svg
            ref={automationCanvasRef}
            className="aims-plugin-auto-canvas"
            data-testid="plugin-automation-canvas"
            viewBox={`0 0 ${totalBeats} 1`}
            preserveAspectRatio="none"
            role="img"
            aria-label="插件参数自动化曲线"
            onClick={addAutomationPoint}
            onPointerMove={onAutomationCanvasMove}
            onPointerUp={onAutomationCanvasUp}
            onPointerLeave={onAutomationCanvasUp}
          >
            <line x1="0" y1="0.5" x2={totalBeats} y2="0.5" className="aims-plugin-auto-grid" />
            <polyline
              className="aims-plugin-auto-line"
              points={automationDraft.map((point) => `${point.beat},${1 - point.value}`).join(' ')}
              vectorEffect="non-scaling-stroke"
            />
            {automationDraft.map((point, index) => (
              <circle
                key={`${point.beat}-${index}`}
                className="aims-plugin-auto-point"
                cx={point.beat}
                cy={1 - point.value}
                r={Math.max(0.06, totalBeats * 0.008)}
                data-testid={`plugin-automation-point-${index}`}
                onPointerDown={(event) => onAutomationPointDown(event, index)}
              />
            ))}
          </svg>
          <div className="aims-plugin-auto-list" role="list" aria-label="自动化点列表">
            {automationDraft.map((point, index) => (
              <div className="aims-plugin-auto-row" role="listitem" key={`${index}-${point.beat}`}>
                <span className="aims-plugin-auto-index aims-mono">{index + 1}</span>
                <input
                  type="number"
                  className="aims-plugin-auto-num"
                  data-testid={`plugin-automation-beat-${index}`}
                  aria-label={`第 ${index + 1} 个点 beat`}
                  min={0}
                  max={totalBeats}
                  step={0.25}
                  value={point.beat}
                  onChange={(e) => { const next = automationDraft.map((item, i) => (i === index ? { ...item, beat: Number(e.target.value) } : item)); setAutomationDraft(next) }}
                  onBlur={() => commitAutomation()}
                />
                <input
                  type="number"
                  className="aims-plugin-auto-num"
                  data-testid={`plugin-automation-value-${index}`}
                  aria-label={`第 ${index + 1} 个点 value`}
                  min={0}
                  max={1}
                  step={0.01}
                  value={point.value}
                  onChange={(e) => { const next = automationDraft.map((item, i) => (i === index ? { ...item, value: Number(e.target.value) } : item)); setAutomationDraft(next) }}
                  onBlur={() => commitAutomation()}
                />
                <button type="button" className="aims-plugin-auto-remove" data-testid={`plugin-automation-remove-${index}`} aria-label={`删除第 ${index + 1} 个点`} onClick={() => removeAutomationPoint(index)}>×</button>
              </div>
            ))}
          </div>
          <div className="aims-plugin-auto-actions">
            <button type="button" className="aims-plugin-auto-btn" data-testid="plugin-automation-add" onClick={() => { const next = [...automationDraft, { beat: totalBeats / 2, value: 0.5 }]; setAutomationDraft(next); commitAutomation(next) }}>加点</button>
            <button type="button" className="aims-plugin-auto-btn" data-testid="plugin-automation-save" disabled={automationBusy} onClick={() => commitAutomation()}>{automationBusy ? '写入中…' : '保存曲线'}</button>
            <button type="button" className="aims-plugin-auto-btn is-danger" data-testid="plugin-automation-clear" disabled={automationBusy} onClick={clearAutomationCurve}>清除自动化</button>
            <span className="aims-plugin-auto-note" data-testid="plugin-automation-message" role="status">
              {automationMessage || (runtime.realtime ? '播放时按曲线实时控制参数；手势结束写入一次撤销步' : '已可写入工程；实时自动化需桌面版（当前仅保存）')}
            </span>
          </div>
        </div>
      ) : null}
      <div className={`aims-external-sync is-${syncState}`} data-testid="plugin-param-sync-status" data-state={syncState} role="status">
        {syncState === 'syncing' ? '正在写回工程…'
          : syncState === 'synced' ? '已同步工程（可撤销）'
            : syncState === 'error' ? `写回失败：${syncError || '未知错误'}`
              : '参数写回工程 · 拖动时 50ms 节流 · 停止后一次撤销步'}
      </div>
      <div className="aims-external-foot">
        <IconSparkle size={10} />
        <span>{runtime.realtime ? '参数写回工程并实时同步实例；停止拖动后进一次撤销步' : '参数可写回工程；实时处理需桌面版（当前仅持久化/撤销）'}</span>
      </div>
    </section>
  )
}
