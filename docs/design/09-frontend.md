# Frontend design

## Purpose

Maia's interface makes three jobs possible without making them compete:

1. talk to an agent;
2. organize agents and threads;
3. inspect why memory affected a response.

The conversation remains the primary surface. Organization stays on the left.
Evidence stays on the right. Obsidian remains the editor for the vault, so Maia
does not duplicate a markdown editor.

## Information architecture

- **Agent rail:** agents, their threads, aggregate activity, global stop, vault,
  and settings.
- **Conversation:** participants, thread state, budget, transcript, tool
  summaries, and composer.
- **Inspector:** Cache, Brain, and Trace views bound to one selected fact and one
  selected turn.
- **Settings:** replaces the conversation pane; it is not a modal.

The same `FactId` drives selection in all inspector views. A click in any view
updates the other two without changing their tab until the user changes it.

## Desktop placement

At 1100 CSS pixels and wider, Maia uses three columns. The rails keep stable
widths and the conversation absorbs the remaining space.

```text
+--------------------+----------------------------------+------------------------+
| Maia               | Scout · with you          Run   | Cache  Brain  Trace    |
|                    | budget 12.4k / 30k               | turn 148 · 81% cached  |
| Agents             |                                  |                        |
|   Archivist        | You                              | constitution           |
| > Scout          ● | Can I open this from my phone?  | personas               |
|     with you       |                                  | compacted memory       |
|     with Scribe    | Scout                            | > mem_7f3a Tailscale   |
|   Scribe           | Yes. Same UI over Tailscale.    |   mem_12c0 desktop     |
|                    |                                  |                        |
|                    | Shell · 1 call                  |                        |
|                    | 2 facts installed               |                        |
|                    |                                  |                        |
| Activity           |                                  |                        |
| 2 running          |                                  |                        |
| 1 needs you        | +------------------------------+ |                        |
| [ Stop all ]       | | Message                 Send | |                        |
| Vault     Settings | +------------------------------+ |                        |
+--------------------+----------------------------------+------------------------+
```

Target widths:

- agent rail: 248 px;
- inspector: 336 px, resizable to 480 px;
- conversation: at least 480 px;
- composer: pinned to the conversation bottom, not the viewport bottom.

The agent rail and inspector have their own scroll containers. The transcript
keeps its reading position when either rail changes.

At 728-1099 px the agent rail (248) remains visible beside the minimum
conversation (480) and the inspector becomes a right-side drawer. Below 728 px
both auxiliary surfaces become overlays.

## Agent rail

Agents are ordered manually. A direct thread appears first under its agent.
Agent-to-agent threads appear under every participant but resolve to one
`ThreadId`.

A status dot means at least one child thread is `Running` or `NeedsHuman`.
Color is not the only signal: the thread row also exposes its state to assistive
technology, and the Activity block contains text counts.

The rail footer never scrolls out of reach. `Stop all` engages the durable panic
latch with immediate effect and no confirmation dialog: every `Running`,
`Sleeping`, and `NeedsHuman` thread becomes `Stopped`. Clearing the latch is a
separate control, available on any owner client except during an incident or audit failure, when it
is desktop-only. It does not resume anyone; each thread needs its own
Resume. Vault opens the configured folder in Obsidian. Settings replaces
the center pane.

## Conversation

The header shows participants, `ThreadRun`, and budget consumption. The budget
meter has a numeric text equivalent. `Run`, `Sleep`, or `Resume` occupies one
stable action position.

Transcript rules:

- speaker names precede every run of messages;
- tool calls are one collapsed line by default;
- reasoning is never expanded inline by default;
- a turn that confirmed facts shows a button such as `2 facts installed`;
- that button opens Cache and selects those facts;
- timestamps are available on focus or hover, not repeated on every line;
- message content is selectable text.

The composer grows to six lines, then scrolls. `Enter` sends and `Shift+Enter`
adds a line. While tools are running, the send action becomes a thread-local
stop action.

## Inspector

### Cache

