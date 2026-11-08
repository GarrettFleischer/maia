//! SSE stream assembly contract.

use maia_core::audit::RequestId;
use maia_core::router::{
    FinishReason, RouterCapabilities, RouterError, RouterSseAssembler,
    TrailingInstructionPlacement, UsageValue,
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
fn split_tool_arguments_assemble_by_id_across_chunks() {
    let mut assembler = RouterSseAssembler::new(RequestId(9), caps());
    assembler
        .push_line(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"search\",\"arguments\":\"{\\\"q\\\":\\\"x\\\"}\"}}]}}]}\n",
        )
        .expect("chunk");
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n")
        .expect("finish");
    assembler.push_line("data: [DONE]\n").expect("done");
    let response = assembler.finish().expect("finish");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].arguments_json, "{\"q\":\"x\"}");
}

#[test]
fn stream_ending_with_partial_tool_call_is_error() {
    let mut assembler = RouterSseAssembler::new(RequestId(10), caps());
    assembler
        .push_line(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"search\",\"arguments\":\"{\"}}]}}]}",
        )
        .expect("chunk");
    let error = assembler.finish().unwrap_err();
    assert!(matches!(error, RouterError::IncompleteStream));
}

#[test]
fn emoji_and_accented_content_deltas_are_kept() {
    let mut assembler = RouterSseAssembler::new(RequestId(13), caps());
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{\"content\":\"👋 \"}}]}\n")
        .expect("wave");
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{\"content\":\"café\"}}]}\n")
        .expect("word");
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n")
        .expect("finish");
    assembler.push_line("data: [DONE]\n").expect("done");
    let response = assembler.finish().expect("finish");
    assert_eq!(response.reply.as_deref(), Some("👋 café"));
}

#[test]
fn chunk_boundaries_split_data_prefix() {
    let mut assembler = RouterSseAssembler::new(RequestId(11), caps());
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{\"content\":\"hel")
        .expect("a");
    assembler.push_line("lo\"}}]}\n").expect("b");
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n")
        .expect("finish");
    assembler.push_line("data: [DONE]\n").expect("done");
    let response = assembler.finish().expect("finish");
    assert_eq!(response.reply.as_deref(), Some("hello"));
    assert_eq!(response.finish, FinishReason::Stop);
}

#[test]
fn cached_usage_from_final_chunk_only() {
    let mut assembler = RouterSseAssembler::new(RequestId(12), caps());
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n")
        .expect("delta");
    assembler
        .push_line(
            "data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"prompt_tokens_details\":{\"cached_tokens\":1}}}\n",
        )
        .expect("usage");
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n")
        .expect("finish");
    assembler.push_line("data: [DONE]\n").expect("done");
    let response = assembler.finish().expect("finish");
    assert_eq!(response.usage.cached_input_tokens, UsageValue::Reported(1));
}
