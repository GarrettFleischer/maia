//! Prompt-driven brain writes and progressive-disclosure recall tools.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use maia_core::brain::LexicalPolicy;
use maia_core::brain::lexemes_for_sentence;
use maia_core::brain::merge_keyword_first;
use maia_core::dream::MAX_CLAIM_SENTENCE_CHARS;
use maia_core::memory_redact::redact_secrets_for_save;
use maia_core::thread_cache::compact_recall_title;
use maia_store::AppendEvents;
use maia_store::EpisodeWrite;
use maia_store::ExplorationFileRecord;
use maia_store::ExplorationRequest;
use maia_store::ExplorationResponse;
use maia_store::MemoryTaint;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionReplaceWrite;
use maia_store::PromotionWrite;
use maia_store::SegmentWrite;
use maia_store::SqliteOwner;
use maia_store::StoreError;
use maia_store::ThreadEventWrite;
use sha2::Digest;
use sha2::Sha256;

use crate::inspector::ROUTER_THREAD;

static REMEMBER_SEQ: AtomicU64 = AtomicU64::new(1);

/// Cap for compact search_memories results.
pub const SEARCH_RESULT_LIMIT: usize = 12;

/// Cap for get_memories ids in one call.
pub const GET_MEMORIES_LIMIT: usize = 8;

/// Soft caps for decision reason / alternatives fields.
const MAX_REASON_CHARS: usize = 240;
const MAX_ALTERNATIVES_CHARS: usize = 240;

/// One parsed memory tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryToolCall {
    /// Insert one new durable claim.
    Remember {
        /// One-sentence claim.
        sentence: String,
    },
    /// Replace an existing claim with a successor sentence.
    Update {
        /// Existing claim id.
        claim_id: String,
        /// Successor sentence.
        sentence: String,
        /// Why this decision / change.
        reason: Option<String>,
        /// Options considered and discarded.
        alternatives: Option<String>,
    },
    /// Hide a claim (retire).
    Retire {
        /// Claim id to hide.
        claim_id: String,
    },
    /// Compact keyword+meaning search (ids + short titles).
    Search {
        /// Free-text query (exact codes/filenames welcome).
        query: String,
    },
    /// Load full text for a few memory ids.
    Get {
        /// Claim/fact ids from recall or search_memories.
        ids: Vec<String>,
    },
    /// Save an exploration memo keyed to file content hashes.
    SaveExploration {
        /// Short topic key.
        topic: String,
        /// Conclusion about how the code fits together.
        conclusion: String,
        /// File paths read while forming the conclusion.
        files: Vec<String>,
    },
    /// Load an exploration memo by topic or path; report file freshness.
    GetExploration {
        /// Topic key (preferred).
        topic: Option<String>,
        /// File path lookup when topic is absent.
        path: Option<String>,
    },
    /// Delete an exploration memo by topic (cleanup / tests).
    DeleteExploration {
        /// Topic key.
        topic: String,
    },
}

