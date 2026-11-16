//! Prompt-driven brain writes: remember / update / retire (honest leaves + store skin).

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use maia_core::brain::LexicalPolicy;
use maia_core::brain::lexemes_for_sentence;
use maia_core::dream::MAX_CLAIM_SENTENCE_CHARS;
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

/// How automatic per-message extraction relates to prompt-driven tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryWriteMode {
    /// Legacy promoter only (no agent memory tools expected).
    Extract,
    /// Agents write via tools; skip automatic extraction.
    Prompt,
    /// Tools available and extraction still runs (compare / transition).
    Both,
}

impl MemoryWriteMode {
    /// Reads `MAIA_MEMORY_WRITE` (`extract` | `prompt` | `both`). Default: `prompt`.
    #[must_use]
    pub fn from_env() -> Self {
        match std::env::var("MAIA_MEMORY_WRITE") {
            Ok(value) if value.eq_ignore_ascii_case("extract") => Self::Extract,
            Ok(value) if value.eq_ignore_ascii_case("both") => Self::Both,
            _ => Self::Prompt,
        }
    }

    /// True when the promoter should still enqueue chat/task episodes.
    #[must_use]
    pub const fn automatic_extraction(self) -> bool {
        matches!(self, Self::Extract | Self::Both)
    }

    /// True when remember/update/retire tools are exposed.
    #[must_use]
    pub const fn prompt_tools(self) -> bool {
        matches!(self, Self::Prompt | Self::Both)
    }
}

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
}

/// Parses remember / update_memory / retire_memory arguments.
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
        _ => None,
    }
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

/// Applies one memory tool against the shared brain. Never logs sentence contents.
///
/// # Errors
///
/// Returns store failures; callers surface a short tool result string instead.
pub fn apply_memory_tool(
    store: &SqliteOwner,
    call: &MemoryToolCall,
    bot_id: &str,
    now: i64,
) -> Result<String, StoreError> {
    match call {
        MemoryToolCall::Remember { sentence } => {
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
                    lexemes: fact_lexemes(sentence),
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
                    lexemes: fact_lexemes(sentence),
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

/// JSON tool definitions for remember / update_memory / retire_memory.
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
                "description": "Replace an existing brain claim when the fact changed. claim_id from recall; message is the new one-sentence fact.",
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
                "description": "Hide a brain claim that is wrong or no longer true. claim_id from recall.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "claim_id": {"type": "string"}
                    },
                    "required": ["claim_id"]
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
    fn memory_write_mode_defaults_to_prompt() {
        assert_eq!(MemoryWriteMode::Prompt.automatic_extraction(), false);
        assert_eq!(MemoryWriteMode::Prompt.prompt_tools(), true);
        assert_eq!(MemoryWriteMode::Extract.automatic_extraction(), true);
        assert_eq!(MemoryWriteMode::Both.automatic_extraction(), true);
    }
}
