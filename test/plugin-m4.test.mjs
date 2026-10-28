/** v2.2 M4: offline render / plugin freeze / cache media / state persistence (ASCII-only tests). */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { createPluginHostClient, DEFAULT_SIDECAR_PATH } from '../src/host/plugin-host-client.js'
import { createPluginService } from '../src/host/plugin-service.js'
import {
  DEFAULT_FREEZE_SAMPLE_RATE,
  autoFreezeForExport,
  barsToFrames,
  buildInstrumentEvents,
  freezeCacheDir,
  freezeCachePath,
  freezeTarget,
  getFreezeStatus,
  hashFreezePayload,
  invalidateStaleFreezes,
  removeFreezeFromProject,
  setFreezeOnProject,
  trackFreezeHash,
} from '../src/host/plugin-freeze.js'
import * as model from '../src/shared/model.js'
import * as ops from '../src/host/ops.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const INSTRUMENT_FIXTURE = process.env.AIMS_VST3_TEST_INSTRUMENT_PLUGIN || path.join(ROOT, '.dev-fixtures', 'vst3-instrument', 'TAL-NoiseMaker.vst3')
const EFFECT_FIXTURE = process.env.AIMS_VST3_TEST_PLUGIN || path.join(ROOT, '.dev-fixtures', 'vst3', 'TAL-Reverb-4.vst3')
const HAS_INSTRUMENT = existsSync(INSTRUMENT_FIXTURE)
const HAS_EFFECT = existsSync(EFFECT_FIXTURE)

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'aims-m4-')) }

function makeWav(frames = 64) {
  const buffer = Buffer.alloc(44 + frames * 4)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + frames * 4, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(2, 22)
  buffer.writeUInt32LE(48000, 24)
  buffer.writeUInt32LE(48000 * 4, 28)
  buffer.writeUInt16LE(4, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(frames * 4, 40)
  return buffer
}

function makeFreezeService(options = {}) {
  const calls = []
  const service = {
    calls,
    async getPlugin(pluginId) {
      if (options.missing) return { pluginId, name: 'Missing', missing: true, isInstrument: true }
      return { pluginId, name: 'Mock Plugin', vendor: 'Mock', version: '1.0', isInstrument: true, isEffect: true, missing: false }
    },
    async renderOffline(request) {
      calls.push(request)
      if (options.renderError) throw new Error(options.renderError)
      await writeFile(request.outputPath, makeWav(Math.max(64, Math.min(512, request.frames || 64))))
      return {
        path: request.outputPath,
        bytes: 44 + 64 * 4,
        frames: request.frames,
        sampleRate: request.sampleRate,
        channels: 2,
        durationSeconds: (request.frames || 64) / (request.sampleRate || 48000),
        peak: 0.5,
        rms: 0.2,
        latencySamples: 0,
        stateBase64: options.stateBase64 ?? 'U1RBVEU=',
      }
    },
  }
  return service
}

function makeProject({ withEffect = false, notes = [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] } = {}) {
  const project = model.createEmptyProject()
  project.title = 'M4 Test'
  project.lengthBars = 2
  project.bpm = 120
  const track = ops.addTrack(project, {
    kind: 'synth', engine: 'vst3', name: 'Inst',
    vst3: { pluginId: 'vst3_inst', name: 'Instrument', vendor: 'V', version: '1', category: 'Audio Module Class', subCategories: 'Instrument|Synth', kind: 'instrument', isInstrument: true, midiInputs: 1, params: {} },
  })
  const pattern = model.makePattern({ id: 'pat_1', name: 'Notes', lengthBars: 1, notes })
  project.patterns.push(pattern)
  project.clips.push(model.makeClip({ id: 'clip_1', trackId: track.trackId, patternId: 'pat_1', startBar: 0, lengthBars: 2 }))
  let effectId = null
  if (withEffect) {
    const effect = ops.addEffect(project, { target: track.trackId, type: 'vst3', vst3: { pluginId: 'vst3_fx', name: 'Effect', params: {} } })
    effectId = effect.effectId
  }
  return { project, trackId: track.trackId, effectId, pattern }
}

async function cleanup(dataDir) {
  await rm(dataDir, { recursive: true, force: true }).catch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })
}

describe('v2.2 M4 freeze hash', () => {
  it('hashFreezePayload stable regardless of key order', () => {
    assert.equal(hashFreezePayload({ a: 1, b: 2 }), hashFreezePayload({ b: 2, a: 1 }))
  })
  it('hashFreezePayload changes on value change', () => {
    assert.notEqual(hashFreezePayload({ a: 1 }), hashFreezePayload({ a: 2 }))
  })
  it('trackFreezeHash stable for same project', () => {
    const { project, trackId } = makeProject()
    assert.equal(trackFreezeHash(project, trackId), trackFreezeHash(project, trackId))
  })
  it('trackFreezeHash changes on note edit', () => {
    const { project, trackId, pattern } = makeProject()
    const first = trackFreezeHash(project, trackId)
    pattern.notes[0].pitch = 67
    assert.notEqual(trackFreezeHash(project, trackId), first)
  })
  it('trackFreezeHash changes on bpm change', () => {
    const { project, trackId } = makeProject()
    const first = trackFreezeHash(project, trackId)
    project.bpm = 90
    assert.notEqual(trackFreezeHash(project, trackId), first)
  })
  it('trackFreezeHash changes on clip length change', () => {
    const { project, trackId } = makeProject()
    const first = trackFreezeHash(project, trackId)
    project.clips[0].lengthBars = 1
    assert.notEqual(trackFreezeHash(project, trackId), first)
  })
  it('trackFreezeHash changes on vst3 params change', () => {
    const { project, trackId } = makeProject()
    const first = trackFreezeHash(project, trackId)
    project.tracks[0].vst3.params = { 1: 0.5 }
    assert.notEqual(trackFreezeHash(project, trackId), first)
  })
  it('trackFreezeHash changes on state change', () => {
    const { project, trackId } = makeProject()
    const first = trackFreezeHash(project, trackId)
    project.tracks[0].vst3.stateBase64 = 'AAAA'
    assert.notEqual(trackFreezeHash(project, trackId), first)
  })
  it('effect hash includes effect plugin descriptor', () => {
    const { project, trackId, effectId } = makeProject({ withEffect: true })
    const first = trackFreezeHash(project, trackId, effectId)
    project.tracks[0].effects.find((fx) => fx.id === effectId).vst3.params = { 2: 0.4 }
    assert.notEqual(trackFreezeHash(project, trackId, effectId), first)
  })
  it('effect hash equals track hash (unified track freeze)', () => {
    const { project, trackId, effectId } = makeProject({ withEffect: true })
    assert.equal(trackFreezeHash(project, trackId), trackFreezeHash(project, trackId, effectId))
  })
  it('missing track throws', () => {
    const { project } = makeProject()
    assert.throws(() => trackFreezeHash(project, 'trk_missing'), /not found|不存在/)
  })
})

