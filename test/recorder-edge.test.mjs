/**
 * 录音模块边界测试（P3b-2 补充）：
 * - 常量/错误映射/采样拼接/波形 peaks/WAV 头与采样转换/无 Web API 行为
 * 只测纯函数与防御性分支，不依赖浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_SECONDS,
  MIN_RECORD_SECONDS,
  PEAK_COUNT,
  RECORDER_BUFFER_SIZE,
  InputRecorder,
  computePeaks,
  concatFloat32,
  encodeRecordedWav,
  mapMicrophoneError,
} from '../src/client/audio/recorder.js'

test('录音常量：缓冲/峰值点/最小时长/最长时长', () => {
  assert.equal(RECORDER_BUFFER_SIZE, 4096)
  assert.equal(PEAK_COUNT, 256)
  assert.equal(MIN_RECORD_SECONDS, 0.15)
  assert.equal(DEFAULT_MAX_SECONDS, 300)
})

test('mapMicrophoneError：权限类错误 → 中文权限提示', () => {
  for (const name of ['NotAllowedError', 'PermissionDeniedError', 'SecurityError']) {
    assert.match(mapMicrophoneError({ name }), /权限被拒绝/)
  }
})

test('mapMicrophoneError：设备类错误 → 中文无设备提示', () => {
  for (const name of ['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError']) {
    assert.equal(mapMicrophoneError({ name }), '没有找到麦克风设备')
  }
})

test('mapMicrophoneError：其它错误保留原文 / 空值有兜底', () => {
  assert.equal(mapMicrophoneError({ name: 'AbortError', message: '设备被占用' }), '设备被占用')
  assert.equal(mapMicrophoneError(null), '录音启动失败')
  assert.equal(mapMicrophoneError({}), '录音启动失败')
})

test('concatFloat32：空/含空块 → 长度 0', () => {
  assert.equal(concatFloat32([]).length, 0)
  assert.equal(concatFloat32(null).length, 0)
  assert.equal(concatFloat32([null, undefined, []]).length, 0)
})

test('concatFloat32：按顺序拼接 Float32 与普通数组', () => {
  const out = concatFloat32([new Float32Array([0.1, 0.2]), [0.3], new Float32Array([0.4, 0.5])])
  assert.equal(out.length, 5)
  assert.ok(out instanceof Float32Array)
  assert.ok(Math.abs(out[0] - 0.1) < 1e-6)
  assert.ok(Math.abs(out[4] - 0.5) < 1e-6)
})

test('computePeaks：空/静音 → 全 0 且长度正确', () => {
  const empty = computePeaks([], 8)
  assert.equal(empty.length, 8)
  assert.ok(empty.every((v) => v === 0))
  const silence = computePeaks(new Float32Array(64), 8)
  assert.ok(silence.every((v) => v === 0))
})

test('computePeaks：分桶取绝对值峰值并归一到 0..1', () => {
  const data = new Float32Array(16)
  data[0] = -0.9
  data[15] = 0.5
  const peaks = computePeaks(data, 4)
  assert.equal(peaks.length, 4)
  assert.ok(Math.abs(peaks[0] - 0.9) < 1e-6)
  assert.ok(Math.abs(peaks[3] - 0.5) < 1e-6)
  assert.ok(peaks.every((v) => v >= 0 && v <= 1))
})

test('computePeaks：NaN/Infinity 被忽略、n 非法时回退默认点数', () => {
  const data = new Float32Array([NaN, Infinity, -Infinity, 0.25])
  const peaks = computePeaks(data, 2)
  assert.ok(peaks.every((v) => Number.isFinite(v)))
  assert.ok(Math.abs(peaks[1] - 0.25) < 1e-6)
  assert.equal(computePeaks([], 0).length, PEAK_COUNT)
  assert.equal(computePeaks([], -5).length, 1)
})

test('encodeRecordedWav：合法 RIFF/WAVE 头（mono/16-bit/采样率）', () => {
  const samples = new Float32Array(4)
  const buf = encodeRecordedWav(samples, 48000)
  const bytes = new Uint8Array(buf)
  const text = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length))
  assert.equal(text(0, 4), 'RIFF')
  assert.equal(text(8, 4), 'WAVE')
  assert.equal(text(12, 4), 'fmt ')
  assert.equal(text(36, 4), 'data')
  const view = new DataView(buf)
  assert.equal(view.getUint16(22, true), 1) // mono
  assert.equal(view.getUint32(24, true), 48000)
  assert.equal(view.getUint16(34, true), 16) // bits
  assert.equal(view.getUint32(40, true), samples.length * 2) // data bytes
  assert.equal(buf.byteLength, 44 + samples.length * 2)
})

test('encodeRecordedWav：采样值转 16bit PCM（clamp 到 ±1）', () => {
  const buf = encodeRecordedWav(new Float32Array([0, 0.5, -0.5, 1.5, -1.5]), 44100)
  const view = new DataView(buf)
  assert.equal(view.getInt16(44, true), 0)
  assert.equal(view.getInt16(46, true), 16384)
  assert.equal(view.getInt16(48, true), -16384)
  assert.equal(view.getInt16(50, true), 32767)
  assert.equal(view.getInt16(52, true), -32768)
})

test('encodeRecordedWav：空录音也有可解析头；sampleRate 非法回退', () => {
  const buf = encodeRecordedWav([], 44100)
  assert.equal(buf.byteLength, 44)
  const view = new DataView(buf)
  assert.equal(view.getUint32(24, true), 44100)
  assert.equal(view.getUint32(40, true), 0)
  const fallback = encodeRecordedWav([0.1], 0)
  assert.equal(new DataView(fallback).getUint32(24, true), 44100)
})

test('InputRecorder：Node 无 Web API 时 start 拒绝并给中文原因', async () => {
  const recorder = new InputRecorder()
  assert.equal(recorder.isRecording, false)
  await assert.rejects(() => recorder.start(), /不支持录音/)
})

test('InputRecorder：构造参数与未录音 stop/cancel 安全', async () => {
  const recorder = new InputRecorder({ maxSeconds: 2 })
  assert.equal(recorder.elapsedSeconds, 0)
  assert.equal(await recorder.stop(), null)
  recorder.cancel()
  assert.equal(recorder.isRecording, false)
})
