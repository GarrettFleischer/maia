# Testing Strategy

## Guiding principle: test real code, not mocks

The overwhelming majority of each test exercises **real production code** against
real (in-memory) infrastructure. Module-level mocks (`jest.mock`, `bun.mock`) are
not used. Every domain module — history, tasks, settings, tools, agent runner,
security, knowledge — is imported and called directly.

Mocking is limited to the two things that genuinely cannot run in a unit-test
environment:

| What is faked                              | Why                                               | Fake class          |
| ------------------------------------------ | ------------------------------------------------- | ------------------- |
| Network I/O (LLM, embeddings, Brave, etc.) | No real server available                          | `FakeHttp`          |
| Filesystem I/O                             | No temp-dir cleanup needed; tests run in parallel | `FakeFs`            |
| Child-process execution                    | No Docker daemon in CI                            | `FakeProcessRunner` |
| SSE event bus                              | Capture emitted events for assertions             | `FakeEvents`        |

All four fakes implement the same interface as the real adapter (defined in
`src/lib/context.ts`), so production code paths are exercised unchanged — only the
I/O boundary differs.

---

## Test helpers

All helpers live in `src/__tests__/helpers/`.

### `makeTestDb()` — `helpers/db.ts`

Creates a fully-initialized, in-memory SQLite database via `bun:sqlite`.

```typescript
import { makeTestDb } from "@/__tests__/helpers/db";

const db = makeTestDb(); // real schema, WAL mode, FK enforcement, migrations applied
```

`initSchema` runs on every test database, so the schema is always up to date and
tests double as a migration smoke-test.

### `makeTestContext()` — `helpers/fakes.ts`

Wires the in-memory DB with the four fakes to produce a complete `AppContext`.
Any adapter can be overridden to inject a specific fake:

```typescript
const events = new FakeEvents();
const ctx = makeTestContext({ events }); // all other adapters are fresh fakes
```

### `FakeFs`

In-memory file-system with `.seed(path, content)` for pre-population and
`.snapshot()` to assert on final state.

### `FakeHttp`

Route-matching HTTP client. Register handlers with `.on(pattern, handler)` or
the convenience `.onJson(pattern, status, body)`:

```typescript
const http = new FakeHttp();
http.onJson("/api/embed", 200, { embeddings: [[0.1, 0.2]] });
const ctx = makeTestContext({ http });
```

Any unmatched URL throws, preventing accidental real network calls.

### `FakeEvents`

Captures all emitted `SystemSSEEvent` objects in `events.emitted`. Use in tests
that verify real-time side-effects (e.g. `tasks_changed`, `agent_update`).

### `FakeProcessRunner`

Configurable with `.setResult(result)` or `.onExec(handler)`. Records the last
command in `.lastExec` for assertion.

---

## Patterns

### Domain-level tests (preferred)

Call domain functions directly with `makeTestContext()`. No HTTP layer involved.

```typescript
import { createTask, listTasks } from "@/lib/tasks";

const ctx = makeTestContext();
createTask(ctx, { title: "Write docs" });
expect(listTasks(ctx, {}).length).toBe(1);
```

### API-route tests

Import the exported Next.js handler functions (GET, POST, PATCH, DELETE) directly
and call them with a `createNextRequest(url, init)` helper. `_setTestContext` in
`src/instrumentation.ts` swaps in the test context so the route uses in-memory
infrastructure.

```typescript
import { GET, POST } from "@/app/api/tasks/route";
import { createNextRequest } from "@/__tests__/helpers/next-request";

beforeEach(() => _setTestContext(makeTestContext()));

it("returns 201 on create", async () => {
  const res = await POST(
    createNextRequest("http://localhost/api/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "x" }),
    }),
  );
  expect(res.status).toBe(201);
});
```

### Agent runner tests

Supply a `ProviderFactory` function that returns a simple `AIProvider` with a
scripted `complete()` implementation. The runner, context builder, tool registry,
history, and event bus all run as real production code; only the LLM network call
is replaced.

```typescript
function makeSimpleProvider(response: Partial<AIResponse> = {}): AIProvider {
  return {
    async complete(_messages, _tools, onToken) {
      const content = response.content ?? "done";
      onToken(content);
      return { content, toolCalls: response.toolCalls ?? [], stopped: true };
    },
  };
}
```

### Filesystem tests

Use `FakeFs` and seed files before the call:

```typescript
const fs = new FakeFs();
fs.seed("/data/agents/maia/SOUL.md", "# Soul\nI am Maia.");
const ctx = makeTestContext({ fs });
// call the domain function that reads that file
```

---

## What NOT to fake

- **Domain modules** (history, tasks, settings, tools, knowledge, security, etc.) —
  call them directly.
- **`ctx.db`** — use `makeTestDb()` (real SQLite, in-memory).
- **Zod schemas** — validation is real; pass invalid data to test rejection paths.
- **Cron, queue, compression** — use real implementations with in-memory context.

---

## Running tests

```bash
bun test                           # all tests
bun test src/__tests__/lib/        # domain tests only
bun test src/__tests__/app/api/    # API route tests only
bun test --watch                   # interactive watch mode
```

Tests use Bun's built-in test runner (`bun:test`). No separate Jest or Vitest
configuration is needed.

---

## Adding new tests

1. Create the test file under `src/__tests__/` mirroring the production path.
2. Build the context with `makeTestContext()`.
3. Call the real domain function or API handler.
4. Assert on return values, `ctx.db` state, or `FakeEvents.emitted`.
5. Only reach for a new fake when a genuine I/O boundary exists that cannot run
   in-process.
