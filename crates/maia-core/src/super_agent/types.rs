//! Typed data contracts for the Super Agent router and task sessions.

use std::fmt;

use crate::agents::{CommandId, HumanRequestId, ThreadId};
use crate::brain::{ClaimId, EpisodeId, FactId};
use crate::security::Taint;

macro_rules! string_newtype {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(pub String);
    };
}

string_newtype! {
    /// Opaque router session identifier.
    RouterSessionId
}
string_newtype! {
    /// Opaque parent or task session identifier.
    TaskId
}
string_newtype! {
    /// Opaque attempt identifier within one task.
    AttemptId
}
string_newtype! {
    /// Opaque nested helper session identifier.
    ChildId
}
string_newtype! {
    /// Opaque sealed task envelope identifier.
    EnvelopeId
}
string_newtype! {
    /// Opaque structured task report identifier.
    ReportId
}
string_newtype! {
    /// Opaque completion criterion identifier.
    CriterionId
}
string_newtype! {
    /// Opaque transcript message identifier.
    MessageId
}
string_newtype! {
    /// Client-owned idempotency identifier for one logical owner submission.
    SubmissionId
}
string_newtype! {
    /// Opaque host-accepted decision identifier.
    DecisionId
}
string_newtype! {
    /// Opaque advisory brain snapshot identifier.
    SnapshotId
}
string_newtype! {
    /// Opaque read-only inspection view identifier.
    InspectionId
}
string_newtype! {
    /// Opaque binding project or design rule identifier.
    RuleId
}
string_newtype! {
    /// Opaque external blocker reference.
    BlockerId
}
string_newtype! {
    /// Opaque external tool call identifier.
    CallId
}
string_newtype! {
    /// Opaque completion evidence record identifier.
    EvidenceId
}
string_newtype! {
    /// Opaque admitted evidence set identifier.
    EvidenceSetId
}
string_newtype! {
    /// Opaque task artifact identifier.
    ArtifactId
}
string_newtype! {
    /// Opaque brain memory row identifier.
    MemoryId
}
string_newtype! {
    /// Opaque read-only detail session identifier.
    DetailSessionId
}
string_newtype! {
    /// Opaque router clarification text payload.
    Clarification
}
string_newtype! {
    /// Opaque advisory brief label for retrieval.
    AdvisoryBrief
}
string_newtype! {
    /// Opaque routing reason recorded on seal.
    RoutingReason
}
string_newtype! {
    /// Opaque grant key for child narrowing.
    GrantKey
}
string_newtype! {
    /// Opaque advisory assumption sentence.
    Assumption
}
string_newtype! {
    /// Exact binding text stored for a rule or accepted decision.
    BindingText
}

/// Confidence as thousandths of the closed unit interval `0..=1000`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Confidence(u16);

/// Error returned when a confidence value is outside `0..=1000`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfidenceError {
    /// The supplied thousandths value exceeds one thousand.
    OutOfRange,
}

impl Confidence {
    /// Constructs confidence from thousandths, rejecting values above `1000`.
    pub fn from_thousandths(value: u16) -> Result<Self, ConfidenceError> {
        if value > 1000 {
            Err(ConfidenceError::OutOfRange)
        } else {
            Ok(Self(value))
        }
    }

    /// Returns the stored thousandths value.
    pub fn thousandths(self) -> u16 {
        self.0
    }
}

/// Remaining router and tool budget for one task attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetCeiling {
    /// Router model tokens still chargeable to this task.
    pub router_tokens: u64,
    /// Tool turns still chargeable to this task.
    pub tool_turns: u32,
}

/// Maximum execution grants carved for a child session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantCeiling {
    /// Grant keys the child may use, a subset of the parent set.
    pub grants: std::collections::BTreeSet<GrantKey>,
}

/// Immutable original user prompt bytes sealed onto a task envelope.
#[derive(Clone, PartialEq, Eq)]
pub struct UserPromptBytes {
    /// Transcript message that supplied the bytes.
    pub message: MessageId,
    /// Exact UTF-8 bytes admitted at seal time.
    pub utf8: Vec<u8>,
}

