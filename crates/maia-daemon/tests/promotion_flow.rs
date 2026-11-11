//! Cross-thread findability after promotion, without a dream.
//!
//! Uses a fake promoter. Episodes stay intact on invalid model output.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use maia_core::audit::Timestamp;
use maia_core::embedder::BGE_SMALL_EN_V1_5;
use maia_daemon::ClaimEmbedder;
use maia_daemon::ClaimEmbedderIdentity;
use maia_daemon::CoreClaimEmbedder;
use maia_daemon::EmbedFailure;
use maia_daemon::PromotionAttempt;
use maia_daemon::PromotionCaps;
use maia_daemon::PromotionRunner;
use maia_daemon::ScriptedPromoter;
use maia_daemon::bounded_recall;
use maia_store::AppendEvents;
use maia_store::EmbeddingModelWrite;
use maia_store::EmbeddingTarget;
use maia_store::EpisodeWrite;
use maia_store::MemoryTaint;
use maia_store::OwnerOpen;
use maia_store::SegmentWrite;
use maia_store::SqliteOwner;
use maia_store::ThreadEventWrite;

const NOW: i64 = 1_735_000_000;
static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

fn temp_db(label: &str) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("maia-promotion-{label}-{seq}.sqlite"));
    let _ = std::fs::remove_file(&path);
    path
}

