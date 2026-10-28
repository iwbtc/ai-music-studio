/**
 * AI 音乐工作室 — 渲染预览桥（P10）。
 *
 * Tools（Host 侧）与桌面窗口 UI 之间的一次性请求/响应通道：
 *   1. 工具 `studio_render_preview` 调用 requestPreview(state, params) 挂起等待；
 *   2. UI 每 300ms 轮询 peekPreviewRequest(state, sinceSeq) 取待处理请求；
 *   3. UI 渲染完成后 POST /studio/api/preview-done → completePreviewRequest(state, seq, result)。
 *
 * 状态按 state 实例存于模块级 WeakMap（同一进程内 tools 与 routes 共享模块实例），
 * 不写工程、不产生 revision/undo。默认超时 120s（env AIMS_PREVIEW_TIMEOUT_MS 可覆盖）；
 * 大段预览自动 fast；超时 reject 带 code='PREVIEW_TIMEOUT' 与明确「窗口被遮挡/最小化」提示。
 */

/** 默认预览超时（毫秒）：窗口遮挡/大段渲染需要更长等待（v2.1 P0）。 */
export const PREVIEW_TIMEOUT_MS = 120000
/** 大段预览自动 fast 的小节阈值（span >= 32 小节自动 fast(22050Hz)；小段保持 normal 保证预览/导出 peak 一致）。 */
export const PREVIEW_AUTO_FAST_BARS = 32

function envPositiveNumber(env, key) {
  const raw = env && env[key] !== undefined ? env[key] : undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** 解析预览超时：options.timeoutMs > env AIMS_PREVIEW_TIMEOUT_MS > 默认 120s。 */
export function resolvePreviewTimeoutMs(options = {}, env = (typeof process !== 'undefined' ? process.env : undefined)) {
  const explicit = Number(options?.timeoutMs)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return envPositiveNumber(env, 'AIMS_PREVIEW_TIMEOUT_MS') ?? PREVIEW_TIMEOUT_MS
}

/**
 * 大段/整曲预览自动 fast（22050Hz）：span >= 阈值（默认 32 小节，env AIMS_PREVIEW_AUTO_FAST_BARS 可覆盖）
 * 时注入 fast:true；返回新对象（不改调用方参数），并带 autoFast 元信息供 UI/日志识别。
 */
export function normalizePreviewParams(params = {}, env = (typeof process !== 'undefined' ? process.env : undefined)) {
  const next = { ...(params && typeof params === 'object' ? params : {}) }
  const fromBar = Math.max(0, Math.floor(Number(next.fromBar) || 0))
  const toBar = Math.max(fromBar + 1, Math.floor(Number(next.toBar) || fromBar + 4))
  const span = toBar - fromBar
  const threshold = envPositiveNumber(env, 'AIMS_PREVIEW_AUTO_FAST_BARS') ?? PREVIEW_AUTO_FAST_BARS
  if (next.fast !== true && span >= threshold) {
    next.fast = true
    next.autoFast = true
    next.autoFastReason = `预览范围 ${span} 小节 ≥ ${threshold}，自动 fast(22050Hz)`
  }
  return next
}

/** 超时错误：明确「窗口被遮挡/最小化或渲染过慢」，不再误导为音色库加载。 */
export function previewTimeoutError(timeoutMs) {
  const seconds = Math.max(1, Math.round(Number(timeoutMs) / 1000))
  const error = new Error(
    `渲染预览超时（${seconds}s）：可能窗口被遮挡/最小化、系统休眠或渲染过慢；请保持窗口可见（或还原窗口）后重试。大段预览已自动使用 fast 模式。`,
  )
  error.code = 'PREVIEW_TIMEOUT'
  error.timeoutMs = Number(timeoutMs)
  return error
}

/** WeakMap<state, {nextSeq:number, pending:Map<number,{params,resolve,reject,timer}>}> */
const BRIDGES = new WeakMap()

/** 取（或创建）某个 state 的预览桥。 */
function bridgeFor(state) {
  let bridge = BRIDGES.get(state)
  if (!bridge) {
    bridge = { nextSeq: 1, pending: new Map() }
    BRIDGES.set(state, bridge)
  }
  return bridge
}

/**
 * 发起一次渲染预览请求并等待 UI 返回。
 * @param {object} state createState() 返回的状态实例
 * @param {{fromBar:number,toBar:number,tailSeconds?:number,includeStems?:boolean}} params
 * @param {{timeoutMs?:number}} [options] 测试可传更短超时
 * @returns {Promise<object>} UI 返回的 analysis（或含 stems 的分析对象）
 */

/* ── v2.4 P0：quick_mix_check draft 缓存（Host 模块级，不写工程/不改 revision） ── */

/** quick_mix_check 缓存条数上限。 */
export const QUICK_MIX_CACHE_LIMIT = 16
/** quick_mix_check 允许的采样率（秒级 draft）。 */
export const QUICK_MIX_SAMPLE_RATES = Object.freeze([8000, 11025, 16000])
/** quick_mix_check 单次最大范围（小节）。 */
export const QUICK_MIX_MAX_SPAN = 8

/** WeakMap<state, Map<string, {analysis, at, renderMs}>>（LRU 按插入顺序，最多 16 条）。 */
const QUICK_CACHES = new WeakMap()

function quickCacheFor(state) {
  let cache = QUICK_CACHES.get(state)
  if (!cache) {
    cache = new Map()
    QUICK_CACHES.set(state, cache)
  }
  return cache
}

/** 计算 quick_mix_check 缓存 key：{revision,range,sampleRate,solo,stems}。 */
export function quickMixCacheKey({ revision, fromBar, toBar, sampleRate, soloTrackIds = [], stems = false } = {}) {
  return JSON.stringify({
    revision: Number(revision) || 0,
    fromBar: Number(fromBar) || 0,
    toBar: Number(toBar) || 0,
    sampleRate: Number(sampleRate) || 0,
    soloTrackIds: (Array.isArray(soloTrackIds) ? soloTrackIds : []).map(String).sort(),
    stems: stems === true,
  })
}

/** 查询缓存；命中返回 {analysis,renderMs:0,at} 并刷新 LRU 顺序，未命中 null。 */
export function getQuickMixCache(state, key) {
  const cache = quickCacheFor(state)
  if (!cache.has(key)) return null
  const entry = cache.get(key)
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

/** 写入缓存（同 key 覆盖；超过 16 条删最旧）。 */
export function setQuickMixCache(state, key, entry = {}) {
  const cache = quickCacheFor(state)
  if (cache.has(key)) cache.delete(key)
  cache.set(key, { analysis: entry.analysis ?? {}, renderMs: Number(entry.renderMs) || 0, at: Date.now(), analysisRevision: entry.analysisRevision ?? null })
  while (cache.size > QUICK_MIX_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
  return entry
}

/** 当前缓存条数（测试/诊断）。 */
export function quickMixCacheSize(state) {
  return quickCacheFor(state).size
}

/** 清空某个 state 的 quick_mix 缓存（测试/reset 用）。 */
export function clearQuickMixCache(state) {
  quickCacheFor(state).clear()
}

export function requestPreview(state, params, options = {}) {
  const bridge = bridgeFor(state)
  const seq = bridge.nextSeq
  bridge.nextSeq += 1
  const timeoutMs = resolvePreviewTimeoutMs(options)
  // v2.4 fix：请求带当前 state.revision，UI 可先同步 project 再渲染，避免编辑后立即预览用旧 project 返回静音 0。
  const paramsWithRevision = {
    ...(params && typeof params === 'object' ? params : {}),
    ...(params?.revision === undefined ? { revision: Number(state?.revision) || 0 } : {}),
  }
  // v2.1：大段/整曲预览自动 fast，避免 60–120s 硬超时；UI 直接消费该参数。
  const normalizedParams = normalizePreviewParams(paramsWithRevision)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!bridge.pending.has(seq)) return
      bridge.pending.delete(seq)
      reject(previewTimeoutError(timeoutMs))
    }, timeoutMs)
    timer.unref?.()
    bridge.pending.set(seq, { params: normalizedParams, resolve, reject, timer })
  })
}

