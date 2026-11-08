//! Consolidation apply: taint, proposals, supersession, stale snapshots, atomic rollback.

use std::collections::{BTreeMap, BTreeSet};

use maia_core::agents::AgentId;
use maia_core::audit::Timestamp;
use maia_core::brain::{
    ClaimId, EpisodeId, FactId, GraphClaim, GraphFact, LexemeId, LexicalPolicy, MemoryScope,
    PageRankParams, QuarantineSet, RankPolicy, RecallGraph, RecallItem, RecallQuery,
    RecallTaintMode, ScoreWeights, lexemes_for_sentence, rank_paths,
};
use maia_core::credit::{AgeUnit, CorrectionHold};
use maia_core::dream::{
    ClaimStatus, ConsolidationCommit, ConsolidationFault, ConsolidationPhase, ConsolidationRequest,
    ConsolidationSnapshot, CorrectionConsumption, DreamEpisode, DreamError, DreamFact, EntityId,
    EntityRow, EntityScope, FactCurrency, MentionEdge, ModelFailure, ModelIdentity, OwnerDecision,
    ProjectionProgress, SnapshotClaim, SnapshotCorrection, SubjectKey, decide_proposal,
    describe_consolidation, render_consolidation_model_input,
};
use maia_core::dream::{DreamBatchId, ProposalDecision, ProposedOperation};
use maia_core::security::Taint;
use maia_core::vault::VaultPath;

fn lexical() -> LexicalPolicy {
    LexicalPolicy {
        stopwords: BTreeSet::from(["the".to_owned(), "is".to_owned()]),
        fan_out: BTreeMap::new(),
        high_fan_cutoff: 100,
    }
}

fn episode(id: &str, at: i64, taint: Taint, lexeme: &str) -> DreamEpisode {
    DreamEpisode {
        id: EpisodeId::new(id),
        at: Timestamp(at),
        taint,
        lexemes: vec![LexemeId::new(lexeme)],
        text: format!("exchange {id}"),
    }
}

fn claim(id: &str, sentence: &str, taint: Taint, episode: &str) -> SnapshotClaim {
    SnapshotClaim {
        id: ClaimId::new(id),
        sentence: sentence.to_owned(),
        taint,
        episode_id: EpisodeId::new(episode),
        status: ClaimStatus::Provisional,
    }
}

fn mention(claim: &str, episode: &str) -> MentionEdge {
    MentionEdge {
        claim_id: ClaimId::new(claim),
        episode_id: EpisodeId::new(episode),
    }
}

fn simple_snapshot() -> ConsolidationSnapshot {
    ConsolidationSnapshot {
        claims: vec![
            claim(
                "claim_owner",
                "The vault is local.",
                Taint::Trusted,
                "episode_owner",
            ),
            claim(
                "claim_other",
                "Notes stay put.",
                Taint::Trusted,
                "episode_owner",
            ),
        ],
        episodes: vec![episode("episode_owner", 20, Taint::Trusted, "vault")],
        facts: Vec::new(),
        entities: Vec::new(),
        corrections: Vec::new(),
        mentions: vec![
            mention("claim_owner", "episode_owner"),
            mention("claim_other", "episode_owner"),
        ],
        participants: BTreeSet::from(["agent_scout".to_owned()]),
    }
}

fn simple_response() -> &'static str {
    r#"{"entities":[{"id":"entity_obsidian","slug":"obsidian","description":"A local knowledge base.","scope":{"kind":"world"},"see":[]}],"canonical_facts":[{"id":"fact_new","entity_id":"entity_obsidian","sentence":"The vault is local.","claim_ids":["claim_owner"],"episode_ids":["episode_owner"]}],"merges":[],"closures":[],"dismissals":[]}"#
}

fn request<'a>(
    snapshot: &'a ConsolidationSnapshot,
    current: &'a ConsolidationSnapshot,
    response: &'a str,
    fault: ConsolidationFault,
) -> ConsolidationRequest<'a> {
    ConsolidationRequest {
        snapshot,
        current,
        response,
        now: Timestamp(100),
        model: ModelIdentity::new("dream-1"),
        batch_id: DreamBatchId::new("batch_01"),
        lexical: lexical(),
        fault,
    }
}

