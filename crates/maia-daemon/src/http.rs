//! Loopback HTTP and websocket skin for the Super Agent catalog.
//!
//! Handlers parse requests and call the orchestrator. They do not admit routes.
//! Credentials, provider URLs, and upstream bodies stay out of responses.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::future::Future;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::path::Path as FsPath;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::task::Context;
use std::task::Poll;
use std::task::Wake;
use std::task::Waker;
use std::time::Duration;
use std::time::Instant;

use axum::Json;
use axum::RequestExt;
use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::Request;
use axum::extract::State;
use axum::extract::ws::Message;
use axum::extract::ws::WebSocket;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::HeaderValue;
use axum::http::StatusCode;
use axum::http::header;
use axum::http::header::CONTENT_TYPE;
use axum::middleware;
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::get;
use axum::routing::patch;
use axum::routing::post;
use axum::routing::put;
use maia_core::brain::LexicalPolicy;
use maia_core::brain::lexemes_for_sentence;
use maia_core::router::ReasoningEffort;
use maia_core::router::Router as RouterPort;
use maia_core::router::RouterError;
use maia_core::router::RouterRequest;
use maia_core::router::RouterResponse;
use maia_core::super_agent::AdmittedRoute;
use maia_core::super_agent::CompletionView;
use maia_core::super_agent::CompletionViewError;
use maia_core::super_agent::CompletionViewEvent;
use maia_core::super_agent::DecisionId;
use maia_core::super_agent::DetailSessionId;
use maia_core::super_agent::HostCommand;
use maia_core::super_agent::PinMark;
use maia_core::super_agent::SidebarSection;
use maia_core::super_agent::SubmissionId;
use maia_core::super_agent::TaskId;
use maia_core::super_agent::TaskPhase;
use maia_core::super_agent::place_sidebar;
use maia_core::super_agent::reduce_completion_view;
use maia_router::RouterHttp;
use maia_router::models_url;
use maia_store::BrainEdge;
use maia_store::BrainMap;
use maia_store::BrainNode;
use maia_store::FactRevise;
use maia_store::ModelConnectionRecord;
use maia_store::RuntimeHttpIdReservation;
use maia_store::SCHEMA_LOCK_BUSY_TIMEOUT;
use maia_store::StoreError;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tokio::net::TcpListener;

use crate::inspector::StoredTurnRow;
use crate::inspector::inspector_document;
use crate::mcp_settings::McpApiError;
use crate::mcp_settings::McpSecretStore;
use crate::mcp_settings::MemoryMcpSecretStore;
use crate::mcp_settings::admit_connection;
use crate::mcp_settings::create_connection;
use crate::mcp_settings::delete_connection;
use crate::mcp_settings::install_from_store;
use crate::mcp_settings::records_json;
use crate::mcp_settings::refresh_connection;
use crate::mcp_settings::rename_connection;
use crate::mcp_settings::replace_connection;
use crate::mcp_settings::revoke_connection;
use crate::model_connection::ModelConnectionWrite;
use crate::model_connection::ModelTestRequest;
use crate::model_connection::PublicModelConnection;
use crate::model_connection::connection_json;
use crate::model_connection::parse_model_test;
use crate::model_connection::parse_model_write;
use crate::model_connection::parse_reasoning_effort;
use crate::model_connection::reasoning_name;
use crate::model_connection::resolve_key;
use crate::model_connection::router_from_connection;
use crate::orchestrator::ActivityLog;
use crate::orchestrator::FastAdmission;
use crate::orchestrator::McpToolReply;
use crate::orchestrator::MessageOutcome;
use crate::orchestrator::OwnerNotice;
use crate::orchestrator::QueuedChat;
use crate::orchestrator::RouteEvent;
use crate::orchestrator::RouteMachine;
use crate::orchestrator::ToolJob;
use crate::orchestrator::ToolParcel;
use crate::orchestrator::ToolStart;
use crate::orchestrator::WorkerAttempts;
use crate::orchestrator::WorkerEvent;
use crate::orchestrator::WorkerMachine;
use crate::orchestrator::present_router_body;
use crate::remote::ListenerClass;
use crate::remote::RemoteHub;
use crate::remote::TailnetPeer;
use crate::remote::UnpairActor;
use crate::remote::code_response;
use crate::remote::desktop_status_response;
use crate::remote::enable_response;
use crate::remote::error_response as remote_error;
use crate::remote::mark_loopback;
use crate::remote::pair_response;
use crate::remote::phone_status_response;
use crate::remote::session_response;
use crate::remote::supervise;
use crate::remote::tailnet_gate;
use crate::remote::unix_now;
use crate::remote::unpair_response;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tower_http::services::ServeDir;
use tower_http::services::ServeFile;

use crate::AdmittedOutcome;
use crate::DiscoveryError;
use crate::HostIntent;
use crate::Orchestrator;
use crate::OrchestratorError;
use crate::RoutedOutcome;
use crate::SubmissionAdmission;
use crate::parse_canonical_phase;
use crate::select_model_id;

const UI_PORT: u16 = 4178;
const MAX_HTTP_BODY: usize = 48 * 1024;
const MAX_UPLOAD_BODY: usize = 14 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE: usize = 8;
const MAX_MESSAGE_BYTES: usize = 32 * 1024;
const MAX_TASK_ID_BYTES: usize = 200;
const MAX_MODEL_LIST_BYTES: usize = 1024 * 1024;
const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(10);
const JSON_CONTENT_TYPE: &str = "application/json";

/// Why a model list could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelListError {
    /// The body was not an OpenAI-compatible model list.
    Unreadable,
    /// `data` was present and empty.
    Empty,
    /// An id was empty or only whitespace.
    BlankId,
    /// The provider request failed without a usable list.
    Unavailable,
}

impl std::fmt::Display for ModelListError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::Unreadable | Self::Unavailable => "The model provider is unavailable.",
            Self::Empty => "Model list is empty.",
            Self::BlankId => "Model list contains an empty id.",
        };
        formatter.write_str(text)
    }
}

impl std::error::Error for ModelListError {}

/// Why the loopback UI server did not start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServeFailure {
    /// The bind address was not loopback or the listener failed.
    Bind,
    /// The server thread stopped before it was ready.
    Server,
}

impl std::fmt::Display for ServeFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("The local UI server could not start.")
    }
}

impl std::error::Error for ServeFailure {}

#[derive(Debug, Deserialize)]
struct ModelListBody {
    data: Vec<ModelRow>,
}

#[derive(Debug, Deserialize)]
struct ModelRow {
    id: String,
}

/// Reads `{ "data": [ { "id" } ] }` without preferring a vendor.
pub fn parse_model_ids(body: &str) -> Result<Vec<String>, ModelListError> {
    let parsed: ModelListBody =
        serde_json::from_str(body).map_err(|_| ModelListError::Unreadable)?;
    if parsed.data.is_empty() {
        return Err(ModelListError::Empty);
    }
    let mut ids = Vec::with_capacity(parsed.data.len());
    for row in parsed.data {
        if row.id.trim().is_empty() {
            return Err(ModelListError::BlankId);
        }
        ids.push(row.id);
    }
    Ok(ids)
}

/// Discovers a model id from `GET {base}/models` using a bearer token.
///
/// The body is capped. Failures do not include the response body, the URL, or the key.
pub async fn discover_model_id(base_url: &str, api_key: &str) -> Result<String, ModelListError> {
    discover_model_id_bounded(base_url, api_key, MAX_MODEL_LIST_BYTES, MODEL_LIST_TIMEOUT).await
}

/// Same discovery as [`discover_model_id`] with an explicit body cap and timeout.
pub async fn discover_model_id_bounded(
    base_url: &str,
    api_key: &str,
    limit: usize,
    timeout: Duration,
) -> Result<String, ModelListError> {
    let ids = list_model_ids_bounded(base_url, api_key, limit, timeout).await?;
    select_model_id(&ids).map_err(model_list_from_discovery)
}

async fn list_model_ids_bounded(
    base_url: &str,
    api_key: &str,
    limit: usize,
    timeout: Duration,
) -> Result<Vec<String>, ModelListError> {
    let url = models_url(base_url).map_err(|_| ModelListError::Unavailable)?;
    let header = HeaderValue::from_str(&format!("Bearer {api_key}"))
        .map_err(|_| ModelListError::Unavailable)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| ModelListError::Unavailable)?;
    let response = client
        .get(url)
        .header(header::AUTHORIZATION, header)
        .send()
        .await
        .map_err(|_| ModelListError::Unavailable)?;
    if !response.status().is_success() {
        let _ = read_bounded(response, limit).await;
        return Err(ModelListError::Unavailable);
    }
    let bytes = read_bounded(response, limit).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| ModelListError::Unreadable)?;
    parse_model_ids(text)
}

fn model_list_from_discovery(error: DiscoveryError) -> ModelListError {
    match error {
        DiscoveryError::NoModels => ModelListError::Empty,
        DiscoveryError::BlankModelId => ModelListError::BlankId,
    }
}

async fn read_bounded(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, ModelListError> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ModelListError::Unavailable)?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(ModelListError::Unavailable);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Returns the last non-empty sidebar frame.
///
/// A slow client keeps that frame and skips intermediates. Empty frames are not shown.
pub fn coalesce_sidebar(updates: &[String]) -> Option<&str> {
    updates
        .iter()
        .rev()
        .find(|frame| !frame.is_empty())
        .map(String::as_str)
}

/// Loopback UI origin. This is not the model provider base URL.
pub fn ui_bind_addr() -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, UI_PORT))
}

struct ShutdownGate {
    sender: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl ShutdownGate {
    fn request(&self) {
        let Ok(mut guard) = self.sender.lock() else {
            return;
        };
        if let Some(sender) = guard.take() {
            let _ = sender.send(());
        }
    }
}

/// Idempotent shutdown for one loopback server. It does not expose routes or state.
#[derive(Clone)]
pub struct ServerShutdown {
    gate: std::sync::Arc<ShutdownGate>,
}

impl ServerShutdown {
    /// Asks the listener to stop. A later call does nothing.
    pub fn request(&self) {
        self.gate.request();
    }
}

/// A running loopback server. Drop stops the listener and the store.
pub struct SuperAgentServer {
    origin: String,
    local_addr: SocketAddr,
    gate: std::sync::Arc<ShutdownGate>,
    thread: Option<std::thread::JoinHandle<()>>,
    armed: bool,
}

impl SuperAgentServer {
    /// `http://127.0.0.1:<port>` for this listener.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// The bound socket. The address is loopback.
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// A handle that can stop the listener without owning the server thread.
    pub fn shutdown_handle(&self) -> ServerShutdown {
        ServerShutdown {
            gate: std::sync::Arc::clone(&self.gate),
        }
    }

