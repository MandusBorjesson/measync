import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchWaveform } from '../api'
import { playCaptureAudio } from '../audioReplay'
import { LIVE_FETCH_MS, type GraphLine } from '../graph'
import { queryWindow, type Viewport } from '../viewport'
import { GraphPlot } from './GraphPlot'
import type { MeasureControls } from '../markers'

type BandPoint = { t: number; mean: number; min: number; max: number }

type Props = {
  sourceId: string
  live: boolean
  lockFront?: boolean
  lockBack?: boolean
  hasCapture?: boolean
  recording?: boolean
  t0: number | null
  t1: number | null
  center: number | null
  duration?: number
  rangeMin?: number | null
  rangeMax?: number | null
  onScrub?: (next: Viewport) => void
  plotPoints?: number
  online?: boolean
  showMarker?: boolean
  playing?: boolean
  playRate?: number
  measure?: MeasureControls
}

const LINE_ID = 'amplitude'

function toLine(points: BandPoint[]): GraphLine {
  return {
    id: LINE_ID,
    label: 'amplitude',
    color: '#f0a202',
    mean: points.map((p) => p.mean),
    min: points.map((p) => p.min),
    max: points.map((p) => p.max),
  }
}

export function AudioWidget({
  sourceId,
  live,
  lockFront = false,
  lockBack = false,
  t0,
  t1,
  center,
  duration,
  rangeMin,
  rangeMax,
  onScrub,
  plotPoints,
  online = true,
  showMarker = false,
  playing = false,
  playRate = 1,
  measure,
}: Props) {
  const rangeRef = useRef({ t0, t1, live, plotPoints })
  const [points, setPoints] = useState<BandPoint[]>([])
  const [raw, setRaw] = useState(false)
  rangeRef.current = { t0, t1, live, plotPoints }

  useEffect(() => {
    let stopped = false
    let lastKey = ''
    let lastFetch = 0
    const pump = async () => {
      while (!stopped) {
        const { t0: rawStart, t1: rawStop, live: isLive, plotPoints: pointsCap } = rangeRef.current
        const win = queryWindow(rawStart, rawStop)
        const tStart = win?.t0 ?? null
        const tStop = win?.t1 ?? null
        const key = `${tStart}:${tStop}:${pointsCap ?? ''}`
        const now = performance.now()
        if (tStart == null || tStop == null) {
          await new Promise((resolve) => window.setTimeout(resolve, 16))
          continue
        }
        if (!isLive && key === lastKey) {
          await new Promise((resolve) => window.setTimeout(resolve, 16))
          continue
        }
        if (now - lastFetch < LIVE_FETCH_MS) {
          await new Promise((resolve) => window.setTimeout(resolve, LIVE_FETCH_MS - (now - lastFetch)))
          continue
        }
        try {
          const wave = await fetchWaveform(sourceId, tStart, tStop, pointsCap)
          if (stopped) return
          setPoints(
            wave.t.map((t, i) => ({
              t,
              mean: wave.mean[i] ?? (wave.min[i] + wave.max[i]) / 2,
              min: wave.min[i],
              max: wave.max[i],
            })),
          )
          setRaw(!!wave.raw)
          lastKey = key
          lastFetch = performance.now()
          if (isLive) await new Promise((resolve) => window.setTimeout(resolve, LIVE_FETCH_MS))
        } catch {
          await new Promise((resolve) => window.setTimeout(resolve, 40))
        }
      }
    }
    void pump()
    return () => {
      stopped = true
    }
  }, [sourceId, plotPoints])

  const playheadRef = useRef(center)
  playheadRef.current = center

  useEffect(() => {
    if (!playing || rangeMax == null) return
    const from = playheadRef.current
    if (from == null) return
    return playCaptureAudio(sourceId, from, rangeMax, playRate)
  }, [playing, playRate, sourceId, rangeMax])

  const lines = useMemo(() => [toLine(points)], [points])

  return (
    <div className="tile-body">
      <GraphPlot
        t={points.map((p) => p.t)}
        lines={lines}
        t0={t0}
        t1={t1}
        center={center}
        live={live}
        lockFront={lockFront}
        lockBack={lockBack}
        duration={duration}
        rangeMin={rangeMin}
        rangeMax={rangeMax}
        onScrub={onScrub}
        legend={false}
        sampleDots={raw}
        yLabel=""
        emptyHint=""
        showMarker={showMarker}
        markers={measure?.markers}
        placeMode={measure?.placeMode}
        onPlace={measure?.place}
        onMoveMarker={measure?.move}
      />
      {!online ? (
        <div className="stamp offline">OFFLINE</div>
      ) : live && lockFront ? (
        <div className="stamp">LIVE</div>
      ) : null}
    </div>
  )
}
