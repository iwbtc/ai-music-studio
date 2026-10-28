/**
 * R6a：混音 assistant（只读建议 + 安全应用）。
 *
 * - buildMixSuggestions({project, analysis, targetLufs}) → {score,summary,recommendations}
 *   analysis 来自 studio_render_preview（lufs/stems/bandEnergyPct/stereoBalanceDb/clipping/peak）；
 *   无 analysis 时用工程静态值（音量/发送/声像）估算。
 * - applyMixSuggestions(project,{analysis,targetLufs,codes})：把推荐安全应用到 project，
 *   只改 volume/pan/sends/master.volume/已存在的 filter cutoff；返回 applied/changes。
 */
const TARGET_LUFS_DEFAULT = -14
const SEVERITY_PENALTY = { warn: 8, info: 3 }
const clamp01 = (value) => Math.max(0, Math.min(1, value))
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits

function readNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function trackLabel(track) {
  return track?.name ?? track?.id ?? '轨道'
}

function filterEffect(track) {
  return (track?.effects ?? []).find((effect) => effect.type === 'filter') ?? null
}

function findTrack(project, trackId) {
  return (project?.tracks ?? []).find((track) => track.id === trackId) ?? null
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 只读混音建议。
 * @param {{project:object, analysis?:object|null, targetLufs?:number}} args
 */
export function buildMixSuggestions(args = {}) {
  const project = args?.project
  if (project === null || typeof project !== 'object') throw new Error('混音建议需要工程对象')
  const targetLufs = readNumber(args.targetLufs) ?? TARGET_LUFS_DEFAULT
  if (targetLufs < -24 || targetLufs > -5) throw new Error('targetLufs 必须在 -24..-5 之间')
  const analysis = args.analysis !== null && typeof args.analysis === 'object' && !Array.isArray(args.analysis) ? args.analysis : null
  const recommendations = []
  const push = (recommendation) => {
    recommendations.push({
      severity: recommendation.severity ?? 'info',
      ...recommendation,
      current: round(recommendation.current, 3),
      suggested: round(recommendation.suggested, 3),
    })
  }
  const master = project.master ?? {}
  const tracks = Array.isArray(project.tracks) ? project.tracks : []

  // 1) 响度（analysis 优先）
  const lufs = analysis ? readNumber(analysis.lufs ?? analysis.lufsApprox) : null
  if (lufs !== null) {
    const delta = lufs - targetLufs
    if (delta > 1) {
      const masterVolume = readNumber(master.volume) ?? 0.82
      const gain = 10 ** (-Math.min(delta, 12) / 20)
      push({
        code: 'mix.loudness.high',
        severity: 'warn',
        target: 'master',
        param: 'volume',
        current: masterVolume,
        suggested: clamp01(masterVolume * gain),
        reason: `整体响度 ${lufs.toFixed(1)} LUFS 高于目标 ${targetLufs} LUFS，建议降低 master 音量`,
      })
    } else if (delta < -1) {
      const masterVolume = readNumber(master.volume) ?? 0.82
      const gain = 10 ** (Math.min(-delta, 12) / 20)
      push({
        code: 'mix.loudness.low',
        severity: 'info',
        target: 'master',
        param: 'volume',
        current: masterVolume,
        suggested: clamp01(masterVolume * gain),
        reason: `整体响度 ${lufs.toFixed(1)} LUFS 低于目标 ${targetLufs} LUFS，可适当提高 master 音量`,
      })
    }
  }

  // 2) 削波/峰值
  const peak = analysis ? readNumber(analysis.peak) : null
  if (analysis?.clipping === true || (peak !== null && peak > 0.98)) {
    const masterVolume = readNumber(master.volume) ?? 0.82
    push({
      code: 'mix.clipping',
      severity: 'warn',
      target: 'master',
      param: 'volume',
      current: masterVolume,
      suggested: clamp01(masterVolume * 0.8),
      reason: analysis?.clipping === true ? '检测到削波，建议降低 master 音量' : `峰值 ${peak.toFixed(2)} 接近/超过 0.98，建议降低 master 音量`,
    })
  }

  // 3) 立体声平衡
  const balance = analysis ? readNumber(analysis.stereoBalanceDb) : null
  if (balance !== null && Math.abs(balance) > 3) {
    const targetTrack = tracks.find((track) => track.kind === 'synth' || track.kind === 'drum') ?? tracks[0] ?? null
    if (targetTrack) {
      const currentPan = readNumber(targetTrack.pan) ?? 0
      push({
        code: 'mix.stereo.balance',
        severity: 'warn',
        target: 'track',
        trackId: targetTrack.id,
        param: 'pan',
        current: currentPan,
        suggested: clamp01((currentPan + 1) / 2 - Math.sign(balance) * 0.15) * 2 - 1,
        reason: `L/R 平衡 ${balance.toFixed(1)}dB，建议把「${trackLabel(targetTrack)}」声像向${balance > 0 ? '左' : '右'}调整`,
      })
    }
  }

  // 4) 频段能量（低/高频过量 → 已有 filter 的轨道建议调 cutoff）
  const bands = analysis?.bandEnergyPct
  if (bands !== null && typeof bands === 'object' && !Array.isArray(bands)) {
    const low = readNumber(bands.low ?? bands.lowPct ?? bands['20-250'])
    const high = readNumber(bands.high ?? bands.highPct ?? bands['4k-16k'])
    if (low !== null && low > 60) {
      const bassLike = tracks.find((track) => track.role === 'bass' || track.kind === 'drum') ?? tracks[0] ?? null
      const filter = filterEffect(bassLike)
      if (filter) {
        const cutoff = readNumber(filter.params?.cutoff) ?? 2000
        push({
          code: 'mix.band.low',
          severity: 'info',
          target: 'track',
          trackId: bassLike.id,
          param: 'filter.cutoff',
          effectId: filter.id,
          current: cutoff,
          suggested: Math.max(100, Math.round(cutoff * 1.4)),
          reason: `低频能量占 ${low.toFixed(0)}%，建议提高「${trackLabel(bassLike)}」filter 截止，减少低频堆积`,
        })
      }
    }
    if (high !== null && high > 35) {
      const bright = tracks.find((track) => filterEffect(track)) ?? null
      const filter = filterEffect(bright)
      if (filter) {
        const cutoff = readNumber(filter.params?.cutoff) ?? 2000
        push({
          code: 'mix.band.high',
          severity: 'info',
          target: 'track',
          trackId: bright.id,
          param: 'filter.cutoff',
          effectId: filter.id,
          current: cutoff,
          suggested: Math.max(100, Math.round(cutoff * 0.7)),
          reason: `高频能量占 ${high.toFixed(0)}%，建议降低「${trackLabel(bright)}」filter 截止，收敛刺耳感`,
        })
      }
    }
  }

  // 5) stems：某轨显著 > 中位数 → 降音量
  if (Array.isArray(analysis?.stems) && analysis.stems.length > 1) {
    const levels = analysis.stems
      .map((stem) => ({ trackId: stem.trackId, rmsDb: readNumber(stem.rmsDb) }))
      .filter((stem) => stem.trackId && stem.rmsDb !== null)
    const medianDb = median(levels.map((stem) => stem.rmsDb))
    if (medianDb !== null) {
      for (const stem of levels) {
        if (stem.rmsDb < medianDb + 10) continue
        const track = findTrack(project, stem.trackId)
        if (!track) continue
        const current = readNumber(track.volume) ?? 0.78
        const gain = 10 ** (-(Math.min(24, stem.rmsDb - medianDb - 6)) / 20)
        push({
          code: 'mix.stem.loud',
          severity: 'warn',
          target: 'track',
          trackId: track.id,
          param: 'volume',
          current,
          suggested: clamp01(current * gain),
          reason: `「${trackLabel(track)}」RMS ${stem.rmsDb.toFixed(1)}dB，比中位轨高 ${(stem.rmsDb - medianDb).toFixed(1)}dB，建议降低音量`,
        })
      }
    }
  }

  // 6) 发送量过高（静态规则）
  for (const track of tracks) {
    const reverb = readNumber(track.sends?.reverb)
    const delay = readNumber(track.sends?.delay)
    if (reverb !== null && reverb > 0.5) {
      push({
        code: 'mix.send.reverb',
        severity: 'info',
        target: 'track',
        trackId: track.id,
        param: 'sends.reverb',
        current: reverb,
        suggested: 0.35,
        reason: `「${trackLabel(track)}」混响发送 ${reverb.toFixed(2)} 偏大，可能变浑浊，建议降到 0.35`,
      })
    }
    if (delay !== null && delay > 0.5) {
      push({
        code: 'mix.send.delay',
        severity: 'info',
        target: 'track',
        trackId: track.id,
        param: 'sends.delay',
        current: delay,
        suggested: 0.3,
        reason: `「${trackLabel(track)}」延迟发送 ${delay.toFixed(2)} 偏大，建议降到 0.3`,
      })
    }
  }

  // 7) 静态兜底：master/轨音量过高
  if (!analysis) {
    const masterVolume = readNumber(master.volume) ?? 0.82
    if (masterVolume > 0.95) {
      push({
        code: 'mix.static.master',
        severity: 'warn',
        target: 'master',
        param: 'volume',
        current: masterVolume,
        suggested: 0.9,
        reason: 'master 音量过高（>0.95），易削波，建议降到 0.9',
      })
    }
    for (const track of tracks) {
      const volume = readNumber(track.volume)
      if (volume !== null && volume > 0.98) {
        push({
          code: 'mix.static.track',
          severity: 'info',
          target: 'track',
          trackId: track.id,
          param: 'volume',
          current: volume,
          suggested: 0.9,
          reason: `「${trackLabel(track)}」音量接近满值，建议降到 0.9 留 headroom`,
        })
      }
    }
  }

  recommendations.sort((a, b) => (SEVERITY_PENALTY[b.severity] ?? 0) - (SEVERITY_PENALTY[a.severity] ?? 0) || a.code.localeCompare(b.code))
  const penalty = recommendations.reduce((sum, item) => sum + (SEVERITY_PENALTY[item.severity] ?? 0), 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const summary = recommendations.length === 0
    ? `混音状态良好（${score} 分），暂无必须调整项。`
    : `混音状态 ${score} 分，发现 ${recommendations.length} 条建议（${recommendations.filter((item) => item.severity === 'warn').length} 条警告）。`
  return { score, summary, targetLufs, recommendations }
}

/**
 * 安全应用建议（只改白名单字段）；返回 applied/changes。
 * @param {object} project
 * @param {{analysis?:object|null,targetLufs?:number,codes?:string[]}} options
 */
export function applyMixSuggestions(project, options = {}) {
  const result = buildMixSuggestions({ project, analysis: options.analysis ?? null, targetLufs: options.targetLufs })
  const allowedCodes = Array.isArray(options.codes) && options.codes.length > 0 ? new Set(options.codes.map((code) => String(code))) : null
  const changes = []
  for (const recommendation of result.recommendations) {
    if (allowedCodes && !allowedCodes.has(recommendation.code)) continue
    const suggested = readNumber(recommendation.suggested)
    if (suggested === null) continue
    if (recommendation.target === 'master' && recommendation.param === 'volume') {
      const current = readNumber(project.master?.volume) ?? 0.82
      const next = clamp01(suggested)
      if (Math.abs(next - current) < 0.002) continue
      project.master.volume = next
      changes.push({ code: recommendation.code, target: 'master', param: 'volume', from: round(current, 3), to: round(next, 3) })
      continue
    }
    if (recommendation.target !== 'track' || !recommendation.trackId) continue
    const track = findTrack(project, recommendation.trackId)
    if (!track) continue
    if (recommendation.param === 'volume') {
      const current = readNumber(track.volume) ?? 0.78
      const next = clamp01(suggested)
      if (Math.abs(next - current) < 0.002) continue
      track.volume = next
      changes.push({ code: recommendation.code, target: 'track', trackId: track.id, param: 'volume', from: round(current, 3), to: round(next, 3) })
    } else if (recommendation.param === 'pan') {
      const current = readNumber(track.pan) ?? 0
      const next = Math.max(-1, Math.min(1, suggested))
      if (Math.abs(next - current) < 0.002) continue
      track.pan = next
      changes.push({ code: recommendation.code, target: 'track', trackId: track.id, param: 'pan', from: round(current, 3), to: round(next, 3) })
    } else if (recommendation.param === 'sends.reverb' || recommendation.param === 'sends.delay') {
      const key = recommendation.param === 'sends.reverb' ? 'reverb' : 'delay'
      if (!track.sends || typeof track.sends !== 'object') track.sends = { reverb: 0.18, delay: 0.12 }
      const current = readNumber(track.sends[key]) ?? 0
      const next = clamp01(suggested)
      if (Math.abs(next - current) < 0.002) continue
      track.sends[key] = next
      changes.push({ code: recommendation.code, target: 'track', trackId: track.id, param: recommendation.param, from: round(current, 3), to: round(next, 3) })
    } else if (recommendation.param === 'filter.cutoff') {
      const effect = (track.effects ?? []).find((item) => item.id === recommendation.effectId && item.type === 'filter')
      if (!effect) continue
      const current = readNumber(effect.params?.cutoff) ?? 2000
      const next = Math.max(100, Math.min(16000, Math.round(suggested)))
      if (next === current) continue
      effect.params = { ...(effect.params ?? {}), cutoff: next }
      changes.push({ code: recommendation.code, target: 'track', trackId: track.id, param: 'filter.cutoff', from: current, to: next })
    }
  }
  return { applied: changes.length, changes, score: result.score, summary: result.summary }
}

export const DEFAULT_MIX_TARGET_LUFS = TARGET_LUFS_DEFAULT
