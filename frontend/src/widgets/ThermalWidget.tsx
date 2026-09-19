import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { fetchThermalFrame, fetchThermalSeries, isLiveOffline, wsUrl } from '../api'
import {
  clampZone,
  clientToSensor,
  decodeTempMap,
  DEFAULT_SPLIT,
  EMPTY_SERIES,
  EMPTY_STATS,
  encodeZoneQuery,
  formatC,
  LINE_GLOBAL_MAX,
  LINE_GLOBAL_MIN,
  MAX_ZONES,
  measureFrame,
  moveZone,
  nextZoneName,
  parseThermalSnapshot,
  SENSOR_W,
  spotStyle,
  type FrameBox,
  type ThermalSeries,
  type ThermalStats,
  type ThermalZone,
  type ZoneStats,
  zoneBoxStyle,
  zoneColor,
  zoneExtrema,
  zoneLineId,
} from '../thermal'
import { queryWindow, type Viewport } from '../viewport'
import { ThermalGraph } from './ThermalGraph'

type Props = {
  sourceId: string
  live: boolean
  lockFront?: boolean
  lockBack?: boolean
  hasCapture?: boolean
  recording?: boolean
  center: number | null
  origin: number | null
  t0: number | null
  t1: number | null
  duration?: number
  rangeMin?: number | null
  rangeMax?: number | null
  onScrub?: (next: Viewport) => void
  zones?: ThermalZone[]
  splitRatio?: number
  onZonesChange?: (zones: ThermalZone[]) => void
  onSplitRatioChange?: (ratio: number) => void
  showGraph?: boolean
  onShowGraphChange?: (show: boolean) => void
}

type Draft = { x: number; y: number; w: number; h: number }
type Drag =
  | { kind: 'draw'; originX: number; originY: number }
  | { kind: 'move'; id: string; startX: number; startY: number; orig: ThermalZone }
  | { kind: 'resize'; id: string; startX: number; startY: number; orig: ThermalZone }

function sameSpot(stats: ThermalStats) {
  return (
    stats.minX != null &&
    stats.minY != null &&
    stats.maxX != null &&
    stats.maxY != null &&
    stats.minX === stats.maxX &&
    stats.minY === stats.maxY
  )
}

