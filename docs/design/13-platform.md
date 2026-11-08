# Cross-platform runtime, credentials, and autonomy controls

## TDD preamble

- **Kind:** new feature
- **Invariant:** Maia runs one durable daemon design on Windows, Linux, and macOS while unattended execution is admitted only when the selected security profile and the current platform capability report allow it.
- **Red test(s):** workspace dependency graph; platform capability matrices; containment conformance; security-profile transition table; allowlist matching and precedence; credential-backend contract; encrypted-file corruption and lock lifecycle; API authorization; responsive and accessibility UI flows.
- **Then:** migrate the Windows-only adapters behind shared contracts, implement one platform skin at a time, and keep unsupported or failed capabilities in `NeedsHuman`.

## Honesty preamble

- **Leaves (honest):** `containment_verdict`, `admit_action`, `match_allowlist`, `reduce_security_profile`, `classify_platform_event`, `derive_encrypted_file_key`, and credential-backend transition descriptions receive every policy, probe, time, and input as parameters.
- **Skin (I/O):** Windows, Linux, and macOS containment; native credential stores; encrypted-file storage; Vault/OpenBao; SQLite; HTTP; embedding; Tauri; process, PTY, browser, signing, and packaging adapters.
- **Hooks (backward):** Axum routes, Tauri commands, OS lifecycle callbacks, and UI actions authenticate, parse, call one leaf or skin, and translate the result.
- **Mode args:** `SecurityProfile`, `PlatformKind`, `ContainmentCapability`, `CredentialBackendKind`, `ActionMatcher`, and `AdmissionVerdict` replace booleans.
- **Pause-and-review:** every new function must expose time and world state in its signature, keep platform I/O out of leaves, use typed modes, and stay at one abstraction level.

## Status and authority

**Status**: Accepted

Owner acceptance is recorded in `REVIEW.md`. This document is the accepted contract for the
cross-platform runtime, credential backends, security profiles, and structured allowlist. Where
`00-goal.md`, `07-computer.md`, `08-rust.md`, `09-frontend.md`, `10-security.md`, or
`11-secrets.md` conflict with this document, this document wins. Those documents are amended in
the same change. `12-files-previews.md` remains a draft and is not part of this decision.

## Summary

Maia becomes one cross-platform desktop product with separate Windows, Linux, and macOS adapters
behind shared Rust contracts. Unattended execution remains fail-closed: Windows and qualifying
Linux hosts may pass containment checks, while macOS requires human participation for tool
execution because supported public APIs cannot provide an equivalent per-tool sandbox.

The owner chooses a global security profile during onboarding. `Protected` prompts for risky
actions. `Allowlisted` suppresses the approval prompt only for a structured matching entry and
still requires a covering grant. `Unrestricted` makes controllable `check_sink` gates auto-Allow
and disables process containment. It never skips budget admission, the durable audit start, panic,
Stop all, audit verification, log redaction, or `DesktopConfirm` administration.

## Context

> ⚠️ Premise note: `Unrestricted` is an explicit owner choice, but it removes the controllable
> checks that bound a hostile model or prompt injection. Budget admission, the durable audit start,
> panic, Stop all, audit verification, persistent status, log redaction, and `DesktopConfirm`
> administration remain non-bypassable. Calling this mode safe would be misleading; the product
> must describe it as full local authority.

The current design binds desktop execution, credential storage, unsafe Rust, and containment to
Windows. The product must also run on Linux and macOS without pretending that their security
primitives are equivalent.

The same change must let an informed owner trade safety for autonomy. Repeated approval prompts
are an attention-denial vector and make unattended work impractical. The answer is an explicit
profile state and a structured allowlist, not hidden exceptions or unrelated settings toggles.

## Requirements

### Cross-platform runtime

- **AC-1:** one core domain and daemon contract builds on Windows x64, Linux x64, and macOS x64 and arm64.
- **AC-2:** platform selection occurs through compile-time adapter selection, while runtime probes still gate each unattended spawn.
- **AC-3:** an unknown, unavailable, deprecated, or insufficient containment primitive never counts as a pass.
- **AC-4:** a failed startup probe appears in Health and Settings with a safe reason; the probe is repeated before every unattended spawn.
- **AC-5:** losing containment after spawn kills the contained process tree, records `UnknownOutcome` when external effects cannot be disproved, and moves the thread to `NeedsHuman`.
- **AC-6:** Chrome's dedicated profile and debugging pipes remain daemon-owned on every platform; tool sandboxes request closed browser intents.
- **AC-7:** the first signed release targets Windows x64, Linux x64, and a macOS universal binary. Windows uses Authenticode. Linux AppImage and Debian packages carry detached GPG signatures from the same release key used for policy bundles. macOS is signed and notarized and requires macOS 13 or newer.

### Credential backends

