//! Autonomous manager contracts. No model, clock, or store.

use maia_core::manager::BlockerClass;
use maia_core::manager::CeoNeed;
use maia_core::manager::DEFAULT_AUTONOMOUS_RETRY_BUDGET;
use maia_core::manager::DEFAULT_WAKE_INTERVAL_SECS;
use maia_core::manager::MAX_MODEL_CALLS_PER_WAKE;
use maia_core::manager::RecoveryAction;
use maia_core::manager::WakeAction;
use maia_core::manager::WakeSnapshot;
use maia_core::manager::WakeToolCall;
use maia_core::manager::classify_blocker_text;
use maia_core::manager::decide_recovery;
use maia_core::manager::format_ceo_question;
use maia_core::manager::interpret_wake_tools;
use maia_core::manager::plan_wake;
use maia_core::manager::snapshot_fingerprint;
use maia_core::manager::wake_actions_for_failures;

#[test]
fn failed_worker_is_retried_when_budget_remains() {
    let class = classify_blocker_text("bash exited 1: file not found");
    assert_eq!(class, BlockerClass::Autonomous);
    let action = decide_recovery(class, 0, DEFAULT_AUTONOMOUS_RETRY_BUDGET, "file not found");
    match action {
        RecoveryAction::RetryDifferentApproach { note } => {
            assert!(note.contains("different approach"));
            assert!(note.contains("file not found"));
        }
        other => panic!("expected retry, got {other:?}"),
    }
}

#[test]
fn escalation_after_retry_budget_runs_out() {
    let class = classify_blocker_text("still stuck after retries");
    let action = decide_recovery(
        class,
        DEFAULT_AUTONOMOUS_RETRY_BUDGET,
        DEFAULT_AUTONOMOUS_RETRY_BUDGET,
        "still stuck after retries",
    );
    match action {
        RecoveryAction::Escalate { question } => {
            assert!(question.contains("still stuck"));
            assert!(question.contains("What should I do"));
        }
        other => panic!("expected escalate, got {other:?}"),
    }
}

#[test]
fn credentials_and_money_need_the_ceo() {
    assert_eq!(
        classify_blocker_text("Need API key for OpenRouter"),
        BlockerClass::NeedsCeo {
            kind: CeoNeed::Credentials
        }
    );
    assert_eq!(
        classify_blocker_text("This will cost $20 to deploy"),
        BlockerClass::NeedsCeo {
            kind: CeoNeed::Money
        }
    );
    let action = decide_recovery(
        BlockerClass::NeedsCeo {
            kind: CeoNeed::Credentials,
        },
        0,
        DEFAULT_AUTONOMOUS_RETRY_BUDGET,
        "Need API key for OpenRouter",
    );
    match action {
        RecoveryAction::Escalate { question } => {
            assert!(question.contains("credentials") || question.contains("API key"));
        }
        other => panic!("expected escalate, got {other:?}"),
    }
}

#[test]
fn worker_question_is_routed_as_one_orchestrator_ceo_question() {
    let question = format_ceo_question(
        "Ship the release",
        "Should I delete the old staging database?",
        BlockerClass::NeedsCeo {
            kind: CeoNeed::Irreversible,
        },
    );
    assert!(question.contains("Ship the release"));
    assert!(question.contains("delete the old staging database"));
    assert!(question.contains("irreversible") || question.contains("cannot undo"));
    assert!(!question.contains("Needs you"));
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
fn wake_that_recovers_a_failed_worker() {
    let snap = WakeSnapshot {
        failed_task_ids: vec!["task-failed".to_owned()],
        stuck_task_ids: vec![],
        waiting: vec![],
        running_count: 0,
        completed_unopened: 0,
    };
    let actions = wake_actions_for_failures(&snap, &[("task-failed".to_owned(), 1)], 3);
    assert!(
        actions.iter().any(|action| matches!(
            action,
            WakeAction::Recover {
                task_id,
                ..
            } if task_id == "task-failed"
        )),
        "expected recover, got {actions:?}"
    );
}

#[test]
fn wake_interval_default_is_five_minutes() {
    assert_eq!(DEFAULT_WAKE_INTERVAL_SECS, 300);
}
