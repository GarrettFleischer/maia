# Design review record

## Status

**Gate: Accepted.**

The implementation source is `00-goal.md` through `11-secrets.md`, plus accepted
`13-platform.md` and accepted `14-super-agent-router.md`. `14-super-agent-router.md`
supersedes conflicting orchestration and UI portions of `00-goal.md`, `01-vault.md`,
`06-agents.md`, `07-computer.md`, and `09-frontend.md`. `12-files-previews.md` remains a draft and is not an
implementation source. Per-round review reports are archived under
[`archive/`](archive/) and are not binding on implementers.

| Reviewer | Round | Verdict |
| --- | --- | --- |
| Grok 4.7 medium | 1–4 | Accept with changes (r3, r4); earlier Rejects resolved |
| Claude Opus 5.5 | 1–2, 4 | Reject (r1–r2); Accept with changes (r4, parent agent) |
| Opus medium subagent | 3 | Not run (model unavailable) |
| Owner | 2026-11-05 | Accepted `13-platform.md` with the cross-check closures below. Ready to implement. |
| Owner | 2026-11-05 | Accepted `14-super-agent-router.md`. Waived further architecture review. Authorized autonomous implementation. |
| Owner | 2026-11-06 | Accepted the admitted MCP catalog. The router execution set stays empty. Subagents call hash-pinned tools. Spec: `docs/superpowers/specs/2026-11-06-mcp-catalog-design.md`. |

## Recorded decisions

- **Sandbox:** Windows column is one AppContainer SID per thread; separate sidecar SID; whole
  vault, Maia data, Chrome profile, and Credential Manager denied. No fallback identity in v1.
  Linux and macOS follow the containment matrix in accepted `13-platform.md`. Linux unattended
  readiness requires kernel 6.4 or newer and Landlock ABI 6; older kernels stay usable with
  `NeedsHuman`. macOS minimum is 13 and does not report unattended tool readiness.
- **Browser / web suite:** API (owner-requested api-anything capability) →
  Scrapy → Chrome. Chrome over a pipe only; no debugging port anywhere.
  Unattended login, captcha, and MFA when grants/secrets/solver allow;
  `NeedsHuman` only on failure. No auto-promotion of sites into API routes.
  On Linux the Chrome profile is excluded from bubblewrap mounts.
- **Remote identity:** paired `(user, node)`; tagged nodes denied. The phone remains a remote
  window only. The desktop daemon runs on Windows, Linux, or macOS.
- **Approvals:** every owner client (desktop, phone, web) approves at `Confirm`.
  `DesktopConfirm` is administration only (router, vault, listeners, Tailscale, pairing, policy,
  secret value entry/rotation, credential-backend switch, enabling `Unrestricted`, audit recovery).
  `Unrestricted` does not bypass `DesktopConfirm`. Residual: unlocked paired phone can approve
  until unpaired.
- **Security profiles:** `Protected`, `Allowlisted`, or `Unrestricted`, chosen explicitly.
  `Allowlisted` suppresses only the approval prompt and still requires a covering grant. A session
  allowlist entry lasts one daemon lifetime. `Unrestricted` is local-desktop only. It makes
  controllable `check_sink` gates auto-Allow and never skips budget admission, the durable audit
  start, panic, Stop all, audit verification, log redaction, or `DesktopConfirm`.
- **Android phone app:** installable PWA (manifest + service worker + in-UI Install button via
  `beforeinstallprompt`) on Android Chrome; content-free Web Push to that PWA/Chrome; daemon dials
  out; no Serve/Funnel; iOS and Play Store / native companion apps out of scope for v1.
- **Visual direction (owner, 2026-11-04):** **Mint Ledger** — tokens and type locked in
  `09-frontend.md`; source mockup `mockups/01-visual-directions.html`. Channel/`To`/dollar-budget
  prototypes in that mock are not product rules until separately accepted.
- **Unsafe:** audited FFI in `maia-windows`, `maia-linux`, and `maia-macos`, plus the one static
  `sqlite-vec` registration function in `maia-store`. Every other crate forbids unsafe code.
  `maia-win32` is replaced by `maia-windows`. The crate graph is the one in `08-rust.md` and
  `13-platform.md`.
