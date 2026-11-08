use maia_core::super_agent::*;

fn attempt(id: &str) -> AttemptId {
    AttemptId(id.into())
}

fn call(id: &str) -> CallId {
    CallId(id.into())
}

fn running(id: &str) -> TaskPhase {
    TaskPhase::Running {
        attempt: attempt(id),
    }
}

fn failed(kind: FailureKind) -> TaskPhase {
    TaskPhase::Failed {
        attempt: attempt("a1"),
        kind,
    }
}

fn unknown(call_id: &str) -> TaskPhase {
    TaskPhase::WaitingForUser {
        reason: WaitReason::UnknownExternalOutcome {
            attempt: attempt("a1"),
            call: call(call_id),
        },
    }
}

fn continue_with(replay_forbidden: Option<CallId>) -> PhaseEvent {
    PhaseEvent::Continue { replay_forbidden }
}

fn assert_phase(label: &str, phase: TaskPhase, event: PhaseEvent, expected: TaskPhase) {
    assert_eq!(reduce_phase(&phase, &event), Ok(expected), "{label}");
}

fn assert_error(label: &str, phase: TaskPhase, event: PhaseEvent, expected: PhaseError) {
    assert_eq!(reduce_phase(&phase, &event), Err(expected), "{label}");
}

#[test]
fn retry_from_failed_keeps_task_and_replaces_attempt() {
    let current = failed(FailureKind::WorkerReported);
    let next = reduce_phase(
        &current,
        &PhaseEvent::Retry {
            attempt: attempt("a2"),
        },
    )
    .unwrap();
    assert_eq!(next, TaskPhase::Queued);
}

#[test]
fn continue_on_failed_does_not_change_phase() {
    let current = failed(FailureKind::BudgetExhausted);
    let next = reduce_phase(&current, &continue_with(None)).unwrap();
    assert_eq!(next, current);
}

#[test]
fn unknown_outcome_is_a_wait_and_retry_is_rejected() {
    let current = unknown("call-9");
    let error = reduce_phase(
        &current,
        &PhaseEvent::Retry {
            attempt: attempt("a2"),
        },
    )
    .unwrap_err();
    assert_eq!(error, PhaseError::RetryNotFailed);
}

#[test]
fn completed_has_no_outbound_edge() {
    let current = TaskPhase::Completed {
        evidence: EvidenceSetId("set-1".into()),
    };
    let error = reduce_phase(
        &current,
        &PhaseEvent::StartAttempt {
            attempt: attempt("a2"),
        },
    )
    .unwrap_err();
    assert_eq!(error, PhaseError::Terminal);
}

#[test]
fn stop_all_holds_a_non_terminal_phase_as_stopped() {
    let current = running("a1");
    let next = reduce_phase(
        &current,
        &PhaseEvent::Host(HostCommand::StopAll {
            command: CommandId(12),
        }),
    )
    .unwrap();
    assert_eq!(
        next,
        TaskPhase::Stopped {
            command: CommandId(12)
        }
    );
}

#[test]
fn terminal_phases_reject_every_event() {
    let phases = [
        TaskPhase::Completed {
            evidence: EvidenceSetId("set-1".into()),
        },
        TaskPhase::Cancelled {
            command: CommandId(3),
        },
        TaskPhase::Abandoned {
            decision: DecisionId("d-old".into()),
        },
    ];
    let events = [
        PhaseEvent::StartAttempt {
            attempt: attempt("a2"),
        },
        PhaseEvent::Wait {
            reason: WaitReason::Clarification,
        },
        PhaseEvent::Block {
            blocker: BlockerId("b1".into()),
        },
        PhaseEvent::Fail {
            kind: FailureKind::WorkerReported,
        },
        PhaseEvent::Complete {
            evidence: EvidenceSetId("set-2".into()),
        },
        continue_with(Some(call("call-9"))),
        PhaseEvent::Retry {
            attempt: attempt("a2"),
        },
        PhaseEvent::Host(HostCommand::Stop {
            task: TaskId("t1".into()),
            command: CommandId(11),
        }),
        PhaseEvent::Host(HostCommand::StopAll {
            command: CommandId(12),
        }),
        PhaseEvent::Host(HostCommand::Abandon {
            task: TaskId("t1".into()),
            decision: DecisionId("d-new".into()),
            command: CommandId(14),
        }),
        PhaseEvent::Host(HostCommand::Cancel {
            task: TaskId("t1".into()),
            command: CommandId(15),
        }),
    ];
    for phase in phases {
        for event in events.clone() {
            assert_error(
                "terminal phase rejects the event",
                phase.clone(),
                event,
                PhaseError::Terminal,
            );
        }
    }
}

