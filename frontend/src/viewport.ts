export const MIN_DURATION_NS = 20_000_000
export const DEFAULT_DURATION_NS = 2_000_000_000
export const PLAY_RATES = [0.25, 0.5, 1, 2, 4, 8] as const

export type TimeRange = {
  tMin: number | null
  tMax: number | null
}

export type Viewport = {
  center: number
  duration: number
  lockFront: boolean
  lockBack: boolean
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function viewRange(
  session: {
    recording: boolean
    t_min: number | null
    t_max: number | null
    live_t_min?: number | null
    live_t_max?: number | null
  } | null,
): TimeRange {
  if (!session) return { tMin: null, tMax: null }
  const cap = session.t_min != null && session.t_max != null
  const liv = session.live_t_min != null && session.live_t_max != null
  if (cap) return { tMin: session.t_min, tMax: session.t_max }
  if (liv) return { tMin: session.live_t_min ?? null, tMax: session.live_t_max ?? null }
  return { tMin: null, tMax: null }
}

export function applyLocks(
  center: number,
  duration: number,
  tMin: number,
  tMax: number,
  lockFront: boolean,
  lockBack: boolean,
): Viewport {
  const span = Math.max(1, tMax - tMin)
  if (lockFront && lockBack) {
    return { center: tMin + span / 2, duration: span, lockFront: true, lockBack: true }
  }
  const d = clamp(duration, MIN_DURATION_NS, span)
  const half = d / 2
  let c = center
  if (lockFront) c = tMax - half
  else if (lockBack) c = tMin + half
  else c = clamp(c, tMin + half, tMax - half)
  return { center: c, duration: d, lockFront, lockBack }
}

export function visibleRange(
  center: number,
  duration: number,
  tMin: number | null,
  tMax: number | null,
): { t0: number; t1: number } | null {
  if (tMin == null || tMax == null) return null
  const next = applyLocks(center, duration, tMin, tMax, false, false)
  return { t0: next.center - next.duration / 2, t1: next.center + next.duration / 2 }
}

export function playhead(
  lockFront: boolean,
  lockBack: boolean,
  center: number | null,
  tMin: number | null,
  tMax: number | null,
) {
  if (lockFront && lockBack) return tMin != null && tMax != null ? (tMin + tMax) / 2 : center
  if (lockFront && tMax != null) return tMax
  if (lockBack && tMin != null) return tMin
  return center ?? tMax
}

export function timeFromX(clientX: number, rect: { left: number; width: number }, tMin: number, tMax: number) {
  const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1)
  return tMin + ratio * Math.max(1, tMax - tMin)
}

export function applyWheelZoom(
  duration: number,
  deltaY: number,
  tMin: number,
  tMax: number,
  lockFront: boolean,
  lockBack: boolean,
  center: number | null,
): Viewport {
  let front = lockFront
  let back = lockBack
  if (front && back && deltaY < 0) back = false
  const range = Math.max(1, tMax - tMin)
  const next = clamp(duration * Math.exp(deltaY * 0.002), MIN_DURATION_NS, range)
  const mid = center ?? tMin + range / 2
  return applyLocks(mid, next, tMin, tMax, front, back)
}

export function applySeek(
  clientX: number,
  rect: { left: number; width: number },
  tMin: number,
  tMax: number,
  duration: number,
): Viewport {
  return applyLocks(timeFromX(clientX, rect, tMin, tMax), duration, tMin, tMax, false, false)
}

export function applyPanDelta(
  startCenter: number,
  startX: number,
  clientX: number,
  plotWidth: number,
  viewSpan: number,
  tMin: number,
  tMax: number,
  duration: number,
): Viewport {
  const dt = -((clientX - startX) / Math.max(1, plotWidth)) * viewSpan
  return applyLocks(startCenter + dt, duration, tMin, tMax, false, false)
}

export function advancePlayhead(
  from: number,
  elapsedMs: number,
  rate: number,
  tMin: number,
  tMax: number,
): { t: number; done: boolean } {
  const next = from + elapsedMs * 1e6 * rate
  if (next >= tMax) return { t: tMax, done: true }
  if (next <= tMin) return { t: tMin, done: false }
  return { t: next, done: false }
}

export function queryWindow(t0: number | null, t1: number | null): { t0: number; t1: number } | null {
  if (t0 == null || t1 == null) return null
  return { t0: Math.round(t0), t1: Math.round(t1) }
}
