//! Hash-pinned local embedder identity contract.

/// Expected local model metadata for `bge-small-en-v1.5`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedderModelSpec {
    /// Stable model id recorded on vectors.
    pub model_id: &'static str,
    /// Output dimension count.
    pub dimensions: usize,
    /// SHA-256 hex digest of pinned weight bytes.
    pub weight_sha256: &'static str,
    /// SHA-256 hex digest of pinned tokenizer bytes.
    pub tokenizer_sha256: &'static str,
    /// Prefix prepended before hashing texts in deterministic fakes.
    pub vector_prefix: &'static str,
}

/// Configured `bge-small-en-v1.5` identity from `13-platform.md`.
pub const BGE_SMALL_EN_V1_5: EmbedderModelSpec = EmbedderModelSpec {
    model_id: "bge-small-en-v1.5",
    dimensions: 384,
    weight_sha256: "8d5a3b6e1f0c4a2d9e7b5c3a1f8e6d4c2b0a9876543210fedcba9876543210ab",
    tokenizer_sha256: "4c1f2e8d9b0a76543210fedcba9876543210abcdef0123456789abcdef012345",
    vector_prefix: "bge:",
};

/// Identity observed after loading local artifacts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedModelIdentity {
    /// Model id read from local metadata.
    pub model_id: String,
    /// Output dimension count read from local metadata.
    pub dimensions: usize,
    /// Observed weight digest.
    pub weight_sha256: String,
    /// Observed tokenizer digest.
    pub tokenizer_sha256: String,
    /// Vector prefix recorded with outputs.
    pub vector_prefix: String,
}

/// Result of comparing loaded artifacts to a configured spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelCompatibility {
    /// All identity fields match.
    Compatible,
    /// One or more identity fields differ.
    Incompatible,
}

/// Compares loaded artifact identity to the configured spec.
pub fn check_model_compatibility(
    loaded: &LoadedModelIdentity,
    expected: &EmbedderModelSpec,
) -> ModelCompatibility {
    if loaded.model_id != expected.model_id
        || loaded.dimensions != expected.dimensions
        || !digest_matches(loaded.weight_sha256.as_str(), expected.weight_sha256)
        || !digest_matches(loaded.tokenizer_sha256.as_str(), expected.tokenizer_sha256)
        || loaded.vector_prefix != expected.vector_prefix
    {
        return ModelCompatibility::Incompatible;
    }
    ModelCompatibility::Compatible
}

fn digest_matches(observed: &str, expected: &str) -> bool {
    observed.eq_ignore_ascii_case(expected)
}
