//! Prompt-driven skills: save_skill / load_skill (honest leaves + store skin).

use maia_store::MAX_SKILL_BODY_CHARS;
use maia_store::SkillRecord;
use maia_store::SkillRequest;
use maia_store::SkillResponse;
use maia_store::SqliteOwner;
use maia_store::StoreError;

/// Hard catalog budget (~300 tokens).
pub const MAX_CATALOG_CHARS: usize = 1200;

/// One parsed skill tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillToolCall {
    /// Create or replace a skill.
    Save {
        /// Optional explicit id; empty → slug from title.
        skill_id: String,
        /// Display title.
        title: String,
        /// Catalog purpose line.
        when_to_use: String,
        /// Procedure body.
        body: String,
        /// Optional project.
        project: String,
    },
    /// Load one skill body into the tool result.
    Load {
        /// Skill id from the catalog.
        skill_id: String,
    },
}

/// Parses save_skill / load_skill arguments.
#[must_use]
pub fn parse_skill_tool(name: &str, arguments_json: &str) -> Option<SkillToolCall> {
    let value: serde_json::Value = serde_json::from_str(arguments_json).ok()?;
    match name {
        "save_skill" => {
            let title = clean_required(value.get("title")?.as_str()?, 80)?;
            let when_to_use = clean_required(
                value
                    .get("when_to_use")
                    .or_else(|| value.get("purpose"))?
                    .as_str()?,
                160,
            )?;
            let body = clean_required(value.get("body")?.as_str()?, MAX_SKILL_BODY_CHARS)?;
            let skill_id = value
                .get("skill_id")
                .or_else(|| value.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_owned();
            let project = value
                .get("project")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .chars()
                .take(64)
                .collect();
            Some(SkillToolCall::Save {
                skill_id,
                title,
                when_to_use,
                body,
                project,
            })
        }
        "load_skill" | "activate_skill" => {
            let skill_id = value
                .get("skill_id")
                .or_else(|| value.get("id"))?
                .as_str()?
                .trim();
            if skill_id.is_empty() || skill_id.len() > 64 {
                return None;
            }
            Some(SkillToolCall::Load {
                skill_id: skill_id.to_owned(),
            })
        }
        _ => None,
    }
}

fn clean_required(raw: &str, max: usize) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed.chars().count() > max {
        trimmed.chars().take(max).collect()
    } else {
        trimmed.to_owned()
    })
}

/// Applies one skill tool against the store.
///
/// # Errors
///
/// Returns store failures; callers surface a short tool result string instead.
pub fn apply_skill_tool(
    store: &SqliteOwner,
    call: &SkillToolCall,
    now: i64,
) -> Result<String, StoreError> {
    match call {
        SkillToolCall::Save {
            skill_id,
            title,
            when_to_use,
            body,
            project,
        } => {
            let response = store.skills(SkillRequest::Save {
                skill_id: skill_id.clone(),
                title: title.clone(),
                when_to_use: when_to_use.clone(),
                body: body.clone(),
                project: project.clone(),
                now,
            })?;
            let SkillResponse::Skill(record) = response else {
                return Ok("Skill saved.".to_owned());
            };
            Ok(format!(
                "Saved skill `{}` — {}.",
                record.skill_id, record.when_to_use
            ))
        }
        SkillToolCall::Load { skill_id } => {
            let response = store.skills(SkillRequest::Get {
                skill_id: skill_id.clone(),
            })?;
            let SkillResponse::Skill(record) = response else {
                return Ok(format!("Skill `{skill_id}` not found."));
            };
            let approx_tokens = (record.body.chars().count() + 3) / 4;
            if approx_tokens as i64 > record.max_tokens {
                return Ok(format!(
                    "Skill `{}` is over budget (≈{approx_tokens} tokens, max {}). Summarize it into a smaller skill first.",
                    record.skill_id, record.max_tokens
                ));
            }
            Ok(format_loaded_skill(&record))
        }
    }
}

fn format_loaded_skill(record: &SkillRecord) -> String {
    let mut out = format!(
        "## skill `{}`: {}\nWhen to use: {}\n\n{}",
        record.skill_id, record.title, record.when_to_use, record.body
    );
    if !record.project.is_empty() {
        out.push_str("\n\nProject: ");
        out.push_str(&record.project);
    }
    out
}

