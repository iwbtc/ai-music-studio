/**
 * AI 音乐工作室 — Host 性能指标（R1a）。
 *
 * 纯内存埋点：工具调用耗时、state save/load 耗时、内存/uptime 快照。
 * 不写文件、不包含工程内容；由 tools.js（每次 execute）、state.js（保存/加载）、
 * routes.js（GET /studio/api/metrics）共享同一个模块级实例。
 */

/** 单个指标实例（测试可创建独立实例，不受并发/历史污染）。 */
export function createMetrics(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const startedAt = now()
  let toolCalls = 0
  let toolTotalMs = 0
  let toolMaxMs = 0
  let lastTool = null
  let saveCount = 0
  let saveTotalMs = 0
  let saveMs = 0
  let loadCount = 0
  let loadTotalMs = 0
  let loadMs = 0

  const round = (value, digits = 2) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return 0
    const factor = 10 ** digits
    return Math.round(numeric * factor) / factor
  }

  function recordToolCall(name, ms) {
    const duration = Number(ms)
    if (!Number.isFinite(duration) || duration < 0) return
    toolCalls += 1
    toolTotalMs += duration
    toolMaxMs = Math.max(toolMaxMs, duration)
    lastTool = { name: String(name), ms: round(duration), at: now() }
  }

  function recordSave(ms) {
    const duration = Number(ms)
    if (!Number.isFinite(duration) || duration < 0) return
    saveCount += 1
    saveTotalMs += duration
    saveMs = duration
  }

  function recordLoad(ms) {
    const duration = Number(ms)
    if (!Number.isFinite(duration) || duration < 0) return
    loadCount += 1
    loadTotalMs += duration
    loadMs = duration
  }

  /** 包装一个工具的 execute：失败也计数，不改变返回值/错误传播。 */
  function instrumentTool(name, execute) {
    if (typeof execute !== 'function') return execute
    return async function instrumentedExecute(...args) {
      const started = now()
      try {
        return await execute.apply(this, args)
      } finally {
        recordToolCall(name, now() - started)
      }
    }
  }

  /** 包装工具定义（返回新对象；保留 name/description/parameters/output）。 */
  function instrumentToolDefinition(tool) {
    if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string') return tool
    return { ...tool, execute: instrumentTool(tool.name, tool.execute) }
  }

  function reset() {
    toolCalls = 0
    toolTotalMs = 0
    toolMaxMs = 0
    lastTool = null
    saveCount = 0
    saveTotalMs = 0
    saveMs = 0
    loadCount = 0
    loadTotalMs = 0
    loadMs = 0
  }

  /** 只读快照（不含工程内容）。 */
  function snapshot() {
    const memory = typeof process.memoryUsage === 'function' ? process.memoryUsage() : {}
    return {
      uptimeMs: Math.max(0, Math.round(now() - startedAt)),
      toolCalls: {
        total: toolCalls,
        avgMs: toolCalls > 0 ? round(toolTotalMs / toolCalls) : 0,
        maxMs: round(toolMaxMs),
        last: lastTool,
      },
      state: {
        saveMs: round(saveMs),
        loadMs: round(loadMs),
        saveCount,
        loadCount,
        saveAvgMs: saveCount > 0 ? round(saveTotalMs / saveCount) : 0,
        loadAvgMs: loadCount > 0 ? round(loadTotalMs / loadCount) : 0,
      },
      memory: {
        rss: Number(memory.rss ?? 0),
        heapUsed: Number(memory.heapUsed ?? 0),
      },
    }
  }

  return { recordToolCall, recordSave, recordLoad, instrumentTool, instrumentToolDefinition, reset, snapshot }
}

/** 进程级共享实例（tools/state/routes 共用）。 */
export const defaultMetrics = createMetrics()

export const recordToolCall = (...args) => defaultMetrics.recordToolCall(...args)
export const recordSave = (...args) => defaultMetrics.recordSave(...args)
export const recordLoad = (...args) => defaultMetrics.recordLoad(...args)
export const instrumentTool = (...args) => defaultMetrics.instrumentTool(...args)
export const instrumentToolDefinition = (...args) => defaultMetrics.instrumentToolDefinition(...args)
export const resetMetrics = (...args) => defaultMetrics.reset(...args)
export const getMetricsSnapshot = (...args) => defaultMetrics.snapshot(...args)
