//! Deterministic links from neuron text. No model calls.

use crate::security::Taint;

/// Title mentions shorter than this are ignored.
pub const MENTION_MIN_CHARS: usize = 4;

/// Stored on every edge this extractor creates.
pub const AUTO_LINK_SOURCE: &str = "auto-link";

/// A neuron the extractor may resolve a reference to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownNeuron {
    /// `claim`, `fact`, or `episode`.
    pub kind: String,
    /// Stable id.
    pub id: String,
    /// Display title.
    pub title: String,
    /// Extra names, including `type/slug` aliases.
    pub aliases: Vec<String>,
    /// File slug such as `claim/alice--claim-1`.
    pub slug: String,
}

/// Where a match points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    /// An existing neuron.
    Resolved {
        /// Target kind.
        kind: String,
        /// Target id.
        id: String,
    },
    /// Provenance kept until a neuron with this reference appears.
    Pending {
        /// Raw reference text.
        reference: String,
    },
}

/// One link found in source text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedLink {
    /// `wikilink`, `mention`, or `reference`.
    pub edge_type: &'static str,
    /// Resolved neuron or a pending reference.
    pub target: LinkTarget,
    /// Byte offset in the source text.
    pub span_start: usize,
    /// Byte offset past the match.
    pub span_end: usize,
    /// Copied from the source neuron. Never raised.
    pub taint: Taint,
    /// Always [`AUTO_LINK_SOURCE`].
    pub source_tag: &'static str,
}

/// Extracts typed links. Longest non-overlapping match wins.
#[must_use]
pub fn extract_links(text: &str, known: &[KnownNeuron], source: &KnownNeuron, taint: Taint) -> Vec<ExtractedLink> {
    let mut found = Vec::new();
    found.extend(wikilinks(text, known, source, taint));
    found.extend(mentions(text, known, source, taint));
    found.extend(references(text, known, source, taint));
    keep_longest(found)
}

fn wikilinks(text: &str, known: &[KnownNeuron], source: &KnownNeuron, taint: Taint) -> Vec<ExtractedLink> {
    let mut links = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index + 4 <= bytes.len() {
        if bytes[index] == b'[' && bytes[index + 1] == b'[' {
            if let Some(end) = find_close(bytes, index + 2) {
                let inner = &text[index + 2..end];
                let target = wiki_target(inner);
                if !target.is_empty() {
                    if let Some(link) = link_for(
                        "wikilink",
                        &target,
                        index,
                        end + 2,
                        known,
                        source,
                        taint,
                        true,
                    ) {
                        links.push(link);
                    }
                }
                index = end + 2;
                continue;
            }
        }
        index += 1;
    }
    links
}

