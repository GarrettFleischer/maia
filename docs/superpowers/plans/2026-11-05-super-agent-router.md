## TDD preamble

- **Kind:** new feature
- **Invariant:** one tool-free router chat semantically routes each unchanged user prompt into a durable isolated task session, while host-enforced lifecycle, security, context provenance, and completion evidence remain authoritative.
- **Red test(s):** name the exact first contract/integration/E2E test files for every task.
- **Then:** minimal production changes in dependency order to make each red test green.

## Honesty preamble

- **Leaves (honest):** list exact intended signatures for pure routing, envelope sealing, phase reduction, completion admission, child narrowing, sidebar placement, and control authorization.
- **Skin (I/O):** daemon model calls, environment, memory/store, process/tools, API/websocket, and browser/Tauri integration.
- **Hooks (backward):** Axum/Tauri/React handlers are glue only.
- **Mode args:** enums/unions only, no mystery booleans.
- **Pause-and-review:** after each function, check complete signature, hidden I/O, typed modes, one abstraction level, and test coverage.

Leaf signatures, copied into `crates/maia-core/src/super_agent/` and re-exported from `maia_core::super_agent`:

```rust
pub fn authorize_control(
    proposal: &RouteProposal,
    source: &TurnSource,
    phases: &BTreeMap<TaskId, TaskPhase>,
) -> AdmittedRoute;

pub fn admit_route(
    proposal: &RouteProposal,
    policy: &RoutingPolicy,
    source: &TurnSource,
    phases: &BTreeMap<TaskId, TaskPhase>,
) -> AdmittedRoute;

pub fn seal_envelope(
    draft: &EnvelopeDraft,
    user_message: &UserPromptBytes,
    rules: &BTreeMap<RuleId, BindingText>,
    decisions: &BTreeMap<DecisionId, BindingText>,
) -> Result<TaskEnvelope, SealError>;

pub fn reduce_phase(
    current: &TaskPhase,
    event: &PhaseEvent,
) -> Result<TaskPhase, PhaseError>;

pub fn admit_completion(
    criteria: &[Criterion],
    marks: &[CriterionMark],
    evidence: &BTreeSet<EvidenceId>,
) -> Result<EvidenceSetId, CompletionError>;

pub fn narrow_child(
    parent_envelope: &TaskEnvelope,
    assignment: &ChildAssignmentDraft,
    parent_grants: &BTreeSet<GrantKey>,
    parent_budget: BudgetCeiling,
    depth: u32,
    policy: &ChildPolicy,
) -> Result<ChildAssignment, NarrowError>;

pub fn place_sidebar(
    phase: &TaskPhase,
    pin: PinMark,
    view: &CompletionView,
) -> SidebarSection;

pub fn execution_tools(role: &SessionRole, profile: SecurityProfile) -> BTreeSet<ExecutionTool>;

pub fn recall_query_text(
    prompt: &UserPromptBytes,
    brief: &AdvisoryBrief,
) -> Result<String, SealError>;

pub fn advisory_items(ranked: &[RankedMemory]) -> Vec<ContextItem>;
```

`SecurityProfile` is the existing enum in `crates/maia-core/src/security/profile.rs`. `rank_paths` stays in `crates/maia-core/src/brain/rank.rs`. Leaves do not call it.

# Super Agent Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one tool-free router chat that admits each user prompt into one isolated parent task, relays structured reports, and shows Needs you, Working, Completed, Pinned, and Archive without deleting history.

**Architecture:** Pure leaves in `maia-core` admit routes, seal envelopes, reduce phases, gate completion, narrow children, and place sidebar rows. `maia-store` migration v3 persists those records beside the existing thread tables. `maia-daemon` is the only reader of `BASE_URL` and `API_KEY`, reuses `RouterHttp`, and serves the HTTP and websocket catalog. The React shell renders host state and never receives secrets or execution tools.

**Tech Stack:** Rust 1.90, edition 2024, `maia-core` / `maia-store` / `maia-router` / `maia-daemon`, rusqlite, existing `RouterHttp`, Axum 0.8.4 on the daemon only, React 19, Vitest, Playwright.

## Global Constraints

- Accepted spec: `docs/design/14-super-agent-router.md`. It wins over conflicting orchestration and UI text in `00`, `01`, `06`, `07`, and `09`.
- Composition-root policy, passed as arguments, never embedded in a leaf: `min_confidence` 800, `min_margin` 150, `max_considered` 8, `ChildPolicy.max_depth` 3. `Confidence` is `u16` thousandths in `0..=1000`.
- `SessionRole::Router` has an empty execution-tool set before and after security-profile branching, including `SecurityProfile::Unrestricted`.
- Original prompt bytes are sealed once and never rewritten by continuation, retry, inspection, snapshot refresh, or relay.
- One user message admits at most one parent task. Child ids are not route targets.
- `Failed` retries inside the same `TaskId` with a new `AttemptId`. `Continue` on `Failed` appends input and does not start an attempt.
- Unknown external call ids are not replayed. The phase is `WaitingForUser { reason: UnknownExternalOutcome }`.
- Archive, pin, and detail close do not delete envelope, transcript, artifact, audit, or brain rows.
- `BASE_URL` and `API_KEY` are loaded from the root `.env` only by the daemon composition-root environment skin in `crates/maia-daemon/src/env.rs`. They never appear in frontend code, Vite env, logs, prompts, SQLite, `Debug`, errors, or tests. Tests inject a fake key string built in the test, not a value read from `.env`.
- Agents and tests do not open or print `.env`; only the running daemon loads it through `dotenvy`. Do not hard-code a vendor model id. Discover ids from `GET {base}/models`.
- Real Windows LPAC is not linked yet. Linux and macOS containment runtimes are plan-only. Candle real inference stays deferred. Tonight's Protected demo uses a scripted tool host and does not spawn an arbitrary unattended process. If containment is not ready, tool execution fails closed to `WaitingForUser`.
- Existing `threads` and `thread_events` rows stay. Migration v3 adds `legacy_threads` markers. It does not delete or rewrite event bodies.
- No git commit in any task. Each task ends at a review checkpoint.
- `cargo` commands run from `f:\Development\maia`. Frontend commands run from `f:\Development\maia\frontend`.

## Scope check

This is one user-facing product slice with a hard dependency order: leaves, then store and shell, then daemon, then end-to-end proof. Splitting into separate plans would leave no runnable router tonight. One master plan, four waves.

## File structure

| Path | Responsibility | Wave owner |
| --- | --- | --- |
| `crates/maia-core/src/super_agent/types.rs` | Enums and newtypes | Wave 1 only |
| `crates/maia-core/src/super_agent/route.rs` | `authorize_control`, `admit_route` | Wave 1 only |
| `crates/maia-core/src/super_agent/envelope.rs` | `seal_envelope`, `recall_query_text` | Wave 1 only |
| `crates/maia-core/src/super_agent/phase.rs` | `reduce_phase` | Wave 1 only |
| `crates/maia-core/src/super_agent/completion.rs` | `admit_completion` | Wave 1 only |
| `crates/maia-core/src/super_agent/child.rs` | `narrow_child`, `execution_tools` | Wave 1 only |
| `crates/maia-core/src/super_agent/sidebar.rs` | `place_sidebar` | Wave 1 only |
| `crates/maia-core/src/super_agent/memory.rs` | `advisory_items` | Wave 1 only |
| `crates/maia-core/src/super_agent/mod.rs` | Re-exports | Wave 1 only |
| `crates/maia-core/src/lib.rs` | `pub mod super_agent;` | Wave 1 only |
| `crates/maia-core/tests/super_agent_*.rs` | Contract tests | Wave 1 only |
| `crates/maia-store/src/sql.rs` | `MIGRATION_V3` | Wave 2 store only |
| `crates/maia-store/src/migrate.rs` | Version 3 | Wave 2 store only |
| `crates/maia-store/src/super_agent_ops.rs` | Round-trip ops | Wave 2 store only |
| `crates/maia-store/tests/super_agent_store.rs` | Store tests | Wave 2 store only |
| `crates/maia-store/tests/sqlite_owner.rs` | Update version assertions only | Wave 2 store only |
| `frontend/src/api/superAgentTypes.ts` | DTO unions | Wave 2 UI only |
| `frontend/src/api/fixtureSuperAgent.ts` | Fixture client | Wave 2 UI only |
| `frontend/src/components/shell/TaskRail.tsx` | Sidebar sections and tree | Wave 2 UI only |
| `frontend/src/components/shell/TaskDetail.tsx` | Read-only detail | Wave 2 UI only |
| `frontend/src/components/shell/RouterConversation.tsx` | Composer and relay | Wave 2 UI only |
| `frontend/src/components/shell/AgentRail.tsx` | Delegate to `TaskRail` | Wave 2 UI only |
| `frontend/src/components/shell/ConversationPane.tsx` | Router transcript | Wave 2 UI only |
| `frontend/src/hooks/useSuperAgent.ts` | Client prop, no secrets | Wave 2 UI, then Wave 3 edits the prop site in `App.tsx` only |
| `frontend/src/App.tsx` | Pass client | Wave 2 fixture, Wave 3 switches to live after Wave 2 review |
| `crates/maia-daemon/src/env.rs` | `BASE_URL`, `API_KEY` | Wave 3 only |
| `crates/maia-daemon/src/discovery.rs` | `/models` selection | Wave 3 only |
| `crates/maia-daemon/src/orchestrator.rs` | Host loop | Wave 3 only |
| `crates/maia-daemon/src/http.rs` | Axum routes and websocket | Wave 3 only |
| `crates/maia-daemon/src/main.rs` | Binary composition root | Wave 3 only |
| `crates/maia-router/src/client.rs` | Add `models_url` beside `chat_completions_url` | Wave 3 only |
| `frontend/src/api/liveSuperAgent.ts` | Authenticated fetch | Wave 3 only |
| `crates/maia-daemon/tests/super_agent_http.rs` | Daemon integration | Wave 4 only |
| `frontend/e2e/super-agent.spec.ts` | Pin and archive | Wave 4 only |

