//! Slice B contract: one blocking SQLite owner, forward-only migrations, and sqlite-vec.

use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::thread;

use rusqlite::Connection;
use rusqlite::types::Value;

use maia_store::AllowlistEntryWrite;
use maia_store::AppendEvents;
use maia_store::AppendOutcome;
use maia_store::AuditActor;
use maia_store::AuditAppend;
use maia_store::BrainMap;
use maia_store::BrainNode;
use maia_store::BrainNodeKind;
use maia_store::CapabilitySnapshotWrite;
use maia_store::ClearPanic;
use maia_store::ClosureWrite;
use maia_store::CoUseWrite;
use maia_store::CompleteProjection;
use maia_store::ConsolidationWrite;
use maia_store::CredentialBackend;
use maia_store::CredentialBackendWrite;
use maia_store::EmbeddingModelWrite;
use maia_store::EmbeddingTarget;
use maia_store::EmbeddingWrite;
use maia_store::EngagePanic;
use maia_store::EntityScope;
use maia_store::EntityWrite;
use maia_store::EpisodeWrite;
use maia_store::EvidenceSource;
use maia_store::Executed;
use maia_store::FactRevise;
use maia_store::FactWrite;
use maia_store::GrantLifetime;
use maia_store::HeatWrite;
use maia_store::HoldTarget;
use maia_store::LedgerWrite;
use maia_store::MAX_AUDIT_CANONICAL_BYTES;
use maia_store::MAX_AUDIT_PAYLOAD_BYTES;
use maia_store::MAX_FTS_QUERY_BYTES;
use maia_store::MAX_PROSE_BYTES;
use maia_store::MAX_THREAD_BATCH_BYTES;
use maia_store::MAX_THREAD_EVENT_BODY_BYTES;
use maia_store::MAX_THREAD_EVENTS_PER_APPEND;
use maia_store::MatcherKind;
use maia_store::MemoryKind;
use maia_store::MemoryTaint;
use maia_store::MergeWrite;
use maia_store::NearestClaimRow;
use maia_store::NegativeMarkWrite;
use maia_store::OwnerOpen;
use maia_store::PendingPromotionRow;
use maia_store::PlatformKind;
use maia_store::PresentationWrite;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionFailureNote;
use maia_store::PromotionReplaceWrite;
use maia_store::PromotionWrite;
use maia_store::ResourceLimit;
use maia_store::SecurityProfile;
use maia_store::SecuritySettingsWrite;
use maia_store::SegmentWrite;
use maia_store::SqliteOwner;
use maia_store::StoreError;
use maia_store::SupersedeWrite;
use maia_store::TextSearch;
use maia_store::ThreadEventWrite;
use maia_store::VecRegistrationGate;
use maia_store::VecTable;
use maia_store::classify_vec_registration;
use maia_store::register_sqlite_vec;
use maia_store::sqlite_vec_registration_entries;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

struct TestDb {
    directory: PathBuf,
    file: PathBuf,
    owner: Option<SqliteOwner>,
    keep_files: bool,
}

impl TestDb {
    fn open(name: &str, now: i64) -> Self {
        Self::open_with_capacity(name, now, 8, 2)
    }

    fn open_with_capacity(
        name: &str,
        now: i64,
        normal_capacity: usize,
        panic_capacity: usize,
    ) -> Self {
        let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let mut directory = std::env::temp_dir();
        directory.push("maia-store-slice-b");
        directory.push(format!("{name}-{}-{sequence}", process::id()));
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("create temp dir: {error}"));
        let file = directory.join("maia.sqlite");
        let owner = must(SqliteOwner::open(OwnerOpen {
            path: file.clone(),
            now,
            normal_capacity,
            panic_capacity,
        }));
        Self {
            directory,
            file,
            owner: Some(owner),
            keep_files: false,
        }
    }

    fn owner(&self) -> &SqliteOwner {
        self.owner
            .as_ref()
            .unwrap_or_else(|| panic!("owner already shut down"))
    }

    fn file(&self) -> &Path {
        &self.file
    }

    fn shutdown(&mut self) {
        if let Some(owner) = self.owner.take() {
            must(owner.shutdown());
        }
    }

    fn keep(mut self) -> (PathBuf, PathBuf) {
        self.shutdown();
        self.keep_files = true;
        (self.directory.clone(), self.file.clone())
    }

    fn reopen(&mut self, now: i64) {
        self.shutdown();
        self.owner = Some(must(SqliteOwner::open(OwnerOpen {
            path: self.file.clone(),
            now,
            normal_capacity: 8,
            panic_capacity: 2,
        })));
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            let _ = owner.shutdown();
        }
        if !self.keep_files {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

fn must<T>(result: Result<T, StoreError>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("store error: {error}"),
    }
}

fn ready<T>(result: Result<T, rusqlite::Error>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("sqlite: {error}"),
    }
}

fn dump(path: &Path, sql: &str) -> String {
    let connection = ready(Connection::open(path));
    let mut statement = ready(connection.prepare(sql));
    let columns = statement.column_count();
    let mut rows = ready(statement.query([]));
    let mut lines = Vec::new();
    loop {
        let Some(row) = ready(rows.next()) else {
            break;
        };
        let mut cells = Vec::new();
        for index in 0..columns {
            let value: Value = ready(row.get(index));
            cells.push(match value {
                Value::Null => "NULL".to_owned(),
                Value::Integer(number) => number.to_string(),
                Value::Real(number) => number.to_string(),
                Value::Text(text) => text,
                Value::Blob(bytes) => bytes.iter().map(|byte| format!("{byte:02X}")).collect(),
            });
        }
        lines.push(cells.join("|"));
    }
    lines.join("\n")
}

fn assert_dump(path: &Path, sql: &str, expected: &str) {
    assert_eq!(dump(path, sql), expected, "query: {sql}");
}

fn master_dump(path: &Path) -> String {
    dump(
        path,
        "SELECT type, name, tbl_name, ifnull(sql, '') \
         FROM sqlite_master ORDER BY type, name, tbl_name",
    )
}

fn thread_event(event_id: &str, kind: &str, body: &str) -> ThreadEventWrite {
    ThreadEventWrite {
        event_id: event_id.to_owned(),
        kind: kind.to_owned(),
        body: body.to_owned(),
    }
}

fn append_request(
    expected_version: u64,
    occurred_at: i64,
    events: Vec<ThreadEventWrite>,
) -> AppendEvents {
    AppendEvents {
        thread_id: "thread-1".to_owned(),
        expected_version,
        participants: "agent-1".to_owned(),
        occurred_at,
        events,
    }
}

fn audit_canonical(sequence: u64) -> Vec<u8> {
    format!("canonical-{sequence}").into_bytes()
}

fn event_hash(sequence: u64) -> u64 {
    maia_core::audit::compute_event_hash(&audit_canonical(sequence)).0
}

fn sample_audit(sequence: u64, previous_hash: u64, kind: &str) -> AuditAppend {
    let canonical = audit_canonical(sequence);
    let event_hash = maia_core::audit::compute_event_hash(&canonical).0;
    AuditAppend {
        sequence,
        event_id: format!("audit-{sequence}"),
        thread_id: Some("thread-1".to_owned()),
        actor: AuditActor::System,
        kind: kind.to_owned(),
        cause_event_id: None,
        request_id: None,
        occurred_at: 500 + i64::try_from(sequence).unwrap_or_else(|_| panic!("sequence fits")),
        payload_hash: format!("payload-{sequence}"),
        previous_hash,
        event_hash,
        canonical,
        profile: "protected".to_owned(),
        allowlist_entry_id: None,
        policy_version: 7,
        checkpoint_at: 800 + i64::try_from(sequence).unwrap_or_else(|_| panic!("sequence fits")),
        payload: Some(format!("blob-{sequence}").into_bytes()),
    }
}

fn episode_request() -> EpisodeWrite {
    EpisodeWrite {
        episode_id: "episode-1".to_owned(),
        thread_id: "thread-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        body: "Obsidian opens the vault".to_owned(),
        taint: MemoryTaint::Untrusted,
        reasoning: Some("readable trace".to_owned()),
        participants: "agent-1".to_owned(),
        created_at: 40,
        segments: vec![SegmentWrite {
            text: "Obsidian opens the vault".to_owned(),
            taint: MemoryTaint::Untrusted,
            sources: "web:example.test".to_owned(),
        }],
    }
}

fn promotion_request() -> PromotionWrite {
    PromotionWrite {
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
    session_bot_id: String::new(),
    session_summary: String::new(),
    }
}

fn presentation(id: &str, weight: f64) -> PresentationWrite {
    PresentationWrite {
        presentation_id: id.to_owned(),
        candidate_kind: MemoryKind::Claim,
        candidate_id: "claim-1".to_owned(),
        source: EvidenceSource::Reasoning,
        weight,
        source_span_start: 0,
        source_span_end: 4,
        evidence_span_start: 0,
        evidence_span_end: 4,
        thread_id: "thread-1".to_owned(),
    }
}

fn ledger_request(ledger_id: &str, presentation_ids: &[&str], weight: f64) -> LedgerWrite {
    let mut presentations = Vec::new();
    for id in presentation_ids {
        presentations.push(presentation(id, weight));
    }
    LedgerWrite {
        ledger_id: ledger_id.to_owned(),
        thread_id: "thread-1".to_owned(),
        request_id: "request-1".to_owned(),
        compiled_prefix_hash: "prefix-hash".to_owned(),
        applied_at: 70,
        presentations,
        heat: vec![HeatWrite {
            slot_id: "slot-1".to_owned(),
            weight,
        }],
        co_use: vec![CoUseWrite {
            left_kind: MemoryKind::Claim,
            left_id: "claim-1".to_owned(),
            right_kind: MemoryKind::Fact,
            right_id: "fact-1".to_owned(),
            weight,
        }],
        negative_marks: vec![NegativeMarkWrite {
            mark_id: format!("mark-{ledger_id}"),
            target_kind: MemoryKind::Claim,
            target_id: "claim-1".to_owned(),
            presentation_id: presentation_ids[0].to_owned(),
            thread_id: "thread-1".to_owned(),
            message_id: "message-2".to_owned(),
            evidence_span_start: 0,
            evidence_span_end: 3,
            occurred_at: 71,
            dream_queue_id: format!("dream-{ledger_id}"),
        }],
    }
}

fn consolidation_request(sentence: &str) -> ConsolidationWrite {
    ConsolidationWrite {
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
            sentence: sentence.to_owned(),
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
    }
}

#[test]
fn owner_thread_is_named_maia_sqlite_and_shutdown_reopens() {
    let mut db = TestDb::open("lifecycle", 10);
    let first = must(db.owner().ping());
    assert_eq!(first.sequence, 1);
    assert_eq!(must(db.owner().thread_name()), "maia-sqlite");
    db.shutdown();
    db.reopen(11);
    assert_eq!(must(db.owner().thread_name()), "maia-sqlite");
    let settings = must(db.owner().connection_settings());
    assert_eq!(settings.user_version, 19);
}

