# Design review — Grok 4.7

Reviewed 2026-11-04 against `docs/design/00-goal.md` through `11-secrets.md`, `REVIEW.md`, and the locked plan (Maia agent OS). No other design doc was edited. No code was written.

## Verdict

**Accept with changes.**

The set agrees on the product shape: one desktop daemon, one shared brain, one durable cache per thread, one presentation ledger, algorithmic recall, dreams that do not receive tools, human regions preserved byte-for-byte, and a phone that is only a window. Those invariants are stated often enough, and in enough of the same words, that they can survive implementation.

Implementation is not justified yet. Three join points are specified in a way that cannot be built without inventing behavior the review would then have to re-litigate: recalled facts have nowhere to sit in the prompt, untrusted origin never becomes a fact field, and high-impact grants have no state or screen. Several named red tests in `00-goal.md` (Testing contract) also lack a single oracle. Fix the documents, then accept. Do not start the workspace until that revision is recorded.

## Counts

| Severity | Count |
| --- | ---: |
| Critical | 3 |
| Important | 16 |
| Minor | 8 |
| **Total** | **27** |

## What already holds

- **Goal.** Vault map/read, ranked recall, the durable prefix, dream batching, the inspector, budgets, and the computer boundary each serve shorter prompts, inspectable recall, or controlled computer use. The Rust doc adds no product surface. Secrets and the threat model are what make computer use admissible.
- **One brain, one cache, one ledger.** `00-goal.md` (System invariants), `02-brain.md` (Ownership and storage boundary), `03-thread-cache.md` (Ownership and identity), `04-credit.md` (Purpose), and `06-agents.md` (Thread and participant model) agree. An agent-agent thread is one `ThreadId` and one log.
- **Dreams and human bytes.** `05-dream.md` (Invariants) and `08-rust.md` (`run_dream`) give the dream runner router, brain, and vault access and no `Tools` parameter. `01-vault.md` (Human and generated regions) defines the human slice as raw bytes between literal markers. `personality.md` is excluded.
- **Secrets UI.** `09-frontend.md` (Settings) and `11-secrets.md` (Grants and UI) agree: values are write-only, the phone may list labels and revoke grants, and it may not create, rotate, or reveal values.
- **Tailscale.** `07-computer.md` (Localhost and Tailscale boundary) is fail-closed: no wildcard bind, no cleartext tailnet, `WhoIs` allowlist, peer-bound session, CSRF, exact Origin, authenticated panic.
- **Challenges.** Captcha, MFA, and bot-check bypass are refused in `00-goal.md`, `06-agents.md`, `07-computer.md`, and `10-security.md`.
- **Two-phase dream apply.** Brain commit, then idempotent vault projection with no second model call, is consistent across `00-goal.md` (Failure handling), `01-vault.md` (Dream projection contract), and `05-dream.md` (Transaction sequence).

## Goal alignment

| System | Serves the goal? | Note |
| --- | --- | --- |
| Vault (`01`) | Yes | `map` keeps bodies out of navigation. |
| Brain (`02`) | Yes, once joined to the prompt | Ranking is model-free. See C1. |
| Thread cache (`03`) | Yes | Prefix stability is the token win. |
| Credit (`04`) | Yes | Makes strength and compaction inspectable. |
| Dream (`05`) | Yes | Moves organization off the message path. |
| Agents (`06`) | Yes | Budgets, panic, and audit bound unattended work. |
| Computer (`07`) | Yes | API-first, no challenge solving, desktop-only tools. |
| Rust (`08`) | Not a product system | Dependency direction matches the honesty rules. |
| Frontend (`09`) | Yes | Transcript stays primary; evidence stays beside it. |
| Security (`10`) | Yes, but not yet joinable | See C2 and C3. |
| Secrets (`11`) | Yes | Containment matches the computer-use goal. |

## Named red tests in `00-goal.md`

