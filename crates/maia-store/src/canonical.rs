//! Deterministic request identities. Idempotent replays compare these strings.

use crate::error::StoreError;
use crate::limits::MAX_AUDIT_CANONICAL_BYTES;
use crate::limits::MAX_AUDIT_PAYLOAD_BYTES;
use crate::limits::MAX_PROSE_BYTES;
use crate::limits::MAX_THREAD_BATCH_BYTES;
use crate::limits::MAX_THREAD_EVENT_BODY_BYTES;
use crate::limits::MAX_THREAD_EVENTS_PER_APPEND;
use crate::limits::require_bounded;
use crate::types::AppendEvents;
use crate::types::AuditActor;
use crate::types::AuditAppend;
use crate::types::ConsolidationWrite;
use crate::types::EMBEDDING_DIMENSIONS;
use crate::types::EmbeddingModelWrite;
use crate::types::EpisodeWrite;
use crate::types::LedgerWrite;
use crate::types::PromotionWrite;

pub(crate) fn require_text(field: &str, value: &str) -> Result<(), StoreError> {
    if value.is_empty() {
        return Err(StoreError::InvalidRequest {
            message: format!("{field} must be non-empty"),
        });
    }
    Ok(())
}

fn require_weight(weight: f64) -> Result<(), StoreError> {
    if !weight.is_finite() || weight < 0.0 {
        return Err(StoreError::InvalidRequest {
            message: "weight must be finite and non-negative".to_owned(),
        });
    }
    Ok(())
}

