# Security: threat model and defensive architecture

## TDD preamble

- **Kind:** new feature
- **Invariant:** no side effect leaves Maia's trusted computing base unless a fail-closed
  capability grant covers it, a deterministic sink check has evaluated it under the request's
  provenance, a durable audit start event exists, and any approval its tier requires is bound to
  the exact canonical action; no known secret appears in any prompt, durable record, log, or UI
  projection.
- **Red test(s):** the `check_sink` decision table; taint-monotonicity and grant-attenuation
  property tests; the `classify_destination` address-representation table; the
  `neutralize_inline_markdown` property test; a known-secret canary scan across every egress and
  persistence sink; the adversarial-router injection suite; the `authorize_request` matrix (Host,
  Origin, CSRF, session class, `WhoIs`); policy-bundle signature and rollback tests; audit
  checkpoint truncation; the Windows containment conformance suite.
- **Then:** pure decision leaves first, then the secret, egress, containment, approval, and policy
  skins, then hooks. No tool reaches a real process, browser, or network before its conformance
  tests have been red and then green.

## Honesty preamble

- **Leaves (honest):** `request_provenance`, `check_sink`, `attenuate_grants`,
  `classify_destination`, `check_egress`, `neutralize_inline_markdown`, `sanitize_terminal_output`,
  `render_approval`, `find_known_secrets`, `authorize_request`, `admit_lease`,
  `classify_policy_change`, `verify_policy_bundle`, and `verify_checkpoint`. Policy, grants, time,
  fingerprints, and inputs arrive as parameters.
- **Skin (I/O):** the secret provider (Windows credential store), the containment launcher, the
  egress proxy, the browser navigation interceptor, the approval notifier, the OS user-verification
  prompt, the policy fetcher, the checkpoint signer, and the witness publisher. Each reads the clock
  once and passes `now` down.
- **Hooks (backward):** session bootstrap, pairing, approval, grant, endorsement, policy-update,
  update, and incident handlers. They authenticate, parse, call one leaf or skin, and translate the
  result.
- **Mode args:** `Taint`, `ApprovalTier`, `SinkDecision`, `ClientClass`, `RunPresence`,
  `UntrustedContextRule`, `DestinationClass`, `PolicyChange`, `ExecutionMode`, and
  `RecallTaintMode`. No boolean selects security behavior.
- **Pause-and-review:** after each new function, check that no policy, secret, clock, filesystem,
  network, or global state entered a leaf, and that every deny path is reachable by a test.

## Status and authority

This document is authoritative for Maia's threat model, trust boundaries, capability grants,
provenance and taint, sink checks, approval tiers, secret handling, process and browser
containment, egress policy, client authentication, audit integrity, incident response,
security-policy versioning, and the supply chain.

