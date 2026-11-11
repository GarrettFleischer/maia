//! Request and response values for the SQLite owner.
//!
//! `maia-daemon` maps `maia-core` port values onto these types. This crate does
//! not implement `ThreadLog`, `BrainStore`, or `AuditLog`.

use std::fmt;

/// Fixed v1 vector width of the hash-pinned `bge-small-en-v1.5` model.
pub const EMBEDDING_DIMENSIONS: usize = 384;

/// Parameters for opening the single database file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerOpen {
    /// Database path. The parent directory must already exist.
    pub path: std::path::PathBuf,
    /// Injected timestamp recorded on migrations applied by this open.
    pub now: i64,
    /// Bound of the ordinary command channel. Must be at least 1.
    pub normal_capacity: usize,
    /// Bound of the panic-priority command channel. Must be at least 1.
    pub panic_capacity: usize,
}

/// Reply wrapper that records the owner's total command order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Executed<T> {
    /// One-based order of this command among commands the owner has started.
    pub sequence: u64,
    /// Command result.
    pub value: T,
}

/// Journal mode, foreign-key flag, and schema version of the owner connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionSettings {
    /// `PRAGMA journal_mode` on the owner connection.
    pub journal_mode: String,
    /// `PRAGMA foreign_keys` on the owner connection.
    pub foreign_keys: i64,
    /// `PRAGMA user_version` after migrations.
    pub user_version: i64,
}

/// One applied forward migration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationRow {
    /// Monotonic schema version.
    pub version: i64,
    /// Migration name.
    pub name: String,
    /// Injected time supplied to the open that applied it.
    pub applied_at: i64,
}

/// Binary memory taint stored on episodes, claims, and facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryTaint {
    /// Owner-originated or declassified content.
    Trusted,
    /// Unknown or attacker-controlled content.
    Untrusted,
}

impl MemoryTaint {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Trusted => "trusted",
            Self::Untrusted => "untrusted",
        }
    }
}

/// Graph endpoint kind stored on edges and ledger rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryKind {
    /// Provisional claim.
    Claim,
    /// Canonical fact.
    Fact,
    /// Durable thread-cache slot.
    Slot,
    /// Raw episode.
    Episode,
    /// Lexeme node.
    Lexeme,
}

impl MemoryKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Claim => "claim",
            Self::Fact => "fact",
            Self::Slot => "slot",
            Self::Episode => "episode",
            Self::Lexeme => "lexeme",
        }
    }
}

/// Evidence channel recorded on a presentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceSource {
    /// Readable reasoning.
    Reasoning,
    /// Model-authored tool argument, or a tool-result echo.
    Tool,
    /// Reply fallback.
    Reply,
}

impl EvidenceSource {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Reasoning => "reasoning",
            Self::Tool => "tool",
            Self::Reply => "reply",
        }
    }
}

/// One append-only thread event.
#[derive(Clone, PartialEq, Eq)]
pub struct ThreadEventWrite {
    /// Stable event id, unique within the thread.
    pub event_id: String,
    /// Caller-defined event kind.
    pub kind: String,
    /// Canonical event body.
    pub body: String,
}

/// Compare-and-swap append onto a thread log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendEvents {
    /// Thread identifier.
    pub thread_id: String,
    /// Version the caller last observed. Zero creates the thread.
    pub expected_version: u64,
    /// Canonical participant list. Stored on first insert and must match later.
    pub participants: String,
    /// Injected event time. It is part of the idempotent append identity: the
    /// same events at a different time are an idempotency conflict, not a new
    /// version and not a successful replay.
    pub occurred_at: i64,
    /// Events to append, in order. Empty ensures the thread row exists.
    pub events: Vec<ThreadEventWrite>,
}

/// Version after an append or an idempotent replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppendOutcome {
    /// Thread version after the call.
    pub version: u64,
}

/// One stored thread event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredThreadEvent {
    /// One-based ordinal. The thread version equals the last ordinal.
    pub ordinal: u64,
    /// Stable event id.
    pub event_id: String,
    /// Event kind.
    pub kind: String,
    /// Event body.
    pub body: String,
    /// Injected event time.
    pub occurred_at: i64,
}

/// Reconstructed thread log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadSnapshot {
    /// Thread identifier.
    pub thread_id: String,
    /// Current version.
    pub version: u64,
    /// Participants stored with the thread.
    pub participants: String,
    /// Injected creation time.
    pub created_at: i64,
    /// Events in ordinal order.
    pub events: Vec<StoredThreadEvent>,
}

/// One episode segment.
#[derive(Clone, PartialEq, Eq)]
pub struct SegmentWrite {
    /// Segment text.
    pub text: String,
    /// Segment taint.
    pub taint: MemoryTaint,
    /// Canonical provenance sources.
    pub sources: String,
}

/// Immutable episode insert.
#[derive(Clone, PartialEq, Eq)]
pub struct EpisodeWrite {
    /// Episode id.
    pub episode_id: String,
    /// Owning thread. The thread row must already exist.
    pub thread_id: String,
    /// Turn id.
    pub turn_id: String,
    /// Full text indexed by FTS5.
    pub body: String,
    /// Joined episode taint.
    pub taint: MemoryTaint,
    /// Readable reasoning trace, when the router returned one.
    pub reasoning: Option<String>,
    /// Canonical participants.
    pub participants: String,
    /// Injected creation time.
    pub created_at: i64,
    /// Ordered exchange segments.
    pub segments: Vec<SegmentWrite>,
}

/// One provisional claim produced by promotion.
#[derive(Clone, PartialEq, Eq)]
pub struct PromotionClaimWrite {
    /// Claim id.
    pub claim_id: String,
    /// One sentence.
    pub sentence: String,
    /// Episode taint copied by the caller.
    pub taint: MemoryTaint,
    /// Episode timestamp copied by the caller.
    pub valid_from: i64,
    /// Lexeme ids derived by the caller.
    pub lexemes: Vec<String>,
}

/// Claim replacement applied inside one promotion transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionReplaceWrite {
    /// Existing claim closed by this promotion.
    pub old_claim_id: String,
    /// Successor claim id that must also appear in [`PromotionWrite::claims`].
    pub new_claim_id: String,
}

/// Promotion transaction body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionWrite {
    /// Episode that must already be stored.
    pub episode_id: String,
    /// Model identity.
    pub model: String,
    /// Injected promotion time.
    pub now: i64,
    /// Claims, mention edges, and lexeme edges committed together.
    pub claims: Vec<PromotionClaimWrite>,
    /// Existing claims that only receive a mention edge to this episode.
    pub same_claim_ids: Vec<String>,
    /// Old claims superseded by new claims from `claims`.
    pub replacements: Vec<PromotionReplaceWrite>,
    /// Relatedness and entity edges committed in the same transaction.
    pub links: Vec<PromotionLinkWrite>,
}

/// Relatedness or entity edge written with a promotion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionLinkWrite {
    /// `relatedness` or `entity`.
    pub edge_kind: String,
    /// New claim id. It must appear in [`PromotionWrite::claims`].
    pub from_claim_id: String,
    /// `claim` or `entity`.
    pub to_kind: String,
    /// Existing claim or entity id.
    pub to_id: String,
    /// Weight times 1000. `1000` is weight 1. Untrusted endpoints use a lower value.
    pub weight_millis: u32,
}

/// Host-created approval wait. Grant text and the reason are chosen in code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalWrite {
    /// Decimal approval id. It matches the waiting phase token.
    pub approval_id: String,
    /// Task parked on this approval.
    pub task_id: String,
    /// `login`, `consent`, or `capability`.
    pub kind: String,
    /// Taint of the request, supplied by the host rather than model output.
    pub taint: MemoryTaint,
    /// Injected creation time.
    pub created_at: i64,
    /// Injected expiry. A later decide fails closed.
    pub expires_at: i64,
}

/// One approval still waiting for the owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingApproval {
    /// Decimal approval id.
    pub approval_id: String,
    /// Task parked on this approval.
    pub task_id: String,
    /// `login`, `consent`, or `capability`.
    pub kind: String,
    /// Stored taint.
    pub taint: MemoryTaint,
    /// Plain-language description of what would be granted.
    pub grant_text: String,
    /// Plain-language reason the task is waiting.
    pub reason: String,
    /// Creation time.
    pub created_at: i64,
    /// Expiry time.
    pub expires_at: i64,
}

