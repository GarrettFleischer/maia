# Durable Thread Cache

## Purpose

The thread cache gives each conversation a long-lived, provider-cache-friendly prompt prefix.
After restart, replaying the same durable thread log must produce exactly the same bytes. Memory
can be appended where its use occurred and later compacted, but ordinary turns never silently
rewrite or reorder the installed prefix.

The cache minimizes repeated context tokens without becoming evidence that a memory was used.
Use credit is a separate traced operation defined in `04-credit.md`.

## Ownership and identity

Each thread owns one ordered durable slot list in SQLite.

- A direct user-agent thread has one list.
- An agent-agent thread also has one shared list, even though it appears under each participant in
  the UI.
- Different threads never share a prompt cache.
- Facts in the brain may be shared, but installing a fact into one thread does not install it into
  another.

The SQLite-backed `ThreadLog` is an I/O port. Compilation and compaction decisions are pure core
operations over values supplied by the caller.

## Data model

### Thread log

The durable log is append-only evidence from which the current ordered slot state is replayed.
Logical records include:

- thread id;
- participant agent ids;
- canonical tool-schema and `agents.md` excerpt inputs;
- persona slot inputs;
- user and assistant turns;
- installed memory notes with their insertion cursor;
- compaction records containing the resulting canonical grouping;
- per-request records;
- turn snapshots.

Compaction is represented durably so replay after restart yields the compacted state. It is the
only operation allowed to replace the prior grouping of durable prefix material.

### Slot

Every slot has:

- stable slot id included in its canonical text;
- slot kind;
- canonical text bytes;
- durable ordinal in the compiled request;
- provenance, including source fact/episode where applicable;
- installation cursor;
- creation turn;
- latest use-hit turn for compaction policy.

Slot kinds cover the fixed prefix material, personas, compacted memory, transcript turns, and
installed memory notes. The scratch suffix is not a slot because it is not durable.

Canonicalization must define all separators, line endings, encodings, labels, id rendering, and
empty sections. Platform-native line endings or locale-sensitive formatting may not alter bytes.

### Untrusted-slot envelopes

Durable slots whose provenance is `Untrusted` wrap their body in an advisory envelope. The
envelope is part of the slot's canonical text and therefore part of the durable prefix hash.
Recall-block lines never use this envelope: they stay `` `{item_id}`: {sentence} `` and carry
taint only on the request record (`10-security.md` `request_provenance`).

Grammar (UTF-8, LF only), version `1`:

```text
<<maia:untrusted id={slot_id} source={provenance_label} v=1>>
{body}
<<maia:end id={slot_id}>>
```

Rules:

- `{slot_id}` is the stable slot id already required in canonical text.
- `{provenance_label}` is a short closed label such as `web`, `console`, `vault`, `agent`, or
  `join` (join of several untrusted sources). It is advisory for readers.
- Any occurrence of the byte sequence `<<maia:` inside `{body}` is escaped as `<<maia\:` before
  the body is stored, so the closer cannot appear as content.
- The envelope version is frozen on the slot at insertion. A later renderer version may wrap
  **new** Untrusted slots differently; it must not rewrite existing slot bytes (cache identity).
- Trusted slots have no envelope. Compaction survivors that remain Untrusted keep the envelope
  version they were stored with.
- No sink check, grant decision, or credit weight reads the envelope. Provenance comes from the
  request record and slot metadata (`10-security.md`).

### Recall block (turn-local, non-durable)

After durable compilation and before the scratch suffix, the request builder appends a
**recall block** produced from `rank_paths` for this turn. The recall block:

- is excluded from the durable prefix hash;
- carries sentences of provisional claims and canonical facts, each with its stable `claim_…` or
  `fact_…` id (never vault paths alone);
- is recorded on the request record as ordered item ids plus a hash of its bytes so attribution
  can replay;
- may be credited by `attribute_uses` (see `04-credit.md`);
- never accrues heat until an item is installed as a durable memory note.

**Recall query.** The query text is the current user message body plus the last assistant turn
body when one exists; otherwise the current user message alone. The I/O skin embeds that query
once and passes the vector into `rank_paths`.

**One rank per user turn.** Ranking runs once when the user (or inter-thread) message opens the
turn. Every in-turn tool request reuses that same ranked list and recall-block bytes. A new
user message ranks again.

