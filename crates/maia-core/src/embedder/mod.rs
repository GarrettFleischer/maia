//! Local embedding port types and dimensional validation contracts (`08-rust.md`).

mod error;
mod fake;
mod identity;
mod port;
mod types;
mod validate;

pub use error::EmbedderError;
pub use fake::DeterministicFakeEmbedder;
pub use identity::{
    BGE_SMALL_EN_V1_5, EmbedderModelSpec, LoadedModelIdentity, ModelCompatibility,
    check_model_compatibility,
};
pub use port::Embedder;
pub use types::{EmbedderArtifacts, Embedding};
pub use validate::{embedding_from_values, validate_embeddings};