/// Owner choice on a pending approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    /// Let the task continue.
    Approve,
    /// Stop the task.
    Deny,
}

/// Result of deciding or expiring one approval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalSettlement {
    /// The owner approved. The task may continue.
    Approved {
        /// Task that was waiting.
        task_id: String,
    },
    /// The owner denied. The task should stop.
    Denied {
        /// Task that was waiting.
        task_id: String,
    },
    /// The wait expired before a decision. The task should stop.
    Expired {
        /// Task that was waiting.
        task_id: String,
    },
    /// The row was already approved, denied, or expired.
    AlreadySettled,
}

/// Taint of one stored claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimTaint {
    /// Claim id.
    pub claim_id: String,
    /// Stored taint.
    pub taint: MemoryTaint,
}

/// Entity slug used to link a claim lexeme.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntitySlugRow {
    /// Entity id.
    pub entity_id: String,
    /// Path slug.
    pub slug: String,
}

/// Untrusted file stored beside the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentWrite {
    /// Attachment id. The same bytes may be attached more than once.
    pub attachment_id: String,
    /// Lowercase SHA-256 of the bytes.
    pub content_sha256: String,
    /// Byte length. It must be within the store cap.
    pub byte_size: i64,
    /// Allowlisted media type.
    pub media_type: String,
    /// Display name with no path separators.
    pub safe_name: String,
    /// Path relative to the data directory: `attachments/{sha256}`.
    pub relative_path: String,
    /// Injected creation time.
    pub created_at: i64,
}

/// One stored attachment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRow {
    /// Attachment id.
    pub attachment_id: String,
    /// Lowercase SHA-256 of the bytes.
    pub content_sha256: String,
    /// Byte length.
    pub byte_size: i64,
    /// Allowlisted media type.
    pub media_type: String,
    /// Display name.
    pub safe_name: String,
    /// Path relative to the data directory.
    pub relative_path: String,
    /// Creation time.
    pub created_at: i64,
    /// Message the owner sent this file with, when it is bound.
    pub message_id: Option<String>,
}

/// File cleanup after an unbound attachment is removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletedAttachment {
    /// Path relative to the data directory.
    pub relative_path: String,
    /// True when no remaining row uses this content hash.
    pub remove_file: bool,
}

/// Episode waiting for promotion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPromotionRow {
    /// Episode id.
    pub episode_id: String,
    /// Episode creation time.
    pub created_at: i64,
    /// Consecutive promotion failures so far.
    pub promotion_failures: i64,
}

/// Result of recording one promotion failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionFailureNote {
    /// Failure count after the increment.
    pub failures: i64,
    /// Whether the episode is now quarantined.
    pub quarantined: bool,
}

/// Claim row returned by nearest FTS search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NearestClaimRow {
    /// Claim id.
    pub claim_id: String,
    /// Claim sentence.
    pub sentence: String,
}

/// Provisional claim returned by a same-model vector search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VectorClaimHit {
    /// Claim id.
    pub claim_id: String,
    /// Claim sentence.
    pub sentence: String,
    /// `f32` distance bits. Lower is nearer for non-negative distances.
    pub distance_bits: u32,
}

/// Episode fields needed to run promotion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionEpisodeRow {
    /// Episode id.
    pub episode_id: String,
    /// Owning thread.
    pub thread_id: String,
    /// Full exchange body.
    pub body: String,
    /// Episode taint.
    pub taint: MemoryTaint,
    /// Readable reasoning when present.
    pub reasoning: Option<String>,
    /// Participant labels.
    pub participants: String,
    /// Episode creation time.
    pub created_at: i64,
    /// Ordered segments.
    pub segments: Vec<SegmentWrite>,
}

/// One accepted presentation.
#[derive(Debug, Clone, PartialEq)]
pub struct PresentationWrite {
    /// Presentation id.
    pub presentation_id: String,
    /// Credited endpoint kind.
    pub candidate_kind: MemoryKind,
    /// Credited endpoint id.
    pub candidate_id: String,
    /// Evidence channel.
    pub source: EvidenceSource,
    /// Accepted weight.
    pub weight: f64,
    /// Inclusive-start span in the candidate text.
    pub source_span_start: i64,
    /// Exclusive-end span in the candidate text.
    pub source_span_end: i64,
    /// Inclusive-start span in the evidence text.
    pub evidence_span_start: i64,
    /// Exclusive-end span in the evidence text.
    pub evidence_span_end: i64,
    /// Originating thread.
    pub thread_id: String,
}

/// Slot-heat increment for one ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct HeatWrite {
    /// Durable slot id.
    pub slot_id: String,
    /// Weight added to the slot.
    pub weight: f64,
}

/// Co-use increment already computed by core.
#[derive(Debug, Clone, PartialEq)]
pub struct CoUseWrite {
    /// Lesser or caller-ordered left endpoint kind.
    pub left_kind: MemoryKind,
    /// Left endpoint id.
    pub left_id: String,
    /// Right endpoint kind.
    pub right_kind: MemoryKind,
    /// Right endpoint id.
    pub right_id: String,
    /// Increment, typically `min(weight_a, weight_b)`.
    pub weight: f64,
}

/// Negative correction mark and its dream-queue item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NegativeMarkWrite {
    /// Mark id.
    pub mark_id: String,
    /// Corrected endpoint kind.
    pub target_kind: MemoryKind,
    /// Corrected endpoint id.
    pub target_id: String,
    /// Presentation being corrected. It must be in this ledger.
    pub presentation_id: String,
    /// Correcting thread.
    pub thread_id: String,
    /// Correcting message.
    pub message_id: String,
    /// Inclusive-start evidence span.
    pub evidence_span_start: i64,
    /// Exclusive-end evidence span.
    pub evidence_span_end: i64,
    /// Injected mark time. Also the correction-hold start when the hold is new.
    pub occurred_at: i64,
    /// Dream-queue id created in the same transaction.
    pub dream_queue_id: String,
}

/// One presentation ledger. `ledger_id` is the idempotency key.
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerWrite {
    /// Idempotency key.
    pub ledger_id: String,
    /// Thread whose heat is updated.
    pub thread_id: String,
    /// Request id.
    pub request_id: String,
    /// Compiled-prefix hash.
    pub compiled_prefix_hash: String,
    /// Injected application time.
    pub applied_at: i64,
    /// Presentations inserted in this transaction.
    pub presentations: Vec<PresentationWrite>,
    /// Slot-heat increments.
    pub heat: Vec<HeatWrite>,
    /// Co-use increments.
    pub co_use: Vec<CoUseWrite>,
    /// Negative marks, queue rows, and correction holds.
    pub negative_marks: Vec<NegativeMarkWrite>,
}

/// Entity scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntityScope {
    /// World knowledge.
    World,
    /// One agent's private scope.
    Agent {
        /// Agent id.
        agent_id: String,
    },
}

/// Entity inserted by consolidation.
#[derive(Clone, PartialEq, Eq)]
pub struct EntityWrite {
    /// Entity id.
    pub entity_id: String,
    /// Path slug, unique within the scope.
    pub slug: String,
    /// Description.
    pub description: String,
    /// World or agent scope.
    pub scope: EntityScope,
    /// Related entity ids.
    pub see: Vec<String>,
}

/// Kind of one node in an owner brain map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrainNodeKind {
    /// Canonical fact.
    Fact,
    /// Provisional or superseded claim.
    Claim,
    /// Raw episode.
    Episode,
    /// Lexeme entry point.
    Lexeme,
}

impl BrainNodeKind {
    /// Stable kind name used by the map and its edges.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Claim => "claim",
            Self::Episode => "episode",
            Self::Lexeme => "lexeme",
        }
    }
}

