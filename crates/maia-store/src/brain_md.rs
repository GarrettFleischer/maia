//! Markdown export, import, sync, and keyword search over the shared brain.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use maia_core::brain::NeuronDoc;
use maia_core::brain::NeuronEdge;
use maia_core::brain::NeuronSegment;
use maia_core::brain::assign_markdown_paths;
use maia_core::brain::body_fingerprint;
use maia_core::brain::neuron_title;
use maia_core::brain::parse_neuron;
use maia_core::brain::render_neuron;
use maia_core::brain::sanitize_fts_query;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::auto_link;
use crate::canonical::episode_canonical;
use crate::error::StoreError;
use crate::types::EpisodeWrite;
use crate::types::MemoryTaint;
use crate::types::SegmentWrite;

/// Result of writing the Markdown folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrainExportReport {
    /// Neuron files written.
    pub neurons: u64,
    /// Edges stored on those neurons.
    pub edges: u64,
    /// Folder that was written.
    pub directory: String,
    /// Export timestamp supplied by the caller.
    pub exported_at: i64,
}

/// Result of applying Markdown edits onto a live brain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrainSyncReport {
    /// Files whose ids were not in the database.
    pub created: u64,
    /// Files whose newer body was applied.
    pub updated: u64,
    /// Exported neurons removed from the folder.
    pub soft_deleted: u64,
    /// Rows left untouched.
    pub kept: u64,
    /// Edits that were not applied. Nothing in this list was dropped silently.
    pub conflicts: Vec<BrainConflict>,
}

/// One sync disagreement, identified without copying the note body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrainConflict {
    /// Neuron kind.
    pub kind: String,
    /// Neuron id.
    pub id: String,
    /// Why the database row was kept.
    pub reason: String,
}

/// Last export and the most recent recall arm sizes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrainIndex {
    /// Unix seconds of the last successful export, when one has run.
    pub exported_at: Option<i64>,
    /// Last export directory.
    pub directory: String,
    /// Neurons written by that export.
    pub neuron_count: i64,
    /// Edges written by that export.
    pub edge_count: i64,
    /// Keyword hits in the last recall.
    pub keyword_count: i64,
    /// Vector hits in the last recall.
    pub vector_count: i64,
    /// Graph hits in the last recall.
    pub graph_count: i64,
}

/// One keyword or graph hit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeuronHit {
    /// `claim`, `fact`, or `episode`.
    pub kind: String,
    /// Stable id.
    pub id: String,
    /// Indexed title.
    pub title: String,
    /// `trusted` or `untrusted`.
    pub taint: String,
}

/// Writes every neuron into `dir` and records the export.
pub(crate) fn export_markdown(
    connection: &mut Connection,
    dir: &Path,
    now: i64,
) -> Result<BrainExportReport, StoreError> {
    let docs = load_docs(connection)?;
    fs::create_dir_all(dir).map_err(|error| io_message("create brain markdown directory", &error))?;
    let assigned = assign_markdown_paths(&docs);
    let mut written = BTreeSet::new();
    for (relative, doc) in &assigned {
        let path = dir.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| io_message("create brain markdown folder", &error))?;
        }
        fs::write(&path, render_neuron(doc))
            .map_err(|error| io_message("write brain markdown", &error))?;
        written.insert(relative.clone());
    }
    remove_stale(dir, &written)?;
    let edges: i64 = connection.query_row("SELECT COUNT(*) FROM edges", [], |row| row.get(0))?;
    let transaction = immediate(connection)?;
    save_members(&transaction, now, dir, &docs, edges)?;
    transaction.commit()?;
    Ok(BrainExportReport {
        neurons: u64::try_from(docs.len()).unwrap_or(0),
        edges: u64::try_from(edges).unwrap_or(0),
        directory: dir.display().to_string(),
        exported_at: now,
    })
}

/// Loads Markdown into a brain that has no neurons yet.
pub(crate) fn import_markdown(
    connection: &mut Connection,
    dir: &Path,
    now: i64,
) -> Result<BrainExportReport, StoreError> {
    let existing = neuron_count(connection)?;
    if existing > 0 {
        return Err(StoreError::InvalidRequest {
            message: "import requires an empty brain".to_owned(),
        });
    }
    let docs = read_docs(dir)?;
    let transaction = immediate(connection)?;
    insert_docs(&transaction, &docs, false)?;
    let edges: i64 = transaction.query_row("SELECT COUNT(*) FROM edges", [], |row| row.get(0))?;
    save_members(&transaction, now, dir, &docs, edges)?;
    transaction.commit()?;
    Ok(BrainExportReport {
        neurons: u64::try_from(docs.len()).unwrap_or(0),
        edges: u64::try_from(edges).unwrap_or(0),
        directory: dir.display().to_string(),
        exported_at: now,
    })
}

