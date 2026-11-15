//! Autonomous manager contracts: wake plan, tools, restart budget. No model or store.

use maia_core::manager::DEFAULT_AUTONOMOUS_RETRY_BUDGET;
use maia_core::manager::DEFAULT_WAKE_INTERVAL_SECS;
use maia_core::manager::MAX_MODEL_CALLS_PER_WAKE;
use maia_core::manager::WakeAction;
use maia_core::manager::WakeSnapshot;
use maia_core::manager::WakeToolCall;
use maia_core::manager::enforce_restart_budget;
use maia_core::manager::interpret_wake_tools;
use maia_core::manager::plan_wake;
use maia_core::manager::restart_budget_exhausted;
use maia_core::manager::snapshot_fingerprint;

#[test]
fn restart_budget_is_exhausted_when_used_meets_cap() {
    assert!(!restart_budget_exhausted(0, DEFAULT_AUTONOMOUS_RETRY_BUDGET));
    assert!(!restart_budget_exhausted(2, DEFAULT_AUTONOMOUS_RETRY_BUDGET));
    assert!(restart_budget_exhausted(
        DEFAULT_AUTONOMOUS_RETRY_BUDGET,
        DEFAULT_AUTONOMOUS_RETRY_BUDGET
    ));
}

#[test]
fn silent_wake_when_fingerprint_unchanged() {
    let snap = WakeSnapshot {
        failed_task_ids: vec![],
        stuck_task_ids: vec![],
        waiting: vec![],
        running_count: 1,
        completed_unopened: 0,
        ..WakeSnapshot::default()
    };
    let fp = snapshot_fingerprint(&snap);
    let plan = plan_wake(
        1_000,
        700,
        DEFAULT_WAKE_INTERVAL_SECS,
        &fp,
        &snap,
        0,
        MAX_MODEL_CALLS_PER_WAKE,
    );
    assert!(matches!(
        plan,
        maia_core::manager::WakePlan::Silent | maia_core::manager::WakePlan::SkipModel
    ));
}

#[test]
fn wake_that_messages_the_user() {
    let outcomes = interpret_wake_tools(&[WakeToolCall {
        name: "message_user".to_owned(),
        message: "Release is blocked on your API key.".to_owned(),
    }]);
    assert_eq!(
        outcomes,
        vec![WakeAction::MessageUser {
            text: "Release is blocked on your API key.".to_owned()
        }]
    );
}

#[test]
fn wake_tool_ask_user_is_one_ceo_question() {
    let outcomes = interpret_wake_tools(&[WakeToolCall {
        name: "ask_user".to_owned(),
        message: "Need the OpenRouter API key to continue shipping.".to_owned(),
    }]);
    assert_eq!(
        outcomes,
        vec![WakeAction::AskUser {
            text: "Need the OpenRouter API key to continue shipping.".to_owned()
        }]
    );
}

#[test]
fn wake_owner_terminals_are_not_aliased_use_message_user_and_ask_user() {
    // Wake offers message_user / ask_user directly; success/waiting are owner-turn tools.
    let close = interpret_wake_tools(&[WakeToolCall {
        name: "success".to_owned(),
        message: "Shipped the release notes.".to_owned(),
    }]);
    assert_eq!(close, vec![WakeAction::Silent]);
    let ask = interpret_wake_tools(&[WakeToolCall {
        name: "waiting".to_owned(),
        message: "Need the vault password.".to_owned(),
    }]);
    assert_eq!(ask, vec![WakeAction::Silent]);
    let workerish = interpret_wake_tools(&[WakeToolCall {
        name: "bash".to_owned(),
        message: "ls".to_owned(),
    }]);
    assert_eq!(workerish, vec![WakeAction::Silent]);
}

#[test]
fn wake_spawn_task_hires_a_worker_without_chat_alias() {
    let outcomes = interpret_wake_tools(&[WakeToolCall {
        name: "spawn_task".to_owned(),
        message: "Rewrite the config and retry the deploy.".to_owned(),
    }]);
    assert_eq!(
        outcomes,
        vec![WakeAction::Spawn {
            guidance: "Rewrite the config and retry the deploy.".to_owned()
        }]
    );
}

#[test]
fn wake_tool_retry_becomes_recover() {
    let outcomes = interpret_wake_tools(&[WakeToolCall {
        name: "retry_task".to_owned(),
        message: "task-failed".to_owned(),
    }]);
    assert!(
        outcomes.iter().any(|action| matches!(
            action,
            WakeAction::Recover { task_id, .. } if task_id == "task-failed"
        )),
        "expected recover, got {outcomes:?}"
    );
}

#[test]
fn wake_recover_is_forced_to_ask_user_when_restart_budget_is_exhausted() {
    let gated = enforce_restart_budget(
        &[WakeAction::Recover {
            task_id: "task-failed".to_owned(),
            note: "try again".to_owned(),
        }],
        &[("task-failed".to_owned(), DEFAULT_AUTONOMOUS_RETRY_BUDGET)],
        DEFAULT_AUTONOMOUS_RETRY_BUDGET,
    );
    assert!(
        gated.iter().any(|action| matches!(
            action,
            WakeAction::AskUser { text } if text.contains("task-failed") && text.contains("restarts")
        )),
        "expected ask_user backstop, got {gated:?}"
    );
}

#[test]
fn wake_interval_default_is_five_minutes() {
    assert_eq!(DEFAULT_WAKE_INTERVAL_SECS, 300);
}

