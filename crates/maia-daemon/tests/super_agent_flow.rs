//! Cross-layer Super Agent proofs. Scripted routers and tool queues only.
//!
//! These tests do not read provider env, spawn a process, or open `.env`.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::fs;
use std::future::Future;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Wake;
use std::task::Waker;

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
use maia_core::super_agent::AdmittedRoute;
use maia_core::super_agent::AdvisoryBrief;
use maia_core::super_agent::AttemptId;
use maia_core::super_agent::BudgetCeiling;
use maia_core::super_agent::ChildAssignmentDraft;
use maia_core::super_agent::ChildId;
use maia_core::super_agent::ChildPolicy;
use maia_core::super_agent::ClaimId;
use maia_core::super_agent::CommandId;
use maia_core::super_agent::CompletionError;
use maia_core::super_agent::Confidence;
use maia_core::super_agent::Criterion;
use maia_core::super_agent::CriterionId;
use maia_core::super_agent::CriterionMark;
use maia_core::super_agent::CriterionSource;
use maia_core::super_agent::EnvelopeId;
use maia_core::super_agent::EvidenceId;
use maia_core::super_agent::ExecutionTool;
use maia_core::super_agent::FactId;
use maia_core::super_agent::FailureKind;
use maia_core::super_agent::GrantCeiling;
use maia_core::super_agent::HostCommand;
use maia_core::super_agent::MemoryId;
use maia_core::super_agent::MemoryProvenance;
use maia_core::super_agent::MessageId;
use maia_core::super_agent::ProposalShape;
use maia_core::super_agent::ProposedRouteDecision;
use maia_core::super_agent::RankedMemory;
use maia_core::super_agent::RouteDecision;
use maia_core::super_agent::RouteProposal;
use maia_core::super_agent::RouteTarget;
use maia_core::super_agent::RoutingReason;
use maia_core::super_agent::SessionRole;
use maia_core::super_agent::SnapshotId;
use maia_core::super_agent::SourcedSlice;
use maia_core::super_agent::TaskEnvelope;
use maia_core::super_agent::TaskId;
use maia_core::super_agent::TaskLink;
use maia_core::super_agent::TaskPhase;
use maia_core::super_agent::UserPromptBytes;
use maia_core::super_agent::admit_completion;
use maia_core::super_agent::advisory_items;
use maia_core::super_agent::execution_tools;
use maia_core::thread_cache::ChatRole;
use maia_daemon::ChildNarrowing;
use maia_daemon::CompletionEvidence;
use maia_daemon::HttpIdSupply;
use maia_daemon::IdSupply;
use maia_daemon::named_tool_response;
use maia_daemon::Orchestrator;
use maia_daemon::OrchestratorConfig;
use maia_daemon::OrchestratorError;
use maia_daemon::ParentWork;
use maia_daemon::ReplayGuard;
use maia_daemon::RouterTurn;
use maia_daemon::ScriptedCall;
use maia_daemon::ScriptedToolHost;
use maia_daemon::ToolHostError;
use maia_daemon::accepted_routing_policy;
use maia_daemon::serve_super_agent_with_ids;
use maia_store::AppendEvents;
use maia_store::ChildAssignmentWrite;
use maia_store::OwnerOpen;
use maia_store::SqliteOwner;
use maia_store::TaskEvidenceWrite;
use maia_store::ThreadEventWrite;
use rusqlite::Connection;
use rusqlite::params;
use serde_json::Value;
use serde_json::json;

const NOW: i64 = 1_735_000_000;
const ORIGINAL: &str = "Add a pin control";
const EXTRA: &str = "keep the failed attempt — café";
const LINKED: &str = "Replace the pin control";
const PROMPT_MARKER: &str = "sealed-prompt-not-for-router";
const CHILD_LOG: &str = "child-log-not-for-router";
const PARENT_SUMMARY: &str = "relay-me";
const RELAY_PROSE: &str = r#"{"proposed":{"kind":"create_task"},"shape":"single","considered":[],"confidence":900,"margin":200}"#;
const FACT_SENTENCE: &str = "Pins stay visible";
const CLAIM_SENTENCE: &str = "Claims stay advisory";

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct ScriptedRouter {
    inner: Arc<Mutex<RouterScript>>,
}

struct RouterScript {
    replies: VecDeque<ScriptedReply>,
    requests: Vec<RouterRequest>,
}

enum ScriptedReply {
    Proposal(RouteProposal),
    Tool { name: String, arguments: String },
    Raw(String),
}

impl ScriptedRouter {
    fn create() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RouterScript {
                replies: VecDeque::new(),
                requests: Vec::new(),
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

    /// Queues a route the host will answer itself, so the loop does not call again.
    fn push_host_ask(&self, proposal: RouteProposal) {
        self.push(ScriptedReply::Proposal(proposal));
    }

    fn push_raw(&self, body: &str) {
        self.push(ScriptedReply::Raw(body.to_owned()));
    }

    fn push(&self, reply: ScriptedReply) {
        self.inner
            .lock()
            .expect("router lock")
            .replies
            .push_back(reply);
    }

    fn requests(&self) -> Vec<RouterRequest> {
        self.inner.lock().expect("router lock").requests.clone()
    }
}

impl Router for ScriptedRouter {
    fn complete(
        &self,
        request: &RouterRequest,
    ) -> impl Future<Output = Result<RouterResponse, RouterError>> + Send {
        let prepared = {
            let mut script = self.inner.lock().expect("router lock");
            script.requests.push(request.clone());
            if request
                .messages
                .first()
                .is_some_and(|message| message.content.starts_with("Maia task-report relay."))
            {
                let body = match script.replies.front() {
                    Some(ScriptedReply::Raw(_)) => match script.replies.pop_front() {
                        Some(ScriptedReply::Raw(body)) => body,
                        _ => "Relayed.".to_owned(),
                    },
                    _ => "Relayed.".to_owned(),
                };
                Ok(reply_response(request.request_id, body))
            } else {
                match script.replies.pop_front() {
                    Some(ScriptedReply::Proposal(proposal)) => Ok(
                        maia_daemon::route_tool_response(request.request_id, &proposal),
                    ),
                    Some(ScriptedReply::Tool { name, arguments }) => {
                        Ok(named_tool_response(request.request_id, &name, &arguments))
                    }
                    Some(ScriptedReply::Raw(body)) => Ok(reply_response(request.request_id, body)),
                    None => Err(RouterError::Protocol {
                        detail: "no scripted proposal".to_owned(),
                    }),
                }
            }
        };
        async move { prepared }
    }

