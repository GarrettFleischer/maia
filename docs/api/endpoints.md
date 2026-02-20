# API Endpoints

All endpoints are Next.js App Router API routes under `src/app/api/`.

## Authentication

For the initial local-only version, no authentication is required. All API routes are accessible without credentials since the system runs locally.

## Chat

### `POST /api/chat`

Send a message to an agent. Starts or continues a session.

**Request body:**
```typescript
{
  message: string;
  sessionId?: string;          // omit to use active session
  targetAgent?: string;        // agent_id for @mention routing; defaults to "maia"
}
```

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
  }>
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
{ sessionId: string }
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
{ sessionId: string }
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
  }>
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

// Session name/description updated by compression agent
event: session_updated
data: { sessionId: string; name: string; description: string; tags: string[] }

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
{ key: string; value: string }
```

### `PUT /api/credentials/[key]`

Update a credential's value.

**Request body:**
```typescript
{ value: string }
```

### `DELETE /api/credentials/[key]`

Delete a credential.

---

## Cron (Internal)

### `POST /api/cron/heartbeat`

Triggered by the internal cron scheduler. Fires the heartbeat to all active agents. Not intended for external use.

### `GET /api/cron/jobs`

List active cron jobs.

**Response:**
```typescript
{
  jobs: CronJob[]
}
```
