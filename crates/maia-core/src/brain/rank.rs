//! Deterministic retrieval ranking.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::agents::AgentId;
use crate::audit::Timestamp;
use crate::brain::graph::{
    ComponentScores, GraphClaim, GraphFact, MemoryScope, QuarantineSet, QueryEmbedding, RankError,
    RankPolicy, RankedPath, RecallGraph, RecallItem, RecallQuery, RecallTaintMode, StoredEmbedding,
};
use crate::brain::ids::{ClaimId, FactId, LexemeId, MemoryRef, NodeId};
use crate::brain::lexemes::lexemes_for_sentence;
use crate::credit::{ActivationError, AgeUnit, WeightedPresentation, activation};
use crate::security::Taint;

/// Ranks eligible claims and facts from an already-loaded graph.
pub fn rank_paths(
    graph: &RecallGraph,
    query: &RecallQuery,
    now: Timestamp,
    policy: &RankPolicy,
    quarantine: &QuarantineSet,
    participants: &BTreeSet<AgentId>,
) -> Result<Vec<RankedPath>, RankError> {
    validate_policy(policy)?;
    let eligible = eligible_items(graph, now, policy.taint_mode, quarantine, participants);
    let seeds = query_seeds(query, policy, graph);
    let pagerank = personalized_pagerank(graph, &eligible, &seeds, policy)?;
    let adjacency = adjacency(graph, &eligible)?;
    let mut ranked = Vec::new();
    for item in &eligible {
        let Some((sentence, taint, presentations, stored)) = item_view(graph, item) else {
            continue;
        };
        let activation_score =
            candidate_activation(presentations, now, policy.decay, policy.age_unit)?;
        let embedding_score = embedding_similarity(query.embedding.as_ref(), stored)?;
        let node = item_node(item);
        let pagerank_score = pagerank.get(&node).copied().unwrap_or(0.0);
        let combined = combine(policy, activation_score, pagerank_score, embedding_score);
        if combined < policy.inclusion_threshold {
            continue;
        }
        ranked.push(RankedPath {
            walked: walked_path(&seeds, &node, &adjacency),
            item: item.clone(),
            sentence: sentence.to_owned(),
            taint,
            scores: ComponentScores {
                activation: activation_score,
                pagerank: pagerank_score,
                embedding: embedding_score,
                combined,
                tie_break: item.tie_break_key().to_owned(),
            },
        });
    }
    ranked.sort_by(|left, right| {
        right
            .scores
            .combined
            .total_cmp(&left.scores.combined)
            .then_with(|| left.scores.tie_break.cmp(&right.scores.tie_break))
    });
    Ok(ranked)
}

fn validate_policy(policy: &RankPolicy) -> Result<(), RankError> {
    if !policy.decay.is_finite() {
        return Err(RankError::NonFiniteDecay);
    }
    if policy.decay <= 0.0 {
        return Err(RankError::NonPositiveDecay);
    }
    if !policy.weights.activation.is_finite()
        || !policy.weights.pagerank.is_finite()
        || !policy.weights.embedding.is_finite()
    {
        return Err(RankError::NonFiniteCoefficient);
    }
    if !policy.inclusion_threshold.is_finite() {
        return Err(RankError::NonFiniteThreshold);
    }
    if !policy.pagerank.damping.is_finite() {
        return Err(RankError::NonFiniteDamping);
    }
    Ok(())
}

fn eligible_items(
    graph: &RecallGraph,
    now: Timestamp,
    taint_mode: RecallTaintMode,
    quarantine: &QuarantineSet,
    participants: &BTreeSet<AgentId>,
) -> Vec<RecallItem> {
    let mut items = Vec::new();
    for (id, claim) in &graph.claims {
        if claim_eligible(id, claim, taint_mode, quarantine, participants) {
            items.push(RecallItem::Claim {
                claim_id: id.clone(),
            });
        }
    }
    for (id, fact) in &graph.facts {
        if fact_eligible(id, fact, now, taint_mode, quarantine, participants) {
            items.push(RecallItem::Fact {
                fact_id: id.clone(),
            });
        }
    }
    items
}

fn claim_eligible(
    id: &ClaimId,
    claim: &GraphClaim,
    taint_mode: RecallTaintMode,
    quarantine: &QuarantineSet,
    participants: &BTreeSet<AgentId>,
) -> bool {
    claim.consolidated_by.is_none()
        && !quarantine.contains(&MemoryRef::Claim(id.clone()))
        && taint_allowed(claim.taint, taint_mode)
        && scope_allowed(&claim.scope, participants)
}

fn fact_eligible(
    id: &FactId,
    fact: &GraphFact,
    now: Timestamp,
    taint_mode: RecallTaintMode,
    quarantine: &QuarantineSet,
    participants: &BTreeSet<AgentId>,
) -> bool {
    fact_current(fact, now)
        && !quarantine.contains(&MemoryRef::Fact(id.clone()))
        && taint_allowed(fact.taint, taint_mode)
        && scope_allowed(&fact.scope, participants)
}

