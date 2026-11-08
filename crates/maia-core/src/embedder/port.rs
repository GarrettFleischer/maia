//! `Embedder` port.

use core::future::Future;

use crate::embedder::error::EmbedderError;
use crate::embedder::types::Embedding;

/// Local embedding model transport.
pub trait Embedder {
    /// Embeds each input text into one vector.
    fn embed(
        &self,
        texts: &[&str],
    ) -> impl Future<Output = Result<Vec<Embedding>, EmbedderError>> + Send;
}
