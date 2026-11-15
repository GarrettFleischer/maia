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
| `record_learning` | Save one short lesson for later wakes (sidecar → LEARNED) |
| `success` / `failure` / `waiting` | End the owner turn |

Workers never talk to the CEO. Their failures and questions park for the manager; the manager decides via tools.

## Code backstop (only)

| Knob | Default | Purpose |
|------|---------|---------|
| `autonomous_retries` per goal | cap `3` | After this many automatic restarts, recover tools are forced to `ask_user` |
| CEO moment safety cap | always | If the wake model skips a waiting `ask_user` or finished close-out, host posts that one message unless `RECENT_CEO_CHAT` already covers it |
| `wake_interval_secs` | 300 | Heartbeat cadence (Settings) |
| `max_model_calls_per_wake` | 1 | Cost cap when something changed |
| Skip model when fingerprint unchanged | always | Do not burn money on idle wakes |

No failure classifiers, fixed recovery strategies, or state-machine “retry vs escalate” rules beyond that budget.

## Wake heartbeat

- Daemon actor polls and runs `run_manager_wake` even while background workers are busy (only an in-flight owner route defers the check). Long runners must not starve hire / recover / ask / close-out.
- A worker entering failed / waiting / completed sets a one-shot wake nudge so the next check may run without waiting for the full interval (still throttled by the 1s disk-check gap).
- Persisted as `manager_wake.json` beside the DB (interval, last wake, fingerprint, cost day counters).
- Unchanged fingerprint → silent, no model call.
- Changed failed/stuck/waiting/completed work → one model tool turn; `message_user` / `ask_user` only when the model chooses.
- When the model is called, the wake user message is a compact brief: counts; `LEARNED` notes from the wake sidecar; `ATTENTION` (ordered concurrent goals: failed → waiting → close-out, leave healthy runners alone); plain `CEO_WAITING` (question + mandatory `ask_user`); `FINISHED` goals with `outcome=` (mandatory `message_user` close-out that restates the outcome when failed/waiting/stuck are clear — healthy runners do not block close-out; one close-out marks one finished goal); `RECENT_CEO_CHAT` for dedup; plus per open worker status, idle age, recent output, and last error. Default is silence; mandatory sections override it. `inspect_task` returns the same worker shape. Fingerprint ignores brief detail, CEO chat lines, and learned notes. On a wake the model may emit several manager tools when ATTENTION lists multiple goals.
- A CEO reply while exactly one worker is waiting remaps a mistaken `spawn_task` onto that worker **without** storing the spawn guidance (so hire text cannot push the worker to call `waiting` again).
- Wake `ask_user` / `message_user` bind to the **selected** bot (not a stale turn bot).
- Wake system prompt lists open task ids as usable candidates (the contract forbids inventing ids).
- A worker that stops answering is marked `Failed` with summary `Worker stopped answering.` (plus a short router reason when known) so wakes can see it (not left as orphaned `Running`).
- Unreadable model replies nudge a couple of times instead of immediately failing silent.
- If the wake model call fails, or returns no tools / the wrong tool while failed/waiting/completed work still needs attention, the fingerprint is **not** advanced so the next wake can retry.
- Wake snapshots are scoped to the selected bot so deleted bots cannot poison the fingerprint.
- JSON completions tolerate gateway quirks: null/missing `message` and tool_calls on the choice.
- Worker success is not relayed raw into CEO chat; the manager posts one short `message_user` close-out on wake, then marks completed views closed.
- A CEO reply while exactly one worker is `waiting_for_user` continues that worker (even if the model tried to spawn).
- Unknown tool names are not a schema abort: the host returns a normal tool error so the manager can recover with `spawn_task` (or another route tool). Wake offers only tools it applies (`spawn_task`, `continue_task`, `retry_task`, `cancel_task`, `message_user`, `ask_user`, `record_learning`) — no worker stubs, no owner-turn terminals.
- Wake `spawn_task` hires without binding into the CEO transcript; bot transcripts require an explicit `message_bots` bind (unbound rows no longer default to Maia).
- Force-Wake / Settings edits reload fingerprint and `last_wake_at` from disk each tick.
- Background and wake failures do not post into CEO chat unless the manager calls `message_user` or `ask_user`.

## Roadmap (prompt-first)

1. ~~Richer wake brief (recent worker output/errors) as prompt context~~ (done).
2. Settings for restart budget and mute wake messages.
3. ~~Learning notes in the wake sidecar fed back into the prompt~~ (done — `record_learning` + `LEARNED` brief).
4. ~~Multi-goal attention scheduling via prompt + inspect tools~~ (done — `ATTENTION` brief + multi-tool wake).
5. ~~Goal close-out digests via `message_user`~~ (done — wake `message_user`, raw success relay removed).
6. ~~Owner/wake models reaching for worker tools~~ (done — manager-only tools + recoverable unknown-tool errors).
7. ~~CEO ask_user + finished close-out dependable on wake~~ (done — plain brief sections + CEO-moment safety cap + selected-bot bind).
8. ~~Concurrent-worker reliability~~ (done — wakes while busy; close-out not blocked by healthy runners; prompt for hire/cancel-by-idle).
9. ~~Richer completed-worker summary + finish reliability~~ (done — `outcome=` FINISHED lines; one close-out per finished goal; wake nudge on fail/wait/complete; no spawn-guidance poison on sole-waiting remap).
10. **General refinement** — settings knobs; real bugs / reliability; autonomy polish.
