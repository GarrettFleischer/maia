//! One-time cleanup of existing brain rows, plus claim and plan edits.
//!
//! Junk is marked hidden. Rows are not deleted.

use maia_core::dream::episode_record;
use maia_core::dream::extract_entities;
use maia_core::dream::judge_claim;
use maia_core::dream::categorize;
use maia_core::dream::subject_name;
use maia_core::dream::ClaimJudgment;
use rusqlite::params;
use rusqlite::Connection;
use rusqlite::OptionalExtension;

use crate::error::StoreError;

/// Hides junk memory, backfills entities, and rebuilds auto-links.
pub(crate) fn cleanup(connection: &Connection) -> Result<(), StoreError> {
    hide_junk_claims(connection)?;
    clean_episodes(connection)?;
    backfill_kept_claims(connection)?;
    crate::auto_link::relink_all(connection)?;
    Ok(())
}

/// Replaces a claim sentence and marks the edit as the owner's.
pub(crate) fn edit_claim(connection: &Connection, claim_id: &str, sentence: &str) -> Result<(), StoreError> {
    let updated = connection.execute(
        "UPDATE claims SET sentence = ?1, owner_edited = 1, category = ?2, subject = ?3, \
         confidence_millis = 1000, hidden_reason = NULL WHERE claim_id = ?4",
        params![sentence, categorize(sentence).as_str(), subject_name(sentence), claim_id],
    )?;
    if updated != 1 {
        return Err(StoreError::NotFound {
            entity: "claim",
            id: claim_id.to_owned(),
        });
    }
    link_sentence(connection, claim_id, sentence)?;
    Ok(())
}

/// Hides a claim without deleting it.
pub(crate) fn forget_claim(connection: &Connection, claim_id: &str) -> Result<(), StoreError> {
    let updated = connection.execute(
        "UPDATE claims SET hidden_reason = 'owner withdrew' WHERE claim_id = ?1",
        params![claim_id],
    )?;
    if updated != 1 {
        return Err(StoreError::NotFound {
            entity: "claim",
            id: claim_id.to_owned(),
        });
    }
    Ok(())
}

/// Shows a hidden claim again.
pub(crate) fn restore_claim(connection: &Connection, claim_id: &str) -> Result<(), StoreError> {
    let updated = connection.execute(
        "UPDATE claims SET hidden_reason = NULL WHERE claim_id = ?1",
        params![claim_id],
    )?;
    if updated != 1 {
        return Err(StoreError::NotFound {
            entity: "claim",
            id: claim_id.to_owned(),
        });
    }
    Ok(())
}

/// Points every edge from `loser` at `winner`, then removes `loser`.
pub(crate) fn merge_entities(connection: &Connection, winner: &str, loser: &str) -> Result<(), StoreError> {
    if winner == loser || winner.is_empty() || loser.is_empty() {
        return Err(StoreError::InvalidRequest {
            message: "merge needs two different entities".to_owned(),
        });
    }
    let winner_found: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM entities WHERE entity_id = ?1",
            params![winner],
            |row| row.get(0),
        )
        .optional()?;
    let loser_found: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM entities WHERE entity_id = ?1",
            params![loser],
            |row| row.get(0),
        )
        .optional()?;
    if winner_found.is_none() || loser_found.is_none() {
        return Err(StoreError::NotFound {
            entity: "entity",
            id: if winner_found.is_none() { winner } else { loser }.to_owned(),
        });
    }
    retarget_edges(connection, loser, winner)?;
    connection.execute("DELETE FROM entity_links WHERE from_entity_id = ?1 OR to_entity_id = ?1", params![loser])?;
    connection.execute("DELETE FROM entities WHERE entity_id = ?1", params![loser])?;
    Ok(())
}

