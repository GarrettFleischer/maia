# Maia

Maia is an agentic system: a **Next.js** app where **Maia** (the orchestrator agent) coordinates sub-agents, threads (sessions), tasks, and tools. Users chat in threads; Maia can create agents, assign tasks, approve custom tools, run cron jobs, and manage threads. Agents discover tools via **find_tool** and skills via **find_skill** and use the same tool set (terminal, web search, knowledge, files, messaging, etc.) with identity and workspace isolation.

**Features:**

- **Multi-agent:** Maia plus any number of sub-agents; each has SOUL.md, AGENTS.md, workspace, memory, and user facts.
- **Threads:** User and agent-only sessions; conversation history and semantic search.
- **Shared task board:** Kanban-style tasks (todo / in_progress / done) with assignment and notes.
- **Rich tool set:** Context (chat_read, knowledge_search, smart_context), terminal, web (search, answer, research), browser automation (optional), files, credentials, messaging between agents, Yahoo Mail, cron.
- **Custom tools:** Add tools under `data/tools/<slug>/`; Maia reviews and approves them via **approve_tool**.
- **Embeddings & models:** Configurable models (see `defaults/models.json`); optional embeddings for semantic search.

---

## Tools

Agents receive only **find_tool** and **find_skill** by default; they discover other tools via find_tool and operational guidance (skills) via find_skill. The following built-in tools are available once discovered. Custom tools can be added under `data/tools/<slug>/` and approved by Maia; they then appear in find_tool results.

### Minimal set (always available)

| Tool         | Returns                                          | Args          | Example                                     |
| ------------ | ------------------------------------------------ | ------------- | ------------------------------------------- |
| `find_tool`  | `ToolDefinition[]`                               | `q`, `limit?` | `find_tool({ q: "search the web" })`        |
| `find_skill` | `FindSkillResult[]` (name, description, content) | `q`, `limit?` | `find_skill({ q: "how to save memories" })` |

### Context & discovery (discoverable via find_tool)

| Tool                      | Returns                        | Args                                             | Example                                                                               |
| ------------------------- | ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `chat_read`               | `string`                       | `rounds` (1-based indices), `include_reasoning?` | `chat_read({ rounds: [1, 2] })`                                                       |
| `chat_find`               | search result array            | `q`, `limit?`                                    | `chat_find({ q: "what did we decide about the API?" })`                               |
| `knowledge_search`        | doc array (with last_modified) | `q`, `limit?`, `scope?`, `include_archived?`     | `knowledge_search({ q: "deployment steps", scope: "self" })`                          |
| `history_semantic_search` | search result array            | `q`, `limit?`                                    | `history_semantic_search({ q: "API key" })`                                           |
| `history_find`            | entry array                    | `q`, `mode?`                                     | `history_find({ q: "deployment steps" })`                                             |
| `history_search_all`      | entry array                    | `q`, `tags?`, `mode?`                            | `history_search_all({ q: "API key" })`                                                |
| `history_get_session`     | session object or `null`       | `id`, `mode?`, `indexes?`, `start?`, `end?`      | `history_get_session({ id: "s1", start: 0, end: 4 })`                                 |
| `smart_context`           | `{ block, queries, sources? }` | `ctx`, `cmd`                                     | `smart_context({ ctx: "user asked about deployment", cmd: "find past discussions" })` |

### Terminal & pipeline

| Tool            | Returns                                                          | Args                                               | Example                                             |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `terminal_exec` | `{ stdout, stderr, exitCode }`                                   | `cmd`, `cwd?`                                      | `terminal_exec({ cmd: "ls -la" })`                  |
| `chain`         | last stage result or `{ error, callStack, failedTool, message }` | `expr` (pipeline; use `@prev` for previous result) | `chain({ expr: "terminal_exec({cmd:'cat x'}).stdout | knowledge_search({q:'@prev'})" })` |

### Web

| Tool             | Returns                                           | Args                                             | Example                                              |
| ---------------- | ------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `web_search`     | `SearchResult[]` (title, url, snippet, fetchedAt) | `q`, `max?`                                      | `web_search({ q: "latest Node release", max: 5 })`   |
| `web_answer`     | `{ answer, fetchedAt }`                           | `q`, `research?`                                 | `web_answer({ q: "What is Node LTS?" })`             |
| `web_research`   | `{ answer, fetchedAt }`                           | `q`, `enableCitations?`, `language?`, `country?` | `web_research({ q: "comprehensive question here" })` |
| `fetch_web_page` | `{ url, title, content, fetchedAt }`              | `url`, `maxContentLength?`                       | `fetch_web_page({ url: "https://example.com" })`     |

### Browser (optional)

When `BROWSER_TOOLS_ENABLED=1`:

