//! Live Slice 4 verification against data/maia.sqlite.
//!
//! One scripted promoter call writes a claim and a session summary; the next
//! packet for that bot includes the summary inside the 2,000-token budget.
//! Requires the daemon to be stopped:
//!   $env:MAIA_LIVE_VERIFY='1'; cargo test -p maia-daemon --test slice4_live_verify -- --nocapture

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use maia_core::task_loop::estimate_tokens;
use maia_core::thread_cache::{
    CONTEXT_PACKET_BUDGET, ContextPacketInput, PacketRole, PacketTurn, pack_context_packet,
};
use maia_daemon::PromotionAttempt;
use maia_daemon::PromotionCaps;
use maia_daemon::PromotionRunner;
use maia_daemon::ScriptedPromoter;
use maia_store::AppendEvents;
use maia_store::BotRequest;
use maia_store::BotResponse;
use maia_store::EpisodeWrite;
use maia_store::MemoryTaint;
use maia_store::OwnerOpen;
use maia_store::SegmentWrite;
use maia_store::SqliteOwner;
use maia_store::ThreadEventWrite;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs() as i64
}

fn tokens(text: &str) -> u32 {
    estimate_tokens(text.chars().count())
}

#[test]
fn live_slice4_summary_in_one_promoter_call() {
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

    let bot = match store
        .bots(BotRequest::Create {
            name: format!("slice4-a-{stamp}"),
            instructions: String::new(),
            now: stamp,
        })
        .expect("create")
    {
        BotResponse::Bot(bot) => bot,
        other => panic!("expected bot, got {other:?}"),
    };

    let episode_id = format!("episode-slice4-{stamp}");
    let thread_id = format!("slice4-thread-{stamp}");
    store
        .append(AppendEvents {
            thread_id: thread_id.clone(),
            expected_version: 0,
            participants: "owner".to_owned(),
            occurred_at: stamp,
            events: vec![ThreadEventWrite {
                event_id: format!("slice4-open-{stamp}"),
                kind: "system".to_owned(),
                body: "slice4".to_owned(),
            }],
        })
        .expect("thread");
    store
        .insert_episode(EpisodeWrite {
            episode_id: episode_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: format!("turn-slice4-{stamp}"),
            body: format!("Owner: slice4 prefers oat milk {stamp}.\nMaia: Noted."),
            taint: MemoryTaint::Trusted,
            reasoning: None,
            participants: "owner".to_owned(),
            created_at: stamp,
            segments: vec![SegmentWrite {
                text: format!("slice4 prefers oat milk {stamp}"),
                taint: MemoryTaint::Trusted,
                sources: "owner".to_owned(),
            }],
        })
        .expect("episode");
    store
        .bots(BotRequest::NoteProvenance {
            target_kind: "episode".to_owned(),
            target_id: episode_id.clone(),
            bot_id: bot.bot_id.clone(),
            session_id: format!("turn-slice4-{stamp}"),
            noted_at: stamp,
        })
        .expect("provenance");

    let summary = format!("Talking about slice4 oat milk {stamp}.");
    let mut promoter = ScriptedPromoter::create();
    promoter.push_ok(&format!(
        r#"{{"skip":false,"new":["The owner prefers oat milk for slice4 {stamp}."],"same":[],"replaces":[],"summary":"{summary}"}}"#
    ));
    let runner = PromotionRunner::new(
        store,
        promoter,
        "slice4-scripted",
        PromotionCaps::default(),
        Arc::new(move || stamp),
    );
    assert_eq!(
        runner.promote_one().expect("promote"),
        PromotionAttempt::Applied {
            claim_ids: vec![format!("claim-{episode_id}-0")]
        }
    );
    let stored = runner
        .store()
        .session_summary(&bot.bot_id)
        .expect("load summary");
    assert_eq!(stored.as_deref(), Some(summary.as_str()));

    let recent = vec![
        PacketTurn {
            role: PacketRole::User,
            text: "What were we talking about?".to_owned(),
        },
        PacketTurn {
            role: PacketRole::Assistant,
            text: "Your oat milk preference.".to_owned(),
        },
    ];
    let packed = pack_context_packet(
        ContextPacketInput {
            card: "",
            conclusions: &format!("The owner prefers oat milk for slice4 {stamp}."),
            summary: &summary,
            recent: &recent,
            budget: CONTEXT_PACKET_BUDGET,
        },
        tokens,
    );
    assert!(packed.total_tokens <= CONTEXT_PACKET_BUDGET);
    assert!(
        packed.memory_block().contains(&summary),
        "packet missing summary: {}",
        packed.memory_block()
    );

    runner
        .store()
        .bots(BotRequest::Delete {
            bot_id: bot.bot_id.clone(),
        })
        .expect("delete bot");
    drop(runner);
    eprintln!("slice4 live verify ok; bot deleted");
}
