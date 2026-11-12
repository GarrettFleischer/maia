//! Composition root for the loopback Super Agent daemon.
//!
//! This process loads provider settings, discovers a model id, and serves the
//! UI and API on `127.0.0.1:4178`. It does not log credentials or provider URLs.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use maia_core::credit::PrefixHash;
use maia_core::router::ReasoningEffort;
use maia_core::security::SecurityProfile;
use maia_daemon::HttpIdSupply;
use maia_daemon::IdSupply;
use maia_daemon::ModelPorts;
use maia_daemon::Orchestrator;
use maia_daemon::OrchestratorConfig;
use maia_daemon::ParentWork;
use maia_daemon::PromotionCaps;
use maia_daemon::PromotionRunner;
use maia_daemon::PublicModelConnection;
use maia_daemon::RouterPromoter;
use maia_daemon::RouterTurn;
use maia_daemon::RuntimeRouter;
use maia_daemon::ScriptedToolHost;
use maia_daemon::discover_model_id;
use maia_daemon::live_model_lister;
use maia_daemon::native_router_key_store;
use maia_daemon::open_candle_claim_embedder;
use maia_daemon::open_routing_policy;
use maia_daemon::parse_reasoning_effort;
use maia_daemon::read_model_env;
use maia_daemon::read_promoter_env;
use maia_daemon::router_from_connection;
use maia_daemon::serve_super_agent_with_model;
use maia_daemon::validate_runtime_snapshot;
use maia_store::OwnerOpen;
use maia_store::RuntimeHttpIdReservation;
use maia_store::RuntimeIdSeeds;
use maia_store::RuntimeSnapshot;
use maia_store::SqliteOwner;

fn main() -> ExitCode {
    let args = std::env::args().collect::<Vec<_>>();
    if let Some(parsed) = maia_daemon::parse_brain_args(&args) {
        return match parsed {
            Ok(command) => match run_brain_command(&command) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("{error}");
                    ExitCode::FAILURE
                }
            },
            Err(message) => {
                eprintln!("{message}");
                ExitCode::FAILURE
            }
        };
    }
    match boot() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run_brain_command(command: &maia_daemon::BrainCli) -> Result<(), BootError> {
    let now = unix_seconds();
    let database = database_path(std::env::var("MAIA_DATABASE").ok().as_deref());
    if let Some(parent) = database.parent() {
        std::fs::create_dir_all(parent).map_err(|_| BootError::Store)?;
    }
    copy_pre_fts_backup(&database)?;
    let store = SqliteOwner::open(OwnerOpen {
        path: database,
        now,
        normal_capacity: 4,
        panic_capacity: 1,
    })
    .map_err(|_| BootError::Store)?;
    match command.verb {
        maia_daemon::BrainVerb::Export => {
            let report = store
                .export_brain_markdown(&command.directory, now)
                .map_err(|_| BootError::Store)?;
            println!("exported {} notes, {} edges", report.neurons, report.edges);
        }
        maia_daemon::BrainVerb::Import => {
            let report = store
                .import_brain_markdown(&command.directory, now)
                .map_err(|_| BootError::Store)?;
            println!("imported {} notes, {} edges", report.neurons, report.edges);
        }
        maia_daemon::BrainVerb::Sync => {
            let report = store
                .sync_brain_markdown(&command.directory, now)
                .map_err(|_| BootError::Store)?;
            println!(
                "synced created {} updated {} deleted {} conflicts {}",
                report.created,
                report.updated,
                report.soft_deleted,
                report.conflicts.len()
            );
        }
    }
    store.shutdown().map_err(|_| BootError::Store)?;
    Ok(())
}

