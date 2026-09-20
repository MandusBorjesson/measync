import { sampleAt } from './graph'

export const MAX_MARKERS = 8

export type PlaceMode = 'single' | 'dual' | null

export type MeasureMarker =
  | { id: string; name: string; kind: 'single'; t: number }
  | { id: string; name: string; kind: 'dual'; t: number; dt: number }

export type LineStats = { min: number; max: number; avg: number; integral: number }

export type MeasureControls = {
  markers: MeasureMarker[]
  placeMode: PlaceMode
  setPlaceMode: (mode: PlaceMode) => void
  place: (kind: 'single' | 'dual', t: number, dt?: number) => void
  move: (id: string, patch: { t: number; dt?: number }) => void
  rename: (id: string, name: string) => void
  remove: (id: string) => void
  jump: (id: string) => void
}

const MARKER_COLORS = ['#5eead4', '#c4b5fd', '#f9a8d4', '#fcd34d', '#93c5fd', '#86efac', '#fdba74', '#fca5a5']

export function markerColor(_marker: MeasureMarker, index: number) {
  return MARKER_COLORS[index % MARKER_COLORS.length]
}

export function nextMarkerName(markers: MeasureMarker[], kind: 'single' | 'dual') {
  const prefix = kind === 'single' ? 'C' : 'D'
  const used = new Set(markers.map((m) => m.name))
  for (let i = 1; i < 100; i++) {
    const name = `${prefix}${i}`
    if (!used.has(name)) return name
  }
  return `${prefix}${markers.length + 1}`
}

export function dualRange(t: number, dt: number) {
  const t1 = t + dt
  return t <= t1 ? { t0: t, t1 } : { t0: t1, t1: t }
}

export function markerCenter(marker: MeasureMarker) {
  if (marker.kind === 'single') return marker.t
  const { t0, t1 } = dualRange(marker.t, marker.dt)
  return (t0 + t1) / 2
}

export function formatDeltaNs(ns: number) {
  const sign = ns < 0 ? '-' : ''
  const abs = Math.abs(ns)
  if (abs < 1e6) return `${sign}${(abs / 1e3).toFixed(0)}µs`
  if (abs < 1e9) {
    const ms = abs / 1e6
    const digits = ms < 10 ? 2 : ms < 100 ? 1 : 0
    return `${sign}${ms.toFixed(digits)}ms`
  }
  return `${sign}${(abs / 1e9).toFixed(3)}s`
}

export function integralUnit(unit: string) {
  if (!unit) return 's'
  return `${unit}s`
}

export function lineStats(
  times: number[],
  mean: (number | null)[],
  lo: (number | null)[],
  hi: (number | null)[],
  t0: number,
  t1: number,
): LineStats | null {
  const a = Math.min(t0, t1)
  const b = Math.max(t0, t1)
  if (!(b > a)) return null
  const pts: { t: number; y: number; lo: number; hi: number }[] = []
  const pushAt = (at: number) => {
    const y = sampleAt(times, mean, at)
    if (y == null) return
    pts.push({
      t: at,
      y,
      lo: sampleAt(times, lo, at) ?? y,
      hi: sampleAt(times, hi, at) ?? y,
    })
  }
  pushAt(a)
  const n = Math.min(times.length, mean.length)
  for (let i = 0; i < n; i++) {
    const t = times[i]
    if (t <= a || t >= b) continue
    const y = mean[i]
    if (y == null || !Number.isFinite(y)) continue
    const lv = lo[i]
    const hv = hi[i]
    pts.push({
      t,
      y,
      lo: lv != null && Number.isFinite(lv) ? lv : y,
      hi: hv != null && Number.isFinite(hv) ? hv : y,
    })
  }
  pushAt(b)
  if (!pts.length) return null
  pts.sort((p, q) => p.t - q.t)
  let minV = pts[0].lo
  let maxV = pts[0].hi
  let area = 0
  for (const p of pts) {
    minV = Math.min(minV, p.lo)
    maxV = Math.max(maxV, p.hi)
  }
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1e9
    if (dt <= 0) continue
    area += 0.5 * (pts[i - 1].y + pts[i].y) * dt
  }
  const span = (b - a) / 1e9
  if (pts.length === 1) area = pts[0].y * span
  return { min: minV, max: maxV, avg: span > 0 ? area / span : pts[0].y, integral: area }
}
