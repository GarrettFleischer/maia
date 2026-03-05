# Runtime and Operations

This document describes how the Maia application runs in development and production: the Node.js/Bun process, in-process background workers (LLM queue and cron), the Docker sandbox for terminal execution, and how deployment and CI/CD are organized.

## Runtime topology

The application is a single **Next.js server process** (Node 20+ or Bun). All backend behavior—API routes, database access, queue processing, and cron scheduling—runs inside that process. There are no separate worker processes or containers for the app itself.

```mermaid
flowchart LR
  userBrowser["UserBrowser"]
  nextServer["NextServer(Node 20/Bun)"]
  appContext["AppContext(singleton)"]
  sqliteDb["SQLite_DB(data/maia.db)"]
  llmQueueWorker["LLMQueueWorker(in-process)"]
  cronScheduler["CronScheduler(node-cron)"]
  sandbox["DockerSandbox(maia-sandbox)"]
  externalAi["ExternalAIProviders"]

  userBrowser --> nextServer
  nextServer --> appContext
  appContext --> sqliteDb
  appContext --> llmQueueWorker
  appContext --> cronScheduler
  appContext --> sandbox
  appContext --> externalAi
```

- **NextServer**: Started via `bun dev` (development) or `bun run build` then `bun start` (production). Serves the App Router UI and all API routes under `src/app/api/**`.
- **AppContext**: Built once per process in `src/instrumentation-node.ts` when `registerNode()` runs (triggered by the first `ensureAppContext()` call from an API route). Holds `db`, `fs`, `http`, `events`, `processRunner`, and optional `sandboxContainerName`.
- **SQLite**: Single file at `data/maia.db` (path from `getDataDir()` in `src/lib/data-dir.ts`). WAL mode; no separate DB server.
- **LLMQueueWorker**: In-process priority queue in `src/lib/queue/llm-queue.ts`. One logical worker; jobs are processed by a timer and by `tickQueueProcessor()` on each `ensureAppContext()`.
- **CronScheduler**: In-process scheduler in `src/lib/cron/service.ts` using `node-cron`. Loads jobs from `cron_jobs` and runs them at the specified cron times.
- **DockerSandbox**: Optional. The `maia-sandbox` container from `docker-compose.yml` is used by the terminal tool when `SANDBOX_CONTAINER_NAME` is set; the Next.js process runs `docker exec` to run shell commands inside the sandbox.
- **ExternalAIProviders**: Ollama, OpenRouter, and (for web tools) Brave APIs. All accessed via the HTTP client in `AppContext`.

## MuninnDB (cognitive memory database)

