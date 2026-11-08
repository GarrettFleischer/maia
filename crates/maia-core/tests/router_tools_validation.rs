//! Tool-call validation against canonical tools JSON.

use maia_core::router::{
    NormalizedToolCall, RouterError, ToolCallId, ToolCallName, validate_tool_calls,
};

#[test]
fn unknown_tool_name_is_protocol_error() {
    let tools_json =
        r#"[{"type":"function","function":{"name":"search","parameters":{"type":"object"}}}]"#;
    let calls = vec![NormalizedToolCall {
        id: ToolCallId::new("call_1"),
        name: ToolCallName::new("delete_all"),
        arguments_json: "{}".to_owned(),
    }];
    let error = validate_tool_calls(tools_json, &calls).unwrap_err();
    assert!(matches!(error, RouterError::Protocol { .. }));
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