    /// Blocks until [`ServerShutdown::request`] or the last server drop.
    ///
    /// This keeps the shutdown sender alive. Dropping it here would stop the listener.
    pub fn wait(mut self) {
        let gate = std::sync::Arc::clone(&self.gate);
        let thread = self.thread.take();
        self.armed = false;
        drop(self);
        if let Some(thread) = thread {
            let _ = thread.join();
        }
        drop(gate);
    }
}

impl Drop for SuperAgentServer {
    fn drop(&mut self) {
        if self.armed {
            self.gate.request();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

/// Router proxy whose HTTP future runs on a Tokio runtime.
///
/// The orchestrator can await this proxy off that runtime, so store calls stay
/// off the worker that would panic inside `blocking_send`.
#[derive(Clone)]
pub struct RuntimeRouter {
    tx: mpsc::Sender<RouterJob>,
}

struct RouterJob {
    request: RouterRequest,
    reply: oneshot::Sender<Result<maia_core::router::RouterResponse, RouterError>>,
}

impl RuntimeRouter {
    /// Moves `router` onto `handle` and returns the proxy the orchestrator holds.
    pub fn spawn<R>(handle: tokio::runtime::Handle, router: R) -> Self
    where
        R: RouterPort + Send + 'static,
    {
        let (tx, mut rx) = mpsc::channel::<RouterJob>(8);
        handle.spawn(async move {
            while let Some(job) = rx.recv().await {
                let result = router.complete(&job.request).await;
                let _ = job.reply.send(result);
            }
        });
        Self { tx }
    }

    /// Same proxy as [`Self::spawn`], plus a channel that replaces the router.
    ///
    /// The next completion uses the installed router. The key stays inside that router.
    pub fn spawn_with_install<R>(
        handle: tokio::runtime::Handle,
        router: R,
    ) -> (Self, mpsc::Sender<R>)
    where
        R: RouterPort + Send + 'static,
    {
        let (tx, mut jobs) = mpsc::channel::<RouterJob>(8);
        let (install_tx, install_rx) = mpsc::channel::<R>(1);
        handle.spawn(async move {
            let mut router = router;
            let mut installs = Some(install_rx);
            loop {
                let next_install = async {
                    match installs.as_mut() {
                        Some(incoming) => incoming.recv().await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    biased;
                    installed = next_install => {
                        match installed {
                            Some(installed) => router = installed,
                            None => installs = None,
                        }
                    }
                    job = jobs.recv() => {
                        let Some(job) = job else { break };
                        let result = router.complete(&job.request).await;
                        let _ = job.reply.send(result);
                    }
                }
            }
        });
        (Self { tx }, install_tx)
    }
}

impl RouterPort for RuntimeRouter {
    fn complete(
        &self,
        request: &RouterRequest,
    ) -> impl Future<Output = Result<maia_core::router::RouterResponse, RouterError>> + Send {
        let tx = self.tx.clone();
        let request = request.clone();
        async move {
            let (reply_tx, reply_rx) = oneshot::channel();
            tx.send(RouterJob {
                request,
                reply: reply_tx,
            })
            .await
            .map_err(|_| RouterError::Protocol {
                detail: "router stopped".to_owned(),
            })?;
            reply_rx.await.map_err(|_| RouterError::Protocol {
                detail: "router stopped".to_owned(),
            })?
        }
    }

    async fn cancel(&self, _request_id: maia_core::audit::RequestId) -> Result<(), RouterError> {
        Ok(())
    }
}

/// Initial durable identifier values owned by the HTTP actor.
#[derive(Debug, PartialEq, Eq)]
pub struct HttpIdSupply {
    /// Next detail-session number.
    next_detail: u64,
    /// Next abandonment-decision number.
    next_decision: u64,
    last_detail: u64,
    last_decision: u64,
}

/// A reserved HTTP identifier range is empty, exhausted, or overflows `u64`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HttpIdSupplyError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PublicationError;

trait SidebarPublication: Send + Sync {
    fn publish(&self, frame: &str) -> Result<(), PublicationError>;
}

impl HttpIdSupply {
    /// Consumes an owner-produced reservation proof into bounded HTTP ranges.
    pub fn from_reserved(reservation: RuntimeHttpIdReservation) -> Result<Self, HttpIdSupplyError> {
        let next_detail = reservation.detail_first();
        let next_decision = reservation.decision_first();
        let count = reservation.count();
        let offset = count.checked_sub(1).ok_or(HttpIdSupplyError)?;
        Ok(Self {
            next_detail,
            next_decision,
            last_detail: next_detail.checked_add(offset).ok_or(HttpIdSupplyError)?,
            last_decision: next_decision.checked_add(offset).ok_or(HttpIdSupplyError)?,
        })
    }

    /// Next reserved detail-session value.
    pub const fn next_detail(&self) -> u64 {
        self.next_detail
    }

    /// Next reserved abandonment-decision value.
    pub const fn next_decision(&self) -> u64 {
        self.next_decision
    }

    fn detail(&self) -> Result<u64, HttpIdSupplyError> {
        (self.next_detail <= self.last_detail)
            .then_some(self.next_detail)
            .ok_or(HttpIdSupplyError)
    }

    fn consume_detail(&mut self, expected: u64) -> Result<(), HttpIdSupplyError> {
        if self.detail()? != expected {
            return Err(HttpIdSupplyError);
        }
        self.next_detail = self.next_detail.saturating_add(1);
        if expected == u64::MAX {
            self.last_detail = u64::MAX - 1;
        }
        Ok(())
    }

    fn decision(&self) -> Result<u64, HttpIdSupplyError> {
        (self.next_decision <= self.last_decision)
            .then_some(self.next_decision)
            .ok_or(HttpIdSupplyError)
    }

    fn consume_decision(&mut self, expected: u64) -> Result<(), HttpIdSupplyError> {
        if self.decision()? != expected {
            return Err(HttpIdSupplyError);
        }
        self.next_decision = self.next_decision.saturating_add(1);
        if expected == u64::MAX {
            self.last_decision = u64::MAX - 1;
        }
        Ok(())
    }
}

/// Why a router key could not be read or written. The key is not included.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKeyError {
    /// The key was empty.
    Empty,
    /// The secret store could not be used.
    Unavailable,
}

/// Stores the router API key outside the database.
pub trait RouterKeyStore: Send + Sync {
    /// Returns the stored key, or nothing when it has not been saved.
    ///
    /// # Errors
    ///
    /// Returns [`ModelKeyError::Unavailable`] when the store cannot be read.
    fn read_key(&self) -> Result<Option<String>, ModelKeyError>;

    /// Replaces the stored key.
    ///
    /// # Errors
    ///
    /// Returns [`ModelKeyError::Empty`] for an empty key and
    /// [`ModelKeyError::Unavailable`] when the store rejects the write.
    fn write_key(&self, key: &str) -> Result<(), ModelKeyError>;
}

/// In-memory key store for tests. Production uses the OS credential store.
#[derive(Default)]
pub struct MemoryRouterKeyStore {
    key: Mutex<Option<String>>,
}

impl MemoryRouterKeyStore {
    /// Empty store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl RouterKeyStore for MemoryRouterKeyStore {
    fn read_key(&self) -> Result<Option<String>, ModelKeyError> {
        Ok(self
            .key
            .lock()
            .map_err(|_| ModelKeyError::Unavailable)?
            .clone())
    }

    fn write_key(&self, key: &str) -> Result<(), ModelKeyError> {
        if key.is_empty() {
            return Err(ModelKeyError::Empty);
        }
        *self.key.lock().map_err(|_| ModelKeyError::Unavailable)? = Some(key.to_owned());
        Ok(())
    }
}

/// OS credential store entry `MaiaRouterKey`.
pub struct NativeRouterKeyStore;

const ROUTER_KEY_TARGET: &str = "MaiaRouterKey";

impl RouterKeyStore for NativeRouterKeyStore {
    fn read_key(&self) -> Result<Option<String>, ModelKeyError> {
        #[cfg(windows)]
        {
            match maia_windows::read_session_credential(ROUTER_KEY_TARGET) {
                Ok(secret) => String::from_utf8(secret.as_bytes().to_vec())
                    .map(Some)
                    .map_err(|_| ModelKeyError::Unavailable),
                Err(maia_windows::CredentialError::NotFound) => Ok(None),
                Err(_) => Err(ModelKeyError::Unavailable),
            }
        }
        #[cfg(not(windows))]
        {
            Err(ModelKeyError::Unavailable)
        }
    }

    fn write_key(&self, key: &str) -> Result<(), ModelKeyError> {
        #[cfg(windows)]
        {
            maia_windows::write_local_credential(ROUTER_KEY_TARGET, key.as_bytes())
                .map_err(|_| ModelKeyError::Unavailable)
        }
        #[cfg(not(windows))]
        {
            let _ = key;
            Err(ModelKeyError::Unavailable)
        }
    }
}

/// OS-backed router key store on Windows, and an empty memory store elsewhere.
pub fn native_router_key_store() -> Arc<dyn RouterKeyStore> {
    #[cfg(windows)]
    {
        Arc::new(NativeRouterKeyStore)
    }
    #[cfg(not(windows))]
    {
        Arc::new(MemoryRouterKeyStore::new())
    }
}

/// Lists model ids for Test connection. Errors must not include the key.
pub trait ModelLister: Send + Sync {
    /// Returns the provider's model ids.
    fn list(
        &self,
        base_url: String,
        api_key: String,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, ModelListError>> + Send>>;
}

struct UnavailableModels;

impl ModelLister for UnavailableModels {
    fn list(
        &self,
        _base_url: String,
        mut api_key: String,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, ModelListError>> + Send>> {
        Box::pin(async move {
            wipe(&mut api_key);
            Err(ModelListError::Unavailable)
        })
    }
}

struct LiveModelLister;

impl ModelLister for LiveModelLister {
    fn list(
        &self,
        base_url: String,
        mut api_key: String,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, ModelListError>> + Send>> {
        Box::pin(async move {
            let result = list_model_ids_bounded(
                &base_url,
                &api_key,
                MAX_MODEL_LIST_BYTES,
                MODEL_LIST_TIMEOUT,
            )
            .await;
            wipe(&mut api_key);
            result
        })
    }
}

/// Provider model list used by Settings on the running daemon.
pub fn live_model_lister() -> Arc<dyn ModelLister> {
    Arc::new(LiveModelLister)
}

/// Dependencies for the model connection routes.
pub struct ModelPorts {
    /// Where the API key is stored.
    pub keys: Arc<dyn RouterKeyStore>,
    /// Key loaded at boot from the environment, used when Settings keeps it.
    pub boot_key: Option<String>,
    /// Replaces the live router after a successful save.
    pub install: Option<mpsc::Sender<RouterHttp>>,
    /// Test connection implementation.
    pub list_models: Arc<dyn ModelLister>,
    /// Shown when Settings has not saved an endpoint yet.
    pub fallback: PublicModelConnection,
    /// MCP header and environment values. They are not written to SQLite.
    pub mcp_secrets: Arc<dyn McpSecretStore>,
}

#[derive(Clone)]
struct ModelHub {
    inner: Arc<ModelHubInner>,
}

struct ModelHubInner {
    keys: Arc<dyn RouterKeyStore>,
    boot_key: Mutex<Option<String>>,
    install: Option<mpsc::Sender<RouterHttp>>,
    fallback: PublicModelConnection,
    models: Mutex<Vec<String>>,
}

impl ModelHub {
    fn from_ports(ports: ModelPorts) -> Self {
        Self {
            inner: Arc::new(ModelHubInner {
                keys: ports.keys,
                boot_key: Mutex::new(ports.boot_key),
                install: ports.install,
                fallback: ports.fallback,
                models: Mutex::new(Vec::new()),
            }),
        }
    }

    fn remember(&self, models: &[String]) {
        if let Ok(mut slot) = self.inner.models.lock() {
            *slot = models.to_vec();
        }
    }

    fn models(&self) -> Vec<String> {
        self.inner
            .models
            .lock()
            .map(|slot| slot.clone())
            .unwrap_or_default()
    }
}

fn default_model_ports() -> ModelPorts {
    ModelPorts {
        keys: Arc::new(MemoryRouterKeyStore::new()),
        boot_key: None,
        install: None,
        list_models: Arc::new(UnavailableModels),
        fallback: PublicModelConnection {
            base_url: String::new(),
            key_set: false,
            model: String::new(),
            reasoning: ReasoningEffort::Medium,
        },
        mcp_secrets: Arc::new(MemoryMcpSecretStore::new()),
    }
}

fn wipe(secret: &mut String) {
    let mut bytes = std::mem::take(secret).into_bytes();
    for byte in &mut bytes {
        *byte = 0;
    }
    std::mem::drop(std::hint::black_box(bytes));
}

/// Binds the Super Agent server with explicit durable HTTP actor identifiers.
pub fn serve_super_agent_with_ids<R>(
    orchestrator: Orchestrator<R>,
    database: PathBuf,
    dist: PathBuf,
    bind: SocketAddr,
    ids: HttpIdSupply,
) -> Result<SuperAgentServer, ServeFailure>
where
    R: RouterPort + Clone + Send + 'static,
{
    serve_super_agent_with_model(
        orchestrator,
        database,
        dist,
        bind,
        ids,
        default_model_ports(),
    )
}

/// Binds the server with a model connection store and an optional live router swap.
pub fn serve_super_agent_with_model<R>(
    orchestrator: Orchestrator<R>,
    database: PathBuf,
    dist: PathBuf,
    bind: SocketAddr,
    ids: HttpIdSupply,
    ports: ModelPorts,
) -> Result<SuperAgentServer, ServeFailure>
where
    R: RouterPort + Clone + Send + 'static,
{
    serve_super_agent_with_source(orchestrator, database, dist, bind, ids, ports)
}

struct ServerThreadConfig {
    database: PathBuf,
    dist: PathBuf,
    bind: SocketAddr,
    ids: HttpIdSupply,
    ports: ModelPorts,
}

fn serve_super_agent_with_source<R>(
    orchestrator: Orchestrator<R>,
    database: PathBuf,
    dist: PathBuf,
    bind: SocketAddr,
    ids: HttpIdSupply,
    ports: ModelPorts,
) -> Result<SuperAgentServer, ServeFailure>
where
    R: RouterPort + Clone + Send + 'static,
{
    if !is_loopback_ip(bind.ip()) {
        return Err(ServeFailure::Bind);
    }
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let thread = std::thread::Builder::new()
        .name("maia-http".to_owned())
        .spawn(move || {
            server_thread(
                orchestrator,
                ServerThreadConfig {
                    database,
                    dist,
                    bind,
                    ids,
                    ports,
                },
                ready_tx,
                shutdown_rx,
            )
        })
        .map_err(|_| ServeFailure::Server)?;
    match ready_rx.recv() {
        Ok(Ok(local_addr)) => Ok(SuperAgentServer {
            origin: format!("http://{local_addr}"),
            local_addr,
            gate: std::sync::Arc::new(ShutdownGate {
                sender: std::sync::Mutex::new(Some(shutdown_tx)),
            }),
            thread: Some(thread),
            armed: true,
        }),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(_) => {
            let _ = thread.join();
            Err(ServeFailure::Server)
        }
    }
}

fn server_thread<R>(
    orchestrator: Orchestrator<R>,
    config: ServerThreadConfig,
    ready: std::sync::mpsc::Sender<Result<SocketAddr, ServeFailure>>,
    shutdown: oneshot::Receiver<()>,
) where
    R: RouterPort + Clone + Send + 'static,
{
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            let _ = ready.send(Err(ServeFailure::Server));
            return;
        }
    };
    let listener = match runtime.block_on(TcpListener::bind(config.bind)) {
        Ok(listener) => listener,
        Err(_) => {
            let _ = ready.send(Err(ServeFailure::Bind));
            return;
        }
    };
    let local_addr = match listener.local_addr() {
        Ok(addr) if addr.ip().is_loopback() => addr,
        Ok(_) => {
            let _ = ready.send(Err(ServeFailure::Bind));
            return;
        }
        Err(_) => {
            let _ = ready.send(Err(ServeFailure::Bind));
            return;
        }
    };
    let activity = ActivityLog::new();
    let mut orchestrator = orchestrator;
    orchestrator.set_activity_log(activity.clone());
    let (commands_tx, commands_rx) = mpsc::channel(32);
    let (updates_tx, updates_rx) = watch::channel(String::new());
    drop(updates_rx);
    let publication: std::sync::Arc<dyn SidebarPublication> =
        std::sync::Arc::new(WatchPublication {
            updates: updates_tx.clone(),
        });
    let list_models = Arc::clone(&config.ports.list_models);
    let mcp_secrets = Arc::clone(&config.ports.mcp_secrets);
    let model = ModelHub::from_ports(config.ports);
    let model_for_actor = model.clone();
    let database_for_actor = config.database.clone();
    let mcp_for_actor = Arc::clone(&mcp_secrets);
    let actor = match std::thread::Builder::new()
        .name("maia-actor".to_owned())
        .spawn(move || {
            actor_loop(
                orchestrator,
                database_for_actor,
                commands_rx,
                config.ids,
                publication,
                model_for_actor,
                mcp_for_actor,
            );
        }) {
        Ok(actor) => actor,
        Err(_) => {
            let _ = ready.send(Err(ServeFailure::Server));
            return;
        }
    };
    let data_dir = config
        .database
        .parent()
        .map(FsPath::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("data"));
    let (remote, enable_rx) = RemoteHub::open(&data_dir, local_addr.port());
    let app = app_router(
        AppState {
            commands: commands_tx,
            updates: updates_tx,
            model,
            list_models,
            remote: remote.clone(),
            database: config.database.clone(),
            mcp_secrets,
            activity,
        },
        config.dist,
    );
    let tail_hub = remote.clone();
    let loop_app = app.clone().layer(middleware::from_fn(mark_loopback));
    let tail_app = app.layer(middleware::from_fn_with_state(remote, tailnet_gate));
    if ready.send(Ok(local_addr)).is_err() {
        drop(runtime);
        let _ = actor.join();
        return;
    }
    let _ = runtime.block_on(async move {
        let (stop_tx, stop_rx) = watch::channel(false);
        let mut stop_for_loop = stop_rx.clone();
        let stop_for_tail = stop_rx;
        tokio::spawn(async move {
            let _ = shutdown.await;
            let _ = stop_tx.send(true);
        });
        let _ = tokio::join!(
            axum::serve(listener, loop_app).with_graceful_shutdown(async move {
                loop {
                    if *stop_for_loop.borrow() {
                        break;
                    }
                    if stop_for_loop.changed().await.is_err() {
                        break;
                    }
                }
            }),
            supervise(enable_rx, tail_hub, tail_app, stop_for_tail),
        );
    });
    drop(runtime);
    let _ = actor.join();
}

#[derive(Clone)]
struct AppState {
    commands: mpsc::Sender<ActorCall>,
    updates: watch::Sender<String>,
    model: ModelHub,
    list_models: Arc<dyn ModelLister>,
    remote: RemoteHub,
    database: PathBuf,
    mcp_secrets: Arc<dyn McpSecretStore>,
    activity: ActivityLog,
}

struct WatchPublication {
    updates: watch::Sender<String>,
}

impl SidebarPublication for WatchPublication {
    fn publish(&self, frame: &str) -> Result<(), PublicationError> {
        self.updates.send_replace(frame.to_owned());
        Ok(())
    }
}

enum ActorCall {
    Message {
        operation: SubmissionId,
        text: String,
        bot_id: String,
        attachments: Vec<crate::orchestrator::StagedAttachment>,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    Bot {
        request: maia_store::BotRequest,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    SaveAttachment {
        write: maia_store::AttachmentWrite,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    DeleteAttachment {
        attachment_id: String,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    Read {
        kind: ReadKind,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    Pin {
        task_id: String,
        pin: PinMark,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    Detail {
        task_id: String,
        view: ViewCommand,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    Reference {
        task_id: String,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    Host {
        command: WireHost,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    DecideApproval {
        approval_id: String,
        decision: maia_store::ApprovalDecision,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    SaveModel {
        write: ModelConnectionWrite,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    ResolveTest {
        request: ModelTestRequest,
        reply: oneshot::Sender<Result<(String, String), ApiError>>,
    },
    BrainMap {
        include_lexemes: bool,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    BrainSearch {
        query: String,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    EditClaim {
        claim_id: String,
        sentence: String,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    ForgetClaim {
        claim_id: String,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    RestoreClaim {
        claim_id: String,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    MergeEntities {
        winner: String,
        loser: String,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    BrainIndex {
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    ExportBrain {
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    ReviseFact {
        fact_id: String,
        sentence: String,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    DeleteFact {
        fact_id: String,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    Mcp {
        action: McpAction,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
}

enum McpAction {
    Create(Value),
    Replace { id: String, body: Value },
    Rename { id: String, body: Value },
    Delete { id: String },
    Refresh { id: String },
    Admit { id: String, body: Value },
    Revoke { id: String },
}

enum ReadKind {
    Sidebar,
    Inspector,
    Task { task_id: String },
}

#[derive(Clone, Copy)]
enum ViewCommand {
    Open,
    Close,
}

struct Actor<R> {
    host: Orchestrator<R>,
    database: PathBuf,
    ids: HttpIdSupply,
    publication: std::sync::Arc<dyn SidebarPublication>,
    model: ModelHub,
    mcp_secrets: Arc<dyn McpSecretStore>,
}

struct LiveRoute {
    operation: SubmissionId,
    machine: RouteMachine,
    inflight: Option<std::sync::mpsc::Receiver<Result<RouterResponse, RouterError>>>,
    pause_until: Option<Instant>,
}

struct LiveWorker {
    machine: WorkerMachine,
    inflight: Option<std::sync::mpsc::Receiver<Result<RouterResponse, RouterError>>>,
    tool: Option<std::sync::mpsc::Receiver<ToolParcel>>,
    waiting_tool: Option<ToolJob>,
}

fn actor_loop<R>(
    host: Orchestrator<R>,
    database: PathBuf,
    mut commands: mpsc::Receiver<ActorCall>,
    ids: HttpIdSupply,
    publication: std::sync::Arc<dyn SidebarPublication>,
    model: ModelHub,
    mcp_secrets: Arc<dyn McpSecretStore>,
) where
    R: RouterPort + Clone + Send + 'static,
{
    let mut actor = Actor {
        host,
        database,
        ids,
        publication,
        model,
        mcp_secrets,
    };
    let publication_for_notice = std::sync::Arc::clone(&actor.publication);
    let database_for_notice = actor.database.clone();
    actor.host.notify_sidebar(std::sync::Arc::new(move || {
        let _ = publish_database(&database_for_notice, publication_for_notice.as_ref());
    }));
    // The listener is already bound. Resume here so a parent model call does
    // not keep Settings unreachable until that call finishes.
    actor.host.work_queued_parents();
    actor.host.defer_model_work();
    let mut inbox = VecDeque::new();
    if let Ok(pending) = actor.host.store().pending_submissions() {
        for (operation, message, text) in pending {
            inbox.push_back(QueuedChat {
                operation: SubmissionId(operation),
                message: maia_core::super_agent::MessageId(message),
                text,
                attachments: Vec::new(),
            });
        }
    }
    let mut route = None;
    let mut workers = Vec::new();
    loop {
        pump(&mut actor, &mut inbox, &mut route, &mut workers);
        let idle = route.is_none() && workers.is_empty() && inbox.is_empty();
        let call = if idle {
            match commands.blocking_recv() {
                Some(call) => call,
                None => break,
            }
        } else {
            match commands.try_recv() {
                Ok(call) => call,
                Err(mpsc::error::TryRecvError::Empty) => {
                    std::thread::sleep(pump_wait(&route));
                    continue;
                }
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            }
        };
        match call {
            ActorCall::Message {
                operation,
                text,
                bot_id,
                attachments,
                reply,
            } => accept_message(
                &mut actor,
                &mut inbox,
                operation,
                &text,
                &bot_id,
                &attachments,
                reply,
            ),
            other => dispatch(&mut actor, other),
        }
    }
}

fn pump_wait(route: &Option<LiveRoute>) -> Duration {
    if let Some(route) = route
        && route.inflight.is_none()
        && let Some(until) = route.pause_until
    {
        let now = Instant::now();
        if until > now {
            return until.saturating_duration_since(now);
        }
    }
    Duration::from_millis(15)
}

fn accept_message<R: RouterPort>(
    actor: &mut Actor<R>,
    inbox: &mut VecDeque<QueuedChat>,
    operation: SubmissionId,
    text: &str,
    bot_id: &str,
    attachments: &[crate::orchestrator::StagedAttachment],
    reply: oneshot::Sender<Result<Value, ApiError>>,
) {
    install_from_store(&mut actor.host, &actor.mcp_secrets);
    actor.host.set_next_bot(bot_id);
    let accepted = match actor.host.admit_fast(&operation, text, attachments) {
        Ok(FastAdmission::Immediate(admission)) => Ok(submission_value(admission)),
        Ok(FastAdmission::Queued(queued)) => {
            let pending = submission_value(SubmissionAdmission::Pending {
                message: queued.message.clone(),
            });
            inbox.push_back(queued);
            Ok(pending)
        }
        Err(error) => Err(map_submission_orchestrator(error)),
    };
    let _ = reply.send(accepted);
}

fn pump<R>(
    actor: &mut Actor<R>,
    inbox: &mut VecDeque<QueuedChat>,
    route: &mut Option<LiveRoute>,
    workers: &mut Vec<LiveWorker>,
) where
    R: RouterPort + Clone + Send + 'static,
{
    loop {
        poll_route(actor, route);
        poll_workers(actor, workers);
        let started = start_ready_workers(actor, workers);
        if route.is_some() {
            return;
        }
        if let Some(queued) = inbox.pop_front() {
            *route = begin_route(actor, queued);
            if route.is_some() {
                return;
            }
            continue;
        }
        if started {
            continue;
        }
        return;
    }
}

fn begin_route<R>(actor: &mut Actor<R>, queued: QueuedChat) -> Option<LiveRoute>
where
    R: RouterPort + Clone + Send + 'static,
{
    let operation = queued.operation.clone();
    let mut live = match actor
        .host
        .open_route(queued.message, &queued.text, &queued.attachments)
    {
        Ok(machine) => LiveRoute {
            operation: operation.clone(),
            machine,
            inflight: None,
            pause_until: None,
        },
        Err(outcome) => {
            settle_route(actor, &operation, outcome);
            return None;
        }
    };
    if advance_route(actor, &mut live, RouteEvent::Start) {
        Some(live)
    } else {
        None
    }
}

/// Returns true while the route still needs another pump.
fn advance_route<R>(actor: &mut Actor<R>, live: &mut LiveRoute, event: RouteEvent) -> bool
where
    R: RouterPort + Clone + Send + 'static,
{
    match actor.host.drive_route(&mut live.machine, event) {
        crate::orchestrator::RouteDrive::Await(request) => {
            live.inflight = Some(actor.host.spawn_model_call(request));
            true
        }
        crate::orchestrator::RouteDrive::Pause(duration) => {
            live.pause_until = Some(Instant::now() + duration);
            true
        }
        crate::orchestrator::RouteDrive::Done(outcome) => {
            let operation = live.operation.clone();
            settle_route(actor, &operation, outcome);
            false
        }
    }
}

fn poll_route<R>(actor: &mut Actor<R>, route: &mut Option<LiveRoute>)
where
    R: RouterPort + Clone + Send + 'static,
{
    let Some(live) = route else {
        return;
    };
    let event = if let Some(receiver) = live.inflight.as_ref() {
        match receiver.try_recv() {
            Ok(result) => {
                live.inflight = None;
                Some(RouteEvent::Model(result))
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => None,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                live.inflight = None;
                Some(RouteEvent::Model(Err(RouterError::Protocol {
                    detail: "model thread stopped".to_owned(),
                })))
            }
        }
    } else if live.pause_until.is_some_and(|until| Instant::now() >= until) {
        live.pause_until = None;
        Some(RouteEvent::Resumed)
    } else {
        None
    };
    let Some(event) = event else {
        return;
    };
    if !advance_route(actor, live, event) {
        *route = None;
    }
}

fn start_ready_workers<R>(actor: &mut Actor<R>, workers: &mut Vec<LiveWorker>) -> bool
where
    R: RouterPort + Clone + Send + 'static,
{
    let tasks = actor.host.take_background_tasks();
    if tasks.is_empty() {
        return false;
    }
    for task in tasks {
        let Ok(machine) =
            actor
                .host
                .open_worker(&task, WorkerAttempts::UntilAnswer, OwnerNotice::Chat)
        else {
            continue;
        };
        let mut live = LiveWorker {
            machine,
            inflight: None,
            tool: None,
            waiting_tool: None,
        };
        if advance_worker(actor, &mut live, WorkerEvent::Start) {
            workers.push(live);
        }
    }
    true
}

fn advance_worker<R>(actor: &mut Actor<R>, live: &mut LiveWorker, event: WorkerEvent) -> bool
where
    R: RouterPort + Clone + Send + 'static,
{
    match actor.host.drive_worker(&mut live.machine, event) {
        crate::orchestrator::WorkerDrive::Await(request) => {
            live.inflight = Some(actor.host.spawn_model_call(request));
            true
        }
        crate::orchestrator::WorkerDrive::Tool(job) => launch_tool(actor, live, job),
        crate::orchestrator::WorkerDrive::Done(_) => false,
    }
}

fn launch_tool<R>(actor: &mut Actor<R>, live: &mut LiveWorker, job: ToolJob) -> bool
where
    R: RouterPort + Clone + Send + 'static,
{
    match actor.host.spawn_tool_job(&job) {
        ToolStart::Started(receiver) => {
            live.tool = Some(receiver);
            true
        }
        ToolStart::Busy => {
            live.waiting_tool = Some(job);
            true
        }
        ToolStart::Done(reply) => advance_worker(actor, live, WorkerEvent::Tool(reply)),
    }
}

fn tool_stopped() -> McpToolReply {
    McpToolReply {
        sent: false,
        completed: false,
        text: "The tool thread stopped.".to_owned(),
        image_png_base64: None,
    }
}

fn poll_workers<R>(actor: &mut Actor<R>, workers: &mut Vec<LiveWorker>)
where
    R: RouterPort + Clone + Send + 'static,
{
    let mut index = 0;
    while index < workers.len() {
        if workers[index].tool.is_none()
            && let Some(job) = workers[index].waiting_tool.take()
        {
            if !launch_tool(actor, &mut workers[index], job) {
                workers.swap_remove(index);
                continue;
            }
        }
        let event = if let Some(receiver) = workers[index].tool.as_ref() {
            match receiver.try_recv() {
                Ok(parcel) => {
                    workers[index].tool = None;
                    let reply = actor.host.accept_tool_parcel(parcel);
                    Some(WorkerEvent::Tool(reply))
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => None,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    workers[index].tool = None;
                    Some(WorkerEvent::Tool(tool_stopped()))
                }
            }
        } else if let Some(receiver) = workers[index].inflight.as_ref() {
            match receiver.try_recv() {
                Ok(result) => {
                    workers[index].inflight = None;
                    Some(WorkerEvent::Model(result))
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => None,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    workers[index].inflight = None;
                    Some(WorkerEvent::Model(Err(RouterError::Protocol {
                        detail: "model thread stopped".to_owned(),
                    })))
                }
            }
        } else {
            None
        };
        let Some(event) = event else {
            index += 1;
            continue;
        };
        if advance_worker(actor, &mut workers[index], event) {
            index += 1;
        } else {
            workers.swap_remove(index);
        }
    }
}

fn settle_route<R: RouterPort>(
    actor: &mut Actor<R>,
    operation: &SubmissionId,
    outcome: MessageOutcome,
) {
    match outcome {
        MessageOutcome::Routed(outcome) => {
            if let Some(task) = outcome.task.clone()
                && actor.host.tools().pending_parent() > 0
                && actor.host.step_parent(&task).is_err()
            {
                actor.host.record_processing_failure();
                let _ = actor.host.finish_submission(
                    operation,
                    outcome.message,
                    AdmittedOutcome::ProcessingFailed,
                );
                return;
            }
            if publish(actor).is_err() {
                actor.host.record_processing_failure();
                let _ = actor.host.finish_submission(
                    operation,
                    outcome.message,
                    AdmittedOutcome::ProcessingFailed,
                );
                return;
            }
            let route = match outcome.admitted {
                AdmittedRoute::Admit(_) => RoutedOutcome::Admit,
                AdmittedRoute::AskUser { .. } => RoutedOutcome::Ask,
                AdmittedRoute::Refuse { .. } => RoutedOutcome::Refuse,
            };
            let _ = actor.host.finish_submission(
                operation,
                outcome.message,
                AdmittedOutcome::Routed(route),
            );
        }
        MessageOutcome::RoutingFailed {
            message, reason, ..
        } => {
            let _ = actor.host.finish_submission(
                operation,
                message,
                AdmittedOutcome::RoutingFailed(reason),
            );
        }
        MessageOutcome::ProcessingFailed { message, .. } => {
            let _ = actor.host.finish_submission(
                operation,
                message,
                AdmittedOutcome::ProcessingFailed,
            );
        }
    }
}

fn dispatch<R: RouterPort>(actor: &mut Actor<R>, call: ActorCall) {
    match call {
        ActorCall::Message {
            operation,
            text,
            bot_id,
            attachments,
            reply,
        } => {
            let _ = reply.send(message(actor, &operation, &text, &bot_id, &attachments));
        }
        ActorCall::Bot { request, reply } => {
            let saved = actor
                .host
                .store()
                .bots(request)
                .map(bot_response_json)
                .map_err(map_bot);
            let _ = reply.send(saved);
        }
        ActorCall::SaveAttachment { write, reply } => {
            let saved = actor
                .host
                .save_attachment(write)
                .map(|()| serde_json::json!({ "status": "stored" }))
                .map_err(map_orchestrator);
            let _ = reply.send(saved);
        }
        ActorCall::DeleteAttachment {
            attachment_id,
            reply,
        } => {
            let deleted = actor
                .host
                .delete_attachment(&attachment_id)
                .map(|removed| {
                    serde_json::json!({
                        "relative_path": removed.relative_path,
                        "remove_file": removed.remove_file,
                    })
                })
                .map_err(map_approval);
            let _ = reply.send(deleted);
        }
        ActorCall::Read { kind, reply } => {
            if matches!(kind, ReadKind::Sidebar) {
                let _ = actor.host.expire_approvals(unix_now());
            }
            let _ = reply.send(read(actor, kind));
        }
        ActorCall::Pin {
            task_id,
            pin,
            reply,
        } => {
            let _ = reply.send(pin_task(actor, &task_id, pin));
        }
        ActorCall::Detail {
            task_id,
            view,
            reply,
        } => {
            let _ = reply.send(detail_view(actor, &task_id, view));
        }
        ActorCall::Reference { task_id, reply } => {
            let _ = reply.send(reference(actor, &task_id));
        }
        ActorCall::Host { command, reply } => {
            let _ = reply.send(host_command(actor, command));
        }
        ActorCall::DecideApproval {
            approval_id,
            decision,
            reply,
        } => {
            let _ = reply.send(decide_approval(actor, &approval_id, decision));
        }
        ActorCall::SaveModel { write, reply } => {
            let _ = reply.send(save_model(actor, write));
        }
        ActorCall::ResolveTest { request, reply } => {
            let _ = reply.send(resolve_test(actor, request));
        }
        ActorCall::BrainMap {
            include_lexemes,
            reply,
        } => {
            let _ = reply.send(read_brain(actor, include_lexemes));
        }
        ActorCall::BrainSearch { query, reply } => {
            let _ = reply.send(search_brain(actor, &query));
        }
        ActorCall::EditClaim {
            claim_id,
            sentence,
            reply,
        } => {
            let _ = reply.send(edit_claim(actor, claim_id, sentence));
        }
        ActorCall::ForgetClaim { claim_id, reply } => {
            let _ = reply.send(forget_claim(actor, claim_id));
        }
        ActorCall::RestoreClaim { claim_id, reply } => {
            let _ = reply.send(restore_claim(actor, claim_id));
        }
        ActorCall::MergeEntities {
            winner,
            loser,
            reply,
        } => {
            let _ = reply.send(merge_entities(actor, winner, loser));
        }
        ActorCall::BrainIndex { reply } => {
            let _ = reply.send(read_brain_index(actor));
        }
        ActorCall::ExportBrain { reply } => {
            let _ = reply.send(export_brain(actor));
        }
        ActorCall::ReviseFact {
            fact_id,
            sentence,
            reply,
        } => {
            let _ = reply.send(revise_brain_fact(actor, fact_id, sentence));
        }
        ActorCall::DeleteFact { fact_id, reply } => {
            let _ = reply.send(delete_brain_fact(actor, fact_id));
        }
        ActorCall::Mcp { action, reply } => {
            let _ = reply.send(mcp_action(actor, action));
        }
    }
}

fn mcp_action<R: RouterPort>(actor: &mut Actor<R>, action: McpAction) -> Result<Value, ApiError> {
    let store = actor.host.store();
    let secrets = actor.mcp_secrets.as_ref();
    let result = match action {
        McpAction::Create(body) => create_connection(store, secrets, &body),
        McpAction::Replace { id, body } => replace_connection(store, secrets, &id, &body),
        McpAction::Rename { id, body } => rename_connection(store, secrets, &id, &body),
        McpAction::Delete { id } => delete_connection(store, secrets, &id),
        McpAction::Refresh { id } => refresh_connection(store, secrets, &id),
        McpAction::Admit { id, body } => admit_connection(store, secrets, &id, &body),
        McpAction::Revoke { id } => revoke_connection(store, secrets, &id),
    };
    if result.is_ok() {
        install_from_store(&mut actor.host, &actor.mcp_secrets);
    }
    result.map_err(map_mcp)
}

fn map_mcp(error: McpApiError) -> ApiError {
    match error {
        McpApiError::Invalid => ApiError::InvalidMcp,
        McpApiError::NotFound => ApiError::UnknownMcp,
        McpApiError::Conflict => ApiError::CommandRejected,
        McpApiError::Store => ApiError::Store,
        McpApiError::Secret => ApiError::McpSecret,
    }
}

fn stored_model_view(
    model: &ModelHub,
    row: Option<ModelConnectionRecord>,
) -> Result<Value, ApiError> {
    let models = model.models();
    match row {
        Some(row) => {
            let reasoning = parse_reasoning_effort(&row.reasoning).map_err(|_| ApiError::Store)?;
            let mut stored = model
                .inner
                .keys
                .read_key()
                .map_err(|_| ApiError::ModelKey)?;
            let key_set = stored.is_some();
            if let Some(secret) = stored.as_mut() {
                wipe(secret);
            }
            Ok(connection_json(
                &PublicModelConnection {
                    base_url: row.base_url,
                    key_set,
                    model: row.model_id,
                    reasoning,
                },
                &models,
            ))
        }
        None => Ok(connection_json(&model.inner.fallback, &models)),
    }
}

fn save_model<R: RouterPort>(
    actor: &mut Actor<R>,
    write: ModelConnectionWrite,
) -> Result<Value, ApiError> {
    let ModelConnectionWrite {
        base_url,
        model,
        reasoning,
        key,
    } = write;
    let stored = actor
        .model
        .inner
        .keys
        .read_key()
        .map_err(|_| ApiError::ModelKey)?;
    let boot = actor
        .model
        .inner
        .boot_key
        .lock()
        .map_err(|_| ApiError::ModelKey)?;
    let mut api_key =
        resolve_key(key, stored, boot.as_deref()).map_err(|_| ApiError::InvalidModelConnection)?;
    drop(boot);
    if let Err(error) = actor.model.inner.keys.write_key(&api_key) {
        wipe(&mut api_key);
        return Err(match error {
            ModelKeyError::Empty => ApiError::InvalidModelConnection,
            ModelKeyError::Unavailable => ApiError::ModelKey,
        });
    }
    let record = ModelConnectionRecord {
        base_url: base_url.clone(),
        model_id: model.clone(),
        reasoning: reasoning_name(reasoning).to_owned(),
    };
    if let Err(error) = actor.host.store().put_model_connection(record) {
        wipe(&mut api_key);
        return Err(match error {
            StoreError::InvalidRequest { .. } => ApiError::InvalidModelConnection,
            _ => ApiError::Store,
        });
    }
    actor.host.set_router_model(model.clone(), reasoning);
    if let Some(install) = &actor.model.inner.install {
        let router = match router_from_connection(&base_url, &api_key, &model) {
            Ok(router) => router,
            Err(_) => {
                wipe(&mut api_key);
                return Err(ApiError::InvalidModelConnection);
            }
        };
        if install.blocking_send(router).is_err() {
            wipe(&mut api_key);
            return Err(ApiError::Session);
        }
    }
    wipe(&mut api_key);
    if let Ok(mut boot_key) = actor.model.inner.boot_key.lock() {
        if let Some(secret) = boot_key.as_mut() {
            wipe(secret);
        }
        *boot_key = None;
    }
    let row = actor
        .host
        .store()
        .model_connection()
        .map_err(|_| ApiError::Store)?;
    stored_model_view(&actor.model, row)
}

fn resolve_test<R: RouterPort>(
    actor: &Actor<R>,
    request: ModelTestRequest,
) -> Result<(String, String), ApiError> {
    let stored = actor
        .model
        .inner
        .keys
        .read_key()
        .map_err(|_| ApiError::ModelKey)?;
    let boot = actor
        .model
        .inner
        .boot_key
        .lock()
        .map_err(|_| ApiError::ModelKey)?;
    let key = resolve_key(request.key, stored, boot.as_deref())
        .map_err(|_| ApiError::InvalidModelConnection)?;
    Ok((request.base_url, key))
}

fn message<R: RouterPort>(
    actor: &mut Actor<R>,
    operation: &SubmissionId,
    text: &str,
    bot_id: &str,
    attachments: &[crate::orchestrator::StagedAttachment],
) -> Result<Value, ApiError> {
    install_from_store(&mut actor.host, &actor.mcp_secrets);
    actor.host.set_next_bot(bot_id);
    let admission = drive(
        actor
            .host
            .handle_submission_attached(operation, text, attachments),
    )
    .map_err(map_submission_orchestrator)?;
    let outcome = match admission {
        SubmissionAdmission::NewRouted(outcome) => outcome,
        terminal => return Ok(submission_value(terminal)),
    };
    if let Some(task) = outcome.task.clone()
        && actor.host.tools().pending_parent() > 0
        && actor.host.step_parent(&task).is_err()
    {
        actor.host.record_processing_failure();
        return Ok(submission_value(actor.host.finish_submission(
            operation,
            outcome.message,
            AdmittedOutcome::ProcessingFailed,
        )));
    }
    if publish(actor).is_err() {
        actor.host.record_processing_failure();
        return Ok(submission_value(actor.host.finish_submission(
            operation,
            outcome.message,
            AdmittedOutcome::ProcessingFailed,
        )));
    }
    let route = match outcome.admitted {
        AdmittedRoute::Admit(_) => RoutedOutcome::Admit,
        AdmittedRoute::AskUser { .. } => RoutedOutcome::Ask,
        AdmittedRoute::Refuse { .. } => RoutedOutcome::Refuse,
    };
    Ok(submission_value(actor.host.finish_submission(
        operation,
        outcome.message,
        AdmittedOutcome::Routed(route),
    )))
}

fn submission_value(admission: SubmissionAdmission) -> Value {
    match admission {
        SubmissionAdmission::Terminal { message, outcome } => match outcome {
            AdmittedOutcome::Routed(route) => {
                let route = routed_outcome_code(route);
                serde_json::json!({
                    "admitted": route,
                    "admission": "admitted",
                    "message_id": message.0,
                    "outcome": {
                        "kind": "routed",
                        "route": route,
                    },
                })
            }
            AdmittedOutcome::RoutingFailed(reason) => serde_json::json!({
                "admission": "admitted",
                "message_id": message.0,
                "outcome": {
                    "kind": "routing_failed",
                    "reason": reason.code(),
                },
            }),
            AdmittedOutcome::ProcessingFailed => serde_json::json!({
                "admission": "admitted",
                "message_id": message.0,
                "outcome": {
                    "kind": "processing_failed",
                    "reason": "processing_unavailable",
                },
            }),
            AdmittedOutcome::Unknown => serde_json::json!({
                "admission": "admitted",
                "message_id": message.0,
                "outcome": {
                    "kind": "unknown_outcome",
                },
            }),
        },
        SubmissionAdmission::Pending { message } => serde_json::json!({
            "admission": "admitted",
            "message_id": message.0,
            "outcome": {
                "kind": "processing_pending",
                "reason": "processing_pending",
            },
        }),
        SubmissionAdmission::NewRouted(_) => {
            serde_json::json!({"error": "session_unavailable"})
        }
    }
}

fn routed_outcome_code(outcome: RoutedOutcome) -> &'static str {
    match outcome {
        RoutedOutcome::Admit => "admit",
        RoutedOutcome::Ask => "ask",
        RoutedOutcome::Refuse => "refuse",
    }
}

fn read<R: RouterPort>(actor: &Actor<R>, kind: ReadKind) -> Result<Value, ApiError> {
    match kind {
        ReadKind::Task { task_id } => {
            accept_task_id(&task_id)?;
            actor
                .host
                .read_inspection(&task_id)
                .map_err(map_orchestrator)
        }
        ReadKind::Sidebar => sidebar_value(&open_read(&actor.database)?, None),
        ReadKind::Inspector => inspector_value(&open_read(&actor.database)?),
    }
}

fn pin_task<R: RouterPort>(
    actor: &mut Actor<R>,
    task_id: &str,
    pin: PinMark,
) -> Result<Value, ApiError> {
    accept_task_id(task_id)?;
    let stored = match pin {
        PinMark::Pinned => "pinned",
        PinMark::Unpinned => "unpinned",
    };
    actor
        .host
        .store()
        .set_pin(task_id, stored)
        .map_err(map_store)?;
    publish_best_effort(actor);
    Ok(serde_json::json!({ "pin": stored }))
}

fn detail_view<R: RouterPort>(
    actor: &mut Actor<R>,
    task_id: &str,
    view: ViewCommand,
) -> Result<Value, ApiError> {
    accept_task_id(task_id)?;
    let connection = open_read(&actor.database)?;
    let current = load_view(&connection, task_id)?;
    let next = match view {
        ViewCommand::Open => {
            let detail = actor.ids.detail().map_err(|_| ApiError::Session)?;
            let detail_id = format!("detail-{detail}");
            reduce_completion_view(
                &current,
                &CompletionViewEvent::Open {
                    detail: DetailSessionId(detail_id),
                },
            )
            .map_err(map_view_open)?
        }
        ViewCommand::Close => reduce_completion_view(&current, &CompletionViewEvent::Close)
            .map_err(|_| ApiError::DetailNotOpen)?,
    };
    let stored = encode_view(&next);
    actor
        .host
        .store()
        .set_completion_view(task_id, &stored)
        .map_err(map_store)?;
    if matches!(view, ViewCommand::Open) {
        let detail = actor.ids.detail().map_err(|_| ApiError::Session)?;
        actor
            .ids
            .consume_detail(detail)
            .map_err(|_| ApiError::Session)?;
    }
    publish_best_effort(actor);
    Ok(serde_json::json!({ "view": view_name(&next) }))
}

fn reference<R: RouterPort>(actor: &Actor<R>, task_id: &str) -> Result<Value, ApiError> {
    accept_task_id(task_id)?;
    let connection = open_read(&actor.database)?;
    if !task_exists(&connection, task_id)? {
        return Err(ApiError::UnknownTask);
    }
    Ok(serde_json::json!({ "composer_insert": format!("task:{task_id} ") }))
}

fn host_command<R: RouterPort>(actor: &mut Actor<R>, command: WireHost) -> Result<Value, ApiError> {
    let command = match command {
        WireHost::Retry { task_id } => return retry_host(actor, &task_id),
        command => command,
    };
    let all = matches!(command, WireHost::StopAll);
    let intent = wire_host_intent(command)?;
    match actor.host.preflight_host_intent(&intent) {
        Ok(()) => {}
        Err(OrchestratorError::UnknownTask) if all => return Err(ApiError::CommandRejected),
        Err(error) => return Err(map_orchestrator(error)),
    }
    let allocated = allocate_host(actor, intent)?;
    let phase = match actor.host.apply_host_command(allocated.command) {
        Ok(phase) => phase,
        Err(OrchestratorError::UnknownTask) if all => return Err(ApiError::CommandRejected),
        Err(error) => return Err(map_orchestrator(error)),
    };
    actor
        .host
        .consume_command_id(allocated.command_id)
        .map_err(map_orchestrator)?;
    if allocated.consumes_decision {
        let decision = actor.ids.decision().map_err(|_| ApiError::Session)?;
        actor
            .ids
            .consume_decision(decision)
            .map_err(|_| ApiError::Session)?;
    }
    publish_best_effort(actor);
    Ok(serde_json::json!({ "phase": phase_name(&phase) }))
}

fn retry_host<R: RouterPort>(actor: &mut Actor<R>, task_id: &str) -> Result<Value, ApiError> {
    accept_task_id(task_id)?;
    let phase = actor
        .host
        .retry_task(&TaskId(task_id.to_owned()))
        .map_err(map_orchestrator)?;
    publish_best_effort(actor);
    Ok(serde_json::json!({ "phase": phase_name(&phase) }))
}

fn wire_host_intent(command: WireHost) -> Result<HostIntent, ApiError> {
    match command {
        WireHost::Stop { task_id } => {
            accept_task_id(&task_id)?;
            Ok(HostIntent::Stop {
                task: TaskId(task_id),
            })
        }
        WireHost::StopAll => Ok(HostIntent::StopAll),
        WireHost::Cancel { task_id } => {
            accept_task_id(&task_id)?;
            Ok(HostIntent::Cancel {
                task: TaskId(task_id),
            })
        }
        WireHost::Abandon { task_id } => {
            accept_task_id(&task_id)?;
            Ok(HostIntent::Abandon {
                task: TaskId(task_id),
            })
        }
        WireHost::Retry { .. } => Err(ApiError::UnknownCommand),
    }
}

struct AllocatedHost {
    command: HostCommand,
    command_id: maia_core::super_agent::CommandId,
    consumes_decision: bool,
}

fn allocate_host<R: RouterPort>(
    actor: &Actor<R>,
    intent: HostIntent,
) -> Result<AllocatedHost, ApiError> {
    let command_id = actor.host.next_command_id().map_err(map_orchestrator)?;
    let (command, consumes_decision) = match intent {
        HostIntent::Stop { task } => (
            HostCommand::Stop {
                task,
                command: command_id,
            },
            false,
        ),
        HostIntent::StopAll => (
            HostCommand::StopAll {
                command: command_id,
            },
            false,
        ),
        HostIntent::Cancel { task } => (
            HostCommand::Cancel {
                task,
                command: command_id,
            },
            false,
        ),
        HostIntent::Abandon { task } => (
            HostCommand::Abandon {
                task,
                decision: DecisionId(format!(
                    "decision-{}",
                    actor.ids.decision().map_err(|_| ApiError::Session)?
                )),
                command: command_id,
            },
            true,
        ),
    };
    Ok(AllocatedHost {
        command,
        command_id,
        consumes_decision,
    })
}

fn publish<R: RouterPort>(actor: &Actor<R>) -> Result<(), ApiError> {
    publish_database(&actor.database, actor.publication.as_ref())
}

fn publish_database(
    database: &FsPath,
    publication: &dyn SidebarPublication,
) -> Result<(), ApiError> {
    let connection = open_read(database)?;
    let value = sidebar_value(&connection, None)?;
    let text = serde_json::to_string(&value).map_err(|_| ApiError::Session)?;
    publication.publish(&text).map_err(|_| ApiError::Session)
}

fn publish_best_effort<R: RouterPort>(actor: &Actor<R>) {
    let _ = publish(actor);
}

fn listener_class(request: &Request) -> Option<ListenerClass> {
    request.extensions().get::<ListenerClass>().copied()
}

fn desktop_only(request: &Request) -> bool {
    listener_class(request) == Some(ListenerClass::Loopback)
}

async fn read_remote_body(request: Request) -> Option<Value> {
    let Ok(bytes) = axum::body::to_bytes(request.into_body(), MAX_HTTP_BODY).await else {
        return None;
    };
    serde_json::from_slice(&bytes).ok()
}

async fn remote_status(State(state): State<AppState>, request: Request) -> Response {
    let now = unix_now();
    match listener_class(&request) {
        Some(ListenerClass::Loopback) => desktop_status_response(&state.remote, now),
        Some(ListenerClass::Tailnet) => {
            let Some(peer) = request.extensions().get::<TailnetPeer>() else {
                return remote_error(403, "denied");
            };
            phone_status_response(&state.remote, &peer.0)
        }
        None => remote_error(403, "denied"),
    }
}

async fn remote_enable(State(state): State<AppState>, request: Request) -> Response {
    if !desktop_only(&request) {
        return remote_error(403, "desktop_only");
    }
    let acknowledged = read_remote_body(request).await.and_then(|body| {
        body.get("acknowledge_certificate_publication")
            .and_then(Value::as_bool)
    }) == Some(true);
    enable_response(&state.remote, acknowledged)
}

async fn remote_pairing_code(State(state): State<AppState>, request: Request) -> Response {
    if !desktop_only(&request) {
        return remote_error(403, "desktop_only");
    }
    code_response(&state.remote, unix_now())
}

async fn remote_pair(State(state): State<AppState>, request: Request) -> Response {
    let Some(peer) = request.extensions().get::<TailnetPeer>().cloned() else {
        return remote_error(403, "denied");
    };
    let code = read_remote_body(request)
        .await
        .and_then(|body| body.get("code").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    pair_response(&state.remote, &peer.0, &code, unix_now())
}

async fn remote_session(State(state): State<AppState>, request: Request) -> Response {
    let Some(peer) = request.extensions().get::<TailnetPeer>() else {
        return remote_error(403, "denied");
    };
    session_response(&state.remote, &peer.0, unix_now())
}

async fn remote_unpair(State(state): State<AppState>, request: Request) -> Response {
    let class = listener_class(&request);
    let peer = request.extensions().get::<TailnetPeer>().cloned();
    let Some(body) = read_remote_body(request).await else {
        return remote_error(400, "invalid_json");
    };
    let Some(node_id) = body.get("node_id").and_then(Value::as_str) else {
        return remote_error(400, "invalid_json");
    };
    let actor = match class {
        Some(ListenerClass::Loopback) => UnpairActor::Desktop,
        Some(ListenerClass::Tailnet) => {
            let Some(peer) = peer else {
                return remote_error(403, "denied");
            };
            UnpairActor::Phone {
                node_id: peer.0.node_id,
            }
        }
        None => return remote_error(403, "denied"),
    };
    unpair_response(&state.remote, actor, node_id, unix_now())
}

fn app_router(state: AppState, dist: PathBuf) -> Router {
    let api = Router::new()
        .route("/super-agent/sidebar", get(sidebar))
        .route("/super-agent/transcript", get(transcript))
        .route("/bots", get(get_bots).post(post_bot))
        .route("/bots/select", post(post_bot_select))
        .route("/bots/{bot_id}/rename", post(post_bot_rename))
        .route("/bots/{bot_id}/instructions", post(post_bot_instructions))
        .route("/bots/{bot_id}/pin", post(post_bot_pin))
        .route("/bots/{bot_id}/archive", post(post_bot_archive))
        .route("/bots/{bot_id}/delete", post(post_bot_delete))
        .route("/super-agent/inspector", get(inspector))
        .route("/super-agent/messages", post(post_message))
        .route("/super-agent/tasks/{task_id}", get(task))
        .route("/super-agent/tasks/{task_id}/pin", post(post_pin))
        .route("/super-agent/tasks/{task_id}/detail", post(post_detail))
        .route(
            "/super-agent/tasks/{task_id}/reference",
            post(post_reference),
        )
        .route("/super-agent/host-command", post(post_host))
        .route("/super-agent/approvals/{approval_id}", post(post_approval))
        .route(
            "/super-agent/model-connection",
            get(get_model).put(put_model),
        )
        .route("/super-agent/model-connection/test", post(test_model))
        .route("/super-agent/mcp", get(get_mcp).post(post_mcp))
        .route("/super-agent/mcp/{id}", put(put_mcp).delete(delete_mcp))
        .route("/super-agent/mcp/{id}/label", post(post_mcp_label))
        .route("/super-agent/mcp/{id}/list", post(post_mcp_list))
        .route("/super-agent/mcp/{id}/admit", post(post_mcp_admit))
        .route("/super-agent/mcp/{id}/revoke", post(post_mcp_revoke))
        .route("/super-agent/ws", get(websocket))
        .route("/remote/status", get(remote_status))
        .route("/remote/enable", post(remote_enable))
        .route("/remote/pairing-code", post(remote_pairing_code))
        .route("/remote/pair", post(remote_pair))
        .route("/remote/session", get(remote_session))
        .route("/remote/unpair", post(remote_unpair))
        .route("/brain/map", get(brain_map))
        .route("/brain/search", post(brain_search))
        .route("/brain/index", get(brain_index))
        .route("/brain/export", post(export_brain_markdown))
        .route("/brain/claims/{claim_id}", patch(patch_claim))
        .route("/brain/claims/{claim_id}/forget", post(forget_claim_route))
        .route("/brain/claims/{claim_id}/restore", post(restore_claim_route))
        .route("/brain/entities/merge", post(merge_entities_route))
        .route(
            "/brain/facts/{fact_id}",
            patch(patch_fact).delete(delete_fact),
        )
        .fallback(unknown_api)
        .layer(DefaultBodyLimit::max(MAX_HTTP_BODY));
    let uploads = Router::new()
        .route("/super-agent/attachments", post(post_attachment))
        .route(
            "/super-agent/attachments/{attachment_id}",
            get(get_attachment).delete(delete_attachment),
        )
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY));
    Router::new()
        .nest("/api", api.merge(uploads))
        .route_service("/tasks/{task_id}", ServeFile::new(dist.join("index.html")))
        .fallback_service(ServeDir::new(dist))
        .layer(middleware::from_fn(cache_headers))
        .with_state(state)
}

async fn cache_headers(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    if path.starts_with("/api") {
        insert_header(&mut response, header::CACHE_CONTROL, "no-store");
        insert_header(&mut response, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
        return response;
    }
    let html = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/html"));
    if html {
        insert_header(&mut response, header::CACHE_CONTROL, "no-cache");
    }
    response
}

fn insert_header(response: &mut Response, name: header::HeaderName, value: &'static str) {
    if let Ok(header_value) = HeaderValue::from_str(value) {
        response.headers_mut().insert(name, header_value);
    }
}

async fn sidebar(
    State(state): State<AppState>,
    Query(query): Query<BotScope>,
) -> Response {
    let Some(bot) = query.bot else {
        return finish(
            ask(&state, |reply| ActorCall::Read {
                kind: ReadKind::Sidebar,
                reply,
            })
            .await,
        );
    };
    let database = state.database.clone();
    let read = tokio::task::spawn_blocking(move || {
        let connection = open_read(&database)?;
        sidebar_value(&connection, Some(bot.as_str()))
    })
    .await;
    match read {
        Ok(value) => finish(value),
        Err(_) => error_response(ApiError::Session),
    }
}

async fn inspector(State(state): State<AppState>) -> Response {
    finish(
        ask(&state, |reply| ActorCall::Read {
            kind: ReadKind::Inspector,
            reply,
        })
        .await,
    )
}

async fn transcript(
    State(state): State<AppState>,
    Query(query): Query<BotScope>,
) -> Response {
    // Read the committed transcript off the actor. A model call keeps that
    // thread busy, and the phone still needs to see the stored message.
    let database = state.database.clone();
    let activity = state.activity.snapshot();
    let bot = query.bot;
    let read = tokio::task::spawn_blocking(move || {
        let connection = open_read(&database)?;
        let mut value = transcript_value(&connection, bot.as_deref())?;
        value["activity"] = serde_json::to_value(&activity).unwrap_or(Value::Array(Vec::new()));
        Ok(value)
    })
    .await;
    match read {
        Ok(value) => finish(value),
        Err(_) => error_response(ApiError::Session),
    }
}

async fn get_bots(State(state): State<AppState>) -> Response {
    let database = state.database.clone();
    let read = tokio::task::spawn_blocking(move || {
        let (bots, selected) =
            maia_store::read_bot_catalog(&database).map_err(|_| ApiError::Store)?;
        Ok(serde_json::json!({
            "bots": bots.iter().map(bot_json).collect::<Vec<_>>(),
            "selected": selected,
        }))
    })
    .await;
    match read {
        Ok(value) => finish(value),
        Err(_) => error_response(ApiError::Session),
    }
}

async fn post_bot(State(state): State<AppState>, request: Request) -> Response {
    let body = match read_bot_body::<WireBotCreate>(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::Bot {
            request: maia_store::BotRequest::Create {
                name: body.name,
                instructions: body.instructions,
                now: unix_now(),
            },
            reply,
        })
        .await,
    )
}

async fn post_bot_select(State(state): State<AppState>, request: Request) -> Response {
    let body = match read_bot_body::<WireBotSelect>(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::Bot {
            request: maia_store::BotRequest::Select {
                bot_id: body.bot_id,
            },
            reply,
        })
        .await,
    )
}

async fn post_bot_rename(
    State(state): State<AppState>,
    Path(bot_id): Path<String>,
    request: Request,
) -> Response {
    let body = match read_bot_body::<WireBotName>(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, move |reply| ActorCall::Bot {
            request: maia_store::BotRequest::Rename {
                bot_id,
                name: body.name,
                now: unix_now(),
            },
            reply,
        })
        .await,
    )
}

async fn post_bot_instructions(
    State(state): State<AppState>,
    Path(bot_id): Path<String>,
    request: Request,
) -> Response {
    let body = match read_bot_body::<WireBotInstructions>(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, move |reply| ActorCall::Bot {
            request: maia_store::BotRequest::Instructions {
                bot_id,
                instructions: body.instructions,
                now: unix_now(),
            },
            reply,
        })
        .await,
    )
}

async fn post_bot_pin(
    State(state): State<AppState>,
    Path(bot_id): Path<String>,
    request: Request,
) -> Response {
    let body = match read_bot_body::<WireBotPin>(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, move |reply| ActorCall::Bot {
            request: maia_store::BotRequest::Pin {
                bot_id,
                pinned: body.pinned,
                now: unix_now(),
            },
            reply,
        })
        .await,
    )
}

async fn post_bot_archive(
    State(state): State<AppState>,
    Path(bot_id): Path<String>,
    request: Request,
) -> Response {
    let body = match read_bot_body::<WireBotArchive>(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, move |reply| ActorCall::Bot {
            request: maia_store::BotRequest::Archive {
                bot_id,
                archived: body.archived,
                now: unix_now(),
            },
            reply,
        })
        .await,
    )
}

async fn post_bot_delete(State(state): State<AppState>, Path(bot_id): Path<String>) -> Response {
    finish(
        ask(&state, |reply| ActorCall::Bot {
            request: maia_store::BotRequest::Delete { bot_id },
            reply,
        })
        .await,
    )
}

async fn read_bot_body<T>(request: Request) -> Result<T, ApiError>
where
    T: serde::de::DeserializeOwned,
{
    let value = read_json(request).await?;
    serde_json::from_value(value).map_err(|_| ApiError::InvalidJson)
}

fn bot_json(bot: &maia_store::BotRecord) -> Value {
    serde_json::json!({
        "bot_id": bot.bot_id,
        "name": bot.name,
        "color": bot.color,
        "instructions": bot.instructions,
        "pinned": bot.pinned,
        "archived": bot.archived,
        "preview": bot.preview,
        "last_message_at": bot.last_message_at,
        "unread": bot.unread,
        "running": bot.running,
        "status_line": bot.status_line,
    })
}

fn bot_response_json(response: maia_store::BotResponse) -> Value {
    match response {
        maia_store::BotResponse::Bot(bot) => bot_json(&bot),
        maia_store::BotResponse::List(bots) => serde_json::json!({
            "bots": bots.iter().map(bot_json).collect::<Vec<_>>(),
        }),
        maia_store::BotResponse::Text(value) => serde_json::json!({ "selected": value }),
        maia_store::BotResponse::Empty => serde_json::json!({ "status": "stored" }),
        maia_store::BotResponse::Notes(_)
        | maia_store::BotResponse::Provenance(_)
        | maia_store::BotResponse::Transcript(_) => serde_json::json!({ "status": "stored" }),
    }
}

async fn task(State(state): State<AppState>, Path(task_id): Path<String>) -> Response {
    finish(
        ask(&state, |reply| ActorCall::Read {
            kind: ReadKind::Task { task_id },
            reply,
        })
        .await,
    )
}

async fn post_message(State(state): State<AppState>, request: Request) -> Response {
    let (operation, text, bot_id, attachment_ids) = match read_message(request).await {
        Ok(message) => message,
        Err(error) => return error_response(error),
    };
    let attachments = match stage_attachments(&state.database, &attachment_ids) {
        Ok(attachments) => attachments,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::Message {
            operation,
            text,
            bot_id,
            attachments,
            reply,
        })
        .await,
    )
}

async fn post_attachment(State(state): State<AppState>, request: Request) -> Response {
    let (name, media_type, bytes) = match read_upload(request).await {
        Ok(upload) => upload,
        Err(error) => return error_response(error),
    };
    let accepted = match crate::attachment_prompt::accept_upload(&name, &media_type, &bytes) {
        Ok(accepted) => accepted,
        Err(crate::attachment_prompt::UploadReject::TooLarge) => {
            return error_response(ApiError::PayloadTooLarge);
        }
        Err(
            crate::attachment_prompt::UploadReject::Type
            | crate::attachment_prompt::UploadReject::Active,
        ) => {
            return error_response(ApiError::UnsupportedMedia);
        }
        Err(_) => return error_response(ApiError::InvalidMessage),
    };
    let attachment_id = match new_attachment_id() {
        Ok(id) => id,
        Err(error) => return error_response(error),
    };
    let data_dir = match state.database.parent() {
        Some(dir) => dir.to_path_buf(),
        None => return error_response(ApiError::Store),
    };
    let path = match crate::attachment_prompt::attachment_file(&data_dir, &accepted.relative_path) {
        Some(path) => path,
        None => return error_response(ApiError::Store),
    };
    let created = !path.exists();
    if let Some(parent) = path.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return error_response(ApiError::Store);
    }
    if std::fs::write(&path, &bytes).is_err() {
        return error_response(ApiError::Store);
    }
    let write = maia_store::AttachmentWrite {
        attachment_id: attachment_id.clone(),
        content_sha256: accepted.sha256_hex,
        byte_size: i64::try_from(bytes.len()).unwrap_or(i64::MAX),
        media_type: accepted.media_type.to_owned(),
        safe_name: accepted.safe_name.clone(),
        relative_path: accepted.relative_path,
        created_at: unix_now(),
    };
    let saved = ask(&state, |reply| ActorCall::SaveAttachment { write, reply }).await;
    if saved.is_err() && created {
        let _ = std::fs::remove_file(&path);
    }
    match saved {
        Ok(_) => json_response(
            StatusCode::OK,
            serde_json::json!({
                "attachment_id": attachment_id,
                "safe_name": accepted.safe_name,
                "media_type": accepted.media_type,
                "byte_size": bytes.len(),
            }),
        ),
        Err(error) => error_response(error),
    }
}

async fn get_attachment(
    State(state): State<AppState>,
    Path(attachment_id): Path<String>,
) -> Response {
    let loaded = match load_attachment_bytes(&state.database, &attachment_id) {
        Ok(loaded) => loaded,
        Err(error) => return error_response(error),
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, loaded.media_type),
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("inline; filename=\"{}\"", loaded.safe_name),
            ),
        ],
        loaded.bytes,
    )
        .into_response()
}

async fn delete_attachment(
    State(state): State<AppState>,
    Path(attachment_id): Path<String>,
) -> Response {
    let deleted = match ask(&state, |reply| ActorCall::DeleteAttachment {
        attachment_id,
        reply,
    })
    .await
    {
        Ok(value) => value,
        Err(error) => return error_response(error),
    };
    if deleted.get("remove_file").and_then(Value::as_bool) == Some(true)
        && let Some(relative) = deleted.get("relative_path").and_then(Value::as_str)
        && let Some(data_dir) = state.database.parent()
        && let Some(path) = crate::attachment_prompt::attachment_file(data_dir, relative)
    {
        let _ = std::fs::remove_file(path);
    }
    json_response(StatusCode::OK, serde_json::json!({ "status": "deleted" }))
}

async fn post_pin(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    let pin = match read_pin(request).await {
        Ok(pin) => pin,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::Pin {
            task_id,
            pin,
            reply,
        })
        .await,
    )
}

async fn post_detail(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    let view = match read_view(request).await {
        Ok(view) => view,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::Detail {
            task_id,
            view,
            reply,
        })
        .await,
    )
}

async fn post_reference(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(error) = read_object(request).await {
        return error_response(error);
    }
    finish(ask(&state, |reply| ActorCall::Reference { task_id, reply }).await)
}

async fn get_mcp(State(state): State<AppState>) -> Response {
    // The actor is busy for the whole model call. The saved server list is
    // already in SQLite and does not need that thread.
    let database = state.database.clone();
    let secrets = Arc::clone(&state.mcp_secrets);
    let read = tokio::task::spawn_blocking(move || {
        let connection = open_read(&database)?;
        let records = maia_store::read_mcp_connections(&connection).map_err(|_| ApiError::Store)?;
        Ok(records_json(&records, secrets.as_ref()))
    })
    .await;
    match read {
        Ok(value) => finish(value),
        Err(_) => error_response(ApiError::Session),
    }
}

async fn post_mcp(State(state): State<AppState>, request: Request) -> Response {
    let body = match read_json(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::Mcp {
            action: McpAction::Create(body),
            reply,
        })
        .await,
    )
}

async fn put_mcp(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let body = match read_json(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::Mcp {
            action: McpAction::Replace { id, body },
            reply,
        })
        .await,
    )
}

async fn delete_mcp(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    finish(
        ask(&state, |reply| ActorCall::Mcp {
            action: McpAction::Delete { id },
            reply,
        })
        .await,
    )
}

async fn post_mcp_label(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let body = match read_json(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::Mcp {
            action: McpAction::Rename { id, body },
            reply,
        })
        .await,
    )
}

async fn post_mcp_list(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    finish(
        ask(&state, |reply| ActorCall::Mcp {
            action: McpAction::Refresh { id },
            reply,
        })
        .await,
    )
}

async fn post_mcp_admit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let body = match read_json(request).await {
        Ok(body) => body,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::Mcp {
            action: McpAction::Admit { id, body },
            reply,
        })
        .await,
    )
}

async fn post_mcp_revoke(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    finish(
        ask(&state, |reply| ActorCall::Mcp {
            action: McpAction::Revoke { id },
            reply,
        })
        .await,
    )
}

async fn get_model(State(state): State<AppState>) -> Response {
    // The actor is busy for the whole model call. The saved connection is
    // already in SQLite and does not need that thread.
    let database = state.database.clone();
    let model = state.model.clone();
    let read = tokio::task::spawn_blocking(move || {
        let connection = open_read(&database)?;
        let row = maia_store::read_model_connection(&connection).map_err(|_| ApiError::Store)?;
        stored_model_view(&model, row)
    })
    .await;
    match read {
        Ok(value) => finish(value),
        Err(_) => error_response(ApiError::Session),
    }
}

async fn put_model(State(state): State<AppState>, request: Request) -> Response {
    let value = match read_json(request).await {
        Ok(value) => value,
        Err(error) => return error_response(error),
    };
    let write = match parse_model_write(value) {
        Ok(write) => write,
        Err(_) => return error_response(ApiError::InvalidModelConnection),
    };
    finish(ask(&state, |reply| ActorCall::SaveModel { write, reply }).await)
}

async fn test_model(State(state): State<AppState>, request: Request) -> Response {
    let value = match read_json(request).await {
        Ok(value) => value,
        Err(error) => return error_response(error),
    };
    let parsed = match parse_model_test(value) {
        Ok(parsed) => parsed,
        Err(_) => return error_response(ApiError::InvalidModelConnection),
    };
    let (base_url, key) = match ask_resolve(&state, parsed).await {
        Ok(resolved) => resolved,
        Err(error) => return error_response(error),
    };
    let listed = state.list_models.list(base_url, key).await;
    match listed {
        Ok(models) => {
            state.model.remember(&models);
            json_response(StatusCode::OK, serde_json::json!({ "models": models }))
        }
        Err(_) => error_response(ApiError::Provider),
    }
}

async fn ask_resolve(
    state: &AppState,
    request: ModelTestRequest,
) -> Result<(String, String), ApiError> {
    let (tx, rx) = oneshot::channel();
    state
        .commands
        .send(ActorCall::ResolveTest { request, reply: tx })
        .await
        .map_err(|_| ApiError::Session)?;
    rx.await.map_err(|_| ApiError::Session)?
}

async fn post_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
    request: Request,
) -> Response {
    let decision = match read_approval_decision(request).await {
        Ok(decision) => decision,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::DecideApproval {
            approval_id,
            decision,
            reply,
        })
        .await,
    )
}

async fn read_approval_decision(
    request: Request,
) -> Result<maia_store::ApprovalDecision, ApiError> {
    let bytes = axum::body::to_bytes(request.into_body(), MAX_HTTP_BODY)
        .await
        .map_err(|_| ApiError::InvalidJson)?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::InvalidJson)?;
    match value.get("decision").and_then(serde_json::Value::as_str) {
        Some("approve") => Ok(maia_store::ApprovalDecision::Approve),
        Some("deny") => Ok(maia_store::ApprovalDecision::Deny),
        _ => Err(ApiError::UnknownCommand),
    }
}

fn decide_approval<R: RouterPort>(
    actor: &mut Actor<R>,
    approval_id: &str,
    decision: maia_store::ApprovalDecision,
) -> Result<Value, ApiError> {
    if approval_id.is_empty()
        || approval_id.len() > 20
        || !approval_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ApiError::UnknownApproval);
    }
    match actor
        .host
        .decide_approval(approval_id, decision, unix_now())
        .map_err(map_approval)?
    {
        maia_store::ApprovalSettlement::Approved { task_id } => {
            publish_best_effort(actor);
            Ok(serde_json::json!({ "status": "approved", "task_id": task_id }))
        }
        maia_store::ApprovalSettlement::Denied { task_id } => {
            publish_best_effort(actor);
            Ok(serde_json::json!({ "status": "denied", "task_id": task_id }))
        }
        maia_store::ApprovalSettlement::Expired { task_id } => {
            publish_best_effort(actor);
            Ok(serde_json::json!({ "status": "expired", "task_id": task_id }))
        }
        maia_store::ApprovalSettlement::AlreadySettled => Err(ApiError::ApprovalSettled),
    }
}

fn map_approval(error: OrchestratorError) -> ApiError {
    match error {
        OrchestratorError::Store(maia_store::StoreError::NotFound { .. }) => {
            ApiError::UnknownApproval
        }
        _ => map_orchestrator(error),
    }
}

async fn post_host(State(state): State<AppState>, request: Request) -> Response {
    let command = match read_host(request).await {
        Ok(command) => command,
        Err(error) => return error_response(error),
    };
    finish(ask(&state, |reply| ActorCall::Host { command, reply }).await)
}

async fn brain_map(State(state): State<AppState>, Query(query): Query<BrainQuery>) -> Response {
    let include_lexemes = query.include.as_deref() == Some("lexemes");
    finish(ask(&state, |reply| ActorCall::BrainMap { include_lexemes, reply }).await)
}

#[derive(serde::Deserialize)]
struct BrainQuery {
    include: Option<String>,
}

async fn brain_search(State(state): State<AppState>, request: Request) -> Response {
    let value = match read_json(request).await {
        Ok(value) => value,
        Err(error) => return error_response(error),
    };
    let query = value
        .get("query")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    if query.is_empty() {
        return error_response(ApiError::InvalidFact);
    }
    finish(ask(&state, |reply| ActorCall::BrainSearch { query, reply }).await)
}

async fn patch_claim(
    State(state): State<AppState>,
    Path(claim_id): Path<String>,
    request: Request,
) -> Response {
    let sentence = match read_fact_sentence(request).await {
        Ok(sentence) => sentence,
        Err(error) => return error_response(error),
    };
    finish(ask(&state, |reply| ActorCall::EditClaim { claim_id, sentence, reply }).await)
}

async fn forget_claim_route(State(state): State<AppState>, Path(claim_id): Path<String>) -> Response {
    finish(ask(&state, |reply| ActorCall::ForgetClaim { claim_id, reply }).await)
}

async fn restore_claim_route(State(state): State<AppState>, Path(claim_id): Path<String>) -> Response {
    finish(ask(&state, |reply| ActorCall::RestoreClaim { claim_id, reply }).await)
}

async fn merge_entities_route(State(state): State<AppState>, request: Request) -> Response {
    let value = match read_json(request).await {
        Ok(value) => value,
        Err(error) => return error_response(error),
    };
    let winner = value.get("winner").and_then(|item| item.as_str()).unwrap_or("").to_owned();
    let loser = value.get("loser").and_then(|item| item.as_str()).unwrap_or("").to_owned();
    if winner.is_empty() || loser.is_empty() {
        return error_response(ApiError::InvalidFact);
    }
    finish(ask(&state, |reply| ActorCall::MergeEntities { winner, loser, reply }).await)
}

async fn brain_index(State(state): State<AppState>) -> Response {
    finish(ask(&state, |reply| ActorCall::BrainIndex { reply }).await)
}

async fn export_brain_markdown(State(state): State<AppState>) -> Response {
    finish(ask(&state, |reply| ActorCall::ExportBrain { reply }).await)
}

async fn patch_fact(
    State(state): State<AppState>,
    Path(fact_id): Path<String>,
    request: Request,
) -> Response {
    let sentence = match read_fact_sentence(request).await {
        Ok(sentence) => sentence,
        Err(error) => return error_response(error),
    };
    finish(
        ask(&state, |reply| ActorCall::ReviseFact {
            fact_id,
            sentence,
            reply,
        })
        .await,
    )
}

async fn delete_fact(State(state): State<AppState>, Path(fact_id): Path<String>) -> Response {
    finish(ask(&state, |reply| ActorCall::DeleteFact { fact_id, reply }).await)
}

fn read_brain<R: RouterPort>(actor: &Actor<R>, include_lexemes: bool) -> Result<Value, ApiError> {
    actor
        .host
        .store()
        .brain_map()
        .map(|map| brain_map_value(&map, include_lexemes))
        .map_err(map_brain_store)
}

fn search_brain<R: RouterPort>(actor: &Actor<R>, query: &str) -> Result<Value, ApiError> {
    let arms = crate::promotion::recall_run(
        actor.host.store(),
        query,
        maia_core::audit::Timestamp(unix_now()),
        None,
    );
    Ok(serde_json::json!({
        "keyword": arms.keyword,
        "vector": arms.vector,
        "graph": arms.graph,
        "hits": arms.hits.iter().map(|hit| serde_json::json!({
            "id": hit.id,
            "kind": hit.kind,
            "sentence": hit.sentence,
            "arms": hit.arms,
        })).collect::<Vec<_>>(),
    }))
}

fn edit_claim<R: RouterPort>(actor: &Actor<R>, claim_id: String, sentence: String) -> Result<Value, ApiError> {
    let edited = actor
        .host
        .store()
        .edit_claim(claim_id, sentence)
        .map_err(map_brain_store)?;
    Ok(brain_map_value(&edited.value, false))
}

fn forget_claim<R: RouterPort>(actor: &Actor<R>, claim_id: String) -> Result<Value, ApiError> {
    let forgotten = actor
        .host
        .store()
        .forget_claim(claim_id)
        .map_err(map_brain_store)?;
    Ok(brain_map_value(&forgotten.value, false))
}

fn restore_claim<R: RouterPort>(actor: &Actor<R>, claim_id: String) -> Result<Value, ApiError> {
    let restored = actor
        .host
        .store()
        .restore_claim(claim_id)
        .map_err(map_brain_store)?;
    Ok(brain_map_value(&restored.value, false))
}

fn merge_entities<R: RouterPort>(actor: &Actor<R>, winner: String, loser: String) -> Result<Value, ApiError> {
    let merged = actor
        .host
        .store()
        .merge_entities(winner, loser)
        .map_err(map_brain_store)?;
    Ok(brain_map_value(&merged.value, false))
}

fn read_brain_index<R: RouterPort>(actor: &Actor<R>) -> Result<Value, ApiError> {
    actor
        .host
        .store()
        .brain_index()
        .map(|index| brain_index_value(&index))
        .map_err(map_brain_store)
}

fn export_brain<R: RouterPort>(actor: &Actor<R>) -> Result<Value, ApiError> {
    let directory = PathBuf::from("data").join("brain-md");
    actor
        .host
        .store()
        .export_brain_markdown(&directory, unix_now())
        .map_err(map_brain_store)?;
    read_brain_index(actor)
}

fn brain_index_value(index: &maia_store::BrainIndex) -> Value {
    serde_json::json!({
        "exported_at": index.exported_at,
        "neuron_count": index.neuron_count,
        "edge_count": index.edge_count,
        "keyword_count": index.keyword_count,
        "vector_count": index.vector_count,
        "graph_count": index.graph_count,
        "directory": index.directory,
    })
}

fn revise_brain_fact<R: RouterPort>(
    actor: &Actor<R>,
    fact_id: String,
    sentence: String,
) -> Result<Value, ApiError> {
    let revised = actor
        .host
        .store()
        .revise_fact(FactRevise {
            fact_id,
            lexemes: owner_fact_lexemes(&sentence),
            sentence,
        })
        .map_err(map_brain_store)?;
    Ok(brain_map_value(&revised.value, false))
}

fn delete_brain_fact<R: RouterPort>(actor: &Actor<R>, fact_id: String) -> Result<Value, ApiError> {
    let deleted = actor
        .host
        .store()
        .delete_fact(&fact_id)
        .map_err(map_brain_store)?;
    Ok(brain_map_value(&deleted.value, false))
}

fn map_brain_store(error: StoreError) -> ApiError {
    match error {
        StoreError::NotFound { .. } => ApiError::UnknownFact,
        StoreError::InvalidRequest { .. } | StoreError::ResourceLimit(_) => ApiError::InvalidFact,
        _ => ApiError::Store,
    }
}

fn owner_fact_policy() -> LexicalPolicy {
    LexicalPolicy {
        stopwords: BTreeSet::from([
            "a".to_owned(),
            "an".to_owned(),
            "is".to_owned(),
            "of".to_owned(),
            "on".to_owned(),
            "the".to_owned(),
            "this".to_owned(),
        ]),
        fan_out: BTreeMap::new(),
        high_fan_cutoff: u32::MAX,
    }
}

fn owner_fact_lexemes(sentence: &str) -> Vec<String> {
    lexemes_for_sentence(sentence, &owner_fact_policy())
        .into_iter()
        .map(|lexeme| lexeme.as_str().to_owned())
        .collect()
}

fn brain_map_value(map: &BrainMap, include_lexemes: bool) -> Value {
    let hidden_node = |node: &BrainNode| {
        node.detail.hidden_reason.is_some() || node.detail.status.as_deref() == Some("superseded")
    };
    let lexeme = |node: &BrainNode| node.kind.as_str() == "lexeme";
    let mut nodes = Vec::new();
    let mut hidden = Vec::new();
    let mut hidden_ids = std::collections::BTreeSet::new();
    for node in &map.nodes {
        if !include_lexemes && lexeme(node) {
            continue;
        }
        if hidden_node(node) {
            hidden_ids.insert(node.id.clone());
            hidden.push(brain_node_value(node));
        } else {
            nodes.push(brain_node_value(node));
        }
    }
    let edges = map
        .edges
        .iter()
        .filter(|edge| {
            if !include_lexemes && (edge.from_kind == "lexeme" || edge.to_kind == "lexeme") {
                return false;
            }
            !hidden_ids.contains(&edge.from_id) && !hidden_ids.contains(&edge.to_id)
        })
        .map(brain_edge_value)
        .collect::<Vec<_>>();
    let mut value = serde_json::json!({ "nodes": nodes, "edges": edges });
    if !hidden.is_empty() {
        value["hidden"] = serde_json::Value::Array(hidden);
    }
    value
}

fn brain_node_value(node: &BrainNode) -> Value {
    let taint = if node.detail.owner_edited {
        Some("owner".to_owned())
    } else {
        node.taint.clone()
    };
    serde_json::json!({
        "id": node.id,
        "kind": node.kind.as_str(),
        "label": node.label,
        "sentence": node.sentence,
        "taint": taint,
        "session_id": node.session_id,
        "held": node.held,
        "category": node.detail.category,
        "confidence_millis": node.detail.confidence_millis,
        "created_at": node.detail.created_at,
        "last_used_at": node.detail.last_used_at,
        "source_episode": node.detail.source_episode,
        "status": node.detail.status,
        "hidden_reason": node.detail.hidden_reason,
        "subject": node.detail.subject,
        "entity_kind": node.detail.entity_kind,
    })
}

fn brain_edge_value(edge: &BrainEdge) -> Value {
    serde_json::json!({
        "kind": edge.kind,
        "from_kind": edge.from_kind,
        "from_id": edge.from_id,
        "to_kind": edge.to_kind,
        "to_id": edge.to_id,
        "weight_millis": edge.weight_millis,
    })
}

async fn unknown_api() -> Response {
    error_response(ApiError::UnknownRoute)
}

async fn websocket(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| socket_loop(socket, state.updates))
}

async fn socket_loop(mut socket: WebSocket, updates: watch::Sender<String>) {
    let mut receiver = updates.subscribe();
    let current = receiver.borrow().clone();
    if coalesce_sidebar(std::slice::from_ref(&current)).is_some()
        && socket.send(Message::Text(current.into())).await.is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            changed = receiver.changed() => {
                if changed.is_err() {
                    break;
                }
                let frame = receiver.borrow().clone();
                if coalesce_sidebar(std::slice::from_ref(&frame)).is_none() {
                    continue;
                }
                if socket.send(Message::Text(frame.into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

async fn ask<F>(state: &AppState, make: F) -> Result<Value, ApiError>
where
    F: FnOnce(oneshot::Sender<Result<Value, ApiError>>) -> ActorCall,
{
    let (tx, rx) = oneshot::channel();
    state
        .commands
        .send(make(tx))
        .await
        .map_err(|_| ApiError::Session)?;
    rx.await.map_err(|_| ApiError::Session)?
}

fn finish(result: Result<Value, ApiError>) -> Response {
    match result {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(error) => error_response(error),
    }
}

async fn read_message(
    request: Request,
) -> Result<(SubmissionId, String, String, Vec<String>), ApiError> {
    let value = read_json(request).await?;
    let message: WireMessage =
        serde_json::from_value(value).map_err(|_| ApiError::InvalidMessage)?;
    let operation = match message.operation_id {
        Some(Value::String(value)) => parse_submission_id(&value)?,
        Some(_) | None => return Err(ApiError::InvalidOperationId),
    };
    if message.text.trim().is_empty() {
        return Err(ApiError::EmptyMessage);
    }
    if message.text.len() > MAX_MESSAGE_BYTES {
        return Err(ApiError::PayloadTooLarge);
    }
    if message.attachment_ids.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(ApiError::PayloadTooLarge);
    }
    let bot_id = if message.bot_id.trim().is_empty() {
        "maia".to_owned()
    } else {
        message.bot_id
    };
    Ok((operation, message.text, bot_id, message.attachment_ids))
}

async fn read_upload(request: Request) -> Result<(String, String, Vec<u8>), ApiError> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type.starts_with(JSON_CONTENT_TYPE) {
        return Err(ApiError::UnsupportedMedia);
    }
    if content_length_exceeds(request.headers(), MAX_UPLOAD_BODY) {
        return Err(ApiError::PayloadTooLarge);
    }
    let bytes = axum::body::to_bytes(request.into_body(), MAX_UPLOAD_BODY)
        .await
        .map_err(|_| ApiError::PayloadTooLarge)?;
    let upload: WireUpload = serde_json::from_slice(&bytes).map_err(|_| ApiError::InvalidJson)?;
    let raw = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        upload.data_base64.trim(),
    )
    .map_err(|_| ApiError::InvalidMessage)?;
    Ok((upload.name, upload.media_type, raw))
}

fn new_attachment_id() -> Result<String, ApiError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| ApiError::Session)?;
    let mut id = String::from("att-");
    for byte in bytes {
        id.push(char::from(b"0123456789abcdef"[(byte >> 4) as usize]));
        id.push(char::from(b"0123456789abcdef"[(byte & 0x0f) as usize]));
    }
    Ok(id)
}

fn stage_attachments(
    database: &FsPath,
    ids: &[String],
) -> Result<Vec<crate::orchestrator::StagedAttachment>, ApiError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let connection = open_read(database)?;
    let data_dir = database.parent().ok_or(ApiError::Store)?;
    let mut staged = Vec::new();
    for id in ids {
        let Some(loaded) = load_attachment_bytes_from(&connection, data_dir, id)? else {
            return Err(ApiError::UnknownAttachment);
        };
        let model = crate::attachment_prompt::model_attachment(
            &loaded.safe_name,
            &loaded.media_type,
            &loaded.bytes,
            false,
        );
        staged.push(crate::orchestrator::StagedAttachment {
            id: id.clone(),
            note: model.note,
            png_base64: model.png_base64,
        });
    }
    Ok(staged)
}

