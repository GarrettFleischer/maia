# Review, feat/maia-agent-os, 2026-11-05

**Reviewed by**: Composer (jsm-reviewer subagent)
**Scope**: 26 Rust modules/tests (vault + agents/security/audit; excludes brain/credit), uncommitted tree
**Verdict**: Blocked

## Summary

Workstream 1 delivers solid frontmatter parsing, entity rendering with human-byte preservation, and a filesystem adapter with canonical-root confinement and compare-and-swap writes. Workstream 4 delivers partial pure leaves (scheduler reducer, budget admission, sink/egress stubs, audit hash chain) with focused contract tests. Several security-sensitive leaves fail closed in documentation but not in code: `check_sink` ignores the `grants` parameter and allows multiple sinks without grant coverage; generated index rendering skips `neutralize_inline_markdown` on descriptions; vault error variants `DuplicateId` and `AmbiguousPath` are never produced. Audit chaining uses FNV-1a (acceptable only as a provisional link hash until signed checkpoints land). All scoped crate tests pass; `cargo deny check` is clean.

## Blockers

### 🔴 `check_sink` allows secret and credentialed actions without grant coverage, `crates/maia-core/src/security/sink.rs:123-149`

**Problem**: `SinkKind::SecretUse` and `SinkKind::CredentialedAction` branch only on `Taint`, never on `action.grant_state` or the `grants` slice. A caller can pass `GrantState::Ungranted` and still receive `Allow` in a trusted context.

**Why it matters**: Violates `10-security.md` default deny and the version-one decision table rows for secret use and credentialed actions (`10-security.md` §Sink checks, table). This is a fail-open path at the side-effect gate.

**Violated design clause**: `10-security.md` invariants 1–2; sink table rows “Secret use, granted” and “Credentialed action, granted”.

**Suggested fix**: Deny when no covering grant is present (evaluate `grants` and/or require `GrantState::Granted` with matching capability). Mirror the table for both taint levels.

**Red regression test**: `check_sink_secret_use_ungranted_is_deny_even_when_trusted` and `check_sink_credentialed_ungranted_is_deny_even_when_trusted` in `crates/maia-core/tests/security_sink.rs`.

### 🔴 `check_sink` ignores `grants` (dishonest leaf), `crates/maia-core/src/security/sink.rs:30-37`

**Problem**: The public signature accepts `grants: &[CapabilityGrant]` but the parameter is unused (`_grants`). Decisions rely entirely on precomputed `CanonicalAction.grant_state`, which the type system does not enforce.

**Why it matters**: `10-security.md` and `08-rust.md` honesty rules require sink decisions to be pure functions of explicit inputs including grants. A buggy skin can mark any action `Granted` and bypass the table.

**Violated design clause**: `10-security.md` §Honesty preamble (`check_sink` leaf); `06-agents.md` / `08-rust.md` port honesty expectations.

**Suggested fix**: Derive `grant_state` (and grant id) inside `check_sink` from `grants`, `action`, and policy, or remove the parameter and document that `CanonicalAction` must be built by a trusted wrapper only (design prefers the former).

**Red regression test**: `check_sink_denies_when_grants_empty_but_grant_state_granted` (proves the leaf cannot be fooled by inconsistent inputs).

### 🔴 Context egress always allowed without grant check, `crates/maia-core/src/security/sink.rs:151-154`

**Problem**: `SinkKind::ContextEgress` returns `Allow` unconditionally.

**Why it matters**: Table row “Context egress to the router, granted” requires a covering grant; ungranted egress should not reach `Allow`.

**Violated design clause**: `10-security.md` sink table; invariant 1 (no side effect without covering grant).

**Suggested fix**: Deny when no `ContextEgress` grant matches; allow only when granted (taint may still be untrusted per table).

**Red regression test**: `check_sink_context_egress_ungranted_denies`.

## Major

### 🟠 Generated index bodies omit neutralization on descriptions, `crates/maia-core/src/vault/render.rs:18-24`

**Problem**: `render_index` copies `child.description` verbatim into generated Markdown list lines. Only fact sentences in entity pages pass through `neutralize_inline_markdown`.

**Why it matters**: When Maia regenerates folder indexes from child frontmatter (`01-vault.md` §Generated index contract), a hostile or synced description can inject `[[…]]`, HTML, or `<!-- maia:` markers into Maia-written vault bytes, violating Obsidian safety (`10-security.md` §Vault and Markdown safety; `01-vault.md` neutralization cross-ref).

**Violated design clause**: `10-security.md` invariant 11; `01-vault.md` fact/description neutralization requirement (descriptions in generated index bodies are Maia-written output).

**Suggested fix**: Run `neutralize_inline_markdown` on each description before emitting index lines (same renderer version as entity facts).

**Red regression test**: `render_index_neutralizes_wikilink_in_description` in `crates/maia-core/tests/vault_contract.rs`.

### 🟠 `DuplicateId` and `AmbiguousPath` are declared but never returned, `crates/maia-core/src/vault/error.rs:30-32`

