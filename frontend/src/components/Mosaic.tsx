import { useRef, useState, type DragEvent, type MouseEvent } from 'react'
import type { Layout, TileSpec } from '../types'
import { dropZoneAt, relocateLeaf, setRatio, type DropZone } from '../layout'
import { AudioWidget } from '../widgets/AudioWidget'
import { CameraWidget } from '../widgets/CameraWidget'

type Props = {
  layout: Layout
  tiles: Record<string, TileSpec>
  focusedId: string | null
  live: boolean
  playing?: boolean
  hasCapture?: boolean
  recording?: boolean
  center: number | null
  origin: number | null
  tMax: number | null
  duration: number
  onFocus: (id: string) => void
  onSplit: (id: string, dir: 'h' | 'v') => void
  onClose: (id: string) => void
  onLayout: (layout: Layout) => void
}

export function Mosaic(props: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; zone: DropZone } | null>(null)
  const layoutRef = useRef(props.layout)
  layoutRef.current = props.layout

  return (
    <div className="mosaic">
      <Node
        {...props}
        node={props.layout}
        path="root"
        layoutRef={layoutRef}
        dragId={dragId}
        over={over}
        setDragId={setDragId}
        setOver={setOver}
      />
    </div>
  )
}

function Node(
  props: Props & {
    node: Layout
    path: string
    layoutRef: { current: Layout }
    dragId: string | null
    over: { id: string; zone: DropZone } | null
    setDragId: (id: string | null) => void
    setOver: (over: { id: string; zone: DropZone } | null) => void
  },
) {
  const { node } = props
  if (node.type === 'leaf') {
    const tile = props.tiles[node.id]
    if (!tile) return null
    const t0 =
      props.center == null
        ? null
        : Math.max(props.origin ?? Number.NEGATIVE_INFINITY, props.center - props.duration / 2)
    const t1 =
      props.center == null
        ? null
        : Math.min(props.tMax ?? Number.POSITIVE_INFINITY, props.center + props.duration / 2)
    const highlighted = props.over?.id === tile.id

    const onDragOver = (event: DragEvent<HTMLDivElement>) => {
      if (!props.dragId || props.dragId === tile.id) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const zone = dropZoneAt(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect())
      props.setOver({ id: tile.id, zone })
    }

    return (
      <div
        className={`tile${props.focusedId === tile.id ? ' focused' : ''}${highlighted ? ' drop-target' : ''}`}
        onMouseDown={() => props.onFocus(tile.id)}
        onDragOver={onDragOver}
        onDragLeave={() => {
          if (props.over?.id === tile.id) props.setOver(null)
        }}
        onDrop={(event) => {
          event.preventDefault()
          const fromId = event.dataTransfer.getData('text/tile-id') || props.dragId
          const zone = props.over?.id === tile.id ? props.over.zone : 'center'
          props.setDragId(null)
          props.setOver(null)
          if (!fromId || fromId === tile.id) return
          props.onLayout(relocateLeaf(props.layout, fromId, tile.id, zone))
        }}
      >
        {highlighted && <div className={`drop-zone ${props.over?.zone}`} />}
        <div
          className="tile-bar"
          draggable
          title="Drag to reposition"
          onDragStart={(event) => {
            if ((event.target as HTMLElement).closest('button')) {
              event.preventDefault()
              return
            }
            event.dataTransfer.setData('text/tile-id', tile.id)
            event.dataTransfer.effectAllowed = 'move'
            props.setDragId(tile.id)
          }}
          onDragEnd={() => {
            props.setDragId(null)
            props.setOver(null)
          }}
        >
          <span className="grip" aria-hidden>
            ⋮⋮
          </span>
          <span className={`kind-dot ${tile.kind}`} />
          <strong>{tile.label}</strong>
          <span>{tile.kind}</span>
          <div className="tile-actions">
            <button className="icon-btn" title="Split horizontally" onClick={() => props.onSplit(tile.id, 'h')}>
              ║
            </button>
            <button className="icon-btn" title="Split vertically" onClick={() => props.onSplit(tile.id, 'v')}>
              ═
            </button>
            <button className="icon-btn" title="Close" onClick={() => props.onClose(tile.id)}>
              ×
            </button>
          </div>
        </div>
        {tile.kind === 'camera' ? (
          <CameraWidget
            sourceId={tile.sourceId}
            live={props.live}
            playing={props.playing}
            hasCapture={props.hasCapture}
            recording={props.recording}
            center={props.center}
            origin={props.origin}
          />
        ) : (
          <AudioWidget
            sourceId={tile.sourceId}
            live={props.live}
            playing={props.playing}
            hasCapture={props.hasCapture}
            t0={t0}
            t1={t1}
            center={props.center}
          />
        )}
      </div>
    )
  }

  const horizontal = node.direction === 'h'
  return (
    <div className={`split ${node.direction}`}>
      <div className="split-pane" style={{ flex: node.ratio }}>
        <Node {...props} node={node.first} path={`${props.path}.first`} />
      </div>
      <Gutter
        horizontal={horizontal}
        onRatio={(ratio) => props.onLayout(setRatio(props.layoutRef.current, props.path, ratio))}
      />
      <div className="split-pane" style={{ flex: 1 - node.ratio }}>
        <Node {...props} node={node.second} path={`${props.path}.second`} />
      </div>
    </div>
  )
}

function Gutter({
  horizontal,
  onRatio,
}: {
  horizontal: boolean
  onRatio: (ratio: number) => void
}) {
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const parent = event.currentTarget.parentElement
    const gutter = event.currentTarget
    if (!parent) return
    gutter.classList.add('dragging')
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'

    const move = (ev: globalThis.MouseEvent) => {
      const rect = parent.getBoundingClientRect()
      const gutterSize = horizontal ? gutter.offsetWidth : gutter.offsetHeight
      const span = Math.max(1, (horizontal ? rect.width : rect.height) - gutterSize)
      const offset = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top
      onRatio(offset / span)
    }
    const up = () => {
      gutter.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    move(event.nativeEvent)
  }

  return <div className="gutter" onMouseDown={onMouseDown} />
}
