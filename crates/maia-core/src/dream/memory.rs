//! Durable-fact filters, entity names, and episode text.
//!
//! These functions read only their arguments. They do not call a model.

use crate::brain::same_keyword_term;

/// Keep a sentence, or drop it as memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimJudgment {
    /// A durable fact about the owner or their world.
    Keep,
    /// Status text, a one-off task request, or scratch reasoning.
    Reject,
}

/// Category stored beside a kept claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactCategory {
    /// A person, including the owner.
    Person,
    /// A city, region, or other place.
    Place,
    /// A like, dislike, or habit.
    Preference,
    /// A project.
    Project,
    /// A folder, file, or URL.
    Path,
    /// A computer, phone, or other device.
    Device,
    /// A standing decision or instruction.
    Decision,
    /// A durable fact that does not fit the other categories.
    Other,
}

impl FactCategory {
    /// Stable category name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Place => "place",
            Self::Preference => "preference",
            Self::Project => "project",
            Self::Path => "path",
            Self::Device => "device",
            Self::Decision => "decision",
            Self::Other => "other",
        }
    }

    /// Edge kind from a claim to the subject entity.
    #[must_use]
    pub const fn edge_kind(self) -> &'static str {
        match self {
            Self::Place => "located_in",
            Self::Project | Self::Path => "works_on",
            Self::Device => "owns",
            Self::Person => "about",
            Self::Preference | Self::Decision | Self::Other => "mentions",
        }
    }
}

/// One named thing pulled from a sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedEntity {
    /// Display name.
    pub name: String,
    /// Entity kind.
    pub kind: &'static str,
}

/// Keeps durable facts. Status, task requests, and scratch text are rejected.
#[must_use]
pub fn judge_claim(sentence: &str) -> ClaimJudgment {
    let trimmed = strip_speaker(sentence.trim());
    if trimmed.is_empty()
        || is_status_text(trimmed)
        || is_task_request(trimmed)
        || looks_like_reasoning(trimmed)
        || is_small_line(trimmed)
    {
        ClaimJudgment::Reject
    } else {
        ClaimJudgment::Keep
    }
}

fn strip_speaker(line: &str) -> &str {
    let lower = line.to_ascii_lowercase();
    for prefix in ["owner:", "maia:", "user:", "assistant:"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let start = line.len() - rest.len();
            return line[start..].trim();
        }
    }
    line
}

/// Category for a sentence that was kept.
#[must_use]
pub fn categorize(sentence: &str) -> FactCategory {
    let folded = sentence.to_lowercase();
    if folded.contains(":\\") || folded.contains("://") || folded.contains("folder located") {
        return FactCategory::Path;
    }
    if folded.contains("lives in") || folded.contains("moved to") || folded.contains("located in") {
        return FactCategory::Place;
    }
    if folded.contains("phone")
        || folded.contains("pixel")
        || folded.contains("gamma")
        || folded.contains("laptop")
    {
        return FactCategory::Device;
    }
    if folded.contains("project") {
        return FactCategory::Project;
    }
    if folded.contains("prefer") || folded.contains("likes") || folded.contains("wants") {
        return FactCategory::Preference;
    }
    if folded.contains("always") || folded.contains("never") || folded.contains("instruction") {
        return FactCategory::Decision;
    }
    if folded.contains("name is") || folded.contains(" is named ") {
        return FactCategory::Person;
    }
    FactCategory::Other
}

/// Subject entity. "user", "owner", and "Garrett" are the same Owner.
#[must_use]
pub fn subject_name(sentence: &str) -> String {
    let folded = sentence.to_lowercase();
    if folded.contains("garrett")
        || folded.contains("the user")
        || folded.contains("the owner")
        || folded.contains("user's")
        || folded.contains("owner's")
    {
        return "Owner".to_owned();
    }
    for entity in extract_entities(sentence) {
        if entity.kind == "person" {
            return entity.name;
        }
    }
    "Owner".to_owned()
}

