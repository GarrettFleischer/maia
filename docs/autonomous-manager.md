# Autonomous Manager

Maia is a smart manager employee. Given a goal, it hires workers, keeps them moving, and only escalates to the CEO when something truly needs him. Strategy lives in the **orchestrator system prompt + tools**, not in hard-coded recovery rules.

## Prompt + tools

The router system prompt (`ROUTE_CONTROL_CONTRACT` in `crates/maia-daemon/src/orchestrator.rs`) describes the role: own the goal end to end, check workers on every wake, diagnose failures, retry or re-plan, replace or hire workers, make low-stakes calls, close finished goals, and use `ask_user` only for real CEO decisions (credentials, money, irreversible/external actions, preferences) as one clear question. Use `message_user` only when something is genuinely useful.

### Tools

| Tool | Role |
|------|------|
| `spawn_task` | Hire a worker for new work |
| `continue_task` | Send new instructions to an open worker |
| `link_task` | Follow-up after a finished worker |
| `inspect_task` | Status without changing anything |
| `retry_task` | Restart a failed/stopped worker |
| `cancel_task` | Stop a worker for good |
| `message_user` | Optional CEO update (wakes stay silent by default) |
| `ask_user` | One clear CEO decision question |
| `success` / `failure` / `waiting` | End the owner turn |

Workers never talk to the CEO. Their failures and questions park for the manager; the manager decides via tools.

## Code backstop (only)

| Knob | Default | Purpose |
|------|---------|---------|
| `autonomous_retries` per goal | cap `3` | After this many automatic restarts, recover tools are forced to `ask_user` |
| `wake_interval_secs` | 300 | Heartbeat cadence (Settings) |
| `max_model_calls_per_wake` | 1 | Cost cap when something changed |
| Skip model when fingerprint unchanged | always | Do not burn money on idle wakes |

No failure classifiers, fixed recovery strategies, or state-machine “retry vs escalate” rules beyond that budget.

## Wake heartbeat

- Idle daemon actor polls and runs `run_manager_wake`.
- Persisted as `manager_wake.json` beside the DB (interval, last wake, fingerprint, cost day counters).
- Unchanged fingerprint → silent, no model call.
- Changed failed/stuck/waiting work → one model tool turn; `message_user` / `ask_user` only when the model chooses.

## Roadmap (prompt-first)

1. Richer wake brief (recent worker output/errors) still as prompt context, not classifiers.
2. Settings for restart budget and mute wake messages.
3. Learning notes in the wake sidecar fed back into the prompt.
4. Multi-goal attention scheduling via prompt + inspect tools.
5. Goal close-out digests via `message_user` on a cadence.
