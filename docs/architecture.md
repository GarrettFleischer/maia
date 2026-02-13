# Architecture

This document describes Maia's architecture, design patterns, module responsibilities, and data flow.

## Design Principles

1. **Dependency Injection everywhere**: No module directly imports `fs`, `fetch`, `crypto`, `Date`, or SQLite. Every external dependency is injected via typed interfaces, making all components independently testable with mocks.
2. **Security as a first-class layer**: Security is not bolted on -- it is a dedicated subsystem with its own modules, audit log, and a persistent watchdog daemon.
3. **Test-driven development**: Documentation defines intent, tests define contracts, code makes tests pass.
4. **Clean separation of concerns**: Each module has a single responsibility and communicates through well-defined interfaces.

## Module Dependency Graph

```
┌─────────────────────────────────────────────────────┐
│                    index.ts (CLI)                    │
└──────────┬──────────────────────────────┬───────────┘
           │                              │
     ┌─────▼─────┐                 ┌──────▼──────┐
     │  Gateway   │                 │  Watchdog   │
     │  (HTTP+WS) │                 │  (daemon)   │
     └─────┬─────┘                 └──────┬──────┘
           │                              │
     ┌─────▼─────────────────────────┐    │
     │        Agent Runtime          │    │
     │  ┌─────────┐ ┌────────────┐  │    │
     │  │ Session  │ │  Context   │  │    │
     │  │  Mgmt    │ │  Builder   │  │    │
     │  └────┬────┘ └─────┬──────┘  │    │
     │       │            │          │    │
     │  ┌────▼────────────▼──────┐  │    │
     │  │      Tool Registry     │  │    │
     │  └────────────┬───────────┘  │    │
     └───────────────┼──────────────┘    │
                     │                    │
  ┌──────────┬───────┼────────┬──────────┤
  │          │       │        │          │
  ▼          ▼       ▼        ▼          ▼
Channels  Providers Memory  Security   Hooks
  │          │       │        │
  │          │       │     ┌──┴──────────────┐
  │          │       │     │ Auth             │
  │          │       │     │ Rate Limiter     │
  │          │       │     │ SSRF Guard       │
  │          │       │     │ Credential Store │
  │          │       │     │ Secret Scanner   │
  │          │       │     │ Encryption       │
  │          │       │     │ Audit Log        │
  │          │       │     │ Tool Permissions │
  │          │       │     └─────────────────┘
  │          │       │
  │          │    ┌──┴──────────────────┐
  │          │    │ Daily Log (Tier 1)  │
  │          │    │ MEMORY.md (Tier 2)  │
  │          │    │ SQLite DB (Tier 3)  │
  │          │    │ Knowledge (Tier 4)  │
  │          │    │ Consolidator        │
  │          │    │ Auto-Recall         │
  │          │    └─────────────────────┘
  │          │
  │       ┌──┴─────────────────┐
  │       │ Ollama             │
  │       │ Groq               │
  │       │ Gemini             │
  │       │ HuggingFace        │
  │       │ OpenRouter         │
  │       │ Health Monitor     │
  │       │ Request Queue      │
  │       └────────────────────┘
  │
  ├── CLI
  ├── WebChat
  ├── Discord
  └── Telegram
```

All modules sit on top of the **Core** layer which provides:

- `MaiaContext` -- aggregate dependency container
- `FileSystem`, `Clock`, `HttpClient`, `CryptoProvider`, `Database`, `EnvProvider` -- DI interfaces
- Config loader (Zod validation + env var substitution)
- Structured logger with sensitive data redaction
- Typed error hierarchy
- EventBus (Observer pattern)
- ShutdownCoordinator (graceful shutdown)
- Migration runner (database schema versioning)

## Design Patterns

### 1. Dependency Injection (Foundation)

Every module receives its dependencies through constructor/factory parameters. No DI framework -- just TypeScript interfaces and factory functions.

```typescript
// Each module declares what it needs
interface DailyLogDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly secretScanner: SecretScanner;
  readonly auditLog: AuditLog;
}

// Factory function accepts deps
function createDailyLog(deps: DailyLogDeps): DailyLog { ... }

// Production: real deps. Tests: mocks.
```

**Core DI interfaces** (defined in `src/core/types.ts`):

| Interface | Abstracts | Test Mock |
|-----------|-----------|-----------|
| `FileSystem` | Node `fs` module | `inMemoryFileSystem()` |
| `Clock` | `Date.now()`, date formatting | `fixedClock()` |
| `EnvProvider` | `process.env` | `staticEnv()` |
| `HttpClient` | `fetch` / HTTP requests | `mockHttpClient()` |
| `CryptoProvider` | `crypto` module | Deterministic crypto |
| `Database` | SQLite connection | `inMemoryDatabase()` |

**`MaiaContext`** is the aggregate container created once at startup and threaded through all modules:

