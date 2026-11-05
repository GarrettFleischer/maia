# Design re-review, round 2 — Claude Opus 5.5

Reviewed 2026-11-04 against `00-goal.md` through `11-secrets.md`, `REVIEW.md`,
`REVIEW-grok-4.7.md`, and the round-1 report `REVIEW-claude-opus-5.5.md`. This pass checks each
critical fix that `REVIEW.md` claims against every document the fix touches, then lists what
remains. No other document was edited, no code was written, and nothing was committed.

`10-security.md` and `11-secrets.md` differ substantially from the versions round 1 cited. For
example, 10 no longer defines `ToolKind`, `RiskClass`, or `ConfirmEveryTime`, and 11 no longer
has `SiteLogin` or Infisical. `REVIEW.md`'s fix table mentions neither rewrite. This review treats
the current files as authoritative.

## Verdict

**Reject. The seven critical fixes hold in substance. Two new Critical findings and a security
layer that the other documents have not caught up with keep the set from passing the gate.**

The architecture stays. Every round-1 Critical now has a written mechanism that a test can target:

- a recall block, with an install rule;
- a byte grammar and a mapping to the wire;
- compaction that is model-free and touches only memory;
- a complete tool enum;
- OS containment, with a conformance suite;
- a per-launch desktop secret, with user presence;
- approvals bound to a digest that never approve themselves.

The set still fails two gate items.

1. **Consistency.** `10-security.md` now carries most of the security design, but `06`, `07`,
   `08`, `09`, and `11` were not reconciled with it. `REVIEW.md` records no decision on any of
   10's 24 consistency findings. Fact taint is defined twice, incompatibly (R2-C1).
2. **Correctness.** The fix for "contradictions are both automatic and optional" now forces the
   dream model to close a fact for every pre-pass candidate. One false positive therefore either
   stalls dreaming or deletes a true fact (R2-C2). The wire form also contradicts its own cache
   guarantee (R2-I1).

Neither Critical needs an architecture change. The next review can be limited to the changes
listed under "Required before the next review."

## Counts

| Severity | Count |
| --- | ---: |
| Critical | 2 |
| Important | 25 (12 new or residual, 13 carried from round 1) |
| Minor | 16 new (open round-1 Minors are listed, not recounted) |
| **Total** | **43** |

## Verification of the merged critical fixes

| ID | Where the fix now lives | Result | What remains |
| --- | --- | --- | --- |
| C1 recall | `03` (Recall block, Installed memory note, Request sequence); `04` (Request attribution scope); `00` (Product sequence) | **Resolved.** 00, 03, and 04 agree on one loop: retrieve, present, credit, install. "Confirmed" means weight above zero. A load is an explicit action, and no model writes a summary on the message path. | Recall has no budget, no dedupe, no defined query, and no rule for tool loops (R2-I2). `08` has no `append_recall` and still claims authority over signatures (R2-I9). |
| C2-bytes | `03` (Canonical byte order, Wire form); `07` (Canonical request) | **Partly resolved.** The grammar can be written as fixtures, the tools JSON is hashed, roles are fixed, and the order after the prefix and the cost of in-turn provider state are both stated. | The wire form breaks its own rule that the common prefix extends through the previous user message. Memory notes have no role, and some message shapes are rewritten by common providers. The grammar leaves no room for 10's untrusted envelope (R2-I1). |
| C3-compact | `03` (Compacted memory block, Compaction triggers) | **Resolved, with gaps.** Fixed slots and transcript slots never trip a trigger, compaction is model-free, and `min_interval_turns` keeps compactions apart. | Survivors depend on "slot heat," which no document defines. Members of the compacted block have no identity. A transcript `Unfixable` points to a rule in 06 that does not exist (R2-I3). |
| C4-tools | `07` (Boundary architecture); `10` (Side-effect pipeline, rule 2) | **Resolved in 07.** Memory, post, and open-thread variants exist. Schedules are human-only. The owner authors operation contracts, and 10 quarantines learned operations. | No table gives each variant its sink, capability, tier, budget charge, audit kind, and unattended rule. 07 says grants key on `ToolKind`, 10 keys them on `Capability`, and 11 on `ToolName` (R2-I6). |
| C5-shell | `07` (Windows console sessions); `10` (Shell containment; Windows containment conformance) | **Resolved in 10.** Each thread gets a contained identity, a separate desktop, and no loopback. The conformance suite contains every red test round 1 asked for. | 07 still runs the sidecar "under the current Windows user" and names one dedicated account rather than one identity per thread. It also lets an approved console call run unisolated, where 10 makes the console unavailable (R2-I8). |
| C6-loopback | `07` (Peer authorization); `10` (Client authentication; HTTP surface hardening) | **Resolved.** A loopback client without the IPC-delivered secret gets no session. Host is matched exactly, Serve and Funnel are detected, and Maia's own origins are blocked in the automation Chrome. | 07 keeps the unauthenticated Chrome debugging-port fallback and an allowlist of users only. 10 requires a pipe and `(user, node)` pairing. 07 and 10 list different presence-gated actions, and 09 lets any client edit router and vault settings (R2-I8, R2-I10). |
| C7-grants | `07` (`HumanRequestKind`); `09` (NeedsHuman, Settings); `10` (Capability grants, Approval tiers) | **Partly resolved.** 10 defines grants, single-use approvals bound to a digest, the unattended default, and a rule that nothing is approved automatically. 09's banner copy depends on the request kind. | 07, 09, 10, and 11 disagree on what the phone may approve. 07's executable allowlist has no field in 10's `ConsoleExec`. 06's reducer has no exit for an approval, and its cancel target contradicts 07 and 09 (R2-I6, R2-I7). |
| C-taint | `02` (Fact); `05` (schema contract); `04` (Correction mark); `10` (Provenance and taint; Memory and dream integrity) | **Not resolved.** The fields exist, but 02 and 05 define a taint model that is incompatible with 10's, and the one in the owning documents can be forged (R2-C1). | 04 still gives a hit found only in a tool result weight 1, in two places (R2-I4). The correction hold is triggered by an unspecified detector (R2-I5). |