/// One node in the shared brain map.
#[derive(Clone, PartialEq, Eq)]
pub struct BrainNode {
    /// Stable id within `kind`.
    pub id: String,
    /// Fact, claim, episode, or lexeme.
    pub kind: BrainNodeKind,
    /// Short text for the graph and the mirrored list.
    pub label: String,
    /// Full sentence or episode body. Lexemes have none.
    pub sentence: Option<String>,
    /// `trusted` or `untrusted` when the row stores taint.
    pub taint: Option<String>,
    /// Episode thread, or the earliest thread of a fact or claim.
    pub session_id: Option<String>,
    /// The row is in `correction_holds`.
    pub held: bool,
}

/// One directed edge in the shared brain map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrainEdge {
    /// Edge kind, such as `mention` or `lexeme`.
    pub kind: String,
    /// Source node kind.
    pub from_kind: String,
    /// Source node id.
    pub from_id: String,
    /// Target node kind.
    pub to_kind: String,
    /// Target node id.
    pub to_id: String,
    /// Weight times 1000. `1000` is weight 1.
    pub weight_millis: i64,
}

/// Shared brain graph ordered for a stable owner view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrainMap {
    /// Nodes ordered by id, then kind.
    pub nodes: Vec<BrainNode>,
    /// Edges ordered by kind and endpoint ids.
    pub edges: Vec<BrainEdge>,
}

/// Owner rewrite of one canonical fact sentence.
#[derive(Clone, PartialEq, Eq)]
pub struct FactRevise {
    /// Fact that keeps its id.
    pub fact_id: String,
    /// Replacement one-line sentence.
    pub sentence: String,
    /// Lexeme ids that replace this fact's lexeme edges and those of its claims.
    pub lexemes: Vec<String>,
}

/// Canonical fact inserted by consolidation.
#[derive(Clone, PartialEq, Eq)]
pub struct FactWrite {
    /// Fact id.
    pub fact_id: String,
    /// Sentence.
    pub sentence: String,
    /// Optional entity.
    pub entity_id: Option<String>,
    /// Canonical source text.
    pub sources: String,
    /// Validity start supplied by the caller.
    pub valid_from: i64,
    /// Consolidated claim ids.
    pub claim_ids: Vec<String>,
    /// Source episode ids.
    pub episode_ids: Vec<String>,
}

/// Claim superseded by a fact in the same consolidation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupersedeWrite {
    /// Provisional claim.
    pub claim_id: String,
    /// Canonical fact.
    pub fact_id: String,
}

/// Duplicate fact merged into a canonical fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeWrite {
    /// Historical fact.
    pub duplicate_fact_id: String,
    /// Fact it merges into.
    pub canonical_fact_id: String,
}

/// Fact closed by a replacement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosureWrite {
    /// Closed fact.
    pub fact_id: String,
    /// Replacement fact.
    pub replacement_fact_id: String,
    /// Validity end.
    pub valid_to: i64,
}

/// Stored dismissal of a contradiction candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DismissalWrite {
    /// Fact that remains current.
    pub existing_fact_id: String,
    /// Episode that did not contradict it.
    pub episode_id: String,
    /// Pre-pass subject key.
    pub subject_key: String,
    /// Inspection reason.
    pub reason: String,
}

/// Trusted-fact operation deferred for the owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalOperation {
    /// Merge deferred because the batch was untrusted.
    Merge {
        /// Duplicate fact.
        duplicate_fact_id: String,
        /// Canonical fact.
        canonical_fact_id: String,
    },
    /// Closure deferred because the batch was untrusted.
    Close {
        /// Fact that would close.
        fact_id: String,
        /// Proposed replacement.
        replacement_fact_id: String,
    },
}

/// Pending proposal row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalWrite {
    /// Proposal id.
    pub proposal_id: String,
    /// Deferred operation.
    pub operation: ProposalOperation,
    /// Fact the operation would change.
    pub target_fact_id: String,
}

/// Correction hold released in a consolidation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldTarget {
    /// Held endpoint kind.
    pub kind: MemoryKind,
    /// Held endpoint id.
    pub id: String,
}

/// Consolidation transaction. `batch_id` is the idempotency key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsolidationWrite {
    /// Idempotency key.
    pub batch_id: String,
    /// Injected commit time and projection creation time.
    pub now: i64,
    /// Dream-call context taint copied onto new facts.
    pub context_taint: MemoryTaint,
    /// Model identity.
    pub model: String,
    /// Entities inserted in this batch.
    pub entities: Vec<EntityWrite>,
    /// Facts inserted in this batch.
    pub facts: Vec<FactWrite>,
    /// Claims marked superseded.
    pub supersede: Vec<SupersedeWrite>,
    /// Facts marked merged.
    pub merges: Vec<MergeWrite>,
    /// Facts closed.
    pub closures: Vec<ClosureWrite>,
    /// Stored dismissals.
    pub dismissals: Vec<DismissalWrite>,
    /// Deferred trusted-fact proposals.
    pub proposals: Vec<ProposalWrite>,
    /// Dream-queue ids marked consumed.
    pub consumed_queue_ids: Vec<String>,
    /// Correction holds deleted in this transaction.
    pub release_holds: Vec<HoldTarget>,
    /// Entity ids named by the pending projection.
    pub projection_entities: Vec<String>,
    /// Folder indexes named by the pending projection.
    pub projection_folders: Vec<String>,
}

/// One durable projection still waiting for the filesystem phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingProjection {
    /// Batch that enqueued it.
    pub batch_id: String,
    /// Entity ids.
    pub entities: Vec<String>,
    /// Folder indexes.
    pub folders: Vec<String>,
    /// Injected enqueue time.
    pub created_at: i64,
}

/// Mark a pending projection complete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompleteProjection {
    /// Batch id.
    pub batch_id: String,
    /// Injected completion time. The first completion time is kept.
    pub completed_at: i64,
}

/// Who caused an audit event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditActor {
    /// Owner client.
    Owner {
        /// Owner id.
        id: String,
    },
    /// Agent participant.
    Agent {
        /// Agent id.
        id: String,
    },
    /// Daemon system action.
    System,
}

/// One audit event plus the checkpoint written in the same transaction.
#[derive(Clone, PartialEq, Eq)]
pub struct AuditAppend {
    /// One-based chain sequence.
    pub sequence: u64,
    /// Stable event id.
    pub event_id: String,
    /// Affected thread, when there is one.
    pub thread_id: Option<String>,
    /// Actor.
    pub actor: AuditActor,
    /// Event kind.
    pub kind: String,
    /// Causal predecessor event id.
    pub cause_event_id: Option<String>,
    /// Correlated request id.
    pub request_id: Option<String>,
    /// Injected event time.
    pub occurred_at: i64,
    /// Payload hash supplied by the caller.
    pub payload_hash: String,
    /// Previous event hash. The first event must be the maia-core genesis hash.
    /// Later events must name the previous event's `event_hash`.
    pub previous_hash: u64,
    /// [`maia_core::audit::compute_event_hash`] of `canonical`. A different value is rejected.
    pub event_hash: u64,
    /// Canonical bytes.
    pub canonical: Vec<u8>,
    /// Security profile included in the hashed bytes.
    pub profile: String,
    /// Allowlist entry that suppressed a prompt, when one did.
    pub allowlist_entry_id: Option<String>,
    /// Policy version stored on the checkpoint.
    pub policy_version: u64,
    /// Injected checkpoint time.
    pub checkpoint_at: i64,
    /// Optional redacted payload blob addressed by `payload_hash`.
    pub payload: Option<Vec<u8>>,
}

/// Latest checkpoint head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditHead {
    /// Head sequence.
    pub sequence: u64,
    /// Head event hash.
    pub event_hash: u64,
    /// Policy version on that checkpoint.
    pub policy_version: u64,
    /// Checkpoint time.
    pub checkpoint_at: i64,
}

/// Durable panic latch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanicLatch {
    /// Monotonic generation. Clearing does not change it.
    pub generation: u64,
    /// Whether panic is currently engaged.
    pub engaged: bool,
    /// Action that last engaged panic.
    pub engaged_by: Option<String>,
    /// Injected time of the last engage.
    pub engaged_at: Option<i64>,
}

/// Engage the global panic latch and append its audit event together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngagePanic {
    /// Engaging action id.
    pub action_id: String,
    /// Injected engage time.
    pub at: i64,
    /// Audit event committed in the same transaction when the latch changes.
    pub audit: AuditAppend,
}

