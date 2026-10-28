/** R6e：音频级质量评估单测。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AUDIO_QUALITY_DEFAULT_TARGET_LUFS,
  AUDIO_QUALITY_WEIGHTS,
  evaluateAudioAnalysis,
} from '../src/shared/ai-quality.js'

const GOOD = {
  lufs: -14.2,
  lufsMaxShortTerm: -13.8,
  peakDb: -1.2,
  crestDb: 10.5,
  stereoBalanceDb: 0.5,
  correlation: 0.8,
  bandEnergyPct: { sub: 8, low: 22, lowMid: 32, mid: 25, highMid: 9, high: 4 },
  clipping: false,
  clippedSamples: 0,
  rmsDb: -24.5,
}

const BAD = {
  lufs: -5,
  peakDb: 0.5,
  crestDb: 4,
  stereoBalanceDb: 6,
  correlation: -0.2,
  bandEnergyPct: { sub: 40, low: 35, lowMid: 15, mid: 8, highMid: 1, high: 1 },
  clipping: true,
  clippedSamples: 1200,
  rmsDb: -9,
}

const clone = (value) => JSON.parse(JSON.stringify(value))

describe('ai-quality R6e — 评分/等级/指标', () => {
  it('默认 targetLufs=-14、权重总和 100', () => {
    assert.equal(AUDIO_QUALITY_DEFAULT_TARGET_LUFS, -14)
    const sum = Object.values(AUDIO_QUALITY_WEIGHTS).reduce((total, value) => total + value, 0)
    assert.equal(sum, 100)
  })

  it('优秀 analysis：score=100、grade=A、无 findings', () => {
    const report = evaluateAudioAnalysis(GOOD)
    assert.equal(report.score, 100)
    assert.equal(report.grade, 'A')
    assert.deepEqual(report.findings, [])
    assert.deepEqual(report.recommendations, [])
    assert.ok(report.summary.includes('A 级'))
  })

  it('metrics：字段齐全、频段合并且为百分比', () => {
    const report = evaluateAudioAnalysis(GOOD)
    for (const key of ['lufs', 'peakDb', 'crestDb', 'stereoBalanceDb', 'correlation', 'lowPct', 'midPct', 'highPct', 'clipping']) {
      assert.ok(Object.hasOwn(report.metrics, key), key)
    }
    assert.equal(report.metrics.lowPct, 30)
    assert.equal(report.metrics.midPct, 57)
    assert.equal(report.metrics.highPct, 13)
    assert.equal(report.metrics.lufsMaxShortTerm, -13.8)
  })

  it('低质 analysis：score 低、grade=D、findings/recommendations 非空', () => {
    const report = evaluateAudioAnalysis(BAD)
    assert.ok(report.score < 50)
    assert.equal(report.grade, 'D')
    assert.ok(report.findings.length >= 5)
    assert.ok(report.recommendations.length >= 3)
    const codes = new Set(report.findings.map((item) => item.code))
    for (const code of ['audio.loudness.loud', 'audio.clipping', 'audio.crest.narrow', 'audio.stereo.imbalance', 'audio.band.lowExcess']) {
      assert.ok(codes.has(code), code)
    }
  })

  it('响度偏低 → quiet 建议；偏高 → loud 建议', () => {
    const quiet = evaluateAudioAnalysis({ ...GOOD, lufs: -24 })
    assert.ok(quiet.findings.some((item) => item.code === 'audio.loudness.quiet'))
    assert.ok(quiet.score < 100)
    const loud = evaluateAudioAnalysis({ ...GOOD, lufs: -6 })
    assert.ok(loud.findings.some((item) => item.code === 'audio.loudness.loud'))
  })

  it('削波/峰值过高 → clipping 建议且 grade 下降', () => {
    const report = evaluateAudioAnalysis({ ...GOOD, peakDb: 0.3, clipping: true, clippedSamples: 50 })
    assert.equal(report.metrics.clipping, true)
    assert.ok(report.findings.some((item) => item.code === 'audio.clipping'))
    assert.ok(report.score < 80)
  })

  it('峰值接近 0dB 但未削波 → peak.hot 提示', () => {
    const report = evaluateAudioAnalysis({ ...GOOD, peakDb: -0.3, clipping: false })
    assert.ok(report.findings.some((item) => item.code === 'audio.peak.hot'))
  })

  it('crest 过小/过大 → 对应建议', () => {
    const narrow = evaluateAudioAnalysis({ ...GOOD, crestDb: 4 })
    assert.ok(narrow.findings.some((item) => item.code === 'audio.crest.narrow'))
    assert.ok(narrow.score < 100)
    const wide = evaluateAudioAnalysis({ ...GOOD, crestDb: 20 })
    assert.ok(wide.findings.some((item) => item.code === 'audio.crest.wide'))
  })

  it('立体声失衡/相关低 → 建议', () => {
    const balance = evaluateAudioAnalysis({ ...GOOD, stereoBalanceDb: -5 })
    assert.ok(balance.findings.some((item) => item.code === 'audio.stereo.imbalance'))
    const phase = evaluateAudioAnalysis({ ...GOOD, correlation: 0 })
    assert.ok(phase.findings.some((item) => item.code === 'audio.stereo.correlation'))
  })

  it('低频过多/高频不足/低频不足 → 频段建议', () => {
    const lowExcess = evaluateAudioAnalysis({ ...GOOD, bandEnergyPct: { sub: 30, low: 30, lowMid: 20, mid: 15, highMid: 3, high: 2 } })
    assert.ok(lowExcess.findings.some((item) => item.code === 'audio.band.lowExcess'))
    const highDeficit = evaluateAudioAnalysis({ ...GOOD, bandEnergyPct: { sub: 10, low: 30, lowMid: 35, mid: 23, highMid: 1, high: 1 } })
    assert.ok(highDeficit.findings.some((item) => item.code === 'audio.band.highDeficit'))
    const lowDeficit = evaluateAudioAnalysis({ ...GOOD, bandEnergyPct: { sub: 0, low: 2, lowMid: 40, mid: 38, highMid: 12, high: 8 } })
    assert.ok(lowDeficit.findings.some((item) => item.code === 'audio.band.lowDeficit'))
  })

  it('score 始终 0..100 整数；grade 为 A/B/C/D', () => {
    for (const analysis of [GOOD, BAD, { ...GOOD, lufs: -8, crestDb: 6 }, { ...GOOD, lufs: -20, peakDb: -12 }]) {
      const report = evaluateAudioAnalysis(analysis)
      assert.ok(Number.isInteger(report.score) && report.score >= 0 && report.score <= 100)
      assert.ok(['A', 'B', 'C', 'D'].includes(report.grade))
    }
  })

  it('findings severity 仅 warn/info；recommendations 字段完整', () => {
    const report = evaluateAudioAnalysis(BAD)
    for (const item of report.findings) {
      assert.ok(['warn', 'info'].includes(item.severity))
      assert.ok(typeof item.code === 'string' && item.message.length > 0)
    }
    for (const item of report.recommendations) {
      for (const key of ['code', 'target', 'param', 'suggested', 'reason']) assert.ok(Object.hasOwn(item, key), key)
      assert.ok(Number.isFinite(item.suggested))
    }
  })

  it('非法 analysis：null/数组/字符串中文错误', () => {
    for (const value of [null, [], 'x', 42]) {
      assert.throws(() => evaluateAudioAnalysis(value), /[\u4e00-\u9fa5]/)
    }
  })

  it('缺 lufs/peakDb 中文错误', () => {
    assert.throws(() => evaluateAudioAnalysis({ peakDb: -1 }), /lufs/)
    assert.throws(() => evaluateAudioAnalysis({ lufs: -14 }), /peakDb/)
    assert.throws(() => evaluateAudioAnalysis({ lufs: 'x', peakDb: -1 }), /lufs/)
  })

  it('非法 targetLufs 中文错误', () => {
    assert.throws(() => evaluateAudioAnalysis(GOOD, { targetLufs: -30 }), /targetLufs/)
    assert.throws(() => evaluateAudioAnalysis(GOOD, { targetLufs: -4 }), /targetLufs/)
  })

  it('targetLufs 影响评分（同一 analysis 不同目标）', () => {
    const at14 = evaluateAudioAnalysis({ ...GOOD, lufs: -14 }, { targetLufs: -14 })
    const at8 = evaluateAudioAnalysis({ ...GOOD, lufs: -14 }, { targetLufs: -8 })
    assert.equal(at14.score, 100)
    assert.ok(at8.score < at14.score)
  })

  it('crest 缺失时用 peakDb-rmsDb 回退', () => {
    const analysis = clone(GOOD)
    delete analysis.crestDb
    const report = evaluateAudioAnalysis(analysis)
    assert.equal(report.metrics.crestDb, Math.round((analysis.peakDb - analysis.rmsDb) * 100) / 100)
  })

  it('clippedSamples>0 但 clipping=false 也扣分', () => {
    const clean = evaluateAudioAnalysis(GOOD)
    const dirty = evaluateAudioAnalysis({ ...GOOD, clippedSamples: 500 })
    assert.ok(dirty.score <= clean.score)
  })

  it('同一输入完全可复现', () => {
    assert.deepEqual(evaluateAudioAnalysis(BAD), evaluateAudioAnalysis(BAD))
  })

  it('不修改输入 analysis', () => {
    const analysis = clone(BAD)
    const before = JSON.stringify(analysis)
    evaluateAudioAnalysis(analysis)
    assert.equal(JSON.stringify(analysis), before)
  })

  it('genre 出现在 summary；默认 electronic', () => {
    assert.ok(evaluateAudioAnalysis(GOOD).summary.includes('electronic'))
    assert.ok(evaluateAudioAnalysis(GOOD, { genre: 'house' }).summary.includes('house'))
  })

  it('无 bandEnergyPct 时频段为 0 且有对应建议，不崩', () => {
    const analysis = clone(GOOD)
    delete analysis.bandEnergyPct
    const report = evaluateAudioAnalysis(analysis)
    assert.equal(report.metrics.lowPct, 0)
    assert.ok(report.findings.some((item) => item.code === 'audio.band.lowDeficit'))
  })
})