/// Parses remember / update_memory / retire_memory / search_memories / get_memories /
/// save_exploration / get_exploration.
#[must_use]
pub fn parse_memory_tool(name: &str, arguments_json: &str) -> Option<MemoryToolCall> {
    let value: serde_json::Value = serde_json::from_str(arguments_json).ok()?;
    match name {
        "remember" => {
            let sentence = clean_sentence(value.get("message").or_else(|| value.get("sentence"))?)?;
            Some(MemoryToolCall::Remember { sentence })
        }
        "update_memory" => {
            let claim_id = value.get("claim_id")?.as_str()?.trim();
            if claim_id.is_empty() || claim_id.len() > 128 {
                return None;
            }
            let sentence = clean_sentence(value.get("message").or_else(|| value.get("sentence"))?)?;
            Some(MemoryToolCall::Update {
                claim_id: claim_id.to_owned(),
                sentence,
                reason: optional_short_field(&value, "reason", MAX_REASON_CHARS),
                alternatives: optional_short_field(&value, "alternatives", MAX_ALTERNATIVES_CHARS),
            })
        }
        "retire_memory" => {
            let claim_id = value
                .get("claim_id")
                .or_else(|| value.get("message"))?
                .as_str()?
                .trim();
            if claim_id.is_empty() || claim_id.len() > 128 {
                return None;
            }
            Some(MemoryToolCall::Retire {
                claim_id: claim_id.to_owned(),
            })
        }
        "search_memories" | "recall" => {
            let query = value
                .get("query")
                .or_else(|| value.get("message"))?
                .as_str()?
                .trim();
            if query.is_empty() || query.len() > 400 {
                return None;
            }
            Some(MemoryToolCall::Search {
                query: query.to_owned(),
            })
        }
        "get_memories" => {
            let ids = parse_ids(&value)?;
            if ids.is_empty() {
                return None;
            }
            Some(MemoryToolCall::Get { ids })
        }
        "save_exploration" => {
            let topic = value.get("topic")?.as_str()?.trim();
            if topic.is_empty() || topic.chars().count() > maia_store::MAX_TOPIC_CHARS {
                return None;
            }
            let conclusion = value
                .get("conclusion")
                .or_else(|| value.get("message"))?
                .as_str()?
                .trim();
            if conclusion.is_empty()
                || conclusion.chars().count() > maia_store::MAX_CONCLUSION_CHARS
            {
                return None;
            }
            let files = parse_file_paths(&value)?;
            if files.is_empty() {
                return None;
            }
            Some(MemoryToolCall::SaveExploration {
                topic: topic.to_owned(),
                conclusion: conclusion.to_owned(),
                files,
            })
        }
        "get_exploration" => {
            let topic = value
                .get("topic")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let path = value
                .get("path")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            if topic.is_none() && path.is_none() {
                return None;
            }
            Some(MemoryToolCall::GetExploration { topic, path })
        }
        "delete_exploration" => {
            let topic = value
                .get("topic")
                .or_else(|| value.get("message"))?
                .as_str()?
                .trim();
            if topic.is_empty() || topic.chars().count() > maia_store::MAX_TOPIC_CHARS {
                return None;
            }
            Some(MemoryToolCall::DeleteExploration {
                topic: topic.to_owned(),
            })
        }
        _ => None,
    }
}

fn optional_short_field(
    value: &serde_json::Value,
    key: &str,
    max_chars: usize,
) -> Option<String> {
    let raw = value.get(key)?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let clipped: String = raw.chars().take(max_chars).collect();
    Some(clipped)
}

fn parse_file_paths(value: &serde_json::Value) -> Option<Vec<String>> {
    let arr = value.get("files")?.as_array()?;
    let mut files = Vec::new();
    for item in arr {
        let path = item.as_str()?.trim();
        if path.is_empty() || path.chars().count() > maia_store::MAX_PATH_CHARS {
            return None;
        }
        files.push(path.to_owned());
        if files.len() >= maia_store::MAX_FILES_PER_MEMO {
            break;
        }
    }
    Some(files)
}

fn parse_ids(value: &serde_json::Value) -> Option<Vec<String>> {
    if let Some(arr) = value.get("ids").and_then(|v| v.as_array()) {
        let mut ids = Vec::new();
        for item in arr {
            let id = item.as_str()?.trim();
            if id.is_empty() || id.len() > 128 {
                return None;
            }
            ids.push(id.to_owned());
            if ids.len() >= GET_MEMORIES_LIMIT {
                break;
            }
        }
        return Some(ids);
    }
    let single = value
        .get("claim_id")
        .or_else(|| value.get("id"))
        .or_else(|| value.get("message"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 128)?;
    Some(vec![single.to_owned()])
}

fn clean_sentence(value: &serde_json::Value) -> Option<String> {
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let sentence = if raw.chars().count() > MAX_CLAIM_SENTENCE_CHARS {
        raw.chars().take(MAX_CLAIM_SENTENCE_CHARS).collect()
    } else {
        raw.to_owned()
    };
    Some(sentence)
}

/// Appends optional decision reason / discarded alternatives onto a claim sentence.
#[must_use]
pub fn sentence_with_decision(
    sentence: &str,
    reason: Option<&str>,
    alternatives: Option<&str>,
) -> String {
    let reason = reason.map(str::trim).filter(|s| !s.is_empty());
    let alternatives = alternatives.map(str::trim).filter(|s| !s.is_empty());
    match (reason, alternatives) {
        (None, None) => sentence.to_owned(),
        (Some(why), None) => format!("{sentence} (why: {why})"),
        (None, Some(discarded)) => format!("{sentence} (discarded: {discarded})"),
        (Some(why), Some(discarded)) => {
            format!("{sentence} (why: {why}; discarded: {discarded})")
        }
    }
}

/// SHA-256 hex of raw file bytes.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn fact_lexemes(sentence: &str) -> Vec<String> {
    let policy = LexicalPolicy {
        stopwords: std::collections::BTreeSet::from([
            "a".to_owned(),
            "an".to_owned(),
            "and".to_owned(),
            "or".to_owned(),
            "the".to_owned(),
            "this".to_owned(),
        ]),
        fan_out: std::collections::BTreeMap::new(),
        high_fan_cutoff: u32::MAX,
    };
    lexemes_for_sentence(sentence, &policy)
        .into_iter()
        .map(|lexeme| lexeme.as_str().to_owned())
        .collect()
}

