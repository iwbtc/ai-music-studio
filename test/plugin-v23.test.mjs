/** v2.3 P0: plugin parameter writeback, undo/mergeKey, preset/automation normalize, param cache. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as model from '../src/shared/model.js'
import * as ops from '../src/host/ops.js'
import { createState } from '../src/host/state.js'
import { createTools } from '../src/host/tools.js'
import { createPluginService } from '../src/host/plugin-service.js'
import { startServer } from '../src/standalone/server.mjs'
import { createServer as createNetServer } from 'node:net'

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'aims-v23-')) }

function makeProject() {
  const project = model.createEmptyProject()
  project.title = 'v2.3 P0'
  project.lengthBars = 4
  const inst = ops.addTrack(project, {
    kind: 'synth', engine: 'vst3', name: 'Inst',
    vst3: { pluginId: 'vst3_inst', name: 'Inst', kind: 'instrument', isInstrument: true, params: { 0: 0.1 } },
  })
  const pad = ops.addTrack(project, { kind: 'synth', name: 'Pad', preset: 'warm_pad' })
  const effect = ops.addEffect(project, { target: pad.trackId, type: 'vst3', vst3: { pluginId: 'vst3_fx', name: 'Fx', kind: 'effect', isInstrument: false, params: { 2: 0.2 } } })
  return { project, trackId: inst.trackId, effectTrackId: pad.trackId, effectId: effect.effectId }
}

async function makeStateWithProject() {
  const dataDir = await tempDir()
  const state = createState({ dataDir })
  await state.ready
  state.mutate({ tool: 'setup', undoLabel: 'setup' }, (draft) => {
    const made = makeProject()
    draft.tracks = made.project.tracks
    draft.patterns = made.project.patterns
    draft.clips = made.project.clips
    draft.title = 'v2.3 P0'
    draft.lengthBars = 4
  })
  const tools = createTools({ defineTool: (options) => options, state })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = (name, args) => byName.get(name).execute(args)
  return { dataDir, state, exec, byName }
}

describe('v2.3 P0 model preset/pluginAutomation', () => {
  it('normalizePluginPreset basic/clamps', () => {
    assert.deepEqual(model.normalizePluginPreset({ listId: 1, index: 3, name: ' P ' }), { listId: 1, index: 3, name: 'P' })
    assert.deepEqual(model.normalizePluginPreset({ index: -2 }), { listId: null, index: 0, name: '' })
    assert.equal(model.normalizePluginPreset({}), null)
    assert.equal(model.normalizePluginPreset('x'), null)
  })
  it('normalizeExternalPlugin preserves preset', () => {
    const plugin = model.normalizeExternalPlugin({ pluginId: 'p', preset: { listId: 0, index: 2, name: 'Init' } })
    assert.deepEqual(plugin.preset, { listId: 0, index: 2, name: 'Init' })
  })
  it('normalizePluginAutomation basic structure', () => {
    const automation = model.normalizePluginAutomation({
      track: { 0: { enabled: true, points: [{ beat: 0, value: 0.2 }, { beat: 4, value: 0.8 }] } },
      'effect:fx_1': { 2: { points: [{ beat: 2, value: 1.2 }] } },
      bogus: { 1: { points: [] } },
    }, { maxBeat: 16 })
    assert.deepEqual(Object.keys(automation).sort(), ['effect:fx_1', 'track'])
    assert.equal(automation.track[0].points[1].value, 0.8)
    assert.equal(automation['effect:fx_1'][2].points[0].value, 1)
  })
  it('normalizePluginAutomation clamps beats/values and dedupes', () => {
    const automation = model.normalizePluginAutomation({ track: { 0: { points: [{ beat: -3, value: -1 }, { beat: 0, value: 0.5 }, { beat: 99, value: 3 }] } } }, { maxBeat: 8 })
    assert.deepEqual(automation.track[0].points, [{ beat: 0, value: 0 }, { beat: 8, value: 1 }])
  })
  it('normalizePluginAutomation caps 16 curves', () => {
    const raw = { track: {} }
    for (let index = 0; index < 30; index += 1) raw.track[index] = { points: [{ beat: 0, value: 0.5 }] }
    assert.equal(Object.keys(model.normalizePluginAutomation(raw).track).length, 16)
  })
  it('normalizePluginAutomation caps 256 points', () => {
    const points = Array.from({ length: 400 }, (_, index) => ({ beat: index * 0.01, value: 0.5 }))
    const automation = model.normalizePluginAutomation({ track: { 0: { points } } })
    assert.equal(automation.track[0].points.length, 256)
  })
  it('normalizeProject preserves pluginAutomation and preset', () => {
    const { project } = makeProject()
    project.tracks[0].vst3.preset = { listId: 0, index: 1, name: 'Init' }
    project.tracks[0].pluginAutomation = { track: { 0: { enabled: true, points: [{ beat: 0, value: 0.4 }] } } }
    const restored = model.normalizeProject(JSON.parse(JSON.stringify(project)))
    assert.deepEqual(restored.tracks[0].vst3.preset, { listId: 0, index: 1, name: 'Init' })
    assert.equal(restored.tracks[0].pluginAutomation.track['0'].points[0].value, 0.4)
  })
  it('getProjectOverview exposes preset and pluginAutomation', () => {
    const { project, trackId } = makeProject()
    project.tracks[0].vst3.preset = { listId: 0, index: 2, name: 'P' }
    project.tracks[0].pluginAutomation = { track: { 0: { enabled: true, points: [{ beat: 0, value: 0.5 }] } } }
    const view = ops.getProjectOverview(project).tracks.find((item) => item.id === trackId)
    assert.equal(view.vst3.preset.index, 2)
    assert.equal(view.pluginAutomation.track['0'].enabled, true)
  })
})

describe('v2.3 P0 setPluginParameter op', () => {
  it('writes track.vst3.params and clamps value', () => {
    const { project, trackId } = makeProject()
    const result = ops.setPluginParameter(project, { trackId, paramId: 3, value: 1.5 })
    assert.equal(result.value, 1)
    assert.equal(project.tracks[0].vst3.params['3'], 1)
    assert.equal(result.instanceKey, 'track')
  })
  it('writes effect.vst3.params via effectId only', () => {
    const { project, effectId } = makeProject()
    const result = ops.setPluginParameter(project, { effectId, paramId: 2, value: 0.33 })
    const effect = project.tracks[1].effects[0]
    assert.equal(effect.vst3.params['2'], 0.33)
    assert.equal(result.instanceKey, `effect:${effectId}`)
  })
  it('validates pluginId mismatch', () => {
    const { project, trackId } = makeProject()
    assert.throws(() => ops.setPluginParameter(project, { trackId, pluginId: 'other', paramId: 0, value: 0.2 }), /pluginId 不匹配/)
  })
  it('validates non-vst3 track', () => {
    const { project, effectTrackId } = makeProject()
    assert.throws(() => ops.setPluginParameter(project, { trackId: effectTrackId, paramId: 0, value: 0.2 }), /VST3 乐器轨/)
  })
  it('validates unknown effectId', () => {
    const { project } = makeProject()
    assert.throws(() => ops.setPluginParameter(project, { effectId: 'fx_missing', paramId: 0, value: 0.2 }), /找不到 VST3 效果器/)
  })
  it('validates invalid paramId/value', () => {
    const { project, trackId } = makeProject()
    assert.throws(() => ops.setPluginParameter(project, { trackId, paramId: -1, value: 0.2 }), /paramId/)
    assert.throws(() => ops.setPluginParameter(project, { trackId, paramId: 0, value: 'x' }), /value/)
  })
  it('requires trackId or effectId', () => {
    const { project } = makeProject()
    assert.throws(() => ops.setPluginParameter(project, { paramId: 0, value: 0.2 }), /trackId 或 effectId/)
  })
})

describe('v2.3 P0 tool writeback + undo/mergeKey', () => {
  it('tool writes params, bumps revision, undo/redo', async () => {
    const { state, exec, dataDir } = await makeStateWithProject()
    try {
      const trackId = state.project.tracks[0].id
      const revision = state.revision
      const result = await exec('studio_set_plugin_parameter', { trackId, paramId: 1, value: 0.42 })
      assert.equal(result.ok, true)
      assert.equal(result.revision, state.revision)
      assert.equal(state.project.tracks[0].vst3.params['1'], 0.42)
      assert.ok(state.revision > revision)
      assert.equal((await state.undo()).ok, true)
      assert.equal(state.project.tracks[0].vst3.params['1'], undefined)
      assert.equal((await state.redo()).ok, true)
      assert.equal(state.project.tracks[0].vst3.params['1'], 0.42)
    } finally {
      await state.flush(); state.dispose(); await rm(dataDir, { recursive: true, force: true })
    }
  })
  it('tool effect target writeback', async () => {
    const { state, exec, dataDir } = await makeStateWithProject()
    try {
      const trackId = state.project.tracks[1].id
      const effectId = state.project.tracks[1].effects[0].id
      const result = await exec('studio_set_plugin_parameter', { trackId, effectId, paramId: 2, value: 0.7 })
      assert.equal(result.ok, true)
      assert.equal(state.project.tracks[1].effects[0].vst3.params['2'], 0.7)
    } finally {
      await state.flush(); state.dispose(); await rm(dataDir, { recursive: true, force: true })
    }
  })
  it('mergeKey merges consecutive edits into one undo step', async () => {
    const { state, exec, dataDir } = await makeStateWithProject()
    try {
      const trackId = state.project.tracks[0].id
      const depth = state.historyState?.().undoDepth ?? 1
      await exec('studio_set_plugin_parameter', { trackId, paramId: 1, value: 0.1, mergeKey: 'drag-1' })
      const depthAfterFirst = state.historyState?.().undoDepth ?? 1
      await exec('studio_set_plugin_parameter', { trackId, paramId: 1, value: 0.2, mergeKey: 'drag-1' })
      await exec('studio_set_plugin_parameter', { trackId, paramId: 1, value: 0.3, mergeKey: 'drag-1' })
      const depthAfterMerge = state.historyState?.().undoDepth ?? 1
      assert.equal(depthAfterMerge, depthAfterFirst)
      assert.ok(depthAfterFirst > depth)
      await state.undo()
      assert.equal(state.project.tracks[0].vst3.params['1'], undefined)
    } finally {
      await state.flush(); state.dispose(); await rm(dataDir, { recursive: true, force: true })
    }
  })
  it('new mergeKey creates a new undo step', async () => {
    const { state, exec, dataDir } = await makeStateWithProject()
    try {
      const trackId = state.project.tracks[0].id
      await exec('studio_set_plugin_parameter', { trackId, paramId: 1, value: 0.1, mergeKey: 'drag-1' })
      const first = state.historyState().undoDepth
      await exec('studio_set_plugin_parameter', { trackId, paramId: 1, value: 0.2, mergeKey: 'drag-2' })
      assert.equal(state.historyState().undoDepth, first + 1)
    } finally {
      await state.flush(); state.dispose(); await rm(dataDir, { recursive: true, force: true })
    }
  })
  it('non-merge mutation resets merge chain', async () => {
    const { state, exec, dataDir } = await makeStateWithProject()
    try {
      const trackId = state.project.tracks[0].id
      await exec('studio_set_plugin_parameter', { trackId, paramId: 1, value: 0.1, mergeKey: 'drag-1' })
      state.mutate({ tool: 'other', undoLabel: 'other' }, (draft) => { draft.title = 'changed' })
      const before = state.historyState().undoDepth
      await exec('studio_set_plugin_parameter', { trackId, paramId: 1, value: 0.4, mergeKey: 'drag-1' })
      assert.equal(state.historyState().undoDepth, before + 1)
    } finally {
      await state.flush(); state.dispose(); await rm(dataDir, { recursive: true, force: true })
    }
  })
  it('pluginId mismatch returns Chinese error from tool', async () => {
    const { state, exec, dataDir } = await makeStateWithProject()
    try {
      const trackId = state.project.tracks[0].id
      const result = await exec('studio_set_plugin_parameter', { trackId, pluginId: 'other', paramId: 0, value: 0.2 })
      assert.equal(result.ok, false)
      assert.match(result.error, /pluginId 不匹配/)
    } finally {
      await state.flush(); state.dispose(); await rm(dataDir, { recursive: true, force: true })
    }
  })
  it('tool without target requires pluginId and marks deprecated when used', async () => {
    const { state, exec, dataDir } = await makeStateWithProject()
    try {
      const result = await exec('studio_set_plugin_parameter', { paramId: 0, value: 0.2 })
      assert.equal(result.ok, false)
      assert.match(result.error, /trackId 或 effectId/)
    } finally {
      await state.flush(); state.dispose(); await rm(dataDir, { recursive: true, force: true })
    }
  })
  it('tool result includes params/param/revision/undoLabel', async () => {
    const { state, exec, dataDir } = await makeStateWithProject()
    try {
      const trackId = state.project.tracks[0].id
      const result = await exec('studio_set_plugin_parameter', { trackId, paramId: 5, value: 0.6 })
      assert.equal(result.undoLabel, '调整插件参数')
      assert.deepEqual(result.param, { paramId: 5, value: 0.6 })
      assert.equal(result.params['5'], 0.6)
      assert.equal(typeof result.revision, 'number')
      assert.equal(result.deprecated, false)
    } finally {
      await state.flush(); state.dispose(); await rm(dataDir, { recursive: true, force: true })
    }
  })
  it('mergeKey response merged=true', async () => {
    const { state, exec, dataDir } = await makeStateWithProject()
    try {
      const trackId = state.project.tracks[0].id
      const result = await exec('studio_set_plugin_parameter', { trackId, paramId: 1, value: 0.2, mergeKey: 'g1' })
      assert.equal(result.merged, true)
    } finally {
      await state.flush(); state.dispose(); await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('v2.3 P0 plugin-service parameter cache', () => {
  function makeClient() {
    return {
      async inspect(target) { return [{ name: 'Mock', category: 'Audio Module Class', subCategories: 'Fx', classId: 'mockclass', vendor: 'M', version: '1' }] },
      async load() { return {} },
      async getParamsList() { return { count: 2, items: [{ id: 0, title: 'A', value: 0.1 }, { id: 1, title: 'B', value: 0.2 }] } },
      async setParameter() { return {} },
      async close() {},
    }
  }
  async function makeService() {
    const dataDir = await tempDir()
    const sourceDir = await tempDir()
    const { mkdir } = await import('node:fs/promises')
    const { writeFile } = await import('node:fs/promises')
    const bundle = path.join(sourceDir, 'Mock.vst3')
    await mkdir(path.join(bundle, 'Contents', 'x86_64-win'), { recursive: true })
    await writeFile(path.join(bundle, 'Contents', 'x86_64-win', 'Mock.vst3'), 'fake')
    const service = createPluginService({ dataDir, client: makeClient() })
    const installed = await service.install({ path: bundle })
    return { service, dataDir, sourceDir, pluginId: installed.plugin.pluginId }
  }
  it('noteParameterValue updates cached list value', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeService()
    try {
      const first = await service.parameters(pluginId)
      assert.equal(first.params[0].value, 0.1)
      assert.equal(service.noteParameterValue({ pluginId, paramId: 0, value: 0.9 }), true)
      const second = await service.parameters(pluginId)
      assert.equal(second.params[0].value, 0.9)
    } finally {
      await service.close(); await rm(dataDir, { recursive: true, force: true }); await rm(sourceDir, { recursive: true, force: true })
    }
  })
  it('noteParameterValue no cache returns false', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeService()
    try {
      assert.equal(service.noteParameterValue({ pluginId, paramId: 0, value: 0.5 }), false)
    } finally {
      await service.close(); await rm(dataDir, { recursive: true, force: true }); await rm(sourceDir, { recursive: true, force: true })
    }
  })
  it('noteParameterValue unknown param returns false', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeService()
    try {
      await service.parameters(pluginId)
      assert.equal(service.noteParameterValue({ pluginId, paramId: 99, value: 0.5 }), false)
    } finally {
      await service.close(); await rm(dataDir, { recursive: true, force: true }); await rm(sourceDir, { recursive: true, force: true })
    }
  })
})


async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
}

async function makeServerWithProject() {
  const dataDir = await tempDir()
  const port = await freePort()
  const handle = await startServer({ dataDir, host: '127.0.0.1', port, portAttempts: 1 })
  const made = makeProject()
  handle.state.mutate({ tool: 'setup', undoLabel: 'setup' }, (draft) => {
    draft.tracks = made.project.tracks
    draft.patterns = made.project.patterns
    draft.clips = made.project.clips
    draft.title = 'v2.3 Route'
    draft.lengthBars = 4
  })
  return { handle, dataDir, base: handle.url.replace(/\/$/, ''), trackId: made.trackId, effectTrackId: made.effectTrackId, effectId: made.effectId }
}

async function cleanupDir(dir) {
  await rm(dir, { recursive: true, force: true }).catch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
}

describe('v2.3 P0 set-param route writeback', () => {
  it('POST /plugins/external/set-param writes track params + bump revision', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      const revisionBefore = handle.state.revision
      const response = await fetch(base + '/studio/api/plugins/external/set-param', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId, paramId: 4, value: 0.55 }),
      })
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.trackId, trackId)
      assert.equal(body.param.value, 0.55)
      assert.equal(body.params['4'], 0.55)
      assert.equal(body.undoLabel, '调整插件参数')
      assert.ok(body.revision > revisionBefore)
      assert.equal(handle.state.project.tracks[0].vst3.params['4'], 0.55)
      assert.equal(handle.state.historyState().undoLabel, '调整插件参数')
    } finally { await handle.close(); await cleanupDir(dataDir) }
  })
  it('POST set-param effectId writes effect params', async () => {
    const { handle, dataDir, base, effectTrackId, effectId } = await makeServerWithProject()
    try {
      const response = await fetch(base + '/studio/api/plugins/external/set-param', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId: effectTrackId, effectId, paramId: 2, value: 0.25 }),
      })
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.effectId, effectId)
      assert.equal(body.instanceKey, 'effect:' + effectId)
      assert.equal(handle.state.project.tracks[1].effects[0].vst3.params['2'], 0.25)
    } finally { await handle.close(); await cleanupDir(dataDir) }
  })
  it('set-param mergeKey merges route edits into one undo', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      const before = handle.state.historyState().undoDepth
      for (const value of [0.1, 0.2, 0.3]) {
        await fetch(base + '/studio/api/plugins/external/set-param', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trackId, paramId: 6, value, mergeKey: 'route-drag' }),
        })
      }
      assert.equal(handle.state.historyState().undoDepth, before + 1)
      assert.equal(handle.state.project.tracks[0].vst3.params['6'], 0.3)
      const undoBody = handle.state.undo()
      assert.equal(undoBody.ok, true)
      assert.equal(handle.state.project.tracks[0].vst3.params['6'], undefined)
    } finally { await handle.close(); await cleanupDir(dataDir) }
  })
  it('set-param validation errors are Chinese and do not bump revision', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      const revisionBefore = handle.state.revision
      const response = await fetch(base + '/studio/api/plugins/external/set-param', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId, paramId: 0, value: 0.5, pluginId: 'wrong' }),
      })
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.match(body.error, /pluginId 不匹配/)
      assert.equal(handle.state.revision, revisionBefore)
    } finally { await handle.close(); await cleanupDir(dataDir) }
  })
})

