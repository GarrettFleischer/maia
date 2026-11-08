//! Request-bounded use attribution.

use std::collections::BTreeSet;

use crate::agents::PresentationId;
use crate::brain::MemoryRef;
use crate::credit::co_use::co_use_updates;
use crate::credit::types::{
    Acceptance, Attributability, AttributedPresentation, AttributionError, AttributionLedger,
    AttributionScope, CandidateRef, HeatUpdate, InspectableMatch, LedgerId, MatchStatus,
    Presentation, ReasoningAvailability, RejectionReason, ReversalStatus, ScopedSlot, TextSpan,
    UseSource,
};

/// Attributes observable uses inside one request scope.
pub fn attribute_uses(scope: &AttributionScope) -> Result<AttributionLedger, AttributionError> {
    validate_scope(scope)?;
    let attributability = match scope.reasoning {
        ReasoningAvailability::Unknown => Attributability::Unattributable,
        ReasoningAvailability::Available { .. }
        | ReasoningAvailability::Missing
        | ReasoningAvailability::Blank => Attributability::Attributable,
    };
    let reply_credit = match scope.reasoning {
        ReasoningAvailability::Missing | ReasoningAvailability::Blank => ReplyCredit::Allowed,
        ReasoningAvailability::Available { .. } | ReasoningAvailability::Unknown => {
            ReplyCredit::Forbidden
        }
    };
    let reasoning_text = match &scope.reasoning {
        ReasoningAvailability::Available { text } if !text.is_empty() => Some(text.as_str()),
        _ => None,
    };

    let ledger_id = derive_ledger_id(scope);
    let mut collected = CollectedUses {
        next_presentation: 0,
        matches: Vec::new(),
        presentations: Vec::new(),
        heat: Vec::new(),
    };

    for slot in &scope.slots {
        let candidate = CandidateRef::Slot {
            slot_id: slot.id.clone(),
            ordinal: slot.ordinal,
            memory: slot.memory.clone(),
        };
        if let Some(matched) = align_candidate(
            &slot.canonical_text,
            candidate,
            reasoning_text,
            scope,
            reply_credit,
        ) {
            record_match(scope, ledger_id, matched, Some(slot), &mut collected);
        }
    }
    for item in &scope.recall {
        let candidate = CandidateRef::Recall {
            item: item.item.clone(),
        };
        if let Some(matched) = align_candidate(
            &item.canonical_text,
            candidate,
            reasoning_text,
            scope,
            reply_credit,
        ) {
            record_match(scope, ledger_id, matched, None, &mut collected);
        }
    }

    let co_use = co_use_updates(&presentations_for_co_use(&collected.presentations));
    Ok(AttributionLedger {
        id: ledger_id,
        thread_id: scope.thread_id,
        request_id: scope.request_id,
        compiled_prefix_hash: scope.compiled_prefix_hash.clone(),
        matches: collected.matches,
        presentations: collected.presentations.clone(),
        heat: collected.heat,
        brain_presentations: collected.presentations,
        co_use,
        attributability,
        reversal: ReversalStatus::NotReversed,
    })
}

fn validate_scope(scope: &AttributionScope) -> Result<(), AttributionError> {
    if scope.compiled_prefix_hash.is_empty() {
        return Err(AttributionError::MissingCompiledHash);
    }
    let mut ids = BTreeSet::new();
    let mut ordinals = BTreeSet::new();
    for slot in &scope.slots {
        if !ids.insert(&slot.id) {
            return Err(AttributionError::DuplicateSlotId);
        }
        if !ordinals.insert(slot.ordinal) {
            return Err(AttributionError::DuplicateOrdinal);
        }
    }
    Ok(())
}

fn derive_ledger_id(scope: &AttributionScope) -> LedgerId {
    let mut mixed =
        scope.thread_id.0.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ scope.request_id.0.rotate_left(13);
    for (index, byte) in scope.compiled_prefix_hash.as_str().bytes().enumerate() {
        mixed = mixed
            .wrapping_mul(1_677_619)
            .wrapping_add(u64::from(byte))
            .wrapping_add(index as u64);
    }
    LedgerId(mixed)
}

struct AlignedMatch {
    candidate: CandidateRef,
    source: UseSource,
    weight: f64,
    source_span: TextSpan,
    evidence_span: TextSpan,
    status: MatchStatus,
}

