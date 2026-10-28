/**
 * AI 音乐工作室 — Standard MIDI File（SMF Format 1）写入器。
 *
 * 纯生成逻辑：只依赖 src/shared/model.js 的 clipNotes/beatsPerBar，
 * 不碰 fs / 网络 / 定时器，可直接单测（test/midi.test.mjs）。
 *
 * 输出约定（CONTRACT-EDIT.md §2.4）：
 * - `MThd`：format = 1，ntrks = 1 + 工程轨道数，division = PPQ 480；
 * - track 0（conductor）：曲名 meta、tempo meta（BPM）、拍号 meta、段落 marker；
 * - 每条 studio 轨道一个 `MTrk`：轨道名 meta + program change + note on/off；
 *   鼓轨使用 MIDI 通道 10（0 基 channel 9），音高按 clipNotes 展开后原样输出（不叠加 transpose）；
 * - 事件时间 = clipNotes 展开后的绝对 beat × 480 tick；每轨以 `FF 2F 00` 结束。
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AUTOMATION_CC_PARAMS, beatsPerBar, clipNotes } from '../shared/model.js'
import { projectDurationSeconds } from '../shared/tempo.js'

/** 每四分音符 tick 数（1 小节 4 beat = 1920 ticks）。 */
export const PPQ = 480
/** SMF format 1（多轨同步）。 */
export const MIDI_FORMAT = 1
/** 鼓轨 MIDI 通道（0 基 9 = 通道 10）。 */
export const DRUM_CHANNEL = 9

/** 轨道角色 → GM program（0 基）。仅用于让导出的 MIDI 在 DAW 里听感接近。 */
const ROLE_PROGRAMS = {
  drums: 0,
  bass: 38, // Synth Bass 1
  lead: 81, // Lead 2 (sawtooth)
  pad: 89, // Pad 2 (warm)
  arp: 82, // Lead 3 (calliope)
  keys: 4, // Electric Piano 1
  fx: 95, // FX 5 (brightness)
}

const clampPitch = (pitch) => Math.max(0, Math.min(127, Math.round(pitch)))
const clampVel = (vel) => Math.max(1, Math.min(127, Math.round((Number(vel) || 0.8) * 127)))

/** 编码 MIDI variable-length quantity（VLQ）。 */
export function encodeVlq(value) {
  let n = Math.max(0, Math.floor(Number(value) || 0))
  const bytes = [n & 0x7f]
  n = Math.floor(n / 128)
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  return Buffer.from(bytes)
}

/** meta 事件：FF type len data。 */
function metaEvent(type, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return Buffer.concat([Buffer.from([0xff, type]), encodeVlq(payload.length), payload])
}

/** 文本类 meta（默认 0x03 track name）。 */
function textMeta(text, type = 0x03) {
  return metaEvent(type, Buffer.from(String(text ?? ''), 'utf8'))
}

/** tempo meta（0x51）：microseconds per quarter note。 */
function tempoMeta(bpm) {
  const usPerQuarter = Math.max(1, Math.round(60000000 / Math.max(1, Number(bpm) || 120)))
  return metaEvent(0x51, Buffer.from([(usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff]))
}

/** 拍号 meta（0x58）：nn, dd(log2 分母), cc(24), bb(8)。 */
function timeSignatureMeta(numerator, denominator) {
  const nn = Math.max(1, Math.min(64, Math.round(Number(numerator) || 4)))
  const dd = Math.max(0, Math.min(7, Math.round(Math.log2(Math.max(1, Number(denominator) || 4)))))
  return metaEvent(0x58, Buffer.from([nn, dd, 24, 8]))
}

/** 一个事件：tick 绝对 tick、order（0=note off 先于 1=note on）、bytes。 */
function sortEvents(events) {
  return events.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[1] - b.bytes[1])
}

/** 把绝对 tick 事件列表编码为 MTrk chunk（含 chunk 头与 end-of-track）。 */
/** R3b：CC 编号 → automation 参数 id 反查。 */
const CC_PARAM_BY_NUMBER = Object.freeze(
  Object.fromEntries(Object.entries(AUTOMATION_CC_PARAMS).map(([cc, param]) => [Number(cc), param])),
)

/**
 * R3b：把一条轨道的 automation 曲线转成 MIDI 事件。
 * - cc1/cc11/cc64/cc74 → 0xB0（value 0..1 → 0..127）
 * - pitchBend → 0xE0 14-bit
 * - expression → 0xA0 poly aftertouch（note 60；契约提及的 aftertouch 形式）
 * 仅导出 enabled 且 points 非空的曲线；volume/pan/cutoff/modulation 不写 MIDI（R3b 范围）。
 */
