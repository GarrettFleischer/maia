//! Auto-activated skills: short named procedures and project coding rules.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::error::StoreError;

/// Soft body budget (~400 tokens ≈ 1600 chars).
pub const MAX_SKILL_BODY_CHARS: usize = 1600;
/// One-line purpose for the catalog.
pub const MAX_WHEN_TO_USE_CHARS: usize = 160;
/// Display title.
pub const MAX_TITLE_CHARS: usize = 80;
/// Optional project tag.
pub const MAX_PROJECT_CHARS: usize = 64;

/// One stored skill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRecord {
    /// Stable kebab id.
    pub skill_id: String,
    /// Short display name.
    pub title: String,
    /// One-line when-to-use for the catalog.
    pub when_to_use: String,
    /// Procedure / rule body (markdown).
    pub body: String,
    /// Optional project scope.
    pub project: String,
    /// Soft token cap for activation.
    pub max_tokens: i64,
    /// Last update time.
    pub updated_at: i64,
}

/// One skills catalog command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillRequest {
    /// List active (non-retired) skills.
    List,
    /// Load one skill by id (active only).
    Get {
        /// Skill id.
        skill_id: String,
    },
    /// Insert or replace a skill body.
    Save {
        /// Skill id (kebab). Empty → derived from title.
        skill_id: String,
        /// Display title.
        title: String,
        /// Catalog purpose line.
        when_to_use: String,
        /// Body text.
        body: String,
        /// Optional project.
        project: String,
        /// Injected clock.
        now: i64,
    },
    /// Retire (soft-delete) a skill.
    Delete {
        /// Skill id.
        skill_id: String,
        /// Injected clock.
        now: i64,
    },
}

/// Result of a skills command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillResponse {
    /// Catalog rows.
    List(Vec<SkillRecord>),
    /// One skill.
    Skill(SkillRecord),
    /// Nothing to return.
    Empty,
}

/// Applies `request` on the owner connection.
///
/// # Errors
///
/// Returns a validation, missing-skill, or SQLite failure.
pub(crate) fn apply(
    connection: &Connection,
    request: &SkillRequest,
) -> Result<SkillResponse, StoreError> {
    match request {
        SkillRequest::List => Ok(SkillResponse::List(list_active(connection)?)),
        SkillRequest::Get { skill_id } => Ok(SkillResponse::Skill(get_active(
            connection, skill_id,
        )?)),
        SkillRequest::Save {
            skill_id,
            title,
            when_to_use,
            body,
            project,
            now,
        } => {
            let record = save(
                connection,
                skill_id,
                title,
                when_to_use,
                body,
                project,
                *now,
            )?;
            Ok(SkillResponse::Skill(record))
        }
        SkillRequest::Delete { skill_id, now } => {
            retire(connection, skill_id, *now)?;
            Ok(SkillResponse::Empty)
        }
    }
}

fn list_active(connection: &Connection) -> Result<Vec<SkillRecord>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT skill_id, title, when_to_use, body, project, max_tokens, updated_at \
         FROM skills WHERE retired = 0 ORDER BY title COLLATE NOCASE, skill_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(SkillRecord {
            skill_id: row.get(0)?,
            title: row.get(1)?,
            when_to_use: row.get(2)?,
            body: row.get(3)?,
            project: row.get(4)?,
            max_tokens: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn get_active(connection: &Connection, skill_id: &str) -> Result<SkillRecord, StoreError> {
    connection
        .query_row(
            "SELECT skill_id, title, when_to_use, body, project, max_tokens, updated_at \
             FROM skills WHERE skill_id = ?1 AND retired = 0",
            params![skill_id],
            |row| {
                Ok(SkillRecord {
                    skill_id: row.get(0)?,
                    title: row.get(1)?,
                    when_to_use: row.get(2)?,
                    body: row.get(3)?,
                    project: row.get(4)?,
                    max_tokens: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "skill",
            id: skill_id.to_owned(),
        })
}

fn save(
    connection: &Connection,
    skill_id: &str,
    title: &str,
    when_to_use: &str,
    body: &str,
    project: &str,
    now: i64,
) -> Result<SkillRecord, StoreError> {
    let title = require_clipped(title, MAX_TITLE_CHARS, "title")?;
    let when_to_use = require_clipped(when_to_use, MAX_WHEN_TO_USE_CHARS, "when_to_use")?;
    let body = require_clipped(body, MAX_SKILL_BODY_CHARS, "body")?;
    let project = clip(project, MAX_PROJECT_CHARS);
    let id = if skill_id.trim().is_empty() {
        slug_from_title(&title).ok_or_else(|| invalid("skill title needs a usable id"))?
    } else {
        validate_skill_id(skill_id)?
    };
    connection.execute(
        "INSERT INTO skills (skill_id, title, when_to_use, body, project, max_tokens, updated_at, retired) \
         VALUES (?1, ?2, ?3, ?4, ?5, 400, ?6, 0) \
         ON CONFLICT(skill_id) DO UPDATE SET \
           title = excluded.title, \
           when_to_use = excluded.when_to_use, \
           body = excluded.body, \
           project = excluded.project, \
           max_tokens = excluded.max_tokens, \
           updated_at = excluded.updated_at, \
           retired = 0",
        params![id, title, when_to_use, body, project, now],
    )?;
    get_active(connection, &id)
}

fn retire(connection: &Connection, skill_id: &str, now: i64) -> Result<(), StoreError> {
    let updated = connection.execute(
        "UPDATE skills SET retired = 1, updated_at = ?2 WHERE skill_id = ?1 AND retired = 0",
        params![skill_id, now],
    )?;
    if updated == 0 {
        return Err(StoreError::NotFound {
            entity: "skill",
            id: skill_id.to_owned(),
        });
    }
    Ok(())
}

fn require_clipped(raw: &str, max: usize, field: &str) -> Result<String, StoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid(format!("{field} is required")));
    }
    Ok(clip(trimmed, max))
}

fn clip(raw: &str, max: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_owned();
    }
    trimmed.chars().take(max).collect()
}

