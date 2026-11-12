//! Super Agent migration v3 and store round-trip contracts.

use std::fs;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use rusqlite::Connection;

use maia_store::AppendEvents;
use maia_store::BotRequest;
use maia_store::BotResponse;
use maia_store::ChildAssignmentWrite;
use maia_store::EpisodeWrite;
use maia_store::LATEST_SCHEMA_VERSION;
use maia_store::MAX_PROSE_BYTES;
use maia_store::MAX_THREAD_EVENT_BODY_BYTES;
use maia_store::MemoryTaint;
use maia_store::MessageSubmissionState;
use maia_store::MessageSubmissionWrite;
use maia_store::ModelConnectionRecord;
use maia_store::OwnerOpen;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionWrite;
use maia_store::RUNTIME_ID_NAMESPACE_COUNT;
use maia_store::RouterMessageWrite;
use maia_store::RuntimeIdNamespace;
use maia_store::SegmentWrite;
use maia_store::SnapshotItemWrite;
use maia_store::SqliteOwner;
use maia_store::StoreError;
use maia_store::StoredSubmissionOutcome;
use maia_store::TaskAggregateWrite;
use maia_store::TaskAttemptWrite;
use maia_store::TaskCriterionWrite;
use maia_store::TaskEnvelopeWrite;
use maia_store::TaskEvidenceWrite;
use maia_store::TaskInputWrite;
use maia_store::TaskReportWrite;
use maia_store::TaskWrite;
use maia_store::TextSearch;
use maia_store::ThreadEventWrite;
use maia_store::decode_canonical_fields;
use maia_store::runtime_id_contracts;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

struct TestDb {
    directory: PathBuf,
    file: PathBuf,
    owner: Option<SqliteOwner>,
}

impl TestDb {
    fn open(name: &str, now: i64) -> Self {
        let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let mut directory = std::env::temp_dir();
        directory.push("maia-store-super-agent");
        directory.push(format!("{name}-{}-{sequence}", process::id()));
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("create temp dir: {error}"));
        let file = directory.join("maia.sqlite");
        let owner = must(SqliteOwner::open(OwnerOpen {
            path: file.clone(),
            now,
            normal_capacity: 8,
            panic_capacity: 2,
        }));
        Self {
            directory,
            file,
            owner: Some(owner),
        }
    }

    fn owner(&self) -> &SqliteOwner {
        self.owner
            .as_ref()
            .unwrap_or_else(|| panic!("owner already shut down"))
    }

    fn file(&self) -> &PathBuf {
        &self.file
    }

    fn close(&mut self) {
        if let Some(owner) = self.owner.take() {
            let _ = owner.shutdown();
        }
    }

    fn reopen(&mut self, now: i64) {
        if let Some(owner) = self.owner.take() {
            let _ = owner.shutdown();
        }
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
        let _ = fs::remove_dir_all(&self.directory);
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

fn scalar_text(path: &PathBuf, sql: &str) -> String {
    let connection = ready(Connection::open(path));
    ready(connection.query_row(sql, [], |row| row.get(0)))
}

fn scalar_i64(path: &PathBuf, sql: &str) -> i64 {
    let connection = ready(Connection::open(path));
    let value: i64 = ready(connection.query_row(sql, [], |row| row.get(0)));
    value
}

fn exec(path: &PathBuf, sql: &str) {
    let connection = ready(Connection::open(path));
    ready(connection.execute_batch(sql));
}

fn sample_task(task_id: &str, created_at: i64) -> TaskWrite {
    TaskWrite {
        task_id: task_id.to_owned(),
        phase: "queued".to_owned(),
        title: "Pin control".to_owned(),
        pin: "unpinned".to_owned(),
        completion_view: "unopened".to_owned(),
        prior_task_id: None,
        created_at,
        attempt_id: "attempt-1".to_owned(),
        attempt_state: "active".to_owned(),
    }
}

fn sample_envelope(task_id: &str, prompt: &[u8]) -> TaskEnvelopeWrite {
    TaskEnvelopeWrite {
        task_id: task_id.to_owned(),
        prompt: prompt.to_vec(),
        brief: "advisory".to_owned(),
        routing_reason: "create_task".to_owned(),
        snapshot_id: "snap-1".to_owned(),
    }
}

fn sample_task_aggregate(task_id: &str) -> TaskAggregateWrite {
    TaskAggregateWrite {
        task: sample_task(task_id, 2),
        envelope: sample_envelope(task_id, b"goal"),
        snapshot_items: vec![SnapshotItemWrite {
            memory_id: "memory-1".to_owned(),
            provenance: "fact:memory-1".to_owned(),
            trust: "trusted".to_owned(),
            sentence: "Useful context.".to_owned(),
        }],
        criteria: vec![TaskCriterionWrite {
            criterion_id: "criterion-1".to_owned(),
            task_id: task_id.to_owned(),
            source_kind: "user_text".to_owned(),
            source_ref: "m-1".to_owned(),
            span_start: Some(0),
            span_end: Some(4),
            text: "goal".to_owned(),
        }],
    }
}

#[test]
fn public_child_writes_match_restart_contract() {
    for (name, subgoal) in [
        ("child-empty", Vec::new()),
        ("child-invalid-utf8", vec![0x80]),
    ] {
        let db = TestDb::open(name, 1);
        must(db.owner().insert_task(sample_task("parent", 2)));
        let before = scalar_text(
            db.file(),
            "SELECT value FROM runtime_id_high_water WHERE namespace = 'child'",
        );
        let result = db.owner().insert_child(ChildAssignmentWrite {
            child_id: "child-1".to_owned(),
            parent_task_id: "parent".to_owned(),
            depth: 1,
            subgoal,
            budget_tokens: 0,
            budget_turns: 0,
        });
        assert!(
            matches!(result, Err(StoreError::InvalidRequest { .. })),
            "{name}"
        );
        assert_eq!(
            scalar_i64(db.file(), "SELECT COUNT(*) FROM child_assignments"),
            0
        );
        assert_eq!(
            scalar_text(
                db.file(),
                "SELECT value FROM runtime_id_high_water WHERE namespace = 'child'"
            ),
            before
        );
    }

    let db = TestDb::open("child-valid-boundaries", 1);
    must(db.owner().insert_task(sample_task("parent", 2)));
    must(db.owner().insert_child(ChildAssignmentWrite {
        child_id: "child-1".to_owned(),
        parent_task_id: "parent".to_owned(),
        depth: 1,
        subgoal: vec![b'x'; MAX_THREAD_EVENT_BODY_BYTES],
        budget_tokens: 0,
        budget_turns: 0,
    }));
}

#[test]
fn child_depth_65_write_preserves_state_and_high_water() {
    let db = TestDb::open("child-depth-65", 1);
    must(db.owner().insert_task(sample_task("parent", 2)));
    let high_water = scalar_text(
        db.file(),
        "SELECT value FROM runtime_id_high_water WHERE namespace = 'child'",
    );

    assert!(matches!(
        db.owner().insert_child(ChildAssignmentWrite {
            child_id: "child-65".to_owned(),
            parent_task_id: "parent".to_owned(),
            depth: 65,
            subgoal: b"too deep".to_vec(),
            budget_tokens: 0,
            budget_turns: 0,
        }),
        Err(StoreError::InvalidRequest { .. })
    ));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM child_assignments"),
        0
    );
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT value FROM runtime_id_high_water WHERE namespace = 'child'"
        ),
        high_water
    );
}

#[test]
fn public_pin_and_view_writes_match_restart_contract() {
    for (name, pin, view) in [
        ("pin-future", Some("future"), None),
        ("view-future", None, Some("future")),
        ("view-empty-detail", None, Some("open:")),
    ] {
        let db = TestDb::open(name, 1);
        must(db.owner().insert_task(sample_task("task-1", 2)));
        let before = scalar_text(
            db.file(),
            "SELECT pinned || ':' || completion_view FROM task_sessions",
        );
        let result = match (pin, view) {
            (Some(pin), None) => db.owner().set_pin("task-1", pin),
            (None, Some(view)) => db.owner().set_completion_view("task-1", view),
            _ => panic!("invalid fixture"),
        };
        assert!(
            matches!(result, Err(StoreError::InvalidRequest { .. })),
            "{name}"
        );
        assert_eq!(
            scalar_text(
                db.file(),
                "SELECT pinned || ':' || completion_view FROM task_sessions"
            ),
            before
        );
    }
}

#[test]
fn public_task_and_router_writes_match_restart_contract() {
    for (name, phase, attempt_state) in [
        ("task-phase", "future", "active"),
        ("task-attempt-state", "queued", "future"),
    ] {
        let db = TestDb::open(name, 1);
        let result = db.owner().insert_task(TaskWrite {
            phase: phase.to_owned(),
            attempt_state: attempt_state.to_owned(),
            ..sample_task("task-1", 2)
        });
        assert!(
            matches!(result, Err(StoreError::InvalidRequest { .. })),
            "{name}"
        );
        assert_eq!(
            scalar_i64(db.file(), "SELECT COUNT(*) FROM task_sessions"),
            0
        );
    }

    let db = TestDb::open("router-role", 1);
    assert!(matches!(
        db.owner().insert_router_message(RouterMessageWrite {
            message_id: "m-1".to_owned(),
            role: "future".to_owned(),
            body: "goal".to_owned(),
            created_at: 1,
        }),
        Err(StoreError::InvalidRequest { .. })
    ));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM router_messages"),
        0
    );
}

