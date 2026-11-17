//! Prompt-driven brain writes and progressive-disclosure recall tools.

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
use maia_store::MemoryTaint;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionReplaceWrite;
use maia_store::PromotionWrite;
use maia_store::SegmentWrite;
use maia_store::SqliteOwner;
use maia_store::StoreError;
use maia_store::ThreadEventWrite;

use crate::inspector::ROUTER_THREAD;

static REMEMBER_SEQ: AtomicU64 = AtomicU64::new(1);

/// Cap for compact search_memories results.
pub const SEARCH_RESULT_LIMIT: usize = 12;

/// Cap for get_memories ids in one call.
pub const GET_MEMORIES_LIMIT: usize = 8;

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
}

/// Parses remember / update_memory / retire_memory / search_memories / get_memories.
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
        _ => None,
    }
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

/// Formats full memory bodies for get_memories.
#[must_use]
pub fn format_memory_bodies(rows: &[(String, String)]) -> String {
    if rows.is_empty() {
        return "No memories found for those ids.".to_owned();
    }
    let mut out = String::from("## memory bodies\n");
    for (id, sentence) in rows {
        out.push_str(&format!("`{id}`: {sentence}\n"));
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

/// Applies one memory tool against the shared brain. Never logs sentence contents.
///
/// `known_secret_values` are CEO-stored secret values (Credential Manager) when cheaply
/// available; patterns and `<private>` blocks are always scrubbed before save.
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
        } => {
            let sentence = redact_secrets_for_save(sentence, known_secret_values);
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
            let pairs: Vec<(String, String)> = rows
                .into_iter()
                .map(|row| (row.id, row.sentence))
                .collect();
            Ok(format_memory_bodies(&pairs))
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
                "description": "Replace an existing brain claim when the fact changed. claim_id from recall or search_memories; message is the new one-sentence fact.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "claim_id": {"type": "string"},
                        "message": {"type": "string"}
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
                "description": "Load full text for a few memory ids from ## recall or search_memories. Pass ids (array, max 8).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "ids": {"type": "array", "items": {"type": "string"}}
                    },
                    "required": ["ids"]
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
        let result = apply_memory_tool(
            &store,
            &MemoryToolCall::Remember {
                sentence: "The project uses prompt-first memory writes.".to_owned(),
            },
            "run69-bot",
            100,
            &[],
        )
        .expect("remember");
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
        let fake_key = "sk-testFAKESECRET_w1x2y3z4a5b6c7d8e9f0";
        let known = "ceo-stored-fake-secret-value-75";
        let result = apply_memory_tool(
            &store,
            &MemoryToolCall::Remember {
                sentence: format!(
                    "Token {fake_key} and known {known} plus <private>hidden</private>."
                ),
            },
            "run75-bot",
            300,
            &[known],
        )
        .expect("remember");
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
        let long = format!(
            "Build failed with ECONNREFUSED_77 while opening hello73.py during the nightly deploy of the staging stack with extra detail for truncation."
        );
        assert!(long.chars().count() > maia_core::thread_cache::RECALL_TITLE_CHARS);
        let remembered = apply_memory_tool(
            &store,
            &MemoryToolCall::Remember {
                sentence: long.clone(),
            },
            "run74-bot",
            200,
            &[],
        )
        .expect("remember");
        let claim_id = remembered
            .trim_start_matches("Remembered as ")
            .trim_end_matches('.')
            .to_owned();

        let search = apply_memory_tool(
            &store,
            &MemoryToolCall::Search {
                query: "ECONNREFUSED_77".to_owned(),
            },
            "run74-bot",
            201,
            &[],
        )
        .expect("search");
        assert!(search.contains("## memories"));
        assert!(search.contains(&claim_id));
        assert!(search.contains("Call get_memories"));
        assert!(search.contains(" — "));
        assert!(
            !search.contains("extra detail for truncation"),
            "compact list must truncate long sentences"
        );

        let full = apply_memory_tool(
            &store,
            &MemoryToolCall::Get {
                ids: vec![claim_id.clone()],
            },
            "run74-bot",
            202,
            &[],
        )
        .expect("get");
        assert!(full.contains("## memory bodies"));
        assert!(full.contains("ECONNREFUSED_77"));
        assert!(full.contains("hello73.py"));
        assert!(full.contains("extra detail for truncation"));
    }

    #[test]
    fn search_finds_memories_that_mention_a_file_path() {
        let store = open_store();
        let path = r"F:\tmp\run75_throwaway.py";
        let _ = apply_memory_tool(
            &store,
            &MemoryToolCall::Remember {
                sentence: format!(
                    "Tried editing {path} with a broken import and failed; use relative imports instead."
                ),
            },
            "run75-path-bot",
            400,
            &[],
        )
        .expect("remember");
        let search = apply_memory_tool(
            &store,
            &MemoryToolCall::Search {
                query: path.to_owned(),
            },
            "run75-path-bot",
            401,
            &[],
        )
        .expect("search");
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
                .map(|(id, s)| (id.clone(), s.clone()))
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
}
