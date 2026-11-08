# Super Agent router

## TDD preamble

- **Kind:** new feature
- **Invariant:** one durable router session is the only user-facing transcript; the host admits at most one parent task per user message; the original user prompt bytes never change; a task agent never writes that transcript; no security profile grants the router an execution tool.
- **Red test(s):** router control admission under every security profile, including `Unrestricted`; envelope seal byte-identity; criterion and constraint provenance; route admission for continuation, new task, linked task, inspection, and clarification; lifecycle, retry, and recursive cancel tables; unknown-outcome refusal to replay; context-isolation fixtures; scoped read-only inspection; memory provenance; child budget and grant narrowing; completion evidence gate; sidebar placement for pin and archive; end-to-end relay where only the router log gains user-visible text.
- **Then:** implement the pure leaves first, then the host skins, then the single composer and sidebar projection.

## Honesty preamble

- **Leaves (honest):** `admit_route`, `seal_envelope`, `reduce_phase`, `admit_completion`, `narrow_child`, `place_sidebar`, and `authorize_control`. Session state, policy, bytes, ids, and time arrive as parameters.
- **Skin (I/O):** the model transport, brain retrieval, session store, tool host, clock, and UI projection. Each reads the clock once and passes `now` down. The tool host is reachable from parent and child task roles only.
- **Hooks (backward):** composer submit, report wake, detail actions, pin, stop, and stop-all handlers authenticate, parse, call one leaf or skin, and translate the result.
- **Mode args:** `RouteDecision`, `TaskPhase`, `TurnSource`, `ReportKind`, `CriterionSource`, `PinMark`, `SecurityProfile`, and `SessionRole` are enums. No boolean selects a mode.
- **Pause-and-review:** after each new function, check that the original prompt is not an output the function can rewrite, that a child id is not a route target, and that a leaf does not read the clock, store, network, or tool host.

## Status and authority

**Status: Accepted.**

Owner acceptance: 2026-11-05. The owner waived further written-spec review and authorized autonomous implementation. This document is an implementation source. `REVIEW.md` records that acceptance.

This document is authoritative for the router session, parent task sessions, nested helpers, the task envelope, route admission, the task phase machine, structured reports, read-only inspection, sidebar placement, and the rule that security profiles never arm the router with execution tools. Where `00-goal.md`, `01-vault.md`, `06-agents.md`, `07-computer.md`, or `09-frontend.md` conflict on user-facing orchestration or UI, this document wins. Those files keep their other contracts and carry a supersession notice. The following stay authoritative in their own subjects:

- `02-brain.md` for ranking, taint, and the rule that retrieval does not call a model.
- `03-thread-cache.md` for the byte layout of a single session log and for compaction inside that log.
- `04-credit.md` for presentation weights.
- `05-dream.md` for promotion and consolidation.
- `08-rust.md` for crate boundaries and honest leaves. New leaves belong in `maia-core`. This document adds no crate.
- `10-security.md` and `13-platform.md` for task-agent grants, approvals, containment, and security profiles.
- `11-secrets.md` for secret handling in every prompt, including router and task prompts.

`07-computer.md` uses "router" for the model HTTP transport. This document uses **model transport** for that port and **RouterSession** for the user-facing control session. The two names are not interchangeable.

Accepted composition-root policy, passed into leaves and not embedded in them: `min_confidence` 800, `min_margin` 150, `max_considered` 8, and `ChildPolicy.max_depth` 3. `Confidence` counts thousandths.

## Purpose

Maia presents one durable conversation. The owner types and reads in that conversation. The host turns each admitted user task into one parent task session with its own context. The parent session investigates, implements, and verifies. It reports structured status to the host. The router session is the only speaker on the user-facing transcript, and it relays those reports in ordinary language.

The router is a control plane. It dispatches, continues, inspects, cancels, retries, asks, and relays. It does not execute the user's task and it does not split one user task into several tasks.

## Inspiration, not a product dependency

The two-level shape — one resident control session, and isolated workers that report back — is inspired by the DeepSeek Harness team's essay "Exploring Super-agent Design: Towards a More Autonomous Agent System" and by the research prototype at <https://github.com/deepseek-ai/dsh-superagent-prototype>.

That repository's README states that the code is a research prototype, not an official DeepSeek product, and that it is not identical to the essay or to the team's internal system. The essay describes architectural ideas. It is not a specification of a shipped DeepSeek Harness feature. Nothing in this document imports that prototype's GitHub or Feishu intake, its panel, its prompt text, or its tool presets.

Maia deliberately differs:

- one local router chat is the only user-facing composer;
- the shared brain supplies labeled, advisory context to task sessions;
- accepted security profiles govern task agents and cannot grant execution to the router;
- nested helpers are visible in the sidebar as a tree under the parent task, and the router does not orchestrate them.

## Components

```text
Owner
  |
  |  one composer, one transcript
  v
RouterSession  ---- controls only ----+
  ^                                    |
  | relay prose                        | host
  |                                    v
  +-------- TaskReport -------- Parent TaskSession
                                      |
                                      | narrow assignment
                                      v
                                 Child sessions
                                      |
                                      v
                                 tool host, under the task security profile

Brain ---- advisory snapshot ----> parent or child context
Sidebar view <---- placement ----- host projection of parent rows and child tree
```

| Component | Owns | Does not own |
| --- | --- | --- |
| `RouterSession` | The only user-facing transcript and composer | Execution tools, task decomposition, child orchestration, phase transitions |
| Host | Route admission, envelope seal, phase, budgets, attempts, cancellation, completion, placement | Inventing criteria or rewriting prompt bytes |
| `TaskSession` | One parent task: investigation, implementation, verification, child supervision | Writing the user transcript, widening its own grants, completing without the host gate |
| Child session | One narrow subgoal inside the parent | User chat, router chat, unsourced scope, a top-level sidebar row |
| Brain snapshot | Ranked memories with provenance and trust labels | Binding criteria, completion evidence, overrides of the prompt |
| Inspection view | An ephemeral read-only copy of one parent and its descendants | Mutation, resume, execute, and durable instruction bytes |
| Sidebar | A projection of host state | Lifecycle changes and deletion |