fn next_ids(now: i64) -> (String, String, String) {
    let seq = REMEMBER_SEQ.fetch_add(1, Ordering::Relaxed);
    (
        format!("episode-remember-{now}-{seq}"),
        format!("turn-remember-{now}-{seq}"),
        format!("claim-remember-{now}-{seq}"),
    )
}

/// Formats a compact search hit list (id + short title).
#[must_use]
pub fn format_compact_memory_hits(hits: &[(String, String)]) -> String {
    if hits.is_empty() {
        return "No memories matched.".to_owned();
    }
    let mut out = String::from(
        "## memories\nCall get_memories with ids for full text.\n",
    );
    for (id, title) in hits {
        out.push_str(&format!("`{id}` — {}\n", compact_recall_title(title)));
    }
    out
}

/// Formats full memory bodies for get_memories (includes a short previously line when present).
#[must_use]
pub fn format_memory_bodies(rows: &[(String, String, Option<String>)]) -> String {
    if rows.is_empty() {
        return "No memories found for those ids.".to_owned();
    }
    let mut out = String::from("## memory bodies\n");
    for (id, sentence, previous) in rows {
        out.push_str(&format!("`{id}`: {sentence}\n"));
        if let Some(prev) = previous {
            let clipped: String = prev.chars().take(160).collect();
            out.push_str(&format!("  previously: {clipped}\n"));
        }
    }
    out
}

/// Keyword-first search: exact FTS, then porter neuron FTS, then claim rows by id order.
#[must_use]
pub fn compact_search_hits(
    store: &SqliteOwner,
    query: &str,
    limit: usize,
) -> Vec<(String, String)> {
    let exact = store
        .search_memory_exact(query, i64::try_from(limit).unwrap_or(12))
        .unwrap_or_default();
    let neurons = store
        .search_neurons(query, i64::try_from(limit).unwrap_or(12))
        .unwrap_or_default();
    let exact_ids: Vec<String> = exact
        .iter()
        .filter(|hit| hit.kind == "claim" || hit.kind == "fact")
        .map(|hit| hit.id.clone())
        .collect();
    let meaning_ids: Vec<String> = neurons
        .iter()
        .filter(|hit| hit.kind == "claim" || hit.kind == "fact")
        .map(|hit| hit.id.clone())
        .collect();
    let merged = merge_keyword_first(&exact_ids, &meaning_ids, limit);
    let mut titles = std::collections::BTreeMap::new();
    for hit in exact.iter().chain(neurons.iter()) {
        titles.insert(hit.id.clone(), hit.title.clone());
    }
    merged
        .into_iter()
        .filter_map(|id| {
            let title = titles.get(&id)?.clone();
            Some((id, title))
        })
        .collect()
}

/// Resolves a path for hashing: absolute as-is, else under `workspace_root`.
#[must_use]
pub fn resolve_exploration_path(workspace_root: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace_root.join(path)
    }
}

fn hash_workspace_file(workspace_root: &Path, raw: &str) -> Result<(String, String), String> {
    let resolved = resolve_exploration_path(workspace_root, raw);
    let bytes = std::fs::read(&resolved).map_err(|_| format!("missing:{raw}"))?;
    Ok((raw.to_owned(), sha256_hex(&bytes)))
}