struct LoadedAttachment {
    safe_name: String,
    media_type: String,
    bytes: Vec<u8>,
}

fn load_attachment_bytes(
    database: &FsPath,
    attachment_id: &str,
) -> Result<LoadedAttachment, ApiError> {
    let connection = open_read(database)?;
    let data_dir = database.parent().ok_or(ApiError::Store)?;
    load_attachment_bytes_from(&connection, data_dir, attachment_id)?
        .ok_or(ApiError::UnknownAttachment)
}

fn load_attachment_bytes_from(
    connection: &Connection,
    data_dir: &FsPath,
    attachment_id: &str,
) -> Result<Option<LoadedAttachment>, ApiError> {
    let row: Option<(String, String, String)> = connection
        .query_row(
            "SELECT safe_name, media_type, relative_path FROM attachments WHERE attachment_id = ?1",
            params![attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| ApiError::Store)?;
    let Some((safe_name, media_type, relative)) = row else {
        return Ok(None);
    };
    if !maia_store::attachment_media_allowed(&media_type) {
        return Err(ApiError::UnsupportedMedia);
    }
    let path =
        crate::attachment_prompt::attachment_file(data_dir, &relative).ok_or(ApiError::Store)?;
    let bytes = std::fs::read(&path).map_err(|_| ApiError::Store)?;
    Ok(Some(LoadedAttachment {
        safe_name,
        media_type,
        bytes,
    }))
}

fn parse_submission_id(value: &str) -> Result<SubmissionId, ApiError> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        });
    if !valid {
        return Err(ApiError::InvalidOperationId);
    }
    Ok(SubmissionId(value.to_ascii_lowercase()))
}

