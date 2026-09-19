import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchPcm,
  fetchSession,
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

const DEFAULT_DURATION = 2_000_000_000
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
  const [live, setLive] = useState(true)
  const [center, setCenter] = useState<number | null>(null)
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [peers, setPeers] = useState<Peer[]>([])
  const [selfId, setSelfId] = useState<string | null>(null)
  const [selfColor, setSelfColor] = useState('#f0a202')
  const [modal, setModal] = useState<'add' | 'profiles' | 'captures' | 'cap' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [capDraft, setCapDraft] = useState('1000')
  const seq = useRef(1)
  const liveStarted = useRef(new Set<string>())
  const presenceRef = useRef<WebSocket | null>(null)
  const ignoreLayoutEcho = useRef(false)
  const [layoutHydrated, setLayoutHydrated] = useState(false)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)
  const sessionRef = useRef(session)
  const tilesRef = useRef(tiles)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const bufferSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const rafRef = useRef(0)
  const playGen = useRef(0)
  const viewportRef = useRef({ live, center, duration, playing })
  sessionRef.current = session
  tilesRef.current = tiles
  viewportRef.current = { live, center, duration, playing }

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
    const id = window.setInterval(refreshSession, 250)
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
          live: v.live,
          center: v.center,
          duration: v.duration,
          playing: v.playing,
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

  const stopPlayback = useCallback(() => {
    playGen.current += 1
    playingRef.current = false
    setPlaying(false)
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    for (const node of bufferSourcesRef.current) {
      try {
        node.stop()
      } catch {
        /* already stopped */
      }
    }
    bufferSourcesRef.current = []
  }, [])

  const startPlayback = useCallback(() => {
    const sess = sessionRef.current
    if (sess?.t_min == null || sess.t_max == null) return
    stopPlayback()
    const gen = playGen.current
    let from = !live && center != null ? center : sess.t_min
    if (from >= sess.t_max - 20_000_000) from = sess.t_min
    from = Math.max(sess.t_min, Math.min(from, sess.t_max))
    setLive(false)
    setCenter(Math.round(from))
    playingRef.current = true
    setPlaying(true)
    const originWall = performance.now()
    const originT = from

    const tick = () => {
      if (playGen.current !== gen) return
      const tMax = sessionRef.current?.t_max ?? originT
      const next = originT + (performance.now() - originWall) * 1e6
      if (next >= tMax) {
        setCenter(Math.round(tMax))
        stopPlayback()
        return
      }
      setCenter(Math.round(next))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    const ctx = audioCtxRef.current ?? new AudioContext()
    audioCtxRef.current = ctx
    void ctx.resume()
    const ctxStart = ctx.currentTime + 0.04
    const tMax = sess.t_max
    const audioIds = [...new Set(
      Object.values(tilesRef.current)
        .filter((tile) => tile.kind === 'audio')
        .map((tile) => tile.sourceId),
    )]
    const CHUNK = 2_000_000_000
    for (const sourceId of audioIds) {
      void (async () => {
        let t = from
        let offset = 0
        while (playGen.current === gen && t < tMax) {
          const t1 = Math.min(t + CHUNK, tMax)
          const spanSec = (t1 - t) / 1e9
          try {
            const { sampleRate, samples } = await fetchPcm(sourceId, t, t1)
            if (playGen.current !== gen) return
            if (samples.length === 0) {
              offset += spanSec
              t = t1
              continue
            }
            const buffer = ctx.createBuffer(1, samples.length, sampleRate)
            buffer.copyToChannel(new Float32Array(samples), 0)
            const node = ctx.createBufferSource()
            node.buffer = buffer
            node.connect(ctx.destination)
            node.start(ctxStart + offset)
            bufferSourcesRef.current.push(node)
            offset += samples.length / sampleRate
          } catch {
            if (playGen.current !== gen) return
            offset += spanSec
          }
          t = t1
        }
      })()
    }
  }, [center, live, stopPlayback])

  const ramRatio = session ? Math.min(1, session.bytes_used / Math.max(1, session.bytes_cap)) : 0
  const canSave = !!session && !session.recording && session.bytes_used > 0
  const windowCenter = useMemo(() => {
    if (live && session?.t_max != null) return session.t_max
    return center
  }, [live, session?.t_max, center])

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
          disabled={!!session?.recording}
          onClick={() => {
            if (!confirmWipe()) return
            stopPlayback()
            startRecording()
              .then((next) => {
                setSession(next)
                setLive(true)
              })
              .catch((err: Error) => setError(err.message))
          }}
        >
          Start
        </button>
        <button
          className="btn btn-stop"
          disabled={!session?.recording}
          onClick={() => {
            stopRecording().then(setSession).catch((err: Error) => setError(err.message))
          }}
        >
          Stop
        </button>
        <button
          className={`btn btn-play${playing ? ' active' : ''}`}
          disabled={!session?.t_min || !session.t_max || playing}
          onClick={() => startPlayback()}
        >
          Play
        </button>
        <button className="btn" disabled={!playing} onClick={() => stopPlayback()}>
          Pause
        </button>
        <button
          className={`btn btn-live${live ? ' active' : ''}`}
          onClick={() => {
            stopPlayback()
            setLive(true)
          }}
        >
          Live
        </button>
        <button className="btn" disabled={!canSave && !(session && !session.recording)} onClick={() => setModal('captures')}>
          Captures
        </button>
        <button className="btn" onClick={() => setModal('profiles')}>
          Profiles
        </button>
        <div className="header-spacer" />
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
            live={live}
            playing={playing}
            hasCapture={session?.t_min != null}
            recording={!!session?.recording}
            center={windowCenter}
            origin={session?.t_min ?? null}
            tMax={session?.t_max ?? null}
            duration={duration}
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
          />
        ) : (
          <div className="empty-workspace">
            <h2>No sources yet</h2>
            <p>Add a camera, thermal camera, or microphone. Drag a tile header to swap or dock it; everyone shares this layout.</p>
            <button className="btn btn-primary" onClick={() => setModal('add')}>
              Add source
            </button>
          </div>
        )}
      </main>

      <Timeline
        session={session}
        live={live}
        center={center}
        duration={duration}
        peers={peers}
        selfId={selfId}
        onScrub={(nextCenter, nextDuration, nextLive) => {
          if (playingRef.current && Math.abs(nextCenter - (center ?? nextCenter)) > 5_000_000) {
            stopPlayback()
          }
          setLive(nextLive)
          setCenter(Math.round(nextCenter))
          setDuration(nextDuration)
        }}
        onJumpToPeer={(peer) => {
          stopPlayback()
          setLive(peer.live)
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
            setLive(false)
            if (next.t_min != null && next.t_max != null) {
              setCenter(Math.round((next.t_min + next.t_max) / 2))
              setDuration(Math.min(DEFAULT_DURATION, Math.max(20_000_000, next.t_max - next.t_min)))
            }
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
