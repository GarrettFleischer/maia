# Rust architecture

## Status and authority

This document defines the Rust workspace boundary for Maia. It is a design contract, not an
implementation plan.

The Google Rust Style Guide is the primary style authority. The official Rust Style Guide and
Rust API Guidelines apply where they do not conflict with it. Rules explicitly scoped to Chrome,
Chromium, or Fuchsia do not apply to Maia. In particular, Maia may use Cargo's conventional
layout, Tokio, `async`/`.await`, and Tokio tasks.

Maia is application code. API guidance therefore favors direct, application-specific types over
prematurely general libraries. Any change to the boundaries or signatures below must first change
this document and pass the design review.

## Invariants

- `maia-core` is deterministic and has no filesystem, database, network, process, browser, clock,
  environment, framework, or global-client access.
- Dependency arrows point toward `maia-core`; `maia-core` never points toward an adapter.
- A leaf reads and writes only state reachable from its parameters.
- Each external capability is owned by one skin and exposed to policy through a narrow port.
- Framework hooks parse framework values, call one skin or leaf, and translate the result. They do
  not contain policy.
- The SQLite connection has one owner task. No connection or transaction is shared behind
  `Arc<Mutex<_>>`.
- Promotion and consolidation (the dream) can depend on the brain, vault, router, and embedder ports.
  Neither can receive or recover a `Tools` implementation.
- No code runs before `main`.
- Every workspace crate forbids unsafe code except one: `maia-win32`, a small audited crate
  allowed `unsafe` only for Job Objects, AppContainer profiles, ConPTY, pipe ACLs, and
  credential-store calls. It exposes safe typed functions, parses no untrusted bytes, and is
  reviewed on every change.

## Dependency direction

The permitted compile-time dependency graph is:

```text
maia-daemon ─┬─> maia-store ─────> maia-core
             ├─> maia-vault ─────> maia-core
             ├─> maia-router ────> maia-core
             ├─> maia-embedder ──> maia-core
             ├─> maia-tools ─────> maia-core
             ├─> maia-secrets ───> maia-core
             └───────────────────> maia-core

maia-tools ───> maia-win32
maia-secrets ─> maia-win32
maia-daemon ──> maia-win32
```

`maia-win32` depends on no workspace crate and is the only permitted target of a horizontal
edge. Apart from those edges, there are no horizontal dependencies between adapter crates. Adapters exchange only
`maia-core` types through orchestration in `maia-daemon`. In particular:

- `maia-store` does not call the router, vault, embedder, or tools.
- `maia-vault` does not open SQLite or call a model.
- `maia-router` does not persist responses or execute tools.
- `maia-embedder` does not select memories or persist vectors.
- `maia-tools` does not compile prompts, call the router, or update thread state.
- `maia-daemon` may depend on every workspace crate because it is the composition root and
  framework boundary.

Third-party domain types do not cross a port. Each adapter translates its library's types into
`maia-core` request, response, and error types at the boundary.

## Crate responsibilities

### `maia-core`

Owns domain newtypes, closed request and state enums, pure algorithms, durable event shapes, port
traits, and orchestration policy that can run against fake ports. It owns:

- weighted ACT-R activation and retrieval ranking;
- attribution and co-use calculations;
- canonical prompt compilation and compaction decisions;
- vault frontmatter and generated-region rendering;
- thread, episode, claim, fact, slot, presentation, and tool domain types;
- `ThreadLog`, `BrainStore`, `VaultStore`, `Router`, `Embedder`, `Tools`, and
  `SecretStore` ports;
- chat-loop, promotion, and dream policy expressed generically over only the ports each policy
  needs. Promotion and dream policy must not take `Tools` or `SecretStore::resolve`.

It does not own defaults loaded from configuration, SQL, HTTP payloads, file watching, local-model
runtime code, subprocesses, Axum, Tauri, or Tokio startup.

### `maia-store`

Owns the one SQLite database file, migrations, FTS5 statements, vector persistence, transactions,
and the database owner task. It implements `ThreadLog` and `BrainStore`. The v1 graph is ordinary
node and edge tables with FTS5 and `sqlite-vec`. No graph engine extension is loaded
(`02-brain.md`, Physical storage).

