//! Honest leaves for one router turn's cache, recall, and trace.
//!
//! These functions read only their arguments. The orchestrator loads the brain
//! and writes the snapshot.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use maia_core::agents::ThreadId;
use maia_core::audit::Timestamp;
use maia_core::brain::ClaimId;
use maia_core::brain::EpisodeId;
use maia_core::brain::FactId;
use maia_core::brain::GraphClaim;
use maia_core::brain::GraphEdge;
use maia_core::brain::GraphFact;
use maia_core::brain::LexemeId;
use maia_core::brain::LexicalPolicy;
use maia_core::brain::MemoryRef;
use maia_core::brain::MemoryScope;
use maia_core::brain::NodeId;
use maia_core::brain::PageRankParams;
use maia_core::brain::QuarantineSet;
use maia_core::brain::QueryEmbedding;
use maia_core::brain::RankError;
use maia_core::brain::RankPolicy;
use maia_core::brain::RecallGraph;
use maia_core::brain::RecallItem;
use maia_core::brain::RecallQuery;
use maia_core::brain::RecallTaintMode;
use maia_core::brain::ScoreWeights;
use maia_core::brain::rank_paths;
use maia_core::credit::AgeUnit;
use maia_core::credit::PrefixHash;
use maia_core::router::RouterUsage;
use maia_core::router::UsageValue;
use maia_core::security::Taint;
use maia_core::thread_cache::ByteDigest;
use maia_core::thread_cache::CompiledPrefix;
use maia_core::thread_cache::RecallLineage;
use maia_core::thread_cache::RecallPackPolicy;
use maia_core::thread_cache::append_recall;
#[cfg(test)]
use maia_store::BrainDetail;
use maia_store::BrainEdge;
use maia_store::BrainMap;
use maia_store::BrainNode;
use maia_store::BrainNodeKind;

/// Sentence shown when the provider returned no separate reasoning.
pub(crate) const MISSING_REASONING: &str = "No readable reasoning returned.";

/// Router thread that owns chat episodes.
pub(crate) const ROUTER_THREAD: &str = "router";

/// Whether the provider reported a cache for the slots in this turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CacheResidence {
    /// Cached input tokens cover the whole prompt.
    Cached,
    /// The provider reported a cache of zero.
    Uncached,
    /// The provider did not report a cache, or reported only part of the prompt.
    Unreported,
}

/// One measured section of the router request that was sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct PromptSlot {
    /// Position in the request, starting at 1.
    pub ordinal: u16,
    /// Section name.
    pub label: String,
    /// UTF-8 bytes of the section that was sent.
    pub bytes: u64,
    /// Cache residence for this slot.
    pub residence: CacheResidence,
    /// Short description that does not invent compaction.
    pub detail: String,
}

/// Sections of the router request, in the order they were measured.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MeasuredPrompt {
    /// Route-tool JSON sent on the request.
    pub tools_json: String,
    /// Butler instructions, without the candidate list.
    pub instructions: String,
    /// Candidate-task JSON.
    pub candidates: String,
    /// Conversation message bodies, oldest first, including the new owner text.
    pub conversation: Vec<String>,
    /// Recall block when the packer returned lines.
    pub recall: Option<PackedRecall>,
}

/// One packed claim or fact. It is not installed as durable memory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallLine {
    /// Claim or fact id.
    pub id: String,
    /// `claim` or `fact`.
    pub kind: RecallKind,
    /// Sentence that was packed.
    pub sentence: String,
    /// Combined rank score.
    pub score: f64,
    /// Nodes walked from the query to this fact, as `kind:id`.
    #[serde(default)]
    pub walked: Vec<String>,
}

/// Endpoint kind of one recall line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecallKind {
    /// Provisional claim.
    Claim,
    /// Canonical fact.
    Fact,
}

/// Recall bytes and the lines they contain.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PackedRecall {
    /// Canonical recall block sent as one extra message.
    pub bytes: String,
    /// Lines inside that block, in rank order.
    pub items: Vec<RecallLine>,
}

