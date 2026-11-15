# Autonomous Manager

Garrett's product goal: Maia is a smart manager employee. Given a goal, it hires workers, keeps them moving, error-corrects, and only escalates to the CEO when something truly needs him.

## Audit (today)

| Path | Trigger | Waits on user? | Orchestrator can resolve? |
|------|---------|----------------|---------------------------|
| `LoopSignal::Nudge` | Same step 3× | No — injects note | Already autonomous |
| `LoopSignal::Handoff` | Nudges exhausted, handoffs &lt; 2 | No — fresh sibling task | Already autonomous |
| `LoopSignal::Pause` → `pause_stuck` | Handoffs exhausted | Yes → `WaitingForUser` / Needs you | **Yes** within retry budget: re-plan / different approach; else one CEO question |
| `fail_worker` | Worker `failure` tool | Yes → `Failed` / Needs you | **Yes** within budget: diagnose + retry; else escalate |
| Host `Stop` / `Stop all` | Owner UI | Yes → `Stopped` / Needs you | No (owner intent). Wake may offer resume; do not auto-retry |
| Worker `waiting` / `ask_owner` | Worker asks | Often bare Needs you | Route through orchestrator as one clear question; auto-answer only when classifiable as autonomous default |
| Router `AskUser` | Ambiguous route | Chat clarification | Keep — genuine preference / ambiguity |
| `Approval` wait | Security admit | Yes | No — credentials / irreversible / policy |
| `WaiverNeeded` | Criterion waiver | Yes | No — preference / irreversible |
| `UnknownExternalOutcome` | Tool unknown | Yes | Prefer inspect + new avenue; do not replay |
| `TranscriptBudget` | Log full | Yes | Compact / continue when possible |
| `Blocked` | External blocker | Yes | Retry later on wake; escalate if still blocked after budget |
| Quarantined brain episodes | Promotion lag | Settings / brain UI | Out of manager-loop scope this slice |
| Check-in `Handoff` | Goal review | Same as loop handoff | Already autonomous until Pause |

## Manager loop

```
goal sealed
  → hire / continue worker
  → supervise (check-in, loop nudge, handoff)
  → on Failed | stuck Pause | Blocked:
        classify blocker
        if Autonomous and retries < budget → retry / re-plan / replace worker
        else → escalate once via orchestrator question (never bare Needs you)
  → on wake heartbeat:
        fingerprint running/failed/waiting/goals
        if unchanged → silent (no model)
        else apply autonomous recoveries; optional model; message_user only when useful
  → record learning (what failed, what worked) on the goal plan
```

### Escalation rule

Only the orchestrator asks Garrett. The question names the goal, what was tried, and the specific decision needed (credentials, money, irreversible action, preference, or external). Workers never own the CEO conversation.

### Budgets (defaults)

| Knob | Default | Purpose |
|------|---------|---------|
| `autonomous_retry_budget` | 3 per goal | Cap auto recoveries before escalate |
| `wake_interval_secs` | 300 (5 min) | Heartbeat cadence; settings-configurable |
| `max_model_calls_per_wake` | 1 | Cost cap when something changed |
| Skip model when fingerprint unchanged | always | Do not burn money on idle wakes |

## Wake heartbeat

- Recurring timer in the daemon actor loop (`recv_timeout` when idle).
- Persisted beside the DB as `manager_wake.json` (interval, last wake, fingerprint, cost day counters, learned notes). Survives restart.
- Most wakes are silent. `message_user` is an explicit orchestrator tool; a wake does not imply a chat line.
- On wake: recover failed/stuck tasks under budget; escalate exhausted ones with one question; close out finished goals when criteria met.

## This run's slice

1. Honest leaves in `maia-core::manager` (classify, decide recovery, wake plan, CEO question text, wake tool outcomes).
2. Durable `autonomous_retries` on the task plan.
3. Orchestrator auto-recovery on worker failure and loop-stuck pause; escalate with a specific question.
4. Worker / waiting questions formatted as orchestrator CEO questions.
5. Wake schedule + `message_user` tool + silent-by-default wake; persist wake state; skip model when unchanged.
6. Rust tests for auto-recovery, budget escalation, question routing, silent wake, messaging wake, recover-on-wake.

## Later slices (roadmap)

1. Replace/hire workers with a different role or tool set after repeated same-class failures.
2. Auto-defaults for low-stakes preference questions (with audit + undo).
3. Blocked-task backoff schedule and external dependency probes.
4. Full settings UI for budgets + wake interval + mute wake messages.
5. Learning store → prompt memory for “do not retry X”.
6. Unknown-external-outcome safe continue without replay.
7. Goal close-out and CEO summary digests on a cadence.
8. Multi-goal priority / attention scheduling.
