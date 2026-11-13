//! Name facts collapse, and a city-state is stored as the city.

use std::fs;
use std::path::PathBuf;

use maia_store::AppendEvents;
use maia_store::BrainNodeKind;
use maia_store::EpisodeWrite;
use maia_store::MemoryTaint;
use maia_store::OwnerOpen;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionWrite;
use maia_store::SqliteOwner;
use maia_store::StoreError;
use maia_store::ThreadEventWrite;

struct TestDb {
    directory: PathBuf,
    owner: Option<SqliteOwner>,
}

impl TestDb {
    fn open(name: &str) -> Self {
        let directory =
            std::env::temp_dir().join(format!("maia-memory-polish-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("{error}"));
        let owner = SqliteOwner::open(OwnerOpen {
            path: directory.join("brain.sqlite"),
            now: 1,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .unwrap_or_else(|error| panic!("{error}"));
        Self {
            directory,
            owner: Some(owner),
        }
    }

    fn owner(&self) -> &SqliteOwner {
        match &self.owner {
            Some(owner) => owner,
            None => panic!("owner shut down"),
        }
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            let _ = owner.shutdown();
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn must<T>(result: Result<T, StoreError>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{error}"),
    }
}

fn seed(owner: &SqliteOwner) {
    must(owner.append(AppendEvents {
        thread_id: "thread-1".to_owned(),
        expected_version: 0,
        participants: "owner".to_owned(),
        occurred_at: 10,
        events: vec![ThreadEventWrite {
            event_id: "event-1".to_owned(),
            kind: "user".to_owned(),
            body: "remember me".to_owned(),
        }],
    }));
}

fn remember(owner: &SqliteOwner, episode_id: &str, claim_id: &str, sentence: &str, at: i64) {
    must(owner.insert_episode(EpisodeWrite {
        episode_id: episode_id.to_owned(),
        thread_id: "thread-1".to_owned(),
        turn_id: format!("turn-{episode_id}"),
        body: format!("Owner: {sentence}"),
        taint: MemoryTaint::Trusted,
        reasoning: None,
        participants: "owner".to_owned(),
        created_at: at,
        segments: vec![],
    }));
    must(owner.apply_promotion(PromotionWrite {
        episode_id: episode_id.to_owned(),
        model: "model-a".to_owned(),
        now: at,
        claims: vec![PromotionClaimWrite {
            claim_id: claim_id.to_owned(),
            sentence: sentence.to_owned(),
            taint: MemoryTaint::Trusted,
            valid_from: at,
            lexemes: vec![],
            ..Default::default()
        }],
        same_claim_ids: vec![],
        replacements: vec![],
        links: vec![],
    session_bot_id: String::new(),
    session_summary: String::new(),
    }));
}

#[test]
fn extracting_the_same_name_twice_leaves_one_visible_claim() {
    let db = TestDb::open("names");
    seed(db.owner());
    remember(
        db.owner(),
        "episode-1",
        "claim-owner",
        "The owner's name is Garrett.",
        20,
    );
    remember(
        db.owner(),
        "episode-2",
        "claim-owner-again",
        "The owner's name is Garrett.",
        21,
    );
    remember(
        db.owner(),
        "episode-3",
        "claim-user",
        "The user's name is Garrett.",
        22,
    );
    let map = must(db.owner().brain_map());
    let visible: Vec<_> = map
        .nodes
        .iter()
        .filter(|node| node.kind == BrainNodeKind::Claim && node.detail.hidden_reason.is_none())
        .collect();
    assert_eq!(visible.len(), 1, "{visible:?}");
    assert_eq!(
        visible[0].sentence.as_deref(),
        Some("The owner's name is Garrett.")
    );
}

#[test]
fn canby_oregon_is_stored_as_the_canby_place() {
    let db = TestDb::open("canby");
    seed(db.owner());
    remember(
        db.owner(),
        "episode-1",
        "claim-home",
        "The user lives in Canby Oregon.",
        20,
    );
    let map = must(db.owner().brain_map());
    let entities: Vec<_> = map
        .nodes
        .iter()
        .filter(|node| node.kind == BrainNodeKind::Entity)
        .collect();
    assert!(
        entities.iter().any(|node| {
            node.label == "Canby" && node.detail.entity_kind.as_deref() == Some("place")
        }),
        "{entities:?}"
    );
    assert!(
        !entities
            .iter()
            .any(|node| node.label.eq_ignore_ascii_case("Canby Oregon")),
        "{entities:?}"
    );
}
