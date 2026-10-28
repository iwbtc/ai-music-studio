/**
 * P14b 音频导出编码（audio-engine 拥有）：MP3 / FLAC。
 *
 * - MP3：lamejs 1.2.1（LGPL-3.0）的官方浏览器单文件入口 `lame.min.js`。
 *   注意：lamejs@1.2.1 的 npm 主入口（src/js/index.js）在 Node ESM / esbuild 等现代
 *   模块环境下会抛 `ReferenceError: MPEGMode/Lame is not defined`（其模块图依赖浏览器
 *   全局变量），因此本模块使用 `./vendor/lame.min.cjs`（逐字节复制自
 *   node_modules/lamejs/lame.min.js，仅在末尾追加 `module.exports = lamejs`）。
 *   升级 lamejs 时重新复制并追加同一行即可，编码逻辑不变。
 * - FLAC：libflacjs 5.6.0（MIT）的 asm.js 单文件构建（无 worker / 无 fs / 无 wasm 资源），
 *   编码 StreamInfo 由 `libflacjs/lib/utils/flac-utils` 的 `exportFlacData` 回填
 *   （min/max frame size、total samples、MD5），浏览器与 Node 行为一致。
 *
 * 所有函数返回纯 `Uint8Array`（不依赖 Blob/File），方便 UI 直接 POST 或下载。
 * 非法参数一律抛中文 Error。
 */

import lamejs from './vendor/lame.min.cjs'
import Flac from 'libflacjs/dist/libflac.js'

/** 支持的导出格式。 */
export const ENCODE_FORMATS = Object.freeze(['mp3', 'flac'])

/** MP3 默认码率（kbps）。 */
export const DEFAULT_MP3_BITRATE_KBPS = 192

/** MP3 标准码率档位（kbps）。 */
export const MP3_BITRATES = Object.freeze([32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320])

/** MP3 支持的采样率（Hz，MPEG-1/2/2.5 Layer III）。 */
export const MP3_SAMPLE_RATES = Object.freeze([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000])

const MIN_SAMPLE_RATE = 8000
const MAX_SAMPLE_RATE = 96000
const MAX_CHANNELS = 2
/** 每批编码帧数（FLAC）：限制峰值内存占用。 */
const FLAC_BLOCK_FRAMES = 16384

/** 扩展名 / MIME（供 UI 导出命名与 POST 使用）。 */
export function audioFormatExtension(format) {
  const name = String(format ?? '').toLowerCase()
  if (name === 'mp3') return 'mp3'
  if (name === 'flac') return 'flac'
  throw new Error(`不支持的音频导出格式 "${format}"（可选：mp3、flac）`)
}

export function audioFormatMime(format) {
  const name = String(format ?? '').toLowerCase()
  if (name === 'mp3') return 'audio/mpeg'
  if (name === 'flac') return 'audio/flac'
  throw new Error(`不支持的音频导出格式 "${format}"（可选：mp3、flac）`)
}

// ---------------------------------------------------------------------------
// 参数校验（中文错误）
// ---------------------------------------------------------------------------

function describeError(operation, message) {
  return new Error(`${operation}: ${message}`)
}

/** 校验并返回声道数；channels 为 Float32Array（或数值数组）的数组。 */
function validateChannels(operation, channels) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw describeError(operation, 'channels 必须是非空数组（[单声道] 或 [左, 右]）')
  }
  if (channels.length > MAX_CHANNELS) {
    throw describeError(operation, `仅支持 1（单声道）或 2（立体声）声道，收到 ${channels.length} 个`)
  }
  const normalized = []
  for (let index = 0; index < channels.length; index++) {
    const channel = channels[index]
    let view = null
    if (channel instanceof Float32Array) view = channel
    else if (channel instanceof Float64Array || Array.isArray(channel)) {
      if (!channel.length) throw describeError(operation, `声道 ${index + 1} 的音频数据为空`)
      view = Float32Array.from(channel)
    }
    if (!view) {
      throw describeError(operation, `声道 ${index + 1} 必须是 Float32Array 或数值数组`)
    }
    if (!view.length) throw describeError(operation, `声道 ${index + 1} 的音频数据为空`)
    normalized.push(view)
  }
  const frames = normalized[0].length
  if (frames === 0) throw describeError(operation, '音频数据为空')
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index].length !== frames) {
      throw describeError(
        operation,
        `所有声道长度必须一致（声道 1 有 ${frames} 帧，声道 ${index + 1} 有 ${normalized[index].length} 帧）`,
      )
    }
  }
  return { channels: normalized, channelCount: normalized.length, frames }
}