## What now holds

- **The recall loop closes.** 00, 03, and 04 agree:
  1. ranking runs without a model;
  2. a turn-local recall block is recorded by item id and hash;
  3. attribution credits the items used;
  4. credited items install after the assistant turn.
- **Prompt bytes can be written as fixtures.** 03 gives exact section headers, label forms, the
  form of an empty block, the order after the prefix, and the accepted cost of in-turn provider
  state.
- **Compaction cannot run every turn.** Only installed memory and the compacted block are
  eligible, compaction calls no model, and `min_interval_turns` separates compactions.
- **Every model-callable action is a variant of one closed enum.** 10 routes all of them through
  one side-effect pipeline that denies by default.
- **The shell no longer runs as the owner.** 10 specifies a contained identity per thread, a
  separate desktop, no loopback, and a Windows conformance suite.
- **Loopback no longer proves identity.** The desktop authenticates with a launch secret delivered
  over IPC, and Host and Origin are matched exactly. Serve and Funnel are detected, Maia's origins
  are blocked in the automation browser, and actions that widen privilege need OS user presence.
- **Approvals are bound and never automatic.**
  - Each approval is single-use and bound to the action digest, lease, and policy version.
  - An unattended run waits in `NeedsHuman` for approval.
  - Repeated denials stop the thread.
- **The dream cannot reach tools through the router.** It sends `tools: []`, and any tool call
  that comes back fails the batch.
- **10 and 11 close several round-1 Important findings** (listed under "Carried from round 1").

## Named red tests in `00-goal.md`, round 2

| Test | Writable from the docs alone? |
| --- | --- |
| `compile_prompt` is byte-identical before and after restart | **Yes,** with independent fixtures from 03's grammar. The companion test on the provider payload is ambiguous (R2-I1). |
| Attribution ignores slots absent from the request | **Yes,** and it now covers recall items. |
| A reply-only hit is half weight only when the turn had no readable reasoning | **The weight, yes. "Hit" and whether the unit is the request or the turn, no** (carried I5, I6). |
| Weighted ACT-R matches a hand-computed fixture | **Yes, from 02** (`AgeUnit::Seconds`). 08's signature conflicts with it (R2-I9). |
| `map` returns descriptions and links without bodies | **Yes.** |
| `render_entity_page` preserves the human region | **Mostly** (carried I15). |
| Dream apply is atomic, projection is idempotent, and neither invokes tools | **Yes,** including `tools: []`. Whether dreaming keeps making progress cannot be tested (R2-C2). |
| Budgets and human challenges produce the specified states | **Budgets, from 06 alone; 10's budget lineage conflicts. Exits from `NeedsHuman`, no** (R2-I7). |
| Desktop and phone address the same daemon and thread ids | **Yes.** What each may do depends on which document you read (R2-I6). |