/// Honest leaf: kebab-case id from a title.
#[must_use]
pub fn slug_from_title(title: &str) -> Option<String> {
    let mut out = String::new();
    let mut dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() || out.len() > 64 {
        None
    } else {
        Some(out)
    }
}

fn validate_skill_id(raw: &str) -> Result<String, StoreError> {
    let id = raw.trim();
    if id.is_empty() || id.len() > 64 {
        return Err(invalid("skill_id must be 1..=64 chars"));
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(invalid("skill_id must be kebab-case ascii"));
    }
    if id.starts_with('-') || id.ends_with('-') || id.contains("--") {
        return Err(invalid("skill_id must be kebab-case ascii"));
    }
    Ok(id.to_owned())
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::InvalidRequest {
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owner::SqliteOwner;
    use crate::types::OwnerOpen;
    use std::fs;

    fn open_store() -> SqliteOwner {
        let directory = std::env::temp_dir().join(format!(
            "maia-skills-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&directory).expect("dir");
        SqliteOwner::open(OwnerOpen {
            path: directory.join("maia.sqlite"),
            now: 1,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("open")
    }

    #[test]
    fn slug_from_title_is_kebab() {
        assert_eq!(
            slug_from_title("Broken Sort then cast"),
            Some("broken-sort-then-cast".to_owned())
        );
        assert!(slug_from_title("!!!").is_none());
    }

    #[test]
    fn save_list_get_and_delete_round_trip() {
        let store = open_store();
        let saved = store
            .skills(SkillRequest::Save {
                skill_id: String::new(),
                title: "Broken Sort then cast".to_owned(),
                when_to_use: "When sorting numbers in PowerShell after Sort-Object fails.".to_owned(),
                body: "Do not use Sort-Object -Property on bare ints. Pipe through Sort-Object { [int]$_ }.".to_owned(),
                project: "maia".to_owned(),
                now: 50,
            })
            .expect("save");
        let SkillResponse::Skill(record) = saved else {
            panic!("expected skill");
        };
        assert_eq!(record.skill_id, "broken-sort-then-cast");
        let SkillResponse::List(list) = store.skills(SkillRequest::List).expect("list") else {
            panic!("expected list");
        };
        assert_eq!(list.len(), 1);
        let SkillResponse::Skill(loaded) = store
            .skills(SkillRequest::Get {
                skill_id: "broken-sort-then-cast".to_owned(),
            })
            .expect("get")
        else {
            panic!("expected skill");
        };
        assert!(loaded.body.contains("Sort-Object { [int]$_ }"));
        store
            .skills(SkillRequest::Delete {
                skill_id: "broken-sort-then-cast".to_owned(),
                now: 60,
            })
            .expect("delete");
        let SkillResponse::List(after) = store.skills(SkillRequest::List).expect("list2") else {
            panic!("expected list");
        };
        assert!(after.is_empty());
    }
}
