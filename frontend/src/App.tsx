import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchSession,
  resetSession,
  setCap,
  startRecording,
  startSource,
  stopRecording,
  stopSource,
  wsUrl,
} from './api'
import { AddSourceModal } from './components/AddSourceModal'
import { CaptureMenu } from './components/CaptureMenu'
import { Mosaic } from './components/Mosaic'
import { ProfileMenu } from './components/ProfileMenu'
import { Timeline } from './components/Timeline'
import { addLeaf, collectLeaves, removeLeaf, splitExisting } from './layout'
import type { Kind, Layout, Peer, SessionStatus, SplitDir, TileSpec } from './types'
import { GRAPH_POINT_CHOICES, loadPlotPoints, savePlotPoints } from './graph'
import { applyLocks, DEFAULT_DURATION_NS, viewRange, type Viewport } from './viewport'

const DEFAULT_DURATION = DEFAULT_DURATION_NS
const NAME_KEY = 'measync.displayName'

function formatBytes(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)} MB`
  return `${Math.round(n / 1000)} kB`
}

export default function App() {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || '')
  const [draftName, setDraftName] = useState(name || 'operator')
  const [session, setSession] = useState<SessionStatus | null>(null)
  const [layout, setLayout] = useState<Layout | null>(null)
  const [tiles, setTiles] = useState<Record<string, TileSpec>>({})
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [splitDir, setSplitDir] = useState<SplitDir>('v')
  const [splitTarget, setSplitTarget] = useState<string | null>(null)
  const [lockFront, setLockFront] = useState(true)
  const [lockBack, setLockBack] = useState(true)
  const [center, setCenter] = useState<number | null>(null)
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [peers, setPeers] = useState<Peer[]>([])
  const [selfId, setSelfId] = useState<string | null>(null)
  const [selfColor, setSelfColor] = useState('#f0a202')
  const [modal, setModal] = useState<'add' | 'profiles' | 'captures' | 'cap' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [capDraft, setCapDraft] = useState('1000')
  const [plotPoints, setPlotPoints] = useState(() => loadPlotPoints())
  const seq = useRef(1)
  const liveStarted = useRef(new Set<string>())
  const presenceRef = useRef<WebSocket | null>(null)
  const ignoreLayoutEcho = useRef(false)
  const [layoutHydrated, setLayoutHydrated] = useState(false)
  const viewportRef = useRef({ lockFront, lockBack, center, duration })
  viewportRef.current = { lockFront, lockBack, center, duration }

  const refreshSession = useCallback(() => {
    fetchSession()
      .then(setSession)
      .catch((err: Error) => setError(err.message))
  }, [])

  const adoptSharedLayout = useCallback(async (payload: {
    layout: Layout | null
    tiles: Record<string, TileSpec>
  }) => {
    ignoreLayoutEcho.current = true
    const nextTiles = payload.tiles ?? {}
    const unique = new Set(Object.values(nextTiles).map((tile) => tile.sourceId))
    for (const sourceId of unique) {
      try {
        await startSource(sourceId)
        liveStarted.current.add(sourceId)
      } catch {
        /* saved track or missing device */
      }
    }
    for (const sourceId of [...liveStarted.current]) {
      if (!unique.has(sourceId)) {
        await stopSource(sourceId).catch(() => undefined)
        liveStarted.current.delete(sourceId)
      }
    }
    const maxN = Object.keys(nextTiles).reduce((n, id) => {
      const match = /^tile-(\d+)$/.exec(id)
      return match ? Math.max(n, Number(match[1]) + 1) : n
    }, 1)
    seq.current = Math.max(seq.current, maxN)
    setTiles(nextTiles)
    setLayout(payload.layout)
    const remaining = collectLeaves(payload.layout)
    setFocusedId((prev) => (prev && remaining.includes(prev) ? prev : remaining[0] ?? null))
  }, [])

  useEffect(() => {
    refreshSession()
    const id = window.setInterval(refreshSession, 80)
    return () => window.clearInterval(id)
  }, [refreshSession])

  useEffect(() => {
    if (!name) return
    setLayoutHydrated(false)
    const ws = new WebSocket(wsUrl('/ws/presence'))
    presenceRef.current = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', name }))
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as {
        type: string
        you?: Peer
        peers?: Peer[]
        layout?: Layout | null
        tiles?: Record<string, TileSpec>
        origin?: string
      }
      if (msg.you) {
        setSelfId(msg.you.id)
        setSelfColor(msg.you.color)
      }
      if (msg.peers) setPeers(msg.peers)
      if (msg.type === 'hello') {
        const incoming = { layout: msg.layout ?? null, tiles: msg.tiles ?? {} }
        void (async () => {
          if (incoming.layout || Object.keys(incoming.tiles).length) {
            await adoptSharedLayout(incoming)
          }
          setLayoutHydrated(true)
        })()
      }
      if (msg.type === 'layout') {
        void adoptSharedLayout({ layout: msg.layout ?? null, tiles: msg.tiles ?? {} })
      }
    }
    return () => {
      ws.close()
      presenceRef.current = null
    }
  }, [name, adoptSharedLayout])

  useEffect(() => {
    const send = () => {
      const ws = presenceRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const v = viewportRef.current
      ws.send(
        JSON.stringify({
          type: 'viewport',
          lock_front: v.lockFront,
          lock_back: v.lockBack,
          center: v.center,
          duration: v.duration,
        }),
      )
    }
    send()
    const id = window.setInterval(send, 80)
    return () => window.clearInterval(id)
  }, [selfId])

  useEffect(() => {
    if (!layoutHydrated) return
    const ws = presenceRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !selfId) return
    if (ignoreLayoutEcho.current) {
      ignoreLayoutEcho.current = false
      return
    }
    const handle = window.setTimeout(() => {
      ws.send(JSON.stringify({ type: 'layout', layout, tiles }))
    }, 40)
    return () => window.clearTimeout(handle)
  }, [layout, tiles, selfId, layoutHydrated])

  const nextTileId = () => {
    const id = `tile-${seq.current}`
    seq.current += 1
    return id
  }

  const releaseIfUnused = (nextTiles: Record<string, TileSpec>, sourceId: string) => {
    const still = Object.values(nextTiles).some((tile) => tile.sourceId === sourceId)
    if (still || !liveStarted.current.has(sourceId)) return
    liveStarted.current.delete(sourceId)
    void stopSource(sourceId)
  }

  const addSource = async (picked: { id: string; kind: Kind; label: string; liveDevice: boolean }) => {
    setError(null)
    if (picked.liveDevice) {
      try {
        await startSource(picked.id)
        liveStarted.current.add(picked.id)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to start source')
        return
      }
    }
    const tileId = nextTileId()
    const spec: TileSpec = { id: tileId, sourceId: picked.id, kind: picked.kind, label: picked.label }
    setTiles((prev) => ({ ...prev, [tileId]: spec }))
    setLayout((prev) => {
      if (splitTarget && prev) return splitExisting(prev, splitTarget, tileId, splitDir)
      return addLeaf(prev, focusedId, tileId, splitDir)
    })
    setFocusedId(tileId)
    setSplitTarget(null)
    setModal(null)
    setLockFront(true)
    setLockBack(true)
  }

  const closeTile = (id: string) => {
    const tile = tiles[id]
    const nextTiles = { ...tiles }
    delete nextTiles[id]
    setTiles(nextTiles)
    const nextLayout = layout ? removeLeaf(layout, id) : null
    setLayout(nextLayout)
    const remaining = collectLeaves(nextLayout)
    setFocusedId(remaining[0] ?? null)
    if (tile) releaseIfUnused(nextTiles, tile.sourceId)
  }

  const applyProfile = async (payload: {
    layout: Layout | null
    tiles: Record<string, TileSpec>
    focused_id: string | null
    split_dir: SplitDir
  }) => {
    for (const sourceId of liveStarted.current) {
      const still = Object.values(payload.tiles).some((tile) => tile.sourceId === sourceId)
      if (!still) {
        await stopSource(sourceId).catch(() => undefined)
        liveStarted.current.delete(sourceId)
      }
    }
    const unique = new Set(Object.values(payload.tiles).map((tile) => tile.sourceId))
    for (const sourceId of unique) {
      try {
        await startSource(sourceId)
        liveStarted.current.add(sourceId)
      } catch {
        /* saved tracks or missing hardware */
      }
    }
    const maxN = Object.keys(payload.tiles).reduce((n, id) => {
      const match = /^tile-(\d+)$/.exec(id)
      return match ? Math.max(n, Number(match[1]) + 1) : n
    }, 1)
    seq.current = maxN
    setTiles(payload.tiles)
    setLayout(payload.layout)
    setFocusedId(payload.focused_id)
    setSplitDir(payload.split_dir)
  }

  const confirmWipe = () => {
    if (!session?.dirty) return true
    return window.confirm('This will discard the unsaved capture currently in RAM. Continue?')
  }

  const fitBothLocks = useCallback(() => {
    setLockFront(true)
    setLockBack(true)
  }, [])

  const applyViewport = useCallback((next: Viewport) => {
    setLockFront(next.lockFront)
    setLockBack(next.lockBack)
    setCenter(Math.round(next.center))
    setDuration(next.duration)
  }, [])

  const ramRatio = session ? Math.min(1, session.bytes_used / Math.max(1, session.bytes_cap)) : 0
  const canSave = !!session && !session.recording && session.bytes_used > 0
  const range = viewRange(session)
  const hasTake = session?.t_min != null && session.t_max != null
  const growing = !!session?.recording || !hasTake
  const fitted = useMemo(() => {
    if (range.tMin == null || range.tMax == null) {
      return { center: center ?? 0, duration, lockFront, lockBack }
    }
    return applyLocks(center ?? range.tMax, duration, range.tMin, range.tMax, lockFront, lockBack)
  }, [range.tMin, range.tMax, center, duration, lockFront, lockBack])
  const windowCenter = range.tMin == null ? center : fitted.center
  const windowDuration = range.tMin == null ? duration : fitted.duration

  const setLock = (front: boolean, back: boolean) => {
    if (range.tMin != null && range.tMax != null) {
      applyViewport(applyLocks(fitted.center, fitted.duration, range.tMin, range.tMax, front, back))
      return
    }
    setLockFront(front)
    setLockBack(back)
  }

  if (!name) {
    return (
      <div className="modal-backdrop">
        <form
          className="modal"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = draftName.trim() || 'operator'
            localStorage.setItem(NAME_KEY, trimmed)
            setName(trimmed)
          }}
        >
          <h3>Who is watching?</h3>
          <p className="field">Shown as a marker on other people’s timelines.</p>
          <label className="field">
            Display name
            <input value={draftName} onChange={(e) => setDraftName(e.target.value)} autoFocus />
          </label>
          <div className="modal-actions">
            <button className="btn btn-primary" type="submit">
              Enter
            </button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark">MEASYNC</span>
          <span className="brand-sub">measure · align · rewind</span>
        </div>
        <button className="btn btn-primary" onClick={() => { setSplitTarget(null); setModal('add') }}>
          Add source
        </button>
        <button
          className={`btn btn-record${session?.recording ? ' active' : ''}`}
          onClick={() => {
            if (session?.recording) {
              stopRecording().then(setSession).catch((err: Error) => setError(err.message))
              return
            }
            startRecording()
              .then((next) => {
                setSession(next)
                fitBothLocks()
              })
              .catch((err: Error) => setError(err.message))
          }}
        >
          {session?.recording ? 'Stop' : 'Record'}
        </button>
        <button
          className="btn"
          onClick={() => {
            if (!confirmWipe()) return
            resetSession()
              .then((next) => {
                setSession(next)
                fitBothLocks()
              })
              .catch((err: Error) => setError(err.message))
          }}
        >
          Reset
        </button>
        <button
          className={`btn btn-lock${lockBack ? ' active' : ''}`}
          onClick={() => setLock(lockFront, !lockBack)}
        >
          Lock back
        </button>
        <button
          className={`btn btn-lock${lockFront ? ' active' : ''}`}
          onClick={() => setLock(!lockFront, lockBack)}
        >
          Lock front
        </button>
        <button className="btn" disabled={!canSave && !(session && !session.recording)} onClick={() => setModal('captures')}>
          Captures
        </button>
        <button className="btn" onClick={() => setModal('profiles')}>
          Profiles
        </button>
        <div className="header-spacer" />
        <label className="header-plot" title="Points drawn per graph. Lower is cheaper on long takes.">
          <span>plot</span>
          <select
            value={plotPoints}
            aria-label="Plot points"
            onChange={(event) => setPlotPoints(savePlotPoints(Number(event.target.value)))}
          >
            {GRAPH_POINT_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} pts
              </option>
            ))}
          </select>
        </label>
        {error && <span className="error">{error}</span>}
        <button
          className="ram"
          title="Click to set RAM cap"
          onClick={() => {
            setCapDraft(String(Math.round((session?.bytes_cap ?? 1e9) / 1e6)))
            setModal('cap')
          }}
        >
          <div className="ram-bar">
            <span style={{ width: `${ramRatio * 100}%` }} />
          </div>
          {session ? `${formatBytes(session.bytes_used)} / ${formatBytes(session.bytes_cap)}` : 'RAM'}
          {session?.dirty ? ' · unsaved' : ''}
        </button>
        <span className="you-chip" style={{ color: selfColor, borderColor: selfColor }}>
          {name}
        </span>
      </header>

      <main className="workspace">
        {layout ? (
          <Mosaic
            layout={layout}
            tiles={tiles}
            focusedId={focusedId}
            live={growing}
            lockFront={lockFront}
            lockBack={lockBack}
            hasCapture={session?.t_min != null}
            recording={!!session?.recording}
            center={windowCenter}
            origin={range.tMin}
            tMax={range.tMax}
            duration={windowDuration}
            onScrub={applyViewport}
            onFocus={setFocusedId}
            onSplit={(id, dir) => {
              setFocusedId(id)
              setSplitTarget(id)
              setSplitDir(dir)
              setModal('add')
            }}
            onClose={closeTile}
            onLayout={setLayout}
            onTileChange={(id, patch) => {
              setTiles((prev) => {
                const tile = prev[id]
                if (!tile) return prev
                return { ...prev, [id]: { ...tile, ...patch } }
              })
            }}
            sources={session?.sources}
            plotPoints={plotPoints}
          />
        ) : (
          <div className="empty-workspace">
            <h2>No sources yet</h2>
            <p>Add a camera, thermal camera, microphone, or Joulescope. Drag a tile header to swap or dock it; everyone shares this layout.</p>
            <button className="btn btn-primary" onClick={() => setModal('add')}>
              Add source
            </button>
          </div>
        )}
      </main>

      <Timeline
        session={session}
        lockFront={lockFront}
        lockBack={lockBack}
        center={windowCenter}
        duration={windowDuration}
        peers={peers}
        selfId={selfId}
        onScrub={applyViewport}
        onJumpToPeer={(peer) => {
          const front = peer.lock_front !== false
          const back = peer.lock_back !== false
          if (range.tMin != null && range.tMax != null) {
            applyViewport(
              applyLocks(
                peer.center ?? fitted.center,
                peer.duration ?? fitted.duration,
                range.tMin,
                range.tMax,
                front,
                back,
              ),
            )
            return
          }
          setLockFront(front)
          setLockBack(back)
          if (peer.center != null) setCenter(peer.center)
          if (peer.duration != null) setDuration(peer.duration)
        }}
      />

      {modal === 'add' && (
        <AddSourceModal
          tracks={session?.sources ?? []}
          onPick={addSource}
          onClose={() => { setModal(null); setSplitTarget(null) }}
        />
      )}
      {modal === 'profiles' && (
        <ProfileMenu
          layout={layout}
          tiles={tiles}
          focusedId={focusedId}
          splitDir={splitDir}
          onLoaded={(payload) => void applyProfile(payload)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'captures' && (
        <CaptureMenu
          canSave={canSave}
          onOpened={(next) => {
            setSession(next)
            fitBothLocks()
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'cap' && (
        <form
          className="modal-backdrop"
          onClick={() => setModal(null)}
          onSubmit={(event) => {
            event.preventDefault()
            const mb = Number(capDraft)
            if (!Number.isFinite(mb) || mb < 1) return
            setCap(Math.round(mb * 1_000_000))
              .then(setSession)
              .then(() => setModal(null))
              .catch((err: Error) => setError(err.message))
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>RAM cap</h3>
            <label className="field">
              Megabytes
              <input value={capDraft} onChange={(e) => setCapDraft(e.target.value)} />
            </label>
            <div className="modal-actions">
              <button className="btn" type="button" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit">
                Set
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  )
}