There is exactly one `RouterSession` per daemon. Creating a second one is a host error.

## Session roles

```rust
enum SessionRole {
    Router,
    ParentTask { task: TaskId },
    ChildTask { task: TaskId, child: ChildId },
}
```

`SessionRole::Router` has an empty execution-tool set under every security profile, including `Unrestricted`. The owner chat may see the admitted MCP catalog and may pass advisory guidance on `spawn_task`, `continue_task`, and `link_task`. That guidance is not a grant, a criterion, or a change to the sealed owner prompt. Only `ParentTask` and `ChildTask` may call an admitted MCP tool, and a child never receives a wider set than its parent. The contract is `docs/superpowers/specs/2026-11-06-mcp-catalog-design.md`. `ParentTask` and `ChildTask` may also receive the execution tools `07-computer.md` and `10-security.md` already define, narrowed by grants and by `13-platform.md`.

## Data contracts

Identifiers are opaque newtypes: `RouterSessionId`, `TaskId`, `AttemptId`, `ChildId`, `EnvelopeId`, `ReportId`, `CriterionId`, `MessageId`, `DecisionId`, `SnapshotId`, `InspectionId`, `CommandId`, `RuleId`, `BlockerId`, `CallId`, `EvidenceId`, `EvidenceSetId`, `ArtifactId`, `MemoryId`, and `DetailSessionId`.

### Route admission

The model proposes one decision. The host leaf admits or replaces it. A proposal that names two creates, a child id, or any execution tool is rejected before a task exists.

```rust
enum TurnSource {
    UserMessage { message: MessageId },
    TaskReport { report: ReportId },
    HostControl { command: CommandId },
}

struct RouteProposal {
    proposed: ProposedRouteDecision,
    shape: ProposalShape,
    considered: Vec<TaskId>,
    confidence: Confidence,
    margin: Confidence,
}

enum RouteTarget {
    Parent(TaskId),
    Child(ChildId),
}

enum ProposedRouteDecision {
    Continue { target: RouteTarget },
    CreateTask,
    CreateLinked { prior: RouteTarget, link: TaskLink },
    Inspect { target: RouteTarget },
    AskUser { clarification: Clarification },
    Relay { report: ReportId },
    Cancel { target: RouteTarget },
    Retry { target: RouteTarget },
}

enum ProposalShape {
    Single,
    Split,
}

enum RouteDecision {
    Continue { task: TaskId },
    CreateTask,
    CreateLinked { prior: TaskId, link: TaskLink },
    Inspect { task: TaskId },
    AskUser { clarification: Clarification },
    Relay { report: ReportId },
    Cancel { task: TaskId },
    Retry { task: TaskId },
}

enum TaskLink {
    Modifies,
    FollowsUp,
}

struct RoutingPolicy {
    min_confidence: Confidence,
    min_margin: Confidence,
    max_considered: u32,
}
```

`Confidence` is thousandths of the closed unit interval, stored as `u16` in `0..=1000`. `admit_route` does not invent a threshold. The caller passes `RoutingPolicy`. Tests pass explicit policies. The accepted composition-root policy on 2026-11-05 is `min_confidence` 800, `min_margin` 150, and `max_considered` 8. `ChildPolicy.max_depth` at that root is 3. Leaves receive these values as arguments and do not embed them.

```rust
enum AdmittedRoute {
    Admit(RouteDecision),
    AskUser { clarification: Clarification },
    Refuse { reason: RouteRefuse },
}

enum RouteRefuse {
    ReportWake,
    ChildTarget,
    SplitProposal,
    HostControlBypass,
}
```

`ProposedRouteDecision` is the untrusted model shape. `RouteDecision` is the host-admitted shape and can name only a parent `TaskId`. `authorize_control(proposal, source, phases) -> AdmittedRoute` applies structural rules and performs that conversion. A `ChildId` on a `UserMessage` returns `AskUser`; a `ChildId` on any other source returns `Refuse { reason: ChildTarget }`. `ProposalShape::Split` on a `UserMessage` returns `AskUser`; on any other source it returns `Refuse { reason: SplitProposal }`. A `TaskReport` whose proposed decision is not `Relay` returns `Refuse { reason: ReportWake }`. A model proposal on a `HostControl` turn returns `Refuse { reason: HostControlBypass }`; host commands call the phase reducer directly. A `UserMessage` returns `AskUser` when it proposes `Relay`, names a missing parent, proposes `Continue` of a terminal parent, `CreateLinked` of a non-terminal parent, or `Retry` outside `Failed` or `Stopped`. Every remaining structurally valid proposal is converted to `Admit(RouteDecision)`.

`admit_route(proposal, policy, source, phases) -> AdmittedRoute` runs `authorize_control` first. A `Refuse` stays a `Refuse`. An `AskUser` stays an `AskUser`. An `Admit` of `Continue`, `CreateTask`, `CreateLinked`, `Inspect`, `Cancel`, or `Retry` becomes `AskUser` when `confidence` is below `min_confidence`, `margin` is below `min_margin`, or `considered` is longer than `max_considered`. A high self-reported confidence does not override `authorize_control`. Confidence is not an independent measurement of meaning.

On any `Refuse` while `source` is `TaskReport`, the host still relays the compact report that woke the turn. It does not ask the owner a new question from that wake. `AskUser` and `Refuse` both seal nothing and start nothing.

Eligible continuation targets are parent tasks in `Queued`, `Running`, `WaitingForUser`, `Blocked`, `Failed`, or `Stopped`. A high-confidence modification of a `Completed`, `Cancelled`, or `Abandoned` parent is `CreateLinked`, which creates a new parent. A high-confidence question about a terminal parent is `Inspect`. If those readings are within `min_margin` of each other, the result is `AskUser`.

`CreateTask` and `CreateLinked` each create one parent. Neither decision carries subgoals, child ids, or a second task. `CreateLinked` is legal only when the cited parent is already terminal, so a live task cannot be split by opening a sibling. A `CreateLinked` proposal aimed at a non-terminal parent becomes `AskUser` rather than a silent `Continue`.

