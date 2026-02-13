# Watchdog Daemon

The watchdog is a persistent background process that runs alongside the Maia gateway. It continuously monitors for security threats, runs periodic health checks, and can automatically shut down the system when critical threats are detected.

## Overview

The watchdog is **not** a one-shot diagnostic tool (see `maia doctor` for that). It is a long-running daemon that provides real-time security monitoring.

```
┌─────────────────────────────────────────────────┐
│                 Watchdog Daemon                  │
│                                                  │
│  ┌──────────────┐  ┌──────────────────────────┐ │
│  │  Audit Log   │  │   Periodic Health Checks │ │
│  │  Monitor     │  │   (config, providers,    │ │
│  │  (real-time) │  │    channels, workspace,  │ │
│  │              │  │    database, credentials)│ │
│  └──────┬───────┘  └────────────┬─────────────┘ │
│         │                       │                │
│  ┌──────▼───────────────────────▼──────────────┐ │
│  │          Threat Detector                    │ │
│  │  Pattern matching on sliding event window   │ │
│  └──────────────────┬──────────────────────────┘ │
│                     │                            │
│  ┌──────────────────▼──────────────────────────┐ │
│  │               Alerter                       │ │
│  │  Console, channel message, system notif     │ │
│  └──────────────────┬──────────────────────────┘ │
│                     │                            │
│  ┌──────────────────▼──────────────────────────┐ │
│  │          Emergency Shutdown                 │ │
│  │  (on CRITICAL threats, if enabled)          │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## Starting the Watchdog

The watchdog starts automatically with the gateway:

```bash
maia start   # Starts gateway + watchdog
```

Or run standalone:

```bash
maia watchdog   # Run watchdog as standalone process
```

## Threat Detection

The watchdog maintains a sliding window of security events (default: 5 minutes) and matches them against threat patterns.

### Threat Patterns

| Pattern | Trigger | Level | Action |
|---------|---------|-------|--------|
| **Brute force** | N auth failures from same IP in window | WARN -> CRITICAL | Alert, temporary IP suggestion |
| **Injection storm** | N prompt injection detections in window | WARN -> CRITICAL | Alert, consider channel lockdown |
| **Credential probing** | Repeated attempts to extract credential values | CRITICAL | Alert + auto-shutdown |
| **File tampering** | Unexpected changes to SOUL.md, AGENTS.md, config | WARN | Alert, re-verify checksums |
| **Anomalous tool usage** | Unusual web_fetch or file access patterns | WARN | Alert |
| **Rate limit exhaustion** | Sustained rate limit hits suggesting automation | WARN | Alert |

### Sliding Window

Events are kept in a fixed-duration window (default: 5 minutes). As events age out, the threat counters decrease. This means:

- A single auth failure is normal (logged as INFO)
- 10 auth failures in 5 minutes from the same IP triggers a WARN
- Sustained failures escalate to CRITICAL

### Escalation

Threats escalate based on severity and persistence:

```
Single event → INFO (logged only)
Threshold crossed → WARN (user notified)
Sustained/severe → CRITICAL (auto-shutdown if enabled)
```

## Alert Levels

### INFO

- Logged to watchdog alert log only
- Not sent to user
- Examples: successful auth, routine tool calls, health check pass

### WARN

- Logged + sent to user via configured alert channel
- Examples: single auth failure, prompt injection detected, health check degraded

### CRITICAL

- Logged + sent to user immediately + **auto-shutdown** (if enabled)
- Examples: credential probing, sustained brute force, file tampering on security files
- The shutdown is graceful (flushes logs, closes DB, disconnects channels)

## Alert Dispatch

Alerts are sent through configured channels:

```json5
{
  "watchdog": {
    "alertChannels": ["console", "discord"]
  }
}
```

| Channel | How It Works |
|---------|-------------|
| `console` | Always enabled, prints to stdout |
| `discord` | Sends a DM to the bot owner |
| `telegram` | Sends a message to the configured chat |
| `webhook` | POST to a configured URL (for external monitoring) |

### Alert Format

```
⚠️ [WARN] Brute force attempt detected
IP: 192.168.1.100
Events: 10 auth failures in 5 minutes
Time: 2026-02-13 14:30:00 UTC
Recommendation: Check if this IP should be blocked
```

```
🚨 [CRITICAL] Credential probing detected
Source: discord channel #general
Events: 5 attempts to extract credential values via tool calls
Time: 2026-02-13 14:31:00 UTC
Action: AUTO-SHUTDOWN initiated
```

## Periodic Health Checks

The watchdog runs health checks on a configurable interval (default: 60 seconds).

### Check Categories

| Check | What It Verifies | Failure Action |
|-------|-----------------|----------------|
| **Config** | Config file is valid and parseable | WARN |
| **Providers** | Each configured provider responds to health check | WARN (per provider) |
| **Channels** | Each enabled channel is authenticated and connected | WARN (per channel) |
| **Workspace** | Critical files exist and have expected checksums | WARN or CRITICAL |
| **Database** | SQLite is accessible, schema version matches | WARN |
| **Credentials** | Vault file exists, is not corrupted | WARN |
| **Permissions** | File permissions on sensitive files are correct | WARN |

### File Integrity

The watchdog maintains checksums for critical workspace files:

- `SOUL.md`, `AGENTS.md`, `TOOLS.md` -- should not change unexpectedly
- `maia.config.json` -- configuration tampering detection

Checksums are stored in `~/.maia/data/watchdog/checksums.json` and updated after legitimate changes.

When a mismatch is detected:
1. Alert the user
2. Log the event
3. Record the new checksum (so the same alert is not repeated)

## Watchdog State

State is persisted in `~/.maia/data/watchdog/`:

```
watchdog/
├── state.json       # Runtime state (threat counters, last check times)
├── alerts.log       # Alert history (append-only)
└── checksums.json   # File integrity checksums
```

### state.json

```json
{
  "startedAt": "2026-02-13T08:00:00.000Z",
  "lastHealthCheck": "2026-02-13T14:29:00.000Z",
  "threatCounters": {
    "authFailures": { "count": 2, "windowStart": "2026-02-13T14:25:00.000Z" },
    "injectionDetections": { "count": 0, "windowStart": "2026-02-13T14:25:00.000Z" }
  }
}
```

## CLI Commands

### Status

```bash
maia watchdog status
```

```
Watchdog Status: RUNNING
Uptime: 6h 30m
Threat Level: NONE
Recent Alerts: 0 (last 24h)
Last Health Check: 2026-02-13 14:29:00 UTC (all OK)
```

### Alert History

```bash
maia watchdog history
```

```
Alert History (last 24h):
  [2026-02-13 10:15] WARN  - Auth failure from 192.168.1.50
  [2026-02-13 12:30] WARN  - Prompt injection detected in #general
  [2026-02-13 14:00] INFO  - Health check: provider groq degraded
