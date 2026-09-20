import { useRef, useState, type DragEvent, type MouseEvent } from 'react'
import type { Layout, SourceInfo, TileSpec } from '../types'
import { dropZoneAt, relocateLeaf, setRatio, type DropZone } from '../layout'
import type { MeasureControls } from '../markers'
import { visibleRange, type Viewport } from '../viewport'
import { AudioWidget } from '../widgets/AudioWidget'
import { CameraWidget } from '../widgets/CameraWidget'
import { JoulescopeWidget } from '../widgets/JoulescopeWidget'
import { ThermalWidget } from '../widgets/ThermalWidget'

type Props = {
  layout: Layout
  tiles: Record<string, TileSpec>
  focusedId: string | null
  live: boolean
  lockFront?: boolean
  lockBack?: boolean
  hasCapture?: boolean
  recording?: boolean
  center: number | null
  windowCenter?: number | null
  origin: number | null
  tMax: number | null
  duration: number
  showMarker?: boolean
  playing?: boolean
  playRate?: number
  onFocus: (id: string) => void
  onSplit: (id: string, dir: 'h' | 'v') => void
  onClose: (id: string) => void
  onLayout: (layout: Layout) => void
  onTileChange: (id: string, patch: Partial<TileSpec>) => void
  onScrub?: (next: Viewport) => void
  sources?: SourceInfo[]
  plotPoints?: number
  measure?: MeasureControls
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
    const win =
      (props.windowCenter ?? props.center) == null
        ? null
        : visibleRange(
            props.windowCenter ?? props.center ?? 0,
            props.duration,
            props.origin ?? null,
            props.tMax ?? null,
          )
    const t0 = win?.t0 ?? null
    const t1 = win?.t1 ?? null
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
        {tile.kind === 'audio' ? (
          <AudioWidget
            sourceId={tile.sourceId}
            live={props.live}
            lockFront={props.lockFront}
            lockBack={props.lockBack}
            hasCapture={props.hasCapture}
            recording={props.recording}
            t0={t0}
            t1={t1}
            center={props.center}
            duration={props.duration}
            rangeMin={props.origin}
            rangeMax={props.tMax}
            onScrub={props.onScrub}
            plotPoints={props.plotPoints}
            showMarker={props.showMarker}
            playing={props.playing}
            playRate={props.playRate}
            online={props.sources?.find((src) => src.id === tile.sourceId)?.online !== false}
            measure={props.measure}
          />
        ) : tile.kind === 'thermal' ? (
          <ThermalWidget
            sourceId={tile.sourceId}
            live={props.live}
            lockFront={props.lockFront}
            lockBack={props.lockBack}
            hasCapture={props.hasCapture}
            recording={props.recording}
            center={props.center}
            origin={props.origin}
            t0={t0}
            t1={t1}
            duration={props.duration}
            rangeMin={props.origin}
            rangeMax={props.tMax}
            onScrub={props.onScrub}
            zones={tile.zones}
            splitRatio={tile.splitRatio}
            showGraph={tile.showGraph !== false}
            onZonesChange={(zones) => props.onTileChange(tile.id, { zones })}
            onSplitRatioChange={(splitRatio) => props.onTileChange(tile.id, { splitRatio })}
            onShowGraphChange={(showGraph) => props.onTileChange(tile.id, { showGraph })}
            plotPoints={props.plotPoints}
            showMarker={props.showMarker}
            measure={props.measure}
          />
        ) : tile.kind === 'joulescope' ? (
          <JoulescopeWidget
            sourceId={tile.sourceId}
            live={props.live}
            lockFront={props.lockFront}
            lockBack={props.lockBack}
            hasCapture={props.hasCapture}
            recording={props.recording}
            t0={t0}
            t1={t1}
            center={props.center}
            duration={props.duration}
            rangeMin={props.origin}
            rangeMax={props.tMax}
            onScrub={props.onScrub}
            channels={tile.channels}
            source={props.sources?.find((src) => src.id === tile.sourceId)}
            onChannelsChange={(channels) => props.onTileChange(tile.id, { channels })}
            plotPoints={props.plotPoints}
            showMarker={props.showMarker}
            measure={props.measure}
          />
        ) : (
          <CameraWidget
            sourceId={tile.sourceId}
            live={props.live}
            lockFront={props.lockFront}
            center={props.center}
            origin={props.origin}
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
