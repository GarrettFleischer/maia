//! Pure thread state reducer.

use crate::agents::types::{
    CommandId, HumanRequestId, PanicState, SchedulerEvent, SchedulerPolicy, SleepReason,
    StopReason, ThreadRun, ThreadState, Transition, TransitionError, TransitionRejectReason,
    WakeAttendance,
};
use crate::audit::Timestamp;

/// Applies one scheduler event to thread state without I/O.
pub fn reduce_thread(
    current: &ThreadState,
    event: &SchedulerEvent,
    policy: &SchedulerPolicy,
    panic: &PanicState,
    seen_commands: &[CommandId],
) -> Result<Transition, TransitionError> {
    if let SchedulerEvent::DuplicateCommand { command_id } = event {
        if seen_commands.contains(command_id) {
            return Ok(no_change(current));
        }
    }

    match event {
        SchedulerEvent::DuplicateCommand { .. } => Ok(no_change(current)),
        SchedulerEvent::PanicEngaged { generation } => Ok(Transition {
            run: ThreadRun::Stopped {
                reason: StopReason::Panic(*generation),
            },
            denials_in_lease: 0,
            grant_lease: false,
        }),
        SchedulerEvent::ThreadStop => stop_from_active(current, StopReason::ThreadStop),
        SchedulerEvent::WakeAccepted {
            command_id,
            cause: _,
            attendance,
            effective_at,
        } => admit_wake(
            current,
            *command_id,
            *attendance,
            *effective_at,
            panic,
            seen_commands,
        ),
        SchedulerEvent::RouterRetryDeferred { until } => {
            from_running(current, |_| ThreadRun::Sleeping {
                reason: SleepReason::DeferredRetry { until: *until },
            })
        }
        SchedulerEvent::ExplicitResume { command_id } => {
            resume_from_stopped(current, *command_id, panic, seen_commands)
        }
        SchedulerEvent::StartNewThread { command_id } => {
            if seen_commands.contains(command_id) {
                return Ok(no_change(current));
            }
            if panic.engaged {
                return Err(reject(TransitionRejectReason::PanicEngaged));
            }
            if matches!(
                current.run,
                ThreadRun::Sleeping {
                    reason: SleepReason::TranscriptBudget
                }
            ) {
                return Ok(no_change(current));
            }
            Err(reject(TransitionRejectReason::InvalidTransition))
        }
        SchedulerEvent::ModelComplete => from_running(current, |_| ThreadRun::Sleeping {
            reason: SleepReason::ModelComplete,
        }),
        SchedulerEvent::BudgetExhausted { kind } => {
            from_running(current, |_| ThreadRun::Sleeping {
                reason: SleepReason::BudgetExhausted(*kind),
            })
        }
        SchedulerEvent::TranscriptBudgetExceeded => {
            from_running(current, |_| ThreadRun::Sleeping {
                reason: SleepReason::TranscriptBudget,
            })
        }
        SchedulerEvent::SpendBreakerTripped => from_active(current, |run| match run {
            ThreadRun::Running | ThreadRun::Sleeping { .. } | ThreadRun::NeedsHuman { .. } => {
                ThreadRun::Sleeping {
                    reason: SleepReason::SpendBreaker,
                }
            }
            ThreadRun::Stopped { .. } => run,
        }),
        SchedulerEvent::HumanRequestOpened { request } => {
            from_running(current, |_| ThreadRun::NeedsHuman {
                request: request.clone(),
            })
        }
        SchedulerEvent::HumanRequestResolved { id } => resolve_human(current, *id, panic),
        SchedulerEvent::HumanRequestDenied { id } => {
            let ThreadRun::NeedsHuman { request } = &current.run else {
                return Err(reject(TransitionRejectReason::InvalidTransition));
            };
            if request.id != *id {
                return Err(reject(TransitionRejectReason::HumanRequestMismatch));
            }
            let denials = current.denials_in_lease.saturating_add(1);
            if denials >= policy.denial_stop_threshold {
                return Ok(Transition {
                    run: ThreadRun::Stopped {
                        reason: StopReason::ApprovalDenials,
                    },
                    denials_in_lease: denials,
                    grant_lease: false,
                });
            }
            Ok(Transition {
                run: current.run.clone(),
                denials_in_lease: denials,
                grant_lease: false,
            })
        }
        SchedulerEvent::HumanRequestCancelled { id } => {
            let ThreadRun::NeedsHuman { request } = &current.run else {
                return Err(reject(TransitionRejectReason::InvalidTransition));
            };
            if request.id != *id {
                return Err(reject(TransitionRejectReason::HumanRequestMismatch));
            }
            Ok(Transition {
                run: ThreadRun::Stopped {
                    reason: StopReason::Cancelled,
                },
                denials_in_lease: current.denials_in_lease,
                grant_lease: false,
            })
        }
    }
}