### Task envelope

The sealed envelope is immutable. Later user messages, accepted decisions, and context refreshes are new records. They cite the envelope. They do not replace its bytes.

```rust
struct TaskEnvelope {
    id: EnvelopeId,
    task: TaskId,
    origin_attempt: AttemptId,
    original_prompt: UserPromptBytes,
    brief: AdvisoryBrief,
    criteria: Vec<Criterion>,
    constraints: Vec<Constraint>,
    context: SnapshotId,
    routing_reason: RoutingReason,
    assumptions: Vec<Assumption>,
    question_log: Vec<ResolvedQuestion>,
}

struct EnvelopeDraft {
    id: EnvelopeId,
    task: TaskId,
    origin_attempt: AttemptId,
    original_prompt: UserPromptBytes,
    brief: AdvisoryBrief,
    criteria: Vec<Criterion>,
    constraints: Vec<Constraint>,
    context: SnapshotId,
    routing_reason: RoutingReason,
    assumptions: Vec<Assumption>,
    question_log: Vec<ResolvedQuestion>,
    open_question_count: u32,
}

struct UserPromptBytes {
    message: MessageId,
    utf8: Vec<u8>,
}

struct ResolvedQuestion {
    decision: DecisionId,
}

struct BindingText(String);

enum CriterionSource {
    UserText { message: MessageId, start: u32, end: u32 },
    BindingRule { rule: RuleId },
    AcceptedDecision { decision: DecisionId },
}

struct Criterion {
    id: CriterionId,
    text: String,
    source: CriterionSource,
}

struct Constraint {
    text: String,
    source: CriterionSource,
}
```

`seal_envelope(draft, user_message, rules: BTreeMap<RuleId, BindingText>, decisions: BTreeMap<DecisionId, BindingText>) -> Result<TaskEnvelope, SealError>` checks:

- `original_prompt.utf8` equals the user message bytes that `CreateTask` or `CreateLinked` is admitting, including order and length;
- every criterion and every constraint source resolves to the exact binding text: a `UserText` span slices those exact bytes, a `BindingRule` maps to the same text in the supplied rule map, or an `AcceptedDecision` maps to the same text in the supplied decision map;
- `question_log` contains only resolved questions, each citing an `AcceptedDecision`;
- `assumptions` are marked advisory and are not valid `CriterionSource` values;
- `brief` is marked advisory. It is not a criterion source and it is not completion evidence.

`BindingRule` means a rule id and exact text already stored by the host from accepted project or design rules. The router model cannot create one by writing it into the brief. A needed rule that is not already binding becomes `AskUser`. The owner's answer, once accepted through the host, is an `AcceptedDecision` with stored exact text and may then be cited. A valid id beside different text fails sealing.

The original prompt remains authoritative. Where the brief, an assumption, or a memory sentence conflicts with those bytes, the bytes win. The worker's obligations are the original prompt, the sourced constraints, and the sourced criteria.

A continuation does not call `seal_envelope` again. The host appends a `TaskInput` whose bytes are the new user message. The existing `original_prompt` stays in place.

```rust
struct TaskInput {
    task: TaskId,
    message: MessageId,
    utf8: Vec<u8>,
    admitted: RouteDecision,
}
```

An amendment after seal is allowed only as a new record that cites an `AcceptedDecision`. The amendment may add a criterion or constraint with that decision as its source. It cannot change `original_prompt`, `brief`, or any earlier criterion's source span.

### Phase

```rust
enum TaskPhase {
    Queued,
    Running { attempt: AttemptId },
    WaitingForUser { reason: WaitReason },
    Blocked { reason: BlockerId },
    Failed { attempt: AttemptId, kind: FailureKind },
    Completed { evidence: EvidenceSetId },
    Stopped { command: CommandId },
    Cancelled { command: CommandId },
    Abandoned { decision: DecisionId },
}

enum WaitReason {
    Clarification,
    TaskQuestion { report: ReportId },
    WaiverNeeded { criterion: CriterionId },
    UnknownExternalOutcome { attempt: AttemptId, call: CallId },
    Approval { request: HumanRequestId },
    TranscriptBudget,
}

enum FailureKind {
    WorkerReported,
    BudgetExhausted,
    AttemptFailed,
}
```

`Failed` stays on the same `TaskId` and is retriable by an admitted `Retry`. `Stopped` is a hold, not a terminal phase: the owner's next message may continue or retry it. `Completed`, `Cancelled`, and `Abandoned` are terminal. `reduce_phase` rejects every edge out of a terminal phase. A modification of a terminal task is a new `TaskId` linked to the old one.

`Abandoned` is entered only by an explicit owner decision. Archive, pin, silence, and inactivity do not abandon a task. Abandoning a parent cancels its children.

### Reports

```rust
enum ReportKind {
    Progress,
    WaitingQuestion,
    Blocker,
    Failure,
    CompletionProposed,
    CancellationNoted,
    Evidence,
    CriterionStatus,
}

struct TaskReport {
    id: ReportId,
    task: TaskId,
    attempt: AttemptId,
    author: SessionRole,
    kind: ReportKind,
    summary: String,
    criterion: Vec<CriterionMark>,
    evidence: Vec<EvidenceId>,
}

enum CriterionMark {
    Pending { criterion: CriterionId },
    Satisfied { criterion: CriterionId, evidence: EvidenceId },
    Waived { criterion: CriterionId, decision: DecisionId },
    Inapplicable { criterion: CriterionId, source: CriterionSource },
}
```

`author` for a parent report is `ParentTask`. `author` for a helper report is `ChildTask`. Neither role has a write path to `RouterSession`. The host stores the report, updates the parent phase through `reduce_phase`, and wakes the router with `TurnSource::TaskReport` so the router can relay.

`summary` is the sidebar's latest meaningful update. A `Progress` report may refresh that line. Phase changes, criterion marks, evidence, questions, blockers, failures, and completion proposals are meaningful updates. The sidebar reads the stored summary. It does not parse router prose.

### Completion