## Critical

### R2-C1. Fact taint is defined twice, and the owning documents use the version that can be forged

**Where.** `02-brain.md` (Fact: `FactOrigin`, quarantine; Episode); `05-dream.md` (schema
contract: `origin`; Purpose: oldest-first selection); `10-security.md` (Provenance and taint;
Sink checks; Memory and dream integrity, items 1–6; Consistency findings 12 and 13).

**Problem.**

- **Two models for one field.** 02 gives each fact one `FactOrigin`, chosen from seven values.
  05 recomputes it from "the union of source episode provenances (strictest / most untrusted
  wins)." No order among `Owner`, `Agent`, `VaultHuman`, `VaultGenerated`, `Web`, `Tool`, and
  `Api` is defined, so "strictest" has no meaning. 10 gives every fact a binary `Taint` plus a
  set of `sources`, and never mentions `FactOrigin`. No document maps one model onto the other.
- **05's derivation is the attack 10 describes.** 05 derives origin from the fact's
  `episode_ids`, and the model chooses those ids. Suppose a batch holds a web episode and an
  owner episode. The model can cite only the owner episode, and the fact is then stored as
  `Owner`. 10 (Memory and dream integrity, item 2) calls this provenance forgery and requires
  fact taint to be the join of everything the call saw.
- **Taint now decides whether an action needs confirmation.**
  - In 10's sink table, a `Trusted` request runs these granted actions without confirmation:
    credentialed actions, secret use, reversible writes, and console network egress.
  - An `Untrusted` request needs confirmation for all of them.
  - So a fact forged as trusted, recalled into an otherwise trusted thread, removes the
    confirmation step in front of injected instructions.

  Round 1 rated taint Important because grants did not then depend on it. Now they do.
- **The supporting pieces exist only in 10.**
  - 02's Episode has no provenance, but 10 requires provenance on each episode segment.
  - 05 selects oldest-first across all episodes, but 10 requires batches partitioned by taint.
  - 05 has no proposal record for an untrusted batch that would close or merge a trusted fact.
  - 02's `RankPolicy` has no `RecallTaintMode`.
  - 02's `InjectionSuspected` quarantine has no defined setter, while 10 handles the same case by
    raising taint after the fact (retro-taint).

**Change.**

- Adopt 10's model in 02 and 05. A fact's taint is the join of the whole dream call's context.
  `FactOrigin` either becomes inspection detail expressed as `SourceRef`s or is removed.
- Add provenance per segment to 02's Episode.
- Partition 05's selection by taint, and add the proposal record for untrusted closures and merges
  of trusted facts.
- Add `RecallTaintMode` to `RankPolicy`.
- Define who sets `InjectionSuspected`, or replace it with 10's retro-taint.

**Red tests.**

- A batch that contains a web episode yields `Untrusted` facts, even when the model cites only
  owner episodes.
- An untrusted batch that closes a trusted fact produces a proposal, and the trusted fact stays
  current.

### R2-C2. Every contradiction candidate must be closed, so one false positive stalls dreaming or deletes a true fact

**Where.** `05-dream.md` (Inputs and pure pre-pass; schema contract: "Pre-pass contradiction
candidates without a corresponding `closures` entry fail the whole batch"; Purpose: oldest-first
selection; Failure handling).

**Problem.** The rule was added to settle Grok I11, where contradictions were both automatic and
optional. It goes too far.

- **The pre-pass is built to propose too many pairs.** It is a deterministic, lexical function
  keyed by `subject_key`. It "proposes pairs only" so that the model can judge them. A candidate
  is a suspicion, not a contradiction.
- **The model cannot reject a candidate.** The schema has no way to say "these do not
  contradict." For each false positive, the model either closes a true fact, which removes it
  from recall and from the vault, or the whole batch fails.
- **A failed batch comes back unchanged.**
  - Selection is oldest-first, the pre-pass is deterministic, and a failure leaves the episodes
    pending. So the same batch, with the same candidate, returns on every trigger.
  - The 20-pending trigger stays true, so the runner keeps paying for model calls until it
    reaches 10's daily dream ceiling.
  - Memory organization stops behind that batch, and no screen shows why.

**Change.**

- Add a required `dismissals` array of (`existing_fact_id`, `episode_id`) pairs. Every candidate
  must then be answered by a closure or a dismissal. A candidate with no answer still fails the
  batch.