/// One trace row for the inspector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct TraceStep {
    /// `reasoning`, `route`, or `reply`.
    pub kind: &'static str,
    /// Row text.
    pub text: String,
}

/// One stored inspector row, oldest first when listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoredTurnRow {
    /// Turn ordinal.
    pub ordinal: i64,
    /// Owner message id.
    pub message_id: String,
    /// Slot JSON.
    pub slots_json: String,
    /// Usage JSON.
    pub usage_json: String,
    /// Recall JSON.
    pub recall_json: String,
    /// Stored reasoning, when present.
    pub thinking: Option<String>,
    /// Admitted route, when present.
    pub route: Option<String>,
    /// Owner-visible reply.
    pub reply: String,
}

/// Measures the request sections in send order.
pub(crate) fn prompt_slots(
    measured: &MeasuredPrompt,
    residence: CacheResidence,
) -> Vec<PromptSlot> {
    let mut slots = vec![
        slot(
            1,
            "Route tools",
            measured.tools_json.len(),
            residence,
            &format!("{} schemas", json_len(&measured.tools_json)),
        ),
        slot(
            2,
            "Router instructions",
            measured.instructions.len(),
            residence,
            "fixed",
        ),
        slot(
            3,
            "Candidate tasks",
            measured.candidates.len(),
            residence,
            &format!("{} tasks", json_len(&measured.candidates)),
        ),
        slot(
            4,
            "Conversation",
            measured.conversation.iter().map(String::len).sum(),
            residence,
            &conversation_detail(measured.conversation.len()),
        ),
    ];
    if let Some(recall) = &measured.recall {
        slots.push(slot(
            5,
            "Recall",
            recall.bytes.len(),
            residence,
            "not durable",
        ));
    }
    slots
}

/// Cached input tokens divided by input tokens, only when both were reported.
pub(crate) fn cached_percent(usage: &RouterUsage) -> Option<u16> {
    match (usage.input_tokens, usage.cached_input_tokens) {
        (UsageValue::Reported(input), UsageValue::Reported(cached)) if input > 0 => {
            let percent = cached.saturating_mul(100) / input;
            u16::try_from(percent.min(100)).ok()
        }
        _ => None,
    }
}

/// Slot residence from the same reported counts.
pub(crate) fn cache_residence(usage: &RouterUsage) -> CacheResidence {
    match (usage.input_tokens, usage.cached_input_tokens) {
        (UsageValue::Reported(input), UsageValue::Reported(0)) if input > 0 => {
            CacheResidence::Uncached
        }
        (UsageValue::Reported(input), UsageValue::Reported(cached))
            if input > 0 && cached >= input =>
        {
            CacheResidence::Cached
        }
        _ => CacheResidence::Unreported,
    }
}

/// Reasoning, the admitted route, and the reply. A missing reasoning row uses
/// [`MISSING_REASONING`].
pub(crate) fn trace_steps(
    thinking: Option<&str>,
    route: Option<&str>,
    reply: &str,
) -> Vec<TraceStep> {
    let reasoning = thinking
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(MISSING_REASONING);
    let mut steps = vec![TraceStep {
        kind: "reasoning",
        text: reasoning.to_owned(),
    }];
    if let Some(route) = route.map(str::trim).filter(|text| !text.is_empty()) {
        steps.push(TraceStep {
            kind: "route",
            text: route.to_owned(),
        });
    }
    if !reply.trim().is_empty() {
        steps.push(TraceStep {
            kind: "reply",
            text: reply.to_owned(),
        });
    }
    steps
}

