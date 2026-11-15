//! Autonomous manager policy for long-running goals.
//!
//! These functions read only their arguments. Clocks, stores, and model calls
//! stay at the daemon skin.

use std::collections::BTreeMap;

/// Default wake heartbeat interval, in seconds (5 minutes).
pub const DEFAULT_WAKE_INTERVAL_SECS: u64 = 300;

/// How many autonomous recoveries one goal may take before escalating.
pub const DEFAULT_AUTONOMOUS_RETRY_BUDGET: u32 = 3;

/// Model calls allowed on one wake when something changed.
pub const MAX_MODEL_CALLS_PER_WAKE: u32 = 1;

/// Why the CEO must decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CeoNeed {
    /// Secrets, API keys, logins.
    Credentials,
    /// Spend or purchase.
    Money,
    /// Destructive or hard-to-undo action.
    Irreversible,
    /// Taste or policy choice with no safe default.
    Preference,
    /// Outside event the manager cannot drive.
    External,
}

/// Whether the orchestrator can keep going alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockerClass {
    /// Retry, re-plan, or pick a sensible default.
    Autonomous,
    /// Ask Garrett through the orchestrator.
    NeedsCeo {
        /// Kind of CEO decision.
        kind: CeoNeed,
    },
}

/// What the manager does after a worker failure or stuck pause.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryAction {
    /// Retry the same goal with a different approach note.
    RetryDifferentApproach {
        /// Note injected into the next worker turn.
        note: String,
    },
    /// Ask the CEO one clear question.
    Escalate {
        /// Orchestrator chat line.
        question: String,
    },
}

/// Observed work for one wake tick.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WakeSnapshot {
    /// Parent tasks in `Failed`.
    pub failed_task_ids: Vec<String>,
    /// Parent tasks stuck waiting after loop exhaustion (or equivalent).
    pub stuck_task_ids: Vec<String>,
    /// Waiting tasks with their current question text.
    pub waiting: Vec<(String, String)>,
    /// How many parents are queued or running.
    pub running_count: u32,
    /// Completed tasks the owner has not opened.
    pub completed_unopened: u32,
}

/// Whether a wake should spend a model call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakePlan {
    /// Interval not due yet.
    NotDue,
    /// Nothing useful changed; stay quiet.
    Silent,
    /// Fingerprint unchanged; skip the model.
    SkipModel,
    /// Daily / per-wake cost cap hit.
    CapReached,
    /// Something changed; a model call is allowed.
    RunModel {
        /// Why the model is needed.
        reason: String,
    },
}

/// One tool the wake model (or deterministic wake) may emit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeToolCall {
    /// Tool name.
    pub name: String,
    /// Message or task id payload.
    pub message: String,
}

/// Concrete side effect from a wake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakeAction {
    /// Do nothing visible.
    Silent,
    /// Post one orchestrator chat line.
    MessageUser {
        /// Chat body.
        text: String,
    },
    /// Retry a failed or stuck parent.
    Recover {
        /// Parent task id.
        task_id: String,
        /// Approach note for the worker.
        note: String,
    },
    /// Hold a task with one CEO question.
    Escalate {
        /// Parent task id.
        task_id: String,
        /// Question for the owner.
        question: String,
    },
}

/// Classifies a worker failure or waiting message.
#[must_use]
pub fn classify_blocker_text(text: &str) -> BlockerClass {
    let folded = text.to_lowercase();
    if contains_any(
        &folded,
        &[
            "api key",
            "apikey",
            "credential",
            "password",
            "login",
            "auth token",
            "secret",
            "sign in",
            "authenticate",
        ],
    ) {
        return BlockerClass::NeedsCeo {
            kind: CeoNeed::Credentials,
        };
    }
    if contains_any(
        &folded,
        &[
            "cost $",
            "costs $",
            "pay $",
            "purchase",
            "billing",
            "spend $",
            "credit card",
            "invoice",
        ],
    ) {
        return BlockerClass::NeedsCeo {
            kind: CeoNeed::Money,
        };
    }
    if contains_any(
        &folded,
        &[
            "delete",
            "drop database",
            "rm -rf",
            "destroy",
            "wipe",
            "irreversible",
            "cannot undo",
            "permanently",
        ],
    ) {
        return BlockerClass::NeedsCeo {
            kind: CeoNeed::Irreversible,
        };
    }
    if contains_any(
        &folded,
        &[
            "which one",
            "which city",
            "which file",
            "which option",
            "do you prefer",
            "your preference",
            "should i choose",
            "pick one",
            "what should i",
        ],
    ) || folded.contains("which ")
    {
        return BlockerClass::NeedsCeo {
            kind: CeoNeed::Preference,
        };
    }
    if contains_any(
        &folded,
        &[
            "waiting on you",
            "need you to",
            "outside",
            "third party",
            "human must",
            "manual approval",
        ],
    ) {
        return BlockerClass::NeedsCeo {
            kind: CeoNeed::External,
        };
    }
    BlockerClass::Autonomous
}