The adapter serializes all connection access through a bounded command channel. A command that
must atomically update the thread heat ledger and shared brain is one database-owner command and
one SQLite transaction. SQL row types remain private to this crate.

### `maia-vault`

Owns filesystem access to the Obsidian vault, path confinement, frontmatter/body reads, generated
index writes, entity-page replacement, atomic file replacement, and file watching. It implements
`VaultStore`.

Rendering and human-region preservation remain pure functions in `maia-core`; this crate only
reads bytes, invokes those functions, and writes the returned bytes. It never writes
`personality.md`.

### `maia-router`

Owns the OpenAI-compatible HTTP client, request/response translation, readable-reasoning parsing,
tool-call parsing, provider-signature round trips, timeout behavior, and cached-token extraction.
It implements `Router`. It neither compiles prompts nor owns the agent loop.

### `maia-embedder`

Owns loading and invoking the configured local embedding model, batching model input, and
normalizing model-specific output into domain vectors. It implements `Embedder`.

Model selection is configuration supplied by `maia-daemon`. Similarity, ranking, and vector
persistence stay outside this crate.

### `maia-tools`

Owns per-thread ConPTY sessions, the persistent Chrome profile, the api-anything
and Scrapy sidecars, tool timeouts, audit-ready tool outcomes, challenge
detection, and unattended auth automation. It implements `Tools`.

`ToolRequest` is a closed `maia-core` enum. Browser, Scrapy, and shell library
types remain private. Challenge detection attempts granted credentials, store-
backed MFA, and the configured captcha solver first; it returns `NeedsHuman`
only when automation cannot proceed. The adapter does not mutate thread state
itself. When a tool needs a credential, it receives a `SecretRef` and asks
`SecretStore` to resolve inside this boundary; secret bytes do not cross back
into `maia-core` policy as owned values.

### `maia-secrets`

Owns the Windows Credential Vault adapter (default) and the optional Vault/OpenBao KV v2
adapter that implement `SecretStore`. It stores and resolves secret values, enforces lock
state, and returns short-lived `SecretValue` leases that zeroize on drop. Metadata and
scopes are catalogued as `SecretRef` rows without values. See `11-secrets.md`. The Windows
adapter calls `CredRead`, `CredWrite`, and `CredDelete` only through safe functions exported by
`maia-win32`; `maia-secrets` itself is `forbid(unsafe_code)`.

### `maia-daemon`

Owns configuration loading, Tokio startup, concrete adapter construction, `assemble`, Axum routes,
Tauri integration, the scheduler/timer loop, cancellation, budgets, panic control, and binding to
localhost and the selected Tailscale address.

It is the only crate allowed to know every concrete adapter. It contains no retrieval, attribution,
prompt-layout, or rendering algorithm.

## Honest leaves, I/O skins, and hooks

### Honest leaves

Leaves are synchronous unless computation proves large enough to merit an explicitly managed
blocking worker. They have no port trait parameters because port traits represent I/O.

The initial leaf signatures are:

```rust
pub fn activation(
    presentations: &[WeightedPresentation],
    now: Timestamp,
    decay: f64,
    age_unit: AgeUnit,
) -> Result<f64, ActivationError>;

pub fn rank_paths(
    graph: &RecallGraph,
    query: &RecallQuery,
    now: Timestamp,
    policy: &RankPolicy,
    quarantine: &QuarantineSet,
    participants: &BTreeSet<AgentId>,
) -> Result<Vec<RankedPath>, RankError>;

pub fn attribute_uses(
    scope: &AttributionScope,
) -> Result<AttributionLedger, AttributionError>;

pub fn compile_prompt(
    log: &ReplayedThread,
) -> Result<CompiledPrefix, CompileError>;

pub fn append_recall(
    prefix: &CompiledPrefix,
    ranked: &[RankedPath],
) -> Result<CompiledWithRecall, CompileError>;

pub fn append_scratch(
    with_recall: &CompiledWithRecall,
    proposed_paths: &[VaultPath],
) -> Result<CompiledRequest, CompileError>;

pub fn to_router_messages(
    request: &CompiledRequest,
) -> Result<Vec<ChatMessage>, CompileError>;

pub fn should_compact(
    state: &CompactionState,
    policy: &CompactionPolicy,
) -> CompactionDecision;

pub fn render_index(children: &[NoteHeader]) -> String;

pub fn render_entity_page(
    existing: &str,
    facts: &[EntityFact],
) -> Result<String, RenderEntityError>;

pub fn propose_dream_candidates(
    episodes: &[Episode],
    facts: &[Fact],
) -> DreamCandidates;

pub fn parse_promotion(
    response: &str,
    episode: &EpisodeId,
) -> Result<Vec<ClaimDraft>, PromotionError>;

pub fn lexemes_for_sentence(
    sentence: &str,
    policy: &LexicalPolicy,
) -> Vec<LexemeId>;
```