`admit_completion(criteria, marks, evidence) -> Result<EvidenceSetId, CompletionError>` admits `Completed` only when every criterion is `Satisfied`, `Waived`, or `Inapplicable`, and every `Satisfied` mark cites evidence the host has stored for that attempt. `Waived` cites an `AcceptedDecision`. `Inapplicable` cites a `CriterionSource` of the same three kinds as a criterion. An assumption, a brief sentence, or a memory item is not evidence and is not a waiver.

A `CompletionProposed` report is a proposal. If the gate fails, the phase stays non-terminal. Missing evidence that the worker can still produce leaves the task `Running`. A missing waiver or an unsourced inapplicable mark moves the task to `WaitingForUser { reason: WaiverNeeded }` when a specific criterion is named, and leaves it `Running` when the proposal is simply incomplete. The host does not mark the task `Completed` on prose alone.

### Inspection

```rust
struct InspectionView {
    id: InspectionId,
    root: TaskId,
    transcripts: Vec<SessionTranscript>,
    reports: Vec<TaskReport>,
    artifacts: Vec<ArtifactId>,
    decisions: Vec<DecisionId>,
    errors: Vec<CallId>,
    criteria: Vec<CriterionMark>,
    children: Vec<ChildId>,
}
```

The view covers one parent and the descendants of that parent. It is ephemeral. It is not written into the envelope, the brief, or the original prompt. It cannot resume a session, start an attempt, call a tool, or change a phase. The router may request it on a `UserMessage` turn whose admitted decision is `Inspect`. A report-only wake relays the compact `TaskReport` and does not pull this view.

### Brain snapshot

```rust
struct ContextItem {
    snapshot: SnapshotId,
    memory: MemoryId,
    sentence: String,
    provenance: MemoryProvenance,
    trust: Taint,
    standing: Advisory,
}

enum MemoryProvenance {
    Episode { episode: EpisodeId, thread: ThreadId },
    Claim { claim: ClaimId },
    Fact { fact: FactId },
}
```

`standing` has the single value `Advisory`. The snapshot is built from the original prompt bytes plus the sealed advisory brief as the retrieval query. A refresh stores a new `SnapshotId`. Ranking itself remains `rank_paths` in `02-brain.md`: algorithmic, participant-scoped, and model-free. The snapshot is attached to the task. Items already installed in that task follow the dedupe rule in `03-thread-cache.md`. Memory text cannot override the original prompt, a binding rule, a sourced constraint, or a sourced criterion, and it cannot satisfy `admit_completion`.

### Child assignment

```rust
struct ChildAssignment {
    child: ChildId,
    parent: TaskId,
    parent_attempt: AttemptId,
    subgoal: SourcedSlice,
    envelope_slices: Vec<SourcedSlice>,
    context: SnapshotId,
    ceiling: GrantCeiling,
    budget: BudgetCeiling,
}

struct SourcedSlice {
    source: CriterionSource,
    utf8: Vec<u8>,
}

struct ChildPolicy {
    max_depth: u32,
}
```

`narrow_child(parent_envelope, assignment, parent_grants, parent_budget, depth, policy) -> Result<ChildAssignment, NarrowError>` checks that every slice equals the cited source bytes, that the subgoal cites the parent envelope or an accepted decision on that task, that `depth` is at most `policy.max_depth`, and that `ceiling` and `budget` are subsets of the parent's remaining grants and remaining budget. The caller supplies `depth` from the parent chain. The child does not receive the router transcript, sibling transcripts, or unsourced brief text.

### Sidebar placement

```rust
enum PinMark {
    Pinned,
    Unpinned,
}

enum CompletionView {
    Unopened,
    Open { detail: DetailSessionId },
    ClosedOnce,
}

enum SidebarSection {
    NeedsYou,
    Working,
    Completed,
    Pinned,
    Archive,
}
```

`place_sidebar(phase, pin, view) -> SidebarSection` returns exactly one section:

| Condition | Section |
| --- | --- |
| `pin` is `Pinned` | `Pinned` |
| phase is `WaitingForUser`, `Blocked`, `Failed`, or `Stopped` | `NeedsYou` |
| phase is `Queued` or `Running` | `Working` |
| phase is `Completed` and `view` is `Unopened` or `Open` | `Completed` |
| phase is `Completed` and `view` is `ClosedOnce` | `Archive` |
| phase is `Cancelled` or `Abandoned` | `Archive` |

The first detail open of a `Completed` task sets `Open` and leaves the row in `Completed`. Closing that detail sets `ClosedOnce`. If the mark is `Pinned` at close time, the result is `Pinned`. A later open of an archived row stays archived on close. Pinning an archived row moves it to `Pinned`. Unpinning a `Completed` task that has `ClosedOnce` returns it to `Archive`.

Placement is view state. `place_sidebar` returns no delete, no phase edge, and no revocation of brain eligibility, artifacts, or audit records.

Top-level rows are parent tasks. A child appears only in the expandable tree of its parent. The row shows the task title, phase, latest report summary, elapsed time computed at the UI skin from stored timestamps and the supplied `now`, and criterion progress as satisfied-or-waived-or-inapplicable counts over the sealed criterion count.

## Routing rules

One user message produces at most one admitted parent-task decision.

- The host presents the candidate parents: non-terminal tasks, plus terminal tasks still inside the policy's consideration limit. The model does not search an unbounded history.
- High-confidence continuation attaches the whole message to one eligible parent as a `TaskInput`.
- A clear new goal seals one new envelope and queues one parent.
- A clear modification of a terminal parent creates one linked parent. The prior terminal phase stays terminal.
- Ambiguity, a thin margin, a child target, or a split proposal becomes one clarification in the router transcript. Nothing is queued.
- The router does not emit subgoals. Nested helpers are created later, if at all, by the parent, through `narrow_child`.

Candidate selection and "recent" are the supplied candidate list. The leaf does not apply a hidden recency clock.

## Lifecycle

The host is the only writer of `TaskPhase`.

