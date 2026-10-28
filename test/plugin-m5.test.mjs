/** v2.2 M5: packaged resource resolution for Node runtime + sidecar + nvst3-host. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  DEFAULT_SIDECAR_PATH,
  PluginHostError,
  createPluginHostClient,
  findNodeInPath,
  resolveNodeBin,
  resolveSidecarPath,
} from '../src/host/plugin-host-client.js'

const ROOT = path.resolve(import.meta.dirname, '..')

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'aims-m5-')) }

async function makePackagedLayout() {
  const root = await tempDir()
  const resources = path.join(root, 'resources')
  await mkdir(path.join(resources, 'native', 'node'), { recursive: true })
  await writeFile(path.join(resources, 'native', 'node', 'node.exe'), 'node-stub', 'utf8')
  await writeFile(path.join(resources, 'native', 'plugin-host-node.cjs'), '// sidecar', 'utf8')
  return { root, resources }
}

describe('v2.2 M5 packaged Node runtime resolution', () => {
  it('resolves resources/native/node/node.exe', async () => {
    const { resources } = await makePackagedLayout()
    try {
      const node = resolveNodeBin({ resourcesPath: resources, execPath: path.join(path.dirname(resources), 'app.exe'), env: { PATH: '' } })
      assert.equal(path.relative(resources, node), path.join('native', 'node', 'node.exe'))
    } finally { await rm(path.dirname(resources), { recursive: true, force: true }) }
  })
  it('falls back to resources/native/node.exe (legacy layout)', async () => {
    const root = await tempDir()
    try {
      const resources = path.join(root, 'resources')
      await mkdir(path.join(resources, 'native'), { recursive: true })
      await writeFile(path.join(resources, 'native', 'node.exe'), 'node', 'utf8')
      const node = resolveNodeBin({ resourcesPath: resources, execPath: path.join(root, 'app.exe'), env: { PATH: '' } })
      assert.equal(node, path.join(resources, 'native', 'node.exe'))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('AIMS_NODE_BIN overrides packaged runtime', async () => {
    const { root, resources } = await makePackagedLayout()
    try {
      const explicit = path.join(root, 'custom-node.exe')
      await writeFile(explicit, 'node', 'utf8')
      const node = resolveNodeBin({ nodeBin: explicit, resourcesPath: resources, execPath: path.join(root, 'app.exe'), env: { PATH: '' } })
      assert.equal(node, path.resolve(explicit))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('missing packaged runtime throws PLUGIN_HOST_NO_NODE', async () => {
    const root = await tempDir()
    try {
      assert.throws(() => resolveNodeBin({ resourcesPath: path.join(root, 'missing-resources'), execPath: path.join(root, 'app.exe'), env: { PATH: '' } }), (error) => {
        assert.ok(error instanceof PluginHostError)
        assert.equal(error.code, 'PLUGIN_HOST_NO_NODE')
        assert.match(error.message, /resources\/native\/node\/node\.exe|AIMS_NODE_BIN/)
        return true
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('findNodeInPath returns null with empty PATH', () => {
    assert.equal(findNodeInPath({ PATH: '' }), null)
  })
  it('resolveSidecarPath finds resources/native/plugin-host-node.cjs', async () => {
    const { root, resources } = await makePackagedLayout()
    try {
      const sidecar = resolveSidecarPath({ resourcesPath: resources, execPath: path.join(root, 'app.exe') })
      assert.equal(sidecar, path.join(resources, 'native', 'plugin-host-node.cjs'))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('resolveSidecarPath finds app-resources/desktop layout', async () => {
    const root = await tempDir()
    try {
      const resources = path.join(root, 'resources')
      await mkdir(path.join(resources, 'app-resources', 'desktop'), { recursive: true })
      const sidecar = path.join(resources, 'app-resources', 'desktop', 'plugin-host-node.cjs')
      await writeFile(sidecar, '// sidecar', 'utf8')
      assert.equal(resolveSidecarPath({ resourcesPath: resources, execPath: path.join(root, 'app.exe') }), sidecar)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('resolveSidecarPath falls back to dev DEFAULT_SIDECAR_PATH', () => {
    assert.equal(resolveSidecarPath({ resourcesPath: path.join(os.tmpdir(), 'missing-res'), execPath: path.join(os.tmpdir(), 'missing-app.exe') }), DEFAULT_SIDECAR_PATH)
  })
  it('bad explicit sidecar path throws PLUGIN_HOST_NO_SIDECAR', () => {
    assert.throws(() => resolveSidecarPath({ sidecarPath: path.join(os.tmpdir(), 'no-sidecar.cjs') }), (error) => error.code === 'PLUGIN_HOST_NO_SIDECAR')
  })
  it('client with packaged resources spawns packaged node + sidecar', async () => {
    const { root, resources } = await makePackagedLayout()
    const calls = []
    const spawnImpl = (command, args) => {
      calls.push({ command, args })
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { writable: true, write: (line) => { const msg = JSON.parse(line); queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: msg.id, ok: true, result: { pid: 1 } }) + '\n')) }, end: () => {} }
      child.kill = () => {}
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n'))
      return child
    }
    const client = createPluginHostClient({ resourcesPath: resources, execPath: path.join(root, 'app.exe'), env: { PATH: '' }, spawnImpl, timeoutMs: 3000 })
    try {
      assert.equal(client.nodeBin, path.join(resources, 'native', 'node', 'node.exe'))
      await client.ping()
      assert.equal(calls[0].command, path.join(resources, 'native', 'node', 'node.exe'))
      assert.equal(calls[0].args[0], path.join(resources, 'native', 'plugin-host-node.cjs'))
    } finally {
      await client.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('client missing sidecar resource yields Chinese error', async () => {
    const root = await tempDir()
    try {
      const resources = path.join(root, 'resources')
      await mkdir(path.join(resources, 'native', 'node'), { recursive: true })
      await writeFile(path.join(resources, 'native', 'node', 'node.exe'), 'node', 'utf8')
      const client = createPluginHostClient({ resourcesPath: resources, execPath: path.join(root, 'app.exe'), env: { PATH: '' }, timeoutMs: 1000 })
      await assert.rejects(client.ping(), /sidecar 脚本不存在|AIMS_PLUGIN_HOST_SCRIPT/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('sidecar source resolves nvst3-host from __dirname/resource candidates', async () => {
    const source = await readFile(path.join(ROOT, 'desktop', 'plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes("path.join(__dirname, 'nvst3-host'"))
    assert.ok(source.includes("path.join(__dirname, 'node_modules', 'nvst3-host')"))
    assert.ok(source.includes("process.resourcesPath"))
    assert.ok(source.includes('AIMS_NVST3_HOST_PATH'))
  })
  it('sidecar source keeps fallback require nvst3-host', async () => {
    const source = await readFile(path.join(ROOT, 'desktop', 'plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes("'nvst3-host',"))
  })
  it('client source supports AIMS_PLUGIN_HOST_SCRIPT and resources candidates', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/plugin-host-client.js'), 'utf8')
    assert.ok(source.includes('AIMS_PLUGIN_HOST_SCRIPT'))
    assert.ok(source.includes("path.join(resourcesPath, 'native', 'plugin-host-node.cjs')"))
    assert.ok(source.includes("path.join(resourcesPath, 'native', 'node', 'node.exe')"))
  })
  it('dev sidecar path exists in repo', () => {
    assert.equal(existsSync(DEFAULT_SIDECAR_PATH), true)
  })
  it('AIMS_PLUGIN_HOST_SCRIPT env override resolves existing path', async () => {
    const root = await tempDir()
    const previous = process.env.AIMS_PLUGIN_HOST_SCRIPT
    try {
      const sidecar = path.join(root, 'custom.cjs')
      await writeFile(sidecar, '// sidecar', 'utf8')
      process.env.AIMS_PLUGIN_HOST_SCRIPT = sidecar
      assert.equal(resolveSidecarPath({}), sidecar)
    } finally {
      if (previous === undefined) delete process.env.AIMS_PLUGIN_HOST_SCRIPT
      else process.env.AIMS_PLUGIN_HOST_SCRIPT = previous
      await rm(root, { recursive: true, force: true })
    }
  })
  it('AIMS_NODE_BIN env override resolves existing path', async () => {
    const root = await tempDir()
    const previous = process.env.AIMS_NODE_BIN
    try {
      const node = path.join(root, 'node.exe')
      await writeFile(node, 'node', 'utf8')
      process.env.AIMS_NODE_BIN = node
      assert.equal(resolveNodeBin({ env: { PATH: '', AIMS_NODE_BIN: node } }), node)
    } finally {
      if (previous === undefined) delete process.env.AIMS_NODE_BIN
      else process.env.AIMS_NODE_BIN = previous
      await rm(root, { recursive: true, force: true })
    }
  })
})
