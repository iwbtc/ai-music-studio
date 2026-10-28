/**
 * task-79：studio_app_status 本地工具单测（全部注入/临时目录，不启动真实窗口）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  APP_STATUS_FILE,
  createAppStatusTool,
  formatLastExit,
  getAppStatus,
  parseStartedAt,
  readStatusFile,
  statusFileCandidates,
} from '../src/host/app-status.js'
import { NO_APP_MESSAGE } from '../src/host/tool-bridge.js'

const tmpDirs = []
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aims-app-status-'))
  tmpDirs.push(dir)
  return dir
}

async function writeStatus(dir, value) {
  await writeFile(path.join(dir, APP_STATUS_FILE), typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  return path.join(dir, APP_STATUS_FILE)
}

describe('task-79 — app-status 基础函数', () => {
  it('常量与 parseStartedAt：毫秒/ISO/非法', () => {
    assert.equal(APP_STATUS_FILE, 'app-status.json')
    assert.equal(parseStartedAt(1700000000000), 1700000000000)
    assert.equal(parseStartedAt(String(1700000000000)), 1700000000000)
    assert.equal(parseStartedAt('2026-10-23T10:00:00.000Z'), Date.parse('2026-10-23T10:00:00.000Z'))
    assert.equal(parseStartedAt('not-a-date'), null)
    assert.equal(parseStartedAt(undefined), null)
  })

  it('statusFileCandidates：AIMS_STATUS_FILE 优先；AIMS_DATA_DIR/APPDATA/data 顺序去重', () => {
    const explicit = statusFileCandidates({ env: { AIMS_STATUS_FILE: 'C:\\tmp\\custom.json' }, root: 'C:\\repo' })
    assert.deepEqual(explicit, [path.resolve('C:\\tmp\\custom.json')])
    const candidates = statusFileCandidates({
      env: { AIMS_DATA_DIR: 'C:\\dataA', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      root: 'C:\\repo',
      extraDirs: ['C:\\extra'],
    })
    assert.equal(candidates[0], path.join('C:\\dataA', APP_STATUS_FILE))
    assert.ok(candidates.includes(path.join('C:\\extra', APP_STATUS_FILE)))
    assert.ok(candidates.some((file) => file.includes(path.join('AI音乐工作室', 'data'))))
    assert.ok(candidates.includes(path.join('C:\\repo', 'data', APP_STATUS_FILE)))
    assert.equal(new Set(candidates).size, candidates.length)
  })

  it('formatLastExit：code/reason/signal/time 组合与空值', () => {
    assert.equal(formatLastExit(null), null)
    const text = formatLastExit({ at: Date.parse('2026-10-23T10:00:00.000Z'), code: 1, reason: '渲染进程崩溃' })
    assert.match(text, /^上次退出：/)
    assert.match(text, /exit code 1/)
    assert.match(text, /渲染进程崩溃/)
    assert.match(formatLastExit({ signal: 'SIGTERM' }), /signal SIGTERM/)
  })

  it('readStatusFile：合法/缺失/损坏/非对象', async () => {
    const dir = await tempDir()
    const file = await writeStatus(dir, { running: false, lastExit: { code: 0 } })
    const ok = await readStatusFile(file)
    assert.equal(ok.ok, true)
    assert.equal(ok.status.lastExit.code, 0)
    const missing = await readStatusFile(path.join(dir, 'nope.json'))
    assert.equal(missing.ok, false)
    assert.equal(missing.missing, true)
    const broken = await writeStatus(dir, '{not json')
    const brokenRead = await readStatusFile(broken)
    assert.equal(brokenRead.ok, false)
    assert.match(brokenRead.error, /不是合法 JSON/)
    const notObject = await writeStatus(path.join(await tempDir(), ''), '[1,2]')
    const arrayRead = await readStatusFile(notObject)
    assert.equal(arrayRead.ok, false)
    assert.match(arrayRead.error, /不是 JSON 对象/)
  })
})

describe('task-79 — getAppStatus', () => {
  it('窗口运行中：读状态文件返回 running/url/pid/uptimeMs/version/dataDir', async () => {
    const dir = await tempDir()
    await writeStatus(dir, { pid: 4321, version: '2.3.4', startedAt: 1700000000000 })
    const result = await getAppStatus({
      detect: async () => 'http://127.0.0.1:41731',
      getTarget: () => ({ dataDir: dir, pid: 999 }),
      now: () => 1700000050000,
      extraDirs: [dir],
      env: {},
      root: dir,
    })
    assert.equal(result.ok, true)
    assert.equal(result.running, true)
    assert.equal(result.status, 'running')
    assert.equal(result.url, 'http://127.0.0.1:41731')
    assert.equal(result.pid, 4321)
    assert.equal(result.uptimeMs, 50000)
    assert.equal(result.version, '2.3.4')
    assert.equal(result.dataDir, dir)
    assert.equal(result.statusFile, path.join(dir, APP_STATUS_FILE))
  })

  it('运行中但无状态文件：返回 running，pid/version 用探测 target 兜底', async () => {
    const result = await getAppStatus({
      detect: async () => 'http://127.0.0.1:41731',
      getTarget: () => ({ dataDir: 'C:\\data', pid: 777, version: '1.0.0', startedAt: new Date(1700000000000).toISOString() }),
      now: () => 1700000010000,
      extraDirs: [],
      env: {},
      root: 'C:\\none',
    })
    assert.equal(result.running, true)
    assert.equal(result.pid, 777)
    assert.equal(result.version, '1.0.0')
    assert.equal(result.uptimeMs, 10000)
    assert.equal(Object.hasOwn(result, 'statusFile'), false)
  })

  it('未运行：从状态文件读取 lastExit（code/reason）并生成中文说明', async () => {
    const dir = await tempDir()
    await writeStatus(dir, {
      running: false,
      lastExit: { at: '2026-10-23T10:00:00.000Z', code: 1, reason: 'render-process-gone' },
    })
    const result = await getAppStatus({
      detect: async () => null,
      extraDirs: [dir],
      env: {},
      root: dir,
    })
    assert.equal(result.ok, true)
    assert.equal(result.running, false)
    assert.equal(result.status, 'stopped')
    assert.equal(result.lastExit.code, 1)
    assert.equal(result.lastExit.reason, 'render-process-gone')
    assert.match(result.lastExitText, /上次退出/)
    assert.match(result.lastExitText, /exit code 1/)
    assert.equal(result.statusFile, path.join(dir, APP_STATUS_FILE))
    assert.match(result.hint, /studio_launch_app/)
  })

  it('未运行：顶层 exitCode/reason/exitedAt 兼容', async () => {
    const dir = await tempDir()
    await writeStatus(dir, { exitCode: 3, reason: 'uncaughtException', exitedAt: 1700000000000 })
    const result = await getAppStatus({ detect: async () => null, extraDirs: [dir], env: {}, root: dir })
    assert.equal(result.running, false)
    assert.equal(result.status, 'stopped')
    assert.equal(result.lastExit.code, 3)
    assert.equal(result.lastExit.reason, 'uncaughtException')
    assert.match(result.lastExitText, /exit code 3/)
  })

  it('未运行且无状态文件：status=unknown + 无运行记录 + 提示 launch', async () => {
    const result = await getAppStatus({
      detect: async () => null,
      extraDirs: [],
      env: {},
      root: path.join(await tempDir(), 'empty-root'),
    })
    assert.equal(result.ok, true)
    assert.equal(result.running, false)
    assert.equal(result.status, 'unknown')
    assert.equal(result.lastExit, null)
    assert.match(result.note, /无运行记录/)
    assert.match(result.hint, /studio_launch_app/)
  })

  it('损坏状态文件：running:false + warning，不崩溃', async () => {
    const dir = await tempDir()
    await writeStatus(dir, '{broken json')
    const result = await getAppStatus({ detect: async () => null, extraDirs: [dir], env: {}, root: dir })
    assert.equal(result.ok, true)
    assert.equal(result.running, false)
    assert.match(result.warning, /状态文件损坏/)
    assert.match(result.warning, /不是合法 JSON/)
    assert.equal(result.statusFile, path.join(dir, APP_STATUS_FILE))
  })

  it('损坏文件后仍有合法候选：跳过损坏用合法文件', async () => {
    const badDir = await tempDir()
    await writeStatus(badDir, '{broken')
    const goodDir = await tempDir()
    await writeStatus(goodDir, { running: false, lastExit: { code: 0 } })
    const result = await getAppStatus({ detect: async () => null, extraDirs: [badDir, goodDir], env: {}, root: badDir })
    assert.equal(result.status, 'stopped')
    assert.equal(result.lastExit.code, 0)
    assert.equal(result.statusFile, path.join(goodDir, APP_STATUS_FILE))
  })

  it('detect 抛异常按未运行处理；AIMS_STATUS_FILE 显式指定文件', async () => {
    const dir = await tempDir()
    const explicit = await writeStatus(dir, { running: false, lastExit: { code: 1 } })
    const result = await getAppStatus({
      detect: async () => { throw new Error('network down') },
      env: { AIMS_STATUS_FILE: explicit },
      root: dir,
    })
    assert.equal(result.running, false)
    assert.equal(result.status, 'stopped')
    assert.equal(result.lastExit.code, 1)
    assert.equal(result.statusFile, explicit)
  })
})

describe('task-79 — createAppStatusTool', () => {
  it('缺少 defineTool 抛 TypeError；工具定义字段符合契约', () => {
    assert.throws(() => createAppStatusTool({}), /defineTool 必须是函数/)
    const tool = createAppStatusTool({ defineTool: (options) => options })
    assert.equal(tool.name, 'studio_app_status')
    assert.match(tool.description, /窗口状态|上次退出/)
    assert.match(tool.description, /studio_launch_app/)
    assert.deepEqual(tool.parameters, {})
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, true)
    assert.equal(typeof tool.output.render, 'function')
    assert.match(tool.output.render({}, { ok: true, running: true })[0].text, /running/)
  })

  it('execute 原样返回 getStatus 结果；异常转中文 ok:false', async () => {
    const tool = createAppStatusTool({
      defineTool: (options) => options,
      getStatus: async () => ({ ok: true, running: false, status: 'stopped', lastExit: { code: 1 } }),
    })
    const result = await tool.execute({})
    assert.equal(result.running, false)
    assert.equal(result.status, 'stopped')
    const throwing = createAppStatusTool({
      defineTool: (options) => options,
      getStatus: async () => { throw new Error('boom') },
    })
    const failed = await throwing.execute({})
    assert.equal(failed.ok, false)
    assert.match(failed.error, /读取窗口状态失败：boom/)
  })

  it('NO_APP_MESSAGE 同时提示 studio_app_status 与 studio_launch_app', () => {
    assert.match(NO_APP_MESSAGE, /studio_app_status/)
    assert.match(NO_APP_MESSAGE, /studio_launch_app/)
    assert.match(NO_APP_MESSAGE, /查看窗口状态|上次退出/)
  })
})
