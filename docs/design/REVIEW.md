# Design review record

## Status

**Gate: Proposed Accept — awaiting owner sign-off.**

The design set `00-goal.md` through `11-secrets.md` is the sole implementation source. Per-round
review reports are archived under [`archive/`](archive/) and are not binding on implementers.

| Reviewer | Round | Verdict |
| --- | --- | --- |
| Grok 4.7 medium | 1–4 | Accept with changes (r3, r4); earlier Rejects resolved |
| Claude Opus 5.5 | 1–2, 4 | Reject (r1–r2); Accept with changes (r4, parent agent) |
| Opus medium subagent | 3 | Not run (model unavailable) |

## Recorded decisions

- **Sandbox:** one AppContainer SID per thread; separate sidecar SID; whole vault, Maia data,
  Chrome profile, and Credential Manager denied. No fallback identity in v1.
- **Browser / web suite:** API (owner-requested api-anything capability) →
  Scrapy → Chrome. Chrome over a pipe only; no debugging port anywhere.
  Unattended login, captcha, and MFA when grants/secrets/solver allow;
  `NeedsHuman` only on failure. No auto-promotion of sites into API routes.
- **Remote identity:** paired `(user, node)`; tagged nodes denied.
- **Approvals:** every owner client (desktop, phone, web) approves at `Confirm`.
  `DesktopConfirm` is administration only (router, vault, listeners, Tailscale, pairing, policy,
  secret value entry/rotation, audit recovery). Residual: unlocked paired phone can approve until
  unpaired.
- **Android phone app:** installable PWA (manifest + service worker + in-UI Install button via
  `beforeinstallprompt`) on Android Chrome; content-free Web Push to that PWA/Chrome; daemon dials
  out; no Serve/Funnel; iOS and Play Store / native companion apps out of scope for v1.
- **Visual direction (owner, 2026-11-04):** **Mint Ledger** — tokens and type locked in
  `09-frontend.md`; source mockup `mockups/01-visual-directions.html`. Channel/`To`/dollar-budget
  prototypes in that mock are not product rules until separately accepted.
- **Unsafe:** only `maia-win32`.
- **Secrets:** only `Tools` and `Router` hold `SecretStore`.
- **Wire:** turn labels only in durable bytes; content fixed at append; trailing instructions
  `TrailingSystem` or `TrailingUserPart` per provider.
- **Untrusted envelopes:** durable Untrusted slots only (`03`); not recall; version frozen per slot.
- **Checkpoint:** `{ sequence, event_hash, policy_version, time }`.
- **Slot heat:** sum of accepted presentation weights on that slot in the thread.
- **Decay:** `f64` default `0.5`; age in seconds.
- **Recall taint default:** `IncludeUntrusted`; `TrustedOnly` per sensitive agent.

## Implementation

After owner sign-off, start with `vault-contract` (TDD). Follow `00`–`11` only. Do not re-open
archived review reports for new requirements; change the design docs and this record instead.

## Acceptance

- Result: **Proposed Accept.** Takes effect on owner sign-off.
- No crate, config, or UI implementation before that.