fn find_close(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start;
    while index + 1 < bytes.len() {
        if bytes[index] == b']' && bytes[index + 1] == b']' {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn wiki_target(inner: &str) -> String {
    let before_label = inner.split('|').next().unwrap_or(inner);
    let before_anchor = before_label.split('#').next().unwrap_or(before_label);
    before_anchor.trim().to_owned()
}

fn mentions(text: &str, known: &[KnownNeuron], source: &KnownNeuron, taint: Taint) -> Vec<ExtractedLink> {
    let mut links = Vec::new();
    for neuron in known {
        if same_neuron(neuron, source) {
            continue;
        }
        if neuron.title.chars().count() < MENTION_MIN_CHARS {
            continue;
        }
        for (start, end) in phrase_spans(text, &neuron.title) {
            links.push(ExtractedLink {
                edge_type: "mention",
                target: LinkTarget::Resolved {
                    kind: neuron.kind.clone(),
                    id: neuron.id.clone(),
                },
                span_start: start,
                span_end: end,
                taint,
                source_tag: AUTO_LINK_SOURCE,
            });
        }
    }
    links
}

fn references(text: &str, known: &[KnownNeuron], source: &KnownNeuron, taint: Taint) -> Vec<ExtractedLink> {
    let mut links = Vec::new();
    for (start, end, raw) in path_and_url_spans(text) {
        if let Some(link) = link_for("reference", &raw, start, end, known, source, taint, false) {
            links.push(link);
        }
    }
    links
}

fn link_for(
    edge_type: &'static str,
    reference: &str,
    start: usize,
    end: usize,
    known: &[KnownNeuron],
    source: &KnownNeuron,
    taint: Taint,
    pending_when_missing: bool,
) -> Option<ExtractedLink> {
    let target = if let Some(neuron) = resolve(reference, known) {
        if same_neuron(neuron, source) {
            return None;
        }
        LinkTarget::Resolved {
            kind: neuron.kind.clone(),
            id: neuron.id.clone(),
        }
    } else if pending_when_missing || edge_type == "reference" {
        LinkTarget::Pending {
            reference: reference.to_owned(),
        }
    } else {
        return None;
    };
    Some(ExtractedLink {
        edge_type,
        target,
        span_start: start,
        span_end: end,
        taint,
        source_tag: AUTO_LINK_SOURCE,
    })
}

fn resolve<'a>(reference: &str, known: &'a [KnownNeuron]) -> Option<&'a KnownNeuron> {
    let folded = reference.to_lowercase();
    known.iter().find(|neuron| {
        neuron.id == reference
            || format!("{}/{}", neuron.kind, neuron.id) == reference
            || neuron.slug == reference
            || format!("{}/{}", neuron.kind, neuron.slug) == reference
            || neuron.title.to_lowercase() == folded
            || neuron.aliases.iter().any(|alias| alias.to_lowercase() == folded)
    })
}

fn same_neuron(left: &KnownNeuron, right: &KnownNeuron) -> bool {
    left.kind == right.kind && left.id == right.id
}

fn phrase_spans(text: &str, phrase: &str) -> Vec<(usize, usize)> {
    let text_chars: Vec<(usize, char)> = text.char_indices().collect();
    let phrase_chars: Vec<char> = phrase.chars().collect();
    if phrase_chars.is_empty() || text_chars.len() < phrase_chars.len() {
        return Vec::new();
    }
    let mut spans = Vec::new();
    let last = text_chars.len() - phrase_chars.len();
    for start in 0..=last {
        if !chars_equal(text_chars[start].1, phrase_chars[0]) {
            continue;
        }
        let matched = phrase_chars.iter().enumerate().all(|(offset, expected)| {
            chars_equal(text_chars[start + offset].1, *expected)
        });
        if !matched {
            continue;
        }
        let end_index = start + phrase_chars.len();
        let before_ok = start == 0 || !is_word_char(text_chars[start - 1].1);
        let after_ok = end_index == text_chars.len() || !is_word_char(text_chars[end_index].1);
        if before_ok && after_ok {
            let byte_start = text_chars[start].0;
            let byte_end = if end_index == text_chars.len() {
                text.len()
            } else {
                text_chars[end_index].0
            };
            spans.push((byte_start, byte_end));
        }
    }
    spans
}

fn chars_equal(left: char, right: char) -> bool {
    let left: Vec<char> = left.to_lowercase().collect();
    let right: Vec<char> = right.to_lowercase().collect();
    left == right
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn path_and_url_spans(text: &str) -> Vec<(usize, usize, String)> {
    let mut spans = Vec::new();
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut index = 0;
    while index < chars.len() {
        if let Some((end, raw)) = url_at(text, &chars, index) {
            spans.push((chars[index].0, end, raw));
            index = next_index(&chars, end);
            continue;
        }
        if let Some((end, raw)) = windows_path_at(text, &chars, index) {
            spans.push((chars[index].0, end, raw));
            index = next_index(&chars, end);
            continue;
        }
        if let Some((end, raw)) = unix_path_at(text, &chars, index) {
            spans.push((chars[index].0, end, raw));
            index = next_index(&chars, end);
            continue;
        }
        index += 1;
    }
    spans
}

fn next_index(chars: &[(usize, char)], byte: usize) -> usize {
    chars
        .iter()
        .position(|(offset, _)| *offset >= byte)
        .unwrap_or(chars.len())
}

fn url_at(text: &str, chars: &[(usize, char)], index: usize) -> Option<(usize, String)> {
    let rest = &text[chars[index].0..];
    let scheme = if rest.starts_with("https://") {
        "https://"
    } else if rest.starts_with("http://") {
        "http://"
    } else {
        return None;
    };
    let mut end = chars[index].0 + scheme.len();
    if end >= text.len() {
        return None;
    }
    for (offset, ch) in text[end..].char_indices() {
        if ch.is_whitespace() || ch == '<' || ch == '>' || ch == '"' {
            break;
        }
        end = chars[index].0 + scheme.len() + offset + ch.len_utf8();
    }
    while end > chars[index].0 && matches!(text.as_bytes()[end - 1], b'.' | b',' | b')' | b']') {
        end -= 1;
    }
    if end <= chars[index].0 + scheme.len() {
        return None;
    }
    Some((end, text[chars[index].0..end].to_owned()))
}

fn windows_path_at(text: &str, chars: &[(usize, char)], index: usize) -> Option<(usize, String)> {
    let ch = chars[index].1;
    if !ch.is_ascii_alphabetic() {
        return None;
    }
    let rest = &text[chars[index].0..];
    let bytes = rest.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' || bytes[2] != b'\\' {
        return None;
    }
    let mut end = chars[index].0 + 3;
    for (offset, ch) in text[end..].char_indices() {
        if ch.is_whitespace() {
            break;
        }
        end = chars[index].0 + 3 + offset + ch.len_utf8();
    }
    if end <= chars[index].0 + 3 {
        return None;
    }
    Some((end, text[chars[index].0..end].to_owned()))
}

fn unix_path_at(text: &str, chars: &[(usize, char)], index: usize) -> Option<(usize, String)> {
    if chars[index].1 != '/' {
        return None;
    }
    if index > 0 && !chars[index - 1].1.is_whitespace() && chars[index - 1].1 != '(' {
        return None;
    }
    let mut segments = 0;
    let mut end = chars[index].0;
    let mut saw_char = false;
    for (offset, ch) in text[chars[index].0..].char_indices() {
        if ch.is_whitespace() {
            break;
        }
        if ch == '/' {
            if saw_char {
                segments += 1;
                saw_char = false;
            }
        } else if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            saw_char = true;
        } else {
            break;
        }
        end = chars[index].0 + offset + ch.len_utf8();
    }
    if saw_char {
        segments += 1;
    }
    if segments < 2 {
        return None;
    }
    while end > chars[index].0 && matches!(text.as_bytes()[end - 1], b'.' | b',' | b')' | b']') {
        end -= 1;
    }
    Some((end, text[chars[index].0..end].to_owned()))
}

