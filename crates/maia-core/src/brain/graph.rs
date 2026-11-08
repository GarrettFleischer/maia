//! Loaded recall graph, query, and ranking policy values.

use std::collections::{BTreeMap, BTreeSet};

use crate::agents::AgentId;
use crate::audit::Timestamp;
use crate::brain::ids::{ClaimId, EpisodeId, FactId, LexemeId, MemoryRef, NodeId};
use crate::brain::lexemes::{LexicalPolicy, lexemes_for_sentence};
use crate::credit::{AgeUnit, WeightedPresentation};
use crate::security::Taint;

/// Whether ranking may surface untrusted claims and facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecallTaintMode {
    /// Default: untrusted items remain eligible.
    IncludeUntrusted,
    /// Sensitive-agent mode: omit untrusted claims and facts.
    TrustedOnly,
}

/// Vault or agent scope for a claim or fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryScope {
    /// World-scoped memory, eligible for every participant set.
    World,
    /// Unscoped shared memory, eligible for every participant set.
    Unscoped,
    /// Private to one agent.
    Agent(AgentId),
}

/// Embedder identity recorded with a vector.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EmbedderModel(String);

impl EmbedderModel {
    /// Builds a model identity.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed model identity.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stored node vector plus the embedder that produced it.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEmbedding {
    /// Finite components.
    pub values: Vec<f64>,
    /// Embedder version; incompatible versions are not compared.
    pub model: EmbedderModel,
}

/// Query vector supplied by the embedder skin.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryEmbedding {
    /// Finite components.
    pub values: Vec<f64>,
    /// Embedder version of the query vector.
    pub model: EmbedderModel,
}

/// Personalized PageRank parameters. Tests pass every number explicitly.
#[derive(Debug, Clone, PartialEq)]
pub struct PageRankParams {
    /// Probability of following an edge (`α`).
    pub damping: f64,
    /// Exact iteration count. Fixtures use a fixed count, not a tolerance.
    pub iterations: u32,
}

/// Linear combination weights for the three ranking channels.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreWeights {
    /// Weight of ACT-R base activation. Absent activation contributes `0`.
    pub activation: f64,
    /// Weight of Personalized PageRank mass.
    pub pagerank: f64,
    /// Weight of embedding cosine. Missing or incompatible vectors contribute `0`.
    pub embedding: f64,
}

/// Explicit ranking policy. No field is read from configuration or a clock.
#[derive(Debug, Clone, PartialEq)]
pub struct RankPolicy {
    /// ACT-R decay `d`.
    pub decay: f64,
    /// Age unit for activation. v1 fixtures use [`AgeUnit::Seconds`].
    pub age_unit: AgeUnit,
    /// Lexical normalization, stopwords, and high-fan cutoff.
    pub lexical: LexicalPolicy,
    /// Personalized PageRank parameters.
    pub pagerank: PageRankParams,
    /// Channel combination weights.
    pub weights: ScoreWeights,
    /// Minimum combined score that may enter the result.
    pub inclusion_threshold: f64,
    /// Recall-block token budget. Packing is applied by `append_recall`, not here.
    pub recall_token_budget: u32,
    /// Whether untrusted claims and facts may participate.
    pub taint_mode: RecallTaintMode,
}

/// Query text and optional fixture vector.
#[derive(Debug, Clone, PartialEq)]
pub struct RecallQuery {
    /// Raw query text. Lexemes are derived with [`LexicalPolicy`].
    pub text: String,
    /// Optional query embedding.
    pub embedding: Option<QueryEmbedding>,
}

/// Provisional claim already loaded into the ranker.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphClaim {
    /// One declarative sentence.
    pub sentence: String,
    /// Claim taint copied from promotion.
    pub taint: Taint,
    /// Agent or shared scope.
    pub scope: MemoryScope,
    /// Known lexeme associations.
    pub lexemes: Vec<LexemeId>,
    /// Optional fixture vector.
    pub embedding: Option<StoredEmbedding>,
    /// Traced presentations.
    pub presentations: Vec<WeightedPresentation>,
    /// Canonical fact that consolidated this claim, if any.
    pub consolidated_by: Option<FactId>,
    /// Source episode when known.
    pub source_episode: Option<EpisodeId>,
}

/// Canonical fact already loaded into the ranker.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphFact {
    /// One declarative sentence.
    pub sentence: String,
    /// Fact taint from consolidation context.
    pub taint: Taint,
    /// Agent or shared scope.
    pub scope: MemoryScope,
    /// Known lexeme associations.
    pub lexemes: Vec<LexemeId>,
    /// Optional fixture vector.
    pub embedding: Option<StoredEmbedding>,
    /// Traced presentations.
    pub presentations: Vec<WeightedPresentation>,
    /// Validity start.
    pub valid_from: Timestamp,
    /// Closed when a newer fact supersedes this one.
    pub valid_end: Option<Timestamp>,
    /// Claims this fact consolidated.
    pub consolidates: Vec<ClaimId>,
}