/// Loads claims and facts, and points each stored lexeme at the memory that names it.
pub(crate) fn recall_graph(map: &BrainMap) -> (RecallGraph, QuarantineSet) {
    let mut graph = RecallGraph::default();
    let mut quarantine = Vec::new();
    for node in &map.nodes {
        match node.kind {
            BrainNodeKind::Lexeme => {
                graph.lexemes.insert(LexemeId::new(node.id.clone()));
            }
            BrainNodeKind::Claim => {
                let id = ClaimId::new(node.id.clone());
                if node.held {
                    quarantine.push(MemoryRef::Claim(id.clone()));
                }
                graph.claims.insert(id, claim_from(node, map));
            }
            BrainNodeKind::Fact => {
                let id = FactId::new(node.id.clone());
                if node.held {
                    quarantine.push(MemoryRef::Fact(id.clone()));
                }
                graph.facts.insert(id, fact_from(node, map));
            }
            BrainNodeKind::Episode => {
                graph.episodes.insert(
                    EpisodeId::new(node.id.clone()),
                    maia_core::brain::GraphEpisode {
                        text: sentence_of(node),
                        lexemes: Vec::new(),
                        embedding: None,
                    },
                );
            }
            BrainNodeKind::Entity => {}
        }
    }
    for edge in &map.edges {
        let weight = edge_weight(edge);
        if weight <= 0.0 {
            continue;
        }
        if edge.kind == "co_use" || edge.kind == "relatedness" {
            let Some(from) = memory_node(&edge.from_kind, &edge.from_id) else {
                continue;
            };
            let Some(to) = memory_node(&edge.to_kind, &edge.to_id) else {
                continue;
            };
            graph.edges.push(GraphEdge {
                from: from.clone(),
                to: to.clone(),
                weight,
            });
            graph.edges.push(GraphEdge {
                from: to,
                to: from,
                weight,
            });
            continue;
        }
        if let Some(reversed) = reversed_lexeme_edge(edge, weight) {
            if let NodeId::Lexeme(lexeme) = &reversed.from {
                graph.lexemes.insert(lexeme.clone());
            }
            graph.edges.push(reversed);
        }
    }
    (graph, QuarantineSet::new(quarantine))
}

/// Ranks the graph and packs recall lines. An empty pack is `None`.
pub(crate) fn pack_recall(
    graph: &RecallGraph,
    query: &str,
    now: Timestamp,
    quarantine: &QuarantineSet,
) -> Result<Option<PackedRecall>, RankError> {
    pack_recall_with_embedding(graph, query, now, quarantine, None)
}

/// Ranks with an optional query vector from the same embedder that stored claim vectors.
pub(crate) fn pack_recall_with_embedding(
    graph: &RecallGraph,
    query: &str,
    now: Timestamp,
    quarantine: &QuarantineSet,
    embedding: Option<&QueryEmbedding>,
) -> Result<Option<PackedRecall>, RankError> {
    let policy = router_rank_policy();
    let ranked = rank_paths(
        graph,
        &RecallQuery {
            text: query.to_owned(),
            embedding: embedding.cloned(),
        },
        now,
        &policy,
        quarantine,
        &BTreeSet::new(),
    )?;
    let packed = append_recall(
        &blank_prefix(),
        &ranked,
        &RecallPackPolicy {
            token_budget: policy.recall_token_budget,
            taint_mode: policy.taint_mode,
            lineage: RecallLineage::default(),
        },
        estimate_tokens,
        ByteDigest::from_fn(digest_len),
    )
    .map_err(|_| RankError::NonFiniteThreshold)?;
    if packed.recall_items.is_empty() {
        return Ok(None);
    }
    let items = packed
        .recall_items
        .iter()
        .filter_map(|item| recall_line(item, &ranked))
        .collect::<Vec<_>>();
    if items.is_empty() {
        return Ok(None);
    }
    Ok(Some(PackedRecall {
        bytes: packed.recall_bytes,
        items,
    }))
}

/// Serializes provider usage without treating an estimate as a reported cache.
pub(crate) fn usage_json(usage: &RouterUsage) -> Result<String, serde_json::Error> {
    serde_json::to_string(&serde_json::json!({
        "input_tokens": usage_value(usage.input_tokens),
        "output_tokens": usage_value(usage.output_tokens),
        "cached_input_tokens": usage_value(usage.cached_input_tokens),
    }))
}