**Dedupe and budget.** Candidates whose item id is already installed as a durable memory note in
this thread are excluded before packing. A provisional claim is also excluded when a canonical
fact that consolidated it is already installed in this thread, and a canonical fact is excluded when
one of its source claims is already installed. This keeps one sentence per lineage in the block. The
packed block must fit `RankPolicy.recall_token_budget`
(token estimate from the same estimator as the prefix budget). Excess paths are dropped in ranked
order after the budget fills.

Grammar (UTF-8, LF only):

```text
## recall
`{item_id}`: {sentence}\n
```

Empty recall is the header alone followed by a blank line. No other text is permitted in the
block. Ranked order is the order emitted by `rank_paths` after stable-id tie-break.

### Installed memory note

**Confirmed** means: the recall item (or already-installed note) received an accepted presentation
with weight strictly greater than zero in that request's attribution ledger.

A confirmed memory note records the stable item id (`claim_…` or `fact_…`, or episode id for a second
load) and canonical text. Its insertion cursor is immediately after the assistant turn that credited
it. Once inserted, that cursor never moves during ordinary appends.

**First install** stores the sentence exactly as it appeared in the recall block. No model call
writes a summary on the message path.

**Consolidation does not rewrite installed notes.** When a claim that is installed in a thread is
later consolidated into a canonical fact, the installed note keeps the claim sentence. The canonical
fact is a new item. It can be credited and installed as its own note under the same rules. Earlier
installed bytes never change in place, consistent with invariant 12 and the compaction rules.

**Second load** of the same source episode appends that episode's full text as a new note. It does
not edit the first note in place. Both remain until a later compaction decides the new grouping.
"Load" is an explicit user or inspector action that requests the episode body; it is not automatic
on every hit.

### Compacted memory block

The compacted memory block is empty until the first compaction. A compaction selects survivors
among **installed memory notes and the compacted block only**, regroups them once into canonical
content without a model call, and stores the result. It is not recomputed on every compile.
Transcript turns, tool schemas, personas, and constitution slots are never compaction inputs.

### Request record

Every router request stores:

- thread id and turn/request id;
- exact slot ordinals included;
- compiled-prefix hash;
- recall-block item ids and recall-block hash (when recall is non-empty);
- provider-reported cached-token count;
- total prompt size needed to compare the cache hit;
- applicable snapshot id.

Turn-local opaque provider signatures are excluded from the durable prefix.

### Snapshot

A snapshot records the compiled slot order and identities for a request so the inspector can show
historical cache state. It references canonical durable data rather than becoming a second source
of prompt truth.

## Canonical byte order

All durable bytes are UTF-8 with LF line endings. Section headers are exactly the lines shown.
Empty sections still emit their header.

Durable prompt, front to back:

1. `## tools\n` + canonical JSON of `tools` (sorted by tool name; same bytes hashed into the
   prefix and sent as `RouterRequest.tools_json`). Then `## agents\n` + the `agents.md` excerpt
   frozen at thread start from the owner-approved content hash (`01-vault.md`; exact bytes and
   hash stored on the first request record).
2. `## personas\n` + each participant persona, sorted by stable `AgentId`, each from that agent's
   owner-approved `personality.md` hash, each prefixed `` `agent:{id}`:\n ``.
3. `## memory\n` + the compacted memory block (empty block is the header alone + `\n`).
4. `## transcript\n` + turns and installed memory notes in log order. Each turn is
   `` `{role}:{turn_id}`:\n{body}\n ``. Installed notes are
   `` `mem:{item_or_episode_id}`:\n{text}\n `` at their fixed cursors.
5. `## user\n` + the current user (or inter-thread) message already appended to the durable log.

**Total order of the outbound request after the durable prefix:**

1. durable prefix (hashed);
2. recall block (hashed separately; not in prefix hash);
3. scratch suffix of vault paths proposed this turn (not stored);
4. for agent-agent threads only, speaker line `` `speaker:{agent_id}`\n `` (not durable; not in
   prefix hash).

Persona order remains agent-id order and does not change with the speaker. Agent-agent turns use
fixed roles on the wire: the human-authored constitution/agents material stays `system`; every
agent utterance is `assistant` with the speaker id in content; the next speaker's cue is the
non-durable speaker line. Roles do not flip with the speaker.

