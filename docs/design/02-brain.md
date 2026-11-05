# Shared Brain and Algorithmic Recall

## Purpose

The brain is Maia's one shared, machine-readable memory. It retains raw experience, provisional
claims, canonical facts, language entry points, graph relationships, presentation history, and
vectors without placing all of that material into every prompt.

The brain is a mesh. Claims and facts link to related claims and facts, to lexemes and entities, and
to every episode (and therefore every thread) that sourced or later hit them. Each episode keeps its
full context, so a later lookup can walk from a hint to the original exchange. Only the small ranked
slice a query selects enters a prompt.

Recall must be inexpensive in router tokens, deterministic from explicit inputs, and inspectable.
The model may organize memory during a dream, but it does not participate in retrieval.

## Ownership and storage boundary

The brain is one SQLite file beside the Obsidian vault. The vault is the human-readable long-term
mind; the brain is the queryable evidence and graph. There is not one brain per agent.

The brain owns:

- episodes and their readable traces;
- provisional claims and canonical facts, with their validity windows;
- mention edges from claims and facts to every episode that sourced or hit them;
- lexemes used as graph entry points;
- graph edges;
- presentation records and correction marks;
- local embedding vectors;
- links back to source episodes and originating threads.

The brain does not own:

- agent personalities or human-authored entity prose;
- thread prompt ordering or cache snapshots;
- opaque provider signatures beyond the current tool round-trip;
- router, browser, shell, or remote-phone state.

SQLite is an I/O skin. Pure ranking functions receive already-loaded values; they do not open the
database, read a clock, invoke an embedder, or call a model.

## Physical storage (v1, locked)

The mesh is a logical graph. v1 stores it in the single SQLite file above, using ordinary tables:

| Need | v1 mechanism |
|---|---|
| Portable brain beside the vault | One SQLite file |
| Atomic promotion, consolidation, and ledger writes | SQLite transactions (`05-dream.md`, `04-credit.md`) |
| Episode and claim full text | FTS5 |
| Embeddings | `sqlite-vec` tables; the ranker receives loaded vectors |
| Nodes, mention edges, relatedness, lexeme edges | Ordinary node and edge tables |
| Walks and Personalized PageRank | A bounded subgraph is loaded into `RecallGraph` and ranked in process |

A graph engine is not part of v1. GraphQLite (a SQLite loadable extension with Cypher and built-in
PageRank) and server graph databases are rejected for v1: GraphQLite is pre-1.0 and adds a
loadable-extension dependency on the desktop daemon, and a server adds a second process and file
outside the one-brain-file model. The ranking model (activation, taint, quarantine, embeddings) stays
in Maia's honest leaves either way.

Revisit an embedded graph engine only if a measured subgraph load or in-process PageRank becomes the
bottleneck, or owner tooling needs ad hoc graph queries. A swap happens behind `BrainStore`; ranking
leaves are unchanged.

## Data model

### Episode

An episode is the immutable raw exchange stored immediately when a turn occurs. It is kept even
after facts are extracted from it.

Required logical fields:

- stable episode id;
- thread id and turn identity;
- raw exchange content as an ordered list of **segments**, each with text and
  `Provenance { taint, sources }` (`10-security.md`);
- readable reasoning trace when the router returned one (Trusted / MaiaCanonical);
- tool arguments (model-authored; taint inherits the turn) and tool results
  (Untrusted; source `Tool` or `Web` / `Api` as applicable);
- reply;
- creation time;
- local embedding, once available;
- known lexeme associations.

Episode taint is the join of its segments' taint. Fact taint is defined only on Fact (dream-call
context join); it is never derived from an episode rollup or cited `episode_ids`.

An episode is searchable before any promotion or dream runs through full text, its local embedding,
and known lexemes. Promotion adds provisional claims that cite it; see below.

### Provisional claim

A provisional claim is one sentence that promotion extracts from a single episode as soon as the
episode commits. Claims are the findability layer: they are rankable from any thread before any
consolidation runs.

Required logical fields:

- stable claim id;
- sentence text (one declarative sentence);
- `Provisional` status, with `valid_from` equal to the source episode timestamp;
- source episode id (exactly one, the episode that produced it);
- taint equal to the source episode's taint (set by promotion, never from model output);
- mention edge to its source episode;
- lexeme associations derived from the sentence by the configured lexical policy;
- local embedding, once available;
- `consolidated_by`, empty until a consolidation batch consolidates it into a canonical fact.

