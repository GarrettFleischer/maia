//! Tool-call validation against canonical tools JSON.

use std::collections::BTreeSet;

use crate::router::error::RouterError;
use crate::router::json::{is_json_object, read_string_field};
use crate::router::types::NormalizedToolCall;

fn protocol(detail: impl Into<String>) -> RouterError {
    RouterError::Protocol {
        detail: detail.into(),
    }
}

/// Extracts registered tool names from canonical tools JSON.
pub fn registered_tool_names(tools_json: &str) -> Result<BTreeSet<String>, RouterError> {
    if !tools_json.trim().starts_with('[') {
        return Err(protocol("tools_json must be an array"));
    }
    let mut names = BTreeSet::new();
    let mut search_from = 0usize;
    while let Some(found) = tools_json[search_from..].find("\"name\"") {
        let absolute = search_from + found;
        let window_start = absolute.saturating_sub(80);
        let window_end = (absolute + 120).min(tools_json.len());
        let window = &tools_json[window_start..window_end];
        if let Some(name) = read_string_field(window, "name") {
            names.insert(name);
        }
        search_from = absolute + 6;
    }
    if names.is_empty() {
        return Err(protocol("tools_json missing function names"));
    }
    Ok(names)
}

/// Validates normalized tool calls against canonical tools JSON.
///
/// Unknown tool *names* are allowed through so the host can answer with a normal
/// tool error and the model can recover. Duplicate ids and non-object arguments
/// still fail the completion.
pub fn validate_tool_calls(
    tools_json: &str,
    calls: &[NormalizedToolCall],
) -> Result<(), RouterError> {
    if calls.is_empty() {
        return Ok(());
    }
    // Ensure tools_json is well-formed even when we do not reject unknown names.
    let _allowed = registered_tool_names(tools_json)?;
    let mut seen_ids = BTreeSet::new();
    for call in calls {
        if !seen_ids.insert(call.id.as_str()) {
            return Err(protocol("duplicate tool call id"));
        }
        if !is_json_object(&call.arguments_json) {
            return Err(protocol("tool arguments must be a JSON object"));
        }
    }
    Ok(())
}
