use std::collections::BTreeMap;

use maia_core::super_agent::*;

const CLARIFY_UNKNOWN_TASK: &str =
    "Which existing task should the router use? The cited task id is not in the session.";
const CLARIFY_CHILD_TARGET: &str =
    "The router cannot route user control to a nested helper; name the parent task instead.";
const CLARIFY_SPLIT: &str =
    "Send one goal per message; the router cannot split one message into multiple new tasks.";
const CLARIFY_USER_RELAY: &str =
    "Say what you want in this message; the router cannot relay a report from your chat line.";
const CLARIFY_TERMINAL_CONTINUE: &str =
    "That task is already finished; say whether to inspect it, link a follow-up, or start fresh.";
const CLARIFY_LIVE_LINKED: &str =
    "That task is still active; continue it or finish it before opening a linked task.";
const CLARIFY_RETRY_INELIGIBLE: &str =
    "Retry applies only to a failed or stopped task; say continue, cancel, or inspect instead.";
const CLARIFY_POLICY: &str =
    "The router is not confident enough to act; restate which task or action you want.";

fn policy() -> RoutingPolicy {
    RoutingPolicy {
        min_confidence: Confidence::from_thousandths(800).unwrap(),
        min_margin: Confidence::from_thousandths(150).unwrap(),
        max_considered: 8,
    }
}

fn phases(id: &str, phase: TaskPhase) -> BTreeMap<TaskId, TaskPhase> {
    let mut map = BTreeMap::new();
    map.insert(TaskId(id.to_owned()), phase);
    map
}

fn user_message() -> TurnSource {
    TurnSource::UserMessage {
        message: MessageId("m-user".into()),
    }
}

fn task_report() -> TurnSource {
    TurnSource::TaskReport {
        report: ReportId("report-1".into()),
    }
}

fn host_control() -> TurnSource {
    TurnSource::HostControl {
        command: CommandId(1),
    }
}

fn proposal(
    proposed: ProposedRouteDecision,
    confidence: u16,
    margin: u16,
    considered: Vec<TaskId>,
) -> RouteProposal {
    RouteProposal {
        proposed,
        shape: ProposalShape::Single,
        considered,
        confidence: Confidence::from_thousandths(confidence).unwrap(),
        margin: Confidence::from_thousandths(margin).unwrap(),
    }
}

fn strong_proposal(proposed: ProposedRouteDecision) -> RouteProposal {
    proposal(proposed, 1000, 1000, vec![])
}

fn assert_host_ask(admitted: AdmittedRoute, expected: &str) {
    match admitted {
        AdmittedRoute::AskUser { clarification } => {
            assert!(!clarification.0.is_empty());
            assert_eq!(clarification.0, expected);
        }
        other => panic!("expected AskUser with {expected:?}, got {other:?}"),
    }
}

fn parent(id: &str) -> RouteTarget {
    RouteTarget::Parent(TaskId(id.into()))
}

#[test]
fn report_wake_cannot_cancel() {
    let admitted = admit_route(
        &proposal(
            ProposedRouteDecision::Cancel {
                target: parent("task-1"),
            },
            1000,
            1000,
            vec![TaskId("task-1".into())],
        ),
        &policy(),
        &task_report(),
        &phases(
            "task-1",
            TaskPhase::Running {
                attempt: AttemptId("a1".into()),
            },
        ),
    );
    assert_eq!(
        admitted,
        AdmittedRoute::Refuse {
            reason: RouteRefuse::ReportWake
        }
    );
}

#[test]
fn low_margin_create_asks_the_user() {
    let admitted = admit_route(
        &proposal(ProposedRouteDecision::CreateTask, 900, 100, vec![]),
        &policy(),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_POLICY);
}

#[test]
fn linked_create_of_a_running_parent_asks() {
    let admitted = authorize_control(
        &proposal(
            ProposedRouteDecision::CreateLinked {
                prior: parent("task-1"),
                link: TaskLink::Modifies,
            },
            1000,
            1000,
            vec![TaskId("task-1".into())],
        ),
        &user_message(),
        &phases(
            "task-1",
            TaskPhase::Running {
                attempt: AttemptId("a1".into()),
            },
        ),
    );
    assert_host_ask(admitted, CLARIFY_LIVE_LINKED);
}