/**
 * UI 轮询：返回 seq 大于 sinceSeq 的最早待处理请求。
 * @param {object} state
 * @param {number} sinceSeq 客户端已处理到的 seq（0/未传 = 从头）
 * @returns {{seq:number, params:object}|null} 无待处理返回 null
 */
export function peekPreviewRequest(state, sinceSeq) {
  const bridge = bridgeFor(state)
  const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0
  let found = null
  for (const [seq, entry] of bridge.pending) {
    if (seq <= since) continue
    if (found === null || seq < found.seq) found = { seq, params: entry.params }
  }
  return found
}

/**
 * UI 回报预览结果（POST /studio/api/preview-done 调用）。
 * @param {object} state
 * @param {number} seq
 * @param {{analysis?:object, error?:string}} result
 * @returns {boolean} seq 是否存在（false = 未知/已超时/重复）
 */
export function completePreviewRequest(state, seq, result = {}) {
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
    error.code = 'PREVIEW_FAILED'
    entry.reject(error)
    return true
  }
  entry.resolve(result?.analysis ?? result ?? {})
  return true
}

/**
 * 当前待处理请求数（调试/测试用）。
 * @param {object} state
 */
export function pendingPreviewCount(state) {
  return bridgeFor(state).pending.size
}

/** 清空某个 state 的所有待处理请求（state.dispose/测试清理用）。 */
export function clearPreviewRequests(state) {
  const bridge = bridgeFor(state)
  for (const [, entry] of bridge.pending) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.reject(Object.assign(new Error('预览请求已取消'), { code: 'PREVIEW_CANCELLED' }))
  }
  bridge.pending.clear()
}
