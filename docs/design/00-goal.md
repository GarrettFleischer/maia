# Maia: Goal and Design Gate

## Status and authority

This document defines the product goal and the documentation gate for Maia. It is a design
contract, not an implementation plan. The approved plan remains the source of locked decisions;
this design set makes those decisions precise enough to review and test before any production,
configuration, or UI code is created.

Implementation may begin only after all design documents and placement mockups have been reviewed
together and the result has been recorded in `REVIEW.md`. `13-platform.md` is accepted there and
is authoritative for the cross-platform runtime, credential backends, security profiles, and
allowlist. Accepted [`14-super-agent-router.md`](14-super-agent-router.md) (owner, 2026-11-05)
supersedes the user-facing loop in this document: the owner speaks in one tool-free
`RouterSession`, and tool execution belongs to a parent `TaskSession` or its children. Brain
recall, dreams, panic, and the desktop daemon boundary below stay in force. The product runs on Windows, Linux, and macOS. The phone remains a remote window only.

## Purpose

Maia is one desktop daemon that remembers across a long life while spending as few context tokens
as possible.

- Agents are folders in one Obsidian vault. The folders organize agents and hold notes intended
  for a person to read.
- Facts about the world live in one shared brain.
- Every chat, whether between a person and an agent or between agents, has its own durable prompt
  cache.
- Recall is algorithmic and does not call a model.
- A tool-less model promotes each stored episode into provisional claims immediately, so knowledge
  is findable from any thread without waiting for a dream.
- A model consolidates memory in batched dreams (merge, close, entities, vault projection). Dreams
  organize memory; they are not the gate for finding it.
- Unattended threads may act on the desktop computer — Windows, Linux, or macOS — within explicit
  budgets, the active security profile, and the platform capability report (`13-platform.md`).
- The phone is a remote window onto the same desktop daemon; the brain, shell, and browser remain
  on that desktop. The phone does not run its own daemon. The phone, and the web UI over
  Tailscale, can approve and grant everything the desktop can, except enabling `Unrestricted` and
  other local-desktop administration. Only administration (pairing, router, vault, Tailscale,
  policy, credential-backend selection, encrypted-file passphrase entry, and audit recovery) is
  desktop-only. A paired Android phone may install the UI as a home-screen PWA and get
  content-free Web Push when something needs them.

The primary user task is conversation. Organization belongs on the left of the desktop UI, and
inspectable proof of memory belongs on the right without covering the transcript.

## Data model

The design has the following authoritative concepts:

- **Vault:** human-readable Markdown organization, agent personalities, and entity pages.
  Conversation transcripts, reasoning traces, and prompt-cache state do not live in it.
- **Brain:** one shared SQLite mesh containing episodes, provisional claims, canonical facts,
  lexemes, edges, vectors, presentation history, and readable reasoning traces. Claims and facts
  link to related claims and to every episode (and therefore every thread) that sourced or later
  hit them, with full episode context retained for lookup.
- **Agent:** a vault folder whose `personality.md` is human-owned.
- **Thread:** a conversation with one ordered durable slot list. A direct thread contains a person
  and one agent. An agent-agent thread is one shared thread shown under every participant.
- **Slot:** a canonical, stable-id-bearing unit in a thread's prompt prefix.
- **Presentation:** traced evidence that a slot was used in reasoning, a tool round-trip, or,
  under the defined restriction, a reply.
- **Promotion:** a tool-less, per-episode process run as soon as an episode commits. It writes
  provisional claims into the brain so they are rankable from any thread.
- **Dream (consolidation):** a tool-less batched process that merges, closes, and reconciles claims
  into canonical facts and entities, then projects them into vault pages while preserving
  human-owned note regions byte-for-byte. Consolidation may lag; it is not required for findability.
- **Daemon:** the single desktop process that owns persistence, scheduling, routing, tools, and
  the web surface exposed on localhost and the Tailscale address.

These concepts are not interchangeable: vault notes are not prompt caches, thread residence is
not use, and a thread cache is not the shared brain.

## Product sequence

The end-to-end sequence is:

1. A user message, inter-thread message, schedule, or tool opens or wakes a thread.
2. The thread's durable log is compiled into a deterministic prefix (hashed).
3. Algorithmic retrieval ranks facts; a non-durable **recall block** of fact sentences is appended
   (hashed separately). Optional scratch paths may follow.
4. Maia maps slots to the OpenAI wire form, calls the router, and records readable reasoning, tool
   activity, reply, slot ordinals, recall item ids, compiled hashes, and provider cached-token count.
5. Attribution credits durable slots and recall items present in that request and writes one ledger
   to both thread heat and shared-brain presentations. Credited recall items are installed as
   durable memory notes after that assistant turn.
6. The loop may execute tools under grants until the model stops or a budget moves the thread to
   `Sleeping`. Failed auth automation and capability approvals move it to
   `NeedsHuman`.
7. Episodes remain immediately searchable. Promotion writes provisional claims into the shared
   mesh as soon as the episode commits, with taint and mention edges back to the episode. A later
   dream consolidates claims into canonical facts (with taint and correction holds) and regenerates
   only machine-owned note regions.
8. Desktop and phone views expose the same thread state, panic control, cache, brain, and trace.

## Public product contracts

The following cross-system contracts must remain true:

- `map` exposes structure and frontmatter, while `read` exposes note bodies.
- `compile_prompt` is deterministic for the same durable thread log.
- `activation` and `rank_paths` receive the graph, query, and time as inputs and do not call a
  model.
- `attribute_uses` receives the request's durable slots, recall items, and readable trace; it
  cannot credit identities absent from that request.
- `render_entity_page` may replace the generated region but preserves the human region exactly.
- `ThreadLog`, `Router`, `Embedder`, `VaultStore`, and `Tools` are I/O ports only where two
  implementations are needed for testing.
- Framework entrypoints remain glue. `main` is the composition root, and nothing runs before it.

Detailed signatures and ownership rules belong to the relevant design documents.

## System invariants

1. There is one shared brain and one durable cache per thread.
2. An agent-agent conversation has one shared cache, not one cache per participant.
3. A compiled prefix is a pure function of its durable thread log.
4. A fact's strength changes only from a traced use; cache residence alone has no weight.
5. One use is recorded through one ledger in both thread heat and the shared brain.
6. Retrieval is algorithmic and model-free.
7. Promotion and dreams have no tool host and cannot use the shell, browser, Scrapy, or
   api-anything.
   Cross-thread findability never depends on a dream having run: a stored episode's provisional
   claims are rankable immediately after promotion commits.
8. Dreams never write `personality.md` and preserve human note regions byte-for-byte.
9. Opaque provider signatures are turn-local and never become durable prefix content.
10. The same selected fact connects cache slot, brain node, and trace span in the inspector.
11. Panic is reachable on desktop and phone, and stops every loop.
12. Auth walls are automated when grants and secrets allow; otherwise the thread
    waits in `NeedsHuman` and identifies the desktop as the place to finish.

## Failure handling

- **Design disagreement:** change the design documents first. Production work stays blocked until
  the set is consistent and the review is accepted.
- **Persistence or replay mismatch:** treat byte drift as a correctness failure. Do not send a
  silently changed prefix as though it were the same cache.
- **Untraceable memory use:** do not award a presentation. Missing evidence is not inferred use.
- **Router without readable reasoning:** retain the explicit trace state and apply only the
  tool/reply attribution rules in `04-credit.md`.
- **Budget exhaustion:** move the thread to `Sleeping`; do not silently continue.
- **Login, captcha, or MFA:** automate with granted secrets and the configured
  solver when possible; on failure move the thread to `NeedsHuman`, optionally
  bring the desktop browser forward as recovery, notify phone clients, and stop
  thread progress.
- **Promotion failure:** the episode stays stored and searchable by full text, vector, and lexeme.
  The failed promotion applies nothing and is retried on a later trigger without losing the episode.
- **Dream failure:** apply the consolidation batch in one SQLite transaction, then project the
  committed state to the vault through a durable, idempotent second phase. A failed projection never
  causes another model call and never overwrites concurrent human edits.
- **Remote-view failure:** desktop state remains authoritative. The phone does not acquire a
  second brain, browser, shell, or daemon.

