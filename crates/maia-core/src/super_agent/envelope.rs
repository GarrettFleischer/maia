//! Task envelope seal admission and recall query construction.

use std::collections::BTreeMap;

use super::types::{
    AdvisoryBrief, BindingText, CriterionSource, DecisionId, EnvelopeDraft, ResolvedQuestion,
    RuleId, SealError, TaskEnvelope, UserPromptBytes,
};

/// Validates draft prompt metadata against the admitted user message.
fn prompt_matches_draft(draft: &EnvelopeDraft, user_message: &UserPromptBytes) -> bool {
    draft.original_prompt.message == user_message.message
        && draft.original_prompt.utf8 == user_message.utf8
}

/// Returns whether the cited span equals the expected text bytes.
fn user_text_matches(
    user_message: &UserPromptBytes,
    message: &super::types::MessageId,
    start: u32,
    end: u32,
    text_bytes: &[u8],
) -> Result<(), SealError> {
    if message != &user_message.message {
        return Err(SealError::SpanMismatch);
    }
    let start = usize::try_from(start).map_err(|_| SealError::SpanMismatch)?;
    let end = usize::try_from(end).map_err(|_| SealError::SpanMismatch)?;
    if start > end || end > user_message.utf8.len() {
        return Err(SealError::SpanMismatch);
    }
    let slice = user_message
        .utf8
        .get(start..end)
        .ok_or(SealError::SpanMismatch)?;
    if slice != text_bytes {
        return Err(SealError::SpanMismatch);
    }
    Ok(())
}

/// Checks one binding source against maps and expected text bytes.
fn validate_source(
    source: &CriterionSource,
    text: &str,
    user_message: &UserPromptBytes,
    rules: &BTreeMap<RuleId, BindingText>,
    decisions: &BTreeMap<DecisionId, BindingText>,
) -> Result<(), SealError> {
    let text_bytes = text.as_bytes();
    match source {
        CriterionSource::UserText {
            message,
            start,
            end,
        } => {
            user_text_matches(user_message, message, *start, *end, text_bytes)?;
        }
        CriterionSource::BindingRule { rule } => {
            let binding = rules.get(rule).ok_or(SealError::MissingRule)?;
            if binding.0.as_bytes() != text_bytes {
                return Err(SealError::SourceTextMismatch);
            }
        }
        CriterionSource::AcceptedDecision { decision } => {
            let binding = decisions.get(decision).ok_or(SealError::MissingDecision)?;
            if binding.0.as_bytes() != text_bytes {
                return Err(SealError::SourceTextMismatch);
            }
        }
    }
    Ok(())
}

/// Validates criterion and constraint sources on the draft.
fn validate_sourced_items(
    draft: &EnvelopeDraft,
    user_message: &UserPromptBytes,
    rules: &BTreeMap<RuleId, BindingText>,
    decisions: &BTreeMap<DecisionId, BindingText>,
) -> Result<(), SealError> {
    for criterion in &draft.criteria {
        validate_source(
            &criterion.source,
            &criterion.text,
            user_message,
            rules,
            decisions,
        )?;
    }
    for constraint in &draft.constraints {
        validate_source(
            &constraint.source,
            &constraint.text,
            user_message,
            rules,
            decisions,
        )?;
    }
    Ok(())
}

/// Ensures every resolved question cites a stored decision.
fn validate_question_log(
    question_log: &[ResolvedQuestion],
    decisions: &BTreeMap<DecisionId, BindingText>,
) -> Result<(), SealError> {
    for entry in question_log {
        if !decisions.contains_key(&entry.decision) {
            return Err(SealError::MissingDecision);
        }
    }
    Ok(())
}

/// Seals a draft envelope after structural and binding checks pass.
pub fn seal_envelope(
    draft: &EnvelopeDraft,
    user_message: &UserPromptBytes,
    rules: &BTreeMap<RuleId, BindingText>,
    decisions: &BTreeMap<DecisionId, BindingText>,
) -> Result<TaskEnvelope, SealError> {
    if !prompt_matches_draft(draft, user_message) {
        return Err(SealError::PromptMismatch);
    }
    if draft.open_question_count > 0 {
        return Err(SealError::UnresolvedQuestion);
    }
    validate_sourced_items(draft, user_message, rules, decisions)?;
    validate_question_log(&draft.question_log, decisions)?;

    Ok(TaskEnvelope {
        id: draft.id.clone(),
        task: draft.task.clone(),
        origin_attempt: draft.origin_attempt.clone(),
        original_prompt: UserPromptBytes {
            message: user_message.message.clone(),
            utf8: user_message.utf8.clone(),
        },
        brief: draft.brief.clone(),
        criteria: draft.criteria.clone(),
        constraints: draft.constraints.clone(),
        context: draft.context.clone(),
        routing_reason: draft.routing_reason.clone(),
        assumptions: draft.assumptions.clone(),
        question_log: draft.question_log.clone(),
    })
}

/// Builds the retrieval query string from prompt bytes and advisory brief label.
pub fn recall_query_text(
    prompt: &UserPromptBytes,
    brief: &AdvisoryBrief,
) -> Result<String, SealError> {
    let decoded = std::str::from_utf8(&prompt.utf8).map_err(|_| SealError::PromptNotUtf8)?;
    Ok(format!("{decoded}\n{}", brief.0))
}