| Test named in Testing contract | Writable from the docs alone? |
| --- | --- |
| `compile_prompt` byte-identical across restart | Property test yes. Independent expected bytes no, until the canonical grammar exists (I3). |
| Attribution ignores slots absent from the request | Yes. |
| Reply-only match is half weight only with no readable reasoning | The weight rule is yes. What counts as a match is no (I5). |
| Weighted ACT-R matches a hand-computed fixture | The formula is yes. A unique numeric oracle is no, until the age unit is a parameter (I2). |
| `map` returns descriptions and links, never bodies | Yes. |
| `render_entity_page` preserves the human region | Yes, including the malformed-marker failure. |
| Dream apply is atomic, projection is idempotent, neither phase calls tools | Largely yes. Embeddings, panic, and a tool-call side channel are open (I10). |
| Budgets and human challenges produce the specified states | Budgets yes. `NeedsHuman` entry differs between docs (I7, I15). |
| Desktop and phone address the same daemon and thread ids | Yes at the network boundary. Desktop webview origin is open (I14). |

## Critical

### C1. Recalled facts never enter the prompt, and installation requires a prior use

`00-goal.md` (Product sequence) step 3 retrieves from the brain, then step 4 calls the router. `02-brain.md` (Retrieval algorithm) returns ranked facts. `03-thread-cache.md` (Canonical byte order) and the locked plan list only tool schemas, the `agents.md` excerpt, personas, the compacted block, the transcript, the current message, and a scratch suffix of **paths**. There is no retrieval block, and scratch is not allowed to hold fact text.

`03-thread-cache.md` (Installed memory note) then says a confirmed memory note is inserted only after the assistant turn that used it. `04-credit.md` (Evidence boundary) awards a presentation only to a slot that was already in that request. A fact cannot be used until it is a slot, and it cannot become a slot until it has been used.

Until this cycle is broken, recall cannot shorten prompts, compaction has nothing honest to compact, and the inspector's "facts installed" control has no producer. The restart test can still pass on an empty memory block, which would hide the hole.

**Change.** Specify one non-durable recall suffix (or an equivalent region) that `compile_prompt` excludes from the prefix hash, that `append_scratch` or a sibling pure function appends, and that attribution may credit. State the rule that promotes a credited recall item into a durable note at the cursor after that assistant turn. State what the first load stores (summary versus full episode text) and who is allowed to write that summary.

### C2. Taint and quarantine are not part of the fact, dream, or rank contracts

`10-security.md` (Memory and dream poisoning, Taint and provenance) says every fact keeps origin, untrusted origin cannot widen grants, and high-severity detections freeze facts out of retrieval. `02-brain.md` (Fact) lists sentence, validity, episode id, embedding, lexemes, presentations, and corrections, and no origin. `05-dream.md` (Structured dream batch schema) facts have id, entity, sentence, and episode ids, and no origin. `rank_paths` in `02-brain.md` (Public contracts) takes the graph, query, time, and rank policy, and no quarantine set.

Episodes include tool results and web text (`02-brain.md`, Episode; `05-dream.md`, Inputs and pure pre-pass). A dream can therefore promote injected page text into a current fact that later walks back into prompts, with no field a test can assert. `04-credit.md` (Correction mark) does not reduce activation; a poisoned fact stays strong until a dream closes it, and nothing in `02-brain.md` (Retrieval algorithm) drops it earlier.

**Change.** Add a closed origin to the fact record and the dream schema, derived from source episodes, never from the model. Pass quarantine as an explicit rank input. State that a negative correction mark either compensates activation immediately or quarantines the fact until the dream commits.

### C3. Tools start with no grant, and nothing can approve a grant

`10-security.md` (Capability grants, Sink checks) starts tools at no capability and defaults unattended `Execute`, `WriteRemote`, and `CredentialUse` to `ConfirmEveryTime`. External content may raise that tier and may not lower it. `06-agents.md` (Purpose and authority, Four-state model) allows any running thread to call tools while the person is away, and its `ThreadRun` / `HumanRequest` path has no approval-waiting state. `07-computer.md` (`ToolRequest`, Login walls) has console and web outcomes only. `09-frontend.md` (Settings) shows secret grants and no capability grants, and no confirm dialog.

A fail-closed reading never runs an unattended shell, because nobody can confirm and the default grant set is empty. A permissive reading ignores `10-security.md`. The computer-use goal is not implementable from the set as written. `ConsoleRequest.command` is also a free string (`07-computer.md`, Windows console sessions), so an `Execute` grant, once it exists, is unrestricted PowerShell unless a target constraint is added.