    async fn cancel(&self, _request_id: RequestId) -> Result<(), RouterError> {
        Ok(())
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

struct Env {
    host: Option<Orchestrator<ScriptedRouter>>,
    directory: PathBuf,
    database: PathBuf,
    dist: PathBuf,
    router: ScriptedRouter,
}

impl Env {
    fn open(name: &str) -> Self {
        Self::open_with(name, SecurityProfile::Protected)
    }

    fn open_ids(name: &str, ids: IdSupply) -> Self {
        Self::open_profile_ids(name, SecurityProfile::Protected, ids)
    }

    fn open_with(name: &str, profile: SecurityProfile) -> Self {
        Self::open_profile_ids(name, profile, supply())
    }

    fn open_profile_ids(name: &str, profile: SecurityProfile, ids: IdSupply) -> Self {
        let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let mut directory = std::env::temp_dir();
        directory.push("maia-daemon-flow");
        directory.push(format!("{name}-{sequence}"));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("temp dir");
        let dist = directory.join("dist");
        fs::create_dir_all(&dist).expect("dist");
        fs::write(dist.join("index.html"), "<!doctype html><p>shell</p>").expect("index");
        let database = directory.join("maia.sqlite");
        let owner = SqliteOwner::open(OwnerOpen {
            path: database.clone(),
            now: NOW,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("open owner");
        let router = ScriptedRouter::create();
        let host = Orchestrator::create(
            router.clone(),
            owner,
            ScriptedToolHost::create(),
            OrchestratorConfig {
                policy: accepted_routing_policy(),
                ids,
                turn: RouterTurn {
                    model: "fixture-model".to_owned(),
                    reasoning: ReasoningEffort::Low,
                    prefix_hash: PrefixHash::new("fixture-prefix"),
                },
                profile,
                parent_work: ParentWork::Script,
            },
        );
        Self {
            host: Some(host),
            directory,
            database,
            dist,
            router,
        }
    }

    fn host(&mut self) -> &mut Orchestrator<ScriptedRouter> {
        self.host.as_mut().expect("orchestrator")
    }

    fn serve(&mut self) -> maia_daemon::SuperAgentServer {
        let host = self.host.take().expect("orchestrator");
        let reserved = host
            .store()
            .reserve_runtime_id_block(4096)
            .expect("reserve HTTP ids");
        let (_, http) = reserved.into_parts();
        let server = serve_super_agent_with_ids(
            host,
            self.database.clone(),
            self.dist.clone(),
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            HttpIdSupply::from_reserved(http).expect("reserved HTTP ids"),
        )
        .expect("serve");
        register_database(server.origin(), &self.database);
        server
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.host.take();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn supply() -> IdSupply {
    let mut ids = IdSupply::at(NOW);
    for index in 1_u64..=16 {
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

fn confidence(value: u16) -> Confidence {
    Confidence::from_thousandths(value).expect("confidence")
}

fn proposal(proposed: ProposedRouteDecision, considered: &[&str]) -> RouteProposal {
    RouteProposal {
        proposed,
        shape: ProposalShape::Single,
        considered: considered
            .iter()
            .map(|id| TaskId((*id).to_owned()))
            .collect(),
        confidence: confidence(900),
        margin: confidence(200),
    }
}

fn create_proposal() -> RouteProposal {
    proposal(ProposedRouteDecision::CreateTask, &[])
}

fn continue_proposal(task: &str) -> RouteProposal {
    proposal(
        ProposedRouteDecision::Continue {
            target: RouteTarget::Parent(TaskId(task.to_owned())),
        },
        &[task],
    )
}

fn linked_proposal(task: &str) -> RouteProposal {
    proposal(
        ProposedRouteDecision::CreateLinked {
            prior: RouteTarget::Parent(TaskId(task.to_owned())),
            link: TaskLink::Modifies,
        },
        &[task],
    )
}

fn inspect_proposal(task: &str) -> RouteProposal {
    proposal(
        ProposedRouteDecision::Inspect {
            target: RouteTarget::Parent(TaskId(task.to_owned())),
        },
        &[task],
    )
}

fn wait<T>(future: impl Future<Output = T>) -> T {
    struct Parker {
        ready: Mutex<bool>,
        signal: Condvar,
    }

    impl Wake for Parker {
        fn wake(self: Arc<Self>) {
            let mut ready = self.ready.lock().expect("wake");
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
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => {
                let mut ready = parker.ready.lock().expect("park");
                while !*ready {
                    ready = parker.signal.wait(ready).expect("park wait");
                }
                *ready = false;
            }
        }
    }
}

fn admit(env: &mut Env, text: &str) -> maia_daemon::TurnOutcome {
    env.router.push_proposal(create_proposal());
    wait(env.host().handle_user_message(text)).expect("admit")
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

fn blobs(path: &Path, sql: &str) -> Vec<Vec<u8>> {
    let connection = Connection::open(path).expect("open sqlite");
    let mut statement = connection.prepare(sql).expect("prepare");
    statement
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("blobs")
}

fn count(path: &Path, sql: &str) -> i64 {
    let connection = Connection::open(path).expect("open sqlite");
    connection
        .query_row(sql, [], |row| row.get(0))
        .expect("count")
}

fn exec(path: &Path, sql: &str, args: impl rusqlite::Params) {
    let connection = Connection::open(path).expect("open sqlite");
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .expect("busy");
    connection.execute(sql, args).expect("exec");
}

fn exec_corrupt(path: &Path, sql: &str) {
    let connection = Connection::open(path).expect("open sqlite");
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .expect("busy");
    connection
        .execute_batch(&format!("PRAGMA foreign_keys = OFF; {sql};"))
        .expect("corrupt fixture");
}

fn reopen(env: &mut Env) -> SqliteOwner {
    env.host.take();
    SqliteOwner::open(OwnerOpen {
        path: env.database.clone(),
        now: NOW + 1,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("reopen")
}

fn restore_host(
    env: &mut Env,
    ids: IdSupply,
) -> Result<(Orchestrator<ScriptedRouter>, ScriptedRouter), OrchestratorError> {
    env.host.take();
    let owner = SqliteOwner::open(OwnerOpen {
        path: env.database.clone(),
        now: NOW + 1,
        normal_capacity: 8,
        panic_capacity: 2,
    })?;
    let router = ScriptedRouter::create();
    let snapshot = owner.runtime_snapshot()?;
    let host = Orchestrator::restore(
        router.clone(),
        owner,
        ScriptedToolHost::create(),
        OrchestratorConfig {
            policy: accepted_routing_policy(),
            ids,
            turn: RouterTurn {
                model: "fixture-model".to_owned(),
                reasoning: ReasoningEffort::Low,
                prefix_hash: PrefixHash::new("fixture-prefix"),
            },
            profile: SecurityProfile::Protected,
            parent_work: ParentWork::Script,
        },
        snapshot,
    )?;
    Ok((host, router))
}

fn child_parts(
    task: &TaskId,
    child: &str,
    prompt: &str,
    depth: u32,
) -> (TaskEnvelope, ChildAssignmentDraft, ChildNarrowing) {
    let envelope = TaskEnvelope {
        id: EnvelopeId("env-1".to_owned()),
        task: task.clone(),
        origin_attempt: AttemptId("attempt-1".to_owned()),
        original_prompt: UserPromptBytes {
            message: MessageId("m-1".to_owned()),
            utf8: prompt.as_bytes().to_vec(),
        },
        brief: AdvisoryBrief("advisory".to_owned()),
        criteria: vec![sealed_criterion(prompt)],
        constraints: Vec::new(),
        context: SnapshotId("snap-1".to_owned()),
        routing_reason: RoutingReason("create_task".to_owned()),
        assumptions: Vec::new(),
        question_log: Vec::new(),
    };
    let draft = ChildAssignmentDraft {
        child: ChildId(child.to_owned()),
        parent: task.clone(),
        parent_attempt: AttemptId("attempt-1".to_owned()),
        subgoal: SourcedSlice {
            source: CriterionSource::UserText {
                message: MessageId("m-1".to_owned()),
                start: 0,
                end: u32::try_from(prompt.len()).expect("span"),
            },
            utf8: prompt.as_bytes().to_vec(),
        },
        envelope_slices: Vec::new(),
        context: SnapshotId("snap-1".to_owned()),
        ceiling: GrantCeiling {
            grants: BTreeSet::new(),
        },
        budget: BudgetCeiling {
            router_tokens: 10,
            tool_turns: 2,
        },
    };
    let narrowing = ChildNarrowing {
        grants: BTreeSet::new(),
        budget: BudgetCeiling {
            router_tokens: 10,
            tool_turns: 2,
        },
        depth,
        policy: ChildPolicy { max_depth: 4 },
    };
    (envelope, draft, narrowing)
}

fn sealed_criterion(text: &str) -> Criterion {
    Criterion {
        id: CriterionId("criterion-1".to_owned()),
        text: text.to_owned(),
        source: CriterionSource::UserText {
            message: MessageId("m-1".to_owned()),
            start: 0,
            end: u32::try_from(text.len()).expect("span"),
        },
    }
}

fn assign(env: &mut Env, task: &TaskId, child: &str, prompt: &str) {
    let (envelope, draft, narrowing) = child_parts(task, child, prompt, 1);
    env.host()
        .assign_child(&envelope, &draft, &narrowing)
        .expect("assign child");
}

fn child_write(child: &str, parent: &str, depth: i64, subgoal: &str) -> ChildAssignmentWrite {
    ChildAssignmentWrite {
        child_id: child.to_owned(),
        parent_task_id: parent.to_owned(),
        depth,
        subgoal: subgoal.as_bytes().to_vec(),
        budget_tokens: 4,
        budget_turns: 1,
    }
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .expect("runtime")
        .block_on(future)
}

async fn post_json(origin: &str, path: &str, body: Value) -> (u16, Value) {
    let mut body = body;
    if path == "/api/super-agent/messages"
        && let Some(object) = body.as_object_mut()
        && !object.contains_key("operation_id")
    {
        let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        object.insert(
            "operation_id".to_owned(),
            Value::String(format!("10000000-0000-4000-8000-{sequence:012}")),
        );
    }
    let response = reqwest::Client::new()
        .post(format!("{origin}{path}"))
        .json(&body)
        .send()
        .await
        .expect("post");
    let status = response.status().as_u16();
    let text = response.text().await.expect("body");
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    if path != "/api/super-agent/messages" || status != 200 || !pending_outcome(&value) {
        return (status, value);
    }
    let operation = body
        .get("operation_id")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_owned();
    let settled = wait_terminal_submission(origin, &operation);
    (status, settled.unwrap_or(value))
}

fn pending_outcome(value: &Value) -> bool {
    value
        .get("outcome")
        .and_then(|outcome| outcome.get("kind"))
        .and_then(|kind| kind.as_str())
        == Some("processing_pending")
}

fn register_database(origin: &str, database: &Path) {
    let port = origin.rsplit(':').next().unwrap_or("").to_owned();
    databases()
        .lock()
        .expect("database map")
        .insert(port, database.to_path_buf());
}

fn databases() -> &'static Mutex<BTreeMap<String, PathBuf>> {
    static DATABASES: std::sync::OnceLock<Mutex<BTreeMap<String, PathBuf>>> =
        std::sync::OnceLock::new();
    DATABASES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn wait_terminal_submission(origin: &str, operation: &str) -> Option<Value> {
    let port = origin.rsplit(':').next().unwrap_or("");
    let database = databases()
        .lock()
        .expect("database map")
        .get(port)
        .cloned()?;
    let started = std::time::Instant::now();
    while started.elapsed() < std::time::Duration::from_secs(8) {
        if let Some(value) = read_terminal_submission(&database, operation) {
            return Some(value);
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
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
        "routed" => json!({
            "admitted": detail,
            "admission": "admitted",
            "message_id": message_id,
            "outcome": { "kind": "routed", "route": detail },
        }),
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

async fn get_json(origin: &str, path: &str) -> (u16, Value) {
    let response = reqwest::Client::new()
        .get(format!("{origin}{path}"))
        .send()
        .await
        .expect("get");
    let status = response.status().as_u16();
    let text = response.text().await.expect("body");
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (status, value)
}

fn durable_counts(path: &Path) -> Vec<(&'static str, i64)> {
    [
        "task_sessions",
        "task_attempts",
        "task_envelopes",
        "task_inputs",
        "task_criteria",
        "task_evidence",
        "task_reports",
        "child_assignments",
        "context_snapshots",
    ]
    .into_iter()
    .map(|table| (table, count(path, &format!("SELECT COUNT(*) FROM {table}"))))
    .collect()
}

#[test]
fn restart_restores_nonterminal_inspect_stop_and_continue() {
    let mut stop_env = Env::open("restart-stop");
    let stop_task = admit(&mut stop_env, "restart stop")
        .task
        .expect("stop task");
    stop_env.host().tools().push_parent(ScriptedCall::Progress {
        summary: "running before restart".to_owned(),
    });
    stop_env.host().step_parent(&stop_task).expect("run task");
    let expected_inspection = stop_env
        .host()
        .read_inspection(&stop_task.0)
        .expect("inspection before restart");
    let (mut stopped, _) = restore_host(&mut stop_env, supply()).expect("restore stop host");

    assert_eq!(
        stopped
            .read_inspection(&stop_task.0)
            .expect("inspection after restart"),
        expected_inspection
    );
    assert_eq!(
        stopped
            .apply_host_command(HostCommand::Stop {
                task: stop_task,
                command: CommandId(77),
            })
            .expect("stop after restart"),
        TaskPhase::Stopped {
            command: CommandId(77),
        }
    );

    let mut continue_env = Env::open("restart-continue");
    let continue_task = admit(&mut continue_env, "restart continue")
        .task
        .expect("continue task");
    continue_env
        .host()
        .tools()
        .push_parent(ScriptedCall::Failure {
            summary: "failed before restart".to_owned(),
        });
    continue_env
        .host()
        .step_parent(&continue_task)
        .expect("fail task");
    let mut continue_ids = supply();
    continue_ids.messages.clear();
    continue_ids.messages.push_back("m-100".to_owned());
    continue_ids.messages.push_back("m-101".to_owned());
    continue_ids.messages.push_back("m-102".to_owned());
    let (mut continued, router) =
        restore_host(&mut continue_env, continue_ids).expect("restore continue host");
    router.push_proposal(continue_proposal(&continue_task.0));

    let outcome = wait(continued.handle_user_message("continue after restart"))
        .expect("continue after restart");
    assert_eq!(outcome.task, Some(continue_task));
    assert_eq!(
        blobs(&continue_env.database, "SELECT prompt FROM task_inputs"),
        vec![b"continue after restart".to_vec()]
    );
}

#[test]
fn successful_public_writes_round_trip_through_runtime_snapshot() {
    let mut env = Env::open("public-write-round-trip");
    let task = admit(&mut env, "round trip").task.expect("task");
    assign(&mut env, &task, "child-1", "round trip");
    env.host().store().set_pin(&task.0, "pinned").expect("pin");
    env.host()
        .store()
        .set_completion_view(&task.0, "open:detail-1")
        .expect("detail");

    let before = env.host().read_inspection(&task.0).expect("inspection");
    let (restored, _) = restore_host(&mut env, supply()).expect("restore");
    assert_eq!(
        restored
            .read_inspection(&task.0)
            .expect("restored inspection"),
        before
    );
}

#[test]
fn restart_restores_failed_retry_state_and_preserves_terminal_rejection() {
    let mut failed_env = Env::open("restart-retry");
    let failed_task = admit(&mut failed_env, "restart retry")
        .task
        .expect("failed task");
    failed_env
        .host()
        .tools()
        .push_parent(ScriptedCall::Failure {
            summary: "failed before restart".to_owned(),
        });
    failed_env
        .host()
        .step_parent(&failed_task)
        .expect("fail task");
    let mut retry_ids = supply();
    retry_ids.attempts.clear();
    retry_ids.attempts.push_back("attempt-retry".to_owned());
    let (mut retried, _) = restore_host(&mut failed_env, retry_ids).expect("restore failed host");
    assert_eq!(
        retried
            .retry_task(&failed_task)
            .expect("retry after restart"),
        TaskPhase::Queued
    );

    let mut terminal_env = Env::open("restart-terminal");
    let terminal_task = admit(&mut terminal_env, "restart terminal")
        .task
        .expect("terminal task");
    terminal_env
        .host()
        .tools()
        .push_parent(ScriptedCall::Completion {
            summary: "done".to_owned(),
            evidence: CompletionEvidence::Stored,
        });
    terminal_env
        .host()
        .step_parent(&terminal_task)
        .expect("complete task");
    let (mut terminal, _) =
        restore_host(&mut terminal_env, supply()).expect("restore terminal host");

    assert!(matches!(
        terminal.apply_host_command(HostCommand::Stop {
            task: terminal_task,
            command: CommandId(88),
        }),
        Err(OrchestratorError::Phase(_))
    ));
}

#[test]
fn restart_preserves_the_reserved_retry_attempt() {
    let mut initial_ids = supply();
    initial_ids.attempts.clear();
    initial_ids.attempts.push_back("attempt-1".to_owned());
    initial_ids.attempts.push_back("attempt-retry".to_owned());
    let mut env = Env::open_ids("restart-retry-attempt", initial_ids);
    let task = admit(&mut env, "restart retry attempt").task.expect("task");
    env.host().tools().push_parent(ScriptedCall::Failure {
        summary: "failed before retry".to_owned(),
    });
    env.host().step_parent(&task).expect("fail task");
    assert_eq!(
        env.host().retry_task(&task).expect("retry"),
        TaskPhase::Queued
    );

    let mut restored_ids = supply();
    restored_ids.calls.clear();
    restored_ids.calls.push_back("call-100".to_owned());
    restored_ids.reports.clear();
    restored_ids.reports.push_back("report-100".to_owned());
    restored_ids.requests.clear();
    restored_ids.requests.push_back(100);
    restored_ids.messages.clear();
    restored_ids.messages.push_back("m-100".to_owned());
    let (mut restored, _) = restore_host(&mut env, restored_ids).expect("restore queued retry");
    restored.tools().push_parent(ScriptedCall::Progress {
        summary: "retry resumed".to_owned(),
    });
    let resumed = restored.step_parent(&task).expect("resume retry");

    assert_eq!(
        resumed.phase,
        TaskPhase::Running {
            attempt: AttemptId("attempt-retry".to_owned()),
        }
    );
}

#[test]
fn restart_rejects_inconsistent_runtime_state() {
    let mut invalid_phase = Env::open("restart-invalid-phase");
    admit(&mut invalid_phase, "invalid phase");
    exec(
        &invalid_phase.database,
        "UPDATE task_sessions SET phase = 'not-canonical'",
        [],
    );
    assert!(matches!(
        restore_host(&mut invalid_phase, supply()),
        Err(OrchestratorError::Phase(_))
    ));

    let mut missing_envelope = Env::open("restart-missing-envelope");
    admit(&mut missing_envelope, "missing envelope");
    exec(&missing_envelope.database, "DELETE FROM task_envelopes", []);
    assert!(matches!(
        restore_host(&mut missing_envelope, supply()),
        Err(OrchestratorError::Store(_))
    ));

    let mut missing_attempt = Env::open("restart-missing-attempt");
    admit(&mut missing_attempt, "missing attempt");
    exec(&missing_attempt.database, "DELETE FROM task_attempts", []);
    assert!(matches!(
        restore_host(&mut missing_attempt, supply()),
        Err(OrchestratorError::Store(_))
    ));

    let mut invalid_criterion = Env::open("restart-invalid-criterion");
    admit(&mut invalid_criterion, "invalid criterion");
    exec(
        &invalid_criterion.database,
        "UPDATE task_criteria SET source_kind = 'future_kind'",
        [],
    );
    assert!(matches!(
        restore_host(&mut invalid_criterion, supply()),
        Err(OrchestratorError::Store(_))
    ));

    let mut invalid_hierarchy = Env::open("restart-invalid-hierarchy");
    let task = admit(&mut invalid_hierarchy, "invalid hierarchy")
        .task
        .expect("task");
    assign(
        &mut invalid_hierarchy,
        &task,
        "child-invalid",
        "invalid hierarchy",
    );
    exec(
        &invalid_hierarchy.database,
        "UPDATE child_assignments SET parent_task_id = 'missing-parent'",
        [],
    );
    assert!(matches!(
        restore_host(&mut invalid_hierarchy, supply()),
        Err(OrchestratorError::Store(_))
    ));
}

#[test]
fn runtime_snapshot_rejects_each_corrupt_reference_class() {
    let cases = [
        ("missing-criterion-message", "DELETE FROM router_messages"),
        (
            "invalid-attempt-state",
            "UPDATE task_attempts SET state = 'future'",
        ),
        (
            "missing-prior-task",
            "UPDATE task_sessions SET prior_task_id = 'missing'",
        ),
        (
            "orphan-input",
            "INSERT INTO task_inputs VALUES ('missing', 'm-99', X'78')",
        ),
        (
            "orphan-context",
            "INSERT INTO context_snapshots VALUES ('snap-orphan', 0, 'memory-x', 'p', 'trusted', 'x')",
        ),
        (
            "report-attempt-mismatch",
            "INSERT INTO task_reports VALUES ('report-99', 'task-1', 'attempt-missing', 'progress', 'x', 1, 'call-99')",
        ),
        (
            "evidence-attempt-mismatch",
            "INSERT INTO task_evidence VALUES ('evidence-99', 'task-1', 'attempt-missing', 'x')",
        ),
    ];
    for (name, mutation) in cases {
        let mut env = Env::open(name);
        admit(&mut env, "snapshot integrity");
        exec_corrupt(&env.database, mutation);
        assert!(
            restore_host(&mut env, supply()).is_err(),
            "{name} must fail startup"
        );
    }
}

#[test]
fn runtime_snapshot_rejects_orphan_cycle_self_parent_and_depth_mismatch() {
    for (name, mutation) in [
        (
            "child-orphan",
            "UPDATE child_assignments SET parent_task_id = 'missing'",
        ),
        (
            "child-self",
            "UPDATE child_assignments SET parent_task_id = child_id",
        ),
        ("child-depth", "UPDATE child_assignments SET depth = 2"),
    ] {
        let mut env = Env::open(name);
        let task = admit(&mut env, "hierarchy").task.expect("task");
        assign(&mut env, &task, "child-1", "hierarchy");
        exec(&env.database, mutation, []);
        assert!(
            restore_host(&mut env, supply()).is_err(),
            "{name} must fail startup"
        );
    }

    let mut cycle = Env::open("child-cycle");
    let task = admit(&mut cycle, "cycle").task.expect("task");
    assign(&mut cycle, &task, "child-1", "cycle");
    cycle
        .host()
        .store()
        .insert_child(child_write("child-2", "child-1", 2, "cycle"))
        .expect("nested child");
    exec(
        &cycle.database,
        "UPDATE child_assignments SET parent_task_id = 'child-2' WHERE child_id = 'child-1'",
        [],
    );
    assert!(restore_host(&mut cycle, supply()).is_err());
}

#[test]
fn runtime_snapshot_rejects_incompatible_replay_guard_and_attempt_state() {
    let mut env = Env::open("replay-guard-missing-report");
    admit(&mut env, "replay guard");
    exec(
        &env.database,
        "UPDATE task_sessions SET phase = 'waiting:unknown:attempt-1:call-404'",
        [],
    );
    assert!(restore_host(&mut env, supply()).is_err());

    let mut mismatch = Env::open("replay-guard-attempt");
    let task = admit(&mut mismatch, "replay attempt").task.expect("task");
    exec(
        &mismatch.database,
        "INSERT INTO task_reports VALUES ('report-404', 'task-1', 'attempt-1', 'progress', 'x', 1, 'call-404')",
        [],
    );
    exec(
        &mismatch.database,
        "UPDATE task_sessions SET phase = 'waiting:unknown:attempt-2:call-404'",
        [],
    );
    assert!(restore_host(&mut mismatch, supply()).is_err());
    assert_eq!(task.0, "task-1");

    let mut completed = Env::open("completed-evidence-link");
    let task = admit(&mut completed, "completed evidence")
        .task
        .expect("task");
    completed
        .host()
        .tools()
        .push_parent(ScriptedCall::Completion {
            summary: "done".to_owned(),
            evidence: CompletionEvidence::Stored,
        });
    completed.host().step_parent(&task).expect("complete");
    exec(&completed.database, "DELETE FROM task_evidence", []);
    assert!(restore_host(&mut completed, supply()).is_err());
}

#[test]
fn runtime_snapshot_rejects_each_noncanonical_task_field() {
    for (name, mutation) in [
        ("runtime-pin", "UPDATE task_sessions SET pinned = 'future'"),
        (
            "runtime-view",
            "UPDATE task_sessions SET completion_view = 'open:'",
        ),
        (
            "runtime-title-limit",
            "UPDATE task_sessions SET title = printf('%.*c', 65537, 'x')",
        ),
    ] {
        let mut env = Env::open(name);
        admit(&mut env, "canonical task");
        exec_corrupt(&env.database, mutation);
        assert!(
            restore_host(&mut env, supply()).is_err(),
            "{name} must fail startup"
        );
    }
}

#[test]
fn lowercase_phase_escape_is_rejected_by_restore() {
    let mut env = Env::open("lowercase-phase-restore");
    admit(&mut env, "lowercase phase");
    exec_corrupt(
        &env.database,
        "UPDATE task_sessions SET phase = 'running:attempt%3a1'",
    );
    assert!(restore_host(&mut env, supply()).is_err());
}

#[test]
fn runtime_snapshot_rejects_each_noncanonical_envelope_context_field() {
    for (name, mutation) in [
        (
            "runtime-prompt-limit",
            "UPDATE task_envelopes SET prompt = zeroblob(65537)",
        ),
        (
            "runtime-prompt-source",
            "UPDATE task_envelopes SET prompt = X'6F74686572'",
        ),
        (
            "runtime-brief-limit",
            "UPDATE task_envelopes SET brief = printf('%.*c', 65537, 'x')",
        ),
        (
            "runtime-brief-canonical",
            "UPDATE task_envelopes SET brief = 'future'",
        ),
        (
            "runtime-reason-limit",
            "UPDATE task_envelopes SET routing_reason = printf('%.*c', 65537, 'x')",
        ),
        (
            "runtime-reason-canonical",
            "UPDATE task_envelopes SET routing_reason = 'future'",
        ),
        (
            "runtime-snapshot-id",
            "UPDATE task_envelopes SET snapshot_id = ''",
        ),
        (
            "runtime-context-memory",
            "UPDATE context_snapshots SET memory_id = ''",
        ),
        (
            "runtime-context-provenance",
            "UPDATE context_snapshots SET provenance = printf('%.*c', 65537, 'x')",
        ),
        (
            "runtime-context-trust",
            "UPDATE context_snapshots SET trust = 'future'",
        ),
        (
            "runtime-context-sentence",
            "UPDATE context_snapshots SET sentence = printf('%.*c', 65537, 'x')",
        ),
        (
            "runtime-context-order",
            "UPDATE context_snapshots SET ordinal = 2",
        ),
    ] {
        let mut env = Env::open(name);
        admit(&mut env, "canonical envelope");
        exec_corrupt(
            &env.database,
            "INSERT INTO context_snapshots VALUES \
             ('snap-1', 0, 'memory-1', 'fact:memory-1', 'trusted', 'context')",
        );
        exec_corrupt(&env.database, mutation);
        assert!(
            restore_host(&mut env, supply()).is_err(),
            "{name} must fail startup"
        );
    }
}

#[test]
fn runtime_snapshot_rejects_each_noncanonical_child_field() {
    for (name, mutation) in [
        (
            "runtime-child-budget",
            "UPDATE child_assignments SET budget_tokens = -1",
        ),
        (
            "runtime-child-turns",
            "UPDATE child_assignments SET budget_turns = -1",
        ),
        (
            "runtime-child-empty",
            "UPDATE child_assignments SET subgoal = X''",
        ),
        (
            "runtime-child-utf8",
            "UPDATE child_assignments SET subgoal = X'80'",
        ),
        (
            "runtime-child-limit",
            "UPDATE child_assignments SET subgoal = zeroblob(65537)",
        ),
    ] {
        let mut env = Env::open(name);
        let task = admit(&mut env, "canonical child").task.expect("task");
        assign(&mut env, &task, "child-1", "canonical child");
        exec_corrupt(&env.database, mutation);
        assert!(
            restore_host(&mut env, supply()).is_err(),
            "{name} must fail startup"
        );
    }
}

#[test]
fn child_depth_64_write_and_restart_round_trip() {
    let mut env = Env::open("child-depth-64");
    let task = admit(&mut env, "deep hierarchy").task.expect("task");
    let mut parent = task.0.clone();
    for depth in 1_i64..=64 {
        let child = format!("child-{depth}");
        env.host()
            .store()
            .insert_child(child_write(&child, &parent, depth, "slice"))
            .expect("child within depth ceiling");
        parent = child;
    }
    assert!(restore_host(&mut env, supply()).is_ok());
}

#[test]
fn runtime_snapshot_rejects_child_depth_65_with_shared_validator() {
    let mut env = Env::open("child-depth-65-restore");
    let task = admit(&mut env, "deep corruption").task.expect("task");
    let mut parent = task.0.clone();
    for depth in 1_i64..=64 {
        let child = format!("child-{depth}");
        env.host()
            .store()
            .insert_child(child_write(&child, &parent, depth, "slice"))
            .expect("child within depth ceiling");
        parent = child;
    }
    exec_corrupt(
        &env.database,
        &format!(
            "INSERT INTO child_assignments \
             (child_id, parent_task_id, depth, subgoal, budget_tokens, budget_turns, phase) \
             VALUES ('child-65', '{parent}', 65, X'78', 0, 0, 'queued')"
        ),
    );
    assert!(restore_host(&mut env, supply()).is_err());
}

#[test]
fn runtime_snapshot_rejects_criterion_source_text_span_and_order_corruption() {
    for (name, mutation) in [
        (
            "runtime-criterion-text",
            "UPDATE task_criteria SET text = 'different'",
        ),
        (
            "runtime-criterion-span",
            "UPDATE task_criteria SET span_start = 1",
        ),
        (
            "runtime-criterion-source",
            "UPDATE task_criteria SET source_ref = 'm-99'",
        ),
    ] {
        let mut env = Env::open(name);
        admit(&mut env, "canonical criterion");
        exec_corrupt(
            &env.database,
            "INSERT INTO router_messages VALUES ('m-99', 99, 'user', 'other', 1)",
        );
        exec_corrupt(&env.database, mutation);
        assert!(
            restore_host(&mut env, supply()).is_err(),
            "{name} must fail startup"
        );
    }

    let mut reversed = Env::open("runtime-criterion-order");
    admit(&mut reversed, "canonical criterion");
    exec_corrupt(
        &reversed.database,
        "INSERT INTO task_criteria \
         (criterion_id, task_id, source_kind, source_ref, span_start, span_end, text, ordinal) \
         VALUES ('criterion-2', 'task-1', 'user_text', 'm-1', 0, 19, 'canonical criterion', 1);
         UPDATE task_sessions SET phase = \
         'completed:criterion-2%3Awaived%2Ccriterion-1%3Awaived'",
    );
    assert!(restore_host(&mut reversed, supply()).is_err());
}

#[test]
fn runtime_snapshot_rejects_duplicate_omitted_unknown_and_cross_attempt_completion_slots() {
    for (name, evidence_set) in [
        (
            "runtime-completion-duplicate",
            "criterion-1%3Awaived%2Ccriterion-1%3Awaived",
        ),
        ("runtime-completion-omitted", "criterion-1%3Awaived"),
        (
            "runtime-completion-unknown",
            "criterion-1%3Awaived%2Ccriterion-404%3Awaived",
        ),
    ] {
        let mut env = Env::open(name);
        admit(&mut env, "completion criteria");
        exec_corrupt(
            &env.database,
            "INSERT INTO task_criteria \
             (criterion_id, task_id, source_kind, source_ref, span_start, span_end, text, ordinal) \
             VALUES ('criterion-2', 'task-1', 'user_text', 'm-1', 0, 19, \
              'completion criteria', 1)",
        );
        exec_corrupt(
            &env.database,
            &format!("UPDATE task_sessions SET phase = 'completed:{evidence_set}'"),
        );
        assert!(
            restore_host(&mut env, supply()).is_err(),
            "{name} must fail startup"
        );
    }

    let mut cross_attempt = Env::open("runtime-completion-cross-attempt");
    admit(&mut cross_attempt, "cross attempt");
    exec_corrupt(
        &cross_attempt.database,
        "INSERT INTO task_attempts VALUES ('task-1', 'attempt-2', 'active');
         INSERT INTO task_evidence VALUES ('evidence-1', 'task-1', 'attempt-1', 'proof');
         UPDATE task_sessions SET phase = 'completed:criterion-1%3Aevidence-1'",
    );
    assert!(restore_host(&mut cross_attempt, supply()).is_err());
}

#[test]
fn runtime_snapshot_accepts_all_valid_boundaries() {
    let mut env = Env::open("runtime-valid-boundaries");
    let task = admit(&mut env, "boundary").task.expect("task");
    assign(&mut env, &task, "child-1", "x");
    exec_corrupt(
        &env.database,
        "UPDATE child_assignments SET budget_tokens = 0, budget_turns = 0;
         UPDATE child_assignments SET subgoal = CAST(printf('%.*c', 65536, 'x') AS BLOB);
         UPDATE task_sessions SET pinned = 'pinned', completion_view = 'open:detail-1',
           title = printf('%.*c', 65536, 'x');
         UPDATE router_messages SET body = printf('%.*c', 65536, 'x') WHERE role = 'user';
         UPDATE task_envelopes SET prompt = CAST(printf('%.*c', 65536, 'x') AS BLOB);
         UPDATE task_criteria SET text = printf('%.*c', 65536, 'x'),
           span_start = 0, span_end = 65536;
         INSERT INTO context_snapshots VALUES
           ('snap-1', 0, 'memory-1', 'fact:memory-1', 'trusted',
            printf('%.*c', 65536, 'x'))",
    );
    assert!(restore_host(&mut env, supply()).is_ok());
}

#[test]
fn restart_restores_completion_and_child_runtime_state() {
    let mut env = Env::open("restart-completion-child");
    let task = admit(&mut env, "restart completion").task.expect("task");
    assign(&mut env, &task, "child-1", "restart completion");
    let mut ids = supply();
    ids.messages.clear();
    ids.messages.push_back("m-100".to_owned());
    ids.calls.clear();
    ids.calls.push_back("call-100".to_owned());
    ids.calls.push_back("call-101".to_owned());
    ids.reports.clear();
    ids.reports.push_back("report-100".to_owned());
    ids.reports.push_back("report-101".to_owned());
    ids.evidence.clear();
    ids.evidence.push_back("evidence-100".to_owned());
    ids.requests.clear();
    ids.requests.push_back(100);
    let (mut restored, _) = restore_host(&mut env, ids).expect("restore runtime");

    restored.tools().push_child(ScriptedCall::Progress {
        summary: "child resumed".to_owned(),
    });
    restored
        .step_child(&task, &ChildId("child-1".to_owned()))
        .expect("step restored child");
    restored.tools().push_parent(ScriptedCall::Completion {
        summary: "completed after restart".to_owned(),
        evidence: CompletionEvidence::Stored,
    });
    let completed = restored.step_parent(&task).expect("complete restored task");

    assert!(matches!(completed.phase, TaskPhase::Completed { .. }));
    assert_eq!(
        restored.recorded_evidence(&task),
        BTreeSet::from([EvidenceId("evidence-100".to_owned())])
    );
}

#[test]
fn restart_restores_unknown_outcome_replay_guard() {
    let mut env = Env::open("restart-unknown-call");
    let task = admit(&mut env, "restart unknown").task.expect("task");
    env.host().tools().push_parent(ScriptedCall::Unknown);
    env.host()
        .step_parent(&task)
        .expect("record unknown outcome");
    let (mut restored, _) = restore_host(&mut env, supply()).expect("restore unknown wait");

    assert!(
        restored
            .continue_task(&task, ReplayGuard::Omit, None)
            .is_err()
    );
    assert!(
        restored
            .continue_task(
                &task,
                ReplayGuard::Exact(maia_core::super_agent::CallId("call-1".to_owned())),
                None,
            )
            .is_ok()
    );
}

#[test]
fn continue_transaction_rolls_back_at_each_write_boundary() {
    let mut env = Env::open("continue-transaction");
    let task = admit(&mut env, "continue transaction").task.expect("task");
    env.host().tools().push_parent(ScriptedCall::Unknown);
    env.host().step_parent(&task).expect("unknown outcome");
    let before = texts(&env.database, "SELECT phase FROM task_sessions");
    let expected_message = format!(
        "m-{}",
        env.host()
            .store()
            .next_message_sequence()
            .expect("next message sequence")
    );
    exec(
        &env.database,
        "CREATE TRIGGER reject_continue_phase BEFORE UPDATE OF phase ON task_sessions \
         BEGIN SELECT RAISE(ABORT, 'continue phase failpoint'); END",
        [],
    );
    assert!(
        env.host()
            .continue_task(
                &task,
                ReplayGuard::Exact(maia_core::super_agent::CallId("call-1".to_owned())),
                Some(b"resume"),
            )
            .is_err()
    );
    assert_eq!(
        texts(&env.database, "SELECT phase FROM task_sessions"),
        before
    );
    assert_eq!(count(&env.database, "SELECT COUNT(*) FROM task_inputs"), 0);
    assert!(matches!(
        env.host().phase(&task),
        Some(TaskPhase::WaitingForUser { .. })
    ));
    exec(&env.database, "DROP TRIGGER reject_continue_phase", []);
    exec(
        &env.database,
        "CREATE TRIGGER reject_continue_input BEFORE INSERT ON task_inputs \
         BEGIN SELECT RAISE(ABORT, 'continue input failpoint'); END",
        [],
    );

    assert!(
        env.host()
            .continue_task(
                &task,
                ReplayGuard::Exact(maia_core::super_agent::CallId("call-1".to_owned())),
                Some(b"resume"),
            )
            .is_err()
    );
    assert_eq!(
        texts(&env.database, "SELECT phase FROM task_sessions"),
        before
    );
    assert_eq!(count(&env.database, "SELECT COUNT(*) FROM task_inputs"), 0);
    assert!(matches!(
        env.host().phase(&task),
        Some(TaskPhase::WaitingForUser { .. })
    ));

    exec(&env.database, "DROP TRIGGER reject_continue_input", []);
    env.host()
        .continue_task(
            &task,
            ReplayGuard::Exact(maia_core::super_agent::CallId("call-1".to_owned())),
            Some(b"resume"),
        )
        .expect("continue after rollback");
    assert_eq!(
        texts(&env.database, "SELECT message_id FROM task_inputs"),
        vec![expected_message]
    );
    drop(reopen(&mut env));
    assert_eq!(
        texts(&env.database, "SELECT phase FROM task_sessions"),
        vec!["queued".to_owned()]
    );
}

#[test]
fn failed_continue_appends_exact_bytes_until_retry_host_command() {
    let mut env = Env::open("retry-state");
    let created = admit(&mut env, ORIGINAL);
    let task = created.task.expect("task");
    env.host().tools().push_parent(ScriptedCall::Failure {
        summary: "worker failed".to_owned(),
    });
    env.host().step_parent(&task).expect("fail");
    assert_eq!(
        env.host().phase(&task),
        Some(&TaskPhase::Failed {
            attempt: AttemptId("attempt-1".to_owned()),
            kind: FailureKind::WorkerReported,
        })
    );
    env.router.push_proposal(continue_proposal("task-1"));
    let continued = wait(env.host().handle_user_message(EXTRA)).expect("continue");
    assert!(matches!(
        continued.admitted,
        AdmittedRoute::Admit(RouteDecision::Continue { .. })
    ));
    assert_eq!(continued.task.as_ref(), Some(&task));
    assert_eq!(
        env.host().phase(&task),
        Some(&TaskPhase::Failed {
            attempt: AttemptId("attempt-1".to_owned()),
            kind: FailureKind::WorkerReported,
        })
    );
    assert_eq!(
        blobs(&env.database, "SELECT prompt FROM task_inputs"),
        vec![EXTRA.as_bytes().to_vec()]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT attempt_id FROM task_attempts ORDER BY attempt_id"
        ),
        vec!["attempt-1".to_owned()]
    );
    assert_eq!(
        texts(&env.database, "SELECT phase FROM task_sessions"),
        vec!["failed:worker_reported:attempt-1".to_owned()]
    );
    assert_eq!(
        blobs(&env.database, "SELECT prompt FROM task_envelopes"),
        vec![ORIGINAL.as_bytes().to_vec()]
    );

    let queued = env.host().retry_task(&task).expect("retry");
    assert_eq!(queued, TaskPhase::Queued);
    assert_eq!(env.host().phase(&task), Some(&TaskPhase::Queued));
    assert_eq!(
        texts(
            &env.database,
            "SELECT attempt_id FROM task_attempts ORDER BY attempt_id"
        ),
        vec!["attempt-1".to_owned(), "attempt-2".to_owned()]
    );
    assert_eq!(
        texts(&env.database, "SELECT task_id FROM task_sessions"),
        vec!["task-1".to_owned()]
    );
    env.host().tools().push_parent(ScriptedCall::Progress {
        summary: "started again".to_owned(),
    });
    let started = env.host().step_parent(&task).expect("start attempt");
    assert_eq!(
        started.phase,
        TaskPhase::Running {
            attempt: AttemptId("attempt-2".to_owned()),
        }
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT attempt_id FROM task_attempts ORDER BY attempt_id"
        ),
        vec!["attempt-1".to_owned(), "attempt-2".to_owned()]
    );
    assert_eq!(
        blobs(&env.database, "SELECT prompt FROM task_envelopes"),
        vec![ORIGINAL.as_bytes().to_vec()]
    );
    drop(reopen(&mut env));
    assert_eq!(
        texts(&env.database, "SELECT phase FROM task_sessions"),
        vec!["running:attempt-2".to_owned()]
    );
    assert_eq!(
        blobs(&env.database, "SELECT prompt FROM task_inputs"),
        vec![EXTRA.as_bytes().to_vec()]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT attempt_id FROM task_attempts ORDER BY attempt_id"
        ),
        vec!["attempt-1".to_owned(), "attempt-2".to_owned()]
    );

    let mut http = Env::open("retry-http");
    http.router.push_proposal(create_proposal());
    http.host().tools().push_parent(ScriptedCall::Failure {
        summary: "worker failed".to_owned(),
    });
    http.router.push_proposal(continue_proposal("task-1"));
    let server = http.serve();
    let origin = server.origin().to_owned();
    let (status, body) = block_on(post_json(
        &origin,
        "/api/super-agent/messages",
        json!({"text": ORIGINAL}),
    ));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["admitted"], "admit");
    let (status, _) = block_on(post_json(
        &origin,
        "/api/super-agent/messages",
        json!({"text": EXTRA}),
    ));
    assert_eq!(status, 200);
    assert_eq!(
        blobs(&http.database, "SELECT prompt FROM task_inputs"),
        vec![EXTRA.as_bytes().to_vec()]
    );
    assert_eq!(
        texts(&http.database, "SELECT phase FROM task_sessions"),
        vec!["failed:worker_reported:attempt-1".to_owned()]
    );
    let (status, body) = block_on(post_json(
        &origin,
        "/api/super-agent/host-command",
        json!({"command": "retry", "task_id": "task-1"}),
    ));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["phase"], "queued");
    assert_eq!(
        texts(
            &http.database,
            "SELECT attempt_id FROM task_attempts ORDER BY attempt_id"
        ),
        vec!["attempt-1".to_owned(), "attempt-2".to_owned()]
    );
    assert_eq!(
        texts(&http.database, "SELECT task_id FROM task_sessions"),
        vec!["task-1".to_owned()]
    );
    assert_eq!(
        blobs(&http.database, "SELECT prompt FROM task_envelopes"),
        vec![ORIGINAL.as_bytes().to_vec()]
    );
    drop(server);
    assert_eq!(
        texts(&http.database, "SELECT phase FROM task_sessions"),
        vec!["queued".to_owned()]
    );
}

#[test]
fn rejected_retry_preserves_the_next_attempt_id() {
    let mut env = Env::open("retry-id-preflight");
    let failed = admit(&mut env, "failed task").task.expect("failed task id");
    env.host().tools().push_parent(ScriptedCall::Failure {
        summary: "failed".to_owned(),
    });
    env.host().step_parent(&failed).expect("fail task");

    env.router.push_proposal(create_proposal());
    let queued = wait(env.host().handle_user_message("queued task"))
        .expect("create queued task")
        .task
        .expect("queued task id");

    assert!(env.host().retry_task(&queued).is_err());
    assert_eq!(
        env.host().retry_task(&failed).expect("retry failed"),
        TaskPhase::Queued
    );
    env.host().tools().push_parent(ScriptedCall::Progress {
        summary: "retry started".to_owned(),
    });
    let started = env.host().step_parent(&failed).expect("start retry");

    assert_eq!(
        started.phase,
        TaskPhase::Running {
            attempt: AttemptId("attempt-3".to_owned()),
        }
    );
}

#[test]
fn failed_retry_write_preserves_the_reserved_attempt_id() {
    let mut env = Env::open("retry-write-id-preflight");
    let failed = admit(&mut env, "failed task").task.expect("failed task id");
    env.host().tools().push_parent(ScriptedCall::Failure {
        summary: "failed".to_owned(),
    });
    env.host().step_parent(&failed).expect("fail task");
    env.router.push_proposal(create_proposal());
    wait(env.host().handle_user_message("second task")).expect("second task");
    exec(
        &env.database,
        "CREATE TRIGGER reject_retry_phase BEFORE UPDATE OF phase ON task_sessions \
         WHEN OLD.task_id = 'task-1' AND NEW.phase = 'queued' \
         BEGIN SELECT RAISE(ABORT, 'retry failpoint'); END;",
        [],
    );

    assert!(env.host().retry_task(&failed).is_err());
    exec(&env.database, "DROP TRIGGER reject_retry_phase", []);
    assert_eq!(
        env.host()
            .retry_task(&failed)
            .expect("retry after failpoint"),
        TaskPhase::Queued
    );
    env.host().tools().push_parent(ScriptedCall::Progress {
        summary: "retry started".to_owned(),
    });
    let started = env.host().step_parent(&failed).expect("start retry");

    assert_eq!(
        started.phase,
        TaskPhase::Running {
            attempt: AttemptId("attempt-3".to_owned()),
        }
    );
}

#[test]
fn create_linked_asks_while_running_and_seals_only_the_new_prompt() {
    let mut env = Env::open("link");
    let created = admit(&mut env, ORIGINAL);
    let task = created.task.expect("task");
    env.host().tools().push_parent(ScriptedCall::Progress {
        summary: "working".to_owned(),
    });
    env.host().step_parent(&task).expect("run");
    assert!(matches!(
        env.host().phase(&task),
        Some(TaskPhase::Running { .. })
    ));
    env.router.push_host_ask(linked_proposal("task-1"));
    let asked = wait(env.host().handle_user_message(LINKED)).expect("ask");
    assert!(matches!(asked.admitted, AdmittedRoute::AskUser { .. }));
    assert!(asked.task.is_none());
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_envelopes"),
        1
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_attempts"),
        1
    );
    assert_eq!(
        blobs(&env.database, "SELECT prompt FROM task_envelopes"),
        vec![ORIGINAL.as_bytes().to_vec()]
    );

    env.host().tools().push_parent(ScriptedCall::Completion {
        summary: "pin added".to_owned(),
        evidence: CompletionEvidence::Stored,
    });
    let done = env.host().step_parent(&task).expect("complete");
    assert!(matches!(done.phase, TaskPhase::Completed { .. }));
    env.router.push_proposal(linked_proposal("task-1"));
    let linked = wait(env.host().handle_user_message(LINKED)).expect("link");
    assert!(matches!(
        linked.admitted,
        AdmittedRoute::Admit(RouteDecision::CreateLinked { .. })
    ));
    assert_eq!(linked.task, Some(TaskId("task-2".to_owned())));
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_sessions"),
        2
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_envelopes"),
        2
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_attempts"),
        2
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT prior_task_id FROM task_sessions WHERE task_id = 'task-2'"
        ),
        vec!["task-1".to_owned()]
    );
    assert_eq!(
        blobs(
            &env.database,
            "SELECT prompt FROM task_envelopes WHERE task_id = 'task-1'"
        ),
        vec![ORIGINAL.as_bytes().to_vec()]
    );
    assert_eq!(
        blobs(
            &env.database,
            "SELECT prompt FROM task_envelopes WHERE task_id = 'task-2'"
        ),
        vec![LINKED.as_bytes().to_vec()]
    );
    drop(reopen(&mut env));
    assert_eq!(
        blobs(
            &env.database,
            "SELECT prompt FROM task_envelopes ORDER BY task_id"
        ),
        vec![ORIGINAL.as_bytes().to_vec(), LINKED.as_bytes().to_vec()]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT prior_task_id FROM task_sessions WHERE task_id = 'task-2'"
        ),
        vec!["task-1".to_owned()]
    );
}

#[test]
fn inspection_get_is_read_only_and_repost_keeps_the_sealed_prompt() {
    let mut env = Env::open("inspect");
    let created = admit(&mut env, ORIGINAL);
    let task = created.task.expect("task");
    assign(&mut env, &task, "child-1", ORIGINAL);
    env.host().tools().push_parent(ScriptedCall::Progress {
        summary: "parent progress".to_owned(),
    });
    env.host().step_parent(&task).expect("progress");
    env.host()
        .store()
        .insert_task_evidence(TaskEvidenceWrite {
            evidence_id: "evidence-9".to_owned(),
            task_id: "task-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            body: "stored artifact".to_owned(),
        })
        .expect("evidence");
    let reductions = env.host().reduction_count();
    let calls = env.host().tools().call_count();
    let preview = env.host().read_inspection("task-1").expect("preview");
    assert_eq!(env.host().reduction_count(), reductions);
    assert_eq!(env.host().tools().call_count(), calls);
    assert_eq!(preview["original_prompt"], ORIGINAL);
    assert_eq!(preview["helpers"][0]["task_id"], "child-1");
    assert_eq!(preview["transcript"][0]["text"], "parent progress");
    assert_eq!(preview["tool_events"][0]["summary"], "parent progress");
    assert_eq!(preview["tool_events"][0]["call_id"], "call-1");
    assert_eq!(preview["artifacts"][0]["artifact_id"], "evidence-9");
    assert_eq!(preview["attempts"][0]["attempt_id"], "attempt-1");
    assert_eq!(preview["criteria"][0]["criterion_id"], "criterion-1");
    assert_eq!(preview["criteria"][0]["text"], ORIGINAL);
    assert!(preview["decisions"].is_array());
    let before = durable_counts(&env.database);
    let prompt_before = blobs(&env.database, "SELECT prompt FROM task_envelopes");
    env.router.push_proposal(inspect_proposal("task-1"));
    env.router.push_proposal(inspect_proposal("task-1"));
    let server = env.serve();
    let origin = server.origin().to_owned();
    let (status, detail) = block_on(get_json(&origin, "/api/super-agent/tasks/task-1"));
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail, preview);
    assert_eq!(durable_counts(&env.database), before);
    assert_eq!(
        blobs(&env.database, "SELECT prompt FROM task_envelopes"),
        prompt_before
    );
    let (status, first) = block_on(post_json(
        &origin,
        "/api/super-agent/messages",
        json!({"text": ORIGINAL}),
    ));
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["admitted"], "admit");
    let (status, second) = block_on(post_json(
        &origin,
        "/api/super-agent/messages",
        json!({"text": ORIGINAL}),
    ));
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["admitted"], "admit");
    assert_eq!(
        blobs(&env.database, "SELECT prompt FROM task_envelopes"),
        vec![ORIGINAL.as_bytes().to_vec()]
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    let (status, again) = block_on(get_json(&origin, "/api/super-agent/tasks/task-1"));
    assert_eq!(status, 200);
    assert_eq!(again["original_prompt"], ORIGINAL);
    assert_eq!(again["criteria"][0]["text"], ORIGINAL);
    drop(server);
    assert_eq!(
        blobs(&env.database, "SELECT prompt FROM task_envelopes"),
        vec![ORIGINAL.as_bytes().to_vec()]
    );
}

#[test]
fn stop_all_holds_descendants_without_deleting_history() {
    let mut env = Env::open("stop-all");
    let created = admit(&mut env, ORIGINAL);
    let task = created.task.expect("parent");
    env.host().tools().push_parent(ScriptedCall::Progress {
        summary: "parent report".to_owned(),
    });
    env.host().step_parent(&task).expect("progress");
    assign(&mut env, &task, "child-b", ORIGINAL);
    assign(&mut env, &task, "child-a", ORIGINAL);
    assign(&mut env, &task, "child-done", ORIGINAL);
    env.host()
        .store()
        .insert_child(child_write("grand-a", "child-a", 2, "grand slice"))
        .expect("grandchild");
    env.host()
        .store()
        .insert_child(child_write("grand-open", "child-done", 2, "open slice"))
        .expect("open grandchild");
    exec(
        &env.database,
        "UPDATE child_assignments SET phase = ?1 WHERE child_id = 'child-done'",
        params!["completed:evidence-9"],
    );
    env.host()
        .store()
        .insert_task_evidence(TaskEvidenceWrite {
            evidence_id: "evidence-9".to_owned(),
            task_id: "task-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            body: "keep me".to_owned(),
        })
        .expect("artifact");
    env.router.push_proposal(create_proposal());
    let sibling = wait(env.host().handle_user_message("done sibling")).expect("sibling");
    let sibling_id = sibling.task.expect("sibling id");
    env.host().tools().push_parent(ScriptedCall::Completion {
        summary: "sibling done".to_owned(),
        evidence: CompletionEvidence::Stored,
    });
    env.host()
        .step_parent(&sibling_id)
        .expect("complete sibling");
    let sibling_phase = texts(
        &env.database,
        "SELECT phase FROM task_sessions WHERE task_id = 'task-2'",
    );
    assert!(sibling_phase[0].starts_with("completed:"));
    let reports_before = count(&env.database, "SELECT COUNT(*) FROM task_reports");
    let evidence_before = count(&env.database, "SELECT COUNT(*) FROM task_evidence");
    let subgoals_before = blobs(
        &env.database,
        "SELECT subgoal FROM child_assignments ORDER BY child_id",
    );
    let server = env.serve();
    let origin = server.origin().to_owned();
    let (status, body) = block_on(post_json(
        &origin,
        "/api/super-agent/host-command",
        json!({"command": "stop_all"}),
    ));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["phase"], "stopped");
    let phases = texts(
        &env.database,
        "SELECT child_id || '=' || phase FROM child_assignments ORDER BY child_id",
    );
    assert_eq!(
        phases,
        vec![
            "child-a=stopped:1".to_owned(),
            "child-b=stopped:1".to_owned(),
            "child-done=completed:evidence-9".to_owned(),
            "grand-a=stopped:1".to_owned(),
            "grand-open=stopped:1".to_owned(),
        ]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT phase FROM task_sessions WHERE task_id = 'task-1'"
        ),
        vec!["stopped:1".to_owned()]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT phase FROM task_sessions WHERE task_id = 'task-2'"
        ),
        sibling_phase
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_reports"),
        reports_before
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_evidence"),
        evidence_before
    );
    assert_eq!(
        blobs(
            &env.database,
            "SELECT subgoal FROM child_assignments ORDER BY child_id"
        ),
        subgoals_before
    );
    drop(server);
    assert_eq!(
        texts(
            &env.database,
            "SELECT child_id || '=' || phase FROM child_assignments ORDER BY child_id"
        ),
        phases
    );