| From | Edge | To |
| --- | --- | --- |
| seal succeeded | slot granted | `Queued` |
| `Queued` | attempt started | `Running` |
| `Running` | report `WaitingQuestion`, unknown outcome, approval, transcript budget, or needed waiver | `WaitingForUser` |
| `Running` | report `Blocker` | `Blocked` |
| `Running` | report `Failure` or budget exhaustion | `Failed` |
| `Running` | `admit_completion` succeeded | `Completed` |
| `WaitingForUser`, `Blocked` | admitted `Continue` that does not replay an unknown call | `Queued` |
| `Queued`, `Running`, `Failed` | admitted `Continue` | same phase, input appended |
| `Failed` or `Stopped` | admitted `Retry` | `Queued` with a new `AttemptId` |
| `Stopped` | admitted `Continue` | `Queued` |
| any live phase other than `Stopped` | `HostCommand::Stop` or `StopAll` | `Stopped` |
| `Stopped` | `HostCommand::Stop` or `StopAll` | unchanged, command refused |
| any non-terminal, including `Stopped` | `HostCommand::Cancel` or admitted `Cancel` | `Cancelled` |
| any non-terminal, including `Stopped` | `HostCommand::Abandon` | `Abandoned` |

```rust
enum HostCommand {
    Stop { task: TaskId, command: CommandId },
    StopAll { command: CommandId },
    Cancel { task: TaskId, command: CommandId },
    Abandon { task: TaskId, decision: DecisionId, command: CommandId },
}
```

`HostCommand` is applied by `reduce_phase` directly. It does not pass through `admit_route`, and a task report cannot emit it. `Abandon` records a `DecisionId`. Archive, pin, and detail close are not an `Abandon`.

`Retry` keeps the `TaskId`, the sealed prompt, the attempt history, and the evidence already stored. It starts a new attempt. It is admitted from `Failed` or `Stopped` and rejected for every other phase, including `WaitingForUser { reason: UnknownExternalOutcome }`. An admitted `Continue` while `Failed` stores the new user bytes and leaves the phase and `AttemptId` unchanged until a separate admitted `Retry`.

An unknown external outcome records the call id and moves that session to `WaitingForUser`. The tool host refuses a later invocation of that same call id. `Continue` may leave that wait for `Queued` with the new user input attached; it does not reissue the call. Child unknown outcomes propagate: the child records the wait, and the parent phase becomes `WaitingForUser { reason: UnknownExternalOutcome }` for that call in the same host transition. The parent does not start a substitute call to hide the unknown result.

`TranscriptBudget` on a task log does not fork a hidden session. The task waits in `WaitingForUser`. A replacement parent exists only after the owner stops or abandons this one, so the cited task is terminal, and a later message is admitted as `CreateLinked`. Compaction inside one log remains `03-thread-cache.md` and cannot merge logs across the router, the parent, and a child.

Stop and Stop all are `HostControl` commands. They do not consult the model. Stop holds one task. Stop all holds every live parent that is not already `Stopped`, and each hold writes `Stopped` onto that parent and onto every descendant that is not already terminal or already `Stopped`. A repeated Stop or Stop all is refused, so a held task keeps the command that held it. `Completed` phases and archive placement stay unchanged. The threads stay `Stopped` until the owner's next message, and the router then decides which ones to continue or retry. Stop all is the only global stop, and there is no separate Panic control. It does not engage the durable panic latch and it does not delete history. Cancel is the separate host command that ends a held or live task as `Cancelled`. A cancel does not undo a side effect that already left the machine; that limit is the one already stated in `06-agents.md`.

## Nested helpers

A parent may create helpers for narrow subgoals of the already sealed task. The router never receives a control that creates, resumes, or addresses a child. `authorize_control` returns `Refuse { reason: ChildTarget }` for a child id on every decision, including `Continue`, `Cancel`, `Retry`, and `Inspect`. Inspection of a parent may include descendant records inside that parent's `InspectionView`. Those records stay labeled as descendants. They are not route targets and they are not top-level tasks.

Each child has its own log and context. It reports only to its parent. It has no composer and no write to the router transcript. The parent verifies child results before integrating them. A child `CompletionProposed` does not complete the parent and does not satisfy a parent criterion unless the parent stores evidence the completion gate can cite.

Parent `Stop` and `StopAll` recursively hold live descendants as `Stopped`. Parent `Cancel` and parent `Abandoned` recursively cancel descendants, including ones already `Stopped`. A descendant `WaitingForUser` or unknown outcome is propagated to the parent before the parent may continue. Budgets are carved from the parent's remainder for the attempt, using the lineage rule in `06-agents.md`: a child ceiling is at most that remainder, and a child cannot refresh it. Grants use the same direction as `attenuate_grants` in `10-security.md`: the child set is a subset of the parent set, and the active security profile is the daemon profile, never a looser one.

`ChildPolicy.max_depth` is an explicit parameter of `narrow_child`. The model does not choose it.

## User interface

The center surface is the router transcript and its composer. There is no worker composer and no second user chat.

The sidebar sections, top to bottom, are **Needs you**, **Working**, **Completed**, **Pinned**, and a collapsed **Archive**. Rows inside a section are parent tasks. Expanding a parent shows its helper tree. Helper rows are not repeated at the top level.

Opening a row opens a read-only detail: the full transcript, tool events, artifacts, attempts, decisions, and criterion marks for that parent and its tree. Detail actions insert an explicit parent or child reference into the router composer. They do not send, execute, or change phase by themselves. A child reference is a citation inside the parent, not a second routable task. The owner sends from the router composer. Stop, Stop all, abandon, security approvals, and unknown-outcome warnings stay host controls on the existing approval surfaces.

Phone layout keeps this single transcript. The same sections live in the existing agent drawer. Stop all stays reachable in one action, as `09-frontend.md` requires for the global stop.

The detail view and the sidebar read host state. They do not grant tools.

## Data flows

### New task

1. The owner submits one message in the router composer.
2. The hook records the message bytes and calls the model transport with compact parent summaries.
3. The model returns one `RouteProposal`.
4. `admit_route` returns `CreateTask`, or `AskUser`.
5. On `AskUser`, the router transcript receives the clarification. No envelope is sealed.
6. On `CreateTask`, `seal_envelope` checks the prompt bytes and provenance. Failure becomes `AskUser` or a recorded seal error, not a task with invented criteria.
7. The host stores the envelope, builds the first advisory snapshot from those prompt bytes and the brief, and sets `Queued`.
8. A worker slot starts `Running` under the task role. The tool host is available to that role only.

