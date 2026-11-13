//! Durable facts stay. Status, task requests, and scratch text do not.

use maia_core::dream::ClaimJudgment;
use maia_core::dream::FactCategory;
use maia_core::dream::PromotionSkipReason;
use maia_core::dream::categorize;
use maia_core::dream::episode_record;
use maia_core::dream::extract_entities;
use maia_core::dream::judge_claim;
use maia_core::dream::near_duplicate;
use maia_core::dream::owner_visible_reply;
use maia_core::dream::should_skip_promotion;
use maia_core::dream::subject_name;
use maia_core::dream::supersedes;

#[test]
fn status_text_and_reasoning_are_rejected_and_durable_facts_are_kept() {
    for sentence in [
        "Handed this message to the running task.",
        "Dispatched as one new task: Canby OR.",
        "Owner wants the chat investigated.",
        "Maia asked a subagent to look into the folder.",
        "Hmm, wait — actually. Looking at the candidate list: task-1.",
    ] {
        assert_eq!(judge_claim(sentence), ClaimJudgment::Reject, "{sentence}");
    }
    for sentence in [
        "The user's name is Garrett.",
        "The user lives in Canby, Oregon.",
        "The user has a folder located at F:\\Development\\Ideas.",
        "The API token lives in the desktop keychain.",
        "Northwind pantry stores flour.",
        "The project is named Bob's Best Burgers.",
    ] {
        assert_eq!(judge_claim(sentence), ClaimJudgment::Keep, "{sentence}");
    }
}

#[test]
fn facts_get_a_category_and_the_owner_is_one_entity() {
    assert_eq!(
        categorize("The user's name is Garrett."),
        FactCategory::Person
    );
    assert_eq!(
        categorize("The user lives in Canby, Oregon."),
        FactCategory::Place
    );
    assert_eq!(
        categorize("The user has a folder located at F:\\Development\\Ideas."),
        FactCategory::Path
    );
    assert_eq!(subject_name("The user lives in Canby, Oregon."), "Owner");
    assert_eq!(subject_name("Garrett keeps notes in that folder."), "Owner");
    let names = extract_entities("Garrett uses Gamma at F:\\Development\\Ideas.");
    assert!(
        names
            .iter()
            .any(|item| item.name == "Owner" && item.kind == "person")
    );
    assert!(names.iter().any(|item| item.name == "Gamma"));
    assert!(
        names
            .iter()
            .any(|item| item.name.contains("F:\\Development\\Ideas"))
    );
    assert!(
        !names
            .iter()
            .any(|item| item.name.eq_ignore_ascii_case("garrett"))
    );
}

#[test]
fn a_moved_city_supersedes_the_old_one_and_duplicates_collapse() {
    let older = "The user lives in Canby, Oregon.";
    let newer = "The user lives in Oregon City.";
    assert!(supersedes(older, newer));
    assert!(near_duplicate(
        "The user's name is Garrett.",
        "the user's name is garrett."
    ));
    assert!(!near_duplicate(older, newer));
}

#[test]
fn a_changed_preference_supersedes_the_old_one_and_a_neighbor_fact_survives() {
    let older = "The owner prefers tea.";
    let newer = "The owner prefers coffee.";
    let neighbor = "The owner lives in Canby, Oregon.";
    assert!(supersedes(older, newer));
    assert!(!supersedes(older, neighbor));
    assert!(!supersedes(neighbor, newer));
    assert!(supersedes(
        "The user likes green tea.",
        "The user likes coffee."
    ));
    assert!(supersedes(
        "Garrett's phone is a Pixel.",
        "Garrett's phone is an iPhone."
    ));
    assert!(supersedes(
        "The owner always saves work before quitting.",
        "The owner never saves work before quitting."
    ));
}

#[test]
fn city_and_state_is_a_place_named_for_the_city() {
    for sentence in [
        "The user lives in Canby, Oregon.",
        "The user lives in Canby Oregon.",
        "Notes mention Austin, Texas.",
    ] {
        let names = extract_entities(sentence);
        assert!(
            names.iter().any(|item| {
                (item.name == "Canby" || item.name == "Austin") && item.kind == "place"
            }),
            "{sentence} -> {names:?}"
        );
        assert!(
            !names
                .iter()
                .any(|item| item.kind == "person" && item.name.to_lowercase().contains("canby")),
            "{sentence} -> {names:?}"
        );
        assert!(
            !names
                .iter()
                .any(|item| item.kind == "person" && item.name.to_lowercase().contains("austin")),
            "{sentence} -> {names:?}"
        );
    }
    let people = extract_entities("Notes mention Ada Lovelace.");
    assert!(
        people
            .iter()
            .any(|item| item.name == "Ada Lovelace" && item.kind == "person"),
        "{people:?}"
    );
}

#[test]
fn user_and_owner_name_facts_are_one_fact() {
    assert!(near_duplicate(
        "The owner's name is Garrett.",
        "The owner's name is Garrett."
    ));
    assert!(near_duplicate(
        "The owner's name is Garrett.",
        "The user's name is Garrett."
    ));
    assert!(near_duplicate(
        "The user's name is Garrett",
        "The owner's name is Garrett."
    ));
    assert!(!near_duplicate(
        "The user's name is Garrett.",
        "The user lives in Canby, Oregon."
    ));
}

#[test]
fn episodes_keep_the_owner_fact_and_drop_status_and_scratch() {
    let (body, hide) = episode_record(
        "The user's name is Garrett.",
        "Handed this message to the running task.",
    );
    assert!(hide.is_none(), "{hide:?}");
    assert!(body.contains("Garrett"));
    assert!(!body.contains("Handed this message"));

    let (status, hidden) = episode_record("hello", "Dispatched as one new task: notes.");
    assert_eq!(hidden, Some("status"));
    assert!(!status.contains("Looking at"));

    let visible = owner_visible_reply(
        "Hmm, wait — actually. Looking at the candidate list: task-1.\n\nThe weather is 54 F.",
    );
    assert_eq!(visible, "The weather is 54 F.");
    assert!(owner_visible_reply("Hmm, looking at the candidate list: task-1.").is_empty());
    assert_eq!(
        should_skip_promotion("Handed this message to the running task."),
        Some(PromotionSkipReason::Status)
    );
}

#[test]
fn extraction_waits_for_the_turn_or_task_to_finish() {
    use maia_core::dream::{
        ExtractionTiming, episode_record, join_owner_messages, should_enqueue_extraction,
    };

    assert!(!should_enqueue_extraction(ExtractionTiming::TaskRunning));
    assert!(should_enqueue_extraction(ExtractionTiming::ChatReplyStored));
    assert!(should_enqueue_extraction(ExtractionTiming::TaskFinished));

    let (body, hide) = episode_record(
        "I prefer coffee for the slice2 check.",
        "Got it — you prefer coffee for the slice2 check.",
    );
    assert!(hide.is_none(), "{hide:?}");
    assert!(body.contains("Owner:"));
    assert!(body.contains("Maia:"));

    let joined = join_owner_messages(&[
        "I prefer coffee for the slice2 check.",
        "Also keep the mug warm.",
    ]);
    assert_eq!(
        joined,
        "I prefer coffee for the slice2 check.\nAlso keep the mug warm."
    );
    let (task_body, task_hide) = episode_record(
        &joined,
        "The subagent finished: coffee preference saved.",
    );
    assert!(task_hide.is_none(), "{task_hide:?}");
    assert!(task_body.contains("Also keep the mug warm."));
    assert!(task_body.contains("coffee preference saved"));
}
