# Design review, round 4: Claude Opus 5.5

Reviewed 2026-11-04 against `00-goal.md` through `11-secrets.md` and `REVIEW.md`, after the
round-3 patches. Claude Opus 5.5 ran this review directly as the parent agent, not as a subagent
at a different effort level. No other document was edited, no code was written, and nothing was
committed.

## Verdict

**Accept with changes.** There are no Critical findings. Every round-1 to round-3 Critical holds:

- the recall loop;
- byte grammar and wire form;
- model-free compaction;
- the closed tool enum;
- per-thread sandboxing;
- the loopback desktop secret;
- approvals bound to a digest;
- dream-context taint and dismissals.

The Important items below are local edits, not architecture changes. Two of them came from the
round-3 patches (I2, I3). Fix the "Before any code" group, record the decision in `REVIEW.md`,
and the gate can open for the vault and brain-rank bricks. Fix the rest before the brick that
depends on each item.

## Counts

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| Important | 12 |
| Minor | 11 |
| **Total** | **23** |

## Important

### Before any code

**I1. Turn labels break the cache rule they support.** `03-thread-cache.md` (Canonical byte
order, Wire form). The durable bytes label transcript turns `` `{role}:{turn_id}`: ``, but the
current message sits unlabeled under `## user`. On the next turn that message becomes a labeled
transcript turn. If wire content carries the label, the previous user message changes between
turns, which breaks the "common prefix through the previous user message" MUST. *Change:* labels
exist only in the hashed durable bytes and never in wire `content`, or the current message carries
its final label from the start. Add a test that asserts identical serialized bytes for message N
across turns N and N+1.

**I2. Phone approval is still two rules inside `10`.** `10-security.md` (Approval tiers) now says
the phone may only deny. (Owner actions and their tiers) still lists `Confirm (desktop or phone)`,
and (Client authentication, item 7) still gives the phone "`Confirm` approvals". `07` and `09` say
desktop-only. *Change:* rewrite both passages to "phone: deny, tighten, stop, panic".

**I3. `run_thread` hands `SecretStore` to core policy.** `08-rust.md` (I/O skins) gives
`run_thread` a `secrets: &S` parameter. `11-secrets.md` (Port rules) says only `maia-tools` and
`maia-router` receive `impl SecretStore`, and the composition root never resolves. Core policy
holding resolve access is the hidden capability the honesty rules forbid. *Change:* remove `S`
from `run_thread`. Tools and router receive the store at assembly.

**I4. `run_dream` still takes `ThreadLog`.** `08-rust.md` (`run_dream`). Nothing in `05` lets a
dream append thread events (round-1 Grok I10). *Change:* remove it, or pass a read-only view with
no `append`.

### Before the thread-cache and chat-loop bricks

**I5. Mid-conversation `system` messages are not portable.** `03` (Wire form) puts recall,
scratch, and the speaker line in `system` messages after the user message. Several
OpenAI-compatible routers hoist every `system` message to the front, which rewrites the prefix,
or reject `system` after the first message. *Change:* add a `RouterCapabilities` field for
trailing-instruction placement (trailing `system`, or a trailing `user` part), choose it per
provider at startup, and record it on the request. The cache test runs for each mode.

**I6. Recall has no budget, no dedupe, and no tool-loop rule.** `03` (Recall block, Request
sequence). A fact that is already installed can be recalled again, which duplicates bytes. Every
request in a tool loop recompiles and re-ranks, so recall and credit repeat while installation
happens once per turn. Nothing defines the query text. *Change:*

- define the recall query as the current user message plus the last assistant turn;
- exclude installed facts from recall;
- cap recall by tokens in `RankPolicy`;
- rank once per user turn and reuse that recall block for the in-turn tool requests.

**I7. Slot heat is used but never defined.** `03` (Survivor predicate) and `04` (Presentation
ledger). *Change:* define heat as the sum of accepted presentation weights on that slot within a
window, as a pure function in `04`. `compact` reads it from the ledger.

**I8. `Unfixable` has no destination.** `03` sends a transcript-over-budget `Unfixable` to
"`NeedsHuman` or stop the lease per `06`". `06` has no such rule, and `HumanRequestKind` has no
matching variant. *Change:* pick one. The recommendation is `Running -> Sleeping { reason:
TranscriptBudget }`, a visible banner, and a "start a new thread" action. Put the rule in `06`.

### Before the brain-rank and dream bricks

