//! Append-only audit chain, checkpoints, and the panic latch.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::actor_parts;
use crate::canonical::validate_audit;
use crate::error::StoreError;
use crate::types::AuditAppend;
use crate::types::AuditHead;
use crate::types::ClearPanic;
use crate::types::EngagePanic;
use crate::types::PanicLatch;

fn link_hash(canonical: &[u8]) -> u64 {
    maia_core::audit::compute_event_hash(canonical).0
}

fn hash_text(value: u64) -> String {
    value.to_string()
}

fn parse_hash(value: &str, sequence: u64) -> Result<u64, StoreError> {
    value
        .parse::<u64>()
        .map_err(|_| StoreError::AuditChainInvalid { sequence })
}

fn require_matching_hash(request: &AuditAppend) -> Result<(), StoreError> {
    if request.event_hash != link_hash(&request.canonical) {
        return Err(StoreError::AuditHashMismatch {
            sequence: request.sequence,
        });
    }
    if request.sequence == 1 && request.previous_hash != maia_core::audit::AuditHash::genesis().0 {
        return Err(StoreError::AuditChainInvalid { sequence: 1 });
    }
    Ok(())
}

fn immediate(connection: &mut Connection) -> Result<Transaction<'_>, StoreError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StoreError::from)
}

fn as_u64(value: i64, sequence: u64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| StoreError::AuditChainInvalid { sequence })
}

pub(crate) fn verify(connection: &Connection) -> Result<(), StoreError> {
    let mut statement = connection.prepare(
        "SELECT sequence, previous_hash, event_hash, canonical FROM audit_events ORDER BY sequence",
    )?;
    let mut rows = statement.query([])?;
    let mut expected = 1_u64;
    let mut previous_hash: Option<u64> = None;
    let mut events: Vec<(u64, String)> = Vec::new();
    while let Some(row) = rows.next()? {
        let sequence = as_u64(row.get(0)?, expected)?;
        let predecessor_text: String = row.get(1)?;
        let event_hash_text: String = row.get(2)?;
        let canonical: Vec<u8> = row.get(3)?;
        let predecessor = parse_hash(&predecessor_text, sequence)?;
        let event_hash = parse_hash(&event_hash_text, sequence)?;
        if link_hash(&canonical) != event_hash {
            return Err(StoreError::AuditHashMismatch { sequence });
        }
        if sequence != expected {
            return Err(StoreError::AuditChainInvalid { sequence });
        }
        if sequence == 1 && predecessor != maia_core::audit::AuditHash::genesis().0 {
            return Err(StoreError::AuditChainInvalid { sequence });
        }
        if let Some(prior) = previous_hash
            && predecessor != prior
        {
            return Err(StoreError::AuditChainInvalid { sequence });
        }
        previous_hash = Some(event_hash);
        events.push((sequence, event_hash_text));
        expected += 1;
    }
    drop(rows);
    drop(statement);

    let mut checkpoints = connection
        .prepare("SELECT sequence, event_hash FROM audit_checkpoints ORDER BY sequence")?;
    let mut checkpoint_rows = checkpoints.query([])?;
    let mut seen = 0_usize;
    let mut last_checkpoint: Option<u64> = None;
    while let Some(row) = checkpoint_rows.next()? {
        let sequence = as_u64(row.get(0)?, 0)?;
        let event_hash: String = row.get(1)?;
        let matched = events.iter().any(|(stored_sequence, stored_hash)| {
            *stored_sequence == sequence && stored_hash == &event_hash
        });
        if !matched {
            return Err(StoreError::AuditChainInvalid { sequence });
        }
        seen += 1;
        last_checkpoint = Some(sequence);
    }
    if seen != events.len() {
        let sequence = events.last().map(|(sequence, _)| *sequence).unwrap_or(0);
        return Err(StoreError::AuditChainInvalid { sequence });
    }
    let last_event = events.last().map(|(sequence, _)| *sequence);
    if last_event != last_checkpoint {
        return Err(StoreError::AuditChainInvalid {
            sequence: last_event.unwrap_or(0),
        });
    }
    Ok(())
}

