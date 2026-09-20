import { useEffect, useRef, useState } from 'react'
import {
  formatDeltaNs,
  markerColor,
  MAX_MARKERS,
  type MeasureControls,
} from '../markers'

type Props = MeasureControls & {
  canPlace: boolean
}

export function MarkerMenu({
  markers,
  placeMode,
  setPlaceMode,
  rename,
  remove,
  jump,
  canPlace,
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const full = markers.length >= MAX_MARKERS

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  return (
    <div className="marker-menu" ref={rootRef}>
      <button
        className={`btn btn-lock${placeMode === 'single' ? ' active' : ''}`}
        disabled={!canPlace || (full && placeMode !== 'single')}
        title={full ? 'Remove a marker to place another' : 'Click a graph to place a cursor'}
        onClick={() => setPlaceMode(placeMode === 'single' ? null : 'single')}
      >
        Cursor
      </button>
      <button
        className={`btn btn-lock${placeMode === 'dual' ? ' active' : ''}`}
        disabled={!canPlace || (full && placeMode !== 'dual')}
        title={full ? 'Remove a marker to place another' : 'Drag on a graph to place a span'}
        onClick={() => setPlaceMode(placeMode === 'dual' ? null : 'dual')}
      >
        Span
      </button>
      <div className="marker-menu-list">
        <button
          className={`btn${open ? ' btn-lock active' : ''}`}
          title="List all markers"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Markers{markers.length ? ` ${markers.length}` : ''} ▾
        </button>
        {open && (
          <div className="marker-pop">
            <p className="marker-pop-title">All markers</p>
            {markers.length === 0 ? (
              <p className="marker-empty">None yet. Use Cursor or Span, then grab the small handle at the top of a bar to move it.</p>
            ) : (
              <ul className="marker-items">
                {markers.map((marker, i) => (
                  <li key={marker.id} style={{ color: markerColor(marker, i) }}>
                    <i className={`marker-swatch${marker.kind === 'dual' ? ' span' : ''}`} />
                    <input
                      value={marker.name}
                      aria-label="Marker name"
                      onChange={(event) => rename(marker.id, event.target.value)}
                    />
                    <span className="marker-meta">
                      {marker.kind === 'dual' ? formatDeltaNs(marker.dt) : 'cursor'}
                    </span>
                    <button
                      className="btn"
                      type="button"
                      title={`Jump to ${marker.name}`}
                      onClick={() => {
                        jump(marker.id)
                        setOpen(false)
                      }}
                    >
                      Jump
                    </button>
                    <button className="icon-btn" title={`Delete ${marker.name}`} onClick={() => remove(marker.id)}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
