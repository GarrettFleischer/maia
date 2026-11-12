//! Loop detection and transcript compaction for a long task.
//!
//! These functions read only their arguments. They do not stop a task because
//! a counter reached a fixed number of tool calls.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;

use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

#[path = "task_guard.rs"]
mod task_guard;

pub use task_guard::{
    Addition, AdditionClass, GoalContract, HandoffNotes, ReviewEffect, ReviewVerdict, TodoItem,
    TodoList, TodoStatus,     accept_model_brief, answer_proposal, bound_digest, classify_addition, complete_item,
    contract_from_model, contract_json, deterministic_brief, deterministic_contract, effect_of,
    gate_tool, goal_prompt,
    handoff_chat_line, handoff_prompt, inherit_list, list_from_contract, owner_decision, start_item,
    owner_question, parse_review, parse_stored_plan, plan_json, propose_addition, review_is_due,
    review_prompt, GOAL_CONTRACT_PREFACE, HANDOFF_LIMIT, HANDOFF_PREFACE, REVIEW_INTERVAL_MS,
    REVIEW_PREFACE, REVIEW_STEP_CADENCE,
};

/// Recent steps kept for loop checks.
pub const LOOP_WINDOW: usize = 8;

/// How many matching steps inside [`LOOP_WINDOW`] count as a repeat.
pub const SAME_STEP_REPEAT: usize = 3;

/// Nudges for one loop signature before the task is handed off.
pub const NUDGES_BEFORE_PAUSE: u32 = 3;

/// Trailing steps whose outputs were all seen earlier.
pub const NO_PROGRESS_STREAK: usize = 4;

/// Default model context budget, in estimated tokens.
pub const DEFAULT_CONTEXT_TOKEN_BUDGET: u32 = 32_000;

/// Numerator for the compaction threshold (`budget * numerator / denominator`).
pub const CONTEXT_NEAR_NUMERATOR: u32 = 3;

/// Denominator for the compaction threshold.
pub const CONTEXT_NEAR_DENOMINATOR: u32 = 4;

/// Raw messages kept after a summary replaces older steps.
pub const COMPACTION_KEEP_TAIL: usize = 6;

/// First line of a compaction request. Callers detect this prefix.
pub const COMPACTION_PREFACE: &str = "Maia context compaction.";

/// First line of a summary note inserted into the transcript.
pub const RUNNING_SUMMARY_HEADER: &str = "Running summary\n";

const LABEL_CHARS: usize = 60;
const QUOTE_CHARS: usize = 80;
const TURN_CHARS: usize = 500;
const EXCERPT_CHARS: usize = 8_000;

/// Whether a tool step produced a result or a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    /// The tool returned a result.
    Completed,
    /// The tool failed or the call was refused.
    Failed,
}

/// One finished tool call or model reply, as the host observed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepObservation {
    /// Tool name. A bare model reply uses `(reply)`.
    pub tool: String,
    /// Raw tool arguments.
    pub arguments: String,
    /// Text the model will see for this step.
    pub output: String,
    /// Whether the step failed.
    pub status: StepStatus,
}

/// What the host should do after a detected loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoopSignal {
    /// Inject `note` into the next model call and show `activity`.
    Nudge {
        /// Stable id for this repeat.
        signature: String,
        /// Activity-feed line.
        activity: String,
        /// Note for the next model call.
        note: String,
    },
    /// Close this task and start a fresh one with the same goal.
    Handoff {
        /// Stable id for this repeat.
        signature: String,
        /// Activity-feed line.
        activity: String,
        /// Short description of the repeated work.
        what: String,
        /// Short quote from the repeated step.
        quote: String,
        /// How many fresh starts this goal has used, including this one.
        handoff_number: u32,
    },
    /// Stop after two fresh starts and tell the owner.
    Pause {
        /// Stable id for this repeat.
        signature: String,
        /// Activity-feed line.
        activity: String,
        /// Plain chat message for the owner.
        owner_message: String,
    },
}

/// Sliding window of recent steps and how many times each loop was nudged.
#[derive(Debug, Clone, Default)]
pub struct LoopTracker {
    window: VecDeque<Finger>,
    nudges: BTreeMap<String, u32>,
    handoffs: u32,
}