Cache is the default tab. It lists slots in exact prefix order. Fixed sections
(tools, agents, personas) are visually separated from installed memory. The
turn's non-durable recall block appears below the durable slots, clearly marked
`recall · not durable`, with each item's id (`claim_…` or `fact_…`), sentence, and taint. Dream
proposals and quarantined episodes for this thread have entries that open their
detail sheets.

```text
Cache                         turn 148
24,880 / 30,720 tokens · 81% cached

01  tools                              fixed
02  agents                             fixed
03  Persona · Scout                    fixed
04  Compacted memory                   6 turns old
05  mem_7f3a · Tailscale   Trusted     full use
06  mem_12c0 · Desktop brain Trusted   half use
--  recall (turn-local) ---------------
r1  fact_9ab · Pipe-only Chrome  Untrusted

turn 1 ------------------------------------● 148
```

The turn scrubber starts at the latest snapshot. Changing it is read-only and
does not mutate the active thread. A selected slot shows source episode,
activation, last use, use source, taint, and the exact rendered bytes in a
disclosure. Request provenance for the selected turn is visible as Trusted or
Untrusted with contributing slot and recall ids.

### Brain

Brain is a graph lens, not a decorative network.

- fact radius follows activation;
- edge width follows association weight;
- lexemes, provisional claims, canonical facts, and episodes use distinct shapes and textual labels;
- a provisional claim that a canonical fact has consolidated is shown dimmed and labeled `consolidated`;
- nodes traversed by the selected turn receive the single accent color;
- cold nodes are lower contrast but remain keyboard reachable;
- Untrusted claims and facts carry a textual taint mark; CorrectionHold items are dimmed
  and labeled `hold`;
- quarantined episodes are listed under a `Quarantine` filter with release
  control for the owner;
- pending dream proposals appear as a list with Accept / Reject (`Confirm`);
- the default graph is filtered to nodes this thread touched;
- `Show shared brain` removes that filter.

Zooming and panning never change activation. Selecting a node selects the same
claim or fact in Cache and Trace.

### Trace

Trace is a vertically ordered record:

1. readable reasoning, or an explicit `No readable reasoning returned` row;
2. tool calls and results;
3. final reply.

Matched ranges are annotated with `full`, `half`, `rejected`, or `correction`.
Taint of the request and of each matched recall item is labeled in text.
The source label is text, not only color. Opaque reasoning signatures are never
rendered.

## NeedsHuman

The thread remains in place. A banner appears directly below the conversation
header. Copy is derived from `HumanRequestKind` (never a single hard-coded string):

| Kind | Desktop banner | Phone |
| --- | --- | --- |
| Login / MFA / Captcha / BotCheck | Shown only after auth automation fails; names the blocker and “on this computer”; [Bring browser forward] as recovery | “Finish this on the desktop.” |
| ConsentWithLegalEffect / AmbiguousExternalOutcome | Names the decision needed on this computer | Same phone line |
| CredentialUnlock | “Unlock the secret store on this computer.” | Same phone line |
| CapabilityApproval | Names the capability, target, and digest short form; [Approve] [Deny] | Same banner and the same full approval sheet; [Approve] [Deny] |
| RotationApproval | “Enter the new value for {label}.” [Rotate] | “Finish this on the desktop.” |

```text
+--------------------------------------------------------------------------+
| Needs you · Approve shell: pwsh -File build.ps1 (digest ab12…)            |
| Unattended grant does not cover this target.     [Deny] [Approve] [Stop] |
+--------------------------------------------------------------------------+
```

`Resume` stays visible for kinds the human can complete without a new message.
The composer stays disabled while `NeedsHuman` holds; cancel moves the thread to
`Stopped` (aligned with `07-computer.md`). `Stop thread` and global `Stop all`
remain available.

## Settings

Settings replaces the center pane and keeps the rail visible.

