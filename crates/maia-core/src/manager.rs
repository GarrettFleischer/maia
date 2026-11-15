//! Autonomous manager policy for long-running goals.
//!
//! Honest leaves only: wake fingerprints, cost caps, tool interpretation, brief
//! formatting, and a restart-budget backstop. Strategy lives in the orchestrator
//! prompt + tools.

use std::collections::BTreeMap;

/// Default wake heartbeat interval, in seconds (5 minutes).
pub const DEFAULT_WAKE_INTERVAL_SECS: u64 = 300;

/// How many automatic restarts one goal may take before the manager must ask.
pub const DEFAULT_AUTONOMOUS_RETRY_BUDGET: u32 = 3;

/// Model calls allowed on one wake when something changed.
pub const MAX_MODEL_CALLS_PER_WAKE: u32 = 1;

/// Max characters kept for a worker's recent output tail in briefs.
pub const BRIEF_TAIL_CHARS: usize = 240;

/// Max characters kept for a worker's last error in briefs.
pub const BRIEF_ERROR_CHARS: usize = 160;

/// Max characters kept for a worker title in briefs.
pub const BRIEF_TITLE_CHARS: usize = 80;

/// Compact per-worker facts for wake / inspect prompt context.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkerBrief {
    /// Parent task id.
    pub task_id: String,
    /// Short goal title.
    pub title: String,
    /// Phase label such as `failed`, `waiting`, `running`.
    pub status: String,
    /// Seconds since last observed progress, when known.
    pub secs_since_progress: Option<u64>,
    /// Truncation-ready recent output.
    pub output_tail: String,
    /// Truncation-ready last error, empty when none.
    pub last_error: String,
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
    /// Prompt-only detail per open worker. Ignored by fingerprint.
    pub workers: Vec<WorkerBrief>,
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

/// One tool the wake model may emit.
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
    /// Post one useful CEO update (not a decision).
    MessageUser {
        /// Chat body.
        text: String,
    },
    /// Ask the CEO one clear decision question.
    AskUser {
        /// Question body.
        text: String,
    },
    /// Retry a failed or stuck parent with a new approach note.
    Recover {
        /// Parent task id.
        task_id: String,
        /// Approach note for the worker.
        note: String,
    },
    /// Stop a parent for good.
    Cancel {
        /// Parent task id.
        task_id: String,
    },
    /// Hire a new worker from a wake (goal text / guidance). Does not post chat.
    Spawn {
        /// Goal text for the new worker.
        guidance: String,
    },
}

/// True when automatic restarts are used up and the manager must ask the user.
#[must_use]
pub fn restart_budget_exhausted(retries_used: u32, budget: u32) -> bool {
    retries_used >= budget
}

/// Truncates text for wake / inspect briefs. Keeps the tail when longer than max.
#[must_use]
pub fn truncate_brief(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if max_chars == 0 || trimmed.is_empty() {
        return String::new();
    }
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_owned();
    }
    let skip = count.saturating_sub(max_chars);
    let tail: String = trimmed.chars().skip(skip).collect();
    format!("…{tail}")
}

/// One worker line for wake briefs and `inspect_task` results.
#[must_use]
pub fn format_worker_brief(worker: &WorkerBrief) -> String {
    let title = truncate_brief(&worker.title, BRIEF_TITLE_CHARS);
    let out = truncate_brief(&worker.output_tail, BRIEF_TAIL_CHARS);
    let err = truncate_brief(&worker.last_error, BRIEF_ERROR_CHARS);
    let idle = match worker.secs_since_progress {
        Some(secs) => format!("{secs}s"),
        None => "unknown".to_owned(),
    };
    let mut lines = vec![format!(
        "worker {} status={} idle={idle} title={title}",
        worker.task_id, worker.status
    )];
    if !out.is_empty() {
        lines.push(format!("  out: {out}"));
    }
    if !err.is_empty() {
        lines.push(format!("  err: {err}"));
    }
    lines.join("\n")
}

