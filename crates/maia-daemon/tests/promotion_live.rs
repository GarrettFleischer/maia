//! Live promotion against the local freellmapi endpoint.
//!
//! Run explicitly:
//!   cargo test -p maia-daemon --test promotion_live -- --ignored --nocapture
//!
//! Loads BASE_URL / API_KEY from `.env` at runtime. Never prints secrets.
//! Uses a TEMP database file only. The model id is `auto`.

use std::collections::BTreeSet;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Wake;
use std::task::Waker;
use std::time::Instant;

use maia_core::audit::Timestamp;
use maia_core::credit::PrefixHash;
use maia_core::embedder::BGE_SMALL_EN_V1_5;
use maia_core::router::ReasoningEffort;
use maia_core::security::SecurityProfile;
use maia_daemon::ClaimEmbedder;
use maia_daemon::CoreClaimEmbedder;
use maia_daemon::IdSupply;
use maia_daemon::Orchestrator;
use maia_daemon::OrchestratorConfig;
use maia_daemon::ParentWork;
use maia_daemon::PromotionAttempt;
use maia_daemon::PromotionCaps;
use maia_daemon::PromotionRunner;
use maia_daemon::RouterPromoter;
use maia_daemon::RouterTurn;
use maia_daemon::RuntimeRouter;
use maia_daemon::ScriptedToolHost;
use maia_daemon::accepted_routing_policy;
use maia_daemon::bounded_recall;
use maia_daemon::read_promoter_env;
use maia_daemon::router_from_connection;
use maia_store::AppendEvents;
use maia_store::EmbeddingTarget;
use maia_store::EpisodeWrite;
use maia_store::MemoryTaint;
use maia_store::OwnerOpen;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionWrite;
use maia_store::SegmentWrite;
use maia_store::SqliteOwner;
use maia_store::ThreadEventWrite;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

fn temp_db() -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "maia-promotion-live-{}-{}.sqlite",
        std::process::id(),
        seq
    ));
    let _ = std::fs::remove_file(&path);
    path
}

fn load_dotenv_from_parents() {
    let Ok(mut dir) = std::env::current_dir() else {
        return;
    };
    loop {
        let candidate = dir.join(".env");
        if candidate.is_file() {
            let _ = dotenvy::from_filename(&candidate);
            return;
        }
        if !dir.pop() {
            return;
        }
    }
}

fn load_promoter() -> maia_daemon::PromoterEnv {
    load_dotenv_from_parents();
    let pairs = [
        ("BASE_URL", std::env::var("BASE_URL").unwrap_or_default()),
        ("API_KEY", std::env::var("API_KEY").unwrap_or_default()),
        (
            "PROMOTER_BASE_URL",
            std::env::var("PROMOTER_BASE_URL").unwrap_or_default(),
        ),
        (
            "PROMOTER_API_KEY",
            std::env::var("PROMOTER_API_KEY").unwrap_or_default(),
        ),
        ("PROMOTER_MODEL", "auto".to_owned()),
    ];
    let refs: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    read_promoter_env(&refs).expect("promoter env from .env")
}

fn recall_hit(store: &SqliteOwner, embedder: &dyn ClaimEmbedder, query: &str, now: i64) -> bool {
    bounded_recall(store, query, Timestamp(now), Some(embedder)).is_some_and(|packed| {
        packed.items.iter().any(|item| {
            let sentence = item.sentence.to_ascii_lowercase();
            sentence.contains(query) || query.split_whitespace().any(|word| sentence.contains(word))
        })
    })
}