/// Applies hand edits. A newer database row is kept and reported.
pub(crate) fn sync_markdown(
    connection: &mut Connection,
    dir: &Path,
    now: i64,
) -> Result<BrainSyncReport, StoreError> {
    let files = read_docs(dir)?;
    let transaction = immediate(connection)?;
    let db_docs = load_docs(&transaction)?;
    let members = load_members(&transaction)?;
    let db_by = docs_by_id(&db_docs);
    let mut seen = BTreeSet::new();
    let mut report = BrainSyncReport {
        created: 0,
        updated: 0,
        soft_deleted: 0,
        kept: 0,
        conflicts: Vec::new(),
    };
    let mut created = Vec::new();
    for doc in &files {
        let key = (doc.kind.clone(), doc.id.clone());
        if !seen.insert(key.clone()) {
            return Err(StoreError::InvalidRequest {
                message: format!("duplicate markdown id {}:{}", doc.kind, doc.id),
            });
        }
        match db_by.get(&key) {
            None => created.push(doc.clone()),
            Some(existing) => {
                decide_existing(&transaction, existing, doc, members.get(&key), &mut report)?;
            }
        }
    }
    if !created.is_empty() {
        insert_docs(&transaction, &created, true)?;
        for doc in &created {
            remember_member(&transaction, doc)?;
        }
        report.created = u64::try_from(created.len()).unwrap_or(0);
    }
    for existing in &db_docs {
        let key = (existing.kind.clone(), existing.id.clone());
        if seen.contains(&key) || existing.deleted_at.is_some() {
            continue;
        }
        match members.get(&key) {
            None => report.kept = report.kept.saturating_add(1),
            Some(member) if existing.updated_at > member.updated_at => {
                report.conflicts.push(BrainConflict {
                    kind: existing.kind.clone(),
                    id: existing.id.clone(),
                    reason: "removed in markdown but newer in the database".to_owned(),
                });
            }
            Some(_) => {
                soft_delete(&transaction, &existing.kind, &existing.id, now)?;
                report.soft_deleted = report.soft_deleted.saturating_add(1);
            }
        }
    }
    transaction.commit()?;
    Ok(report)
}

/// Keyword hits. Odd FTS input becomes an empty hit list instead of an error.
pub(crate) fn search_neurons(
    connection: &Connection,
    raw: &str,
    limit: i64,
) -> Result<Vec<NeuronHit>, StoreError> {
    if limit < 1 {
        return Err(StoreError::InvalidRequest {
            message: "neuron search limit must be at least 1".to_owned(),
        });
    }
    let query = sanitize_fts_query(raw);
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let statement = connection.prepare(
        "SELECT neuron_fts.kind, neuron_fts.neuron_id, neuron_text.title, neuron_text.taint \
         FROM neuron_fts \
         JOIN neuron_text ON neuron_text.kind = neuron_fts.kind \
           AND neuron_text.neuron_id = neuron_fts.neuron_id \
         WHERE neuron_fts MATCH ?1 \
           AND neuron_text.deleted_at IS NULL \
           AND NOT (neuron_text.kind = 'claim' AND EXISTS ( \
             SELECT 1 FROM claims \
             WHERE claims.claim_id = neuron_text.neuron_id \
               AND (claims.status != 'provisional' OR claims.consolidated_by IS NOT NULL \
                 OR claims.hidden_reason IS NOT NULL))) \
           AND NOT (neuron_text.kind = 'episode' AND EXISTS ( \
             SELECT 1 FROM episodes \
             WHERE episodes.episode_id = neuron_text.neuron_id \
               AND episodes.hidden_reason IS NOT NULL)) \
         ORDER BY bm25(neuron_fts) ASC, neuron_fts.kind ASC, neuron_fts.neuron_id ASC \
         LIMIT ?2",
    );
    let mut statement = match statement {
        Ok(statement) => statement,
        Err(error) => return fts_or_empty(error),
    };
    let mapped = match statement.query_map(params![query, limit], read_hit) {
        Ok(mapped) => mapped,
        Err(error) => return fts_or_empty(error),
    };
    let mut hits = Vec::new();
    for hit in mapped {
        match hit {
            Ok(hit) => hits.push(hit),
            Err(error) => return fts_or_empty(error),
        }
    }
    Ok(hits)
}

/// Lexeme neighbors used as the graph arm, most matches first.
pub(crate) fn graph_arm(
    connection: &Connection,
    lexeme_ids: &[String],
    limit: i64,
) -> Result<Vec<NeuronHit>, StoreError> {
    if limit < 1 {
        return Ok(Vec::new());
    }
    let mut scores: BTreeMap<(String, String), (NeuronHit, u32)> = BTreeMap::new();
    for lexeme in lexeme_ids {
        if lexeme.is_empty() {
            continue;
        }
        collect_lexeme(connection, lexeme, &mut scores)?;
    }
    let mut ranked: Vec<(NeuronHit, u32)> = scores.into_values().collect();
    ranked.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| left.0.kind.cmp(&right.0.kind))
            .then_with(|| left.0.id.cmp(&right.0.id))
    });
    ranked.truncate(usize::try_from(limit).unwrap_or(0));
    Ok(ranked.into_iter().map(|(hit, _)| hit).collect())
}