fn admit_wake(
    current: &ThreadState,
    command_id: CommandId,
    attendance: WakeAttendance,
    effective_at: Timestamp,
    panic: &PanicState,
    seen_commands: &[CommandId],
) -> Result<Transition, TransitionError> {
    if seen_commands.contains(&command_id) {
        return Ok(no_change(current));
    }
    if panic.engaged {
        return Err(reject(TransitionRejectReason::PanicEngaged));
    }
    if matches!(current.run, ThreadRun::Stopped { .. }) {
        return Err(reject(TransitionRejectReason::Stopped));
    }
    if matches!(current.run, ThreadRun::NeedsHuman { .. }) {
        return Err(reject(TransitionRejectReason::InvalidTransition));
    }
    if matches!(
        current.run,
        ThreadRun::Sleeping {
            reason: SleepReason::TranscriptBudget
        }
    ) {
        return Err(reject(TransitionRejectReason::TranscriptBudgetResume));
    }
    if matches!(
        current.run,
        ThreadRun::Sleeping {
            reason: SleepReason::SpendBreaker
        }
    ) && attendance == WakeAttendance::Unattended
    {
        return Err(reject(TransitionRejectReason::SpendBreakerUnattended));
    }
    if let ThreadRun::Sleeping {
        reason: SleepReason::DeferredRetry { until },
    } = &current.run
    {
        if effective_at.0 < until.0 {
            return Err(reject(TransitionRejectReason::DeferredRetryNotDue));
        }
    }
    if matches!(current.run, ThreadRun::Running) {
        return Ok(no_change(current));
    }
    Ok(Transition {
        run: ThreadRun::Running,
        denials_in_lease: 0,
        grant_lease: true,
    })
}

fn resume_from_stopped(
    current: &ThreadState,
    command_id: CommandId,
    panic: &PanicState,
    seen_commands: &[CommandId],
) -> Result<Transition, TransitionError> {
    if seen_commands.contains(&command_id) {
        return Ok(no_change(current));
    }
    let ThreadRun::Stopped { .. } = current.run else {
        return Err(reject(TransitionRejectReason::InvalidTransition));
    };
    if panic.engaged {
        return Err(reject(TransitionRejectReason::PanicNotCleared));
    }
    Ok(Transition {
        run: ThreadRun::Sleeping {
            reason: SleepReason::ModelComplete,
        },
        denials_in_lease: 0,
        grant_lease: false,
    })
}

fn resolve_human(
    current: &ThreadState,
    id: HumanRequestId,
    panic: &PanicState,
) -> Result<Transition, TransitionError> {
    if panic.engaged {
        return Err(reject(TransitionRejectReason::PanicEngaged));
    }
    let ThreadRun::NeedsHuman { request } = &current.run else {
        return Err(reject(TransitionRejectReason::InvalidTransition));
    };
    if request.id != id {
        return Err(reject(TransitionRejectReason::HumanRequestMismatch));
    }
    Ok(Transition {
        run: ThreadRun::Running,
        denials_in_lease: current.denials_in_lease,
        grant_lease: true,
    })
}

fn from_running(
    current: &ThreadState,
    next: impl FnOnce(&ThreadState) -> ThreadRun,
) -> Result<Transition, TransitionError> {
    if !matches!(current.run, ThreadRun::Running) {
        return Err(reject(TransitionRejectReason::InvalidTransition));
    }
    Ok(Transition {
        run: next(current),
        denials_in_lease: current.denials_in_lease,
        grant_lease: false,
    })
}

fn from_active(
    current: &ThreadState,
    next: impl FnOnce(ThreadRun) -> ThreadRun,
) -> Result<Transition, TransitionError> {
    match &current.run {
        ThreadRun::Stopped { .. } => Ok(no_change(current)),
        _ => Ok(Transition {
            run: next(current.run.clone()),
            denials_in_lease: current.denials_in_lease,
            grant_lease: false,
        }),
    }
}

fn stop_from_active(
    current: &ThreadState,
    reason: StopReason,
) -> Result<Transition, TransitionError> {
    match &current.run {
        ThreadRun::Stopped { .. } => Ok(no_change(current)),
        _ => Ok(Transition {
            run: ThreadRun::Stopped { reason },
            denials_in_lease: 0,
            grant_lease: false,
        }),
    }
}

fn no_change(current: &ThreadState) -> Transition {
    Transition {
        run: current.run.clone(),
        denials_in_lease: current.denials_in_lease,
        grant_lease: false,
    }
}

fn reject(reason: TransitionRejectReason) -> TransitionError {
    TransitionError::Rejected { reason }
}