- **AC-8:** onboarding requires selection of native OS storage, an encrypted local file, or Vault/OpenBao.
- **AC-9:** native storage maps to Windows Credential Manager, macOS Keychain, and Linux Secret Service API v2 (`org.freedesktop.secrets`). KWallet is acceptable only when it implements that API. If the DBus session bus or the service is absent, the native backend is `LockState::Unavailable`.
- **AC-10:** the encrypted-file backend derives a key from a user passphrase with Argon2id and encrypts authenticated data with XChaCha20-Poly1305. Argon2id memory, iterations, and parallelism are benchmark-gated: they are recorded in this document from a measured desktop benchmark before that backend is accepted, and they are not invented here. Each atomic replacement generates a fresh random nonce, stores it in the authenticated header, and never reuses it.
- **AC-11:** the encrypted-file backend locks on OS lock, suspend, daemon exit, and a configurable idle timeout whose default is 15 minutes. Idle is the time since the last successful `SecretStore::resolve`. Promotion, dreams, and other daemon-only background activity do not reset it. Lock and suspend sources are Windows session-lock (`WTS_SESSION_LOCK`) and suspend (`PBT_APMSUSPEND`); Linux `org.freedesktop.login1.Session` `LockedHint` and `PrepareForSleep`; and macOS `com.apple.screenIsLocked` plus `NSWorkspaceWillSleepNotification`.
- **AC-12:** changing backend changes only the active backend. It neither copies nor deletes old values. Missing credentials are registered again as needed.
- **AC-13:** no backend falls back silently. A locked, missing, or unavailable active backend turns secret-using actions into `NeedsHuman` while non-secret features continue.
- **AC-14:** secret values remain inside the consuming skin and never enter prompts, audit payloads, logs, URLs, CLI arguments, phone responses, or browser DOM.

### Security profiles and allowlist

- **AC-15:** onboarding requires an explicit choice of `Protected`, `Allowlisted`, or `Unrestricted`; there is no hidden default.
- **AC-16:** the active profile is global. Allowlist entries may narrow their scope to an agent.
- **AC-17:** only the local desktop may enable `Unrestricted`, after one explicit confirmation. The choice persists until changed.
- **AC-18:** paired owner clients may view the profile and switch to a safer profile, but cannot enable `Unrestricted`.
- **AC-19:** `Unrestricted` makes controllable `check_sink` gates auto-Allow. Those gates are grants, presence, egress, and containment. It also suppresses Maia approval prompts and disables process-sandbox admission. It never skips budget admission, the durable audit start, panic, Stop all, audit verification, log redaction, or `DesktopConfirm` administration. External requirements such as MFA, CAPTCHA, OS consent, a locked credential backend, or missing credentials still return `NeedsHuman`.
- **AC-20:** panic, Stop all, audit-chain verification, budget admission, the durable audit start, persistent status, action audit stamping, secret redaction from logs, and `DesktopConfirm` administration cannot be disabled by any profile.
- **AC-21:** switching from `Unrestricted` to a safer profile cancels running unsandboxed actions and records `UnknownOutcome` where side effects cannot be disproved.
- **AC-22:** `Allowlisted` keeps platform containment enabled. A matching entry suppresses only the Maia approval prompt. The action still requires a covering capability grant, and the sink and containment checks still apply. A nonmatching action follows normal policy and prompting.
- **AC-23:** an always-allowed entry is exact by default and may be deliberately broadened by capability, typed target, destination, agent, lifetime, or session. Command entries are OS-specific and match a canonical absolute executable path for that OS only.
- **AC-24:** entries may be created from an approval prompt or in Settings, are permanent by default, and may instead expire or last one session. A session is the daemon process lifetime, from start until stop or restart, and does not survive either. It is not an authenticated client session and not a scheduler lease. Entries keep their `enabled` flag across profile switches.
- **AC-25:** Unrestricted mode is continuously visible in the app banner, window, and tray. The banner provides one action to return to `Protected`.

### UI and API

- **AC-26:** Settings contains a Security page for the profile, capability report, allowlist, and immutable audit status.
- **AC-27:** the approval sheet supports `Allow once`, `Always allow this exact action`, deliberate scope expansion, and `Deny`.
- **AC-28:** dedicated authenticated resources expose profile and allowlist state. Enabling `Unrestricted` rejects nonlocal clients.
- **AC-29:** the existing desktop and phone panic controls remain reachable under every profile and viewport.

## Options considered

### Keep the Windows-only runtime

This preserves the current AppContainer, Job Object, ConPTY, and Credential Manager design.

**Pros:**

- smallest adapter and CI surface;
- strongest current unattended implementation path.

**Cons:**

- does not meet the cross-platform product requirement;
- keeps domain-adjacent crates coupled to one operating system.

### One cross-platform adapter crate

One `maia-platform` crate could use `cfg` modules for all operating systems.

**Pros:**

- fewer workspace crates;
- one dependency for daemon composition.

**Cons:**

- platform unsafe code, dependencies, and conformance rules become harder to audit separately;
- a broad crate makes accidental cross-platform feature assumptions easier.

### Shared contract with separate platform adapters

A pure containment contract defines readiness and admission. Windows, Linux, and macOS implement
separate skins, and each must pass its own conformance suite.

