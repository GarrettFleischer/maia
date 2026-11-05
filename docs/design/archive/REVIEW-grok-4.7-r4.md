# Design re-review, round 4 — Grok 4.7

Reviewed 2026-11-04. Read `00-goal.md` through `11-secrets.md`, `REVIEW.md`, and
`REVIEW-grok-4.7-r3.md`. No other document was edited. No code was written.

Scope was the fixes `REVIEW.md` says landed after round 3, whether those edits
disagree with any chapter that still touches the same rule, and what is still
Important before implementation.

## Verdict

**Accept with changes.**

No Critical finding. The round-3 security properties still hold: fact taint is
the dream-call join, batches are taint-partitioned, an untrusted close or merge
of a trusted fact is a proposal, and a contradiction candidate has a closure or
a dismissal. The patched chapters say the right thing. Several other chapters
still say the previous thing, so two implementers can still diverge. Those are
text alignments, not a new architecture.

## Counts

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| Important | 12 |
| Minor | 6 |
| **Total** | **18** |

## Verification

Fenced blocks in `00`–`11` are balanced. No fence is left open.

| Claimed fix | Result |
| --- | --- |
| Episode "strictest origin" removed (`02`) | **Holds.** `02` (Episode) sets episode taint to the join of segment taint and says fact taint is only the Fact rule. `02` (Fact), `05` (schema contract), and `10` (Memory and dream integrity, items 1–2) agree. The phrase is gone from `00`–`11`. |
| `RecallTaintMode` matches (`08` = `10`) | **Holds.** `02` (Public contracts), `08` (Honest leaves), and `10` (Memory and dream integrity) use `IncludeUntrusted` as the default and `TrustedOnly` per sensitive agent. `ExcludeUntrusted` is gone. |
| Dream proposal step and `DreamProposal` (`05`) | **Holds** in the apply sequence. Step 6 writes `DreamProposal`; steps 7 and 8 skip diverted merges and closures; step 10 commits proposals with the batch. `10` item 4 matches. The invariant list omits them (Minor 1). |
| One closure answers every candidate; failures per episode (`05`) | **Holds.** `05` (schema contract, Failure handling, Testing contract) and the tests agree. "A fact cannot be closed twice" means one closure object, which is what the new rule asks for. Dismissal identity omits `subject_key` (Minor 1). |
| One AppContainer SID per thread, separate sidecar SID, whole vault denied (`07`) | **Holds in `07` and `REVIEW.md`.** `10` (Shell containment, item 1) still leaves the mechanism open (I3). |
| `RankedPath` carries `FactId`, sentence, and taint (`02` / `03` / `08`) | **Holds for the bytes.** All three say `append_recall` renders `` `{fact_id}`: {sentence} `` from the path. The taint field is not consumed (I4). |
| Chrome pipe-only | **Holds** in `07` (Persistent Chrome), `10` (Browser containment), and finding 2. The same `07` file still describes a debugging endpoint (I2). |
| `(user, node)` pairing; tagged nodes denied | **Holds.** `07` (`authorize_peer`, `PeerKind::Tailnet`) and `10` (Client authentication, `ClientClass`) use the pair. Tagged nodes are denied in both. |
| Desktop-only approvals; phone may deny | **Holds** in `07` (`CapabilityApproval`), `09` (NeedsHuman), `10` (Approval tiers), and `REVIEW.md`. Two later passages in `10`, plus `11`, still grant or invent phone approvals (I1). |
| `maia-win32` is the only unsafe crate | **Holds** in `08` (Invariants, Style and lint) and `10` finding 10. `08` (maia-secrets) and `11` (Windows adapter) still describe unsafe calls in another crate (I6). |
| Signed checkpoints, `InspectOnly`, budget lineage, global breaker, cancel → `Stopped` | **Holds** for the audit mode and for cancel. `06` (Immutable audit, Failure modes) signs checkpoints, keeps witnesses, enters `InspectOnly`, blocks clearing panic until `DesktopConfirm`, and still allows engaging panic. `06`, `07`, and `09` agree that cancel goes to `Stopped`. Lineage is in `06` (Budgets) and `10` (Denial of service). Deny-versus-stop and the breaker shape disagree (I5). |

## Important

### I1. Phone approval is still granted after the desktop-only edit

`07-computer.md` (Login walls, captchas, and `NeedsHuman`) marks
`CapabilityApproval` desktop-only. `09-frontend.md` (NeedsHuman) says the phone
may deny only, and that every approval is desktop-only. `10-security.md`
(Approval tiers) says a paired phone may deny and may not approve.

