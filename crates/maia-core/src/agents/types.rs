//! Scheduler and thread run-state types.

use crate::audit::Timestamp;

/// Immutable agent identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AgentId(pub u64);

/// Immutable thread identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ThreadId(pub u64);

/// Durable scheduler command identifier for idempotency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CommandId(pub u64);

/// Wake record identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WakeId(pub u64);

/// Human request correlation identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HumanRequestId(pub u64);

/// User action correlation identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct UserActionId(pub u64);

/// Presentation ledger identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PresentationId(pub u64);

/// Idempotent reversal request identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ReversalRequestId(pub u64);

/// Persisted thread run state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadRun {
    /// Actively executing under a lease.
    Running,
    /// Quiescent but eligible for defined wakes.
    Sleeping {
        /// Why the thread is sleeping.
        reason: SleepReason,
    },
    /// Blocked on a specific human action.
    NeedsHuman {
        /// Open human request.
        request: HumanRequest,
    },
    /// No automatic wake is accepted.
    Stopped {
        /// Why the thread stopped.
        reason: StopReason,
    },
}

/// Why a thread is sleeping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SleepReason {
    /// Model returned without tool calls.
    ModelComplete,
    /// Lease budget exhausted.
    BudgetExhausted(BudgetKind),
    /// Restart or lease loss.
    Interrupted,
    /// Transcript alone exceeded budget; resume-in-place is refused.
    TranscriptBudget,
    /// Global spend breaker tripped.
    SpendBreaker,
    /// Retry deferred until a timestamp.
    DeferredRetry {
        /// Earliest retry instant.
        until: Timestamp,
    },
}

/// Which budget ceiling was hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetKind {
    /// Router token ceiling.
    RouterTokens,
    /// Tool turn ceiling.
    ToolTurns,
}

/// Why a thread stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    /// Owner or policy stop.
    OwnerStop,
    /// Too many approval denials in the lease.
    ApprovalDenials,
    /// Human cancelled the pending request.
    Cancelled,
    /// Global panic generation.
    Panic(u64),
    /// Explicit thread stop.
    ThreadStop,
}

/// Human blocker surfaced to the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HumanRequest {
    /// Request identifier.
    pub id: HumanRequestId,
    /// Blocker category.
    pub kind: HumanRequestKind,
}

/// Categories of human requests (subset for scheduler transitions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HumanRequestKind {
    /// Capability approval pending.
    CapabilityApproval,
    /// Credential store locked.
    CredentialUnlock,
    /// Ambiguous external write outcome.
    AmbiguousExternalOutcome,
}

/// Cause recorded on accepted wakes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakeCause {
    /// Owner or human message.
    UserMessage(u64),
    /// Agent participant message.
    ParticipantMessage(u64),
    /// Due schedule occurrence.
    Schedule(u64),
    /// Tool opened a child thread.
    ToolOpenedThread(u64),
    /// Human request resolved.
    HumanResolved(HumanRequestId),
    /// Owner resume action.
    ExplicitResume(UserActionId),
}

/// Global panic latch state supplied to the reducer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PanicState {
    /// Monotonic panic generation.
    pub generation: u64,
    /// Whether panic is engaged.
    pub engaged: bool,
}

/// Scheduler policy inputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchedulerPolicy {
    /// Denials in one lease before `Stopped`.
    pub denial_stop_threshold: u32,
}

/// Thread snapshot for pure transitions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadState {
    /// Current run state.
    pub run: ThreadRun,
    /// Denials recorded in the active lease.
    pub denials_in_lease: u32,
}

