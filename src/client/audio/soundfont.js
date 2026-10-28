/**
 * GeneralUser GS（SF2）真实采样音色库（CONTRACT-P8 §3）。
 *
 * - SoundfontBank：fetch `/soundfonts/GeneralUser.sf2` → vendor soundfont2 解析器解析；
 *   按 (bank, program) 懒构建 128 键映射（sample/root/loop/包络/衰减/pan/tune）。
 * - 采样数据 Int16Array → Float32（/32768）→ ctx.createBuffer；按 AudioContext（WeakMap）缓存，
 *   实时与离线各自建 buffer，避免跨 context 兼容问题。
 * - buildVoice：AudioBufferSourceNode + 音量包络（attack/decay/sustain/release）+ StereoPanner，
 *   接口与 samples.js 的 buildSampleVoice 一致（endTime/stop/release/dispose）。
 *
 * 模块加载时不做 Web Audio / 网络调用；Node 单测可用 fs 作为 fetchImpl 直接解析真实 SF2。
 */
import sf2pkg from './vendor/soundfont2.cjs'
import { DEFAULT_INSTRUMENT_PARAMS, INSTRUMENT_PARAM_SPECS } from '../../shared/model.js'

const { SoundFont2 } = sf2pkg

/** 默认音色库 URL（独立版服务器静态路由）。 */
export const DEFAULT_SOUNDFONT_URL = '/soundfonts/GeneralUser.sf2'

/** SF2 generator id（CONTRACT-P8 §3.1）。 */
export const SF2_GENERATORS = Object.freeze({
  pan: 17,
  attackVolEnv: 34,
  decayVolEnv: 36,
  sustainVolEnv: 37,
  releaseVolEnv: 38,
  initialAttenuation: 48,
  coarseTune: 51,
  fineTune: 52,
  sampleModes: 54,
  overridingRootKey: 58,
})

/** 默认包络（catalog 采样乐器只有 program/bank；缺省用钢琴型安全值）。 */
const DEFAULT_ENVELOPE = Object.freeze({
  attackSeconds: 0.002,
  decaySeconds: 2,
  sustainLevel: 0.75,
  releaseSeconds: 0.25,
})

/* ------------------------------------------------------------------------- */
/* R5b：track.instrumentParams（仅 synth；默认值省略 → 旧工程完全不变）          */
/* ------------------------------------------------------------------------- */

/** 默认乐器参数（与 shared model 一致）。 */
export const INSTRUMENT_PARAM_DEFAULTS = DEFAULT_INSTRUMENT_PARAMS

/** 按 spec 夹紧/取整（与 model.normalizeInstrumentParams 相同规则，防御性复算）。 */
function clampInstrumentParam(key, raw) {
  const spec = INSTRUMENT_PARAM_SPECS[key]
  if (!spec) return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  const factor = 10 ** spec.round
  return Math.round(Math.max(spec.min, Math.min(spec.max, value)) * factor) / factor
}

/**
 * R5b：读取轨道有效乐器参数（仅 kind='synth'），只返回非默认字段。
 * 默认/缺省/非法/非 synth → {}（引擎/图/voice 都不额外建节点，旧工程逐位不变）。
 * @param {{kind?:string, instrumentParams?:object, bypassFx?:boolean}} track
 * @returns {{attack?:number,release?:number,filterCutoff?:number,filterQ?:number,lfoRate?:number,lfoDepth?:number}}
 */
export function effectiveInstrumentParams(track) {
  if (!track || track.kind !== 'synth') return {}
  const raw = track.instrumentParams
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const output = {}
  for (const key of Object.keys(INSTRUMENT_PARAM_SPECS)) {
    if (raw[key] === undefined || raw[key] === null) continue
    const value = clampInstrumentParam(key, raw[key])
    if (value === null || value === INSTRUMENT_PARAM_DEFAULTS[key]) continue
    output[key] = value
  }
  return output
}

/**
 * R5b：buildVoice 的包络/LFO 覆盖参数（仅非默认字段）：
 * - attack/release 直接覆盖 SF2 包络；
 * - lfoDepth>0 → {lfo:{rateHz,depthCents}}，depth=0 不建节点。
 */