/// Reads the Brain tab counters.
pub(crate) fn brain_index(connection: &Connection) -> Result<BrainIndex, StoreError> {
    let row = connection
        .query_row(
            "SELECT exported_at, directory, neuron_count, edge_count, keyword_count, vector_count, graph_count \
             FROM brain_md_state WHERE singleton = 1",
            [],
            |row| {
                Ok(BrainIndex {
                    exported_at: row.get(0)?,
                    directory: row.get(1)?,
                    neuron_count: row.get(2)?,
                    edge_count: row.get(3)?,
                    keyword_count: row.get(4)?,
                    vector_count: row.get(5)?,
                    graph_count: row.get(6)?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or(BrainIndex {
        exported_at: None,
        directory: String::new(),
        neuron_count: 0,
        edge_count: 0,
        keyword_count: 0,
        vector_count: 0,
        graph_count: 0,
    }))
}

/// Stores the last recall's arm sizes.
pub(crate) fn record_recall_arms(
    connection: &Connection,
    keyword: i64,
    vector: i64,
    graph: i64,
) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE brain_md_state SET keyword_count = ?1, vector_count = ?2, graph_count = ?3 \
         WHERE singleton = 1",
        params![keyword, vector, graph],
    )?;
    Ok(())
}

fn decide_existing(
    connection: &Connection,
    existing: &NeuronDoc,
    file: &NeuronDoc,
    member: Option<&Member>,
    report: &mut BrainSyncReport,
) -> Result<(), StoreError> {
    if existing.body == file.body && existing.deleted_at.is_none() {
        report.kept = report.kept.saturating_add(1);
        return Ok(());
    }
    let db_hash = body_fingerprint(&existing.body);
    let file_hash = body_fingerprint(&file.body);
    let db_changed = member.is_none_or(|row| row.body_hash != db_hash);
    let file_changed = member.is_none_or(|row| row.body_hash != file_hash);
    if file.updated_at > existing.updated_at || (file.updated_at == existing.updated_at && file_changed && !db_changed)
    {
        apply_body(connection, file)?;
        report.updated = report.updated.saturating_add(1);
        return Ok(());
    }
    if existing.updated_at > file.updated_at || db_changed {
        report.conflicts.push(BrainConflict {
            kind: existing.kind.clone(),
            id: existing.id.clone(),
            reason: format!(
                "database updated_at {} is not older than markdown updated_at {}",
                existing.updated_at, file.updated_at
            ),
        });
        return Ok(());
    }
    report.kept = report.kept.saturating_add(1);
    Ok(())
}

fn apply_body(connection: &Connection, doc: &NeuronDoc) -> Result<(), StoreError> {
    let body = doc.body.clone();
    match doc.kind.as_str() {
        "claim" => {
            connection.execute(
                "UPDATE claims SET sentence = ?1 WHERE claim_id = ?2",
                params![body, doc.id],
            )?;
            connection.execute("DELETE FROM claim_fts WHERE claim_id = ?1", params![doc.id])?;
            connection.execute(
                "INSERT INTO claim_fts (claim_id, sentence) VALUES (?1, ?2)",
                params![doc.id, doc.body],
            )?;
        }
        "fact" => {
            connection.execute(
                "UPDATE facts SET sentence = ?1 WHERE fact_id = ?2",
                params![body, doc.id],
            )?;
        }
        "episode" => {
            connection.execute(
                "UPDATE episodes SET body = ?1 WHERE episode_id = ?2",
                params![body, doc.id],
            )?;
            connection.execute(
                "DELETE FROM episode_fts WHERE episode_id = ?1",
                params![doc.id],
            )?;
            connection.execute(
                "INSERT INTO episode_fts (episode_id, body) VALUES (?1, ?2)",
                params![doc.id, doc.body],
            )?;
        }
        other => {
            return Err(StoreError::InvalidRequest {
                message: format!("unknown neuron kind {other}"),
            });
        }
    }
    auto_link::on_neuron_written(connection, &doc.kind, &doc.id)?;
    remember_member(connection, doc)?;
    let aliases = doc.aliases.join("\n");
    connection.execute(
        "UPDATE neuron_text SET updated_at = ?1, aliases = ?2, deleted_at = NULL, title = ?3 \
         WHERE kind = ?4 AND neuron_id = ?5",
        params![doc.updated_at, aliases, neuron_title(&doc.id, &doc.body), doc.kind, doc.id],
    )?;
    Ok(())
}

fn remember_member(connection: &Connection, doc: &NeuronDoc) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO brain_md_member (kind, neuron_id, updated_at, body_hash) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(kind, neuron_id) DO UPDATE SET updated_at = excluded.updated_at, body_hash = excluded.body_hash",
        params![doc.kind, doc.id, doc.updated_at, body_fingerprint(&doc.body)],
    )?;
    Ok(())
}

