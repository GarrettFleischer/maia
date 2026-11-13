//! Tool-less episode promotion and memory consolidation contracts.

mod apply;
mod batch;
mod consolidate;
mod decision;
mod error;
mod json;
mod memory;
mod parse;
mod plan;
mod prepass;
mod project;
mod related;
mod schedule;
mod seeds;
mod select;
mod sentence;
mod skip;
mod tags;

pub use apply::{
    ApplyFault, ClaimReplacement, ClaimStatus, CommittedClaim, EpisodeSegment, LexemeEdge,
    MentionEdge, ModelIdentity, PromotedMark, PromotionCommit, PromotionEpisode,
    PromotionInputPart, describe_promotion, describe_promotion_decision, promotion_input_parts,
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
pub use decision::{
    ClaimKind, MAX_CLAIM_SENTENCE_CHARS, NewClaimDraft, PromotionDecision, ReplaceDraft,
    parse_promotion_decision,
};
pub use error::{
    ConsolidationPhase, DreamError, ModelFailure, PromotionError, PromotionPhase, SentenceIssue,
};
pub use memory::{
    ClaimJudgment, FactCategory, NamedEntity, categorize, episode_record, extract_entities,
    is_status_text, judge_claim, looks_like_reasoning, near_duplicate, owner_visible_reply,
    place_city, subject_name, supersedes,
};
pub use parse::{ClaimDraft, parse_promotion};
pub use prepass::{
    ContradictionCandidate, DreamCandidates, DreamEpisode, DreamFact, DuplicateCandidate, EntityId,
    FactCurrency, SubjectKey, propose_dream_candidates,
};
pub use project::{
    PageOutcome, PageSource, ProjectionRender, render_projection, screen_projection_path,
};
pub use related::{
    EntityLink, EntitySlug, LEXICAL_MIN_MILLIS, RELATEDNESS_FANOUT, RelatedCandidate,
    RelatedChannel, RelatedLink, VECTOR_MIN_MILLIS, select_entity_links, select_related_claims,
};
pub use schedule::{
    CallKind, CallTarget, DEFAULT_PROMOTION_FAILURE_LIMIT, DreamBatchId, EpisodeLedger, NoTools,
    OrchestrationPort, PanicLatch, PendingPromotion, PromotionAdmission, PromotionPolicy,
    PromotionQueue, PromotionSchedule, QuarantineChannel, QuarantineNotice, RunnerOccupancy,
    ScheduleSkip, StructuredCall, consolidation_orchestration_ports, note_consolidation_failure,
    note_promotion_failure, plan_consolidation_call, plan_promotion_call,
    promotion_orchestration_ports, release_quarantine, schedule_promotion,
};
pub use seeds::{ClaimSeed, merge_claim_seeds, promotion_backoff_seconds, promotion_claim_id};
pub use tags::{
    KnownTag, TagRole, default_tags, names_for_category, normalize_tag_name, search_kind_rank,
    suggest_tags,
};
pub use select::{
    BatchPolicy, BatchQueue, BatchSelection, BatchSkip, DEFAULT_CONSOLIDATION_FAILURE_LIMIT,
    DEFAULT_IDLE_SECONDS, DEFAULT_UNCONSOLIDATED_THRESHOLD, DreamRequestMode, SelectableClaim,
    SelectedBatch, WakeDecision, WakeObservation, WakePolicy, consolidation_due, select_batch,
};
pub use skip::{PromotionSkipReason, should_skip_promotion};