#[test]
fn lowercase_phase_escape_is_rejected_by_write_and_shared_decoder() {
    assert!(decode_canonical_fields("running:attempt%3a1").is_err());
    let db = TestDb::open("lowercase-phase-escape", 1);
    assert!(matches!(
        db.owner().insert_task(TaskWrite {
            phase: "running:attempt%3a1".to_owned(),
            attempt_id: "attempt:1".to_owned(),
            ..sample_task("task-1", 2)
        }),
        Err(StoreError::InvalidRequest { .. })
    ));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM task_sessions"),
        0
    );
}

#[test]
fn canonical_phase_round_trips_through_shared_decoder() {
    assert_eq!(
        decode_canonical_fields("waiting:unknown:attempt%3A1:call%2C1").expect("canonical fields"),
        vec![
            "waiting".to_owned(),
            "unknown".to_owned(),
            "attempt:1".to_owned(),
            "call,1".to_owned(),
        ]
    );
}

#[test]
fn public_envelope_and_context_writes_match_restart_contract() {
    for (name, brief, reason) in [
        ("envelope-brief", "future", "create_task"),
        ("envelope-reason", "advisory", "future"),
    ] {
        let db = TestDb::open(name, 1);
        must(db.owner().insert_task(sample_task("task-1", 2)));
        let result = db.owner().insert_task_envelope(TaskEnvelopeWrite {
            brief: brief.to_owned(),
            routing_reason: reason.to_owned(),
            ..sample_envelope("task-1", b"goal")
        });
        assert!(
            matches!(result, Err(StoreError::InvalidRequest { .. })),
            "{name}"
        );
        assert_eq!(
            scalar_i64(db.file(), "SELECT COUNT(*) FROM task_envelopes"),
            0
        );
    }

    for (name, provenance, trust) in [
        ("context-provenance", "future", "trusted"),
        ("context-trust", "fact:memory-1", "future"),
    ] {
        let db = TestDb::open(name, 1);
        let result = db.owner().insert_context_snapshot(
            "snap-1",
            &[SnapshotItemWrite {
                memory_id: "memory-1".to_owned(),
                provenance: provenance.to_owned(),
                trust: trust.to_owned(),
                sentence: String::new(),
            }],
        );
        assert!(
            matches!(result, Err(StoreError::InvalidRequest { .. })),
            "{name}"
        );
        assert_eq!(
            scalar_i64(db.file(), "SELECT COUNT(*) FROM context_snapshots"),
            0
        );
    }
}

#[test]
fn public_criterion_writes_match_restart_contract() {
    for (name, source_kind, source_ref, start, end, text) in [
        (
            "criterion-text",
            "user_text",
            "m-1",
            Some(0),
            Some(4),
            "nope",
        ),
        (
            "criterion-negative",
            "user_text",
            "m-1",
            Some(-1),
            Some(4),
            "goal",
        ),
        (
            "criterion-span",
            "user_text",
            "m-1",
            Some(0),
            Some(3),
            "goal",
        ),
        ("criterion-kind", "future", "m-1", None, None, "goal"),
        (
            "criterion-source",
            "user_text",
            "missing",
            Some(0),
            Some(4),
            "goal",
        ),
    ] {
        let db = TestDb::open(name, 1);
        must(db.owner().insert_router_message(RouterMessageWrite {
            message_id: "m-1".to_owned(),
            role: "user".to_owned(),
            body: "goal".to_owned(),
            created_at: 1,
        }));
        must(db.owner().insert_task(sample_task("task-1", 2)));
        must(
            db.owner()
                .insert_task_envelope(sample_envelope("task-1", b"goal")),
        );
        let result = db.owner().insert_task_criterion(TaskCriterionWrite {
            criterion_id: "criterion-1".to_owned(),
            task_id: "task-1".to_owned(),
            source_kind: source_kind.to_owned(),
            source_ref: source_ref.to_owned(),
            span_start: start,
            span_end: end,
            text: text.to_owned(),
        });
        assert!(
            matches!(result, Err(StoreError::InvalidRequest { .. })),
            "{name}"
        );
        assert_eq!(
            scalar_i64(db.file(), "SELECT COUNT(*) FROM task_criteria"),
            0
        );
    }

    let db = TestDb::open("criterion-valid", 1);
    must(db.owner().insert_router_message(RouterMessageWrite {
        message_id: "m-1".to_owned(),
        role: "user".to_owned(),
        body: "goal".to_owned(),
        created_at: 1,
    }));
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(
        db.owner()
            .insert_task_envelope(sample_envelope("task-1", b"goal")),
    );
    must(db.owner().insert_task_criterion(TaskCriterionWrite {
        criterion_id: "criterion-1".to_owned(),
        task_id: "task-1".to_owned(),
        source_kind: "user_text".to_owned(),
        source_ref: "m-1".to_owned(),
        span_start: Some(0),
        span_end: Some(4),
        text: "goal".to_owned(),
    }));
    assert_eq!(
        scalar_i64(
            db.file(),
            "SELECT ordinal FROM task_criteria WHERE criterion_id = 'criterion-1'"
        ),
        0
    );
}

#[test]
fn failed_canonical_writes_preserve_exact_state_and_high_water() {
    let db = TestDb::open("canonical-write-rollback", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    let session_before = scalar_text(
        db.file(),
        "SELECT phase || ':' || pinned || ':' || completion_view FROM task_sessions",
    );
    let high_water_before = scalar_text(
        db.file(),
        "SELECT group_concat(namespace || '=' || value, ',') FROM \
         (SELECT namespace, value FROM runtime_id_high_water ORDER BY namespace)",
    );

    assert!(db.owner().set_pin("task-1", "future").is_err());
    assert!(db.owner().set_completion_view("task-1", "open:").is_err());
    assert!(
        db.owner()
            .insert_child(ChildAssignmentWrite {
                child_id: "child-50".to_owned(),
                parent_task_id: "task-1".to_owned(),
                depth: 1,
                subgoal: Vec::new(),
                budget_tokens: 0,
                budget_turns: 0,
            })
            .is_err()
    );

    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase || ':' || pinned || ':' || completion_view FROM task_sessions"
        ),
        session_before
    );
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT group_concat(namespace || '=' || value, ',') FROM \
             (SELECT namespace, value FROM runtime_id_high_water ORDER BY namespace)"
        ),
        high_water_before
    );
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM child_assignments"),
        0
    );
}

#[test]
fn runtime_namespace_registry_is_exhaustive() {
    let contracts = runtime_id_contracts();
    assert_eq!(contracts.len(), RUNTIME_ID_NAMESPACE_COUNT);
    assert_eq!(
        contracts
            .iter()
            .map(|contract| contract.namespace)
            .collect::<std::collections::BTreeSet<_>>(),
        RuntimeIdNamespace::ALL.into_iter().collect()
    );
    assert!(contracts.iter().all(|contract| {
        !contract.key.is_empty()
            && matches!(
                contract.allocation,
                maia_store::RuntimeIdAllocation::ReservedBlock
                    | maia_store::RuntimeIdAllocation::OwningCommitOrReservedBlock
            )
    }));
    assert!(contracts.iter().any(|contract| {
        contract.namespace == RuntimeIdNamespace::Child
            && matches!(
                contract.allocation,
                maia_store::RuntimeIdAllocation::OwningCommitOrReservedBlock
            )
    }));
    let bump_only = contracts
        .iter()
        .filter(|contract| {
            matches!(
                contract.migration,
                maia_store::RuntimeIdMigration::LegacyBumpOnly
            )
        })
        .map(|contract| contract.namespace)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        bump_only,
        [RuntimeIdNamespace::Envelope, RuntimeIdNamespace::Request]
            .into_iter()
            .collect()
    );
    let db = TestDb::open("runtime-id-registry-table", 1);
    let connection = ready(Connection::open(db.file()));
    let mut statement =
        ready(connection.prepare("SELECT namespace FROM runtime_id_high_water ORDER BY namespace"));
    let stored = ready(statement.query_map([], |row| row.get::<_, String>(0)))
        .collect::<Result<std::collections::BTreeSet<_>, _>>()
        .unwrap_or_else(|error| panic!("registry rows: {error}"));
    assert_eq!(
        stored,
        contracts
            .iter()
            .map(|contract| contract.key.to_owned())
            .collect()
    );
    drop(statement);
    drop(connection);
    let reserved = must(db.owner().reserve_runtime_id_block(1));
    for contract in contracts {
        assert_eq!(reserved.first(contract.namespace), 1);
    }
}

#[test]
fn runtime_id_block_reservation_is_atomic_and_exhaustive() {
    let db = TestDb::open("runtime-id-reservation", 1);

    let first = must(db.owner().reserve_runtime_id_block(4));
    let second = must(db.owner().reserve_runtime_id_block(4));

    for namespace in RuntimeIdNamespace::ALL {
        assert_eq!(first.first(namespace), 1, "{namespace:?}");
        assert_eq!(second.first(namespace), 5, "{namespace:?}");
    }
    assert_eq!(
        scalar_i64(
            db.file(),
            "SELECT COUNT(*) FROM runtime_id_high_water WHERE CAST(value AS INTEGER) = 8"
        ),
        i64::try_from(RUNTIME_ID_NAMESPACE_COUNT).expect("namespace count")
    );
}