Do not start a later wave until the review checkpoint of the previous wave is recorded in the task checklist. Wave 2 store and Wave 2 UI may run at the same time. They share no files.

## Frozen API catalog

Daemon bind: `127.0.0.1:4178`. This is the UI API origin. It is not `BASE_URL`.

| Method | Path | Body result |
| --- | --- | --- |
| `GET` | `/api/super-agent/sidebar` | `{ rows: SidebarRow[] }` |
| `GET` | `/api/super-agent/transcript` | `{ messages: RouterMessage[] }` |
| `POST` | `/api/super-agent/messages` | `{ admitted: "admit" \| "ask" \| "refuse" }` |
| `GET` | `/api/super-agent/tasks/:taskId` | `TaskDetail` read-only |
| `POST` | `/api/super-agent/tasks/:taskId/pin` | `{ pin: "pinned" \| "unpinned" }` |
| `POST` | `/api/super-agent/tasks/:taskId/detail` | `{ view: "open" \| "closed_once" }` |
| `POST` | `/api/super-agent/tasks/:taskId/reference` | `{ composer_insert: string }` |
| `POST` | `/api/super-agent/host-command` | `{ phase: TaskPhaseName }` |
| `GET` | `/api/super-agent/ws` | websocket text frames of `SidebarRow` JSON |

`SidebarRow` fields: `task_id`, `title`, `section`, `phase`, `summary`, `elapsed_ms`, `criteria_done`, `criteria_total`, `children`. `children` is the same shape without further nesting in the fixture; the daemon may nest grandchildren up to depth 3. A child never appears in `rows` except inside `children`.

---

### Task 1: Super Agent types

**Files:**
- Create: `crates/maia-core/src/super_agent/mod.rs`
- Create: `crates/maia-core/src/super_agent/types.rs`
- Modify: `crates/maia-core/src/lib.rs`
- Test: `crates/maia-core/tests/super_agent_types.rs`

**Interfaces:**
- Consumes: nothing
- Produces: every enum and newtype named in the honesty preamble, plus `EnvelopeDraft`, `PhaseEvent`, `ChildAssignmentDraft`, `RankedMemory`, `SealError`, `PhaseError`, `CompletionError`, `NarrowError`

- [ ] **Step 1: Write the failing test**

```rust
use maia_core::super_agent::{Confidence, ConfidenceError};

#[test]
fn confidence_rejects_values_above_one_thousand() {
    let error = Confidence::from_thousandths(1001).expect_err("1001");
    assert_eq!(error, ConfidenceError::OutOfRange);
}

#[test]
fn confidence_accepts_boundaries() {
    assert_eq!(Confidence::from_thousandths(0).unwrap().thousandths(), 0);
    assert_eq!(Confidence::from_thousandths(1000).unwrap().thousandths(), 1000);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-core --test super_agent_types -- --nocapture`

Expected: FAIL with `cannot find module super_agent` or `no super_agent in the root`.

- [ ] **Step 3: Write minimal implementation**

Add `pub mod super_agent;` to `crates/maia-core/src/lib.rs`.

`mod.rs` declares `mod types;` and `pub use types::*;`.

`Confidence` is a tuple struct around `u16`. `from_thousandths` returns `Err(ConfidenceError::OutOfRange)` when `value > 1000`.

Define the remaining enums from `docs/design/14-super-agent-router.md` data contracts: `SessionRole`, `TurnSource`, `RouteTarget` (`Parent(TaskId)` or `Child(ChildId)`), parent-only `RouteDecision`, `TaskLink`, `RouteProposal`, `RoutingPolicy`, `AdmittedRoute`, `RouteRefuse`, `TaskPhase`, `WaitReason`, `FailureKind`, `HostCommand`, `PhaseEvent`, `ReportKind`, `CriterionSource`, `Criterion`, `CriterionMark`, `PinMark`, `CompletionView`, `SidebarSection`, `ExecutionTool`, and `AdvisoryStanding` with the single variant `Advisory`. Task 2 adds the untrusted `ProposedRouteDecision` and `ProposalShape` boundary before route admission. Reuse `crate::agents::{CommandId, HumanRequestId, ThreadId}` and `crate::brain::{ClaimId, EpisodeId, FactId}` instead of duplicate super-agent newtypes; episode provenance cites `agents::ThreadId` as the scheduler thread owner. `RouteDecision::Continue`, `Cancel`, `Retry`, and `Inspect` carry a parent `TaskId`. `HostCommand` follows the accepted spec: `Stop { task }`, bare `StopAll`, and `Abandon { task }`; cancellation bookkeeping supplies the resulting `CommandId`. Super-agent string newtypes wrap `String` except reused agent/brain ids, `Confidence`, and `BudgetCeiling { router_tokens: u64, tool_turns: u32 }`; `ChildAssignmentDraft.ceiling` is `GrantCeiling`. `UserPromptBytes { message: MessageId, utf8: Vec<u8> }` and other byte-bearing types use secret-safe `Debug` (ids and `byte_len` only). `ExecutionTool` variants are exactly `Shell`, `Filesystem`, `Browser`, `Network`, `Vault`, `OpenThread`, `PostToThread`.

Every public type gets a one-line doc comment. No `bool` field selects a mode.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-core --test super_agent_types -- --nocapture`

Expected: PASS, 6 tests.

- [ ] **Step 5: Honesty pause**

`from_thousandths` takes the number as a parameter and returns a `Result`. It does not read env, clock, or store.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. Diff is limited to the three paths above plus the test. `Confidence` has no `Debug` output of secrets because it stores only a `u16`.

### Task 2: Route admission

**Files:**
- Create: `crates/maia-core/src/super_agent/route.rs`
- Modify: `crates/maia-core/src/super_agent/mod.rs`
- Test: `crates/maia-core/tests/super_agent_route.rs`

**Interfaces:**
- Consumes: Task 1 types
- Produces: `authorize_control`, `admit_route`

- [ ] **Step 1: Write the failing test**

```rust
use std::collections::BTreeMap;

use maia_core::super_agent::*;

fn policy() -> RoutingPolicy {
    RoutingPolicy {
        min_confidence: Confidence::from_thousandths(800).unwrap(),
        min_margin: Confidence::from_thousandths(150).unwrap(),
        max_considered: 8,
    }
}

fn phases(id: &str, phase: TaskPhase) -> BTreeMap<TaskId, TaskPhase> {
    let mut map = BTreeMap::new();
    map.insert(TaskId(id.to_owned()), phase);
    map
}

#[test]
fn report_wake_cannot_cancel() {
    let decision = ProposedRouteDecision::Cancel {
        target: RouteTarget::Parent(TaskId("task-1".into())),
    };
    let source = TurnSource::TaskReport { report: ReportId("report-1".into()) };
    let admitted = admit_route(
        &RouteProposal {
            proposed: decision.clone(),
            shape: ProposalShape::Single,
            considered: vec![TaskId("task-1".into())],
            confidence: Confidence::from_thousandths(1000).unwrap(),
            margin: Confidence::from_thousandths(1000).unwrap(),
        },
        &policy(),
        &source,
        &phases("task-1", TaskPhase::Running { attempt: AttemptId("a1".into()) }),
    );
    assert_eq!(admitted, AdmittedRoute::Refuse { reason: RouteRefuse::ReportWake });
}

