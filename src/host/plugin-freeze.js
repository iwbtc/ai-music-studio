/**
 * v2.2 M4：外部 VST3 离线冻结（语义 B：缓存只含外部插件链，不含轨道内置 FX）。
 *
 * - 缓存：<dataDir>/plugin-cache/<hash>.wav；同时复制 <dataDir>/media/freeze-<hash>.wav 并写
 *   project.media 条目（renderer 经 /studio/api/media/<file> 解码）。
 * - track.freeze = {hash,mediaId,cacheFile,cachePath,includesFx:false,...}；effect 冻结统一为整轨缓存。
 * - hash 覆盖：插件 pluginId/params/state、轨道音符/片段、速度/拍号、完整 track.effects 链、音量/自动化等混音字段。
 * - VST3 乐器轨：Host 侧 sidecar 渲染 instrument → VST3 effect 链。
 * - 普通轨 + VST3 effect：优先使用调用方（audio engine）提供的 inputPcm（干声，不含外部插件/内置 FX），
 *   否则 Host 用 SF2 采样器近似渲染（E2E/无引擎回退）。
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const PLUGIN_CACHE_DIR = 'plugin-cache'
export const MAX_FREEZE_SECONDS = 300
export const DEFAULT_FREEZE_SAMPLE_RATE = 48000
export const DEFAULT_FREEZE_BLOCK = 256
export const FREEZE_INCLUDES_FX = false
/** Host 采样器回退渲染的校准系数（近似 engine 实时播放增益；有 engine inputPcm 时不使用）。 */
const SAMPLER_FALLBACK_GAIN = 0.78

function safeJson(value) {
  if (Array.isArray(value)) return value.map(safeJson)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      out[key] = safeJson(value[key])
    }
    return out
  }
  return value
}

export function hashFreezePayload(payload) {
  return createHash('sha1').update(JSON.stringify(safeJson(payload))).digest('hex')
}

export function freezeCacheDir(dataDir) {
  return path.join(String(dataDir ?? ''), PLUGIN_CACHE_DIR)
}
export function freezeCachePath(dataDir, hash) {
  const safe = String(hash ?? '').toLowerCase()
  if (!/^[a-f0-9]{8,64}$/.test(safe)) throw new Error('冻结 hash 非法')
  return path.join(freezeCacheDir(dataDir), `${safe}.wav`)
}

function beatsPerBar(project) {
  return Number(project?.timeSignature?.[0]) > 0 ? Number(project.timeSignature[0]) : 4
}
function bpmOf(project) {
  return Number(project?.bpm) > 0 ? Number(project.bpm) : 120
}
function secondsPerBeat(project) {
  return 60 / bpmOf(project)
}
export function barsToFrames(project, bars, sampleRate = DEFAULT_FREEZE_SAMPLE_RATE) {
  const safeBars = Math.max(1, Math.min(256, Math.round(Number(bars) || 1)))
  const seconds = safeBars * beatsPerBar(project) * secondsPerBeat(project)
  return Math.max(1, Math.min(sampleRate * MAX_FREEZE_SECONDS, Math.round(seconds * sampleRate)))
}

