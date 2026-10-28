/**
 * R1a：性能指标 perf.js 单测。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createMetrics,
  defaultMetrics,
  getMetricsSnapshot,
  instrumentTool,
  instrumentToolDefinition,
  recordLoad,
  recordSave,
  recordToolCall,
  resetMetrics,
} from '../src/host/perf.js'

describe('R1a perf — 指标实例', () => {
  it('初始快照字段完整且非负', () => {
    const metrics = createMetrics({ now: () => 1000 })
    const snapshot = metrics.snapshot()
    assert.equal(snapshot.uptimeMs, 0)
    assert.deepEqual(snapshot.toolCalls, { total: 0, avgMs: 0, maxMs: 0, last: null })
    assert.equal(snapshot.state.saveMs, 0)
    assert.equal(snapshot.state.loadMs, 0)
    assert.equal(snapshot.state.saveCount, 0)
    assert.equal(snapshot.state.loadCount, 0)
    assert.equal(typeof snapshot.memory.rss, 'number')
    assert.equal(typeof snapshot.memory.heapUsed, 'number')
    assert.ok(Number.isFinite(snapshot.memory.rss))
  })

  it('recordToolCall：total/avg/max/last 正确；非法值忽略', () => {
    let now = 0
    const metrics = createMetrics({ now: () => now })
    metrics.recordToolCall('studio_a', 10)
    metrics.recordToolCall('studio_b', 30)
    const snapshot = metrics.snapshot()
    assert.equal(snapshot.toolCalls.total, 2)
    assert.equal(snapshot.toolCalls.maxMs, 30)
    assert.equal(snapshot.toolCalls.avgMs, 20)
    assert.equal(snapshot.toolCalls.last.name, 'studio_b')
    assert.equal(snapshot.toolCalls.last.ms, 30)
    metrics.recordToolCall('bad', Number.NaN)
    metrics.recordToolCall('bad', -5)
    assert.equal(metrics.snapshot().toolCalls.total, 2)
    now = 1234
    metrics.recordToolCall('studio_c', 1.234)
    assert.equal(metrics.snapshot().toolCalls.last.at, 1234)
  })

  it('recordSave/recordLoad：计数/最后耗时/均值', () => {
    const metrics = createMetrics()
    metrics.recordSave(2)
    metrics.recordSave(4)
    metrics.recordLoad(7)
    const state = metrics.snapshot().state
    assert.equal(state.saveCount, 2)
    assert.equal(state.saveMs, 4)
    assert.equal(state.saveAvgMs, 3)
    assert.equal(state.loadCount, 1)
    assert.equal(state.loadMs, 7)
    assert.equal(state.loadAvgMs, 7)
    metrics.recordSave(Number.NaN)
    assert.equal(metrics.snapshot().state.saveCount, 2)
  })

  it('instrumentTool：成功/失败都计数，返回值/异常不改变', async () => {
    const metrics = createMetrics()
    const okTool = metrics.instrumentTool('studio_ok', async (value) => value * 2)
    assert.equal(await okTool(21), 42)
    const failTool = metrics.instrumentTool('studio_fail', async () => {
      throw new Error('boom')
    })
    await assert.rejects(() => failTool(), /boom/)
    const snapshot = metrics.snapshot()
    assert.equal(snapshot.toolCalls.total, 2)
    assert.equal(snapshot.toolCalls.last.name, 'studio_fail')
  })

  it('instrumentToolDefinition：保留 name/description/parameters/output，只包装 execute', async () => {
    const metrics = createMetrics()
    const tool = {
      name: 'studio_x',
      description: 'desc',
      parameters: {},
      output: { schema: {} },
      execute: async () => ({ ok: true }),
    }
    const wrapped = metrics.instrumentToolDefinition(tool)
    assert.equal(wrapped.name, 'studio_x')
    assert.equal(wrapped.description, 'desc')
    assert.equal(wrapped.parameters, tool.parameters)
    assert.equal(wrapped.output, tool.output)
    assert.notEqual(wrapped.execute, tool.execute)
    assert.deepEqual(await wrapped.execute({}), { ok: true })
    assert.equal(metrics.snapshot().toolCalls.total, 1)
    // 非工具对象原样返回
    assert.equal(metrics.instrumentToolDefinition(null), null)
  })

  it('reset：清空计数但保留 uptime/memory', () => {
    const metrics = createMetrics()
    metrics.recordToolCall('a', 5)
    metrics.recordSave(3)
    metrics.recordLoad(2)
    metrics.reset()
    const snapshot = metrics.snapshot()
    assert.equal(snapshot.toolCalls.total, 0)
    assert.equal(snapshot.state.saveCount, 0)
    assert.equal(snapshot.state.loadCount, 0)
    assert.equal(typeof snapshot.memory.rss, 'number')
  })

  it('uptimeMs 随时间增长且不出现负数', () => {
    let now = 100
    const metrics = createMetrics({ now: () => now })
    assert.equal(metrics.snapshot().uptimeMs, 0)
    now = 6100
    assert.equal(metrics.snapshot().uptimeMs, 6000)
    now = 50
    assert.equal(metrics.snapshot().uptimeMs, 0, '时钟回退时钳制为 0')
  })

  it('快照不含工程内容字段（只含指标/内存）', () => {
    const metrics = createMetrics()
    const snapshot = metrics.snapshot()
    assert.deepEqual(Object.keys(snapshot).sort(), ['memory', 'state', 'toolCalls', 'uptimeMs'])
    const text = JSON.stringify(snapshot)
    assert.ok(!text.includes('tracks'))
    assert.ok(!text.includes('patterns'))
  })

  it('默认单例函数与 defaultMetrics 共享计数', () => {
    resetMetrics()
    recordToolCall('studio_singleton', 12)
    recordSave(1)
    recordLoad(2)
    assert.equal(defaultMetrics.snapshot().toolCalls.total, 1)
    const snapshot = getMetricsSnapshot()
    assert.equal(snapshot.toolCalls.total, 1)
    assert.equal(snapshot.state.saveCount, 1)
    assert.equal(snapshot.state.loadCount, 1)
    resetMetrics()
    assert.equal(getMetricsSnapshot().toolCalls.total, 0)
  })

  it('instrumentTool 绑定 this 且支持同步 execute', async () => {
    const metrics = createMetrics()
    const wrapped = metrics.instrumentTool('studio_sync', function sync(value) {
      return this?.factor ? value * this.factor : value
    })
    assert.equal(await wrapped.call({ factor: 3 }, 2), 6)
    assert.equal(metrics.snapshot().toolCalls.total, 1)
    void instrumentTool
  })
})
