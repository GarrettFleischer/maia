# Admitted MCP catalog

## TDD preamble

- **Kind:** new feature
- **Invariant:** the owner chat can read every live subagent tool and can attach advisory guidance, and it cannot invoke any of them; a subagent can invoke only a tool whose schema hash the owner has admitted.
- **Red test(s):** router tool-list absence; router call rejected with no transport I/O; catalog hides unapproved schemas; schema drift drops live tools; guidance bounds and prompt-byte identity; worker schema equals the admitted set; argument rejection skips the transport; child grants cannot widen; sampling requests do not call the model; secrets stay out of prompts and audit; stdio does not spawn while containment is unready; non-local HTTP URLs must be `https`; a transport edit clears the admitted hash.
- **Then:** pure admission and catalog leaves, then store and HTTP skins, then the owner-chat and worker wiring, then Settings.

## Honesty preamble

- **Leaves (honest):** `canonical_manifest`, `manifest_hash`, `wire_name`, `catalog_lines`, `admit_mcp_call`, `check_guidance`, `classify_mcp_exchange`, `mcp_grants`, `validate_connection_target`, `check_arguments`. Each receives the manifest, role, bytes, or clock-free facts as parameters.
- **Skin (I/O):** the HTTP JSON-RPC client, the stdio launcher, secret resolution, and the timeout. They live in the daemon composition root and `maia-tools`.
- **Hooks (backward):** Axum settings handlers and the orchestrator. They parse, call one leaf or one skin, and write the result.
- **Mode args:** `McpTransport`, `CatalogStatus`, `SessionRole`, and `McpExchangeClass` are enums.
- **Pause-and-review:** after each new function, confirm it does not read the clock, the store, the network, the secret store, or the process table unless it is the skin named above.

## Purpose

Maia connects to MCP servers the owner adds. The owner chat learns the tools those servers give to subagents, and it can tell a subagent how to use them. The owner chat still does no work. Subagents call only tools whose schema the owner has admitted.

No server ships with the product. An empty catalog is a valid install. The Decodo server at the end of this document is an example of a connection the owner might add. It is not a default, a seed row, or a named code path.

This feature amends the closed tool rule in `10-security.md`. The single execution variant is `Mcp { connection, tool, arguments }`. The host sends that call only when the wire name is in the admitted manifest and the arguments pass `check_arguments`. A free-form forward to an unapproved server or tool is refused.

On implementation, update `07-computer.md`, `10-security.md`, `14-super-agent-router.md`, and `REVIEW.md` to match this spec. Those edits are part of the same change as the code.

## Architecture

```text
Settings (desktop edits transport; any owner client admits a hash)
  |-- connection row (no secret values)
  |-- listed manifest (untrusted, pre-approval)
  `-- admitted hash

Owner chat
  |-- system prompt includes catalog_lines
  |-- tools_json stays the six route tools
  `-- spawn_task, continue_task, and link_task may carry guidance

Host leaves
  |-- admit_mcp_call
  |-- mcp_grants
  `-- check_guidance

Subagent
  |-- system prompt includes the live catalog and the latest guidance
  |-- user turns: sealed owner prompt, then each continue input
  `-- tools_json is the live admitted set

Tool skin
  |-- HttpJsonRpc
  `-- StdioProcess   (fails closed until containment is ready)
```

`execution_tools` stays an emptiness proof for every role and every security profile. MCP grants come from `mcp_grants`. `Unrestricted` does not add MCP tools to the owner chat.

## Connection record

A connection is owner configuration stored in SQLite.

```rust
struct McpConnection {
    id: ConnectionId,
    label: String,
    transport: McpTransport,
    admitted_hash: Option<ManifestHash>,
}

enum McpTransport {
    Http {
        url: String,
        headers: Vec<HeaderSecret>,
    },
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<EnvSecret>,
    },
}

struct HeaderSecret {
    name: String,
    secret_ref: SecretRef,
}

