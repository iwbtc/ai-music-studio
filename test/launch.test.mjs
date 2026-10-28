/**
 * P15：一键启动 studio_launch_app 单测。
 *
 * 全部注入 spawn/detect/now/wait/exists —— **不真实启动任何进程**。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  EXE_BASENAME,
  LAUNCH_POLL_INTERVAL_MS,
  LAUNCH_TIMEOUT_MS,
  candidateExecutables,
  cleanLaunchEnv,
  createLaunchTool,
  findExecutable,
  launchApp,
} from '../src/host/launch.js'
import { ROOT } from '../src/host/tool-bridge.js'

/** 可控时间：每次 now() 前进 step。 */
function fakeClock(step = 500, start = 1000) {
  let current = start - step
  return () => {
    current += step
    return current
  }
}

/** 记录调用参数的假 spawn。 */
function makeSpawn(options = {}) {
  const calls = []
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions })
    if (options.throwError) throw options.throwError
    const child = { unref: () => { child.unrefCalled = true }, unrefCalled: false }
    return child
  }
  spawn.calls = calls
  return spawn
}

/** 按序列返回的 detect。 */
function sequenceDetect(sequence) {
  let index = 0
  return () => {
    const value = sequence[Math.min(index, sequence.length - 1)]
    index += 1
    return value
  }
}

describe('P15 launch — 常量与 exe 定位', () => {
  it('常量：EXE 名 / 20s 超时 / 轮询间隔', () => {
    assert.equal(EXE_BASENAME, 'AI音乐工作室.exe')
    assert.equal(LAUNCH_TIMEOUT_MS, 20000)
    assert.ok(LAUNCH_POLL_INTERVAL_MS > 0 && LAUNCH_POLL_INTERVAL_MS <= 1000)
  })

  it('candidateExecutables：默认顺序 dist/win32-x64 → win-unpacked → dist', () => {
    const candidates = candidateExecutables({ env: {} })
    assert.equal(candidates.length, 3)
    assert.equal(candidates[0].source, 'dist/win32-x64')
    assert.equal(candidates[0].path, path.join(ROOT, 'dist', 'AI音乐工作室-win32-x64', EXE_BASENAME))
    assert.equal(candidates[1].source, 'dist/win-unpacked')
    assert.equal(candidates[2].source, 'dist')
    assert.ok(candidates[2].path.endsWith(EXE_BASENAME))
  })

  it('AIMS_EXE 环境变量优先且解析为绝对路径', () => {
    const candidates = candidateExecutables({ env: { AIMS_EXE: 'portable/AI音乐工作室.exe' }, root: 'C:\\repo' })
    assert.equal(candidates[0].source, 'AIMS_EXE')
    assert.equal(candidates[0].path, path.resolve('portable/AI音乐工作室.exe'))
    assert.equal(candidates[1].source, 'dist/win32-x64')
    // 空 AIMS_EXE 不产生候选
    assert.equal(candidateExecutables({ env: { AIMS_EXE: '   ' } })[0].source, 'dist/win32-x64')
  })

  it('findExecutable：返回第一个存在的候选；支持字符串候选列表', () => {
    const candidates = candidateExecutables({ env: {} })
    const found = findExecutable({
      candidates,
      exists: (filePath) => filePath === candidates[1].path,
    })
    assert.equal(found.path, candidates[1].path)
    assert.equal(found.source, 'dist/win-unpacked')
    // 字符串列表
    const stringFound = findExecutable({
      candidates: ['C:\\missing.exe', 'C:\\exists.exe'],
      exists: (filePath) => filePath === 'C:\\exists.exe',
    })
    assert.deepEqual(stringFound, { path: 'C:\\exists.exe', source: 'candidate' })
  })

  it('findExecutable：全部不存在返回 null', () => {
    assert.equal(findExecutable({ candidates: ['a.exe', 'b.exe'], exists: () => false }), null)
    assert.equal(findExecutable({ candidates: [], exists: () => true }), null)
  })

  it('cleanLaunchEnv：只删除 ELECTRON_RUN_AS_NODE，其余环境保留', () => {
    const env = { PATH: 'C:\\bin', ELECTRON_RUN_AS_NODE: '1', FOO: 'bar' }
    const clean = cleanLaunchEnv(env)
    assert.equal(Object.hasOwn(clean, 'ELECTRON_RUN_AS_NODE'), false)
    assert.equal(clean.PATH, 'C:\\bin')
    assert.equal(clean.FOO, 'bar')
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1', '不修改传入对象')
  })
})

