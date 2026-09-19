import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { hasBand, type GraphLine } from '../graph'
import { applyPanDelta, applyWheelZoom, type Viewport } from '../viewport'

const PAD_L = 52
const PAD_R = 8

type Props = {
  t: number[]
  lines: GraphLine[]
  t0: number | null
  t1: number | null
  center: number | null
  live: boolean
  lockFront?: boolean
  lockBack?: boolean
  duration?: number
  rangeMin?: number | null
  rangeMax?: number | null
  onScrub?: (next: Viewport) => void
  hidden?: Record<string, boolean>
  onToggle?: (id: string) => void
  yLabel?: string
  emptyHint?: string
  legend?: boolean
  sampleDots?: boolean
  formatTick?: (value: number) => string
}

function yBounds(lines: GraphLine[]): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const line of lines) {
    const series = [line.mean, line.min, line.max]
    for (const values of series) {
      for (const v of values) {
        if (v == null || !Number.isFinite(v)) continue
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  if (hi - lo < 1e-12) {
    const pad = Math.max(Math.abs(hi) * 0.05, 1e-6)
    lo -= pad
    hi += pad
  }
  const pad = (hi - lo) * 0.12
  return [lo - pad, hi + pad]
}

function zoomOctave(t0: number | null | undefined, t1: number | null | undefined) {
  const span = (t1 ?? 0) - (t0 ?? 0)
  if (span <= 0) return 0
  return Math.round(Math.log2(span))
}

function stabilizeY(
  prev: [number, number] | null,
  next: [number, number],
  reset: boolean,
): [number, number] {
  if (!prev || reset) return next
  const [plo, phi] = prev
  const [nlo, nhi] = next
  const pspan = Math.max(phi - plo, 1e-18)
  const nspan = Math.max(nhi - nlo, 1e-18)
  if (nlo < plo || nhi > phi) {
    return [Math.min(plo, nlo), Math.max(phi, nhi)]
  }
  if (nspan > pspan * 0.5) return prev
  return [plo + (nlo - plo) * 0.2, phi + (nhi - phi) * 0.2]
}

function draw(
  canvas: HTMLCanvasElement,
  t: number[],
  lines: GraphLine[],
  t0?: number | null,
  t1?: number | null,
  center?: number | null,
  lockFront?: boolean,
  lockBack?: boolean,
  yLabel?: string,
  formatTick?: (value: number) => string,
  yHold?: { octave: number; bounds: [number, number] | null },
  sampleDots?: boolean,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  const dpr = window.devicePixelRatio || 1
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#080b10'
  ctx.fillRect(0, 0, width, height)

  const raw = yBounds(lines)
  const octave = zoomOctave(t0, t1)
  const bounds = raw
    ? stabilizeY(yHold?.bounds ?? null, raw, !yHold || yHold.octave !== octave)
    : null
  if (yHold && bounds) {
    yHold.octave = octave
    yHold.bounds = bounds
  }
  const padL = PAD_L * dpr
  const padR = PAD_R * dpr
  const padT = 10 * dpr
  const padB = 8 * dpr
  const plotW = Math.max(1, width - padL - padR)
  const plotH = Math.max(1, height - padT - padB)
  const view0 = t0 ?? t[0] ?? 0
  const view1 = t1 ?? t[t.length - 1] ?? 1
  const span = Math.max(1, view1 - view0)
  const xOf = (ns: number) => padL + ((ns - view0) / span) * plotW

  ctx.strokeStyle = '#1d2838'
  ctx.lineWidth = dpr
  ctx.beginPath()
  ctx.moveTo(padL, padT)
  ctx.lineTo(padL, padT + plotH)
  ctx.lineTo(padL + plotW, padT + plotH)
  ctx.stroke()

  if (bounds) {
    const [lo, hi] = bounds
    const ticks = 4
    ctx.font = `${Math.round(11 * dpr)}px "IBM Plex Mono", monospace`
    ctx.fillStyle = '#8b9bb0'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    const fmt = formatTick ?? ((value: number) => {
      const abs = Math.abs(value)
      if (abs >= 100) return value.toFixed(0)
      if (abs >= 10) return value.toFixed(1)
      if (abs >= 1) return value.toFixed(2)
      if (abs >= 0.01) return value.toFixed(3)
      return value.toExponential(1)
    })
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks
      const y = padT + plotH * (1 - frac)
      const value = lo + (hi - lo) * frac
      ctx.strokeStyle = '#16202c'
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + plotW, y)
      ctx.stroke()
      ctx.fillText(fmt(value), padL - 6 * dpr, y)
    }
    if (yLabel) {
      ctx.save()
      ctx.translate(12 * dpr, padT + plotH / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.textAlign = 'center'
      ctx.fillStyle = '#8b9bb0'
      ctx.fillText(yLabel, 0, 0)
      ctx.restore()
    }

    const yOf = (v: number) => padT + ((hi - v) / (hi - lo)) * plotH

    for (const line of lines) {
      const n = Math.min(line.mean.length, t.length)
      ctx.fillStyle = line.color
      ctx.globalAlpha = 0.22
      let bandStart = -1
      const flushBand = (from: number, to: number) => {
        if (to - from < 1) return
        ctx.beginPath()
        for (let i = from; i <= to; i++) {
          const hiV = line.max[i]
          if (hiV == null || !Number.isFinite(hiV)) continue
          const x = xOf(t[i])
          if (i === from) ctx.moveTo(x, yOf(hiV))
          else ctx.lineTo(x, yOf(hiV))
        }
        for (let i = to; i >= from; i--) {
          const loV = line.min[i]
          if (loV == null || !Number.isFinite(loV)) continue
          ctx.lineTo(xOf(t[i]), yOf(loV))
        }
        ctx.closePath()
        ctx.fill()
      }
      for (let i = 0; i < n; i++) {
        const open = hasBand(line.min[i], line.max[i])
        if (open) {
          if (bandStart < 0) bandStart = i
        } else if (bandStart >= 0) {
          flushBand(bandStart, i - 1)
          bandStart = -1
        }
      }
      if (bandStart >= 0) flushBand(bandStart, n - 1)
      ctx.globalAlpha = 1

      ctx.strokeStyle = line.color
      ctx.lineWidth = Math.max(1.2, dpr)
      if (line.dashed) ctx.setLineDash([6 * dpr, 4 * dpr])
      else ctx.setLineDash([])
      ctx.beginPath()
      let drawing = false
      let lastX = Number.NEGATIVE_INFINITY
      for (let i = 0; i < n; i++) {
        const v = line.mean[i]
        if (v == null || !Number.isFinite(v)) {
          drawing = false
          continue
        }
        const x = xOf(t[i])
        if (!Number.isFinite(x) || x < lastX) {
          drawing = false
        }
        const y = yOf(v)
        if (!drawing) {
          ctx.moveTo(x, y)
          drawing = true
        } else {
          ctx.lineTo(x, y)
        }
        lastX = x
      }
      ctx.stroke()
      if (sampleDots) {
        ctx.setLineDash([])
        ctx.fillStyle = line.color
        const dot = Math.max(2.2, 1.8 * dpr)
        for (let i = 0; i < n; i++) {
          if (hasBand(line.min[i], line.max[i])) continue
          const v = line.mean[i]
          if (v == null || !Number.isFinite(v)) continue
          const x = xOf(t[i])
          const y = yOf(v)
          if (x < padL - dot || x > padL + plotW + dot) continue
          ctx.beginPath()
          ctx.arc(x, y, dot, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  const playT = lockFront && lockBack ? null : lockFront ? view1 : center
  if (playT != null) {
    const x = Math.min(padL + plotW, Math.max(padL, xOf(playT)))
    ctx.strokeStyle = '#ff3b4e'
    ctx.lineWidth = Math.max(2, dpr)
    ctx.beginPath()
    ctx.moveTo(x, padT)
    ctx.lineTo(x, padT + plotH)
    ctx.stroke()
  }
}

export function GraphPlot({
  t,
  lines,
  t0,
  t1,
  center,
  live: _live,
  lockFront = false,
  lockBack = false,
  duration,
  rangeMin,
  rangeMax,
  onScrub,
  hidden,
  onToggle,
  yLabel,
  emptyHint,
  legend = true,
  sampleDots = false,
  formatTick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const visible = lines.filter((line) => !hidden?.[line.id])
  const dataRef = useRef({ t, visible, t0, t1, center, lockFront, lockBack, yLabel, formatTick, sampleDots })
  const yHoldRef = useRef({ octave: 0, bounds: null as [number, number] | null })
  const scrubRef = useRef({ center, duration, rangeMin, rangeMax, t0, t1, lockFront, lockBack, onScrub })
  scrubRef.current = { center, duration, rangeMin, rangeMax, t0, t1, lockFront, lockBack, onScrub }

  useEffect(() => {
    dataRef.current = { t, visible, t0, t1, center, lockFront, lockBack, yLabel, formatTick, sampleDots }
    const canvas = canvasRef.current
    if (!canvas) return
    const paint = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      const d = dataRef.current
      draw(
        canvas,
        d.t,
        d.visible,
        d.t0,
        d.t1,
        d.center,
        d.lockFront,
        d.lockBack,
        d.yLabel,
        d.formatTick,
        yHoldRef.current,
        d.sampleDots,
      )
    }
    paint()
    const observer = new ResizeObserver(paint)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [t, visible, t0, t1, center, lockFront, lockBack, yLabel, formatTick, sampleDots])

  useEffect(() => {
    const root = rootRef.current
    if (!root || !onScrub) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const {
        rangeMin: min,
        rangeMax: max,
        duration: dur,
        lockFront: front,
        lockBack: back,
        center: cur,
        onScrub: scrub,
      } = scrubRef.current
      if (min == null || max == null || dur == null || !scrub) return
      scrub(applyWheelZoom(dur, event.deltaY, min, max, front, back, cur))
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [onScrub])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !onScrub) return
    if ((event.target as HTMLElement).closest('.graph-legend')) return
    const { rangeMin: min, rangeMax: max, duration: dur, center: cur, t0: view0, t1: view1 } = scrubRef.current
    if (min == null || max == null || dur == null) return
    event.preventDefault()
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!rect) return
    const plotWidth = Math.max(1, rect.width - PAD_L - PAD_R)
    const startCenter = cur ?? (view0 != null && view1 != null ? (view0 + view1) / 2 : min)
    const viewSpan = view0 != null && view1 != null ? Math.max(1, view1 - view0) : dur
    const startX = event.clientX
    event.currentTarget.setPointerCapture(event.pointerId)
    let dragged = false
    const apply = (clientX: number) => {
      if (!dragged && Math.abs(clientX - startX) < 3) return
      dragged = true
      const { rangeMin: a, rangeMax: b, duration: d, onScrub: scrub } = scrubRef.current
      if (a == null || b == null || d == null || !scrub) return
      scrub(applyPanDelta(startCenter, startX, clientX, plotWidth, viewSpan, a, b, d))
    }
    const move = (ev: PointerEvent) => apply(ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className={`graph-plot${onScrub ? ' interactive' : ''}`}
      ref={rootRef}
      onPointerDown={onScrub ? onPointerDown : undefined}
    >
      <canvas ref={canvasRef} className="graph-plot-canvas" />
      {legend && onToggle && (
        <div className="graph-legend" aria-label="Graph series">
          {lines.map((line) => {
            const on = !hidden?.[line.id]
            return (
              <button
                key={line.id}
                type="button"
                className={`graph-legend-item${on ? '' : ' off'}`}
                aria-pressed={on}
                title={on ? `Hide ${line.label}` : `Show ${line.label}`}
                onClick={() => onToggle(line.id)}
              >
                <i
                  className={`graph-legend-swatch${line.dashed ? ' dashed' : ''}`}
                  style={{ color: line.color, background: line.dashed ? undefined : line.color }}
                />
                {line.label}
              </button>
            )
          })}
        </div>
      )}
      {t.length === 0 && emptyHint ? <div className="graph-plot-empty">{emptyHint}</div> : null}
    </div>
  )
}