fn open_store(path: &PathBuf) -> SqliteOwner {
    SqliteOwner::open(OwnerOpen {
        path: path.clone(),
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("store")
}

fn seed_thread(store: &SqliteOwner, thread_id: &str) {
    store
        .append(AppendEvents {
            thread_id: thread_id.to_owned(),
            expected_version: 0,
            participants: "owner".to_owned(),
            occurred_at: NOW,
            events: vec![ThreadEventWrite {
                event_id: format!("{thread_id}-open"),
                kind: "system".to_owned(),
                body: "open".to_owned(),
            }],
        })
        .expect("thread");
}

fn insert_episode(store: &SqliteOwner, episode_id: &str, thread_id: &str, body: &str) {
    insert_episode_at(
        store,
        episode_id,
        thread_id,
        body,
        NOW,
        MemoryTaint::Untrusted,
        MemoryTaint::Untrusted,
    );
}

fn insert_episode_at(
    store: &SqliteOwner,
    episode_id: &str,
    thread_id: &str,
    body: &str,
    created_at: i64,
    episode_taint: MemoryTaint,
    segment_taint: MemoryTaint,
) {
    store
        .insert_episode(EpisodeWrite {
            episode_id: episode_id.to_owned(),
            thread_id: thread_id.to_owned(),
            turn_id: format!("{episode_id}-turn"),
            body: body.to_owned(),
            taint: episode_taint,
            reasoning: None,
            participants: "owner".to_owned(),
            created_at,
            segments: vec![SegmentWrite {
                text: body.to_owned(),
                taint: segment_taint,
                sources: "web".to_owned(),
            }],
        })
        .expect("episode");
}

#[test]
fn bobs_best_burgers_claim_from_thread_a_is_recalled_in_thread_b_without_a_dream() {
    let path = temp_db("bobs");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    seed_thread(&store, "thread-b");
    insert_episode(
        &store,
        "episode-a1",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
    );

    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(
        r#"{"skip":false,"new":["The project is named Bob's Best Burgers."],"same":[],"replaces":[]}"#,
    );
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    );
    let attempts = runner.drain().expect("promote");
    assert_eq!(
        attempts,
        vec![PromotionAttempt::Applied {
            claim_ids: vec!["claim-episode-a1-0".to_owned()]
        }]
    );

    let recall = bounded_recall(runner.store(), "bob's", Timestamp(NOW), None).expect("recall");
    assert!(
        recall
            .items
            .iter()
            .any(|item| item.sentence.contains("Bob's Best Burgers")),
        "expected Bob's claim in recall, got {:?}",
        recall.items
    );
    assert_eq!(
        runner.store().pending_promotions().expect("pending").len(),
        0
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn invalid_promotion_json_leaves_episode_intact_and_queued() {
    let path = temp_db("invalid");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-bad",
        "thread-a",
        "Owner: Remember the vault path is local.\nMaia: Ok.",
    );
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(r#"{"skip":false,"new":["not a sentence"],"same":[],"replaces":[]}"#);
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps {
            failure_limit: 3,
            ..PromotionCaps::default()
        },
        Arc::new(|| NOW),
    );
    let attempt = runner.promote_one().expect("promote");
    assert_eq!(attempt, PromotionAttempt::QueuedRetry);
    let pending = runner.store().pending_promotions().expect("pending");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].episode_id, "episode-bad");
    assert_eq!(pending[0].promotion_failures, 1);
    assert_eq!(
        runner
            .store()
            .nearest_claims("vault", 5)
            .unwrap_or_default()
            .len(),
        0,
        "no partial claims"
    );
    let episode = runner
        .store()
        .promotion_episode("episode-bad")
        .expect("episode remains");
    assert!(episode.body.contains("vault path"));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn taint_comes_from_the_episode_not_the_model() {
    let path = temp_db("taint");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-taint",
        "thread-a",
        "Owner: The API token lives in the desktop keychain.\nMaia: Stored.",
    );
    let mut promoter = ScriptedPromoter::create();
    // Model output has no taint field; episode is Untrusted.
    promoter.push_ok(
        r#"{"skip":false,"new":["The API token lives in the desktop keychain."],"same":[],"replaces":[]}"#,
    );
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    );
    runner.drain().expect("promote");
    let map = runner.store().brain_map().expect("map");
    let claim = map
        .nodes
        .iter()
        .find(|node| node.kind == maia_store::BrainNodeKind::Claim)
        .expect("claim");
    assert_eq!(claim.taint.as_deref(), Some("untrusted"));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_second_runner_does_not_reuse_claim_ids() {
    let path = temp_db("stable-ids");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-a",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
    );
    insert_episode_at(
        &store,
        "episode-b",
        "thread-a",
        "Owner: The kitchen is in Portland.\nMaia: Noted.",
        NOW + 1,
        MemoryTaint::Untrusted,
        MemoryTaint::Untrusted,
    );
    let mut first_promoter = ScriptedPromoter::create();
    first_promoter.push_ok(
        r#"{"skip":false,"new":["The project is named Bob's Best Burgers."],"same":[],"replaces":[]}"#,
    );
    let first = PromotionRunner::new(
        store,
        first_promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    );
    assert_eq!(
        first.promote_one().expect("first"),
        PromotionAttempt::Applied {
            claim_ids: vec!["claim-episode-a-0".to_owned()]
        }
    );
    drop(first);
    let store = open_store(&path);
    let mut second_promoter = ScriptedPromoter::create();
    second_promoter
        .push_ok(r#"{"skip":false,"new":["The kitchen is in Portland."],"same":[],"replaces":[]}"#);
    let second = PromotionRunner::new(
        store,
        second_promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    );
    assert_eq!(
        second.promote_one().expect("second"),
        PromotionAttempt::Applied {
            claim_ids: vec!["claim-episode-b-0".to_owned()]
        }
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_failed_promotion_call_counts_against_the_daily_cap() {
    let path = temp_db("cap-fail");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-cap",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
    );
    let mut promoter = ScriptedPromoter::create();
    promoter.push_err("transport");
    promoter.push_ok(
        r#"{"skip":false,"new":["The project is named Bob's Best Burgers."],"same":[],"replaces":[]}"#,
    );
    let clock = Arc::new(AtomicI64::new(NOW));
    let clock_for_runner = Arc::clone(&clock);
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps {
            daily_call_cap: 1,
            ..PromotionCaps::default()
        },
        Arc::new(move || clock_for_runner.load(Ordering::Relaxed)),
    );
    let handle = runner.promoter();
    assert_eq!(
        runner.promote_one().expect("first"),
        PromotionAttempt::QueuedRetry
    );
    clock.store(NOW + 2, Ordering::Relaxed);
    assert_eq!(
        runner.promote_one().expect("second"),
        PromotionAttempt::CapReached
    );
    let Ok(guard) = handle.lock() else {
        panic!("promoter lock");
    };
    assert_eq!(guard.prompts.len(), 1);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn drain_stops_when_the_daily_cap_is_already_spent() {
    let path = temp_db("cap-drain");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-drain",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
    );
    let promoter = ScriptedPromoter::create();
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps {
            daily_call_cap: 0,
            ..PromotionCaps::default()
        },
        Arc::new(|| NOW),
    );
    let handle = runner.promoter();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(runner.drain());
    });
    let attempts = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("drain returned");
    assert_eq!(attempts.expect("drain"), vec![PromotionAttempt::CapReached]);
    let Ok(guard) = handle.lock() else {
        panic!("promoter lock");
    };
    assert_eq!(guard.prompts.len(), 0);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_failed_episode_waits_out_backoff_so_a_later_episode_can_run() {
    let path = temp_db("backoff");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode_at(
        &store,
        "episode-a",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
        NOW,
        MemoryTaint::Untrusted,
        MemoryTaint::Untrusted,
    );
    insert_episode_at(
        &store,
        "episode-b",
        "thread-a",
        "Owner: The kitchen is in Portland.\nMaia: Noted.",
        NOW + 1,
        MemoryTaint::Untrusted,
        MemoryTaint::Untrusted,
    );
    let mut promoter = ScriptedPromoter::create();
    promoter.push_err("transport");
    promoter
        .push_ok(r#"{"skip":false,"new":["The kitchen is in Portland."],"same":[],"replaces":[]}"#);
    promoter.push_ok(
        r#"{"skip":false,"new":["The project is named Bob's Best Burgers."],"same":[],"replaces":[]}"#,
    );
    let clock = Arc::new(AtomicI64::new(NOW));
    let clock_for_runner = Arc::clone(&clock);
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(move || clock_for_runner.load(Ordering::Relaxed)),
    );
    assert_eq!(
        runner.promote_one().expect("defer a"),
        PromotionAttempt::QueuedRetry
    );
    assert_eq!(
        runner.promote_one().expect("promote b"),
        PromotionAttempt::Applied {
            claim_ids: vec!["claim-episode-b-0".to_owned()]
        }
    );
    clock.store(NOW + 2, Ordering::Relaxed);
    assert_eq!(
        runner.promote_one().expect("promote a"),
        PromotionAttempt::Applied {
            claim_ids: vec!["claim-episode-a-0".to_owned()]
        }
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn segment_taint_is_joined_even_when_the_episode_row_is_trusted() {
    let path = temp_db("segment-taint");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode_at(
        &store,
        "episode-mix",
        "thread-a",
        "Owner: The API token lives in the desktop keychain.\nMaia: Stored.",
        NOW,
        MemoryTaint::Trusted,
        MemoryTaint::Untrusted,
    );
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(
        r#"{"skip":false,"new":["The API token lives in the desktop keychain."],"same":[],"replaces":[]}"#,
    );
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    );
    runner.drain().expect("promote");
    let map = runner.store().brain_map().expect("map");
    let claim = map
        .nodes
        .iter()
        .find(|node| node.kind == maia_store::BrainNodeKind::Claim)
        .expect("claim");
    assert_eq!(claim.taint.as_deref(), Some("untrusted"));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn the_model_cannot_replace_a_claim_it_was_not_shown() {
    let path = temp_db("shown");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-hidden",
        "thread-a",
        "Owner: The vault code is stored in Obsidian.\nMaia: Noted.",
    );
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(
        r#"{"skip":false,"new":["The vault code is stored in Obsidian."],"same":[],"replaces":[]}"#,
    );
    promoter.push_ok(
        r#"{"skip":false,"new":[],"same":[],"replaces":[{"old":"claim-episode-hidden-0","sentence":"The bicycle paint is teal."}]}"#,
    );
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    );
    assert!(matches!(
        runner.promote_one().expect("seed"),
        PromotionAttempt::Applied { .. }
    ));
    insert_episode_at(
        runner.store(),
        "episode-teal",
        "thread-a",
        "Owner: The bicycle paint is teal.\nMaia: Noted.",
        NOW + 1,
        MemoryTaint::Untrusted,
        MemoryTaint::Untrusted,
    );
    assert_eq!(
        runner.promote_one().expect("hidden replace"),
        PromotionAttempt::QueuedRetry
    );
    let hidden = runner
        .store()
        .nearest_claims("obsidian", 5)
        .expect("nearest");
    assert_eq!(hidden.len(), 1);
    assert_eq!(hidden[0].claim_id, "claim-episode-hidden-0");
    assert!(hidden[0].sentence.contains("Obsidian"));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn role_prefixed_small_talk_is_skipped_without_a_model_call() {
    let path = temp_db("smalltalk");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(&store, "episode-hi", "thread-a", "Owner: hello\nMaia: hi");
    let promoter = ScriptedPromoter::create();
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    );
    let handle = runner.promoter();
    assert_eq!(
        runner.promote_one().expect("skip"),
        PromotionAttempt::Skipped
    );
    let Ok(guard) = handle.lock() else {
        panic!("promoter lock");
    };
    assert_eq!(guard.prompts.len(), 0);
    let _ = std::fs::remove_file(&path);
}