#[test]
fn zero_capacity_is_rejected_without_a_database_owner() {
    let mut directory = std::env::temp_dir();
    directory.push("maia-store-slice-b");
    directory.push(format!("capacity-{}", process::id()));
    fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("create temp dir: {error}"));
    let path = directory.join("maia.sqlite");
    let result = SqliteOwner::open(OwnerOpen {
        path: path.clone(),
        now: 1,
        normal_capacity: 0,
        panic_capacity: 1,
    });
    assert_eq!(result.err(), Some(StoreError::InvalidCapacity));
    assert!(!path.exists());
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn bounded_queue_rejects_overflow_and_panic_lane_runs_first() {
    let db = TestDb::open_with_capacity("bound", 20, 1, 1);
    let hold = must(db.owner().try_hold());
    must(hold.wait_until_entered());
    let queued = must(db.owner().try_ping());
    let overflow = db.owner().try_ping();
    assert_eq!(overflow.err(), Some(StoreError::QueueFull));
    let panic_pending = must(db.owner().try_engage_panic(EngagePanic {
        action_id: "action-panic".to_owned(),
        at: 21,
        audit: sample_audit(1, 0, "panic_engaged"),
    }));
    let held: Executed<()> = must(hold.release().wait());
    let panicked = must(panic_pending.wait());
    let pinged = must(queued.wait());
    assert_eq!(held.sequence, 1);
    assert!(
        panicked.sequence < pinged.sequence,
        "panic sequence {} must precede normal sequence {}",
        panicked.sequence,
        pinged.sequence,
    );
    assert_eq!(panicked.value.generation, 1);
    assert!(panicked.value.engaged);
    assert_eq!(must(db.owner().thread_name()), "maia-sqlite");
}

#[test]
fn migrations_apply_forward_only_and_keep_the_original_row() {
    let mut db = TestDb::open("migrate", 100);
    assert_dump(
        db.file(),
        "SELECT CAST(version AS TEXT), name, CAST(applied_at AS TEXT) \
         FROM schema_migrations ORDER BY version",
        "1|schema_migrations|100\n2|durable_schema|100\n3|super_agent_schema|100\n4|message_submission_idempotency|100\n5|runtime_id_high_water|100\n6|model_connection|100\n7|router_turn_snapshots|100\n8|mcp_connections|100\n9|promotion_brain|100\n10|approvals_attachments|100\n11|brain_markdown|100\n12|neuron_fts_porter|100\n13|brain_memory|100\n14|brain_polish|100\n15|bots|100\n16|memory_tags|100\n17|purge_orphan_bot_tasks|100\n18|claim_kind_and_scope|100\n19|session_summaries|100",
    );
    let settings = must(db.owner().connection_settings());
    assert_eq!(settings.user_version, 19);
    db.reopen(250);
    assert_dump(
        db.file(),
        "SELECT CAST(version AS TEXT), name, CAST(applied_at AS TEXT) \
         FROM schema_migrations ORDER BY version",
        "1|schema_migrations|100\n2|durable_schema|100\n3|super_agent_schema|100\n4|message_submission_idempotency|100\n5|runtime_id_high_water|100\n6|model_connection|100\n7|router_turn_snapshots|100\n8|mcp_connections|100\n9|promotion_brain|100\n10|approvals_attachments|100\n11|brain_markdown|100\n12|neuron_fts_porter|100\n13|brain_memory|100\n14|brain_polish|100\n15|bots|100\n16|memory_tags|100\n17|purge_orphan_bot_tasks|100\n18|claim_kind_and_scope|100\n19|session_summaries|100",
    );
    db.shutdown();

    let upgrade_dir = db.directory.join("upgrade");
    fs::create_dir_all(&upgrade_dir).unwrap_or_else(|error| panic!("upgrade dir: {error}"));
    let upgrade_file = upgrade_dir.join("maia.sqlite");
    let connection = ready(Connection::open(&upgrade_file));
    ready(connection.execute_batch(
        "CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (1, 'schema_migrations', 111);
        PRAGMA user_version = 1;",
    ));
    drop(connection);
    let upgraded = must(SqliteOwner::open(OwnerOpen {
        path: upgrade_file.clone(),
        now: 222,
        normal_capacity: 2,
        panic_capacity: 1,
    }));
    must(upgraded.shutdown());
    assert_dump(
        &upgrade_file,
        "SELECT CAST(version AS TEXT), name, CAST(applied_at AS TEXT) \
         FROM schema_migrations ORDER BY version",
        "1|schema_migrations|111\n2|durable_schema|222\n3|super_agent_schema|222\n4|message_submission_idempotency|222\n5|runtime_id_high_water|222\n6|model_connection|222\n7|router_turn_snapshots|222\n8|mcp_connections|222\n9|promotion_brain|222\n10|approvals_attachments|222\n11|brain_markdown|222\n12|neuron_fts_porter|222\n13|brain_memory|222\n14|brain_polish|222\n15|bots|222\n16|memory_tags|222\n17|purge_orphan_bot_tasks|222\n18|claim_kind_and_scope|222\n19|session_summaries|222",
    );

    let future = db.directory.join("future.sqlite");
    let connection = ready(Connection::open(&future));
    ready(connection.pragma_update(None, "user_version", 20_i64));
    drop(connection);
    let opened = SqliteOwner::open(OwnerOpen {
        path: future.clone(),
        now: 1,
        normal_capacity: 2,
        panic_capacity: 1,
    });
    assert_eq!(
        opened.err(),
        Some(StoreError::DatabaseTooNew {
            found: 20,
            supported: 19,
        })
    );
    let connection = ready(Connection::open(&future));
    let version: i64 = ready(connection.pragma_query_value(None, "user_version", |row| row.get(0)));
    assert_eq!(version, 20);
    assert_dump(
        &future,
        "SELECT name FROM sqlite_master WHERE name = 'schema_migrations'",
        "",
    );
}

#[test]
fn initial_schema_matches_the_locked_catalog() {
    let mut db = TestDb::open("catalog", 30);
    let settings = must(db.owner().connection_settings());
    assert_eq!(settings.journal_mode, "wal");
    assert_eq!(settings.foreign_keys, 1);
    assert_eq!(settings.user_version, 19);
    db.shutdown();
    let actual = master_dump(db.file());
    let expected = include_str!("expected_schema.txt")
        .replace("\r\n", "\n")
        .trim_end_matches('\n')
        .to_owned();
    if actual != expected {
        let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/actual_schema.txt");
        fs::write(&output, &actual).unwrap_or_else(|error| panic!("write schema dump: {error}"));
        panic!("schema dump mismatch; wrote {}", output.display());
    }
    assert_eq!(dump(db.file(), "PRAGMA integrity_check"), "ok");
    assert_dump(db.file(), "PRAGMA foreign_key_check", "");
}

#[test]
fn wal_and_foreign_keys_survive_reopen() {
    let mut db = TestDb::open("wal", 31);
    db.shutdown();
    let connection = ready(Connection::open(db.file()));
    let journal: String =
        ready(connection.pragma_query_value(None, "journal_mode", |row| row.get(0)));
    assert_eq!(journal, "wal");
    drop(connection);
    db.reopen(32);
    let settings = must(db.owner().connection_settings());
    assert_eq!(settings.journal_mode, "wal");
    assert_eq!(settings.foreign_keys, 1);
}

#[test]
fn thread_append_is_atomic_cas_and_idempotent_across_restart() {
    let mut db = TestDb::open("append", 40);
    let version = must(db.owner().append(append_request(
        0,
        41,
        vec![thread_event("event-1", "user", "hello")],
    )));
    assert_eq!(version.value, AppendOutcome { version: 1 });
    let duplicate = db.owner().append(append_request(
        1,
        42,
        vec![
            thread_event("event-dup", "user", "one"),
            thread_event("event-dup", "user", "two"),
        ],
    ));
    assert!(
        matches!(duplicate, Err(StoreError::Constraint { .. })),
        "duplicate append must roll back, got {duplicate:?}"
    );
    assert_dump(
        db.file(),
        "SELECT thread_id, CAST(ordinal AS TEXT), event_id, kind, body, CAST(occurred_at AS TEXT) \
         FROM thread_events ORDER BY ordinal",
        "thread-1|1|event-1|user|hello|41",
    );
    let conflict = db.owner().append(append_request(
        0,
        42,
        vec![thread_event("event-2", "user", "other")],
    ));
    assert_eq!(
        conflict.err(),
        Some(StoreError::IdempotencyConflict {
            key: "thread-1".to_owned(),
        })
    );
    let replay = must(db.owner().append(append_request(
        0,
        41,
        vec![thread_event("event-1", "user", "hello")],
    )));
    assert_eq!(replay.value.version, 1);
    let changed_time = db.owner().append(append_request(
        0,
        99,
        vec![thread_event("event-1", "user", "hello")],
    ));
    assert_eq!(
        changed_time.err(),
        Some(StoreError::IdempotencyConflict {
            key: "thread-1".to_owned(),
        })
    );
    assert_dump(
        db.file(),
        "SELECT CAST(ordinal AS TEXT), event_id, kind, body, CAST(occurred_at AS TEXT) \
         FROM thread_events ORDER BY ordinal",
        "1|event-1|user|hello|41",
    );
    let second = must(db.owner().append(append_request(
        1,
        43,
        vec![thread_event("event-2", "assistant", "world")],
    )));
    assert_eq!(second.value.version, 2);
    let changed = db.owner().append(append_request(
        0,
        41,
        vec![thread_event("event-1", "user", "mutated")],
    ));
    assert_eq!(
        changed.err(),
        Some(StoreError::VersionConflict {
            expected: 0,
            actual: 2,
        })
    );
    db.shutdown();
    assert_dump(
        db.file(),
        "SELECT CAST(version AS TEXT), participants, CAST(created_at AS TEXT) FROM threads",
        "2|agent-1|41",
    );
    assert_dump(
        db.file(),
        "SELECT CAST(ordinal AS TEXT), event_id, kind, body, CAST(occurred_at AS TEXT) \
         FROM thread_events ORDER BY ordinal",
        "1|event-1|user|hello|41\n2|event-2|assistant|world|43",
    );
    db.reopen(99);
    db.shutdown();
    assert_dump(
        db.file(),
        "SELECT CAST(ordinal AS TEXT), event_id, kind, body, CAST(occurred_at AS TEXT) \
         FROM thread_events ORDER BY ordinal",
        "1|event-1|user|hello|41\n2|event-2|assistant|world|43",
    );
}