`parse_promotion` is an honest leaf: it validates the one-episode promotion schema and rejects
unknown fields, a wrong `episode`, a non-declarative `sentence`, and tool-call channels. It does not
read the brain. `lexemes_for_sentence` is an honest leaf over the supplied lexical policy.

`rank_paths` receives precomputed query and node vectors inside `RecallGraph` and
`RecallQuery`; it does not call `Embedder`. Quarantined facts and facts scoped to agents outside
`participants` are omitted. `RankPolicy` includes `AgeUnit`, a recall token budget, and
`RecallTaintMode` exactly as `10-security.md` defines it (`IncludeUntrusted` default;
`TrustedOnly` per agent the owner marks sensitive). Decay is `f64`. `RankedPath` carries a
`RecallItem` (`Claim` or `Fact` id), sentence, and taint so `append_recall` needs no other input. `compile_prompt` returns owned canonical durable prefix bytes, their
hash, and ordered slot metadata. `append_recall` then `append_scratch` add turn-local regions
without changing the prefix hash. `to_router_messages` is the only mapping into
`RouterRequest.messages`. `render_entity_page` treats malformed or missing region markers as a
recoverable error and never guesses where human content ends.

### I/O skins

Skins own external state and read nondeterministic values once. They pass clock values, data, and
closed mode enums down to policy and leaves.

The initial skin signatures are:

```rust
pub async fn run_thread<L, B, V, R, E, T>(
    command: RunThreadCommand,
    now: Timestamp,
    thread_log: &L,
    brain_store: &B,
    vault_store: &V,
    router: &R,
    embedder: &E,
    tools: &T,
) -> Result<ThreadRunOutcome, RunThreadError>
where
    L: ThreadLog,
    B: BrainStore,
    V: VaultStore,
    R: Router,
    E: Embedder,
    T: Tools;

pub async fn run_promote<B, R, E>(
    episode: EpisodeId,
    now: Timestamp,
    brain_store: &B,
    router: &R,
    embedder: &E,
) -> Result<PromotionOutcome, PromotionError>
where
    B: BrainStore,
    R: Router,
    E: Embedder;

pub async fn run_consolidate<B, V, R, E>(
    request: DreamRequest,
    now: Timestamp,
    brain_store: &B,
    vault_store: &V,
    router: &R,
    embedder: &E,
) -> Result<DreamOutcome, DreamError>
where
    B: BrainStore,
    V: VaultStore,
    R: Router,
    E: Embedder;

pub fn assemble<L, B, V, R, E, T>(
    settings: Settings,
    thread_log: L,
    brain_store: B,
    vault_store: V,
    router: R,
    embedder: E,
    tools: T,
) -> Application<L, B, V, R, E, T>
where
    L: ThreadLog,
    B: BrainStore,
    V: VaultStore,
    R: Router,
    E: Embedder,
    T: Tools;
```

`run_promote` and `run_consolidate` have no `ThreadLog`, `Tools`, or `SecretStore` type parameter.
They read episodes and claims through `BrainStore` and cannot append thread events. Promotion never
writes canonical facts; consolidation is the only runner that does. `maia-daemon` constructs the concrete
`SecretStore` first and passes it into the `Tools` and `Router` adapters it builds; `run_thread`
and `assemble` never receive it, so orchestration policy sees `ToolOutcome` and router errors,
never a resolve capability. The router resolves only its own `SecretRef` from `RouterConfig`.
Ports remain statically dispatched.
`maia-daemon` gives the fully concrete production application type a local alias for framework
state; `assemble` does not erase port types.

### Framework hooks

Hooks are backward-facing entrypoints whose signatures are constrained by Tokio, Axum, or Tauri.
They are glue only:

```rust
#[tokio::main]
async fn main() -> Result<(), MainError>;

async fn post_message(
    State(application): State<ApplicationHandle>,
    Json(request): Json<PostMessageRequest>,
) -> Result<Json<PostMessageResponse>, ApiError>;

async fn stop_all(
    State(application): State<ApplicationHandle>,
) -> Result<StatusCode, ApiError>;

async fn scheduler_tick(
    now: Timestamp,
    application: &ApplicationHandle,
) -> Result<(), SchedulerError>;

fn build_window(application: ApplicationHandle) -> Result<TauriWindow, WindowError>;
```

`main` loads configuration, constructs adapters, calls `assemble`, and starts the application.
Handlers validate transport input and translate domain errors to HTTP responses. The timer loop
reads the clock and passes `now` to `scheduler_tick`; the tick does not read a clock.

## Dependency-inversion port rules

A port is permitted only when a skin must be tested against at least two implementations: the real
adapter and a deterministic test implementation. Traits are not used to organize pure functions.

Ports live in `maia-core`, are capability-specific, and expose domain types:

```rust
pub trait ThreadLog {
    fn load_thread(
        &self,
        thread_id: ThreadId,
    ) -> impl Future<Output = Result<ThreadSnapshot, ThreadLogError>> + Send;

    fn append(
        &self,
        thread_id: ThreadId,
        expected_version: ThreadVersion,
        events: &[ThreadEvent],
    ) -> impl Future<Output = Result<ThreadVersion, ThreadLogError>> + Send;
}

pub trait BrainStore {
    fn retrieval_graph(
        &self,
        request: &GraphRequest,
    ) -> impl Future<Output = Result<RecallGraph, BrainStoreError>> + Send;

    /// Commits thread heat, presentations, co-use edges, and negative marks in one transaction.
    fn apply_ledger(
        &self,
        ledger: &AttributionLedger,
    ) -> impl Future<Output = Result<(), BrainStoreError>> + Send;

    fn pending_promotion_input(
        &self,
        request: &PromotionInputRequest,
    ) -> impl Future<Output = Result<PromotionInput, BrainStoreError>> + Send;

    /// Inserts provisional claims, mention edges, lexeme edges, and promoted status in one transaction.
    fn apply_promotion(
        &self,
        update: &PromotionUpdate,
    ) -> impl Future<Output = Result<(), BrainStoreError>> + Send;

    fn pending_consolidation_input(
        &self,
        request: &DreamInputRequest,
    ) -> impl Future<Output = Result<DreamInput, BrainStoreError>> + Send;

    fn apply_consolidation(
        &self,
        update: &DreamUpdate,
    ) -> impl Future<Output = Result<(), BrainStoreError>> + Send;
}

pub trait VaultStore {
    fn map(
        &self,
        path: Option<&VaultPath>,
    ) -> impl Future<Output = Result<VaultMap, VaultError>> + Send;

    fn read(
        &self,
        path: &VaultPath,
    ) -> impl Future<Output = Result<NoteBody, VaultError>> + Send;

    fn apply_generated(
        &self,
        update: &GeneratedVaultUpdate,
    ) -> impl Future<Output = Result<(), VaultError>> + Send;
}

pub trait Router {
    fn complete(
        &self,
        request: &RouterRequest,
    ) -> impl Future<Output = Result<RouterResponse, RouterError>> + Send;

    fn cancel(
        &self,
        request_id: RequestId,
    ) -> impl Future<Output = Result<(), RouterError>> + Send;
}

pub trait Embedder {
    fn embed(
        &self,
        texts: &[&str],
    ) -> impl Future<Output = Result<Vec<Embedding>, EmbedderError>> + Send;
}

pub trait Tools {
    fn execute(
        &self,
        thread_id: ThreadId,
        request: &ToolRequest,
    ) -> impl Future<Output = Result<ToolOutcome, ToolError>> + Send;

    fn cancel(
        &self,
        thread_id: ThreadId,
        call_id: ToolCallId,
    ) -> impl Future<Output = Result<(), ToolError>> + Send;
}

pub trait AuditLog {
    fn append(
        &self,
        event: &AuditEvent,
    ) -> impl Future<Output = Result<(), AuditError>> + Send;

    fn verify_chain(
        &self,
    ) -> impl Future<Output = Result<(), AuditError>> + Send;
}
```