```typescript
interface MaiaContext {
  readonly config: MaiaConfig;
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly env: EnvProvider;
  readonly http: HttpClient;
  readonly crypto: CryptoProvider;
  readonly db: Database;
  readonly logger: Logger;
  readonly events: EventBus;
  readonly credentials: CredentialStore;
  readonly auditLog: AuditLog;
}
```

### 2. Strategy Pattern -- LLM Providers

Each provider implements a common `LLMProvider` interface. The `ProviderRegistry` manages them with health monitoring, automatic fallback, and request queuing.

```typescript
interface LLMProvider {
  readonly id: string;
  readonly name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatChunk>;
  embed?(texts: string[]): Promise<number[][]>;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<boolean>;
  contextWindowSize(model: string): number;
}
```

### 3. Adapter Pattern -- Channels

Each channel (CLI, WebChat, Discord, Telegram) implements a common `Channel` interface with a `MessageFormatter` for channel-specific output formatting.

```typescript
interface Channel {
  readonly id: string;
  readonly name: string;
  initialize(config: ChannelConfig): Promise<void>;
  shutdown(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  onMessage(handler: InboundMessageHandler): void;
}
```

### 4. Repository Pattern -- Memory Store

The SQLite store abstracts data access for the vector database (Tier 3). Receives `Database` via DI.

### 5. Middleware Pattern -- Gateway

Composable middleware chain for HTTP/WebSocket requests: auth, rate limiting, CORS, error handling. Each middleware receives its dependencies via DI.

### 6. Observer Pattern -- Lifecycle Hooks

Event-driven hooks (`beforeAgentStart`, `afterAgentEnd`, `messageReceived`, `messageSent`) via an injected `EventBus`.

## Data Flow

### Message Processing

```
1. Channel receives message (Discord, Telegram, CLI, WebChat)
2. Channel adapter normalizes to InboundMessage
3. Gateway routes to Agent Runtime
4. Agent Runtime:
   a. Load workspace context (SOUL.md, AGENTS.md, USER.md, etc.)
   b. Auto-recall: search memory DB, inject relevant memories
   c. Build system prompt (compose all layers)
   d. Check privacy mode
   e. Send to LLM provider (with fallback/queue)
   f. Stream response chunks
   g. Execute any tool calls (memory_store, web_fetch, etc.)
   h. Write to daily log (unless privacy mode)
   i. Auto-capture: check for capturable content
5. Format response for target channel
6. Channel adapter sends formatted response
7. Audit log records the interaction metadata
```

### End-of-Day Consolidation

```
1. Scheduler triggers consolidation (configurable time, or on-demand)
2. Read today's daily log (memory/YYYY-MM-DD.md)
3. Send to LLM with consolidation prompt
4. LLM extracts important items:
   a. Store structured items in vector DB (Tier 3)
   b. Update MEMORY.md with new insights (Tier 2)
   c. Create/update Obsidian notes with [[wikilinks]] (Tier 4)
5. Daily log is left completely intact (Tier 1)
```

### Graceful Shutdown

```
1. Signal received (SIGINT, SIGTERM, watchdog critical alert)
2. ShutdownCoordinator runs hooks in reverse dependency order:
   a. Stop accepting new requests
   b. Flush daily log writes
   c. Save session state
   d. Close database (checkpoint WAL)
   e. Disconnect channels
   f. Stop watchdog
   g. Log shutdown event to audit log
3. Exit with appropriate code
4. Timeout (10s default) triggers force-exit
```

## File Layout

```
~/.maia/
├── maia.config.json          # Configuration
├── workspace/                # Agent workspace
│   ├── SOUL.md              # Identity: persona, tone, boundaries
│   ├── IDENTITY.md          # Identity: name, emoji, vibe
│   ├── USER.md              # About the human
│   ├── AGENTS.md            # Operating instructions
│   ├── TOOLS.md             # Tool notes
│   ├── MEMORY.md            # Curated long-term notes (Tier 2)
│   ├── BOOTSTRAP.md         # First-run ritual (deleted after)
│   ├── memory/              # Immutable daily logs (Tier 1)
│   │   └── YYYY-MM-DD.md
│   └── knowledge/           # Obsidian vault (Tier 4)
│       ├── people/
│       ├── projects/
│       └── topics/
├── data/
│   ├── memory.sqlite        # Vector DB (Tier 3)
│   ├── sessions/            # Session transcripts
│   ├── audit.log            # Security audit log
│   ├── scheduler.json       # Scheduled tasks
│   └── watchdog/            # Watchdog state
└── credentials/
    └── vault.enc            # Encrypted credential store
```

## Database Schema

The SQLite database (`memory.sqlite`) uses the following core tables:

```sql
-- Schema versioning
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Memory entries (Tier 3)
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('preference','fact','decision','entity','other')),
  importance REAL NOT NULL DEFAULT 0.7,
  embedding BLOB,
  source_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Full-text search index
CREATE VIRTUAL TABLE memories_fts USING fts5(text, content=memories, content_rowid=rowid);

-- Vector search (when sqlite-vec is available)
CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[{dims}]);
```
