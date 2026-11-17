import { useEffect, useState } from 'react'
import { withCsrf } from '@/remote/csrf'
import type { SuperAgentDataSource } from '@/api/superAgentTypes'

interface WakeView {
  interval_secs: number
  last_wake_at: number
  restart_budget: number
  mute_nonessential_wake_messages: boolean
}

export function ManagerWakeSection({
  source,
  editable,
}: {
  source: SuperAgentDataSource
  editable: boolean
}) {
  const [minutes, setMinutes] = useState('5')
  const [budget, setBudget] = useState('3')
  const [mute, setMute] = useState(false)
  const [status, setStatus] = useState(
    source === 'fixture'
      ? 'Preview only — wake schedule is not saved here.'
      : 'Loading manager wake schedule.',
  )
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(source !== 'live')
  const canEdit = editable && source === 'live'

  useEffect(() => {
    if (source !== 'live') return
    let cancel = false
    void (async () => {
      const result = await loadWake(window.location.origin)
      if (cancel) return
      if (!result.ok) {
        setLoaded(false)
        setStatus(result.message)
        return
      }
      setMinutes(String(Math.max(1, Math.round(result.view.interval_secs / 60))))
      setBudget(String(result.view.restart_budget))
      setMute(result.view.mute_nonessential_wake_messages)
      setLoaded(true)
      setStatus('Maia checks on workers on this schedule. Most wakes stay silent.')
    })()
    return () => {
      cancel = true
    }
  }, [source])

  async function save() {
    if (!canEdit || busy || !loaded) return
    const parsed = Number.parseInt(minutes, 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
      setStatus('Enter minutes as a whole number of at least 1.')
      return
    }
    const parsedBudget = Number.parseInt(budget, 10)
    if (!Number.isFinite(parsedBudget) || parsedBudget < 1) {
      setStatus('Enter a restart budget of at least 1.')
      return
    }
    setBusy(true)
    const result = await saveWake(window.location.origin, {
      interval_secs: parsed * 60,
      restart_budget: parsedBudget,
      mute_nonessential_wake_messages: mute,
    })
    setBusy(false)
    if (!result.ok) {
      setStatus(result.message)
      return
    }
    setMinutes(String(Math.max(1, Math.round(result.view.interval_secs / 60))))
    setBudget(String(result.view.restart_budget))
    setMute(result.view.mute_nonessential_wake_messages)
    setStatus('Saved. The manager wake uses these settings.')
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
      <label className="maia-field">
        <span>Restart budget (per goal)</span>
        <input
          type="number"
          min={1}
          max={20}
          value={budget}
          disabled={!canEdit || busy}
          onChange={(event) => setBudget(event.target.value)}
        />
      </label>
      <p className="maia-field-help">
        After this many automatic recoveries on one goal, Maia asks you what to do next.
      </p>
      <label className="maia-choice">
        <input
          type="checkbox"
          checked={mute}
          disabled={!canEdit || busy}
          onChange={(event) => setMute(event.target.checked)}
        />
        <span>Mute non-essential wake messages</span>
      </label>
      <p className="maia-field-help">
        Keeps decision questions and finished-goal close-outs; drops optional status chatter.
      </p>
      {canEdit ? (
        <button
          type="button"
          className="maia-icon-btn maia-icon-btn--primary"
          aria-label="Save wake schedule"
          title="Save wake schedule"
          disabled={busy || !loaded}
          onClick={() => void save()}
        >
          <span className="maia-check-icon" aria-hidden="true" />
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
        restart_budget: Number(body.restart_budget) || 3,
        mute_nonessential_wake_messages: Boolean(body.mute_nonessential_wake_messages),
      },
    }
  } catch {
    return { ok: false, message: 'Could not load the wake schedule.' }
  }
}

async function saveWake(
  origin: string,
  body: {
    interval_secs: number
    restart_budget: number
    mute_nonessential_wake_messages: boolean
  },
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
        restart_budget: Number(saved.restart_budget) || body.restart_budget,
        mute_nonessential_wake_messages:
          typeof saved.mute_nonessential_wake_messages === 'boolean'
            ? saved.mute_nonessential_wake_messages
            : body.mute_nonessential_wake_messages,
      },
    }
  } catch {
    return { ok: false, message: 'Could not save the wake schedule.' }
  }
}
