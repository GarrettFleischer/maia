//! Configured lexical normalization and seeding.

use std::collections::{BTreeMap, BTreeSet};

use crate::brain::ids::LexemeId;

/// Stopword set, recorded fan-out, and high-fan cutoff supplied to ranking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexicalPolicy {
    /// Normalized terms that never become lexeme nodes.
    pub stopwords: BTreeSet<String>,
    /// Recorded fan-out counts for known terms.
    pub fan_out: BTreeMap<String, u32>,
    /// Terms whose recorded fan-out is at least this cutoff are excluded.
    pub high_fan_cutoff: u32,
}

/// Returns first-seen normalized lexemes, excluding stopwords and high-fan terms.
#[must_use]
pub fn lexemes_for_sentence(sentence: &str, policy: &LexicalPolicy) -> Vec<LexemeId> {
    let mut lexemes = Vec::new();
    let mut seen = BTreeSet::new();
    for token in tokenize(sentence) {
        let normalized = normalize_lexeme(&token);
        if normalized.len() < 2 {
            continue;
        }
        if policy.stopwords.contains(&normalized) || FUNCTION_WORDS.contains(&normalized.as_str()) {
            continue;
        }
        if policy
            .fan_out
            .get(&normalized)
            .is_some_and(|fan| *fan >= policy.high_fan_cutoff)
        {
            continue;
        }
        if seen.insert(normalized.clone()) {
            lexemes.push(LexemeId::new(normalized));
        }
    }
    lexemes
}

const FUNCTION_WORDS: &[&str] = &[
    "about", "also", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could", "did",
    "do", "does", "for", "from", "had", "has", "have", "he", "her", "here", "his", "how", "i",
    "if", "in", "into", "is", "it", "its", "just", "me", "my", "not", "of", "on", "or", "our",
    "rather", "she", "so", "than", "that", "the", "their", "them", "then", "there", "they",
    "this", "to", "too", "was", "wants", "we", "were", "what", "when", "where", "which", "who",
    "will", "with", "you", "your",
];

fn tokenize(sentence: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in sentence.chars() {
        if ch.is_alphanumeric() || ch == '\'' || ch == '\u{2019}' {
            current.push(ch);
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn normalize_lexeme(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let stripped = lower
        .strip_suffix("'s")
        .or_else(|| lower.strip_suffix("\u{2019}s"))
        .unwrap_or(lower.as_str());
    stripped.chars().filter(|ch| ch.is_alphanumeric()).collect()
}