#[test]
fn ledger_commit_is_atomic_and_idempotent_by_ledger_id() {
    let db = TestDb::open("ledger", 50);
    must(db.owner().append(append_request(
        0,
        51,
        vec![thread_event("event-1", "user", "hi")],
    )));
    let failed = db
        .owner()
        .apply_ledger(ledger_request("ledger-1", &["p1", "p1"], 1.0));
    assert!(
        matches!(failed, Err(StoreError::Constraint { .. })),
        "duplicate presentation must roll back, got {failed:?}"
    );
    assert_dump(db.file(), "SELECT ledger_id FROM ledgers", "");
    assert_dump(db.file(), "SELECT presentation_id FROM presentations", "");
    assert_dump(db.file(), "SELECT slot_id FROM slot_heat", "");
    assert_dump(db.file(), "SELECT mark_id FROM negative_marks", "");
    assert_dump(db.file(), "SELECT dream_queue_id FROM dream_queue", "");
    assert_dump(db.file(), "SELECT target_id FROM correction_holds", "");
    assert_dump(db.file(), "SELECT edge_kind FROM edges", "");

    must(
        db.owner()
            .apply_ledger(ledger_request("ledger-1", &["p1"], 1.0)),
    );
    must(
        db.owner()
            .apply_ledger(ledger_request("ledger-1", &["p1"], 1.0)),
    );
    let conflict = db
        .owner()
        .apply_ledger(ledger_request("ledger-1", &["p1"], 0.5));
    assert!(
        matches!(conflict, Err(StoreError::IdempotencyConflict { .. })),
        "changed ledger must not apply twice, got {conflict:?}"
    );
    assert_dump(
        db.file(),
        "SELECT ledger_id, thread_id, request_id, compiled_prefix_hash, CAST(applied_at AS TEXT) \
         FROM ledgers",
        "ledger-1|thread-1|request-1|prefix-hash|70",
    );
    assert_dump(
        db.file(),
        "SELECT presentation_id, candidate_kind, candidate_id, source, printf('%.6f', weight) \
         FROM presentations",
        "p1|claim|claim-1|reasoning|1.000000",
    );
    assert_dump(
        db.file(),
        "SELECT slot_id, printf('%.6f', heat) FROM slot_heat",
        "slot-1|1.000000",
    );
    assert_dump(
        db.file(),
        "SELECT edge_kind, from_id, to_id, printf('%.6f', weight) FROM edges ORDER BY from_id, to_id",
        "co_use|claim-1|fact-1|1.000000",
    );
    assert_dump(
        db.file(),
        "SELECT mark_id, presentation_id, dream_queue_id, CAST(occurred_at AS TEXT) FROM negative_marks",
        "mark-ledger-1|p1|dream-ledger-1|71",
    );
    assert_dump(
        db.file(),
        "SELECT dream_queue_id, target_id, consumed_at IS NULL FROM dream_queue",
        "dream-ledger-1|claim-1|1",
    );
    assert_dump(
        db.file(),
        "SELECT target_kind, target_id, CAST(since AS TEXT) FROM correction_holds",
        "claim|claim-1|71",
    );

    let non_finite = ledger_request("ledger-2", &["p2"], f64::NAN);
    assert!(matches!(
        db.owner().apply_ledger(non_finite),
        Err(StoreError::InvalidRequest { .. })
    ));
    assert_dump(db.file(), "SELECT ledger_id FROM ledgers", "ledger-1");
}

#[test]
fn next_message_sequence_includes_negative_mark_ids() {
    let db = TestDb::open("negative-mark-message-id", 50);
    must(db.owner().append(append_request(
        0,
        51,
        vec![thread_event("event-1", "user", "hi")],
    )));
    let mut ledger = ledger_request("ledger-1", &["p1"], 1.0);
    ledger.negative_marks[0].message_id = "m-9".to_owned();
    must(db.owner().apply_ledger(ledger));

    assert_eq!(must(db.owner().next_message_sequence()), 10);
}

#[test]
fn promotion_and_consolidation_are_atomic_and_idempotent() {
    let mut db = TestDb::open("dream", 60);
    must(db.owner().append(append_request(
        0,
        61,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().insert_episode(episode_request()));
    let rewritten = episode_request();
    let mut changed = rewritten;
    changed.body = "different body".to_owned();
    assert!(matches!(
        db.owner().insert_episode(changed),
        Err(StoreError::IdempotencyConflict { .. })
    ));
    let missing = db.owner().apply_promotion(PromotionWrite {
        episode_id: "missing-episode".to_owned(),
        model: "model-a".to_owned(),
        now: 62,
        claims: promotion_request().claims,
        same_claim_ids: Vec::new(),
        replacements: Vec::new(),
        links: Vec::new(),
    session_bot_id: String::new(),
    session_summary: String::new(),
    });
    assert!(missing.is_err(), "missing episode must not insert claims");
    assert_dump(db.file(), "SELECT claim_id FROM claims", "");

    let mut duplicated = promotion_request();
    duplicated.claims.push(duplicated.claims[0].clone());
    assert!(
        matches!(
            db.owner().apply_promotion(duplicated),
            Err(StoreError::Constraint { .. })
        ),
        "duplicate claim ids must roll back promotion"
    );
    assert_dump(db.file(), "SELECT claim_id FROM claims", "");
    assert_dump(
        db.file(),
        "SELECT promoted_at IS NULL, promoted_model IS NULL FROM episodes",
        "1|1",
    );

    must(db.owner().apply_promotion(promotion_request()));
    must(db.owner().apply_promotion(promotion_request()));
    let mut other = promotion_request();
    other.claims[0].claim_id = "claim-other".to_owned();
    assert!(matches!(
        db.owner().apply_promotion(other),
        Err(StoreError::IdempotencyConflict { .. })
    ));
    assert_dump(
        db.file(),
        "SELECT claim_id, sentence, taint, status, CAST(valid_from AS TEXT), consolidated_by IS NULL \
         FROM claims",
        "claim-1|Obsidian opens the vault.|untrusted|provisional|40|1",
    );
    assert_dump(
        db.file(),
        "SELECT edge_kind, from_kind, from_id, to_kind, to_id FROM edges ORDER BY edge_kind, to_id",
        "lexeme|claim|claim-1|lexeme|obsidian\nlexeme|claim|claim-1|lexeme|vault\n\
         mention|claim|claim-1|episode|episode-1\n\
         mentions|claim|claim-1|entity|entity-owner",
    );
    assert_dump(
        db.file(),
        "SELECT CAST(promoted_at AS TEXT), promoted_model FROM episodes",
        "60|model-a",
    );

    must(
        db.owner()
            .apply_ledger(ledger_request("ledger-1", &["p1"], 1.0)),
    );
    let mut failed = consolidation_request("Obsidian opens the vault.");
    failed.supersede[0].claim_id = "missing-claim".to_owned();
    assert!(matches!(
        db.owner().apply_consolidation(failed),
        Err(StoreError::NotFound { .. })
    ));
    assert_dump(db.file(), "SELECT entity_id FROM entities", "entity-owner");
    assert_dump(db.file(), "SELECT fact_id FROM facts", "");
    assert_dump(db.file(), "SELECT batch_id FROM projections", "");
    assert_dump(
        db.file(),
        "SELECT target_id FROM correction_holds",
        "claim-1",
    );

    must(
        db.owner()
            .apply_consolidation(consolidation_request("Obsidian opens the vault.")),
    );
    must(
        db.owner()
            .apply_consolidation(consolidation_request("Obsidian opens the vault.")),
    );
    let conflict = db
        .owner()
        .apply_consolidation(consolidation_request("A different sentence."));
    assert!(matches!(
        conflict,
        Err(StoreError::IdempotencyConflict { .. })
    ));
    assert_dump(
        db.file(),
        "SELECT fact_id, sentence, taint, sources, CAST(valid_from AS TEXT), entity_id FROM facts",
        "fact-1|Obsidian opens the vault.|untrusted|episode-1|40|entity-1",
    );
    assert_dump(
        db.file(),
        "SELECT claim_id, status, consolidated_by FROM claims",
        "claim-1|superseded|fact-1",
    );
    assert_dump(
        db.file(),
        "SELECT batch_id, progress, CAST(created_at AS TEXT), completed_at IS NULL FROM projections",
        "batch-1|pending|90|1",
    );
    assert_dump(
        db.file(),
        "SELECT entity_id FROM projection_entities",
        "entity-1",
    );
    assert_dump(
        db.file(),
        "SELECT folder FROM projection_folders",
        "entities",
    );
    assert_dump(
        db.file(),
        "SELECT dream_queue_id, CAST(consumed_at AS TEXT) FROM dream_queue",
        "dream-ledger-1|90",
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Episode, "obsidian")),
        vec!["episode-1".to_owned()]
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Claim, "vault")),
        vec!["claim-1".to_owned()]
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Episode, "missingword")),
        Vec::<String>::new()
    );

    assert_dump(db.file(), "SELECT target_id FROM correction_holds", "");
    db.shutdown();
    db.reopen(200);
    db.shutdown();
    assert_dump(
        db.file(),
        "SELECT fact_id, sentence FROM facts",
        "fact-1|Obsidian opens the vault.",
    );
    assert_dump(
        db.file(),
        "SELECT claim_id, status, consolidated_by FROM claims",
        "claim-1|superseded|fact-1",
    );
}

#[test]
fn apply_promotion_same_and_replaces_is_atomic() {
    let db = TestDb::open("promo-same-replace", 60);
    must(db.owner().append(append_request(
        0,
        61,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-1".to_owned(),
        model: "model-a".to_owned(),
        now: 62,
        claims: vec![
            PromotionClaimWrite {
                claim_id: "claim-same".to_owned(),
                sentence: "The vault stays open.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: 40,
                lexemes: vec!["vault".to_owned()],
            ..Default::default()
        },
            PromotionClaimWrite {
                claim_id: "claim-old".to_owned(),
                sentence: "Bob uses Obsidian.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: 40,
                lexemes: vec!["bob".to_owned()],
            ..Default::default()
        },
        ],
        same_claim_ids: Vec::new(),
        replacements: Vec::new(),
        links: Vec::new(),
    session_bot_id: String::new(),
    session_summary: String::new(),
    }));

    let mut episode_two = episode_request();
    episode_two.episode_id = "episode-2".to_owned();
    episode_two.turn_id = "turn-2".to_owned();
    episode_two.body = "Bob prefers Neovim.".to_owned();
    episode_two.created_at = 50;
    episode_two.segments[0].text = "Bob prefers Neovim.".to_owned();
    must(db.owner().insert_episode(episode_two));
    must(db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-2".to_owned(),
        model: "model-b".to_owned(),
        now: 70,
        claims: vec![PromotionClaimWrite {
            claim_id: "claim-new".to_owned(),
            sentence: "Bob prefers Neovim.".to_owned(),
            taint: MemoryTaint::Untrusted,
            valid_from: 50,
            lexemes: vec!["bob".to_owned(), "neovim".to_owned()],
            ..Default::default()
        }],
        same_claim_ids: vec!["claim-same".to_owned()],
        replacements: vec![PromotionReplaceWrite {
            old_claim_id: "claim-old".to_owned(),
            new_claim_id: "claim-new".to_owned(),
        }],
        links: Vec::new(),
    session_bot_id: String::new(),
    session_summary: String::new(),
    }));

    assert_dump(
        db.file(),
        "SELECT claim_id, status, COALESCE(replaced_by, '') FROM claims ORDER BY claim_id",
        "claim-new|provisional|\nclaim-old|superseded|claim-new\nclaim-same|provisional|",
    );
    assert_dump(
        db.file(),
        "SELECT from_id, to_id FROM edges WHERE edge_kind = 'mention' ORDER BY from_id, to_id",
        "claim-new|episode-2\nclaim-old|episode-1\nclaim-same|episode-1\nclaim-same|episode-2\nepisode-2|claim-new",
    );
    assert_dump(
        db.file(),
        "SELECT CAST(promoted_at AS TEXT), promoted_model FROM episodes WHERE episode_id = 'episode-2'",
        "70|model-b",
    );
}

