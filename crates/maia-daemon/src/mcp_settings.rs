//! Settings skin for admitted MCP connections.
//!
//! Secret values are written only to [`McpSecretStore`]. SQLite stores the reference.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

use maia_core::mcp::CatalogEntry;
use maia_core::mcp::CatalogStatus;
use maia_core::mcp::CatalogTool;
use maia_core::mcp::ConnectionView;
use maia_core::mcp::ListedState;
use maia_core::mcp::ListedTool;
use maia_core::mcp::LiveTool;
use maia_core::mcp::SecretNeedle;
use maia_core::mcp::bound_tool_text;
use maia_core::mcp::connection_entries;
use maia_core::mcp::parameter_names;
use maia_core::mcp::prepare_manifest;
use maia_core::mcp::redact_secret_needles;
use maia_core::mcp::render_tool_result;
use maia_core::mcp::wire_name;
use maia_core::router::Router;
use maia_store::McpConnectionRecord;
use maia_store::McpSecretSlot;
use maia_store::McpTransportRecord;
use maia_store::SqliteOwner;
use maia_store::StoreError;
use maia_tools::mcp_client::ClientError;
use maia_tools::mcp_client::McpSession;
use maia_tools::mcp_client::RpcOutgoing;
use maia_tools::mcp_client::RpcPost;
use maia_tools::mcp_client::RpcReply;
use maia_tools::mcp_client::post_json;
use serde_json::Value;
use serde_json::json;

use crate::orchestrator::AdmittedMcpTool;
use crate::orchestrator::McpToolReply;
use crate::orchestrator::Orchestrator;

/// Why a settings call failed. The message never includes a secret value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpApiError {
    /// The body did not match the connection contract.
    Invalid,
    /// No connection has that id.
    NotFound,
    /// The id is already stored.
    Conflict,
    /// SQLite or the owner queue failed.
    Store,
    /// The secret store could not be used.
    Secret,
}

/// Stores MCP header and environment values outside SQLite.
pub trait McpSecretStore: Send + Sync {
    /// Reads one secret.
    ///
    /// # Errors
    ///
    /// Returns [`McpApiError::Secret`] when the store cannot be read.
    fn read_secret(&self, secret_ref: &str) -> Result<Option<String>, McpApiError>;

    /// Replaces one secret.
    ///
    /// # Errors
    ///
    /// Returns [`McpApiError::Secret`] when the value is empty or the store rejects it.
    fn write_secret(&self, secret_ref: &str, value: &str) -> Result<(), McpApiError>;

    /// Removes one secret. A missing secret is success.
    ///
    /// # Errors
    ///
    /// Returns [`McpApiError::Secret`] when the store rejects the delete.
    fn delete_secret(&self, secret_ref: &str) -> Result<(), McpApiError>;
}

/// In-memory secrets for tests and for a daemon that has not been given an OS store.
#[derive(Default)]
pub struct MemoryMcpSecretStore {
    values: Mutex<BTreeMap<String, String>>,
}

impl MemoryMcpSecretStore {
    /// Empty store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl std::fmt::Debug for MemoryMcpSecretStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("MemoryMcpSecretStore")
    }
}

impl McpSecretStore for MemoryMcpSecretStore {
    fn read_secret(&self, secret_ref: &str) -> Result<Option<String>, McpApiError> {
        Ok(self
            .values
            .lock()
            .map_err(|_| McpApiError::Secret)?
            .get(secret_ref)
            .cloned())
    }

