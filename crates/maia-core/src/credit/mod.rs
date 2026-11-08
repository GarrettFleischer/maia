//! Activation, attribution, and presentation credit policy.

mod activation;
mod attribute;
mod co_use;
mod correction;
mod types;

pub use activation::{ActivationError, AgeUnit, WeightedPresentation, activation};
pub use attribute::attribute_uses;
pub use co_use::co_use_updates;
pub use correction::correction_mark;
pub use types::{
    Acceptance, AppliedLedger, Attributability, AttributedPresentation, AttributionError,
    AttributionLedger, AttributionScope, CandidateRef, CanonicalMessage, CorrectionEvidence,
    CorrectionHold, DreamQueueId, EdgeIncrement, HeatUpdate, InspectableMatch, LedgerId,
    MatchStatus, MessageId, NegativeMark, PrefixHash, Presentation, ReasoningAvailability,
    RejectionReason, ReversalStatus, ScopedRecallItem, ScopedSlot, TextSpan, ToolTrace, UseSource,
};
