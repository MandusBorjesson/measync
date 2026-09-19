import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchJoulescopeSeries, setSourceOutput, setSourceRate } from '../api'
import { emptyBand, formatRate, LIVE_FETCH_MS } from '../graph'
import type { JoulescopeChannel, JoulescopeSeries, SourceInfo } from '../types'
import { queryWindow, type Viewport } from '../viewport'
import { GraphPlot } from './GraphPlot'

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
  channels?: JoulescopeChannel[]
  source?: SourceInfo
  onChannelsChange?: (channels: JoulescopeChannel[]) => void
  plotPoints?: number
}

const CHANNELS: { id: JoulescopeChannel; label: string; unit: string; color: string }[] = [
  { id: 'current', label: 'I', unit: 'A', color: '#ffd166' },
  { id: 'voltage', label: 'V', unit: 'V', color: '#7fdbff' },
  { id: 'power', label: 'P', unit: 'W', color: '#7dce82' },
]

const EMPTY: JoulescopeSeries = {
  t: [],
  current: emptyBand(),
  voltage: emptyBand(),
  power: emptyBand(),
  raw: false,
}

export function JoulescopeWidget({
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
  channels,
  source,
  onChannelsChange,
  plotPoints,
}: Props) {
  const rangeRef = useRef({ t0, t1, live, plotPoints })
  const [series, setSeries] = useState<JoulescopeSeries>(EMPTY)
  const [rateBusy, setRateBusy] = useState(false)
  const [portBusy, setPortBusy] = useState(false)
  rangeRef.current = { t0, t1, live, plotPoints }
  const visible = CHANNELS.filter((ch) => !channels || channels.length === 0 || channels.includes(ch.id))
  const rates = source?.sample_rates?.length ? source.sample_rates : [10, 100, 1000, 10_000, 100_000, 1_000_000]
  const rate = source?.sample_rate ?? 1000
  const outputOn = source?.output_on ?? true
  const outputEnabled = source?.live !== false
  const online = source?.online !== false

  const toggle = (id: JoulescopeChannel) => {
    const current = visible.map((ch) => ch.id)
    const next = current.includes(id) ? current.filter((ch) => ch !== id) : [...current, id]
    onChannelsChange?.(next.length ? next : [id])
  }

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
        if (isLive && now - lastFetch < LIVE_FETCH_MS) {
          await new Promise((resolve) => window.setTimeout(resolve, LIVE_FETCH_MS - (now - lastFetch)))
          continue
        }
        try {
          const next = await fetchJoulescopeSeries(sourceId, tStart, tStop, pointsCap)
          if (stopped) return
          setSeries(next)
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

  const panes = useMemo(
    () =>
      visible.map((ch) => ({
        ...ch,
        band: series[ch.id],
      })),
    [visible, series],
  )

  const onRate = async (next: number) => {
    if (next === rate || rateBusy) return
    setRateBusy(true)
    try {
      await setSourceRate(sourceId, next)
    } finally {
      setRateBusy(false)
    }
  }

  const onOutput = async (next: boolean) => {
    if (portBusy || !outputEnabled || next === outputOn) return
    setPortBusy(true)
    try {
      await setSourceOutput(sourceId, next)
    } finally {
      setPortBusy(false)
    }
  }

  return (
    <div className="tile-body joulescope-body">
      <div className="joulescope-hud">
        <div className="joulescope-toggles">
          {CHANNELS.map((ch) => {
            const on = visible.some((item) => item.id === ch.id)
            return (
              <button
                key={ch.id}
                type="button"
                className={`joulescope-ch${on ? '' : ' off'}`}
                aria-pressed={on}
                style={{ color: ch.color }}
                onClick={() => toggle(ch.id)}
              >
                {ch.label}
              </button>
            )
          })}
        </div>
        <div className="joulescope-toggles joulescope-ports">
          <button
            type="button"
            className={`joulescope-ch${outputOn ? '' : ' off'}`}
            aria-pressed={outputOn}
            title="Current port — powers a series-connected DUT"
            disabled={portBusy || !outputEnabled}
            onClick={() => void onOutput(!outputOn)}
          >
            out
          </button>
        </div>
        <label className="joulescope-rate">
          <span>rate</span>
          <select
            value={rate}
            disabled={rateBusy || !live}
            onChange={(event) => void onRate(Number(event.target.value))}
          >
            {rates.map((hz) => (
              <option key={hz} value={hz}>
                {formatRate(hz)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="joulescope-stack">
        {panes.map((pane) => (
          <GraphPlot
            key={pane.id}
            t={series.t}
            lines={[
              {
                id: pane.id,
                label: pane.label,
                color: pane.color,
                unit: pane.unit,
                mean: pane.band.mean,
                min: pane.band.min,
                max: pane.band.max,
              },
            ]}
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
            sampleDots={!!series.raw}
            yLabel={pane.unit}
          />
        ))}
      </div>
      {!online ? (
        <div className="stamp offline">OFFLINE</div>
      ) : live && lockFront ? (
        <div className="stamp">LIVE</div>
      ) : null}
    </div>
  )
}
