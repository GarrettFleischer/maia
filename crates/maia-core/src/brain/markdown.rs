//! Git-friendly Markdown for one brain neuron.
//!
//! Frontmatter values are JSON so ids, paths, and punctuation round-trip.
//! A generated `## Links` section mirrors edges as wikilinks and is stripped
//! on parse. The prose body stays the ranking text.

use std::collections::BTreeMap;

use sha2::Digest;
use sha2::Sha256;

use crate::audit::Timestamp;
use crate::brain::graph::GraphClaim;
use crate::brain::graph::GraphEdge;
use crate::brain::graph::GraphEpisode;
use crate::brain::graph::GraphFact;
use crate::brain::graph::MemoryScope;
use crate::brain::graph::QuarantineSet;
use crate::brain::graph::RecallGraph;
use crate::brain::graph::StoredEmbedding;
use crate::brain::ids::ClaimId;
use crate::brain::ids::EpisodeId;
use crate::brain::ids::FactId;
use crate::brain::ids::LexemeId;
use crate::brain::ids::MemoryRef;
use crate::brain::ids::NodeId;
use crate::credit::WeightedPresentation;
use crate::brain::graph::EmbedderModel;
use crate::security::Taint;

/// One typed edge stored on the source neuron.
#[derive(Debug, Clone, PartialEq)]
pub struct NeuronEdge {
    /// Edge kind such as `mention`, `lexeme`, `wikilink`, or `reference`.
    pub edge_type: String,
    /// Target kind.
    pub to_kind: String,
    /// Target id.
    pub to_id: String,
    /// Weight times 1000.
    pub weight_millis: i64,
    /// Empty for older rows. Auto-link uses `auto-link`.
    pub source: String,
    /// `trusted` or `untrusted`.
    pub taint: String,
    /// Byte span in the source text, when the edge came from a match.
    pub span_start: Option<i64>,
    /// Byte span end.
    pub span_end: Option<i64>,
}

/// One traced presentation carried for activation.
#[derive(Debug, Clone, PartialEq)]
pub struct NeuronPresentation {
    /// Recorded weight.
    pub weight: f64,
    /// Presentation time in unix seconds.
    pub presented_at: i64,
}

/// One episode segment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeuronSegment {
    /// Segment text.
    pub text: String,
    /// `trusted` or `untrusted`.
    pub taint: String,
    /// Provenance label.
    pub sources: String,
}

/// One claim, fact, or episode written as a single Markdown file.
#[derive(Debug, Clone, PartialEq)]
pub struct NeuronDoc {
    /// Stable id.
    pub id: String,
    /// `claim`, `fact`, or `episode`.
    pub kind: String,
    /// Short title.
    pub title: String,
    /// Sentence or episode body. This is the ranking text.
    pub body: String,
    /// `trusted` or `untrusted`.
    pub taint: String,
    /// Creation time.
    pub created_at: i64,
    /// Last edit time used by sync.
    pub updated_at: i64,
    /// Set when a deleted Markdown file was applied as a soft-delete.
    pub deleted_at: Option<i64>,
    /// `provisional`, `superseded`, `canonical`, `closed`, or `stored`.
    pub status: String,
    /// `world`, `unscoped`, or `agent:<id>`.
    pub scope: String,
    /// Source episode for a claim.
    pub source_episode: Option<String>,
    /// Canonical fact that superseded this claim.
    pub consolidated_by: Option<String>,
    /// Claims this fact consolidated.
    pub consolidates: Vec<String>,
    /// Validity start.
    pub valid_from: i64,
    /// Validity end when a newer fact closed this one.
    pub valid_to: Option<i64>,
    /// Episode thread.
    pub thread_id: String,
    /// Episode turn.
    pub turn_id: String,
    /// Episode participants.
    pub participants: String,
    /// Optional reasoning trace.
    pub reasoning: Option<String>,
    /// Fact source text.
    pub sources: String,
    /// Lexeme ids.
    pub lexemes: Vec<String>,
    /// Extra match names.
    pub aliases: Vec<String>,
    /// Correction hold.
    pub held: bool,
    /// Embedder id, when a vector is present.
    pub embedding_model: Option<String>,
    /// Finite vector components.
    pub embedding: Vec<f64>,
    /// Traced presentations.
    pub presentations: Vec<NeuronPresentation>,
    /// Outgoing edges.
    pub edges: Vec<NeuronEdge>,
    /// Episode segments.
    pub segments: Vec<NeuronSegment>,
    /// Provenance labels.
    pub provenance: Vec<String>,
    /// Replacement claim id.
    pub replaced_by: Option<String>,
    /// Fact this row merged into.
    pub merged_into: Option<String>,
    /// Fact that replaced this one.
    pub replacement_fact_id: Option<String>,
    /// Optional entity id.
    pub entity_id: Option<String>,
}

