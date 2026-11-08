//! SSE malformed-frame and terminal-condition regressions.

use maia_core::audit::RequestId;
use maia_core::router::{
    RouterCapabilities, RouterError, RouterSseAssembler, TrailingInstructionPlacement,
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
fn router_sse_rejects_non_json_data_payload() {
    let mut assembler = RouterSseAssembler::new(RequestId(1), caps());
    let error = assembler
        .push_line("data: not-json\n")
        .expect_err("malformed data");
    assert!(matches!(error, RouterError::Protocol { .. }));
}

#[test]
fn router_sse_allows_comments_and_blank_lines() {
    let mut assembler = RouterSseAssembler::new(RequestId(2), caps());
    assembler.push_line(": keep-alive\n").expect("comment");
    assembler.push_line("\n").expect("blank");
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n")
        .expect("payload");
    assembler
        .push_line("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n")
        .expect("finish");
    assembler.push_line("data: [DONE]\n").expect("done");
    let response = assembler.finish().expect("finish");
    assert_eq!(response.reply.as_deref(), Some("x"));
}

#[test]
fn router_sse_requires_done_marker() {
    let mut assembler = RouterSseAssembler::new(RequestId(3), caps());
    assembler
        .push_line(
            "data: {\"choices\":[{\"delta\":{\"content\":\"x\"},\"finish_reason\":\"stop\"}]}\n",
        )
        .expect("payload");
    let error = assembler.finish().unwrap_err();
    assert!(matches!(error, RouterError::IncompleteStream));
}