Opaque provider tool state stays out of the durable prefix. Within a turn it is attached only to
the assistant tool-call message for that provider round-trip. The next turn therefore shares the
durable prefix through the prior user message and diverges at in-turn tool state; that cache cost
is accepted and documented.

## Wire form

Owned by this document; consumed by `07-computer.md`.

```text
messages = [
  { role: "system", content: agents + personas + memory },  // no tools JSON here
  ...transcript turns as user|assistant messages in order,
    including installed notes as assistant messages labeled `mem:{id}`...,
  { role: "user", content: current user message },          // durable; content fixed at append
  // non-durable trailing instructions AFTER the user message;
  // placement from RouterCapabilities.trailing_instruction_placement
]
tools = <canonical tools JSON only in RouterRequest.tools_json / provider `tools`>
```

Trailing instructions are the recall block, optional scratch paths, and (agent-agent only) the
speaker line. Placement is chosen once per provider at startup from
`RouterCapabilities.trailing_instruction_placement`:

- `TrailingSystem`: each instruction is a `system` message after the durable user message
  (default when the provider preserves mid-conversation `system` order).
- `TrailingUserPart`: the same texts are concatenated, in that order, into one trailing `user`
  message after the durable user message (used when the provider hoists or rejects later
  `system` messages).

Empty recall is still emitted as the header-only block under `TrailingSystem`, or as that header
text inside the trailing user part under `TrailingUserPart`, so the request record always has a
recall hash when ranking ran. Scratch and speaker lines are omitted when empty or not applicable.

Turn labels (`` `{role}:{turn_id}`: ``) exist only in the hashed durable bytes. A message's wire
`content` is its body, fixed when the turn is appended, and never changes when that message moves
from `## user` into `## transcript`. Installed notes keep their `` `mem:{id}` `` label because it
is part of the note body at install time. Agent utterances in agent-agent threads carry the
speaker id in the body, also fixed at append.

The durable `## tools` section exists for prefix hashing and inspection only; it is not
duplicated into `messages`. Two consecutive requests MUST produce provider JSON whose common
prefix extends through the previous user message (recall/scratch/speaker never rewrite that
message). The placement mode is stored on the request record. Red tests assert identical
serialized bytes for message N across turns N and N+1 under each placement mode.

## Public contracts and honest signatures

```rust
pub fn compile_prompt(log: &ReplayedThread) -> Result<CompiledPrefix, CompileError>;
```

`compile_prompt` is an honest leaf. It returns canonical bytes plus the ordered slot ids and
ordinals used to produce those bytes. It performs no I/O, reads no clock, and does not include
scratch data.

```rust
pub fn append_recall(
    prefix: &CompiledPrefix,
    ranked: &[RankedPath],
) -> Result<CompiledWithRecall, CompileError>;

pub fn append_scratch(
    with_recall: &CompiledWithRecall,
    proposed_paths: &[VaultPath],
) -> Result<CompiledRequest, CompileError>;
```

Both are pure. They create turn-local request bytes without mutating the durable log or changing
the prefix hash. `append_recall` renders each `` `{item_id}`: {sentence} `` line from the `RecallItem`
id and sentence carried on `RankedPath`, and records item ids plus the recall-block hash for the
request record.

```rust
pub fn should_compact(
    state: &CompactionState,
    policy: &CompactionPolicy,
) -> CompactionDecision;
```

`CompactionPolicy` supplies:

- the centroid-distance threshold and required consecutive-turn count (default `2`);
- the centroid window `N` (default `8`);
- the unused-slot turn window (default `6`);
- `min_interval_turns` (default `3`);
- the memory portion of the prefix byte/token budget;
- the separate transcript budget;
- the slot-heat floor for survivors.

The decision reports which trigger fired; it does not read a clock, database, or global config.

```rust
pub fn compact(
    slots: &[CacheSlot],
    decision: &CompactionDecision,
    policy: &CompactionPolicy,
) -> Result<CompactionRecord, CompactionError>;
```

`compact` deterministically chooses the survivors required by the supplied decision and regroups
them once. The durable `ThreadLog` skin appends the resulting record transactionally.

The `ThreadLog` port supports append and replay. It does not own compilation policy.

