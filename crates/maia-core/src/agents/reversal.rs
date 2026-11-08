//! Presentation reversal compensations.

use std::collections::BTreeSet;

use crate::agents::types::{
    LedgerCompensation, Presentation, PresentationId, ReversalError, ReversalRequest,
    ReversalRequestId,
};

/// Builds compensation rows without mutating original ledger entries.
pub fn reverse_presentations(
    source: &[Presentation],
    already_reversed: &BTreeSet<PresentationId>,
    already_applied: &BTreeSet<ReversalRequestId>,
    request: &ReversalRequest,
) -> Result<Vec<LedgerCompensation>, ReversalError> {
    if already_applied.contains(&request.id) {
        return Ok(Vec::new());
    }
    let by_id: std::collections::BTreeMap<PresentationId, &Presentation> =
        source.iter().map(|p| (p.id, p)).collect();
    let mut out = Vec::new();
    let mut selected = BTreeSet::new();
    for id in &request.presentation_ids {
        if already_reversed.contains(id) || !selected.insert(*id) {
            continue;
        }
        let Some(presentation) = by_id.get(id) else {
            return Err(ReversalError::UnknownPresentation(*id));
        };
        out.push(LedgerCompensation {
            presentation_id: *id,
            activation_delta: -presentation.activation,
            co_use_delta: -presentation.co_use,
            reversal_id: request.id,
        });
    }
    Ok(out)
}
