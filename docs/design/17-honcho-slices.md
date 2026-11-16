# Honcho slices 5–10 — Run 72 decisions

Source plan: `honcho-investigation.md` (slices 1–4 shipped earlier). Reconsidered after prompt-only memory (`remember` / `recall`), trailing skills catalog, and a byte-stable `manager_system_prefix`.

| Slice | Decision | One-line reason |
|-------|----------|-----------------|
| 5 Owner peer card | **drop** | Card was always `""` in production; stable owner facts belong in `remember`, not a per-turn always-on card. |
| 6 Scope / perspective | **drop** | Shared brain stays default; agent-scoped `remember` already covers facts without a private-chat composer control. |
| 7 Ask the brain | **drop** | Covered by `recall` / `remember` / `load_skill` tools — no separate cite/explain agent. |
| 8 Dream as cleanup | **drop** | No new Honcho dream runner; live-data dreams stay off; store consolidation left for later, unused by daemon. |
| 9 Brain page cleanup | **drop** | Skills tab shipped (Run 71); extraction banner already hidden when idle; no further Brain chrome this run. |
| 10 Retire unused fact tier | **already covered** | Daemon never starts `apply_consolidation`; prompt-only memory writes claims, not the old fact-outrank path. |

## Dead code removed with this reconsider

- Peer-card budget/constants (`CONTEXT_PACKET_CARD_CAP`) and card field on the context packet (slice 5 drop).
- Store `MessageBot` no longer invents `"maia"` for unbound rows (pairs with the cross-bot status-note fix).

Unused tables (`session_summaries`, legacy facts, promoter episode queue) are left in place — no destructive schema changes. PromotionRunner stays for quarantine drain only.

## Per-turn token notes (Run 72)

- `manager_system_prefix`: cached; unchanged by this cleanup.
- Trailing block: ranked recall + `also_happening` + `## skills` catalog (cap ~300 tokens / 1200 chars).
- Context packet budget remains 2000 tokens for conclusions + summary + recent turns (no card share).
