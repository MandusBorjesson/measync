import { useEffect, useState } from 'react'
import { fetchDevices } from '../api'
import type { Device, Kind, SourceInfo } from '../types'
import { Modal } from './Modal'

type Props = {
  tracks: SourceInfo[]
  onPick: (source: { id: string; kind: Device['kind']; label: string; liveDevice: boolean }) => void
  onClose: () => void
}

type Pickable = { id: string; kind: Kind; label: string }

const CATEGORIES: { kind: Kind; title: string }[] = [
  { kind: 'camera', title: 'Webcam' },
  { kind: 'thermal', title: 'Thermal camera' },
  { kind: 'audio', title: 'Audio' },
]

function grouped(items: Pickable[]) {
  const byKind = new Map<Kind, Pickable[]>()
  for (const item of items) {
    const list = byKind.get(item.kind)
    if (list) list.push(item)
    else byKind.set(item.kind, [item])
  }
  const known = CATEGORIES.filter((cat) => (byKind.get(cat.kind) ?? []).length > 0).map((cat) => ({
    ...cat,
    items: byKind.get(cat.kind) ?? [],
  }))
  const leftover = [...byKind.entries()]
    .filter(([kind]) => !CATEGORIES.some((cat) => cat.kind === kind))
    .map(([kind, group]) => ({ kind, title: kind, items: group }))
  return [...known, ...leftover]
}

function DeviceGroups({
  items,
  liveDevice,
  onPick,
}: {
  items: Pickable[]
  liveDevice: boolean
  onPick: Props['onPick']
}) {
  return (
    <div className="device-groups">
      {grouped(items).map((group) => (
        <section key={group.kind} className="device-category">
          <h4 className="device-category-title">
            <span className={`kind-dot ${group.kind}`} />
            {group.title}
          </h4>
          <ul className="device-list">
            {group.items.map((device) => (
              <li key={device.id}>
                <span>
                  {device.label}
                  {liveDevice && (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {device.id}
                    </div>
                  )}
                </span>
                <button
                  className={liveDevice ? 'btn btn-primary' : 'btn'}
                  onClick={() => onPick({ ...device, liveDevice })}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export function AddSourceModal({ tracks, onPick, onClose }: Props) {
  const [devices, setDevices] = useState<Device[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchDevices()
      .then(setDevices)
      .catch((err: Error) => setError(err.message))
  }, [])

  const saved = tracks.filter((track) => !devices.some((d) => d.id === track.id))

  return (
    <Modal title="Add source" onClose={onClose}>
      {error && <p className="error">{error}</p>}
      {devices.length === 0 ? (
        <p className="device-empty">No cameras, thermal cameras, or microphones found.</p>
      ) : (
        <DeviceGroups items={devices} liveDevice onPick={onPick} />
      )}
      {saved.length > 0 && (
        <>
          <p className="field">In-memory / saved tracks</p>
          <DeviceGroups items={saved} liveDevice={false} onPick={onPick} />
        </>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
