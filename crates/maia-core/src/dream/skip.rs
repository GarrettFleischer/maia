//! Code-side promotion skip rule. No model is consulted.

/// Why promotion should not call a model for an episode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromotionSkipReason {
    /// Empty or whitespace-only exchange.
    Empty,
    /// Pure tool-noise with no owner prose.
    ToolNoise,
    /// Pure small talk with no durable fact.
    SmallTalk,
    /// Router status with no durable fact.
    Status,
    /// Scratch reasoning with no recoverable reply.
    Reasoning,
}

/// Returns a skip reason when the episode should not be sent to the promoter.
#[must_use]
pub fn should_skip_promotion(body: &str) -> Option<PromotionSkipReason> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Some(PromotionSkipReason::Empty);
    }
    if is_tool_noise(trimmed) {
        return Some(PromotionSkipReason::ToolNoise);
    }
    if is_small_talk(trimmed) {
        return Some(PromotionSkipReason::SmallTalk);
    }
    if crate::dream::memory::is_status_text(trimmed)
        && !trimmed.lines().any(|line| {
            crate::dream::memory::judge_claim(line) == crate::dream::memory::ClaimJudgment::Keep
                && !crate::dream::memory::is_status_text(line)
        })
    {
        return Some(PromotionSkipReason::Status);
    }
    if crate::dream::memory::looks_like_reasoning(trimmed)
        && crate::dream::memory::owner_visible_reply(trimmed).is_empty()
    {
        return Some(PromotionSkipReason::Reasoning);
    }
    None
}

fn is_tool_noise(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    let lines: Vec<&str> = lower
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return true;
    }
    lines.iter().all(|line| {
        line.starts_with("tool:")
            || line.starts_with("tool_call")
            || line.starts_with("function_call")
            || line.starts_with('{') && line.contains("\"name\"")
            || *line == "{}"
            || *line == "[]"
    })
}

fn is_small_talk(body: &str) -> bool {
    let lines: Vec<&str> = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return true;
    }
    lines.iter().all(|line| is_phrase(strip_speaker(line)))
}

fn strip_speaker(line: &str) -> &str {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    for prefix in ["owner:", "maia:", "user:", "assistant:"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let start = trimmed.len() - rest.len();
            return trimmed[start..].trim();
        }
    }
    trimmed
}

fn is_phrase(text: &str) -> bool {
    let compact: String = text
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect();
    let words: Vec<&str> = compact.split_whitespace().collect();
    if words.is_empty() || words.len() > 6 {
        return false;
    }
    const PHRASES: &[&[&str]] = &[
        &["hi"],
        &["hello"],
        &["hey"],
        &["thanks"],
        &["thank", "you"],
        &["ok"],
        &["okay"],
        &["bye"],
        &["good", "morning"],
        &["good", "night"],
        &["how", "are", "you"],
        &["whats", "up"],
        &["what", "s", "up"],
    ];
    PHRASES.contains(&words.as_slice())
}