| Tool                    | Returns                      | Args                                             | Example                                                 |
| ----------------------- | ---------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| `browser_navigate`      | `{ ok, url }`                | `url`                                            | `browser_navigate({ url: "https://example.com" })`      |
| `browser_snapshot`      | `{ snapshot }` (text + refs) | `interactiveOnly?`, `maxDepth?`                  | `browser_snapshot({})`                                  |
| `browser_click`         | `{ ok }`                     | `ref?`, `selector?`, `button?`, `modifiers?`     | `browser_click({ ref: "1" })`                           |
| `browser_type`          | `{ ok }`                     | `ref?`, `selector?`, `text`, `clear?`, `submit?` | `browser_type({ ref: "1", text: "hello" })`             |
| `browser_fill`          | `{ ok }`                     | `ref?`, `selector?`, `value`                     | `browser_fill({ ref: "1", value: "new value" })`        |
| `browser_select_option` | `{ ok }`                     | `ref?`, `selector?`, `values`                    | `browser_select_option({ ref: "1", values: ["opt1"] })` |
| `browser_go_back`       | `{ ok }`                     | —                                                | `browser_go_back({})`                                   |
| `browser_close`         | `{ ok }`                     | —                                                | `browser_close({})`                                     |

### Messaging

| Tool           | Returns  | Args                                | Example                                                                                                       |
| -------------- | -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `message_send` | `string` | `to` (`"user"` or agent ID), `text` | `message_send({ to: "user", text: "Done." })` or `message_send({ to: "agent-uuid", text: "Please review." })` |

### Credentials

| Tool                | Returns           | Args           | Example                                                      |
| ------------------- | ----------------- | -------------- | ------------------------------------------------------------ |
| `credential_create` | `void`            | `key`, `value` | `credential_create({ key: "API_KEY", value: "secret" })`     |
| `credential_update` | `void`            | `key`, `value` | `credential_update({ key: "API_KEY", value: "new-secret" })` |
| `credential_delete` | `void`            | `key`          | `credential_delete({ key: "API_KEY" })`                      |
| `credential_list`   | `string[]` (keys) | —              | `credential_list({})`                                        |

### Task tracker

| Tool          | Returns         | Args                                | Example                                            |
| ------------- | --------------- | ----------------------------------- | -------------------------------------------------- |
| `task_create` | `Task`          | `title`, `desc?`, `assign?`         | `task_create({ title: "Review PR" })`              |
| `task_update` | `Task`          | `id`, `status?`, `note?`, `assign?` | `task_update({ id: "id", status: "in_progress" })` |
| `task_list`   | `Task[]`        | `status?`, `assign?`, `created?`    | `task_list({ status: "todo" })`                    |
| `task_get`    | `Task` or error | `id`                                | `task_get({ id: "id" })`                           |

### File (workspace / knowledge / tools)

| Tool               | Returns                 | Args              | Example                                                        |
| ------------------ | ----------------------- | ----------------- | -------------------------------------------------------------- |
| `file_read`        | `string`                | `path`            | `file_read({ path: "workspace/notes.md" })`                    |
| `file_write`       | `void`                  | `path`, `content` | `file_write({ path: "workspace/notes.md", content: "Hello" })` |
| `file_append`      | `void`                  | `path`, `content` | `file_append({ path: "workspace/log.txt", content: "line" })`  |
| `file_delete`      | `void`                  | `path`            | `file_delete({ path: "workspace/old.md" })`                    |
| `file_list`        | `{ path, type }[]`      | —                 | `file_list({})`                                                |
| `file_move`        | `void`                  | `from`, `to`      | `file_move({ from: "a.md", to: "b.md" })`                      |
| `file_exists`      | `boolean`               | `path`            | `file_exists({ path: "workspace/x.md" })`                      |
| `directory_create` | `string` (created path) | `path`            | `directory_create({ path: "workspace/docs" })`                 |

Paths: relative to workspace; `knowledge/...` → shared knowledge base; `tools/...` → custom tools dir.

### Yahoo Mail

Requires credentials: `YAHOO_EMAIL`, `YAHOO_APP_PASSWORD`.

| Tool                 | Returns                                         | Args                                                     | Example                                               |
| -------------------- | ----------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| `email_list_folders` | folder list                                     | —                                                        | `email_list_folders({})`                              |
| `email_list`         | `{ folder, total, offset, returned, emails[] }` | `folder?`, `limit?`, `offset?`, `unreadOnly?`            | `email_list({ folder: "INBOX", limit: 10 })`          |
| `email_read`         | `{ uid, subject, from, body, ... }`             | `uid`, `folder?`                                         | `email_read({ uid: 42, folder: "INBOX" })`            |
| `email_search`       | search result array                             | `query`, `folder?`, `limit?`, `unreadOnly?`              | `email_search({ query: "invoice", folder: "INBOX" })` |
| `email_move`         | `void`                                          | `uid`, `toFolder`, `fromFolder?`                         | `email_move({ uid: 42, toFolder: "Trash" })`          |
| `email_mark`         | `void`                                          | `uid`, `mark` (read/unread/starred/unstarred), `folder?` | `email_mark({ uid: 42, mark: "read" })`               |
| `email_delete`       | `void`                                          | `uid`, `folder?`                                         | `email_delete({ uid: 42, folder: "INBOX" })`          |