/// Markdown that could not be parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownError {
    /// What failed.
    pub message: String,
}

impl NeuronDoc {
    /// A claim or fact shell. Callers fill edges and status.
    #[must_use]
    pub fn prose(kind: &str, id: &str, body: &str, taint: &str, at: i64) -> Self {
        Self {
            id: id.to_owned(),
            kind: kind.to_owned(),
            title: neuron_title(id, body),
            body: body.to_owned(),
            taint: taint.to_owned(),
            created_at: at,
            updated_at: at,
            deleted_at: None,
            status: if kind == "episode" {
                "stored".to_owned()
            } else if kind == "fact" {
                "canonical".to_owned()
            } else {
                "provisional".to_owned()
            },
            scope: "world".to_owned(),
            source_episode: None,
            consolidated_by: None,
            consolidates: Vec::new(),
            valid_from: at,
            valid_to: None,
            thread_id: String::new(),
            turn_id: String::new(),
            participants: String::new(),
            reasoning: None,
            sources: String::new(),
            lexemes: Vec::new(),
            aliases: Vec::new(),
            held: false,
            embedding_model: None,
            embedding: Vec::new(),
            presentations: Vec::new(),
            edges: Vec::new(),
            segments: Vec::new(),
            provenance: Vec::new(),
            replaced_by: None,
            merged_into: None,
            replacement_fact_id: None,
            entity_id: None,
        }
    }
}

/// First line, trimmed, at most 80 characters. An empty body uses the id.
#[must_use]
pub fn neuron_title(id: &str, body: &str) -> String {
    let line = body.lines().next().unwrap_or("").trim();
    let line = if line.is_empty() { id } else { line };
    line.chars().take(80).collect()
}

/// Stable `kind/title--id` slug. The id keeps collisions apart.
#[must_use]
pub fn neuron_slug(kind: &str, id: &str, title: &str) -> String {
    let mut base = String::new();
    let mut hyphen = false;
    for ch in title.chars() {
        if base.chars().count() >= 48 {
            break;
        }
        if ch.is_ascii_alphanumeric() {
            base.push(ch.to_ascii_lowercase());
            hyphen = false;
        } else if !hyphen && !base.is_empty() {
            base.push('-');
            hyphen = true;
        }
    }
    while base.ends_with('-') {
        base.pop();
    }
    if base.is_empty() {
        base.push_str("note");
    }
    format!("{kind}/{base}--{}", sanitize_id(id))
}

/// Relative Markdown path for one neuron.
#[must_use]
pub fn markdown_path(doc: &NeuronDoc) -> String {
    format!("{}.md", neuron_slug(&doc.kind, &doc.id, &doc.title))
}

/// Assigns paths and suffixes a numeric tail when two neurons want one path.
#[must_use]
pub fn assign_markdown_paths(docs: &[NeuronDoc]) -> Vec<(String, NeuronDoc)> {
    let desired: Vec<(String, String)> = docs
        .iter()
        .map(|doc| (markdown_path(doc), doc.id.clone()))
        .collect();
    let paths = disambiguate_paths(&desired);
    docs.iter()
        .enumerate()
        .map(|(index, doc)| (paths[index].clone(), doc.clone()))
        .collect()
}

/// Makes paths unique without dropping an id.
#[must_use]
pub fn disambiguate_paths(desired: &[(String, String)]) -> Vec<String> {
    let mut used: BTreeMap<String, String> = BTreeMap::new();
    let mut out = Vec::with_capacity(desired.len());
    for (path, id) in desired {
        if used.get(path).is_none_or(|owner| owner == id) {
            used.insert(path.clone(), id.clone());
            out.push(path.clone());
            continue;
        }
        let (stem, ext) = path
            .strip_suffix(".md")
            .map_or((path.as_str(), ""), |stem| (stem, ".md"));
        let mut chosen = String::new();
        for suffix in 2..10_000 {
            let candidate = format!("{stem}-{suffix}{ext}");
            if used.get(&candidate).is_none_or(|owner| owner == id) {
                chosen = candidate;
                break;
            }
        }
        if chosen.is_empty() {
            chosen = format!("{stem}--{id}{ext}");
        }
        used.insert(chosen.clone(), id.clone());
        out.push(chosen);
    }
    out
}

