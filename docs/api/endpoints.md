# API Endpoints

All endpoints are Next.js App Router API routes under `src/app/api/`.

## Authentication

For the initial local-only version, no authentication is required. All API routes are accessible without credentials since the system runs locally.

## Error responses

JSON error responses use a standard shape so clients can parse them consistently:

```typescript
{
  error: string;   // Human-readable message; always present
  code?: string;   // Optional machine-readable code (e.g. "VALIDATION", "NOT_FOUND")
}
```

Typical status codes:

- **400** – Validation failed (e.g. invalid request body, missing required field). Use `error` to describe what is wrong.
- **404** – Resource not found (e.g. task, session, agent by id).
- **500** – Unexpected server error. Return a generic message; log the real error server-side. Do not expose internal details in the response.

All API routes that can throw (Zod parse, `ensureAppContext`, domain, DB) should be wrapped in try/catch and return one of these responses instead of letting unhandled exceptions become a 500 with a stack trace.

## Chat

### `POST /api/chat`

Send a message to an agent. Starts or continues a session.

**Request body:**

```typescript
{
  message: string;
  sessionId?: string;          // omit to use active session
  targetAgent?: string;        // defaults to "maia"; orchestrator agent id for the session
}
```

Leading `@<persona-id>` in `message` may be parsed as a **persona turn** on the same session (see `src/app/api/chat/route.ts`). New user threads use participants `["user", "maia"]`.

The runner builds context in-process: embeddings refresh for `data/` and history, **pre-prompt recall** (SQLite registry, episodes, on-disk PARA under `life/`, daily notes) is merged into the smart-context block, then per-turn semantic search uses **`knowledge_vectors` / `history_vectors`** only (no external vector DB).

**Response:** Server-Sent Events (streaming)

```typescript
// Stream of events:
{ type: "token", content: string }           // streaming response tokens
{ type: "tool_call", tool: string, args: object }
{ type: "tool_result", tool: string, result: unknown }
{ type: "done", sessionId: string, compressed: HistoryEntry, original: HistoryEntry }
{ type: "error", message: string }
```

---

## Sessions

### `GET /api/sessions`

List all sessions with metadata.

**Query params:**

- `type`: `"user"` | `"agents"` | `"all"` (default: `"all"`)

**Response:**

```typescript
{
  sessions: Array<{
    id: string;
    name: string;
    description: string;
    participants: string[];
    tags: string[];
    createdAt: string;
    updatedAt: string;
  }>;
}
```

### `POST /api/sessions`

Create a new session.

**Request body:**

```typescript
{ participants?: string[] }   // defaults to ["user", "maia"]
```

**Response:**

```typescript
{
  sessionId: string;
}
```

### `GET /api/sessions/active`

Get the currently active user session.

**Response:**

```typescript
{
  sessionId: string | null;
  session: Session | null;
}
```

### `PUT /api/sessions/active`

Set the active session.

**Request body:**

```typescript
{
  sessionId: string;
}
```

### `GET /api/sessions/[id]`

Get full session data.

**Query params:**

- `mode`: `"compressed"` | `"original"` | `"both"` (default: `"both"`)

**Response:** `Session` object

### `GET /api/sessions/[id]/search`

Fuzzy search within a session.

**Query params:**

- `q`: search string
- `mode`: `"compressed"` | `"original"` | `"both"`

**Response:**

```typescript
{ entries: HistoryEntry[] }
```

---

## Agents

### `GET /api/agents`

List all agents.

**Response:**

```typescript
{
  agents: AgentDefinition[]
}
```

### `GET /api/agents/[id]`

Get a specific agent.

**Response:** `AgentDefinition` with identity file contents included:

```typescript
{
  agent: AgentDefinition;
  soul: string;
  memory: string;
  goals: string;
  user: string;
}
```

### `DELETE /api/agents/[id]`

Delete an agent (Maia only — enforced server-side).

---

## Personas

Templates live under `defaults/personas/catalog` and `data/personas/catalog` (Codex-style `.toml`); optional markdown overrides in `data/personas/overrides/<id>.md`.

### `GET /api/personas`

**Response:**

```typescript
{
  personas: Array<{
    id: string;
    name: string;
    description: string;
    suggestedModelHint?: string;
    sandboxMode?: string;
  }>;
}
```

### `GET /api/personas/[id]`

