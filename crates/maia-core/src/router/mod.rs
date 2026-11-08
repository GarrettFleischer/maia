//! OpenAI-compatible router port types and translation contracts (`08-rust.md`).

mod cancel;
mod config;
mod error;
mod json;
mod limits;
mod normalize;
mod port;
mod sse;
mod tools;
mod types;
mod url;

pub use cancel::{CancelRegistry, RequestCancelGuard, WaitForCancel};
pub use config::{configuration_error, validate_router_config};
pub use error::{RouterConfigError, RouterError, RouterFailureClass, classify_router_failure};
pub use json::read_string_field;
pub(crate) use json::is_json_object;
pub use limits::{
    BoundedResponseCollector, MAX_ROUTER_RESPONSE_BYTES, MAX_SSE_ACCUMULATED_REASONING_BYTES,
    MAX_SSE_ACCUMULATED_REPLY_BYTES, MAX_SSE_LINE_BUFFER_BYTES, MAX_TOOL_ARGUMENTS_BYTES,
    ResponseByteBudget, ensure_within_limit,
};
pub use normalize::{normalize_and_validate_json, normalize_router_json};
pub use port::Router;
pub use sse::RouterSseAssembler;
pub use tools::validate_tool_calls;
pub use types::{
    CanonicalJson, FinishReason, NormalizedToolCall, OpaqueTurnState, ReasoningEffort,
    RouterCapabilities, RouterConfig, RouterRequest, RouterResponse, RouterStreamMode, RouterUsage,
    ToolCallId, ToolCallName, TrailingInstructionPlacement, UsageValue,
};
