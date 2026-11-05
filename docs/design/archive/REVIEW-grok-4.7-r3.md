# Design re-review, round 3 — Grok 4.7

Reviewed 2026-11-04. Scope was only the Opus r2 reject items and the Grok r2 criticals that
were still open after that reject:

- R2-C1 taint (dream-call context join, not model `episode_ids`; taint-partitioned batches;
  untrusted closures of trusted facts are proposals; `RecallTaintMode`);
- R2-C2 dismissals (required array; unanswered candidates fail; N-failure quarantine);
- residuals of Grok r2 C5, C6, C2-bytes, and C-taint.

Read `02-brain.md`, `03-thread-cache.md`, `05-dream.md`, `07-computer.md`, `08-rust.md`,
`10-security.md`, `REVIEW.md`, `REVIEW-claude-opus-5.5-r2.md`, and `REVIEW-grok-4.7-r2.md`.
No other document was edited. No code was written.

## Verdict

**Accept with changes.**

R2-C1 and R2-C2 hold in `05` and `10`, and in `02`'s Fact and `rank_paths` contracts. The four
Grok r2 critical contradictions (interactive-user sidecar, loopback session optional, provider
payload as opaque bytes, rank with no quarantine) are gone. What remains cannot forge trusted
facts from cited episode ids, and it cannot stall a dream on a false-positive contradiction
without an N-failure exit. It can still make two implementers pick different recall defaults,
fact-origin sentences, proposal steps, and sandbox identities. Those are changes to align, not
a new architecture.

## Counts

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| Important | 6 |
| Minor | 3 |
| **Total** | **9** |

## Verification

| Check | Result |
| --- | --- |
| R2-C1 context join, not model `episode_ids` | **Holds** in `02` Fact, `05` schema contract, and `10` Memory and dream integrity item 2. A web/tool episode in the call yields `Untrusted` even when the model cites only owner episodes. `episode_ids` are inspection-only and must belong to the selected batch. |
| R2-C1 taint-partitioned batches | **Holds** in `05` Purpose and schema contract, and `10` item 3. Oldest-first is inside one taint partition. A trusted batch's context facts are trusted-only. |
| R2-C1 proposals | **Holds** in `05` schema contract and tests, and `10` item 4. An untrusted batch records a proposal instead of closing or merging a trusted fact; other valid operations in that response still apply. The apply sequence does not say this (I3). |
| R2-C1 `RecallTaintMode` | **Present** on `02` `RankPolicy` and as `10`'s enum (`IncludeUntrusted` default, `TrustedOnly` per sensitive agent). `rank_paths` in `02` and `08` takes `QuarantineSet`. `08` names and defaults the mode differently (I2). |
| R2-C2 dismissals | **Holds.** `dismissals` is a required array. Each pre-pass contradiction candidate needs one closure or one dismissal. Unanswered fails with no mutations. Dismissals are stored and do not close facts. Tests cover dismiss, unanswered, and N. |
| R2-C2 N-failure quarantine | **Holds** as a rule: after N consecutive validation failures (default 3) the episode set leaves selection, a security/UI event is raised, and later batches proceed. The counter is the set, not the episode (I4). |
| Grok C5-r2 interactive user | **Resolved.** Sidecar and console both run under a dedicated sandbox identity, not the interactive user. `10` finding 3 is Resolved. `07` has the four denial tests (brain, cookie database, Credential Manager canary, `personality.md`). Per-thread distinctness still disagrees with `10` (I5). |
| Grok C6-r2 loopback session | **Resolved.** Invariant 10 requires the per-launch desktop secret on every loopback UI session. One Origin allowlist includes `tauri://localhost` (or the custom protocol). The negative loopback test is in `07`. `10` finding 1 is Resolved. |
| Grok C2-bytes | **Resolved** as a single payload. `03` wire form is the provider `messages` array; recall, scratch, and the speaker line are separate messages after the durable user message; tools JSON is only `RouterRequest.tools_json`. `07` forbids re-encoding. `08` has `append_recall` and `to_router_messages`. The recall signature still has no sentence (I6). |
| Grok C-taint-r2 | **Resolved** as the security property (see R2-C1). Episode segments carry `Provenance`. Quarantine is `CorrectionHold` only; injection is retro-taint. One stale derivation sentence remains (I1). |

## Important

### I1. `02` still states a second fact-origin rule

`02-brain.md` (Episode) says rollup provenance is "the strictest segment origin" and that "Dream
origin for a fact is the strictest origin among its source episodes' rollups." The Fact section
below it, `05`, and `10` set taint to the join of the whole dream-call context (selected
episodes, context facts, correction marks, pre-pass candidates), never from cited `episode_ids`.

