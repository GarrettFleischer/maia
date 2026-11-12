//! Goal contract, working list, check-in, and stuck-task handoff.
//!
//! The model calls are made here. The decisions are pure functions in `maia-core`.

use std::time::Instant;

use maia_core::router::NormalizedToolCall;
use maia_core::router::Router;
use maia_core::router::RouterResponse;
use maia_core::super_agent::CommandId;
use maia_core::super_agent::HostCommand;
use maia_core::super_agent::MessageId;
use maia_core::super_agent::TaskId;
use maia_core::task_loop::Addition;
use maia_core::task_loop::GoalContract;
use maia_core::task_loop::HandoffNotes;
use maia_core::task_loop::ReviewEffect;
use maia_core::task_loop::TodoList;
use maia_core::task_loop::TodoStatus;
use maia_core::task_loop::accept_model_brief;
use maia_core::task_loop::answer_proposal;
use maia_core::task_loop::bound_digest;
use maia_core::task_loop::complete_item;
use maia_core::task_loop::contract_from_model;
use maia_core::task_loop::contract_json;
use maia_core::task_loop::deterministic_contract;
use maia_core::task_loop::effect_of;
use maia_core::task_loop::gate_tool;
use maia_core::task_loop::goal_prompt;
use maia_core::task_loop::handoff_chat_line;
use maia_core::task_loop::handoff_prompt;
use maia_core::task_loop::inherit_list;
use maia_core::task_loop::list_from_contract;
use maia_core::task_loop::owner_decision;
use maia_core::task_loop::parse_review;
use maia_core::task_loop::parse_stored_plan;
use maia_core::task_loop::plan_json;
use maia_core::task_loop::propose_addition;
use maia_core::task_loop::review_is_due;
use maia_core::task_loop::review_prompt;
use maia_core::task_loop::start_item;
use maia_core::task_loop::StepObservation;
use maia_core::task_loop::StepStatus;
use maia_core::thread_cache::ChatMessage;
use maia_core::thread_cache::ChatRole;

use super::Orchestrator;
use super::OwnerNotice;
use super::WorkerDrive;
use super::WorkerFinish;
use super::WorkerMachine;
use super::parent_work_request;
use super::push_tool_exchange;
use super::wait_router;

