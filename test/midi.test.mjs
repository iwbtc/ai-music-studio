/**
 * MIDI 导出单测（P1，CONTRACT-EDIT.md §2.4）。
 * 用「自己写的 SMF 解析器」逐字节验证 header / track / meta / note 事件，
 * 而不是复用 src/host/midi.js 的写入逻辑，避免读写错误互相抵消。
 *
 * 运行：node --test test/midi.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  DRUM_CHANNEL,
  PPQ,
  buildMidi,
  buildMidiFile,
  collectTrackNotes,
  encodeVlq,
  exportMidiFile,
  midiExportName,
} from '../src/host/midi.js'
import { buildProjectFromMidi, parseMidiBuffer } from '../src/host/midi-import.js'
import { createDemoProject } from '../src/shared/demo.js'
import { createEmptyProject, makeClip, makePattern, makeTrack } from '../src/shared/model.js'
import { projectDurationSeconds } from '../src/shared/tempo.js'

const tmpDirs = []
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aims-midi-'))
  tmpDirs.push(dir)
  return dir
}

/* ------------------------------------------------------------------------- */
/* 独立 SMF 解析器                                                            */
/* ------------------------------------------------------------------------- */

function readVlq(buffer, state) {
  let value = 0
  let byte
  do {
    if (state.pos >= buffer.length) throw new Error('VLQ 越界')
    byte = buffer[state.pos++]
    value = (value << 7) | (byte & 0x7f)
  } while (byte & 0x80)
  return value
}

/**
 * 解析 SMF；返回 {format, ntrks, division, tracks:[{name,tempo,timeSignature,program,channel,notes,markers,endTick}]}
 * notes 项：{tick, pitch, vel, on, channel}
 */
function parseSmf(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'MThd', '缺少 MThd')
  const headerLength = buffer.readUInt32BE(4)
  assert.equal(headerLength, 6, 'MThd 长度应为 6')
  const format = buffer.readUInt16BE(8)
  const ntrks = buffer.readUInt16BE(10)
  const division = buffer.readUInt16BE(12)
  let pos = 8 + headerLength
  const tracks = []
  while (pos < buffer.length) {
    assert.equal(buffer.toString('ascii', pos, pos + 4), 'MTrk', `第 ${tracks.length} 个 chunk 缺少 MTrk`)
    const length = buffer.readUInt32BE(pos + 4)
    const start = pos + 8
    const end = start + length
    assert.ok(end <= buffer.length, 'MTrk 长度越界')
    const state = { pos: start }
    const track = {
      name: null,
      tempo: null,
      tempos: [],
      timeSignature: null,
      program: null,
      channels: new Set(),
      notes: [],
      markers: [],
      endTick: 0,
      eventCount: 0,
    }
    let tick = 0
    while (state.pos < end) {
      tick += readVlq(buffer, state)
      const status = buffer[state.pos]
      if (status === 0xff) {
        state.pos += 1
        const type = buffer[state.pos++]
        const length2 = readVlq(buffer, state)
        const data = buffer.subarray(state.pos, state.pos + length2)
        state.pos += length2
        track.eventCount += 1
        if (type === 0x03) track.name = data.toString('utf8')
        else if (type === 0x51) {
          const us = (data[0] << 16) | (data[1] << 8) | data[2]
          track.tempo = us
          track.tempos.push({ tick, us })
        }
        else if (type === 0x58) track.timeSignature = [data[0], data[1]]
        else if (type === 0x06) track.markers.push(data.toString('utf8'))
        else if (type === 0x2f) {
          assert.equal(length2, 0, 'end-of-track 长度应为 0')
          break
        }
        continue
      }
      if (status === 0xf0 || status === 0xf7) {
        state.pos += 1
        const length2 = readVlq(buffer, state)
        state.pos += length2
        track.eventCount += 1
        continue
      }
      assert.ok(status >= 0x80 && status < 0xf0, `非法 status 0x${status?.toString(16)}`)
      const type = status & 0xf0
      const channel = status & 0x0f
      state.pos += 1
      track.channels.add(channel)
      if (type === 0x90 || type === 0x80) {
        const pitch = buffer[state.pos++]
        const vel = buffer[state.pos++]
        track.notes.push({ tick, pitch, vel, on: type === 0x90 && vel > 0, channel })
      } else if (type === 0xc0) {
        track.program = buffer[state.pos++]
      } else {
        throw new Error(`解析器未支持的事件类型 0x${type.toString(16)}`)
      }
      track.eventCount += 1
      track.endTick = tick
    }
    assert.equal(state.pos, end, 'MTrk 事件长度与 chunk 声明不一致')
    tracks.push(track)
    pos = end
  }
  assert.equal(pos, buffer.length, 'chunk 拼接后应正好到文件尾')
  assert.equal(tracks.length, ntrks, 'MThd 的 ntrks 应与实际 MTrk 数一致')
  return { format, ntrks, division, tracks }
}

