//! Goal contract, working list, check-in, and handoff text.
//!
//! Every function here reads only its arguments.

use serde_json::Value;

/// First line of a goal-contract model call.
pub const GOAL_CONTRACT_PREFACE: &str = "Maia goal contract.";

/// First line of a check-in model call.
pub const REVIEW_PREFACE: &str = "Maia goal check-in.";

/// First line of a handoff-brief model call.
pub const HANDOFF_PREFACE: &str = "Maia handoff brief.";

/// Fresh starts allowed for one goal before the owner is told to decide.
pub const HANDOFF_LIMIT: u32 = 2;

/// Worker steps between check-ins.
pub const REVIEW_STEP_CADENCE: u32 = 12;

/// Task time between check-ins, in milliseconds.
pub const REVIEW_INTERVAL_MS: u64 = 5 * 60 * 1000;

/// What the owner asked for, kept on the task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalContract {
    /// Owner goal, verbatim.
    pub goal: String,
    /// Explicit requirements taken from that goal.
    pub requirements: Vec<String>,
    /// How the owner can tell the work is finished.
    pub done_criteria: Vec<String>,
}

/// State of one working-list item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoStatus {
    /// Not started.
    Pending,
    /// The worker may act on this item.
    InProgress,
    /// Finished.
    Done,
    /// Removed and not to be done.
    Dropped,
}

/// One line of the working plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItem {
    /// Stable id, such as `todo-1`.
    pub id: String,
    /// What to do.
    pub text: String,
    /// Current state.
    pub status: TodoStatus,
    /// One-line result once done or dropped.
    pub note: String,
    /// Added after the first list, as an obvious improvement.
    pub added: bool,
    /// Why it was added.
    pub reason: String,
}

/// A change the worker wants that is not on the list yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    /// Stable id.
    pub id: String,
    /// Proposed work.
    pub text: String,
    /// Why it would help.
    pub why: String,
}

/// The working plan stored on the task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoList {
    /// Items the worker may do.
    pub items: Vec<TodoItem>,
    /// Proposals waiting for a yes or no.
    pub proposed: Vec<Proposal>,
    /// Texts the owner declined. Do not ask again.
    pub rejected: Vec<String>,
}

/// Whether a proposed step is part of a solid result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdditionClass {
    /// Tests, matching style, basic error handling, or a bug in the same files.
    Obvious,
    /// A new feature, design change, or anything the owner did not ask for.
    Ask,
}

/// What `propose_addition` did with one suggestion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Addition {
    /// The item is on the list and in progress.
    Added(TodoItem),
    /// The owner was asked. The item is not on the list.
    Asked(String),
    /// The owner already declined this, or it is already listed.
    Skipped,
}

/// One check-in from the reviewer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewVerdict {
    /// The recent work still serves the goal.
    pub on_track: bool,
    /// Rough percent toward the done criteria.
    pub progress_toward_done: u8,
    /// Work that is not on the list and not an obvious improvement.
    pub scope_creep: Vec<String>,
    /// The reviewer thinks the task is stuck.
    pub stuck: bool,
    /// Short instruction for the next worker call.
    pub correction: String,
}

/// What the host does with a verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewEffect {
    /// Quiet activity line. The worker is not corrected.
    Quiet {
        /// Activity text.
        activity: String,
    },
    /// Inject `correction` into the next model call.
    Steer {
        /// Activity text.
        activity: String,
        /// Instruction for the worker.
        correction: String,
    },
    /// Hand the task off, carrying `notes`.
    Handoff {
        /// Reviewer notes for the brief.
        notes: String,
    },
}

/// Facts the next task needs from the one that got stuck.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffNotes {
    /// Original goal.
    pub goal: String,
    /// Finished items and their one-line results.
    pub done: Vec<(String, String)>,
    /// What the loop was.
    pub failed: String,
    /// Quote from the repeated step.
    pub quote: String,
    /// Items still to do.
    pub left: Vec<String>,
    /// Proposals the owner declined.
    pub rejected: Vec<String>,
}

/// Contract used when the model call fails or the JSON is unusable.
#[must_use]
pub fn deterministic_contract(goal: &str) -> GoalContract {
    let goal = goal.trim().to_owned();
    GoalContract {
        requirements: vec![goal.clone()],
        done_criteria: vec!["The owner's request is finished.".to_owned()],
        goal,
    }
}

