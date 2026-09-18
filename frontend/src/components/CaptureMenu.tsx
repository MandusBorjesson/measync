import { useEffect, useState } from 'react'
import { listCaptures, openCapture, saveCapture } from '../api'
import type { SavedCapture, SessionStatus } from '../types'
import { Modal } from './Modal'

type Props = {
  canSave: boolean
  onOpened: (session: SessionStatus) => void
  onClose: () => void
}

export function CaptureMenu({ canSave, onOpened, onClose }: Props) {
  const [captures, setCaptures] = useState<SavedCapture[]>([])
  const [name, setName] = useState(() => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
  const [error, setError] = useState<string | null>(null)

  const refresh = () =>
    listCaptures()
      .then(setCaptures)
      .catch((err: Error) => setError(err.message))

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <Modal title="Captures" onClose={onClose}>
      <label className="field">
        Save in-memory capture to disk
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canSave} />
      </label>
      <div className="modal-actions" style={{ marginTop: 0 }}>
        <button
          className="btn btn-primary"
          disabled={!canSave}
          onClick={() => {
            saveCapture(name)
              .then(() => refresh())
              .catch((err: Error) => setError(err.message))
          }}
        >
          Save
        </button>
      </div>
      <p className="field">On disk</p>
      <ul className="simple-list">
        {captures.length === 0 && <li>Nothing saved yet.</li>}
        {captures.map((cap) => (
          <li key={cap.name}>
            <span>
              {cap.name}
              <div className="mono" style={{ fontSize: 11 }}>
                {cap.sources.map((s) => s.label).join(', ') || 'empty'}
              </div>
            </span>
            <button
              className="btn"
              onClick={() => {
                openCapture(cap.name)
                  .then((session) => {
                    onOpened(session)
                    onClose()
                  })
                  .catch((err: Error) => setError(err.message))
              }}
            >
              Open
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
