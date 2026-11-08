//! SSE stream normalization.

use std::collections::BTreeMap;

use crate::audit::RequestId;
use crate::router::error::RouterError;
use crate::router::json::{first_choice_object, is_json_object, read_string_field, read_u64_field};
use crate::router::limits::{
    MAX_SSE_ACCUMULATED_REASONING_BYTES, MAX_SSE_ACCUMULATED_REPLY_BYTES,
    MAX_SSE_LINE_BUFFER_BYTES, MAX_TOOL_ARGUMENTS_BYTES, ensure_within_limit,
};
use crate::router::normalize::{
    extract_balanced_array, extract_balanced_object, parse_finish_reason,
};
use crate::router::types::{
    FinishReason, NormalizedToolCall, RouterCapabilities, RouterResponse, RouterUsage, ToolCallId,
    ToolCallName, UsageValue,
};

fn protocol(detail: impl Into<String>) -> RouterError {
    RouterError::Protocol {
        detail: detail.into(),
    }
}

#[derive(Debug, Default, Clone)]
struct PartialToolCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

/// Incrementally assembles one SSE completion stream.
pub struct RouterSseAssembler {
    request_id: RequestId,
    capabilities: RouterCapabilities,
    line_buffer: String,
    content: String,
    reasoning: Option<String>,
    tool_calls: BTreeMap<usize, PartialToolCall>,
    usage: RouterUsage,
    finish: Option<FinishReason>,
    provider_response_id: Option<String>,
    done_seen: bool,
    saw_payload: bool,
}

impl RouterSseAssembler {
    /// Starts a new SSE assembler for one request.
    pub fn new(request_id: RequestId, capabilities: RouterCapabilities) -> Self {
        Self {
            request_id,
            capabilities,
            line_buffer: String::new(),
            content: String::new(),
            reasoning: None,
            tool_calls: BTreeMap::new(),
            usage: RouterUsage {
                input_tokens: UsageValue::Unavailable,
                output_tokens: UsageValue::Unavailable,
                cached_input_tokens: UsageValue::Unavailable,
            },
            finish: None,
            provider_response_id: None,
            done_seen: false,
            saw_payload: false,
        }
    }

    /// Appends one chunk that may contain partial SSE lines.
    pub fn push_line(&mut self, chunk: &str) -> Result<(), RouterError> {
        ensure_within_limit(
            self.line_buffer.len(),
            chunk.len(),
            MAX_SSE_LINE_BUFFER_BYTES,
            "sse_line_buffer",
        )?;
        self.line_buffer.push_str(chunk);
        while let Some(newline) = self.line_buffer.find('\n') {
            let mut line = self.line_buffer[..newline].to_owned();
            self.line_buffer.drain(..=newline);
            if line.ends_with('\r') {
                line.pop();
            }
            self.process_line(&line)?;
        }
        Ok(())
    }

    /// Finishes the stream and returns the normalized response.
    pub fn finish(mut self) -> Result<RouterResponse, RouterError> {
        if !self.line_buffer.is_empty() {
            let mut trailing = self.line_buffer.trim_end().to_owned();
            self.line_buffer.clear();
            if trailing.ends_with('\r') {
                trailing.pop();
            }
            if !trailing.is_empty() {
                self.process_line(&trailing)?;
            }
        }
        if !self.saw_payload {
            return Err(RouterError::IncompleteStream);
        }
        if !self.done_seen {
            return Err(RouterError::IncompleteStream);
        }
        let tool_calls = self.finalize_tool_calls()?;
        let finish = self.finish.ok_or(RouterError::IncompleteStream)?;
        Ok(RouterResponse {
            request_id: self.request_id,
            provider_response_id: self.provider_response_id,
            reasoning: self.reasoning.clone(),
            tool_calls,
            reply: if self.content.is_empty() {
                None
            } else {
                Some(self.content.clone())
            },
            usage: self.usage,
            finish,
        })
    }

    fn process_line(&mut self, line: &str) -> Result<(), RouterError> {
        if line.is_empty() || line.starts_with(':') {
            return Ok(());
        }
        let Some(payload) = line.strip_prefix("data:").map(str::trim) else {
            return Err(protocol("unsupported sse line"));
        };
        if payload == "[DONE]" {
            self.done_seen = true;
            return Ok(());
        }
        if payload.starts_with('{') {
            self.saw_payload = true;
            self.merge_payload(payload)?;
            return Ok(());
        }
        Err(protocol("sse data payload must be json or [DONE]"))
    }