/// Episode retained for pre-promotion discoverability.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphEpisode {
    /// Full episode text.
    pub text: String,
    /// Known lexeme associations.
    pub lexemes: Vec<LexemeId>,
    /// Optional fixture vector.
    pub embedding: Option<StoredEmbedding>,
}

/// Directed weighted edge between already-loaded nodes.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphEdge {
    /// Edge origin.
    pub from: NodeId,
    /// Edge destination.
    pub to: NodeId,
    /// Positive finite weight.
    pub weight: f64,
}

/// Bounded subgraph passed into [`crate::brain::rank_paths`].
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RecallGraph {
    /// Provisional claims keyed by stable id.
    pub claims: BTreeMap<ClaimId, GraphClaim>,
    /// Canonical facts keyed by stable id.
    pub facts: BTreeMap<FactId, GraphFact>,
    /// Episodes keyed by stable id.
    pub episodes: BTreeMap<EpisodeId, GraphEpisode>,
    /// Known lexeme nodes.
    pub lexemes: BTreeSet<LexemeId>,
    /// Directed edges.
    pub edges: Vec<GraphEdge>,
}

impl RecallGraph {
    /// Finds episodes by lexeme, full text, or a compatible fixture vector.
    #[must_use]
    pub fn discover_episodes(&self, query: &RecallQuery, policy: &LexicalPolicy) -> Vec<EpisodeId> {
        let query_lexemes: BTreeSet<LexemeId> = lexemes_for_sentence(&query.text, policy)
            .into_iter()
            .collect();
        let needle = query.text.to_lowercase();
        let mut hits = BTreeSet::new();
        for (id, episode) in &self.episodes {
            let lexeme_hit = episode
                .lexemes
                .iter()
                .any(|lexeme| query_lexemes.contains(lexeme));
            let text_hit = !needle.is_empty() && episode.text.to_lowercase().contains(&needle);
            let vector_hit =
                compatible_vectors(query.embedding.as_ref(), episode.embedding.as_ref());
            if lexeme_hit || text_hit || vector_hit {
                hits.insert(id.clone());
            }
        }
        hits.into_iter().collect()
    }
}

fn compatible_vectors(query: Option<&QueryEmbedding>, stored: Option<&StoredEmbedding>) -> bool {
    let (Some(query), Some(stored)) = (query, stored) else {
        return false;
    };
    query.model == stored.model && query.values.len() == stored.values.len()
}

/// Claim and fact ids in `CorrectionHold`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct QuarantineSet {
    ids: BTreeSet<MemoryRef>,
}

impl QuarantineSet {
    /// Builds a quarantine set from claim and fact ids.
    pub fn new(ids: impl IntoIterator<Item = MemoryRef>) -> Self {
        Self {
            ids: ids.into_iter().collect(),
        }
    }

    /// Whether this id is under a correction hold.
    #[must_use]
    pub fn contains(&self, id: &MemoryRef) -> bool {
        self.ids.contains(id)
    }
}

/// Ranked recall item carried into the recall block.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum RecallItem {
    /// Provisional claim.
    Claim {
        /// Stable claim id.
        claim_id: ClaimId,
    },
    /// Canonical fact.
    Fact {
        /// Stable fact id.
        fact_id: FactId,
    },
}

impl RecallItem {
    /// Stable tie-break key.
    #[must_use]
    pub fn tie_break_key(&self) -> &str {
        match self {
            Self::Claim { claim_id } => claim_id.as_str(),
            Self::Fact { fact_id } => fact_id.as_str(),
        }
    }
}

/// Per-candidate component scores retained for the inspector.
#[derive(Debug, Clone, PartialEq)]
pub struct ComponentScores {
    /// Base activation, or `None` when no valid presentations remain.
    pub activation: Option<f64>,
    /// Personalized PageRank mass on this node.
    pub pagerank: f64,
    /// Cosine similarity, or `None` when a vector is missing or incomparable.
    pub embedding: Option<f64>,
    /// Weighted combination of the three channels.
    pub combined: f64,
    /// Stable id used when combined scores are equal.
    pub tie_break: String,
}

/// One ranked claim or fact plus the walk that lifted it.
#[derive(Debug, Clone, PartialEq)]
pub struct RankedPath {
    /// Nodes walked from query lexemes to the candidate.
    pub walked: Vec<NodeId>,
    /// Recall-block item.
    pub item: RecallItem,
    /// Exact sentence text.
    pub sentence: String,
    /// Item taint.
    pub taint: Taint,
    /// Inspectable component scores.
    pub scores: ComponentScores,
}

/// Typed ranking failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RankError {
    /// Policy decay was NaN or infinite.
    NonFiniteDecay,
    /// Policy decay was zero or negative.
    NonPositiveDecay,
    /// A score-combination coefficient was NaN or infinite.
    NonFiniteCoefficient,
    /// Inclusion threshold was NaN or infinite.
    NonFiniteThreshold,
    /// PageRank damping was NaN or infinite.
    NonFiniteDamping,
    /// An edge weight was NaN or infinite.
    NonFiniteEdgeWeight,
    /// A vector component was NaN or infinite.
    NonFiniteVector,
    /// A presentation weight remaining after age filtering was invalid.
    InvalidPresentationWeight,
}
