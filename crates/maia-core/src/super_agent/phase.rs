//! Host-owned task phase transitions.

use super::types::{CallId, HostCommand, PhaseError, PhaseEvent, TaskPhase, WaitReason};

/// Returns the next task phase for one host event.
///
/// Terminal phases reject every event. `Retry` from `Failed` or `Stopped` yields
/// `Queued`; the attempt id on that event is not stored on `Queued`.
pub fn reduce_phase(current: &TaskPhase, event: &PhaseEvent) -> Result<TaskPhase, PhaseError> {
    match (current, event) {
        (
            TaskPhase::Completed { .. } | TaskPhase::Cancelled { .. } | TaskPhase::Abandoned { .. },
            _,
        ) => Err(PhaseError::Terminal),

        (TaskPhase::Queued, PhaseEvent::StartAttempt { attempt }) => Ok(TaskPhase::Running {
            attempt: attempt.clone(),
        }),
        (
            TaskPhase::Running { .. }
            | TaskPhase::WaitingForUser { .. }
            | TaskPhase::Blocked { .. }
            | TaskPhase::Failed { .. }
            | TaskPhase::Stopped { .. },
            PhaseEvent::StartAttempt { .. },
        ) => Err(PhaseError::InvalidTransition),

        (TaskPhase::Running { .. }, PhaseEvent::Wait { reason }) => Ok(TaskPhase::WaitingForUser {
            reason: reason.clone(),
        }),
        (TaskPhase::Running { .. }, PhaseEvent::Block { blocker }) => Ok(TaskPhase::Blocked {
            reason: blocker.clone(),
        }),
        (TaskPhase::Running { attempt }, PhaseEvent::Fail { kind }) => Ok(TaskPhase::Failed {
            attempt: attempt.clone(),
            kind: *kind,
        }),
        (TaskPhase::Running { .. }, PhaseEvent::Complete { evidence }) => {
            Ok(TaskPhase::Completed {
                evidence: evidence.clone(),
            })
        }
        (
            TaskPhase::Queued
            | TaskPhase::WaitingForUser { .. }
            | TaskPhase::Blocked { .. }
            | TaskPhase::Failed { .. }
            | TaskPhase::Stopped { .. },
            PhaseEvent::Wait { .. }
            | PhaseEvent::Block { .. }
            | PhaseEvent::Fail { .. }
            | PhaseEvent::Complete { .. },
        ) => Err(PhaseError::InvalidTransition),

        (
            TaskPhase::WaitingForUser {
                reason: WaitReason::UnknownExternalOutcome { call, .. },
            },
            PhaseEvent::Continue { replay_forbidden },
        ) => continue_unknown(call, replay_forbidden),
        (
            TaskPhase::WaitingForUser { .. }
            | TaskPhase::Blocked { .. }
            | TaskPhase::Stopped { .. },
            PhaseEvent::Continue { .. },
        ) => Ok(TaskPhase::Queued),
        (
            TaskPhase::Queued | TaskPhase::Running { .. } | TaskPhase::Failed { .. },
            PhaseEvent::Continue { .. },
        ) => Ok(current.clone()),

        (TaskPhase::Failed { .. } | TaskPhase::Stopped { .. }, PhaseEvent::Retry { .. }) => {
            Ok(TaskPhase::Queued)
        }
        (
            TaskPhase::Queued
            | TaskPhase::Running { .. }
            | TaskPhase::WaitingForUser { .. }
            | TaskPhase::Blocked { .. },
            PhaseEvent::Retry { .. },
        ) => Err(PhaseError::RetryNotFailed),

        (
            TaskPhase::Stopped { .. },
            PhaseEvent::Host(HostCommand::Stop { .. } | HostCommand::StopAll { .. }),
        ) => Err(PhaseError::InvalidTransition),
        (
            TaskPhase::Queued
            | TaskPhase::Running { .. }
            | TaskPhase::WaitingForUser { .. }
            | TaskPhase::Blocked { .. }
            | TaskPhase::Failed { .. }
            | TaskPhase::Stopped { .. },
            PhaseEvent::Host(command),
        ) => Ok(phase_after_host(command)),
    }
}

fn continue_unknown(recorded: &CallId, supplied: &Option<CallId>) -> Result<TaskPhase, PhaseError> {
    match supplied {
        Some(call) if call == recorded => Ok(TaskPhase::Queued),
        Some(_) | None => Err(PhaseError::UnknownOutcomeCallMismatch),
    }
}

fn phase_after_host(command: &HostCommand) -> TaskPhase {
    match command {
        HostCommand::Stop {
            command: command_id,
            ..
        }
        | HostCommand::StopAll {
            command: command_id,
        } => TaskPhase::Stopped {
            command: *command_id,
        },
        HostCommand::Cancel {
            command: command_id,
            ..
        } => TaskPhase::Cancelled {
            command: *command_id,
        },
        HostCommand::Abandon { decision, .. } => TaskPhase::Abandoned {
            decision: decision.clone(),
        },
    }
}
