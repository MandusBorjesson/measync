import type { ReactNode } from 'react'

type Props = {
  title: string
  children: ReactNode
  onClose: () => void
}

export function Modal({ title, children, onClose }: Props) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}