    fn write_secret(&self, secret_ref: &str, value: &str) -> Result<(), McpApiError> {
        if value.is_empty() {
            return Err(McpApiError::Secret);
        }
        self.values
            .lock()
            .map_err(|_| McpApiError::Secret)?
            .insert(secret_ref.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete_secret(&self, secret_ref: &str) -> Result<(), McpApiError> {
        self.values
            .lock()
            .map_err(|_| McpApiError::Secret)?
            .remove(secret_ref);
        Ok(())
    }
}

/// OS credential entries `MaiaMcp:{secret_ref}`.
pub struct NativeMcpSecretStore;

impl McpSecretStore for NativeMcpSecretStore {
    fn read_secret(&self, secret_ref: &str) -> Result<Option<String>, McpApiError> {
        #[cfg(windows)]
        {
            match maia_windows::read_session_credential(&mcp_target(secret_ref)) {
                Ok(secret) => String::from_utf8(secret.as_bytes().to_vec())
                    .map(Some)
                    .map_err(|_| McpApiError::Secret),
                Err(maia_windows::CredentialError::NotFound) => Ok(None),
                Err(_) => Err(McpApiError::Secret),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = secret_ref;
            Err(McpApiError::Secret)
        }
    }

    fn write_secret(&self, secret_ref: &str, value: &str) -> Result<(), McpApiError> {
        if value.is_empty() {
            return Err(McpApiError::Secret);
        }
        #[cfg(windows)]
        {
            maia_windows::write_local_credential(&mcp_target(secret_ref), value.as_bytes())
                .map_err(|_| McpApiError::Secret)
        }
        #[cfg(not(windows))]
        {
            let _ = secret_ref;
            Err(McpApiError::Secret)
        }
    }

    fn delete_secret(&self, secret_ref: &str) -> Result<(), McpApiError> {
        #[cfg(windows)]
        {
            match maia_windows::delete_session_credential(&mcp_target(secret_ref)) {
                Ok(()) | Err(maia_windows::CredentialError::NotFound) => Ok(()),
                Err(_) => Err(McpApiError::Secret),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = secret_ref;
            Err(McpApiError::Secret)
        }
    }
}

fn mcp_target(secret_ref: &str) -> String {
    format!("MaiaMcp:{secret_ref}")
}

struct Endpoint {
    id: String,
    url: String,
    headers: Vec<(String, String)>,
}

/// Rebuilds the owner-chat catalog and the worker transport from SQLite.
pub fn install_from_store<R: Router>(
    host: &mut Orchestrator<R>,
    secrets: &Arc<dyn McpSecretStore>,
) {
    let Ok(records) = host.store().list_mcp() else {
        return;
    };
    let (entries, live) = catalog_for(&records, secrets.as_ref());
    host.install_mcp(entries, live);
    let endpoints = endpoints(&records);
    let secrets = Arc::clone(secrets);
    host.set_mcp_transport(move |connection, _wire, call| {
        invoke(&endpoints, secrets.as_ref(), connection, call)
    });
}

/// Inserts a connection and stores any secret values outside SQLite.
///
/// # Errors
///
/// Returns [`McpApiError`] when the body, store, or secret store rejects the write.
pub fn create_connection(
    store: &SqliteOwner,
    secrets: &dyn McpSecretStore,
    body: &Value,
) -> Result<Value, McpApiError> {
    let (record, pairs) = record_from_body(body)?;
    write_pairs(secrets, &pairs)?;
    if let Err(error) = store.create_mcp(record) {
        let _ = delete_pairs(secrets, &pairs);
        return Err(map_store(error));
    }
    public_list(store, secrets)
}

/// Replaces transport fields and clears the admitted hash.
///
/// # Errors
///
/// Returns [`McpApiError`] when the connection is missing or the body is rejected.
pub fn replace_connection(
    store: &SqliteOwner,
    secrets: &dyn McpSecretStore,
    id: &str,
    body: &Value,
) -> Result<Value, McpApiError> {
    let records = store.list_mcp().map_err(map_store)?;
    let existing = records
        .iter()
        .find(|record| record.id == id)
        .ok_or(McpApiError::NotFound)?;
    let previous = slot_refs(existing);
    let (transport, pairs) = transport_from_body(id, body)?;
    write_pairs(secrets, &pairs)?;
    if let Err(error) = store.replace_mcp_transport(id, transport) {
        let _ = delete_pairs(secrets, &pairs);
        return Err(map_store(error));
    }
    let _ = delete_refs(secrets, &previous);
    public_list(store, secrets)
}

/// Changes the label and leaves the admitted hash in place.
///
/// # Errors
///
/// Returns [`McpApiError`] when the label or the connection is rejected.
pub fn rename_connection(
    store: &SqliteOwner,
    secrets: &dyn McpSecretStore,
    id: &str,
    body: &Value,
) -> Result<Value, McpApiError> {
    let label = body
        .get("label")
        .and_then(Value::as_str)
        .ok_or(McpApiError::Invalid)?;
    store.update_mcp_label(id, label).map_err(map_store)?;
    public_list(store, secrets)
}

/// Deletes the connection and its secret references.
///
/// # Errors
///
/// Returns [`McpApiError`] when the store rejects the delete.
pub fn delete_connection(
    store: &SqliteOwner,
    secrets: &dyn McpSecretStore,
    id: &str,
) -> Result<Value, McpApiError> {
    let records = store.list_mcp().map_err(map_store)?;
    let existing = records
        .iter()
        .find(|record| record.id == id)
        .ok_or(McpApiError::NotFound)?;
    let previous = slot_refs(existing);
    store.delete_mcp(id).map_err(map_store)?;
    let _ = delete_refs(secrets, &previous);
    public_list(store, secrets)
}

/// Lists tools for one HTTP connection. A failed list keeps the previous hash.
///
/// # Errors
///
/// Returns [`McpApiError`] when the connection is missing.
pub fn refresh_connection(
    store: &SqliteOwner,
    secrets: &dyn McpSecretStore,
    id: &str,
) -> Result<Value, McpApiError> {
    let records = store.list_mcp().map_err(map_store)?;
    let existing = records
        .iter()
        .find(|record| record.id == id)
        .ok_or(McpApiError::NotFound)?;
    match &existing.transport {
        McpTransportRecord::Stdio { .. } => {}
        McpTransportRecord::Http { url, headers } => {
            if headers
                .iter()
                .all(|slot| secret_ready(secrets, &slot.secret_ref))
            {
                match resolved_headers(secrets, headers) {
                    Ok(resolved) => match list_http_tools(url, &resolved) {
                        Ok(tools) => store_listed(store, id, &tools)?,
                        Err(error) => {
                            let _ = store.set_mcp_refresh_error(id, scrub(&error, &resolved));
                        }
                    },
                    Err(error) => return Err(error),
                }
            }
        }
    }
    public_list(store, secrets)
}

/// Admits the listed hash.
///
/// # Errors
///
/// Returns [`McpApiError`] when the hash does not match the listed manifest.
pub fn admit_connection(
    store: &SqliteOwner,
    secrets: &dyn McpSecretStore,
    id: &str,
    body: &Value,
) -> Result<Value, McpApiError> {
    let hash = body
        .get("hash")
        .and_then(Value::as_str)
        .ok_or(McpApiError::Invalid)?;
    store.admit_mcp(id, hash).map_err(map_store)?;
    public_list(store, secrets)
}

/// Clears the admitted hash and keeps the listed manifest.
///
/// # Errors
///
/// Returns [`McpApiError`] when the connection is missing.
pub fn revoke_connection(
    store: &SqliteOwner,
    secrets: &dyn McpSecretStore,
    id: &str,
) -> Result<Value, McpApiError> {
    store.revoke_mcp(id).map_err(map_store)?;
    public_list(store, secrets)
}

/// Public connection list. Secret values are absent.
///
/// # Errors
///
/// Returns [`McpApiError::Store`] when the owner cannot be read.
pub fn public_list(
    store: &SqliteOwner,
    secrets: &dyn McpSecretStore,
) -> Result<Value, McpApiError> {
    let records = store.list_mcp().map_err(map_store)?;
    Ok(
        json!({ "connections": records.iter().map(|record| public_connection(record, secrets)).collect::<Vec<_>>() }),
    )
}

fn catalog_for(
    records: &[McpConnectionRecord],
    secrets: &dyn McpSecretStore,
) -> (Vec<CatalogEntry>, Vec<AdmittedMcpTool>) {
    let mut entries = Vec::new();
    let mut live = Vec::new();
    for record in records {
        let view = connection_view(record, secrets);
        entries.extend(connection_entries(&view));
        if view.blocked.is_none() && matches!(view.listed, ListedState::Matches { .. }) {
            let Some(hash) = record.admitted_hash.clone() else {
                continue;
            };
            for tool in
                tools_from_canonical(&record.id, record.listed_canonical.as_deref().unwrap_or(""))
            {
                live.push(AdmittedMcpTool {
                    tool,
                    connection_id: record.id.clone(),
                    manifest_hash: hash.clone(),
                });
            }
        }
    }
    (entries, live)
}

fn connection_view(record: &McpConnectionRecord, secrets: &dyn McpSecretStore) -> ConnectionView {
    let secret_ok = slots(record)
        .iter()
        .all(|slot| secret_ready(secrets, &slot.secret_ref));
    let listed = listed_state(record);
    let tools = if matches!(listed, ListedState::Matches { .. }) {
        tools_from_canonical(&record.id, record.listed_canonical.as_deref().unwrap_or(""))
            .into_iter()
            .map(|tool| CatalogTool {
                parameters: parameter_names(&tool.input_schema).unwrap_or_default(),
                wire_name: tool.wire_name,
                description: tool.description,
            })
            .collect()
    } else {
        Vec::new()
    };
    ConnectionView {
        label: record.label.clone(),
        blocked: block_reason(record, secret_ok),
        listed,
        tools,
    }
}

fn block_reason(record: &McpConnectionRecord, secret_ok: bool) -> Option<CatalogStatus> {
    if matches!(record.transport, McpTransportRecord::Stdio { .. }) {
        return Some(CatalogStatus::Containment);
    }
    if !secret_ok {
        return Some(CatalogStatus::SecretMissing);
    }
    if record.listed_hash.is_none() {
        let error = record.refresh_error.as_deref().unwrap_or("");
        if error.contains("Unsupported MCP protocol") {
            return Some(CatalogStatus::Protocol);
        }
        if !error.is_empty() {
            return Some(CatalogStatus::Unreachable);
        }
    }
    None
}

fn listed_state(record: &McpConnectionRecord) -> ListedState {
    match (&record.admitted_hash, &record.listed_hash) {
        (_, None) => ListedState::Absent,
        (None, Some(listed)) => ListedState::Pending {
            hash: listed.clone(),
        },
        (Some(admitted), Some(listed)) if admitted == listed => ListedState::Matches {
            hash: listed.clone(),
        },
        (Some(admitted), Some(listed)) => ListedState::Drifted {
            admitted: admitted.clone(),
            listed: listed.clone(),
        },
    }
}

fn tools_from_canonical(connection_id: &str, canonical: &str) -> Vec<LiveTool> {
    let Ok(values) = serde_json::from_str::<Vec<Value>>(canonical) else {
        return Vec::new();
    };
    let mut live = Vec::new();
    for value in values {
        let Some(name) = value.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Ok(wire) = wire_name(connection_id, name) else {
            continue;
        };
        let description = value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let schema = value
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object"}))
            .to_string();
        live.push(LiveTool {
            wire_name: wire,
            server_tool: name.to_owned(),
            description,
            input_schema: schema,
        });
    }
    live
}

fn endpoints(records: &[McpConnectionRecord]) -> Vec<Endpoint> {
    records
        .iter()
        .filter_map(|record| match &record.transport {
            McpTransportRecord::Http { url, headers } => Some(Endpoint {
                id: record.id.clone(),
                url: url.clone(),
                headers: headers
                    .iter()
                    .map(|slot| (slot.name.clone(), slot.secret_ref.clone()))
                    .collect(),
            }),
            McpTransportRecord::Stdio { .. } => None,
        })
        .collect()
}

fn invoke(
    endpoints: &[Endpoint],
    secrets: &dyn McpSecretStore,
    connection: &str,
    call: &maia_core::mcp::McpCall,
) -> McpToolReply {
    let Some(endpoint) = endpoints.iter().find(|endpoint| endpoint.id == connection) else {
        return not_sent("The MCP server is not connected.");
    };
    let mut values = Vec::new();
    let mut headers = Vec::new();
    for (name, secret_ref) in &endpoint.headers {
        let Ok(Some(value)) = secrets.read_secret(secret_ref) else {
            return not_sent("The MCP secret is missing.");
        };
        headers.push((name.clone(), value.clone()));
        values.push(value);
    }
    let outcome = call_http_tool(
        &endpoint.url,
        &headers,
        &call.server_tool,
        &call.arguments_json,
    );
    let (sent, completed, text) = match outcome {
        HttpOutcome::Finished(parts) => (true, true, render_tool_result(&parts)),
        HttpOutcome::Unknown => (
            true,
            false,
            "The MCP server did not answer in time.".to_owned(),
        ),
        HttpOutcome::NotSent(error) => (false, false, scrub(&error, &headers)),
    };
    let needles: Vec<SecretNeedle<'_>> = values
        .iter()
        .map(|value| SecretNeedle(value.as_str()))
        .collect();
    let shown = bound_tool_text(&redact_secret_needles(&text, &needles));
    for value in &mut values {
        wipe(value);
    }
    McpToolReply {
        sent,
        completed,
        text: shown,
        image_png_base64: None,
    }
}

enum HttpOutcome {
    Finished(Vec<maia_core::mcp::ToolPart>),
    NotSent(String),
    Unknown,
}

struct HttpPost<'a> {
    url: &'a str,
    headers: &'a [(String, String)],
}

impl RpcPost for HttpPost<'_> {
    fn round_trip(&mut self, outgoing: &RpcOutgoing) -> Result<RpcReply, ClientError> {
        let headers = self
            .headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        post_json(
            self.url,
            &headers,
            outgoing,
            std::time::Duration::from_secs(60),
        )
    }
}

fn list_http_tools(url: &str, headers: &[(String, String)]) -> Result<Vec<ListedTool>, String> {
    let mut session = McpSession::new();
    let mut post = HttpPost { url, headers };
    let tools = session.list_tools(&mut post).map_err(client_message)?;
    Ok(tools
        .into_iter()
        .map(|tool| ListedTool {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
        })
        .collect())
}

fn call_http_tool(
    url: &str,
    headers: &[(String, String)],
    name: &str,
    arguments_json: &str,
) -> HttpOutcome {
    let mut session = McpSession::new();
    let mut post = HttpPost { url, headers };
    match session.call_tool(&mut post, name, arguments_json) {
        Ok(parts) => HttpOutcome::Finished(parts),
        Err(ClientError::Timeout) => HttpOutcome::Unknown,
        Err(error) => HttpOutcome::NotSent(client_message(error)),
    }
}

fn client_message(error: ClientError) -> String {
    match error {
        ClientError::Target => "The MCP URL is not allowed.".to_owned(),
        ClientError::Transport => "The MCP server could not be reached.".to_owned(),
        ClientError::Protocol => "Unsupported MCP protocol.".to_owned(),
        ClientError::MethodRefused => {
            "The MCP server asked for a method Maia does not provide.".to_owned()
        }
        ClientError::TooManyTools => "The MCP server listed too many tools.".to_owned(),
        ClientError::Timeout => "The MCP server did not answer in time.".to_owned(),
    }
}

fn not_sent(text: &str) -> McpToolReply {
    McpToolReply {
        sent: false,
        completed: false,
        text: text.to_owned(),
        image_png_base64: None,
    }
}

fn scrub(text: &str, headers: &[(String, String)]) -> String {
    let needles: Vec<SecretNeedle<'_>> = headers
        .iter()
        .map(|(_, value)| SecretNeedle(value.as_str()))
        .collect();
    redact_secret_needles(text, &needles)
}

fn store_listed(store: &SqliteOwner, id: &str, tools: &[ListedTool]) -> Result<(), McpApiError> {
    let prepared = prepare_manifest(id, tools).map_err(|_| McpApiError::Invalid)?;
    store
        .store_mcp_list(id, &prepared.canonical, &prepared.hash)
        .map_err(map_store)?;
    Ok(())
}

fn public_connection(record: &McpConnectionRecord, secrets: &dyn McpSecretStore) -> Value {
    let view = connection_view(record, secrets);
    let status = match view.blocked {
        Some(status) => status_phrase(status),
        None => match &view.listed {
            ListedState::Matches { .. } => "live",
            ListedState::Pending { .. } => status_phrase(CatalogStatus::PendingApproval),
            ListedState::Drifted { .. } => status_phrase(CatalogStatus::SchemaChanged),
            ListedState::Absent => "not listed",
        },
    };
    let tools = listed_tools(record.listed_canonical.as_deref().unwrap_or(""));
    match &record.transport {
        McpTransportRecord::Http { url, headers } => json!({
            "id": record.id,
            "label": record.label,
            "transport": "http",
            "url": url,
            "headers": headers.iter().map(|slot| json!({
                "name": slot.name,
                "secret_set": secret_ready(secrets, &slot.secret_ref),
            })).collect::<Vec<_>>(),
            "status": status,
            "refresh_error": record.refresh_error,
            "admitted_hash": record.admitted_hash,
            "listed_hash": record.listed_hash,
            "tools": tools,
        }),
        McpTransportRecord::Stdio { command, args, env } => json!({
            "id": record.id,
            "label": record.label,
            "transport": "stdio",
            "command": command,
            "args": args,
            "env": env.iter().map(|slot| json!({
                "name": slot.name,
                "secret_set": secret_ready(secrets, &slot.secret_ref),
            })).collect::<Vec<_>>(),
            "status": status,
            "refresh_error": record.refresh_error,
            "admitted_hash": record.admitted_hash,
            "listed_hash": record.listed_hash,
            "tools": tools,
        }),
    }
}

fn listed_tools(canonical: &str) -> Vec<Value> {
    let Ok(values) = serde_json::from_str::<Vec<Value>>(canonical) else {
        return Vec::new();
    };
    values
        .into_iter()
        .filter_map(|value| {
            let name = value.get("name")?.as_str()?.to_owned();
            let description = value
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            Some(json!({ "name": name, "description": description }))
        })
        .collect()
}

fn status_phrase(status: CatalogStatus) -> &'static str {
    match status {
        CatalogStatus::PendingApproval => "pending approval",
        CatalogStatus::SchemaChanged => "schema changed",
        CatalogStatus::SecretMissing => "secret missing",
        CatalogStatus::Containment => "containment is not ready",
        CatalogStatus::Protocol => "protocol is unsupported",
        CatalogStatus::Unreachable => "unreachable",
    }
}

fn record_from_body(
    body: &Value,
) -> Result<(McpConnectionRecord, Vec<(String, String)>), McpApiError> {
    let id = body
        .get("id")
        .and_then(Value::as_str)
        .ok_or(McpApiError::Invalid)?;
    let label = body.get("label").and_then(Value::as_str).unwrap_or(id);
    let (transport, pairs) = transport_from_body(id, body)?;
    Ok((
        McpConnectionRecord {
            id: id.to_owned(),
            label: label.to_owned(),
            transport,
            admitted_hash: None,
            listed_canonical: None,
            listed_hash: None,
            refresh_error: None,
        },
        pairs,
    ))
}

fn transport_from_body(
    id: &str,
    body: &Value,
) -> Result<(McpTransportRecord, Vec<(String, String)>), McpApiError> {
    match body
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("http")
    {
        "http" => {
            let url = body
                .get("url")
                .and_then(Value::as_str)
                .ok_or(McpApiError::Invalid)?;
            let (headers, pairs) = secret_slots(id, "h", body.get("headers"))?;
            Ok((
                McpTransportRecord::Http {
                    url: url.to_owned(),
                    headers,
                },
                pairs,
            ))
        }
        "stdio" => {
            let command = body
                .get("command")
                .and_then(Value::as_str)
                .ok_or(McpApiError::Invalid)?;
            let args = string_list(body.get("args"))?;
            let (env, pairs) = secret_slots(id, "e", body.get("env"))?;
            Ok((
                McpTransportRecord::Stdio {
                    command: command.to_owned(),
                    args,
                    env,
                },
                pairs,
            ))
        }
        _ => Err(McpApiError::Invalid),
    }
}

fn secret_slots(
    id: &str,
    kind: &str,
    value: Option<&Value>,
) -> Result<(Vec<McpSecretSlot>, Vec<(String, String)>), McpApiError> {
    let Some(items) = value else {
        return Ok((Vec::new(), Vec::new()));
    };
    let items = items.as_array().ok_or(McpApiError::Invalid)?;
    let mut slots = Vec::new();
    let mut pairs = Vec::new();
    for (ordinal, item) in items.iter().enumerate() {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .ok_or(McpApiError::Invalid)?;
        let secret = item
            .get("value")
            .and_then(Value::as_str)
            .ok_or(McpApiError::Invalid)?;
        let secret_ref = format!("{id}-{kind}-{ordinal}");
        slots.push(McpSecretSlot {
            name: name.to_owned(),
            secret_ref: secret_ref.clone(),
        });
        pairs.push((secret_ref, secret.to_owned()));
    }
    Ok((slots, pairs))
}

fn string_list(value: Option<&Value>) -> Result<Vec<String>, McpApiError> {
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned).ok_or(McpApiError::Invalid))
            .collect(),
        Some(_) => Err(McpApiError::Invalid),
    }
}