/** 收集某轨在指定 bars 内的 MIDI 事件（instrument 冻结用）。 */
export function buildInstrumentEvents(project, track, { bars } = {}) {
  const targetBars = Math.max(1, Math.min(256, Math.round(Number(bars ?? project.lengthBars) || project.lengthBars || 1)))
  const barBeats = beatsPerBar(project)
  const spb = secondsPerBeat(project)
  const sampleRate = DEFAULT_FREEZE_SAMPLE_RATE
  const frames = barsToFrames(project, targetBars, sampleRate)
  const events = []
  const patterns = new Map((project.patterns ?? []).map((pattern) => [pattern.id, pattern]))
  const clips = (project.clips ?? []).filter((clip) => clip.trackId === track.id && typeof clip.patternId === 'string')
  for (const clip of clips) {
    const pattern = patterns.get(clip.patternId)
    if (!pattern) continue
    const clipBars = Math.max(1, Math.round(Number(clip.lengthBars) || 1))
    const patternBars = Math.max(1, Math.round(Number(pattern.lengthBars) || 1))
    const clipStartBar = Math.round(Number(clip.startBar) || 0)
    // 按 pattern 长度循环，而不是每个 bar 重放全部音符。
    for (let cycleStart = clipStartBar; cycleStart < clipStartBar + clipBars; cycleStart += patternBars) {
      if (cycleStart >= targetBars) break
      for (const note of pattern.notes ?? []) {
        const noteStartBeat = cycleStart * barBeats + Number(note.start ?? 0)
        const startFrame = Math.round(noteStartBeat * spb * sampleRate)
        const endFrame = Math.round((noteStartBeat + Math.max(0.01, Number(note.dur ?? 0.25))) * spb * sampleRate)
        const pitch = Math.max(0, Math.min(127, Math.round(Number(note.pitch ?? 60) + (Number(clip.transpose) || 0))))
        const velocity = Math.max(1, Math.min(127, Math.round((Number(note.vel ?? 0.8) || 0.8) * 127)))
        if (startFrame >= frames) continue
        events.push({ type: 'noteOn', pitch, velocity, frame: startFrame })
        events.push({ type: 'noteOff', pitch, velocity: 0, frame: Math.min(frames - 1, endFrame) })
      }
    }
  }
  events.sort((a, b) => a.frame - b.frame || (a.type === 'noteOff' ? -1 : 1))
  return { events: events.slice(0, 50000), frames, bars: targetBars, sampleRate }
}

/** 读取 16-bit PCM WAV（Host 内部干声→effect 链）。 */
export function readPcm16Wav(buffer) {
  if (!buffer || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('干声 WAV 格式非法')
  }
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') fmt = { format: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) }
    if (id === 'data') { data = buffer.subarray(body, Math.min(buffer.length, body + size)); break }
    offset = body + size + (size % 2)
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) throw new Error('干声 WAV 必须是 16-bit PCM')
  const frames = Math.floor(data.length / (fmt.channels * 2))
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames))
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < fmt.channels; channel += 1) {
      channels[channel][frame] = data.readInt16LE((frame * fmt.channels + channel) * 2) / 32767
    }
  }
  return { channels, frames, sampleRate: fmt.sampleRate }
}

/** 计算整轨冻结 hash；effectId 保留参数兼容但 hash 统一按整轨。 */
export function trackFreezeHash(project, trackId, effectId = null, override = {}) {
  const track = (project?.tracks ?? []).find((item) => item.id === trackId)
  if (!track) throw new Error(`轨道不存在：${String(trackId)}`)
  const clips = (project.clips ?? [])
    .filter((clip) => clip.trackId === trackId)
    .map((clip) => ({
      startBar: clip.startBar,
      lengthBars: clip.lengthBars,
      patternId: clip.patternId ?? null,
      mediaId: clip.mediaId ?? null,
      transpose: clip.transpose ?? 0,
      offsetSeconds: clip.offsetSeconds ?? 0,
      gainDb: clip.gainDb ?? 0,
      reverse: clip.reverse === true,
      stretchRatio: clip.stretchRatio ?? 1,
      semitones: clip.semitones ?? 0,
    }))
    .sort((a, b) => a.startBar - b.startBar || String(a.patternId).localeCompare(String(b.patternId)))
  const patterns = new Map((project.patterns ?? []).map((pattern) => [pattern.id, pattern]))
  const patternNotes = clips
    .filter((clip) => clip.patternId)
    .map((clip) => {
      const pattern = patterns.get(clip.patternId)
      return {
        patternId: clip.patternId,
        notes: (pattern?.notes ?? []).map((note) => ({ pitch: note.pitch, start: note.start, dur: note.dur, vel: note.vel })),
      }
    })
  const effects = (track.effects ?? []).map((fx) => ({
    id: fx.id,
    type: fx.type,
    enabled: fx.enabled !== false,
    params: fx.params ?? {},
    vst3: fx.type === 'vst3'
      ? {
          pluginId: fx.vst3?.pluginId ?? '',
          params: fx.vst3?.params ?? {},
          stateBase64: override.effectStates?.[fx.id] ?? fx.vst3?.stateBase64 ?? null,
          missing: fx.vst3?.missing === true,
        }
      : null,
  }))
  return hashFreezePayload({
    schema: 2,
    freezeMode: 'track-external-chain',
    includesFx: FREEZE_INCLUDES_FX,
    bars: Number.isFinite(Number(override.bars)) ? Math.round(Number(override.bars)) : null,
    bpm: project.bpm,
    timeSignature: project.timeSignature,
    tempoMap: project.tempoMap ?? [],
    track: {
      id: track.id,
      kind: track.kind,
      engine: track.engine ?? null,
      instrumentParams: track.instrumentParams ?? {},
      synthPreset: track.synthPreset ?? null,
      synthParams: track.synthParams ?? {},
      volume: track.volume ?? null,
      pan: track.pan ?? null,
      mute: track.mute === true,
      solo: track.solo === true,
      sends: track.sends ?? null,
      sendMode: track.sendMode ?? 'post',
      output: track.output ?? 'master',
      automation: track.automation ?? {},
      automationMode: track.automationMode ?? 'read',
      vst3: track.vst3
        ? {
            pluginId: track.vst3.pluginId ?? '',
            params: track.vst3.params ?? {},
            stateBase64: override.trackStateBase64 ?? track.vst3.stateBase64 ?? null,
            missing: track.vst3.missing === true,
          }
        : null,
      effects,
    },
    clips,
    patternNotes,
  })
}