impl fmt::Debug for UserPromptBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UserPromptBytes")
            .field("message", &self.message)
            .field("byte_len", &self.utf8.len())
            .finish()
    }
}

/// Which session role owns a log or report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionRole {
    /// User-facing router control session with no execution tools.
    Router,
    /// Parent task session investigating one admitted goal.
    ParentTask {
        /// Parent task identifier.
        task: TaskId,
    },
    /// Nested helper session under one parent task.
    ChildTask {
        /// Parent task identifier.
        task: TaskId,
        /// Child helper identifier.
        child: ChildId,
    },
}

/// What triggered a router control turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnSource {
    /// Owner message in the router composer.
    UserMessage {
        /// Stored message identifier.
        message: MessageId,
    },
    /// Structured report from a task session.
    TaskReport {
        /// Stored report identifier.
        report: ReportId,
    },
    /// Host stop, stop all, or abandon control.
    HostControl {
        /// Control command identifier.
        command: CommandId,
    },
}

/// Route target cited by a control decision; children are never admitted routes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteTarget {
    /// A parent task session.
    Parent(TaskId),
    /// A nested helper id cited in a proposal (never admitted).
    Child(ChildId),
}

/// One untrusted model-proposed routing outcome before structural conversion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposedRouteDecision {
    /// Attach the user message to a cited parent or child target.
    Continue {
        /// Cited route target (child ids are never admitted).
        target: RouteTarget,
    },
    /// Seal one new parent task from the user message.
    CreateTask,
    /// Create a linked parent after a terminal modification.
    CreateLinked {
        /// Prior task cited by the proposal.
        prior: RouteTarget,
        /// Link kind between parents.
        link: TaskLink,
    },
    /// Build a read-only inspection view for one cited target.
    Inspect {
        /// Cited route target (child ids are never admitted).
        target: RouteTarget,
    },
    /// Ask the owner for clarification in the router transcript.
    AskUser {
        /// Clarification text to relay.
        clarification: Clarification,
    },
    /// Relay a compact task report to the owner.
    Relay {
        /// Report to relay.
        report: ReportId,
    },
    /// Cancel one non-terminal parent task.
    Cancel {
        /// Cited route target (child ids are never admitted).
        target: RouteTarget,
    },
    /// Retry a failed parent task with a new attempt.
    Retry {
        /// Cited route target (child ids are never admitted).
        target: RouteTarget,
    },
}

/// Whether the model proposed one route or a split across multiple creates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposalShape {
    /// One admitted decision for this message.
    Single,
    /// Multiple creates from one message (never admitted as a split list).
    Split,
}

/// Host-admitted routing outcome naming only parent task ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteDecision {
    /// Attach the user message to an eligible parent task.
    Continue {
        /// Parent task to continue.
        task: TaskId,
    },
    /// Seal one new parent task from the user message.
    CreateTask,
    /// Create a linked parent after a terminal modification.
    CreateLinked {
        /// Terminal parent being modified.
        prior: TaskId,
        /// Link kind between parents.
        link: TaskLink,
    },
    /// Build a read-only inspection view for one parent.
    Inspect {
        /// Parent task to inspect.
        task: TaskId,
    },
    /// Ask the owner for clarification in the router transcript.
    AskUser {
        /// Clarification text to relay.
        clarification: Clarification,
    },
    /// Relay a compact task report to the owner.
    Relay {
        /// Report to relay.
        report: ReportId,
    },
    /// Cancel one non-terminal parent task.
    Cancel {
        /// Parent task to cancel.
        task: TaskId,
    },
    /// Retry a failed parent task with a new attempt.
    Retry {
        /// Failed parent task to retry.
        task: TaskId,
    },
}

/// How a linked parent relates to its prior terminal task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLink {
    /// The new task modifies completed work.
    Modifies,
    /// The new task follows up on completed work.
    FollowsUp,
}

/// Model output proposing one route before host admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteProposal {
    /// Untrusted routing decision before structural conversion.
    pub proposed: ProposedRouteDecision,
    /// Whether the model split one message into multiple creates.
    pub shape: ProposalShape,
    /// Parent tasks the model considered.
    pub considered: Vec<TaskId>,
    /// Self-reported confidence in thousandths.
    pub confidence: Confidence,
    /// Self-reported margin over the next alternative in thousandths.
    pub margin: Confidence,
}