fn require_span(start: i64, end: i64) -> Result<(), StoreError> {
    if start < 0 || end < start {
        return Err(StoreError::InvalidRequest {
            message: "span is out of order".to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn format_weight(weight: f64) -> String {
    format!("{weight:.6}")
}

pub(crate) fn validate_append(request: &AppendEvents) -> Result<(), StoreError> {
    require_text("thread_id", &request.thread_id)?;
    require_text("participants", &request.participants)?;
    let length = u64::try_from(request.events.len()).map_err(|_| StoreError::InvalidRequest {
        message: "too many events".to_owned(),
    })?;
    if request.expected_version.checked_add(length).is_none() {
        return Err(StoreError::InvalidRequest {
            message: "thread version overflow".to_owned(),
        });
    }
    require_bounded(
        "thread_event_batch",
        request.events.len(),
        MAX_THREAD_EVENTS_PER_APPEND,
    )?;
    let mut total = 0_usize;
    for event in &request.events {
        require_text("event_id", &event.event_id)?;
        require_text("kind", &event.kind)?;
        require_bounded(
            "thread_event_body",
            event.body.len(),
            MAX_THREAD_EVENT_BODY_BYTES,
        )?;
        total = total.checked_add(event.body.len()).ok_or_else(|| {
            StoreError::ResourceLimit(crate::error::ResourceLimit {
                field: "thread_batch_bytes",
                limit: MAX_THREAD_BATCH_BYTES,
                actual: usize::MAX,
            })
        })?;
    }
    require_bounded("thread_batch_bytes", total, MAX_THREAD_BATCH_BYTES)?;
    Ok(())
}

pub(crate) fn episode_canonical(request: &EpisodeWrite) -> Result<String, StoreError> {
    require_text("episode_id", &request.episode_id)?;
    require_text("thread_id", &request.thread_id)?;
    require_text("turn_id", &request.turn_id)?;
    require_text("participants", &request.participants)?;
    require_bounded("episode_body", request.body.len(), MAX_PROSE_BYTES)?;
    if let Some(reasoning) = &request.reasoning {
        require_bounded("episode_reasoning", reasoning.len(), MAX_PROSE_BYTES)?;
    }
    let mut text = String::new();
    text.push_str("episode ");
    text.push_str(&request.episode_id);
    text.push('\n');
    text.push_str("thread ");
    text.push_str(&request.thread_id);
    text.push('\n');
    text.push_str("turn ");
    text.push_str(&request.turn_id);
    text.push('\n');
    text.push_str("taint ");
    text.push_str(request.taint.as_str());
    text.push('\n');
    text.push_str("participants ");
    text.push_str(&request.participants);
    text.push('\n');
    text.push_str("at ");
    text.push_str(&request.created_at.to_string());
    text.push('\n');
    text.push_str("body ");
    text.push_str(&request.body);
    text.push('\n');
    text.push_str("reasoning ");
    text.push_str(request.reasoning.as_deref().unwrap_or(""));
    text.push('\n');
    for (index, segment) in request.segments.iter().enumerate() {
        require_text("segment", &segment.text)?;
        require_bounded("episode_segment", segment.text.len(), MAX_PROSE_BYTES)?;
        text.push_str("segment ");
        text.push_str(&index.to_string());
        text.push(' ');
        text.push_str(segment.taint.as_str());
        text.push(' ');
        text.push_str(&segment.sources);
        text.push(' ');
        text.push_str(&segment.text);
        text.push('\n');
    }
    Ok(text)
}

pub(crate) fn promotion_canonical(request: &PromotionWrite) -> Result<String, StoreError> {
    require_text("episode_id", &request.episode_id)?;
    require_text("model", &request.model)?;
    if !request.session_bot_id.is_empty() {
        require_text("session_bot_id", &request.session_bot_id)?;
    }
    if !request.session_summary.is_empty() {
        require_bounded(
            "session_summary",
            request.session_summary.len(),
            MAX_PROSE_BYTES,
        )?;
    }
    let mut text = String::new();
    text.push_str("promotion ");
    text.push_str(&request.episode_id);
    text.push(' ');
    text.push_str(&request.model);
    text.push(' ');
    text.push_str(&request.now.to_string());
    text.push('\n');
    if !request.session_bot_id.is_empty() && !request.session_summary.is_empty() {
        text.push_str("summary ");
        text.push_str(&request.session_bot_id);
        text.push(' ');
        text.push_str(&request.session_summary);
        text.push('\n');
    }
    for claim in &request.claims {
        require_text("claim_id", &claim.claim_id)?;
        require_text("sentence", &claim.sentence)?;
        require_bounded("claim_sentence", claim.sentence.len(), MAX_PROSE_BYTES)?;
        text.push_str("claim ");
        text.push_str(&claim.claim_id);
        text.push(' ');
        text.push_str(claim.taint.as_str());
        text.push(' ');
        text.push_str(&claim.valid_from.to_string());
        text.push(' ');
        text.push_str(&claim.sentence);
        text.push('\n');
        for lexeme in &claim.lexemes {
            require_text("lexeme", lexeme)?;
            text.push_str("lexeme ");
            text.push_str(lexeme);
            text.push('\n');
        }
    }
    for claim_id in &request.same_claim_ids {
        require_text("same_claim_id", claim_id)?;
        text.push_str("same ");
        text.push_str(claim_id);
        text.push('\n');
    }
    for replacement in &request.replacements {
        require_text("old_claim_id", &replacement.old_claim_id)?;
        require_text("new_claim_id", &replacement.new_claim_id)?;
        text.push_str("replace ");
        text.push_str(&replacement.old_claim_id);
        text.push(' ');
        text.push_str(&replacement.new_claim_id);
        text.push('\n');
    }
    let mut links = request.links.clone();
    links.sort_by(|left, right| {
        left.edge_kind
            .cmp(&right.edge_kind)
            .then_with(|| left.from_claim_id.cmp(&right.from_claim_id))
            .then_with(|| left.to_kind.cmp(&right.to_kind))
            .then_with(|| left.to_id.cmp(&right.to_id))
    });
    for link in &links {
        require_text("link_kind", &link.edge_kind)?;
        require_text("from_claim_id", &link.from_claim_id)?;
        require_text("to_kind", &link.to_kind)?;
        require_text("to_id", &link.to_id)?;
        if link.weight_millis == 0 || link.weight_millis > 1000 {
            return Err(StoreError::InvalidRequest {
                message: "promotion link weight must be between 1 and 1000 millis".to_owned(),
            });
        }
        text.push_str("link ");
        text.push_str(&link.edge_kind);
        text.push(' ');
        text.push_str(&link.from_claim_id);
        text.push(' ');
        text.push_str(&link.to_kind);
        text.push(' ');
        text.push_str(&link.to_id);
        text.push(' ');
        text.push_str(&link.weight_millis.to_string());
        text.push('\n');
    }
    Ok(text)
}

pub(crate) fn ledger_canonical(request: &LedgerWrite) -> Result<String, StoreError> {
    require_text("ledger_id", &request.ledger_id)?;
    require_text("thread_id", &request.thread_id)?;
    require_text("request_id", &request.request_id)?;
    require_text("compiled_prefix_hash", &request.compiled_prefix_hash)?;
    let mut text = String::new();
    text.push_str("ledger ");
    text.push_str(&request.ledger_id);
    text.push('\n');
    text.push_str("thread ");
    text.push_str(&request.thread_id);
    text.push('\n');
    text.push_str("request ");
    text.push_str(&request.request_id);
    text.push('\n');
    text.push_str("hash ");
    text.push_str(&request.compiled_prefix_hash);
    text.push('\n');
    text.push_str("at ");
    text.push_str(&request.applied_at.to_string());
    text.push('\n');
    for presentation in &request.presentations {
        require_text("presentation_id", &presentation.presentation_id)?;
        require_text("candidate_id", &presentation.candidate_id)?;
        require_text("thread_id", &presentation.thread_id)?;
        require_weight(presentation.weight)?;
        require_span(presentation.source_span_start, presentation.source_span_end)?;
        require_span(
            presentation.evidence_span_start,
            presentation.evidence_span_end,
        )?;
        text.push_str("presentation ");
        text.push_str(&presentation.presentation_id);
        text.push(' ');
        text.push_str(presentation.candidate_kind.as_str());
        text.push(' ');
        text.push_str(&presentation.candidate_id);
        text.push(' ');
        text.push_str(presentation.source.as_str());
        text.push(' ');
        text.push_str(&format_weight(presentation.weight));
        text.push(' ');
        text.push_str(&presentation.source_span_start.to_string());
        text.push(' ');
        text.push_str(&presentation.source_span_end.to_string());
        text.push(' ');
        text.push_str(&presentation.evidence_span_start.to_string());
        text.push(' ');
        text.push_str(&presentation.evidence_span_end.to_string());
        text.push(' ');
        text.push_str(&presentation.thread_id);
        text.push('\n');
    }
    for heat in &request.heat {
        require_text("slot_id", &heat.slot_id)?;
        require_weight(heat.weight)?;
        text.push_str("heat ");
        text.push_str(&heat.slot_id);
        text.push(' ');
        text.push_str(&format_weight(heat.weight));
        text.push('\n');
    }
    for edge in &request.co_use {
        require_text("left_id", &edge.left_id)?;
        require_text("right_id", &edge.right_id)?;
        require_weight(edge.weight)?;
        text.push_str("co_use ");
        text.push_str(edge.left_kind.as_str());
        text.push(' ');
        text.push_str(&edge.left_id);
        text.push(' ');
        text.push_str(edge.right_kind.as_str());
        text.push(' ');
        text.push_str(&edge.right_id);
        text.push(' ');
        text.push_str(&format_weight(edge.weight));
        text.push('\n');
    }
    for mark in &request.negative_marks {
        require_text("mark_id", &mark.mark_id)?;
        require_text("target_id", &mark.target_id)?;
        require_text("presentation_id", &mark.presentation_id)?;
        require_text("thread_id", &mark.thread_id)?;
        require_text("message_id", &mark.message_id)?;
        require_text("dream_queue_id", &mark.dream_queue_id)?;
        require_span(mark.evidence_span_start, mark.evidence_span_end)?;
        text.push_str("mark ");
        text.push_str(&mark.mark_id);
        text.push(' ');
        text.push_str(mark.target_kind.as_str());
        text.push(' ');
        text.push_str(&mark.target_id);
        text.push(' ');
        text.push_str(&mark.presentation_id);
        text.push(' ');
        text.push_str(&mark.thread_id);
        text.push(' ');
        text.push_str(&mark.message_id);
        text.push(' ');
        text.push_str(&mark.evidence_span_start.to_string());
        text.push(' ');
        text.push_str(&mark.evidence_span_end.to_string());
        text.push(' ');
        text.push_str(&mark.occurred_at.to_string());
        text.push(' ');
        text.push_str(&mark.dream_queue_id);
        text.push('\n');
    }
    Ok(text)
}

pub(crate) fn consolidation_canonical(request: &ConsolidationWrite) -> Result<String, StoreError> {
    require_text("batch_id", &request.batch_id)?;
    require_text("model", &request.model)?;
    let mut text = String::new();
    text.push_str("batch ");
    text.push_str(&request.batch_id);
    text.push(' ');
    text.push_str(&request.model);
    text.push(' ');
    text.push_str(request.context_taint.as_str());
    text.push(' ');
    text.push_str(&request.now.to_string());
    text.push('\n');
    for entity in &request.entities {
        require_text("entity_id", &entity.entity_id)?;
        require_text("slug", &entity.slug)?;
        require_bounded(
            "entity_description",
            entity.description.len(),
            MAX_PROSE_BYTES,
        )?;
        text.push_str("entity ");
        text.push_str(&entity.entity_id);
        text.push(' ');
        text.push_str(&entity.slug);
        text.push(' ');
        text.push_str(&entity.description);
        match &entity.scope {
            crate::types::EntityScope::World => text.push_str(" world\n"),
            crate::types::EntityScope::Agent { agent_id } => {
                require_text("agent_id", agent_id)?;
                text.push_str(" agent ");
                text.push_str(agent_id);
                text.push('\n');
            }
        }
        for seen in &entity.see {
            require_text("see", seen)?;
            text.push_str("see ");
            text.push_str(seen);
            text.push('\n');
        }
    }
    for fact in &request.facts {
        require_text("fact_id", &fact.fact_id)?;
        require_text("sentence", &fact.sentence)?;
        require_bounded("fact_sentence", fact.sentence.len(), MAX_PROSE_BYTES)?;
        text.push_str("fact ");
        text.push_str(&fact.fact_id);
        text.push(' ');
        text.push_str(fact.entity_id.as_deref().unwrap_or(""));
        text.push(' ');
        text.push_str(&fact.sources);
        text.push(' ');
        text.push_str(&fact.valid_from.to_string());
        text.push(' ');
        text.push_str(&fact.sentence);
        text.push('\n');
        for claim_id in &fact.claim_ids {
            require_text("claim_id", claim_id)?;
            text.push_str("fact_claim ");
            text.push_str(claim_id);
            text.push('\n');
        }
        for episode_id in &fact.episode_ids {
            require_text("episode_id", episode_id)?;
            text.push_str("fact_episode ");
            text.push_str(episode_id);
            text.push('\n');
        }
    }
    for row in &request.supersede {
        require_text("claim_id", &row.claim_id)?;
        require_text("fact_id", &row.fact_id)?;
        text.push_str("supersede ");
        text.push_str(&row.claim_id);
        text.push(' ');
        text.push_str(&row.fact_id);
        text.push('\n');
    }
    for row in &request.merges {
        text.push_str("merge ");
        text.push_str(&row.duplicate_fact_id);
        text.push(' ');
        text.push_str(&row.canonical_fact_id);
        text.push('\n');
    }
    for row in &request.closures {
        text.push_str("close ");
        text.push_str(&row.fact_id);
        text.push(' ');
        text.push_str(&row.replacement_fact_id);
        text.push(' ');
        text.push_str(&row.valid_to.to_string());
        text.push('\n');
    }
    for row in &request.dismissals {
        text.push_str("dismissal ");
        text.push_str(&row.existing_fact_id);
        text.push(' ');
        text.push_str(&row.episode_id);
        text.push(' ');
        text.push_str(&row.subject_key);
        text.push(' ');
        text.push_str(&row.reason);
        text.push('\n');
    }
    for row in &request.proposals {
        text.push_str("proposal ");
        text.push_str(&row.proposal_id);
        text.push(' ');
        text.push_str(&row.target_fact_id);
        text.push(' ');
        match &row.operation {
            crate::types::ProposalOperation::Merge {
                duplicate_fact_id,
                canonical_fact_id,
            } => {
                text.push_str("merge ");
                text.push_str(duplicate_fact_id);
                text.push(' ');
                text.push_str(canonical_fact_id);
            }
            crate::types::ProposalOperation::Close {
                fact_id,
                replacement_fact_id,
            } => {
                text.push_str("close ");
                text.push_str(fact_id);
                text.push(' ');
                text.push_str(replacement_fact_id);
            }
        }
        text.push('\n');
    }
    for queue_id in &request.consumed_queue_ids {
        require_text("dream_queue_id", queue_id)?;
        text.push_str("consume ");
        text.push_str(queue_id);
        text.push('\n');
    }
    for hold in &request.release_holds {
        require_text("hold", &hold.id)?;
        text.push_str("release ");
        text.push_str(hold.kind.as_str());
        text.push(' ');
        text.push_str(&hold.id);
        text.push('\n');
    }
    for entity_id in &request.projection_entities {
        require_text("projection_entity", entity_id)?;
        text.push_str("projection_entity ");
        text.push_str(entity_id);
        text.push('\n');
    }
    for folder in &request.projection_folders {
        require_text("projection_folder", folder)?;
        text.push_str("projection_folder ");
        text.push_str(folder);
        text.push('\n');
    }
    Ok(text)
}

pub(crate) fn actor_parts(actor: &AuditActor) -> (&'static str, Option<&str>) {
    match actor {
        AuditActor::Owner { id } => ("owner", Some(id.as_str())),
        AuditActor::Agent { id } => ("agent", Some(id.as_str())),
        AuditActor::System => ("system", None),
    }
}

pub(crate) fn validate_audit(request: &AuditAppend) -> Result<(), StoreError> {
    require_text("event_id", &request.event_id)?;
    require_text("kind", &request.kind)?;
    require_text("payload_hash", &request.payload_hash)?;
    require_text("profile", &request.profile)?;
    if request.sequence == 0 {
        return Err(StoreError::InvalidRequest {
            message: "audit sequence starts at 1".to_owned(),
        });
    }
    require_bounded(
        "audit_canonical",
        request.canonical.len(),
        MAX_AUDIT_CANONICAL_BYTES,
    )?;
    if let Some(payload) = &request.payload {
        require_bounded("audit_payload", payload.len(), MAX_AUDIT_PAYLOAD_BYTES)?;
    }
    match &request.actor {
        AuditActor::Owner { id } | AuditActor::Agent { id } => require_text("actor_id", id)?,
        AuditActor::System => {}
    }
    Ok(())
}

pub(crate) fn validate_model(request: &EmbeddingModelWrite) -> Result<(), StoreError> {
    require_text("model_id", &request.model_id)?;
    require_text("weights_sha256", &request.weights_sha256)?;
    require_text("tokenizer_sha256", &request.tokenizer_sha256)?;
    let width = u64::try_from(EMBEDDING_DIMENSIONS).map_err(|_| StoreError::InvalidRequest {
        message: "embedding width does not fit".to_owned(),
    })?;
    if request.dimensions != width {
        return Err(StoreError::InvalidRequest {
            message: format!("v1 embeddings are {EMBEDDING_DIMENSIONS}-dimensional"),
        });
    }
    Ok(())
}