#[test]
fn apply_promotion_with_invalid_replacement_rolls_back_completely() {
    let db = TestDb::open("promo-partial", 60);
    must(db.owner().append(append_request(
        0,
        61,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    let failed = db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-1".to_owned(),
        model: "model-a".to_owned(),
        now: 62,
        claims: vec![PromotionClaimWrite {
            claim_id: "claim-new".to_owned(),
            sentence: "A replacement claim.".to_owned(),
            taint: MemoryTaint::Untrusted,
            valid_from: 40,
            lexemes: vec!["replacement".to_owned()],
            ..Default::default()
        }],
        same_claim_ids: Vec::new(),
        replacements: vec![PromotionReplaceWrite {
            old_claim_id: "missing-old".to_owned(),
            new_claim_id: "claim-new".to_owned(),
        }],
        links: Vec::new(),
    session_bot_id: String::new(),
    session_summary: String::new(),
    });
    assert!(matches!(failed, Err(StoreError::NotFound { .. })));
    assert_dump(db.file(), "SELECT claim_id FROM claims", "");
    assert_dump(db.file(), "SELECT promoted_at IS NULL FROM episodes", "1");
}

#[test]
fn pending_promotions_exclude_promoted_and_quarantined_and_failures_stay_searchable() {
    let db = TestDb::open("promo-pending", 60);
    must(db.owner().append(append_request(
        0,
        61,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    let mut episode_two = episode_request();
    episode_two.episode_id = "episode-2".to_owned();
    episode_two.turn_id = "turn-2".to_owned();
    episode_two.body = "Second episode body".to_owned();
    episode_two.created_at = 45;
    episode_two.segments[0].text = "Second episode body".to_owned();
    must(db.owner().insert_episode(episode_two));
    let mut episode_three = episode_request();
    episode_three.episode_id = "episode-3".to_owned();
    episode_three.turn_id = "turn-3".to_owned();
    episode_three.body = "Third episode body".to_owned();
    episode_three.created_at = 50;
    episode_three.segments[0].text = "Third episode body".to_owned();
    must(db.owner().insert_episode(episode_three));

    let pending = must(db.owner().pending_promotions());
    assert_eq!(
        pending
            .iter()
            .map(|row| row.episode_id.as_str())
            .collect::<Vec<_>>(),
        vec!["episode-1", "episode-2", "episode-3"]
    );

    must(db.owner().apply_promotion(promotion_request()));
    let first_failure = must(db.owner().note_promotion_failure("episode-2", 2));
    assert_eq!(
        first_failure.value,
        PromotionFailureNote {
            failures: 1,
            quarantined: false,
        }
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Episode, "Second")),
        vec!["episode-2".to_owned()]
    );
    assert_eq!(
        must(db.owner().pending_promotions()),
        vec![
            PendingPromotionRow {
                episode_id: "episode-2".to_owned(),
                created_at: 45,
                promotion_failures: 1,
            },
            PendingPromotionRow {
                episode_id: "episode-3".to_owned(),
                created_at: 50,
                promotion_failures: 0,
            },
        ]
    );

    let quarantined = must(db.owner().note_promotion_failure("episode-2", 2));
    assert_eq!(
        quarantined.value,
        PromotionFailureNote {
            failures: 2,
            quarantined: true,
        }
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Episode, "Second")),
        vec!["episode-2".to_owned()]
    );
    assert_eq!(
        must(db.owner().pending_promotions())
            .into_iter()
            .map(|row| row.episode_id)
            .collect::<Vec<_>>(),
        vec!["episode-3".to_owned()]
    );

    must(
        db.owner()
            .mark_promotion_skipped("episode-3", 80, "model-skip"),
    );
    assert_eq!(
        must(db.owner().pending_promotions()),
        Vec::<PendingPromotionRow>::new()
    );
    assert_dump(
        db.file(),
        "SELECT CAST(promoted_at AS TEXT), promoted_model, CAST(promotion_failures AS TEXT), \
         CAST(promotion_quarantined AS TEXT) FROM episodes ORDER BY episode_id",
        "60|model-a|0|0\nNULL|NULL|2|1\n80|model-skip|0|0",
    );
}

