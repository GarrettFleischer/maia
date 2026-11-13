//! Forward-only schema application. There is no down migration.
//!
//! Each migration's DDL, journal insert, and `user_version` update commit in one
//! SQLite transaction. A mid-migration error rolls all three back.

use std::time::Duration;
use std::time::Instant;

use rusqlite::Connection;
use rusqlite::TransactionBehavior;

use crate::error::StoreError;
use crate::error::store_error_is_schema_lock_contention;
use crate::sql::MIGRATION_V1;
use crate::sql::MIGRATION_V2;
use crate::sql::MIGRATION_V3;
use crate::sql::MIGRATION_V4;
use crate::sql::MIGRATION_V5;
use crate::sql::MIGRATION_V6;
use crate::sql::MIGRATION_V7;
use crate::sql::MIGRATION_V8;
use crate::sql::MIGRATION_V9;
use crate::sql::MIGRATION_V10;
use crate::sql::MIGRATION_V11;
use crate::sql::MIGRATION_V12;
use crate::sql::MIGRATION_V13;
use crate::sql::MIGRATION_V14;
use crate::sql::MIGRATION_V15;
use crate::sql::MIGRATION_V16;
use crate::sql::MIGRATION_V17;
use crate::sql::MIGRATION_V18;

/// Highest `user_version` this binary can open.
pub const LATEST_SCHEMA_VERSION: i64 = 18;

