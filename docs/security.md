# Security Model

Security is a first-class subsystem in Maia, not an afterthought. This document covers every security layer, from input validation to the persistent watchdog daemon.

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Incoming Request                        │
│                                                             │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐  │
│  │   Auth   │→ │Rate Limit │→ │  Input   │→ │ Content  │  │
│  │  Token   │  │ Sliding   │  │  Validate│  │ Sanitize │  │
│  │  Check   │  │ Window    │  │  (Zod)   │  │ (Inject  │  │
│  │          │  │           │  │          │  │  Detect) │  │
│  └──────────┘  └───────────┘  └──────────┘  └──────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Tool Permission Check                    │  │
│  │  (context-specific allow/deny before execution)       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Secret Scanner                           │  │
│  │  (scan all memory writes for leaked credentials)      │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Audit Log                                │  │
│  │  (append-only, records all security events)           │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Watchdog Daemon                          │  │
│  │  (persistent monitor, threat detection, auto-shutdown)│  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Authentication

Bearer token authentication with timing-safe comparison to prevent timing attacks.

- Configure via `gateway.auth.token` in config (supports env var substitution: `${MAIA_AUTH_TOKEN}`)
- All HTTP/WebSocket requests must include `Authorization: Bearer <token>`
- Uses `crypto.timingSafeEqual` to prevent timing-based token extraction
- Failed auth attempts are logged to the audit log with IP and timestamp
- The watchdog monitors for brute-force patterns

```http
GET /api/chat HTTP/1.1
Authorization: Bearer your-secret-token
```

## Rate Limiting

Sliding window rate limiter per IP address.

- Configurable via `security.rateLimiting` in config
- Default: 60 requests per 60-second window
- Returns `429 Too Many Requests` with `Retry-After` header when exceeded
- Rate limit events logged to audit log
- Clock is injected (testable with `fixedClock`)
- GET requests for web UI assets (e.g. `/`, `/index.html`, `/styles.css`, `/chat.js`) are exempt so loading the web UI does not trigger 429

## Prompt Injection Defense

Two layers of protection against prompt injection:

### 1. Detection

Regex-based scanning for common injection patterns:

- `ignore previous instructions`
- `you are now`
- `system prompt override`
- `reveal your instructions`
- Custom patterns configurable via config

Detection triggers an audit log event and a watchdog alert. The message is still processed (to avoid false-positive denial of service) but wrapped.

### 2. Content Wrapping

All external (user) content is wrapped with markers:

```
<<<EXTERNAL_UNTRUSTED_CONTENT>>>
{user message here}
<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>
```

This makes it clear to the LLM what is user-provided vs system-provided, reducing injection effectiveness.

## SSRF Protection

Prevents the LLM from using tools (like `web_fetch`) to access internal services.

- **Private IP blocking**: Blocks requests to `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fd00::/8`
- **DNS pinning**: Resolves hostnames before connecting, then checks the resolved IP against the blocklist (prevents DNS rebinding attacks)
- **Protocol restriction**: Only `http:` and `https:` allowed
- Applied to all tool HTTP requests, not just user-facing endpoints

## Input Validation

All external input is validated using Zod schemas before processing:

- Request bodies (chat messages, tool arguments)
- Configuration files
- WebSocket frames
- CLI arguments

Invalid input returns a descriptive error without leaking internal details.

## Content Sanitization

Applied to all incoming messages:

- **Control character stripping**: Removes non-printable characters (except newlines/tabs)
- **Homoglyph folding**: Normalizes lookalike Unicode characters to ASCII equivalents (prevents visual spoofing)
- **Length limits**: Maximum message length enforced per channel

## Sensitive Data Redaction

The structured logger automatically redacts sensitive values:

- API keys (patterns: `sk-*`, `ghp_*`, `xoxb-*`, etc.)
- Tokens (Bearer, Basic auth values)
- Passwords
- Custom redaction patterns configurable

Redacted values appear as `[REDACTED]` in logs.

## File Permission Hardening

On first run, file permissions are set to restrict access:

- `~/.maia/credentials/vault.enc`: `600` (owner read/write only)
- `~/.maia/data/`: `700` (owner only)
- `~/.maia/data/audit.log`: `600`

Note: File permissions are best-effort on Windows (full enforcement on Linux/macOS).

## File Sandbox

When enabled, all file operations are restricted to a single root directory. Any attempt to read, write, or otherwise access a path outside that root is **denied** and **logged** to the security audit log as `FILE_ACCESS_DENIED`, then fails with a security error.