describe('P15 launch — launchApp', () => {
  it('窗口已运行：直接返回 running，不 spawn', async () => {
    const spawn = makeSpawn()
    const result = await launchApp({
      spawn,
      detect: () => 'http://127.0.0.1:41731',
      getTarget: () => ({ url: 'http://127.0.0.1:41731', dataDir: 'C:\\data' }),
    })
    assert.deepEqual(result, {
      ok: true,
      running: true,
      launched: false,
      url: 'http://127.0.0.1:41731',
      dataDir: 'C:\\data',
    })
    assert.equal(spawn.calls.length, 0, '已运行不应 spawn')
  })

  it('启动成功：detached/stdio ignore/env 清理，轮询后返回 launched/url/exePath', async () => {
    const spawn = makeSpawn()
    const waits = []
    const result = await launchApp({
      spawn,
      detect: sequenceDetect([null, null, 'http://127.0.0.1:41731']),
      now: fakeClock(500),
      wait: async (ms) => { waits.push(ms) },
      exists: (filePath) => filePath.endsWith(EXE_BASENAME),
      env: { ELECTRON_RUN_AS_NODE: '1', PATH: 'x' },
      getTarget: () => ({ url: 'http://127.0.0.1:41731', dataDir: 'C:\\data' }),
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.running, true)
    assert.equal(result.launched, true)
    assert.equal(result.url, 'http://127.0.0.1:41731')
    assert.equal(result.dataDir, 'C:\\data')
    assert.ok(result.exePath.endsWith(EXE_BASENAME))
    assert.ok(result.waitedMs > 0)
    assert.equal(spawn.calls.length, 1)
    const call = spawn.calls[0]
    assert.equal(call.args.length, 0)
    assert.equal(call.options.detached, true)
    assert.equal(call.options.stdio, 'ignore')
    assert.equal(call.options.windowsHide, false)
    assert.equal(Object.hasOwn(call.options.env, 'ELECTRON_RUN_AS_NODE'), false)
    assert.equal(call.options.env.PATH, 'x')
    assert.ok(waits.length >= 1)
    assert.ok(waits.every((ms) => ms === LAUNCH_POLL_INTERVAL_MS))
  })

  it('显式 exePath 覆盖候选；不存在时中文错误且不 spawn', async () => {
    const spawn = makeSpawn()
    const result = await launchApp({
      spawn,
      detect: () => null,
      exists: (filePath) => filePath === 'C:\\custom\\app.exe',
      exePath: 'C:\\custom\\app.exe',
      now: fakeClock(500),
      wait: async () => {},
    })
    // 未提供可成功的 detect → 会超时；这里只验证 spawn 用的是显式路径
    assert.equal(result.ok, false)
    assert.ok(spawn.calls[0].command === 'C:\\custom\\app.exe')

    const spawn2 = makeSpawn()
    const missing = await launchApp({
      spawn: spawn2,
      detect: () => null,
      exists: () => false,
      exePath: 'C:\\nope\\app.exe',
    })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /指定的 AI 音乐工作室 exe 不存在/)
    assert.equal(spawn2.calls.length, 0)
  })

  it('找不到 exe：中文错误包含 AIMS_EXE 与 dist 提示，且不 spawn', async () => {
    const spawn = makeSpawn()
    const result = await launchApp({
      spawn,
      detect: () => null,
      exists: () => false,
      env: {},
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /未找到「AI 音乐工作室」exe/)
    assert.match(result.error, /AIMS_EXE/)
    assert.match(result.error, /dist\/AI音乐工作室-win32-x64/)
    assert.equal(spawn.calls.length, 0)
  })

  it('spawn 抛错：中文错误含启动失败与路径，不崩溃', async () => {
    const spawn = makeSpawn({ throwError: new Error('EACCES') })
    const result = await launchApp({
      spawn,
      detect: () => null,
      exists: (filePath) => filePath.endsWith(EXE_BASENAME),
      env: {},
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /启动 AI 音乐工作室失败/)
    assert.match(result.error, /EACCES/)
    assert.match(result.error, /手动双击/)
    assert.ok(result.exePath.endsWith(EXE_BASENAME))
  })

  it('超时：detect 始终 null → 20 秒中文超时错误，只 spawn 一次', async () => {
    const spawn = makeSpawn()
    const result = await launchApp({
      spawn,
      detect: () => null,
      now: fakeClock(2000),
      wait: async () => {},
      exists: (filePath) => filePath.endsWith(EXE_BASENAME),
      env: {},
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /20 秒内没有检测到窗口响应/)
    assert.match(result.error, /AIMS_EXE/)
    assert.equal(spawn.calls.length, 1)
    assert.equal(result.timeoutMs, 20000)
  })

  it('自定义 timeoutMs=1000：错误按秒数显示；轮询间隔可注入', async () => {
    const waits = []
    const spawn = makeSpawn()
    const result = await launchApp({
      spawn,
      detect: () => null,
      now: fakeClock(400),
      wait: async (ms) => { waits.push(ms) },
      exists: (filePath) => filePath.endsWith(EXE_BASENAME),
      env: {},
      timeoutMs: 1000,
      pollIntervalMs: 123,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /1 秒内没有检测到窗口响应/)
    assert.deepEqual(waits, [123, 123, 123].slice(0, waits.length))
    assert.ok(waits.length >= 1)
    assert.ok(waits.every((ms) => ms === 123))
  })

  it('detect 抛异常不会导致崩溃：按超时失败处理', async () => {
    const spawn = makeSpawn()
    const result = await launchApp({
      spawn,
      detect: () => { throw new Error('network down') },
      now: fakeClock(2000),
      wait: async () => {},
      exists: (filePath) => filePath.endsWith(EXE_BASENAME),
      env: {},
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /没有检测到窗口响应/)
  })
})

describe('P15 launch — createLaunchTool', () => {
  it('缺少 defineTool 抛 TypeError', () => {
    assert.throws(() => createLaunchTool({}), /defineTool 必须是函数/)
  })

  it('工具定义：name/描述/参数/output 符合契约', () => {
    const tool = createLaunchTool({ defineTool: (options) => options })
    assert.equal(tool.name, 'studio_launch_app')
    assert.match(tool.description, /窗口没开时先调用我/)
    assert.match(tool.description, /一键启动/)
    assert.match(tool.description, /20 秒/)
    assert.equal(tool.parameters.exe.type, 'string')
    assert.equal(tool.parameters.timeoutMs.type, 'integer')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, true)
    assert.equal(typeof tool.output.render, 'function')
    const rendered = tool.output.render({}, { ok: true, running: true })
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /running/)
  })

  it('execute 成功：透传 exe/timeoutMs 并原样返回 launch 结果', async () => {
    const calls = []
    const tool = createLaunchTool({
      defineTool: (options) => options,
      launch: async (options) => {
        calls.push(options)
        return { ok: true, running: true, launched: true, url: 'http://127.0.0.1:41731' }
      },
    })
    const result = await tool.execute({ exe: '  C:\\portable\\AI音乐工作室.exe  ', timeoutMs: 5000 })
    assert.equal(result.ok, true)
    assert.equal(result.url, 'http://127.0.0.1:41731')
    assert.deepEqual(calls, [{ exePath: 'C:\\portable\\AI音乐工作室.exe', timeoutMs: 5000 }])
  })

  it('execute 失败：launch 抛错 → ok:false 中文错误；缺省 launch 返回失败也透传', async () => {
    const throwing = createLaunchTool({
      defineTool: (options) => options,
      launch: async () => { throw new Error('boom') },
    })
    const result = await throwing.execute({})
    assert.equal(result.ok, false)
    assert.match(result.error, /启动 AI 音乐工作室失败：boom/)
    const failing = createLaunchTool({
      defineTool: (options) => options,
      launch: async () => ({ ok: false, error: '未找到 exe' }),
    })
    const failed = await failing.execute({})
    assert.deepEqual(failed, { ok: false, error: '未找到 exe' })
  })
})

describe('P15 launch — fetch 注入（不依赖 tool-bridge 发现逻辑）', () => {
  it('注入 fetch 探测已运行：命中 /studio/api/health 即返回 running，不 spawn', async () => {
    const spawn = makeSpawn()
    const requests = []
    const result = await launchApp({
      spawn,
      fetch: async (url) => {
        requests.push(url)
        return { ok: true }
      },
      baseUrl: 'http://127.0.0.1:5555/',
    })
    assert.equal(result.ok, true)
    assert.equal(result.running, true)
    assert.equal(result.launched, false)
    assert.equal(result.url, 'http://127.0.0.1:5555')
    assert.deepEqual(requests, ['http://127.0.0.1:5555/studio/api/health'])
    assert.equal(spawn.calls.length, 0)
  })

  it('注入 fetch 轮询：启动后 health 恢复 → launched:true；fetch 抛错按未响应处理', async () => {
    const spawn = makeSpawn()
    let attempts = 0
    const result = await launchApp({
      spawn,
      fetch: async () => {
        attempts += 1
        if (attempts <= 2) throw new Error('ECONNREFUSED')
        return { ok: true }
      },
      baseUrl: 'http://127.0.0.1:5555',
      now: fakeClock(500),
      wait: async () => {},
      exists: (filePath) => filePath.endsWith(EXE_BASENAME),
      env: {},
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.launched, true)
    assert.equal(result.url, 'http://127.0.0.1:5555')
    assert.equal(attempts, 3)
  })
})

