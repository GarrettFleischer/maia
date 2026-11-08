//! Thread log compare-and-swap appends.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::validate_append;
use crate::error::StoreError;
use crate::types::AppendEvents;
use crate::types::AppendOutcome;
use crate::types::StoredThreadEvent;
use crate::types::ThreadEventWrite;
use crate::types::ThreadSnapshot;

struct ThreadMeta {
    version: u64,
    participants: String,
}

enum AppendPlan {
    Apply { version: u64 },
    Replay { version: u64 },
    Conflict { actual: u64 },
    IdentityMismatch,
}

fn plan_append(
    current: Option<u64>,
    expected: u64,
    incoming: &[ThreadEventWrite],
    occurred_at: i64,
    tail: &[StoredThreadEvent],
) -> AppendPlan {
    if current.is_none() && expected != 0 {
        return AppendPlan::Conflict { actual: 0 };
    }
    let current_version = current.unwrap_or(0);
    let length = incoming.len() as u64;
    let target = expected + length;
    if current_version == expected {
        return AppendPlan::Apply { version: target };
    }
    if !incoming.is_empty() && current_version == target {
        if tail_matches(tail, incoming, occurred_at) {
            return AppendPlan::Replay {
                version: current_version,
            };
        }
        return AppendPlan::IdentityMismatch;
    }
    AppendPlan::Conflict {
        actual: current_version,
    }
}

fn tail_matches(
    tail: &[StoredThreadEvent],
    incoming: &[ThreadEventWrite],
    occurred_at: i64,
) -> bool {
    if tail.len() != incoming.len() {
        return false;
    }
    for (stored, event) in tail.iter().zip(incoming.iter()) {
        if stored.event_id != event.event_id
            || stored.kind != event.kind
            || stored.body != event.body
            || stored.occurred_at != occurred_at
        {
            return false;
        }
    }
    true
}

fn immediate(connection: &mut Connection) -> Result<Transaction<'_>, StoreError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StoreError::from)
}

fn load_meta(connection: &Connection, thread_id: &str) -> Result<Option<ThreadMeta>, StoreError> {
    let row = connection
        .query_row(
            "SELECT version, participants FROM threads WHERE thread_id = ?1",
            params![thread_id],
            |row| {
                let version: i64 = row.get(0)?;
                let participants: String = row.get(1)?;
                Ok((version, participants))
            },
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((version, participants)) => {
            let version = u64::try_from(version).map_err(|_| StoreError::InvalidRequest {
                message: "stored thread version is negative".to_owned(),
            })?;
            Ok(Some(ThreadMeta {
                version,
                participants,
            }))
        }
    }
}

fn load_tail(
    connection: &Connection,
    thread_id: &str,
    expected: u64,
    target: u64,
) -> Result<Vec<StoredThreadEvent>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT ordinal, event_id, kind, body, occurred_at FROM thread_events \
         WHERE thread_id = ?1 AND ordinal > ?2 AND ordinal <= ?3 ORDER BY ordinal",
    )?;
    let mapped =
        statement.query_map(params![thread_id, expected as i64, target as i64], |row| {
            Ok(StoredThreadEvent {
                ordinal: row.get::<_, i64>(0)? as u64,
                event_id: row.get(1)?,
                kind: row.get(2)?,
                body: row.get(3)?,
                occurred_at: row.get(4)?,
            })
        })?;
    let mut events = Vec::new();
    for event in mapped {
        events.push(event?);
    }
    Ok(events)
}

fn insert_events(connection: &Connection, request: &AppendEvents) -> Result<(), StoreError> {
    for (index, event) in request.events.iter().enumerate() {
        let ordinal = request.expected_version + index as u64 + 1;
        connection.execute(
            "INSERT INTO thread_events (thread_id, ordinal, event_id, kind, body, occurred_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                request.thread_id,
                ordinal as i64,
                event.event_id,
                event.kind,
                event.body,
                request.occurred_at
            ],
        )?;
    }
    Ok(())
}

pub(crate) fn append(
    connection: &mut Connection,
    request: &AppendEvents,
) -> Result<AppendOutcome, StoreError> {
    validate_append(request)?;
    let transaction = immediate(connection)?;
    let meta = load_meta(&transaction, &request.thread_id)?;
    if let Some(meta) = &meta
        && meta.participants != request.participants
    {
        return Err(StoreError::IdempotencyConflict {
            key: request.thread_id.clone(),
        });
    }
    let length = request.events.len() as u64;
    let target = request.expected_version + length;
    let tail = if meta.is_some() {
        load_tail(
            &transaction,
            &request.thread_id,
            request.expected_version,
            target,
        )?
    } else {
        Vec::new()
    };
    let current = meta.as_ref().map(|item| item.version);
    let plan = plan_append(
        current,
        request.expected_version,
        &request.events,
        request.occurred_at,
        &tail,
    );
    match plan {
        AppendPlan::Replay { version } => {
            transaction.commit()?;
            Ok(AppendOutcome { version })
        }
        AppendPlan::IdentityMismatch => Err(StoreError::IdempotencyConflict {
            key: request.thread_id.clone(),
        }),
        AppendPlan::Conflict { actual } => Err(StoreError::VersionConflict {
            expected: request.expected_version,
            actual,
        }),
        AppendPlan::Apply { version } => {
            if meta.is_none() {
                transaction.execute(
                    "INSERT INTO threads (thread_id, version, participants, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![request.thread_id, version as i64, request.participants, request.occurred_at],
                )?;
            } else {
                transaction.execute(
                    "UPDATE threads SET version = ?1 WHERE thread_id = ?2",
                    params![version as i64, request.thread_id],
                )?;
            }
            insert_events(&transaction, request)?;
            transaction.commit()?;
            Ok(AppendOutcome { version })
        }
    }
}

pub(crate) fn snapshot(
    connection: &Connection,
    thread_id: &str,
) -> Result<ThreadSnapshot, StoreError> {
    let meta = load_meta(connection, thread_id)?.ok_or_else(|| StoreError::NotFound {
        entity: "thread",
        id: thread_id.to_owned(),
    })?;
    let created_at: i64 = connection.query_row(
        "SELECT created_at FROM threads WHERE thread_id = ?1",
        params![thread_id],
        |row| row.get(0),
    )?;
    let mut statement = connection.prepare(
        "SELECT ordinal, event_id, kind, body, occurred_at FROM thread_events \
         WHERE thread_id = ?1 ORDER BY ordinal",
    )?;
    let mapped = statement.query_map(params![thread_id], |row| {
        Ok(StoredThreadEvent {
            ordinal: row.get::<_, i64>(0)? as u64,
            event_id: row.get(1)?,
            kind: row.get(2)?,
            body: row.get(3)?,
            occurred_at: row.get(4)?,
        })
    })?;
    let mut events = Vec::new();
    for event in mapped {
        events.push(event?);
    }
    Ok(ThreadSnapshot {
        thread_id: thread_id.to_owned(),
        version: meta.version,
        participants: meta.participants,
        created_at,
        events,
    })
}