#[test]
fn low_margin_create_asks_the_user() {
    let admitted = admit_route(
        &RouteProposal {
            proposed: ProposedRouteDecision::CreateTask,
            shape: ProposalShape::Single,
            considered: vec![],
            confidence: Confidence::from_thousandths(900).unwrap(),
            margin: Confidence::from_thousandths(100).unwrap(),
        },
        &policy(),
        &TurnSource::UserMessage { message: MessageId("m1".into()) },
        &BTreeMap::new(),
    );
    assert!(matches!(admitted, AdmittedRoute::AskUser { .. }));
}

#[test]
fn linked_create_of_a_running_parent_asks() {
    let admitted = authorize_control(
        &RouteProposal {
            proposed: ProposedRouteDecision::CreateLinked {
                prior: RouteTarget::Parent(TaskId("task-1".into())),
                link: TaskLink::Modifies,
            },
            shape: ProposalShape::Single,
            considered: vec![TaskId("task-1".into())],
            confidence: Confidence::from_thousandths(1000).unwrap(),
            margin: Confidence::from_thousandths(1000).unwrap(),
        },
        &TurnSource::UserMessage { message: MessageId("m1".into()) },
        &phases("task-1", TaskPhase::Running { attempt: AttemptId("a1".into()) }),
    );
    assert!(matches!(admitted, AdmittedRoute::AskUser { .. }));
}

#[test]
fn high_confidence_continue_of_failed_is_admitted() {
    let admitted = admit_route(
        &RouteProposal {
            proposed: ProposedRouteDecision::Continue {
                target: RouteTarget::Parent(TaskId("task-1".into())),
            },
            shape: ProposalShape::Single,
            considered: vec![TaskId("task-1".into())],
            confidence: Confidence::from_thousandths(900).unwrap(),
            margin: Confidence::from_thousandths(200).unwrap(),
        },
        &policy(),
        &TurnSource::UserMessage { message: MessageId("m2".into()) },
        &phases(
            "task-1",
            TaskPhase::Failed {
                attempt: AttemptId("a1".into()),
                kind: FailureKind::WorkerReported,
            },
        ),
    );
    assert!(matches!(
        admitted,
        AdmittedRoute::Admit(RouteDecision::Continue {
            task: TaskId(_)
        })
    ));
}

#[test]
fn child_target_on_a_user_message_asks_and_seals_nothing() {
    let admitted = authorize_control(
        &RouteProposal {
            proposed: ProposedRouteDecision::Continue {
                target: RouteTarget::Child(ChildId("child-1".into())),
            },
            shape: ProposalShape::Single,
            considered: vec![],
            confidence: Confidence::from_thousandths(1000).unwrap(),
            margin: Confidence::from_thousandths(1000).unwrap(),
        },
        &TurnSource::UserMessage { message: MessageId("m1".into()) },
        &BTreeMap::new(),
    );
    assert!(matches!(admitted, AdmittedRoute::AskUser { .. }));
}
```

`ProposedRouteDecision::Continue`, `Cancel`, `Retry`, and `Inspect` carry `target: RouteTarget`; `CreateLinked.prior` is also a `RouteTarget`. `RouteTarget::Child(ChildId)` is representable only in the untrusted proposal and is never converted to an admitted `RouteDecision`. Admitted `RouteDecision` variants carry only parent `TaskId` values.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-core --test super_agent_route -- --nocapture`

Expected: FAIL with `cannot find function admit_route`.

- [ ] **Step 3: Write minimal implementation**

Implement the structural order from the spec:

1. `RouteTarget::Child` on `UserMessage` returns `AskUser`. On any other source return `Refuse { reason: ChildTarget }`.
2. `ProposalShape::Split` returns `AskUser` on `UserMessage` and `Refuse { reason: SplitProposal }` otherwise. Neither admitted decision shape can carry a subgoal list.
3. `TurnSource::TaskReport` with any decision other than `Relay` returns `Refuse { reason: ReportWake }`.
4. `UserMessage` plus `Relay`, `Continue` of a terminal phase, `CreateLinked` of a non-terminal phase, or `Retry` of a phase other than `Failed` returns `AskUser`.
5. Otherwise convert the structurally valid `ProposedRouteDecision` into a parent-only `RouteDecision` and return `Admit`.
6. `admit_route` keeps `Refuse` and `AskUser`. An `Admit` of `Continue`, `CreateTask`, `CreateLinked`, `Inspect`, `Cancel`, or `Retry` becomes `AskUser` when confidence is below `min_confidence`, margin is below `min_margin`, or `considered.len()` exceeds `max_considered`.

Terminal phases are `Completed`, `Cancelled`, and `Abandoned`. `CreateTask` does not look up a phase. `Retry` looks up the cited parent and requires `Failed`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-core --test super_agent_route -- --nocapture`

Expected: PASS, 5 tests.

- [ ] **Step 5: Honesty pause**

Both functions take policy, source, and phases as parameters. They do not call the model, the clock, or SQLite.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. A report wake cannot create, continue, inspect, cancel, or retry. A child target is not an `Admit`.

### Task 3: Envelope seal and recall query

**Files:**
- Create: `crates/maia-core/src/super_agent/envelope.rs`
- Modify: `crates/maia-core/src/super_agent/types.rs`
- Modify: `crates/maia-core/src/super_agent/mod.rs`
- Test: `crates/maia-core/tests/super_agent_envelope.rs`

**Interfaces:**
- Consumes: Task 1 types
- Produces: `seal_envelope`, `recall_query_text`

- [ ] **Step 1: Write the failing test**

```rust
use std::collections::BTreeMap;

use maia_core::super_agent::*;

fn message(bytes: &[u8]) -> UserPromptBytes {
    UserPromptBytes { message: MessageId("m1".into()), utf8: bytes.to_vec() }
}

#[test]
fn seal_keeps_exact_prompt_bytes() {
    let bytes = b"Add a pin control".to_vec();
    let draft = EnvelopeDraft {
        id: EnvelopeId("env-1".into()),
        task: TaskId("task-1".into()),
        origin_attempt: AttemptId("a1".into()),
        original_prompt: message(&bytes),
        brief: AdvisoryBrief("label only".into()),
        criteria: vec![Criterion {
            id: CriterionId("c1".into()),
            text: "pin control".into(),
            source: CriterionSource::UserText { message: MessageId("m1".into()), start: 6, end: 17 },
        }],
        constraints: vec![],
        context: SnapshotId("snapshot-1".into()),
        assumptions: vec![],
        question_log: vec![],
        open_question_count: 0,
        routing_reason: RoutingReason("new goal".into()),
    };
    let sealed = seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap();
    assert_eq!(sealed.original_prompt.utf8, bytes);
    assert_eq!(&sealed.original_prompt.utf8[6..17], b"pin control");
}

#[test]
fn unsourced_criterion_is_rejected() {
    let bytes = b"Add a pin control".to_vec();
    let mut draft = EnvelopeDraft {
        id: EnvelopeId("env-1".into()),
        task: TaskId("task-1".into()),
        origin_attempt: AttemptId("a1".into()),
        original_prompt: message(&bytes),
        brief: AdvisoryBrief("invent a dashboard".into()),
        criteria: vec![Criterion {
            id: CriterionId("c1".into()),
            text: "dashboard".into(),
            source: CriterionSource::UserText { message: MessageId("m1".into()), start: 0, end: 9 },
        }],
        constraints: vec![],
        context: SnapshotId("snapshot-1".into()),
        assumptions: vec![],
        question_log: vec![],
        open_question_count: 0,
        routing_reason: RoutingReason("new goal".into()),
    };
    let error = seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap_err();
    assert_eq!(error, SealError::SpanMismatch);
    draft.criteria.clear();
    draft.open_question_count = 1;
    let error = seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap_err();
    assert_eq!(error, SealError::UnresolvedQuestion);
}

#[test]
fn valid_source_id_with_different_text_is_rejected() {
    let bytes = b"Use the accepted rules".to_vec();
    let rule = RuleId("rule-1".into());
    let decision = DecisionId("decision-1".into());
    let mut draft = EnvelopeDraft {
        id: EnvelopeId("env-2".into()),
        task: TaskId("task-2".into()),
        origin_attempt: AttemptId("a1".into()),
        original_prompt: message(&bytes),
        brief: AdvisoryBrief("label only".into()),
        criteria: vec![Criterion {
            id: CriterionId("c1".into()),
            text: "invented rule text".into(),
            source: CriterionSource::BindingRule { rule: rule.clone() },
        }],
        constraints: vec![],
        context: SnapshotId("snapshot-2".into()),
        assumptions: vec![],
        question_log: vec![ResolvedQuestion { decision: decision.clone() }],
        open_question_count: 0,
        routing_reason: RoutingReason("new goal".into()),
    };
    let rules = BTreeMap::from([(rule, BindingText("actual rule text".into()))]);
    let decisions = BTreeMap::from([(decision, BindingText("actual decision text".into()))]);
    assert_eq!(
        seal_envelope(&draft, &message(&bytes), &rules, &decisions).unwrap_err(),
        SealError::SourceTextMismatch
    );

    draft.criteria[0] = Criterion {
        id: CriterionId("c1".into()),
        text: "invented decision text".into(),
        source: CriterionSource::AcceptedDecision {
            decision: DecisionId("decision-1".into()),
        },
    };
    assert_eq!(
        seal_envelope(&draft, &message(&bytes), &rules, &decisions).unwrap_err(),
        SealError::SourceTextMismatch
    );
}