Other documents own their mechanisms. Where this document adds a requirement to another system,
the requirement appears in [Consistency findings](#consistency-findings) and must be resolved in
`REVIEW.md` before implementation begins. Until `REVIEW.md` records a decision, the more
restrictive reading of any security property applies.

## Security goal

Maia is a high-risk local agent. It runs unattended, reads attacker-controlled content, holds the
owner's logged-in browser sessions and router key, executes shell commands, remembers what it reads
in a shared brain, and is reachable from a phone. Neither a model nor a detector can reliably
prevent prompt injection. The security goal is therefore containment of consequences:

> Whatever text reaches a model, the worst outcome is bounded by grants the owner issued, checked
> by deterministic code at every sink, recorded before it happens, and repairable in memory.

Principles:

1. **The model is not a security boundary.** Once any untrusted byte is in a request, assume the
   whole response is attacker-controlled. Assume the router itself may be hostile.
2. **Enforce at sinks, not at sources.** Injection detectors and prompt envelopes are advisory.
   Decisions happen where an action leaves the model context.
3. **Fail closed.** Unknown, missing, unparseable, unverifiable, or unavailable means deny or
   narrow, never allow.
4. **Least privilege comes from the OS, not from string inspection.** A command denylist is not
   containment; a distinct security identity is.
5. **Provenance is sticky.** Taint joins upward through every derivation. Only a recorded owner
   action lowers it.
6. **The owner is the only source of authority.** Authority flows from owner actions, attenuates
   on every hop, and never amplifies.
7. **Secrets are handles.** Plaintext exists only inside the skin that uses it, only while using
   it.
8. **Record before acting.** Every attempt has a durable audit start event before it begins.
9. **Tighten automatically; loosen deliberately.** Automatic changes only narrow behavior.
   Widening needs an owner decision; widening administration (router, vault, listeners,
   pairing, policy) needs desktop presence.
10. **Security decisions are honest leaves.** Pure functions over explicit inputs, so the table of
    decisions can be tested exhaustively.

## Assets

- **Owner credentials:** the router API key; logged-in sessions and cookies in the Maia Chrome
  profile; credentials used by api-anything operations; the Tailscale node identity; Windows
  credential-store entries.
- **Owner accounts:** everything reachable through those sessions, such as mail, code hosting,
  finance, and cloud consoles. Integrity of actions matters as much as confidentiality.
- **Memory:** episodes, reasoning traces, provisional claims, canonical facts, presentations, and vectors in the brain. Poisoned
  memory is persistent compromise that crosses threads and agents.
- **Instruction integrity:** `personality.md`, `agents.md`, tool schemas, and the constitution at
  the front of every prefix.
- **Vault:** byte integrity of human regions ([01-vault.md](01-vault.md)) and safety when Obsidian
  renders what Maia wrote.
- **Thread logs and prefixes:** integrity and determinism ([03-thread-cache.md](03-thread-cache.md)).
- **Audit:** completeness and integrity ([06-agents.md](06-agents.md)).
- **Security state:** policy bundles, grants, allowlists, paired devices, approvals, learned
  operation approvals, and the compiled trust root.
- **The desktop:** owner files, processes, windows, clipboard, persistence locations, and the
  machine's position on the LAN and tailnet.
- **Spend:** router tokens and paid external actions.
- **Control:** availability of stop and panic.
- **Owner attention:** approval prompts are a finite resource; flooding them is an attack.

## Principals

- **Owner:** the human, authenticated through the desktop window or a paired phone. The only
  principal that issues grants, approves, endorses, pairs devices, and changes policy.
- **Daemon:** the Maia process under the owner's standard, non-elevated Windows account. Part of
  the trusted computing base. Holds secrets only inside skins.
- **Thread sandbox:** a per-thread contained OS identity that runs shell processes. Untrusted.
- **Sidecar:** the api-anything and Scrapy processes, each under its own contained identity.
  Semi-trusted code with untrusted output.
- **Chrome:** the browser process the daemon launches under the owner account with the Maia
  profile. Trusted to enforce web origin rules; page content is untrusted.
- **Router and model:** external. Output is untrusted and may be adversarial.
- **Content authors:** anyone who wrote bytes Maia reads, including other agents whose context
  was tainted.
- **Release authority:** the holder of release and policy signing keys.

The trusted computing base is the daemon binary and its dependencies, the security leaves in
`maia-core`, the compiled trust root, Windows, the Tailscale client, and the Chrome browser
process. Everything else is outside it.

## Trust boundaries

```text
                         Owner
          desktop window          paired phone (tailnet, HTTPS)
               | TB1                    | TB1
+--------------v------------------------v-------------------------------+
| Daemon (owner account, non-elevated)  -- trusted computing base       |
|   core leaves: provenance, sink checks, egress, approvals, policy     |
|   skins: secrets, audit, scheduler, egress proxy, containment launcher|
|     TB7 state directory (owner-only ACL): brain, audit, policy        |
|     TB6 vault  <-- Obsidian, sync, clippers, and plugins also write   |
|     TB8 Tailscale LocalAPI                                            |
+----+--------------+------------------+------------------+------------------+
     | TB2          | TB3              | TB4              | TB5              | TB5b
     v              v                  v                  v                  v
  Router      Thread sandbox      Chrome (pipe)     api-anything       Scrapy
  (internet)  per-thread identity  Maia profile     contained id       contained id
              no network default        |           per-request creds  allowlisted crawl
                     |                  |                  |                  |
                     +----------> one egress policy <------+------------------+
                                        |
                                   TB9 the web

TB10 model context: every prompt mixes provenance; every output is untrusted.
TB11 thread to thread: posts, opened threads, roots, and the shared brain carry provenance.
TB12 promotion and dream to brain and vault: no tools, schema-validated, taint-partitioned.
TB13 build and update to the installed binary and policy: signatures, not TLS.
```

## Adversaries

- **Content author (most likely):** controls a web page, email, document, repository file, API
  response, calendar entry, or vault note that arrives by sync or a web clipper. Goal: make an
  agent act or remember on the author's behalf. Capability: arbitrary bytes in tool output; no
  network path to Maia itself.
- **Hostile router or model:** a compromised provider, a malicious base URL, or a backdoored local
  model. Sees every prompt and returns arbitrary reasoning, tool calls, replies, and usage.
- **Hostile origin in the owner's normal browser:** targets the loopback or tailnet API through
  CSRF, DNS rebinding, WebSocket hijacking, framing, or port scanning.
- **Local unprivileged code:** another local user, a sandboxed app, or Maia's own thread sandboxes.
  Can reach loopback, squat pipes or ports, and plant files.
- **Tailnet peer:** another device or user on the tailnet, a shared or tagged node, or a Serve or
  Funnel misconfiguration that proxies the internet to loopback.
- **Device or session thief:** holds an unlocked paired phone or a copied session cookie.
- **Supply-chain attacker:** compromises a crate, an npm package, the api-anything release, the
  embedder weights, the toolchain, CI, or the update and policy channels.
- **Excessive agency:** no human attacker; a model that misreads intent and takes broad,
  irreversible, or costly actions. Treated as hostile for design purposes.
- **Future tactics:** techniques unknown today. Answered by versioned policy, retro-scan, and
  signed updates rather than by prediction.

The owner, a local administrator, SYSTEM or kernel code, and a physical attacker at the unlocked
desktop are not adversaries this design defends against (see
[Explicitly out of scope](#explicitly-out-of-scope)).

## Threat catalogue

Each threat lists the vector, the impact, the controls (defined under
[Defensive architecture](#defensive-architecture)), and the residual risk that remains.

### T1. Direct prompt injection

- **Vector:** instructions entered through an authenticated client by someone other than the owner,
  third-party text the owner pastes into the composer, or another agent's message in an
  agent-agent thread.
- **Impact:** any action within the thread's grants.
- **Controls:** client authentication and session binding; paste provenance, so pasted spans are
  `Untrusted` by default; agent messages carry the sender's request taint; agent-group grants are
  the intersection of participants' grants; instruction files are installed only at an approved
  hash.
- **Residual:** the owner deliberately asking for a harmful action within existing grants.

### T2. Indirect prompt injection

- **Vector:** instructions inside web pages, API responses, console output, files, vault notes,
  retrieved facts, text inside screenshots, or tool descriptions.
- **Impact:** hijacked tool calls, exfiltration, and memory writes.
- **Controls:** provenance on every slot; request taint is the join of included slots; sink checks
  gate every side effect under `Untrusted`; an advisory envelope marks untrusted slots; the
  adversarial-router suite assumes complete hijack.
- **Residual:** actions the owner pre-granted with `UntrustedContextRule::Allow`, and anything in
  the context reaching the router, which sees the prompt by design.

### T3. Tool-output injection

- **Vector:** tool results that forge conversation structure (fake assistant turns, fake tool
  calls, fake console sentinels, fake envelope terminators); terminal control sequences such as
  OSC 52 clipboard writes, OSC 8 hyperlinks, and title or cursor tricks; Unicode bidirectional or
  zero-width text that changes what a person sees in an approval.
- **Impact:** confused model, confused human, or a UI that executes what it should display.
- **Controls:** tool calls come only from provider structured fields
  ([07-computer.md](07-computer.md)); envelopes carry an id-bearing terminator and escape
  look-alikes; console framing uses a daemon nonce (07); `sanitize_terminal_output` runs before
  output enters a transcript, prompt, or UI; approval rendering makes invisible and bidirectional
  characters visible.
- **Residual:** semantic deception in plain text, which falls back to T2's controls.

### T4. Memory poisoning

- **Vector:** untrusted content becomes an episode, then a provisional claim (promotion), then a
  canonical fact (consolidation), then a slot or recall item in other threads and agents through the
  shared brain. A hijacked model fakes readable reasoning to credit slots
  ([04-credit.md](04-credit.md) limits credit to included slots). Promotion makes claims findable
  from every thread immediately, so the window before consolidation is cross-thread reach.
- **Impact:** persistent influence across threads and agents.
- **Controls:** claim and fact taint is derived deterministically from its inputs and travels into
  every request it joins; promotion sets claim taint from the single source episode; untrusted claims
  are labeled in recall and the inspector; `RecallTaintMode::TrustedOnly` for agents the owner marks
  sensitive; endorsement only by owner action; retro-taint during incident response; presentation
  reversal (06).
- **Residual:** ranking bias among untrusted claims and facts, and untrusted claims that are findable
  across threads before consolidation reviews them.

### T5. Dream and promotion poisoning

- **Vector:** a promotion or dream input carries injection that makes the model emit false claims
  or facts, claim a trusted episode as provenance (provenance forgery), close or merge true facts,
  create misleading entities, or plant Markdown that executes or beacons when Obsidian renders it.
- **Impact:** corrupted shared memory and a hostile vault.
- **Controls:** promotion and the dream have no tools ([05-dream.md](05-dream.md)); promotion sees one
  episode and cannot touch canonical state; dream output taint is the join of the whole batch
  context, not the model's `episode_ids`; batches are partitioned by taint; untrusted batches record
  proposals instead of closing or merging trusted facts; generated text is neutralized; the schema is
  validated (05).
- **Residual:** wrong but labeled-untrusted claims and facts until reviewed.

### T6. Malicious Markdown and Obsidian links

- **Vector:** wikilink or embed traversal; remote image embeds that beacon when rendered; raw HTML
  or iframes; `obsidian:` URIs that trigger plugin commands; `file:` or UNC links that leak NTLM
  hashes; Templater `<% %>` or Dataview JavaScript that executes inside Obsidian; `%%` comments that
  hide text; marker-like text that breaks region parsing.
- **Impact:** code execution in Obsidian, exfiltration on render, region corruption, or an agent
  following a link it should not.
- **Controls:** vault path confinement (01); `neutralize_inline_markdown` for every byte Maia
  generates; blocked schemes in the browser and UI; links in read notes are data and are not
  followed (01); UNC and device paths rejected everywhere.
- **Residual:** Obsidian plugins acting on human-authored notes, which is the owner's
  configuration.

### T7. Confused deputy and excessive agency

- **Vector:** an agent borrows the daemon's authority for a purpose the owner did not intend:
  driving Maia's own UI through the agent browser, asking the daemon to read a junction the agent
  planted, opening child threads with fresh budgets, posting into a thread with wider grants, or
  approving its own requests.
- **Impact:** privilege amplification through Maia itself.
- **Controls:** the model is never a principal; grants attenuate on every hop; Maia origins and
  loopback are blocked in Chrome; daemon-side opens in sandbox-writable paths refuse reparse
  points; approvals come only from owner sessions; child leases are funded from their root; no tool
  changes configuration.
- **Residual:** actions within granted authority.

### T8. Shell escape and host compromise

- **Vector:** arbitrary commands that read owner files, the brain, Chrome cookies, or secrets;
  persist through Run keys, the Startup folder, or scheduled tasks; inject input into owner
  windows; read the clipboard; reach loopback services; or request elevation.
- **Impact:** owner account compromise.
- **Controls:** a per-thread contained identity; Job Object limits; a separate desktop and UI
  limits; no network by default; an owner-only state directory; absolute executable paths; the
  containment conformance suite.
- **Residual:** Windows kernel or sandbox escape vulnerabilities.

### T9. Browser abuse

- **Vector:** navigation to loopback, the tailnet, the LAN, metadata endpoints, `file:`, or
  `chrome:`; CSRF against the owner's accounts through third-party cookies; credential autofill;
  downloads; permission prompts; DevTools takeover; WebRTC leaks.
- **Impact:** SSRF, account actions, credential theft, and browser control by local code.
- **Controls:** pipe-only automation; all browser traffic through the egress policy; navigation
  interception; third-party cookies blocked; password manager, sync, extensions, downloads, file
  chooser, external protocols, and permissions disabled; per-thread tab ownership; credentialed
  origin grants.
- **Residual:** Chrome exploits run as the owner; one cookie jar is shared between threads and is
  scoped by grants, not isolated.

### T10. Credential, cookie, and secret theft

- **Vector:** secrets in prompts, episodes, audit, logs, transcripts, environment blocks, or crash
  dumps; the cookie database read by a same-user process; the sidecar copying cookies; the model
  asking the owner to paste a secret.
- **Impact:** account takeover and router-key abuse.
- **Controls:** the no-secret-in-prompt rule; `SecretRef` handles; known-secret scanning at every
  sink; per-request cookie scoping; the profile is unreadable by sandboxes; the composer blocks
  known secrets.
- **Residual:** a hijacked sandbox that was granted a secret can transform it beyond registered
  encodings; owner-typed secrets that Maia does not know.

### T11. api-anything learned-operation poisoning

- **Vector:** a malicious page teaches an operation that targets another origin, adds a
  model-controlled host or header, misdeclares risk, or exfiltrates through parameters; an approved
  manifest changes afterward; a cookie is attached to the wrong origin.
- **Impact:** credentialed requests the owner never approved, aimed wherever the attacker likes.
- **Controls:** quarantine until owner promotion; origin pinning; typed templates with fixed
  scheme, host, port, method, and path prefix; default risk `IrreversibleWrite`; manifests pinned
  by hash; re-approval on change; credentials scoped to the pinned origin.
- **Residual:** a promoted operation the owner misunderstood.

### T12. CSRF, DNS rebinding, and cross-origin attacks on the Maia API

- **Vector:** a page in the owner's normal browser posts to `127.0.0.1:<port>`, rebinds a hostname
  to loopback, opens a WebSocket, frames the UI, or scans ports.
- **Impact:** commands, approvals, or panic clearing from a web page.
- **Controls:** every request needs a session; exact Host allowlist; exact Origin; `Sec-Fetch-Site`;
  JSON-only mutations; no CORS; `SameSite=Strict` cookies; session-bound CSRF tokens;
  `frame-ancestors 'none'`.
- **Residual:** none known on the request path.

### T13. Server-side request forgery

- **Vector:** the router base URL, a learned operation, the browser, or a sandbox aimed at loopback
  services, the tailnet, LAN devices, link-local metadata, or IP-literal tricks; DNS answers that
  change between check and connect; redirects.
- **Impact:** reaching services that trust the desktop's network position.
- **Controls:** one egress policy over resolved addresses; connections pinned to the checked
  address; every redirect hop rechecked; non-public classes denied by default.
- **Residual:** allowlisted destinations that are themselves hostile.

### T14. Tailscale and phone authentication

- **Vector:** another tailnet user or node, a tagged node, Serve or Funnel proxying to loopback, a
  spoofed identity header, a stolen phone, or a session cookie replayed from another device.
- **Impact:** remote control of the agent and approval of actions.
- **Controls:** `WhoIs` on every request; user and node pairing; tagged nodes denied; sessions bound
  to listener class and node; Serve and Funnel detection; HTTPS on the tailnet listener; no
  administration from remote clients; digest-bound single-use approvals; revocation.
- **Residual:** compromise of the Tailscale coordination service, or of the paired phone while it is
  unlocked. Because remote clients approve at `Confirm` (owner decision), a thief holding an
  unlocked paired phone can approve actions and issue grants until the device is unpaired or the
  session generation is bumped. They cannot pair devices, redirect the router or vault, or loosen
  policy.

### T15. Supply-chain backdoors

- **Vector:** a malicious crate, build script, or procedural macro; an npm install script; the
  toolchain; a CI runner; an api-anything release; embedder weights; the update or policy channel;
  a DLL planted beside an executable.
- **Impact:** code running inside the trusted computing base.
- **Controls:** lockfiles and `--locked` builds; `cargo-deny`; an audit record per new dependency;
  no install scripts; a pinned toolchain; hashed external artifacts; Authenticode and update
  signatures; anti-rollback; absolute paths; hardened DLL search; SBOM and provenance.
- **Residual:** a backdoor in an audited dependency of the daemon.

### T16. Router and model compromise

- **Vector:** the router logs prompts, returns hostile tool calls, fakes reasoning to steer credit,
  lies about usage, or redirects.
- **Impact:** every T2 outcome plus disclosure of everything sent to it.
- **Controls:** router output is untrusted; no secrets in prompts; router configuration changes
  require `DesktopConfirm`; no redirects (07); absent usage keeps the full reservation charged (06);
  credit is limited to included slots (04).
- **Residual:** confidentiality of everything sent to the router, by design.

### T17. Audit tampering

- **Vector:** deleting or rewriting events to hide actions; truncating the chain; recomputing an
  unkeyed hash chain; filling the disk so events cannot be written.
- **Impact:** undetectable misuse.
- **Controls:** sandboxes and the sidecar have no access to the audit store; the hash chain (06)
  plus signed checkpoints; witnesses on paired clients; fail closed when the audit cannot append.
- **Residual:** an attacker running as the owner who also controls every witness.

### T18. Plugin and MCP capability abuse

- **Vector:** tool-description poisoning, post-approval changes to a tool ("rug pull"), ambient
  secret access, access to other tools' outputs, server-initiated model calls.
- **Impact:** a third-party component acting outside the grant model.
- **Controls:** no plugin or MCP surface exists in this design (07, [08-rust.md](08-rust.md)). The
  gate for any future surface is [Plugins and MCP](#plugins-and-mcp).
- **Residual:** none until a surface is added.

### T19. Denial of service and cost abuse

- **Vector:** approval floods, thread fan-out, agent ping-pong, schedule spam, dream churn, output
  floods, huge files, regular-expression or parser bombs, a saturated database queue delaying
  panic.
- **Impact:** spend, exhaustion, and loss of the stop control.
- **Controls:** budget lineage; a global spend breaker; rate limits; size ceilings; linear-time
  parsing; a panic priority lane.
- **Residual:** router-provider outages.

### T20. Local privilege escalation

- **Vector:** a daemon running elevated; binary planting; pipe squatting; a writable install
  directory; a sandbox raising a consent prompt the owner clicks; memory-unsafe parsing of
  untrusted input in the daemon.
- **Impact:** administrator or owner compromise.
- **Controls:** refuse elevated start; absolute paths; first-instance pipes with explicit ACLs; an
  owner-only install directory; sandboxes cannot elevate; untrusted bytes are parsed only by safe
  Rust.
- **Residual:** operating-system vulnerabilities.

### T21. Exfiltration

- **Vector:** the router prompt, web requests (URLs, forms, API calls), sandbox network and DNS,
  Maia's UI rendering remote resources, Obsidian rendering generated content, cross-thread
  laundering, clipboard, screenshots, push notifications, logs, and crash reports.
- **Impact:** disclosure of memory, owner messages, files, or secrets.
- **Controls:** per channel in [Exfiltration channels](#exfiltration-channels).
- **Residual:** DNS through the system resolver from a network-granted sandbox; covert timing
  channels.

### T22. Untrusted files

- **Vector:** path traversal, junctions and symbolic links, UNC paths, alternate data streams,
  reserved device names, archives with path escapes or decompression bombs, polyglot files, missing
  Mark-of-the-Web.
- **Impact:** writes outside scope, credential leaks, resource exhaustion, and tools tricked into
  executing content.
- **Controls:** [Untrusted files](#untrusted-files).
- **Residual:** vulnerabilities in tools a sandbox runs on those files.

### T23. Approval spoofing and fatigue

- **Vector:** model-rendered text imitating an approval; approval text that differs from the
  executed action; long, homoglyph, or bidirectional-obfuscated commands; request floods meant to
  produce a reflexive click.
- **Impact:** the owner authorizing something other than what they believe.
- **Controls:** approvals render only from daemon canonical actions, outside the transcript; digest
  binding; visible confusables and invisible characters; rate limits; automatic stop after repeated
  denials.
- **Residual:** the owner approving an accurately displayed harmful action.

### T24. UI injection

- **Vector:** model output, tool output, filenames, page titles, or URLs rendered as HTML in the
  Maia UI, giving script an owner session that can approve actions.
- **Impact:** full owner authority from a string.
- **Controls:** text rendering by default; strict CSP; Trusted Types; no inline script; no remote
  resources; a minimal Tauri capability set.
- **Residual:** frontend framework vulnerabilities.

## Defensive architecture

### Side-effect pipeline

Every side effect flows through one ordered pipeline. Skipping a stage is a defect, not an
optimization. The pipeline is identical for attended and unattended runs; presence changes only
what an approval waits for.

```text
model tool call
  -> parse and validate (07)
  -> canonical action and digest
  -> request provenance from the persisted request record (03, 04)
  -> check_sink(grants, presence, policy)
  -> owner approval bound to the digest, when the decision requires one
  -> admit_lease: budget reservation with lineage (06)
  -> durable audit start event (06)
  -> contained execution under the egress policy
  -> outcome classification (07)
  -> sanitize, redact, scan for secrets, attach provenance
  -> append result and audit completion (06)
```

The closed `ToolRequest` enum (07, 08) is the only way a model reaches this pipeline. Every tool a
model can call, including vault `map` and `read`, opening a thread, and posting a message, is a
variant of that enum.

### Capability grants

Authority comes only from owner actions. A grant is a durable record. A model may request one; it
can never create, widen, or extend one.

```rust
struct CapabilityGrant {
    id: GrantId,
    holder: GrantHolder,
    capability: Capability,
    untrusted_context: UntrustedContextRule,
    presence: PresenceRule,
    issued_by: UserActionId,
    issued_with: ApprovalTier,
    policy_version: PolicyVersion,
    not_after: Option<Timestamp>,
    max_uses: Option<u32>,
}

enum GrantHolder {
    Agent(AgentId),
    Thread(ThreadId),
}

enum Capability {
    ConsoleExec {
        workspace: WorkspaceId,
        network: ConsoleNetwork,
        executables: ExecutableAllowlist,
    },
    FsRoot { root: GrantedRoot, mode: FsMode },
    WebRead { origins: OriginSet },
    WebWrite { origin: Origin, operation: OperationName },
    WebCredentialed { site: SiteId },
    ApiOperation { capability: ApiCapabilityId, manifest: Hash },
    VaultRead { scope: VaultScope },
    SecretUse { secret: SecretRef, sink: SecretSink },
    ContextEgress { kind: ContextEgressKind, origin: Origin },
    OpenThread { max_children: u32 },
    PostMessage { destination: ThreadId },
}

enum UntrustedContextRule {
    Allow,
    Require(ApprovalTier),
    Deny,
}

enum PresenceRule {
    AttendedOnly,
    AttendedOrUnattended,
}

enum ConsoleNetwork {
    None,
    Allowlist(DestinationSet),
}

enum FsMode {
    ReadOnly,
    ReadWrite,
}
```

Rules:

1. **Default deny.** A tool request without a covering, unexpired, unexhausted grant is
   `RejectedBeforeStart` (07) and audited. An unknown capability, an unparseable grant, or a policy
   that fails verification denies every tool; chat without tools continues.
2. **Owner-only issuance.** Grants are created by owner actions through authenticated hooks at the
   tier the policy assigns to that capability. No `ToolRequest` variant creates, widens, or extends
   a grant, changes policy or settings, pairs a device, or edits a schedule.
3. **Default standing grant.** Each agent starts with only `VaultRead` over the participant scope
   defined in [01-vault.md](01-vault.md) (shared entities plus participants' private entities).
   Everything else is explicitly issued.
4. **Effective grants.** For a direct thread: the thread's session grants plus the agent's standing
   grants, intersected with the policy ceiling. For an `AgentGroup` thread: the standing component
   is the intersection across all participants, so one participant cannot launder another's
   authority.
5. **Attenuation on every hop.** A tool-opened thread or posted message carries no authority the
   source lacks. Child grants are a subset of the parent's effective grants, child expiry is no
   later than the parent's, and child taint is at least the parent's.
6. **Presence.** Unattended runs use only grants with `PresenceRule::AttendedOrUnattended`.
7. **Expiry and revocation.** Session grants expire with the lease that requested them unless the
   owner chose a longer `not_after`. Revocation takes effect before the next sink check, and
   in-flight calls under a revoked grant are cancelled through the cancellation path in 06.
8. **Policy ceiling.** A policy tightening that excludes an existing grant revokes it. A loosening
   never widens an existing grant.

```rust
fn attenuate_grants(
    parent: &[CapabilityGrant],
    requested: &[CapabilityRequest],
    policy: &SecurityPolicy,
    now: Timestamp,
) -> Result<Vec<CapabilityGrant>, GrantError>;
```

### Provenance and taint

Every slot (03), episode segment ([02-brain.md](02-brain.md)), fact (02), thread message (06), tool
result (07), and workspace root carries provenance.

```rust
enum Taint {
    Trusted,
    Untrusted,
}

struct Provenance {
    taint: Taint,
    sources: BTreeSet<SourceRef>,
}

enum SourceRef {
    OwnerMessage(MessageId),
    Pasted(MessageId),
    InstructionFile { path: VaultPath, approved: Hash },
    MaiaCanonical(CanonicalTextId),
    VaultNote { path: VaultPath, content: Hash },
    WebOrigin(Origin),
    ApiOperation(ApiCapabilityId),
    Console { thread: ThreadId, call: ToolCallId },
    WorkspaceRoot(WorkspaceId),
    Thread { thread: ThreadId, request: RequestId },
    Fact(FactId),
    DreamBatch(DreamBatchId),
    Endorsement(UserActionId),
}
```

`Taint` is ordered `Trusted < Untrusted`, and combining provenance takes the maximum taint and the
union of sources. Two levels are deliberate: a sink decision needs one sound bit, and `sources`
carries the detail for inspection, incident scoping, and retro-scan. Adding a level is a policy
format change.

Labeling rules for policy version 1:

- Owner-typed composer text is `Trusted`. Pasted spans longer than the policy threshold are
  `Untrusted` unless the owner marks the message trusted when sending it.
- Maia canonical constants (tool schemas, the constitution) are `Trusted`.
- `personality.md` and `agents.md` are `Trusted` only at an owner-approved content hash. See
  [Vault and Markdown safety](#vault-and-markdown-safety).
- Vault note bodies and frontmatter are `Untrusted`, because Obsidian plugins, sync services, and
  web clippers write them too. The owner may designate trusted folders (`Confirm`). A
  generated region carries the join of the facts rendered in it.
- Web pages, DOM extracts, screenshots, and API responses are `Untrusted` unless the owner
  designates the origin trusted (`Confirm`).
- Console output carries the join of the request taint, the taint of every root readable by that
  sandbox, and `Untrusted` when network egress was enabled.
- A workspace root's taint rises to the join of itself and the request taint after any
  write-capable execution in it. It never falls except by an owner reset or endorsement. This
  closes taint laundering through shared files.
- A brain fact carries the taint of its dream batch context (see
  [Memory and dream integrity](#memory-and-dream-integrity)).
- Model output (reasoning, tool calls, reply) carries the request taint.
- A message posted to another thread carries the sending turn's request taint.
- A compacted memory block carries the join of its survivors.
- An owner endorsement is the only declassification. It applies to one fact, note hash, origin, or
  root, and is recorded in the audit.

```rust
fn request_provenance(
    included: &[SlotProvenance],
    scratch: &[SlotProvenance],
    recall: &[RecallItemProvenance],
) -> Provenance;
```

Request provenance is the join of included durable slots, the scratch suffix, and every recall
item on the request record (each recall item carries the `RankedPath` taint). Slot ordinals and
recall item ids are the same authority attribution uses (03, 04), so the sink check and the credit
ledger see the same request. One untrusted recalled fact makes the request `Untrusted` even when
every durable slot is `Trusted`. A thread returns to `Trusted` only when no untrusted slot remains
in its compiled prefix and the current request's recall set is empty or entirely `Trusted`.

Durable Untrusted slots carry the advisory envelope defined in
[03-thread-cache.md](03-thread-cache.md) (Untrusted-slot envelopes). Recall items do not. The
envelope helps the model and the human reader; no security decision relies on it.

### Sink checks

A sink is any operation that changes something outside the model context or sends data beyond the
daemon.

```rust
enum SinkKind {
    ConsoleExec,
    WebNavigate,
    WebRead,
    WebWrite { risk: OperationRisk },
    ApiCall { risk: OperationRisk },
    CredentialedAction,
    SecretUse,
    ContextEgress,
    OpenThread,
    PostMessage,
    VaultRead,
}

fn check_sink(
    action: &CanonicalAction,
    context: &Provenance,
    grants: &[CapabilityGrant],
    presence: RunPresence,
    policy: &SecurityPolicy,
    now: Timestamp,
) -> SinkDecision;

enum SinkDecision {
    Allow { grant: GrantId, rule: RuleId },
    RequireApproval { tier: ApprovalTier, rule: RuleId, reason: SinkReason },
    Deny { rule: RuleId, reason: SinkReason },
}

enum RunPresence {
    Attended,
    Unattended,
}
```

Sending the compiled prompt to the router is the product's function, not a sink. It is governed by
the [no-secret-in-prompt rule](#no-secret-in-prompt) and by router configuration.

Properties of `check_sink`:

- deterministic and total; every decision names the rule that produced it;
- monotone in taint: replacing `Trusted` with `Untrusted` never yields a more permissive decision;
- monotone in grants: removing a grant never yields a more permissive decision;
- monotone in policy: a tightening never yields a more permissive decision.

Default decision table for policy version 1. "Floor" marks rows compiled into the binary that no
grant, bundle, or setting can loosen.

| Sink and grant state | `Trusted` context | `Untrusted` context |
| --- | --- | --- |
| Console, granted workspace, no network | Allow | Allow; output taints roots |
| Console, network allowlist grant | Allow | Confirm (owner may lower with `DesktopConfirm`) |
| Console, no grant | Deny | Deny (floor) |
| Web read or navigate, granted origin | Allow | Allow |
| Web read or navigate, ungranted public origin | Confirm | Confirm |
| Any egress to a non-public class or blocked scheme | Deny | Deny (floor) |
| Reversible write, granted | Allow | Confirm |
| Irreversible write, granted | Confirm (owner may lower with `DesktopConfirm`) | Confirm (floor) |
| Any write, ungranted | Deny | Deny (floor) |
| Credentialed action, granted site | Allow | Confirm (floor) |
| Secret use, granted | Allow | Confirm (floor) |
| Context egress to the router, granted | Allow | Allow |
| Open thread or post message, within grant | Allow; taint propagates | Allow; taint propagates |
| Vault read outside participant scope, ungranted | Confirm | Confirm |
| Captcha, bot-check, or MFA via configured solver / granted secret | Allow | Confirm (floor) |
| Captcha, bot-check, or MFA without grant, secret, or configured solver | Deny | Deny (floor) |
| Policy, grant, settings, pairing, or audit change | Deny | Deny (floor; no such tool exists) |

In an unattended run, `RequireApproval` becomes `NeedsHuman` with an approval request and waits. It
never auto-approves and never times out into approval; an expired request is denied.

### Approval tiers

```rust
enum ApprovalTier {
    Auto,
    Confirm,
    DesktopConfirm,
}
```

- **`Auto`:** the grant is the approval. Recorded in the audit.
- **`Confirm`:** one owner decision from any authenticated owner client: the desktop window, a
  paired phone, or the web UI over the tailnet. Every approval of an action or grant uses this
  tier, including high-impact grants. This is an owner decision (2026-11-04): a client that holds a
  valid owner session has full approval authority. The mitigations are digest binding, single use,
  injective rendering, session lifetimes, the session-generation revoke, and unpairing.
- **`DesktopConfirm`:** administration only, never an action approval. It needs an owner decision
  from the desktop window plus OS user verification (Windows Hello, or the account credential
  through the Windows consent prompt). Remote clients cannot use it. If OS verification is
  unavailable, the action is unavailable; it never downgrades to `Confirm`.

Forbidden actions are `SinkDecision::Deny`, not a tier. No approval unlocks them.

```rust
struct ApprovalRequest {
    id: ApprovalId,
    thread_id: ThreadId,
    lease_id: LeaseId,
    request_id: RequestId,
    action_digest: Hash,
    tier: ApprovalTier,
    rule: RuleId,
    policy_version: PolicyVersion,
    provenance: Provenance,
    expires_at: Timestamp,
}

struct ApprovalDecision {
    approval: ApprovalId,
    outcome: ApprovalOutcome,
    client: ClientClass,
    user_action: UserActionId,
    presence_proof: PresenceProof,
}

enum ApprovalOutcome {
    Approved,
    Denied,
}

enum PresenceProof {
    SessionOnly,
    OsUserVerification,
}
```

Approval rules:

- **Binding.** An approval authorizes exactly one execution of the action whose canonical bytes hash
  to `action_digest`, in that thread, lease, and policy version. Any change to the action requests
  a new approval. Execution uses the stored canonical action, never a re-derived one.
- **Single use and expiry.** A used, expired, or foreign-thread approval is rejected.
- **Rendering.** `render_approval(&CanonicalAction) -> ApprovalView` is injective: distinct actions
  render distinctly. It shows the sink, the full destination with the host in ASCII or punycode,
  port, and path, the exact command with control, bidirectional, and zero-width characters made
  visible, secret references by name only, the risk, the rule that required approval, the
  provenance sources (for example "context includes content from web: example.com"), and the budget
  impact.
- **Placement.** Approvals appear only in daemon-owned UI: the `NeedsHuman` banner and an approval
  sheet. Model-rendered transcript content can never produce an approve control.
- **Fatigue.** Approval requests are rate-limited per thread. After the policy's number of denials
  in one lease, the thread moves to `Stopped` and a security event is raised. Bulk approval is not
  offered. "Always allow this" issues a narrow grant at the tier the policy assigns to that grant.

Owner actions and their tiers:

- **Session only, no confirmation** ([09-frontend.md](09-frontend.md)): stop a thread, engage panic.
- **`Confirm` (desktop, phone, or web):**
  - approve or deny any pending action;
  - issue or widen any grant, including `ConsoleExec` with network, `FsRoot`, `WebCredentialed`,
    `SecretUse`, `VaultRead` beyond the participant scope, and non-public egress;
  - endorse a fact; accept or reject a dream proposal;
  - promote a learned operation; approve instruction-file hashes and changed tool schemas;
  - designate trusted folders, origins, or roots; mark a pasted message trusted;
  - set an agent's recall mode; resume a thread that is not under an incident;
  - reset a tripped spend breaker;
  - revoke, narrow, or widen a secret scope;
  - make any change that only tightens: lower budgets, revoke a grant or secret scope, or unpair
    the current device.
- **`DesktopConfirm` (administration):**
  - change the router base URL, model, or key; change the vault path;
  - change the listener or Tailscale settings; pair a device;
  - add or rotate a secret value;
  - loosen policy, including lowering a decision-table row;
  - clear panic while under an incident; resume after an incident or audit failure;
  - apply a binary update.

### No secret in prompt

**Rule:** no byte sequence equal to a resolved secret value, or to a registered encoding of it,
appears in a compiled prefix, scratch suffix, router request, episode, fact, vault byte Maia
writes, audit event or blob, log line, metric, crash report, UI projection, or WebSocket frame.

Mechanics:

1. **Handles.** Settings, grants, tool schemas, and operation contracts name secrets by
   `SecretRef`. The skin that uses a secret (the router adapter, the console launcher's environment
   injection, the sidecar's credential attachment) resolves plaintext from the Windows credential
   store at use time and drops it after the call.
2. **Types.** The skin-side `Secret` type has no `Display` or `Serialize` implementation, and its
   `Debug` output is the reference name. No `maia-core` type can hold a `Secret`; ports carry
   `SecretRef`.
3. **Detection at sinks.** `find_known_secrets` runs over every router request, persisted episode
   and tool result, audit blob, and UI projection. It uses a `SecretIndex` of keyed fingerprints of
   each secret and each registered encoding (raw, base64, base64url, percent-encoding, hexadecimal,
   and JSON string escaping), not plaintext. Matching runs on assembled output so a secret split
   across stream chunks still matches. A hit in a router request or UI projection blocks the
   operation and raises `SecretEgressBlocked`. A hit in tool output is replaced by
   `[redacted:<secret-ref>]` before the output enters any prompt or durable record.
4. **Unknown secrets.** Pattern detectors (key formats, private-key headers, bearer tokens,
   high-entropy strings near credential keywords) redact tool output before it enters prompts.
   They are versioned in the policy bundle and are advisory; misses are expected.
5. **Composer.** A known secret in an owner message blocks sending with an explanation. A pattern
   hit warns and lets the owner proceed, because it is the owner's data.
6. **Environment references.** The environment-variable secret references in 09 are bootstrap-only:
   read once at startup, imported into the credential store, and never inherited by children (07's
   allowlisted environment). Release builds use the credential store only.
7. **Crash dumps.** Disabled or scrubbed, and never uploaded.

Residual: a sandbox granted a secret can transform it past the registered encodings. That is why
`SecretUse` under `Untrusted` is a `Confirm` floor.

### Per-thread isolation

- **Prompt cache:** one per thread (03).
- **Taint:** per request, sticky per thread.
- **Session grants:** per thread.
- **Budget:** per lease, with lineage (06 and [Denial of service and cost](#denial-of-service-and-cost)).
- **Console:** per-thread security identity, workspace, and Job Object.
- **Browser:** per-thread tab ownership (07) and origin grants; the cookie jar is shared (residual).
- **Secrets:** `SecretUse` grants per thread or agent.
- **Approvals:** bound to thread, lease, request, and digest.
- **Brain:** shared by design; provenance and participant scope (01) cross the boundary with every
  fact.
- **Audit:** one chain; every event carries its thread id.

No mechanism moves data between threads without provenance. Posts, opened threads, shared roots,
and recalled facts all make the receiver's taint the join of both.

### Shell containment

The mechanism must meet every requirement below. The containment conformance suite is the oracle.

1. **Distinct identity per thread.** Shell processes run under an OS security identity distinct
   from the owner and from every other thread. The mechanism is one AppContainer (low-box)
   profile per thread, as recorded in `REVIEW.md` and specified in `07-computer.md`: it gives a
   per-thread SID, denies the owner's files by default, and blocks network and loopback unless
   capabilities are granted. Sidecars run under a separate AppContainer SID. If the conformance
   suite fails on a supported Windows build, shell tools are disabled on that build; there is no
   fallback identity in v1.
2. **No access to** the daemon state directory (brain, audit, blobs, policy, approvals), the Maia
   Chrome profile, the vault, the owner's profile folders, the owner's credential store, other
   threads' workspaces, write access to the install directory, or owner persistence locations (Run
   keys, the Startup folder, scheduled tasks).
3. **Filesystem.** Each thread has a workspace under the workspaces root. Additional roots come only
   from `FsRoot` grants, applied as ACL entries for that thread's identity and removed on
   revocation.
4. **Network.** None by default, including loopback. `ConsoleNetwork::Allowlist` permits egress only
   to listed destinations, enforced by the OS (filters keyed on the sandbox identity, or proxy-only
   egress with direct egress blocked). Loopback, tailnet, LAN, and link-local stay blocked.
5. **Job Object** (07): kill on close, no breakaway, an active-process limit, a memory limit, a CPU
   rate cap, and UI restrictions (no clipboard read or write, no global atoms, no handles to owner
   windows, no system-parameter, display, or exit-windows changes).
6. **Desktop.** Sandbox processes run on a separate, non-interactive desktop, so a GUI child cannot
   see or inject input into the owner's desktop.
7. **No elevation.** The identity has no administrator membership or sensitive privileges.
   Elevation fails without a consent prompt, and Maia never asks the owner to approve a consent
   prompt on a thread's behalf.
8. **Environment.** Allowlisted (07). `SecretUse` with a console sink injects one variable for the
   granted scope; output is redacted.
9. **Daemon-side access to sandbox paths.** The daemon never opens a path inside a sandbox-writable
   directory with owner rights unless the handle is opened without following reparse points and the
   final path is verified to be inside that directory. Work that needs file content on a thread's
   behalf runs inside that thread's sandbox.
10. **Command inspection is not a boundary.** The daemon shows, records, and classifies commands, but
    enforcement relies on the OS identity. No command denylist is relied on.
11. **Paths.** Working directories and `FsRoot` grants reject UNC paths, `\\?\UNC\`, device
    namespaces, and WebDAV paths. Outbound SMB from sandboxes is blocked by the network rule.

### Browser containment

These extend the persistent-Chrome contract in 07.

1. **Automation channel:** `--remote-debugging-pipe` only. No debugging port, including on loopback.
2. **Profile hardening:** extensions disabled; sync and browser sign-in disabled; password manager
   and autofill disabled; third-party cookies blocked; downloads denied (07); the file chooser
   intercepted and denied (07); every permission request (camera, microphone, location,
   notifications, clipboard, USB, serial, HID, MIDI) denied; external protocol launch disabled; QUIC
   disabled; WebRTC limited to proxied traffic.
3. **Network:** all browser traffic goes through the daemon's egress proxy with no bypass list, so
   destination policy applies after DNS resolution. Navigation interception applies scheme and
   origin policy to top-level and frame navigations before requests leave.
4. **Blocked destinations:** `file:`, `chrome:`, `chrome-extension:`, `devtools:`, `view-source:`,
   top-level `javascript:` and `data:` navigations, `obsidian:` and every other external protocol,
   loopback, tailnet, LAN, link-local, and the Maia listener origins.
5. **Credentialed origins.** An origin where the owner has logged in inside the Maia profile is a
   credentialed origin. Any thread action on it needs `WebCredentialed`. Logging in is an owner
   action at the desktop (07) and grants no thread anything by itself.
6. **Tabs.** Thread-owned (07). A thread cannot read or drive another thread's tab. A popup opened
   by a page belongs to the opener's thread.
7. **Context egress.** Screenshots and DOM extracts are untrusted, redacted (07's list plus hidden
   inputs, one-time-code fields, and payment fields), bounded, and sent to the router only under a
   `ContextEgress` grant.
8. **Executable.** Chrome is launched from its installed absolute path after its Authenticode
   signature verifies, never through `PATH`.

### Scrapy containment

1. **Process.** The Scrapy sidecar runs under its own contained identity with no read access to the
   Chrome profile, daemon state, vault, owner profile, or the api-anything sandbox. Its executable
   and spider contracts are pinned by hash and verified at every launch. Egress uses the egress
   policy and the intent's origin allowlist.
2. **No model-installed spiders.** Only owner-authored or signed-pack contracts run. Extracted
   items are Untrusted web content.
3. **Read-oriented.** Scrapy does not perform credentialed writes; those use api-anything or Chrome.

### api-anything containment and learned operations

1. **Process.** The sidecar runs under its own contained identity with no read access to the Chrome
   profile, daemon state, vault, owner profile, or the Scrapy sandbox. Its executable is pinned by
   hash and verified at every launch. Its egress uses the egress policy. Owner promotion is required
   before a capability is executable; frequency of use never auto-promotes.
2. **Credentials per request.** For each execution, the daemon attaches cookies obtained from the
   browser owner for the operation's exact pinned origin, in memory, for that request only. The
   sidecar never stores credentials and never reads the profile.
3. **Learning yields candidates.** A learned operation starts `Quarantined`, recording the site,
   thread, session, taint, and observed requests. Only an owner promotion makes it executable:
   read-only and write operations at `Confirm`, each shown with its risk tier.
4. **Origin pinning.** An operation is bound to the exact origins (scheme, host, port) registered
   for its `SiteId`. Requests observed to other origins are not learnable into that site.
5. **Typed templates.** Scheme, host, port, method, and path prefix are fixed. Model-controlled
   fields are typed and schema-validated. Headers are built from typed fields, so raw header and
   CRLF injection are impossible. Bodies are validated against the contract schema.
6. **Risk.** The owner assigns risk at promotion. Until then the operation is `IrreversibleWrite`.
   The model cannot downgrade risk (07).
7. **Manifests.** Content-addressed. The daemon stores approved manifests, and every execution names
   its manifest hash. If the sidecar's `capabilities_hash` (07) does not match the approved set, API
   routes are disabled. Any change to an approved operation is a new candidate.
8. **Revocation.** Revoking an operation blocks it at the next sink check.

```rust
enum LearnedOperationState {
    Quarantined,
    Promoted { tier: ApprovalTier, by: UserActionId },
    Revoked { by: UserActionId },
}
```

### Egress policy

One egress decision governs the router, the browser, both sidecars, and network-granted sandboxes.

```rust
enum DestinationClass {
    Public,
    Loopback,
    Private,
    Tailnet,
    LinkLocal,
    Multicast,
    Unspecified,
    Reserved,
}

fn classify_destination(address: IpAddr) -> DestinationClass;

fn check_egress(
    destination: &ResolvedDestination,
    purpose: EgressPurpose,
    grants: &[CapabilityGrant],
    policy: &EgressPolicy,
) -> EgressDecision;
```

Rules:

- Classification uses the resolved address after normalizing IPv4-mapped and IPv4-compatible IPv6,
  the NAT64 well-known prefix, 6to4 and Teredo embeddings, and every IPv4 literal form (decimal,
  octal, hexadecimal, and shortened). `Tailnet` covers `100.64.0.0/10` and `fd7a:115c:a1e0::/48`;
  `LinkLocal` includes `169.254.169.254`.
- Only `Public` is allowed by default. `Loopback` is allowed only for a configured loopback router
  (07). Any other class needs an owner grant naming that exact address and port (`Confirm`).
- `localhost`, `*.localhost`, trailing-dot forms, and the machine's own names are treated as
  loopback before resolution.
- Resolve once, check every answer, and connect to a checked address without a second lookup. If
  any answer is denied, the destination is denied.
- Every redirect hop is rechecked. Credentials never follow a cross-origin redirect. The router
  follows no redirects (07).
- Daemon HTTP clients ignore system proxy auto-discovery (WPAD and PAC).
- Every decision is audited with its purpose, destination class, and rule id.

### Client authentication

```rust
enum ClientClass {
    DesktopWindow,
    PairedPhone { user: TailnetUserId, node: TailnetNodeId },
}
```

1. **Loopback is not identity.** Every request on the loopback listener must carry a session created
   by the desktop-window bootstrap. The daemon gives the Tauri window a per-launch secret over
   in-process IPC, never through a URL, file, or environment block other principals can read, and
   the window exchanges it for a session.
2. **Tailnet transport.** The tailnet listener serves HTTPS with a certificate for the machine's
   MagicDNS name issued through Tailscale. Issuing it publishes that name in certificate
   transparency logs; the owner is told before enabling remote access.
3. **Tailnet identity.** Every request's socket peer is resolved with LocalAPI `WhoIs` (07). The
   `(user, node)` pair must be paired. Tagged nodes and nodes without a user identity are denied.
   Identity headers are ignored (07). A `WhoIs` result may be cached for a short policy interval; a
   failure denies.
4. **Pairing.** A new phone is paired from the desktop at `DesktopConfirm`: the desktop shows a short
   code, the phone enters it after arriving through `WhoIs`, and the daemon records `(user, node)`.
5. **Session binding.** A session is bound to its listener, client class, and, for phones, node. It
   is rejected on the other listener or from another node. Sessions have idle and absolute lifetimes
   from policy. A session-generation counter revokes every session at once.
6. **Serve and Funnel.** At startup and on every Tailscale state change, the daemon asks LocalAPI
   whether a Serve or Funnel configuration targets a Maia port. If one does, remote access is
   disabled and a security event raised. Proxied requests arriving on loopback lack a desktop
   session and are rejected regardless.
7. **Phone authority.** Everything at `Confirm`: chat, inspect, approve, deny, stop, panic, and
   grants. Never a `DesktopConfirm` administration action.
8. **Lost device.** Unpair from the desktop (or from the phone itself), bump the session generation,
   delete every push subscription for that node, and remove the node in the Tailscale admin
   console. Push payloads are content-free (`07-computer.md` Android notifications).

### HTTP surface hardening

Every request on every listener:

- carries a `Host` that exactly matches a listener literal (`127.0.0.1:<port>`, `[::1]:<port>`, or
  the MagicDNS name or tailnet address with port); anything else is rejected, which defeats DNS
  rebinding;
- for mutations, carries a valid session, the session-bound CSRF token (07), an exact `Origin`,
  `Sec-Fetch-Site: same-origin` when the header is present, and `Content-Type: application/json`;
- for WebSocket upgrades, carries the session and an exact `Origin` (07).

Responses:

- no CORS headers; preflight requests are rejected;
- session cookies are `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS, use the `__Host-` prefix
  where the scheme allows it, and set no `Domain`;
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'; require-trusted-types-for 'script'`;
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`
  on API responses.

Rendering:

- Model output, tool output, filenames, URLs, and page titles render as text.
- If Markdown rendering is added to the transcript, raw HTML stays disabled, remote images are not
  loaded, and links show their full URL and open externally only after a click that reveals the
  destination. Allowed link schemes are `https`, and `http` with a warning. `javascript:`, `data:`,
  `file:`, `obsidian:`, and UNC targets are never links.
- The Tauri window loads only the daemon origin and blocks navigation elsewhere. Its IPC
  capabilities are limited to session bootstrap and opening the configured vault in Obsidian (09);
  the vault path comes from settings, never from the page.

Limits on request bodies, headers, WebSocket frames, message rates, and authentication failures
apply to every listener.

### Vault and Markdown safety

These complement 01 and 05.

1. **Neutralization contract.** Every string Maia writes into the vault from model-derived or
   untrusted data (fact sentences, entity descriptions, any future generated text) passes through
   `neutralize_inline_markdown`. Its output contains none of the following unescaped: `[[`, `![[`,
   `![`, `](`, `<http`, any `<`, `<%`, backtick runs that could open a code fence, `%%`, the literal
   `<!-- maia:` prefix, the schemes `obsidian:`, `file:`, `javascript:`, and `data:`, UNC prefixes,
   and bidirectional control characters. The escape table is versioned with the renderer, and
   rendering stays deterministic for a given renderer version (01). Slugs already have a closed
   character set (05).
2. **Reading.** Bytes returned by `read` are data with provenance, `Untrusted` by default. Links
   inside are not followed (01). Following a link means calling web tools and passing their sink
   checks.
3. **Instruction files.** `personality.md` and `agents.md` are installed into a new thread log only
   at an owner-approved content hash. A changed file raises a `Confirm` approval request.
   Until it is approved, new threads use the last approved bytes, and existing threads are
   unaffected because their prefix is already durable (03). An agent with no approved personality
   cannot start a thread.
4. **Writers.** Sandboxes have no vault access, and the dream writes only generated regions (01,
   05). The only writers of vault bytes are therefore the owner's own tools and Maia's renderer.
5. **Paths.** Vault path inputs reject UNC and device paths in addition to 01's rules.

### Memory and dream integrity

1. An episode segment carries provenance; an episode's taint is the join of its segments.
1a. **Promotion taint.** A promotion call sees exactly one episode, so each provisional claim it
   writes takes that episode's taint. The model's `episode_id` is checked for equality with the input
   episode and cannot lower taint. Promotion never reads or writes canonical facts, merges, or
   closures, so an untrusted promotion cannot close or merge a trusted fact.
2. **Consolidation context taint.** A consolidation call's taint is the join over everything the
   call sees: the selected claims and their episodes, context facts, correction marks, and pre-pass
   candidates. Every canonical fact, entity, merge, and closure in the response inherits it. The
   model's `episode_ids` and `claim_ids` remain provenance for inspection but cannot lower taint,
   which defeats provenance forgery.
3. **Taint-partitioned batches.** Selection (05) builds batches that are homogeneous in taint, and a
   trusted batch includes only trusted context facts. Oldest-first order holds within each
   partition.
4. **Trusted-fact protection.** When an untrusted batch would close or merge a trusted fact, the
   apply transaction records a proposal instead of applying that operation. The owner accepts or
   rejects it at `Confirm`. The response is still applied in one transaction (05).
5. **Untrusted world facts.** Untrusted batches may create world-scope entities and facts. They carry
   their taint, which the inspector shows.
6. **Recall.** Ranking policy (02) takes `RecallTaintMode` as an explicit input. The default is
   `IncludeUntrusted`. The owner may set `TrustedOnly` per agent. Retrieval stays pure.
7. **Credit.** A hijacked model can fake reasoning to credit included slots (04). That cannot change
   taint and cannot reach slots outside the request. Presentation reversal (06) is the repair.
8. **Retro-taint.** Incident response can raise taint on facts by source thread, origin, audit
   range, or dream-batch lineage. Raising is a tightening and applies immediately; lowering requires
   endorsement.

```rust
enum RecallTaintMode {
    IncludeUntrusted,
    TrustedOnly,
}
```

### Router and model trust

- Router output is untrusted and may be adversarial. Tool calls go through the pipeline; reasoning
  is used only for credit; replies render as text.
- Changing the router base URL, model, or key requires `DesktopConfirm` and is audited with the
  policy version.
- Data sent to the router is minimized: the compiled prefix, the scratch suffix, and the tool
  context the active action needs. Human-region text leaves only when a model explicitly reads a
  note. Screenshots leave only under grants. Secrets never leave.
- The provider key lives in the credential store. The owner is advised to use a key dedicated to
  Maia with a provider-side spend limit.
- A loopback router (07) is only as trustworthy as the local processes that could bind that port
  first. That is the owner's choice and is shown in settings.
- Embedder weights are pinned by hash and loaded from a non-executable format. A hostile embedder
  can bias ranking but cannot cause a side effect.
- The promotion and consolidation router calls receive the same validation (05).

### Immutable audit

These extend the audit in 06.

1. **Writers.** Only the daemon principal. Sandboxes and the sidecar have no access to the audit
   store or blobs.
2. **Chain.** The hash chain in 06.
3. **Signed checkpoints.** At policy-defined intervals and at every security event (grant, approval,
   policy change, pairing, panic, incident), the daemon signs `{sequence, event_hash,
   policy_version, time}` with an audit key held in the owner's credential store. An unkeyed chain
   can be recomputed by anyone who can write the store; the signature binds the head to a key no
   sandbox can reach.
4. **Witnesses.** Paired clients store the latest checkpoint they have seen and, on reconnect,
   require the new head to extend it through signed checkpoints. A mismatch is a security event. The
   owner can export checkpoints to removable media.
5. **Fail closed.** If an audit start event cannot be appended, the external call does not start (06
   invariant 4). If verification fails, the daemon enters `ExecutionMode::InspectOnly` until a
   `DesktopConfirm` acknowledgment starts a new signed segment; the broken segment is preserved as
   evidence.
6. **Security events** include: grant issued, revoked, or expired; approval requested, approved,
   denied, or expired; sink denied; egress denied; secret egress blocked; secret redacted; policy
   verified, applied, or rejected; update verified, applied, or rejected; session created or
   revoked; device paired or unpaired; `WhoIs` denied; Host, Origin, or CSRF rejected; Serve or
   Funnel detected; containment self-check failed; endorsement; retro-taint; incident opened or
   closed; execution mode changed.
7. **Redaction** happens before write (06). Events never contain secrets, tokens, or cookies.

### Execution modes and startup self-checks

```rust
enum ExecutionMode {
    Normal,
    AttendedOnly,
    NoTools,
    InspectOnly,
}
```

Modes are ordered from most to least capable and are global, orthogonal to per-thread `ThreadRun`.
Automatic transitions only narrow. Widening requires `DesktopConfirm`.

Startup checks, each of which narrows the mode on failure:

- the daemon token is not elevated (otherwise refuse to start);
- ACLs on the state directory, Chrome profile, policy, and audit store match expectations
  (otherwise `NoTools`);
- the policy bundle verifies and its version is at least the highest seen (otherwise the compiled
  floor applies and the mode is `NoTools`);
- the audit chain and latest checkpoint verify (otherwise `InspectOnly`);
- the sidecar hash and Chrome signature verify (otherwise those routes are unavailable, per 07);
- a containment probe in a fresh sandbox cannot read a state-directory canary or reach loopback
  (otherwise the console is unavailable);
- listeners bind only the permitted addresses (07) and the Host allowlist is populated;
- no Serve or Funnel configuration targets a Maia port (otherwise remote access is disabled).

The wall clock may not move behind the latest audited time. If it does, the mode narrows to
`AttendedOnly` and a security event is raised, so a rolled-back clock cannot extend grants.

### Denial of service and cost

1. **Budget lineage.** Every lease has a root cause: an owner message, an owner resume, or a due
   schedule occurrence. A lease caused by agent or tool activity (a tool-opened thread, or a post
   that wakes a sleeping thread) is a child whose ceilings are carved from the root's remaining
   reservation. Fan-out width and depth are bounded by policy. Ping-pong between threads cannot
   create fresh budget.
2. **Global breaker.** A daemon-wide rolling window over router tokens, tool turns, and estimated
   spend. Tripping it moves every unattended lease to `Sleeping` with a global budget reason and
   raises a security event. Resetting it is `Confirm`.
3. **Schedules.** Wherever schedules are defined, creating or changing one is an owner action at
   `Confirm` with a policy minimum interval. A vault edit cannot add a schedule without approval.
4. **Promotion and dreams.** A daily ceiling on promotion calls, a per-episode input cap, a daily
   ceiling on consolidation calls, and a per-batch input cap, on top of the single runners in 05.
5. **Approvals.** Per-thread rate limit and denial threshold (see
   [Approval tiers](#approval-tiers)).
6. **Resources.** Job Object limits; output byte ceilings (07); workspace disk quotas; a tab limit;
   sidecar rate limits; HTTP body and frame limits; JSON depth limits; size limits on Markdown and
   frontmatter; linear-time regular expressions only; bounded graph size and iteration counts per
   ranking query; bounded embedding batches (08); storage growth alerts, since episodes are kept
   forever (02).
7. **Panic availability.** Panic commands use a priority lane into the scheduler and the database
   owner, so a saturated queue cannot delay them. The in-memory admission gate closes before the
   durable write begins and stays closed if that write fails.

### Local privilege

- The daemon runs under the owner's standard account, refuses an elevated token, and has no
  component running as SYSTEM.
- The install directory is writable only by the owner and administrators. Child executables are
  launched by absolute path, and child DLL search is restricted to the system directory where
  Windows supports it.
- Named pipes use unpredictable names, first-instance creation, explicit DACLs naming the intended
  principals, and remote-client rejection.
- Temporary files are per user, exclusively created, unpredictably named, and restrictively ACL'd.
- Auto-start is per user and never "run with highest privileges".
- Untrusted bytes are parsed only by safe Rust or inside Chrome or a sandbox. Whatever resolves the
  `unsafe` question for Windows APIs (see [Consistency findings](#consistency-findings)), no unsafe
  code parses untrusted input.

### Exfiltration channels

- **Router prompt:** data minimization and no secrets; the owner chooses the router.
- **Web navigation and reads:** origin grants; `Confirm` for ungranted origins, so an untrusted
  context cannot silently reach a new origin through a URL.
- **Web and API writes:** risk tiers; `Confirm` under `Untrusted`.
- **Sandbox network:** none by default; allowlist; `Confirm` under `Untrusted` unless the owner
  lowered it at `DesktopConfirm`.
- **DNS through the system resolver:** residual. Limited by the fact that sandboxes hold nothing
  except what their grants put there.
- **Maia UI:** no remote resource loads (CSP).
- **Obsidian rendering:** neutralization removes remote embeds and links from generated content.
- **Cross-thread:** provenance join on every flow.
- **Clipboard:** Job Object UI limits; browser clipboard permission denied.
- **Screenshots and DOM:** `ContextEgress` grants; they go only to the router.
- **Notifications:** Android Web Push and desktop toasts are content-free
  (`07-computer.md`). Title/body are fixed; deep-link ids are opaque and useless
  without a live owner session. Push subscription keys are revoked on unpair.
- **Logs, metrics, crash reports:** local only and payload-free (06, 07); nothing is uploaded.
- **Backups:** Maia creates none that include the profile (07).

### Untrusted files

- Downloads stay off (07). Any future ingestion lands in a quarantine directory inside a sandbox,
  receives Mark-of-the-Web, is bounded in size and count, is typed by content rather than extension,
  and is processed inside a sandbox, never in the daemon.
- In addition to 01's path rules, path inputs reject UNC paths, device namespaces, alternate data
  streams, reserved device names, trailing dots and spaces, and short-name aliases that resolve out
  of scope. Paths are canonicalized with a final-path check, and daemon-side opens refuse reparse
  points.
- Archives are never extracted by the daemon. Inside a sandbox, extraction checks for path escapes,
  bounds entry count, size, and compression ratio, and rejects link entries.
- A future upload contract reads the file inside the thread's sandbox from its workspace, never by
  the daemon from an arbitrary path.

### Plugins and MCP

No plugin or MCP surface exists. 07 and 08 exclude plugin APIs, dynamic loading, and arbitrary
sidecar plugins. A future integration must, before it is enabled:

1. add closed `ToolRequest` variants (08), never a generic passthrough;
2. run out of process under a contained identity with no ambient secrets; secrets arrive only
   through `SecretUse` grants;
3. declare its capabilities in a manifest pinned by hash; tool names, descriptions, and schemas are
   untrusted text admitted to the tool-schema slot only at the approved hash, and any change
   disables the tool until it is re-approved at `Confirm` (a schema change also changes the
   prefix, so it affects new threads only, per 03);
4. route every call through the pipeline, with `Untrusted` outputs;
5. make no server-initiated model calls, read no other tool's output, and inject no content outside
   a tool result;
6. pass its own containment conformance tests.

### Supply chain and builds

1. **Dependencies.** `Cargo.lock` and the frontend lockfile are committed, and builds use `--locked`.
   Crates come from crates.io only; a git or external path dependency requires review. `cargo-deny`
   checks advisories, licenses, bans, duplicates, and sources. Every new or updated dependency gets
   a human audit record, with extra scrutiny for build scripts and procedural macros. Dependencies
   at trust boundaries are kept minimal.
2. **Frontend.** `npm ci --ignore-scripts`, pinned versions, no CDN assets; the daemon serves the
   bundle.
3. **Toolchain.** An exact pinned stable Rust and Node version, recorded once configuration exists
   after review.
4. **CI.** Ephemeral runners. Untrusted pull requests build without secrets. Signing runs in a
   separate job with minimal permissions.
5. **Artifacts.** Authenticode-signed binaries, an SBOM, a build provenance attestation, and release
   notes that list dependency changes.
6. **External binaries and models.** api-anything and the Scrapy sidecar are pinned by version
   and hash and verified at launch; Chrome is verified by signature; embedder weights are pinned
   by hash.
7. **Reproducibility** is a target, not a gate.
8. **Fuzzing toolchain.** Fuzz harnesses that need a nightly toolchain live outside the product
   workspace, so the product itself stays stable-only (08).

### Security policy versioning and signed updates

The security policy is data, versioned separately from the binary, so new tactics can be answered
without a release. It contains:

- the sink decision table, its floors, and approval tiers for owner actions;
- taint labeling rules and the paste threshold;
- egress classes and blocked schemes;
- the Markdown neutralization table version and the slot envelope version;
- secret pattern detectors and registered encodings;
- challenge-detection signatures (07);
- injection heuristics, which are advisory only;
- approval rate limits and the denial threshold;
- budget-lineage limits and breaker windows;
- session lifetimes;
- pinned hashes and minimum versions for the sidecar, Chrome, and embedder;
- revocation lists for learned operations and future plugin hashes.

Layers:

1. **Floor.** Compiled into the binary. No bundle or setting can loosen it.
2. **Signed bundle.** Canonical bytes signed with Ed25519 by a policy key, carrying a monotonic
   `policy_version` and an expiry, verified against a trust root compiled into the binary.
3. **Owner overrides.** Stored locally, set at `DesktopConfirm`, audited, and allowed to move only
   within what the floor permits.

```rust
fn verify_policy_bundle(
    bytes: &[u8],
    trust: &TrustRoot,
    highest_seen: PolicyVersion,
    now: Timestamp,
) -> Result<VerifiedPolicy, PolicyError>;

fn classify_policy_change(current: &SecurityPolicy, next: &SecurityPolicy) -> PolicyChange;

enum PolicyChange {
    Tighten,
    Loosen,
    Mixed,
}
```

Rules:

- **Rollback** to a version below the highest seen is rejected.
- **Freeze.** An expired bundle stays enforced, and the UI reports policy age. Expiry never loosens
  anything.
- **Metadata** follows a TUF-shaped split (root, targets, snapshot, and timestamp roles), so a
  network attacker cannot serve stale or mixed metadata.
- **Key rotation.** The root key signs policy and release keys with validity windows. Root rotation
  is a statement signed by the outgoing root.
- **Application.** The policy schema is built from components with a declared direction (deny lists
  grow, allow lists shrink, tiers rise), so `classify_policy_change` is mechanical. `Tighten` applies
  immediately, revoking grants and re-evaluating pending approvals. `Loosen` and `Mixed` wait for
  `DesktopConfirm` even when correctly signed, so a stolen policy key cannot silently widen
  behavior.
- **Determinism.** Every decision records `policy_version` and its rule id. A policy change never
  rewrites stored prompt bytes (03). Envelope and neutralization changes apply to new slots and new
  projections only.
- **Retro-scan.** A new detector version can be run over stored episodes and facts to find past
  matches. Matches raise taint and open incident candidates. History is never deleted.
- **Distribution.** Bundles are fetched over HTTPS from a configured endpoint or side-loaded from a
  file. The signature is the trust boundary, not TLS. Fetching is off until the owner enables it,
  and fetching sends no telemetry.

Binary updates:

- carry Authenticode and an updater signature from the release key, and reject rollback;
- are applied by the owner at `DesktopConfirm`, only after every thread has drained to `Sleeping`;
- run the startup self-checks before unattended execution resumes, narrowing the mode on failure;
- never migrate durable formats in a way that changes stored prefix bytes (03).

For a new tactic: new detection ships as a tightening bundle; a new structural control ships as a
binary update; a retro-scan finds past exposure; and the tactic becomes a permanent fixture in the
adversarial suite.

### Incident response and revocation

Triggers: secret egress blocked, repeated sink denials, a witness mismatch, an audit failure, a
containment self-check failure, `WhoIs` attempts from unpaired nodes, Serve or Funnel detection, an
unexpected instruction-file change, retro-scan hits, and owner suspicion.

Procedure:

1. **Contain.** Panic (06) or stop the thread; narrow the execution mode.
2. **Preserve.** Make affected workspaces read-only; export the audit range and checkpoints; keep
   every episode.
3. **Scope.** Identify threads, the audit sequence range, origins, learned operations, dream
   batches, derived facts (through provenance lineage), and devices and sessions involved.
4. **Revoke.** Grants; learned operations; sessions (bump the generation); paired nodes; the router
   key (rotate at the provider and in the credential store); site sessions (the owner clears site
   data for affected origins in the Maia profile; the profile is never deleted automatically, per
   07); sidecar or plugin hashes through policy.
5. **Repair memory.** Retro-taint facts; reverse presentations for the range (06); open closure
   proposals for poisoned facts for owner review.
6. **Recover.** Resuming affected threads requires `DesktopConfirm`. Ship a policy update when the
   tactic is new.
7. **Record.** A durable incident record links every action to audit sequences and is closed by the
   owner.

```rust
struct SecurityIncident {
    id: IncidentId,
    trigger: IncidentTrigger,
    scope: IncidentScope,
    actions: Vec<AuditEventId>,
    state: IncidentState,
}

enum IncidentState {
    Open,
    Contained,
    Closed { by: UserActionId },
}
```

Revocation takes effect at the next sink check and cancels in-flight work through the cancellation
path in 06. External effects that already happened are reported as completed or outcome-unknown;
Maia never claims to have rolled them back (06, 07).

## Invariants

1. No side effect happens without a covering grant, a sink check under the request's provenance,
   budget admission, a durable audit start event, and, where the tier requires it, an owner
   approval bound to the action digest.
2. Authority originates only in owner actions. Model output cannot create, widen, or extend a grant,
   change policy or settings, or pair a device.
3. Effective authority never increases across a thread-open, a post, or an agent-group thread.
4. Taint never decreases except through a recorded owner endorsement. Request taint is the join of
   the included slots and the scratch suffix.
5. `check_sink` is deterministic and monotone in taint, grants, and policy tightening.
6. Unattended runs never auto-approve. Approve controls never come from model-rendered content.
7. No known secret appears in any prompt, durable record, log, or UI projection.
8. Shell processes run under a per-thread contained identity with no access to daemon state, the
   Chrome profile, the vault, owner secrets, or other threads.
9. Browser automation is pipe-only, and all router, browser, sidecar, and sandbox egress passes one
   destination policy evaluated on resolved addresses.
10. Every API request, including loopback, carries a session of a known client class. Phones never
    perform `DesktopConfirm` actions.
11. Every byte Maia writes to the vault from model-derived or untrusted data is neutralized.
12. Promotion and dream output taint is the join of its whole context, and an untrusted promotion or
    batch cannot close or merge a trusted fact.
13. The audit is writable only by the daemon principal, chained, signed at checkpoints, and
    witnessed. A failed audit append blocks the operation.
14. A loosening policy change requires `DesktopConfirm`, rollback is rejected, and the compiled
    floor cannot be loosened.
15. Automatic execution-mode changes only narrow.
16. Panic stays reachable under load, and its admission gate closes before its durable write.
17. Security policy changes never rewrite stored prompt bytes.
18. Child leases are funded from their root lease, and a global breaker bounds daemon-wide spend.

## Failure handling

- **Policy missing, invalid, or unverifiable:** the compiled floor applies and the mode is
  `NoTools`.
- **Grant store unreadable:** every tool is denied.
- **Provenance missing on an included slot:** treated as `Untrusted` and raised as a security event.
- **Secret store unavailable:** operations needing a secret fail before start; a missing router key
  follows 07's authentication-failure handling.
- **Secret scanner error:** the egress it guards is blocked.
- **Approval UI unreachable:** the request waits. It never auto-approves and never times out into
  approval; on expiry it is denied.
- **OS user verification unavailable:** `DesktopConfirm` actions are unavailable; nothing downgrades
  to `Confirm`.
- **`WhoIs` failure:** deny (07).
- **Containment setup failure:** the console is unavailable for that thread (extending 07's Job
  Object rule).
- **Egress proxy down:** browser, sidecar, and sandbox network fail closed with no direct fallback.
- **Audit append failure:** no external call starts (06).
- **Checkpoint signing failure:** the mode narrows to `AttendedOnly` and a security event is raised.
- **Witness mismatch:** the mode narrows to `InspectOnly` pending owner review.
- **Policy or update verification failure:** keep the current version and raise a security event.
- **Approval digest mismatch at execution:** reject, audit, and request a new approval.
- **Repeated denials:** the thread moves to `Stopped` at the policy threshold.

## Observability

- The inspector shows taint for each slot, fact, and request. Cache marks untrusted slots. Brain
  marks untrusted nodes. Trace shows, for every tool call, the sink decision, rule id, grant, and
  approval.
- Activity shows pending approvals and a security-event count. The `NeedsHuman` banner carries the
  approval request.
- Metrics: sink decisions by rule and outcome; approvals requested, approved, denied, and expired,
  with latency; egress denials by destination class; secret hits and redactions; Host, Origin, and
  CSRF rejections; `WhoIs` denials; containment probe results; policy version and age; checkpoint
  lag; breaker state; execution mode.
- Logs and metrics never contain secrets, tokens, cookies, prompt bodies, or tool payloads.

## Testing contract

Tests inject time, policy, grants, a secret index built from canary values, and adversarial routers.
No test uses real credentials, the owner's Chrome profile, the owner's vault, or a live router.

### Pure leaf tests

- `check_sink`: every `SinkKind` against both taints, every grant state, both presences, and every
  floor row, asserting the rule id.
- Properties: taint monotonicity, grant monotonicity, and policy-tightening monotonicity of
  `check_sink`; `attenuate_grants` output is always a subset of the parent; the provenance join is
  commutative, associative, and idempotent; only an owner endorsement event lowers taint.
- `classify_destination`: a table over every IPv4 literal form, IPv4-mapped and compatible IPv6,
  NAT64, 6to4, Teredo, the tailnet ranges, metadata, and unspecified addresses; property: any
  address in a non-public range is non-public in every encoding.
- `check_egress`: mixed DNS answers, redirect chains, and connections pinned to the checked address.
- `neutralize_inline_markdown`: property over arbitrary Unicode that the output contains no
  forbidden construct and that a rendered entity page still parses to exactly one generated and one
  human region; determinism.
- `sanitize_terminal_output`: OSC 52, OSC 8, CSI, C1 controls, and bidirectional characters are
  removed or made visible; property: no escape byte survives.
- `render_approval`: injectivity over generated action pairs; invisible characters visible;
  internationalized hosts shown in punycode.
- `find_known_secrets`: a canary in every registered encoding, split across chunk boundaries and
  embedded in JSON, is always found.
- `authorize_request`: listener, client class, Host, Origin, `Sec-Fetch-Site`, CSRF token, session
  generation, `WhoIs` result, and tagged-node cases.
- `verify_policy_bundle` and `classify_policy_change`: wrong key, truncation, rollback, expiry
  (still enforced, flagged), root rotation, mixed metadata; a `Mixed` change is treated as `Loosen`.
- `verify_checkpoint`: truncation, a chain recomputed without the key, and witness divergence.
- `admit_lease`: child carve-out, fan-out limits, ping-pong, and breaker trip.

### Adversarial integration suite

A scripted router obeys every injection it sees, modeling the worst-case model. Fixtures plant
payloads in a web page, an API response, console output, a vault note, a retrieved fact, another
agent's message, dream input, and a tool description. The suite asserts that each action is denied
or requires approval exactly as the table says; that no canary reaches a router request; that no
egress reaches an ungranted origin; that no grant is created; that facts carry the expected taint;
that dream provenance forgery never yields a trusted fact; that promotion `episode_id` forgery
never yields a trusted claim; and that an untrusted closure of a trusted fact becomes a proposal. Every new tactic adds a fixture.

### Windows containment conformance

Run on a real Windows build in CI. From a thread sandbox, each of these must fail: reading a
state-directory canary, the brain, or the audit store; reading the Chrome profile's cookie or key
files; reading a vault canary; reading another thread's workspace canary; reading owner
credential-store entries; connecting to the Maia listeners, the sidecar, or any loopback address;
writing a Run key, the Startup folder, a scheduled task, or the install directory; reading or
writing the clipboard; enumerating or injecting input into owner windows; opening the daemon process
for memory reads; breaking away from or outliving the Job Object; elevating; reaching a UNC path;
reaching the network without a grant; reaching a non-allowlisted destination with one. Work inside
the thread's own workspace and granted roots must succeed in the granted mode. A junction planted in
a workspace must not be followed by the daemon.

### Browser conformance

Navigation and subresource requests to loopback, `[::1]`, the tailnet, private ranges, link-local,
the Maia origins, `file:`, `chrome:`, and external protocols are blocked. A hostname that rebinds to
loopback is blocked at the proxy. WebRTC sends no unproxied UDP. Downloads, the file chooser, and
permission prompts are denied. No debugging port listens. Third-party cookies are blocked. An action
on an ungranted credentialed origin is denied.

### HTTP surface

A hostile page served to a real browser attempts CSRF, DNS rebinding, and WebSocket hijacking
against the daemon and fails. A simulated Serve proxy on loopback without a desktop session is
denied. A phone approval of a `CapabilityApproval` executes the digest-bound action exactly once,
a replay of that approval is rejected, a phone cannot perform a `DesktopConfirm` action, and a
phone panic engages the latch. The
security headers are present. XSS payloads in model output, tool output, and filenames render inert.

### Fuzz targets

Targets live outside the product workspace: frontmatter, region markers, the vault path normalizer
with Windows path forms, the router JSON and SSE parsers, tool-call argument validation, console
sentinel framing, the terminal sanitizer, the Markdown neutralizer, URL and host parsing with
destination classification, HTTP authorization inputs, session cookie parsing, policy bundle
parsing and verification, the dream response parser, learned-operation manifests, and audit event
canonicalization. Each asserts no panic, bounded time and memory, and its security property. Stable
`proptest` property tests live in the workspace.

### Supply chain and denial of service

CI fails on lockfile drift, `cargo-deny` violations, unaudited new dependencies, install scripts,
and unpinned external binaries. An update artifact with a wrong signature or an older version is
rejected. Panic latency stays bounded with a saturated database queue. An approval flood stops the
thread at the threshold. Size limits reject oversized inputs before parsing.

## Consistency findings

Resolved items are marked **Resolved** and no longer override chapter text. Open items still need
a decision in `REVIEW.md`; until then the restrictive reading here applies.

1. **Loopback treated as identity.** **Resolved (r2).** [07](07-computer.md) Peer authorization
   and invariant 10 require the per-launch desktop secret for every loopback UI session.
2. **Chrome debugging-port fallback.** **Resolved (r3).** [07](07-computer.md) uses pipe-only
   automation with no port fallback.
3. **Shell and sidecar identity.** **Resolved (r3).** [07](07-computer.md) uses one AppContainer SID
   per thread plus a separate sidecar SID, and denies the whole vault. Mechanism recorded in
   `REVIEW.md`.
4. **Unkeyed audit chain.** **Resolved (r3).** [06](06-agents.md) signs checkpoints and keeps
   witnesses on paired clients.
5. **Budget laundering.** **Resolved (r3).** [06](06-agents.md) adds budget lineage and the global
   spend breaker.
6. **Approval waits.** **Resolved (r2).** `HumanRequestKind::CapabilityApproval` exists; [09](09-frontend.md)
   uses kind-specific copy. Superseded (r4 owner decision): every client approves at `Confirm`.
7. **Tailnet HTTPS.** 07 sets the session cookie `Secure` on the tailnet, which requires HTTPS, but
   names no certificate source. Required: a Tailscale-issued certificate for the MagicDNS name, with
   the certificate-transparency disclosure.
8. **Device pairing.** **Resolved (r3).** [07](07-computer.md) authorizes paired `(user, node)` and
   denies tagged nodes.
9. **Phone settings.** **Resolved (r4).** [09](09-frontend.md) keeps administration fields
   read-only on remote clients; grants and approvals are `Confirm` on every owner client.
10. **`forbid(unsafe_code)` versus Windows containment.** **Resolved (r3).** [08](08-rust.md) names
    one audited `maia-win32` crate as the only one allowed `unsafe`; it parses no untrusted bytes.
11. **Markdown neutralization.** **Resolved (r4).** [01](01-vault.md) runs
    `neutralize_inline_markdown` on fact sentences and entity descriptions before generated
    bytes are written.
12. **Dream taint.** **Resolved (r2b).** [05](05-dream.md) partitions by taint, sets fact taint from
    the whole dream-call context (not model `episode_ids`), and records proposals for untrusted
    closures/merges of trusted facts.
13. **Provenance in cache and recall.** **Resolved (r4).** [02](02-brain.md) facts carry taint +
    sources; episodes carry segment provenance; `rank_paths` takes quarantine and
    `RecallTaintMode`. `request_provenance` joins recall-item taint. [03](03-thread-cache.md)
    defines Untrusted-slot envelopes for durable slots only (not recall), version frozen per slot.
14. **Agent-group grants.** **Resolved (r4).** [06](06-agents.md) intersects participant grants
    for `AgentGroup` threads.
15. **Instruction-file approval.** **Resolved (r4).** [01](01-vault.md) and [03](03-thread-cache.md)
    install `personality.md` and `agents.md` only at an owner-approved content hash.
16. **Environment-variable secrets.** 09 allows secrets as environment-variable references.
    Required: bootstrap-only import into the credential store; release builds use the store only.
17. **Sidecar credential source.** The plan and 07 say cookies stay in the profile but not how the
    sidecar authenticates learned calls. Required: per-request, origin-scoped cookies supplied by
    the browser owner; the sidecar never reads the profile.
18. **Panic priority.** **Resolved (r4).** [06](06-agents.md) closes an in-memory gate first and
    writes the durable latch on a priority database-owner lane.
19. **Audit-failure mode.** **Resolved (r3).** [06](06-agents.md) enters `InspectOnly`, blocks
    clearing panic until `DesktopConfirm`, and keeps engaging panic available.
20. **Closed tool enum.** **Resolved (r2).** [07](07-computer.md) `ToolRequest` includes VaultMap,
    VaultRead, Console, Web, PostToThread, OpenThread.
21. **Ports for cancellation and audit.** **Resolved (r4).** [08](08-rust.md) adds
    `Router::cancel`, `Tools::cancel`, and `AuditLog`.
22. **Fuzz toolchain.** 08 is stable-only, and common fuzzing tools need nightly. Required: harnesses
    outside the product workspace.
23. **Frontend surfaces.** **Resolved (r4).** [09](09-frontend.md) shows recall, taint, proposals,
    quarantine, device pairing, and administration read-only on remote clients.
24. **Gate set.** **Resolved (r4).** [00-goal.md](00-goal.md) consistency links include `10` and
    `11`, and the acceptance checklist has a Security item.

## Explicitly out of scope

- An attacker already running as the owner's Windows account, a local administrator, SYSTEM, the
  kernel, firmware, or physical access to the unlocked desktop. Maia limits what its own sandboxes
  and remote clients can do; it does not defend the owner account from itself (consistent with 06).
- Preventing prompt injection inside the model. Maia bounds consequences instead.
- Confidentiality from the configured router provider for data Maia sends it.
- Compromise of the Tailscale coordination service or of WireGuard.
- Chrome and Windows vulnerabilities, beyond keeping them current and contained.
- DNS exfiltration through the system resolver from a network-granted sandbox, covert timing
  channels, and hardware side channels.
- An owner who approves an accurately rendered harmful action.
- The security of Obsidian, its plugins, or sync services, beyond neutralizing what Maia writes.
- Encryption at rest for the brain or vault (full-disk encryption is recommended), and multi-user
  or multi-tenant operation.
- Malware scanning of files.
- Fingerprint rotation, proxy rotation, and refresh-as-evasion beyond the
  configured captcha solver and stored credentials (07).
- Production code, configuration, CI files, policy bundles, or keys during the documentation gate.

## Consistency links

- Product goal, gate, and acceptance checklist: [00-goal.md](00-goal.md)
- Vault paths, regions, and the participant scope: [01-vault.md](01-vault.md)
- Episodes, facts, and ranking policy: [02-brain.md](02-brain.md)
- Canonical slot bytes and request records: [03-thread-cache.md](03-thread-cache.md)
- Request-bounded credit and correction marks: [04-credit.md](04-credit.md)
- Dream batching, schema, and transaction: [05-dream.md](05-dream.md)
- Leases, budgets, panic, audit, and reversal: [06-agents.md](06-agents.md)
- Router, console, api-anything, Scrapy, Chrome, and Tailscale boundaries:
  [07-computer.md](07-computer.md)
- Crate boundaries, ports, and the `unsafe` rule: [08-rust.md](08-rust.md)
- Stop placement, `NeedsHuman`, settings, and the phone: [09-frontend.md](09-frontend.md)
- Whole-set acceptance record: `REVIEW.md`
