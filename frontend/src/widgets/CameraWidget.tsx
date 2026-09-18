import { useEffect, useRef } from 'react'
import { fetchFrame, wsUrl } from '../api'

type Props = {
  sourceId: string
  live: boolean
  playing?: boolean
  hasCapture?: boolean
  recording?: boolean
  center: number | null
  origin: number | null
}

export function CameraWidget({
  sourceId,
  live,
  playing = false,
  hasCapture = false,
  recording = false,
  center,
  origin,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const urlRef = useRef<string | null>(null)
  const centerRef = useRef(center)
  const liveRef = useRef(live)
  const recordingRef = useRef(recording)
  centerRef.current = center
  liveRef.current = live
  recordingRef.current = recording
  const followStream = live && !playing && !hasCapture

  const showBlob = (buffer: ArrayBuffer) => {
    const next = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }))
    if (imgRef.current) imgRef.current.src = next
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
  }

  useEffect(() => {
    if (!followStream) return
    const ws = new WebSocket(wsUrl(`/ws/live/${encodeURIComponent(sourceId)}`))
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) showBlob(event.data)
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
          const buffer = await fetchFrame(sourceId, wantLatest ? quantized + 1_000_000_000 : quantized)
          if (stopped) return
          showBlob(buffer)
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

  return (
    <div className="tile-body">
      <img ref={imgRef} className="camera-frame" alt="" />
      {stamp && <div className="stamp">{stamp}</div>}
    </div>
  )
}