```text
Settings

Vault
Path          [ F:\Notes\Maia                              ] [Open]

Model router
Base URL      [ https://openrouter.ai/api/v1               ]
Model         [ provider/model                             v]
Reasoning     [ medium                                     v]

Default thread budgets
Tokens        [ configured value ]
Tool turns    [ configured value ]

Secrets
Backend       [ Windows Credential Vault (default)         ]
              [ Vault / OpenBao  [Configure]               ]
Labels and scopes are listed here. Values are write-only: create, rotate,
revoke, import. The UI never displays a resolved secret after save. Phone
clients may change scopes and revoke; entering or rotating a value stays on the
desktop.

Capability grants
Standing and session grants are listed with capability, presence rule, and
expiry. Any owner client, phone and web included, may create, widen, or revoke
a grant and approve or deny pending requests.

Devices
Paired (user, node) entries are listed with last-seen time. Unpair is available
on any owner client. Pairing a new device is desktop-only (`DesktopConfirm`)
and shows a short code the phone enters after WhoIs.

App (Android)
[ Install ]   Adds Maia to the home screen (Chrome PWA). Hidden when already
              installed; otherwise falls back to Chrome's Install / Add to
              Home screen menu.

Notifications (Android)
[ Enable notifications ]   Chrome or installed PWA only; iOS unsupported in v1
Categories  [x] Needs you  [x] Panic  [x] Spend breaker  [x] Dream proposal
Alerts are content-free ("Maia · Needs your attention"). Opening one lands on
the thread after the session authenticates. Disable clears this device's
subscription.

                                      [Discard] [Save settings]
```

Secret values are write-only through Settings and resolve only inside approved
tool adapters. Saving settings affects future requests; it cannot rewrite an
existing durable prefix.

## Phone placement

The phone is one column. The header remains visible, and the composer is pinned
to the viewport bottom. If any thread is running, global stop is one tap away.

```text
+--------------------------------+
| [Agents] Scout          [Inspect]|
| with you                    Run |
|--------------------------------|
| You                            |
| Can I open this from my phone? |
|                                |
| Scout                          |
| Yes. Same UI over Tailscale.   |
| 2 facts installed              |
|                                |
|--------------------------------|
| 2 running            [Stop all]|
| [Message...              Send] |
+--------------------------------+
```

`Agents` opens a left drawer containing the complete desktop rail. `Inspect`
opens a full-height bottom sheet with Cache, Brain, and Trace. The sheet opens
on Cache and preserves selection and turn when dismissed.

The phone and the web UI over the tailnet approve, deny, and grant with the same
controls as the desktop. In Settings on a remote client, the administration
fields (vault path, router base URL, model, and key, listener and Tailscale
settings, device pairing, and policy) are read-only and show "Change this on the
desktop."

On Android Chrome (or an installed PWA), Settings can enable Web Push as in
`07-computer.md`. A notification tap opens the phone UI on the deep-linked
thread when the session is still valid, otherwise on the login/pair gate. There
is no notification permission prompt on desktop web; the desktop uses OS toasts
from the Tauri shell instead.

### Android install (PWA)

The Tailscale HTTPS UI is an installable progressive web app on **Android Chrome**
so it can sit on the home screen like a native app. v1 does not require iOS or a
Play Store package.

Requirements served by the daemon on the tailnet origin only:

- a Web App Manifest (`name` / `short_name` Maia, `display: standalone`,
  `start_url` the phone UI root, icons at 192 and 512, theme colors);
- a service worker scoped to that origin (needed for installability and for
  Web Push from `07-computer.md`);
- `https` via the Tailscale-issued certificate already required for remote UI.

**Install control.** When Android Chrome fires `beforeinstallprompt`, the phone
UI shows an **Install** button (Settings and, once, a dismissible banner under
the header). Choosing it calls `prompt()` on that event. If the browser has no
deferred prompt (already installed, or criteria unmet), the button is hidden and
Settings shows either "Installed" or a short line: "In Chrome: Menu → Install
app / Add to Home screen."

When `display-mode: standalone` (or the related media query) is true, the app is
treated as installed: hide Install, prefer the standalone window for notification
deep links, and keep the same authenticated session rules as the browser tab.

The service worker caches only the static UI shell. It never caches vault bytes,
secrets, approval digests, or router credentials, and it cannot widen grants.
Unpair and session-generation bump still clear the session on next open.

### Agent drawer

