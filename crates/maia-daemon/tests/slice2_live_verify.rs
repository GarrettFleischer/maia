//! Live Slice 2 verification against data/maia.sqlite.
//!
//! Requires the daemon to be stopped. Run:
//!   $env:MAIA_LIVE_VERIFY='1'; cargo test -p maia-daemon --test slice2_live_verify -- --nocapture

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use maia_core::audit::Timestamp;
use maia_daemon::bounded_recall;
use maia_store::AppendEvents;
use maia_store::BotRequest;
use maia_store::BotResponse;
use maia_store::EpisodeWrite;
use maia_store::MemoryTaint;
use maia_store::OwnerOpen;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionWrite;
use maia_store::SegmentWrite;
use maia_store::SqliteOwner;
use maia_store::ThreadEventWrite;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs() as i64
}

#[test]
fn live_slice2_completed_unit_recallable_and_lag_visible() {
    if std::env::var("MAIA_LIVE_VERIFY").ok().as_deref() != Some("1") {
        eprintln!("skip: set MAIA_LIVE_VERIFY=1 with the daemon stopped");
        return;
    }
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("data/maia.sqlite");
    let path = path.canonicalize().unwrap_or(path);
    assert!(path.exists(), "missing {}", path.display());
    let stamp = now();
    let store = SqliteOwner::open(OwnerOpen {
        path: path.clone(),
        now: stamp,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("open live store");

    let bot_a = match store
        .bots(BotRequest::Create {
            name: format!("slice2-a-{stamp}"),
            instructions: String::new(),
            now: stamp,
        })
        .expect("create a")
    {
        BotResponse::Bot(bot) => bot,
        other => panic!("expected bot, got {other:?}"),
    };
    let bot_b = match store
        .bots(BotRequest::Create {
            name: format!("slice2-b-{stamp}"),
            instructions: String::new(),
            now: stamp,
        })
        .expect("create b")
    {
        BotResponse::Bot(bot) => bot,
        other => panic!("expected bot, got {other:?}"),
    };

    let thread_id = format!("slice2-thread-{stamp}");
    store
        .append(AppendEvents {
            thread_id: thread_id.clone(),
            expected_version: 0,
            participants: "owner".to_owned(),
            occurred_at: stamp,
            events: vec![ThreadEventWrite {
                event_id: format!("{thread_id}-open"),
                kind: "system".to_owned(),
                body: "open".to_owned(),
            }],
        })
        .expect("thread");

    let completed_episode = format!("episode-slice2-done-{stamp}");
    let claim_id = format!("claim-slice2-oat-{stamp}");
    store
        .insert_episode(EpisodeWrite {
            episode_id: completed_episode.clone(),
            thread_id: thread_id.clone(),
            turn_id: format!("{completed_episode}-turn"),
            body: "Owner: For this slice2 throwaway check I prefer oat milk.\nMaia: Got it — oat milk noted.".to_owned(),
            taint: MemoryTaint::Untrusted,
            reasoning: None,
            participants: "owner".to_owned(),
            created_at: stamp,
            segments: vec![
                SegmentWrite {
                    text: "For this slice2 throwaway check I prefer oat milk.".to_owned(),
                    taint: MemoryTaint::Untrusted,
                    sources: "owner".to_owned(),
                },
                SegmentWrite {
                    text: "Got it — oat milk noted.".to_owned(),
                    taint: MemoryTaint::Untrusted,
                    sources: "router".to_owned(),
                },
            ],
        })
        .expect("completed unit episode");
    let _ = store.bots(BotRequest::NoteProvenance {
        target_kind: "episode".to_owned(),
        target_id: completed_episode.clone(),
        bot_id: bot_a.bot_id.clone(),
        session_id: thread_id.clone(),
        noted_at: stamp,
    });

    store
        .apply_promotion(PromotionWrite {
            episode_id: completed_episode.clone(),
            model: "slice2-verify".to_owned(),
            now: stamp,
            claims: vec![PromotionClaimWrite {
                claim_id: claim_id.clone(),
                sentence: "The owner prefers oat milk for the slice2 throwaway check.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: stamp,
                lexemes: vec![
                    "owner".to_owned(),
                    "prefer".to_owned(),
                    "oat".to_owned(),
                    "milk".to_owned(),
                    "slice2".to_owned(),
                    "throwaway".to_owned(),
                ],
                memory_kind: "explicit".to_owned(),
                memory_scope: "agent".to_owned(),
                observer_bot_id: bot_a.bot_id.clone(),
                flagged_beside_lock: false,
            }],
            same_claim_ids: vec![],
            replacements: vec![],
            links: vec![],
        })
        .expect("promote completed unit once");
    let _ = store.bots(BotRequest::NoteProvenance {
        target_kind: "claim".to_owned(),
        target_id: claim_id.clone(),
        bot_id: bot_a.bot_id.clone(),
        session_id: thread_id.clone(),
        noted_at: stamp,
    });

    let pending_for_stamp = store
        .pending_promotions()
        .expect("pending")
        .into_iter()
        .filter(|row| row.episode_id.contains(&format!("slice2-done-{stamp}")))
        .count();
    assert_eq!(
        pending_for_stamp, 0,
        "completed unit must not leave a second pending extraction"
    );

    let recall = bounded_recall(
        &store,
        "slice2 throwaway oat milk",
        Timestamp(stamp),
        None,
    )
    .expect("recall");
    assert!(
        recall
            .items
            .iter()
            .any(|item| item.sentence.contains("oat milk")),
        "completed unit must be recallable after one extraction, got {:?}",
        recall.items
    );

    let lag_episode = format!("episode-slice2-lag-{stamp}");
    store
        .insert_episode(EpisodeWrite {
            episode_id: lag_episode.clone(),
            thread_id: thread_id.clone(),
            turn_id: format!("{lag_episode}-turn"),
            body: "Owner: Slice2 lag probe stays queued.\nMaia: Noted.".to_owned(),
            taint: MemoryTaint::Untrusted,
            reasoning: None,
            participants: "owner".to_owned(),
            created_at: stamp,
            segments: vec![SegmentWrite {
                text: "Slice2 lag probe stays queued.".to_owned(),
                taint: MemoryTaint::Untrusted,
                sources: "owner".to_owned(),
            }],
        })
        .expect("lag episode");
    store
        .note_promotion_failure(&lag_episode, 1)
        .expect("quarantine for behind indicator");
    let lag = store.extraction_lag().expect("lag");
    assert!(
        lag.quarantined >= 1,
        "quarantined work must stay visible in the lag count: {lag:?}"
    );
    assert!(
        lag.quarantined_episode_ids
            .iter()
            .any(|id| id == &lag_episode),
        "quarantined episode must be named: {lag:?}"
    );

    store
        .mark_promotion_skipped(&lag_episode, stamp + 1, "slice2-cleanup")
        .expect("clear lag probe");
    let _ = store.hide_episode(lag_episode, "slice2 cleanup");
    let _ = store.forget_claim(&claim_id);

    store
        .bots(BotRequest::Delete {
            bot_id: bot_a.bot_id.clone(),
        })
        .expect("delete a");
    store
        .bots(BotRequest::Delete {
            bot_id: bot_b.bot_id.clone(),
        })
        .expect("delete b");

    eprintln!("slice2 live verify ok: completed-unit recall + lag quarantine named");
}