/// Keeps the owner goal verbatim and fills requirements from model JSON.
#[must_use]
pub fn contract_from_model(goal: &str, model_json: &str) -> GoalContract {
    let mut contract = deterministic_contract(goal);
    let Ok(value) = serde_json::from_str::<Value>(model_json) else {
        return contract;
    };
    let requirements = string_list(value.get("requirements"));
    let done = string_list(value.get("done_criteria"));
    if !requirements.is_empty() {
        contract.requirements = requirements;
    }
    if !done.is_empty() {
        contract.done_criteria = done;
    }
    contract
}

/// One list item per done-criterion. The first item is in progress.
#[must_use]
pub fn list_from_contract(contract: &GoalContract) -> TodoList {
    let criteria = if contract.done_criteria.is_empty() {
        vec!["The owner's request is finished.".to_owned()]
    } else {
        contract.done_criteria.clone()
    };
    let items = criteria
        .into_iter()
        .enumerate()
        .map(|(index, text)| TodoItem {
            id: format!("todo-{}", index + 1),
            text,
            status: if index == 0 {
                TodoStatus::InProgress
            } else {
                TodoStatus::Pending
            },
            note: String::new(),
            added: false,
            reason: String::new(),
        })
        .collect();
    TodoList {
        items,
        proposed: Vec::new(),
        rejected: Vec::new(),
    }
}

/// System and user text for the goal-contract call.
#[must_use]
pub fn goal_prompt(goal: &str) -> (String, String) {
    let system = format!(
        "{GOAL_CONTRACT_PREFACE}\n\
Extract the owner's goal. Reply with one JSON object only: {{\"requirements\":[string],\"done_criteria\":[string]}}. \
Keep only what the owner asked. No extra fields."
    );
    (system, goal.to_owned())
}

/// System and user text for one check-in. The user text is the digest, not worker reasoning.
#[must_use]
pub fn review_prompt(contract: &GoalContract, digest: &str, plan: &str) -> (String, String) {
    let system = format!(
        "{REVIEW_PREFACE}\n\
You review a task. You do not see the worker's reasoning. Reply with one JSON object only: \
{{\"on_track\":bool,\"progress_toward_done\":number,\"scope_creep\":[string],\"stuck\":bool,\"correction\":string}}. \
Obvious quality work is on track. Unrequested work is scope creep. No extra fields."
    );
    let user = format!(
        "Goal:\n{}\n\nRequirements:\n{}\n\nDone when:\n{}\n\nPlan:\n{plan}\n\nRecent steps:\n{digest}",
        contract.goal,
        contract.requirements.join("\n"),
        contract.done_criteria.join("\n"),
    );
    (system, user)
}

/// Keeps the newest lines that fit in `max_chars`.
#[must_use]
pub fn bound_digest(lines: &[String], max_chars: usize) -> String {
    let mut kept = Vec::new();
    let mut size = 0_usize;
    for line in lines.iter().rev() {
        let next = line.len().saturating_add(1);
        if size.saturating_add(next) > max_chars && !kept.is_empty() {
            break;
        }
        kept.push(line.clone());
        size = size.saturating_add(next);
        if size >= max_chars {
            break;
        }
    }
    kept.reverse();
    kept.join("\n")
}

/// Parses a check-in. Unknown or missing fields are an error.
pub fn parse_review(raw: &str) -> Result<ReviewVerdict, String> {
    let value: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    let on_track = value
        .get("on_track")
        .and_then(Value::as_bool)
        .ok_or_else(|| "on_track missing".to_owned())?;
    let progress = value
        .get("progress_toward_done")
        .and_then(Value::as_u64)
        .ok_or_else(|| "progress missing".to_owned())?;
    let progress_toward_done = u8::try_from(progress.min(100)).unwrap_or(100);
    let scope_creep = string_list(value.get("scope_creep"));
    let stuck = value
        .get("stuck")
        .and_then(Value::as_bool)
        .ok_or_else(|| "stuck missing".to_owned())?;
    let correction = value
        .get("correction")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    Ok(ReviewVerdict {
        on_track,
        progress_toward_done,
        scope_creep,
        stuck,
        correction,
    })
}