`Router::cancel` and `Tools::cancel` are required by panic and stop (`06-agents.md`). `AuditLog`
is the append-only signed chain; the SQLite owner may implement it beside `ThreadLog` and
`BrainStore` without merging those ports.

Port rules:

- Use generic parameters (`T: Port` or `impl Port`) inside policy. The initial ports are statically
  dispatched and are not required to support `dyn Port`. Axum and Tauri receive a concrete
  production application type or a cloneable command handle.
- Do not create a `Clock` trait. Skins read the clock once and pass `Timestamp`.
- Do not wrap a pure function in a trait.
- Add a method only for a current caller and its deterministic fake; do not design speculative
  CRUD APIs.
- Prefer borrowed `&str`, slices, and `&T` for immutable inputs. Return owned values when data must
  cross an async or task boundary.
- Do not expose database transactions, HTTP clients, mutex guards, browser handles, or filesystem
  handles through ports.
- Do not add mode booleans. Use closed enums such as `UseSource`, `ThreadRun`, `NoteRegion`, and
  `ToolRequest`.
- Keep in-workspace enums exhaustive. They are application APIs under one team's control and do
  not receive `#[non_exhaustive]`.
- Add standard trait implementations and derives only when a caller needs them.

`BrainStore` is separate from `ThreadLog`: combining shared-brain persistence with ordered thread
events would give one interface two unrelated reasons to change. The concrete SQLite owner may
implement both traits and preserve cross-port atomicity through a single explicit database command
used by orchestration.

## Domain types

Semantically distinct identifiers are newtypes, including at least `ThreadId`, `AgentId`,
`EpisodeId`, `FactId`, `SlotId`, `PresentationId`, and `VaultPath`. Numeric values with invariants,
including `Activation` and positive budgets, are validated newtypes rather than aliases. Decay
is an `f64` (default `0.5`) on `RankPolicy`, not a newtype.

Structs with more than one field use named fields. Options structs implement `Default` only when a
real default state exists. Constructors are `new`, `new_with_*`, or `try_new` according to the
Google guide. Important `From` implementations have an equally discoverable inherent constructor.

`ToolRequest`, `UseSource`, `ThreadRun`, and `NoteRegion` are closed enums. No boolean chooses a
mode.

## Ownership and concurrency

- `main` uniquely owns startup resources until it moves them into `Application`.
- The SQLite connection is opened and owned by one Tokio task. Callers use a bounded `mpsc`
  command channel; response-bearing commands use `oneshot` replies. Queue saturation is
  backpressure, not a reason to spawn another connection owner.
- Each running thread has at most one loop task. The scheduler owns a registry of join handles and
  cancellation handles keyed by `ThreadId`. Starting an already-running thread is idempotent.
- Global panic control cancels all run-loop tokens and prevents new scheduling while the latch is
  set. Clearing the latch resumes no thread. Cancellation is observed between router and tool turns and before every durable
  conversational or memory mutation. Audit and outcome records required to describe cancellation
  or an already-started external action still append after panic; they cannot start another action.
- A tool supervisor owns subprocess and browser handles. A thread receives a capability handle,
  not direct shared ownership of those resources.
- Prefer moves and borrows. Deep `clone` is used only when ownership must cross a task boundary and
  the copy is intentional.
- Avoid `Rc` and `Arc`. `Arc` is allowed only for immutable application state or a thread-safe
  client that must be shared with a framework; its use requires a short comment explaining why
  unique ownership or a channel is less clear.
- Do not put mutable domain state behind `Arc<Mutex<_>>`. Send commands to its owner task.
- If a mutex is unavoidable in third-party integration glue, poisoning is propagated as an error;
  code never recovers the inner value from a poisoned mutex.
- CPU-heavy embedding or graph work must not block Tokio workers. The owning skin may use a
  bounded blocking executor and await its result. Pure leaves remain runtime-independent.
- Maia does not use `std::thread::spawn` for ordinary concurrency. This is a local ownership
  decision, not adoption of the Chrome-only rule.

## Error policy

- `Option<T>` represents an expected absence whose cause is obvious, such as a missing optional
  frontmatter field. Empty activation presentations are `Err(ActivationError::NoPresentations)`.
- `Result<T, E>` represents recoverable parse, validation, I/O, database, network, model, process,
  cancellation, conflict, and protocol failures.
