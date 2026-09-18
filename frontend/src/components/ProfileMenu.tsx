import { useEffect, useState } from 'react'
import { deleteProfile, listProfiles, loadProfile, saveProfile } from '../api'
import type { Layout, SplitDir, TileSpec } from '../types'
import { Modal } from './Modal'

type Props = {
  layout: Layout | null
  tiles: Record<string, TileSpec>
  focusedId: string | null
  splitDir: SplitDir
  onLoaded: (payload: {
    layout: Layout | null
    tiles: Record<string, TileSpec>
    focused_id: string | null
    split_dir: SplitDir
  }) => void
  onClose: () => void
}

export function ProfileMenu({ layout, tiles, focusedId, splitDir, onLoaded, onClose }: Props) {
  const [names, setNames] = useState<string[]>([])
  const [name, setName] = useState('lab-default')
  const [error, setError] = useState<string | null>(null)

  const refresh = () =>
    listProfiles()
      .then((list) => setNames(list.map((p) => p.name)))
      .catch((err: Error) => setError(err.message))

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <Modal title="Profiles" onClose={onClose}>
      <label className="field">
        Save current layout
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="modal-actions" style={{ marginTop: 0 }}>
        <button
          className="btn btn-primary"
          onClick={() => {
            saveProfile({ name, layout, tiles, focused_id: focusedId, split_dir: splitDir })
              .then(() => refresh())
              .catch((err: Error) => setError(err.message))
          }}
        >
          Save
        </button>
      </div>
      <p className="field">Saved</p>
      <ul className="simple-list">
        {names.length === 0 && <li>No profiles yet.</li>}
        {names.map((item) => (
          <li key={item}>
            <span>{item}</span>
            <span>
              <button
                className="btn"
                onClick={() => {
                  loadProfile(item)
                    .then((profile) => {
                      onLoaded(profile)
                      onClose()
                    })
                    .catch((err: Error) => setError(err.message))
                }}
              >
                Load
              </button>{' '}
              <button
                className="btn"
                onClick={() => {
                  deleteProfile(item)
                    .then(() => refresh())
                    .catch((err: Error) => setError(err.message))
                }}
              >
                Delete
              </button>
            </span>
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
