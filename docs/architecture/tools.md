# Tool Architecture

## Tool Interface

All tools implement a common interface that enables dependency injection and testability:

```typescript
interface Tool<TArgs extends ZodTypeAny, TResult> {
  name: string;
  description: string;          // shown to the LLM in the tool list
  schema: TArgs;                // Zod schema for argument validation
  execute(
    args: z.infer<TArgs>,
    context: ToolContext
  ): Promise<TResult>;
}

interface ToolContext {
  agentId: string;
  sessionId: string;
  db: DatabaseClient;           // injectable — use in-memory DB in tests
  fs: FileSystemClient;         // injectable — use mock FS in tests
  credentialVault: CredentialVault;
  injectionFilter: InjectionFilter;
  dockerClient: DockerClient;   // injectable — use mock in tests
  httpClient: HttpClient;       // injectable — use mock in tests
  volumeRoot: string;           // path to agent's sandbox root
}
```

## Tool Registry

Tools are registered in a central registry. Maia-only tools are marked with `maiaOnly: true`.

```typescript
const TOOL_REGISTRY: ToolRegistration[] = [
  { tool: fileCrudTool,        maiaOnly: false },
  { tool: terminalTool,        maiaOnly: false },
  { tool: webSearchTool,       maiaOnly: false },
  { tool: messagingTool,       maiaOnly: false },
  { tool: historyTool,         maiaOnly: false },
  { tool: credentialsTool,     maiaOnly: false },
  { tool: agentManagementTool, maiaOnly: true  },
  { tool: cronTool,            maiaOnly: true  },
];

function getToolsForAgent(agentId: string): Tool[] {
  return TOOL_REGISTRY
    .filter(reg => !reg.maiaOnly || agentId === 'maia')
    .map(reg => reg.tool);
}
```

## Tool Definitions (LLM-facing)

Each tool's schema is converted to a JSON Schema for the AI provider:

```typescript
// Example: file_read
{
  name: "file_read",
  description: "Read the contents of a file within the workspace volume.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to the workspace root (e.g., 'workspace/project/main.py')"
      }
    },
    required: ["path"]
  }
}
```

## Individual Tool Specifications

### `file_crud` — File Operations

| Function | Args | Returns | Notes |
|----------|------|---------|-------|
| `file_read` | `path: string` | `string` | File contents |
| `file_write` | `path: string, content: string` | `void` | Creates or overwrites |
| `file_append` | `path: string, content: string` | `void` | Appends to file |
| `file_delete` | `path: string` | `void` | Deletes file or empty dir |
| `file_list` | `directory: string` | `string[]` | List files in directory |
| `file_move` | `from: string, to: string` | `void` | Move/rename |
| `file_exists` | `path: string` | `boolean` | Check existence |

Paths are resolved against the volume root. In addition, paths starting with `knowledge/` (e.g. `knowledge/reports/summary.md`) resolve to the shared knowledge base at `data/knowledge/`, so agents can read and write reports there with the same file tools. Operations outside the volume or knowledge base throw.

### `terminal` — Shell Execution

| Function | Args | Returns |
|----------|------|---------|
| `terminal_exec` | `command: string, cwd?: string` | `{ stdout, stderr, exitCode }` |

- Executes inside the Docker sandbox container.
- Default timeout: 30 seconds (configurable in settings).
- `cwd` defaults to `/workspace` if not provided.
- stdout and stderr are capped at 50KB each to prevent context flooding.

### `web_search` — Brave Web Search

| Function | Args | Returns |
|----------|------|---------|
| `web_search` | `query: string, maxResults?: number` | `SearchResult[]` |

```typescript
interface SearchResult {
  title: string;
  url: string;
  snippet: string;    // injection-filtered
  fetchedAt: string;
}
```

- **Brave only**: Uses Brave Search API. Requires `BRAVE_SEARCH_API_KEY` (no fallback).
- Results pass through `InjectionFilter`. If redaction occurred, the result includes a warning field.

### `brave_answers` — Brave Answers (AI-Grounded Answers)