function findEffect(track, effectId) {
  const effect = (track?.effects ?? []).find((fx) => fx.id === effectId && fx.type === 'vst3')
  if (!effect) throw new Error(`轨道 ${track?.id ?? '?'} 找不到 VST3 效果器：${String(effectId)}`)
  return effect
}

async function readWavChannels(filePath) {
  const buffer = await readFile(filePath)
  return readPcm16Wav(buffer).channels.map((channel) => Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength).toString('base64'))
}

function resolveSoundfontPath() {
  const candidates = [
    path.join(process.cwd(), 'assets', 'soundfonts', 'GeneralUser.sf2'),
    path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', '..', 'assets', 'soundfonts', 'GeneralUser.sf2'),
    process.resourcesPath ? path.join(process.resourcesPath, 'assets', 'soundfonts', 'GeneralUser.sf2') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'app-resources', 'assets', 'soundfonts', 'GeneralUser.sf2') : null,
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Host 侧采样器轨干声近似渲染（无引擎 inputPcm 回退；不含轨道内置 FX，包含预设/力度/音量/master）。 */
export async function renderSamplerTrackDryPcm(project, track, { bars, sampleRate = DEFAULT_FREEZE_SAMPLE_RATE } = {}) {
  if (track?.kind !== 'synth') throw new Error('普通轨冻结仅支持采样乐器轨（kind=synth）')
  const presetId = track.instrument?.preset
  if (typeof presetId !== 'string' || presetId === '') throw new Error('普通轨缺少采样乐器 preset，无法 Host 冻结')
  const { findSynthPreset } = await import('../shared/catalog.js')
  const preset = findSynthPreset(presetId)
  if (!preset?.soundfont || !Number.isFinite(Number(preset.soundfont.program))) throw new Error('普通轨采样乐器未配置 SF2 program，无法 Host 冻结')
  const sf2Path = resolveSoundfontPath()
  if (!sf2Path) throw new Error('找不到 GeneralUser.sf2，无法 Host 渲染普通轨干声')
  const { SoundfontBank } = await import('../client/audio/soundfont.js')
  const bank = new SoundfontBank({
    fetchImpl: async () => {
      const { readFile: readFs } = await import('node:fs/promises')
      const buffer = await readFs(sf2Path)
      return { ok: true, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }
    },
  })
  await bank.load()
  if (!bank.isLoaded) throw new Error('GeneralUser.sf2 解析失败，无法 Host 渲染普通轨干声')
  const program = Number(preset.soundfont.program)
  const bankNumber = Number(preset.soundfont.bank ?? 0)
  const targetBars = Math.max(1, Math.min(256, Math.round(Number(bars ?? project.lengthBars) || project.lengthBars || 1)))
  const frames = barsToFrames(project, targetBars, sampleRate)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const presetGain = Math.pow(10, Number(preset.gainDb ?? 0) / 20)
  // engine trackGainForValue 使用 pow(volume,1.35) 感知曲线；回退渲染对齐该曲线并做整体校准。
  const trackGain = Math.pow(Math.max(0, Math.min(1, Number(track.volume ?? 0.78))), 1.35)
  const gain = presetGain * trackGain * Number(project.master?.volume ?? 1) * SAMPLER_FALLBACK_GAIN
  const built = buildInstrumentEvents(project, track, { bars: targetBars })
  const active = new Map()
  const notes = []
  for (const event of built.events) {
    if (event.type === 'noteOn') {
      if (!active.has(event.pitch)) active.set(event.pitch, [])
      active.get(event.pitch).push(event)
    } else if (event.type === 'noteOff') {
      const stack = active.get(event.pitch)
      const startEvent = stack?.shift()
      if (startEvent) notes.push({ pitch: event.pitch, velocity: startEvent.velocity, startFrame: startEvent.frame, endFrame: event.frame })
    }
  }
  for (const note of notes) {
    const keyInfo = bank.getKeyInfo(bankNumber, program, note.pitch)
    if (!keyInfo?.sample?.data) continue
    const source = keyInfo.sample.data
    if (source.length <= 0) continue
    const ratio = Math.pow(2, (note.pitch - keyInfo.root + Number(keyInfo.tuneCents ?? 0) / 100) / 12) * (keyInfo.sampleRate / sampleRate)
    const loop = keyInfo.loop === true && keyInfo.loopEndFrames > keyInfo.loopStartFrames + 1
    const attack = Math.max(0.001, Number(keyInfo.attackSeconds ?? 0.01))
    const decay = Math.max(0.005, Number(keyInfo.decaySeconds ?? 0.1))
    const sustain = Math.max(0, Math.min(1, Number(keyInfo.sustainLevel ?? 0.8)))
    const release = Math.max(0.02, Number(keyInfo.releaseSeconds ?? 0.2))
    const startFrame = Math.max(0, Math.round((note.startFrame / DEFAULT_FREEZE_SAMPLE_RATE) * sampleRate))
    const endFrame = Math.max(startFrame + 1, Math.round((note.endFrame / DEFAULT_FREEZE_SAMPLE_RATE) * sampleRate))
    const noteFrames = Math.min(frames - startFrame, endFrame - startFrame + Math.round(release * sampleRate))
    if (noteFrames <= 0) continue
    const velocity = Math.pow(Math.max(0, Math.min(1, Number(note.velocity ?? 100) / 127)), 1.5)
    const attenuation = Number(keyInfo.attenuationGain ?? 1)
    const pan = Math.max(-1, Math.min(1, Number(keyInfo.pan ?? 0)))
    const leftGain = gain * attenuation * velocity * (pan <= 0 ? 1 : 1 - pan)
    const rightGain = gain * attenuation * velocity * (pan >= 0 ? 1 : 1 + pan)
    let position = 0
    for (let index = 0; index < noteFrames; index += 1) {
      const destination = startFrame + index
      if (destination >= frames) break
      let sampleIndex = Math.floor(position)
      if (loop) {
        const loopLength = keyInfo.loopEndFrames - keyInfo.loopStartFrames
        if (sampleIndex >= keyInfo.loopEndFrames) position = keyInfo.loopStartFrames + ((position - keyInfo.loopEndFrames) % loopLength)
        sampleIndex = Math.floor(position)
      }
      if (sampleIndex < 0 || sampleIndex >= source.length) break
      const raw = Number(source[sampleIndex] ?? 0) / 32768
      const seconds = index / sampleRate
      const noteOffSeconds = (endFrame - startFrame) / sampleRate
      let envelope
      if (seconds < attack) envelope = seconds / attack
      else if (seconds < attack + decay) envelope = 1 - (1 - sustain) * ((seconds - attack) / decay)
      else envelope = sustain
      if (seconds > noteOffSeconds) envelope *= Math.max(0, 1 - (seconds - noteOffSeconds) / release)
      if (envelope <= 0) {
        if (seconds >= noteOffSeconds + release) break
        position += ratio
        continue
      }
      left[destination] += raw * envelope * leftGain
      right[destination] += raw * envelope * rightGain
      position += ratio
      if (!loop && position >= source.length) break
    }
  }
  return { channels: [left, right], frames, bars: targetBars, sampleRate }
}

function decodeInputPcm(inputPcm, frames) {
  if (!Array.isArray(inputPcm) || inputPcm.length === 0) return null
  const channels = inputPcm.map((channel) => {
    if (typeof channel === 'string') {
      const buffer = Buffer.from(channel, 'base64')
      return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
    }
    if (channel && typeof channel.length === 'number') return channel instanceof Float32Array ? channel : Float32Array.from(channel)
    throw new Error('inputPcm 通道格式非法（应为 base64 Float32 planar 字符串数组）')
  })
  for (const channel of channels) {
    if (channel.length < frames) throw new Error(`inputPcm 长度不足：需要 ${frames} 帧，实际 ${channel.length}`)
  }
  return channels.map((channel) => Buffer.from(channel.buffer, channel.byteOffset, Math.min(channel.byteLength, frames * 4)).toString('base64'))
}

/** 冻结整轨外部插件链；普通轨可用 engine inputPcm（首选）或 Host SF2 采样器回退。 */
export async function freezeTarget({ dataDir, project, trackId, effectId = null, service, inputPcm = null, bars = null, sampleRate = DEFAULT_FREEZE_SAMPLE_RATE, maxBlockSize = DEFAULT_FREEZE_BLOCK } = {}) {
  if (!service || typeof service.renderOffline !== 'function') throw new Error('冻结需要插件服务（sidecar）')
  const track = (project?.tracks ?? []).find((item) => item.id === trackId)
  if (!track) throw new Error(`轨道不存在：${String(trackId)}`)
  const vst3Effects = (track.effects ?? []).filter((fx) => fx.type === 'vst3')
  if (effectId !== null && effectId !== undefined) findEffect(track, effectId)
  if (track.engine === 'vst3') {
    if (!track.vst3 || typeof track.vst3.pluginId !== 'string') throw new Error(`轨道 ${trackId} 缺少 VST3 插件引用`)
    if (track.vst3.missing === true) throw new Error(`插件文件缺失，无法冻结：${track.vst3.pluginId}`)
    const plugin = await service.getPlugin(track.vst3.pluginId)
    if (!plugin) throw new Error(`插件未安装，无法冻结：${track.vst3.pluginId}`)
    if (plugin.missing) throw new Error(`插件内容缺失：${track.vst3.pluginId}；请重新安装后再冻结`)
  } else if (vst3Effects.length === 0) {
    throw new Error(`轨道 ${trackId} 没有 VST3 乐器或效果器，无法冻结`)
  }
  for (const effect of vst3Effects) {
    if (effect.vst3?.missing === true) throw new Error(`插件文件缺失，无法冻结：${effect.vst3.pluginId}`)
    const effectPlugin = await service.getPlugin(effect.vst3?.pluginId ?? '')
    if (!effectPlugin) throw new Error(`插件未安装，无法冻结：${String(effect.vst3?.pluginId ?? '')}`)
    if (effectPlugin.missing) throw new Error(`插件内容缺失：${effect.vst3?.pluginId ?? ''}；请重新安装后再冻结`)
  }
  const targetBars = Math.max(1, Math.min(256, Math.round(Number(bars ?? project.lengthBars) || project.lengthBars || 1)))
  const frames = barsToFrames(project, targetBars, sampleRate)
  const cacheDir = freezeCacheDir(dataDir)
  await mkdir(cacheDir, { recursive: true })
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const effectStates = {}
  let trackStateBase64 = null
  let currentPath = null
  let currentChannels = null
  try {
    if (track.engine === 'vst3') {
      currentPath = path.join(cacheDir, `render-${stamp}-0.wav`)
      const built = buildInstrumentEvents(project, track, { bars: targetBars })
      const scaledEvents = sampleRate === DEFAULT_FREEZE_SAMPLE_RATE
        ? built.events
        : built.events.map((event) => ({ ...event, frame: Math.min(frames - 1, Math.round(event.frame * (sampleRate / DEFAULT_FREEZE_SAMPLE_RATE))) }))
      const instrument = await service.renderOffline({
        pluginId: track.vst3.pluginId,
        kind: 'instrument',
        outputPath: currentPath,
        frames,
        sampleRate,
        maxBlockSize,
        events: scaledEvents,
        params: track.vst3.params ?? {},
        stateBase64: track.vst3.stateBase64 ?? null,
        saveState: true,
      })
      trackStateBase64 = instrument.stateBase64 ?? null
      currentChannels = await readWavChannels(currentPath)
    } else {
      const provided = decodeInputPcm(inputPcm, frames)
      if (provided) {
        currentChannels = provided
      } else {
        const dry = await renderSamplerTrackDryPcm(project, track, { bars: targetBars, sampleRate })
        currentChannels = dry.channels.map((channel) => Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength).toString('base64'))
      }
    }
    let stage = 1
    for (const effect of vst3Effects) {
      const nextPath = path.join(cacheDir, `render-${stamp}-${stage}.wav`)
      const rendered = await service.renderOffline({
        pluginId: effect.vst3?.pluginId,
        kind: 'effect',
        outputPath: nextPath,
        frames,
        sampleRate,
        maxBlockSize,
        inputPcm: currentChannels,
        params: effect.vst3?.params ?? {},
        stateBase64: effect.vst3?.stateBase64 ?? null,
        saveState: true,
      })
      effectStates[effect.id] = rendered.stateBase64 ?? null
      if (currentPath) await rm(currentPath, { force: true }).catch(() => {})
      currentPath = nextPath
      currentChannels = await readWavChannels(nextPath)
      stage += 1
    }
    if (!currentPath) throw new Error('冻结未产生音频')
    const hash = trackFreezeHash(project, trackId, null, { trackStateBase64, effectStates, bars: targetBars })
    const finalCacheFile = `${hash}.wav`
    const finalCachePath = path.join(cacheDir, finalCacheFile)
    if (path.resolve(currentPath) !== path.resolve(finalCachePath)) {
      await copyFile(currentPath, finalCachePath)
      await rm(currentPath, { force: true }).catch(() => {})
    }
    const mediaDir = path.join(String(dataDir), 'media')
    await mkdir(mediaDir, { recursive: true })
    const mediaFile = `freeze-${hash}.wav`
    const mediaPath = path.join(mediaDir, mediaFile)
    await copyFile(finalCachePath, mediaPath)
    const info = await stat(mediaPath)
    const mediaId = `med_freeze_${hash.slice(0, 12)}`
    const name = track.vst3?.name || vst3Effects[vst3Effects.length - 1]?.vst3?.name || track.name || track.id
    const mediaEntry = {
      id: mediaId,
      name: `冻结 · ${name}`,
      file: mediaFile,
      bytes: info.size,
      durationSeconds: Number((frames / sampleRate).toFixed(3)),
      channels: 2,
      sampleRate,
    }
    const lastState = Object.values(effectStates).filter(Boolean).pop() ?? trackStateBase64
    const finalDecoded = readPcm16Wav(await readFile(finalCachePath))
    let cachePeak = 0
    let cacheSum = 0
    let cacheCount = 0
    for (const channel of finalDecoded.channels) {
      for (const sample of channel) {
        cachePeak = Math.max(cachePeak, Math.abs(sample))
        cacheSum += sample * sample
        cacheCount += 1
      }
    }
    const cacheRms = Math.sqrt(cacheCount > 0 ? cacheSum / cacheCount : 0)
    const freeze = {
      status: 'current',
      hash,
      mediaId,
      cacheFile: finalCacheFile,
      cachePath: finalCachePath,
      includesFx: FREEZE_INCLUDES_FX,
      bars: targetBars,
      frames,
      sampleRate,
      latencySamples: 0,
      createdAt: Date.now(),
      stale: false,
    }
    return {
      freeze,
      mediaEntry,
      stateBase64: lastState,
      trackStateBase64,
      effectStates,
      result: { path: finalCachePath, frames, sampleRate, channels: 2, rms: Number(cacheRms.toFixed(6)), peak: Number(cachePeak.toFixed(6)) },
      effectIds: vst3Effects.map((fx) => fx.id),
    }
  } catch (error) {
    if (currentPath) await rm(currentPath, { force: true }).catch(() => {})
    const message = String(error?.message ?? error)
    if (/不存在|missing|找不到|ENOENT/i.test(message) && /插件|plugin/i.test(message)) {
      throw new Error(`插件内容缺失，无法冻结：${String(track.vst3?.pluginId ?? vst3Effects[0]?.vst3?.pluginId ?? '')}（${message}）`)
    }
    throw error
  }
}

