import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchThermalFrame, wsUrl } from '../api'

type Props = {
  sourceId: string
  live: boolean
  playing?: boolean
  hasCapture?: boolean
  recording?: boolean
  center: number | null
  origin: number | null
}

type Stats = {
  minC: number | null
  maxC: number | null
  centerC: number | null
  minX: number | null
  minY: number | null
  maxX: number | null
  maxY: number | null
}

type FrameBox = { left: number; top: number; width: number; height: number }

const SENSOR_W = 256
const SENSOR_H = 192
const EMPTY_STATS: Stats = {
  minC: null,
  maxC: null,
  centerC: null,
  minX: null,
  minY: null,
  maxX: null,
  maxY: null,
}

function isJpegAt(bytes: Uint8Array, offset: number) {
  return bytes.length >= offset + 2 && bytes[offset] === 0xff && bytes[offset + 1] === 0xd8
}

function parseSnapshot(buffer: ArrayBuffer): { jpeg: ArrayBuffer; stats: Stats } {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 16 || bytes[0] !== 0x54 || bytes[1] !== 0x48 || bytes[2] !== 0x52 || bytes[3] !== 0x4d) {
    return { jpeg: buffer, stats: EMPTY_STATS }
  }
  const view = new DataView(buffer)
  const temps = {
    minC: view.getFloat32(4, true),
    maxC: view.getFloat32(8, true),
    centerC: view.getFloat32(12, true),
  }
  if (isJpegAt(bytes, 24)) {
    return {
      jpeg: buffer.slice(24),
      stats: {
        ...temps,
        minX: view.getUint16(16, true),
        minY: view.getUint16(18, true),
        maxX: view.getUint16(20, true),
        maxY: view.getUint16(22, true),
      },
    }
  }
  if (isJpegAt(bytes, 16)) {
    return { jpeg: buffer.slice(16), stats: { ...EMPTY_STATS, ...temps } }
  }
  return { jpeg: buffer, stats: EMPTY_STATS }
}

function formatC(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}°C`
}

function measureFrame(img: HTMLImageElement): FrameBox | null {
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  const cw = img.clientWidth
  const ch = img.clientHeight
  if (!nw || !nh || !cw || !ch) return null
  const scale = Math.min(cw / nw, ch / nh)
  const width = nw * scale
  const height = nh * scale
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height }
}

function spotStyle(box: FrameBox, sx: number, sy: number) {
  return {
    left: box.left + ((sx + 0.5) / SENSOR_W) * box.width,
    top: box.top + ((sy + 0.5) / SENSOR_H) * box.height,
  }
}

export function ThermalWidget({
  sourceId,
  live,
  playing = false,
  hasCapture = false,
  recording = false,
  center,
  origin,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<string | null>(null)
  const centerRef = useRef(center)
  const liveRef = useRef(live)
  const recordingRef = useRef(recording)
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)
  const [box, setBox] = useState<FrameBox | null>(null)
  centerRef.current = center
  liveRef.current = live
  recordingRef.current = recording
  const followStream = live && !playing && !hasCapture

  const relayout = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    setBox(measureFrame(img))
  }, [])

  const showPayload = (buffer: ArrayBuffer) => {
    const parsed = parseSnapshot(buffer)
    setStats(parsed.stats)
    const next = URL.createObjectURL(new Blob([parsed.jpeg], { type: 'image/jpeg' }))
    if (imgRef.current) imgRef.current.src = next
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
  }

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(() => relayout())
    observer.observe(stage)
    return () => observer.disconnect()
  }, [relayout])

  useEffect(() => {
    if (!followStream) return
    const ws = new WebSocket(wsUrl(`/ws/live/${encodeURIComponent(sourceId)}`))
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) showPayload(event.data)
    }
    return () => {
      ws.close()
    }
  }, [sourceId, followStream])

  useEffect(() => {
    if (followStream) return
    let stopped = false
    let lastDrawn = Number.NaN

    const pump = async () => {
      while (!stopped) {
        const t = centerRef.current
        const quantized = t == null ? null : Math.round(t / 33_000_000) * 33_000_000
        const wantLatest = liveRef.current && recordingRef.current
        if (quantized == null || (!wantLatest && quantized === lastDrawn)) {
          await new Promise((resolve) => window.setTimeout(resolve, 16))
          continue
        }
        try {
          const buffer = await fetchThermalFrame(sourceId, wantLatest ? quantized + 1_000_000_000 : quantized)
          if (stopped) return
          showPayload(buffer)
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
  }, [sourceId, followStream])

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  const stamp = live
    ? 'LIVE'
    : playing
      ? `PLAY ${center != null ? ((center - (origin ?? center)) / 1e9).toFixed(3) : ''}s`
      : center != null
        ? `${((center - (origin ?? center)) / 1e9).toFixed(3)}s`
        : ''

  const sameSpot =
    stats.minX != null &&
    stats.minY != null &&
    stats.maxX != null &&
    stats.maxY != null &&
    stats.minX === stats.maxX &&
    stats.minY === stats.maxY

  return (
    <div className="tile-body thermal-body">
      <div className="thermal-stage" ref={stageRef}>
        <img ref={imgRef} className="camera-frame" alt="" onLoad={relayout} />
        {box && stats.minX != null && stats.minY != null && (
          <div
            className={`thermal-spot cold${stats.minX > SENSOR_W * 0.72 ? ' flip' : ''}`}
            style={spotStyle(box, stats.minX, stats.minY)}
          >
            <span className="thermal-spot-mark" />
            <span className="thermal-spot-label">
              {sameSpot ? `${formatC(stats.minC)} / ${formatC(stats.maxC)}` : formatC(stats.minC)}
            </span>
          </div>
        )}
        {box && !sameSpot && stats.maxX != null && stats.maxY != null && (
          <div
            className={`thermal-spot hot${stats.maxX > SENSOR_W * 0.72 ? ' flip' : ''}`}
            style={spotStyle(box, stats.maxX, stats.maxY)}
          >
            <span className="thermal-spot-mark" />
            <span className="thermal-spot-label">{formatC(stats.maxC)}</span>
          </div>
        )}
        {stamp && <div className="stamp">{stamp}</div>}
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
      </div>
    </div>
  )
}