### Continuation

1. A later user message is proposed as `Continue` for one eligible parent.
2. `admit_route` either admits it or returns `AskUser`.
3. The host appends a `TaskInput` with the new bytes. `original_prompt` is unchanged.
4. `WaitingForUser` and `Blocked` move to `Queued` when the continue does not replay an unknown call. `Queued`, `Running`, and `Failed` keep their phase. `Failed` also keeps its `AttemptId`.
5. The parent does not gain a second sibling from this message.

### Status relay

1. A parent or child emits a `TaskReport`. A child report is delivered to the parent log only.
2. The host reduces the parent phase. Child reports do not write the router log.
3. The router wakes with `TurnSource::TaskReport` and the compact report.
4. `admit_route` on that wake admits `Relay` only. Create, continue, inspect, cancel, and retry are refused.
5. The router writes the user-visible prose into `RouterSession`. The sidebar reads the structured summary, not that prose.

### Detailed question

1. A user message proposes `Inspect` for one parent.
2. The host builds an `InspectionView` for that parent and its descendants.
3. The view is passed into that router turn only.
4. The relay is written to the router transcript. The view is discarded as an instruction source. Phase and envelope bytes stay as they were.

### Stop

1. Stop or Stop all is a `HostControl`. The host holds the selected live parents and recursively holds descendants that are not already terminal or already `Stopped`.
2. The parent phase becomes `Stopped`. Reached children become `Stopped`. The row stays in Needs you. Partial external effects remain in the audit.
3. The owner's next message may admit `Continue` or `Retry` for each held parent. Until that admission, a `Stopped` task is not started.

### Cancel

1. Cancel is a `HostControl`, or a `UserMessage` proposal of `Cancel` for one parent id. A `TaskReport` turn cannot authorize the proposal: `authorize_control` returns `Refuse { reason: ReportWake }`.
2. The parent phase becomes `Cancelled`, including when it was `Stopped`. Reached children become `Cancelled`. Partial external effects remain in the audit.

### Retry

1. A user message proposes `Retry` for a parent in `Failed` or `Stopped`.
2. The host opens a new `AttemptId` on the same `TaskId` and sets `Queued`.
3. Unknown-outcome waits do not take this path.
4. Prior attempt logs remain addressable from detail and from inspection.

### Archive and pin

1. A task reaches `Completed` and `place_sidebar` returns `Completed` while `CompletionView::Unopened`.
2. The first detail open keeps `Completed`.
3. Detail close sets `ClosedOnce`. The next placement is `Archive`, or `Pinned` when the mark is `Pinned`.
4. The store keeps the envelope, inputs, logs, artifacts, audit, and brain eligibility.
5. `Cancelled` and `Abandoned` are placed in `Archive` without waiting for an open. That placement is still view state.

## Invariants

1. The daemon has one `RouterSession`, and it is the only log with a user-facing composer.
2. `SessionRole::Router` has an empty execution-tool set before security-profile branching. The set stays empty under `Protected`, `Allowlisted`, and `Unrestricted`. It includes no shell, no filesystem tool, no browser automation, no network execution, no vault tool, and no domain tool from `07-computer.md`. Task contents reach the router only as a compact `TaskReport` or as an `InspectionView`.
3. `SecurityProfile::Protected`, `Allowlisted`, and `Unrestricted` govern parent and child execution. None of them adds a tool to the router.
4. One user message admits at most one new parent task.
5. Route decisions do not contain child ids or subgoal lists.
6. `original_prompt` bytes are fixed at seal and are never an output of continuation, amendment, inspection, snapshot refresh, relay, or retry.
7. Every binding criterion and constraint traces to user-text bytes, a stored binding rule, or an accepted decision. The brief, assumptions, and memories are advisory.
8. A task session writes reports to the host. The host is the only writer of the router transcript on behalf of task results.
9. `Completed` requires `admit_completion`. Terminal phases have no outbound edge.
10. `Retry` stays inside the same `TaskId` and is legal only from `Failed`.
11. An unknown external call is not replayed. The phase that records it is `WaitingForUser`.
12. A child context is not the parent context and is not the router context. Its grants and budget are subsets of the parent's remainder.
13. Parent cancel and parent abandon recursively cancel descendants.
14. An inspection view cannot mutate, resume, or execute.
15. Sidebar placement does not delete envelope, transcript, artifact, audit, or brain records.
16. A child is not a top-level sidebar row and is not a router dispatch target.
17. A router prose turn is not an approval, a completion, or a phase transition.
18. Leaves do not read the clock, the store, the network, or the tool host.

## Failure handling

- **Seal mismatch:** the host refuses `Queued`. The router asks the owner, or records the seal error. No task runs on a partial envelope.
- **Unsourced criterion or constraint:** the same refusal. The model may ask. It may not keep the unsourced sentence as binding.
- **Route conflict:** `AskUser`. No second parent is created to break the tie.
- **Report-only dangerous control:** `authorize_control` returns `Refuse { reason: ReportWake }`. The compact report can still be relayed. The wake does not become a new owner question.
- **Unknown tool outcome:** `WaitingForUser`, with the call id. No automatic retry and no browser fallback. This is the task-phase form of the ambiguous-outcome rule in `06-agents.md` and `07-computer.md`.
- **Completion proposal without evidence:** phase stays non-terminal.
- **Child unknown outcome:** parent wait is set before any further parent tool call.
- **Budget exhaustion:** the attempt becomes `Failed { kind: BudgetExhausted }`. The next attempt requires an admitted `Retry` under a budget the host still allows. The task does not silently continue.
- **Restart:** non-terminal `Running` attempts become `Failed { kind: AttemptFailed }` unless the host can show the attempt had not yet made an external call, in which case it returns to `Queued`. Calls with unknown outcome follow the wait rule. Sealed prompt bytes are part of the durable envelope and are reloaded, not recomputed from the brief.
- **Model transport failure on the router:** no dispatch is invented. The user message stays unadmitted and the router transcript records the failure.
- **Inspection failure:** the router says the detail could not be read. Phase is unchanged.
- **Archive or pin write failure:** placement stays at the last committed view. Phase is unchanged.

