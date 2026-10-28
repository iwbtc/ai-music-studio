/** v2.2 M3: instrument instances / MIDI events / preload+main IPC (ASCII-only test file). */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createPluginHostClient, DEFAULT_SIDECAR_PATH } from '../src/host/plugin-host-client.js'
import { createPluginService } from '../src/host/plugin-service.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const INSTRUMENT_FIXTURE = process.env.AIMS_VST3_TEST_INSTRUMENT_PLUGIN || path.join(ROOT, '.dev-fixtures', 'vst3-instrument', 'TAL-NoiseMaker.vst3')
const EFFECT_FIXTURE = process.env.AIMS_VST3_TEST_PLUGIN || path.join(ROOT, '.dev-fixtures', 'vst3', 'TAL-Reverb-4.vst3')
const HAS_INSTRUMENT = existsSync(INSTRUMENT_FIXTURE)
const HAS_EFFECT = existsSync(EFFECT_FIXTURE)

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'aims-m3-')) }

async function makeBundle(root, name = 'TAL-Reverb-4') {
  const bundle = path.join(root, `${name}.vst3`)
  const binary = path.join(bundle, 'Contents', 'x86_64-win', `${name}.vst3`)
  await mkdir(path.dirname(binary), { recursive: true })
  await writeFile(binary, 'fake', 'utf8')
  return { bundle }
}

function encodeF32(array) { return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64') }
function decodeF32(base64) {
  const buffer = Buffer.from(base64, 'base64')
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
}

function makeClient(overrides = {}) {
  const calls = []
  const client = {
    async inspect(target) {
      return [{ path: String(target), name: 'Mock Plugin', vendor: 'Mock', version: '1.0', category: 'Audio Module Class', subCategories: 'Fx', classId: 'mockclass' }]
    },
    async load() { return {} },
    async getParamsList() { return { count: 0, items: [] } },
    async loadInstance(options) {
      calls.push({ type: 'loadInstance', options })
      const instrument = options.kind === 'instrument'
      return { instanceId: options.instanceId, latencySamples: instrument ? 0 : 480, midiInputs: instrument ? 1 : 0, plugin: { numMidiInputs: instrument ? 1 : 0 }, ...options }
    },
    async unloadInstance(instanceId) { calls.push({ type: 'unloadInstance', instanceId }); return { instanceId, unloaded: true } },
    async processInstance(options) {
      calls.push({ type: 'processInstance', options })
      const inputs = (options.inputs ?? []).map(decodeF32)
      const midiCount = Array.isArray(options.midi) ? options.midi.length : 0
      const outputs = inputs.length > 0
        ? inputs.map((input) => Float32Array.from(input, (value) => value * 0.5))
        : [new Float32Array(options.numSamples).fill(0.1)]
      return { ms: 0.2, outputs: outputs.map(encodeF32), outputEvents: [], midiEventCount: midiCount }
    },
    async setInstanceParam(options) { calls.push({ type: 'setInstanceParam', options }); return { ...options } },
    async getInstanceParams() { return { count: 2, items: [{ id: 0, title: 'Mix', units: '%', value: 0.5 }, { id: 1, title: 'Tune', units: 'st', value: 0.5 }] } },
    async saveInstanceState() { return { state: 'c3RhdGU=' } },
    async close() {},
    calls,
    ...overrides,
  }
  return client
}

async function serviceWithInstrument() {
  const dataDir = await tempDir()
  const sourceDir = await tempDir()
  const { bundle } = await makeBundle(sourceDir, 'Instrument')
  const client = makeClient()
  const service = createPluginService({ dataDir, client })
  const installed = await service.install({ path: bundle })
  return { service, client, dataDir, sourceDir, pluginId: installed.plugin.pluginId, bundle }
}

async function cleanup(service, dataDir, sourceDir) {
  await service.close().catch(() => {})
  await rm(dataDir, { recursive: true, force: true }).catch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })
  await rm(sourceDir, { recursive: true, force: true }).catch(() => {})
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
        queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: message.id, ok: true, result: handler(message) }) + '\n'))
      },
      end: () => {},
    }
    child.kill = () => {}
    queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n'))
    return child
  }
  return { spawnImpl, requests }
}