fn soft_delete(connection: &Connection, kind: &str, id: &str, now: i64) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE neuron_text SET deleted_at = ?1 WHERE kind = ?2 AND neuron_id = ?3",
        params![now, kind, id],
    )?;
    connection.execute(
        "DELETE FROM neuron_fts WHERE kind = ?1 AND neuron_id = ?2",
        params![kind, id],
    )?;
    if kind == "claim" {
        connection.execute("DELETE FROM claim_fts WHERE claim_id = ?1", params![id])?;
    }
    if kind == "episode" {
        connection.execute("DELETE FROM episode_fts WHERE episode_id = ?1", params![id])?;
    }
    Ok(())
}

fn insert_docs(connection: &Connection, docs: &[NeuronDoc], relink: bool) -> Result<(), StoreError> {
    let mut episodes = Vec::new();
    let mut facts = Vec::new();
    let mut claims = Vec::new();
    for doc in docs {
        match doc.kind.as_str() {
            "episode" => episodes.push(doc),
            "fact" => facts.push(doc),
            "claim" => claims.push(doc),
            other => {
                return Err(StoreError::InvalidRequest {
                    message: format!("unknown neuron kind {other}"),
                });
            }
        }
    }
    for doc in &episodes {
        insert_episode_doc(connection, doc)?;
    }
    for doc in &facts {
        insert_fact_doc(connection, doc)?;
    }
    for doc in &claims {
        insert_claim_doc(connection, doc)?;
    }
    for doc in &facts {
        update_fact_pointers(connection, doc)?;
    }
    for doc in &claims {
        update_claim_pointers(connection, doc)?;
    }
    for doc in docs {
        insert_doc_edges(connection, doc)?;
        finish_neuron(connection, doc)?;
    }
    for doc in docs {
        if doc.deleted_at.is_some() {
            connection.execute(
                "DELETE FROM neuron_fts WHERE kind = ?1 AND neuron_id = ?2",
                params![doc.kind, doc.id],
            )?;
            continue;
        }
        if relink {
            auto_link::on_neuron_written(connection, &doc.kind, &doc.id)?;
        } else {
            auto_link::index_neuron(connection, &doc.kind, &doc.id)?;
        }
    }
    Ok(())
}

fn insert_episode_doc(connection: &Connection, doc: &NeuronDoc) -> Result<(), StoreError> {
    let taint = parse_taint(&doc.taint)?;
    let thread_id = nonempty(&doc.thread_id, "imported");
    let participants = nonempty(&doc.participants, "owner");
    connection.execute(
        "INSERT OR IGNORE INTO threads (thread_id, version, participants, created_at) VALUES (?1, 0, ?2, ?3)",
        params![thread_id, participants, doc.created_at],
    )?;
    let segments = if doc.segments.is_empty() {
        vec![SegmentWrite {
            text: nonempty(&doc.body, &doc.id),
            taint,
            sources: "markdown".to_owned(),
        }]
    } else {
        doc.segments
            .iter()
            .map(|segment| SegmentWrite {
                text: nonempty(&segment.text, &doc.id),
                taint: parse_taint(&segment.taint).unwrap_or(taint),
                sources: nonempty(&segment.sources, "markdown"),
            })
            .collect()
    };
    let request = EpisodeWrite {
        episode_id: doc.id.clone(),
        thread_id,
        turn_id: nonempty(&doc.turn_id, &doc.id),
        body: doc.body.clone(),
        taint,
        reasoning: doc.reasoning.clone(),
        participants,
        created_at: doc.created_at,
        segments,
    };
    let canonical = episode_canonical(&request)?;
    connection.execute(
        "INSERT INTO episodes (episode_id, thread_id, turn_id, body, taint, reasoning, participants, created_at, write_canonical, promoted_at, promoted_model, promotion_canonical) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'markdown-import', 'markdown-import')",
        params![
            request.episode_id,
            request.thread_id,
            request.turn_id,
            request.body,
            request.taint.as_str(),
            request.reasoning,
            request.participants,
            request.created_at,
            canonical,
            request.created_at
        ],
    )?;
    for (index, segment) in request.segments.iter().enumerate() {
        let ordinal = i64::try_from(index).unwrap_or(0);
        connection.execute(
            "INSERT INTO episode_segments (episode_id, ordinal, text, taint, sources) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![request.episode_id, ordinal, segment.text, segment.taint.as_str(), segment.sources],
        )?;
    }
    connection.execute(
        "INSERT INTO episode_fts (episode_id, body) VALUES (?1, ?2)",
        params![request.episode_id, request.body],
    )?;
    Ok(())
}

