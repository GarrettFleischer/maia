//! Pure route admission leaves for the Super Agent router.

use std::collections::BTreeMap;

use super::types::{
    AdmittedRoute, Clarification, ProposalShape, ProposedRouteDecision, RouteDecision,
    RouteProposal, RouteRefuse, RouteTarget, RoutingPolicy, TaskId, TaskPhase, TurnSource,
};

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

/// Builds a host-generated clarification question with explicit non-empty text.
pub fn host_ask_user(text: &str) -> AdmittedRoute {
    AdmittedRoute::AskUser {
        clarification: Clarification(text.to_owned()),
    }
}

fn is_terminal(phase: &TaskPhase) -> bool {
    matches!(
        phase,
        TaskPhase::Completed { .. } | TaskPhase::Cancelled { .. } | TaskPhase::Abandoned { .. }
    )
}

fn is_retry_eligible(phase: &TaskPhase) -> bool {
    matches!(phase, TaskPhase::Failed { .. } | TaskPhase::Stopped { .. })
}

fn proposal_names_child(proposed: &ProposedRouteDecision) -> bool {
    match proposed {
        ProposedRouteDecision::Continue { target }
        | ProposedRouteDecision::Inspect { target }
        | ProposedRouteDecision::Cancel { target }
        | ProposedRouteDecision::Retry { target } => matches!(target, RouteTarget::Child(_)),
        ProposedRouteDecision::CreateLinked { prior, .. } => {
            matches!(prior, RouteTarget::Child(_))
        }
        ProposedRouteDecision::CreateTask
        | ProposedRouteDecision::AskUser { .. }
        | ProposedRouteDecision::Relay { .. } => false,
    }
}

fn parent_phase<'a>(
    target: &RouteTarget,
    phases: &'a BTreeMap<TaskId, TaskPhase>,
) -> Option<&'a TaskPhase> {
    match target {
        RouteTarget::Parent(task) => phases.get(task),
        RouteTarget::Child(_) => None,
    }
}

fn cited_parent_missing(
    proposed: &ProposedRouteDecision,
    phases: &BTreeMap<TaskId, TaskPhase>,
) -> bool {
    cited_parent_ids(proposed)
        .into_iter()
        .any(|task| !phases.contains_key(task))
}

fn cited_parent_ids(proposed: &ProposedRouteDecision) -> Vec<&TaskId> {
    match proposed {
        ProposedRouteDecision::Continue { target }
        | ProposedRouteDecision::Inspect { target }
        | ProposedRouteDecision::Cancel { target }
        | ProposedRouteDecision::Retry { target } => match target {
            RouteTarget::Parent(task) => vec![task],
            RouteTarget::Child(_) => vec![],
        },
        ProposedRouteDecision::CreateLinked { prior, .. } => match prior {
            RouteTarget::Parent(task) => vec![task],
            RouteTarget::Child(_) => vec![],
        },
        ProposedRouteDecision::CreateTask
        | ProposedRouteDecision::AskUser { .. }
        | ProposedRouteDecision::Relay { .. } => vec![],
    }
}

fn user_message_host_ask_reason(
    proposed: &ProposedRouteDecision,
    phases: &BTreeMap<TaskId, TaskPhase>,
) -> Option<&'static str> {
    if cited_parent_missing(proposed, phases) {
        return Some(CLARIFY_UNKNOWN_TASK);
    }

    match proposed {
        ProposedRouteDecision::Relay { .. } => Some(CLARIFY_USER_RELAY),
        ProposedRouteDecision::Continue { target } => parent_phase(target, phases)
            .is_some_and(is_terminal)
            .then_some(CLARIFY_TERMINAL_CONTINUE),
        ProposedRouteDecision::CreateLinked { prior, .. } => parent_phase(prior, phases)
            .is_some_and(|phase| !is_terminal(phase))
            .then_some(CLARIFY_LIVE_LINKED),
        ProposedRouteDecision::Retry { target } => (!parent_phase(target, phases)
            .is_some_and(is_retry_eligible))
        .then_some(CLARIFY_RETRY_INELIGIBLE),
        _ => None,
    }
}

