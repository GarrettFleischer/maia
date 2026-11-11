import { useEffect, useState } from 'react'
import { withCsrf } from '@/remote/csrf'
import type { SuperAgentDataSource } from '@/api/superAgentTypes'
import { reloadUntilLoaded } from '@/components/settings/reloadUntilLoaded'

type Reasoning = 'low' | 'medium' | 'high'

interface ModelConnectionView {
  base_url: string
  key_set: boolean
  model: string
  reasoning: Reasoning
  models: string[]
}

const EMPTY: ModelConnectionView = {
  base_url: '',
  key_set: false,
  model: '',
  reasoning: 'medium',
  models: [],
}

const REASONING: readonly Reasoning[] = ['low', 'medium', 'high']

export function ModelConnectionSection({
  source,
  editable,
}: {
  source: SuperAgentDataSource
  editable: boolean
}) {
  const [loaded, setLoaded] = useState<ModelConnectionView>(EMPTY)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [reasoning, setReasoning] = useState<Reasoning>('medium')
  const [models, setModels] = useState<string[]>([])
  const [apiKey, setApiKey] = useState('')
  const [replacing, setReplacing] = useState(true)
  const [status, setStatus] = useState(
    source === 'fixture' ? 'This preview does not save a model connection.' : 'Loading model connection.',
  )
  const [busy, setBusy] = useState(false)
  const canEdit = editable && source === 'live'

  useEffect(() => {
    if (source !== 'live') return
    let cancel = false
    function applyView(view: ModelConnectionView) {
      setLoaded(view)
      setBaseUrl(view.base_url)
      setModel(view.model)
      setReasoning(view.reasoning)
      setModels(view.models)
      setApiKey('')
      setReplacing(!view.key_set)
      setStatus(
        view.key_set || view.base_url
          ? 'Saved. Future model calls use this connection.'
          : 'Add a Base URL and an API key.',
      )
    }
    const stop = reloadUntilLoaded(async () => {
      const result = await loadModelConnection(window.location.origin)
      if (cancel) return true
      if (!result.ok) {
        setStatus(result.message)
        return false
      }
      applyView(result.view)
      return true
    }, () => cancel)
    return () => {
      cancel = true
      stop()
    }
  }, [source])

  const dirty =
    baseUrl !== loaded.base_url ||
    model !== loaded.model ||
    reasoning !== loaded.reasoning ||
    (replacing && apiKey.trim() !== '')

  async function save() {
    setBusy(true)
    const body: Record<string, string> = {
      base_url: baseUrl,
      model,
      reasoning,
    }
    if (replacing && apiKey.trim()) body.api_key = apiKey
    const result = await writeModelConnection(window.location.origin, body)
    setApiKey('')
    setBusy(false)
    if (!result.ok) {
      setStatus(result.message)
      return
    }
    setLoaded(result.view)
    setBaseUrl(result.view.base_url)
    setModel(result.view.model)
    setReasoning(result.view.reasoning)
    setModels(result.view.models)
    setReplacing(!result.view.key_set)
    setStatus('Saved. Future model calls use this connection.')
  }

  async function testConnection() {
    setBusy(true)
    const body: Record<string, string> = { base_url: baseUrl }
    if (replacing && apiKey.trim()) body.api_key = apiKey
    const result = await testModelConnection(window.location.origin, body)
    setBusy(false)
    if (!result.ok) {
      setStatus(result.message)
      return
    }
    setModels(result.models)
    if (!model && result.models[0]) setModel(result.models[0])
    setStatus(`Connected · ${result.models.length} models`)
  }

  function discard() {
    setBaseUrl(loaded.base_url)
    setModel(loaded.model)
    setReasoning(loaded.reasoning)
    setModels(loaded.models)
    setApiKey('')
    setReplacing(!loaded.key_set)
    setStatus(loaded.key_set || loaded.base_url ? 'Saved. Future model calls use this connection.' : 'Add a Base URL and an API key.')
  }

  const modelOptions = models.length === 0 || models.includes(model) || model === '' ? models : [model, ...models]
  const keyLocked = !replacing && loaded.key_set

  return (
    <section className="maia-model-connection" aria-labelledby="model-connection-heading">
      <header>
        <h2 id="model-connection-heading">Model connection</h2>
        <p className="maia-field-help">
          The OpenAI-compatible endpoint the router uses. Saving changes future model calls only.
        </p>
      </header>
      <div className="maia-field">
        <label htmlFor="model-base-url">Base URL</label>
        <input
          id="model-base-url"
          value={baseUrl}
          disabled={!canEdit || busy}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <p className="maia-field-help">https, or a loopback address for a local server.</p>
      </div>
      <div className="maia-field">
        <label htmlFor="model-api-key">API key</label>
        <div className="maia-key-row">
          <input
            id="model-api-key"
            type="password"
            value={keyLocked ? '••••••••' : apiKey}
            readOnly={keyLocked}
            disabled={!canEdit || busy}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
          />
          {canEdit && keyLocked ? (
            <button type="button" className="maia-btn" onClick={() => setReplacing(true)}>
              Replace key
            </button>
          ) : null}
        </div>
        <p className="maia-field-help">Write-only. Stored as the router-key secret. Maia never shows it again.</p>
      </div>
      <div className="maia-field">
        <label htmlFor="model-id">Model</label>
        {modelOptions.length > 0 ? (
          <select
            id="model-id"
            value={model}
            disabled={!canEdit || busy}
            onChange={(event) => setModel(event.target.value)}
          >
            {model === '' ? <option value="">Select a model</option> : null}
            {modelOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          <input
            id="model-id"
            value={model}
            disabled={!canEdit || busy}
            onChange={(event) => setModel(event.target.value)}
          />
        )}
        <p className="maia-field-help">Listed from this endpoint after Test connection.</p>
      </div>
      <div className="maia-field">
        <p id="model-reasoning-label">Reasoning</p>
        <div className="maia-seg" role="group" aria-labelledby="model-reasoning-label">
          {REASONING.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={reasoning === choice}
              disabled={!canEdit || busy}
              onClick={() => setReasoning(choice)}
            >
              {choice[0].toUpperCase() + choice.slice(1)}
            </button>
          ))}
        </div>
        <p className="maia-field-help">Saved with this connection for later model calls.</p>
      </div>
      {canEdit ? (
        <div className="maia-set-acts">
          <button
            type="button"
            className="maia-btn"
            disabled={busy || baseUrl.trim() === '' || (replacing && apiKey.trim() === '' && !loaded.key_set)}
            onClick={() => void testConnection()}
          >
            Test connection
          </button>
          <span className="maia-set-grow" />
          <button type="button" className="maia-btn" disabled={!dirty || busy} onClick={discard}>
            Discard
          </button>
          <button
            type="button"
            className="maia-btn maia-btn--primary"
            disabled={!dirty || busy}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      ) : null}
      <p className="maia-model-status" role="status">
        {status}
      </p>
    </section>
  )
}

