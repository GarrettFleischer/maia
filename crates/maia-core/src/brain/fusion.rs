//! Reciprocal-rank fusion and a safe FTS query string.
//!
//! Keyword, vector, and graph arms stay separate. Fusion only orders their ids.
//! Activation and Personalized PageRank still run afterwards on the fused set.

use std::collections::BTreeMap;

/// Default RRF constant from the standard fusion formula `1 / (k + rank)`.
pub const RRF_K: u32 = 60;

/// One fused document, highest score first.
#[derive(Debug, Clone, PartialEq)]
pub struct FusedRank {
    /// Stable id supplied by an arm. Empty ids are ignored.
    pub id: String,
    /// Sum of `1 / (k + rank)` across arms. Rank is 1-based.
    pub score: f64,
}

/// Fusion rejected a zero `k`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FusionError;

/// Merges ranked id lists. The first occurrence in an arm is that arm's rank.
///
/// # Errors
///
/// Returns [`FusionError`] when `k` is zero.
pub fn reciprocal_rank_fusion(arms: &[Vec<String>], k: u32) -> Result<Vec<FusedRank>, FusionError> {
    if k == 0 {
        return Err(FusionError);
    }
    let mut scores: BTreeMap<String, f64> = BTreeMap::new();
    for arm in arms {
        let mut seen = BTreeMap::<String, u32>::new();
        for (index, id) in arm.iter().enumerate() {
            if id.is_empty() {
                continue;
            }
            let rank = u32::try_from(index.saturating_add(1)).unwrap_or(u32::MAX);
            seen.entry(id.clone()).or_insert(rank);
        }
        for (id, rank) in seen {
            let add = 1.0 / f64::from(k.saturating_add(rank));
            scores
                .entry(id)
                .and_modify(|score| *score += add)
                .or_insert(add);
        }
    }
    let mut fused: Vec<FusedRank> = scores
        .into_iter()
        .map(|(id, score)| FusedRank { id, score })
        .collect();
    fused.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(fused)
}

/// Turns arbitrary recall text into a quoted FTS5 `OR` query.
///
/// Operators, quotes, backslashes, and punctuation never reach `MATCH`.
/// An empty string means "no keyword query", not an error.
#[must_use]
pub fn sanitize_fts_query(raw: &str) -> String {
    const MAX_TOKENS: usize = 24;
    const MAX_TOKEN_CHARS: usize = 64;
    const MAX_BYTES: usize = 480;
    let mut tokens = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, tokens: &mut Vec<String>| {
        if current.is_empty() {
            return;
        }
        if tokens.len() < MAX_TOKENS {
            tokens.push(std::mem::take(current));
        } else {
            current.clear();
        }
    };
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            if current.chars().count() < MAX_TOKEN_CHARS {
                current.push(ch);
            }
        } else {
            flush(&mut current, &mut tokens);
        }
    }
    flush(&mut current, &mut tokens);
    let mut query = String::new();
    for token in tokens {
        let piece = format!("\"{token}\"");
        let extra = piece.len() + if query.is_empty() { 0 } else { 4 };
        if query.len().saturating_add(extra) > MAX_BYTES {
            break;
        }
        if !query.is_empty() {
            query.push_str(" OR ");
        }
        query.push_str(&piece);
    }
    query
}

/// Short activity line. Titles are truncated and never include raw recall text beyond those titles.
#[must_use]
pub fn recall_activity_label(note_count: usize, titles: &[String]) -> String {
    let shown: Vec<String> = titles.iter().take(3).map(|title| clip_title(title)).collect();
    let noun = if note_count == 1 { "note" } else { "notes" };
    if shown.is_empty() {
        return format!("recalled {note_count} {noun}");
    }
    format!("recalled {note_count} {noun}: {}", shown.join(", "))
}

fn clip_title(title: &str) -> String {
    let mut out = String::new();
    for ch in title.chars() {
        if out.chars().count() == 40 {
            out.push('…');
            break;
        }
        if ch.is_control() || ch == '\n' || ch == '\r' {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fusion_puts_the_document_both_arms_support_ahead_of_either_arm_alone() {
        let literal = "literal-token".to_owned();
        let paraphrase = "paraphrase-only".to_owned();
        let both = "supported-by-both".to_owned();
        let keyword = vec![literal.clone(), both.clone()];
        let vector = vec![paraphrase.clone(), both.clone()];
        let keyword_ids: Vec<&str> = keyword.iter().map(String::as_str).collect();
        let vector_ids: Vec<&str> = vector.iter().map(String::as_str).collect();
        assert!(!keyword_ids.contains(&paraphrase.as_str()));
        assert!(!vector_ids.contains(&literal.as_str()));
        let fused = reciprocal_rank_fusion(&[keyword, vector], RRF_K).expect("k");
        assert_eq!(fused[0].id, both);
        let ids: Vec<&str> = fused.iter().map(|row| row.id.as_str()).collect();
        assert!(ids.contains(&literal.as_str()));
        assert!(ids.contains(&paraphrase.as_str()));
        assert!(fused[0].score > fused[1].score);
    }

    #[test]
    fn fusion_rejects_a_zero_k_and_ignores_duplicate_worse_ranks() {
        assert!(reciprocal_rank_fusion(&[vec!["a".to_owned()]], 0).is_err());
        let fused = reciprocal_rank_fusion(
            &[vec!["a".to_owned(), "a".to_owned(), "b".to_owned()]],
            RRF_K,
        )
        .expect("k");
        assert_eq!(fused[0].id, "a");
        assert_eq!(fused.len(), 2);
    }

    #[test]
    fn sanitize_quotes_paths_and_drops_fts_operators() {
        let path = sanitize_fts_query(r"F:\Development\Ideas");
        assert!(path.contains("\"Development\""));
        assert!(path.contains("\"Ideas\""));
        assert!(!path.contains('\\'));
        assert!(!path.contains(':'));
        let odd = sanitize_fts_query("))) OR (\" * :");
        assert!(odd.is_empty() || (odd.starts_with('"') && odd.ends_with('"')));
        assert!(!sanitize_fts_query("bob's best").contains('\''));
        assert!(sanitize_fts_query("zephyr_id").contains("\"zephyr_id\""));
        assert_eq!(sanitize_fts_query("***"), "");
    }

    #[test]
    fn activity_line_lists_a_few_truncated_titles() {
        let long = "A".repeat(50);
        let label = recall_activity_label(2, &[long, "Beta\nsecret".to_owned()]);
        assert!(label.starts_with("recalled 2 notes: "));
        assert!(label.contains('…'));
        assert!(!label.contains('\n'));
        assert_eq!(recall_activity_label(0, &[]), "recalled 0 notes");
        assert_eq!(
            recall_activity_label(1, &["Alpha".to_owned()]),
            "recalled 1 note: Alpha"
        );
    }
}
