# Use Attribution and Presentation Ledger

## Purpose

Credit converts observable use of prompt memory into durable evidence. It answers which installed
facts actually contributed to a turn, without pretending that prompt residence or provider
attention is observable.

**Slot heat** for a durable memory note or compacted-memory survivor is the sum of accepted
presentation weights credited to that slot in this thread. Compaction reads heat as a pure
ledger fold (`03-thread-cache.md`).

Attribution updates both the thread cache's slot heat and the shared brain through one ledger. That
single write path keeps cache compaction, ACT-R activation, graph edges, inspection, and reversal
consistent.

## Evidence boundary

Routers do not expose reliable attention over prompt slots. Maia therefore credits only matches in
observable turn output, in this order:

1. readable reasoning returned by the router;
2. tool **arguments** (model-authored);
3. the reply, only as the specified fallback when that turn had no readable reasoning.

Tool **results** and web extracts are untrusted data. A match that appears only in a tool result
scores weight `0` unless the same slot also matched in reasoning, a tool argument, or an eligible
reply. Result-only echoes never thicken co-use edges.

Attribution sees only:

- durable slots included in the exact request (request-record ordinals), and
- recall-block items recorded on that same request (item ids + recall-block hash).

A fact elsewhere in the brain, another snapshot, or another thread cannot receive a presentation
from this turn. Scratch paths still cannot accrue heat.

Opaque provider signatures may be echoed inside the current turn's tool round-trips when required
by the provider. They are not readable attribution evidence, are not stored in the durable prefix,
and are not matched as facts. The readable trace is retained on the episode.

## Data model

### Use source

`UseSource` is a closed enum:

- `Reasoning`
- `Tool`
- `Reply`

It is not represented by booleans. Reasoning and tool evidence have full weight. Eligible reply
fallback evidence has half weight.

### Request attribution scope

The scope binds attribution to:

- thread id;
- turn/request id;
- compiled-prefix hash;
- ordered included slot ids and ordinals;
- canonical readable text for those slots;
- readable-reasoning availability state;
- reasoning text when available;
- tool arguments and results;
- reply text.

The scope includes recall-block item ids and their canonical recall text for this request. It
excludes scratch paths. Current-turn scratch is not durable memory and cannot accrue slot heat.
A recall item with an accepted presentation of weight > 0 is **confirmed** and becomes an
installed memory note after that assistant turn (`03-thread-cache.md`).

### Match

A match identifies:

- included slot id and ordinal;
- source span in canonical slot text;
- evidence span in reasoning, a tool argument/result, or reply;
- `UseSource`;
- weight;
- acceptance or rejection status;
- rejection reason, including semantic rejection of the fact.

Matching must retain spans so the Trace inspector can show why credit was awarded. A truthy-only
match with no inspectable evidence is invalid.

### Presentation ledger

One ledger records all accepted use effects for a request:

- stable ledger id;
- thread, turn, request, and compiled-prefix identities;
- accepted presentation entries;
- thread slot-heat updates;
- shared-brain presentation updates;
- co-use edge updates;
- negative correction marks;
- reversal status.

Each presentation entry records the included slot/fact identity, source, weight, evidence span, and
originating thread. The ledger id makes application idempotent.

### Co-use edge update

For two facts used together in the same attributed turn, the edge increment is:

`min(weight_a, weight_b)`

Only accepted fact uses participate. Mere co-residence in the request does not create or thicken
an edge.

### Correction mark

When the next user message corrects a fact or provisional claim used in the preceding turn, Maia
writes a negative mark linked to:

- corrected fact or claim and presentation;
- correcting thread and message;
- correction evidence span;
- time;
- dream-queue item.

The mark does not delete the fact, claim, presentation, episode, or edge history. Immediately on write
it places the corrected item in `CorrectionHold` quarantine so `rank_paths` omits it until the
consolidation dream commits a validity closure or supersession of that item, the dream records a
dismissal of this correction mark (which clears the hold in the same transaction), or an owner clears
the hold. The dream remains responsible for reconciliation; a dismissal that leaves the item current
must still release the hold. Promotion never clears a hold.

## Public contracts and honest signatures