**Pros:**

- keeps policy portable and testable;
- makes unsupported capabilities explicit and fail-closed;
- isolates unsafe and platform dependencies.

**Cons:**

- adds crate, release, and CI maintenance;
- macOS cannot claim unattended arbitrary-process parity.

## Decision

**Chosen option:** shared contract with separate platform adapters.

**Implementation skills:** `rust-async-patterns` (`wshobson/agents`,
`.agents/skills/rust-async-patterns/`) · `rust-best-practices`
(`apollographql/skills`, `.agents/skills/rust-best-practices/`) · `vite`
(`antfu/skills`, `.agents/skills/vite/`) · `vitest` (`antfu/skills`,
`.agents/skills/vitest/`) · `playwright-cli` (`microsoft/playwright-cli`,
`.agents/skills/playwright-cli/`) · `playwright-best-practices`
(`currents-dev/playwright-best-practices-skill`,
`.agents/skills/playwright-best-practices/`) · `typescript-advanced-types`
(`wshobson/agents`, `.agents/skills/typescript-advanced-types/`) ·
`pwa-development` (`alinaqi/maggy`, `.agents/skills/pwa-development/`) ·
`tauri-v2` (`nodnarbnitram/claude-code-extensions`,
`.agents/skills/tauri-v2/`)

## Rationale

Fixing the existing Windows adapter in place cannot satisfy the platform requirement. A direct
replacement with one `cfg`-heavy crate would compile on every target but weaken the audit boundary.
Separate adapters behind an honest shared contract preserve the current dependency direction and
allow each operating system to prove only the capabilities it actually has.

The fail-closed asymmetry is intentional. Windows and qualifying Linux hosts can earn unattended
readiness through conformance tests. macOS cannot currently provide an equivalent supported
per-tool sandbox, so reporting readiness there would be a false security claim.

Named security profiles are chosen over independent toggles because they prevent persisted
combinations whose meaning is unclear. The owner may choose full autonomy, but the interface and
audit always identify that choice.

### Platform boundary

Create a shared `maia-containment` contract and three leaf adapters. `maia-containment` owns
capability reports, admission verdicts, and safe request and result types. It performs no I/O.
Each platform crate owns only its OS calls and translates into the shared types. `cfg` chooses
exactly one compiled skin; runtime probes decide whether a requested capability is currently ready.

The old `maia-win32` crate is replaced by `maia-windows`. Exactly one of `maia-windows`,
`maia-linux`, or `maia-macos` is compiled for a target. That crate is the only horizontal adapter
dependency of `maia-daemon`, `maia-tools`, and `maia-secrets`. Each platform crate depends on
`maia-containment` and on no other workspace crate. `maia-tools` uses it only for the PTY port.
`maia-secrets` uses it only for native credential FFI.

```text
maia-daemon --> maia-containment --> maia-core
maia-daemon --> maia-windows | maia-linux | maia-macos
maia-windows | maia-linux | maia-macos --> maia-containment
maia-tools --> selected platform adapter
maia-secrets --> selected platform adapter
```

Unsafe code is permitted only in these places:

- `maia-windows`: Job Objects, AppContainer profiles, ConPTY, pipe ACLs, and Credential Manager FFI;
- `maia-linux`: user-namespace, seccomp, Landlock, and bubblewrap calls that safe wrappers cannot express;
- `maia-macos`: Keychain and lifecycle-probe FFI only; it implements no sandbox;
- `maia-store`: the one static `sqlite-vec` registration function.

Listing a crate here permits unsafe code in that scope. It does not require the crate to
contain unsafe code. A listed crate with no unsafe code may keep `#![forbid(unsafe_code)]`.
That attribute is stricter than the permission and is not a missing boundary.

Every other workspace crate uses `forbid(unsafe_code)`. No unsafe block parses untrusted bytes.
Every unsafe block states its safety preconditions in a `// SAFETY:` comment and has a conformance
test outside the block. `maia-secrets` stays `forbid(unsafe_code)` and calls only safe functions
exported by the selected platform adapter.

### Containment matrix

| Platform | Unattended readiness | Required controls | Missing control |
| --- | --- | --- | --- |
| Windows | Supported | LPAC/AppContainer identity, kill-on-close Job Object, process assignment before resume, ConPTY where needed | `NeedsHuman` |
| Linux | Conditional | kernel 6.4 or newer, user namespaces, bubblewrap, seccomp, Landlock ABI 6 or newer, cgroup v2, fresh devpts | `NeedsHuman` |
| macOS | Not supported for arbitrary child tools | macOS 13 or newer; supported public APIs provide no equivalent per-tool sandbox; deprecated `sandbox-exec` is never a pass | `NeedsHuman` |

Linux hosts older than 6.4, or hosts missing any required control, remain usable. Unattended tool
execution on those hosts is `NeedsHuman`. The capability report shown in Health includes the kernel
version and Landlock ABI. macOS still runs conversation, memory, vault, router, UI, browser
inspection, scheduling, and human-approved actions that do not require an unattended
arbitrary-process boundary. It does not claim containment it cannot enforce. The minimum macOS
version is 13.

