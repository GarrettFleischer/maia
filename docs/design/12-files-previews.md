# Files and previews

Status: draft for owner review. Not accepted. No production code until the design gate is accepted.

Visual reference: [`mockups/03-file-preview.html`](mockups/03-file-preview.html) (overlay, eight types, edit and save, history, quote) and [`mockups/02-desktop-main.html`](mockups/02-desktop-main.html) (chips and attachment cards in the transcript). Empty and error states: [`mockups/06-empty-error-states.html`](mockups/06-empty-error-states.html).

## Purpose

Let the owner and agents exchange files inside a thread. A file reference in an agent reply becomes a chip. A file opens in a full-window preview. The owner can read, search, edit (where allowed), compare versions, and quote a passage into the next message. Every file keeps its source identity and its taint.

## Invariants

1. A file is named by an opaque id, never by a raw path in the reply, the transcript, or the URL.
2. The daemon never parses an untrusted file. Rendering, text extraction, and thumbnails run in a sandbox and the UI shows only their derivatives.
3. Every file, quote, and chip carries its taint. Untrusted content never gains trust by being quoted, previewed, or edited.
4. A save never overwrites bytes silently. Each save, restore, and agent write creates a version.
5. Personality and generated vault content keep their existing rules (01, 05): dreams never write `personality.md`, and human regions survive byte for byte.

## Scope

In scope: file sources, reference syntax in replies, attachment cards and chips, per-type preview, edit and save rules, version history and diff, Quote in chat, keyboard shortcuts, accessibility, limits, and the error states.

Out of scope for v1: image cropping as a quote, Office editing, OCR, transcoding, live co-editing, browsing arbitrary local paths, agent-initiated downloads (07), and sharing a file with another person.

## Sources

| Source | Written by | Identity | Taint | Editable | Owner download |
| --- | --- | --- | --- | --- | --- |
| Upload | Owner, through the composer | `fil_<id>` in the thread workspace | Untrusted | Text types only, as a new version | Yes |
| Workspace file | Agent, in its thread | `fil_<id>` | Untrusted | Text types only, as a new version | Yes |
| Artifact (Markdown, HTML, chart, Mermaid) | Agent | `fil_<id>` | Untrusted | Source only | Yes |
| Browser capture (screenshot, snapshot) | Browser tool | `cap_<id>` | Untrusted | No, read-only evidence | Yes |
| Vault note | Owner, agent by proposal, dream by generated region | Frontmatter `id` (for example `entity_tailscale`) | Body Untrusted | Yes, through VaultStore | Yes |
| `personality.md` | Owner only | Frontmatter `id` | Trusted only at the owner-approved hash | Yes, with approval prompt | Yes |

Rules:

- **FP-SRC-01.** An upload's bytes move from the owner's client to the daemon, which writes them into the thread workspace. The daemon never opens a path that the client supplies. (10: a future upload contract reads from the sandboxed workspace.)
- **FP-SRC-02.** Rendering, text extraction, page images, and thumbnails for untrusted files run in a sandbox process. The UI consumes only those derivatives, stored in the workspace cache. A failed derivative shows the failed state, never a raw parse in the daemon.
- **FP-SRC-03.** A file's taint is set by its source, not by its name or extension. Vault note bodies are Untrusted. `personality.md` is Trusted only while its content hash matches an owner-approved hash.
- **FP-SRC-04.** "Download" is an owner export: the owner's client saves a copy of bytes the owner can already see. It is not an agent download. Agent-initiated downloads stay disabled (07).

## References in agent replies

An agent refers to a file with a Markdown link that uses the `maia-file:` scheme:

```text
[report.pdf](maia-file:ws/fil_01JABC?page=3)
[Tailscale notes](maia-file:vault/entity_tailscale?anchor=serve-on-7420)
[build-log.txt](maia-file:ws/fil_01JAB9?line=12-20)
```

- Source segment: `ws` (workspace, uploads, and artifacts), `cap` (browser capture), or `vault` (vault note, by frontmatter `id`).
- Id segment: the opaque id from the table above.
- Locator: at most one of `page=N` (PDF, paged captures), `line=A` or `line=A-B` (text and code), `row=N` (CSV), or `anchor=slug` (Markdown heading slug or block id). Format: lowercase letters, digits, and hyphens, 1 to 64 characters.

Rules:

- **FP-REF-01.** A reply may link a file only with the `maia-file:` scheme. Every other scheme (`file:`, `obsidian:`, `javascript:`, `data:`, UNC paths, and remote images) renders as plain text. Raw HTML is off in replies. (01, 10.)
- **FP-REF-02.** Resolution uses only the id segment, looked up in the current thread's file set (its workspace, its uploads, its captures, and its vault grants). The link text is display text and never selects a file.
- **FP-REF-03.** A missing file and a file this thread may not see produce the same chip copy: "Not available in this thread". The copy must not reveal whether the file exists.
- **FP-REF-04.** A locator that cannot be found (page past the end, unknown anchor, line beyond the file) keeps the chip and shows "Location not found. Opens at the top." The file still opens.
- **FP-REF-05.** The chip's name, type icon, and size come from the resolved file's metadata. If the link text differs from the file name, the chip shows the file name and keeps the link text in the accessible description.

## Components

### Chip (inline, in the transcript)

A bordered pill, 32 px tall on desktop and 44 px on phone. It shows the type icon, the file name (middle-truncated), and the locator when present (`p.3`, `L12-20`, `row 42`, `#serve-on-7420`).

States: default; focused (2 px accent ring); opened (the preview is open); not available ("Not available in this thread", dashed border, not clickable); location not found (see FP-REF-04); changed (the file has a newer version than the one the reply cited; the chip shows "Newer version", and the preview opens the cited version with a banner).

- **FP-CMP-01.** A chip's accessible name is "Open {name}, {type}, {locator if any}, {taint label}". Example: "Open report.pdf, PDF, page 3, untrusted".
- **FP-CMP-02.** A chip is a button when it resolves and is not a button when it does not. The "not available" state uses the same copy for missing and not granted files (FP-REF-03).

### Attachment card (above the owner's message)

Shows the file name, type icon, size, and status text: "Uploading 42%", "Ready", "Failed: connection lost", "Too large: limit 50 MB", "Unsupported type", or "Not sent: desktop unreachable".

- **FP-CMP-03.** A card has a Remove control only before the message is sent. After sending, the card stays with the message and cannot be removed.
- **FP-CMP-04.** Folders are rejected with "Drop files, not folders." Multiple files are accepted up to the per-message limit (LIM table).
- **FP-CMP-05.** Uploads are not queued offline. If the desktop is unreachable, the card shows "Not sent: desktop unreachable" with Retry, and the draft message is kept (FP-ERR-02).

## Preview by type

Preview opens as a full-window modal over the chat (FP-PRV-01). Type is decided by content, not extension (FP-PRV-02).

| Type | Preview | Find | Zoom and paging | Edit | Derivative |
| --- | --- | --- | --- | --- | --- |
| PDF | Page images and text layer | Yes | Zoom; paging | No | Page images, text (sandbox) |
| Image (PNG, JPEG, WebP, GIF first frame) | Fit and zoom | No | Zoom | No | Decoded preview (sandbox) |
| Vault note (Markdown) | Rendered Markdown, with source toggle | Yes | No | Yes (FP-EDT) | None; the UI renders the body with raw HTML, remote images, and non-`maia-file:` links off |
| Code and plain text | Monospace with line numbers | Yes | Zoom | Yes (FP-EDT) | None |
| CSV | Table with sortable columns | Yes | Zoom | Yes, as text | Parsed rows (sandbox) |
| HTML artifact | Sandboxed frame, no network | Source only | Zoom | Source only | None |
| Diagram (Mermaid) | Rendered diagram with source toggle | No | Zoom | Source only | Rendered SVG (sandbox) |
| Web capture | Image plus text snapshot | Yes (text) | Zoom | No, read-only evidence | Image and snapshot text |

Rules:

- **FP-PRV-01.** Preview is a full-window modal over the chat, never a side pane. Esc closes it (FP-KEY-02). Focus moves into it on open and returns to the trigger on close (FP-A11Y-02).
- **FP-PRV-02.** The type is detected from the leading bytes (magic numbers, then a text check). A file whose content type does not match its extension shows the mismatch and falls back to "Unsupported type". (10: typed by content.)
- **FP-PRV-03.** The UI shows only derivatives from the sandbox (FP-SRC-02). It never embeds the original file bytes as a live document, except a download.
- **FP-PRV-04.** An HTML artifact renders in an iframe with `sandbox="allow-scripts"` (no `allow-same-origin`, no forms, no popups, no top navigation), with a Content-Security-Policy of `default-src 'none'` plus inline styles and scripts only, and `connect-src 'none'`. It has no access to daemon storage or cookies, and no network.
- **FP-PRV-05.** Every previewable file offers Copy text (where text exists), Download, Open in app (desktop only, FP-PRV-06), History, and Quote in chat. Find, zoom, paging, edit, and the source toggle appear only where they apply. (Refines 03, which shows Open in app for every mock type.)
- **FP-PRV-06.** Open in app is desktop only. Vault notes open in Obsidian. The phone hides the control and does not show a disabled version. Open in app is never offered for executables or installers, because opening them runs them. Those files offer Download only.
- **FP-PRV-07.** A failed, unsupported, or too-large file always offers Download (owner export, FP-SRC-04) and Try again where a retry can help.

## Editing and save

Editable: vault notes, `personality.md`, code and plain text, CSV (as text), HTML artifact source, and diagram source. Not editable: PDF, image, and web captures (read-only evidence).

- **FP-EDT-01.** The editable set is exactly the list above. Other types never show an Edit control.
- **FP-EDT-02.** Save writes a new version and never edits a version in place. Vault notes are written through VaultStore with an atomic replace (01). Workspace files use the same version store. A save result is announced once (FP-A11Y-03).
- **FP-EDT-03.** Save sends the version hash the editor opened from. If the file's current version differs, the save is refused and nothing is written. The owner then chooses one of: Compare; Save as new version (both versions remain in history); Discard my changes. A stale save never overwrites an agent's or a dream's write.
- **FP-EDT-04.** Editing inside a generated region (`<!-- maia:generated:start -->` to `<!-- maia:generated:end -->`) shows the band "Generated region · regenerated on next dream". Saving asks first with that warning, and offers Keep my edit (saved, and recorded in history as "edited generated region") or Revert region to the last generated text. (05.)
- **FP-EDT-05.** Human regions (`<!-- maia:human:start -->` to `<!-- maia:human:end -->`) never trigger the generated-region warning. No save, revert, or dream changes their bytes (01, 05).
- **FP-EDT-06.** Saving `personality.md` creates a draft version and asks "Approve this version for new threads?" Approve records that content hash as owner-approved, and only new threads use it. "Not now" keeps the draft, and existing threads keep their bytes (03, 10). A save never approves by itself.
- **FP-EDT-07.** Dreams and agents never write `personality.md`. A write attempt is refused and recorded as a refusal, not applied.
- **FP-EDT-08.** Closing with unsaved changes asks: Keep editing, or Discard. Esc closes a clean preview at once and asks first when the editor is dirty (FP-KEY-02).
- **FP-EDT-09.** Editing is limited to the text limit in the limits table. Above it, Save is disabled with "Too large to edit here. Download the original."

## Version history and diff

- **FP-VER-01.** Each version records: version id, file id, content hash (sha256), author kind (owner, agent with id, dream, or system), time, reason (save, restore, agent write, dream write, or revert), byte size, and parent version id.
- **FP-VER-02.** Older versions open read-only. Restore writes a new version whose bytes equal the chosen version. It never rewinds history.
- **FP-VER-03.** Line diff is shown for text types only, with `+` and `−` glyphs and a text label on each line kind (FP-A11Y-04). Each side must be within the diff limit. Above it: "Too large to compare line by line. Open each version to compare."
- **FP-VER-04.** Binary types (PDF, image, web capture) compare metadata only: size, hash, author, and time.
- **FP-VER-05.** Version 1 keeps every version. Deleting or pruning history is out of scope and listed as an open decision (OD-5).
- **FP-VER-06.** Compare accepts two versions of the same file id. A cross-file compare is refused with "Compare works within one file."

## Quote in chat

Select text in a preview, then press Quote in chat or Ctrl+Shift+Q. The quote appears in the composer as a block quote, with the chip for its source.

- **FP-QTE-01.** A quote record stores: source file id, the cited version hash, the locator of the selection (page, line range, row, or anchor), the selected text, and the source taint. It never stores only the text.
- **FP-QTE-02.** A quote keeps its source taint. It reaches the thread as untrusted text unless the owner's message is marked trusted (03, 10). Quoting never raises taint.
- **FP-QTE-03.** A quote holds at most 4,000 characters. Longer selections are truncated and the composer shows "Quote truncated at 4,000 characters."
- **FP-QTE-04.** Version 1 quotes text selections only: PDF text layer, code and plain text, Markdown, CSV cells in one contiguous range, and web capture snapshot text. Visual regions (PDF or image areas) are not quotable.
- **FP-QTE-05.** A quote keeps pointing at the cited version hash after a newer version exists. The chip shows "Newer version" and the preview opens the cited version.