**Problem**: `VaultError` includes `AmbiguousPath` and `DuplicateId`, but no vault code path validates global ID uniqueness or ambiguous folder/file resolution (`grep` shows definitions only).

**Why it matters**: `01-vault.md` requires duplicate IDs to block map/index/projection and ambiguous resolution to error; missing enforcement allows silent inconsistency during navigation and dream projection.

**Violated design clause**: `01-vault.md` §Note and frontmatter contract; §`map` and `read` contracts (`AmbiguousPath`, `DuplicateId`).

**Suggested fix**: Enforce duplicate-ID detection when building index/map over siblings (or vault-wide registry at projection), and reject paths that resolve to both file and directory candidates.

**Red regression test**: `map_duplicate_id_in_folder_returns_duplicate_id_error`; `map_ambiguous_file_and_folder_returns_ambiguous_path`.

### 🟠 `check_egress` ignores owner grants for non-public destinations, `crates/maia-core/src/security/egress.rs:24-50`

**Problem**: Non-public address classes are always denied except loopback when `allow_loopback_router` is set. The `grants` parameter is unused.

**Why it matters**: `10-security.md` §Egress policy requires owner-granted exceptions naming exact address/port (`Confirm`). Current leaf cannot model allowlisted tailnet/LAN egress.

**Violated design clause**: `10-security.md` egress rules bullet 2; `check_egress` signature in §Egress policy.

**Suggested fix**: When any resolved address is non-public, require a matching grant entry before allow; keep default deny.

**Red regression test**: `check_egress_allows_private_when_grant_matches_address` in `security_egress.rs`.

### 🟠 Open thread / post message allow without grant state, `crates/maia-core/src/security/sink.rs:155-158`

**Problem**: `OpenThread` and `PostMessage` always `Allow` regardless of `grant_state`.

**Why it matters**: Decision table: “Open thread or post message, **within grant**”. Ungranted fan-out should deny, not allow with taint propagation only.

**Violated design clause**: `10-security.md` sink table; budget lineage / confused-deputy controls (`10-security.md` T7).

**Suggested fix**: Deny when grant missing; allow when grant covers destination/thread.

**Red regression test**: `check_sink_post_message_ungranted_denies`.

### 🟠 Sink decision table coverage far below design testing contract, `crates/maia-core/tests/security_sink.rs` (entire file)

**Problem**: Only four sink tests exist. Design requires every `SinkKind`, both taints, grant states, presences, and floor rows with rule id assertions (`10-security.md` §Testing contract / Pure leaf tests).

**Why it matters**: Current tests miss fail-open rows above and cannot catch table regressions (captchas, admin floor, vault-out-of-scope confirm path, web ungranted confirm, etc.).

**Violated design clause**: `10-security.md` §Testing contract (`check_sink` exhaustive table).

**Suggested fix**: Add table-driven tests (one case per row/floor) asserting exact `RuleId`.

**Red regression test**: Parameterized `sink_table_v1_matrix` test fixture keyed by rule id.

### 🟠 No filesystem test for symlink/junction confinement, `crates/maia-vault/tests/vault_adapter_contract.rs`

**Problem**: Design requires integration tests for symlink traversal outside the vault root (`01-vault.md` §Testing contract). Adapter uses `canonicalize` + prefix check (`filesystem.rs:47-55`) but no test creates a junction/symlink escape attempt.

**Why it matters**: Regressions in path resolution or Windows reparse handling would read/write outside the vault without detection.

**Violated design clause**: `01-vault.md` §Testing contract (filesystem integration: symlink); `10-security.md` vault path confinement.

**Suggested fix**: Add Windows (and Unix symlink) fixture: link inside vault → outside target; assert `read`/`map`/`apply_generated` return `OutsideVault` or `NotFound`, never outside bytes.

**Red regression test**: `vault_junction_outside_root_is_outside_vault` in `vault_adapter_contract.rs`.

### 🟠 Scheduler reducer omits deferred-retry transition path, `crates/maia-core/src/agents/reduce.rs` + `types.rs:73-76`

**Problem**: `SleepReason::DeferredRetry` exists, but `SchedulerEvent` has no event to enter that state from `Running`, and `reduce_thread` does not handle retry completion.

**Why it matters**: `06-agents.md` §Four-state model lists `Running -> Sleeping` for deferred retry deadlines; router timeout flow depends on it.

**Violated design clause**: `06-agents.md` accepted transitions (`DeferredRetry { until }`).

**Suggested fix**: Add explicit events (e.g. `RetryDeferred { until }`, `RetryDue`) and transition table entries; test refused unattended wake before `until`.

**Red regression test**: `running_to_sleeping_records_deferred_retry_until`.

**Classification note**: Partial agents workstream may intend incremental delivery; treat as **defect in implemented scope** for the reducer contract, not as an invented fifth state.

## Minor