- **Config**: `security.sandbox.enabled` (default: `true`), `security.sandbox.root` (optional)
- **Default root**: When `root` is not set, the sandbox root defaults to `workspace.path`, so the bot may only access files under the workspace directory.
- **Parent root**: If your vault, audit log, or data directory live outside the workspace, set `security.sandbox.root` to a parent directory (e.g. `~/.maia`) so that workspace, credentials, and audit paths all fall under one root. All paths used by the application must be under this root when the sandbox is enabled.
- **Audit**: Each denied access is logged with `path`, `resolvedPath`, and `operation` for forensics.

## Credential Store (LLM-Opaque)

The credential store is the critical security boundary between the LLM and external service authentication.

### How It Works

1. The user stores API keys via CLI: `maia credentials add github-token`
2. Keys are encrypted with AES-256-GCM, master key derived from user passphrase via Argon2id
3. Stored in `~/.maia/credentials/vault.enc`
4. Tool descriptions mention credentials by **name only** (e.g., "uses credential: github-token")
5. At tool execution time, the runtime resolves the name to the actual value and injects it into the HTTP request
6. The LLM never sees the key value -- it is not in the prompt, conversation, or memory

### Why This Matters

Even if a prompt injection tricks the LLM into trying to reveal credentials, it literally does not have them. The credential resolution happens at the transport layer, outside the LLM's context.

See [credentials.md](credentials.md) for detailed usage.

## Secret Scanner

Prevents accidentally leaked secrets from being stored in memory:

- Runs on every memory write: daily log append, MEMORY.md update, `memory_store`, knowledge vault notes
- Regex patterns for common formats:
  - `sk-proj-...` (OpenAI)
  - `ghp_...` (GitHub)
  - `Bearer <token>` patterns
  - `-----BEGIN.*KEY-----` (PEM keys)
  - High-entropy base64 blobs
- On detection: **block the write**, redact the content, log an audit event
- Custom patterns configurable via `security.secretScanner.patterns`

## Tool Permission Model

Context-aware access control for tool usage:

| Context | Default Allowed Tools | Restricted |
|---------|----------------------|------------|
| **Main session** (private) | All tools | None |
| **Group/channel** | `memory_search` | `web_fetch`, file writes, `memory_store` |
| **Consolidation** (automated) | Memory/knowledge writes | Network, file access outside workspace |

- Configured via `security.toolPermissions` in config
- **Deny always wins** over allow (fail-safe)
- Tool invocations are logged to the audit log with context type

## Encryption at Rest

Optional AES-256-GCM encryption for sensitive workspace files:

- **Encrypted by default**: `USER.md`, `MEMORY.md`, daily logs, knowledge vault, session transcripts
- **Not encrypted** (operational files): `SOUL.md`, `AGENTS.md`, `IDENTITY.md`, `TOOLS.md`
- Same master key as credential store (Argon2id derivation)
- Transparent: encrypt on write, decrypt on read
- Enable via `security.encryption.enabled: true`
- Scope configurable via `security.encryption.scope`

## Security Audit Log

Separate, append-only log at `~/.maia/data/audit.log`:

- Auth successes and failures (IP, timestamp)
- Rate limit triggers
- Prompt injection detections (source channel)
- Tool invocations (tool name, context, success/failure)
- Memory writes (tier, category, size)
- Credential access (credential name, tool)
- Secret scanner detections
- **Never contains actual sensitive content -- only metadata**

Format:
```
[2026-02-13T14:30:00.000Z] [AUTH_FAILURE] ip=192.168.1.100 reason="invalid_token"
[2026-02-13T14:30:05.000Z] [RATE_LIMIT] ip=192.168.1.100 remaining=0 window=60000
[2026-02-13T14:30:10.000Z] [INJECTION_DETECTED] channel=discord pattern="ignore previous"
[2026-02-13T14:30:15.000Z] [TOOL_CALL] tool=web_fetch context=main status=success
[2026-02-13T14:30:20.000Z] [CREDENTIAL_ACCESS] name=github-token tool=web_fetch
```

## Privacy Mode

A `/private` command (or API flag) that tells the agent:

- Skip all memory capture for this message or conversation
- Do not write to daily log
- Do not trigger auto-capture
- Do not update MEMORY.md or knowledge vault
- The conversation functions normally, it just leaves no trace in persistent storage
- The audit log records that privacy mode was used (but not the content)
- Useful for sensitive topics the user does not want remembered

## Watchdog Daemon

See [watchdog.md](watchdog.md) for the full specification of the persistent security monitoring daemon.