#[test]
fn failed_work_plans_a_model_call() {
    let snap = WakeSnapshot {
        failed_task_ids: vec!["task-failed".to_owned()],
        stuck_task_ids: vec![],
        waiting: vec![],
        running_count: 0,
        completed_unopened: 0,
        ..WakeSnapshot::default()
    };
    let plan = plan_wake(
        1_000,
        0,
        DEFAULT_WAKE_INTERVAL_SECS,
        "",
        &snap,
        0,
        MAX_MODEL_CALLS_PER_WAKE,
    );
    assert!(
        matches!(plan, maia_core::manager::WakePlan::RunModel { .. }),
        "expected RunModel, got {plan:?}"
    );
}

#[test]
fn completed_work_plans_a_model_call_for_close_out() {
    let snap = WakeSnapshot {
        failed_task_ids: vec![],
        stuck_task_ids: vec![],
        waiting: vec![],
        running_count: 0,
        completed_unopened: 1,
        ..WakeSnapshot::default()
    };
    let plan = plan_wake(
        1_000,
        0,
        DEFAULT_WAKE_INTERVAL_SECS,
        "",
        &snap,
        0,
        MAX_MODEL_CALLS_PER_WAKE,
    );
    assert!(
        matches!(plan, maia_core::manager::WakePlan::RunModel { ref reason } if reason.contains("close")),
        "expected RunModel for completed close-out, got {plan:?}"
    );
}

#[test]
fn wake_brief_requires_ask_user_when_a_worker_is_waiting() {
    use maia_core::manager::format_wake_brief;

    let snap = WakeSnapshot {
        waiting: vec![("task-wait".to_owned(), "Need the vault password".to_owned())],
        running_count: 0,
        completed_unopened: 0,
        ..WakeSnapshot::default()
    };
    let brief = format_wake_brief(&snap);
    assert!(
        brief.to_ascii_lowercase().contains("ask_user"),
        "waiting brief must require ask_user: {brief}"
    );
    assert!(
        brief.contains("waiting task-wait"),
        "brief must name the waiting worker: {brief}"
    );
}

#[test]
fn wake_brief_includes_per_worker_status_idle_output_and_error() {
    use maia_core::manager::WorkerBrief;
    use maia_core::manager::format_wake_brief;
    use maia_core::manager::truncate_brief;

    let long_out = "x".repeat(400);
    let snap = WakeSnapshot {
        failed_task_ids: vec!["task-1".to_owned()],
        running_count: 0,
        completed_unopened: 0,
        workers: vec![WorkerBrief {
            task_id: "task-1".to_owned(),
            title: "Fix missing config".to_owned(),
            status: "failed".to_owned(),
            secs_since_progress: Some(45),
            output_tail: long_out.clone(),
            last_error: "bash exited 1: missing config".to_owned(),
        }],
        ..WakeSnapshot::default()
    };
    let brief = format_wake_brief(&snap);
    assert!(brief.contains("Silent manager wake"));
    assert!(brief.contains("failed=task-1"));
    assert!(brief.contains("worker task-1"));
    assert!(brief.contains("status=failed"));
    assert!(brief.contains("idle=45s"));
    assert!(brief.contains("Fix missing config"));
    assert!(brief.contains("bash exited 1: missing config"));
    assert!(
        !brief.contains(&long_out),
        "output must be truncated"
    );
    assert!(brief.contains(&truncate_brief(&long_out, maia_core::manager::BRIEF_TAIL_CHARS)));
}

#[test]
fn worker_inspect_brief_matches_wake_worker_line() {
    use maia_core::manager::WorkerBrief;
    use maia_core::manager::format_worker_brief;

    let worker = WorkerBrief {
        task_id: "task-9".to_owned(),
        title: "Open vault".to_owned(),
        status: "waiting".to_owned(),
        secs_since_progress: Some(12),
        output_tail: "Need the vault password".to_owned(),
        last_error: String::new(),
    };
    let text = format_worker_brief(&worker);
    assert!(text.contains("task-9"));
    assert!(text.contains("status=waiting"));
    assert!(text.contains("idle=12s"));
    assert!(text.contains("Need the vault password"));
    assert!(text.contains("Open vault"));
}

#[test]
fn continue_task_wake_tool_keeps_guidance_in_recover_note() {
    let outcomes = interpret_wake_tools(&[WakeToolCall {
        name: "continue_task".to_owned(),
        message: "task-1\nCreate the missing config.toml then retry.".to_owned(),
    }]);
    assert!(
        outcomes.iter().any(|action| matches!(
            action,
            WakeAction::Recover { task_id, note }
                if task_id == "task-1"
                    && note.contains("Create the missing config.toml")
        )),
        "expected recover with guidance note, got {outcomes:?}"
    );
}

#[test]
fn fingerprint_ignores_worker_brief_detail() {
    use maia_core::manager::WorkerBrief;

    let base = WakeSnapshot {
        failed_task_ids: vec!["task-1".to_owned()],
        running_count: 0,
        completed_unopened: 0,
        ..WakeSnapshot::default()
    };
    let richer = WakeSnapshot {
        workers: vec![WorkerBrief {
            task_id: "task-1".to_owned(),
            title: "x".to_owned(),
            status: "failed".to_owned(),
            secs_since_progress: Some(1),
            output_tail: "new output".to_owned(),
            last_error: "err".to_owned(),
        }],
        ..base.clone()
    };
    assert_eq!(
        snapshot_fingerprint(&base),
        snapshot_fingerprint(&richer),
        "brief detail must not change wake fingerprint"
    );
}
