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

export function formatRate(hz: number) {
  if (hz >= 1_000_000) return `${hz / 1_000_000} MHz`
  if (hz >= 1000) return `${hz / 1000} kHz`
  return `${hz} Hz`
}
