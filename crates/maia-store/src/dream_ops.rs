//! Episode, promotion, consolidation, projection, and FTS operations.

use std::collections::BTreeSet;

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::consolidation_canonical;
use crate::canonical::episode_canonical;
use crate::canonical::promotion_canonical;
use crate::error::StoreError;
use crate::types::CompleteProjection;
use crate::types::ConsolidationWrite;
use crate::types::EntityScope;
use crate::types::EpisodeWrite;
use crate::types::PendingProjection;
use crate::types::PromotionWrite;
use crate::types::ProposalOperation;
use crate::types::TextSearch;

fn immediate(connection: &mut Connection) -> Result<Transaction<'_>, StoreError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StoreError::from)
}

pub(crate) fn insert_episode(
    connection: &mut Connection,
    request: &EpisodeWrite,
) -> Result<(), StoreError> {
    let canonical = episode_canonical(request)?;
    let transaction = immediate(connection)?;
    let existing: Option<String> = transaction
        .query_row(
            "SELECT write_canonical FROM episodes WHERE episode_id = ?1",
            params![request.episode_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(stored) = existing {
        if stored == canonical {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.episode_id.clone(),
        });
    }
    transaction.execute(
        "INSERT INTO episodes (episode_id, thread_id, turn_id, body, taint, reasoning, participants, created_at, write_canonical) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            request.episode_id,
            request.thread_id,
            request.turn_id,
            request.body,
            request.taint.as_str(),
            request.reasoning,
            request.participants,
            request.created_at,
            canonical
        ],
    )?;
    for (index, segment) in request.segments.iter().enumerate() {
        let ordinal = i64::try_from(index).map_err(|_| StoreError::InvalidRequest {
            message: "too many segments".to_owned(),
        })?;
        transaction.execute(
            "INSERT INTO episode_segments (episode_id, ordinal, text, taint, sources) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![request.episode_id, ordinal, segment.text, segment.taint.as_str(), segment.sources],
        )?;
    }
    transaction.execute(
        "INSERT INTO episode_fts (episode_id, body) VALUES (?1, ?2)",
        params![request.episode_id, request.body],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn apply_promotion(
    connection: &mut Connection,
    request: &PromotionWrite,
) -> Result<(), StoreError> {
    let canonical = promotion_canonical(request)?;
    let transaction = immediate(connection)?;
    let stored: Option<Option<String>> = transaction
        .query_row(
            "SELECT promotion_canonical FROM episodes WHERE episode_id = ?1",
            params![request.episode_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(promotion) = stored else {
        return Err(StoreError::NotFound {
            entity: "episode",
            id: request.episode_id.clone(),
        });
    };
    if let Some(existing) = promotion {
        if existing == canonical {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.episode_id.clone(),
        });
    }
    for claim in &request.claims {
        transaction.execute(
            "INSERT INTO claims (claim_id, sentence, episode_id, taint, status, valid_from, consolidated_by) \
             VALUES (?1, ?2, ?3, ?4, 'provisional', ?5, NULL)",
            params![
                claim.claim_id,
                claim.sentence,
                request.episode_id,
                claim.taint.as_str(),
                claim.valid_from
            ],
        )?;
        transaction.execute(
            "INSERT INTO claim_fts (claim_id, sentence) VALUES (?1, ?2)",
            params![claim.claim_id, claim.sentence],
        )?;
        transaction.execute(
            "INSERT INTO edges (edge_kind, from_kind, from_id, to_kind, to_id, weight) \
             VALUES ('mention', 'claim', ?1, 'episode', ?2, 1.0)",
            params![claim.claim_id, request.episode_id],
        )?;
        let mut seen = BTreeSet::new();
        for lexeme in &claim.lexemes {
            if !seen.insert(lexeme.clone()) {
                continue;
            }
            transaction.execute(
                "INSERT OR IGNORE INTO lexemes (lexeme_id) VALUES (?1)",
                params![lexeme],
            )?;
            transaction.execute(
                "INSERT INTO edges (edge_kind, from_kind, from_id, to_kind, to_id, weight) \
                 VALUES ('lexeme', 'claim', ?1, 'lexeme', ?2, 1.0)",
                params![claim.claim_id, lexeme],
            )?;
        }
    }
    let updated = transaction.execute(
        "UPDATE episodes SET promoted_at = ?1, promoted_model = ?2, promotion_canonical = ?3 WHERE episode_id = ?4",
        params![request.now, request.model, canonical, request.episode_id],
    )?;
    if updated != 1 {
        return Err(StoreError::NotFound {
            entity: "episode",
            id: request.episode_id.clone(),
        });
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn apply_consolidation(
    connection: &mut Connection,
    request: &ConsolidationWrite,
) -> Result<(), StoreError> {
    let canonical = consolidation_canonical(request)?;
    let transaction = immediate(connection)?;
    let existing: Option<String> = transaction
        .query_row(
            "SELECT canonical FROM consolidation_batches WHERE batch_id = ?1",
            params![request.batch_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(stored) = existing {
        if stored == canonical {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.batch_id.clone(),
        });
    }
    transaction.execute(
        "INSERT INTO consolidation_batches (batch_id, canonical, context_taint, model, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            request.batch_id,
            canonical,
            request.context_taint.as_str(),
            request.model,
            request.now
        ],
    )?;
    for entity in &request.entities {
        let (scope_kind, scope_agent) = match &entity.scope {
            EntityScope::World => ("world", String::new()),
            EntityScope::Agent { agent_id } => ("agent", agent_id.clone()),
        };
        transaction.execute(
            "INSERT INTO entities (entity_id, slug, description, scope_kind, scope_agent) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![entity.entity_id, entity.slug, entity.description, scope_kind, scope_agent],
        )?;
    }
    for entity in &request.entities {
        for seen in &entity.see {
            transaction.execute(
                "INSERT INTO entity_links (from_entity_id, to_entity_id) VALUES (?1, ?2)",
                params![entity.entity_id, seen],
            )?;
        }
    }
    for fact in &request.facts {
        transaction.execute(
            "INSERT INTO facts (fact_id, sentence, entity_id, taint, sources, valid_from) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                fact.fact_id,
                fact.sentence,
                fact.entity_id,
                request.context_taint.as_str(),
                fact.sources,
                fact.valid_from
            ],
        )?;
        for claim_id in &fact.claim_ids {
            transaction.execute(
                "INSERT INTO fact_claims (fact_id, claim_id) VALUES (?1, ?2)",
                params![fact.fact_id, claim_id],
            )?;
        }
        for episode_id in &fact.episode_ids {
            transaction.execute(
                "INSERT INTO fact_episodes (fact_id, episode_id) VALUES (?1, ?2)",
                params![fact.fact_id, episode_id],
            )?;
            transaction.execute(
                "INSERT INTO edges (edge_kind, from_kind, from_id, to_kind, to_id, weight) \
                 VALUES ('mention', 'fact', ?1, 'episode', ?2, 1.0)",
                params![fact.fact_id, episode_id],
            )?;
        }
    }
    for row in &request.supersede {
        let updated = transaction.execute(
            "UPDATE claims SET status = 'superseded', consolidated_by = ?1 \
             WHERE claim_id = ?2 AND status = 'provisional'",
            params![row.fact_id, row.claim_id],
        )?;
        if updated != 1 {
            return Err(StoreError::NotFound {
                entity: "claim",
                id: row.claim_id.clone(),
            });
        }
    }
    for row in &request.merges {
        let updated = transaction.execute(
            "UPDATE facts SET merged_into = ?1 WHERE fact_id = ?2",
            params![row.canonical_fact_id, row.duplicate_fact_id],
        )?;
        if updated != 1 {
            return Err(StoreError::NotFound {
                entity: "fact",
                id: row.duplicate_fact_id.clone(),
            });
        }
    }
    for row in &request.closures {
        let updated = transaction.execute(
            "UPDATE facts SET valid_to = ?1, replacement_fact_id = ?2 WHERE fact_id = ?3",
            params![row.valid_to, row.replacement_fact_id, row.fact_id],
        )?;
        if updated != 1 {
            return Err(StoreError::NotFound {
                entity: "fact",
                id: row.fact_id.clone(),
            });
        }
    }
    for row in &request.dismissals {
        transaction.execute(
            "INSERT INTO dismissals (batch_id, existing_fact_id, episode_id, subject_key, reason) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                request.batch_id,
                row.existing_fact_id,
                row.episode_id,
                row.subject_key,
                row.reason
            ],
        )?;
    }
    for proposal in &request.proposals {
        let (operation_kind, left_id, right_id) = match &proposal.operation {
            ProposalOperation::Merge {
                duplicate_fact_id,
                canonical_fact_id,
            } => (
                "merge",
                duplicate_fact_id.as_str(),
                canonical_fact_id.as_str(),
            ),
            ProposalOperation::Close {
                fact_id,
                replacement_fact_id,
            } => ("close", fact_id.as_str(), replacement_fact_id.as_str()),
        };
        transaction.execute(
            "INSERT INTO proposals (proposal_id, batch_id, operation_kind, left_id, right_id, target_fact_id, \
             batch_taint, created_at, decision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')",
            params![
                proposal.proposal_id,
                request.batch_id,
                operation_kind,
                left_id,
                right_id,
                proposal.target_fact_id,
                request.context_taint.as_str(),
                request.now
            ],
        )?;
    }
    for queue_id in &request.consumed_queue_ids {
        let updated = transaction.execute(
            "UPDATE dream_queue SET consumed_at = ?1 WHERE dream_queue_id = ?2 AND consumed_at IS NULL",
            params![request.now, queue_id],
        )?;
        if updated != 1 {
            return Err(StoreError::NotFound {
                entity: "dream_queue",
                id: queue_id.clone(),
            });
        }
    }
    for hold in &request.release_holds {
        let deleted = transaction.execute(
            "DELETE FROM correction_holds WHERE target_kind = ?1 AND target_id = ?2",
            params![hold.kind.as_str(), hold.id],
        )?;
        if deleted != 1 {
            return Err(StoreError::NotFound {
                entity: "correction_hold",
                id: hold.id.clone(),
            });
        }
    }
    transaction.execute(
        "INSERT INTO projections (batch_id, progress, created_at, completed_at) VALUES (?1, 'pending', ?2, NULL)",
        params![request.batch_id, request.now],
    )?;
    for entity_id in &request.projection_entities {
        transaction.execute(
            "INSERT INTO projection_entities (batch_id, entity_id) VALUES (?1, ?2)",
            params![request.batch_id, entity_id],
        )?;
    }
    for folder in &request.projection_folders {
        transaction.execute(
            "INSERT INTO projection_folders (batch_id, folder) VALUES (?1, ?2)",
            params![request.batch_id, folder],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn pending(connection: &Connection) -> Result<Vec<PendingProjection>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT batch_id, created_at FROM projections WHERE progress = 'pending' ORDER BY batch_id",
    )?;
    let mapped = statement.query_map([], |row| {
        let batch_id: String = row.get(0)?;
        let created_at: i64 = row.get(1)?;
        Ok((batch_id, created_at))
    })?;
    let mut heads = Vec::new();
    for row in mapped {
        heads.push(row?);
    }
    drop(statement);
    let mut pending = Vec::new();
    for (batch_id, created_at) in heads {
        pending.push(PendingProjection {
            entities: string_column(
                connection,
                "SELECT entity_id FROM projection_entities WHERE batch_id = ?1 ORDER BY entity_id",
                &batch_id,
            )?,
            folders: string_column(
                connection,
                "SELECT folder FROM projection_folders WHERE batch_id = ?1 ORDER BY folder",
                &batch_id,
            )?,
            batch_id,
            created_at,
        });
    }
    Ok(pending)
}

fn string_column(connection: &Connection, sql: &str, id: &str) -> Result<Vec<String>, StoreError> {
    let mut statement = connection.prepare(sql)?;
    let mapped = statement.query_map(params![id], |row| row.get(0))?;
    let mut values = Vec::new();
    for value in mapped {
        values.push(value?);
    }
    Ok(values)
}

pub(crate) fn complete(
    connection: &mut Connection,
    request: &CompleteProjection,
) -> Result<i64, StoreError> {
    let transaction = immediate(connection)?;
    let stored: Option<(String, Option<i64>)> = transaction
        .query_row(
            "SELECT progress, completed_at FROM projections WHERE batch_id = ?1",
            params![request.batch_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((progress, completed_at)) = stored else {
        return Err(StoreError::NotFound {
            entity: "projection",
            id: request.batch_id.clone(),
        });
    };
    if progress == "complete" {
        let Some(completed_at) = completed_at else {
            return Err(StoreError::InvalidRequest {
                message: "complete projection is missing its completion time".to_owned(),
            });
        };
        transaction.commit()?;
        return Ok(completed_at);
    }
    transaction.execute(
        "UPDATE projections SET progress = 'complete', completed_at = ?1 WHERE batch_id = ?2",
        params![request.completed_at, request.batch_id],
    )?;
    transaction.commit()?;
    Ok(request.completed_at)
}

pub(crate) fn search(
    connection: &Connection,
    kind: TextSearch,
    query: &str,
) -> Result<Vec<String>, StoreError> {
    crate::limits::require_fts_query(query)?;
    let sql = match kind {
        TextSearch::Episode => {
            "SELECT episode_id FROM episode_fts WHERE episode_fts MATCH ?1 ORDER BY episode_id"
        }
        TextSearch::Claim => {
            "SELECT claim_id FROM claim_fts WHERE claim_fts MATCH ?1 ORDER BY claim_id"
        }
    };
    string_column(connection, sql, query)
}
