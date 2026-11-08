//! Deterministic fake embedder vectors.

use maia_core::brain::EmbedderModel;
use maia_core::embedder::{BGE_SMALL_EN_V1_5, DeterministicFakeEmbedder};

#[test]
fn fake_vectors_are_stable_and_pinned() {
    let embedder = DeterministicFakeEmbedder::new(&BGE_SMALL_EN_V1_5);
    let first = embedder.embed_sync(&["hello"]).expect("first");
    let second = embedder.embed_sync(&["hello"]).expect("second");
    assert_eq!(first, second);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].values.len(), 384);
    assert_eq!(
        first[0].model,
        EmbedderModel::new(BGE_SMALL_EN_V1_5.model_id)
    );
    assert!(first[0].values.iter().all(|v| v.is_finite()));
}

#[test]
fn different_texts_yield_different_vectors() {
    let embedder = DeterministicFakeEmbedder::new(&BGE_SMALL_EN_V1_5);
    let a = embedder.embed_sync(&["alpha"]).expect("a");
    let b = embedder.embed_sync(&["beta"]).expect("b");
    assert_ne!(a[0].values, b[0].values);
}
