//! Embedder adapter contract tests.

use std::fs;
use std::path::PathBuf;

use maia_core::embedder::{
    BGE_SMALL_EN_V1_5, EmbedderArtifacts, EmbedderError, EmbedderModelSpec, ModelCompatibility,
    check_model_compatibility,
};
use maia_embedder::CandleEmbedder;

fn temp_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("maia-embedder-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("mkdir");
    path
}

#[test]
fn candle_open_rejects_mismatched_weight_hash() {
    let dir = temp_dir("hash");
    let weights = dir.join("weights");
    fs::create_dir_all(&weights).expect("weights dir");
    fs::write(weights.join("model.safetensors"), b"not-the-real-weights").expect("weights");
    let tokenizer_bytes = b"{}";
    let tokenizer = dir.join("tokenizer.json");
    fs::write(&tokenizer, tokenizer_bytes).expect("tokenizer");
    let spec = fixture_spec(tokenizer_bytes, b"expected-not-matching");
    let artifacts = EmbedderArtifacts {
        weights_dir: weights.display().to_string(),
        tokenizer_path: tokenizer.display().to_string(),
    };
    let error = match CandleEmbedder::open(&artifacts, &spec) {
        Ok(_) => panic!("expected incompatible model"),
        Err(error) => error,
    };
    assert!(matches!(error, EmbedderError::IncompatibleModel));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn candle_open_accepts_matching_digests_but_inference_is_deferred() {
    let dir = temp_dir("match");
    let weights = dir.join("weights");
    fs::create_dir_all(&weights).expect("weights dir");
    let weight_bytes = b"fixture-weight-bytes";
    fs::write(weights.join("model.safetensors"), weight_bytes).expect("weights");
    let tokenizer_bytes = br#"{"version":"fixture"}"#;
    let tokenizer = dir.join("tokenizer.json");
    fs::write(&tokenizer, tokenizer_bytes).expect("tokenizer");
    let spec = fixture_spec(tokenizer_bytes, weight_bytes);
    let artifacts = EmbedderArtifacts {
        weights_dir: weights.display().to_string(),
        tokenizer_path: tokenizer.display().to_string(),
    };
    let embedder = CandleEmbedder::open(&artifacts, &spec).expect("open");
    assert_eq!(
        check_model_compatibility(embedder.identity(), &spec),
        ModelCompatibility::Compatible
    );
    let error = match embedder.embed_sync(&["hello"]) {
        Ok(_) => panic!("expected deferred inference error"),
        Err(error) => error,
    };
    assert!(matches!(error, EmbedderError::Runtime(_)));
    let _ = fs::remove_dir_all(dir);
}

#[test]
#[ignore = "requires local bge-small-en-v1.5 weight and tokenizer files on the machine"]
fn candle_smoke_with_real_pinned_artifacts() {
    let artifacts = EmbedderArtifacts {
        weights_dir: std::env::var("MAIA_BGE_WEIGHTS_DIR").expect("MAIA_BGE_WEIGHTS_DIR"),
        tokenizer_path: std::env::var("MAIA_BGE_TOKENIZER_PATH").expect("MAIA_BGE_TOKENIZER_PATH"),
    };
    let embedder = CandleEmbedder::open(&artifacts, &BGE_SMALL_EN_V1_5).expect("open");
    let vectors = embedder.embed_sync(&["smoke"]).expect("embed");
    assert_eq!(vectors.len(), 1);
    assert_eq!(vectors[0].values.len(), 384);
}

fn fixture_spec(tokenizer_bytes: &[u8], weight_bytes: &[u8]) -> EmbedderModelSpec {
    EmbedderModelSpec {
        model_id: BGE_SMALL_EN_V1_5.model_id,
        dimensions: BGE_SMALL_EN_V1_5.dimensions,
        weight_sha256: leak_hex(weight_bytes),
        tokenizer_sha256: leak_hex(tokenizer_bytes),
        vector_prefix: BGE_SMALL_EN_V1_5.vector_prefix,
    }
}

fn leak_hex(bytes: &[u8]) -> &'static str {
    Box::leak(sha256_hex(bytes).into_boxed_str())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