```rust
pub enum ContainmentVerdict {
    UnattendedReady(CapabilityReport),
    NeedsHuman(ContainmentFailure),
}

pub fn containment_verdict(
    report: &CapabilityReport,
    required: &RequiredCapabilities,
) -> ContainmentVerdict;
```

The daemon obtains a report at startup for display and obtains a fresh report before each spawn.
Only the second report authorizes the spawn.

### Process, PTY, and browser ownership

- Windows uses AppContainer, Job Objects, and ConPTY through `maia-windows`.
- Linux uses bubblewrap for namespace setup, seccomp and Landlock for syscall and resource
  restrictions, cgroup v2 for process and resource ownership, and a fresh devpts instance.
- Linux and macOS create terminal sessions with the POSIX PTY calls `posix_openpt`, `grantpt`, and
  `unlockpt`. `maia-tools` does not call those APIs. It calls a narrow PTY port implemented by the
  selected platform adapter. Windows implements that port with ConPTY.
- macOS provides a probe-only containment adapter until a supported public mechanism can meet the
  same contract.
- Chrome always uses a nondefault Maia profile. The daemon parent owns the profile and pipe file
  descriptors. Sandboxed tools never inherit browser credentials or the profile directory. On Linux
  the profile directory is not bind-mounted into the bubblewrap sandbox, is owned by the daemon
  process UID, and is unreadable by the mapped sandbox UID. The containment conformance test is the
  oracle for that exclusion.
- A platform capability failure is a typed result, not a warning string.

### Credential storage

```rust
pub enum CredentialBackendKind {
    Native,
    EncryptedFile,
    VaultOpenBao,
}

pub struct CredentialSettings {
    pub active_backend: CredentialBackendKind,
    pub encrypted_file_idle_timeout: Duration,
}
```

The native adapter uses a narrow cross-platform keyring skin and maps to Credential Manager,
Keychain, or Secret Service API v2. A missing DBus session bus or a missing
`org.freedesktop.secrets` service is `LockState::Unavailable`, not a fallback to another backend.

The encrypted file lives in Maia's owner-only application-data directory, never in the Obsidian
vault. Its authenticated header contains a format version, KDF identifier and parameters, random
salt, cipher identifier, and nonce. Ciphertext contains the credential records and an integrity
version. Atomic replacement and corruption recovery follow the same temp, sync, and replace
discipline as generated vault files.

The passphrase is accepted only through a local Tauri command. It is never an HTTP request field,
so plaintext never enters HTTP. Argon2id parameters are versioned in the header and may be raised
on a later successful unlock. Memory, iterations, and parallelism stay unset until a measured
desktop benchmark records them in this document. The encrypted-file backend is not accepted before
that record exists. Plaintext and derived keys use zeroizing buffers and are cleared when the
Tauri command returns. There is no recovery bypass. Each atomic file replacement uses a new random
nonce in the authenticated header.

Switching backend writes only `active_backend`. It does not copy values and it does not delete
values. Old backends remain untouched. References missing from the newly active backend appear as
unavailable and may be registered again by the owner. `11-secrets.md` has no migration flow.

Native per-secret handles, amended on `SecretBackend` in `11-secrets.md`, are
`WindowsCredentialVault { target }`, `Keychain { account }`, and
`SecretService { collection, label }`. Encrypted-file records use
`SecretBackend::EncryptedFile` and are addressed by `SecretId`. Backend-specific
handles stay private to `maia-secrets`.

### Storage, HTTP, embedding, daemon, and frontend stack

| Layer | Choice |
| --- | --- |
| SQLite | `rusqlite` with bundled SQLite, static `sqlite-vec`, forward-only SQL migrations |
| SQLite ownership | one named blocking owner thread, bounded Tokio command channel, separate panic lane |
| HTTP | `reqwest` with rustls and native roots; redirects, cookies, and proxy discovery disabled |
| Embedding | Candle CPU with hash-pinned `bge-small-en-v1.5`, 384 dimensions, no runtime downloader |
| Daemon | Tokio, Axum 0.8, Tauri 2.12.5 |
| Rust | newest compatible stable toolchain; pin nightly only if a required feature has no stable form |
| Frontend | `frontend/`, Vite, React, TypeScript, Vitest, Testing Library, Playwright |
| PWA | hand-written service worker that caches only the static asset manifest and never `/api` or `/ws` |
| Linux packages | AppImage and Debian package, each with a detached GPG signature from the policy-bundle release key; tested on the current Ubuntu LTS |
| Windows release | Authenticode-signed x64 bundle |
| macOS release | signed and notarized universal bundle; minimum macOS 13 |

`maia-core` remains free of framework and serialization dependencies. Axum DTOs stay in
`maia-daemon`. Model weights, tokenizer bytes, dimensions, and query/document prefixes are
identified and hashed in persistent vector metadata. A mismatch disables vector use for those
rows and falls back to full text and lexemes.

### Security profile state