/// SHA-256 hex of the prose body.
#[must_use]
pub fn body_fingerprint(body: &str) -> String {
    let digest = Sha256::digest(body.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Renders one neuron, including a wikilink mirror of its edges.
#[must_use]
pub fn render_neuron(doc: &NeuronDoc) -> String {
    let mut front = String::from("---\n");
    push_json(&mut front, "id", &doc.id);
    push_json(&mut front, "kind", &doc.kind);
    push_json(&mut front, "title", &doc.title);
    push_json(&mut front, "taint", &doc.taint);
    push_i64(&mut front, "created_at", doc.created_at);
    push_i64(&mut front, "updated_at", doc.updated_at);
    push_opt_i64(&mut front, "deleted_at", doc.deleted_at);
    push_json(&mut front, "status", &doc.status);
    push_json(&mut front, "scope", &doc.scope);
    push_opt_string(&mut front, "source_episode", doc.source_episode.as_deref());
    push_opt_string(&mut front, "consolidated_by", doc.consolidated_by.as_deref());
    push_strings(&mut front, "consolidates", &doc.consolidates);
    push_i64(&mut front, "valid_from", doc.valid_from);
    push_opt_i64(&mut front, "valid_to", doc.valid_to);
    push_json(&mut front, "thread_id", &doc.thread_id);
    push_json(&mut front, "turn_id", &doc.turn_id);
    push_json(&mut front, "participants", &doc.participants);
    push_opt_string(&mut front, "reasoning", doc.reasoning.as_deref());
    push_json(&mut front, "sources", &doc.sources);
    push_strings(&mut front, "lexemes", &doc.lexemes);
    push_strings(&mut front, "aliases", &doc.aliases);
    push_bool(&mut front, "held", doc.held);
    push_opt_string(&mut front, "embedding_model", doc.embedding_model.as_deref());
    push_f64s(&mut front, "embedding", &doc.embedding);
    push_presentations(&mut front, &doc.presentations);
    push_edges(&mut front, &doc.edges);
    push_segments(&mut front, &doc.segments);
    push_strings(&mut front, "provenance", &doc.provenance);
    push_opt_string(&mut front, "replaced_by", doc.replaced_by.as_deref());
    push_opt_string(&mut front, "merged_into", doc.merged_into.as_deref());
    push_opt_string(
        &mut front,
        "replacement_fact_id",
        doc.replacement_fact_id.as_deref(),
    );
    push_opt_string(&mut front, "entity_id", doc.entity_id.as_deref());
    front.push_str("---\n");
    front.push_str(&doc.body);
    front.push_str(&links_section(&doc.edges));
    front
}

/// Parses one neuron file.
///
/// # Errors
///
/// Returns [`MarkdownError`] when the fences or a JSON value are invalid.
pub fn parse_neuron(text: &str) -> Result<NeuronDoc, MarkdownError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| MarkdownError {
            message: "missing opening frontmatter fence".to_owned(),
        })?;
    let (front, body) = split_frontmatter(rest)?;
    let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for line in front.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let (key, raw) = line.split_once(':').ok_or_else(|| MarkdownError {
            message: "frontmatter line needs a colon".to_owned(),
        })?;
        let value = serde_json::from_str(raw.trim()).map_err(|_| MarkdownError {
            message: format!("invalid JSON for {}", key.trim()),
        })?;
        fields.insert(key.trim().to_owned(), value);
    }
    let edges = edges_from(fields.get("edges"))?;
    let mut doc = NeuronDoc::prose("claim", "", "", "trusted", 0);
    doc.id = string_field(&fields, "id")?;
    doc.kind = string_field(&fields, "kind")?;
    doc.title = optional_string(&fields, "title").unwrap_or_else(|| neuron_title(&doc.id, ""));
    doc.taint = optional_string(&fields, "taint").unwrap_or_else(|| "trusted".to_owned());
    doc.created_at = optional_i64(&fields, "created_at").unwrap_or(0);
    doc.updated_at = optional_i64(&fields, "updated_at").unwrap_or(doc.created_at);
    doc.deleted_at = optional_opt_i64(&fields, "deleted_at");
    doc.status = optional_string(&fields, "status").unwrap_or_else(|| doc.status.clone());
    doc.scope = optional_string(&fields, "scope").unwrap_or_else(|| "world".to_owned());
    doc.source_episode = optional_opt_string(&fields, "source_episode");
    doc.consolidated_by = optional_opt_string(&fields, "consolidated_by");
    doc.consolidates = string_list(fields.get("consolidates"));
    doc.valid_from = optional_i64(&fields, "valid_from").unwrap_or(doc.created_at);
    doc.valid_to = optional_opt_i64(&fields, "valid_to");
    doc.thread_id = optional_string(&fields, "thread_id").unwrap_or_default();
    doc.turn_id = optional_string(&fields, "turn_id").unwrap_or_default();
    doc.participants = optional_string(&fields, "participants").unwrap_or_default();
    doc.reasoning = optional_opt_string(&fields, "reasoning");
    doc.sources = optional_string(&fields, "sources").unwrap_or_default();
    doc.lexemes = string_list(fields.get("lexemes"));
    doc.aliases = string_list(fields.get("aliases"));
    doc.held = fields.get("held").and_then(serde_json::Value::as_bool).unwrap_or(false);
    doc.embedding_model = optional_opt_string(&fields, "embedding_model");
    doc.embedding = f64_list(fields.get("embedding"));
    doc.presentations = presentations_from(fields.get("presentations"))?;
    doc.edges = edges;
    doc.segments = segments_from(fields.get("segments"))?;
    doc.provenance = string_list(fields.get("provenance"));
    doc.replaced_by = optional_opt_string(&fields, "replaced_by");
    doc.merged_into = optional_opt_string(&fields, "merged_into");
    doc.replacement_fact_id = optional_opt_string(&fields, "replacement_fact_id");
    doc.entity_id = optional_opt_string(&fields, "entity_id");
    doc.body = strip_generated_links(body, &doc.edges);
    if doc.title.is_empty() {
        doc.title = neuron_title(&doc.id, &doc.body);
    }
    if doc.id.is_empty() || doc.kind.is_empty() {
        return Err(MarkdownError {
            message: "id and kind are required".to_owned(),
        });
    }
    Ok(doc)
}