/// Thresholds supplied by the composition root for route admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoutingPolicy {
    /// Minimum confidence required to admit structural routes.
    pub min_confidence: Confidence,
    /// Minimum margin required to admit structural routes.
    pub min_margin: Confidence,
    /// Maximum length of the considered parent list.
    pub max_considered: u32,
}

/// Host outcome after structural and policy route admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmittedRoute {
    /// Structural checks passed and policy thresholds met.
    Admit(RouteDecision),
    /// Owner clarification is required before any task starts.
    AskUser {
        /// Clarification to write into the router transcript.
        clarification: Clarification,
    },
    /// The proposal is refused for this turn source.
    Refuse {
        /// Refusal reason recorded by the host.
        reason: RouteRefuse,
    },
}

/// Why a route proposal is refused without starting work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteRefuse {
    /// A task report wake attempted a non-relay control.
    ReportWake,
    /// A proposal named a child id as a route target.
    ChildTarget,
    /// A proposal split one message into multiple creates.
    SplitProposal,
    /// A host-control turn attempted model route admission instead of `reduce_phase`.
    HostControlBypass,
}

/// Host-owned lifecycle phase of one parent task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskPhase {
    /// Envelope sealed and waiting for an attempt slot.
    Queued,
    /// An attempt is actively running.
    Running {
        /// Active attempt identifier.
        attempt: AttemptId,
    },
    /// The task waits for owner or host input.
    WaitingForUser {
        /// Why the task is waiting.
        reason: WaitReason,
    },
    /// The task is blocked on an external dependency.
    Blocked {
        /// Blocker reference supplied by the worker.
        reason: BlockerId,
    },
    /// The attempt failed and may be retried.
    Failed {
        /// Attempt that failed.
        attempt: AttemptId,
        /// Failure classification.
        kind: FailureKind,
    },
    /// Completion gate admitted terminal success.
    Completed {
        /// Evidence set cited by the gate.
        evidence: EvidenceSetId,
    },
    /// Owner or host stopped the task. Non-terminal: the owner's next message
    /// lets the router continue or retry it.
    Stopped {
        /// Host command that stopped the task.
        command: CommandId,
    },
    /// Owner cancelled the task. Terminal.
    Cancelled {
        /// Host command that cancelled the task.
        command: CommandId,
    },
    /// Owner explicitly abandoned the task.
    Abandoned {
        /// Owner decision that abandoned the task.
        decision: DecisionId,
    },
}

/// Why a task waits in `WaitingForUser`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitReason {
    /// Router clarification is outstanding.
    Clarification,
    /// The worker asked a task-scoped question.
    TaskQuestion {
        /// Report that asked the question.
        report: ReportId,
    },
    /// A criterion needs an explicit waiver decision.
    WaiverNeeded {
        /// Criterion awaiting waiver.
        criterion: CriterionId,
    },
    /// An external tool call ended with unknown outcome.
    UnknownExternalOutcome {
        /// Attempt when the call was issued.
        attempt: AttemptId,
        /// Call id that must not be replayed.
        call: CallId,
    },
    /// Host security approval is outstanding.
    Approval {
        /// Approval request identifier.
        request: HumanRequestId,
    },
    /// The task log hit transcript budget and waits for owner action.
    TranscriptBudget,
    /// The worker stored a report and the model call is finished.
    Settled {
        /// Report that ended the model call.
        report: ReportId,
    },
}

/// Classification of a failed attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The worker reported failure.
    WorkerReported,
    /// Router or tool budget was exhausted.
    BudgetExhausted,
    /// The host could not verify attempt progress after restart.
    AttemptFailed,
}

