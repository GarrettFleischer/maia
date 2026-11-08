//! Router response accumulation limits.

use maia_core::audit::RequestId;
use maia_core::router::{
    MAX_SSE_ACCUMULATED_REPLY_BYTES, RouterCapabilities, RouterError, RouterSseAssembler,
    TrailingInstructionPlacement,
};

fn caps() -> RouterCapabilities {
    RouterCapabilities {
        readable_reasoning: false,
        tool_calls: false,
        cached_token_usage: false,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    }
}

#[test]
fn router_sse_reply_accumulation_enforces_limit() {
    let mut assembler = RouterSseAssembler::new(RequestId(4), caps());
    let chunk = "x".repeat(MAX_SSE_ACCUMULATED_REPLY_BYTES + 1);
    let line = format!(
        r#"data: {{"choices":[{{"delta":{{"content":"{chunk}"}},"finish_reason":"stop"}}]}}"#
    );
    let error = assembler.push_line(&line).expect_err("over limit");
    assert!(matches!(
        error,
        RouterError::ResourceLimit { .. } | RouterError::Protocol { .. }
    ));
}
