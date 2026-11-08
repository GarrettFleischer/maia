//! Tool-less episode promotion and memory consolidation contracts.

mod apply;
mod batch;
mod consolidate;
mod error;
mod json;
mod parse;
mod plan;
mod prepass;
mod project;
mod schedule;
mod select;
mod sentence;

pub use apply::{
    ApplyFault, ClaimStatus, CommittedClaim, EpisodeSegment, LexemeEdge, MentionEdge,
    ModelIdentity, PromotedMark, PromotionCommit, PromotionEpisode, PromotionInputPart,
    describe_promotion, promotion_input_parts,
};
pub use batch::{
    ClosureDraft, ConsolidationDraft, DismissalDraft, EntityDraft, EntityScope, FactDraft,
    MergeDraft, ReplacementRef, parse_consolidation,
};
pub use consolidate::{
    BatchRecord, ConsolidationCommit, ConsolidationFault, ConsolidationRequest,
    ConsolidationSnapshot, CorrectionConsumption, CorrectionOutcome, DreamProposal, EntityRow,
    OwnerDecision, ProjectionProgress, ProjectionRecord, ProposalDecision, ProposalId,
    ProposedOperation, SnapshotClaim, SnapshotCorrection, decide_proposal, describe_consolidation,
    render_consolidation_model_input,
};
pub use error::{
    ConsolidationPhase, DreamError, ModelFailure, PromotionError, PromotionPhase, SentenceIssue,
};
pub use parse::{ClaimDraft, parse_promotion};
pub use prepass::{
    ContradictionCandidate, DreamCandidates, DreamEpisode, DreamFact, DuplicateCandidate, EntityId,
    FactCurrency, SubjectKey, propose_dream_candidates,
};
pub use project::{
    PageOutcome, PageSource, ProjectionRender, render_projection, screen_projection_path,
};
pub use schedule::{
    CallKind, CallTarget, DEFAULT_PROMOTION_FAILURE_LIMIT, DreamBatchId, EpisodeLedger, NoTools,
    OrchestrationPort, PanicLatch, PendingPromotion, PromotionAdmission, PromotionPolicy,
    PromotionQueue, PromotionSchedule, QuarantineChannel, QuarantineNotice, RunnerOccupancy,
    ScheduleSkip, StructuredCall, consolidation_orchestration_ports, note_consolidation_failure,
    note_promotion_failure, plan_consolidation_call, plan_promotion_call,
    promotion_orchestration_ports, release_quarantine, schedule_promotion,
};
pub use select::{
    BatchPolicy, BatchQueue, BatchSelection, BatchSkip, DEFAULT_CONSOLIDATION_FAILURE_LIMIT,
    DEFAULT_IDLE_SECONDS, DEFAULT_UNCONSOLIDATED_THRESHOLD, DreamRequestMode, SelectableClaim,
    SelectedBatch, WakeDecision, WakeObservation, WakePolicy, consolidation_due, select_batch,
};