- Record dismissals so they can be inspected.
- Count failures per episode. After N failures, quarantine the episode and show it in the UI
  (round-1 I11).

**Red tests.**

- A response that dismisses a false-positive candidate is applied, and the existing fact stays
  current.
- A response that leaves a candidate unanswered fails.
- After N failures, the episode leaves selection, and later batches proceed.

## Important

These are kept brief, as requested. Each names where the gap is, what breaks, and the smallest
change.

### Residual of the merged fixes

**R2-I1. The wire form breaks its own cache rule and is not portable across providers.**
`03` (Wire form, Canonical byte order); `07` (Canonical request).

- **Recall breaks the rule.** Recall and scratch are "appended to the last user content part."
  On the next turn that message is sent without them. The payload therefore diverges inside the
  previous user message, not after it, which contradicts the MUST and its red test.
- **Labels may change a message's form.** Durable bytes label transcript turns
  (`` `user:{turn_id}`: ``) but place the current message, unlabeled, under `## user`. Nothing says
  whether the wire content includes the label. If it does, the same message changes form between
  turns.
- **Notes have no role, and tools may be sent twice.** Installed memory notes sit inside the
  transcript but have no role on the wire. "`tools_header`" may or may not include the tools
  JSON; if it does, tools are sent twice.
- **Agent-agent threads use risky message shapes.**
  - The newest agent message is sent as `user` while it is current, then as `assistant` once it
    is in the transcript, so its role flips.
  - The speaker cue is a trailing `system` message that follows consecutive `assistant` messages.
  - Anthropic's OpenAI-compatible endpoint documents that it moves system messages to the front.
    Native APIs may treat a trailing assistant message as text to continue.
  - Many open-model chat templates reject a system message that is not first, or roles that do
    not alternate.
- **The adapter cannot rebuild messages.** `RouterRequest.compiled_prompt: Bytes` drops message
  boundaries. The grammar does not escape section headers or labels that occur inside a body, so
  the adapter cannot recover the boundaries either.
- **No room for the envelope.** The grammar says "No other text is permitted," which leaves no
  place for 10's untrusted-slot envelope.

**Change.**

- Carry recall, scratch, and the speaker cue in one trailing `user` message that is not durable.
- For each slot kind, state exactly what the message content holds. Give notes a role.
- Send tools only in `tools`.
- Pass structured wire messages, plus the hash, in `RouterRequest`.
- Decide whether the envelope is used.
- Add one payload fixture for each supported provider family.

**R2-I2. The recall block has no budget, no dedupe, no defined query, and no rule for tool
loops.** `03` (Recall block, Request sequence); `02` (`RankPolicy`); `06` (scheduler step 6).

- Recall has no cap on items or bytes, only an inclusion threshold.
- A fact that is already installed can be recalled again. That duplicates bytes and leaves open
  which slot gets the credit.
- No document says where `RecallQuery` comes from for a user message, an inter-thread message,
  or a scheduled wake.
- Each request in a tool loop recompiles, so recall and credit repeat per request, while install
  happens once per turn (round-1 I5).
- `append_recall(&[RankedPath])` receives no sentence text.
- Before the first dream there are no facts, so nothing reaches the prompt. Episodes surface only
  through an explicit Load, and 09 has no control for it.

**R2-I3. Compaction's survivors depend on an undefined "heat," and a transcript `Unfixable` leads
nowhere.** `03` (Compaction triggers); `04` (Presentation ledger: "thread slot-heat updates").

- No document defines "slot heat at or above the policy floor": not whether it is a sum, decays,
  or uses a window. Survivors therefore cannot be computed by hand.
- Members of the compacted block have no identity of their own. The unused-slot trigger and the
  survivor rule cannot see them individually (round-1 I24).
- For an over-budget transcript, `Unfixable` says the scheduler "surfaces `NeedsHuman` or stops
  the lease per `06-agents.md`." 06 has no such rule, reason, or kind. A long thread hits a wall
  that nothing defines.

**R2-I4. 04 contradicts itself on the weight of a tool result.** The Evidence boundary scores a
match found only in a tool result at 0. Weight rules and the Testing contract still say 1.0. The
plan locked 1.0, and `REVIEW.md` does not record the user's approval of the change (round-1 I7).

**R2-I5. A correction now removes a fact from recall, but the detector is unspecified.** `04`
(Correction mark; `correction_mark`).

