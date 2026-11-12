//! Durable facts stay. Status, task requests, and scratch text do not.

use maia_core::dream::ClaimJudgment;
use maia_core::dream::FactCategory;
use maia_core::dream::categorize;
use maia_core::dream::episode_record;
use maia_core::dream::extract_entities;
use maia_core::dream::judge_claim;
use maia_core::dream::near_duplicate;
use maia_core::dream::owner_visible_reply;
use maia_core::dream::should_skip_promotion;
use maia_core::dream::subject_name;
use maia_core::dream::supersedes;
use maia_core::dream::PromotionSkipReason;

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
    assert_eq!(categorize("The user's name is Garrett."), FactCategory::Person);
    assert_eq!(categorize("The user lives in Canby, Oregon."), FactCategory::Place);
    assert_eq!(
        categorize("The user has a folder located at F:\\Development\\Ideas."),
        FactCategory::Path
    );
    assert_eq!(subject_name("The user lives in Canby, Oregon."), "Owner");
    assert_eq!(subject_name("Garrett keeps notes in that folder."), "Owner");
    let names = extract_entities("Garrett uses Gamma at F:\\Development\\Ideas.");
    assert!(names.iter().any(|item| item.name == "Owner" && item.kind == "person"));
    assert!(names.iter().any(|item| item.name == "Gamma"));
    assert!(names.iter().any(|item| item.name.contains("F:\\Development\\Ideas")));
    assert!(!names.iter().any(|item| item.name.eq_ignore_ascii_case("garrett")));
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
