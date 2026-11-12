//! Episode, promotion, consolidation, projection, and FTS operations.

use std::collections::BTreeSet;
use std::collections::VecDeque;

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::brain_ops;
use crate::canonical::consolidation_canonical;
use crate::canonical::episode_canonical;
use crate::canonical::promotion_canonical;
use crate::canonical::require_text;
use crate::error::StoreError;
use crate::limits::require_fts_query;
use crate::types::BrainEdge;
use crate::types::ClaimTaint;
use crate::types::EntitySlugRow;
use crate::types::BrainMap;
use crate::types::BrainNode;
use crate::types::BrainNodeKind;
use crate::types::CompleteProjection;
use crate::types::ConsolidationWrite;
use crate::types::EntityScope;
use crate::types::EpisodeWrite;
use crate::types::MemoryTaint;
use crate::types::NearestClaimRow;
use crate::types::PendingProjection;
use crate::types::PendingPromotionRow;
use crate::types::PromotionEpisodeRow;
use crate::types::PromotionFailureNote;
use crate::types::PromotionWrite;
use crate::types::ProposalOperation;
use crate::types::SegmentWrite;
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
    crate::auto_link::on_neuron_written(&transaction, "episode", &request.episode_id)?;
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
        crate::memory_cleanup::annotate_new_claim(&transaction, &claim.claim_id, &claim.sentence)?;
    }
    for claim_id in &request.same_claim_ids {
        let found: Option<i64> = transaction
            .query_row(
                "SELECT 1 FROM claims WHERE claim_id = ?1",
                params![claim_id],
                |row| row.get(0),
            )
            .optional()?;
        if found.is_none() {
            return Err(StoreError::NotFound {
                entity: "claim",
                id: claim_id.clone(),
            });
        }
        transaction.execute(
            "INSERT OR IGNORE INTO edges (edge_kind, from_kind, from_id, to_kind, to_id, weight) \
             VALUES ('mention', 'claim', ?1, 'episode', ?2, 1.0)",
            params![claim_id, request.episode_id],
        )?;
    }
    let mut links = request.links.clone();
    links.sort_by(|left, right| {
        left.edge_kind
            .cmp(&right.edge_kind)
            .then_with(|| left.from_claim_id.cmp(&right.from_claim_id))
            .then_with(|| left.to_kind.cmp(&right.to_kind))
            .then_with(|| left.to_id.cmp(&right.to_id))
    });
    for link in &links {
        if !request
            .claims
            .iter()
            .any(|claim| claim.claim_id == link.from_claim_id)
        {
            return Err(StoreError::InvalidRequest {
                message: "promotion link must start at a claim in this write".to_owned(),
            });
        }
        let weight = f64::from(link.weight_millis) / 1000.0;
        match (link.edge_kind.as_str(), link.to_kind.as_str()) {
            ("relatedness", "claim") => {
                let status: Option<String> = transaction
                    .query_row(
                        "SELECT status FROM claims WHERE claim_id = ?1",
                        params![link.to_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match status.as_deref() {
                    Some("provisional") => {}
                    Some(_) => continue,
                    None => {
                        return Err(StoreError::NotFound {
                            entity: "claim",
                            id: link.to_id.clone(),
                        });
                    }
                }
            }
            ("entity", "entity") => {
                let found: Option<i64> = transaction
                    .query_row(
                        "SELECT 1 FROM entities WHERE entity_id = ?1",
                        params![link.to_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if found.is_none() {
                    return Err(StoreError::NotFound {
                        entity: "entity",
                        id: link.to_id.clone(),
                    });
                }
            }
            _ => {
                return Err(StoreError::InvalidRequest {
                    message: "promotion link kind is not relatedness or entity".to_owned(),
                });
            }
        }
        transaction.execute(
            "INSERT INTO edges (edge_kind, from_kind, from_id, to_kind, to_id, weight) \
             VALUES (?1, 'claim', ?2, ?3, ?4, ?5) \
             ON CONFLICT (edge_kind, from_kind, from_id, to_kind, to_id) \
             DO UPDATE SET weight = excluded.weight",
            params![link.edge_kind, link.from_claim_id, link.to_kind, link.to_id, weight],
        )?;
    }
    for replacement in &request.replacements {
        let updated = transaction.execute(
            "UPDATE claims SET status = 'superseded', replaced_by = ?1 \
             WHERE claim_id = ?2 AND status = 'provisional'",
            params![replacement.new_claim_id, replacement.old_claim_id],
        )?;
        if updated != 1 {
            return Err(StoreError::NotFound {
                entity: "claim",
                id: replacement.old_claim_id.clone(),
            });
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
    crate::auto_link::on_neuron_written(&transaction, "episode", &request.episode_id)?;
    for claim in &request.claims {
        crate::auto_link::on_neuron_written(&transaction, "claim", &claim.claim_id)?;
    }
    transaction.commit()?;
    Ok(())
}

type EpisodeIdentityRow = (String, String, String, String, Option<String>, String, i64);

pub(crate) fn promotion_episode(
    connection: &Connection,
    episode_id: &str,
) -> Result<PromotionEpisodeRow, StoreError> {
    require_text("episode_id", episode_id)?;
    let row: Option<EpisodeIdentityRow> = connection
        .query_row(
            "SELECT episode_id, thread_id, body, taint, reasoning, participants, created_at \
             FROM episodes WHERE episode_id = ?1",
            params![episode_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((episode_id, thread_id, body, taint, reasoning, participants, created_at)) = row
    else {
        return Err(StoreError::NotFound {
            entity: "episode",
            id: episode_id.to_owned(),
        });
    };
    let mut statement = connection.prepare(
        "SELECT text, taint, sources FROM episode_segments \
         WHERE episode_id = ?1 ORDER BY ordinal ASC",
    )?;
    let mapped = statement.query_map(params![episode_id], |row| {
        Ok(SegmentWrite {
            text: row.get(0)?,
            taint: match row.get::<_, String>(1)?.as_str() {
                "untrusted" => MemoryTaint::Untrusted,
                _ => MemoryTaint::Trusted,
            },
            sources: row.get(2)?,
        })
    })?;
    let mut segments = Vec::new();
    for segment in mapped {
        segments.push(segment?);
    }
    Ok(PromotionEpisodeRow {
        episode_id,
        thread_id,
        body,
        taint: match taint.as_str() {
            "untrusted" => MemoryTaint::Untrusted,
            _ => MemoryTaint::Trusted,
        },
        reasoning,
        participants,
        created_at,
        segments,
    })
}

pub(crate) fn pending_promotions(
    connection: &Connection,
) -> Result<Vec<PendingPromotionRow>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT episode_id, created_at, promotion_failures FROM episodes \
         WHERE promoted_at IS NULL AND promotion_quarantined = 0 \
         ORDER BY created_at ASC, episode_id ASC",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok(PendingPromotionRow {
            episode_id: row.get(0)?,
            created_at: row.get(1)?,
            promotion_failures: row.get(2)?,
        })
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    Ok(rows)
}

pub(crate) fn note_promotion_failure(
    connection: &mut Connection,
    episode_id: &str,
    limit: i64,
) -> Result<PromotionFailureNote, StoreError> {
    require_text("episode_id", episode_id)?;
    if limit < 1 {
        return Err(StoreError::InvalidRequest {
            message: "promotion failure limit must be at least 1".to_owned(),
        });
    }
    let transaction = immediate(connection)?;
    let existing: Option<(Option<i64>, i64, i64)> = transaction
        .query_row(
            "SELECT promoted_at, promotion_failures, promotion_quarantined \
             FROM episodes WHERE episode_id = ?1",
            params![episode_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((promoted_at, failures, quarantined)) = existing else {
        return Err(StoreError::NotFound {
            entity: "episode",
            id: episode_id.to_owned(),
        });
    };
    if promoted_at.is_some() {
        return Err(StoreError::InvalidRequest {
            message: "promoted episode cannot record a promotion failure".to_owned(),
        });
    }
    let failures = failures + 1;
    let quarantined = if quarantined == 1 || failures >= limit {
        1
    } else {
        0
    };
    let updated = transaction.execute(
        "UPDATE episodes SET promotion_failures = ?1, promotion_quarantined = ?2 \
         WHERE episode_id = ?3",
        params![failures, quarantined, episode_id],
    )?;
    if updated != 1 {
        return Err(StoreError::NotFound {
            entity: "episode",
            id: episode_id.to_owned(),
        });
    }
    transaction.commit()?;
    Ok(PromotionFailureNote {
        failures,
        quarantined: quarantined == 1,
    })
}

pub(crate) fn mark_promotion_skipped(
    connection: &mut Connection,
    episode_id: &str,
    now: i64,
    model: &str,
) -> Result<(), StoreError> {
    require_text("episode_id", episode_id)?;
    require_text("model", model)?;
    let transaction = immediate(connection)?;
    let stored: Option<(Option<i64>, Option<String>)> = transaction
        .query_row(
            "SELECT promoted_at, promotion_canonical FROM episodes WHERE episode_id = ?1",
            params![episode_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((promoted_at, canonical)) = stored else {
        return Err(StoreError::NotFound {
            entity: "episode",
            id: episode_id.to_owned(),
        });
    };
    let skip_canonical = format!("skip {episode_id} {model} {now}\n");
    if promoted_at.is_some() {
        if canonical.as_deref() == Some(skip_canonical.as_str()) {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: episode_id.to_owned(),
        });
    }
    let updated = transaction.execute(
        "UPDATE episodes SET promoted_at = ?1, promoted_model = ?2, promotion_canonical = ?3 \
         WHERE episode_id = ?4",
        params![now, model, skip_canonical, episode_id],
    )?;
    if updated != 1 {
        return Err(StoreError::NotFound {
            entity: "episode",
            id: episode_id.to_owned(),
        });
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn nearest_claims(
    connection: &Connection,
    query_text: &str,
    limit: i64,
) -> Result<Vec<NearestClaimRow>, StoreError> {
    require_fts_query(query_text)?;
    if limit < 1 {
        return Err(StoreError::InvalidRequest {
            message: "nearest claims limit must be at least 1".to_owned(),
        });
    }
    let mut statement = connection.prepare(
        "SELECT claims.claim_id, claims.sentence FROM claim_fts \
         JOIN claims ON claims.claim_id = claim_fts.claim_id \
         WHERE claim_fts MATCH ?1 \
           AND claims.status = 'provisional' \
           AND claims.consolidated_by IS NULL \
           AND claims.hidden_reason IS NULL \
         ORDER BY bm25(claim_fts) ASC, claims.claim_id ASC \
         LIMIT ?2",
    )?;
    let mapped = statement.query_map(params![query_text, limit], |row| {
        Ok(NearestClaimRow {
            claim_id: row.get(0)?,
            sentence: row.get(1)?,
        })
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    Ok(rows)
}

fn deleted_neurons(connection: &Connection) -> Result<BTreeSet<(String, String)>, StoreError> {
    let mut statement = connection
        .prepare("SELECT kind, neuron_id FROM neuron_text WHERE deleted_at IS NOT NULL")?;
    let mapped = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let mut ids = BTreeSet::new();
    for id in mapped {
        ids.insert(id?);
    }
    Ok(ids)
}

fn closed_claim_ids(connection: &Connection) -> Result<BTreeSet<String>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT claim_id FROM claims \
         WHERE status != 'provisional' OR consolidated_by IS NOT NULL",
    )?;
    let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut ids = BTreeSet::new();
    for id in mapped {
        ids.insert(id?);
    }
    Ok(ids)
}

pub(crate) fn claim_rows(
    connection: &Connection,
    ids: &[String],
) -> Result<Vec<NearestClaimRow>, StoreError> {
    let mut rows = Vec::new();
    for id in ids {
        require_text("claim_id", id)?;
        let row: Option<NearestClaimRow> = connection
            .query_row(
                "SELECT claim_id, sentence FROM claims WHERE claim_id = ?1",
                params![id],
                |row| {
                    Ok(NearestClaimRow {
                        claim_id: row.get(0)?,
                        sentence: row.get(1)?,
                    })
                },
            )
            .optional()?;
        if let Some(row) = row {
            rows.push(row);
        }
    }
    rows.sort_by(|left, right| left.claim_id.cmp(&right.claim_id));
    Ok(rows)
}

pub(crate) fn recall_subgraph(
    connection: &Connection,
    seed_claim_ids: &[String],
    seed_fact_ids: &[String],
    seed_lexeme_ids: &[String],
    hops: i64,
) -> Result<BrainMap, StoreError> {
    if hops < 0 {
        return Err(StoreError::InvalidRequest {
            message: "recall subgraph hops must be non-negative".to_owned(),
        });
    }
    for id in seed_claim_ids {
        require_text("seed_claim_id", id)?;
    }
    for id in seed_fact_ids {
        require_text("seed_fact_id", id)?;
    }
    for id in seed_lexeme_ids {
        require_text("seed_lexeme_id", id)?;
    }
    let closed = closed_claim_ids(connection)?;
    let deleted = deleted_neurons(connection)?;
    let full = brain_ops::map(connection)?;
    let mut selected: BTreeSet<(String, String)> = BTreeSet::new();
    let mut frontier: VecDeque<(String, String, i64)> = VecDeque::new();
    for id in seed_claim_ids {
        if closed.contains(id) || deleted.contains(&("claim".to_owned(), id.clone())) {
            continue;
        }
        if full
            .nodes
            .iter()
            .any(|node| node.kind == BrainNodeKind::Claim && node.id == *id)
        {
            selected.insert(("claim".to_owned(), id.clone()));
            frontier.push_back(("claim".to_owned(), id.clone(), 0));
        }
    }
    for id in seed_fact_ids {
        if deleted.contains(&("fact".to_owned(), id.clone())) {
            continue;
        }
        if full
            .nodes
            .iter()
            .any(|node| node.kind == BrainNodeKind::Fact && node.id == *id)
        {
            selected.insert(("fact".to_owned(), id.clone()));
            frontier.push_back(("fact".to_owned(), id.clone(), 0));
        }
    }
    for id in seed_lexeme_ids {
        if full
            .nodes
            .iter()
            .any(|node| node.kind == BrainNodeKind::Lexeme && node.id == *id)
        {
            selected.insert(("lexeme".to_owned(), id.clone()));
            frontier.push_back(("lexeme".to_owned(), id.clone(), 0));
        }
    }
    while let Some((kind, id, depth)) = frontier.pop_front() {
        if depth >= hops {
            continue;
        }
        for edge in &full.edges {
            let next = if edge.from_kind == kind && edge.from_id == id {
                Some((edge.to_kind.clone(), edge.to_id.clone()))
            } else if edge.to_kind == kind && edge.to_id == id {
                Some((edge.from_kind.clone(), edge.from_id.clone()))
            } else {
                None
            };
            let Some((next_kind, next_id)) = next else {
                continue;
            };
            if next_kind == "claim" && closed.contains(&next_id) {
                continue;
            }
            if deleted.contains(&(next_kind.clone(), next_id.clone())) {
                continue;
            }
            if selected.insert((next_kind.clone(), next_id.clone())) {
                frontier.push_back((next_kind, next_id, depth + 1));
            }
        }
    }
    let nodes: Vec<BrainNode> = full
        .nodes
        .into_iter()
        .filter(|node| selected.contains(&(node.kind.as_str().to_owned(), node.id.clone())))
        .collect();
    let node_keys: BTreeSet<(String, String)> = nodes
        .iter()
        .map(|node| (node.kind.as_str().to_owned(), node.id.clone()))
        .collect();
    let edges: Vec<BrainEdge> = full
        .edges
        .into_iter()
        .filter(|edge| {
            node_keys.contains(&(edge.from_kind.clone(), edge.from_id.clone()))
                && node_keys.contains(&(edge.to_kind.clone(), edge.to_id.clone()))
        })
        .collect();
    Ok(BrainMap {
        nodes,
        edges,
        tags: Vec::new(),
    })
}

pub(crate) fn bump_promotion_day_stats(
    connection: &mut Connection,
    day_key: &str,
    calls: i64,
    tokens: i64,
) -> Result<(), StoreError> {
    require_text("day_key", day_key)?;
    if calls < 0 || tokens < 0 {
        return Err(StoreError::InvalidRequest {
            message: "promotion day stats increments must be non-negative".to_owned(),
        });
    }
    let transaction = immediate(connection)?;
    transaction.execute(
        "INSERT INTO promotion_day_stats (day_key, calls, tokens) VALUES (?1, ?2, ?3) \
         ON CONFLICT(day_key) DO UPDATE SET \
         calls = calls + excluded.calls, tokens = tokens + excluded.tokens",
        params![day_key, calls, tokens],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn promotion_day_stats(
    connection: &Connection,
    day_key: &str,
) -> Result<(i64, i64), StoreError> {
    require_text("day_key", day_key)?;
    let row: Option<(i64, i64)> = connection
        .query_row(
            "SELECT calls, tokens FROM promotion_day_stats WHERE day_key = ?1",
            params![day_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.unwrap_or((0, 0)))
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
    for fact in &request.facts {
        crate::auto_link::on_neuron_written(&transaction, "fact", &fact.fact_id)?;
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

pub(crate) fn claim_taints(
    connection: &Connection,
    ids: &[String],
) -> Result<Vec<ClaimTaint>, StoreError> {
    let mut rows = Vec::new();
    for id in ids {
        require_text("claim_id", id)?;
        let taint: Option<String> = connection
            .query_row(
                "SELECT taint FROM claims WHERE claim_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(taint) = taint else {
            continue;
        };
        rows.push(ClaimTaint {
            claim_id: id.clone(),
            taint: match taint.as_str() {
                "trusted" => MemoryTaint::Trusted,
                _ => MemoryTaint::Untrusted,
            },
        });
    }
    Ok(rows)
}

pub(crate) fn entity_slugs(connection: &Connection) -> Result<Vec<EntitySlugRow>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT entity_id, slug FROM entities ORDER BY entity_id",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok(EntitySlugRow {
            entity_id: row.get(0)?,
            slug: row.get(1)?,
        })
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    Ok(rows)
}
