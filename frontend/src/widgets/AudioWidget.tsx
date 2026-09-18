import { useEffect, useRef } from 'react'
import { fetchWaveform, wsUrl } from '../api'

type Peak = { t: number; min: number; max: number }

type Props = {
  sourceId: string
  live: boolean
  playing?: boolean
  hasCapture?: boolean
  t0: number | null
  t1: number | null
  center: number | null
  duration: number
}

function draw(canvas: HTMLCanvasElement, peaks: Peak[], t0?: number | null, t1?: number | null) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#080b10'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = '#1d2838'
  ctx.beginPath()
  ctx.moveTo(0, height / 2)
  ctx.lineTo(width, height / 2)
  ctx.stroke()
  if (peaks.length === 0) return
  const mid = height / 2
  ctx.fillStyle = '#f0a202'
  const view0 = t0 ?? peaks[0].t
  const view1 = t1 ?? peaks[peaks.length - 1].t
  const span = Math.max(1, view1 - view0)
  const step = Math.max(1, width / peaks.length)
  peaks.forEach((peak, i) => {
    const x = t0 != null && t1 != null ? ((peak.t - view0) / span) * width : i * step
    const y1 = mid - peak.max * mid
    const y2 = mid - peak.min * mid
    ctx.fillRect(x, Math.min(y1, y2), Math.max(1, step * 0.9), Math.max(1, Math.abs(y2 - y1)))
  })
}

export function AudioWidget({
  sourceId,
  live,
  playing = false,
  hasCapture = false,
  t0,
  t1,
  center,
  duration,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaksRef = useRef<Peak[]>([])
  const centerRef = useRef(center)
  const durationRef = useRef(duration)
  const rangeRef = useRef({ t0, t1 })
  centerRef.current = center
  durationRef.current = duration
  rangeRef.current = { t0, t1 }
  const followStream = live && !playing && !hasCapture

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      const { t0: a, t1: b } = rangeRef.current
      draw(canvas, peaksRef.current, a, b)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!followStream) return
    peaksRef.current = []
    const ws = new WebSocket(wsUrl(`/ws/live/${encodeURIComponent(sourceId)}`))
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as { t_ns: number; min: number; max: number }
      const next = [...peaksRef.current, { t: msg.t_ns, min: msg.min, max: msg.max }]
      peaksRef.current = next.slice(-240)
      if (canvasRef.current) draw(canvasRef.current, peaksRef.current)
    }
    return () => ws.close()
  }, [sourceId, followStream])

  useEffect(() => {
    if (followStream) return
    let stopped = false
    let lastKey = ''

    const pump = async () => {
      while (!stopped) {
        const now = centerRef.current
        const rawStart = playing
          ? now == null
            ? null
            : now - Math.max(durationRef.current, 500_000_000)
          : rangeRef.current.t0
        const rawStop = playing ? now : rangeRef.current.t1
        const tStart = rawStart == null ? null : Math.round(rawStart / 20_000_000) * 20_000_000
        const tStop = rawStop == null ? null : Math.round(rawStop / 20_000_000) * 20_000_000
        const key = `${tStart}:${tStop}`
        if (tStart == null || tStop == null || key === lastKey) {
          await new Promise((resolve) => window.setTimeout(resolve, 16))
          continue
        }
        try {
          const wave = await fetchWaveform(sourceId, tStart, tStop)
          if (stopped) return
          const next = wave.t.map((t, i) => ({ t, min: wave.min[i], max: wave.max[i] }))
          peaksRef.current = next
          if (canvasRef.current) draw(canvasRef.current, next, tStart, tStop)
          lastKey = key
        } catch {
          await new Promise((resolve) => window.setTimeout(resolve, 40))
        }
      }
    }
    void pump()
    return () => {
      stopped = true
    }
  }, [sourceId, followStream, playing])

  const percent = (() => {
    if (followStream) return 100
    if (playing) return 100
    if (t0 == null || t1 == null || center == null) return 50
    const span = t1 - t0
    if (span <= 0) return 50
    return Math.min(100, Math.max(0, ((center - t0) / span) * 100))
  })()

  return (
    <div className="tile-body">
      <canvas ref={canvasRef} className="audio-canvas" />
      <div className="now-bar" style={{ left: `${percent}%` }} />
      {live && <div className="stamp">LIVE</div>}
      {playing && !live && <div className="stamp">PLAY</div>}
    </div>
  )
}