impl LoopTracker {
    /// A tracker that already used `count` fresh starts on this goal.
    #[must_use]
    pub fn with_handoffs(count: u32) -> Self {
        Self {
            handoffs: count,
            ..Self::default()
        }
    }

    /// How many fresh starts this goal has already used.
    #[must_use]
    pub const fn handoff_count(&self) -> u32 {
        self.handoffs
    }

    /// Records one step. `Some` when this step continues a loop.
    #[must_use]
    pub fn observe(&mut self, step: &StepObservation) -> Option<LoopSignal> {
        self.window.push_back(finger(step));
        while self.window.len() > LOOP_WINDOW {
            self.window.pop_front();
        }
        let hit = {
            let window = self.window.make_contiguous();
            detect(window)
        }?;
        self.raise(hit)
    }

    fn raise(&mut self, hit: Hit) -> Option<LoopSignal> {
        let seen = self.nudges.entry(hit.signature.clone()).or_insert(0);
        if *seen >= NUDGES_BEFORE_PAUSE {
            if self.handoffs >= HANDOFF_LIMIT {
                return Some(LoopSignal::Pause {
                    signature: hit.signature,
                    activity: format!(
                        "Stopped after two fresh starts: stuck on {} ({})",
                        hit.what, hit.quote
                    ),
                    owner_message: stopped_message(&hit.what, &hit.quote),
                });
            }
            return Some(LoopSignal::Handoff {
                signature: hit.signature,
                activity: format!("Handed off: stuck on {} ({})", hit.what, hit.quote),
                what: hit.what,
                quote: hit.quote,
                handoff_number: self.handoffs.saturating_add(1),
            });
        }
        *seen = seen.saturating_add(1);
        Some(LoopSignal::Nudge {
            signature: hit.signature,
            activity: hit.activity,
            note: hit.note,
        })
    }
}

/// Role of one transcript message used for compaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryRole {
    /// System instructions.
    System,
    /// Owner, recall, nudge, or summary text.
    User,
    /// Model text.
    Assistant,
    /// Tool result.
    Tool,
}

/// One transcript message reduced to the text compaction needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryTurn {
    /// Who wrote the message.
    pub role: HistoryRole,
    /// Message text.
    pub content: String,
}

/// Where to cut a transcript, plus the goal and the text to summarize.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorySplit {
    /// Messages before this index stay verbatim. This includes the goal.
    pub head_end: usize,
    /// Messages from this index to the end stay verbatim.
    pub tail_start: usize,
    /// Original goal, taken from the first user message in the head.
    pub goal: String,
    /// Older steps the model should summarize.
    pub excerpt: String,
}

/// Estimated tokens for `chars` of transcript text. Four characters is one token.
#[must_use]
pub fn estimate_tokens(chars: usize) -> u32 {
    u32::try_from(chars.div_ceil(4)).unwrap_or(u32::MAX)
}

/// Whether `tokens` is at least three quarters of `budget`.
#[must_use]
pub fn nears_context_budget(tokens: u32, budget: u32) -> bool {
    let threshold = budget.saturating_mul(CONTEXT_NEAR_NUMERATOR) / CONTEXT_NEAR_DENOMINATOR;
    threshold > 0 && tokens >= threshold
}

/// Splits a transcript when the middle contains tool work that can be summarized.
#[must_use]
pub fn split_for_compaction(turns: &[HistoryTurn], keep_tail: usize) -> Option<HistorySplit> {
    if keep_tail == 0 || turns.len() < 3 {
        return None;
    }
    let head_end = head_len(turns);
    let tail = keep_tail.min(turns.len().saturating_sub(head_end));
    if tail == 0 {
        return None;
    }
    let tail_start = turns.len() - tail;
    if tail_start <= head_end || !middle_has_work(turns, head_end, tail_start) {
        return None;
    }
    let excerpt = excerpt_text(turns, head_end, tail_start);
    if excerpt.is_empty() {
        return None;
    }
    Some(HistorySplit {
        head_end,
        tail_start,
        goal: goal_text(turns, head_end),
        excerpt,
    })
}