fn format_exploration_get(
    conclusion: &str,
    files: &[(String, FileFreshness)],
) -> String {
    let mut out = format!("## exploration\n{conclusion}\n## files\n");
    for (path, status) in files {
        let label = match status {
            FileFreshness::Unchanged => "unchanged",
            FileFreshness::Changed => "changed",
            FileFreshness::Missing => "missing",
        };
        out.push_str(&format!("`{path}` — {label}\n"));
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileFreshness {
    Unchanged,
    Changed,
    Missing,
}

fn classify_file(workspace_root: &Path, path: &str, expected_hash: &str) -> FileFreshness {
    let resolved = resolve_exploration_path(workspace_root, path);
    match std::fs::read(&resolved) {
        Ok(bytes) => {
            if sha256_hex(&bytes) == expected_hash {
                FileFreshness::Unchanged
            } else {
                FileFreshness::Changed
            }
        }
        Err(_) => FileFreshness::Missing,
    }
}

/// Applies one memory tool against the shared brain. Never logs sentence contents.
///
/// `known_secret_values` are CEO-stored secret values (Credential Manager) when cheaply
/// available; patterns and `<private>` blocks are always scrubbed before save.
/// `workspace_root` is used only by exploration tools to hash file contents.
///
/// # Errors
///
/// Returns store failures; callers surface a short tool result string instead.
pub fn apply_memory_tool(
    store: &SqliteOwner,
    call: &MemoryToolCall,
    bot_id: &str,
    now: i64,
    known_secret_values: &[&str],
    workspace_root: &Path,
) -> Result<String, StoreError> {
    match call {
        MemoryToolCall::Remember { sentence } => {
            let sentence = redact_secrets_for_save(sentence, known_secret_values);
            let (episode_id, turn_id, claim_id) = next_ids(now);
            ensure_router_thread(store, now)?;
            store.insert_episode(EpisodeWrite {
                episode_id: episode_id.clone(),
                thread_id: ROUTER_THREAD.to_owned(),
                turn_id,
                body: format!("Agent remembered a durable fact."),
                taint: MemoryTaint::Trusted,
                reasoning: None,
                participants: "agent".to_owned(),
                created_at: now,
                segments: vec![SegmentWrite {
                    text: sentence.clone(),
                    taint: MemoryTaint::Trusted,
                    sources: "agent".to_owned(),
                }],
            })?;
            store.apply_promotion(PromotionWrite {
                episode_id,
                model: "agent-remember".to_owned(),
                now,
                claims: vec![PromotionClaimWrite {
                    claim_id: claim_id.clone(),
                    sentence: sentence.clone(),
                    taint: MemoryTaint::Trusted,
                    valid_from: now,
                    lexemes: fact_lexemes(&sentence),
                    memory_kind: "explicit".to_owned(),
                    memory_scope: "agent".to_owned(),
                    observer_bot_id: bot_id.to_owned(),
                    flagged_beside_lock: false,
                }],
                same_claim_ids: Vec::new(),
                replacements: Vec::new(),
                links: Vec::new(),
                session_bot_id: String::new(),
                session_summary: String::new(),
            })?;
            let _ = store.bots(maia_store::BotRequest::NoteProvenance {
                target_kind: "claim".to_owned(),
                target_id: claim_id.clone(),
                bot_id: bot_id.to_owned(),
                session_id: format!("remember-{now}"),
                noted_at: now,
            });
            Ok(format!("Remembered as {claim_id}."))
        }
        MemoryToolCall::Update {
            claim_id,
            sentence,
            reason,
            alternatives,
        } => {
            let sentence = sentence_with_decision(
                sentence,
                reason.as_deref(),
                alternatives.as_deref(),
            );
            let sentence = redact_secrets_for_save(&sentence, known_secret_values);
            let (episode_id, turn_id, new_claim_id) = next_ids(now);
            ensure_router_thread(store, now)?;
            store.insert_episode(EpisodeWrite {
                episode_id: episode_id.clone(),
                thread_id: ROUTER_THREAD.to_owned(),
                turn_id,
                body: "Agent updated a durable fact.".to_owned(),
                taint: MemoryTaint::Trusted,
                reasoning: None,
                participants: "agent".to_owned(),
                created_at: now,
                segments: vec![SegmentWrite {
                    text: sentence.clone(),
                    taint: MemoryTaint::Trusted,
                    sources: "agent".to_owned(),
                }],
            })?;
            store.apply_promotion(PromotionWrite {
                episode_id,
                model: "agent-update".to_owned(),
                now,
                claims: vec![PromotionClaimWrite {
                    claim_id: new_claim_id.clone(),
                    sentence: sentence.clone(),
                    taint: MemoryTaint::Trusted,
                    valid_from: now,
                    lexemes: fact_lexemes(&sentence),
                    memory_kind: "explicit".to_owned(),
                    memory_scope: "agent".to_owned(),
                    observer_bot_id: bot_id.to_owned(),
                    flagged_beside_lock: false,
                }],
                same_claim_ids: Vec::new(),
                replacements: vec![PromotionReplaceWrite {
                    old_claim_id: claim_id.clone(),
                    new_claim_id: new_claim_id.clone(),
                }],
                links: Vec::new(),
                session_bot_id: String::new(),
                session_summary: String::new(),
            })?;
            Ok(format!("Updated {claim_id} → {new_claim_id}."))
        }
        MemoryToolCall::Retire { claim_id } => {
            store.forget_claim(claim_id.clone())?;
            Ok(format!("Retired {claim_id}."))
        }
        MemoryToolCall::Search { query } => {
            let hits = compact_search_hits(store, query, SEARCH_RESULT_LIMIT);
            Ok(format_compact_memory_hits(&hits))
        }
        MemoryToolCall::Get { ids } => {
            let rows = store.memory_bodies(ids)?;
            let pairs: Vec<(String, String, Option<String>)> = rows
                .into_iter()
                .map(|row| (row.id, row.sentence, row.previous))
                .collect();
            Ok(format_memory_bodies(&pairs))
        }
        MemoryToolCall::SaveExploration {
            topic,
            conclusion,
            files,
        } => {
            let conclusion = redact_secrets_for_save(conclusion, known_secret_values);
            let mut hashed = Vec::with_capacity(files.len());
            for path in files {
                match hash_workspace_file(workspace_root, path) {
                    Ok((path, content_sha256)) => hashed.push(ExplorationFileRecord {
                        path,
                        content_sha256,
                    }),
                    Err(_) => {
                        return Ok(format!(
                            "Could not read `{path}` to hash for exploration memo."
                        ));
                    }
                }
            }
            match store.explorations(ExplorationRequest::Save {
                topic: topic.clone(),
                conclusion,
                files: hashed,
                observer_bot_id: bot_id.to_owned(),
                now,
            })? {
                ExplorationResponse::Memo(record) => {
                    Ok(format!("Saved exploration `{}`.", record.memo_id))
                }
                ExplorationResponse::Empty => Ok("Could not save exploration.".to_owned()),
            }
        }
        MemoryToolCall::GetExploration { topic, path } => {
            let response = store.explorations(ExplorationRequest::Get {
                topic: topic.clone().unwrap_or_default(),
                path: path.clone().unwrap_or_default(),
            })?;
            let ExplorationResponse::Memo(record) = response else {
                return Ok("No exploration memo matched.".to_owned());
            };
            let statuses: Vec<(String, FileFreshness)> = record
                .files
                .iter()
                .map(|file| {
                    (
                        file.path.clone(),
                        classify_file(workspace_root, &file.path, &file.content_sha256),
                    )
                })
                .collect();
            Ok(format_exploration_get(&record.conclusion, &statuses))
        }
        MemoryToolCall::DeleteExploration { topic } => {
            store.explorations(ExplorationRequest::Delete {
                topic: topic.clone(),
            })?;
            Ok(format!("Deleted exploration for topic `{topic}`."))
        }
    }
}

fn ensure_router_thread(store: &SqliteOwner, now: i64) -> Result<(), StoreError> {
    match store.thread(ROUTER_THREAD) {
        Ok(_) => Ok(()),
        Err(StoreError::NotFound { .. }) => {
            store.append(AppendEvents {
                thread_id: ROUTER_THREAD.to_owned(),
                expected_version: 0,
                participants: "owner".to_owned(),
                occurred_at: now,
                events: vec![ThreadEventWrite {
                    event_id: "router-open-remember".to_owned(),
                    kind: "system".to_owned(),
                    body: "Router".to_owned(),
                }],
            })?;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// JSON tool definitions for memory tools.
#[must_use]
pub fn memory_tool_defs() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "remember",
                "description": "Save one durable fact to the shared brain (preference, name, project rule, what was tried and failed, important info from docs/sites). message is one short sentence. Skip greetings and transient status.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": {"type": "string"}
                    },
                    "required": ["message"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "update_memory",
                "description": "Replace an existing brain claim when the fact changed. claim_id from recall or search_memories; message is the new one-sentence fact. Optional reason (why) and alternatives (options discarded) are stored with the decision; the prior sentence stays as history.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "claim_id": {"type": "string"},
                        "message": {"type": "string"},
                        "reason": {"type": "string"},
                        "alternatives": {"type": "string"}
                    },
                    "required": ["claim_id", "message"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "retire_memory",
                "description": "Hide a brain claim that is wrong or no longer true. claim_id from recall or search_memories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "claim_id": {"type": "string"}
                    },
                    "required": ["claim_id"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "search_memories",
                "description": "Search the shared brain. Returns a compact list (id + short title). Use for exact error codes, filenames, file paths (before editing), session_summary tags, and identifiers as well as meaning. Then call get_memories with only the ids you need.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"}
                    },
                    "required": ["query"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "get_memories",
                "description": "Load full text for a few memory ids from ## recall or search_memories. Pass ids (array, max 8). When a fact was updated, includes a short previously line.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "ids": {"type": "array", "items": {"type": "string"}}
                    },
                    "required": ["ids"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "save_exploration",
                "description": "Save how part of the code fits together. topic is a short key; conclusion is the insight; files are paths you read (daemon stores SHA-256 of each). Separate from ordinary remember facts. Later call get_exploration to reuse if hashes still match.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "topic": {"type": "string"},
                        "conclusion": {"type": "string"},
                        "files": {"type": "array", "items": {"type": "string"}}
                    },
                    "required": ["topic", "conclusion", "files"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "get_exploration",
                "description": "Load an exploration memo by topic or path. Returns the conclusion plus each file marked unchanged, changed, or missing versus the stored hashes.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "topic": {"type": "string"},
                        "path": {"type": "string"}
                    }
                }
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use maia_store::OwnerOpen;
    use std::fs;

    fn open_store() -> SqliteOwner {
        let directory = std::env::temp_dir().join(format!(
            "maia-memory-tools-{}-{}",
            std::process::id(),
            REMEMBER_SEQ.fetch_add(1, Ordering::Relaxed)
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

    fn apply(
        store: &SqliteOwner,
        call: &MemoryToolCall,
        bot_id: &str,
        now: i64,
        known: &[&str],
        workspace: &Path,
    ) -> String {
        apply_memory_tool(store, call, bot_id, now, known, workspace).expect("apply")
    }

    #[test]
    fn parse_remember_requires_sentence() {
        assert!(parse_memory_tool("remember", r#"{"message":""}"#).is_none());
        assert_eq!(
            parse_memory_tool("remember", r#"{"message":"Garrett prefers concise replies."}"#),
            Some(MemoryToolCall::Remember {
                sentence: "Garrett prefers concise replies.".to_owned()
            })
        );
    }

    #[test]
    fn remember_persists_a_claim() {
        let store = open_store();
        let workspace = std::env::temp_dir();
        let result = apply(
            &store,
            &MemoryToolCall::Remember {
                sentence: "The project uses prompt-first memory writes.".to_owned(),
            },
            "run69-bot",
            100,
            &[],
            &workspace,
        );
        assert!(result.starts_with("Remembered as claim-remember-"));
        let map = store.brain_map().expect("map");
        assert!(
            map.nodes.iter().any(|node| {
                node.kind.as_str() == "claim"
                    && node
                        .sentence
                        .as_deref()
                        .unwrap_or(node.label.as_str())
                        .contains("prompt-first memory writes")
            }),
            "claim should appear on the brain map"
        );
    }

    #[test]
    fn remember_redacts_secrets_before_save() {
        let store = open_store();
        let workspace = std::env::temp_dir();
        let fake_key = "sk-testFAKESECRET_w1x2y3z4a5b6c7d8e9f0";
        let known = "ceo-stored-fake-secret-value-75";
        let result = apply(
            &store,
            &MemoryToolCall::Remember {
                sentence: format!(
                    "Token {fake_key} and known {known} plus <private>hidden</private>."
                ),
            },
            "run75-bot",
            300,
            &[known],
            &workspace,
        );
        assert!(result.starts_with("Remembered as claim-remember-"));
        let map = store.brain_map().expect("map");
        let sentence = map
            .nodes
            .iter()
            .find(|node| node.kind.as_str() == "claim")
            .and_then(|node| node.sentence.clone())
            .expect("claim sentence");
        assert!(!sentence.contains(fake_key));
        assert!(!sentence.contains(known));
        assert!(!sentence.contains("hidden"));
        assert!(sentence.contains(maia_core::memory_redact::REDACTED));
    }

    #[test]
    fn search_returns_compact_list_and_get_loads_full_text() {
        let store = open_store();
        let workspace = std::env::temp_dir();
        let long = format!(
            "Build failed with ECONNREFUSED_77 while opening hello73.py during the nightly deploy of the staging stack with extra detail for truncation."
        );
        assert!(long.chars().count() > maia_core::thread_cache::RECALL_TITLE_CHARS);
        let remembered = apply(
            &store,
            &MemoryToolCall::Remember {
                sentence: long.clone(),
            },
            "run74-bot",
            200,
            &[],
            &workspace,
        );
        let claim_id = remembered
            .trim_start_matches("Remembered as ")
            .trim_end_matches('.')
            .to_owned();

        let search = apply(
            &store,
            &MemoryToolCall::Search {
                query: "ECONNREFUSED_77".to_owned(),
            },
            "run74-bot",
            201,
            &[],
            &workspace,
        );
        assert!(search.contains("## memories"));
        assert!(search.contains(&claim_id));
        assert!(search.contains("Call get_memories"));
        assert!(search.contains(" — "));
        assert!(
            !search.contains("extra detail for truncation"),
            "compact list must truncate long sentences"
        );

        let full = apply(
            &store,
            &MemoryToolCall::Get {
                ids: vec![claim_id.clone()],
            },
            "run74-bot",
            202,
            &[],
            &workspace,
        );
        assert!(full.contains("## memory bodies"));
        assert!(full.contains("ECONNREFUSED_77"));
        assert!(full.contains("hello73.py"));
        assert!(full.contains("extra detail for truncation"));
    }

    #[test]
    fn search_finds_memories_that_mention_a_file_path() {
        let store = open_store();
        let workspace = std::env::temp_dir();
        let path = r"F:\tmp\run75_throwaway.py";
        let _ = apply(
            &store,
            &MemoryToolCall::Remember {
                sentence: format!(
                    "Tried editing {path} with a broken import and failed; use relative imports instead."
                ),
            },
            "run75-path-bot",
            400,
            &[],
            &workspace,
        );
        let search = apply(
            &store,
            &MemoryToolCall::Search {
                query: path.to_owned(),
            },
            "run75-path-bot",
            401,
            &[],
            &workspace,
        );
        assert!(
            search.contains("run75_throwaway") || search.contains("broken import"),
            "exact FTS / neuron search should find path mentions without a dedicated filter: {search}"
        );
    }

    #[test]
    fn format_compact_is_smaller_than_full_bodies() {
        let hits: Vec<(String, String)> = (0..8)
            .map(|i| {
                (
                    format!("claim-{i}"),
                    format!(
                        "Long throwaway memory number {i} about ECONNREFUSED_77 and hello73.py with extra padding words to inflate tokens."
                    ),
                )
            })
            .collect();
        let compact = format_compact_memory_hits(&hits);
        let full = format_memory_bodies(
            &hits
                .iter()
                .map(|(id, s)| (id.clone(), s.clone(), None))
                .collect::<Vec<_>>(),
        );
        assert!(compact.len() < full.len());
        let compact_tokens = (compact.chars().count() + 3) / 4;
        let full_tokens = (full.chars().count() + 3) / 4;
        assert!(
            compact_tokens < full_tokens,
            "compact {compact_tokens} should be under full {full_tokens}"
        );
    }

    #[test]
    fn exploration_save_reuses_when_unchanged_and_flags_changed_file() {
        let store = open_store();
        let workspace = std::env::temp_dir().join(format!(
            "maia-explore-ws-{}-{}",
            std::process::id(),
            REMEMBER_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&workspace).expect("ws");
        let a = workspace.join("run76_a.rs");
        let b = workspace.join("run76_b.rs");
        fs::write(&a, b"fn a() {}").expect("a");
        fs::write(&b, b"fn b() {}").expect("b");

        let saved = apply(
            &store,
            &MemoryToolCall::SaveExploration {
                topic: "run76 glue".to_owned(),
                conclusion: "A calls into B for setup.".to_owned(),
                files: vec![
                    "run76_a.rs".to_owned(),
                    "run76_b.rs".to_owned(),
                ],
            },
            "run76-bot",
            500,
            &[],
            &workspace,
        );
        assert!(saved.contains("Saved exploration"));

        let reuse = apply(
            &store,
            &MemoryToolCall::GetExploration {
                topic: Some("run76 glue".to_owned()),
                path: None,
            },
            "run76-bot",
            501,
            &[],
            &workspace,
        );
        assert!(reuse.contains("A calls into B"));
        assert!(reuse.contains("`run76_a.rs` — unchanged"));
        assert!(reuse.contains("`run76_b.rs` — unchanged"));

        fs::write(&a, b"fn a() { changed }").expect("edit a");
        let after = apply(
            &store,
            &MemoryToolCall::GetExploration {
                topic: Some("run76 glue".to_owned()),
                path: None,
            },
            "run76-bot",
            502,
            &[],
            &workspace,
        );
        assert!(after.contains("`run76_a.rs` — changed"));
        assert!(after.contains("`run76_b.rs` — unchanged"));
    }

    #[test]
    fn exploration_redacts_secrets_in_conclusion() {
        let store = open_store();
        let workspace = std::env::temp_dir().join(format!(
            "maia-explore-redact-{}-{}",
            std::process::id(),
            REMEMBER_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&workspace).expect("ws");
        fs::write(workspace.join("x.rs"), b"x").expect("x");
        let fake = "sk-testFAKESECRET_a4b5c6d7e8f9g0h1i2j3";
        let _ = apply(
            &store,
            &MemoryToolCall::SaveExploration {
                topic: "secrets".to_owned(),
                conclusion: format!("Saw token {fake} in comments."),
                files: vec!["x.rs".to_owned()],
            },
            "run76-bot",
            600,
            &[],
            &workspace,
        );
        let got = apply(
            &store,
            &MemoryToolCall::GetExploration {
                topic: Some("secrets".to_owned()),
                path: None,
            },
            "run76-bot",
            601,
            &[],
            &workspace,
        );
        assert!(!got.contains(fake));
        assert!(got.contains(maia_core::memory_redact::REDACTED));
    }

    #[test]
    fn update_memory_stores_reason_and_get_shows_previously() {
        let store = open_store();
        let workspace = std::env::temp_dir();
        let remembered = apply(
            &store,
            &MemoryToolCall::Remember {
                sentence: "Deploy uses staging branch.".to_owned(),
            },
            "run76-bot",
            700,
            &[],
            &workspace,
        );
        let old_id = remembered
            .trim_start_matches("Remembered as ")
            .trim_end_matches('.')
            .to_owned();
        let updated = apply(
            &store,
            &MemoryToolCall::Update {
                claim_id: old_id.clone(),
                sentence: "Deploy uses main branch.".to_owned(),
                reason: Some("staging was retired".to_owned()),
                alternatives: Some("keep staging; dual-track".to_owned()),
            },
            "run76-bot",
            701,
            &[],
            &workspace,
        );
        let new_id = updated
            .trim_start_matches(&format!("Updated {old_id} → "))
            .trim_end_matches('.')
            .to_owned();
        let full = apply(
            &store,
            &MemoryToolCall::Get {
                ids: vec![new_id],
            },
            "run76-bot",
            702,
            &[],
            &workspace,
        );
        assert!(full.contains("Deploy uses main branch."));
        assert!(full.contains("why: staging was retired"));
        assert!(full.contains("discarded: keep staging; dual-track"));
        assert!(full.contains("previously: Deploy uses staging branch."));
    }
}
