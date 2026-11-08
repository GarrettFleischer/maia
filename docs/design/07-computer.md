# Computer use, router, and remote boundary

## TDD preamble

- **Kind:** new feature
- **Invariant:** Maia prefers a known local API operation, then Scrapy, then
  Chrome; automates login, captcha, and MFA when secrets and grants allow;
  and exposes desktop capabilities only to authenticated localhost or tailnet
  peers.
- **Red test(s):** router normalization fixtures; console framing and restart;
  API → Scrapy → Chrome selection; no fallback after ambiguous mutation;
  auth automation success and `NeedsHuman` on missing secret/grant/solver
  failure; persistent-profile ownership; Tailscale authorization, Origin, and
  CSRF rejection.
- **Then:** implement pure protocol parsers and route policy first, then the
  loopback-only process adapters, then authenticated daemon endpoints.

## Honesty preamble

- **Leaves (honest):** `normalize_router_response`, `select_execution_route`,
  `classify_api_outcome`, `classify_scrapy_outcome`, `classify_page_blocker`,
  `authorize_peer`, `validate_origin`, and `redact_tool_record`.
- **Skin (I/O):** the router HTTP client, the PTY owner (ConPTY on Windows; POSIX
  PTY on Linux and macOS), api-anything sidecar client, Scrapy sidecar client,
  Chrome controller, configured captcha/MFA solvers, Tailscale LocalAPI client,
  and foreground-window notifier.
- **Hooks (backward):** Axum HTTP/WebSocket handlers and tool dispatch parse,
  authorize, invoke one skin, and return typed results.
- **Mode args:** `OperationRisk`, `Idempotency`, `ExecutionRoute`,
  `HumanRequestKind`, `PeerKind`, and `RouterStreamMode` replace boolean flags.
- **Pause-and-review:** every new or materially changed function is checked for
  hidden clock, process, filesystem, network, window, profile, or global-client
  access.

## Purpose and authority

This document specifies the desktop execution boundary: OpenAI-compatible
router transport, platform console sessions, api-anything, Scrapy, persistent
Chrome, unattended auth challenges, Tailscale access, and the contracts
connecting them to the scheduler in `06-agents.md`. `13-platform.md` is
authoritative for which desktop operating systems can run unattended tools.

**Supersession (2026-11-05):** accepted [`14-super-agent-router.md`](14-super-agent-router.md)
withholds the execution `ToolRequest` set from `SessionRole::Router`, including under
`Unrestricted`. Parent and child roles may receive those tools when grants allow. In this
document, "router" means the model HTTP transport, not `RouterSession`.

All computer capabilities remain on the desktop daemon. That daemon runs on
Windows, Linux, or macOS. The phone can submit authenticated commands and
inspect results, but it receives no shell, browser, database, or vault process
of its own. A paired Android phone may receive content-free Web Push alerts so
the owner can open the same UI without polling.

## Boundary architecture

```text
Scheduler
  |-- Router adapter -------- HTTPS -------- configured OpenAI-compatible host
  |
  `-- Tool host
       |-- route policy (pure)
       |-- Console owner ---- PTY --------- per-thread shell (ConPTY or POSIX)
       |-- API client ------- loopback ----- api-anything sidecar
       |-- Scrapy client ---- loopback ----- Scrapy sidecar
       `-- Browser owner ---- pipe only      daemon-owned Chrome profile

Desktop/phone UI -- authenticated HTTP + WebSocket --> Axum daemon
Axum daemon ------ local LocalAPI WhoIs ------------> Tailscale daemon
```

Process ownership follows `13-platform.md`. Windows console sessions use
AppContainer, Job Objects, and ConPTY. Linux and macOS terminal sessions use a
POSIX PTY (`posix_openpt`, `grantpt`, `unlockpt`) through the selected platform
adapter. Linux unattended containment is bubblewrap, seccomp, Landlock, and
cgroup v2 when the capability report is ready, and requires Linux 6.4 or newer.
macOS does not report unattended readiness. The phone remains remote only.

The composition root creates one owner for each process-backed service. No
module-level client or lazy singleton is allowed. Tool requests are a closed
enum:

```rust
enum ToolRequest {
    VaultMap { path: Option<VaultPath> },
    VaultRead { path: VaultPath },
    Console(ConsoleRequest),
    Web(WebIntent),
    PostToThread { destination: ThreadId, body: String },
    OpenThread { participants: Vec<AgentId>, opener: String },
}

/// Discriminant used by grants (`10-security.md`). Schedules are human-only in v1.
enum ToolKind {
    VaultMap,
    VaultRead,
    ConsoleRun,
    Web,
    PostToThread,
    OpenThread,
}

enum ToolOutcome {
    VaultMap(VaultMap),
    VaultRead(NoteBody),
    Console(ConsoleResult),
    Api(ApiResult),
    Scrapy(ScrapyResult),
    Browser(BrowserResult),
    ThreadPosted { destination: ThreadId },
    ThreadOpened { thread_id: ThreadId },
    NeedsHuman(HumanRequest),
    RejectedBeforeStart { reason: GrantDenial },
}
```

