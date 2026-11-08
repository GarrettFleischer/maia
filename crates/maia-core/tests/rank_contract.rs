//! Retrieval ranking contracts from `docs/design/02-brain.md`.

use std::collections::{BTreeMap, BTreeSet};

use maia_core::agents::AgentId;
use maia_core::audit::Timestamp;
use maia_core::brain::{
    ClaimId, EmbedderModel, EpisodeId, FactId, GraphClaim, GraphEdge, GraphEpisode, GraphFact,
    LexemeId, MemoryRef, MemoryScope, NodeId, PageRankParams, QuarantineSet, QueryEmbedding,
    RankError, RankPolicy, RecallGraph, RecallItem, RecallQuery, RecallTaintMode, ScoreWeights,
    StoredEmbedding, rank_paths,
};
use maia_core::credit::{AgeUnit, WeightedPresentation};
use maia_core::security::Taint;

const NOW: Timestamp = Timestamp(100);
const DECAY: f64 = 0.5;

fn lexical() -> maia_core::brain::LexicalPolicy {
    maia_core::brain::LexicalPolicy {
        stopwords: BTreeSet::from(["the".to_owned(), "is".to_owned()]),
        fan_out: BTreeMap::new(),
        high_fan_cutoff: 100,
    }
}

fn policy(activation: f64, pagerank: f64, embedding: f64, threshold: f64) -> RankPolicy {
    RankPolicy {
        decay: DECAY,
        age_unit: AgeUnit::Seconds,
        lexical: lexical(),
        pagerank: PageRankParams {
            damping: 0.5,
            iterations: 1,
        },
        weights: ScoreWeights {
            activation,
            pagerank,
            embedding,
        },
        inclusion_threshold: threshold,
        recall_token_budget: 1000,
        taint_mode: RecallTaintMode::IncludeUntrusted,
    }
}

fn embedding(model: &str, values: &[f64]) -> StoredEmbedding {
    StoredEmbedding {
        values: values.to_vec(),
        model: EmbedderModel::new(model),
    }
}

fn fact(id: &str, sentence: &str, lexemes: &[&str]) -> (FactId, GraphFact) {
    (
        FactId::new(id),
        GraphFact {
            sentence: sentence.to_owned(),
            taint: Taint::Trusted,
            scope: MemoryScope::World,
            lexemes: lexemes
                .iter()
                .map(|lexeme| LexemeId::new(*lexeme))
                .collect(),
            embedding: None,
            presentations: Vec::new(),
            valid_from: Timestamp(0),
            valid_end: None,
            consolidates: Vec::new(),
        },
    )
}

fn claim(id: &str, sentence: &str, lexemes: &[&str]) -> (ClaimId, GraphClaim) {
    (
        ClaimId::new(id),
        GraphClaim {
            sentence: sentence.to_owned(),
            taint: Taint::Trusted,
            scope: MemoryScope::World,
            lexemes: lexemes
                .iter()
                .map(|lexeme| LexemeId::new(*lexeme))
                .collect(),
            embedding: None,
            presentations: Vec::new(),
            consolidated_by: None,
            source_episode: None,
        },
    )
}

fn graph_with_facts(facts: Vec<(FactId, GraphFact)>, edges: Vec<GraphEdge>) -> RecallGraph {
    let mut lexemes = BTreeSet::new();
    for (_, fact) in &facts {
        lexemes.extend(fact.lexemes.iter().cloned());
    }
    for edge in &edges {
        if let NodeId::Lexeme(id) = &edge.from {
            lexemes.insert(id.clone());
        }
        if let NodeId::Lexeme(id) = &edge.to {
            lexemes.insert(id.clone());
        }
    }
    RecallGraph {
        claims: BTreeMap::new(),
        facts: facts.into_iter().collect(),
        episodes: BTreeMap::new(),
        lexemes,
        edges,
    }
}

fn query(text: &str) -> RecallQuery {
    RecallQuery {
        text: text.to_owned(),
        embedding: None,
    }
}

fn empty_participants() -> BTreeSet<AgentId> {
    BTreeSet::new()
}

fn empty_quarantine() -> QuarantineSet {
    QuarantineSet::new([])
}

fn item_ids(paths: &[maia_core::brain::RankedPath]) -> Vec<String> {
    paths
        .iter()
        .map(|path| match &path.item {
            RecallItem::Claim { claim_id } => claim_id.as_str().to_owned(),
            RecallItem::Fact { fact_id } => fact_id.as_str().to_owned(),
        })
        .collect()
}

