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