/// Turns a verdict into a quiet note, a correction, or a handoff.
#[must_use]
pub fn effect_of(verdict: &ReviewVerdict) -> ReviewEffect {
    if verdict.stuck {
        return ReviewEffect::Handoff {
            notes: verdict.correction.clone(),
        };
    }
    let creep: Vec<&str> = verdict
        .scope_creep
        .iter()
        .map(String::as_str)
        .filter(|item| classify_addition(item) == AdditionClass::Ask)
        .collect();
    if !creep.is_empty() || (!verdict.on_track && !verdict.correction.is_empty()) {
        let correction = if verdict.correction.is_empty() {
            format!("Stop the extra work ({}). Finish the owner's goal.", creep.join(", "))
        } else {
            verdict.correction.clone()
        };
        let skipped = if creep.is_empty() {
            "the extra work".to_owned()
        } else {
            creep.join(", ")
        };
        return ReviewEffect::Steer {
            activity: format!("Check-in: steering back. Skipping {skipped}, not needed for the goal."),
            correction,
        };
    }
    ReviewEffect::Quiet {
        activity: format!(
            "Check-in: on track, ~{}% done",
            verdict.progress_toward_done
        ),
    }
}

/// A check-in is due on the step cadence, the time cadence, a loop, or a new sub-goal.
#[must_use]
pub fn review_is_due(steps_since_review: u32, elapsed_ms: u64, loop_fired: bool, new_subgoal: bool) -> bool {
    steps_since_review >= REVIEW_STEP_CADENCE
        || elapsed_ms >= REVIEW_INTERVAL_MS
        || loop_fired
        || new_subgoal
}

/// Obvious quality work versus something the owner should approve.
#[must_use]
pub fn classify_addition(text: &str) -> AdditionClass {
    let folded = text.to_lowercase();
    if folded.contains("test")
        || folded.contains("error handling")
        || folded.contains("style")
        || folded.contains("bug")
        || folded.contains("lint")
    {
        AdditionClass::Obvious
    } else {
        AdditionClass::Ask
    }
}

/// One question for the main chat. It names the item, why, the cost, and a recommendation.
#[must_use]
pub fn owner_question(item: &str, why: &str, recommend_yes: bool) -> String {
    let recommend = if recommend_yes { "yes" } else { "no" };
    format!(
        "May I add \"{item}\"? {why} That adds time and scope. I recommend {recommend}."
    )
}

/// Adds an obvious item, or records a proposal. Declined texts are not asked again.
pub fn propose_addition(list: &mut TodoList, text: &str, why: &str) -> Addition {
    let text = text.trim();
    if text.is_empty() {
        return Addition::Skipped;
    }
    if list.rejected.iter().any(|item| same_text(item, text))
        || list.items.iter().any(|item| same_text(&item.text, text))
        || list.proposed.iter().any(|item| same_text(&item.text, text))
    {
        return Addition::Skipped;
    }
    if classify_addition(text) == AdditionClass::Obvious {
        for item in &mut list.items {
            if item.status == TodoStatus::InProgress {
                item.status = TodoStatus::Pending;
            }
        }
        let added = TodoItem {
            id: format!("todo-{}", list.items.len() + 1),
            text: text.to_owned(),
            status: TodoStatus::InProgress,
            note: String::new(),
            added: true,
            reason: why.trim().to_owned(),
        };
        list.items.push(added.clone());
        return Addition::Added(added);
    }
    let proposal = Proposal {
        id: format!("proposal-{}", list.proposed.len() + 1),
        text: text.to_owned(),
        why: why.trim().to_owned(),
        };
    let question = owner_question(&proposal.text, &proposal.why, false);
    list.proposed.push(proposal);
    Addition::Asked(question)
}

/// `Some(true)` for yes, `Some(false)` for no, `None` when the reply is about something else.
#[must_use]
pub fn owner_decision(text: &str) -> Option<bool> {
    let folded = text.trim().to_lowercase();
    let token = folded.split_whitespace().next().unwrap_or("");
    if matches!(token, "yes" | "y" | "yeah" | "yep") || folded == "do it" || folded == "add it" {
        return Some(true);
    }
    if matches!(token, "no" | "n" | "nope") || folded == "don't" || folded == "do not" {
        return Some(false);
    }
    None
}