/// Host control commands applied directly by `reduce_phase`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCommand {
    /// Stop one non-terminal parent task and hold it until the owner's next message.
    Stop {
        /// Parent task to stop.
        task: TaskId,
        /// Command recorded on the stopped phase.
        command: CommandId,
    },
    /// Stop every non-terminal parent and descendant and hold them until the owner's next message.
    StopAll {
        /// Command recorded on each stopped phase.
        command: CommandId,
    },
    /// Cancel one non-terminal parent task. Terminal.
    Cancel {
        /// Parent task to cancel.
        task: TaskId,
        /// Command recorded on the cancelled phase.
        command: CommandId,
    },
    /// Abandon one non-terminal parent task by owner decision.
    Abandon {
        /// Parent task to abandon.
        task: TaskId,
        /// Owner decision recorded on the abandoned phase.
        decision: DecisionId,
        /// Command recorded on each cancelled descendant. Not stored on the parent.
        command: CommandId,
    },
}

/// Host events that drive the task phase reducer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhaseEvent {
    /// An attempt slot started for a queued task.
    StartAttempt {
        /// New attempt identifier.
        attempt: AttemptId,
    },
    /// The worker moved the task to a wait state.
    Wait {
        /// Wait reason to record.
        reason: WaitReason,
    },
    /// The worker reported a blocker.
    Block {
        /// Blocker reference.
        blocker: BlockerId,
    },
    /// The worker or host reported attempt failure.
    Fail {
        /// Failure classification.
        kind: FailureKind,
    },
    /// Completion gate supplied evidence for terminal success.
    Complete {
        /// Admitted evidence set identifier.
        evidence: EvidenceSetId,
    },
    /// A continue input arrived without starting a new attempt.
    Continue {
        /// Call id that must not be replayed on this continue, if any.
        replay_forbidden: Option<CallId>,
    },
    /// Owner or host admitted a retry from failed.
    Retry {
        /// New attempt identifier for the retry.
        attempt: AttemptId,
    },
    /// Host stop, stop all, or abandon command.
    Host(HostCommand),
}

/// Kind of structured report emitted by a task session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportKind {
    /// Progress update with optional sidebar summary refresh.
    Progress,
    /// Worker question requiring owner input.
    WaitingQuestion,
    /// External blocker reported.
    Blocker,
    /// Attempt failure reported.
    Failure,
    /// Worker proposes completion pending gate admission.
    CompletionProposed,
    /// Cancellation noted by the worker.
    CancellationNoted,
    /// Evidence artifact cited toward completion.
    Evidence,
    /// Criterion mark update.
    CriterionStatus,
}

/// Provenance of binding criterion or constraint text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CriterionSource {
    /// Span of the original user message bytes.
    UserText {
        /// Message whose bytes are sliced.
        message: MessageId,
        /// Inclusive-start byte offset into `utf8`.
        start: u32,
        /// Exclusive-end byte offset into `utf8`.
        end: u32,
    },
    /// Stored binding rule from the host rule set.
    BindingRule {
        /// Rule identifier present in the host set.
        rule: RuleId,
    },
    /// Prior host-accepted decision on this task.
    AcceptedDecision {
        /// Decision identifier present in the host set.
        decision: DecisionId,
    },
}

/// One binding completion criterion sealed on the envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Criterion {
    /// Stable criterion identifier.
    pub id: CriterionId,
    /// Human-readable obligation text.
    pub text: String,
    /// Provenance tying the text to prompt, rule, or decision bytes.
    pub source: CriterionSource,
}

/// One binding constraint sealed on the envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Constraint {
    /// Human-readable constraint text.
    pub text: String,
    /// Provenance tying the text to prompt, rule, or decision bytes.
    pub source: CriterionSource,
}

/// Criterion disposition attached to a structured report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CriterionMark {
    /// Criterion not yet satisfied.
    Pending {
        /// Pending criterion.
        criterion: CriterionId,
    },
    /// Criterion satisfied with stored evidence.
    Satisfied {
        /// Satisfied criterion.
        criterion: CriterionId,
        /// Evidence id stored for this attempt.
        evidence: EvidenceId,
    },
    /// Criterion waived by an accepted decision.
    Waived {
        /// Waived criterion.
        criterion: CriterionId,
        /// Decision that waived the criterion.
        decision: DecisionId,
    },
    /// Criterion marked inapplicable with sourced justification.
    Inapplicable {
        /// Inapplicable criterion.
        criterion: CriterionId,
        /// Source justifying inapplicability.
        source: CriterionSource,
    },
}

