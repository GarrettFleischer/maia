# Dream design

## Purpose

Memory organization has two tool-less model steps. Both run off the reply path and neither has tools.

1. **Promotion** runs once per stored episode, as soon as the episode commits. It writes one-sentence
   **provisional claims** into the shared brain with mention edges back to that episode. Promotion is
   what makes knowledge findable from any thread: a claim is rankable immediately, without waiting
   for a dream.
2. **Consolidation** (the dream) runs in batches. It turns provisional claims and queued corrections
   into canonical facts and entity relationships, merges duplicates, closes superseded facts, then
   projects the committed current state into human-readable vault pages.

Episodes are useful immediately through full text, embeddings, and known lexemes. Consolidation is
never required for cross-thread findability. An episode remains searchable while pending and remains
stored after promotion or consolidation.

## Promotion

### Trigger and selection

- Promotion is enqueued when an episode commits. The reply path does not wait for it.
- One structured call per episode. The episode is the whole promotion context.
- Episodes are promoted oldest-pending-first. Only one promotion call runs at a time.
- Policy supplies a daily ceiling on promotion calls and a per-episode input cap (`10-security.md`).
  A capped episode stays stored and searchable with no claims until a later promotion succeeds.

### Promotion input and taint

The input contains exactly one episode: its stable ID, timestamp, participants, raw exchange, and
readable reasoning trace when present. It does not include existing facts, claims, or vault text.
Promotion therefore cannot see or touch canonical state, and its taint is the episode's taint
(the join of its segments, `02-brain.md`). No model-supplied field can change that taint.

### Promotion schema

There is exactly one structured model call per episode. Its response must conform to this logical
schema. Objects reject unknown fields.

```json
{
  "claims": [
    {
      "id": "claim_01JXYZ",
      "sentence": "The project is named Bob's Best Burgers.",
      "episode_id": "episode_01J001"
    }
  ]
}
```

- `claims` is a required array and may be empty.
- `id` is a non-empty opaque ID that is new to the brain.
- `sentence` is one non-empty declarative sentence with no Markdown list marker, stable ID, or
  frontmatter.
- `episode_id` must equal the single episode in the input. It is provenance for inspection and
  cannot lower taint.
- Claims may not reference facts, entities, or other claims. Promotion creates no merges, closures,
  dismissals, or entities.
- The response may not contain a tool-call channel. Any tool-call channel fails the call with no
  mutations.

### Promotion apply

The runner validates syntax, the episode ID, and sentence shape before opening one brain transaction.
In that transaction it:

1. Inserts each claim as `Provisional`, with taint equal to the episode taint and `valid_from` equal
   to the episode timestamp.
2. Inserts a mention edge from each claim to the episode.
3. Derives lexeme edges from the claim sentence using the configured lexical policy (stopwords and
   high-fan terms excluded). Lexemes are deterministic, not model output.
4. Marks the episode `promoted` (with the call's model identity and injected `now` recorded for
   inspection).

Promotion does not deduplicate. Because it sees one episode, the same sentence promoted from two
episodes yields two claims with two mention edges. Consolidation resolves that duplication through
the normal pre-pass and merge path.

Any error rolls back the whole transaction. The episode remains stored and searchable, and promotion
is retried on a later trigger. A promotion never touches canonical facts, so it cannot close or merge
a trusted fact.

### Promotion failure

Parse errors, schema errors, unknown IDs, or a wrong `episode_id` apply nothing. Failures are counted
per episode. After `N` failures (policy; default 3), the episode is quarantined from promotion and
shown in the inspector. The episode itself is never removed.

## Consolidation (dream)

A consolidation wakes when any one of these conditions is true:

- there are 20 unconsolidated provisional claims;
- Maia has been idle for 30 minutes and at least one unconsolidated claim is pending; or
- a person explicitly requests a dream.

Twenty claims and 30 minutes are configuration defaults passed into policy, not discoveries made
inside it. Selection builds taint-homogeneous batches (Trusted or Untrusted), oldest-pending-first
within each partition, up to the configured batch size. Only one consolidation batch may run at a
time. A claim that has not yet been consolidated stays rankable.

