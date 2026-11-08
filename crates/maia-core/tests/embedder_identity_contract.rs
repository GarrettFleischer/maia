//! Embedder model identity contract.

use maia_core::embedder::{
    BGE_SMALL_EN_V1_5, LoadedModelIdentity, ModelCompatibility, check_model_compatibility,
};

#[test]
fn pinned_id_dimensions_and_hashes_are_explicit() {
    assert_eq!(BGE_SMALL_EN_V1_5.model_id, "bge-small-en-v1.5");
    assert_eq!(BGE_SMALL_EN_V1_5.dimensions, 384);
    assert!(!BGE_SMALL_EN_V1_5.weight_sha256.is_empty());
    assert!(!BGE_SMALL_EN_V1_5.tokenizer_sha256.is_empty());
    assert!(BGE_SMALL_EN_V1_5.vector_prefix.starts_with("bge:"));
}

#[test]
fn matching_identity_is_compatible() {
    let loaded = LoadedModelIdentity {
        model_id: BGE_SMALL_EN_V1_5.model_id.to_owned(),
        dimensions: BGE_SMALL_EN_V1_5.dimensions,
        weight_sha256: BGE_SMALL_EN_V1_5.weight_sha256.to_owned(),
        tokenizer_sha256: BGE_SMALL_EN_V1_5.tokenizer_sha256.to_owned(),
        vector_prefix: BGE_SMALL_EN_V1_5.vector_prefix.to_owned(),
    };
    assert_eq!(
        check_model_compatibility(&loaded, &BGE_SMALL_EN_V1_5),
        ModelCompatibility::Compatible
    );
}

#[test]
fn mismatched_weight_hash_is_incompatible() {
    let loaded = LoadedModelIdentity {
        model_id: BGE_SMALL_EN_V1_5.model_id.to_owned(),
        dimensions: BGE_SMALL_EN_V1_5.dimensions,
        weight_sha256: "deadbeef".to_owned(),
        tokenizer_sha256: BGE_SMALL_EN_V1_5.tokenizer_sha256.to_owned(),
        vector_prefix: BGE_SMALL_EN_V1_5.vector_prefix.to_owned(),
    };
    assert_eq!(
        check_model_compatibility(&loaded, &BGE_SMALL_EN_V1_5),
        ModelCompatibility::Incompatible
    );
}

#[test]
fn wrong_dimension_count_is_incompatible() {
    let loaded = LoadedModelIdentity {
        model_id: BGE_SMALL_EN_V1_5.model_id.to_owned(),
        dimensions: 128,
        weight_sha256: BGE_SMALL_EN_V1_5.weight_sha256.to_owned(),
        tokenizer_sha256: BGE_SMALL_EN_V1_5.tokenizer_sha256.to_owned(),
        vector_prefix: BGE_SMALL_EN_V1_5.vector_prefix.to_owned(),
    };
    assert_eq!(
        check_model_compatibility(&loaded, &BGE_SMALL_EN_V1_5),
        ModelCompatibility::Incompatible
    );
}