export function voiceInstrumentOptions(track) {
  const params = effectiveInstrumentParams(track)
  const options = {}
  if (params.attack !== undefined) options.attack = params.attack
  if (params.release !== undefined) options.release = params.release
  if (params.lfoDepth !== undefined && params.lfoDepth > 0) {
    options.lfo = {
      rateHz: params.lfoRate ?? INSTRUMENT_PARAM_DEFAULTS.lfoRate,
      depthCents: params.lfoDepth,
    }
  }
  return options
}

/**
 * R5b：轨道 instrument filter 设置（voice→instrumentFilter→track FX）：
 * 仅 synth、未 bypassFx、且 filterCutoff/filterQ 非默认时返回 {cutoff,q}；否则 null（不建节点）。
 */
export function instrumentFilterSettings(track) {
  if (!track || track.kind !== 'synth' || track.bypassFx === true) return null
  // R5d：subtractive 轨的 filter 在 synth voice 内（见 synth.js），不再叠 track instrumentFilter
  if (track.engine === 'subtractive') return null
  const params = effectiveInstrumentParams(track)
  const hasCutoff = params.filterCutoff !== undefined
  const hasQ = params.filterQ !== undefined
  if (!hasCutoff && !hasQ) return null
  return {
    cutoff: hasCutoff ? params.filterCutoff : INSTRUMENT_PARAM_DEFAULTS.filterCutoff,
    q: hasQ ? params.filterQ : INSTRUMENT_PARAM_DEFAULTS.filterQ,
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1, number))
}

function generatorValue(generators, id) {
  const generator = generators?.[id]
  if (!generator || typeof generator.value !== 'number' || !Number.isFinite(generator.value)) return null
  return generator.value
}

/** SF2 timecents → 秒（2^(tc/1200)）；缺失用 fallback。 */
export function timecentsToSeconds(timecents, fallback) {
  if (timecents === null || timecents === undefined || !Number.isFinite(Number(timecents))) return fallback
  return Math.pow(2, Number(timecents) / 1200)
}

/** SF2 centibels（衰减量）→ 线性增益 10^(-cb/200)。 */
export function centibelsToGain(centibels) {
  return Math.pow(10, -Number(centibels || 0) / 200)
}

/**
 * loop 点（帧）归一化：该 vendor 解析器已在 getSamples() 中把 startLoop/endLoop
 * 减去 header.start（即相对切片数据）；但若传入的是全局偏移则再减 header.start。
 */
function normalizeLoopFrames(rawValue, startOffset, dataLength) {
  const raw = Number(rawValue)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  if (raw <= dataLength) return raw
  const relative = raw - Number(startOffset || 0)
  if (relative > 0 && relative <= dataLength) return relative
  return 0
}

export class SoundfontBank {
  /**
   * @param {{url?: string, fetchImpl?: typeof fetch|null}} [options]
   *        fetchImpl 可注入（Node 单测用 fs 读取）；浏览器默认全局 fetch。
   */
  constructor(options = {}) {
    this.url = typeof options.url === 'string' && options.url ? options.url : DEFAULT_SOUNDFONT_URL
    const fetchImplProvided = Object.prototype.hasOwnProperty.call(options, 'fetchImpl')
    this._fetch = fetchImplProvided
      ? options.fetchImpl
      : typeof fetch === 'function'
        ? fetch.bind(globalThis)
        : null
    this._sf = null
    this._promise = null
    this._failedAt = 0
    this._keyMaps = new Map() // `${bank}:${program}` → Array(128)
    this._bufferCaches = new WeakMap() // ctx → Map(sample object → AudioBuffer)
  }

  get isLoaded() {
    return Boolean(this._sf)
  }

  /** 已解析 SoundFont2 实例（调试/测试用）。 */
  get soundfont() {
    return this._sf
  }

  get presetCount() {
    return this._sf?.presets?.length ?? 0
  }

  /** 解析失败后允许重试的冷却（毫秒）。 */
  get _retryCooldownMs() {
    return 5000
  }