```text
+-----------------------------+
| Agents                  [x] |
| Archivist                   |
| Scout                     ● |
|   with you                  |
|   with Scribe               |
| Scribe                      |
|                             |
| Activity                    |
| 2 running · 1 needs you     |
| [Stop all]                  |
| Vault              Settings |
+-----------------------------+
```

### Inspector sheet

```text
+-----------------------------+
| Cache   Brain   Trace   [x] |
| turn 148 · 81% cached       |
|                             |
| 01 tools              fixed |
| 02 agents             fixed |
| 03 Persona · Scout    fixed |
| 04 Compacted memory         |
| 05 mem_7f3a Tailscale       |
| -- recall (turn-local) ---- |
|                             |
| 1 --------------------- 148 |
+-----------------------------+
```

## Empty and error states

- No agents: name the vault path and explain that an agent is a folder with
  `personality.md`.
- Agent without threads: offer `New conversation`.
- Cache without installed memory: still show tools, agents, and personas; state
  that episode and claim recall are active.
- Brain without claims or facts: state that no episode has been promoted yet and
  episodes remain searchable. Once claims exist but no dream has consolidated
  them, state that claims are active and canonical facts appear after a dream.
- Router unavailable: keep the draft message, show the recoverable error next
  to the composer, and offer retry.
- Desktop daemon unavailable on phone: show connection status and the Tailscale
  address being attempted. Do not imply the brain moved to the phone.

## Visual system

**Locked direction: Mint Ledger** (direction 4 from
[`mockups/01-visual-directions.html`](mockups/01-visual-directions.html)).

Dark by default, with a full light theme. One mint accent for running state,
active selection, and primary actions. Orange is reserved for `NeedsHuman` and
its banner so an approval cannot be mistaken for an active agent. Success is a
yellow-green so it does not blur into mint. Borders separate regions; shadows
and gradients are unnecessary. System fonts only so Windows and the Android PWA
match.

### Tokens

| Token | Dark | Light |
| --- | --- | --- |
| `bg` | `#0C0E10` | `#F3F4F1` |
| `surface` | `#14171A` | `#FCFCFA` |
| `border` | `#252A2E` | `#DADCD5` |
| `text` | `#E4E8E6` | `#14181A` |
| `muted` | `#8A9490` | `#5C6560` |
| `accent` | `#3DDDB0` | `#00775A` |
| `warning` | `#F5A524` | `#B45F00` |
| `danger` | `#F0584F` | `#C22F2F` |
| `success` | `#A6D95B` | `#4D7A1A` |
| `on-accent` | `#04140F` | `#FFFFFF` |

### Type

| Role | Size / line | Face |
| --- | --- | --- |
| Title | 15 / 20 · 600 | Segoe UI Variable Text |
| Transcript | 15 / 24 · 400 | Segoe UI Variable Text |
| Speaker names | 13 / 16 · 600 | Segoe UI Variable Text |
| Rail and inspector rows | 13 / 18 · 400 | Segoe UI Variable Text |
| Body and controls | 14 / 20; buttons 550 | Segoe UI Variable Text |
| Data, ids, prompt bytes, tool output | 12 / 16, tabular | Cascadia Mono, then Consolas |
| Fallback | same sizes | system-ui; Roboto on Android |

### Layout and chrome patterns (from the Mint Ledger mock)

- base spacing unit: 4 px; control radius 2–6 px (dense, not pill-heavy);
- human messages sit right-aligned in a filled block; agent messages sit flush
  left under avatar + name;
- file chips are inline bordered pills in the transcript; attachment cards sit
  above the human message;
- Cache shows a large cached-% hero, a byte stack, ordered slots, then
  `recall · not durable`, then a turn scrubber;
- Brain marks Untrusted with a dashed ring and a `U` label; held facts are
  dimmed and labeled `held`;
- Trace steps carry textual match labels (`full` / `half` / `rejected`), not
  color alone;
- `Stop all` uses the danger token and stays pinned in the rail footer;
- minimum pointer target: 40 px desktop, 44 px phone;
- focus ring: 2 px accent, never removed;
- reduced-motion mode removes the running pulse and sheet animation.

### Alternatives considered

Directions 1–3 remain in the mockup for reference and are **not** product
defaults:

1. **Graphite Signal** — graphite + electric blue; calm workbench.
2. **Ink and Amber** — warm serif reading room; amber accent too close to the
   NeedsHuman vermilion.
3. **Night Mint** — near-black console; mint accent, but success sat near accent
   and the denser type alone was harder to read in the transcript.

Mint Ledger keeps Night Mint's dense inspector and Graphite Signal's readable
sans transcript, with orange reserved for warnings.

### Structural ideas shown in the mock (not yet locked)

The directions HTML also prototypes a multi-agent channel view (`#build-crew`),
a composer `To` recipient control, and dollar budget readouts beside token
budgets. Those are **not** accepted product rules until specified in `06` /
`09` after the remaining mockup tasks. Visual tokens above are locked regardless.

## Accessibility

- Landmarks are `nav`, `main`, and `aside`.
- Tabs follow the ARIA tab pattern.
- Drawers and sheets trap focus and restore it to the trigger.
- Graph nodes are mirrored by a keyboard-operable list.
- Live regions announce thread state changes, not token-by-token output.
- Text labels accompany every status color.
- Stop controls have distinct accessible names: `Stop this thread` and
  `Stop all running threads`.

## Responsive acceptance checks

- At 1440x900, all three panes are visible and the composer does not overlap the
  transcript.
- At 900x800, the inspector is a drawer and the conversation remains at least
  480 px wide.
- At 390x844, global stop remains visible while a thread runs.
- A NeedsHuman banner never hides a stop control.
- Selecting a claim or fact in any inspector tab preserves the same item id when moving
  between tabs and between desktop and phone layouts.

## Invariant

The transcript remains readable while the evidence for a response remains
reachable. Global stop is reachable in one action on desktop and phone.

## Out of scope

- A second full Markdown editor competing with Obsidian for day-to-day note authoring.
  Light vault edits from the file-preview overlay are specified in [`12-files-previews.md`](12-files-previews.md).
- Visual workflow builders.
- A public multi-tenant web service.
- Phone-local agents, tools, or brain storage.
- Rendering private chain-of-thought that the provider did not return.

## Mockups

| File | Status |
| --- | --- |
| [`mockups/01-visual-directions.html`](mockups/01-visual-directions.html) | Accepted: Mint Ledger locked |
| [`mockups/02-desktop-main.html`](mockups/02-desktop-main.html) | Draft for owner review: desktop main screen (dark/light, Running/NeedsHuman, chips, attachments, drop state, Cache/Brain/Trace) |
| [`mockups/03-file-preview.html`](mockups/03-file-preview.html) | Draft for owner review: file preview overlay (eight file types, edit and save rules, version history, quote, generated-region and personality.md approval states, dark/light) |
| [`mockups/04-phone-pwa.html`](mockups/04-phone-pwa.html) | Draft for owner review: Android phone PWA at 390 × 844 (thread, full-screen file preview, agent drawer, inspector sheet, install banner and NeedsHuman approval; dark/light; 44 px targets; Stop all reachable) |
| [`mockups/05-inspector-needshuman-settings.html`](mockups/05-inspector-needshuman-settings.html) | Draft for owner review: inspector Brain and Trace tabs over one desktop frame (graph, list, Trace, and detail share one selection; shared-scope toggle; quarantine; dream accept and reject), NeedsHuman cards for the five request kinds with the expanded CapabilityApproval sheet (invisible characters labelled), and the phone Settings remote view (read-only admin fields, revocable grants and devices, desktop-only pairing; dark/light; 44 px targets) |
| [`mockups/06-empty-error-states.html`](mockups/06-empty-error-states.html) | Draft for owner review: nine empty and error states (no agents, agent with no threads, Cache and Brain without facts, router unavailable with draft kept, phone cannot reach the desktop, preview failed, unsupported type, file too large; dark/light) |
| [`12-files-previews.md`](12-files-previews.md) | Draft for owner review: FILES & PREVIEWS spec (reference syntax, chips and attachments, per-type preview, edit and save rules, version history and diff, Quote in chat, shortcuts, accessibility, limits, testable rules, open decisions) |