#[test]
fn runtime_reservation_token_projects_http_ranges_once() {
    let db = TestDb::open("runtime-http-reservation-token", 1);
    let reserved = must(db.owner().reserve_runtime_id_block(4));
    let (seeds, http) = reserved.into_parts();

    assert_eq!(seeds.detail, 1);
    assert_eq!(seeds.decision, 1);
    assert_eq!(http.detail_first(), 1);
    assert_eq!(http.decision_first(), 1);
    assert_eq!(http.count(), 4);
}

#[test]
fn runtime_id_reservation_overflow_fails_closed() {
    let db = TestDb::open("runtime-id-reservation-overflow", 1);
    exec(
        db.file(),
        "UPDATE runtime_id_high_water SET value = '18446744073709551615' \
         WHERE namespace = 'request'",
    );
    let before = scalar_text(
        db.file(),
        "SELECT group_concat(namespace || '=' || value, ',') \
         FROM (SELECT namespace, value FROM runtime_id_high_water ORDER BY namespace)",
    );

    assert!(matches!(
        db.owner().reserve_runtime_id_block(1),
        Err(StoreError::InvalidRequest { .. })
    ));
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT group_concat(namespace || '=' || value, ',') \
             FROM (SELECT namespace, value FROM runtime_id_high_water ORDER BY namespace)"
        ),
        before
    );
}

#[test]
fn runtime_id_block_reservation_rolls_back_when_registry_is_incomplete() {
    let db = TestDb::open("runtime-id-reservation-missing-row", 1);
    exec(
        db.file(),
        "DELETE FROM runtime_id_high_water WHERE namespace = 'command'",
    );

    assert!(matches!(
        db.owner().reserve_runtime_id_block(4),
        Err(StoreError::InvalidRequest { .. })
    ));
    assert_eq!(
        scalar_i64(
            db.file(),
            "SELECT COUNT(*) FROM runtime_id_high_water WHERE value <> '0'"
        ),
        0
    );
}

#[test]
fn runtime_snapshot_derives_every_durable_id_seed() {
    let db = TestDb::open("runtime-id-seeds", 1);
    exec(
        db.file(),
        "INSERT INTO router_messages VALUES ('m-9', 1, 'user', 'seed', 1);
         INSERT INTO task_sessions VALUES
           ('task-10', 'cancelled:21', 'command', 'unpinned', 'unopened', NULL, 1),
           ('task-11', 'abandoned:decision-22', 'decision', 'unpinned', 'unopened', NULL, 2),
           ('task-12', 'waiting:approval:23', 'request', 'unpinned', 'unopened', NULL, 3),
           ('task-13', 'waiting:unknown:attempt-14:call-20', 'call', 'unpinned',
            'open:detail-24', NULL, 4);
         INSERT INTO task_attempts VALUES ('task-13', 'attempt-14', 'active');
         INSERT INTO task_envelopes VALUES ('task-13', X'78', 'brief', 'reason', 'snap-15');
         INSERT INTO task_inputs VALUES ('task-13', 'm-15', X'79');
         INSERT INTO task_criteria
           (criterion_id, task_id, source_kind, source_ref, span_start, span_end, text)
           VALUES ('criterion-16', 'task-13', 'user_text', 'm-15', 0, 1, 'y');
         INSERT INTO task_evidence VALUES ('evidence-17', 'task-13', 'attempt-14', 'proof');
         INSERT INTO task_reports VALUES
           ('report-18', 'task-13', 'attempt-14', 'progress', 'step', 5, 'call-19');
         INSERT INTO child_assignments
           (child_id, parent_task_id, depth, subgoal, budget_tokens, budget_turns, phase)
           VALUES ('child-20', 'task-13', 1, X'7A', 1, 1, 'cancelled:21');",
    );

    let seeds = must(db.owner().runtime_snapshot()).id_seeds;

    assert_eq!(seeds.message, 16);
    assert_eq!(seeds.task, 14);
    assert_eq!(seeds.attempt, 15);
    assert_eq!(seeds.envelope, 1);
    assert_eq!(seeds.report, 19);
    assert_eq!(seeds.call, 20);
    assert_eq!(seeds.evidence, 18);
    assert_eq!(seeds.snapshot, 16);
    assert_eq!(seeds.criterion, 17);
    assert_eq!(seeds.request, 1);
    assert_eq!(seeds.child, 21);
    assert_eq!(seeds.detail, 25);
    assert_eq!(seeds.decision, 23);
    assert_eq!(seeds.command, 22);
}

#[test]
fn runtime_snapshot_derives_command_seed_from_stopped_phases() {
    let db = TestDb::open("runtime-id-seeds-stopped", 1);
    exec(
        db.file(),
        "INSERT INTO router_messages VALUES ('m-9', 1, 'user', 'seed', 1);
         INSERT INTO task_sessions VALUES
           ('task-10', 'stopped:31', 'command', 'unpinned', 'unopened', NULL, 1);
         INSERT INTO child_assignments
           (child_id, parent_task_id, depth, subgoal, budget_tokens, budget_turns, phase)
           VALUES ('child-20', 'task-10', 1, X'7A', 1, 1, 'stopped:33');",
    );

    let seeds = must(db.owner().runtime_snapshot()).id_seeds;

    assert_eq!(seeds.command, 34);
}

#[test]
fn runtime_snapshot_captures_complete_task_state() {
    let db = TestDb::open("runtime-snapshot-complete", 1);
    must(db.owner().insert_router_message(RouterMessageWrite {
        message_id: "m-1".to_owned(),
        role: "user".to_owned(),
        body: "goal".to_owned(),
        created_at: 1,
    }));
    must(
        db.owner()
            .insert_task_aggregate(sample_task_aggregate("task-1")),
    );
    must(db.owner().insert_task_input(TaskInputWrite {
        task_id: "task-1".to_owned(),
        message_id: "m-2".to_owned(),
        prompt: b"more".to_vec(),
    }));
    must(db.owner().insert_report(TaskReportWrite {
        report_id: "report-1".to_owned(),
        task_id: "task-1".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        kind: "progress".to_owned(),
        summary: "working".to_owned(),
        created_at: 3,
        call_id: "call-1".to_owned(),
    }));
    must(db.owner().insert_task_evidence(TaskEvidenceWrite {
        evidence_id: "evidence-1".to_owned(),
        task_id: "task-1".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        body: "proof".to_owned(),
    }));
    must(db.owner().insert_child(ChildAssignmentWrite {
        child_id: "child-1".to_owned(),
        parent_task_id: "task-1".to_owned(),
        depth: 1,
        subgoal: b"slice".to_vec(),
        budget_tokens: 10,
        budget_turns: 2,
    }));

    let snapshot = must(db.owner().runtime_snapshot());
    let task = snapshot.tasks.first().expect("task snapshot");
    let envelope = task.envelope.as_ref().expect("envelope snapshot");

    assert_eq!(snapshot.router_messages[0].message_id, "m-1");
    assert_eq!(task.task_id, "task-1");
    assert_eq!(task.attempts[0].state, "active");
    assert_eq!(task.inputs[0].message_id, "m-2");
    assert_eq!(task.criteria[0].criterion_id, "criterion-1");
    assert_eq!(task.reports[0].attempt_id, "attempt-1");
    assert_eq!(task.reports[0].call_id, "call-1");
    assert_eq!(task.evidence[0].attempt_id, "attempt-1");
    assert_eq!(envelope.snapshot_id, "snap-1");
    assert_eq!(envelope.context[0].memory_id, "memory-1");
    assert_eq!(snapshot.children[0].parent_task_id, "task-1");
    assert_eq!(snapshot.children[0].depth, 1);
}

#[test]
fn runtime_id_seed_overflow_fails_closed() {
    let db = TestDb::open("runtime-id-overflow", 1);
    exec(
        db.file(),
        "INSERT INTO task_sessions
           (task_id, phase, title, pinned, completion_view, prior_task_id, created_at)
         VALUES
           ('task-18446744073709551615', 'queued', 'overflow', 'unpinned',
            'unopened', NULL, 1)",
    );

    assert!(matches!(
        db.owner().runtime_snapshot(),
        Err(StoreError::InvalidRequest { .. })
    ));
}