    let mut stop_env = Env::open("stop-all-tree");
    let created = admit(&mut stop_env, ORIGINAL);
    let task = created.task.expect("stop-all parent");
    stop_env.host().tools().push_parent(ScriptedCall::Progress {
        summary: "still here".to_owned(),
    });
    stop_env.host().step_parent(&task).expect("progress");
    assign(&mut stop_env, &task, "child-a", ORIGINAL);
    stop_env
        .host()
        .store()
        .insert_child(child_write("grand-a", "child-a", 2, "grand slice"))
        .expect("grandchild");
    let server = stop_env.serve();
    let origin = server.origin().to_owned();
    let (status, body) = block_on(post_json(
        &origin,
        "/api/super-agent/host-command",
        json!({"command": "stop_all"}),
    ));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["phase"], "stopped");
    assert_eq!(
        texts(
            &stop_env.database,
            "SELECT child_id || '=' || phase FROM child_assignments ORDER BY child_id"
        ),
        vec![
            "child-a=stopped:1".to_owned(),
            "grand-a=stopped:1".to_owned(),
        ]
    );
    assert_eq!(
        texts(&stop_env.database, "SELECT summary FROM task_reports"),
        vec!["still here".to_owned()]
    );
    drop(server);
    assert_eq!(
        texts(&stop_env.database, "SELECT phase FROM task_sessions"),
        vec!["stopped:1".to_owned()]
    );
}

