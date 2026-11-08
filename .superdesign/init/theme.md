# Mint Ledger tokens

Loaded by `frontend/src/main.tsx` from `frontend/src/styles/mint-ledger.css`. `frontend/src/index.css` and `frontend/src/App.css` are unused Vite starter files and are not mounted.

## Color

| Token | Dark (`:root`, `[data-theme='dark']`) | Light (`[data-theme='light']`) |
| --- | --- | --- |
| `--bg` | `#0c0e10` | `#f3f4f1` |
| `--surface` | `#14171a` | `#fcfcfa` |
| `--border` | `#252a2e` | `#dadcd5` |
| `--text` | `#e4e8e6` | `#14181a` |
| `--muted` | `#8a9490` | `#5c6560` |
| `--accent` | `#3dddb0` | `#00775a` |
| `--warning` | `#f5a524` | `#b45f00` |
| `--danger` | `#f0584f` | `#c22f2f` |
| `--success` | `#a6d95b` | `#4d7a1a` |
| `--on-accent` | `#04140f` | `#ffffff` |

## Type, space, radius, layout

- Font: `400 14px/20px 'Segoe UI Variable Text', system-ui, sans-serif`
- Mono: `400 12px/16px 'Cascadia Mono', Consolas, monospace` (`.maia-mono`)
- Radius: 4px controls, 6px dialogs
- Focus: `2px solid var(--accent)`, offset 2px
- Rail width: `248px`. Inspector width: `336px`
- Breakpoints in CSS: 1099px (hide docked inspector), 727px (phone column, show `.maia-phone-stop`)
- Shell: CSS grid. Phone is one column, `minmax(0, 1fr)`, no horizontal page scroll
- Motion: disabled under `prefers-reduced-motion: reduce`

## Raw source

### `frontend/src/styles/mint-ledger.css`

```css
:root,
[data-theme='dark'] {
  color-scheme: dark;
  --bg: #0c0e10;
  --surface: #14171a;
  --border: #252a2e;
  --text: #e4e8e6;
  --muted: #8a9490;
  --accent: #3dddb0;
  --warning: #f5a524;
  --danger: #f0584f;
  --success: #a6d95b;
  --on-accent: #04140f;
  --rail-width: 248px;
  --inspector-width: 336px;
  --focus-ring: 2px solid var(--accent);
}

[data-theme='light'] {
  color-scheme: light;
  --bg: #f3f4f1;
  --surface: #fcfcfa;
  --border: #dadcd5;
  --text: #14181a;
  --muted: #5c6560;
  --accent: #00775a;
  --warning: #b45f00;
  --danger: #c22f2f;
  --success: #4d7a1a;
  --on-accent: #ffffff;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  font: 400 14px/20px 'Segoe UI Variable Text', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
}

button,
input,
select,
textarea {
  font: inherit;
}

:focus-visible {
  outline: var(--focus-ring);
  outline-offset: 2px;
}

.maia-shell {
  display: grid;
  grid-template-columns: var(--rail-width) minmax(480px, 1fr) var(--inspector-width);
  grid-template-rows: auto 1fr;
  height: 100%;
  min-height: 100%;
}

.maia-shell--tablet {
  grid-template-columns: var(--rail-width) minmax(480px, 1fr);
}

.maia-shell--phone {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto 1fr auto;
  width: 100%;
  max-width: 100%;
}

.maia-warning-banner {
  grid-column: 1 / -1;
  background: color-mix(in srgb, var(--warning) 18%, var(--surface));
  border-bottom: 1px solid var(--warning);
  color: var(--text);
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
}

.maia-warning-banner strong {
  color: var(--warning);
}

.maia-nav {
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.maia-nav-scroll {
  flex: 1;
  overflow: auto;
  padding: 12px;
}

.maia-nav-footer {
  border-top: 1px solid var(--border);
  padding: 12px;
  display: grid;
  gap: 8px;
}

.maia-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
}

.maia-main-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

.maia-inspector {
  background: var(--surface);
  border-left: 1px solid var(--border);
  min-height: 0;
  overflow: auto;
}

.maia-inspector-drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: min(480px, 100%);
  height: 100%;
  background: var(--surface);
  border-left: 1px solid var(--border);
  z-index: 30;
}

.maia-conversation {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.maia-transcript {
  flex: 1;
  overflow: auto;
  padding: 16px;
  padding-bottom: 8px;
}

.maia-composer {
  border-top: 1px solid var(--border);
  padding: 12px 16px;
  background: var(--surface);
}

.maia-composer textarea {
  width: 100%;
  min-height: 44px;
  max-height: 144px;
  resize: vertical;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px;
}

.maia-btn {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 4px;
  padding: 8px 12px;
  min-height: 40px;
  cursor: pointer;
}

.maia-btn--primary {
  background: var(--accent);
  color: var(--on-accent);
  border-color: transparent;
  font-weight: 550;
}

.maia-btn--danger {
  background: color-mix(in srgb, var(--danger) 20%, var(--surface));
  border-color: var(--danger);
  color: var(--text);
}

.maia-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.maia-card-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  min-width: 0;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

.maia-profile-card {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 4px;
  padding: 12px;
  text-align: left;
  min-width: 0;
  max-width: 100%;
  width: 100%;
  box-sizing: border-box;
  overflow-wrap: anywhere;
}

.maia-profile-card[aria-checked='true'] {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.maia-table {
  width: 100%;
  border-collapse: collapse;
}

.maia-table th,
.maia-table td {
  border-bottom: 1px solid var(--border);
  padding: 8px;
  text-align: left;
  vertical-align: top;
}

.maia-mono {
  font: 400 12px/16px 'Cascadia Mono', Consolas, monospace;
}

.maia-settings-section {
  display: grid;
  gap: 16px;
  max-width: 960px;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}

.maia-settings-fit {
  display: grid;
  gap: 16px;
  min-width: 0;
  width: 100%;
  max-width: 100%;
}

.maia-settings-scroll {
  min-width: 0;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
}

.maia-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 55%);
  display: grid;
  place-items: center;
  z-index: 50;
}

.maia-dialog {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  width: min(520px, calc(100% - 24px));
  max-height: calc(100% - 24px);
  overflow: auto;
}

.maia-phone-stop {
  display: none;
}

@media (max-width: 1099px) {
  .maia-shell:not(.maia-shell--phone) {
    grid-template-columns: var(--rail-width) minmax(480px, 1fr);
  }
  .maia-inspector {
    display: none;
  }
}

.maia-needs-human-banner {
  background: color-mix(in srgb, var(--warning) 16%, var(--surface));
  border-bottom: 1px solid var(--warning);
  padding: 8px 16px;
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.maia-inspector-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}

.maia-inspector-tabs [role='tab'][aria-selected='true'] {
  border-color: var(--accent);
  color: var(--accent);
}

.maia-inspector-tabs [role='tab'] {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  padding: 6px 10px;
  cursor: pointer;
}

@media (max-width: 727px) {
  .maia-shell,
  .maia-shell--phone {
    grid-template-columns: minmax(0, 1fr);
  }
  .maia-nav {
    display: none;
  }
  .maia-card-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .maia-table {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }
  .maia-phone-stop {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
  }
}

```