```rust
pub enum SecurityProfile {
    Protected,
    Allowlisted,
    Unrestricted,
}

pub struct SecuritySettings {
    pub profile: SecurityProfile,
    pub activated_at: Timestamp,
    pub activated_by: OwnerClientId,
    pub local_unrestricted_confirmation: Option<ConfirmationRecord>,
}

/// Recorded when the local desktop enables `Unrestricted`.
/// `desktop_client_id` is the authenticated desktop `OwnerClientId`.
/// `PresenceProof` is the enum in `10-security.md`.
pub struct ConfirmationRecord {
    pub confirmed_at: Timestamp,
    pub desktop_client_id: OwnerClientId,
    pub presence_proof: PresenceProof,
}
```

Profile semantics:

| Profile | Maia approval prompts | Maia policy gates | Process containment |
| --- | --- | --- | --- |
| Protected | Required by policy | Enforced | Required for unattended execution |
| Allowlisted | Skipped only for a matching entry | Enforced | Required |
| Unrestricted | Suppressed | Controllable `check_sink` gates auto-Allow; AC-20 controls still run | Disabled |

This is one enum, not two booleans. Impossible combinations therefore cannot be persisted.

### Structured allowlist

The allowlist extends the existing capability-grant model. It is not a second authorization
engine.

```rust
pub struct AllowlistEntry {
    pub id: GrantId,
    pub capability: CapabilityKind,
    pub matcher: ActionMatcher,
    pub agent: Option<AgentId>,
    pub lifetime: GrantLifetime,
    pub enabled: bool,
    pub created_at: Timestamp,
    pub created_by: OwnerClientId,
}

pub enum GrantLifetime {
    Permanent,
    ExpiresAt(Timestamp),
    /// Matches only during the daemon process that created the entry.
    DaemonLifetime { generation: u64 },
}

pub enum PlatformKind {
    Windows,
    Linux,
    MacOs,
}

/// OS-specific. A Windows entry does not match Linux or macOS, or the reverse.
/// `executable` is a canonical absolute path for `platform` only.
pub struct CommandMatcher {
    pub platform: PlatformKind,
    pub executable: CanonicalExecutablePath,
    pub args: Vec<String>,
}

pub enum ActionMatcher {
    Command(CommandMatcher),
    Web(WebMatcher),
    File(FileMatcher),
    Secret(SecretMatcher),
    Browser(BrowserMatcher),
    Thread(ThreadMatcher),
}
```

Each matcher uses parsed typed fields rather than regex over display text. New entries copy the
canonical action exactly. The owner may broaden individual fields in a review sheet that shows
the resulting scope before save. Maia never invents or broadens a pattern.

`CanonicalExecutablePath` is absolute. On Windows it follows the canonical `WindowsPath` rules in
`07-computer.md`. On Linux and macOS it is an absolute POSIX path with `.` and `..` removed. A
command entry matches only when the spawn platform, the canonical executable path, and the exact
argument vector all match. An allowlist match suppresses only the approval prompt. The action
still needs a covering capability grant, and sink and containment checks still run.

Allowlist rows, including `enabled`, persist independently of the active profile. Switching among
`Protected`, `Allowlisted`, and `Unrestricted` does not change `enabled`. Entries may be created
while `Protected` is active. Entering `Allowlisted` immediately applies enabled, unexpired rows.
`DaemonLifetime` entries match only while `generation` is the current daemon process generation
and are not consulted after stop or restart.

### Admission order

Every action records an audit start before execution. Admission is deterministic:

1. Authenticate the client or model-originated request and load the global profile.
2. If `Unrestricted`, stamp the action with that profile. Controllable `check_sink` gates
   (grants, presence, egress, and containment) return `Allow`, and process containment is not
   applied. Budget admission, the durable audit start, panic, Stop all, audit verification, log
   redaction, and `DesktopConfirm` administration still run.
3. Otherwise compute provenance, capability, target, destination, secret references, and the
   platform capability report.
4. In `Allowlisted`, test enabled and unexpired structured entries. A match removes only the
   approval prompt. It does not replace the capability grant.
5. Apply capability, sink, egress, secret-scope, and containment checks. Under `Unrestricted`
   this step is the auto-Allow described above and still includes budget admission.
6. If policy requires human action, enter the existing typed `NeedsHuman` flow.

Panic, Stop all, audit-chain verification, visible profile state, and secret redaction from logs
run before this profile branch or after it as non-bypassable controls. `DesktopConfirm`
administration is not a tool-execution gate and is unaffected by the profile.

### State transitions

```text
Onboarding -> Protected | Allowlisted | Unrestricted
Protected <-> Allowlisted
Protected -> Unrestricted       local desktop confirmation only
Allowlisted -> Unrestricted     local desktop confirmation only
Unrestricted -> Protected       any owner client
Unrestricted -> Allowlisted     any owner client
```

Entering `Unrestricted` affects new admissions. Leaving it immediately cancels active unsandboxed
actions. An action whose external effects cannot be disproved becomes `UnknownOutcome`.

