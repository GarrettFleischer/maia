# Design review — Grok 4.7, round 2

Reviewed 2026-11-04 against `docs/design/00-goal.md` through `11-secrets.md`, `REVIEW.md`,
`REVIEW-grok-4.7.md`, and `REVIEW-claude-opus-5.5.md`. No other design document was edited. No
code was written.

## Verdict

**Reject.**

C1 (recall install), C3 (compaction), and C4 (tool enum) are specified well enough to test.
C5, C6, C2-bytes, and C-taint are written in the chapters `REVIEW.md` names and then contradicted
by another rule in the same set. Those four are the isolation boundary, the loopback identity
boundary, the provider cache, and poisoned-fact retrieval. A second implementer can still build
a different system from the same pages. Revise until each of those four has one rule, then
re-review. Do not start the workspace on this set.

## Counts

| Severity | Count |
| --- | ---: |
| Critical | 4 |
| Important | 10 |
| Minor | 4 |
| **Total** | **18** |

## What already holds

- **C1 recall loop.** `00-goal.md` (Product sequence, steps 3–5), `03-thread-cache.md` (Recall
  block, Installed memory note, Request sequence), and `04-credit.md` (Request attribution scope)
  agree: a non-durable recall block of fact sentences sits after the durable prefix, is hashed
  apart from it, may be credited, and installs only after an accepted presentation with weight
  greater than zero. First install stores that sentence. A second load is an explicit inspector
  action that appends episode text. No message-path model writes a summary.
- **C3 compaction.** Triggers and survivors are limited to installed memory notes and the
  compacted block. Compaction is model-free, has a minimum turn interval, and returns
  `Unfixable` without a write when the transcript alone exceeds its budget
  (`03-thread-cache.md`, Compaction triggers and behavior).
- **C4 tools.** `07-computer.md` (`ToolRequest`, `ToolKind`) adds `VaultMap`, `VaultRead`,
  `Console`, `Web`, `PostToThread`, and `OpenThread`, and states that schedules are human-only
  in v1. `10-security.md` (Side-effect pipeline) sends those same calls through `check_sink`.
- **C7 surface, not its targets.** `HumanRequestKind::CapabilityApproval` exists
  (`07-computer.md`). Settings lists grants, and the banner is kind-specific with desktop Approve
  and phone Deny for high-impact kinds (`09-frontend.md`).
- **Dream tools.** `05-dream.md` sends `tools: []` and fails the batch on any tool-call channel.
  Missing closures for pre-pass contradictions fail the batch.
- **Two-phase dream apply, map/read split, and challenge refusal** still match across `00`, `01`,
  `05`, `06`, and `07`.

## Critical

### C5-r2. The console and sidecar still have two Windows identities

`07-computer.md` (api-anything sidecar) runs the sidecar “under the current Windows user.”
`07-computer.md` (Windows console sessions) then says console sessions and the sidecar do not run
as the interactive user: they use a dedicated local account, restricted token, or AppContainer,
with ACLs denying the data directory, `personality.md`, the Chrome profile, and the interactive
user’s Credential Manager. Until that isolation ships, unattended `ConsoleRun` is
`NeedsHuman { kind: CapabilityApproval }`.

Both sentences are current. The first is the identity Opus rejected. The second is the fix.
`10-security.md` (Consistency findings, item 3) still describes the first sentence as the live
`07` rule and says the restrictive reading applies until `REVIEW.md` records a decision.
`REVIEW.md` records the fix and does not retire that finding.

`07-computer.md` (Required tests) also has no canary test that a console session cannot read the
brain, the cookie database, a Credential Manager entry, or `personality.md`. The startup probe in
`10-security.md` (Execution modes and startup self-checks) is the only such test, and it is tied
to the reading `10` says is not yet adopted.

**Change.** Delete the “current Windows user” sidecar sentence. Make the dedicated identity the
only rule, including api-anything. Point `10` finding 3 at that paragraph and drop the
“until REVIEW decides” override. Add the four denial tests to `07`.

### C6-r2. Loopback authentication is required in one section and optional in the invariant

