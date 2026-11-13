//! Live Slice 1 verification against data/maia.sqlite.
//!
//! Requires the daemon to be stopped. Run:
//!   $env:MAIA_LIVE_VERIFY='1'; cargo test -p maia-daemon --test slice1_live_verify -- --nocapture

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
use maia_store::PromotionReplaceWrite;
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
fn live_slice1_throwaway_bot_preference_replace() {
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
            name: format!("slice1-a-{stamp}"),
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
            name: format!("slice1-b-{stamp}"),
            instructions: String::new(),
            now: stamp,
        })
        .expect("create b")
    {
        BotResponse::Bot(bot) => bot,
        other => panic!("expected bot, got {other:?}"),
    };

    let thread_id = format!("slice1-thread-{stamp}");
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

    let tea_episode = format!("episode-slice1-tea-{stamp}");
    let coffee_episode = format!("episode-slice1-coffee-{stamp}");
    let tea_claim = format!("claim-slice1-tea-{stamp}");
    let coffee_claim = format!("claim-slice1-coffee-{stamp}");

    for (episode_id, body, at) in [
        (
            tea_episode.as_str(),
            "Owner: For this throwaway check I prefer tea.\nMaia: Noted.",
            stamp,
        ),
        (
            coffee_episode.as_str(),
            "Owner: For this throwaway check I prefer coffee.\nMaia: Noted.",
            stamp + 1,
        ),
    ] {
        store
            .insert_episode(EpisodeWrite {
                episode_id: episode_id.to_owned(),
                thread_id: thread_id.clone(),
                turn_id: format!("{episode_id}-turn"),
                body: body.to_owned(),
                taint: MemoryTaint::Untrusted,
                reasoning: None,
                participants: "owner".to_owned(),
                created_at: at,
                segments: vec![SegmentWrite {
                    text: body.to_owned(),
                    taint: MemoryTaint::Untrusted,
                    sources: "owner".to_owned(),
                }],
            })
            .expect("episode");
        let _ = store.bots(BotRequest::NoteProvenance {
            target_kind: "episode".to_owned(),
            target_id: episode_id.to_owned(),
            bot_id: bot_a.bot_id.clone(),
            session_id: thread_id.clone(),
            noted_at: at,
        });
    }

    store
        .apply_promotion(PromotionWrite {
            episode_id: tea_episode.clone(),
            model: "slice1-verify".to_owned(),
            now: stamp,
            claims: vec![PromotionClaimWrite {
                claim_id: tea_claim.clone(),
                sentence: "The owner prefers tea for the throwaway check.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: stamp,
                lexemes: vec![
                    "owner".to_owned(),
                    "prefer".to_owned(),
                    "tea".to_owned(),
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
        .expect("tea write");
    let _ = store.bots(BotRequest::NoteProvenance {
        target_kind: "claim".to_owned(),
        target_id: tea_claim.clone(),
        bot_id: bot_a.bot_id.clone(),
        session_id: thread_id.clone(),
        noted_at: stamp,
    });

    store
        .apply_promotion(PromotionWrite {
            episode_id: coffee_episode.clone(),
            model: "slice1-verify".to_owned(),
            now: stamp + 1,
            claims: vec![PromotionClaimWrite {
                claim_id: coffee_claim.clone(),
                sentence: "The owner prefers coffee for the throwaway check.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: stamp + 1,
                lexemes: vec![
                    "owner".to_owned(),
                    "prefer".to_owned(),
                    "coffee".to_owned(),
                    "throwaway".to_owned(),
                ],
                memory_kind: "explicit".to_owned(),
                memory_scope: "agent".to_owned(),
                observer_bot_id: bot_a.bot_id.clone(),
                flagged_beside_lock: false,
            }],
            same_claim_ids: vec![],
            replacements: vec![PromotionReplaceWrite {
                old_claim_id: tea_claim.clone(),
                new_claim_id: coffee_claim.clone(),
            }],
            links: vec![],
        })
        .expect("coffee write");
    let _ = store.bots(BotRequest::NoteProvenance {
        target_kind: "claim".to_owned(),
        target_id: coffee_claim.clone(),
        bot_id: bot_a.bot_id.clone(),
        session_id: thread_id.clone(),
        noted_at: stamp + 1,
    });

    let connection = rusqlite::Connection::open(&path).expect("db");
    let (scope, kind, observer): (String, String, String) = connection
        .query_row(
            "SELECT memory_scope, memory_kind, observer_bot_id FROM claims WHERE claim_id = ?1",
            [coffee_claim.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("coffee columns");
    assert_eq!(scope, "agent", "new facts default private to the observer agent");
    assert_eq!(kind, "explicit");
    assert_eq!(observer, bot_a.bot_id);

    let recall = bounded_recall(&store, "throwaway check prefer", Timestamp(stamp), None)
        .expect("recall");
    assert!(
        recall
            .items
            .iter()
            .any(|item| item.sentence.contains("coffee")),
        "coffee must be recallable right away where scope allows (observer {}), got {:?}",
        bot_a.bot_id,
        recall.items
    );
    assert!(
        recall
            .items
            .iter()
            .all(|item| !item.sentence.to_lowercase().contains("tea")),
        "replaced tea must not surface, got {:?}",
        recall.items
    );

    let tea_status: String = connection
        .query_row(
            "SELECT status FROM claims WHERE claim_id = ?1",
            [tea_claim.as_str()],
            |row| row.get(0),
        )
        .expect("tea status");
    assert_eq!(tea_status, "superseded");

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
    println!(
        "slice1 live verify ok: coffee current under agent scope for {}, tea superseded, throwaway bots deleted",
        bot_a.bot_id
    );
}
