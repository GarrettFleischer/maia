//! Embedding output validation contract.

use maia_core::brain::EmbedderModel;
use maia_core::embedder::{BGE_SMALL_EN_V1_5, EmbedderError, Embedding, validate_embeddings};

fn embedding(values: Vec<f64>) -> Embedding {
    Embedding {
        values,
        model: EmbedderModel::new(BGE_SMALL_EN_V1_5.model_id),
    }
}

#[test]
fn cardinality_must_match_input_count() {
    let error =
        validate_embeddings(2, &[embedding(vec![0.0; 384])], &BGE_SMALL_EN_V1_5).unwrap_err();
    assert!(matches!(error, EmbedderError::Cardinality { .. }));
}

#[test]
fn dimension_mismatch_fails_closed() {
    let error =
        validate_embeddings(1, &[embedding(vec![0.0; 128])], &BGE_SMALL_EN_V1_5).unwrap_err();
    assert!(matches!(error, EmbedderError::Dimension { .. }));
}

#[test]
fn non_finite_components_are_rejected() {
    let error =
        validate_embeddings(1, &[embedding(vec![f64::NAN; 384])], &BGE_SMALL_EN_V1_5).unwrap_err();
    assert!(matches!(error, EmbedderError::NonFinite));
}

#[test]
fn compatible_batch_passes() {
    validate_embeddings(1, &[embedding(vec![0.0; 384])], &BGE_SMALL_EN_V1_5).expect("ok");
}
