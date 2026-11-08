//! Router port value types.

use std::time::Duration;

use crate::audit::RequestId;
use crate::credit::PrefixHash;
use crate::thread_cache::ChatMessage;

/// Exact canonical tools JSON hashed into the durable prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalJson(pub String);

/// Provider-local tool state carried only on in-turn messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpaqueTurnState(pub Vec<u8>);

/// Reasoning depth requested for a completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningEffort {
    /// Low reasoning budget.
    Low,
    /// Medium reasoning budget.
    Medium,
    /// High reasoning budget.
    High,
}

/// How the adapter reads provider bodies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouterStreamMode {
    /// Single JSON response body.
    Json,
    /// Server-sent events stream.
    ServerSentEvents,
}

/// Where trailing recall and scratch instructions are placed on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrailingInstructionPlacement {
    /// Separate trailing system messages.
    TrailingSystem,
    /// One trailing user message part.
    TrailingUserPart,
}

/// Descriptive provider capability flags established at startup or first response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterCapabilities {
    /// Provider exposes readable reasoning text.
    pub readable_reasoning: bool,
    /// Provider supports tool calls in the agent loop.
    pub tool_calls: bool,
    /// Provider reports cached prompt token counts.
    pub cached_token_usage: bool,
    /// Where trailing instructions belong for this provider.
    pub trailing_instruction_placement: TrailingInstructionPlacement,
}

/// Static router endpoint configuration without secret material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterConfig {
    /// OpenAI-compatible base URL including `/v1` when required.
    pub base_url: String,
    /// Default model id sent when the request omits one.
    pub model: String,
    /// Per-request HTTP timeout.
    pub request_timeout: Duration,
    /// JSON or SSE response mode.
    pub stream_mode: RouterStreamMode,
    /// Trailing instruction placement for this provider.
    pub trailing_instruction_placement: TrailingInstructionPlacement,
}

/// Canonical outbound completion request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterRequest {
    /// Idempotency and cancellation identity.
    pub request_id: RequestId,
    /// Model id for this turn.
    pub model: String,
    /// Exact OpenAI-compatible messages array.
    pub messages: Vec<ChatMessage>,
    /// Canonical tools JSON from the durable prefix.
    pub tools_json: CanonicalJson,
    /// Hash of the durable compiled prefix.
    pub prefix_hash: PrefixHash,
    /// Hash of the recall pack when present.
    pub recall_hash: Option<PrefixHash>,
    /// Requested reasoning effort.
    pub reasoning_effort: ReasoningEffort,
    /// Output token cap for the provider.
    pub max_output_tokens: u32,
    /// Turn-local opaque provider tool state.
    pub prior_provider_tool_state: Option<OpaqueTurnState>,
}

/// Normalized provider tool-call identifier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ToolCallId(String);

impl ToolCallId {
    /// Builds an identifier from provider bytes.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed id string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Normalized tool name from the provider schema.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ToolCallName(String);

impl ToolCallName {
    /// Builds a tool name.
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    /// Borrowed name string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One executable tool call after normalization and validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedToolCall {
    /// Stable provider tool-call id.
    pub id: ToolCallId,
    /// Registered tool name.
    pub name: ToolCallName,
    /// Canonical JSON object arguments bytes.
    pub arguments_json: String,
}

/// Token usage with explicit availability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageValue {
    /// Provider reported an exact count.
    Reported(u64),
    /// Adapter estimated a count without guessing cached tokens.
    Estimated(u64),
    /// Field omitted by the provider.
    Unavailable,
}

/// Normalized token accounting for one completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouterUsage {
    /// Prompt or input tokens.
    pub input_tokens: UsageValue,
    /// Completion or output tokens.
    pub output_tokens: UsageValue,
    /// Cached prompt tokens when reported.
    pub cached_input_tokens: UsageValue,
}

/// Provider stop reason after normalization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    /// Model returned a final assistant message.
    Stop,
    /// Model emitted tool calls.
    ToolCalls,
    /// Output truncated by length.
    Length,
    /// Provider-specific or unknown stop reason mapped safely.
    Other,
}

/// Normalized completion body for one router turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterResponse {
    /// Caller request identity echoed back.
    pub request_id: RequestId,
    /// Provider response id when present.
    pub provider_response_id: Option<String>,
    /// Readable reasoning text when supported.
    pub reasoning: Option<String>,
    /// Ordered normalized tool calls.
    pub tool_calls: Vec<NormalizedToolCall>,
    /// Final assistant reply text when present.
    pub reply: Option<String>,
    /// Token usage with explicit unavailable fields.
    pub usage: RouterUsage,
    /// Stop reason for the completion.
    pub finish: FinishReason,
}