**Response:** Full persona definition for one id (including `instructions` text), or 404.

---

## Dashboard

### `GET /api/dashboard`

Aggregates monitor data for the UI: agents, **personas** (catalog summary), task counts, recent `type: "user"` / agent sessions, and cron jobs.

---

## History Search

### `GET /api/history/search`

Search across all sessions.

**Query params:**

- `q`: fuzzy search string
- `mode`: `"compressed"` | `"original"` | `"both"`
- `tags`: comma-separated tag list (filter)

**Response:**

```typescript
{
  results: Array<{
    sessionId: string;
    sessionName: string;
    entries: HistoryEntry[];
  }>;
}
```

---

## Settings

### `GET /api/settings`

Get current settings (API keys are not returned — only presence indicated).

**Response:**

```typescript
{
  whitelistedModels: string[];
  compressionModel: string;
  heartbeatIntervalMinutes: number;
  ollamaBaseUrl: string;
  hasOpenRouterKey: boolean;    // true/false, never the key value
}
```

### `PUT /api/settings`

Update settings.

**Request body:** Partial settings object (same shape as GET response, no key values).

### `GET /api/model-capabilities`

Returns capabilities for all whitelisted models (provider, reasoning support, tools support). Used by the Settings page to enable/disable reasoning effort and to know if a model supports tool calling.

**Response:**

```typescript
{
  modelCapabilities: Record<
    string,
    {
      provider: "ollama" | "openrouter";
      supportsReasoning: boolean;
      supportsTools?: boolean; // Ollama: from /api/show capabilities; OpenRouter: true
    }
  >;
}
```

For Ollama models, when `ollamaBaseUrl` is set, the server queries each model via Ollama `POST /api/show` and reads the `capabilities` array (`thinking` and `tools`). On failure or when baseUrl is empty, reasoning falls back to heuristics (e.g. embedding models do not support reasoning); tools default to true.

---

## Events (SSE)

### `GET /api/events`

Subscribe to real-time events from the system.

**Response:** Server-Sent Events stream. Events:

```typescript
// New message in any session
event: message
data: { sessionId: string; entry: HistoryEntry; participants: string[] }

// Session created
event: session_created
data: { session: Session }

// Session name/description/tags updated (e.g. compression agent), or default delegated persona for plain user messages (`defaultPersonaId`, optional)
event: session_updated
data: { sessionId: string; name: string; description: string; tags: string[]; defaultPersonaId?: string | null }

// Agent status change
event: agent_status
data: { agentId: string; status: "idle" | "running" | "paused" }

// Heartbeat fired
event: heartbeat
data: { timestamp: string }

// Keep-alive (every 15s to prevent connection timeout)
event: ping
data: { timestamp: string }
```

---

## Credentials

### `GET /api/credentials`

List credential keys (values never exposed).

**Response:**

```typescript
{ keys: string[] }
```

### `POST /api/credentials`

Create a credential.

**Request body:**

```typescript
{
  key: string;
  value: string;
}
```

### `PUT /api/credentials/[key]`

Update a credential's value.

**Request body:**

```typescript
{
  value: string;
}
```

### `DELETE /api/credentials/[key]`

Delete a credential.

---

## Cron (Internal)

### `POST /api/cron/heartbeat`

Triggered by the internal cron scheduler. Fires the heartbeat to all active agents. Not intended for external use.

### `GET /api/cron/jobs`

List active cron jobs (with `scheduleDescription` and `nextRunAt`).

**Response:**

```typescript
{ jobs: CronJob[] }
```

### `POST /api/cron/jobs`

Create a user schedule from the UI: `{ expression, taskDescription, wakeType: "wake_up" | "custom", delegateTo: "maia" | "persona", personaId?, personaModel?, customMessage?, boardTask?: { title, description?, assignedTo? } }`. Returns `201` with the created job JSON.

### `PATCH /api/cron/jobs/:id`

Update a **non-built-in** schedule (`400` for built-in rows). Body may include `expression`, `taskDescription`, `personaId`, `personaModel`, `cronMessage`. The server always persists `agent_id: "maia"`, `tool_name: "cron_echo"`, and `tool_args: {}`. Empty `cronMessage` with no persona is stored as the default task-board wake paragraph.

### `DELETE /api/cron/jobs/:id`

Delete a non-built-in job (built-in rows return `400`).
