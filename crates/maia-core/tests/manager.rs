//! Autonomous manager contracts: wake plan, tools, restart budget. No model or store.

use maia_core::manager::DEFAULT_AUTONOMOUS_RETRY_BUDGET;
use maia_core::manager::DEFAULT_WAKE_INTERVAL_SECS;
use maia_core::manager::MAX_MODEL_CALLS_PER_WAKE;
use maia_core::manager::WakeAction;
use maia_core::manager::WakeSnapshot;
use maia_core::manager::WakeToolCall;
use maia_core::manager::enforce_ceo_moments;
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
fn wake_waiting_without_ask_user_is_forced_once_unless_already_in_chat() {
    let snap = WakeSnapshot {
        waiting: vec![("task-wait".to_owned(), "Need RUN43_CEO_SECRET from the vault".to_owned())],
        ..WakeSnapshot::default()
    };
    let forced = enforce_ceo_moments(&[WakeAction::Silent], &snap);
    assert!(
        forced.iter().any(|action| matches!(
            action,
            WakeAction::AskUser { text } if text.contains("RUN43_CEO_SECRET")
        )),
        "waiting without ask_user must force one ask: {forced:?}"
    );

    let chatter = WakeSnapshot {
        recent_ceo_lines: vec![
            "assistant: Waiting for the worker to call waiting with RUN43_CEO_SECRET.".to_owned(),
        ],
        ..snap.clone()
    };
    let still = enforce_ceo_moments(&[WakeAction::Silent], &chatter);
    assert!(
        still.iter().any(|action| matches!(action, WakeAction::AskUser { .. })),
        "status chatter must not suppress the real ask: {still:?}"
    );

    let already = WakeSnapshot {
        recent_ceo_lines: vec![
            "assistant: Need your decision for task-wait: Need RUN43_CEO_SECRET from the vault?".to_owned(),
        ],
        ..snap.clone()
    };
    let skipped = enforce_ceo_moments(&[WakeAction::Silent], &already);
    assert!(
        !skipped.iter().any(|action| matches!(action, WakeAction::AskUser { .. })),
        "must not duplicate an ask already in CEO chat: {skipped:?}"
    );
}

#[test]
fn looks_like_close_out_rejects_status_chatter() {
    assert!(maia_core::manager::looks_like_close_out(
        "Done — wrote DONE43 to the workspace file."
    ));
    assert!(!maia_core::manager::looks_like_close_out(
        "I've hired a worker to write DONE43. I'll notify you once it's complete."
    ));
    assert!(!maia_core::manager::looks_like_close_out(
        "Worker hired to write DONE43. On the next wake, I'll message_user with the close-out."
    ));
}

