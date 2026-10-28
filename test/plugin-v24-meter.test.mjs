/** v2.4 P1: live meter bridge + studio_measure_live + routes. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { describe, it } from 'node:test'
import * as model from '../src/shared/model.js'
import { createState } from '../src/host/state.js'
import { createTools } from '../src/host/tools.js'
import { startServer } from '../src/standalone/server.mjs'
import {
  METER_MAX_BARS,
  METER_SAMPLE_INTERVAL_MS,
  METER_TIMEOUT_MS,
  aggregateMeterResult,
  clearMeterRequests,
  completeMeterRequest,
  peekMeterRequest,
  pendingMeterCount,
  requestMeter,
} from '../src/host/meter-bridge.js'

const ROOT = path.resolve(import.meta.dirname, '..')

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'aims-meter-')) }
async function cleanup(dir) { await rm(dir, { recursive: true, force: true }).catch(async () => { await new Promise((r) => setTimeout(r, 150)); await rm(dir, { recursive: true, force: true }).catch(() => {}) }) }
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
}

function sample(t, overrides = {}) {
  return {
    t,
    tracks: { trk_1: { rms: 0.1, rmsDb: -20, peak: 0.4, peakDb: -8 }, trk_2: { rms: 0.05, rmsDb: -26, peak: 0.2, peakDb: -14 } },
    master: { rms: 0.2, rmsDb: -14, peak: 0.8, peakDb: -2, lufsApprox: -13 },
    ...overrides,
  }
}

async function makeStateAndTools() {
  const dataDir = await tempDir()
  const state = createState({ dataDir })
  await state.ready
  state.mutate({ tool: 'setup' }, (draft) => {
    const project = model.createEmptyProject()
    project.lengthBars = 8
    const track = { id: 'trk_1', name: 'Lead', kind: 'synth', instrument: { preset: 'warm_pad' }, volume: 0.8, pan: 0, mute: false, solo: false, sends: { reverb: 0.1, delay: 0.05 }, effects: [], automation: {} }
    draft.tracks = [track]
    draft.title = 'meter'
    draft.lengthBars = 8
  })
  const tools = createTools({ defineTool: (options) => options, state })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { state, dataDir, exec: (name, args) => byName.get(name).execute(args), byName }
}

async function runMeter(state, exec, args, result) {
  const promise = exec('studio_measure_live', args)
  let request = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    request = peekMeterRequest(state, 0)
    if (request) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  if (!request) throw new Error('measure_live did not request meter')
  assert.equal(completeMeterRequest(state, request.seq, result), true)
  return await promise
}

describe('v2.4 P1 meter aggregation', () => {
  it('empty samples yields null aggregates', () => {
    const result = aggregateMeterResult({})
    assert.equal(result.sampleCount, 0)
    assert.equal(result.master.rmsAvg, null)
    assert.deepEqual(result.tracks, {})
  })
  it('master rms min/avg/max', () => {
    const result = aggregateMeterResult({ samples: [sample(0), sample(50, { master: { rms: 0.4, rmsDb: -8, peak: 0.9, peakDb: -1, lufsApprox: -10 } })] })
    assert.equal(result.master.rmsMin, 0.2)
    assert.equal(result.master.rmsMax, 0.4)
    assert.equal(result.master.rmsAvg, 0.30000000000000004)
  })
  it('master peak/lufs max', () => {
    const result = aggregateMeterResult({ samples: [sample(0), sample(50, { master: { rms: 0.2, peak: 0.99, lufsApprox: -9 } })] })
    assert.equal(result.master.peakMax, 0.99)
    assert.equal(result.master.lufsApproxMax, -9)
  })
  it('track max rms/peak dB', () => {
    const result = aggregateMeterResult({ samples: [sample(0), sample(50, { tracks: { trk_1: { rms: 0.3, rmsDb: -10, peak: 0.7, peakDb: -3 } } })] })
    assert.equal(result.tracks.trk_1.maxRms, 0.3)
    assert.equal(result.tracks.trk_1.maxPeak, 0.7)
    assert.equal(result.tracks.trk_1.maxRmsDb, -10)
    assert.equal(result.tracks.trk_1.maxPeakDb, -3)
    assert.equal(result.tracks.trk_1.samples, 2)
  })
  it('missing meters ignored', () => {
    const result = aggregateMeterResult({ samples: [{ t: 0, master: { rms: 'x' }, tracks: { trk_1: { rms: 'y' } } }] })
    assert.equal(result.master.rmsAvg, null)
    assert.equal(result.tracks.trk_1.maxRms, null)
  })
  it('duration/transport/underruns passthrough', () => {
    const result = aggregateMeterResult({ samples: [], durationMs: 1875, underruns: 2, transport: { wasPlaying: false, prevBar: 0 } })
    assert.equal(result.durationMs, 1875)
    assert.equal(result.underruns, 2)
    assert.equal(result.transport.prevBar, 0)
  })
  it('constants', () => {
    assert.equal(METER_TIMEOUT_MS, 15000)
    assert.equal(METER_MAX_BARS, 4)
    assert.equal(METER_SAMPLE_INTERVAL_MS, 50)
  })
  for (let count = 1; count <= 8; count += 1) {
    it('aggregate ' + count + ' samples', () => {
      const samples = Array.from({ length: count }, (_, index) => sample(index * 50))
      const result = aggregateMeterResult({ samples })
      assert.equal(result.sampleCount, count)
      assert.ok(Math.abs(result.master.rmsAvg - 0.2) < 1e-9)
    })
  }
})

describe('v2.4 P1 meter bridge request/complete/timeout', () => {
  it('peek returns null when empty', () => {
    const state = {}
    assert.equal(peekMeterRequest(state, 0), null)
  })
  it('request/peek/complete lifecycle', async () => {
    const state = {}
    const promise = requestMeter(state, { fromBar: 1, bars: 2 })
    const request = peekMeterRequest(state, 0)
    assert.equal(request.params.fromBar, 1)
    assert.equal(request.params.bars, 2)
    assert.equal(pendingMeterCount(state), 1)
    completeMeterRequest(state, request.seq, { samples: [sample(0)] })
    const result = await promise
    assert.equal(result.sampleCount, 1)
    assert.equal(pendingMeterCount(state), 0)
  })
  it('bars clamped to 1..4', async () => {
    const state = {}
    const promise = requestMeter(state, { fromBar: 0, bars: 99 })
    assert.equal(peekMeterRequest(state, 0).params.bars, 4)
    completeMeterRequest(state, 1, { samples: [] })
    await promise
  })
  it('unknown seq returns false', () => {
    assert.equal(completeMeterRequest({}, 999, { samples: [] }), false)
  })
  it('error rejects with METER_FAILED', async () => {
    const state = {}
    const promise = requestMeter(state, { fromBar: 0, bars: 1 })
    const request = peekMeterRequest(state, 0)
    completeMeterRequest(state, request.seq, { error: '音频未启用' })
    await assert.rejects(promise, /音频未启用/)
  })
  it('timeout rejects with Chinese message', async () => {
    const state = {}
    const promise = requestMeter(state, { fromBar: 0, bars: 1 }, { timeoutMs: 20 })
    await assert.rejects(promise, /实时电平测量超时.*studio_quick_mix_check/)
  })
  it('clear rejects pending', async () => {
    const state = {}
    const promise = requestMeter(state, { fromBar: 0, bars: 1 })
    clearMeterRequests(state)
    await assert.rejects(promise, /已取消/)
    assert.equal(pendingMeterCount(state), 0)
  })
  it('seq increases', async () => {
    const state = {}
    const first = requestMeter(state, { fromBar: 0, bars: 1 })
    const firstRequest = peekMeterRequest(state, 0)
    const second = requestMeter(state, { fromBar: 1, bars: 1 })
    assert.ok(peekMeterRequest(state, firstRequest.seq).seq > firstRequest.seq)
    completeMeterRequest(state, firstRequest.seq, { samples: [] })
    const secondRequest = peekMeterRequest(state, 0)
    completeMeterRequest(state, secondRequest.seq, { samples: [] })
    await Promise.all([first, second])
  })
})

describe('v2.4 P1 studio_measure_live tool', () => {
  it('tool registered', async () => {
    const tools = await import('../src/host/tools.js')
    assert.ok(tools.TOOL_NAMES.includes('studio_measure_live'))
  })
  it('invalid fromBar/bars rejected without request', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      for (const args of [{ fromBar: -1 }, { fromBar: 1.5 }, { fromBar: 99 }, { bars: 0 }, { bars: 5 }, { bars: 1.5 }]) {
        const result = await exec('studio_measure_live', args)
        assert.equal(result.ok, false)
      }
      assert.equal(pendingMeterCount(state), 0)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('range beyond project rejected', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      const result = await exec('studio_measure_live', { fromBar: 7, bars: 2 })
      assert.equal(result.ok, false)
      assert.match(result.error, /超出曲长/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('default 1 bar and aggregates master/tracks', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      const promise = exec('studio_measure_live', {})
      let request = null
      for (let attempt = 0; attempt < 100; attempt += 1) { request = peekMeterRequest(state, 0); if (request) break; await new Promise((r) => setTimeout(r, 1)) }
      assert.deepEqual({ fromBar: request.params.fromBar, bars: request.params.bars }, { fromBar: 0, bars: 1 })
      assert.equal(request.params.revision, state.revision)
      completeMeterRequest(state, request.seq, { samples: [sample(0), sample(50)], durationMs: 1875, underruns: 0, transport: { wasPlaying: false, prevBar: 0 } })
      const result = await promise
      assert.equal(result.ok, true)
      assert.equal(result.bars, 1)
      assert.equal(result.sampleCount, 2)
      assert.equal(result.master.rmsAvg, 0.2)
      assert.equal(result.tracks.trk_1.maxRms, 0.1)
      assert.equal(result.durationMs, 1875)
      assert.match(result.note, /studio_render_preview/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('fromBar/bars request is passed', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      const result = await runMeter(state, exec, { fromBar: 2, bars: 2 }, { samples: [sample(0)] })
      assert.equal(result.ok, true)
      assert.equal(result.fromBar, 2)
      assert.equal(result.bars, 2)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('does not change revision/undo', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      const revision = state.revision
      const undoDepth = state.historyState().undoDepth
      await runMeter(state, exec, {}, { samples: [sample(0)] })
      assert.equal(state.revision, revision)
      assert.equal(state.historyState().undoDepth, undoDepth)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('UI error returns Chinese failure', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      const promise = exec('studio_measure_live', {})
      let request = null
      for (let attempt = 0; attempt < 100; attempt += 1) { request = peekMeterRequest(state, 0); if (request) break; await new Promise((r) => setTimeout(r, 1)) }
      completeMeterRequest(state, request.seq, { error: '音频未启用，请点击窗口' })
      const result = await promise
      assert.equal(result.ok, false)
      assert.match(result.error, /音频未启用/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  for (let bars = 1; bars <= 4; bars += 1) {
    it('bars ' + bars + ' accepted', async () => {
      const { state, exec, dataDir } = await makeStateAndTools()
      try {
        const result = await runMeter(state, exec, { fromBar: 0, bars }, { samples: [sample(0)] })
        assert.equal(result.ok, true)
        assert.equal(result.bars, bars)
      } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
    })
  }
})

describe('v2.4 P1 meter routes', () => {
  async function makeServer() {
    const dataDir = await tempDir()
    const port = await freePort()
    const handle = await startServer({ dataDir, host: '127.0.0.1', port })
    handle.state.mutate({ tool: 'setup' }, (draft) => {
      draft.lengthBars = 8
      draft.title = 'meter route'
    })
    return { handle, dataDir, base: handle.url.replace(/\/$/, '') }
  }
  it('GET meter-request empty returns null request', async () => {
    const { handle, dataDir, base } = await makeServer()
    try {
      const body = await (await fetch(`${base}/studio/api/meter-request?since=0`)).json()
      assert.equal(body.ok, true)
      assert.equal(body.request, null)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('GET meter-request passes since and shape', async () => {
    const { handle, dataDir, base } = await makeServer()
    try {
      const body = await (await fetch(`${base}/studio/api/meter-request?since=5`)).json()
      assert.equal(body.ok, true)
      assert.equal(body.seq, 5)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('meter-done invalid seq returns Chinese error', async () => {
    const { handle, dataDir, base } = await makeServer()
    try {
      const response = await fetch(`${base}/studio/api/meter-done`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seq: 0, samples: [] }) })
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.match(body.error, /seq/)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('meter-done unknown seq returns error', async () => {
    const { handle, dataDir, base } = await makeServer()
    try {
      const body = await (await fetch(`${base}/studio/api/meter-done`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seq: 999, samples: [] }) })).json()
      assert.equal(body.ok, false)
      assert.match(body.error, /未知或已超时/)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('meter-done requires samples/master/error', async () => {
    const { handle, dataDir, base } = await makeServer()
    try {
      const body = await (await fetch(`${base}/studio/api/meter-done`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seq: 999 }) })).json()
      assert.equal(body.ok, false)
      assert.match(body.error, /samples/)
    } finally { await handle.close(); await cleanup(dataDir) }
  })

  it('full route lifecycle: meter-request pending -> meter-done -> tool resolves', async () => {
    const { handle, dataDir, base } = await makeServer()
    try {
      const tools = createTools({ defineTool: (options) => options, state: handle.state })
      const tool = tools.find((item) => item.name === 'studio_measure_live')
      const promise = tool.execute({ fromBar: 0, bars: 1 })
      let request = null
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const body = await (await fetch(`${base}/studio/api/meter-request?since=0`)).json()
        if (body.request) { request = body.request; break }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      assert.ok(request)
      assert.equal(request.fromBar, 0)
      assert.equal(request.bars, 1)
      assert.equal(typeof request.revision, 'number')
      const done = await (await fetch(`${base}/studio/api/meter-done`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seq: request.seq, durationMs: 1875, sampleCount: 2, samples: [sample(0), sample(50)], transport: { wasPlaying: false, prevBar: 0 } }),
      })).json()
      assert.equal(done.ok, true)
      const result = await promise
      assert.equal(result.ok, true)
      assert.equal(result.master.rmsAvg, 0.2)
      assert.equal(result.tracks.trk_1.maxRms, 0.1)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('routes static paths present', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes("case '/meter-request':"))
    assert.ok(source.includes("case '/meter-done':"))
    assert.ok(source.includes('peekMeterRequest'))
    assert.ok(source.includes('completeMeterRequest'))
  })
  for (let bars = 1; bars <= 4; bars += 1) {
    it('aggregate route shape case ' + bars, () => {
      const result = aggregateMeterResult({ samples: [sample(0)] })
      assert.equal(result.tracks.trk_1.samples, 1)
    })
  }
})
