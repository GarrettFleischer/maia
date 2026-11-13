//! Session summary commits with promotion; a failed promotion keeps neither.

use std::fs;
use std::path::PathBuf;

use maia_store::AppendEvents;
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
            std::env::temp_dir().join(format!("maia-session-summary-{name}-{}", std::process::id()));
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

#[test]
fn summary_and_claim_commit_together_and_failed_write_keeps_neither() {
    let db = TestDb::open("commit");
    must(db.owner().append(AppendEvents {
        thread_id: "thread-1".to_owned(),
        expected_version: 0,
        participants: "owner".to_owned(),
        occurred_at: 10,
        events: vec![ThreadEventWrite {
            event_id: "open".to_owned(),
            kind: "system".to_owned(),
            body: "open".to_owned(),
        }],
    }));
    must(db.owner().insert_episode(EpisodeWrite {
        episode_id: "episode-1".to_owned(),
        thread_id: "thread-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        body: "Owner: I like oat milk.\nMaia: Noted.".to_owned(),
        taint: MemoryTaint::Trusted,
        reasoning: None,
        participants: "owner".to_owned(),
        created_at: 20,
        segments: Vec::new(),
    }));

    must(db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-1".to_owned(),
        model: "promoter".to_owned(),
        now: 30,
        claims: vec![PromotionClaimWrite {
            claim_id: "claim-oat".to_owned(),
            sentence: "The owner prefers oat milk.".to_owned(),
            taint: MemoryTaint::Trusted,
            valid_from: 20,
            lexemes: vec!["oat".to_owned(), "milk".to_owned()],
            ..Default::default()
        }],
        same_claim_ids: Vec::new(),
        replacements: Vec::new(),
        links: Vec::new(),
        session_bot_id: "maia".to_owned(),
        session_summary: "Talking about coffee preferences.".to_owned(),
    }));

    assert_eq!(
        must(db.owner().session_summary("maia")).as_deref(),
        Some("Talking about coffee preferences.")
    );
    let nearest = must(db.owner().nearest_claims("oat milk", 5));
    assert!(
        nearest.iter().any(|row| row.claim_id == "claim-oat"),
        "{nearest:?}"
    );

    let missing = db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-missing".to_owned(),
        model: "promoter".to_owned(),
        now: 40,
        claims: vec![PromotionClaimWrite {
            claim_id: "claim-x".to_owned(),
            sentence: "Should not land.".to_owned(),
            taint: MemoryTaint::Trusted,
            valid_from: 40,
            lexemes: Vec::new(),
            ..Default::default()
        }],
        same_claim_ids: Vec::new(),
        replacements: Vec::new(),
        links: Vec::new(),
        session_bot_id: "maia".to_owned(),
        session_summary: "This summary must not replace the prior one.".to_owned(),
    });
    assert!(missing.is_err(), "{missing:?}");
    assert_eq!(
        must(db.owner().session_summary("maia")).as_deref(),
        Some("Talking about coffee preferences.")
    );
}
