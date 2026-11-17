//! Exploration memos: conclusions keyed to SHA-256 hashes of files read.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::error::StoreError;

/// Soft caps for exploration memo fields.
pub const MAX_TOPIC_CHARS: usize = 160;
/// Conclusion body budget (~400 tokens).
pub const MAX_CONCLUSION_CHARS: usize = 1600;
/// Max files attached to one memo.
pub const MAX_FILES_PER_MEMO: usize = 32;
/// Max path length stored with a memo.
pub const MAX_PATH_CHARS: usize = 512;

/// One file fingerprint recorded with an exploration memo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplorationFileRecord {
    /// Workspace-relative or absolute path as supplied at save.
    pub path: String,
    /// SHA-256 hex of file bytes at save time.
    pub content_sha256: String,
}

/// One stored exploration memo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplorationMemoRecord {
    /// Stable id.
    pub memo_id: String,
    /// Short topic key.
    pub topic: String,
    /// Conclusion text (secrets already redacted by caller).
    pub conclusion: String,
    /// Bot that saved the memo.
    pub observer_bot_id: String,
    /// Injected update time.
    pub updated_at: i64,
    /// Files hashed at save.
    pub files: Vec<ExplorationFileRecord>,
}

/// One exploration catalog command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExplorationRequest {
    /// Insert or replace a memo for a topic (same topic overwrites).
    Save {
        /// Topic key.
        topic: String,
        /// Conclusion body.
        conclusion: String,
        /// File path + hash pairs (hashes computed by caller).
        files: Vec<ExplorationFileRecord>,
        /// Observing bot id.
        observer_bot_id: String,
        /// Injected clock.
        now: i64,
    },
    /// Load by topic (exact) or by a file path that appears in a memo.
    Get {
        /// Topic to look up. Empty when searching by path.
        topic: String,
        /// Path to look up when topic is empty.
        path: String,
    },
    /// Delete by topic (throwaway cleanup).
    Delete {
        /// Topic key.
        topic: String,
    },
}

/// Result of an exploration command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExplorationResponse {
    /// One memo.
    Memo(ExplorationMemoRecord),
    /// Nothing found / deleted.
    Empty,
}

/// Applies `request` on the owner connection.
///
/// # Errors
///
/// Returns a validation or SQLite failure.
pub(crate) fn apply(
    connection: &Connection,
    request: &ExplorationRequest,
) -> Result<ExplorationResponse, StoreError> {
    match request {
        ExplorationRequest::Save {
            topic,
            conclusion,
            files,
            observer_bot_id,
            now,
        } => {
            let record = save(
                connection,
                topic,
                conclusion,
                files,
                observer_bot_id,
                *now,
            )?;
            Ok(ExplorationResponse::Memo(record))
        }
        ExplorationRequest::Get { topic, path } => match get(connection, topic, path)? {
            Some(record) => Ok(ExplorationResponse::Memo(record)),
            None => Ok(ExplorationResponse::Empty),
        },
        ExplorationRequest::Delete { topic } => {
            delete_by_topic(connection, topic)?;
            Ok(ExplorationResponse::Empty)
        }
    }
}

fn save(
    connection: &Connection,
    topic: &str,
    conclusion: &str,
    files: &[ExplorationFileRecord],
    observer_bot_id: &str,
    now: i64,
) -> Result<ExplorationMemoRecord, StoreError> {
    let topic = validate_topic(topic)?;
    let conclusion = validate_conclusion(conclusion)?;
    if files.is_empty() || files.len() > MAX_FILES_PER_MEMO {
        return Err(invalid(format!(
            "exploration files must be 1..={MAX_FILES_PER_MEMO}"
        )));
    }
    let mut normalized = Vec::with_capacity(files.len());
    for file in files {
        normalized.push(validate_file(file)?);
    }
    let memo_id = memo_id_for_topic(&topic);
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "DELETE FROM exploration_memo_files WHERE memo_id = ?1",
        params![memo_id],
    )?;
    transaction.execute(
        "DELETE FROM exploration_memos WHERE memo_id = ?1",
        params![memo_id],
    )?;
    transaction.execute(
        "INSERT INTO exploration_memos (memo_id, topic, conclusion, observer_bot_id, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![memo_id, topic, conclusion, observer_bot_id, now],
    )?;
    for file in &normalized {
        transaction.execute(
            "INSERT INTO exploration_memo_files (memo_id, path, content_sha256) VALUES (?1, ?2, ?3)",
            params![memo_id, file.path, file.content_sha256],
        )?;
    }
    transaction.commit()?;
    Ok(ExplorationMemoRecord {
        memo_id,
        topic,
        conclusion,
        observer_bot_id: observer_bot_id.to_owned(),
        updated_at: now,
        files: normalized,
    })
}

fn get(
    connection: &Connection,
    topic: &str,
    path: &str,
) -> Result<Option<ExplorationMemoRecord>, StoreError> {
    let topic = topic.trim();
    let path = path.trim();
    if !topic.is_empty() {
        let memo_id = memo_id_for_topic(topic);
        return load_by_id(connection, &memo_id);
    }
    if path.is_empty() {
        return Err(invalid("exploration get needs topic or path"));
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err(invalid("exploration path is too long"));
    }
    let memo_id: Option<String> = connection
        .query_row(
            "SELECT memo_id FROM exploration_memo_files WHERE path = ?1 \
             ORDER BY memo_id LIMIT 1",
            params![path],
            |row| row.get(0),
        )
        .optional()?;
    match memo_id {
        Some(id) => load_by_id(connection, &id),
        None => Ok(None),
    }
}