fn fact_current(fact: &GraphFact, now: Timestamp) -> bool {
    fact.valid_from.0 <= now.0 && fact.valid_end.is_none_or(|end| end.0 > now.0)
}

fn taint_allowed(taint: Taint, mode: RecallTaintMode) -> bool {
    match mode {
        RecallTaintMode::IncludeUntrusted => true,
        RecallTaintMode::TrustedOnly => taint == Taint::Trusted,
    }
}

fn scope_allowed(scope: &MemoryScope, participants: &BTreeSet<AgentId>) -> bool {
    match scope {
        MemoryScope::World | MemoryScope::Unscoped => true,
        MemoryScope::Agent(agent) => participants.contains(agent),
    }
}

fn query_seeds(query: &RecallQuery, policy: &RankPolicy, graph: &RecallGraph) -> Vec<LexemeId> {
    let mut seeds = Vec::new();
    let mut seen = BTreeSet::new();
    for lexeme in lexemes_for_sentence(&query.text, &policy.lexical) {
        if graph.lexemes.contains(&lexeme) && seen.insert(lexeme.clone()) {
            seeds.push(lexeme);
        }
    }
    seeds
}

fn item_view<'a>(
    graph: &'a RecallGraph,
    item: &RecallItem,
) -> Option<(
    &'a str,
    Taint,
    &'a [WeightedPresentation],
    Option<&'a StoredEmbedding>,
)> {
    match item {
        RecallItem::Claim { claim_id } => graph.claims.get(claim_id).map(|claim| {
            (
                claim.sentence.as_str(),
                claim.taint,
                claim.presentations.as_slice(),
                claim.embedding.as_ref(),
            )
        }),
        RecallItem::Fact { fact_id } => graph.facts.get(fact_id).map(|fact| {
            (
                fact.sentence.as_str(),
                fact.taint,
                fact.presentations.as_slice(),
                fact.embedding.as_ref(),
            )
        }),
    }
}

fn item_node(item: &RecallItem) -> NodeId {
    match item {
        RecallItem::Claim { claim_id } => NodeId::Claim(claim_id.clone()),
        RecallItem::Fact { fact_id } => NodeId::Fact(fact_id.clone()),
    }
}

fn candidate_activation(
    presentations: &[WeightedPresentation],
    now: Timestamp,
    decay: f64,
    age_unit: AgeUnit,
) -> Result<Option<f64>, RankError> {
    let mut usable = Vec::new();
    for presentation in presentations {
        if !presentation.weight.is_finite() {
            return Err(RankError::InvalidPresentationWeight);
        }
        if presentation.weight < 0.0 {
            return Err(RankError::InvalidPresentationWeight);
        }
        if age_seconds(now, presentation.presented_at, age_unit).is_none() {
            continue;
        }
        usable.push(presentation.clone());
    }
    if usable.is_empty() {
        return Ok(None);
    }
    match activation(&usable, now, decay, age_unit) {
        Ok(score) => Ok(Some(score)),
        Err(ActivationError::NoPresentations | ActivationError::NonPositiveMass) => Ok(None),
        Err(_) => Err(RankError::InvalidPresentationWeight),
    }
}

fn age_seconds(now: Timestamp, presented_at: Timestamp, age_unit: AgeUnit) -> Option<f64> {
    match age_unit {
        AgeUnit::Seconds => {
            let delta = now.0.checked_sub(presented_at.0)?;
            if delta <= 0 { None } else { Some(delta as f64) }
        }
    }
}

fn embedding_similarity(
    query: Option<&QueryEmbedding>,
    stored: Option<&StoredEmbedding>,
) -> Result<Option<f64>, RankError> {
    let (Some(query), Some(stored)) = (query, stored) else {
        return Ok(None);
    };
    if query.model != stored.model || query.values.len() != stored.values.len() {
        return Ok(None);
    }
    cosine(&query.values, &stored.values)
}

fn cosine(left: &[f64], right: &[f64]) -> Result<Option<f64>, RankError> {
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for (left_value, right_value) in left.iter().zip(right.iter()) {
        if !left_value.is_finite() || !right_value.is_finite() {
            return Err(RankError::NonFiniteVector);
        }
        dot += left_value * right_value;
        left_norm += left_value * left_value;
        right_norm += right_value * right_value;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        return Ok(None);
    }
    Ok(Some(dot / (left_norm.sqrt() * right_norm.sqrt())))
}

fn combine(
    policy: &RankPolicy,
    activation_score: Option<f64>,
    pagerank_score: f64,
    embedding_score: Option<f64>,
) -> f64 {
    policy.weights.activation * activation_score.unwrap_or(0.0)
        + policy.weights.pagerank * pagerank_score
        + policy.weights.embedding * embedding_score.unwrap_or(0.0)
}