- `CorrectionHold` applies at once, yet how correction evidence is proposed is still "outside
  this leaf."
- A loose lexical rule silently freezes facts. A model-based detector would be a model call on
  the message path.
- **Change:** lock a lexical rule for v1, or show the hold in the UI for the owner to confirm.

**R2-I6. Grant keys, phone approval authority, and console targets differ across 07, 09, 10, and
11.**

- **Grant key.** 07 says grants key on `ToolKind`. 10 keys them on `Capability` and `SinkKind`;
  11 on `ToolName` with `SecretScope`. No table maps each `ToolRequest` variant to its sink,
  capability, tier, budget charge, audit kind, and unattended rule (round-1 C4).
- **What the phone may approve.**
  - 07 makes `CapabilityApproval` desktop-only and requires presence to approve any grant.
  - 10 lets phones approve `Confirm`-tier sinks. Because those grants are missing from its
    `DesktopConfirm` list, 10 also lets phones issue some grants at `Confirm`.
  - 09 lets the phone deny only, and names risk classes (`Execute`, `CredentialUse`,
    `WriteRemote`) that 10 no longer defines.
  - 11 queues a phone's rotation or revocation as a `NeedsHuman` `RotationApproval`. That kind is
    not in the enum and belongs to no thread. 10 calls revocation a tightening the phone may do.
- **Console target.** 07 admits a command when its executable is on an allowlist and its
  arguments match a digest. 10's `ConsoleExec { workspace, network }` has neither field, and 10
  states that inspecting commands is not a boundary.
- **Secrets.** 11's `check_scope` (which allows `AllowedSet::All`) and 10's `SecretUse` grants
  both gate resolution. No rule says how the two combine.

**R2-I7. 06 was not updated for approvals, compaction, or 10's budget rules.**

- `Running -> NeedsHuman` happens only when "a tool returns" a request, but approvals come from
  `check_sink`.
- There is no exit for Approve or Deny. 10's denial threshold implies that Deny returns a
  rejection to the model and the loop continues.
- Cancel moves the thread to `Running`, whereas 07 and 09 move it to `Stopped`.
- There is no budget lineage and no global breaker. Pooled quotas are still out of scope, and
  `ToolOpenedThread` grants a fresh lease (10 finding 5).
- A failed audit check still disables "panic mutations," whereas 10 moves to `InspectOnly`.
- Compaction `Unfixable` has no handling, and turn-taking in agent-agent threads is still
  undefined (round-1 I10).

**R2-I8. 07 still contradicts the C5 and C6 fixes in five places.**

- The sidecar runs "under the current Windows user."
- Chrome may fall back to a loopback debugging port. That port is unauthenticated, and 10
  requires a pipe only.
- An approved console call can run without isolation, whereas 10 makes the console unavailable.
- `authorize_peer` takes an allowlist of users only, whereas 10 requires `(user, node)` pairing
  and denies tagged nodes.
- 07 names one "dedicated local account," whereas 10 requires an identity per thread. Separately,
  "Allowed origins are generated from … listener addresses" leaves out the Tauri origin named one
  paragraph earlier.

**R2-I9. 08 was not updated, yet still claims authority over every signature.**

- Its leaves are the old ones:
  - `activation` returns `Option`;
  - `rank_paths` returns `Vec<RankedFact>`, with no quarantine or taint input;
  - `attribute_uses(slots, trace)` keeps its old shape;
  - there is no `append_recall` and no `compact`.
- `run_thread` receives all of `SecretStore`, and `run_dream` receives a `ThreadLog` that can
  append.
- There are no ports for audit, scheduler state, approvals, grants, or the projection queue
  (round-1 I1, I2, I11, I20; 10 finding 21).
- 11 calls Credential Manager "via the `windows` crate," where every call is `unsafe`. 08 forbids
  `unsafe` in every crate (10 finding 10).

Until 08 changes, its authority clause formally overrides the C1 and C-taint fixes.

**R2-I10. 09 does not classify settings and lacks the security screens 10 requires.**

- The Settings mockup saves router URL, model, vault path, and budgets with one button, on any
  client. 10 requires `DesktopConfirm` for router and vault-path changes.
- These screens have no placement (10 finding 23):
  - the approval sheet;
  - device pairing;
  - a latched-panic banner with a Clear control;
  - taint markers in Cache, Brain, and Trace;
  - security events in Activity;
  - incidents.
- The phone stop bar still appears only while a thread is running (round-1 I17).