#[test]
fn host_mutation_rolls_back_at_each_descendant_and_parent_boundary() {
    let mut env = Env::open("host-atomic-one");
    let task = admit(&mut env, "atomic stop").task.expect("task");
    assign(&mut env, &task, "child-1", "atomic stop");
    exec(
        &env.database,
        "CREATE TRIGGER reject_parent_stop BEFORE UPDATE OF phase ON task_sessions \
         WHEN task_id = 'task-1' \
         BEGIN SELECT RAISE(ABORT, 'parent stop failpoint'); END",
        [],
    );

    assert!(
        env.host()
            .apply_host_command(HostCommand::Stop {
                task,
                command: CommandId(77),
            })
            .is_err()
    );
    assert_eq!(
        texts(&env.database, "SELECT phase FROM task_sessions"),
        vec!["queued".to_owned()]
    );
    assert_eq!(
        texts(&env.database, "SELECT phase FROM child_assignments"),
        vec!["queued".to_owned()]
    );

    let mut descendant = Env::open("host-atomic-descendant");
    let task = admit(&mut descendant, "descendant stop")
        .task
        .expect("task");
    assign(&mut descendant, &task, "child-1", "descendant stop");
    assign(&mut descendant, &task, "child-2", "descendant stop");
    exec(
        &descendant.database,
        "CREATE TRIGGER reject_second_child BEFORE UPDATE OF phase ON child_assignments \
         WHEN child_id = 'child-2' \
         BEGIN SELECT RAISE(ABORT, 'child failpoint'); END",
        [],
    );
    assert!(
        descendant
            .host()
            .apply_host_command(HostCommand::Stop {
                task,
                command: CommandId(78),
            })
            .is_err()
    );
    assert_eq!(
        texts(&descendant.database, "SELECT phase FROM task_sessions"),
        vec!["queued".to_owned()]
    );
    assert_eq!(
        texts(
            &descendant.database,
            "SELECT phase FROM child_assignments ORDER BY child_id"
        ),
        vec!["queued".to_owned(), "queued".to_owned()]
    );
}