`10-security.md` (Approval tiers, Owner actions and their tiers) still lists
`Confirm (desktop or phone)` for approving sinks, endorsing a fact, and
accepting or rejecting a dream proposal. `10-security.md` (Client
authentication, item 7) still gives the phone "`Confirm` approvals". Accepting
a proposal is how an untrusted closure of a trusted fact becomes real, so this
sentence reopens a decision the proposal step exists to keep on the desktop.

`11-secrets.md` (Approval gate) queues `NeedsHuman { kind: RotationApproval }`.
That variant is not in `07`'s `HumanRequestKind`. `09-frontend.md` (Settings)
lets the phone revoke secret scopes in place. `11-secrets.md` (Scope and
approval tests) keeps the old scope until a desktop confirmation.

**Change.** One phone sentence in `07`, `09`, `10`, and `11`: deny, revoke
(tighten), stop, and panic. Name `RotationApproval` in `07` if rotation stays a
queued desktop request.

### I2. Pipe-only Chrome still has a loopback debugging endpoint in `07`

`07-computer.md` (Persistent Chrome) and `10-security.md` (Browser containment,
finding 2) forbid every debugging port, including on loopback.

`07-computer.md` (Boundary architecture) draws the browser owner as
`pipe/loopback`. Invariant 9 says "Remote debugging … [is] loopback-only."
The Chrome tests require the debugging endpoint to be unreachable from
non-loopback interfaces. A port bound to loopback passes that test and violates
the pipe-only rule.

**Change.** Delete the diagram label, the "remote debugging" clause, and that
test. Replace the test with "no debugging port listens, including on loopback."

### I3. The sandbox mechanism is recorded, and `10` still calls it open

`07-computer.md` (Windows console sessions) and `REVIEW.md` (Recorded decisions)
lock one AppContainer SID per thread, a separate sidecar SID, and a denial of
Maia data, the whole vault, the Chrome profile, and Credential Manager.
`10-security.md` finding 3 is marked Resolved on that text.

`10-security.md` (Shell containment, item 1) still allows a dedicated local
account with a per-thread restricted token, and says the choice "is a
`REVIEW.md` item decided by the conformance suite."

**Change.** Replace item 1 with the recorded AppContainer rule. Keep the denial
list and the conformance suite as the oracle for that rule.

### I4. `RankedPath.taint` never enters the request the model sees

`02-brain.md` (Public contracts), `03-thread-cache.md` (`append_recall`), and
`08-rust.md` (Honest leaves) agree that the path carries `FactId`, the
sentence, and taint, and that the recall line is the id and the sentence. The
byte contract holds.

`10-security.md` (`request_provenance`) joins included slots and the scratch
suffix. Recall items are on the request record and are not slots.
`03-thread-cache.md` (Recall block) allows no other text in the block, so the
untrusted-slot envelope from `10` (Provenance and taint) cannot be written
there. An untrusted fact can sit in the prompt while `check_sink` still sees
`Trusted`. Finding 13, slot envelopes in `03`, is the same hole for durable
slots and is still open.

**Change.** Add recall-item provenance to `request_provenance`. Join path taint
into the request even when the recall grammar stays id-and-sentence. Cover it
with a test: one untrusted recalled fact makes the request `Untrusted`. Put the
durable-slot envelope in `03` or drop it from `10`.

### I5. Cancel, deny, and the spend breaker do not share one outcome

Cancel holds. `06-agents.md` (Accepted transitions), `07-computer.md` (Login
walls), and `09-frontend.md` (NeedsHuman) send cancel to `Stopped`.

The same `06` bullet also sends a denied approval to `Stopped`. `09` draws
Deny and Stop as different controls. `10-security.md` (Approval tiers) moves
the thread to `Stopped` only after the policy's number of denials in the lease.
A single deny therefore has two legal destinations.

`06-agents.md` (Budgets) caps "total router tokens per day." `10-security.md`
(Denial of service and cost) trips a rolling window over router tokens, tool
turns, and estimated spend, then sleeps unattended leases. `06` does not say a
later unattended wake is refused after the trip. `10` (Testing contract) tests
`admit_lease` against the breaker; `06`'s `admit_step` does not take it.

**Change.** Keep cancel → `Stopped`. A single deny stays in `NeedsHuman` until
the Nth denial, which stops the thread. Point `06`'s breaker at `10`'s three
meters and require `admit_step` to fail while the breaker is tripped.