The model requests an outcome through `WebIntent`; it does not choose API,
Scrapy, or browser. Route selection is deterministic policy. api-anything
operation contracts for a site exist only when the owner requests them in
Settings (or imports a signed pack). The model may suggest adding an API
route; it cannot register one. A generic `WebRead` over an allowlisted origin
set covers open-ended research when granted.

## Router protocol

### Configuration and capabilities

```rust
struct RouterConfig {
    base_url: Url,
    model: String,
    reasoning_effort: ReasoningEffort,
    request_timeout: Duration,
    stream_mode: RouterStreamMode,
}

enum ReasoningEffort {
    Low,
    Medium,
    High,
}

enum RouterStreamMode {
    Json,
    ServerSentEvents,
}
```

The base URL must be `https` unless its resolved destination is loopback.
Redirects are disabled. Authentication comes from an injected secret provider
and is never stored in the vault, thread log, audit payload, or UI response.

At startup, the adapter validates the configured model with a non-billable
capability description when the provider offers one. Otherwise capabilities
are established by configuration and the first response. Capability flags are
descriptive, not silent fallbacks:

```rust
enum TrailingInstructionPlacement {
    /// Recall, scratch, and speaker as `system` messages after the durable user message.
    TrailingSystem,
    /// Same texts concatenated into one trailing `user` message after the durable user message.
    TrailingUserPart,
}

struct RouterCapabilities {
    readable_reasoning: bool,
    tool_calls: bool,
    cached_token_usage: bool,
    request_idempotency: bool,
    trailing_instruction_placement: TrailingInstructionPlacement,
}
```

Maia may operate without readable reasoning or cached-token usage and records
their absence. It may not run an agent loop when tool calls are unsupported.

### Canonical request

```rust
struct RouterRequest {
    request_id: RequestId,
    model: String,
    /// Exact OpenAI-compatible `messages` array from `03-thread-cache.md` wire form.
    messages: Vec<ChatMessage>,
    /// Same canonical tools JSON already hashed into the durable prefix `## tools` section.
    tools_json: CanonicalJson,
    prefix_hash: Hash,
    recall_hash: Option<Hash>,
    reasoning_effort: ReasoningEffort,
    max_output_tokens: u32,
    prior_provider_tool_state: Option<OpaqueTurnState>,
}
```

The adapter POSTs these fields as the provider JSON body without reordering
messages, rewriting content parts, or re-encoding `tools_json`. Maia's internal
durable-prefix bytes exist only to compute `prefix_hash` and for inspection; they
are not a second wire encoding. `request_id` is the provider idempotency key when
supported. Opaque provider tool state may appear only on in-turn assistant
tool-call / tool-result messages; it is not persisted into the durable prefix.

Installed memory notes inside `## transcript` map to `assistant` messages with
content `` `mem:{id}`:\n{text} ``. In-turn tool rounds use `assistant` (tool_calls)
then `tool` role messages per the OpenAI schema.

The tool schema uses a stable name and canonical JSON Schema. Unknown tool
names, duplicate tool-call ids, malformed arguments, or non-exhaustive enum
values are protocol errors and are never executed.

### Normalized response

```rust
struct RouterResponse {
    request_id: RequestId,
    provider_response_id: Option<String>,
    reasoning: Option<String>,
    tool_calls: Vec<NormalizedToolCall>,
    reply: Option<String>,
    usage: RouterUsage,
    finish: FinishReason,
}

struct RouterUsage {
    input_tokens: UsageValue,
    output_tokens: UsageValue,
    cached_input_tokens: UsageValue,
}

enum UsageValue {
    Reported(u64),
    Estimated(u64),
    Unavailable,
}
```

The parser accepts only documented provider fields selected by the adapter.
It does not search arbitrary JSON for text that resembles reasoning or cached
usage. Reasoning text, tool calls, and final reply preserve provider order.
SSE chunks are assembled by index and tool-call id; a stream ending with
incomplete JSON is an error, not a partial executable call.

`cached_input_tokens` is recorded as `Unavailable` when omitted. It is never
derived by subtracting output tokens. Token budget handling follows
`06-agents.md`.

### Router failures

- HTTP `401` or `403`: configuration failure; stop the thread and surface a
  settings action. Do not retry.
- HTTP `429` or `5xx` before any body: sleep until a bounded, jittered retry
  time, respecting `Retry-After`.
- timeout or disconnect after bytes arrive: record an incomplete response and
  do not execute partial tool calls.
- malformed response: record a protocol error with redacted fixture bytes and
  sleep; never guess the intended call.
- request outcome unknown: do not automatically retry unless the provider
  confirms idempotency for the same `request_id`.

## Web intent and route policy

The model supplies a typed desired outcome:

```rust
struct WebIntent {
    id: ToolCallId,
    site: SiteId,
    operation: OperationName,
    arguments: JsonObject,
    expected: OutcomePredicate,
    risk: OperationRisk,
    idempotency: Idempotency,
}

enum OperationRisk {
    ReadOnly,
    ReversibleWrite,
    IrreversibleWrite,
}

enum Idempotency {
    NaturallyIdempotent,
    Keyed(IdempotencyKey),
    NonIdempotent,
}
```

Risk and idempotency are validated against the registered operation when an API
contract exists; the model cannot downgrade them. An operation contract declares
argument schema, redaction schema, preconditions, postcondition evidence, and
whether Scrapy or browser fallback is safe.