fn slots(record: &McpConnectionRecord) -> &[McpSecretSlot] {
    match &record.transport {
        McpTransportRecord::Http { headers, .. } => headers,
        McpTransportRecord::Stdio { env, .. } => env,
    }
}

fn slot_refs(record: &McpConnectionRecord) -> Vec<String> {
    slots(record)
        .iter()
        .map(|slot| slot.secret_ref.clone())
        .collect()
}

fn secret_ready(secrets: &dyn McpSecretStore, secret_ref: &str) -> bool {
    matches!(secrets.read_secret(secret_ref), Ok(Some(_)))
}

fn resolved_headers(
    secrets: &dyn McpSecretStore,
    slots: &[McpSecretSlot],
) -> Result<Vec<(String, String)>, McpApiError> {
    let mut headers = Vec::new();
    for slot in slots {
        let value = secrets
            .read_secret(&slot.secret_ref)?
            .ok_or(McpApiError::Secret)?;
        headers.push((slot.name.clone(), value));
    }
    Ok(headers)
}

fn write_pairs(
    secrets: &dyn McpSecretStore,
    pairs: &[(String, String)],
) -> Result<(), McpApiError> {
    for (secret_ref, value) in pairs {
        secrets.write_secret(secret_ref, value)?;
    }
    Ok(())
}

