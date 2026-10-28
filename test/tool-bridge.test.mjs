/**
 * DSH 工具桥（tool-bridge）单元测试 —— P9 接线修复。
 *
 * 目标：
 * - 只代理到窗口 App，窗口不在时**直接报错、不回退本地**（不写隐藏数据）；
 * - endpoint 文件发现 / 代理调用 / 错误信息可操作；
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BRIDGE_URL = pathToFileURL(path.resolve(import.meta.dirname ?? '.', '..', 'src', 'host', 'tool-bridge.js')).href

async function tempDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'aims-bridge-'))
}

/** 起一个假的窗口 App（health + tool-call）。 */
async function startFakeApp() {
  const calls = []
  const server = http.createServer(async (req, res) => {
    if (req.url === '/studio/api/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, version: '1.0.0', rev: 1 }))
      return
    }
    if (req.url === '/studio/api/tool-call' && req.method === 'POST') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const payload = JSON.parse(raw)
      calls.push(payload)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, result: { ok: true, echoed: payload.name, args: payload.args, rev: 1 } }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('只代理到窗口 App：可用时转发 tool-call 并返回结果', async () => {
  const dir = await tempDir()
  const previous = {
    AIMS_APP_URL: process.env.AIMS_APP_URL,
    AIMS_ENDPOINT_DIR: process.env.AIMS_ENDPOINT_DIR,
    AIMS_PORT: process.env.AIMS_PORT,
    APPDATA: process.env.APPDATA,
  }
  const fake = await startFakeApp()
  try {
    await writeFile(
      path.join(dir, 'app-endpoint.json'),
      JSON.stringify({ version: '1.0.0', mode: 'window', port: Number(new URL(fake.base).port), dataDir: dir }),
      'utf8',
    )
    process.env.AIMS_APP_URL = fake.base
    process.env.AIMS_ENDPOINT_DIR = dir
    process.env.AIMS_PORT = '9'
    process.env.APPDATA = path.join(dir, 'no-appdata')

    const bridge = await import(BRIDGE_URL)
    const definition = {
      name: 'studio_test_echo',
      description: '测试工具',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true } },
      execute: async () => ({ ok: true, local: true }),
    }
    const proxied = bridge.withAppProxy(definition)
    const result = await proxied.execute({ a: 1 })
    assert.equal(result.ok, true)
    assert.equal(result.echoed, 'studio_test_echo')
    assert.deepEqual(result.args, { a: 1 })
    assert.equal(result.local, undefined, '有窗口时必须走 App，不能走本地 execute')
    assert.equal(fake.calls.length, 1)

    const info = await bridge.readEndpointInfo()
    assert.equal(info.dataDir, dir)
    assert.equal(info.url, fake.base)
  } finally {
    await fake.close()
    await rm(dir, { recursive: true, force: true })
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('窗口不在时直接报错（NO_APP_MESSAGE），绝不回退本地 execute', async () => {
  const dir = await tempDir()
  const previous = {
    AIMS_APP_URL: process.env.AIMS_APP_URL,
    AIMS_ENDPOINT_DIR: process.env.AIMS_ENDPOINT_DIR,
    AIMS_PORT: process.env.AIMS_PORT,
    APPDATA: process.env.APPDATA,
  }
  try {
    process.env.AIMS_APP_URL = 'http://127.0.0.1:9'
    process.env.AIMS_ENDPOINT_DIR = path.join(dir, 'empty')
    process.env.AIMS_PORT = '9'
    process.env.APPDATA = path.join(dir, 'no-appdata')
    const bridge = await import(BRIDGE_URL)
    assert.equal(await bridge.detectApp({ force: true }), null)
    let localCalled = false
    const definition = {
      name: 'studio_test_local',
      description: '测试工具',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true } },
      execute: async () => {
        localCalled = true
        return { ok: true, local: true }
      },
    }
    const proxied = bridge.withAppProxy(definition)
    await assert.rejects(() => proxied.execute({}), /没有运行/)
    assert.equal(localCalled, false, '窗口不在时不得调用本地 execute')
    assert.ok(bridge.NO_APP_MESSAGE.includes('不会写入任何后台数据'))
    assert.ok(bridge.NO_APP_MESSAGE.includes('studio_app_info'))
  } finally {
    await rm(dir, { recursive: true, force: true })
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