`07-computer.md` (Peer authorization) is the fix: a per-launch desktop secret delivered only to
the Tauri webview, no session without it, `Host` checked on every request, Maia’s own listeners
denied to automation Chrome and tool HTTP clients, Serve/Funnel-looking loopback refused, and
desktop presence for grant approval, panic clear, router URL or model, Tailscale allowlist, and
secret put/rotate. The Tauri origin is named (`tauri://localhost` or the configured custom
protocol).

`07-computer.md` invariant 10 still requires an application session only for non-loopback UI
requests. `07-computer.md` (Browser session and request protections) builds the Origin allowlist
only from loopback and Tailscale listener addresses, which excludes `tauri://localhost` after the
peer section included it. `10-security.md` (Consistency findings, item 1) quotes the old
loopback-is-a-peer rule and keeps it in force. `07` network tests still do not assert that a
loopback client without the desktop secret receives no session.

**Change.** Make invariant 10 require the desktop secret on loopback. Generate one Origin
allowlist that includes the Tauri origin. Retire finding 1. Add the negative loopback test.

### C2-r2. The wire form and the router contract describe different payloads

`03-thread-cache.md` (Wire form) maps slots to OpenAI `messages`, appends recall and scratch to
the last user part, and sends `tools` as the same canonical JSON that `## tools` already placed
in the system message. The red test asserts a common prefix on the serialized provider payload.

`07-computer.md` (Canonical request) stores `compiled_prompt: Bytes` and says the adapter
translates that request “without changing prompt bytes.” `08-rust.md` (Honest leaves) compiles a
prefix and appends scratch only; it has no `append_recall` and no wire mapping. Tool schemas
therefore appear both inside the hashed system message and in `tools`, while the adapter is
forbidden to reshape bytes into messages. The byte-identical restart test can pass on Maia’s
internal prefix while the provider cache key stays undefined.

Installed memory notes, which sit inside `## transcript`, have no message role. In-turn tool
messages are described only as “opaque provider state on the assistant tool-call message.”

**Change.** Make `03`’s serialized `messages` plus canonical `tools` JSON the only
`RouterRequest` body. Say the adapter sends that JSON and does not re-encode it. Give installed
notes and tool-round messages explicit roles. Add `append_recall` beside `compile_prompt` in
`08`, or stop calling `08` the signature authority until it matches `03`.

### C-taint-r2. Origin is stored, and nothing can compute it

`02-brain.md` (Fact) adds `FactOrigin` and a quarantine enum. `rank_paths` takes
`QuarantineSet`. `04-credit.md` (Correction mark) puts a corrected fact in `CorrectionHold`.
`05-dream.md` (Structured dream batch schema) ignores the model’s `origin` and stores the
strictest origin in the union of source-episode provenances.

`02-brain.md` (Episode) has no provenance, no segment list, and no `FactOrigin`. There is no
order on `Owner`, `Agent`, `VaultHuman`, `VaultGenerated`, `Web`, `Tool`, and `Api`, so
“strictest” is not a function. `08-rust.md` `rank_paths` takes no quarantine set and returns
`Vec<RankedFact>`.

`10-security.md` (Provenance and taint, Memory and dream integrity) specifies a second system:
`Trusted`/`Untrusted`, dream-batch taint, and `RecallTaintMode` on ranking policy. `02` has
neither `RecallTaintMode` nor a map from `FactOrigin` to `Taint`. Finding 13 in `10` still asks
for those fields and says they are not in `02`. A fact can be quarantined in one document and
retrievable under `IncludeUntrusted` in the other.

**Change.** Put segment provenance on the episode. Define one total order for `FactOrigin`.
Pass quarantine into the `08` signature. Map each origin to `Trusted` or `Untrusted`, and make
`rank_paths` apply quarantine and `RecallTaintMode` as two explicit inputs. Delete the duplicate
rule.

## Important

These were deferred in `REVIEW.md` or left inconsistent by the critical edits. They are not a
second copy of the prior lists.

1. **`08` is still the signature authority and still the old signatures.** `activation` returns
   `Option` and takes no `AgeUnit`. `attribute_uses` takes slots and a trace, not
   `AttributionScope`, so it cannot see recall items or an unattributable turn. `append_recall`
   is absent. `rank_paths` drops quarantine and walked paths. `apply_ledger` is still only a
   prose command on `BrainStore`, not a joint thread-and-brain commit.