fn insert_fact_doc(connection: &Connection, doc: &NeuronDoc) -> Result<(), StoreError> {
    if let Some(entity) = &doc.entity_id {
        connection.execute(
            "INSERT OR IGNORE INTO entities (entity_id, slug, description, scope_kind, scope_agent) \
             VALUES (?1, ?1, '', 'world', '')",
            params![entity],
        )?;
    }
    connection.execute(
        "INSERT INTO facts (fact_id, sentence, entity_id, taint, sources, valid_from, valid_to, replacement_fact_id, merged_into) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL)",
        params![
            doc.id,
            nonempty(&doc.body, &doc.id),
            doc.entity_id,
            parse_taint(&doc.taint)?.as_str(),
            doc.sources,
            doc.valid_from
        ],
    )?;
    for label in &doc.provenance {
        let Some(episode) = label.strip_prefix("episode:") else {
            continue;
        };
        connection.execute(
            "INSERT OR IGNORE INTO fact_episodes (fact_id, episode_id) VALUES (?1, ?2)",
            params![doc.id, episode],
        )?;
    }
    Ok(())
}

fn insert_claim_doc(connection: &Connection, doc: &NeuronDoc) -> Result<(), StoreError> {
    let status = if doc.consolidated_by.is_some() || doc.status == "superseded" {
        "superseded"
    } else {
        "provisional"
    };
    let episode = doc
        .source_episode
        .clone()
        .unwrap_or_else(|| "episode-missing".to_owned());
    connection.execute(
        "INSERT INTO claims (claim_id, sentence, episode_id, taint, status, valid_from, consolidated_by, replaced_by) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
        params![
            doc.id,
            nonempty(&doc.body, &doc.id),
            episode,
            parse_taint(&doc.taint)?.as_str(),
            status,
            doc.valid_from,
            doc.consolidated_by
        ],
    )?;
    crate::memory_tags::fill_claim(
        connection,
        &doc.id,
        &nonempty(&doc.body, &doc.id),
        "",
    )?;
    connection.execute(
        "INSERT INTO claim_fts (claim_id, sentence) VALUES (?1, ?2)",
        params![doc.id, nonempty(&doc.body, &doc.id)],
    )?;
    Ok(())
}

fn update_fact_pointers(connection: &Connection, doc: &NeuronDoc) -> Result<(), StoreError> {
    connection.execute(
        "UPDATE facts SET valid_to = ?1, replacement_fact_id = ?2, merged_into = ?3 WHERE fact_id = ?4",
        params![doc.valid_to, doc.replacement_fact_id, doc.merged_into, doc.id],
    )?;
    Ok(())
}

fn update_claim_pointers(connection: &Connection, doc: &NeuronDoc) -> Result<(), StoreError> {
    if let Some(replaced) = &doc.replaced_by {
        connection.execute(
            "UPDATE claims SET replaced_by = ?1 WHERE claim_id = ?2",
            params![replaced, doc.id],
        )?;
    }
    Ok(())
}

fn insert_doc_edges(connection: &Connection, doc: &NeuronDoc) -> Result<(), StoreError> {
    if doc.held {
        connection.execute(
            "INSERT OR IGNORE INTO correction_holds (target_kind, target_id, since) VALUES (?1, ?2, ?3)",
            params![doc.kind, doc.id, doc.created_at],
        )?;
    }
    for edge in &doc.edges {
        if edge.to_kind == "lexeme" {
            connection.execute(
                "INSERT OR IGNORE INTO lexemes (lexeme_id) VALUES (?1)",
                params![edge.to_id],
            )?;
        }
        let weight = f64::from(i32::try_from(edge.weight_millis).unwrap_or(0)) / 1000.0;
        connection.execute(
            "INSERT OR IGNORE INTO edges \
             (edge_kind, from_kind, from_id, to_kind, to_id, weight, source_tag, taint, span_start, span_end) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                edge.edge_type,
                doc.kind,
                doc.id,
                edge.to_kind,
                edge.to_id,
                weight,
                edge.source,
                if edge.taint == "untrusted" { "untrusted" } else { "trusted" },
                edge.span_start,
                edge.span_end
            ],
        )?;
    }
    if doc.kind == "fact" {
        for claim_id in &doc.consolidates {
            connection.execute(
                "INSERT OR IGNORE INTO fact_claims (fact_id, claim_id) VALUES (?1, ?2)",
                params![doc.id, claim_id],
            )?;
        }
    }
    Ok(())
}

fn finish_neuron(connection: &Connection, doc: &NeuronDoc) -> Result<(), StoreError> {
    let aliases = doc.aliases.join("\n");
    connection.execute(
        "UPDATE neuron_text SET title = ?1, updated_at = ?2, deleted_at = ?3, aliases = ?4 \
         WHERE kind = ?5 AND neuron_id = ?6",
        params![
            doc.title,
            doc.updated_at,
            doc.deleted_at,
            aliases,
            doc.kind,
            doc.id
        ],
    )?;
    Ok(())
}

fn load_docs(connection: &Connection) -> Result<Vec<NeuronDoc>, StoreError> {
    let edges = load_edge_map(connection)?;
    let holds = load_hold_set(connection)?;
    let mut docs = Vec::new();
    docs.extend(load_kind(connection, "episode", &edges, &holds)?);
    docs.extend(load_kind(connection, "claim", &edges, &holds)?);
    docs.extend(load_kind(connection, "fact", &edges, &holds)?);
    docs.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(docs)
}