fn head_hash(transaction: &Transaction<'_>, sequence: u64) -> Result<Option<String>, StoreError> {
    transaction
        .query_row(
            "SELECT event_hash FROM audit_events WHERE sequence = ?1",
            params![sequence as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::from)
}

fn audit_matches(
    transaction: &Transaction<'_>,
    request: &AuditAppend,
) -> Result<Option<bool>, StoreError> {
    let stored = transaction
        .query_row(
            "SELECT sequence, thread_id, actor_kind, actor_id, kind, cause_event_id, request_id, occurred_at, \
             payload_hash, previous_hash, event_hash, canonical, profile, allowlist_entry_id \
             FROM audit_events WHERE event_id = ?1",
            params![request.event_id],
            |row| {
                Ok(StoredAudit {
                    sequence: row.get(0)?,
                    thread_id: row.get(1)?,
                    actor_kind: row.get(2)?,
                    actor_id: row.get(3)?,
                    kind: row.get(4)?,
                    cause_event_id: row.get(5)?,
                    request_id: row.get(6)?,
                    occurred_at: row.get(7)?,
                    payload_hash: row.get(8)?,
                    previous_hash: row.get(9)?,
                    event_hash: row.get(10)?,
                    canonical: row.get(11)?,
                    profile: row.get(12)?,
                    allowlist_entry_id: row.get(13)?,
                })
            },
        )
        .optional()?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let (actor_kind, actor_id) = actor_parts(&request.actor);
    let same = stored.sequence == request.sequence as i64
        && stored.thread_id == request.thread_id
        && stored.actor_kind == actor_kind
        && stored.actor_id == actor_id.map(str::to_owned)
        && stored.kind == request.kind
        && stored.cause_event_id == request.cause_event_id
        && stored.request_id == request.request_id
        && stored.occurred_at == request.occurred_at
        && stored.payload_hash == request.payload_hash
        && stored.previous_hash == hash_text(request.previous_hash)
        && stored.event_hash == hash_text(request.event_hash)
        && stored.canonical == request.canonical
        && stored.profile == request.profile
        && stored.allowlist_entry_id == request.allowlist_entry_id;
    if !same {
        return Ok(Some(false));
    }
    let checkpoint: Option<(String, i64, i64)> = transaction
        .query_row(
            "SELECT event_hash, policy_version, occurred_at FROM audit_checkpoints WHERE sequence = ?1",
            params![request.sequence as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((event_hash, policy_version, occurred_at)) = checkpoint else {
        return Ok(Some(false));
    };
    if event_hash != hash_text(request.event_hash)
        || policy_version != i64::try_from(request.policy_version).unwrap_or(i64::MAX)
        || occurred_at != request.checkpoint_at
    {
        return Ok(Some(false));
    }
    if let Some(payload) = &request.payload {
        let stored_payload: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT body FROM audit_blobs WHERE payload_hash = ?1",
                params![request.payload_hash],
                |row| row.get(0),
            )
            .optional()?;
        if stored_payload.as_ref() != Some(payload) {
            return Ok(Some(false));
        }
    }
    Ok(Some(true))
}

struct StoredAudit {
    sequence: i64,
    thread_id: Option<String>,
    actor_kind: String,
    actor_id: Option<String>,
    kind: String,
    cause_event_id: Option<String>,
    request_id: Option<String>,
    occurred_at: i64,
    payload_hash: String,
    previous_hash: String,
    event_hash: String,
    canonical: Vec<u8>,
    profile: String,
    allowlist_entry_id: Option<String>,
}

pub(crate) fn insert_audit(
    transaction: &Transaction<'_>,
    request: &AuditAppend,
) -> Result<(), StoreError> {
    validate_audit(request)?;
    require_matching_hash(request)?;
    match audit_matches(transaction, request)? {
        Some(true) => return Ok(()),
        Some(false) => {
            return Err(StoreError::IdempotencyConflict {
                key: request.event_id.clone(),
            });
        }
        None => {}
    }
    let max_sequence: Option<i64> =
        transaction.query_row("SELECT MAX(sequence) FROM audit_events", [], |row| {
            row.get(0)
        })?;
    let next = match max_sequence {
        Some(max_sequence) => as_u64(max_sequence, 0)?.saturating_add(1),
        None => 1,
    };
    if request.sequence != next {
        return Err(StoreError::AuditChainInvalid {
            sequence: request.sequence,
        });
    }
    if let Some(max_sequence) = max_sequence {
        let prior = as_u64(max_sequence, request.sequence)?;
        let expected = head_hash(transaction, prior)?.ok_or(StoreError::AuditChainInvalid {
            sequence: request.sequence,
        })?;
        if hash_text(request.previous_hash) != expected {
            return Err(StoreError::AuditChainInvalid {
                sequence: request.sequence,
            });
        }
    }
    if let Some(payload) = &request.payload {
        let existing: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT body FROM audit_blobs WHERE payload_hash = ?1",
                params![request.payload_hash],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            if existing != *payload {
                return Err(StoreError::IdempotencyConflict {
                    key: request.payload_hash.clone(),
                });
            }
        } else {
            transaction.execute(
                "INSERT INTO audit_blobs (payload_hash, body) VALUES (?1, ?2)",
                params![request.payload_hash, payload],
            )?;
        }
    }
    let (actor_kind, actor_id) = actor_parts(&request.actor);
    let policy_version =
        i64::try_from(request.policy_version).map_err(|_| StoreError::InvalidRequest {
            message: "policy version does not fit".to_owned(),
        })?;
    transaction.execute(
        "INSERT INTO audit_events (sequence, event_id, thread_id, actor_kind, actor_id, kind, cause_event_id, \
         request_id, occurred_at, payload_hash, previous_hash, event_hash, canonical, profile, allowlist_entry_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            request.sequence as i64,
            request.event_id,
            request.thread_id,
            actor_kind,
            actor_id,
            request.kind,
            request.cause_event_id,
            request.request_id,
            request.occurred_at,
            request.payload_hash,
            hash_text(request.previous_hash),
            hash_text(request.event_hash),
            request.canonical,
            request.profile,
            request.allowlist_entry_id
        ],
    )?;
    transaction.execute(
        "INSERT INTO audit_checkpoints (sequence, event_hash, policy_version, occurred_at) VALUES (?1, ?2, ?3, ?4)",
        params![
            request.sequence as i64,
            hash_text(request.event_hash),
            policy_version,
            request.checkpoint_at
        ],
    )?;
    Ok(())
}