#[test]
fn finished_wake_keeps_spawn_for_verify_recover_and_does_not_force_done() {
    // A worker can finish "success" while the artifact fails the goal check.
    // Manager must be allowed to hire again; safety cap must not overwrite with Done.
    use maia_core::manager::WorkerBrief;

    let snap = WakeSnapshot {
        completed_unopened: 1,
        learned: vec![
            "missing-file: create the missing file then retry_task; do not invent contents"
                .to_owned(),
        ],
        workers: vec![WorkerBrief {
            task_id: "task-draft".to_owned(),
            title: "Write WRONG draft".to_owned(),
            status: "completed".to_owned(),
            secs_since_progress: Some(1),
            output_tail: "Wrote WRONG.".to_owned(),
            last_error: String::new(),
        }],
        ..WakeSnapshot::default()
    };
    let recovered = enforce_ceo_moments(
        &[WakeAction::Spawn {
            guidance: "Overwrite the file with the seven required prime lines, then success."
                .to_owned(),
        }],
        &snap,
    );
    assert!(
        recovered
            .iter()
            .any(|action| matches!(action, WakeAction::Spawn { .. })),
        "finished wake must keep spawn_task for verify/recover: {recovered:?}"
    );
    assert!(
        !recovered.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if text.starts_with("Done")
        )),
        "spawn_task on a finished wake defers Done for a real second hire: {recovered:?}"
    );

    let silent_close = enforce_ceo_moments(&[WakeAction::Silent], &snap);
    assert!(
        silent_close.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if text.starts_with("Done")
        )),
        "silent finished wake still forces one Done close-out: {silent_close:?}"
    );

    // continue/retry on a completed draft is a host no-op; must not block Done.
    let noop_recover = enforce_ceo_moments(
        &[WakeAction::Recover {
            task_id: "task-draft".to_owned(),
            note: "overwrite with primes".to_owned(),
        }],
        &snap,
    );
    assert!(
        noop_recover.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if text.starts_with("Done")
        )),
        "noop recover on a finished wake must still force Done: {noop_recover:?}"
    );

    let idle = WakeSnapshot {
        completed_unopened: 0,
        learned: snap.learned.clone(),
        ..WakeSnapshot::default()
    };
    let dropped = enforce_ceo_moments(
        &[WakeAction::Spawn {
            guidance: "Invent unrelated work from LEARNED alone.".to_owned(),
        }],
        &idle,
    );
    assert!(
        !dropped
            .iter()
            .any(|action| matches!(action, WakeAction::Spawn { .. })),
        "idle wake with no attention must still drop LEARNED-only spawn: {dropped:?}"
    );

    let with_failure = WakeSnapshot {
        failed_task_ids: vec!["task-fail".to_owned()],
        completed_unopened: 0,
        learned: snap.learned.clone(),
        ..WakeSnapshot::default()
    };
    let allowed = enforce_ceo_moments(
        &[WakeAction::Spawn {
            guidance: "Replace the failed worker with a clearer plan.".to_owned(),
        }],
        &with_failure,
    );
    assert!(
        allowed
            .iter()
            .any(|action| matches!(action, WakeAction::Spawn { .. })),
        "spawn_task remains allowed when ATTENTION has a failure: {allowed:?}"
    );
}

#[test]
fn forced_close_out_includes_title_when_outcome_omits_goal_marker() {
    use maia_core::manager::WorkerBrief;

    let snap = WakeSnapshot {
        completed_unopened: 1,
        workers: vec![WorkerBrief {
            task_id: "task-done".to_owned(),
            title: "Hire a worker to write exactly DONE46 into the file".to_owned(),
            status: "completed".to_owned(),
            secs_since_progress: Some(1),
            output_tail: "Wrote the workspace file.".to_owned(),
            last_error: String::new(),
        }],
        ..WakeSnapshot::default()
    };
    let forced = enforce_ceo_moments(&[WakeAction::Silent], &snap);
    assert!(
        forced.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text }
                if text.starts_with("Done") && text.contains("DONE46")
        )),
        "forced close-out must keep the goal marker from the title when outcome omits it: {forced:?}"
    );
}

#[test]
fn wake_finished_without_close_out_is_forced_once_unless_already_in_chat() {
    use maia_core::manager::WorkerBrief;

    let snap = WakeSnapshot {
        completed_unopened: 1,
        workers: vec![WorkerBrief {
            task_id: "task-done".to_owned(),
            title: "Write DONE43".to_owned(),
            status: "completed".to_owned(),
            secs_since_progress: Some(1),
            output_tail: "Wrote DONE43 to the workspace file.".to_owned(),
            last_error: String::new(),
        }],
        ..WakeSnapshot::default()
    };
    let forced = enforce_ceo_moments(&[WakeAction::Silent], &snap);
    assert!(
        forced.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if text.contains("DONE43") && text.starts_with("Done")
        )),
        "finished goal without close-out must force one message_user: {forced:?}"
    );

    let chatter = enforce_ceo_moments(
        &[WakeAction::MessageUser {
            text: "I've hired a worker to write DONE43. I'll notify you once it's complete."
                .to_owned(),
        }],
        &snap,
    );
    assert!(
        chatter.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if text.starts_with("Done")
        )),
        "status message_user must not prevent the real close-out: {chatter:?}"
    );

    let already = WakeSnapshot {
        recent_ceo_lines: vec![
            "assistant: Done — wrote DONE43 to the workspace file.".to_owned(),
        ],
        ..snap.clone()
    };
    let skipped = enforce_ceo_moments(&[WakeAction::Silent], &already);
    assert!(
        !skipped.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if text.starts_with("Done")
        )),
        "must not duplicate a close-out already in CEO chat: {skipped:?}"
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
fn glanceable_task_title_keeps_first_line_head_for_tasks_rail() {
    use maia_core::manager::glanceable_task_title;
    use maia_core::manager::BRIEF_TITLE_CHARS;

    let multi = "Research newest workspace files\n1) List five files\n2) Write a brief";
    assert_eq!(
        glanceable_task_title(multi),
        "Research newest workspace files",
        "Tasks rail must show the first line, not the whole CEO brief"
    );

    let long = "A".repeat(BRIEF_TITLE_CHARS + 20);
    let clipped = glanceable_task_title(&long);
    assert!(
        clipped.chars().count() <= BRIEF_TITLE_CHARS,
        "title must fit the brief title budget: {clipped}"
    );
    assert!(
        clipped.starts_with('A'),
        "truncate the head for glanceability, not the tail: {clipped}"
    );
    assert_eq!(glanceable_task_title("  pin control  "), "pin control");
    assert_eq!(glanceable_task_title(""), "");
}