function automationEventsForTrack(track, channel) {
  const events = []
  const automation = track?.automation
  if (automation === null || typeof automation !== 'object') return events
  for (const [param, curve] of Object.entries(automation)) {
    if (!curve || curve.enabled === false || !Array.isArray(curve.points)) continue
    for (const point of curve.points) {
      const beat = Number(point?.beat)
      const value = Number(point?.value)
      if (!Number.isFinite(beat) || !Number.isFinite(value)) continue
      const tick = beatToTick(beat)
      const normalized = Math.max(0, Math.min(1, value))
      if (param === 'pitchBend') {
        const value14 = Math.max(0, Math.min(16383, Math.round(normalized * 16383)))
        events.push({
          tick,
          order: 1,
          bytes: Buffer.from([0xe0 | channel, value14 & 0x7f, (value14 >> 7) & 0x7f]),
        })
        continue
      }
      if (param === 'expression') {
        events.push({
          tick,
          order: 1,
          bytes: Buffer.from([0xa0 | channel, 60, Math.max(0, Math.min(127, Math.round(normalized * 127)))]),
        })
        continue
      }
      const ccEntry = Object.entries(CC_PARAM_BY_NUMBER).find(([, id]) => id === param)
      if (!ccEntry) continue
      events.push({
        tick,
        order: 1,
        bytes: Buffer.from([0xb0 | channel, Number(ccEntry[0]) & 0x7f, Math.max(0, Math.min(127, Math.round(normalized * 127)))]),
      })
    }
  }
  return events
}

