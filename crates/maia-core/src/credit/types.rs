//! Attribution and presentation-ledger types.

use crate::agents::{PresentationId, ThreadId};
use crate::audit::{RequestId, Timestamp};
use crate::brain::{MemoryRef, RecallItem, SlotId};

/// Closed evidence channel for a traced use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UseSource {
    /// Readable reasoning returned by the router.
    Reasoning,
    /// Model-authored tool argument, or a tool-result-only echo.
    Tool,
    /// Reply fallback when the turn had no readable reasoning.
    Reply,
}

/// Whether the router returned readable reasoning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasoningAvailability {
    /// Reasoning text is present.
    Available {
        /// Canonical reasoning text.
        text: String,
    },
    /// The router returned no reasoning.
    Missing,
    /// Reasoning was present but blank.
    Blank,
    /// Availability is unresolved; the turn is unattributable for reply credit.
    Unknown,
}

/// Compiled-prefix identity recorded on the request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrefixHash(String);

impl PrefixHash {
    /// Builds a prefix hash from its canonical bytes identity.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrowed hash identity.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether the hash is missing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Inclusive-start exclusive-end byte span.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextSpan {
    /// Start byte index.
    pub start: usize,
    /// End byte index.
    pub end: usize,
}

/// Durable slot included in the request ordinals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedSlot {
    /// Stable slot id.
    pub id: SlotId,
    /// Request ordinal.
    pub ordinal: u32,
    /// Canonical readable slot text.
    pub canonical_text: String,
    /// Linked claim or fact when the slot carries one.
    pub memory: Option<MemoryRef>,
}

/// Recall-block item recorded on the same request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedRecallItem {
    /// Recall item identity.
    pub item: RecallItem,
    /// Canonical recall sentence.
    pub canonical_text: String,
}

/// One tool round-trip's observable arguments and results.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolTrace {
    /// Model-authored arguments.
    pub arguments: String,
    /// Untrusted tool results.
    pub results: String,
}

/// Request-bounded attribution input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttributionScope {
    /// Thread that issued the request.
    pub thread_id: ThreadId,
    /// Request identity.
    pub request_id: RequestId,
    /// Compiled durable prefix hash.
    pub compiled_prefix_hash: PrefixHash,
    /// Included durable slots and ordinals.
    pub slots: Vec<ScopedSlot>,
    /// Recall-block items on this request.
    pub recall: Vec<ScopedRecallItem>,
    /// Readable-reasoning availability.
    pub reasoning: ReasoningAvailability,
    /// Tool arguments and results.
    pub tools: Vec<ToolTrace>,
    /// Assistant reply text.
    pub reply: String,
}

/// Slot or recall candidate that matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CandidateRef {
    /// Durable slot.
    Slot {
        /// Slot id.
        slot_id: SlotId,
        /// Request ordinal.
        ordinal: u32,
        /// Linked memory, if any.
        memory: Option<MemoryRef>,
    },
    /// Recall-block item.
    Recall {
        /// Recall item.
        item: RecallItem,
    },
}

/// Why a match was not accepted as a presentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectionReason {
    /// Echoed only in a tool result.
    ToolResultOnly,
    /// A sentence rejected the fact.
    FactRejected,
}

/// Acceptance or rejection of one inspectable match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchStatus {
    /// Accepted presentation.
    Accepted,
    /// Rejected or zero-weight match.
    Rejected {
        /// Why the match was rejected.
        reason: RejectionReason,
    },
}

/// One inspectable alignment with source and evidence spans.
#[derive(Debug, Clone, PartialEq)]
pub struct InspectableMatch {
    /// Candidate that matched.
    pub candidate: CandidateRef,
    /// Evidence channel.
    pub source: UseSource,
    /// Full, half, or zero weight.
    pub weight: f64,
    /// Span inside canonical candidate text.
    pub source_span: TextSpan,
    /// Span inside the evidence text.
    pub evidence_span: TextSpan,
    /// Acceptance.
    pub status: MatchStatus,
}

/// Accepted presentation written to the ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct AttributedPresentation {
    /// Stable presentation id derived from the ledger identity.
    pub id: PresentationId,
    /// Credited candidate.
    pub candidate: CandidateRef,
    /// Evidence channel.
    pub source: UseSource,
    /// Accepted weight.
    pub weight: f64,
    /// Span inside canonical candidate text.
    pub source_span: TextSpan,
    /// Span inside the evidence text.
    pub evidence_span: TextSpan,
    /// Originating thread.
    pub thread_id: ThreadId,
}