**Change.** Add a persisted grant catalog, a `NeedsHuman` kind for approval, and a desktop confirm surface. Define the unattended default as either a user-created allowlist that may run while away, or a hard stop into `NeedsHuman`. Name the shell target that a grant actually covers (executable, directory, or both).

## Important

### I1. Core signatures disagree, and the joint ledger has no single port

`02-brain.md` (Public contracts) defines `activation(..., decay: f64) -> Result<f64, ActivationError>` and `rank_paths(...) -> Result<Vec<RankedPath>, RankError>`. `08-rust.md` (Honest leaves) defines `activation(...) -> Option<Activation>` and `rank_paths(...) -> Vec<RankedFact>`. The second form cannot report a non-finite decay, drops walked paths the inspector requires (`02-brain.md`, Observability), and treats every failure as an empty ranking.

`04-credit.md` (Public contracts) defines `attribute_uses(scope) -> Result<AttributionLedger, AttributionError>`, including an unattributable turn when reasoning availability is unknown. `08-rust.md` defines `attribute_uses(slots, trace) -> Vec<AttributedUse>`, which cannot distinguish "no hits" from "do not score this turn."

`04-credit.md` (Public contracts, `apply_ledger`) commits thread heat and brain presentations together. `08-rust.md` (Dependency-inversion port rules) puts `apply_ledger` only on `BrainStore` and says cross-port atomicity is "a single explicit database command," without naming that command. The atomicity test in `04-credit.md` (Testing contract) has no port to call.

**Change.** Pick one signature set, put it in `08-rust.md`, and make `02` and `04` match it. Add one database-owner command whose success commits heat, presentations, co-use edges, and negative marks together.

### I2. The ACT-R fixture has no time unit

`02-brain.md` (Public contracts) fixes `B_i = ln(Σ_j w_j * t_j^(-d))` and then, in Explicitly out of scope, leaves the elapsed-time unit unset. `activation` does not take a unit. Ages in milliseconds and ages in seconds both satisfy the prose and disagree on every hand-computed value. Empty presentations correctly avoid `ln(0)`, but that special case is attached to a different return type in `08-rust.md` (see I1).

**Change.** Define the age unit as a parameter of the call, or define `Timestamp` subtraction as one named unit, and put that unit in the fixture contract.

### I3. Prefix canonicalization is required and not defined

`03-thread-cache.md` (Slot) says canonicalization must define separators, line endings, encodings, labels, id rendering, and empty sections. It never defines them. Replay identity is still a meaningful property test. An independent byte oracle, which `00-goal.md` (Testing contract) asks for, is not derivable. `agents.md` "excerpt" (`03-thread-cache.md`, Canonical byte order) is similarly unnamed; storing whatever excerpt was chosen inside the log preserves replay, but two readers cannot predict the bytes.

**Change.** Specify the byte grammar for every slot kind, including the empty compacted block and the agent-agent speaker line, as fixture text.

### I4. Compaction triggers do not determine survivors

`03-thread-cache.md` (Compaction triggers and behavior) names centroid drift for two turns, six turns without a use-hit, and prefix budget. It does not define the centroid (which embedding, which turns, which distance), and `compact` "chooses the survivors required by the supplied decision" without a survivor rule. A second load "appends the full text" (`Installed memory note`) without defining when a load occurs. `00-goal.md` (Documentation-gate acceptance checklist) requires these rules to be tight enough to test.

**Change.** Define the distance input, the survivor predicate per trigger, and the second-load event. Keep numeric thresholds as policy arguments.

### I5. Half-weight tests depend on a matcher the docs refuse to specify

`04-credit.md` (Weight rules) locks 1, 0.5, and 0. `04-credit.md` (Explicitly out of scope) leaves text alignment and correction classification unspecified. `00-goal.md` (Testing contract) still requires a reply-only hit to score half. "Hit" has no acceptance boundary, so a substring fixture and a paraphrase fixture are both compatible with the doc.

**Change.** Lock a minimum deterministic matcher for the red tests (for example exact canonical substring, with rejection as an explicit supplied span). A richer matcher may follow only if it preserves those fixtures.

### I6. Shared selection is `FactId`, and many slots are not facts

