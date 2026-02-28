# Agent System Architecture

## Agent behavior (AGENTS.md)

`AGENTS.md` is loaded from the agent's directory (`data/agents/<id>/AGENTS.md`) or project root and injected into the system prompt with explicit attribution (see System prompt order below). It describes how agents should function—context tools, workspace, safety, tools—and can be edited per agent. If the per-agent file is missing or empty, the system falls back to `AGENTS.md` at project root.

## Agent Identity

Each agent has a directory at `data/agents/<agent_id>/`. Identity files at the root are **SOUL.md** and **AGENTS.md** only. Memory and user facts live in **memory/** and **user/** as small files and are retrieved via **knowledge_search** with scope (self, user, global, or another agent id); they are not injected as blocks into the system prompt.

```
data/agents/agent_007/
├── AGENTS.md    # How this agent should function (fallback: project root AGENTS.md)
├── SOUL.md      # Who the agent is (included in system prompt with attribution)
├── workspace/   # Agent file work
├── memory/      # Small fact files (e.g. fact.md); retrieved via knowledge_search
└── user/        # Small fact files about the user; retrieved via knowledge_search
```

### SOUL.md

The agent's self-concept (name, personality, expertise). Included in the system prompt with attribution. Edited via the **terminal** from the agent directory.

### memory/ and user/

Persistent facts the agent deems important (user preferences, decisions, lessons learned) live as small files under `memory/` and `user/`. Agents retrieve them via **knowledge_search** with the appropriate scope. Results include **last_modified**; files older than the archive duration are excluded unless **include_archived: true**. Agents create and edit these files via the **terminal**.

## System prompt order

The system prompt is built in this order (in `buildSystemPrompt` and `transformContext`):

1. **Agent ID** — e.g. "You are agent \`<agent_id>\`".
2. **System date and time** — Current ISO/local datetime and timezone.
3. **AGENTS.md** — A line stating that the following instructions are from `data/agents/<agent_id>/AGENTS.md`, then the full AGENTS content.
4. **SOUL.md** — A line stating that the following is from `data/agents/<agent_id>/SOUL.md`, then the SOUL content.

There are no "Memory" or "User" blocks in the prompt; memory and user facts are in `memory/` and `user/` and are retrieved via **knowledge_search** when the agent needs them.

## Context pipeline

Context is built and passed to the LLM as follows:

1. **transformContext** — Combines (optionally empty) recent-thread and smart-context blocks with the system prompt into a single system string. By default, recent thread and smart context are not included; agents use **chat_read**, **chat_find**, and **smart_context** when they need prior context. Implemented in `src/lib/agent/context-query.ts` as `transformContext(recentThreadBlock, smartContextBlock, systemPromptContent)`.

2. **convertToLlm** — Maps that system string plus the user message (and optional initial tool result) to the `Message[]` format the AI provider expects.

Flow: `systemPromptContent` (agent ID → date/time → AGENTS with attribution → SOUL with attribution) → `transformContext` → `convertToLlm` → `Message[]` → LLM.

## Agent Execution Loop

```
Trigger (user message | heartbeat | agent message)
         │
         ▼
   Load agent definition (model, status)
         │
         ▼
   Validate model is whitelisted ──── NO ──► Error: agent blocked
         │
        YES
         │
         ▼
   Assemble context window:
   - Agent ID, system date/time
   - AGENTS.md (with attribution)
   - SOUL.md (with attribution)
   - Current message (original)
   - Minimal tool definitions (find_tool, chat_read, chat_find, terminal; Maia gets agent-management tools)
         │
         ▼
   Call AI provider
         │
         ▼
   Parse response
         │
    ┌────┴────┐
    │         │
  Text    Tool calls
    │         │
    │         ▼
    │    Execute tools (in sequence or parallel per AI decision)
    │         │
    │         ▼
    │    Append tool results to context
    │         │
    │         ▼
    │    Call AI again (agentic loop continues until no more tool calls)
    │         │
    └────┬────┘
         │
         ▼
   Final text response
         │
         ▼
   Run compression agent on new entries
         │
         ▼
   Store compressed + original in session
         │
         ▼
   Emit SSE event to UI
```

## Agent Communication

### Agent → User

An agent can post to the active user session at any time using `message_send({ to: "user", text: "..." })`. This:
1. Adds the agent to the session's `participants` array if not already present.
2. Appends the message as an `"agent"` role entry.
3. Emits an SSE event causing the UI to update.

### Agent → Agent

An agent uses `message_send({ to: targetAgentId, text: content })`. This:
1. Searches for an existing session where `participants` contains exactly `[senderAgentId, targetAgentId]`.
2. If found, appends to that session.
3. If not found, creates a new session in `data/history/agents/`.
4. The target agent is triggered to respond (either synchronously or at next heartbeat).

### User → Specific Agent

The user prefixes their message with `@agent_name`. The system:
1. Resolves `agent_name` to an `agent_id`.
2. Adds that agent to the active user session.
3. Routes the message to that agent's execution loop.
4. The agent responds within the user session.

## Heartbeat and per-agent cron

Every N minutes (configurable via `heartbeatIntervalMinutes`), a **heartbeat** runs that wakes **only Maia**. She receives:

- A prompt to **check the task board and the cron job list**, assign unassigned tasks, and ensure each active agent has a staggered cron job. She does not message agents—they run on their own cron schedule.
- The current task board (unassigned and in-progress tasks), cron jobs table, and agents list.

Maia does not wake other agents directly via the heartbeat. Instead, the system assigns **one cron job per active agent** (except Maia). Those jobs run at **staggered times** within the interval so agents do not overlap (e.g. at :05, :15, :25 for a 30-minute interval). When an agent’s cron fires, that agent is run with a reminder to review GOALS and assigned tasks, check MEMORY, and take action. The heartbeat thus coordinates via tasks and cron; agents run on their own schedule.

## Maia — The Orchestrator

Maia is the only agent that can:
- Create new agents
- Delete agents
- Schedule cron jobs
- Manage the cron job list

Maia's responsibility is to:
1. Understand the user's high-level goals.
2. Break them into discrete, assignable tasks.
3. Create specialized agents for those tasks.
4. Monitor the task board and cron jobs on each heartbeat; ensure each agent has a staggered cron run.
5. Synthesize agent outputs for the user.

Maia should NOT directly implement features or run commands when she can delegate. Her value is in coordination and synthesis.

## Model Assignment

Each agent has a model assigned at creation:
- `ollama/llama3.2` — local lightweight model
- `ollama/qwen2.5-coder` — local code-specialized model
- `openrouter/anthropic/claude-3.5-haiku` — cloud model

The system validates the model against `settings.whitelistedModels` before:
- Creating an agent
- Triggering an agent (heartbeat or message)

If the model is not whitelisted, the agent is silently skipped (not triggered) and a warning is logged.
