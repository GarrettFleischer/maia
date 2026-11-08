#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Local embedding model adapter implementing `Embedder`.

mod candle;

pub use candle::{CandleEmbedder, INFERENCE_PRODUCTION_READY, default_spec};