#[test]
fn continue_on_queued_running_and_failed_preserves_the_phase() {
    let phases = [
        TaskPhase::Queued,
        running("a1"),
        failed(FailureKind::WorkerReported),
        failed(FailureKind::BudgetExhausted),
        failed(FailureKind::AttemptFailed),
    ];
    for phase in phases {
        assert_phase(
            "continue is an exact no-op",
            phase.clone(),
            continue_with(Some(call("call-9"))),
            phase,
        );
    }
}

#[test]
fn continue_from_ordinary_wait_or_blocked_queues() {
    let phases = [
        TaskPhase::WaitingForUser {
            reason: WaitReason::Clarification,
        },
        TaskPhase::WaitingForUser {
            reason: WaitReason::TaskQuestion {
                report: ReportId("r1".into()),
            },
        },
        TaskPhase::WaitingForUser {
            reason: WaitReason::WaiverNeeded {
                criterion: CriterionId("c1".into()),
            },
        },
        TaskPhase::WaitingForUser {
            reason: WaitReason::Approval {
                request: HumanRequestId(7),
            },
        },
        TaskPhase::WaitingForUser {
            reason: WaitReason::TranscriptBudget,
        },
        TaskPhase::WaitingForUser {
            reason: WaitReason::Settled {
                report: ReportId("r1".into()),
            },
        },
        TaskPhase::Blocked {
            reason: BlockerId("b1".into()),
        },
    ];
    for phase in phases {
        assert_phase(
            "ordinary continue queues",
            phase.clone(),
            continue_with(None),
            TaskPhase::Queued,
        );
        assert_phase(
            "an extra call id does not block an ordinary continue",
            phase,
            continue_with(Some(call("call-9"))),
            TaskPhase::Queued,
        );
    }
}

#[test]
fn continue_unknown_outcome_requires_the_recorded_call() {
    let current = unknown("call-9");
    assert_phase(
        "exact recorded call leaves the wait",
        current.clone(),
        continue_with(Some(call("call-9"))),
        TaskPhase::Queued,
    );
    for (label, supplied) in [
        ("missing call id", None),
        ("different call id", Some(call("call-99"))),
        ("different capitalization", Some(call("Call-9"))),
    ] {
        assert_error(
            label,
            current.clone(),
            continue_with(supplied),
            PhaseError::UnknownOutcomeCallMismatch,
        );
    }
}

#[test]
fn retry_is_rejected_outside_failed_and_stopped() {
    let phases = [
        TaskPhase::Queued,
        running("a1"),
        TaskPhase::WaitingForUser {
            reason: WaitReason::Clarification,
        },
        unknown("call-9"),
        TaskPhase::Blocked {
            reason: BlockerId("b1".into()),
        },
    ];
    for phase in phases {
        assert_error(
            "retry only leaves failed or stopped",
            phase,
            PhaseEvent::Retry {
                attempt: attempt("a2"),
            },
            PhaseError::RetryNotFailed,
        );
    }
}