## Request sequence

1. Append the current user message or inter-thread message to the thread log.
2. Replay durable records into one ordered thread state.
3. Compile canonical durable bytes through the current user message; hash them.
4. On the first request of this user turn, rank recall once (query, participants, quarantine,
   policy); `append_recall`; record ranked paths, item ids, and recall-block hash on the turn.
   Later tool requests in the same turn reuse that recall block without re-ranking.
5. Optionally `append_scratch` with vault paths for this turn.
6. Map to wire form using the request's trailing-instruction placement; call the router.
7. Store the request record (prefix hash, recall hash, placement mode, provider cached-token
   count, and the join of included-slot and recall-item taints as request provenance).
8. Attribute use against durable slots **and** recall items in that request.
9. Append assistant/tool activity; install each credited recall item as a durable memory note at
   the cursor after this assistant turn, in stable-id order.
10. Store a snapshot for inspection.
11. Evaluate compaction. If triggered and fixable, append one durable compaction record;
    consecutive turns cannot both compact (`min_interval_turns`).

## Compaction triggers and behavior

Compaction is **model-free**. It never calls the router. Regrouping that needs a model belongs in
a dream batch.

Eligible slots for triggers and survivors: installed memory notes and the compacted memory block.
Fixed prefix slots (tools, agents, personas) and transcript turns never trip triggers and are
never dropped by compaction. The transcript budget is separate: when the transcript alone exceeds
the configured transcript budget, compaction returns `Unfixable` without rewriting, and the
scheduler moves the thread to `Sleeping { reason: TranscriptBudget }` with a visible banner and a
"start a new thread" action (`06-agents.md`). Transcript summarization is out of scope for v1
message-path compaction.

Compaction runs when any locked trigger is true **and** at least `min_interval_turns` (default 3)
have passed since the last compaction record:

- **Centroid drift:** among the last `N` installed-memory embeddings (policy; default `N=8`), the
  mean cosine distance from the compacted-block centroid exceeds the threshold for two consecutive
  turns.
- **Unused installed memory:** an installed memory note has received no use-hit for six turns.
- **Memory budget:** installed memory + compacted block exceed the memory portion of the prefix
  budget.

**Slot heat** is the sum of accepted presentation weights on that slot in this thread
(`04-credit.md`). It is a pure fold of the ledger; compaction reads it as an input.

Survivor predicate (pure): keep notes whose slot heat is at or above the policy floor, prefer
higher heat then newer install time then stable id; pack until the memory budget fits; if nothing
fits, return `Unfixable` without writing.

Compaction is the only rewrite of memory slots:

- survivors are regrouped once into canonical order by stable id;
- the compaction result is stored before it can affect a request;
- ordinary appends do not revisit earlier slot text or cursors;
- a second load appends full episode text and leaves the first note untouched until compaction.

Compaction changes future durable bytes intentionally. It must never make replay of the resulting
log nondeterministic.

## Invariants

1. Compiling the same durable log twice yields identical bytes, slot ordinals, and hash.
2. Restart and replay do not alter a compiled prefix.
3. Each thread has one cache; caches are not shared between threads.
4. One agent-agent thread has one shared cache.
5. Persona order is stable agent-id order.
6. The request's last line identifies the speaker in agent-agent threads.
7. Slot canonical text contains its stable id.
8. Confirmed memory notes are inserted only immediately after the assistant turn that used them
   and do not move during ordinary appends.
9. Scratch paths are turn-local and never durable. The recall block is turn-local,
    excluded from the prefix hash, recorded by item id + hash on the request, and
    may be credited; credited items install as durable notes after that turn.
10. Opaque provider signatures are never installed into the durable prefix.
11. Compaction is the only rewrite and is itself represented durably.
12. A second load appends full text; it does not edit an earlier installed sentence in place.
13. Cache residence is not a use presentation.

## Failure handling

- Reject duplicate stable slot ids or invalid insertion cursors during replay.
- Reject a persona set that does not match the durable participant identities.
- Reject unknown or non-canonical durable record versions rather than compiling approximate bytes.
- If append or compaction persistence fails, do not send a request based on an uncommitted state.
- If request metadata cannot be stored, do not apply attribution because the authoritative slot
  set for that request would be missing.
