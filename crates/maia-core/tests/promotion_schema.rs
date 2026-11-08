//! Strict promotion schema: unknown fields, forged episode ids, sentence shape, tool channel.

use maia_core::brain::EpisodeId;
use maia_core::dream::{ClaimDraft, PromotionError, SentenceIssue, parse_promotion};

fn episode() -> EpisodeId {
    EpisodeId::new("episode_01J001")
}

fn claim(sentence: &str) -> String {
    format!(
        r#"{{"claims":[{{"id":"claim_01JXYZ","sentence":{sentence:?},"episode_id":"episode_01J001"}}]}}"#
    )
}

#[test]
fn accepts_one_declarative_claim_bound_to_the_input_episode() {
    let draft = parse_promotion(
        &claim("The project is named Bob's Best Burgers."),
        &episode(),
    )
    .expect("valid promotion");
    assert_eq!(
        draft,
        vec![ClaimDraft {
            id: maia_core::brain::ClaimId::new("claim_01JXYZ"),
            sentence: "The project is named Bob's Best Burgers.".to_owned(),
            episode_id: episode(),
        }]
    );
}

#[test]
fn accepts_an_empty_claim_list() {
    let draft = parse_promotion(r#"{"claims":[]}"#, &episode()).expect("empty claims");
    assert!(draft.is_empty());
}

#[test]
fn rejects_unknown_missing_and_mistyped_fields() {
    let cases = [
        (r#"{"claims":[],"note":"x"}"#, PromotionError::UnknownField),
        (r#"{}"#, PromotionError::MissingField),
        (
            r#"{"claims":[{"sentence":"Ok.","episode_id":"episode_01J001"}]}"#,
            PromotionError::MissingField,
        ),
        (
            r#"{"claims":[{"id":"claim_01JXYZ","sentence":"Ok.","episode_id":"episode_01J001","taint":"Trusted"}]}"#,
            PromotionError::UnknownField,
        ),
        (r#"{"claims":"none"}"#, PromotionError::InvalidType),
        (
            r#"{"claims":[{"id":"","sentence":"Ok.","episode_id":"episode_01J001"}]}"#,
            PromotionError::EmptyId,
        ),
        (
            r#"{"claims":[{"id":"claim_a","sentence":"Ok.","episode_id":"episode_01J001"},{"id":"claim_a","sentence":"Also ok.","episode_id":"episode_01J001"}]}"#,
            PromotionError::DuplicateId,
        ),
        ("not json", PromotionError::Malformed),
    ];
    for (response, expected) in cases {
        assert_eq!(
            parse_promotion(response, &episode()),
            Err(expected),
            "{response}"
        );
    }
    assert_eq!(
        parse_promotion(r#"{"claims":[]}  trailing"#, &episode()),
        Err(PromotionError::Malformed)
    );
}

#[test]
fn rejects_a_forged_episode_id() {
    let response = r#"{"claims":[{"id":"claim_01JXYZ","sentence":"The project is named Bob's Best Burgers.","episode_id":"episode_forged"}]}"#;
    assert_eq!(
        parse_promotion(response, &episode()),
        Err(PromotionError::ForgedEpisodeId)
    );
}

#[test]
fn rejects_non_declarative_or_decorated_sentences() {
    let sentences = [
        ("Is the project named Bob?", SentenceIssue::NotDeclarative),
        ("The project is named Bob!", SentenceIssue::NotDeclarative),
        (
            "The project is named Bob. The vault is local.",
            SentenceIssue::MultipleSentences,
        ),
        ("- The project is named Bob.", SentenceIssue::ListMarker),
        (
            "The project is named fact_01JABC today.",
            SentenceIssue::StableId,
        ),
        ("kind: entity", SentenceIssue::Frontmatter),
        ("   ", SentenceIssue::Empty),
    ];
    for (sentence, issue) in sentences {
        assert_eq!(
            parse_promotion(&claim(sentence), &episode()),
            Err(PromotionError::InvalidSentence(issue)),
            "{sentence}"
        );
    }
}

#[test]
fn rejects_a_tool_call_channel_without_returning_claims() {
    let response = r#"{"claims":[{"id":"claim_01JXYZ","sentence":"The project is named Bob's Best Burgers.","episode_id":"episode_01J001"}],"tool_calls":[{"name":"shell"}]}"#;
    assert_eq!(
        parse_promotion(response, &episode()),
        Err(PromotionError::ToolChannel)
    );
}
