//! Deterministic relatedness and entity links chosen at promotion.
//!
//! The caller supplies lexemes, taint, and a cosine that was computed only for
//! the same embedder model. This leaf does not read a store, clock, or embedder.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

/// Default cap on relatedness edges from one new claim.
pub const RELATEDNESS_FANOUT: usize = 4;
/// Lexical overlap, in thousandths, required before a relatedness edge.
pub const LEXICAL_MIN_MILLIS: u32 = 500;
/// Same-model cosine, in thousandths, required before a vector relatedness edge.
pub const VECTOR_MIN_MILLIS: i32 = 800;

/// Why a relatedness edge was selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelatedChannel {
    /// Shared lexemes cleared the overlap threshold.
    Lexeme,
    /// A same-model cosine cleared the vector threshold.
    Vector,
}

/// One existing claim the promoter already retrieved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelatedCandidate {
    /// Existing claim id.
    pub claim_id: String,
    /// Lexemes of that claim, already normalized.
    pub lexemes: Vec<String>,
    /// The existing claim is untrusted.
    pub untrusted: bool,
    /// Cosine times 1000 when the vectors share one model. Otherwise `None`.
    pub cosine_millis: Option<i32>,
    /// Model that produced `cosine_millis`.
    pub model_id: Option<String>,
}

/// One relatedness edge from a new claim to an existing claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelatedLink {
    /// Existing claim.
    pub claim_id: String,
    /// Weight times 1000 after the taint cap.
    pub weight_millis: u32,
    /// Channel that won.
    pub channel: RelatedChannel,
}

/// One entity whose slug can match a claim lexeme.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntitySlug {
    /// Entity id.
    pub entity_id: String,
    /// Path slug.
    pub slug: String,
}

/// One claim-to-entity edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityLink {
    /// Entity id.
    pub entity_id: String,
    /// Weight times 1000. Untrusted claims use half.
    pub weight_millis: u32,
}

/// Picks nearest claims above the similarity threshold, capped and ordered.
///
/// A cosine is used only when `query_model_id` equals the candidate model.
/// Input order does not change the result. An untrusted endpoint halves the weight.
#[must_use]
pub fn select_related_claims(
    new_lexemes: &[String],
    new_untrusted: bool,
    query_model_id: Option<&str>,
    candidates: &[RelatedCandidate],
    fanout: usize,
) -> Vec<RelatedLink> {
    let mut best: BTreeMap<String, Scored> = BTreeMap::new();
    for candidate in candidates {
        if candidate.claim_id.is_empty() {
            continue;
        }
        let lexical = overlap_millis(new_lexemes, &candidate.lexemes);
        let vector = comparable_cosine(query_model_id, candidate);
        let (score, channel) = match (lexical >= LEXICAL_MIN_MILLIS, vector) {
            (true, Some(cosine)) if cosine >= lexical => (cosine, RelatedChannel::Vector),
            (true, _) => (lexical, RelatedChannel::Lexeme),
            (false, Some(cosine))
                if u32::try_from(VECTOR_MIN_MILLIS)
                    .ok()
                    .is_some_and(|min| cosine >= min) =>
            {
                (cosine, RelatedChannel::Vector)
            }
            (false, _) => continue,
        };
        let row = Scored {
            claim_id: candidate.claim_id.clone(),
            score,
            weight_millis: taint_weight(score, new_untrusted || candidate.untrusted),
            channel,
        };
        match best.get(&row.claim_id) {
            Some(existing) if existing.score >= row.score => {}
            _ => {
                best.insert(row.claim_id.clone(), row);
            }
        }
    }
    let mut ranked: Vec<Scored> = best.into_values().collect();
    ranked.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.claim_id.cmp(&right.claim_id))
    });
    ranked.truncate(fanout);
    ranked
        .into_iter()
        .map(|row| RelatedLink {
            claim_id: row.claim_id,
            weight_millis: row.weight_millis,
            channel: row.channel,
        })
        .collect()
}

/// Links a claim to entities whose slug is one of its lexemes.
#[must_use]
pub fn select_entity_links(
    lexemes: &[String],
    entities: &[EntitySlug],
    untrusted: bool,
    fanout: usize,
) -> Vec<EntityLink> {
    let lexeme_set: BTreeSet<&str> = lexemes.iter().map(String::as_str).collect();
    let mut links = Vec::new();
    let mut seen = BTreeSet::new();
    for entity in entities {
        if entity.entity_id.is_empty() || entity.slug.is_empty() {
            continue;
        }
        if !lexeme_set.contains(entity.slug.as_str()) || !seen.insert(entity.entity_id.clone()) {
            continue;
        }
        links.push(EntityLink {
            entity_id: entity.entity_id.clone(),
            weight_millis: taint_weight(1000, untrusted),
        });
    }
    links.sort_by(|left, right| left.entity_id.cmp(&right.entity_id));
    links.truncate(fanout);
    links
}

struct Scored {
    claim_id: String,
    score: u32,
    weight_millis: u32,
    channel: RelatedChannel,
}

fn comparable_cosine(query_model_id: Option<&str>, candidate: &RelatedCandidate) -> Option<u32> {
    let cosine = candidate.cosine_millis?;
    let model = candidate.model_id.as_deref()?;
    let query_model = query_model_id?;
    if model != query_model || cosine < 0 {
        return None;
    }
    u32::try_from(cosine).ok()
}

fn overlap_millis(left: &[String], right: &[String]) -> u32 {
    let left_set: BTreeSet<&str> = left.iter().map(String::as_str).collect();
    let right_set: BTreeSet<&str> = right.iter().map(String::as_str).collect();
    if left_set.is_empty() || right_set.is_empty() {
        return 0;
    }
    let shared = left_set.intersection(&right_set).count();
    let denom = left_set.len().max(right_set.len());
    u32::try_from(shared * 1000 / denom).unwrap_or(0)
}

fn taint_weight(score: u32, untrusted: bool) -> u32 {
    if untrusted { score / 2 } else { score }
}
