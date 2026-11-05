# Agents and unattended execution

## TDD preamble

- **Kind:** new feature
- **Invariant:** only one scheduler lease may advance a thread at a time, and every
  state transition, router call, tool attempt, budget charge, and reversal is
  durably attributable to that thread.
- **Red test(s):** scheduler transition-table tests; two-waker serialization;
  shared-thread byte identity after restart; budget exhaustion before a call;
  panic during router and tool work; append-only audit hash verification;
  presentation reversal without history deletion.
- **Then:** implement the pure transition and budget leaves first, followed by the
  single-writer scheduler skin and durable adapters.

## Honesty preamble

- **Leaves (honest):** `reduce_thread`, `admit_step`, `charge_usage`,
  `next_runnable`, `reverse_presentations`, and `verify_audit_chain`; all state,
  limits, time, and inputs arrive as parameters.
- **Skin (I/O):** the scheduler task reads the clock, owns timers, calls the
  router and tool host, and commits through the database task.
- **Hooks (backward):** user-message, scheduled-wake, posted-message, tool-open,
  resume, stop, and panic handlers parse requests and enqueue commands only.
- **Mode args:** `ThreadRun`, `WakeCause`, `StopScope`, `StepKind`, and
  `ReversalReason` are enums; no boolean selects behavior.
- **Pause-and-review:** after each new function, check that hidden time, database,
  network, or global cancellation state has not entered a leaf.

## Purpose and authority

This document is authoritative for agent identity, shared threads, scheduling,
run state, budget enforcement, panic, the immutable execution audit, and
presentation reversal. `03-thread-cache.md` owns prompt byte layout and
compaction. `04-credit.md` owns attribution weights. `07-computer.md` owns the
router and computer-tool transports.

The scheduler is orchestration, not memory. It advances durable thread logs and
calls injected ports. It cannot rewrite prompt slots, infer facts, or bypass the
tool policy.

## Thread and participant model

An agent is identified by an immutable `AgentId` and configured by its vault
folder. A thread has an immutable `ThreadId`, a non-empty sorted set of agent
participants, and a `ThreadKind`:

```rust
enum ThreadKind {
    Direct { agent: AgentId },
    AgentGroup { agents: Vec<AgentId> },
}

struct Thread {
    id: ThreadId,
    kind: ThreadKind,
    participants: Vec<AgentId>,
    run: ThreadRun,
    version: ThreadVersion,
    active_lease: Option<RunLease>,
}
```

The human is a speaker in a direct thread, not an `AgentId` and not a persona
slot. `participants` contains agents only, sorted by the canonical bytes of
`AgentId`. This resolves persona ordering without inventing a human agent.

Participants are fixed at thread creation. Adding or removing an agent creates
a new thread because changing personas at the front of an existing cache would
invalidate its durable prefix. An agent-agent thread has one `ThreadId`, one
ordered log, one cache, one state, and one budget ledger. Sidebar placement
under multiple agents is a view over that same identity.

**Authority for `AgentGroup`.** Standing and session grants that apply to the
thread are the intersection of each participant agent's grants
(`10-security.md`). A capability present for only one participant is absent for
the group. Session grants issued on the thread still attenuate from that
intersection and never widen past any participant's standing grant.

Every durable message carries:

```rust
struct ThreadMessage {
    id: MessageId,
    thread_id: ThreadId,
    speaker: Speaker,
    body: String,
    caused_by: CauseId,
    appended_at: Timestamp,
}

enum Speaker {
    Human,
    Agent(AgentId),
    System,
}
```

An agent may speak only if it is a participant. The final request line names
the current speaker using the stable speaker id. Cross-thread posting appends a
message to the destination thread with the source thread and source audit event
in `CauseId`; it never copies the source cache.

## Shared context

All participants in a thread observe the same durable slot list. There is no
private per-participant suffix. Persona slots appear in sorted `AgentId` order,
and attribution writes to the single thread ledger plus the shared brain.

The scheduler compiles from a committed thread version. Router output and tool
results are appended through the `ThreadLog` compare-and-append contract owned
by `08-rust.md`:

```rust
thread_log
    .append(thread_id, expected_version, &events)
    .await
    -> Result<ThreadVersion, ThreadLogError>
```

`ThreadLogError::VersionConflict` is never merged heuristically. The scheduler discards
the uncommitted compiled request, reloads, and decides whether a new step is
still admissible. A router response already received for a stale version is
audited as orphaned and is not appended as a conversational reply.

