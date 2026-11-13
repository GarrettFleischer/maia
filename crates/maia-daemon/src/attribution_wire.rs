//! I/O skin: attribute one router turn and apply the ledger.

use maia_core::agents::ThreadId;
use maia_core::audit::RequestId;
use maia_core::brain::ClaimId;
use maia_core::brain::FactId;
use maia_core::brain::MemoryRef;
use maia_core::brain::RecallItem;
use maia_core::credit::AttributionScope;
use maia_core::credit::CandidateRef;
use maia_core::credit::PrefixHash;
use maia_core::credit::ReasoningAvailability;
use maia_core::credit::ScopedRecallItem;
use maia_core::credit::ToolTrace;
use maia_core::credit::UseSource;
use maia_core::credit::attribute_uses;
use maia_store::CoUseWrite;
use maia_store::EvidenceSource;
use maia_store::LedgerWrite;
use maia_store::MemoryKind;
use maia_store::PresentationWrite;
use maia_store::SqliteOwner;

use crate::inspector::PackedRecall;
use crate::inspector::RecallKind;

/// Attributes recall items present in the request and applies the ledger.
///
/// Failures are returned; the caller decides whether to surface them.
pub fn attribute_router_turn(
    store: &SqliteOwner,
    message_id: &str,
    request_seq: u64,
    prefix_hash: &PrefixHash,
    recall: Option<&PackedRecall>,
    thinking: Option<&str>,
    reply: &str,
    tools: &[ToolTrace],
    now: i64,
) -> Result<(), String> {
    let Some(recall) = recall else {
        return Ok(());
    };
    if recall.items.is_empty() {
        return Ok(());
    }
    let scoped: Vec<ScopedRecallItem> = recall
        .items
        .iter()
        .map(|line| ScopedRecallItem {
            item: match line.kind {
                RecallKind::Claim => RecallItem::Claim {
                    claim_id: ClaimId::new(line.id.clone()),
                },
                RecallKind::Fact => RecallItem::Fact {
                    fact_id: FactId::new(line.id.clone()),
                },
            },
            canonical_text: line.sentence.clone(),
        })
        .collect();
    let reasoning = match thinking.map(str::trim) {
        Some("") => ReasoningAvailability::Blank,
        Some(text) => ReasoningAvailability::Available {
            text: text.to_owned(),
        },
        None => ReasoningAvailability::Missing,
    };
    let scope = AttributionScope {
        thread_id: ThreadId(0),
        request_id: RequestId(request_seq),
        compiled_prefix_hash: prefix_hash.clone(),
        slots: Vec::new(),
        recall: scoped,
        reasoning,
        tools: tools.to_vec(),
        reply: reply.to_owned(),
    };
    let ledger = attribute_uses(&scope).map_err(|error| format!("{error:?}"))?;
    if ledger.presentations.is_empty() {
        return Ok(());
    }
    let write = LedgerWrite {
        ledger_id: format!("ledger-{message_id}"),
        thread_id: "router".to_owned(),
        request_id: message_id.to_owned(),
        compiled_prefix_hash: prefix_hash.as_str().to_owned(),
        applied_at: now,
        presentations: ledger
            .presentations
            .iter()
            .filter_map(|presentation| {
                let (kind, id) = match &presentation.candidate {
                    CandidateRef::Recall { item } => match item {
                        RecallItem::Claim { claim_id } => {
                            (MemoryKind::Claim, claim_id.as_str().to_owned())
                        }
                        RecallItem::Fact { fact_id } => {
                            (MemoryKind::Fact, fact_id.as_str().to_owned())
                        }
                    },
                    CandidateRef::Slot { .. } => return None,
                };
                Some(PresentationWrite {
                    presentation_id: format!("pres-{}", presentation.id.0),
                    candidate_kind: kind,
                    candidate_id: id,
                    source: match presentation.source {
                        UseSource::Reasoning => EvidenceSource::Reasoning,
                        UseSource::Tool => EvidenceSource::Tool,
                        UseSource::Reply => EvidenceSource::Reply,
                    },
                    weight: presentation.weight,
                    source_span_start: presentation.source_span.start as i64,
                    source_span_end: presentation.source_span.end as i64,
                    evidence_span_start: presentation.evidence_span.start as i64,
                    evidence_span_end: presentation.evidence_span.end as i64,
                    thread_id: "router".to_owned(),
                })
            })
            .collect(),
        heat: Vec::new(),
        co_use: ledger
            .co_use
            .iter()
            .map(|edge| CoUseWrite {
                left_kind: memory_kind(&edge.left),
                left_id: memory_id(&edge.left),
                right_kind: memory_kind(&edge.right),
                right_id: memory_id(&edge.right),
                weight: edge.weight,
            })
            .collect(),
        negative_marks: Vec::new(),
    };
    if write.presentations.is_empty() {
        return Ok(());
    }
    store
        .apply_ledger(write)
        .map_err(|error| format!("{error:?}"))?;
    Ok(())
}