/// Clear the global panic latch and append its audit event together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearPanic {
    /// Clearing action id.
    pub action_id: String,
    /// Injected clear time.
    pub at: i64,
    /// Audit event committed when the latch changes.
    pub audit: AuditAppend,
}

/// Named security profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecurityProfile {
    /// Prompts and containment stay on.
    Protected,
    /// Matching allowlist entries skip only the approval prompt.
    Allowlisted,
    /// Local-desktop autonomy profile.
    Unrestricted,
}

impl SecurityProfile {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Protected => "protected",
            Self::Allowlisted => "allowlisted",
            Self::Unrestricted => "unrestricted",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, crate::error::StoreError> {
        match value {
            "protected" => Ok(Self::Protected),
            "allowlisted" => Ok(Self::Allowlisted),
            "unrestricted" => Ok(Self::Unrestricted),
            _ => Err(crate::error::StoreError::InvalidRequest {
                message: format!("unknown security profile `{value}`"),
            }),
        }
    }
}

/// Presence proof recorded when the desktop enables `Unrestricted`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceProof {
    /// An authenticated desktop session.
    SessionOnly,
    /// OS user verification.
    OsUserVerification,
}

impl PresenceProof {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::SessionOnly => "session_only",
            Self::OsUserVerification => "os_user_verification",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, crate::error::StoreError> {
        match value {
            "session_only" => Ok(Self::SessionOnly),
            "os_user_verification" => Ok(Self::OsUserVerification),
            _ => Err(crate::error::StoreError::InvalidRequest {
                message: format!("unknown presence proof `{value}`"),
            }),
        }
    }
}

/// Local confirmation required to store `Unrestricted`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnrestrictedConfirmation {
    /// Injected confirmation time.
    pub confirmed_at: i64,
    /// Desktop client id.
    pub desktop_client_id: String,
    /// Presence proof.
    pub presence_proof: PresenceProof,
}

/// Singleton security profile row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecuritySettingsWrite {
    /// Active profile.
    pub profile: SecurityProfile,
    /// Injected activation time.
    pub activated_at: i64,
    /// Client that activated it.
    pub activated_by: String,
    /// Present only for `Unrestricted`.
    pub confirmation: Option<UnrestrictedConfirmation>,
}

/// Allowlist matcher family. The canonical text is caller-supplied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatcherKind {
    /// Command matcher.
    Command,
    /// Web matcher.
    Web,
    /// File matcher.
    File,
    /// Secret matcher.
    Secret,
    /// Browser matcher.
    Browser,
    /// Thread matcher.
    Thread,
}

impl MatcherKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Web => "web",
            Self::File => "file",
            Self::Secret => "secret",
            Self::Browser => "browser",
            Self::Thread => "thread",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, crate::error::StoreError> {
        match value {
            "command" => Ok(Self::Command),
            "web" => Ok(Self::Web),
            "file" => Ok(Self::File),
            "secret" => Ok(Self::Secret),
            "browser" => Ok(Self::Browser),
            "thread" => Ok(Self::Thread),
            _ => Err(crate::error::StoreError::InvalidRequest {
                message: format!("unknown matcher kind `{value}`"),
            }),
        }
    }
}

/// How long an allowlist entry matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantLifetime {
    /// Until revoked.
    Permanent,
    /// Until an injected timestamp.
    ExpiresAt {
        /// Expiry time.
        at: i64,
    },
    /// Until the daemon generation changes.
    DaemonLifetime {
        /// Daemon generation.
        generation: u64,
    },
}

/// One allowlist row. `grant_id` is immutable after insert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowlistEntryWrite {
    /// Grant id.
    pub grant_id: String,
    /// Capability name.
    pub capability: String,
    /// Matcher family.
    pub matcher_kind: MatcherKind,
    /// Canonical matcher text.
    pub matcher_canonical: String,
    /// Optional agent scope.
    pub agent_id: Option<String>,
    /// Lifetime.
    pub lifetime: GrantLifetime,
    /// Whether the entry is enabled. Profile switches do not change this.
    pub enabled: bool,
    /// Injected creation time.
    pub created_at: i64,
    /// Creating client.
    pub created_by: String,
}

/// Selected credential backend. No row exists until onboarding writes one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialBackend {
    /// OS credential store.
    Native,
    /// Encrypted file.
    EncryptedFile,
    /// Vault or OpenBao.
    VaultOpenBao,
}

impl CredentialBackend {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::EncryptedFile => "encrypted_file",
            Self::VaultOpenBao => "vault_openbao",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, crate::error::StoreError> {
        match value {
            "native" => Ok(Self::Native),
            "encrypted_file" => Ok(Self::EncryptedFile),
            "vault_openbao" => Ok(Self::VaultOpenBao),
            _ => Err(crate::error::StoreError::InvalidRequest {
                message: format!("unknown credential backend `{value}`"),
            }),
        }
    }
}

/// Saved model endpoint. The API key is not part of this row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelConnectionRecord {
    /// OpenAI-compatible base URL.
    pub base_url: String,
    /// Model id sent on later calls.
    pub model_id: String,
    /// `low`, `medium`, or `high`.
    pub reasoning: String,
}

/// How an MCP connection reaches its server. Secret values are not stored here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpTransportRecord {
    /// Streamable HTTP endpoint.
    Http {
        /// Absolute URL.
        url: String,
        /// Header names and secret references, in ordinal order.
        headers: Vec<McpSecretSlot>,
    },
    /// Local process. The launcher stays closed until containment is ready.
    Stdio {
        /// Executable name or path.
        command: String,
        /// Arguments.
        args: Vec<String>,
        /// Environment names and secret references, in ordinal order.
        env: Vec<McpSecretSlot>,
    },
}

/// One secret reference on an MCP connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpSecretSlot {
    /// Header or environment name.
    pub name: String,
    /// Key in the secret store. Not the secret value.
    pub secret_ref: String,
}

/// Durable MCP connection without secret values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpConnectionRecord {
    /// Stable connection id.
    pub id: String,
    /// Owner label.
    pub label: String,
    /// Transport and secret references.
    pub transport: McpTransportRecord,
    /// Hash the owner admitted.
    pub admitted_hash: Option<String>,
    /// Canonical JSON from the last successful list.
    pub listed_canonical: Option<String>,
    /// Hash of [`Self::listed_canonical`].
    pub listed_hash: Option<String>,
    /// Last refresh failure, when the list did not replace the manifest.
    pub refresh_error: Option<String>,
}

/// Audit row for one MCP call. Arguments and result bodies are absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpAuditWrite {
    /// Connection id.
    pub connection_id: String,
    /// Wire name.
    pub wire_name: String,
    /// Admitted manifest hash.
    pub manifest_hash: String,
    /// `known_failure`, `known_result`, or `unknown`.
    pub exchange_class: String,
    /// SHA-256 hex of the redacted result.
    pub result_sha256: String,
}

/// Singleton credential-backend selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialBackendWrite {
    /// Active backend.
    pub backend: CredentialBackend,
    /// Encrypted-file idle timeout in milliseconds. Zero when that backend is inactive.
    pub encrypted_file_idle_timeout_ms: u64,
}

/// Platform recorded on a capability snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformKind {
    /// Windows.
    Windows,
    /// Linux.
    Linux,
    /// macOS.
    MacOs,
}

impl PlatformKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Linux => "linux",
            Self::MacOs => "macos",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, crate::error::StoreError> {
        match value {
            "windows" => Ok(Self::Windows),
            "linux" => Ok(Self::Linux),
            "macos" => Ok(Self::MacOs),
            _ => Err(crate::error::StoreError::InvalidRequest {
                message: format!("unknown platform `{value}`"),
            }),
        }
    }
}

/// One platform capability snapshot. The newest 32 rows are retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilitySnapshotWrite {
    /// Snapshot id.
    pub snapshot_id: String,
    /// Injected observation time. Retention orders by this value.
    pub observed_at: i64,
    /// Platform.
    pub platform: PlatformKind,
    /// Adapter version string.
    pub adapter_version: String,
    /// Verdict label.
    pub verdict: String,
    /// Kernel version when Linux reported one.
    pub kernel: Option<String>,
    /// Landlock ABI when Linux reported one.
    pub landlock_abi: Option<i64>,
    /// Canonical probe text.
    pub probe_canonical: String,
}