/// Copies `maia.sqlite` to `maia.sqlite.pre-fts.bak` once, next to the file.
///
/// Other database names are left alone so tests and spare databases are not copied.
fn copy_pre_fts_backup(path: &std::path::Path) -> Result<(), BootError> {
    if path.file_name().and_then(|name| name.to_str()) != Some("maia.sqlite") {
        return Ok(());
    }
    if !path.is_file() {
        return Ok(());
    }
    let backup = path.with_file_name("maia.sqlite.pre-fts.bak");
    if backup.exists() {
        return Ok(());
    }
    std::fs::copy(path, &backup).map_err(|_| BootError::Store)?;
    Ok(())
}

fn attach_subagent_tools<R: maia_core::router::Router>(orchestrator: &mut Orchestrator<R>) {
    let _ = std::fs::create_dir_all(PathBuf::from("data").join("workspace"));
    let specs = std::fs::read_to_string("mcp.json")
        .ok()
        .and_then(|text| maia_tools::parse_server_config(&text).ok())
        .unwrap_or_default();
    orchestrator.attach_subagent(maia_tools::SubagentHost::open(&specs));
}

struct ChosenConnection {
    base_url: String,
    api_key: String,
    model: String,
    reasoning: ReasoningEffort,
    from_settings: bool,
}

fn boot() -> Result<(), BootError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| BootError::Server)?;
    let now = unix_seconds();
    let database = database_path(std::env::var("MAIA_DATABASE").ok().as_deref());
    let port = bind_port(std::env::var("MAIA_PORT").ok().as_deref())?;
    if let Some(parent) = database.parent() {
        std::fs::create_dir_all(parent).map_err(|_| BootError::Store)?;
    }
    copy_pre_fts_backup(&database)?;
    let store = SqliteOwner::open(OwnerOpen {
        path: database.clone(),
        now,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .map_err(|_| BootError::Store)?;
    probe_vector_tables(&store)?;
    let promoter = load_promoter_env()?;
    let promo_store = SqliteOwner::open(OwnerOpen {
        path: database.clone(),
        now,
        normal_capacity: 4,
        panic_capacity: 1,
    })
    .map_err(|_| BootError::Store)?;
    let promo_router = router_from_connection(
        promoter.base_url(),
        promoter.api_key().as_str(),
        promoter.model(),
    )
    .map_err(|_| BootError::Router)?;
    let embedder = claim_embedder_from_env();
    let mut runner = PromotionRunner::new(
        promo_store,
        RouterPromoter::new(promo_router, promoter.model()),
        promoter.model(),
        PromotionCaps {
            daily_call_cap: promoter.daily_call_cap(),
            daily_token_cap: promoter.daily_token_cap(),
            failure_limit: 3,
        },
        Arc::new(unix_seconds),
    );
    if let Some(embedder) = embedder.clone() {
        runner = runner.with_embedder(embedder);
    }
    std::thread::Builder::new()
        .name("maia-promotion".to_owned())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let _ = runner.promote_one();
            }
        })
        .map_err(|_| BootError::Server)?;
    let saved = store.model_connection().map_err(|_| BootError::Store)?;
    let keys = native_router_key_store();
    let stored_key = keys.read_key().map_err(|_| BootError::Store)?;
    let chosen = match (saved, stored_key) {
        (Some(row), Some(api_key)) => match parse_reasoning_effort(&row.reasoning) {
            Ok(reasoning) => ChosenConnection {
                base_url: row.base_url,
                api_key,
                model: row.model_id,
                reasoning,
                from_settings: true,
            },
            Err(_) => connection_from_env(&runtime)?,
        },
        _ => connection_from_env(&runtime)?,
    };
    let router = router_from_connection(&chosen.base_url, &chosen.api_key, &chosen.model)
        .map_err(|_| BootError::Router)?;
    let (proxy, install) = RuntimeRouter::spawn_with_install(runtime.handle().clone(), router);
    let (snapshot, supplies) = prepare_runtime(&store, now)?;
    let mut orchestrator = Orchestrator::restore(
        proxy,
        store,
        ScriptedToolHost::create(),
        OrchestratorConfig {
            policy: open_routing_policy(),
            ids: supplies.orchestrator,
            turn: RouterTurn {
                model: chosen.model.clone(),
                reasoning: chosen.reasoning,
                prefix_hash: PrefixHash::new("super-agent"),
            },
            profile: SecurityProfile::Protected,
            parent_work: ParentWork::ModelTurn,
        },
        snapshot,
    )
    .map_err(|_| BootError::Store)?;
    if let Some(embedder) = embedder {
        orchestrator.set_recall_embedder(embedder);
    }
    attach_subagent_tools(&mut orchestrator);
    let fallback = if chosen.from_settings {
        PublicModelConnection {
            base_url: String::new(),
            key_set: false,
            model: String::new(),
            reasoning: chosen.reasoning,
        }
    } else {
        PublicModelConnection {
            base_url: chosen.base_url.clone(),
            key_set: true,
            model: chosen.model.clone(),
            reasoning: chosen.reasoning,
        }
    };
    let boot_key = if chosen.from_settings {
        None
    } else {
        Some(chosen.api_key)
    };
    let server = serve_super_agent_with_model(
        orchestrator,
        database,
        PathBuf::from("frontend").join("dist"),
        std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
        supplies.http,
        ModelPorts {
            keys,
            boot_key,
            install: Some(install),
            list_models: live_model_lister(),
            fallback,
            mcp_secrets: std::sync::Arc::new(maia_daemon::NativeMcpSecretStore),
        },
    )
    .map_err(|_| BootError::Server)?;
    server.wait();
    drop(runtime);
    Ok(())
}

