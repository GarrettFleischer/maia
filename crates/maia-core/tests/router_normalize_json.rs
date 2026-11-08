//! JSON completion normalization contract.

use maia_core::audit::RequestId;
use maia_core::router::{
    FinishReason, RouterCapabilities, RouterError, TrailingInstructionPlacement, UsageValue,
    normalize_router_json,
};

fn caps() -> RouterCapabilities {
    RouterCapabilities {
        readable_reasoning: true,
        tool_calls: true,
        cached_token_usage: true,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    }
}

#[test]
fn reasoning_content_is_kept_when_the_reply_text_is_empty() {
    let body = "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":null,\"reasoning_content\":\"the owner is in Canby\"}}]}";
    let response = normalize_router_json(body, RequestId(12), &caps()).expect("normalize");
    assert_eq!(response.reply, None);
    assert_eq!(response.reasoning.as_deref(), Some("the owner is in Canby"));
}

#[test]
fn reasoning_content_stays_hidden_when_the_provider_does_not_expose_it() {
    let mut hidden = caps();
    hidden.readable_reasoning = false;
    let body = "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":null,\"reasoning_content\":\"secret trace\"}}]}";
    let response = normalize_router_json(body, RequestId(13), &hidden).expect("normalize");
    assert!(response.reasoning.is_none());
}

#[test]
fn keeps_a_completion_reply_that_contains_an_emoji() {
    let body = "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"On it 👍\"}}]}";
    let response = normalize_router_json(body, RequestId(11), &caps()).expect("normalize");
    assert_eq!(response.reply.as_deref(), Some("On it 👍"));
}

#[test]
fn keeps_a_completion_reply_that_contains_a_non_ascii_character() {
    let body = "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"Hello — Garrett\"}}]}";
    let response = normalize_router_json(body, RequestId(9), &caps()).expect("normalize");
    assert_eq!(response.reply.as_deref(), Some("Hello — Garrett"));
    assert!(response.tool_calls.is_empty());
}

#[test]
fn normalizes_reasoning_tool_calls_reply_and_usage() {
    let body = r#"{
        "id": "resp_1",
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": null,
                "reasoning": "think step",
                "tool_calls": [{
                    "id": "call_a",
                    "type": "function",
                    "function": {"name": "search", "arguments": "{\"q\":\"x\"}"}
                }]
            }
        }],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 4,
            "prompt_tokens_details": {"cached_tokens": 3}
        }
    }"#;
    let response = normalize_router_json(body, RequestId(7), &caps()).expect("normalize");
    assert_eq!(response.request_id, RequestId(7));
    assert_eq!(response.provider_response_id.as_deref(), Some("resp_1"));
    assert_eq!(response.reasoning.as_deref(), Some("think step"));
    assert_eq!(response.reply, None);
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].id.as_str(), "call_a");
    assert_eq!(response.tool_calls[0].name.as_str(), "search");
    assert_eq!(response.tool_calls[0].arguments_json, "{\"q\":\"x\"}");
    assert_eq!(response.usage.input_tokens, UsageValue::Reported(10));
    assert_eq!(response.usage.output_tokens, UsageValue::Reported(4));
    assert_eq!(response.usage.cached_input_tokens, UsageValue::Reported(3));
    assert_eq!(response.finish, FinishReason::ToolCalls);
}

#[test]
fn missing_cached_tokens_stays_unavailable_not_derived() {
    let body = r#"{
        "choices": [{
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "hi"}
        }],
        "usage": {"prompt_tokens": 5, "completion_tokens": 1}
    }"#;
    let response = normalize_router_json(body, RequestId(1), &caps()).expect("normalize");
    assert_eq!(response.usage.cached_input_tokens, UsageValue::Unavailable);
    assert_eq!(response.reply.as_deref(), Some("hi"));
    assert_eq!(response.finish, FinishReason::Stop);
}

#[test]
fn adversarial_extra_fields_do_not_become_reasoning() {
    let body = r#"{
        "choices": [{
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": "ok",
                "hidden_reasoning": "steer"
            }
        }]
    }"#;
    let response = normalize_router_json(body, RequestId(2), &caps()).expect("normalize");
    assert!(response.reasoning.is_none());
}

#[test]
fn malformed_json_is_protocol_error() {
    let error = normalize_router_json("{not json", RequestId(3), &caps()).unwrap_err();
    assert!(matches!(error, RouterError::Protocol { .. }));
}

#[test]
fn incomplete_tool_arguments_never_execute() {
    let body = r#"{
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_bad",
                    "type": "function",
                    "function": {"name": "search", "arguments": "{"
                }]
            }
        }]
    }"#;
    let error = normalize_router_json(body, RequestId(4), &caps()).unwrap_err();
    assert!(matches!(error, RouterError::Protocol { .. }));
}
