import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { Peer, SessionStatus } from '../types'
import { applySeek, applyWheelZoom, clamp, playhead, viewRange, visibleRange, type Viewport } from '../viewport'

type Props = {
  session: SessionStatus | null
  lockFront: boolean
  lockBack: boolean
  center: number | null
  duration: number
  peers: Peer[]
  selfId: string | null
  onScrub: (next: Viewport) => void
  onJumpToPeer: (peer: Peer) => void
  marker?: number | null
}

export function Timeline({
  session,
  lockFront,
  lockBack,
  center,
  duration,
  peers,
  selfId,
  onScrub,
  onJumpToPeer,
  marker = null,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const range = viewRange(session)
  const scrubRef = useRef({
    lockFront,
    lockBack,
    center,
    duration,
    tMin: range.tMin,
    tMax: range.tMax,
  })
  scrubRef.current = { lockFront, lockBack, center, duration, tMin: range.tMin, tMax: range.tMax }

  const tMin = range.tMin
  const tMax = range.tMax
  const hasRange = tMin != null && tMax != null && tMax >= tMin
  const span = hasRange ? Math.max(1, tMax - tMin) : 1
  const windowCenter = playhead(lockFront, lockBack, center, tMin, tMax)
  const win =
    windowCenter != null && tMin != null && tMax != null
      ? visibleRange(windowCenter, duration, tMin, tMax)
      : null
  const leftNs = win?.t0 ?? (windowCenter != null ? windowCenter - duration / 2 : null)
  const rightNs = win?.t1 ?? (windowCenter != null ? windowCenter + duration / 2 : null)
  const bothLocks = lockFront && lockBack
  const status = bothLocks ? 'FULL' : lockFront ? 'FRONT' : lockBack ? 'BACK' : 'SCRUB'

  const xOf = (t: number) => {
    if (!hasRange || tMin == null) return 0
    return ((t - tMin) / span) * 100
  }

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const { tMin: min, tMax: max, duration: dur, lockFront: front, lockBack: back, center: cur } = scrubRef.current
      if (min == null || max == null) return
      onScrub(applyWheelZoom(dur, event.deltaY, min, max, front, back, cur))
    }

    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [onScrub])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const { tMin: min, tMax: max, duration: dur } = scrubRef.current
    if (min == null || max == null) return
    event.preventDefault()
    const track = trackRef.current
    track?.setPointerCapture(event.pointerId)
    const apply = (clientX: number) => {
      const el = trackRef.current
      const { tMin: a, tMax: b, duration: d } = scrubRef.current
      if (!el || a == null || b == null) return
      onScrub(applySeek(clientX, el.getBoundingClientRect(), a, b, d))
    }
    apply(event.clientX)

    const move = (ev: PointerEvent) => apply(ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      void dur
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const peerLockLabel = (peer: Peer) => {
    const front = peer.lock_front !== false
    const back = peer.lock_back !== false
    if (front && back) return ' · full'
    if (front) return ' · front'
    if (back) return ' · back'
    return ''
  }

  return (
    <div className="timeline" ref={rootRef}>
      <div className="timeline-meta">
        <span>{status} · window {formatDuration(duration)}</span>
        <span>
          {hasRange && tMin != null && tMax != null
            ? `${formatOffset(tMin, tMin)} — ${formatOffset(tMax, tMin)}`
            : session?.recording
              ? 'recording… waiting for samples'
              : 'no samples in memory'}
        </span>
      </div>
      <div className="timeline-track" ref={trackRef} onPointerDown={onPointerDown}>
        {hasRange && tMin != null && tMax != null && leftNs != null && rightNs != null && (
          <div
            className="window-rect"
            style={{
              left: `${xOf(clamp(leftNs, tMin, tMax))}%`,
              width: `${Math.max(0.4, xOf(clamp(rightNs, tMin, tMax)) - xOf(clamp(leftNs, tMin, tMax)))}%`,
            }}
          />
        )}
        {hasRange && tMin != null && tMax != null && (marker ?? (!bothLocks ? windowCenter : null)) != null && (
          <div
            className="playhead"
            style={{
              left: `${xOf(clamp((marker ?? windowCenter) as number, tMin, tMax))}%`,
            }}
          />
        )}
        {hasRange &&
          tMin != null &&
          tMax != null &&
          peers
            .filter((peer) => peer.id !== selfId)
            .map((peer) => {
              const front = peer.lock_front !== false
              const back = peer.lock_back !== false
              const peerCenter = playhead(front, back, peer.center, tMin, tMax)
              if (peerCenter == null) return null
              const dur = peer.duration ?? duration
              const a = clamp(peerCenter - dur / 2, tMin, tMax)
              const b = clamp(peerCenter + dur / 2, tMin, tMax)
              return (
                <div key={peer.id} className="peer-marker" style={{ left: `${xOf(peerCenter)}%`, color: peer.color }}>
                  <div
                    className="peer-bracket"
                    style={{
                      left: `${xOf(a) - xOf(peerCenter)}%`,
                      width: `${Math.max(0.4, xOf(b) - xOf(a))}%`,
                      background: peer.color,
                    }}
                  />
                  <div className="peer-tick" style={{ background: peer.color }} />
                  <div
                    className="peer-label"
                    style={{ color: peer.color }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onJumpToPeer(peer)}
                  >
                    {peer.name}
                    {peerLockLabel(peer)}
                  </div>
                </div>
              )
            })}
      </div>
      <div className="axis">
        <span>{hasRange && tMin != null ? formatOffset(tMin, tMin) : '—'}</span>
        <span>scroll to zoom · drag to pan/scrub · lock front = newest · lock back = oldest</span>
        <span>{hasRange && tMin != null && tMax != null ? formatOffset(tMax, tMin) : '—'}</span>
      </div>
    </div>
  )
}

function formatDuration(ns: number) {
  const s = ns / 1e9
  if (s < 1) return `${(s * 1000).toFixed(0)}ms`
  return `${s.toFixed(2)}s`
}

function formatOffset(t: number, origin: number) {
  const s = (t - origin) / 1e9
  return `${s.toFixed(3)}s`
}