#[test]
fn stop_all_is_atomic_across_all_tasks_and_descendants() {
    let mut env = Env::open("host-atomic-many");
    let first = admit(&mut env, "first").task.expect("first");
    let second = admit(&mut env, "second").task.expect("second");
    assign(&mut env, &first, "child-1", "first");
    assign(&mut env, &second, "child-2", "second");
    exec(
        &env.database,
        "CREATE TRIGGER reject_second_stop BEFORE UPDATE OF phase ON task_sessions \
         WHEN task_id = 'task-2' \
         BEGIN SELECT RAISE(ABORT, 'second stop failpoint'); END",
        [],
    );

    assert!(
        env.host()
            .apply_host_command(HostCommand::StopAll {
                command: CommandId(78),
            })
            .is_err()
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT phase FROM task_sessions ORDER BY task_id"
        ),
        vec!["queued".to_owned(), "queued".to_owned()]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT phase FROM child_assignments ORDER BY child_id"
        ),
        vec!["queued".to_owned(), "queued".to_owned()]
    );
}

#[test]
fn stop_all_skips_a_task_already_held_and_keeps_its_command() {
    let mut env = Env::open("stop-all-skips-held");
    let held = admit(&mut env, "held first").task.expect("held");
    let live = admit(&mut env, "live second").task.expect("live");
    env.host()
        .apply_host_command(HostCommand::Stop {
            task: held.clone(),
            command: CommandId(10),
        })
        .expect("stop first");

    env.host()
        .apply_host_command(HostCommand::StopAll {
            command: CommandId(11),
        })
        .expect("stop all");

    assert_eq!(
        env.host().phase(&held),
        Some(&TaskPhase::Stopped {
            command: CommandId(10),
        })
    );
    assert_eq!(
        env.host().phase(&live),
        Some(&TaskPhase::Stopped {
            command: CommandId(11),
        })
    );
}

