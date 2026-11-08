//! Named blocking owner thread. The connection never leaves `maia-sqlite`.

use std::sync::Mutex;
use std::sync::mpsc;
use std::thread::JoinHandle;

use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::oneshot;

use crate::audit_ops;
use crate::brain_ops;
use crate::brain_ops::validate_fact_sentence;
use crate::canonical::consolidation_canonical;
use crate::canonical::episode_canonical;
use crate::canonical::ledger_canonical;
use crate::canonical::promotion_canonical;
use crate::canonical::require_text;
use crate::canonical::validate_append;
use crate::canonical::validate_audit;
use crate::dream_ops;
use crate::embed_ops;
use crate::error::StoreError;
use crate::inspector_ops;
use crate::ledger_ops;
use crate::limits::require_fts_query;
use crate::mcp_ops;
use crate::migrate;
use crate::model_connection_ops;
use crate::security_ops;
use crate::super_agent_ops;
use crate::thread_ops;
use crate::types::AllowlistEntryWrite;
use crate::types::AppendEvents;
use crate::types::AppendOutcome;
use crate::types::AuditAppend;
use crate::types::AuditHead;
use crate::types::BrainMap;
use crate::types::CapabilitySnapshotWrite;
use crate::types::ChildAssignmentWrite;
use crate::types::ChildLink;
use crate::types::ClearPanic;
use crate::types::CompleteProjection;
use crate::types::ConnectionSettings;
use crate::types::ConsolidationWrite;
use crate::types::ContinueTaskWrite;
use crate::types::CredentialBackendWrite;
use crate::types::EmbeddingModelWrite;
use crate::types::EmbeddingTarget;
use crate::types::EmbeddingWrite;
use crate::types::EngagePanic;
use crate::types::EpisodeWrite;
use crate::types::Executed;
use crate::types::FactRevise;
use crate::types::HostMutationWrite;
use crate::types::MessageSubmissionState;
use crate::types::MessageSubmissionWrite;
use crate::types::MigrationRow;
use crate::types::McpAuditWrite;
use crate::types::McpConnectionRecord;
use crate::types::McpTransportRecord;
use crate::types::ModelConnectionRecord;
use crate::types::OwnerOpen;
use crate::types::PanicLatch;
use crate::types::PendingProjection;
use crate::types::PromotionWrite;
use crate::types::RouterMessageWrite;
use crate::types::RouterTurnWrite;
use crate::types::RuntimeIdBlock;
use crate::types::RuntimeSnapshot;
use crate::types::SecuritySettingsWrite;
use crate::types::SnapshotItemWrite;
use crate::types::StoredSubmissionOutcome;
use crate::types::TaskAggregateWrite;
use crate::types::TaskAttemptWrite;
use crate::types::TaskCriterionWrite;
use crate::types::TaskEnvelopeWrite;
use crate::types::TaskEvidenceWrite;
use crate::types::TaskInputWrite;
use crate::types::TaskInspection;
use crate::types::TaskReportWrite;
use crate::types::TaskView;
use crate::types::TaskWrite;
use crate::types::TextSearch;
use crate::types::ThreadSnapshot;
use crate::types::VecTable;
use crate::types::VecVersionMetadata;
use crate::vec_register::register_sqlite_vec;

enum Submit {
    Try,
    Wait,
}

type Reply<T> = oneshot::Sender<Result<T, StoreError>>;