## Keyboard shortcuts

| Key | Action | Applies to |
| --- | --- | --- |
| Esc | Close preview (asks first if dirty) | Preview |
| Tab, Shift+Tab | Move focus; cycles inside the preview | Preview |
| Ctrl+F | Find in file | Where Find applies |
| Ctrl+E | Toggle edit | Editable files |
| Ctrl+S | Save as new version | Editing |
| Ctrl+Shift+Q | Quote the selection in chat | Text selection |
| Ctrl+Shift+H | Version history | Preview |
| Ctrl+Shift+S | Download (owner export) | Preview |
| Ctrl+Shift+O | Open in app | Preview, desktop only |
| PageUp, PageDown | Previous or next page | Paged files |
| Ctrl+=, Ctrl+-, Ctrl+0 | Zoom in, out, reset | Zoomable files |

- **FP-KEY-01.** Preview shortcuts are active only while the preview is open. The handler calls `preventDefault` only for keys it handles, so the browser keeps its own shortcuts elsewhere.
- **FP-KEY-02.** Esc closes a clean preview immediately. When the editor is dirty, Esc asks first (FP-EDT-08).
- **FP-KEY-03.** Each shortcut appears in its control's tooltip and in the preview's key list.
- **FP-KEY-04.** The phone has no keyboard shortcuts. Every action has a visible control of at least 44 px.

## Accessibility

- **FP-A11Y-01.** The preview is `role="dialog"` with `aria-modal="true"`, labelled by the file name.
- **FP-A11Y-02.** Focus moves into the preview on open and returns to the trigger on close, including after a discard prompt.
- **FP-A11Y-03.** Save, restore, conflict, and refusal results are announced once through a polite live region. Typing and scrolling are not announced.
- **FP-A11Y-04.** Taint, status, diff kind, and version labels use text and glyphs (`Untrusted`, `+`, `−`, `Newer version`), never color alone.
- **FP-A11Y-05.** Targets are at least 40 px on desktop and 44 px on phone.
- **FP-A11Y-06.** Focus rings are a 2 px accent outline and are never removed.
- **FP-A11Y-07.** Reduced-motion mode removes overlay and sheet transitions.
- **FP-A11Y-08.** Images carry alt text from file metadata, or "Image: {name}" when none exists. HTML artifacts carry a `title`. PDF pages state their page number in text.

## Limits

These values are **proposals for owner confirmation**. Each one is a test boundary: exactly at the limit is allowed, one byte over is refused.

| Item | Limit | Over the limit |
| --- | --- | --- |
| Upload, per file | 50 MB | Card shows "Too large: limit 50 MB"; not uploaded |
| Upload, per message | 10 files and 200 MB total | Extra files refused with the count |
| Thread workspace | 2 GB per thread | Upload refused: "Workspace full. Remove old files." |
| Preview, text, Markdown, code | 2 MB | First 2 MB shown with banner; Download original |
| Preview, CSV | 5 MB; first 10,000 rows | First 10,000 rows shown with banner |
| Preview, PDF | 25 MB; first 500 pages | Pages past 500 not rendered; banner |
| Preview, image | 20 MB; 50 megapixels | Not decoded; Download original |
| Preview, HTML artifact | 2 MB | Not rendered; Download original |
| Preview, diagram source | 512 KB | Not rendered; source shown as text |
| Preview, web capture image | 10 MB | Not rendered; snapshot text shown |
| Edit, text types | 2 MB | Save disabled (FP-EDT-09) |
| Diff, each side | 1 MB | Metadata compare only (FP-VER-03) |
| Quote | 4,000 characters | Truncated (FP-QTE-03) |
| Unsupported types | Executables and installers (`.exe`, `.msi`, `.dll`, `.bat`, `.cmd`, `.ps1`, `.scr`, `.com`, `.lnk`), archives (`.zip`, `.7z`, `.rar`, `.tar`, `.gz`), and unknown content | No preview; Download only (archives are never extracted by the daemon, 10) |
| File name | 255 characters | Middle-truncated in the UI; full name in the tooltip |