#[test]
fn stop_all_keeps_a_held_child_under_the_command_that_held_it() {
    let mut env = Env::open("stop-keeps-held-child");
    let task = admit(&mut env, "held child").task.expect("task");
    assign(&mut env, &task, "child-1", "held child");
    env.host()
        .apply_host_command(HostCommand::Stop {
            task: task.clone(),
            command: CommandId(1),
        })
        .expect("stop");
    env.host().retry_task(&task).expect("retry after stop");

    env.host()
        .apply_host_command(HostCommand::StopAll {
            command: CommandId(2),
        })
        .expect("stop all again");

    assert_eq!(
        env.host().phase(&task),
        Some(&TaskPhase::Stopped {
            command: CommandId(2),
        })
    );
    assert_eq!(
        texts(&env.database, "SELECT phase FROM child_assignments"),
        vec!["stopped:1".to_owned()]
    );
}

#[test]
fn retry_after_stop_queues_the_task_under_a_fresh_attempt() {
    let mut initial_ids = supply();
    initial_ids.attempts.clear();
    initial_ids.attempts.push_back("attempt-1".to_owned());
    initial_ids.attempts.push_back("attempt-retry".to_owned());
    let mut env = Env::open_ids("retry-after-stop", initial_ids);
    let task = admit(&mut env, "retry after stop").task.expect("task");
    env.host()
        .apply_host_command(HostCommand::Stop {
            task: task.clone(),
            command: CommandId(1),
        })
        .expect("stop");

    assert_eq!(
        env.host().retry_task(&task).expect("retry after stop"),
        TaskPhase::Queued
    );
    assert_eq!(env.host().phase(&task), Some(&TaskPhase::Queued));
    assert_eq!(
        texts(
            &env.database,
            "SELECT state FROM task_attempts WHERE attempt_id = 'attempt-retry'"
        ),
        vec!["active".to_owned()]
    );
}