/// Embedding model metadata. Vectors from other versions must not be mixed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingModelWrite {
    /// Model id.
    pub model_id: String,
    /// Vector width. v1 accepts only [`EMBEDDING_DIMENSIONS`].
    pub dimensions: u64,
    /// Weights content hash.
    pub weights_sha256: String,
    /// Tokenizer content hash.
    pub tokenizer_sha256: String,
    /// Query prefix stored with the model.
    pub query_prefix: String,
    /// Document prefix stored with the model.
    pub document_prefix: String,
    /// Injected record time.
    pub recorded_at: i64,
}

/// Which vec0 table receives a vector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingTarget {
    /// Episode vector.
    Episode,
    /// Claim vector.
    Claim,
    /// Fact vector.
    Fact,
}

/// Vector upsert. The same target and equal bytes replay as a no-op.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingWrite {
    /// Destination table.
    pub target: EmbeddingTarget,
    /// Episode, claim, or fact id.
    pub target_id: String,
    /// Model row that must already exist.
    pub model_id: String,
    /// Little-endian `f32` values. Length must match the model and v1 width.
    pub values: Vec<f32>,
}

/// sqlite-vec build recorded in a vec0 shadow info table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VecVersionMetadata {
    /// `CREATE_VERSION`, expected `v0.1.9` for the pinned extension.
    pub version: String,
    /// Major component.
    pub major: i64,
    /// Minor component.
    pub minor: i64,
    /// Patch component.
    pub patch: i64,
}

/// Which vec0 table to read version metadata from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VecTable {
    /// `episode_vec`.
    Episode,
    /// `claim_vec`.
    Claim,
    /// `fact_vec`.
    Fact,
}

/// Full-text target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextSearch {
    /// Episode body.
    Episode,
    /// Claim sentence.
    Claim,
}

/// One completed router turn kept for the inspector.
#[derive(Clone, PartialEq, Eq)]
pub struct RouterTurnWrite {
    /// Owner message this turn answered.
    pub message_id: String,
    /// Ordered prompt slots as JSON.
    pub slots_json: String,
    /// Provider usage as JSON.
    pub usage_json: String,
    /// Packed recall lines as JSON.
    pub recall_json: String,
    /// Readable reasoning, when the provider returned it.
    pub thinking: Option<String>,
    /// Route tool the host admitted, when this turn admitted one.
    pub route: Option<String>,
    /// Sentence shown to the owner.
    pub reply: String,
    /// Injected creation time.
    pub created_at: i64,
}

/// One router transcript message.
#[derive(Clone, PartialEq, Eq)]
pub struct RouterMessageWrite {
    /// Stable message id.
    pub message_id: String,
    /// Router role label stored as canonical text.
    pub role: String,
    /// Message body.
    pub body: String,
    /// Injected creation time.
    pub created_at: i64,
}

/// Atomic owner-message admission keyed by one client operation.
#[derive(Clone, PartialEq, Eq)]
pub struct MessageSubmissionWrite {
    /// Client-generated idempotency key.
    pub operation_id: String,
    /// Exact owner text bound to this operation.
    pub text: String,
    /// Owner transcript row inserted in the same transaction.
    pub message: RouterMessageWrite,
}

/// Terminal public-safe outcome stored for replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoredSubmissionOutcome {
    /// Routing completed with the named route result.
    Routed {
        /// `admit`, `ask`, or `refuse`.
        route: String,
    },
    /// Routing failed with one stable reason code.
    RoutingFailed {
        /// Public-safe route failure reason.
        reason: String,
    },
    /// A later internal processing stage failed.
    ProcessingFailed,
    /// Opaque future or malformed terminal encoding.
    Unknown,
}

/// Durable lookup/begin state for one client operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageSubmissionState {
    /// No operation row exists.
    Missing,
    /// This begin inserted the operation and owner row.
    New {
        /// Durable owner message id.
        message_id: String,
    },
    /// Owner row exists but no terminal outcome was committed.
    Pending {
        /// Durable owner message id.
        message_id: String,
    },
    /// Terminal outcome is durable and replayable.
    Terminal {
        /// Durable owner message id.
        message_id: String,
        /// Stored public-safe terminal outcome.
        outcome: StoredSubmissionOutcome,
    },
}

/// New parent task session row and its opening attempt.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskWrite {
    /// Task id.
    pub task_id: String,
    /// Encoded phase string from the host skin.
    pub phase: String,
    /// Sidebar title.
    pub title: String,
    /// Encoded pin mark.
    pub pin: String,
    /// Encoded completion view.
    pub completion_view: String,
    /// Optional linked prior task.
    pub prior_task_id: Option<String>,
    /// Creation time.
    pub created_at: i64,
    /// Opening attempt id.
    pub attempt_id: String,
    /// Attempt state label.
    pub attempt_state: String,
}

/// Sealed envelope row. Prompt bytes are insert-once.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskEnvelopeWrite {
    /// Task id.
    pub task_id: String,
    /// Original prompt bytes.
    pub prompt: Vec<u8>,
    /// Advisory brief label.
    pub brief: String,
    /// Routing reason recorded at seal.
    pub routing_reason: String,
    /// Context snapshot id.
    pub snapshot_id: String,
}

/// Complete opening persistence plan for one parent task.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskAggregateWrite {
    /// Session row and opening attempt.
    pub task: TaskWrite,
    /// Sealed prompt and routing envelope.
    pub envelope: TaskEnvelopeWrite,
    /// Advisory context rows stored under `envelope.snapshot_id`.
    pub snapshot_items: Vec<SnapshotItemWrite>,
    /// Initial sealed acceptance criteria.
    pub criteria: Vec<TaskCriterionWrite>,
}

/// Continuation input appended to one task.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskInputWrite {
    /// Task id.
    pub task_id: String,
    /// Source message id.
    pub message_id: String,
    /// Appended prompt bytes.
    pub prompt: Vec<u8>,
}

/// Atomic expected-phase continuation with an optional appended input.
#[derive(Clone, PartialEq, Eq)]
pub struct ContinueTaskWrite {
    /// Parent task identifier.
    pub task_id: String,
    /// Exact phase required before the transition.
    pub expected_phase: String,
    /// Canonical phase stored by the transition.
    pub next_phase: String,
    /// Optional continuation input inserted in the same transaction.
    pub input: Option<TaskInputWrite>,
}

/// One expected parent phase transition inside a host mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskPhaseMutation {
    /// Parent task identifier.
    pub task_id: String,
    /// Exact phase required before commit.
    pub expected_phase: String,
    /// Canonical phase stored by commit.
    pub next_phase: String,
}

/// One expected child phase transition inside a host mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildPhaseMutation {
    /// Child assignment identifier.
    pub child_id: String,
    /// Exact phase required before commit.
    pub expected_phase: String,
    /// Canonical phase stored by commit.
    pub next_phase: String,
}

/// Atomic host transition over every affected parent and descendant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostMutationWrite {
    /// Parent task transitions.
    pub tasks: Vec<TaskPhaseMutation>,
    /// Child assignment transitions.
    pub children: Vec<ChildPhaseMutation>,
}

/// Structured worker report stored on a task.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskReportWrite {
    /// Report id.
    pub report_id: String,
    /// Parent task id.
    pub task_id: String,
    /// Attempt that produced the report.
    pub attempt_id: String,
    /// Report kind label.
    pub kind: String,
    /// Summary text as sent by the worker.
    pub summary: String,
    /// Creation time.
    pub created_at: i64,
    /// Scripted call id. Empty when the report is not a tool step.
    pub call_id: String,
}

/// Completion evidence stored once for one attempt.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskEvidenceWrite {
    /// Evidence id.
    pub evidence_id: String,
    /// Parent task id.
    pub task_id: String,
    /// Attempt that produced the evidence.
    pub attempt_id: String,
    /// Evidence body. `Debug` redacts this field.
    pub body: String,
}