#[test]
fn extraction_lag_counts_waiting_and_quarantined_without_dropping_work() {
    let db = TestDb::open("extraction-lag", 60);
    must(db.owner().append(append_request(
        0,
        61,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    let mut episode_two = episode_request();
    episode_two.episode_id = "episode-2".to_owned();
    episode_two.turn_id = "turn-2".to_owned();
    episode_two.body = "Second episode body".to_owned();
    episode_two.created_at = 45;
    episode_two.segments[0].text = "Second episode body".to_owned();
    must(db.owner().insert_episode(episode_two));
    must(db.owner().note_promotion_failure("episode-2", 1));

    let lag = must(db.owner().extraction_lag());
    assert_eq!(lag.waiting, 1);
    assert_eq!(lag.quarantined, 1);
    assert_eq!(lag.oldest_waiting_at, Some(40));
    assert_eq!(lag.quarantined_episode_ids, vec!["episode-2".to_owned()]);
}

#[test]
fn nearest_claims_returns_bob_for_query_bob() {
    let db = TestDb::open("promo-nearest", 60);
    must(db.owner().append(append_request(
        0,
        61,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-1".to_owned(),
        model: "model-a".to_owned(),
        now: 62,
        claims: vec![
            PromotionClaimWrite {
                claim_id: "claim-alice".to_owned(),
                sentence: "Alice opens the vault.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: 40,
                lexemes: vec!["alice".to_owned()],
            ..Default::default()
        },
            PromotionClaimWrite {
                claim_id: "claim-bob".to_owned(),
                sentence: "Bob opens the vault.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: 40,
                lexemes: vec!["bob".to_owned()],
            ..Default::default()
        },
        ],
        same_claim_ids: Vec::new(),
        replacements: Vec::new(),
        links: Vec::new(),
    session_bot_id: String::new(),
    session_summary: String::new(),
    }));
    assert_eq!(
        must(db.owner().nearest_claims("bob", 5)),
        vec![NearestClaimRow {
            claim_id: "claim-bob".to_owned(),
            sentence: "Bob opens the vault.".to_owned(),
        }]
    );
    assert_eq!(
        must(db.owner().claim_rows(&[
            "claim-bob".to_owned(),
            "missing".to_owned(),
            "claim-alice".to_owned(),
        ])),
        vec![
            NearestClaimRow {
                claim_id: "claim-alice".to_owned(),
                sentence: "Alice opens the vault.".to_owned(),
            },
            NearestClaimRow {
                claim_id: "claim-bob".to_owned(),
                sentence: "Bob opens the vault.".to_owned(),
            },
        ]
    );
}

#[test]
fn promotion_day_stats_and_recall_subgraph_round_trip() {
    let db = TestDb::open("promo-stats-recall", 60);
    must(db.owner().append(append_request(
        0,
        61,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().apply_promotion(promotion_request()));
    must(db.owner().bump_promotion_day_stats("2026-11-10", 1, 40));
    must(db.owner().bump_promotion_day_stats("2026-11-10", 2, 10));
    assert_eq!(must(db.owner().promotion_day_stats("2026-11-10")), (3, 50));
    assert_eq!(must(db.owner().promotion_day_stats("missing-day")), (0, 0));

    let map = must(db.owner().recall_subgraph(
        &["claim-1".to_owned()],
        &["obsidian".to_owned()],
        2,
    ));
    let ids = map
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<Vec<_>>();
    assert!(ids.contains(&"claim-1"));
    assert!(ids.contains(&"obsidian"));
    assert!(ids.contains(&"episode-1"));
    assert!(ids.contains(&"vault"));
}

#[test]
fn pending_projection_survives_restart_and_completion_is_idempotent() {
    let mut db = TestDb::open("project", 80);
    must(db.owner().append(append_request(
        0,
        81,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().apply_promotion(promotion_request()));
    must(
        db.owner()
            .apply_ledger(ledger_request("ledger-1", &["p1"], 1.0)),
    );
    must(
        db.owner()
            .apply_consolidation(consolidation_request("Obsidian opens the vault.")),
    );
    let pending = must(db.owner().pending_projections());
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].batch_id, "batch-1");
    assert_eq!(pending[0].entities, vec!["entity-1".to_owned()]);
    assert_eq!(pending[0].folders, vec!["entities".to_owned()]);
    assert_eq!(pending[0].created_at, 90);
    db.shutdown();
    db.reopen(300);
    let pending = must(db.owner().pending_projections());
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].batch_id, "batch-1");
    let completed = must(db.owner().complete_projection(CompleteProjection {
        batch_id: "batch-1".to_owned(),
        completed_at: 310,
    }));
    assert_eq!(completed.value, 310);
    let again = must(db.owner().complete_projection(CompleteProjection {
        batch_id: "batch-1".to_owned(),
        completed_at: 999,
    }));
    assert_eq!(again.value, 310);
    assert!(must(db.owner().pending_projections()).is_empty());
    db.shutdown();
    assert_dump(
        db.file(),
        "SELECT batch_id, progress, CAST(created_at AS TEXT), CAST(completed_at AS TEXT) FROM projections",
        "batch-1|complete|90|310",
    );
    db.reopen(400);
    db.shutdown();
    assert_dump(
        db.file(),
        "SELECT batch_id, progress, CAST(completed_at AS TEXT) FROM projections",
        "batch-1|complete|310",
    );
}

#[test]
fn audit_append_is_idempotent_and_restart_keeps_the_chain() {
    let mut db = TestDb::open("audit", 90);
    must(db.owner().append_audit(sample_audit(1, 0, "wake_accepted")));
    must(db.owner().append_audit(sample_audit(1, 0, "wake_accepted")));
    let broken = db.owner().append_audit(sample_audit(2, 99, "transition"));
    assert!(
        matches!(broken, Err(StoreError::AuditChainInvalid { .. })),
        "broken predecessor must not append, got {broken:?}"
    );
    must(
        db.owner()
            .append_audit(sample_audit(2, event_hash(1), "transition")),
    );
    let head = must(db.owner().audit_head());
    let head = head.unwrap_or_else(|| panic!("checkpoint missing"));
    assert_eq!(head.sequence, 2);
    assert_eq!(head.event_hash, event_hash(2));
    assert_eq!(head.policy_version, 7);
    assert_eq!(head.checkpoint_at, 802);
    db.shutdown();
    let first = event_hash(1).to_string();
    let second = event_hash(2).to_string();
    assert_dump(
        db.file(),
        "SELECT CAST(sequence AS TEXT), event_id, kind, previous_hash, event_hash, profile, \
         hex(canonical) FROM audit_events ORDER BY sequence",
        &format!(
            "1|audit-1|wake_accepted|0|{first}|protected|63616E6F6E6963616C2D31\n\
             2|audit-2|transition|{first}|{second}|protected|63616E6F6E6963616C2D32"
        ),
    );
    assert_dump(
        db.file(),
        "SELECT CAST(sequence AS TEXT), event_hash, CAST(policy_version AS TEXT), \
         CAST(occurred_at AS TEXT) FROM audit_checkpoints ORDER BY sequence",
        &format!("1|{first}|7|801\n2|{second}|7|802"),
    );
    assert_dump(
        db.file(),
        "SELECT payload_hash, hex(body) FROM audit_blobs ORDER BY payload_hash",
        "payload-1|626C6F622D31\npayload-2|626C6F622D32",
    );
    db.reopen(500);
    db.shutdown();
    assert_dump(
        db.file(),
        "SELECT CAST(sequence AS TEXT), event_hash FROM audit_events ORDER BY sequence",
        &format!("1|{first}\n2|{second}"),
    );

    let tampered = TestDb::open("audit-tamper", 90);
    must(
        tampered
            .owner()
            .append_audit(sample_audit(1, 0, "wake_accepted")),
    );
    must(
        tampered
            .owner()
            .append_audit(sample_audit(2, event_hash(1), "transition")),
    );
    let (tamper_dir, tamper_file) = tampered.keep();
    let connection = ready(Connection::open(&tamper_file));
    ready(connection.execute(
        "UPDATE audit_events SET previous_hash = 'tampered' WHERE sequence = 2",
        [],
    ));
    drop(connection);
    let reopened = SqliteOwner::open(OwnerOpen {
        path: tamper_file,
        now: 91,
        normal_capacity: 2,
        panic_capacity: 1,
    });
    match reopened {
        Err(StoreError::AuditChainInvalid { sequence: 2 }) => {}
        Err(error) => panic!("tampered chain must fail open, got {error}"),
        Ok(owner) => {
            let _ = owner.shutdown();
            panic!("tampered chain must fail open");
        }
    }
    let _ = fs::remove_dir_all(tamper_dir);
}

#[test]
fn panic_security_allowlist_and_settings_round_trip() {
    let mut db = TestDb::open("settings", 120);
    let initial = must(db.owner().panic_latch());
    assert_eq!(initial.generation, 0);
    assert!(!initial.engaged);
    assert!(must(db.owner().security_settings()).is_none());
    assert!(must(db.owner().credential_backend()).is_none());
    assert!(must(db.owner().allowlist()).is_empty());

    let engaged = must(db.owner().engage_panic(EngagePanic {
        action_id: "action-1".to_owned(),
        at: 121,
        audit: sample_audit(1, 0, "panic_engaged"),
    }));
    assert_eq!(engaged.value.generation, 1);
    assert!(engaged.value.engaged);
    assert_eq!(engaged.value.engaged_by.as_deref(), Some("action-1"));
    assert_eq!(engaged.value.engaged_at, Some(121));
    let again = must(db.owner().engage_panic(EngagePanic {
        action_id: "action-2".to_owned(),
        at: 122,
        audit: sample_audit(2, event_hash(1), "panic_engaged"),
    }));
    assert_eq!(again.value.generation, 1);
    assert_eq!(again.value.engaged_by.as_deref(), Some("action-1"));
    assert_dump(db.file(), "SELECT COUNT(*) FROM audit_events", "1");

    let cleared = must(db.owner().clear_panic(ClearPanic {
        action_id: "action-clear".to_owned(),
        at: 130,
        audit: sample_audit(2, event_hash(1), "panic_cleared"),
    }));
    assert_eq!(cleared.value.generation, 1);
    assert!(!cleared.value.engaged);
    must(db.owner().clear_panic(ClearPanic {
        action_id: "action-clear-2".to_owned(),
        at: 131,
        audit: sample_audit(3, event_hash(2), "panic_cleared"),
    }));
    assert_dump(
        db.file(),
        "SELECT CAST(sequence AS TEXT), kind FROM audit_events ORDER BY sequence",
        "1|panic_engaged\n2|panic_cleared",
    );

    let protected = SecuritySettingsWrite {
        profile: SecurityProfile::Protected,
        activated_at: 140,
        activated_by: "desktop-1".to_owned(),
        confirmation: None,
    };
    must(db.owner().put_security_settings(protected));
    let entry = AllowlistEntryWrite {
        grant_id: "grant-1".to_owned(),
        capability: "shell".to_owned(),
        matcher_kind: MatcherKind::Command,
        matcher_canonical: "windows|C:/Tools/echo.exe|hello".to_owned(),
        agent_id: Some("agent-1".to_owned()),
        lifetime: GrantLifetime::DaemonLifetime { generation: 4 },
        enabled: true,
        created_at: 141,
        created_by: "desktop-1".to_owned(),
    };
    must(db.owner().put_allowlist(entry.clone()));
    must(db.owner().put_security_settings(SecuritySettingsWrite {
        profile: SecurityProfile::Allowlisted,
        activated_at: 142,
        activated_by: "desktop-1".to_owned(),
        confirmation: None,
    }));
    let listed = must(db.owner().allowlist());
    assert_eq!(listed.len(), 1);
    assert!(listed[0].enabled);
    assert_eq!(listed[0].matcher_canonical, entry.matcher_canonical);
    must(db.owner().set_allowlist_enabled("grant-1", false));
    assert!(!must(db.owner().allowlist())[0].enabled);
    must(db.owner().set_allowlist_enabled("grant-1", true));

    must(db.owner().put_credential_backend(CredentialBackendWrite {
        backend: CredentialBackend::Native,
        encrypted_file_idle_timeout_ms: 0,
    }));
    for observed_at in 1..=33 {
        must(db.owner().put_capability_snapshot(CapabilitySnapshotWrite {
            snapshot_id: format!("snap-{observed_at}"),
            observed_at,
            platform: PlatformKind::Windows,
            adapter_version: "0.1.0".to_owned(),
            verdict: "needs_human".to_owned(),
            kernel: None,
            landlock_abi: None,
            probe_canonical: format!("probe-{observed_at}"),
        }));
    }
    let snapshots = must(db.owner().capability_snapshots());
    assert_eq!(snapshots.len(), 32);
    assert_eq!(snapshots[0].snapshot_id, "snap-2");
    assert_eq!(snapshots[31].snapshot_id, "snap-33");

    db.shutdown();
    db.reopen(400);
    let latch = must(db.owner().panic_latch());
    assert_eq!(latch.generation, 1);
    assert!(!latch.engaged);
    let settings = must(db.owner().security_settings());
    let settings = settings.unwrap_or_else(|| panic!("settings missing"));
    assert_eq!(settings.profile, SecurityProfile::Allowlisted);
    assert_eq!(settings.activated_at, 142);
    assert!(must(db.owner().allowlist())[0].enabled);
    let backend = must(db.owner().credential_backend());
    let backend = backend.unwrap_or_else(|| panic!("backend missing"));
    assert_eq!(backend.backend, CredentialBackend::Native);
    assert_eq!(must(db.owner().capability_snapshots()).len(), 32);
    db.shutdown();
    assert_dump(
        db.file(),
        "SELECT profile, CAST(activated_at AS TEXT), activated_by FROM security_settings",
        "allowlisted|142|desktop-1",
    );
    assert_dump(
        db.file(),
        "SELECT grant_id, capability, matcher_kind, matcher_canonical, agent_id, lifetime_kind, \
         CAST(lifetime_generation AS TEXT), CAST(enabled AS TEXT) FROM allowlist_entries",
        "grant-1|shell|command|windows|C:/Tools/echo.exe|hello|agent-1|daemon_lifetime|4|1",
    );
    assert_dump(
        db.file(),
        "SELECT active_backend, CAST(encrypted_file_idle_timeout_ms AS TEXT) \
         FROM credential_backend_settings",
        "native|0",
    );
    assert_dump(
        db.file(),
        "SELECT CAST(generation AS TEXT), CAST(engaged AS TEXT), engaged_by, CAST(engaged_at AS TEXT) \
         FROM panic_state",
        "1|0|action-1|121",
    );
}

#[test]
fn fts5_is_available_for_episode_and_claim_text() {
    let db = TestDb::open("fts", 150);
    must(db.owner().append(append_request(
        0,
        151,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().apply_promotion(promotion_request()));
    assert_eq!(
        dump(
            db.file(),
            "SELECT name FROM pragma_module_list WHERE name = 'fts5'"
        ),
        "fts5"
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Episode, "Obsidian")),
        vec!["episode-1".to_owned()]
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Claim, "opens")),
        vec!["claim-1".to_owned()]
    );
}

#[test]
fn sqlite_vec_registration_is_once_and_records_dimension_and_version() {
    let before = sqlite_vec_registration_entries();
    must(register_sqlite_vec());
    let after_first = sqlite_vec_registration_entries();
    must(register_sqlite_vec());
    let after_second = sqlite_vec_registration_entries();
    assert_eq!(after_first, after_second);
    assert!(after_second >= 1);
    assert!(after_second - before <= 1);

    let mut db = TestDb::open("vectors", 160);
    assert_eq!(must(db.owner().vec_version()), "v0.1.9");
    for table in [VecTable::Episode, VecTable::Claim, VecTable::Fact] {
        let metadata = must(db.owner().vec_metadata(table));
        assert_eq!(metadata.version, "v0.1.9");
        assert_eq!(metadata.major, 0);
        assert_eq!(metadata.minor, 1);
        assert_eq!(metadata.patch, 9);
    }
    let schema = master_dump(db.file());
    let vec_tables = schema
        .lines()
        .filter(|line| line.contains("USING vec0("))
        .count();
    assert_eq!(vec_tables, 3);
    assert_eq!(schema.matches("float[384]").count(), 3);

    must(db.owner().append(append_request(
        0,
        161,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().put_embedding_model(EmbeddingModelWrite {
        model_id: "bge-small-en-v1.5".to_owned(),
        dimensions: 384,
        weights_sha256: "weights-sha".to_owned(),
        tokenizer_sha256: "tokenizer-sha".to_owned(),
        query_prefix: "query: ".to_owned(),
        document_prefix: "document: ".to_owned(),
        recorded_at: 162,
    }));
    let mut values = vec![0.0_f32; 384];
    values[0] = 1.0;
    values[383] = 0.5;
    must(db.owner().upsert_embedding(EmbeddingWrite {
        target: EmbeddingTarget::Episode,
        target_id: "episode-1".to_owned(),
        model_id: "bge-small-en-v1.5".to_owned(),
        values: values.clone(),
    }));
    must(db.owner().upsert_embedding(EmbeddingWrite {
        target: EmbeddingTarget::Episode,
        target_id: "episode-1".to_owned(),
        model_id: "bge-small-en-v1.5".to_owned(),
        values: values.clone(),
    }));
    let mut changed = values.clone();
    changed[1] = 0.25;
    assert!(matches!(
        db.owner().upsert_embedding(EmbeddingWrite {
            target: EmbeddingTarget::Episode,
            target_id: "episode-1".to_owned(),
            model_id: "bge-small-en-v1.5".to_owned(),
            values: changed,
        }),
        Err(StoreError::IdempotencyConflict { .. })
    ));
    let short = vec![0.0_f32; 3];
    assert!(matches!(
        db.owner().upsert_embedding(EmbeddingWrite {
            target: EmbeddingTarget::Episode,
            target_id: "episode-1".to_owned(),
            model_id: "bge-small-en-v1.5".to_owned(),
            values: short,
        }),
        Err(StoreError::InvalidRequest { .. })
    ));
    let loaded = must(db.owner().embedding(EmbeddingTarget::Episode, "episode-1"));
    let loaded = loaded.unwrap_or_else(|| panic!("vector missing"));
    assert_eq!(loaded.len(), 384);
    assert_eq!(loaded[0].to_bits(), 1.0_f32.to_bits());
    assert_eq!(loaded[383].to_bits(), 0.5_f32.to_bits());
    assert_eq!(loaded[1].to_bits(), 0.0_f32.to_bits());
    assert_dump(
        db.file(),
        "SELECT CAST(count(*) AS TEXT) FROM episode_vec",
        "1",
    );
    assert_dump(
        db.file(),
        "SELECT CAST(count(*) AS TEXT) FROM claim_vec",
        "0",
    );
    assert_dump(
        db.file(),
        "SELECT CAST(count(*) AS TEXT) FROM fact_vec",
        "0",
    );
    assert_dump(
        db.file(),
        "SELECT model_id, CAST(dimensions AS TEXT), weights_sha256, tokenizer_sha256, \
         query_prefix, document_prefix, CAST(recorded_at AS TEXT) FROM embedding_models",
        "bge-small-en-v1.5|384|weights-sha|tokenizer-sha|query: |document: |162",
    );
    db.shutdown();
    db.reopen(170);
    let loaded = must(db.owner().embedding(EmbeddingTarget::Episode, "episode-1"));
    let loaded = loaded.unwrap_or_else(|| panic!("vector missing after restart"));
    assert_eq!(loaded.len(), 384);
    assert_eq!(loaded[0].to_bits(), 1.0_f32.to_bits());
    assert_eq!(loaded[383].to_bits(), 0.5_f32.to_bits());
    db.shutdown();
}

#[test]
fn restart_reconstructs_the_same_durable_rows() {
    let mut db = TestDb::open("restart", 180);
    must(db.owner().append(append_request(
        0,
        181,
        vec![thread_event("event-1", "user", "hello")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().apply_promotion(promotion_request()));
    must(
        db.owner()
            .apply_ledger(ledger_request("ledger-1", &["p1"], 1.0)),
    );
    must(
        db.owner()
            .apply_consolidation(consolidation_request("Obsidian opens the vault.")),
    );
    must(db.owner().append_audit(sample_audit(1, 0, "wake_accepted")));
    must(db.owner().put_security_settings(SecuritySettingsWrite {
        profile: SecurityProfile::Protected,
        activated_at: 182,
        activated_by: "desktop-1".to_owned(),
        confirmation: None,
    }));
    db.shutdown();
    let before = durable_dump(db.file());
    db.reopen(999);
    db.shutdown();
    let after = durable_dump(db.file());
    assert_eq!(before, after);
    assert!(before.contains("thread-1|1|event-1|user|hello|181"));
    assert!(before.contains("claim-1|superseded|fact-1"));
    assert!(before.contains("batch-1|pending|90"));
    assert!(before.contains(&format!(
        "1|audit-1|wake_accepted|0|{}|protected",
        event_hash(1)
    )));
    assert!(before.contains("protected|182|desktop-1"));
}

#[test]
fn audit_hash_must_match_core_algorithm_and_tampered_bytes_fail_reopen() {
    let db = TestDb::open("hash", 70);
    let mut forged = sample_audit(1, 0, "wake_accepted");
    forged.event_hash = forged.event_hash.wrapping_add(1);
    let rejected = db.owner().append_audit(forged);
    assert!(
        matches!(rejected, Err(StoreError::AuditHashMismatch { sequence: 1 })),
        "wrong event hash must be rejected, got {rejected:?}"
    );
    assert_dump(db.file(), "SELECT event_id FROM audit_events", "");
    must(db.owner().append_audit(sample_audit(1, 0, "wake_accepted")));
    let (directory, file) = db.keep();
    let connection = ready(Connection::open(&file));
    ready(connection.execute(
        "UPDATE audit_events SET canonical = X'00' WHERE sequence = 1",
        [],
    ));
    drop(connection);
    let reopened = SqliteOwner::open(OwnerOpen {
        path: file,
        now: 71,
        normal_capacity: 2,
        panic_capacity: 1,
    });
    match reopened {
        Err(StoreError::AuditHashMismatch { sequence: 1 }) => {}
        Err(error) => panic!("tampered canonical must fail open, got {error}"),
        Ok(owner) => {
            let _ = owner.shutdown();
            panic!("tampered canonical must fail open");
        }
    }
    let _ = fs::remove_dir_all(directory);
}

#[test]
fn store_inputs_reject_one_byte_past_the_named_limit() {
    let db = TestDb::open("limits", 80);
    let boundary = "x".repeat(MAX_THREAD_EVENT_BODY_BYTES);
    must(db.owner().append(append_request(
        0,
        81,
        vec![thread_event("event-bound", "user", &boundary)],
    )));
    let over = "x".repeat(MAX_THREAD_EVENT_BODY_BYTES + 1);
    let rejected = db.owner().append(append_request(
        1,
        82,
        vec![thread_event("event-over", "user", &over)],
    ));
    assert_eq!(
        rejected.err(),
        Some(StoreError::ResourceLimit(ResourceLimit {
            field: "thread_event_body",
            limit: MAX_THREAD_EVENT_BODY_BYTES,
            actual: MAX_THREAD_EVENT_BODY_BYTES + 1,
        }))
    );
    let mut batch = Vec::new();
    for index in 0..MAX_THREAD_EVENTS_PER_APPEND {
        batch.push(thread_event(&format!("batch-{index}"), "user", "ok"));
    }
    let appended = must(db.owner().append(append_request(1, 83, batch)));
    assert_eq!(
        appended.value.version,
        1 + MAX_THREAD_EVENTS_PER_APPEND as u64
    );
    let mut too_many = Vec::new();
    for index in 0..=MAX_THREAD_EVENTS_PER_APPEND {
        too_many.push(thread_event(&format!("too-{index}"), "user", "ok"));
    }
    let rejected = db.owner().append(append_request(1, 84, too_many));
    assert_eq!(
        rejected.err(),
        Some(StoreError::ResourceLimit(ResourceLimit {
            field: "thread_event_batch",
            limit: MAX_THREAD_EVENTS_PER_APPEND,
            actual: MAX_THREAD_EVENTS_PER_APPEND + 1,
        }))
    );

    let mut canonical = sample_audit(1, 0, "wake_accepted");
    canonical.canonical = vec![b'c'; MAX_AUDIT_CANONICAL_BYTES];
    canonical.event_hash = maia_core::audit::compute_event_hash(&canonical.canonical).0;
    must(db.owner().append_audit(canonical));
    let mut over_canonical = sample_audit(2, event_hash(1), "transition");
    over_canonical.canonical = vec![b'c'; MAX_AUDIT_CANONICAL_BYTES + 1];
    over_canonical.event_hash = maia_core::audit::compute_event_hash(&over_canonical.canonical).0;
    let rejected = db.owner().append_audit(over_canonical);
    assert_eq!(
        rejected.err(),
        Some(StoreError::ResourceLimit(ResourceLimit {
            field: "audit_canonical",
            limit: MAX_AUDIT_CANONICAL_BYTES,
            actual: MAX_AUDIT_CANONICAL_BYTES + 1,
        }))
    );
    let mut payload = sample_audit(2, event_hash(1), "transition");
    payload.payload = Some(vec![b'p'; MAX_AUDIT_PAYLOAD_BYTES + 1]);
    let rejected = db.owner().append_audit(payload);
    assert_eq!(
        rejected.err(),
        Some(StoreError::ResourceLimit(ResourceLimit {
            field: "audit_payload",
            limit: MAX_AUDIT_PAYLOAD_BYTES,
            actual: MAX_AUDIT_PAYLOAD_BYTES + 1,
        }))
    );

    let query = "a".repeat(MAX_FTS_QUERY_BYTES);
    assert_eq!(
        must(db.owner().search(TextSearch::Episode, &query)),
        Vec::<String>::new()
    );
    let over_query = "a".repeat(MAX_FTS_QUERY_BYTES + 1);
    let rejected = db.owner().search(TextSearch::Episode, &over_query);
    assert_eq!(
        rejected.err(),
        Some(StoreError::ResourceLimit(ResourceLimit {
            field: "fts_query",
            limit: MAX_FTS_QUERY_BYTES,
            actual: MAX_FTS_QUERY_BYTES + 1,
        }))
    );

    must(db.owner().append(append_request(
        1 + MAX_THREAD_EVENTS_PER_APPEND as u64,
        85,
        vec![thread_event("event-2", "user", "hi")],
    )));
    let mut episode = episode_request();
    episode.body = "y".repeat(MAX_PROSE_BYTES + 1);
    let rejected = db.owner().insert_episode(episode);
    assert_eq!(
        rejected.err(),
        Some(StoreError::ResourceLimit(ResourceLimit {
            field: "episode_body",
            limit: MAX_PROSE_BYTES,
            actual: MAX_PROSE_BYTES + 1,
        }))
    );
}

#[test]
fn thread_batch_bytes_accepts_at_limit_and_rejects_one_byte_over() {
    let db = TestDb::open("thread-batch-bytes", 86);
    let body = "x".repeat(MAX_THREAD_EVENT_BODY_BYTES);
    let mut at_limit = Vec::new();
    for index in 0..4 {
        at_limit.push(thread_event(&format!("batch-at-{index}"), "user", &body));
    }
    assert_eq!(
        at_limit.iter().map(|event| event.body.len()).sum::<usize>(),
        MAX_THREAD_BATCH_BYTES
    );
    must(db.owner().append(append_request(0, 87, at_limit)));

    let mut over = Vec::new();
    for index in 0..4 {
        over.push(thread_event(&format!("batch-over-{index}"), "user", &body));
    }
    over.push(thread_event("batch-over-tail", "user", "x"));
    assert_eq!(
        over.iter().map(|event| event.body.len()).sum::<usize>(),
        MAX_THREAD_BATCH_BYTES + 1
    );
    let rejected = db.owner().append(append_request(4, 88, over));
    assert_eq!(
        rejected.err(),
        Some(StoreError::ResourceLimit(ResourceLimit {
            field: "thread_batch_bytes",
            limit: MAX_THREAD_BATCH_BYTES,
            actual: MAX_THREAD_BATCH_BYTES + 1,
        }))
    );
}

#[test]
fn debug_redacts_audit_bytes_and_thread_bodies() {
    let mut event = sample_audit(1, 0, "wake_accepted");
    event.canonical = b"super-secret-sentinel".to_vec();
    event.payload = Some(b"super-secret-sentinel".to_vec());
    let rendered = format!("{event:?}");
    assert!(!rendered.contains("super-secret-sentinel"));
    assert!(rendered.contains("<redacted len="));
    let body = thread_event("event-1", "user", "super-secret-sentinel");
    let rendered = format!("{body:?}");
    assert!(!rendered.contains("super-secret-sentinel"));
    assert!(rendered.contains("event-1"));
}

#[test]
fn vec_registration_state_fails_closed_and_races_enter_once() {
    assert_eq!(classify_vec_registration(0), Ok(VecRegistrationGate::Enter));
    assert_eq!(classify_vec_registration(1), Ok(VecRegistrationGate::Wait));
    assert_eq!(classify_vec_registration(2), Ok(VecRegistrationGate::Ready));
    assert_eq!(
        classify_vec_registration(3),
        Err(StoreError::VecRegistrationCorrupt { state: 3 })
    );
    assert_eq!(
        classify_vec_registration(255),
        Err(StoreError::VecRegistrationCorrupt { state: 255 })
    );
    let before = sqlite_vec_registration_entries();
    thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                must(register_sqlite_vec());
            });
        }
    });
    let after = sqlite_vec_registration_entries();
    assert!(after.saturating_sub(before) <= 1);
    must(register_sqlite_vec());
    assert_eq!(sqlite_vec_registration_entries(), after);
}

#[test]
fn concurrent_opens_of_one_path_share_one_migration_journal() {
    for round in 0..4 {
        let mut directory = std::env::temp_dir();
        directory.push(format!("maia-store-race-{}-{round}", process::id()));
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("temp dir: {error}"));
        let path = directory.join("maia.sqlite");
        let left_path = path.clone();
        let right_path = path.clone();
        let (left, right) = thread::scope(|scope| {
            let left = scope.spawn(move || {
                SqliteOwner::open(OwnerOpen {
                    path: left_path,
                    now: 111,
                    normal_capacity: 2,
                    panic_capacity: 1,
                })
            });
            let right = scope.spawn(move || {
                SqliteOwner::open(OwnerOpen {
                    path: right_path,
                    now: 222,
                    normal_capacity: 2,
                    panic_capacity: 1,
                })
            });
            let left = match left.join() {
                Ok(result) => must(result),
                Err(_) => panic!("left open panicked"),
            };
            let right = match right.join() {
                Ok(result) => must(result),
                Err(_) => panic!("right open panicked"),
            };
            (left, right)
        });
        must(left.ping());
        must(right.ping());
        must(left.shutdown());
        must(right.shutdown());
        let journal = dump(
            &path,
            "SELECT CAST(version AS TEXT), CAST(applied_at AS TEXT) FROM schema_migrations ORDER BY version",
        );
        let lines: Vec<&str> = journal.lines().collect();
        assert_eq!(lines.len(), 19, "journal for round {round}: {journal}");
        for (index, line) in lines.iter().enumerate() {
            assert!(
                line.starts_with(&format!("{}|", index + 1)),
                "journal for round {round}: {journal}"
            );
        }
        for line in lines {
            let applied_at = line.rsplit('|').next().unwrap_or("");
            assert!(
                applied_at == "111" || applied_at == "222",
                "unexpected migration owner: {journal}"
            );
        }
        let _ = fs::remove_dir_all(directory);
    }
}

