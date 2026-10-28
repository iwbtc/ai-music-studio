/** v2.2 M2：多实例 sidecar / plugin-service / preload+main IPC / startServer.plugins。 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createPluginHostClient, DEFAULT_SIDECAR_PATH } from '../src/host/plugin-host-client.js'
import { createPluginService, getSharedPluginService, closeSharedPluginServices } from '../src/host/plugin-service.js'

const ROOT = path.resolve(import.meta.dirname, '..')

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'aims-m2-'))
}

async function makeBundle(root, name = 'TAL-Reverb-4') {
  const bundle = path.join(root, `${name}.vst3`)
  const binary = path.join(bundle, 'Contents', 'x86_64-win', `${name}.vst3`)
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, 'fake', 'utf8')
  return bundle
}

function encodeF32(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64')
}

function decodeF32(base64) {
  const buffer = Buffer.from(base64, 'base64')
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
}

function makeFullClient(overrides = {}) {
  const calls = []
  const client = {
    async inspect(target) {
      return [{
        path: String(target), name: 'TAL Reverb 4 Plugin', vendor: 'TAL-Togu Audio Line', version: '4.0.4',
        category: 'Audio Module Class', subCategories: 'Fx', classId: '7254535656657434616c207265766572',
      }]
    },
    async load() { return {} },
    async getParamsList() { return { count: 0, items: [] } },
    async loadInstance(options) {
      calls.push({ type: 'loadInstance', options })
      return { instanceId: options.instanceId, latencySamples: 480, sampleRate: options.sampleRate, ...options }
    },
    async unloadInstance(instanceId) { calls.push({ type: 'unloadInstance', instanceId }); return { instanceId, unloaded: true } },
    async processInstance(options) {
      calls.push({ type: 'processInstance', options })
      const inputs = (options.inputs ?? []).map(decodeF32)
      const outputs = inputs.map((input) => Float32Array.from(input, (value) => value * 0.5))
      return { ms: 0.4, outputs: outputs.map(encodeF32), outputEvents: [] }
    },
    async setInstanceParam(options) { calls.push({ type: 'setInstanceParam', options }); return { ...options } },
    async getInstanceParams() {
      return { count: 2, items: [
        { index: 0, id: 0, title: 'Mix', shortTitle: 'Mix', units: '%', value: 0.5, defaultNormalizedValue: 0.5 },
        { index: 1, id: 1, title: 'Decay', shortTitle: 'Decay', units: 's', value: 0.2, defaultNormalizedValue: 0.2 },
      ] }
    },
    async saveInstanceState() { return { state: Buffer.from('state').toString('base64') } },
    async close() {},
    calls,
    ...overrides,
  }
  return client
}

async function makeServiceWithPlugin() {
  const dataDir = await tempDir()
  const sourceDir = await tempDir()
  const bundle = await makeBundle(sourceDir)
  const client = makeFullClient()
  const service = createPluginService({ dataDir, client })
  const installed = await service.install({ path: bundle })
  return { service, client, dataDir, sourceDir, pluginId: installed.plugin.pluginId, bundle }
}

function fakeSpawn(handler) {
  const requests = []
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = {
      writable: true,
      write: (line) => {
        const message = JSON.parse(line)
        requests.push(message)
        queueMicrotask(() => {
          const result = handler(message)
          child.stdout.emit('data', JSON.stringify({ id: message.id, ok: true, result }) + '\n')
        })
      },
      end: () => {},
    }
    child.kill = () => {}
    queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n'))
    return child
  }
  return { spawnImpl, requests }
}

describe('v2.2 M2 — plugin-service 多实例', () => {
  it('loadInstance：实例信息/latency/列表', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      const info = await service.loadInstance(pluginId, {
        instanceId: 'fx:fx_1', effectId: 'fx_1', trackId: 'trk_1', sampleRate: 48000, maxBlockSize: 256,
      })
      assert.equal(info.instanceId, 'fx:fx_1')
      assert.equal(info.pluginName, 'TAL Reverb 4 Plugin')
      assert.equal(info.latencySamples, 480)
      assert.equal(info.latencyMs, 10)
      assert.equal(info.maxBlockSize, 256)
      assert.equal((await service.listInstances()).count, 1)
      assert.equal(service.getInstanceInfo('fx:fx_1').pluginId, pluginId)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('loadInstance：缺 instanceId/未知插件/非法采样率/非法 block', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      await assert.rejects(service.loadInstance(pluginId, {}), /instanceId/)
      await assert.rejects(service.loadInstance('vst3_missing', { instanceId: 'fx:x' }), /不存在/)
      await assert.rejects(service.loadInstance(pluginId, { instanceId: 'fx:x', sampleRate: 100 }), /sampleRate/)
      await assert.rejects(service.loadInstance(pluginId, { instanceId: 'fx:x', maxBlockSize: 3 }), /maxBlockSize/)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('processInstance：Float32 输入/输出 + outputsBase64 + latency', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      await service.loadInstance(pluginId, { instanceId: 'fx:fx_1', sampleRate: 48000, maxBlockSize: 256 })
      const inputs = [Float32Array.from({ length: 64 }, () => 0.5), Float32Array.from({ length: 64 }, () => -0.5)]
      const result = await service.processInstance({ instanceId: 'fx:fx_1', inputs, numSamples: 64 })
      assert.equal(result.numSamples, 64)
      assert.equal(result.outputs.length, 2)
      assert.ok(result.outputs[0] instanceof Float32Array)
      assert.equal(result.outputs[0][0], 0.25)
      assert.equal(result.outputs[1][0], -0.25)
      assert.equal(result.outputsBase64.length, 2)
      assert.equal(result.latencyMs, 10)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('processInstance：未加载/非法 block 中文错误', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      await assert.rejects(service.processInstance({ instanceId: 'fx:none', inputs: [], numSamples: 64 }), /未加载/)
      await service.loadInstance(pluginId, { instanceId: 'fx:fx_1', maxBlockSize: 256 })
      await assert.rejects(service.processInstance({ instanceId: 'fx:fx_1', inputs: [], numSamples: 0 }), /numSamples/)
      await assert.rejects(service.processInstance({ instanceId: 'fx:fx_1', inputs: [], numSamples: 512 }), /numSamples/)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('setParam/getParams/saveState/unload/listInstances', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      await service.loadInstance(pluginId, { instanceId: 'fx:fx_1', sampleRate: 48000, maxBlockSize: 256 })
      const set = await service.setInstanceParam({ instanceId: 'fx:fx_1', paramId: 1, value: 0.4 })
      assert.equal(set.value, 0.4)
      await assert.rejects(service.setInstanceParam({ instanceId: 'fx:fx_1', paramId: 0, value: 2 }), /0\.\.1/)
      const params = await service.getInstanceParams('fx:fx_1')
      assert.equal(params.count, 2)
      assert.equal(params.params[0].name, 'Mix')
      const state = await service.saveInstanceState('fx:fx_1')
      assert.ok(state.stateBase64.length > 0)
      assert.equal((await service.unloadInstance('fx:fx_1')).unloaded, true)
      assert.equal((await service.unloadInstance('fx:fx_1')).unloaded, false)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('reportInstanceStatus：underrun/bufferMs/error 状态', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      await service.loadInstance(pluginId, { instanceId: 'fx:fx_1', sampleRate: 48000, maxBlockSize: 256 })
      const reported = service.reportInstanceStatus({ instanceId: 'fx:fx_1', underrun: true, underruns: 3, bufferMs: 5.3, error: 'underrun-x' })
      assert.equal(reported.ok, true)
      assert.equal(reported.instance.underrun, true)
      assert.equal(reported.instance.underruns, 3)
      assert.equal(reported.instance.bufferMs, 5.3)
      assert.equal(reported.instance.lastError, 'underrun-x')
      assert.equal(service.reportInstanceStatus({ instanceId: 'fx:none' }).ok, false)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('install 前释放已加载实例（EPERM 回归）', async () => {
    const { service, client, dataDir, sourceDir, pluginId, bundle } = await makeServiceWithPlugin()
    try {
      await service.loadInstance(pluginId, { instanceId: 'fx:fx_1', sampleRate: 48000, maxBlockSize: 256 })
      assert.equal((await service.listInstances()).count, 1)
      await service.install({ path: bundle })
      assert.equal((await service.listInstances()).count, 0)
      assert.ok(client.calls.some((call) => call.type === 'unloadInstance'))
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('status：多实例 started/instances/maxInstances', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      assert.equal(service.status().instances, 0)
      await service.loadInstance(pluginId, { instanceId: 'fx:fx_1' })
      const status = service.status()
      assert.equal(status.started, true)
      assert.equal(status.instances, 1)
      assert.equal(status.maxInstances, 8)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('loadInstance：对象式签名 + 同 id 重载', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      const first = await service.loadInstance({ pluginId, instanceId: 'fx:reload', sampleRate: 44100, maxBlockSize: 128 })
      assert.equal(first.maxBlockSize, 128)
      const second = await service.loadInstance({ pluginId, instanceId: 'fx:reload', sampleRate: 48000, maxBlockSize: 256 })
      assert.equal(second.maxBlockSize, 256)
      assert.equal((await service.listInstances()).count, 1)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('processInstance：base64 输入 + outputFormat=base64', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      await service.loadInstance(pluginId, { instanceId: 'fx:b64', maxBlockSize: 64 })
      const input = Float32Array.from({ length: 64 }, () => 0.2)
      const result = await service.processInstance({ instanceId: 'fx:b64', inputs: [encodeF32(input)], numSamples: 64, outputFormat: 'base64' })
      assert.equal(typeof result.outputs[0], 'string')
      assert.ok(Math.abs(decodeF32(result.outputs[0])[0] - 0.1) < 1e-6)
      assert.equal(result.outputsBase64, undefined)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('未知实例：getInstanceInfo=null / getParams/saveState/setParam 中文错误', async () => {
    const { service, dataDir, sourceDir } = await makeServiceWithPlugin()
    try {
      assert.equal(service.getInstanceInfo('fx:none'), null)
      await assert.rejects(service.getInstanceParams('fx:none'), /未加载/)
      await assert.rejects(service.saveInstanceState('fx:none'), /未加载/)
      await assert.rejects(service.setInstanceParam({ instanceId: 'fx:none', paramId: 0, value: 0.5 }), /未加载/)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('instanceId 过长中文错误；close 清空实例', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      await assert.rejects(service.loadInstance(pluginId, { instanceId: 'x'.repeat(81) }), /过长/)
      await service.loadInstance(pluginId, { instanceId: 'fx:fx_1' })
      await service.close()
      assert.equal((await service.listInstances()).count, 0)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('缺失 managed 文件：loadInstance PLUGIN_MISSING 中文错误', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      await assert.rejects(service.loadInstance('vst3_missing', { instanceId: 'fx:x' }), /不存在/)
      const list = await service.list()
      assert.equal(list.plugins.length, 1)
      await rm(list.entries[0].managedPath, { recursive: true, force: true })
      await assert.rejects(service.loadInstance(pluginId, { instanceId: 'fx:missing' }), /缺失|重新安装/)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('无 Node 时 status.available=false', () => {
    const service = createPluginService({ dataDir: path.join(os.tmpdir(), 'aims-m2-none'), nodeBin: path.join(os.tmpdir(), 'missing-node.exe') })
    const status = service.status()
    assert.equal(status.available, false)
    assert.equal(status.code, 'PLUGIN_HOST_NO_NODE')
  })

  it('reportInstanceStatus：后一次只带 error 时保留数值状态', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      await service.loadInstance(pluginId, { instanceId: 'fx:report' })
      service.reportInstanceStatus({ instanceId: 'fx:report', underruns: 2, bufferMs: 4 })
      const reported = service.reportInstanceStatus({ instanceId: 'fx:report', error: 'x' })
      assert.equal(reported.instance.underruns, 2)
      assert.equal(reported.instance.bufferMs, 4)
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('install managed 布局保留原始 bundle 名与 pluginId 目录', async () => {
    const { service, dataDir, sourceDir, pluginId } = await makeServiceWithPlugin()
    try {
      const entry = (await service.list()).entries[0]
      assert.equal(path.basename(entry.managedPath), 'TAL-Reverb-4.vst3')
      assert.equal(path.basename(path.dirname(entry.managedPath)), pluginId)
      assert.ok(existsSync(entry.managedPath))
    } finally {
      await service.close()
      await rm(dataDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  it('shared service：同 dataDir 复用同一 service', () => {
    const dataDir = path.join(os.tmpdir(), 'aims-m2-shared')
    assert.equal(getSharedPluginService(dataDir), getSharedPluginService(dataDir))
  })
})

describe('v2.2 M2 — sidecar 客户端协议', () => {
  it('loadInstance/process/set/unload/list 请求 type/payload', async () => {
    const { spawnImpl, requests } = fakeSpawn((message) => {
      if (message.type === 'loadInstance') return { instanceId: message.payload.instanceId, latencySamples: 1 }
      if (message.type === 'processInstance') return { instanceId: message.payload.instanceId, outputs: [message.payload.inputs[0]], outputEvents: [] }
      if (message.type === 'unloadInstance') return { instanceId: message.payload.instanceId, unloaded: true }
      return { echoed: message.type }
    })
    const client = createPluginHostClient({ nodeBin: process.execPath, spawnImpl, timeoutMs: 3000 })
    try {
      const loaded = await client.loadInstance({ instanceId: 'fx:1', path: 'x.vst3', sampleRate: 48000, maxBlockSize: 256 })
      assert.equal(loaded.instanceId, 'fx:1')
      await client.processInstance({ instanceId: 'fx:1', inputs: ['AAAA'], numSamples: 64 })
      await client.setInstanceParam({ instanceId: 'fx:1', paramId: 0, value: 0.5 })
      await client.unloadInstance('fx:1')
      await client.listInstances()
      assert.deepEqual(requests.map((item) => item.type), ['loadInstance', 'processInstance', 'setInstanceParam', 'unloadInstance', 'listInstances'])
      assert.equal(requests[0].payload.sampleRate, 48000)
      assert.equal(requests[1].payload.numSamples, 64)
      assert.equal(requests[2].payload.paramId, 0)
      assert.equal(requests[3].payload.instanceId, 'fx:1')
    } finally {
      await client.close()
    }
  })

  it('getInstanceParams/saveInstanceState/loadInstanceState 方法映射', async () => {
    const { spawnImpl, requests } = fakeSpawn(() => ({ ok: true }))
    const client = createPluginHostClient({ nodeBin: process.execPath, spawnImpl, timeoutMs: 3000 })
    try {
      await client.getInstanceParams('fx:1', { offset: 2 })
      await client.saveInstanceState('fx:1')
      await client.loadInstanceState('fx:1', 'AAAA')
      assert.deepEqual(requests.map((item) => item.type), ['getInstanceParams', 'saveInstanceState', 'loadInstanceState'])
      assert.equal(requests[0].payload.offset, 2)
      assert.equal(requests[2].payload.state, 'AAAA')
    } finally {
      await client.close()
    }
  })

  it('真实 sidecar：ping maxInstances=8 / listInstances 空 / 未加载中文错误', async () => {
    const client = createPluginHostClient({ nodeBin: process.execPath, sidecarPath: DEFAULT_SIDECAR_PATH, timeoutMs: 15000 })
    try {
      const ping = await client.ping()
      assert.equal(ping.maxInstances, 8)
      assert.equal((await client.listInstances()).count, 0)
      await assert.rejects(client.loadInstance({ instanceId: 'fx:none' }), /缺少插件路径/)
      await assert.rejects(client.unloadInstance('fx:none'), /未加载/)
      await assert.rejects(client.processInstance({ instanceId: 'fx:none', inputs: [], numSamples: 64 }), /未加载/)
      await assert.rejects(client.saveInstanceState('fx:none'), /未加载/)
    } finally {
      await client.close()
    }
  })
})

describe('v2.2 M2 — desktop preload/main 静态契约', () => {
  it('preload：aimsPlugins 方法/通道', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/preload.cjs'), 'utf8')
    assert.ok(source.includes("contextBridge.exposeInMainWorld('aimsPlugins'"))
    for (const method of ['load:', 'process:', 'setParam:', 'unload:', 'status:', 'params:', 'reportStatus:']) assert.ok(source.includes(method), method)
    for (const channel of ['aims-plugin:load', 'aims-plugin:process', 'aims-plugin:set-param', 'aims-plugin:unload', 'aims-plugin:status']) assert.ok(source.includes(channel), channel)
    assert.ok(source.includes('supported: false'))
    assert.ok(source.includes('PLUGIN_HOST_UNAVAILABLE'))
  })

  it('main：IPC 通道/preload/启动调用/错误码', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    for (const channel of ['aims-plugin:load', 'aims-plugin:process', 'aims-plugin:set-param', 'aims-plugin:unload', 'aims-plugin:status', 'aims-plugin:params', 'aims-plugin:report-status']) {
      assert.ok(source.includes(channel), channel)
    }
    assert.ok(source.includes("preload: path.join(__dirname, 'preload.cjs')"))
    assert.ok(source.includes('registerPluginIpc()'))
    assert.ok(source.includes('serverHandle?.plugins'))
    assert.ok(source.includes('PLUGIN_HOST_TIMEOUT'))
    assert.ok(source.includes('20000'))
    assert.ok(source.includes('外部插件服务未就绪'))
    assert.ok(source.includes('outputsF32'))
  })

  it('server：startServer 返回 plugins 并 close 共享 sidecar', async () => {
    const source = await readFile(path.join(ROOT, 'src/standalone/server.mjs'), 'utf8')
    assert.ok(source.includes('plugins: getSharedPluginService(dataDir)'))
    assert.ok(source.includes('await closeSharedPluginServices()'))
  })

  it('sidecar：多实例协议/上限 8/旧协议兼容/中文错误', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes('MAX_INSTANCES = 8'))
    for (const type of ['loadInstance', 'unloadInstance', 'processInstance', 'setInstanceParam', 'getInstanceParams', 'saveInstanceState', 'listInstances']) {
      assert.ok(source.includes("type === '" + type + "'"), type)
    }
    for (const type of ['load', 'process', 'setParam', 'getParamsList', 'saveState', 'loadState', 'unload']) {
      assert.ok(source.includes("type === '" + type + "'"), type)
    }
    assert.ok(source.includes('__legacy__'))
    for (const text of ['插件实例未加载', '实例数量已达上限', 'numSamples 必须']) assert.ok(source.includes(text), text)
  })

  it('sidecar：bundle 目录解析到 Contents 内二进制', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes('function resolveBinaryPath'))
    assert.ok(source.includes("path.join(resolved, 'Contents', platformDir)"))
    assert.ok(source.includes('无法在 .vst3 bundle 中找到二进制'))
  })

  it('audio 桥静态文件存在（external-plugin/worklet）', async () => {
    assert.ok(existsSync(path.join(ROOT, 'src/client/audio/external-plugin.js')))
    assert.ok(existsSync(path.join(ROOT, 'src/client/audio/external-plugin-worklet.js')))
  })

  it('plugin-host-client：AIMS_NODE_BIN/错误码/默认 sidecar 路径', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/plugin-host-client.js'), 'utf8')
    assert.ok(source.includes('AIMS_NODE_BIN'))
    assert.ok(source.includes('PLUGIN_HOST_NO_NODE'))
    assert.ok(source.includes('plugin-host-node.cjs'))
  })

  it('plugin-service 导出共享 service 生命周期函数', async () => {
    assert.equal(typeof getSharedPluginService, 'function')
    assert.equal(typeof closeSharedPluginServices, 'function')
  })
})

describe('v2.2 M2 — 真实 fixture managed 副本', () => {
  it('install managed 副本可被真实 sidecar loadInstance/processInstance（缺失 fixture skip）', async (t) => {
    const fixture = process.env.AIMS_VST3_TEST_PLUGIN
      ? process.env.AIMS_VST3_TEST_PLUGIN
      : path.join(ROOT, '.dev-fixtures', 'vst3', 'TAL-Reverb-4.vst3')
    if (!existsSync(fixture)) {
      t.skip('缺少 AIMS_VST3_TEST_PLUGIN fixture')
      return
    }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    const client = createPluginHostClient({ nodeBin: process.execPath, sidecarPath: DEFAULT_SIDECAR_PATH, timeoutMs: 20000 })
    try {
      const installed = await service.install({ path: fixture })
      assert.equal(path.basename(installed.entry.managedPath), path.basename(fixture))
      const loaded = await client.loadInstance({
        instanceId: 'managed-check',
        path: installed.entry.managedPath,
        sampleRate: 48000,
        maxBlockSize: 256,
        audioInputs: 2,
        audioOutputs: 2,
      })
      assert.ok(loaded.plugin?.name)
      let sum = 0
      let count = 0
      for (let block = 0; block < 24; block += 1) {
        const left = new Float32Array(256)
        const right = new Float32Array(256)
        for (let index = 0; index < 256; index += 1) left[index] = right[index] = Math.sin(2 * Math.PI * 440 * (index / 48000)) * 0.25
        const result = await client.processInstance({
          instanceId: 'managed-check',
          inputs: [encodeF32(left), encodeF32(right)],
          numSamples: 256,
        })
        for (const encoded of (result.outputs ?? []).slice(0, 2)) {
          for (const sample of decodeF32(encoded)) { sum += sample * sample; count += 1 }
        }
      }
      const rms = Math.sqrt(sum / count)
      assert.ok(rms > 0.1157 && rms < 0.1415, 'managed 副本 RMS 应接近 0.1286（实际 ' + rms + '）')
    } finally {
      await client.close().catch(() => {})
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })
})

describe('v2.2 M2 — 跨源隔离 / SharedArrayBuffer', () => {
  it('server.mjs：所有响应带 COOP same-origin / COEP require-corp / CORP', async () => {
    const source = await readFile(path.join(ROOT, 'src/standalone/server.mjs'), 'utf8')
    assert.ok(source.includes("res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')"))
    assert.ok(source.includes("res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')"))
    assert.ok(source.includes("res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')"))
  })

  it('desktop main：session.onHeadersReceived 兜底注入隔离头', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    assert.ok(source.includes('installCrossOriginIsolation'))
    assert.ok(source.includes('session.defaultSession.webRequest.onHeadersReceived'))
    assert.ok(source.includes("'Cross-Origin-Opener-Policy'"))
    assert.ok(source.includes("'Cross-Origin-Embedder-Policy'"))
    assert.ok(source.includes("'Cross-Origin-Resource-Policy'"))
  })
})

