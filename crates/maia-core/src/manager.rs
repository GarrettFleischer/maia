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

/// Cap on durable learning notes kept in the wake sidecar / brief.
pub const MAX_LEARNED_NOTES: usize = 16;

/// Max characters kept for one learning note.
pub const LEARNED_NOTE_CHARS: usize = 160;

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
    /// Recent selected-bot CEO chat lines for dedup. Ignored by fingerprint.
    pub recent_ceo_lines: Vec<String>,
    /// Short notes from earlier wakes. Ignored by fingerprint.
    pub learned: Vec<String>,
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
    /// Persist a short lesson for later wakes (sidecar / brief). Does not post chat.
    RecordLearning {
        /// One short note about what worked or failed.
        note: String,
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

/// Merges new learning notes into the durable list (dedup, newest last, capped).
#[must_use]
pub fn merge_learned_notes(existing: &[String], additions: &[String]) -> Vec<String> {
    let mut out: Vec<String> = existing
        .iter()
        .map(|note| truncate_brief(note, LEARNED_NOTE_CHARS))
        .filter(|note| !note.is_empty())
        .collect();
    for note in additions {
        let clipped = truncate_brief(note, LEARNED_NOTE_CHARS);
        if clipped.is_empty() {
            continue;
        }
        out.retain(|prior| prior != &clipped);
        out.push(clipped);
    }
    let excess = out.len().saturating_sub(MAX_LEARNED_NOTES);
    if excess > 0 {
        out.drain(0..excess);
    }
    out
}

/// Prompt-only ordered attention lines for concurrent goals. Empty when idle.
#[must_use]
pub fn attention_lines(snap: &WakeSnapshot) -> Vec<String> {
    let mut lines = Vec::new();
    for id in &snap.failed_task_ids {
        lines.push(format!("retry/fix {id} (failed)"));
    }
    for id in &snap.stuck_task_ids {
        if !snap.failed_task_ids.iter().any(|failed| failed == id) {
            lines.push(format!("continue/fix {id} (stuck)"));
        }
    }
    for (id, _) in &snap.waiting {
        lines.push(format!("ask_user for {id} (CEO decision)"));
    }
    if snap.completed_unopened > 0 {
        lines.push(
            "close-out finished goals with message_user when other attention is clear".to_owned(),
        );
    }
    for worker in &snap.workers {
        if worker.status != "running" && worker.status != "queued" {
            continue;
        }
        let busy = snap.failed_task_ids.iter().any(|id| id == &worker.task_id)
            || snap.stuck_task_ids.iter().any(|id| id == &worker.task_id)
            || snap.waiting.iter().any(|(id, _)| id == &worker.task_id);
        if !busy {
            lines.push(format!("leave {} alone (healthy)", worker.task_id));
        }
    }
    lines
}

/// Prompt context for a manager wake that will call the model.
#[must_use]
pub fn format_wake_brief(snap: &WakeSnapshot) -> String {
    let mut lines = vec![
        "Manager wake. Use manager route tools only. Never call bash, shell, write_file, read_file, success, failure, or waiting.".to_owned(),
        "Default: stay silent. Mandatory exceptions below override silence.".to_owned(),
        format!("running={}", snap.running_count),
        format!("completed_unopened={}", snap.completed_unopened),
    ];
    if !snap.learned.is_empty() {
        lines.push(
            "LEARNED: prior lessons for ATTENTION items only (how to retry/fix a listed failure). Prefer a different approach after a failure; do not repeat a failed tactic. Never spawn_task from LEARNED alone — do not invent new work that is not in ATTENTION. Call record_learning with one short note when you learn something useful."
                .to_owned(),
        );
        for note in &snap.learned {
            let clipped = truncate_brief(note, LEARNED_NOTE_CHARS);
            if !clipped.is_empty() {
                lines.push(format!("- {clipped}"));
            }
        }
    }
    let attention = attention_lines(snap);
    if !attention.is_empty() {
        lines.push(
            "ATTENTION: act on each item that needs you this wake (failed → waiting → close-out). Leave healthy runners alone. One clear ask_user per blocked goal; one close-out per finished goal when clear; do not cross-talk or duplicate CEO messages."
                .to_owned(),
        );
        for item in attention {
            lines.push(format!("- {item}"));
        }
    }
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
            "CEO_WAITING (mandatory): call ask_user once with one clear CEO question. Do not stay silent. Do not call message_user instead. Do not paste worker wording; restate cleanly. Skip only if RECENT_CEO_CHAT already asked this."
                .to_owned(),
        );
        for (id, question) in &snap.waiting {
            let q = truncate_brief(question, BRIEF_TAIL_CHARS);
            lines.push(format!("- {id}: {q}"));
        }
    }
    let finished: Vec<&WorkerBrief> = snap
        .workers
        .iter()
        .filter(|worker| worker.status == "completed")
        .collect();
    if snap.completed_unopened > 0 || !finished.is_empty() {
        lines.push(
            "FINISHED (close-out): goals whose work just finished. When nothing else needs attention, call message_user once with one short useful close-out that restates what the worker accomplished (use each outcome= line). One close-out per finished goal. Do not dump worker logs. Skip if RECENT_CEO_CHAT already closed this out."
                .to_owned(),
        );
        // Healthy runners are not "attention" — close out finished goals while they keep working.
        if snap.completed_unopened > 0
            && snap.failed_task_ids.is_empty()
            && snap.stuck_task_ids.is_empty()
            && snap.waiting.is_empty()
        {
            lines.push(
                "REQUIRED: call message_user once now for the finished goal."
                    .to_owned(),
            );
        }
        for worker in finished {
            let title = truncate_brief(&worker.title, BRIEF_TITLE_CHARS);
            let out = truncate_brief(&worker.output_tail, BRIEF_TAIL_CHARS);
            if out.is_empty() {
                lines.push(format!("- {}: title={title} outcome=(no summary)", worker.task_id));
            } else {
                lines.push(format!(
                    "- {}: title={title} outcome={out}",
                    worker.task_id
                ));
            }
        }
    }
    if !snap.recent_ceo_lines.is_empty() {
        lines.push(
            "RECENT_CEO_CHAT (durable signal — do not repeat an ask_user or close-out already here):"
                .to_owned(),
        );
        for line in &snap.recent_ceo_lines {
            let clipped = truncate_brief(line, BRIEF_TAIL_CHARS);
            if !clipped.is_empty() {
                lines.push(format!("- {clipped}"));
            }
        }
    }
    for worker in &snap.workers {
        if worker.status == "completed" {
            continue;
        }
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
            "record_learning" => {
                let note = truncate_brief(&call.message, LEARNED_NOTE_CHARS);
                if !note.is_empty() {
                    actions.push(WakeAction::RecordLearning { note });
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

/// What kind of CEO-facing line we are trying not to duplicate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CeoCoverKind {
    /// An ask_user decision question.
    Ask,
    /// A finished-goal close-out.
    CloseOut,
}

/// True when recent CEO assistant chat already covers `text` for this kind of moment.
#[must_use]
pub fn recent_ceo_covers(snap: &WakeSnapshot, text: &str, kind: CeoCoverKind) -> bool {
    let key = distinctive_token(text);
    if key.is_empty() {
        return false;
    }
    snap.recent_ceo_lines.iter().any(|line| {
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("assistant:") || !lower.contains(key.as_str()) {
            return false;
        }
        match kind {
            // Status chatter that merely mentions the secret must not suppress a real ask.
            CeoCoverKind::Ask => {
                lower.contains('?')
                    || lower.contains("need your decision")
                    || lower.contains("what should")
                    || lower.contains("provide")
                    || lower.contains("password")
            }
            CeoCoverKind::CloseOut => {
                let body = lower.strip_prefix("assistant:").unwrap_or(lower.as_str()).trim();
                looks_like_close_out(body)
            }
        }
    })
}

/// True when a message_user body is a finished-goal close-out (not status chatter).
#[must_use]
pub fn looks_like_close_out(text: &str) -> bool {
    let trimmed = text.trim().to_ascii_lowercase();
    // Require a clear done lead-in. Planning text like "I'll send a close-out" must not match.
    trimmed.starts_with("done")
        || trimmed.starts_with("finished —")
        || trimmed.starts_with("finished -")
        || trimmed.starts_with("all done")
}

/// Longest alphanumeric token of length >= 6, lowercased. Empty when none.
#[must_use]
pub fn distinctive_token(text: &str) -> String {
    text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .map(|part| part.to_ascii_lowercase())
        .filter(|part| part.chars().count() >= 6)
        .max_by_key(|part| part.chars().count())
        .unwrap_or_default()
}

/// Safety cap: waiting → one ask_user; finished-only → one close-out; skip if already in chat.
///
/// Also drops `spawn_task` when ATTENTION has no failed/stuck/waiting work. LEARNED notes are
/// shared across bots; a close-out-only wake must not invent new goals from them.
#[must_use]
pub fn enforce_ceo_moments(actions: &[WakeAction], snap: &WakeSnapshot) -> Vec<WakeAction> {
    // Failed / stuck / waiting block close-out; healthy runners do not.
    let attention_clear = snap.failed_task_ids.is_empty()
        && snap.stuck_task_ids.is_empty()
        && snap.waiting.is_empty();
    let mut out: Vec<WakeAction> = actions
        .iter()
        .filter(|action| !matches!(action, WakeAction::Silent))
        .filter(|action| {
            // No failed/stuck/waiting → nothing to hire for on this wake.
            !(attention_clear && matches!(action, WakeAction::Spawn { .. }))
        })
        .cloned()
        .collect();
    let asked = out
        .iter()
        .any(|action| matches!(action, WakeAction::AskUser { .. }));
    let closed_out = out.iter().any(|action| match action {
        WakeAction::MessageUser { text } => looks_like_close_out(text),
        _ => false,
    });

    if !snap.waiting.is_empty() && !asked {
        if let Some((task_id, question)) = snap.waiting.first() {
            let question = truncate_brief(question, BRIEF_TAIL_CHARS);
            if !question.is_empty()
                && !recent_ceo_covers(snap, &question, CeoCoverKind::Ask)
            {
                out.push(WakeAction::AskUser {
                    text: format!("Need your decision for {task_id}: {question}"),
                });
            }
        }
    }

    if snap.completed_unopened > 0 && attention_clear && !closed_out {
        let finished = snap
            .workers
            .iter()
            .find(|worker| worker.status == "completed");
        let summary = finished
            .map(|worker| {
                let title = truncate_brief(&worker.title, BRIEF_TITLE_CHARS);
                let out = truncate_brief(&worker.output_tail, BRIEF_TAIL_CHARS);
                match (title.is_empty(), out.is_empty()) {
                    (false, false) => format!("{title} — {out}"),
                    (false, true) => title,
                    (true, false) => out,
                    (true, true) => String::new(),
                }
            })
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "the goal".to_owned());
        if !recent_ceo_covers(snap, &summary, CeoCoverKind::CloseOut) {
            out.push(WakeAction::MessageUser {
                text: format!("Done — {summary}"),
            });
        }
    }

    if out.is_empty() {
        out.push(WakeAction::Silent);
    }
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
