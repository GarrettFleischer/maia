//! Loopback Super Agent HTTP, websocket, static shell, and model-list contracts.
//!
//! Fixtures are created in this file. These tests do not read `.env` or process
//! provider variables.

use std::future::Future;
use std::io::Read;
use std::io::Write;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;
use std::thread;
use std::time::Duration;

use futures_util::SinkExt;
use futures_util::StreamExt;
use maia_core::audit::RequestId;
use maia_core::credit::PrefixHash;
use maia_core::router::CanonicalJson;
use maia_core::router::FinishReason;
use maia_core::router::ReasoningEffort;
use maia_core::router::Router;
use maia_core::router::RouterError;
use maia_core::router::RouterRequest;
use maia_core::router::RouterResponse;
use maia_core::router::RouterUsage;
use maia_core::router::UsageValue;
use maia_core::security::SecurityProfile;
use maia_core::security::Taint;
use maia_core::super_agent::CallId;
use maia_core::super_agent::Confidence;
use maia_core::super_agent::FactId;
use maia_core::super_agent::MemoryId;
use maia_core::super_agent::MemoryProvenance;
use maia_core::super_agent::ProposalShape;
use maia_core::super_agent::ProposedRouteDecision;
use maia_core::super_agent::RankedMemory;
use maia_core::super_agent::RouteProposal;
use maia_core::super_agent::SessionRole;
use maia_core::super_agent::TaskId;
use maia_daemon::CompletionEvidence;
use maia_daemon::HttpIdSupply;
use maia_daemon::IdSupply;
use maia_daemon::ModelListError;
use maia_daemon::Orchestrator;
use maia_daemon::OrchestratorConfig;
use maia_daemon::ParentWork;
use maia_daemon::RouterTurn;
use maia_daemon::RuntimeRouter;
use maia_daemon::ScriptedCall;
use maia_daemon::ScriptedToolHost;
use maia_daemon::ServeFailure;
use maia_daemon::accepted_routing_policy;
use maia_daemon::coalesce_sidebar;
use maia_daemon::discover_model_id_bounded;
use maia_daemon::named_tool_response;
use maia_daemon::parse_model_ids;
use maia_daemon::present_router_body;
use maia_daemon::route_tool_response;
use maia_daemon::select_model_id;
use maia_daemon::serve_super_agent_with_ids;
use maia_daemon::ui_bind_addr;
use maia_store::AppendEvents;
use maia_store::AttachmentWrite;
use maia_store::CoUseWrite;
use maia_store::ConsolidationWrite;
use maia_store::EntityScope;
use maia_store::EntityWrite;
use maia_store::EpisodeWrite;
use maia_store::EvidenceSource;
use maia_store::FactWrite;
use maia_store::HeatWrite;
use maia_store::HoldTarget;
use maia_store::LedgerWrite;
use maia_store::MemoryKind;
use maia_store::MemoryTaint;
use maia_store::MessageSubmissionWrite;
use maia_store::NegativeMarkWrite;
use maia_store::OwnerOpen;
use maia_store::PresentationWrite;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionWrite;
use maia_store::RouterMessageWrite;
use maia_store::SegmentWrite;
use maia_store::SqliteOwner;
use maia_store::SupersedeWrite;
use maia_store::ThreadEventWrite;
use rusqlite::Connection;
use serde_json::Value;
use serde_json::json;

const NOW: i64 = 1_735_000_000;
const LEAK: &str = "sk-fixture-do-not-leak";
const USER_TEXT: &str = "Add a pin control — café";

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct ScriptedRouter {
    inner: Arc<Mutex<RouterScript>>,
}

struct RouterScript {
    replies: std::collections::VecDeque<ScriptedReply>,
    requests: usize,
    bodies: Vec<String>,
}

enum ScriptedReply {
    Proposal(RouteProposal),
    Tool { name: String, arguments: String },
    Fail(String),
    Server { code: u16 },
}

impl ScriptedRouter {
    fn create() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RouterScript {
                replies: std::collections::VecDeque::new(),
                requests: 0,
                bodies: Vec::new(),
            })),
        }
    }

    fn push_proposal(&self, proposal: RouteProposal) {
        self.push(ScriptedReply::Proposal(proposal));
        self.push(ScriptedReply::Tool {
            name: "success".to_owned(),
            arguments: r#"{"message":"Done."}"#.to_owned(),
        });
    }

    fn push_host_ask(&self, proposal: RouteProposal) {
        self.push(ScriptedReply::Proposal(proposal));
    }

    fn push_fail(&self, detail: String) {
        self.push(ScriptedReply::Fail(detail));
    }

    fn push_server(&self, code: u16) {
        self.push(ScriptedReply::Server { code });
    }

    fn push(&self, reply: ScriptedReply) {
        self.inner
            .lock()
            .expect("router lock")
            .replies
            .push_back(reply);
    }

    fn request_count(&self) -> usize {
        self.inner.lock().expect("router lock").requests
    }

    fn saw(&self, needle: &str) -> bool {
        self.inner
            .lock()
            .expect("router lock")
            .bodies
            .iter()
            .any(|body| body.contains(needle))
    }
}

fn auxiliary_reply(request: &RouterRequest) -> Option<String> {
    let text = request.messages.first()?.content.as_str();
    if text.starts_with("Maia goal contract.") {
        return Some(
            r#"{"requirements":["Do the requested work."],"done_criteria":["The requested work is finished."]}"#
                .to_owned(),
        );
    }
    if text.starts_with("Maia goal check-in.") {
        return Some(
            r#"{"on_track":true,"progress_toward_done":60,"scope_creep":[],"stuck":false,"correction":""}"#
                .to_owned(),
        );
    }
    if text.starts_with("Maia handoff brief.") {
        return Some("A fresh start is ready.".to_owned());
    }
    None
}

impl Router for ScriptedRouter {
    fn complete(
        &self,
        request: &RouterRequest,
    ) -> impl Future<Output = Result<RouterResponse, RouterError>> + Send {
        let prepared = {
            if let Some(reply) = auxiliary_reply(request) {
                Ok(reply_response(request.request_id, reply))
            } else {
                let mut script = self.inner.lock().expect("router lock");
                script.bodies.push(
                    request
                        .messages
                        .iter()
                        .map(|message| message.content.clone())
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
                script.requests += 1;
                if request
                    .messages
                    .first()
                    .is_some_and(|message| message.content.starts_with("Maia task-report relay."))
                {
                    Ok(reply_response(request.request_id, "Relayed.".to_owned()))
                } else {
                    match script.replies.pop_front() {
                        Some(ScriptedReply::Proposal(proposal)) => {
                            Ok(route_tool_response(request.request_id, &proposal))
                        }
                        Some(ScriptedReply::Tool { name, arguments }) => {
                            Ok(named_tool_response(request.request_id, &name, &arguments))
                        }
                        Some(ScriptedReply::Fail(detail)) => Err(RouterError::Protocol { detail }),
                        Some(ScriptedReply::Server { code }) => Err(RouterError::Server { code }),
                        None => Err(RouterError::Protocol {
                            detail: "no scripted proposal".to_owned(),
                        }),
                    }
                }
            }
        };
        async move { prepared }
    }

    async fn cancel(&self, _request_id: RequestId) -> Result<(), RouterError> {
        Ok(())
    }
}

struct HoldGate {
    released: Mutex<bool>,
    waker: Mutex<Option<Waker>>,
}

impl HoldGate {
    fn create() -> Arc<Self> {
        Arc::new(Self {
            released: Mutex::new(false),
            waker: Mutex::new(None),
        })
    }

    fn release(&self) {
        let mut released = self.released.lock().expect("hold");
        if *released {
            return;
        }
        *released = true;
        drop(released);
        if let Some(waker) = self.waker.lock().expect("waker").take() {
            waker.wake();
        }
    }
}

struct ReleaseOnDrop(Arc<HoldGate>);

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[derive(Clone)]
struct HoldingRouter {
    inner: ScriptedRouter,
    gate: Arc<HoldGate>,
    started: Arc<AtomicBool>,
}

impl Router for HoldingRouter {
    fn complete(
        &self,
        request: &RouterRequest,
    ) -> impl Future<Output = Result<RouterResponse, RouterError>> + Send {
        let inner = self.inner.clone();
        let request = request.clone();
        let gate = Arc::clone(&self.gate);
        let started = Arc::clone(&self.started);
        async move {
            started.store(true, Ordering::SeqCst);
            HoldUntil { gate }.await;
            inner.complete(&request).await
        }
    }

    async fn cancel(&self, _request_id: RequestId) -> Result<(), RouterError> {
        Ok(())
    }
}

struct HoldUntil {
    gate: Arc<HoldGate>,
}

impl Future for HoldUntil {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        if *self.gate.released.lock().expect("hold") {
            return Poll::Ready(());
        }
        *self.gate.waker.lock().expect("waker") = Some(context.waker().clone());
        if *self.gate.released.lock().expect("hold") {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}

#[derive(Clone)]
struct SplitHold {
    route: ScriptedRouter,
    worker: ScriptedRouter,
    gate: Arc<HoldGate>,
    worker_started: Arc<AtomicBool>,
}

impl Router for SplitHold {
    fn complete(
        &self,
        request: &RouterRequest,
    ) -> impl Future<Output = Result<RouterResponse, RouterError>> + Send {
        let worker = request
            .messages
            .first()
            .is_some_and(|message| message.content.starts_with("Maia task worker"));
        let request = request.clone();
        if worker {
            let inner = self.worker.clone();
            let gate = Arc::clone(&self.gate);
            let started = Arc::clone(&self.worker_started);
            futures_util::future::Either::Left(async move {
                started.store(true, Ordering::SeqCst);
                HoldUntil { gate }.await;
                inner.complete(&request).await
            })
        } else {
            let inner = self.route.clone();
            futures_util::future::Either::Right(async move { inner.complete(&request).await })
        }
    }

    async fn cancel(&self, _request_id: RequestId) -> Result<(), RouterError> {
        Ok(())
    }
}

#[derive(Clone)]
struct PendingFirst {
    inner: ScriptedRouter,
}

impl Router for PendingFirst {
    fn complete(
        &self,
        request: &RouterRequest,
    ) -> impl Future<Output = Result<RouterResponse, RouterError>> + Send {
        let inner = self.inner.clone();
        let request = request.clone();
        async move {
            YieldOnce { armed: false }.await;
            inner.complete(&request).await
        }
    }