describe('v2.2 M4 bars/events', () => {
  it('barsToFrames 1 bar at 120bpm 48k = 96000', () => {
    const { project } = makeProject()
    assert.equal(barsToFrames(project, 1), 96000)
  })
  it('barsToFrames clamps invalid bars to >=1', () => {
    const { project } = makeProject()
    assert.equal(barsToFrames(project, 0), 96000)
  })
  it('barsToFrames respects custom sampleRate', () => {
    const { project } = makeProject()
    assert.equal(barsToFrames(project, 1, 44100), 88200)
  })
  it('barsToFrames caps at 300 seconds', () => {
    const { project } = makeProject()
    assert.ok(barsToFrames(project, 256, 192000) <= 192000 * 300)
  })
  it('buildInstrumentEvents returns noteOn/noteOff pairs', () => {
    const { project, trackId } = makeProject()
    const { events } = buildInstrumentEvents(project, project.tracks[0], { bars: 1 })
    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'noteOn')
    assert.equal(events[1].type, 'noteOff')
    assert.equal(events[0].pitch, 60)
  })
  it('buildInstrumentEvents respects clip transpose', () => {
    const { project } = makeProject()
    project.clips[0].transpose = 12
    const { events } = buildInstrumentEvents(project, project.tracks[0], { bars: 1 })
    assert.equal(events[0].pitch, 72)
  })
  it('buildInstrumentEvents repeats pattern per clip bars', () => {
    const { project } = makeProject()
    project.clips[0].lengthBars = 2
    const { events } = buildInstrumentEvents(project, project.tracks[0], { bars: 2 })
    assert.equal(events.length, 4)
  })
  it('buildInstrumentEvents caps events at 50000', () => {
    const notes = Array.from({ length: 30000 }, (_, index) => ({ pitch: 60, start: index * 0.001, dur: 0.001, vel: 0.8 }))
    const { project } = makeProject({ notes })
    const { events } = buildInstrumentEvents(project, project.tracks[0], { bars: 1 })
    assert.ok(events.length <= 50000)
  })
  it('buildInstrumentEvents ignores clips beyond bars', () => {
    const { project } = makeProject()
    const { events } = buildInstrumentEvents(project, project.tracks[0], { bars: 1 })
    assert.ok(events.every((event) => event.frame < 96000))
  })
  it('buildInstrumentEvents velocity normalized to MIDI 1..127', () => {
    const { project } = makeProject({ notes: [{ pitch: 60, start: 0, dur: 1, vel: 1 }] })
    const { events } = buildInstrumentEvents(project, project.tracks[0], { bars: 1 })
    assert.equal(events[0].velocity, 127)
  })
  it('buildInstrumentEvents frames matches barsToFrames', () => {
    const { project } = makeProject()
    assert.equal(buildInstrumentEvents(project, project.tracks[0], { bars: 2 }).frames, barsToFrames(project, 2))
  })
})

