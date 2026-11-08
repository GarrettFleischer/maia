use crate::mcp::manifest::manifest_hash;

/// Whether an MCP exchange finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpExchangeClass {
    /// The request was not written, or it failed before it was written.
    KnownFailure,
    /// A complete response arrived.
    KnownResult,
    /// The request was written and no complete response arrived.
    Unknown,
}

/// One content part from `tools/call`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolPart {
    /// Text the model may read after redaction.
    Text(String),
    /// Binary content that stays out of the prompt.
    Binary {
        /// Byte length reported by the server.
        byte_len: u64,
    },
    /// PNG bytes already encoded as base64.
    Image {
        /// Base64 PNG.
        png_base64: String,
    },
}

/// A secret value the host already resolved and wants removed from text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretNeedle<'a>(pub &'a str);

/// Audit fields for one MCP call. Arguments and result bodies are absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpAuditRecord {
    /// Connection id.
    pub connection_id: String,
    /// Wire name.
    pub wire_name: String,
    /// Admitted manifest hash.
    pub manifest_hash: String,
    /// Exchange class name.
    pub exchange_class: &'static str,
    /// SHA-256 of the redacted result text.
    pub result_sha256: String,
}

/// Classifies an exchange from whether the request was written and completed.
#[must_use]
pub fn classify_mcp_exchange(sent: bool, completed: bool) -> McpExchangeClass {
    match (sent, completed) {
        (true, true) => McpExchangeClass::KnownResult,
        (true, false) => McpExchangeClass::Unknown,
        (false, _) => McpExchangeClass::KnownFailure,
    }
}

/// Joins text parts and replaces binary parts with a fixed sentence.
#[must_use]
pub fn render_tool_result(parts: &[ToolPart]) -> String {
    let mut out = String::new();
    for part in parts {
        match part {
            ToolPart::Text(text) => out.push_str(text),
            ToolPart::Binary { .. } => {
                out.push_str("The tool returned binary content and it was omitted.");
            }
            ToolPart::Image { .. } => out.push_str("The tool returned an image.")
        }
    }
    out
}

/// Replaces each non-empty needle with `[redacted]`. Longer needles are applied first.
#[must_use]
pub fn redact_secret_needles(text: &str, needles: &[SecretNeedle<'_>]) -> String {
    let mut ordered: Vec<&str> = needles
        .iter()
        .map(|needle| needle.0)
        .filter(|needle| !needle.is_empty())
        .collect();
    ordered.sort_by_key(|needle| std::cmp::Reverse(needle.len()));
    let mut out = text.to_owned();
    for needle in ordered {
        out = out.replace(needle, "[redacted]");
    }
    out
}

/// Caps text at 65_536 bytes and appends a truncation marker when it cuts.
#[must_use]
pub fn bound_tool_text(text: &str) -> String {
    const MAX_RESULT_BYTES: usize = 65_536;
    if text.len() <= MAX_RESULT_BYTES {
        return text.to_owned();
    }
    let mut end = MAX_RESULT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = text[..end].to_owned();
    out.push_str("\n[truncated]");
    out
}

/// Builds an audit row from the redacted result. The result body is not stored.
#[must_use]
pub fn mcp_audit_record(
    connection_id: &str,
    wire_name: &str,
    manifest_hash_text: &str,
    class: McpExchangeClass,
    redacted_result: &str,
) -> McpAuditRecord {
    McpAuditRecord {
        connection_id: connection_id.to_owned(),
        wire_name: wire_name.to_owned(),
        manifest_hash: manifest_hash_text.to_owned(),
        exchange_class: class_name(class),
        result_sha256: manifest_hash(redacted_result),
    }
}

fn class_name(class: McpExchangeClass) -> &'static str {
    match class {
        McpExchangeClass::KnownFailure => "known_failure",
        McpExchangeClass::KnownResult => "known_result",
        McpExchangeClass::Unknown => "unknown",
    }
}
