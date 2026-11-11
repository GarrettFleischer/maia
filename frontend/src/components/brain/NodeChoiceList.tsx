import type { KeyboardEvent } from 'react'

export interface NodeChoice {
  id: string
  label: string
  taint?: 'trusted' | 'untrusted' | null
  detail?: string
}

export function taintLabel(taint: NodeChoice['taint']): 'Trusted' | 'Untrusted' | null {
  if (taint === 'trusted') return 'Trusted'
  if (taint === 'untrusted') return 'Untrusted'
  return null
}

export function NodeChoiceList({
  label,
  items,
  selectedId,
  onSelect,
}: {
  label: string
  items: readonly NodeChoice[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (items.length === 0) return
    event.preventDefault()
    const current = items.findIndex((item) => item.id === selectedId)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = items[(current + step + items.length) % items.length]
    if (next) onSelect(next.id)
  }

  return (
    <ul className="maia-brain-list" aria-label={label} onKeyDown={move}>
      {items.map((item) => {
        const taint = taintLabel(item.taint)
        return (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={item.id === selectedId}
              onClick={() => onSelect(item.id)}
            >
              <span>{item.label}</span>
              {taint ? (
                <>
                  {' '}
                  <span>{taint}</span>
                </>
              ) : null}
              {item.detail ? (
                <>
                  {' '}
                  <span>{item.detail}</span>
                </>
              ) : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
