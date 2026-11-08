//! Provider message mapping. This is the only leaf that builds wire messages.

use crate::agents::AgentId;
use crate::thread_cache::scratch::CompiledRequest;
use crate::thread_cache::types::{ChatRole, CompileError, SlotKind};

/// Where trailing recall, scratch, and speaker text are placed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlacementMode {
    /// Each trailing instruction is its own system message after the durable user message.
    TrailingSystem,
    /// Trailing instructions are concatenated into one user message.
    TrailingUserPart,
}

/// One provider message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    /// Wire role.
    pub role: ChatRole,
    /// Exact content bytes.
    pub content: String,
    /// Provider tool-call id when `role` is [`ChatRole::Tool`].
    pub tool_call_id: Option<String>,
    /// OpenAI `tool_calls` JSON when this assistant message invoked tools.
    pub tool_calls_json: Option<String>,
    /// PNG bytes, standard base64, attached as an image content part.
    pub image_png_base64: Option<String>,
}

impl ChatMessage {
    /// Text message with no tool payload.
    pub fn text(role: ChatRole, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            tool_call_id: None,
            tool_calls_json: None,
            image_png_base64: None,
        }
    }

    /// Assistant message that carries tool calls.
    pub fn assistant_tools(content: impl Into<String>, tool_calls_json: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Assistant,
            content: content.into(),
            tool_call_id: None,
            tool_calls_json: Some(tool_calls_json.into()),
            image_png_base64: None,
        }
    }

    /// Tool result, optionally with a PNG screenshot.
    pub fn tool_result(
        tool_call_id: impl Into<String>,
        content: impl Into<String>,
        image_png_base64: Option<String>,
    ) -> Self {
        Self {
            role: ChatRole::Tool,
            content: content.into(),
            tool_call_id: Some(tool_call_id.into()),
            tool_calls_json: None,
            image_png_base64,
        }
    }
}

/// Provider placement inputs that are not part of the durable log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WirePlan {
    /// Placement chosen for this provider.
    pub placement: PlacementMode,
    /// Speaker cue for an agent-agent thread.
    pub speaker: Option<AgentId>,
    /// In-turn tool messages. They are not part of the durable prefix.
    pub in_turn: Vec<ChatMessage>,
}

/// Maps a compiled request to provider messages.
///
/// Tool JSON stays on the prefix `tools_json` field and is not copied into messages.
pub fn to_router_messages(
    request: &CompiledRequest,
    plan: &WirePlan,
) -> Result<Vec<ChatMessage>, CompileError> {
    let mut messages = Vec::new();
    messages.push(ChatMessage::text(
        ChatRole::System,
        request.with_recall.prefix.system_sections.clone(),
    ));
    for slot in &request.with_recall.prefix.slots {
        match slot.kind {
            SlotKind::Tools | SlotKind::Agents | SlotKind::Persona | SlotKind::CompactedMemory => {}
            SlotKind::TranscriptTurn | SlotKind::MemoryNote | SlotKind::CurrentUser => {
                let Some(content) = slot.wire_content.clone() else {
                    return Err(CompileError::MissingWireBody);
                };
                let Some(role) = slot.wire_role else {
                    return Err(CompileError::MissingWireBody);
                };
                messages.push(ChatMessage::text(role, content));
            }
        }
    }
    for message in &plan.in_turn {
        match message.role {
            ChatRole::Assistant | ChatRole::Tool => messages.push(message.clone()),
            ChatRole::System | ChatRole::User => return Err(CompileError::InvalidToolRole),
        }
    }
    let mut trailing = Vec::new();
    trailing.push(request.with_recall.recall_bytes.clone());
    if let Some(scratch) = &request.scratch {
        trailing.push(scratch.bytes.clone());
    }
    if let Some(speaker) = plan.speaker {
        trailing.push(format!("`speaker:{}`\n", speaker.0));
    }
    match plan.placement {
        PlacementMode::TrailingSystem => {
            for content in trailing {
                messages.push(ChatMessage::text(ChatRole::System, content));
            }
        }
        PlacementMode::TrailingUserPart => {
            let mut content = String::new();
            for part in &trailing {
                content.push_str(part);
            }
            messages.push(ChatMessage::text(ChatRole::User, content));
        }
    }
    Ok(messages)
}