export function setFreezeOnProject(project, { trackId, effectId = null, freeze, mediaEntry = null, stateBase64 = null, trackStateBase64 = null, effectStates = null }) {
  const track = (project?.tracks ?? []).find((item) => item.id === trackId)
  if (!track) throw new Error(`轨道不存在：${String(trackId)}`)
  track.freeze = freeze
  if (trackStateBase64 && track.vst3) track.vst3.stateBase64 = trackStateBase64
  else if (stateBase64 && track.vst3) track.vst3.stateBase64 = stateBase64
  if (effectStates && typeof effectStates === 'object') {
    for (const [id, state] of Object.entries(effectStates)) {
      const effect = (track.effects ?? []).find((fx) => fx.id === id)
      if (effect?.vst3 && state) effect.vst3.stateBase64 = state
    }
  }
  if (mediaEntry) {
    if (!Array.isArray(project.media)) project.media = []
    const existing = project.media.find((item) => item.id === mediaEntry.id)
    if (existing) Object.assign(existing, mediaEntry)
    else project.media.push(mediaEntry)
  }
  return freeze
}

export async function removeFreezeFromProject(project, { trackId, effectId = null, dataDir = null } = {}) {
  const track = (project?.tracks ?? []).find((item) => item.id === trackId)
  if (!track) return { removed: false }
  const freeze = track.freeze
  if (!freeze) return { removed: false }
  delete track.freeze
  if (Array.isArray(project.media) && freeze.mediaId) project.media = project.media.filter((item) => item.id !== freeze.mediaId)
  if (dataDir) {
    if (freeze.cacheFile) await rm(path.join(freezeCacheDir(dataDir), path.basename(freeze.cacheFile)), { force: true }).catch(() => {})
    if (freeze.hash) await rm(path.join(String(dataDir), 'media', `freeze-${freeze.hash}.wav`), { force: true }).catch(() => {})
  }
  return { removed: true, freeze }
}