The web suite is a fixed ladder. api-anything is attempted first only when the
sidecar reports an exact capability match for
`site + operation + schema_version`. “Known site” alone is insufficient. The
owner adds that capability when they want a site API-routed; frequency of use
does not auto-register one.

```rust
fn select_execution_route(
    intent: &WebIntent,
    capability: Option<&ApiCapability>,
    prior: Option<&AttemptRecord>,
) -> RouteDecision;

enum RouteDecision {
    UseApi(ApiCapabilityId),
    UseScrapy,
    UseBrowser,
    NeedsHuman(HumanRequest),
    Fail(RouteFailure),
}
```

The initial decision is:

1. Exact API capability match: `UseApi`.
2. Else: `UseScrapy` for crawl/extract research when the intent is satisfiable
   without interactive page control.
3. Else: `UseBrowser` when a browser contract exists.
4. Neither Scrapy nor browser can serve the intent: `Fail(UnsupportedOperation)`.

After an API attempt, fallback down the ladder (Scrapy, then Chrome) is allowed
only for `NotStarted`, `Unsupported`, or `RejectedBeforeMutation`. A timeout,
disconnect, malformed response after dispatch, or missing postcondition is
`OutcomeUnknown`; it never falls back automatically because the API may have
already changed the remote system. Read-only operations may retry or fall back
when their contract declares that repeated reads are safe.

After a Scrapy attempt that cannot satisfy `expected`, policy may continue to
Chrome for the same intent when the scrape did not mutate remote state. Scrapy
is read-oriented: structured extract and crawl only. Writes use a known API
capability or Chrome.

For a write, successful transport is not success. The adapter must return the
contract's postcondition evidence. Missing or contradictory evidence is
`OutcomeUnknown` and becomes `NeedsHuman`.

## api-anything sidecar

The sidecar runs as a child process under a dedicated sandbox identity, not as
the interactive desktop user. On Windows that identity is an AppContainer
profile, separate from the owner's user. On Linux and macOS the sidecar follows
the containment contract in `13-platform.md`. It listens on an unpredictable
loopback port. The daemon passes a per-launch bearer token through an inherited
pipe, not command-line arguments or the filesystem.
Requests from non-loopback addresses are rejected.

Handshake:

```rust
struct SidecarHello {
    protocol_version: u32,
    instance_id: String,
    capabilities_hash: Hash,
}
```

The daemon requires an exact supported protocol version and fetches the
capability manifest by hash. Learned HTTP calls are local sidecar data. Their
cookies and credentials are never sent to the router.

Each execution includes `tool_call_id`, operation schema version, deadline,
idempotency key when available, and panic generation. Sidecar responses
classify whether dispatch occurred and provide redacted request metadata plus
postcondition evidence.

The sidecar is not an authority for scheduler state. A crash produces a typed
attempt outcome; only the scheduler appends state and audit events.

## Scrapy sidecar

