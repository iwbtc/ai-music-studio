/**
 * v2.4 P1：实时电平测量桥（AI studio_measure_live ↔ UI meter 轮询）。
 * UI 播放 1–4 小节，每 50ms 读取 engine.getMeters()，完成后 POST /meter-done；
 * Host 阻塞等待并按 master/track 聚合 RMS/peak/lufsApprox（不写工程/不改 revision/undo）。
 */

/** 默认/最大等待时间（毫秒）。 */
export const METER_TIMEOUT_MS = 15000
/** 允许的小节数。 */
export const METER_MAX_BARS = 4
/** UI 采样间隔（毫秒，仅文档/校验提示）。 */
export const METER_SAMPLE_INTERVAL_MS = 50

/** WeakMap<state, {nextSeq:number, pending:Map<number,{params,resolve,reject,timer}>}> */
const BRIDGES = new WeakMap()

function bridgeFor(state) {
  let bridge = BRIDGES.get(state)
  if (!bridge) {
    bridge = { nextSeq: 1, pending: new Map() }
    BRIDGES.set(state, bridge)
  }
  return bridge
}

function meterTimeoutError(timeoutMs) {
  const error = new Error(`实时电平测量超时（${Math.max(1, Math.round(timeoutMs / 1000))}s）：请确认桌面窗口已打开且音频已启用；可改用 studio_quick_mix_check 或 studio_render_preview`)
  error.code = 'METER_TIMEOUT'
  error.timeoutMs = timeoutMs
  return error
}

/** 发起一次实时电平测量请求并等待 UI 回传（默认 15s）。 */
export function requestMeter(state, params = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : METER_TIMEOUT_MS
  const bridge = bridgeFor(state)
  const seq = bridge.nextSeq
  bridge.nextSeq += 1
  const fromBar = Math.max(0, Math.floor(Number(params.fromBar) || 0))
  const bars = Math.max(1, Math.min(METER_MAX_BARS, Math.floor(Number(params.bars) || 1)))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!bridge.pending.has(seq)) return
      bridge.pending.delete(seq)
      reject(meterTimeoutError(timeoutMs))
    }, timeoutMs)
    timer.unref?.()
    bridge.pending.set(seq, { params: { fromBar, bars, revision: Number(state?.revision) || 0 }, resolve, reject, timer })
  })
}

/** UI 轮询：返回 seq > sinceSeq 的最早待处理请求；无请求返回 null。 */
export function peekMeterRequest(state, sinceSeq) {
  const bridge = bridgeFor(state)
  const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0
  let found = null
  for (const [seq, entry] of bridge.pending) {
    if (seq <= since) continue
    if (found === null || seq < found.seq) found = { seq, params: entry.params }
  }
  return found
}

function finiteOrNull(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

/** 从 UI 原始 samples 聚合 master/tracks（Host 侧校验，不信任 UI 聚合字段）。 */
export function aggregateMeterResult(result = {}) {
  const samples = Array.isArray(result.samples) ? result.samples.filter((item) => item && typeof item === 'object') : []
  const masterSamples = []
  const trackSamples = new Map()
  for (const sample of samples) {
    const master = sample.master && typeof sample.master === 'object' ? sample.master : null
    if (master) {
      masterSamples.push({
        rms: finiteOrNull(master.rms),
        peak: finiteOrNull(master.peak),
        rmsDb: finiteOrNull(master.rmsDb),
        peakDb: finiteOrNull(master.peakDb),
        lufsApprox: finiteOrNull(master.lufsApprox),
      })
    }
    const tracks = sample.tracks && typeof sample.tracks === 'object' ? sample.tracks : {}
    for (const [trackId, meters] of Object.entries(tracks)) {
      if (!meters || typeof meters !== 'object') continue
      if (!trackSamples.has(trackId)) trackSamples.set(trackId, [])
      trackSamples.get(trackId).push({ rms: finiteOrNull(meters.rms), peak: finiteOrNull(meters.peak), rmsDb: finiteOrNull(meters.rmsDb), peakDb: finiteOrNull(meters.peakDb) })
    }
  }
  const collect = (list, key) => list.map((item) => item[key]).filter((value) => value !== null)
  const rmsValues = collect(masterSamples, 'rms')
  const peakValues = collect(masterSamples, 'peak')
  const lufsValues = collect(masterSamples, 'lufsApprox')
  const avg = (values) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null)
  const master = {
    rmsAvg: avg(rmsValues),
    rmsMin: rmsValues.length > 0 ? Math.min(...rmsValues) : null,
    rmsMax: rmsValues.length > 0 ? Math.max(...rmsValues) : null,
    peakMax: peakValues.length > 0 ? Math.max(...peakValues) : null,
    lufsApproxAvg: avg(lufsValues),
    lufsApproxMax: lufsValues.length > 0 ? Math.max(...lufsValues) : null,
  }
  const tracks = {}
  for (const [trackId, list] of trackSamples) {
    const maxRms = list.map((item) => item.rms).filter((value) => value !== null)
    const maxPeak = list.map((item) => item.peak).filter((value) => value !== null)
    const rmsDbValues = list.map((item) => item.rmsDb).filter((value) => value !== null)
    const peakDbValues = list.map((item) => item.peakDb).filter((value) => value !== null)
    tracks[trackId] = {
      maxRms: maxRms.length > 0 ? Math.max(...maxRms) : null,
      maxPeak: maxPeak.length > 0 ? Math.max(...maxPeak) : null,
      maxRmsDb: rmsDbValues.length > 0 ? Math.max(...rmsDbValues) : null,
      maxPeakDb: peakDbValues.length > 0 ? Math.max(...peakDbValues) : null,
      samples: list.length,
    }
  }
  return {
    sampleCount: samples.length,
    master,
    tracks,
    durationMs: finiteOrNull(result.durationMs),
    transport: result.transport && typeof result.transport === 'object' ? result.transport : null,
    underruns: Math.max(0, Math.round(finiteOrNull(result.underruns) ?? 0)),
  }
}

/** UI 回传（POST /meter-done）；返回 seq 是否有效。 */
export function completeMeterRequest(state, seq, result = {}) {
  const bridge = bridgeFor(state)
  const numericSeq = Number(seq)
  if (!Number.isInteger(numericSeq)) return false
  const entry = bridge.pending.get(numericSeq)
  if (!entry) return false
  bridge.pending.delete(numericSeq)
  if (entry.timer) clearTimeout(entry.timer)
  const errorText = typeof result?.error === 'string' ? result.error.trim() : ''
  if (errorText !== '') {
    const error = new Error(errorText)
    error.code = 'METER_FAILED'
    entry.reject(error)
    return true
  }
  entry.resolve(aggregateMeterResult(result))
  return true
}

export function pendingMeterCount(state) {
  return bridgeFor(state).pending.size
}

export function clearMeterRequests(state) {
  const bridge = bridgeFor(state)
  for (const [, entry] of bridge.pending) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.reject(Object.assign(new Error('实时电平测量请求已取消'), { code: 'METER_CANCELLED' }))
  }
  bridge.pending.clear()
}