function validateSampleRate(operation, sampleRate) {
  const rate = Number(sampleRate)
  if (!Number.isFinite(rate) || !Number.isInteger(rate) || rate < MIN_SAMPLE_RATE || rate > MAX_SAMPLE_RATE) {
    throw describeError(
      operation,
      `采样率 ${sampleRate} 非法（必须是 ${MIN_SAMPLE_RATE}–${MAX_SAMPLE_RATE} Hz 之间的整数）`,
    )
  }
  return rate
}

function validateMp3SampleRate(operation, sampleRate) {
  const rate = validateSampleRate(operation, sampleRate)
  if (!MP3_SAMPLE_RATES.includes(rate)) {
    throw describeError(
      operation,
      `采样率 ${rate} 不受 MP3 支持（可选：${MP3_SAMPLE_RATES.join(' / ')} Hz）`,
    )
  }
  return rate
}

function validateBitrate(operation, bitrateKbps) {
  const bitrate = Number(bitrateKbps)
  if (!Number.isFinite(bitrate) || !MP3_BITRATES.includes(Math.round(bitrate))) {
    throw describeError(
      operation,
      `码率 ${bitrateKbps} 非法（支持 32–320 kbps 标准档位：${MP3_BITRATES.join(' / ')}）`,
    )
  }
  return Math.round(bitrate)
}

/** float 样本（-1..1）→ 16bit 有符号整数（越界钳制）。 */
function floatToInt16View(channel) {
  const out = new Int16Array(channel.length)
  for (let i = 0; i < channel.length; i++) {
    const value = Number(channel[i])
    const clamped = !Number.isFinite(value) ? 0 : value < -1 ? -1 : value > 1 ? 1 : value
    out[i] = Math.round(clamped * 32767)
  }
  return out
}

/** 合并编码分块（Int8Array/Uint8Array）为单个 Uint8Array（必须复制，避免共享 HEAP/内部缓冲）。 */
function mergeChunks(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk?.byteLength ?? chunk?.length ?? 0
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    if (!chunk) continue
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    merged.set(bytes, offset)
    offset += bytes.byteLength
  }
  return merged
}

/**
 * 回填 FLAC STREAMINFO（等价于 libflacjs `exportFlacData` 的 native FLAC 路径）。
 *
 * libflacjs 的 `lib/utils/flac-utils.js` 是 CJS UMD，内部 `require('./data-utils')` 在
 * esbuild/browser 环境下会触发 "Dynamic require is not supported"，故这里直接实现同一
 * 回填逻辑（算法取自 libflacjs 5.6.0 `lib/utils/flac-utils.js` 的 addFLACMetaData，MIT）。
 * 写入项：min/max frame size、total samples、MD5（sample rate/channels/bps 由编码器已写好）。
 */
function patchFlacStreamInfo(chunks, metadata) {
  if (!metadata || !Array.isArray(chunks) || chunks.length === 0) return
  let dataIndex = 0
  let offset = 4
  let data = chunks[0]
  if (!data || data.byteLength < 4) return
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'fLaC') return
  if (data.byteLength === 4) {
    // 第 1 个分块只有 "fLaC" 标识时，STREAMINFO 在第 2 个分块开头
    dataIndex = 1
    data = chunks[dataIndex]
    offset = 0
  }
  if (!data || data.byteLength < 34) return
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  // min_framesize（24bit，大端）
  view.setUint8(8 + offset, (metadata.min_framesize >> 16) & 0xff)
  view.setUint8(9 + offset, (metadata.min_framesize >> 8) & 0xff)
  view.setUint8(10 + offset, metadata.min_framesize & 0xff)
  // max_framesize（24bit，大端）
  view.setUint8(11 + offset, (metadata.max_framesize >> 16) & 0xff)
  view.setUint8(12 + offset, (metadata.max_framesize >> 8) & 0xff)
  view.setUint8(13 + offset, metadata.max_framesize & 0xff)
  // total_samples（36bit，大端）
  view.setUint8(18 + offset, (metadata.total_samples >> 24) & 0xff)
  view.setUint8(19 + offset, (metadata.total_samples >> 16) & 0xff)
  view.setUint8(20 + offset, (metadata.total_samples >> 8) & 0xff)
  view.setUint8(21 + offset, metadata.total_samples & 0xff)
  // MD5（16 字节）
  const md5 = typeof metadata.md5sum === 'string' ? metadata.md5sum : ''
  for (let i = 0; i < 16 && i * 2 + 1 < md5.length; i++) {
    view.setUint8(22 + offset + i, parseInt(md5.substring(i * 2, i * 2 + 2), 16) || 0)
  }
}