#[test]
fn recall_query_is_prompt_plus_brief() {
    let prompt = message(b"Add a pin control");
    let text = recall_query_text(&prompt, &AdvisoryBrief("label only".into())).unwrap();
    assert_eq!(text, "Add a pin control\nlabel only");
}
```

`ResolvedQuestion` is a struct containing a `DecisionId`; it cannot represent an open question. `EnvelopeDraft` carries `open_question_count: u32`, and seal returns `UnresolvedQuestion` when that count is not zero. Do not add a boolean.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-core --test super_agent_envelope -- --nocapture`

Expected: FAIL with `cannot find function seal_envelope`.

- [ ] **Step 3: Write minimal implementation**

`seal_envelope` returns `SealError::PromptMismatch` when draft prompt bytes differ from `user_message.utf8` or message id. For each `UserText` source, compare the cited byte slice exactly to the criterion or constraint text bytes; invalid boundaries or mismatches return `SpanMismatch`. A `BindingRule` or `AcceptedDecision` id must exist in its supplied map and its stored `BindingText` must equal the criterion/constraint text; missing ids keep `MissingRule`/`MissingDecision`, and unequal text returns `SourceTextMismatch`. Every `ResolvedQuestion.decision` must exist in the decision map. `open_question_count > 0` returns `UnresolvedQuestion`. The returned envelope copies every output field, including `id` and `context`, from the draft and copies `user_message.utf8` by value. `recall_query_text` UTF-8-decodes the prompt, appends `\n`, then appends the brief. Invalid UTF-8 returns `SealError::PromptNotUtf8`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-core --test super_agent_envelope -- --nocapture`

Expected: PASS, 4 tests.

- [ ] **Step 5: Honesty pause**

The seal output's prompt vector equals the input vector. The function has no other source of prompt bytes.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. A brief sentence cannot satisfy a `UserText` span check.

### Task 4: Phase reducer

**Files:**
- Create: `crates/maia-core/src/super_agent/phase.rs`
- Modify: `crates/maia-core/src/super_agent/mod.rs`
- Test: `crates/maia-core/tests/super_agent_phase.rs`

**Interfaces:**
- Consumes: Task 1 `TaskPhase`, `PhaseEvent`
- Produces: `reduce_phase`

- [ ] **Step 1: Write the failing test**

```rust
use maia_core::super_agent::*;

#[test]
fn retry_from_failed_keeps_task_and_replaces_attempt() {
    let current = TaskPhase::Failed {
        attempt: AttemptId("a1".into()),
        kind: FailureKind::WorkerReported,
    };
    let next = reduce_phase(
        &current,
        &PhaseEvent::Retry { attempt: AttemptId("a2".into()) },
    )
    .unwrap();
    assert_eq!(next, TaskPhase::Queued);
}

#[test]
fn continue_on_failed_does_not_change_phase() {
    let current = TaskPhase::Failed {
        attempt: AttemptId("a1".into()),
        kind: FailureKind::BudgetExhausted,
    };
    let next = reduce_phase(&current, &PhaseEvent::Continue { replay_forbidden: None }).unwrap();
    assert_eq!(next, current);
}

#[test]
fn unknown_outcome_is_a_wait_and_retry_is_rejected() {
    let current = TaskPhase::WaitingForUser {
        reason: WaitReason::UnknownExternalOutcome { attempt: AttemptId("a1".into()), call: CallId("call-9".into()) },
    };
    let error = reduce_phase(
        &current,
        &PhaseEvent::Retry { attempt: AttemptId("a2".into()) },
    )
    .unwrap_err();
    assert_eq!(error, PhaseError::RetryNotFailed);
}

#[test]
fn completed_has_no_outbound_edge() {
    let current = TaskPhase::Completed { evidence: EvidenceSetId("set-1".into()) };
    let error = reduce_phase(&current, &PhaseEvent::StartAttempt { attempt: AttemptId("a2".into()) }).unwrap_err();
    assert_eq!(error, PhaseError::Terminal);
}

#[test]
fn stop_all_cancels_a_non_terminal_phase() {
    let current = TaskPhase::Running { attempt: AttemptId("a1".into()) };
    let next = reduce_phase(
        &current,
        &PhaseEvent::Host(HostCommand::StopAll { command: CommandId("stop-all".into()) }),
    )
    .unwrap();
    assert_eq!(next, TaskPhase::Cancelled { command: CommandId("stop-all".into()) });
}
```

`HostCommand::Stop` and `StopAll` each carry `command: CommandId`. `Abandon` carries `task: TaskId` and `decision: DecisionId`. The cancelled phase stores that command id.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-core --test super_agent_phase -- --nocapture`

Expected: FAIL with `cannot find function reduce_phase`.

- [ ] **Step 3: Write minimal implementation**

Match `(current, event)`:

- Any event on `Completed`, `Cancelled`, or `Abandoned` returns `PhaseError::Terminal`.
- `Queue` from a fresh caller is not used. `StartAttempt` from `Queued` yields `Running`.
- `Wait` from `Running` yields `WaitingForUser`.
- `Block` from `Running` yields `Blocked`.
- `Fail` from `Running` yields `Failed`.
- `Complete` from `Running` yields `Completed`. The completion gate is a separate function; this edge only stores an evidence-set id the caller already admitted.
- `Continue` from `WaitingForUser` or `Blocked` yields `Queued`, except `UnknownExternalOutcome` also yields `Queued` and the caller must keep the call id in the event. `Continue` from `Queued`, `Running`, or `Failed` returns `current` unchanged.
- `Retry` from `Failed` yields `Queued`. From any other phase, `PhaseError::RetryNotFailed`.
- `Host(Stop | StopAll)` from a non-terminal phase yields `Cancelled`.
- `Host(Abandon)` from a non-terminal phase yields `Abandoned`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-core --test super_agent_phase -- --nocapture`

Expected: PASS, 5 tests.

- [ ] **Step 5: Honesty pause**

No clock, no store, no tool host. Terminal phases return `PhaseError::Terminal` instead of a silent no-op.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. `Retry` is impossible from `UnknownExternalOutcome`.

### Task 5: Completion gate

**Files:**
- Create: `crates/maia-core/src/super_agent/completion.rs`
- Modify: `crates/maia-core/src/super_agent/mod.rs`
- Test: `crates/maia-core/tests/super_agent_completion.rs`

**Interfaces:**
- Consumes: `Criterion`, `CriterionMark`, `EvidenceId`
- Produces: `admit_completion`

- [ ] **Step 1: Write the failing test**

```rust
use std::collections::BTreeSet;

use maia_core::super_agent::*;

fn criterion() -> Criterion {
    Criterion {
        id: CriterionId("c1".into()),
        text: "pin control".into(),
        source: CriterionSource::UserText { message: MessageId("m1".into()), start: 6, end: 17 },
    }
}

#[test]
fn satisfied_mark_requires_known_evidence() {
    let evidence = BTreeSet::from([EvidenceId("e1".into())]);
    let marks = vec![CriterionMark::Satisfied { criterion: CriterionId("c1".into()), evidence: EvidenceId("e1".into()) }];
    let set = admit_completion(&[criterion()], &marks, &evidence).unwrap();
    assert_eq!(set, EvidenceSetId("c1:e1".into()));
}

#[test]
fn memory_id_is_not_evidence() {
    let marks = vec![CriterionMark::Satisfied { criterion: CriterionId("c1".into()), evidence: EvidenceId("fact-1".into()) }];
    let error = admit_completion(&[criterion()], &marks, &BTreeSet::new()).unwrap_err();
    assert_eq!(error, CompletionError::MissingEvidence);
}