struct FixedEmbedder;

impl ClaimEmbedder for FixedEmbedder {
    fn identity(&self) -> ClaimEmbedderIdentity {
        ClaimEmbedderIdentity {
            model_id: BGE_SMALL_EN_V1_5.model_id.to_owned(),
            dimensions: u64::try_from(BGE_SMALL_EN_V1_5.dimensions).unwrap_or(0),
            weights_sha256: BGE_SMALL_EN_V1_5.weight_sha256.to_owned(),
            tokenizer_sha256: BGE_SMALL_EN_V1_5.tokenizer_sha256.to_owned(),
            query_prefix: BGE_SMALL_EN_V1_5.vector_prefix.to_owned(),
            document_prefix: BGE_SMALL_EN_V1_5.vector_prefix.to_owned(),
        }
    }

    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedFailure> {
        let mut values = vec![0.0_f32; BGE_SMALL_EN_V1_5.dimensions];
        values[0] = 1.0;
        Ok(texts.iter().map(|_| values.clone()).collect())
    }
}

struct DownEmbedder;

impl ClaimEmbedder for DownEmbedder {
    fn identity(&self) -> ClaimEmbedderIdentity {
        FixedEmbedder.identity()
    }

    fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedFailure> {
        Err(EmbedFailure::Unavailable)
    }
}

