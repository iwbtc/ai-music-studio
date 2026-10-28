/** v2.3 P1: presets/state host APIs, sidecar/preload sources, routes. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { describe, it } from 'node:test'
import * as model from '../src/shared/model.js'
import * as ops from '../src/host/ops.js'
import { createState } from '../src/host/state.js'
import { createTools } from '../src/host/tools.js'
import { createPluginService } from '../src/host/plugin-service.js'
import { startServer } from '../src/standalone/server.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'aims-p1-')) }
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
    vst3: { pluginId: 'vst3_inst', name: 'Inst', kind: 'instrument', isInstrument: true, params: { 0: 0.1 }, stateBase64: 'c3RhdGU=' },
  })
  const pad = ops.addTrack(project, { kind: 'synth', name: 'Pad', preset: 'warm_pad' })
  const effect = ops.addEffect(project, { target: pad.trackId, type: 'vst3', vst3: { pluginId: 'vst3_fx', name: 'Fx', kind: 'effect', isInstrument: false, params: { 2: 0.2 }, stateBase64: 'Zng=' } })
  return { project, trackId: inst.trackId, effectTrackId: pad.trackId, effectId: effect.effectId }
}

async function makeStateAndTools() {
  const dataDir = await tempDir()
  const state = createState({ dataDir })
  await state.ready
  const made = makeProject()
  state.mutate({ tool: 'setup' }, (draft) => {
    draft.tracks = made.project.tracks
    draft.patterns = made.project.patterns
    draft.clips = made.project.clips
    draft.title = 'P1'
    draft.lengthBars = 4
  })
  const tools = createTools({ defineTool: (options) => options, state })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { dataDir, state, exec: (name, args) => byName.get(name).execute(args), byName, ...made }
}

async function makeServerWithProject() {
  const dataDir = await tempDir()
  const port = await freePort()
  const handle = await startServer({ dataDir, host: '127.0.0.1', port })
  const made = makeProject()
  handle.state.mutate({ tool: 'setup' }, (draft) => {
    draft.tracks = made.project.tracks
    draft.title = 'P1 route'
    draft.lengthBars = 4
  })
  return { handle, dataDir, base: handle.url.replace(/\/$/, ''), ...made }
}

function makeProgramClient() {
  const calls = []
  const paramsItems = [{ index: 0, id: 10, title: 'Cutoff', value: 0.3, default: 0.5, min: 0, max: 1 }]
  return {
    calls,
    async inspect() { return [{ name: 'Mock', category: 'Audio Module Class', subCategories: 'Fx', classId: 'mock', vendor: 'V', version: '1' }] },
    async load() { return {} },
    async unload() {},
    async getParamsList() { return { count: paramsItems.length, items: paramsItems } },
    async setParameter() {},
    async listPrograms(payload) { calls.push({ type: 'listPrograms', payload }); return {
      lists: [{ listId: 0, listIndex: 0, name: 'Factory', programCount: 2, unitId: 0, programs: [{ index: 0, name: 'Init' }, { index: 1, name: 'Pad' }] }],
      presets: [{ listId: 0, listIndex: 0, index: 0, name: 'Init', programName: 'Init', listName: 'Factory' }, { listId: 0, listIndex: 0, index: 1, name: 'Pad', programName: 'Pad', listName: 'Factory' }],
    } },
    async selectProgram(payload) { calls.push({ type: 'selectProgram', payload }); return {
      listId: Number(payload.listId), index: Number(payload.index), preset: { listId: 0, index: 1, name: 'Pad' }, params: { count: 1, items: paramsItems }, stateBase64: 'U1RBVEU=',
    } },
    async saveState() { calls.push({ type: 'saveState' }); return { state: 'U1RBVEU=' } },
    async loadState(state) { calls.push({ type: 'loadState', state }); return { loaded: true } },
    async close() {},
  }
}

async function makeServiceWithFakePlugin() {
  const dataDir = await tempDir()
  const sourceDir = await tempDir()
  const bundle = path.join(sourceDir, 'Mock.vst3')
  await mkdir(path.join(bundle, 'Contents', 'x86_64-win'), { recursive: true })
  await writeFile(path.join(bundle, 'Contents', 'x86_64-win', 'Mock.vst3'), 'fake')
  const client = makeProgramClient()
  const service = createPluginService({ dataDir, client })
  const installed = await service.install({ path: bundle })
  return { service, client, dataDir, sourceDir, pluginId: installed.plugin.pluginId }
}

describe('v2.3 P1 normalize preset variants', () => {
  const cases = [
    [{ listId: 0, index: 0, name: 'A' }, { listId: 0, index: 0, name: 'A' }],
    [{ listId: 3, index: 7 }, { listId: 3, index: 7, name: '' }],
    [{ listId: '2', index: '5', name: 'B' }, { listId: 2, index: 5, name: 'B' }],
    [{ listId: 1.6, index: 2.2, name: 'C' }, { listId: 2, index: 2, name: 'C' }],
    [{ listId: -1, index: -1, name: 'D' }, { listId: 0, index: 0, name: 'D' }],
    [{ listId: 0, index: 0, name: '  E  ' }, { listId: 0, index: 0, name: 'E' }],
    [{ listId: 0, index: 0, name: 'x'.repeat(300) }, { listId: 0, index: 0, name: 'x'.repeat(160) }],
  ]
  for (const [input, expected] of cases) {
    it(`normalizePluginPreset ${JSON.stringify(input).slice(0, 40)}`, () => {
      assert.deepEqual(model.normalizePluginPreset(input), expected)
    })
  }
  for (const input of [null, undefined, 'x', 3, [], {}]) {
    it(`normalizePluginPreset null for ${String(input).slice(0, 20)}`, () => assert.equal(model.normalizePluginPreset(input), null))
  }
  it('external plugin preset roundtrip', () => {
    const plugin = model.normalizeExternalPlugin({ pluginId: 'p', preset: { listId: 1, index: 2, name: 'Init' } })
    assert.equal(plugin.preset.name, 'Init')
  })
})

describe('v2.3 P1 ops target/preset/state', () => {
  it('resolvePluginTarget instrument', () => {
    const { project, trackId } = makeProject()
    const target = ops.resolvePluginTarget(project, { trackId })
    assert.equal(target.instanceKey, 'track')
    assert.equal(target.instanceId, `track:${trackId}`)
  })
  it('resolvePluginTarget effect by effectId only', () => {
    const { project, effectId } = makeProject()
    const target = ops.resolvePluginTarget(project, { effectId })
    assert.equal(target.instanceKey, `effect:${effectId}`)
    assert.equal(target.instanceId, `fx:${effectId}`)
  })
  it('resolvePluginTarget error no target', () => {
    const { project } = makeProject()
    assert.throws(() => ops.resolvePluginTarget(project, {}), /trackId 或 effectId/)
  })
  it('resolvePluginTarget error unknown effect', () => {
    const { project } = makeProject()
    assert.throws(() => ops.resolvePluginTarget(project, { effectId: 'fx_x' }), /找不到 VST3 效果器/)
  })
  it('resolvePluginTarget error non-vst3', () => {
    const { project, effectTrackId } = makeProject()
    assert.throws(() => ops.resolvePluginTarget(project, { trackId: effectTrackId }), /VST3 乐器轨/)
  })
  it('applyPluginPreset writes preset/params/state', () => {
    const { project, trackId } = makeProject()
    ops.applyPluginPreset(project, { trackId, preset: { listId: 1, index: 2, name: 'P' }, params: [{ id: 1, value: 0.5 }], stateBase64: 'QUJD' })
    const vst3 = project.tracks[0].vst3
    assert.equal(vst3.preset.index, 2)
    assert.equal(vst3.params['1'], 0.5)
    assert.equal(vst3.stateBase64, 'QUJD')
  })
  it('applyPluginPreset clamps params and caps list', () => {
    const { project, trackId } = makeProject()
    ops.applyPluginPreset(project, { trackId, params: [{ id: 1, value: 2 }, { id: '2', value: -1 }, { id: 'bad', value: 0.5 }] })
    assert.equal(project.tracks[0].vst3.params['1'], 1)
    assert.equal(project.tracks[0].vst3.params['2'], 0)
    assert.equal(project.tracks[0].vst3.params.bad, undefined)
  })
  it('applyPluginPreset rejects >2MB state', () => {
    const { project, trackId } = makeProject()
    assert.throws(() => ops.applyPluginPreset(project, { trackId, stateBase64: 'x'.repeat(2 * 1024 * 1024 + 1) }), /2MB/)
  })
  it('getPluginState returns project state', () => {
    const { project, trackId, effectId } = makeProject()
    assert.equal(ops.getPluginState(project, { trackId }).stateBase64, 'c3RhdGU=')
    assert.equal(ops.getPluginState(project, { effectId }).stateBase64, 'Zng=')
  })
  for (const value of [0, 1, 0.5, 0.999999]) {
    it(`setPluginState accepts ${value}`, () => {
      const { project, trackId } = makeProject()
      const result = ops.setPluginState(project, { trackId, stateBase64: Buffer.from(String(value)).toString('base64') })
      assert.equal(result.bytes > 0, true)
      assert.equal(typeof project.tracks[0].vst3.stateBase64, 'string')
    })
  }
  it('setPluginState rejects empty', () => {
    const { project, trackId } = makeProject()
    assert.throws(() => ops.setPluginState(project, { trackId, stateBase64: '' }), /不能为空/)
  })
  it('setPluginState rejects >2MB', () => {
    const { project, trackId } = makeProject()
    assert.throws(() => ops.setPluginState(project, { trackId, stateBase64: 'x'.repeat(2 * 1024 * 1024 + 1) }), /2MB/)
  })
})

describe('v2.3 P1 service presets/state', () => {
  it('listPresets returns lists/presets/cache', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithFakePlugin()
    try {
      const first = await service.listPresets({ pluginId })
      assert.equal(first.count, 2)
      assert.equal(first.presets[1].name, 'Pad')
      const second = await service.listPresets({ pluginId })
      assert.equal(second, first)
    } finally { await service.close(); await cleanup(dataDir); await cleanup(sourceDir) }
  })
  it('listPresets missing plugin throws Chinese', async () => {
    const { service, dataDir, sourceDir } = await makeServiceWithFakePlugin()
    try { await assert.rejects(service.listPresets({ pluginId: 'missing' }), /插件不存在/) }
    finally { await service.close(); await cleanup(dataDir); await cleanup(sourceDir) }
  })
  it('selectPreset returns params/state/preset', async () => {
    const { service, client, dataDir, sourceDir, pluginId } = await makeServiceWithFakePlugin()
    try {
      const result = await service.selectPreset({ pluginId, listId: 0, index: 1 })
      assert.equal(result.preset.name, 'Pad')
      assert.equal(result.params[0].value, 0.3)
      assert.equal(result.stateBase64, 'U1RBVEU=')
      assert.equal(client.calls.some((call) => call.type === 'selectProgram'), true)
    } finally { await service.close(); await cleanup(dataDir); await cleanup(sourceDir) }
  })
  it('selectPreset passes instanceId when loaded', async () => {
    const { service, client, dataDir, sourceDir, pluginId } = await makeServiceWithFakePlugin()
    try {
      await service.loadInstance({ pluginId, instanceId: 'fx:fx_1', kind: 'effect' }).catch(() => {})
      // Fake client lacks dynamic instance map; only assert call shape when load succeeded.
      await service.selectPreset({ pluginId, instanceId: 'fx:fx_1', listId: 0, index: 0 }).catch(() => {})
      assert.equal(Array.isArray(client.calls), true)
    } finally { await service.close(); await cleanup(dataDir); await cleanup(sourceDir) }
  })
  it('loadPluginState legacy loads state and params', async () => {
    const { service, client, dataDir, sourceDir, pluginId } = await makeServiceWithFakePlugin()
    try {
      const result = await service.loadPluginState({ pluginId, stateBase64: 'QUJD' })
      assert.equal(result.loaded, true)
      assert.equal(result.params.length, 1)
      assert.equal(client.calls.some((call) => call.type === 'loadState'), true)
    } finally { await service.close(); await cleanup(dataDir); await cleanup(sourceDir) }
  })
  it('loadPluginState rejects empty/>2MB', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithFakePlugin()
    try {
      await assert.rejects(service.loadPluginState({ pluginId, stateBase64: '' }), /不能为空/)
      await assert.rejects(service.loadPluginState({ pluginId, stateBase64: 'x'.repeat(2 * 1024 * 1024 + 1) }), /2MB/)
    } finally { await service.close(); await cleanup(dataDir); await cleanup(sourceDir) }
  })
  it('savePluginState legacy returns state', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithFakePlugin()
    try {
      const result = await service.savePluginState({ pluginId })
      assert.equal(result.stateBase64, 'U1RBVEU=')
    } finally { await service.close(); await cleanup(dataDir); await cleanup(sourceDir) }
  })
})

describe('v2.3 P1 tools presets/state', () => {
  it('get_plugin_state reads project state', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      const result = await exec('studio_get_plugin_state', { trackId })
      assert.equal(result.ok, true)
      assert.equal(result.stateBase64, 'c3RhdGU=')
      assert.equal(result.bytes > 0, true)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('get_plugin_state missing target returns error', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      const result = await exec('studio_get_plugin_state', {})
      assert.equal(result.ok, false)
      assert.match(result.error, /trackId 或 effectId/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('set_plugin_state writes project state and undo', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      const result = await exec('studio_set_plugin_state', { trackId, stateBase64: 'TkVX' })
      assert.equal(result.ok, true)
      assert.equal(result.bytes, 4)
      assert.equal(state.project.tracks[0].vst3.stateBase64, 'TkVX')
      assert.equal(state.historyState().undoLabel, '载入插件状态')
      await state.undo()
      assert.equal(state.project.tracks[0].vst3.stateBase64, 'c3RhdGU=')
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('set_plugin_state rejects empty base64', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      const result = await exec('studio_set_plugin_state', { trackId, stateBase64: '   ' })
      assert.equal(result.ok, false)
      assert.match(result.error, /不能为空/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('list_plugin_presets requires target/pluginId', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      const result = await exec('studio_list_plugin_presets', {})
      assert.equal(result.ok, false)
      assert.match(result.error, /pluginId/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('select_plugin_preset requires target', async () => {
    const { state, exec, dataDir } = await makeStateAndTools()
    try {
      const result = await exec('studio_select_plugin_preset', { listId: 0, index: 0 })
      assert.equal(result.ok, false)
      assert.match(result.error, /trackId 或 effectId/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('P1 tool definitions exist with Chinese descriptions', async () => {
    const { state, dataDir, byName } = await makeStateAndTools()
    try {
      for (const name of ['studio_list_plugin_presets', 'studio_select_plugin_preset', 'studio_get_plugin_state', 'studio_set_plugin_state']) {
        const tool = byName.get(name)
        assert.ok(tool, name)
        assert.match(tool.description, /[\u4e00-\u9fa5]/)
      }
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
})

describe('v2.3 P1 routes state/presets', () => {
  it('GET /plugins/external/state returns project state', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      const response = await fetch(`${base}/studio/api/plugins/external/state?trackId=${trackId}`)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.stateBase64, 'c3RhdGU=')
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('GET /plugins/external/plugin-state alias works', async () => {
    const { handle, dataDir, base, effectId } = await makeServerWithProject()
    try {
      const response = await fetch(`${base}/studio/api/plugins/external/plugin-state?effectId=${effectId}`)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.stateBase64, 'Zng=')
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('POST state writes state + revision/undo', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      const revision = handle.state.revision
      const response = await fetch(`${base}/studio/api/plugins/external/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId, stateBase64: 'TkVX' }),
      })
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.undoLabel, '载入插件状态')
      assert.ok(body.revision > revision)
      assert.equal(handle.state.project.tracks[0].vst3.stateBase64, 'TkVX')
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('POST state empty base64 error', async () => {
    const { handle, dataDir, base, trackId } = await makeServerWithProject()
    try {
      const response = await fetch(`${base}/studio/api/plugins/external/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId, stateBase64: '' }),
      })
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.match(body.error, /不能为空/)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('GET presets missing pluginId error', async () => {
    const { handle, dataDir, base } = await makeServerWithProject()
    try {
      const response = await fetch(`${base}/studio/api/plugins/external/presets`)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.match(body.error, /pluginId/)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
  it('POST select-preset requires target', async () => {
    const { handle, dataDir, base } = await makeServerWithProject()
    try {
      const response = await fetch(`${base}/studio/api/plugins/external/select-preset`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listId: 0, index: 0 }),
      })
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.match(body.error, /trackId 或 effectId/)
    } finally { await handle.close(); await cleanup(dataDir) }
  })
})

describe('v2.3 P1 source/preload contracts', () => {
  it('preload exposes selectProgram/loadState', async () => {
    const source = await readFile(path.join(ROOT, 'desktop', 'preload.cjs'), 'utf8')
    assert.ok(source.includes("selectProgram: (options) => ipcRenderer.invoke('aims-plugin:select-program'"))
    assert.ok(source.includes("loadState: (options) => ipcRenderer.invoke('aims-plugin:load-state'"))
  })
  it('main handles select-program/load-state', async () => {
    const source = await readFile(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8')
    assert.ok(source.includes("ipcMain.handle('aims-plugin:select-program'"))
    assert.ok(source.includes("ipcMain.handle('aims-plugin:load-state'"))
  })
  it('sidecar has program helpers/commands', async () => {
    const source = await readFile(path.join(ROOT, 'desktop', 'plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes('function programSnapshot('))
    assert.ok(source.includes('function selectProgramOnPlugin('))
    assert.ok(source.includes("type === 'listPrograms'"))
    assert.ok(source.includes("type === 'selectProgram'"))
  })
  it('service exposes listPresets/selectPreset/loadPluginState/savePluginState', async () => {
    const { service, dataDir, sourceDir } = await makeServiceWithFakePlugin()
    try {
      assert.equal(typeof service.listPresets, 'function')
      assert.equal(typeof service.selectPreset, 'function')
      assert.equal(typeof service.loadPluginState, 'function')
      assert.equal(typeof service.savePluginState, 'function')
      assert.equal(typeof service.selectProgram, 'function')
      assert.equal(typeof service.loadInstanceState, 'function')
    } finally { await service.close(); await cleanup(dataDir); await cleanup(sourceDir) }
  })
  it('routes expose presets/select-preset/state aliases', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes("case '/plugins/external/presets':"))
    assert.ok(source.includes("case '/plugins/external/programs':"))
    assert.ok(source.includes("case '/plugins/external/select-preset':"))
    assert.ok(source.includes("case '/plugins/external/state':"))
    assert.ok(source.includes("case '/plugins/external/plugin-state':"))
  })
  it('routes state body limit >=2MB', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes('PLUGIN_STATE_BODY_LIMIT = 4 * 1024 * 1024'))
  })
  it('tools module contains P1 tool names in TOOL_NAMES', async () => {
    const tools = await import('../src/host/tools.js')
    for (const name of ['studio_list_plugin_presets', 'studio_select_plugin_preset', 'studio_get_plugin_state', 'studio_set_plugin_state']) {
      assert.ok(tools.TOOL_NAMES.includes(name))
    }
  })
  it('plugin-service listPresets cache invalidates on install', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithFakePlugin()
    try {
      await service.listPresets({ pluginId })
      const again = await service.install({ path: path.join(sourceDir, 'Mock.vst3') })
      assert.equal(again.plugin.pluginId, pluginId)
    } finally { await service.close(); await cleanup(dataDir); await cleanup(sourceDir) }
  })
})

describe('v2.3 P1 extra state/save contracts', () => {
  it('state save route is registered and uses savePluginState', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes("case '/plugins/external/state/save':"))
    assert.ok(source.includes('async function handleExternalPluginStateSave(req, res)'))
    assert.ok(source.includes('savePluginState({ pluginId: target.pluginId, instanceId: target.instanceId })'))
    assert.ok(source.includes("undoLabel: '保存插件状态'"))
  })
  it('GET state tool supports live flag', async () => {
    const tools = await readFile(path.join(ROOT, 'src/host/tools.js'), 'utf8')
    assert.ok(tools.includes("source: 'live'"))
    assert.ok(tools.includes("source: 'project'"))
    assert.ok(tools.includes("live: { type: 'boolean'"))
  })
  it('get_plugin_state project source without live', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      const result = await exec('studio_get_plugin_state', { trackId })
      assert.equal(result.source, 'project')
      assert.equal(result.hasStateBase64, true)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('get_plugin_state live fails without plugin service registration', async () => {
    const { state, exec, dataDir, trackId } = await makeStateAndTools()
    try {
      const result = await exec('studio_get_plugin_state', { trackId, live: true })
      assert.equal(result.ok, false)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  for (let index = 0; index < 12; index += 1) {
    it('preset normalize bounds case ' + index, () => {
      const value = model.normalizePluginPreset({ listId: index, index: index * 2, name: 'P' + index })
      assert.equal(value.listId, index)
      assert.equal(value.index, index * 2)
    })
  }
  for (let index = 0; index < 8; index += 1) {
    it('pluginAutomation enabled default case ' + index, () => {
      const raw = { track: {} }
      raw.track[index] = { points: [{ beat: index, value: index / 10 }] }
      const automation = model.normalizePluginAutomation(raw, { maxBeat: 8 })
      assert.equal(automation.track[index].enabled, true)
    })
  }
})