### I6. `maia-win32` is the only unsafe crate, except where the secrets text says otherwise

`08-rust.md` (Invariants, Style and lint) and `10-security.md` finding 10 allow
`unsafe` only in `maia-win32`, which parses no untrusted bytes.

`08-rust.md` (`maia-secrets`) still says concrete Win32 wrapper crates "stay out
of this gate" and that first-party crates remain `forbid(unsafe_code)`.
`11-secrets.md` (Windows Credential Vault adapter) calls `CredRead`,
`CredWrite`, and `CredDelete` on that adapter. The dependency graph in `08`
does not contain `maia-win32`, so the crate that is allowed to make those calls
has no legal edge.

**Change.** Delete the "out of this gate" sentence. State that `11`'s adapter
calls safe functions in `maia-win32`. Add `maia-win32` to the graph: adapter
crates may depend on it, and it depends on no adapter.

### I7. A private fact has a scope and no retrieval filter

`01-vault.md` (invariant 7) says a thread sees shared entities and the private
entities of its participants. `02-brain.md` (Fact) stores
`Agent(AgentId)` on the fact. `rank_paths` in `02` and `08` takes the graph,
query, time, policy, and quarantine. It does not take participants. Nothing
else in the rank path drops another agent's private fact.

**Change.** Pass `participants: &BTreeSet<AgentId>` into `rank_paths`. Facts
scoped to any other agent are neither candidates nor spread. Add the red test
`01` already names for participant-scoped retrieval.

### I8. Trailing `system` messages can break the prefix the wire form requires

`03-thread-cache.md` (Wire form) places recall, scratch, and the speaker line
in `system` messages after the durable user message, and says two consecutive
provider payloads must share a prefix through that user message.
`07-computer.md` (Canonical request) forbids the adapter to reorder messages.
The set never says what happens when a provider rejects a later `system`
message or moves every `system` message to the front.

**Change.** Add a placement mode to `RouterCapabilities` (trailing `system`, or
a trailing `user` part). Choose it per provider at startup and store it on the
request. Run the common-prefix test in each mode.

### I9. Core policy can resolve a secret and append a dream into the thread log

`08-rust.md` (I/O skins) gives `run_thread` a `secrets: &S` parameter with
`S: SecretStore`. `11-secrets.md` (Port rules) says only `maia-tools` and
`maia-router` receive the store, and that the composition root does not call
`resolve`. The trait method `resolve` returns `SecretValue`. `11` invariant 2
says no `SecretStore` method returns `SecretValue` through the port.

`run_dream` takes `ThreadLog`, whose port includes `append`. `05-dream.md`
never appends a thread event. A dream that can append is a tool the dream
runner is forbidden to have.

**Change.** Remove `S` from `run_thread`. Skins resolve, and policy receives a
non-secret outcome. Make `11` invariant 2 match that split. Remove `ThreadLog`
from `run_dream`, or pass a read-only load with no `append`.

### I10. Transcript overflow and a dismissed correction have no legal next state

`03-thread-cache.md` (Compaction triggers) returns `Unfixable` when the
transcript alone exceeds its budget, then "surfaces `NeedsHuman` or stops the
lease per `06-agents.md`." `06` has no such transition, and
`HumanRequestKind` has no matching variant.

`04-credit.md` (Correction mark) keeps `CorrectionHold` until a dream closes
validity or an owner clears it. `05-dream.md` (Failure handling) says a
dismissal leaves the fact current. It does not clear the hold. A dismissed
correction never re-enters `rank_paths`.

**Change.** In `06`, transcript overflow is `Sleeping { reason: TranscriptBudget }`
with a visible banner. In `05`, dismissing the correction mark clears that
fact's hold in the same transaction as the dismissal.

### I11. One ledger is written through two ports

`04-credit.md` (`apply_ledger`) takes `&mut impl PresentationStore` and commits
thread heat, brain presentations, edges, and marks together. `08-rust.md`
(`BrainStore`) defines `apply_ledger(&LedgerUpdate)` and, separately, "a single
explicit database command" for cross-port atomicity. `PresentationStore` is not
a port in `08`. An implementer can persist heat and presentations in two
transactions and still satisfy one of the two signatures.

**Change.** One `BrainStore::apply_ledger(&AttributionLedger)` commits all four
effects. Delete `PresentationStore`.

### I12. These `10` requirements still have no text in the chapter that would implement them

