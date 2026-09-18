export type Kind = 'camera' | 'audio'
export type SplitDir = 'h' | 'v'

export type Device = {
  id: string
  kind: Kind
  label: string
  index: number
}

export type SourceInfo = {
  id: string
  kind: Kind
  label: string
  sample_rate: number | null
  live: boolean
}

export type SessionStatus = {
  recording: boolean
  t_min: number | null
  t_max: number | null
  bytes_used: number
  bytes_cap: number
  dirty: boolean
  sources: SourceInfo[]
}

export type TileSpec = {
  id: string
  sourceId: string
  kind: Kind
  label: string
}

export type Layout =
  | { type: 'leaf'; id: string }
  | { type: 'split'; direction: SplitDir; ratio: number; first: Layout; second: Layout }

export type Peer = {
  id: string
  name: string
  color: string
  live: boolean
  playing?: boolean
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

export type Waveform = {
  t: number[]
  min: number[]
  max: number[]
  sample_rate: number
}