"Strictest origin" is not a function: segment provenance is `Taint` plus `SourceRef`s, and
`SourceRef` has no order. An implementer who stops at the Episode paragraph derives taint from
source-episode rollups and ignores untrusted context that is not an episode.

**Change.** Delete those two sentences. Episode taint is the join of its segments. Fact taint is
only the dream-call join defined on Fact.

### I2. `RecallTaintMode` has two enums and opposite defaults

`02-brain.md` and `10-security.md`: `IncludeUntrusted` (default) or `TrustedOnly` (per sensitive
agent).

`08-rust.md` (Honest leaves): `ExcludeUntrusted` default, or `IncludeUntrusted` when the owner
opts in. `08` still says signature changes must land in `08` first, so this paragraph overrides
`02` and `10`.

The safer default does not recreate provenance forgery. It does change which facts enter the
prompt, and the variant names do not match.

**Change.** Copy `10`'s enum and default into `08`. One name, one default.

### I3. The dream apply sequence never records a proposal

`05-dream.md` (schema contract) says an untrusted close or merge of a trusted fact becomes a
proposal, and other operations in that response still apply. Transaction steps 6 and 7 always
"apply merges" and "apply closures." No field list exists for the proposal (fact id, operation,
batch id, taint, owner decision).

**Change.** Add a proposal step to the sequence and a closed record shape. Steps 6 and 7 skip
operations that were recorded as proposals.

### I4. Two contradiction candidates for one fact have no legal double closure

`05-dream.md` requires every `ContradictionCandidate { existing_fact_id, episode_id, … }` to
be answered by exactly one closure or one dismissal. A closure is `{ fact_id, replacement_fact_id }`
and "a fact cannot be closed twice." Two candidates that share `existing_fact_id` cannot both
be closures. The model must dismiss the extras or the batch fails.

N-failure quarantine counts consecutive failures of the same episode **set**. A batch whose
membership changes (new pending episode inside the size cap) resets the counter, so a single
poisoned episode can keep failing inside new sets.

**Change.** Let one closure answer every candidate for that `fact_id`, and require a dismissal
only for candidates that do not close. Count failures per episode id; quarantine that episode
after N.

### I5. Shell identity is no longer the interactive user, and it is still not one identity

`07-computer.md` (api-anything sidecar, Windows console sessions) uses one dedicated local
account, or a restricted token, or an AppContainer, shared by console and sidecar.
`10-security.md` (Shell containment) requires an OS identity distinct per thread (AppContainer
profile per thread, or one account with a per-thread restricted token). That choice is still
"a `REVIEW.md` item," and `REVIEW.md` does not record it, while finding 3 is marked Resolved.

**Change.** State in `07` that each thread has its own sandbox SID. Record the mechanism in
`REVIEW.md`, or keep finding 3 open until that sentence exists.

### I6. `append_recall` cannot build the recall block

`03-thread-cache.md` (Recall block) requires `` `{fact_id}`: {sentence} ``.
`02-brain.md` says `RankedPath` retains walked node ids. `append_recall` in `03` and `08` takes
`&[RankedPath]` and no sentences. The wire form is otherwise one payload.

**Change.** Put the sentence (and fact id) on `RankedPath`, or pass the fact text into
`append_recall`. The bytes of `## recall` must be computable from the arguments alone.

## Minor

1. `02-brain.md` invariant 6 still says "source episode," singular, beside source episode id(s)
   and the dream-call taint join.
2. `07-computer.md` `authorize_peer` takes `BTreeSet<TailnetUserId>` and matches a user.
   `PeerKind::Tailnet` carries `node`, and `10` finding 8 still requires `(user, node)` pairing
   and denial of tagged nodes. The loopback secret rule does not depend on this.
3. `05-dream.md` (Failure handling) still describes only full rejection and pending episodes.
   Dismissals, proposals, and N-quarantine appear in the schema contract and tests, not there.
   `07-computer.md` (Persistent Chrome) still allows a loopback debugging port with a per-launch
   secret; `10` finding 2 still requires pipe only. That is outside C6's session rule and still
   two live rules for browser control.

## Checklist

| `REVIEW.md` item | Result |
| --- | --- |
| R2-C1 taint | Pass with I1, I2, I3 |
| R2-C2 dismissals | Pass with I4 |
| Grok C5 / C6 / C2-bytes / C-taint | Pass as criticals, with I5, I6, I1, I2 |
| Dual re-review Accept | This report is Accept with changes. Not a clean Accept. |

## Required before implementation

1. Delete the episode rollup-origin sentence (I1).
2. Make `08`'s `RecallTaintMode` identical to `10` (I2).
3. Put proposals in the dream apply sequence (I3).
4. Define how multiple candidates for one fact are answered, and count N per episode (I4).
5. One sandbox identity per thread, recorded in `REVIEW.md` (I5).
6. Give `append_recall` the sentence bytes (I6).