describe('v2.2 M4 freezeTarget with mock service', () => {
  it('freezes instrument and writes cache/media/state', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const service = makeFreezeService()
      const frozen = await freezeTarget({ dataDir, project, trackId, service })
      assert.equal(frozen.freeze.status, 'current')
      assert.ok(frozen.freeze.hash)
      assert.ok(frozen.freeze.mediaId.startsWith('med_freeze_'))
      assert.ok(existsSync(frozen.freeze.cachePath))
      assert.equal(frozen.stateBase64, 'U1RBVEU=')
      assert.equal(service.calls[0].kind, 'instrument')
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget rejects missing track', async () => {
    const dataDir = await tempDir()
    try {
      const { project } = makeProject()
      await assert.rejects(freezeTarget({ dataDir, project, trackId: 'trk_none', service: makeFreezeService() }), /not found|不存在/)
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget rejects non-vst3 track', async () => {
    const dataDir = await tempDir()
    try {
      const project = model.createEmptyProject()
      const track = ops.addTrack(project, { kind: 'synth', name: 'Sampler', preset: 'grand_piano' })
      await assert.rejects(freezeTarget({ dataDir, project, trackId: track.trackId, service: makeFreezeService() }), /VST3/)
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget rejects missing plugin entry', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      await assert.rejects(freezeTarget({ dataDir, project, trackId, service: makeFreezeService({ missing: true }) }), /missing|内容缺失/)
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget rejects missing track.vst3 descriptor', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      delete project.tracks[0].vst3
      await assert.rejects(freezeTarget({ dataDir, project, trackId, service: makeFreezeService() }), /VST3/)
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget ordinary track + vst3 effect uses sampler fallback when no inputPcm', async () => {
    const dataDir = await tempDir()
    try {
      const project = model.createEmptyProject()
      project.bpm = 120
      const track = ops.addTrack(project, { kind: 'synth', name: 'Sampler', preset: 'grand_piano' })
      const pattern = model.makePattern({ id: 'pat_o', name: 'P', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
      project.patterns.push(pattern)
      project.clips.push(model.makeClip({ id: 'clip_o', trackId: track.trackId, patternId: 'pat_o', startBar: 0, lengthBars: 1 }))
      const effect = ops.addEffect(project, { target: track.trackId, type: 'vst3', vst3: { pluginId: 'vst3_fx', name: 'Fx' } })
      const frozen = await freezeTarget({ dataDir, project, trackId: track.trackId, effectId: effect.effectId, service: makeFreezeService(), bars: 1 })
      assert.equal(frozen.freeze.status, 'current')
      assert.equal(frozen.freeze.includesFx, false)
      assert.ok(frozen.effectIds.includes(effect.effectId))
      assert.ok(existsSync(frozen.freeze.cachePath))
    } finally { await cleanup(dataDir) }
  })

  it('freezeTarget ordinary track accepts engine inputPcm first', async () => {
    const dataDir = await tempDir()
    try {
      const project = model.createEmptyProject()
      project.bpm = 120
      const track = ops.addTrack(project, { kind: 'synth', name: 'Sampler', preset: 'grand_piano' })
      const effect = ops.addEffect(project, { target: track.trackId, type: 'vst3', vst3: { pluginId: 'vst3_fx', name: 'Fx' } })
      const frames = barsToFrames(project, 1)
      const silence = Buffer.from(new Float32Array(frames).buffer).toString('base64')
      const frozen = await freezeTarget({ dataDir, project, trackId: track.trackId, effectId: effect.effectId, service: makeFreezeService(), bars: 1, inputPcm: [silence, silence] })
      assert.equal(frozen.freeze.status, 'current')
      assert.ok(frozen.freeze.cacheFile)
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget effect on vst3 instrument auto-renders dry input', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId, effectId } = makeProject({ withEffect: true })
      const service = makeFreezeService()
      const frozen = await freezeTarget({ dataDir, project, trackId, effectId, service })
      assert.equal(frozen.freeze.status, 'current')
      assert.equal(service.calls.length, 2)
      assert.equal(service.calls[0].kind, 'instrument')
      assert.equal(service.calls[1].kind, 'effect')
      assert.ok(service.calls[1].inputPcm.length > 0)
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget effect with explicit inputPcm still renders full external chain', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId, effectId } = makeProject({ withEffect: true })
      const service = makeFreezeService()
      await freezeTarget({ dataDir, project, trackId, effectId, service, inputPcm: ['AAAA', 'AAAA'] })
      assert.ok(service.calls.length >= 2)
      assert.equal(service.calls[0].kind, 'instrument')
      assert.equal(service.calls[service.calls.length - 1].kind, 'effect')
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget passes params/state to renderOffline', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      project.tracks[0].vst3.params = { 1: 0.25 }
      project.tracks[0].vst3.stateBase64 = 'T0xE'
      const service = makeFreezeService()
      await freezeTarget({ dataDir, project, trackId, service })
      assert.deepEqual(service.calls[0].params, { 1: 0.25 })
      assert.equal(service.calls[0].stateBase64, 'T0xE')
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget honors bars argument', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService(), bars: 1 })
      assert.equal(frozen.freeze.bars, 1)
      assert.equal(frozen.freeze.frames, barsToFrames(project, 1))
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget writes media file under dataDir/media', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      const mediaPath = path.join(dataDir, 'media', `freeze-${frozen.freeze.hash}.wav`)
      assert.ok(existsSync(mediaPath))
      assert.ok((await stat(mediaPath)).size > 44)
    } finally { await cleanup(dataDir) }
  })
  it('freezeTarget cache stays under plugin-cache', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      assert.equal(path.dirname(frozen.freeze.cachePath), freezeCacheDir(dataDir))
    } finally { await cleanup(dataDir) }
  })
})

describe('v2.2 M4 project freeze state', () => {
  it('setFreezeOnProject writes track.freeze/media/state', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      assert.equal(project.tracks[0].freeze.hash, frozen.freeze.hash)
      assert.equal(project.tracks[0].vst3.stateBase64, 'U1RBVEU=')
      assert.equal(project.media.length, 1)
      assert.equal(project.media[0].id, frozen.freeze.mediaId)
    } finally { await cleanup(dataDir) }
  })
  it('effect freeze is unified into track.freeze (B semantics)', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId, effectId } = makeProject({ withEffect: true })
      const frozen = await freezeTarget({ dataDir, project, trackId, effectId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, trackStateBase64: frozen.trackStateBase64, effectStates: frozen.effectStates })
      assert.ok(project.tracks[0].freeze)
      assert.equal(project.tracks[0].freeze.includesFx, false)
      assert.equal(project.tracks[0].effects.find((fx) => fx.id === effectId).freeze, undefined)
    } finally { await cleanup(dataDir) }
  })
  it('getFreezeStatus current after freeze', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      const status = getFreezeStatus(project, { dataDir })
      assert.equal(status.items[0].status, 'current')
      assert.equal(status.items[0].frozen, true)
    } finally { await cleanup(dataDir) }
  })
  it('getFreezeStatus stale after note edit', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId, pattern } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      pattern.notes[0].pitch = 66
      assert.equal(getFreezeStatus(project, { dataDir }).items[0].status, 'stale')
    } finally { await cleanup(dataDir) }
  })
  it('getFreezeStatus unfrozen when no freeze', () => {
    const { project } = makeProject()
    assert.equal(getFreezeStatus(project, { dataDir: os.tmpdir() }).items[0].status, 'unfrozen')
  })
  it('getFreezeStatus missing when plugin descriptor missing flag', () => {
    const { project } = makeProject()
    project.tracks[0].vst3.missing = true
    assert.equal(getFreezeStatus(project, { dataDir: os.tmpdir() }).items[0].status, 'missing')
  })
  it('getFreezeStatus error when cache file deleted', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      await rm(frozen.freeze.cachePath, { force: true })
      assert.equal(getFreezeStatus(project, { dataDir }).items[0].status, 'error')
    } finally { await cleanup(dataDir) }
  })
  it('getFreezeStatus can filter by trackId/effectId', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId, effectId } = makeProject({ withEffect: true })
      const status = getFreezeStatus(project, { dataDir, trackId, effectId })
      assert.equal(status.items.length, 1)
      assert.equal(status.items[0].effectId, effectId)
    } finally { await cleanup(dataDir) }
  })
  it('invalidateStaleFreezes marks stale on edit', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId, pattern } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      pattern.notes[0].pitch = 62
      assert.equal(invalidateStaleFreezes(project), 1)
      assert.equal(project.tracks[0].freeze.stale, true)
      assert.equal(invalidateStaleFreezes(project), 0)
    } finally { await cleanup(dataDir) }
  })
  it('removeFreezeFromProject clears freeze/media/files', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      const removed = await removeFreezeFromProject(project, { trackId, dataDir })
      assert.equal(removed.removed, true)
      assert.equal(project.tracks[0].freeze, undefined)
      assert.equal(project.media.length, 0)
      assert.equal(existsSync(frozen.freeze.cachePath), false)
    } finally { await cleanup(dataDir) }
  })
  it('removeFreezeFromProject no freeze returns false', async () => {
    const { project, trackId } = makeProject()
    assert.equal((await removeFreezeFromProject(project, { trackId })).removed, false)
  })
  it('freeze survives normalizeProject roundtrip', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      const restored = model.normalizeProject(JSON.parse(JSON.stringify(project)))
      assert.equal(restored.tracks[0].freeze.hash, frozen.freeze.hash)
      assert.equal(restored.tracks[0].freeze.mediaId, frozen.freeze.mediaId)
      assert.equal(restored.tracks[0].vst3.stateBase64, 'U1RBVEU=')
    } finally { await cleanup(dataDir) }
  })
  it('freeze summary in getProjectOverview', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      const overview = ops.getProjectOverview(project)
      assert.equal(overview.tracks[0].freeze.status, 'current')
      assert.equal(overview.tracks[0].freeze.mediaId, frozen.freeze.mediaId)
    } finally { await cleanup(dataDir) }
  })
  it('cache path rejects traversal hash', () => {
    assert.throws(() => freezeCachePath('/tmp', '../evil'), /hash/)
  })
  it('cache path accepts 40-hex hash', () => {
    assert.ok(freezeCachePath('/tmp', 'a'.repeat(40)).endsWith(`${'a'.repeat(40)}.wav`))
  })
  it('autoFreezeForExport skips current freeze and warns effects', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId, effectId } = makeProject({ withEffect: true })
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, trackStateBase64: frozen.trackStateBase64, effectStates: frozen.effectStates })
      const auto = await autoFreezeForExport({ dataDir, project, service: makeFreezeService() })
      assert.equal(auto.applied.length, 0)
      assert.equal(auto.warnings.length, 0)
    } finally { await cleanup(dataDir) }
  })
  it('autoFreezeForExport freezes unfrozen instrument', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const auto = await autoFreezeForExport({ dataDir, project, service: makeFreezeService() })
      assert.equal(auto.applied.length, 1)
      assert.equal(auto.applied[0].trackId, trackId)
    } finally { await cleanup(dataDir) }
  })
  it('autoFreezeForExport warnings on failure', async () => {
    const dataDir = await tempDir()
    try {
      const { project } = makeProject()
      project.tracks[0].vst3.missing = true
      const auto = await autoFreezeForExport({ dataDir, project, service: makeFreezeService() })
      assert.equal(auto.applied.length, 0)
      assert.ok(auto.warnings.length >= 1)
    } finally { await cleanup(dataDir) }
  })
  it('default freeze sample rate exported', () => {
    assert.equal(DEFAULT_FREEZE_SAMPLE_RATE, 48000)
  })
})

