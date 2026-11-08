//! Audit domain identifiers and event shapes.

/// Monotonic audit sequence number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AuditSequence(pub u64);

/// Stable audit event identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AuditEventId(pub u64);

/// Thread identifier referenced by audit events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ThreadId(pub u64);

/// Router request correlation identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RequestId(pub u64);

/// Unix epoch seconds for audit timestamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(pub i64);

/// Content-addressed payload reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AuditHash(pub u64);

impl AuditHash {
    /// First link in a chain uses the all-zero predecessor.
    pub fn genesis() -> Self {
        Self(0)
    }

    /// Deterministic test and fixture helper.
    pub fn from_seed(seed: u8) -> Self {
        Self(u64::from(seed).wrapping_mul(0x9E37_79B9_7F4A_7C15))
    }
}

/// Who performed an audited action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditActor {
    /// Owner-authenticated human action.
    Owner(u64),
    /// Agent participant.
    Agent(u64),
    /// Daemon system action.
    System,
}

/// Required audit event categories (subset used by pure verification).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditKind {
    /// Wake accepted into the queue.
    WakeAccepted,
    /// Thread run transition.
    Transition,
    /// Run lease created.
    LeaseCreated,
    /// Run lease expired.
    LeaseExpired,
    /// Router call started.
    RouterStarted,
    /// Router call completed.
    RouterCompleted,
    /// Tool call accepted.
    ToolAccepted,
    /// Budget reservation recorded.
    BudgetReserved,
    /// Human request opened.
    HumanRequestOpened,
    /// Thread or global stop.
    Stop,
    /// Panic latch engaged.
    PanicEngaged,
    /// Presentation reversal recorded.
    PresentationReversed,
}

/// One append-only audit event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEvent {
    /// Monotonic sequence starting at one.
    pub sequence: u64,
    /// Stable event id.
    pub id: AuditEventId,
    /// Affected thread, if any.
    pub thread_id: Option<ThreadId>,
    /// Actor that caused the event.
    pub actor: AuditActor,
    /// Event category.
    pub kind: AuditKind,
    /// Prior event in a causal chain.
    pub cause: Option<AuditEventId>,
    /// Correlated router request.
    pub request_id: Option<RequestId>,
    /// When the event occurred.
    pub occurred_at: Timestamp,
    /// Hash of redacted payload bytes.
    pub payload_hash: AuditHash,
    /// Hash of the previous event.
    pub previous_hash: AuditHash,
    /// Hash of canonical event bytes including `previous_hash`.
    pub event_hash: AuditHash,
    /// Canonical bytes hashed into `event_hash`.
    pub canonical: Vec<u8>,
}

/// Signed checkpoint payload without cryptography (hash binding only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditCheckpoint {
    /// Sequence covered by this checkpoint.
    pub sequence: u64,
    /// Head hash at `sequence`.
    pub event_hash: AuditHash,
    /// Policy version active when signed.
    pub policy_version: u64,
    /// Checkpoint time.
    pub occurred_at: Timestamp,
}