2. **Credit contradicts itself on the path C1 added.** `04-credit.md` (Evidence boundary) scores
   a tool-result-only match at `0`. The weight rules, attribution step 5, and the testing
   contract still give every tool-result match weight `1`. Attribution step 3 builds candidates
   only from durable slots, after the scope paragraph added recall items.
3. **Compaction policy is not one struct.** Prose defaults `min_interval_turns` to 3 and splits
   transcript budget from memory budget. `CompactionPolicy` lists neither. The centroid of an
   empty compacted block is undefined, and `Unfixable` “surfaces `NeedsHuman` or stops the
   lease.”
4. **Console grants do not name the same target.** `07` admits a command when the executable is
   on an allowlist, the directory is under a granted root, and egress matches `ConsoleNetwork`.
   `10` `Capability::ConsoleExec` is `{ workspace, network }` with no executable allowlist.
   `10` lets a phone approve `Confirm`-tier sinks. `09` lets the phone only deny
   `CapabilityApproval` for Execute, CredentialUse, and WriteRemote.
5. **`NeedsHuman` cancel has two successors.** `06-agents.md` (Accepted transitions) goes to
   `Running` with a new lease. `07-computer.md` and `09-frontend.md` go to `Stopped`.
6. **Panic versus a broken audit is still two sentences.** `06-agents.md` (Failure modes)
   disables “panic mutations.” `10-security.md` reads that as `InspectOnly` until
   `DesktopConfirm`, while also requiring panic to stay reachable. Engaging panic is not named
   as allowed.
7. **`10-security.md` (Consistency findings) describes the pre-fix set.** Items 1, 3, 6, 19, and
   20 contradict chapters that now contain the fix, and the section says that older reading
   applies until `REVIEW.md` records each decision. `REVIEW.md` does not.
8. **The request record omits the recall hash** in its field list (`03-thread-cache.md`, Request
   record) while the request sequence stores it. The Cache inspector still selects “the same
   fact” for every slot.
9. **An end marker inside the human region is still the first-match rule.** `01-vault.md` defines
   the region as the bytes before `<!-- maia:human:end -->` and also fails duplicated or nested
   markers. Which rule wins for a marker inside the region is unstated.
10. **Still open from the prior Important lists, unchanged by this pass:** ACT-R age still
    rejects `t = 0` and a future timestamp fails the whole rank, while `02` (Explicitly out of
    scope) says the time unit is unset beside `AgeUnit::Seconds`; dream embed timing and panic
    admission; `AgentId` to vault folder; router credential one-shot injection (`11` still forbids
    `resolve` on the router path); 720 px rail plus 480 px conversation; joint ledger port;
    participant scope on episodes and `map`/`read`.

## Minor

1. `03-thread-cache.md` tests still say a second load keeps “the old summary.” First install
   stores the fact sentence, not a summary.
2. `02-brain.md` invariant 2 lists rank inputs as graph, query, time, and policy, and omits
   `quarantine`.
3. `07-computer.md` still types reasoning as `Option<String>`. Blank and missing stay
   indistinguishable for half-weight.
4. The Chrome profile sentence still says “restricted to the current Windows user”
   (`07-computer.md`, Persistent Chrome) beside the sandbox identity that must not be that user.

## Checklist

| `REVIEW.md` item | Result |
| --- | --- |
| Goal alignment | Pass. Recall, compaction, and the tool enum now sit on the token and computer-use path. |
| Consistency | Fail. C5-r2, C6-r2, C2-r2, C-taint-r2. |
| Correctness | Fail. Provider payload and origin derivation still have no single oracle. |
| Security | Fail. Shell identity and loopback session each have two live rules. |
| Frontend | Partial. Approval banner and grant settings exist. Cancel, phone Confirm, and selection identity still disagree. |
| Dual re-review Accept | Not met. |

## Required before the next review

1. One sandbox identity, and retire the contradictory sidecar sentence (C5-r2).
2. One loopback session rule and one Origin allowlist (C6-r2).
3. One provider payload, owned by `03` and copied by `07` and `08` (C2-r2).
4. One origin derivation with episode provenance, a strictness order, and the same quarantine
   input on every `rank_paths` (C-taint-r2).
5. Either update `08` and the `10` consistency-findings list to the revised chapters, or stop
   treating them as authorities that override those chapters.
