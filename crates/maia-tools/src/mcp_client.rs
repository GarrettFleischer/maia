//! MCP JSON-RPC client for `initialize`, `tools/list`, and `tools/call`.
//!
//! Server requests such as sampling are answered with method-not-found. This
//! client has no model callback.

use std::time::Duration;

use serde_json::Value;
use serde_json::json;

use maia_core::mcp::ToolPart;
use maia_core::mcp::validate_connection_target;

const ACCEPTED_PROTOCOLS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// One tool description returned by `tools/list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteTool {
    /// Server tool name.
    pub name: String,
    /// Untrusted description.
    pub description: String,
    /// Raw input schema JSON.
    pub input_schema: String,
}

/// Why a JSON-RPC exchange failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// The HTTP URL is not allowed.
    Target,
    /// The transport failed before or during the write.
    Transport,
    /// The server protocol version or payload could not be used.
    Protocol,
    /// A server request was refused. No model call was made.
    MethodRefused,
    /// The tool list exceeded 32 tools.
    TooManyTools,
    /// The request was written and no complete response arrived.
    Timeout,
}

/// Outbound JSON-RPC body plus the session id from an earlier response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcOutgoing {
    /// JSON-RPC body.
    pub body: String,
    /// `Mcp-Session-Id` when the server has issued one.
    pub session: Option<String>,
}

/// Inbound HTTP body and optional session id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcReply {
    /// Response body. Empty is a successful notification acknowledgement.
    pub body: String,
    /// Session id returned by the server.
    pub session: Option<String>,
}

/// One HTTP round trip. The caller attaches secrets outside this trait.
pub trait RpcPost {
    /// Sends one JSON body and returns the response body.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::Transport`] when the exchange fails.
    fn round_trip(&mut self, outgoing: &RpcOutgoing) -> Result<RpcReply, ClientError>;
}

/// Session state for one MCP server.
#[derive(Debug, Default)]
pub struct McpSession {
    session: Option<String>,
    ready: bool,
    next_id: i64,
}

impl McpSession {
    /// Empty session.
    #[must_use]
    pub fn new() -> Self {
        Self {
            session: None,
            ready: false,
            next_id: 1,
        }
    }

    /// Initializes the server when needed and returns its tools.
    ///
    /// # Errors
    ///
    /// Returns a [`ClientError`] when the handshake or list fails.
    pub fn list_tools(&mut self, post: &mut dyn RpcPost) -> Result<Vec<RemoteTool>, ClientError> {
        self.ensure_ready(post)?;
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(value) => json!({ "cursor": value }),
                None => json!({}),
            };
            let response = self.request(post, "tools/list", params)?;
            let result = response.get("result").ok_or(ClientError::Protocol)?;
            let listed = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or(ClientError::Protocol)?;
            for tool in listed {
                tools.push(remote_tool(tool)?);
                if tools.len() > 32 {
                    return Err(ClientError::TooManyTools);
                }
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if cursor.is_none() {
                return Ok(tools);
            }
        }
    }

    /// Calls one server tool by its server name.
    ///
    /// # Errors
    ///
    /// Returns a [`ClientError`] when the call does not complete.
    pub fn call_tool(
        &mut self,
        post: &mut dyn RpcPost,
        name: &str,
        arguments_json: &str,
    ) -> Result<Vec<ToolPart>, ClientError> {
        self.ensure_ready(post)?;
        let arguments: Value =
            serde_json::from_str(arguments_json).map_err(|_| ClientError::Protocol)?;
        let response = self.request(
            post,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )?;
        if response.get("error").is_some() {
            let message = response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("The tool call failed.");
            return Ok(vec![ToolPart::Text(message.to_owned())]);
        }
        let content = response
            .pointer("/result/content")
            .and_then(Value::as_array)
            .ok_or(ClientError::Protocol)?;
        let mut parts = Vec::new();
        for item in content {
            parts.push(tool_part(item));
        }
        Ok(parts)
    }

    fn ensure_ready(&mut self, post: &mut dyn RpcPost) -> Result<(), ClientError> {
        if self.ready {
            return Ok(());
        }
        let response = self.request(
            post,
            "initialize",
            json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "maia", "version": "0.1.0" }
            }),
        )?;
        let version = response
            .pointer("/result/protocolVersion")
            .and_then(Value::as_str)
            .ok_or(ClientError::Protocol)?;
        if !accepted_protocol(version) {
            return Err(ClientError::Protocol);
        }
        self.notify(post, "notifications/initialized")?;
        self.ready = true;
        Ok(())
    }

    fn request(
        &mut self,
        post: &mut dyn RpcPost,
        method: &str,
        params: Value,
    ) -> Result<Value, ClientError> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.exchange(post, &body.to_string(), true)
    }

    fn notify(&mut self, post: &mut dyn RpcPost, method: &str) -> Result<(), ClientError> {
        let body = json!({
            "jsonrpc": "2.0",
            "method": method,
        });
        let reply = post.round_trip(&RpcOutgoing {
            body: body.to_string(),
            session: self.session.clone(),
        })?;
        if let Some(session) = reply.session {
            self.session = Some(session);
        }
        let body = json_message(&reply.body)?;
        if body.is_empty() {
            return Ok(());
        }
        let value: Value = serde_json::from_str(&body).map_err(|_| ClientError::Protocol)?;
        if value.get("method").is_some()
            && value.get("result").is_none()
            && value.get("error").is_none()
        {
            self.refuse_server_request(post, &value)?;
        }
        Ok(())
    }

    fn exchange(
        &mut self,
        post: &mut dyn RpcPost,
        body: &str,
        require_result: bool,
    ) -> Result<Value, ClientError> {
        let reply = post.round_trip(&RpcOutgoing {
            body: body.to_owned(),
            session: self.session.clone(),
        })?;
        if let Some(session) = reply.session {
            self.session = Some(session);
        }
        let body = json_message(&reply.body)?;
        let value: Value = serde_json::from_str(&body).map_err(|_| ClientError::Protocol)?;
        if value.get("method").is_some()
            && value.get("result").is_none()
            && value.get("error").is_none()
        {
            self.refuse_server_request(post, &value)?;
            return Err(ClientError::MethodRefused);
        }
        if require_result && value.get("result").is_none() && value.get("error").is_none() {
            return Err(ClientError::Protocol);
        }
        Ok(value)
    }

    fn refuse_server_request(
        &mut self,
        post: &mut dyn RpcPost,
        request: &Value,
    ) -> Result<(), ClientError> {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "Method not found" }
        });
        let _reply = post.round_trip(&RpcOutgoing {
            body: body.to_string(),
            session: self.session.clone(),
        })?;
        Err(ClientError::MethodRefused)
    }
}