- **Secrets:** onboarding chooses native OS storage, an encrypted file, or Vault/OpenBao. No hidden
  default. Native variants are Windows Credential Manager, macOS Keychain `{ account }`, and Linux
  Secret Service v2 `{ collection, label }`. Missing DBus or Secret Service is `Unavailable`.
  Switching backends does not copy or delete values. The encrypted-file passphrase is Tauri-only
  and never enters HTTP. Argon2id parameters are benchmark-gated before that backend is accepted.
  Only `Tools` and `Router` hold `SecretStore`.
- **Wire:** turn labels exist only in the hashed durable bytes; content is fixed at append;
  trailing instructions are `TrailingSystem` or `TrailingUserPart` per provider.
- **Untrusted wire:** Untrusted durable wire content includes the visible advisory envelope.
  Envelopes apply to durable Untrusted slots only (`03`), not recall, and the version is frozen
  per slot. No sink, grant, or credit decision reads the envelope.
- **Checkpoint:** `{ sequence, event_hash, policy_version, time }`. Canonical `AuditEvent` also
  carries `profile` and optional `allowlist_entry_id` inside the hashed event bytes.
- **Slot heat:** sum of accepted presentation weights on that slot in the thread.
- **Decay:** `f64` default `0.5`; age in seconds.
- **Recall taint default:** `IncludeUntrusted`; `TrustedOnly` per sensitive agent.
- **Linux release:** AppImage and Debian packages carry detached GPG signatures from the same
  release key used for policy bundles. Windows releases are Authenticode-signed. macOS releases
  are signed and notarized.
- **Super Agent (owner, 2026-11-05):** one tool-free `RouterSession` is the user-facing chat.
  `14-super-agent-router.md` wins over conflicting orchestration and UI text in `00`, `01`, `06`,
  `07`, and `09`. Composition-root routing policy is `min_confidence` 800, `min_margin` 150,
  `max_considered` 8, and child depth 3, passed into leaves as arguments. Model id is discovered
  from the OpenAI-compatible `/models` endpoint; it is not hard-coded. `BASE_URL` and `API_KEY`
  are read only in the daemon composition root and are never logged or sent to the frontend.
  Existing `threads` rows stay readable and are marked legacy. They are not deleted.

## Implementation

Implementation may start. `12-files-previews.md` stays draft. Follow `00`–`11`, accepted `13`, and
accepted `14`. Where `14` conflicts with `00`, `01`, `06`, `07`, or `09` on orchestration or UI,
follow `14`. Do not re-open archived review reports for new requirements; change the design docs and this
record instead.

Start order, from the build plan in `13-platform.md`. The documentation precondition is already
satisfied:

1. Red contract tests for the platform, credential-backend, security-profile, and allowlist contracts.
2. Workspace graph: `maia-containment`, and exactly one of `maia-windows`, `maia-linux`, or
   `maia-macos` per target, compile-only until each conformance test exists.
3. SQLite owner and schema, including the static `sqlite-vec` boundary.
4. Credential backends and the security-profile reducer before any real tool spawn. Encrypted-file
   acceptance waits for measured Argon2id parameters recorded in `13-platform.md`.
5. Router and embedding adapters against fixtures.
6. Windows and Linux containment, one platform at a time. macOS stays fail-closed for unattended tools.
7. Daemon routes and React settings surfaces against recorded DTO fixtures.
8. Tauri lifecycle, signed packaging, and the CI matrix.
9. Remove remaining `maia-win32` code references only after Windows conformance passes through
   `maia-windows`.

## Acceptance

- Result: **Accepted.** `13-platform.md` is Accepted. `14-super-agent-router.md` is Accepted.
  `12-files-previews.md` remains draft.
- Owner direction on 2026-11-05: stop architecture questioning and implement, using the cross-check's
  recommended defaults recorded above, then the Super Agent acceptance recorded above.
- Production code may begin with the start order in this record and with
  `docs/superpowers/plans/2026-11-05-super-agent-router.md`. This acceptance change itself
  edits design documents only.