/// Pin state for sidebar placement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinMark {
    /// Row stays in the pinned section regardless of phase.
    Pinned,
    /// Row follows normal phase-based placement.
    Unpinned,
}

/// Whether the owner opened the read-only detail view for a completed task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionView {
    /// Detail was never opened after completion.
    Unopened,
    /// Detail is open or was opened and not yet closed once.
    Open {
        /// Detail session identifier for the open view.
        detail: DetailSessionId,
    },
    /// Detail was opened once and then closed.
    ClosedOnce,
}

/// Host event that moves the completion detail view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionViewEvent {
    /// First open of the read-only detail.
    Open {
        /// Detail session created for this open.
        detail: DetailSessionId,
    },
    /// Close of the currently open detail.
    Close,
}

/// Sidebar section for one parent task row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarSection {
    /// Tasks needing owner attention.
    NeedsYou,
    /// Tasks actively queued or running.
    Working,
    /// Completed tasks before first detail close.
    Completed,
    /// Pinned tasks regardless of phase.
    Pinned,
    /// Archived terminal or closed-once completed tasks.
    Archive,
}

/// Execution tools available to task roles when grants allow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ExecutionTool {
    /// Shell execution under task grants.
    Shell,
    /// Filesystem access under task grants.
    Filesystem,
    /// Browser automation under task grants.
    Browser,
    /// Network execution under task grants.
    Network,
    /// Vault access under task grants.
    Vault,
    /// Open another thread under task grants.
    OpenThread,
    /// Post to another thread under task grants.
    PostToThread,
}

/// Standing label for advisory brain snapshot items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvisoryStanding {
    /// Memory text is advisory only and not binding evidence.
    Advisory,
}

/// Provenance of one ranked memory sentence.
///
/// Episode paths cite `crate::agents::ThreadId`, the scheduler thread identity that owns
/// the durable episode provenance, alongside `crate::brain::EpisodeId`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryProvenance {
    /// Memory recalled from an episode path.
    Episode {
        /// Episode identifier.
        episode: EpisodeId,
        /// Scheduler thread that owns the episode path.
        thread: ThreadId,
    },
    /// Memory recalled from a claim node.
    Claim {
        /// Claim identifier.
        claim: ClaimId,
    },
    /// Memory recalled from a fact node.
    Fact {
        /// Fact identifier.
        fact: FactId,
    },
}

/// One ranked memory row before snapshot installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RankedMemory {
    /// Brain memory identifier.
    pub memory: MemoryId,
    /// Sentence text retrieved for the task context.
    pub sentence: String,
    /// Provenance of the memory row.
    pub provenance: MemoryProvenance,
    /// Trust label preserved from brain ranking.
    pub trust: Taint,
}

/// One advisory item installed in a task brain snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextItem {
    /// Snapshot that installed this item.
    pub snapshot: SnapshotId,
    /// Brain memory identifier.
    pub memory: MemoryId,
    /// Sentence text shown to the worker.
    pub sentence: String,
    /// Provenance of the memory row.
    pub provenance: MemoryProvenance,
    /// Trust label preserved from ranking.
    pub trust: Taint,
    /// Standing marking the item as advisory only.
    pub standing: AdvisoryStanding,
}

/// Envelope fields collected before seal admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeDraft {
    /// Envelope identifier assigned at seal.
    pub id: EnvelopeId,
    /// Task receiving the sealed envelope.
    pub task: TaskId,
    /// Attempt granted when the envelope is sealed.
    pub origin_attempt: AttemptId,
    /// Prompt bytes proposed for seal.
    pub original_prompt: UserPromptBytes,
    /// Advisory brief used only for retrieval labeling.
    pub brief: AdvisoryBrief,
    /// Binding criteria proposed for seal.
    pub criteria: Vec<Criterion>,
    /// Binding constraints proposed for seal.
    pub constraints: Vec<Constraint>,
    /// Initial advisory snapshot proposed for the task.
    pub context: SnapshotId,
    /// Advisory assumptions that are not criterion sources.
    pub assumptions: Vec<Assumption>,
    /// Resolved questions stored on the sealed envelope.
    pub question_log: Vec<ResolvedQuestion>,
    /// Count of open questions that block seal.
    pub open_question_count: u32,
    /// Why the host admitted this create or link route.
    pub routing_reason: RoutingReason,
}