fn connection_from_env(runtime: &tokio::runtime::Runtime) -> Result<ChosenConnection, BootError> {
    let model_env = load_model_env()?;
    let model = runtime
        .block_on(discover_model_id(
            model_env.base_url(),
            model_env.api_key().as_str(),
        ))
        .map_err(|_| BootError::Discovery)?;
    Ok(ChosenConnection {
        base_url: model_env.base_url().to_owned(),
        api_key: model_env.api_key().as_str().to_owned(),
        model,
        reasoning: ReasoningEffort::Low,
        from_settings: false,
    })
}

fn load_model_env() -> Result<maia_daemon::ModelEnv, BootError> {
    let _ = dotenvy::dotenv();
    let base_url = std::env::var("BASE_URL").unwrap_or_default();
    let api_key = std::env::var("API_KEY").unwrap_or_default();
    read_model_env(&[
        ("BASE_URL", base_url.as_str()),
        ("API_KEY", api_key.as_str()),
    ])
    .map_err(|_| BootError::Env)
}

fn load_promoter_env() -> Result<maia_daemon::PromoterEnv, BootError> {
    let _ = dotenvy::dotenv();
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
        (
            "PROMOTER_MODEL",
            std::env::var("PROMOTER_MODEL").unwrap_or_default(),
        ),
        (
            "PROMOTER_DAILY_CALL_CAP",
            std::env::var("PROMOTER_DAILY_CALL_CAP").unwrap_or_default(),
        ),
        (
            "PROMOTER_DAILY_TOKEN_CAP",
            std::env::var("PROMOTER_DAILY_TOKEN_CAP").unwrap_or_default(),
        ),
    ];
    let refs: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    read_promoter_env(&refs).map_err(|_| BootError::Env)
}

fn probe_vector_tables(store: &SqliteOwner) -> Result<(), BootError> {
    store.probe_vector_write().map_err(|_| BootError::Vectors)
}

fn claim_embedder_from_env() -> Option<Arc<dyn maia_daemon::ClaimEmbedder>> {
    let weights = std::env::var("MAIA_EMBEDDER_WEIGHTS").ok()?;
    let tokenizer = std::env::var("MAIA_EMBEDDER_TOKENIZER").ok()?;
    open_candle_claim_embedder(&weights, &tokenizer)
}