#[test]
fn stopped_resumes_only_through_continue_or_retry() {
    let stopped = TaskPhase::Stopped {
        command: CommandId(11),
    };
    assert_phase(
        "continue resumes a stopped task to queued",
        stopped.clone(),
        continue_with(None),
        TaskPhase::Queued,
    );
    assert_phase(
        "retry resumes a stopped task with a new attempt",
        stopped.clone(),
        PhaseEvent::Retry {
            attempt: attempt("a2"),
        },
        TaskPhase::Queued,
    );
    let refused = [
        PhaseEvent::StartAttempt {
            attempt: attempt("a2"),
        },
        PhaseEvent::Wait {
            reason: WaitReason::Clarification,
        },
        PhaseEvent::Block {
            blocker: BlockerId("b1".into()),
        },
        PhaseEvent::Fail {
            kind: FailureKind::WorkerReported,
        },
        PhaseEvent::Complete {
            evidence: EvidenceSetId("set-2".into()),
        },
    ];
    for event in refused {
        assert_error(
            "a stopped task starts no attempt and records no worker result",
            stopped.clone(),
            event,
            PhaseError::InvalidTransition,
        );
    }
}

#[test]
fn stopped_is_kept_by_stop_and_ends_only_by_cancel_or_abandon() {
    let stopped = TaskPhase::Stopped {
        command: CommandId(11),
    };
    assert_error(
        "stop on a stopped task is refused as already held",
        stopped.clone(),
        PhaseEvent::Host(HostCommand::Stop {
            task: TaskId("t1".into()),
            command: CommandId(15),
        }),
        PhaseError::InvalidTransition,
    );
    assert_error(
        "stop all on a stopped task is refused as already held",
        stopped.clone(),
        PhaseEvent::Host(HostCommand::StopAll {
            command: CommandId(15),
        }),
        PhaseError::InvalidTransition,
    );
    assert_phase(
        "cancel ends a stopped task",
        stopped.clone(),
        PhaseEvent::Host(HostCommand::Cancel {
            task: TaskId("t1".into()),
            command: CommandId(16),
        }),
        TaskPhase::Cancelled {
            command: CommandId(16),
        },
    );
    assert_phase(
        "abandon ends a stopped task",
        stopped,
        PhaseEvent::Host(HostCommand::Abandon {
            task: TaskId("t1".into()),
            decision: DecisionId("d-1".into()),
            command: CommandId(17),
        }),
        TaskPhase::Abandoned {
            decision: DecisionId("d-1".into()),
        },
    );
}

#[test]
fn start_attempt_only_from_queued() {
    assert_phase(
        "queued starts the supplied attempt",
        TaskPhase::Queued,
        PhaseEvent::StartAttempt {
            attempt: attempt("a2"),
        },
        running("a2"),
    );
    for phase in [
        running("a1"),
        TaskPhase::WaitingForUser {
            reason: WaitReason::Clarification,
        },
        unknown("call-9"),
        TaskPhase::Blocked {
            reason: BlockerId("b1".into()),
        },
        failed(FailureKind::AttemptFailed),
    ] {
        assert_error(
            "start attempt outside queued",
            phase,
            PhaseEvent::StartAttempt {
                attempt: attempt("a2"),
            },
            PhaseError::InvalidTransition,
        );
    }
}

