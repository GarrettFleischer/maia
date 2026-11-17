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
    let by_tag = must(db.owner().search_memory_exact("session_summary", 8));
    assert!(
        by_tag.iter().any(|hit| hit.id == "claim-ssum-maia"),
        "session summary must be a searchable claim: {by_tag:?}"
    );
    let by_body = must(db.owner().search_memory_exact("coffee", 8));
    assert!(
        by_body.iter().any(|hit| hit.id == "claim-ssum-maia"),
        "session summary body must be findable: {by_body:?}"
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

#[test]
fn searchable_session_summary_archives_prior_body_when_overwritten() {
    let db = TestDb::open("archive");
    db.owner()
        .append(AppendEvents {
            thread_id: "thread-1".to_owned(),
            expected_version: 0,
            participants: "owner".to_owned(),
            occurred_at: 10,
            events: vec![ThreadEventWrite {
                event_id: "open".to_owned(),
                kind: "system".to_owned(),
                body: "open".to_owned(),
            }],
        })
        .unwrap_or_else(|e| panic!("append: {e}"));
    db.owner()
        .insert_episode(EpisodeWrite {
            episode_id: "episode-1".to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            body: "first".to_owned(),
            taint: MemoryTaint::Trusted,
            reasoning: None,
            participants: "owner".to_owned(),
            created_at: 20,
            segments: Vec::new(),
        })
        .unwrap_or_else(|e| panic!("episode-1: {e}"));
    db.owner()
        .apply_promotion(PromotionWrite {
            episode_id: "episode-1".to_owned(),
            model: "promoter".to_owned(),
            now: 30,
            claims: vec![PromotionClaimWrite {
                claim_id: "claim-a".to_owned(),
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
            session_summary: "RUN76_SESSION_PITFALL_ALPHA coffee talk.".to_owned(),
        })
        .unwrap_or_else(|e| panic!("promo-1: {e}"));
    db.owner()
        .insert_episode(EpisodeWrite {
            episode_id: "episode-2".to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: "turn-2".to_owned(),
            body: "second".to_owned(),
            taint: MemoryTaint::Trusted,
            reasoning: None,
            participants: "owner".to_owned(),
            created_at: 40,
            segments: Vec::new(),
        })
        .unwrap_or_else(|e| panic!("episode-2: {e}"));
    db.owner()
        .apply_promotion(PromotionWrite {
            episode_id: "episode-2".to_owned(),
            model: "promoter".to_owned(),
            now: 50,
            claims: vec![PromotionClaimWrite {
                claim_id: "claim-b".to_owned(),
                sentence: "The owner likes pour-over coffee.".to_owned(),
                taint: MemoryTaint::Trusted,
                valid_from: 40,
                lexemes: vec!["coffee".to_owned()],
                ..Default::default()
            }],
            same_claim_ids: Vec::new(),
            replacements: Vec::new(),
            links: Vec::new(),
            session_bot_id: "maia".to_owned(),
            session_summary: "RUN76_SESSION_PITFALL_BETA later topic.".to_owned(),
        })
        .unwrap_or_else(|e| panic!("promo-2: {e}"));

    let latest = must(db.owner().search_memory_exact("PITFALL_BETA", 8));
    assert!(
        latest.iter().any(|hit| hit.id == "claim-ssum-maia"),
        "latest summary must stay on the stable id: {latest:?}"
    );
    let prior = must(db.owner().search_memory_exact("PITFALL_ALPHA", 8));
    assert!(
        prior
            .iter()
            .any(|hit| hit.id.starts_with("claim-ssum-maia-") && hit.title.contains("ALPHA")),
        "prior summary must remain searchable after overwrite: {prior:?}"
    );
}
