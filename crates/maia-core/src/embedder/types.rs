//! Embedder port value types.

use crate::brain::EmbedderModel;

/// One embedding vector plus the model that produced it.
#[derive(Debug, Clone, PartialEq)]
pub struct Embedding {
    /// Finite vector components.
    pub values: Vec<f64>,
    /// Model identity recorded with the vector.
    pub model: EmbedderModel,
}

/// Local artifact paths supplied by the composition root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedderArtifacts {
    /// Directory containing pinned weight files.
    pub weights_dir: String,
    /// Path to the pinned tokenizer JSON file.
    pub tokenizer_path: String,
}