#[test]
fn frame_ceo_waiting_answer_marks_reply_as_finish_not_reask() {
    use maia_core::manager::frame_ceo_waiting_answer;
    use maia_core::manager::is_framed_ceo_waiting_answer;

    let framed = frame_ceo_waiting_answer("password is hunter2");
    assert!(
        is_framed_ceo_waiting_answer(&framed),
        "framed resume must be detectable: {framed}"
    );
    assert!(
        framed.contains("password is hunter2"),
        "CEO answer body must remain: {framed}"
    );
    assert!(
        framed.to_ascii_lowercase().contains("do not call waiting again"),
        "resume must tell the worker not to re-wait: {framed}"
    );
    assert!(
        framed.to_ascii_lowercase().contains("finish")
            || framed.to_ascii_lowercase().contains("success"),
        "resume must push finish/success: {framed}"
    );
    // Idempotent: already-framed text is not wrapped again.
    assert_eq!(frame_ceo_waiting_answer(&framed), framed);
}

#[test]
fn mute_nonessential_wake_messages_keeps_ask_and_close_out() {
    use maia_core::manager::filter_muted_wake_messages;

    let actions = vec![
        WakeAction::MessageUser {
            text: "Still working on the deploy.".to_owned(),
        },
        WakeAction::MessageUser {
            text: "Done — wrote the release notes.".to_owned(),
        },
        WakeAction::AskUser {
            text: "Need the vault password.".to_owned(),
        },
        WakeAction::Recover {
            task_id: "task-1".to_owned(),
            note: "retry".to_owned(),
        },
    ];
    let muted = filter_muted_wake_messages(&actions, true);
    assert!(
        !muted.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if text.contains("Still working")
        )),
        "status chatter must drop when mute is on: {muted:?}"
    );
    assert!(
        muted.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if text.starts_with("Done")
        )),
        "close-out must survive mute: {muted:?}"
    );
    assert!(
        muted
            .iter()
            .any(|action| matches!(action, WakeAction::AskUser { .. })),
        "ask_user must survive mute: {muted:?}"
    );
    assert!(
        muted
            .iter()
            .any(|action| matches!(action, WakeAction::Recover { .. })),
        "recover must survive mute: {muted:?}"
    );
    assert_eq!(filter_muted_wake_messages(&actions, false), actions);
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
        brief.contains("CEO_WAITING"),
        "waiting workers must be a plain CEO_WAITING section: {brief}"
    );
    assert!(
        brief.to_ascii_lowercase().contains("ask_user"),
        "waiting brief must require ask_user: {brief}"
    );
    assert!(
        brief.contains("task-wait") && brief.contains("Need the vault password"),
        "brief must name the waiting worker and question: {brief}"
    );
    assert!(
        !brief.to_ascii_lowercase().contains("stay silent unless"),
        "silence bias must not contradict a mandatory ask: {brief}"
    );
}