## Observability contract

The product must make its memory and autonomy inspectable:

- Every request records thread id, slot ordinals, compiled hash, and provider cached-token count.
- Every episode retains readable reasoning when available, tool calls, and the reply.
- Every presentation records its source, weight, fact or slot identity, and originating thread.
- Every tool call appears in the thread and in an immutable audit.
- Cache snapshots support a turn scrubber and preserve prefix order.
- The brain view exposes activation, weighted edges, walked nodes, and cold nodes.
- The trace view labels full and half matches and explicitly says when readable reasoning was not
  returned.
- Run state and budget status are visible, while panic remains directly reachable.

Observability must not alter retrieval, attribution, prompt bytes, or memory strength.

## Testing contract

Before implementation, the design set must be precise enough to derive these independent red
tests:

- Compiling the same durable thread log before and after restart yields byte-identical output.
- Attribution ignores any slot absent from the request.
- A reply-only match receives half weight only when the turn had no readable reasoning.
- Weighted ACT-R activation matches a hand-computed fixture.
- `map` returns descriptions and links without returning note bodies.
- Entity-page rendering preserves the human region byte-for-byte.
- Dream brain application is atomic, vault projection is recoverable and idempotent, and neither
  phase can invoke tools.
- Thread budgets and human challenges produce the specified states.
- The desktop and phone controls address the same daemon and the same thread identities.

Tests inject time, vectors, graph state, logs, routers, and tool hosts. Defaults are configuration,
not hidden discoveries; tests pass explicit thresholds and budgets.

## Documentation-gate acceptance checklist

The review recorded in `REVIEW.md` must answer every item:

- **Goal:** every system either shortens the prompt, makes recall inspectable, or lets an agent act
  on this machine. A system that only adds surface area is removed.
- **Consistency:** the set describes one brain, one cache per thread, one ledger, promotion and
  dreams without tools, preserved human regions, and one shared selection across cache, brain, and trace.
- **Correctness:** prefix bytes, use weights, compaction rules, and `map`'s refusal to return bodies
  are tight enough to produce red tests from the documents alone.
- **Frontend:** the transcript stays readable, panic is reachable on desktop and phone, and
  `NeedsHuman` accurately states when auth automation failed and must finish on
  the desktop, while approvals work on every owner client.
- **Security:** approvals, containment, provenance, secrets, and remote authority match
  `10-security.md`, `11-secrets.md`, and accepted `13-platform.md`.
- **Review record:** unresolved disagreements are documented and fixed in the design set before
  code begins.

## Explicitly out of scope

- Fine-tuning a model or using a model for recall.
- A second Markdown editor inside Maia.
- A phone-resident brain, shell, browser, or independent daemon.
- Per-agent copies of shared world facts.
- Per-participant caches for one agent-agent thread.
- Treating prompt residence, retrieval, or model attention guesses as proven use.
- Fingerprint rotation, proxy rotation, or refresh-as-evasion beyond configured
  captcha solving and stored credentials (see `07-computer.md`).
- Production code, workspace configuration, crate scaffolding, or UI implementation during the
  documentation gate.

## Consistency links

- Vault ownership and human/generated regions: `01-vault.md`
- Shared brain, activation, and retrieval: [`02-brain.md`](02-brain.md)
- Durable prefix and compaction: [`03-thread-cache.md`](03-thread-cache.md)
- Attribution and the presentation ledger: [`04-credit.md`](04-credit.md)
- Promotion, consolidation batching, and atomic apply: `05-dream.md`
- Thread states, budgets, and panic: `06-agents.md`
- Shell, api-anything, Scrapy, browser, router, and remote boundaries:
  `07-computer.md`
- Rust architecture and port placement: `08-rust.md`
- Desktop/phone placement and inspector behavior: `09-frontend.md`
- Threat model and adversarial controls: [`10-security.md`](10-security.md)
- Credential management and secret containment: [`11-secrets.md`](11-secrets.md)
- Cross-platform runtime, credentials, profiles, and allowlist: [`13-platform.md`](13-platform.md)
- Whole-set acceptance record: `REVIEW.md`
