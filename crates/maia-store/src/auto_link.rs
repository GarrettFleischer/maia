//! Model-free links stored beside the neurons that produced them.

use std::collections::BTreeSet;

use maia_core::brain::AUTO_LINK_SOURCE;
use maia_core::brain::ExtractedLink;
use maia_core::brain::KnownNeuron;
use maia_core::brain::LinkTarget;
use maia_core::brain::extract_links;
use maia_core::brain::link_match_keys;
use maia_core::brain::neuron_slug;
use maia_core::brain::neuron_title;
use maia_core::security::Taint;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::error::StoreError;

/// Counts of auto-link edges after a full pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoLinkReport {
    /// Edges whose source tag is `auto-link`.
    pub edges: u64,
    /// References still waiting for a target neuron.
    pub pending: u64,
    /// Edge type and how many auto-link rows use it, then `pending`.
    pub by_type: Vec<(String, u64)>,
}

/// Refreshes the title index and auto-links for one neuron.
pub(crate) fn on_neuron_written(
    connection: &Connection,
    kind: &str,
    id: &str,
) -> Result<(), StoreError> {
    index_neuron(connection, kind, id)?;
    refresh_links(connection, kind, id)
}

/// Updates the keyword title without creating links.
pub(crate) fn index_neuron(
    connection: &Connection,
    kind: &str,
    id: &str,
) -> Result<(), StoreError> {
    let Some((body, taint)) = neuron_body(connection, kind, id)? else {
        return Ok(());
    };
    let title = neuron_title(id, &body);
    let updated = connection.execute(
        "UPDATE neuron_text SET title = ?1 WHERE kind = ?2 AND neuron_id = ?3",
        params![title, kind, id],
    )?;
    if updated == 0 {
        connection.execute(
            "INSERT INTO neuron_text (kind, neuron_id, title, body, taint, updated_at, deleted_at, aliases) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, '')",
            params![kind, id, title, body, taint],
        )?;
    }
    connection.execute(
        "DELETE FROM neuron_fts WHERE kind = ?1 AND neuron_id = ?2",
        params![kind, id],
    )?;
    connection.execute(
        "INSERT INTO neuron_fts (kind, neuron_id, title, body) VALUES (?1, ?2, ?3, ?4)",
        params![kind, id, title, body],
    )?;
    Ok(())
}

/// Rebuilds auto-link edges for every live neuron, then counts them.
pub(crate) fn relink_all(connection: &Connection) -> Result<AutoLinkReport, StoreError> {
    let mut statement =
        connection.prepare("SELECT kind, neuron_id FROM neuron_text WHERE deleted_at IS NULL")?;
    let mapped = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    drop(statement);
    for (kind, id) in rows {
        on_neuron_written(connection, &kind, &id)?;
    }
    link_report(connection)
}

pub(crate) fn link_report(connection: &Connection) -> Result<AutoLinkReport, StoreError> {
    let mut statement = connection.prepare(
        "SELECT edge_kind, COUNT(*) FROM edges WHERE source_tag = ?1 GROUP BY edge_kind ORDER BY edge_kind",
    )?;
    let mapped = statement.query_map(params![AUTO_LINK_SOURCE], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;
    let mut by_type = Vec::new();
    let mut edges = 0_u64;
    for row in mapped {
        let (kind, count): (String, i64) = row?;
        let count = u64::try_from(count).unwrap_or(0);
        edges = edges.saturating_add(count);
        by_type.push((kind, count));
    }
    drop(statement);
    let pending: i64 =
        connection.query_row("SELECT COUNT(*) FROM pending_links", [], |row| row.get(0))?;
    let pending = u64::try_from(pending).unwrap_or(0);
    if pending > 0 {
        by_type.push(("pending".to_owned(), pending));
    }
    Ok(AutoLinkReport {
        edges,
        pending,
        by_type,
    })
}

fn refresh_links(connection: &Connection, kind: &str, id: &str) -> Result<(), StoreError> {
    let Some((body, taint_text)) = neuron_body(connection, kind, id)? else {
        return Ok(());
    };
    let known = known_neurons(connection)?;
    let title = neuron_title(id, &body);
    let source = known
        .iter()
        .find(|neuron| neuron.kind == kind && neuron.id == id)
        .cloned()
        .unwrap_or(KnownNeuron {
            kind: kind.to_owned(),
            id: id.to_owned(),
            title: title.clone(),
            aliases: Vec::new(),
            slug: neuron_slug(kind, id, &title),
        });
    let taint = if taint_text == "untrusted" {
        Taint::Untrusted
    } else {
        Taint::Trusted
    };
    let links = extract_links(&body, &known, &source, taint);
    connection.execute(
        "DELETE FROM edges WHERE from_kind = ?1 AND from_id = ?2 AND source_tag = ?3",
        params![kind, id, AUTO_LINK_SOURCE],
    )?;
    connection.execute(
        "DELETE FROM pending_links WHERE source_kind = ?1 AND source_id = ?2",
        params![kind, id],
    )?;
    let mut seen_edges = BTreeSet::new();
    for link in &links {
        write_link(connection, kind, id, link, &mut seen_edges)?;
    }
    resolve_pending_for(connection, &source)?;
    Ok(())
}

fn write_link(
    connection: &Connection,
    kind: &str,
    id: &str,
    link: &ExtractedLink,
    seen: &mut BTreeSet<(String, String, String)>,
) -> Result<(), StoreError> {
    let taint = match link.taint {
        Taint::Trusted => "trusted",
        Taint::Untrusted => "untrusted",
    };
    let span_start = i64::try_from(link.span_start).unwrap_or(0);
    let span_end = i64::try_from(link.span_end).unwrap_or(span_start);
    match &link.target {
        LinkTarget::Resolved {
            kind: to_kind,
            id: to_id,
        } => {
            if to_kind == kind && to_id == id {
                return Ok(());
            }
            if !seen.insert((link.edge_type.to_owned(), to_kind.clone(), to_id.clone())) {
                return Ok(());
            }
            connection.execute(
                "INSERT OR IGNORE INTO edges \
                 (edge_kind, from_kind, from_id, to_kind, to_id, weight, source_tag, taint, span_start, span_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 1.0, ?6, ?7, ?8, ?9)",
                params![
                    link.edge_type,
                    kind,
                    id,
                    to_kind,
                    to_id,
                    AUTO_LINK_SOURCE,
                    taint,
                    span_start,
                    span_end
                ],
            )?;
        }
        LinkTarget::Pending { reference } => {
            connection.execute(
                "INSERT OR IGNORE INTO pending_links \
                 (source_kind, source_id, span_start, span_end, target_ref, edge_type, taint) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    kind,
                    id,
                    span_start,
                    span_end,
                    reference,
                    link.edge_type,
                    taint
                ],
            )?;
        }
    }
    Ok(())
}

