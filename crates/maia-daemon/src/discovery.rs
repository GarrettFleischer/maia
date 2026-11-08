//! Deterministic model id selection.
//!
//! Callers pass ids they already discovered. This module does not send HTTP
//! and does not prefer a vendor.

/// Why a model id could not be selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryError {
    /// The id list was empty.
    NoModels,
    /// An id was empty or only whitespace.
    BlankModelId,
}

impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::NoModels => "Model list is empty.",
            Self::BlankModelId => "Model list contains an empty id.",
        };
        formatter.write_str(text)
    }
}

impl std::error::Error for DiscoveryError {}

/// Returns the lexicographically first id.
///
/// The input slice is not modified. Ordering is `String`'s `Ord` (Unicode
/// scalar order), not a vendor ranking. An empty list returns
/// [`DiscoveryError::NoModels`]. An empty or whitespace id returns
/// [`DiscoveryError::BlankModelId`] instead of being skipped.
pub fn select_model_id(ids: &[String]) -> Result<String, DiscoveryError> {
    if ids.is_empty() {
        return Err(DiscoveryError::NoModels);
    }
    if ids.iter().any(|id| id.trim().is_empty()) {
        return Err(DiscoveryError::BlankModelId);
    }
    let mut ordered = ids.to_vec();
    ordered.sort();
    match ordered.into_iter().next() {
        Some(id) => Ok(id),
        None => Err(DiscoveryError::NoModels),
    }
}