export function ThermalWidget({
  sourceId,
  live,
  lockFront = false,
  lockBack = false,
  hasCapture: _hasCapture = false,
  recording: _recording = false,
  center,
  origin,
  t0,
  t1,
  duration,
  rangeMin,
  rangeMax,
  onScrub,
  zones = [],
  splitRatio = DEFAULT_SPLIT,
  onZonesChange,
  onSplitRatioChange,
  showGraph = true,
  onShowGraphChange,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<string | null>(null)
  const centerRef = useRef(center)
  const liveRef = useRef(live)
  const rangeRef = useRef({ t0, t1, live })
  const zonesRef = useRef(zones)
  const genRef = useRef(0)
  const [offline, setOffline] = useState(false)
  const [stats, setStats] = useState<ThermalStats>(EMPTY_STATS)
  const [tempMap, setTempMap] = useState<Float32Array | null>(null)
  const [box, setBox] = useState<FrameBox | null>(null)
  const [series, setSeries] = useState<ThermalSeries>(EMPTY_SERIES)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Record<string, boolean>>({})
  const dragRef = useRef<Drag | null>(null)
  const ratio = Math.min(0.82, Math.max(0.28, splitRatio))
  centerRef.current = center
  liveRef.current = live
  rangeRef.current = { t0, t1, live }
  zonesRef.current = zones
  const previewLive = live && lockFront
  const zoneGeomKey = encodeZoneQuery(zones)

  const relayout = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    setBox(measureFrame(img))
  }, [])

  const clearLivePreview = () => {
    genRef.current += 1
    if (imgRef.current) imgRef.current.removeAttribute('src')
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setStats(EMPTY_STATS)
    setTempMap(null)
    setBox(null)
  }

  const showPayload = (buffer: ArrayBuffer, _tNs?: number) => {
    const my = ++genRef.current
    const parsed = parseThermalSnapshot(buffer)
    setStats(parsed.stats)
    const next = URL.createObjectURL(new Blob([new Uint8Array(parsed.jpeg)], { type: 'image/jpeg' }))
    if (imgRef.current) imgRef.current.src = next
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
    if (!parsed.tempBytes) {
      setTempMap(null)
      return
    }
    void decodeTempMap(parsed.tempBytes).then((temp) => {
      if (my !== genRef.current) return
      setTempMap(temp)
    })
  }

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(() => relayout())
    observer.observe(stage)
    return () => observer.disconnect()
  }, [relayout])

  useEffect(() => {
    if (!previewLive) return
    const ws = new WebSocket(wsUrl(`/ws/live/${encodeURIComponent(sourceId)}`))
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (isLiveOffline(event.data)) {
          setOffline(true)
          clearLivePreview()
        }
        return
      }
      if (event.data instanceof ArrayBuffer) {
        setOffline(false)
        void showPayload(event.data)
      }
    }
    return () => {
      ws.close()
    }
  }, [sourceId, previewLive])

  useEffect(() => {
    if (previewLive) return
    let stopped = false
    let lastDrawn = Number.NaN

    const pump = async () => {
      while (!stopped) {
        const t = centerRef.current
        const quantized = t == null ? null : Math.round(t / 33_000_000) * 33_000_000
        if (quantized == null || quantized === lastDrawn) {
          await new Promise((resolve) => window.setTimeout(resolve, 16))
          continue
        }
        try {
          const buffer = await fetchThermalFrame(sourceId, quantized)
          if (stopped) return
          await showPayload(buffer, quantized)
          lastDrawn = quantized
        } catch {
          await new Promise((resolve) => window.setTimeout(resolve, 40))
        }
      }
    }
    void pump()
    return () => {
      stopped = true
    }
  }, [sourceId, previewLive])

  useEffect(() => {
    if (!showGraph) return
    setSeries(EMPTY_SERIES)
    let stopped = false
    let lastKey = ''
    let lastFetch = 0

    const pump = async () => {
      while (!stopped) {
        const { t0: rawStart, t1: rawStop, live: isLive } = rangeRef.current
        const win = queryWindow(rawStart, rawStop)
        const tStart = win?.t0 ?? null
        const tStop = win?.t1 ?? null
        const zoned = zonesRef.current.length > 0
        const key = `${tStart}:${tStop}:${encodeZoneQuery(zonesRef.current)}`
        const now = performance.now()
        if (tStart == null || tStop == null) {
          await new Promise((resolve) => window.setTimeout(resolve, zoned ? 50 : 16))
          continue
        }
        if (!isLive && key === lastKey) {
          await new Promise((resolve) => window.setTimeout(resolve, zoned ? 50 : 16))
          continue
        }
        if (isLive && key === lastKey && now - lastFetch < 50) {
          await new Promise((resolve) => window.setTimeout(resolve, 16))
          continue
        }
        try {
          const next = await fetchThermalSeries(sourceId, tStart, tStop, zonesRef.current)
          if (stopped) return
          setSeries(next)
          lastKey = key
          lastFetch = now
          if (zoned) await new Promise((resolve) => window.setTimeout(resolve, 80))
        } catch {
          await new Promise((resolve) => window.setTimeout(resolve, 40))
        }
      }
    }
    void pump()
    return () => {
      stopped = true
    }
  }, [sourceId, zoneGeomKey, showGraph])

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  useEffect(() => {
    if (!selectedId) return
    const onKey = (event: KeyboardEvent) => {
      if (editingId) return
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
      event.preventDefault()
      onZonesChange?.(zonesRef.current.filter((z) => z.id !== selectedId))
      setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, editingId, onZonesChange])

  const zoneStats = useMemo(() => {
    if (!tempMap) return [] as (ZoneStats | null)[]
    return zones.map((z) => zoneExtrema(tempMap, z))
  }, [zones, tempMap])

  const sensorFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current
    if (!stage || !box) return null
    const rect = stage.getBoundingClientRect()
    return clientToSensor(box, event.clientX - rect.left, event.clientY - rect.top)
  }

  const commitZones = (next: ThermalZone[]) => {
    onZonesChange?.(next)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !box) return
    const target = event.target as HTMLElement
    if (target.closest('.thermal-zone-label') || target.closest('.thermal-zone-x')) return
    const sensor = sensorFromEvent(event)
    if (!sensor) return
    const handle = target.closest('.thermal-zone-handle') as HTMLElement | null
    const zoneEl = target.closest('.thermal-zone') as HTMLElement | null
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    if (handle?.dataset.zoneId) {
      const orig = zones.find((z) => z.id === handle.dataset.zoneId)
      if (!orig) return
      setSelectedId(orig.id)
      setEditingId(null)
      dragRef.current = { kind: 'resize', id: orig.id, startX: sensor.x, startY: sensor.y, orig }
      return
    }
    if (zoneEl?.dataset.zoneId) {
      const orig = zones.find((z) => z.id === zoneEl.dataset.zoneId)
      if (!orig) return
      setSelectedId(orig.id)
      setEditingId(null)
      dragRef.current = { kind: 'move', id: orig.id, startX: sensor.x, startY: sensor.y, orig }
      return
    }
    setSelectedId(null)
    setEditingId(null)
    if (zones.length >= MAX_ZONES) return
    dragRef.current = { kind: 'draw', originX: sensor.x, originY: sensor.y }
    setDraft({ x: sensor.x, y: sensor.y, w: 1, h: 1 })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const sensor = sensorFromEvent(event)
    if (!sensor) return
    if (drag.kind === 'draw') {
      const next = clampZone(drag.originX, drag.originY, sensor.x - drag.originX + 1, sensor.y - drag.originY + 1)
      setDraft({ x: next.x, y: next.y, w: next.w, h: next.h })
      return
    }
    if (drag.kind === 'move') {
      const moved = moveZone(drag.orig, sensor.x - drag.startX, sensor.y - drag.startY)
      commitZones(zonesRef.current.map((z) => (z.id === drag.id ? moved : z)))
      return
    }
    const dw = sensor.x - drag.startX
    const dh = sensor.y - drag.startY
    const resized = clampZone(drag.orig.x, drag.orig.y, drag.orig.w + dw, drag.orig.h + dh)
    commitZones(
      zonesRef.current.map((z) => (z.id === drag.id ? { ...z, x: resized.x, y: resized.y, w: resized.w, h: resized.h } : z)),
    )
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }
    if (drag?.kind !== 'draw' || !draft) {
      setDraft(null)
      return
    }
    setDraft(null)
    if (draft.w < 2 && draft.h < 2) return
    if (zones.length >= MAX_ZONES) return
    const name = nextZoneName(zones)
    const next: ThermalZone = {
      id: `zone-${Date.now()}-${name}`,
      name,
      x: draft.x,
      y: draft.y,
      w: draft.w,
      h: draft.h,
    }
    commitZones([...zones, next])
    setSelectedId(next.id)
  }

  const onGutterDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const parent = event.currentTarget.parentElement
    const gutter = event.currentTarget
    if (!parent) return
    gutter.classList.add('dragging')
    const move = (ev: PointerEvent) => {
      const rect = parent.getBoundingClientRect()
      const span = Math.max(1, rect.height - gutter.offsetHeight)
      onSplitRatioChange?.(Math.min(0.82, Math.max(0.28, (ev.clientY - rect.top) / span)))
    }
    const up = () => {
      gutter.classList.remove('dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    move(event.nativeEvent)
  }

  const stamp = previewLive && offline
    ? 'OFFLINE'
    : previewLive
      ? 'LIVE'
      : center != null
        ? `${((center - (origin ?? center)) / 1e9).toFixed(3)}s`
        : ''

  const overlayZones: Array<ThermalZone & { draft?: boolean }> = draft
    ? [...zones, { id: 'draft', name: 'new', x: draft.x, y: draft.y, w: draft.w, h: draft.h, draft: true }]
    : zones
  const showGlobalMin = !hidden[LINE_GLOBAL_MIN]
  const showGlobalMax = !hidden[LINE_GLOBAL_MAX]
  const toggleLine = (id: string) => setHidden((prev) => ({ ...prev, [id]: !prev[id] }))

  return (
    <div className="tile-body thermal-body">
      <div className="thermal-upper" style={{ flexGrow: showGraph ? ratio : 1, flexShrink: 1, flexBasis: 0 }}>
        <div
          className="thermal-stage"
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <img ref={imgRef} className="camera-frame" alt="" onLoad={relayout} />
          {box && showGlobalMin && stats.minX != null && stats.minY != null && (
            <div
              className={`thermal-spot cold${stats.minX > SENSOR_W * 0.72 ? ' flip' : ''}`}
              style={spotStyle(box, stats.minX, stats.minY)}
            >
              <span className="thermal-spot-mark" />
              <span className="thermal-spot-label">
                {sameSpot(stats) && showGlobalMax ? `${formatC(stats.minC)} / ${formatC(stats.maxC)}` : formatC(stats.minC)}
              </span>
            </div>
          )}
          {box && showGlobalMax && !sameSpot(stats) && stats.maxX != null && stats.maxY != null && (
            <div
              className={`thermal-spot hot${stats.maxX > SENSOR_W * 0.72 ? ' flip' : ''}`}
              style={spotStyle(box, stats.maxX, stats.maxY)}
            >
              <span className="thermal-spot-mark" />
              <span className="thermal-spot-label">{formatC(stats.maxC)}</span>
            </div>
          )}
          {box && sameSpot(stats) && showGlobalMax && !showGlobalMin && stats.maxX != null && stats.maxY != null && (
            <div
              className={`thermal-spot hot${stats.maxX > SENSOR_W * 0.72 ? ' flip' : ''}`}
              style={spotStyle(box, stats.maxX, stats.maxY)}
            >
              <span className="thermal-spot-mark" />
              <span className="thermal-spot-label">{formatC(stats.maxC)}</span>
            </div>
          )}
          {box &&
            overlayZones.map((zone, index) => {
              const color = zoneColor(zone, index)
              const local = zone.id === 'draft' ? null : zoneStats[index]
              const selected = zone.id === selectedId
              const showMin = zone.draft || !hidden[zoneLineId(zone.id, 'min')]
              const showMax = zone.draft || !hidden[zoneLineId(zone.id, 'max')]
              const tracesOff = !zone.draft && !showMin && !showMax
              return (
                <div key={zone.id}>
                  <div
                    className={`thermal-zone${selected ? ' selected' : ''}${zone.draft ? ' draft' : ''}${tracesOff ? ' muted' : ''}`}
                    data-zone-id={zone.draft ? undefined : zone.id}
                    style={{ ...zoneBoxStyle(box, zone), borderColor: color, color }}
                  >
                    <div className="thermal-zone-label" onDoubleClick={() => !zone.draft && setEditingId(zone.id)}>
                      {editingId === zone.id ? (
                        <input
                          className="thermal-zone-input"
                          autoFocus
                          defaultValue={zone.name}
                          onPointerDown={(ev) => ev.stopPropagation()}
                          onBlur={(ev) => {
                            const name = ev.target.value.trim() || zone.name
                            commitZones(zones.map((z) => (z.id === zone.id ? { ...z, name } : z)))
                            setEditingId(null)
                          }}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur()
                            if (ev.key === 'Escape') setEditingId(null)
                          }}
                        />
                      ) : (
                        zone.name
                      )}
                      {selected && !zone.draft && (
                        <button
                          type="button"
                          className="thermal-zone-x"
                          title="Remove zone"
                          onPointerDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            commitZones(zones.filter((z) => z.id !== zone.id))
                            setSelectedId(null)
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {!zone.draft && <div className="thermal-zone-handle" data-zone-id={zone.id} />}
                  </div>
                  {local && (
                    <>
                      {showMin && (
                        <div
                          className={`thermal-spot zone-cold${local.minX > SENSOR_W * 0.72 ? ' flip' : ''}`}
                          style={{ ...spotStyle(box, local.minX, local.minY), color }}
                        >
                          <span className="thermal-spot-mark small" />
                          <span className="thermal-spot-label">{formatC(local.minC)}</span>
                        </div>
                      )}
                      {showMax && (local.minX !== local.maxX || local.minY !== local.maxY || !showMin) && (
                        <div
                          className={`thermal-spot zone-hot${local.maxX > SENSOR_W * 0.72 ? ' flip' : ''}`}
                          style={{ ...spotStyle(box, local.maxX, local.maxY), color }}
                        >
                          <span className="thermal-spot-mark small" />
                          <span className="thermal-spot-label">{formatC(local.maxC)}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          {stamp && <div className={`stamp${offline ? ' offline' : ''}`}>{stamp}</div>}
        </div>
        <div className="thermal-scale" title="Autoscale, cold to hot" aria-hidden />
        <div className="thermal-hud">
          <span>
            <em>min</em> {formatC(stats.minC)}
          </span>
          <span>
            <em>center</em> {formatC(stats.centerC)}
          </span>
          <span>
            <em>max</em> {formatC(stats.maxC)}
          </span>
          <span className="thermal-hud-hint">drag a zone · del removes</span>
          <button
            type="button"
            className={`thermal-hud-btn${showGraph ? '' : ' off'}`}
            title={showGraph ? 'Hide graph' : 'Show graph'}
            aria-pressed={showGraph}
            onClick={() => onShowGraphChange?.(!showGraph)}
          >
            graph
          </button>
        </div>
      </div>
      {showGraph && (
        <>
          <div className="thermal-gutter gutter" onPointerDown={onGutterDown} />
          <div className="thermal-lower" style={{ flexGrow: 1 - ratio, flexShrink: 1, flexBasis: 0 }}>
            <ThermalGraph
              series={series}
              zones={zones}
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
              hidden={hidden}
              onToggle={toggleLine}
            />
          </div>
        </>
      )}
    </div>
  )
}