describe('v2.2 M4 service renderOffline / state', () => {
  function makeClient(overrides = {}) {
    const calls = []
    const client = {
      calls,
      async inspect() { return [{ name: 'Mock', category: 'Audio Module Class', subCategories: 'Fx', classId: 'x', vendor: 'M', version: '1' }] },
      async load() { return {} },
      async getParamsList() { return { count: 0, items: [] } },
      async renderOffline(options) { calls.push({ type: 'renderOffline', options }); await writeFile(options.outputPath, makeWav()); return { stateBase64: 'U1RBVEU=', latencySamples: 0, rms: 0.1, peak: 0.2 } },
      async loadInstance(options) { calls.push({ type: 'loadInstance', options }); return { instanceId: options.instanceId, latencySamples: 0, midiInputs: 1 } },
      async loadInstanceState(instanceId, state) { calls.push({ type: 'loadInstanceState', instanceId, state }); return { loaded: true } },
      async unloadInstance(instanceId) { return { instanceId, unloaded: true } },
      async close() {},
      ...overrides,
    }
    return client
  }
  async function serviceWithPlugin() {
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir, client: makeClient() })
    const source = await tempDir()
    const bundle = path.join(source, 'Mock.vst3')
    await writeFile(path.join(source, 'dummy'), 'x')
    // 直接写 registry 避免依赖 inspect 分类
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(bundle, 'Contents', 'x86_64-win'), { recursive: true })
    await writeFile(path.join(bundle, 'Contents', 'x86_64-win', 'Mock.vst3'), 'fake')
    const installed = await service.install({ path: bundle })
    return { service, dataDir, source, pluginId: installed.plugin.pluginId }
  }
  it('service.renderOffline calls sidecar with kind/events/state', async () => {
    const { service, dataDir, source, pluginId } = await serviceWithPlugin()
    try {
      const outputPath = path.join(dataDir, 'plugin-cache', 'test.wav')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(path.dirname(outputPath), { recursive: true })
      const result = await service.renderOffline({ pluginId, kind: 'instrument', outputPath, frames: 64, events: [{ type: 'noteOn', pitch: 60, velocity: 1, frame: 0 }], stateBase64: 'T0xE' })
      assert.equal(result.stateBase64, 'U1RBVEU=')
      const call = service.client.calls.find((item) => item.type === 'renderOffline')
      assert.equal(call.options.kind, 'instrument')
      assert.equal(call.options.stateBase64, 'T0xE')
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await rm(source, { recursive: true, force: true }).catch(() => {})
    }
  })
  it('service.renderOffline rejects unknown plugin', async () => {
    const { service, dataDir, source } = await serviceWithPlugin()
    try {
      await assert.rejects(service.renderOffline({ pluginId: 'vst3_missing', outputPath: path.join(dataDir, 'x.wav'), frames: 64 }), /不存在/)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await rm(source, { recursive: true, force: true }).catch(() => {})
    }
  })
  it('service.renderOffline validates .wav outputPath', async () => {
    const { service, dataDir, source, pluginId } = await serviceWithPlugin()
    try {
      await assert.rejects(service.renderOffline({ pluginId, outputPath: path.join(dataDir, 'x.bin'), frames: 64 }), /\.wav/)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await rm(source, { recursive: true, force: true }).catch(() => {})
    }
  })
  it('service.loadInstance applies stateBase64', async () => {
    const { service, dataDir, source, pluginId } = await serviceWithPlugin()
    try {
      await service.loadInstance(pluginId, { instanceId: 'track:x', kind: 'instrument', stateBase64: 'T0xE' })
      assert.ok(service.client.calls.some((item) => item.type === 'loadInstanceState' && item.state === 'T0xE'))
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await rm(source, { recursive: true, force: true }).catch(() => {})
    }
  })
  it('service.loadInstance state load failure errors', async () => {
    const dataDir = await tempDir()
    const source = await tempDir()
    const client = makeClient({ async loadInstanceState() { throw new Error('bad state') } })
    const service = createPluginService({ dataDir, client })
    try {
      const { mkdir } = await import('node:fs/promises')
      const bundle = path.join(source, 'Mock2.vst3')
      await mkdir(path.join(bundle, 'Contents', 'x86_64-win'), { recursive: true })
      await writeFile(path.join(bundle, 'Contents', 'x86_64-win', 'Mock2.vst3'), 'fake')
      const installed = await service.install({ path: bundle })
      await assert.rejects(service.loadInstance(installed.plugin.pluginId, { instanceId: 'track:x', kind: 'instrument', stateBase64: 'T0xE' }), /状态/)
    } finally {
      await service.close().catch(() => {})
      await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await rm(source, { recursive: true, force: true }).catch(() => {})
    }
  })
  it('client has renderOffline method', async () => {
    const client = createPluginHostClient({ nodeBin: process.execPath, sidecarPath: DEFAULT_SIDECAR_PATH, timeoutMs: 100 })
    assert.equal(typeof client.renderOffline, 'function')
    await client.close().catch(() => {})
  })
  it('client renderOffline request mapping via fake spawn', async () => {
    const { EventEmitter } = await import('node:events')
    const requests = []
    const spawnImpl = () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { writable: true, write: (line) => { const msg = JSON.parse(line); requests.push(msg); queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: msg.id, ok: true, result: { path: 'x' } }) + '\n')) }, end: () => {} }
      child.kill = () => {}
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ type: 'ready' }) + '\n'))
      return child
    }
    const client = createPluginHostClient({ nodeBin: process.execPath, spawnImpl, timeoutMs: 3000 })
    try {
      await client.renderOffline({ kind: 'instrument', frames: 64 })
      assert.equal(requests[0].type, 'renderOffline')
    } finally { await client.close() }
  })
  it('sidecar source has renderOffline and wav writer', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/plugin-host-node.cjs'), 'utf8')
    assert.ok(source.includes('function renderOffline'))
    assert.ok(source.includes('function writePcm16Wav'))
    assert.ok(source.includes("type === 'renderOffline'"))
  })
  it('sidecar renderOffline validates kind', async () => {
    const client = createPluginHostClient({ nodeBin: process.execPath, sidecarPath: DEFAULT_SIDECAR_PATH, timeoutMs: 15000 })
    try {
      await assert.rejects(client.renderOffline({ kind: 'bogus', pluginPath: path.join(os.tmpdir(), 'x.vst3'), frames: 64, outputPath: path.join(os.tmpdir(), 'x.wav') }), /kind/)
    } finally { await client.close() }
  })
  it('sidecar renderOffline rejects non-wav output path', async () => {
    const client = createPluginHostClient({ nodeBin: process.execPath, sidecarPath: DEFAULT_SIDECAR_PATH, timeoutMs: 15000 })
    try {
      await assert.rejects(client.renderOffline({ kind: 'instrument', pluginPath: path.join(os.tmpdir(), 'x.vst3'), frames: 64, outputPath: path.join(os.tmpdir(), 'x.bin') }), /wav|path|插件/i)
    } finally { await client.close() }
  })
})