pub(crate) fn append(connection: &mut Connection, request: &AuditAppend) -> Result<(), StoreError> {
    let transaction = immediate(connection)?;
    insert_audit(&transaction, request)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn head(connection: &Connection) -> Result<Option<AuditHead>, StoreError> {
    let row = connection
        .query_row(
            "SELECT sequence, event_hash, policy_version, occurred_at FROM audit_checkpoints \
             ORDER BY sequence DESC LIMIT 1",
            [],
            |row| {
                let sequence: i64 = row.get(0)?;
                let event_hash: String = row.get(1)?;
                let policy_version: i64 = row.get(2)?;
                let checkpoint_at: i64 = row.get(3)?;
                Ok((sequence, event_hash, policy_version, checkpoint_at))
            },
        )
        .optional()?;
    let Some((sequence, event_hash, policy_version, checkpoint_at)) = row else {
        return Ok(None);
    };
    let sequence = as_u64(sequence, 0)?;
    let event_hash = parse_hash(&event_hash, sequence)?;
    let policy_version =
        u64::try_from(policy_version).map_err(|_| StoreError::AuditChainInvalid { sequence })?;
    Ok(Some(AuditHead {
        sequence,
        event_hash,
        policy_version,
        checkpoint_at,
    }))
}

pub(crate) fn read_latch(connection: &Connection) -> Result<PanicLatch, StoreError> {
    connection.query_row(
        "SELECT generation, engaged, engaged_by, engaged_at FROM panic_state WHERE singleton = 1",
        [],
        |row| {
            let generation: i64 = row.get(0)?;
            let engaged: i64 = row.get(1)?;
            Ok(PanicLatch {
                generation: generation as u64,
                engaged: engaged == 1,
                engaged_by: row.get(2)?,
                engaged_at: row.get(3)?,
            })
        },
    ).map_err(StoreError::from)
}

pub(crate) fn engage(
    connection: &mut Connection,
    request: &EngagePanic,
) -> Result<PanicLatch, StoreError> {
    let transaction = immediate(connection)?;
    let latch = read_latch(&transaction)?;
    if latch.engaged {
        transaction.commit()?;
        return Ok(latch);
    }
    let generation = latch
        .generation
        .checked_add(1)
        .ok_or_else(|| StoreError::InvalidRequest {
            message: "panic generation overflow".to_owned(),
        })?;
    transaction.execute(
        "UPDATE panic_state SET generation = ?1, engaged = 1, engaged_by = ?2, engaged_at = ?3 WHERE singleton = 1",
        params![generation as i64, request.action_id, request.at],
    )?;
    insert_audit(&transaction, &request.audit)?;
    transaction.commit()?;
    Ok(PanicLatch {
        generation,
        engaged: true,
        engaged_by: Some(request.action_id.clone()),
        engaged_at: Some(request.at),
    })
}

pub(crate) fn clear(
    connection: &mut Connection,
    request: &ClearPanic,
) -> Result<PanicLatch, StoreError> {
    let transaction = immediate(connection)?;
    let latch = read_latch(&transaction)?;
    if !latch.engaged {
        transaction.commit()?;
        return Ok(latch);
    }
    transaction.execute("UPDATE panic_state SET engaged = 0 WHERE singleton = 1", [])?;
    insert_audit(&transaction, &request.audit)?;
    transaction.commit()?;
    Ok(PanicLatch {
        generation: latch.generation,
        engaged: false,
        engaged_by: latch.engaged_by,
        engaged_at: latch.engaged_at,
    })
}