#[test]
fn wake_brief_lists_finished_goals_for_one_close_out() {
    use maia_core::manager::WorkerBrief;
    use maia_core::manager::format_wake_brief;

    let snap = WakeSnapshot {
        running_count: 0,
        completed_unopened: 1,
        workers: vec![WorkerBrief {
            task_id: "task-done".to_owned(),
            title: "Write DONE43".to_owned(),
            status: "completed".to_owned(),
            secs_since_progress: Some(2),
            output_tail: "Wrote DONE43 to the workspace file.".to_owned(),
            last_error: String::new(),
        }],
        ..WakeSnapshot::default()
    };
    let brief = format_wake_brief(&snap);
    assert!(
        brief.contains("FINISHED"),
        "finished goals must be a plain FINISHED section: {brief}"
    );
    assert!(
        brief.contains("task-done") && brief.contains("DONE43"),
        "finished section must name the goal result: {brief}"
    );
    assert!(
        brief.contains("outcome="),
        "finished lines must label the worker outcome for useful close-out text: {brief}"
    );
    assert!(
        brief.to_ascii_lowercase().contains("restate")
            || brief.to_ascii_lowercase().contains("what the worker"),
        "FINISHED header must tell the manager to restate the outcome: {brief}"
    );
    assert!(
        brief.to_ascii_lowercase().contains("message_user"),
        "finished brief must require message_user close-out: {brief}"
    );
    assert!(
        brief.contains("goal_state=needs_close_out"),
        "FINISHED lines must make the still-open goal state obvious: {brief}"
    );
    assert!(
        brief.to_ascii_lowercase().contains("status chatter")
            || brief.to_ascii_lowercase().contains("does not close"),
        "FINISHED brief must say prior status chatter does not close the goal: {brief}"
    );
}

#[test]
fn wake_brief_includes_recent_ceo_chat_so_model_can_skip_duplicates() {
    use maia_core::manager::format_wake_brief;

    let snap = WakeSnapshot {
        waiting: vec![("task-wait".to_owned(), "Need RUN43_CEO_SECRET".to_owned())],
        recent_ceo_lines: vec![
            "assistant: Need the vault secret RUN43_CEO_SECRET to continue.".to_owned(),
            "user: the secret is run43-ok".to_owned(),
        ],
        ..WakeSnapshot::default()
    };
    let brief = format_wake_brief(&snap);
    assert!(
        brief.contains("RECENT_CEO_CHAT"),
        "brief must surface recent CEO chat for dedup: {brief}"
    );
    assert!(
        brief.contains("RUN43_CEO_SECRET") && brief.contains("run43-ok"),
        "brief must include the prior ask and reply: {brief}"
    );
}