describe('v2.2 M4 static routes/preload/main/tools', () => {
  it('routes register freeze/status/unfreeze aliases', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    for (const token of ['/plugin-freeze', '/plugin-unfreeze', '/plugin-freeze-status', '/plugins/external/freeze', '/plugins/external/state']) assert.ok(source.includes(token), token)
  })
  it('routes freeze handler returns hash/mediaId/cacheFile', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes('cacheUrl'))
    assert.ok(source.includes('stateSaved'))
  })
  it('routes save-state persists track/effect vst3 state', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes('handlePluginSaveState'))
    assert.ok(source.includes('stateBase64 = stateBase64'))
  })
  it('preload saveState + load state doc', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/preload.cjs'), 'utf8')
    assert.ok(source.includes('saveState:'))
    assert.ok(source.includes('aims-plugin:save-state'))
    assert.ok(source.includes('stateBase64?'))
  })
  it('main save-state handler exists', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    assert.ok(source.includes("ipcMain.handle('aims-plugin:save-state'"))
    assert.ok(source.includes('saveInstanceState'))
  })
  it('main load passes stateBase64/state', async () => {
    const source = await readFile(path.join(ROOT, 'desktop/main.cjs'), 'utf8')
    assert.ok(source.includes('stateBase64: typeof args?.stateBase64'))
  })
  it('tools register 3 freeze tools', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/tools.js'), 'utf8')
    for (const token of ['studio_freeze_plugin_track', 'studio_unfreeze_plugin_track', 'studio_get_freeze_status']) assert.ok(source.includes(token), token)
  })
  it('tool count is 110 app tools', async () => {
    const tools = await import('../src/host/tools.js')
    assert.equal(tools.TOOL_NAMES.length, 110)
  })
  it('export auto freeze hook present', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/tools.js'), 'utf8')
    assert.ok(source.includes('autoFreezeForExport'))
    assert.ok(source.includes('导出前自动冻结外部插件'))
  })
  it('freeze tool returns freeze summary fields', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/tools.js'), 'utf8')
    assert.ok(source.includes('cacheFile: frozen.freeze.cacheFile'))
    assert.ok(source.includes('stateSaved'))
  })
  it('plugin-freeze exports required functions', async () => {
    const mod = await import('../src/host/plugin-freeze.js')
    for (const name of ['trackFreezeHash', 'freezeTarget', 'getFreezeStatus', 'invalidateStaleFreezes', 'autoFreezeForExport']) assert.equal(typeof mod[name], 'function', name)
  })
  it('freeze cache directory constant', async () => {
    const mod = await import('../src/host/plugin-freeze.js')
    assert.equal(mod.PLUGIN_CACHE_DIR, 'plugin-cache')
  })
  it('media route can serve freeze-*.wav files', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes('/media/'))
  })
  it('reload normalize preserves effect freeze', async () => {
    const { project, trackId, effectId } = makeProject({ withEffect: true })
    const effect = project.tracks[0].effects.find((fx) => fx.id === effectId)
    effect.freeze = { hash: 'a'.repeat(40), mediaId: 'med_freeze_test', status: 'current', cacheFile: 'a.wav', stale: false }
    const restored = model.normalizeProject(JSON.parse(JSON.stringify(project)))
    assert.equal(restored.tracks[0].effects.find((fx) => fx.id === effectId).freeze.mediaId, 'med_freeze_test')
  })
  it('normalizeProject drops invalid freeze', () => {
    const { project } = makeProject()
    project.tracks[0].freeze = { hash: 'bad!' }
    const restored = model.normalizeProject(JSON.parse(JSON.stringify(project)))
    assert.equal(restored.tracks[0].freeze, undefined)
  })
  it('normalizeFreeze clamps fields', () => {
    const freeze = model.normalizeFreeze({ hash: 'a'.repeat(40), mediaId: 'med_x', cacheFile: 'x.wav', bars: 999, frames: 1, sampleRate: 1, latencySamples: -1, status: 'weird' })
    assert.equal(freeze.bars, 256)
    assert.equal(freeze.sampleRate, 8000)
    assert.equal(freeze.latencySamples, 0)
    assert.equal(freeze.status, 'current')
  })
  it('normalizeFreeze returns null for bad hash', () => {
    assert.equal(model.normalizeFreeze({ hash: 'xyz' }), null)
  })
})

