/**
 * R6e：AI 音频级质量评估（纯函数，输入 studio_render_preview 的 analysis）。
 *
 * - evaluateAudioAnalysis(analysis, {targetLufs=-14, genre='electronic'})
 *   → {score 0..100, grade A|B|C|D, metrics, findings, recommendations, summary}
 * - 评分权重明确：响度 25 / 峰值削波 20 / crest 动态 15 / 立体声 15 / 频段 15 / 削波样本 10。
 * - 不写工程、不依赖客户端代码（可被脚本与工具共用）。
 */
const DEFAULT_TARGET_LUFS = -14
const DEFAULT_GENRE = 'electronic'
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const clamp01 = (value) => clamp(value, 0, 1)
const round = (value, digits = 3) => Math.round(value * 1000) / 1000
function readNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function bandPercents(bands) {
  if (bands === null || typeof bands !== 'object' || Array.isArray(bands)) return { lowPct: 0, midPct: 0, highPct: 0 }
  const read = (key) => readNumber(bands[key]) ?? 0
  const lowPct = round(read('sub') + read('low'))
  const midPct = round(read('lowMid') + read('mid'))
  const highPct = round(read('highMid') + read('high'))
  return { lowPct, midPct, highPct }
}

/**
 * 评估一段 render_preview analysis。
 * @param {object} analysis 真实/合成 analysis（至少含 lufs 与 peakDb）
 * @param {{targetLufs?:number, genre?:string}} [options]
 */