| Function | Args | Returns |
|----------|------|---------|
| `brave_answers` | `question: string, enableResearch?: boolean` | `{ answer: string, fetchedAt: string }` |

- AI-generated answers backed by real-time web search (Brave Answers API, OpenAI-compatible chat/completions).
- Same API key as `web_search`. Use for questions that need current, cited information.
- `enableResearch: true` enables multi-search research mode (thorough but slower and higher cost).

### `fetch_web_page` — Page Content via Real Browser

| Function | Args | Returns |
|----------|------|---------|
| `fetch_web_page` | `url: string, maxContentLength?: number` | `WebPageContent` |

```typescript
interface WebPageContent {
  url: string;
  title: string;
  content: string;   // main text, injection-filtered
  fetchedAt: string;
  injectionWarning?: string;
}
```

- Opens the URL in a **one-off** Playwright browser (no shared session). Uses Chromium or Brave if `BRAVE_EXECUTABLE_PATH` is set.
- Waits for DOM/content, extracts title and main body text, runs content through `filterText` with source `fetch_web_page:<url>`.
- Optional `maxContentLength` truncates content to avoid context overflow.
- Improves resilience to bot protections (real browser, JS execution). Timeout ~30s; navigation errors surface as thrown errors.

### Browser automation suite — Session-scoped Brave

One browser **page per session** (keyed by `sessionId`). Use for multi-step agent-mode tasks (navigate, snapshot, click, type, fill forms). **`web_search`** returns links; **`brave_answers`** returns AI-generated answers grounded in web search.

| Function | Args | Returns |
|----------|------|---------|
| `browser_navigate` | `url: string` | `{ ok, url }` |
| `browser_snapshot` | `interactiveOnly?: boolean, maxDepth?: number` | `{ snapshot: string }` |
| `browser_click` | `ref?: string, selector?: string, button?, modifiers?` | `{ ok }` |
| `browser_type` | `ref?, selector?, text: string, clear?, submit?` | `{ ok }` |
| `browser_fill` | `ref?, selector?, value: string` | `{ ok }` |
| `browser_select_option` | `ref?, selector?, values: string[]` | `{ ok }` |
| `browser_go_back` | _(none)_ | `{ ok }` |
| `browser_close` | _(none)_ | `{ ok }` |

- **Refs**: `browser_snapshot` injects `data-maia-ref` on interactive elements and returns a text list (e.g. `[1] button "Submit"`). Use `ref: "1"` in click/type/fill/select. Alternatively pass a CSS `selector` (e.g. `#id`, `.class`).
- **Browser**: Brave via Playwright when `BRAVE_EXECUTABLE_PATH` (or OS default) is set; otherwise Chromium. Optional env `BROWSER_TOOLS_ENABLED=1` can gate the suite (documented in README/env).

### `credentials` — Credential Vault (LLM-facing)

| Function | Args | Returns | LLM Access |
|----------|------|---------|------------|
| `credential_create` | `key: string, value: string` | `void` | Yes |
| `credential_update` | `key: string, value: string` | `void` | Yes |
| `credential_delete` | `key: string` | `void` | Yes |
| `credential_list` | _(none)_ | `string[]` (keys only) | Yes |
| `credential_get` | `key: string` | `string` (value) | **NO** — internal only |

### `messaging` — Inter-agent and User Communication

| Function | Args | Returns |
|----------|------|---------|
| `message_send` | `toAgentId: string, content: string` | `void` |
| `message_to_user` | `content: string` | `void` |

`message_send` behavior:
1. Find existing session where participants are exactly `[callerAgentId, toAgentId]`.
2. If not found, create new session in `data/history/agents/`.
3. Append message.
4. Queue target agent for response (either immediately or at next heartbeat).

`message_to_user` behavior:
1. Add caller agent to active user session participants (if not already).
2. Append message as `role: "agent"` entry.
3. Emit SSE event to UI.

### `history` — Session Management

