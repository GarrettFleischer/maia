//! Shared brain retrieval graph, episodes, facts, and ranking leaves.

mod autolink;
mod fusion;
mod graph;
mod ids;
mod lexemes;
mod markdown;
mod porter;
mod rank;
mod stem;

pub use autolink::{
    AUTO_LINK_SOURCE, ExtractedLink, KnownNeuron, LinkTarget, MENTION_MIN_CHARS, extract_links,
};
pub use fusion::{
    FusedRank, FusionError, RRF_K, recall_activity_label, reciprocal_rank_fusion,
    sanitize_fts_query,
};
pub use graph::{
    ComponentScores, EmbedderModel, GraphClaim, GraphEdge, GraphEpisode, GraphFact, MemoryScope,
    PageRankParams, QuarantineSet, QueryEmbedding, RankError, RankPolicy, RankedPath, RecallGraph,
    RecallItem, RecallQuery, RecallTaintMode, ScoreWeights, StoredEmbedding,
};
pub use ids::{ClaimId, EpisodeId, FactId, LexemeId, MemoryRef, NodeId, SlotId};
pub use lexemes::{LexicalPolicy, lexemes_for_sentence};
pub use markdown::{
    MarkdownError, NeuronDoc, NeuronEdge, NeuronPresentation, NeuronSegment, assign_markdown_paths,
    body_fingerprint, disambiguate_paths, graph_from_docs, markdown_path, neuron_slug,
    neuron_title, parse_neuron, render_neuron,
};
pub use rank::rank_paths;
pub use stem::{link_match_keys, same_keyword_term};