A claim is not a fact. It is never canonical, does not appear in vault projections, and can be
superseded by a canonical fact (below). It can be quarantined by a correction mark like any fact.

### Fact

A canonical fact is produced by consolidation (`05-dream.md`) from one or more provisional claims or
from other canonical facts. A canonical fact is one sentence with:

- stable fact id;
- sentence text;
- validity start and optional validity end;
- source episode id(s) and the consolidated claim id(s) it supersedes;
- **taint** — binary `Trusted` | `Untrusted` from `10-security.md`. Authority for sink checks
  and recall. Set only by the consolidation apply step as the **join of the entire dream-call context**
  (selected episodes, context facts, correction marks, pre-pass candidates), never from the
  model's cited `episode_ids`. Retro-taint (owner/incident) may raise taint; only an owner
  endorsement may lower it;
- **sources** — `BTreeSet<SourceRef>` for inspection (episode segments, vault paths, web origins).
  Informative; cannot lower taint;
- **quarantine** — `None` or `CorrectionHold { since }` (set immediately by a negative correction
  mark). Injection handling uses retro-taint / raised `Untrusted`, not a separate detector enum;
- local embedding;
- lexeme associations;
- presentation history;
- correction marks;
- optional entity id and vault scope (`World` or `Agent(AgentId)`).

When a newer fact supersedes an older fact, the newer fact closes the old fact's validity window.
The old fact and its source episode remain history; supersession does not delete them.

When a canonical fact consolidates a provisional claim, the claim is superseded for ranking. The
claim row, its mention edge, and its episode remain history. The canonical fact is preferred
wherever both would otherwise match.

Facts below the retrieval threshold remain in the graph. They are cold storage: omitted from the
prompt unless a graph walk lifts them above the applicable threshold. Quarantined facts are
omitted from ranking entirely until an owner clears the hold or a dream closes validity.

### Lexeme

A lexeme is a word or short phrase that anchors lexical recall. Stopwords and very high-fan terms
must not become lexeme nodes. Fan-out exclusion prevents common words from spreading activation
through unrelated memory.

The stopword set and high-fan cutoff are supplied policy/configuration, not model judgments hidden
inside ranking.

### Edge

Edges connect graph nodes: episodes, claims, facts, entities, and lexemes. Mention edges run from a
claim or fact to each episode that sourced or hit it. Their exact persisted representation is a
storage concern, but the ranker receives stable endpoint ids and weights. Co-use edges are updated
only through the presentation ledger described in `04-credit.md`.

### Presentation

A presentation records traced use of a fact or installed memory:

- stable presentation id;
- fact or slot identity;
- source (`Reasoning`, `ToolArgument`, or `Reply`);
- weight (`1` for reasoning/tool-argument, `0.5` for eligible reply-only use);
- presentation time;
- originating thread id and turn;
- ledger identity used to prevent duplicate application.

Cache residence and retrieval without traced use are not presentations.

### Vector

Vectors are produced by a local embedder so retrieval does not consume router tokens. Tests provide
vectors directly. The embedder model id is configuration and must be recorded with vectors or
otherwise versioned so incomparable embeddings are not silently mixed.

## Public contracts and honest signatures

The core contracts are expressed here as Rust-shaped design signatures. Exact storage structs may
be refined later without weakening the contracts.

```rust
pub fn activation(
    presentations: &[WeightedPresentation],
    now: Timestamp,
    decay: f64,
    age_unit: AgeUnit,
) -> Result<f64, ActivationError>;

pub enum AgeUnit {
    Seconds,
}
```

`activation` is an honest leaf. For fact \(i\), it computes:

`B_i = ln(Σ_j w_j * t_j^(-d))`

where `d` is supplied (`0.5` by default), `w_j` is the recorded presentation weight, and `t_j` is
the positive age of presentation `j` at `now` measured in `age_unit`. v1 fixtures and production
use `AgeUnit::Seconds`. Empty presentations return `Err(ActivationError::NoPresentations)`.
Non-finite decay or non-positive ages return typed errors. Negative presentation weights are
rejected.