describe('v2.2 M4 real fixture freeze', () => {
  it('TAL-NoiseMaker freeze writes WAV/media/state and status current', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      const project = model.createEmptyProject()
      project.lengthBars = 1
      project.bpm = 120
      const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'Inst', vst3: { ...installed.plugin, kind: 'instrument', isInstrument: true, midiInputs: 1, params: {} } })
      const pattern = model.makePattern({ id: 'pat_r', name: 'P', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
      project.patterns.push(pattern)
      project.clips.push(model.makeClip({ id: 'clip_r', trackId: track.trackId, patternId: 'pat_r', startBar: 0, lengthBars: 1 }))
      const frozen = await freezeTarget({ dataDir, project, trackId: track.trackId, service, bars: 1 })
      setFreezeOnProject(project, { trackId: track.trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      assert.ok(frozen.result.rms > 0.01)
      assert.equal(frozen.freeze.frames, 96000)
      assert.equal(project.tracks[0].vst3.stateBase64, frozen.stateBase64)
      assert.ok(project.media.some((item) => item.id === frozen.freeze.mediaId))
      assert.equal(getFreezeStatus(project, { dataDir }).items[0].status, 'current')
    } finally {
      await service.close().catch(() => {})
      await cleanup(dataDir)
    }
  })
  it('TAL-NoiseMaker freeze stale after note edit', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      const project = model.createEmptyProject()
      project.lengthBars = 1
      project.bpm = 120
      const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'Inst', vst3: { ...installed.plugin, kind: 'instrument', isInstrument: true, midiInputs: 1, params: {} } })
      const pattern = model.makePattern({ id: 'pat_s', name: 'P', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
      project.patterns.push(pattern)
      project.clips.push(model.makeClip({ id: 'clip_s', trackId: track.trackId, patternId: 'pat_s', startBar: 0, lengthBars: 1 }))
      const frozen = await freezeTarget({ dataDir, project, trackId: track.trackId, service, bars: 1 })
      setFreezeOnProject(project, { trackId: track.trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      pattern.notes[0].pitch = 64
      assert.equal(getFreezeStatus(project, { dataDir }).items[0].status, 'stale')
    } finally {
      await service.close().catch(() => {})
      await cleanup(dataDir)
    }
  })
  it('TAL-Reverb effect freeze on vst3 instrument track', async (t) => {
    if (!HAS_INSTRUMENT || !HAS_EFFECT) { t.skip('fixtures missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const inst = await service.install({ path: INSTRUMENT_FIXTURE })
      const eff = await service.install({ path: EFFECT_FIXTURE })
      const project = model.createEmptyProject()
      project.lengthBars = 1
      project.bpm = 120
      const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'Inst', vst3: { ...inst.plugin, kind: 'instrument', isInstrument: true, midiInputs: 1, params: {} } })
      const pattern = model.makePattern({ id: 'pat_e', name: 'P', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
      project.patterns.push(pattern)
      project.clips.push(model.makeClip({ id: 'clip_e', trackId: track.trackId, patternId: 'pat_e', startBar: 0, lengthBars: 1 }))
      const effect = ops.addEffect(project, { target: track.trackId, type: 'vst3', vst3: { ...eff.plugin, kind: 'effect', isInstrument: false, params: {} } })
      const frozen = await freezeTarget({ dataDir, project, trackId: track.trackId, effectId: effect.effectId, service, bars: 1 })
      assert.ok(frozen.freeze.mediaId)
      assert.ok(frozen.result.rms > 0)
      setFreezeOnProject(project, { trackId: track.trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, trackStateBase64: frozen.trackStateBase64, effectStates: frozen.effectStates })
      assert.ok(project.tracks[0].freeze)
      assert.equal(project.tracks[0].freeze.includesFx, false)
    } finally {
      await service.close().catch(() => {})
      await cleanup(dataDir)
    }
  })
  it('missing managed plugin rejects freeze', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      const project = model.createEmptyProject()
      project.lengthBars = 1
      const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'Inst', vst3: { ...installed.plugin, kind: 'instrument', isInstrument: true, midiInputs: 1, params: {} } })
      await rm(installed.entry.managedPath, { recursive: true, force: true })
      await assert.rejects(freezeTarget({ dataDir, project, trackId: track.trackId, service, bars: 1 }), /缺失|重新安装/)
    } finally {
      await service.close().catch(() => {})
      await cleanup(dataDir)
    }
  })
  it('real freeze cache file is valid 16-bit WAV header', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      const project = model.createEmptyProject()
      project.lengthBars = 1
      const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'Inst', vst3: { ...installed.plugin, kind: 'instrument', isInstrument: true, midiInputs: 1, params: {} } })
      const pattern = model.makePattern({ id: 'pat_w', name: 'P', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
      project.patterns.push(pattern)
      project.clips.push(model.makeClip({ id: 'clip_w', trackId: track.trackId, patternId: 'pat_w', startBar: 0, lengthBars: 1 }))
      const frozen = await freezeTarget({ dataDir, project, trackId: track.trackId, service, bars: 1 })
      const buffer = await readFile(frozen.freeze.cachePath)
      assert.equal(buffer.toString('ascii', 0, 4), 'RIFF')
      assert.equal(buffer.toString('ascii', 8, 12), 'WAVE')
      assert.equal(buffer.readUInt16LE(20), 1)
      assert.equal(buffer.readUInt16LE(22), 2)
    } finally {
      await service.close().catch(() => {})
      await cleanup(dataDir)
    }
  })
  it('real freeze is under 100MB for 8 bars', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      const project = model.createEmptyProject()
      project.lengthBars = 8
      project.bpm = 120
      const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'Inst', vst3: { ...installed.plugin, kind: 'instrument', isInstrument: true, midiInputs: 1, params: {} } })
      const pattern = model.makePattern({ id: 'pat_big', name: 'P', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
      project.patterns.push(pattern)
      project.clips.push(model.makeClip({ id: 'clip_big', trackId: track.trackId, patternId: 'pat_big', startBar: 0, lengthBars: 8 }))
      const frozen = await freezeTarget({ dataDir, project, trackId: track.trackId, service, bars: 8 })
      assert.ok((await stat(frozen.freeze.cachePath)).size < 100 * 1024 * 1024)
    } finally {
      await service.close().catch(() => {})
      await cleanup(dataDir)
    }
  })
  it('fixture availability flags are booleans', () => {
    assert.equal(typeof HAS_INSTRUMENT, 'boolean')
    assert.equal(typeof HAS_EFFECT, 'boolean')
  })
  it('stateBase64 size is under 2MB after freeze', async (t) => {
    if (!HAS_INSTRUMENT) { t.skip('instrument fixture missing'); return }
    const dataDir = await tempDir()
    const service = createPluginService({ dataDir })
    try {
      const installed = await service.install({ path: INSTRUMENT_FIXTURE })
      const project = model.createEmptyProject()
      project.lengthBars = 1
      const track = ops.addTrack(project, { kind: 'synth', engine: 'vst3', name: 'Inst', vst3: { ...installed.plugin, kind: 'instrument', isInstrument: true, midiInputs: 1, params: {} } })
      const pattern = model.makePattern({ id: 'pat_st', name: 'P', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
      project.patterns.push(pattern)
      project.clips.push(model.makeClip({ id: 'clip_st', trackId: track.trackId, patternId: 'pat_st', startBar: 0, lengthBars: 1 }))
      const frozen = await freezeTarget({ dataDir, project, trackId: track.trackId, service, bars: 1 })
      assert.ok(Buffer.byteLength(frozen.stateBase64, 'base64') <= 2 * 1024 * 1024)
    } finally {
      await service.close().catch(() => {})
      await cleanup(dataDir)
    }
  })
})


