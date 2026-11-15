import { useEffect, useState } from 'react'
import { withCsrf } from '@/remote/csrf'
import type { SuperAgentDataSource } from '@/api/superAgentTypes'

interface WakeView {
  interval_secs: number
  last_wake_at: number
  max_model_calls_per_wake: number
}

const DEFAULT_VIEW: WakeView = {
  interval_secs: 300,
  last_wake_at: 0,
  max_model_calls_per_wake: 1,
}

export function ManagerWakeSection({
  source,
  editable,
}: {
  source: SuperAgentDataSource
  editable: boolean
}) {
  const [view, setView] = useState<WakeView>(DEFAULT_VIEW)
  const [minutes, setMinutes] = useState('5')
  const [status, setStatus] = useState(
    source === 'fixture'
      ? 'Preview only — wake schedule is not saved here.'
      : 'Loading manager wake schedule.',
  )
  const [busy, setBusy] = useState(false)
  const canEdit = editable && source === 'live'

  useEffect(() => {
    if (source !== 'live') return
    let cancel = false
    void (async () => {
      const result = await loadWake(window.location.origin)
      if (cancel) return
      if (!result.ok) {
        setStatus(result.message)
        return
      }
      setView(result.view)
      setMinutes(String(Math.max(1, Math.round(result.view.interval_secs / 60))))
      setStatus('Maia checks on workers on this schedule. Most wakes stay silent.')
    })()
    return () => {
      cancel = true
    }
  }, [source])

  async function save() {
    if (!canEdit || busy) return
    const parsed = Number.parseInt(minutes, 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
      setStatus('Enter minutes as a whole number of at least 1.')
      return
    }
    setBusy(true)
    const result = await saveWake(window.location.origin, {
      interval_secs: parsed * 60,
      max_model_calls_per_wake: view.max_model_calls_per_wake,
    })
    setBusy(false)
    if (!result.ok) {
      setStatus(result.message)
      return
    }
    setView(result.view)
    setMinutes(String(Math.max(1, Math.round(result.view.interval_secs / 60))))
    setStatus('Saved. The manager wake uses this interval.')
  }

  return (
    <section className="maia-settings-block" aria-label="Manager wake">
      <h2>Manager wake</h2>
      <p className="maia-field-help">
        How often Maia checks running, failed, and stuck work on her own. She only messages you when
        something is useful or she needs a decision.
      </p>
      <label className="maia-field">
        <span>Wake every (minutes)</span>
        <input
          type="number"
          min={1}
          max={1440}
          value={minutes}
          disabled={!canEdit || busy}
          onChange={(event) => setMinutes(event.target.value)}
        />
      </label>
      {canEdit ? (
        <button type="button" disabled={busy} onClick={() => void save()}>
          Save wake schedule
        </button>
      ) : null}
      <p className="maia-field-help" role="status">
        {status}
      </p>
    </section>
  )
}

async function loadWake(
  origin: string,
): Promise<{ ok: true; view: WakeView } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${origin}/api/super-agent/manager-wake`)
    if (!response.ok) return { ok: false, message: 'Could not load the wake schedule.' }
    const body = (await response.json()) as Partial<WakeView>
    return {
      ok: true,
      view: {
        interval_secs: Number(body.interval_secs) || 300,
        last_wake_at: Number(body.last_wake_at) || 0,
        max_model_calls_per_wake: Number(body.max_model_calls_per_wake) || 1,
      },
    }
  } catch {
    return { ok: false, message: 'Could not load the wake schedule.' }
  }
}

async function saveWake(
  origin: string,
  body: { interval_secs: number; max_model_calls_per_wake: number },
): Promise<{ ok: true; view: WakeView } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${origin}/api/super-agent/manager-wake`, {
      method: 'PUT',
      headers: withCsrf('PUT', { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!response.ok) return { ok: false, message: 'Could not save the wake schedule.' }
    const saved = (await response.json()) as Partial<WakeView>
    return {
      ok: true,
      view: {
        interval_secs: Number(saved.interval_secs) || body.interval_secs,
        last_wake_at: Number(saved.last_wake_at) || 0,
        max_model_calls_per_wake:
          Number(saved.max_model_calls_per_wake) || body.max_model_calls_per_wake,
      },
    }
  } catch {
    return { ok: false, message: 'Could not save the wake schedule.' }
  }
}