/// Sealed immutable task envelope stored by the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEnvelope {
    /// Envelope identifier assigned at seal.
    pub id: EnvelopeId,
    /// Parent task owning the envelope.
    pub task: TaskId,
    /// Attempt active when the envelope was sealed.
    pub origin_attempt: AttemptId,
    /// Immutable original user prompt bytes.
    pub original_prompt: UserPromptBytes,
    /// Advisory brief snapshotted for retrieval.
    pub brief: AdvisoryBrief,
    /// Binding criteria sealed on the envelope.
    pub criteria: Vec<Criterion>,
    /// Binding constraints sealed on the envelope.
    pub constraints: Vec<Constraint>,
    /// Initial advisory snapshot attached to the task.
    pub context: SnapshotId,
    /// Why the host admitted this create or link route.
    pub routing_reason: RoutingReason,
    /// Advisory assumptions sealed for transparency.
    pub assumptions: Vec<Assumption>,
    /// Resolved questions sealed on the envelope.
    pub question_log: Vec<ResolvedQuestion>,
}

/// One resolved question sealed on the envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedQuestion {
    /// Decision that resolved the question.
    pub decision: DecisionId,
}

/// Continuation input appended without resealing the envelope.
#[derive(Clone, PartialEq, Eq)]
pub struct TaskInput {
    /// Task receiving the input.
    pub task: TaskId,
    /// Message identifier for the new bytes.
    pub message: MessageId,
    /// New user message bytes appended to the task.
    pub utf8: Vec<u8>,
    /// Route decision that admitted the input.
    pub admitted: RouteDecision,
}

impl fmt::Debug for TaskInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TaskInput")
            .field("task", &self.task)
            .field("message", &self.message)
            .field("byte_len", &self.utf8.len())
            .field("admitted", &self.admitted)
            .finish()
    }
}

/// Structured status report from a parent or child session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskReport {
    /// Report identifier assigned by the host.
    pub id: ReportId,
    /// Task emitting the report.
    pub task: TaskId,
    /// Attempt active when the report was emitted.
    pub attempt: AttemptId,
    /// Session role that authored the report.
    pub author: SessionRole,
    /// Report classification.
    pub kind: ReportKind,
    /// Sidebar summary line supplied by the worker.
    pub summary: String,
    /// Criterion marks carried by this report.
    pub criterion: Vec<CriterionMark>,
    /// Evidence ids cited by this report.
    pub evidence: Vec<EvidenceId>,
}

/// Byte slice tied to a criterion source for child narrowing.
#[derive(Clone, PartialEq, Eq)]
pub struct SourcedSlice {
    /// Provenance tying bytes to envelope or decision sources.
    pub source: CriterionSource,
    /// Exact UTF-8 bytes for the slice.
    pub utf8: Vec<u8>,
}

impl fmt::Debug for SourcedSlice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SourcedSlice")
            .field("source", &self.source)
            .field("byte_len", &self.utf8.len())
            .finish()
    }
}

/// Child assignment proposal before host narrowing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildAssignmentDraft {
    /// Child session identifier to create.
    pub child: ChildId,
    /// Parent task owning the child.
    pub parent: TaskId,
    /// Parent attempt carving budget for the child.
    pub parent_attempt: AttemptId,
    /// Narrow subgoal bytes with sourced provenance.
    pub subgoal: SourcedSlice,
    /// Additional envelope slices copied into the child context.
    pub envelope_slices: Vec<SourcedSlice>,
    /// Advisory snapshot attached to the child.
    pub context: SnapshotId,
    /// Proposed grant ceiling for the child.
    pub ceiling: GrantCeiling,
    /// Proposed budget ceiling for the child.
    pub budget: BudgetCeiling,
}

