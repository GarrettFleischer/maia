//! Shared brain retrieval graph, episodes, facts, and ranking leaves.

mod autolink;
mod fusion;
mod graph;
mod ids;
mod lexemes;
mod markdown;
mod rank;

pub use autolink::{
    extract_links, ExtractedLink, KnownNeuron, LinkTarget, AUTO_LINK_SOURCE, MENTION_MIN_CHARS,
};
pub use fusion::{
    recall_activity_label, reciprocal_rank_fusion, sanitize_fts_query, FusedRank, FusionError,
    RRF_K,
};
pub use graph::{
    ComponentScores, EmbedderModel, GraphClaim, GraphEdge, GraphEpisode, GraphFact, MemoryScope,
    PageRankParams, QuarantineSet, QueryEmbedding, RankError, RankPolicy, RankedPath, RecallGraph,
    RecallItem, RecallQuery, RecallTaintMode, ScoreWeights, StoredEmbedding,
};
pub use ids::{ClaimId, EpisodeId, FactId, LexemeId, MemoryRef, NodeId, SlotId};
pub use lexemes::{LexicalPolicy, lexemes_for_sentence};
pub use markdown::{
    assign_markdown_paths, body_fingerprint, disambiguate_paths, graph_from_docs, markdown_path,
    neuron_slug, neuron_title, parse_neuron, render_neuron, MarkdownError, NeuronDoc, NeuronEdge,
    NeuronPresentation, NeuronSegment,
};
pub use rank::rank_paths;