```rust
pub fn attribute_uses(
    scope: &AttributionScope,
) -> Result<AttributionLedger, AttributionError>;
```

`attribute_uses` is an honest core policy operation. All candidate slots and all observable evidence
arrive through `scope`. Its concrete matching logic returns spans and rejection classification; it
has no database, router, clock, port trait, or global-client access.

```rust
pub fn co_use_updates(presentations: &[Presentation]) -> Vec<EdgeIncrement>;
```

`co_use_updates` is pure. It considers accepted positive presentations from one request and uses
the minimum of each pair's weights.

```rust
pub fn correction_mark(
    prior: &AppliedLedger,
    next_message: &CanonicalMessage,
    evidence: &[CorrectionEvidence],
    now: Timestamp,
) -> Result<Vec<NegativeMark>, AttributionError>;
```

The caller supplies time and correction evidence. The function may mark only facts presented by
the immediately preceding turn in that thread. How candidate correction evidence is proposed must
remain outside this leaf and must not mutate history before validation.

```rust
pub fn apply_ledger(
    brain: &mut impl BrainStore,
    ledger: &AttributionLedger,
) -> Result<AppliedLedger, ApplyError>;
```

This is an I/O skin over `BrainStore::apply_ledger`. There is no separate `PresentationStore`.
Application is one database-owner command and one SQLite transaction: thread heat, brain
presentations, co-use edge increments, and negative marks commit together or not at all.

## Attribution sequence

1. Load the stored request record and exact included slot ordinals.
2. Verify that its compiled-prefix hash and identities match the trace being attributed.
3. Build candidates from included durable slots **and** recall-block items on this request.
4. Align candidate text against readable reasoning, if the router returned readable reasoning.
5. Align remaining candidates against tool **arguments**. A match that appears only in a tool
   **result** scores weight `0` and does not create a presentation or co-use edge.
6. If and only if the turn had no readable reasoning (missing or blank), align remaining
   candidates against the reply at half weight.
7. Classify sentences that reject a candidate fact and award them zero.
8. Produce inspectable matches with source and evidence spans.
9. Derive co-use increments from accepted presentations using the minimum pair weight.
10. Write one idempotent ledger transaction to thread heat and the shared brain.
11. When the next message provides correction evidence for the preceding turn, append a negative
    mark and queue the fact for the dream without deleting history.

Source priority prevents a reply from downgrading evidence already observed in reasoning or tools.
The ledger must not count the same identified use twice merely because the same evidence is
encountered during multiple alignment passes.

## Weight rules

- Readable-reasoning match: `1.0`.
- Tool-argument match: `1.0`.
- Tool-result-only match: `0.0` (never a presentation).
- Reply match when the turn had no readable reasoning: `0.5`.
- Reply match when readable reasoning was available: no reply-fallback presentation.
- A sentence that rejects the fact: `0.0`.
- A slot absent from the request: ineligible, regardless of textual similarity.
- Prompt residence, retrieval, and cache survival: `0.0`.

There is no separate presentation floor. A use is either ineligible/zero, an accepted reply
fallback at `0.5`, or an accepted reasoning or tool-argument use at `1.0`. Policy must not invent a smaller
positive weight for weak similarity: below the matcher acceptance boundary, the result is zero.

The default ACT-R decay is independent of these source weights and belongs to ranking policy.

## Invariants

1. A slot absent from a request cannot receive a presentation from that request.
2. Attribution uses the persisted request ordinals, not the current cache state.
3. Reasoning and tool-argument hits are full weight. Tool-result-only matches are weight `0`.
4. Reply hits are half weight only when the turn had no readable reasoning.
5. A rejection scores zero.
6. Residence, retrieval, or survival through compaction is not use.
7. The same logical use updates thread heat and the shared brain through one ledger.
8. Co-use edges thicken only between facts used together, by the minimum hit weight.
9. Every presentation records the thread that caused it.
10. A correction in the next message adds negative history and queues a dream; it does not erase
    history.
11. Opaque provider signatures are neither durable prefix content nor attribution evidence.
12. Ledger application is atomic and idempotent.

## Failure handling

