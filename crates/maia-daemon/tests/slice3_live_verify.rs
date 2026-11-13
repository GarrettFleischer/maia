//! Live Slice 3 verification against data/maia.sqlite.
//!
//! Checks the budgeted context packet and bot transcript isolation on the
//! live store without calling a model. Requires the daemon to be stopped:
//!   $env:MAIA_LIVE_VERIFY='1'; cargo test -p maia-daemon --test slice3_live_verify -- --nocapture

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use maia_core::task_loop::estimate_tokens;
use maia_core::thread_cache::{
    CONTEXT_PACKET_BUDGET, ContextPacketInput, PacketRole, PacketTurn, pack_context_packet,
};
use maia_store::BotRequest;
use maia_store::BotResponse;
use maia_store::OwnerOpen;
use maia_store::SqliteOwner;

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
fn live_slice3_packet_budget_and_bot_isolation() {
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
            name: format!("slice3-a-{stamp}"),
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
            name: format!("slice3-b-{stamp}"),
            instructions: String::new(),
            now: stamp,
        })
        .expect("create b")
    {
        BotResponse::Bot(bot) => bot,
        other => panic!("expected bot, got {other:?}"),
    };

    let secret = format!("slice3-secret-oat-{stamp}");
    let coding = format!("slice3-coding-hello-{stamp}");
    let a_history = vec![
        PacketTurn {
            role: PacketRole::User,
            text: secret.clone(),
        },
        PacketTurn {
            role: PacketRole::Assistant,
            text: "Noted the oat preference.".to_owned(),
        },
    ];
    let b_history = vec![PacketTurn {
        role: PacketRole::User,
        text: coding.clone(),
    }];
    let packed_b = pack_context_packet(
        ContextPacketInput {
            card: "",
            conclusions: "Garrett prefers oat milk.",
            summary: "",
            recent: &b_history,
            budget: CONTEXT_PACKET_BUDGET,
        },
        tokens,
    );
    let prompt_b = format!(
        "{}\n{}",
        packed_b
            .recent
            .iter()
            .map(|turn| turn.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        packed_b.memory_block()
    );
    assert!(
        prompt_b.contains(&coding),
        "current bot turn must pack: {prompt_b}"
    );
    assert!(
        !prompt_b.contains(&secret),
        "other bot transcript must stay out of this packet: {prompt_b}"
    );
    assert!(
        packed_b.total_tokens <= CONTEXT_PACKET_BUDGET,
        "packet over budget: {}",
        packed_b.total_tokens
    );

    let long_recent: Vec<PacketTurn> = (0..40)
        .map(|index| PacketTurn {
            role: if index % 2 == 0 {
                PacketRole::User
            } else {
                PacketRole::Assistant
            },
            text: format!("slice3-turn-{index}-{}", "word ".repeat(40)),
        })
        .collect();
    let packed_long = pack_context_packet(
        ContextPacketInput {
            card: "Name: Garrett",
            conclusions: "Garrett prefers oat milk.",
            summary: "",
            recent: &long_recent,
            budget: CONTEXT_PACKET_BUDGET,
        },
        tokens,
    );
    assert!(
        packed_long.total_tokens <= CONTEXT_PACKET_BUDGET,
        "long chat packet over budget: {}",
        packed_long.total_tokens
    );
    assert_eq!(packed_long.card, "Name: Garrett");
    assert!(
        packed_long.recent.len() < long_recent.len(),
        "budget must drop older turns"
    );
    assert!(
        packed_long
            .recent
            .last()
            .is_some_and(|turn| turn.text.contains("slice3-turn-39")),
        "newest turn survives: {:?}",
        packed_long.recent.last()
    );

    let _ = a_history;
    let lag = store.extraction_lag().expect("lag");
    assert_eq!(lag.waiting, 0, "live lag waiting: {lag:?}");
    assert_eq!(lag.quarantined, 0, "live lag quarantined: {lag:?}");

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

    eprintln!(
        "slice3 live verify ok: packet budget + bot isolation; bots {} / {}",
        bot_a.bot_id, bot_b.bot_id
    );
}
