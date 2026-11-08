//! Canonical Super Agent field validation shared by writes and restart reconstruction.

use std::fmt;

use crate::limits::MAX_PROSE_BYTES;
use crate::limits::MAX_THREAD_EVENT_BODY_BYTES;

/// Maximum durable helper nesting accepted by writes and restart.
pub const MAX_RUNTIME_CHILD_DEPTH: i64 = 64;

/// Whether one bounded canonical text field may be empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalTextRequirement {
    /// Empty text is valid.
    AllowEmpty,
    /// At least one byte is required.
    Nonempty,
}

/// Public-safe canonical field validation failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuperAgentCanonicalError {
    field: &'static str,
}

impl SuperAgentCanonicalError {
    fn new(field: &'static str) -> Self {
        Self { field }
    }
}

impl fmt::Display for SuperAgentCanonicalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} is not canonical", self.field)
    }
}

impl std::error::Error for SuperAgentCanonicalError {}

/// Validates one text field against its canonical emptiness and byte limit.
pub fn validate_canonical_text(
    field: &'static str,
    value: &str,
    requirement: CanonicalTextRequirement,
) -> Result<(), SuperAgentCanonicalError> {
    if value.len() > MAX_PROSE_BYTES
        || (matches!(requirement, CanonicalTextRequirement::Nonempty) && value.is_empty())
    {
        return Err(SuperAgentCanonicalError::new(field));
    }
    Ok(())
}

/// Validates one bounded binary field.
pub fn validate_canonical_blob(
    field: &'static str,
    value: &[u8],
) -> Result<(), SuperAgentCanonicalError> {
    if value.len() > MAX_THREAD_EVENT_BODY_BYTES {
        return Err(SuperAgentCanonicalError::new(field));
    }
    Ok(())
}

/// Validates a router transcript message stored for restart.
pub fn validate_router_message_contract(
    message_id: &str,
    role: &str,
    body: &str,
) -> Result<(), SuperAgentCanonicalError> {
    validate_canonical_text("message id", message_id, CanonicalTextRequirement::Nonempty)?;
    if !matches!(role, "user" | "assistant") {
        return Err(SuperAgentCanonicalError::new("router message role"));
    }
    validate_canonical_text(
        "router message body",
        body,
        CanonicalTextRequirement::AllowEmpty,
    )
}

/// Validates the durable pin encoding.
pub fn validate_pin_contract(pin: &str) -> Result<(), SuperAgentCanonicalError> {
    if matches!(pin, "pinned" | "unpinned") {
        Ok(())
    } else {
        Err(SuperAgentCanonicalError::new("task pin"))
    }
}

/// Validates the durable completion-view encoding.
pub fn validate_completion_view_contract(view: &str) -> Result<(), SuperAgentCanonicalError> {
    if matches!(view, "unopened" | "closed_once") {
        return Ok(());
    }
    let detail = view
        .strip_prefix("open:")
        .ok_or_else(|| SuperAgentCanonicalError::new("completion view"))?;
    validate_canonical_text(
        "detail session id",
        detail,
        CanonicalTextRequirement::Nonempty,
    )
}

