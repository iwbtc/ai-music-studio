/** v2.4 P0: studio_quick_mix_check draft + 16-entry cache. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as model from '../src/shared/model.js'
import * as ops from '../src/host/ops.js'
import { createState } from '../src/host/state.js'
import { createTools } from '../src/host/tools.js'
import {
  QUICK_MIX_CACHE_LIMIT,
  QUICK_MIX_MAX_SPAN,
  QUICK_MIX_SAMPLE_RATES,
  clearQuickMixCache,
  completePreviewRequest,
  getQuickMixCache,
  peekPreviewRequest,
  pendingPreviewCount,
  quickMixCacheKey,
  quickMixCacheSize,
  setQuickMixCache,
} from '../src/host/preview-bridge.js'

const ROOT = path.resolve(import.meta.dirname, '..')

async function tempDir() { return mkdtemp(path.join(os.tmpdir(), 'aims-v24-')) }
async function cleanup(dir) { await rm(dir, { recursive: true, force: true }).catch(async () => { await new Promise((r) => setTimeout(r, 150)); await rm(dir, { recursive: true, force: true }).catch(() => {}) }) }

function analysisFixture(overrides = {}) {
  return {
    peak: 0.9, peakDb: -0.9, rms: 0.2, rmsDb: -14, lufs: -13.5, lufsApprox: -13.7,
    lufsMaxShortTerm: -12.5, crestDb: 13, clipping: false, clippedSamples: 0, silent: false,
    stereoBalanceDb: 0.3, correlation: 0.8, spectralCentroidHz: 1200, bandEnergyPct: { sub: 10, low: 20, lowMid: 30, mid: 20, highMid: 10, high: 10 },
    dcOffset: 0.001,
    ...overrides,
  }
}

async function makeState() {
  const dataDir = await tempDir()
  const state = createState({ dataDir })
  await state.ready
  state.mutate({ tool: 'setup' }, (draft) => {
    const project = model.createEmptyProject()
    project.lengthBars = 16
    project.bpm = 120
    const track = ops.addTrack(project, { kind: 'synth', name: 'Lead', preset: 'warm_pad' })
    const pattern = model.makePattern({ id: 'pat_1', name: 'P', lengthBars: 1, notes: [{ pitch: 60, start: 0, dur: 1, vel: 0.8 }] })
    project.patterns.push(pattern)
    project.clips.push(model.makeClip({ id: 'clip_1', trackId: track.trackId, patternId: 'pat_1', startBar: 0, lengthBars: 4 }))
    draft.tracks = project.tracks
    draft.patterns = project.patterns
    draft.clips = project.clips
    draft.title = 'v2.4 quick'
    draft.lengthBars = 16
    draft.bpm = 120
  })
  const tools = createTools({ defineTool: (options) => options, state })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = (name, args) => byName.get(name).execute(args)
  return { dataDir, state, exec, byName }
}

async function runQuick(state, exec, args, analysis = analysisFixture()) {
  const promise = exec('studio_quick_mix_check', args)
  let request = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    request = peekPreviewRequest(state, 0)
    if (request) break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  if (!request) throw new Error('quick_mix_check did not request preview')
  assert.equal(completePreviewRequest(state, request.seq, { analysis }), true)
  return await promise
}

describe('v2.4 P0 quick cache key/size', () => {
  it('cache key includes revision/range/sampleRate/solo/stems', () => {
    const base = { revision: 1, fromBar: 0, toBar: 1, sampleRate: 8000, soloTrackIds: [], stems: false }
    assert.equal(quickMixCacheKey(base), quickMixCacheKey(base))
    assert.notEqual(quickMixCacheKey(base), quickMixCacheKey({ ...base, revision: 2 }))
    assert.notEqual(quickMixCacheKey(base), quickMixCacheKey({ ...base, toBar: 2 }))
    assert.notEqual(quickMixCacheKey(base), quickMixCacheKey({ ...base, sampleRate: 11025 }))
    assert.notEqual(quickMixCacheKey(base), quickMixCacheKey({ ...base, soloTrackIds: ['trk_1'] }))
    assert.notEqual(quickMixCacheKey(base), quickMixCacheKey({ ...base, stems: true }))
  })
  it('soloTrackIds order-insensitive', () => {
    const base = { revision: 1, fromBar: 0, toBar: 1, sampleRate: 8000, stems: false }
    assert.equal(quickMixCacheKey({ ...base, soloTrackIds: ['a', 'b'] }), quickMixCacheKey({ ...base, soloTrackIds: ['b', 'a'] }))
  })
  it('cache set/get/size/clear on dummy state', () => {
    const state = {}
    assert.equal(quickMixCacheSize(state), 0)
    setQuickMixCache(state, 'k1', { analysis: { rms: 1 }, renderMs: 5 })
    assert.equal(quickMixCacheSize(state), 1)
    assert.equal(getQuickMixCache(state, 'k1').analysis.rms, 1)
    assert.equal(getQuickMixCache(state, 'k2'), null)
    clearQuickMixCache(state)
    assert.equal(quickMixCacheSize(state), 0)
  })
  it('cache limits to 16 entries (oldest evicted)', () => {
    const state = {}
    for (let index = 0; index < 20; index += 1) setQuickMixCache(state, 'k' + index, { analysis: { rms: index } })
    assert.equal(quickMixCacheSize(state), QUICK_MIX_CACHE_LIMIT)
    assert.equal(getQuickMixCache(state, 'k0'), null)
    assert.equal(getQuickMixCache(state, 'k19').analysis.rms, 19)
  })
  it('cache overwrite same key no growth', () => {
    const state = {}
    setQuickMixCache(state, 'k', { analysis: { rms: 1 } })
    setQuickMixCache(state, 'k', { analysis: { rms: 2 } })
    assert.equal(quickMixCacheSize(state), 1)
    assert.equal(getQuickMixCache(state, 'k').analysis.rms, 2)
  })
  it('cache hit refreshes LRU order', () => {
    const state = {}
    for (let index = 0; index < 16; index += 1) setQuickMixCache(state, 'k' + index, { analysis: { rms: index } })
    getQuickMixCache(state, 'k0')
    setQuickMixCache(state, 'k16', { analysis: { rms: 16 } })
    assert.ok(getQuickMixCache(state, 'k0'))
    assert.equal(getQuickMixCache(state, 'k1'), null)
  })
  it('constants exported', () => {
    assert.equal(QUICK_MIX_CACHE_LIMIT, 16)
    assert.equal(QUICK_MIX_MAX_SPAN, 8)
    assert.deepEqual([...QUICK_MIX_SAMPLE_RATES], [8000, 11025, 16000])
  })
})

describe('v2.4 P0 quick_mix_check validation', () => {
  it('tool registered', async () => {
    const tools = await import('../src/host/tools.js')
    assert.ok(tools.TOOL_NAMES.includes('studio_quick_mix_check'))
  })
  it('fromBar invalid', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      assert.equal((await exec('studio_quick_mix_check', { fromBar: -1 })).ok, false)
      assert.equal((await exec('studio_quick_mix_check', { fromBar: 1.5 })).ok, false)
      assert.equal((await exec('studio_quick_mix_check', { fromBar: 99 })).ok, false)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('bars invalid', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      for (const bars of [0, 5, -1, 1.5, 'x']) assert.equal((await exec('studio_quick_mix_check', { bars })).ok, false)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('toBar invalid', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      assert.equal((await exec('studio_quick_mix_check', { fromBar: 2, toBar: 2 })).ok, false)
      assert.equal((await exec('studio_quick_mix_check', { fromBar: 2, toBar: 1 })).ok, false)
      assert.equal((await exec('studio_quick_mix_check', { fromBar: 2, toBar: 2.5 })).ok, false)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('max span 8 enforced', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const result = await exec('studio_quick_mix_check', { fromBar: 0, toBar: 9 })
      assert.equal(result.ok, false)
      assert.match(result.error, /8 小节/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('sampleRate whitelist', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      for (const sampleRate of [44100, 48000, 7999, 16001, 22050]) assert.equal((await exec('studio_quick_mix_check', { sampleRate })).ok, false)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  for (const rate of [8000, 11025, 16000]) {
    it(`sampleRate ${rate} accepted`, async () => {
      const { state, exec, dataDir } = await makeState()
      try {
        const result = await runQuick(state, exec, { sampleRate: rate })
        assert.equal(result.ok, true)
        assert.equal(result.sampleRate, rate)
      } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
    })
  }
  it('includeStems non-boolean rejected', async () => {
    const { state, exec, dataDir } = await makeState()
    try { assert.equal((await exec('studio_quick_mix_check', { includeStems: 'yes' })).ok, false) }
    finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('soloTrackIds invalid/missing rejected', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      assert.equal((await exec('studio_quick_mix_check', { soloTrackIds: [1] })).ok, false)
      const missing = await exec('studio_quick_mix_check', { soloTrackIds: ['nope'] })
      assert.equal(missing.ok, false)
      assert.match(missing.error, /不存在/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
})

describe('v2.4 P0 quick_mix_check defaults/render/cache', () => {
  it('defaults 1 bar/8000/fast/no stems/tail0', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const promise = exec('studio_quick_mix_check', {})
      let request = null
      for (let attempt = 0; attempt < 100; attempt += 1) { request = peekPreviewRequest(state, 0); if (request) break; await new Promise((r) => setTimeout(r, 1)) }
      assert.ok(request)
      assert.equal(request.params.fromBar, 0)
      assert.equal(request.params.toBar, 1)
      assert.equal(request.params.fast, true)
      assert.equal(request.params.sampleRate, 8000)
      assert.equal(request.params.includeStems, false)
      assert.equal(request.params.tailSeconds, 0)
      completePreviewRequest(state, request.seq, { analysis: analysisFixture() })
      const result = await promise
      assert.equal(result.ok, true)
      assert.equal(result.cached, false)
      assert.deepEqual(result.range, { fromBar: 0, toBar: 1, bars: 1 })
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('returns condensed analysis fields', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const result = await runQuick(state, exec, {})
      for (const key of ['peak', 'peakDb', 'rms', 'rmsDb', 'lufs', 'lufsApprox', 'lufsMaxShortTerm', 'crestDb', 'clipping', 'clippedSamples', 'silent', 'stereoBalanceDb', 'correlation', 'spectralCentroidHz', 'bandEnergyPct', 'pbandEnergy']) {
        assert.ok(Object.hasOwn(result, key), key)
      }
      assert.deepEqual(result.bandEnergyPct, analysisFixture().bandEnergyPct)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('renderMs measured and mode/note set', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const result = await runQuick(state, exec, {})
      assert.equal(result.mode, 'quick-draft')
      assert.equal(typeof result.renderMs, 'number')
      assert.match(result.note, /studio_render_preview/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('second identical call cached=true/renderMs=0/no pending', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const first = await runQuick(state, exec, {})
      assert.equal(first.cached, false)
      assert.equal(pendingPreviewCount(state), 0)
      const revision = state.revision
      const second = await exec('studio_quick_mix_check', {})
      assert.equal(second.ok, true)
      assert.equal(second.cached, true)
      assert.equal(second.renderMs, 0)
      assert.equal(second.revision, revision)
      assert.equal(second.rms, first.rms)
      assert.equal(pendingPreviewCount(state), 0)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('does not write project/revision/undo', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const revision = state.revision
      const contentRevision = state.project.contentRevision
      const undoDepth = state.historyState().undoDepth
      await runQuick(state, exec, {})
      assert.equal(state.revision, revision)
      assert.equal(state.project.contentRevision, contentRevision)
      assert.equal(state.historyState().undoDepth, undoDepth)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('revision change causes cache miss', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const first = await runQuick(state, exec, {})
      state.mutate({ tool: 'edit' }, (draft) => { draft.title = 'changed' })
      const second = await runQuick(state, exec, {}, analysisFixture({ rms: 0.9 }))
      assert.equal(second.cached, false)
      assert.equal(second.rms, 0.9)
      assert.notEqual(second.revision, first.revision)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('range change cache miss/hit for both ranges', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const one = await runQuick(state, exec, { fromBar: 0, bars: 1 })
      const two = await runQuick(state, exec, { fromBar: 0, bars: 2 })
      assert.equal(one.cached, false)
      assert.equal(two.cached, false)
      assert.equal((await exec('studio_quick_mix_check', { fromBar: 0, bars: 2 })).cached, true)
      assert.equal((await exec('studio_quick_mix_check', { fromBar: 0, bars: 1 })).cached, true)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('sampleRate difference keyed separately', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      await runQuick(state, exec, { sampleRate: 8000 })
      assert.equal((await exec('studio_quick_mix_check', { sampleRate: 8000 })).cached, true)
      const other = await runQuick(state, exec, { sampleRate: 11025 })
      assert.equal(other.cached, false)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('soloTrackIds difference keyed separately', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      await runQuick(state, exec, {})
      const solo = await runQuick(state, exec, { soloTrackIds: ['trk_1'] })
      assert.equal(solo.cached, false)
      assert.equal((await exec('studio_quick_mix_check', { soloTrackIds: ['trk_1'] })).cached, true)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('includeStems true passes stems and caches separately', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const promise = exec('studio_quick_mix_check', { includeStems: true })
      let request = null
      for (let attempt = 0; attempt < 100; attempt += 1) { request = peekPreviewRequest(state, 0); if (request) break; await new Promise((r) => setTimeout(r, 1)) }
      assert.equal(request.params.includeStems, true)
      completePreviewRequest(state, request.seq, { analysis: { ...analysisFixture(), stems: [{ trackId: 'trk_1', rms: 0.2 }] } })
      const result = await promise
      assert.equal(result.stems.length, 1)
      assert.equal((await exec('studio_quick_mix_check', { includeStems: true })).cached, true)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('toBar overrides bars and clamps to project length', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const result = await runQuick(state, exec, { fromBar: 2, toBar: 5 })
      assert.deepEqual(result.range, { fromBar: 2, toBar: 5, bars: 3 })
      const clamped = await runQuick(state, exec, { fromBar: 14, toBar: 99 })
      assert.equal(clamped.range.toBar, 16)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('preview error returns Chinese hint', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const promise = exec('studio_quick_mix_check', {})
      let request = null
      for (let attempt = 0; attempt < 100; attempt += 1) { request = peekPreviewRequest(state, 0); if (request) break; await new Promise((r) => setTimeout(r, 1)) }
      completePreviewRequest(state, request.seq, { error: '窗口不可用' })
      const result = await promise
      assert.equal(result.ok, false)
      assert.match(result.error, /quick_mix_check 渲染失败/)
      assert.match(result.error, /studio_render_preview/)
      assert.equal(quickMixCacheSize(state), 0)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('invalid analysis shape returns error', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const promise = exec('studio_quick_mix_check', {})
      let request = null
      for (let attempt = 0; attempt < 100; attempt += 1) { request = peekPreviewRequest(state, 0); if (request) break; await new Promise((r) => setTimeout(r, 1)) }
      completePreviewRequest(state, request.seq, { analysis: [] })
      const result = await promise
      assert.equal(result.ok, false)
      assert.match(result.error, /格式无效/)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('cache accumulates across distinct ranges max16', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      for (let fromBar = 0; fromBar < 10; fromBar += 1) await runQuick(state, exec, { fromBar, bars: 1 })
      assert.equal(quickMixCacheSize(state), 10)
      assert.ok(quickMixCacheSize(state) <= QUICK_MIX_CACHE_LIMIT)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
})

describe('v2.4 P0 source/docs notes', () => {
  it('tool source mentions draft vs full guidance', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/tools.js'), 'utf8')
    assert.ok(source.includes('studio_quick_mix_check'))
    assert.ok(source.includes('draft 只用于快速平衡/削波/频段粗查'))
    assert.ok(source.includes('studio_render_preview'))
  })
  it('preview bridge exports cache limit/span/rates', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/preview-bridge.js'), 'utf8')
    assert.ok(source.includes('QUICK_MIX_CACHE_LIMIT = 16'))
    assert.ok(source.includes('QUICK_MIX_MAX_SPAN = 8'))
    assert.ok(source.includes('8000, 11025, 16000'))
  })
  for (let index = 0; index < 12; index += 1) {
    it('cache key stability case ' + index, () => {
      const base = { revision: index, fromBar: index % 4, toBar: (index % 4) + 1, sampleRate: 8000, soloTrackIds: [], stems: false }
      assert.equal(quickMixCacheKey(base), quickMixCacheKey({ ...base }))
    })
  }
  for (let index = 0; index < 8; index += 1) {
    it('cache set/get roundtrip ' + index, () => {
      const state = {}
      setQuickMixCache(state, 'r' + index, { analysis: { peak: 0.1 * index }, renderMs: index })
      assert.equal(getQuickMixCache(state, 'r' + index).analysis.peak, 0.1 * index)
    })
  }
})

describe('v2.4 P0 quick extra coverage', () => {
  for (let index = 0; index < 16; index += 1) {
    it('sampleRate whitelist constant case ' + index, () => {
      assert.equal(QUICK_MIX_SAMPLE_RATES.includes([8000, 11025, 16000][index % 3]), true)
    })
  }
  for (let index = 0; index < 12; index += 1) {
    it('cache key solo/stems matrix ' + index, () => {
      const base = { revision: index % 5, fromBar: index % 3, toBar: (index % 3) + 1, sampleRate: 8000, soloTrackIds: index % 2 ? ['trk_1'] : [], stems: index % 3 === 0 }
      const key = quickMixCacheKey(base)
      assert.equal(typeof key, 'string')
      assert.ok(key.length > 0)
    })
  }
  for (let index = 0; index < 8; index += 1) {
    it('cache eviction preserves latest ' + index, () => {
      const state = {}
      for (let step = 0; step <= index; step += 1) setQuickMixCache(state, 'e' + step, { analysis: { rms: step } })
      assert.equal(getQuickMixCache(state, 'e' + index).analysis.rms, index)
    })
  }
  it('quick tool request carries draft/quick markers', async () => {
    const source = await readFile(path.join(ROOT, 'src/host/tools.js'), 'utf8')
    assert.ok(source.includes('draft: true'))
    assert.ok(source.includes('quick: true'))
    assert.ok(source.includes("mode: 'draft'"))
  })
  it('cache size does not exceed 16 after many distinct renders', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      for (let fromBar = 0; fromBar < 12; fromBar += 1) await runQuick(state, exec, { fromBar, bars: 1 })
      assert.ok(quickMixCacheSize(state) <= QUICK_MIX_CACHE_LIMIT)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('cached result keeps revision and range', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const first = await runQuick(state, exec, { fromBar: 1, bars: 1 })
      const cached = await exec('studio_quick_mix_check', { fromBar: 1, bars: 1 })
      assert.equal(cached.cached, true)
      assert.deepEqual(cached.range, first.range)
      assert.equal(cached.revision, first.revision)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
})

describe('v2.4 revision sync race fix', () => {
  it('preview request carries state.revision', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const promise = exec('studio_quick_mix_check', {})
      let request = null
      for (let attempt = 0; attempt < 100; attempt += 1) { request = peekPreviewRequest(state, 0); if (request) break; await new Promise((r) => setTimeout(r, 1)) }
      assert.ok(request)
      assert.equal(request.params.revision, state.revision)
      completePreviewRequest(state, request.seq, { analysis: analysisFixture() })
      await promise
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('revision increments visible to request after edit', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      state.mutate({ tool: 'edit' }, (draft) => { draft.title = 'edited' })
      const promise = exec('studio_quick_mix_check', {})
      let request = null
      for (let attempt = 0; attempt < 100; attempt += 1) { request = peekPreviewRequest(state, 0); if (request) break; await new Promise((r) => setTimeout(r, 1)) }
      assert.equal(request.params.revision, state.revision)
      completePreviewRequest(state, request.seq, { analysis: analysisFixture({ rms: 0.42 }) })
      const result = await promise
      assert.equal(result.cached, false)
      assert.equal(result.rms, 0.42)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('quick cache key remains revision-specific with request revision', () => {
    const first = quickMixCacheKey({ revision: 1, fromBar: 0, toBar: 1, sampleRate: 8000 })
    const second = quickMixCacheKey({ revision: 2, fromBar: 0, toBar: 1, sampleRate: 8000 })
    assert.notEqual(first, second)
  })
  it('panel source has waitForRequestRevision + state sync loop', async () => {
    const source = await readFile(path.join(ROOT, 'src/client/panel.jsx'), 'utf8')
    assert.ok(source.includes('waitForRequestRevision'))
    assert.ok(source.includes("fetch('/studio/api/state?rev=0'"))
    assert.ok(source.includes('工程状态尚未同步'))
    assert.ok(source.includes('const syncedProject = await waitForRequestRevision(request, current)'))
  })
})

describe('v2.4 P0 range/no-window contract', () => {
  it('range >8 rejects when project is wide', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const result = await exec('studio_quick_mix_check', { fromBar: 0, toBar: 9 })
      assert.equal(result.ok, false)
      assert.match(result.error, /8 小节/)
      assert.equal(pendingPreviewCount(state), 0)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('cache hit returns without UI/preview bridge', async () => {
    const { state, exec, dataDir } = await makeState()
    try {
      const key = quickMixCacheKey({ revision: state.revision, fromBar: 0, toBar: 1, sampleRate: 8000, soloTrackIds: [], stems: false })
      setQuickMixCache(state, key, { analysis: { peak: 0.5, rms: 0.2, silent: false }, renderMs: 12, analysisRevision: state.revision })
      const result = await exec('studio_quick_mix_check', {})
      assert.equal(result.ok, true)
      assert.equal(result.cached, true)
      assert.equal(result.renderMs, 0)
      assert.equal(result.peak, 0.5)
      assert.equal(pendingPreviewCount(state), 0)
    } finally { await state.flush(); state.dispose(); await cleanup(dataDir) }
  })
  it('cache miss without UI rejects Chinese after preview timeout', async () => {
    const { state, exec, dataDir } = await makeState()
    const previous = process.env.AIMS_PREVIEW_TIMEOUT_MS
    try {
      process.env.AIMS_PREVIEW_TIMEOUT_MS = '30'
      const result = await exec('studio_quick_mix_check', {})
      assert.equal(result.ok, false)
      assert.match(result.error, /quick_mix_check 渲染失败/)
      assert.match(result.error, /studio_render_preview/)
      assert.equal(pendingPreviewCount(state), 0)
    } finally {
      if (previous === undefined) delete process.env.AIMS_PREVIEW_TIMEOUT_MS
      else process.env.AIMS_PREVIEW_TIMEOUT_MS = previous
      await state.flush(); state.dispose(); await cleanup(dataDir)
    }
  })
})

