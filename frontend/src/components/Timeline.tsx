import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Peer, SessionStatus } from '../types'
import { dualRange, markerColor, type MeasureControls } from '../markers'
import { applySeek, applyWheelZoom, clamp, playhead, timeFromX, viewRange, visibleRange, type Viewport } from '../viewport'

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
  measure?: MeasureControls
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
  measure,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<{ t: number; dt: number } | null>(null)
  const measureRef = useRef(measure)
  measureRef.current = measure
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
    const track = trackRef.current
    if (!track) return
    event.preventDefault()
    track.setPointerCapture(event.pointerId)
    const at = (clientX: number) => timeFromX(clientX, track.getBoundingClientRect(), min, max)
    const startT = at(event.clientX)
    const startX = event.clientX
    const mode = measureRef.current?.placeMode
    if (mode === 'single') {
      const up = () => {
        window.removeEventListener('pointerup', up)
        const next = measureRef.current
        if (next?.placeMode !== 'single') return
        next.place('single', startT)
      }
      window.addEventListener('pointerup', up)
      return
    }
    if (mode === 'dual') {
      setDraft({ t: startT, dt: 0 })
      const move = (ev: PointerEvent) => setDraft({ t: startT, dt: at(ev.clientX) - startT })
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setDraft(null)
        const next = measureRef.current
        if (next?.placeMode !== 'dual') return
        const dt = at(ev.clientX) - startT
        if (Math.abs(dt) < 1_000_000 && Math.abs(ev.clientX - startX) < 3) return
        next.place('dual', startT, dt || 1_000_000)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      return
    }
    const startY = event.clientY
    const trackTop = track.getBoundingClientRect().top
    const handleHit = (clientX: number, t: number) =>
      Math.abs(clientX - xOfClient(t)) <= 8 && Math.abs(startY - (trackTop + 7)) <= 10
    const spanNs = Math.max(1, max - min)
    const xOfClient = (t: number) =>
      track.getBoundingClientRect().left + ((t - min) / spanNs) * track.getBoundingClientRect().width
    const markers = measureRef.current?.markers ?? []
    let hit: { id: string; edge: 't' | 'end'; t: number; dt: number; kind: 'single' | 'dual' } | null = null
    for (let i = markers.length - 1; i >= 0; i--) {
      const m = markers[i]
      if (m.kind === 'single') {
        if (handleHit(startX, m.t)) {
          hit = { id: m.id, edge: 't', t: m.t, dt: 0, kind: 'single' }
          break
        }
        continue
      }
      const { t0, t1 } = dualRange(m.t, m.dt)
      if (handleHit(startX, t0)) {
        hit = { id: m.id, edge: m.t <= m.t + m.dt ? 't' : 'end', t: m.t, dt: m.dt, kind: 'dual' }
        break
      }
      if (handleHit(startX, t1)) {
        hit = { id: m.id, edge: m.t <= m.t + m.dt ? 'end' : 't', t: m.t, dt: m.dt, kind: 'dual' }
        break
      }
    }
    if (hit) {
      const orig = hit
      const other = orig.t + orig.dt
      const move = (ev: PointerEvent) => {
        const ctl = measureRef.current
        if (!ctl) return
        const next = at(ev.clientX)
        if (orig.kind === 'single') {
          ctl.move(orig.id, { t: next })
          return
        }
        if (orig.edge === 't') ctl.move(orig.id, { t: next, dt: other - next })
        else ctl.move(orig.id, { t: orig.t, dt: next - orig.t })
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      return
    }
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
      <div className={`timeline-track${measure?.placeMode ? ' placing' : ''}`} ref={trackRef} onPointerDown={onPointerDown}>
        {hasRange && tMin != null && tMax != null && leftNs != null && rightNs != null && (
          <div
            className="window-rect"
            style={{
              left: `${xOf(clamp(leftNs, tMin, tMax))}%`,
              width: `${Math.max(0.4, xOf(clamp(rightNs, tMin, tMax)) - xOf(clamp(leftNs, tMin, tMax)))}%`,
            }}
          />
        )}
        {hasRange &&
          tMin != null &&
          tMax != null &&
          [...(measure?.markers ?? []), ...(draft ? [{ id: '__draft', name: '', kind: 'dual' as const, t: draft.t, dt: draft.dt }] : [])].map(
            (m, i) => {
              const color = m.id === '__draft' ? '#9ca3af' : markerColor(m, i)
              if (m.kind === 'single') {
                return (
                  <div
                    key={m.id}
                    className="measure-tick"
                    style={{ left: `${xOf(clamp(m.t, tMin, tMax))}%`, background: color, color }}
                    title={m.name}
                  />
                )
              }
              const { t0, t1 } = dualRange(m.t, m.dt)
              const a = xOf(clamp(t0, tMin, tMax))
              const b = xOf(clamp(t1, tMin, tMax))
              return (
                <div
                  key={m.id}
                  className="measure-span"
                  style={{
                    left: `${Math.min(a, b)}%`,
                    width: `${Math.max(0.4, Math.abs(b - a))}%`,
                    color,
                    borderColor: color,
                    background: `${color}33`,
                  }}
                  title={m.name}
                />
              )
            },
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
        <span>scroll to zoom · drag to pan/scrub · cursor/span to measure</span>
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
