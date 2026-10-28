/**
 * P15 录音设备选择单测：InputRecorder deviceId 契约（CONTRACT-P15 §1）。
 *
 * 纯 Node + 注入 mock getUserMedia / AudioContext，不依赖浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  InputRecorder,
  buildMicrophoneConstraints,
  normalizeRecorderDeviceId,
  mapMicrophoneError,
  RECORDER_BUFFER_SIZE,
} from '../src/client/audio/recorder.js'

/** 录音测试环境：mock getUserMedia / AudioContext / MediaStream。 */
function makeEnv({ sampleRate = 44100, getUserMediaError = null } = {}) {
  const env = {
    calls: [],
    contexts: [],
    stoppedTracks: 0,
    getUserMediaError,
  }
  env.stream = {
    getTracks: () => [
      {
        stop() {
          env.stoppedTracks += 1
        },
      },
    ],
  }
  env.getUserMedia = async (constraints) => {
    env.calls.push(constraints)
    if (env.getUserMediaError) throw env.getUserMediaError
    return env.stream
  }
  class MockAudioContext {
    constructor(options = {}) {
      this.options = options
      this.sampleRate = sampleRate
      this.state = 'running'
      this.destination = { connect() {}, disconnect() {} }
      this.closed = false
      this.processor = null
      env.contexts.push(this)
    }
    resume() {
      return Promise.resolve()
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    }
    createScriptProcessor(size, inChannels, outChannels) {
      this.processor = { size, inChannels, outChannels, onaudioprocess: null, connect() {}, disconnect() {} }
      return this.processor
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} }
    }
    close() {
      this.closed = true
      return Promise.resolve()
    }
  }
  env.MockAudioContext = MockAudioContext
  return env
}

function makeRecorder(env, options = {}) {
  return new InputRecorder({
    audioContextCtor: env.MockAudioContext,
    getUserMediaImpl: env.getUserMedia,
    ...options,
  })
}

test('buildMicrophoneConstraints：无 deviceId → audio:true；有 deviceId → 精确约束', () => {
  assert.deepEqual(buildMicrophoneConstraints(null), { audio: true })
  assert.deepEqual(buildMicrophoneConstraints(undefined), { audio: true })
  assert.deepEqual(buildMicrophoneConstraints(''), { audio: true })
  assert.deepEqual(buildMicrophoneConstraints('   '), { audio: true })
  assert.deepEqual(buildMicrophoneConstraints(123), { audio: true })
  assert.deepEqual(buildMicrophoneConstraints({ exact: 'x' }), { audio: true })
  assert.deepEqual(buildMicrophoneConstraints('mic-abc'), {
    audio: { deviceId: { exact: 'mic-abc' } },
  })
  // 去首尾空白
  assert.deepEqual(buildMicrophoneConstraints('  mic-trim  '), {
    audio: { deviceId: { exact: 'mic-trim' } },
  })
  assert.equal(normalizeRecorderDeviceId(' mic '), 'mic')
  assert.equal(normalizeRecorderDeviceId(''), null)
  assert.equal(normalizeRecorderDeviceId(null), null)
  assert.equal(normalizeRecorderDeviceId(42), null)
})

test('InputRecorder：构造 deviceId → start() 使用精确约束并在返回值中带 deviceId', async () => {
  const env = makeEnv({ sampleRate: 48000 })
  const recorder = makeRecorder(env, { deviceId: 'mic-constructor' })
  assert.equal(recorder.deviceId, 'mic-constructor')
  const started = await recorder.start()
  assert.equal(started.deviceId, 'mic-constructor')
  assert.equal(started.sampleRate, 48000)
  assert.equal(started.channels, 1)
  assert.equal(env.calls.length, 1)
  assert.deepEqual(env.calls[0], { audio: { deviceId: { exact: 'mic-constructor' } } })
  assert.equal(env.contexts[0].processor.size, RECORDER_BUFFER_SIZE)
  recorder.cancel()
})