/// System and user text for one compaction model call.
#[must_use]
pub fn compaction_request_text(goal: &str, excerpt: &str) -> (String, String) {
    let system = format!(
        "{COMPACTION_PREFACE}\n\
Summarize the earlier steps. Keep the original goal, the decisions, the files touched, and the open TODOs. Keep the goal verbatim. Do not call tools."
    );
    let user = format!("Original goal:\n{goal}\n\nEarlier steps:\n{excerpt}");
    (system, user)
}

/// Summary note inserted between the goal and the recent raw steps.
#[must_use]
pub fn summary_note(model_reply: &str, goal: &str) -> String {
    let reply = model_reply.trim();
    let body = if reply.is_empty() {
        "Earlier steps were compacted."
    } else {
        reply
    };
    let mut note = format!("{RUNNING_SUMMARY_HEADER}{body}");
    if !goal.is_empty() && !note.contains(goal) {
        note.push_str("\nOriginal goal: ");
        note.push_str(goal);
    }
    note
}

/// Canonical JSON arguments, or collapsed whitespace when the text is not JSON.
#[must_use]
pub fn normalize_arguments(raw: &str) -> String {
    match serde_json::from_str::<Value>(raw) {
        Ok(value) => canonicalize(&value).to_string(),
        Err(_) => collapse_ws(raw),
    }
}

#[derive(Debug, Clone)]
struct Finger {
    call_key: String,
    state_key: String,
    output_hash: String,
    error_key: String,
    failed: bool,
    label: String,
    quote: String,
}

struct Hit {
    signature: String,
    activity: String,
    note: String,
    #[allow(dead_code)]
    owner_message: String,
    what: String,
    quote: String,
}

fn detect(window: &[Finger]) -> Option<Hit> {
    unfinished_replies(window)
        .or_else(|| same_failure(window))
        .or_else(|| same_call(window))
        .or_else(|| oscillation(window))
        .or_else(|| no_progress(window))
}

fn unfinished_replies(window: &[Finger]) -> Option<Hit> {
    let latest = window.last()?;
    if !is_bare_reply(latest) {
        return None;
    }
    let count = window
        .iter()
        .rev()
        .take_while(|step| is_bare_reply(step))
        .count();
    if count < SAME_STEP_REPEAT {
        return None;
    }
    let what = "unfinished replies";
    Some(Hit {
        signature: "unfinished:(reply)".to_owned(),
        activity: format!(
            "Noticed a loop: {count} replies in a row did not finish the task. Asked it to try something else."
        ),
        note: unfinished_note(&latest.quote),
        owner_message: stuck_message(what, &latest.quote),
        what: what.to_owned(),
        quote: latest.quote.clone(),
    })
}

fn is_bare_reply(step: &Finger) -> bool {
    step.call_key.starts_with("(reply):")
}

fn unfinished_note(quote: &str) -> String {
    format!(
        "You replied without finishing.\n\
Quote: \"{quote}\"\n\
Stop writing another plan. Call a tool, or call success, failure, or waiting.\n\
Say in one line what you will try next."
    )
}

fn same_failure(window: &[Finger]) -> Option<Hit> {
    let latest = window.last()?;
    if !latest.failed {
        return None;
    }
    let command_count = window
        .iter()
        .filter(|step| step.failed && step.call_key == latest.call_key)
        .count();
    if command_count >= SAME_STEP_REPEAT {
        return Some(repeat_hit(
            latest,
            command_count,
            &format!("fail:{}", latest.call_key),
            "with the same error",
        ));
    }
    let error_count = window
        .iter()
        .filter(|step| step.failed && step.error_key == latest.error_key)
        .count();
    if error_count >= SAME_STEP_REPEAT {
        return Some(repeat_hit(
            latest,
            error_count,
            &format!("error:{}", latest.error_key),
            "with the same error",
        ));
    }
    None
}