**R2-I11. None of 10's consistency findings has a recorded decision.**

- 10 makes each of its 24 findings a `REVIEW.md` decision and applies "the more restrictive
  reading" until one is recorded.
- The owning documents fix findings 1, 6, and 20. Most others remain open: 2, 3, 5, 8–10, 12, 13,
  15, 18, 19, 21, 23, and 24.
- 10 also defers to `REVIEW.md` the choice between an AppContainer and a restricted-token
  account.
- `REVIEW.md`'s fix table does not mention that 10 and 11 were rewritten.

**R2-I12. 11 claims compile-time enforcement it does not have, and the router's requester is
undefined.**

- `use_once` takes a closure, and the closure can copy the `&str` into a captured `String`. So
  `NotSecretValue` does not keep the value inside its scope.
- The compile-fail test "storing `SecretValue` in a struct field does not compile" cannot pass in
  Rust, because `resolve` hands the caller an ordinary public type.
- **Change:** state the guarantee as the sentinel exfiltration scan instead.
- The router resolves its key with a `SecretRequester { agent, tool, thread }`. A router call has
  no tool, and a dream's router call has no thread (round-1 I20).

### Carried from round 1, still open

| Round-1 item | Status |
| --- | --- |
| I4 participant scope | **Partly fixed.** 10's standing `VaultRead` grant scopes `map` and `read`. Still open: episodes from private threads reach every thread's retrieval; dream scope ("existing participant agent") is not validated; and nothing maps an `AgentId` to a folder. |
| I5 request versus turn; `ReasoningTrace` | **Open.** `RouterResponse.reasoning` is still `Option<String>`. |
| I6 matcher for a "hit" | **Open.** |
| I8 ACT-R ages | **Partly fixed:** the unit is now `AgeUnit::Seconds`. Zero age is still rejected, and one future-dated presentation still fails the whole ranking. |
| I9 reversal | **Open.** A double reversal still reads as corruption, and 04 still stores a mutable "reversal status." |
| I11 dream runner | **Partly fixed:** the runner sends `tools: []`, and 10 adds spending ceilings. Panic handling, embedding timing, the input bound, and the `ThreadLog` that can append remain open. |
| I12 blocked projections | **Open.** On restart, every pending projection must still finish before any new dream runs. |
| I14 vault validation is strict | **Open.** Unknown keys, notes without frontmatter, and missing kinds still block whole folders. |
| I15 bytes outside the markers; replacement race | **Open,** together with Grok I17 (an end marker inside a region). |
| I24 selection identity; retrieval record | **Open,** together with Grok I6. |
| Grok I11, second half | **Open.** A metadata echo that differs by one character still rejects the whole batch. |
| Grok I13 and M4 | **Open.** 248 + 480 is wider than 720, and resizing the inspector can break the conversation's minimum width. |
| Grok I15 | **Open.** 06 still enters `NeedsHuman` "when duplicate execution could cause harm," which is not a closed rule. |

Closed since round 1:

- I13: 10 installs instruction files only at owner-approved hashes, and existing threads keep
  their prefix.
- I18: 10 renders untrusted content as text under a strict CSP.
- I21: logins are an owner action only.
- I22: 10 defines request taint and keeps detectors out of every decision.
- I23: 10 specifies the supply chain and signing.

## Minor

- **R2-M1.** 02's "Explicitly out of scope" still leaves the elapsed-time unit open, while its
  public contracts fix `AgeUnit::Seconds`. Invariant 6 still says "source episode," singular.
- **R2-M2.** 03's testing contract still says "retaining the old summary." "Constitution" appears
  in 03, 09, and 10, but the grammar has no section for it.
- **R2-M3.** The tool is `ToolRequest::Console` but its kind is `ToolKind::ConsoleRun`.
  `VaultRead { path: VaultPath }` uses a different path type from 01's `NotePath`.
- **R2-M4.** Steps 1–3 of 04's attribution sequence build candidates "only from those included
  slots," leaving out the recall items its scope includes.
- **R2-M5.** An empty recall block still sends its header every turn. How a recall sentence
  escapes backticks and newlines is unspecified.
- **R2-M6.** An `Unfixable` caused by the memory budget, rather than the transcript, has no
  handling. The centroid is undefined while the compacted block is empty.
- **R2-M7.** Each compaction rewrites the `system` message, so each one costs a cache miss on the
  whole prefix. Say that `min_interval_turns` exists to bound this cost.
