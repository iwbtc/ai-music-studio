/**
 * 麦克风录音（CONTRACT-P3B2 §1）。
 *
 * 采集链：getUserMedia → AudioContext → MediaStreamSource →
 *        ScriptProcessorNode(4096,1,1) → Gain(0) → destination
 * 0 增益使麦克风信号不进入扬声器（不监听 / 无啸叫），同时保证 ScriptProcessor 被驱动。
 *
 * 本模块在 Node 下可安全 import（不触 Web API）；只有调用 start() 时才依赖：
 * - navigator.mediaDevices.getUserMedia
 * - AudioContext（或 webkitAudioContext）
 * 可用构造参数注入 mock（单测用）：audioContextCtor / getUserMediaImpl / now。
 */

import { encodeWavBytes } from './wav.js'

/** 录音太短判定阈值（秒）。 */
export const MIN_RECORD_SECONDS = 0.15
/** 默认最长录音（秒）；到点自动停止。 */
export const DEFAULT_MAX_SECONDS = 300
/** ScriptProcessor 缓冲帧数（约 85ms @48k，延迟与稳定性折中）。 */
export const RECORDER_BUFFER_SIZE = 4096
/** 峰值个数（契约：0..1 × 256）。 */
export const PEAK_COUNT = 256
/** 录音监听默认增益（CONTRACT-R2C §4：低增益防啸叫）。 */
export const DEFAULT_MONITOR_GAIN = 0.35

/** 录音监听增益规范化：非有限数回退 fallback，钳制 0..1。 */
export function normalizeMonitorGain(raw, fallback = DEFAULT_MONITOR_GAIN) {
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    const base = Number(fallback)
    return Number.isFinite(base) ? Math.min(1, Math.max(0, base)) : DEFAULT_MONITOR_GAIN
  }
  return Math.min(1, Math.max(0, value))
}

/** 录音设备 id 规范化：非空字符串保留，其余一律视为「系统默认输入」。 */
export function normalizeRecorderDeviceId(deviceId) {
  return typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : null
}

/**
 * 构造 getUserMedia 的 constraints（CONTRACT-P15 §1）。
 * - 指定 deviceId → `{audio:{deviceId:{exact:deviceId}}}`（无效设备时浏览器抛 OverconstrainedError）；
 * - 未指定 → `{audio:true}`（系统默认输入）。
 */
export function buildMicrophoneConstraints(deviceId) {
  const resolved = normalizeRecorderDeviceId(deviceId)
  return resolved ? { audio: { deviceId: { exact: resolved } } } : { audio: true }
}

/** 是否为「设备不可用 / 设备不存在」类错误（用于指定 deviceId 失败时的中文回退提示）。 */
function isDeviceUnavailableError(error) {
  const name = String(error?.name ?? '')
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'DevicesNotFoundError'
}

/**
 * 麦克风错误 → 中文提示。
 * @param {unknown} error DOMException / Error
 * @returns {string}
 */
export function mapMicrophoneError(error) {
  const name = String(error?.name ?? '')
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝，请在浏览器/系统设置里允许'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return '没有找到麦克风设备'
  }
  const message = error?.message
  if (typeof message === 'string' && message.trim()) return message
  return '录音启动失败'
}

/** 拼接多个 Float32 块为单声道采样。 */
export function concatFloat32(chunks) {
  const list = Array.isArray(chunks) ? chunks.filter(Boolean) : []
  let total = 0
  for (const chunk of list) total += Math.max(0, Number(chunk.length) || 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of list) {
    const view = chunk instanceof Float32Array ? chunk : Float32Array.from(chunk)
    out.set(view, offset)
    offset += view.length
  }
  return out
}

/**
 * 计算 peaks 波形摘要：把 samples 均分为 n 段，每段取 |样本| 最大值（0..1）。
 * 空/静音返回全 0。
 * @param {Float32Array|number[]} samples
 * @param {number} [n=256]
 * @returns {number[]}
 */
export function computePeaks(samples, n = PEAK_COUNT) {
  const count = Math.max(1, Math.round(Number(n) || PEAK_COUNT))
  const peaks = new Array(count).fill(0)
  const data = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? [])
  if (!data.length) return peaks
  const bucketSize = data.length / count
  for (let i = 0; i < data.length; i++) {
    const index = Math.min(count - 1, Math.floor(i / bucketSize))
    const value = Math.abs(data[i])
    if (Number.isFinite(value) && value > peaks[index]) peaks[index] = value
  }
  for (let i = 0; i < count; i++) peaks[i] = Math.min(1, peaks[i])
  return peaks
}

