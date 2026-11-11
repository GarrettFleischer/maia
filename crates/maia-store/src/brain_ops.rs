//! Owner brain map, in-place fact revision, and fact deletion.

use std::collections::BTreeSet;

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::require_text;
use crate::error::StoreError;
use crate::limits::MAX_PROSE_BYTES;
use crate::limits::require_bounded;
use crate::types::BrainEdge;
use crate::types::BrainMap;
use crate::types::BrainNode;
use crate::types::BrainNodeKind;
use crate::types::FactRevise;

fn immediate(connection: &mut Connection) -> Result<Transaction<'_>, StoreError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StoreError::from)
}

/// Rejects an empty sentence and any sentence that spans more than one line.
pub(crate) fn validate_fact_sentence(sentence: &str) -> Result<(), StoreError> {
    if sentence.is_empty()
        || sentence.trim().is_empty()
        || sentence.chars().any(|ch| ch == '\n' || ch == '\r')
    {
        return Err(StoreError::InvalidRequest {
            message: "fact sentence must be one non-empty line".to_owned(),
        });
    }
    require_bounded("fact_sentence", sentence.len(), MAX_PROSE_BYTES)
}

pub(crate) fn map(connection: &Connection) -> Result<BrainMap, StoreError> {
    let holds = load_holds(connection)?;
    let mut nodes = Vec::new();
    nodes.extend(load_facts(connection, &holds)?);
    nodes.extend(load_claims(connection, &holds)?);
    nodes.extend(load_episodes(connection, &holds)?);
    nodes.extend(load_lexemes(connection, &holds)?);
    nodes.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.kind.as_str().cmp(right.kind.as_str()))
    });
    Ok(BrainMap {
        nodes,
        edges: load_edges(connection)?,
    })
}

pub(crate) fn revise(
    connection: &mut Connection,
    request: &FactRevise,
) -> Result<BrainMap, StoreError> {
    validate_fact_sentence(&request.sentence)?;
    require_text("fact_id", &request.fact_id)?;
    for lexeme in &request.lexemes {
        require_text("lexeme", lexeme)?;
    }
    let transaction = immediate(connection)?;
    let updated = transaction.execute(
        "UPDATE facts SET sentence = ?1 WHERE fact_id = ?2",
        params![request.sentence, request.fact_id],
    )?;
    if updated != 1 {
        return Err(StoreError::NotFound {
            entity: "fact",
            id: request.fact_id.clone(),
        });
    }
    let claims = claim_ids(&transaction, &request.fact_id)?;
    for claim_id in &claims {
        rewrite_claim(&transaction, claim_id, &request.sentence)?;
        replace_lexeme_edges(&transaction, "claim", claim_id, &request.lexemes)?;
        drop_embedding(&transaction, "claim", claim_id)?;
    }
    replace_lexeme_edges(&transaction, "fact", &request.fact_id, &request.lexemes)?;
    drop_embedding(&transaction, "fact", &request.fact_id)?;
    prune_lexemes(&transaction)?;
    let map = map(&transaction)?;
    transaction.commit()?;
    Ok(map)
}

pub(crate) fn delete(connection: &mut Connection, fact_id: &str) -> Result<BrainMap, StoreError> {
    require_text("fact_id", fact_id)?;
    let transaction = immediate(connection)?;
    let found: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM facts WHERE fact_id = ?1",
            params![fact_id],
            |row| row.get(0),
        )
        .optional()?;
    if found.is_none() {
        return Err(StoreError::NotFound {
            entity: "fact",
            id: fact_id.to_owned(),
        });
    }
    let claims = claim_ids(&transaction, fact_id)?;
    clear_fact_pointers(&transaction, fact_id)?;
    for claim_id in &claims {
        delete_edges(&transaction, "claim", claim_id)?;
        drop_embedding(&transaction, "claim", claim_id)?;
        delete_claim_fts(&transaction, claim_id)?;
        delete_hold(&transaction, "claim", claim_id)?;
        transaction.execute(
            "DELETE FROM fact_claims WHERE claim_id = ?1",
            params![claim_id],
        )?;
    }
    transaction.execute(
        "DELETE FROM fact_claims WHERE fact_id = ?1",
        params![fact_id],
    )?;
    for claim_id in &claims {
        let deleted =
            transaction.execute("DELETE FROM claims WHERE claim_id = ?1", params![claim_id])?;
        if deleted != 1 {
            return Err(StoreError::NotFound {
                entity: "claim",
                id: claim_id.clone(),
            });
        }
    }
    delete_edges(&transaction, "fact", fact_id)?;
    drop_embedding(&transaction, "fact", fact_id)?;
    delete_hold(&transaction, "fact", fact_id)?;
    transaction.execute(
        "DELETE FROM fact_episodes WHERE fact_id = ?1",
        params![fact_id],
    )?;
    let deleted = transaction.execute("DELETE FROM facts WHERE fact_id = ?1", params![fact_id])?;
    if deleted != 1 {
        return Err(StoreError::NotFound {
            entity: "fact",
            id: fact_id.to_owned(),
        });
    }
    prune_lexemes(&transaction)?;
    let map = map(&transaction)?;
    transaction.commit()?;
    Ok(map)
}

