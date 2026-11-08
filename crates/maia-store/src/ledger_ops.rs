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