The runner has a router boundary for its one structured extraction call and a vault boundary for
projection. It has no `Tools` parameter or tool host and cannot call the shell, browser, Scrapy,
or api-anything.

## Consolidation inputs and pure pre-pass

The consolidation batch input contains:

- the selected unconsolidated provisional claims, each with its sentence, taint, and mention edges
  to its source episodes;
- the source episodes for those claims, with stable IDs, timestamps, participants, raw exchange, and
  readable reasoning trace when present;
- current canonical facts and claims that share known subjects or lexemes with the selected claims;
- queued negative correction marks relevant to those facts and claims; and
- duplicate and contradiction candidates from the pure pre-pass.

The pre-pass is a deterministic function of those values. It proposes pairs only; it does not
insert, merge, close, or rewrite anything. At minimum it emits:

```text
DuplicateCandidate { left_fact_id, right_fact_id }
ContradictionCandidate { existing_fact_id, episode_id, subject_key }
```

Candidate ordering is stable by IDs. The same input produces the same candidates. Stopwords and
high-fan lexemes are governed by the brain design, not rediscovered by the model.

Human-region prose is not extraction input. The structured call organizes episodes and existing
brain facts, not private editorial notes in the vault.

## Structured consolidation batch schema

There is exactly one structured model call for a selected batch. Its response must conform to this
logical schema; all objects reject unknown fields:

```json
{
  "entities": [
    {
      "id": "entity_obsidian",
      "slug": "obsidian",
      "description": "A local Markdown knowledge-base application.",
      "scope": { "kind": "world" },
      "see": ["entity_maia"]
    },
    {
      "id": "entity_scout_preference",
      "slug": "vault-preference",
      "description": "Scout's private vault preference.",
      "scope": { "kind": "agent", "agent_id": "agent_scout" },
      "see": []
    }
  ],
  "canonical_facts": [
    {
      "id": "fact_01JABC",
      "entity_id": "entity_obsidian",
      "sentence": "Obsidian opens Maia's vault for human editing.",
      "claim_ids": ["claim_01JXYZ"],
      "episode_ids": ["episode_01J001"]
    }
  ],
  "merges": [
    {
      "duplicate_fact_id": "fact_older_duplicate",
      "canonical_fact_id": "fact_01JABC"
    }
  ],
  "closures": [
    {
      "fact_id": "fact_outdated",
      "replacement_fact_id": "fact_01JABC"
    }
  ],
  "dismissals": [
    {
      "existing_fact_id": "fact_unrelated",
      "episode_id": "episode_01J001",
      "subject_key": "lexeme:vault",
      "reason": "different subject despite shared lexeme"
    }
  ]
}
```

The schema contract is:

- `entities`, `canonical_facts`, `merges`, `closures`, and `dismissals` are required arrays, including
  when empty.
- `claim_ids` lists the provisional claims a canonical fact consolidates. Every listed claim must be
  in the batch and still `Provisional`. Once a canonical fact consolidates a claim, the claim is
  superseded for ranking: it is excluded from candidates and the canonical fact is preferred. The
  claim row and its mention edges remain as history.
- A claim that a batch does not consolidate stays `Provisional` and rankable. An omission is not a
  failure.
- A dismissal is
  `{ "existing_fact_id", "episode_id", "subject_key", "reason" }` and asserts that a pre-pass
  candidate pair does **not** contradict. `subject_key` is the same key the pre-pass used for that
  candidate, so two candidates that share a fact and episode remain distinct.
- **Every** pre-pass contradiction candidate must be answered. One closure of `fact_id` answers
  every candidate whose `existing_fact_id` is that fact. Each remaining candidate needs exactly one
  `dismissals` entry keyed by `(existing_fact_id, episode_id, subject_key)`. An unanswered
  candidate fails the batch with no mutations. Dismissals are stored for inspection and do not
  close facts. Dismissing a correction mark clears that fact's `CorrectionHold` in the same
  transaction.
