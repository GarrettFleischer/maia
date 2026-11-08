//! Scheduler reducer and budget admission contracts.

use maia_core::agents::{
    BudgetExceeded, BudgetKind, BudgetUsage, CommandId, HumanRequest, HumanRequestId,
    HumanRequestKind, PanicState, RunBudget, SchedulerEvent, SchedulerPolicy, SleepReason,
    SpendBreakerState, StepKind, StepRequest, StopReason, ThreadRun, ThreadState,
    TransitionRejectReason, WakeAttendance, admit_step, reduce_thread,
};

fn sleeping(reason: SleepReason) -> ThreadState {
    ThreadState {
        run: ThreadRun::Sleeping { reason },
        denials_in_lease: 0,
    }
}

fn policy() -> SchedulerPolicy {
    SchedulerPolicy {
        denial_stop_threshold: 3,
    }
}

fn panic_cleared() -> PanicState {
    PanicState {
        generation: 1,
        engaged: false,
    }
}

fn wake(command_id: u64, attendance: WakeAttendance, effective_at: i64) -> SchedulerEvent {
    SchedulerEvent::WakeAccepted {
        command_id: CommandId(command_id),
        cause: maia_core::agents::WakeCause::UserMessage(1),
        attendance,
        effective_at: maia_core::audit::Timestamp(effective_at),
    }
}

