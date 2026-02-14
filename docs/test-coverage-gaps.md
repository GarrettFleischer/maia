# Test Coverage Gaps

Based on `bun run test:coverage`. Focus on **src/**; test files and helpers are excluded from priorities below.

**Last major update:** Added integration tests for agent tools, backup restore, memory search; unit tests for error-handler, CORS, auth branches, embeddings, chunker, note, watchdog health-checks, alerter; runtime tool-call test. Overall coverage is now **~97%** lines/funcs for `src/`.

---

## Remaining gaps (lower priority)

| File | Line % | What's missing |
|------|--------|----------------|
| **src/agent/tools/web-fetch.ts** | ~63 | `definition()` and execute catch block (105–110). |
| **src/agent/tools/memory-tools.ts** | ~89 | Some catch blocks and logger.debug paths (121–123, 227–229, 252–265, 296–298). |
| **src/agent/tools/registry.ts** | ~89 | Catch block when tool.execute() throws (131–136). |
| **src/app.ts** | ~75 | Provider registration, agent wiring, fallback, backup wiring (many branches). |
| **src/gateway/ws-handler.ts** | ~77 | Some message/connection branches. |
| **src/gateway/server.ts** | ~83 | Handle errors, getWSHandler. |
| **src/agent/runtime.ts** | ~91 | Compaction summary path, some tool-loop edges (165–167, 181, 183–188, 225–228). |

---

## Not covered: Files never run during tests

These files are **not imported** by any test, so they show 0% in coverage. Bun only reports files that are executed.

| Category | Files |
|----------|--------|
| **CLI / entry** | `src/index.ts` (main CLI; better suited for E2E or manual testing) |
| **Gateway** | `src/gateway/bun-server.ts` (Bun.serve, route registration) |
| **Channels** | `src/channels/base.ts`, `src/channels/cli.ts`, `src/channels/webchat.ts`, `src/channels/discord.ts`, `src/channels/telegram.ts`, `src/channels/index.ts` |
| **Watchdog** | `src/watchdog/daemon.ts`, `src/watchdog/monitor.ts`, `src/watchdog/shutdown.ts`, `src/watchdog/index.ts`, health-checks for credentials, workspace, channels, providers, permissions |
| **Agent** | `src/agent/tools/base.ts` (types only) |
| **Hooks** | `src/hooks/runner.ts`, `src/hooks/types.ts` |
| **Barrel** | Various `index.ts` |

Coverage for **embeddings**, **chunker**, **note**, and **config/database health-checks** was added; they are now exercised by tests.

---

## Optional next steps

1. **web_fetch** – Call `definition()` and test execute() when `http.fetch` throws to cover the catch block.
2. **registry** – Register a tool that throws in `execute()` to cover the catch path.
3. **app.ts** – Hard to unit-test in isolation; consider integration tests that start the app and hit routes.
4. **Channels / bun-server / index** – E2E or manual testing.

Run `bun run test:coverage` and use `coverage/lcov.info` in your editor (e.g. Coverage Gutters) to confirm covered lines.