async function loadModelConnection(
  origin: string,
): Promise<{ ok: true; view: ModelConnectionView } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${origin}/api/super-agent/model-connection`)
    if (!response.ok) return { ok: false, message: await errorMessage(response) }
    return { ok: true, view: readView(await response.json()) }
  } catch {
    return { ok: false, message: 'Model connection could not be loaded.' }
  }
}

async function writeModelConnection(
  origin: string,
  body: Record<string, string>,
): Promise<{ ok: true; view: ModelConnectionView } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${origin}/api/super-agent/model-connection`, {
      method: 'PUT',
      headers: withCsrf('PUT', { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!response.ok) return { ok: false, message: await errorMessage(response) }
    return { ok: true, view: readView(await response.json()) }
  } catch {
    return { ok: false, message: 'Model connection could not be saved.' }
  }
}

async function testModelConnection(
  origin: string,
  body: Record<string, string>,
): Promise<{ ok: true; models: string[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${origin}/api/super-agent/model-connection/test`, {
      method: 'POST',
      headers: withCsrf('POST', { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!response.ok) return { ok: false, message: await errorMessage(response) }
    const payload = (await response.json()) as { models?: unknown }
    const models = Array.isArray(payload.models) ? payload.models.filter((item): item is string => typeof item === 'string') : []
    return { ok: true, models }
  } catch {
    return { ok: false, message: 'The model connection did not answer.' }
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (payload.error === 'invalid_model_connection') return 'Add a Base URL, a model, and an API key.'
    if (payload.error === 'model_connection_unavailable') return 'The API key could not be stored.'
    if (payload.error === 'model_provider_unavailable') return 'The model connection did not answer.'
    if (payload.error === 'unknown_route') return 'Restart the daemon to save a model connection.'
  } catch {
    return 'Model connection could not be saved.'
  }
  return 'Model connection could not be saved.'
}

function readView(value: unknown): ModelConnectionView {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const reasoning = record.reasoning === 'low' || record.reasoning === 'high' ? record.reasoning : 'medium'
  const models = Array.isArray(record.models)
    ? record.models.filter((item): item is string => typeof item === 'string')
    : []
  return {
    base_url: typeof record.base_url === 'string' ? record.base_url : '',
    key_set: record.key_set === true,
    model: typeof record.model === 'string' ? record.model : '',
    reasoning,
    models,
  }
}