fn seed_owner_brain(db: &TestDb) {
    must(db.owner().append(append_request(
        0,
        81,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    let mut promotion = promotion_request();
    promotion.claims.push(PromotionClaimWrite {
        claim_id: "claim-keep".to_owned(),
        sentence: "The router stays local.".to_owned(),
        taint: MemoryTaint::Untrusted,
        valid_from: 40,
        lexemes: vec!["router".to_owned()],
            ..Default::default()
        });
    must(db.owner().apply_promotion(promotion));
    must(
        db.owner()
            .apply_ledger(ledger_request("ledger-1", &["p1"], 1.0)),
    );
    let mut consolidation = consolidation_request("Obsidian opens the vault.");
    consolidation.facts.push(FactWrite {
        fact_id: "fact-old".to_owned(),
        sentence: "An older note.".to_owned(),
        entity_id: Some("entity-1".to_owned()),
        sources: "episode-1".to_owned(),
        valid_from: 40,
        claim_ids: Vec::new(),
        episode_ids: vec!["episode-1".to_owned()],
    });
    consolidation.merges.push(MergeWrite {
        duplicate_fact_id: "fact-old".to_owned(),
        canonical_fact_id: "fact-1".to_owned(),
    });
    consolidation.closures.push(ClosureWrite {
        fact_id: "fact-old".to_owned(),
        replacement_fact_id: "fact-1".to_owned(),
        valid_to: 90,
    });
    must(db.owner().apply_consolidation(consolidation));
}

fn brain_node<'a>(map: &'a BrainMap, id: &str) -> &'a BrainNode {
    map.nodes
        .iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("missing brain node {id}"))
}

