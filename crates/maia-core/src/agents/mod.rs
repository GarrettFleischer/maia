//! Thread lifecycle, budgets, scheduler state, and run-loop policy.

mod budget;
mod reduce;
mod reversal;
mod types;

pub use budget::admit_step;
pub use reduce::reduce_thread;
pub use reversal::reverse_presentations;
pub use types::{
    AgentId, BudgetExceeded, BudgetKind, BudgetUsage, CommandId, HumanRequest, HumanRequestId,
    HumanRequestKind, LedgerCompensation, PanicState, Presentation, PresentationId, Reservation,
    ReversalError, ReversalRequest, ReversalRequestId, RunBudget, SchedulerEvent, SchedulerPolicy,
    SleepReason, SpendBreakerState, StepKind, StepRequest, StopReason, ThreadId, ThreadRun,
    ThreadState, Transition, TransitionError, TransitionRejectReason, UserActionId, WakeAttendance,
    WakeCause, WakeId,
};