fn load_kind(
    connection: &Connection,
    kind: &str,
    edges: &BTreeMap<(String, String), Vec<NeuronEdge>>,
    holds: &BTreeSet<(String, String)>,
) -> Result<Vec<NeuronDoc>, StoreError> {
    let sql = match kind {
        "episode" => {
            "SELECT episode_id, body, taint, created_at, thread_id, turn_id, participants, reasoning \
             FROM episodes ORDER BY episode_id"
        }
        "claim" => {
            "SELECT claim_id, sentence, taint, valid_from, episode_id, status, consolidated_by, replaced_by \
             FROM claims ORDER BY claim_id"
        }
        "fact" => {
            "SELECT fact_id, sentence, taint, valid_from, valid_to, sources, entity_id, merged_into, replacement_fact_id \
             FROM facts ORDER BY fact_id"
        }
        _ => return Ok(Vec::new()),
    };
    let mut statement = connection.prepare(sql)?;
    let mut docs = Vec::new();
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let mut doc = match kind {
            "episode" => episode_doc(row)?,
            "claim" => claim_doc(row)?,
            "fact" => fact_doc(connection, row)?,
            _ => continue,
        };
        let key = (doc.kind.clone(), doc.id.clone());
        if let Some(found) = edges.get(&key) {
            doc.edges = found.clone();
            doc.lexemes = found
                .iter()
                .filter(|edge| edge.edge_type == "lexeme" && edge.to_kind == "lexeme")
                .map(|edge| edge.to_id.clone())
                .collect();
        }
        doc.held = holds.contains(&key);
        if let Some((title, updated_at, deleted_at, aliases)) = neuron_meta(connection, &doc.kind, &doc.id)? {
            doc.title = title;
            doc.updated_at = updated_at;
            doc.deleted_at = deleted_at;
            doc.aliases = aliases;
        }
        if kind == "episode" {
            doc.segments = load_segments(connection, &doc.id)?;
        }
        docs.push(doc);
    }
    Ok(docs)
}

fn episode_doc(row: &rusqlite::Row<'_>) -> Result<NeuronDoc, StoreError> {
    let id: String = row.get(0)?;
    let body: String = row.get(1)?;
    let taint: String = row.get(2)?;
    let created_at: i64 = row.get(3)?;
    let mut doc = NeuronDoc::prose("episode", &id, &body, &taint, created_at);
    doc.thread_id = row.get(4)?;
    doc.turn_id = row.get(5)?;
    doc.participants = row.get(6)?;
    doc.reasoning = row.get(7)?;
    doc.provenance = vec![format!("thread:{}", doc.thread_id)];
    Ok(doc)
}

fn claim_doc(row: &rusqlite::Row<'_>) -> Result<NeuronDoc, StoreError> {
    let id: String = row.get(0)?;
    let body: String = row.get(1)?;
    let taint: String = row.get(2)?;
    let created_at: i64 = row.get(3)?;
    let mut doc = NeuronDoc::prose("claim", &id, &body, &taint, created_at);
    doc.source_episode = Some(row.get(4)?);
    doc.status = row.get(5)?;
    doc.consolidated_by = row.get(6)?;
    doc.replaced_by = row.get(7)?;
    if let Some(episode) = &doc.source_episode {
        doc.provenance = vec![format!("episode:{episode}")];
    }
    Ok(doc)
}

fn fact_doc(connection: &Connection, row: &rusqlite::Row<'_>) -> Result<NeuronDoc, StoreError> {
    let id: String = row.get(0)?;
    let body: String = row.get(1)?;
    let taint: String = row.get(2)?;
    let created_at: i64 = row.get(3)?;
    let mut doc = NeuronDoc::prose("fact", &id, &body, &taint, created_at);
    doc.valid_to = row.get(4)?;
    doc.sources = row.get(5)?;
    doc.entity_id = row.get(6)?;
    doc.merged_into = row.get(7)?;
    doc.replacement_fact_id = row.get(8)?;
    if doc.valid_to.is_some() || doc.merged_into.is_some() {
        doc.status = "closed".to_owned();
    }
    doc.consolidates = id_list(
        connection,
        "SELECT claim_id FROM fact_claims WHERE fact_id = ?1 ORDER BY claim_id",
        &id,
    )?;
    let episodes = id_list(
        connection,
        "SELECT episode_id FROM fact_episodes WHERE fact_id = ?1 ORDER BY episode_id",
        &id,
    )?;
    doc.provenance = episodes
        .iter()
        .map(|episode| format!("episode:{episode}"))
        .collect();
    Ok(doc)
}

fn load_segments(connection: &Connection, episode_id: &str) -> Result<Vec<NeuronSegment>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT text, taint, sources FROM episode_segments WHERE episode_id = ?1 ORDER BY ordinal",
    )?;
    let mapped = statement.query_map(params![episode_id], |row| {
        Ok(NeuronSegment {
            text: row.get(0)?,
            taint: row.get(1)?,
            sources: row.get(2)?,
        })
    })?;
    let mut segments = Vec::new();
    for segment in mapped {
        segments.push(segment?);
    }
    Ok(segments)
}

