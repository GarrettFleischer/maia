//! Owner-approved promotion decision schema: new / same / replaces / skip.

use maia_core::brain::ClaimId;
use maia_core::dream::{
    ClaimKind, NewClaimDraft, PromotionDecision, PromotionError, ReplaceDraft, SentenceIssue,
    parse_promotion_decision,
};

#[test]
fn accepts_new_same_replaces_and_skip() {
    let raw = r#"{
      "skip": false,
      "new": ["The project is named Bob's Best Burgers."],
      "same": ["claim_existing"],
      "replaces": [{"old":"claim_old","sentence":"The project is named Bob's Better Burgers."}]
    }"#;
    let decision = parse_promotion_decision(raw).expect("valid decision");
    assert_eq!(
        decision,
        PromotionDecision {
            skip: false,
            new: vec![NewClaimDraft {
                sentence: "The project is named Bob's Best Burgers.".to_owned(),
                kind: ClaimKind::Explicit,
            }],
            same: vec![ClaimId::new("claim_existing")],
            replaces: vec![ReplaceDraft {
                old: ClaimId::new("claim_old"),
                sentence: "The project is named Bob's Better Burgers.".to_owned(),
            }],
        }
    );
}

#[test]
fn accepts_a_deduction_object_inside_new() {
    let raw = r#"{
      "skip": false,
      "new": [{"sentence":"The owner lives in Canby.","kind":"deduction"}],
      "same": [],
      "replaces": []
    }"#;
    let decision = parse_promotion_decision(raw).expect("deduction");
    assert_eq!(
        decision.new,
        vec![NewClaimDraft {
            sentence: "The owner lives in Canby.".to_owned(),
            kind: ClaimKind::Deduction,
        }]
    );
}

#[test]
fn accepts_skip_true_with_empty_lists() {
    let decision =
        parse_promotion_decision(r#"{"skip":true,"new":[],"same":[],"replaces":[]}"#)
            .expect("skip");
    assert!(decision.skip);
    assert!(decision.new.is_empty());
    assert!(decision.same.is_empty());
    assert!(decision.replaces.is_empty());
}

#[test]
fn rejects_unknown_missing_mistyped_and_long_sentences() {
    let cases = [
        (
            r#"{"skip":false,"new":[],"same":[],"replaces":[],"note":"x"}"#,
            PromotionError::UnknownField,
        ),
        (
            r#"{"new":[],"same":[],"replaces":[]}"#,
            PromotionError::MissingField,
        ),
        (
            r#"{"skip":"no","new":[],"same":[],"replaces":[]}"#,
            PromotionError::InvalidType,
        ),
        (
            r#"{"skip":false,"new":[""],"same":[],"replaces":[]}"#,
            PromotionError::InvalidSentence(SentenceIssue::Empty),
        ),
        ("not json", PromotionError::Malformed),
    ];
    for (response, expected) in cases {
        assert_eq!(
            parse_promotion_decision(response),
            Err(expected),
            "{response}"
        );
    }
    let long = format!("{}{}", "A".repeat(280), ".");
    let response = format!(r#"{{"skip":false,"new":["{long}"],"same":[],"replaces":[]}}"#);
    assert_eq!(
        parse_promotion_decision(&response),
        Err(PromotionError::SentenceTooLong)
    );
}

#[test]
fn accepts_json_wrapped_in_a_code_fence_and_preamble() {
    let raw = "Here is the decision:\n```json\n{\"skip\":false,\"new\":[\"The project is named Bob's Best Burgers.\"],\"same\":[],\"replaces\":[]}\n```\nThanks.";
    let decision = parse_promotion_decision(raw).expect("wrapped json");
    assert_eq!(
        decision.new,
        vec![NewClaimDraft {
            sentence: "The project is named Bob's Best Burgers.".to_owned(),
            kind: ClaimKind::Explicit,
        }]
    );
}

#[test]
fn wrapped_json_still_rejects_unknown_fields() {
    let raw = "```json\n{\"skip\":false,\"new\":[],\"same\":[],\"replaces\":[],\"note\":\"x\"}\n```";
    assert_eq!(
        parse_promotion_decision(raw),
        Err(PromotionError::UnknownField)
    );
}

#[test]
fn rejects_tool_channel_and_duplicate_same_ids() {
    assert_eq!(
        parse_promotion_decision(
            r#"{"skip":false,"new":[],"same":[],"replaces":[],"tool_calls":[{"name":"shell"}]}"#
        ),
        Err(PromotionError::ToolChannel)
    );
    assert_eq!(
        parse_promotion_decision(
            r#"{"skip":false,"new":[],"same":["claim_a","claim_a"],"replaces":[]}"#
        ),
        Err(PromotionError::DuplicateId)
    );
}