fn memory_kind(memory: &MemoryRef) -> MemoryKind {
    match memory {
        MemoryRef::Claim(_) => MemoryKind::Claim,
        MemoryRef::Fact(_) => MemoryKind::Fact,
    }
}

fn memory_id(memory: &MemoryRef) -> String {
    match memory {
        MemoryRef::Claim(id) => id.as_str().to_owned(),
        MemoryRef::Fact(id) => id.as_str().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    use maia_core::audit::Timestamp;
    use maia_core::credit::PrefixHash;
    use maia_core::credit::ToolTrace;
    use maia_store::AppendEvents;
    use maia_store::EpisodeWrite;
    use maia_store::MemoryTaint;
    use maia_store::OwnerOpen;
    use maia_store::PromotionClaimWrite;
    use maia_store::PromotionWrite;
    use maia_store::SegmentWrite;
    use maia_store::SqliteOwner;
    use maia_store::ThreadEventWrite;

    use crate::inspector::PackedRecall;
    use crate::inspector::RecallKind;
    use crate::inspector::RecallLine;
    use crate::promotion::bounded_recall;

    use super::attribute_router_turn;

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

    fn open_store(label: &str) -> (std::path::PathBuf, SqliteOwner) {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "maia-wire-{label}-{}-{seq}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let owner = SqliteOwner::open(OwnerOpen {
            path: path.clone(),
            now: 100,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("store");
        (path, owner)
    }

    fn seed_router(store: &SqliteOwner) {
        store
            .append(AppendEvents {
                thread_id: "router".to_owned(),
                expected_version: 0,
                participants: "owner".to_owned(),
                occurred_at: 100,
                events: vec![ThreadEventWrite {
                    event_id: "router-open".to_owned(),
                    kind: "system".to_owned(),
                    body: "open".to_owned(),
                }],
            })
            .expect("thread");
    }

    fn line(id: &str, sentence: &str) -> RecallLine {
        RecallLine {
            id: id.to_owned(),
            kind: RecallKind::Claim,
            sentence: sentence.to_owned(),
            score: 1.0,
            walked: Vec::new(),
        }
    }

    fn co_use_millis(store: &SqliteOwner) -> Option<i64> {
        store
            .brain_map()
            .expect("map")
            .edges
            .into_iter()
            .find(|edge| edge.kind == "co_use")
            .map(|edge| edge.weight_millis)
    }

    #[test]
    fn a_reply_thickens_co_use_once_and_echoes_and_scratch_do_not() {
        let (path, store) = open_store("reply");
        seed_router(&store);
        let recall = PackedRecall {
            bytes: "recall".to_owned(),
            items: vec![
                line("claim-anchor", "The kitchen is in Portland."),
                line("claim-far", "Zephyr holds the indigo token."),
                line("claim-echo", "The tool result names the echo."),
            ],
        };
        let reply = "The kitchen is in Portland. Zephyr holds the indigo token. Scratch paper is not a fact.";
        let tools = [ToolTrace {
            arguments: String::new(),
            results: "The tool result names the echo.".to_owned(),
        }];
        let attribute = |store: &SqliteOwner| {
            attribute_router_turn(
                store,
                "message-1",
                1,
                &PrefixHash::new("prefix"),
                Some(&recall),
                None,
                reply,
                &tools,
                100,
            )
            .expect("attribute")
        };
        attribute(&store);
        attribute(&store);
        assert_eq!(co_use_millis(&store), Some(500));
        let used = store.presented_ids("message-1".to_owned()).expect("used");
        assert_eq!(
            used,
            vec!["claim-anchor".to_owned(), "claim-far".to_owned()]
        );
        store
            .reverse_ledger("ledger-message-1".to_owned(), 101)
            .expect("reverse");
        assert_eq!(co_use_millis(&store), None);
        assert_eq!(
            store.presented_ids("message-1".to_owned()).expect("kept"),
            vec!["claim-anchor".to_owned(), "claim-far".to_owned()]
        );
        store
            .reverse_ledger("ledger-message-1".to_owned(), 102)
            .expect("second reverse");
        assert_eq!(co_use_millis(&store), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_wordless_claim_is_recalled_through_the_co_used_neighbor() {
        let (path, store) = open_store("path");
        seed_router(&store);
        store
            .insert_episode(EpisodeWrite {
                episode_id: "episode-path".to_owned(),
                thread_id: "router".to_owned(),
                turn_id: "turn-path".to_owned(),
                body: "The kitchen is in Portland.".to_owned(),
                taint: MemoryTaint::Trusted,
                reasoning: None,
                participants: "owner".to_owned(),
                created_at: 100,
                segments: vec![SegmentWrite {
                    text: "The kitchen is in Portland.".to_owned(),
                    taint: MemoryTaint::Trusted,
                    sources: "owner".to_owned(),
                }],
            })
            .expect("episode");
        store
            .apply_promotion(PromotionWrite {
                episode_id: "episode-path".to_owned(),
                model: "model-a".to_owned(),
                now: 100,
                claims: vec![
                    PromotionClaimWrite {
                        claim_id: "claim-anchor".to_owned(),
                        sentence: "The kitchen is in Portland.".to_owned(),
                        taint: MemoryTaint::Trusted,
                        valid_from: 100,
                        lexemes: vec!["portland".to_owned(), "kitchen".to_owned()],
            ..Default::default()
        },
                    PromotionClaimWrite {
                        claim_id: "claim-far".to_owned(),
                        sentence: "Zephyr holds the indigo token.".to_owned(),
                        taint: MemoryTaint::Trusted,
                        valid_from: 100,
                        lexemes: vec!["zephyr".to_owned(), "indigo".to_owned(), "token".to_owned()],
            ..Default::default()
        },
                ],
                same_claim_ids: Vec::new(),
                replacements: Vec::new(),
                links: Vec::new(),
            session_bot_id: String::new(),
            session_summary: String::new(),
            })
            .expect("promotion");
        let before = bounded_recall(&store, "portland", Timestamp(100), None);
        assert!(
            before
                .as_ref()
                .is_none_or(|pack| { pack.items.iter().all(|item| item.id != "claim-far") })
        );
        let recall = PackedRecall {
            bytes: "recall".to_owned(),
            items: vec![
                line("claim-anchor", "The kitchen is in Portland."),
                line("claim-far", "Zephyr holds the indigo token."),
            ],
        };
        attribute_router_turn(
            &store,
            "message-path",
            2,
            &PrefixHash::new("prefix"),
            Some(&recall),
            None,
            "The kitchen is in Portland. Zephyr holds the indigo token.",
            &[],
            100,
        )
        .expect("attribute");
        let after = bounded_recall(&store, "portland", Timestamp(100), None).expect("recall");
        let far = after
            .items
            .iter()
            .find(|item| item.id == "claim-far")
            .expect("far claim");
        assert!(!far.sentence.to_ascii_lowercase().contains("portland"));
        assert!(far.walked.iter().any(|node| node == "claim:claim-anchor"));
        let _ = std::fs::remove_file(&path);
    }
}