`00-goal.md` (System invariants) and `09-frontend.md` (Information architecture) say one `FactId` drives cache, brain, and trace. `03-thread-cache.md` (Canonical byte order) also has constitution, persona, transcript, and compacted slots. `09-frontend.md` (Conversation) selects "those facts" from a count button, but selection is a single id. `04-credit.md` (Presentation ledger) records a "fact or slot identity" and always writes the shared brain. A persona hit has no fact to update, and a constitution click has no `FactId` to share.

**Change.** Define selection as `FactId` or `SlotId`, state which non-fact slots are heat-only, and define the multi-fact install click as a set, not one id.

### I7. `NeedsHuman` copy is only true for a Chrome sign-in

`09-frontend.md` (NeedsHuman) requires the banner to name the blocker and the device, then shows one string: Chrome waiting for a sign-in on this computer. The phone string is "Finish this on the desktop." `07-computer.md` (`HumanRequestKind`) also includes MFA, captcha, bot check, legal consent, and ambiguous external outcome. `11-secrets.md` (Lock state) uses `NeedsHuman` when the secret store is locked. Those are not a sign-in challenge, and a locked secret is not resolved by looking at Chrome. The sample banner offers Stop and not the Resume control `07-computer.md` (Login walls) requires. The composer is disabled, so chat cannot substitute for Resume.

**Change.** Specify kind-specific desktop and phone copy, always name the desktop as the place of action, and keep Resume visible for kinds the human can complete.

### I8. Stop all does not match the panic latch

`06-agents.md` (Panic and stopping) makes panic a durable latch: every `Running`, `Sleeping`, and `NeedsHuman` thread becomes `Stopped`, and clearing the latch does not resume anyone. `08-rust.md` (Ownership and concurrency) says panic blocks scheduling "until explicitly resumed," which reads as if clearing the latch continues work. `09-frontend.md` (Agent rail, Invariant) has `Stop all` with no confirm, no latched state, and no clear-latch control, while the header still offers Resume. After the only global stop, either Resume is a lie or the latch is ignored.

**Change.** State that `Stop all` engages the latch. Add a visible latched state and an explicit clear that still leaves each thread `Stopped` until its own Resume.

### I9. Tool-result matches award full credit for untrusted echoes

`04-credit.md` (Weight rules, Attribution sequence) gives a tool-result match weight 1, in the same class as reasoning the model produced. Tool results and web extracts are untrusted data (`10-security.md`, Prompt injection). A page or command that echoes prompt facts marks those facts used, thickens co-use edges by `min(weight_a, weight_b)`, and raises ACT-R. That is a memory-poisoning path with a specified weight.

**Change.** Credit tool results only as evidence of model-authored arguments, or require the match to appear in reasoning or the reply before a tool result can confirm it. Keep result-only matches at zero unless a later design gives them a separate, inspectable class.

### I10. The dream runner is not closed against panic, tools, or the embedder

`05-dream.md` (Transaction sequence) makes one structured call and applies it in one database transaction. It does not say what panic does to that call or to the following projection. `06-agents.md` (Panic and stopping) stops "every loop" and does not mention the dream. `08-rust.md` (`run_dream`) also takes `ThreadLog`, so the runner can append thread events the dream chapter never allows. `Router::complete` can return `tool_calls`; `05-dream.md` (Structured dream batch schema) rejects unknown JSON fields and does not say a tool-call channel is a hard failure with an empty tool list. New fact vectors are required by `02-brain.md` (Fact) and the dream signature includes `Embedder`, but the transaction steps never say when embedding runs. Doing it inside the SQLite transaction holds the database owner; doing it later leaves current facts unranked with no job defined.

**Change.** Panic cancels dream admission and the model call, and still allows an already committed projection to finish. Remove `ThreadLog` or make it a read-only port with no `append`. Send `tools: []` and fail the batch on any tool call. Embed after commit, idempotently, without a second extraction call.

### I11. Contradictions are both automatic and optional, and identity echo can reject a good batch

`05-dream.md` (Invariants) says a newer fact closes the older contradictory fact. `05-dream.md` (Transaction sequence) only applies closures present in the model payload. The pre-pass proposes candidates and does not write. Nothing in validation says a contradiction without a closure is an invalid batch, so both current facts can remain.

The same chapter (Transaction sequence, step 5) requires an existing entity's description, links, slug, and scope to match exactly or the whole response is stale. A one-character description drift then drops every fact in the batch.