- **R2-M8.** 11 says locking the workstation makes `CredRead` fail, and maps that to
  `DaemonRestart`. The logon session persists while the workstation is locked, so the Windows
  `CredentialUnlock` path is mostly unreachable.
- **R2-M9.** 11 names crates (`windows`, `zeroize`, `ulid`, `reqwest`), although 08 says this
  gate chooses no libraries.
- **R2-M10.** 07 shows the phone "This step must be completed on the desktop" for every kind.
  09's table lets the phone deny an approval, and an ambiguous outcome can be checked from any
  device.
- **R2-M11.** 00's acceptance checklist still has no security item (10 finding 24).
- **R2-M12.** 09 and 11 draw different Settings mockups for secrets.
- **R2-M13.** A second load is described as "an explicit user or inspector action," but 09 has
  no control for it.
- **R2-M14.** 07's generic `WebRead` has no request shape, because `WebIntent` requires a
  registered `SiteId` and operation.
- **R2-M15.** 10's distribution of signed policy (TUF roles, root rotation, remote fetch) has no
  publisher in v1. The compiled floor plus local overrides cover v1. Mark distribution as
  post-v1, so it does not count as surface area under 00's Goal item.
- **R2-M16.** The transcript is never compacted (03), and taint never decreases (10). A thread
  that has read one web page is therefore `Untrusted` for the rest of its life, and every later
  credentialed or write action in it waits for confirmation. State this, because it limits
  unattended work in long threads.

Round-1 Minors still open (not recounted):

- M1: `PanicState.engaged` and `ConsoleResult.truncated` are booleans.
- M4: `AuditEvent` has no policy version.
- M5: the Cache mockup uses `mem_` ids.
- M6: the Sleep and Run header actions are undefined.
- M7: a cache count the provider did not report would display as 0%.
- M8: a closure can produce an inverted validity window.
- M9: the generated-region line has no exact grammar.
- M10: no job re-embeds vectors after the embedder changes.
- M11: no single-instance lock for the daemon.
- M15: no request-intent record before the router call.
- M17: the dream pre-pass has hidden inputs.
- M18: the disabled composer blocks redirecting the agent during `NeedsHuman`.

## Checklist result

| `REVIEW.md` item | Result | Blocking findings |
| --- | --- | --- |
| Goal alignment | Pass with notes | R2-C2 puts the dream pillar at risk; R2-I2 (no recall before the first dream) |
| Consistency | Fail | R2-C1, R2-I6, R2-I7, R2-I8, R2-I9, R2-I11 |
| Correctness | Fail | R2-C2, R2-I1, R2-I3, R2-I4 |
| Security | Fail as a set; 10 on its own is sound | R2-C1, R2-I6, R2-I8, R2-I12 |
| Frontend | Partial | R2-I10; carried I24 |
| Dual re-review Accept recorded | Not met | — |

## Relation to Grok's round 1

- **Grok C1 (recall)** is resolved.
- **Grok C3 (grants)** is resolved in 10, but 06, 07, 09, and 11 disagree with it (R2-I6,
  R2-I7).
- **Grok C2 (taint)** is not resolved (R2-C1).
- Of Grok's Important items, I1 is part of R2-I9. I3 and I4 are resolved, except for R2-I1 and
  R2-I3. I6, I13, I15, and I17 are carried. I11's first half became R2-C2. I14, I16, and I18 are
  resolved by 10, apart from the 07 and 06 text in R2-I7 and R2-I8.

## Required before the next review

1. Unify fact taint on 10's model in 02 and 05, with selection partitioned by taint and with
   proposals (R2-C1).
2. Give the dream a way to dismiss a candidate, and quarantine an episode after repeated failures
   (R2-C2).
3. Fix the wire form and the recall rules. Define slot heat. Resolve 04's weight contradiction
   and record the user's decision (R2-I1 through R2-I5).
4. Reconcile 06, 07, 08, 09, and 11 with 10 (R2-I6 through R2-I10, and R2-I12).
5. In `REVIEW.md`, record a decision for each of 10's 24 findings. Include the isolation
   mechanism, the `unsafe` boundary, and what the phone may approve (R2-I11).
6. Fix each carried Important item before the code that depends on it. I14 and I15 block vault
   work, and I8 blocks activation.
7. Limit the next review to these changes. The architecture, the seven round-1 mechanisms, and
   10's threat model do not need another full pass.
