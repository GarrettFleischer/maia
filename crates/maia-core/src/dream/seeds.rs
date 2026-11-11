//! Deterministic promotion seeds. No clock, store, or embedder.

use std::collections::BTreeMap;

use crate::brain::ClaimId;

/// One nearest-claim hit from full text or a same-model vector search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimSeed {
    /// Stable claim id.
    pub claim_id: String,
    /// Claim sentence shown to the promoter or ranker.
    pub sentence: String,
    /// `f32` distance bits. `None` for a full-text-only hit.
    pub distance_bits: Option<u32>,
}

/// Merges full-text and vector hits into one deterministic list.
///
/// Claims found by both channels come first, then vector-only hits by
/// distance, then full-text-only hits. Claim id breaks remaining ties.
/// Input order does not change the result.
#[must_use]
pub fn merge_claim_seeds(
    full_text: &[ClaimSeed],
    vectors: &[ClaimSeed],
    limit: usize,
) -> Vec<ClaimSeed> {
    let mut by_id: BTreeMap<String, MergedSeed> = BTreeMap::new();
    for seed in full_text {
        let entry = by_id
            .entry(seed.claim_id.clone())
            .or_insert_with(|| MergedSeed::full_text(seed));
        entry.full_text = true;
        if entry.sentence.is_empty() {
            entry.sentence = seed.sentence.clone();
        }
    }
    for seed in vectors {
        let entry = by_id
            .entry(seed.claim_id.clone())
            .or_insert_with(|| MergedSeed::vector(seed));
        entry.vector = true;
        if entry.sentence.is_empty() {
            entry.sentence = seed.sentence.clone();
        }
        if entry.distance_bits.is_none() {
            entry.distance_bits = seed.distance_bits;
        }
    }
    let mut rows: Vec<MergedSeed> = by_id.into_values().collect();
    rows.sort_by(|left, right| {
        left.rank()
            .cmp(&right.rank())
            .then_with(|| {
                left.distance_bits
                    .unwrap_or(u32::MAX)
                    .cmp(&right.distance_bits.unwrap_or(u32::MAX))
            })
            .then_with(|| left.claim_id.cmp(&right.claim_id))
    });
    rows.truncate(limit);
    rows.into_iter()
        .map(|row| ClaimSeed {
            claim_id: row.claim_id,
            sentence: row.sentence,
            distance_bits: row.distance_bits,
        })
        .collect()
}

/// Stable claim id for one new sentence from an episode. Restarts do not reuse it.
#[must_use]
pub fn promotion_claim_id(episode_id: &str, index: usize) -> ClaimId {
    ClaimId::new(format!("claim-{episode_id}-{index}"))
}

/// Seconds to wait before the same episode is selected again after `failures`.
///
/// `failures` is the count after the attempt that just failed.
#[must_use]
pub fn promotion_backoff_seconds(failures: u32) -> i64 {
    match failures {
        0 | 1 => 2,
        2 => 4,
        _ => 8,
    }
}

struct MergedSeed {
    claim_id: String,
    sentence: String,
    distance_bits: Option<u32>,
    full_text: bool,
    vector: bool,
}

impl MergedSeed {
    fn full_text(seed: &ClaimSeed) -> Self {
        Self {
            claim_id: seed.claim_id.clone(),
            sentence: seed.sentence.clone(),
            distance_bits: None,
            full_text: true,
            vector: false,
        }
    }

    fn vector(seed: &ClaimSeed) -> Self {
        Self {
            claim_id: seed.claim_id.clone(),
            sentence: seed.sentence.clone(),
            distance_bits: seed.distance_bits,
            full_text: false,
            vector: true,
        }
    }

    fn rank(&self) -> u8 {
        match (self.full_text, self.vector) {
            (true, true) => 0,
            (false, true) => 1,
            (true, false) => 2,
            (false, false) => 3,
        }
    }
}
