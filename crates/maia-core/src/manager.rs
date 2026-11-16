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
    /// Recent CEO chat lines for this wake's bot (dedup). Ignored by fingerprint.
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

/// Short Tasks-rail title: first non-empty line, head-clipped to [`BRIEF_TITLE_CHARS`].
///
/// Full goal text still lives on the worker prompt; only the sidebar label is shortened.
#[must_use]
pub fn glanceable_task_title(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if line.is_empty() || BRIEF_TITLE_CHARS == 0 {
        return String::new();
    }
    let count = line.chars().count();
    if count <= BRIEF_TITLE_CHARS {
        return line.to_owned();
    }
    let head: String = line.chars().take(BRIEF_TITLE_CHARS.saturating_sub(1)).collect();
    format!("{head}…")
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
    let waiter_unanswered = waiting_ask_already_in_chat(snap);
    let waiter_answered = !waiter_unanswered
        && snap
            .waiting
            .iter()
            .any(|(_, q)| recent_ceo_covers(snap, q, CeoCoverKind::Ask));
    for (id, _) in &snap.waiting {
        if waiter_unanswered {
            lines.push(format!("await CEO answer for {id} (already asked)"));
        } else if waiter_answered {
            lines.push(format!("continue_task for {id} (CEO answered)"));
        } else {
            lines.push(format!("ask_user for {id} (CEO decision)"));
        }
    }
    if snap.completed_unopened > 0 {
        lines.push(
            "close-out finished goals with message_user immediately (do not wait for healthy runners)".to_owned(),
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
            if worker.secs_since_progress.is_none() {
                lines.push(format!(
                    "leave {} alone (resumed or idle unknown after host restart — do not re-hire a duplicate)",
                    worker.task_id
                ));
            } else {
                lines.push(format!("leave {} alone (healthy)", worker.task_id));
            }
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
        if waiting_ask_already_in_chat(snap) {
            lines.push(
                "CEO_WAITING (already asked): RECENT_CEO_CHAT already has your unanswered question. Stay silent. Do not rephrase. Do not ask_user again. Do not message_user that you are waiting. When the CEO answers, continue_task with their answer."
                    .to_owned(),
            );
        } else if snap.waiting.iter().any(|(_, q)| recent_ceo_covers(snap, q, CeoCoverKind::Ask))
        {
            lines.push(
                "CEO_WAITING (CEO answered): RECENT_CEO_CHAT has the owner's answer. continue_task immediately this wake with that task_id and their answer so the worker can finish. Do not wait for a later wake. Do not ask_user again."
                    .to_owned(),
            );
        } else {
            lines.push(
                "CEO_WAITING (mandatory): call ask_user immediately this wake with one clear CEO question. Do not defer. Do not stay silent. Do not call message_user instead. Do not paste worker wording; restate cleanly. Skip only if RECENT_CEO_CHAT already asked this."
                    .to_owned(),
            );
        }
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
            "FINISHED (close-out): worker success is not Done. Verify each outcome= against the goal's stated checks (path, format, content). If outcome= contains WRONG or otherwise fails a stated check, you MUST spawn_task this wake with a corrected brief that restates every stated goal check (path, format, content, forbidden tokens) so the next hire is durable — do not Silent, do not Done, do not continue_task or retry_task on a completed worker, and do not ask_user. When verification passes, send one Done message_user immediately this wake that starts with Done — and restates each outcome=. Never put a secret value, password, token, or vault contents into Done — name the secret, do not echo its value (even if outcome= shows it). Do not defer close-out. Prior status chatter (hired, working on it, will notify) does not close a goal. One close-out per finished goal. Then stay silent. Do not dump worker logs. Skip only if RECENT_CEO_CHAT already has that Done close-out."
                .to_owned(),
        );
        // Healthy runners are not "attention" — close out finished goals while they keep working.
        if snap.completed_unopened > 0
            && snap.failed_task_ids.is_empty()
            && snap.stuck_task_ids.is_empty()
            && snap.waiting.is_empty()
        {
            lines.push(
                "REQUIRED: verify the finished goal; if the check fails spawn_task once (do not continue_task on completed); otherwise message_user immediately (Done — …)."
                    .to_owned(),
            );
        }
        let secrets = ceo_supplied_secret_values(&snap.recent_ceo_lines);
        for worker in finished {
            let title = truncate_brief(&worker.title, BRIEF_TITLE_CHARS);
            let out = mask_close_out_secrets(
                &truncate_brief(&worker.output_tail, BRIEF_TAIL_CHARS),
                &secrets,
            );
            if out.is_empty() {
                lines.push(format!(
                    "- {}: goal_state=needs_close_out title={title} outcome=(no summary)",
                    worker.task_id
                ));
            } else {
                lines.push(format!(
                    "- {}: goal_state=needs_close_out title={title} outcome={out}",
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

/// True when `text` is a multi-bot wake fingerprint map (`bot_id=r=...` lines).
#[must_use]
pub fn is_bot_wake_fingerprint_map(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    trimmed.contains('\n') || trimmed.contains("=r=")
}

/// Parse per-bot wake fingerprints. Raw single-bot fingerprints (`r=...`) yield an empty map.
#[must_use]
pub fn parse_bot_wake_fingerprints(text: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if !is_bot_wake_fingerprint_map(text) {
        return map;
    }
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((bot, fp)) = line.split_once('=') else {
            continue;
        };
        let bot = bot.trim();
        let fp = fp.trim();
        if bot.is_empty() || fp.is_empty() {
            continue;
        }
        map.insert(bot.to_owned(), fp.to_owned());
    }
    map
}

/// Encode per-bot wake fingerprints (sorted). Empty map → empty string.
#[must_use]
pub fn encode_bot_wake_fingerprints(by_bot: &BTreeMap<String, String>) -> String {
    by_bot
        .iter()
        .map(|(bot, fp)| format!("{bot}={fp}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Previous fingerprint for one bot from a stored wake fingerprint string.
///
/// Multi-bot maps look up `bot_id`. Legacy single-bot strings (`r=...`) apply to any bot.
#[must_use]
pub fn previous_bot_wake_fingerprint(encoded: &str, bot_id: &str) -> String {
    let map = parse_bot_wake_fingerprints(encoded);
    if let Some(fp) = map.get(bot_id) {
        return fp.clone();
    }
    if !is_bot_wake_fingerprint_map(encoded) {
        return encoded.to_owned();
    }
    String::new()
}

/// Persist wake fingerprints after a multi-bot pass.
///
/// One bot → raw snapshot fingerprint (legacy-compatible). Several → map encoding.
#[must_use]
pub fn store_bot_wake_fingerprints(
    by_bot: &BTreeMap<String, String>,
    bots_woken: &[String],
) -> String {
    if bots_woken.len() <= 1 {
        if let Some(bot) = bots_woken.first() {
            return by_bot.get(bot).cloned().unwrap_or_default();
        }
        return String::new();
    }
    let mut kept = BTreeMap::new();
    for bot in bots_woken {
        if let Some(fp) = by_bot.get(bot) {
            kept.insert(bot.clone(), fp.clone());
        }
    }
    encode_bot_wake_fingerprints(&kept)
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
        // Answers are not in the fingerprint; still wake so continue_task can run.
        // WRONG outcomes are not in the fingerprint either — keep calling until recover.
        if !waiting_ceo_answered(snap) && !finished_outcome_needs_recover(snap) {
            return WakePlan::SkipModel;
        }
    }
    if model_calls_this_wake >= max_model_calls {
        return WakePlan::CapReached;
    }
    if !snap.failed_task_ids.is_empty() || !snap.stuck_task_ids.is_empty() {
        return WakePlan::RunModel {
            reason: "failed or stuck work needs judgment".to_owned(),
        };
    }
    if waiting_ceo_answered(snap) {
        return WakePlan::RunModel {
            reason: "CEO answered a waiting question".to_owned(),
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
            "retry_task" | "continue_task" => {
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

/// Lead-in stored on a waiting-worker continue so cold resume is not raw CEO chat.
pub const CEO_WAITING_ANSWER_PREFIX: &str = "CEO answered your waiting question.";

/// Frames a CEO reply so a resumed waiting worker finishes instead of re-asking.
///
/// Honest leaf: text in, framed text out. Idempotent when already framed.
#[must_use]
pub fn frame_ceo_waiting_answer(answer: &str) -> String {
    let trimmed = answer.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if is_framed_ceo_waiting_answer(trimmed) {
        return trimmed.to_owned();
    }
    format!(
        "{CEO_WAITING_ANSWER_PREFIX} Use this answer now: finish with success if the goal is done, or keep working with tools. Do not call waiting again for the same question.\n\nAnswer:\n{trimmed}"
    )
}

/// True when `text` is already a framed CEO waiting answer.
#[must_use]
pub fn is_framed_ceo_waiting_answer(text: &str) -> bool {
    text.trim_start()
        .starts_with(CEO_WAITING_ANSWER_PREFIX)
}

/// Drops optional wake status chatter when the owner muted non-essential messages.
///
/// Keeps `ask_user`, recover/cancel/spawn/learn, and finished-goal close-outs.
#[must_use]
pub fn filter_muted_wake_messages(actions: &[WakeAction], mute_nonessential: bool) -> Vec<WakeAction> {
    if !mute_nonessential {
        return actions.to_vec();
    }
    let muted: Vec<WakeAction> = actions
        .iter()
        .filter(|action| match action {
            WakeAction::MessageUser { text } => looks_like_close_out(text),
            _ => true,
        })
        .cloned()
        .collect();
    if muted.is_empty() {
        vec![WakeAction::Silent]
    } else {
        muted
    }
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

/// True when a waiter question was asked in CEO chat and no user line followed that ask.
#[must_use]
pub fn waiting_ask_already_in_chat(snap: &WakeSnapshot) -> bool {
    snap.waiting
        .iter()
        .any(|(_, question)| unanswered_ask_covers(snap, question))
}

/// True when a waiter was asked and the CEO's reply is already in recent chat.
///
/// CEO answers live outside the wake fingerprint, so [`plan_wake`] must still
/// spend a model call to `continue_task` even when the fingerprint is unchanged.
#[must_use]
pub fn waiting_ceo_answered(snap: &WakeSnapshot) -> bool {
    !snap.waiting.is_empty()
        && !waiting_ask_already_in_chat(snap)
        && snap
            .waiting
            .iter()
            .any(|(_, question)| recent_ceo_covers(snap, question, CeoCoverKind::Ask))
}

/// True when recent CEO chat has an ask covering `text` with no later `user:` reply.
#[must_use]
pub fn unanswered_ask_covers(snap: &WakeSnapshot, text: &str) -> bool {
    let keys = distinctive_tokens(text);
    if keys.is_empty() {
        return false;
    }
    let mut last_ask: Option<usize> = None;
    for (idx, line) in snap.recent_ceo_lines.iter().enumerate() {
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("assistant:") {
            continue;
        }
        if !keys.iter().any(|key| lower.contains(key.as_str())) {
            continue;
        }
        if ask_shaped_ceo_line(&lower) {
            last_ask = Some(idx);
        }
    }
    let Some(ask_idx) = last_ask else {
        return false;
    };
    !snap.recent_ceo_lines[ask_idx + 1..]
        .iter()
        .any(|line| line.to_ascii_lowercase().starts_with("user:"))
}

fn ask_shaped_ceo_line(lower: &str) -> bool {
    lower.contains('?')
        || lower.contains("need your decision")
        || lower.contains("what should")
        || lower.contains("provide")
        || lower.contains("password")
}

/// True when recent CEO assistant chat already covers `text` for this kind of moment.
#[must_use]
pub fn recent_ceo_covers(snap: &WakeSnapshot, text: &str, kind: CeoCoverKind) -> bool {
    let keys = distinctive_tokens(text);
    if keys.is_empty() {
        return false;
    }
    snap.recent_ceo_lines.iter().any(|line| {
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("assistant:") {
            return false;
        }
        if !keys.iter().any(|key| lower.contains(key.as_str())) {
            return false;
        }
        match kind {
            // Status chatter that merely mentions the secret must not suppress a real ask.
            CeoCoverKind::Ask => ask_shaped_ceo_line(&lower),
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

/// Durable failed-check marker already present in FINISHED `outcome=` (not a classifier).
///
/// When a completed worker's output tail still shows a WRONG draft, close-out must wait for a
/// corrected hire — safety must not Done over a known-bad draft. Negated mentions
/// ("no WRONG", verification passed) do not count.
#[must_use]
pub fn finished_outcome_needs_recover(snap: &WakeSnapshot) -> bool {
    snap.workers
        .iter()
        .any(|worker| worker.status == "completed" && outcome_shows_wrong_draft(&worker.output_tail))
}

fn outcome_shows_wrong_draft(tail: &str) -> bool {
    let upper = tail.to_ascii_uppercase();
    if !upper.contains("WRONG") {
        return false;
    }
    let wrote_wrong = upper.contains("WROTE WRONG")
        || upper.contains("WORD WRONG")
        || upper.contains("WRONG INTO")
        || upper.trim() == "WRONG";
    let negated = upper.contains("NO WRONG")
        || upper.contains("WITHOUT WRONG")
        || upper.contains("NOT CONTAIN WRONG")
        || upper.contains("FORBIDDEN TOKEN");
    if negated {
        return wrote_wrong;
    }
    true
}

/// Alphanumeric tokens of length >= 6, lowercased (longest first).
#[must_use]
pub fn distinctive_tokens(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = text
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .map(|part| part.to_ascii_lowercase())
        .filter(|part| part.chars().count() >= 6)
        .collect();
    tokens.sort_by_key(|part| std::cmp::Reverse(part.chars().count()));
    tokens.dedup();
    tokens
}

/// Longest alphanumeric token of length >= 6, lowercased. Empty when none.
#[must_use]
pub fn distinctive_token(text: &str) -> String {
    distinctive_tokens(text).into_iter().next().unwrap_or_default()
}

/// One-line Done body for a finished wake, or `"the goal"` when nothing useful is known.
#[must_use]
pub fn finished_close_out_summary(snap: &WakeSnapshot) -> String {
    let raw = snap
        .workers
        .iter()
        .find(|worker| worker.status == "completed")
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
    let secrets = ceo_supplied_secret_values(&snap.recent_ceo_lines);
    mask_close_out_secrets(&raw, &secrets)
}

/// Secret values the CEO just supplied in recent owner chat (after ` is ` / quotes).
///
/// Honest leaf: lines in, value strings out. Does not treat long ALL_CAPS names as values.
#[must_use]
pub fn ceo_supplied_secret_values(recent_ceo_lines: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for line in recent_ceo_lines {
        let body = line
            .strip_prefix("user:")
            .or_else(|| line.strip_prefix("User:"))
            .unwrap_or(line)
            .trim();
        if body.is_empty() {
            continue;
        }
        push_quoted_secret_values(body, &mut out);
        push_is_clause_secret_value(body, &mut out);
    }
    out.sort_by_key(|value| std::cmp::Reverse(value.chars().count()));
    out.dedup();
    out
}

fn push_quoted_secret_values(body: &str, out: &mut Vec<String>) {
    for (open, close) in [('"', '"'), ('\'', '\'')] {
        let mut rest = body;
        while let Some(start) = rest.find(open) {
            let after = &rest[start + open.len_utf8()..];
            let Some(end) = after.find(close) else {
                break;
            };
            let value = after[..end].trim();
            if secret_value_candidate(value) {
                out.push(value.to_owned());
            }
            rest = &after[end + close.len_utf8()..];
        }
    }
}

fn push_is_clause_secret_value(body: &str, out: &mut Vec<String>) {
    let lower = body.to_ascii_lowercase();
    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find(" is ") {
        let abs = search_from + rel;
        let after = body[abs + 4..].trim_start();
        let token = after
            .split(|ch: char| ch.is_whitespace() || matches!(ch, '.' | ',' | ';' | '!' | '?'))
            .next()
            .unwrap_or("")
            .trim_matches(|ch: char| matches!(ch, '"' | '\'' | '`'));
        if secret_value_candidate(token) {
            out.push(token.to_owned());
        }
        search_from = abs + 4;
    }
}

fn secret_value_candidate(value: &str) -> bool {
    let chars = value.chars().count();
    if chars < 6 || chars > 128 {
        return false;
    }
    // Secret *names* are often ALL_CAPS with underscores; values usually are not.
    let letters: Vec<char> = value.chars().filter(|ch| ch.is_ascii_alphabetic()).collect();
    if !letters.is_empty() && letters.iter().all(|ch| ch.is_ascii_uppercase()) {
        return false;
    }
    true
}

/// Replaces each known secret value in close-out text with `[redacted]`.
#[must_use]
pub fn mask_close_out_secrets(text: &str, secrets: &[String]) -> String {
    let mut ordered: Vec<&str> = secrets
        .iter()
        .map(String::as_str)
        .filter(|secret| !secret.is_empty())
        .collect();
    ordered.sort_by_key(|secret| std::cmp::Reverse(secret.chars().count()));
    let mut out = text.to_owned();
    for secret in ordered {
        out = out.replace(secret, "[redacted]");
    }
    out
}

/// Safety cap only: waiting → one ask_user; silent finished → one Done; skip if already in chat.
///
/// Drops `spawn_task` on idle wakes (LEARNED must not invent goals). A finished wake may keep
/// `spawn_task` and defer Done for a second hire; the host re-runs this cap after apply when
/// that hire never started live work (see orchestrator second pass).
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
            // Idle wake (no attention, no finished goal) → drop LEARNED-only hire.
            let idle = attention_clear && snap.completed_unopened == 0;
            !(idle && matches!(action, WakeAction::Spawn { .. }))
        })
        .filter(|action| match action {
            // Safety cap: never re-post an ask / Done already covered in CEO chat.
            // While a waiter is already asked, drop any rephrased ask_user too.
            WakeAction::AskUser { text } => {
                !waiting_ask_already_in_chat(snap)
                    && !recent_ceo_covers(snap, text, CeoCoverKind::Ask)
            }
            WakeAction::MessageUser { text } if looks_like_close_out(text) => {
                !finished_outcome_needs_recover(snap)
                    && !recent_ceo_covers(snap, text, CeoCoverKind::CloseOut)
            }
            // Unanswered ask → stay silent; drop standing-by / status chatter.
            WakeAction::MessageUser { .. } if waiting_ask_already_in_chat(snap) => false,
            _ => true,
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
    // Real second hire defers Done; host second-pass forces Done if the hire stays idle.
    let recovering = out
        .iter()
        .any(|action| matches!(action, WakeAction::Spawn { .. }));

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

    if snap.completed_unopened > 0
        && attention_clear
        && !closed_out
        && !recovering
        && !finished_outcome_needs_recover(snap)
    {
        let summary = finished_close_out_summary(snap);
        if !recent_ceo_covers(snap, &summary, CeoCoverKind::CloseOut) {
            let secrets = ceo_supplied_secret_values(&snap.recent_ceo_lines);
            let text = mask_close_out_secrets(&format!("Done — {summary}"), &secrets);
            out.push(WakeAction::MessageUser { text });
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