- Fact taint is **not** taken from the model. The apply step sets every new fact/entity/merge/
  closure's taint to the **dream-call context taint**: the join over everything the call saw
  (selected episodes, context facts, correction marks, pre-pass candidates), per
  `10-security.md` Memory and dream integrity. The model's `episode_ids` and any optional
  `origin` field are inspection-only and cannot lower taint (defeats provenance forgery).
- Batches are **taint-partitioned**: a call contains only Trusted or only Untrusted episodes
  (oldest-first within the partition). A Trusted batch's context facts are Trusted-only.
- When an Untrusted batch would close or merge a Trusted fact, the apply transaction records a
  **proposal** instead of applying that operation; the owner accepts or rejects at `Confirm`. Other
  valid operations in the same response still apply in one transaction.
- Failures are counted **per episode id**, across batches regardless of membership. After `N`
  failed batches containing an episode (policy; default 3), that episode is quarantined from
  selection, a security/UI event names it, and later batches proceed without it. The owner may
  release it from the inspector.
- The structured call is sent with `tools: []`. Any tool-call channel in the response fails the
  batch with no mutations.
- IDs are non-empty opaque stable IDs. Every reference resolves either to a current brain record
  or to an object in this response. An ID may not change the identity or scope of an existing
  record.
- `slug` is a unique lowercase ASCII path segment within its scope and contains only `a-z`, `0-9`,
  and single `-` separators. It is a path choice, not identity.
- `description` obeys the vault's single-line description contract.
- `scope` is a tagged union: `{ "kind": "world" }` or
  `{ "kind": "agent", "agent_id": "<existing participant agent>" }`. A mystery boolean is not
  accepted.
- `see` contains entity IDs. The runner resolves these to vault-relative wikilinks after identity
  validation.
- `sentence` is one non-empty declarative sentence. It contains no Markdown list marker, stable ID,
  or frontmatter.
- `episode_ids` is a non-empty, duplicate-free list drawn only from the source episodes of the
  selected claims. Provenance is never invented or discarded.
- A merge marks one duplicate as noncanonical and preserves both records and provenance. It does
  not delete history. IDs must differ.
- A closure ends a current fact's validity window. `replacement_fact_id` is either a new/current
  fact or `null` when a correction retracts a claim without replacing it. Closure never changes
  the closed fact's sentence or source episode IDs.
- One fact cannot be both a duplicate source and a closure target in the same response. A fact
  cannot be closed twice, merged twice, or reference itself.

The runner validates syntax, references, scopes, provenance, current-state preconditions, and graph
consistency before opening the apply transaction. It derives a new fact's `valid_from` from the
latest timestamp among its source episodes. A closure's `valid_to` is the replacement's
`valid_from`, or the runner's single injected `now` for a retraction. The model does not read the
clock.

## Vault Markdown projection