fn unit_embedding() -> Vec<f32> {
    let mut values = vec![0.0_f32; 384];
    values[0] = 1.0;
    values
}

fn put_fact_embedding(db: &TestDb, fact_id: &str) {
    must(db.owner().put_embedding_model(EmbeddingModelWrite {
        model_id: "bge-small-en-v1.5".to_owned(),
        dimensions: 384,
        weights_sha256: "weights-sha".to_owned(),
        tokenizer_sha256: "tokenizer-sha".to_owned(),
        query_prefix: "query: ".to_owned(),
        document_prefix: "document: ".to_owned(),
        recorded_at: 162,
    }));
    must(db.owner().upsert_embedding(EmbeddingWrite {
        target: EmbeddingTarget::Fact,
        target_id: fact_id.to_owned(),
        model_id: "bge-small-en-v1.5".to_owned(),
        values: unit_embedding(),
    }));
    must(db.owner().upsert_embedding(EmbeddingWrite {
        target: EmbeddingTarget::Claim,
        target_id: "claim-1".to_owned(),
        model_id: "bge-small-en-v1.5".to_owned(),
        values: unit_embedding(),
    }));
}

#[test]
fn owner_revise_replaces_a_fact_sentence_and_trim_deletes_it() {
    let db = TestDb::open("brain-map", 80);
    seed_owner_brain(&db);
    let map = must(db.owner().brain_map());
    let ids: Vec<&str> = map.nodes.iter().map(|node| node.id.as_str()).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(ids, sorted, "brain map nodes are ordered by id");
    let fact = brain_node(&map, "fact-1");
    assert_eq!(fact.kind, BrainNodeKind::Fact);
    assert_eq!(fact.sentence.as_deref(), Some("Obsidian opens the vault."));
    assert_eq!(fact.session_id.as_deref(), Some("thread-1"));
    assert_eq!(fact.taint.as_deref(), Some("untrusted"));
    assert!(!fact.held);
    assert_eq!(
        brain_node(&map, "episode-1").sentence.as_deref(),
        Some("Obsidian opens the vault")
    );
    assert!(map.edges.iter().any(|edge| {
        edge.kind == "mention" && edge.from_id == "fact-1" && edge.to_id == "episode-1"
    }));

    let blank = db.owner().revise_fact(FactRevise {
        fact_id: "fact-1".to_owned(),
        sentence: " \n ".to_owned(),
        lexemes: Vec::new(),
    });
    assert!(matches!(blank, Err(StoreError::InvalidRequest { .. })));
    let missing = db.owner().revise_fact(FactRevise {
        fact_id: "missing-fact".to_owned(),
        sentence: "A real sentence.".to_owned(),
        lexemes: vec!["real".to_owned()],
    });
    assert_eq!(
        missing.err(),
        Some(StoreError::NotFound {
            entity: "fact",
            id: "missing-fact".to_owned(),
        })
    );
    assert_dump(
        db.file(),
        "SELECT sentence FROM facts WHERE fact_id = 'fact-1'",
        "Obsidian opens the vault.",
    );

    put_fact_embedding(&db, "fact-1");
    let revised = must(db.owner().revise_fact(FactRevise {
        fact_id: "fact-1".to_owned(),
        sentence: "Notes stay on this computer.".to_owned(),
        lexemes: vec!["notes".to_owned(), "computer".to_owned()],
    }));
    assert_eq!(
        revised
            .value
            .nodes
            .iter()
            .find(|node| node.id == "fact-1")
            .map(|node| node.sentence.as_deref()),
        Some(Some("Notes stay on this computer."))
    );
    assert_dump(
        db.file(),
        "SELECT fact_id, sentence FROM facts WHERE fact_id = 'fact-1'",
        "fact-1|Notes stay on this computer.",
    );
    assert_dump(
        db.file(),
        "SELECT sentence FROM facts WHERE sentence = 'Obsidian opens the vault.'",
        "",
    );
    assert_dump(
        db.file(),
        "SELECT claim_id, sentence FROM claims WHERE claim_id = 'claim-1'",
        "claim-1|Notes stay on this computer.",
    );
    assert_dump(
        db.file(),
        "SELECT sentence FROM claims WHERE sentence = 'Obsidian opens the vault.'",
        "",
    );
    assert_dump(
        db.file(),
        "SELECT to_id FROM edges WHERE edge_kind = 'lexeme' AND from_kind = 'fact' AND from_id = 'fact-1' ORDER BY to_id",
        "computer\nnotes",
    );
    assert_dump(
        db.file(),
        "SELECT lexeme_id FROM lexemes ORDER BY lexeme_id",
        "computer\nnotes\nrouter",
    );
    assert_eq!(
        must(db.owner().embedding(EmbeddingTarget::Fact, "fact-1")),
        None
    );
    assert_eq!(
        must(db.owner().embedding(EmbeddingTarget::Claim, "claim-1")),
        None
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Claim, "computer")),
        vec!["claim-1".to_owned()]
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Claim, "obsidian")),
        Vec::<String>::new()
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Episode, "obsidian")),
        vec!["episode-1".to_owned()]
    );

    put_fact_embedding(&db, "fact-1");
    let unknown = db.owner().delete_fact("missing-fact");
    assert_eq!(
        unknown.err(),
        Some(StoreError::NotFound {
            entity: "fact",
            id: "missing-fact".to_owned(),
        })
    );
    let deleted = must(db.owner().delete_fact("fact-1"));
    assert!(deleted.value.nodes.iter().all(|node| node.id != "fact-1"));
    assert!(
        deleted
            .value
            .nodes
            .iter()
            .all(|node| node.sentence.as_deref() != Some("Notes stay on this computer."))
    );
    assert_eq!(
        brain_node(&deleted.value, "episode-1").sentence.as_deref(),
        Some("Obsidian opens the vault")
    );
    assert_dump(
        db.file(),
        "SELECT fact_id FROM facts WHERE fact_id = 'fact-1'",
        "",
    );
    assert_dump(
        db.file(),
        "SELECT claim_id FROM claims WHERE claim_id = 'claim-1'",
        "",
    );
    assert_dump(
        db.file(),
        "SELECT claim_id, sentence FROM claims ORDER BY claim_id",
        "claim-keep|The router stays local.",
    );
    assert_dump(
        db.file(),
        "SELECT fact_id, merged_into IS NULL, replacement_fact_id IS NULL FROM facts ORDER BY fact_id",
        "fact-old|1|1",
    );
    assert_dump(
        db.file(),
        "SELECT body FROM episodes",
        "Obsidian opens the vault",
    );
    assert_dump(
        db.file(),
        "SELECT consolidated_by FROM claims WHERE consolidated_by = 'fact-1'",
        "",
    );
    assert_eq!(
        must(db.owner().embedding(EmbeddingTarget::Fact, "fact-1")),
        None
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Episode, "obsidian")),
        vec!["episode-1".to_owned()]
    );
    assert_eq!(
        must(db.owner().search(TextSearch::Claim, "router")),
        vec!["claim-keep".to_owned()]
    );
}