#[test]
fn closed_detail_high_water_survives_restart() {
    let mut db = TestDb::open("detail-high-water", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(db.owner().set_completion_view("task-1", "open:detail-40"));
    must(db.owner().set_completion_view("task-1", "closed_once"));
    db.reopen(3);

    assert_eq!(must(db.owner().runtime_snapshot()).id_seeds.detail, 41);
}

#[test]
fn fresh_open_is_schema_version_twelve() {
    assert_eq!(LATEST_SCHEMA_VERSION, 17);
    let db = TestDb::open("version", 1);
    let settings = must(db.owner().connection_settings());
    assert_eq!(settings.user_version, 17);
    let rows = must(db.owner().migrations());
    assert_eq!(rows.len(), 17);
    assert_eq!(rows.last().map(|row| row.version), Some(17));
    assert_eq!(
        rows.last().map(|row| row.name.as_str()),
        Some("purge_orphan_bot_tasks")
    );
}

#[test]
fn model_connection_round_trips_the_endpoint_and_has_no_secret_column() {
    let mut db = TestDb::open("model-connection", 1);
    assert!(must(db.owner().model_connection()).is_none());
    let rejected = db.owner().put_model_connection(ModelConnectionRecord {
        base_url: "https://example.test/v1".to_owned(),
        model_id: "example-chat".to_owned(),
        reasoning: "secret".to_owned(),
    });
    assert!(matches!(rejected, Err(StoreError::InvalidRequest { .. })));
    must(db.owner().put_model_connection(ModelConnectionRecord {
        base_url: " https://example.test/v1 ".to_owned(),
        model_id: " example-chat ".to_owned(),
        reasoning: " medium ".to_owned(),
    }));
    db.reopen(2);
    assert_eq!(
        must(db.owner().model_connection()),
        Some(ModelConnectionRecord {
            base_url: "https://example.test/v1".to_owned(),
            model_id: "example-chat".to_owned(),
            reasoning: "medium".to_owned(),
        })
    );
    let connection = Connection::open(db.file()).expect("open");
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info('model_connection') ORDER BY name")
        .expect("prepare");
    let columns: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("columns");
    assert_eq!(
        columns,
        vec!["base_url", "model_id", "reasoning", "singleton"]
    );
}

#[test]
fn prompt_bytes_round_trip_and_legacy_rows_remain() {
    let db = TestDb::open("legacy-prompt", 1);
    exec(
        db.file(),
        "INSERT INTO threads (thread_id, version, participants, created_at) \
         VALUES ('legacy-1', 1, '[]', 1)",
    );
    must(db.owner().mark_legacy_threads(2));
    let legacy = must(db.owner().legacy_thread_ids());
    assert_eq!(legacy, vec!["legacy-1".to_owned()]);
    must(db.owner().insert_task(sample_task("task-1", 3)));
    let bytes = b"Add a pin control".to_vec();
    must(
        db.owner()
            .insert_task_envelope(sample_envelope("task-1", &bytes)),
    );
    assert_eq!(must(db.owner().load_prompt("task-1")), bytes);
    assert_eq!(scalar_i64(db.file(), "SELECT COUNT(*) FROM threads"), 1);
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM thread_events"),
        0
    );
}

#[test]
fn duplicate_envelope_prompt_rejects_without_changing_bytes() {
    let db = TestDb::open("dup-prompt", 10);
    must(db.owner().insert_task(sample_task("task-1", 11)));
    let first = b"same".to_vec();
    must(
        db.owner()
            .insert_task_envelope(sample_envelope("task-1", &first)),
    );
    let second = b"different".to_vec();
    let error = db
        .owner()
        .insert_task_envelope(sample_envelope("task-1", &second))
        .unwrap_err();
    assert!(matches!(error, StoreError::IdempotencyConflict { .. }));
    assert_eq!(must(db.owner().load_prompt("task-1")), first);
}

#[test]
fn mark_legacy_threads_is_idempotent() {
    let db = TestDb::open("legacy-idempotent", 1);
    exec(
        db.file(),
        "INSERT INTO threads (thread_id, version, participants, created_at) \
         VALUES ('a', 1, '[]', 1);
         INSERT INTO threads (thread_id, version, participants, created_at) \
         VALUES ('b', 1, '[]', 1);",
    );
    must(db.owner().mark_legacy_threads(2));
    must(db.owner().mark_legacy_threads(3));
    assert_eq!(
        must(db.owner().legacy_thread_ids()),
        vec!["a".to_owned(), "b".to_owned()]
    );
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM legacy_threads"),
        2
    );
}

#[test]
fn router_messages_allocate_ordinals_in_order() {
    let db = TestDb::open("router", 1);
    must(db.owner().insert_router_message(RouterMessageWrite {
        message_id: "m1".to_owned(),
        role: "user".to_owned(),
        body: "hello".to_owned(),
        created_at: 2,
    }));
    must(db.owner().insert_router_message(RouterMessageWrite {
        message_id: "m2".to_owned(),
        role: "assistant".to_owned(),
        body: "hi".to_owned(),
        created_at: 3,
    }));
    let connection = ready(Connection::open(db.file()));
    let rows: Vec<(String, i64)> = ready(
        connection
            .prepare("SELECT message_id, ordinal FROM router_messages ORDER BY ordinal")
            .and_then(|mut statement| {
                let mapped =
                    statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?;
                mapped.collect()
            }),
    );
    assert_eq!(rows, vec![("m1".to_owned(), 1), ("m2".to_owned(), 2),]);
}

#[test]
fn submission_begin_is_atomic_replayable_and_conflicts_on_text() {
    let db = TestDb::open("submission-begin", 1);
    let write = MessageSubmissionWrite {
        operation_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        text: "Route once".to_owned(),
        message: RouterMessageWrite {
            message_id: "m-1".to_owned(),
            role: "user".to_owned(),
            body: "Route once".to_owned(),
            created_at: 2,
        },
    };

    assert_eq!(
        must(
            db.owner()
                .lookup_message_submission(&write.operation_id, &write.text,)
        ),
        MessageSubmissionState::Missing
    );
    assert_eq!(
        must(db.owner().begin_message_submission(write.clone())).value,
        MessageSubmissionState::New {
            message_id: "m-1".to_owned(),
        }
    );
    assert_eq!(
        must(db.owner().begin_message_submission(MessageSubmissionWrite {
            message: RouterMessageWrite {
                message_id: "m-unused".to_owned(),
                ..write.message.clone()
            },
            ..write.clone()
        }))
        .value,
        MessageSubmissionState::Pending {
            message_id: "m-1".to_owned(),
        }
    );
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM router_messages"),
        1
    );
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM message_submissions"),
        1
    );

    let conflict = db
        .owner()
        .lookup_message_submission(&write.operation_id, "Different text")
        .expect_err("same operation with different text");
    assert!(matches!(conflict, StoreError::IdempotencyConflict { .. }));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM router_messages"),
        1
    );
}

#[test]
fn submission_terminal_replays_after_reopen() {
    let mut db = TestDb::open("submission-terminal", 1);
    let operation_id = "22222222-2222-4222-8222-222222222222";
    let text = "Route once";
    must(db.owner().begin_message_submission(MessageSubmissionWrite {
        operation_id: operation_id.to_owned(),
        text: text.to_owned(),
        message: RouterMessageWrite {
            message_id: "m-2".to_owned(),
            role: "user".to_owned(),
            body: text.to_owned(),
            created_at: 2,
        },
    }));
    let terminal = StoredSubmissionOutcome::RoutingFailed {
        reason: "model_provider_unavailable".to_owned(),
    };
    must(
        db.owner()
            .finish_message_submission(operation_id, terminal.clone()),
    );
    db.reopen(9);

    assert_eq!(
        must(db.owner().lookup_message_submission(operation_id, text)),
        MessageSubmissionState::Terminal {
            message_id: "m-2".to_owned(),
            outcome: terminal,
        }
    );
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM router_messages"),
        1
    );
}

#[test]
fn future_and_malformed_terminal_rows_decode_to_opaque_unknown() {
    let db = TestDb::open("submission-opaque", 1);
    let cases = [
        ("future_kind", "future-secret-route"),
        ("routed", ""),
        ("routed", "future-route"),
        ("routing_failed", "future-reason"),
        ("processing_failed", "secret-detail"),
    ];
    for (index, (kind, detail)) in cases.into_iter().enumerate() {
        let operation_id = format!("operation-{index}");
        let message_id = format!("m-{index}");
        let text = format!("text-{index}");
        must(db.owner().begin_message_submission(MessageSubmissionWrite {
            operation_id: operation_id.clone(),
            text: text.clone(),
            message: RouterMessageWrite {
                message_id: message_id.clone(),
                role: "user".to_owned(),
                body: text.clone(),
                created_at: 2,
            },
        }));
        let detail_sql = if detail.is_empty() {
            "NULL".to_owned()
        } else {
            format!("'{}'", detail.replace('\'', "''"))
        };
        exec(
            db.file(),
            &format!(
                "UPDATE message_submissions SET state = 'terminal', \
                 outcome_kind = '{}', outcome_detail = {detail_sql} \
                 WHERE operation_id = '{operation_id}'",
                kind.replace('\'', "''"),
            ),
        );

        assert_eq!(
            must(db.owner().lookup_message_submission(&operation_id, &text)),
            MessageSubmissionState::Terminal {
                message_id,
                outcome: StoredSubmissionOutcome::Unknown,
            }
        );
    }
}

#[test]
fn blob_and_non_text_terminal_fields_decode_unknown() {
    let db = TestDb::open("submission-raw-opaque", 1);
    let cases = [
        ("X'726F75746564'", "'admit'"),
        ("'routed'", "X'61646D6974'"),
        ("7", "1.5"),
        ("CAST(X'80' AS TEXT)", "NULL"),
    ];
    for (index, (kind_sql, detail_sql)) in cases.into_iter().enumerate() {
        let operation_id = format!("raw-operation-{index}");
        let message_id = format!("raw-message-{index}");
        let text = format!("raw-text-{index}");
        must(db.owner().begin_message_submission(MessageSubmissionWrite {
            operation_id: operation_id.clone(),
            text: text.clone(),
            message: RouterMessageWrite {
                message_id: message_id.clone(),
                role: "user".to_owned(),
                body: text.clone(),
                created_at: 3,
            },
        }));
        exec(
            db.file(),
            &format!(
                "UPDATE message_submissions SET state = 'terminal', \
                 outcome_kind = {kind_sql}, outcome_detail = {detail_sql} \
                 WHERE operation_id = '{operation_id}'"
            ),
        );

        assert_eq!(
            must(db.owner().lookup_message_submission(&operation_id, &text)),
            MessageSubmissionState::Terminal {
                message_id,
                outcome: StoredSubmissionOutcome::Unknown,
            }
        );
    }
}