struct RuntimeSupplies {
    orchestrator: IdSupply,
    http: HttpIdSupply,
}

const RUNTIME_ID_BLOCK_SIZE: u64 = 4096;

fn prepare_runtime(
    store: &SqliteOwner,
    now: i64,
) -> Result<(RuntimeSnapshot, RuntimeSupplies), BootError> {
    let snapshot = store.runtime_snapshot().map_err(|_| BootError::Store)?;
    validate_runtime_snapshot(&snapshot).map_err(|_| BootError::Store)?;
    let reserved = store
        .reserve_runtime_id_block(RUNTIME_ID_BLOCK_SIZE)
        .map_err(|_| BootError::Store)?;
    let (seeds, http) = reserved.into_parts();
    let supplies = runtime_supply(now, seeds, http).map_err(|_| BootError::Store)?;
    Ok((snapshot, supplies))
}

fn runtime_supply(
    now: i64,
    seeds: RuntimeIdSeeds,
    http: RuntimeHttpIdReservation,
) -> Result<RuntimeSupplies, SupplyError> {
    let count = http.count();
    let mut ids = IdSupply::at(now);
    push_text_ids(&mut ids.messages, "m-", seeds.message, count)?;
    push_text_ids(&mut ids.tasks, "task-", seeds.task, count)?;
    push_text_ids(&mut ids.attempts, "attempt-", seeds.attempt, count)?;
    push_text_ids(&mut ids.envelopes, "env-", seeds.envelope, count)?;
    push_text_ids(&mut ids.reports, "report-", seeds.report, count)?;
    push_text_ids(&mut ids.calls, "call-", seeds.call, count)?;
    push_text_ids(&mut ids.evidence, "evidence-", seeds.evidence, count)?;
    push_text_ids(&mut ids.snapshots, "snap-", seeds.snapshot, count)?;
    push_text_ids(&mut ids.criteria, "criterion-", seeds.criterion, count)?;
    push_text_ids(&mut ids.children, "child-", seeds.child, count)?;
    push_numeric_ids(&mut ids.requests, seeds.request, count)?;
    push_numeric_ids(&mut ids.commands, seeds.command, count)?;
    Ok(RuntimeSupplies {
        orchestrator: ids,
        http: HttpIdSupply::from_reserved(http).map_err(|_| SupplyError::IdOverflow)?,
    })
}

fn push_text_ids(
    queue: &mut std::collections::VecDeque<String>,
    prefix: &str,
    first: u64,
    count: u64,
) -> Result<(), SupplyError> {
    for offset in 0_u64..count {
        let value = first.checked_add(offset).ok_or(SupplyError::IdOverflow)?;
        queue.push_back(format!("{prefix}{value}"));
    }
    Ok(())
}

fn push_numeric_ids(
    queue: &mut std::collections::VecDeque<u64>,
    first: u64,
    count: u64,
) -> Result<(), SupplyError> {
    for offset in 0_u64..count {
        queue.push_back(first.checked_add(offset).ok_or(SupplyError::IdOverflow)?);
    }
    Ok(())
}

fn database_path(configured: Option<&str>) -> PathBuf {
    match configured.map(str::trim).filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from("data").join("maia.sqlite"),
    }
}

fn bind_port(configured: Option<&str>) -> Result<u16, BootError> {
    match configured.map(str::trim).filter(|value| !value.is_empty()) {
        Some(text) => text.parse().map_err(|_| BootError::Server),
        None => Ok(4178),
    }
}

fn unix_seconds() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_secs()).unwrap_or(0),
        Err(_) => 0,
    }
}

