//! Advisory context items from ranked memories.

use super::types::{AdvisoryStanding, ContextItem, RankedMemory, SnapshotId};

/// Labels each ranked memory as advisory context for `snapshot`.
///
/// The output has the same length and order as `ranked`. Memory id, sentence,
/// provenance, and trust are copied. Standing is [`AdvisoryStanding::Advisory`].
/// `snapshot` is the caller-supplied id stored on every item. This leaf does
/// not dedupe, normalize, truncate, rank, or read a graph.
pub fn advisory_items(snapshot: &SnapshotId, ranked: &[RankedMemory]) -> Vec<ContextItem> {
    ranked
        .iter()
        .map(|row| ContextItem {
            snapshot: snapshot.clone(),
            memory: row.memory.clone(),
            sentence: row.sentence.clone(),
            provenance: row.provenance.clone(),
            trust: row.trust,
            standing: AdvisoryStanding::Advisory,
        })
        .collect()
}