async fn read_pin(request: Request) -> Result<PinMark, ApiError> {
    let value = read_json(request).await?;
    let wire: WirePin = serde_json::from_value(value).map_err(|_| ApiError::InvalidPin)?;
    match wire.pin.as_str() {
        "pinned" => Ok(PinMark::Pinned),
        "unpinned" => Ok(PinMark::Unpinned),
        _ => Err(ApiError::InvalidPin),
    }
}

async fn read_view(request: Request) -> Result<ViewCommand, ApiError> {
    let value = read_json(request).await?;
    let wire: WireView = serde_json::from_value(value).map_err(|_| ApiError::InvalidView)?;
    match wire.view.as_str() {
        "open" => Ok(ViewCommand::Open),
        "closed_once" => Ok(ViewCommand::Close),
        _ => Err(ApiError::InvalidView),
    }
}

async fn read_fact_sentence(request: Request) -> Result<String, ApiError> {
    let value = read_json(request).await?;
    let body: WireFactSentence =
        serde_json::from_value(value).map_err(|_| ApiError::InvalidFact)?;
    Ok(body.sentence)
}

async fn read_host(request: Request) -> Result<WireHost, ApiError> {
    let value = read_json(request).await?;
    serde_json::from_value(value).map_err(|_| ApiError::UnknownCommand)
}