#[derive(Debug)]
enum BootError {
    Env,
    Discovery,
    Router,
    Store,
    Vectors,
    Server,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SupplyError {
    IdOverflow,
}

impl std::fmt::Display for BootError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::Env => "Model provider is not configured.",
            Self::Discovery | Self::Router => "The model provider is unavailable.",
            Self::Store => "The task store is unavailable.",
            Self::Vectors => "Vector tables could not be written.",
            Self::Server => "The local UI server could not start.",
        };
        formatter.write_str(text)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    use super::*;
    use maia_store::RouterMessageWrite;
    use maia_store::RuntimeIdNamespace;
    use maia_store::RuntimeIdSeeds;
    use maia_store::StoreError;
    use maia_store::TaskInputWrite;
    use maia_store::TaskWrite;
    use rusqlite::Connection;

    static RESERVATION_SEQ: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn database_and_port_stay_on_the_release_defaults_unless_configured() {
        assert_eq!(
            database_path(None),
            PathBuf::from("data").join("maia.sqlite")
        );
        assert_eq!(
            database_path(Some("  ")),
            PathBuf::from("data").join("maia.sqlite")
        );
        assert_eq!(
            database_path(Some(r"C:\temp\maia.sqlite")),
            PathBuf::from(r"C:\temp\maia.sqlite")
        );
        assert_eq!(bind_port(None).ok(), Some(4178));
        assert_eq!(bind_port(Some("")).ok(), Some(4178));
        assert_eq!(bind_port(Some("4181")).ok(), Some(4181));
        assert!(bind_port(Some("nope")).is_err());
    }

    #[test]
    fn production_boot_constructs_http_supply_from_owner_reservation() {
        let database = std::env::temp_dir().join(format!(
            "maia-daemon-runtime-reservation-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&database);
        let owner = SqliteOwner::open(OwnerOpen {
            path: database.clone(),
            now: 1,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("owner");

        let (_, mut supplies) = prepare_runtime(&owner, 2).expect("prepare runtime");

        assert_eq!(
            supplies.orchestrator.messages.pop_front().as_deref(),
            Some("m-1")
        );
        assert_eq!(
            supplies.orchestrator.tasks.pop_front().as_deref(),
            Some("task-1")
        );
        assert_eq!(
            supplies.orchestrator.attempts.pop_front().as_deref(),
            Some("attempt-1")
        );
        assert_eq!(
            supplies.orchestrator.envelopes.pop_front().as_deref(),
            Some("env-1")
        );
        assert_eq!(
            supplies.orchestrator.reports.pop_front().as_deref(),
            Some("report-1")
        );
        assert_eq!(
            supplies.orchestrator.calls.pop_front().as_deref(),
            Some("call-1")
        );
        assert_eq!(
            supplies.orchestrator.evidence.pop_front().as_deref(),
            Some("evidence-1")
        );
        assert_eq!(
            supplies.orchestrator.snapshots.pop_front().as_deref(),
            Some("snap-1")
        );
        assert_eq!(
            supplies.orchestrator.criteria.pop_front().as_deref(),
            Some("criterion-1")
        );
        assert_eq!(supplies.orchestrator.requests.pop_front(), Some(1));
        assert_eq!(
            supplies.orchestrator.children.pop_front().as_deref(),
            Some("child-1")
        );
        assert_eq!(supplies.orchestrator.commands.pop_front(), Some(1));
        assert_eq!(supplies.http.next_detail(), 1);
        assert_eq!(supplies.http.next_decision(), 1);
        let connection = Connection::open(&database).expect("read high water");
        let reserved: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_id_high_water WHERE value = '4096'",
                [],
                |row| row.get(0),
            )
            .expect("reserved rows");
        assert_eq!(reserved, 14);
        owner.shutdown().expect("shutdown");
        let _ = std::fs::remove_file(database);
    }

    #[test]
    fn corrupt_snapshot_does_not_reserve_runtime_ids() {
        let database = std::env::temp_dir().join(format!(
            "maia-daemon-invalid-runtime-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&database);
        let owner = SqliteOwner::open(OwnerOpen {
            path: database.clone(),
            now: 1,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("owner");
        owner
            .insert_task(TaskWrite {
                task_id: "task-1".to_owned(),
                phase: "queued".to_owned(),
                title: "corrupt".to_owned(),
                pin: "unpinned".to_owned(),
                completion_view: "unopened".to_owned(),
                prior_task_id: None,
                created_at: 1,
                attempt_id: "attempt-1".to_owned(),
                attempt_state: "active".to_owned(),
            })
            .expect("corrupt task fixture");

        assert!(prepare_runtime(&owner, 2).is_err());
        let connection = Connection::open(&database).expect("read high water");
        let consumed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_id_high_water WHERE value <> '0'",
                [],
                |row| row.get(0),
            )
            .expect("consumed rows");
        assert_eq!(consumed, 0);
        owner.shutdown().expect("shutdown");
        let _ = std::fs::remove_file(database);
    }

    #[test]
    fn production_restart_allocates_exact_next_ids_without_collision() {
        let seeds = RuntimeIdSeeds {
            message: 101,
            task: 102,
            attempt: 103,
            envelope: 104,
            report: 105,
            call: 106,
            evidence: 107,
            snapshot: 108,
            criterion: 109,
            request: 110,
            child: 111,
            detail: 112,
            decision: 113,
            command: 114,
        };

        let (seeds, http) = test_reservation(seeds, 4096).expect("test reservation");
        let mut supplies = runtime_supply(2, seeds, http).expect("runtime supplies");

        assert_eq!(
            supplies.orchestrator.messages.pop_front().as_deref(),
            Some("m-101")
        );
        assert_eq!(
            supplies.orchestrator.tasks.pop_front().as_deref(),
            Some("task-102")
        );
        assert_eq!(
            supplies.orchestrator.attempts.pop_front().as_deref(),
            Some("attempt-103")
        );
        assert_eq!(
            supplies.orchestrator.envelopes.pop_front().as_deref(),
            Some("env-104")
        );
        assert_eq!(
            supplies.orchestrator.reports.pop_front().as_deref(),
            Some("report-105")
        );
        assert_eq!(
            supplies.orchestrator.calls.pop_front().as_deref(),
            Some("call-106")
        );
        assert_eq!(
            supplies.orchestrator.evidence.pop_front().as_deref(),
            Some("evidence-107")
        );
        assert_eq!(
            supplies.orchestrator.snapshots.pop_front().as_deref(),
            Some("snap-108")
        );
        assert_eq!(
            supplies.orchestrator.criteria.pop_front().as_deref(),
            Some("criterion-109")
        );
        assert_eq!(
            supplies.orchestrator.children.pop_front().as_deref(),
            Some("child-111")
        );
        assert_eq!(supplies.orchestrator.requests.pop_front(), Some(110));
        assert_eq!(supplies.orchestrator.commands.pop_front(), Some(114));
        assert_eq!(supplies.http.next_detail(), 112);
        assert_eq!(supplies.http.next_decision(), 113);
    }

    #[test]
    fn runtime_supply_does_not_reuse_a_persisted_message_id_after_restart() {
        let database = std::env::temp_dir().join(format!(
            "maia-daemon-message-restart-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&database);
        let owner = SqliteOwner::open(OwnerOpen {
            path: database.clone(),
            now: 1,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("first owner");
        owner
            .insert_router_message(RouterMessageWrite {
                message_id: "m-1".to_owned(),
                role: "user".to_owned(),
                body: "before restart".to_owned(),
                created_at: 1,
            })
            .expect("persist message");
        owner
            .insert_task(TaskWrite {
                task_id: "task-1".to_owned(),
                phase: "queued".to_owned(),
                title: "Restart fixture".to_owned(),
                pin: "unpinned".to_owned(),
                completion_view: "unopened".to_owned(),
                prior_task_id: None,
                created_at: 1,
                attempt_id: "attempt-1".to_owned(),
                attempt_state: "active".to_owned(),
            })
            .expect("persist task");
        owner
            .insert_task_input(TaskInputWrite {
                task_id: "task-1".to_owned(),
                message_id: "m-2".to_owned(),
                prompt: b"continuation".to_vec(),
            })
            .expect("persist continuation message");
        owner
            .insert_router_message(RouterMessageWrite {
                message_id: "m-3".to_owned(),
                role: "assistant".to_owned(),
                body: "after a continuation consumed m-2".to_owned(),
                created_at: 1,
            })
            .expect("persist later message");
        owner.shutdown().expect("first shutdown");

        let owner = SqliteOwner::open(OwnerOpen {
            path: database.clone(),
            now: 2,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("restarted owner");
        let reserved = owner
            .reserve_runtime_id_block(4096)
            .expect("reserve runtime ids");
        let (seeds, http) = reserved.into_parts();
        let mut supplies = runtime_supply(2, seeds, http).expect("runtime supply");
        let next = supplies
            .orchestrator
            .messages
            .pop_front()
            .expect("next message id");

        assert_eq!(next, "m-4");
        assert_eq!(
            supplies.orchestrator.messages.front().map(String::as_str),
            Some("m-5")
        );
        owner
            .insert_router_message(RouterMessageWrite {
                message_id: next,
                role: "user".to_owned(),
                body: "after restart".to_owned(),
                created_at: 2,
            })
            .expect("persist message after restart");

        owner.shutdown().expect("restarted shutdown");
        let _ = std::fs::remove_file(database);
    }

    #[test]
    fn runtime_supply_accepts_the_last_complete_u64_range() {
        let (seeds, http) =
            test_reservation(uniform_seeds(u64::MAX - 4095), 4096).expect("last reservation");
        let supplies = runtime_supply(2, seeds, http).expect("last complete range");

        assert_eq!(supplies.orchestrator.messages.len(), 4096);
        assert_eq!(
            supplies.orchestrator.messages.back().map(String::as_str),
            Some("m-18446744073709551615")
        );
    }

    #[test]
    fn runtime_supply_rejects_an_incomplete_u64_range() {
        assert!(test_reservation(uniform_seeds(u64::MAX - 4094), 4096).is_err());
    }

    fn uniform_seeds(first: u64) -> RuntimeIdSeeds {
        RuntimeIdSeeds {
            message: first,
            task: first,
            attempt: first,
            envelope: first,
            report: first,
            call: first,
            evidence: first,
            snapshot: first,
            criterion: first,
            request: first,
            child: first,
            detail: first,
            decision: first,
            command: first,
        }
    }

    fn test_reservation(
        first: RuntimeIdSeeds,
        count: u64,
    ) -> Result<(RuntimeIdSeeds, RuntimeHttpIdReservation), StoreError> {
        let sequence = RESERVATION_SEQ.fetch_add(1, Ordering::Relaxed);
        let database = std::env::temp_dir().join(format!(
            "maia-daemon-test-reservation-{}-{sequence}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&database);
        let owner = SqliteOwner::open(OwnerOpen {
            path: database.clone(),
            now: 1,
            normal_capacity: 8,
            panic_capacity: 2,
        })?;
        let connection = Connection::open(&database).map_err(StoreError::from)?;
        for namespace in RuntimeIdNamespace::ALL {
            let consumed = first.value(namespace).checked_sub(1).ok_or_else(|| {
                StoreError::InvalidRequest {
                    message: "test reservation must start above zero".to_owned(),
                }
            })?;
            connection
                .execute(
                    "UPDATE runtime_id_high_water SET value = ?2 WHERE namespace = ?1",
                    rusqlite::params![namespace.key(), consumed.to_string()],
                )
                .map_err(StoreError::from)?;
        }
        drop(connection);
        let reserved = owner.reserve_runtime_id_block(count)?;
        owner.shutdown()?;
        let _ = std::fs::remove_file(database);
        Ok(reserved.into_parts())
    }
}