  /**
   * 加载并解析 SF2（幂等；并发共享同一个 Promise）。
   * @returns {Promise<SoundFont2|null>}
   */
  async load() {
    if (this._sf) return this._sf
    if (this._promise) return this._promise
    if (!this._fetch) return null
    if (this._failedAt && Date.now() - this._failedAt < this._retryCooldownMs) return null
    const task = (async () => {
      try {
        const response = await this._fetch(this.url)
        if (!response || response.ok === false) throw new Error(`HTTP ${response?.status ?? 0}`)
        const buffer = await response.arrayBuffer()
        const sf = new SoundFont2(new Uint8Array(buffer))
        this._sf = sf
        this._failedAt = 0
        return sf
      } catch {
        this._failedAt = Date.now()
        return null
      } finally {
        this._promise = null
      }
    })()
    this._promise = task
    return task
  }

  /**
   * 程序名（如 program 0 → 'Stereo Grand'）。
   * @param {number} [bank=0]
   * @param {number} [program=0]
   * @returns {string|null}
   */
  findProgramName(bank = 0, program = 0) {
    const sf = this._sf
    if (!sf) return null
    const bankNumber = clampInt(bank, 0, 127, 0)
    const programNumber = clampInt(program, 0, 127, 0)
    const fromBanks = sf.banks?.[bankNumber]?.presets?.[programNumber]
    if (fromBanks?.header?.name) return fromBanks.header.name
    const preset = (sf.presets ?? []).find(
      (item) => item?.header?.bank === bankNumber && item?.header?.preset === programNumber,
    )
    return preset?.header?.name ?? null
  }

  /**
   * 某 (bank, program) 的 128 键映射（懒构建，失败缓存 null）。
   * @returns {Array<object|null>|null}
   */
  getKeyMap(bank = 0, program = 0) {
    const sf = this._sf
    if (!sf || typeof sf.getKeyData !== 'function') return null
    const bankNumber = clampInt(bank, 0, 127, 0)
    const programNumber = clampInt(program, 0, 127, 0)
    const cacheKey = `${bankNumber}:${programNumber}`
    if (this._keyMaps.has(cacheKey)) return this._keyMaps.get(cacheKey)
    const map = new Array(128).fill(null)
    for (let note = 0; note < 128; note++) {
      try {
        const keyData = sf.getKeyData(note, bankNumber, programNumber)
        map[note] = keyData ? this._parseKeyData(keyData) : null
      } catch {
        map[note] = null
      }
    }
    this._keyMaps.set(cacheKey, map)
    return map
  }

  /** 单键信息（测试/调试用）。 */
  getKeyInfo(bank, program, pitch) {
    const map = this.getKeyMap(bank, program)
    if (!map) return null
    return map[clampInt(pitch, 0, 127, 60)] ?? null
  }

  /** SoundFont2 getKeyData 结果 → 播放用键信息。 */
  _parseKeyData(keyData) {
    const sample = keyData?.sample
    const header = sample?.header
    if (!header) return null
    const generators = keyData?.generators ?? {}
    const data = sample?.data
    const frames = Math.max(1, Number(data?.length) || 0)
    const sampleRate = Number(header.sampleRate) || 44100
    const rootKey = generatorValue(generators, SF2_GENERATORS.overridingRootKey)
    const root = clampInt(
      rootKey ?? header.originalPitch ?? 60,
      0,
      127,
      60,
    )
    const sampleModes = generatorValue(generators, SF2_GENERATORS.sampleModes) ?? 0
    const loopStartFrames = normalizeLoopFrames(header.startLoop, header.start, frames)
    const loopEndFrames = normalizeLoopFrames(header.endLoop, header.start, frames)
    const loop = (sampleModes === 1 || sampleModes === 3) && loopEndFrames > loopStartFrames + 1
    const coarseTune = generatorValue(generators, SF2_GENERATORS.coarseTune) ?? 0
    const fineTune = generatorValue(generators, SF2_GENERATORS.fineTune) ?? 0
    const pitchCorrection = Number(header.pitchCorrection) || 0
    const attenuation = generatorValue(generators, SF2_GENERATORS.initialAttenuation) ?? 0
    const pan = generatorValue(generators, SF2_GENERATORS.pan) ?? 0
    const attackTimecents = generatorValue(generators, SF2_GENERATORS.attackVolEnv)
    const decayTimecents = generatorValue(generators, SF2_GENERATORS.decayVolEnv)
    const sustainCentibels = generatorValue(generators, SF2_GENERATORS.sustainVolEnv)
    const releaseTimecents = generatorValue(generators, SF2_GENERATORS.releaseVolEnv)
    return {
      sample,
      header,
      sampleName: String(header.name ?? ''),
      sampleRate,
      frames,
      root,
      loop,
      loopStartFrames,
      loopEndFrames,
      loopStartSeconds: loopStartFrames / sampleRate,
      loopEndSeconds: loopEndFrames / sampleRate,
      tuneCents: coarseTune * 100 + fineTune + pitchCorrection,
      attenuationGain: Math.max(0, Math.min(4, centibelsToGain(attenuation))),
      pan: Math.max(-1, Math.min(1, pan / 500)),
      attackSeconds: Math.max(
        0.001,
        Math.min(4, timecentsToSeconds(attackTimecents, DEFAULT_ENVELOPE.attackSeconds)),
      ),
      decaySeconds: Math.max(
        0.005,
        Math.min(10, timecentsToSeconds(decayTimecents, DEFAULT_ENVELOPE.decaySeconds)),
      ),
      sustainLevel: Math.max(
        0,
        Math.min(1, sustainCentibels === null ? DEFAULT_ENVELOPE.sustainLevel : centibelsToGain(sustainCentibels)),
      ),
      releaseSeconds: Math.max(
        0.02,
        Math.min(8, timecentsToSeconds(releaseTimecents, DEFAULT_ENVELOPE.releaseSeconds)),
      ),
    }
  }