/// Admitted child assignment after narrowing checks pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildAssignment {
    /// Child session identifier.
    pub child: ChildId,
    /// Parent task owning the child.
    pub parent: TaskId,
    /// Parent attempt carving budget for the child.
    pub parent_attempt: AttemptId,
    /// Narrow subgoal bytes with sourced provenance.
    pub subgoal: SourcedSlice,
    /// Envelope slices copied into the child context.
    pub envelope_slices: Vec<SourcedSlice>,
    /// Advisory snapshot attached to the child.
    pub context: SnapshotId,
    /// Admitted grant ceiling subset of the parent.
    pub ceiling: GrantCeiling,
    /// Admitted budget subset of the parent remainder.
    pub budget: BudgetCeiling,
}

/// Explicit child nesting limit supplied by the composition root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChildPolicy {
    /// Maximum helper depth below the parent.
    pub max_depth: u32,
}

/// Read-only transcript bytes in an inspection view.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionTranscript {
    /// Session log bytes for one role.
    pub utf8: Vec<u8>,
}

impl fmt::Debug for SessionTranscript {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionTranscript")
            .field("byte_len", &self.utf8.len())
            .finish()
    }
}

/// Ephemeral read-only view of one parent task and its descendants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectionView {
    /// Inspection view identifier.
    pub id: InspectionId,
    /// Root parent task shown in the view.
    pub root: TaskId,
    /// Session transcripts for the parent and descendants.
    pub transcripts: Vec<SessionTranscript>,
    /// Structured reports stored for the tree.
    pub reports: Vec<TaskReport>,
    /// Artifact ids referenced by the tree.
    pub artifacts: Vec<ArtifactId>,
    /// Decision ids referenced by the tree.
    pub decisions: Vec<DecisionId>,
    /// Tool call ids that ended with errors.
    pub errors: Vec<CallId>,
    /// Criterion marks stored for the tree.
    pub criteria: Vec<CriterionMark>,
    /// Child ids under the root parent.
    pub children: Vec<ChildId>,
}

/// Errors returned while sealing a task envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealError {
    /// Draft prompt bytes differ from the admitted user message.
    PromptMismatch,
    /// A cited user-text span does not match criterion or constraint text.
    SpanMismatch,
    /// Open questions remain on the draft.
    UnresolvedQuestion,
    /// Prompt bytes are not valid UTF-8 for recall query construction.
    PromptNotUtf8,
    /// A criterion or constraint cites a missing binding rule.
    MissingRule,
    /// A criterion or constraint cites a missing accepted decision.
    MissingDecision,
    /// Binding id is present but stored text does not match criterion or constraint text.
    SourceTextMismatch,
}

/// Errors returned while reducing task phase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhaseError {
    /// The current phase is terminal and rejects all edges.
    Terminal,
    /// Retry was requested outside the failed phase.
    RetryNotFailed,
    /// Continue from an unknown external outcome did not cite that call id.
    UnknownOutcomeCallMismatch,
    /// The event is not a legal edge from this non-terminal phase.
    InvalidTransition,
}

/// Errors returned while reducing the completion detail view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionViewError {
    /// The event is not a legal edge from this view.
    InvalidTransition,
}

/// Errors returned while admitting task completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionError {
    /// Required evidence id was not stored for this attempt.
    MissingEvidence,
    /// Criteria are empty, or a sealed criterion is still pending.
    Incomplete,
    /// The same criterion id appears more than once in the sealed list.
    DuplicateCriterion,
    /// A mark cites a criterion id that is not sealed.
    UnknownMark,
    /// The same criterion id appears more than once in marks.
    DuplicateMark,
    /// A sealed criterion has no mark.
    MissingMark,
}

/// Errors returned while narrowing a child assignment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NarrowError {
    /// Child budget exceeds the parent remainder.
    BudgetWidened,
    /// Child grants exceed the parent grant set.
    GrantWidened,
    /// Child depth exceeds the supplied policy limit.
    DepthExceeded,
    /// A sourced slice does not match envelope or decision bytes.
    SliceMismatch,
    /// Draft parent task does not equal the sealed envelope task.
    ParentMismatch,
}
