//! Embedding output validation.

use crate::brain::EmbedderModel;
use crate::embedder::error::EmbedderError;
use crate::embedder::identity::EmbedderModelSpec;
use crate::embedder::types::Embedding;

/// Validates embedding batch shape and finiteness for one model spec.
pub fn validate_embeddings(
    input_count: usize,
    embeddings: &[Embedding],
    spec: &EmbedderModelSpec,
) -> Result<(), EmbedderError> {
    if embeddings.len() != input_count {
        return Err(EmbedderError::Cardinality {
            expected: input_count,
            actual: embeddings.len(),
        });
    }
    for embedding in embeddings {
        if embedding.model.as_str() != spec.model_id {
            return Err(EmbedderError::IncompatibleModel);
        }
        if embedding.values.len() != spec.dimensions {
            return Err(EmbedderError::Dimension {
                expected: spec.dimensions,
                actual: embedding.values.len(),
            });
        }
        if embedding.values.iter().any(|value| !value.is_finite()) {
            return Err(EmbedderError::NonFinite);
        }
    }
    Ok(())
}

/// Builds one embedding value for tests and fakes.
pub fn embedding_from_values(model_id: &str, values: Vec<f64>) -> Embedding {
    Embedding {
        values,
        model: EmbedderModel::new(model_id),
    }
}