/// Applies a yes or no to the newest proposal.
pub fn answer_proposal(list: &mut TodoList, contract: &mut GoalContract, yes: bool) -> Option<String> {
    let proposal = list.proposed.pop()?;
    if yes {
        contract.requirements.push(proposal.text.clone());
        contract.done_criteria.push(proposal.text.clone());
        list.items.push(TodoItem {
            id: format!("todo-{}", list.items.len() + 1),
            text: proposal.text.clone(),
            status: TodoStatus::Pending,
            note: String::new(),
            added: true,
            reason: proposal.why,
        });
        return Some(proposal.text);
    }
    list.rejected.push(proposal.text);
    None
}

/// Allows terminal and list tools always. Other tools need an in-progress item.
#[must_use]
pub fn gate_tool(list: &TodoList, tool: &str) -> Result<(), String> {
    if matches!(
        tool,
        "success" | "failure" | "waiting" | "todo_add" | "todo_done" | "todo_start" | "ask_owner"
    ) {
        return Ok(());
    }
    let open = list
        .items
        .iter()
        .any(|item| item.status == TodoStatus::InProgress);
    if open {
        return Ok(());
    }
    Err(
        "Add that step to the list and mark it in progress before doing the work.".to_owned(),
    )
}

/// Marks an item done and returns whether it was on the list.
pub fn complete_item(list: &mut TodoList, id: &str, result: &str) -> bool {
    let Some(item) = list.items.iter_mut().find(|item| item.id == id) else {
        return false;
    };
    item.status = TodoStatus::Done;
    item.note = result.trim().to_owned();
    true
}

/// Marks an item in progress. Other in-progress items return to pending.
pub fn start_item(list: &mut TodoList, id: &str) -> bool {
    if !list.items.iter().any(|item| item.id == id) {
        return false;
    }
    for item in &mut list.items {
        if item.status == TodoStatus::InProgress {
            item.status = TodoStatus::Pending;
        }
        if item.id == id {
            item.status = TodoStatus::InProgress;
        }
    }
    true
}

/// Uses the model brief only when it still contains the goal and both sections.
#[must_use]
pub fn accept_model_brief(goal: &str, model_text: &str, notes: &HandoffNotes) -> String {
    let text = model_text.trim();
    let folded = text.to_lowercase();
    if !goal.is_empty()
        && text.contains(goal)
        && (folded.contains("done") && (folded.contains("left") || folded.contains("plan")))
    {
        return text.to_owned();
    }
    deterministic_brief(notes)
}

/// Brief used when the model call fails or omits the goal.
#[must_use]
pub fn deterministic_brief(notes: &HandoffNotes) -> String {
    let mut lines = vec![format!("Goal: {}", notes.goal), String::new(), "Done:".to_owned()];
    if notes.done.is_empty() {
        lines.push("- Nothing finished yet.".to_owned());
    } else {
        for (item, result) in &notes.done {
            lines.push(format!("- {item}: {result}"));
        }
    }
    lines.push(String::new());
    lines.push(format!(
        "Failed: {}. Do not repeat this approach. Quote: \"{}\"",
        notes.failed, notes.quote
    ));
    lines.push(String::new());
    lines.push("Left:".to_owned());
    if notes.left.is_empty() {
        lines.push("- Finish the owner's goal.".to_owned());
    } else {
        for item in &notes.left {
            lines.push(format!("- {item}"));
        }
    }
    if !notes.rejected.is_empty() {
        lines.push(String::new());
        lines.push("Do not add:".to_owned());
        for item in &notes.rejected {
            lines.push(format!("- {item}"));
        }
    }
    lines.join("\n")
}

/// System and user text for the handoff brief.
#[must_use]
pub fn handoff_prompt(notes: &HandoffNotes) -> (String, String) {
    let system = format!(
        "{HANDOFF_PREFACE}\n\
Write a handoff brief for a fresh task. Include the goal verbatim, what is done, what failed, \
and what is left. Say do not repeat the failed approach. No tools."
    );
    (system, deterministic_brief(notes))
}

/// Chat line when a stuck task starts a fresh one.
#[must_use]
pub fn handoff_chat_line(what: &str) -> String {
    format!("Task got stuck on {what}; started a fresh task to continue from here.")
}