#[test]
fn promoted_claims_receive_embeddings_when_the_embedder_works() {
    let path = temp_db("embed");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-a1",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
    );
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(
        r#"{"skip":false,"new":["The project is named Bob's Best Burgers."],"same":[],"replaces":[]}"#,
    );
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    )
    .with_embedder(Arc::new(CoreClaimEmbedder::new(&BGE_SMALL_EN_V1_5)));
    let attempt = runner.promote_one().expect("promote");
    let PromotionAttempt::Applied { claim_ids } = attempt else {
        panic!("expected a claim");
    };
    let vector = runner
        .store()
        .embedding(EmbeddingTarget::Claim, &claim_ids[0])
        .expect("read")
        .expect("vector");
    assert_eq!(vector.len(), 384);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_down_embedder_keeps_the_claim_findable_by_text() {
    let path = temp_db("embed-down");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-a1",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
    );
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(
        r#"{"skip":false,"new":["The project is named Bob's Best Burgers."],"same":[],"replaces":[]}"#,
    );
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    )
    .with_embedder(Arc::new(DownEmbedder));
    let attempt = runner.promote_one().expect("promote");
    let PromotionAttempt::Applied { claim_ids } = attempt else {
        panic!("expected a claim");
    };
    assert!(
        runner
            .store()
            .embedding(EmbeddingTarget::Claim, &claim_ids[0])
            .expect("read")
            .is_none()
    );
    let recall = bounded_recall(runner.store(), "bob's", Timestamp(NOW), None).expect("recall");
    assert!(
        recall
            .items
            .iter()
            .any(|item| item.sentence.contains("Bob's Best Burgers"))
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn vector_seeds_recall_a_claim_that_shares_no_lexemes_with_the_query() {
    let path = temp_db("knn-recall");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-a1",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
    );
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(
        r#"{"skip":false,"new":["The project is named Bob's Best Burgers."],"same":[],"replaces":[]}"#,
    );
    let embedder: Arc<dyn ClaimEmbedder> = Arc::new(FixedEmbedder);
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    )
    .with_embedder(Arc::clone(&embedder));
    assert!(matches!(
        runner.promote_one().expect("promote"),
        PromotionAttempt::Applied { .. }
    ));
    let recall = bounded_recall(
        runner.store(),
        "zephyrlattice",
        Timestamp(NOW),
        Some(embedder.as_ref()),
    )
    .expect("vector recall");
    assert!(
        recall
            .items
            .iter()
            .any(|item| item.sentence.contains("Bob's Best Burgers"))
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn an_incompatible_embedder_does_not_mix_claim_vectors() {
    let path = temp_db("embed-mismatch");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-a1",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
    );
    store
        .put_embedding_model(EmbeddingModelWrite {
            model_id: BGE_SMALL_EN_V1_5.model_id.to_owned(),
            dimensions: 384,
            weights_sha256: "different-weights".to_owned(),
            tokenizer_sha256: "different-tokenizer".to_owned(),
            query_prefix: "other:".to_owned(),
            document_prefix: "other:".to_owned(),
            recorded_at: NOW,
        })
        .expect("model row");
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(
        r#"{"skip":false,"new":["The project is named Bob's Best Burgers."],"same":[],"replaces":[]}"#,
    );
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    )
    .with_embedder(Arc::new(FixedEmbedder));
    let attempt = runner.promote_one().expect("promote");
    let PromotionAttempt::Applied { claim_ids } = attempt else {
        panic!("expected a claim");
    };
    assert!(
        runner
            .store()
            .embedding(EmbeddingTarget::Claim, &claim_ids[0])
            .expect("read")
            .is_none()
    );
    let recall = bounded_recall(runner.store(), "bob's", Timestamp(NOW), None).expect("recall");
    assert!(
        recall
            .items
            .iter()
            .any(|item| item.sentence.contains("Bob's Best Burgers"))
    );
    let _ = std::fs::remove_file(&path);
}