/// Names, paths, URLs, and known devices in one sentence.
#[must_use]
pub fn extract_entities(sentence: &str) -> Vec<NamedEntity> {
    let mut found = Vec::new();
    push_unique(&mut found, windows_paths(sentence), "path");
    push_unique(&mut found, urls(sentence), "path");
    if sentence.to_lowercase().contains("gamma") {
        push_unique(&mut found, vec!["Gamma".to_owned()], "device");
    }
    if sentence.to_lowercase().contains("pixel") {
        push_unique(&mut found, vec!["Pixel".to_owned()], "device");
    }
    if sentence.to_lowercase().contains("garrett") {
        push_unique(&mut found, vec!["Owner".to_owned()], "person");
    }
    if sentence.to_lowercase().contains("canby") {
        push_unique(&mut found, vec!["Canby".to_owned()], "place");
    }
    if sentence.to_lowercase().contains("oregon city") {
        push_unique(&mut found, vec!["Oregon City".to_owned()], "place");
    }
    for name in capitalized_names(sentence) {
        if let Some(city) = place_city(&name) {
            push_unique(&mut found, vec![city], "place");
        } else {
            push_unique(&mut found, vec![name], "person");
        }
    }
    merge_owner(&mut found);
    found
}

/// City when `name` is `City, State` or `City State`.
///
/// The second word must be a US state. `Canby`, `Canby, Oregon`, and
/// `Canby Oregon` are the same place, so this returns `Canby`.
#[must_use]
pub fn place_city(name: &str) -> Option<String> {
    let words = place_words(name);
    let [city, state] = words.as_slice() else {
        return None;
    };
    if is_us_state(state) {
        Some(city.clone())
    } else {
        None
    }
}

/// True when two sentences say the same fact.
///
/// `user`, `owner`, and `the user` are one subject. Punctuation is ignored.
/// Tokens match when they share a stem.
#[must_use]
pub fn near_duplicate(left: &str, right: &str) -> bool {
    let left_tokens = fact_tokens(left);
    let right_tokens = fact_tokens(right);
    left_tokens.len() == right_tokens.len()
        && left_tokens
            .iter()
            .zip(right_tokens.iter())
            .all(|(left_token, right_token)| same_keyword_term(left_token, right_token))
}

/// True when `newer` replaces `older` about the same subject and slot.
///
/// Place, preference, device, and decision sentences supersede when they share
/// a frame (same subject and overlapping relation words) and differ in value.
/// A neighbor fact about the same person in another category does not match.
#[must_use]
pub fn supersedes(older: &str, newer: &str) -> bool {
    if near_duplicate(older, newer) {
        return false;
    }
    let category = categorize(older);
    if category != categorize(newer) || subject_name(older) != subject_name(newer) {
        return false;
    }
    match category {
        FactCategory::Place
        | FactCategory::Preference
        | FactCategory::Device
        | FactCategory::Decision => same_update_frame(older, newer),
        FactCategory::Person
        | FactCategory::Project
        | FactCategory::Path
        | FactCategory::Other => false,
    }
}

/// Shared relation words with at least one differing value token on each side.
fn same_update_frame(older: &str, newer: &str) -> bool {
    let older_tokens = fact_tokens(older);
    let newer_tokens = fact_tokens(newer);
    if older_tokens.is_empty() || newer_tokens.is_empty() {
        return false;
    }
    let shared = older_tokens
        .iter()
        .filter(|token| newer_tokens.iter().any(|other| other == *token))
        .count();
    let older_only = older_tokens
        .iter()
        .filter(|token| newer_tokens.iter().all(|other| other != *token))
        .count();
    let newer_only = newer_tokens
        .iter()
        .filter(|token| older_tokens.iter().all(|other| other != *token))
        .count();
    shared > 0 && older_only > 0 && newer_only > 0
}

/// Final visible reply. Scratch paragraphs are dropped. Empty when nothing remains.
#[must_use]
pub fn owner_visible_reply(reply: &str) -> String {
    let paragraphs: Vec<&str> = reply
        .split("\n\n")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let source: Vec<&str> = if paragraphs.is_empty() {
        vec![reply.trim()]
    } else {
        paragraphs
    };
    let mut kept = Vec::new();
    for paragraph in source {
        if let Some(text) = recover_paragraph(paragraph) {
            kept.push(text);
        }
    }
    kept.last().cloned().unwrap_or_default()
}