  /** Int16 sample data → Float32 AudioBuffer（按 ctx 缓存）。 */
  _audioBufferFor(ctx, keyInfo) {
    const sample = keyInfo?.sample
    const data = sample?.data
    if (!data || typeof ctx?.createBuffer !== 'function') return null
    let cache = this._bufferCaches.get(ctx)
    if (!cache) {
      cache = new Map()
      this._bufferCaches.set(ctx, cache)
    }
    const cached = cache.get(sample)
    if (cached) return cached
    const frames = data.length
    if (frames <= 0) return null
    const floats = new Float32Array(frames)
    for (let i = 0; i < frames; i++) floats[i] = data[i] / 32768
    const buffer = ctx.createBuffer(1, frames, keyInfo.sampleRate)
    let copied = false
    if (typeof buffer?.copyToChannel === 'function') {
      try {
        buffer.copyToChannel(floats, 0)
        copied = true
      } catch {
        copied = false
      }
    }
    if (!copied) {
      const channel = buffer?.getChannelData?.(0)
      if (!channel) return null
      channel.set(floats)
    }
    cache.set(sample, buffer)
    return buffer
  }

  /**
   * 构建一个采样乐器 voice（接口对齐 buildSampleVoice）。
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} destination 轨道输入
   * @param {{program?:number, bank?:number, pitch?:number, vel?:number, startTime?:number, dur?:number}} options
   * @returns {{endTime:number, stop:(at?:number)=>void, release:()=>void, dispose:()=>void}|null}
   */
  buildVoice(ctx, destination, options = {}) {
    const sf = this._sf
    if (!sf || !ctx || !destination) return null
    try {
      // 未知 program/bank 直接返回 null（不做 clamp，避免把 200 当 127 播放）
      const programNumber = options.program === undefined || options.program === null ? 0 : Number(options.program)
      const bankNumber = options.bank === undefined || options.bank === null ? 0 : Number(options.bank)
      if (!Number.isInteger(programNumber) || programNumber < 0 || programNumber > 127) return null
      if (!Number.isInteger(bankNumber) || bankNumber < 0 || bankNumber > 127) return null
      const keyMap = this.getKeyMap(bankNumber, programNumber)
      if (!keyMap) return null
      const pitchNumber = options.pitch === undefined || options.pitch === null ? 60 : Math.round(Number(options.pitch))
      if (!Number.isFinite(pitchNumber) || pitchNumber < 0 || pitchNumber > 127) return null
      const keyInfo = keyMap[pitchNumber]
      if (!keyInfo) return null
      const buffer = this._audioBufferFor(ctx, keyInfo)
      if (!buffer) return null

      const t0 = Math.max(0, Number(options.startTime) || Number(ctx.currentTime) || 0)
      const vel = clamp01(options.vel === undefined || options.vel === null ? 0.8 : options.vel)
      const dur = Math.max(0.05, Number(options.dur) || 0.4)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      const playbackRate = Math.pow(2, (pitchNumber - keyInfo.root + keyInfo.tuneCents / 100) / 12)
      source.playbackRate.value = Math.max(0.03125, Math.min(8, playbackRate))
      // CONTRACT-P13：表情自动化在音符起始采样（pitch bend ±200 cents）
      const pitchBendCents = Math.max(
        -200,
        Math.min(200, Number(options.pitchBendCents) || 0),
      )
      if (Math.abs(pitchBendCents) > 1e-9) {
        source.detune.value = pitchBendCents
      }
      if (keyInfo.loop) {
        source.loop = true
        source.loopStart = keyInfo.loopStartSeconds
        source.loopEnd = keyInfo.loopEndSeconds
      }

      // 揉弦（CONTRACT-P11）：Oscillator(sine) → gain(depthCents) → source.detune
      // 无 vibrato / 非法值 → 不建任何节点。
      let vibratoOsc = null
      let vibratoGain = null
      const vibrato = options.vibrato
      if (vibrato && typeof vibrato === 'object') {
        const rateHz = Number(vibrato.rateHz)
        const depthCents = Number(vibrato.depthCents)
        if (Number.isFinite(rateHz) && rateHz > 0 && Number.isFinite(depthCents) && depthCents > 0) {
          try {
            vibratoOsc = ctx.createOscillator()
            vibratoOsc.type = 'sine'
            vibratoOsc.frequency.value = Math.max(0.1, Math.min(12, rateHz))
            vibratoGain = ctx.createGain()
            vibratoGain.gain.value = Math.max(0, Math.min(100, depthCents))
            vibratoOsc.connect(vibratoGain)
            vibratoGain.connect(source.detune)
          } catch {
            vibratoOsc = null
            vibratoGain = null
          }
        }
      }

      // R5b：乐器 LFO（lfoRate/lfoDepth）→ source.detune；depth<=0 不建节点。
      let lfoOsc = null
      let lfoGain = null
      const lfo = options.lfo
      if (lfo && typeof lfo === 'object') {
        const rateHz = Number(lfo.rateHz)
        const depthCents = Number(lfo.depthCents)
        if (Number.isFinite(rateHz) && rateHz > 0 && Number.isFinite(depthCents) && depthCents > 0) {
          try {
            lfoOsc = ctx.createOscillator()
            lfoOsc.type = 'sine'
            lfoOsc.frequency.value = Math.max(0.1, Math.min(12, rateHz))
            lfoGain = ctx.createGain()
            lfoGain.gain.value = Math.max(0, Math.min(100, depthCents))
            lfoOsc.connect(lfoGain)
            lfoGain.connect(source.detune)
          } catch {
            lfoOsc = null
            lfoGain = null
          }
        }
      }

      const gain = ctx.createGain()
      // CONTRACT-P13：expression 自动化 → 输出增益乘数（0..1，缺省 1）
      const expressionGain = Math.max(
        0,
        Math.min(1, options.expressionGain === undefined || options.expressionGain === null ? 1 : Number(options.expressionGain)),
      )
      // CONTRACT-R0-10：采样预设响度归一基线（线性倍数，由 catalog.presetGainScale 提供）
      const gainScale = Math.max(
        0.01,
        Math.min(
          64,
          options.gainScale === undefined || options.gainScale === null ? 1 : Number(options.gainScale),
        ),
      )
      const peak = Math.max(
        0.0001,
        Math.pow(vel, 1.5) *
          Math.max(0.0625, Math.min(4, keyInfo.attenuationGain)) *
          expressionGain *
          gainScale,
      )
      const attackOverride = Number(options.attack)
      const releaseOverride = Number(options.release)
      // R5b：attack/release 覆盖（非默认字段才传；缺省保持 SF2 keyInfo 原行为）
      const attack = Number.isFinite(attackOverride) ? Math.max(0.001, Math.min(2, attackOverride)) : keyInfo.attackSeconds
      const decay = keyInfo.decaySeconds
      const sustain = keyInfo.sustainLevel
      const release = Number.isFinite(releaseOverride) ? Math.max(0.01, Math.min(4, releaseOverride)) : keyInfo.releaseSeconds
      const noteEnd = t0 + dur
      const attackEnd = t0 + Math.min(attack, dur)
      const decayFullEnd = attackEnd + decay
      const sustainGain = Math.max(0.0002, peak * sustain)
      try {
        gain.gain.setValueAtTime(0.0001, t0)
        gain.gain.linearRampToValueAtTime(peak, Math.max(t0 + 0.001, attackEnd))
        if (noteEnd > attackEnd + 0.001) {
          if (noteEnd >= decayFullEnd - 0.001) {
            // 音符足够长：完整 decay 到 sustain 电平，保持到 noteEnd
            gain.gain.linearRampToValueAtTime(sustainGain, Math.max(attackEnd + 0.002, decayFullEnd))
            if (noteEnd > decayFullEnd + 0.001) gain.gain.setValueAtTime(sustainGain, noteEnd)
          } else {
            // 音符短于 decay：沿线性衰减曲线取 noteEnd 处电平，再从该电平 release
            const progress = Math.max(0, Math.min(1, (noteEnd - attackEnd) / decay))
            const atRelease = peak + (sustainGain - peak) * progress
            gain.gain.linearRampToValueAtTime(Math.max(0.0002, atRelease), noteEnd)
          }
        }
        gain.gain.linearRampToValueAtTime(0.0001, noteEnd + release)
      } catch {
        gain.gain.value = peak
      }

      let tail = gain
      let panner = null
      if (Math.abs(keyInfo.pan) > 0.01 && typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner()
        panner.pan.value = keyInfo.pan
        gain.connect(panner)
        tail = panner
      }
      source.connect(gain)
      tail.connect(destination)
      const stopAt = noteEnd + release + 0.02
      try {
        source.start(t0)
        source.stop(stopAt)
        if (vibratoOsc) {
          vibratoOsc.start(t0)
          vibratoOsc.stop(stopAt)
        }
        if (lfoOsc) {
          lfoOsc.start(t0)
          lfoOsc.stop(stopAt)
        }
      } catch {
        try {
          source.disconnect()
        } catch {
          /* ignore */
        }
        try {
          gain.disconnect()
        } catch {
          /* ignore */
        }
        try {
          panner?.disconnect()
        } catch {
          /* ignore */
        }
        try {
          vibratoOsc?.disconnect()
        } catch {
          /* ignore */
        }
        try {
          vibratoGain?.disconnect()
        } catch {
          /* ignore */
        }
        try {
          lfoOsc?.disconnect()
        } catch {
          /* ignore */
        }
        try {
          lfoGain?.disconnect()
        } catch {
          /* ignore */
        }
        return null
      }
      let disposed = false
      return {
        endTime: stopAt,
        stop(at) {
          const when = Number.isFinite(Number(at)) ? Math.max(t0, Number(at)) : t0
          try {
            source.stop(when)
          } catch {
            /* already stopped */
          }
          try {
            vibratoOsc?.stop(when)
          } catch {
            /* ignore */
          }
          try {
            lfoOsc?.stop(when)
          } catch {
            /* ignore */
          }
        },
        release() {
          // 包络已在 noteEnd 处排好 release；揉弦/LFO 在收尾时停止即可
          try {
            vibratoOsc?.stop()
          } catch {
            /* ignore */
          }
          try {
            lfoOsc?.stop()
          } catch {
            /* ignore */
          }
        },
        dispose() {
          if (disposed) return
          disposed = true
          try {
            source.stop()
          } catch {
            /* ignore */
          }
          try {
            vibratoOsc?.stop()
          } catch {
            /* ignore */
          }
          try {
            lfoOsc?.stop()
          } catch {
            /* ignore */
          }
          for (const node of [source, gain, panner, vibratoOsc, vibratoGain, lfoOsc, lfoGain]) {
            try {
              node?.disconnect()
            } catch {
              /* ignore */
            }
          }
        },
      }
    } catch {
      return null
    }
  }

  /** 清空解析结果/键映射/采样 buffer 缓存。 */
  dispose() {
    this._sf = null
    this._promise = null
    this._failedAt = 0
    this._keyMaps.clear()
    this._bufferCaches = new WeakMap()
  }
}

/**
 * 便捷函数：使用某个 SoundfontBank 实例构建 voice。
 * @returns {ReturnType<SoundfontBank['buildVoice']>}
 */
export function buildVoice(soundfontBank, ctx, destination, options) {
  if (!soundfontBank || typeof soundfontBank.buildVoice !== 'function') return null
  return soundfontBank.buildVoice(ctx, destination, options)
}
