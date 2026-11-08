# Designer-loop invariants

## Tokens and jobs

- `--bg` is the application paper; `--surface` seats persistent chrome and controls.
- `--text` is primary ink. `--muted` is secondary readable ink, never ornament.
- `--accent` marks focus and the primary action; `--on-accent` is the only text color on it.
- `--danger` is reserved for emergency or destructive consequence. `--warning` names attention and pending risk. `--success` names completed or safe state.
- Borders may use `--border`; body, label, and button text must use text tokens, not ornament colors.

## Type and document structure

- Every rendered page surface has exactly one `h1`: conversation uses `Router`; Settings uses `Settings`; onboarding uses `Welcome to Maia`.
- Section headings descend from that page heading. Dialog titles use `h2` and label their dialog.
- Stored enums and machine values are converted to human labels beside their typed formatter; CSS never supplies words.
- Document and surface titles name the current job once and do not repeat the product name.

## Motion

- Transcript positioning is immediate layout work; it never uses smooth scrolling or an entrance animation.
- `prefers-reduced-motion: reduce` disables animations and transitions.
- Hover-only lift or motion, if added, is gated by `@media (hover: hover)` so touch cannot retain it.

## Modal and chrome seats

- The application root is the background seat. An active modal is portalled outside that root, makes every lower seat inert and semantically hidden, and traps focus.
- Only the top registry entry owns Escape, Tab, focus containment, and backdrop dismissal. One Escape closes one modal. Closing the top modal restores a connected trigger in the underlying modal; a disconnected, inert, or hidden trigger is never focused.
- Focusable controls are queried at interaction time so controls added or removed while open join the current trap. Eligibility requires resolved `tabIndex >= 0`, enabled state, rendered visibility, and no hidden, inert, `aria-hidden`, closed-details, or disabled-fieldset exclusion.
- Nested modals isolate lower modal seats without hiding their own portal. Replacement, unmount, and StrictMode cleanup restore each pre-existing `inert` and `aria-hidden` attribute exactly after the last owner releases it.
- Desktop keeps rail, conversation, and inspector chrome. Phone keeps header, conversation, and modal agent/inspector seats. Live mode never exposes fixture Settings.

## Transcript job and scroll invariant

- The transcript is one ordered list inside a non-live `log`. Every entry is one speaker-labelled article; history is navigable but never replayed as a live announcement.
- The dedicated announcer is permanently `aria-live="polite"`, atomic, and additions-only. It starts empty, emits each new router event once by sequence, and never toggles live state in the content commit. Initial history remains silent.
- Message bodies wrap unbroken ASCII and grapheme-safe tokens anywhere with a scoped word-break fallback; normal prose keeps its existing layout and the transcript never gains horizontal overflow at phone, tablet, or desktop widths.
- First successful hydration lands on the newest message without smooth motion. An append follows only when the transcript was already pinned to the bottom immediately before that append. Reading older history preserves the exact scroll position.
- A resize keeps a pinned transcript pinned and leaves an unpinned transcript unchanged. The composer remains outside the independent transcript scroll seat and reachable at every supported viewport.

## Action hierarchy

- `Send` is the primary conversation action.
- `Stop all` is a quiet scoped control labelled `Stop all running threads`.
- `Stop all running threads` is the only global stop. It stays quiet and is not danger-weight.

## Inspector tabs

- Cache, Brain, and Trace form one typed tab order.
- Exactly one selected tab has `tabIndex=0`; the others have `-1`.
- Left and Right move focus and selection with wrap. Home selects Cache; End selects Trace. Click follows the same selection contract.
- Each tab controls one panel whose `aria-labelledby` points back to that tab. Unavailable live inspector content renders explanatory text and no inactive tab interface.
