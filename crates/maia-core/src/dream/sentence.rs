//! Declarative-sentence contract shared by promotion and consolidation.

use crate::dream::error::SentenceIssue;

/// Validates one model-authored sentence. Policy and clock are not consulted.
pub(crate) fn validate_sentence(sentence: &str) -> Result<(), SentenceIssue> {
    let trimmed = sentence.trim();
    if trimmed.is_empty() {
        return Err(SentenceIssue::Empty);
    }
    if list_marker(trimmed) {
        return Err(SentenceIssue::ListMarker);
    }
    if frontmatter(trimmed) {
        return Err(SentenceIssue::Frontmatter);
    }
    if contains_stable_id(trimmed) {
        return Err(SentenceIssue::StableId);
    }
    if !is_one_declarative_sentence(trimmed) {
        return sentence_shape_error(trimmed);
    }
    Ok(())
}

fn list_marker(sentence: &str) -> bool {
    sentence.starts_with("- ")
        || sentence.starts_with("* ")
        || sentence.starts_with("+ ")
        || numbered_marker(sentence)
}

fn numbered_marker(sentence: &str) -> bool {
    let mut chars = sentence.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_digit() {
        return false;
    }
    for ch in chars {
        if ch.is_ascii_digit() {
            continue;
        }
        return ch == '.' && sentence.contains(". ");
    }
    false
}

fn frontmatter(sentence: &str) -> bool {
    sentence.contains("---")
        || sentence.contains('\n')
        || sentence.contains('\r')
        || sentence.starts_with("id:")
        || sentence.starts_with("description:")
        || sentence.starts_with("see:")
        || sentence.starts_with("kind:")
}

fn contains_stable_id(sentence: &str) -> bool {
    const PREFIXES: [&str; 5] = ["claim_", "fact_", "episode_", "entity_", "agent_"];
    PREFIXES
        .iter()
        .any(|prefix| prefixed_token(sentence, prefix))
}

fn prefixed_token(sentence: &str, prefix: &str) -> bool {
    let mut rest = sentence;
    while let Some(index) = rest.find(prefix) {
        let after = &rest[index + prefix.len()..];
        if after
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric())
        {
            return true;
        }
        rest = after;
    }
    false
}

fn is_one_declarative_sentence(sentence: &str) -> bool {
    sentence.ends_with('.')
        && sentence.chars().filter(|ch| *ch == '.').count() == 1
        && !sentence.contains(['!', '?'])
}

fn sentence_shape_error(sentence: &str) -> Result<(), SentenceIssue> {
    let terminators = sentence
        .chars()
        .filter(|ch| matches!(ch, '.' | '!' | '?'))
        .count();
    if terminators > 1 {
        Err(SentenceIssue::MultipleSentences)
    } else {
        Err(SentenceIssue::NotDeclarative)
    }
}