#[test]
fn non_outcome_submission_corruption_still_fails_closed() {
    let db = TestDb::open("submission-identity-corrupt", 1);
    let operation_id = "identity-corrupt";
    must(db.owner().begin_message_submission(MessageSubmissionWrite {
        operation_id: operation_id.to_owned(),
        text: "owner text".to_owned(),
        message: RouterMessageWrite {
            message_id: "identity-message".to_owned(),
            role: "user".to_owned(),
            body: "owner text".to_owned(),
            created_at: 3,
        },
    }));
    exec(
        db.file(),
        "UPDATE message_submissions SET text = X'80' \
         WHERE operation_id = 'identity-corrupt'",
    );

    let error = db
        .owner()
        .lookup_message_submission(operation_id, "owner text")
        .expect_err("identity corruption must not become opaque terminal");

    assert!(matches!(error, StoreError::Sqlite { .. }));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM router_messages"),
        1
    );
}

#[test]
fn task_aggregate_failpoints_roll_back_every_constituent_write() {
    for table in [
        "task_sessions",
        "task_attempts",
        "task_envelopes",
        "context_snapshots",
        "task_criteria",
    ] {
        let db = TestDb::open(&format!("aggregate-fail-{table}"), 1);
        must(db.owner().insert_router_message(RouterMessageWrite {
            message_id: "m-1".to_owned(),
            role: "user".to_owned(),
            body: "goal".to_owned(),
            created_at: 1,
        }));
        exec(
            db.file(),
            &format!(
                "CREATE TRIGGER fail_{table} BEFORE INSERT ON {table} \
                 BEGIN SELECT RAISE(ABORT, 'aggregate failpoint'); END;"
            ),
        );

        let error = db
            .owner()
            .insert_task_aggregate(sample_task_aggregate("task-1"))
            .expect_err("constituent write must fail");

        assert!(matches!(error, StoreError::Constraint { .. }), "{table}");
        for aggregate_table in [
            "task_sessions",
            "task_attempts",
            "task_envelopes",
            "context_snapshots",
            "task_criteria",
        ] {
            assert_eq!(
                scalar_i64(
                    db.file(),
                    &format!("SELECT COUNT(*) FROM {aggregate_table}")
                ),
                0,
                "{table} failpoint left rows in {aggregate_table}"
            );
        }
    }
}

#[test]
fn task_input_and_report_round_trip() {
    let db = TestDb::open("input-report", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(
        db.owner()
            .insert_task_envelope(sample_envelope("task-1", b"goal")),
    );
    must(db.owner().insert_task_input(TaskInputWrite {
        task_id: "task-1".to_owned(),
        message_id: "msg-2".to_owned(),
        prompt: b"more".to_vec(),
    }));
    must(db.owner().insert_report(TaskReportWrite {
        report_id: "rep-1".to_owned(),
        task_id: "task-1".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        kind: "question".to_owned(),
        summary: "Need detail".to_owned(),
        created_at: 4,
        call_id: String::new(),
    }));
    let inspection = must(db.owner().task_inspection("task-1"));
    assert_eq!(inspection.prompt, b"goal".to_vec());
    assert_eq!(inspection.input_message_ids, vec!["msg-2".to_owned()]);
    assert_eq!(inspection.report_summaries, vec!["Need detail".to_owned()]);
    assert!(inspection.child_ids.is_empty());
}

#[test]
fn child_pin_and_completion_view_persist() {
    let db = TestDb::open("pin-view", 1);
    must(db.owner().insert_task(sample_task("parent", 2)));
    must(
        db.owner()
            .insert_task_envelope(sample_envelope("parent", b"x")),
    );
    must(db.owner().insert_child(ChildAssignmentWrite {
        child_id: "child-1".to_owned(),
        parent_task_id: "parent".to_owned(),
        depth: 1,
        subgoal: b"slice".to_vec(),
        budget_tokens: 100,
        budget_turns: 2,
    }));
    must(db.owner().set_pin("parent", "pinned"));
    must(db.owner().set_completion_view("parent", "open:detail-1"));
    let inspection = must(db.owner().task_inspection("parent"));
    assert_eq!(inspection.child_ids, vec!["child-1".to_owned()]);
    assert_eq!(inspection.pin, "pinned");
    assert_eq!(inspection.completion_view, "open:detail-1");
}

#[test]
fn child_owning_commit_records_numeric_high_water() {
    let db = TestDb::open("child-high-water", 1);
    must(db.owner().insert_task(sample_task("parent", 2)));
    must(db.owner().insert_child(ChildAssignmentWrite {
        child_id: "child-50".to_owned(),
        parent_task_id: "parent".to_owned(),
        depth: 1,
        subgoal: b"slice".to_vec(),
        budget_tokens: 1,
        budget_turns: 1,
    }));

    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT value FROM runtime_id_high_water WHERE namespace = 'child'"
        ),
        "50"
    );
    assert_eq!(
        must(db.owner().reserve_runtime_id_block(1)).first(RuntimeIdNamespace::Child),
        51
    );
}

#[test]
fn foreign_key_violation_on_child_parent_rolls_back() {
    let db = TestDb::open("fk-child", 1);
    let error = db
        .owner()
        .insert_child(ChildAssignmentWrite {
            child_id: "child-1".to_owned(),
            parent_task_id: "missing".to_owned(),
            depth: 1,
            subgoal: b"x".to_vec(),
            budget_tokens: 1,
            budget_turns: 1,
        })
        .unwrap_err();
    assert!(matches!(error, StoreError::Constraint { .. }));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM child_assignments"),
        0
    );
}

#[test]
fn oversized_prompt_is_rejected_before_write() {
    let db = TestDb::open("limit-prompt", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    let huge = vec![b'a'; MAX_THREAD_EVENT_BODY_BYTES + 1];
    let error = db
        .owner()
        .insert_task_envelope(sample_envelope("task-1", &huge))
        .unwrap_err();
    assert!(matches!(error, StoreError::ResourceLimit(_)));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM task_envelopes"),
        0
    );
}

#[test]
fn oversized_router_body_is_rejected() {
    let db = TestDb::open("limit-router", 1);
    let huge = "x".repeat(MAX_PROSE_BYTES + 1);
    let error = db
        .owner()
        .insert_router_message(RouterMessageWrite {
            message_id: "m1".to_owned(),
            role: "user".to_owned(),
            body: huge,
            created_at: 1,
        })
        .unwrap_err();
    assert!(matches!(error, StoreError::ResourceLimit(_)));
}

#[test]
fn task_inspection_is_read_only() {
    let db = TestDb::open("inspect-readonly", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(
        db.owner()
            .insert_task_envelope(sample_envelope("task-1", b"p")),
    );
    let envelopes_before = scalar_i64(db.file(), "SELECT COUNT(*) FROM task_envelopes");
    let _ = must(db.owner().task_inspection("task-1"));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM task_envelopes"),
        envelopes_before
    );
}

#[test]
fn phase_survives_reopen_without_touching_other_columns() {
    let mut db = TestDb::open("phase-reopen", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(db.owner().update_task_phase("task-1", "running:attempt-1"));
    must(
        db.owner()
            .update_task_phase("task-1", "waiting:unknown:attempt-1:call-1"),
    );
    assert_ne!(must(db.owner().load_task_phase("task-1")), "waiting");
    db.reopen(9);
    assert_eq!(
        must(db.owner().load_task_phase("task-1")),
        "waiting:unknown:attempt-1:call-1"
    );
    assert_eq!(
        scalar_text(db.file(), "SELECT title FROM task_sessions"),
        "Pin control"
    );
    assert_eq!(
        scalar_text(db.file(), "SELECT pinned FROM task_sessions"),
        "unpinned"
    );
    let missing = db.owner().update_task_phase("missing", "running:attempt-1");
    assert!(matches!(
        missing,
        Err(StoreError::NotFound {
            entity: "task_session",
            ..
        })
    ));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM task_sessions"),
        1
    );
    let huge = "p".repeat(MAX_PROSE_BYTES + 1);
    let oversized = db.owner().update_task_phase("task-1", &huge);
    assert!(matches!(oversized, Err(StoreError::ResourceLimit(_))));
    assert_eq!(
        must(db.owner().load_task_phase("task-1")),
        "waiting:unknown:attempt-1:call-1"
    );
}

