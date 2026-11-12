//! Loop detection and compaction contracts. No model and no clock.

use maia_core::task_loop::COMPACTION_PREFACE;
use maia_core::task_loop::HistoryRole;
use maia_core::task_loop::HistoryTurn;
use maia_core::task_loop::LoopSignal;
use maia_core::task_loop::LoopTracker;
use maia_core::task_loop::SAME_STEP_REPEAT;
use maia_core::task_loop::StepObservation;
use maia_core::task_loop::StepStatus;
use maia_core::task_loop::compaction_request_text;
use maia_core::task_loop::estimate_tokens;
use maia_core::task_loop::nears_context_budget;
use maia_core::task_loop::normalize_arguments;
use maia_core::task_loop::split_for_compaction;
use maia_core::task_loop::summary_note;

fn step(tool: &str, arguments: &str, output: &str, status: StepStatus) -> StepObservation {
    StepObservation {
        tool: tool.to_owned(),
        arguments: arguments.to_owned(),
        output: output.to_owned(),
        status,
    }
}

fn done(tool: &str, arguments: &str, output: &str) -> StepObservation {
    step(tool, arguments, output, StepStatus::Completed)
}

fn failed(tool: &str, arguments: &str, output: &str) -> StepObservation {
    step(tool, arguments, output, StepStatus::Failed)
}

fn nudge_activity(signal: Option<LoopSignal>) -> Option<String> {
    match signal {
        Some(LoopSignal::Nudge { activity, note, .. }) => {
            assert!(note.contains("Say in one line what you will try next"));
            assert!(note.contains("another tool"));
            assert!(note.contains("reading the error"));
            Some(activity)
        }
        other => panic!("expected a nudge, got {other:?}"),
    }
}