struct EnvSecret {
    name: String,
    secret_ref: SecretRef,
}
```

`ConnectionId` matches `^[a-z][a-z0-9_-]{0,13}$`. `label` is at most 80 UTF-8 bytes. Header and env names match `^[A-Za-z0-9-]{1,64}$`. The command is a non-empty path or file name of at most 256 bytes. Arguments are each at most 512 bytes, with at most 32 arguments. The URL is an absolute URL of at most 2048 bytes.

`validate_connection_target` accepts an HTTP URL only when the scheme is `https`, or when the scheme is `http` and the host is a loopback name (`localhost`, `127.0.0.1`, or `::1`). Redirects are disabled. The leaf does not resolve DNS.

Secret values are stored through the existing secret store. The connection row stores `SecretRef` only. Reads for Settings return `secret_set: true | false` per header or env entry. Logs, audit rows, prompts, catalog lines, and API responses omit the value.

The connection id is immutable. Editing the label does not change `admitted_hash`. Editing the transport clears `admitted_hash` and the listed manifest. The owner lists and admits again after a transport edit.

## Listing and admission

The skin speaks MCP as a client.

1. `initialize` with protocol version `2025-03-26`.
2. Accept a server response of `2025-03-26` or `2024-11-05`. Any other version sets status `Protocol` and stores no tools.
3. Send `notifications/initialized`.
4. Call `tools/list`, following `nextCursor` until the list ends.

The client handles server requests while it waits:

- `sampling/createMessage`, `roots/list`, and `elicitation/create` receive JSON-RPC error `-32601`.
- That response does not call the model, read the vault, or open an owner prompt.
- A tool result is the only server content that can enter a subagent transcript.

`canonical_manifest` sorts tools by `name` and emits compact JSON with sorted object keys for `name`, `description`, and `inputSchema`. `manifest_hash` is the SHA-256 hex of those bytes.

Admission limits, checked before the hash is stored:

- at most 32 tools;
- canonical bytes at most 32_768;
- each server tool name matches `^[A-Za-z0-9_-]{1,48}$`;
- `wire_name` is `{connection_id}__{tool_name}` and is at most 64 characters;
- a wire name already live on another connection is rejected.

A listed manifest is shown in Settings so the owner can read it. It is absent from the owner-chat prompt and from subagent `tools_json` until the owner admits that exact hash. `POST .../admit` stores the hash only when the body hash equals the stored listed hash. A later `tools/list` whose hash differs sets status `SchemaChanged`, clears the live tools, and keeps the old hash visible as the last admission so the owner can see that it no longer matches.

Approving a manifest allows whatever that server does inside a tool, including its own model calls. Maia still refuses protocol messages that would make Maia call a model.

## Who may change what

Transport create, edit, delete, and `tools/list` are local-desktop administration, the same gate as the model connection. The phone Settings view can read status and can admit or revoke a hash that the desktop has already listed. Admit and revoke are `Confirm` actions on any authenticated owner client. Revoke clears `admitted_hash`. The listed manifest remains until the next list or until the connection is deleted.

## Catalog the owner chat sees

`catalog_lines` renders entries the caller has already classified.

```rust
enum CatalogEntry {
    Live {
        label: String,
        wire_name: String,
        description: String,
        parameters: Vec<String>,
    },
    Hidden {
        label: String,
        status: CatalogStatus,
    },
}