/// Picks retry or escalate from class and remaining budget.
#[must_use]
pub fn decide_recovery(
    class: BlockerClass,
    retries_used: u32,
    budget: u32,
    summary: &str,
) -> RecoveryAction {
    match class {
        BlockerClass::NeedsCeo { .. } => RecoveryAction::Escalate {
            question: format_ceo_question("", summary, class),
        },
        BlockerClass::Autonomous if retries_used >= budget => RecoveryAction::Escalate {
            question: format!(
                "I tried {budget} autonomous recoveries and I am still blocked: {}. What should I do next?",
                trim_summary(summary)
            ),
        },
        BlockerClass::Autonomous => RecoveryAction::RetryDifferentApproach {
            note: format!(
                "Previous approach failed: {}. Try a different approach. Do not repeat the same steps. Say in one line what you will try next.",
                trim_summary(summary)
            ),
        },
    }
}

/// One orchestrator question for the CEO. Never a bare "Needs you".
#[must_use]
pub fn format_ceo_question(goal: &str, summary: &str, class: BlockerClass) -> String {
    let summary = trim_summary(summary);
    let need = match class {
        BlockerClass::Autonomous => "a decision".to_owned(),
        BlockerClass::NeedsCeo { kind } => match kind {
            CeoNeed::Credentials => "credentials (API key, login, or secret)".to_owned(),
            CeoNeed::Money => "a spend decision".to_owned(),
            CeoNeed::Irreversible => "approval for an irreversible action I cannot undo".to_owned(),
            CeoNeed::Preference => "your preference".to_owned(),
            CeoNeed::External => "something only you can do externally".to_owned(),
        },
    };
    if goal.trim().is_empty() {
        format!("I need {need}: {summary}")
    } else {
        format!(
            "Goal \"{}\": I need {need}. {}",
            goal.trim(),
            summary
        )
    }
}

/// Stable fingerprint of a wake snapshot.
#[must_use]
pub fn snapshot_fingerprint(snap: &WakeSnapshot) -> String {
    let mut parts = Vec::new();
    parts.push(format!("r={}", snap.running_count));
    parts.push(format!("c={}", snap.completed_unopened));
    let mut failed = snap.failed_task_ids.clone();
    failed.sort();
    parts.push(format!("f={}", failed.join(",")));
    let mut stuck = snap.stuck_task_ids.clone();
    stuck.sort();
    parts.push(format!("s={}", stuck.join(",")));
    let mut waiting = snap.waiting.clone();
    waiting.sort();
    let waiting_line = waiting
        .into_iter()
        .map(|(id, q)| format!("{id}:{q}"))
        .collect::<Vec<_>>()
        .join("|");
    parts.push(format!("w={waiting_line}"));
    parts.join(";")
}