External human blockers remain typed regardless of profile. A website's MFA, CAPTCHA, legal
consent, OS consent, missing credential, or locked selected credential backend cannot be
completed by changing policy.

## Feature design

### Data model

| Entity | Key fields | Relationships and constraints |
| --- | --- | --- |
| `SecuritySettings` | singleton id, profile, activated_at, activated_by, `ConfirmationRecord` | exactly one active row; confirmation present only after local `Unrestricted` enablement |
| `AllowlistEntry` | grant id, capability, typed matcher, optional agent, lifetime, enabled, creation metadata | optional agent FK; canonical typed matcher; immutable creation audit; `enabled` survives profile switches |
| `PlatformCapabilitySnapshot` | platform, observed_at, adapter version, probe results, overall verdict, kernel and Landlock ABI when Linux | display uses the latest row; spawn rechecks live; retain the last 32 rows |
| `CredentialBackendSettings` | active backend, encrypted-file idle timeout | exactly one active backend; switching does not copy or delete values |
| `AuditEvent` | existing fields from `06-agents.md`, plus `profile` and `allowlist_entry_id` | `profile` always present; allowlist id present only when a match suppressed the prompt; both are inside the hashed canonical bytes |

### API surface

The v1 daemon surface in `07-computer.md` remains accepted and gains these routes. The same
additions are recorded there.

| Method and path | Purpose | Authorization |
| --- | --- | --- |
| `GET /api/security/profile` | current profile and non-sensitive activation metadata | owner client |
| `PUT /api/security/profile` | change profile | local desktop to enable `Unrestricted`; any owner to tighten |
| `GET /api/security/capabilities` | current safe capability report | owner client |
| `GET /api/security/allowlist` | list entries | owner client |
| `POST /api/security/allowlist` | create exact or deliberately broadened entry | owner client |
| `PUT /api/security/allowlist/:id` | edit scope, lifetime, or enabled state | owner client |
| `DELETE /api/security/allowlist/:id` | revoke entry | owner client |
| `POST /api/threads/:thread/approvals/:id` | approve, deny, allow once, or create an exact always-allow entry | owner client |
| `PUT /api/secrets/backend` | switch the active credential backend; no copy and no deletion | local desktop only |

The encrypted-file passphrase has no HTTP route. A local Tauri command accepts it and zeroizes it
before returning. Remote attempts to enable `Unrestricted` or to switch the credential backend
return `403`.

All errors use `{ "code", "message" }` without secrets, credential paths, vault paths, cookies, or
raw command output.

### Value sourcing

| Value | Source |
| --- | --- |
| active security profile | singleton `SecuritySettings.profile` |
| whether a client may enable `Unrestricted` | authenticated session `ClientClass` and loopback/Tauri origin |
| profile banner and tray state | active profile plus immutable audit status |
| allowlist match | canonical typed action plus enabled, unexpired `AllowlistEntry` rows |
| platform readiness shown in UI | latest `PlatformCapabilitySnapshot` |
| platform readiness used for spawn | fresh adapter probe performed for that spawn |
| active credential backend | `CredentialBackendSettings.active_backend` |
| encrypted-file lock state | local owner-task state, OS lock/suspend source, and idle deadline since the last successful `SecretStore::resolve` |
| capability history | the latest 32 `PlatformCapabilitySnapshot` rows; 32 is the local retention default |
| vector compatibility | stored model id, weight hash, tokenizer hash, dimension, and prefix metadata |
| `UnknownOutcome` | cancellation result plus whether external side effects can be disproved |

### UI contract

Settings adds a Security page containing:

1. three profile cards with plain-language consequences;
2. the platform capability report and exact safe failure reasons;
3. the structured allowlist with search, capability, target, agent, lifetime, enabled state, edit,
   and revoke;
4. immutable audit health;
5. credential-backend selection and encrypted-file lock state.

`Unrestricted` activation is local desktop only. It is `DesktopConfirm` administration: one
explicit confirmation dialog on the local desktop, recorded as a `ConfirmationRecord`. Remote
clients cannot enable it. While active, an orange warning banner remains below the application
header on every view, the tray and window expose the state, and the banner includes
`Return to Protected`. Tray status is verified by a Tauri integration test when the harness can
read the tray, and otherwise by a manual check of the same contract: the tray shows `Unrestricted`
while that profile is active and clears after `Return to Protected`. Vitest and Playwright cover
the in-window banner and do not replace the tray contract.

The existing approval sheet gains `Allow once` and `Always allow this exact action`. Choosing the
second opens the scope review before save. Remote clients may create allowlist entries but may not
enable `Unrestricted`.

The locked Mint Ledger tokens remain authoritative. Orange remains reserved for human attention
and now also denotes the persistent `Unrestricted` warning because it is a standing attention
state.

### Failure handling

- Probe timeout, malformed report, missing helper, unsupported kernel, or deprecated API is not a pass.
- A containment loss kills the owned process tree. Ambiguous external mutation becomes
  `UnknownOutcome`.