## Four-state model

The complete persisted state enum is:

```rust
enum ThreadRun {
    Running,
    Sleeping { reason: SleepReason },
    NeedsHuman { request: HumanRequest },
    Stopped { reason: StopReason },
}

enum SleepReason {
    ModelComplete,
    BudgetExhausted(BudgetKind),
    Interrupted,
    TranscriptBudget,
    SpendBreaker,
    DeferredRetry { until: Timestamp },
}
```

There is intentionally no fifth `Idle` state. Normal quiescence is
`Sleeping { reason: ModelComplete }`. `Sleeping` means safe and eligible for a
defined wake, except `TranscriptBudget` (needs a new thread) and `SpendBreaker`
(unattended wakes are refused until the breaker resets and the owner resets it).
`NeedsHuman` means blocked on a specific human action. `Stopped` means no
automatic wake is accepted.

### Accepted transitions

- `Sleeping -> Running`: a user message, participant message, due schedule,
  tool-open-thread event, or explicit resume is accepted and a run lease is
  granted. Unattended wakes are refused while the spend breaker is tripped, and
  `TranscriptBudget` accepts only "start a new thread" (not resume-in-place).
- `Running -> Sleeping`: the model returns no tool calls, a budget is exhausted,
  a retry deadline is deferred, the transcript alone exceeds its budget, the
  spend breaker trips, or the current work is otherwise complete.
- `Running -> NeedsHuman`: a tool returns a structured human request and no
  result with ambiguous side effects remains in flight.
- `NeedsHuman -> Running`: the exact human request is resolved (challenge
  cleared, approval granted, or store unlocked), then a new lease is granted.
- `NeedsHuman` stays `NeedsHuman` on a single deny. After the policy's number of
  denials in the current lease (`10-security.md` Approval tiers), the thread
  moves `NeedsHuman -> Stopped`. Cancel always moves `NeedsHuman -> Stopped`.
- `Running | Sleeping | NeedsHuman -> Stopped`: thread stop or global panic.
- `Stopped -> Sleeping`: explicit resume after any global panic latch is
  cleared. The resume itself does not call the router.

All other transitions are rejected and audited. Duplicate commands are
idempotent by `CommandId`.

### Pure reducer contract

```rust
fn reduce_thread(
    current: &ThreadState,
    event: &SchedulerEvent,
    policy: &SchedulerPolicy,
) -> Result<Transition, TransitionError>;
```

The reducer returns the next state and durable effects to request. It does not
read time, generate ids, call ports, or mutate storage.

## Wake queue and scheduler

There is one scheduler coordinator for the daemon. It owns the wake queue and a
registry of at most one run-loop task per active thread. Each thread is a
logical actor with one mailbox. Durable wake records are inserted before an API
acknowledges the wake, so restart cannot lose accepted work.

```rust
struct Wake {
    id: WakeId,
    thread_id: ThreadId,
    cause: WakeCause,
    not_before: Timestamp,
    accepted_at: Timestamp,
}

enum WakeCause {
    UserMessage(MessageId),
    ParticipantMessage(MessageId),
    Schedule(ScheduleOccurrenceId),
    ToolOpenedThread(AuditEventId),
    HumanResolved(HumanRequestId),
    ExplicitResume(UserActionId),
}
```

Selection is deterministic among eligible work: first `not_before`, then
`accepted_at`, then `WakeId`. At most one active lease exists per thread.
Daemon-wide concurrency is a configured positive integer; the default belongs
in configuration, not this design. Fairness is round-robin across threads after
each router or tool boundary, so a tool-heavy thread cannot monopolize all
slots.

The scheduler step is:

1. Transactionally claim an eligible wake and create a `RunLease`.
2. Load the committed thread snapshot and compile the request.
3. Reserve enough budget for the next router call.
4. Call the router with the stable `request_id`.
5. Append the readable reasoning, tool requests, reply, usage, trace, and
   attribution as one logical transaction.
6. For each accepted tool request, reserve a tool turn, execute through the
   tool host, and append the result before recompiling.
7. Yield after each external call. Continue only while the lease is valid,
   policy admits another step, and the model has not completed.

One model response containing multiple tool calls consumes one tool turn per
tool call. Calls execute in emitted order. Parallel tool execution is out of
scope because it makes side-effect ordering and panic semantics ambiguous.