fn unit_vector(hot: usize) -> Vec<f32> {
    let mut values = vec![0.0_f32; 384];
    values[hot] = 1.0;
    values
}

fn register_embedder(db: &TestDb, model_id: &str) {
    must(db.owner().put_embedding_model(EmbeddingModelWrite {
        model_id: model_id.to_owned(),
        dimensions: 384,
        weights_sha256: "weights-sha".to_owned(),
        tokenizer_sha256: "tokenizer-sha".to_owned(),
        query_prefix: "query: ".to_owned(),
        document_prefix: "document: ".to_owned(),
        recorded_at: 162,
    }));
}

#[test]
fn probe_vector_write_leaves_no_claim_row() {
    let db = TestDb::open("vec-probe", 70);
    must(db.owner().probe_vector_write());
    assert_eq!(dump(db.file(), "SELECT COUNT(*) FROM claim_vec"), "0");
    assert_eq!(dump(db.file(), "SELECT COUNT(*) FROM embedding_rows"), "0");
}

#[test]
fn nearest_claims_and_recall_omit_superseded_claims() {
    let db = TestDb::open("promo-closed-nearest", 60);
    must(db.owner().append(append_request(
        0,
        61,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-1".to_owned(),
        model: "model-a".to_owned(),
        now: 62,
        claims: vec![PromotionClaimWrite {
            claim_id: "claim-old".to_owned(),
            sentence: "Bob uses Obsidian.".to_owned(),
            taint: MemoryTaint::Untrusted,
            valid_from: 40,
            lexemes: vec!["bob".to_owned(), "obsidian".to_owned()],
            ..Default::default()
        }],
        same_claim_ids: Vec::new(),
        replacements: Vec::new(),
        links: Vec::new(),
    session_bot_id: String::new(),
    session_summary: String::new(),
    }));
    let mut episode_two = episode_request();
    episode_two.episode_id = "episode-2".to_owned();
    episode_two.turn_id = "turn-2".to_owned();
    episode_two.body = "Bob prefers Neovim.".to_owned();
    episode_two.created_at = 50;
    episode_two.segments[0].text = "Bob prefers Neovim.".to_owned();
    must(db.owner().insert_episode(episode_two));
    must(db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-2".to_owned(),
        model: "model-b".to_owned(),
        now: 70,
        claims: vec![PromotionClaimWrite {
            claim_id: "claim-new".to_owned(),
            sentence: "Bob prefers Neovim.".to_owned(),
            taint: MemoryTaint::Untrusted,
            valid_from: 50,
            lexemes: vec!["bob".to_owned(), "neovim".to_owned()],
            ..Default::default()
        }],
        same_claim_ids: Vec::new(),
        replacements: vec![PromotionReplaceWrite {
            old_claim_id: "claim-old".to_owned(),
            new_claim_id: "claim-new".to_owned(),
        }],
        links: Vec::new(),
    session_bot_id: String::new(),
    session_summary: String::new(),
    }));
    assert_eq!(
        must(db.owner().nearest_claims("Obsidian", 5)),
        Vec::<NearestClaimRow>::new()
    );
    assert_eq!(
        must(db.owner().nearest_claims("Neovim", 5)),
        vec![NearestClaimRow {
            claim_id: "claim-new".to_owned(),
            sentence: "Bob prefers Neovim.".to_owned(),
        }]
    );
    let map = must(db.owner().recall_subgraph(&[], &["bob".to_owned()], 2));
    let claims = map
        .nodes
        .iter()
        .filter(|node| node.kind == BrainNodeKind::Claim)
        .map(|node| node.id.as_str())
        .collect::<Vec<_>>();
    assert!(claims.contains(&"claim-new"));
    assert!(!claims.contains(&"claim-old"));
}

#[test]
fn nearest_claim_vectors_keep_the_same_model_and_the_nearer_claim() {
    let db = TestDb::open("claim-knn", 80);
    must(db.owner().append(append_request(
        0,
        81,
        vec![thread_event("event-1", "user", "hi")],
    )));
    must(db.owner().insert_episode(episode_request()));
    must(db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-1".to_owned(),
        model: "model-a".to_owned(),
        now: 82,
        claims: vec![
            PromotionClaimWrite {
                claim_id: "claim-near".to_owned(),
                sentence: "The near claim.".to_owned(),
                taint: MemoryTaint::Trusted,
                valid_from: 40,
                lexemes: vec!["near".to_owned()],
            ..Default::default()
        },
            PromotionClaimWrite {
                claim_id: "claim-far".to_owned(),
                sentence: "The far claim.".to_owned(),
                taint: MemoryTaint::Trusted,
                valid_from: 40,
                lexemes: vec!["far".to_owned()],
            ..Default::default()
        },
            PromotionClaimWrite {
                claim_id: "claim-other".to_owned(),
                sentence: "The other model claim.".to_owned(),
                taint: MemoryTaint::Trusted,
                valid_from: 40,
                lexemes: vec!["other".to_owned()],
            ..Default::default()
        },
        ],
        same_claim_ids: Vec::new(),
        replacements: Vec::new(),
        links: Vec::new(),
    session_bot_id: String::new(),
    session_summary: String::new(),
    }));
    register_embedder(&db, "bge-small-en-v1.5");
    register_embedder(&db, "other-model");
    must(db.owner().upsert_embedding(EmbeddingWrite {
        target: EmbeddingTarget::Claim,
        target_id: "claim-near".to_owned(),
        model_id: "bge-small-en-v1.5".to_owned(),
        values: unit_vector(0),
    }));
    must(db.owner().upsert_embedding(EmbeddingWrite {
        target: EmbeddingTarget::Claim,
        target_id: "claim-far".to_owned(),
        model_id: "bge-small-en-v1.5".to_owned(),
        values: unit_vector(1),
    }));
    must(db.owner().upsert_embedding(EmbeddingWrite {
        target: EmbeddingTarget::Claim,
        target_id: "claim-other".to_owned(),
        model_id: "other-model".to_owned(),
        values: unit_vector(0),
    }));
    let hits = must(
        db.owner()
            .nearest_claim_vectors("bge-small-en-v1.5", &unit_vector(0), 5),
    );
    assert_eq!(
        hits.first().map(|hit| hit.claim_id.as_str()),
        Some("claim-near")
    );
    assert!(hits.iter().any(|hit| hit.claim_id == "claim-far"));
    assert!(hits.iter().all(|hit| hit.claim_id != "claim-other"));
    assert!(matches!(
        must(db.owner().embedding_for_model(
            EmbeddingTarget::Claim,
            "claim-other",
            "bge-small-en-v1.5",
        )),
        None
    ));
    let other = must(db.owner().embedding_for_model(
        EmbeddingTarget::Claim,
        "claim-other",
        "other-model",
    ));
    assert_eq!(other.as_ref().map(Vec::len), Some(384));
    assert!(
        hits.windows(2)
            .all(|pair| pair[0].distance_bits <= pair[1].distance_bits)
    );
}

fn durable_dump(path: &Path) -> String {
    let tables = [
        "SELECT 'threads', thread_id, CAST(version AS TEXT), participants, CAST(created_at AS TEXT) \
         FROM threads",
        "SELECT 'events', thread_id, CAST(ordinal AS TEXT), event_id, kind, body, \
         CAST(occurred_at AS TEXT) FROM thread_events",
        "SELECT 'episodes', episode_id, body, taint, CAST(promoted_at AS TEXT) FROM episodes",
        "SELECT 'claims', claim_id, status, ifnull(consolidated_by, '') FROM claims",
        "SELECT 'facts', fact_id, sentence, taint FROM facts",
        "SELECT 'ledgers', ledger_id, request_id FROM ledgers",
        "SELECT 'heat', slot_id, printf('%.6f', heat) FROM slot_heat",
        "SELECT 'projections', batch_id, progress, CAST(created_at AS TEXT) FROM projections",
        "SELECT 'audit', CAST(sequence AS TEXT), event_id, kind, previous_hash, event_hash, profile \
         FROM audit_events",
        "SELECT 'settings', profile, CAST(activated_at AS TEXT), activated_by FROM security_settings",
    ];
    let mut lines = Vec::new();
    for sql in tables {
        let dumped = dump(path, sql);
        if !dumped.is_empty() {
            lines.push(dumped);
        }
    }
    lines.join("\n")
}