## Security and privacy

Task agents run under the daemon security profile and the grant, approval, containment, and egress rules in `10-security.md` and `13-platform.md`. `Unrestricted` may auto-allow controllable task sinks that those documents already name. It does not create router sinks. `DesktopConfirm` administration stays desktop-only.

Approvals and unknown-outcome warnings are host UI bound to the action digest. Text in the router transcript, a task report, or an inspection view does not approve, deny, or waive a criterion.

Secrets follow `11-secrets.md` in router prompts, task prompts, briefs, snapshots, and inspection views. Tool output remains untrusted. Memory trust labels are preserved on `ContextItem`. Advisory memories do not become trusted because they were retrieved. The phone remains a remote window onto this daemon, as in `00-goal.md` and `13-platform.md`.

Prompt injection in a report or a tool result can propose a control. `TurnSource::TaskReport` cannot admit create, continue, cancel, or retry. That is the host boundary. Residual risk is a user-message turn whose model proposal misreads the owner's words as `Cancel` or `Retry`. Stop and Stop all do not depend on that proposal.

## Supersessions

These supersessions are in effect as of owner acceptance on 2026-11-05. The named documents keep their remaining text and carry a notice. Implementers follow this document on the conflicts below.

| Document | Conflict this document replaces |
| --- | --- |
| `00-goal.md` | The user-facing loop compiles a direct chat and runs tools in that same chat. Here the user-facing loop is `RouterSession`. Tool execution happens in a parent `TaskSession` or its children. The product sequence's "thread runs tools until sleep" step applies to task roles, not to the router. |
| `01-vault.md` | Vault agent folders remain the human-edited personalities and entity notes those documents describe. They stop being the sidebar's user-facing chat list. Private-entity retrieval for a task uses the task's participant set under `02-brain.md`, not a second composer per folder. |
| `06-agents.md` | The user-facing unit is no longer a direct thread that both talks and executes. `OpenThread` and `PostToThread` are not how the router splits a user task. The user-facing four-state machine is replaced, for this surface, by `TaskPhase`. Leases, audit, panic, and budget lineage remain the host mechanism underneath attempts and children. Agent-to-agent shared caches are not the isolation boundary between router, parent, and child. |
| `07-computer.md` | The closed `ToolRequest` set is available to parent and child roles when grants allow. It is not available to `SessionRole::Router`. The model-transport port stays the HTTP adapter specified there. |
| `09-frontend.md` | The center pane is the router chat. The agent rail's per-agent thread list is replaced by Needs you, Working, Completed, Pinned, and Archive, with helper trees under parents. Detail is read-only and has no worker composer. `Stop all`, approval sheets, and phone reachability stay. |

`02-brain.md`, `03-thread-cache.md`, `04-credit.md`, `05-dream.md`, `08-rust.md`, `10-security.md`, `11-secrets.md`, and `13-platform.md` keep their contracts. This document calls them. It does not loosen them.

Existing `threads` and `thread_events` rows stay in SQLite. The accepted migration marks them legacy and readable. It does not delete them, rewrite their event bytes, or make them the user-facing composer. New owner conversation uses `router_sessions` and `task_sessions`.

## Acceptance criteria for this architecture

1. Review can point to one `RouterSession` contract and an empty router execution-tool set that survives every security profile.
2. Review can point to `seal_envelope` and see that the original prompt is compared byte for byte and is not an editable field of any later record.
3. Review can point to `CriterionSource` and see that binding text has exactly three origins, and that the brief, assumptions, and memories are outside those origins.
4. Review can point to `admit_route` and see one parent per user message, clarification on ambiguity, continuation only for eligible phases, and no child target.
5. Review can point to `reduce_phase` and see host-owned edges, same-task retry from `Failed` or `Stopped`, a hold at `Stopped` until the owner's next message, no replay of unknown calls, and no exit from terminal phases.
6. Review can point to child narrowing and see sourced slices, subset grants, parent-charged budget, parent-only reports, and recursive cancel.
7. Review can point to `admit_completion` and see evidence, waiver, or sourced inapplicability for every criterion.
8. Review can point to `place_sidebar` and see one section, pin precedence, archive on first detail close of a completed task, and no delete effect.
9. Review can point to inspection and see an ephemeral parent-scoped read with no mutate, resume, or execute operation.
10. The conflicts with `00`, `01`, `06`, `07`, and `09` are the table above and no others are implied.

## Testing contracts

Tests inject policy, bytes, phases, grants, and clocks. They do not discover thresholds from ambient configuration.

- **Router tool absence.** For each `SecurityProfile`, including `Unrestricted`, the router role's execution-tool set is empty before and after profile branching. A fixture that attaches shell, filesystem read or write, browser, network execution, vault, `OpenThread`, or `PostToThread` to that role fails admission.
- **Immutable prompt.** Seal stores the user message bytes. Continuation, amendment, retry, inspection, and snapshot refresh fixtures compare equal bytes afterward. A one-byte drift fails.
- **Criteria provenance.** A criterion citing a span must match the slice. A criterion citing a missing rule or decision is rejected. A brief-only obligation is rejected.
- **Semantic admission.** Fixtures cover confidence and margin at the policy boundary, a tie that becomes `AskUser`, continuation of each eligible phase, `AskUser` for continuation of each terminal phase, linked create for a terminal modification, `AskUser` for `CreateLinked` on a live parent, inspect for a terminal question, and `AskUser` with nothing sealed for two creates or a child id on a user message.
- **Lifecycle.** The transition table is exhaustive. `Retry` from `Failed` or `Stopped` keeps `TaskId` and changes `AttemptId`. `Continue` on `Failed` keeps both ids and the phase. `Continue` or `Retry` on `Stopped` returns `Queued`. `Retry` from unknown-outcome wait is rejected, and the recorded call id cannot be issued again. `CreateLinked` against a non-terminal parent becomes `AskUser`. Stop of a parent yields `Stopped` on every live descendant. Cancel of a parent yields `Cancelled` on every live or held descendant.
- **Context isolation.** Router, parent, and child logs are distinct byte sequences. A child fixture contains only its sourced slices and its snapshot.
- **Inspection.** The view includes the parent transcript, tool events, artifacts, decisions, errors, criterion marks, and child ids. The tool host and `reduce_phase` receive no call from building the view.
- **Memory.** Snapshot items carry provenance and trust. A completion fixture that offers only a memory id as evidence is rejected.
- **Nested budget and security.** A child grant outside the parent set is rejected. A child budget above the parent remainder is rejected. `Unrestricted` still leaves the router tool set empty. Recursive cancel reaches a grandchild.
- **Completion evidence.** Each criterion is satisfied with evidence, waived by decision, or inapplicable by source. One pending criterion rejects `Completed`.
- **Sidebar.** Completed and unopened stays `Completed`. Close after first open yields `Archive`. `Pinned` yields `Pinned` across that close. Archive fixtures still read the envelope and the audit.
- **Relay.** A task report fixture appends user-visible text only to `RouterSession`. The task log gains the report. The task log gains no router composer message.