fn keep_longest(mut links: Vec<ExtractedLink>) -> Vec<ExtractedLink> {
    links.sort_by(|left, right| {
        let left_len = left.span_end.saturating_sub(left.span_start);
        let right_len = right.span_end.saturating_sub(right.span_start);
        right_len
            .cmp(&left_len)
            .then_with(|| left.span_start.cmp(&right.span_start))
            .then_with(|| edge_rank(left.edge_type).cmp(&edge_rank(right.edge_type)))
    });
    let mut kept = Vec::new();
    for link in links {
        let overlaps = kept.iter().any(|earlier: &ExtractedLink| {
            link.span_start < earlier.span_end && earlier.span_start < link.span_end
        });
        if !overlaps {
            kept.push(link);
        }
    }
    kept.sort_by(|left, right| {
        left.span_start
            .cmp(&right.span_start)
            .then_with(|| left.edge_type.cmp(right.edge_type))
    });
    kept
}

fn edge_rank(edge_type: &str) -> u8 {
    match edge_type {
        "wikilink" => 0,
        "mention" => 1,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alice() -> KnownNeuron {
        KnownNeuron {
            kind: "claim".to_owned(),
            id: "claim-alice".to_owned(),
            title: "Alice".to_owned(),
            aliases: vec!["people/alice".to_owned()],
            slug: "claim/alice--claim-alice".to_owned(),
        }
    }

    fn source() -> KnownNeuron {
        KnownNeuron {
            kind: "episode".to_owned(),
            id: "episode-1".to_owned(),
            title: "A note".to_owned(),
            aliases: Vec::new(),
            slug: "episode/a-note--episode-1".to_owned(),
        }
    }

    #[test]
    fn wikilinks_resolve_type_slug_aliases_and_keep_missing_refs_pending() {
        let text = "See [[people/alice]] and [[projects/missing]] plus [[claim/alice--claim-alice|label]].";
        let links = extract_links(text, &[alice()], &source(), Taint::Trusted);
        assert!(links.iter().any(|link| {
            link.edge_type == "wikilink"
                && matches!(&link.target, LinkTarget::Resolved { id, .. } if id == "claim-alice")
        }));
        assert!(links.iter().any(|link| {
            link.edge_type == "wikilink"
                && matches!(&link.target, LinkTarget::Pending { reference } if reference == "projects/missing")
        }));
        assert!(links.iter().all(|link| link.source_tag == AUTO_LINK_SOURCE));
    }

    #[test]
    fn mentions_are_whole_words_case_insensitive_and_longest_wins() {
        let york = KnownNeuron {
            kind: "claim".to_owned(),
            id: "claim-york".to_owned(),
            title: "York".to_owned(),
            aliases: Vec::new(),
            slug: "claim/york--claim-york".to_owned(),
        };
        let city = KnownNeuron {
            kind: "claim".to_owned(),
            id: "claim-city".to_owned(),
            title: "New York".to_owned(),
            aliases: Vec::new(),
            slug: "claim/new-york--claim-city".to_owned(),
        };
        let bob = KnownNeuron {
            kind: "claim".to_owned(),
            id: "claim-bob".to_owned(),
            title: "Bob".to_owned(),
            aliases: Vec::new(),
            slug: "claim/bob--claim-bob".to_owned(),
        };
        let text = "Visit New York. malice is not ALICE. Bob is short.";
        let links = extract_links(text, &[york, city, alice(), bob], &source(), Taint::Trusted);
        assert!(links.iter().any(|link| {
            matches!(&link.target, LinkTarget::Resolved { id, .. } if id == "claim-city")
        }));
        assert!(!links.iter().any(|link| {
            matches!(&link.target, LinkTarget::Resolved { id, .. } if id == "claim-york")
        }));
        assert!(links.iter().any(|link| {
            matches!(&link.target, LinkTarget::Resolved { id, .. } if id == "claim-alice")
        }));
        assert!(!links.iter().any(|link| {
            matches!(&link.target, LinkTarget::Resolved { id, .. } if id == "claim-bob")
        }));
    }

    #[test]
    fn paths_and_urls_become_reference_edges() {
        let text = r"Notes live at F:\Development\Ideas and https://example.com/a plus /vault/notes.";
        let links = extract_links(text, &[alice()], &source(), Taint::Trusted);
        let refs: Vec<&str> = links
            .iter()
            .filter(|link| link.edge_type == "reference")
            .map(|link| match &link.target {
                LinkTarget::Pending { reference } => reference.as_str(),
                LinkTarget::Resolved { id, .. } => id.as_str(),
            })
            .collect();
        assert!(refs.iter().any(|reference| reference.contains(r"F:\Development\Ideas")));
        assert!(refs.iter().any(|reference| reference.contains("https://example.com/a")));
        assert!(refs.iter().any(|reference| *reference == "/vault/notes"));
    }

    #[test]
    fn untrusted_text_stays_untrusted_and_repeat_is_identical() {
        let text = "See [[people/alice]] tomorrow.";
        let known = [alice()];
        let origin = source();
        let once = extract_links(text, &known, &origin, Taint::Untrusted);
        let twice = extract_links(text, &known, &origin, Taint::Untrusted);
        assert_eq!(once, twice);
        assert!(!once.is_empty());
        assert!(once.iter().all(|link| link.taint == Taint::Untrusted));
    }

    #[test]
    fn a_neuron_does_not_link_to_itself() {
        let self_note = alice();
        let links = extract_links("Alice wrote [[people/alice]].", &[alice()], &self_note, Taint::Trusted);
        assert!(links.is_empty());
    }
}