fn load_by_id(
    connection: &Connection,
    memo_id: &str,
) -> Result<Option<ExplorationMemoRecord>, StoreError> {
    let row: Option<(String, String, String, String, i64)> = connection
        .query_row(
            "SELECT memo_id, topic, conclusion, observer_bot_id, updated_at \
             FROM exploration_memos WHERE memo_id = ?1",
            params![memo_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((memo_id, topic, conclusion, observer_bot_id, updated_at)) = row else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT path, content_sha256 FROM exploration_memo_files WHERE memo_id = ?1 ORDER BY path",
    )?;
    let mapped = statement.query_map(params![memo_id], |row| {
        Ok(ExplorationFileRecord {
            path: row.get(0)?,
            content_sha256: row.get(1)?,
        })
    })?;
    let mut files = Vec::new();
    for file in mapped {
        files.push(file?);
    }
    Ok(Some(ExplorationMemoRecord {
        memo_id,
        topic,
        conclusion,
        observer_bot_id,
        updated_at,
        files,
    }))
}

fn delete_by_topic(connection: &Connection, topic: &str) -> Result<(), StoreError> {
    let topic = validate_topic(topic)?;
    let memo_id = memo_id_for_topic(&topic);
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "DELETE FROM exploration_memo_files WHERE memo_id = ?1",
        params![memo_id],
    )?;
    transaction.execute(
        "DELETE FROM exploration_memos WHERE memo_id = ?1",
        params![memo_id],
    )?;
    transaction.commit()?;
    Ok(())
}

fn memo_id_for_topic(topic: &str) -> String {
    let slug: String = topic
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let mut collapsed = String::new();
    let mut prev_dash = false;
    for ch in slug.chars() {
        if ch == '-' {
            if !prev_dash && !collapsed.is_empty() {
                collapsed.push('-');
                prev_dash = true;
            }
        } else {
            collapsed.push(ch);
            prev_dash = false;
        }
    }
    let trimmed = collapsed.trim_matches('-');
    let safe = if trimmed.is_empty() {
        "memo".to_owned()
    } else {
        trimmed.chars().take(48).collect()
    };
    format!("explore-{safe}")
}

fn validate_topic(raw: &str) -> Result<String, StoreError> {
    let topic = raw.trim();
    if topic.is_empty() || topic.chars().count() > MAX_TOPIC_CHARS {
        return Err(invalid(format!(
            "exploration topic must be 1..={MAX_TOPIC_CHARS} chars"
        )));
    }
    Ok(topic.to_owned())
}

fn validate_conclusion(raw: &str) -> Result<String, StoreError> {
    let conclusion = raw.trim();
    if conclusion.is_empty() || conclusion.chars().count() > MAX_CONCLUSION_CHARS {
        return Err(invalid(format!(
            "exploration conclusion must be 1..={MAX_CONCLUSION_CHARS} chars"
        )));
    }
    Ok(conclusion.to_owned())
}

fn validate_file(file: &ExplorationFileRecord) -> Result<ExplorationFileRecord, StoreError> {
    let path = file.path.trim();
    if path.is_empty() || path.chars().count() > MAX_PATH_CHARS {
        return Err(invalid("exploration path is invalid"));
    }
    let hash = file.content_sha256.trim().to_ascii_lowercase();
    if hash.len() != 64 || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(invalid("exploration content_sha256 must be 64 hex chars"));
    }
    Ok(ExplorationFileRecord {
        path: path.to_owned(),
        content_sha256: hash,
    })
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
            "maia-explore-{}-{}",
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
    fn save_get_by_topic_and_path_then_delete() {
        let store = open_store();
        let hash = "a".repeat(64);
        let saved = store
            .explorations(ExplorationRequest::Save {
                topic: "auth middleware".to_owned(),
                conclusion: "Login flows through middleware before handlers.".to_owned(),
                files: vec![ExplorationFileRecord {
                    path: "data/workspace/run76_a.rs".to_owned(),
                    content_sha256: hash.clone(),
                }],
                observer_bot_id: "bot-x".to_owned(),
                now: 10,
            })
            .expect("save");
        let ExplorationResponse::Memo(record) = saved else {
            panic!("expected memo");
        };
        assert!(record.memo_id.starts_with("explore-"));
        let ExplorationResponse::Memo(by_topic) = store
            .explorations(ExplorationRequest::Get {
                topic: "auth middleware".to_owned(),
                path: String::new(),
            })
            .expect("get topic")
        else {
            panic!("expected memo by topic");
        };
        assert_eq!(by_topic.conclusion, record.conclusion);
        let ExplorationResponse::Memo(by_path) = store
            .explorations(ExplorationRequest::Get {
                topic: String::new(),
                path: "data/workspace/run76_a.rs".to_owned(),
            })
            .expect("get path")
        else {
            panic!("expected memo by path");
        };
        assert_eq!(by_path.files[0].content_sha256, hash);
        store
            .explorations(ExplorationRequest::Delete {
                topic: "auth middleware".to_owned(),
            })
            .expect("delete");
        let gone = store
            .explorations(ExplorationRequest::Get {
                topic: "auth middleware".to_owned(),
                path: String::new(),
            })
            .expect("get after delete");
        assert_eq!(gone, ExplorationResponse::Empty);
    }
}