#[test]
fn evidence_row_is_immutable_and_survives_reopen() {
    let mut db = TestDb::open("evidence-reopen", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(
        db.owner()
            .update_task_phase("task-1", "completed:criterion-1%3Aevidence-1"),
    );
    let write = TaskEvidenceWrite {
        evidence_id: "evidence-1".to_owned(),
        task_id: "task-1".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        body: "pin control is present".to_owned(),
    };
    must(db.owner().insert_task_evidence(write.clone()));
    must(db.owner().insert_task_evidence(write.clone()));
    let changed = write.clone();
    let conflict = db.owner().insert_task_evidence(TaskEvidenceWrite {
        body: "rewritten".to_owned(),
        ..changed
    });
    assert!(matches!(
        conflict,
        Err(StoreError::IdempotencyConflict { .. })
    ));
    db.reopen(9);
    let loaded = must(db.owner().load_task_evidence("evidence-1"));
    assert_eq!(loaded.evidence_id, "evidence-1");
    assert_eq!(loaded.task_id, "task-1");
    assert_eq!(loaded.attempt_id, "attempt-1");
    assert_eq!(loaded.body, "pin control is present");
    assert_eq!(
        must(db.owner().load_task_phase("task-1")),
        "completed:criterion-1%3Aevidence-1"
    );
    let rendered = format!("{:?}", loaded);
    assert!(!rendered.contains("pin control is present"));
}

#[test]
fn stopped_phase_is_durable_keeps_its_command_and_rejects_a_zero_command() {
    let mut db = TestDb::open("stopped-phase-durable", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(db.owner().update_task_phase("task-1", "stopped:7"));
    db.reopen(9);
    assert_eq!(must(db.owner().load_task_phase("task-1")), "stopped:7");

    assert!(matches!(
        db.owner().update_task_phase("task-1", "stopped:0"),
        Err(StoreError::InvalidRequest { .. })
    ));
    assert_eq!(must(db.owner().load_task_phase("task-1")), "stopped:7");
}

#[test]
fn evidence_failure_rolls_back_and_does_not_mutate() {
    let db = TestDb::open("evidence-rollback", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(db.owner().update_task_phase("task-1", "running:attempt-1"));
    let missing_task = db.owner().insert_task_evidence(TaskEvidenceWrite {
        evidence_id: "evidence-x".to_owned(),
        task_id: "missing".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        body: "no task".to_owned(),
    });
    assert!(matches!(
        missing_task,
        Err(StoreError::NotFound {
            entity: "task_session",
            ..
        })
    ));
    let missing_attempt = db.owner().insert_task_evidence(TaskEvidenceWrite {
        evidence_id: "evidence-y".to_owned(),
        task_id: "task-1".to_owned(),
        attempt_id: "attempt-missing".to_owned(),
        body: "no attempt".to_owned(),
    });
    assert!(matches!(
        missing_attempt,
        Err(StoreError::NotFound {
            entity: "task_attempt",
            ..
        })
    ));
    let oversized = db.owner().insert_task_evidence(TaskEvidenceWrite {
        evidence_id: "evidence-z".to_owned(),
        task_id: "task-1".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        body: "b".repeat(MAX_PROSE_BYTES + 1),
    });
    assert!(matches!(oversized, Err(StoreError::ResourceLimit(_))));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM task_evidence"),
        0
    );
    assert_eq!(
        must(db.owner().load_task_phase("task-1")),
        "running:attempt-1"
    );
    assert_eq!(
        scalar_text(db.file(), "SELECT title FROM task_sessions"),
        "Pin control"
    );
}

#[test]
fn load_prompt_missing_task_returns_not_found() {
    let db = TestDb::open("missing-prompt", 1);
    let error = db.owner().load_prompt("nope").unwrap_err();
    assert!(matches!(error, StoreError::NotFound { .. }));
}

#[test]
fn legacy_mark_rejects_unknown_thread_via_fk() {
    let db = TestDb::open("legacy-fk", 1);
    let connection = ready(Connection::open(db.file()));
    let first = connection.execute(
        "INSERT INTO legacy_threads (thread_id, marked_at) VALUES ('ghost', 1)",
        [],
    );
    assert!(first.is_err());
    let second = connection.execute(
        "INSERT INTO legacy_threads (thread_id, marked_at) VALUES ('ghost2', 1)",
        [],
    );
    assert!(second.is_err());
}

#[test]
fn second_attempt_is_idempotent_and_rolls_back_when_missing() {
    let mut db = TestDb::open("attempt-row", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    let write = TaskAttemptWrite {
        task_id: "task-1".to_owned(),
        attempt_id: "attempt-2".to_owned(),
        state: "active".to_owned(),
    };
    must(db.owner().insert_task_attempt(write.clone()));
    must(db.owner().insert_task_attempt(write.clone()));
    let conflict = db.owner().insert_task_attempt(TaskAttemptWrite {
        state: "other".to_owned(),
        ..write
    });
    assert!(matches!(conflict, Err(StoreError::InvalidRequest { .. })));
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT state FROM task_attempts WHERE attempt_id = 'attempt-2'"
        ),
        "active"
    );
    let missing = db.owner().insert_task_attempt(TaskAttemptWrite {
        task_id: "missing".to_owned(),
        attempt_id: "attempt-9".to_owned(),
        state: "active".to_owned(),
    });
    assert!(matches!(
        missing,
        Err(StoreError::NotFound {
            entity: "task_session",
            ..
        })
    ));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM task_attempts"),
        2
    );
    let huge = "s".repeat(MAX_PROSE_BYTES + 1);
    let oversized = db.owner().insert_task_attempt(TaskAttemptWrite {
        task_id: "task-1".to_owned(),
        attempt_id: "attempt-3".to_owned(),
        state: huge,
    });
    assert!(matches!(oversized, Err(StoreError::ResourceLimit(_))));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM task_attempts"),
        2
    );
    db.reopen(9);
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT attempt_id FROM task_attempts WHERE attempt_id = 'attempt-2'"
        ),
        "attempt-2"
    );
}

#[test]
fn grandchild_phase_survives_reopen_and_missing_parent_rolls_back() {
    let mut db = TestDb::open("child-phase", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(db.owner().insert_child(ChildAssignmentWrite {
        child_id: "child-a".to_owned(),
        parent_task_id: "task-1".to_owned(),
        depth: 1,
        subgoal: b"child".to_vec(),
        budget_tokens: 4,
        budget_turns: 1,
    }));
    must(db.owner().insert_child(ChildAssignmentWrite {
        child_id: "grand-a".to_owned(),
        parent_task_id: "child-a".to_owned(),
        depth: 2,
        subgoal: b"grand".to_vec(),
        budget_tokens: 2,
        budget_turns: 1,
    }));
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase FROM child_assignments WHERE child_id = 'child-a'"
        ),
        "queued"
    );
    must(db.owner().update_child_phase("grand-a", "cancelled:4"));
    must(db.owner().update_child_phase("grand-a", "cancelled:4"));
    let missing = db
        .owner()
        .update_child_phase("missing-child", "cancelled:4");
    assert!(matches!(
        missing,
        Err(StoreError::NotFound {
            entity: "child_assignment",
            ..
        })
    ));
    assert_eq!(
        scalar_i64(db.file(), "SELECT COUNT(*) FROM child_assignments"),
        2
    );
    let huge = "p".repeat(MAX_PROSE_BYTES + 1);
    let oversized = db.owner().update_child_phase("grand-a", &huge);
    assert!(matches!(oversized, Err(StoreError::ResourceLimit(_))));
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase FROM child_assignments WHERE child_id = 'grand-a'"
        ),
        "cancelled:4"
    );
    db.reopen(9);
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase FROM child_assignments WHERE child_id = 'grand-a'"
        ),
        "cancelled:4"
    );
}

#[test]
fn child_phase_batch_rolls_back_when_any_id_is_missing() {
    let db = TestDb::open("child-batch", 1);
    must(db.owner().insert_task(sample_task("task-1", 2)));
    must(db.owner().insert_child(ChildAssignmentWrite {
        child_id: "child-a".to_owned(),
        parent_task_id: "task-1".to_owned(),
        depth: 1,
        subgoal: b"a".to_vec(),
        budget_tokens: 1,
        budget_turns: 1,
    }));
    must(db.owner().insert_child(ChildAssignmentWrite {
        child_id: "child-b".to_owned(),
        parent_task_id: "task-1".to_owned(),
        depth: 1,
        subgoal: b"b".to_vec(),
        budget_tokens: 1,
        budget_turns: 1,
    }));
    let missing = db.owner().update_child_phases(
        &[
            "child-a".to_owned(),
            "missing".to_owned(),
            "child-b".to_owned(),
        ],
        "cancelled:41",
    );
    assert!(matches!(
        missing,
        Err(StoreError::NotFound {
            entity: "child_assignment",
            ..
        })
    ));
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase FROM child_assignments ORDER BY child_id"
        ),
        "queued"
    );
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase FROM child_assignments WHERE child_id = 'child-b'"
        ),
        "queued"
    );
    must(db.owner().update_child_phases(&[], "cancelled:41"));
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase FROM child_assignments WHERE child_id = 'child-a'"
        ),
        "queued"
    );
    must(db.owner().update_child_phases(
        &["child-b".to_owned(), "child-a".to_owned()],
        "cancelled:41",
    ));
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase FROM child_assignments WHERE child_id = 'child-a'"
        ),
        "cancelled:41"
    );
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase FROM child_assignments WHERE child_id = 'child-b'"
        ),
        "cancelled:41"
    );
    let empty_id = db
        .owner()
        .update_child_phases(&["child-a".to_owned(), String::new()], "cancelled:7");
    assert!(matches!(empty_id, Err(StoreError::InvalidRequest { .. })));
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT phase FROM child_assignments WHERE child_id = 'child-a'"
        ),
        "cancelled:41"
    );
}

