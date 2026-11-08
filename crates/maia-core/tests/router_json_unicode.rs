//! JSON string escape handling for router normalization.

use maia_core::router::read_string_field;

#[test]
fn router_json_keeps_a_reply_that_contains_a_non_ascii_character() {
    let object = "{\"content\":\"Hello — Garrett\"}";
    assert_eq!(
        read_string_field(object, "content").as_deref(),
        Some("Hello — Garrett")
    );
}

#[test]
fn router_json_keeps_a_raw_emoji_and_an_accented_character() {
    let object = "{\"content\":\"café 😀\"}";
    assert_eq!(
        read_string_field(object, "content").as_deref(),
        Some("café 😀")
    );
}

#[test]
fn router_json_decodes_basic_unicode_escape() {
    let object = r#"{"content":"\u0041"}"#;
    assert_eq!(read_string_field(object, "content").as_deref(), Some("A"));
}

#[test]
fn router_json_decodes_surrogate_pair_escape() {
    let object = r#"{"content":"\uD83D\uDE00"}"#;
    assert_eq!(read_string_field(object, "content").as_deref(), Some("😀"));
}

#[test]
fn router_json_rejects_truncated_unicode_escape() {
    let object = r#"{"content":"\u004"}"#;
    assert!(read_string_field(object, "content").is_none());
}

#[test]
fn router_json_decodes_escaped_tool_name() {
    let object = r#"{"name":"search\"alias"}"#;
    assert_eq!(
        read_string_field(object, "name").as_deref(),
        Some("search\"alias")
    );
}