fn delete_pairs(
    secrets: &dyn McpSecretStore,
    pairs: &[(String, String)],
) -> Result<(), McpApiError> {
    delete_refs(
        secrets,
        &pairs
            .iter()
            .map(|(secret_ref, _)| secret_ref.clone())
            .collect::<Vec<_>>(),
    )
}

fn delete_refs(secrets: &dyn McpSecretStore, refs: &[String]) -> Result<(), McpApiError> {
    for secret_ref in refs {
        secrets.delete_secret(secret_ref)?;
    }
    Ok(())
}

fn map_store(error: StoreError) -> McpApiError {
    match error {
        StoreError::NotFound { .. } => McpApiError::NotFound,
        StoreError::InvalidRequest { message } if message.contains("missing") => {
            McpApiError::NotFound
        }
        StoreError::InvalidRequest { message } if message.contains("already exists") => {
            McpApiError::Conflict
        }
        StoreError::InvalidRequest { .. } => McpApiError::Invalid,
        _ => McpApiError::Store,
    }
}

fn wipe(secret: &mut String) {
    let mut bytes = std::mem::take(secret).into_bytes();
    for byte in &mut bytes {
        *byte = 0;
    }
    std::mem::drop(std::hint::black_box(bytes));
}

#[cfg(test)]
mod tests {
    use super::*;
    use maia_store::OwnerOpen;
    use std::fs;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