`10-security.md` (Consistency findings) leaves them open. Each one changes
runtime behavior:

- **Finding 9.** `09-frontend.md` (Phone placement, Settings) opens the same
  settings pane, including router base URL and vault path, from the phone
  drawer. `10` requires `DesktopConfirm` for those fields. Phone restrictions
  in `09` cover secrets and grant creation only.
- **Finding 11.** `neutralize_inline_markdown` is specified only in `10` (Vault
  and Markdown safety). `01` and `05` constrain sentences and descriptions and
  do not name the escape table.
- **Finding 14.** `10` (Capability grants) intersects standing grants across an
  `AgentGroup`. `06-agents.md` (Thread and participant model) defines the
  thread and no authority rule.
- **Finding 15.** `10` installs `personality.md` and `agents.md` only at an
  approved hash. `01`, `03`, and `06` install the file bytes with no approval.
- **Finding 18.** `10` (Denial of service) gives panic a priority lane and
  closes the in-memory gate before the durable write. `06-agents.md` (Panic)
  requires the durable write before the HTTP response and names no lane.
- **Finding 23.** `09` has a `NeedsHuman` banner. It has no taint marks in
  Cache, Brain, and Trace, no pairing flow, and no incident view. `00-goal.md`
  still gates implementation on placement mockups.

**Change.** Put each rule in the owning chapter (`09`, `01`/`05`, `06`, `03`)
in the words `10` already uses. Mark the finding Resolved only after that
sentence exists.

## Minor

1. `05-dream.md` invariant 2 lists what commits together and omits proposals and
   dismissals; step 10 includes both. A dismissal is
   `{existing_fact_id, episode_id, reason}` while a candidate also has
   `subject_key`, so two candidates that share a fact and an episode have no
   distinct dismissal record.
2. `06-agents.md` (Immutable audit) signs `(sequence, head hash)`.
   `10-security.md` (Immutable audit) signs `{sequence, event_hash,
   policy_version, time}`. Witnesses cannot be checked against both payloads.
3. `08-rust.md` (`BrainStore::retrieval_graph`) returns `RetrievalGraph`;
   `rank_paths` takes `RecallGraph`. The dependency graph omits `maia-win32`
   (see I6). Ownership says panic prevents scheduling "until explicitly
   resumed"; `06` says clearing the latch resumes nobody.
4. `03-thread-cache.md` item 1 says tools are sent as `RouterRequest.tools`;
   the field in `07` is `tools_json`. Invariant 12 still says "old summary"
   for a first install that stores a sentence. `CompactionPolicy` omits
   `min_interval_turns`, the centroid window, the transcript budget, and the
   heat floor that the prose uses. Slot heat is never given as a fold of
   presentation weights.
5. `09-frontend.md` Cache mockup labels "Constitution"; `03` has tools, agents,
   and personas. At 720 px the rail (248) plus the minimum conversation (480)
   is 728. `00-goal.md` (Product sequence, step 7) still says "origin and
   quarantine," and the acceptance checklist has no security item (finding 24).
   The consistency links do include `10` and `11`.
6. `04-credit.md` invariant 3 and `02-brain.md` (Testing contract) say a "tool"
   hit is full weight; the weight rule is tool-argument only.
   `11-secrets.md` (Windows Credential Vault) reports a locked Windows session
   as `Locked { reason: DaemonRestart }`. Findings 16 and 21 in `10` describe
   `09` environment-variable secrets and `Router::cancel` that the current
   chapters do not contain.

## Checklist

| `REVIEW.md` claim | Result |
| --- | --- |
| I1 strictest origin removed | Pass |
| I2 `RecallTaintMode` | Pass |
| I3 dream proposal | Pass, with Minor 1 |
| I4 one closure; per-episode failures | Pass, with Minor 1 |
| I5 one SID per thread; vault denied | Pass in `07`; I3 in `10` |
| I6 `RankedPath` bytes | Pass; taint unused (I4) |
| Chrome pipe-only | Pass in the Chrome section; I2 elsewhere in `07` |
| `(user, node)` pairing | Pass |
| Desktop-only approvals | Pass in `07`, `09`, and Approval tiers; I1 elsewhere |
| `maia-win32` only | Pass in the lint rule; I6 in the secrets text |
| Signed audit, `InspectOnly`, lineage, breaker, cancel → `Stopped` | Pass for audit, lineage, and cancel; I5 for deny and the breaker |
| Dual re-review Accept | This report is Accept with changes. Not a clean Accept. |