/// The successor list keeps finished results, remaining work, and declined proposals.
#[must_use]
pub fn inherit_list(list: &TodoList) -> TodoList {
    let mut items = Vec::new();
    for item in &list.items {
        let mut copy = item.clone();
        if copy.status == TodoStatus::InProgress {
            copy.status = TodoStatus::Pending;
        }
        items.push(copy);
    }
    if let Some(next) = items.iter_mut().find(|item| item.status == TodoStatus::Pending) {
        next.status = TodoStatus::InProgress;
    }
    TodoList {
        items,
        proposed: Vec::new(),
        rejected: list.rejected.clone(),
    }
}

/// JSON for the goal contract.
#[must_use]
pub fn contract_json(contract: &GoalContract) -> String {
    serde_json::json!({
        "goal": contract.goal,
        "requirements": contract.requirements,
        "done_criteria": contract.done_criteria,
    })
    .to_string()
}

/// JSON for the working list.
#[must_use]
pub fn plan_json(list: &TodoList, handoff_count: u32, handoff_of: Option<&str>) -> String {
    serde_json::json!({
        "items": list.items.iter().map(item_json).collect::<Vec<_>>(),
        "proposed": list.proposed.iter().map(|item| serde_json::json!({
            "id": item.id,
            "text": item.text,
            "why": item.why,
        })).collect::<Vec<_>>(),
        "rejected": list.rejected,
        "handoff_count": handoff_count,
        "handoff_of": handoff_of,
    })
    .to_string()
}

/// Reads a stored contract and list. `None` when the JSON is unusable.
#[must_use]
pub fn parse_stored_plan(goal_json: &str, todo_json: &str) -> Option<(GoalContract, TodoList, u32, Option<String>)> {
    let goal: Value = serde_json::from_str(goal_json).ok()?;
    let todo: Value = serde_json::from_str(todo_json).ok()?;
    let contract = GoalContract {
        goal: goal.get("goal").and_then(Value::as_str)?.to_owned(),
        requirements: string_list(goal.get("requirements")),
        done_criteria: string_list(goal.get("done_criteria")),
    };
    let items = todo
        .get("items")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(parse_item)
        .collect();
    let proposed = todo
        .get("proposed")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(parse_proposal).collect())
        .unwrap_or_default();
    let rejected = string_list(todo.get("rejected"));
    let handoff_count = todo
        .get("handoff_count")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let handoff_of = todo
        .get("handoff_of")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some((
        contract,
        TodoList {
            items,
            proposed,
            rejected,
        },
        handoff_count,
        handoff_of,
    ))
}

fn item_json(item: &TodoItem) -> Value {
    serde_json::json!({
        "id": item.id,
        "text": item.text,
        "status": status_name(item.status),
        "note": item.note,
        "added": item.added,
        "reason": item.reason,
    })
}

fn status_name(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Pending => "pending",
        TodoStatus::InProgress => "in_progress",
        TodoStatus::Done => "done",
        TodoStatus::Dropped => "dropped",
    }
}

fn parse_status(value: &str) -> TodoStatus {
    match value {
        "in_progress" => TodoStatus::InProgress,
        "done" => TodoStatus::Done,
        "dropped" => TodoStatus::Dropped,
        _ => TodoStatus::Pending,
    }
}

fn parse_item(value: &Value) -> Option<TodoItem> {
    Some(TodoItem {
        id: value.get("id").and_then(Value::as_str)?.to_owned(),
        text: value.get("text").and_then(Value::as_str)?.to_owned(),
        status: parse_status(value.get("status").and_then(Value::as_str).unwrap_or("pending")),
        note: value.get("note").and_then(Value::as_str).unwrap_or("").to_owned(),
        added: value.get("added").and_then(Value::as_bool).unwrap_or(false),
        reason: value.get("reason").and_then(Value::as_str).unwrap_or("").to_owned(),
    })
}

fn parse_proposal(value: &Value) -> Option<Proposal> {
    Some(Proposal {
        id: value.get("id").and_then(Value::as_str)?.to_owned(),
        text: value.get("text").and_then(Value::as_str)?.to_owned(),
        why: value.get("why").and_then(Value::as_str).unwrap_or("").to_owned(),
    })
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn same_text(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}
