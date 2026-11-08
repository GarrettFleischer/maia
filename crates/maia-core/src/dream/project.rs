//! Idempotent vault projection descriptions. No filesystem or model call.

use std::collections::BTreeMap;

use crate::dream::batch::EntityScope;
use crate::dream::consolidate::EntityRow;
use crate::dream::consolidate::ProjectionProgress;
use crate::dream::consolidate::ProjectionRecord;
use crate::dream::error::DreamError;
use crate::dream::prepass::DreamFact;
use crate::dream::prepass::FactCurrency;
use crate::vault::EntityFact;
use crate::vault::NoteHeader;
use crate::vault::VaultPath;
use crate::vault::is_personality_note;
use crate::vault::parse_note;
use crate::vault::render_entity_page;
use crate::vault::render_index;

/// Existing entity bytes supplied by the vault skin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSource {
    /// Vault-relative path.
    pub path: VaultPath,
    /// Bytes observed at render time.
    pub current_bytes: Vec<u8>,
    /// Bytes read when staging began.
    pub bytes_read_for_rendering: Vec<u8>,
}

/// One entity page outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageOutcome {
    /// Complete replacement bytes.
    Replace {
        /// Target path.
        path: VaultPath,
        /// Full file bytes.
        bytes: Vec<u8>,
    },
    /// Current bytes changed. Do not write the stale render.
    Restage {
        /// Target path.
        path: VaultPath,
    },
    /// This file is left untouched.
    Blocked {
        /// Target path.
        path: VaultPath,
        /// Why it was not written.
        error: DreamError,
    },
}

/// Rendered projection. Calling it twice with the same inputs returns the same value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionRender {
    /// Entity page outcomes.
    pub pages: Vec<PageOutcome>,
    /// Folder index bodies.
    pub indexes: Vec<(VaultPath, String)>,
    /// Pending while any page is blocked or restaged.
    pub progress: ProjectionProgress,
}

/// Rejects `personality.md` before any replacement bytes are produced.
pub fn screen_projection_path(path: &VaultPath) -> Result<(), DreamError> {
    if is_personality_note(path)
        || path.as_str().ends_with("/personality")
        || path.as_str() == "personality"
    {
        Err(DreamError::PersonalityTarget)
    } else {
        Ok(())
    }
}

/// Renders entity pages and indexes from committed rows.
pub fn render_projection(
    record: &ProjectionRecord,
    entities: &[EntityRow],
    facts: &[DreamFact],
    pages: &[PageSource],
    index_children: &BTreeMap<VaultPath, Vec<NoteHeader>>,
) -> Result<ProjectionRender, DreamError> {
    let mut selected = Vec::new();
    for id in &record.entities {
        let entity = entities
            .iter()
            .find(|entity| &entity.id == id)
            .ok_or(DreamError::UnknownId)?;
        let path = entity_path(entity)?;
        screen_projection_path(&path)?;
        selected.push((entity, path));
    }
    for page in pages {
        screen_projection_path(&page.path)?;
    }
    let mut outcomes = Vec::new();
    for (entity, path) in &selected {
        outcomes.push(render_entity(entity, path, entities, facts, pages)?);
    }
    let mut indexes = Vec::new();
    for folder in &record.folders {
        screen_projection_path(folder)?;
        let children = index_children.get(folder).map(Vec::as_slice).unwrap_or(&[]);
        indexes.push((folder.clone(), render_index(children)));
    }
    let progress = if outcomes.iter().any(|outcome| {
        matches!(
            outcome,
            PageOutcome::Blocked { .. } | PageOutcome::Restage { .. }
        )
    }) {
        ProjectionProgress::Pending
    } else {
        ProjectionProgress::Complete
    };
    Ok(ProjectionRender {
        pages: outcomes,
        indexes,
        progress,
    })
}

fn render_entity(
    entity: &EntityRow,
    path: &VaultPath,
    entities: &[EntityRow],
    facts: &[DreamFact],
    pages: &[PageSource],
) -> Result<PageOutcome, DreamError> {
    let rows = current_fact_rows(entity, facts);
    let links = resolved_links(entity, entities)?;
    let Some(page) = pages.iter().find(|page| &page.path == path) else {
        let bytes = render_entity_page(&new_skeleton(entity, &links)?, &rows)
            .map_err(|_| DreamError::InvalidRegionMarkers)?;
        return Ok(PageOutcome::Replace {
            path: path.clone(),
            bytes: bytes.into_bytes(),
        });
    };
    if page.current_bytes != page.bytes_read_for_rendering {
        return Ok(PageOutcome::Restage { path: path.clone() });
    }
    let text =
        std::str::from_utf8(&page.current_bytes).map_err(|_| DreamError::InvalidRegionMarkers)?;
    let parsed =
        parse_note(page.current_bytes.as_slice()).map_err(|_| DreamError::FrontmatterMismatch)?;
    if parsed.frontmatter.id != entity.id.as_str() {
        return Ok(PageOutcome::Blocked {
            path: path.clone(),
            error: DreamError::FrontmatterMismatch,
        });
    }
    match render_entity_page(text, &rows) {
        Ok(bytes) => Ok(PageOutcome::Replace {
            path: path.clone(),
            bytes: bytes.into_bytes(),
        }),
        Err(_) => Ok(PageOutcome::Blocked {
            path: path.clone(),
            error: DreamError::InvalidRegionMarkers,
        }),
    }
}

fn current_fact_rows(entity: &EntityRow, facts: &[DreamFact]) -> Vec<EntityFact> {
    let mut rows = Vec::new();
    for fact in facts {
        if fact.entity_id.as_ref() == Some(&entity.id) && fact.currency == FactCurrency::Current {
            rows.push(EntityFact {
                id: fact.id.as_str().to_owned(),
                sentence: fact.sentence.clone(),
            });
        }
    }
    rows
}

fn resolved_links(entity: &EntityRow, entities: &[EntityRow]) -> Result<Vec<String>, DreamError> {
    let mut links = Vec::with_capacity(entity.see.len());
    for id in &entity.see {
        let target = entities
            .iter()
            .find(|candidate| &candidate.id == id)
            .ok_or(DreamError::UnknownId)?;
        links.push(entity_path(target)?.as_str().to_owned());
    }
    Ok(links)
}

fn new_skeleton(entity: &EntityRow, links: &[String]) -> Result<String, DreamError> {
    let mut see = String::new();
    if links.is_empty() {
        see.push_str("see: []\n");
    } else {
        see.push_str("see:\n");
        for link in links {
            see.push_str("  - \"[[");
            see.push_str(link);
            see.push_str("]]\"\n");
        }
    }
    Ok(format!(
        "---\nid: {id}\ndescription: {description}\n{see}kind: entity\n---\n<!-- maia:generated:start -->\n<!-- maia:generated:end -->\n<!-- maia:human:start -->\n<!-- maia:human:end -->\n",
        id = entity.id.as_str(),
        description = entity.description,
    ))
}

fn entity_path(entity: &EntityRow) -> Result<VaultPath, DreamError> {
    let raw = match &entity.scope {
        EntityScope::World => format!("world/entities/{}", entity.slug),
        EntityScope::Agent { agent_id } => format!("agents/{agent_id}/entities/{}", entity.slug),
    };
    VaultPath::parse(&raw).map_err(|_error| DreamError::InvalidSlug)
}