async fn read_object(request: Request) -> Result<(), ApiError> {
    let value = read_json(request).await?;
    if value.as_object().is_some() {
        Ok(())
    } else {
        Err(ApiError::InvalidMessage)
    }
}

async fn read_json(request: Request) -> Result<Value, ApiError> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type.starts_with(JSON_CONTENT_TYPE) {
        return Err(ApiError::UnsupportedMedia);
    }
    if content_length_exceeds(request.headers(), MAX_HTTP_BODY) {
        return Err(ApiError::PayloadTooLarge);
    }
    let request = request.with_limited_body();
    let bytes = axum::body::to_bytes(request.into_body(), MAX_HTTP_BODY)
        .await
        .map_err(|_| ApiError::PayloadTooLarge)?;
    if bytes.is_empty() {
        return Err(ApiError::InvalidJson);
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiError::InvalidJson)
}

fn content_length_exceeds(headers: &axum::http::HeaderMap, limit: usize) -> bool {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > limit)
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let mut response = (status, Json(value)).into_response();
    insert_header(&mut response, header::CACHE_CONTROL, "no-store");
    insert_header(&mut response, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    response
}

fn error_response(error: ApiError) -> Response {
    json_response(error.status(), serde_json::json!({ "error": error.code() }))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireFactSentence {
    sentence: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireMessage {
    operation_id: Option<Value>,
    text: String,
    #[serde(default)]
    attachment_ids: Vec<String>,
    /// Empty means the migrated Maia bot.
    #[serde(default)]
    bot_id: String,
}

#[derive(Debug, Default, Deserialize)]
struct BotScope {
    bot: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBotCreate {
    name: String,
    #[serde(default)]
    instructions: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBotName {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBotInstructions {
    #[serde(default)]
    instructions: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBotPin {
    pinned: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBotArchive {
    archived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBotSelect {
    bot_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireUpload {
    name: String,
    media_type: String,
    data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WirePin {
    pin: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireView {
    view: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum WireHost {
    Stop { task_id: String },
    StopAll,
    Cancel { task_id: String },
    Abandon { task_id: String },
    Retry { task_id: String },
}

#[derive(Debug, Clone, Copy)]
enum ApiError {
    InvalidJson,
    InvalidMessage,
    InvalidOperationId,
    EmptyMessage,
    UnsupportedMedia,
    PayloadTooLarge,
    Provider,
    RouteUnreadable,
    Store,
    Session,
    UnknownTask,
    UnknownCommand,
    CommandRejected,
    SubmissionConflict,
    InvalidPin,
    InvalidView,
    DetailNotOpen,
    UnknownRoute,
    InvalidModelConnection,
    ModelKey,
    UnknownFact,
    InvalidFact,
    InvalidMcp,
    UnknownMcp,
    McpSecret,
    UnknownApproval,
    ApprovalSettled,
    UnknownAttachment,
}

impl ApiError {
    fn status(self) -> StatusCode {
        match self {
            Self::InvalidJson
            | Self::InvalidMessage
            | Self::InvalidOperationId
            | Self::EmptyMessage
            | Self::UnknownCommand
            | Self::InvalidPin
            | Self::InvalidView
            | Self::InvalidModelConnection
            | Self::InvalidFact
            | Self::InvalidMcp => StatusCode::BAD_REQUEST,
            Self::UnsupportedMedia => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::UnknownTask
            | Self::UnknownRoute
            | Self::UnknownFact
            | Self::UnknownMcp
            | Self::UnknownApproval
            | Self::UnknownAttachment => StatusCode::NOT_FOUND,
            Self::CommandRejected
            | Self::SubmissionConflict
            | Self::DetailNotOpen
            | Self::ApprovalSettled => StatusCode::CONFLICT,
            Self::Provider | Self::RouteUnreadable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Store | Self::Session | Self::ModelKey | Self::McpSecret => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::InvalidMessage => "invalid_message",
            Self::InvalidOperationId => "invalid_operation_id",
            Self::EmptyMessage => "empty_message",
            Self::UnsupportedMedia => "unsupported_media_type",
            Self::PayloadTooLarge => "payload_too_large",
            Self::Provider => "model_provider_unavailable",
            Self::RouteUnreadable => "route_unreadable",
            Self::Store => "task_store_unavailable",
            Self::Session => "session_unavailable",
            Self::UnknownTask => "unknown_task",
            Self::UnknownCommand => "unknown_command",
            Self::CommandRejected => "command_rejected",
            Self::SubmissionConflict => "submission_conflict",
            Self::InvalidPin => "invalid_pin",
            Self::InvalidView => "invalid_view",
            Self::DetailNotOpen => "detail_not_open",
            Self::UnknownRoute => "unknown_route",
            Self::InvalidModelConnection => "invalid_model_connection",
            Self::ModelKey => "model_connection_unavailable",
            Self::UnknownFact => "unknown_fact",
            Self::InvalidFact => "invalid_fact",
            Self::InvalidMcp => "invalid_mcp",
            Self::UnknownMcp => "unknown_mcp",
            Self::McpSecret => "mcp_secret_unavailable",
            Self::UnknownApproval => "unknown_approval",
            Self::ApprovalSettled => "approval_settled",
            Self::UnknownAttachment => "unknown_attachment",
        }
    }
}

fn map_orchestrator(error: OrchestratorError) -> ApiError {
    match error {
        OrchestratorError::Router(_) => ApiError::Provider,
        OrchestratorError::Proposal(_) => ApiError::RouteUnreadable,
        OrchestratorError::Store(store) => map_store(store),
        OrchestratorError::UnknownTask => ApiError::UnknownTask,
        OrchestratorError::Phase(_) => ApiError::CommandRejected,
        OrchestratorError::IdExhausted(_)
        | OrchestratorError::Seal(_)
        | OrchestratorError::Tool(_)
        | OrchestratorError::UnknownChild
        | OrchestratorError::DecisionNotApplied
        | OrchestratorError::PromptTooLarge
        | OrchestratorError::Narrow(_)
        | OrchestratorError::ChildBudget => ApiError::Session,
    }
}

fn map_submission_orchestrator(error: OrchestratorError) -> ApiError {
    match error {
        OrchestratorError::Store(StoreError::IdempotencyConflict { .. }) => {
            ApiError::SubmissionConflict
        }
        other => map_orchestrator(other),
    }
}

fn map_store(error: StoreError) -> ApiError {
    match error {
        StoreError::NotFound { .. } => ApiError::UnknownTask,
        StoreError::ResourceLimit(_) => ApiError::PayloadTooLarge,
        _ => ApiError::Store,
    }
}

fn map_bot(error: StoreError) -> ApiError {
    match error {
        StoreError::NotFound { .. } => ApiError::UnknownTask,
        StoreError::InvalidRequest { .. } => ApiError::InvalidMessage,
        StoreError::ResourceLimit(_) => ApiError::PayloadTooLarge,
        _ => ApiError::Store,
    }
}

fn map_view_open(error: CompletionViewError) -> ApiError {
    match error {
        CompletionViewError::InvalidTransition => ApiError::CommandRejected,
    }
}

fn accept_task_id(task_id: &str) -> Result<(), ApiError> {
    if task_id.is_empty()
        || task_id.len() > MAX_TASK_ID_BYTES
        || task_id
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
    {
        return Err(ApiError::UnknownTask);
    }
    Ok(())
}

fn open_read(path: &FsPath) -> Result<Connection, ApiError> {
    let connection = Connection::open(path).map_err(|_| ApiError::Store)?;
    connection
        .busy_timeout(SCHEMA_LOCK_BUSY_TIMEOUT)
        .map_err(|_| ApiError::Store)?;
    Ok(connection)
}

fn sidebar_value(connection: &Connection, bot: Option<&str>) -> Result<Value, ApiError> {
    let tasks = load_tasks(connection, bot)?;
    let children = load_children(connection)?;
    let rows = nest_rows(&tasks, &children)?;
    let approvals = approval_values(connection)?;
    Ok(serde_json::json!({ "rows": rows, "approvals": approvals }))
}

fn approval_values(connection: &Connection) -> Result<Vec<Value>, ApiError> {
    let mut statement = connection
        .prepare(
            "SELECT approval_id, task_id, kind, taint, grant_text, reason, created_at, expires_at \
             FROM pending_approvals WHERE status = 'pending' ORDER BY created_at, approval_id",
        )
        .map_err(|_| ApiError::Store)?;
    let mapped = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "approval_id": row.get::<_, String>(0)?,
                "task_id": row.get::<_, String>(1)?,
                "kind": row.get::<_, String>(2)?,
                "taint": row.get::<_, String>(3)?,
                "grant_text": row.get::<_, String>(4)?,
                "reason": row.get::<_, String>(5)?,
                "created_at": row.get::<_, i64>(6)?,
                "expires_at": row.get::<_, i64>(7)?,
            }))
        })
        .map_err(|_| ApiError::Store)?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row.map_err(|_| ApiError::Store)?);
    }
    Ok(rows)
}

fn inspector_value(connection: &Connection) -> Result<Value, ApiError> {
    let mut statement = connection
        .prepare(
            "SELECT ordinal, message_id, slots_json, usage_json, recall_json, thinking, route, reply \
             FROM router_turn_snapshots ORDER BY ordinal",
        )
        .map_err(|_| ApiError::Store)?;
    let mapped = statement
        .query_map([], |row| {
            Ok(StoredTurnRow {
                ordinal: row.get(0)?,
                message_id: row.get(1)?,
                slots_json: row.get(2)?,
                usage_json: row.get(3)?,
                recall_json: row.get(4)?,
                thinking: row.get(5)?,
                route: row.get(6)?,
                reply: row.get(7)?,
            })
        })
        .map_err(|_| ApiError::Store)?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row.map_err(|_| ApiError::Store)?);
    }
    Ok(inspector_document(&rows, &presented_by_message(connection)))
}

fn presented_by_message(connection: &Connection) -> BTreeMap<String, Vec<String>> {
    let mut statement = match connection.prepare(
        "SELECT l.request_id, p.candidate_id FROM presentations p \
         JOIN ledgers l ON l.ledger_id = p.ledger_id \
         WHERE p.weight > 0 ORDER BY l.request_id, p.candidate_id",
    ) {
        Ok(statement) => statement,
        Err(_) => return BTreeMap::new(),
    };
    let mapped = match statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        Ok(mapped) => mapped,
        Err(_) => return BTreeMap::new(),
    };
    let mut used = BTreeMap::<String, Vec<String>>::new();
    for row in mapped {
        let Ok((message_id, candidate_id)) = row else {
            continue;
        };
        let ids = used.entry(message_id).or_default();
        if !ids.contains(&candidate_id) {
            ids.push(candidate_id);
        }
    }
    used
}

fn transcript_value(connection: &Connection, bot: Option<&str>) -> Result<Value, ApiError> {
    let mut statement = connection
        .prepare(
            "SELECT m.message_id, m.role, m.body FROM router_messages m \
             LEFT JOIN message_bots b ON b.message_id = m.message_id \
             WHERE (?1 IS NULL OR COALESCE(b.bot_id, 'maia') = ?1) \
             ORDER BY m.ordinal, m.message_id",
        )
        .map_err(|_| ApiError::Store)?;
    let mapped = statement
        .query_map(params![bot], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| ApiError::Store)?;
    let mut messages = Vec::new();
    for row in mapped {
        let (message_id, role, body) = row.map_err(|_| ApiError::Store)?;
        let presented = present_router_body(&body);
        let mut message = serde_json::json!({
            "message_id": message_id,
            "role": transcript_role(&role)?,
            "text": presented.text,
        });
        if let Some(thinking) = presented.thinking {
            message["thinking"] = serde_json::Value::String(thinking);
        }
        if let Some(route) = presented.route {
            message["route"] = serde_json::Value::String(route);
        }
        if let Ok(attachments) = attachment_values(connection, &message_id)
            && !attachments.is_empty()
        {
            message["attachments"] = Value::Array(attachments);
        }
        messages.push(message);
    }
    Ok(serde_json::json!({ "messages": messages }))
}

fn attachment_values(connection: &Connection, message_id: &str) -> Result<Vec<Value>, ApiError> {
    let mut statement = connection
        .prepare(
            "SELECT attachment_id, safe_name, media_type, byte_size FROM attachments \
             WHERE message_id = ?1 ORDER BY attachment_id",
        )
        .map_err(|_| ApiError::Store)?;
    let mapped = statement
        .query_map(params![message_id], |row| {
            Ok(serde_json::json!({
                "attachment_id": row.get::<_, String>(0)?,
                "safe_name": row.get::<_, String>(1)?,
                "media_type": row.get::<_, String>(2)?,
                "byte_size": row.get::<_, i64>(3)?,
            }))
        })
        .map_err(|_| ApiError::Store)?;
    let mut values = Vec::new();
    for row in mapped {
        values.push(row.map_err(|_| ApiError::Store)?);
    }
    Ok(values)
}

fn transcript_role(role: &str) -> Result<&'static str, ApiError> {
    match role {
        "user" => Ok("owner"),
        "assistant" => Ok("router"),
        _ => Err(ApiError::Store),
    }
}

#[derive(Clone)]
struct TaskRecord {
    task_id: String,
    title: String,
    phase: String,
    pin: String,
    completion_view: String,
    summary: String,
    criteria_total: u32,
}

struct ChildRecord {
    child_id: String,
    parent_task_id: String,
    title: String,
}

fn load_tasks(connection: &Connection, bot: Option<&str>) -> Result<Vec<TaskRecord>, ApiError> {
    let mut statement = connection
        .prepare(
            "SELECT t.task_id, t.title, t.phase, t.pinned, t.completion_view FROM task_sessions t \
             LEFT JOIN task_bots b ON b.task_id = t.task_id \
             WHERE (?1 IS NULL OR COALESCE(b.bot_id, 'maia') = ?1) \
             ORDER BY t.created_at, t.task_id",
        )
        .map_err(|_| ApiError::Store)?;
    let mapped = statement
        .query_map(params![bot], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|_| ApiError::Store)?;
    let mut tasks = Vec::new();
    for row in mapped {
        let (task_id, title, phase, pin, completion_view) = row.map_err(|_| ApiError::Store)?;
        tasks.push(TaskRecord {
            summary: load_summary(connection, &task_id)?,
            criteria_total: count_criteria(connection, &task_id)?,
            task_id,
            title,
            phase,
            pin,
            completion_view,
        });
    }
    Ok(tasks)
}

fn load_children(connection: &Connection) -> Result<Vec<ChildRecord>, ApiError> {
    let mut statement = connection
        .prepare(
            "SELECT child_id, parent_task_id, subgoal FROM child_assignments ORDER BY child_id",
        )
        .map_err(|_| ApiError::Store)?;
    let mapped = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|_| ApiError::Store)?;
    let mut children = Vec::new();
    for row in mapped {
        let (child_id, parent_task_id, subgoal) = row.map_err(|_| ApiError::Store)?;
        let title = String::from_utf8(subgoal).unwrap_or_default();
        children.push(ChildRecord {
            child_id,
            parent_task_id,
            title,
        });
    }
    Ok(children)
}