/// One line per list item, for the worker prompt and the owner.
pub(super) fn list_lines(list: &TodoList) -> String {
    if list.items.is_empty() {
        return "The list is empty.".to_owned();
    }
    list.items
        .iter()
        .map(|item| {
            let mark = match item.status {
                TodoStatus::Pending => "pending",
                TodoStatus::InProgress => "in progress",
                TodoStatus::Done => "done",
                TodoStatus::Dropped => "dropped",
            };
            if item.note.is_empty() {
                format!("- {} {mark}: {}", item.id, item.text)
            } else {
                format!("- {} {mark}: {} ({})", item.id, item.text, item.note)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

impl<R: Router> Orchestrator<R> {
    pub(super) fn ensure_plan(&mut self, task: &TaskId, prompt: &str) -> (GoalContract, TodoList, u32) {
        if let Ok(Some((goal_json, todo_json, count, _))) = self.store.task_plan(&task.0)
            && let Some((contract, list, _, _)) = parse_stored_plan(&goal_json, &todo_json)
        {
            let handoffs = u32::try_from(count).unwrap_or(0);
            return (contract, list, handoffs);
        }
        let model = self.ask_model(&goal_prompt(prompt));
        let contract = model
            .map(|text| contract_from_model(prompt, &text))
            .unwrap_or_else(|_| deterministic_contract(prompt));
        let list = list_from_contract(&contract);
        self.save_plan(task, &contract, &list, 0, None);
        let first = list
            .items
            .first()
            .map(|item| item.text.clone())
            .unwrap_or_default();
        self.record_activity(format!("Plan: {first}"), Some(task));
        (contract, list, 0)
    }

    pub(super) fn maybe_review(&mut self, machine: &mut WorkerMachine) -> Option<WorkerDrive> {
        let elapsed = machine.review_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        if !review_is_due(
            machine.steps_since_review,
            elapsed,
            machine.review_now,
            machine.new_subgoal,
        ) {
            return None;
        }
        machine.steps_since_review = 0;
        machine.review_now = false;
        machine.new_subgoal = false;
        machine.review_at = Instant::now();
        let digest = bound_digest(&recent_lines(&machine.messages), 12_000);
        let (system, user) = review_prompt(&machine.contract, &digest, &list_lines(&machine.todos));
        let raw = if let Some(reviewer) = self.reviewer.as_mut() {
            reviewer(&user)
        } else {
            self.ask_model(&(system, user))
        };
        let verdict = match raw.and_then(|text| parse_review(&text)) {
            Ok(verdict) => verdict,
            Err(_) => {
                self.record_activity(
                    "Check-in could not be read. Continuing.",
                    Some(&machine.task.clone()),
                );
                return None;
            }
        };
        match effect_of(&verdict) {
            ReviewEffect::Quiet { activity } => {
                self.record_activity(activity, Some(&machine.task.clone()));
                None
            }
            ReviewEffect::Steer { activity, correction } => {
                self.record_activity(activity, Some(&machine.task.clone()));
                machine
                    .messages
                    .push(ChatMessage::text(ChatRole::User, correction));
                None
            }
            ReviewEffect::Handoff { notes } => {
                let what = if notes.is_empty() {
                    "the check-in".to_owned()
                } else {
                    notes
                };
                Some(self.hand_off(machine, &what, "check-in", machine.loops.handoff_count().saturating_add(1)))
            }
        }
    }

    pub(super) fn hand_off(
        &mut self,
        machine: &mut WorkerMachine,
        what: &str,
        quote: &str,
        handoff_number: u32,
    ) -> WorkerDrive {
        let task = machine.task.clone();
        let notice = machine.notice;
        let line = handoff_chat_line(what);
        if matches!(notice, OwnerNotice::Hold) {
            let _ = self.note_router(&line);
        }
        self.record_activity(line, Some(&task));
        let notes = notes_from(machine, what, quote);
        let model = self.ask_model(&handoff_prompt(&notes));
        let brief = model
            .map(|text| accept_model_brief(&notes.goal, &text, &notes))
            .unwrap_or_else(|_| accept_model_brief(&notes.goal, "", &notes));
        let message = match self.ids.pop_message() {
            Ok(id) => MessageId(id),
            Err(error) => {
                self.record_activity(format!("Handoff could not start: {error:?}"), Some(&task));
                return WorkerDrive::Done(self.pause_stuck(machine, &brief));
            }
        };
        if let Err(error) = self.insert_user_message(&message, &brief) {
            self.record_activity(format!("Handoff could not start: {error:?}"), Some(&task));
            return WorkerDrive::Done(self.pause_stuck(machine, &brief));
        }
        let successor = match self.create_parent(&message, &brief, Some(&task), "create_linked") {
            Ok(id) => id,
            Err(error) => {
                self.record_activity(format!("Handoff could not start: {error:?}"), Some(&task));
                return WorkerDrive::Done(self.pause_stuck(machine, &brief));
            }
        };
        let carried = inherit_list(&machine.todos);
        self.save_plan(&successor, &machine.contract, &carried, handoff_number, Some(task.0.clone()));
        if let Ok(command) = self.ids.next_command() {
            let command = CommandId(command);
            if self.ids.consume_command(command.0).is_ok() {
                let _ = self.apply_host_command(HostCommand::Cancel {
                    task: task.clone(),
                    command,
                });
            }
        }
        self.release_worker(&task);
        self.maybe_work(&successor, notice);
        WorkerDrive::Done(WorkerFinish::Skipped)
    }

    pub(super) fn host_plan_tool(
        &mut self,
        machine: &mut WorkerMachine,
        response: &RouterResponse,
        call: &NormalizedToolCall,
    ) -> Option<WorkerDrive> {
        let name = call.name.as_str();
        if !matches!(name, "todo_add" | "todo_done" | "todo_start" | "ask_owner") {
            if let Err(reminder) = gate_tool(&machine.todos, name) {
                push_tool_exchange(&mut machine.messages, response, call, &reminder);
                return Some(self.follow_loop(
                    machine,
                    StepObservation {
                        tool: name.to_owned(),
                        arguments: call.arguments_json.clone(),
                        output: reminder,
                        status: StepStatus::Failed,
                    },
                ));
            }
            return None;
        }
        let message = tool_message(&call.arguments_json);
        let output = match name {
            "todo_done" => {
                let id = message.split_whitespace().next().unwrap_or("todo-1");
                let result = message.split_once(' ').map(|(_, rest)| rest).unwrap_or("Done.");
                if complete_item(&mut machine.todos, id, result) {
                    format!("Checked off {id}. {result}")
                } else {
                    "That item is not on the list.".to_owned()
                }
            }
            "todo_start" => {
                machine.new_subgoal = true;
                if start_item(&mut machine.todos, message.trim()) {
                    format!("Started {}.", message.trim())
                } else {
                    "That item is not on the list.".to_owned()
                }
            }
            "todo_add" | "ask_owner" => self.add_or_ask(machine, &message),
            _ => String::new(),
        };
        self.save_plan(
            &machine.task.clone(),
            &machine.contract.clone(),
            &machine.todos.clone(),
            machine.loops.handoff_count(),
            None,
        );
        self.record_activity(output.clone(), Some(&machine.task.clone()));
        push_tool_exchange(&mut machine.messages, response, call, &output);
        Some(self.follow_loop(
            machine,
            StepObservation {
                tool: name.to_owned(),
                arguments: call.arguments_json.clone(),
                output,
                status: StepStatus::Completed,
            },
        ))
    }

    pub(super) fn apply_owner_answer(&mut self, text: &str) {
        let Some(yes) = owner_decision(text) else {
            return;
        };
        let tasks: Vec<TaskId> = self.phases.keys().cloned().collect();
        for task in tasks {
            let Ok(Some((goal_json, todo_json, count, handoff_of))) = self.store.task_plan(&task.0) else {
                continue;
            };
            let Some((mut contract, mut list, _, _)) = parse_stored_plan(&goal_json, &todo_json) else {
                continue;
            };
            if list.proposed.is_empty() {
                continue;
            }
            let _ = answer_proposal(&mut list, &mut contract, yes);
            let count = u32::try_from(count).unwrap_or(0);
            self.save_plan(&task, &contract, &list, count, handoff_of);
            let line = if yes {
                "Added the approved step to the plan.".to_owned()
            } else {
                "Dropped that proposal.".to_owned()
            };
            self.record_activity(line, Some(&task));
            return;
        }
    }

    fn add_or_ask(&mut self, machine: &mut WorkerMachine, message: &str) -> String {
        match propose_addition(&mut machine.todos, message, "the worker suggested it") {
            Addition::Added(item) => {
                machine.new_subgoal = true;
                format!("Added to the plan: {}. {}", item.text, item.reason)
            }
            Addition::Asked(question) => {
                if matches!(machine.notice, OwnerNotice::Hold) {
                    let _ = self.note_router(&question);
                }
                question
            }
            Addition::Skipped => "That step was already decided.".to_owned(),
        }
    }

    fn save_plan(
        &mut self,
        task: &TaskId,
        contract: &GoalContract,
        list: &TodoList,
        handoff_count: u32,
        handoff_of: Option<String>,
    ) {
        let _ = self.store.put_task_plan(
            task.0.clone(),
            contract_json(contract),
            plan_json(list, handoff_count, handoff_of.as_deref()),
            i64::from(handoff_count),
            handoff_of,
        );
    }

    fn ask_model(&mut self, prompt: &(String, String)) -> Result<String, String> {
        let request = parent_work_request(
            &self.turn,
            maia_core::audit::RequestId(0),
            vec![
                ChatMessage::text(ChatRole::System, prompt.0.clone()),
                ChatMessage::text(ChatRole::User, prompt.1.clone()),
            ],
            "[]".to_owned(),
        );
        let response = wait_router(self.router.complete(&request)).map_err(|_| "model call failed".to_owned())?;
        Ok(response.reply.unwrap_or_default())
    }
}

fn notes_from(machine: &WorkerMachine, what: &str, quote: &str) -> HandoffNotes {
    let mut done = Vec::new();
    let mut left = Vec::new();
    for item in &machine.todos.items {
        if item.status == TodoStatus::Done {
            done.push((item.text.clone(), item.note.clone()));
        } else if item.status != TodoStatus::Dropped {
            left.push(item.text.clone());
        }
    }
    HandoffNotes {
        goal: machine.contract.goal.clone(),
        done,
        failed: what.to_owned(),
        quote: quote.to_owned(),
        left,
        rejected: machine.todos.rejected.clone(),
    }
}

fn recent_lines(messages: &[ChatMessage]) -> Vec<String> {
    messages
        .iter()
        .rev()
        .take(24)
        .map(|message| message.content.clone())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn tool_message(arguments: &str) -> String {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("text"))
                .or_else(|| value.get("id"))
                .and_then(|item| item.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| arguments.to_owned())
}