    fn open() -> SqliteOwner {
        let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "maia-mcp-settings-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temp dir");
        SqliteOwner::open(OwnerOpen {
            path: directory.join("maia.sqlite"),
            now: 1,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("open")
    }

    #[test]
    fn create_hides_the_secret_and_a_drifted_hash_hides_tool_text() {
        let store = open();
        let secrets = MemoryMcpSecretStore::new();
        let created = create_connection(
            &store,
            &secrets,
            &json!({
                "id": "web",
                "label": "Web",
                "transport": "http",
                "url": "https://mcp.example.com/mcp",
                "headers": [{"name": "Authorization", "value": "super-secret-value"}]
            }),
        )
        .expect("create");
        let text = created.to_string();
        assert!(text.contains("\"secret_set\":true"));
        assert!(!text.contains("super-secret-value"));
        store
            .store_mcp_list("web", r#"[{"description":"Read a page","inputSchema":{"type":"object"},"name":"scrape"}]"#, "hash-a")
            .expect("list");
        store.admit_mcp("web", "hash-a").expect("admit");
        store
            .store_mcp_list("web", r#"[{"description":"Read a page","inputSchema":{"type":"object"},"name":"scrape"}]"#, "hash-b")
            .expect("drift");
        let records = store.list_mcp().expect("records");
        let (entries, live) = catalog_for(&records, &secrets);
        assert!(live.is_empty());
        let rendered = maia_core::mcp::catalog_lines(&entries);
        assert!(rendered.contains("schema changed"));
        assert!(!rendered.contains("Read a page"));
        assert!(!rendered.contains("super-secret-value"));
    }
}