#[test]
fn high_confidence_continue_of_failed_is_admitted() {
    let admitted = admit_route(
        &proposal(
            ProposedRouteDecision::Continue {
                target: parent("task-1"),
            },
            900,
            200,
            vec![TaskId("task-1".into())],
        ),
        &policy(),
        &user_message(),
        &phases(
            "task-1",
            TaskPhase::Failed {
                attempt: AttemptId("a1".into()),
                kind: FailureKind::WorkerReported,
            },
        ),
    );
    assert!(matches!(
        admitted,
        AdmittedRoute::Admit(RouteDecision::Continue { task: TaskId(_) })
    ));
}

#[test]
fn high_confidence_continue_of_stopped_is_admitted() {
    let admitted = admit_route(
        &proposal(
            ProposedRouteDecision::Continue {
                target: parent("task-1"),
            },
            900,
            200,
            vec![TaskId("task-1".into())],
        ),
        &policy(),
        &user_message(),
        &phases(
            "task-1",
            TaskPhase::Stopped {
                command: CommandId(7),
            },
        ),
    );
    assert!(matches!(
        admitted,
        AdmittedRoute::Admit(RouteDecision::Continue { task: TaskId(_) })
    ));
}

#[test]
fn retry_of_stopped_parent_is_admitted_on_user_message() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Retry {
            target: parent("task-1"),
        }),
        &user_message(),
        &phases(
            "task-1",
            TaskPhase::Stopped {
                command: CommandId(7),
            },
        ),
    );
    assert!(matches!(
        admitted,
        AdmittedRoute::Admit(RouteDecision::Retry { task: TaskId(_) })
    ));
}

#[test]
fn child_target_on_a_user_message_asks_and_seals_nothing() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Continue {
            target: RouteTarget::Child(ChildId("child-1".into())),
        }),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_CHILD_TARGET);
}

#[test]
fn missing_parent_continue_never_admits() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Continue {
            target: parent("ghost"),
        }),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_UNKNOWN_TASK);
}

#[test]
fn missing_parent_create_linked_never_admits() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::CreateLinked {
            prior: parent("ghost"),
            link: TaskLink::Modifies,
        }),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_UNKNOWN_TASK);
}

#[test]
fn missing_parent_inspect_never_admits() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Inspect {
            target: parent("ghost"),
        }),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_UNKNOWN_TASK);
}

#[test]
fn missing_parent_cancel_never_admits() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Cancel {
            target: parent("ghost"),
        }),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_UNKNOWN_TASK);
}

#[test]
fn missing_parent_retry_never_admits() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Retry {
            target: parent("ghost"),
        }),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_UNKNOWN_TASK);
}

#[test]
fn host_control_cancel_refuses_with_bypass() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Cancel {
            target: parent("task-1"),
        }),
        &host_control(),
        &phases(
            "task-1",
            TaskPhase::Running {
                attempt: AttemptId("a1".into()),
            },
        ),
    );
    assert_eq!(
        admitted,
        AdmittedRoute::Refuse {
            reason: RouteRefuse::HostControlBypass
        }
    );
}

#[test]
fn host_control_create_task_refuses_with_bypass() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::CreateTask),
        &host_control(),
        &BTreeMap::new(),
    );
    assert_eq!(
        admitted,
        AdmittedRoute::Refuse {
            reason: RouteRefuse::HostControlBypass
        }
    );
}

#[test]
fn user_relay_asks_with_clarification() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Relay {
            report: ReportId("report-1".into()),
        }),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_USER_RELAY);
}

#[test]
fn report_relay_admits() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Relay {
            report: ReportId("report-1".into()),
        }),
        &task_report(),
        &BTreeMap::new(),
    );
    assert_eq!(
        admitted,
        AdmittedRoute::Admit(RouteDecision::Relay {
            report: ReportId("report-1".into())
        })
    );
}