/// Builds the ranker inputs represented by these files.
#[must_use]
pub fn graph_from_docs(docs: &[NeuronDoc]) -> (RecallGraph, QuarantineSet) {
    let mut graph = RecallGraph::default();
    let mut quarantine = Vec::new();
    for doc in docs {
        if doc.deleted_at.is_some() {
            continue;
        }
        match doc.kind.as_str() {
            "claim" => {
                let id = ClaimId::new(doc.id.clone());
                if doc.held {
                    quarantine.push(MemoryRef::Claim(id.clone()));
                }
                graph.claims.insert(id, claim_from(doc));
            }
            "fact" => {
                let id = FactId::new(doc.id.clone());
                if doc.held {
                    quarantine.push(MemoryRef::Fact(id.clone()));
                }
                graph.facts.insert(id, fact_from(doc));
            }
            "episode" => {
                graph.episodes.insert(
                    EpisodeId::new(doc.id.clone()),
                    GraphEpisode {
                        text: doc.body.clone(),
                        lexemes: lexeme_ids(&doc.lexemes),
                        embedding: stored_embedding(doc),
                    },
                );
            }
            _ => {}
        }
    }
    for doc in docs {
        if doc.deleted_at.is_some() {
            continue;
        }
        let Some(from) = node_for(&doc.kind, &doc.id) else {
            continue;
        };
        for edge in &doc.edges {
            push_graph_edge(&mut graph, &from, edge);
        }
    }
    (graph, QuarantineSet::new(quarantine))
}

fn claim_from(doc: &NeuronDoc) -> GraphClaim {
    GraphClaim {
        sentence: doc.body.clone(),
        taint: parse_taint(&doc.taint),
        scope: parse_scope(&doc.scope),
        lexemes: lexeme_ids(&doc.lexemes),
        embedding: stored_embedding(doc),
        presentations: presentations_of(doc),
        consolidated_by: doc.consolidated_by.as_ref().map(|id| FactId::new(id.clone())),
        source_episode: doc.source_episode.as_ref().map(|id| EpisodeId::new(id.clone())),
    }
}