fn describe_simple(fault: ConsolidationFault) -> Result<ConsolidationCommit, DreamError> {
    let snapshot = simple_snapshot();
    describe_consolidation(&request(&snapshot, &snapshot, simple_response(), fault))
}

#[test]
fn trusted_batch_supersedes_only_listed_claims_and_keeps_mentions() {
    let snapshot = simple_snapshot();
    let commit = describe_consolidation(&request(
        &snapshot,
        &snapshot,
        simple_response(),
        ConsolidationFault::None,
    ))
    .expect("commit");
    let sentence = "The vault is local.";
    assert_eq!(commit.context_taint, Taint::Trusted);
    assert_eq!(commit.mentions, snapshot.mentions);
    assert_eq!(
        commit.claims,
        vec![
            SnapshotClaim {
                id: ClaimId::new("claim_owner"),
                sentence: sentence.to_owned(),
                taint: Taint::Trusted,
                episode_id: EpisodeId::new("episode_owner"),
                status: ClaimStatus::Superseded {
                    by: FactId::new("fact_new"),
                },
            },
            claim(
                "claim_other",
                "Notes stay put.",
                Taint::Trusted,
                "episode_owner"
            ),
        ]
    );
    assert_eq!(
        commit.facts,
        vec![DreamFact {
            id: FactId::new("fact_new"),
            sentence: sentence.to_owned(),
            taint: Taint::Trusted,
            lexemes: lexemes_for_sentence(sentence, &lexical()),
            episode_ids: vec![EpisodeId::new("episode_owner")],
            entity_id: Some(EntityId::new("entity_obsidian")),
            claim_ids: vec![ClaimId::new("claim_owner")],
            valid_from: Timestamp(20),
            hold: None,
            currency: FactCurrency::Current,
        }]
    );
    assert_eq!(
        commit.entities,
        vec![EntityRow {
            id: EntityId::new("entity_obsidian"),
            slug: "obsidian".to_owned(),
            description: "A local knowledge base.".to_owned(),
            scope: EntityScope::World,
            see: Vec::new(),
            taint: Taint::Trusted,
        }]
    );
    assert!(commit.proposals.is_empty());
    assert_eq!(commit.projection.progress, ProjectionProgress::Pending);
    assert_eq!(
        commit.projection.entities,
        vec![EntityId::new("entity_obsidian")]
    );
    assert_eq!(
        commit.projection.folders,
        vec![VaultPath::parse("world/entities/index").expect("path")]
    );
    assert!(!render_consolidation_model_input(&snapshot).contains("SENTINEL_HUMAN"));
    assert!(render_consolidation_model_input(&snapshot).contains("exchange episode_owner"));
}

#[test]
fn superseded_claim_drops_out_of_ranking_and_its_fact_remains() {
    let commit = describe_simple(ConsolidationFault::None).expect("commit");
    let mut graph = RecallGraph::default();
    for claim in &commit.claims {
        let consolidated_by = match &claim.status {
            ClaimStatus::Provisional => None,
            ClaimStatus::Superseded { by } => Some(by.clone()),
        };
        graph.claims.insert(
            claim.id.clone(),
            GraphClaim {
                sentence: claim.sentence.clone(),
                taint: claim.taint,
                scope: MemoryScope::World,
                lexemes: lexemes_for_sentence(&claim.sentence, &lexical()),
                embedding: None,
                presentations: Vec::new(),
                consolidated_by,
                source_episode: Some(claim.episode_id.clone()),
            },
        );
    }
    for fact in &commit.facts {
        graph.facts.insert(
            fact.id.clone(),
            GraphFact {
                sentence: fact.sentence.clone(),
                taint: fact.taint,
                scope: MemoryScope::World,
                lexemes: fact.lexemes.clone(),
                embedding: None,
                presentations: Vec::new(),
                valid_from: fact.valid_from,
                valid_end: None,
                consolidates: fact.claim_ids.clone(),
            },
        );
        graph.lexemes.extend(fact.lexemes.iter().cloned());
    }
    let ranked = rank_paths(
        &graph,
        &RecallQuery {
            text: "local".to_owned(),
            embedding: None,
        },
        Timestamp(100),
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
        &QuarantineSet::new(Vec::new()),
        &BTreeSet::from([AgentId(1)]),
    )
    .expect("rank");
    let items = ranked
        .iter()
        .map(|path| path.item.clone())
        .collect::<Vec<_>>();
    assert!(items.contains(&RecallItem::Fact {
        fact_id: FactId::new("fact_new"),
    }));
    assert!(!items.contains(&RecallItem::Claim {
        claim_id: ClaimId::new("claim_owner"),
    }));
    assert!(items.contains(&RecallItem::Claim {
        claim_id: ClaimId::new("claim_other"),
    }));
}