#[test]
fn cancel_ends_a_held_task_and_its_held_children_under_the_cancel_command() {
    let mut env = Env::open("cancel-held-tree");
    let task = admit(&mut env, "cancel held").task.expect("task");
    assign(&mut env, &task, "child-1", "cancel held");
    env.host()
        .apply_host_command(HostCommand::Stop {
            task: task.clone(),
            command: CommandId(1),
        })
        .expect("stop");

    assert_eq!(
        env.host()
            .apply_host_command(HostCommand::Cancel {
                task: task.clone(),
                command: CommandId(2),
            })
            .expect("cancel"),
        TaskPhase::Cancelled {
            command: CommandId(2),
        }
    );
    assert_eq!(
        texts(&env.database, "SELECT phase FROM child_assignments"),
        vec!["cancelled:2".to_owned()]
    );
}

#[test]
fn abandon_cancels_nonterminal_descendants_with_the_supplied_command() {
    let mut ids = supply();
    ids.commands.clear();
    ids.commands.push_back(41);
    let mut env = Env::open_ids("abandon", ids);
    let created = admit(&mut env, ORIGINAL);
    let task = created.task.expect("parent");
    env.host().tools().push_parent(ScriptedCall::Progress {
        summary: "abandon report".to_owned(),
    });
    env.host().step_parent(&task).expect("progress");
    assign(&mut env, &task, "child-a", ORIGINAL);
    assign(&mut env, &task, "child-done", ORIGINAL);
    env.host()
        .store()
        .insert_child(child_write("grand-a", "child-a", 2, "grand slice"))
        .expect("grandchild");
    env.host()
        .store()
        .insert_child(child_write("grand-open", "child-done", 2, "open slice"))
        .expect("open grandchild");
    exec(
        &env.database,
        "UPDATE child_assignments SET phase = ?1 WHERE child_id = 'child-done'",
        params!["completed:evidence-9"],
    );
    env.host()
        .store()
        .insert_task_evidence(TaskEvidenceWrite {
            evidence_id: "evidence-9".to_owned(),
            task_id: "task-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            body: "keep the artifact".to_owned(),
        })
        .expect("artifact");
    let reports_before = count(&env.database, "SELECT COUNT(*) FROM task_reports");
    let evidence_before = count(&env.database, "SELECT COUNT(*) FROM task_evidence");
    let subgoals_before = blobs(
        &env.database,
        "SELECT subgoal FROM child_assignments ORDER BY child_id",
    );
    let server = env.serve();
    let origin = server.origin().to_owned();
    let (status, body) = block_on(post_json(
        &origin,
        "/api/super-agent/host-command",
        json!({"command": "abandon", "task_id": "task-1"}),
    ));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["phase"], "abandoned");
    drop(server);
    assert_eq!(
        texts(&env.database, "SELECT phase FROM task_sessions"),
        vec!["abandoned:decision-1".to_owned()]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT child_id || '=' || phase FROM child_assignments ORDER BY child_id"
        ),
        vec![
            "child-a=cancelled:41".to_owned(),
            "child-done=completed:evidence-9".to_owned(),
            "grand-a=cancelled:41".to_owned(),
            "grand-open=cancelled:41".to_owned(),
        ]
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_reports"),
        reports_before
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_evidence"),
        evidence_before
    );
    assert_eq!(
        blobs(
            &env.database,
            "SELECT subgoal FROM child_assignments ORDER BY child_id"
        ),
        subgoals_before
    );
}

