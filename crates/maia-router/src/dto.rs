//! Private OpenAI-compatible response DTOs (reserved for adapter-side decoding extensions).

#![allow(dead_code)]

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub(crate) struct ChatCompletionResponse {
    pub id: Option<String>,
    pub choices: Vec<Choice>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Choice {
    pub finish_reason: Option<String>,
    pub message: Option<Message>,
    pub delta: Option<Message>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Message {
    pub content: Option<String>,
    pub reasoning: Option<String>,
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ToolCall {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub call_type: Option<String>,
    pub function: Option<FunctionCall>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FunctionCall {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Usage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub prompt_tokens_details: Option<PromptDetails>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PromptDetails {
    pub cached_tokens: Option<u64>,
}