fn resolve_pending_for(connection: &Connection, neuron: &KnownNeuron) -> Result<(), StoreError> {
    let keys = match_keys(neuron);
    let mut statement = connection.prepare(
        "SELECT source_kind, source_id, span_start, span_end, target_ref, edge_type, taint \
         FROM pending_links",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
        ))
    })?;
    let mut hits = Vec::new();
    for row in mapped {
        let (source_kind, source_id, span_start, span_end, target_ref, edge_type, taint): (
            String,
            String,
            i64,
            i64,
            String,
            String,
            String,
        ) = row?;
        if source_kind == neuron.kind && source_id == neuron.id {
            continue;
        }
        if link_match_keys(&target_ref)
            .iter()
            .any(|key| keys.contains(key))
        {
            hits.push((
                source_kind,
                source_id,
                span_start,
                span_end,
                target_ref,
                edge_type,
                taint,
            ));
        }
    }
    drop(statement);
    for (source_kind, source_id, span_start, span_end, target_ref, edge_type, taint) in hits {
        connection.execute(
            "INSERT OR IGNORE INTO edges \
             (edge_kind, from_kind, from_id, to_kind, to_id, weight, source_tag, taint, span_start, span_end) \
             VALUES (?1, ?2, ?3, ?4, ?5, 1.0, ?6, ?7, ?8, ?9)",
            params![
                edge_type,
                source_kind,
                source_id,
                neuron.kind,
                neuron.id,
                AUTO_LINK_SOURCE,
                taint,
                span_start,
                span_end
            ],
        )?;
        connection.execute(
            "DELETE FROM pending_links \
             WHERE source_kind = ?1 AND source_id = ?2 AND span_start = ?3 AND target_ref = ?4",
            params![source_kind, source_id, span_start, target_ref],
        )?;
    }
    Ok(())
}

fn match_keys(neuron: &KnownNeuron) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    keys.insert(neuron.id.to_lowercase());
    keys.insert(format!("{}/{}", neuron.kind, neuron.id).to_lowercase());
    keys.insert(neuron.slug.to_lowercase());
    for key in link_match_keys(&neuron.title) {
        keys.insert(key);
    }
    for alias in &neuron.aliases {
        for key in link_match_keys(alias) {
            keys.insert(key);
        }
    }
    keys
}

fn known_neurons(connection: &Connection) -> Result<Vec<KnownNeuron>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT kind, neuron_id, title, aliases FROM neuron_text WHERE deleted_at IS NULL",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    let mut neurons = Vec::new();
    for row in mapped {
        let (kind, id, title, aliases): (String, String, String, String) = row?;
        neurons.push(KnownNeuron {
            slug: neuron_slug(&kind, &id, &title),
            kind,
            id,
            title,
            aliases: aliases
                .split('\n')
                .filter(|alias| !alias.is_empty())
                .map(str::to_owned)
                .collect(),
        });
    }
    Ok(neurons)
}

fn neuron_body(
    connection: &Connection,
    kind: &str,
    id: &str,
) -> Result<Option<(String, String)>, StoreError> {
    let row = connection
        .query_row(
            "SELECT body, taint FROM neuron_text WHERE kind = ?1 AND neuron_id = ?2",
            params![kind, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row)
}