/// Decides whether this wake spends a model call.
#[must_use]
pub fn plan_wake(
    now_secs: u64,
    last_wake_secs: u64,
    interval_secs: u64,
    previous_fingerprint: &str,
    snap: &WakeSnapshot,
    model_calls_this_wake: u32,
    max_model_calls: u32,
) -> WakePlan {
    if interval_secs > 0 && now_secs.saturating_sub(last_wake_secs) < interval_secs {
        return WakePlan::NotDue;
    }
    let fingerprint = snapshot_fingerprint(snap);
    let idle = snap.failed_task_ids.is_empty()
        && snap.stuck_task_ids.is_empty()
        && snap.waiting.is_empty()
        && snap.running_count == 0;
    if idle {
        return WakePlan::Silent;
    }
    if !previous_fingerprint.is_empty() && previous_fingerprint == fingerprint {
        return WakePlan::SkipModel;
    }
    if model_calls_this_wake >= max_model_calls {
        return WakePlan::CapReached;
    }
    if !snap.failed_task_ids.is_empty() || !snap.stuck_task_ids.is_empty() {
        return WakePlan::RunModel {
            reason: "failed or stuck work needs judgment".to_owned(),
        };
    }
    if !snap.waiting.is_empty() {
        return WakePlan::RunModel {
            reason: "waiting tasks may need a CEO question".to_owned(),
        };
    }
    WakePlan::Silent
}

/// Deterministic recoveries for failed tasks under budget (no model).
#[must_use]
pub fn wake_actions_for_failures(
    snap: &WakeSnapshot,
    retries_by_task: &[(String, u32)],
    budget: u32,
) -> Vec<WakeAction> {
    let counts: BTreeMap<&str, u32> = retries_by_task
        .iter()
        .map(|(id, count)| (id.as_str(), *count))
        .collect();
    let mut actions = Vec::new();
    for task_id in &snap.failed_task_ids {
        let used = counts.get(task_id.as_str()).copied().unwrap_or(0);
        match decide_recovery(
            BlockerClass::Autonomous,
            used,
            budget,
            "failed worker on wake",
        ) {
            RecoveryAction::RetryDifferentApproach { note } => {
                actions.push(WakeAction::Recover {
                    task_id: task_id.clone(),
                    note,
                });
            }
            RecoveryAction::Escalate { question } => {
                actions.push(WakeAction::Escalate {
                    task_id: task_id.clone(),
                    question,
                });
            }
        }
    }
    for task_id in &snap.stuck_task_ids {
        let used = counts.get(task_id.as_str()).copied().unwrap_or(0);
        match decide_recovery(
            BlockerClass::Autonomous,
            used,
            budget,
            "stuck worker on wake",
        ) {
            RecoveryAction::RetryDifferentApproach { note } => {
                actions.push(WakeAction::Recover {
                    task_id: task_id.clone(),
                    note,
                });
            }
            RecoveryAction::Escalate { question } => {
                actions.push(WakeAction::Escalate {
                    task_id: task_id.clone(),
                    question,
                });
            }
        }
    }
    actions
}

/// Maps wake tool calls into host actions. Unknown tools are ignored.
#[must_use]
pub fn interpret_wake_tools(calls: &[WakeToolCall]) -> Vec<WakeAction> {
    let mut actions = Vec::new();
    for call in calls {
        match call.name.as_str() {
            "message_user" => {
                let text = call.message.trim();
                if !text.is_empty() {
                    actions.push(WakeAction::MessageUser {
                        text: text.to_owned(),
                    });
                }
            }
            "retry_task" | "recover_task" => {
                let task_id = call.message.trim();
                if !task_id.is_empty() {
                    actions.push(WakeAction::Recover {
                        task_id: task_id.to_owned(),
                        note: "Wake recovery: try a different approach.".to_owned(),
                    });
                }
            }
            _ => {}
        }
    }
    if actions.is_empty() {
        actions.push(WakeAction::Silent);
    }
    actions
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn trim_summary(summary: &str) -> String {
    let trimmed = summary.trim();
    if trimmed.chars().count() <= 280 {
        return trimmed.to_owned();
    }
    let mut out = trimmed.chars().take(277).collect::<String>();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_order_independent_for_failed_ids() {
        let left = WakeSnapshot {
            failed_task_ids: vec!["b".to_owned(), "a".to_owned()],
            ..WakeSnapshot::default()
        };
        let right = WakeSnapshot {
            failed_task_ids: vec!["a".to_owned(), "b".to_owned()],
            ..WakeSnapshot::default()
        };
        assert_eq!(snapshot_fingerprint(&left), snapshot_fingerprint(&right));
    }
}