```rust
pub fn rank_paths(
    graph: &RecallGraph,
    query: &RecallQuery,
    now: Timestamp,
    policy: &RankPolicy,
    quarantine: &QuarantineSet,
    participants: &BTreeSet<AgentId>,
) -> Result<Vec<RankedPath>, RankError>;
```

`rank_paths` is an honest leaf. `RankPolicy` carries decay (`f64`, default `0.5`), `AgeUnit`,
lexical fan-out policy, Personalized PageRank parameters, embedding-combination parameters,
inclusion thresholds, a recall token budget, and `RecallTaintMode` (`IncludeUntrusted` default,
or `TrustedOnly` per sensitive agent). `quarantine` lists claim and fact ids in `CorrectionHold`;
they contribute neither candidates nor spreading. Under `TrustedOnly`, `Untrusted` claims and facts
are also omitted. Claims and facts scoped to `Agent(other)` where `other` is not in `participants`
contribute neither candidates nor spreading (shared and unscoped items remain eligible). A claim
superseded by a canonical fact contributes neither candidates nor spreading. Its canonical fact
is the candidate. No threshold or coefficient is discovered from global state.

`RankedPath` retains the walked node ids for the inspector and carries a `RecallItem`, a tagged
union of `Claim { claim_id }` or `Fact { fact_id }`, plus its exact sentence text and taint. The
recall block is computable from `rank_paths` output alone.

The result identifies ranked nodes and the paths that lifted them, so the UI can mark the last
query's walk. Stable tie-breaking must use stable ids; database iteration order cannot decide the
result.

An I/O skin obtains query embeddings from the local `Embedder` port and graph data from storage,
then passes both into `rank_paths`. Neither core function calls those ports.

## Retrieval algorithm

1. Normalize the query using the configured lexical policy.
2. Resolve query words and short phrases to eligible lexeme nodes. Case folding and possessive
   stripping are part of the configured lexical policy, so `bob's` and `Bob's` both resolve to the
   lexeme `bob`.
3. Exclude stopwords and very high-fan terms from lexeme seeding.
4. Build the Personalized PageRank personalization vector from the query lexemes.
5. Compute weighted ACT-R base activation from traced presentations at the supplied `now`.
6. Run Personalized PageRank over the supplied graph.
7. Compare query and candidate vectors using the supplied embedding inputs.
8. Combine base activation, graph spreading, and embedding similarity using explicit
   `RankPolicy` parameters.
9. Apply the supplied inclusion threshold. A fact below it remains stored and can still be lifted
   by a later graph walk.
10. Return candidates with stable ids, component scores, and walked paths in deterministic order.

Episodes follow the same search boundary immediately after storage: full text, embedding, and
known lexemes make them discoverable before any promotion or dream. Provisional claims join the
rankable set as soon as promotion commits, through the same channels and the same graph walk.

## Invariants

1. There is one shared brain.
2. Retrieval is a pure function of graph data, query data, supplied time, supplied policy, the
   quarantine set, and the participant set.
3. Retrieval never calls a router or any model.
4. The local embedder supplies vectors outside the pure ranker.
5. An episode is stored immediately, kept, and searchable before a promotion or dream runs.
6. A canonical fact is exactly one sentence with a validity window and one or more source episodes.
   A provisional claim is exactly one sentence with one source episode.
7. Supersession closes old validity; it does not erase history. A canonical fact that consolidates a
   claim supersedes that claim for ranking only.
8. Mention edges point from a claim or fact to the episodes that sourced or hit it. Thread identity
   is reached through the episode.
9. Stopwords and very high-fan terms do not become lexeme nodes.
10. Fact strength changes only through traced presentations.
11. Cold facts remain in the graph when omitted from a prompt.
12. Tests can replace embeddings with explicit fixture vectors.
13. Ranking ties are resolved deterministically.

## Failure handling

- Reject non-finite or non-positive decay inputs rather than producing an uninspectable score.
- Skip a presentation dated after `now`, or whose age is not positive in `AgeUnit::Seconds`, and
  continue ranking with the remaining presentations. Do not reject the whole ranking for clock
  skew. Do not clamp ages silently.
- Treat an empty presentation set as having no base-level evidence; do not take `ln(0)`.
  The rank policy must represent that absence explicitly when combining components.
