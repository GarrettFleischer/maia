//! Embedder validation errors.

/// Errors returned by embedder validation and adapters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbedderError {
    /// Output count does not match requested texts.
    Cardinality {
        /// Inputs requested.
        expected: usize,
        /// Outputs returned.
        actual: usize,
    },
    /// Vector length does not match the configured model.
    Dimension {
        /// Expected dimension count.
        expected: usize,
        /// Observed dimension count.
        actual: usize,
    },
    /// A vector component is not finite.
    NonFinite,
    /// Local artifacts failed hash or metadata checks.
    IncompatibleModel,
    /// Artifact IO or inference failure at the adapter boundary.
    Runtime(String),
}
