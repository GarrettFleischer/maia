//! Promotion admission policy. Clock, stores, and tool hosts stay outside.

use crate::audit::Timestamp;
use crate::brain::EpisodeId;

/// Default promotion failures before an episode leaves selection.
pub const DEFAULT_PROMOTION_FAILURE_LIMIT: u32 = 3;

/// Caller-supplied promotion ceilings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionPolicy {
    /// Failures that quarantine an episode.
    pub failure_limit: u32,
    /// Maximum promotion calls recorded for the supplied day.
    pub daily_ceiling: u32,
    /// Maximum episode input size, in bytes.
    pub input_byte_cap: usize,
}

/// Episode waiting for promotion. The row stays searchable either way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPromotion {
    /// Episode id.
    pub id: EpisodeId,
    /// Commit time used for oldest-pending-first order.
    pub committed_at: Timestamp,
    /// Promotion failures so far.
    pub failures: u32,
    /// Encoded input size supplied by the caller.
    pub input_bytes: usize,
    /// Raw exchange retained for search.
    pub text: String,
}

/// Whether a promotion runner is already inside a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerOccupancy {
    /// No promotion call is in flight.
    Idle,
    /// One promotion call is in flight.
    Busy,
}

/// Panic latch for admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanicLatch {
    /// Promotion may be admitted.
    Clear,
    /// New promotion calls are refused.
    Engaged,
}

/// Inputs to [`schedule_promotion`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromotionQueue<'a> {
    /// Pending episodes.
    pub pending: &'a [PendingPromotion],
    /// Runner occupancy.
    pub occupancy: RunnerOccupancy,
    /// Calls already admitted in the supplied day.
    pub calls_today: u32,
    /// Panic latch.
    pub latch: PanicLatch,
    /// Ceilings.
    pub policy: &'a PromotionPolicy,
}

/// Why no promotion call was admitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleSkip {
    /// Nothing eligible remains.
    Empty,
    /// A promotion call is already running.
    Busy,
    /// Panic latch is engaged.
    Panic,
    /// The daily ceiling is exhausted.
    Ceiling,
}

/// At most one promotion call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromotionSchedule {
    /// No call.
    None(ScheduleSkip),
    /// The single episode to promote.
    One(EpisodeId),
}

/// Selects the oldest eligible episode, or refuses admission.
#[must_use]
pub fn schedule_promotion(queue: &PromotionQueue<'_>) -> PromotionSchedule {
    if queue.latch == PanicLatch::Engaged {
        return PromotionSchedule::None(ScheduleSkip::Panic);
    }
    if queue.occupancy == RunnerOccupancy::Busy {
        return PromotionSchedule::None(ScheduleSkip::Busy);
    }
    if queue.calls_today >= queue.policy.daily_ceiling {
        return PromotionSchedule::None(ScheduleSkip::Ceiling);
    }
    let mut eligible: Vec<&PendingPromotion> = queue
        .pending
        .iter()
        .filter(|episode| {
            episode.failures < queue.policy.failure_limit
                && episode.input_bytes <= queue.policy.input_byte_cap
        })
        .collect();
    eligible.sort_by(|left, right| {
        left.committed_at
            .cmp(&right.committed_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    match eligible.first() {
        Some(episode) => PromotionSchedule::One(episode.id.clone()),
        None => PromotionSchedule::None(ScheduleSkip::Empty),
    }
}

/// Whether an episode may still be promoted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromotionAdmission {
    /// Eligible for selection.
    Eligible,
    /// Removed from promotion selection. The episode row remains.
    Quarantined,
}

/// Failure counter kept beside the searchable episode text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeLedger {
    /// Episode id.
    pub id: EpisodeId,
    /// Raw exchange. Failure accounting does not clear it.
    pub text: String,
    /// Failures counted for this channel.
    pub failures: u32,
    /// Selection admission.
    pub admission: PromotionAdmission,
}

/// Channel that produced a quarantine notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuarantineChannel {
    /// Promotion failures reached the limit.
    Promotion,
    /// Consolidation failures reached the limit.
    Consolidation,
}

