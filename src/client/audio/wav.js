/**
 * WAV 编码（16-bit PCM + 标准 RIFF 头）。
 * 纯计算：不依赖 AudioContext，只读取 AudioBuffer 的形状与采样数据，Node 可单测。
 */

const HEADER_BYTES = 44
const BITS_PER_SAMPLE = 16

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** float 样本 → int16（负数取 0x8000 保证 -1 映射为 -32768）。 */
function floatToInt16(sample) {
  const s = Number(sample)
  if (!Number.isFinite(s)) return 0
  const clamped = Math.min(1, Math.max(-1, s))
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
}

/**
 * 把 AudioBuffer（或同形状 mock）编码为 WAV 字节。
 * @param {{numberOfChannels:number,sampleRate:number,length:number,getChannelData:(c:number)=>Float32Array}} audioBuffer
 * @returns {Uint8Array}
 */
export function encodeWavBytes(audioBuffer) {
  if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
    throw new TypeError('encodeWavBytes: 需要 AudioBuffer（含 getChannelData）')
  }
  const channels = Math.max(1, Math.min(8, Math.round(Number(audioBuffer.numberOfChannels) || 1)))
  const sampleRate = Math.max(1, Math.round(Number(audioBuffer.sampleRate) || 44100))
  const frames = Math.max(0, Math.round(Number(audioBuffer.length) || 0))
  const blockAlign = channels * (BITS_PER_SAMPLE / 8)
  const dataBytes = frames * blockAlign
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  // RIFF header
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  // fmt chunk
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byteRate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, BITS_PER_SAMPLE, true)
  // data chunk
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  const chans = []
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c)
    chans.push(data && typeof data.length === 'number' ? data : new Float32Array(frames))
  }
  let offset = HEADER_BYTES
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      view.setInt16(offset, floatToInt16(chans[c][i]), true)
      offset += 2
    }
  }
  return new Uint8Array(buffer)
}

/**
 * AudioBuffer → WAV Blob（浏览器端下载 / POST 用）。
 * @param {Parameters<typeof encodeWavBytes>[0]} audioBuffer
 * @returns {Blob}
 */
export function encodeWav(audioBuffer) {
  const bytes = encodeWavBytes(audioBuffer)
  if (typeof Blob === 'undefined') return bytes
  return new Blob([bytes], { type: 'audio/wav' })
}

/** 读取 WAV 头信息（单测 / 调试用）。 */
export function parseWavHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset, length) => {
    let out = ''
    for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i))
    return out
  }
  return {
    riff: ascii(0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    byteLength: bytes.byteLength,
  }
}