#[test]
fn store_faults_and_model_timeout_leave_zero_commits() {
    for phase in [
        ConsolidationPhase::RecordBatch,
        ConsolidationPhase::ApplyEntities,
        ConsolidationPhase::DivertProtected,
        ConsolidationPhase::ApplyFactsAndMerges,
        ConsolidationPhase::ApplyClosuresAndDismissals,
        ConsolidationPhase::FinishBrainState,
        ConsolidationPhase::EnqueueProjection,
    ] {
        assert_eq!(
            describe_simple(ConsolidationFault::After(phase)),
            Err(DreamError::RolledBack(phase))
        );
    }
    let snapshot = simple_snapshot();
    assert_eq!(
        describe_consolidation(&request(
            &snapshot,
            &snapshot,
            "not-json",
            ConsolidationFault::Model(ModelFailure::Timeout),
        )),
        Err(DreamError::Model(ModelFailure::Timeout))
    );
}

#[test]
fn forged_provenance_and_stale_snapshots_apply_nothing() {
    let snapshot = simple_snapshot();
    let forged = r#"{"entities":[{"id":"entity_obsidian","slug":"obsidian","description":"A local knowledge base.","scope":{"kind":"world"},"see":[]}],"canonical_facts":[{"id":"fact_new","entity_id":"entity_obsidian","sentence":"The vault is local.","claim_ids":["claim_owner"],"episode_ids":["episode_forged"]}],"merges":[],"closures":[],"dismissals":[]}"#;
    assert_eq!(
        describe_consolidation(&request(
            &snapshot,
            &snapshot,
            forged,
            ConsolidationFault::None
        )),
        Err(DreamError::InventedProvenance)
    );
    let mut current = snapshot.clone();
    current.claims[0].sentence = "changed".to_owned();
    assert_eq!(
        describe_consolidation(&request(
            &snapshot,
            &current,
            simple_response(),
            ConsolidationFault::None,
        )),
        Err(DreamError::StaleSnapshot)
    );
}

#[test]
fn unanswered_candidate_rejects_and_dismissal_clears_the_hold() {
    let fact = DreamFact {
        id: FactId::new("fact_kept"),
        sentence: "The vault is local.".to_owned(),
        taint: Taint::Trusted,
        lexemes: vec![LexemeId::new("vault")],
        episode_ids: vec![EpisodeId::new("episode_old")],
        entity_id: Some(EntityId::new("entity_kept")),
        claim_ids: Vec::new(),
        valid_from: Timestamp(4),
        hold: Some(CorrectionHold {
            since: Timestamp(7),
        }),
        currency: FactCurrency::Current,
    };
    let snapshot = ConsolidationSnapshot {
        claims: vec![claim(
            "claim_owner",
            "The vault is local.",
            Taint::Trusted,
            "episode_owner",
        )],
        episodes: vec![episode("episode_owner", 20, Taint::Trusted, "vault")],
        facts: vec![fact.clone()],
        entities: vec![EntityRow {
            id: EntityId::new("entity_kept"),
            slug: "kept".to_owned(),
            description: "Kept entity.".to_owned(),
            scope: EntityScope::World,
            see: Vec::new(),
            taint: Taint::Trusted,
        }],
        corrections: vec![SnapshotCorrection {
            fact_id: FactId::new("fact_kept"),
            episode_id: EpisodeId::new("episode_owner"),
            subject_key: SubjectKey::new("lexeme:vault"),
            taint: Taint::Trusted,
            hold: CorrectionHold {
                since: Timestamp(7),
            },
        }],
        mentions: vec![mention("claim_owner", "episode_owner")],
        participants: BTreeSet::new(),
    };
    assert_eq!(
        describe_consolidation(&request(
            &snapshot,
            &snapshot,
            r#"{"entities":[],"canonical_facts":[],"merges":[],"closures":[],"dismissals":[]}"#,
            ConsolidationFault::None
        )),
        Err(DreamError::UnansweredCandidate)
    );
    let response = r#"{"entities":[],"canonical_facts":[],"merges":[],"closures":[],"dismissals":[{"existing_fact_id":"fact_kept","episode_id":"episode_owner","subject_key":"lexeme:vault","reason":"different subject"}]}"#;
    let commit = describe_consolidation(&request(
        &snapshot,
        &snapshot,
        response,
        ConsolidationFault::None,
    ))
    .expect("dismiss");
    assert_eq!(commit.facts[0].sentence, fact.sentence);
    assert_eq!(commit.facts[0].episode_ids, fact.episode_ids);
    assert_eq!(commit.facts[0].currency, FactCurrency::Current);
    assert_eq!(commit.facts[0].hold, None);
    assert_eq!(
        commit.corrections[0].consumption,
        CorrectionConsumption::Consumed
    );
    assert_eq!(commit.corrections[0].hold, None);
    assert_eq!(commit.claims[0].status, ClaimStatus::Provisional);
}