fn clear_fact_pointers(connection: &Connection, fact_id: &str) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE facts SET replacement_fact_id = NULL WHERE replacement_fact_id = ?1",
        params![fact_id],
    )?;
    connection.execute(
        "UPDATE facts SET merged_into = NULL WHERE merged_into = ?1",
        params![fact_id],
    )?;
    connection.execute(
        "UPDATE claims SET consolidated_by = NULL WHERE consolidated_by = ?1",
        params![fact_id],
    )?;
    Ok(())
}

fn claim_ids(connection: &Connection, fact_id: &str) -> Result<Vec<String>, StoreError> {
    let mut statement = connection
        .prepare("SELECT claim_id FROM fact_claims WHERE fact_id = ?1 ORDER BY claim_id")?;
    let mapped = statement.query_map(params![fact_id], |row| row.get(0))?;
    let mut ids = Vec::new();
    for id in mapped {
        ids.push(id?);
    }
    Ok(ids)
}

fn rewrite_claim(
    connection: &Connection,
    claim_id: &str,
    sentence: &str,
) -> Result<(), StoreError> {
    let updated = connection.execute(
        "UPDATE claims SET sentence = ?1 WHERE claim_id = ?2",
        params![sentence, claim_id],
    )?;
    if updated != 1 {
        return Err(StoreError::NotFound {
            entity: "claim",
            id: claim_id.to_owned(),
        });
    }
    delete_claim_fts(connection, claim_id)?;
    connection.execute(
        "INSERT INTO claim_fts (claim_id, sentence) VALUES (?1, ?2)",
        params![claim_id, sentence],
    )?;
    Ok(())
}

fn delete_claim_fts(connection: &Connection, claim_id: &str) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM claim_fts WHERE claim_id = ?1",
        params![claim_id],
    )?;
    Ok(())
}

fn replace_lexeme_edges(
    connection: &Connection,
    from_kind: &str,
    from_id: &str,
    lexemes: &[String],
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM edges WHERE edge_kind = 'lexeme' AND from_kind = ?1 AND from_id = ?2",
        params![from_kind, from_id],
    )?;
    let mut seen = BTreeSet::new();
    for lexeme in lexemes {
        if !seen.insert(lexeme.clone()) {
            continue;
        }
        connection.execute(
            "INSERT OR IGNORE INTO lexemes (lexeme_id) VALUES (?1)",
            params![lexeme],
        )?;
        connection.execute(
            "INSERT INTO edges (edge_kind, from_kind, from_id, to_kind, to_id, weight) \
             VALUES ('lexeme', ?1, ?2, 'lexeme', ?3, 1.0)",
            params![from_kind, from_id, lexeme],
        )?;
    }
    Ok(())
}

fn prune_lexemes(connection: &Connection) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM lexemes WHERE lexeme_id NOT IN \
         (SELECT to_id FROM edges WHERE edge_kind = 'lexeme' AND to_kind = 'lexeme')",
        [],
    )?;
    Ok(())
}

fn delete_edges(connection: &Connection, kind: &str, id: &str) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM edges WHERE (from_kind = ?1 AND from_id = ?2) OR (to_kind = ?1 AND to_id = ?2)",
        params![kind, id],
    )?;
    Ok(())
}

fn delete_hold(connection: &Connection, kind: &str, id: &str) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM correction_holds WHERE target_kind = ?1 AND target_id = ?2",
        params![kind, id],
    )?;
    Ok(())
}

