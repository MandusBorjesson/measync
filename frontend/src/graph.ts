import type { BandSeries } from './types'

export type GraphLine = {
  id: string
  label: string
  color: string
  unit?: string
  dashed?: boolean
  mean: (number | null)[]
  min: (number | null)[]
  max: (number | null)[]
}

export function emptyBand(): BandSeries {
  return { mean: [], min: [], max: [] }
}

export function appendBand(band: BandSeries, value: number | null, cap = 240): BandSeries {
  const mean = [...band.mean, value]
  const min = [...band.min, value]
  const max = [...band.max, value]
  if (mean.length <= cap) return { mean, min, max }
  return { mean: mean.slice(-cap), min: min.slice(-cap), max: max.slice(-cap) }
}

export function hasBand(min: number | null, max: number | null) {
  return min != null && max != null && Number.isFinite(min) && Number.isFinite(max) && min !== max
}

export const GRAPH_POINTS = 100
export const GRAPH_POINTS_MIN = 16
export const GRAPH_POINTS_MAX = 2000
export const GRAPH_POINT_CHOICES = [50, 100, 200, 400, 800] as const
const PLOT_POINTS_KEY = 'measync.plotPoints'

export function clampGraphPoints(value: number) {
  if (!Number.isFinite(value)) return GRAPH_POINTS
  return Math.min(GRAPH_POINTS_MAX, Math.max(GRAPH_POINTS_MIN, Math.round(value)))
}

export function loadPlotPoints() {
  const n = clampGraphPoints(Number(localStorage.getItem(PLOT_POINTS_KEY)) || GRAPH_POINTS)
  return (GRAPH_POINT_CHOICES as readonly number[]).includes(n) ? n : GRAPH_POINTS
}

export function savePlotPoints(value: number) {
  const next = clampGraphPoints(value)
  localStorage.setItem(PLOT_POINTS_KEY, String(next))
  return next
}

export function formatRate(hz: number) {
  if (hz >= 1_000_000) return `${hz / 1_000_000} MHz`
  if (hz >= 1000) return `${hz / 1000} kHz`
  return `${hz} Hz`
}