/// Rebuilds usage from the stored JSON. A broken record is unavailable.
pub(crate) fn usage_from_json(json: &str) -> RouterUsage {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return empty_usage();
    };
    RouterUsage {
        input_tokens: read_usage_value(value.get("input_tokens")),
        output_tokens: read_usage_value(value.get("output_tokens")),
        cached_input_tokens: read_usage_value(value.get("cached_input_tokens")),
    }
}

/// Inspector document, oldest turn first.
///
/// `used` maps a message id to the claim and fact ids presented for that turn.
pub(crate) fn inspector_document(
    rows: &[StoredTurnRow],
    used: &BTreeMap<String, Vec<String>>,
) -> Value {
    let turns = rows
        .iter()
        .map(|row| {
            let usage = usage_from_json(&row.usage_json);
            let facts_used = used.get(&row.message_id).cloned().unwrap_or_default();
            serde_json::json!({
                "ordinal": row.ordinal,
                "message_id": row.message_id,
                "cached_percent": cached_percent(&usage),
                "slots": parse_json_array(&row.slots_json),
                "recall": parse_json_array(&row.recall_json),
                "used": facts_used,
                "thinking": row.thinking,
                "route": row.route,
                "reply": row.reply,
                "trace": trace_steps(row.thinking.as_deref(), row.route.as_deref(), &row.reply),
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "turns": turns })
}

fn slot(
    ordinal: u16,
    label: &str,
    bytes: usize,
    residence: CacheResidence,
    detail: &str,
) -> PromptSlot {
    PromptSlot {
        ordinal,
        label: label.to_owned(),
        bytes: u64::try_from(bytes).unwrap_or(u64::MAX),
        residence,
        detail: detail.to_owned(),
    }
}

fn conversation_detail(count: usize) -> String {
    if count == 1 {
        "1 message".to_owned()
    } else {
        format!("{count} messages")
    }
}

fn json_len(json: &str) -> usize {
    serde_json::from_str::<Vec<Value>>(json)
        .map(|items| items.len())
        .unwrap_or(0)
}

fn sentence_of(node: &BrainNode) -> String {
    node.sentence
        .clone()
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| node.label.clone())
}

fn node_taint(node: &BrainNode) -> Taint {
    if node.taint.as_deref() == Some("untrusted") {
        Taint::Untrusted
    } else {
        Taint::Trusted
    }
}

fn lexemes_named(map: &BrainMap, kind: &str, id: &str) -> Vec<LexemeId> {
    map.edges
        .iter()
        .filter(|edge| {
            edge.kind == "lexeme"
                && edge.from_kind == kind
                && edge.from_id == id
                && edge.to_kind == "lexeme"
        })
        .map(|edge| LexemeId::new(edge.to_id.clone()))
        .collect()
}

fn claim_from(node: &BrainNode, map: &BrainMap) -> GraphClaim {
    GraphClaim {
        sentence: sentence_of(node),
        taint: node_taint(node),
        scope: MemoryScope::World,
        lexemes: lexemes_named(map, "claim", &node.id),
        embedding: None,
        presentations: Vec::new(),
        consolidated_by: None,
        source_episode: None,
    }
}

fn fact_from(node: &BrainNode, map: &BrainMap) -> GraphFact {
    GraphFact {
        sentence: sentence_of(node),
        taint: node_taint(node),
        scope: MemoryScope::World,
        lexemes: lexemes_named(map, "fact", &node.id),
        embedding: None,
        presentations: Vec::new(),
        valid_from: Timestamp(0),
        valid_end: None,
        consolidates: Vec::new(),
    }
}

fn reversed_lexeme_edge(edge: &BrainEdge, weight: f64) -> Option<GraphEdge> {
    if edge.kind != "lexeme" || edge.to_kind != "lexeme" {
        return None;
    }
    let memory = memory_node(&edge.from_kind, &edge.from_id)?;
    Some(GraphEdge {
        from: NodeId::Lexeme(LexemeId::new(edge.to_id.clone())),
        to: memory,
        weight,
    })
}

fn memory_node(kind: &str, id: &str) -> Option<NodeId> {
    match kind {
        "claim" => Some(NodeId::Claim(ClaimId::new(id))),
        "fact" => Some(NodeId::Fact(FactId::new(id))),
        _ => None,
    }
}

fn edge_weight(edge: &BrainEdge) -> f64 {
    let millis = edge.weight_millis.clamp(0, 1_000_000);
    f64::from(u32::try_from(millis).unwrap_or(0)) / 1000.0
}

fn router_rank_policy() -> RankPolicy {
    RankPolicy {
        decay: 0.5,
        age_unit: AgeUnit::Seconds,
        lexical: LexicalPolicy {
            stopwords: BTreeSet::from(["the".to_owned(), "a".to_owned(), "is".to_owned()]),
            fan_out: BTreeMap::new(),
            high_fan_cutoff: 100,
        },
        pagerank: PageRankParams {
            damping: 0.5,
            iterations: 2,
        },
        weights: ScoreWeights {
            activation: 1.0,
            pagerank: 1.0,
            embedding: 1.0,
        },
        inclusion_threshold: 0.05,
        recall_token_budget: 500,
        taint_mode: RecallTaintMode::IncludeUntrusted,
    }
}

fn blank_prefix() -> CompiledPrefix {
    CompiledPrefix {
        thread_id: ThreadId(0),
        bytes: String::new(),
        hash: PrefixHash::new("router"),
        tools_json: String::new(),
        system_sections: String::new(),
        slots: Vec::new(),
        installed_memories: Vec::new(),
        installed_episodes: Vec::new(),
    }
}

fn estimate_tokens(text: &str) -> u32 {
    maia_core::task_loop::estimate_tokens(text.chars().count())
}

fn digest_len(bytes: &[u8]) -> PrefixHash {
    PrefixHash::new(bytes.len().to_string())
}

fn recall_line(item: &RecallItem, ranked: &[maia_core::brain::RankedPath]) -> Option<RecallLine> {
    let path = ranked.iter().find(|path| path.item == *item)?;
    let (id, kind) = match item {
        RecallItem::Claim { claim_id } => (claim_id.as_str().to_owned(), RecallKind::Claim),
        RecallItem::Fact { fact_id } => (fact_id.as_str().to_owned(), RecallKind::Fact),
    };
    Some(RecallLine {
        id,
        kind,
        sentence: path.sentence.clone(),
        score: path.scores.combined,
        walked: path.walked.iter().map(walked_token).collect(),
    })
}

fn walked_token(node: &NodeId) -> String {
    match node {
        NodeId::Lexeme(id) => format!("lexeme:{}", id.as_str()),
        NodeId::Claim(id) => format!("claim:{}", id.as_str()),
        NodeId::Fact(id) => format!("fact:{}", id.as_str()),
        NodeId::Episode(id) => format!("episode:{}", id.as_str()),
    }
}

fn usage_value(value: UsageValue) -> Value {
    match value {
        UsageValue::Reported(tokens) => serde_json::json!({ "kind": "reported", "tokens": tokens }),
        UsageValue::Estimated(tokens) => {
            serde_json::json!({ "kind": "estimated", "tokens": tokens })
        }
        UsageValue::Unavailable => serde_json::json!({ "kind": "unavailable" }),
    }
}

fn read_usage_value(value: Option<&Value>) -> UsageValue {
    let Some(value) = value else {
        return UsageValue::Unavailable;
    };
    let kind = value.get("kind").and_then(Value::as_str);
    let tokens = value.get("tokens").and_then(Value::as_u64).unwrap_or(0);
    match kind {
        Some("reported") => UsageValue::Reported(tokens),
        Some("estimated") => UsageValue::Estimated(tokens),
        _ => UsageValue::Unavailable,
    }
}

fn empty_usage() -> RouterUsage {
    RouterUsage {
        input_tokens: UsageValue::Unavailable,
        output_tokens: UsageValue::Unavailable,
        cached_input_tokens: UsageValue::Unavailable,
    }
}

fn parse_json_array(json: &str) -> Value {
    serde_json::from_str::<Value>(json).unwrap_or_else(|_| Value::Array(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: UsageValue, cached: UsageValue) -> RouterUsage {
        RouterUsage {
            input_tokens: input,
            output_tokens: UsageValue::Reported(4),
            cached_input_tokens: cached,
        }
    }

    #[test]
    fn cached_percent_needs_both_reported_counts() {
        assert_eq!(
            cached_percent(&usage(UsageValue::Reported(200), UsageValue::Unavailable)),
            None
        );
        assert_eq!(
            cached_percent(&usage(
                UsageValue::Reported(200),
                UsageValue::Estimated(200)
            )),
            None
        );
        assert_eq!(
            cached_percent(&usage(UsageValue::Reported(0), UsageValue::Reported(0))),
            None
        );
        assert_eq!(
            cached_percent(&usage(UsageValue::Reported(200), UsageValue::Reported(50))),
            Some(25)
        );
        assert_eq!(
            cached_percent(&usage(UsageValue::Reported(200), UsageValue::Reported(0))),
            Some(0)
        );
        assert_eq!(
            cached_percent(&usage(UsageValue::Reported(50), UsageValue::Reported(80))),
            Some(100)
        );
    }

    #[test]
    fn residence_is_unreported_when_the_cache_covers_only_part_of_the_prompt() {
        assert_eq!(
            cache_residence(&usage(UsageValue::Unavailable, UsageValue::Unavailable)),
            CacheResidence::Unreported
        );
        assert_eq!(
            cache_residence(&usage(UsageValue::Reported(200), UsageValue::Reported(0))),
            CacheResidence::Uncached
        );
        assert_eq!(
            cache_residence(&usage(UsageValue::Reported(200), UsageValue::Reported(200))),
            CacheResidence::Cached
        );
        assert_eq!(
            cache_residence(&usage(UsageValue::Reported(200), UsageValue::Reported(50))),
            CacheResidence::Unreported
        );
    }

    #[test]
    fn prompt_slots_follow_the_sent_sections_and_do_not_call_the_chat_compacted() {
        let measured = MeasuredPrompt {
            tools_json: "[{}]".to_owned(),
            instructions: "Rules".to_owned(),
            candidates: "[]".to_owned(),
            conversation: vec!["Hello".to_owned(), "Again".to_owned()],
            recall: Some(PackedRecall {
                bytes: "## recall\n`claim-1`: Kept.\n".to_owned(),
                items: vec![RecallLine {
                    id: "claim-1".to_owned(),
                    kind: RecallKind::Claim,
                    sentence: "Kept.".to_owned(),
                    score: 0.5,
                    walked: Vec::new(),
                }],
            }),
        };
        let slots = prompt_slots(&measured, CacheResidence::Unreported);
        let labels: Vec<_> = slots.iter().map(|slot| slot.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "Route tools",
                "Router instructions",
                "Candidate tasks",
                "Conversation",
                "Recall"
            ]
        );
        assert_eq!(slots[0].bytes, 4);
        assert_eq!(slots[0].detail, "1 schemas");
        assert_eq!(slots[2].detail, "0 tasks");
        assert_eq!(slots[3].bytes, 10);
        assert_eq!(slots[3].detail, "2 messages");
        assert!(slots.iter().all(|slot| !slot.detail.contains("compact")));
        assert!(slots.iter().all(|slot| !slot.label.contains("compact")));
        assert_eq!(slots[4].detail, "not durable");
        assert!(
            prompt_slots(
                &MeasuredPrompt {
                    recall: None,
                    ..measured
                },
                CacheResidence::Cached
            )
            .iter()
            .all(|slot| slot.label != "Recall")
        );
    }

    #[test]
    fn trace_uses_the_missing_reasoning_sentence_and_skips_an_absent_route() {
        let steps = trace_steps(None, None, "Hello.");
        assert_eq!(steps[0].text, MISSING_REASONING);
        assert!(steps.iter().all(|step| step.kind != "route"));
        assert_eq!(steps[1].kind, "reply");
        let admitted = trace_steps(Some("Thinking."), Some("spawn_task"), "Dispatched.");
        assert_eq!(admitted[0].text, "Thinking.");
        assert_eq!(admitted[1].kind, "route");
        assert_eq!(admitted[1].text, "spawn_task");
        assert!(admitted.iter().all(|step| !step.text.contains("full")));
    }

    #[test]
    fn pack_recall_includes_a_lexeme_linked_fact_and_skips_an_empty_graph() {
        let (fact_id, fact) = linked_fact();
        let mut graph = RecallGraph::default();
        graph.lexemes.insert(LexemeId::new("obsidian"));
        graph.edges.push(GraphEdge {
            from: NodeId::Lexeme(LexemeId::new("obsidian")),
            to: NodeId::Fact(fact_id.clone()),
            weight: 1.0,
        });
        graph.facts.insert(fact_id, fact);
        let packed = pack_recall(
            &graph,
            "What about obsidian?",
            Timestamp(1_735_000_000),
            &QuarantineSet::new([]),
        )
        .expect("rank")
        .expect("packed lines");
        assert!(packed.bytes.contains("Obsidian opens the vault."));
        assert!(packed.bytes.starts_with("## recall\n"));
        assert_eq!(packed.items[0].id, "fact-1");
        assert_eq!(packed.items[0].kind, RecallKind::Fact);
        assert!(
            pack_recall(
                &RecallGraph::default(),
                "obsidian",
                Timestamp(1),
                &QuarantineSet::new([])
            )
            .expect("empty rank")
            .is_none()
        );
    }

    #[test]
    fn recall_graph_points_a_stored_lexeme_at_the_claim() {
        let map = BrainMap {
            tags: Vec::new(),
            nodes: vec![
                BrainNode {
                    id: "claim-1".to_owned(),
                    kind: BrainNodeKind::Claim,
                    label: "Obsidian opens the vault.".to_owned(),
                    sentence: Some("Obsidian opens the vault.".to_owned()),
                    taint: Some("untrusted".to_owned()),
                    session_id: Some("thread-1".to_owned()),
                    held: false,
                    detail: BrainDetail::default(),
                },
                BrainNode {
                    id: "obsidian".to_owned(),
                    kind: BrainNodeKind::Lexeme,
                    label: "obsidian".to_owned(),
                    sentence: None,
                    taint: None,
                    session_id: None,
                    held: false,
                    detail: BrainDetail::default(),
                },
            ],
            edges: vec![BrainEdge {
                kind: "lexeme".to_owned(),
                from_kind: "claim".to_owned(),
                from_id: "claim-1".to_owned(),
                to_kind: "lexeme".to_owned(),
                to_id: "obsidian".to_owned(),
                weight_millis: 1000,
            }],
        };
        let (graph, quarantine) = recall_graph(&map);
        assert!(graph.claims.contains_key(&ClaimId::new("claim-1")));
        assert!(graph.edges.iter().any(|edge| {
            matches!(edge.from, NodeId::Lexeme(_)) && matches!(edge.to, NodeId::Claim(_))
        }));
        let packed = pack_recall(
            &graph,
            "What about obsidian?",
            Timestamp(1_735_000_000),
            &quarantine,
        )
        .expect("rank")
        .expect("claim line");
        assert_eq!(packed.items[0].id, "claim-1");
        assert!(packed.bytes.contains("Obsidian opens the vault."));
    }

    fn linked_fact() -> (FactId, GraphFact) {
        (
            FactId::new("fact-1"),
            GraphFact {
                sentence: "Obsidian opens the vault.".to_owned(),
                taint: Taint::Trusted,
                scope: MemoryScope::World,
                lexemes: vec![LexemeId::new("obsidian")],
                embedding: None,
                presentations: Vec::new(),
                valid_from: Timestamp(0),
                valid_end: None,
                consolidates: Vec::new(),
            },
        )
    }
}