/// Posts JSON to an allowed MCP URL. Redirects are disabled.
///
/// # Errors
///
/// Returns [`ClientError::Target`] or [`ClientError::Transport`].
pub fn post_json(
    url: &str,
    headers: &[(&str, &str)],
    outgoing: &RpcOutgoing,
    timeout: Duration,
) -> Result<RpcReply, ClientError> {
    validate_connection_target(url).map_err(|_| ClientError::Target)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ClientError::Transport)?;
    let mut request = client
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(outgoing.body.clone());
    if let Some(session) = &outgoing.session {
        request = request.header("mcp-session-id", session);
    }
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().map_err(|error| {
        if error.is_timeout() {
            ClientError::Timeout
        } else {
            ClientError::Transport
        }
    })?;
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response.text().map_err(|_| ClientError::Transport)?;
    Ok(RpcReply { body, session })
}

/// Refuses to spawn a stdio server while containment is unready.
///
/// # Errors
///
/// Returns [`maia_core::mcp::StdioError::Containment`] when containment is unready.
pub fn launch_stdio(
    containment_ready: bool,
    command: &str,
    args: &[String],
) -> Result<(), maia_core::mcp::StdioError<std::io::Error>> {
    maia_core::mcp::open_stdio(containment_ready, || {
        std::process::Command::new(command)
            .args(args)
            .spawn()
            .map(|_| ())
    })
}

fn accepted_protocol(version: &str) -> bool {
    ACCEPTED_PROTOCOLS.contains(&version)
}

fn json_message(body: &str) -> Result<String, ClientError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return Ok(trimmed.to_owned());
    }
    for line in trimmed.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.starts_with('{') {
            return Ok(data.to_owned());
        }
    }
    Err(ClientError::Protocol)
}

fn remote_tool(value: &Value) -> Result<RemoteTool, ClientError> {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or(ClientError::Protocol)?;
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let schema = value
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| json!({"type": "object"}));
    Ok(RemoteTool {
        name: name.to_owned(),
        description,
        input_schema: schema.to_string(),
    })
}

fn tool_part(value: &Value) -> ToolPart {
    let kind = value.get("type").and_then(Value::as_str);
    if kind == Some("text") {
        return ToolPart::Text(
            value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        );
    }
    if kind == Some("image") {
        let data = value.get("data").and_then(Value::as_str).unwrap_or("");
        if !data.is_empty() && data.len() <= 1_500_000 {
            return ToolPart::Image {
                png_base64: data.to_owned(),
            };
        }
    }
    let byte_len = value
        .get("data")
        .and_then(Value::as_str)
        .map(|data| u64::try_from(data.len()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    ToolPart::Binary { byte_len }
}
