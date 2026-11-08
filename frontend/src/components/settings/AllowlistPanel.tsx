import { useMemo, useState } from 'react'
import { AllowlistEditSheet } from '@/components/approval/ApprovalSheet'
import { useMaiaState } from '@/hooks/useMaiaState'
import { selectAllowlistEntries } from '@/state/maiaReducer'

export function AllowlistPanel() {
  const { state, dispatch } = useMaiaState()
  const [query, setQuery] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const entries = useMemo(() => selectAllowlistEntries(state, query), [state, query])
  const editing = entries.find((entry) => entry.id === editId) ?? state.allowlist.find((e) => e.id === editId)

  return (
    <section aria-labelledby="allowlist-heading">
      <h3 id="allowlist-heading">Allowlist</h3>
      <label>
        Search entries
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search allowlist entries"
          data-testid="allowlist-search"
        />
      </label>
      <table className="maia-table" data-testid="allowlist-table">
        <thead>
          <tr>
            <th scope="col">Target</th>
            <th scope="col">Capability</th>
            <th scope="col">Agent</th>
            <th scope="col">Enabled</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} data-testid={`allowlist-row-${entry.id}`}>
              <td>
                <div>{entry.label}</div>
                <div className="maia-mono">{entry.id}</div>
              </td>
              <td>{entry.capability}</td>
              <td>{entry.agent ?? 'All agents'}</td>
              <td>
                <button
                  type="button"
                  className="maia-btn"
                  aria-pressed={entry.enabled}
                  onClick={() =>
                    dispatch({
                      type: 'set_allowlist_enabled',
                      id: entry.id,
                      enabled: !entry.enabled,
                    })
                  }
                >
                  {entry.enabled ? 'Enabled' : 'Disabled'}
                </button>
              </td>
              <td>
                <button
                  type="button"
                  className="maia-btn"
                  aria-label={`Edit ${entry.label}`}
                  onClick={() => setEditId(entry.id)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="maia-btn"
                  aria-label={`Revoke ${entry.label}`}
                  onClick={() => dispatch({ type: 'revoke_allowlist_entry', id: entry.id })}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <AllowlistEditSheet
        open={editId !== null && editing != null}
        entry={editing ?? null}
        onSave={(patch) => {
          if (!editing) {
            return
          }
          dispatch({
            type: 'update_allowlist_entry',
            id: editing.id,
            label: patch.label,
            matcher: patch.matcher,
            enabled: patch.enabled,
          })
          setEditId(null)
        }}
        onCancel={() => setEditId(null)}
      />
    </section>
  )
}