fn convert_proposed(proposed: &ProposedRouteDecision) -> Result<RouteDecision, RouteRefuse> {
    match proposed {
        ProposedRouteDecision::Continue { target } => {
            let task = parent_task_id(target)?;
            Ok(RouteDecision::Continue { task })
        }
        ProposedRouteDecision::CreateTask => Ok(RouteDecision::CreateTask),
        ProposedRouteDecision::CreateLinked { prior, link } => {
            let prior = parent_task_id(prior)?;
            Ok(RouteDecision::CreateLinked { prior, link: *link })
        }
        ProposedRouteDecision::Inspect { target } => {
            let task = parent_task_id(target)?;
            Ok(RouteDecision::Inspect { task })
        }
        ProposedRouteDecision::AskUser { clarification } => Ok(RouteDecision::AskUser {
            clarification: clarification.clone(),
        }),
        ProposedRouteDecision::Relay { report } => Ok(RouteDecision::Relay {
            report: report.clone(),
        }),
        ProposedRouteDecision::Cancel { target } => {
            let task = parent_task_id(target)?;
            Ok(RouteDecision::Cancel { task })
        }
        ProposedRouteDecision::Retry { target } => {
            let task = parent_task_id(target)?;
            Ok(RouteDecision::Retry { task })
        }
    }
}

fn parent_task_id(target: &RouteTarget) -> Result<TaskId, RouteRefuse> {
    match target {
        RouteTarget::Parent(task) => Ok(task.clone()),
        RouteTarget::Child(_) => Err(RouteRefuse::ChildTarget),
    }
}

fn policy_demotes_admit(proposal: &RouteProposal, policy: &RoutingPolicy) -> bool {
    proposal.confidence.thousandths() < policy.min_confidence.thousandths()
        || proposal.margin.thousandths() < policy.min_margin.thousandths()
        || proposal.considered.len() as u32 > policy.max_considered
}

fn policy_applies_to(decision: &RouteDecision) -> bool {
    matches!(
        decision,
        RouteDecision::Continue { .. }
            | RouteDecision::CreateTask
            | RouteDecision::CreateLinked { .. }
            | RouteDecision::Inspect { .. }
            | RouteDecision::Cancel { .. }
            | RouteDecision::Retry { .. }
    )
}

fn refuse_child_on_source(source: &TurnSource) -> AdmittedRoute {
    match source {
        TurnSource::UserMessage { .. } => host_ask_user(CLARIFY_CHILD_TARGET),
        TurnSource::TaskReport { .. } | TurnSource::HostControl { .. } => AdmittedRoute::Refuse {
            reason: RouteRefuse::ChildTarget,
        },
    }
}

fn refuse_split_on_source(source: &TurnSource) -> AdmittedRoute {
    match source {
        TurnSource::UserMessage { .. } => host_ask_user(CLARIFY_SPLIT),
        TurnSource::TaskReport { .. } | TurnSource::HostControl { .. } => AdmittedRoute::Refuse {
            reason: RouteRefuse::SplitProposal,
        },
    }
}

/// Applies structural rules and converts a proposal to a parent-only route decision.
pub fn authorize_control(
    proposal: &RouteProposal,
    source: &TurnSource,
    phases: &BTreeMap<TaskId, TaskPhase>,
) -> AdmittedRoute {
    if proposal_names_child(&proposal.proposed) {
        return refuse_child_on_source(source);
    }

    if proposal.shape == ProposalShape::Split {
        return refuse_split_on_source(source);
    }

    if matches!(source, TurnSource::TaskReport { .. })
        && !matches!(proposal.proposed, ProposedRouteDecision::Relay { .. })
    {
        return AdmittedRoute::Refuse {
            reason: RouteRefuse::ReportWake,
        };
    }

    if matches!(source, TurnSource::HostControl { .. }) {
        return AdmittedRoute::Refuse {
            reason: RouteRefuse::HostControlBypass,
        };
    }

    if matches!(source, TurnSource::UserMessage { .. })
        && let Some(text) = user_message_host_ask_reason(&proposal.proposed, phases)
    {
        return host_ask_user(text);
    }

    match convert_proposed(&proposal.proposed) {
        Ok(decision) => AdmittedRoute::Admit(decision),
        Err(RouteRefuse::ChildTarget) => refuse_child_on_source(source),
        Err(reason) => AdmittedRoute::Refuse { reason },
    }
}

/// Runs structural admission then applies explicit routing policy thresholds.
pub fn admit_route(
    proposal: &RouteProposal,
    policy: &RoutingPolicy,
    source: &TurnSource,
    phases: &BTreeMap<TaskId, TaskPhase>,
) -> AdmittedRoute {
    match authorize_control(proposal, source, phases) {
        AdmittedRoute::Refuse { reason } => AdmittedRoute::Refuse { reason },
        AdmittedRoute::AskUser { clarification } => AdmittedRoute::AskUser { clarification },
        AdmittedRoute::Admit(decision) => {
            if policy_applies_to(&decision) && policy_demotes_admit(proposal, policy) {
                host_ask_user(CLARIFY_POLICY)
            } else {
                AdmittedRoute::Admit(decision)
            }
        }
    }
}
