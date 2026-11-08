//! Next-message correction marks.

use crate::audit::Timestamp;
use crate::credit::attribute::candidate_memory;
use crate::credit::types::{
    AppliedLedger, AttributionError, CanonicalMessage, CorrectionEvidence, CorrectionHold,
    DreamQueueId, NegativeMark, TextSpan,
};

/// Marks facts presented by the immediately preceding turn in the same thread.
pub fn correction_mark(
    prior: &AppliedLedger,
    next_message: &CanonicalMessage,
    evidence: &[CorrectionEvidence],
    now: Timestamp,
) -> Result<Vec<NegativeMark>, AttributionError> {
    for item in evidence {
        if !span_in(&next_message.text, item.span) {
            return Err(AttributionError::InvalidSpan);
        }
    }
    if next_message.thread_id != prior.thread_id || next_message.prior_request != prior.request_id {
        return Ok(Vec::new());
    }
    let mut marks = Vec::new();
    for item in evidence {
        let Some(presentation) = prior.presentations.iter().find(|presentation| {
            candidate_memory(&presentation.candidate).as_ref() == Some(&item.target)
                && presentation.weight > 0.0
        }) else {
            continue;
        };
        marks.push(NegativeMark {
            target: item.target.clone(),
            presentation_id: presentation.id,
            thread_id: next_message.thread_id,
            message_id: next_message.message_id,
            evidence_span: item.span,
            at: now,
            hold: CorrectionHold { since: now },
            dream_queue: DreamQueueId(presentation.id.0 ^ now.0 as u64),
        });
    }
    Ok(marks)
}

fn span_in(text: &str, span: TextSpan) -> bool {
    span.start < span.end
        && span.end <= text.len()
        && text.is_char_boundary(span.start)
        && text.is_char_boundary(span.end)
}