/// Slot-heat increment for a durable slot.
#[derive(Debug, Clone, PartialEq)]
pub struct HeatUpdate {
    /// Durable slot.
    pub slot_id: SlotId,
    /// Accepted weight added to heat.
    pub weight: f64,
}

/// Deterministic ledger identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LedgerId(pub u64);

/// Whether reply fallback may be awarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attributability {
    /// Reasoning availability is resolved.
    Attributable,
    /// Reasoning availability is unknown.
    Unattributable,
}

/// Ledger reversal state. Application skins record later reversals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReversalStatus {
    /// No reversal has been applied.
    NotReversed,
}

/// One request's attribution effects.
#[derive(Debug, Clone, PartialEq)]
pub struct AttributionLedger {
    /// Deterministic ledger id.
    pub id: LedgerId,
    /// Thread identity.
    pub thread_id: ThreadId,
    /// Request identity.
    pub request_id: RequestId,
    /// Compiled prefix hash.
    pub compiled_prefix_hash: PrefixHash,
    /// Accepted and rejected matches.
    pub matches: Vec<InspectableMatch>,
    /// Accepted presentations.
    pub presentations: Vec<AttributedPresentation>,
    /// Durable slot-heat updates.
    pub heat: Vec<HeatUpdate>,
    /// Shared-brain presentation copies of the accepted uses.
    pub brain_presentations: Vec<AttributedPresentation>,
    /// Co-use increments derived from accepted presentations.
    pub co_use: Vec<EdgeIncrement>,
    /// Whether reply fallback was allowed.
    pub attributability: Attributability,
    /// Reversal state.
    pub reversal: ReversalStatus,
}

/// Typed attribution failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributionError {
    /// Compiled prefix hash is missing.
    MissingCompiledHash,
    /// Two included slots share an id.
    DuplicateSlotId,
    /// Two included slots share an ordinal.
    DuplicateOrdinal,
    /// An evidence span does not lie inside the supplied text.
    InvalidSpan,
}

/// Whether a presentation participates in co-use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Acceptance {
    /// Accepted positive use.
    Accepted,
    /// Rejected or zero-weight use.
    Rejected,
}

/// One presentation considered by [`crate::credit::co_use_updates`].
#[derive(Debug, Clone, PartialEq)]
pub struct Presentation {
    /// Presentation id.
    pub id: PresentationId,
    /// Fact or claim identity.
    pub memory: MemoryRef,
    /// Evidence channel.
    pub source: UseSource,
    /// Recorded weight.
    pub weight: f64,
    /// Acceptance.
    pub acceptance: Acceptance,
}

/// Minimum-weight co-use increment between two memories.
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeIncrement {
    /// Lesser memory identity.
    pub left: MemoryRef,
    /// Greater memory identity.
    pub right: MemoryRef,
    /// `min(weight_a, weight_b)`.
    pub weight: f64,
}

/// Already-applied ledger rows visible to correction.
#[derive(Debug, Clone, PartialEq)]
pub struct AppliedLedger {
    /// Thread of the preceding turn.
    pub thread_id: ThreadId,
    /// Preceding request.
    pub request_id: RequestId,
    /// Accepted presentations from that request.
    pub presentations: Vec<AttributedPresentation>,
}

/// Next user-message identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MessageId(pub u64);

/// Canonical next message supplied to [`crate::credit::correction_mark`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalMessage {
    /// Thread of the message.
    pub thread_id: ThreadId,
    /// Message id.
    pub message_id: MessageId,
    /// Request that this message claims to follow.
    pub prior_request: RequestId,
    /// Canonical message text.
    pub text: String,
}

/// Proposed correction evidence. Proposal stays outside this leaf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionEvidence {
    /// Claim or fact being corrected.
    pub target: MemoryRef,
    /// Span inside the next message.
    pub span: TextSpan,
}

/// Immediate quarantine placed on a corrected item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CorrectionHold {
    /// Instant the hold was written.
    pub since: Timestamp,
}

/// Dream-queue item linked to a negative mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DreamQueueId(pub u64);

/// Negative correction mark. History is not deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NegativeMark {
    /// Corrected claim or fact.
    pub target: MemoryRef,
    /// Presentation that is being corrected.
    pub presentation_id: PresentationId,
    /// Correcting thread.
    pub thread_id: ThreadId,
    /// Correcting message.
    pub message_id: MessageId,
    /// Evidence span inside the next message.
    pub evidence_span: TextSpan,
    /// Supplied mark time.
    pub at: Timestamp,
    /// Immediate `CorrectionHold`.
    pub hold: CorrectionHold,
    /// Linked dream-queue item.
    pub dream_queue: DreamQueueId,
}