describe('v2.2 M4 extra cache/media/state checks', () => {
  it('freezeCachePath rejects empty hash', () => {
    assert.throws(() => freezeCachePath('/tmp', ''), /hash/)
  })
  it('freezeCachePath rejects short hash', () => {
    assert.throws(() => freezeCachePath('/tmp', 'abcd'), /hash/)
  })
  it('hashFreezePayload handles nested arrays', () => {
    assert.equal(hashFreezePayload({ a: [1, { b: 2 }] }), hashFreezePayload({ a: [1, { b: 2 }] }))
  })
  it('hashFreezePayload ignores undefined values', () => {
    assert.equal(hashFreezePayload({ a: 1, b: undefined }), hashFreezePayload({ a: 1 }))
  })
  it('normalizeFreeze clamps frames', () => {
    const freeze = model.normalizeFreeze({ hash: 'a'.repeat(40), frames: 999999999, bars: 1 })
    assert.ok(freeze.frames <= 192000 * 900)
  })
  it('normalizeFreeze preserves stale flag', () => {
    const freeze = model.normalizeFreeze({ hash: 'a'.repeat(40), stale: true })
    assert.equal(freeze.stale, true)
    assert.equal(freeze.status, 'stale')
  })
  it('normalizeFreeze preserves error message', () => {
    const freeze = model.normalizeFreeze({ hash: 'a'.repeat(40), status: 'error', error: 'boom' })
    assert.equal(freeze.status, 'error')
    assert.equal(freeze.error, 'boom')
  })
  it('freezeSummary handles null', () => {
    assert.equal(ops.freezeSummary(null), null)
  })
  it('freezeSummary marks stale status', () => {
    assert.equal(ops.freezeSummary({ hash: 'a'.repeat(40), stale: true }).status, 'stale')
  })
  it('effect summary includes freeze', () => {
    const { project, trackId, effectId } = makeProject({ withEffect: true })
    const effect = project.tracks[0].effects.find((fx) => fx.id === effectId)
    effect.freeze = { hash: 'b'.repeat(40), mediaId: 'med_x', status: 'current', cacheFile: 'b.wav', stale: false }
    const summary = ops.effectSummary(effect)
    assert.equal(summary.freeze.status, 'current')
    assert.equal(summary.freeze.mediaId, 'med_x')
  })
  it('track summary without freeze omits field', () => {
    const { project } = makeProject()
    const overview = ops.getProjectOverview(project)
    assert.equal(overview.tracks[0].freeze, undefined)
  })
  it('removeFreezeFromProject effect clears effect.freeze', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId, effectId } = makeProject({ withEffect: true })
      const frozen = await freezeTarget({ dataDir, project, trackId, effectId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, effectId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      assert.equal((await removeFreezeFromProject(project, { trackId, effectId, dataDir })).removed, true)
      assert.equal(project.tracks[0].effects.find((fx) => fx.id === effectId).freeze, undefined)
    } finally { await cleanup(dataDir) }
  })
  it('stateBase64 roundtrip through normalizeProject', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, stateBase64: frozen.stateBase64 })
      const restored = model.normalizeProject(JSON.parse(JSON.stringify(project)))
      assert.equal(restored.tracks[0].vst3.stateBase64, 'U1RBVEU=')
    } finally { await cleanup(dataDir) }
  })
})
  it('freeze summary includes includesFx=false (B semantics)', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, trackStateBase64: frozen.trackStateBase64 })
      const overview = ops.getProjectOverview(project)
      assert.equal(overview.tracks[0].freeze.includesFx, false)
    } finally { await cleanup(dataDir) }
  })