fn same_call(window: &[Finger]) -> Option<Hit> {
    let latest = window.last()?;
    let count = window
        .iter()
        .filter(|step| step.call_key == latest.call_key && step.output_hash == latest.output_hash)
        .count();
    if count < SAME_STEP_REPEAT {
        return None;
    }
    Some(repeat_hit(
        latest,
        count,
        &format!("call:{}:{}", latest.call_key, latest.output_hash),
        "with the same result",
    ))
}

fn oscillation(window: &[Finger]) -> Option<Hit> {
    cycle_hit(window, 2).or_else(|| cycle_hit(window, 3))
}

fn cycle_hit(window: &[Finger], period: usize) -> Option<Hit> {
    let need = period.saturating_mul(2);
    if period < 2 || window.len() < need {
        return None;
    }
    let start = window.len() - need;
    let slice = window.get(start..)?;
    for index in 0..period {
        let earlier = slice.get(index)?;
        let later = slice.get(index + period)?;
        if earlier.state_key != later.state_key {
            return None;
        }
    }
    let mut seen = BTreeSet::new();
    for index in 0..period {
        let key = slice.get(index)?.state_key.as_str();
        if !seen.insert(key) {
            return None;
        }
    }
    let labels = (0..period)
        .filter_map(|index| slice.get(index).map(|step| step.label.as_str()))
        .collect::<Vec<_>>();
    let latest = slice.last()?;
    let between = match labels.as_slice() {
        [left, right] => format!("`{left}` and `{right}`"),
        [left, mid, right] => format!("`{left}`, `{mid}`, and `{right}`"),
        _ => return None,
    };
    let what = format!("alternating between {between}");
    let signature = labels_signature(slice, period);
    Some(Hit {
        signature,
        activity: format!(
            "Noticed a loop: alternated between {between} with the same results. Asked it to try something else."
        ),
        note: nudge_note(&what, &latest.quote),
        owner_message: stuck_message(&what, &latest.quote),
        what,
        quote: latest.quote.clone(),
    })
}

fn labels_signature(slice: &[Finger], period: usize) -> String {
    let mut joined = String::new();
    for index in 0..period {
        if let Some(step) = slice.get(index) {
            if !joined.is_empty() {
                joined.push('|');
            }
            joined.push_str(&step.state_key);
        }
    }
    format!("osc:{joined}")
}

fn no_progress(window: &[Finger]) -> Option<Hit> {
    if window.len() < NO_PROGRESS_STREAK + 1 {
        return None;
    }
    let start = window.len() - NO_PROGRESS_STREAK;
    let mut earlier = BTreeSet::new();
    for step in window.iter().take(start) {
        earlier.insert(step.output_hash.as_str());
    }
    if earlier.is_empty() {
        return None;
    }
    let streak = window.get(start..)?;
    if !streak
        .iter()
        .all(|step| earlier.contains(step.output_hash.as_str()))
    {
        return None;
    }
    let latest = window.last()?;
    let mut joined = String::new();
    for step in streak {
        joined.push_str(&step.output_hash);
        joined.push('|');
    }
    let what = format!("the last {NO_PROGRESS_STREAK} steps");
    Some(Hit {
        signature: format!("progress:{}", digest(&joined)),
        activity: format!(
            "Noticed a loop: the last {NO_PROGRESS_STREAK} steps repeated earlier results. Asked it to try something else."
        ),
        note: nudge_note(&what, &latest.quote),
        owner_message: stuck_message(&what, &latest.quote),
        quote: latest.quote.clone(),
        what,
    })
}

fn repeat_hit(latest: &Finger, count: usize, signature: &str, kind: &str) -> Hit {
    let what = format!("the call `{}`", latest.label);
    Hit {
        signature: signature.to_owned(),
        activity: format!(
            "Noticed a loop: ran `{label}` {count} times {kind}. Asked it to try something else.",
            label = latest.label
        ),
        note: nudge_note(&what, &latest.quote),
        owner_message: stuck_message(&what, &latest.quote),
        quote: latest.quote.clone(),
        what,
    }
}

fn stopped_message(what: &str, quote: &str) -> String {
    format!(
        "This task is stuck on {what}. Quote: \"{quote}\". I started fresh twice and it got stuck the same way, so I stopped. Reply if you want a different approach, or press Stop."
    )
}