- macOS never treats `sandbox-exec` or Endpoint Security presence as unattended readiness.
- A locked or unavailable selected credential backend does not trigger another backend.
- An encrypted-file authentication failure changes no bytes and reveals no record count.
- Corrupt encrypted-file headers fail closed and preserve the original file for owner-directed
  recovery.
- Backend switching does not copy or delete credentials.
- A remote profile-escalation request is denied and audited.
- Downgrading from `Unrestricted` cancels unsandboxed actions before the API reports success.
- A stale, disabled, expired, or nonmatching allowlist entry never suppresses a prompt.
- Panic and Stop all remain available even when audit verification has failed.

### Critical test scenarios

### Pure contract tests

- every `SecurityProfile` and action-risk combination has an explicit admission result, verifies
  **AC-15**, **AC-19**, **AC-20**, **AC-22**;
- profile tightening is monotonic and remote escalation is impossible, verifies **AC-17**,
  **AC-18**, **AC-21**;
- matcher tables cover commands, web destinations, files, secrets, browser actions, and thread
  actions without substring matching; command rows match only the same OS and canonical absolute
  path, verifies **AC-23**, **AC-24**;
- exact entries do not match broader targets until the owner broadens them, verifies **AC-23**;
- expiry uses injected time, and daemon-lifetime entries match only the current daemon generation,
  verifies **AC-24**;
- unknown platform capabilities fail closed, including Linux kernels older than 6.4, verifies
  **AC-3**, **AC-4**, **AC-5**;
- secret-backend selection never falls through to another backend and never copies or deletes
  values on a switch, verifies **AC-8**, **AC-12**, **AC-13**;
- Argon2id and XChaCha20-Poly1305 fixtures reject wrong passphrases and modified headers,
  ciphertext, and tags, and a second write uses a different nonce, verifies **AC-10**, **AC-11**,
  **AC-14**. The encrypted-file parameter fixture is blocked until the measured Argon2id record
  exists in this document.

### Platform conformance

- Windows proves LPAC identity, denied default network, process-tree kill, ConPTY ownership, pipe
  ACLs, and parent-only credentials, verifies **AC-2** through **AC-6**, **AC-9**;
- Linux proves user, pid, mount, network, and IPC namespace isolation; seccomp denial; Landlock
  ABI 6 on kernel 6.4 or newer; cgroup ownership and kill; fresh devpts; POSIX PTY ownership; the
  Chrome profile absent from bubblewrap mounts; and `NeedsHuman` for each missing primitive,
  verifies **AC-2** through **AC-5**, **AC-6**, **AC-9**;
- macOS proves the adapter never reports unattended readiness and that the PTY port uses the POSIX
  calls, verifies **AC-2**, **AC-3**, **AC-9**;
- every platform proves Chrome profile and pipe ownership stay in the daemon parent, verifies
  **AC-6**.

### Integration and UI

- onboarding cannot finish without a credential backend and security profile, verifies **AC-8**,
  **AC-15**;
- `Allowlisted` exact matches suppress only the approval prompt, still require a covering grant,
  and retain containment, verifies **AC-22**, **AC-23**, **AC-24**, **AC-27**;
- `Unrestricted` executes without Maia prompts or sandbox admission while budget admission, the
  durable audit start, panic, Stop all, audit verification, log redaction, and `DesktopConfirm`
  administration still run, verifies **AC-17**, **AC-19**, **AC-20**;
- remote clients can tighten but not enable `Unrestricted`, and cannot switch the credential
  backend, verifies **AC-18**, **AC-28**;
- leaving `Unrestricted` cancels running unsandboxed work before success, verifies **AC-21**;
- profile banner, keyboard flow, screen-reader labels, and 1440, 900, and 390 pixel layouts pass
  in Vitest and Playwright, verifies **AC-25**, **AC-26**, **AC-29**;
- tray status meets the Tauri integration or manual contract in the UI section, verifies **AC-25**;
- service-worker tests prove `/api`, `/ws`, vault, secret, and audit content is never cached,
  verifies **AC-14**, **AC-20**.

## Build plan

Use a strangler migration. Existing pure `maia-core` contracts remain in place while adapters move
behind the new boundaries.

**Precondition (satisfied):** this document is Accepted, and `00`, `07`, `08`, `09`, `10`, `11`,
and `REVIEW.md` are amended in the same change.

1. Record that acceptance. It is not an implementation step, satisfies **AC-1**, **AC-2**,
   **AC-15**, **AC-19**, **AC-20**.
2. Add shared platform, credential-backend, security-profile, and allowlist contract tests red,
   satisfies **AC-2** through **AC-5**, **AC-8** through **AC-25**.
3. Replace the workspace graph with `maia-containment`, `maia-windows`, `maia-linux`, and
   `maia-macos`; keep adapter shells compile-only until their conformance test exists, satisfies
   **AC-1** through **AC-7**.
4. Implement the SQLite owner and schema with the approved `rusqlite` and static `sqlite-vec`
   boundary, satisfies **AC-1**, **AC-7**.