Maia can use **[MuninnDB](https://muninndb.com/docs)** as its long‑term semantic memory store (instead of the built‑in SQLite vector tables). MuninnDB runs as a **separate service**, typically via Docker, and exposes:

- REST on `http://localhost:8475` (JSON API for reads/writes and `ACTIVATE`)
- Web UI on `http://localhost:8476` (admin dashboard)
- MCP on `http://localhost:8750/mcp` (for tools like Cursor/Claude)
- MBP, gRPC, and clustering ports (not used directly by Maia)

### Docker deployment (recommended for development)

Use a named volume for persistence:

```bash
docker volume create muninndb-data
```

Run MuninnDB with all standard ports exposed and data stored in the volume:

```bash
docker run -d \
  --name muninndb \
  -p 8474:8474 \
  -p 8475:8475 \
  -p 8476:8476 \
  -p 8477:8477 \
  -p 8750:8750 \
  -v muninndb-data:/data \
  ghcr.io/scrypster/muninndb:latest
```

You should then be able to:

- Open the **Web UI** at `http://localhost:8476` (admin `root` / `password` by default; change password after first login).
- Call the **REST API** at `http://localhost:8475`.
- Configure MCP clients (e.g. Cursor) to use `http://localhost:8750/mcp`.

### Embedding plugin (semantic search) — Ollama

Maia’s setup uses **Ollama only** for MuninnDB. Configure the embedder so MuninnDB can do semantic similarity in its ACTIVATE pipeline. Pull the embedding model in Ollama first (e.g. `ollama pull nomic-embed-text`), then set:

```bash
-e MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text
```

Run with Docker:

```bash
docker run -d \
  --name muninndb \
  -p 8474:8474 \
  -p 8475:8475 \
  -p 8476:8476 \
  -p 8477:8477 \
  -p 8750:8750 \
  -v muninndb-data:/data \
  -e MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text \
  ghcr.io/scrypster/muninndb:latest
```

If the MuninnDB container cannot reach `localhost:11434` (e.g. Ollama runs on the host), use the host’s IP or `host.docker.internal` (e.g. `ollama://host.docker.internal:11434/nomic-embed-text` on Docker Desktop).

### Enrich plugin (summaries and key points) — Ollama

The **Enrich plugin** lets MuninnDB auto‑generate `summary`, `key_points`, entities, and relationships for each engram using an LLM. With **Ollama only**, use a chat-capable model (e.g. `llama3.2` or `llama3.1`). No API key is required:

```bash
-e MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2
```

Pull the model first: `ollama pull llama3.2`. If MuninnDB runs in Docker and Ollama is on the host, use `host.docker.internal` as in the embedder section (e.g. `ollama://host.docker.internal:11434/llama3.2`).

**Full example — Ollama only (embed + enrich):**

```bash
docker run -d \
  --name muninndb \
  -p 8474:8474 \
  -p 8475:8475 \
  -p 8476:8476 \
  -p 8477:8477 \
  -p 8750:8750 \
  -v muninndb-data:/data \
  -e MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text \
  -e MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2 \
  ghcr.io/scrypster/muninndb:latest
```

Once enabled, enrichment runs in the background for both newly written and existing engrams; enriched fields appear in ACTIVATE/Read responses. No API keys are needed when using Ollama only.

### Sanity checks

After MuninnDB is running:

- **Health check**:

  ```bash
  curl -s http://localhost:8475/api/health
  ```

- **Write a test memory (engrams)**:

  ```bash
  curl -sX POST http://localhost:8475/api/engrams \
    -H "Content-Type: application/json" \
    -d '{
      "vault": "default",
      "concept": "auth architecture",
      "content": "Short-lived JWTs, refresh in HttpOnly cookies",
      "tags": ["auth", "security"]
    }'
  ```

- **Activate by context (cognitive retrieval)**:

  ```bash
  curl -sX POST http://localhost:8475/api/activate \
    -H "Content-Type: application/json" \
    -d '{
      "vault": "default",
      "context": ["login flow"],
      "max_results": 5
    }'
  ```

You should see the test engram in the `activations` list. After enrichment has run, ACTIVATE/Read responses for that engram will also include `summary` and `key_points`.

### How Maia connects to MuninnDB

Maia treats MuninnDB as an external dependency, accessed via an internal client module when the integration is wired.

- **Configuration**: The MuninnDB base URL is set in **Settings → AI Providers** as **MuninnDB URL** (stored in the `settings` table as `muninnUrl`). Same pattern as **Ollama Base URL**. When empty, MuninnDB is not used. Optional: an API key can be added later if MuninnDB REST auth is enabled.
- **Client**: When present, `src/lib/muninn/config.ts` (or equivalent) will read `getSettings(ctx).muninnUrl` and build a config; `src/lib/muninn/client.ts` will expose `writeEngram`, `activate`, and related functions to the domain layer.

- **Flow**: History append and knowledge index write engrams to Muninn (default vault); smart context and the knowledge tool call Muninn’s ACTIVATE API for retrieval. See [Backend and domain](backend-and-domain.md#muninndb-integration), [data-model](data-model.md#semantic-memory-muninndb-and-deprecated-vector-tables), and [context-window](context-window.md).

## Background processes (in-process)

### LLM queue

- **Module**: `src/lib/queue/llm-queue.ts`, `src/lib/queue/llm-queue-handlers.ts`.
- **Startup**: In `src/instrumentation-node.ts`, after building `AppContext`:
  - `registerLlmQueueHandlers()` registers handlers for tools such as `runAgent`, `indexHistoryEntry`, `refreshEmbeddings`, `extractSearchQueries`, etc.
  - `startQueueProcessor(1000)` starts a `setInterval` that processes the queue every 1 second.
  - `tickQueueProcessor()` is called once immediately so jobs can run even before the first interval.
- **Tick on request**: Each time an API route calls `ensureAppContext()`, the instrumentation layer calls `tickQueueProcessor()` so the queue advances even if the interval timer has not fired in that worker.
- **Concurrency**: One job at a time (single worker) to avoid rate limits and keep ordering predictable.
- **Snapshot API**: `GET /api/queue` returns a JSON snapshot of queued jobs (see `docs/api/endpoints.md`). Implemented in `src/app/api/queue/route.ts`; it calls `ensureAppContext()` then `getQueueSnapshot()`.

### Cron scheduler

- **Module**: `src/lib/cron/service.ts`.
- **Startup**: In `src/instrumentation-node.ts`, `startCronScheduler(ctx, runAgentFn)` is called after the queue is started. It:
  - Loads all rows from `cron_jobs`.
  - Registers each job with `node-cron` using the job’s `expression`.
  - For built-in heartbeat: when the `builtin-heartbeat` job fires, it calls `fireHeartbeat(ctx, runAgentFn)` from `src/lib/heartbeat.ts`.
  - For per-agent run jobs (`agent-run-<agent_id>`): when they fire, the scheduler gets or creates a session for that agent and enqueues a `runAgent` job (or runs the configured tool with stored args).
- **Heartbeat**: The heartbeat is an internal tool (not exposed to agents) that wakes **only Maia**. She is prompted to check the task board and cron list, assign tasks, and ensure each active agent has a staggered cron job. See `docs/architecture/agent-system.md`.
- **Manual trigger**: `POST /api/cron/heartbeat` triggers `fireHeartbeat` directly. Used by external cron (e.g. system cron) or for testing; the in-process scheduler also fires the built-in heartbeat job on its schedule.

## Sandbox container

Terminal execution runs inside a dedicated Docker container for isolation.

- **Definition**: `docker-compose.yml` at the project root.
- **Service**: `maia-sandbox`.
  - Image: `ubuntu:22.04`.
  - Command: `sleep infinity`.
  - `network_mode: none` — no network access from inside the container.
  - Volume: `maia-workspace` mounted at `/workspace` (read-write).
  - Capabilities: all dropped except `CHOWN` and `SETUID`; `no-new-privileges: true`.
- **Usage**: When `SANDBOX_CONTAINER_NAME` is set (e.g. to `maia-sandbox`), the terminal tool uses `AppContext.processRunner` to run `docker exec --workdir <cwd> <container> bash -c '<command>'`. The working directory and command are validated against the workspace root to prevent path traversal. See `docs/architecture/security.md` and `docs/architecture/tools.md`.
- **Start**: Run `docker compose up -d` (or `docker-compose up -d`) in the project directory to start the sandbox. The Next.js app does not start it automatically.

## Logging

Application logging uses a small **logging facade** in `src/lib/logger.ts` with levels `debug`, `info`, `warn`, `error` and optional structured fields (e.g. `agentId`, `sessionId`). Use it from the agent runner, queue, cron, and critical tools instead of raw `console` or ad hoc helpers so that log format and level are consistent. Optionally, a **request correlation id** (from a header or generated per request) can be passed through so logs for a single request can be grepped; this can be added to the facade or to `AppContext` when needed.

## Environment and configuration

- **Data directory**: Where `maia.db`, agents, knowledge, and tools live. Configurable via the UI (Settings) and/or code in `src/lib/data-dir.ts`; default is project `data/` (or similar as defined in the app).
- **Required / common env** (see `.env.example`):
  - `CREDENTIAL_MASTER_KEY`: 64-char hex for credential encryption.
  - `SANDBOX_CONTAINER_NAME`: Optional; set to `maia-sandbox` (or your container name) to use the Docker sandbox for terminal.
  - API keys (Brave, OpenRouter, etc.) can be set in `.env` or stored in the app Settings (credential vault).
- **Runtime guard**: Node-only initialization (DB, queue, cron) runs only when `process.env.NEXT_RUNTIME === "nodejs"` so these modules are not bundled for Edge.

## CI/CD

- **Workflows**: The repository may use `.github/workflows` for CI (build, lint, test, E2E). If present, inspect the workflow files for the exact steps.
- **Local quality gates** (from `package.json` and project conventions):
  - **Typecheck**: `bun run typecheck` or `bunx tsc --noEmit`.
  - **Lint**: `bun run lint`.
  - **Tests**: `bun test` (unit and integration tests under `src/__tests__/**`).
  - **E2E**: E2E tests (e.g. Playwright) under `e2e/`; run via the script defined in `package.json` (e.g. `bun run test:e2e`).
- **Build**: `bun run build` produces the Next.js production build; `bun start` runs the production server. The application does not ship a Dockerfile in the repo; deployment is typically via a platform (e.g. Vercel, Node host) or a separately maintained container image.

## Summary

| Concern           | Where it runs               | Key modules / config                                    |
| ----------------- | --------------------------- | ------------------------------------------------------- |
| HTTP / API        | Next.js server              | `src/app/api/**`                                        |
| DB                | Same process, SQLite file   | `src/lib/db.ts`, `AppContext`                           |
| LLM queue         | Same process, timer + tick  | `src/lib/queue/llm-queue.ts`, `instrumentation-node.ts` |
| Cron              | Same process, node-cron     | `src/lib/cron/service.ts`, `heartbeat.ts`               |
| Terminal commands | Docker container (optional) | `docker-compose.yml`, `processRunner`                   |
| External APIs     | Same process, HTTP client   | `AppContext.http`, `src/lib/ai/**`, tools               |

For request-level and data flow details, see [Backend and Domain](backend-and-domain.md), [Request Flows](request-flows.md), and [System Overview](system-overview.md).

## Performance considerations

- **Agent turn hot path:** Before building smart context, the runner runs `buildEmbeddings(ctx)` so knowledge files and unindexed history are embedded and retrieval sees current data. The runner then loads only the last N history entries for the recent-thread block via `getSessionRecent(ctx, sessionId)` (see `src/lib/history.ts`) instead of loading the full session, so long threads do not pull entire history into memory. Smart context and skills are fetched in parallel (`Promise.all([buildSmartContextBlock(...), getMatchedSkillsContent(...)])`) to reduce time-to-first-token.
- **Queue:** A single worker processes one job at a time (by design for rate limits and ordering). Queue depth is the natural backpressure; long-running jobs (e.g. `runAgent`) block others. Embedding jobs have higher priority so indexing can keep up.
- **I/O cost:** The main I/O costs are embedding and vector search (smart context, history indexing) and LLM calls. Embedding failures degrade to empty context and are logged; they do not fail the request.
