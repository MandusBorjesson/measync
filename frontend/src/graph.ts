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

export function sampleAt(times: number[], values: (number | null)[], at: number) {
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

export const LIVE_FETCH_MS = 200
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

const SI_PREFIXES: { exp: number; symbol: string }[] = [
  { exp: -24, symbol: 'y' },
  { exp: -21, symbol: 'z' },
  { exp: -18, symbol: 'a' },
  { exp: -15, symbol: 'f' },
  { exp: -12, symbol: 'p' },
  { exp: -9, symbol: 'n' },
  { exp: -6, symbol: 'µ' },
  { exp: -3, symbol: 'm' },
  { exp: 0, symbol: '' },
  { exp: 3, symbol: 'k' },
  { exp: 6, symbol: 'M' },
  { exp: 9, symbol: 'G' },
  { exp: 12, symbol: 'T' },
  { exp: 15, symbol: 'P' },
  { exp: 18, symbol: 'E' },
]

const NO_SI_PREFIX = new Set(['°C', 'C', '%', 'dB'])

function formatMantissa(scaled: number) {
  if (scaled >= 100) return scaled.toFixed(0)
  if (scaled >= 10) return scaled.toFixed(1)
  return scaled.toFixed(2)
}

/** SI prefix when it fits (12.0mA, 3.30kV); scientific notation otherwise. */
export function formatSi(value: number, unit = '') {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return unit ? `0${unit}` : '0'
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (NO_SI_PREFIX.has(unit)) {
    if (abs >= 1e4 || abs < 1e-3) return `${value.toExponential(2)}${unit}`
    if (abs >= 100) return `${sign}${abs.toFixed(0)}${unit}`
    if (abs >= 10) return `${sign}${abs.toFixed(1)}${unit}`
    return `${sign}${abs.toFixed(2)}${unit}`
  }
  if (!unit) {
    if (abs >= 1e4 || abs < 1e-3) return value.toExponential(2)
    return sign + formatMantissa(abs)
  }
  let exp = Math.floor(Math.log10(abs) / 3) * 3
  let scaled = abs / 10 ** exp
  if (scaled >= 1000) {
    exp += 3
    scaled = abs / 10 ** exp
  } else if (scaled < 1) {
    exp -= 3
    scaled = abs / 10 ** exp
  }
  const prefix = SI_PREFIXES.find((item) => item.exp === exp)
  if (!prefix) return `${value.toExponential(2)}${unit}`
  return `${sign}${formatMantissa(scaled)}${prefix.symbol}${unit}`
}

export function formatRate(hz: number) {
  if (hz >= 1_000_000) return `${hz / 1_000_000} MHz`
  if (hz >= 1000) return `${hz / 1000} kHz`
  return `${hz} Hz`
}
