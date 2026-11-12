//! Goal contract, working list, check-in, and handoff text.

use maia_core::task_loop::Addition;
use maia_core::task_loop::AdditionClass;
use maia_core::task_loop::GoalContract;
use maia_core::task_loop::HandoffNotes;
use maia_core::task_loop::ReviewEffect;
use maia_core::task_loop::ReviewVerdict;
use maia_core::task_loop::TodoStatus;
use maia_core::task_loop::accept_model_brief;
use maia_core::task_loop::answer_proposal;
use maia_core::task_loop::classify_addition;
use maia_core::task_loop::contract_from_model;
use maia_core::task_loop::deterministic_brief;
use maia_core::task_loop::deterministic_contract;
use maia_core::task_loop::effect_of;
use maia_core::task_loop::gate_tool;
use maia_core::task_loop::inherit_list;
use maia_core::task_loop::list_from_contract;
use maia_core::task_loop::parse_review;
use maia_core::task_loop::parse_stored_plan;
use maia_core::task_loop::plan_json;
use maia_core::task_loop::contract_json;
use maia_core::task_loop::propose_addition;
use maia_core::task_loop::review_is_due;

fn contract() -> GoalContract {
    deterministic_contract("Build a simple dog house.")
}

#[test]
fn a_new_task_stores_the_goal_and_a_list_from_it() {
    let goal = "Build a simple dog house.";
    let parsed = contract_from_model(goal, "not json");
    assert_eq!(parsed.goal, goal);
    assert_eq!(parsed.requirements, vec![goal]);
    let list = list_from_contract(&parsed);
    assert_eq!(list.items.len(), 1);
    assert_eq!(list.items[0].status, TodoStatus::InProgress);
    let again = contract_from_model(
        goal,
        r#"{"requirements":["A simple dog house."],"done_criteria":["The dog house is built."]}"#,
    );
    assert_eq!(again.goal, goal);
    assert_eq!(again.done_criteria, vec!["The dog house is built."]);
}

#[test]
fn an_obvious_improvement_is_added_and_a_new_idea_is_only_asked() {
    let mut list = list_from_contract(&contract());
    assert_eq!(classify_addition("write tests for the parser"), AdditionClass::Obvious);
    let added = propose_addition(&mut list, "write tests for the parser", "needed for a solid result");
    assert!(matches!(added, Addition::Added(_)));
    assert!(list.items.iter().any(|item| item.added && item.text.contains("tests")));
    assert_eq!(
        list.items.iter().filter(|item| item.status == TodoStatus::InProgress).count(),
        1
    );

    let asked = propose_addition(&mut list, "light in the dog house", "it would look nicer");
    let Addition::Asked(question) = asked else {
        panic!("expected a question");
    };
    assert!(question.contains("light in the dog house"));
    assert!(question.contains("recommend no"));
    assert!(!list.items.iter().any(|item| item.text.contains("light")));
    assert_eq!(propose_addition(&mut list, "light in the dog house", "again"), Addition::Skipped);
}

#[test]
fn yes_adds_a_proposal_and_no_drops_it() {
    let mut list = list_from_contract(&contract());
    propose_addition(&mut list, "light in the dog house", "it would look nicer");
    let mut contract = contract();
    assert!(answer_proposal(&mut list, &mut contract, false).is_none());
    assert!(list.rejected.iter().any(|item| item.contains("light")));
    assert!(propose_addition(&mut list, "light in the dog house", "again") == Addition::Skipped);

    propose_addition(&mut list, "a generator", "power tools");
    let added = answer_proposal(&mut list, &mut contract, true).expect("added");
    assert!(added.contains("generator"));
    assert!(contract.requirements.iter().any(|item| item.contains("generator")));
    assert!(list.items.iter().any(|item| item.text.contains("generator")));
}

#[test]
fn a_tool_without_an_in_progress_item_is_refused() {
    let mut list = list_from_contract(&contract());
    assert!(gate_tool(&list, "web__scrape").is_ok());
    list.items[0].status = TodoStatus::Done;
    let error = gate_tool(&list, "web__scrape").expect_err("refused");
    assert!(error.contains("Add that step to the list"));
    assert!(gate_tool(&list, "success").is_ok());
    assert!(gate_tool(&list, "todo_add").is_ok());
}

#[test]
fn a_drifting_review_steers_and_an_on_track_review_stays_quiet() {
    let drift = ReviewVerdict {
        on_track: false,
        progress_toward_done: 20,
        scope_creep: vec!["light in the dog house".to_owned()],
        stuck: false,
        correction: "Stop building the generator. Finish the dog house.".to_owned(),
    };
    match effect_of(&drift) {
        ReviewEffect::Steer { correction, activity } => {
            assert!(correction.contains("dog house"));
            assert!(activity.contains("steering back"));
        }
        other => panic!("expected a correction, {other:?}"),
    }
    let quiet = ReviewVerdict {
        on_track: true,
        progress_toward_done: 60,
        scope_creep: vec!["write tests for the parser".to_owned()],
        stuck: false,
        correction: String::new(),
    };
    assert!(matches!(effect_of(&quiet), ReviewEffect::Quiet { .. }));
    assert!(parse_review("nope").is_err());
}

#[test]
fn review_is_due_on_the_cadence_and_on_a_loop() {
    assert!(!review_is_due(11, 1_000, false, false));
    assert!(review_is_due(12, 1_000, false, false));
    assert!(review_is_due(0, 1_000, true, false));
    assert!(review_is_due(0, 1_000, false, true));
}

#[test]
fn a_handoff_brief_keeps_the_goal_and_the_list_carries_over() {
    let notes = HandoffNotes {
        goal: "Build a simple dog house.".to_owned(),
        done: vec![("Cut the panels".to_owned(), "Four panels cut.".to_owned())],
        failed: "the call `web__scrape`".to_owned(),
        quote: "same page".to_owned(),
        left: vec!["Assemble the dog house.".to_owned()],
        rejected: vec!["light in the dog house".to_owned()],
    };
    let brief = accept_model_brief(&notes.goal, "A fresh start is ready.", &notes);
    assert!(brief.contains("Build a simple dog house."));
    assert!(brief.contains("Four panels cut."));
    assert!(brief.contains("Do not repeat"));
    assert!(brief.contains("Assemble the dog house."));
    assert!(brief.contains("do not add") || brief.contains("Do not add"));
    assert_eq!(deterministic_brief(&notes), brief);

    let mut list = list_from_contract(&contract());
    list.items[0].status = TodoStatus::Done;
    list.items[0].note = "Panels cut.".to_owned();
    list.rejected.push("light in the dog house".to_owned());
    let carried = inherit_list(&list);
    assert_eq!(carried.items[0].status, TodoStatus::Done);
    assert_eq!(carried.items[0].note, "Panels cut.");
    assert_eq!(carried.rejected, list.rejected);

    let stored = parse_stored_plan(&contract_json(&contract()), &plan_json(&carried, 1, Some("task-1")))
        .expect("plan");
    assert_eq!(stored.0.goal, "Build a simple dog house.");
    assert_eq!(stored.2, 1);
    assert_eq!(stored.3.as_deref(), Some("task-1"));
}
