import { useEffect, useState } from 'react'
import type { SuperAgentDataSource } from '@/api/superAgentTypes'
import { withCsrf } from '@/remote/csrf'

interface McpTool {
  name: string
  description: string
}

interface McpConnection {
  id: string
  label: string
  transport: string
  url?: string
  status: string
  refresh_error: string | null
  admitted_hash: string | null
  listed_hash: string | null
  tools: McpTool[]
}

interface McpList {
  connections: McpConnection[]
}

export function McpServersSection({
  source,
  editable,
}: {
  source: SuperAgentDataSource
  editable: boolean
}) {
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [headerName, setHeaderName] = useState('Authorization')
  const [secret, setSecret] = useState('')
  const [status, setStatus] = useState(
    source === 'fixture' ? 'This preview does not connect to an MCP server.' : 'Loading MCP servers.',
  )
  const [busy, setBusy] = useState(false)
  const canEdit = editable && source === 'live'

  useEffect(() => {
    if (source !== 'live') return
    let cancel = false
    void loadServers(window.location.origin).then((result) => {
      if (cancel) return
      if (!result.ok) {
        setStatus(result.message)
        return
      }
      setConnections(result.connections)
      setStatus(result.connections.length === 0 ? 'No MCP servers are connected.' : 'Saved.')
    })
    return () => {
      cancel = true
    }
  }, [source])

  async function apply(result: { ok: true; connections: McpConnection[] } | { ok: false; message: string }) {
    if (!result.ok) {
      setStatus(result.message)
      return
    }
    setConnections(result.connections)
    setSecret('')
    setStatus('Saved.')
  }

  async function save() {
    setBusy(true)
    const headers = secret.trim() === '' ? [] : [{ name: headerName.trim(), value: secret }]
    const result = await writeJson(window.location.origin, '/api/super-agent/mcp', 'POST', {
      id: id.trim(),
      label: label.trim() || id.trim(),
      transport: 'http',
      url: url.trim(),
      headers,
    })
    setBusy(false)
    await apply(result)
  }

  async function listTools(connectionId: string) {
    setBusy(true)
    const result = await writeJson(
      window.location.origin,
      `/api/super-agent/mcp/${connectionId}/list`,
      'POST',
      {},
    )
    setBusy(false)
    await apply(result)
  }

  async function admit(connection: McpConnection) {
    if (!connection.listed_hash) return
    setBusy(true)
    const result = await writeJson(
      window.location.origin,
      `/api/super-agent/mcp/${connection.id}/admit`,
      'POST',
      { hash: connection.listed_hash },
    )
    setBusy(false)
    await apply(result)
  }

  async function revoke(connectionId: string) {
    setBusy(true)
    const result = await writeJson(
      window.location.origin,
      `/api/super-agent/mcp/${connectionId}/revoke`,
      'POST',
      {},
    )
    setBusy(false)
    await apply(result)
  }

  return (
    <section className="maia-model-connection" aria-label="MCP servers">
      <h2>MCP servers</h2>
      <p className="maia-field-help">
        Subagents can call tools you admit. The owner chat can explain them and cannot call them.
      </p>
      {connections.map((connection) => (
        <article key={connection.id} className="maia-field">
          <p>
            {connection.label}: {connection.status}
          </p>
          {connection.refresh_error ? <p className="maia-field-help">{connection.refresh_error}</p> : null}
          {connection.tools.length > 0 ? (
            <ul>
              {connection.tools.map((tool) => (
                <li key={tool.name}>
                  {tool.name}: {tool.description}
                </li>
              ))}
            </ul>
          ) : null}
          {connection.listed_hash && connection.admitted_hash !== connection.listed_hash ? (
            <button type="button" className="maia-btn" disabled={busy} onClick={() => void admit(connection)}>
              Admit
            </button>
          ) : null}
          {connection.admitted_hash ? (
            <button type="button" className="maia-btn" disabled={busy} onClick={() => void revoke(connection.id)}>
              Revoke
            </button>
          ) : null}
          {canEdit && connection.transport === 'http' ? (
            <button type="button" className="maia-btn" disabled={busy} onClick={() => void listTools(connection.id)}>
              List tools
            </button>
          ) : null}
        </article>
      ))}
      {canEdit ? (
        <>
          <div className="maia-field">
            <label htmlFor="mcp-id">Connection id</label>
            <input id="mcp-id" value={id} disabled={busy} onChange={(event) => setId(event.target.value)} />
          </div>
          <div className="maia-field">
            <label htmlFor="mcp-label">Label</label>
            <input id="mcp-label" value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} />
          </div>
          <div className="maia-field">
            <label htmlFor="mcp-url">URL</label>
            <input id="mcp-url" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} />
          </div>
          <div className="maia-field">
            <label htmlFor="mcp-header">Header name</label>
            <input
              id="mcp-header"
              value={headerName}
              disabled={busy}
              onChange={(event) => setHeaderName(event.target.value)}
            />
          </div>
          <div className="maia-field">
            <label htmlFor="mcp-secret">Secret</label>
            <input
              id="mcp-secret"
              type="password"
              value={secret}
              disabled={busy}
              onChange={(event) => setSecret(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="maia-btn maia-btn--primary"
            disabled={busy || id.trim() === '' || url.trim() === ''}
            onClick={() => void save()}
          >
            Add server
          </button>
        </>
      ) : null}
      <p className="maia-model-status" role="status">
        {status}
      </p>
    </section>
  )
}

async function loadServers(
  origin: string,
): Promise<{ ok: true; connections: McpConnection[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${origin}/api/super-agent/mcp`)
    if (!response.ok) return { ok: false, message: 'MCP servers could not be loaded.' }
    const body = (await response.json()) as McpList
    return { ok: true, connections: body.connections ?? [] }
  } catch {
    return { ok: false, message: 'MCP servers could not be loaded.' }
  }
}

async function writeJson(
  origin: string,
  path: string,
  method: string,
  body: unknown,
): Promise<{ ok: true; connections: McpConnection[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: withCsrf(method, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!response.ok) return { ok: false, message: 'The MCP server change was rejected.' }
    const parsed = (await response.json()) as McpList
    return { ok: true, connections: parsed.connections ?? [] }
  } catch {
    return { ok: false, message: 'The MCP server change was rejected.' }
  }
}