- Reject non-finite presentation weights, edge weights, vectors, and policy coefficients.
- If a query has no eligible lexemes, lexical spreading contributes no seed; full-text and
  embedding retrieval remain available.
- If an embedding is missing, keep the episode, claim, or fact searchable by the available full-text
  and lexeme channels. Do not fabricate a vector.
- If vectors come from incompatible embedder versions, do not compare them as though they shared
  a space.
- A transaction failure while storing an episode or applying a ledger must not leave partial
  graph or presentation updates.
- A failed promotion or dream cannot remove the original episode, partially close facts, or leave a
  claim half-written.

## Observability

Each retrieval should expose enough structured data for the inspector and tests:

- query lexemes accepted and excluded, including exclusion reason;
- the supplied ranking policy and time;
- base activation, PageRank contribution, embedding contribution, and final score per candidate;
- paths walked from query lexemes;
- threshold decision and cold/selected status;
- stable tie-break key;
- vector model/version and missing-vector state;
- source episode and validity window for each fact.

The brain inspector sizes facts according to activation, draws edge thickness according to weight,
marks nodes walked by the last query, and dims cold nodes. For a thread view it filters to nodes
that thread has touched, with an explicit way to show the rest of the shared brain.

## Testing contract

Tests must use independent, hand-computed fixtures:

- Weighted ACT-R with multiple ages and weights matches
  `ln(Σ w_j * t_j^(-0.5))`.
- A reasoning or tool-argument presentation contributes weight `1`; an eligible reply-only
  presentation contributes `0.5`.
- A private fact scoped to an agent not in `participants` never appears as a candidate and never
  spreads.
- Changing supplied `now` changes activation predictably without reading the system clock.
- Empty presentations produce the documented no-base-evidence state, not NaN or infinity.
- Personalized PageRank on a small fixed graph matches a hand-computed or independently generated
  expected ranking.
- Stopwords and high-fan terms do not seed graph spreading.
- Stable ids break equal-score ties identically across input orderings and restart.
- A cold fact remains queryable in the graph and can cross threshold after a relevant walk.
- A newly stored episode is discoverable by full text, fixture vector, and known lexeme before a
  promotion or dream.
- Cross-thread hint: thread A stores an episode whose promoted claim reads "The project is named
  Bob's Best Burgers"; thread B's `rank_paths` for the query "bob's" returns that claim (or its
  canonical successor) with its sentence, before any consolidation runs.
- A canonical fact that lists a claim consolidates it: the claim is absent from ranked candidates,
  its row and mention edge remain, and the canonical fact is returned instead.
- Superseding a fact closes its validity window while preserving both fact and source episode.
- Missing embeddings degrade to the remaining channels rather than dropping the record.
- Ranking performs no model, clock, filesystem, global-client, or database access.

The default decay is `0.5`, but tests pass it explicitly. PageRank, embedding-combination, fan-out,
and inclusion thresholds are also explicit fixture inputs.

## Explicitly out of scope

- Model-driven retrieval, reranking, or attention-based credit.
- Fine-tuning.
- Deleting old episodes when facts are extracted.
- Making every vault word a lexeme.
- Treating retrieval or prompt residence as a presentation.
- Defining promotion or consolidation schemas, entity-page rendering, or vault layout here
  (`05-dream.md`, `01-vault.md`).
- Defining final numeric PageRank damping, score-combination coefficients, inclusion thresholds,
  embedder model id, or fan-out cutoff; those are explicit `RankPolicy` / configuration inputs.
  Elapsed time is fixed as `AgeUnit::Seconds`; decay is an `f64` (default `0.5`), not a newtype.
- Database schema DDL or production SQLite code during the documentation gate.

## Consistency links

- Product goal and shared-system invariants: [`00-goal.md`](00-goal.md)
- Vault entity projections and source ownership: `01-vault.md`
- Prompt installation, slot identity, and snapshots: [`03-thread-cache.md`](03-thread-cache.md)
- Presentation weights, co-use edges, and correction marks: [`04-credit.md`](04-credit.md)
- Claim promotion, consolidation, merging, and validity closure: `05-dream.md`
- Rust dependency direction and the `Embedder` port: `08-rust.md`
- Brain graph and shared selection behavior: `09-frontend.md`
