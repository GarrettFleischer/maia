//! Deterministic fake embedder for tests.

use crate::embedder::error::EmbedderError;
use crate::embedder::identity::EmbedderModelSpec;
use crate::embedder::port::Embedder;
use crate::embedder::types::Embedding;
use crate::embedder::validate::validate_embeddings;

/// Deterministic vectors derived from text and a pinned model spec.
pub struct DeterministicFakeEmbedder {
    spec: EmbedderModelSpec,
}

impl DeterministicFakeEmbedder {
    /// Builds a fake embedder for one model spec.
    pub fn new(spec: &EmbedderModelSpec) -> Self {
        Self { spec: spec.clone() }
    }

    /// Synchronous embed helper for pure tests.
    pub fn embed_sync(&self, texts: &[&str]) -> Result<Vec<Embedding>, EmbedderError> {
        let embeddings = texts
            .iter()
            .map(|text| Embedding {
                values: deterministic_vector(&self.spec, text),
                model: crate::brain::EmbedderModel::new(self.spec.model_id),
            })
            .collect::<Vec<_>>();
        validate_embeddings(texts.len(), &embeddings, &self.spec)?;
        Ok(embeddings)
    }
}

impl Embedder for DeterministicFakeEmbedder {
    async fn embed(&self, texts: &[&str]) -> Result<Vec<Embedding>, EmbedderError> {
        self.embed_sync(texts)
    }
}

fn deterministic_vector(spec: &EmbedderModelSpec, text: &str) -> Vec<f64> {
    let seed = fnv1a64(&format!("{}{}", spec.vector_prefix, text));
    (0..spec.dimensions)
        .map(|index| {
            let mixed = seed
                .wrapping_add(index as u64)
                .wrapping_mul(0x9E37_79B9_7F4A_7C15);
            let unit = (mixed as f64) / (u64::MAX as f64);
            unit * 2.0 - 1.0
        })
        .collect()
}

fn fnv1a64(text: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