/// Episode body and a hide reason. `None` means the episode stays visible.
#[must_use]
pub fn episode_record(owner: &str, reply: &str) -> (String, Option<&'static str>) {
    let visible = owner_visible_reply(reply);
    let status = is_status_text(&visible) || is_status_text(reply);
    let owner_fact = judge_claim(owner) == ClaimJudgment::Keep && !is_small_line(owner);
    if status && owner_fact {
        return (format!("Owner: {owner}"), None);
    }
    if status {
        return (format!("Owner: {owner}\nMaia: {visible}"), Some("status"));
    }
    if looks_like_reasoning(reply) && visible.is_empty() {
        return (format!("Owner: {owner}"), Some("reasoning"));
    }
    if is_small_line(owner) && (visible.is_empty() || is_small_line(&visible)) {
        return (format!("Owner: {owner}\nMaia: {visible}"), Some("chitchat"));
    }
    let shown = if visible.is_empty() {
        reply.trim()
    } else {
        visible.as_str()
    };
    (format!("Owner: {owner}\nMaia: {shown}"), None)
}

/// Status lines the router uses for dispatch, and similar chatter.
#[must_use]
pub fn is_status_text(text: &str) -> bool {
    let folded = text.to_lowercase();
    folded.contains("handed this message")
        || folded.contains("dispatched as one new task")
        || folded.contains("handed off")
        || folded.contains("started a fresh task")
        || folded.contains("the message was accepted")
}

/// Scratch text from a model, not a reply the owner should remember.
#[must_use]
pub fn looks_like_reasoning(text: &str) -> bool {
    let folded = text.to_lowercase();
    folded.contains("hmm")
        || folded.contains("candidate list")
        || folded.contains("looking at the candidate")
        || folded.contains("let me think")
        || folded.contains("wait —")
        || folded.contains("wait -")
}

fn is_task_request(text: &str) -> bool {
    let folded = text.to_lowercase();
    let asks = folded.contains("investigat")
        || folded.contains("look into")
        || folded.contains("looked into")
        || folded.contains("fix this")
        || folded.contains("wants the chat")
        || folded.contains("wants the task");
    asks && (folded.contains("owner wants")
        || folded.contains("user wants")
        || folded.contains("maia asked"))
}

fn is_small_line(text: &str) -> bool {
    let compact: String = text
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || ch.is_whitespace())
        .flat_map(|ch| ch.to_lowercase())
        .collect();
    let compact = compact.split_whitespace().collect::<Vec<_>>().join(" ");
    matches!(
        compact.as_str(),
        "hi" | "hello" | "hey" | "thanks" | "thank you" | "ok" | "okay" | "yes" | "no" | "bye"
    )
}

fn recover_paragraph(paragraph: &str) -> Option<String> {
    if !looks_like_reasoning(paragraph) && !is_status_text(paragraph) {
        let trimmed = paragraph.trim();
        return if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        };
    }
    let sentences = split_sentences(paragraph);
    let clean: Vec<&str> = sentences
        .iter()
        .copied()
        .filter(|sentence| !looks_like_reasoning(sentence) && !is_status_text(sentence))
        .collect();
    if clean.is_empty() {
        None
    } else {
        Some(clean.join(" "))
    }
}