## Staged implementation boundaries

Implementation follows [`../superpowers/plans/2026-11-05-super-agent-router.md`](../superpowers/plans/2026-11-05-super-agent-router.md).

1. Red contract tests for the leaves, with no model, tool, or UI process.
2. `admit_route`, `seal_envelope`, `authorize_control`, `reduce_phase`, `admit_completion`, `narrow_child`, and `place_sidebar` in `maia-core`.
3. Host skins: one router session, parent session logs, envelope storage, and the model transport bound to role. The tool host stays unwired to `SessionRole::Router`.
4. One user message to one admitted parent, then continuation inputs that preserve prompt bytes.
5. Reports, relay into the router log, and the completion gate.
6. Child sessions, budget carving, grant narrowing, and recursive cancel.
7. Ephemeral inspection on a user-message inspect decision.
8. Sidebar and read-only detail as a projection, including pin and archive placement.
9. End-to-end relay and the security-profile matrix.

A later stage does not widen the router tool set to make a test pass.

## Decisions recorded

- Continuation appends a `TaskInput`. It does not reseal or edit `original_prompt`.
- `Continue` applies to `Queued`, `Running`, `WaitingForUser`, `Blocked`, and `Failed`. Terminal work becomes `CreateLinked` or `Inspect`, or `AskUser` when those are close.
- `Failed` and `Stopped` are retriable and non-terminal. `Completed`, `Cancelled`, and `Abandoned` are terminal. `Stopped` waits in Needs you until the owner's next message.
- `Abandoned` is an explicit owner decision. Archive does not imply it.
- `Cancelled` and `Abandoned` start in `Archive`. `Completed` waits for the first detail close unless pinned.
- A pinned task occupies `Pinned` only, so a row is in one section. The row still shows its phase.
- Needs you contains `WaitingForUser`, `Blocked`, `Failed`, and `Stopped`. Working contains `Queued` and `Running`.
- Open questions block seal. The sealed envelope stores resolved questions only.
- The brief and assumptions are advisory. Binding obligations are the prompt, sourced constraints, and sourced criteria.
- Child sessions may use `WaitingForUser` internally, and that wait is propagated to the parent. Children never gain a composer.
- Detail buttons insert composer references. They do not execute. Chat cancel and retry require `TurnSource::UserMessage`. Stop, Stop all, Cancel, and abandon are `HostCommand` values.
- A report-only wake may relay. It may not create, continue, inspect, cancel, or retry.
- `CreateLinked` cites a terminal parent only. Continuation of a live parent is `Continue` of that same parent, or `AskUser`.
- `Continue` on `Failed` appends input and does not start an attempt. `Retry` is the only edge from `Failed` to `Queued`. `Continue` and `Retry` are both edges from `Stopped` to `Queued`.
- Confidence thresholds, consideration limits, and `ChildPolicy.max_depth` are parameters passed into leaves. The composition root passes the accepted policy in **Status and authority**. Report summaries are stored as the worker sent them; no leaf rewrites them.
- Existing `threads` rows stay readable, are marked legacy, and are not the user-facing composer.

## Explicitly out of scope

- Importing DeepSeek prototype sources, presets, panels, or multi-channel listeners.
- Proactive work that starts without a user message or an already accepted host rule recorded as a binding rule.
- A second user-facing composer for a parent or a child.
- Router-directed decomposition of one user message into several parents or into children.
- Using archive, pin, or detail-close as deletion, revocation, or a phase transition.
- Letting a security profile, including `Unrestricted`, add execution tools to the router.
- Replaying an unknown external call.
- Deleting or rewriting historical direct-thread rows. The accepted migration only marks them legacy and readable.
- Changing `02`, `03`, `04`, `05`, `08`, `10`, `11`, or `13` except by calling their existing contracts.
- Embedding confidence, depth, or budget numbers inside a leaf. The composition root passes the accepted policy.

## Consistency links

- [`00-goal.md`](00-goal.md) — user-facing loop superseded here; brain, dreams, and the desktop daemon boundary remain.
- [`01-vault.md`](01-vault.md) — vault folders and personalities that remain human-edited notes.
- [`02-brain.md`](02-brain.md) — model-free ranking used to build advisory snapshots.
- [`03-thread-cache.md`](03-thread-cache.md) — per-log prefix and recall dedupe.
- [`06-agents.md`](06-agents.md) — leases, panic, and budget lineage underneath attempts.
- [`07-computer.md`](07-computer.md) — model transport and the execution tool enum withheld from the router.
- [`09-frontend.md`](09-frontend.md) — rail and composer superseded here; Mint Ledger, Stop all, and phone reachability remain.
- [`10-security.md`](10-security.md) — grants, approvals, and attenuation for task roles.
- [`11-secrets.md`](11-secrets.md) — no secrets in prompts or inspection views.
- [`13-platform.md`](13-platform.md) — security profiles for task execution.
- DeepSeek research prototype, inspiration only: <https://github.com/deepseek-ai/dsh-superagent-prototype>.