/// Query vector points opposite the stored claim vector. Lexical recall must still hit.
struct OppositeQueryEmbedder;

impl ClaimEmbedder for OppositeQueryEmbedder {
    fn identity(&self) -> ClaimEmbedderIdentity {
        FixedEmbedder.identity()
    }

    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedFailure> {
        Ok(texts
            .iter()
            .map(|text| {
                let mut values = vec![0.0_f32; BGE_SMALL_EN_V1_5.dimensions];
                let lower = text.to_ascii_lowercase();
                values[0] = if lower.contains("best") { 1.0 } else { -1.0 };
                values
            })
            .collect())
    }
}

#[test]
fn a_negative_cosine_does_not_hide_a_lexical_claim() {
    let path = temp_db("neg-cosine");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-a1",
        "thread-a",
        "Owner: The project is named Bob's Best Burgers.\nMaia: Noted.",
    );
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(
        r#"{"skip":false,"new":["The project is named Bob's Best Burgers."],"same":[],"replaces":[]}"#,
    );
    let embedder: Arc<dyn ClaimEmbedder> = Arc::new(OppositeQueryEmbedder);
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    )
    .with_embedder(Arc::clone(&embedder));
    assert!(matches!(
        runner.promote_one().expect("promote"),
        PromotionAttempt::Applied { .. }
    ));
    let recall = bounded_recall(
        runner.store(),
        "bob",
        Timestamp(NOW),
        Some(embedder.as_ref()),
    )
    .expect("lexical recall survives a negative cosine");
    assert!(
        recall
            .items
            .iter()
            .any(|item| item.sentence.contains("Bob's Best Burgers"))
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn promotion_writes_a_relatedness_edge_and_an_entity_edge() {
    let path = temp_db("related");
    let store = open_store(&path);
    seed_thread(&store, "thread-a");
    insert_episode(
        &store,
        "episode-flour",
        "thread-a",
        "Northwind pantry stores flour.",
    );
    insert_episode(
        &store,
        "episode-oats",
        "thread-a",
        "Northwind pantry ships oats.",
    );
    {
        let connection = rusqlite::Connection::open(&path).expect("entity connection");
        connection
            .execute(
                "INSERT INTO entities (entity_id, slug, description, scope_kind, scope_agent) \
                 VALUES ('entity-nw', 'northwind', 'A shop', 'world', '')",
                [],
            )
            .expect("entity");
    }
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(
        r#"{"skip":false,"new":["Northwind pantry stores flour."],"same":[],"replaces":[]}"#,
    );
    promoter.push_ok(
        r#"{"skip":false,"new":["Northwind pantry ships oats."],"same":[],"replaces":[]}"#,
    );
    let runner = PromotionRunner::new(
        store,
        promoter,
        "fake-promoter",
        PromotionCaps::default(),
        Arc::new(|| NOW),
    );
    runner.promote_one().expect("flour");
    runner.promote_one().expect("oats");
    let edges = runner.store().brain_map().expect("map").edges;
    let related = edges
        .iter()
        .find(|edge| edge.kind == "relatedness")
        .expect("relatedness");
    assert_eq!(related.weight_millis, 250);
    assert_eq!(related.to_id, "claim-episode-flour-0");
    assert!(edges.iter().any(|edge| {
        edge.kind == "entity" && edge.to_id == "entity-nw" && edge.weight_millis == 500
    }));
    let _ = std::fs::remove_file(&path);
}