// ---------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------

/**
 * 把 PCM 声道数据编码为 MP3（CBR）。
 *
 * @param {Array<Float32Array|Float64Array|number[]>} channels [单声道] 或 [左, 右]，样本范围 -1..1
 * @param {number} sampleRate 采样率（Hz，MP3 标准档位）
 * @param {{bitrateKbps?:number}} [options] 码率，默认 192 kbps
 * @returns {Uint8Array} MP3 字节流（首帧同步字 0xFF 0xEx）
 */
export function encodeMp3(channels, sampleRate, options = {}) {
  const operation = 'encodeMp3'
  const { channels: validChannels, channelCount, frames } = validateChannels(operation, channels)
  const rate = validateMp3SampleRate(operation, sampleRate)
  const bitrateKbps = validateBitrate(
    operation,
    options && options.bitrateKbps !== undefined ? options.bitrateKbps : DEFAULT_MP3_BITRATE_KBPS,
  )

  const pcm = validChannels.map((channel) => floatToInt16View(channel))
  let encoder = null
  try {
    encoder = new lamejs.Mp3Encoder(channelCount, rate, bitrateKbps)
  } catch (error) {
    throw describeError(operation, `MP3 编码器初始化失败（${error?.message ?? error}）`)
  }

  const chunks = []
  const CHUNK_FRAMES = 1152
  try {
    for (let start = 0; start < frames; start += CHUNK_FRAMES) {
      const end = Math.min(frames, start + CHUNK_FRAMES)
      const left = pcm[0].subarray(start, end)
      const encoded =
        channelCount === 2
          ? encoder.encodeBuffer(left, pcm[1].subarray(start, end))
          : encoder.encodeBuffer(left)
      if (encoded && encoded.length) chunks.push(encoded)
    }
    const tail = encoder.flush()
    if (tail && tail.length) chunks.push(tail)
  } catch (error) {
    throw describeError(operation, `MP3 编码失败（${error?.message ?? error}）`)
  }

  const merged = mergeChunks(chunks)
  if (merged.byteLength === 0) throw describeError(operation, '编码结果为空')
  return merged
}

// ---------------------------------------------------------------------------
// FLAC
// ---------------------------------------------------------------------------

let flacReadyPromise = null

/** libflacjs asm.js 异步初始化完成（Node/浏览器一致）：已 ready → resolve，否则等待 ready 事件/轮询。 */
function ensureFlacReady() {
  if (Flac.isReady()) return Promise.resolve()
  if (flacReadyPromise) return flacReadyPromise
  flacReadyPromise = new Promise((resolve, reject) => {
    let settled = false
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (Flac.isReady()) finish()
      else if (Date.now() - startedAt > 15000) {
        finish()
        if (!Flac.isReady()) reject(new Error('FLAC 编码库初始化超时'))
      }
    }, 15)
    if (typeof timer?.unref === 'function') timer.unref()
    function finish() {
      if (settled) return
      settled = true
      clearInterval(timer)
      resolve()
    }
    try {
      Flac.onready = () => finish()
    } catch {
      /* 环境不支持 onready 时用轮询兜底 */
    }
  })
  return flacReadyPromise
}

