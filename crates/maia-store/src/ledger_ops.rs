//! Atomic presentation-ledger application.

use std::collections::BTreeMap;

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::ledger_canonical;
use crate::error::StoreError;
use crate::types::LedgerWrite;

pub(crate) fn apply(connection: &mut Connection, request: &LedgerWrite) -> Result<(), StoreError> {
    let canonical = ledger_canonical(request)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<String> = transaction
        .query_row(
            "SELECT canonical FROM ledgers WHERE ledger_id = ?1",
            params![request.ledger_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(stored) = existing {
        if stored == canonical {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.ledger_id.clone(),
        });
    }
    transaction.execute(
        "INSERT INTO ledgers (ledger_id, thread_id, request_id, compiled_prefix_hash, applied_at, canonical) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            request.ledger_id,
            request.thread_id,
            request.request_id,
            request.compiled_prefix_hash,
            request.applied_at,
            canonical
        ],
    )?;
    for presentation in &request.presentations {
        transaction.execute(
            "INSERT INTO presentations (presentation_id, ledger_id, candidate_kind, candidate_id, source, weight, \
             source_span_start, source_span_end, evidence_span_start, evidence_span_end, thread_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                presentation.presentation_id,
                request.ledger_id,
                presentation.candidate_kind.as_str(),
                presentation.candidate_id,
                presentation.source.as_str(),
                presentation.weight,
                presentation.source_span_start,
                presentation.source_span_end,
                presentation.evidence_span_start,
                presentation.evidence_span_end,
                presentation.thread_id
            ],
        )?;
    }
    let mut heat = BTreeMap::<String, f64>::new();
    for update in &request.heat {
        let entry = heat.entry(update.slot_id.clone()).or_insert(0.0);
        *entry += update.weight;
    }
    for (slot_id, weight) in heat {
        transaction.execute(
            "INSERT INTO ledger_heat (ledger_id, slot_id, weight) VALUES (?1, ?2, ?3)",
            params![request.ledger_id, slot_id, weight],
        )?;
        transaction.execute(
            "INSERT INTO slot_heat (thread_id, slot_id, heat) VALUES (?1, ?2, ?3) \
             ON CONFLICT (thread_id, slot_id) DO UPDATE SET heat = heat + excluded.heat",
            params![request.thread_id, slot_id, weight],
        )?;
    }
    for edge in &request.co_use {
        transaction.execute(
            "INSERT INTO edges (edge_kind, from_kind, from_id, to_kind, to_id, weight) \
             VALUES ('co_use', ?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT (edge_kind, from_kind, from_id, to_kind, to_id) \
             DO UPDATE SET weight = weight + excluded.weight",
            params![
                edge.left_kind.as_str(),
                edge.left_id,
                edge.right_kind.as_str(),
                edge.right_id,
                edge.weight
            ],
        )?;
    }
    for mark in &request.negative_marks {
        transaction.execute(
            "INSERT INTO dream_queue (dream_queue_id, target_kind, target_id, enqueued_at, consumed_at, ledger_id) \
             VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            params![
                mark.dream_queue_id,
                mark.target_kind.as_str(),
                mark.target_id,
                mark.occurred_at,
                request.ledger_id
            ],
        )?;
        transaction.execute(
            "INSERT INTO negative_marks (mark_id, ledger_id, target_kind, target_id, presentation_id, thread_id, \
             message_id, evidence_span_start, evidence_span_end, occurred_at, dream_queue_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                mark.mark_id,
                request.ledger_id,
                mark.target_kind.as_str(),
                mark.target_id,
                mark.presentation_id,
                mark.thread_id,
                mark.message_id,
                mark.evidence_span_start,
                mark.evidence_span_end,
                mark.occurred_at,
                mark.dream_queue_id
            ],
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO correction_holds (target_kind, target_id, since) VALUES (?1, ?2, ?3)",
            params![mark.target_kind.as_str(), mark.target_id, mark.occurred_at],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn reverse(
    connection: &mut Connection,
    ledger_id: &str,
    now: i64,
) -> Result<(), StoreError> {
    crate::canonical::require_text("ledger_id", ledger_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM ledgers WHERE ledger_id = ?1",
            params![ledger_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(StoreError::NotFound {
            entity: "ledger",
            id: ledger_id.to_owned(),
        });
    }
    let reversed: Option<i64> = transaction
        .query_row(
            "SELECT reversed_at FROM ledger_reversals WHERE ledger_id = ?1",
            params![ledger_id],
            |row| row.get(0),
        )
        .optional()?;
    if reversed.is_some() {
        transaction.commit()?;
        return Ok(());
    }
    let mut statement = transaction.prepare(
        "SELECT candidate_kind, candidate_id, weight FROM presentations \
         WHERE ledger_id = ?1 ORDER BY presentation_id",
    )?;
    let mapped = statement.query_map(params![ledger_id], |row| {
        Ok(StoredUse {
            kind: row.get(0)?,
            id: row.get(1)?,
            weight: row.get(2)?,
        })
    })?;
    let mut stored = Vec::new();
    for row in mapped {
        stored.push(row?);
    }
    drop(statement);
    let increments = co_use_from_stored(&stored);
    for edge in &increments {
        let (left_kind, left_id) = endpoint(&edge.left);
        let (right_kind, right_id) = endpoint(&edge.right);
        transaction.execute(
            "UPDATE edges SET weight = weight - ?5 \
             WHERE edge_kind = 'co_use' AND from_kind = ?1 AND from_id = ?2 \
             AND to_kind = ?3 AND to_id = ?4",
            params![left_kind, left_id, right_kind, right_id, edge.weight],
        )?;
        transaction.execute(
            "DELETE FROM edges \
             WHERE edge_kind = 'co_use' AND from_kind = ?1 AND from_id = ?2 \
             AND to_kind = ?3 AND to_id = ?4 AND weight <= 0.000001",
            params![left_kind, left_id, right_kind, right_id],
        )?;
    }
    transaction.execute(
        "INSERT INTO ledger_reversals (ledger_id, reversed_at) VALUES (?1, ?2)",
        params![ledger_id, now],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn presented_ids(
    connection: &Connection,
    request_id: &str,
) -> Result<Vec<String>, StoreError> {
    crate::canonical::require_text("request_id", request_id)?;
    let mut statement = connection.prepare(
        "SELECT DISTINCT p.candidate_id FROM presentations p \
         JOIN ledgers l ON l.ledger_id = p.ledger_id \
         WHERE l.request_id = ?1 AND p.weight > 0 \
         ORDER BY p.candidate_id",
    )?;
    let mapped = statement.query_map(params![request_id], |row| row.get::<_, String>(0))?;
    let mut ids = Vec::new();
    for id in mapped {
        ids.push(id?);
    }
    Ok(ids)
}

struct StoredUse {
    kind: String,
    id: String,
    weight: f64,
}

fn co_use_from_stored(stored: &[StoredUse]) -> Vec<maia_core::credit::EdgeIncrement> {
    let mut presentations = Vec::new();
    for (index, row) in stored.iter().enumerate() {
        let Some(memory) = memory_ref(&row.kind, &row.id) else {
            continue;
        };
        let accepted = row.weight > 0.0;
        presentations.push(maia_core::credit::Presentation {
            id: maia_core::agents::PresentationId(u64::try_from(index).unwrap_or(0)),
            memory,
            source: maia_core::credit::UseSource::Reply,
            weight: row.weight,
            acceptance: if accepted {
                maia_core::credit::Acceptance::Accepted
            } else {
                maia_core::credit::Acceptance::Rejected
            },
        });
    }
    maia_core::credit::co_use_updates(&presentations)
}

fn memory_ref(kind: &str, id: &str) -> Option<maia_core::brain::MemoryRef> {
    match kind {
        "claim" => Some(maia_core::brain::MemoryRef::Claim(
            maia_core::brain::ClaimId::new(id),
        )),
        "fact" => Some(maia_core::brain::MemoryRef::Fact(
            maia_core::brain::FactId::new(id),
        )),
        _ => None,
    }
}

fn endpoint(memory: &maia_core::brain::MemoryRef) -> (&'static str, String) {
    match memory {
        maia_core::brain::MemoryRef::Claim(id) => ("claim", id.as_str().to_owned()),
        maia_core::brain::MemoryRef::Fact(id) => ("fact", id.as_str().to_owned()),
    }
}