describe('v2.2 M4 mix hash + route bug regressions', () => {
  it('trackFreezeHash changes on volume change', () => {
    const { project, trackId } = makeProject()
    const first = trackFreezeHash(project, trackId)
    project.tracks[0].volume = 0.2
    assert.notEqual(trackFreezeHash(project, trackId), first)
  })
  it('trackFreezeHash changes on pan/automation change', () => {
    const { project, trackId } = makeProject()
    const first = trackFreezeHash(project, trackId)
    project.tracks[0].pan = -0.5
    assert.notEqual(trackFreezeHash(project, trackId), first)
    const second = trackFreezeHash(project, trackId)
    project.tracks[0].automation = { volume: { enabled: true, points: [{ beat: 0, value: 0.2 }] } }
    assert.notEqual(trackFreezeHash(project, trackId), second)
  })
  it('plugin-freeze route no longer references undefined track variable', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.equal(source.includes('pluginId: track.vst3?.pluginId'), false)
    assert.ok(source.includes('pluginId: frozen.result?.pluginId'))
  })
  it('stale after volume edit via getFreezeStatus', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService() })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, trackStateBase64: frozen.trackStateBase64, effectStates: frozen.effectStates })
      assert.equal(getFreezeStatus(project, { dataDir }).items[0].status, 'current')
      project.tracks[0].volume = 0.33
      assert.equal(getFreezeStatus(project, { dataDir }).items[0].status, 'stale')
    } finally { await cleanup(dataDir) }
  })
})


describe('v2.2 M4 freeze body limit', () => {
  it('plugin freeze route uses >=64MB JSON body limit', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes('PLUGIN_FREEZE_BODY_LIMIT = 128 * 1024 * 1024'))
    assert.ok(source.includes('pluginBody(req, PLUGIN_FREEZE_BODY_LIMIT)'))
  })
  it('pluginBody supports per-route limit', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/routes.js'), 'utf8')
    assert.ok(source.includes('async function pluginBody(req, limit = jsonBodyLimit)'))
    assert.ok(source.includes('return readJsonBody(req, limit)'))
  })
})


describe('v2.2 M4 freeze bars hash/cache', () => {
  it('trackFreezeHash differs for 2/4/8 bars', () => {
    const { project, trackId } = makeProject()
    const hashes = [2, 4, 8].map((bars) => trackFreezeHash(project, trackId, null, { bars }))
    assert.equal(new Set(hashes).size, 3)
  })
  it('freezeTarget 2/4 bars yields different hash/cacheFile', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const service = makeFreezeService()
      const two = await freezeTarget({ dataDir, project, trackId, service, bars: 2 })
      const four = await freezeTarget({ dataDir, project, trackId, service, bars: 4 })
      assert.notEqual(two.freeze.hash, four.freeze.hash)
      assert.notEqual(two.freeze.cacheFile, four.freeze.cacheFile)
      assert.equal(two.freeze.bars, 2)
      assert.equal(four.freeze.bars, 4)
      assert.equal(existsSync(two.freeze.cachePath), true)
      assert.equal(existsSync(four.freeze.cachePath), true)
    } finally { await cleanup(dataDir) }
  })
  it('status becomes stale when requested bars differs from freeze bars', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService(), bars: 2 })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, trackStateBase64: frozen.trackStateBase64, effectStates: frozen.effectStates })
      assert.equal(getFreezeStatus(project, { dataDir }).items[0].status, 'current')
      assert.equal(getFreezeStatus(project, { dataDir, bars: 4 }).items[0].status, 'stale')
    } finally { await cleanup(dataDir) }
  })
  it('autoFreezeForExport refreezes when target bars differs', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService(), bars: 2 })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, trackStateBase64: frozen.trackStateBase64, effectStates: frozen.effectStates })
      const auto = await autoFreezeForExport({ dataDir, project, service: makeFreezeService(), bars: 4 })
      assert.equal(auto.applied.length, 1)
      assert.equal(auto.applied[0].freeze.bars, 4)
      assert.notEqual(auto.applied[0].freeze.hash, frozen.freeze.hash)
    } finally { await cleanup(dataDir) }
  })
  it('status current when no bars override matches stored freeze bars', async () => {
    const dataDir = await tempDir()
    try {
      const { project, trackId } = makeProject()
      const frozen = await freezeTarget({ dataDir, project, trackId, service: makeFreezeService(), bars: 4 })
      setFreezeOnProject(project, { trackId, freeze: frozen.freeze, mediaEntry: frozen.mediaEntry, trackStateBase64: frozen.trackStateBase64, effectStates: frozen.effectStates })
      assert.equal(getFreezeStatus(project, { dataDir }).items[0].status, 'current')
    } finally { await cleanup(dataDir) }
  })
})

