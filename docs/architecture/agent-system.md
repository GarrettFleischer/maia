# Agent System Architecture

## Agent behavior (AGENTS.md)

`AGENTS.md` is loaded from the agent's directory (`data/agents/<id>/AGENTS.md`) and injected into every agent’s system prompt (after the security notice, before identity usage guidance). It describes how agents should function—session behavior, memory, safety, heartbeats, tools—and can be edited per agent without code changes. If the per-agent file is missing or empty, the system falls back to `AGENTS.md` at project root; if that is also missing or empty, no "How you function" section is added.

## Agent Identity

Each agent is defined by a directory at `data/agents/<agent_id>/` containing Markdown files. These form the agent's persistent identity and are included in every context window.

```
data/agents/agent_007/
├── AGENTS.md    # How this agent should function (fallback: project root AGENTS.md)
├── SOUL.md      # Who the agent is
├── MEMORY.md    # What the agent remembers
├── GOALS.md     # What the agent is working toward
└── USER.md      # What the agent knows about the user(s)
```

### SOUL.md

The agent's self-concept. Encouraged content:
- Name and preferred pronouns
- Personality, communication style, quirks
- Areas of expertise or interest
- How the agent prefers to approach problems

The agent should feel free to express creativity here. This is their identity, not a job description.

### MEMORY.md

Persistent knowledge the agent deems important. Examples:
- User preferences learned through interaction
- Architectural decisions made in the workspace
- Important file paths or project structures
- Lessons learned from failed approaches
- Relationships with other agents

Agents should proactively add to this file using the `file_write` tool after learning something significant.

### GOALS.md

Uses a checklist format. Goals are NEVER deleted — completed ones are checked off.

```markdown
## Long-term Goals
- [x] Set up Python project structure
- [ ] Implement data pipeline
- [ ] Write comprehensive tests

## Current Tasks
- [ ] Fix the failing test in data_processor.py
- [ ] Review agent_012's PR for the API module
```

Agents should check off completed items and add new tasks as they emerge.

### USER.md

Everything the agent knows about the user(s) it works with:
- Communication preferences
- Technical skill level
- Project context
- Important personal details the user has shared
- Working hours or availability (if known)

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
   - Security preamble
   - Identity files (SOUL, MEMORY, GOALS, USER)
   - Compressed session history
   - Current message (original)
   - Tool definitions
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

An agent can post to the active user session at any time using `message_to_user()`. This:
1. Adds the agent to the session's `participants` array if not already present.
2. Appends the message as an `"agent"` role entry.
3. Emits an SSE event causing the UI to update.

### Agent → Agent

An agent uses `message_send(targetAgentId, content)`. This:
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

- A prompt to **check the task board and the cron job list**, assign unassigned tasks, ensure each active agent has a staggered cron job, and message agents as needed.
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