### 🟡 FNV-1a 64-bit audit link hash, `crates/maia-core/src/audit/chain.rs:45-55`

**Problem**: `stable_hash` uses non-cryptographic FNV-1a for `event_hash` / chain links. Design emphasizes detectable tampering via hash chain plus **signed** checkpoints (`06-agents.md` §Immutable audit; `10-security.md` §Immutable audit); signing/verification is not present in this crate yet.

**Why it matters**: FNV is fine for deterministic dev fixtures but is collision-prone if checkpoints bind to `event_hash` without a cryptographic hash step. Residual risk until SHA-256 (or similar) link hashing and checkpoint signing land.

**Violated design clause**: None fully specified for link hash algorithm (implementation choice); tension with `10-security.md` T17 mitigation narrative.

**Suggested fix**: Document as provisional; use a cryptographic hash for chain links before pairing with signed checkpoints.

**Red regression test**: `event_hash_matches_sha256_canonical_bytes` (golden vector).

### 🟡 Concurrent projection conflict maps to generic `Io`, `crates/maia-vault/src/filesystem.rs:170-173`

**Problem**: Content mismatch on `expected_before` returns `VaultError::Io` instead of a distinct conflict error.

**Why it matters**: Callers cannot distinguish concurrent human edit from disk failure (`01-vault.md` §Failure handling expects detectable concurrent edit for retry).

**Violated design clause**: `01-vault.md` concurrent edit detection (behavior correct; error taxonomy weak).

**Suggested fix**: Add `Conflict` or reuse a dedicated variant; keep prior bytes untouched (already true).

**Red regression test**: `apply_generated_concurrent_edit_returns_conflict_not_io`.

### 🟡 Child grant id allocation may collide under repeated attenuation, `crates/maia-core/src/security/grants.rs:36`

**Problem**: `GrantId(parent_grant.id.0 + index + 1)` is deterministic but not globally unique across repeated attenuation calls.

**Why it matters**: Approval/grant audit correlation could collide if the same parent grant attenuates multiple times in one lease.

**Violated design clause**: Stable grant identity expectations in `10-security.md` capability grants (implicit).

**Suggested fix**: Allocate ids from a skin-supplied counter or monotonic generator at persistence boundary.

**Red regression test**: `attenuate_grants_two_batches_never_reuse_grant_id`.

### 🟡 `render_approval` injectivity tested only on digest, not on distinct actions, `crates/maia-core/tests/security_approval.rs:6-17`

**Problem**: Injectivity check mutates digest bytes only; distinct actions sharing a digest would not be caught.

**Why it matters**: `10-security.md` requires injective rendering on canonical actions for approval spoofing defense.

**Violated design clause**: `10-security.md` §Approval tiers (`render_approval` injective).

**Suggested fix**: Test distinct `ApprovalAction` fields (destination/command) produce distinct views with fixed digest.

**Red regression test**: `render_approval_injective_on_command_with_same_digest`.

## Strengths

- Strict frontmatter parser with explicit rejection cases and exact post-frontmatter byte preservation (`vault_contract.rs`, `parse.rs`).
- Entity renderer preserves human regions and sorts facts deterministically with neutralization on fact sentences (`render.rs`, `vault_contract.rs`).
- Scheduler reducer covers panic gate, spend breaker unattended refusal, transcript budget, and approval denial stop threshold (`agents_scheduler.rs`).
- Audit chain verification tests cover edit, reorder, and checkpoint truncation (`audit_chain.rs`).

## Test coverage

**Commands run**

| Command | Result |
| --- | --- |
| `cargo test -p maia-core -p maia-vault --no-fail-fast` | 48 tests passed (integration + unit) |
| `cargo clippy -p maia-core -p maia-vault -- -D warnings` | Clean |
| `cargo deny check` | advisories, bans, licenses, sources ok |

**Assessment**: Vault parser/renderer tests are strong and byte-oriented. Filesystem adapter tests cover map leakage, read bytes, personality guard, and concurrent edit bytes but not symlinks/junctions. Security sink/egress tests cover a small fraction of the documented table. Audit tests cover chain integrity but not checkpoint signing (not implemented). Agents reducer tests omit deferred retry and many rejected transitions required by `06-agents.md`.

## Residual risks (not classified as immediate defects)

- Signed audit checkpoints and witness verification are design-required but not in this workstream’s Rust surface (`AuditCheckpoint` is hash-binding only).
- `find_known_secrets`, approval digest binding, and grant intersection for agent groups live in design docs but are not implemented in reviewed modules (expected for partial WS4).
- Brain/credit modules intentionally excluded from this review.

## Intentionally deferred / out of reviewed scope

- SQLite audit persistence, checkpoint signing skin, daemon scheduler I/O (`06-agents.md` skin).
- Windows containment reparse-point open flags on daemon reads (`10-security.md` §Shell containment item 9) beyond vault `canonicalize` prefix check.
- Full IPv4 literal / NAT64 / Teredo classification matrix (`10-security.md` testing table) — only sample cases tested.
