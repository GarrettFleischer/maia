//! Local Candle embedder adapter.

#![allow(unused_imports)]

use std::fs;
use std::path::Path;

use maia_core::brain::EmbedderModel;
use maia_core::embedder::{
    BGE_SMALL_EN_V1_5, Embedder, EmbedderArtifacts, EmbedderError, EmbedderModelSpec, Embedding,
    LoadedModelIdentity, ModelCompatibility, check_model_compatibility, validate_embeddings,
};
use sha2::{Digest, Sha256};

/// Real Candle inference is intentionally deferred for the fixture milestone.
pub const INFERENCE_PRODUCTION_READY: bool = false;

/// Candle-backed local embedder with hash-pinned artifacts.
pub struct CandleEmbedder {
    spec: EmbedderModelSpec,
    identity: LoadedModelIdentity,
}

impl CandleEmbedder {
    /// Loads artifacts from explicit local paths and verifies pinned digests.
    pub fn open(
        artifacts: &EmbedderArtifacts,
        spec: &EmbedderModelSpec,
    ) -> Result<Self, EmbedderError> {
        let identity = load_identity(artifacts, spec)?;
        if check_model_compatibility(&identity, spec) != ModelCompatibility::Compatible {
            return Err(EmbedderError::IncompatibleModel);
        }
        Ok(Self {
            spec: spec.clone(),
            identity,
        })
    }

    /// Returns whether production inference is enabled (always false until implemented).
    pub fn inference_is_production_ready(&self) -> bool {
        INFERENCE_PRODUCTION_READY
    }

    /// Returns the verified model identity.
    pub fn identity(&self) -> &LoadedModelIdentity {
        &self.identity
    }

    /// Synchronous embed for tests.
    pub fn embed_sync(&self, texts: &[&str]) -> Result<Vec<Embedding>, EmbedderError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let vectors = infer_vectors(&self.spec, texts)?;
        validate_embeddings(texts.len(), &vectors, &self.spec)?;
        Ok(vectors)
    }
}

impl Embedder for CandleEmbedder {
    async fn embed(&self, texts: &[&str]) -> Result<Vec<Embedding>, EmbedderError> {
        self.embed_sync(texts)
    }
}

fn load_identity(
    artifacts: &EmbedderArtifacts,
    spec: &EmbedderModelSpec,
) -> Result<LoadedModelIdentity, EmbedderError> {
    let weight_path = find_weight_file(&artifacts.weights_dir)?;
    let weight_sha256 = sha256_file(&weight_path)?;
    let tokenizer_sha256 = sha256_file(Path::new(&artifacts.tokenizer_path))?;
    Ok(LoadedModelIdentity {
        model_id: spec.model_id.to_owned(),
        dimensions: spec.dimensions,
        weight_sha256,
        tokenizer_sha256,
        vector_prefix: spec.vector_prefix.to_owned(),
    })
}

fn find_weight_file(weights_dir: &str) -> Result<std::path::PathBuf, EmbedderError> {
    let dir = Path::new(weights_dir);
    let entries = fs::read_dir(dir).map_err(|error| runtime(error.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|error| runtime(error.to_string()))?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "safetensors") {
            return Ok(path);
        }
    }
    Err(runtime("missing safetensors weight file"))
}

fn sha256_file(path: &Path) -> Result<String, EmbedderError> {
    let bytes = fs::read(path).map_err(|error| runtime(error.to_string()))?;
    let digest = Sha256::digest(bytes);
    Ok(hex_encode(&digest))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn infer_vectors(
    _spec: &EmbedderModelSpec,
    texts: &[&str],
) -> Result<Vec<Embedding>, EmbedderError> {
    // Real Candle inference requires pinned weight bytes that are not vendored in the repo.
    // Hash verification still runs at open; inference remains deferred to the ignored smoke test.
    let _ = texts;
    Err(runtime(
        "candle inference requires local bge-small-en-v1.5 weights; use DeterministicFakeEmbedder in CI"
            .to_owned(),
    ))
}

fn runtime(message: impl Into<String>) -> EmbedderError {
    EmbedderError::Runtime(message.into())
}

/// Default spec constant used by the adapter.
pub fn default_spec() -> &'static EmbedderModelSpec {
    &BGE_SMALL_EN_V1_5
}