/**
 * 录音采样 → 16-bit PCM WAV（单声道，ArrayBuffer）。
 * @param {Float32Array|number[]} samples -1..1
 * @param {number} [sampleRate=44100]
 * @returns {ArrayBuffer}
 */
export function encodeRecordedWav(samples, sampleRate = 44100) {
  const data = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? [])
  const rate = Math.max(1, Math.round(Number(sampleRate) || 44100))
  const bytes = encodeWavBytes({
    numberOfChannels: 1,
    sampleRate: rate,
    length: data.length,
    getChannelData: () => data,
  })
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** 均方根（0..1，用于电平显示）。 */
function computeRms(samples) {
  if (!samples || !samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]
    sum += value * value
  }
  return Math.min(1, Math.sqrt(sum / samples.length))
}

/** 默认时钟（毫秒）。 */
function defaultNowMillis() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  return Date.now()
}

export class InputRecorder {
  /**
   * @param {{sampleRate?: number, maxSeconds?: number, deviceId?: string|null,
   *          audioContextCtor?: (new (options?: object) => AudioContext)|null,
   *          getUserMediaImpl?: ((constraints: object) => Promise<MediaStream>)|null,
   *          now?: () => number}} [options]
   *        audioContextCtor/getUserMediaImpl/now 仅用于单测注入；浏览器默认走 Web API。
   *        deviceId：构造时指定默认输入设备（也可每次 start({deviceId}) 覆盖）。
   */
  constructor(options = {}) {
    this._requestedSampleRate = Number(options.sampleRate) > 0 ? Number(options.sampleRate) : 0
    this.maxSeconds = Number(options.maxSeconds) > 0 ? Number(options.maxSeconds) : DEFAULT_MAX_SECONDS
    this._deviceId = normalizeRecorderDeviceId(options.deviceId)
    this._audioContextCtor =
      options.audioContextCtor !== undefined ? options.audioContextCtor : undefined
    this._getUserMediaImpl =
      options.getUserMediaImpl !== undefined ? options.getUserMediaImpl : undefined
    this._now = typeof options.now === 'function' ? options.now : defaultNowMillis

    this._recording = false
    this._stream = null
    this._ctx = null
    this._source = null
    this._processor = null
    this._mute = null
    this._monitorNode = null
    this._monitor = false
    this._monitorWanted = false
    this._monitorGainValue = DEFAULT_MONITOR_GAIN
    this._chunks = []
    this._sampleRate = 0
    this._onLevel = null
    this._startedAt = 0
    this._startClock = 0
    this._stopPromise = null
    this._autoResult = null
    this._autoStopping = false
  }

  get isRecording() {
    return this._recording
  }

  /** 是否正在监听（录音中且监听节点已连接）。 */
  get isMonitoring() {
    return Boolean(this._recording && this._monitor && this._monitorNode)
  }

  /** 当前监听增益（0..1；默认 0.35）。 */
  get monitorGain() {
    return this._monitorGainValue
  }

  /** 当前默认输入设备 id（null = 系统默认输入）。 */
  get deviceId() {
    return this._deviceId
  }

  /** 设置默认输入设备（下次 start 生效；null/空串 = 系统默认输入）。 */
  set deviceId(deviceId) {
    this._deviceId = normalizeRecorderDeviceId(deviceId)
  }

  /** 录音中已录时长（秒）；未录音时为 0。 */
  get elapsedSeconds() {
    if (!this._recording) return 0
    const elapsed = (this._now() - this._startClock) / 1000
    return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0
  }

  /** AudioContext 构造器（浏览器按前缀兜底）。 */
  _resolveAudioContextCtor() {
    if (this._audioContextCtor !== undefined) return this._audioContextCtor
    if (typeof AudioContext !== 'undefined') return AudioContext
    if (typeof webkitAudioContext !== 'undefined') return webkitAudioContext
    return null
  }

  /** getUserMedia（优先注入，其次 navigator.mediaDevices）。 */
  _resolveGetUserMedia() {
    if (this._getUserMediaImpl !== undefined) return this._getUserMediaImpl
    if (
      typeof navigator !== 'undefined' &&
      navigator?.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    ) {
      return navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    }
    return null
  }

  /** 音频处理回调：累积单声道 Float32、汇报电平、maxSeconds 自动停止。 */
  _handleAudioProcess(event) {
    if (!this._recording) return
    try {
      const input = event?.inputBuffer
      const channel =
        input && typeof input.getChannelData === 'function' ? input.getChannelData(0) : null
      if (channel && channel.length) {
        const copy = new Float32Array(channel.length)
        copy.set(channel)
        this._chunks.push(copy)
        if (this._onLevel) {
          try {
            this._onLevel(computeRms(copy))
          } catch {
            /* 电平回调异常不影响录音 */
          }
        }
      }
    } catch {
      /* 单个块异常忽略，继续录音 */
    }
    if (this._recording && this.maxSeconds > 0 && this.elapsedSeconds >= this.maxSeconds && !this._autoStopping) {
      this._autoStopping = true
      const promise = this.stop()
      promise.then((result) => {
        if (result) this._autoResult = result
      }).catch(() => {})
    }
  }