    fn merge_payload(&mut self, payload: &str) -> Result<(), RouterError> {
        if let Some(id) = read_string_field(payload, "id") {
            self.provider_response_id = Some(id);
        }
        if let Some(prompt) = read_u64_field(payload, "prompt_tokens") {
            self.usage.input_tokens = UsageValue::Reported(prompt);
        }
        if let Some(completion) = read_u64_field(payload, "completion_tokens") {
            self.usage.output_tokens = UsageValue::Reported(completion);
        }
        if self.capabilities.cached_token_usage
            && let Some(details_start) = payload.find("\"prompt_tokens_details\"")
        {
            let window = &payload[details_start..];
            if let Some(cached) = read_u64_field(window, "cached_tokens") {
                self.usage.cached_input_tokens = UsageValue::Reported(cached);
            }
        }
        if !payload.contains("\"choices\"") {
            return Ok(());
        }
        let choice = first_choice_object(payload)?;
        if read_string_field(&choice, "finish_reason").is_some() {
            self.finish = Some(parse_finish_reason(&choice)?);
        }
        let delta_or_message = if choice.contains("\"delta\"") {
            let delta_start = choice
                .find("\"delta\"")
                .ok_or_else(|| protocol("missing delta"))?;
            extract_balanced_object(&choice[delta_start..])?
        } else {
            crate::router::json::message_object(&choice)?
        };
        if self.capabilities.readable_reasoning
            && let Some(delta_reason) = crate::router::json::read_reasoning_text(&delta_or_message)
        {
            let combined = match self.reasoning.take() {
                Some(existing) => format!("{existing}{delta_reason}"),
                None => delta_reason,
            };
            ensure_within_limit(
                0,
                combined.len(),
                MAX_SSE_ACCUMULATED_REASONING_BYTES,
                "reasoning",
            )?;
            self.reasoning = Some(combined);
        }
        if let Some(delta) = read_string_field(&delta_or_message, "content") {
            ensure_within_limit(
                self.content.len(),
                delta.len(),
                MAX_SSE_ACCUMULATED_REPLY_BYTES,
                "reply",
            )?;
            self.content.push_str(&delta);
        }
        self.merge_tool_deltas(&delta_or_message)
    }

    fn merge_tool_deltas(&mut self, object: &str) -> Result<(), RouterError> {
        let Some(start) = object.find("\"tool_calls\"") else {
            return Ok(());
        };
        let after = &object[start..];
        let open = after
            .find('[')
            .ok_or_else(|| protocol("missing tool_calls array"))?;
        let array = extract_balanced_array(&after[open..])?;
        let mut search = 0usize;
        while let Some(obj_start) = array[search..].find('{') {
            let absolute = search + obj_start;
            let fragment = extract_balanced_object(&array[absolute..])?;
            search = absolute + fragment.len();
            let index = read_u64_field(&fragment, "index").unwrap_or(0) as usize;
            let entry = self.tool_calls.entry(index).or_default();
            if let Some(id) = read_string_field(&fragment, "id") {
                entry.id = Some(id);
            }
            if let Some(function_start) = fragment.find("\"function\"") {
                let function = extract_balanced_object(&fragment[function_start..])?;
                if let Some(name) = read_string_field(&function, "name") {
                    entry.name = Some(name);
                }
                if let Some(args) = read_string_field(&function, "arguments") {
                    ensure_within_limit(
                        entry.arguments.len(),
                        args.len(),
                        MAX_TOOL_ARGUMENTS_BYTES,
                        "tool_arguments",
                    )?;
                    entry.arguments.push_str(&args);
                }
            }
        }
        Ok(())
    }

    fn finalize_tool_calls(&self) -> Result<Vec<NormalizedToolCall>, RouterError> {
        if self.tool_calls.is_empty() {
            return Ok(Vec::new());
        }
        let mut calls = Vec::new();
        for partial in self.tool_calls.values() {
            let id = partial.id.clone().ok_or(RouterError::IncompleteStream)?;
            let name = partial.name.clone().ok_or(RouterError::IncompleteStream)?;
            if !is_json_object(&partial.arguments) {
                return Err(RouterError::IncompleteStream);
            }
            calls.push(NormalizedToolCall {
                id: ToolCallId::new(id),
                name: ToolCallName::new(name),
                arguments_json: partial.arguments.clone(),
            });
        }
        Ok(calls)
    }
}
