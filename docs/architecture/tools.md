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

All paths are validated against the volume root. Operations outside the volume throw `SecurityError`.

### `terminal` — Shell Execution

| Function | Args | Returns |
|----------|------|---------|
| `terminal_exec` | `command: string, cwd?: string` | `{ stdout, stderr, exitCode }` |

- Executes inside the Docker sandbox container.
- Default timeout: 30 seconds (configurable in settings).
- `cwd` defaults to `/workspace` if not provided.
- stdout and stderr are capped at 50KB each to prevent context flooding.

### `web_search` — Web Content

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

Results pass through `InjectionFilter` before returning. If redaction occurred, the result includes a warning field.

Provider: Configurable (e.g., SearXNG self-hosted, Brave Search API, DuckDuckGo scraping).

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