/// Stores the goal contract and working list for one task.
pub(crate) fn put_task_plan(
    connection: &Connection,
    task_id: &str,
    goal_json: &str,
    todo_json: &str,
    handoff_count: i64,
    handoff_of: Option<&str>,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO task_plans (task_id, goal_json, todo_json, handoff_count, handoff_of) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(task_id) DO UPDATE SET goal_json = excluded.goal_json, \
         todo_json = excluded.todo_json, handoff_count = excluded.handoff_count, \
         handoff_of = excluded.handoff_of",
        params![task_id, goal_json, todo_json, handoff_count, handoff_of],
    )?;
    Ok(())
}

/// Goal JSON, todo JSON, handoff count, and the previous task id.
pub(crate) fn task_plan(connection: &Connection, task_id: &str) -> Result<Option<(String, String, i64, Option<String>)>, StoreError> {
    connection
        .query_row(
            "SELECT goal_json, todo_json, handoff_count, handoff_of FROM task_plans WHERE task_id = ?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(StoreError::from)
}

/// Pending inbox rows, oldest first: operation id, message id, text.
pub(crate) fn pending_submissions(connection: &Connection) -> Result<Vec<(String, String, String)>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT s.operation_id, s.message_id, s.text FROM message_submissions s \
         JOIN router_messages owner ON owner.message_id = s.message_id \
         WHERE s.state = 'pending' \
         AND NOT EXISTS ( \
           SELECT 1 FROM router_messages later WHERE later.ordinal > owner.ordinal \
         ) \
         AND NOT EXISTS ( \
           SELECT 1 FROM task_inputs i WHERE i.message_id = s.message_id \
         ) \
         ORDER BY s.created_at, s.operation_id",
    )?;
    let mapped = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    Ok(rows)
}

/// Whether the owner edited this claim.
pub(crate) fn hide_episode(connection: &Connection, episode_id: &str, reason: &str) -> Result<(), StoreError> {
    connection
        .execute(
            "UPDATE episodes SET hidden_reason = ?2 WHERE episode_id = ?1",
            params![episode_id, reason],
        )
        .map_err(StoreError::from)?;
    Ok(())
}