fn align_candidate(
    canonical_text: &str,
    candidate: CandidateRef,
    reasoning_text: Option<&str>,
    scope: &AttributionScope,
    reply_credit: ReplyCredit,
) -> Option<AlignedMatch> {
    if let Some(text) = reasoning_text {
        if let Some(aligned) = align_in(
            canonical_text,
            text,
            UseSource::Reasoning,
            1.0,
            candidate.clone(),
        ) {
            return Some(aligned);
        }
    }
    for tool in &scope.tools {
        if let Some(aligned) = align_in(
            canonical_text,
            &tool.arguments,
            UseSource::Tool,
            1.0,
            candidate.clone(),
        ) {
            return Some(aligned);
        }
    }
    if let ReplyCredit::Allowed = reply_credit {
        if let Some(aligned) = align_in(
            canonical_text,
            &scope.reply,
            UseSource::Reply,
            0.5,
            candidate.clone(),
        ) {
            return Some(aligned);
        }
    }
    for tool in &scope.tools {
        if let Some(span) = find_span(tool.results.as_str(), canonical_text) {
            return Some(AlignedMatch {
                candidate,
                source: UseSource::Tool,
                weight: 0.0,
                source_span: TextSpan {
                    start: 0,
                    end: canonical_text.len(),
                },
                evidence_span: span,
                status: MatchStatus::Rejected {
                    reason: RejectionReason::ToolResultOnly,
                },
            });
        }
    }
    None
}

#[derive(Clone, Copy)]
enum ReplyCredit {
    Allowed,
    Forbidden,
}

fn align_in(
    canonical_text: &str,
    evidence: &str,
    source: UseSource,
    weight: f64,
    candidate: CandidateRef,
) -> Option<AlignedMatch> {
    let evidence_span = find_span(evidence, canonical_text)?;
    let source_span = TextSpan {
        start: 0,
        end: canonical_text.len(),
    };
    let sentence = sentence_around(evidence, evidence_span);
    if sentence_rejects(sentence) {
        return Some(AlignedMatch {
            candidate,
            source,
            weight: 0.0,
            source_span,
            evidence_span,
            status: MatchStatus::Rejected {
                reason: RejectionReason::FactRejected,
            },
        });
    }
    Some(AlignedMatch {
        candidate,
        source,
        weight,
        source_span,
        evidence_span,
        status: MatchStatus::Accepted,
    })
}

fn find_span(haystack: &str, needle: &str) -> Option<TextSpan> {
    if needle.is_empty() {
        return None;
    }
    let start = haystack.find(needle)?;
    Some(TextSpan {
        start,
        end: start + needle.len(),
    })
}

fn sentence_around(text: &str, span: TextSpan) -> &str {
    let start = text[..span.start]
        .rfind(['.', '!', '?'])
        .map(|index| index + 1)
        .unwrap_or(0);
    let end = text[span.end..]
        .find(['.', '!', '?'])
        .map(|index| span.end + index + 1)
        .unwrap_or(text.len());
    text[start..end].trim()
}

fn sentence_rejects(sentence: &str) -> bool {
    let lower = sentence.to_ascii_lowercase();
    lower.contains("is incorrect")
        || lower.contains("is wrong")
        || lower.contains("is false")
        || lower.contains("is not true")
        || lower.contains("rejected")
}

struct CollectedUses {
    next_presentation: u64,
    matches: Vec<InspectableMatch>,
    presentations: Vec<AttributedPresentation>,
    heat: Vec<HeatUpdate>,
}

fn record_match(
    scope: &AttributionScope,
    ledger_id: LedgerId,
    aligned: AlignedMatch,
    slot: Option<&ScopedSlot>,
    collected: &mut CollectedUses,
) {
    collected.matches.push(InspectableMatch {
        candidate: aligned.candidate.clone(),
        source: aligned.source,
        weight: aligned.weight,
        source_span: aligned.source_span,
        evidence_span: aligned.evidence_span,
        status: aligned.status,
    });
    if aligned.status != MatchStatus::Accepted || aligned.weight <= 0.0 {
        return;
    }
    collected.next_presentation += 1;
    let presentation = AttributedPresentation {
        id: PresentationId(ledger_id.0.wrapping_add(collected.next_presentation)),
        candidate: aligned.candidate,
        source: aligned.source,
        weight: aligned.weight,
        source_span: aligned.source_span,
        evidence_span: aligned.evidence_span,
        thread_id: scope.thread_id,
    };
    if let Some(slot) = slot {
        collected.heat.push(HeatUpdate {
            slot_id: slot.id.clone(),
            weight: aligned.weight,
        });
    }
    collected.presentations.push(presentation);
}

fn presentations_for_co_use(presentations: &[AttributedPresentation]) -> Vec<Presentation> {
    let mut out = Vec::new();
    for presentation in presentations {
        if let Some(memory) = candidate_memory(&presentation.candidate) {
            out.push(Presentation {
                id: presentation.id,
                memory,
                source: presentation.source,
                weight: presentation.weight,
                acceptance: Acceptance::Accepted,
            });
        }
    }
    out
}

pub(crate) fn candidate_memory(candidate: &CandidateRef) -> Option<MemoryRef> {
    match candidate {
        CandidateRef::Slot { memory, .. } => memory.clone(),
        CandidateRef::Recall { item } => Some(item_memory(item)),
    }
}

fn item_memory(item: &crate::brain::RecallItem) -> MemoryRef {
    match item {
        crate::brain::RecallItem::Claim { claim_id } => MemoryRef::Claim(claim_id.clone()),
        crate::brain::RecallItem::Fact { fact_id } => MemoryRef::Fact(fact_id.clone()),
    }
}