enum NormalCommand {
    Ping {
        reply: Reply<Executed<()>>,
    },
    ThreadName {
        reply: Reply<String>,
    },
    Settings {
        reply: Reply<ConnectionSettings>,
    },
    Migrations {
        reply: Reply<Vec<MigrationRow>>,
    },
    Hold {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        reply: Reply<Executed<()>>,
    },
    Append {
        request: AppendEvents,
        reply: Reply<Executed<AppendOutcome>>,
    },
    Thread {
        thread_id: String,
        reply: Reply<ThreadSnapshot>,
    },
    Episode {
        request: EpisodeWrite,
        reply: Reply<Executed<()>>,
    },
    Promotion {
        request: PromotionWrite,
        reply: Reply<Executed<()>>,
    },
    Ledger {
        request: LedgerWrite,
        reply: Reply<Executed<()>>,
    },
    Consolidation {
        request: ConsolidationWrite,
        reply: Reply<Executed<()>>,
    },
    BrainMap {
        reply: Reply<BrainMap>,
    },
    ReviseFact {
        request: FactRevise,
        reply: Reply<Executed<BrainMap>>,
    },
    DeleteFact {
        fact_id: String,
        reply: Reply<Executed<BrainMap>>,
    },
    Pending {
        reply: Reply<Vec<PendingProjection>>,
    },
    Complete {
        request: CompleteProjection,
        reply: Reply<Executed<i64>>,
    },
    Audit {
        request: AuditAppend,
        reply: Reply<Executed<()>>,
    },
    AuditHead {
        reply: Reply<Option<AuditHead>>,
    },
    Latch {
        reply: Reply<PanicLatch>,
    },
    PutSettings {
        request: SecuritySettingsWrite,
        reply: Reply<Executed<()>>,
    },
    GetSettings {
        reply: Reply<Option<SecuritySettingsWrite>>,
    },
    PutAllowlist {
        request: AllowlistEntryWrite,
        reply: Reply<Executed<()>>,
    },
    SetEnabled {
        grant_id: String,
        enabled: bool,
        reply: Reply<Executed<()>>,
    },
    Allowlist {
        reply: Reply<Vec<AllowlistEntryWrite>>,
    },
    PutBackend {
        request: CredentialBackendWrite,
        reply: Reply<Executed<()>>,
    },
    Backend {
        reply: Reply<Option<CredentialBackendWrite>>,
    },
    PutModelConnection {
        request: ModelConnectionRecord,
        reply: Reply<Executed<()>>,
    },
    ModelConnection {
        reply: Reply<Option<ModelConnectionRecord>>,
    },
    PutSnapshot {
        request: CapabilitySnapshotWrite,
        reply: Reply<Executed<()>>,
    },
    Snapshots {
        reply: Reply<Vec<CapabilitySnapshotWrite>>,
    },
    PutModel {
        request: EmbeddingModelWrite,
        reply: Reply<Executed<()>>,
    },
    Models {
        reply: Reply<Vec<EmbeddingModelWrite>>,
    },
    Upsert {
        request: EmbeddingWrite,
        reply: Reply<Executed<()>>,
    },
    Embedding {
        target: EmbeddingTarget,
        target_id: String,
        reply: Reply<Option<Vec<f32>>>,
    },
    Search {
        kind: TextSearch,
        query: String,
        reply: Reply<Vec<String>>,
    },
    VecVersion {
        reply: Reply<String>,
    },
    VecMetadata {
        table: VecTable,
        reply: Reply<VecVersionMetadata>,
    },
    RouterMessage {
        request: RouterMessageWrite,
        reply: Reply<Executed<()>>,
    },
    LookupMessageSubmission {
        operation_id: String,
        text: String,
        reply: Reply<MessageSubmissionState>,
    },
    BeginMessageSubmission {
        request: MessageSubmissionWrite,
        reply: Reply<Executed<MessageSubmissionState>>,
    },
    FinishMessageSubmission {
        operation_id: String,
        outcome: StoredSubmissionOutcome,
        reply: Reply<Executed<()>>,
    },
    NextMessageSequence {
        reply: Reply<u64>,
    },
    RuntimeSnapshot {
        reply: Reply<RuntimeSnapshot>,
    },
    ReserveRuntimeIds {
        count: u64,
        reply: Reply<RuntimeIdBlock>,
    },
    InsertTask {
        request: TaskWrite,
        reply: Reply<Executed<()>>,
    },
    InsertTaskAggregate {
        request: TaskAggregateWrite,
        reply: Reply<Executed<()>>,
    },
    TaskEnvelope {
        request: TaskEnvelopeWrite,
        reply: Reply<Executed<()>>,
    },
    LoadPrompt {
        task_id: String,
        reply: Reply<Vec<u8>>,
    },
    TaskInput {
        request: TaskInputWrite,
        reply: Reply<Executed<()>>,
    },
    ContinueTask {
        request: ContinueTaskWrite,
        reply: Reply<Executed<()>>,
    },
    TaskReport {
        request: TaskReportWrite,
        reply: Reply<Executed<()>>,
    },
    UpdateTaskPhase {
        task_id: String,
        phase: String,
        reply: Reply<Executed<()>>,
    },
    LoadTaskPhase {
        task_id: String,
        reply: Reply<String>,
    },
    InsertTaskEvidence {
        request: TaskEvidenceWrite,
        reply: Reply<Executed<()>>,
    },
    InsertTaskAttempt {
        request: TaskAttemptWrite,
        reply: Reply<Executed<()>>,
    },
    RetryTaskPhase {
        request: TaskAttemptWrite,
        expected_phase: String,
        next_phase: String,
        reply: Reply<Executed<()>>,
    },
    InsertTaskCriterion {
        request: TaskCriterionWrite,
        reply: Reply<Executed<()>>,
    },
    LoadTaskView {
        task_id: String,
        reply: Reply<TaskView>,
    },
    ListTaskViews {
        reply: Reply<Vec<TaskView>>,
    },
    InsertContextSnapshot {
        snapshot_id: String,
        items: Vec<SnapshotItemWrite>,
        reply: Reply<Executed<()>>,
    },
    LoadTaskEvidence {
        evidence_id: String,
        reply: Reply<TaskEvidenceWrite>,
    },
    ChildAssignment {
        request: ChildAssignmentWrite,
        reply: Reply<Executed<()>>,
    },
    ListChildLinks {
        reply: Reply<Vec<ChildLink>>,
    },
    UpdateChildPhase {
        child_id: String,
        phase: String,
        reply: Reply<Executed<()>>,
    },
    UpdateChildPhases {
        child_ids: Vec<String>,
        phase: String,
        reply: Reply<Executed<()>>,
    },
    ApplyHostMutation {
        request: HostMutationWrite,
        reply: Reply<Executed<()>>,
    },
    SetPin {
        task_id: String,
        pin: String,
        reply: Reply<Executed<()>>,
    },
    SetCompletionView {
        task_id: String,
        view: String,
        reply: Reply<Executed<()>>,
    },
    MarkLegacyThreads {
        marked_at: i64,
        reply: Reply<Executed<()>>,
    },
    LegacyThreadIds {
        reply: Reply<Vec<String>>,
    },
    TaskInspection {
        task_id: String,
        reply: Reply<TaskInspection>,
    },
    InsertRouterTurn {
        request: RouterTurnWrite,
        reply: Reply<Executed<()>>,
    },
    CreateMcp {
        request: McpConnectionRecord,
        reply: Reply<Executed<()>>,
    },
    ReplaceMcpTransport {
        id: String,
        transport: McpTransportRecord,
        reply: Reply<Executed<()>>,
    },
    UpdateMcpLabel {
        id: String,
        label: String,
        reply: Reply<Executed<()>>,
    },
    DeleteMcp {
        id: String,
        reply: Reply<Executed<()>>,
    },
    ListMcp {
        reply: Reply<Vec<McpConnectionRecord>>,
    },
    StoreMcpList {
        id: String,
        canonical: String,
        hash: String,
        reply: Reply<Executed<()>>,
    },
    SetMcpRefreshError {
        id: String,
        message: String,
        reply: Reply<Executed<()>>,
    },
    AdmitMcp {
        id: String,
        hash: String,
        reply: Reply<Executed<()>>,
    },
    RevokeMcp {
        id: String,
        reply: Reply<Executed<()>>,
    },
    PutTaskGuidance {
        task_id: String,
        guidance: String,
        reply: Reply<Executed<()>>,
    },
    TaskGuidance {
        task_id: String,
        reply: Reply<Option<String>>,
    },
    InsertMcpAudit {
        request: McpAuditWrite,
        reply: Reply<Executed<()>>,
    },
}

enum PanicCommand {
    Engage {
        request: EngagePanic,
        reply: Reply<Executed<PanicLatch>>,
    },
    Clear {
        request: ClearPanic,
        reply: Reply<Executed<PanicLatch>>,
    },
}

use crate::types::LedgerWrite;

/// In-flight reply. Dropping it does not cancel work already accepted by the owner.
#[must_use]
pub struct Pending<T> {
    rx: oneshot::Receiver<Result<T, StoreError>>,
}

impl<T> Pending<T> {
    /// Blocks until the owner finishes this command.
    ///
    /// # Errors
    ///
    /// Returns the owner error, or [`StoreError::OwnerStopped`] if the thread
    /// exits first.
    pub fn wait(self) -> Result<T, StoreError> {
        match self.rx.blocking_recv() {
            Ok(result) => result,
            Err(_) => Err(StoreError::OwnerStopped),
        }
    }
}

/// Pauses the owner inside one normal-lane command so callers can observe queue bounds.
#[must_use]
pub struct Hold {
    entered: mpsc::Receiver<()>,
    release: mpsc::Sender<()>,
    pending: Option<Pending<Executed<()>>>,
}

impl Hold {
    /// Blocks until `maia-sqlite` has entered this hold.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::OwnerStopped`] if the owner exits first.
    pub fn wait_until_entered(&self) -> Result<(), StoreError> {
        self.entered.recv().map_err(|_| StoreError::OwnerStopped)?;
        Ok(())
    }

    /// Lets the owner finish the hold and returns the completion reply.
    pub fn release(mut self) -> Pending<Executed<()>> {
        let _ = self.release.send(());
        self.pending.take().unwrap_or_else(|| Pending {
            rx: oneshot::channel().1,
        })
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        let _ = self.release.send(());
    }
}

/// One SQLite connection owned by the `maia-sqlite` thread.
///
/// Callers send bounded commands. The connection is not behind a mutex.
#[must_use]
pub struct SqliteOwner {
    normal_tx: Option<tokio::sync::mpsc::Sender<NormalCommand>>,
    panic_tx: Option<tokio::sync::mpsc::Sender<PanicCommand>>,
    wake_tx: Option<mpsc::Sender<()>>,
    /// Release senders for holds blocked inside the owner thread.
    /// This mutex does not guard the SQLite connection.
    barriers: Mutex<Vec<mpsc::Sender<()>>>,
    done_rx: Option<mpsc::Receiver<Result<(), StoreError>>>,
    join: Option<JoinHandle<()>>,
}