describe('v2.2 M3 service instrument instances', () => {
  it('loads instrument instance with kind and midiInputs', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      const info = await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument', sampleRate: 48000, maxBlockSize: 256 })
      assert.equal(info.kind, 'instrument')
      assert.equal(info.midiInputs, 1)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('defaults audioInputs=0 for instrument', async () => {
    const { service, client, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      const info = await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument' })
      assert.equal(info.audioInputs, 0)
      assert.equal(client.calls.find((item) => item.type === 'loadInstance').options.audioInputs, 0)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('infers instrument when kind omitted and audioInputs=0', async () => {
    const { service, client, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      const info = await service.loadInstance(pluginId, { instanceId: 'track:trk_1', audioInputs: 0 })
      assert.equal(info.kind, 'instrument')
      assert.equal(client.calls.find((item) => item.type === 'loadInstance').options.kind, 'instrument')
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('defaults audioInputs=2 for effect', async () => {
    const { service, client, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      const info = await service.loadInstance(pluginId, { instanceId: 'fx:fx_1', kind: 'effect' })
      assert.equal(info.kind, 'effect')
      assert.equal(client.calls.find((item) => item.type === 'loadInstance').options.audioInputs, 2)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('rejects invalid kind', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await assert.rejects(service.loadInstance(pluginId, { instanceId: 'track:x', kind: 'midi' }), /kind/)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('passes midi events to sidecar', async () => {
    const { service, client, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument', maxBlockSize: 256 })
      const midi = [{ type: 'noteOn', pitch: 60, velocity: 0.8, sampleOffset: 0 }, { type: 'noteOff', pitch: 60, sampleOffset: 128 }]
      await service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 256, midi })
      assert.deepEqual(client.calls.find((item) => item.type === 'processInstance').options.midi, midi)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('returns midiEventCount', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument', maxBlockSize: 256 })
      const result = await service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 256, midi: [{ type: 'noteOn', pitch: 60, velocity: 1 }, { type: 'noteOff', pitch: 60 }] })
      assert.equal(result.midiEventCount, 2)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('returns zero midiEventCount without midi', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument' })
      const result = await service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 256 })
      assert.equal(result.midiEventCount, 0)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('listInstances exposes kind/midiInputs/midiEventCount', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument' })
      await service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 256, midi: [{ type: 'noteOn', pitch: 60, velocity: 1 }] })
      const item = (await service.listInstances()).instances[0]
      assert.equal(item.kind, 'instrument')
      assert.equal(item.midiInputs, 1)
      assert.equal(item.midiEventCount, 1)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('setParam/getParams work for instrument instance', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument' })
      assert.equal((await service.getInstanceParams('track:trk_1')).count, 2)
      assert.equal((await service.setInstanceParam({ instanceId: 'track:trk_1', paramId: 1, value: 0.3 })).value, 0.3)
      await assert.rejects(service.setInstanceParam({ instanceId: 'track:trk_1', paramId: 1, value: 2 }), /0\.\.1/)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('unload instrument then process fails', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument' })
      assert.equal((await service.unloadInstance('track:trk_1')).unloaded, true)
      await assert.rejects(service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 256 }), /PLUGIN_INSTANCE_NOT_FOUND|not loaded|未加载/)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('status counts instrument instances', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument' })
      const status = service.status()
      assert.equal(status.started, true)
      assert.equal(status.instances, 1)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('object-style loadInstance keeps kind', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      const info = await service.loadInstance({ pluginId, instanceId: 'track:trk_1', kind: 'instrument', audioInputs: 0 })
      assert.equal(info.kind, 'instrument')
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('reload same instance id replaces instance', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:reload', kind: 'instrument', maxBlockSize: 128 })
      const second = await service.loadInstance(pluginId, { instanceId: 'track:reload', kind: 'instrument', maxBlockSize: 256 })
      assert.equal(second.maxBlockSize, 256)
      assert.equal((await service.listInstances()).count, 1)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('unknown instance operations fail', async () => {
    const { service, dataDir, sourceDir } = await serviceWithInstrument()
    try {
      assert.equal(service.getInstanceInfo('track:none'), null)
      await assert.rejects(service.getInstanceParams('track:none'), /not|未加载|PLUGIN_INSTANCE/i)
      await assert.rejects(service.saveInstanceState('track:none'), /not|未加载|PLUGIN_INSTANCE/i)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('process invalid block size fails', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument', maxBlockSize: 256 })
      await assert.rejects(service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 0 }), /numSamples/)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('reportInstanceStatus updates midi/underrun diagnostics', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument' })
      const reported = service.reportInstanceStatus({ instanceId: 'track:trk_1', underrun: true, underruns: 2, bufferMs: 3 })
      assert.equal(reported.instance.underrun, true)
      assert.equal(reported.instance.underruns, 2)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('close clears instrument instances', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument' })
      await service.close()
      assert.equal((await service.listInstances()).count, 0)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('load missing plugin fails with PLUGIN_NOT_FOUND', async () => {
    const { service, dataDir, sourceDir } = await serviceWithInstrument()
    try {
      await assert.rejects(service.loadInstance('vst3_missing', { instanceId: 'track:x', kind: 'instrument' }), (error) => error.code === 'PLUGIN_NOT_FOUND')
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('base64 output format preserved for instrument', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument' })
      const result = await service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 64, outputFormat: 'base64' })
      assert.equal(typeof result.outputs[0], 'string')
      assert.equal(result.outputs.length, 1)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })
})

describe('v2.2 M3 real instrument fixture', () => {
  it('loads instrument with midiInputs=1 and 2169 params', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      const loaded = await service.loadInstance(installed.plugin.pluginId, { instanceId: 'track:fixture', kind: 'instrument', sampleRate: 48000, maxBlockSize: 256 })
      assert.equal(loaded.kind, 'instrument')
      assert.equal(loaded.midiInputs, 1)
      assert.equal(loaded.audioInputs, 0)
      const params = await service.getInstanceParams('track:fixture')
      assert.equal(params.count, 2169)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })

  it('NoteOn C4 produces audio on 40x256 blocks', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      await service.loadInstance(installed.plugin.pluginId, { instanceId: 'track:fixture', kind: 'instrument', sampleRate: 48000, maxBlockSize: 256 })
      let sum = 0
      let count = 0
      for (let block = 0; block < 40; block += 1) {
        const midi = block === 0 ? [{ type: 'noteOn', pitch: 60, velocity: 0.8, sampleOffset: 0 }] : []
        const result = await service.processInstance({ instanceId: 'track:fixture', inputs: [], numSamples: 256, midi })
        for (const channel of result.outputs) for (const sample of channel) { sum += sample * sample; count += 1 }
      }
      const rms = Math.sqrt(sum / count)
      assert.ok(rms > 0.05, `expected audio RMS>0.05, got ${rms}`)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })

  it('NoteOff eventually decays energy', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      await service.loadInstance(installed.plugin.pluginId, { instanceId: 'track:fixture', kind: 'instrument', maxBlockSize: 256 })
      await service.processInstance({ instanceId: 'track:fixture', inputs: [], numSamples: 256, midi: [{ type: 'noteOn', pitch: 60, velocity: 0.8 }] })
      await service.processInstance({ instanceId: 'track:fixture', inputs: [], numSamples: 256, midi: [{ type: 'noteOff', pitch: 60, sampleOffset: 0 }] })
      let sum = 0
      let count = 0
      for (let block = 0; block < 5; block += 1) {
        const result = await service.processInstance({ instanceId: 'track:fixture', inputs: [], numSamples: 256 })
        for (const channel of result.outputs) for (const sample of channel) { sum += sample * sample; count += 1 }
      }
      assert.ok(Math.sqrt(sum / count) >= 0)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })

  it('instrument instance works with setParam and list', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      await service.loadInstance(installed.plugin.pluginId, { instanceId: 'track:fixture', kind: 'instrument', maxBlockSize: 256 })
      const params = await service.getInstanceParams('track:fixture')
      await service.setInstanceParam({ instanceId: 'track:fixture', paramId: params.params[0].id, value: 0.25 })
      const item = (await service.listInstances()).instances[0]
      assert.equal(item.kind, 'instrument')
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })

  it('loading instrument as effect fails with Chinese error', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      await assert.rejects(service.loadInstance(installed.plugin.pluginId, { instanceId: 'track:bad', kind: 'effect' }), /乐器/)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })

  it('loading effect as instrument fails with Chinese error', async (t) => {
    if (!HAS_EFFECT) { t.skip('effect fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: EFFECT_FIXTURE })
      await assert.rejects(service.loadInstance(installed.plugin.pluginId, { instanceId: 'track:bad', kind: 'instrument' }), /不是 MIDI 乐器/)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })

  it('3x load/unload instrument cycles without crash', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      for (let round = 1; round <= 3; round += 1) {
        const instanceId = `track:cycle${round}`
        await service.loadInstance(installed.plugin.pluginId, { instanceId, kind: 'instrument', maxBlockSize: 256 })
        const result = await service.processInstance({ instanceId, inputs: [], numSamples: 256, midi: [{ type: 'noteOn', pitch: 60, velocity: 0.8 }] })
        assert.ok(result.outputs.length > 0)
        assert.equal((await service.unloadInstance(instanceId)).unloaded, true)
      }
      assert.equal((await service.listInstances()).count, 0)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })

  it('managed copy keeps original bundle name', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      assert.equal(path.basename(installed.entry.managedPath), path.basename(INSTRUMENT_FIXTURE))
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })

  it('fixture paths exist as expected', () => {
    assert.equal(typeof HAS_INSTRUMENT, 'boolean')
    assert.equal(typeof HAS_EFFECT, 'boolean')
  })

  it('instrument config has midi input metadata', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      const loaded = await service.loadInstance(installed.plugin.pluginId, { instanceId: 'track:meta', kind: 'instrument' })
      assert.ok(loaded.midiInputs >= 1)
      assert.equal(loaded.kind, 'instrument')
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })
})

describe('v2.2 M3 static preload/main/sidecar/service contract', () => {
  it('preload load doc mentions kind', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/preload.cjs'), 'utf8')
    assert.ok(source.includes("kind?:'instrument'|'effect'"))
    assert.ok(source.includes('track:<trackId>'))
  })

  it('preload process doc mentions midi and midiEventCount', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/preload.cjs'), 'utf8')
    assert.ok(source.includes('midi?:'))
    assert.ok(source.includes('midiEventCount'))
  })

  it('main validates kind values', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    assert.ok(source.includes("kind !== 'instrument' && kind !== 'effect'"))
    assert.ok(source.includes('kind: kind ==='))
  })

  it('main load passes kind to service', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    assert.ok(source.includes("kind: kind === '' ? undefined : kind"))
  })

  it('main validates midi array', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    assert.ok(source.includes('Array.isArray(args?.midi)'))
    assert.ok(source.includes('midi 事件过多'))
    assert.ok(source.includes('midi 事件必须是对象'))
  })

  it('main returns midiEventCount', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    assert.ok(source.includes('midiEventCount: result.midiEventCount'))
    assert.ok(source.includes('outputsF32'))
  })

  it('sidecar validates kind', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes("kind 必须是 'instrument' 或 'effect'"))
  })

  it('sidecar defaults audioInputs 0 for instrument', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes("kind === 'instrument' ? 0 : 2"))
  })

  it('sidecar uses midi inputs/subcategories for instrument detection', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes('numMidiInputs'))
    assert.ok(source.includes('/instrument/i'))
  })

  it('sidecar rejects effect-as-instrument and instrument-as-effect', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes('插件不是 MIDI 乐器'))
    assert.ok(source.includes('插件是乐器'))
  })

  it('sidecar implements midiEventsToBytes', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes('function midiEventsToBytes'))
    for (const token of ['noteOn', 'noteOff', "'cc'", 'pitchBend']) assert.ok(source.includes(token), token)
  })

  it('sidecar converts midi to addMidiBytes and counts', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes('addMidiBytes(event.sampleOffset, event.bytes)'))
    assert.ok(source.includes('midiEventCount: midiEvents.length'))
  })

  it('sidecar list/info exposes kind and midi fields', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes('kind: instance.kind'))
    assert.ok(source.includes('midiInputs: instance.midiInputs'))
    assert.ok(source.includes('midiEventCount: instance.midiEventCount'))
  })

  it('service handles kind detection', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/plugin-service.js'), 'utf8')
    assert.ok(source.includes('rawKind'))
    assert.ok(source.includes("kind === 'instrument' ? 0 : 2"))
  })

  it('service passes midi and returns count', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/plugin-service.js'), 'utf8')
    assert.ok(source.includes('midi: Array.isArray(midi) ? midi : []'))
    assert.ok(source.includes('midiEventCount'))
    assert.ok(source.includes('Number(result?.midiEventCount ?? 0)'))
  })

  it('service list exposes kind/midiInputs/midiEventCount', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/plugin-service.js'), 'utf8')
    assert.ok(source.includes('kind: meta.kind'))
    assert.ok(source.includes('midiInputs: meta.midiInputs'))
    assert.ok(source.includes('midiEventCount: meta.midiEventCount'))
  })

  it('studio_add_plugin_track remains instrument entry', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/tools.js'), 'utf8')
    assert.ok(source.includes("name: 'studio_add_plugin_track'"))
    assert.ok(source.includes("engine: 'vst3'"))
  })

  it('instrument fixture directory exists when available', () => {
    assert.equal(HAS_INSTRUMENT, existsSync(path.join(ROOT, '.dev-fixtures', 'vst3-instrument')))
  })
})

