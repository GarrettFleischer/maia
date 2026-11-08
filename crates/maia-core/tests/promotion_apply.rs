//! Promotion apply descriptions: taint, lexemes, atomic rollback, findability.

use std::collections::{BTreeMap, BTreeSet};

use maia_core::agents::AgentId;
use maia_core::audit::Timestamp;
use maia_core::brain::{
    ClaimId, EpisodeId, GraphClaim, LexemeId, LexicalPolicy, MemoryScope, NodeId, PageRankParams,
    QuarantineSet, RankPolicy, RecallGraph, RecallItem, RecallQuery, RecallTaintMode, ScoreWeights,
    lexemes_for_sentence, rank_paths,
};
use maia_core::credit::AgeUnit;
use maia_core::dream::{
    ApplyFault, ClaimStatus, CommittedClaim, EpisodeSegment, LexemeEdge, MentionEdge,
    ModelIdentity, PromotedMark, PromotionCommit, PromotionEpisode, PromotionError,
    PromotionInputPart, PromotionPhase, describe_promotion, promotion_input_parts,
};
use maia_core::security::{SourceRef, Taint};

fn lexical() -> LexicalPolicy {
    LexicalPolicy {
        stopwords: BTreeSet::from(["the".to_owned(), "is".to_owned(), "named".to_owned()]),
        fan_out: BTreeMap::new(),
        high_fan_cutoff: 100,
    }
}

fn episode(known: &[&str]) -> PromotionEpisode {
    PromotionEpisode {
        id: EpisodeId::new("episode_01J001"),
        at: Timestamp(10),
        participants: BTreeSet::from(["agent_scout".to_owned()]),
        segments: vec![EpisodeSegment {
            text: "Owner: what is the project called?\nTool: Bob's Best Burgers.".to_owned(),
            taint: Taint::Untrusted,
            sources: BTreeSet::from([SourceRef::WebOrigin("https://example.test".to_owned())]),
        }],
        reasoning: Some("The page title names the project.".to_owned()),
        known_claim_ids: known.iter().map(|id| ClaimId::new(*id)).collect(),
    }
}

fn response() -> String {
    r#"{"claims":[{"id":"claim_01JXYZ","sentence":"The project is named Bob's Best Burgers.","episode_id":"episode_01J001"}]}"#
        .to_owned()
}

fn describe(fault: ApplyFault) -> Result<PromotionCommit, PromotionError> {
    describe_promotion(
        &episode(&[]),
        &response(),
        Timestamp(50),
        &ModelIdentity::new("promoter-1"),
        &lexical(),
        fault,
    )
}

#[test]
fn commits_provisional_claims_with_episode_taint_mentions_and_lexemes() {
    let commit = describe(ApplyFault::None).expect("promotion commits");
    let sentence = "The project is named Bob's Best Burgers.";
    let lexemes = lexemes_for_sentence(sentence, &lexical());
    assert_eq!(
        commit,
        PromotionCommit {
            claims: vec![CommittedClaim {
                id: ClaimId::new("claim_01JXYZ"),
                sentence: sentence.to_owned(),
                episode_id: EpisodeId::new("episode_01J001"),
                taint: Taint::Untrusted,
                sources: BTreeSet::from([SourceRef::WebOrigin("https://example.test".to_owned())]),
                valid_from: Timestamp(10),
                status: ClaimStatus::Provisional,
                lexemes: lexemes.clone(),
            }],
            mentions: vec![MentionEdge {
                claim_id: ClaimId::new("claim_01JXYZ"),
                episode_id: EpisodeId::new("episode_01J001"),
            }],
            lexeme_edges: lexemes
                .iter()
                .map(|lexeme| LexemeEdge {
                    claim_id: ClaimId::new("claim_01JXYZ"),
                    lexeme_id: lexeme.clone(),
                })
                .collect(),
            promoted: PromotedMark {
                episode_id: EpisodeId::new("episode_01J001"),
                model: ModelIdentity::new("promoter-1"),
                now: Timestamp(50),
            },
        }
    );
    assert!(lexemes.contains(&LexemeId::new("burgers")));
    assert!(!lexemes.iter().any(|lexeme| lexeme.as_str() == "the"));
}

#[test]
fn injected_store_fault_after_every_step_yields_no_commit() {
    for phase in [
        PromotionPhase::InsertClaims,
        PromotionPhase::InsertMentions,
        PromotionPhase::InsertLexemes,
        PromotionPhase::MarkPromoted,
    ] {
        assert_eq!(
            describe(ApplyFault::After(phase)),
            Err(PromotionError::RolledBack(phase))
        );
    }
}