#[test]
fn pagerank_on_two_facts_matches_hand_iteration() {
    // Nodes in order: Lexeme(bob), Fact(fact_a), Fact(fact_b)
    // Edges: bob→fact_a, fact_a→fact_b. Dangling fact_b redistributes to seeds.
    // α=0.5, r0=u=[1,0,0], one iteration → r=[0.5, 0.5, 0]
    let (fact_a_id, fact_a) = fact("fact_a", "Alpha exists.", &["bob"]);
    let (fact_b_id, fact_b) = fact("fact_b", "Beta exists.", &[]);
    let graph = graph_with_facts(
        vec![(fact_a_id.clone(), fact_a), (fact_b_id.clone(), fact_b)],
        vec![
            GraphEdge {
                from: NodeId::Lexeme(LexemeId::new("bob")),
                to: NodeId::Fact(fact_a_id.clone()),
                weight: 1.0,
            },
            GraphEdge {
                from: NodeId::Fact(fact_a_id.clone()),
                to: NodeId::Fact(fact_b_id.clone()),
                weight: 1.0,
            },
        ],
    );
    let ranked = rank_paths(
        &graph,
        &query("bob"),
        NOW,
        &policy(0.0, 1.0, 0.0, 0.25),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("PPR fixture");
    assert_eq!(item_ids(&ranked), vec!["fact_a".to_owned()]);
    assert!(
        (ranked[0].scores.pagerank - 0.5).abs() < 1e-12,
        "hand-computed PPR mass for fact_a is 0.5, got {}",
        ranked[0].scores.pagerank
    );
    assert_eq!(
        ranked[0].walked,
        vec![
            NodeId::Lexeme(LexemeId::new("bob")),
            NodeId::Fact(fact_a_id)
        ]
    );
}

#[test]
fn private_agent_fact_never_candidates_or_spreads() {
    let (private_id, mut private) = fact("fact_private", "Secret recipe.", &["bob"]);
    private.scope = MemoryScope::Agent(AgentId(99));
    let (public_id, public) = fact("fact_public", "Public menu.", &["bob"]);
    let graph = graph_with_facts(
        vec![(private_id.clone(), private), (public_id.clone(), public)],
        vec![
            GraphEdge {
                from: NodeId::Lexeme(LexemeId::new("bob")),
                to: NodeId::Fact(private_id.clone()),
                weight: 1.0,
            },
            GraphEdge {
                from: NodeId::Fact(private_id),
                to: NodeId::Fact(public_id.clone()),
                weight: 1.0,
            },
        ],
    );
    let ranked = rank_paths(
        &graph,
        &query("bob"),
        NOW,
        &policy(0.0, 1.0, 0.0, -1.0),
        &empty_quarantine(),
        &BTreeSet::from([AgentId(1)]),
    )
    .expect("participant filter");
    assert_eq!(item_ids(&ranked), vec!["fact_public".to_owned()]);
    assert!(
        ranked[0].scores.pagerank.abs() < 1e-12,
        "private fact must not spread into public: {}",
        ranked[0].scores.pagerank
    );
}

#[test]
fn quarantine_omits_candidate_and_spreading() {
    let (held_id, held) = fact("fact_held", "Held sentence.", &["bob"]);
    let (open_id, open) = fact("fact_open", "Open sentence.", &["bob"]);
    let graph = graph_with_facts(
        vec![(held_id.clone(), held), (open_id.clone(), open)],
        vec![
            GraphEdge {
                from: NodeId::Lexeme(LexemeId::new("bob")),
                to: NodeId::Fact(held_id.clone()),
                weight: 1.0,
            },
            GraphEdge {
                from: NodeId::Fact(held_id.clone()),
                to: NodeId::Fact(open_id.clone()),
                weight: 1.0,
            },
        ],
    );
    let ranked = rank_paths(
        &graph,
        &query("bob"),
        NOW,
        &policy(0.0, 1.0, 0.0, -1.0),
        &QuarantineSet::new([MemoryRef::Fact(held_id)]),
        &empty_participants(),
    )
    .expect("quarantine");
    assert_eq!(item_ids(&ranked), vec!["fact_open".to_owned()]);
    assert!(
        ranked[0].scores.pagerank.abs() < 1e-12,
        "quarantined node must not spread"
    );
}

#[test]
fn trusted_only_omits_untrusted_facts() {
    let (trusted_id, trusted) = fact("fact_trusted", "Trusted sentence.", &["bob"]);
    let (untrusted_id, mut untrusted) = fact("fact_untrusted", "Untrusted sentence.", &["bob"]);
    untrusted.taint = Taint::Untrusted;
    let graph = graph_with_facts(
        vec![(trusted_id, trusted), (untrusted_id, untrusted)],
        vec![GraphEdge {
            from: NodeId::Lexeme(LexemeId::new("bob")),
            to: NodeId::Fact(FactId::new("fact_trusted")),
            weight: 1.0,
        }],
    );
    let mut policy = policy(0.0, 1.0, 0.0, -1.0);
    policy.taint_mode = RecallTaintMode::TrustedOnly;
    let ranked = rank_paths(
        &graph,
        &query("bob"),
        NOW,
        &policy,
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("taint filter");
    assert_eq!(item_ids(&ranked), vec!["fact_trusted".to_owned()]);
}

#[test]
fn superseded_claim_is_absent_and_canonical_fact_is_returned() {
    let (claim_id, mut provisional) = claim(
        "claim_burgers",
        "The project is named Bob's Best Burgers",
        &["bob"],
    );
    let (fact_id, mut canonical) = fact(
        "fact_burgers",
        "The project is named Bob's Best Burgers",
        &["bob"],
    );
    provisional.consolidated_by = Some(fact_id.clone());
    canonical.consolidates.push(claim_id.clone());
    let graph = RecallGraph {
        claims: BTreeMap::from([(claim_id, provisional)]),
        facts: BTreeMap::from([(fact_id.clone(), canonical)]),
        episodes: BTreeMap::new(),
        lexemes: BTreeSet::from([LexemeId::new("bob")]),
        edges: vec![GraphEdge {
            from: NodeId::Lexeme(LexemeId::new("bob")),
            to: NodeId::Fact(fact_id.clone()),
            weight: 1.0,
        }],
    };
    let ranked = rank_paths(
        &graph,
        &query("bob's"),
        NOW,
        &policy(0.0, 1.0, 0.0, -1.0),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("supersession");
    assert_eq!(item_ids(&ranked), vec!["fact_burgers".to_owned()]);
    assert!(matches!(
        ranked[0].item,
        RecallItem::Fact { fact_id: ref id } if id == &fact_id
    ));
}

#[test]
fn closed_validity_omits_superseded_fact_but_row_remains() {
    let (old_id, mut old) = fact("fact_old", "Old name.", &["bob"]);
    old.valid_end = Some(NOW);
    let (new_id, new) = fact("fact_new", "New name.", &["bob"]);
    let graph = graph_with_facts(
        vec![(old_id.clone(), old), (new_id.clone(), new)],
        vec![GraphEdge {
            from: NodeId::Lexeme(LexemeId::new("bob")),
            to: NodeId::Fact(new_id.clone()),
            weight: 1.0,
        }],
    );
    let ranked = rank_paths(
        &graph,
        &query("bob"),
        NOW,
        &policy(0.0, 1.0, 0.0, -1.0),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("validity");
    assert_eq!(item_ids(&ranked), vec!["fact_new".to_owned()]);
    assert!(
        graph.facts.contains_key(&old_id),
        "superseded fact row remains in the graph"
    );
}

#[test]
fn equal_scores_break_ties_by_stable_id_regardless_of_insert_order() {
    let (z_id, z) = fact("fact_z", "Zee.", &[]);
    let (a_id, a) = fact("fact_a", "Ay.", &[]);
    let first = graph_with_facts(
        vec![(z_id.clone(), z.clone()), (a_id.clone(), a.clone())],
        vec![],
    );
    let second = graph_with_facts(vec![(a_id, a), (z_id, z)], vec![]);
    let policy = policy(0.0, 0.0, 0.0, -1.0);
    let left = rank_paths(
        &first,
        &query("unused"),
        NOW,
        &policy,
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("order a");
    let right = rank_paths(
        &second,
        &query("unused"),
        NOW,
        &policy,
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("order b");
    assert_eq!(
        item_ids(&left),
        vec!["fact_a".to_owned(), "fact_z".to_owned()]
    );
    assert_eq!(item_ids(&left), item_ids(&right));
}

#[test]
fn cold_fact_crosses_threshold_after_relevant_walk() {
    let (hot_id, hot) = fact("fact_hot", "Hot sentence.", &["bob"]);
    let (cold_id, cold) = fact("fact_cold", "Cold sentence.", &["bob"]);
    let mut graph = graph_with_facts(
        vec![(hot_id.clone(), hot), (cold_id.clone(), cold)],
        vec![GraphEdge {
            from: NodeId::Lexeme(LexemeId::new("bob")),
            to: NodeId::Fact(hot_id.clone()),
            weight: 1.0,
        }],
    );
    let policy = policy(0.0, 1.0, 0.0, 0.25);
    let before = rank_paths(
        &graph,
        &query("bob"),
        NOW,
        &policy,
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("cold before");
    assert_eq!(item_ids(&before), vec!["fact_hot".to_owned()]);
    graph.edges.push(GraphEdge {
        from: NodeId::Lexeme(LexemeId::new("bob")),
        to: NodeId::Fact(cold_id.clone()),
        weight: 1.0,
    });
    let after = rank_paths(
        &graph,
        &query("bob"),
        NOW,
        &policy,
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("cold after");
    assert_eq!(
        item_ids(&after),
        vec!["fact_cold".to_owned(), "fact_hot".to_owned()]
    );
}

#[test]
fn missing_embedding_keeps_lexeme_channel() {
    let (id, fact) = fact("fact_plain", "Plain sentence.", &["bob"]);
    let graph = graph_with_facts(
        vec![(id, fact)],
        vec![GraphEdge {
            from: NodeId::Lexeme(LexemeId::new("bob")),
            to: NodeId::Fact(FactId::new("fact_plain")),
            weight: 1.0,
        }],
    );
    let ranked = rank_paths(
        &graph,
        &query("bob"),
        NOW,
        &policy(0.0, 1.0, 1.0, 0.25),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("missing embedding");
    assert_eq!(item_ids(&ranked), vec!["fact_plain".to_owned()]);
    assert_eq!(ranked[0].scores.embedding, None);
}

#[test]
fn incompatible_embedder_versions_are_not_compared() {
    let (id, mut item) = fact("fact_vec", "Vector sentence.", &["bob"]);
    item.embedding = Some(embedding("model-a", &[1.0, 0.0]));
    let graph = graph_with_facts(
        vec![(id, item)],
        vec![GraphEdge {
            from: NodeId::Lexeme(LexemeId::new("bob")),
            to: NodeId::Fact(FactId::new("fact_vec")),
            weight: 1.0,
        }],
    );
    let mut recall = query("bob");
    recall.embedding = Some(QueryEmbedding {
        values: vec![1.0, 0.0],
        model: EmbedderModel::new("model-b"),
    });
    let ranked = rank_paths(
        &graph,
        &recall,
        NOW,
        &policy(0.0, 1.0, 1.0, 0.25),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("incompatible vectors");
    assert_eq!(ranked[0].scores.embedding, None);
}

#[test]
fn no_eligible_lexemes_still_ranks_by_embedding() {
    let (id, mut item) = fact("fact_embed", "The widget exists.", &[]);
    item.embedding = Some(embedding("model-a", &[1.0, 0.0]));
    let graph = graph_with_facts(vec![(id, item)], vec![]);
    let recall = RecallQuery {
        text: "the".to_owned(),
        embedding: Some(QueryEmbedding {
            values: vec![1.0, 0.0],
            model: EmbedderModel::new("model-a"),
        }),
    };
    let ranked = rank_paths(
        &graph,
        &recall,
        NOW,
        &policy(0.0, 0.0, 1.0, 0.5),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("embedding channel");
    assert_eq!(item_ids(&ranked), vec!["fact_embed".to_owned()]);
    assert!(
        (ranked[0]
            .scores
            .embedding
            .expect("identical compatible vectors have a score")
            - 1.0)
            .abs()
            < 1e-12,
        "identical vectors have cosine 1"
    );
}

#[test]
fn ranking_skips_future_presentations_and_uses_remaining() {
    let (id, mut item) = fact("fact_aged", "Aged sentence.", &[]);
    item.presentations = vec![
        WeightedPresentation {
            weight: 1.0,
            presented_at: Timestamp(200),
        },
        WeightedPresentation {
            weight: 1.0,
            presented_at: Timestamp(96),
        },
    ];
    let graph = graph_with_facts(vec![(id, item)], vec![]);
    let ranked = rank_paths(
        &graph,
        &query("none"),
        NOW,
        &policy(1.0, 0.0, 0.0, -1.0),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("clock skew skip");
    assert!(
        (ranked[0]
            .scores
            .activation
            .expect("one usable presentation has activation")
            + 2.0_f64.ln())
        .abs()
            < 1e-12,
        "remaining age-4 presentation is ln(1/2), got {:?}",
        ranked[0].scores.activation
    );
}

#[test]
fn empty_presentations_are_explicit_absent_activation() {
    let (id, item) = fact("fact_new", "New sentence.", &[]);
    let graph = graph_with_facts(vec![(id, item)], vec![]);
    let ranked = rank_paths(
        &graph,
        &query("none"),
        NOW,
        &policy(1.0, 0.0, 0.0, -1.0),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("absent activation");
    assert_eq!(ranked[0].scores.activation, None);
    assert_eq!(ranked[0].scores.combined, 0.0);
}

#[test]
fn cross_thread_bobs_query_returns_promoted_claim() {
    let (claim_id, provisional) = claim(
        "claim_burgers",
        "The project is named Bob's Best Burgers",
        &["bob"],
    );
    let graph = RecallGraph {
        claims: BTreeMap::from([(claim_id.clone(), provisional)]),
        facts: BTreeMap::new(),
        episodes: BTreeMap::new(),
        lexemes: BTreeSet::from([LexemeId::new("bob")]),
        edges: vec![GraphEdge {
            from: NodeId::Lexeme(LexemeId::new("bob")),
            to: NodeId::Claim(claim_id.clone()),
            weight: 1.0,
        }],
    };
    let ranked = rank_paths(
        &graph,
        &query("bob's"),
        NOW,
        &policy(0.0, 1.0, 0.0, 0.25),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("cross-thread claim");
    assert_eq!(item_ids(&ranked), vec!["claim_burgers".to_owned()]);
    assert_eq!(
        ranked[0].sentence,
        "The project is named Bob's Best Burgers"
    );
    assert!(matches!(
        ranked[0].item,
        RecallItem::Claim { claim_id: ref id } if id == &claim_id
    ));
}

#[test]
fn newly_stored_episode_is_discoverable_before_promotion() {
    let episode_id = EpisodeId::new("episode_1");
    let graph = RecallGraph {
        claims: BTreeMap::new(),
        facts: BTreeMap::new(),
        episodes: BTreeMap::from([(
            episode_id.clone(),
            GraphEpisode {
                text: "The project is named Bob's Best Burgers".to_owned(),
                lexemes: vec![LexemeId::new("bob")],
                embedding: Some(embedding("model-a", &[0.0, 1.0])),
            },
        )]),
        lexemes: BTreeSet::from([LexemeId::new("bob")]),
        edges: Vec::new(),
    };
    let by_lexeme = graph.discover_episodes(&query("bob's"), &lexical());
    let by_text = graph.discover_episodes(&query("Best Burgers"), &lexical());
    let by_vector = graph.discover_episodes(
        &RecallQuery {
            text: String::new(),
            embedding: Some(QueryEmbedding {
                values: vec![0.0, 1.0],
                model: EmbedderModel::new("model-a"),
            }),
        },
        &lexical(),
    );
    assert_eq!(by_lexeme, vec![episode_id.clone()]);
    assert_eq!(by_text, vec![episode_id.clone()]);
    assert_eq!(by_vector, vec![episode_id]);
    let ranked = rank_paths(
        &graph,
        &query("bob's"),
        NOW,
        &policy(0.0, 1.0, 0.0, 0.0),
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect("no claims yet");
    assert!(ranked.is_empty(), "episodes are not recall-block items");
}

#[test]
fn non_finite_policy_inputs_are_rejected() {
    let graph = graph_with_facts(vec![fact("fact_x", "X.", &[])], vec![]);
    let mut bad = policy(1.0, 0.0, 0.0, 0.0);
    bad.decay = f64::NAN;
    let error = rank_paths(
        &graph,
        &query("x"),
        NOW,
        &bad,
        &empty_quarantine(),
        &empty_participants(),
    )
    .expect_err("NaN decay");
    assert_eq!(error, RankError::NonFiniteDecay);
}