#[test]
fn sleeping_to_running_on_attended_wake_grants_lease() {
    let current = sleeping(SleepReason::ModelComplete);
    let transition = reduce_thread(
        &current,
        &wake(1, WakeAttendance::Attended, 100),
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect("wake should succeed");
    assert_eq!(transition.run, ThreadRun::Running);
    assert!(transition.grant_lease);
}

#[test]
fn wake_rejects_while_panic_engaged() {
    let current = sleeping(SleepReason::ModelComplete);
    let err = reduce_thread(
        &current,
        &wake(2, WakeAttendance::Attended, 100),
        &policy(),
        &PanicState {
            generation: 2,
            engaged: true,
        },
        &[],
    )
    .expect_err("panic must reject wake");
    assert!(matches!(
        err,
        maia_core::agents::TransitionError::Rejected {
            reason: TransitionRejectReason::PanicEngaged
        }
    ));
}

#[test]
fn spend_breaker_refuses_unattended_wake() {
    let current = sleeping(SleepReason::SpendBreaker);
    let err = reduce_thread(
        &current,
        &wake(3, WakeAttendance::Unattended, 100),
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect_err("breaker must reject unattended wake");
    assert!(matches!(
        err,
        maia_core::agents::TransitionError::Rejected {
            reason: TransitionRejectReason::SpendBreakerUnattended
        }
    ));
}

#[test]
fn transcript_budget_refuses_unattended_resume_in_place() {
    let current = sleeping(SleepReason::TranscriptBudget);
    let err = reduce_thread(
        &current,
        &wake(4, WakeAttendance::Unattended, 100),
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect_err("transcript budget must reject unattended wake");
    assert!(matches!(
        err,
        maia_core::agents::TransitionError::Rejected {
            reason: TransitionRejectReason::TranscriptBudgetResume
        }
    ));
}

#[test]
fn transcript_budget_refuses_attended_resume_in_place() {
    let current = sleeping(SleepReason::TranscriptBudget);
    let err = reduce_thread(
        &current,
        &wake(41, WakeAttendance::Attended, 100),
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect_err("transcript budget requires a new thread");
    assert!(matches!(
        err,
        maia_core::agents::TransitionError::Rejected {
            reason: TransitionRejectReason::TranscriptBudgetResume
        }
    ));
}

#[test]
fn start_new_thread_does_not_resume_exhausted_thread() {
    let current = sleeping(SleepReason::TranscriptBudget);
    let transition = reduce_thread(
        &current,
        &SchedulerEvent::StartNewThread {
            command_id: CommandId(411),
        },
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect("new-thread command is accepted as orchestration glue");
    assert_eq!(transition.run, current.run);
    assert!(!transition.grant_lease);
}

#[test]
fn generic_wake_cannot_bypass_needs_human() {
    let current = ThreadState {
        run: ThreadRun::NeedsHuman {
            request: HumanRequest {
                id: HumanRequestId(42),
                kind: HumanRequestKind::CapabilityApproval,
            },
        },
        denials_in_lease: 0,
    };
    let err = reduce_thread(
        &current,
        &wake(42, WakeAttendance::Attended, 100),
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect_err("only the matching human resolution may resume");
    assert!(matches!(
        err,
        maia_core::agents::TransitionError::Rejected {
            reason: TransitionRejectReason::InvalidTransition
        }
    ));
}

#[test]
fn human_resolution_cannot_start_lease_while_panic_is_engaged() {
    let current = ThreadState {
        run: ThreadRun::NeedsHuman {
            request: HumanRequest {
                id: HumanRequestId(43),
                kind: HumanRequestKind::CapabilityApproval,
            },
        },
        denials_in_lease: 0,
    };
    let err = reduce_thread(
        &current,
        &SchedulerEvent::HumanRequestResolved {
            id: HumanRequestId(43),
        },
        &policy(),
        &PanicState {
            generation: 2,
            engaged: true,
        },
        &[],
    )
    .expect_err("panic blocks lease admission");
    assert!(matches!(
        err,
        maia_core::agents::TransitionError::Rejected {
            reason: TransitionRejectReason::PanicEngaged
        }
    ));
}

#[test]
fn stopped_to_sleeping_on_explicit_resume_without_router() {
    let current = ThreadState {
        run: ThreadRun::Stopped {
            reason: StopReason::Panic(1),
        },
        denials_in_lease: 0,
    };
    let transition = reduce_thread(
        &current,
        &SchedulerEvent::ExplicitResume {
            command_id: CommandId(5),
        },
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect("resume after panic clear");
    assert!(matches!(
        transition.run,
        ThreadRun::Sleeping {
            reason: SleepReason::ModelComplete
        }
    ));
    assert!(!transition.grant_lease);
}

#[test]
fn needs_human_stays_on_single_deny_then_stops_at_threshold() {
    let request = HumanRequest {
        id: HumanRequestId(7),
        kind: HumanRequestKind::CapabilityApproval,
    };
    let current = ThreadState {
        run: ThreadRun::NeedsHuman {
            request: request.clone(),
        },
        denials_in_lease: 2,
    };
    let transition = reduce_thread(
        &current,
        &SchedulerEvent::HumanRequestDenied {
            id: HumanRequestId(7),
        },
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect("deny");
    assert!(matches!(
        transition.run,
        ThreadRun::Stopped {
            reason: StopReason::ApprovalDenials
        }
    ));
}

#[test]
fn admit_step_boundary_router_tokens() {
    let limits = RunBudget {
        max_router_tokens: 100,
        max_tool_turns: 5,
    };
    let usage = BudgetUsage {
        router_tokens: 99,
        reserved_router_tokens: 0,
        tool_turns: 0,
        reserved_tool_turns: 0,
    };
    let ok = admit_step(
        &usage,
        &StepRequest {
            kind: StepKind::Router { reserve_tokens: 1 },
        },
        &limits,
        &SpendBreakerState { tripped: false },
    );
    assert!(ok.is_ok());
    let err = admit_step(
        &usage,
        &StepRequest {
            kind: StepKind::Router { reserve_tokens: 2 },
        },
        &limits,
        &SpendBreakerState { tripped: false },
    )
    .expect_err("reservation above ceiling must fail");
    assert!(matches!(
        err,
        BudgetExceeded::CeilingReached {
            kind: BudgetKind::RouterTokens
        }
    ));
}

#[test]
fn running_to_sleeping_records_deferred_retry_until() {
    let current = ThreadState {
        run: ThreadRun::Running,
        denials_in_lease: 0,
    };
    let transition = reduce_thread(
        &current,
        &SchedulerEvent::RouterRetryDeferred {
            until: maia_core::audit::Timestamp(500),
        },
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect("defer retry");
    assert!(matches!(
        transition.run,
        ThreadRun::Sleeping {
            reason: SleepReason::DeferredRetry {
                until: maia_core::audit::Timestamp(500)
            }
        }
    ));
}

#[test]
fn deferred_retry_refuses_wake_before_until() {
    let current = sleeping(SleepReason::DeferredRetry {
        until: maia_core::audit::Timestamp(500),
    });
    let err = reduce_thread(
        &current,
        &wake(8, WakeAttendance::Unattended, 100),
        &policy(),
        &panic_cleared(),
        &[],
    )
    .expect_err("deferred retry must wait for deadline");
    assert!(matches!(
        err,
        maia_core::agents::TransitionError::Rejected {
            reason: TransitionRejectReason::DeferredRetryNotDue
        }
    ));
}

#[test]
fn admit_step_fails_when_breaker_tripped_even_with_budget() {
    let limits = RunBudget {
        max_router_tokens: 1_000,
        max_tool_turns: 10,
    };
    let usage = BudgetUsage::default();
    let err = admit_step(
        &usage,
        &StepRequest {
            kind: StepKind::Tool,
        },
        &limits,
        &SpendBreakerState { tripped: true },
    )
    .expect_err("tripped breaker must reject step");
    assert!(matches!(err, BudgetExceeded::BreakerTripped));
}
