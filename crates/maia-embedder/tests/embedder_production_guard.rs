//! Candle production-readiness guard.

use maia_embedder::CandleEmbedder;

#[test]
fn candle_inference_is_not_production_ready() {
    let dir = std::env::temp_dir().join(format!("maia-embedder-guard-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("weights")).expect("mkdir");
    let weight_bytes = b"fixture-weight-bytes";
    std::fs::write(dir.join("weights/model.safetensors"), weight_bytes).expect("weights");
    let tokenizer_bytes = br#"{"version":"fixture"}"#;
    std::fs::write(dir.join("tokenizer.json"), tokenizer_bytes).expect("tokenizer");
    let mut spec = maia_core::embedder::BGE_SMALL_EN_V1_5.clone();
    spec.weight_sha256 = leak_hex(weight_bytes);
    spec.tokenizer_sha256 = leak_hex(tokenizer_bytes);
    let artifacts = maia_core::embedder::EmbedderArtifacts {
        weights_dir: dir.join("weights").display().to_string(),
        tokenizer_path: dir.join("tokenizer.json").display().to_string(),
    };
    let embedder = CandleEmbedder::open(&artifacts, &spec).expect("open");
    assert!(!embedder.inference_is_production_ready());
    let _ = std::fs::remove_dir_all(dir);
}

fn leak_hex(bytes: &[u8]) -> &'static str {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let rendered = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Box::leak(rendered.into_boxed_str())
}