fn fact_from(doc: &NeuronDoc) -> GraphFact {
    GraphFact {
        sentence: doc.body.clone(),
        taint: parse_taint(&doc.taint),
        scope: parse_scope(&doc.scope),
        lexemes: lexeme_ids(&doc.lexemes),
        embedding: stored_embedding(doc),
        presentations: presentations_of(doc),
        valid_from: Timestamp(doc.valid_from),
        valid_end: doc.valid_to.map(Timestamp),
        consolidates: doc
            .consolidates
            .iter()
            .map(|id| ClaimId::new(id.clone()))
            .collect(),
    }
}

fn presentations_of(doc: &NeuronDoc) -> Vec<WeightedPresentation> {
    doc.presentations
        .iter()
        .map(|row| WeightedPresentation {
            weight: row.weight,
            presented_at: Timestamp(row.presented_at),
        })
        .collect()
}

fn stored_embedding(doc: &NeuronDoc) -> Option<StoredEmbedding> {
    let model = doc.embedding_model.as_ref()?;
    if doc.embedding.is_empty() || doc.embedding.iter().any(|value| !value.is_finite()) {
        return None;
    }
    Some(StoredEmbedding {
        values: doc.embedding.clone(),
        model: EmbedderModel::new(model.clone()),
    })
}

fn lexeme_ids(lexemes: &[String]) -> Vec<LexemeId> {
    lexemes.iter().cloned().map(LexemeId::new).collect()
}

fn parse_taint(taint: &str) -> Taint {
    if taint == "untrusted" {
        Taint::Untrusted
    } else {
        Taint::Trusted
    }
}

fn parse_scope(scope: &str) -> MemoryScope {
    if let Some(id) = scope.strip_prefix("agent:") {
        if let Ok(parsed) = id.parse::<u64>() {
            return MemoryScope::Agent(crate::agents::AgentId(parsed));
        }
    }
    if scope == "unscoped" {
        MemoryScope::Unscoped
    } else {
        MemoryScope::World
    }
}

fn node_for(kind: &str, id: &str) -> Option<NodeId> {
    match kind {
        "claim" => Some(NodeId::Claim(ClaimId::new(id))),
        "fact" => Some(NodeId::Fact(FactId::new(id))),
        "episode" => Some(NodeId::Episode(EpisodeId::new(id))),
        "lexeme" => Some(NodeId::Lexeme(LexemeId::new(id))),
        _ => None,
    }
}

fn push_graph_edge(graph: &mut RecallGraph, from: &NodeId, edge: &NeuronEdge) {
    let weight = f64::from(u32::try_from(edge.weight_millis.max(0)).unwrap_or(0)) / 1000.0;
    if weight <= 0.0 {
        return;
    }
    if edge.to_kind == "lexeme" {
        let lexeme = LexemeId::new(edge.to_id.clone());
        graph.lexemes.insert(lexeme.clone());
        graph.edges.push(GraphEdge {
            from: NodeId::Lexeme(lexeme),
            to: from.clone(),
            weight,
        });
        return;
    }
    let Some(to) = node_for(&edge.to_kind, &edge.to_id) else {
        return;
    };
    graph.edges.push(GraphEdge {
        from: from.clone(),
        to: to.clone(),
        weight,
    });
    if edge.edge_type == "co_use" || edge.edge_type == "relatedness" {
        graph.edges.push(GraphEdge {
            from: to,
            to: from.clone(),
            weight,
        });
    }
}

fn links_section(edges: &[NeuronEdge]) -> String {
    let mut section = String::from("\n## Links\n");
    for edge in edges {
        section.push_str("[[");
        section.push_str(&edge.to_kind);
        section.push('/');
        section.push_str(&edge.to_id);
        section.push_str("]]\n");
    }
    section
}

fn strip_generated_links(body: &str, edges: &[NeuronEdge]) -> String {
    let suffix = links_section(edges);
    body.strip_suffix(&suffix)
        .unwrap_or(body)
        .to_owned()
}