fn ppr_nodes(graph: &RecallGraph, eligible: &[RecallItem]) -> BTreeSet<NodeId> {
    let mut nodes = BTreeSet::new();
    for lexeme in &graph.lexemes {
        nodes.insert(NodeId::Lexeme(lexeme.clone()));
    }
    for item in eligible {
        nodes.insert(item_node(item));
    }
    for id in graph.episodes.keys() {
        nodes.insert(NodeId::Episode(id.clone()));
    }
    nodes
}

fn adjacency(
    graph: &RecallGraph,
    eligible: &[RecallItem],
) -> Result<BTreeMap<NodeId, Vec<(NodeId, f64)>>, RankError> {
    let nodes = ppr_nodes(graph, eligible);
    let mut outgoing: BTreeMap<NodeId, Vec<(NodeId, f64)>> = BTreeMap::new();
    for edge in &graph.edges {
        if !edge.weight.is_finite() {
            return Err(RankError::NonFiniteEdgeWeight);
        }
        if edge.weight <= 0.0 {
            continue;
        }
        if !nodes.contains(&edge.from) || !nodes.contains(&edge.to) {
            continue;
        }
        outgoing
            .entry(edge.from.clone())
            .or_default()
            .push((edge.to.clone(), edge.weight));
    }
    Ok(outgoing)
}

fn personalized_pagerank(
    graph: &RecallGraph,
    eligible: &[RecallItem],
    seeds: &[LexemeId],
    policy: &RankPolicy,
) -> Result<BTreeMap<NodeId, f64>, RankError> {
    let nodes: Vec<NodeId> = ppr_nodes(graph, eligible).into_iter().collect();
    if nodes.is_empty() {
        return Ok(BTreeMap::new());
    }
    let index: BTreeMap<&NodeId, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, node)| (node, i))
        .collect();
    let outgoing = adjacency(graph, eligible)?;
    let mut transitions: Vec<Vec<(usize, f64)>> = vec![Vec::new(); nodes.len()];
    for (from, edges) in &outgoing {
        let Some(&from_index) = index.get(from) else {
            continue;
        };
        let mut total = 0.0;
        for (_, weight) in edges {
            total += *weight;
        }
        if total <= 0.0 {
            continue;
        }
        for (to, weight) in edges {
            if let Some(&to_index) = index.get(to) {
                transitions[from_index].push((to_index, weight / total));
            }
        }
    }

    let mut personalization = vec![0.0; nodes.len()];
    if !seeds.is_empty() {
        let mass = 1.0 / seeds.len() as f64;
        for seed in seeds {
            if let Some(&seed_index) = index.get(&NodeId::Lexeme(seed.clone())) {
                personalization[seed_index] += mass;
            }
        }
        let seed_mass: f64 = personalization.iter().sum();
        if seed_mass == 0.0 {
            // Query lexemes were not graph nodes; lexical spreading contributes no seed.
        }
    }

    let alpha = policy.pagerank.damping;
    let mut rank = personalization.clone();
    for _ in 0..policy.pagerank.iterations {
        let mut next = vec![0.0; nodes.len()];
        for (from_index, mass) in rank.iter().enumerate() {
            if *mass == 0.0 {
                continue;
            }
            if transitions[from_index].is_empty() {
                for (to_index, seed_mass) in personalization.iter().enumerate() {
                    next[to_index] += alpha * mass * seed_mass;
                }
            } else {
                for (to_index, probability) in &transitions[from_index] {
                    next[*to_index] += alpha * mass * probability;
                }
            }
        }
        for (to_index, seed_mass) in personalization.iter().enumerate() {
            next[to_index] += (1.0 - alpha) * seed_mass;
        }
        rank = next;
    }

    let mut scores = BTreeMap::new();
    for (node, mass) in nodes.into_iter().zip(rank) {
        scores.insert(node, mass);
    }
    Ok(scores)
}

fn walked_path(
    seeds: &[LexemeId],
    target: &NodeId,
    adjacency: &BTreeMap<NodeId, Vec<(NodeId, f64)>>,
) -> Vec<NodeId> {
    if seeds.is_empty() {
        return vec![target.clone()];
    }
    let mut queue = VecDeque::new();
    let mut parent: BTreeMap<NodeId, NodeId> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for seed in seeds {
        let start = NodeId::Lexeme(seed.clone());
        if seen.insert(start.clone()) {
            queue.push_back(start);
        }
    }
    let mut reached = false;
    while let Some(current) = queue.pop_front() {
        if current == *target {
            reached = true;
            break;
        }
        let Some(neighbors) = adjacency.get(&current) else {
            continue;
        };
        let mut next_nodes: Vec<NodeId> = neighbors.iter().map(|(node, _)| node.clone()).collect();
        next_nodes.sort();
        for next in next_nodes {
            if seen.insert(next.clone()) {
                parent.insert(next.clone(), current.clone());
                queue.push_back(next);
            }
        }
    }
    if !reached {
        return vec![target.clone()];
    }
    let mut path = vec![target.clone()];
    let mut cursor = target.clone();
    while let Some(previous) = parent.get(&cursor) {
        path.push(previous.clone());
        cursor = previous.clone();
    }
    path.reverse();
    path
}