**Change.** State that missing closures on pre-pass contradictions fail the batch (or are applied by deterministic rule, not by the model). Validate fact operations independently of an exact metadata echo, and keep the ban on silent renames.

### I12. Agent identity and the vault folder are different namespaces

`06-agents.md` (Thread and participant model) uses an immutable `AgentId` whose canonical bytes order personas. `01-vault.md` (Purpose) uses `agents/<agent>/`. `05-dream.md` (Structured dream batch schema) uses `agent_id` values such as `agent_scout` and projects to `agents/<agent>/entities/<slug>.md`. No document maps `AgentId` to a vault folder. Private-entity retrieval (`01-vault.md`, Invariants; `05-dream.md`, Testing contract) cannot be tested until that map is a pure function.

**Change.** Specify the map, require it to be unique and stable, and reject a dream scope whose agent does not resolve.

### I13. The 720 px layout cannot meet its own minimums

`09-frontend.md` (Desktop placement) keeps a 248 px agent rail from 720 px up and requires the conversation to stay at least 480 px. 248 + 480 = 728, which is already wider than the 720 px breakpoint. The 900×800 acceptance check still fits; the breakpoint rule does not.

**Change.** Lower the rail at that width, lower the conversation floor, or start the overlay earlier. Recompute the acceptance widths from the same numbers.

### I14. Desktop origin is not on the Origin allowlist

`07-computer.md` (Browser session and request protections) allows Origins only from loopback and Tailscale listener addresses. `08-rust.md` (`maia-daemon`) and `09-frontend.md` (Purpose) put the desktop UI in a Tauri webview. A `tauri://` or `tauri.localhost` origin would fail the exact-Origin check and lock the desktop out of panic, send, and settings. Cookie `Secure` is specified for the tailnet, not for how the webview stores the loopback session.

**Change.** Name the desktop origin, include it in the allowlist generator, and state the loopback cookie attributes.

### I15. Unknown tool outcomes do not share one next state

`07-computer.md` (Web intent and API-first policy) sends an unknown write to `NeedsHuman` and forbids browser fallback. `06-agents.md` (Failure modes) enters `NeedsHuman` only "when duplicate execution could cause harm," which is not a closed predicate. A read whose contract allows repetition may fall back (`07-computer.md`); the scheduler text does not say that.

**Change.** Use `AttemptOutcome` as the only input to the next `ThreadRun`: unknown write, `NeedsHuman`; unknown read, the contract's retry rule; never a harm judgment inside the reducer.

### I16. A broken audit chain can disable panic

`06-agents.md` (Failure modes) says audit verification failure disables unattended work and "panic mutations." If that includes engaging panic, a damaged log removes the stop control. `10-security.md` (Invariants) says panic stays reachable.

**Change.** Verification failure blocks new runs and blocks clearing panic. Engaging panic remains allowed and is itself audited as far as the chain still accepts appends.

### I17. The human-region end marker can truncate notes

`01-vault.md` (Human and generated regions) defines the human region as the bytes before the first `<!-- maia:human:end -->`. The testing contract covers marker-like text outside marker lines, not the same byte sequence inside the region. A later render can treat the note as a shorter human region and drop the tail, or fail closed. Which one happens is unstated. Silent truncation violates the byte-preservation invariant.

**Change.** If either end marker occurs inside a region, fail the write and leave the file untouched.

### I18. The router must authenticate without a per-request resolve

`11-secrets.md` (Invariants) says router code paths have no `SecretStore::resolve`. `07-computer.md` (Router protocol) says router authentication comes from an injected secret provider. Both can be true only if something outside `maia-router` resolves `RouterApiKey` once and the router client never sees `SecretStore`. That path is not written, so an implementer either breaks containment or cannot call the API. `11-secrets.md` also names `keyring-core` and `windows-native-keyring-store`, while `08-rust.md` (Explicitly out of scope) says this gate does not choose libraries.

**Change.** State one-shot resolve in the composition root, a client that cannot resolve again, and leave concrete crate names out of the contract.

## Minor

### M1. MCP appears only as a threat

`10-security.md` (Assets and trust boundaries) lists MCP and tool metadata. `07-computer.md` (`ToolRequest`, Explicitly out of scope) has console and web only, and excludes arbitrary sidecar plugins. Either drop MCP from this gate or add a closed tool variant and a grant target.

### M2. Empty reasoning is not the same as missing reasoning