#[test]
fn same_call_three_times_nudges_and_quotes_the_result() {
    let mut tracker = LoopTracker::default();
    let call = done("bash", r#"{"command":"Get-Content a.txt"}"#, "nope");
    assert!(tracker.observe(&call).is_none());
    assert!(tracker.observe(&call).is_none());
    let activity = nudge_activity(tracker.observe(&call)).expect("activity");
    assert_eq!(
        activity,
        "Noticed a loop: ran `Get-Content a.txt` 3 times with the same result. Asked it to try something else."
    );
}

#[test]
fn json_key_order_does_not_hide_a_repeated_call() {
    let mut tracker = LoopTracker::default();
    let left = done("bash", r#"{"b":"1","a":"2"}"#, "out");
    let right = done("bash", r#"{"a":"2","b":"1"}"#, "out");
    assert!(tracker.observe(&left).is_none());
    assert!(tracker.observe(&right).is_none());
    assert!(matches!(
        tracker.observe(&left),
        Some(LoopSignal::Nudge { .. })
    ));
    assert_eq!(
        normalize_arguments(r#"{"b":"1","a":"2"}"#),
        normalize_arguments(r#"{"a":"2","b":"1"}"#)
    );
}

#[test]
fn distinct_unfinished_replies_ask_for_a_different_approach() {
    let mut tracker = LoopTracker::default();
    assert!(
        tracker
            .observe(&done("(reply)", "", "I will look at the folder."))
            .is_none()
    );
    assert!(
        tracker
            .observe(&done("(reply)", "", "Still planning the chat stream."))
            .is_none()
    );
    match tracker.observe(&done("(reply)", "", "I stopped after many replies.")) {
        Some(LoopSignal::Nudge { activity, note, .. }) => {
            assert!(activity.contains("try something else"));
            assert!(activity.contains("did not finish"));
            assert!(!activity.contains("32"));
            assert!(note.contains("Call a tool"));
            assert!(note.contains("success, failure, or waiting"));
        }
        other => panic!("expected a nudge, got {other:?}"),
    }
}

#[test]
fn a_real_tool_call_breaks_an_unfinished_reply_streak() {
    let mut tracker = LoopTracker::default();
    assert!(tracker.observe(&done("(reply)", "", "one")).is_none());
    assert!(tracker.observe(&done("(reply)", "", "two")).is_none());
    assert!(
        tracker
            .observe(&done("bash", r#"{"command":"Get-ChildItem"}"#, "files",))
            .is_none()
    );
    assert!(tracker.observe(&done("(reply)", "", "three")).is_none());
    assert!(tracker.observe(&done("(reply)", "", "four")).is_none());
    assert!(matches!(
        tracker.observe(&done("(reply)", "", "five")),
        Some(LoopSignal::Nudge { .. })
    ));
}

#[test]
fn unfinished_replies_hand_off_without_a_fixed_step_cap() {
    let mut tracker = LoopTracker::default();
    let mut nudges = 0;
    let mut handed = false;
    let mut steps = 0;
    for index in 0..32 {
        steps += 1;
        let call = done("(reply)", "", &format!("still writing plan {index}"));
        match tracker.observe(&call) {
            Some(LoopSignal::Nudge { activity, .. }) => {
                assert!(activity.contains("try something else"));
                assert!(!activity.contains("32"));
                nudges += 1;
            }
            Some(LoopSignal::Handoff { handoff_number, .. }) => {
                assert_eq!(handoff_number, 1);
                handed = true;
                break;
            }
            Some(LoopSignal::Pause { .. }) => panic!("first stuck start should hand off"),
            None => {}
        }
    }
    assert!(handed);
    assert_eq!(nudges, 3);
    assert!(steps < 32);
}

#[test]
fn same_arguments_with_changing_output_do_not_nudge() {
    let mut tracker = LoopTracker::default();
    for index in 0..6 {
        let call = done(
            "web__scrape",
            r#"{"url":"https://example.com"}"#,
            &format!("body {index}"),
        );
        assert!(tracker.observe(&call).is_none());
    }
}

#[test]
fn distinct_calls_with_changing_outputs_do_not_nudge() {
    let mut tracker = LoopTracker::default();
    for index in 0..8 {
        let call = done(
            "web__scrape",
            &format!(r#"{{"url":"https://example.com/{index}"}}"#),
            &format!("body {index}"),
        );
        assert!(tracker.observe(&call).is_none());
    }
}

#[test]
fn the_same_failing_command_nudges() {
    let mut tracker = LoopTracker::default();
    let call = failed("bash", r#"{"command":"Get-Content missing"}"#, "not found");
    assert!(tracker.observe(&call).is_none());
    assert!(tracker.observe(&call).is_none());
    let activity = nudge_activity(tracker.observe(&call)).expect("activity");
    assert!(activity.contains("same error"));
    assert!(activity.contains("Get-Content missing"));
}

#[test]
fn alternation_without_new_output_is_a_loop() {
    let mut tracker = LoopTracker::default();
    let alpha = done("bash", r#"{"command":"Get-Content a"}"#, "alpha");
    let beta = done("bash", r#"{"command":"Get-Content b"}"#, "beta");
    assert!(tracker.observe(&alpha).is_none());
    assert!(tracker.observe(&beta).is_none());
    assert!(tracker.observe(&alpha).is_none());
    let activity = nudge_activity(tracker.observe(&beta)).expect("activity");
    assert!(activity.contains("alternated between"));
    assert!(activity.contains("Get-Content a"));
    assert!(activity.contains("Get-Content b"));
}

#[test]
fn alternation_with_a_new_output_is_not_a_loop() {
    let mut tracker = LoopTracker::default();
    assert!(
        tracker
            .observe(&done("bash", r#"{"command":"Get-Content a"}"#, "alpha"))
            .is_none()
    );
    assert!(
        tracker
            .observe(&done("bash", r#"{"command":"Get-Content b"}"#, "beta"))
            .is_none()
    );
    assert!(
        tracker
            .observe(&done(
                "bash",
                r#"{"command":"Get-Content a"}"#,
                "alpha changed"
            ))
            .is_none()
    );
    assert!(
        tracker
            .observe(&done("bash", r#"{"command":"Get-Content b"}"#, "beta"))
            .is_none()
    );
}

#[test]
fn repeated_earlier_outputs_from_new_commands_are_no_progress() {
    let mut tracker = LoopTracker::default();
    let outputs = ["one", "two", "one", "two", "one", "two"];
    let mut fired = None;
    for (index, output) in outputs.iter().enumerate() {
        let call = done("bash", &format!(r#"{{"command":"step {index}"}}"#), output);
        if let Some(signal) = tracker.observe(&call) {
            fired = Some(signal);
            break;
        }
    }
    let activity = nudge_activity(fired).expect("activity");
    assert!(activity.contains("repeated earlier results"));
}

#[test]
fn the_same_signature_hands_off_after_three_nudges() {
    let mut tracker = LoopTracker::default();
    let call = done("bash", r#"{"command":"Get-Content a.txt"}"#, "nope");
    let mut nudges = 0;
    let mut handed = false;
    for _ in 0..(SAME_STEP_REPEAT + 8) {
        match tracker.observe(&call) {
            Some(LoopSignal::Nudge { .. }) => nudges += 1,
            Some(LoopSignal::Handoff {
                what,
                quote,
                handoff_number,
                activity,
                ..
            }) => {
                assert!(what.contains("Get-Content"));
                assert!(!quote.is_empty());
                assert_eq!(handoff_number, 1);
                assert!(activity.contains("Handed off"));
                handed = true;
                break;
            }
            Some(LoopSignal::Pause { .. }) => panic!("first stuck start should hand off"),
            None => {}
        }
    }
    assert_eq!(nudges, 3);
    assert!(handed);
}

#[test]
fn a_second_fresh_start_hands_off_again_and_the_third_tells_the_owner() {
    let call = done("bash", r#"{"command":"Get-Content a.txt"}"#, "nope");
    let mut second = LoopTracker::with_handoffs(1);
    let mut second_handoff = None;
    for _ in 0..8 {
        if let Some(LoopSignal::Handoff { handoff_number, .. }) = second.observe(&call) {
            second_handoff = Some(handoff_number);
            break;
        }
    }
    assert_eq!(second_handoff, Some(2));

    let mut third = LoopTracker::with_handoffs(2);
    let mut owner = None;
    for _ in 0..8 {
        if let Some(LoopSignal::Pause {
            owner_message,
            activity,
            ..
        }) = third.observe(&call)
        {
            owner = Some((owner_message, activity));
            break;
        }
    }
    let (owner_message, activity) = owner.expect("owner report");
    assert!(owner_message.contains("started fresh twice"));
    assert!(owner_message.contains("stopped"));
    assert!(activity.contains("Stopped after two fresh starts"));
}

#[test]
fn token_estimate_and_budget_threshold() {
    assert_eq!(estimate_tokens(0), 0);
    assert_eq!(estimate_tokens(1), 1);
    assert_eq!(estimate_tokens(4), 1);
    assert_eq!(estimate_tokens(5), 2);
    assert!(!nears_context_budget(74, 100));
    assert!(nears_context_budget(75, 100));
}

#[test]
fn compaction_keeps_the_goal_and_summarizes_the_middle() {
    let turns = vec![
        HistoryTurn {
            role: HistoryRole::System,
            content: "contract".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::User,
            content: "GOAL-TOKEN-KEEP".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::Assistant,
            content: "read first".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::Tool,
            content: "FIRST-MARKER".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::Assistant,
            content: "read last".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::Tool,
            content: "FOURTH-MARKER".to_owned(),
        },
    ];
    let split = split_for_compaction(&turns, 2).expect("split");
    assert_eq!(split.goal, "GOAL-TOKEN-KEEP");
    assert_eq!(split.head_end, 2);
    assert!(split.excerpt.contains("FIRST-MARKER"));
    assert!(!split.excerpt.contains("FOURTH-MARKER"));
    let (system, user) = compaction_request_text(&split.goal, &split.excerpt);
    assert!(system.starts_with(COMPACTION_PREFACE));
    assert!(user.contains("GOAL-TOKEN-KEEP"));
    let note = summary_note("files touched: a.txt", &split.goal);
    assert!(note.contains("GOAL-TOKEN-KEEP"));
    assert!(note.contains("files touched: a.txt"));
    assert!(note.starts_with("Running summary"));
}

#[test]
fn a_running_summary_is_not_the_goal() {
    let turns = vec![
        HistoryTurn {
            role: HistoryRole::System,
            content: "contract".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::User,
            content: "GOAL-TOKEN-KEEP".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::User,
            content: "Running summary\nold notes".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::Assistant,
            content: "call".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::Tool,
            content: "old-step".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::Assistant,
            content: "again".to_owned(),
        },
        HistoryTurn {
            role: HistoryRole::Tool,
            content: "new-step".to_owned(),
        },
    ];
    let split = split_for_compaction(&turns, 2).expect("split");
    assert_eq!(split.goal, "GOAL-TOKEN-KEEP");
    assert!(split.excerpt.contains("old notes") || split.excerpt.contains("old-step"));
    assert!(!split.excerpt.contains("new-step"));
}