- Each port has a narrow typed error. Adapters retain useful source errors without leaking
  third-party request or client types into `maia-core`.
- Hooks translate errors once: API errors become stable status/code/message responses, while
  startup errors reach `main` with their source chain intact.
- A stale `ThreadVersion` is a typed conflict. It is never silently retried because retrying may
  duplicate a model or tool side effect.
- Tool uncertainty is explicit. A timed-out tool whose side effect is unknown returns an
  `OutcomeUnknown` variant and is not automatically retried.
- Panics are reserved for programmer bugs and violated internal invariants. User input and
  external failures never panic.
- Prefer pattern matching to check-then-unwrap. Production code does not use `unwrap`.
- `expect` is permitted only when an invariant cannot be expressed in the type system and the
  message explains why the invariant must hold. It is not an I/O error strategy.
- Assertions include context when the condition alone would not explain the failure.
- Do not use `panic::catch_unwind`.
- A background-task error is observed, recorded in the immutable audit, and mapped to
  `Sleeping`, `NeedsHuman`, or `Stopped` according to its typed category. It is never discarded.

## Style and lint contract

The workspace targets stable Rust, edition 2024. Unstable language and library features are
prohibited.

When configuration is added after design approval, rustfmt must enforce:

- `edition = "2024"`;
- `max_width = 100`;
- standard rustfmt layout everywhere except generated code or a documented alignment case;
- module-granularity imports when that rustfmt option is available on stable.

The Google guide permits omitting rustfmt options unavailable on the selected stable toolchain.
Until stable rustfmt supports them, lowercase hexadecimal literals, formatted macro matchers, and
module-granularity imports are review rules rather than a reason to require nightly rustfmt.

Imports and modules follow these rules:

- no glob imports except `use super::*` in a small inline test module or an enum-variant import
  inside a function primarily handling that enum;
- each `use` group imports items from one module;
- import types and traits, then use their names unqualified;
- import a module and qualify top-level free-function calls with the module name;
- import traits inside a function unless their methods are used throughout the file;
- non-leaf modules contain module declarations and re-exports, with only minimal wiring;
- a leaf module with one primary type is named after that type;
- no project prelude.

All crates except `maia-win32` use `#![forbid(unsafe_code)]`; `maia-win32` uses
`#![deny(unsafe_op_in_unsafe_fn)]` with a `// SAFETY:` comment on every block. `maia-core` uses `#![deny(missing_docs)]`; other crates
deny missing docs on their public API and may keep implementation modules crate-private. Public
docs state meaningful invariants, errors, and panic conditions rather than repeating names.

The required lint run is:

```text
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

The workspace enables Clippy's default `all` group and the following style-relevant lints where
they are not already enabled: `borrowed_box`, `ptr_arg`, `should_implement_trait`,
`new_without_default`, `len_without_is_empty`, `wrong_self_convention`, `unwrap_used`,
`panic_in_result_fn`, and `await_holding_lock`. Pedantic lints are enabled individually, not as a
blanket group, so lint policy remains intentional and stable.

Additional source rules:

- prefer regular functions, types, and traits over macros;
- use derives instead of manual implementations where equivalent;
- use `format!` or `write!` for substitution and concatenating more than two strings;
- use direct loops instead of long or stateful iterator chains;
- annotate inferred types when a generic conversion, parse, or complex chain would be unclear;
- do not access third-party `#[doc(hidden)]` items;
- do not overload operators for non-mathematical behavior;
- use `#[must_use]` on pure-return values when ignoring them would be incorrect.

## Testing strategy

Implementation follows red-green-refactor. No production function listed in this document is
added before a failing contract test names its invariant.

### Pure unit tests in `maia-core`

- `activation` uses hand-computed weighted ACT-R fixtures, including full, half, empty, and time
  boundary cases.
- `rank_paths` uses small explicit graphs and injected vectors with independently calculated
  PageRank and final ordering.
- `attribute_uses` proves that absent slots receive no credit, rejection scores zero, reasoning and
  tool hits score full weight, and reply-only hits score half.
- `compile_prompt` uses byte fixtures, stable IDs, fixed participant order, scratch-suffix
  exclusion, and a restart-equivalent replay.