#[test]
fn schema_errors_apply_nothing_even_when_a_fault_is_armed() {
    let result = describe_promotion(
        &episode(&[]),
        r#"{"claims":[],"tool_calls":[]}"#,
        Timestamp(50),
        &ModelIdentity::new("promoter-1"),
        &lexical(),
        ApplyFault::After(PromotionPhase::MarkPromoted),
    );
    assert_eq!(result, Err(PromotionError::ToolChannel));
}

#[test]
fn known_claim_id_rejects_the_whole_promotion() {
    let result = describe_promotion(
        &episode(&["claim_01JXYZ"]),
        &response(),
        Timestamp(50),
        &ModelIdentity::new("promoter-1"),
        &lexical(),
        ApplyFault::None,
    );
    assert_eq!(result, Err(PromotionError::KnownId));
}

#[test]
fn promoted_claim_is_rankable_before_any_consolidation() {
    let commit = describe(ApplyFault::None).expect("promotion commits");
    let claim = &commit.claims[0];
    let mut graph = RecallGraph::default();
    graph.lexemes.extend(claim.lexemes.iter().cloned());
    graph.claims.insert(
        claim.id.clone(),
        GraphClaim {
            sentence: claim.sentence.clone(),
            taint: claim.taint,
            scope: MemoryScope::World,
            lexemes: claim.lexemes.clone(),
            embedding: None,
            presentations: Vec::new(),
            consolidated_by: None,
            source_episode: Some(claim.episode_id.clone()),
        },
    );
    graph.episodes.insert(
        EpisodeId::new("episode_01J001"),
        maia_core::brain::GraphEpisode {
            text: episode(&[]).segments[0].text.clone(),
            lexemes: vec![LexemeId::new("burgers")],
            embedding: None,
        },
    );
    for edge in &commit.lexeme_edges {
        graph.edges.push(maia_core::brain::GraphEdge {
            from: NodeId::Lexeme(edge.lexeme_id.clone()),
            to: NodeId::Claim(edge.claim_id.clone()),
            weight: 1.0,
        });
    }
    let ranked = rank_paths(
        &graph,
        &RecallQuery {
            text: "burgers".to_owned(),
            embedding: None,
        },
        Timestamp(50),
        &RankPolicy {
            decay: 0.5,
            age_unit: AgeUnit::Seconds,
            lexical: lexical(),
            pagerank: PageRankParams {
                damping: 0.5,
                iterations: 1,
            },
            weights: ScoreWeights {
                activation: 0.0,
                pagerank: 0.0,
                embedding: 0.0,
            },
            inclusion_threshold: 0.0,
            recall_token_budget: 100,
            taint_mode: RecallTaintMode::IncludeUntrusted,
        },
        &QuarantineSet::new([]),
        &BTreeSet::from([AgentId(1)]),
    )
    .expect("rank");
    assert_eq!(
        ranked
            .iter()
            .map(|path| path.item.clone())
            .collect::<Vec<_>>(),
        vec![RecallItem::Claim {
            claim_id: ClaimId::new("claim_01JXYZ"),
        }]
    );
    let found = graph.discover_episodes(
        &RecallQuery {
            text: "Bob's Best Burgers".to_owned(),
            embedding: None,
        },
        &lexical(),
    );
    assert_eq!(found, vec![EpisodeId::new("episode_01J001")]);
}

#[test]
fn identical_sentences_from_two_episodes_remain_two_claims() {
    let first = describe(ApplyFault::None).expect("first episode");
    let mut second_episode = episode(&[]);
    second_episode.id = EpisodeId::new("episode_01J002");
    let second = describe_promotion(
        &second_episode,
        r#"{"claims":[{"id":"claim_other","sentence":"The project is named Bob's Best Burgers.","episode_id":"episode_01J002"}]}"#,
        Timestamp(60),
        &ModelIdentity::new("promoter-1"),
        &lexical(),
        ApplyFault::None,
    )
    .expect("second episode");
    assert_eq!(first.claims[0].sentence, second.claims[0].sentence);
    assert_ne!(first.claims[0].id, second.claims[0].id);
    assert_eq!(
        second.mentions,
        vec![MentionEdge {
            claim_id: ClaimId::new("claim_other"),
            episode_id: EpisodeId::new("episode_01J002"),
        }]
    );
}

#[test]
fn promotion_model_input_is_the_episode_only() {
    assert_eq!(
        promotion_input_parts(),
        &[
            PromotionInputPart::EpisodeId,
            PromotionInputPart::Timestamp,
            PromotionInputPart::Participants,
            PromotionInputPart::Segments,
            PromotionInputPart::Reasoning,
        ]
    );
}