#[test]
fn split_on_report_refuses_split_proposal() {
    let admitted = authorize_control(
        &RouteProposal {
            proposed: ProposedRouteDecision::CreateTask,
            shape: ProposalShape::Split,
            considered: vec![],
            confidence: Confidence::from_thousandths(1000).unwrap(),
            margin: Confidence::from_thousandths(1000).unwrap(),
        },
        &task_report(),
        &BTreeMap::new(),
    );
    assert_eq!(
        admitted,
        AdmittedRoute::Refuse {
            reason: RouteRefuse::SplitProposal
        }
    );
}

#[test]
fn report_child_target_prefers_child_refusal() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Continue {
            target: RouteTarget::Child(ChildId("child-1".into())),
        }),
        &task_report(),
        &BTreeMap::new(),
    );
    assert_eq!(
        admitted,
        AdmittedRoute::Refuse {
            reason: RouteRefuse::ChildTarget
        }
    );
}

#[test]
fn policy_boundary_at_minimums_admits_create_task() {
    let admitted = admit_route(
        &proposal(ProposedRouteDecision::CreateTask, 800, 150, vec![]),
        &policy(),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_eq!(admitted, AdmittedRoute::Admit(RouteDecision::CreateTask));
}

#[test]
fn policy_boundary_considered_at_max_admits() {
    let considered: Vec<TaskId> = (0..8).map(|i| TaskId(format!("t{i}"))).collect();
    let admitted = admit_route(
        &proposal(ProposedRouteDecision::CreateTask, 800, 150, considered),
        &policy(),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_eq!(admitted, AdmittedRoute::Admit(RouteDecision::CreateTask));
}

#[test]
fn policy_low_confidence_demotes_to_ask_user() {
    let admitted = admit_route(
        &proposal(ProposedRouteDecision::CreateTask, 799, 150, vec![]),
        &policy(),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_POLICY);
}

#[test]
fn policy_low_margin_demotes_to_ask_user() {
    let admitted = admit_route(
        &proposal(ProposedRouteDecision::CreateTask, 800, 149, vec![]),
        &policy(),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_POLICY);
}

#[test]
fn policy_too_many_considered_demotes_to_ask_user() {
    let considered: Vec<TaskId> = (0..9).map(|i| TaskId(format!("t{i}"))).collect();
    let admitted = admit_route(
        &proposal(ProposedRouteDecision::CreateTask, 800, 150, considered),
        &policy(),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_POLICY);
}

#[test]
fn model_ask_user_text_is_preserved() {
    let text = "Which repository should I modify?";
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::AskUser {
            clarification: Clarification(text.into()),
        }),
        &user_message(),
        &BTreeMap::new(),
    );
    assert_eq!(
        admitted,
        AdmittedRoute::Admit(RouteDecision::AskUser {
            clarification: Clarification(text.into())
        })
    );
}

#[test]
fn terminal_continue_on_user_message_asks() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Continue {
            target: parent("task-1"),
        }),
        &user_message(),
        &phases(
            "task-1",
            TaskPhase::Completed {
                evidence: EvidenceSetId("ev-1".into()),
            },
        ),
    );
    assert_host_ask(admitted, CLARIFY_TERMINAL_CONTINUE);
}

#[test]
fn retry_on_running_parent_asks() {
    let admitted = authorize_control(
        &strong_proposal(ProposedRouteDecision::Retry {
            target: parent("task-1"),
        }),
        &user_message(),
        &phases(
            "task-1",
            TaskPhase::Running {
                attempt: AttemptId("a1".into()),
            },
        ),
    );
    assert_host_ask(admitted, CLARIFY_RETRY_INELIGIBLE);
}

#[test]
fn split_on_user_message_asks() {
    let admitted = authorize_control(
        &RouteProposal {
            proposed: ProposedRouteDecision::CreateTask,
            shape: ProposalShape::Split,
            considered: vec![],
            confidence: Confidence::from_thousandths(1000).unwrap(),
            margin: Confidence::from_thousandths(1000).unwrap(),
        },
        &user_message(),
        &BTreeMap::new(),
    );
    assert_host_ask(admitted, CLARIFY_SPLIT);
}