fn split_sentences(text: &str) -> Vec<&str> {
    text.split(". ")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

fn fact_tokens(text: &str) -> Vec<String> {
    let mut raw = Vec::new();
    let mut word = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            word.push(ch.to_ascii_lowercase());
        } else if !word.is_empty() {
            raw.push(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        raw.push(word);
    }
    let mapped: Vec<String> = raw
        .into_iter()
        .map(|token| match token.as_str() {
            "user" | "users" | "owner" | "owners" => "owner".to_owned(),
            other => other.to_owned(),
        })
        .collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < mapped.len() {
        if mapped[index] == "the" && mapped.get(index + 1).is_some_and(|next| next == "owner") {
            index += 1;
            continue;
        }
        if mapped[index] == "s" && tokens.last().is_some_and(|previous| previous == "owner") {
            index += 1;
            continue;
        }
        tokens.push(mapped[index].clone());
        index += 1;
    }
    tokens
}

fn place_words(name: &str) -> Vec<String> {
    name.split(|ch: char| ch.is_whitespace() || ch == ',')
        .map(|word| {
            word.trim_matches(|ch: char| !ch.is_ascii_alphabetic())
                .to_owned()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

fn is_us_state(word: &str) -> bool {
    let folded = word.to_ascii_lowercase();
    US_STATES.binary_search(&folded.as_str()).is_ok()
}

const US_STATES: &[&str] = &[
    "alabama",
    "alaska",
    "arizona",
    "arkansas",
    "california",
    "colorado",
    "connecticut",
    "delaware",
    "florida",
    "georgia",
    "hawaii",
    "idaho",
    "illinois",
    "indiana",
    "iowa",
    "kansas",
    "kentucky",
    "louisiana",
    "maine",
    "maryland",
    "massachusetts",
    "michigan",
    "minnesota",
    "mississippi",
    "missouri",
    "montana",
    "nebraska",
    "nevada",
    "ohio",
    "oklahoma",
    "oregon",
    "pennsylvania",
    "tennessee",
    "texas",
    "utah",
    "vermont",
    "virginia",
    "washington",
    "wisconsin",
    "wyoming",
];

fn windows_paths(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index + 2 < chars.len() {
        let letter = chars[index];
        if letter.is_ascii_alphabetic() && chars[index + 1] == ':' && chars[index + 2] == '\\' {
            let start = index;
            index += 3;
            while index < chars.len() && !chars[index].is_whitespace() {
                index += 1;
            }
            let path: String = chars[start..index].iter().collect();
            let path = path
                .trim_end_matches(|ch: char| matches!(ch, '.' | ',' | ';' | ')' | ']'))
                .to_owned();
            if !path.is_empty() {
                paths.push(path);
            }
            continue;
        }
        index += 1;
    }
    paths
}

fn urls(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for token in text.split_whitespace() {
        let token = token.trim_matches(|ch: char| matches!(ch, '(' | ')' | ',' | '.' | ';'));
        if token.starts_with("https://") || token.starts_with("http://") {
            found.push(token.to_owned());
        }
    }
    found
}

fn capitalized_names(text: &str) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut names = Vec::new();
    let mut index = 0;
    while index < words.len() {
        let word = trim_word(words[index]);
        if is_capital_word(word) && !is_sentence_start(index, words.as_slice()) {
            let mut name = word.to_owned();
            let mut next = index + 1;
            while next < words.len() {
                let part = trim_word(words[next]);
                if !is_capital_word(part) {
                    break;
                }
                name.push(' ');
                name.push_str(part);
                next += 1;
            }
            if name.split_whitespace().count() >= 2 {
                names.push(name);
            }
            index = next;
            continue;
        }
        index += 1;
    }
    names
}

fn is_sentence_start(index: usize, words: &[&str]) -> bool {
    if index == 0 {
        return true;
    }
    words[index - 1].ends_with('.')
        || words[index - 1].ends_with('!')
        || words[index - 1].ends_with('?')
}

fn is_capital_word(word: &str) -> bool {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) if first.is_uppercase() => chars.all(|ch| ch.is_alphabetic() || ch == '\''),
        _ => false,
    }
}

fn trim_word(word: &str) -> &str {
    word.trim_matches(|ch: char| matches!(ch, ',' | '.' | ';' | ':' | '(' | ')' | '"' | '\''))
}

fn push_unique(found: &mut Vec<NamedEntity>, names: Vec<String>, kind: &'static str) {
    for name in names {
        if name.is_empty()
            || found
                .iter()
                .any(|item| item.name.eq_ignore_ascii_case(&name))
        {
            continue;
        }
        found.push(NamedEntity { name, kind });
    }
}

fn merge_owner(found: &mut Vec<NamedEntity>) {
    let owner = found.iter().any(|item| {
        let folded = item.name.to_lowercase();
        folded == "owner" || folded == "user" || folded == "garrett"
    });
    if !owner {
        return;
    }
    found.retain(|item| {
        let folded = item.name.to_lowercase();
        folded != "user" && folded != "garrett"
    });
    if !found.iter().any(|item| item.name == "Owner") {
        found.insert(
            0,
            NamedEntity {
                name: "Owner".to_owned(),
                kind: "person",
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::US_STATES;

    #[test]
    fn us_states_stay_sorted_for_lookup() {
        assert!(US_STATES.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(US_STATES.contains(&"oregon"));
        assert!(US_STATES.contains(&"texas"));
    }
}
