import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { Peer, SessionStatus } from '../types'

type Props = {
  session: SessionStatus | null
  live: boolean
  center: number | null
  duration: number
  peers: Peer[]
  selfId: string | null
  onScrub: (center: number, duration: number, live: boolean) => void
  onJumpToPeer: (peer: Peer) => void
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function Timeline({
  session,
  live,
  center,
  duration,
  peers,
  selfId,
  onScrub,
  onJumpToPeer,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrubRef = useRef({ live, center, duration, tMin: session?.t_min ?? null, tMax: session?.t_max ?? null })
  scrubRef.current = { live, center, duration, tMin: session?.t_min ?? null, tMax: session?.t_max ?? null }

  const tMin = session?.t_min ?? null
  const tMax = session?.t_max ?? null
  const hasRange = tMin != null && tMax != null && tMax >= tMin
  const span = hasRange ? Math.max(1, tMax - tMin) : 1
  const windowCenter = live && tMax != null ? tMax : center ?? tMax
  const leftNs = windowCenter != null ? windowCenter - duration / 2 : null
  const rightNs = windowCenter != null ? windowCenter + duration / 2 : null

  const xOf = (t: number) => {
    if (!hasRange || tMin == null) return 0
    return ((t - tMin) / span) * 100
  }

  const timeAt = (clientX: number) => {
    const el = trackRef.current
    const { tMin: min, tMax: max } = scrubRef.current
    if (!el || min == null || max == null) return 0
    const rect = el.getBoundingClientRect()
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1)
    return min + ratio * Math.max(1, max - min)
  }

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const { tMin: min, tMax: max, duration: dur, live: isLive, center: cur } = scrubRef.current
      if (min == null || max == null) return
      const range = Math.max(1, max - min)
      const playhead = isLive ? max : (cur ?? max)
      const factor = Math.exp(event.deltaY * 0.002)
      const next = clamp(dur * factor, 20_000_000, range)
      onScrub(playhead, next, isLive)
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
      const { tMin: a, tMax: b, duration: d } = scrubRef.current
      if (a == null || b == null) return
      onScrub(clamp(timeAt(clientX), a, b), d, false)
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

  return (
    <div className="timeline" ref={rootRef}>
      <div className="timeline-meta">
        <span>{live ? 'LIVE' : 'SCRUB'} · window {formatDuration(duration)}</span>
        <span>
          {hasRange && tMin != null && tMax != null
            ? `${formatOffset(tMin, tMin)} — ${formatOffset(tMax, tMin)}`
            : session?.recording
              ? 'recording… waiting for samples'
              : 'no capture in memory'}
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
        {hasRange && tMin != null && windowCenter != null && (
          <div className="playhead" style={{ left: `${xOf(windowCenter)}%` }} />
        )}
        {hasRange &&
          tMin != null &&
          tMax != null &&
          peers
            .filter((peer) => peer.id !== selfId)
            .map((peer) => {
              const peerCenter = peer.live ? tMax : peer.center
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
                    {peer.live ? ' · live' : peer.playing ? ' · play' : ''}
                  </div>
                </div>
              )
            })}
      </div>
      <div className="axis">
        <span>{hasRange && tMin != null ? formatOffset(tMin, tMin) : '—'}</span>
        <span>scroll to zoom (keeps live) · drag to scrub · click a name to follow</span>
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