enum CatalogStatus {
    PendingApproval,
    SchemaChanged,
    SecretMissing,
    Containment,
    Protocol,
    Unreachable,
}
```

`Live` is built only from a manifest whose hash equals `admitted_hash` and whose transport can run. `Hidden` carries the owner label and the status. It carries no tool name, description, or schema. Parameter names are the sorted top-level `properties` keys. A schema that is not an object contributes an empty parameter list.

The owner-chat system prompt gains one section, `Subagent tools`, after the route rules. The section is the `catalog_lines` string. The owner chat's `tools_json` remains `spawn_task`, `continue_task`, `link_task`, `inspect_task`, `cancel_task`, and `retry_task`.

A route-tool call whose name is outside that six is rejected before secret resolution and before any MCP client method.

## Guidance

`spawn_task`, `continue_task`, and `link_task` take an optional `guidance` string. `check_guidance` accepts `None` or a string of at most 2000 UTF-8 bytes. A longer string refuses that route. The host does not truncate.

Guidance is stored on the task as advisory text. It is not written into `original_prompt`, the brief, a criterion, or a constraint. It cannot satisfy completion. It cannot add a grant.

The subagent system prompt includes the latest guidance under the heading `Router guidance (advisory)`. The worker contract states that the sealed owner text wins when the two disagree, and that the callable tools are exactly `tools_json`.

`inspect_task`, `cancel_task`, and `retry_task` have no guidance field. A proposal that includes one is refused.

On the first worker turn, the user message is the sealed owner prompt. On continue, the worker receives that sealed prompt and then each stored continue input, in order. Guidance stays in the system section for the turn that carries it.

## Subagent calls

`mcp_grants(role, live_wire_names, parent_grants)` returns an empty set for `SessionRole::Router`. For a parent it returns one `GrantKey` per live wire name, and `parent_grants` is ignored. For a child it returns the live wire names that are also in `parent_grants`. A child draft that names any other grant fails the existing `narrow_child` check.

`admit_mcp_call(role, wire_name, arguments, live)` returns a call only for a parent or child whose grants contain that wire name, and only when `check_arguments` accepts the arguments. The router role returns refusal with the transport uncalled.

`check_arguments` enforces a bounded subset of JSON Schema:

- missing `inputSchema` means a JSON object, additional properties allowed;
- `type` must be absent or `object`;
- every name in `required` is present;
- each present property whose schema declares `type` of `string`, `number`, `boolean`, `array`, or `object` must have that JSON type;
- `integer` means a JSON number with no fractional part (`1` passes, `1.5` fails);
- `additionalProperties: false` rejects unknown top-level keys.

`$ref`, `oneOf`, `pattern`, and numeric ranges stay in the schema the model sees. The host does not enforce them. The admitted hash still covers the full schema bytes.

The skin calls `tools/call` with the server tool name, not the wire name. The result text is untrusted. Binary parts become the sentence `The tool returned binary content and it was omitted.` Text parts are concatenated. The host caps the concatenated text at 65_536 bytes and appends `\n[truncated]` when it cuts. Configured secret-pattern detectors run on that text before it is appended to the subagent transcript. A match is replaced with `[redacted]`.

The audit row stores the connection id, wire name, manifest hash, exchange class, and the SHA-256 of the redacted result. It stores neither the arguments nor the result body.

## Exchange class

`classify_mcp_exchange(sent, completed)`:

| sent | completed | class |
| --- | --- | --- |
| false | false | `KnownFailure` |
| true | true | `KnownResult` |
| true | false | `Unknown` |

`KnownFailure` covers refused admission, a JSON-RPC error, or a connection that failed before the request was written. `Unknown` uses the existing rule: `WaitingForUser` with the call id, and that call id is not issued again. A timeout after the request is written is `Unknown`. The timeout value is a parameter of the skin, 60 seconds for list and for call.

## Stdio

The stdio launcher returns `Containment` and does not spawn a process while the platform capability report says unattended spawn is unready. No ambient environment is passed. Env entries are the configured secret refs only, resolved at the skin. When containment is later ready, the same leaves admit the call; only the launcher changes.

## HTTP API

Under the existing `/api` router:

| Method and path | Effect |
| --- | --- |
| `GET /api/super-agent/mcp` | Connections, status, `secret_set`, and admitted wire names |
| `POST /api/super-agent/mcp` | Create. Desktop only |
| `PUT /api/super-agent/mcp/{id}` | Replace transport. Clears the hash. Desktop only |
| `DELETE /api/super-agent/mcp/{id}` | Delete the connection, its listed manifest, and its hash. Desktop only |
| `POST /api/super-agent/mcp/{id}/list` | Run `tools/list` and store the listed manifest. Desktop only |
| `POST /api/super-agent/mcp/{id}/admit` | Store the hash when it matches the listed manifest |
| `POST /api/super-agent/mcp/{id}/revoke` | Clear the admitted hash |

A phone request that creates, edits, deletes, or lists receives the same refusal the model-connection editor already uses for a non-desktop client.

## Settings

Settings gains an MCP section beside the model connection.

- The desktop form adds an HTTP connection or a stdio connection, sets the label, and enters secrets that the UI does not echo back.
- After a successful list, the desktop shows each tool name, description, and schema, marked as untrusted, with Admit.
- The phone view shows the label and status. When a list is waiting, it can Admit or Revoke. It has no transport fields.
- Fixture data for the preview shell contains no live client and no secret.

## Failure handling

- **Secret missing:** status `SecretMissing`. The catalog entry is `Hidden`. The subagent does not receive those tools.
- **List or initialize failed:** a connection that has never admitted a matching list shows `Unreachable` or `Protocol`. A failed refresh leaves the admitted hash and the previous catalog entry unchanged. Settings reports the refresh error beside that entry. A successful refresh whose hash differs sets `SchemaChanged` and drops live tools.
- **Schema drift:** subagent calls to that connection are refused. The owner chat sees `SchemaChanged` and the label.
- **Tool-call JSON-RPC error:** known failure, returned as the tool result text after redaction and the size cap.
- **Dropped connection after send:** `Unknown`, no automatic retry.
- **Oversized list:** the list is discarded, nothing is admitted, and Settings reports the limit that failed.

## Tests

Contract tests call the leaves with fixture manifests. They do not open sockets, spawn processes, or read environment variables.

- For every `SecurityProfile`, the owner-chat tool list has the six route names and no wire name from a live manifest.
- `admit_mcp_call` for `SessionRole::Router` returns refusal, and the test transport records zero calls.
- `catalog_lines` includes description and parameters for `Live`, and only label plus status for `Hidden`.
- A one-byte schema change yields `SchemaChanged` and an empty grant set for that connection.
- Guidance of 2000 bytes is stored; 2001 bytes refuses the route; the sealed prompt bytes stay equal to the owner message.
- Worker `tools_json` function names equal the live wire names.
- An argument that misses `required` does not call the transport.
- A child grant set that adds a wire name fails `narrow_child`.
- A server `sampling/createMessage` produces a `-32601` response and zero model completions.
- A fixture secret value is absent from catalog text, API JSON, and the audit row.
- The stdio launcher, given an unready containment report, records zero spawns.
- `http://example.com/mcp` fails `validate_connection_target`; `http://127.0.0.1/mcp` and `https://mcp.example.com/mcp` pass.
- Replacing the URL clears `admitted_hash`.

The HTTP skin tests use a loopback fixture server. No test in the default suite calls a public MCP host.

## Example connection

This example is not installed.

An owner who wants the hosted Decodo web tools adds an HTTP connection with id `decodo`, label `Decodo`, URL `https://mcp.decodo.com/mcp`, and one header `Authorization` whose secret ref resolves to `Bearer <api key>`. They list the tools, read the schemas, and admit the hash. From then on, the owner chat can name those wire names in guidance, and a subagent can call them. Removing the connection or revoking the hash removes the tools from both prompts.

## Out of scope

- MCP resources, prompts, and completions.
- A built-in directory of servers.
- Sampling, roots, and elicitation as features.
- Spawning stdio servers before the containment report is ready.
- Full JSON Schema evaluation.
- Letting the owner chat invoke an MCP tool under any security profile.