fn drop_embedding(connection: &Connection, kind: &str, id: &str) -> Result<(), StoreError> {
    let rowid: Option<i64> = connection
        .query_row(
            "SELECT vec_rowid FROM embedding_rows WHERE target_kind = ?1 AND target_id = ?2",
            params![kind, id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(rowid) = rowid else {
        return Ok(());
    };
    let sql = match kind {
        "claim" => "DELETE FROM claim_vec WHERE rowid = ?1",
        "fact" => "DELETE FROM fact_vec WHERE rowid = ?1",
        "episode" => "DELETE FROM episode_vec WHERE rowid = ?1",
        _ => {
            return Err(StoreError::InvalidRequest {
                message: "unknown embedding kind".to_owned(),
            });
        }
    };
    connection.execute(sql, params![rowid])?;
    connection.execute(
        "DELETE FROM embedding_rows WHERE target_kind = ?1 AND target_id = ?2",
        params![kind, id],
    )?;
    Ok(())
}

fn load_holds(connection: &Connection) -> Result<BTreeSet<(String, String)>, StoreError> {
    let mut statement =
        connection.prepare("SELECT target_kind, target_id FROM correction_holds")?;
    let mapped = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let mut holds = BTreeSet::new();
    for hold in mapped {
        holds.insert(hold?);
    }
    Ok(holds)
}

fn is_held(holds: &BTreeSet<(String, String)>, kind: &str, id: &str) -> bool {
    holds
        .iter()
        .any(|(held_kind, held_id)| held_kind == kind && held_id == id)
}

fn known_taint(value: String) -> Result<String, StoreError> {
    match value.as_str() {
        "trusted" | "untrusted" => Ok(value),
        _ => Err(StoreError::InvalidRequest {
            message: "stored taint is invalid".to_owned(),
        }),
    }
}

fn prose_node(
    id: String,
    kind: BrainNodeKind,
    text: String,
    taint: String,
    session_id: Option<String>,
    held: bool,
) -> Result<BrainNode, StoreError> {
    Ok(BrainNode {
        id,
        kind,
        label: text.clone(),
        sentence: Some(text),
        taint: Some(known_taint(taint)?),
        session_id,
        held,
    })
}

fn load_facts(
    connection: &Connection,
    holds: &BTreeSet<(String, String)>,
) -> Result<Vec<BrainNode>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT fact_id, sentence, taint, \
         (SELECT MIN(episodes.thread_id) FROM fact_episodes \
          JOIN episodes ON episodes.episode_id = fact_episodes.episode_id \
          WHERE fact_episodes.fact_id = facts.fact_id) \
         FROM facts ORDER BY fact_id",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    let mut nodes = Vec::new();
    for row in mapped {
        let (id, sentence, taint, session_id): (String, String, String, Option<String>) = row?;
        let held = is_held(holds, "fact", &id);
        nodes.push(prose_node(
            id,
            BrainNodeKind::Fact,
            sentence,
            taint,
            session_id,
            held,
        )?);
    }
    Ok(nodes)
}

fn load_claims(
    connection: &Connection,
    holds: &BTreeSet<(String, String)>,
) -> Result<Vec<BrainNode>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT claims.claim_id, claims.sentence, claims.taint, episodes.thread_id \
         FROM claims JOIN episodes ON episodes.episode_id = claims.episode_id \
         ORDER BY claims.claim_id",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    let mut nodes = Vec::new();
    for row in mapped {
        let (id, sentence, taint, session_id): (String, String, String, String) = row?;
        let held = is_held(holds, "claim", &id);
        nodes.push(prose_node(
            id,
            BrainNodeKind::Claim,
            sentence,
            taint,
            Some(session_id),
            held,
        )?);
    }
    Ok(nodes)
}

fn load_episodes(
    connection: &Connection,
    holds: &BTreeSet<(String, String)>,
) -> Result<Vec<BrainNode>, StoreError> {
    let mut statement = connection
        .prepare("SELECT episode_id, body, taint, thread_id FROM episodes ORDER BY episode_id")?;
    let mapped = statement.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    let mut nodes = Vec::new();
    for row in mapped {
        let (id, body, taint, session_id): (String, String, String, String) = row?;
        let held = is_held(holds, "episode", &id);
        nodes.push(prose_node(
            id,
            BrainNodeKind::Episode,
            body,
            taint,
            Some(session_id),
            held,
        )?);
    }
    Ok(nodes)
}

fn load_lexemes(
    connection: &Connection,
    holds: &BTreeSet<(String, String)>,
) -> Result<Vec<BrainNode>, StoreError> {
    let mut statement = connection.prepare("SELECT lexeme_id FROM lexemes ORDER BY lexeme_id")?;
    let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut nodes = Vec::new();
    for id in mapped {
        let id = id?;
        nodes.push(BrainNode {
            held: is_held(holds, "lexeme", &id),
            label: id.clone(),
            id,
            kind: BrainNodeKind::Lexeme,
            sentence: None,
            taint: None,
            session_id: None,
        });
    }
    Ok(nodes)
}

fn load_edges(connection: &Connection) -> Result<Vec<BrainEdge>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT edge_kind, from_kind, from_id, to_kind, to_id, weight FROM edges \
         ORDER BY edge_kind, from_kind, from_id, to_kind, to_id",
    )?;
    let mapped = statement.query_map([], |row| {
        let weight: f64 = row.get(5)?;
        Ok(BrainEdge {
            kind: row.get(0)?,
            from_kind: row.get(1)?,
            from_id: row.get(2)?,
            to_kind: row.get(3)?,
            to_id: row.get(4)?,
            weight_millis: weight_millis(weight),
        })
    })?;
    let mut edges = Vec::new();
    for edge in mapped {
        edges.push(edge?);
    }
    Ok(edges)
}

fn weight_millis(weight: f64) -> i64 {
    if !weight.is_finite() {
        return 0;
    }
    let scaled = (weight * 1000.0).round();
    if !(0.0..=1_000_000.0).contains(&scaled) {
        return 0;
    }
    scaled as i64
}
