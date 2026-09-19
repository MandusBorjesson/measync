import { useEffect, useRef, useState } from 'react'
import { fetchFrame, isLiveOffline, wsUrl } from '../api'

type Props = {
  sourceId: string
  live: boolean
  lockFront?: boolean
  center: number | null
  origin: number | null
}

export function CameraWidget({
  sourceId,
  live,
  lockFront = false,
  center,
  origin,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const urlRef = useRef<string | null>(null)
  const centerRef = useRef(center)
  const [offline, setOffline] = useState(false)
  centerRef.current = center
  const previewLive = live && lockFront

  const clearFrame = () => {
    if (imgRef.current) imgRef.current.removeAttribute('src')
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }

  const showBlob = (buffer: ArrayBuffer) => {
    const next = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }))
    if (imgRef.current) imgRef.current.src = next
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
  }

  useEffect(() => {
    if (!previewLive) return
    const ws = new WebSocket(wsUrl(`/ws/live/${encodeURIComponent(sourceId)}`))
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (isLiveOffline(event.data)) {
          setOffline(true)
          clearFrame()
        }
        return
      }
      if (event.data instanceof ArrayBuffer) {
        setOffline(false)
        showBlob(event.data)
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
          const buffer = await fetchFrame(sourceId, quantized)
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
  }, [sourceId, previewLive])

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  const stamp = previewLive && offline
    ? 'OFFLINE'
    : previewLive
      ? 'LIVE'
      : center != null
        ? `${((center - (origin ?? center)) / 1e9).toFixed(3)}s`
        : ''

  return (
    <div className="tile-body">
      <img ref={imgRef} className="camera-frame" alt="" />
      {stamp && <div className={`stamp${offline ? ' offline' : ''}`}>{stamp}</div>}
    </div>
  )
}
