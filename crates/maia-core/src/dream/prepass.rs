//! Pure duplicate and contradiction pre-pass. It proposes pairs and writes nothing.

use std::collections::BTreeSet;

use crate::audit::Timestamp;
use crate::brain::ClaimId;
use crate::brain::EpisodeId;
use crate::brain::FactId;
use crate::brain::LexemeId;
use crate::credit::CorrectionHold;
use crate::security::Taint;

/// Opaque entity id.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EntityId(String);

impl EntityId {
    /// Builds an entity id.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed entity id.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Episode values the pre-pass may read. Lexemes are already policy-filtered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamEpisode {
    /// Stable episode id.
    pub id: EpisodeId,
    /// Episode timestamp supplied by the caller.
    pub at: Timestamp,
    /// Episode taint. The pre-pass does not rewrite it.
    pub taint: Taint,
    /// Lexemes derived outside this function.
    pub lexemes: Vec<LexemeId>,
    /// Raw exchange. Human vault prose is not part of this value.
    pub text: String,
}

/// Whether a fact is still a current canonical record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FactCurrency {
    /// Eligible for duplicate and contradiction pairing.
    Current,
    /// Closed history. Not a candidate endpoint.
    Closed {
        /// Validity end.
        valid_end: Timestamp,
    },
    /// Noncanonical duplicate. Not a candidate endpoint.
    Merged {
        /// Canonical fact that absorbed this one.
        into: FactId,
    },
}

/// Canonical fact values the pre-pass may read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamFact {
    /// Stable fact id.
    pub id: FactId,
    /// Sentence used for duplicate equality.
    pub sentence: String,
    /// Fact taint. The pre-pass does not rewrite it.
    pub taint: Taint,
    /// Lexemes derived outside this function.
    pub lexemes: Vec<LexemeId>,
    /// Episodes already recorded as provenance.
    pub episode_ids: Vec<EpisodeId>,
    /// Entity this fact projects onto, when it has one.
    pub entity_id: Option<EntityId>,
    /// Claims consolidated into this fact.
    pub claim_ids: Vec<ClaimId>,
    /// Validity start.
    pub valid_from: Timestamp,
    /// Correction hold, when one is queued.
    pub hold: Option<CorrectionHold>,
    /// Current, closed, or merged.
    pub currency: FactCurrency,
}

/// Stable subject key shared with dismissal rows.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SubjectKey(String);

impl SubjectKey {
    /// Builds a subject key.
    pub fn new(key: impl Into<String>) -> Self {
        Self(key.into())
    }

    /// Borrowed key.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Two current facts with the same sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateCandidate {
    /// Lesser fact id.
    pub left_fact_id: FactId,
    /// Greater fact id.
    pub right_fact_id: FactId,
}

/// One pre-pass contradiction distinguished by subject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContradictionCandidate {
    /// Current fact.
    pub existing_fact_id: FactId,
    /// Episode that shares a subject and is not already provenance.
    pub episode_id: EpisodeId,
    /// `lexeme:<id>` key for the shared lexeme.
    pub subject_key: SubjectKey,
}

/// Ordered candidates. Equal inputs always produce equal output.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DreamCandidates {
    /// Duplicate pairs, ordered by fact id.
    pub duplicates: Vec<DuplicateCandidate>,
    /// Contradiction triples, ordered by fact id, episode id, then subject.
    pub contradictions: Vec<ContradictionCandidate>,
}

/// Proposes duplicate and contradiction pairs. `episodes` and `facts` are not modified.
#[must_use]
pub fn propose_dream_candidates(episodes: &[DreamEpisode], facts: &[DreamFact]) -> DreamCandidates {
    let mut current: Vec<&DreamFact> = facts
        .iter()
        .filter(|fact| fact.currency == FactCurrency::Current)
        .collect();
    current.sort_by(|left, right| left.id.cmp(&right.id));

    let mut episode_order: Vec<&DreamEpisode> = episodes.iter().collect();
    episode_order.sort_by(|left, right| left.id.cmp(&right.id));

    DreamCandidates {
        duplicates: duplicate_pairs(&current),
        contradictions: contradiction_pairs(&current, &episode_order),
    }
}

fn duplicate_pairs(current: &[&DreamFact]) -> Vec<DuplicateCandidate> {
    let mut pairs = Vec::new();
    for left_index in 0..current.len() {
        for right in current.iter().skip(left_index + 1) {
            let left = current[left_index];
            if left.sentence == right.sentence {
                pairs.push(DuplicateCandidate {
                    left_fact_id: left.id.clone(),
                    right_fact_id: right.id.clone(),
                });
            }
        }
    }
    pairs
}

fn contradiction_pairs(
    current: &[&DreamFact],
    episodes: &[&DreamEpisode],
) -> Vec<ContradictionCandidate> {
    let mut pairs = Vec::new();
    for fact in current {
        let sources: BTreeSet<&EpisodeId> = fact.episode_ids.iter().collect();
        let fact_lexemes: BTreeSet<&LexemeId> = fact.lexemes.iter().collect();
        for episode in episodes {
            if sources.contains(&episode.id) {
                continue;
            }
            let mut shared: Vec<&LexemeId> = episode
                .lexemes
                .iter()
                .filter(|lexeme| fact_lexemes.contains(lexeme))
                .collect();
            shared.sort();
            shared.dedup();
            for lexeme in shared {
                pairs.push(ContradictionCandidate {
                    existing_fact_id: fact.id.clone(),
                    episode_id: episode.id.clone(),
                    subject_key: SubjectKey::new(format!("lexeme:{}", lexeme.as_str())),
                });
            }
        }
    }
    pairs
}