- `should_compact` has one table-driven case per trigger and boundary.
- render tests compare bytes and prove the human entity region, including whitespace and line
  endings, is unchanged.
- dream pre-pass tests use explicit duplicate and contradiction fixtures and never call a model.

Pure tests use `#[test]`; async policy tests use `#[tokio::test]`. Assertions include context when
the fixture name alone is insufficient.

### Port contract tests

Reusable contract suites run against both each deterministic fake and its real adapter:

- `ThreadLog`: append ordering, optimistic-version conflict, replay identity, and restart.
- `BrainStore`: ledger atomicity, negative marks, validity closure, and transaction rollback.
- `VaultStore`: path confinement, map/body separation, atomic replacement, and preservation of
  human regions.
- `Router`: request translation, readable/opaque reasoning cases, tool calls, cached-token counts,
  malformed responses, and timeout classification.
- `Embedder`: output cardinality, dimensional validation, deterministic fake vectors, and bounded
  batching.
- `Tools`: audit outcomes, timeout uncertainty, cancellation, auth automation then
  challenge-to-`NeedsHuman`, Scrapy route, and no
  automatic retry.

SQLite tests use a temporary on-disk database when restart or WAL behavior matters; `:memory:` is
used only when persistence semantics are irrelevant. Vault tests use a temporary directory and
compare raw bytes.

### Integration tests

- A scripted router, fake tools, temporary vault, and real SQLite adapter prove one complete turn:
  compile, route, attribute, execute, append, and replay.
- Restart tests create a new application over the same database and assert byte-identical compiled
  prefixes.
- Promotion tests prove one episode yields one scripted call, one brain transaction applies claims
  and mention edges, and the runner cannot obtain a tools handle.
- Dream tests prove one transaction applies model output and generated files while preserving the
  human region byte-for-byte; the test dream cannot obtain a tools handle.
- Scheduler tests inject `Timestamp`, budgets, and deterministic ports to prove state transitions,
  idempotent wake-up, cancellation, and panic behavior.
- API hook tests assert transport validation and error mapping without duplicating policy tests.

No test uses live router, internet, Chrome login, wall-clock sleeps, or a developer's vault. A
separate ignored smoke suite may exercise explicitly configured local adapters, but it is not a
substitute for deterministic CI.

## Explicitly out of scope

This document does not:

- implement crates, Cargo manifests, rustfmt, Clippy, CI, migrations, or source code;
- choose concrete database, HTTP, embedding, ConPTY, browser, or Tauri libraries;
- define SQL tables, wire JSON, HTTP routes, UI components, or frontend state;
- specify retrieval constants, dream thresholds, budgets, or model defaults beyond requiring them
  to be explicit inputs or configuration;
- define vault syntax, ranking mathematics, prompt byte layout, attribution semantics, dream
  extraction schema, scheduler product behavior, or tool UX beyond the Rust boundaries needed to
  preserve their existing design invariants;
- introduce plugin APIs, dynamic loading, public third-party SDK stability, or cross-team
  compatibility guarantees;
- permit remote brain, shell, browser, database, or embedder execution;
- add a general service locator, dependency-injection framework, global singleton, clock trait, or
  trait around a pure function;
- make promotion or dreams capable of shell, browser, Scrapy, or api-anything access;
- adopt Chrome's build layout, Chrome's ban on async Rust, Chrome's test framework, or Fuchsia's
  mutex requirement.

## Resolved plan contradictions

The source plan names `ThreadLog`, `Router`, `Embedder`, `VaultStore`, and `Tools` as ports, but it
also requires independently testable shared-brain persistence. Making `ThreadLog` responsible for
both thread events and the brain would violate interface segregation and obscure atomicity.
This document adds the narrow `BrainStore` port while allowing one SQLite owner to implement both.

The source plan requires a local embedder skin and an `Embedder` port but assigns no crate to the
concrete implementation. This document adds `crates/maia-embedder/`. Folding it into
`maia-router`, `maia-store`, or `maia-daemon` would mix unrelated reasons to change.

The source plan requires module-granularity imports and other Google rustfmt choices while also
following the stable, no-unstable-features rule. Some rustfmt options may be unstable on the
selected toolchain. This document resolves that tension by requiring stable rustfmt and treating
unsupported formatter options as review rules, exactly as the Google guide permits.