#[test]
fn prompt_debug_does_not_leak_bytes() {
    let rendered = format!("{:?}", sample_envelope("task-1", b"secret-bytes"));
    assert!(!rendered.contains("secret-bytes"));
}

fn transcript_bodies(db: &TestDb, bot_id: &str) -> Vec<String> {
    match must(db.owner().bots(BotRequest::Transcript {
        bot_id: bot_id.to_owned(),
    })) {
        BotResponse::Transcript(rows) => rows.into_iter().map(|row| row.body).collect(),
        other => panic!("transcript {other:?}"),
    }
}

#[test]
fn listed_preview_is_the_turn_sentence_and_a_running_task_sets_status() {
    let mut db = TestDb::open("bot-row", 10);
    must(db.owner().insert_task(sample_task("task-chat", 12)));
    let path = db.file().clone();
    db.close();
    let connection = ready(Connection::open(&path));
    let body = "\u{1}maia-turn\u{1}{\"route\":\"inspect_task\",\"text\":\"The chat is stuck on the investigation.\"}";
    ready(connection.execute("UPDATE bots SET preview = ?1 WHERE bot_id = 'maia'", [body]));
    drop(connection);
    db.reopen(13);
    match must(db.owner().bots(BotRequest::List)) {
        BotResponse::List(bots) => {
            assert_eq!(bots[0].preview, "The chat is stuck on the investigation.");
            assert!(bots[0].running);
            assert_eq!(bots[0].status_line, "Working on Pin control");
        }
        other => panic!("list {other:?}"),
    }
}

#[test]
fn bots_keep_separate_histories_and_share_one_brain() {
    let db = TestDb::open("bots", 10);
    match must(db.owner().bots(BotRequest::List)) {
        BotResponse::List(bots) => {
            assert_eq!(bots[0].bot_id, "maia");
            assert_eq!(bots[0].name, "Maia");
            assert!(bots[0].pinned);
        }
        other => panic!("list {other:?}"),
    }
    must(db.owner().insert_router_message(RouterMessageWrite {
        message_id: "m-maia".to_owned(),
        role: "user".to_owned(),
        body: "hello from maia".to_owned(),
        created_at: 11,
    }));
    let coding = match must(db.owner().bots(BotRequest::Create {
        name: "Coding".to_owned(),
        instructions: "This one is for Maia development".to_owned(),
        now: 12,
    })) {
        BotResponse::Bot(bot) => bot,
        other => panic!("create {other:?}"),
    };
    must(db.owner().insert_router_message(RouterMessageWrite {
        message_id: "m-code".to_owned(),
        role: "user".to_owned(),
        body: "hello from coding".to_owned(),
        created_at: 13,
    }));
    must(db.owner().bots(BotRequest::BindMessage {
        message_id: "m-code".to_owned(),
        bot_id: coding.bot_id.clone(),
        preview: "hello from coding".to_owned(),
        now: 13,
        from_owner: true,
    }));

    let maia_lines = transcript_bodies(&db, "maia");
    let coding_lines = transcript_bodies(&db, &coding.bot_id);
    assert_eq!(maia_lines, vec!["hello from maia".to_owned()]);
    assert_eq!(coding_lines, vec!["hello from coding".to_owned()]);

    must(db.owner().bots(BotRequest::UpsertWork {
        bot_id: coding.bot_id.clone(),
        goal: "dog-house list".to_owned(),
        todos_json: "[]".to_owned(),
        activity: "Working on dog-house list".to_owned(),
        now: 14,
    }));
    let notes = match must(db.owner().bots(BotRequest::WorkNotes)) {
        BotResponse::Notes(notes) => notes,
        other => panic!("notes {other:?}"),
    };
    let lines = maia_core::bots::also_happening(
        "what is the coding agent working on?",
        "maia",
        &notes
            .iter()
            .map(|note| maia_core::bots::WorkNote {
                bot_id: note.bot_id.clone(),
                name: note.name.clone(),
                goal: note.goal.clone(),
                activity: note.activity.clone(),
            })
            .collect::<Vec<_>>(),
    );
    assert_eq!(
        lines,
        vec!["Also happening: Coding — Working on dog-house list.".to_owned()]
    );

    must(db.owner().append(AppendEvents {
        thread_id: "thread-bots".to_owned(),
        expected_version: 0,
        participants: "owner".to_owned(),
        occurred_at: 15,
        events: vec![ThreadEventWrite {
            event_id: "event-bots".to_owned(),
            kind: "user".to_owned(),
            body: "learned a place".to_owned(),
        }],
    }));
    must(db.owner().insert_episode(EpisodeWrite {
        episode_id: "episode-canby".to_owned(),
        thread_id: "thread-bots".to_owned(),
        turn_id: "m-code".to_owned(),
        body: "Garrett lives in Canby.".to_owned(),
        taint: MemoryTaint::Trusted,
        reasoning: None,
        participants: "owner".to_owned(),
        created_at: 16,
        segments: vec![SegmentWrite {
            text: "Garrett lives in Canby.".to_owned(),
            taint: MemoryTaint::Trusted,
            sources: format!("bot:{}", coding.bot_id),
        }],
    }));
    must(db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-canby".to_owned(),
        model: "model-a".to_owned(),
        now: 17,
        claims: vec![PromotionClaimWrite {
            claim_id: "claim-canby".to_owned(),
            sentence: "Garrett lives in Canby.".to_owned(),
            taint: MemoryTaint::Trusted,
            valid_from: 16,
            lexemes: vec!["garrett".to_owned(), "canby".to_owned()],
        }],
        same_claim_ids: Vec::new(),
        replacements: Vec::new(),
        links: Vec::new(),
    }));
    must(db.owner().bots(BotRequest::NoteProvenance {
        target_kind: "claim".to_owned(),
        target_id: "claim-canby".to_owned(),
        bot_id: coding.bot_id.clone(),
        session_id: "m-code".to_owned(),
        noted_at: 17,
    }));
    assert_eq!(
        must(db.owner().search(TextSearch::Claim, "Canby")),
        vec!["claim-canby".to_owned()]
    );
    match must(db.owner().bots(BotRequest::Provenance {
        target_kind: "claim".to_owned(),
        target_id: "claim-canby".to_owned(),
    })) {
        BotResponse::Provenance(Some(row)) => {
            assert_eq!(row.bot_id, coding.bot_id);
            assert_eq!(row.session_id, "m-code");
        }
        other => panic!("provenance {other:?}"),
    }
}

#[test]
fn deleting_the_last_bot_is_refused_and_archive_hides_nothing_from_memory() {
    let db = TestDb::open("bots-delete", 20);
    assert!(matches!(
        db.owner().bots(BotRequest::Delete {
            bot_id: "maia".to_owned(),
        }),
        Err(StoreError::InvalidRequest { .. })
    ));
    let coding = match must(db.owner().bots(BotRequest::Create {
        name: "Coding".to_owned(),
        instructions: String::new(),
        now: 21,
    })) {
        BotResponse::Bot(bot) => bot,
        other => panic!("create {other:?}"),
    };
    let archived = match must(db.owner().bots(BotRequest::Archive {
        bot_id: coding.bot_id.clone(),
        archived: true,
        now: 22,
    })) {
        BotResponse::Bot(bot) => bot,
        other => panic!("archive {other:?}"),
    };
    assert!(archived.archived);
    assert!(!archived.pinned);
}