/** 冻结状态：VST3 乐器轨与含 VST3 effect 的普通轨都返回整轨状态。 */
export function getFreezeStatus(project, { trackId = null, effectId = null, dataDir = null, bars = null } = {}) {
  const items = []
  for (const track of project?.tracks ?? []) {
    const effectChain = (track.effects ?? []).filter((fx) => fx.type === 'vst3')
    const isInstrumentTrack = track.engine === 'vst3'
    if (!isInstrumentTrack && effectChain.length === 0) continue
    if (trackId !== null && track.id !== trackId) continue
    const freeze = track.freeze
    const requestedBars = bars !== null && bars !== undefined
      ? Math.max(1, Math.min(256, Math.round(Number(bars) || 1)))
      : (freeze?.bars ?? Math.max(1, Math.min(256, Math.round(Number(project.lengthBars) || 1))))
    let currentHash = null
    try { currentHash = trackFreezeHash(project, track.id, null, { bars: requestedBars }) } catch { currentHash = null }
    const missingPlugin = track.vst3?.missing === true || effectChain.some((fx) => fx.vst3?.missing === true)
    let status = 'unfrozen'
    if (missingPlugin) status = 'missing'
    else if (!freeze) status = 'unfrozen'
    else if (freeze.status === 'error') status = 'error'
    else if (!freeze.cacheFile) status = 'error'
    else {
      const cacheFile = dataDir ? path.join(freezeCacheDir(dataDir), path.basename(freeze.cacheFile)) : null
      status = freeze.stale === true
        || freeze.status === 'stale'
        || (bars !== null && bars !== undefined && Number(freeze.bars) !== requestedBars)
        || currentHash !== freeze.hash
        ? 'stale'
        : 'current'
      if (status === 'current' && cacheFile && !existsSync(cacheFile)) status = 'error'
    }
    items.push({
      trackId: track.id,
      trackName: track.name ?? track.id,
      effectId: effectId ?? (effectChain[0]?.id ?? null),
      pluginId: track.vst3?.pluginId ?? effectChain[0]?.vst3?.pluginId ?? '',
      kind: isInstrumentTrack ? 'instrument' : 'effect',
      frozen: status === 'current' || status === 'stale',
      status,
      hash: freeze?.hash ?? null,
      currentHash,
      mediaId: freeze?.mediaId ?? null,
      cacheFile: freeze?.cacheFile ?? null,
      includesFx: freeze?.includesFx === true,
      stale: status === 'stale',
      missing: missingPlugin,
      effectIds: effectChain.map((fx) => fx.id),
    })
  }
  return {
    ok: true,
    items,
    tracks: items,
    counts: {
      total: items.length,
      current: items.filter((item) => item.status === 'current').length,
      stale: items.filter((item) => item.status === 'stale').length,
      unfrozen: items.filter((item) => item.status === 'unfrozen').length,
      missing: items.filter((item) => item.status === 'missing').length,
    },
  }
}

