//! Strict consolidation schema. Scope-relative forged ids are applied in `consolidation_apply`.

use maia_core::brain::{ClaimId, EpisodeId, FactId};
use maia_core::dream::{
    ClosureDraft, ConsolidationDraft, DreamError, EntityDraft, EntityId, EntityScope, FactDraft,
    MergeDraft, ReplacementRef, SentenceIssue, parse_consolidation,
};

fn valid() -> &'static str {
    r#"{
      "entities": [{
        "id": "entity_obsidian",
        "slug": "obsidian",
        "description": "A local Markdown knowledge-base application.",
        "scope": { "kind": "world" },
        "see": ["entity_maia"]
      }],
      "canonical_facts": [{
        "id": "fact_01JABC",
        "entity_id": "entity_obsidian",
        "sentence": "Obsidian opens Maia's vault for human editing.",
        "claim_ids": ["claim_01JXYZ"],
        "episode_ids": ["episode_01J001"],
        "origin": "ignored"
      }],
      "merges": [{
        "duplicate_fact_id": "fact_older",
        "canonical_fact_id": "fact_01JABC"
      }],
      "closures": [{
        "fact_id": "fact_outdated",
        "replacement_fact_id": "fact_01JABC"
      }],
      "dismissals": [{
        "existing_fact_id": "fact_unrelated",
        "episode_id": "episode_01J001",
        "subject_key": "lexeme:vault",
        "reason": "different subject despite shared lexeme"
      }]
    }"#
}

#[test]
fn parses_the_locked_batch_schema() {
    let draft = parse_consolidation(valid()).expect("schema");
    assert_eq!(
        draft,
        ConsolidationDraft {
            entities: vec![EntityDraft {
                id: EntityId::new("entity_obsidian"),
                slug: "obsidian".to_owned(),
                description: "A local Markdown knowledge-base application.".to_owned(),
                scope: EntityScope::World,
                see: vec![EntityId::new("entity_maia")],
            }],
            canonical_facts: vec![FactDraft {
                id: FactId::new("fact_01JABC"),
                entity_id: EntityId::new("entity_obsidian"),
                sentence: "Obsidian opens Maia's vault for human editing.".to_owned(),
                claim_ids: vec![ClaimId::new("claim_01JXYZ")],
                episode_ids: vec![EpisodeId::new("episode_01J001")],
                origin: Some("ignored".to_owned()),
            }],
            merges: vec![MergeDraft {
                duplicate_fact_id: FactId::new("fact_older"),
                canonical_fact_id: FactId::new("fact_01JABC"),
            }],
            closures: vec![ClosureDraft {
                fact_id: FactId::new("fact_outdated"),
                replacement: ReplacementRef::Fact(FactId::new("fact_01JABC")),
            }],
            dismissals: vec![maia_core::dream::DismissalDraft {
                existing_fact_id: FactId::new("fact_unrelated"),
                episode_id: EpisodeId::new("episode_01J001"),
                subject_key: maia_core::dream::SubjectKey::new("lexeme:vault"),
                reason: "different subject despite shared lexeme".to_owned(),
            }],
        }
    );
}

#[test]
fn accepts_a_null_retraction_and_empty_arrays() {
    let response = r#"{"entities":[],"canonical_facts":[],"merges":[],"closures":[{"fact_id":"fact_old","replacement_fact_id":null}],"dismissals":[]}"#;
    let draft = parse_consolidation(response).expect("retraction");
    assert_eq!(
        draft.closures,
        vec![ClosureDraft {
            fact_id: FactId::new("fact_old"),
            replacement: ReplacementRef::None,
        }]
    );
}

#[test]
fn rejects_unknown_fields_tool_channels_and_bad_shapes() {
    let cases = [
        (
            r#"{"entities":[],"canonical_facts":[],"merges":[],"closures":[],"dismissals":[],"extra":1}"#,
            DreamError::UnknownField,
        ),
        (
            r#"{"entities":[],"canonical_facts":[],"merges":[],"closures":[]}"#,
            DreamError::MissingField,
        ),
        (
            r#"{"entities":[],"canonical_facts":[],"merges":[],"closures":[],"dismissals":[],"tool_calls":[{"name":"shell"}]}"#,
            DreamError::ToolChannel,
        ),
        (
            r#"{"entities":[{"id":"entity_a","slug":"Bad","description":"Fine.","scope":{"kind":"world"},"see":[]}],"canonical_facts":[],"merges":[],"closures":[],"dismissals":[]}"#,
            DreamError::InvalidSlug,
        ),
        (
            r#"{"entities":[{"id":"entity_a","slug":"obsidian","description":"Fine.","scope":{"private":true},"see":[]}],"canonical_facts":[],"merges":[],"closures":[],"dismissals":[]}"#,
            DreamError::InvalidScope,
        ),
        (
            r#"{"entities":[],"canonical_facts":[{"id":"fact_a","entity_id":"entity_a","sentence":"Is this true?","claim_ids":["claim_a"],"episode_ids":["episode_a"]}],"merges":[],"closures":[],"dismissals":[]}"#,
            DreamError::InvalidSentence(SentenceIssue::NotDeclarative),
        ),
        (
            r#"{"entities":[],"canonical_facts":[],"merges":[{"duplicate_fact_id":"fact_a","canonical_fact_id":"fact_a"}],"closures":[],"dismissals":[]}"#,
            DreamError::ContradictoryOperation,
        ),
        (
            r#"{"entities":[],"canonical_facts":[],"merges":[],"closures":[{"fact_id":"fact_a","replacement_fact_id":null},{"fact_id":"fact_a","replacement_fact_id":"fact_b"}],"dismissals":[]}"#,
            DreamError::ContradictoryOperation,
        ),
        (
            r#"{"entities":[],"canonical_facts":[],"merges":[{"duplicate_fact_id":"fact_a","canonical_fact_id":"fact_b"}],"closures":[{"fact_id":"fact_a","replacement_fact_id":null}],"dismissals":[]}"#,
            DreamError::ContradictoryOperation,
        ),
        ("{", DreamError::Malformed),
    ];
    for (response, expected) in cases {
        assert_eq!(parse_consolidation(response), Err(expected), "{response}");
    }
}
