//! Provenance join helpers.

use std::collections::BTreeSet;

use crate::security::types::{Provenance, SlotProvenance, SourceRef, Taint};

/// Joins durable slots, scratch slots, and recall items into request provenance.
pub fn request_provenance(
    included: &[SlotProvenance],
    scratch: &[SlotProvenance],
    recall: &[SlotProvenance],
) -> Provenance {
    let mut taint = Taint::Trusted;
    let mut sources = BTreeSet::new();
    for slot in included.iter().chain(scratch).chain(recall) {
        if slot.taint > taint {
            taint = slot.taint;
        }
        sources.extend(slot.sources.iter().cloned());
    }
    Provenance { taint, sources }
}

/// Lowers taint only via endorsement source (owner action).
pub fn endorse_source(sources: &mut BTreeSet<SourceRef>, action: u64) -> Taint {
    sources.insert(SourceRef::Endorsement(action));
    Taint::Trusted
}
