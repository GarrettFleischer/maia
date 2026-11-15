//! Tool-call validation against canonical tools JSON.

use maia_core::router::{NormalizedToolCall, ToolCallId, ToolCallName, validate_tool_calls};

#[test]
fn unknown_tool_name_is_allowed_for_host_repair() {
    let tools_json =
        r#"[{"type":"function","function":{"name":"search","parameters":{"type":"object"}}}]"#;
    let calls = vec![NormalizedToolCall {
        id: ToolCallId::new("call_1"),
        name: ToolCallName::new("bash"),
        arguments_json: "{}".to_owned(),
    }];
    // Host returns a normal tool error so the model can recover; do not abort the turn.
    validate_tool_calls(tools_json, &calls).expect("unknown name stays readable");
}

#[test]
fn duplicate_tool_call_ids_are_rejected() {
    let tools_json =
        r#"[{"type":"function","function":{"name":"search","parameters":{"type":"object"}}}]"#;
    let calls = vec![
        NormalizedToolCall {
            id: ToolCallId::new("dup"),
            name: ToolCallName::new("search"),
            arguments_json: "{}".to_owned(),
        },
        NormalizedToolCall {
            id: ToolCallId::new("dup"),
            name: ToolCallName::new("search"),
            arguments_json: "{}".to_owned(),
        },
    ];
    assert!(validate_tool_calls(tools_json, &calls).is_err());
}

#[test]
fn valid_calls_pass_when_schema_is_object() {
    let tools_json = r#"[{"type":"function","function":{"name":"search","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}}]"#;
    let calls = vec![NormalizedToolCall {
        id: ToolCallId::new("call_ok"),
        name: ToolCallName::new("search"),
        arguments_json: "{\"q\":\"needle\"}".to_owned(),
    }];
    validate_tool_calls(tools_json, &calls).expect("valid");
}
