//! A claim with no query words is recalled only along a co-use path.

use std::collections::{BTreeMap, BTreeSet};

use maia_core::agents::AgentId;
use maia_core::audit::Timestamp;
use maia_core::brain::ClaimId;
use maia_core::brain::GraphClaim;
use maia_core::brain::GraphEdge;
use maia_core::brain::LexemeId;
use maia_core::brain::LexicalPolicy;
use maia_core::brain::MemoryScope;
use maia_core::brain::NodeId;
use maia_core::brain::PageRankParams;
use maia_core::brain::QuarantineSet;
use maia_core::brain::RankPolicy;
use maia_core::brain::RecallGraph;
use maia_core::brain::RecallItem;
use maia_core::brain::RecallQuery;
use maia_core::brain::RecallTaintMode;
use maia_core::brain::ScoreWeights;
use maia_core::brain::rank_paths;
use maia_core::credit::AgeUnit;
use maia_core::security::Taint;

fn claim(id: &str, sentence: &str) -> (ClaimId, GraphClaim) {
    (
        ClaimId::new(id),
        GraphClaim {
            sentence: sentence.to_owned(),
            taint: Taint::Trusted,
            scope: MemoryScope::World,
            lexemes: Vec::new(),
            embedding: None,
            presentations: Vec::new(),
            consolidated_by: None,
            source_episode: None,
        },
    )
}

fn policy() -> RankPolicy {
    RankPolicy {
        decay: 0.5,
        age_unit: AgeUnit::Seconds,
        lexical: LexicalPolicy {
            stopwords: BTreeSet::from(["the".to_owned(), "is".to_owned(), "in".to_owned()]),
            fan_out: BTreeMap::new(),
            high_fan_cutoff: 100,
        },
        pagerank: PageRankParams {
            damping: 0.5,
            iterations: 2,
        },
        weights: ScoreWeights {
            activation: 0.0,
            pagerank: 1.0,
            embedding: 0.0,
        },
        inclusion_threshold: 0.05,
        recall_token_budget: 800,
        taint_mode: RecallTaintMode::IncludeUntrusted,
    }
}

fn graph(co_use: f64, related: f64) -> RecallGraph {
    let (anchor_id, anchor) = claim("claim-anchor", "The kitchen is in Portland.");
    let (far_id, far) = claim("claim-far", "Zephyr holds the indigo token.");
    let (light_id, light) = claim("claim-light", "Quartz marks the violet ledger.");
    let mut claims = BTreeMap::new();
    claims.insert(anchor_id.clone(), anchor);
    claims.insert(far_id.clone(), far);
    claims.insert(light_id.clone(), light);
    RecallGraph {
        claims,
        facts: BTreeMap::new(),
        episodes: BTreeMap::new(),
        lexemes: BTreeSet::from([LexemeId::new("portland"), LexemeId::new("kitchen")]),
        edges: vec![
            GraphEdge {
                from: NodeId::Lexeme(LexemeId::new("portland")),
                to: NodeId::Claim(anchor_id.clone()),
                weight: 1.0,
            },
            GraphEdge {
                from: NodeId::Claim(anchor_id.clone()),
                to: NodeId::Claim(far_id),
                weight: co_use,
            },
            GraphEdge {
                from: NodeId::Claim(anchor_id),
                to: NodeId::Claim(light_id),
                weight: related,
            },
        ],
    }
}

#[test]
fn a_claim_with_no_query_words_is_recalled_only_through_a_co_used_neighbor() {
    let ranked = rank_paths(
        &graph(1.0, 0.0),
        &RecallQuery {
            text: "portland".to_owned(),
            embedding: None,
        },
        Timestamp(1_735_000_000),
        &policy(),
        &QuarantineSet::default(),
        &BTreeSet::<AgentId>::new(),
    )
    .expect("rank");
    let far = ranked
        .iter()
        .find(|path| path.item == RecallItem::Claim { claim_id: ClaimId::new("claim-far") })
        .expect("far claim");
    assert!(far.walked.iter().any(|node| {
        matches!(node, NodeId::Claim(id) if id.as_str() == "claim-anchor")
    }));
    assert!(!far.sentence.to_ascii_lowercase().contains("portland"));
    let without = rank_paths(
        &graph(0.0, 0.0),
        &RecallQuery {
            text: "portland".to_owned(),
            embedding: None,
        },
        Timestamp(1_735_000_000),
        &policy(),
        &QuarantineSet::default(),
        &BTreeSet::<AgentId>::new(),
    )
    .expect("rank");
    assert!(without.iter().all(|path| {
        path.item
            != (RecallItem::Claim {
                claim_id: ClaimId::new("claim-far"),
            })
    }));
}

#[test]
fn a_heavier_edge_spreads_more_than_a_lighter_relatedness_edge() {
    let ranked = rank_paths(
        &graph(1.0, 0.2),
        &RecallQuery {
            text: "portland".to_owned(),
            embedding: None,
        },
        Timestamp(1_735_000_000),
        &policy(),
        &QuarantineSet::default(),
        &BTreeSet::<AgentId>::new(),
    )
    .expect("rank");
    let score = |id: &str| {
        ranked
            .iter()
            .find(|path| path.item == RecallItem::Claim { claim_id: ClaimId::new(id) })
            .map(|path| path.scores.pagerank)
            .unwrap_or(0.0)
    };
    assert!(score("claim-far") > score("claim-light"));
}