#[test]
fn untrusted_context_proposes_trusted_closure_and_still_merges_other_facts() {
    let trusted = DreamFact {
        id: FactId::new("fact_trusted"),
        sentence: "The vault is local.".to_owned(),
        taint: Taint::Trusted,
        lexemes: vec![LexemeId::new("vault")],
        episode_ids: vec![EpisodeId::new("episode_owner")],
        entity_id: Some(EntityId::new("entity_kept")),
        claim_ids: Vec::new(),
        valid_from: Timestamp(30),
        hold: None,
        currency: FactCurrency::Current,
    };
    let duplicate = DreamFact {
        id: FactId::new("fact_dup"),
        sentence: "A web page mentioned burgers.".to_owned(),
        taint: Taint::Untrusted,
        lexemes: Vec::new(),
        episode_ids: vec![EpisodeId::new("episode_web")],
        entity_id: Some(EntityId::new("entity_kept")),
        claim_ids: Vec::new(),
        valid_from: Timestamp(10),
        hold: None,
        currency: FactCurrency::Current,
    };
    let snapshot = ConsolidationSnapshot {
        claims: vec![
            claim(
                "claim_owner",
                "The vault is local.",
                Taint::Trusted,
                "episode_owner",
            ),
            claim(
                "claim_web",
                "A web page mentioned burgers.",
                Taint::Untrusted,
                "episode_web",
            ),
        ],
        episodes: vec![
            episode("episode_web", 10, Taint::Untrusted, "vault"),
            episode("episode_owner", 30, Taint::Trusted, "vault"),
        ],
        facts: vec![trusted.clone(), duplicate.clone()],
        entities: vec![EntityRow {
            id: EntityId::new("entity_kept"),
            slug: "kept".to_owned(),
            description: "Kept entity.".to_owned(),
            scope: EntityScope::World,
            see: Vec::new(),
            taint: Taint::Trusted,
        }],
        corrections: Vec::new(),
        mentions: vec![
            mention("claim_owner", "episode_owner"),
            mention("claim_web", "episode_web"),
        ],
        participants: BTreeSet::new(),
    };
    let response = r#"{"entities":[],"canonical_facts":[{"id":"fact_new","entity_id":"entity_kept","sentence":"The vault is local.","claim_ids":["claim_owner"],"episode_ids":["episode_owner"]}],"merges":[{"duplicate_fact_id":"fact_dup","canonical_fact_id":"fact_new"}],"closures":[{"fact_id":"fact_trusted","replacement_fact_id":"fact_new"}],"dismissals":[]}"#;
    let commit = describe_consolidation(&request(
        &snapshot,
        &snapshot,
        response,
        ConsolidationFault::None,
    ))
    .expect("proposal");
    assert_eq!(commit.context_taint, Taint::Untrusted);
    assert_eq!(commit.mentions, snapshot.mentions);
    assert_eq!(commit.facts[0].sentence, trusted.sentence);
    assert_eq!(commit.facts[0].episode_ids, trusted.episode_ids);
    assert_eq!(commit.facts[0].currency, FactCurrency::Current);
    assert_eq!(
        commit.facts[1].currency,
        FactCurrency::Merged {
            into: FactId::new("fact_new"),
        }
    );
    assert_eq!(commit.facts[1].sentence, duplicate.sentence);
    assert_eq!(commit.facts[2].taint, Taint::Untrusted);
    assert_eq!(
        commit.facts[2].episode_ids,
        vec![EpisodeId::new("episode_owner")]
    );
    assert_eq!(
        commit.claims[0].status,
        ClaimStatus::Superseded {
            by: FactId::new("fact_new")
        }
    );
    assert_eq!(commit.claims[1].status, ClaimStatus::Provisional);
    assert_eq!(commit.proposals.len(), 1);
    assert_eq!(commit.proposals[0].batch_taint, Taint::Untrusted);
    assert_eq!(commit.proposals[0].decision, ProposalDecision::Pending);
    assert_eq!(commit.proposals[0].target_fact, FactId::new("fact_trusted"));
    assert_eq!(
        commit.proposals[0].operation,
        ProposedOperation::Close {
            fact: FactId::new("fact_trusted"),
            replacement: Some(FactId::new("fact_new")),
        }
    );
    let (decided, unchanged) = decide_proposal(
        &commit.proposals[0],
        &OwnerDecision::Reject {
            by: "owner".to_owned(),
        },
        &commit.facts[0],
        Timestamp(120),
    )
    .expect("reject");
    assert_eq!(unchanged.currency, FactCurrency::Current);
    assert_eq!(unchanged.sentence, trusted.sentence);
    assert_eq!(
        decided.decision,
        ProposalDecision::Rejected {
            by: "owner".to_owned()
        }
    );
    let (accepted, closed) = decide_proposal(
        &commit.proposals[0],
        &OwnerDecision::Accept {
            by: "owner".to_owned(),
        },
        &commit.facts[0],
        Timestamp(120),
    )
    .expect("accept");
    assert_eq!(
        closed.currency,
        FactCurrency::Closed {
            valid_end: Timestamp(120)
        }
    );
    assert_eq!(closed.sentence, trusted.sentence);
    assert_eq!(closed.episode_ids, trusted.episode_ids);
    assert_eq!(
        accepted.decision,
        ProposalDecision::Accepted {
            by: "owner".to_owned()
        }
    );
}

