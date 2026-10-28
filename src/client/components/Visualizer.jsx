/**
 * 右栏：Master 频谱可视化（canvas）。
 *
 * 播放时读取 engine.getSpectrum(u8)；未播放时绘制缓动的「AI 呼吸」频谱，
 * 保证静态截图也有一点生命力。每两帧绘制一次即可。
 */
import { useEffect, useMemo, useRef } from 'react'
import { mix, palette } from '../theme.js'
import { Panel, clamp, useElementSize, useFrame } from './ui.jsx'

const BINS = 40

function roundedTopBar(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  ctx.beginPath()
  ctx.moveTo(x, y + h)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.closePath()
  ctx.fill()
}

export function Visualizer({ engine, playing = false, collapsed = false, onToggleCollapse = null }) {
  const [wrapRef, size] = useElementSize()
  const canvasRef = useRef(null)
  const ctxRef = useRef(null)
  const valuesRef = useRef(new Float32Array(BINS))
  const spectrumRef = useRef(null)

  const colors = useMemo(
    () => Array.from({ length: BINS }, (_, i) => {
      const t = i / (BINS - 1)
      return t < 0.55 ? mix(palette.mint, palette.amber, t / 0.55) : mix(palette.amber, palette.coral, (t - 0.55) / 0.45)
    }),
    [],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width < 8 || size.height < 8) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctxRef.current = ctx
  }, [size.width, size.height])

  useFrame(engine, (e, now, frame) => {
    const ctx = ctxRef.current
    if (!ctx || frame % 2 !== 0) return
    const w = size.width
    const h = size.height
    if (w < 8 || h < 8) return

    const live = Boolean(e?.isPlaying || playing)
    let spectrum = null
    if (engine && typeof engine.getSpectrum === 'function') {
      try {
        if (!spectrumRef.current) spectrumRef.current = new Uint8Array(64)
        engine.getSpectrum(spectrumRef.current)
        spectrum = spectrumRef.current
      } catch (err) {
        spectrum = null
      }
    }

    const t = now * 0.001
    const values = valuesRef.current
    for (let i = 0; i < BINS; i += 1) {
      // 呼吸感 idle 波形（未播放时有轻微起伏）
      const idle = 0.12 + 0.36 * Math.abs(Math.sin(t * 0.85 + i * 0.29)) * (0.55 + 0.45 * Math.sin(t * 0.5 + i * 0.17))
      let target = idle * 0.55
      if (spectrum && live) {
        const idx = Math.min(spectrum.length - 1, Math.floor((i / BINS) * spectrum.length))
        const real = spectrum[idx] / 255
        target = Math.max(Math.pow(real, 1.25), idle * 0.22)
      }
      values[i] = values[i] + (clamp(target, 0.02, 1) - values[i]) * 0.35
    }

    ctx.clearRect(0, 0, w, h)
    // 底色与基准线
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, w, h)
    const baseline = h - 14
    ctx.fillStyle = '#F0ECE3'
    ctx.fillRect(0, baseline + 1, w, 1)

    const gap = Math.max(1.5, Math.round(w * 0.008))
    const barW = Math.max(2, (w - gap * (BINS - 1)) / BINS)
    for (let i = 0; i < BINS; i += 1) {
      const v = values[i]
      const bh = Math.max(1.5, v * (baseline - 10))
      const x = i * (barW + gap)
      // 倒影（非常淡）
      ctx.globalAlpha = 0.12
      ctx.fillStyle = colors[i]
      ctx.fillRect(x, baseline + 2, barW, Math.min(8, bh * 0.14))
      // 主柱：渐变按柱高（顶部更饱和）
      ctx.globalAlpha = 0.42 + v * 0.5
      roundedTopBar(ctx, x, baseline - bh, barW, bh, Math.min(3, barW / 2))
      ctx.globalAlpha = 1
    }
    // 顶部高光短线
    ctx.fillStyle = 'rgba(242,107,58,0.20)'
    ctx.fillRect(0, 0, w, 1)
  })

  return (
    <Panel
      title="Master 频谱"
      subtitle="ANALYSER"
      badge={<span className={`aims-vis-live ${playing ? 'is-live' : ''}`}><span className="aims-vis-live-dot" />{playing ? 'LIVE' : 'IDLE'}</span>}
      className="aims-right-panel aims-vis-panel"
      bodyClassName="aims-vis-body"
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      collapseTestId="collapse-spectrum"
      collapseTitle={collapsed ? '展开 Master 频谱' : '折叠 Master 频谱'}
    >
      <div className="aims-vis-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="aims-vis-canvas" />
        <div className="aims-vis-axis" aria-hidden="true">
          <span>20Hz</span><span>200</span><span>2k</span><span>20k</span>
        </div>
      </div>
      <div className="aims-vis-foot">
        <span className="aims-vis-foot-item aims-mono">48 kHz</span>
        <span className="aims-vis-foot-item aims-mono">FFT 2048</span>
        <span className="aims-vis-foot-item aims-mono">STEREO OUT</span>
        <span className="aims-vis-foot-accent">MASTER</span>
      </div>
    </Panel>
  )
}
