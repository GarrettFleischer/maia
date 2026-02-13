# Configuration

Maia is configured via a JSON5 configuration file and environment variables.

## Config File Location

Default: `~/.maia/maia.config.json`

Override with the `MAIA_CONFIG` environment variable:

```bash
MAIA_CONFIG=/path/to/my/config.json maia start
```

## Environment Variable Substitution

Any string value in the config can reference environment variables using `${VAR_NAME}`:

```json5
{
  "gateway": {
    "auth": {
      "token": "${MAIA_AUTH_TOKEN}"
    }
  }
}
```

## Full Configuration Reference

```json5
{
  // ─── Identity ───────────────────────────────────────────
  // Can also be set via IDENTITY.md in workspace
  "identity": {
    "name": "Maia",            // Agent display name
    "emoji": "🌙",             // Agent emoji/avatar
    "personality": "helpful, security-conscious assistant"
  },

  // ─── Workspace ──────────────────────────────────────────
  "workspace": {
    "path": "~/.maia/workspace"  // Path to workspace directory
  },

  // ─── LLM Provider ──────────────────────────────────────
  "provider": {
    "primary": "ollama",         // Primary provider id
    "model": "llama3.2",         // Primary model name
    "fallback": {                // Optional fallback
      "provider": "groq",
      "model": "llama-3.3-70b-versatile"
    },
    "healthCheck": {
      "enabled": true,
      "intervalMs": 60000,       // Health check interval
      "consecutiveFailures": 3   // Failures before fallback
    },
    "ollama": {
      "baseUrl": "http://localhost:11434"
    },
    "groq": {
      "credentialName": "groq-api-key"
    },
    "gemini": {
      "credentialName": "gemini-api-key"
    },
    "huggingface": {
      "credentialName": "hf-api-token"
    },
    "openrouter": {
      "credentialName": "openrouter-api-key"
    }
  },

  // ─── Gateway ────────────────────────────────────────────
  "gateway": {
    "port": 3000,                // HTTP/WS server port
    "host": "0.0.0.0",          // Bind address
    "auth": {
      "token": "${MAIA_AUTH_TOKEN}"  // Bearer token
    },
    "cors": {
      "origins": ["http://localhost:3000"]  // Allowed origins
    }
  },

  // ─── Channels ───────────────────────────────────────────
  "channels": {
    "cli": {
      "enabled": true
    },
    "webchat": {
      "enabled": true
    },
    "discord": {
      "enabled": false,
      "credentialName": "discord-bot-token"
    },
    "telegram": {
      "enabled": false,
      "credentialName": "telegram-bot-token"
    }
  },

  // ─── Memory ─────────────────────────────────────────────
  "memory": {
    "enabled": true,
    "embeddingProvider": "ollama",    // Which provider for embeddings
    "embeddingModel": "nomic-embed-text",
    "search": {
      "hybrid": {
        "enabled": true,
        "vectorWeight": 0.7,         // Weight for vector similarity
        "textWeight": 0.3            // Weight for FTS5 keyword match
      },
      "defaultLimit": 5             // Default number of results
    },
    "autoCapture": true,             // Auto-store preferences, decisions
    "autoRecall": true,              // Auto-inject relevant memories
    "consolidation": {
      "schedule": "0 23 * * *",      // Cron: 11 PM daily
      "onDemand": true,              // Allow manual trigger
      "sizeThreshold": 5000          // Trigger if log exceeds N chars
    }
  },

  // ─── Security ───────────────────────────────────────────
  "security": {
    "rateLimiting": {
      "maxRequests": 60,             // Max requests per window
      "windowMs": 60000              // Window size in ms
    },
    "promptInjection": {
      "detection": true,             // Enable detection regex
      "wrapping": true               // Wrap external content
    },
    "ssrf": {
      "blockPrivateIPs": true        // Block private IP ranges
    },
    "encryption": {
      "enabled": true,               // Enable encryption at rest
      "scope": [                     // Files/dirs to encrypt
        "USER.md",
        "MEMORY.md",
        "memory/",
        "knowledge/"
      ]
    },
    "secretScanner": {
      "enabled": true,
      "patterns": []                 // Additional regex patterns
    },
    "auditLog": {
      "enabled": true
    },
    "toolPermissions": {
      "main": {
        "allow": ["*"]              // All tools in main sessions
      },
      "group": {
        "allow": ["memory_search"],  // Limited in group contexts
        "deny": ["web_fetch", "memory_store"]
      }
    }
  },

  // ─── Scheduler ──────────────────────────────────────────
  "scheduler": {
    "enabled": true,
    "checkIntervalMs": 60000         // Check for due tasks every minute
  },

  // ─── Watchdog ───────────────────────────────────────────
  "watchdog": {
    "enabled": true,
    "healthCheckIntervalMs": 60000,  // Periodic health check interval
    "threatWindow": {
      "durationMs": 300000,          // 5-minute sliding window
      "bruteForceThreshold": 10,     // Auth failures before alert
      "injectionThreshold": 5        // Injection detections before alert
    },
    "alertChannels": ["console"],    // Where to send alerts
    "autoShutdown": true             // Shutdown on CRITICAL threats
  },

  // ─── Session ────────────────────────────────────────────
  "session": {
    "compaction": {
      "thresholdPercent": 80,        // Compact at 80% of context window
      "preserveRecentMessages": 10   // Keep last N messages uncompacted
    }
  },

  // ─── Backup ─────────────────────────────────────────────
  "backup": {
    "includeAuditLog": false         // Whether to include audit.log
  }
}
```

## Minimal Configuration

The absolute minimum to get started:

```json5
{
  "provider": {
    "primary": "ollama",
    "model": "llama3.2"
  }
}
```

Everything else has sensible defaults:
- CLI channel enabled
- Memory enabled with Ollama embeddings
- Security enabled with default settings
- Workspace at `~/.maia/workspace/`

## Environment Variables

| Variable | Purpose | Used By |
|----------|---------|---------|
| `MAIA_CONFIG` | Override config file path | CLI |
| `MAIA_AUTH_TOKEN` | Gateway auth token | Config |
| `MAIA_LOG_LEVEL` | Log level (debug/info/warn/error) | Logger |
| `MAIA_WORKSPACE` | Override workspace path | Config |

## Config Validation

Configuration is validated at startup using Zod schemas. Invalid configuration produces a clear error message with the specific field and expected type:

```
Config validation failed:
  - provider.primary: Expected "ollama" | "groq" | "gemini" | "huggingface" | "openrouter", received "invalid"
  - gateway.port: Expected number, received string
```

## Runtime Config Changes

Configuration is loaded once at startup. Changes require a restart. This is by design -- runtime config changes are a source of hard-to-debug issues.