/// One sealed criterion row.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskCriterionWrite {
    /// Criterion id.
    pub criterion_id: String,
    /// Parent task id.
    pub task_id: String,
    /// Source kind label.
    pub source_kind: String,
    /// Source identifier.
    pub source_ref: String,
    /// Inclusive start byte, when the source is a span.
    pub span_start: Option<i64>,
    /// Exclusive end byte, when the source is a span.
    pub span_end: Option<i64>,
    /// Criterion text.
    pub text: String,
}

/// One report row returned with a task view.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredReport {
    /// Report id.
    pub report_id: String,
    /// Summary text.
    pub summary: String,
    /// Scripted call id. Empty when this report is not a tool step.
    pub call_id: String,
}

/// One criterion row returned with a task view.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredCriterion {
    /// Stable zero-based order within the task envelope.
    pub ordinal: i64,
    /// Criterion id.
    pub criterion_id: String,
    /// Criterion text.
    pub text: String,
    /// Stored source kind.
    pub source_kind: String,
    /// Stored source identifier.
    pub source_ref: String,
    /// Inclusive source byte offset.
    pub span_start: Option<i64>,
    /// Exclusive source byte offset.
    pub span_end: Option<i64>,
}

/// One child row returned with a task view.
#[derive(Clone, PartialEq, Eq)]
pub struct StoredHelper {
    /// Child id.
    pub child_id: String,
    /// Subgoal text.
    pub title: String,
}

/// Read-only rows for one parent inspection.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskView {
    /// Task id.
    pub task_id: String,
    /// Sidebar title.
    pub title: String,
    /// Canonical phase text.
    pub phase: String,
    /// Advisory brief.
    pub brief: String,
    /// Sealed prompt bytes.
    pub prompt: Vec<u8>,
    /// Reports in creation order.
    pub reports: Vec<StoredReport>,
    /// Attempt ids in sort order.
    pub attempts: Vec<String>,
    /// Criteria in id order.
    pub criteria: Vec<StoredCriterion>,
    /// Evidence ids in sort order.
    pub artifacts: Vec<String>,
    /// Direct child helpers in id order.
    pub helpers: Vec<StoredHelper>,
}

/// One attempt row on an existing task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskAttemptWrite {
    /// Parent task id.
    pub task_id: String,
    /// Attempt id.
    pub attempt_id: String,
    /// Attempt state label.
    pub state: String,
}

/// One advisory snapshot item, before its ordinal is assigned.
#[derive(Clone, PartialEq, Eq)]
pub struct SnapshotItemWrite {
    /// Brain memory id.
    pub memory_id: String,
    /// Encoded provenance.
    pub provenance: String,
    /// Trust label.
    pub trust: String,
    /// Advisory sentence.
    pub sentence: String,
}

/// One child row used to walk a descendant tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildLink {
    /// Child id.
    pub child_id: String,
    /// Immediate parent task id or parent child id.
    pub parent_task_id: String,
    /// Canonical phase text.
    pub phase: String,
}

/// Collision-safe next values for every durable Super Agent identifier namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeIdSeeds {
    /// Next router or task-input message number.
    pub message: u64,
    /// Next parent task number.
    pub task: u64,
    /// Next attempt number.
    pub attempt: u64,
    /// Next envelope correlation number.
    pub envelope: u64,
    /// Next report number.
    pub report: u64,
    /// Next scripted call/replay number.
    pub call: u64,
    /// Next evidence number.
    pub evidence: u64,
    /// Next context snapshot number.
    pub snapshot: u64,
    /// Next criterion number.
    pub criterion: u64,
    /// Next router request correlation number.
    pub request: u64,
    /// Next child assignment number.
    pub child: u64,
    /// Next detail session number.
    pub detail: u64,
    /// Next abandonment decision number.
    pub decision: u64,
    /// Next host command number.
    pub command: u64,
}

/// Number of runtime identifier namespaces reserved as one durability unit.
pub const RUNTIME_ID_NAMESPACE_COUNT: usize = 14;

/// Legacy generation floor used when v4 history cannot prove every consumed identifier.
pub const LEGACY_RUNTIME_ID_FLOOR: u64 = 4_000_000_000_000_000_000;

/// One durable runtime identifier namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuntimeIdNamespace {
    /// Router and task-input messages.
    Message,
    /// Parent tasks.
    Task,
    /// Task attempts.
    Attempt,
    /// Sealed-envelope correlations.
    Envelope,
    /// Worker reports.
    Report,
    /// Tool call and replay guards.
    Call,
    /// Completion evidence.
    Evidence,
    /// Context snapshots.
    Snapshot,
    /// Acceptance criteria.
    Criterion,
    /// Router request correlations.
    Request,
    /// Child assignments.
    Child,
    /// Detail sessions.
    Detail,
    /// Abandonment decisions.
    Decision,
    /// Host commands.
    Command,
}

impl RuntimeIdNamespace {
    /// Every namespace in stable registry order.
    pub const ALL: [Self; RUNTIME_ID_NAMESPACE_COUNT] = [
        Self::Message,
        Self::Task,
        Self::Attempt,
        Self::Envelope,
        Self::Report,
        Self::Call,
        Self::Evidence,
        Self::Snapshot,
        Self::Criterion,
        Self::Request,
        Self::Child,
        Self::Detail,
        Self::Decision,
        Self::Command,
    ];

    /// Stable key stored in `runtime_id_high_water`.
    pub const fn key(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Task => "task",
            Self::Attempt => "attempt",
            Self::Envelope => "envelope",
            Self::Report => "report",
            Self::Call => "call",
            Self::Evidence => "evidence",
            Self::Snapshot => "snapshot",
            Self::Criterion => "criterion",
            Self::Request => "request",
            Self::Child => "child",
            Self::Detail => "detail",
            Self::Decision => "decision",
            Self::Command => "command",
        }
    }
}

/// How migration v5 establishes a collision-safe legacy high-water mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeIdMigration {
    /// Recover owning rows and also bump above unrecorded legacy allocations.
    OwningRowsWithLegacyBump,
    /// No historical owning row existed; use only the persisted generation bump.
    LegacyBumpOnly,
}

/// How new runtime identifiers are made durable before use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeIdAllocation {
    /// Reserve a checked owner-thread block before any consumer receives it.
    ReservedBlock,
    /// Reserve production blocks and record externally supplied numeric IDs with the owner commit.
    OwningCommitOrReservedBlock,
}

/// Auditable durability contract for one runtime identifier namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeIdContract {
    /// Namespace represented by this row.
    pub namespace: RuntimeIdNamespace,
    /// Stable high-water key.
    pub key: &'static str,
    /// Migration/backfill strategy.
    pub migration: RuntimeIdMigration,
    /// New-allocation strategy.
    pub allocation: RuntimeIdAllocation,
}

const RUNTIME_ID_CONTRACTS: [RuntimeIdContract; RUNTIME_ID_NAMESPACE_COUNT] = [
    runtime_contract(
        RuntimeIdNamespace::Message,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Task,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Attempt,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Envelope,
        RuntimeIdMigration::LegacyBumpOnly,
    ),
    runtime_contract(
        RuntimeIdNamespace::Report,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Call,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Evidence,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Snapshot,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Criterion,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Request,
        RuntimeIdMigration::LegacyBumpOnly,
    ),
    runtime_contract_with_allocation(
        RuntimeIdNamespace::Child,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
        RuntimeIdAllocation::OwningCommitOrReservedBlock,
    ),
    runtime_contract(
        RuntimeIdNamespace::Detail,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Decision,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
    runtime_contract(
        RuntimeIdNamespace::Command,
        RuntimeIdMigration::OwningRowsWithLegacyBump,
    ),
];

const fn runtime_contract(
    namespace: RuntimeIdNamespace,
    migration: RuntimeIdMigration,
) -> RuntimeIdContract {
    runtime_contract_with_allocation(namespace, migration, RuntimeIdAllocation::ReservedBlock)
}

const fn runtime_contract_with_allocation(
    namespace: RuntimeIdNamespace,
    migration: RuntimeIdMigration,
    allocation: RuntimeIdAllocation,
) -> RuntimeIdContract {
    RuntimeIdContract {
        namespace,
        key: namespace.key(),
        migration,
        allocation,
    }
}

/// Returns the complete stable runtime identifier durability registry.
pub fn runtime_id_contracts() -> &'static [RuntimeIdContract] {
    &RUNTIME_ID_CONTRACTS
}