export function evaluateAudioAnalysis(analysis, options = {}) {
  if (analysis === null || typeof analysis !== 'object' || Array.isArray(analysis)) {
    throw new Error('音频质量评估需要 analysis 对象（来自 studio_render_preview）')
  }
  const targetLufsRaw = readNumber(options.targetLufs)
  const targetLufs = targetLufsRaw === null ? DEFAULT_TARGET_LUFS : targetLufsRaw
  if (targetLufs < -24 || targetLufs > -5) throw new Error('targetLufs 必须在 -24..-5 之间')
  const genre = typeof options.genre === 'string' && options.genre.trim() !== '' ? options.genre.trim() : DEFAULT_GENRE
  const lufs = readNumber(analysis.lufs)
  const peakDb = readNumber(analysis.peakDb)
  if (lufs === null) throw new Error('analysis 缺少有效字段 lufs（响度）')
  if (peakDb === null) throw new Error('analysis 缺少有效字段 peakDb（峰值）')
  const rmsDb = readNumber(analysis.rmsDb)
  const crestDb = readNumber(analysis.crestDb) ?? (rmsDb === null ? 10 : round(peakDb - rmsDb))
  const stereoBalanceDb = readNumber(analysis.stereoBalanceDb) ?? 0
  const correlation = readNumber(analysis.correlation) ?? 1
  const clipping = analysis.clipping === true || peakDb > -0.05
  const clippedSamples = Math.max(0, readNumber(analysis.clippedSamples) ?? 0)
  const { lowPct, midPct, highPct } = bandPercents(analysis.bandEnergyPct)
  const lufsMaxShortTerm = readNumber(analysis.lufsMaxShortTerm)
  const metrics = {
    lufs: round(lufs, 2),
    peakDb: round(peakDb, 2),
    crestDb: round(crestDb, 2),
    stereoBalanceDb: round(stereoBalanceDb, 2),
    correlation: round(correlation, 3),
    lowPct,
    midPct,
    highPct,
    clipping,
    clippedSamples,
    ...(lufsMaxShortTerm === null ? {} : { lufsMaxShortTerm: round(lufsMaxShortTerm, 2) }),
  }
  const findings = []
  const recommendations = []
  const push = (code, severity, message) => findings.push({ code, severity, message })
  const recommend = (code, target, param, suggested, reason) => recommendations.push({ code, target, param, suggested, reason })

  // 1) 响度（25 分）：目标 ±2 LUFS 满分，偏离线性衰减。
  const loudnessDeviation = Math.abs(lufs - targetLufs)
  const loudnessScore = loudnessDeviation <= 2 ? 25 : 25 * clamp01(1 - (loudnessDeviation - 2) / 8)
  if (lufs < targetLufs - 2) {
    push('audio.loudness.quiet', 'warn', `整体响度 ${metrics.lufs} LUFS 低于目标 ${targetLufs} LUFS`)
    recommend('audio.loudness.quiet', 'master', 'volume', round(10 ** ((targetLufs - lufs) / 20), 3), '提高 master 增益以接近目标响度')
  } else if (lufs > targetLufs + 2) {
    push('audio.loudness.loud', 'warn', `整体响度 ${metrics.lufs} LUFS 高于目标 ${targetLufs} LUFS`)
    recommend('audio.loudness.loud', 'master', 'volume', round(10 ** ((targetLufs - lufs) / 20), 3), '降低 master 增益以接近目标响度')
  }

  // 2) 峰值/削波（20 分）+ 6) 削波样本（10 分）。
  const peakScore = clipping ? 0 : 20 * clamp01(1 - Math.max(0, peakDb + 1) / 1)
  if (clipping) {
    push('audio.clipping', 'warn', `检测到削波（峰值 ${metrics.peakDb}dB${clippedSamples > 0 ? `，${clippedSamples} 个样本` : ''}）`)
    recommend('audio.clipping', 'master', 'volume', 0.8, '降低 master 增益/加限幅，避免削波失真')
  } else if (peakDb > -1) {
    push('audio.peak.hot', 'info', `峰值 ${metrics.peakDb}dB 接近 0dB，动态余量不足`)
    recommend('audio.peak.hot', 'master', 'volume', 0.9, '预留约 1dB headroom')
  }
  const sampleScore = clipping ? 0 : 10 * clamp01(1 - clippedSamples / 1000)

  // 3) crest 动态（15 分）：8–14dB 最佳。
  let crestScore = 15
  if (crestDb < 8) {
    crestScore = 15 * clamp01(1 - (8 - crestDb) / 8)
    push('audio.crest.narrow', 'info', `crest ${metrics.crestDb}dB 偏小（<8dB），动态被压得过紧`)
    recommend('audio.crest.narrow', 'master', 'compressor.threshold', 0.6, '降低压缩量，保留瞬态动态')
  } else if (crestDb > 14) {
    crestScore = 15 * clamp01(1 - (crestDb - 14) / 10)
    push('audio.crest.wide', 'info', `crest ${metrics.crestDb}dB 偏大（>14dB），动态起伏可能过大`)
    recommend('audio.crest.wide', 'master', 'compressor.threshold', 0.35, '适度压缩/限幅，稳定整体动态')
  }

  // 4) 立体声平衡/相关（15 分）：平衡 9 + 相关 6。
  const balancePenalty = Math.abs(stereoBalanceDb) <= 1 ? 0 : Math.abs(stereoBalanceDb) - 1
  const balanceScore = 9 * clamp01(1 - balancePenalty / 5)
  const correlationScore = correlation >= 0.2 ? 6 : 6 * clamp01((correlation + 1) / 1.2)
  const stereoScore = balanceScore + correlationScore
  if (Math.abs(stereoBalanceDb) > 3) {
    push('audio.stereo.imbalance', 'warn', `L/R 平衡 ${metrics.stereoBalanceDb}dB 偏差过大`)
    recommend('audio.stereo.imbalance', 'master', 'pan', 0, '调整声像使左右能量更均衡')
  }
  if (correlation < 0.1) {
    push('audio.stereo.correlation', 'warn', `相位相关 ${metrics.correlation} 偏低，存在相位抵消风险`)
    recommend('audio.stereo.correlation', 'master', 'pan', 0, '检查立体声宽度/相位，避免单声道兼容问题')
  }

  // 5) 频段（15 分）：低频 15–40%、中频 20–70%、高频 ≥3%。
  let bandPenalty = 0
  if (lowPct < 10) bandPenalty += ((10 - lowPct) / 10) * 7
  if (lowPct > 50) bandPenalty += ((lowPct - 50) / 50) * 7
  if (midPct < 20) bandPenalty += ((20 - midPct) / 20) * 5
  if (highPct < 3) bandPenalty += ((3 - highPct) / 3) * 6
  const bandScore = 15 * clamp01(1 - bandPenalty / 15)
  if (lowPct > 50) {
    push('audio.band.lowExcess', 'info', `低频能量占 ${lowPct}%，可能浑浊/轰头`)
    recommend('audio.band.lowExcess', 'master', 'eq3.low', -3, '衰减低频或高通，减少低频堆积')
  }
  if (highPct < 3) {
    push('audio.band.highDeficit', 'info', `高频能量占 ${highPct}%，听感偏闷`)
    recommend('audio.band.highDeficit', 'master', 'eq3.high', 3, '提升高频/空气感，改善明亮度')
  }
  if (lowPct < 10) {
    push('audio.band.lowDeficit', 'info', `低频能量仅占 ${lowPct}%，可能偏薄`)
    recommend('audio.band.lowDeficit', 'master', 'eq3.low', 2, '适度提升低频/超低频')
  }

  const rawScore = loudnessScore + peakScore + crestScore + stereoScore + bandScore + sampleScore
  const score = clamp(Math.round(rawScore), 0, 100)
  let grade = 'D'
  if (score >= 90) grade = 'A'
  else if (score >= 80) grade = 'B'
  else if (score >= 70) grade = 'C'
  const warnCount = findings.filter((item) => item.severity === 'warn').length
  const summary = `${score} 分 · ${grade} 级 · ${genre} · 响度 ${metrics.lufs} LUFS · 峰值 ${metrics.peakDb}dB · ` +
    `${findings.length === 0 ? '未发现明显问题' : `${warnCount} 条警告 / ${findings.length - warnCount} 条提示`}`
  return { score, grade, metrics, findings, recommendations, summary }
}

export const AUDIO_QUALITY_DEFAULT_TARGET_LUFS = DEFAULT_TARGET_LUFS
export const AUDIO_QUALITY_WEIGHTS = Object.freeze({
  loudness: 25,
  peak: 20,
  crest: 15,
  stereo: 15,
  bands: 15,
  clippingSamples: 10,
})
