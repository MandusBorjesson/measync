export type Kind = 'camera' | 'audio' | 'thermal' | 'joulescope'
export type SplitDir = 'h' | 'v'
export type JoulescopeChannel = 'current' | 'voltage' | 'power'

export type Device = {
  id: string
  kind: Kind
  label: string
  index: number
  sample_rates?: number[] | null
}

export type SourceInfo = {
  id: string
  kind: Kind
  label: string
  sample_rate: number | null
  sample_rates?: number[] | null
  output_on?: boolean | null
  live: boolean
  online?: boolean
}

export type SessionStatus = {
  recording: boolean
  t_min: number | null
  t_max: number | null
  live_t_min?: number | null
  live_t_max?: number | null
  bytes_used: number
  bytes_cap: number
  dirty: boolean
  sources: SourceInfo[]
}

export type ThermalZone = {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
}

export type TileSpec = {
  id: string
  sourceId: string
  kind: Kind
  label: string
  zones?: ThermalZone[]
  splitRatio?: number
  showGraph?: boolean
  channels?: JoulescopeChannel[]
}

export type Layout =
  | { type: 'leaf'; id: string }
  | { type: 'split'; direction: SplitDir; ratio: number; first: Layout; second: Layout }

export type Peer = {
  id: string
  name: string
  color: string
  lock_front?: boolean
  lock_back?: boolean
  center: number | null
  duration: number | null
}

export type Profile = {
  name: string
  layout: Layout | null
  tiles: Record<string, TileSpec>
  focused_id: string | null
  split_dir: SplitDir
}

export type SavedCapture = {
  name: string
  t_min: number | null
  t_max: number | null
  bytes: number | null
  sources: { id: string; kind: Kind; label: string }[]
}

export type BandSeries = {
  mean: (number | null)[]
  min: (number | null)[]
  max: (number | null)[]
}

export type Waveform = {
  t: number[]
  mean: number[]
  min: number[]
  max: number[]
  sample_rate: number
  raw?: boolean
}

export type ThermalSeries = {
  t: number[]
  min: BandSeries
  max: BandSeries
  center: BandSeries
  zones: { min: BandSeries; max: BandSeries }[]
  raw?: boolean
}

export type JoulescopeSeries = {
  t: number[]
  current: BandSeries
  voltage: BandSeries
  power: BandSeries
  sample_rate?: number
  raw?: boolean
}