impl RuntimeIdSeeds {
    /// Returns one namespace's first available value.
    pub const fn value(&self, namespace: RuntimeIdNamespace) -> u64 {
        match namespace {
            RuntimeIdNamespace::Message => self.message,
            RuntimeIdNamespace::Task => self.task,
            RuntimeIdNamespace::Attempt => self.attempt,
            RuntimeIdNamespace::Envelope => self.envelope,
            RuntimeIdNamespace::Report => self.report,
            RuntimeIdNamespace::Call => self.call,
            RuntimeIdNamespace::Evidence => self.evidence,
            RuntimeIdNamespace::Snapshot => self.snapshot,
            RuntimeIdNamespace::Criterion => self.criterion,
            RuntimeIdNamespace::Request => self.request,
            RuntimeIdNamespace::Child => self.child,
            RuntimeIdNamespace::Detail => self.detail,
            RuntimeIdNamespace::Decision => self.decision,
            RuntimeIdNamespace::Command => self.command,
        }
    }

    pub(crate) fn set(&mut self, namespace: RuntimeIdNamespace, value: u64) {
        match namespace {
            RuntimeIdNamespace::Message => self.message = value,
            RuntimeIdNamespace::Task => self.task = value,
            RuntimeIdNamespace::Attempt => self.attempt = value,
            RuntimeIdNamespace::Envelope => self.envelope = value,
            RuntimeIdNamespace::Report => self.report = value,
            RuntimeIdNamespace::Call => self.call = value,
            RuntimeIdNamespace::Evidence => self.evidence = value,
            RuntimeIdNamespace::Snapshot => self.snapshot = value,
            RuntimeIdNamespace::Criterion => self.criterion = value,
            RuntimeIdNamespace::Request => self.request = value,
            RuntimeIdNamespace::Child => self.child = value,
            RuntimeIdNamespace::Detail => self.detail = value,
            RuntimeIdNamespace::Decision => self.decision = value,
            RuntimeIdNamespace::Command => self.command = value,
        }
    }
}

/// One atomically reserved block spanning every runtime identifier namespace.
#[derive(Debug, PartialEq, Eq)]
pub struct RuntimeIdBlock {
    first: RuntimeIdSeeds,
    count: u64,
    provenance: RuntimeReservationProvenance,
}

#[derive(Debug, PartialEq, Eq)]
struct RuntimeReservationProvenance;

/// Opaque proof that detail and decision ranges were reserved by the SQLite owner.
#[derive(Debug, PartialEq, Eq)]
pub struct RuntimeHttpIdReservation {
    detail_first: u64,
    decision_first: u64,
    count: u64,
    provenance: RuntimeReservationProvenance,
}

impl RuntimeIdBlock {
    pub(crate) fn new(first: RuntimeIdSeeds, count: u64) -> Self {
        Self {
            first,
            count,
            provenance: RuntimeReservationProvenance,
        }
    }

    /// First reserved value for one namespace.
    pub const fn first(&self, namespace: RuntimeIdNamespace) -> u64 {
        self.first.value(namespace)
    }

    /// Number of reserved values in every namespace.
    pub const fn count(&self) -> u64 {
        self.count
    }

    /// Consumes the reservation into orchestrator seeds and an opaque HTTP proof.
    pub fn into_parts(self) -> (RuntimeIdSeeds, RuntimeHttpIdReservation) {
        let http = RuntimeHttpIdReservation {
            detail_first: self.first.detail,
            decision_first: self.first.decision,
            count: self.count,
            provenance: self.provenance,
        };
        (self.first, http)
    }
}

impl RuntimeHttpIdReservation {
    /// First reserved detail-session value.
    pub const fn detail_first(&self) -> u64 {
        self.detail_first
    }

    /// First reserved abandonment-decision value.
    pub const fn decision_first(&self) -> u64 {
        self.decision_first
    }

    /// Number of reserved values in each HTTP namespace.
    pub const fn count(&self) -> u64 {
        self.count
    }
}

/// One stored task attempt in a startup snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeAttempt {
    /// Attempt identifier.
    pub attempt_id: String,
    /// Stored attempt state.
    pub state: String,
}

/// One stored continuation input in a startup snapshot.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeInput {
    /// Input message identifier.
    pub message_id: String,
    /// Exact stored input bytes.
    pub prompt: Vec<u8>,
}

/// One durable router message needed for criterion source validation.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeMessage {
    /// Message identifier.
    pub message_id: String,
    /// Canonical role label.
    pub role: String,
    /// Exact UTF-8 body.
    pub body: String,
}

/// One stored report in a startup snapshot.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeReport {
    /// Report identifier.
    pub report_id: String,
    /// Attempt that produced the report.
    pub attempt_id: String,
    /// Stored report kind.
    pub kind: String,
    /// Stored summary.
    pub summary: String,
    /// Injected creation time.
    pub created_at: i64,
    /// Scripted call identifier, or empty when no call produced the report.
    pub call_id: String,
}

/// One stored evidence row in a startup snapshot.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeEvidence {
    /// Evidence identifier.
    pub evidence_id: String,
    /// Attempt that produced the evidence.
    pub attempt_id: String,
    /// Stored evidence body.
    pub body: String,
}

/// One sealed envelope and its advisory context rows.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeEnvelope {
    /// Original prompt bytes.
    pub prompt: Vec<u8>,
    /// Advisory brief.
    pub brief: String,
    /// Stored routing reason.
    pub routing_reason: String,
    /// Context snapshot identifier.
    pub snapshot_id: String,
    /// Ordered context snapshot rows.
    pub context: Vec<RuntimeContextItem>,
}

/// One ordered advisory context row in a runtime snapshot.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeContextItem {
    /// Zero-based stored ordinal.
    pub ordinal: i64,
    /// Source memory identifier.
    pub memory_id: String,
    /// Encoded provenance.
    pub provenance: String,
    /// Trust label.
    pub trust: String,
    /// Advisory sentence.
    pub sentence: String,
}

/// Complete durable state for one parent task at startup.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeTask {
    /// Parent task identifier.
    pub task_id: String,
    /// Canonical phase text.
    pub phase: String,
    /// Sidebar title.
    pub title: String,
    /// Stored pin encoding.
    pub pin: String,
    /// Stored completion-view encoding.
    pub completion_view: String,
    /// Optional prior task.
    pub prior_task_id: Option<String>,
    /// Injected creation time.
    pub created_at: i64,
    /// Sealed envelope, absent only when persistence is corrupt.
    pub envelope: Option<RuntimeEnvelope>,
    /// Ordered continuation inputs.
    pub inputs: Vec<RuntimeInput>,
    /// Ordered attempts.
    pub attempts: Vec<RuntimeAttempt>,
    /// Stored criteria.
    pub criteria: Vec<StoredCriterion>,
    /// Ordered reports.
    pub reports: Vec<RuntimeReport>,
    /// Stored evidence.
    pub evidence: Vec<RuntimeEvidence>,
}

/// Complete durable child assignment state at startup.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeChild {
    /// Child identifier.
    pub child_id: String,
    /// Immediate parent task or child identifier.
    pub parent_task_id: String,
    /// Stored nesting depth.
    pub depth: i64,
    /// Exact subgoal bytes.
    pub subgoal: Vec<u8>,
    /// Stored token budget.
    pub budget_tokens: i64,
    /// Stored tool-turn budget.
    pub budget_turns: i64,
    /// Canonical phase text.
    pub phase: String,
}

/// Complete startup input loaded in one owner-thread request.
#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeSnapshot {
    /// Durable router transcript messages used by canonical source validation.
    pub router_messages: Vec<RuntimeMessage>,
    /// Complete parent task state.
    pub tasks: Vec<RuntimeTask>,
    /// Complete child hierarchy state.
    pub children: Vec<RuntimeChild>,
    /// Collision-safe next identifier values.
    pub id_seeds: RuntimeIdSeeds,
}