/** 测试侧独立实现的「clip → 绝对 beat 音符」展开（不复用 src 的 clipNotes）。 */
function expandClip(project, clip) {
  const pattern = project.patterns.find((p) => p.id === clip.patternId)
  const barBeats = project.timeSignature[0]
  const patBeats = pattern.lengthBars * barBeats
  const clipBeats = clip.lengthBars * barBeats
  const startBeat = clip.startBar * barBeats
  const out = []
  for (let offset = 0; offset < clipBeats; offset += patBeats) {
    for (const note of pattern.notes) {
      const at = offset + note.start
      if (at >= clipBeats - 1e-6) continue
      out.push({ pitch: note.pitch + (clip.transpose || 0), start: startBeat + at, dur: Math.min(note.dur, clipBeats - at) })
    }
  }
  return out
}

function expectedTrackNotes(project, track) {
  const notes = []
  for (const clip of project.clips) {
    if (clip.trackId !== track.id) continue
    for (const note of expandClip(project, clip)) {
      notes.push({
        pitch: track.kind === 'drum' ? note.pitch - (clip.transpose || 0) : note.pitch,
        start: note.start,
        dur: note.dur,
      })
    }
  }
  return notes
}

/* ------------------------------------------------------------------------- */
/* 测试                                                                       */
/* ------------------------------------------------------------------------- */

