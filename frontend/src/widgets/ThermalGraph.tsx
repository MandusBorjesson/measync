import { useEffect, useRef } from 'react'
import {
  GLOBAL_COLORS,
  LINE_CENTER,
  LINE_GLOBAL_MAX,
  LINE_GLOBAL_MIN,
  type ThermalSeries,
  type ThermalZone,
  zoneColor,
  zoneLineId,
} from '../thermal'

type Props = {
  series: ThermalSeries
  zones: ThermalZone[]
  t0: number | null
  t1: number | null
  center: number | null
  live: boolean
  playing?: boolean
  hidden: Record<string, boolean>
  onToggle: (id: string) => void
}

type Line = {
  id: string
  label: string
  color: string
  dashed?: boolean
  values: (number | null)[]
}

function linesFor(series: ThermalSeries, zones: ThermalZone[]): Line[] {
  const lines: Line[] = [
    { id: LINE_GLOBAL_MAX, label: 'global max', color: GLOBAL_COLORS.max, values: series.max },
    { id: LINE_CENTER, label: 'center', color: GLOBAL_COLORS.center, values: series.center },
    { id: LINE_GLOBAL_MIN, label: 'global min', color: GLOBAL_COLORS.min, values: series.min },
  ]
  zones.forEach((zone, i) => {
    const data = series.zones[i]
    const color = zoneColor(zone, i)
    lines.push({ id: zoneLineId(zone.id, 'max'), label: `${zone.name} max`, color, values: data?.max ?? [] })
    lines.push({
      id: zoneLineId(zone.id, 'min'),
      label: `${zone.name} min`,
      color,
      dashed: true,
      values: data?.min ?? [],
    })
  })
  return lines
}

function yBounds(lines: Line[]): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const line of lines) {
    for (const v of line.values) {
      if (v == null || !Number.isFinite(v)) continue
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  if (hi - lo < 1e-3) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.12
  return [lo - pad, hi + pad]
}

function draw(
  canvas: HTMLCanvasElement,
  series: ThermalSeries,
  zones: ThermalZone[],
  hidden: Record<string, boolean>,
  t0?: number | null,
  t1?: number | null,
  center?: number | null,
  live?: boolean,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  const dpr = window.devicePixelRatio || 1
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#080b10'
  ctx.fillRect(0, 0, width, height)

  const lines = linesFor(series, zones)
  const visible = lines.filter((line) => !hidden[line.id])
  const bounds = yBounds(visible)
  const padL = 44 * dpr
  const padR = 8 * dpr
  const padT = 10 * dpr
  const padB = 8 * dpr
  const plotW = Math.max(1, width - padL - padR)
  const plotH = Math.max(1, height - padT - padB)
  const view0 = t0 ?? series.t[0] ?? 0
  const view1 = t1 ?? series.t[series.t.length - 1] ?? 1
  const span = Math.max(1, view1 - view0)

  ctx.strokeStyle = '#1d2838'
  ctx.lineWidth = dpr
  ctx.beginPath()
  ctx.moveTo(padL, padT)
  ctx.lineTo(padL, padT + plotH)
  ctx.lineTo(padL + plotW, padT + plotH)
  ctx.stroke()

  const xOf = (t: number) => padL + ((t - view0) / span) * plotW

  if (bounds) {
    const [lo, hi] = bounds
    const ticks = 4
    ctx.font = `${Math.round(11 * dpr)}px "IBM Plex Mono", monospace`
    ctx.fillStyle = '#8b9bb0'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks
      const y = padT + plotH * (1 - frac)
      const value = lo + (hi - lo) * frac
      ctx.strokeStyle = '#16202c'
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + plotW, y)
      ctx.stroke()
      ctx.fillText(`${value.toFixed(1)}`, padL - 6 * dpr, y)
    }
    ctx.save()
    ctx.translate(12 * dpr, padT + plotH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#8b9bb0'
    ctx.fillText('°C', 0, 0)
    ctx.restore()

    const yOf = (v: number) => padT + ((hi - v) / (hi - lo)) * plotH

    for (const line of visible) {
      ctx.strokeStyle = line.color
      ctx.lineWidth = Math.max(1.2, dpr)
      if (line.dashed) ctx.setLineDash([6 * dpr, 4 * dpr])
      else ctx.setLineDash([])
      ctx.beginPath()
      let drawing = false
      const n = Math.min(line.values.length, series.t.length)
      for (let i = 0; i < n; i++) {
        const v = line.values[i]
        if (v == null || !Number.isFinite(v)) {
          drawing = false
          continue
        }
        const x = xOf(series.t[i])
        const y = yOf(v)
        if (!drawing) {
          ctx.moveTo(x, y)
          drawing = true
        } else {
          ctx.lineTo(x, y)
        }
      }
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  const playT = live ? view1 : center
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

export function ThermalGraph({
  series,
  zones,
  t0,
  t1,
  center,
  live,
  playing = false,
  hidden,
  onToggle,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dataRef = useRef({ series, zones, t0, t1, center, live, playing, hidden })

  useEffect(() => {
    dataRef.current = { series, zones, t0, t1, center, live, playing, hidden }
    const canvas = canvasRef.current
    if (!canvas) return
    const paint = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      const d = dataRef.current
      draw(canvas, d.series, d.zones, d.hidden, d.t0, d.t1, d.center, d.live && !d.playing)
    }
    paint()
    const observer = new ResizeObserver(paint)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [series, zones, t0, t1, center, live, playing, hidden])

  const legend = linesFor(series, zones)

  return (
    <div className="thermal-graph">
      <canvas ref={canvasRef} className="thermal-graph-canvas" />
      <div className="thermal-legend" aria-label="Temperature series">
        {legend.map((line) => {
          const on = !hidden[line.id]
          return (
            <button
              key={line.id}
              type="button"
              className={`thermal-legend-item${on ? '' : ' off'}`}
              aria-pressed={on}
              title={on ? `Hide ${line.label}` : `Show ${line.label}`}
              onClick={() => onToggle(line.id)}
            >
              <i
                className={`thermal-legend-swatch${line.dashed ? ' dashed' : ''}`}
                style={{ color: line.color, background: line.dashed ? undefined : line.color }}
              />
              {line.label}
            </button>
          )
        })}
      </div>
      {series.t.length === 0 && (
        <div className="thermal-graph-empty">global min / max / center · drag a zone on the image</div>
      )}
    </div>
  )
}