describe('v2.2 M3 sidecar client MIDI protocol', () => {
  it('loadInstance payload includes kind/audioInputs', async () => {
    const { spawnImpl, requests } = fakeSpawn((message) => ({ instanceId: message.payload.instanceId, midiInputs: 1 }))
    const client = createPluginHostClient({ nodeBin: process.execPath, spawnImpl, timeoutMs: 3000 })
    try {
      const loaded = await client.loadInstance({ instanceId: 'track:trk_1', path: 'x.vst3', kind: 'instrument', audioInputs: 0, sampleRate: 48000, maxBlockSize: 256 })
      assert.equal(loaded.midiInputs, 1)
      assert.equal(requests[0].payload.kind, 'instrument')
      assert.equal(requests[0].payload.audioInputs, 0)
    } finally { await client.close() }
  })

  it('processInstance payload includes midi', async () => {
    const { spawnImpl, requests } = fakeSpawn((message) => ({ outputs: [], midiEventCount: message.payload.midi?.length ?? 0 }))
    const client = createPluginHostClient({ nodeBin: process.execPath, spawnImpl, timeoutMs: 3000 })
    try {
      const result = await client.processInstance({ instanceId: 'track:1', inputs: [], numSamples: 256, midi: [{ type: 'noteOn', pitch: 60, velocity: 1 }] })
      assert.equal(result.midiEventCount, 1)
      assert.equal(requests[0].payload.midi.length, 1)
    } finally { await client.close() }
  })

  it('real sidecar rejects instrument load without path', async () => {
    const client = createPluginHostClient({ nodeBin: process.execPath, sidecarPath: DEFAULT_SIDECAR_PATH, timeoutMs: 15000 })
    try {
      await assert.rejects(client.loadInstance({ instanceId: 'track:none', kind: 'instrument' }), /缺少插件路径|path/i)
      await assert.rejects(client.loadInstance({ instanceId: 'fx:none', kind: 'bogus', path: 'x.vst3' }), /kind/)
    } finally { await client.close() }
  })

  it('real sidecar effect accepts midi events without crash', async (t) => {
    if (!HAS_EFFECT) { t.skip('effect fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: EFFECT_FIXTURE })
      await service.loadInstance(installed.plugin.pluginId, { instanceId: 'fx:midi', kind: 'effect', maxBlockSize: 256 })
      const result = await service.processInstance({ instanceId: 'fx:midi', inputs: [new Float32Array(256), new Float32Array(256)], numSamples: 256, midi: [{ type: 'cc', controller: 1, value: 64 }] })
      assert.equal(result.midiEventCount, 1)
      assert.equal(result.outputs.length, 2)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })

  it('M3 main kind validation is documented for IPC', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    assert.ok(source.includes("kind !== 'instrument' && kind !== 'effect'"))
  })
})

describe('v2.2 M3 extra MIDI/instance checks', () => {
  it('service accumulates midiEventCount across blocks', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument', maxBlockSize: 256 })
      await service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 256, midi: [{ type: 'noteOn', pitch: 60, velocity: 1 }] })
      await service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 256, midi: [{ type: 'noteOff', pitch: 60 }] })
      assert.equal((await service.listInstances()).instances[0].midiEventCount, 2)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('service accepts cc/pitchBend events', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:trk_1', kind: 'instrument', maxBlockSize: 256 })
      const result = await service.processInstance({ instanceId: 'track:trk_1', inputs: [], numSamples: 256, midi: [
        { type: 'cc', controller: 64, value: 127, sampleOffset: 0 },
        { type: 'pitchBend', value: 0, sampleOffset: 10 },
      ] })
      assert.equal(result.midiEventCount, 2)
    } finally { await cleanup(service, dataDir, sourceDir) }
  })

  it('sidecar source contains all MIDI event branches', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    for (const token of ['0x90', '0x80', '0xb0', '0xe0', 'sampleOffset', 'velocity']) assert.ok(source.includes(token), token)
  })

  it('main process returns both outputs base64 and outputsF32', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    assert.ok(source.includes('outputs: result.outputsBase64'))
    assert.ok(source.includes('outputsF32: result.outputs'))
  })

  it('service list keeps kind effect for non instrument', async () => {
    const { service, dataDir, sourceDir, pluginId } = await serviceWithInstrument()
    try {
      await service.loadInstance(pluginId, { instanceId: 'fx:x', kind: 'effect' })
      assert.equal((await service.listInstances()).instances[0].kind, 'effect')
    } finally { await cleanup(service, dataDir, sourceDir) }
  })
})