/// Prompt context for a manager wake that will call the model.
#[must_use]
pub fn format_wake_brief(snap: &WakeSnapshot) -> String {
    let mut lines = vec![
        "Silent manager wake. Review workers and act with manager route tools only. Never call bash, shell, write_file, read_file, success, failure, or waiting. Stay silent unless ask_user or message_user is truly needed.".to_owned(),
        format!("running={}", snap.running_count),
        format!("completed_unopened={}", snap.completed_unopened),
    ];
    if !snap.failed_task_ids.is_empty() {
        lines.push(format!("failed={}", snap.failed_task_ids.join(",")));
    }
    if !snap.stuck_task_ids.is_empty() {
        lines.push(format!("stuck={}", snap.stuck_task_ids.join(",")));
    }
    if !snap.failed_task_ids.is_empty() || !snap.stuck_task_ids.is_empty() {
        lines.push(
            "REQUIRED: call retry_task or continue_task with the failed/stuck task_id (and guidance). Do not call bash. Do not ask_user for a fixable missing-file or tool error."
                .to_owned(),
        );
    }
    if !snap.waiting.is_empty() {
        lines.push(
            "REQUIRED: call ask_user once with one clear CEO question for the waiting worker. Do not stay silent. Do not call bash. Do not paste worker wording; restate cleanly. Do not ask again if that question is already in chat."
                .to_owned(),
        );
    }
    if snap.completed_unopened > 0
        && snap.failed_task_ids.is_empty()
        && snap.stuck_task_ids.is_empty()
        && snap.waiting.is_empty()
        && snap.running_count == 0
    {
        lines.push(
            "REQUIRED: call message_user once with one short useful close-out for the finished goal. Do not dump worker logs. Do not call bash."
                .to_owned(),
        );
    }
    for (id, question) in &snap.waiting {
        let q = truncate_brief(question, BRIEF_TAIL_CHARS);
        lines.push(format!("waiting {id}: {q}"));
    }
    for worker in &snap.workers {
        lines.push(format_worker_brief(worker));
    }
    lines.join("\n")
}

/// Splits a wake tool payload into task id and optional guidance note.
#[must_use]
pub fn split_task_and_note(message: &str) -> (String, String) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return (String::new(), String::new());
    }
    if let Some((task_id, note)) = trimmed.split_once('\n') {
        let task_id = task_id.trim().to_owned();
        let note = note.trim().to_owned();
        if note.is_empty() {
            (
                task_id,
                "Manager: try a different approach.".to_owned(),
            )
        } else {
            (task_id, note)
        }
    } else {
        (
            trimmed.to_owned(),
            "Manager: try a different approach.".to_owned(),
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
        && snap.running_count == 0
        && snap.completed_unopened == 0;
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
    if snap.completed_unopened > 0 {
        return WakePlan::RunModel {
            reason: "finished goals need a short close-out".to_owned(),
        };
    }
    WakePlan::Silent
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
            "ask_user" => {
                let text = call.message.trim();
                if !text.is_empty() {
                    actions.push(WakeAction::AskUser {
                        text: text.to_owned(),
                    });
                }
            }
            "retry_task" | "recover_task" | "continue_task" => {
                let (task_id, note) = split_task_and_note(&call.message);
                if !task_id.is_empty() {
                    actions.push(WakeAction::Recover { task_id, note });
                }
            }
            "cancel_task" => {
                let task_id = call.message.trim();
                if !task_id.is_empty() {
                    actions.push(WakeAction::Cancel {
                        task_id: task_id.to_owned(),
                    });
                }
            }
            "spawn_task" => {
                let guidance = call.message.trim();
                if !guidance.is_empty() {
                    actions.push(WakeAction::Spawn {
                        guidance: guidance.to_owned(),
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

/// Safety backstop: recoveries past the restart budget become one ask_user.
#[must_use]
pub fn enforce_restart_budget(
    actions: &[WakeAction],
    retries_by_task: &[(String, u32)],
    budget: u32,
) -> Vec<WakeAction> {
    let counts: BTreeMap<&str, u32> = retries_by_task
        .iter()
        .map(|(id, count)| (id.as_str(), *count))
        .collect();
    actions
        .iter()
        .map(|action| match action {
            WakeAction::Recover { task_id, .. } => {
                let used = counts.get(task_id.as_str()).copied().unwrap_or(0);
                if restart_budget_exhausted(used, budget) {
                    WakeAction::AskUser {
                        text: format!(
                            "Goal {task_id}: I have used {budget} automatic restarts and I am still blocked. What should I do next?"
                        ),
                    }
                } else {
                    action.clone()
                }
            }
            other => other.clone(),
        })
        .collect()
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