describe('midi — SMF Format 1 结构', () => {
  it('demo 工程：MThd format1 / PPQ 480 / ntrks = 1 + 轨道数', () => {
    const project = createDemoProject()
    const { buffer, tracks, noteCount, seconds } = buildMidi(project)
    const smf = parseSmf(buffer)
    assert.equal(smf.format, 1)
    assert.equal(smf.division, PPQ)
    assert.equal(smf.division, 480)
    assert.equal(smf.ntrks, project.tracks.length + 1)
    assert.equal(tracks, project.tracks.length)
    assert.equal(smf.tracks.length, project.tracks.length + 1)

    // track0：曲名 / 速度 / 拍号 / 段落 marker
    const conductor = smf.tracks[0]
    assert.equal(conductor.name, project.title)
    assert.equal(conductor.tempo, Math.round(60000000 / project.bpm))
    assert.deepEqual(conductor.timeSignature.slice(0, 2), [project.timeSignature[0], 2])
    assert.deepEqual(conductor.markers, project.sections.map((section) => section.name))
    assert.equal(conductor.notes.length, 0)

    // 时长与统计
    const expectedSeconds = Math.round(((project.lengthBars * 4) / project.bpm) * 60 * 100) / 100
    assert.equal(seconds, expectedSeconds)
    const totalEvents = smf.tracks.reduce((sum, track) => sum + track.notes.length, 0)
    assert.equal(noteCount, totalEvents / 2)
    const expectedTotal = project.tracks.reduce((sum, track) => sum + expectedTrackNotes(project, track).length, 0)
    assert.ok(expectedTotal > 0)
    assert.equal(noteCount, expectedTotal)
  })

  it('每条轨道一个 MTrk：track name meta + 音符数/音高与 clip 展开一致', () => {
    const project = createDemoProject()
    const smf = parseSmf(buildMidiFile(project))
    for (let index = 0; index < project.tracks.length; index += 1) {
      const track = project.tracks[index]
      const midiTrack = smf.tracks[index + 1]
      assert.equal(midiTrack.name, track.name, `第 ${index} 条轨道名 meta`)
      const expected = expectedTrackNotes(project, track)
      const noteOns = midiTrack.notes.filter((note) => note.on)
      assert.equal(noteOns.length, expected.length, `${track.name} 音符数`)
      const expectedByTick = new Map()
      for (const note of expected) {
        const key = `${Math.round(note.start * PPQ)}:${Math.round(note.pitch)}`
        expectedByTick.set(key, (expectedByTick.get(key) || 0) + 1)
      }
      for (const note of noteOns) {
        const key = `${note.tick}:${note.pitch}`
        assert.ok(expectedByTick.get(key) > 0, `${track.name} 出现意外音符 ${key}`)
      }
      // note off 的 tick = on tick + dur ticks
      const offs = new Map()
      for (const note of midiTrack.notes.filter((item) => !item.on)) offs.set(`${note.tick}:${note.pitch}`, true)
      for (const note of expected) {
        const onTick = Math.round(note.start * PPQ)
        const offTick = Math.max(onTick + 1, Math.round((note.start + note.dur) * PPQ))
        assert.ok(offs.has(`${offTick}:${Math.round(note.pitch)}`), `${track.name} 缺少 note off @${offTick}`)
      }
      // 事件按 tick 非降序
      let last = -1
      for (const note of midiTrack.notes) {
        assert.ok(note.tick >= last, '事件 tick 必须单调不减')
        last = note.tick
      }
    }
  })

  it('鼓轨固定在 MIDI 通道 10（0 基 9）且 pitch 不受 transpose 影响', () => {
    const project = createDemoProject()
    const smf = parseSmf(buildMidiFile(project))
    let drumIndex = -1
    for (let index = 0; index < project.tracks.length; index += 1) {
      const track = project.tracks[index]
      const midiTrack = smf.tracks[index + 1]
      if (track.kind === 'drum') {
        drumIndex = index
        assert.deepEqual([...midiTrack.channels], [DRUM_CHANNEL])
        assert.equal(midiTrack.program, 0)
        const pitches = new Set(midiTrack.notes.map((note) => note.pitch))
        const expectedPitches = new Set(expectedTrackNotes(project, track).map((note) => Math.round(note.pitch)))
        assert.deepEqual(pitches, expectedPitches)
      } else {
        assert.ok(!midiTrack.channels.has(DRUM_CHANNEL), `${track.name} 不应占用鼓通道`)
        assert.equal(typeof midiTrack.program, 'number')
      }
    }
    assert.ok(drumIndex >= 0, 'demo 工程应包含鼓轨')
  })

  it('clip transpose 作用于合成器轨道，但不改变鼓轨音高', () => {
    const project = createEmptyProject({ title: 'transpose', bpm: 100 })
    const synth = makeTrack({ id: 'trk_1', name: 'Lead', kind: 'synth', preset: 'supersaw', role: 'lead' })
    const drum = makeTrack({ id: 'trk_2', name: 'Drums', kind: 'drum', kit: 'neon808', role: 'drums' })
    project.tracks = [synth, drum]
    project.patterns = [makePattern({ id: 'pat_1', name: 'melody', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.9 }] })]
    project.clips = [
      makeClip({ id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 1, transpose: 2 }),
      makeClip({ id: 'clip_2', trackId: 'trk_2', patternId: 'pat_1', startBar: 0, lengthBars: 1, transpose: 5 }),
    ]
    project.patterns[0].notes = [
      { pitch: 60, start: 0, dur: 1, vel: 0.9 },
      { pitch: 36, start: 1, dur: 0.5, vel: 0.9 },
    ]
    const smf = parseSmf(buildMidiFile(project))
    const synthOns = smf.tracks[1].notes.filter((note) => note.on).map((note) => note.pitch)
    assert.deepEqual(synthOns.sort((a, b) => a - b), [62, 38].sort((a, b) => a - b))
    const drumOns = smf.tracks[2].notes.filter((note) => note.on).map((note) => note.pitch)
    // 鼓轨：36/60 原样输出（不叠加 +5）
    assert.deepEqual(drumOns.sort((a, b) => a - b), [36, 60])
    assert.deepEqual([...smf.tracks[2].channels], [DRUM_CHANNEL])
  })

  it('空工程：只有 conductor track，0 音符，仍有 tempo/拍号', () => {
    const project = createEmptyProject({ title: 'Empty', bpm: 90, lengthBars: 8 })
    const smf = parseSmf(buildMidiFile(project))
    assert.equal(smf.ntrks, 1)
    assert.equal(smf.tracks.length, 1)
    assert.equal(smf.tracks[0].tempo, Math.round(60000000 / 90))
    assert.equal(smf.tracks[0].notes.length, 0)
    assert.equal(smf.tracks[0].name, 'Empty')
    const info = buildMidi(project)
    assert.equal(info.noteCount, 0)
    assert.equal(info.tracks, 0)
    assert.equal(info.seconds, Math.round(((8 * 4) / 90) * 60 * 100) / 100)
  })

  it('VLQ 编码边界（0/127/128/1920/16383/16384）', () => {
    const decode = (bytes) => {
      let value = 0
      for (const byte of bytes) value = (value << 7) | (byte & 0x7f)
      return value
    }
    assert.deepEqual([...encodeVlq(0)], [0x00])
    assert.deepEqual([...encodeVlq(127)], [0x7f])
    assert.deepEqual([...encodeVlq(128)], [0x81, 0x00])
    assert.deepEqual([...encodeVlq(1920)], [0x8f, 0x00])
    assert.equal(decode(encodeVlq(16383)), 16383)
    assert.equal(decode(encodeVlq(16384)), 16384)
    assert.equal(decode(encodeVlq(0x0fffffff)), 0x0fffffff)
  })

  it('collectTrackNotes 与 clip 展开一致（含 loop 平铺）', () => {
    const project = createDemoProject()
    for (const track of project.tracks) {
      const fromCollect = collectTrackNotes(project, track)
      const expected = expectedTrackNotes(project, track)
      assert.equal(fromCollect.length, expected.length, `${track.name} note 数`)
      fromCollect.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
      expected.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
      for (let index = 0; index < expected.length; index += 1) {
        assert.ok(Math.abs(fromCollect[index].start - expected[index].start) < 1e-9, 'start 一致')
        assert.equal(Math.round(fromCollect[index].pitch), Math.round(expected[index].pitch), 'pitch 一致')
      }
    }
  })
})

