# Maia - Personal AI Assistant

Maia is a security-focused, personal AI assistant built with TypeScript and Bun. It connects to **free LLM providers** (Ollama, Groq, Google Gemini, HuggingFace, OpenRouter), supports multiple communication channels (CLI, WebChat, Discord, Telegram), and features a sophisticated four-tier memory system with an Obsidian-compatible knowledge graph.

## Philosophy

- **Security first**: Encrypted credential store, prompt injection defense, SSRF protection, a persistent watchdog daemon, and a tool permission model that keeps sensitive data away from the LLM.
- **Test-driven development**: Every module was documented first, tested second, and implemented third. Dependency injection throughout makes every component independently testable.
- **Nothing is ever lost**: Immutable daily logs serve as a complete audit trail. Long-term memory is curated separately in a searchable vector database and human-readable Obsidian vault.
- **Free by default**: Designed to work with completely free LLM providers. No paid API keys required to get started.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Ollama](https://ollama.ai) (recommended for local, free inference)

### Install and Run

```bash
# Clone the repository
git clone https://github.com/your-username/maia.git
cd maia

# Install dependencies
bun install

# Run the onboarding wizard (creates workspace, sets up identity)
bun run maia onboard

# Start the gateway (starts the agent, watchdog, and channels)
bun run maia start

# Or just chat via CLI
bun run maia chat
```

### Minimal Configuration

Create `~/.maia/maia.config.json`:

```json5
{
  "provider": {
    "primary": "ollama",
    "model": "llama3.2"
  },
  "channels": {
    "cli": { "enabled": true }
  }
}
```

That is all you need. Maia will create a workspace at `~/.maia/workspace/` on first run and guide you through a bootstrap conversation to set up its identity.

## Architecture Overview

```
CLI / WebChat / Discord / Telegram
              │
              ▼
┌─────────────────────────────┐
│          Gateway            │
│   HTTP + WebSocket server   │
│   Middleware chain (auth,   │
│   rate-limit, CORS)         │
└────────────┬────────────────┘
             │
     ┌───────┴────────┐
     │  Agent Runtime  │
     │  Session mgmt   │
     │  Tool registry   │
     │  Context builder │
     └───────┬────────┘
             │
  ┌──────────┼──────────┐
  │          │          │
  ▼          ▼          ▼
Providers  Memory    Security
(Ollama,   (4-tier)  (watchdog,
 Groq,     + search  credentials,
 Gemini)             encryption)
```

See [docs/architecture.md](docs/architecture.md) for the full design.

## Memory System (Four Tiers)

| Tier | Storage | Purpose |
|------|---------|---------|
| 1 | `memory/YYYY-MM-DD.md` | Immutable daily logs (append-only, never deleted) |
| 2 | `MEMORY.md` | Agent-curated long-term notes (freeform markdown) |
| 3 | `memory.sqlite` | Vector database with hybrid search (embeddings + FTS5) |
| 4 | `knowledge/` | Obsidian-compatible knowledge vault with `[[wikilinks]]` |

Daily logs feed into all other tiers via **end-of-day consolidation**. See [docs/memory.md](docs/memory.md).

## Security Model

- **Credential store**: AES-256-GCM encrypted vault. The LLM never sees API key values.
- **Watchdog daemon**: Persistent background process monitoring for brute force, prompt injection storms, credential probing. Auto-shuts down on critical threats.
- **Prompt injection defense**: Detection regex + external content wrapping.
- **SSRF protection**: Private IP blocking + DNS pinning.
- **Secret scanner**: Catches accidentally stored API keys in memory.
- **Tool permissions**: Per-context access control (main session vs group chat).
- **Encryption at rest**: Optional AES-256-GCM for sensitive workspace files.
- **Privacy mode**: `/private` command disables all memory capture.

See [docs/security.md](docs/security.md).

## Free LLM Providers

| Provider | Cost | Models |
|----------|------|--------|
| **Ollama** | Free (local) | Llama 3, Mistral, Gemma, Phi |
| **Groq** | Free tier | Llama 3 70B, Mixtral, Gemma |
| **Google Gemini** | Free tier (15 RPM) | Gemini 1.5 Flash, Gemini Pro |
| **HuggingFace** | Free tier | Mistral, Llama, Zephyr |
| **OpenRouter** | Some free models | Various community models |

See [docs/providers.md](docs/providers.md) for step-by-step setup.

## Documentation

- [Architecture](docs/architecture.md) -- Design patterns, data flow, module responsibilities
- [Security](docs/security.md) -- Security model deep dive
- [Memory](docs/memory.md) -- Four-tier memory system and consolidation
- [Providers](docs/providers.md) -- Free LLM provider setup guides
- [Channels](docs/channels.md) -- CLI, WebChat, Discord, Telegram setup
- [Configuration](docs/configuration.md) -- All config options with examples
- [Deployment](docs/deployment.md) -- Production deployment (reverse proxy, TLS, systemd, Docker)
- [API Reference](docs/api.md) -- Gateway REST + WebSocket API
- [Credentials](docs/credentials.md) -- Credential store and LLM-opaque keys
- [Watchdog](docs/watchdog.md) -- Persistent security monitor

## CLI Commands

```bash
maia start              # Start gateway + watchdog + channels
maia chat               # Interactive CLI chat
maia onboard            # First-run setup wizard

maia credentials add    # Add an API key to the encrypted vault
maia credentials list   # List stored credential names
maia credentials remove # Remove a credential

maia backup             # Create encrypted backup archive
maia restore            # Restore from backup

maia schedule list      # List scheduled tasks
maia schedule add       # Add a reminder or recurring task

maia watchdog           # Run watchdog standalone
maia watchdog status    # Show threat level and recent alerts
maia doctor             # One-shot health check

maia --help             # Full command reference
```

## Project Structure

```
maia/
├── src/
│   ├── core/           # Config, logging, types, DI interfaces, shutdown, migrations
│   ├── security/       # Auth, rate limiting, SSRF, credentials, encryption, audit log
│   ├── providers/      # LLM provider abstraction (Ollama, Groq, Gemini, HF, OpenRouter)
│   ├── agent/          # Agent runtime, session management, tools, threading, scheduler
│   ├── memory/         # Four-tier memory: daily logs, MEMORY.md, SQLite store, search
│   ├── knowledge/      # Obsidian knowledge vault: notes, wikilinks, frontmatter
│   ├── workspace/      # Workspace file loader, templates, bootstrap
│   ├── gateway/        # HTTP + WebSocket server, middleware chain
│   ├── channels/       # Channel adapters: CLI, WebChat, Discord, Telegram
│   ├── backup/         # Backup/restore encrypted archives
│   ├── hooks/          # Lifecycle hooks (Observer pattern)
│   └── watchdog/       # Persistent security monitor daemon
├── web/                # WebChat frontend
├── docs/               # Documentation
├── tests/              # Unit + integration tests
└── package.json
```

## License

MIT