fn nudge_note(what: &str, quote: &str) -> String {
    format!(
        "You are repeating {what}.\n\
Quote: \"{quote}\"\n\
Stop repeating that. Try a different approach: another tool, another command, reading the error, narrowing the scope, or asking the owner.\n\
Say in one line what you will try next."
    )
}

fn stuck_message(what: &str, quote: &str) -> String {
    format!(
        "This task is stuck. It kept repeating {what}. Quote: \"{quote}\". I asked it to try something else {NUDGES_BEFORE_PAUSE} times. Reply to continue, or press Stop."
    )
}

fn finger(step: &StepObservation) -> Finger {
    let args = normalize_arguments(&step.arguments);
    let output_hash = digest(&step.output);
    let call_key = format!("{}:{}", step.tool, digest(&args));
    let state_key = format!("{call_key}:{output_hash}");
    let failed = matches!(step.status, StepStatus::Failed);
    let error_key = if failed {
        digest(&collapse_ws(&step.output))
    } else {
        String::new()
    };
    let label = step_label(&step.tool, &step.arguments);
    let quote_source = if step.output.trim().is_empty() {
        label.as_str()
    } else {
        step.output.as_str()
    };
    Finger {
        call_key,
        state_key,
        output_hash,
        error_key,
        failed,
        quote: quote_text(quote_source),
        label,
    }
}

fn step_label(tool: &str, arguments: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(arguments) {
        for key in ["command", "cmd", "path", "url", "file"] {
            if let Some(text) = value.get(key).and_then(Value::as_str) {
                let clipped = clip(&collapse_ws(text), LABEL_CHARS);
                if !clipped.is_empty() {
                    return clipped;
                }
            }
        }
    }
    let name = if tool.is_empty() { "(reply)" } else { tool };
    clip(&collapse_ws(name), LABEL_CHARS)
}

fn quote_text(text: &str) -> String {
    clip(&collapse_ws(text), QUOTE_CHARS).replace('"', "'")
}

fn head_len(turns: &[HistoryTurn]) -> usize {
    let mut index = 0;
    while turns
        .get(index)
        .is_some_and(|turn| matches!(turn.role, HistoryRole::System))
    {
        index += 1;
    }
    while turns.get(index).is_some_and(|turn| {
        matches!(turn.role, HistoryRole::User) && !turn.content.starts_with(RUNNING_SUMMARY_HEADER)
    }) {
        index += 1;
    }
    index
}

fn goal_text(turns: &[HistoryTurn], head_end: usize) -> String {
    turns
        .iter()
        .take(head_end)
        .find(|turn| matches!(turn.role, HistoryRole::User))
        .map(|turn| turn.content.clone())
        .unwrap_or_default()
}

fn middle_has_work(turns: &[HistoryTurn], head_end: usize, tail_start: usize) -> bool {
    turns
        .iter()
        .take(tail_start)
        .skip(head_end)
        .any(|turn| matches!(turn.role, HistoryRole::Assistant | HistoryRole::Tool))
}

fn excerpt_text(turns: &[HistoryTurn], start: usize, end: usize) -> String {
    let mut out = String::new();
    for turn in turns.iter().take(end).skip(start) {
        let line = format!(
            "[{}] {}",
            role_name(turn.role),
            clip(&collapse_ws(&turn.content), TURN_CHARS)
        );
        if !out.is_empty() && out.len().saturating_add(1).saturating_add(line.len()) > EXCERPT_CHARS
        {
            break;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&line);
    }
    out
}

fn role_name(role: HistoryRole) -> &'static str {
    match role {
        HistoryRole::System => "system",
        HistoryRole::User => "user",
        HistoryRole::Assistant => "assistant",
        HistoryRole::Tool => "tool",
    }
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                if let Some(child) = map.get(key) {
                    out.insert(key.clone(), canonicalize(child));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

fn collapse_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(text: &str, max: usize) -> String {
    let mut out = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index == max {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn digest(text: &str) -> String {
    let hashed = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(16);
    for byte in hashed.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