/**
 * 把 PCM 声道数据编码为 FLAC（16bit，compression level 5，含 MD5/StreamInfo 回填）。
 * 同步编码 + Promise 包装（libflacjs asm.js 初始化为异步，其余为同步计算）。
 *
 * @param {Array<Float32Array|Float64Array|number[]>} channels [单声道] 或 [左, 右]，样本范围 -1..1
 * @param {number} sampleRate 采样率（Hz）
 * @returns {Promise<Uint8Array>} FLAC 字节流（magic "fLaC"）
 */
export async function encodeFlac(channels, sampleRate) {
  const operation = 'encodeFlac'
  const { channels: validChannels, channelCount, frames } = validateChannels(operation, channels)
  const rate = validateSampleRate(operation, sampleRate)

  await ensureFlacReady()
  if (!Flac.isReady()) throw describeError(operation, 'FLAC 编码库未就绪')

  let encoder = 0
  const chunks = []
  let metadata = null
  try {
    encoder = Flac.create_libflac_encoder(rate, channelCount, 16, 5, frames, true, 0)
    if (!encoder) throw describeError(operation, 'FLAC 编码器创建失败')
    const status = Flac.init_encoder_stream(
      encoder,
      // 写入回调：data 是 libflacjs 内部内存视图，必须立即复制
      (data) => {
        if (data && data.byteLength) chunks.push(new Uint8Array(data))
      },
      (info) => {
        metadata = info
      },
    )
    if (status !== 0) {
      throw describeError(operation, `FLAC 编码器初始化失败（status=${status}）`)
    }

    // 分块交织为 Int32 PCM（16bit 取值范围），避免长曲目一次性占用大量内存
    const interleaved = new Int32Array(Math.min(FLAC_BLOCK_FRAMES, frames) * channelCount)
    for (let start = 0; start < frames; start += FLAC_BLOCK_FRAMES) {
      const blockFrames = Math.min(FLAC_BLOCK_FRAMES, frames - start)
      const samples = blockFrames * channelCount
      const buffer = samples === interleaved.length ? interleaved : new Int32Array(samples)
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
        const source = validChannels[channelIndex]
        let target = channelIndex
        for (let i = 0; i < blockFrames; i++) {
          const value = Number(source[start + i])
          const clamped = !Number.isFinite(value) ? 0 : value < -1 ? -1 : value > 1 ? 1 : value
          buffer[target] = Math.round(clamped * 32767)
          target += channelCount
        }
      }
      const ok = Flac.FLAC__stream_encoder_process_interleaved(encoder, buffer, blockFrames)
      if (!ok) throw describeError(operation, 'FLAC 编码失败（process_interleaved 返回 false）')
    }
    const finished = Flac.FLAC__stream_encoder_finish(encoder)
    if (!finished) throw describeError(operation, 'FLAC 编码收尾失败（finish 返回 false）')
  } finally {
    if (encoder) {
      try {
        Flac.FLAC__stream_encoder_delete(encoder)
      } catch {
        /* 忽略清理失败 */
      }
    }
  }

  if (!chunks.length) throw describeError(operation, '编码结果为空')
  let merged = null
  try {
    // 回填 StreamInfo（min/max frame size、total samples、MD5）并合并分块
    patchFlacStreamInfo(chunks, metadata)
    merged = mergeChunks(chunks)
  } catch (error) {
    throw describeError(operation, `FLAC 数据合并失败（${error?.message ?? error}）`)
  }
  if (!merged || merged.byteLength === 0) throw describeError(operation, '编码结果为空')
  return merged
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/**
 * 按格式导出音频字节。
 *
 * @param {'mp3'|'flac'} format
 * @param {Array<Float32Array|Float64Array|number[]>} channels
 * @param {number} sampleRate
 * @param {{bitrateKbps?:number}} [options]
 * @returns {Uint8Array|Promise<Uint8Array>} mp3 同步返回；flac 返回 Promise
 */
export function encodeAudioFormat(format, channels, sampleRate, options = {}) {
  const name = String(format ?? '').toLowerCase()
  if (name === 'mp3') return encodeMp3(channels, sampleRate, options)
  if (name === 'flac') return encodeFlac(channels, sampleRate)
  throw new Error(`encodeAudioFormat: 不支持的导出格式 "${format}"（可选：mp3、flac）`)
}