fn load_edge_map(
    connection: &Connection,
) -> Result<BTreeMap<(String, String), Vec<NeuronEdge>>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT from_kind, from_id, edge_kind, to_kind, to_id, weight, source_tag, taint, span_start, span_end \
         FROM edges ORDER BY from_kind, from_id, edge_kind, to_kind, to_id",
    )?;
    let mapped = statement.query_map([], |row| {
        let weight: f64 = row.get(5)?;
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            NeuronEdge {
                edge_type: row.get(2)?,
                to_kind: row.get(3)?,
                to_id: row.get(4)?,
                weight_millis: weight_millis(weight),
                source: row.get(6)?,
                taint: row.get(7)?,
                span_start: row.get(8)?,
                span_end: row.get(9)?,
            },
        ))
    })?;
    let mut map: BTreeMap<(String, String), Vec<NeuronEdge>> = BTreeMap::new();
    for row in mapped {
        let (kind, id, edge) = row?;
        map.entry((kind, id)).or_default().push(edge);
    }
    Ok(map)
}

fn load_hold_set(connection: &Connection) -> Result<BTreeSet<(String, String)>, StoreError> {
    let mut statement =
        connection.prepare("SELECT target_kind, target_id FROM correction_holds")?;
    let mapped = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let mut holds = BTreeSet::new();
    for hold in mapped {
        holds.insert(hold?);
    }
    Ok(holds)
}

fn neuron_meta(
    connection: &Connection,
    kind: &str,
    id: &str,
) -> Result<Option<(String, i64, Option<i64>, Vec<String>)>, StoreError> {
    let row = connection
        .query_row(
            "SELECT title, updated_at, deleted_at, aliases FROM neuron_text WHERE kind = ?1 AND neuron_id = ?2",
            params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    Ok(row.map(|(title, updated_at, deleted_at, aliases): (String, i64, Option<i64>, String)| {
        (
            title,
            updated_at,
            deleted_at,
            aliases
                .split('\n')
                .filter(|alias| !alias.is_empty())
                .map(str::to_owned)
                .collect(),
        )
    }))
}

fn id_list(connection: &Connection, sql: &str, id: &str) -> Result<Vec<String>, StoreError> {
    let mut statement = connection.prepare(sql)?;
    let mapped = statement.query_map(params![id], |row| row.get(0))?;
    let mut ids = Vec::new();
    for id in mapped {
        ids.push(id?);
    }
    Ok(ids)
}

struct Member {
    updated_at: i64,
    body_hash: String,
}

fn load_members(connection: &Connection) -> Result<BTreeMap<(String, String), Member>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT kind, neuron_id, updated_at, body_hash FROM brain_md_member",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            Member {
                updated_at: row.get(2)?,
                body_hash: row.get(3)?,
            },
        ))
    })?;
    let mut members = BTreeMap::new();
    for row in mapped {
        let (kind, id, member): (String, String, Member) = row?;
        members.insert((kind, id), member);
    }
    Ok(members)
}

fn save_members(
    connection: &Connection,
    now: i64,
    dir: &Path,
    docs: &[NeuronDoc],
    edges: i64,
) -> Result<(), StoreError> {
    connection.execute("DELETE FROM brain_md_member", [])?;
    for doc in docs {
        connection.execute(
            "INSERT INTO brain_md_member (kind, neuron_id, updated_at, body_hash) VALUES (?1, ?2, ?3, ?4)",
            params![doc.kind, doc.id, doc.updated_at, body_fingerprint(&doc.body)],
        )?;
    }
    connection.execute(
        "UPDATE brain_md_state SET exported_at = ?1, directory = ?2, neuron_count = ?3, edge_count = ?4 \
         WHERE singleton = 1",
        params![now, dir.display().to_string(), i64::try_from(docs.len()).unwrap_or(0), edges],
    )?;
    Ok(())
}

fn collect_lexeme(
    connection: &Connection,
    lexeme: &str,
    scores: &mut BTreeMap<(String, String), (NeuronHit, u32)>,
) -> Result<(), StoreError> {
    let mut statement = connection.prepare(
        "SELECT edges.from_kind, edges.from_id, COALESCE(neuron_text.title, edges.from_id), \
           COALESCE(neuron_text.taint, 'trusted') \
         FROM edges \
         LEFT JOIN neuron_text ON neuron_text.kind = edges.from_kind AND neuron_text.neuron_id = edges.from_id \
         WHERE edges.edge_kind = 'lexeme' AND edges.to_kind = 'lexeme' AND edges.to_id = ?1 \
           AND edges.from_kind IN ('claim', 'fact') \
           AND (neuron_text.deleted_at IS NULL)",
    )?;
    let mapped = statement.query_map(params![lexeme], read_hit)?;
    for hit in mapped {
        let hit = hit?;
        if hit.kind == "claim" && claim_closed(connection, &hit.id)? {
            continue;
        }
        let key = (hit.kind.clone(), hit.id.clone());
        scores
            .entry(key)
            .and_modify(|pair| pair.1 = pair.1.saturating_add(1))
            .or_insert((hit, 1));
    }
    Ok(())
}