/// Events applied by the reducer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchedulerEvent {
    /// Accepted wake with attendance class.
    WakeAccepted {
        /// Idempotency key.
        command_id: CommandId,
        /// Wake cause.
        cause: WakeCause,
        /// Attended vs unattended admission.
        attendance: WakeAttendance,
        /// Effective time for retry and schedule gates.
        effective_at: Timestamp,
    },
    /// Duplicate command id.
    DuplicateCommand {
        /// Seen command id.
        command_id: CommandId,
    },
    /// Model finished without tools.
    ModelComplete,
    /// Budget exhausted.
    BudgetExhausted {
        /// Which ceiling.
        kind: BudgetKind,
    },
    /// Transcript budget exceeded.
    TranscriptBudgetExceeded,
    /// Spend breaker tripped globally.
    SpendBreakerTripped,
    /// Tool opened a human request.
    HumanRequestOpened {
        /// Open request.
        request: HumanRequest,
    },
    /// Human resolved the pending request.
    HumanRequestResolved {
        /// Matching request id.
        id: HumanRequestId,
    },
    /// Owner denied the pending approval.
    HumanRequestDenied {
        /// Matching request id.
        id: HumanRequestId,
    },
    /// Owner cancelled the pending request.
    HumanRequestCancelled {
        /// Matching request id.
        id: HumanRequestId,
    },
    /// Thread stop requested.
    ThreadStop,
    /// Panic engaged.
    PanicEngaged {
        /// Panic generation.
        generation: u64,
    },
    /// Explicit resume after panic cleared.
    ExplicitResume {
        /// Idempotency key.
        command_id: CommandId,
    },
    /// Start a new thread after transcript budget (not resume-in-place).
    StartNewThread {
        /// Idempotency key.
        command_id: CommandId,
    },
    /// Router timeout deferred retry until a timestamp.
    RouterRetryDeferred {
        /// Earliest retry instant.
        until: Timestamp,
    },
}

/// Whether a wake is attended by the owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeAttendance {
    /// Owner-present wake.
    Attended,
    /// Unattended wake.
    Unattended,
}

/// Successful transition output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    /// Next run state.
    pub run: ThreadRun,
    /// Updated denial counter.
    pub denials_in_lease: u32,
    /// Whether a new lease should be granted.
    pub grant_lease: bool,
}

/// Rejected transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransitionError {
    /// Transition not allowed from this state.
    Rejected {
        /// Human-readable reason code.
        reason: TransitionRejectReason,
    },
}

/// Stable reject reason for auditing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionRejectReason {
    /// Thread is stopped.
    Stopped,
    /// Panic latch blocks admission.
    PanicEngaged,
    /// Duplicate command was already applied.
    DuplicateCommand,
    /// Unattended wake under spend breaker.
    SpendBreakerUnattended,
    /// Resume-in-place under transcript budget.
    TranscriptBudgetResume,
    /// No matching human request.
    HumanRequestMismatch,
    /// Panic latch still engaged.
    PanicNotCleared,
    /// Invalid state for event.
    InvalidTransition,
    /// Deferred retry deadline not reached.
    DeferredRetryNotDue,
}

/// Per-lease budget ceilings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunBudget {
    /// Maximum router tokens per lease.
    pub max_router_tokens: u64,
    /// Maximum tool turns per lease.
    pub max_tool_turns: u32,
}

/// Budget consumption including reservations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BudgetUsage {
    /// Charged router tokens.
    pub router_tokens: u64,
    /// Charged tool turns.
    pub tool_turns: u32,
    /// Reserved router tokens.
    pub reserved_router_tokens: u64,
    /// Reserved tool turns.
    pub reserved_tool_turns: u32,
}

/// External step to admit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    /// Router call reservation.
    Router {
        /// Tokens to reserve including conservative output estimate.
        reserve_tokens: u64,
    },
    /// One tool turn reservation.
    Tool,
}

/// Admission request for one step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StepRequest {
    /// Step kind to admit.
    pub kind: StepKind,
}

/// Global spend breaker snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpendBreakerState {
    /// Whether the breaker is tripped.
    pub tripped: bool,
}

/// Reserved budget for a started step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reservation {
    /// Router tokens reserved.
    pub router_tokens: u64,
    /// Tool turns reserved.
    pub tool_turns: u32,
}

/// Budget admission failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BudgetExceeded {
    /// Breaker tripped.
    BreakerTripped,
    /// Lease ceiling reached.
    CeilingReached {
        /// Which ceiling.
        kind: BudgetKind,
    },
}

/// Weighted presentation for reversal.
#[derive(Debug, Clone, PartialEq)]
pub struct Presentation {
    /// Presentation id.
    pub id: PresentationId,
    /// Activation contribution.
    pub activation: f64,
    /// Co-use contribution.
    pub co_use: f64,
}

/// Reversal selection request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReversalRequest {
    /// Idempotency key.
    pub id: ReversalRequestId,
    /// Presentations to reverse.
    pub presentation_ids: Vec<PresentationId>,
}

/// Compensation row appended to the ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerCompensation {
    /// Original presentation.
    pub presentation_id: PresentationId,
    /// Negated activation.
    pub activation_delta: f64,
    /// Negated co-use.
    pub co_use_delta: f64,
    /// Reversal request id.
    pub reversal_id: ReversalRequestId,
}

/// Reversal failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReversalError {
    /// Unknown presentation id.
    UnknownPresentation(PresentationId),
}