fn split_frontmatter(rest: &str) -> Result<(&str, &str), MarkdownError> {
    if let Some(index) = rest.find("\n---\n") {
        return Ok((&rest[..index], &rest[index + 5..]));
    }
    if let Some(index) = rest.find("\n---\r\n") {
        return Ok((&rest[..index], &rest[index + 6..]));
    }
    Err(MarkdownError {
        message: "missing closing frontmatter fence".to_owned(),
    })
}

fn sanitize_id(id: &str) -> String {
    let mut out = String::new();
    for ch in id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    if out.is_empty() {
        out.push_str("id");
    }
    out
}

fn push_json(out: &mut String, key: &str, value: &str) {
    out.push_str(key);
    out.push_str(": ");
    out.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned()));
    out.push('\n');
}

fn push_i64(out: &mut String, key: &str, value: i64) {
    out.push_str(key);
    out.push_str(": ");
    out.push_str(&value.to_string());
    out.push('\n');
}

fn push_opt_i64(out: &mut String, key: &str, value: Option<i64>) {
    out.push_str(key);
    out.push_str(": ");
    match value {
        Some(value) => out.push_str(&value.to_string()),
        None => out.push_str("null"),
    }
    out.push('\n');
}

fn push_opt_string(out: &mut String, key: &str, value: Option<&str>) {
    out.push_str(key);
    out.push_str(": ");
    match value {
        Some(value) => push_raw_json(out, &serde_json::json!(value)),
        None => out.push_str("null"),
    }
    out.push('\n');
}

fn push_bool(out: &mut String, key: &str, value: bool) {
    out.push_str(key);
    out.push_str(": ");
    out.push_str(if value { "true" } else { "false" });
    out.push('\n');
}

fn push_strings(out: &mut String, key: &str, values: &[String]) {
    out.push_str(key);
    out.push_str(": ");
    push_raw_json(out, &serde_json::json!(values));
    out.push('\n');
}

fn push_f64s(out: &mut String, key: &str, values: &[f64]) {
    out.push_str(key);
    out.push_str(": ");
    push_raw_json(out, &serde_json::json!(values));
    out.push('\n');
}

fn push_presentations(out: &mut String, rows: &[NeuronPresentation]) {
    let values: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| serde_json::json!({"weight": row.weight, "presented_at": row.presented_at}))
        .collect();
    out.push_str("presentations: ");
    push_raw_json(out, &serde_json::Value::Array(values));
    out.push('\n');
}

fn push_edges(out: &mut String, edges: &[NeuronEdge]) {
    let values: Vec<serde_json::Value> = edges
        .iter()
        .map(|edge| {
            serde_json::json!({
                "type": edge.edge_type,
                "to_kind": edge.to_kind,
                "to_id": edge.to_id,
                "weight_millis": edge.weight_millis,
                "source": edge.source,
                "taint": edge.taint,
                "span_start": edge.span_start,
                "span_end": edge.span_end,
            })
        })
        .collect();
    out.push_str("edges: ");
    push_raw_json(out, &serde_json::Value::Array(values));
    out.push('\n');
}

fn push_segments(out: &mut String, segments: &[NeuronSegment]) {
    let values: Vec<serde_json::Value> = segments
        .iter()
        .map(|segment| {
            serde_json::json!({
                "text": segment.text,
                "taint": segment.taint,
                "sources": segment.sources,
            })
        })
        .collect();
    out.push_str("segments: ");
    push_raw_json(out, &serde_json::Value::Array(values));
    out.push('\n');
}

fn push_raw_json(out: &mut String, value: &serde_json::Value) {
    out.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()));
}

fn string_field(fields: &BTreeMap<String, serde_json::Value>, key: &str) -> Result<String, MarkdownError> {
    optional_string(fields, key).ok_or_else(|| MarkdownError {
        message: format!("missing {key}"),
    })
}

fn optional_string(fields: &BTreeMap<String, serde_json::Value>, key: &str) -> Option<String> {
    fields.get(key).and_then(|value| value.as_str()).map(str::to_owned)
}

fn optional_opt_string(fields: &BTreeMap<String, serde_json::Value>, key: &str) -> Option<String> {
    let value = fields.get(key)?;
    if value.is_null() {
        return None;
    }
    value.as_str().map(str::to_owned)
}