    async fn cancel(&self, _request_id: RequestId) -> Result<(), RouterError> {
        Ok(())
    }
}

struct YieldOnce {
    armed: bool,
}

impl Future for YieldOnce {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        if this.armed {
            Poll::Ready(())
        } else {
            this.armed = true;
            context.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

fn reply_response(request_id: RequestId, reply: String) -> RouterResponse {
    RouterResponse {
        request_id,
        provider_response_id: None,
        reasoning: None,
        tool_calls: Vec::new(),
        reply: Some(reply),
        usage: RouterUsage {
            input_tokens: UsageValue::Unavailable,
            output_tokens: UsageValue::Unavailable,
            cached_input_tokens: UsageValue::Unavailable,
        },
        finish: FinishReason::Stop,
    }
}

struct Session {
    router: ScriptedRouter,
    tools: ScriptedToolHost,
    ids: IdSupply,
    memories: Vec<RankedMemory>,
    directory: PathBuf,
    database: PathBuf,
    dist: PathBuf,
    http_count: u64,
    parent_work: ParentWork,
}

impl Session {
    fn open(name: &str) -> Self {
        Self::open_with(name, supply())
    }

    fn open_with(name: &str, ids: IdSupply) -> Self {
        let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let mut directory = std::env::temp_dir();
        directory.push("maia-daemon-http");
        directory.push(format!("{name}-{sequence}"));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("temp dir");
        let dist = directory.join("dist");
        std::fs::create_dir_all(&dist).expect("dist");
        std::fs::write(
            dist.join("index.html"),
            "<!doctype html><title>Maia shell</title><p>shell</p>",
        )
        .expect("index");
        Self {
            router: ScriptedRouter::create(),
            tools: ScriptedToolHost::create(),
            ids,
            memories: Vec::new(),
            database: directory.join("maia.sqlite"),
            dist,
            directory,
            http_count: 4096,
            parent_work: ParentWork::Script,
        }
    }

    fn with_model_work(mut self) -> Self {
        self.parent_work = ParentWork::ModelTurn;
        self
    }

    fn with_http_count(mut self, count: u64) -> Self {
        self.http_count = count;
        self
    }

    fn queue_create(&self) {
        self.router.push_proposal(create_task(900, 200));
    }

    fn queue_ask(&self) {
        self.router.push_host_ask(create_task(100, 200));
    }

    fn queue_fail(&self, detail: &str) {
        self.router.push_fail(detail.to_owned());
    }

    fn queue_server(&self, code: u16) {
        self.router.push_server(code);
    }

    fn queue_completion(&mut self, summary: &str) {
        self.tools.push_parent(ScriptedCall::Completion {
            summary: summary.to_owned(),
            evidence: CompletionEvidence::Stored,
        });
    }

    fn queue_progress(&mut self, summary: &str) {
        self.tools.push_parent(ScriptedCall::Progress {
            summary: summary.to_owned(),
        });
    }

    fn queue_failure(&mut self, summary: &str) {
        self.tools.push_parent(ScriptedCall::Failure {
            summary: summary.to_owned(),
        });
    }

    fn include_ranked_memory(&mut self) {
        self.memories.push(RankedMemory {
            memory: MemoryId("memory-1".to_owned()),
            sentence: "Useful context.".to_owned(),
            provenance: MemoryProvenance::Fact {
                fact: FactId::new("memory-1"),
            },
            trust: Taint::Trusted,
        });
    }

    fn spawn(self) -> Running {
        let router = self.router.clone();
        self.spawn_router(router)
    }

    fn spawn_router<R>(self, router: R) -> Running
    where
        R: Router + Clone + Send + 'static,
    {
        self.try_spawn_router_at(router, SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .unwrap_or_else(|error| panic!("serve: {error}"))
    }

    fn try_spawn_router_at<R>(self, router: R, bind: SocketAddr) -> Result<Running, ServeFailure>
    where
        R: Router + Clone + Send + 'static,
    {
        let owner = SqliteOwner::open(OwnerOpen {
            path: self.database.clone(),
            now: NOW,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("open store");
        let mut orchestrator = Orchestrator::create(
            router,
            owner,
            self.tools,
            OrchestratorConfig {
                policy: accepted_routing_policy(),
                ids: self.ids,
                turn: RouterTurn {
                    model: "fixture-model".to_owned(),
                    reasoning: ReasoningEffort::Low,
                    prefix_hash: PrefixHash::new("fixture-prefix"),
                },
                profile: SecurityProfile::Protected,
                parent_work: self.parent_work,
            },
        );
        orchestrator.set_ranked_memories(self.memories);
        let ids = reserved_http_supply(orchestrator.store(), self.http_count)?;
        let server =
            serve_super_agent_with_ids(orchestrator, self.database.clone(), self.dist, bind, ids)?;
        Ok(Running {
            origin: server.origin().to_owned(),
            local_addr: server.local_addr(),
            client: reqwest::Client::new(),
            server: Some(server),
            directory: self.directory,
            database: self.database,
        })
    }
}

fn reserved_http_supply(owner: &SqliteOwner, count: u64) -> Result<HttpIdSupply, ServeFailure> {
    let reserved = if tokio::runtime::Handle::try_current().is_ok() {
        tokio::task::block_in_place(|| owner.reserve_runtime_id_block(count))
    } else {
        owner.reserve_runtime_id_block(count)
    }
    .map_err(|_| ServeFailure::Server)?;
    let (_, http) = reserved.into_parts();
    HttpIdSupply::from_reserved(http).map_err(|_| ServeFailure::Server)
}

struct Running {
    origin: String,
    local_addr: SocketAddr,
    client: reqwest::Client,
    server: Option<maia_daemon::SuperAgentServer>,
    directory: PathBuf,
    database: PathBuf,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.server.take();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn supply() -> IdSupply {
    let mut ids = IdSupply::at(NOW);
    for index in 1_u64..=8 {
        ids.messages.push_back(format!("m-{index}"));
        ids.tasks.push_back(format!("task-{index}"));
        ids.attempts.push_back(format!("attempt-{index}"));
        ids.envelopes.push_back(format!("env-{index}"));
        ids.reports.push_back(format!("report-{index}"));
        ids.calls.push_back(format!("call-{index}"));
        ids.evidence.push_back(format!("evidence-{index}"));
        ids.snapshots.push_back(format!("snap-{index}"));
        ids.criteria.push_back(format!("criterion-{index}"));
        ids.requests.push_back(index);
        ids.commands.push_back(index);
    }
    ids
}

fn exhausted_ids() -> IdSupply {
    let mut ids = supply();
    ids.tasks.clear();
    ids
}

fn create_task(confidence_value: u16, margin: u16) -> RouteProposal {
    RouteProposal {
        proposed: ProposedRouteDecision::CreateTask,
        shape: ProposalShape::Single,
        considered: Vec::new(),
        confidence: Confidence::from_thousandths(confidence_value).expect("confidence"),
        margin: Confidence::from_thousandths(margin).expect("margin"),
    }
}

fn routed_body(message_id: &str, route: &str) -> Value {
    json!({
        "admitted": route,
        "admission": "admitted",
        "message_id": message_id,
        "outcome": {
            "kind": "routed",
            "route": route,
        },
    })
}

fn spawn_with_scripted_router() -> Running {
    let session = Session::open("admit");
    session.queue_create();
    session.spawn()
}

async fn post_json(server: &Running, path: &str, body: Value) -> reqwest::Response {
    let mut body = body;
    if path == "/api/super-agent/messages"
        && let Some(object) = body.as_object_mut()
        && !object.contains_key("operation_id")
    {
        let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        object.insert(
            "operation_id".to_owned(),
            Value::String(format!("00000000-0000-4000-8000-{sequence:012}")),
        );
    }
    let response = server
        .client
        .post(format!("{}{path}", server.origin))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .expect("post");
    if path != "/api/super-agent/messages" {
        return response;
    }
    let status = response.status();
    let value: Value = response.json().await.expect("message json");
    if status != reqwest::StatusCode::OK || !pending_outcome(&value) {
        return json_response(status, value);
    }
    let operation = body
        .get("operation_id")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_owned();
    let settled = wait_terminal_submission(&server.database, &operation, Duration::from_secs(8));
    json_response(reqwest::StatusCode::OK, settled.unwrap_or(value))
}

fn pending_outcome(value: &Value) -> bool {
    value
        .get("outcome")
        .and_then(|outcome| outcome.get("kind"))
        .and_then(|kind| kind.as_str())
        == Some("processing_pending")
}

fn wait_terminal_submission(database: &Path, operation: &str, limit: Duration) -> Option<Value> {
    let started = std::time::Instant::now();
    while started.elapsed() < limit {
        if let Some(value) = read_terminal_submission(database, operation) {
            return Some(value);
        }
        thread::sleep(Duration::from_millis(15));
    }
    None
}

fn read_terminal_submission(database: &Path, operation: &str) -> Option<Value> {
    let connection = Connection::open(database).ok()?;
    let row = connection
        .query_row(
            "SELECT state, message_id, outcome_kind, outcome_detail FROM message_submissions \
             WHERE operation_id = ?1",
            [operation],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .ok()?;
    if row.0 != "terminal" {
        return None;
    }
    let message_id = row.1;
    let kind = row.2.unwrap_or_else(|| "unknown_outcome".to_owned());
    let detail = row.3.unwrap_or_default();
    Some(match kind.as_str() {
        "routed" => routed_body(&message_id, &detail),
        "routing_failed" => json!({
            "admission": "admitted",
            "message_id": message_id,
            "outcome": { "kind": "routing_failed", "reason": detail },
        }),
        "processing_failed" => json!({
            "admission": "admitted",
            "message_id": message_id,
            "outcome": {
                "kind": "processing_failed",
                "reason": "processing_unavailable",
            },
        }),
        _ => json!({
            "admission": "admitted",
            "message_id": message_id,
            "outcome": { "kind": "unknown_outcome" },
        }),
    })
}

fn json_response(status: reqwest::StatusCode, body: Value) -> reqwest::Response {
    let bytes = serde_json::to_vec(&body).expect("json bytes");
    let response = http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(reqwest::Body::from(bytes))
        .expect("response");
    reqwest::Response::from(response)
}

async fn get(server: &Running, path: &str) -> reqwest::Response {
    server
        .client
        .get(format!("{}{path}", server.origin))
        .send()
        .await
        .expect("get")
}

fn count(path: &Path, sql: &str) -> i64 {
    let connection = Connection::open(path).expect("open sqlite");
    connection
        .query_row(sql, [], |row| row.get(0))
        .expect("count")
}

fn prompt_blob(path: &Path) -> Vec<u8> {
    let connection = Connection::open(path).expect("open sqlite");
    connection
        .query_row("SELECT prompt FROM task_envelopes", [], |row| row.get(0))
        .expect("prompt")
}

fn shown(path: &Path, sql: &str) -> Vec<String> {
    texts(path, sql)
        .into_iter()
        .map(|body| present_router_body(&body).text)
        .collect()
}

fn texts(path: &Path, sql: &str) -> Vec<String> {
    let connection = Connection::open(path).expect("open sqlite");
    let mut statement = connection.prepare(sql).expect("prepare");
    statement
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows")
}

#[tokio::test(flavor = "multi_thread")]
async fn inspector_returns_the_stored_router_turn_without_fixture_copy() {
    let server = spawn_with_scripted_router();
    let response = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await;
    assert_eq!(response.status(), 200);
    let inspector = get(&server, "/api/super-agent/inspector")
        .await
        .json::<Value>()
        .await
        .expect("inspector");
    let turns = inspector["turns"].as_array().expect("turns");
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["ordinal"], 1);
    assert_eq!(turns[0]["route"], "spawn_task");
    assert_eq!(turns[0]["cached_percent"], Value::Null);
    assert_eq!(turns[0]["slots"][0]["label"], "Route tools");
    assert_eq!(turns[0]["slots"][3]["label"], "Conversation");
    assert_eq!(turns[0]["slots"][3]["detail"], "1 message");
    assert_eq!(
        turns[0]["trace"][0]["text"],
        "No readable reasoning returned."
    );
    assert!(
        turns[0]["trace"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| { step["kind"] == "route" && step["text"] == "spawn_task" })
    );
    let body = inspector.to_string();
    assert!(!body.to_lowercase().contains("compact"));
    assert!(!body.contains("Tailscale"));
    assert!(!body.contains("Persona"));
}

#[tokio::test(flavor = "multi_thread")]
async fn transcript_is_readable_while_the_router_still_holds_the_send() {
    let session = Session::open("live-transcript");
    session.queue_create();
    let gate = HoldGate::create();
    let started = Arc::new(AtomicBool::new(false));
    let router = HoldingRouter {
        inner: session.router.clone(),
        gate: Arc::clone(&gate),
        started: Arc::clone(&started),
    };
    let server = session.spawn_router(router);
    let _release = ReleaseOnDrop(Arc::clone(&gate));
    let origin = server.origin.clone();
    let post = tokio::spawn(async move {
        let client = reqwest::Client::new();
        client
            .post(format!("{origin}/api/super-agent/messages"))
            .header("content-type", "application/json")
            .json(&json!({
                "text": USER_TEXT,
                "operation_id": "00000000-0000-4000-8000-000000000099",
            }))
            .send()
            .await
            .expect("post")
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !started.load(Ordering::SeqCst) {
        if std::time::Instant::now() > deadline {
            panic!("router did not start holding the send");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let reader = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("reader");
    let transcript = reader
        .get(format!("{}/api/super-agent/transcript", server.origin))
        .send()
        .await
        .expect("transcript while the send is still open");
    assert_eq!(transcript.status(), 200);
    let body = transcript.text().await.expect("transcript body");
    assert!(body.contains(USER_TEXT));
    assert!(body.contains("\"role\":\"owner\""));
    gate.release();
    let posted = tokio::time::timeout(Duration::from_secs(5), post)
        .await
        .expect("send finished after the router was released")
        .expect("send task");
    assert_eq!(posted.status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_stay_readable_while_the_router_holds_the_send() {
    let session = Session::open("settings-during-send");
    session.queue_create();
    let gate = HoldGate::create();
    let started = Arc::new(AtomicBool::new(false));
    let router = HoldingRouter {
        inner: session.router.clone(),
        gate: Arc::clone(&gate),
        started: Arc::clone(&started),
    };
    let server = session.spawn_router(router);
    let _release = ReleaseOnDrop(Arc::clone(&gate));
    let saved = put_json(
        &server,
        "/api/super-agent/model-connection",
        json!({
            "base_url": "https://example.test/v1",
            "api_key": LEAK,
            "model": "example-chat",
            "reasoning": "high"
        }),
    )
    .await;
    assert_eq!(saved.status(), 200);

    let origin = server.origin.clone();
    let post = tokio::spawn(async move {
        let client = reqwest::Client::new();
        client
            .post(format!("{origin}/api/super-agent/messages"))
            .header("content-type", "application/json")
            .json(&json!({
                "text": USER_TEXT,
                "operation_id": "00000000-0000-4000-8000-000000000098",
            }))
            .send()
            .await
            .expect("post")
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !started.load(Ordering::SeqCst) {
        if std::time::Instant::now() > deadline {
            panic!("router did not start holding the send");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let reader = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("reader");
    let model = reader
        .get(format!(
            "{}/api/super-agent/model-connection",
            server.origin
        ))
        .send()
        .await
        .expect("model connection while the send is still open");
    assert_eq!(model.status(), 200);
    let model_body = model.text().await.expect("model body");
    assert!(model_body.contains("https://example.test/v1"));
    assert!(model_body.contains("example-chat"));
    assert!(model_body.contains("\"key_set\":true"));
    assert!(model_body.contains("\"reasoning\":\"high\""));
    assert!(!model_body.contains(LEAK));
    let mcp = reader
        .get(format!("{}/api/super-agent/mcp", server.origin))
        .send()
        .await
        .expect("mcp list while the send is still open");
    assert_eq!(mcp.status(), 200);
    let mcp_body = mcp.text().await.expect("mcp body");
    assert!(mcp_body.contains("\"connections\""));
    gate.release();
    let posted = tokio::time::timeout(Duration::from_secs(5), post)
        .await
        .expect("send finished after the router was released")
        .expect("send task");
    assert_eq!(posted.status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn post_message_returns_admitted_without_secrets() {
    let server = spawn_with_scripted_router();
    let response = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await;
    assert_eq!(response.status(), 200);
    let body = response.text().await.expect("body");
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("routed body"),
        routed_body("m-1", "admit")
    );
    assert!(!body.contains("API_KEY"));
    assert!(!body.contains("BASE_URL"));
    assert!(!body.contains(LEAK));
    assert!(!body.contains("fixture-model"));
    assert_eq!(prompt_blob(&server.database), USER_TEXT.as_bytes());
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    assert!(server.local_addr.ip().is_loopback());
    assert_ne!(server.local_addr.port(), 4178);
}

#[tokio::test(flavor = "multi_thread")]
async fn low_confidence_returns_ask_and_inserts_no_task() {
    let session = Session::open("ask");
    session.queue_ask();
    let server = session.spawn();
    let response = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.expect("body"),
        routed_body("m-1", "ask")
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        0
    );
    let transcript = get(&server, "/api/super-agent/transcript").await;
    assert_eq!(transcript.status(), 200);
    let body = transcript.text().await.expect("transcript");
    assert!(body.contains(USER_TEXT));
    assert!(body.contains("\"role\":\"owner\""));
    assert!(!body.contains("API_KEY"));
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_empty_and_oversize_messages_fail_closed() {
    let session = Session::open("bad-body");
    session.queue_create();
    let server = session.spawn();
    let malformed = server
        .client
        .post(format!("{}/api/super-agent/messages", server.origin))
        .header("content-type", "application/json")
        .body("{")
        .send()
        .await
        .expect("malformed");
    assert_eq!(malformed.status(), 400);
    assert_eq!(
        malformed.text().await.expect("malformed body"),
        r#"{"error":"invalid_json"}"#
    );
    let empty = post_json(&server, "/api/super-agent/messages", json!({"text": "   "})).await;
    assert_eq!(empty.status(), 400);
    assert_eq!(
        empty.text().await.expect("empty body"),
        r#"{"error":"empty_message"}"#
    );
    let media = server
        .client
        .post(format!("{}/api/super-agent/messages", server.origin))
        .body(r#"{"text":"hello"}"#)
        .send()
        .await
        .expect("media");
    assert_eq!(media.status(), 415);
    assert_eq!(
        media.text().await.expect("media body"),
        r#"{"error":"unsupported_media_type"}"#
    );
    let oversize = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "a".repeat(40_000)}),
    )
    .await;
    assert_eq!(oversize.status(), 413);
    assert_eq!(
        oversize.text().await.expect("oversize body"),
        r#"{"error":"payload_too_large"}"#
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        0
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        0
    );
    let oversized = "x".repeat(48 * 1024 + 1);
    let limited = server
        .client
        .post(format!("{}/api/super-agent/messages", server.origin))
        .header("content-type", "application/json")
        .body(oversized)
        .send()
        .await
        .expect("oversized body");
    assert_eq!(limited.status(), 413);
    let limited_body = limited.text().await.expect("limited body");
    assert_eq!(limited_body, r#"{"error":"payload_too_large"}"#);
    assert!(!limited_body.contains('x'));
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        0
    );
    let invalid_utf8 = server
        .client
        .post(format!("{}/api/super-agent/messages", server.origin))
        .header("content-type", "application/json")
        .body(vec![0xff, 0xfe, 0xfd])
        .send()
        .await
        .expect("invalid utf-8");
    assert_eq!(invalid_utf8.status(), 400);
    assert_eq!(
        invalid_utf8.text().await.expect("invalid utf-8 body"),
        r#"{"error":"invalid_json"}"#
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn punctuation_html_and_long_messages_remain_inert_data() {
    for (index, text) in [
        "!!!".to_owned(),
        "<b>pin this</b>".to_owned(),
        "<script>alert(1)</script>".to_owned(),
        "x".repeat(10_001),
    ]
    .into_iter()
    .enumerate()
    {
        let session = Session::open(&format!("inert-text-{index}"));
        session.queue_create();
        let server = session.spawn();
        let response = post_json(&server, "/api/super-agent/messages", json!({"text": text})).await;
        assert_eq!(response.status(), 200, "case {index}");
        assert_eq!(
            prompt_blob(&server.database),
            text.as_bytes(),
            "case {index}"
        );
        let shell = get(&server, "/").await.text().await.expect("shell");
        assert!(!shell.contains(&text), "case {index}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn operation_id_is_required_and_validated() {
    let session = Session::open("operation-validation");
    session.queue_create();
    let server = session.spawn();
    for body in [
        json!({"text": USER_TEXT}),
        json!({"operation_id": "not-a-uuid", "text": USER_TEXT}),
        json!({"operation_id": 7, "text": USER_TEXT}),
    ] {
        let response = server
            .client
            .post(format!("{}/api/super-agent/messages", server.origin))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .expect("post invalid operation");
        assert_eq!(response.status(), 400);
        assert_eq!(
            response.text().await.expect("invalid operation body"),
            r#"{"error":"invalid_operation_id"}"#
        );
    }
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn same_operation_replays_success_without_side_effects() {
    let session = Session::open("replay-success");
    session.queue_create();
    let router = session.router.clone();
    let server = session.spawn();
    let body = json!({
        "operation_id": "11111111-1111-4111-8111-111111111111",
        "text": USER_TEXT,
    });

    let (first, concurrent) = tokio::join!(
        post_json(&server, "/api/super-agent/messages", body.clone()),
        post_json(&server, "/api/super-agent/messages", body.clone()),
    );
    let first_body = first.text().await.expect("first body");
    assert_eq!(
        concurrent.text().await.expect("concurrent body"),
        first_body
    );
    let replay = post_json(&server, "/api/super-agent/messages", body.clone()).await;
    let replay_body = replay.text().await.expect("replay body");

    assert_eq!(first_body, replay_body);
    assert_eq!(router.request_count(), 2);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        2
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_reports"),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn same_operation_different_text_conflicts_without_mutation() {
    let session = Session::open("replay-conflict");
    session.queue_create();
    let router = session.router.clone();
    let server = session.spawn();
    let operation_id = "22222222-2222-4222-8222-222222222222";
    let first = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"operation_id": operation_id, "text": USER_TEXT}),
    )
    .await;
    assert_eq!(first.status(), 200);

    let conflict = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"operation_id": operation_id, "text": "Different text"}),
    )
    .await;

    assert_eq!(conflict.status(), 409);
    assert_eq!(
        conflict.text().await.expect("conflict body"),
        r#"{"error":"submission_conflict"}"#
    );
    assert_eq!(router.request_count(), 2);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        2
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn request_note_and_route_apply_failures_replay_without_side_effects() {
    let mut request_ids = supply();
    request_ids.requests.clear();
    let request_session = Session::open_with("replay-request-id", request_ids);
    let request_router = request_session.router.clone();
    let request_server = request_session.spawn();
    assert_processing_replay(&request_server, "88888888-8888-4888-8888-888888888888", 2).await;
    assert_eq!(request_router.request_count(), 0);

    let mut note_ids = supply();
    note_ids.messages.truncate(1);
    let note_session = Session::open_with("replay-note-failure", note_ids);
    note_session.queue_server(503);
    let note_router = note_session.router.clone();
    let note_server = note_session.spawn();
    let note_request = json!({
        "operation_id": "99999999-9999-4999-8999-999999999999",
        "text": USER_TEXT,
    });
    let first = post_json(
        &note_server,
        "/api/super-agent/messages",
        note_request.clone(),
    )
    .await
    .json::<Value>()
    .await
    .expect("note failure body");
    let replay = post_json(&note_server, "/api/super-agent/messages", note_request)
        .await
        .json::<Value>()
        .await
        .expect("note replay body");
    assert_eq!(replay, first);
    assert_eq!(note_router.request_count(), 2);
    assert_eq!(
        count(
            &note_server.database,
            "SELECT COUNT(*) FROM router_messages"
        ),
        1
    );

    let mut apply_ids = supply();
    apply_ids.tasks.clear();
    let apply_session = Session::open_with("replay-route-apply", apply_ids);
    apply_session.queue_create();
    let apply_router = apply_session.router.clone();
    let apply_server = apply_session.spawn();
    assert_processing_replay(&apply_server, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 2).await;
    assert_eq!(apply_router.request_count(), 1);
}

async fn assert_processing_replay(server: &Running, operation_id: &str, message_count: i64) {
    let request = json!({"operation_id": operation_id, "text": USER_TEXT});
    let first = post_json(server, "/api/super-agent/messages", request.clone())
        .await
        .json::<Value>()
        .await
        .expect("first processing body");
    let replay = post_json(server, "/api/super-agent/messages", request)
        .await
        .json::<Value>()
        .await
        .expect("replay processing body");
    assert_eq!(replay, first);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        message_count
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        0
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_reports"),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn router_failure_is_an_admitted_http_outcome_with_one_safe_note() {
    let session = Session::open("server-status");
    session.queue_server(502);
    let router = session.router.clone();
    let server = session.spawn();
    let request = json!({
        "operation_id": "33333333-3333-4333-8333-333333333333",
        "text": USER_TEXT,
    });
    let response = post_json(&server, "/api/super-agent/messages", request.clone()).await;
    assert_eq!(response.status(), 200);
    let body = response.text().await.expect("provider body");
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("admitted body"),
        json!({
            "admission": "admitted",
            "message_id": "m-1",
            "outcome": {
                "kind": "routing_failed",
                "reason": "model_provider_unavailable",
            },
        })
    );
    assert!(!body.contains("502"));
    assert_eq!(
        texts(
            &server.database,
            "SELECT role FROM router_messages ORDER BY ordinal"
        ),
        vec![
            "user".to_owned(),
            "assistant".to_owned(),
            "assistant".to_owned(),
        ]
    );
    assert_eq!(
        texts(
            &server.database,
            "SELECT body FROM router_messages ORDER BY ordinal"
        ),
        vec![
            USER_TEXT.to_owned(),
            "The provider is busy, retrying.".to_owned(),
            "The model provider is unavailable.".to_owned(),
        ]
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        3
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        0
    );
    assert!(
        texts(&server.database, "SELECT body FROM router_messages")
            .iter()
            .all(|text| !text.contains("502"))
    );
    let replay = post_json(&server, "/api/super-agent/messages", request).await;
    assert_eq!(replay.status(), 200);
    assert_eq!(
        replay.json::<Value>().await.expect("replay body"),
        serde_json::from_str::<Value>(&body).expect("first body")
    );
    assert_eq!(router.request_count(), 2);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        3
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn step_failure_after_admission_returns_processing_failed() {
    let mut session = Session::open("step-processing-failure");
    session.queue_create();
    session.tools.push_parent(ScriptedCall::Unknown);
    session
        .tools
        .execute_scripted(
            &SessionRole::ParentTask {
                task: TaskId("task-1".to_owned()),
            },
            CallId("call-1".to_owned()),
            SecurityProfile::Protected,
        )
        .expect_err("seed blocked tool call");
    session.queue_progress("must not be reported");
    let router = session.router.clone();
    let server = session.spawn();
    let request = json!({
        "operation_id": "44444444-4444-4444-8444-444444444444",
        "text": USER_TEXT,
    });

    let response = post_json(&server, "/api/super-agent/messages", request.clone()).await;

    assert_eq!(response.status(), 200);
    let first_body = response.json::<Value>().await.expect("processing body");
    assert_eq!(
        first_body,
        json!({
            "admission": "admitted",
            "message_id": "m-1",
            "outcome": {
                "kind": "processing_failed",
                "reason": "processing_unavailable",
            },
        })
    );
    assert_eq!(router.request_count(), 2);
    assert_eq!(
        shown(
            &server.database,
            "SELECT body FROM router_messages ORDER BY ordinal"
        ),
        vec![
            USER_TEXT.to_owned(),
            "Done.".to_owned(),
            "The message was accepted, but processing could not continue.".to_owned(),
        ]
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_reports"),
        0
    );
    let replay = post_json(&server, "/api/super-agent/messages", request).await;
    assert_eq!(
        replay.json::<Value>().await.expect("replay body"),
        first_body
    );
    assert_eq!(router.request_count(), 2);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        3
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn publication_failure_after_admission_returns_processing_failed() {
    let session = Session::open("publish-processing-failure");
    session.queue_create();
    let router = session.router.clone();
    let server = session.spawn();
    let connection = Connection::open(&server.database).expect("open sqlite");
    connection
        .execute_batch(
            "CREATE TRIGGER invalidate_phase AFTER INSERT ON task_sessions \
             BEGIN UPDATE task_sessions SET phase = 'invalid' WHERE task_id = NEW.task_id; END;",
        )
        .expect("install publication failpoint");
    let request = json!({
        "operation_id": "55555555-5555-4555-8555-555555555555",
        "text": USER_TEXT,
    });

    let response = post_json(&server, "/api/super-agent/messages", request.clone()).await;

    assert_eq!(response.status(), 200);
    let first_body = response.json::<Value>().await.expect("processing body");
    assert_eq!(
        first_body,
        json!({
            "admission": "admitted",
            "message_id": "m-1",
            "outcome": {
                "kind": "processing_failed",
                "reason": "processing_unavailable",
            },
        })
    );
    assert_eq!(router.request_count(), 2);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_envelopes"),
        1
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_reports"),
        0
    );
    assert_eq!(
        shown(
            &server.database,
            "SELECT body FROM router_messages ORDER BY ordinal"
        ),
        vec![
            USER_TEXT.to_owned(),
            "Done.".to_owned(),
            "The message was accepted, but processing could not continue.".to_owned(),
        ]
    );
    let replay = post_json(&server, "/api/super-agent/messages", request).await;
    assert_eq!(
        replay.json::<Value>().await.expect("replay body"),
        first_body
    );
    assert_eq!(router.request_count(), 2);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        3
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn committed_actions_succeed_when_publication_fails() {
    let mut session = Session::open("committed-publication-failure");
    session.queue_create();
    session.queue_failure("retry target");
    let server = session.spawn();
    assert_eq!(
        post_json(
            &server,
            "/api/super-agent/messages",
            json!({"text": "publication target"}),
        )
        .await
        .status(),
        200
    );
    let connection = Connection::open(&server.database).expect("open sqlite");
    connection
        .execute(
            "INSERT INTO task_sessions \
             (task_id, phase, title, pinned, completion_view, prior_task_id, created_at) \
             VALUES ('corrupt-publication', 'future', 'corrupt', 'unpinned', 'unopened', NULL, 2)",
            [],
        )
        .expect("publication corruption fixture");
    drop(connection);

    for (path, body) in [
        (
            "/api/super-agent/tasks/task-1/pin",
            json!({"pin": "pinned"}),
        ),
        (
            "/api/super-agent/tasks/task-1/detail",
            json!({"view": "open"}),
        ),
        (
            "/api/super-agent/host-command",
            json!({"command": "retry", "task_id": "task-1"}),
        ),
        (
            "/api/super-agent/host-command",
            json!({"command": "stop", "task_id": "task-1"}),
        ),
    ] {
        let response = post_json(&server, path, body).await;
        assert_eq!(response.status(), 200, "{path}");
    }
    assert_eq!(
        texts(
            &server.database,
            "SELECT pinned || ':' || completion_view || ':' || phase FROM task_sessions \
             WHERE task_id = 'task-1'"
        ),
        vec!["pinned:open:detail-1:stopped:1".to_owned()]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn http_id_ranges_refuse_unreserved_detail_and_decision() {
    let session = Session::open("bounded-http-ids").with_http_count(1);
    session.queue_create();
    session.queue_create();
    session.queue_create();
    let server = session.spawn();

    for text in ["first", "second"] {
        assert_eq!(
            post_json(&server, "/api/super-agent/messages", json!({"text": text}),)
                .await
                .status(),
            200
        );
    }
    assert_eq!(
        post_json(
            &server,
            "/api/super-agent/tasks/task-1/detail",
            json!({"view": "open"}),
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        post_json(
            &server,
            "/api/super-agent/tasks/task-1/detail",
            json!({"view": "closed_once"}),
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        post_json(
            &server,
            "/api/super-agent/tasks/task-2/detail",
            json!({"view": "open"}),
        )
        .await
        .status(),
        500
    );
    assert_eq!(
        texts(
            &server.database,
            "SELECT completion_view FROM task_sessions ORDER BY task_id"
        ),
        vec!["closed_once".to_owned(), "unopened".to_owned()]
    );

    assert_eq!(
        post_json(
            &server,
            "/api/super-agent/host-command",
            json!({"command": "abandon", "task_id": "task-2"}),
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        post_json(
            &server,
            "/api/super-agent/messages",
            json!({"text": "third"}),
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        post_json(
            &server,
            "/api/super-agent/host-command",
            json!({"command": "abandon", "task_id": "task-3"}),
        )
        .await
        .status(),
        500
    );
    assert_eq!(
        texts(
            &server.database,
            "SELECT phase FROM task_sessions ORDER BY task_id"
        ),
        vec![
            "queued".to_owned(),
            "abandoned:decision-1".to_owned(),
            "queued".to_owned(),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn atomic_task_failure_returns_admitted_with_no_partial_task() {
    let session = Session::open("atomic-processing-failure");
    session.queue_create();
    let router = session.router.clone();
    let server = session.spawn();
    let connection = Connection::open(&server.database).expect("open sqlite");
    connection
        .execute_batch(
            "CREATE TRIGGER fail_envelope BEFORE INSERT ON task_envelopes \
             BEGIN SELECT RAISE(ABORT, 'aggregate failpoint'); END;",
        )
        .expect("install aggregate failpoint");
    let request = json!({
        "operation_id": "66666666-6666-4666-8666-666666666666",
        "text": USER_TEXT,
    });

    let response = post_json(&server, "/api/super-agent/messages", request.clone()).await;

    assert_eq!(response.status(), 200);
    let first_body = response.json::<Value>().await.expect("processing body");
    assert_eq!(
        first_body,
        json!({
            "admission": "admitted",
            "message_id": "m-1",
            "outcome": {
                "kind": "processing_failed",
                "reason": "processing_unavailable",
            },
        })
    );
    for table in [
        "task_sessions",
        "task_attempts",
        "task_envelopes",
        "context_snapshots",
        "task_criteria",
    ] {
        assert_eq!(
            count(&server.database, &format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table}"
        );
    }
    assert_eq!(
        texts(
            &server.database,
            "SELECT body FROM router_messages ORDER BY ordinal"
        ),
        vec![
            USER_TEXT.to_owned(),
            "The message was accepted, but processing could not continue.".to_owned(),
        ]
    );
    let replay = post_json(&server, "/api/super-agent/messages", request).await;
    assert_eq!(
        replay.json::<Value>().await.expect("replay body"),
        first_body
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        2
    );
    assert_eq!(router.request_count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_atomic_failpoint_replays_without_reprocessing() {
    let cases = [
        ("task_sessions", "b1111111-1111-4111-8111-111111111111"),
        ("task_attempts", "b2222222-2222-4222-8222-222222222222"),
        ("task_envelopes", "b3333333-3333-4333-8333-333333333333"),
        ("context_snapshots", "b4444444-4444-4444-8444-444444444444"),
        ("task_criteria", "b5555555-5555-4555-8555-555555555555"),
    ];
    for (table, operation_id) in cases {
        let mut session = Session::open(&format!("replay-atomic-{table}"));
        session.queue_create();
        session.include_ranked_memory();
        let router = session.router.clone();
        let server = session.spawn();
        let connection = Connection::open(&server.database).expect("open sqlite");
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER fail_{table} BEFORE INSERT ON {table} \
                 BEGIN SELECT RAISE(ABORT, 'aggregate failpoint'); END;"
            ))
            .expect("install aggregate failpoint");

        assert_processing_replay(&server, operation_id, 2).await;

        assert_eq!(router.request_count(), 1, "{table}");
        for aggregate_table in [
            "task_sessions",
            "task_attempts",
            "task_envelopes",
            "context_snapshots",
            "task_criteria",
        ] {
            assert_eq!(
                count(
                    &server.database,
                    &format!("SELECT COUNT(*) FROM {aggregate_table}")
                ),
                0,
                "{table} left {aggregate_table}"
            );
        }
    }
}

#[test]
fn pre_admission_store_failure_stays_retryable() {
    let session = Session::open("pre-admission-store");
    let owner = SqliteOwner::open(OwnerOpen {
        path: session.database.clone(),
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("seed owner");
    owner
        .insert_router_message(RouterMessageWrite {
            message_id: "m-1".to_owned(),
            role: "user".to_owned(),
            body: "status".to_owned(),
            created_at: NOW - 1,
        })
        .expect("seed historical owner message");
    drop(owner);
    session.queue_server(503);
    let router = session.router.clone();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(async move {
            let server = session.spawn();
            let response = post_json(
                &server,
                "/api/super-agent/messages",
                json!({"text": USER_TEXT}),
            )
            .await;

            assert_eq!(response.status(), 500);
            assert_eq!(
                response.text().await.expect("store body"),
                r#"{"error":"task_store_unavailable"}"#
            );
            assert_eq!(router.request_count(), 0);
            assert_eq!(
                texts(
                    &server.database,
                    "SELECT body FROM router_messages ORDER BY ordinal"
                ),
                vec!["status".to_owned()]
            );
            assert_eq!(
                count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
                0
            );
        });
}

#[test]
fn pending_submission_resumes_once_after_restart() {
    let mut session = Session::open("pending-restart");
    session.ids.messages.pop_front();
    let operation_id = "77777777-7777-4777-8777-777777777777";
    let owner = SqliteOwner::open(OwnerOpen {
        path: session.database.clone(),
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("seed owner");
    owner
        .begin_message_submission(MessageSubmissionWrite {
            operation_id: operation_id.to_owned(),
            text: USER_TEXT.to_owned(),
            message: RouterMessageWrite {
                message_id: "m-1".to_owned(),
                role: "user".to_owned(),
                body: USER_TEXT.to_owned(),
                created_at: NOW,
            },
        })
        .expect("seed pending admission");
    drop(owner);
    session.queue_create();
    let router = session.router.clone();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(async move {
            let server = session.spawn();
            let started = std::time::Instant::now();
            while (count(&server.database, "SELECT COUNT(*) FROM task_sessions") == 0
                || router.request_count() < 2)
                && started.elapsed() < std::time::Duration::from_secs(2)
            {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert_eq!(
                count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
                1
            );
            assert_eq!(router.request_count(), 2);
            assert_eq!(
                count(
                    &server.database,
                    "SELECT COUNT(*) FROM router_messages WHERE role = 'user'"
                ),
                1
            );
        });
}

#[test]
fn a_bound_file_is_on_the_turn_after_restart() {
    let mut session = Session::open("pending-attachment-restart");
    session.ids.messages.pop_front();
    let operation_id = "88888888-8888-4888-8888-888888888888";
    let hash = "e9b1269d8cf6a5ccb3008d647520021761e302ca1e430a8e1fbf3d83a7173886";
    let bytes = b"hello from the file";
    let folder = session.directory.join("attachments");
    std::fs::create_dir_all(&folder).expect("attachments dir");
    std::fs::write(folder.join(hash), bytes).expect("attachment bytes");
    let owner = SqliteOwner::open(OwnerOpen {
        path: session.database.clone(),
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("seed owner");
    owner
        .begin_message_submission(MessageSubmissionWrite {
            operation_id: operation_id.to_owned(),
            text: USER_TEXT.to_owned(),
            message: RouterMessageWrite {
                message_id: "m-1".to_owned(),
                role: "user".to_owned(),
                body: USER_TEXT.to_owned(),
                created_at: NOW,
            },
        })
        .expect("seed pending admission");
    owner
        .insert_attachment(AttachmentWrite {
            attachment_id: "att-restart".to_owned(),
            content_sha256: hash.to_owned(),
            byte_size: i64::try_from(bytes.len()).expect("size"),
            media_type: "text/plain".to_owned(),
            safe_name: "note.txt".to_owned(),
            relative_path: format!("attachments/{hash}"),
            created_at: NOW,
        })
        .expect("attachment row");
    owner
        .bind_attachments(vec!["att-restart".to_owned()], "m-1".to_owned())
        .expect("bind file to the stored message");
    drop(owner);
    session.queue_create();
    let router = session.router.clone();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(async move {
            let server = session.spawn();
            let started = std::time::Instant::now();
            while count(&server.database, "SELECT COUNT(*) FROM task_sessions") == 0
                && started.elapsed() < std::time::Duration::from_secs(2)
            {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert_eq!(
                count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
                1
            );
            assert!(
                router.saw("hello from the file"),
                "restarted turn did not include the bound file"
            );
            assert!(router.saw("Untrusted text file note.txt"));
            assert_eq!(
                count(
                    &server.database,
                    "SELECT COUNT(*) FROM router_messages WHERE role = 'user'"
                ),
                1
            );
        });
}

#[test]
fn opaque_terminal_replay_is_admitted_and_secret_safe() {
    let session = Session::open("opaque-terminal");
    let operation_id = "c1111111-1111-4111-8111-111111111111";
    let owner = SqliteOwner::open(OwnerOpen {
        path: session.database.clone(),
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("seed owner");
    owner
        .begin_message_submission(MessageSubmissionWrite {
            operation_id: operation_id.to_owned(),
            text: USER_TEXT.to_owned(),
            message: RouterMessageWrite {
                message_id: "m-1".to_owned(),
                role: "user".to_owned(),
                body: USER_TEXT.to_owned(),
                created_at: NOW,
            },
        })
        .expect("seed submission");
    drop(owner);
    let connection = Connection::open(&session.database).expect("open sqlite");
    connection
        .execute(
            "UPDATE message_submissions SET state = 'terminal', \
             outcome_kind = 'future_kind', outcome_detail = 'sk-SECRET private-host' \
             WHERE operation_id = ?1",
            [operation_id],
        )
        .expect("seed opaque terminal");
    drop(connection);
    session.queue_create();
    let router = session.router.clone();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(async move {
            let server = session.spawn();
            let response = post_json(
                &server,
                "/api/super-agent/messages",
                json!({"operation_id": operation_id, "text": USER_TEXT}),
            )
            .await;

            assert_eq!(response.status(), 200);
            let body = response.text().await.expect("opaque body");
            assert_eq!(
                serde_json::from_str::<Value>(&body).expect("opaque json"),
                json!({
                    "admission": "admitted",
                    "message_id": "m-1",
                    "outcome": {
                        "kind": "unknown_outcome",
                    },
                })
            );
            assert!(!body.contains("SECRET"));
            assert!(!body.contains("private-host"));
            assert_eq!(router.request_count(), 0);
            assert_eq!(
                count(&server.database, "SELECT COUNT(*) FROM router_messages"),
                1
            );
            assert_eq!(
                count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
                0
            );
        });
}

#[test]
fn non_text_terminal_replays_are_admitted_unknown_without_leak() {
    let session = Session::open("non-text-terminals");
    let cases = [
        (
            "d1111111-1111-4111-8111-111111111111",
            "m-1",
            "blob kind",
            "X'726F75746564'",
            "'secret-route'",
        ),
        (
            "d2222222-2222-4222-8222-222222222222",
            "m-2",
            "blob detail",
            "'routed'",
            "X'736B2D534543524554'",
        ),
        (
            "d3333333-3333-4333-8333-333333333333",
            "m-3",
            "numeric fields",
            "7",
            "1.5",
        ),
    ];
    let owner = SqliteOwner::open(OwnerOpen {
        path: session.database.clone(),
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("seed owner");
    for (operation_id, message_id, text, _, _) in cases {
        owner
            .begin_message_submission(MessageSubmissionWrite {
                operation_id: operation_id.to_owned(),
                text: text.to_owned(),
                message: RouterMessageWrite {
                    message_id: message_id.to_owned(),
                    role: "user".to_owned(),
                    body: text.to_owned(),
                    created_at: NOW,
                },
            })
            .expect("seed submission");
    }
    drop(owner);
    let connection = Connection::open(&session.database).expect("open sqlite");
    for (operation_id, _, _, kind_sql, detail_sql) in cases {
        connection
            .execute_batch(&format!(
                "UPDATE message_submissions SET state = 'terminal', \
                 outcome_kind = {kind_sql}, outcome_detail = {detail_sql} \
                 WHERE operation_id = '{operation_id}';"
            ))
            .expect("seed raw terminal");
    }
    drop(connection);
    let router = session.router.clone();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(async move {
            let server = session.spawn();
            for (operation_id, message_id, text, _, _) in cases {
                let response = post_json(
                    &server,
                    "/api/super-agent/messages",
                    json!({"operation_id": operation_id, "text": text}),
                )
                .await;
                assert_eq!(response.status(), 200);
                let body = response.text().await.expect("unknown body");
                assert_eq!(
                    serde_json::from_str::<Value>(&body).expect("unknown json"),
                    json!({
                        "admission": "admitted",
                        "message_id": message_id,
                        "outcome": {"kind": "unknown_outcome"},
                    })
                );
                assert!(!body.contains("SECRET"));
                assert!(!body.contains("secret-route"));
                assert!(!body.contains("726F"));
            }
            assert_eq!(router.request_count(), 0);
            assert_eq!(
                count(&server.database, "SELECT COUNT(*) FROM router_messages"),
                3
            );
            assert_eq!(
                count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
                0
            );
            assert_eq!(
                count(&server.database, "SELECT COUNT(*) FROM task_reports"),
                0
            );
        });
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_persistence_failure_after_side_effects_restarts_pending_without_duplicates() {
    let mut first = Session::open("terminal-failpoint-restart");
    first.queue_create();
    first.queue_progress("Stored once");
    let first_router = first.router.clone();
    let directory = first.directory.clone();
    let database = first.database.clone();
    let dist = first.dist.clone();
    let mut server = first.spawn();
    let connection = Connection::open(&server.database).expect("open sqlite");
    connection
        .execute_batch(
            "CREATE TRIGGER fail_terminal BEFORE UPDATE OF state ON message_submissions \
             WHEN NEW.state = 'terminal' \
             BEGIN SELECT RAISE(ABORT, 'terminal failpoint'); END;",
        )
        .expect("install terminal failpoint");
    let operation_id = "c2222222-2222-4222-8222-222222222222";
    let request = json!({"operation_id": operation_id, "text": USER_TEXT});

    let first_response = post_json(&server, "/api/super-agent/messages", request.clone()).await;
    assert_eq!(first_response.status(), 200);
    let pending = first_response
        .json::<Value>()
        .await
        .expect("pending response");
    assert_eq!(
        pending,
        json!({
            "admission": "admitted",
            "message_id": "m-1",
            "outcome": {
                "kind": "processing_pending",
                "reason": "processing_pending",
            },
        })
    );
    assert_eq!(first_router.request_count(), 3);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM router_messages"),
        3
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_reports"),
        1
    );

    server.directory = directory.join("preserved-until-replay");
    drop(server);
    let second_router = ScriptedRouter::create();
    let second = Session {
        router: second_router.clone(),
        tools: ScriptedToolHost::create(),
        ids: supply(),
        memories: Vec::new(),
        directory,
        database,
        dist,
        http_count: 4096,
        parent_work: ParentWork::Script,
    };
    second.queue_create();
    let replay_server = second.spawn();

    let replay = post_json(&replay_server, "/api/super-agent/messages", request).await;

    assert_eq!(replay.status(), 200);
    assert_eq!(replay.json::<Value>().await.expect("replay body"), pending);
    assert_eq!(second_router.request_count(), 0);
    assert_eq!(
        count(
            &replay_server.database,
            "SELECT COUNT(*) FROM router_messages"
        ),
        3
    );
    assert_eq!(
        count(
            &replay_server.database,
            "SELECT COUNT(*) FROM task_sessions"
        ),
        1
    );
    assert_eq!(
        count(&replay_server.database, "SELECT COUNT(*) FROM task_reports"),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn provider_and_internal_failures_use_stable_codes() {
    let session = Session::open("provider");
    session.queue_fail(&format!("API_KEY {LEAK} BASE_URL https://provider.example"));
    let server = session.spawn();
    let response = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await;
    assert_eq!(response.status(), 200);
    let body = response.text().await.expect("provider body");
    assert_eq!(
        serde_json::from_str::<Value>(&body).expect("admitted body"),
        json!({
            "admission": "admitted",
            "message_id": "m-1",
            "outcome": {
                "kind": "routing_failed",
                "reason": "model_provider_unavailable",
            },
        })
    );
    assert!(!body.contains(LEAK));
    assert!(!body.contains("API_KEY"));
    assert!(!body.contains("BASE_URL"));
    assert!(!body.contains("provider.example"));
    let stored = texts(&server.database, "SELECT body FROM router_messages");
    assert!(stored.iter().all(|text| !text.contains(LEAK)));
    assert!(stored.iter().all(|text| !text.contains("provider.example")));

    let internal = Session::open_with("internal", exhausted_ids());
    internal.queue_create();
    let internal = internal.spawn();
    let response = post_json(
        &internal,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.expect("internal body"),
        json!({
            "admission": "admitted",
            "message_id": "m-1",
            "outcome": {
                "kind": "processing_failed",
                "reason": "processing_unavailable",
            },
        })
    );
    assert_eq!(
        count(&internal.database, "SELECT COUNT(*) FROM task_sessions"),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn catalog_reads_pin_detail_reference_and_host_commands() {
    let mut session = Session::open("catalog");
    session.queue_create();
    session.queue_completion("Pin is ready");
    let server = session.spawn();
    let admitted = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await;
    assert_eq!(admitted.status(), 200);
    let sidebar = get(&server, "/api/super-agent/sidebar").await;
    assert_eq!(sidebar.status(), 200);
    assert!(
        sidebar
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .contains("application/json")
    );
    assert_eq!(
        sidebar
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    assert!(
        sidebar
            .headers()
            .get("access-control-allow-origin")
            .is_none()
    );
    let sidebar_body = sidebar.text().await.expect("sidebar");
    let sidebar_json: Value = serde_json::from_str(&sidebar_body).expect("sidebar json");
    let row = &sidebar_json["rows"][0];
    assert_eq!(row["task_id"], "task-1");
    assert_eq!(row["title"], USER_TEXT);
    assert_eq!(row["section"], "completed");
    assert_eq!(row["phase"], "completed");
    assert_eq!(row["summary"], "Pin is ready");
    assert_eq!(row["children"], json!([]));
    assert!(!sidebar_body.contains("API_KEY"));
    assert!(!sidebar_body.contains("fixture-model"));

    let detail = get(&server, "/api/super-agent/tasks/task-1").await;
    assert_eq!(detail.status(), 200);
    let detail_json: Value = detail.json().await.expect("detail");
    assert_eq!(detail_json["original_prompt"], USER_TEXT);
    assert_eq!(detail_json["helpers"], json!([]));
    assert_eq!(
        detail_json["tool_events"],
        json!([{
            "call_id": "call-1",
            "name": "script",
            "summary": "Pin is ready"
        }])
    );
    assert_eq!(detail_json["transcript"][0]["text"], "Pin is ready");

    let missing = get(&server, "/api/super-agent/tasks/missing").await;
    assert_eq!(missing.status(), 404);
    assert_eq!(
        missing.text().await.expect("missing"),
        r#"{"error":"unknown_task"}"#
    );

    let opened = post_json(
        &server,
        "/api/super-agent/tasks/task-1/detail",
        json!({"view": "open"}),
    )
    .await;
    assert_eq!(opened.status(), 200);
    assert_eq!(opened.text().await.expect("open"), r#"{"view":"open"}"#);
    let closed = post_json(
        &server,
        "/api/super-agent/tasks/task-1/detail",
        json!({"view": "closed_once"}),
    )
    .await;
    assert_eq!(closed.status(), 200);
    assert_eq!(
        closed.text().await.expect("close"),
        r#"{"view":"closed_once"}"#
    );
    let archived = get(&server, "/api/super-agent/sidebar").await;
    let archived_json: Value = archived.json().await.expect("archived");
    assert_eq!(archived_json["rows"][0]["section"], "archive");

    let pinned = post_json(
        &server,
        "/api/super-agent/tasks/task-1/pin",
        json!({"pin": "pinned"}),
    )
    .await;
    assert_eq!(pinned.status(), 200);
    assert_eq!(pinned.text().await.expect("pin"), r#"{"pin":"pinned"}"#);
    let pinned_rows: Value = get(&server, "/api/super-agent/sidebar")
        .await
        .json()
        .await
        .expect("pinned rows");
    assert_eq!(pinned_rows["rows"][0]["section"], "pinned");
    let unpinned = post_json(
        &server,
        "/api/super-agent/tasks/task-1/pin",
        json!({"pin": "unpinned"}),
    )
    .await;
    assert_eq!(unpinned.status(), 200);
    let restored: Value = get(&server, "/api/super-agent/sidebar")
        .await
        .json()
        .await
        .expect("restored");
    assert_eq!(restored["rows"][0]["section"], "archive");

    let reference = post_json(
        &server,
        "/api/super-agent/tasks/task-1/reference",
        json!({}),
    )
    .await;
    assert_eq!(reference.status(), 200);
    assert_eq!(
        reference.text().await.expect("reference"),
        r#"{"composer_insert":"task:task-1 "}"#
    );
    let unknown_ref = post_json(
        &server,
        "/api/super-agent/tasks/missing/reference",
        json!({}),
    )
    .await;
    assert_eq!(unknown_ref.status(), 404);

    let unknown_command = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "delete"}),
    )
    .await;
    assert_eq!(unknown_command.status(), 400);
    assert_eq!(
        unknown_command.text().await.expect("command"),
        r#"{"error":"unknown_command"}"#
    );
    let unknown_task = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "stop", "task_id": "missing"}),
    )
    .await;
    assert_eq!(unknown_task.status(), 404);
    assert_eq!(
        unknown_task.text().await.expect("unknown task"),
        r#"{"error":"unknown_task"}"#
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn close_before_open_does_not_archive() {
    let mut session = Session::open("close-first");
    session.queue_create();
    session.queue_completion("Still open");
    let server = session.spawn();
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await
    .error_for_status()
    .expect("admit");
    let closed = post_json(
        &server,
        "/api/super-agent/tasks/task-1/detail",
        json!({"view": "closed_once"}),
    )
    .await;
    assert_eq!(closed.status(), 409);
    assert_eq!(
        closed.text().await.expect("close"),
        r#"{"error":"detail_not_open"}"#
    );
    let rows: Value = get(&server, "/api/super-agent/sidebar")
        .await
        .json()
        .await
        .expect("rows");
    assert_eq!(rows["rows"][0]["section"], "completed");
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_holds_the_task_in_needs_you_and_stop_all_without_work_is_rejected() {
    let session = Session::open("stop");
    session.queue_create();
    let server = session.spawn();
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await
    .error_for_status()
    .expect("admit");
    let stopped = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "stop", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(stopped.status(), 200);
    assert_eq!(
        stopped.text().await.expect("stop"),
        r#"{"phase":"stopped"}"#
    );
    let rows: Value = get(&server, "/api/super-agent/sidebar")
        .await
        .json()
        .await
        .expect("rows");
    assert_eq!(rows["rows"][0]["section"], "needs_you");
    assert_eq!(rows["rows"][0]["phase"], "stopped");

    let empty = Session::open("stop-all");
    let empty = empty.spawn();
    let rejected = post_json(
        &empty,
        "/api/super-agent/host-command",
        json!({"command": "stop_all"}),
    )
    .await;
    assert_eq!(rejected.status(), 409);
    assert_eq!(
        rejected.text().await.expect("stop all"),
        r#"{"error":"command_rejected"}"#
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_wrong_phase_and_repeated_task_actions_fail_closed() {
    let mut completed = Session::open("task-action-matrix");
    completed.queue_create();
    completed.queue_completion("Done");
    let server = completed.spawn();
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await
    .error_for_status()
    .expect("complete task");

    for (path, body, status, error) in [
        (
            "/api/super-agent/tasks/missing/pin",
            json!({"pin": "pinned"}),
            404,
            "unknown_task",
        ),
        (
            "/api/super-agent/tasks/missing/detail",
            json!({"view": "open"}),
            404,
            "unknown_task",
        ),
        (
            "/api/super-agent/tasks/missing/reference",
            json!({}),
            404,
            "unknown_task",
        ),
        (
            "/api/super-agent/host-command",
            json!({"command": "stop", "task_id": "task-1"}),
            409,
            "command_rejected",
        ),
        (
            "/api/super-agent/host-command",
            json!({"command": "abandon", "task_id": "task-1"}),
            409,
            "command_rejected",
        ),
        (
            "/api/super-agent/host-command",
            json!({"command": "retry", "task_id": "task-1"}),
            409,
            "command_rejected",
        ),
    ] {
        let response = post_json(&server, path, body).await;
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(
            response.text().await.expect("action body"),
            format!(r#"{{"error":"{error}"}}"#)
        );
    }

    let first_pin = post_json(
        &server,
        "/api/super-agent/tasks/task-1/pin",
        json!({"pin": "pinned"}),
    )
    .await;
    assert_eq!(first_pin.status(), 200);
    let repeated_pin = post_json(
        &server,
        "/api/super-agent/tasks/task-1/pin",
        json!({"pin": "pinned"}),
    )
    .await;
    assert_eq!(repeated_pin.status(), 200);

    let opened = post_json(
        &server,
        "/api/super-agent/tasks/task-1/detail",
        json!({"view": "open"}),
    )
    .await;
    assert_eq!(opened.status(), 200);
    let closed = post_json(
        &server,
        "/api/super-agent/tasks/task-1/detail",
        json!({"view": "closed_once"}),
    )
    .await;
    assert_eq!(closed.status(), 200);
    let repeated_close = post_json(
        &server,
        "/api/super-agent/tasks/task-1/detail",
        json!({"view": "closed_once"}),
    )
    .await;
    assert_eq!(repeated_close.status(), 200);
    assert_eq!(
        repeated_close.text().await.expect("repeat close"),
        r#"{"view":"closed_once"}"#
    );
    let rows: Value = get(&server, "/api/super-agent/sidebar")
        .await
        .json()
        .await
        .expect("rows after repeated close");
    assert_eq!(rows["rows"][0]["section"], "pinned");
}

#[tokio::test(flavor = "multi_thread")]
async fn panic_is_not_a_host_command_and_changes_no_phase() {
    let session = Session::open("panic-rejected");
    session.queue_create();
    let server = session.spawn();
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await
    .error_for_status()
    .expect("admit task");
    let before: Value = get(&server, "/api/super-agent/sidebar")
        .await
        .json()
        .await
        .expect("rows before");

    let rejected = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "panic"}),
    )
    .await;

    assert_eq!(rejected.status(), 400);
    let after: Value = get(&server, "/api/super-agent/sidebar")
        .await
        .json()
        .await
        .expect("rows after");
    assert_eq!(after["rows"][0]["phase"], before["rows"][0]["phase"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_ends_a_stopped_task_and_archives_it_once() {
    let session = Session::open("cancel-after-stop");
    session.queue_create();
    let server = session.spawn();
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await
    .error_for_status()
    .expect("admit");
    let stopped = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "stop", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(stopped.status(), 200);

    let cancelled = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "cancel", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(cancelled.status(), 200);
    assert_eq!(
        cancelled.text().await.expect("cancel"),
        r#"{"phase":"cancelled"}"#
    );
    let rows: Value = get(&server, "/api/super-agent/sidebar")
        .await
        .json()
        .await
        .expect("rows");
    assert_eq!(rows["rows"][0]["section"], "archive");
    assert_eq!(rows["rows"][0]["phase"], "cancelled");

    let repeated = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "cancel", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(repeated.status(), 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn abandon_stop_all_and_retry_are_phase_safe_when_repeated() {
    let abandon = Session::open("repeat-abandon");
    abandon.queue_create();
    let abandon = abandon.spawn();
    post_json(
        &abandon,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await
    .error_for_status()
    .expect("admit abandon task");
    let abandoned = post_json(
        &abandon,
        "/api/super-agent/host-command",
        json!({"command": "abandon", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(abandoned.status(), 200);
    let abandoned_again = post_json(
        &abandon,
        "/api/super-agent/host-command",
        json!({"command": "abandon", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(abandoned_again.status(), 409);

    for command in ["stop_all"] {
        let session = Session::open(&format!("repeat-{command}"));
        session.queue_create();
        let server = session.spawn();
        post_json(
            &server,
            "/api/super-agent/messages",
            json!({"text": USER_TEXT}),
        )
        .await
        .error_for_status()
        .expect("admit command task");
        let first = post_json(
            &server,
            "/api/super-agent/host-command",
            json!({"command": command}),
        )
        .await;
        assert_eq!(first.status(), 200, "{command}");
        let repeated = post_json(
            &server,
            "/api/super-agent/host-command",
            json!({"command": command}),
        )
        .await;
        assert_eq!(repeated.status(), 409, "{command}");
    }

    let mut failed = Session::open("repeat-retry");
    failed.queue_create();
    failed.queue_failure("Failed once");
    let failed = failed.spawn();
    post_json(
        &failed,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await
    .error_for_status()
    .expect("admit failed task");
    let retry = post_json(
        &failed,
        "/api/super-agent/host-command",
        json!({"command": "retry", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(retry.status(), 200);
    let retry_again = post_json(
        &failed,
        "/api/super-agent/host-command",
        json!({"command": "retry", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(retry_again.status(), 409);
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_detail_open_preserves_the_next_detail_id() {
    let session = Session::open("detail-id-preflight");
    session.queue_create();
    session.queue_create();
    let server = session.spawn();
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "first task"}),
    )
    .await
    .error_for_status()
    .expect("first task");
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "second task"}),
    )
    .await
    .error_for_status()
    .expect("second task");

    let first = post_json(
        &server,
        "/api/super-agent/tasks/task-1/detail",
        json!({"view": "open"}),
    )
    .await;
    assert_eq!(first.status(), 200);
    let rejected = post_json(
        &server,
        "/api/super-agent/tasks/task-1/detail",
        json!({"view": "open"}),
    )
    .await;
    assert_eq!(rejected.status(), 409);
    let second = post_json(
        &server,
        "/api/super-agent/tasks/task-2/detail",
        json!({"view": "open"}),
    )
    .await;
    assert_eq!(second.status(), 200);

    assert_eq!(
        texts(
            &server.database,
            "SELECT completion_view FROM task_sessions ORDER BY task_id",
        ),
        vec!["open:detail-1".to_owned(), "open:detail-2".to_owned()]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_host_commands_preserve_the_next_command_id() {
    let session = Session::open("command-id-preflight");
    session.queue_create();
    session.queue_create();
    let server = session.spawn();
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "first task"}),
    )
    .await
    .error_for_status()
    .expect("first task");
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "second task"}),
    )
    .await
    .error_for_status()
    .expect("second task");

    let missing = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "stop", "task_id": "missing"}),
    )
    .await;
    assert_eq!(missing.status(), 404);
    let first = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "stop", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(first.status(), 200);
    let repeated = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "stop", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(repeated.status(), 409);
    let second = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "stop", "task_id": "task-2"}),
    )
    .await;
    assert_eq!(second.status(), 200);

    assert_eq!(
        texts(
            &server.database,
            "SELECT phase FROM task_sessions ORDER BY task_id",
        ),
        vec!["stopped:1".to_owned(), "stopped:2".to_owned()]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_abandon_preserves_the_next_decision_id() {
    let mut session = Session::open("decision-id-preflight");
    session.queue_create();
    session.queue_completion("done");
    session.queue_create();
    let server = session.spawn();
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "completed task"}),
    )
    .await
    .error_for_status()
    .expect("completed task");
    post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "queued task"}),
    )
    .await
    .error_for_status()
    .expect("queued task");

    let rejected = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "abandon", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(rejected.status(), 409);
    let accepted = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "abandon", "task_id": "task-2"}),
    )
    .await;
    assert_eq!(accepted.status(), 200);

    assert_eq!(
        texts(
            &server.database,
            "SELECT phase FROM task_sessions WHERE task_id = 'task-2'",
        ),
        vec!["abandoned:decision-1".to_owned()]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_pushes_sidebar_after_commit_and_ignores_client_text() {
    let mut session = Session::open("ws");
    session.queue_create();
    session.queue_completion("Pin is ready");
    session.queue_create();
    let server = session.spawn();
    let ws_url = format!(
        "ws://{}/api/super-agent/ws",
        server.origin.trim_start_matches("http://")
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .expect("websocket");
    let early = tokio::time::timeout(Duration::from_millis(200), socket.next()).await;
    assert!(early.is_err(), "no frame before a commit");
    let posted = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await;
    assert_eq!(posted.status(), 200);
    let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("frame wait")
        .expect("frame stream")
        .expect("frame");
    let text = match message {
        tokio_tungstenite::tungstenite::Message::Text(text) => text.to_string(),
        other => panic!("expected text, got {other:?}"),
    };
    assert!(text.contains("task-1"));
    assert!(text.contains("Pin is ready"));
    assert!(text.contains("\"section\":\"completed\""));
    assert!(!text.contains("API_KEY"));
    assert!(!text.contains("BASE_URL"));
    assert!(!text.contains("fixture-model"));
    drop(socket);
    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://{}/api/super-agent/ws",
        server.origin.trim_start_matches("http://")
    ))
    .await
    .expect("reconnect websocket");
    let replay = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("replay wait")
        .expect("replay stream")
        .expect("replay frame");
    let replay_text = match replay {
        tokio_tungstenite::tungstenite::Message::Text(text) => text.to_string(),
        other => panic!("expected replay text, got {other:?}"),
    };
    assert_eq!(replay_text, text);
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            r#"{"command":"stop_all"}"#.into(),
        ))
        .await
        .expect("client text");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let rows: Value = get(&server, "/api/super-agent/sidebar")
        .await
        .json()
        .await
        .expect("rows");
    assert_eq!(rows["rows"][0]["phase"], "completed");
    drop(socket);
    let again = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "second note"}),
    )
    .await;
    assert_eq!(again.status(), 200);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        2
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn spa_fallback_does_not_swallow_api_routes() {
    let session = Session::open("spa");
    let server = session.spawn();
    let root = get(&server, "/").await;
    assert_eq!(root.status(), 200);
    assert!(
        root.headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .contains("text/html")
    );
    assert_eq!(
        root.headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-cache")
    );
    let root_body = root.text().await.expect("root");
    assert!(root_body.contains("Maia shell"));
    let route = get(&server, "/tasks/demo").await;
    assert_eq!(route.status(), 200);
    assert!(route.text().await.expect("route").contains("Maia shell"));
    let junk = get(&server, "/not-a-maia-route").await;
    assert_eq!(junk.status(), 404);
    assert!(
        !junk
            .text()
            .await
            .expect("junk route")
            .contains("Maia shell")
    );
    let missing = get(&server, "/api/super-agent/missing").await;
    assert_eq!(missing.status(), 404);
    assert!(
        missing
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .contains("application/json")
    );
    assert_eq!(
        missing
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
    let missing_body = missing.text().await.expect("api 404");
    assert_eq!(missing_body, r#"{"error":"unknown_route"}"#);
    assert!(!missing_body.contains("Maia shell"));
}

#[tokio::test(flavor = "multi_thread")]
async fn script_text_stays_json_and_out_of_the_shell() {
    let session = Session::open("script");
    session.queue_create();
    let server = session.spawn();
    let text = "<script>alert(1)</script>";
    post_json(&server, "/api/super-agent/messages", json!({"text": text}))
        .await
        .error_for_status()
        .expect("admit");
    assert_eq!(prompt_blob(&server.database), text.as_bytes());
    let sidebar = get(&server, "/api/super-agent/sidebar").await;
    assert!(
        sidebar
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .contains("application/json")
    );
    let shell = get(&server, "/").await;
    assert!(!shell.text().await.expect("shell").contains("<script>alert"));
}

#[tokio::test(flavor = "multi_thread")]
async fn loopback_phone_status_stays_off_until_the_certificate_is_acknowledged() {
    let server = spawn_with_scripted_router();
    let status = get(&server, "/api/remote/status").await;
    assert_eq!(status.status(), 200);
    let body = status.json::<Value>().await.expect("status");
    assert_eq!(body["enabled"], false);
    assert_eq!(body["phase"], "disabled");
    assert!(body.get("code").is_none());
    let denied = post_json(
        &server,
        "/api/remote/enable",
        json!({ "acknowledge_certificate_publication": false }),
    )
    .await;
    assert_eq!(denied.status(), 400);
    assert_eq!(body["url"], Value::Null);
}

#[test]
fn ui_bind_addr_is_loopback_4178() {
    let addr = ui_bind_addr();
    assert_eq!(addr, SocketAddr::from((Ipv4Addr::LOCALHOST, 4178)));
    assert!(addr.ip().is_loopback());
    assert_ne!(addr.ip(), std::net::IpAddr::V4(Ipv4Addr::UNSPECIFIED));
}

#[test]
fn second_daemon_server_cannot_bind_the_owned_address() {
    let first = Session::open("single-owner-first").spawn();
    let mut second = Session::open("single-owner-second");
    second.database = first.database.clone();
    let second_directory = second.directory.clone();
    let second_router = second.router.clone();

    let result = second.try_spawn_router_at(second_router, first.local_addr);

    assert!(matches!(result, Err(ServeFailure::Bind)));
    drop(first);
    let _ = std::fs::remove_dir_all(second_directory);
}

#[test]
fn coalesce_sidebar_keeps_the_latest_non_empty_frame() {
    let frames = vec![
        String::new(),
        r#"{"rows":[{"task_id":"task-1"}]}"#.to_owned(),
        r#"{"rows":[{"task_id":"task-1","section":"pinned"}]}"#.to_owned(),
    ];
    assert_eq!(
        coalesce_sidebar(&frames),
        Some(r#"{"rows":[{"task_id":"task-1","section":"pinned"}]}"#)
    );
    assert_eq!(coalesce_sidebar(&[String::new()]), None);
}

#[test]
fn parse_model_ids_sorts_without_a_vendor_or_leaking_the_body() {
    let ids = parse_model_ids(r#"{"data":[{"id":"gpt-4o"},{"id":"alpha","object":"model"}]}"#)
        .expect("ids");
    assert_eq!(select_model_id(&ids).expect("selected"), "alpha");
    let secret = "sk-fixture-do-not-leak";
    let error = parse_model_ids(&format!(r#"{{"error":"{secret}"}}"#)).expect_err("unreadable");
    let rendered = format!("{error} {error:?}");
    assert_eq!(error, ModelListError::Unreadable);
    assert!(!rendered.contains(secret));
    assert_eq!(
        parse_model_ids(r#"{"data":[]}"#).expect_err("empty"),
        ModelListError::Empty
    );
    assert_eq!(
        parse_model_ids(r#"{"data":[{"id":"   "}]}"#).expect_err("blank"),
        ModelListError::BlankId
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn discover_model_id_uses_bearer_auth_and_hides_error_bodies() {
    let seen = Arc::new(Mutex::new(None));
    let seen_for_route = Arc::clone(&seen);
    let app = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(move |request: axum::extract::Request| {
            let seen_for_route = Arc::clone(&seen_for_route);
            async move {
                let header = request
                    .headers()
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_owned();
                *seen_for_route.lock().expect("header") = Some(header);
                axum::Json(json!({"data":[{"id":"zeta"},{"id":"alpha"}]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .expect("bind models");
    let address = listener.local_addr().expect("models addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let selected = discover_model_id_bounded(
        &format!("http://{address}/v1"),
        "fixture-key",
        1024,
        Duration::from_secs(2),
    )
    .await
    .expect("model");
    assert_eq!(selected, "alpha");
    assert_eq!(
        seen.lock().expect("seen").as_deref(),
        Some("Bearer fixture-key")
    );

    let failure = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(|| async {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("API_KEY {LEAK} upstream-secret"),
            )
        }),
    );
    let failure_listener =
        tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("bind failure");
    let failure_address = failure_listener.local_addr().expect("failure addr");
    tokio::spawn(async move {
        let _ = axum::serve(failure_listener, failure).await;
    });
    let error = discover_model_id_bounded(
        &format!("http://{failure_address}/v1"),
        "fixture-key",
        1024,
        Duration::from_secs(2),
    )
    .await
    .expect_err("hidden");
    let rendered = format!("{error} {error:?}");
    assert_eq!(error, ModelListError::Unavailable);
    assert!(!rendered.contains(LEAK));
    assert!(!rendered.contains("upstream-secret"));
    assert!(!rendered.contains("fixture-key"));

    let huge = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(|| async { "x".repeat(80) }),
    );
    let huge_listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .expect("bind huge");
    let huge_address = huge_listener.local_addr().expect("huge addr");
    tokio::spawn(async move {
        let _ = axum::serve(huge_listener, huge).await;
    });
    let limited = discover_model_id_bounded(
        &format!("http://{huge_address}/v1"),
        "fixture-key",
        32,
        Duration::from_secs(2),
    )
    .await
    .expect_err("bounded");
    assert_eq!(limited, ModelListError::Unavailable);
    assert!(!format!("{limited}").contains("xxxx"));
}

#[tokio::test(flavor = "multi_thread")]
async fn runtime_router_pending_future_creates_one_task() {
    let scripted = ScriptedRouter::create();
    scripted.push_proposal(create_task(900, 200));
    let proxy = RuntimeRouter::spawn(
        tokio::runtime::Handle::current(),
        PendingFirst { inner: scripted },
    );
    let session = Session::open("runtime-router");
    session.queue_create();
    let server = session.spawn_router(proxy);
    let response = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.expect("body"),
        routed_body("m-1", "admit")
    );
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    assert_eq!(prompt_blob(&server.database), USER_TEXT.as_bytes());
}

fn http_status(origin: &str) -> Result<u16, std::io::Error> {
    let mut stream = TcpStream::connect(origin.trim_start_matches("http://"))?;
    stream.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    text.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| std::io::Error::other("missing status"))
}

#[test]
fn wait_keeps_the_listener_up_until_explicit_shutdown() {
    let session = Session::open("lifecycle");
    let mut running = session.spawn();
    let origin = running.origin.clone();
    let server = running.server.take().expect("server");
    let shutdown = server.shutdown_handle();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let waiter = std::thread::spawn(move || {
        started_tx.send(()).expect("started");
        server.wait();
        finished_tx.send(()).expect("finished");
    });
    started_rx.recv().expect("waiter entered");
    let mut live = 0;
    loop {
        if finished_rx.try_recv().is_ok() {
            panic!("wait returned before shutdown");
        }
        match http_status(&origin) {
            Ok(200) => {
                live += 1;
                if live == 2 {
                    break;
                }
            }
            Ok(status) => panic!("unexpected status {status}"),
            Err(_) => {
                if finished_rx.try_recv().is_ok() {
                    panic!("wait returned before shutdown");
                }
            }
        }
    }
    assert!(
        finished_rx.try_recv().is_err(),
        "wait returned while the origin was still serving"
    );
    assert_eq!(http_status(&origin).expect("still listening"), 200);
    shutdown.request();
    shutdown.request();
    finished_rx.recv().expect("wait returns after shutdown");
    waiter.join().expect("waiter");
    let mut gone = false;
    for _ in 0..100 {
        if http_status(&origin).is_err() {
            gone = true;
            break;
        }
    }
    assert!(gone, "listener stayed up after shutdown");
}

#[tokio::test(flavor = "multi_thread")]
async fn model_connection_save_never_returns_or_stores_the_api_key() {
    let server = spawn_with_scripted_router();
    let secret = LEAK;
    let initial = get(&server, "/api/super-agent/model-connection").await;
    assert_eq!(initial.status(), 200);
    let initial_body = initial.text().await.expect("initial body");
    assert!(initial_body.contains("\"key_set\":false"));
    assert!(!initial_body.contains(secret));

    let tested = post_json(
        &server,
        "/api/super-agent/model-connection/test",
        json!({
            "base_url": "https://example.test/v1",
            "api_key": secret
        }),
    )
    .await;
    assert_eq!(tested.status(), 503);
    let tested_body = tested.text().await.expect("test body");
    assert!(!tested_body.contains(secret));
    assert_eq!(tested_body, r#"{"error":"model_provider_unavailable"}"#);

    let rejected = put_json(
        &server,
        "/api/super-agent/model-connection",
        json!({
            "base_url": "http://example.test/v1",
            "api_key": secret,
            "model": "example-chat",
            "reasoning": "medium"
        }),
    )
    .await;
    assert_eq!(rejected.status(), 400);
    let rejected_body = rejected.text().await.expect("rejected body");
    assert!(!rejected_body.contains(secret));
    assert_eq!(rejected_body, r#"{"error":"invalid_model_connection"}"#);

    let saved = put_json(
        &server,
        "/api/super-agent/model-connection",
        json!({
            "base_url": "https://example.test/v1/",
            "api_key": secret,
            "model": " example-chat ",
            "reasoning": "medium"
        }),
    )
    .await;
    assert_eq!(saved.status(), 200);
    let saved_body = saved.text().await.expect("saved body");
    assert!(!saved_body.contains(secret));
    assert!(saved_body.contains("\"key_set\":true"));
    assert!(saved_body.contains("example-chat"));
    assert!(saved_body.contains("https://example.test/v1"));

    let kept = put_json(
        &server,
        "/api/super-agent/model-connection",
        json!({
            "base_url": "https://example.test/v1",
            "model": "example-small",
            "reasoning": "high"
        }),
    )
    .await;
    assert_eq!(kept.status(), 200);
    let kept_body = kept.text().await.expect("kept body");
    assert!(!kept_body.contains(secret));
    assert!(kept_body.contains("example-small"));
    assert!(kept_body.contains("\"key_set\":true"));

    let stored = texts(
        &server.database,
        "SELECT base_url || ' ' || model_id || ' ' || reasoning FROM model_connection",
    );
    assert_eq!(
        stored,
        vec!["https://example.test/v1 example-small high".to_owned()]
    );
    assert!(!database_contains(&server.database, secret));
}

#[tokio::test(flavor = "multi_thread")]
async fn installed_router_handles_the_next_completion() {
    let first = ScriptedRouter::create();
    first.push_fail("first-router".to_owned());
    let second = ScriptedRouter::create();
    second.push_fail("second-router".to_owned());
    let (proxy, install) =
        RuntimeRouter::spawn_with_install(tokio::runtime::Handle::current(), first);
    let request = RouterRequest {
        request_id: RequestId(1),
        model: "fixture-model".to_owned(),
        messages: Vec::new(),
        tools_json: CanonicalJson("[]".to_owned()),
        prefix_hash: PrefixHash::new("fixture-prefix"),
        recall_hash: None,
        reasoning_effort: ReasoningEffort::Low,
        prior_provider_tool_state: None,
    };
    let first_result = proxy.complete(&request).await;
    assert!(matches!(
        first_result,
        Err(RouterError::Protocol { detail }) if detail == "first-router"
    ));
    install.send(second).await.expect("install");
    let second_result = proxy.complete(&request).await;
    assert!(matches!(
        second_result,
        Err(RouterError::Protocol { detail }) if detail == "second-router"
    ));
}

async fn put_json(server: &Running, path: &str, body: Value) -> reqwest::Response {
    server
        .client
        .put(format!("{}{path}", server.origin))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .expect("put")
}

fn database_contains(path: &Path, needle: &str) -> bool {
    let needle = needle.as_bytes();
    [path.to_path_buf(), wal_path(path), shm_path(path)]
        .into_iter()
        .any(|file| {
            std::fs::read(file)
                .map(|bytes| bytes.windows(needle.len()).any(|window| window == needle))
                .unwrap_or(false)
        })
}

fn wal_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-wal", path.display()))
}

fn shm_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-shm", path.display()))
}

async fn patch_json(server: &Running, path: &str, body: Value) -> reqwest::Response {
    server
        .client
        .patch(format!("{}{path}", server.origin))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .expect("patch")
}

async fn delete_api(server: &Running, path: &str) -> reqwest::Response {
    server
        .client
        .delete(format!("{}{path}", server.origin))
        .send()
        .await
        .expect("delete")
}

fn brain_sentence(map: &Value, id: &str) -> Option<String> {
    map["nodes"].as_array()?.iter().find_map(|node| {
        if node["id"] == id {
            node["sentence"].as_str().map(str::to_owned)
        } else {
            None
        }
    })
}

fn brain_has_lexeme(map: &Value, id: &str) -> bool {
    map["nodes"].as_array().is_some_and(|nodes| {
        nodes
            .iter()
            .any(|node| node["id"] == id && node["kind"] == "lexeme")
    })
}

fn seed_http_brain(path: &Path) {
    let owner = SqliteOwner::open(OwnerOpen {
        path: path.to_path_buf(),
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("seed store");
    owner
        .append(AppendEvents {
            thread_id: "thread-1".to_owned(),
            expected_version: 0,
            participants: "agent-1".to_owned(),
            occurred_at: 81,
            events: vec![ThreadEventWrite {
                event_id: "event-1".to_owned(),
                kind: "user".to_owned(),
                body: "hi".to_owned(),
            }],
        })
        .expect("append");
    owner
        .insert_episode(EpisodeWrite {
            episode_id: "episode-1".to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            body: "Obsidian opens the vault".to_owned(),
            taint: MemoryTaint::Untrusted,
            reasoning: None,
            participants: "agent-1".to_owned(),
            created_at: 40,
            segments: vec![SegmentWrite {
                text: "Obsidian opens the vault".to_owned(),
                taint: MemoryTaint::Untrusted,
                sources: "owner".to_owned(),
            }],
        })
        .expect("episode");
    owner
        .apply_promotion(PromotionWrite {
            episode_id: "episode-1".to_owned(),
            model: "model-a".to_owned(),
            now: 60,
            claims: vec![PromotionClaimWrite {
                claim_id: "claim-1".to_owned(),
                sentence: "Obsidian opens the vault.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: 40,
                lexemes: vec!["obsidian".to_owned(), "vault".to_owned()],
            ..Default::default()
        }],
            same_claim_ids: Vec::new(),
            replacements: Vec::new(),
            links: Vec::new(),
        })
        .expect("promotion");
    owner
        .apply_ledger(LedgerWrite {
            ledger_id: "ledger-1".to_owned(),
            thread_id: "thread-1".to_owned(),
            request_id: "request-1".to_owned(),
            compiled_prefix_hash: "prefix-hash".to_owned(),
            applied_at: 70,
            presentations: vec![PresentationWrite {
                presentation_id: "p1".to_owned(),
                candidate_kind: MemoryKind::Claim,
                candidate_id: "claim-1".to_owned(),
                source: EvidenceSource::Reasoning,
                weight: 1.0,
                source_span_start: 0,
                source_span_end: 4,
                evidence_span_start: 0,
                evidence_span_end: 4,
                thread_id: "thread-1".to_owned(),
            }],
            heat: vec![HeatWrite {
                slot_id: "slot-1".to_owned(),
                weight: 1.0,
            }],
            co_use: vec![CoUseWrite {
                left_kind: MemoryKind::Claim,
                left_id: "claim-1".to_owned(),
                right_kind: MemoryKind::Fact,
                right_id: "fact-1".to_owned(),
                weight: 1.0,
            }],
            negative_marks: vec![NegativeMarkWrite {
                mark_id: "mark-ledger-1".to_owned(),
                target_kind: MemoryKind::Claim,
                target_id: "claim-1".to_owned(),
                presentation_id: "p1".to_owned(),
                thread_id: "thread-1".to_owned(),
                message_id: "message-2".to_owned(),
                evidence_span_start: 0,
                evidence_span_end: 3,
                occurred_at: 71,
                dream_queue_id: "dream-ledger-1".to_owned(),
            }],
        })
        .expect("ledger");
    owner
        .apply_consolidation(ConsolidationWrite {
            batch_id: "batch-1".to_owned(),
            now: 90,
            context_taint: MemoryTaint::Untrusted,
            model: "model-a".to_owned(),
            entities: vec![EntityWrite {
                entity_id: "entity-1".to_owned(),
                slug: "obsidian".to_owned(),
                description: "A local notes application.".to_owned(),
                scope: EntityScope::World,
                see: Vec::new(),
            }],
            facts: vec![FactWrite {
                fact_id: "fact-1".to_owned(),
                sentence: "Obsidian opens the vault.".to_owned(),
                entity_id: Some("entity-1".to_owned()),
                sources: "episode-1".to_owned(),
                valid_from: 40,
                claim_ids: vec!["claim-1".to_owned()],
                episode_ids: vec!["episode-1".to_owned()],
            }],
            supersede: vec![SupersedeWrite {
                claim_id: "claim-1".to_owned(),
                fact_id: "fact-1".to_owned(),
            }],
            merges: Vec::new(),
            closures: Vec::new(),
            dismissals: Vec::new(),
            proposals: Vec::new(),
            consumed_queue_ids: vec!["dream-ledger-1".to_owned()],
            release_holds: vec![HoldTarget {
                kind: MemoryKind::Claim,
                id: "claim-1".to_owned(),
            }],
            projection_entities: vec!["entity-1".to_owned()],
            projection_folders: vec!["entities".to_owned()],
        })
        .expect("consolidation");
    owner.shutdown().expect("close seed store");
}

#[tokio::test(flavor = "multi_thread")]
async fn brain_map_is_empty_and_rejects_a_missing_fact() {
    let server = Session::open("brain-empty").spawn();
    let response = get(&server, "/api/brain/map").await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.expect("map"),
        json!({
            "nodes": [],
            "edges": [],
            "tag_catalog": [
                {"id": "tag-people", "name": "People", "role": "people"},
                {"id": "tag-places", "name": "Places", "role": "places"},
                {"id": "tag-things", "name": "Things", "role": "things"},
                {"id": "tag-ideas", "name": "Ideas", "role": "ideas"}
            ]
        })
    );
    let missing = patch_json(
        &server,
        "/api/brain/facts/fact-1",
        json!({"sentence": "Notes stay on this computer."}),
    )
    .await;
    assert_eq!(missing.status(), 404);
    assert_eq!(
        missing.json::<Value>().await.expect("missing"),
        json!({"error": "unknown_fact"})
    );
    let blank = patch_json(
        &server,
        "/api/brain/facts/fact-1",
        json!({"sentence": "\n"}),
    )
    .await;
    assert_eq!(blank.status(), 400);
    assert_eq!(
        blank.json::<Value>().await.expect("blank"),
        json!({"error": "invalid_fact"})
    );
}

#[test]
fn brain_map_revise_and_delete_round_trip() {
    let session = Session::open("brain-map");
    seed_http_brain(&session.database);
    tokio::runtime::Runtime::new()
        .expect("runtime")
        .block_on(revise_and_delete_brain(session));
}

async fn revise_and_delete_brain(session: Session) {
    let server = session.spawn();
    let loaded = get(&server, "/api/brain/map").await;
    assert_eq!(loaded.status(), 200);
    let loaded = loaded.json::<Value>().await.expect("loaded map");
    assert_eq!(
        brain_sentence(&loaded, "fact-1").as_deref(),
        Some("Obsidian opens the vault.")
    );
    assert_eq!(
        brain_sentence(&loaded, "episode-1").as_deref(),
        Some("Obsidian opens the vault")
    );

    let rejected = patch_json(
        &server,
        "/api/brain/facts/fact-1",
        json!({"sentence": "two\nlines"}),
    )
    .await;
    assert_eq!(rejected.status(), 400);

    let revised = patch_json(
        &server,
        "/api/brain/facts/fact-1",
        json!({"sentence": "Notes stay on this computer."}),
    )
    .await;
    assert_eq!(revised.status(), 200);
    let revised = revised.json::<Value>().await.expect("revised map");
    assert_eq!(
        brain_sentence(&revised, "fact-1").as_deref(),
        Some("Notes stay on this computer.")
    );
    assert!(
        !revised["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .any(|node| node["kind"] == "lexeme")
    );
    let lexemes = get(&server, "/api/brain/map?include=lexemes").await;
    assert_eq!(lexemes.status(), 200);
    let lexemes = lexemes.json::<Value>().await.expect("lexeme map");
    assert!(brain_has_lexeme(&lexemes, "notes"));
    assert!(brain_has_lexeme(&lexemes, "stay"));
    assert!(brain_has_lexeme(&lexemes, "computer"));
    assert!(!brain_has_lexeme(&lexemes, "on"));
    assert!(!brain_has_lexeme(&lexemes, "this"));
    assert!(!brain_has_lexeme(&lexemes, "obsidian"));

    let deleted = delete_api(&server, "/api/brain/facts/fact-1").await;
    assert_eq!(deleted.status(), 200);
    let deleted = deleted.json::<Value>().await.expect("deleted map");
    assert_eq!(brain_sentence(&deleted, "fact-1"), None);
    assert_eq!(
        brain_sentence(&deleted, "episode-1").as_deref(),
        Some("Obsidian opens the vault")
    );
    assert!(
        deleted["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .all(|node| node["sentence"] != "Notes stay on this computer.")
    );

    let again = delete_api(&server, "/api/brain/facts/fact-1").await;
    assert_eq!(again.status(), 404);
    assert_eq!(
        again.json::<Value>().await.expect("missing delete"),
        json!({"error": "unknown_fact"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_settings_hide_secrets_and_admit_only_the_listed_hash() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("addr");
    thread::spawn(move || {
        for _ in 0..4 {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut bytes = Vec::new();
            let mut buf = [0_u8; 4096];
            if let Ok(count) = stream.read(&mut buf) {
                bytes.extend_from_slice(&buf[..count]);
            }
            let request = String::from_utf8_lossy(&bytes);
            let body = if request.contains("notifications/initialized") {
                String::new()
            } else if request.contains("\"method\":\"initialize\"") {
                r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{}}}"#.to_owned()
            } else {
                r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"scrape","description":"Read a page","inputSchema":{"type":"object","required":["url"],"properties":{"url":{"type":"string"}}}}]}}"#.to_owned()
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    let server = spawn_with_scripted_router();
    let secret = "super-secret-value";
    let created = post_json(
        &server,
        "/api/super-agent/mcp",
        json!({
            "id": "web",
            "label": "Web",
            "transport": "http",
            "url": format!("http://{address}/mcp"),
            "headers": [{"name": "Authorization", "value": secret}]
        }),
    )
    .await;
    assert_eq!(created.status(), 200);
    let created_body = created.text().await.expect("created");
    assert!(created_body.contains("\"secret_set\":true"));
    assert!(!created_body.contains(secret));
    let listed = server
        .client
        .post(format!("{}/api/super-agent/mcp/web/list", server.origin))
        .send()
        .await
        .expect("list");
    assert_eq!(listed.status(), 200);
    let listed_body = listed.text().await.expect("listed body");
    assert!(listed_body.contains("Read a page"));
    assert!(listed_body.contains("pending approval"));
    assert!(!listed_body.contains(secret));
    let hash = listed_body
        .split("\"listed_hash\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("hash")
        .to_owned();
    let rejected = post_json(
        &server,
        "/api/super-agent/mcp/web/admit",
        json!({"hash": "not-the-listed-hash"}),
    )
    .await;
    assert_eq!(rejected.status(), 400);
    let admitted = post_json(
        &server,
        "/api/super-agent/mcp/web/admit",
        json!({"hash": hash}),
    )
    .await;
    assert_eq!(admitted.status(), 200);
    let admitted_body = admitted.text().await.expect("admitted");
    assert!(admitted_body.contains("\"status\":\"live\""));
    assert!(!admitted_body.contains(secret));
}

fn operation(suffix: &str) -> String {
    format!("00000000-0000-4000-8000-{suffix}")
}

async fn post_now(server: &Running, operation_id: &str, text: &str) -> reqwest::Response {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .expect("client");
    client
        .post(format!("{}/api/super-agent/messages", server.origin))
        .header("content-type", "application/json")
        .json(&json!({
            "operation_id": operation_id,
            "text": text,
        }))
        .send()
        .await
        .expect("send returned")
}

fn push_success(router: &ScriptedRouter, message: &str) {
    router.push(ScriptedReply::Tool {
        name: "success".to_owned(),
        arguments: format!(r#"{{"message":"{message}"}}"#),
    });
}

async fn wait_text(server: &Running, needle: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let body = get(server, "/api/super-agent/transcript")
            .await
            .text()
            .await
            .expect("transcript");
        if body.contains(needle) {
            return;
        }
        if std::time::Instant::now() > deadline {
            panic!("transcript never contained {needle}: {body}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn second_message_is_accepted_while_a_router_turn_is_blocked() {
    let session = Session::open("accept-while-blocked");
    session.queue_create();
    session.queue_create();
    let gate = HoldGate::create();
    let started = Arc::new(AtomicBool::new(false));
    let router = HoldingRouter {
        inner: session.router.clone(),
        gate: Arc::clone(&gate),
        started: Arc::clone(&started),
    };
    let server = session.spawn_router(router);
    let _release = ReleaseOnDrop(Arc::clone(&gate));
    let origin = server.origin.clone();
    let first = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!("{origin}/api/super-agent/messages"))
            .header("content-type", "application/json")
            .json(&json!({
                "operation_id": operation("0000000000a1"),
                "text": "first folder check",
            }))
            .send()
            .await
            .expect("first post")
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !started.load(Ordering::SeqCst) {
        if std::time::Instant::now() > deadline {
            panic!("router did not start");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let began = std::time::Instant::now();
    let second = post_now(&server, &operation("0000000000a2"), "second while busy").await;
    assert!(began.elapsed() < Duration::from_secs(1));
    assert_eq!(second.status(), 200);
    let transcript = get(&server, "/api/super-agent/transcript")
        .await
        .text()
        .await
        .expect("transcript");
    assert!(transcript.contains("first folder check"));
    assert!(transcript.contains("second while busy"));
    let first_at = transcript.find("first folder check").expect("first");
    let second_at = transcript.find("second while busy").expect("second");
    assert!(first_at < second_at);
    gate.release();
    let posted = tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .expect("first finished")
        .expect("first task");
    assert_eq!(posted.status(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_messages_route_in_arrival_order() {
    let session = Session::open("ordered-queue");
    session.queue_create();
    session.queue_create();
    session.queue_create();
    let gate = HoldGate::create();
    let started = Arc::new(AtomicBool::new(false));
    let router = HoldingRouter {
        inner: session.router.clone(),
        gate: Arc::clone(&gate),
        started: Arc::clone(&started),
    };
    let server = session.spawn_router(router);
    let _release = ReleaseOnDrop(Arc::clone(&gate));
    let origin = server.origin.clone();
    let first = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!("{origin}/api/super-agent/messages"))
            .header("content-type", "application/json")
            .json(&json!({
                "operation_id": operation("0000000000b1"),
                "text": "alpha",
            }))
            .send()
            .await
            .expect("first")
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !started.load(Ordering::SeqCst) {
        if std::time::Instant::now() > deadline {
            panic!("router did not start");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    post_now(&server, &operation("0000000000b2"), "beta").await;
    post_now(&server, &operation("0000000000b3"), "gamma").await;
    gate.release();
    tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .expect("first finished")
        .expect("join");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if count(&server.database, "SELECT COUNT(*) FROM task_sessions") == 3 {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("three tasks did not start");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let owners = texts(
        &server.database,
        "SELECT body FROM router_messages WHERE role = 'user' ORDER BY ordinal, message_id",
    );
    assert_eq!(
        owners,
        vec!["alpha".to_owned(), "beta".to_owned(), "gamma".to_owned()]
    );
    let tasks = texts(
        &server.database,
        "SELECT task_id FROM task_sessions ORDER BY task_id",
    );
    assert_eq!(
        tasks,
        vec![
            "task-1".to_owned(),
            "task-2".to_owned(),
            "task-3".to_owned()
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resend_while_a_turn_is_open_does_not_route_twice() {
    let session = Session::open("idempotent-while-open");
    session.queue_create();
    let probe = session.router.clone();
    let gate = HoldGate::create();
    let started = Arc::new(AtomicBool::new(false));
    let router = HoldingRouter {
        inner: session.router.clone(),
        gate: Arc::clone(&gate),
        started: Arc::clone(&started),
    };
    let server = session.spawn_router(router);
    let _release = ReleaseOnDrop(Arc::clone(&gate));
    let operation_id = operation("0000000000c1");
    let origin = server.origin.clone();
    let operation_for_first = operation_id.clone();
    let first = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!("{origin}/api/super-agent/messages"))
            .header("content-type", "application/json")
            .json(&json!({
                "operation_id": operation_for_first,
                "text": "only once",
            }))
            .send()
            .await
            .expect("first")
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !started.load(Ordering::SeqCst) {
        if std::time::Instant::now() > deadline {
            panic!("router did not start");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let began = std::time::Instant::now();
    let replay = post_now(&server, &operation_id, "only once").await;
    assert!(began.elapsed() < Duration::from_secs(1));
    assert_eq!(replay.status(), 200);
    gate.release();
    tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .expect("first finished")
        .expect("join");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if probe.request_count() >= 2 {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("route did not finish");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(probe.request_count(), 2);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    assert_eq!(
        count(
            &server.database,
            "SELECT COUNT(*) FROM router_messages WHERE role = 'user'",
        ),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn router_and_task_tool_steps_emit_activity() {
    let session = Session::open("activity-steps").with_model_work();
    session.router.push_proposal(create_task(900, 200));
    session.router.push(ScriptedReply::Tool {
        name: "bash".to_owned(),
        arguments: r#"{"command":"Get-ChildItem F:\\Development\\Ideas"}"#.to_owned(),
    });
    push_success(&session.router, "Listed the ideas folder.");
    let server = session.spawn();
    let posted = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "Check F:\\Development\\Ideas"}),
    )
    .await;
    assert_eq!(posted.status(), 200);
    wait_text(&server, "Router: reading your message").await;
    wait_text(&server, "listing f:").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_running_task_does_not_block_the_next_message() {
    let session = Session::open("task-does-not-block").with_model_work();
    let route = session.router.clone();
    let worker = ScriptedRouter::create();
    route.push_proposal(create_task(900, 200));
    route.push(ScriptedReply::Tool {
        name: "success".to_owned(),
        arguments: r#"{"message":"You live in Canby."}"#.to_owned(),
    });
    push_success(&worker, "Listed the ideas folder.");
    let gate = HoldGate::create();
    let worker_started = Arc::new(AtomicBool::new(false));
    let router = SplitHold {
        route,
        worker,
        gate: Arc::clone(&gate),
        worker_started: Arc::clone(&worker_started),
    };
    let server = session.spawn_router(router);
    let _release = ReleaseOnDrop(Arc::clone(&gate));
    let posted = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "Check F:\\Development\\Ideas"}),
    )
    .await;
    assert_eq!(posted.status(), 200);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !worker_started.load(Ordering::SeqCst) {
        if std::time::Instant::now() > deadline {
            panic!("worker did not start");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let began = std::time::Instant::now();
    let second = post_now(
        &server,
        &operation("0000000000e2"),
        "I'm Garrett and I live in Canby Oregon",
    )
    .await;
    assert!(began.elapsed() < Duration::from_secs(1));
    assert_eq!(second.status(), 200);
    wait_text(&server, "You live in Canby.").await;
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    let phase = texts(
        &server.database,
        "SELECT phase FROM task_sessions WHERE task_id = 'task-1'",
    );
    assert_eq!(phase.len(), 1);
    assert!(!phase[0].starts_with("completed"));
    gate.release();
    wait_text(&server, "Listed the ideas folder.").await;
    let transcript = get(&server, "/api/super-agent/transcript")
        .await
        .text()
        .await
        .expect("transcript");
    assert!(
        !transcript.contains("Task task-1:"),
        "a finished task should read as a sentence, not an id: {transcript}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repeat_of_a_running_folder_does_not_spawn_a_second_task() {
    let session = Session::open("no-duplicate-folder");
    session.queue_create();
    session.queue_create();
    let server = session.spawn();
    let first = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "Can you check out the F:\\Development\\Ideas folder"}),
    )
    .await;
    assert_eq!(first.status(), 200);
    let second = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": "Yes check the F:\\Development\\Ideas folder like I told you"}),
    )
    .await;
    assert_eq!(second.status(), 200);
    assert_eq!(
        count(&server.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_during_a_running_worker_does_not_let_it_finish() {
    let session = Session::open("stop-mid-run").with_model_work();
    let route = session.router.clone();
    let worker = ScriptedRouter::create();
    route.push_proposal(create_task(900, 200));
    push_success(&worker, "Should not finish.");
    let gate = HoldGate::create();
    let worker_started = Arc::new(AtomicBool::new(false));
    let router = SplitHold {
        route,
        worker,
        gate: Arc::clone(&gate),
        worker_started: Arc::clone(&worker_started),
    };
    let server = session.spawn_router(router);
    let _release = ReleaseOnDrop(Arc::clone(&gate));
    let posted = post_json(
        &server,
        "/api/super-agent/messages",
        json!({"text": USER_TEXT}),
    )
    .await;
    assert_eq!(posted.status(), 200);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !worker_started.load(Ordering::SeqCst) {
        if std::time::Instant::now() > deadline {
            panic!("worker did not start");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let stopped = post_json(
        &server,
        "/api/super-agent/host-command",
        json!({"command": "stop", "task_id": "task-1"}),
    )
    .await;
    assert_eq!(stopped.status(), 200);
    assert_eq!(
        stopped.text().await.expect("stop"),
        r#"{"phase":"stopped"}"#
    );
    gate.release();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let phase = texts(
        &server.database,
        "SELECT phase FROM task_sessions WHERE task_id = 'task-1'",
    );
    assert_eq!(phase.len(), 1);
    assert!(
        phase[0].starts_with("stopped"),
        "phase stayed stopped: {}",
        phase[0]
    );
    let body = get(&server, "/api/super-agent/transcript")
        .await
        .text()
        .await
        .expect("transcript");
    assert!(!body.contains("Should not finish."));
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_catalog_lists_maia_and_creates_another() {
    let server = spawn_with_scripted_router();
    let listed = get(&server, "/api/bots").await;
    assert_eq!(listed.status(), 200);
    let body: Value = listed.json().await.expect("bot list");
    assert_eq!(body["bots"][0]["bot_id"], "maia");
    assert_eq!(body["bots"][0]["name"], "Maia");
    assert_eq!(body["selected"], "maia");
    let created = post_json(
        &server,
        "/api/bots",
        json!({"name": "Coding", "instructions": "dev"}),
    )
    .await;
    assert_eq!(created.status(), 200);
    let bot: Value = created.json().await.expect("created bot");
    assert_eq!(bot["name"], "Coding");
    let again = get(&server, "/api/bots").await;
    let catalog: Value = again.json().await.expect("catalog");
    assert_eq!(catalog["bots"].as_array().expect("bots").len(), 2);
}