- If provider cached-token reporting is absent, record it as unavailable; do not infer a value.
- If a stored compiled hash differs from recompilation of the same log state, surface a
  correctness fault and retain both values for diagnosis.
- If scratch canonicalization fails, omit the outbound call rather than persisting scratch data as
  a workaround.
- A compaction transaction either stores the complete canonical result or leaves the previous
  prefix active.

## Observability

For every request and snapshot, expose:

- thread/request/turn identity;
- slot ids, kinds, ordinals, and byte ranges in prefix order;
- compiled byte length and hash;
- total prompt size and provider cached-token count;
- cache-hit comparison;
- scratch suffix size and proposed paths, clearly marked non-durable;
- memory-note provenance and insertion cursor;
- compaction trigger, thresholds, survivors, removed grouping, and resulting hash;
- replay/hash mismatches.

The Cache inspector lists slots in the exact order seen by the model. A turn scrubber starts on the
latest snapshot. One line compares cached tokens with prompt size. Selecting a slot selects the
same fact and trace span described by the other inspector tabs.

## Testing contract

Required tests include:

- A fixture log compiles to byte-identical output before and after closing and reopening storage.
- Repeated compilation of one replayed value is byte-identical and hash-identical.
- Different SQLite row iteration orders cannot change slot order.
- Personas compile in stable agent-id order regardless of participant input order.
- Agent-agent requests end with the correct speaker line without reordering personas.
- An empty compacted block has one canonical representation.
- A confirmed memory note is inserted immediately after the assistant turn that used it and stays
  there as later turns append.
- Scratch paths change outbound request bytes but not durable prefix bytes, prefix hash, or replay.
- The next request shares the durable prefix through the prior user message.
- A second episode load appends full text while retaining the first installed sentence until
  compaction.
- Ranking runs once per user turn; a tool-loop request reuses the same recall-block hash.
- An already-installed item id never appears in a later recall block for that thread.
- A provisional claim installed in a thread does not reappear in that thread's recall block after
  its canonical fact is consolidated, and the canonical fact is excluded if its claim is installed.
- Cross-thread recall: a claim promoted in thread A appears in thread B's recall block for a
  matching hint, and is not installed into thread B's durable transcript until credited there.
- Under each trailing-instruction placement mode, message N's wire content is byte-identical on
  turns N and N+1.
- An Untrusted durable slot stores the version-1 envelope; a body containing `<<maia:` is escaped;
  a Trusted slot has no envelope; a recall line never has an envelope.
- Each compaction trigger independently produces a decision; threshold boundary cases are covered.
- A stored compaction result replays identically after restart.
- A failed compaction append leaves the previous durable prefix intact.
- Request records contain the exact slot ordinals used by attribution.
- Merely compiling or retaining a slot writes no use presentation.

Tests use explicit thresholds, byte fixtures, canonical newline expectations, and fake/in-memory
`ThreadLog` implementations. They do not depend on the host locale, filesystem, system clock, or
provider cache behavior.

## Explicitly out of scope

- Sharing one prompt cache across different threads.
- Treating installed or retrieved memory as used without trace evidence.
- Persisting scratch paths.
- Persisting opaque provider signatures.
- Rewriting prior summaries on a second load outside compaction.
- Reordering personas by speaking order or UI order.
- Brain ranking, claim promotion, dream fact extraction, or attribution scoring.
- Selecting final centroid-distance threshold, inclusion thresholds outside the defaults named
  above, or the provider token estimator; those remain explicit policy inputs. Mean cosine
  distance is the locked centroid metric.
- SQLite DDL, provider-specific prompt-cache APIs, or production implementation during the
  documentation gate.

## Consistency links

- Product goal and one-cache-per-thread rule: [`00-goal.md`](00-goal.md)
- Human-readable vault content and `agents.md`: `01-vault.md`
- Shared facts and retrieval paths: [`02-brain.md`](02-brain.md)
- Use hits, slot heat, and request-bounded attribution: [`04-credit.md`](04-credit.md)
- Agent-agent identity, budgets, and scheduling: `06-agents.md`
- Router cached-token reporting and turn-local signatures: `07-computer.md`
- Core/store dependency direction: `08-rust.md`
- Cache timeline and selection UI: `09-frontend.md`