describe('midi — 文件名与写文件', () => {
  it('midiExportName：安全化、补 .mid、保留中文、防目录穿越', () => {
    assert.equal(midiExportName({ title: '霓虹天际线 Neon Skyline' }), '霓虹天际线 Neon Skyline.mid')
    assert.equal(midiExportName({ title: 'x' }, 'demo'), 'demo.mid')
    assert.equal(midiExportName({ title: 'x' }, 'demo.mid'), 'demo.mid')
    assert.equal(midiExportName({ title: 'x' }, '../evil'), 'evil.mid')
    assert.equal(midiExportName({ title: 'a/b:c*d' }), 'a-b-c-d.mid')
    assert.match(midiExportName({ title: 'x' }, ''), /^x\.mid$/)
    assert.ok(midiExportName({ title: 'y'.repeat(200) }).length <= 64)
  })

  it('exportMidiFile：写入 <dir>/<name>.mid，字节数正确、无 .tmp 残留', async () => {
    const dir = await tempDir()
    const project = createDemoProject()
    const result = await exportMidiFile({ exportsDir: dir, project, name: '导出测试' })
    assert.equal(result.fileName, '导出测试.mid')
    assert.equal(result.path, path.join(dir, '导出测试.mid'))
    const buffer = await readFile(result.path)
    assert.equal(buffer.length, result.bytes)
    assert.ok(result.tracks > 0)
    assert.ok(result.notes > 0)
    const smf = parseSmf(buffer)
    assert.equal(smf.format, 1)
    assert.equal(smf.ntrks, result.tracks + 1)
    const entries = await readdir(dir)
    assert.equal(entries.filter((name) => name.endsWith('.tmp')).length, 0)
    assert.deepEqual(entries, ['导出测试.mid'])
  })
})

/* ------------------------------------------------------------------------- */
/* P12b：conductor tempoMap 多速度事件                                        */
/* ------------------------------------------------------------------------- */

describe('midi P12b — conductor tempoMap', () => {
  const us = (bpm) => Math.round(60000000 / bpm)

  it('无 tempoMap：conductor 只有一条 tick0 的 FF 51（bpm 常量）', () => {
    const project = createEmptyProject({ bpm: 128 })
    const smf = parseSmf(buildMidi(project).buffer)
    const conductor = smf.tracks[0]
    assert.deepEqual(conductor.tempos, [{ tick: 0, us: us(128) }])
  })

  it('tempoMap：每个点一条 FF 51，tick = beat×480，首点必须存在', () => {
    const project = createEmptyProject({ bpm: 120, lengthBars: 8 })
    project.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }, { beat: 16, bpm: 180 }]
    const smf = parseSmf(buildMidi(project).buffer)
    assert.deepEqual(smf.tracks[0].tempos, [
      { tick: 0, us: us(120) },
      { tick: 8 * 480, us: us(60) },
      { tick: 16 * 480, us: us(180) },
    ])
    // 时长按 tempo 积分（与 tempo.js 一致）
    const result = buildMidi(project)
    assert.ok(Math.abs(result.seconds - Math.round(projectDurationSeconds(project) * 100) / 100) <= 0.01)
  })

  it('首点不在 beat0：先写基准 bpm 的 tick0 tempo，再写各点', () => {
    const project = createEmptyProject({ bpm: 128, lengthBars: 8 })
    project.tempoMap = [{ beat: 4, bpm: 90 }, { beat: 12, bpm: 150 }]
    const smf = parseSmf(buildMidi(project).buffer)
    assert.deepEqual(smf.tracks[0].tempos, [
      { tick: 0, us: us(128) },
      { tick: 4 * 480, us: us(90) },
      { tick: 12 * 480, us: us(150) },
    ])
  })

  it('tempoMap 加速段：MIDI 时长小于常量 bpm 基准时长', () => {
    const constant = createEmptyProject({ bpm: 120, lengthBars: 8 })
    const ramped = createEmptyProject({ bpm: 120, lengthBars: 8 })
    ramped.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 32, bpm: 200 }]
    assert.ok(buildMidi(ramped).seconds < buildMidi(constant).seconds)
  })
})