Full API in [PLAN.md — History Tool API](../PLAN.md#history-tool-api).

### Knowledge base and semantic search

**Storage**: The knowledge base is markdown files under `data/knowledge/`. Agents use the **existing file tools** to read and write there: any path starting with `knowledge/` (e.g. `knowledge/reports/q4-summary.md`) is resolved to `data/knowledge/...`. Store human-readable reports and durable knowledge under `knowledge/` so they are discoverable via semantic search.

**Indexing**: The knowledge base is indexed once on startup and every 60 minutes (one embedding per file, no chunking). Session history is indexed on append (original and compressed entries). Both use the same embedding model (e.g. `nomic-embed-text` via Ollama) and a shared vector store.

| Function | Args | Returns |
|----------|------|---------|
| `knowledge_search` | `query: string, limit?: number` | `{ path, content, score }[]` |
| `history_semantic_search` | `query: string, limit?: number` | `{ sessionId, entryId, content, isCompressed, score }[]` |

- **`knowledge_search`**: Semantic search over the knowledge base. Returns the most relevant documents (full content). Use to find stored reports and durable knowledge.
- **`history_semantic_search`**: Semantic search over past session history. Returns the most relevant past messages or tool results. Use when you need to find something by meaning rather than keywords. Existing fuzzy search (`history_find`, `history_search_all`) remains available.

### `agent_management` — Agent Lifecycle (Maia only)

| Function | Args | Returns |
|----------|------|---------|
| `agent_create` | `AgentCreateConfig` | `string` (agent_id) |
| `agent_delete` | `agentId: string` | `void` |
| `agent_list` | _(none)_ | `AgentDefinition[]` |
| `agent_get` | `agentId: string` | `AgentDefinition` |

```typescript
interface AgentCreateConfig {
  name: string;
  model: string;                 // must be in whitelistedModels
  soul?: string;                 // initial SOUL.md content
  memory?: string;               // initial MEMORY.md content
  goals?: string;                // initial GOALS.md content
  user?: string;                 // initial USER.md content
  systemPromptExtra?: string;    // additional system instructions
}
```

On creation:
1. Validate model against whitelist.
2. Generate a unique `agent_id`.
3. Insert into `agents` DB table.
4. Create `data/agents/<agent_id>/` directory.
5. Write the four .md files with provided or default content.

### `cron` — Job Scheduling (Maia only)

| Function | Args | Returns |
|----------|------|---------|
| `cron_schedule` | `expression: string, taskDescription: string` | `string` (jobId) |
| `cron_list` | _(none)_ | `CronJob[]` |
| `cron_delete` | `jobId: string` | `void` |

Cron expressions follow standard 5-field format: `* * * * *` (minute, hour, day, month, weekday).

The heartbeat is a built-in cron job (`*/30 * * * *`) that cannot be deleted.

## Tool Execution in Agentic Loop

When an AI response contains tool calls:

1. Parse all tool calls from the response.
2. Validate each tool name against the registry for this agent.
3. Parse and validate arguments against the tool's Zod schema.
4. Execute tools (sequentially by default; parallel if AI explicitly requests it).
5. Collect results.
6. Append tool calls + results as entries to the session (original form).
7. Continue the AI loop with results in context.

### Environment (optional)

- **`BRAVE_SEARCH_API_KEY`** — **Required** for `web_search` and `brave_answers`. No fallback. Get a key at [Brave Search API](https://api.search.brave.com/).
- **`BRAVE_EXECUTABLE_PATH`** — Path to Brave browser for Playwright. When set, `fetch_web_page` and the browser automation suite use Brave; otherwise Chromium. OS defaults: Windows `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`, macOS `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`, Linux `/usr/bin/brave-browser` (or first existing of `brave`, `brave-browser-stable`).
- **`BROWSER_TOOLS_ENABLED`** — Browser automation suite is **off by default**. Set to `1` to register and enable `browser_navigate`, `browser_snapshot`, `browser_click`, etc., until Brave (or Chromium) is available.

### Tool Error Handling

Tool errors are returned to the AI as error results, not thrown:

```typescript
{
  tool_name: "file_read",
  error: "SecurityError: Path traversal attempt detected",
  success: false
}
```

This allows the AI to understand what went wrong and adjust its approach.