#[test]
fn trusted_closure_ends_validity_without_rewriting_history() {
    let fact = DreamFact {
        id: FactId::new("fact_old"),
        sentence: "The vault is local.".to_owned(),
        taint: Taint::Trusted,
        lexemes: vec![LexemeId::new("vault")],
        episode_ids: vec![EpisodeId::new("episode_owner")],
        entity_id: Some(EntityId::new("entity_kept")),
        claim_ids: Vec::new(),
        valid_from: Timestamp(20),
        hold: None,
        currency: FactCurrency::Current,
    };
    let snapshot = ConsolidationSnapshot {
        claims: vec![claim(
            "claim_owner",
            "The vault is local.",
            Taint::Trusted,
            "episode_owner",
        )],
        episodes: vec![episode("episode_owner", 20, Taint::Trusted, "vault")],
        facts: vec![fact.clone()],
        entities: vec![EntityRow {
            id: EntityId::new("entity_kept"),
            slug: "kept".to_owned(),
            description: "Kept entity.".to_owned(),
            scope: EntityScope::World,
            see: Vec::new(),
            taint: Taint::Trusted,
        }],
        corrections: Vec::new(),
        mentions: vec![mention("claim_owner", "episode_owner")],
        participants: BTreeSet::new(),
    };
    let response = r#"{"entities":[],"canonical_facts":[{"id":"fact_new","entity_id":"entity_kept","sentence":"The vault is local.","claim_ids":["claim_owner"],"episode_ids":["episode_owner"]}],"merges":[],"closures":[{"fact_id":"fact_old","replacement_fact_id":null}],"dismissals":[]}"#;
    let commit = describe_consolidation(&request(
        &snapshot,
        &snapshot,
        response,
        ConsolidationFault::None,
    ))
    .expect("close");
    assert!(commit.proposals.is_empty());
    assert_eq!(commit.facts[0].sentence, fact.sentence);
    assert_eq!(commit.facts[0].episode_ids, fact.episode_ids);
    assert_eq!(
        commit.facts[0].currency,
        FactCurrency::Closed {
            valid_end: Timestamp(100)
        }
    );
    assert_eq!(commit.facts[1].valid_from, Timestamp(20));
}