#[test]
fn pending_criterion_rejects_completion() {
    let marks = vec![CriterionMark::Pending { criterion: CriterionId("c1".into()) }];
    let error = admit_completion(&[criterion()], &marks, &BTreeSet::new()).unwrap_err();
    assert_eq!(error, CompletionError::Incomplete);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-core --test super_agent_completion -- --nocapture`

Expected: FAIL with `cannot find function admit_completion`.

- [ ] **Step 3: Write minimal implementation**

Every criterion id must appear exactly once in `marks`. `Pending` returns `Incomplete`. `Satisfied` returns `MissingEvidence` when the evidence id is absent from the set. `Waived` requires `CriterionSource::AcceptedDecision` on that mark. `Inapplicable` requires a `CriterionSource` other than a bare brief. Return `EvidenceSetId` built by joining `criterion_id:evidence_id` in criterion order with `,`. Waiver and inapplicable contribute `waived` or `inapplicable` in that slot so the id is deterministic.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-core --test super_agent_completion -- --nocapture`

Expected: PASS, 3 tests.

- [ ] **Step 5: Honesty pause**

The function does not treat a memory id as evidence unless that id was placed in the evidence set by the caller. The test passes an empty set, so a memory-looking id fails.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit.

### Task 6: Child narrowing and router tool absence

**Files:**
- Create: `crates/maia-core/src/super_agent/child.rs`
- Modify: `crates/maia-core/src/super_agent/mod.rs`
- Test: `crates/maia-core/tests/super_agent_child.rs`

**Interfaces:**
- Consumes: envelope types, `SecurityProfile`
- Produces: `narrow_child`, `execution_tools`

- [ ] **Step 1: Write the failing test**

```rust
use std::collections::BTreeSet;

use maia_core::security::SecurityProfile;
use maia_core::super_agent::*;

fn parent_envelope() -> TaskEnvelope {
    TaskEnvelope {
        id: EnvelopeId("env-1".into()),
        task: TaskId("task-1".into()),
        origin_attempt: AttemptId("a1".into()),
        original_prompt: UserPromptBytes { message: MessageId("m1".into()), utf8: b"Add a pin control".to_vec() },
        brief: AdvisoryBrief("label only".into()),
        criteria: vec![Criterion {
            id: CriterionId("c1".into()),
            text: "pin control".into(),
            source: CriterionSource::UserText { message: MessageId("m1".into()), start: 6, end: 17 },
        }],
        constraints: vec![],
        context: SnapshotId("snap-1".into()),
        routing_reason: RoutingReason("new goal".into()),
        assumptions: vec![],
        question_log: vec![],
    }
}

#[test]
fn router_has_no_tools_when_unrestricted() {
    for profile in [SecurityProfile::Protected, SecurityProfile::Allowlisted, SecurityProfile::Unrestricted] {
        let tools = execution_tools(&SessionRole::Router, profile);
        assert!(tools.is_empty(), "{profile:?}");
    }
}

fn draft(ceiling: BTreeSet<GrantKey>, tokens: u64) -> ChildAssignmentDraft {
    ChildAssignmentDraft {
        child: ChildId("child-1".into()),
        parent: TaskId("task-1".into()),
        parent_attempt: AttemptId("a1".into()),
        subgoal: SourcedSlice {
            source: CriterionSource::UserText { message: MessageId("m1".into()), start: 4, end: 17 },
            utf8: b"a pin control".to_vec(),
        },
        envelope_slices: vec![],
        context: SnapshotId("snap-1".into()),
        ceiling,
        budget: BudgetCeiling { router_tokens: tokens, tool_turns: 1 },
    }
}

#[test]
fn child_budget_above_parent_is_rejected() {
    let error = narrow_child(
        &parent_envelope(),
        &draft(BTreeSet::from([GrantKey("shell".into())]), 50),
        &BTreeSet::from([GrantKey("shell".into())]),
        BudgetCeiling { router_tokens: 40, tool_turns: 1 },
        1,
        &ChildPolicy { max_depth: 3 },
    )
    .unwrap_err();
    assert_eq!(error, NarrowError::BudgetWidened);
}

#[test]
fn child_grant_outside_parent_is_rejected() {
    let error = narrow_child(
        &parent_envelope(),
        &draft(BTreeSet::from([GrantKey("browser".into())]), 10),
        &BTreeSet::from([GrantKey("shell".into())]),
        BudgetCeiling { router_tokens: 40, tool_turns: 1 },
        1,
        &ChildPolicy { max_depth: 3 },
    )
    .unwrap_err();
    assert_eq!(error, NarrowError::GrantWidened);
    let child = narrow_child(
        &parent_envelope(),
        &draft(BTreeSet::from([GrantKey("shell".into())]), 10),
        &BTreeSet::from([GrantKey("shell".into())]),
        BudgetCeiling { router_tokens: 40, tool_turns: 1 },
        1,
        &ChildPolicy { max_depth: 3 },
    )
    .unwrap();
    assert_eq!(child.child, ChildId("child-1".into()));
}
```

The test assigns `assignment` after a move. Build the draft in a function and call it twice so the second call does not use a moved value. `mut` is unnecessary if the function returns a fresh draft.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-core --test super_agent_child -- --nocapture`

Expected: FAIL with `cannot find function execution_tools`.

- [ ] **Step 3: Write minimal implementation**

`execution_tools` returns an empty set for `SessionRole::Router` for every profile. For `ParentTask` and `ChildTask` it returns an empty set in this leaf too: the granted tool set is decided later by the existing security admission. This function's contract is the router emptiness proof. Parent and child callers that need the catalog pass grants into `narrow_child`, not into `execution_tools`.

`narrow_child` checks slice bytes equal the cited parent-prompt span, depth `<= policy.max_depth`, every grant key is in `parent_grants`, and both budget fields are `<=` the parent remainder. Failures are `SliceMismatch`, `TooDeep`, `GrantWidened`, and `BudgetWidened`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-core --test super_agent_child -- --nocapture`

Expected: PASS, 3 tests.

- [ ] **Step 5: Honesty pause**

`execution_tools` does not branch into a process spawn. Profile is a parameter and does not add router tools.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. `Unrestricted` is covered by the loop.

### Task 7: Sidebar placement and advisory memory labels

**Files:**
- Create: `crates/maia-core/src/super_agent/sidebar.rs`
- Create: `crates/maia-core/src/super_agent/memory.rs`
- Modify: `crates/maia-core/src/super_agent/mod.rs`
- Test: `crates/maia-core/tests/super_agent_sidebar.rs`

**Interfaces:**
- Consumes: `TaskPhase`, `PinMark`, `CompletionView`, `RankedMemory`
- Produces: `place_sidebar`, `advisory_items`

- [ ] **Step 1: Write the failing test**

```rust
use maia_core::security::Taint;
use maia_core::super_agent::*;

#[test]
fn completed_unopened_stays_completed_until_close() {
    let phase = TaskPhase::Completed { evidence: EvidenceSetId("set-1".into()) };
    assert_eq!(
        place_sidebar(&phase, PinMark::Unpinned, &CompletionView::Unopened),
        SidebarSection::Completed
    );
    assert_eq!(
        place_sidebar(&phase, PinMark::Unpinned, &CompletionView::Open { detail: DetailSessionId("d1".into()) }),
        SidebarSection::Completed
    );
    assert_eq!(
        place_sidebar(&phase, PinMark::Unpinned, &CompletionView::ClosedOnce),
        SidebarSection::Archive
    );
}

#[test]
fn pin_wins_over_archive() {
    let phase = TaskPhase::Completed { evidence: EvidenceSetId("set-1".into()) };
    assert_eq!(
        place_sidebar(&phase, PinMark::Pinned, &CompletionView::ClosedOnce),
        SidebarSection::Pinned
    );
}

#[test]
fn advisory_items_cannot_change_trust_or_drop_provenance() {
    let ranked = vec![RankedMemory {
        memory: MemoryId("fact-1".into()),
        sentence: "Pins stay visible".into(),
        provenance: MemoryProvenance::Fact { fact: FactId("fact-1".into()) },
        trust: Taint::Untrusted,
    }];
    let items = advisory_items(&ranked);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].standing, AdvisoryStanding::Advisory);
    assert_eq!(items[0].trust, Taint::Untrusted);
    assert_eq!(items[0].sentence, "Pins stay visible");
}
```

`Taint` lives in `crates/maia-core/src/security`. Re-export or import it. `FactId` in this module is a `String` newtype local to `super_agent` so the leaf does not depend on brain id formatting. The daemon skin maps brain ids into this newtype before calling `advisory_items`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-core --test super_agent_sidebar -- --nocapture`

Expected: FAIL with `cannot find function place_sidebar`.

- [ ] **Step 3: Write minimal implementation**

`place_sidebar` follows the spec table: `Pinned` first, then `WaitingForUser` / `Blocked` / `Failed` to `NeedsYou`, `Queued` / `Running` to `Working`, `Completed` plus `Unopened` or `Open` to `Completed`, `Completed` plus `ClosedOnce` to `Archive`, `Cancelled` and `Abandoned` to `Archive`.

`advisory_items` copies each ranked row, sets `standing` to `Advisory`, and preserves `trust` and `provenance`. It drops nothing and it does not read a graph.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-core --test super_agent_sidebar -- --nocapture`

Expected: PASS, 3 tests.

- [ ] **Step 5: Honesty pause**

Neither function allocates from the clock or the database. Placement returns a section and no delete effect.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. Wave 1 is complete when `cargo test -p maia-core --test super_agent_types --test super_agent_route --test super_agent_envelope --test super_agent_phase --test super_agent_completion --test super_agent_child --test super_agent_sidebar` passes.

### Task 8: SQLite migration v3

**Files:**
- Modify: `crates/maia-store/src/sql.rs`
- Modify: `crates/maia-store/src/migrate.rs`
- Create: `crates/maia-store/src/super_agent_ops.rs`
- Modify: `crates/maia-store/src/lib.rs`
- Modify: `crates/maia-store/tests/sqlite_owner.rs` version assertions only
- Test: `crates/maia-store/tests/super_agent_store.rs`

**Interfaces:**
- Consumes: Wave 1 types by storing their canonical strings, not by embedding leaf logic
- Produces: `insert_router_message`, `insert_task`, `insert_task_input`, `load_prompt`, `insert_report`, `insert_child`, `set_pin`, `set_completion_view`, `mark_legacy_threads`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn prompt_bytes_round_trip_and_legacy_rows_remain() {
    let owner = open_temp();
    owner.exec("INSERT INTO threads (thread_id, version, participants, created_at) VALUES ('legacy-1', 1, '[]', 1)");
    owner.mark_legacy_threads().unwrap();
    let legacy = owner.legacy_thread_ids().unwrap();
    assert_eq!(legacy, vec!["legacy-1".to_owned()]);
    let bytes = b"Add a pin control".to_vec();
    owner.insert_task_prompt("task-1", &bytes).unwrap();
    assert_eq!(owner.load_prompt("task-1").unwrap(), bytes);
    let count: i64 = owner.scalar("SELECT COUNT(*) FROM threads");
    assert_eq!(count, 1);
}
```

Use the existing `SqliteOwner::open` helper pattern from `crates/maia-store/tests/sqlite_owner.rs`. Do not invent a second connection owner.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-store --test super_agent_store prompt_bytes_round_trip_and_legacy_rows_remain -- --nocapture`

Expected: FAIL with missing `insert_task_prompt` or missing table `task_envelopes`.

- [ ] **Step 3: Write minimal implementation**

Add `MIGRATION_V3` and set `LATEST_SCHEMA_VERSION` to `3`. Statements:

- `router_sessions (router_session_id TEXT PRIMARY KEY CHECK (router_session_id = 'router'), created_at INTEGER NOT NULL)`
- `router_messages (message_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)`
- `task_sessions (task_id TEXT PRIMARY KEY, phase TEXT NOT NULL, title TEXT NOT NULL, pinned TEXT NOT NULL, completion_view TEXT NOT NULL, prior_task_id TEXT, created_at INTEGER NOT NULL)`
- `task_attempts (task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (task_id, attempt_id))`
- `task_envelopes (task_id TEXT PRIMARY KEY, prompt BLOB NOT NULL, brief TEXT NOT NULL, routing_reason TEXT NOT NULL, snapshot_id TEXT NOT NULL)`
- `task_inputs (task_id TEXT NOT NULL, message_id TEXT NOT NULL, prompt BLOB NOT NULL, PRIMARY KEY (task_id, message_id))`
- `task_criteria (criterion_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, span_start INTEGER, span_end INTEGER, text TEXT NOT NULL)`
- `task_evidence (evidence_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, body TEXT NOT NULL)`
- `task_reports (report_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL)`
- `child_assignments (child_id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL, depth INTEGER NOT NULL, subgoal BLOB NOT NULL, budget_tokens INTEGER NOT NULL, budget_turns INTEGER NOT NULL)`
- `context_snapshots (snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, memory_id TEXT NOT NULL, provenance TEXT NOT NULL, trust TEXT NOT NULL, sentence TEXT NOT NULL, PRIMARY KEY (snapshot_id, ordinal))`
- `task_inspections` is not a durable instruction table. Do not create one. Inspection is assembled by a read query.
- `legacy_threads (thread_id TEXT PRIMARY KEY, marked_at INTEGER NOT NULL, FOREIGN KEY (thread_id) REFERENCES threads(thread_id))`

`insert_task_prompt` inserts the blob and never updates it. A second insert for the same task returns an error. `load_prompt` selects the blob. `mark_legacy_threads` inserts one row per existing `threads.thread_id` and does not delete `thread_events`.

In `sqlite_owner.rs`, change expected `user_version` `2` to `3` at the three assertions that expect the latest schema. Change the too-new pragma from `3_i64` to `4_i64`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-store --test super_agent_store --test sqlite_owner -- --nocapture`

Expected: PASS. The too-new database test still fails closed for version 4.

- [ ] **Step 5: Honesty pause**

Ops take a connection argument from `SqliteOwner`. They do not open a global connection. Prompt update SQL is absent.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. Confirm `SELECT COUNT(*) FROM threads` is unchanged by the new migration and `legacy_threads` references those ids.

### Task 9: Frontend router shell

**Files:**
- Create: `frontend/src/api/superAgentTypes.ts`
- Create: `frontend/src/api/fixtureSuperAgent.ts`
- Create: `frontend/src/hooks/useSuperAgent.ts`
- Create: `frontend/src/components/shell/TaskRail.tsx`
- Create: `frontend/src/components/shell/TaskDetail.tsx`
- Create: `frontend/src/components/shell/RouterConversation.tsx`
- Modify: `frontend/src/components/shell/AgentRail.tsx`
- Modify: `frontend/src/components/shell/ConversationPane.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/components/shell/TaskRail.test.tsx`
- Test: `frontend/src/components/shell/RouterConversation.test.tsx`

**Interfaces:**
- Consumes: the frozen API catalog shapes, Mint Ledger CSS variables already used by `AgentRail.tsx`
- Produces: `SuperAgentClient` with `sidebar`, `transcript`, `send`, `pin`, `closeDetail`, `insertReference`, `hostCommand`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskRail } from '@/components/shell/TaskRail'
import type { SidebarRow } from '@/api/superAgentTypes'

const rows: SidebarRow[] = [
  {
    task_id: 'task-1',
    title: 'Pin control',
    section: 'completed',
    phase: 'completed',
    summary: 'Ready to review',
    elapsed_ms: 1200,
    criteria_done: 1,
    criteria_total: 1,
    children: [
      {
        task_id: 'child-1',
        title: 'Write the control',
        section: 'working',
        phase: 'running',
        summary: 'Editing',
        elapsed_ms: 400,
        criteria_done: 0,
        criteria_total: 1,
        children: [],
      },
    ],
  },
]

it('shows a completed parent and nests the helper', async () => {
  const user = userEvent.setup()
  const onOpen = vi.fn()
  render(<TaskRail rows={rows} onOpen={onOpen} />)
  expect(screen.getByRole('region', { name: 'Completed' })).toHaveTextContent('Pin control')
  expect(screen.queryByRole('listitem', { name: 'Write the control' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Expand Pin control' }))
  expect(screen.getByText('Write the control')).toBeInTheDocument()
  expect(screen.getAllByRole('listitem').filter((item) => item.parentElement?.getAttribute('data-level') === 'root')).toHaveLength(1)
})
```

Add a second test that the detail view has no textbox, and a composer test that "Quote task" calls `insertReference('task-1')` and the textarea value becomes `task:task-1 `.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/shell/TaskRail.test.tsx src/components/shell/RouterConversation.test.tsx`

Expected: FAIL with `Failed to resolve import` for `TaskRail`.

- [ ] **Step 3: Write minimal implementation**

`TaskRail` groups rows by `section` in the order Needs you, Working, Completed, Pinned, Archive. Archive is a `<details>` element. Root rows have `data-level="root"`. Children render only after the expand button for that parent. `TaskDetail` renders transcript, tools, artifacts, attempts, decisions, and criteria as lists and contains no `<textarea>`. `RouterConversation` is the only composer. `AgentRail` renders `TaskRail` instead of the hard-coded Scout row and keeps the existing `StopAllButton`. `ConversationPane` renders `RouterConversation`. `App.tsx` passes `fixtureSuperAgentClient`. The fixture client returns the rows above and records pin, close, and reference calls in memory. Do not read `import.meta.env` for a model key.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/shell/TaskRail.test.tsx src/components/shell/RouterConversation.test.tsx`

Expected: PASS.

- [ ] **Step 5: Honesty pause**

Components receive rows and callbacks. They do not fetch, and they do not compute `place_sidebar` themselves. The fixture already carries `section`.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. Diff under `frontend/` contains no `API_KEY`, `BASE_URL`, or `.env`.

### Task 10: Daemon environment and model discovery

**Files:**
- Create: `crates/maia-daemon/src/env.rs`
- Create: `crates/maia-daemon/src/discovery.rs`
- Modify: `crates/maia-router/src/client.rs`
- Modify: `crates/maia-daemon/src/lib.rs`
- Modify: `crates/maia-daemon/Cargo.toml`
- Test: `crates/maia-daemon/tests/discovery.rs`

**Interfaces:**
- Consumes: `chat_completions_url` style in `crates/maia-router/src/client.rs`
- Produces: `read_model_env(vars: &[(&str, &str)]) -> Result<ModelEnv, EnvError>`, `models_url(base: &str) -> Result<String, RouterConfigError>`, `select_model_id(ids: &[String]) -> Result<String, DiscoveryError>`

- [ ] **Step 1: Write the failing test**

```rust
use maia_daemon::{read_model_env, select_model_id, EnvError, DiscoveryError};

#[test]
fn missing_key_fails_closed_without_echoing_values() {
    let error = read_model_env(&[("BASE_URL", "https://example.test/v1")]).unwrap_err();
    let rendered = format!("{error}");
    assert!(matches!(error, EnvError::MissingApiKey));
    assert!(!rendered.contains("example.test"));
    assert!(!rendered.to_lowercase().contains("key"));
}

#[test]
fn select_model_id_sorts_and_does_not_prefer_a_vendor() {
    let id = select_model_id(&["zeta".into(), "alpha".into()]).unwrap();
    assert_eq!(id, "alpha");
    let error = select_model_id(&[]).unwrap_err();
    assert_eq!(error, DiscoveryError::NoModels);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-daemon --test discovery -- --nocapture`

Expected: FAIL with `cannot find function read_model_env`.

- [ ] **Step 3: Write minimal implementation**

`read_model_env` looks up `BASE_URL` and `API_KEY` in the supplied slice. Missing either value returns `MissingBaseUrl` or `MissingApiKey`. `Display` for those errors is the fixed sentence `Model provider is not configured.` with no interpolation. `models_url` trims trailing slashes and appends `/models`, matching `chat_completions_url`. `select_model_id` clones, sorts lexicographically, and returns the first. Empty input returns `NoModels`.

Add daemon dependencies: `maia-router` is already present. Add `tokio` with `rt-multi-thread`, `macros`, and `net`, `axum = { version = "0.8.4", features = ["ws"] }`, `tower-http` with its filesystem service feature, and `dotenvy`, only on `maia-daemon`.

The composition root in Task 12 calls `dotenvy::dotenv()` and then reads only `BASE_URL` and `API_KEY` through `std::env::var`, passes those owned values into `read_model_env`, and drops the source pairs. Tests never call `dotenvy` or `std::env::var`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-daemon --test discovery -- --nocapture`

Expected: PASS, 2 tests.

- [ ] **Step 5: Honesty pause**

`read_model_env` does not call `std::env`. `Display` does not include the URL or the key.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. Search the daemon crate for `println` and `dbg` and remove any that could print env values.

### Task 11: Orchestrator and scripted tool host

**Files:**
- Create: `crates/maia-daemon/src/orchestrator.rs`
- Create: `crates/maia-daemon/src/scripted_tools.rs`
- Modify: `crates/maia-daemon/src/lib.rs`
- Test: `crates/maia-daemon/tests/orchestrator.rs`

**Interfaces:**
- Consumes: Wave 1 leaves, `Router` trait from `maia_core::router`, `SqliteOwner` ops from Task 8
- Produces: `handle_user_message`, `ScriptedToolHost::execute`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn user_text_is_sealed_once_and_router_role_cannot_execute() {
    let mut host = test_host();
    host.script_route(RouteDecision::CreateTask, 900, 200);
    let outcome = host.handle_user_message("Add a pin control").unwrap();
    assert_eq!(outcome.admitted, AdmitKind::Admit);
    assert_eq!(host.prompt_bytes("the-new-task"), b"Add a pin control");
    let error = host.tools.execute(SessionRole::Router, ExecutionTool::Shell).unwrap_err();
    assert_eq!(error, ToolHostError::RouterForbidden);
}

#[test]
fn unknown_tool_outcome_waits_and_does_not_replay() {
    let mut host = test_host();
    host.tools.unknown_on_next_parent_call();
    host.script_route(RouteDecision::CreateTask, 900, 200);
    host.handle_user_message("Add a pin control").unwrap();
    host.step_task().unwrap();
    assert!(matches!(host.phase(), TaskPhase::WaitingForUser { reason: WaitReason::UnknownExternalOutcome { .. } }));
    let calls = host.tools.call_count();
    host.continue_without_replay().unwrap();
    assert_eq!(host.tools.call_count(), calls);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-daemon --test orchestrator -- --nocapture`

Expected: FAIL with `cannot find function handle_user_message` or missing module.

- [ ] **Step 3: Write minimal implementation**

`handle_user_message` stores the user bytes in `router_messages`, asks the `Router` port for one JSON object matching `RouteProposal`, runs `admit_route` with the composition-root policy, and on `CreateTask` calls `seal_envelope` with those same bytes. The scripted router in tests returns the proposal without HTTP. `ScriptedToolHost::execute` matches `SessionRole::Router` and returns `RouterForbidden` before any script. A scripted unknown outcome returns `ToolHostError::Unknown { call_id }` and the orchestrator emits `PhaseEvent::Wait` with `UnknownExternalOutcome`. Later execute calls reject that `call_id`.

Parent task work for this demo calls the scripted host at most once and then emits `ReportKind::CompletionProposed` only when `admit_completion` succeeds. Otherwise it emits `Progress`. Relay text is written only to `router_messages`.

Do not spawn a process. If a future caller requests `ExecutionTool::Shell` for a parent while containment is not ready, return `ToolHostError::ContainmentUnavailable` and wait. Tonight's script never requests a real process.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-daemon --test orchestrator -- --nocapture`

Expected: PASS, 2 tests.

- [ ] **Step 5: Honesty pause**

`seal_envelope` is the only prompt writer. The orchestrator passes the stored bytes back in; it does not rebuild them from the model reply.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. Router role execution is refused even when the script would have returned success.

### Task 12: HTTP, websocket, and live client

**Files:**
- Create: `crates/maia-daemon/src/http.rs`
- Create: `crates/maia-daemon/src/main.rs`
- Create: `frontend/src/api/liveSuperAgent.ts`
- Modify: `frontend/src/App.tsx`
- Test: `crates/maia-daemon/tests/super_agent_http.rs`
- Test: `frontend/src/api/liveSuperAgent.test.ts`

**Interfaces:**
- Consumes: Task 11 orchestrator, frozen catalog
- Produces: daemon binary `maia-daemon`, `liveSuperAgentClient(origin: string)`

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn post_message_returns_admitted_without_secrets() {
    let server = spawn_with_scripted_router().await;
    let response = server.client.post(format!("{}/api/super-agent/messages", server.origin))
        .json(&serde_json::json!({"text": "Add a pin control"}))
        .send().await.unwrap();
    assert_eq!(response.status(), 200);
    let body = response.text().await.unwrap();
    assert!(body.contains("\"admitted\":\"admit\""));
    assert!(!body.contains("API_KEY"));
    assert!(!body.contains("BASE_URL"));
}
```

Frontend test: `liveSuperAgentClient('http://127.0.0.1:9')` request headers and JSON body fixture do not contain `API_KEY`. Mock `fetch` and assert the URL is the daemon origin plus `/api/super-agent/sidebar`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-daemon --test super_agent_http -- --nocapture`

Expected: FAIL with `could not find spawn_with_scripted_router` or connection refused.

- [ ] **Step 3: Write minimal implementation**

`main.rs` loads the root `.env` through the daemon-only environment skin, reads only `BASE_URL` and `API_KEY`, builds `RouterHttp::new` with `RouterAuth::bearer`, discovers the model id, and serves Axum on `127.0.0.1:4178`. Routes match the catalog. Handlers parse JSON, call the orchestrator, and map errors to `{ "error": "model_provider_unavailable" }` without the upstream body. Websocket sends sidebar JSON after each committed report. The router falls back to `tower_http::services::ServeDir` for `frontend/dist`, including an SPA `index.html` fallback, so `http://127.0.0.1:4178/` is the actual app rather than an API-only origin.

`liveSuperAgentClient` uses `fetch` against the supplied origin. `App.tsx` passes `window.location.origin` when `import.meta.env.MODE !== 'test'`, because the daemon serves the built frontend and API from the same origin. Tests keep the fixture client. Do not add `VITE_API_KEY`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-daemon --test super_agent_http -- --nocapture`

Then: `npm test -- src/api/liveSuperAgent.test.ts`

Expected: PASS.

- [ ] **Step 5: Honesty pause**

Handlers do not contain routing policy. They call `handle_user_message`. The live client does not import `env.rs`.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit. A grep of `frontend/src` for `API_KEY` and `BASE_URL` returns no matches.

### Task 13: Integration proofs

**Files:**
- Create: `crates/maia-daemon/tests/super_agent_flow.rs`
- Test: that file

**Interfaces:**
- Consumes: Tasks 8 through 12
- Produces: no new library API

- [ ] **Step 1: Write the failing test**

Cover these cases in one file, each as its own `#[test]`:

- continuation of a `Failed` task appends `task_inputs` and leaves the attempt id unchanged until `POST /api/super-agent/host-command` with `retry`
- `CreateLinked` against a `Running` task returns `ask` and inserts no second `task_sessions` row
- a completed modification inserts a new task whose `prior_task_id` is the completed id and whose prompt blob is the new message only
- inspection `GET /api/super-agent/tasks/:id` includes child ids and a second `POST` of the same user message does not change `task_envelopes.prompt`
- parent `StopAll` sets every descendant `child_assignments` row's parent phase and child phase to `cancelled`
- a context snapshot row stores `trust = untrusted` and `provenance` for a ranked fact, and `admit_completion` still fails when that memory id is the only offered evidence
- router compiled tools JSON for `SessionRole::Router` is `[]`
- the router model request for a relay contains the report summary and does not contain the parent tool-call transcript
- `legacy_threads` still returns the original thread id after a new task is created

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p maia-daemon --test super_agent_flow -- --nocapture`

Expected: FAIL on the first missing route or wrong phase.

- [ ] **Step 3: Write minimal implementation**

Fill only the orchestrator arms the failing assertion names. Do not add a second task for one message. Recursive cancel walks `child_assignments` where `parent_task_id` matches and repeats for those child ids as parents of grandchildren. Snapshot insert uses `advisory_items` output. Completion still calls `admit_completion`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p maia-daemon --test super_agent_flow -- --nocapture`

Expected: PASS for every test in the file.

- [ ] **Step 5: Honesty pause**

Inspection read does not call `reduce_phase` or `ScriptedToolHost::execute`. Assert that with a counter the test already observes.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit.

### Task 14: Playwright pin and archive

**Files:**
- Create: `frontend/e2e/super-agent.spec.ts`
- Modify: `frontend/src/api/fixtureSuperAgent.ts` only if the e2e fixture lacks pin and close

**Interfaces:**
- Consumes: Task 9 UI
- Produces: e2e coverage of pin and archive

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from '@playwright/test'

test('completed row archives on detail close unless pinned', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open Pin control' }).click()
  await expect(page.getByRole('dialog', { name: 'Task detail' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Task detail' }).getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close detail' }).click()
  await expect(page.getByRole('region', { name: 'Archive' })).toContainText('Pin control')
  await page.getByRole('button', { name: 'Pin Pin control' }).click()
  await expect(page.getByRole('region', { name: 'Pinned' })).toContainText('Pin control')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run e2e -- e2e/super-agent.spec.ts --project=desktop`

Expected: FAIL because the completed fixture is not archived on close, or the button names are absent.

- [ ] **Step 3: Write minimal implementation**

Wire the close button to `client.closeDetail(taskId)`, which sets `completion_view` to `closed_once` in the fixture and moves the row's `section` to `archive` unless `pin` is `pinned`. The pin button sets `pin` to `pinned` and `section` to `pinned`. Detail remains free of a textbox. The e2e server is the existing Vite preview from `frontend/playwright.config.ts`; it uses the fixture client, not the model provider.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run e2e -- e2e/super-agent.spec.ts --project=desktop`

Expected: PASS, 1 test.

- [ ] **Step 5: Honesty pause**

The browser test does not set `BASE_URL` or `API_KEY`.

- [ ] **Step 6: Review checkpoint**

Stop. Do not commit.

### Task 15: Full local verification

**Files:**
- Modify: none unless a command fails for a reason inside this plan's files

**Interfaces:**
- Consumes: Tasks 1 through 14
- Produces: a green local matrix

- [ ] **Step 1: Format and lint Rust**

Run: `cargo fmt --all -- --check`

Expected: exit 0. If it fails, run `cargo fmt --all` and review the diff. Do not commit.

Run: `cargo clippy --workspace --all-targets -- -D warnings`

Expected: exit 0.

Run: `cargo deny check`

Expected: exit 0. If `axum` triggers an advisory, record the exact advisory in the checkpoint and do not silence it with a blanket allow unless the advisory is already an accepted workspace exception.

- [ ] **Step 2: Test Rust**

Run: `cargo test --workspace --all-targets`

Expected: exit 0. Candle tests that are already ignored stay ignored. New super-agent tests are not ignored.

- [ ] **Step 3: Frontend**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run e2e`

Expected: each exit 0.

- [ ] **Step 4: Secret scan**

Run: `rg -n "API_KEY|BEGIN |sk-" frontend/src crates/maia-daemon/src crates/maia-core/src/super_agent`

Expected: no matches in `frontend/src`. Daemon matches are limited to the identifier `API_KEY` inside `env.rs` lookup code, not a literal secret.

- [ ] **Step 5: Review checkpoint**

Stop. Do not commit. List any pre-existing failing test that is outside `super_agent` and do not expand this plan to fix it in the same checkpoint.

### Task 16: Grok 4.7 live validation

**Files:**
- Modify: none

**Interfaces:**
- Consumes: a running `maia-daemon` built from this plan and the frontend pointed at `http://127.0.0.1:4178`
- Produces: screenshot paths and a redacted log

- [ ] **Step 1: Dispatch**

Dispatch one subagent with model `grok-4.7-xhigh`. The task text tells it to:

1. Run `npm run build` in `f:\Development\maia\frontend`, then start `cargo run -p maia-daemon` from `f:\Development\maia`. The daemon itself loads `BASE_URL` and `API_KEY` from the root `.env`; the subagent must not print those values, open `.env`, or pass them as CLI arguments.
2. Open `http://127.0.0.1:4178` in the browser tools.
3. Send the prompt `Add a pin control to the sidebar and stop.`
4. Observe one parent row leave Working only after a report, and confirm the router transcript relays that report.
5. Open the task detail, confirm there is no worker composer, and confirm criteria text is present.
6. Pin the row, close the detail, and confirm a pinned completed row stays under Pinned. Unpin, close again, and confirm Archive still contains the row.
7. Capture screenshots of the router chat, the sidebar sections, the detail view, and the archive.
8. Return the screenshot paths and the daemon log with any header that could carry authorization replaced by `[redacted]`.

- [ ] **Step 2: Review the evidence**

The parent reviewer checks that the prompt text in the screenshot matches the sealed prompt, that no screenshot shows an API key, and that the router bubble is the only composer. A failure here does not authorize adding execution tools to the router.

- [ ] **Step 3: Review checkpoint**

Stop. Do not commit. Record pass or the first failing observation.

## Spec coverage

| Spec section | Task |
| --- | --- |
| Status, policy numbers, supersession | Global constraints and Tasks 1–2 |
| Router tool absence | Tasks 6, 11, 13 |
| `admit_route` / `authorize_control` | Task 2 |
| Envelope and exact prompt | Tasks 3, 8, 11 |
| Phase, retry, host commands | Tasks 4, 13 |
| Completion evidence | Tasks 5, 13 |
| Nested helpers, budgets, recursive stop | Tasks 6, 13 |
| Sidebar, pin, archive | Tasks 7, 9, 14 |
| Brain provenance | Tasks 7, 8, 13 |
| Inspection | Tasks 12, 13 |
| Security profile | Tasks 6, 11 |
| Migration of legacy threads | Task 8 |
| Live model transport | Tasks 10, 12, 16 |
| Unknown outcome | Tasks 4, 11 |
| No commits | Every review checkpoint |

## Self-review notes

- Leaf names match the accepted spec. `RouteTarget` distinguishes a child id without a boolean. `HostCommand::StopAll` carries `CommandId` so the cancelled phase can store it.
- `execution_tools` is intentionally empty for the router and does not grant parent tools by itself. Parent execution goes through `ScriptedToolHost` plus existing security admission, and tonight it does not spawn a process.
- Store migration v3 does not reuse `threads` as the router log. `router_messages` is a new table. Legacy rows stay in `threads`.
- Frontend fixture tests do not duplicate `place_sidebar`. They consume a `section` field. The Rust test owns the placement table.
- Wave 2 store and Wave 2 UI are parallel-safe. Wave 3 is the next editor of `App.tsx` and does not edit `TaskRail.tsx`.
- No task contains a commit command.