Scrapy ([project](https://github.com/scrapy/scrapy),
[docs](https://docs.scrapy.org/en/latest/)) is the research and structured
extract leg of the web suite: crawl allowlisted origins, select page data, and
return size-bounded items. It sits between api-anything and Chrome in route
policy.

The Scrapy sidecar runs as a child process under its own sandbox identity
(separate from console threads and from api-anything). On Windows that identity
is its own AppContainer profile. On Linux and macOS it follows
`13-platform.md`. It listens on an unpredictable loopback port. Handshake,
bearer token, protocol version, and capability hash rules match the api-anything
sidecar. Non-loopback requests are
rejected. Cookies and credentials used by Scrapy stay in the sidecar; they are
never sent to the router.

```rust
struct ScrapyRequest {
    call_id: ToolCallId,
    intent: WebIntent,
    origin_allowlist: OriginSet,
    deadline: Duration,
    max_items: u32,
    max_bytes: u64,
}

struct ScrapyResult {
    call_id: ToolCallId,
    items: RedactedJson,
    pages_fetched: u32,
    truncated: bool,
    evidence: PostconditionEvidence,
}
```

Owner-authored spider contracts (or a generic extract over a granted origin set)
define selectors, item schema, redaction, rate limits, and robots/policy
settings. The model cannot install arbitrary spider code. Downloaded bodies and
items are redacted, size-bounded, and taint as Untrusted web content when they
enter thread context.

Scrapy does not drive the daemon-owned Chrome profile. JS-heavy or
challenge-gated pages that Scrapy cannot satisfy fall through to Chrome under
the same `WebIntent`. Auth walls encountered on the Chrome path use the
unattended auth rules below.

## Windows console sessions

This section is the Windows adapter contract. Linux and macOS console ownership
follows `13-platform.md`, including the POSIX PTY port. It does not replace this
section on Windows.

Each thread has one logical console session and at most one live ConPTY process.
The default shell executable is configuration validated at startup.

**OS isolation (v1 requirement).** Console sessions, the api-anything sidecar,
and the Scrapy sidecar do **not** run as the interactive Windows user. Each
thread's console runs as its own AppContainer profile (one SID per thread).
Each sidecar runs as a separate AppContainer profile of its own. No two threads
share a sandbox SID, so one thread's shell cannot read another thread's
workspace. ACLs deny every sandbox SID:

- Maia's data directory (SQLite brain, thread logs, audit chain, grants);
- the entire vault (sandboxes reach vault content only through `VaultMap` /
  `VaultRead` tools, never the filesystem);
- the daemon-owned Chrome profile;
- the interactive user's Credential Manager / DPAPI secrets.

Working directories and network egress are limited to what the covering
`CapabilityGrant` allows (`ConsoleExec.workspace` and `ConsoleNetwork`). Until
this isolation ships, unattended `ConsoleRun` is unavailable and every console
call becomes `NeedsHuman { kind: CapabilityApproval }` even if a grant exists.

Grant target for console is not a free string match. `ConsoleRequest` is
admitted only when the resolved executable path is on the grant's executable
allowlist, the working directory is under a granted root, and egress matches
`ConsoleNetwork`.

```rust
struct ConsoleSession {
    thread_id: ThreadId,
    shell: ShellIdentity,
    working_directory: WindowsPath,
    environment_profile: EnvironmentProfileId,
    sandbox_identity: SandboxIdentity,
    generation: u64,
}
```

The environment profile contains an allowlisted environment assembled by the
composition root. Secret environment values may reach the child only when the
tool contract explicitly grants them; they are redacted from transcript and
audit.

```rust
struct ConsoleRequest {
    call_id: ToolCallId,
    /// Display / audit form. Admission uses argv0 path + args digest against the grant.
    command_display: String,
    executable: WindowsPath,
    args: Vec<String>,
    working_directory: Option<WindowsPath>,
    timeout: Duration,
}

struct ConsoleResult {
    call_id: ToolCallId,
    generation: u64,
    exit_code: i32,
    stdout: RedactedBytes,
    stderr: RedactedBytes,
    resulting_directory: WindowsPath,
    truncated: bool,
}
```

Commands are framed with a daemon-generated nonce and shell-specific sentinel
that reports exit code and final directory. Output before the matching sentinel
belongs to that command. The transcript stores ordered stdout/stderr chunks,
timestamps, truncation metadata, and the redacted command. A byte and duration
ceiling prevents unbounded output.

Only one command runs per thread. A requested directory is canonicalized using
Windows path rules before launch. A nonexistent or unauthorized directory is
rejected before the command starts. The resulting directory is committed only
after a valid sentinel.

ConPTY handles cannot survive daemon restart. The durable session is logical:
restart creates a new process in the last committed working directory and
increments `generation`. Startup files and volatile shell variables are not
claimed to persist. A command interrupted by daemon loss is outcome unknown and
is never replayed automatically.

Panic first sends the configured graceful interrupt, waits a short configured
grace period, then terminates the process tree through a Windows Job Object.
The Job Object is configured to kill child processes when the console owner
dies.

## Persistent Chrome

Chrome is headful and uses one dedicated user-data directory owned by Maia.
It is not the person's normal Chrome profile. The directory persists across
daemon restarts so cookies and logins persist locally.

Only one daemon instance may own the profile. An exclusive profile lock is
acquired before Chrome launch; failure puts browser tools unavailable without
deleting or copying profile data. The profile directory is owned by the daemon
process identity. On Windows it is ACL-denied to the console and sidecar
sandbox identity. On Linux it is not bind-mounted into the bubblewrap sandbox
and is unreadable by the mapped sandbox UID (`13-platform.md`). It is
excluded from vault indexing, audit blobs, backups created by Maia, and router
payloads.

Chrome automation uses a private pipe only (`--remote-debugging-pipe`). There is
no debugging-port fallback: Chrome's port is unauthenticated, so any local
process that found it would control the browser and its cookies. If pipe
automation is unavailable, browser tools are unavailable. The browser owner maps tabs to
`ThreadId` and serializes actions within a tab. Multiple tabs may exist, but
focus changes are performed only for `NeedsHuman` or explicit user requests.

Browser contracts operate on semantic locators and expected outcomes:

```rust
struct BrowserAction {
    call_id: ToolCallId,
    tab_id: BrowserTabId,
    action: BrowserActionKind,
    expected: OutcomePredicate,
    deadline: Duration,
}
```

A completed action requires postcondition evidence such as URL, accessible
state, or site-specific confirmation. Screenshots and DOM extracts are
redacted, size-bounded, and included in router context only when required for
the active action. Password fields, cookie values, authorization headers,
downloaded files, and Chrome profile files never enter model context.

Downloads are disabled unless a future tool contract explicitly defines a
quarantine and approval flow. File uploads require an explicit typed contract;
the browser cannot browse arbitrary local paths.

## Login, captcha, MFA, and `NeedsHuman`

Chrome automates authentication when grants and secrets allow. Foreground
browser hand-off is recovery after automation fails, not the default for every
wall.

```rust
enum HumanRequestKind {
    Login,
    MultiFactorAuthentication,
    Captcha,
    BotCheck,
    ConsentWithLegalEffect,
    AmbiguousExternalOutcome,
    /// Secret store locked (Windows session or Vault/OpenBao token). Desktop only.
    CredentialUnlock,
    /// Capability grant confirmation. Any owner client may approve or deny.
    CapabilityApproval,
    /// Phone-initiated secret rotation from `11-secrets.md`. Completed on the desktop.
    RotationApproval,
}

struct HumanRequest {
    id: HumanRequestId,
    thread_id: ThreadId,
    kind: HumanRequestKind,
    summary: String,
    desktop_action: DesktopAction,
    safe_to_resume_when: ResumePredicate,
}

enum AuthAutomation {
    /// Username/password (or equivalent) from SecretStore for the granted site.
    FillCredentials { secret: SecretRef },
    /// TOTP or other store-backed second factor.
    ResolveMfa { secret: SecretRef },
    /// Configured captcha/bot-check solver path (injected at the composition root).
    SolveChallenge { solver: SolverId },
}
```

A challenge is detected from adapter status, accessibility text, known
challenge URLs, HTTP status, or a registered site contract. On detection the
browser owner attempts `AuthAutomation` in order:

1. **Login** — resolve granted site credentials from `SecretStore` and fill the
   form. Secret bytes never enter router context (`11-secrets.md`).
2. **MFA** — when a granted TOTP (or equivalent) secret exists, resolve and
   submit it. Push/SMS/email factors without a store-backed secret are not
   fabricated.
3. **Captcha / bot check** — invoke the owner-configured solver. Challenge
   payloads may go to that solver only; they are not pasted into the model
   prompt. Solver credentials are secrets.

Automation stops and returns `NeedsHuman` when:

- the secret store is locked (`CredentialUnlock`);
- no grant or secret covers the site or factor;
- the solver is unconfigured, unavailable, or fails;
- consent has legal effect (`ConsentWithLegalEffect`);
- the outcome after automation is ambiguous.

Fingerprint rotation, proxy rotation, and repeated refresh-as-evasion remain
out of scope. Unattended auth uses stored secrets and the configured solver
only.

Before `NeedsHuman`, the browser owner leaves the relevant tab open and records
a non-sensitive description. On the desktop it may request foreground
activation once as recovery. Windows may deny focus stealing; in that case Maia
flashes the taskbar and keeps the request active. The phone receives only:
“This step must be completed on the desktop,” the request kind, and stop/cancel
controls. It never receives a live credential or captcha interaction surface.

Resolution is explicit when the user presses Resume, or automatic only when the
registered `ResumePredicate` observes that the blocker disappeared without
performing a consequential action. Resolution appends an audit event and
creates a new scheduler lease. Cancelling the request moves the thread to
`Stopped`.

## Accepted route additions

`13-platform.md` is authoritative for these additions to the daemon surface.
Authorization below matches that document.

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

The encrypted-file passphrase has no HTTP route. A local Tauri command accepts
it. Remote attempts to enable `Unrestricted` or to switch the credential
backend return `403`.

## Localhost and Tailscale boundary

The daemon binds to:

- `127.0.0.1` and `::1`; and
- explicitly discovered local Tailscale addresses when remote access is
  enabled.

It never binds to wildcard, LAN, or public interfaces. If Tailscale is absent,
logged out, or has no assigned address, localhost remains available and remote
access reports unavailable. Address changes cause a controlled listener
rebind; existing localhost access remains.

Loopback may use HTTP. The Tailscale listener uses HTTPS with a valid
Tailscale-issued certificate for the configured MagicDNS name. If the
certificate or MagicDNS name is unavailable, remote UI is disabled rather than
serving cleartext HTTP. The certificate and key are held by the daemon boundary
and never exposed through settings responses or audit payloads.

### Peer authorization

**Loopback is not the human.** A TCP client on `127.0.0.1` proves only local
reachability. The desktop UI authenticates with a **per-launch desktop secret**
generated at process start and delivered only to the Tauri webview through IPC
(or an injected init script). That secret is never served from any HTTP
endpoint. A loopback client without it receives no session and no CSRF token.

Approving actions and issuing or approving capability grants are `Confirm`:
any authenticated owner client may do them, including a paired phone or the web
UI over the tailnet (`10-security.md`, Approval tiers). `Allowlisted` and
`Unrestricted` change only tool-execution prompts and controllable sink gates,
as `13-platform.md` specifies. Administration additionally requires a
desktop-only channel plus user presence (on Windows, Windows Hello or an OS
consent prompt):

- clearing the panic latch while under an incident;
- changing router URL or model;
- changing the Tailscale allowlist or pairing a device;
- putting or rotating a secret value;
- switching the credential backend;
- enabling `Unrestricted`.

`DesktopConfirm` administration is not bypassed by `Unrestricted`. Enabling
`Unrestricted` is local desktop only. Paired clients may switch to a safer
profile. Engaging panic remains available from every authenticated channel
(desktop secret or Tailscale session) without a presence prompt.

Tailscale requests are authorized by asking the local Tailscale LocalAPI
`WhoIs` endpoint for the socket peer address. The returned stable user identity
must match an allowlist in Maia settings. Reverse-proxy identity headers
supplied by the request are ignored. Proxied traffic that appears as loopback
(Serve/Funnel) is refused.

Every request validates `Host` against the exact listener names. Automation
Chrome and tool HTTP clients are configured with an explicit deny of Maia's own
listener addresses. The desktop Origin allowlist includes the Tauri webview
origin (`tauri://localhost` or the configured custom protocol), loopback UI
origins, and Tailscale HTTPS origins.

```rust
enum PeerKind {
    DesktopUi { launch_id: LaunchId },
    Tailnet { user: TailnetUserId, node: TailnetNodeId },
}

fn authorize_peer(
    peer: &PeerIdentity,
    desktop_secret: &DesktopLaunchSecret,
    paired: &BTreeSet<(TailnetUserId, TailnetNodeId)>,
) -> Result<PeerKind, AuthorizationError>;
```

The tailnet allowlist is a set of paired `(user, node)` devices. Pairing a device
is a desktop-only action with user presence. Tagged nodes are always denied.

Tailscale ACLs are a first boundary, not the application identity check. Maia
still verifies `WhoIs`. Failure or timeout is deny-by-default.

### Browser session and request protections

After peer authorization, Maia issues a short-lived, `HttpOnly`, `Secure` on
tailnet (and `Secure` optional on pure loopback HTTP), `SameSite=Strict` session
cookie bound to peer identity. Mutating HTTP requests require a session-bound
CSRF token. WebSocket upgrades require the same session and an exact allowed
`Origin`. The Origin allowlist is exactly: the Tauri webview origin
(`tauri://localhost` or the configured custom protocol), active loopback UI
origins, and Tailscale HTTPS listener origins. Arbitrary host headers do not
extend the list.

Panic uses these same checks. There is no unauthenticated “emergency” endpoint
because any tailnet peer able to reach it could otherwise stop all work.

The UI API never serves raw vault paths, Chrome profile paths, environment
values, router credentials, cookies, or unredacted console/browser payloads.
Phone and desktop receive the same authorized projections of daemon state.

### Android notifications (Web Push)

v1 supports **Android only** (Chrome or an installed PWA). There is no iOS
requirement and no native companion app. The phone UI is installable via the
Web App Manifest and Install control in `09-frontend.md`; Web Push prefers the
installed PWA when present.

```rust
enum PushCategory {
    NeedsHuman,
    PanicEngaged,
    SpendBreaker,
    ProposalPending,
}

struct PushSubscription {
    id: PushSubscriptionId,
    user: TailnetUserId,
    node: TailnetNodeId,
    endpoint: Url,           // push service URL from the browser
    client_public_key: Bytes,
    auth_secret: Bytes,      // held only in the secret store / encrypted at rest
    categories: BTreeSet<PushCategory>,
    created_at: Timestamp,
}

struct PushPayload {
    // Fixed strings only. No thread titles, commands, digests, paths, or secret labels.
    title: &'static str,     // always "Maia"
    body: &'static str,      // always "Needs your attention"
    // Opaque ids so a valid session can deep-link after open. Useless alone.
    thread_id: Option<ThreadId>,
    request_id: Option<RequestId>,
}
```

Rules:

1. **Opt-in per device.** After pairing, Settings on that phone offers "Notify me".
   The browser `PushManager.subscribe` runs only from a user gesture. The
   resulting subscription is POSTed over the authenticated Tailscale session and
   bound to `(user, node)`. Default categories: all of `PushCategory`.
2. **Daemon egress only.** `maia-daemon` sends Web Push (VAPID) to the
   subscription endpoint. Sandboxes never send push. The daemon's egress
   allowlist for this path is the push-service hosts required by the browser
   (for Chrome Android, FCM). No Tailscale Serve or Funnel is involved: the
   daemon dials out; the phone receives from the push service.
3. **Content-free.** Title and body are the fixed strings above. The payload
   carries only optional opaque `thread_id` / `request_id` for deep link after
   the session authenticates. No command text, approval digest, secret label,
   vault path, URL, or model text.
4. **Triggers.** The scheduler emits a push when a matching category event is
   committed: `NeedsHuman` opened, panic engaged (skip the device that engaged
   it), spend breaker tripped, dream proposal became `Pending`. Duplicate
   events for the same `(thread_id, request_id, category)` coalesce within a
   short window.
5. **Revocation.** Unpair, session-generation bump, or "Disable notifications"
   deletes the subscription and auth secret. A push HTTP 404/410 from the
   service deletes it. Lost-device steps include wiping push state.
6. **Failure.** Push failure is audited and never blocks the underlying state
   transition. There is no retry storm: at most a small bounded retry, then
   drop until the next distinct event.

Desktop Toast notifications for the same events are allowed and follow the same
content-free rule. They are out of band from Web Push.

## Tool result and audit contract

Every boundary attempt maps to:

```rust
enum AttemptOutcome<T> {
    Completed(T),
    RejectedBeforeStart(ToolFailure),
    FailedAfterStart(ToolFailure),
    CancelledBeforeStart,
    CancelledAfterStart,
    OutcomeUnknown(UnknownOutcome),
    NeedsHuman(HumanRequest),
}
```

The adapter states whether execution started. It never converts an unknown
outcome into failure. The scheduler uses this classification for budget,
fallback, retry, state, and immutable audit decisions.

Tool audit payloads contain operation names, schema versions, redacted argument
hashes, timing, route, start classification, outcome classification, and
postcondition evidence hashes. Console text, page content, screenshots, and
HTTP bodies are immutable blobs only when needed for inspection and after
contract-specific redaction.

## Invariants

1. The model expresses a web outcome; deterministic policy chooses API, Scrapy,
   or browser.
2. An exact api-anything capability is attempted before Scrapy; Scrapy before
   Chrome. API capabilities exist only when the owner requests them for a site.
3. Scrapy or browser fallback never follows a write whose external outcome is
   unknown.
4. Login, captcha, and MFA are automated when grants and secrets (and a
   configured solver for challenges) allow; otherwise they become `NeedsHuman`.
5. One thread owns at most one live console command and one ordered browser tab
   action at a time.
6. Chrome cookies and credentials stay in the dedicated local profile and are
   never sent to the router. Scrapy sidecar cookies stay in the sidecar.
7. Console process persistence is never claimed across daemon restart; only
   transcript and last committed working directory persist.
8. Router partial streams never produce executable tool calls.
9. Chrome exposes no debugging port, on loopback or anywhere else; it is driven
   only over the inherited pipe. Sidecars and LocalAPI clients are loopback-only.
10. Every UI request requires an application session. Loopback sessions require
    the per-launch desktop secret. Tailnet sessions require WhoIs allowlist match
    plus the application session.
11. No listener binds to wildcard, ordinary LAN, or public interfaces.
12. Every attempt reports whether it started and whether its outcome is known.

## Failure modes

- **Router capability mismatch:** disable agent loops for that configuration
  and surface the missing capability.
- **Router disconnect mid-stream:** discard partial executable content, retain
  redacted diagnostics, and follow idempotency policy.
- **API sidecar unavailable or version mismatch:** use Scrapy, then browser,
  only if no API attempt started and the next contract allows it.
- **Scrapy sidecar unavailable or version mismatch:** use browser only if no
  Scrapy attempt started mutating state and the browser contract allows it.
- **Sidecar timeout after dispatch:** mark outcome unknown; do not fall further
  down the ladder or retry a write.
- **Console sentinel missing:** terminate or recycle the generation, mark the
  command outcome unknown, and preserve bounded output.
- **Console child escapes:** Job Object setup failure prevents session launch.
- **Chrome profile locked:** browser route is unavailable; API and Scrapy routes
  may still run.
- **Chrome crash:** preserve the profile, mark active action outcome unknown,
  restart once under policy, and never replay a consequential action.
- **Profile corruption:** stop browser automation and require human repair;
  never delete the profile automatically.
- **Auth automation fails or challenge detection uncertain:** prefer
  `NeedsHuman` over unbounded retries; foreground hand-off is recovery.
- **Foreground activation denied:** flash the taskbar and retain `NeedsHuman`.
- **Tailscale unavailable:** close Tailscale listeners and keep loopback.
- **WhoIs failure or identity mismatch:** reject without creating a session.
- **Origin or CSRF mismatch:** reject and emit a security event without
  including the supplied token.
- **Panic during an operation:** cancel, classify actual outcome, and never
  claim reversal of an external side effect.

## Observability

Structured logs use ids and classifications, never secrets or full payloads.
Metrics:

- router latency, status, finish reason, token usage source, cached tokens, and
  protocol errors by configured model;
- API capability match rate, ladder success rate (API / Scrapy / Chrome),
  fallback reason, and unknown outcomes;
- api-anything and Scrapy sidecar health, protocol version, and postcondition
  failures;
- auth automation attempts by kind, solver success/failure, and fall-through to
  `NeedsHuman`;
- console startup, command latency, exit class, output truncation, generation,
  timeout, and forced process-tree termination;
- Chrome startup, profile-lock failures, action latency, crash count, and
  blocker classification;
- `NeedsHuman` count, age, kind, foreground outcome, and resolution path;
- listener addresses by class, WhoIs latency/failure, authorization denial,
  Origin rejection, CSRF rejection, and active sessions;
- cancellation outcomes grouped by router, console, API, and browser.

Traces link router requests and tool attempts to scheduler `lease_id` and audit
sequence. Browser screenshots, console output, URLs with query strings, HTTP
bodies, and headers are excluded from telemetry by default.

Health endpoints distinguish:

- daemon ready;
- router configured/capable;
- console available;
- api-anything sidecar available/version-compatible;
- Scrapy sidecar available/version-compatible;
- Chrome available/profile-owned;
- captcha solver configured/reachable when required;
- Tailscale local/remote availability.

Health is descriptive and does not expose credentials or remote account names.

## Required tests

### Router contract tests

- JSON and SSE fixtures with reasoning, ordered tool calls, reply, and all
  usage fields;
- absent reasoning and cached tokens remain explicitly unavailable;
- split tool arguments assemble by id and malformed/incomplete JSON never
  executes;
- redirects, insecure non-loopback base URLs, unknown tools, duplicate ids, and
  schema-invalid arguments are rejected;
- timeout, `429`, `5xx`, authentication failure, and unknown request outcome
  follow the specified retry policy.

### Route-policy tests

- exact capability chooses API; no capability chooses Scrapy before Chrome;
- model-supplied risk downgrade is rejected;
- unsupported/rejected-before-mutation API result allows Scrapy then browser;
- Scrapy miss on a read-oriented intent allows Chrome;
- ambiguous read follows its declared safe retry policy;
- ambiguous write enters `NeedsHuman` with no further ladder attempt;
- missing write postcondition is outcome unknown;
- panic generation mismatch rejects a late sidecar response;
- the model cannot register an api-anything operation.

### Windows console integration tests

- commands capture ordered output, exit code, and resulting directory;
- two commands on one thread serialize while different threads remain
  independently addressable;
- timeout kills the process tree and bounds output;
- invalid directory and unauthorized environment access fail before start;
- restart increments generation, restores the last directory, and does not
  claim shell-variable persistence;
- panic interrupts and then terminates a non-cooperative process tree;
- redaction removes declared secrets from transcript and audit blobs;
- from inside a console (and sidecar) session, reading the brain SQLite file,
  the Chrome cookie database, a canary Credential Manager entry, and writing
  a `personality.md` fixture each fail.

### Chrome, Scrapy, and auth tests

- profile data and login cookies persist across daemon-controlled restart;
- second daemon cannot acquire the profile;
- no Chrome debugging port listens on any interface, including loopback;
- granted credentials fill a login wall without `NeedsHuman`;
- granted TOTP completes MFA without `NeedsHuman`;
- configured solver completes a captcha fixture without `NeedsHuman`;
- missing secret, locked store, or solver failure produces the matching
  `NeedsHuman` kind;
- phone projection contains no challenge controls or sensitive page content;
- Scrapy returns bounded redacted items and does not touch the Chrome profile;
- browser fallback never occurs after an ambiguous API mutation;
- Chrome crash during a write records outcome unknown and does not replay.

### Network and security tests

- listeners bind only loopback and discovered Tailscale addresses;
- no Tailscale installation leaves localhost healthy;
- a loopback client without the per-launch desktop secret receives no session
  and no CSRF token;
- allowed WhoIs identity receives a session; mismatch, timeout, and spoofed
  headers are denied;
- mutating requests without a valid CSRF token are denied;
- WebSocket upgrades with invalid Origin (including missing Tauri origin) or
  peer-bound session are denied;
- Tailscale address change rebinds without opening wildcard/LAN listeners;
- desktop and phone panic requests pass through identical authorization and
  engage the durable panic latch;
- a push payload fixture contains only the fixed title/body and opaque ids — no
  command, digest, path, or secret label;
- unpair deletes the node's push subscription; a subsequent send is a no-op;
- push HTTP failure does not roll back the `NeedsHuman` transition that triggered it.

### End-to-end tests with fakes

- router emits a web intent, exact API capability succeeds, and Scrapy/Chrome
  are never launched;
- no API capability, Scrapy satisfies the intent, and Chrome is never launched;
- API rejects before mutation, Scrapy misses, browser completes with
  postcondition evidence, and attempts share one tool-call audit chain;
- browser encounters captcha, configured solver succeeds, thread stays
  `Running` without foreground hand-off;
- solver failure enters `NeedsHuman`, human resolves it, and a new lease
  resumes from committed state;
- daemon dies during console/API/Scrapy/browser work and restart never silently
  replays the operation.

## Resolved source ambiguities

- “OpenAI-compatible” does not standardize readable reasoning, cached-token
  fields, or opaque tool state. A provider adapter must normalize only
  documented fields and represent absent capabilities explicitly.
- “Console session per thread” cannot mean a live ConPTY survives daemon
  restart. The durable session is transcript plus committed directory; a new
  process receives a new generation.
- “API → Scrapy → Chrome” is unsafe after an ambiguous write. Fallback down the
  ladder is permitted only when the prior attempt provably did not mutate, or
  for a read whose contract explicitly allows repetition.
- api-anything routes are owner-requested per site. Heavy use may prompt a
  suggestion; it does not auto-install a capability.
- “Normal Chrome profile the daemon owns” means a dedicated persistent Maia
  profile, never the person's everyday Chrome profile.
- Binding a privileged UI to a Tailscale address is incomplete without
  application authorization and transport security. The design requires
  LocalAPI `WhoIs`, a user allowlist, peer-bound sessions, CSRF/Origin checks,
  and Tailscale-issued TLS.
- “Bring the desktop browser forward” is recovery after auth automation fails.
  Windows may deny focus stealing; taskbar notification preserves truthful
  behavior when focus activation fails.

## Explicitly out of scope

- fingerprint rotation, proxy rotation, or refresh-as-evasion beyond the
  configured captcha solver and stored credentials;
- remote browser or shell execution on the phone;
- arbitrary LAN or public-internet exposure;
- non-Tailscale remote-access providers;
- use of the person's existing Chrome profile;
- headless-only operation for flows that may require human intervention;
- arbitrary file downloads or uploads without a future typed quarantine
  contract;
- automatic retries of non-idempotent or outcome-unknown writes;
- parallel actions within a single console session or browser tab;
- preserving a live ConPTY process across daemon restart;
- provider-specific features not representable by the normalized router
  contract;
- a general browser-extension platform or arbitrary Scrapy/spider plugins
- an MCP passthrough. The only MCP call is the hash-pinned catalog in
  `docs/superpowers/specs/2026-11-06-mcp-catalog-design.md`
  installed by the model;
- automatic promotion of Scrapy/Chrome flows into api-anything capabilities.