An accepted world entity projects to `world/entities/<slug>.md`; an agent-scoped entity projects to
`agents/<agent>/entities/<slug>.md`. Entity Markdown follows
[the vault region contract](01-vault.md#human-and-generated-regions):

```markdown
---
id: entity_obsidian
description: A local Markdown knowledge-base application.
see:
  - "[[world/entities/maia]]"
kind: entity
---
<!-- maia:generated:start -->
- `fact_01JABC`: Obsidian opens Maia's vault for human editing.
<!-- maia:generated:end -->
<!-- maia:human:start -->
## Notes

This prose remains byte-for-byte unchanged.
<!-- maia:human:end -->
```

Only current, canonical facts appear in the generated region. Closed and duplicate facts remain in
the brain for history and attribution but are omitted from the projection. Facts sort by stable ID.
For a new entity, the dream creates canonical frontmatter. For an existing entity, it validates
that the frontmatter ID matches the brain and replaces only the generated region. It must copy the
human-region bytes exactly and must never target `personality.md`.

Every affected folder index is regenerated from child frontmatter after entity pages are replaced.
The generated index contains descriptions and links, never child bodies.

## `map` and `read` boundary

The full contract is in [01-vault.md](01-vault.md#map-and-read-contracts). Dreaming does not weaken
it:

- `map` may supply root/folder indexes or one file's frontmatter, but never a non-index body.
- `read` returns the exact post-frontmatter body only for an explicitly named note.
- The vault projection reads an existing target entity body solely to locate and preserve its
  human bytes. Those bytes are not sent to the extraction model.
- Neither `map` nor `read` starts a promotion or dream, follows `see` links, or writes a file.
- Promotion and consolidation use committed brain records, not generated Markdown, as the
  authoritative state.

## Transaction sequence

The model response is applied in exactly one SQLite transaction. The subsequent filesystem
projection is intentionally not represented as part of that transaction.

1. **Select and call.** The serialized consolidation runner snapshots the oldest unconsolidated
   provisional claims, their source episodes, and relevant current facts and claims, runs the pure
   pre-pass, reads `now` once at the I/O skin, and makes one structured model call.
2. **Validate before mutation.** Parse the complete response and validate the schema and all
   references against the snapshot. Any error rejects the entire response; no partial result is
   applied.
3. **Begin one brain transaction.** Recheck that selected claims are still `Provisional` and
   referenced facts are still in the snapshotted current state. A mismatch rolls back and makes the
   response stale.
4. **Record the batch.** Store the batch ID, selected claim and episode IDs, pre-pass candidates, raw
   structured response, model identity, and injected `now` for inspection.
5. **Apply entities.** Insert new identities. For existing identities, require the returned
   description, links, slug, and scope to match the stored identity; a rename or metadata change
   requires a later explicit design rather than an implicit dream rewrite.
6. **Divert protected operations.** In an Untrusted batch, every merge or closure that targets a
   Trusted fact is written as a proposal instead of applied:

   ```rust
   struct DreamProposal {
       id: ProposalId,
       batch_id: DreamBatchId,
       operation: ProposedOperation, // Merge { duplicate, canonical } | Close { fact, replacement }
       target_fact: FactId,
       batch_taint: Taint,           // always Untrusted
       created_at: Timestamp,
       decision: ProposalDecision,   // Pending | Accepted { by } | Rejected { by }
   }
   ```

   The owner decides at `Confirm`. Accepting applies the operation in its own transaction.
7. **Apply canonical facts and merges.** Insert new canonical facts with context taint, sources, and
   validity starts. Mark each consolidated claim superseded by its canonical fact, without deleting
   the claim. Mark duplicate facts merged into their canonical facts without deleting either record.
   Skip merges diverted in step 6.
8. **Apply closures and dismissals.** Set validity ends and replacement links, preserving each
   closed fact and its episode provenance. Skip closures diverted in step 6. Store dismissals.
   A dismissal of a queued correction mark clears that fact's `CorrectionHold` here.
9. **Finish brain state.** Mark selected claims consolidated, consume applicable queued correction
   marks (each either closed or dismissed with hold release), and enqueue one vault projection
   record listing affected entity IDs and folders.
10. **Commit once.** Entities, canonical facts, claim supersessions, merges, closures, dismissals,
    proposals, claim status, correction consumption, hold releases, and the pending projection become
    visible together. Any database error rolls all of them back.
11. **Project after commit.** Derive pages from committed brain state, stage complete bytes, verify
    source hashes, replace entity pages, regenerate indexes bottom-up, and mark the projection
    complete.
12. **Embed after commit.** New claim vectors (from promotion) and new canonical fact vectors (from
    consolidation) are produced by an idempotent embedder job outside the SQLite transaction. A claim
    or fact without a vector yet remains reachable through lexemes and full text (`02-brain.md`).
    Embedding failure does not reopen the batch or call the extraction model again.

The SQLite transaction is the atomic source-of-truth update. SQLite and the filesystem do not
provide a shared atomic commit. The durable pending projection closes that gap: after a crash,
projection resumes from committed brain state without another model call. Rendering and replacement
must therefore be idempotent.

## Invariants

1. One promoted episode causes exactly one structured promotion call, and one selected consolidation
   batch causes at most one structured consolidation call.
2. A consolidation batch's entities, canonical facts, claim supersessions, merges, closures,
   dismissals, proposals, claim status, correction consumption (including hold releases), and
   projection intent commit together or not at all.
3. Raw episodes, old facts, provenance, merges, closures, and negative marks are not erased to make
   the current view simpler.
4. A newer fact closes an older contradictory fact; it does not overwrite it.
5. The human region of every existing entity page is byte-identical before and after a dream.
6. A dream never writes `personality.md`.
7. The dream runner has no shell, browser, Scrapy, api-anything, or general
   tool-host capability.
8. Generated Markdown is a deterministic projection of committed current facts and entity
   metadata; it is not the source of truth.
9. Every stored episode remains searchable whether or not it has been promoted or consolidated.
10. Promotion never reads or writes canonical facts, merges, or closures.
11. A claim superseded by a canonical fact is excluded from ranking candidates but is never deleted.

## Failure handling

- A router timeout, malformed structured response, schema error, unknown ID, invented episode
  provenance, invalid scope, or contradictory operation applies nothing. The selected claims
  remain `Provisional` and rankable, and the episodes remain searchable. The failed call and parse
  error may be audited, but its content is not treated as memory.
- Because one batch permits one consolidation call, the runner does not automatically call the model
  again for that batch. A later trigger may select the still-unconsolidated claims into a new batch.
  Each failure increments the per-episode failure counter; at `N` the episode is quarantined from
  selection and shown in the inspector.
- A promotion failure applies nothing and leaves the episode stored and searchable. The episode is
  retried on a later trigger and quarantined after `N` promotion failures, as above.
- An unanswered contradiction candidate is a validation failure. A dismissed false positive is
  applied normally, leaves the existing fact current, and clears any `CorrectionHold` on that
  fact when the dismissal answers a correction mark.
- **Panic.** Engaging panic cancels promotion and consolidation admission and any in-flight model
  call from either. A brain transaction that has already committed still finishes its vault
  projection. No new promotion or dream starts while the latch is set.
- An Untrusted batch that would close or merge a Trusted fact is not a failure: that operation
  becomes a pending proposal and the rest of the response applies.
- A stale snapshot discovered at transaction start rejects the response rather than merging it
  against changed state.
- Any SQLite error rolls back the entire apply transaction and leaves episodes pending.
- A crash or I/O failure after commit leaves a durable pending projection. Retry renders from the
  committed brain and does not call the model again.
- Before replacing an existing entity file, the runner compares its current hash with the bytes
  read for rendering. A concurrent human edit causes that file to be restaged, never overwritten.
- Missing or malformed human/generated markers block that entity write and preserve the original
  file. Other already-written pages remain valid projections; the overall projection stays pending
  until every target and index succeeds.
- A permission or disk-full error preserves old target bytes where atomic replacement is
  supported, records the projection error, and retries only the filesystem phase.
- A process restart scans durable pending projections before scheduling new dream work.

## Testing contract

The contract is proven with pure fixtures, a scripted router, an in-memory/test SQLite
implementation, and a temporary real vault:

- Promotion trigger: assert a committed episode enqueues exactly one promotion; assert the reply
  path returns before the promotion call completes.
- Promotion schema: table-test unknown fields, a `episode_id` that differs from the input episode,
  a non-declarative or multi-sentence `sentence`, and a tool-call channel; each applies nothing.
- Promotion findability: after promotion commits, a fixture query mentioning a hint from that
  episode ranks its provisional claim before any consolidation batch runs.
- Promotion taint: a claim from an Untrusted episode is `Untrusted` even when the model's output
  is otherwise valid; promotion cannot close or merge a canonical fact.
- Promotion atomicity: inject a failure after each promotion apply step and assert no claims,
  mention edges, lexeme edges, or promoted status escape.
- Promotion quarantine: after N promotion failures the episode leaves promotion selection and stays
  searchable.
- Consolidation trigger policy: assert 20 unconsolidated claims, 30 idle minutes with pending claims,
  and explicit request each wake; assert idle with no pending claims does not.
- Consolidation supersession: a canonical fact listing a claim in `claim_ids` removes that claim from
  ranking candidates, keeps the claim row and its mention edges, and leaves the claim unconsolidated
  if the batch does not list it.
- Selection: assert taint-partitioned oldest-first batching and one active runner.
- Taint: a batch that includes any web/tool episode yields only `Untrusted` facts even when the
  model cites only owner episodes; an untrusted closure of a trusted fact becomes a proposal.
- Dismissals: a false-positive candidate dismissed keeps the existing fact current; an unanswered
  candidate fails; after N failures the episode leaves selection.
- Pre-pass: use hand-authored duplicate/contradiction fixtures and assert deterministic ordered
  candidates without writes.
- Structured schema: table-test every required field and invalid relationship, including unknown
  fields, missing provenance, cross-scope IDs, self-merges, and double closure.
- Call count: a scripted router records exactly one call for an accepted batch and no tool-host
  invocation is possible from the runner type.
- Atomic apply: inject a failure after each transaction step and assert no entities, facts, merges,
  closures, dreamed flags, consumed corrections, or projection intent escape.
- Validity: assert `valid_from` derives from source episodes, replacement closure times align, and
  the old fact and its provenance remain queryable.
- Stale state: mutate a referenced fact between response validation and transaction start; assert
  the entire result is rejected.
- Projection: assert only current canonical facts render, stable IDs appear, ordering is
  deterministic, and indexes contain only links and descriptions.
- Human preservation: include non-ASCII text, CRLF, blank lines, and trailing spaces; compare the
  pre/post human byte slices for exact equality.
- Protected files: attempt to resolve an output to `personality.md`; assert the transaction or
  projection is rejected before a file write.
- Crash recovery: commit, simulate a crash before the first file and midway through files, restart,
  and assert convergence to the same bytes as an uninterrupted run with no additional model call.
- Concurrent edit: alter a human region after staging; assert the edit survives and projection
  retries against the new source hash.
- Map/read noninterference: place a sentinel secret in a human region and assert it appears in
  neither map/index output nor the model request.

The independent oracle for transaction tests is a complete table dump before and after each
injected failure. The independent oracle for projection tests is checked-in expected Markdown
bytes, not output parsed and re-rendered by the implementation under test.

## Explicitly out of scope

- A model call on the reply path, or any model call inside retrieval. Promotion runs after commit,
  off the reply path.
- Model-based retrieval or reranking.
- Deleting raw episodes, claims, closed facts, duplicate facts, correction marks, or provenance.
- Activation, PageRank, embedding generation, lexeme admission, and prompt ranking.
- Prompt-cache compaction or attribution scoring.
- Editing human prose, personalities, or arbitrary Markdown notes.
- Shell commands, browser automation, Scrapy crawls, api-anything calls, and
  challenge handling.
- Cross-machine vault synchronization or pretending SQLite and filesystem writes are one atomic
  transaction.
- Frontend presentation of dreams beyond exposing durable state for later inspector work.

## Related designs

- [00-goal.md](00-goal.md) — why promotion makes memory findable and dreams organize it, both off the message path.
- [01-vault.md](01-vault.md) — frontmatter, regions, map/read, and index contracts.
- [02-brain.md](02-brain.md) — episodes, claims, facts, validity, graph nodes, and retrieval.
- [03-thread-cache.md](03-thread-cache.md) — durable prompt slots and turn-local recall that consume ranked claims and facts.
- [04-credit.md](04-credit.md) — presentations, corrections, and negative marks queued for dreams.
- [06-agents.md](06-agents.md) — participant identities and agent-private entity scope.
- [08-rust.md](08-rust.md) — port boundaries and the prohibition on a `Tools` parameter here.