/// Inspector event emitted when an episode crosses the failure limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuarantineNotice {
    /// Episode that left selection.
    pub episode_id: EpisodeId,
    /// Which runner quarantined it.
    pub channel: QuarantineChannel,
}

/// Increments the promotion failure count and quarantines at `limit`.
#[must_use]
pub fn note_promotion_failure(
    episode: &EpisodeLedger,
    limit: u32,
) -> (EpisodeLedger, Option<QuarantineNotice>) {
    note_failure(episode, limit, QuarantineChannel::Promotion)
}

/// Increments the consolidation failure count and quarantines at `limit`.
#[must_use]
pub fn note_consolidation_failure(
    episode: &EpisodeLedger,
    limit: u32,
) -> (EpisodeLedger, Option<QuarantineNotice>) {
    note_failure(episode, limit, QuarantineChannel::Consolidation)
}

fn note_failure(
    episode: &EpisodeLedger,
    limit: u32,
    channel: QuarantineChannel,
) -> (EpisodeLedger, Option<QuarantineNotice>) {
    let failures = episode.failures.saturating_add(1);
    let crossed = episode.admission == PromotionAdmission::Eligible && failures >= limit;
    let admission = if failures >= limit {
        PromotionAdmission::Quarantined
    } else {
        episode.admission
    };
    let notice = crossed.then(|| QuarantineNotice {
        episode_id: episode.id.clone(),
        channel,
    });
    (
        EpisodeLedger {
            id: episode.id.clone(),
            text: episode.text.clone(),
            failures,
            admission,
        },
        notice,
    )
}

/// Owner release from the inspector. Search text is unchanged.
#[must_use]
pub fn release_quarantine(episode: &EpisodeLedger) -> EpisodeLedger {
    EpisodeLedger {
        id: episode.id.clone(),
        text: episode.text.clone(),
        failures: 0,
        admission: PromotionAdmission::Eligible,
    }
}

/// Unit witness that a structured call carries no tool host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoTools;

/// Which off-path model call a description refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallKind {
    /// One episode promotion.
    Promotion,
    /// One consolidation batch.
    Consolidation,
}

/// Stable consolidation batch id supplied by the caller.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DreamBatchId(String);

impl DreamBatchId {
    /// Builds a batch id.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed batch id.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Subject of a single structured call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallTarget {
    /// Promotion episode.
    Episode(EpisodeId),
    /// Consolidation batch.
    Batch(DreamBatchId),
}

/// One structured model call with an empty tool host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredCall {
    /// Promotion or consolidation.
    pub kind: CallKind,
    /// Episode or batch being sent.
    pub target: CallTarget,
    /// No tool host is representable on this call.
    pub tool_host: NoTools,
}

/// Describes the single promotion call for `episode`.
#[must_use]
pub fn plan_promotion_call(episode: &EpisodeId) -> StructuredCall {
    StructuredCall {
        kind: CallKind::Promotion,
        target: CallTarget::Episode(episode.clone()),
        tool_host: NoTools,
    }
}

/// Describes the single consolidation call for `batch`.
#[must_use]
pub fn plan_consolidation_call(batch: &DreamBatchId) -> StructuredCall {
    StructuredCall {
        kind: CallKind::Consolidation,
        target: CallTarget::Batch(batch.clone()),
        tool_host: NoTools,
    }
}

/// Ports a promotion runner is allowed to require.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrchestrationPort {
    /// Shared brain.
    Brain,
    /// Structured model router.
    Router,
    /// Idempotent embedder, outside the model call.
    Embedder,
    /// Vault projection after a committed dream.
    Vault,
}

/// Promotion cannot name a vault store or a tool host.
#[must_use]
pub fn promotion_orchestration_ports() -> &'static [OrchestrationPort] {
    &[
        OrchestrationPort::Brain,
        OrchestrationPort::Router,
        OrchestrationPort::Embedder,
    ]
}

/// Consolidation adds the vault projection port and still has no tool host.
#[must_use]
pub fn consolidation_orchestration_ports() -> &'static [OrchestrationPort] {
    &[
        OrchestrationPort::Brain,
        OrchestrationPort::Vault,
        OrchestrationPort::Router,
        OrchestrationPort::Embedder,
    ]
}