#[test]
fn running_edges_record_wait_block_failure_and_completion() {
    let attempt_id = attempt("a1");
    let cases = [
        (
            "clarification",
            PhaseEvent::Wait {
                reason: WaitReason::Clarification,
            },
            TaskPhase::WaitingForUser {
                reason: WaitReason::Clarification,
            },
        ),
        (
            "unknown outcome",
            PhaseEvent::Wait {
                reason: WaitReason::UnknownExternalOutcome {
                    attempt: attempt("a1"),
                    call: call("call-9"),
                },
            },
            unknown("call-9"),
        ),
        (
            "blocker",
            PhaseEvent::Block {
                blocker: BlockerId("b1".into()),
            },
            TaskPhase::Blocked {
                reason: BlockerId("b1".into()),
            },
        ),
        (
            "worker failure",
            PhaseEvent::Fail {
                kind: FailureKind::WorkerReported,
            },
            TaskPhase::Failed {
                attempt: attempt_id.clone(),
                kind: FailureKind::WorkerReported,
            },
        ),
        (
            "budget failure",
            PhaseEvent::Fail {
                kind: FailureKind::BudgetExhausted,
            },
            TaskPhase::Failed {
                attempt: attempt_id.clone(),
                kind: FailureKind::BudgetExhausted,
            },
        ),
        (
            "attempt failure",
            PhaseEvent::Fail {
                kind: FailureKind::AttemptFailed,
            },
            TaskPhase::Failed {
                attempt: attempt_id,
                kind: FailureKind::AttemptFailed,
            },
        ),
        (
            "completion",
            PhaseEvent::Complete {
                evidence: EvidenceSetId("set-1".into()),
            },
            TaskPhase::Completed {
                evidence: EvidenceSetId("set-1".into()),
            },
        ),
    ];
    for (label, event, expected) in cases {
        assert_phase(label, running("a1"), event, expected);
    }
}

#[test]
fn non_running_rejects_wait_block_fail_and_complete() {
    let phases = [
        TaskPhase::Queued,
        TaskPhase::WaitingForUser {
            reason: WaitReason::TranscriptBudget,
        },
        unknown("call-9"),
        TaskPhase::Blocked {
            reason: BlockerId("b1".into()),
        },
        failed(FailureKind::WorkerReported),
    ];
    let events = [
        PhaseEvent::Wait {
            reason: WaitReason::Clarification,
        },
        PhaseEvent::Block {
            blocker: BlockerId("b2".into()),
        },
        PhaseEvent::Fail {
            kind: FailureKind::BudgetExhausted,
        },
        PhaseEvent::Complete {
            evidence: EvidenceSetId("set-9".into()),
        },
    ];
    for phase in phases {
        for event in events.clone() {
            assert_error(
                "event is only legal from running",
                phase.clone(),
                event,
                PhaseError::InvalidTransition,
            );
        }
    }
}

#[test]
fn host_stop_holds_and_cancel_terminates_every_non_terminal() {
    let phases = [
        TaskPhase::Queued,
        running("a1"),
        TaskPhase::WaitingForUser {
            reason: WaitReason::WaiverNeeded {
                criterion: CriterionId("c1".into()),
            },
        },
        unknown("call-9"),
        TaskPhase::Blocked {
            reason: BlockerId("b1".into()),
        },
        failed(FailureKind::AttemptFailed),
    ];
    let cancels = [
        (
            "stop",
            HostCommand::Stop {
                task: TaskId("t1".into()),
                command: CommandId(11),
            },
            TaskPhase::Stopped {
                command: CommandId(11),
            },
        ),
        (
            "stop all",
            HostCommand::StopAll {
                command: CommandId(12),
            },
            TaskPhase::Stopped {
                command: CommandId(12),
            },
        ),
        (
            "cancel",
            HostCommand::Cancel {
                task: TaskId("t1".into()),
                command: CommandId(13),
            },
            TaskPhase::Cancelled {
                command: CommandId(13),
            },
        ),
    ];
    for phase in &phases {
        for (label, command, expected) in &cancels {
            assert_phase(
                label,
                phase.clone(),
                PhaseEvent::Host(command.clone()),
                expected.clone(),
            );
        }
        assert_phase(
            "abandon",
            phase.clone(),
            PhaseEvent::Host(HostCommand::Abandon {
                task: TaskId("t1".into()),
                decision: DecisionId("d-abandon".into()),
                command: CommandId(14),
            }),
            TaskPhase::Abandoned {
                decision: DecisionId("d-abandon".into()),
            },
        );
    }
}