## Error and empty states

These match [`09-frontend.md`](09-frontend.md) (Empty and error states) and the mock `06`.

- **FP-ERR-01.** Router unavailable: the draft stays in the composer. The error sits next to the composer with the time and the base address. Retry resends the same draft. A failed retry keeps the draft too.
- **FP-ERR-02.** Desktop unreachable from the phone: the phone shows the last view it loaded, with its time, and the address it is trying. The composer keeps the draft. Uploads are not queued (FP-CMP-05). The copy never implies that agents, brain, or vault moved to the phone.
- **FP-ERR-03.** While the desktop is unreachable, the phone cannot send Stop all. It shows "Stop all can't reach the desktop. Stop it on the desktop." (OD-2.)
- **FP-ERR-04.** Preview failed (renderer or derivative failed): "Couldn't render {name}. The file itself is unchanged." Try again runs the sandboxed derivative once more. A second failure stays failed. Download is always offered (FP-PRV-07).
- **FP-ERR-05.** Unsupported type: "No preview for {name}. Maia doesn't render this type." Show the detected type. Offer Download and, on desktop, Open in app.
- **FP-ERR-06.** Too large: show the size and the limit, then the partial preview (where the limits table allows one) or Download only.

## Testable rules

Each rule ID above is a test target. Tests use independent oracles: fixture bytes and their hashes, file-system state after a refused save, the iframe's sandbox attribute string, and the exact stored version list. Boundary tests for the limits:

- FP-LIM: a text file of exactly 2 MB previews; 2 MB plus one byte shows the partial preview with the banner.
- FP-LIM: an upload of exactly 50 MB is accepted; 50 MB plus one byte is refused and writes nothing to the workspace.
- FP-LIM: a quote of exactly 4,000 characters is kept; 4,001 is truncated.
- FP-REF-02: a link whose text names `other.pdf` still resolves to the file id it carries.
- FP-REF-03: a missing file and a non-granted file render the same chip text.
- FP-SRC-01: an upload whose client path points outside the workspace is refused, and no daemon open occurs.
- FP-PRV-02: a PDF renamed to `.txt` shows "Unsupported type" with the detected PDF type.
- FP-PRV-04: the HTML artifact frame has exactly the sandbox flags and CSP named in the rule.
- FP-EDT-03: a save with a stale base hash changes no bytes on disk.
- FP-EDT-05: after Revert region, the human-region bytes are identical to before.
- FP-EDT-06: an unapproved `personality.md` save leaves the approved hash unchanged; approval changes only new-thread use.
- FP-VER-02: restore produces version n+1 whose hash equals version k's hash.
- FP-QTE-01: a quote still names the cited version hash after a newer version exists.

## Open decisions

- **OD-1. Owner download and 07.** FP-SRC-04 treats owner downloads as export. 07 disables downloads that agents drive. Confirm that owner export is allowed, and add one clarifying sentence to 07.
- **OD-2. Stop from the phone while the desktop is unreachable.** The 09 invariant says global stop is reachable in one action on desktop and phone. When the desktop is unreachable, the phone cannot reach it. Options: (a) state the gap and rely on the desktop's Stop all plus budgets and timeouts (recommended here); (b) add a second control path, which adds a network route and is not recommended.
- **OD-3. Upload contract.** 10 requires a future typed upload contract, and FP-SRC-01 and FP-SRC-02 depend on it. The contract is not yet written in 07 or 10 and must be added before implementation.
- **OD-4. Limits.** All values in the limits table are proposals.
- **OD-5. Version retention.** FP-VER-05 keeps every version. Pruning needs a decision.
- **OD-6. Ctrl+Shift+S.** It may collide with "Save page as" in some browsers. FP-KEY-01 limits the handler to the open preview. Confirm on the phone-browser and desktop-app shells.
- **OD-7. Trusted message.** FP-QTE-02 mirrors 03. The exact owner gesture for marking a message trusted belongs to 10.

## Mockups

| File | Status |
| --- | --- |
| [`mockups/03-file-preview.html`](mockups/03-file-preview.html) | Accepted reference for the overlay (eight types, save rules, history, quote) |
| [`mockups/06-empty-error-states.html`](mockups/06-empty-error-states.html) | Draft for owner review: empty and error states, including file error states |