function buildTrackChunk(events) {
  const chunks = []
  let lastTick = 0
  for (const event of sortEvents(events)) {
    const tick = Math.max(lastTick, Math.min(0x0fffffff, Math.round(event.tick)))
    chunks.push(encodeVlq(tick - lastTick), event.bytes)
    lastTick = tick
  }
  // delta 0 + FF 2F 00（end of track）
  chunks.push(encodeVlq(0), Buffer.from([0xff, 0x2f, 0x00]))
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('MTrk', 0, 'ascii')
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

/** 把 beat 转成 tick。 */
const beatToTick = (beat) => Math.max(0, Math.round((Number(beat) || 0) * PPQ))

/**
 * 收集一条轨道要导出的音符（绝对 beat；synth 含 transpose，鼓轨忽略 transpose）。
 * @returns {{pitch:number,start:number,dur:number,vel:number}[]}
 */
export function collectTrackNotes(project, track) {
  const notes = []
  for (const clip of project.clips) {
    if (clip.trackId !== track.id) continue
    const expanded = clipNotes(project, clip)
    const transpose = clip.transpose || 0
    for (const note of expanded) {
      notes.push({
        // clipNotes 已叠加 transpose；鼓轨按 GM 鼓件音高输出，需抵消 transpose。
        pitch: clampPitch(track.kind === 'drum' ? note.pitch - transpose : note.pitch),
        start: note.start,
        dur: note.dur,
        vel: note.vel,
      })
    }
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  return notes
}

/** 分配 MIDI 通道：鼓轨固定 9，其余在 0..15 中循环且跳过 9。 */
function makeChannelAssigner() {
  let next = 0
  return () => {
    let guard = 0
    while (next % 16 === DRUM_CHANNEL && guard < 32) {
      next += 1
      guard += 1
    }
    const channel = next % 16
    next += 1
    return channel
  }
}

/** 构建 conductor track（track 0）：曲名 + tempo + 拍号 + 段落 marker。 */
function buildConductorTrack(project) {
  const barBeats = beatsPerBar(project)
  const events = [{ tick: 0, order: 0, bytes: textMeta(project.title || 'AI 音乐工作室') }]
  // P12b：tempoMap 每个点输出一条 FF 51；首点不在 beat0 时先写基准 bpm（向前延伸）。
  const tempoMap = Array.isArray(project.tempoMap)
    ? project.tempoMap.filter((point) => Number.isFinite(Number(point?.beat)) && Number.isFinite(Number(point?.bpm)))
    : []
  if (tempoMap.length === 0) {
    events.push({ tick: 0, order: 1, bytes: tempoMeta(project.bpm) })
  } else {
    if (Number(tempoMap[0].beat) > 0) {
      events.push({ tick: 0, order: 1, bytes: tempoMeta(project.bpm) })
    }
    for (const point of tempoMap) {
      events.push({ tick: beatToTick(point.beat), order: 1, bytes: tempoMeta(point.bpm) })
    }
  }
  events.push({
    tick: 0,
    order: 2,
    bytes: timeSignatureMeta(project.timeSignature?.[0] ?? 4, project.timeSignature?.[1] ?? 4),
  })
  for (const section of project.sections ?? []) {
    events.push({
      tick: beatToTick((Number(section.startBar) || 0) * barBeats),
      order: 3,
      bytes: textMeta(section.name || 'Section', 0x06), // marker
    })
  }
  return buildTrackChunk(events)
}

/**
 * 生成整首工程的 MIDI 数据。
 * @param {object} project 工程模型
 * @returns {{buffer:Buffer, tracks:number, noteCount:number, seconds:number}}
 */
export function buildMidi(project) {
  if (project === null || typeof project !== 'object') throw new Error('buildMidi 需要工程对象')
  const tracks = Array.isArray(project.tracks) ? project.tracks : []
  // P12b：时长按 tempoMap 积分计算（常量 bpm 时与原公式完全一致）。
  const seconds = Math.round(projectDurationSeconds(project) * 100) / 100

  const chunks = [buildConductorTrack(project)]
  const assignChannel = makeChannelAssigner()
  let noteCount = 0

  for (const track of tracks) {
    const isDrum = track.kind === 'drum'
    const channel = isDrum ? DRUM_CHANNEL : assignChannel()
    const program = isDrum ? 0 : (ROLE_PROGRAMS[track.role] ?? 0)
    const events = [
      { tick: 0, order: 0, bytes: textMeta(track.name || track.id || 'Track') },
      { tick: 0, order: 1, bytes: Buffer.from([0xc0 | channel, program & 0x7f]) },
    ]
    const notes = collectTrackNotes(project, track)
    for (const note of notes) {
      const startTick = beatToTick(note.start)
      const endTick = Math.max(startTick + 1, beatToTick(note.start + Math.max(0.01, note.dur)))
      events.push(
        { tick: startTick, order: 2, bytes: Buffer.from([0x90 | channel, clampPitch(note.pitch), clampVel(note.vel)]) },
        { tick: endTick, order: 2, bytes: Buffer.from([0x80 | channel, clampPitch(note.pitch), 0]) },
      )
      noteCount += 1
    }
    // R3b：CC / pitch bend / aftertouch（expression）与音符同一 MTrk，按 tick 排序。
    events.push(...automationEventsForTrack(track, channel))
    chunks.push(buildTrackChunk(events))
  }

  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(14)
  header.write('MThd', 0, 'ascii')
  header.writeUInt32BE(6, 4)
  header.writeUInt16BE(MIDI_FORMAT, 8)
  header.writeUInt16BE(1 + tracks.length, 10)
  header.writeUInt16BE(PPQ, 12)
  return { buffer: Buffer.concat([header, body]), tracks: tracks.length, noteCount, seconds }
}

/**
 * 生成 MIDI Buffer（便捷函数）。
 * @param {object} project
 * @returns {Buffer}
 */
export function buildMidiFile(project) {
  return buildMidi(project).buffer
}

/**
 * 清理 MIDI 导出文件名：保留中英文/数字/空格/-/_，长度 ≤60，补 `.mid`。
 * @param {object} project 工程（用于默认名）
 * @param {string} [requestedName] 调用方指定名
 * @returns {string}
 */
export function midiExportName(project, requestedName) {
  const title = typeof project?.title === 'string' ? project.title : ''
  const raw = typeof requestedName === 'string' && requestedName.trim() !== '' ? requestedName : title || 'ai-music'
  // 先去掉已有的 .mid/.midi 后缀（避免被当成非法字符替换成 -mid），清理后再统一补 .mid。
  const withoutExt = String(raw).trim().replace(/\.midi?$/i, '')
  let safe = withoutExt
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5 -]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 60)
  if (safe === '') safe = `midi-${Date.now()}`
  return `${safe}.mid`
}

/**
 * 生成 MIDI 并写入 `<exportsDir>/<name>.mid`（原子写 .tmp → rename）。
 * @param {{exportsDir:string, project:object, name?:string}} options
 * @returns {Promise<{path:string,fileName:string,bytes:number,tracks:number,notes:number,seconds:number}>}
 */
export async function exportMidiFile(options = {}) {
  const { exportsDir, project } = options
  if (typeof exportsDir !== 'string' || exportsDir === '') throw new Error('exportMidiFile 需要 exportsDir')
  const { buffer, tracks, noteCount, seconds } = buildMidi(project)
  const fileName = midiExportName(project, options.name)
  await mkdir(exportsDir, { recursive: true })
  const filePath = path.join(exportsDir, fileName)
  const tmpPath = `${filePath}.tmp`
  await writeFile(tmpPath, buffer)
  await rename(tmpPath, filePath)
  return { path: filePath, fileName, bytes: buffer.length, tracks, notes: noteCount, seconds }
}
