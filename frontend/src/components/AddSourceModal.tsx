import { useEffect, useState } from 'react'
import { fetchDevices } from '../api'
import type { Device, SourceInfo } from '../types'
import { Modal } from './Modal'

type Props = {
  tracks: SourceInfo[]
  onPick: (source: { id: string; kind: Device['kind']; label: string; liveDevice: boolean }) => void
  onClose: () => void
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
      <p className="field">Live devices</p>
      <ul className="device-list">
        {devices.length === 0 && <li>No cameras, thermal cameras, or microphones found.</li>}
        {devices.map((device) => (
          <li key={device.id}>
            <span>
              {device.label}
              <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                {device.id}
              </div>
            </span>
            <button className="btn btn-primary" onClick={() => onPick({ ...device, liveDevice: true })}>
              Add
            </button>
          </li>
        ))}
      </ul>
      {saved.length > 0 && (
        <>
          <p className="field">In-memory / saved tracks</p>
          <ul className="device-list">
            {saved.map((track) => (
              <li key={track.id}>
                <span>{track.label}</span>
                <button
                  className="btn"
                  onClick={() =>
                    onPick({ id: track.id, kind: track.kind, label: track.label, liveDevice: false })
                  }
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
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