On restart, leases are expired. A thread formerly `Running` is reconstructed
from its committed events and placed in `Sleeping { reason: Interrupted }`.
The scheduler does not replay an external call whose outcome is unknown.

## Budgets

A run lease has two hard ceilings:

```rust
struct RunBudget {
    max_router_tokens: u64,
    max_tool_turns: u32,
}

struct BudgetUsage {
    router_tokens: u64,
    tool_turns: u32,
    reserved_router_tokens: u64,
    reserved_tool_turns: u32,
}
```

Budgets are per run lease, not reset by agent-generated messages. A new user
message, due schedule occurrence, resolved human request, or explicit resume
may create a new lease. Messages posted by tools or agents while the thread is
already running join the current lease. This prevents agents from refreshing
their own limits by posting to themselves.

**Budget lineage.** A thread opened by `OpenThread`, or woken by `PostToThread`,
does not get a fresh budget. Its lease draws from the originating lease's
remaining budget, and the child ceiling is at most the parent's remainder. A
daemon-wide spend breaker (`10-security.md`) tracks three rolling meters:
router tokens, tool turns, and estimated spend. Tripping it moves every
unattended lease to `Sleeping { reason: SpendBreaker }` and refuses later
unattended wakes until the window resets and the owner resets the breaker at
`Confirm`.

Before a router call, Maia reserves the configured maximum output tokens plus
the exact compiled input-token estimate. If the provider tokenizer is
unavailable, the router adapter must supply a conservative estimator. A call is
not started when the reservation would exceed the ceiling. Actual provider
usage replaces the reservation; absent usage keeps the full reservation
charged and emits `UsageEstimated`.

Before each tool call, one tool turn is reserved. Completion, failure,
`NeedsHuman`, and ambiguous outcome all consume that turn. A rejected call that
never reaches a tool implementation does not consume a tool turn but is still
audited.

```rust
fn admit_step(
    usage: &BudgetUsage,
    request: &StepRequest,
    limits: &RunBudget,
    breaker: &SpendBreakerState,
) -> Result<Reservation, BudgetExceeded>;
```

`admit_step` fails while the breaker is tripped, even when the lease still has
local budget. When either lease ceiling is reached, no additional external call
begins. The state becomes `Sleeping { reason: BudgetExhausted(kind) }`, and
unused reservations are released only when the adapter proves the call did not
start.

## Panic and stopping

Global panic is a durable latch, not merely a cancellation token:

```rust
struct PanicState {
    generation: u64,
    engaged: bool,
    engaged_by: UserActionId,
    engaged_at: Timestamp,
}
```

The desktop and phone invoke the same authenticated `POST /api/panic`. Engaging
panic first closes an in-memory admission gate so no new step starts, then
writes the durable latch on a priority database-owner lane ahead of ordinary
commands. The API returns only after that durable write commits. Scheduler
admission stops immediately. Active router requests, console commands, and
browser/API operations receive cancellation. Every thread in `Running`,
`Sleeping`, or `NeedsHuman` transitions to `Stopped { reason: Panic(generation) }`.
Dream admission is cancelled the same way (`05-dream.md`).

Panic cannot promise rollback of an external side effect that already reached
another process or service. Such operations are recorded as completed,
cancelled-before-start, or outcome-unknown. Clearing panic requires a separate
authenticated action. Clearing does not resume threads; each thread requires an
explicit resume.

Thread stop uses the same cancellation path but affects one thread and does not
engage the global latch.

## Immutable audit

The audit is append-only and separate from the compactable prompt projection.
Every accepted command and every attempted external boundary writes an event:

```rust
struct AuditEvent {
    sequence: u64,
    id: AuditEventId,
    thread_id: Option<ThreadId>,
    actor: AuditActor,
    kind: AuditKind,
    cause: Option<AuditEventId>,
    request_id: Option<RequestId>,
    occurred_at: Timestamp,
    payload_hash: Hash,
    previous_hash: Hash,
    event_hash: Hash,
}
```

`event_hash` is the hash of canonical event bytes including `previous_hash`.
Large request and response bodies are stored in immutable blobs addressed by
`payload_hash`; secrets are redacted before blob creation according to the
tool's declared redaction schema. Redaction is deterministic and records which
fields were removed. Secret values never enter the audit.