/// Nested helper assignment under one parent task.
#[derive(Clone, PartialEq, Eq)]
pub struct ChildAssignmentWrite {
    /// Child session id.
    pub child_id: String,
    /// Parent task id.
    pub parent_task_id: String,
    /// Nesting depth.
    pub depth: i64,
    /// Sourced subgoal bytes.
    pub subgoal: Vec<u8>,
    /// Token budget carved from the parent.
    pub budget_tokens: i64,
    /// Turn budget carved from the parent.
    pub budget_turns: i64,
}

/// Read-only inspection view assembled from durable rows.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskInspection {
    /// Sealed prompt bytes.
    pub prompt: Vec<u8>,
    /// Stored pin mark encoding.
    pub pin: String,
    /// Stored completion view encoding.
    pub completion_view: String,
    /// Continuation input message ids in sort order.
    pub input_message_ids: Vec<String>,
    /// Report summaries in creation order.
    pub report_summaries: Vec<String>,
    /// Assigned child ids in sort order.
    pub child_ids: Vec<String>,
}

struct Redacted {
    len: usize,
}

impl fmt::Debug for Redacted {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "<redacted len={}>", self.len)
    }
}

impl fmt::Debug for ThreadEventWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ThreadEventWrite")
            .field("event_id", &self.event_id)
            .field("kind", &self.kind)
            .field(
                "body",
                &Redacted {
                    len: self.body.len(),
                },
            )
            .finish()
    }
}

impl fmt::Debug for SegmentWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SegmentWrite")
            .field("taint", &self.taint)
            .field("sources", &self.sources)
            .field(
                "text",
                &Redacted {
                    len: self.text.len(),
                },
            )
            .finish()
    }
}

impl fmt::Debug for EpisodeWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EpisodeWrite")
            .field("episode_id", &self.episode_id)
            .field("thread_id", &self.thread_id)
            .field("turn_id", &self.turn_id)
            .field("taint", &self.taint)
            .field("participants", &self.participants)
            .field("created_at", &self.created_at)
            .field(
                "body",
                &Redacted {
                    len: self.body.len(),
                },
            )
            .field(
                "reasoning",
                &self
                    .reasoning
                    .as_ref()
                    .map(|text| Redacted { len: text.len() }),
            )
            .field("segments", &self.segments)
            .finish()
    }
}

impl fmt::Debug for PromotionClaimWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PromotionClaimWrite")
            .field("claim_id", &self.claim_id)
            .field("taint", &self.taint)
            .field("valid_from", &self.valid_from)
            .field("lexemes", &self.lexemes)
            .field(
                "sentence",
                &Redacted {
                    len: self.sentence.len(),
                },
            )
            .finish()
    }
}

impl fmt::Debug for EntityWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EntityWrite")
            .field("entity_id", &self.entity_id)
            .field("slug", &self.slug)
            .field("scope", &self.scope)
            .field("see", &self.see)
            .field(
                "description",
                &Redacted {
                    len: self.description.len(),
                },
            )
            .finish()
    }
}

impl fmt::Debug for BrainNode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrainNode")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("taint", &self.taint)
            .field("session_id", &self.session_id)
            .field("held", &self.held)
            .field(
                "label",
                &Redacted {
                    len: self.label.len(),
                },
            )
            .field(
                "sentence",
                &self.sentence.as_ref().map(|sentence| Redacted {
                    len: sentence.len(),
                }),
            )
            .finish()
    }
}

impl fmt::Debug for FactRevise {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FactRevise")
            .field("fact_id", &self.fact_id)
            .field("lexemes", &self.lexemes)
            .field(
                "sentence",
                &Redacted {
                    len: self.sentence.len(),
                },
            )
            .finish()
    }
}

impl fmt::Debug for FactWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FactWrite")
            .field("fact_id", &self.fact_id)
            .field("entity_id", &self.entity_id)
            .field("sources", &self.sources)
            .field("valid_from", &self.valid_from)
            .field("claim_ids", &self.claim_ids)
            .field("episode_ids", &self.episode_ids)
            .field(
                "sentence",
                &Redacted {
                    len: self.sentence.len(),
                },
            )
            .finish()
    }
}

impl fmt::Debug for RouterMessageWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouterMessageWrite")
            .field("message_id", &self.message_id)
            .field("role", &self.role)
            .field(
                "body",
                &Redacted {
                    len: self.body.len(),
                },
            )
            .field("created_at", &self.created_at)
            .finish()
    }
}

impl fmt::Debug for TaskWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskWrite")
            .field("task_id", &self.task_id)
            .field("phase", &self.phase)
            .field("title", &self.title)
            .field("pin", &self.pin)
            .field("completion_view", &self.completion_view)
            .field("prior_task_id", &self.prior_task_id)
            .field("created_at", &self.created_at)
            .field("attempt_id", &self.attempt_id)
            .field("attempt_state", &self.attempt_state)
            .finish()
    }
}

impl fmt::Debug for TaskEnvelopeWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskEnvelopeWrite")
            .field("task_id", &self.task_id)
            .field(
                "prompt",
                &Redacted {
                    len: self.prompt.len(),
                },
            )
            .field("brief", &self.brief)
            .field("routing_reason", &self.routing_reason)
            .field("snapshot_id", &self.snapshot_id)
            .finish()
    }
}

impl fmt::Debug for TaskInputWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskInputWrite")
            .field("task_id", &self.task_id)
            .field("message_id", &self.message_id)
            .field(
                "prompt",
                &Redacted {
                    len: self.prompt.len(),
                },
            )
            .finish()
    }
}

impl fmt::Debug for TaskEvidenceWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskEvidenceWrite")
            .field("evidence_id", &self.evidence_id)
            .field("task_id", &self.task_id)
            .field("attempt_id", &self.attempt_id)
            .field(
                "body",
                &Redacted {
                    len: self.body.len(),
                },
            )
            .finish()
    }
}

impl fmt::Debug for TaskReportWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskReportWrite")
            .field("report_id", &self.report_id)
            .field("task_id", &self.task_id)
            .field("attempt_id", &self.attempt_id)
            .field("kind", &self.kind)
            .field(
                "summary",
                &Redacted {
                    len: self.summary.len(),
                },
            )
            .field("created_at", &self.created_at)
            .field("call_id", &self.call_id)
            .finish()
    }
}

impl fmt::Debug for ChildAssignmentWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ChildAssignmentWrite")
            .field("child_id", &self.child_id)
            .field("parent_task_id", &self.parent_task_id)
            .field("depth", &self.depth)
            .field(
                "subgoal",
                &Redacted {
                    len: self.subgoal.len(),
                },
            )
            .field("budget_tokens", &self.budget_tokens)
            .field("budget_turns", &self.budget_turns)
            .finish()
    }
}

impl fmt::Debug for TaskInspection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskInspection")
            .field(
                "prompt",
                &Redacted {
                    len: self.prompt.len(),
                },
            )
            .field("pin", &self.pin)
            .field("completion_view", &self.completion_view)
            .field("input_message_ids", &self.input_message_ids)
            .field("report_summaries", &self.report_summaries)
            .field("child_ids", &self.child_ids)
            .finish()
    }
}

impl fmt::Debug for AuditAppend {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuditAppend")
            .field("sequence", &self.sequence)
            .field("event_id", &self.event_id)
            .field("thread_id", &self.thread_id)
            .field("actor", &self.actor)
            .field("kind", &self.kind)
            .field("cause_event_id", &self.cause_event_id)
            .field("request_id", &self.request_id)
            .field("occurred_at", &self.occurred_at)
            .field("payload_hash", &self.payload_hash)
            .field("previous_hash", &self.previous_hash)
            .field("event_hash", &self.event_hash)
            .field("profile", &self.profile)
            .field("allowlist_entry_id", &self.allowlist_entry_id)
            .field("policy_version", &self.policy_version)
            .field("checkpoint_at", &self.checkpoint_at)
            .field(
                "canonical",
                &Redacted {
                    len: self.canonical.len(),
                },
            )
            .field(
                "payload",
                &self
                    .payload
                    .as_ref()
                    .map(|bytes| Redacted { len: bytes.len() }),
            )
            .finish()
    }
}