/** 标记过期冻结（编辑后/打开工程）。返回标记数量。 */
export function invalidateStaleFreezes(project) {
  let changed = 0
  for (const track of project?.tracks ?? []) {
    if (!track.freeze) continue
    const currentHash = trackFreezeHash(project, track.id, null, { bars: track.freeze.bars })
    if (currentHash !== track.freeze.hash && track.freeze.stale !== true) {
      track.freeze.stale = true
      track.freeze.status = 'stale'
      changed += 1
    }
  }
  return changed
}

/** 导出前自动冻结所有 VST3 轨（含普通轨 + VST3 effect；普通轨优先 engine 提供的 inputPcm）。 */
export async function autoFreezeForExport({ dataDir, project, service, bars = null, inputPcmByTrack = null } = {}) {
  const applied = []
  const warnings = []
  for (const track of project?.tracks ?? []) {
    const hasVst3Effect = (track.effects ?? []).some((fx) => fx.type === 'vst3')
    if (track.engine !== 'vst3' && !hasVst3Effect) continue
    const targetBars = Math.max(1, Math.min(256, Math.round(Number(bars ?? project.lengthBars) || project.lengthBars || 1)))
    let currentHash = null
    try { currentHash = trackFreezeHash(project, track.id, null, { bars: targetBars }) } catch { currentHash = null }
    if (track.freeze && Number(track.freeze.bars) === targetBars && currentHash !== null && track.freeze.hash === currentHash && track.freeze.stale !== true) {
      const cacheFile = track.freeze.cacheFile ? path.join(freezeCacheDir(dataDir), path.basename(track.freeze.cacheFile)) : null
      if (cacheFile && existsSync(cacheFile)) continue
    }
    try {
      const frozen = await freezeTarget({
        dataDir,
        project,
        trackId: track.id,
        service,
        bars: targetBars,
        inputPcm: inputPcmByTrack?.[track.id] ?? null,
      })
      applied.push({ trackId: track.id, effectId: null, ...frozen })
    } catch (error) {
      warnings.push({ trackId: track.id, effectId: null, error: String(error?.message ?? error) })
    }
  }
  return { applied, warnings }
}