**I9. Retrieval ignores participant scope.** `01-vault.md` (invariant 7) lets a thread see only
shared entities and its participants' private entities. `rank_paths` takes no participant scope,
and facts carry `Agent(AgentId)` scope. A private Scout fact can therefore enter a thread with
Scribe through recall. *Change:* add `participants: &BTreeSet<AgentId>` to `rank_paths`. Facts
scoped to other agents contribute no candidates and no spreading. Add a red test.

**I10. The joint ledger write has no single port.** `04` calls
`apply_ledger(store: &mut impl PresentationStore, …)`. `08` puts `apply_ledger(&LedgerUpdate)`
on `BrainStore` and leaves thread heat to "a single explicit database command". *Change:* name
one `BrainStore::apply_ledger(&AttributionLedger)` that commits thread heat, presentations,
co-use edges, and marks in one transaction, and delete `PresentationStore`.

**I11. The dream does not specify panic or embedding timing.** `05` (Transaction sequence). This
is carried from round 1. *Change:* panic cancels dream admission and the model call, while a
committed projection still finishes. New fact vectors are embedded after commit by an
idempotent job, and a fact without a vector stays reachable through lexemes and full text.

**I12. A correction hold has no guaranteed release.** `04` (Correction mark) holds a fact until
"the dream commits a validity closure or an owner clears the hold". If the dream consumes the mark
and dismisses it instead, the hold lasts forever and the fact silently leaves recall. *Change:*
the dream must either close the fact or record a dismissal of the mark. A dismissal releases the
hold, and both outcomes are visible in the inspector.

## Minor

1. `00-goal.md` (Product sequence, step 7) still says "origin and quarantine". It should say
   "taint and correction hold".
2. `00-goal.md` (Public product contracts) lists ports without `BrainStore` and `SecretStore`.
   The acceptance checklist has no Security item (`10` finding 24).
3. `03` testing contract and invariant 12 still say "old summary". First install stores a
   sentence.
4. `03` (Explicitly out of scope) still leaves "centroid-distance math" unselected. Compaction now
   specifies mean cosine distance.
5. `03` `CompactionPolicy` omits `min_interval_turns`, the centroid window `N`, the transcript
   budget, and the heat floor that the prose defines.
6. `03` item 1 says tools are "sent as `RouterRequest.tools`". The field is `tools_json`.
7. `08` `BrainStore::retrieval_graph` returns `RetrievalGraph`, but `rank_paths` takes
   `RecallGraph`. `08` (Domain types) still names a `Decay` newtype, but `activation` takes `f64`.
8. `08` (Ownership and concurrency) says panic blocks scheduling "until explicitly resumed". The
   latch is cleared separately, and clearing does not resume anyone.
9. `02` (Explicitly out of scope) still leaves the elapsed-time unit unset beside
   `AgeUnit::Seconds`. `02` (Failure handling) rejects the whole ranking on a future-dated
   presentation; skipping that presentation would survive clock skew.
10. `04` invariant 3 and `02` testing contract say "tool" hits are full weight. They should say
    "tool-argument".
11. `09`:
    - The Cache mockup shows "Constitution", while `03` uses tools, agents, and personas.
    - The Cache tab shows neither the non-durable recall block nor dream proposals, quarantined
      episodes, or device pairing.
    - Router, vault, and Tailscale fields are not marked desktop-only.
    - The 720 px breakpoint plus the 248 px rail and 480 px conversation adds up to 728 px.

## What holds

- One brain, one cache per thread, and one ledger, with no contradiction between documents.
- Recall, credit, and install form a closed loop. "Confirmed" means weight above zero.
- The prompt bytes can be written as fixtures. The tools JSON is hashed but not duplicated into
  messages.
- Compaction is model-free and memory-only, and it cannot run on two consecutive turns.
- Fact taint is the join of the whole dream-call context, so it cannot be forged through cited
  episode ids. Batches are partitioned by taint, and an untrusted closure or merge of a trusted
  fact becomes a proposal.
- Contradiction candidates are answered by a closure or a dismissal, and failures are counted per
  episode.
- Each thread runs in its own AppContainer. Chrome is driven over a pipe only. Remote devices are
  paired as `(user, node)`.
- Loopback is not treated as identity. Approvals are bound to a digest and never automatic.
- The audit checkpoint is signed and witnessed. Engaging panic always works.
- `maia-win32` is the only crate allowed `unsafe`.
- Human regions fail closed on duplicated markers, which covers an end marker typed inside the
  region.