pub(crate) fn claim_owner_edited(connection: &Connection, claim_id: &str) -> Result<bool, StoreError> {
    let edited: Option<i64> = connection
        .query_row(
            "SELECT owner_edited FROM claims WHERE claim_id = ?1",
            params![claim_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(edited.unwrap_or(0) != 0)
}

fn hide_junk_claims(connection: &Connection) -> Result<(), StoreError> {
    let mut statement = connection.prepare(
        "SELECT claim_id, sentence FROM claims WHERE hidden_reason IS NULL AND status = 'provisional'",
    )?;
    let mapped = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut junk = Vec::new();
    for row in mapped {
        let (id, sentence) = row?;
        if judge_claim(&sentence) == ClaimJudgment::Reject {
            junk.push(id);
        }
    }
    drop(statement);
    for id in junk {
        connection.execute(
            "UPDATE claims SET hidden_reason = 'not a durable fact' WHERE claim_id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

fn clean_episodes(connection: &Connection) -> Result<(), StoreError> {
    let mut statement = connection.prepare("SELECT episode_id, body FROM episodes")?;
    let mapped = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut updates = Vec::new();
    for row in mapped {
        let (id, body) = row?;
        let (owner, reply) = split_episode(&body);
        let (next, hide) = episode_record(&owner, &reply);
        updates.push((id, next, hide.map(str::to_owned)));
    }
    drop(statement);
    for (id, body, hide) in updates {
        connection.execute(
            "UPDATE episodes SET body = ?1, reasoning = NULL, hidden_reason = ?2 WHERE episode_id = ?3",
            params![body, hide, id],
        )?;
    }
    Ok(())
}

fn backfill_kept_claims(connection: &Connection) -> Result<(), StoreError> {
    let mut statement = connection.prepare(
        "SELECT claim_id, sentence FROM claims WHERE hidden_reason IS NULL AND status = 'provisional'",
    )?;
    let mapped = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut kept = Vec::new();
    for row in mapped {
        kept.push(row?);
    }
    drop(statement);
    for (id, sentence) in kept {
        if judge_claim(&sentence) != ClaimJudgment::Keep {
            continue;
        }
        let category = categorize(&sentence);
        connection.execute(
            "UPDATE claims SET category = ?1, subject = ?2 WHERE claim_id = ?3 AND owner_edited = 0",
            params![category.as_str(), subject_name(&sentence), id],
        )?;
        link_sentence(connection, &id, &sentence)?;
    }
    Ok(())
}

pub(crate) fn annotate_new_claim(connection: &Connection, claim_id: &str, sentence: &str) -> Result<(), StoreError> {
    if judge_claim(sentence) != ClaimJudgment::Keep {
        return Ok(());
    }
    let category = categorize(sentence);
    connection.execute(
        "UPDATE claims SET category = ?1, subject = ?2, confidence_millis = 550 \
         WHERE claim_id = ?3 AND owner_edited = 0",
        params![category.as_str(), subject_name(sentence), claim_id],
    )?;
    link_sentence(connection, claim_id, sentence)
}

fn link_sentence(connection: &Connection, claim_id: &str, sentence: &str) -> Result<(), StoreError> {
    let category = categorize(sentence);
    for entity in extract_entities(sentence) {
        let id = ensure_entity(connection, &entity.name, entity.kind)?;
        insert_edge(connection, category.edge_kind(), claim_id, &id)?;
    }
    let subject = subject_name(sentence);
    let subject_id = ensure_entity(connection, &subject, "person")?;
    insert_edge(connection, category.edge_kind(), claim_id, &subject_id)?;
    Ok(())
}

fn ensure_entity(connection: &Connection, name: &str, kind: &str) -> Result<String, StoreError> {
    let slug = slug_for(name);
    let id = format!("entity-{slug}");
    let existing: Option<String> = connection
        .query_row(
            "SELECT entity_id FROM entities WHERE scope_kind = 'world' AND scope_agent = '' AND slug = ?1",
            params![slug],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        connection.execute(
            "UPDATE entities SET kind = ?1 WHERE entity_id = ?2 AND kind = 'other'",
            params![kind, existing],
        )?;
        return Ok(existing);
    }
    connection.execute(
        "INSERT INTO entities (entity_id, slug, description, scope_kind, scope_agent, kind) \
         VALUES (?1, ?2, ?3, 'world', '', ?4)",
        params![id, slug, name, kind],
    )?;
    Ok(id)
}

fn insert_edge(connection: &Connection, kind: &str, claim_id: &str, entity_id: &str) -> Result<(), StoreError> {
    connection.execute(
        "INSERT OR IGNORE INTO edges \
         (edge_kind, from_kind, from_id, to_kind, to_id, weight, source_tag, taint, span_start, span_end) \
         VALUES (?1, 'claim', ?2, 'entity', ?3, 1.0, 'memory', 'trusted', 0, 0)",
        params![kind, claim_id, entity_id],
    )?;
    Ok(())
}

fn retarget_edges(connection: &Connection, loser: &str, winner: &str) -> Result<(), StoreError> {
    let mut statement = connection.prepare(
        "SELECT edge_kind, from_kind, from_id, to_kind, to_id, weight, source_tag, taint, span_start, span_end \
         FROM edges WHERE (from_kind = 'entity' AND from_id = ?1) OR (to_kind = 'entity' AND to_id = ?1)",
    )?;
    let mapped = statement.query_map(params![loser], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, f64>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, Option<i64>>(8)?,
            row.get::<_, Option<i64>>(9)?,
        ))
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    drop(statement);
    connection.execute(
        "DELETE FROM edges WHERE (from_kind = 'entity' AND from_id = ?1) OR (to_kind = 'entity' AND to_id = ?1)",
        params![loser],
    )?;
    for (kind, from_kind, from_id, to_kind, to_id, weight, source, taint, span_start, span_end) in rows {
        let from_id = if from_kind == "entity" && from_id == loser {
            winner.to_owned()
        } else {
            from_id
        };
        let to_id = if to_kind == "entity" && to_id == loser {
            winner.to_owned()
        } else {
            to_id
        };
        if from_kind == to_kind && from_id == to_id {
            continue;
        }
        connection.execute(
            "INSERT OR IGNORE INTO edges \
             (edge_kind, from_kind, from_id, to_kind, to_id, weight, source_tag, taint, span_start, span_end) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![kind, from_kind, from_id, to_kind, to_id, weight, source, taint, span_start, span_end],
        )?;
    }
    Ok(())
}

fn split_episode(body: &str) -> (String, String) {
    let mut owner = String::new();
    let mut reply = String::new();
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("Owner: ") {
            owner = rest.to_owned();
        } else if let Some(rest) = line.strip_prefix("Maia: ") {
            if !reply.is_empty() {
                reply.push('\n');
            }
            reply.push_str(rest);
        }
    }
    if owner.is_empty() {
        (body.to_owned(), String::new())
    } else {
        (owner, reply)
    }
}

fn slug_for(name: &str) -> String {
    let slug: String = name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect();
    if slug.is_empty() { "item".to_owned() } else { slug }
}

#[cfg(test)]
mod tests {
    use super::cleanup;
    use crate::migrate::apply;
    use crate::vec_register::register_sqlite_vec;
    use rusqlite::Connection;

    #[test]
    fn cleanup_hides_status_and_keeps_a_durable_fact() {
        register_sqlite_vec().expect("vec");
        let mut connection = Connection::open_in_memory().expect("memory db");
        apply(&mut connection, 1).expect("migrate");
        connection
            .execute(
                "INSERT INTO threads (thread_id, version, participants, created_at) VALUES ('t-1', 1, 'owner', 1)",
                [],
            )
            .expect("thread");
        connection
            .execute(
                "INSERT INTO episodes (episode_id, thread_id, turn_id, body, taint, participants, created_at, write_canonical) \
                 VALUES ('episode-1', 't-1', 'turn-1', 'Owner: The user''s name is Garrett.\nMaia: Handed this message to the running task.', 'trusted', 'owner', 1, 'canon')",
                [],
            )
            .expect("episode");
        connection
            .execute(
                "INSERT INTO claims (claim_id, sentence, episode_id, taint, status, valid_from) \
                 VALUES ('claim-good', 'The user''s name is Garrett.', 'episode-1', 'trusted', 'provisional', 1)",
                [],
            )
            .expect("good claim");
        connection
            .execute(
                "INSERT INTO claims (claim_id, sentence, episode_id, taint, status, valid_from) \
                 VALUES ('claim-junk', 'Handed this message to the running task.', 'episode-1', 'trusted', 'provisional', 1)",
                [],
            )
            .expect("junk claim");
        cleanup(&connection).expect("cleanup");
        let hidden: String = connection
            .query_row(
                "SELECT hidden_reason FROM claims WHERE claim_id = 'claim-junk'",
                [],
                |row| row.get(0),
            )
            .expect("junk");
        assert_eq!(hidden, "not a durable fact");
        let category: String = connection
            .query_row(
                "SELECT category FROM claims WHERE claim_id = 'claim-good'",
                [],
                |row| row.get(0),
            )
            .expect("good");
        assert_eq!(category, "person");
        let body: String = connection
            .query_row("SELECT body FROM episodes WHERE episode_id = 'episode-1'", [], |row| row.get(0))
            .expect("body");
        assert!(body.contains("Garrett"));
        assert!(!body.contains("Handed this message"));
        let owner: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM entities WHERE entity_id = 'entity-owner'",
                [],
                |row| row.get(0),
            )
            .expect("owner");
        assert_eq!(owner, 1);
    }
}