test('InputRecorder：start({deviceId}) 覆盖构造值；deviceId 属性 setter 下次录音生效', async () => {
  const env = makeEnv()
  const recorder = makeRecorder(env, { deviceId: 'from-constructor' })
  await recorder.start({ deviceId: 'from-start' })
  assert.deepEqual(env.calls[0], { audio: { deviceId: { exact: 'from-start' } } })
  assert.equal(recorder.deviceId, 'from-start') // 最近一次生效设备
  recorder.cancel()

  // setter 切换 → 下次录音生效
  recorder.deviceId = 'from-setter'
  await recorder.start()
  assert.deepEqual(env.calls[1], { audio: { deviceId: { exact: 'from-setter' } } })
  recorder.cancel()

  // 清空 → 回系统默认输入
  recorder.deviceId = null
  assert.equal(recorder.deviceId, null)
  await recorder.start()
  assert.deepEqual(env.calls[2], { audio: true })
  recorder.cancel()
})

test('InputRecorder：start({deviceId:null}) 显式回退系统默认输入', async () => {
  const env = makeEnv()
  const recorder = makeRecorder(env, { deviceId: 'mic-x' })
  const started = await recorder.start({ deviceId: null })
  assert.equal(started.deviceId, null)
  assert.deepEqual(env.calls[0], { audio: true })
  recorder.cancel()
})

test('InputRecorder：默认（无 deviceId）→ audio:true，切换设备后下次录音包含新 deviceId', async () => {
  const env = makeEnv()
  const recorder = makeRecorder(env)
  await recorder.start()
  assert.deepEqual(env.calls[0], { audio: true })
  recorder.cancel()

  recorder.deviceId = 'mic-next'
  await recorder.start()
  assert.deepEqual(env.calls[1], { audio: { deviceId: { exact: 'mic-next' } } })
  recorder.cancel()
})

test('InputRecorder：指定设备不可用（OverconstrainedError）→ 中文回退提示且不残留资源', async () => {
  const env = makeEnv({ getUserMediaError: { name: 'OverconstrainedError', constraint: 'deviceId' } })
  const recorder = makeRecorder(env, { deviceId: 'mic-unplugged' })
  await assert.rejects(
    () => recorder.start(),
    /所选麦克风设备不可用，请重新选择设备.*没有找到麦克风设备/,
  )
  assert.equal(recorder.isRecording, false)
  assert.equal(env.contexts.length, 0) // 未创建 AudioContext
  assert.equal(env.stoppedTracks, 0) // 流未建立
  // 失败后仍可再次尝试（换默认设备）
  env.getUserMediaError = null
  const started = await recorder.start({ deviceId: null })
  assert.equal(started.deviceId, null)
  assert.equal(recorder.isRecording, true)
  recorder.cancel()
})

test('InputRecorder：默认设备失败仍用原中文错误（无「所选设备」前缀）；普通错误传播原文', async () => {
  const notFoundEnv = makeEnv({ getUserMediaError: { name: 'NotFoundError' } })
  const notFound = makeRecorder(notFoundEnv)
  await assert.rejects(
    () => notFound.start(),
    (error) => {
      assert.equal(error.message, '没有找到麦克风设备')
      return true
    },
  )

  const busyEnv = makeEnv({ getUserMediaError: new Error('设备被其他应用占用') })
  const busy = makeRecorder(busyEnv, { deviceId: 'mic-busy' })
  await assert.rejects(
    () => busy.start(),
    (error) => {
      assert.equal(error.message, '设备被其他应用占用')
      return true
    },
  )

  // 权限错误原样映射（不受 deviceId 影响）
  const deniedEnv = makeEnv({ getUserMediaError: { name: 'NotAllowedError' } })
  const denied = makeRecorder(deniedEnv, { deviceId: 'mic-denied' })
  await assert.rejects(() => denied.start(), /麦克风权限被拒绝/)
})

test('InputRecorder：非法 deviceId 类型/空白 → 视为系统默认输入；Overconstrained 映射函数不变', async () => {
  const env = makeEnv()
  const recorder = makeRecorder(env, { deviceId: 12345 })
  assert.equal(recorder.deviceId, null)
  await recorder.start()
  assert.deepEqual(env.calls[0], { audio: true })
  recorder.cancel()

  recorder.deviceId = '   '
  assert.equal(recorder.deviceId, null)
  await recorder.start()
  assert.deepEqual(env.calls[1], { audio: true })
  recorder.cancel()

  // 既有错误映射保持不变（recorder-edge 断言）
  assert.equal(mapMicrophoneError({ name: 'OverconstrainedError' }), '没有找到麦克风设备')
  assert.equal(mapMicrophoneError({ name: 'NotFoundError' }), '没有找到麦克风设备')
  assert.equal(mapMicrophoneError({ name: 'NotAllowedError' }), '麦克风权限被拒绝，请在浏览器/系统设置里允许')
})