/// Builds the trailing skills catalog block (never put this in the stable system prefix).
#[must_use]
pub fn format_skills_catalog(skills: &[SkillRecord], max_chars: usize) -> String {
    if skills.is_empty() || max_chars < 20 {
        return String::new();
    }
    let mut out = String::from("## skills\nCall load_skill with a skill_id when a task matches.\n");
    for skill in skills {
        let line = format!("`{}` — {}\n", skill.skill_id, skill.when_to_use);
        if out.len() + line.len() > max_chars {
            break;
        }
        out.push_str(&line);
    }
    out
}

/// Approx catalog token cost (chars/4).
#[must_use]
pub fn catalog_token_estimate(catalog: &str) -> usize {
    (catalog.chars().count() + 3) / 4
}

/// JSON tool definitions for save_skill / load_skill.
#[must_use]
pub fn skill_tool_defs() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "save_skill",
                "description": "Save a reusable procedure or project coding rule as a named skill (not a one-line fact — use remember for facts). title, when_to_use (one line), and body (steps). Optional skill_id and project.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "when_to_use": {"type": "string"},
                        "body": {"type": "string"},
                        "skill_id": {"type": "string"},
                        "project": {"type": "string"}
                    },
                    "required": ["title", "when_to_use", "body"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "load_skill",
                "description": "Load a skill body from the ## skills catalog when the current task matches its when-to-use line. skill_id is required.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "skill_id": {"type": "string"}
                    },
                    "required": ["skill_id"]
                }
            }
        }),
    ]
}

/// Loads active skills for the trailing catalog.
#[must_use]
pub fn load_catalog_block(store: &SqliteOwner) -> String {
    let Ok(SkillResponse::List(skills)) = store.skills(SkillRequest::List) else {
        return String::new();
    };
    format_skills_catalog(&skills, MAX_CATALOG_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maia_store::OwnerOpen;
    use maia_store::slug_from_title;
    use std::fs;

    fn open_store() -> SqliteOwner {
        let directory = std::env::temp_dir().join(format!(
            "maia-skill-tools-{}-{}",
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
    fn parse_save_requires_fields() {
        assert!(parse_skill_tool("save_skill", r#"{"title":"x"}"#).is_none());
        assert_eq!(
            parse_skill_tool(
                "save_skill",
                r#"{"title":"Sort ints","when_to_use":"When PS sort fails","body":"Use Sort-Object { [int]$_ }."}"#
            ),
            Some(SkillToolCall::Save {
                skill_id: String::new(),
                title: "Sort ints".to_owned(),
                when_to_use: "When PS sort fails".to_owned(),
                body: "Use Sort-Object { [int]$_ }.".to_owned(),
                project: String::new(),
            })
        );
    }

    #[test]
    fn catalog_stays_under_budget_and_save_load_round_trip() {
        let store = open_store();
        let saved = apply_skill_tool(
            &store,
            &SkillToolCall::Save {
                skill_id: String::new(),
                title: "Sort ints in PowerShell".to_owned(),
                when_to_use: "When sorting bare integers in PowerShell.".to_owned(),
                body: "Use Sort-Object { [int]$_ } instead of -Property.".to_owned(),
                project: "run71".to_owned(),
            },
            10,
        )
        .expect("save");
        assert!(saved.contains("sort-ints-in-powershell") || saved.contains("Saved skill"));
        let id = slug_from_title("Sort ints in PowerShell").expect("slug");
        let loaded = apply_skill_tool(
            &store,
            &SkillToolCall::Load {
                skill_id: id.clone(),
            },
            11,
        )
        .expect("load");
        assert!(loaded.contains("Sort-Object { [int]$_ }"));
        let catalog = load_catalog_block(&store);
        assert!(catalog.starts_with("## skills\n"));
        assert!(catalog.contains(&id));
        assert!(catalog_token_estimate(&catalog) <= 300);
        assert!(catalog.len() <= MAX_CATALOG_CHARS);
    }

    #[test]
    fn format_skills_catalog_omits_when_empty() {
        assert!(format_skills_catalog(&[], 200).is_empty());
    }
}
