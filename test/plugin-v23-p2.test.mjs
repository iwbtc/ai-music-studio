/** v2.3 P2: plugin parameter automation host tools/routes/ops. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { describe, it } from 'node:test'
import * as model from '../src/shared/model.js'
import * as ops from '../src/host/ops.js'
import { createState } from '../src/host/state.js'
import { createTools } from '../src/host/tools.js'
import { startServer } from '../src/standalone/server.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'aims-p2-')) }
async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true }).catch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
}
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
}

function makeProject() {
  const project = model.createEmptyProject()
  project.lengthBars = 4
  const inst = ops.addTrack(project, {
    kind: 'synth', engine: 'vst3', name: 'Inst',
    vst3: { pluginId: 'vst3_inst', name: 'Inst', kind: 'instrument', isInstrument: true, params: {} },
  })
  const pad = ops.addTrack(project, { kind: 'synth', name: 'Pad', preset: 'warm_pad' })
  const effect = ops.addEffect(project, { target: pad.trackId, type: 'vst3', vst3: { pluginId: 'vst3_fx', name: 'Fx', kind: 'effect', isInstrument: false, params: {} } })
  return { project, trackId: inst.trackId, effectTrackId: pad.trackId, effectId: effect.effectId }
}

async function makeStateAndTools() {
  const dataDir = await tempDir()
  const state = createState({ dataDir })
  await state.ready
  const made = makeProject()
  state.mutate({ tool: 'setup' }, (draft) => {
    draft.tracks = made.project.tracks
    draft.title = 'P2'
    draft.lengthBars = 4
  })
  const tools = createTools({ defineTool: (options) => options, state })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { dataDir, state, byName, exec: (name, args) => byName.get(name).execute(args), ...made }
}

async function makeServerWithProject() {
  const dataDir = await tempDir()
  const port = await freePort()
  const handle = await startServer({ dataDir, host: '127.0.0.1', port })
  const made = makeProject()
  handle.state.mutate({ tool: 'setup' }, (draft) => {
    draft.tracks = made.project.tracks
    draft.title = 'P2 route'
    draft.lengthBars = 4
  })
  return { handle, dataDir, base: handle.url.replace(/\/$/, ''), ...made }
}

describe('v2.3 P2 ops pluginAutomation', () => {
  it('set instrument track curve', () => {
    const { project, trackId } = makeProject()
    const result = ops.setPluginAutomation(project, { trackId, paramId: 1, points: [{ beat: 0, value: 0.2 }, { beat: 4, value: 0.8 }] })
    assert.equal(result.instanceKey, 'track')
    assert.equal(result.curve.points.length, 2)
    assert.equal(project.tracks[0].pluginAutomation.track['1'].points[1].value, 0.8)
  })
  it('set effect curve via effectId', () => {
    const { project, effectId } = makeProject()
    const result = ops.setPluginAutomation(project, { effectId, paramId: 2, points: [{ beat: 0, value: 0.5 }] })
    assert.equal(result.instanceKey, `effect:${effectId}`)
    assert.equal(project.tracks[1].pluginAutomation[`effect:${effectId}`]['2'].points.length, 1)
  })
  it('enabled false preserved', () => {
    const { project, trackId } = makeProject()
    ops.setPluginAutomation(project, { trackId, paramId: 0, points: [], enabled: false })
    assert.equal(project.tracks[0].pluginAutomation.track['0'].enabled, false)
  })
  it('points sorted by beat', () => {
    const { project, trackId } = makeProject()
    const result = ops.setPluginAutomation(project, { trackId, paramId: 0, points: [{ beat: 8, value: 0.2 }, { beat: 2, value: 0.8 }] })
    assert.deepEqual(result.curve.points.map((point) => point.beat), [2, 8])
  })
  it('beats clamped to project length', () => {
    const { project, trackId } = makeProject()
    const result = ops.setPluginAutomation(project, { trackId, paramId: 0, points: [{ beat: -5, value: -1 }, { beat: 999, value: 2 }] })
    assert.deepEqual(result.curve.points, [{ beat: 0, value: 0 }, { beat: 16, value: 1 }])
  })
  it('duplicate beats deduped', () => {
    const { project, trackId } = makeProject()
    const result = ops.setPluginAutomation(project, { trackId, paramId: 0, points: [{ beat: 1, value: 0.1 }, { beat: 1, value: 0.9 }] })
    assert.equal(result.curve.points.length, 1)
    assert.equal(result.curve.points[0].value, 0.1)
  })
  it('caps 256 points', () => {
    const { project, trackId } = makeProject()
    const points = Array.from({ length: 400 }, (_, index) => ({ beat: index * 0.01, value: 0.5 }))
    const result = ops.setPluginAutomation(project, { trackId, paramId: 0, points })
    assert.equal(result.curve.points.length, 256)
  })
  it('caps 16 curves per track', () => {
    const { project, trackId } = makeProject()
    for (let index = 0; index < 16; index += 1) ops.setPluginAutomation(project, { trackId, paramId: index, points: [] })
    assert.throws(() => ops.setPluginAutomation(project, { trackId, paramId: 16, points: [] }), /16 条/)
  })
  it('overwrites existing curve (no count growth)', () => {
    const { project, trackId } = makeProject()
    ops.setPluginAutomation(project, { trackId, paramId: 1, points: [{ beat: 0, value: 0.2 }] })
    ops.setPluginAutomation(project, { trackId, paramId: 1, points: [{ beat: 0, value: 0.9 }] })
    assert.equal(project.tracks[0].pluginAutomation.track['1'].points[0].value, 0.9)
  })
  it('invalid paramId rejected', () => {
    const { project, trackId } = makeProject()
    assert.throws(() => ops.setPluginAutomation(project, { trackId, paramId: -1, points: [] }), /paramId/)
  })
  it('missing target rejected', () => {
    const { project } = makeProject()
    assert.throws(() => ops.setPluginAutomation(project, { paramId: 0, points: [] }), /trackId 或 effectId/)
  })
  it('get all curves for instance', () => {
    const { project, trackId } = makeProject()
    ops.setPluginAutomation(project, { trackId, paramId: 1, points: [] })
    ops.setPluginAutomation(project, { trackId, paramId: 2, points: [] })
    const result = ops.getPluginAutomation(project, { trackId })
    assert.equal(result.count, 2)
    assert.ok(result.curves['1'])
  })
  it('get filtered paramId', () => {
    const { project, trackId } = makeProject()
    ops.setPluginAutomation(project, { trackId, paramId: 1, points: [] })
    ops.setPluginAutomation(project, { trackId, paramId: 2, points: [] })
    const result = ops.getPluginAutomation(project, { trackId, paramId: 2 })
    assert.equal(result.count, 1)
    assert.equal(result.curves['1'], undefined)
  })
  it('get empty when unset', () => {
    const { project, trackId } = makeProject()
    const result = ops.getPluginAutomation(project, { trackId })
    assert.equal(result.count, 0)
  })
  it('clear one curve', () => {
    const { project, trackId } = makeProject()
    ops.setPluginAutomation(project, { trackId, paramId: 1, points: [] })
    ops.setPluginAutomation(project, { trackId, paramId: 2, points: [] })
    const result = ops.clearPluginAutomation(project, { trackId, paramId: 1 })
    assert.equal(result.removed, 1)
    assert.equal(project.tracks[0].pluginAutomation.track['1'], undefined)
    assert.ok(project.tracks[0].pluginAutomation.track['2'])
  })
  it('clear entire instance', () => {
    const { project, trackId } = makeProject()
    ops.setPluginAutomation(project, { trackId, paramId: 1, points: [] })
    const result = ops.clearPluginAutomation(project, { trackId })
    assert.equal(result.removed, 1)
    assert.equal(project.tracks[0].pluginAutomation, undefined)
  })
  it('clear on absent automation is no-op', () => {
    const { project, trackId } = makeProject()
    const result = ops.clearPluginAutomation(project, { trackId })
    assert.equal(result.removed, 0)
    assert.equal(result.cleared, false)
  })
})

describe('v2.3 P2 tools automation', () => {
  it('set tool writes curve + undo label/revision', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      const revision = state.revision
      const result = await exec('studio_set_plugin_automation', { trackId, paramId: 1, points: [{ beat: 0, value: 0.2 }] })
      assert.equal(result.ok, true)
      assert.equal(result.undoLabel, '编辑插件自动化')
      assert.ok(result.revision > revision)
      assert.equal(state.project.tracks[0].pluginAutomation.track['1'].points[0].value, 0.2)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('set tool undo/redo restores curve', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      await exec('studio_set_plugin_automation', { trackId, paramId: 1, points: [{ beat: 0, value: 0.2 }] })
      await state.undo()
      assert.equal(state.project.tracks[0].pluginAutomation, undefined)
      await state.redo()
      assert.equal(state.project.tracks[0].pluginAutomation.track['1'].points.length, 1)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('set tool mergeKey merges consecutive edits', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      const before = state.historyState().undoDepth
      await exec('studio_set_plugin_automation', { trackId, paramId: 1, points: [{ beat: 0, value: 0.1 }], mergeKey: 'g1' })
      await exec('studio_set_plugin_automation', { trackId, paramId: 1, points: [{ beat: 0, value: 0.2 }], mergeKey: 'g1' })
      assert.equal(state.historyState().undoDepth, before + 1)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('set tool effect target', async () => {
    const { state, exec, dataDir, effectId } = await makeStateAndTools()
    try {
      const result = await exec('studio_set_plugin_automation', { effectId, paramId: 2, points: [{ beat: 0, value: 0.4 }] })
      assert.equal(result.ok, true)
      assert.equal(result.instanceKey, `effect:${effectId}`)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('get tool returns curves', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      await exec('studio_set_plugin_automation', { trackId, paramId: 1, points: [{ beat: 0, value: 0.5 }] })
      const result = await exec('studio_get_plugin_automation', { trackId })
      assert.equal(result.ok, true)
      assert.equal(result.curves['1'].points[0].value, 0.5)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('clear tool removes and bumps revision', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      await exec('studio_set_plugin_automation', { trackId, paramId: 1, points: [] })
      const revision = state.revision
      const result = await exec('studio_clear_plugin_automation', { trackId, paramId: 1 })
      assert.equal(result.ok, true)
      assert.equal(result.removed, 1)
      assert.ok(result.revision > revision)
      assert.equal(state.project.tracks[0].pluginAutomation, undefined)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('clear tool undo label', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      await exec('studio_set_plugin_automation', { trackId, paramId: 1, points: [] })
      await exec('studio_clear_plugin_automation', { trackId })
      assert.equal(state.historyState().undoLabel, '清除插件自动化')
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('tool invalid target Chinese error', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      const result = await exec('studio_set_plugin_automation', { paramId: 1, points: [] })
      assert.equal(result.ok, false)
      assert.match(result.error, /trackId 或 effectId/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('get_project exposes pluginAutomation', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      await exec('studio_set_plugin_automation', { trackId, paramId: 1, points: [{ beat: 0, value: 0.6 }] })
      const overview = ops.getProjectOverview(state.project)
      const track = overview.tracks.find((item) => item.id === trackId)
      assert.equal(track.pluginAutomation.track['1'].points[0].value, 0.6)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('P2 tool names registered', async () => {
    const tools = await import('../src/host/tools.js')
    for (const name of ['studio_set_plugin_automation', 'studio_clear_plugin_automation', 'studio_get_plugin_automation']) assert.ok(tools.TOOL_NAMES.includes(name))
  })
})

describe('v2.3 P2 routes automation', () => {
  it('GET plugin-automation empty', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      const response = await fetch(`${base}/studio/api/plugins/external/plugin-automation?trackId=${trackId}`)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.count, 0)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('POST plugin-automation writes + revision', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      const revision = handle.state.revision
      const response = await fetch(`${base}/studio/api/plugins/external/plugin-automation`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId, paramId: 1, points: [{ beat: 0, value: 0.2 }] }),
      })
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.undoLabel, '编辑插件自动化')
      assert.ok(body.revision > revision)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('POST plugin-automation mergeKey one undo', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      const before = handle.state.historyState().undoDepth
      for (const value of [0.1, 0.2]) {
        await fetch(`${base}/studio/api/plugins/external/plugin-automation`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trackId, paramId: 1, points: [{ beat: 0, value }], mergeKey: 'canvas' }),
        })
      }
      assert.equal(handle.state.historyState().undoDepth, before + 1)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('DELETE plugin-automation clears one', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      await fetch(`${base}/studio/api/plugins/external/plugin-automation`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId, paramId: 1, points: [] }),
      })
      const response = await fetch(`${base}/studio/api/plugins/external/plugin-automation?trackId=${trackId}&paramId=1`, { method: 'DELETE' })
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.removed, 1)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('POST plugin-automation/clear clears instance', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      await fetch(`${base}/studio/api/plugins/external/plugin-automation`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId, paramId: 1, points: [] }),
      })
      const response = await fetch(`${base}/studio/api/plugins/external/plugin-automation/clear`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId }),
      })
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.removed, 1)
      assert.equal(body.undoLabel, '清除插件自动化')
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('POST plugin-automation invalid target error', async () => {
    const { handle, dataDir, base } = await makeServerWithProject()
    try {
      const response = await fetch(`${base}/studio/api/plugins/external/plugin-automation`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paramId: 1, points: [] }),
      })
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.match(body.error, /trackId 或 effectId/)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('routes static aliases present', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes("case '/plugins/external/plugin-automation':"))
    assert.ok(source.includes("case '/plugins/external/plugin-automation/clear':"))
  })
})

describe('v2.3 P2 model/audio contract shape', () => {
  it('normalize keeps effect instanceKey', () => {
    const automation = model.normalizePluginAutomation({ 'effect:fx_1': { 3: { enabled: false, points: [{ beat: 1, value: 0.2 }] } } })
    assert.equal(automation['effect:fx_1']['3'].enabled, false)
  })
  it('normalize drops invalid instance key', () => {
    const automation = model.normalizePluginAutomation({ bad: { 1: { points: [] } } })
    assert.deepEqual(automation, {})
  })
  for (let index = 0; index < 8; index += 1) {
    it('beat clamp/roundtrip case ' + index, () => {
      const automation = model.normalizePluginAutomation({ track: { [index]: { points: [{ beat: index + 0.123456, value: 0 }] } } }, { maxBeat: 16 })
      assert.equal(automation.track[index].points[0].beat, index + 0.123456)
    })
  }
  for (let index = 0; index < 8; index += 1) {
    it('enabled flag case ' + index, () => {
      const automation = model.normalizePluginAutomation({ track: { 0: { enabled: index % 2 === 0, points: [] } } })
      assert.equal(automation.track['0'].enabled, index % 2 === 0)
    })
  }
  it('audio contract instance IDs documented', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(path.join(ROOT, 'src/host/ops.js'), 'utf8')
    assert.ok(source.includes("instanceKey: effect ? `effect:${effect.id}` : 'track'"))
  })
})