#[test]
#[ignore = "live freellmapi check; run with --ignored"]
fn live_promotion_then_cross_thread_recall() {
    let env = load_promoter();
    assert!(
        env.base_url().starts_with("http"),
        "base url missing (value not printed)"
    );
    assert_eq!(env.model(), "auto");
    let path = temp_db();
    let origin = 1_735_100_000_i64;
    let clock = Arc::new(AtomicI64::new(origin));
    let store = SqliteOwner::open(OwnerOpen {
        path: path.clone(),
        now: origin,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("temp store");
    for thread in ["thread-live-a", "thread-live-b"] {
        store
            .append(AppendEvents {
                thread_id: thread.to_owned(),
                expected_version: 0,
                participants: "owner".to_owned(),
                occurred_at: origin,
                events: vec![ThreadEventWrite {
                    event_id: format!("{thread}-open"),
                    kind: "system".to_owned(),
                    body: "open".to_owned(),
                }],
            })
            .expect("thread");
    }

    let turns = [
        (
            "episode-bob",
            origin,
            "Owner: The project is named Bob's Best Burgers.\nMaia: Got it.",
        ),
        (
            "episode-correction",
            origin + 1,
            "Owner: Actually the project is named Northwind Pantry.\nMaia: Updated.",
        ),
        (
            "episode-duplicate",
            origin + 2,
            "Owner: The project is named Northwind Pantry.\nMaia: Noted again.",
        ),
        ("episode-smalltalk", origin + 3, "Owner: hello\nMaia: hi"),
        (
            "episode-portland",
            origin + 4,
            "Owner: The kitchen is in Portland.\nMaia: Noted.",
        ),
    ];
    for (id, created_at, body) in turns {
        store
            .insert_episode(EpisodeWrite {
                episode_id: id.to_owned(),
                thread_id: "thread-live-a".to_owned(),
                turn_id: format!("{id}-turn"),
                body: body.to_owned(),
                taint: MemoryTaint::Trusted,
                reasoning: None,
                participants: "owner".to_owned(),
                created_at,
                segments: vec![SegmentWrite {
                    text: body.to_owned(),
                    taint: MemoryTaint::Trusted,
                    sources: "owner".to_owned(),
                }],
            })
            .expect("episode");
    }

    let router = router_from_connection(env.base_url(), env.api_key().as_str(), "auto")
        .expect("promoter router");
    let embedder: Arc<dyn ClaimEmbedder> = Arc::new(CoreClaimEmbedder::new(&BGE_SMALL_EN_V1_5));
    let clock_for_runner = Arc::clone(&clock);
    let runner = PromotionRunner::new(
        store,
        RouterPromoter::new(router, "auto"),
        "auto",
        PromotionCaps::default(),
        Arc::new(move || clock_for_runner.load(Ordering::Relaxed)),
    )
    .with_embedder(Arc::clone(&embedder));

    let mut claims = Vec::new();
    let mut malformed = 0_u32;
    let mut latencies_ms = Vec::new();
    let mut token_counts = Vec::new();
    let mut saw_smalltalk = false;
    for _ in 0..15 {
        let before: BTreeSet<String> = runner
            .store()
            .pending_promotions()
            .expect("pending")
            .into_iter()
            .map(|row| row.episode_id)
            .collect();
        if before.is_empty() {
            break;
        }
        clock.fetch_add(30, Ordering::Relaxed);
        let now = clock.load(Ordering::Relaxed);
        let day_key = format!("day-{}", now.div_euclid(86_400));
        let before_stats = runner
            .store()
            .promotion_day_stats(&day_key)
            .unwrap_or((0, 0));
        let started = Instant::now();
        let attempt = runner.promote_one().expect("promote");
        let after_stats = runner
            .store()
            .promotion_day_stats(&day_key)
            .unwrap_or((0, 0));
        latencies_ms.push(started.elapsed().as_millis());
        token_counts.push(after_stats.1.saturating_sub(before_stats.1));
        let after: BTreeSet<String> = runner
            .store()
            .pending_promotions()
            .expect("pending")
            .into_iter()
            .map(|row| row.episode_id)
            .collect();
        if before.contains("episode-smalltalk") && !after.contains("episode-smalltalk") {
            assert_eq!(attempt, PromotionAttempt::Skipped);
            assert_eq!(before_stats.0, after_stats.0);
            saw_smalltalk = true;
        }
        match attempt {
            PromotionAttempt::Applied { claim_ids } => claims.extend(claim_ids),
            PromotionAttempt::Skipped => {}
            PromotionAttempt::QueuedRetry => malformed += 1,
            PromotionAttempt::Idle | PromotionAttempt::CapReached => break,
        }
    }

    let now = clock.load(Ordering::Relaxed);
    let bob = recall_hit(runner.store(), embedder.as_ref(), "bob", now);
    let northwind = recall_hit(runner.store(), embedder.as_ref(), "northwind", now);
    let portland = recall_hit(runner.store(), embedder.as_ref(), "portland", now);
    let map = runner.store().brain_map().expect("map");
    let claim_sentences: Vec<String> = map
        .nodes
        .iter()
        .filter(|node| node.kind == maia_store::BrainNodeKind::Claim)
        .filter_map(|node| node.sentence.clone())
        .collect();
    let vectors = claims
        .iter()
        .filter(|id| {
            runner
                .store()
                .embedding(EmbeddingTarget::Claim, id)
                .ok()
                .flatten()
                .is_some()
        })
        .count();

    println!("live model id: auto");
    println!("live promotion claims produced: {claim_sentences:?}");
    println!("claim ids: {claims:?}");
    println!("malformed/queued retries: {malformed}");
    println!("latency_ms per call: {latencies_ms:?}");
    println!("tokens per call: {token_counts:?}");
    println!("vector rows for new claims: {vectors}");
    println!("recall bob: {bob}");
    println!("recall northwind: {northwind}");
    println!("recall portland: {portland}");

    assert!(saw_smalltalk, "small talk was not code-skipped");
    assert!(
        !claim_sentences.is_empty(),
        "expected at least one claim from the live promoter"
    );
    assert!(
        bob || northwind || portland,
        "expected cross-thread recall for a planted fact"
    );
    let _ = std::fs::remove_file(&path);
}

const KITCHEN: &str = "The kitchen is in Portland.";
const ZEPHYR: &str = "Zephyr holds the indigo token.";

#[test]
#[ignore = "live freellmapi co-use check; run with --ignored"]
fn live_chat_thickens_a_co_use_path() {
    let env = load_promoter();
    assert!(env.base_url().starts_with("http"), "base url missing");
    assert_eq!(env.model(), "auto");
    let path = temp_db();
    let now = 1_735_200_000_i64;
    let store = SqliteOwner::open(OwnerOpen {
        path: path.clone(),
        now,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("temp store");
    store
        .append(AppendEvents {
            thread_id: "thread-live-path".to_owned(),
            expected_version: 0,
            participants: "owner".to_owned(),
            occurred_at: now,
            events: vec![ThreadEventWrite {
                event_id: "thread-live-path-open".to_owned(),
                kind: "system".to_owned(),
                body: "open".to_owned(),
            }],
        })
        .expect("thread");
    store
        .insert_episode(EpisodeWrite {
            episode_id: "episode-path".to_owned(),
            thread_id: "thread-live-path".to_owned(),
            turn_id: "turn-path".to_owned(),
            body: format!("{KITCHEN} {ZEPHYR}"),
            taint: MemoryTaint::Trusted,
            reasoning: None,
            participants: "owner".to_owned(),
            created_at: now,
            segments: vec![SegmentWrite {
                text: format!("{KITCHEN} {ZEPHYR}"),
                taint: MemoryTaint::Trusted,
                sources: "owner".to_owned(),
            }],
        })
        .expect("episode");
    store
        .apply_promotion(PromotionWrite {
            episode_id: "episode-path".to_owned(),
            model: "auto".to_owned(),
            now,
            claims: vec![
                PromotionClaimWrite {
                    claim_id: "claim-kitchen".to_owned(),
                    sentence: KITCHEN.to_owned(),
                    taint: MemoryTaint::Trusted,
                    valid_from: now,
                    lexemes: vec!["kitchen".to_owned(), "portland".to_owned()],
                },
                PromotionClaimWrite {
                    claim_id: "claim-zephyr".to_owned(),
                    sentence: ZEPHYR.to_owned(),
                    taint: MemoryTaint::Trusted,
                    valid_from: now,
                    lexemes: vec!["zephyr".to_owned(), "indigo".to_owned(), "token".to_owned()],
                },
            ],
            same_claim_ids: Vec::new(),
            replacements: Vec::new(),
            links: Vec::new(),
        })
        .expect("claims");
    let before_recall = recall_has_zephyr(&store, now);
    let before_weight = co_use_millis(&store);
    println!("co-use weight before chat: {before_weight}");
    println!("portland recall includes zephyr before chat: {before_recall}");

    let router = router_from_connection(env.base_url(), env.api_key().as_str(), "auto")
        .expect("live router");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let (router, _install) = RuntimeRouter::spawn_with_install(runtime.handle().clone(), router);
    let mut ids = IdSupply::at(now);
    for n in 1_u64..48 {
        ids.messages.push_back(format!("live-m-{n}"));
        ids.tasks.push_back(format!("live-task-{n}"));
        ids.attempts.push_back(format!("live-attempt-{n}"));
        ids.envelopes.push_back(format!("live-envelope-{n}"));
        ids.reports.push_back(format!("live-report-{n}"));
        ids.calls.push_back(format!("live-call-{n}"));
        ids.evidence.push_back(format!("live-evidence-{n}"));
        ids.snapshots.push_back(format!("live-snapshot-{n}"));
        ids.criteria.push_back(format!("live-criterion-{n}"));
        ids.children.push_back(format!("live-child-{n}"));
        ids.requests.push_back(n);
        ids.commands.push_back(n);
    }
    let mut host = Orchestrator::create(
        router,
        store,
        ScriptedToolHost::create(),
        OrchestratorConfig {
            policy: accepted_routing_policy(),
            ids,
            turn: RouterTurn {
                model: "auto".to_owned(),
                reasoning: ReasoningEffort::Low,
                prefix_hash: PrefixHash::new("live-prefix"),
            },
            profile: SecurityProfile::Protected,
            parent_work: ParentWork::Script,
        },
    );
    let prompt = format!(
        "Call success. Its message must be exactly these two sentences and no other words: {KITCHEN} {ZEPHYR}"
    );
    let mut admitted = 0_u32;
    for turn in 1..=3 {
        let result = drive(host.handle_user_message(&prompt));
        if result.is_ok() {
            admitted += 1;
            println!("turn {turn}: admitted");
        } else {
            println!("turn {turn}: failed");
        }
    }
    let after_weight = co_use_millis(host.store());
    let after_recall = recall_has_zephyr(host.store(), now);
    let echoed = replies_echo_both(&path);
    println!("turns admitted: {admitted}");
    println!("replies that contain both exact sentences: {echoed}");
    println!("co-use weight after chat: {after_weight}");
    println!("portland recall includes zephyr after chat: {after_recall}");
    assert!(!before_recall, "zephyr was reachable before any co-use");
    assert_eq!(before_weight, 0);
    if echoed == 3 {
        assert!(
            after_weight > before_weight,
            "echoed replies did not thicken co-use"
        );
        assert!(
            after_recall,
            "zephyr was not recalled through the portland path"
        );
    }
    let _ = std::fs::remove_file(&path);
}

fn co_use_millis(store: &SqliteOwner) -> i64 {
    store
        .brain_map()
        .expect("map")
        .edges
        .iter()
        .filter(|edge| edge.kind == "co_use")
        .map(|edge| edge.weight_millis)
        .sum()
}

fn recall_has_zephyr(store: &SqliteOwner, now: i64) -> bool {
    bounded_recall(store, "portland", Timestamp(now), None).is_some_and(|packed| {
        packed
            .items
            .iter()
            .any(|item| item.sentence.contains("Zephyr"))
    })
}

fn drive<T>(future: impl Future<Output = T>) -> T {
    struct Parker {
        ready: Mutex<bool>,
        signal: Condvar,
    }

    impl Wake for Parker {
        fn wake(self: Arc<Self>) {
            let Ok(mut ready) = self.ready.lock() else {
                return;
            };
            *ready = true;
            self.signal.notify_one();
        }
    }

    let parker = Arc::new(Parker {
        ready: Mutex::new(false),
        signal: Condvar::new(),
    });
    let waker = Waker::from(Arc::clone(&parker));
    let mut context = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    loop {
        match Pin::as_mut(&mut future).poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => {
                let Ok(mut ready) = parker.ready.lock() else {
                    continue;
                };
                while !*ready {
                    ready = parker
                        .signal
                        .wait(ready)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
                *ready = false;
            }
        }
    }
}

fn replies_echo_both(path: &PathBuf) -> u32 {
    let connection = rusqlite::Connection::open(path).expect("read replies");
    let mut statement = connection
        .prepare("SELECT body FROM router_messages WHERE role = 'assistant'")
        .expect("replies");
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("rows");
    rows.flatten()
        .filter(|body| body.contains(KITCHEN) && body.contains(ZEPHYR))
        .count() as u32
}