/* ------------------------------------------------------------------------- */
/* R3b：CC / pitch bend / aftertouch MIDI 导入导出                              */
/* ------------------------------------------------------------------------- */

function r3bVlq(value) {
  return encodeVlq(value)
}

function r3bMetaText(text, type = 0x03) {
  const data = Buffer.from(String(text), 'utf8')
  return Buffer.concat([Buffer.from([0xff, type]), r3bVlq(data.length), data])
}

function r3bMetaTempo(bpm = 120) {
  const microseconds = Math.round(60000000 / bpm)
  return Buffer.concat([Buffer.from([0xff, 0x51, 0x03]), Buffer.from([(microseconds >> 16) & 0xff, (microseconds >> 8) & 0xff, microseconds & 0xff])])
}

function r3bTrackChunk(events) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || (a.bytes[0] - b.bytes[0]))
  const parts = []
  let lastTick = 0
  for (const event of sorted) {
    const tick = Math.max(lastTick, event.tick)
    parts.push(r3bVlq(tick - lastTick), Buffer.from(event.bytes))
    lastTick = tick
  }
  parts.push(r3bVlq(0), Buffer.from([0xff, 0x2f, 0x00]))
  const body = Buffer.concat(parts)
  const header = Buffer.alloc(8)
  header.write('MTrk', 0, 'ascii')
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

function r3bControllerBytes(controller, channel = 0) {
  if (controller.type === 'cc') return [0xb0 | channel, controller.cc, controller.value]
  if (controller.type === 'pitchBend') {
    const value14 = Math.max(0, Math.min(16383, controller.value14))
    return [0xe0 | channel, value14 & 0x7f, (value14 >> 7) & 0x7f]
  }
  if (controller.type === 'aftertouch') return [0xa0 | channel, controller.note ?? 60, controller.value]
  if (controller.type === 'channelPressure') return [0xd0 | channel, controller.value]
  throw new Error('未知 controller 类型：' + controller.type)
}

function r3bMusicTrack({ channel = 0, name = 'Music', notes = [{ pitch: 60, startTick: 0, durTicks: 480, vel: 100 }], controllers = [] }) {
  const events = [
    { tick: 0, bytes: r3bMetaText(name) },
    { tick: 0, bytes: [0xc0 | channel, 0] },
  ]
  for (const note of notes) {
    events.push({ tick: note.startTick, bytes: [0x90 | channel, note.pitch, note.vel] })
    events.push({ tick: note.startTick + note.durTicks, bytes: [0x80 | channel, note.pitch, 0] })
  }
  for (const controller of controllers) {
    events.push({ tick: controller.tick, bytes: r3bControllerBytes(controller, channel) })
  }
  return r3bTrackChunk(events)
}

