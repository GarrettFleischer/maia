//! JSON completion normalization.

use crate::audit::RequestId;
use crate::router::error::RouterError;
use crate::router::json::{
    first_choice_object, is_json_object, message_object, read_reasoning_text, read_string_field,
    read_u64_field,
};
use crate::router::tools::validate_tool_calls;
use crate::router::types::{
    FinishReason, NormalizedToolCall, RouterCapabilities, RouterResponse, RouterUsage, ToolCallId,
    ToolCallName, UsageValue,
};

fn protocol(detail: impl Into<String>) -> RouterError {
    RouterError::Protocol {
        detail: detail.into(),
    }
}

/// Normalizes one OpenAI-compatible chat completion JSON body.
pub fn normalize_router_json(
    body: &str,
    request_id: RequestId,
    capabilities: &RouterCapabilities,
) -> Result<RouterResponse, RouterError> {
    let trimmed = body.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') {
        return Err(protocol("body must be a JSON object"));
    }
    let choice = first_choice_object(trimmed)?;
    let message = message_object(&choice)?;
    let finish = parse_finish_reason(&choice)?;
    let reasoning = if capabilities.readable_reasoning {
        read_reasoning_text(&message)
    } else {
        None
    };
    let reply = read_string_field(&message, "content");
    let tool_calls = parse_tool_calls(&message)?;
    let usage = parse_usage(trimmed, capabilities);
    let response = RouterResponse {
        request_id,
        provider_response_id: read_string_field(trimmed, "id"),
        reasoning,
        tool_calls: tool_calls.clone(),
        reply,
        usage,
        finish,
    };
    if !tool_calls.is_empty() && !capabilities.tool_calls {
        return Err(protocol("tool calls unsupported for this provider"));
    }
    Ok(response)
}

pub(crate) fn parse_finish_reason(choice: &str) -> Result<FinishReason, RouterError> {
    let reason = read_string_field(choice, "finish_reason").unwrap_or_else(|| "stop".to_owned());
    Ok(match reason.as_str() {
        "stop" => FinishReason::Stop,
        "tool_calls" => FinishReason::ToolCalls,
        "length" => FinishReason::Length,
        _ => FinishReason::Other,
    })
}

fn parse_usage(body: &str, capabilities: &RouterCapabilities) -> RouterUsage {
    let input = read_u64_field(body, "prompt_tokens")
        .map(UsageValue::Reported)
        .unwrap_or(UsageValue::Unavailable);
    let output = read_u64_field(body, "completion_tokens")
        .map(UsageValue::Reported)
        .unwrap_or(UsageValue::Unavailable);
    let cached = if capabilities.cached_token_usage {
        read_cached_tokens(body)
    } else {
        UsageValue::Unavailable
    };
    RouterUsage {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached,
    }
}

fn read_cached_tokens(body: &str) -> UsageValue {
    if let Some(details_start) = body.find("\"prompt_tokens_details\"") {
        let window = &body[details_start..details_start.saturating_add(120).min(body.len())];
        if let Some(value) = read_u64_field(window, "cached_tokens") {
            return UsageValue::Reported(value);
        }
    }
    UsageValue::Unavailable
}

fn parse_tool_calls(message: &str) -> Result<Vec<NormalizedToolCall>, RouterError> {
    let Some(start) = message.find("\"tool_calls\"") else {
        return Ok(Vec::new());
    };
    let after = &message[start..];
    let open = after
        .find('[')
        .ok_or_else(|| protocol("missing tool_calls array"))?;
    let array_body = extract_balanced_array(&after[open..])?;
    let mut calls = Vec::new();
    let mut search = 0usize;
    while let Some(obj_start) = array_body[search..].find('{') {
        let absolute = search + obj_start;
        let object = extract_balanced_object(&array_body[absolute..])?;
        search = absolute + object.len();
        let id =
            read_string_field(&object, "id").ok_or_else(|| protocol("tool call missing id"))?;
        let function_key = object
            .find("\"function\"")
            .ok_or_else(|| protocol("tool call missing function"))?;
        let function = extract_balanced_object(&object[function_key..])?;
        let name = read_string_field(&function, "name")
            .ok_or_else(|| protocol("tool call missing name"))?;
        let arguments = read_string_field(&function, "arguments")
            .ok_or_else(|| protocol("tool call missing arguments"))?;
        if !is_json_object(&arguments) {
            return Err(protocol("tool arguments must be valid JSON object"));
        }
        calls.push(NormalizedToolCall {
            id: ToolCallId::new(id),
            name: ToolCallName::new(name),
            arguments_json: arguments,
        });
    }
    Ok(calls)
}

pub(crate) fn extract_balanced_array(text: &str) -> Result<String, RouterError> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (offset, byte) in text.bytes().enumerate() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            if byte == b'\\' {
                escape = true;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(text[..=offset].to_owned());
                }
            }
            _ => {}
        }
    }
    Err(protocol("unterminated tool_calls array"))
}

pub(crate) fn extract_balanced_object(text: &str) -> Result<String, RouterError> {
    let start = text.find('{').ok_or_else(|| protocol("missing object"))?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (offset, byte) in text[start..].bytes().enumerate() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            if byte == b'\\' {
                escape = true;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(text[start..start + offset + 1].to_owned());
                }
            }
            _ => {}
        }
    }
    Err(protocol("unterminated object"))
}

/// Validates tool calls for a normalized JSON response using canonical tools JSON.
pub fn normalize_and_validate_json(
    body: &str,
    request_id: RequestId,
    capabilities: &RouterCapabilities,
    tools_json: &str,
) -> Result<RouterResponse, RouterError> {
    let response = normalize_router_json(body, request_id, capabilities)?;
    validate_tool_calls(tools_json, &response.tool_calls)?;
    Ok(response)
}