5. Implement credential backends and the security-profile reducer before any real tool spawn.
   Encrypted-file acceptance waits until this document records measured Argon2id parameters.
   Satisfies **AC-8** through **AC-25**.
6. Implement router and embedding adapters against fixtures, satisfies **AC-1**, **AC-6**.
7. Implement Windows and Linux containment one platform at a time. Keep macOS fail-closed,
   satisfies **AC-2** through **AC-6**.
8. Implement daemon routes and React settings surfaces against recorded DTO fixtures, satisfies
   **AC-15** through **AC-29**.
9. Wire Tauri lifecycle, signed packaging, and the full CI matrix, satisfies **AC-1**, **AC-4**,
   **AC-7**, **AC-25** through **AC-29**.
10. Remove old `maia-win32` references only after the Windows conformance suite passes through
    `maia-windows`, satisfies **AC-1** through **AC-7**.

## Migration plan

**Strategy:** strangler.

**Phases:**

1. Land shared contracts and compile-only platform adapters while `maia-win32` remains active.
2. Prove Windows behavior through `maia-windows`, then switch the composition root.
3. Add Linux readiness behind runtime probes and keep every failed probe in `NeedsHuman`.
4. Add macOS packaging with unattended tools permanently fail-closed.
5. Enable security profiles only after profile, allowlist, cancellation, audit, and UI integration
   tests pass.

**Rollback:** keep `maia-win32` and the old composition path until Windows conformance passes through
`maia-windows`. A rollback disables non-Windows unattended execution. It preserves a persisted
`Protected` or `Allowlisted` profile. It forces `Protected` only when the persisted profile is
`Unrestricted`. The app shows one notice of what changed. Rollback never widens execution.

**Risks:** crate-graph drift, false-positive Linux readiness, incomplete cancellation during
profile tightening, credential-file corruption, and release-signing failures.

No phase may widen execution merely to keep a platform build green.

## Consequences

### Positive

- Conversation, memory, vault, UI, and safe automation become portable.
- Security claims are explicit per platform instead of implied by a successful build.
- Owners can choose high autonomy without prompt fatigue, while safer profiles stay available.
- Allowlist decisions reuse capability grants and remain inspectable and revocable.
- Credential storage works without requiring one OS service.

### Negative

- macOS cannot run arbitrary unattended tools under the accepted security bar.
- Linux support depends on host kernel and distribution configuration, not only Maia's package.
- `Unrestricted` can expose the owner's files, credentials, accounts, network, and money to model
  mistakes or hostile content. The UI warning reduces surprise but cannot reduce that authority.
- Three platform adapters and signed release pipelines increase build and audit cost.
- Static `sqlite-vec` introduces one additional audited unsafe boundary.
- The encrypted-file backend creates password-loss risk and has no recovery bypass.

### Neutral

- Existing Windows path rules remain valid vault portability checks.
- The phone remains a remote window onto one desktop daemon.
- Nightly Rust is permitted only when a documented required capability cannot use stable Rust.

## Follow-up

- Create `AGENTS.md` entries for the installed implementation skills and keep low-confidence Tauri
  guidance subordinate to Tauri's primary documentation.
- Pin exact dependency versions and license exceptions only after `cargo deny` evaluates the
  resolved graph.
- Record measured Argon2id memory, iterations, and parallelism in this document before accepting
  the encrypted-file backend. Do not invent those parameters.
- Define signed update and rollback behavior for each release format. Linux release artifacts
  already use detached GPG signatures.
- Re-evaluate macOS unattended containment only when Apple provides a supported public mechanism
  that can pass the same conformance contract.

## References

### Project sources

- `00-goal.md`: one daemon, shared state, panic, and design gate.
- `07-computer.md`: tool routes, remote boundary, and current Windows execution assumptions.
- `08-rust.md`: honest leaves, adapter graph, unsafe boundary, Axum, Tauri, and Tokio.
- `09-frontend.md`: Mint Ledger layout, Settings, phone placement, and accessibility.
- `10-security.md`: fail-closed sink enforcement, containment, audit, and incident controls.
- `11-secrets.md`: typed references, non-entry invariant, lock lifecycle, and Vault/OpenBao.
- `REVIEW.md`: acceptance record for this document.

### Practices and standards

- capability-based authorization;
- deny-by-default OS containment;
- strangler migration;
- authenticated encryption with memory-hard password derivation;
- record-before-act audit;
- monotonic security tightening.

### Web-verified links

- Tauri 2.12 release: https://v2.tauri.app/blog/tauri-2.12/
- Tauri crate: https://crates.io/crates/tauri
- Windows AppContainer: https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- Windows Job Objects: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- Windows ConPTY: https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
- Linux Landlock userspace API: https://docs.kernel.org/userspace-api/landlock.html
- Apple sandbox guidance: https://developer.apple.com/forums/thread/661939
- Tauri macOS signing: https://v2.tauri.app/distribute/sign/macos/
- Chrome remote debugging changes: https://developer.chrome.com/blog/remote-debugging-port
- `windows` crate: https://crates.io/crates/windows
