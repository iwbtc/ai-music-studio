/** v2.2 M1：VST3 插件 registry / sidecar 客户端 / 模型 / 工具单测。 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  MAX_EXTERNAL_PLUGIN_INSTANCES,
  MAX_PLUGIN_STATE_BYTES,
  TRACK_ENGINES,
  createEmptyProject,
  makeTrack,
  normalizeExternalPlugin,
  normalizeProject,
} from '../src/shared/model.js'
import {
  defaultVst3Dirs,
  findVst3Candidates,
  installPlugin,
  listPlugins,
  loadPluginRegistry,
  makePluginId,
  normalizePluginInfo,
  resolveVst3BinaryPath,
  scanPlugins,
  selectPrimaryPluginInfo,
  uninstallPlugin,
  validatePluginSource,
} from '../src/host/plugin-registry.js'
import { createPluginHostClient, findNodeInPath, resolveNodeBin } from '../src/host/plugin-host-client.js'
import { createPluginService } from '../src/host/plugin-service.js'

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'aims-m1-'))
}

async function makeFakeBundle(root, name = 'FakePlugin') {
  const bundle = path.join(root, `${name}.vst3`)
  const binary = path.join(bundle, 'Contents', 'x86_64-win', `${name}.vst3`)
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, Buffer.from('fake-vst3-binary'), 'utf8')
  return { bundle, binary }
}

function fakeInspectInfo(binaryPath, overrides = {}) {
  return {
    path: binaryPath,
    name: 'TAL Reverb 4 Plugin',
    vendor: 'TAL-Togu Audio Line',
    version: '4.0.4',
    category: 'Audio Module Class',
    subCategories: 'Fx',
    classId: '7254535656657434616c207265766572',
    ...overrides,
  }
}

function makeRegistryClient(options = {}) {
  return {
    async inspect(target) {
      if (options.inspectError) throw new Error(options.inspectError)
      return [fakeInspectInfo(target), { ...fakeInspectInfo(target), category: 'Component Controller Class', classId: 'controller' }]
    },
    async load() { return { plugin: {} } },
    async getParamsList() {
      return {
        count: 3,
        items: [
          { index: 0, id: 0, title: 'Mix', shortTitle: 'Mix', units: '%', value: 0.5, defaultNormalizedValue: 0.5, formatted: '50%' },
          { index: 1, id: 1, title: 'Decay', shortTitle: 'Decay', units: 's', value: 0.2, defaultNormalizedValue: 0.2 },
          { index: 2, id: 2, title: 'Size', shortTitle: 'Size', units: '', value: 0.8, defaultNormalizedValue: 0.8 },
        ],
      }
    },
    async setParameter(paramId, value) { return { paramId, value } },
    async close() {},
  }
}

describe('v2.2 M1 — 模型 vst3 引用', () => {
  it('normalizeExternalPlugin：字段/params 夹紧/state 上限', () => {
    const plugin = normalizeExternalPlugin({
      pluginId: 'vst3_abc',
      name: 'TAL',
      params: { 0: 1.5, 1: -1, 2: 'bad' },
      stateBase64: 'x'.repeat(10),
      bypass: true,
      missing: true,
    })
    assert.equal(plugin.pluginId, 'vst3_abc')
    assert.deepEqual(plugin.params, { 0: 1, 1: 0 })
    assert.equal(plugin.bypass, true)
    assert.equal(plugin.missing, true)
    assert.equal(normalizeExternalPlugin({ name: 'no id' }), null)
    assert.equal(normalizeExternalPlugin({ pluginId: 'vst3_x', stateBase64: 'a'.repeat(MAX_PLUGIN_STATE_BYTES + 1) }).stateBase64, null)
  })

  it('normalizeProject：engine=vst3 轨 instrument.preset=null / 引用保留', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'VST', preset: 'grand_piano' })]
    project.tracks[0].engine = 'vst3'
    project.tracks[0].vst3 = { pluginId: 'vst3_unknown', name: 'Ghost', category: 'Instrument', missing: true }
    normalizeProject(project)
    assert.equal(project.tracks[0].engine, 'vst3')
    assert.equal(project.tracks[0].instrument.preset, null)
    assert.equal(project.tracks[0].vst3.pluginId, 'vst3_unknown')
    assert.equal(project.tracks[0].vst3.missing, true)
    assert.equal(TRACK_ENGINES.includes('vst3'), true)
  })

  it('非 vst3 轨删除 vst3 字段；音频轨同样', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'S', preset: 'grand_piano' })]
    project.tracks[0].vst3 = { pluginId: 'vst3_x' }
    normalizeProject(project)
    assert.equal(Object.hasOwn(project.tracks[0], 'vst3'), false)
  })

  it('效果器 vst3：接受并自动移到链尾；非法 vst3 丢弃', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'S', preset: 'grand_piano' })]
    project.tracks[0].effects = [
      { id: 'fx_2', type: 'vst3', vst3: { pluginId: 'vst3_fx', name: 'Reverb' } },
      { id: 'fx_1', type: 'filter', params: { cutoff: 900 } },
      { id: 'fx_3', type: 'vst3', vst3: {} },
    ]
    normalizeProject(project)
    assert.deepEqual(project.tracks[0].effects.map((fx) => fx.type), ['filter', 'vst3'])
    assert.equal(project.tracks[0].effects[1].vst3.pluginId, 'vst3_fx')
  })

  it('MAX_EXTERNAL_PLUGIN_INSTANCES=16', () => {
    assert.equal(MAX_EXTERNAL_PLUGIN_INSTANCES, 16)
  })
})

describe('v2.2 M1 — registry 扫描/安装/卸载', () => {
  it('makePluginId/normalizePluginInfo：classId 稳定、instrument/effect 判定', () => {
    const info = normalizePluginInfo({ name: 'Reverb', vendor: 'TAL', version: '4', category: 'Audio Module Class', subCategories: 'Fx', classId: 'abc' }, '/x.vst3')
    assert.equal(info.pluginId, makePluginId({ classId: 'abc' }, '/x.vst3'))
    assert.equal(info.isEffect, true)
    const instrument = normalizePluginInfo({ category: 'Instrument', classId: 'ins' }, '/x')
    assert.equal(instrument.isInstrument, true)
  })

  it('selectPrimaryPluginInfo：优先 Audio Module Class', () => {
    const primary = selectPrimaryPluginInfo([{ category: 'Component Controller Class' }, { category: 'Audio Module Class' }])
    assert.equal(primary.category, 'Audio Module Class')
  })

  it('resolveVst3BinaryPath：bundle 目录解析 Contents 二进制', async () => {
    const dir = await tempDir()
    try {
      const { bundle, binary } = await makeFakeBundle(dir)
      assert.equal(await resolveVst3BinaryPath(bundle), binary)
      assert.equal(await resolveVst3BinaryPath(binary), binary)
      await assert.rejects(resolveVst3BinaryPath(path.join(dir, 'nope.vst3')), /不存在/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('validatePluginSource：必须存在且 .vst3 结尾', async () => {
    const dir = await tempDir()
    try {
      const { bundle } = await makeFakeBundle(dir)
      const source = await validatePluginSource(bundle)
      assert.equal(source.isDirectory, true)
      await assert.rejects(validatePluginSource(path.join(dir, 'x.wav')), /\.vst3/)
      await assert.rejects(validatePluginSource(path.join(dir, 'missing.vst3')), /不存在/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('installPlugin：复制托管目录 + registry + 去重', async () => {
    const dataDir = await tempDir()
    const sourceDir = await tempDir()
    try {
      const { bundle } = await makeFakeBundle(sourceDir, 'TAL')
      const first = await installPlugin({ dataDir, client: makeRegistryClient(), sourcePath: bundle })
      assert.equal(first.plugin.managed, true)
      assert.equal(first.plugin.isEffect, true)
      assert.ok((await stat(first.entry.managedPath)).isDirectory())
      // v2.2 M2：托管目录 <plugins>/<pluginId>/<原始 bundle 名>.vst3，内层二进制不改名
      assert.equal(path.basename(first.entry.managedPath), 'TAL.vst3')
      assert.equal(path.basename(path.dirname(first.entry.managedPath)), first.entry.pluginId)
      assert.ok(first.entry.managedRoot)
      const second = await installPlugin({ dataDir, client: makeRegistryClient(), sourcePath: bundle })
      assert.equal(second.plugin.pluginId, first.plugin.pluginId)
      const registry = await loadPluginRegistry(dataDir)
      assert.equal(registry.plugins.length, 1, '同 classId 去重')
      assert.equal(registry.plugins[0].source, 'install')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('uninstallPlugin：只删托管副本，registry 移除；未知 id 中文错误', async () => {
    const dataDir = await tempDir()
    const sourceDir = await tempDir()
    try {
      const { bundle } = await makeFakeBundle(sourceDir)
      const installed = await installPlugin({ dataDir, client: makeRegistryClient(), sourcePath: bundle })
      const result = await uninstallPlugin(dataDir, installed.plugin.pluginId)
      assert.equal(result.removed, true)
      assert.equal(result.managedRemoved, true)
      await assert.rejects(stat(installed.entry.managedPath), /ENOENT/)
      assert.equal((await loadPluginRegistry(dataDir)).plugins.length, 0)
      await assert.rejects(uninstallPlugin(dataDir, 'vst3_missing'), /不存在/)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('listPlugins：托管副本被删后 missing=true', async () => {
    const dataDir = await tempDir()
    const sourceDir = await tempDir()
    try {
      const { bundle } = await makeFakeBundle(sourceDir)
      const installed = await installPlugin({ dataDir, client: makeRegistryClient(), sourcePath: bundle })
      await rm(installed.entry.managedPath, { recursive: true, force: true })
      const list = await listPlugins(dataDir)
      assert.equal(list.plugins[0].missing, true)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('findVst3Candidates/defaultVst3Dirs：递归发现 .vst3 bundle', async () => {
    const dir = await tempDir()
    try {
      await makeFakeBundle(dir, 'A')
      const nested = path.join(dir, 'nested')
      await mkdir(nested, { recursive: true })
      await makeFakeBundle(nested, 'B')
      const candidates = await findVst3Candidates([dir])
      assert.equal(candidates.length, 2)
      assert.ok(candidates.every((item) => item.endsWith('.vst3')))
      assert.ok(defaultVst3Dirs({}).length > 0)
      assert.ok(defaultVst3Dirs({ AIMS_VST3_TEST_PLUGIN: path.join(dir, 'A.vst3') }).includes(dir))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scanPlugins：扫描自定义目录并写 registry；无 client 中文错误', async () => {
    const dataDir = await tempDir()
    const scanDir = await tempDir()
    try {
      await makeFakeBundle(scanDir, 'ScanMe')
      const result = await scanPlugins({ dataDir, client: makeRegistryClient(), dirs: [scanDir], includeDefaults: false })
      assert.equal(result.scanned, 1)
      assert.equal(result.plugins.length, 1)
      assert.equal(result.plugins[0].name, 'TAL Reverb 4 Plugin')
      const saved = await loadPluginRegistry(dataDir)
      assert.equal(saved.plugins.length, 1)
      await assert.rejects(scanPlugins({ dataDir, client: null, dirs: [scanDir], includeDefaults: false }), /sidecar/)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
      await rm(scanDir, { recursive: true, force: true })
    }
  })

  it('loadPluginRegistry：损坏 registry 回退空且不抛错', async () => {
    const dataDir = await tempDir()
    try {
      await writeFile(path.join(dataDir, 'plugins.json'), '{bad', 'utf8')
      assert.deepEqual(await loadPluginRegistry(dataDir), { version: 1, plugins: [] })
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('v2.2 M1 — plugin-host-client', () => {
  function makeFakeSpawn({ failPing = false, neverReply = false } = {}) {
    const calls = []
    const spawnImpl = (command, args, options) => {
      calls.push({ command, args, options })
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      const writes = []
      child.stdin = {
        writable: true,
        write: (line) => {
          writes.push(line)
          const message = JSON.parse(line)
          if (neverReply) return
          queueMicrotask(() => {
            if (message.type === 'ping') {
              if (failPing) child.stdout.emit('data', `${JSON.stringify({ id: message.id, ok: false, error: 'mock 失败', code: 'MOCK_FAIL' })}\n`)
              else child.stdout.emit('data', `${JSON.stringify({ id: message.id, ok: true, result: { pid: 123, node: '24.0.0' } })}\n`)
            } else child.stdout.emit('data', `${JSON.stringify({ id: message.id, ok: true, result: { echoed: message.type } })}\n`)
          })
        },
        end: () => {},
      }
      child.kill = () => { child.emit('exit', 0, 'SIGTERM') }
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ type: 'ready', pid: 123, node: '24.0.0' })}\n`))
      return child
    }
    return { spawnImpl, calls }
  }

  it('resolveNodeBin/findNodeInPath：显式路径存在校验', async () => {
    assert.throws(() => resolveNodeBin({ nodeBin: path.join(os.tmpdir(), 'missing-node.exe') }), /AIMS_NODE_BIN 不存在/)
    assert.equal(typeof findNodeInPath(process.env), 'string')
  })

  it('ping：ready 后请求成功；fake spawn 收到 sidecar 路径', async () => {
    const { spawnImpl, calls } = makeFakeSpawn()
    const client = createPluginHostClient({ nodeBin: process.execPath, spawnImpl, timeoutMs: 3000 })
    try {
      const result = await client.ping()
      assert.equal(result.pid, 123)
      assert.equal(calls.length, 1)
      assert.ok(calls[0].args[0].endsWith('plugin-host-node.cjs'))
    } finally {
      await client.close()
    }
  })

  it('error 响应转 PluginHostError（code 保留）', async () => {
    const { spawnImpl } = makeFakeSpawn({ failPing: true })
    const client = createPluginHostClient({ nodeBin: process.execPath, spawnImpl, timeoutMs: 3000 })
    try {
      await assert.rejects(client.ping(), /mock 失败/)
    } finally {
      await client.close()
    }
  })

  it('request 超时中文错误', async () => {
    const { spawnImpl } = makeFakeSpawn({ neverReply: true })
    const client = createPluginHostClient({ nodeBin: process.execPath, spawnImpl, timeoutMs: 120 })
    try {
      await assert.rejects(client.ping(), /请求超时/)
    } finally {
      await client.close()
    }
  })

  it('缺少 sidecar 脚本：中文错误', async () => {
    const client = createPluginHostClient({ nodeBin: process.execPath, sidecarPath: path.join(os.tmpdir(), 'nope.cjs'), timeoutMs: 500 })
    await assert.rejects(client.ping(), /sidecar 脚本不存在/)
  })
})

describe('v2.2 M1 — service / ops 集成', () => {
  it('createPluginService：install/list/parameters/setParameter 使用注入 client', async () => {
    const dataDir = await tempDir()
    const sourceDir = await tempDir()
    const client = makeRegistryClient()
    const service = createPluginService({ dataDir, client })
    try {
      const { bundle } = await makeFakeBundle(sourceDir)
      const installed = await service.install({ path: bundle })
      assert.equal(installed.plugin.name, 'TAL Reverb 4 Plugin')
      const listed = await service.list()
      assert.equal(listed.plugins.length, 1)
      const params = await service.parameters(installed.plugin.pluginId)
      assert.equal(params.count, 3)
      assert.equal(params.params[0].name, 'Mix')
      assert.equal(params.params[0].min, 0)
      assert.equal(params.params[0].max, 1)
      await assert.rejects(service.setParameter({ pluginId: installed.plugin.pluginId, paramId: 0, value: 2 }), /0\.\.1/)
      const setResult = await service.setParameter({ pluginId: installed.plugin.pluginId, paramId: 1, value: 0.4 })
      assert.equal(setResult.value, 0.4)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('ops：vst3 轨/效果器 + bypass + markPluginMissing + 实例上限', async () => {
    const ops = await import('../src/host/ops.js')
    const project = createEmptyProject()
    const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'V', vst3: { pluginId: 'vst3_x', name: 'TAL' } })
    assert.equal(track.track.engine, 'vst3')
    const effect = ops.addEffect(project, { target: track.trackId, type: 'vst3', vst3: { pluginId: 'vst3_x', name: 'TAL' } })
    assert.equal(effect.chain[0].type, 'vst3')
    assert.equal(ops.countExternalPluginInstances(project), 2)
    const bypass = ops.setVst3Bypass(project, { effectId: effect.effectId, bypass: true })
    assert.equal(bypass.bypass, true)
    assert.equal(project.tracks[0].effects[0].vst3.bypass, true)
    assert.equal(ops.markPluginMissing(project, 'vst3_x', true), 2)
    assert.equal(project.tracks[0].vst3.missing, true)
    assert.equal(project.tracks[0].effects[0].vst3.missing, true)
    // 上限 16：构造 2 轨 × 8 vst3 效果器后，再添加插件轨/效果器应拒绝
    const full = createEmptyProject()
    for (let index = 0; index < 2; index += 1) {
      const t = ops.addTrack(full, { kind: 'synth', name: `T${index}`, preset: 'grand_piano' })
      for (let fxIndex = 0; fxIndex < 8; fxIndex += 1) {
        ops.addEffect(full, { target: t.trackId, type: 'vst3', vst3: { pluginId: `vst3_${index}_${fxIndex}`, name: 'F' } })
      }
    }
    assert.equal(ops.countExternalPluginInstances(full), 16)
    assert.throws(() => ops.addTrack(full, { kind: 'synth', engine: 'vst3', vst3: { pluginId: 'vst3_17', name: 'T' } }), /上限/)
    assert.throws(() => ops.addEffect(full, { target: full.tracks[0].id, type: 'vst3', vst3: { pluginId: 'vst3_18' } }), /上限/)
  })

  it('ops：VST3 效果器不允许 master/bus/group', async () => {
    const ops = await import('../src/host/ops.js')
    const project = createEmptyProject()
    project.groups = [{ id: 'grp_1', name: 'G', level: 0.8, effects: [] }]
    assert.throws(() => ops.addEffect(project, { target: 'master', type: 'vst3', vst3: { pluginId: 'vst3_x' } }), /轨道 FX/)
    assert.throws(() => ops.addEffect(project, { target: 'bus', busId: 'reverb', type: 'vst3', vst3: { pluginId: 'vst3_x' } }), /轨道 FX/)
  })
})

/* v2.2 M1 补充：边界/工具声明 */
describe('v2.2 M1 — 补充边界', () => {
  it('normalizeExternalPlugin：空/非对象返回 null；params 最多 512 键', () => {
    assert.equal(normalizeExternalPlugin(null), null)
    assert.equal(normalizeExternalPlugin('x'), null)
    const params = {}
    for (let index = 0; index < 600; index += 1) params[`p${index}`] = 0.5
    const plugin = normalizeExternalPlugin({ pluginId: 'p', params })
    assert.equal(Object.keys(plugin.params).length, 512)
  })

  it('normalizeProject：vst3 轨 normalize 幂等', () => {
    const project = createEmptyProject()
    project.tracks = [makeTrack({ id: 'trk_1', kind: 'synth', name: 'V', preset: 'grand_piano' })]
    project.tracks[0].engine = 'vst3'
    project.tracks[0].vst3 = { pluginId: 'vst3_x', name: 'X' }
    normalizeProject(project)
    const first = JSON.stringify(project.tracks[0])
    normalizeProject(project)
    assert.equal(JSON.stringify(project.tracks[0]), first)
  })

  it('效果器链上限：vst3 超过 max 截断且链尾', async () => {
    const { normalizeEffects } = await import('../src/shared/model.js')
    const effects = Array.from({ length: 10 }, (_, index) => ({ id: `fx_${index + 1}`, type: 'vst3', vst3: { pluginId: `p${index}` } }))
    const normalized = normalizeEffects(effects, { max: 8 })
    assert.equal(normalized.length, 8)
    assert.ok(normalized.every((fx) => fx.type === 'vst3'))
  })

  it('makePluginId：classId 相同 → id 相同；无 classId 用路径 hash', () => {
    assert.equal(makePluginId({ classId: 'abc' }, '/a'), makePluginId({ classId: 'abc' }, '/b'))
    assert.notEqual(makePluginId({}, '/a'), makePluginId({}, '/b'))
  })

  it('listPlugins：空 registry 返回空数组', async () => {
    const dir = await tempDir()
    try {
      const result = await listPlugins(dir)
      assert.deepEqual(result.plugins, [])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uninstallPlugin：不删除托管目录之外的路径', async () => {
    const dataDir = await tempDir()
    const outside = await tempDir()
    try {
      const outsideFile = path.join(outside, 'keep.txt')
      await writeFile(outsideFile, 'keep', 'utf8')
      await writeFile(path.join(dataDir, 'plugins.json'), JSON.stringify({
        version: 1,
        plugins: [{ pluginId: 'vst3_out', name: 'X', path: outsideFile, managedPath: outsideFile, managed: true }],
      }), 'utf8')
      const result = await uninstallPlugin(dataDir, 'vst3_out')
      assert.equal(result.managedRemoved, true)
      assert.equal((await stat(outsideFile)).isFile(), true, '托管目录外文件不删除')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('scanPlugins：不存在的自定义目录跳过、不抛错', async () => {
    const dataDir = await tempDir()
    try {
      const result = await scanPlugins({ dataDir, client: makeRegistryClient(), dirs: [path.join(dataDir, 'nope')], includeDefaults: false })
      assert.equal(result.scanned, 0)
      assert.equal(result.plugins.length, 0)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('createPluginService：无可用 Node 时 status.available=false（中文错误码）', () => {
    const service = createPluginService({ dataDir: path.join(os.tmpdir(), 'aims-m1-none'), nodeBin: path.join(os.tmpdir(), 'missing-node.exe') })
    const status = service.status()
    assert.equal(status.available, false)
    assert.equal(status.code, 'PLUGIN_HOST_NO_NODE')
    assert.match(status.error, /AIMS_NODE_BIN/)
  })

  it('createPluginService：未知 pluginId 的 getPlugin=null / parameters 中文错误', async () => {
    const service = createPluginService({ dataDir: path.join(os.tmpdir(), 'aims-m1-none'), client: makeRegistryClient() })
    try {
      assert.equal(await service.getPlugin('vst3_nope'), null)
      await assert.rejects(service.parameters('vst3_nope'), /不存在/)
    } finally {
      await service.close()
    }
  })

  it('ops.addTrack：VST3 轨拒绝 preset/synthPreset；鼓轨拒绝 vst3', async () => {
    const ops = await import('../src/host/ops.js')
    const project = createEmptyProject()
    assert.throws(() => ops.addTrack(project, { kind: 'synth', engine: 'vst3', preset: 'grand_piano', vst3: { pluginId: 'x' } }), /不接受采样 preset/)
    assert.throws(() => ops.addTrack(project, { kind: 'synth', engine: 'vst3', synthPreset: 'saw_lead', vst3: { pluginId: 'x' } }), /不接受 synthPreset/)
    assert.throws(() => ops.addTrack(project, { kind: 'drum', engine: 'vst3', vst3: { pluginId: 'x' } }), /仅支持乐器轨/)
  })

  it('ops.addEffect：vst3 缺描述中文错误', async () => {
    const ops = await import('../src/host/ops.js')
    const project = createEmptyProject()
    const track = ops.addTrack(project, { kind: 'synth', name: 'S', preset: 'grand_piano' })
    assert.throws(() => ops.addEffect(project, { target: track.trackId, type: 'vst3' }), /vst3 描述/)
  })

  it('ops.updateEffect：vst3Bypass 与 vst3Params 合并', async () => {
    const ops = await import('../src/host/ops.js')
    const project = createEmptyProject()
    const track = ops.addTrack(project, { kind: 'synth', name: 'S', preset: 'grand_piano' })
    const effect = ops.addEffect(project, { target: track.trackId, type: 'vst3', vst3: { pluginId: 'vst3_fx' } })
    const updated = ops.updateEffect(project, { target: track.trackId, effectId: effect.effectId, vst3Bypass: true, vst3Params: { 0: 0.3 } })
    const fx = project.tracks[0].effects.find((item) => item.id === effect.effectId)
    assert.equal(fx.vst3.bypass, true)
    assert.equal(fx.vst3.params['0'], 0.3)
    assert.equal(updated.effectId, effect.effectId)
  })

  it('getProjectOverview：vst3 轨/效果器摘要不含 stateBase64', async () => {
    const ops = await import('../src/host/ops.js')
    const project = createEmptyProject()
    const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'V', vst3: { pluginId: 'vst3_x', name: 'TAL', stateBase64: 'c2VjcmV0' } })
    ops.addEffect(project, { target: track.trackId, type: 'vst3', vst3: { pluginId: 'vst3_x', name: 'TAL', stateBase64: 'c2VjcmV0' } })
    const overview = ops.getProjectOverview(project)
    const trackView = overview.tracks.find((item) => item.id === track.trackId)
    assert.equal(trackView.engine, 'vst3')
    assert.equal(trackView.instrument.preset, null)
    assert.equal(trackView.vst3.missing, false)
    assert.equal(JSON.stringify(overview).includes('c2VjcmV0'), false)
  })

  it('工具声明：7 个外部插件工具 + 描述中文', async () => {
    const { createTools } = await import('../src/host/tools.js')
    const { createState } = await import('../src/host/state.js')
    const dir = await tempDir()
    const state = createState({ dataDir: dir })
    await state.ready
    try {
      const tools = createTools({ defineTool: (options) => options, state })
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const names = ['studio_scan_plugins', 'studio_install_plugin', 'studio_list_external_plugins', 'studio_get_plugin_parameters', 'studio_add_plugin_track', 'studio_add_plugin_effect', 'studio_remove_external_plugin', 'studio_set_plugin_parameter']
      for (const name of names) {
        const tool = byName.get(name)
        assert.ok(tool, name)
        assert.ok(tool.description.includes('VST3') || tool.description.includes('插件'), name)
        assert.ok(tool.output?.schema, name)
      }
      assert.equal(names.length, 8)
    } finally {
      await state.flush()
      state.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

  it('service：已加载插件后重新 install 能释放文件锁并覆盖（Windows EPERM 回归）', async () => {
    const dataDir = await tempDir()
    const sourceDir = await tempDir()
    const client = makeRegistryClient()
    let unloadCalls = 0
    client.unload = async () => { unloadCalls += 1; return { unloaded: true } }
    const service = createPluginService({ dataDir, client })
    try {
      const { bundle } = await makeFakeBundle(sourceDir)
      const first = await service.install({ path: bundle })
      // 触发 sidecar 加载托管副本（参数读取）
      await service.parameters(first.plugin.pluginId)
      const second = await service.install({ path: bundle })
      assert.equal(second.plugin.pluginId, first.plugin.pluginId)
      assert.ok(unloadCalls >= 1, 'install 前应 unload 释放文件锁')
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

