# Gateway API Reference

The Maia gateway exposes an HTTP REST API and a WebSocket endpoint for real-time chat.

## Base URL

```
http://localhost:3000
```

Port is configurable via `gateway.port` in config.

## Authentication

All endpoints (except health check) require Bearer token authentication:

```http
Authorization: Bearer your-secret-token
```

The token is configured via `gateway.auth.token` in config (supports env var substitution).

## REST Endpoints

### Health Check

```http
GET /api/health
```

No authentication required.

**Response** `200 OK`:
```json
{
  "status": "healthy",
  "uptime": 3600,
  "providers": {
    "ollama": {
      "status": "healthy",
      "latencyP50": 120,
      "latencyP95": 450,
      "model": "llama3.2"
    },
    "groq": {
      "status": "degraded",
      "latencyP50": 80,
      "latencyP95": 200,
      "consecutiveFailures": 1
    }
  },
  "channels": {
    "cli": { "status": "connected" },
    "discord": { "status": "connected" },
    "telegram": { "status": "disconnected" }
  },
  "memory": {
    "entries": 1234,
    "dbSizeBytes": 5242880
  },
  "watchdog": {
    "status": "running",
    "threatLevel": "none"
  }
}
```

### Send Message

```http
POST /api/chat
Content-Type: application/json
Authorization: Bearer your-secret-token
```

**Request body**:
```json
{
  "message": "Hello, how are you?",
  "sessionId": "optional-session-id",
  "private": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | The message to send |
| `sessionId` | string | No | Session ID for conversation continuity |
| `private` | boolean | No | Enable privacy mode (no memory capture) |

**Response** `200 OK`:
```json
{
  "response": "I'm doing well! How can I help you today?",
  "sessionId": "sess_abc123",
  "metadata": {
    "provider": "ollama",
    "model": "llama3.2",
    "tokensUsed": 45,
    "latencyMs": 230
  }
}
```

### Search Memory

```http
POST /api/memory/search
Content-Type: application/json
Authorization: Bearer your-secret-token
```

**Request body**:
```json
{
  "query": "TypeScript preferences",
  "category": "preference",
  "limit": 5
}
```

**Response** `200 OK`:
```json
{
  "results": [
    {
      "id": "mem_abc123",
      "text": "User prefers TypeScript over JavaScript",
      "category": "preference",
      "importance": 0.9,
      "score": 0.87,
      "createdAt": "2026-02-10T14:30:00.000Z"
    }
  ]
}
```

### Store Memory

```http
POST /api/memory/store
Content-Type: application/json
Authorization: Bearer your-secret-token
```

**Request body**:
```json
{
  "text": "User prefers ESM over CommonJS",
  "category": "preference",
  "importance": 0.8
}
```

**Response** `201 Created`:
```json
{
  "id": "mem_def456",
  "text": "User prefers ESM over CommonJS",
  "category": "preference",
  "importance": 0.8,
  "createdAt": "2026-02-13T14:30:00.000Z"
}
```

### Delete Memory

```http
DELETE /api/memory/:id
Authorization: Bearer your-secret-token
```

**Response** `204 No Content`

### List Scheduled Tasks

```http
GET /api/schedule
Authorization: Bearer your-secret-token
```

**Response** `200 OK`:
```json
{
  "tasks": [
    {
      "id": "task_001",
      "schedule": "2026-02-14T15:00:00.000Z",
      "prompt": "Remind me to check the deployment",
      "channel": "discord",
      "status": "pending"
    }
  ]
}
```

### Trigger Consolidation

```http
POST /api/memory/consolidate
Authorization: Bearer your-secret-token
```

Triggers an on-demand end-of-day consolidation.

**Response** `202 Accepted`:
```json
{
  "status": "started",
  "date": "2026-02-13"
}
```

### Watchdog Status

```http
GET /api/watchdog/status
Authorization: Bearer your-secret-token
```

**Response** `200 OK`:
```json
{
  "running": true,
  "threatLevel": "none",
  "recentAlerts": [],
  "lastHealthCheck": "2026-02-13T14:29:00.000Z",
  "healthStatus": {
    "config": "ok",
    "providers": "ok",
    "channels": "degraded",
    "workspace": "ok",
    "database": "ok",
    "credentials": "ok"
  }
}
```

## WebSocket API

### Connect

```
ws://localhost:3000/ws?token=your-secret-token
```

The token can be passed as a query parameter or in the first message.

### Message Format

All WebSocket messages are JSON:

**Client -> Server (send message)**:
```json
{
  "type": "message",
  "content": "Hello!",
  "sessionId": "optional-session-id",
  "private": false
}
```

**Server -> Client (response chunk -- streaming)**:
```json
{
  "type": "chunk",
  "content": "I'm ",
  "sessionId": "sess_abc123"
}
```

**Server -> Client (response complete)**:
```json
{
  "type": "done",
  "sessionId": "sess_abc123",
  "metadata": {
    "provider": "ollama",
    "model": "llama3.2",
    "tokensUsed": 45,
    "latencyMs": 230
  }
}
```

**Server -> Client (error)**:
```json
{
  "type": "error",
  "code": "RATE_LIMITED",
  "message": "Too many requests. Please wait."
}
```

**Server -> Client (thinking indicator)**:
```json
{
  "type": "thinking",
  "message": "Queued (position 2/3)..."
}
```

## Error Responses

All errors follow a consistent format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid auth token |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `VALIDATION_ERROR` | 400 | Invalid request body |
| `PROVIDER_ERROR` | 502 | LLM provider failed |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## Rate Limiting

- Default: 60 requests per 60-second sliding window
- Rate limit headers included in responses:
  ```
  X-RateLimit-Limit: 60
  X-RateLimit-Remaining: 45
  X-RateLimit-Reset: 1707840000
  ```
- `429` response includes `Retry-After` header

## CORS

Configurable via `gateway.cors.origins`. Default: same origin only.