#[test]
fn context_snapshot_stores_advisory_items_and_memory_is_not_evidence() {
    let ranked = vec![
        RankedMemory {
            memory: MemoryId("fact-1".to_owned()),
            sentence: FACT_SENTENCE.to_owned(),
            provenance: MemoryProvenance::Fact {
                fact: FactId::new("fact-1"),
            },
            trust: Taint::Untrusted,
        },
        RankedMemory {
            memory: MemoryId("claim-1".to_owned()),
            sentence: CLAIM_SENTENCE.to_owned(),
            provenance: MemoryProvenance::Claim {
                claim: ClaimId::new("claim-1"),
            },
            trust: Taint::Trusted,
        },
    ];
    let expected = advisory_items(&SnapshotId("snap-1".to_owned()), &ranked);
    let mut env = Env::open("snapshot");
    env.host().set_ranked_memories(ranked);
    let created = admit(&mut env, ORIGINAL);
    let task = created.task.expect("task");
    assert!(matches!(env.host().phase(&task), Some(TaskPhase::Queued)));
    assert_eq!(
        texts(
            &env.database,
            "SELECT snapshot_id FROM context_snapshots ORDER BY ordinal"
        ),
        vec!["snap-1".to_owned(), "snap-1".to_owned()]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT memory_id FROM context_snapshots ORDER BY ordinal"
        ),
        expected
            .iter()
            .map(|item| item.memory.0.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT sentence FROM context_snapshots ORDER BY ordinal"
        ),
        expected
            .iter()
            .map(|item| item.sentence.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT trust FROM context_snapshots ORDER BY ordinal"
        ),
        vec!["untrusted".to_owned(), "trusted".to_owned()]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT provenance FROM context_snapshots ORDER BY ordinal"
        ),
        vec!["fact:fact-1".to_owned(), "claim:claim-1".to_owned()]
    );
    let stored = env.host().recorded_evidence(&task);
    assert!(stored.is_empty());
    let refused = admit_completion(
        &[sealed_criterion(ORIGINAL)],
        &[CriterionMark::Satisfied {
            criterion: CriterionId("criterion-1".to_owned()),
            evidence: EvidenceId("fact-1".to_owned()),
        }],
        &stored,
    );
    assert_eq!(refused, Err(CompletionError::MissingEvidence));
    drop(reopen(&mut env));
    assert_eq!(
        texts(
            &env.database,
            "SELECT sentence FROM context_snapshots ORDER BY ordinal"
        ),
        vec![FACT_SENTENCE.to_owned(), CLAIM_SENTENCE.to_owned()]
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT trust FROM context_snapshots ORDER BY ordinal"
        ),
        vec!["untrusted".to_owned(), "trusted".to_owned()]
    );
}

#[test]
fn router_tools_json_is_empty_for_every_profile() {
    let profiles = [
        SecurityProfile::Protected,
        SecurityProfile::Allowlisted,
        SecurityProfile::Unrestricted,
    ];
    for profile in profiles {
        let grants = execution_tools(&SessionRole::Router, profile);
        assert!(grants.is_empty(), "{profile:?}");
        let tools = ScriptedToolHost::create();
        for tool in [
            ExecutionTool::Shell,
            ExecutionTool::Filesystem,
            ExecutionTool::Browser,
            ExecutionTool::Network,
            ExecutionTool::Vault,
            ExecutionTool::OpenThread,
            ExecutionTool::PostToThread,
        ] {
            let error = tools
                .execute(&SessionRole::Router, tool, profile)
                .expect_err("router tool");
            assert_eq!(error, ToolHostError::RouterForbidden);
        }
        let mut env = Env::open_with("tools", profile);
        env.router.push_proposal(create_proposal());
        wait(env.host().handle_user_message(ORIGINAL)).expect("route");
        let requests = env.router.requests();
        assert!(!requests.is_empty());
        for request in &requests {
            assert!(request.tools_json.0.contains("spawn_task"));
            assert!(!request.tools_json.0.contains("shell"));
            assert!(!request.tools_json.0.contains("filesystem"));
            assert!(!request.tools_json.0.contains("browser"));
            assert!(!request.tools_json.0.contains("vault"));
        }
    }
}

#[test]
fn task_report_wake_relays_compact_report_without_transcripts() {
    let mut env = Env::open("relay");
    let created = admit(&mut env, PROMPT_MARKER);
    let task = created.task.expect("task");
    assign(&mut env, &task, "child-1", PROMPT_MARKER);
    env.host().tools().push_child(ScriptedCall::Progress {
        summary: CHILD_LOG.to_owned(),
    });
    env.host()
        .step_child(&task, &ChildId("child-1".to_owned()))
        .expect("child");
    env.router.push_raw(RELAY_PROSE);
    env.host().tools().push_parent(ScriptedCall::Progress {
        summary: PARENT_SUMMARY.to_owned(),
    });
    env.host().step_parent(&task).expect("parent");
    let relay = env
        .router
        .requests()
        .into_iter()
        .find(|request| {
            request
                .messages
                .iter()
                .any(|message| message.content.contains(PARENT_SUMMARY))
        })
        .expect("relay request");
    assert_eq!(relay.tools_json, CanonicalJson("[]".to_owned()));
    let joined = relay
        .messages
        .iter()
        .map(|message| message.content.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(joined.contains("report-2"));
    assert!(joined.contains("task-1"));
    assert!(joined.contains(PARENT_SUMMARY));
    assert!(!joined.contains(PROMPT_MARKER));
    assert!(!joined.contains(CHILD_LOG));
    assert!(!joined.contains("TOOL-TRANSCRIPT"));
    assert!(!joined.contains("API_KEY"));
    assert!(!joined.contains("BASE_URL"));
    assert!(!joined.contains("sk-fixture"));
    assert!(!joined.contains("sk-live"));
    assert!(!joined.contains("Allowed proposed.kind"));
    assert!(
        relay
            .messages
            .iter()
            .any(|message| message.role == ChatRole::System)
    );
    let bodies = texts(
        &env.database,
        "SELECT body FROM router_messages ORDER BY ordinal",
    );
    assert!(bodies.contains(&RELAY_PROSE.to_owned()));
    assert!(!bodies.iter().any(|body| body.contains(CHILD_LOG)));
    assert_eq!(
        texts(
            &env.database,
            "SELECT summary FROM task_reports ORDER BY report_id"
        ),
        vec![CHILD_LOG.to_owned(), PARENT_SUMMARY.to_owned()]
    );
    assert_eq!(
        count(&env.database, "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    drop(reopen(&mut env));
    assert!(
        texts(&env.database, "SELECT body FROM router_messages").contains(&RELAY_PROSE.to_owned())
    );
    assert_eq!(
        texts(
            &env.database,
            "SELECT summary FROM task_reports ORDER BY report_id"
        ),
        vec![CHILD_LOG.to_owned(), PARENT_SUMMARY.to_owned()]
    );
}

#[test]
fn legacy_thread_survives_create_continue_and_complete() {
    let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut directory = std::env::temp_dir();
    directory.push("maia-daemon-flow");
    directory.push(format!("legacy-{sequence}"));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).expect("temp dir");
    let database = directory.join("maia.sqlite");
    let owner = SqliteOwner::open(OwnerOpen {
        path: database.clone(),
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("legacy owner");
    owner
        .append(AppendEvents {
            thread_id: "thread-legacy".to_owned(),
            expected_version: 0,
            participants: "owner".to_owned(),
            occurred_at: NOW,
            events: vec![ThreadEventWrite {
                event_id: "event-1".to_owned(),
                kind: "user".to_owned(),
                body: "legacy body".to_owned(),
            }],
        })
        .expect("append");
    owner.mark_legacy_threads(NOW).expect("mark");
    owner.shutdown().expect("shutdown");

    let router = ScriptedRouter::create();
    let reopened = SqliteOwner::open(OwnerOpen {
        path: database.clone(),
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("reopen");
    let mut host = Orchestrator::create(
        router.clone(),
        reopened,
        ScriptedToolHost::create(),
        OrchestratorConfig {
            policy: accepted_routing_policy(),
            ids: supply(),
            turn: RouterTurn {
                model: "fixture-model".to_owned(),
                reasoning: ReasoningEffort::Low,
                prefix_hash: PrefixHash::new("fixture-prefix"),
            },
            profile: SecurityProfile::Protected,
            parent_work: ParentWork::Script,
        },
    );
    router.push_proposal(create_proposal());
    let created = wait(host.handle_user_message(ORIGINAL)).expect("create");
    let task = created.task.expect("task");
    router.push_proposal(continue_proposal("task-1"));
    wait(host.handle_user_message("continue legacy")).expect("continue");
    router.push_raw("legacy relay");
    host.tools().push_parent(ScriptedCall::Completion {
        summary: "done".to_owned(),
        evidence: CompletionEvidence::Stored,
    });
    host.step_parent(&task).expect("complete");
    drop(host);
    let owner = SqliteOwner::open(OwnerOpen {
        path: database.clone(),
        now: NOW + 2,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("final");
    assert_eq!(
        owner.legacy_thread_ids().expect("legacy ids"),
        vec!["thread-legacy".to_owned()]
    );
    let snapshot = owner.thread("thread-legacy").expect("thread");
    assert_eq!(snapshot.events.len(), 1);
    assert_eq!(snapshot.events[0].event_id, "event-1");
    assert_eq!(snapshot.events[0].body, "legacy body");
    assert_eq!(snapshot.events[0].kind, "user");
    drop(owner);
    let _ = fs::remove_dir_all(&directory);
}