- Reject attribution if the request record, slot ordinals, compiled hash, or trace identity is
  missing or inconsistent.
- Ignore brain facts or cache slots outside the persisted request scope even when their text
  matches strongly.
- Reject non-finite weights, invalid spans, unknown `UseSource` values, or matches whose evidence
  does not lie inside the supplied trace.
- When readable-reasoning availability is unknown, do not assume it was absent and award reply
  credit. Record the turn as unattributable until the state is resolved.
- If rejection classification conflicts with a positive match for the same evidence, award zero
  and retain the conflict for inspection rather than silently strengthening the fact.
- If ledger persistence fails, commit none of the thread-heat, presentation, edge, or negative-mark
  effects.
- Reapplying an already applied ledger id returns the original applied result without duplicating
  weights.
- If correction evidence does not target a fact presented in the immediately preceding turn, do
  not attach it under the "next-message correction" rule.
- A failure to queue the dream must roll back the corresponding negative mark so the ledger does
  not claim follow-up work that was never queued.

## Observability

The stored ledger and Trace inspector expose:

- request and compiled-prefix identities;
- included and excluded slot ids;
- readable-reasoning availability;
- each accepted or rejected match with both spans;
- source and full/half/zero weight label;
- slot-heat and brain-presentation effects;
- every co-use edge increment and its minimum-weight calculation;
- correction marks and linked dream-queue item;
- originating thread for every presentation;
- reversal state and audit identity.

The trace explicitly says when the router returned no readable reasoning, then shows the tool and
reply matches actually scored. Selecting a match selects the same cache slot and brain fact.

Because thread id is stored on every presentation, effects from a background thread can be
inspected and reversed by the later autonomy contract without destroying the immutable audit.

## Testing contract

Required tests use fixed slots and independent expected ledgers:

- A matching fact absent from request ordinals receives no presentation.
- A reasoning match receives weight `1`.
- A tool-argument match receives weight `1`.
- A tool-result-only match receives weight `0`.
- With no readable reasoning, a reply-only match receives weight `0.5`.
- With readable reasoning available, a reply-only match receives no reply-fallback presentation.
- A sentence that rejects the fact receives zero.
- Source priority does not duplicate one identified use across reasoning, tool, and reply passes.
- Two full uses add a co-use edge of `1`; a full and half use add `0.5`.
- Two merely resident slots create no edge and no heat.
- Thread heat and brain presentations commit together or not at all.
- Reapplying the same ledger id does not duplicate effects.
- Attribution after cache changes still uses the historical request snapshot.
- A correction in the immediately next message writes a negative mark, preserves history, and
  queues the fact for dream processing.
- A later or unrelated correction is not attached by the next-message rule.
- Opaque provider signatures do not match and do not appear in durable output.
- Every accepted match contains valid source and evidence spans suitable for UI highlighting.

Tests inject the trace, request scope, time, and transactional store. They do not call a live
router or infer provider attention.

## Explicitly out of scope

- Estimating or reconstructing hidden model attention.
- Awarding credit to every retrieved or installed fact.
- Reply credit when readable reasoning was available.
- Deleting or rewriting history in response to a correction.
- Dream reconciliation, fact merging, or validity closure.
- Defining cache-compaction policy or brain-ranking coefficients.
- Provider-specific opaque-signature persistence.
- Selecting the final concrete text-alignment or correction-evidence algorithm where the approved
  plan does not lock one; any selected implementation must satisfy the evidence-span, rejection,
  scope, and test contracts above.
- Production database or router code during the documentation gate.

## Consistency links

- Product-wide one-ledger and inspectability rules: [`00-goal.md`](00-goal.md)
- Presentation history and co-use graph ownership: [`02-brain.md`](02-brain.md)
- Historical request ordinals, slot ids, heat, and snapshots:
  [`03-thread-cache.md`](03-thread-cache.md)
- Dream queue and correction reconciliation: `05-dream.md`
- Background-thread audit and reversal: `06-agents.md`
- Router reasoning and opaque signature handling: `07-computer.md`
- Core policy and store-port placement: `08-rust.md`
- Shared cache/brain/trace selection: `09-frontend.md`
