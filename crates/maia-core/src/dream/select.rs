//! Consolidation wake and taint-partitioned selection.

use std::collections::BTreeMap;

use crate::audit::Timestamp;
use crate::brain::ClaimId;
use crate::brain::EpisodeId;
use crate::dream::schedule::PanicLatch;
use crate::dream::schedule::RunnerOccupancy;
use crate::security::Taint;

/// Default unconsolidated-claim wake threshold.
pub const DEFAULT_UNCONSOLIDATED_THRESHOLD: u32 = 20;

/// Default idle wake interval, in seconds.
pub const DEFAULT_IDLE_SECONDS: i64 = 30 * 60;

/// Default consolidation failures before an episode leaves selection.
pub const DEFAULT_CONSOLIDATION_FAILURE_LIMIT: u32 = 3;

/// Wake thresholds supplied by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WakePolicy {
    /// Wake when at least this many claims are unconsolidated.
    pub claim_threshold: u32,
    /// Wake when idle at least this many seconds and a claim is pending.
    pub idle_seconds: i64,
}

/// Whether a person asked for a dream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DreamRequestMode {
    /// No explicit request.
    None,
    /// The owner requested a dream.
    Explicit,
}

/// Observations passed into [`consolidation_due`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WakeObservation {
    /// Unconsolidated provisional claims.
    pub unconsolidated: u32,
    /// Idle duration supplied by the caller, in seconds.
    pub idle_for: i64,
    /// Explicit request.
    pub request: DreamRequestMode,
}

/// Whether consolidation may start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeDecision {
    /// A dream may be selected.
    Wake,
    /// Stay idle.
    Sleep,
}

/// Returns whether any wake condition holds for the supplied policy.
#[must_use]
pub fn consolidation_due(observation: &WakeObservation, policy: &WakePolicy) -> WakeDecision {
    let threshold = observation.unconsolidated >= policy.claim_threshold;
    let idle = observation.idle_for >= policy.idle_seconds && observation.unconsolidated >= 1;
    let explicit = observation.request == DreamRequestMode::Explicit;
    if threshold || idle || explicit {
        WakeDecision::Wake
    } else {
        WakeDecision::Sleep
    }
}

/// Batch size and quarantine limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatchPolicy {
    /// Maximum claims in the single batch.
    pub max_claims: u32,
    /// Episode failure count that excludes its claims.
    pub failure_limit: u32,
}

/// One unconsolidated claim eligible for selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectableClaim {
    /// Claim id.
    pub id: ClaimId,
    /// Claim taint. Batches do not mix taints.
    pub taint: Taint,
    /// Source episode.
    pub episode_id: EpisodeId,
    /// Time the claim became pending.
    pub pending_since: Timestamp,
    /// Consolidation failures recorded for the source episode.
    pub consolidation_failures: u32,
}

/// Selection inputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatchQueue<'a> {
    /// Candidate claims.
    pub claims: &'a [SelectableClaim],
    /// Runner occupancy.
    pub occupancy: RunnerOccupancy,
    /// Panic latch.
    pub latch: PanicLatch,
    /// Batch policy.
    pub policy: &'a BatchPolicy,
}

/// Why selection admitted nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchSkip {
    /// No eligible claim.
    Empty,
    /// A batch is already running.
    Busy,
    /// Panic latch is engaged.
    Panic,
}

/// One homogeneous batch, oldest pending first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedBatch {
    /// Partition taint.
    pub taint: Taint,
    /// Selected claim ids.
    pub claims: Vec<ClaimId>,
}

/// At most one consolidation batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchSelection {
    /// No batch.
    None(BatchSkip),
    /// The only batch admitted.
    Batch(SelectedBatch),
}

/// Builds one taint-homogeneous batch, or refuses admission.
#[must_use]
pub fn select_batch(queue: &BatchQueue<'_>) -> BatchSelection {
    if queue.latch == PanicLatch::Engaged {
        return BatchSelection::None(BatchSkip::Panic);
    }
    if queue.occupancy == RunnerOccupancy::Busy {
        return BatchSelection::None(BatchSkip::Busy);
    }
    let limit = usize::try_from(queue.policy.max_claims).unwrap_or(usize::MAX);
    if limit == 0 {
        return BatchSelection::None(BatchSkip::Empty);
    }
    let mut groups: BTreeMap<Taint, Vec<&SelectableClaim>> = BTreeMap::new();
    for claim in queue.claims {
        if claim.consolidation_failures < queue.policy.failure_limit {
            groups.entry(claim.taint).or_default().push(claim);
        }
    }
    let mut best: Option<SelectedBatch> = None;
    let mut best_key: Option<(Timestamp, Taint)> = None;
    for (taint, mut group) in groups {
        group.sort_by(|left, right| {
            left.pending_since
                .cmp(&right.pending_since)
                .then_with(|| left.id.cmp(&right.id))
        });
        let Some(oldest) = group.first() else {
            continue;
        };
        let key = (oldest.pending_since, taint);
        let replace = best_key.is_none_or(|current| key < current);
        if replace {
            best_key = Some(key);
            best = Some(SelectedBatch {
                taint,
                claims: group
                    .into_iter()
                    .take(limit)
                    .map(|claim| claim.id.clone())
                    .collect(),
            });
        }
    }
    match best {
        Some(batch) if !batch.claims.is_empty() => BatchSelection::Batch(batch),
        _ => BatchSelection::None(BatchSkip::Empty),
    }
}
