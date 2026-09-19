import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { formatSi, hasBand, type GraphLine } from '../graph'
import { applyPanDelta, applyWheelZoom, type Viewport } from '../viewport'

const PAD_L = 58
const PAD_R = 8
const TIME_STEPS_NS = [
  1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8, 2e8, 5e8, 1e9, 2e9, 5e9, 10e9, 15e9, 30e9, 60e9,
]

function formatTimeOffset(t: number, origin: number, stepNs: number) {
  const s = (t - origin) / 1e9
  if (stepNs < 1e9) return `${s.toFixed(3)}s`
  if (stepNs < 10e9) return `${s.toFixed(2)}s`
  return `${s.toFixed(1)}s`
}

function timeTicks(view0: number, view1: number, origin: number, maxTicks: number) {
  const span = Math.max(1, view1 - view0)
  let step = TIME_STEPS_NS[TIME_STEPS_NS.length - 1]
  for (const candidate of TIME_STEPS_NS) {
    if (span / candidate <= maxTicks) {
      step = candidate
      break
    }
  }
  const start = origin + Math.ceil((view0 - origin) / step) * step
  const ticks: number[] = []
  for (let t = start; t <= view1 + 1; t += step) {
    if (t >= view0 - 1) ticks.push(t)
    if (ticks.length > maxTicks + 2) break
  }
  return { ticks, step }
}

function sampleAt(times: number[], values: (number | null)[], at: number) {
  const n = Math.min(times.length, values.length)
  if (n <= 0) return null
  if (at <= times[0]) {
    const v = values[0]
    return v == null || !Number.isFinite(v) ? null : v
  }
  if (at >= times[n - 1]) {
    const v = values[n - 1]
    return v == null || !Number.isFinite(v) ? null : v
  }
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= at) lo = mid
    else hi = mid
  }
  const a = values[lo]
  const b = values[hi]
  const aOk = a != null && Number.isFinite(a)
  const bOk = b != null && Number.isFinite(b)
  if (!aOk) return bOk ? b : null
  if (!bOk) return a
  const dt = times[hi] - times[lo]
  if (dt <= 0) return a
  return a + ((b - a) * (at - times[lo])) / dt
}

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
  rangeMin?: number | null,
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
  const padB = 22 * dpr
  const plotW = Math.max(1, width - padL - padR)
  const plotH = Math.max(1, height - padT - padB)
  const view0 = t0 ?? t[0] ?? 0
  const view1 = t1 ?? t[t.length - 1] ?? 1
  const span = Math.max(1, view1 - view0)
  const origin = rangeMin ?? view0
  const xOf = (ns: number) => padL + ((ns - view0) / span) * plotW
  const axisY = padT + plotH
  const maxTimeTicks = Math.max(3, Math.min(8, Math.floor(plotW / (72 * dpr))))
  const { ticks: xTicks, step: xStep } = timeTicks(view0, view1, origin, maxTimeTicks)

  ctx.strokeStyle = '#1d2838'
  ctx.lineWidth = dpr
  ctx.beginPath()
  ctx.moveTo(padL, padT)
  ctx.lineTo(padL, axisY)
  ctx.lineTo(padL + plotW, axisY)
  ctx.stroke()

  ctx.font = `${Math.round(11 * dpr)}px "IBM Plex Mono", monospace`
  ctx.textBaseline = 'top'
  ctx.textAlign = 'center'
  ctx.fillStyle = '#8b9bb0'
  for (const ns of xTicks) {
    const x = xOf(ns)
    if (x < padL - 1 || x > padL + plotW + 1) continue
    ctx.strokeStyle = '#16202c'
    ctx.beginPath()
    ctx.moveTo(x, padT)
    ctx.lineTo(x, axisY)
    ctx.stroke()
    ctx.strokeStyle = '#1d2838'
    ctx.beginPath()
    ctx.moveTo(x, axisY)
    ctx.lineTo(x, axisY + 4 * dpr)
    ctx.stroke()
    const label = formatTimeOffset(ns, origin, xStep)
    const tw = ctx.measureText(label).width
    if (x - tw / 2 < 2 * dpr || x + tw / 2 > width - 2 * dpr) continue
    ctx.fillText(label, x, axisY + 6 * dpr)
  }

  if (bounds) {
    const [lo, hi] = bounds
    const ticks = 4
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    const fmt = formatTick ?? ((value: number) => formatSi(value, yLabel ?? ''))
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
    ctx.lineTo(x, axisY)
    ctx.stroke()
    if (bounds) {
      const [lo, hi] = bounds
      const yOf = (v: number) => padT + ((hi - v) / (hi - lo)) * plotH
      const alignRight = x > padL + plotW * 0.62
      const labelX = alignRight ? x - 8 * dpr : x + 8 * dpr
      const readouts: { text: string; color: string; y: number }[] = []
      for (const line of lines) {
        const value = sampleAt(t, line.mean, playT)
        if (value == null) continue
        readouts.push({
          text: formatSi(value, line.unit ?? yLabel ?? ''),
          color: line.color,
          y: Math.min(axisY - 8 * dpr, Math.max(padT + 8 * dpr, yOf(value))),
        })
      }
      readouts.sort((a, b) => a.y - b.y)
      const gap = 14 * dpr
      for (let i = 1; i < readouts.length; i++) {
        if (readouts[i].y - readouts[i - 1].y < gap) {
          readouts[i].y = readouts[i - 1].y + gap
        }
      }
      if (readouts.length && readouts[readouts.length - 1].y > axisY - 8 * dpr) {
        let shift = readouts[readouts.length - 1].y - (axisY - 8 * dpr)
        for (const item of readouts) item.y -= shift
        if (readouts[0].y < padT + 8 * dpr) {
          shift = padT + 8 * dpr - readouts[0].y
          for (const item of readouts) item.y += shift
        }
      }
      ctx.font = `${Math.round(11 * dpr)}px "IBM Plex Mono", monospace`
      ctx.textAlign = alignRight ? 'right' : 'left'
      ctx.textBaseline = 'middle'
      for (const item of readouts) {
        const tw = ctx.measureText(item.text).width
        const th = 14 * dpr
        const pad = 3 * dpr
        const boxX = alignRight ? labelX - tw - pad : labelX - pad
        ctx.fillStyle = 'rgba(8, 11, 16, 0.78)'
        ctx.fillRect(boxX, item.y - th / 2, tw + pad * 2, th)
        ctx.fillStyle = item.color
        ctx.fillText(item.text, labelX, item.y)
      }
    }
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
  const dataRef = useRef({ t, visible, t0, t1, center, lockFront, lockBack, yLabel, formatTick, sampleDots, rangeMin })
  const yHoldRef = useRef({ octave: 0, bounds: null as [number, number] | null })
  const scrubRef = useRef({ center, duration, rangeMin, rangeMax, t0, t1, lockFront, lockBack, onScrub })
  scrubRef.current = { center, duration, rangeMin, rangeMax, t0, t1, lockFront, lockBack, onScrub }

  useEffect(() => {
    dataRef.current = { t, visible, t0, t1, center, lockFront, lockBack, yLabel, formatTick, sampleDots, rangeMin }
    const canvas = canvasRef.current
    if (!canvas) return
    const paint = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const width = Math.max(1, Math.floor(rect.width * dpr))
      const height = Math.max(1, Math.floor(rect.height * dpr))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
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
        d.rangeMin,
      )
    }
    paint()
    const observer = new ResizeObserver(paint)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [t, visible, t0, t1, center, lockFront, lockBack, yLabel, formatTick, sampleDots, rangeMin])

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