```

### One-Shot Doctor

For manual diagnostics without a running watchdog:

```bash
maia doctor
```

```
Maia Health Report
──────────────────
✓ Config: Valid
✓ Ollama: Connected (llama3.2, latency: 120ms)
✗ Groq: Unreachable (connection timeout)
✓ Discord: Connected
✗ Telegram: Not configured
✓ Workspace: All files present
✓ Database: Healthy (1,234 memories, schema v3)
✓ Credentials: Vault intact
✓ Permissions: Correct
⚠ Knowledge vault: 2 broken [[wikilinks]]
```

## Configuration

```json5
{
  "watchdog": {
    "enabled": true,
    "healthCheckIntervalMs": 60000,
    "threatWindow": {
      "durationMs": 300000,        // 5-minute sliding window
      "bruteForceThreshold": 10,   // Auth failures before WARN
      "injectionThreshold": 5      // Injections before WARN
    },
    "alertChannels": ["console", "discord"],
    "autoShutdown": true           // Shutdown on CRITICAL
  }
}
```

## Integration with Gateway

When the watchdog issues a CRITICAL alert with `autoShutdown: true`:

1. Watchdog signals the ShutdownCoordinator
2. ShutdownCoordinator runs the graceful shutdown sequence
3. All active sessions are saved
4. Database is closed cleanly
5. Channels are disconnected
6. Audit log records the shutdown reason
7. Process exits with code 1