#[test]
fn deleting_a_bot_removes_its_chat_and_leaves_the_other() {
    let db = TestDb::open("bots-delete-chat", 30);
    must(db.owner().insert_router_message(RouterMessageWrite {
        message_id: "m-maia".to_owned(),
        role: "user".to_owned(),
        body: "keep maia".to_owned(),
        created_at: 31,
    }));
    let coding = match must(db.owner().bots(BotRequest::Create {
        name: "Coding".to_owned(),
        instructions: String::new(),
        now: 32,
    })) {
        BotResponse::Bot(bot) => bot,
        other => panic!("create {other:?}"),
    };
    must(db.owner().begin_message_submission(MessageSubmissionWrite {
        operation_id: "op-code".to_owned(),
        text: "temp chat".to_owned(),
        message: RouterMessageWrite {
            message_id: "m-code".to_owned(),
            role: "user".to_owned(),
            body: "temp chat".to_owned(),
            created_at: 33,
        },
    }));
    must(db.owner().bots(BotRequest::BindMessage {
        message_id: "m-code".to_owned(),
        bot_id: coding.bot_id.clone(),
        preview: "temp chat".to_owned(),
        now: 33,
        from_owner: true,
    }));
    must(db.owner().append(AppendEvents {
        thread_id: "thread-delete-bot".to_owned(),
        expected_version: 0,
        participants: "owner".to_owned(),
        occurred_at: 34,
        events: vec![ThreadEventWrite {
            event_id: "event-delete-bot".to_owned(),
            kind: "user".to_owned(),
            body: "temp".to_owned(),
        }],
    }));
    must(db.owner().insert_episode(EpisodeWrite {
        episode_id: "episode-m-code".to_owned(),
        thread_id: "thread-delete-bot".to_owned(),
        turn_id: "m-code".to_owned(),
        body: "Owner: temp chat".to_owned(),
        taint: MemoryTaint::Trusted,
        reasoning: None,
        participants: "owner".to_owned(),
        created_at: 35,
        segments: vec![SegmentWrite {
            text: "temp chat".to_owned(),
            taint: MemoryTaint::Trusted,
            sources: "owner".to_owned(),
        }],
    }));
    must(db.owner().insert_episode(EpisodeWrite {
        episode_id: "episode-m-maia".to_owned(),
        thread_id: "thread-delete-bot".to_owned(),
        turn_id: "m-maia".to_owned(),
        body: "Owner: keep maia".to_owned(),
        taint: MemoryTaint::Trusted,
        reasoning: None,
        participants: "owner".to_owned(),
        created_at: 36,
        segments: vec![SegmentWrite {
            text: "keep maia".to_owned(),
            taint: MemoryTaint::Trusted,
            sources: "owner".to_owned(),
        }],
    }));
    must(db.owner().bots(BotRequest::Select {
        bot_id: coding.bot_id.clone(),
    }));

    must(db.owner().bots(BotRequest::Delete {
        bot_id: coding.bot_id.clone(),
    }));

    assert_eq!(transcript_bodies(&db, "maia"), vec!["keep maia".to_owned()]);
    match must(db.owner().bots(BotRequest::List)) {
        BotResponse::List(bots) => {
            assert_eq!(bots.len(), 1);
            assert_eq!(bots[0].bot_id, "maia");
        }
        other => panic!("list {other:?}"),
    }
    match must(db.owner().bots(BotRequest::Selected)) {
        BotResponse::Text(bot_id) => assert_eq!(bot_id, "maia"),
        other => panic!("selected {other:?}"),
    }
    let pending = must(db.owner().pending_promotions());
    let pending_ids = pending
        .iter()
        .map(|row| row.episode_id.as_str())
        .collect::<Vec<_>>();
    assert!(pending_ids.contains(&"episode-m-maia"));
    assert!(!pending_ids.contains(&"episode-m-code"));
}

#[test]
fn deleting_a_bot_removes_its_tasks_instead_of_handing_them_to_maia() {
    let db = TestDb::open("bots-delete-tasks", 40);
    let coding = match must(db.owner().bots(BotRequest::Create {
        name: "Coding".to_owned(),
        instructions: String::new(),
        now: 41,
    })) {
        BotResponse::Bot(bot) => bot,
        other => panic!("create {other:?}"),
    };
    must(db.owner().insert_task(TaskWrite {
        task_id: "task-pong".to_owned(),
        phase: "running:attempt-1".to_owned(),
        title: "Reply with exactly the word pong.".to_owned(),
        pin: "unpinned".to_owned(),
        completion_view: "unopened".to_owned(),
        prior_task_id: None,
        created_at: 42,
        attempt_id: "attempt-1".to_owned(),
        attempt_state: "active".to_owned(),
    }));
    must(db.owner().bots(BotRequest::BindTask {
        task_id: "task-pong".to_owned(),
        bot_id: coding.bot_id.clone(),
    }));
    must(db.owner().insert_task(TaskWrite {
        task_id: "task-maia".to_owned(),
        phase: "queued".to_owned(),
        title: "Keep Maia work".to_owned(),
        pin: "unpinned".to_owned(),
        completion_view: "unopened".to_owned(),
        prior_task_id: None,
        created_at: 43,
        attempt_id: "attempt-2".to_owned(),
        attempt_state: "active".to_owned(),
    }));
    must(db.owner().bots(BotRequest::BindTask {
        task_id: "task-maia".to_owned(),
        bot_id: "maia".to_owned(),
    }));

    must(db.owner().bots(BotRequest::Delete {
        bot_id: coding.bot_id.clone(),
    }));

    assert_eq!(
        scalar_i64(
            db.file(),
            "SELECT COUNT(*) FROM task_sessions WHERE task_id = 'task-pong'"
        ),
        0
    );
    assert_eq!(
        scalar_i64(
            db.file(),
            "SELECT COUNT(*) FROM task_bots WHERE task_id = 'task-pong'"
        ),
        0
    );
    match must(db.owner().bots(BotRequest::List)) {
        BotResponse::List(bots) => {
            assert_eq!(bots.len(), 1);
            assert_eq!(bots[0].bot_id, "maia");
            assert!(bots[0].running);
            assert!(bots[0].status_line.contains("Keep Maia work"));
        }
        other => panic!("list {other:?}"),
    }
    let maia_phase = scalar_text(
        db.file(),
        "SELECT phase FROM task_sessions WHERE task_id = 'task-maia'",
    );
    assert_eq!(maia_phase, "queued");
}

#[test]
fn deleting_a_bot_archives_finished_tasks_and_purges_running_ones() {
    let mut db = TestDb::open("bots-delete-archive-finished", 50);
    let coding = match must(db.owner().bots(BotRequest::Create {
        name: "Coding".to_owned(),
        instructions: String::new(),
        now: 51,
    })) {
        BotResponse::Bot(bot) => bot,
        other => panic!("create {other:?}"),
    };
    must(db.owner().insert_router_message(RouterMessageWrite {
        message_id: "m-1".to_owned(),
        role: "user".to_owned(),
        body: "goal".to_owned(),
        created_at: 52,
    }));
    must(db.owner().bots(BotRequest::BindMessage {
        message_id: "m-1".to_owned(),
        bot_id: coding.bot_id.clone(),
        preview: "goal".to_owned(),
        now: 52,
        from_owner: true,
    }));
    let mut finished = sample_task_aggregate("task-done");
    finished.task.phase = "completed:evidence-1".to_owned();
    finished.task.title = "Ship the archive".to_owned();
    finished.task.completion_view = "closed_once".to_owned();
    finished.task.created_at = 53;
    must(db.owner().insert_task_aggregate(finished));
    must(db.owner().bots(BotRequest::BindTask {
        task_id: "task-done".to_owned(),
        bot_id: coding.bot_id.clone(),
    }));
    must(db.owner().insert_task(TaskWrite {
        task_id: "task-live".to_owned(),
        phase: "running:attempt-1".to_owned(),
        title: "Still working".to_owned(),
        pin: "unpinned".to_owned(),
        completion_view: "unopened".to_owned(),
        prior_task_id: None,
        created_at: 54,
        attempt_id: "attempt-1".to_owned(),
        attempt_state: "active".to_owned(),
    }));
    must(db.owner().bots(BotRequest::BindTask {
        task_id: "task-live".to_owned(),
        bot_id: coding.bot_id.clone(),
    }));

    must(db.owner().bots(BotRequest::Delete {
        bot_id: coding.bot_id.clone(),
    }));

    assert_eq!(
        scalar_i64(
            db.file(),
            "SELECT COUNT(*) FROM task_sessions WHERE task_id = 'task-live'"
        ),
        0
    );
    assert_eq!(
        scalar_i64(
            db.file(),
            "SELECT COUNT(*) FROM task_sessions WHERE task_id = 'task-done'"
        ),
        1
    );
    assert_eq!(
        scalar_i64(
            db.file(),
            "SELECT COUNT(*) FROM task_bots WHERE task_id = 'task-done'"
        ),
        0
    );
    let archived_title = scalar_text(
        db.file(),
        "SELECT title FROM task_sessions WHERE task_id = 'task-done'",
    );
    assert!(
        archived_title.contains("Coding"),
        "archived title should keep the bot name: {archived_title}"
    );
    assert!(
        archived_title.contains("Ship the archive"),
        "archived title should keep the original title: {archived_title}"
    );
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT completion_view FROM task_sessions WHERE task_id = 'task-done'"
        ),
        "closed_once"
    );
    assert_eq!(
        scalar_text(
            db.file(),
            "SELECT source_kind FROM task_criteria WHERE task_id = 'task-done'"
        ),
        "accepted_decision"
    );
    assert!(
        scalar_text(
            db.file(),
            "SELECT source_ref FROM task_criteria WHERE task_id = 'task-done'"
        )
        .starts_with("archived-bot:"),
        "criterion should soft-reference the deleted bot"
    );
    assert_eq!(
        scalar_i64(
            db.file(),
            "SELECT COUNT(*) FROM router_messages WHERE message_id = 'm-1'"
        ),
        0
    );
    match must(db.owner().bots(BotRequest::List)) {
        BotResponse::List(bots) => {
            assert_eq!(bots.len(), 1);
            assert_eq!(bots[0].bot_id, "maia");
            assert!(!bots[0].running);
            assert!(!bots[0].status_line.contains("Ship the archive"));
            assert!(!bots[0].status_line.contains("Still working"));
        }
        other => panic!("list {other:?}"),
    }

    db.reopen(60);
    let snapshot = must(db.owner().runtime_snapshot());
    assert!(
        snapshot
            .tasks
            .iter()
            .all(|task| task.task_id != "task-done"),
        "archived deleted-bot tasks must not enter the runtime snapshot"
    );
    assert!(
        snapshot
            .tasks
            .iter()
            .all(|task| task.task_id != "task-live"),
        "purged running tasks must stay gone after reopen"
    );
}