  /** 挂载监听路径：source → monitorGain → destination（同时保留采集链）。 */
  _attachMonitor(ctx, source, gainValue) {
    if (!ctx || !source || typeof ctx.createGain !== 'function') return false
    if (this._monitorNode) return true
    const node = ctx.createGain()
    node.gain.value = normalizeMonitorGain(gainValue, this._monitorGainValue)
    try {
      source.connect(node)
      node.connect(ctx.destination)
    } catch {
      try {
        node.disconnect?.()
      } catch {
        /* ignore */
      }
      return false
    }
    this._monitorNode = node
    this._monitor = true
    this._monitorGainValue = node.gain.value
    return true
  }

  /** 断开监听路径（不影响采集/已录数据）。 */
  _detachMonitor() {
    const node = this._monitorNode
    this._monitorNode = null
    this._monitor = false
    if (node) {
      try {
        node.disconnect?.()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * CONTRACT-R2C：录音中切换监听（不中断采集，不影响已录数据）。
   * 未录音时只记录偏好，下次 start() 生效。
   * @param {boolean} enabled
   * @param {number} [monitorGain] 0..1（省略保持当前增益）
   * @returns {boolean} 是否已应用到当前录音
   */
  setMonitor(enabled, monitorGain) {
    this._monitorWanted = enabled === true
    if (monitorGain !== undefined) {
      this._monitorGainValue = normalizeMonitorGain(monitorGain, this._monitorGainValue)
      if (this._monitorNode) {
        try {
          this._monitorNode.gain.value = this._monitorGainValue
        } catch {
          /* ignore */
        }
      }
    }
    if (!this._recording || !this._ctx || !this._source) return false
    if (this._monitorWanted) this._attachMonitor(this._ctx, this._source, this._monitorGainValue)
    else this._detachMonitor()
    return true
  }

  /**
   * 开始录音。
   * @param {{deviceId?: string|null, onLevel?: (level01: number) => void,
   *          monitor?: boolean, monitorGain?: number}} [options]
   *        deviceId 覆盖构造时的默认设备；省略则用实例当前 deviceId；null/空串 = 系统默认输入。
   *        monitor/monitorGain（CONTRACT-R2C）：录音监听，默认关闭/0.35。
   * @returns {Promise<{sampleRate:number, channels:number, startedAt:number, deviceId:string|null,
   *   monitor:boolean, monitorGain:number}>}
   */
  async start(options = {}) {
    if (this._recording) throw new Error('录音已在进行中')
    const Ctor = this._resolveAudioContextCtor()
    const getUserMedia = this._resolveGetUserMedia()
    if (!Ctor || typeof getUserMedia !== 'function') throw new Error('当前环境不支持录音')

    const resolvedDeviceId =
      options.deviceId !== undefined ? normalizeRecorderDeviceId(options.deviceId) : this._deviceId
    const onLevel = typeof options.onLevel === 'function' ? options.onLevel : null
    const constraints = buildMicrophoneConstraints(resolvedDeviceId)
    const wantMonitor = options.monitor !== undefined ? options.monitor === true : this._monitorWanted
    if (options.monitorGain !== undefined) {
      this._monitorGainValue = normalizeMonitorGain(options.monitorGain, this._monitorGainValue)
    }

    this._autoResult = null
    this._autoStopping = false
    this._chunks = []
    let stream = null
    let ctx = null
    try {
      stream = await getUserMedia(constraints)
      if (!stream) throw new Error('麦克风设备不可用')
      // 先挂到实例上，保证后续任何一步失败时 _cleanup 都能停止 tracks / 关闭 ctx
      this._stream = stream
      const ctxOptions = this._requestedSampleRate > 0 ? { sampleRate: this._requestedSampleRate } : undefined
      ctx = ctxOptions ? new Ctor(ctxOptions) : new Ctor()
      this._ctx = ctx
      if (typeof ctx.resume === 'function') {
        try {
          const resumed = ctx.resume()
          if (resumed && typeof resumed.then === 'function') await resumed
        } catch {
          /* 某些环境 resume 失败也能采集 */
        }
      }
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(RECORDER_BUFFER_SIZE, 1, 1)
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(processor)
      processor.connect(mute)
      mute.connect(ctx.destination)

      this._source = source
      this._processor = processor
      this._mute = mute
      // CONTRACT-R2C：监听路径（source→monitorGain→destination），默认关闭
      this._monitorNode = null
      this._monitor = false
      if (wantMonitor) this._attachMonitor(ctx, source, this._monitorGainValue)
      this._monitorWanted = Boolean(this._monitor)
      this._sampleRate = Math.max(1, Math.round(Number(ctx.sampleRate) || this._requestedSampleRate || 44100))
      this._onLevel = onLevel
      this._startedAt = Date.now()
      this._startClock = this._now()
      processor.onaudioprocess = (event) => this._handleAudioProcess(event)
      this._recording = true
      this._deviceId = resolvedDeviceId
      return {
        sampleRate: this._sampleRate,
        channels: 1,
        startedAt: this._startedAt,
        deviceId: resolvedDeviceId,
        monitor: Boolean(this._monitor),
        monitorGain: this._monitorGainValue,
      }
    } catch (error) {
      this._recording = false
      await this._cleanup()
      const message = mapMicrophoneError(error)
      // 指定了 deviceId 但设备不可用（拔掉/被占用/已被删除）→ 明确回退提示
      if (resolvedDeviceId && isDeviceUnavailableError(error)) {
        throw new Error(`所选麦克风设备不可用，请重新选择设备（${message}）`)
      }
      throw new Error(message)
    }
  }

  /**
   * 停止录音并返回 WAV 与元数据；未录音且无自动停止结果时返回 null。
   * 录音短于 MIN_RECORD_SECONDS 时抛「录音太短，已取消」（已完成清理）。
   * @returns {Promise<{wav:ArrayBuffer, durationSeconds:number, sampleRate:number,
   *   channels:number, peaks:number[]}|null>}
   */
  async stop() {
    if (this._stopPromise) return this._stopPromise
    if (!this._recording) {
      if (this._autoResult) {
        const result = this._autoResult
        this._autoResult = null
        return result
      }
      return null
    }
    this._stopPromise = this._stopRecording()
    try {
      return await this._stopPromise
    } finally {
      this._stopPromise = null
    }
  }

  async _stopRecording() {
    this._recording = false
    const sampleRate = this._sampleRate || this._requestedSampleRate || 44100
    await this._cleanup()
    const samples = concatFloat32(this._chunks)
    this._chunks = []
    this._sampleRate = sampleRate
    const durationSeconds = sampleRate > 0 ? samples.length / sampleRate : 0
    this._onLevel = null
    if (durationSeconds < MIN_RECORD_SECONDS) throw new Error('录音太短，已取消')
    return {
      wav: encodeRecordedWav(samples, sampleRate),
      durationSeconds,
      sampleRate,
      channels: 1,
      peaks: computePeaks(samples, PEAK_COUNT),
    }
  }

  /** 取消录音：立即释放麦克风/上下文，不产出结果。 */
  cancel() {
    if (!this._recording) {
      this._chunks = []
      this._autoResult = null
      return
    }
    this._recording = false
    this._onLevel = null
    this._chunks = []
    this._autoResult = null
    void this._cleanup()
  }

  /** 停止 tracks / 断开节点 / 关闭 AudioContext（幂等，不抛异常）。 */
  async _cleanup() {
    const stream = this._stream
    const ctx = this._ctx
    const source = this._source
    const processor = this._processor
    const mute = this._mute
    const monitorNode = this._monitorNode
    this._stream = null
    this._ctx = null
    this._source = null
    this._processor = null
    this._mute = null
    this._monitorNode = null
    this._monitor = false
    if (monitorNode) {
      try {
        monitorNode.disconnect?.()
      } catch {
        /* ignore */
      }
    }
    if (processor) {
      try {
        processor.onaudioprocess = null
      } catch {
        /* ignore */
      }
      try {
        processor.disconnect()
      } catch {
        /* ignore */
      }
    }
    try {
      source?.disconnect?.()
    } catch {
      /* ignore */
    }
    try {
      mute?.disconnect?.()
    } catch {
      /* ignore */
    }
    if (stream && typeof stream.getTracks === 'function') {
      let tracks = []
      try {
        tracks = stream.getTracks() || []
      } catch {
        tracks = []
      }
      for (const track of tracks) {
        try {
          track?.stop?.()
        } catch {
          /* ignore */
        }
      }
    }
    if (ctx && typeof ctx.close === 'function') {
      try {
        const closed = ctx.close()
        if (closed && typeof closed.then === 'function') await closed
      } catch {
        /* ignore */
      }
    }
  }
}