#[test]
fn fingerprint_ignores_recent_ceo_chat() {
    let base = WakeSnapshot {
        waiting: vec![("task-wait".to_owned(), "Need the vault password".to_owned())],
        ..WakeSnapshot::default()
    };
    let with_chat = WakeSnapshot {
        recent_ceo_lines: vec!["assistant: already asked".to_owned()],
        ..base.clone()
    };
    assert_eq!(
        snapshot_fingerprint(&base),
        snapshot_fingerprint(&with_chat),
        "CEO chat context must not change wake fingerprint"
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
    assert!(brief.contains("Manager wake"));
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

#[test]
fn wake_brief_orders_multi_goal_attention_and_leaves_healthy_alone() {
    use maia_core::manager::WorkerBrief;
    use maia_core::manager::format_wake_brief;

    let snap = WakeSnapshot {
        failed_task_ids: vec!["task-fail".to_owned()],
        waiting: vec![(
            "task-wait".to_owned(),
            "Need RUN44_CEO_SECRET from the CEO".to_owned(),
        )],
        running_count: 1,
        completed_unopened: 1,
        workers: vec![
            WorkerBrief {
                task_id: "task-run".to_owned(),
                title: "Healthy copy".to_owned(),
                status: "running".to_owned(),
                secs_since_progress: Some(3),
                output_tail: "still writing".to_owned(),
                last_error: String::new(),
            },
            WorkerBrief {
                task_id: "task-fail".to_owned(),
                title: "Missing file".to_owned(),
                status: "failed".to_owned(),
                secs_since_progress: Some(20),
                output_tail: String::new(),
                last_error: "bash exited 1: missing".to_owned(),
            },
            WorkerBrief {
                task_id: "task-wait".to_owned(),
                title: "Need secret".to_owned(),
                status: "waiting".to_owned(),
                secs_since_progress: Some(8),
                output_tail: "Need RUN44_CEO_SECRET from the CEO".to_owned(),
                last_error: String::new(),
            },
            WorkerBrief {
                task_id: "task-done".to_owned(),
                title: "Finished note".to_owned(),
                status: "completed".to_owned(),
                secs_since_progress: Some(1),
                output_tail: "Wrote DONE44".to_owned(),
                last_error: String::new(),
            },
        ],
        ..WakeSnapshot::default()
    };
    let brief = format_wake_brief(&snap);
    assert!(
        brief.contains("ATTENTION:"),
        "multi-goal brief must open an ATTENTION section: {brief}"
    );
    let fail_at = brief
        .find("retry/fix task-fail")
        .expect("ATTENTION must list failed work");
    let wait_at = brief
        .find("ask_user for task-wait")
        .expect("ATTENTION must list CEO waiting");
    let done_at = brief
        .find("close-out finished goals")
        .expect("ATTENTION must mention finished close-out");
    assert!(
        fail_at < wait_at && wait_at < done_at,
        "ATTENTION order must be failed → waiting → close-out: {brief}"
    );
    assert!(
        brief.contains("leave task-run alone (healthy)"),
        "ATTENTION must tell the model to leave the healthy runner alone: {brief}"
    );
    assert!(
        brief.contains("do not cross-talk"),
        "multi-goal brief must forbid cross-talk / duplicate CEO noise: {brief}"
    );
}

#[test]
fn wake_brief_surfaces_learned_notes_for_later_wakes() {
    use maia_core::manager::format_wake_brief;

    let snap = WakeSnapshot {
        failed_task_ids: vec!["task-1".to_owned()],
        learned: vec![
            "missing-file: create the file then retry_task".to_owned(),
            "do not invent vault secrets".to_owned(),
        ],
        ..WakeSnapshot::default()
    };
    let brief = format_wake_brief(&snap);
    assert!(
        brief.contains("LEARNED:"),
        "brief must surface LEARNED notes: {brief}"
    );
    assert!(
        brief.contains("missing-file: create the file then retry_task"),
        "brief must include prior learning: {brief}"
    );
    assert!(
        brief.to_ascii_lowercase().contains("different approach")
            || brief.to_ascii_lowercase().contains("do not repeat"),
        "LEARNED section must nudge a different approach: {brief}"
    );
    assert!(
        brief.to_ascii_lowercase().contains("never spawn_task from learned")
            || brief.to_ascii_lowercase().contains("not invent new work"),
        "LEARNED must forbid inventing work absent from ATTENTION: {brief}"
    );
}

#[test]
fn fingerprint_ignores_learned_notes() {
    let base = WakeSnapshot {
        failed_task_ids: vec!["task-1".to_owned()],
        ..WakeSnapshot::default()
    };
    let with_learned = WakeSnapshot {
        learned: vec!["tried cat missing file".to_owned()],
        ..base.clone()
    };
    assert_eq!(
        snapshot_fingerprint(&base),
        snapshot_fingerprint(&with_learned),
        "learned notes must not change wake fingerprint"
    );
}

#[test]
fn record_learning_wake_tool_emits_note_action() {
    let outcomes = interpret_wake_tools(&[WakeToolCall {
        name: "record_learning".to_owned(),
        message: "missing-file: create it then retry_task".to_owned(),
    }]);
    assert_eq!(
        outcomes,
        vec![WakeAction::RecordLearning {
            note: "missing-file: create it then retry_task".to_owned()
        }]
    );
}

#[test]
fn merge_learned_notes_dedups_and_caps() {
    use maia_core::manager::MAX_LEARNED_NOTES;
    use maia_core::manager::merge_learned_notes;

    let existing = vec!["old note".to_owned(), "keep me".to_owned()];
    let merged = merge_learned_notes(
        &existing,
        &["keep me".to_owned(), "new lesson".to_owned()],
    );
    assert_eq!(
        merged,
        vec![
            "old note".to_owned(),
            "keep me".to_owned(),
            "new lesson".to_owned()
        ]
    );
    let many: Vec<String> = (0..(MAX_LEARNED_NOTES + 3))
        .map(|i| format!("note-{i}"))
        .collect();
    let capped = merge_learned_notes(&[], &many);
    assert_eq!(capped.len(), MAX_LEARNED_NOTES);
    assert_eq!(capped.first().map(String::as_str), Some("note-3"));
    assert_eq!(
        capped.last().map(String::as_str),
        Some(&format!("note-{}", MAX_LEARNED_NOTES + 2)[..])
    );
}

#[test]
fn close_out_is_forced_while_a_healthy_runner_is_still_busy() {
    use maia_core::manager::WorkerBrief;
    use maia_core::manager::format_wake_brief;

    let snap = WakeSnapshot {
        running_count: 1,
        completed_unopened: 1,
        workers: vec![
            WorkerBrief {
                task_id: "task-run".to_owned(),
                title: "Healthy long copy".to_owned(),
                status: "running".to_owned(),
                secs_since_progress: Some(12),
                output_tail: "still writing".to_owned(),
                last_error: String::new(),
            },
            WorkerBrief {
                task_id: "task-done".to_owned(),
                title: "Write DONE45".to_owned(),
                status: "completed".to_owned(),
                secs_since_progress: Some(1),
                output_tail: "Wrote DONE45".to_owned(),
                last_error: String::new(),
            },
        ],
        ..WakeSnapshot::default()
    };
    let brief = format_wake_brief(&snap);
    assert!(
        brief.contains("verify") && brief.contains("Done"),
        "FINISHED brief must say verify before Done: {brief}"
    );
    assert!(
        brief.contains("REQUIRED:") && brief.contains("finished goal"),
        "healthy runners must not defer close-out REQUIRED: {brief}"
    );
    let forced = enforce_ceo_moments(&[WakeAction::Silent], &snap);
    assert!(
        forced.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if text.contains("DONE45") && text.starts_with("Done")
        )),
        "safety cap must close out finished work while a healthy runner is busy: {forced:?}"
    );
}