fn claim_closed(connection: &Connection, id: &str) -> Result<bool, StoreError> {
    let row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT status || COALESCE(consolidated_by, ''), hidden_reason FROM claims WHERE claim_id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    Ok(row.is_some_and(|(status, hidden)| {
        hidden.is_some()
            || !status.starts_with("provisional")
            || status.len() > "provisional".len()
    }))
}

fn read_hit(row: &rusqlite::Row<'_>) -> rusqlite::Result<NeuronHit> {
    Ok(NeuronHit {
        kind: row.get(0)?,
        id: row.get(1)?,
        title: row.get(2)?,
        taint: row.get(3)?,
    })
}

fn neuron_count(connection: &Connection) -> Result<i64, StoreError> {
    let claims: i64 = connection.query_row("SELECT COUNT(*) FROM claims", [], |row| row.get(0))?;
    let facts: i64 = connection.query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))?;
    let episodes: i64 =
        connection.query_row("SELECT COUNT(*) FROM episodes", [], |row| row.get(0))?;
    Ok(claims + facts + episodes)
}

fn docs_by_id(docs: &[NeuronDoc]) -> BTreeMap<(String, String), NeuronDoc> {
    docs.iter()
        .map(|doc| ((doc.kind.clone(), doc.id.clone()), doc.clone()))
        .collect()
}

fn read_docs(dir: &Path) -> Result<Vec<NeuronDoc>, StoreError> {
    if !dir.is_dir() {
        return Err(StoreError::InvalidRequest {
            message: "markdown directory does not exist".to_owned(),
        });
    }
    let mut docs = Vec::new();
    walk_md(dir, &mut docs)?;
    let mut seen = BTreeSet::new();
    for doc in &docs {
        if !seen.insert((doc.kind.clone(), doc.id.clone())) {
            return Err(StoreError::InvalidRequest {
                message: format!("duplicate markdown id {}:{}", doc.kind, doc.id),
            });
        }
    }
    Ok(docs)
}

fn walk_md(dir: &Path, docs: &mut Vec<NeuronDoc>) -> Result<(), StoreError> {
    let entries = fs::read_dir(dir).map_err(|error| io_message("read brain markdown", &error))?;
    for entry in entries {
        let entry = entry.map_err(|error| io_message("read brain markdown entry", &error))?;
        let path = entry.path();
        if path.is_dir() {
            walk_md(&path, docs)?;
            continue;
        }
        let is_md = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
        if !is_md {
            continue;
        }
        let text = fs::read_to_string(&path)
            .map_err(|error| io_message("read brain markdown file", &error))?;
        let doc = parse_neuron(&text).map_err(|error| StoreError::InvalidRequest {
            message: format!("markdown file {} is not a neuron ({})", path.display(), error.message),
        })?;
        docs.push(doc);
    }
    Ok(())
}

fn remove_stale(dir: &Path, written: &BTreeSet<String>) -> Result<(), StoreError> {
    for kind in ["claim", "fact", "episode"] {
        let folder = dir.join(kind);
        if !folder.is_dir() {
            continue;
        }
        let entries =
            fs::read_dir(&folder).map_err(|error| io_message("read exported neurons", &error))?;
        for entry in entries {
            let entry = entry.map_err(|error| io_message("read exported neuron", &error))?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.ends_with(".md") {
                continue;
            }
            let relative = format!("{kind}/{name}");
            if !written.contains(&relative) {
                fs::remove_file(entry.path())
                    .map_err(|error| io_message("remove stale neuron file", &error))?;
            }
        }
    }
    Ok(())
}

fn fts_or_empty(error: rusqlite::Error) -> Result<Vec<NeuronHit>, StoreError> {
    let message = error.to_string().to_lowercase();
    if message.contains("fts") || message.contains("syntax") {
        Ok(Vec::new())
    } else {
        Err(StoreError::from(error))
    }
}

fn parse_taint(taint: &str) -> Result<MemoryTaint, StoreError> {
    match taint {
        "untrusted" => Ok(MemoryTaint::Untrusted),
        "trusted" | "" => Ok(MemoryTaint::Trusted),
        _ => Err(StoreError::InvalidRequest {
            message: "neuron taint must be trusted or untrusted".to_owned(),
        }),
    }
}

fn nonempty(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_owned()
    } else {
        value.to_owned()
    }
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

fn immediate(connection: &mut Connection) -> Result<Transaction<'_>, StoreError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StoreError::from)
}

fn io_message(action: &str, error: &std::io::Error) -> StoreError {
    StoreError::InvalidRequest {
        message: format!("{action} failed ({error})"),
    }
}