/// How long a second opener waits for the migration writer. This is SQLite's
/// lock wait, not a process-global path mutex.
pub const SCHEMA_LOCK_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn with_schema_lock_retry<T, F>(mut attempt: F) -> Result<T, StoreError>
where
    F: FnMut() -> Result<T, StoreError>,
{
    let deadline = Instant::now() + SCHEMA_LOCK_BUSY_TIMEOUT;
    let mut last = StoreError::Sqlite {
        message: "schema lock timed out waiting for another opener".to_owned(),
        schema_lock_contention: false,
    };
    while Instant::now() < deadline {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(error) if store_error_is_schema_lock_contention(&error) => {
                last = error;
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

struct Migration {
    version: i64,
    name: &'static str,
    statements: &'static [&'static str],
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "schema_migrations",
        statements: MIGRATION_V1,
    },
    Migration {
        version: 2,
        name: "durable_schema",
        statements: MIGRATION_V2,
    },
    Migration {
        version: 3,
        name: "super_agent_schema",
        statements: MIGRATION_V3,
    },
    Migration {
        version: 4,
        name: "message_submission_idempotency",
        statements: MIGRATION_V4,
    },
    Migration {
        version: 5,
        name: "runtime_id_high_water",
        statements: MIGRATION_V5,
    },
    Migration {
        version: 6,
        name: "model_connection",
        statements: MIGRATION_V6,
    },
    Migration {
        version: 7,
        name: "router_turn_snapshots",
        statements: MIGRATION_V7,
    },
    Migration {
        version: 8,
        name: "mcp_connections",
        statements: MIGRATION_V8,
    },
    Migration {
        version: 9,
        name: "promotion_brain",
        statements: MIGRATION_V9,
    },
    Migration {
        version: 10,
        name: "approvals_attachments",
        statements: MIGRATION_V10,
    },
    Migration {
        version: 11,
        name: "brain_markdown",
        statements: MIGRATION_V11,
    },
    Migration {
        version: 12,
        name: "neuron_fts_porter",
        statements: MIGRATION_V12,
    },
    Migration {
        version: 13,
        name: "brain_memory",
        statements: MIGRATION_V13,
    },
    Migration {
        version: 14,
        name: "brain_polish",
        statements: MIGRATION_V14,
    },
    Migration {
        version: 15,
        name: "bots",
        statements: MIGRATION_V15,
    },
    Migration {
        version: 16,
        name: "memory_tags",
        statements: MIGRATION_V16,
    },
    Migration {
        version: 17,
        name: "purge_orphan_bot_tasks",
        statements: MIGRATION_V17,
    },
    Migration {
        version: 18,
        name: "claim_kind_and_scope",
        statements: MIGRATION_V18,
    },
];

pub(crate) fn apply(connection: &mut Connection, now: i64) -> Result<(), StoreError> {
    apply_migrations(connection, now, MIGRATIONS)
}

fn apply_migrations(
    connection: &mut Connection,
    now: i64,
    migrations: &[Migration],
) -> Result<(), StoreError> {
    for migration in migrations {
        apply_one(connection, now, migration)?;
    }
    Ok(())
}

fn apply_one(
    connection: &mut Connection,
    now: i64,
    migration: &Migration,
) -> Result<(), StoreError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current > LATEST_SCHEMA_VERSION {
        return Err(StoreError::DatabaseTooNew {
            found: current,
            supported: LATEST_SCHEMA_VERSION,
        });
    }
    if migration.version <= current {
        transaction.commit()?;
        return Ok(());
    }
    if migration.version != current + 1 {
        return Err(StoreError::InvalidRequest {
            message: format!(
                "migration {} is not the next version after {current}",
                migration.version
            ),
        });
    }
    for statement in migration.statements {
        transaction.execute_batch(statement)?;
    }
    if migration.version == 13 {
        crate::memory_cleanup::cleanup(&transaction)?;
    }
    if migration.version == 14 {
        crate::memory_cleanup::polish(&transaction)?;
    }
    if migration.version == 16 {
        crate::memory_tags::fill_empty(&transaction)?;
    }
    transaction.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![migration.version, migration.name, now],
    )?;
    transaction.pragma_update(None, "user_version", migration.version)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn rows(connection: &Connection) -> Result<Vec<crate::types::MigrationRow>, StoreError> {
    let mut statement = connection
        .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")?;
    let mapped = statement.query_map([], |row| {
        Ok(crate::types::MigrationRow {
            version: row.get(0)?,
            name: row.get(1)?,
            applied_at: row.get(2)?,
        })
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process;

    use rusqlite::Connection;

    use super::MIGRATIONS;
    use super::Migration;
    use super::apply;
    use super::apply_migrations;
    use crate::LEGACY_RUNTIME_ID_FLOOR;
    use crate::OwnerOpen;
    use crate::RuntimeIdNamespace;
    use crate::SqliteOwner;
    use crate::error::StoreError;
    use crate::register_sqlite_vec;

    fn ready<T, E: std::fmt::Display>(result: Result<T, E>) -> T {
        match result {
            Ok(value) => value,
            Err(error) => panic!("{error}"),
        }
    }

    #[test]
    fn mid_migration_error_rolls_back_catalog_journal_and_version() {
        let mut directory = std::env::temp_dir();
        directory.push(format!("maia-store-migrate-{}", process::id()));
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("temp dir: {error}"));
        let path = directory.join("maia.sqlite");
        ready(register_sqlite_vec());
        let mut connection = ready(Connection::open(&path));
        let broken = [Migration {
            version: 1,
            name: "broken",
            statements: &[
                "CREATE TABLE kept (id INTEGER PRIMARY KEY)",
                "SELECT nope FROM kept",
            ],
        }];
        match apply_migrations(&mut connection, 10, &broken) {
            Err(StoreError::Sqlite { .. }) => {}
            other => panic!("mid-migration SQL must fail, got {other:?}"),
        }
        drop(connection);
        let connection = ready(Connection::open(&path));
        let version: i64 =
            ready(connection.pragma_query_value(None, "user_version", |row| row.get(0)));
        assert_eq!(version, 0);
        let names = table_names(&connection);
        assert!(
            !names.iter().any(|name| name == "kept"),
            "rolled-back table still present: {names:?}"
        );
        assert!(
            !names.iter().any(|name| name == "schema_migrations"),
            "journal must roll back with the failed migration: {names:?}"
        );
        drop(connection);

        let owner = ready(SqliteOwner::open(OwnerOpen {
            path: path.clone(),
            now: 40,
            normal_capacity: 2,
            panic_capacity: 1,
        }));
        ready(owner.shutdown());
        let connection = ready(Connection::open(&path));
        let version: i64 =
            ready(connection.pragma_query_value(None, "user_version", |row| row.get(0)));
        assert_eq!(version, 18);
        let mut statement = ready(
            connection
                .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version"),
        );
        let mapped = ready(statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))));
        let mut rows = Vec::new();
        for row in mapped {
            rows.push(ready(row));
        }
        assert_eq!(
            rows,
            vec![
                (1_i64, 40_i64),
                (2, 40),
                (3, 40),
                (4, 40),
                (5, 40),
                (6, 40),
                (7, 40),
                (8, 40),
                (9, 40),
                (10, 40),
                (11, 40),
                (12, 40),
                (13, 40),
                (14, 40),
                (15, 40),
                (16, 40),
                (17, 40),
                (18, 40)
            ]
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn v3_to_latest_preserves_legacy_router_rows_without_fake_backfill() {
        let mut directory = std::env::temp_dir();
        directory.push(format!("maia-store-v3-v4-{}", process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("temp dir: {error}"));
        let path = directory.join("maia.sqlite");
        ready(register_sqlite_vec());
        let mut connection = ready(Connection::open(&path));
        ready(apply_migrations(&mut connection, 10, &MIGRATIONS[..3]));
        ready(connection.execute(
            "INSERT INTO router_messages (message_id, ordinal, role, body, created_at) \
             VALUES ('legacy-message', 1, 'user', 'status', 9)",
            [],
        ));

        ready(apply(&mut connection, 20));

        let version: i64 =
            ready(connection.pragma_query_value(None, "user_version", |row| row.get(0)));
        assert_eq!(version, 18);
        let legacy: String = ready(connection.query_row(
            "SELECT body FROM router_messages WHERE message_id = 'legacy-message'",
            [],
            |row| row.get(0),
        ));
        assert_eq!(legacy, "status");
        let submissions: i64 = ready(connection.query_row(
            "SELECT COUNT(*) FROM message_submissions",
            [],
            |row| row.get(0),
        ));
        assert_eq!(submissions, 0);
        drop(connection);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn v4_migration_backfills_all_runtime_namespaces_from_owners() {
        let mut directory = std::env::temp_dir();
        directory.push(format!("maia-store-v4-runtime-{}", process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("temp dir: {error}"));
        let path = directory.join("maia.sqlite");
        ready(register_sqlite_vec());
        let mut connection = ready(Connection::open(&path));
        ready(apply_migrations(&mut connection, 10, &MIGRATIONS[..4]));
        let floor = LEGACY_RUNTIME_ID_FLOOR;
        ready(connection.execute_batch(&format!(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO router_messages VALUES ('m-{m1}', 1, 'user', 'legacy', 1);
             INSERT INTO router_messages VALUES ('m-{m2}', 2, 'user', 'legacy-2', 2);
             INSERT INTO task_sessions VALUES
               ('task-{task}', 'abandoned:decision-{decision}', 'legacy', 'unpinned',
                'closed_once', NULL, 1);
             INSERT INTO task_sessions VALUES
               ('legacy-open-detail', 'queued', 'legacy open', 'unpinned',
                'open:detail-{detail}', NULL, 2);
             INSERT INTO task_attempts VALUES ('task-{task}', 'attempt-{attempt}', 'active');
             INSERT INTO task_envelopes VALUES
               ('task-{task}', X'78', 'brief', 'reason', 'snap-{snapshot}');
             INSERT INTO task_inputs VALUES ('task-{task}', 'm-{m2}', X'79');
             INSERT INTO task_criteria VALUES
               ('criterion-{criterion}', 'task-{task}', 'user_text', 'm-{m2}', 0, 1, 'y');
             INSERT INTO task_criteria VALUES
               ('legacy-second-criterion', 'task-{task}', 'user_text', 'm-{m2}', 0, 1, 'y');
             INSERT INTO task_evidence VALUES
               ('evidence-{evidence}', 'task-{task}', 'attempt-{attempt}', 'proof');
             INSERT INTO task_reports VALUES
               ('report-{report}', 'task-{task}', 'attempt-{attempt}', 'progress', 'step', 2,
                'call-{call}');
             INSERT INTO child_assignments
               (child_id, parent_task_id, depth, subgoal, budget_tokens, budget_turns, phase)
               VALUES ('child-{child}', 'task-{task}', 1, X'7A', 1, 1, 'cancelled:{command}');
             INSERT INTO negative_marks
               (mark_id, ledger_id, target_kind, target_id, presentation_id, thread_id, message_id,
                evidence_span_start, evidence_span_end, occurred_at, dream_queue_id)
               VALUES ('mark-v4', 'missing-ledger', 'fact', 'target', 'missing-presentation',
                'missing-thread', 'm-{m3}', 0, 1, 1, 'missing-queue');",
            m1 = floor + 1,
            m2 = floor + 2,
            m3 = floor + 3,
            task = floor + 4,
            attempt = floor + 5,
            report = floor + 6,
            call = floor + 7,
            evidence = floor + 8,
            snapshot = floor + 9,
            criterion = floor + 10,
            child = floor + 11,
            decision = floor + 12,
            command = floor + 13,
            detail = floor + 14,
        )));

        ready(apply_migrations(&mut connection, 20, &MIGRATIONS[4..]));

        let expected = [
            (RuntimeIdNamespace::Message, floor + 3),
            (RuntimeIdNamespace::Task, floor + 4),
            (RuntimeIdNamespace::Attempt, floor + 5),
            (RuntimeIdNamespace::Envelope, floor),
            (RuntimeIdNamespace::Report, floor + 6),
            (RuntimeIdNamespace::Call, floor + 7),
            (RuntimeIdNamespace::Evidence, floor + 8),
            (RuntimeIdNamespace::Snapshot, floor + 9),
            (RuntimeIdNamespace::Criterion, floor + 10),
            (RuntimeIdNamespace::Request, floor),
            (RuntimeIdNamespace::Child, floor + 11),
            (RuntimeIdNamespace::Detail, floor + 14),
            (RuntimeIdNamespace::Decision, floor + 12),
            (RuntimeIdNamespace::Command, floor + 13),
        ];
        for &(namespace, consumed) in &expected {
            let stored: String = ready(connection.query_row(
                "SELECT value FROM runtime_id_high_water WHERE namespace = ?1",
                [namespace.key()],
                |row| row.get(0),
            ));
            assert_eq!(stored, consumed.to_string(), "{namespace:?}");
        }
        let reserved = ready(crate::super_agent_ops::reserve_runtime_id_block(
            &mut connection,
            4096,
        ));
        for &(namespace, consumed) in &expected {
            assert_eq!(reserved.first(namespace), consumed + 1, "{namespace:?}");
        }
        let ordinals: String = ready(connection.query_row(
            "SELECT group_concat(ordinal, ',') FROM \
             (SELECT ordinal FROM task_criteria WHERE task_id LIKE 'task-%' ORDER BY ordinal)",
            [],
            |row| row.get(0),
        ));
        assert_eq!(ordinals, "0,1");
        let version: i64 =
            ready(connection.pragma_query_value(None, "user_version", |row| row.get(0)));
        assert_eq!(version, 18);
        drop(connection);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn version_fourteen_merges_a_place_person_and_duplicate_names() {
        let mut directory = std::env::temp_dir();
        directory.push(format!("maia-store-polish-{}", process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("temp dir: {error}"));
        let path = directory.join("maia.sqlite");
        ready(register_sqlite_vec());
        let mut connection = ready(Connection::open(&path));
        ready(apply_migrations(&mut connection, 10, &MIGRATIONS[..13]));
        ready(connection.execute_batch(
            "INSERT INTO threads (thread_id, version, participants, created_at) VALUES ('t-1', 1, 'owner', 1);
             INSERT INTO episodes (episode_id, thread_id, turn_id, body, taint, participants, created_at, write_canonical)
               VALUES ('episode-1', 't-1', 'turn-1', 'Owner: The owner''s name is Garrett.', 'trusted', 'owner', 1, 'canon-1');
             INSERT INTO episodes (episode_id, thread_id, turn_id, body, taint, participants, created_at, write_canonical)
               VALUES ('episode-2', 't-1', 'turn-2', 'Owner: The user''s name is Garrett.', 'trusted', 'owner', 2, 'canon-2');
             INSERT INTO claims (claim_id, sentence, episode_id, taint, status, valid_from)
               VALUES ('claim-a', 'The owner''s name is Garrett.', 'episode-1', 'trusted', 'provisional', 1);
             INSERT INTO claims (claim_id, sentence, episode_id, taint, status, valid_from)
               VALUES ('claim-b', 'The user''s name is Garrett.', 'episode-2', 'trusted', 'provisional', 2);
             INSERT INTO entities (entity_id, slug, description, scope_kind, scope_agent, kind)
               VALUES ('entity-canby', 'canby', 'Canby', 'world', '', 'place');
             INSERT INTO entities (entity_id, slug, description, scope_kind, scope_agent, kind)
               VALUES ('entity-canbyoregon', 'canbyoregon', 'Canby Oregon', 'world', '', 'person');
             INSERT INTO edges (edge_kind, from_kind, from_id, to_kind, to_id, weight)
               VALUES ('about', 'claim', 'claim-a', 'entity', 'entity-canbyoregon', 1.0);",
        ));
        ready(apply(&mut connection, 30));
        let people: i64 = ready(connection.query_row(
            "SELECT COUNT(*) FROM entities WHERE description = 'Canby Oregon'",
            [],
            |row| row.get(0),
        ));
        assert_eq!(people, 0);
        let kind: String = ready(connection.query_row(
            "SELECT kind FROM entities WHERE entity_id = 'entity-canby'",
            [],
            |row| row.get(0),
        ));
        assert_eq!(kind, "place");
        let target: String = ready(connection.query_row(
            "SELECT to_id FROM edges WHERE from_id = 'claim-a' AND to_kind = 'entity'",
            [],
            |row| row.get(0),
        ));
        assert_eq!(target, "entity-canby");
        let visible: i64 = ready(connection.query_row(
            "SELECT COUNT(*) FROM claims WHERE hidden_reason IS NULL AND status = 'provisional'",
            [],
            |row| row.get(0),
        ));
        assert_eq!(visible, 1);
        let hidden: String = ready(connection.query_row(
            "SELECT hidden_reason FROM claims WHERE claim_id = 'claim-b'",
            [],
            |row| row.get(0),
        ));
        assert_eq!(hidden, "duplicate");
        drop(connection);
        let _ = fs::remove_dir_all(directory);
    }

    fn table_names(connection: &Connection) -> Vec<String> {
        let mut statement = ready(
            connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
        );
        let mapped = ready(statement.query_map([], |row| row.get(0)));
        let mut names = Vec::new();
        for name in mapped {
            names.push(ready(name));
        }
        names
    }
}