#[test]
fn ceo_safety_cap_still_asks_when_model_only_retries_failed_among_multi_goals() {
    use maia_core::manager::WorkerBrief;

    let snap = WakeSnapshot {
        failed_task_ids: vec!["task-fail".to_owned()],
        waiting: vec![(
            "task-wait".to_owned(),
            "Need RUN44_CEO_SECRET from the CEO".to_owned(),
        )],
        running_count: 1,
        completed_unopened: 1,
        workers: vec![WorkerBrief {
            task_id: "task-done".to_owned(),
            title: "Done".to_owned(),
            status: "completed".to_owned(),
            secs_since_progress: Some(1),
            output_tail: "DONE44".to_owned(),
            last_error: String::new(),
        }],
        ..WakeSnapshot::default()
    };
    let forced = enforce_ceo_moments(
        &[WakeAction::Recover {
            task_id: "task-fail".to_owned(),
            note: "create missing file then retry".to_owned(),
        }],
        &snap,
    );
    assert!(
        forced.iter().any(|action| matches!(
            action,
            WakeAction::Recover { task_id, .. } if task_id == "task-fail"
        )),
        "recover must remain: {forced:?}"
    );
    assert!(
        forced.iter().any(|action| matches!(
            action,
            WakeAction::AskUser { text } if text.contains("RUN44_CEO_SECRET")
        )),
        "safety cap must still force one ask while other goals exist: {forced:?}"
    );
    assert!(
        !forced.iter().any(|action| matches!(
            action,
            WakeAction::MessageUser { text } if maia_core::manager::looks_like_close_out(text)
        )),
        "must not close out while failed/waiting still need attention: {forced:?}"
    );
}