/// Validates the durable task/child phase encoding without interpreting domain transitions.
pub fn validate_phase_contract(phase: &str) -> Result<(), SuperAgentCanonicalError> {
    validate_canonical_text("task phase", phase, CanonicalTextRequirement::Nonempty)?;
    let fields = decode_canonical_fields(phase)?;
    let valid = match fields.as_slice() {
        [tag] => matches!(tag.as_str(), "queued"),
        [tag, field] if !field.is_empty() => match tag.as_str() {
            "running" | "blocked" | "completed" | "abandoned" => true,
            "cancelled" | "stopped" => field.parse::<u64>().is_ok_and(|id| id != 0),
            "waiting" => matches!(field.as_str(), "clarification" | "transcript_budget"),
            _ => false,
        },
        [tag, kind, field] if !field.is_empty() => match (tag.as_str(), kind.as_str()) {
            ("failed", "worker_reported" | "budget_exhausted" | "attempt_failed") => true,
            ("waiting", "question" | "waiver" | "settled") => true,
            ("waiting", "approval") => field.parse::<u64>().is_ok(),
            _ => false,
        },
        [tag, kind, attempt, call]
            if tag == "waiting" && kind == "unknown" && !attempt.is_empty() && !call.is_empty() =>
        {
            true
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(SuperAgentCanonicalError::new("task phase"))
    }
}

/// Decodes colon-delimited canonical fields with strict uppercase percent escapes.
pub fn decode_canonical_fields(value: &str) -> Result<Vec<String>, SuperAgentCanonicalError> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '%' {
            let hi = chars
                .next()
                .ok_or_else(|| SuperAgentCanonicalError::new("task phase"))?;
            let lo = chars
                .next()
                .ok_or_else(|| SuperAgentCanonicalError::new("task phase"))?;
            current.push(char::from(phase_hex_byte(hi, lo)?));
        } else if ch == ':' {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    Ok(fields)
}

fn phase_hex_byte(hi: char, lo: char) -> Result<u8, SuperAgentCanonicalError> {
    Ok(phase_hex_nibble(hi)? << 4 | phase_hex_nibble(lo)?)
}

fn phase_hex_nibble(ch: char) -> Result<u8, SuperAgentCanonicalError> {
    match ch {
        '0'..='9' => u8::try_from(u32::from(ch) - u32::from('0'))
            .map_err(|_| SuperAgentCanonicalError::new("task phase")),
        'A'..='F' => u8::try_from(u32::from(ch) - u32::from('A') + 10)
            .map_err(|_| SuperAgentCanonicalError::new("task phase")),
        _ => Err(SuperAgentCanonicalError::new("task phase")),
    }
}

/// Validates sealed envelope bytes and canonical metadata.
pub fn validate_envelope_contract(
    prompt: &[u8],
    brief: &str,
    routing_reason: &str,
    snapshot_id: &str,
) -> Result<(), SuperAgentCanonicalError> {
    validate_canonical_blob("task prompt", prompt)?;
    if brief != "advisory" {
        return Err(SuperAgentCanonicalError::new("task brief"));
    }
    if !matches!(routing_reason, "create_task" | "create_linked") {
        return Err(SuperAgentCanonicalError::new("routing reason"));
    }
    validate_canonical_text(
        "context snapshot id",
        snapshot_id,
        CanonicalTextRequirement::Nonempty,
    )
}

/// Validates one advisory context row.
pub fn validate_context_item_contract(
    memory_id: &str,
    provenance: &str,
    trust: &str,
    sentence: &str,
) -> Result<(), SuperAgentCanonicalError> {
    validate_canonical_text(
        "context memory id",
        memory_id,
        CanonicalTextRequirement::Nonempty,
    )?;
    validate_canonical_text(
        "context provenance",
        provenance,
        CanonicalTextRequirement::Nonempty,
    )?;
    if !valid_context_provenance(provenance) {
        return Err(SuperAgentCanonicalError::new("context provenance"));
    }
    if !matches!(trust, "trusted" | "untrusted") {
        return Err(SuperAgentCanonicalError::new("context trust"));
    }
    validate_canonical_text(
        "context sentence",
        sentence,
        CanonicalTextRequirement::AllowEmpty,
    )
}

fn valid_context_provenance(provenance: &str) -> bool {
    if let Some(id) = provenance.strip_prefix("fact:") {
        return !id.is_empty();
    }
    if let Some(id) = provenance.strip_prefix("claim:") {
        return !id.is_empty();
    }
    provenance
        .strip_prefix("episode:")
        .and_then(|value| value.split_once(":thread:"))
        .is_some_and(|(episode, thread)| !episode.is_empty() && !thread.is_empty())
}

/// Validates one child assignment payload.
pub fn validate_child_contract(
    child_id: &str,
    parent_task_id: &str,
    depth: i64,
    subgoal: &[u8],
    budget_tokens: i64,
    budget_turns: i64,
) -> Result<(), SuperAgentCanonicalError> {
    validate_canonical_text("child id", child_id, CanonicalTextRequirement::Nonempty)?;
    validate_canonical_text(
        "child parent id",
        parent_task_id,
        CanonicalTextRequirement::Nonempty,
    )?;
    validate_canonical_blob("child subgoal", subgoal)?;
    if subgoal.is_empty() || std::str::from_utf8(subgoal).is_err() {
        return Err(SuperAgentCanonicalError::new("child subgoal"));
    }
    if !(1..=MAX_RUNTIME_CHILD_DEPTH).contains(&depth) {
        return Err(SuperAgentCanonicalError::new("child depth"));
    }
    if budget_tokens < 0 || budget_turns < 0 {
        return Err(SuperAgentCanonicalError::new("child budget"));
    }
    Ok(())
}

/// Validates one criterion against its exact source bytes.
pub fn validate_criterion_contract(
    criterion_id: &str,
    source_kind: &str,
    source_ref: &str,
    span_start: Option<i64>,
    span_end: Option<i64>,
    text: &str,
    source_bytes: Option<&[u8]>,
) -> Result<(), SuperAgentCanonicalError> {
    validate_canonical_text(
        "criterion id",
        criterion_id,
        CanonicalTextRequirement::Nonempty,
    )?;
    validate_canonical_text(
        "criterion source",
        source_ref,
        CanonicalTextRequirement::Nonempty,
    )?;
    validate_canonical_text("criterion text", text, CanonicalTextRequirement::Nonempty)?;
    match source_kind {
        "user_text" => {
            let start = span_start
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| SuperAgentCanonicalError::new("criterion span"))?;
            let end = span_end
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| SuperAgentCanonicalError::new("criterion span"))?;
            let source =
                source_bytes.ok_or_else(|| SuperAgentCanonicalError::new("criterion source"))?;
            let cited = source
                .get(start..end)
                .ok_or_else(|| SuperAgentCanonicalError::new("criterion span"))?;
            if cited != text.as_bytes() {
                return Err(SuperAgentCanonicalError::new("criterion text"));
            }
            Ok(())
        }
        "binding_rule" | "accepted_decision"
            if span_start.is_none() && span_end.is_none() && source_bytes.is_none() =>
        {
            Ok(())
        }
        _ => Err(SuperAgentCanonicalError::new("criterion source kind")),
    }
}