`07-computer.md` (Normalized response) uses `reasoning: Option<String>`. `04-credit.md` (Weight rules) switches on "no readable reasoning." `Some("")` can be read either way and would change half-weight eligibility.

**Change.** Treat missing and blank reasoning as no readable reasoning.

### M3. `forbid(unsafe_code)` has no Win32 boundary

`08-rust.md` (Invariants) forbids unsafe in every workspace crate. `07-computer.md` (Windows console sessions, Persistent Chrome) needs ConPTY, Job Objects, and a profile lock. That is viable only through safe dependency wrappers, which the design never names. State that first-party crates stay safe and name the wrapper boundary, so the console work does not grow an unreviewed `unsafe` exception.

### M4. Inspector resize can break the conversation floor

`09-frontend.md` (Desktop placement) allows the inspector to grow to 480 px while the conversation must stay at least 480 and the rail stays 248. That sum is 1208 px. Between the 1100 px three-pane breakpoint and 1208 px, the maximum resize is impossible. Cap the inspector by the conversation floor.

### M5. The brain graph omits episode nodes

`02-brain.md` (Data model, Observability) makes episodes graph nodes and says a new episode is visible before any dream. `09-frontend.md` (Brain, Empty and error states) draws facts and lexemes and, with no facts, says only that the dream has not run. The empty graph should show that episodes are already searchable, including a way to select an episode node.

### M6. Dream timing knobs are easy to confuse

`05-dream.md` (Purpose) wakes at 20 pending episodes and selects oldest-first up to "the configured batch size." It is unclear whether those are one setting. "Idle for 30 minutes" does not say whether any running thread counts as busy. Name the two integers if they differ, and define idle as no router or tool call in progress.

### M7. Phone stop is not one action when every thread is asleep

`09-frontend.md` (Invariant) says global stop is one action on the phone. `09-frontend.md` (Phone placement) shows `Stop all` above the composer only while a thread is running; otherwise it is inside the agent drawer. That matches the locked plan's running-bar rule and contradicts the one-action invariant. Qualify the invariant: one action while any thread is `Running` or `NeedsHuman`; otherwise the drawer control.

### M8. Cloud Infisical is a trust boundary in only one doc

`11-secrets.md` (Design choice, Infisical adapter) allows an explicit cloud project. `10-security.md` (Assets and trust boundaries) does not list that host. Add it, and keep the default backend on the local machine.

## Security and frontend checklist

| `REVIEW.md` item | Result |
| --- | --- |
| Prompt injection | Layering is right (data blocks, closed tool enum, `authorize_tool`). It is not enforceable until C2 and I9 are fixed. Plan-drift "divergence" (`10-security.md`, Prompt injection) is also not a predicate; do not treat it as a control until it is. |
| Excessive agency | API-first, no challenge solving, budgets, and outcome-unknown writes are sound. Unattended execution contradicts empty grants (C3). |
| Supply chain | Lockfiles, `forbid(unsafe)`, signed policy packs that cannot widen grants, and hashed sidecars are specified (`10-security.md`, Supply chain). M3 is the remaining local hole. |
| Secrets containment | Strong, and aligned with the write-only UI, except the router injection path (I18). |
| Tailscale and auth | Specified fail-closed in `07-computer.md`, except the desktop webview origin (I14) and panic-versus-audit (I16). |
| Panic reachability | Desktop footer is always reachable. Phone reachability and latch semantics need I8 and M7. |
| `NeedsHuman` truthfulness | Device is the desktop. Reason text is not truthful for every kind (I7). |
| Secrets write-only UI | Holds. |

## Required before acceptance

1. Specify the recall suffix and the install-after-credit rule (C1).
2. Put origin and quarantine on facts, dream output, and rank inputs (C2).
3. Specify grant storage, the unattended default, and the approval state and screen (C3).
4. Unify leaf signatures and the ledger command (I1), the ACT-R time unit (I2), the prefix grammar (I3), compaction survivors (I4), and the matcher used by the red tests (I5).
5. Align panic, `NeedsHuman`, dream cancellation, and the desktop origin with the screens that must show them (I7, I8, I10, I14).

After those edits, the existing red tests in `00-goal.md` (Testing contract) are sufficient to start the vault and activation work. No crate should be created on this review alone.
