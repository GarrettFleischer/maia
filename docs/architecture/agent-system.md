# Agent System Architecture

## Agent Identity

Each agent is defined by a directory at `data/agents/<agent_id>/` containing four Markdown files. These files form the agent's persistent identity and are included in every context window.

```
data/agents/agent_007/
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

## Heartbeat

Every 30 minutes, all `active` agents receive a heartbeat trigger:

```
[HEARTBEAT] Timestamp: 2025-01-15T14:30:00Z

Review your GOALS.md. Identify any tasks you can make progress on right now.
Check your MEMORY.md for relevant context.
If you need to collaborate with another agent, use the messaging tool.
Update your identity files with any new information.
Take meaningful action or report any blockers.
```

Agents may respond by making tool calls, sending messages, or simply confirming no action is needed.

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
4. Monitor agent progress via heartbeats.
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