After each committed batch, the database owner atomically writes a separate
signed checkpoint whose payload is
`{ sequence, event_hash, policy_version, time }` (`10-security.md`).
`event_hash` is the head of the hash chain at that sequence. If a crash leaves
the database ahead of the checkpoint, startup verifies the additional events
and advances the checkpoint. If the checkpoint is ahead of the database or
names a different `event_hash` at the same sequence, verification fails.

Checkpoints are signed with a daemon key held in the interactive user's
credential store, which sandbox SIDs cannot read. Each paired client also keeps
the latest signed checkpoint payload as a witness. A writer that can modify the
SQLite file but cannot sign cannot forge a checkpoint, and rolling back both
local stores is caught when a paired client's witness is newer. This still
claims no protection from an administrator who controls both the key and every
witness.

SQLite permissions and transactions provide local append-only enforcement; the
hash chain and checkpoint make ordinary modification, reorder, and truncation
detectable, not impossible against an administrator controlling the machine.
The daemon verifies the chain at startup and on request. A broken chain
disables unattended execution, leaves read-only inspection available, and
reports the first invalid sequence.

Required event kinds include wake accepted/claimed, transition, lease created
or expired, prompt compiled, router started/completed/failed, tool
accepted/started/completed/failed/outcome-unknown, budget reserved/charged,
human request opened/resolved, stop, panic engaged/cleared, and presentation
reversed.

The thread transcript may project audit events into collapsed tool lines, but
deleting or compacting a projection never deletes audit events.

## Presentation reversal

Reversal applies only to memory-credit effects caused by a thread. It is not an
undo mechanism for messages, shell commands, HTTP mutations, or browser
actions.

```rust
fn reverse_presentations(
    source: &[Presentation],
    already_reversed: &BTreeSet<PresentationId>,
    request: &ReversalRequest,
) -> Result<Vec<LedgerCompensation>, ReversalError>;
```

A reversal appends one compensation per selected presentation. The
compensation references the original `PresentationId`, negates exactly its
activation and co-use contribution, and carries a reason and initiating human
action. It never edits the original ledger row or episode. Repeating the same
`ReversalRequestId` is idempotent; attempting to reverse an already compensated
presentation is a no-op recorded in the audit.

Derived activation and edge weights are folds over original entries plus
compensations. Because each original may be compensated once, the fold exactly
cancels its contribution; a negative aggregate is treated as ledger
corruption. Reversal of a thread defaults to a closed, explicit range of audit
sequences so concurrent future work is not accidentally included.

## Ports and ownership

The scheduler uses the exact `ThreadLog`, `BrainStore`, `Router`, and `Tools`
ports defined in `08-rust.md`; this document does not add wider variants.
Cancellation is owned by the daemon's run-task registry and tool supervisor,
not added to those domain ports. The database owner accepts typed commands for
audit append, checkpoint, verification, and ledger compensation in the same
transaction domain as the affected records.

The composition root owns concrete ports and supervisors. Scheduler policy
depends on a port only where both a production adapter and deterministic fake
are required. Pure leaves do not receive traits.

## Invariants

1. One `ThreadId` has at most one active scheduler lease.
2. An agent-agent thread has exactly one log, cache, state, and budget ledger.
3. Participants and their persona order never change after thread creation.
4. No router or tool call begins without a durable audit start event and budget
   reservation.
5. No automatic wake advances a `Stopped` thread or any thread while panic is
   engaged.
6. A tool result is appended before that result can influence another router
   request.
7. Budget exhaustion prevents the next external call; it does not interrupt a
   committed append.
8. Restart never silently retries an external operation with unknown outcome.
9. Audit events and presentation ledger entries are never updated or deleted.
10. Reversal changes derived memory credit only and preserves source history.

## Failure modes

- **Duplicate wake:** deduplicate by `WakeId` or occurrence id; one audit event
  records the duplicate.
- **Concurrent wake:** the existing lease receives the message; no second loop
  starts.
- **Database unavailable:** do not call router or tools; release in-memory work
  and retry the durable wake with bounded backoff.
- **Append conflict:** mark any completed external response orphaned, reload,
  and never present it as committed output.
- **Router timeout before response:** charge the reservation, record timeout,
  and sleep with retry metadata. Retry requires a new request id and policy
  admission.
- **Tool outcome unknown:** record it and do not auto-retry or browser-fallback
  (see the precise rule below).