fn load_summary(connection: &Connection, task_id: &str) -> Result<String, ApiError> {
    connection
        .query_row(
            "SELECT summary FROM task_reports WHERE task_id = ?1 \
             ORDER BY created_at DESC, report_id DESC LIMIT 1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| ApiError::Store)
        .map(|summary| summary.unwrap_or_default())
}

fn count_criteria(connection: &Connection, task_id: &str) -> Result<u32, ApiError> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM task_criteria WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .map_err(|_| ApiError::Store)?;
    u32::try_from(count).map_err(|_| ApiError::Store)
}

fn load_view(connection: &Connection, task_id: &str) -> Result<CompletionView, ApiError> {
    let stored: String = connection
        .query_row(
            "SELECT completion_view FROM task_sessions WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| ApiError::Store)?
        .ok_or(ApiError::UnknownTask)?;
    decode_view(&stored)
}

fn task_exists(connection: &Connection, task_id: &str) -> Result<bool, ApiError> {
    connection
        .query_row(
            "SELECT 1 FROM task_sessions WHERE task_id = ?1",
            params![task_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| ApiError::Store)
        .map(|row| row.is_some())
}

#[derive(Serialize)]
struct SidebarRowBody {
    task_id: String,
    title: String,
    section: &'static str,
    phase: &'static str,
    summary: String,
    elapsed_ms: u64,
    criteria_done: u32,
    criteria_total: u32,
    children: Vec<SidebarRowBody>,
}

fn nest_rows(
    tasks: &[TaskRecord],
    children: &[ChildRecord],
) -> Result<Vec<SidebarRowBody>, ApiError> {
    let child_ids: BTreeSet<&str> = children
        .iter()
        .map(|child| child.child_id.as_str())
        .collect();
    let mut by_parent: BTreeMap<&str, Vec<&ChildRecord>> = BTreeMap::new();
    for child in children {
        by_parent
            .entry(child.parent_task_id.as_str())
            .or_default()
            .push(child);
    }
    let mut rows = Vec::new();
    for task in tasks {
        if child_ids.contains(task.task_id.as_str()) {
            continue;
        }
        rows.push(task_row(task, tasks, &by_parent, 0)?);
    }
    Ok(rows)
}

fn task_row(
    task: &TaskRecord,
    tasks: &[TaskRecord],
    by_parent: &BTreeMap<&str, Vec<&ChildRecord>>,
    depth: u32,
) -> Result<SidebarRowBody, ApiError> {
    let mut row = project_task(task)?;
    if depth < 3 {
        row.children = child_rows(&task.task_id, tasks, by_parent, depth)?;
    }
    Ok(row)
}

fn child_rows(
    parent: &str,
    tasks: &[TaskRecord],
    by_parent: &BTreeMap<&str, Vec<&ChildRecord>>,
    depth: u32,
) -> Result<Vec<SidebarRowBody>, ApiError> {
    let Some(children) = by_parent.get(parent) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for child in children {
        if let Some(task) = tasks.iter().find(|task| task.task_id == child.child_id) {
            rows.push(task_row(task, tasks, by_parent, depth.saturating_add(1))?);
        } else if depth < 3 {
            let mut row = synthetic_child(child);
            row.children = child_rows(&child.child_id, tasks, by_parent, depth.saturating_add(1))?;
            rows.push(row);
        }
    }
    Ok(rows)
}

fn project_task(task: &TaskRecord) -> Result<SidebarRowBody, ApiError> {
    let phase = parse_canonical_phase(&task.phase).map_err(|_| ApiError::Store)?;
    let pin = decode_pin(&task.pin)?;
    let view = decode_view(&task.completion_view)?;
    let done = if matches!(phase, TaskPhase::Completed { .. }) {
        task.criteria_total
    } else {
        0
    };
    Ok(SidebarRowBody {
        task_id: task.task_id.clone(),
        title: task.title.clone(),
        section: section_name(place_sidebar(&phase, pin, &view)),
        phase: phase_name(&phase),
        summary: task.summary.clone(),
        elapsed_ms: 0,
        criteria_done: done,
        criteria_total: task.criteria_total,
        children: Vec::new(),
    })
}

fn synthetic_child(child: &ChildRecord) -> SidebarRowBody {
    SidebarRowBody {
        task_id: child.child_id.clone(),
        title: child.title.clone(),
        section: "working",
        phase: "running",
        summary: child.title.clone(),
        elapsed_ms: 0,
        criteria_done: 0,
        criteria_total: 0,
        children: Vec::new(),
    }
}

fn decode_pin(pin: &str) -> Result<PinMark, ApiError> {
    match pin {
        "pinned" => Ok(PinMark::Pinned),
        "unpinned" => Ok(PinMark::Unpinned),
        _ => Err(ApiError::Store),
    }
}

fn decode_view(view: &str) -> Result<CompletionView, ApiError> {
    match view {
        "unopened" => Ok(CompletionView::Unopened),
        "closed_once" => Ok(CompletionView::ClosedOnce),
        other => {
            let id = other.strip_prefix("open:").ok_or(ApiError::Store)?;
            if id.is_empty() {
                return Err(ApiError::Store);
            }
            Ok(CompletionView::Open {
                detail: DetailSessionId(id.to_owned()),
            })
        }
    }
}

fn encode_view(view: &CompletionView) -> String {
    match view {
        CompletionView::Unopened => "unopened".to_owned(),
        CompletionView::ClosedOnce => "closed_once".to_owned(),
        CompletionView::Open { detail } => format!("open:{}", detail.0),
    }
}

fn view_name(view: &CompletionView) -> &'static str {
    match view {
        CompletionView::Unopened => "unopened",
        CompletionView::Open { .. } => "open",
        CompletionView::ClosedOnce => "closed_once",
    }
}

fn phase_name(phase: &TaskPhase) -> &'static str {
    match phase {
        TaskPhase::Queued => "queued",
        TaskPhase::Running { .. } => "running",
        TaskPhase::WaitingForUser { .. } => "waiting_for_user",
        TaskPhase::Blocked { .. } => "blocked",
        TaskPhase::Failed { .. } => "failed",
        TaskPhase::Completed { .. } => "completed",
        TaskPhase::Stopped { .. } => "stopped",
        TaskPhase::Cancelled { .. } => "cancelled",
        TaskPhase::Abandoned { .. } => "abandoned",
    }
}

fn section_name(section: SidebarSection) -> &'static str {
    match section {
        SidebarSection::NeedsYou => "needs_you",
        SidebarSection::Working => "working",
        SidebarSection::Completed => "completed",
        SidebarSection::Pinned => "pinned",
        SidebarSection::Archive => "archive",
    }
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
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => {
                let Ok(mut ready) = parker.ready.lock() else {
                    continue;
                };
                while !*ready {
                    ready = match parker.signal.wait(ready) {
                        Ok(ready) => ready,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                }
                *ready = false;
            }
        }
    }
}

/// Loopback check used by bind. Non-loopback addresses are refused.
pub fn is_loopback_ip(ip: IpAddr) -> bool {
    ip.is_loopback()
}