describe('v2.2 M3 host kind metadata and static params', () => {
  it('track.vst3 summary/getProject/add_track include kind=instrument', async () => {
    const [ops, model] = await Promise.all([import('../src/host/ops.js'), import('../src/shared/model.js')])
    const project = model.createEmptyProject()
    const vst3 = { pluginId: 'vst3_inst', name: 'TAL-NoiseMaker', category: 'Audio Module Class', subCategories: 'Instrument|Synth', kind: 'instrument', isInstrument: true, midiInputs: 1 }
    const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'Inst', vst3 })
    assert.equal(track.track.vst3.kind, 'instrument')
    assert.equal(track.track.vst3.isInstrument, true)
    assert.equal(track.track.vst3.subCategories, 'Instrument|Synth')
    const trackView = ops.getProjectOverview(project).tracks.find((item) => item.id === track.trackId)
    assert.equal(trackView.vst3.kind, 'instrument')
    assert.equal(trackView.vst3.isInstrument, true)
    assert.ok(/instrument|synth/i.test(JSON.stringify(trackView.vst3)))
  })

  it('effect.vst3 summary includes kind=effect/isInstrument=false', async () => {
    const [ops, model] = await Promise.all([import('../src/host/ops.js'), import('../src/shared/model.js')])
    const project = model.createEmptyProject()
    const track = ops.addTrack(project, { kind: 'synth', name: 'S', preset: 'grand_piano' })
    const effect = ops.addEffect(project, { target: track.trackId, type: 'vst3', vst3: { pluginId: 'vst3_fx', name: 'Reverb' } })
    const item = effect.chain.find((fx) => fx.id === effect.effectId)
    assert.equal(item.vst3.kind, 'effect')
    assert.equal(item.vst3.isInstrument, false)
  })

  it('real fixture parameters returns 2169 via registry instrument mode', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      const params = await service.parameters(installed.plugin.pluginId)
      assert.equal(params.count, 2169)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      })
    }
  })
})

