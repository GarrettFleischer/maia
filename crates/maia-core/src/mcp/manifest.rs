use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

/// One tool returned by `tools/list`, before admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedTool {
    /// Server tool name.
    pub name: String,
    /// Untrusted description.
    pub description: String,
    /// JSON schema text.
    pub input_schema: String,
}

/// One tool a subagent may call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveTool {
    /// Name placed in the model tool list.
    pub wire_name: String,
    /// Name sent to the MCP server.
    pub server_tool: String,
    /// Description shown to the subagent.
    pub description: String,
    /// Pinned JSON schema text.
    pub input_schema: String,
}

/// Canonical manifest plus the wire names it admits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedManifest {
    /// Sorted compact JSON.
    pub canonical: String,
    /// SHA-256 hex of [`PreparedManifest::canonical`].
    pub hash: String,
    /// Wire names in tool order after the name sort.
    pub wire_names: Vec<String>,
}

/// Why a manifest or wire name was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestError {
    /// The connection id is not a short lowercase slug.
    ConnectionId,
    /// A tool name is empty or outside the allowed character set.
    ToolName,
    /// Two tools share a name.
    DuplicateName,
    /// The schema text is not JSON.
    Schema,
    /// The list has more than 32 tools.
    TooMany,
    /// The canonical JSON exceeds 32_768 bytes.
    TooLarge,
}

/// Sorts tools and emits compact JSON with sorted object keys.
///
/// # Errors
///
/// Returns [`ManifestError::DuplicateName`] or [`ManifestError::Schema`].
pub fn canonical_manifest(tools: &[ListedTool]) -> Result<String, ManifestError> {
    let mut ordered: Vec<&ListedTool> = tools.iter().collect();
    ordered.sort_by(|left, right| left.name.cmp(&right.name));
    for pair in ordered.windows(2) {
        if pair[0].name == pair[1].name {
            return Err(ManifestError::DuplicateName);
        }
    }
    let mut values = Vec::with_capacity(ordered.len());
    for tool in ordered {
        let schema = serde_json::from_str::<Value>(&tool.input_schema)
            .map_err(|_| ManifestError::Schema)?;
        let mut map = Map::new();
        map.insert("description".to_owned(), Value::String(tool.description.clone()));
        map.insert("inputSchema".to_owned(), schema);
        map.insert("name".to_owned(), Value::String(tool.name.clone()));
        values.push(Value::Object(map));
    }
    let mut out = String::new();
    write_value(&Value::Array(values), &mut out);
    Ok(out)
}

/// SHA-256 hex of `bytes` interpreted as UTF-8 text.
#[must_use]
pub fn manifest_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push(hex_digit(byte >> 4));
        hex.push(hex_digit(byte & 0x0f));
    }
    hex
}

/// Builds `{connection_id}__{tool_name}` when both names are in range.
///
/// # Errors
///
/// Returns [`ManifestError::ConnectionId`] or [`ManifestError::ToolName`].
pub fn wire_name(connection_id: &str, tool_name: &str) -> Result<String, ManifestError> {
    if !valid_connection_id(connection_id) {
        return Err(ManifestError::ConnectionId);
    }
    if !valid_tool_name(tool_name) {
        return Err(ManifestError::ToolName);
    }
    let wire = format!("{connection_id}__{tool_name}");
    if wire.len() > 64 {
        return Err(ManifestError::ToolName);
    }
    Ok(wire)
}

/// Checks listing limits and returns the hash the owner can admit.
///
/// # Errors
///
/// Returns a [`ManifestError`] when the id, names, count, schema, or size fail.
pub fn prepare_manifest(
    connection_id: &str,
    tools: &[ListedTool],
) -> Result<PreparedManifest, ManifestError> {
    if tools.len() > 32 {
        return Err(ManifestError::TooMany);
    }
    let mut wire_names = Vec::with_capacity(tools.len());
    for tool in tools {
        wire_names.push(wire_name(connection_id, &tool.name)?);
    }
    let canonical = canonical_manifest(tools)?;
    if canonical.len() > 32_768 {
        return Err(ManifestError::TooLarge);
    }
    wire_names.sort();
    Ok(PreparedManifest {
        hash: manifest_hash(&canonical),
        canonical,
        wire_names,
    })
}

/// OpenAI function-list JSON for the live wire names.
#[must_use]
pub fn worker_tools_json(live: &[LiveTool]) -> String {
    let mut ordered: Vec<&LiveTool> = live.iter().collect();
    ordered.sort_by(|left, right| left.wire_name.cmp(&right.wire_name));
    let mut tools = Vec::with_capacity(ordered.len());
    for tool in ordered {
        let parameters = serde_json::from_str::<Value>(&tool.input_schema)
            .unwrap_or_else(|_| serde_json::json!({"type": "object"}));
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": tool.wire_name,
                "description": tool.description,
                "parameters": parameters,
            }
        }));
    }
    serde_json::Value::Array(tools).to_string()
}

/// Returns whether `id` matches `^[a-z][a-z0-9_-]{0,13}$`.
#[must_use]
pub fn valid_connection_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    let mut count = 1usize;
    for ch in chars {
        if count == 14 {
            return false;
        }
        if !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-') {
            return false;
        }
        count += 1;
    }
    true
}

/// Returns whether `label` is non-empty, at most 80 bytes, and free of control characters.
#[must_use]
pub fn valid_owner_label(label: &str) -> bool {
    !label.is_empty() && label.len() <= 80 && !label.chars().any(char::is_control)
}

/// Returns whether a header or environment name matches `^[A-Za-z0-9-]{1,64}$`.
#[must_use]
pub fn valid_secret_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=64).contains(&count)
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

/// Returns whether a stdio command and its arguments fit the launch limits.
#[must_use]
pub fn valid_stdio_launch(command: &str, args: &[String]) -> bool {
    !command.is_empty()
        && command.len() <= 256
        && !command.chars().any(char::is_control)
        && args.len() <= 32
        && args
            .iter()
            .all(|arg| arg.len() <= 512 && !arg.chars().any(char::is_control))
}

fn valid_tool_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=48).contains(&count)
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn hex_digit(value: u8) -> char {
    char::from(b"0123456789abcdef"[usize::from(value)])
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number.to_string()),
        Value::String(text) => push_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                push_string(key, out);
                out.push(':');
                write_value(&map[*key], out);
            }
            out.push('}');
        }
    }
}

fn push_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if control.is_control() => {
                let encoded = u32::from(control);
                out.push_str(&format!("\\u{encoded:04x}"));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}