function r3bBuildSmf({ ppq = 480, musicTracks = [] }) {
  const chunks = [r3bTrackChunk([
    { tick: 0, bytes: r3bMetaText('Conductor') },
    { tick: 0, bytes: r3bMetaTempo(120) },
    { tick: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
  ])]
  for (const track of musicTracks) chunks.push(track)
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(14)
  header.write('MThd', 0, 'ascii')
  header.writeUInt32BE(6, 4)
  header.writeUInt16BE(1, 8)
  header.writeUInt16BE(1 + musicTracks.length, 10)
  header.writeUInt16BE(ppq, 12)
  return Buffer.concat([header, body])
}

function r3bFixtureProject() {
  const project = createEmptyProject({ title: 'R3b', bpm: 120, lengthBars: 4 })
  const track = makeTrack({ id: 'trk_1', kind: 'synth', name: 'Synth' })
  const pattern = makePattern({ id: 'pat_1', name: 'Synth', lengthBars: 4, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
  project.tracks = [track]
  project.patterns = [pattern]
  project.clips = [makeClip({ id: 'clip_1', trackId: 'trk_1', patternId: 'pat_1', startBar: 0, lengthBars: 4 })]
  return project
}

describe('R3b — MIDI CC / pitch bend / aftertouch 导入', () => {
  it('parseMidiBuffer 捕获 CC(1/11/64/74)/pitch bend/aftertouch/channel pressure', () => {
    const buffer = r3bBuildSmf({
      musicTracks: [r3bMusicTrack({
        controllers: [
          { tick: 0, type: 'cc', cc: 1, value: 64 },
          { tick: 240, type: 'cc', cc: 11, value: 127 },
          { tick: 480, type: 'cc', cc: 64, value: 0 },
          { tick: 720, type: 'cc', cc: 74, value: 32 },
          { tick: 960, type: 'pitchBend', value14: 16383 },
          { tick: 1200, type: 'aftertouch', note: 60, value: 100 },
          { tick: 1440, type: 'channelPressure', value: 50 },
          { tick: 1680, type: 'cc', cc: 7, value: 99 },
        ],
      })],
    })
    const parsed = parseMidiBuffer(buffer)
    assert.equal(parsed.tracks.length, 1)
    const controllers = parsed.tracks[0].controllers
    assert.equal(controllers.filter((event) => event.type === 'cc').length, 5)
    assert.equal(controllers.find((event) => event.type === 'cc' && event.cc === 1).value, 64)
    assert.equal(controllers.find((event) => event.type === 'pitchBend').value14, 16383)
    assert.equal(controllers.find((event) => event.type === 'aftertouch').value, 100)
    assert.equal(controllers.find((event) => event.type === 'channelPressure').value, 50)
  })

  it('buildProjectFromMidi：CC1/11/64/74 → track.automation，beat=tick/PPQ、value=cc/127', () => {
    const buffer = r3bBuildSmf({
      musicTracks: [r3bMusicTrack({
        controllers: [
          { tick: 0, type: 'cc', cc: 1, value: 0 },
          { tick: 480, type: 'cc', cc: 1, value: 127 },
          { tick: 0, type: 'cc', cc: 11, value: 64 },
          { tick: 960, type: 'cc', cc: 64, value: 127 },
          { tick: 1920, type: 'cc', cc: 74, value: 32 },
          { tick: 960, type: 'cc', cc: 7, value: 100 },
        ],
      })],
    })
    const parsed = parseMidiBuffer(buffer)
    const { project, imported } = buildProjectFromMidi(parsed)
    const automation = project.tracks[0].automation
    assert.ok(automation)
    assert.deepEqual(Object.keys(automation).sort(), ['cc1', 'cc11', 'cc64', 'cc74'])
    assert.deepEqual(automation.cc1.points, [{ beat: 0, value: 0 }, { beat: 1, value: 1 }])
    assert.equal(automation.cc11.points[0].value, 64 / 127)
    assert.equal(automation.cc64.points[0].beat, 2)
    assert.ok(Math.abs(automation.cc74.points[0].value - 32 / 127) < 1e-9)
    assert.equal(imported.automationTracks, 1)
    assert.equal(imported.tracks, 1)
    assert.equal(imported.notes, 1)
  })

  it('pitch bend 14-bit → automation.pitchBend（0/8192/16383）', () => {
    const buffer = r3bBuildSmf({
      musicTracks: [r3bMusicTrack({
        controllers: [
          { tick: 0, type: 'pitchBend', value14: 0 },
          { tick: 480, type: 'pitchBend', value14: 8192 },
          { tick: 960, type: 'pitchBend', value14: 16383 },
        ],
      })],
    })
    const { project } = buildProjectFromMidi(parseMidiBuffer(buffer))
    const points = project.tracks[0].automation.pitchBend.points
    assert.equal(points.length, 3)
    assert.equal(points[0].value, 0)
    assert.ok(Math.abs(points[1].value - 8192 / 16383) < 1e-9)
    assert.equal(points[2].value, 1)
  })

  it('aftertouch 0xA0 与 channel pressure 0xD0 → automation.expression', () => {
    const buffer = r3bBuildSmf({
      musicTracks: [r3bMusicTrack({
        controllers: [
          { tick: 0, type: 'aftertouch', note: 60, value: 127 },
          { tick: 480, type: 'channelPressure', value: 64 },
        ],
      })],
    })
    const { project } = buildProjectFromMidi(parseMidiBuffer(buffer))
    const points = project.tracks[0].automation.expression.points
    assert.equal(points.length, 2)
    assert.equal(points[0].value, 1)
    assert.equal(points[1].value, 64 / 127)
  })

  it('CC-only（无音符）轨被忽略，不新增轨道', () => {
    const buffer = r3bBuildSmf({
      musicTracks: [
        r3bMusicTrack({ channel: 0, controllers: [{ tick: 0, type: 'cc', cc: 1, value: 99 }] }),
        r3bMusicTrack({ channel: 1, name: 'CC Only', notes: [], controllers: [
          { tick: 0, type: 'cc', cc: 11, value: 10 },
          { tick: 480, type: 'cc', cc: 74, value: 20 },
        ] }),
      ],
    })
    const parsed = parseMidiBuffer(buffer)
    const { project } = buildProjectFromMidi(parsed)
    assert.equal(project.tracks.length, 1)
    assert.equal(project.tracks[0].name, 'Music')
    assert.equal(project.tracks[0].automation.cc1.points[0].value, 99 / 127)
  })

  it('CC 按 channel 归属：channel1 的 CC 不写到 channel0 轨', () => {
    const buffer = r3bBuildSmf({
      musicTracks: [
        r3bMusicTrack({ channel: 0, controllers: [{ tick: 0, type: 'cc', cc: 1, value: 10 }] }),
        r3bMusicTrack({ channel: 1, name: 'Other', notes: [{ pitch: 67, startTick: 0, durTicks: 480, vel: 90 }], controllers: [{ tick: 0, type: 'cc', cc: 11, value: 100 }] }),
      ],
    })
    const { project } = buildProjectFromMidi(parseMidiBuffer(buffer))
    const byName = new Map(project.tracks.map((track) => [track.name, track]))
    assert.equal(byName.get('Music').automation.cc1.points[0].value, 10 / 127)
    assert.equal(byName.get('Music').automation.cc11, undefined)
    assert.equal(byName.get('Other').automation.cc11.points[0].value, 100 / 127)
  })

  it('同 tick 重复 CC：后值覆盖；点按 beat 排序', () => {
    const buffer = r3bBuildSmf({
      musicTracks: [r3bMusicTrack({ controllers: [
        { tick: 480, type: 'cc', cc: 1, value: 10 },
        { tick: 0, type: 'cc', cc: 1, value: 5 },
        { tick: 480, type: 'cc', cc: 1, value: 90 },
      ] })],
    })
    const { project } = buildProjectFromMidi(parseMidiBuffer(buffer))
    assert.deepEqual(project.tracks[0].automation.cc1.points, [
      { beat: 0, value: 5 / 127 },
      { beat: 1, value: 90 / 127 },
    ])
  })

  it('CC 点超过 256 时按上限截断', () => {
    const controllers = Array.from({ length: 300 }, (_, index) => ({ tick: index * 10, type: 'cc', cc: 1, value: index % 127 }))
    const buffer = r3bBuildSmf({ musicTracks: [r3bMusicTrack({ controllers })] })
    const { project } = buildProjectFromMidi(parseMidiBuffer(buffer))
    assert.ok(project.tracks[0].automation.cc1.points.length <= 256)
  })

  it('无 CC 旧 MIDI 不变：无 automation / automationTracks=0', () => {
    const buffer = r3bBuildSmf({ musicTracks: [r3bMusicTrack({})] })
    const parsed = parseMidiBuffer(buffer)
    assert.deepEqual(parsed.tracks[0].controllers, [])
    const { project, imported } = buildProjectFromMidi(parsed)
    assert.equal(project.tracks[0].automation, undefined)
    assert.equal(imported.automationTracks, 0)
    assert.equal(imported.notes, 1)
  })
})

describe('R3b — MIDI CC / pitch bend / aftertouch 导出与往返', () => {
  it('buildMidi：CC1/11/64/74 导出为 0xB0，tick/value 正确', () => {
    const project = r3bFixtureProject()
    project.tracks[0].automation = {
      cc1: { enabled: true, points: [{ beat: 0, value: 0 }, { beat: 2, value: 1 }] },
      cc11: { enabled: true, points: [{ beat: 1, value: 0.5 }] },
      cc64: { enabled: true, points: [{ beat: 3, value: 1 }] },
      cc74: { enabled: true, points: [{ beat: 4, value: 0.25 }] },
    }
    const buffer = buildMidiFile(project)
    const parsed = parseMidiBuffer(buffer)
    const controllers = parsed.tracks.flatMap((track) => track.controllers)
    assert.deepEqual(controllers.map((event) => event.cc), [1, 11, 1, 64, 74])
    const cc1Beats = controllers.filter((event) => event.cc === 1).map((event) => event.tick / PPQ)
    assert.deepEqual(cc1Beats, [0, 2])
    assert.equal(controllers.find((event) => event.cc === 11).value, Math.round(0.5 * 127))
    assert.equal(controllers.find((event) => event.cc === 74).value, Math.round(0.25 * 127))
  })

  it('pitch bend 导出 0xE0 14-bit，往返 ±1', () => {
    const project = r3bFixtureProject()
    project.tracks[0].automation = {
      pitchBend: { enabled: true, points: [{ beat: 0, value: 0 }, { beat: 1, value: 0.5 }, { beat: 2, value: 1 }] },
    }
    const parsed = parseMidiBuffer(buildMidiFile(project))
    const bends = parsed.tracks.flatMap((track) => track.controllers).filter((event) => event.type === 'pitchBend')
    assert.equal(bends.length, 3)
    assert.deepEqual(bends.map((event) => event.value14), [0, Math.round(0.5 * 16383), 16383])
    const roundtrip = buildProjectFromMidi(parsed)
    const points = roundtrip.project.tracks[0].automation.pitchBend.points
    assert.equal(points.length, 3)
    for (let index = 0; index < 3; index += 1) {
      assert.ok(Math.abs(points[index].value - project.tracks[0].automation.pitchBend.points[index].value) <= 1 / 16383 + 1e-9)
    }
  })

  it('expression 导出为 0xA0 aftertouch（note 60），往返恢复', () => {
    const project = r3bFixtureProject()
    project.tracks[0].automation = {
      expression: { enabled: true, points: [{ beat: 0, value: 0.2 }, { beat: 2, value: 0.9 }] },
    }
    const buffer = buildMidiFile(project)
    const parsed = parseMidiBuffer(buffer)
    const aftertouches = parsed.tracks.flatMap((track) => track.controllers).filter((event) => event.type === 'aftertouch')
    assert.equal(aftertouches.length, 2)
    assert.equal(aftertouches[0].note, 60)
    assert.equal(aftertouches[0].value, Math.round(0.2 * 127))
    const roundtrip = buildProjectFromMidi(parsed)
    const points = roundtrip.project.tracks[0].automation.expression.points
    assert.equal(points.length, 2)
    assert.ok(Math.abs(points[1].value - 0.9) <= 1 / 127 + 1e-9)
  })

  it('disabled 曲线不导出；无 automation 的工程不产生额外控制器事件', () => {
    const project = r3bFixtureProject()
    project.tracks[0].automation = {
      cc1: { enabled: false, points: [{ beat: 0, value: 1 }] },
    }
    const parsed = parseMidiBuffer(buildMidiFile(project))
    assert.equal(parsed.tracks.flatMap((track) => track.controllers).length, 0)
    const plain = r3bFixtureProject()
    const plainParsed = parseMidiBuffer(buildMidiFile(plain))
    assert.equal(plainParsed.tracks.flatMap((track) => track.controllers).length, 0)
    assert.equal(plainParsed.tracks[0].notes.length, 1, '音符事件保持原样')
  })

  it('automation 不改变 note/tempo/拍号输出', () => {
    const plain = r3bFixtureProject()
    const withAutomation = r3bFixtureProject()
    withAutomation.tracks[0].automation = {
      cc11: { enabled: true, points: [{ beat: 0, value: 0.3 }, { beat: 3, value: 0.8 }] },
    }
    const plainParsed = parseMidiBuffer(buildMidiFile(plain))
    const autoParsed = parseMidiBuffer(buildMidiFile(withAutomation))
    assert.deepEqual(autoParsed.tracks[0].notes, plainParsed.tracks[0].notes)
    assert.equal(autoParsed.tracks[0].tempo, plainParsed.tracks[0].tempo)
    assert.deepEqual(autoParsed.timeSignature, plainParsed.timeSignature)
    assert.equal(autoParsed.tracks[0].controllers.length - plainParsed.tracks[0].controllers.length, 2)
  })

  it('全参数往返：CC/pitch bend/expression 的 beat 与 value 在容差内', () => {
    const project = r3bFixtureProject()
    project.tracks[0].automation = {
      cc1: { enabled: true, points: [{ beat: 0, value: 0.1 }, { beat: 1.5, value: 0.75 }, { beat: 4, value: 1 }] },
      cc11: { enabled: true, points: [{ beat: 2, value: 0.4 }] },
      cc64: { enabled: true, points: [{ beat: 1, value: 1 }] },
      cc74: { enabled: true, points: [{ beat: 3, value: 0.2 }] },
      pitchBend: { enabled: true, points: [{ beat: 2, value: 0.75 }] },
      expression: { enabled: true, points: [{ beat: 0, value: 0.5 }] },
    }
    const parsed = parseMidiBuffer(buildMidiFile(project))
    const { project: roundtrip, imported } = buildProjectFromMidi(parsed)
    const automation = roundtrip.tracks[0].automation
    for (const param of ['cc1', 'cc11', 'cc64', 'cc74', 'pitchBend', 'expression']) {
      assert.ok(automation[param], param)
      assert.equal(automation[param].points.length, project.tracks[0].automation[param].points.length, param)
      for (let index = 0; index < project.tracks[0].automation[param].points.length; index += 1) {
        const before = project.tracks[0].automation[param].points[index]
        const after = automation[param].points[index]
        assert.ok(Math.abs(before.beat - after.beat) < 1e-9, param + ' beat')
        assert.ok(Math.abs(before.value - after.value) <= 1 / 127 + 1e-9, param + ' value')
      }
    }
    assert.equal(imported.automationTracks, 1)
  })

  it('CC64 仅存储/导出（不参与引擎），roundtrip 生效', () => {
    const project = r3bFixtureProject()
    project.tracks[0].automation = { cc64: { enabled: true, points: [{ beat: 1, value: 1 }] } }
    const parsed = parseMidiBuffer(buildMidiFile(project))
    const cc64 = parsed.tracks.flatMap((track) => track.controllers).find((event) => event.cc === 64)
    assert.ok(cc64)
    assert.equal(cc64.value, 127)
    assert.equal(cc64.tick, PPQ)
  })
})