### Date / time

| Tool              | Returns                    | Args | Example               |
| ----------------- | -------------------------- | ---- | --------------------- |
| `system_datetime` | `{ iso, local, timezone }` | —    | `system_datetime({})` |
| `system_date`     | `{ date, iso }`            | —    | `system_date({})`     |

### Maia-only tools

Available only to the Maia orchestrator agent:

| Tool                | Returns                 | Args                               | Example                                                                            |
| ------------------- | ----------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `agent_create`      | `string` (new agent id) | `name`, `model`, `soul?`, `extra?` | `agent_create({ name: "Helper", model: "openrouter/free" })`                       |
| `agent_delete`      | `void`                  | `id`                               | `agent_delete({ id: "agent-uuid" })`                                               |
| `agent_list`        | agent list              | —                                  | `agent_list({})`                                                                   |
| `agent_get`         | agent object or `null`  | `id`                               | `agent_get({ id: "agent-uuid" })`                                                  |
| `cron_echo`         | `string` (echoed msg)   | `msg`                              | `cron_echo({ msg: "ping" })`                                                       |
| `cron_schedule`     | `string` (job id)       | `expr`, `tool`, `args`, `desc?`    | `cron_schedule({ expr: "0 9 * * 1", tool: "cron_echo", args: {}, desc: "Daily" })` |
| `cron_list`         | `CronJob[]`             | —                                  | `cron_list({})`                                                                    |
| `cron_delete`       | `void`                  | `id`                               | `cron_delete({ id: "job-uuid" })`                                                  |
| `approve_tool`      | `{ approved: slug }`    | `slug`                             | `approve_tool({ slug: "my-tool" })`                                                |
| `tool_deregister`   | `void`                  | `slug`                             | `tool_deregister({ slug: "my-tool" })`                                             |
| `thread_list`       | session meta array      | `type?`                            | `thread_list({})` or `thread_list({ type: "user" })`                               |
| `thread_create`     | `string` (session id)   | `participants?`, `type?`           | `thread_create({ type: "user" })`                                                  |
| `thread_update`     | `void`                  | `id`, `name?`, `desc?`, `tags?`    | `thread_update({ id: "s1", name: "Project X" })`                                   |
| `thread_delete`     | `boolean`               | `id`                               | `thread_delete({ id: "s1" })`                                                      |
| `thread_get_active` | `string \| null`        | —                                  | `thread_get_active({})`                                                            |
| `thread_set_active` | `void`                  | `id`                               | `thread_set_active({ id: "s1" })`                                                  |

---

## Getting Started

**Prerequisites:** Node 20+ (or Bun). For embeddings and some tools: Ollama or another provider; Brave Search / Brave Answers API keys (optional); Yahoo Mail credentials in the vault if using email tools.

1. **Install dependencies**

   ```bash
   bun install
   ```

2. **Environment**

   Copy `.env.example` to `.env` and set at least:
   - `CREDENTIAL_MASTER_KEY` — 64-char hex (e.g. `openssl rand -hex 32`) for encrypting credentials.
   - `SANDBOX_CONTAINER_NAME` — only if using the Docker sandbox for terminal runs (e.g. `maia-sandbox`).

   API keys (Brave Search, Brave Answers, etc.) can be set in `.env` or later in the app **Settings**; the UI stores them in the credential vault.

3. **Run the app**

   ```bash
   bun dev
   ```

   Open [http://localhost:3000](http://localhost:3000). You’ll see the main chat view: choose or create a thread and talk to Maia. Use **Agents**, **Tasks**, **Cron**, and **Settings** from the UI as needed.

## Main UI

- **Home** — Chat with Maia (or the active agent) in the current thread; switch or create threads from the sidebar.
- **Agents** — List, create, and manage sub-agents (Maia-only).
- **Tasks** — Shared kanban board (all agents).
- **Cron** — List and manage scheduled jobs (Maia-only).
- **Settings** — API keys, model whitelist, credential vault, and other app settings.

## Development

- **Typecheck:** `bun run typecheck` (or `bunx tsc --noEmit`)
- **Tests:** `bun test`
- **Lint:** `bun run lint`
- **Build:** `bun run build` then `bun start` for production

Data (SQLite, agents, knowledge, tools) lives under the project data directory; the path is configurable in **Settings** in the UI.