fn optional_i64(fields: &BTreeMap<String, serde_json::Value>, key: &str) -> Option<i64> {
    fields.get(key).and_then(serde_json::Value::as_i64)
}

fn optional_opt_i64(fields: &BTreeMap<String, serde_json::Value>, key: &str) -> Option<i64> {
    let value = fields.get(key)?;
    if value.is_null() {
        return None;
    }
    value.as_i64()
}

fn string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn f64_list(value: Option<&serde_json::Value>) -> Vec<f64> {
    value
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(serde_json::Value::as_f64).collect())
        .unwrap_or_default()
}

fn edges_from(value: Option<&serde_json::Value>) -> Result<Vec<NeuronEdge>, MarkdownError> {
    let Some(items) = value.and_then(serde_json::Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut edges = Vec::new();
    for item in items {
        let object = item.as_object().ok_or_else(|| MarkdownError {
            message: "edge must be an object".to_owned(),
        })?;
        edges.push(NeuronEdge {
            edge_type: json_string(object, "type")?,
            to_kind: json_string(object, "to_kind")?,
            to_id: json_string(object, "to_id")?,
            weight_millis: object.get("weight_millis").and_then(serde_json::Value::as_i64).unwrap_or(1000),
            source: object
                .get("source")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_owned(),
            taint: object
                .get("taint")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("trusted")
                .to_owned(),
            span_start: object.get("span_start").and_then(serde_json::Value::as_i64),
            span_end: object.get("span_end").and_then(serde_json::Value::as_i64),
        });
    }
    Ok(edges)
}

fn segments_from(value: Option<&serde_json::Value>) -> Result<Vec<NeuronSegment>, MarkdownError> {
    let Some(items) = value.and_then(serde_json::Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut segments = Vec::new();
    for item in items {
        let object = item.as_object().ok_or_else(|| MarkdownError {
            message: "segment must be an object".to_owned(),
        })?;
        segments.push(NeuronSegment {
            text: json_string(object, "text")?,
            taint: json_string(object, "taint")?,
            sources: json_string(object, "sources")?,
        });
    }
    Ok(segments)
}

fn presentations_from(value: Option<&serde_json::Value>) -> Result<Vec<NeuronPresentation>, MarkdownError> {
    let Some(items) = value.and_then(serde_json::Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::new();
    for item in items {
        let object = item.as_object().ok_or_else(|| MarkdownError {
            message: "presentation must be an object".to_owned(),
        })?;
        rows.push(NeuronPresentation {
            weight: object.get("weight").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
            presented_at: object
                .get("presented_at")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0),
        });
    }
    Ok(rows)
}

fn json_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, MarkdownError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| MarkdownError {
            message: format!("missing edge field {key}"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::AgentId;
    use crate::brain::rank_paths;
    use crate::brain::LexemeId;
    use crate::brain::PageRankParams;
    use crate::brain::RankPolicy;
    use crate::brain::RecallQuery;
    use crate::brain::RecallTaintMode;
    use crate::brain::ScoreWeights;
    use crate::credit::AgeUnit;
    use std::collections::BTreeSet;

    fn sample() -> NeuronDoc {
        let mut claim = NeuronDoc::prose(
            "claim",
            "claim-1",
            "The project is named Bob's Best Burgers.",
            "untrusted",
            40,
        );
        claim.updated_at = 50;
        claim.status = "superseded".to_owned();
        claim.consolidated_by = Some("fact-1".to_owned());
        claim.source_episode = Some("episode-1".to_owned());
        claim.lexemes = vec!["bob".to_owned(), "burgers".to_owned()];
        claim.aliases = vec!["people/bob".to_owned()];
        claim.provenance = vec!["episode:episode-1".to_owned()];
        claim.edges.push(NeuronEdge {
            edge_type: "mention".to_owned(),
            to_kind: "episode".to_owned(),
            to_id: "episode-1".to_owned(),
            weight_millis: 1000,
            source: String::new(),
            taint: "untrusted".to_owned(),
            span_start: None,
            span_end: None,
        });
        claim.edges.push(NeuronEdge {
            edge_type: "lexeme".to_owned(),
            to_kind: "lexeme".to_owned(),
            to_id: "bob".to_owned(),
            weight_millis: 1000,
            source: String::new(),
            taint: "trusted".to_owned(),
            span_start: None,
            span_end: None,
        });
        claim
    }

    #[test]
    fn markdown_round_trip_keeps_body_edges_taint_and_supersession() {
        let claim = sample();
        let text = render_neuron(&claim);
        assert!(text.contains("[[episode/episode-1]]"));
        assert!(text.contains("Bob's Best Burgers"));
        let parsed = parse_neuron(&text).expect("parse");
        assert_eq!(parsed, claim);
        assert_eq!(
            neuron_slug(&claim.kind, &claim.id, &claim.title),
            neuron_slug(&claim.kind, &claim.id, &claim.title)
        );
        assert!(markdown_path(&claim).ends_with(&format!("--{}.md", claim.id)));
    }

    #[test]
    fn colliding_paths_gain_a_numeric_suffix() {
        let paths = disambiguate_paths(&[
            ("claim/note--a.md".to_owned(), "a".to_owned()),
            ("claim/note--a.md".to_owned(), "b".to_owned()),
        ]);
        assert_eq!(paths[0], "claim/note--a.md");
        assert_eq!(paths[1], "claim/note--a-2.md");
        assert_ne!(paths[0], paths[1]);
    }

    #[test]
    fn imported_docs_rank_the_same_paths_for_a_fixed_query() {
        let mut claim = sample();
        claim.status = "provisional".to_owned();
        claim.consolidated_by = None;
        let mut superseded = sample();
        superseded.id = "claim-old".to_owned();
        superseded.body = "Bob used to live in York.".to_owned();
        superseded.title = neuron_title(&superseded.id, &superseded.body);
        superseded.consolidated_by = Some("fact-1".to_owned());
        superseded.lexemes = vec!["bob".to_owned(), "york".to_owned()];
        let mut fact = NeuronDoc::prose("fact", "fact-1", "Bob lives in Portland.", "trusted", 80);
        fact.consolidates = vec!["claim-old".to_owned()];
        fact.lexemes = vec!["bob".to_owned(), "portland".to_owned()];
        fact.edges.push(NeuronEdge {
            edge_type: "lexeme".to_owned(),
            to_kind: "lexeme".to_owned(),
            to_id: "portland".to_owned(),
            weight_millis: 1000,
            source: String::new(),
            taint: "trusted".to_owned(),
            span_start: None,
            span_end: None,
        });
        let docs = vec![claim, superseded, fact];
        let rendered: Vec<String> = docs.iter().map(render_neuron).collect();
        let parsed: Vec<NeuronDoc> = rendered
            .iter()
            .map(|text| parse_neuron(text).expect("parse"))
            .collect();
        let (left_graph, left_hold) = graph_from_docs(&docs);
        let (right_graph, right_hold) = graph_from_docs(&parsed);
        let policy = RankPolicy {
            decay: 0.5,
            age_unit: AgeUnit::Seconds,
            lexical: crate::brain::LexicalPolicy {
                stopwords: BTreeSet::from(["the".to_owned()]),
                fan_out: BTreeMap::new(),
                high_fan_cutoff: 100,
            },
            pagerank: PageRankParams {
                damping: 0.5,
                iterations: 2,
            },
            weights: ScoreWeights {
                activation: 0.0,
                pagerank: 1.0,
                embedding: 0.0,
            },
            inclusion_threshold: 0.0,
            recall_token_budget: 400,
            taint_mode: RecallTaintMode::IncludeUntrusted,
        };
        let query = RecallQuery {
            text: "portland".to_owned(),
            embedding: None,
        };
        let left = rank_paths(
            &left_graph,
            &query,
            Timestamp(100),
            &policy,
            &left_hold,
            &BTreeSet::<AgentId>::new(),
        )
        .expect("rank");
        let right = rank_paths(
            &right_graph,
            &query,
            Timestamp(100),
            &policy,
            &right_hold,
            &BTreeSet::<AgentId>::new(),
        )
        .expect("rank");
        let left_ids: Vec<String> = left.iter().map(|row| row.scores.tie_break.clone()).collect();
        let right_ids: Vec<String> = right.iter().map(|row| row.scores.tie_break.clone()).collect();
        assert_eq!(left_ids, right_ids);
        assert!(left_ids.iter().any(|id| id.contains("fact-1")));
        assert!(!left_ids.iter().any(|id| id.contains("claim-old")));
        let _ = LexemeId::new("portland");
    }
}