impl SqliteOwner {
    /// Opens `request.path`, migrates forward, and starts `maia-sqlite`.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::InvalidCapacity`] before creating a thread when a
    /// capacity is zero. Database and migration failures stop the thread and
    /// return the error.
    pub fn open(request: OwnerOpen) -> Result<Self, StoreError> {
        if request.normal_capacity == 0 || request.panic_capacity == 0 {
            return Err(StoreError::InvalidCapacity);
        }
        let (normal_tx, normal_rx) = tokio::sync::mpsc::channel(request.normal_capacity);
        let (panic_tx, panic_rx) = tokio::sync::mpsc::channel(request.panic_capacity);
        let (wake_tx, wake_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let path = request.path;
        let now = request.now;
        let join = std::thread::Builder::new()
            .name("maia-sqlite".to_owned())
            .spawn(move || match open_connection(&path, now) {
                Ok(connection) => {
                    let _ = ready_tx.send(Ok(()));
                    run_owner(connection, panic_rx, normal_rx, wake_rx, done_tx);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            })
            .map_err(|error| StoreError::ThreadSpawn {
                message: error.to_string(),
            })?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                normal_tx: Some(normal_tx),
                panic_tx: Some(panic_tx),
                wake_tx: Some(wake_tx),
                barriers: Mutex::new(Vec::new()),
                done_rx: Some(done_rx),
                join: Some(join),
            }),
            Ok(Err(error)) => {
                let _ = join.join();
                Err(error)
            }
            Err(_) => {
                let _ = join.join();
                Err(StoreError::OwnerStopped)
            }
        }
    }

    /// Checkpoints WAL, joins `maia-sqlite`, and returns a checkpoint failure.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::OwnerStopped`] if the thread panicked, or the
    /// checkpoint error when SQLite cannot flush the WAL.
    pub fn shutdown(mut self) -> Result<(), StoreError> {
        self.stop()
    }

    /// Liveness probe. Does not write.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::QueueFull`] only through [`Self::try_ping`].
    pub fn ping(&self) -> Result<Executed<()>, StoreError> {
        self.enqueue_ping(Submit::Wait)?.wait()
    }

    /// Enqueues a liveness probe without waiting for capacity.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::QueueFull`] when the normal lane is at capacity.
    pub fn try_ping(&self) -> Result<Pending<Executed<()>>, StoreError> {
        self.enqueue_ping(Submit::Try)
    }

    /// Enqueues a hold on the normal lane.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::QueueFull`] when the normal lane is at capacity.
    pub fn try_hold(&self) -> Result<Hold, StoreError> {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        {
            let mut guard = self.barriers.lock().map_err(|_| StoreError::LockPoisoned)?;
            guard.push(release_tx.clone());
        }
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::Hold {
                entered: entered_tx,
                release: release_rx,
                reply,
            },
            Submit::Try,
        )?;
        Ok(Hold {
            entered: entered_rx,
            release: release_tx,
            pending: Some(Pending { rx }),
        })
    }

    /// Name of the owner thread, read on that thread.
    ///
    /// # Errors
    ///
    /// Returns a queue or owner failure.
    pub fn thread_name(&self) -> Result<String, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::ThreadName { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Owner-connection pragmas.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn connection_settings(&self) -> Result<ConnectionSettings, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Settings { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Applied migration rows.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn migrations(&self) -> Result<Vec<MigrationRow>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Migrations { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Appends thread events or replays an identical suffix.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::VersionConflict`] when `expected_version` does not
    /// match and the events are not already the stored suffix.
    pub fn append(&self, request: AppendEvents) -> Result<Executed<AppendOutcome>, StoreError> {
        validate_append(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Append { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Loads one thread log.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the thread has never been created.
    pub fn thread(&self, thread_id: &str) -> Result<ThreadSnapshot, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::Thread {
                thread_id: thread_id.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Inserts an episode, or replays the same canonical write.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::IdempotencyConflict`] when the id exists with a different body.
    pub fn insert_episode(&self, request: EpisodeWrite) -> Result<Executed<()>, StoreError> {
        let _ = episode_canonical(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Episode { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Applies one promotion transaction.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the episode is missing, or a
    /// constraint error when the transaction rolls back.
    pub fn apply_promotion(&self, request: PromotionWrite) -> Result<Executed<()>, StoreError> {
        let _ = promotion_canonical(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Promotion { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Applies one presentation ledger.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::IdempotencyConflict`] when `ledger_id` exists with
    /// a different canonical body. A constraint failure rolls the transaction back.
    pub fn apply_ledger(&self, request: LedgerWrite) -> Result<Executed<()>, StoreError> {
        let _ = ledger_canonical(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Ledger { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Applies one consolidation transaction and enqueues its projection.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when a referenced claim, queue item, or
    /// hold is missing. The transaction rolls back.
    pub fn apply_consolidation(
        &self,
        request: ConsolidationWrite,
    ) -> Result<Executed<()>, StoreError> {
        let _ = consolidation_canonical(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::Consolidation { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Reads the shared brain graph in stable id order.
    ///
    /// # Errors
    ///
    /// Returns a SQLite failure.
    pub fn brain_map(&self) -> Result<BrainMap, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::BrainMap { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Rewrites one fact sentence in place and returns the new map.
    ///
    /// The fact id stays. Linked claim sentences are rewritten to the same text.
    /// Embeddings for the fact and those claims are dropped.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::InvalidRequest`] for an empty or multi-line sentence.
    /// Returns [`StoreError::NotFound`] when the fact id is missing.
    pub fn revise_fact(&self, request: FactRevise) -> Result<Executed<BrainMap>, StoreError> {
        validate_fact_sentence(&request.sentence)?;
        require_text("fact_id", &request.fact_id)?;
        for lexeme in &request.lexemes {
            require_text("lexeme", lexeme)?;
        }
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::ReviseFact { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Deletes one fact and the claims consolidated into it.
    ///
    /// Episode rows stay. Facts that pointed at this id have those pointers cleared.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the fact id is missing.
    /// Returns [`StoreError::InvalidRequest`] when `fact_id` is empty.
    pub fn delete_fact(&self, fact_id: &str) -> Result<Executed<BrainMap>, StoreError> {
        require_text("fact_id", fact_id)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::DeleteFact {
                fact_id: fact_id.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Lists projections whose filesystem phase has not finished.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn pending_projections(&self) -> Result<Vec<PendingProjection>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Pending { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Marks a projection complete. A second call keeps the first completion time.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the batch has no projection row.
    pub fn complete_projection(
        &self,
        request: CompleteProjection,
    ) -> Result<Executed<i64>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Complete { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Appends one audit event and its checkpoint.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::AuditChainInvalid`] when the sequence or predecessor
    /// hash does not extend the stored chain.
    pub fn append_audit(&self, request: AuditAppend) -> Result<Executed<()>, StoreError> {
        validate_audit(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Audit { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Latest checkpoint, if any event has been stored.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn audit_head(&self) -> Result<Option<AuditHead>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::AuditHead { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Current panic latch.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn panic_latch(&self) -> Result<PanicLatch, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Latch { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Engages panic on the priority lane and writes its audit event in one transaction.
    ///
    /// A second engage while the latch is already engaged does not append another event.
    ///
    /// # Errors
    ///
    /// Returns an audit or SQLite error. The latch update rolls back with the audit insert.
    pub fn engage_panic(&self, request: EngagePanic) -> Result<Executed<PanicLatch>, StoreError> {
        self.enqueue_engage(request, Submit::Wait)?.wait()
    }

    /// Enqueues panic engagement without waiting for normal-lane capacity.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::QueueFull`] when the panic lane itself is full.
    pub fn try_engage_panic(
        &self,
        request: EngagePanic,
    ) -> Result<Pending<Executed<PanicLatch>>, StoreError> {
        self.enqueue_engage(request, Submit::Try)
    }

    /// Clears panic on the priority lane.
    ///
    /// Clearing does not change the generation. A second clear does not append another event.
    ///
    /// # Errors
    ///
    /// Returns an audit or SQLite error.
    pub fn clear_panic(&self, request: ClearPanic) -> Result<Executed<PanicLatch>, StoreError> {
        validate_audit(&request.audit)?;
        let (reply, rx) = oneshot::channel();
        self.send_panic(PanicCommand::Clear { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Replaces the singleton security profile.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::InvalidRequest`] when confirmation does not match the profile.
    pub fn put_security_settings(
        &self,
        request: SecuritySettingsWrite,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::PutSettings { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Reads the security profile, if onboarding has written one.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn security_settings(&self) -> Result<Option<SecuritySettingsWrite>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::GetSettings { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Inserts an allowlist entry. The same id and body replays; a different body conflicts.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::IdempotencyConflict`] when `grant_id` is already stored differently.
    pub fn put_allowlist(&self, request: AllowlistEntryWrite) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::PutAllowlist { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Changes only the enabled flag. Profile switches do not call this.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the grant id is absent.
    pub fn set_allowlist_enabled(
        &self,
        grant_id: &str,
        enabled: bool,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::SetEnabled {
                grant_id: grant_id.to_owned(),
                enabled,
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Allowlist rows in grant-id order.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn allowlist(&self) -> Result<Vec<AllowlistEntryWrite>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Allowlist { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Replaces the singleton credential backend selection.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn put_credential_backend(
        &self,
        request: CredentialBackendWrite,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::PutBackend { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Credential backend, if onboarding has selected one.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn credential_backend(&self) -> Result<Option<CredentialBackendWrite>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Backend { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Replaces the saved model endpoint. The API key is not accepted here.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure, or an invalid endpoint field.
    pub fn put_model_connection(
        &self,
        request: ModelConnectionRecord,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::PutModelConnection { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Saved model endpoint, if Settings has written one.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn model_connection(&self) -> Result<Option<ModelConnectionRecord>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::ModelConnection { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Inserts a capability snapshot and retains the newest 32.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::IdempotencyConflict`] when the snapshot id exists with a different body.
    pub fn put_capability_snapshot(
        &self,
        request: CapabilitySnapshotWrite,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::PutSnapshot { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Snapshots from oldest to newest.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn capability_snapshots(&self) -> Result<Vec<CapabilitySnapshotWrite>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Snapshots { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Stored embedding models in model-id order.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn embedding_models(&self) -> Result<Vec<EmbeddingModelWrite>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Models { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Records embedding model metadata.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::InvalidRequest`] when the width is not the v1 width.
    pub fn put_embedding_model(
        &self,
        request: EmbeddingModelWrite,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::PutModel { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Inserts a vector, or replays equal bytes.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::IdempotencyConflict`] when the target already has different bytes.
    pub fn upsert_embedding(&self, request: EmbeddingWrite) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Upsert { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Loads one stored vector.
    ///
    /// # Errors
    ///
    /// Returns a SQLite or decode failure. Absence is `Ok(None)`.
    pub fn embedding(
        &self,
        target: EmbeddingTarget,
        target_id: &str,
    ) -> Result<Option<Vec<f32>>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::Embedding {
                target,
                target_id: target_id.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Full-text search over episode or claim text.
    ///
    /// # Errors
    ///
    /// Returns a SQLite failure when the query is not valid FTS5 syntax.
    pub fn search(&self, kind: TextSearch, query: &str) -> Result<Vec<String>, StoreError> {
        require_fts_query(query)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::Search {
                kind,
                query: query.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// `vec_version()` from the owner connection.
    ///
    /// # Errors
    ///
    /// Returns a SQLite failure when sqlite-vec is not registered.
    pub fn vec_version(&self) -> Result<String, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::VecVersion { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Version row sqlite-vec stored beside a vec0 table.
    ///
    /// # Errors
    ///
    /// Returns a SQLite failure when the shadow info table is missing.
    pub fn vec_metadata(&self, table: VecTable) -> Result<VecVersionMetadata, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::VecMetadata { table, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Appends one router transcript message with the next ordinal.
    pub fn insert_router_message(
        &self,
        request: RouterMessageWrite,
    ) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_router_message(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::RouterMessage { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Looks up one client operation and rejects a different text replay.
    pub fn lookup_message_submission(
        &self,
        operation_id: &str,
        text: &str,
    ) -> Result<MessageSubmissionState, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::LookupMessageSubmission {
                operation_id: operation_id.to_owned(),
                text: text.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Atomically inserts a pending operation and its owner transcript row.
    pub fn begin_message_submission(
        &self,
        request: MessageSubmissionWrite,
    ) -> Result<Executed<MessageSubmissionState>, StoreError> {
        super_agent_ops::validate_message_submission(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::BeginMessageSubmission { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Stores one terminal public-safe outcome for replay.
    pub fn finish_message_submission(
        &self,
        operation_id: &str,
        outcome: StoredSubmissionOutcome,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::FinishMessageSubmission {
                operation_id: operation_id.to_owned(),
                outcome,
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Next numeric `m-N` sequence after all durable message identifiers.
    pub fn next_message_sequence(&self) -> Result<u64, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::NextMessageSequence { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Loads the complete durable Super Agent startup state and ID high-water marks.
    pub fn runtime_snapshot(&self) -> Result<RuntimeSnapshot, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::RuntimeSnapshot { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Atomically reserves the same checked block size in every runtime ID namespace.
    pub fn reserve_runtime_id_block(&self, count: u64) -> Result<RuntimeIdBlock, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::ReserveRuntimeIds { count, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Creates a task session row and its opening attempt in one transaction.
    pub fn insert_task(&self, request: TaskWrite) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_task(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::InsertTask { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Creates the complete opening parent-task aggregate in one transaction.
    pub fn insert_task_aggregate(
        &self,
        request: TaskAggregateWrite,
    ) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_task_aggregate(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::InsertTaskAggregate { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Inserts sealed envelope bytes. Prompt rows are never updated.
    pub fn insert_task_envelope(
        &self,
        request: TaskEnvelopeWrite,
    ) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_envelope(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::TaskEnvelope { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Loads sealed prompt bytes for one task.
    pub fn load_prompt(&self, task_id: &str) -> Result<Vec<u8>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::LoadPrompt {
                task_id: task_id.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Appends one continuation input row.
    pub fn insert_task_input(&self, request: TaskInputWrite) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_task_input(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::TaskInput { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Atomically compares and advances a task phase with an optional input insert.
    pub fn continue_task(&self, request: ContinueTaskWrite) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::ContinueTask { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Replaces only the stored phase string for one existing task.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the task does not exist, or a
    /// validation error when the phase text is empty or over the prose cap.
    pub fn update_task_phase(
        &self,
        task_id: &str,
        phase: &str,
    ) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_phase(task_id, phase)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::UpdateTaskPhase {
                task_id: task_id.to_owned(),
                phase: phase.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Loads the stored phase string for one task.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the task does not exist.
    pub fn load_task_phase(&self, task_id: &str) -> Result<String, StoreError> {
        super_agent_ops::validate_task_id(task_id)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::LoadTaskPhase {
                task_id: task_id.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Stores advisory snapshot items in ordinal order.
    ///
    /// An identical replay commits. A different body for the same snapshot id
    /// conflicts and leaves the stored rows unchanged.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::IdempotencyConflict`] when the snapshot is already
    /// stored with different items, or a validation error for an empty field.
    pub fn insert_context_snapshot(
        &self,
        snapshot_id: &str,
        items: &[SnapshotItemWrite],
    ) -> Result<Executed<()>, StoreError> {
        require_text("snapshot_id", snapshot_id)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::InsertContextSnapshot {
                snapshot_id: snapshot_id.to_owned(),
                items: items.to_vec(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Inserts one sealed criterion. An identical replay commits.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the task is missing,
    /// [`StoreError::IdempotencyConflict`] when the id is stored with different
    /// bytes, or a validation error for an empty field or a one-sided span.
    pub fn insert_task_criterion(
        &self,
        request: TaskCriterionWrite,
    ) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_criterion(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::InsertTaskCriterion { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Reads one parent inspection without writing.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the task or envelope is missing.
    pub fn load_task_view(&self, task_id: &str) -> Result<TaskView, StoreError> {
        super_agent_ops::validate_task_id(task_id)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::LoadTaskView {
                task_id: task_id.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Reads every parent task runtime view in creation order.
    ///
    /// # Errors
    ///
    /// Returns a store error when any task lacks its required envelope or
    /// another persisted field cannot be decoded.
    pub fn list_task_views(&self) -> Result<Vec<TaskView>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::ListTaskViews { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Inserts one attempt on an existing task.
    ///
    /// An identical replay commits. A different state for the same attempt id
    /// conflicts and leaves the stored state unchanged.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the task is missing,
    /// [`StoreError::IdempotencyConflict`] when the attempt is stored with a
    /// different state, or a validation error for an empty or oversized field.
    pub fn insert_task_attempt(
        &self,
        request: TaskAttemptWrite,
    ) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_attempt(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::InsertTaskAttempt { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Atomically stores a retry attempt and advances the expected task phase.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::IdempotencyConflict`] when the stored phase or
    /// attempt body differs, and rolls both writes back on any failure.
    pub fn retry_task_phase(
        &self,
        request: TaskAttemptWrite,
        expected_phase: &str,
        next_phase: &str,
    ) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_attempt(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::RetryTaskPhase {
                request,
                expected_phase: expected_phase.to_owned(),
                next_phase: next_phase.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Inserts one evidence row. An identical replay succeeds; a different body does not.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the task or attempt is missing,
    /// [`StoreError::IdempotencyConflict`] when the id is already stored with
    /// different bytes, or a validation error for an empty or oversized body.
    pub fn insert_task_evidence(
        &self,
        request: TaskEvidenceWrite,
    ) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_evidence(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::InsertTaskEvidence { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Loads one evidence row by id.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the evidence id is not stored.
    pub fn load_task_evidence(&self, evidence_id: &str) -> Result<TaskEvidenceWrite, StoreError> {
        super_agent_ops::validate_evidence_id(evidence_id)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::LoadTaskEvidence {
                evidence_id: evidence_id.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Stores one structured task report.
    pub fn insert_report(&self, request: TaskReportWrite) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_report(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::TaskReport { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Stores one child assignment under a parent task or parent child.
    pub fn insert_child(&self, request: ChildAssignmentWrite) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_child(&request)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::ChildAssignment { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Reads every child link in child-id order.
    pub fn list_child_links(&self) -> Result<Vec<ChildLink>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::ListChildLinks { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Sets one child phase. The same phase commits again.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when the child is missing, or a
    /// validation error for an empty or oversized phase. A missing child does
    /// not write a row.
    pub fn update_child_phase(
        &self,
        child_id: &str,
        phase: &str,
    ) -> Result<Executed<()>, StoreError> {
        require_text("child_id", child_id)?;
        require_text("phase", phase)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::UpdateChildPhase {
                child_id: child_id.to_owned(),
                phase: phase.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Sets every listed child phase in one immediate transaction.
    ///
    /// An empty list commits nothing. If any id is missing, the transaction
    /// rolls back and no listed phase changes.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::NotFound`] when a child id is missing,
    /// [`StoreError::InvalidRequest`] when an id is empty, or a limit error
    /// when the phase text is oversized.
    pub fn update_child_phases(
        &self,
        child_ids: &[String],
        phase: &str,
    ) -> Result<Executed<()>, StoreError> {
        if child_ids.is_empty() {
            return Ok(Executed {
                sequence: 0,
                value: (),
            });
        }
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::UpdateChildPhases {
                child_ids: child_ids.to_vec(),
                phase: phase.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Atomically compares and updates all parent and descendant host phases.
    pub fn apply_host_mutation(
        &self,
        request: HostMutationWrite,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::ApplyHostMutation { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Updates the stored pin mark for one task.
    pub fn set_pin(&self, task_id: &str, pin: &str) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_pin(pin)?;
        require_text("task_id", task_id)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::SetPin {
                task_id: task_id.to_owned(),
                pin: pin.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Updates the stored completion view encoding for one task.
    pub fn set_completion_view(
        &self,
        task_id: &str,
        view: &str,
    ) -> Result<Executed<()>, StoreError> {
        super_agent_ops::validate_completion_view(view)?;
        require_text("task_id", task_id)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::SetCompletionView {
                task_id: task_id.to_owned(),
                view: view.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Marks every existing thread row as legacy without deleting events.
    pub fn mark_legacy_threads(&self, marked_at: i64) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::MarkLegacyThreads { marked_at, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Legacy thread ids in lexicographic order.
    pub fn legacy_thread_ids(&self) -> Result<Vec<String>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::LegacyThreadIds { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Stores one completed router turn for the inspector.
    ///
    /// # Errors
    ///
    /// Returns a queue, validation, or SQLite failure. A repeated message id conflicts.
    pub fn insert_router_turn(&self, request: RouterTurnWrite) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::InsertRouterTurn { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Inserts one MCP connection. The row has no admitted hash and no secret value.
    ///
    /// # Errors
    ///
    /// Returns a queue, validation, or SQLite failure.
    pub fn create_mcp(
        &self,
        request: McpConnectionRecord,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::CreateMcp { request, reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Replaces the transport and clears the admitted hash and listed manifest.
    ///
    /// # Errors
    ///
    /// Returns a queue, validation, or SQLite failure.
    pub fn replace_mcp_transport(
        &self,
        id: impl Into<String>,
        transport: McpTransportRecord,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::ReplaceMcpTransport {
                id: id.into(),
                transport,
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Changes the owner label and leaves the admitted hash in place.
    ///
    /// # Errors
    ///
    /// Returns a queue, validation, or SQLite failure.
    pub fn update_mcp_label(
        &self,
        id: impl Into<String>,
        label: impl Into<String>,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::UpdateMcpLabel {
                id: id.into(),
                label: label.into(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Deletes one MCP connection and its secret references.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn delete_mcp(&self, id: impl Into<String>) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::DeleteMcp {
                id: id.into(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Lists MCP connections in id order.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn list_mcp(&self) -> Result<Vec<McpConnectionRecord>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::ListMcp { reply }, Submit::Wait)?;
        Pending { rx }.wait()
    }

    /// Stores a successful tool list and clears the refresh error.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn store_mcp_list(
        &self,
        id: impl Into<String>,
        canonical: impl Into<String>,
        hash: impl Into<String>,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::StoreMcpList {
                id: id.into(),
                canonical: canonical.into(),
                hash: hash.into(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Records a failed refresh without clearing the admitted hash.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn set_mcp_refresh_error(
        &self,
        id: impl Into<String>,
        message: impl Into<String>,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::SetMcpRefreshError {
                id: id.into(),
                message: message.into(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Admits a hash that matches the stored list.
    ///
    /// # Errors
    ///
    /// Returns a queue, validation, or SQLite failure.
    pub fn admit_mcp(
        &self,
        id: impl Into<String>,
        hash: impl Into<String>,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::AdmitMcp {
                id: id.into(),
                hash: hash.into(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Clears the admitted hash and keeps the listed manifest.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn revoke_mcp(&self, id: impl Into<String>) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::RevokeMcp {
                id: id.into(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Replaces advisory guidance for one task.
    ///
    /// # Errors
    ///
    /// Returns a queue, validation, or SQLite failure.
    pub fn put_task_guidance(
        &self,
        task_id: impl Into<String>,
        guidance: impl Into<String>,
    ) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::PutTaskGuidance {
                task_id: task_id.into(),
                guidance: guidance.into(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Latest advisory guidance for one task.
    ///
    /// # Errors
    ///
    /// Returns a queue or SQLite failure.
    pub fn task_guidance(&self, task_id: impl Into<String>) -> Result<Option<String>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::TaskGuidance {
                task_id: task_id.into(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Appends an MCP audit row that has no argument or result body.
    ///
    /// # Errors
    ///
    /// Returns a queue, validation, or SQLite failure.
    pub fn insert_mcp_audit(&self, request: McpAuditWrite) -> Result<Executed<()>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::InsertMcpAudit { request, reply },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    /// Assembles a read-only inspection view from stored rows.
    pub fn task_inspection(&self, task_id: &str) -> Result<TaskInspection, StoreError> {
        require_text("task_id", task_id)?;
        let (reply, rx) = oneshot::channel();
        self.send_normal(
            NormalCommand::TaskInspection {
                task_id: task_id.to_owned(),
                reply,
            },
            Submit::Wait,
        )?;
        Pending { rx }.wait()
    }

    fn enqueue_ping(&self, mode: Submit) -> Result<Pending<Executed<()>>, StoreError> {
        let (reply, rx) = oneshot::channel();
        self.send_normal(NormalCommand::Ping { reply }, mode)?;
        Ok(Pending { rx })
    }

    fn enqueue_engage(
        &self,
        request: EngagePanic,
        mode: Submit,
    ) -> Result<Pending<Executed<PanicLatch>>, StoreError> {
        validate_audit(&request.audit)?;
        let (reply, rx) = oneshot::channel();
        self.send_panic(PanicCommand::Engage { request, reply }, mode)?;
        Ok(Pending { rx })
    }

    fn send_normal(&self, command: NormalCommand, mode: Submit) -> Result<(), StoreError> {
        let sender = self.normal_tx.as_ref().ok_or(StoreError::OwnerStopped)?;
        match mode {
            Submit::Try => match sender.try_send(command) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => return Err(StoreError::QueueFull),
                Err(TrySendError::Closed(_)) => return Err(StoreError::OwnerStopped),
            },
            Submit::Wait => sender
                .blocking_send(command)
                .map_err(|_| StoreError::OwnerStopped)?,
        }
        self.wake_tx
            .as_ref()
            .ok_or(StoreError::OwnerStopped)?
            .send(())
            .map_err(|_| StoreError::OwnerStopped)
    }

    fn send_panic(&self, command: PanicCommand, mode: Submit) -> Result<(), StoreError> {
        let sender = self.panic_tx.as_ref().ok_or(StoreError::OwnerStopped)?;
        match mode {
            Submit::Try => match sender.try_send(command) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => return Err(StoreError::QueueFull),
                Err(TrySendError::Closed(_)) => return Err(StoreError::OwnerStopped),
            },
            Submit::Wait => sender
                .blocking_send(command)
                .map_err(|_| StoreError::OwnerStopped)?,
        }
        self.wake_tx
            .as_ref()
            .ok_or(StoreError::OwnerStopped)?
            .send(())
            .map_err(|_| StoreError::OwnerStopped)
    }

    fn stop(&mut self) -> Result<(), StoreError> {
        self.release_barriers();
        self.normal_tx.take();
        self.panic_tx.take();
        self.wake_tx.take();
        let joined = match self.join.take() {
            Some(handle) => handle.join(),
            None => return Ok(()),
        };
        if joined.is_err() {
            return Err(StoreError::OwnerStopped);
        }
        match self.done_rx.take() {
            Some(done) => match done.recv() {
                Ok(result) => result,
                Err(_) => Err(StoreError::OwnerStopped),
            },
            None => Ok(()),
        }
    }

    fn release_barriers(&self) {
        let Ok(mut guard) = self.barriers.lock() else {
            return;
        };
        for sender in guard.drain(..) {
            let _ = sender.send(());
        }
    }
}

impl Drop for SqliteOwner {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn open_connection(path: &std::path::Path, now: i64) -> Result<rusqlite::Connection, StoreError> {
    register_sqlite_vec()?;
    migrate::with_schema_lock_retry(|| open_connection_once(path, now))
}

fn open_connection_once(
    path: &std::path::Path,
    now: i64,
) -> Result<rusqlite::Connection, StoreError> {
    let mut connection = rusqlite::Connection::open(path)?;
    connection.busy_timeout(crate::migrate::SCHEMA_LOCK_BUSY_TIMEOUT)?;
    let mode: String =
        connection.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
    if mode != "wal" {
        return Err(StoreError::Sqlite {
            message: format!("journal mode is {mode}"),
            schema_lock_contention: false,
        });
    }
    connection.pragma_update(None, "foreign_keys", 1_i64)?;
    migrate::apply(&mut connection, now)?;
    audit_ops::verify(&connection)?;
    Ok(connection)
}

fn run_owner(
    mut connection: rusqlite::Connection,
    mut panic_rx: tokio::sync::mpsc::Receiver<PanicCommand>,
    mut normal_rx: tokio::sync::mpsc::Receiver<NormalCommand>,
    wake_rx: mpsc::Receiver<()>,
    done_tx: mpsc::Sender<Result<(), StoreError>>,
) {
    let mut sequence = 0_u64;
    loop {
        match wake_rx.recv() {
            Ok(()) => {
                sequence = drain_panic(&mut connection, &mut panic_rx, sequence);
                if let Ok(command) = normal_rx.try_recv() {
                    sequence += 1;
                    dispatch_normal(&mut connection, command, sequence);
                }
            }
            Err(_) => {
                sequence = drain_panic(&mut connection, &mut panic_rx, sequence);
                while let Ok(command) = normal_rx.try_recv() {
                    sequence += 1;
                    dispatch_normal(&mut connection, command, sequence);
                }
                break;
            }
        }
    }
    let checkpoint = connection
        .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
        .map_err(StoreError::from);
    let _ = done_tx.send(checkpoint);
}

fn drain_panic(
    connection: &mut rusqlite::Connection,
    panic_rx: &mut tokio::sync::mpsc::Receiver<PanicCommand>,
    mut sequence: u64,
) -> u64 {
    while let Ok(command) = panic_rx.try_recv() {
        sequence += 1;
        dispatch_panic(connection, command, sequence);
    }
    sequence
}

fn dispatch_panic(connection: &mut rusqlite::Connection, command: PanicCommand, sequence: u64) {
    match command {
        PanicCommand::Engage { request, reply } => {
            executed(reply, sequence, audit_ops::engage(connection, &request));
        }
        PanicCommand::Clear { request, reply } => {
            executed(reply, sequence, audit_ops::clear(connection, &request));
        }
    }
}

fn dispatch_normal(connection: &mut rusqlite::Connection, command: NormalCommand, sequence: u64) {
    match command {
        NormalCommand::Ping { reply } => executed(reply, sequence, Ok(())),
        NormalCommand::ThreadName { reply } => {
            let name = std::thread::current().name().unwrap_or("").to_owned();
            send(reply, Ok(name));
        }
        NormalCommand::Settings { reply } => send(reply, connection_settings(connection)),
        NormalCommand::Migrations { reply } => send(reply, migrate::rows(connection)),
        NormalCommand::Hold {
            entered,
            release,
            reply,
        } => {
            let _ = entered.send(());
            let _ = release.recv();
            executed(reply, sequence, Ok(()));
        }
        NormalCommand::Append { request, reply } => {
            executed(reply, sequence, thread_ops::append(connection, &request));
        }
        NormalCommand::Thread { thread_id, reply } => {
            send(reply, thread_ops::snapshot(connection, &thread_id))
        }
        NormalCommand::Episode { request, reply } => {
            executed(
                reply,
                sequence,
                dream_ops::insert_episode(connection, &request),
            );
        }
        NormalCommand::Promotion { request, reply } => {
            executed(
                reply,
                sequence,
                dream_ops::apply_promotion(connection, &request),
            );
        }
        NormalCommand::Ledger { request, reply } => {
            executed(reply, sequence, ledger_ops::apply(connection, &request));
        }
        NormalCommand::Consolidation { request, reply } => {
            executed(
                reply,
                sequence,
                dream_ops::apply_consolidation(connection, &request),
            );
        }
        NormalCommand::BrainMap { reply } => send(reply, brain_ops::map(connection)),
        NormalCommand::ReviseFact { request, reply } => {
            executed(reply, sequence, brain_ops::revise(connection, &request));
        }
        NormalCommand::DeleteFact { fact_id, reply } => {
            executed(reply, sequence, brain_ops::delete(connection, &fact_id));
        }
        NormalCommand::Pending { reply } => send(reply, dream_ops::pending(connection)),
        NormalCommand::Complete { request, reply } => {
            executed(reply, sequence, dream_ops::complete(connection, &request));
        }
        NormalCommand::Audit { request, reply } => {
            executed(reply, sequence, audit_ops::append(connection, &request))
        }
        NormalCommand::AuditHead { reply } => send(reply, audit_ops::head(connection)),
        NormalCommand::Latch { reply } => send(reply, audit_ops::read_latch(connection)),
        NormalCommand::PutSettings { request, reply } => {
            executed(
                reply,
                sequence,
                security_ops::put_settings(connection, &request),
            );
        }
        NormalCommand::GetSettings { reply } => send(reply, security_ops::settings(connection)),
        NormalCommand::PutAllowlist { request, reply } => {
            executed(
                reply,
                sequence,
                security_ops::put_allowlist(connection, &request),
            );
        }
        NormalCommand::SetEnabled {
            grant_id,
            enabled,
            reply,
        } => {
            executed(
                reply,
                sequence,
                security_ops::set_enabled(connection, &grant_id, enabled),
            );
        }
        NormalCommand::Allowlist { reply } => send(reply, security_ops::allowlist(connection)),
        NormalCommand::PutBackend { request, reply } => {
            executed(
                reply,
                sequence,
                security_ops::put_backend(connection, &request),
            );
        }
        NormalCommand::Backend { reply } => send(reply, security_ops::backend(connection)),
        NormalCommand::PutModelConnection { request, reply } => {
            executed(
                reply,
                sequence,
                model_connection_ops::put(connection, &request),
            );
        }
        NormalCommand::ModelConnection { reply } => {
            send(reply, model_connection_ops::get(connection))
        }
        NormalCommand::PutSnapshot { request, reply } => {
            executed(
                reply,
                sequence,
                security_ops::put_snapshot(connection, &request),
            );
        }
        NormalCommand::Snapshots { reply } => send(reply, security_ops::snapshots(connection)),
        NormalCommand::PutModel { request, reply } => {
            executed(reply, sequence, embed_ops::put_model(connection, &request));
        }
        NormalCommand::Models { reply } => send(reply, embed_ops::models(connection)),
        NormalCommand::Upsert { request, reply } => {
            executed(reply, sequence, embed_ops::upsert(connection, &request))
        }
        NormalCommand::Embedding {
            target,
            target_id,
            reply,
        } => {
            send(reply, embed_ops::embedding(connection, target, &target_id));
        }
        NormalCommand::Search { kind, query, reply } => {
            send(reply, dream_ops::search(connection, kind, &query))
        }
        NormalCommand::VecVersion { reply } => send(reply, embed_ops::vec_version(connection)),
        NormalCommand::VecMetadata { table, reply } => {
            send(reply, embed_ops::vec_metadata(connection, table))
        }
        NormalCommand::RouterMessage { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_router_message(connection, &request),
            );
        }
        NormalCommand::LookupMessageSubmission {
            operation_id,
            text,
            reply,
        } => {
            send(
                reply,
                super_agent_ops::lookup_message_submission(connection, &operation_id, &text),
            );
        }
        NormalCommand::BeginMessageSubmission { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::begin_message_submission(connection, &request),
            );
        }
        NormalCommand::FinishMessageSubmission {
            operation_id,
            outcome,
            reply,
        } => {
            executed(
                reply,
                sequence,
                super_agent_ops::finish_message_submission(connection, &operation_id, &outcome),
            );
        }
        NormalCommand::NextMessageSequence { reply } => {
            send(reply, super_agent_ops::next_message_sequence(connection));
        }
        NormalCommand::RuntimeSnapshot { reply } => {
            send(reply, super_agent_ops::runtime_snapshot(connection));
        }
        NormalCommand::ReserveRuntimeIds { count, reply } => {
            send(
                reply,
                super_agent_ops::reserve_runtime_id_block(connection, count),
            );
        }
        NormalCommand::InsertTask { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_task(connection, &request),
            );
        }
        NormalCommand::InsertTaskAggregate { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_task_aggregate(connection, &request),
            );
        }
        NormalCommand::TaskEnvelope { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_task_envelope(connection, &request),
            );
        }
        NormalCommand::LoadPrompt { task_id, reply } => {
            send(reply, super_agent_ops::load_prompt(connection, &task_id));
        }
        NormalCommand::TaskInput { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_task_input(connection, &request),
            );
        }
        NormalCommand::ContinueTask { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::continue_task(connection, &request),
            );
        }
        NormalCommand::TaskReport { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_report(connection, &request),
            );
        }
        NormalCommand::UpdateTaskPhase {
            task_id,
            phase,
            reply,
        } => {
            executed(
                reply,
                sequence,
                super_agent_ops::update_task_phase(connection, &task_id, &phase),
            );
        }
        NormalCommand::LoadTaskPhase { task_id, reply } => {
            send(
                reply,
                super_agent_ops::load_task_phase(connection, &task_id),
            );
        }
        NormalCommand::InsertTaskEvidence { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_task_evidence(connection, &request),
            );
        }
        NormalCommand::InsertTaskAttempt { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_task_attempt(connection, &request),
            );
        }
        NormalCommand::RetryTaskPhase {
            request,
            expected_phase,
            next_phase,
            reply,
        } => {
            executed(
                reply,
                sequence,
                super_agent_ops::retry_task_phase(
                    connection,
                    &request,
                    &expected_phase,
                    &next_phase,
                ),
            );
        }
        NormalCommand::InsertTaskCriterion { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_task_criterion(connection, &request),
            );
        }
        NormalCommand::LoadTaskView { task_id, reply } => {
            send(reply, super_agent_ops::load_task_view(connection, &task_id));
        }
        NormalCommand::ListTaskViews { reply } => {
            send(reply, super_agent_ops::list_task_views(connection));
        }
        NormalCommand::InsertContextSnapshot {
            snapshot_id,
            items,
            reply,
        } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_context_snapshot(connection, &snapshot_id, &items),
            );
        }
        NormalCommand::LoadTaskEvidence { evidence_id, reply } => {
            send(
                reply,
                super_agent_ops::load_task_evidence(connection, &evidence_id),
            );
        }
        NormalCommand::ChildAssignment { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::insert_child(connection, &request),
            );
        }
        NormalCommand::ListChildLinks { reply } => {
            send(reply, super_agent_ops::list_child_links(connection));
        }
        NormalCommand::UpdateChildPhase {
            child_id,
            phase,
            reply,
        } => {
            executed(
                reply,
                sequence,
                super_agent_ops::update_child_phase(connection, &child_id, &phase),
            );
        }
        NormalCommand::UpdateChildPhases {
            child_ids,
            phase,
            reply,
        } => {
            executed(
                reply,
                sequence,
                super_agent_ops::update_child_phases(connection, &child_ids, &phase),
            );
        }
        NormalCommand::ApplyHostMutation { request, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::apply_host_mutation(connection, &request),
            );
        }
        NormalCommand::SetPin {
            task_id,
            pin,
            reply,
        } => {
            executed(
                reply,
                sequence,
                super_agent_ops::set_pin(connection, &task_id, &pin),
            );
        }
        NormalCommand::SetCompletionView {
            task_id,
            view,
            reply,
        } => {
            executed(
                reply,
                sequence,
                super_agent_ops::set_completion_view(connection, &task_id, &view),
            );
        }
        NormalCommand::MarkLegacyThreads { marked_at, reply } => {
            executed(
                reply,
                sequence,
                super_agent_ops::mark_legacy_threads(connection, marked_at),
            );
        }
        NormalCommand::LegacyThreadIds { reply } => {
            send(reply, super_agent_ops::legacy_thread_ids(connection));
        }
        NormalCommand::TaskInspection { task_id, reply } => {
            send(
                reply,
                super_agent_ops::task_inspection(connection, &task_id),
            );
        }
        NormalCommand::InsertRouterTurn { request, reply } => {
            executed(
                reply,
                sequence,
                inspector_ops::insert_router_turn(connection, &request),
            );
        }
        NormalCommand::CreateMcp { request, reply } => {
            executed(reply, sequence, mcp_ops::create(connection, &request));
        }
        NormalCommand::ReplaceMcpTransport {
            id,
            transport,
            reply,
        } => {
            executed(
                reply,
                sequence,
                mcp_ops::replace_transport(connection, &id, &transport),
            );
        }
        NormalCommand::UpdateMcpLabel { id, label, reply } => {
            executed(reply, sequence, mcp_ops::update_label(connection, &id, &label));
        }
        NormalCommand::DeleteMcp { id, reply } => {
            executed(reply, sequence, mcp_ops::delete(connection, &id));
        }
        NormalCommand::ListMcp { reply } => send(reply, mcp_ops::list(connection)),
        NormalCommand::StoreMcpList {
            id,
            canonical,
            hash,
            reply,
        } => {
            executed(
                reply,
                sequence,
                mcp_ops::store_list(connection, &id, &canonical, &hash),
            );
        }
        NormalCommand::SetMcpRefreshError { id, message, reply } => {
            executed(
                reply,
                sequence,
                mcp_ops::set_refresh_error(connection, &id, &message),
            );
        }
        NormalCommand::AdmitMcp { id, hash, reply } => {
            executed(reply, sequence, mcp_ops::admit(connection, &id, &hash));
        }
        NormalCommand::RevokeMcp { id, reply } => {
            executed(reply, sequence, mcp_ops::revoke(connection, &id));
        }
        NormalCommand::PutTaskGuidance {
            task_id,
            guidance,
            reply,
        } => {
            executed(
                reply,
                sequence,
                mcp_ops::put_guidance(connection, &task_id, &guidance),
            );
        }
        NormalCommand::TaskGuidance { task_id, reply } => {
            send(reply, mcp_ops::guidance(connection, &task_id));
        }
        NormalCommand::InsertMcpAudit { request, reply } => {
            executed(reply, sequence, mcp_ops::insert_audit(connection, &request));
        }
    }
}

fn connection_settings(
    connection: &rusqlite::Connection,
) -> Result<ConnectionSettings, StoreError> {
    let journal_mode: String =
        connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    let foreign_keys: i64 =
        connection.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    let user_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    Ok(ConnectionSettings {
        journal_mode,
        foreign_keys,
        user_version,
    })
}

fn send<T>(reply: Reply<T>, result: Result<T, StoreError>) {
    let _ = reply.send(result);
}

fn executed<T>(reply: Reply<Executed<T>>, sequence: u64, result: Result<T, StoreError>) {
    send(reply, result.map(|value| Executed { sequence, value }));
}