- **Scheduler crash:** expire leases on restart and move interrupted threads to
  sleeping; no unknown external call is replayed.
- **Audit verification failure:** enter `InspectOnly`. No new router or tool
  calls, and clearing the panic latch is blocked until a `DesktopConfirm`
  acknowledgment. Engaging panic stays allowed from every authenticated channel
  and is appended as far as the chain still accepts appends. Read-only
  diagnostics remain.
- **Tool outcome unknown (precise rule):** an unknown write moves the thread to
  `NeedsHuman { kind: AmbiguousExternalOutcome }`. An unknown read follows its
  contract's retry rule. The reducer makes no harm judgment.
- **Invalid model speaker:** reject the response before append and record a
  protocol failure.
- **Panic cancellation unsupported:** stop admitting work, mark the in-flight
  operation outcome unknown until its adapter resolves, and keep the thread
  stopped.

## Observability

Structured logs use `thread_id`, `lease_id`, `request_id`, `tool_call_id`,
`audit_sequence`, and `panic_generation`; they exclude prompt and tool bodies.
Metrics:

- eligible wakes, wake age, active leases, and scheduler step latency;
- state transitions by cause and current thread count by state;
- router tokens reserved, actual, and estimated by thread and lease;
- tool turns by tool, result class, and unattended status;
- budget exhaustion by kind;
- panic engagement latency and cancellation outcomes;
- audit append latency, verification result, and chain head sequence;
- presentation reversals and compensated weight;
- orphaned router responses and unknown external outcomes.

Each run has a trace rooted at `lease_id`. Router and tool spans link to the
immutable audit sequence but do not duplicate sensitive payloads.

## Required tests

### Pure unit tests

- every allowed and rejected state transition;
- deterministic wake ordering and round-robin selection;
- budget admission at one below, exactly at, and one above each ceiling;
- missing router usage retains the conservative reservation;
- multiple tool calls consume multiple tool turns;
- presentation compensation is exact, bounded, and idempotent;
- audit canonicalization and chain verification detect edit, reorder, and
  truncation.

### Store and scheduler integration tests

- two simultaneous wakes produce one lease and one ordered log;
- an agent-agent thread appears under each participant but advances once;
- restart compiles the same shared prefix and expires a running lease;
- a posted agent message cannot reset the active lease budget;
- panic blocks new admission before the HTTP response and leaves all threads
  stopped after restart;
- append conflict never commits a stale router response;
- tool result commits before the next prompt is compiled;
- audit and thread projection agree on request and tool ids.

### Fault-injection tests

- database failure at each boundary before and after an external call;
- process termination during router call, tool call, and append;
- cancellation accepted, rejected, and unsupported by each port;
- corrupt audit blob and hash chain;
- repeated commands and delayed responses after lease expiry.

## Resolved source ambiguities

- The four-state plan has no `Idle`; normal idle is represented as
  `Sleeping { reason: ModelComplete }`.
- Persona order says agent-id order while a direct thread includes the human.
  The human is a speaker, not an agent persona; only agent participants are
  sorted into persona slots.
- The plan does not define when budgets reset. Budgets belong to one run lease,
  and agent/tool messages cannot create a fresh lease for their own loop.
- “Panic stops every loop” means durable admission stops and cancellation is
  requested; it cannot retroactively undo an external side effect.
- “Presentation reversal” reverses memory-credit ledger effects only. Tool
  effects and immutable history are never reversed.
- “Immutable audit” means append-only application behavior plus detectable
  chaining and checkpointing. It does not claim tamper resistance against a
  Windows administrator who can roll back every local store.

## Explicitly out of scope

- dynamic participant changes within an existing thread;
- parallel tool calls within one model response;
- distributed scheduling across multiple desktop daemons;
- cryptographic protection from a local machine administrator;
- deletion or rewriting of audit history;
- automatic rollback of real-world tool side effects;
- budget purchasing or billing (budget lineage and the global breaker are in scope);
- model-driven scheduling policy or model-driven panic clearing;
- dreams, retrieval ranking, prompt compaction, and credit-weight formulas,
  which are specified in their respective design documents.

## Consistency links

- [10-security.md](10-security.md) — capability grants and approvals for tool
  steps, budget lineage and the global spend breaker, signed audit checkpoints
  and witnesses, panic priority, and incident response.
