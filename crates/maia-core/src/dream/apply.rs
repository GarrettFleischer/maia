//! Promotion transaction description. No store or clock is read.

use std::collections::BTreeSet;

use crate::audit::Timestamp;
use crate::brain::ClaimId;
use crate::brain::EpisodeId;
use crate::brain::FactId;
use crate::brain::LexemeId;
use crate::brain::LexicalPolicy;
use crate::brain::lexemes_for_sentence;
use crate::dream::decision::PromotionDecision;
use crate::dream::error::PromotionError;
use crate::dream::error::PromotionPhase;
use crate::dream::parse::parse_promotion;
use crate::security::SourceRef;
use crate::security::Taint;

/// How a simulated store fault is injected after validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyFault {
    /// The description commits.
    None,
    /// Roll back after this planned step.
    After(PromotionPhase),
}

/// One episode segment supplied by the caller. Taint is joined from these records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeSegment {
    /// Segment text included in the promotion request.
    pub text: String,
    /// Segment provenance taint.
    pub taint: Taint,
    /// Inspection sources. They cannot lower taint.
    pub sources: BTreeSet<SourceRef>,
}

/// Episode scope for one promotion description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionEpisode {
    /// Episode being promoted.
    pub id: EpisodeId,
    /// Episode timestamp. Claim `valid_from` copies this value.
    pub at: Timestamp,
    /// Participant labels recorded on the episode.
    pub participants: BTreeSet<String>,
    /// Ordered exchange segments.
    pub segments: Vec<EpisodeSegment>,
    /// Readable reasoning trace when the router returned one.
    pub reasoning: Option<String>,
    /// Claim ids already stored in the brain.
    pub known_claim_ids: BTreeSet<ClaimId>,
}

/// Model identity recorded on the promoted mark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelIdentity(String);

impl ModelIdentity {
    /// Builds a model identity from caller-supplied text.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed model identity.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Ranking status of a claim row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimStatus {
    /// Rankable provisional claim.
    Provisional,
    /// Kept for history and omitted from ranking candidates.
    Superseded {
        /// Canonical fact that consolidated the claim.
        by: FactId,
    },
}

/// Provisional claim row a promotion would insert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedClaim {
    /// Stable claim id from the response.
    pub id: ClaimId,
    /// Validated sentence.
    pub sentence: String,
    /// Source episode.
    pub episode_id: EpisodeId,
    /// Join of the episode segments. Never taken from the model.
    pub taint: Taint,
    /// Union of segment sources.
    pub sources: BTreeSet<SourceRef>,
    /// Episode timestamp.
    pub valid_from: Timestamp,
    /// Always provisional for a promotion commit.
    pub status: ClaimStatus,
    /// Lexemes derived from the supplied policy.
    pub lexemes: Vec<LexemeId>,
}

/// Mention edge from a claim to its episode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionEdge {
    /// Claim endpoint.
    pub claim_id: ClaimId,
    /// Episode endpoint.
    pub episode_id: EpisodeId,
}

/// Lexeme edge derived from a claim sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexemeEdge {
    /// Claim endpoint.
    pub claim_id: ClaimId,
    /// Lexeme endpoint.
    pub lexeme_id: LexemeId,
}

/// Inspection record written when promotion commits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotedMark {
    /// Promoted episode.
    pub episode_id: EpisodeId,
    /// Model that produced the response.
    pub model: ModelIdentity,
    /// Injected clock value.
    pub now: Timestamp,
}

/// One claim closed by a promotion replace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimReplacement {
    /// Existing claim closed for ranking.
    pub old_claim_id: ClaimId,
    /// Successor claim inserted in the same transaction.
    pub new_claim_id: ClaimId,
}

/// Complete promotion mutation. Absence of this value means zero rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionCommit {
    /// Inserted claims, response order.
    pub claims: Vec<CommittedClaim>,
    /// Mention edges for new and replaced claims, response order.
    pub mentions: Vec<MentionEdge>,
    /// Mention edges for `same` claims only.
    pub same_mentions: Vec<MentionEdge>,
    /// Closed claims paired with their successors.
    pub replacements: Vec<ClaimReplacement>,
    /// Lexeme edges, response order then lexical order.
    pub lexeme_edges: Vec<LexemeEdge>,
    /// Promoted mark.
    pub promoted: PromotedMark,
}

/// Fields a promotion model request is allowed to carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromotionInputPart {
    /// Episode id.
    EpisodeId,
    /// Episode timestamp.
    Timestamp,
    /// Participants.
    Participants,
    /// Raw segments.
    Segments,
    /// Optional reasoning trace.
    Reasoning,
}

/// Closed field list for the promotion request. Facts, claims, and tools are absent.
#[must_use]
pub fn promotion_input_parts() -> &'static [PromotionInputPart] {
    &[
        PromotionInputPart::EpisodeId,
        PromotionInputPart::Timestamp,
        PromotionInputPart::Participants,
        PromotionInputPart::Segments,
        PromotionInputPart::Reasoning,
    ]
}

/// Validates `response` and describes the promotion transaction.
pub fn describe_promotion(
    episode: &PromotionEpisode,
    response: &str,
    now: Timestamp,
    model: &ModelIdentity,
    lexical: &LexicalPolicy,
    fault: ApplyFault,
) -> Result<PromotionCommit, PromotionError> {
    let drafts = parse_promotion(response, &episode.id)?;
    if drafts
        .iter()
        .any(|draft| episode.known_claim_ids.contains(&draft.id))
    {
        return Err(PromotionError::KnownId);
    }
    let claims = insert_claims(episode, &drafts, lexical);
    if fault == ApplyFault::After(PromotionPhase::InsertClaims) {
        return Err(PromotionError::RolledBack(PromotionPhase::InsertClaims));
    }
    let mentions = insert_mentions(episode, &drafts);
    if fault == ApplyFault::After(PromotionPhase::InsertMentions) {
        return Err(PromotionError::RolledBack(PromotionPhase::InsertMentions));
    }
    let lexeme_edges = insert_lexeme_edges(&claims);
    if fault == ApplyFault::After(PromotionPhase::InsertLexemes) {
        return Err(PromotionError::RolledBack(PromotionPhase::InsertLexemes));
    }
    let promoted = mark_promoted(episode, now, model);
    if fault == ApplyFault::After(PromotionPhase::MarkPromoted) {
        return Err(PromotionError::RolledBack(PromotionPhase::MarkPromoted));
    }
    Ok(PromotionCommit {
        claims,
        mentions,
        same_mentions: Vec::new(),
        replacements: Vec::new(),
        lexeme_edges,
        promoted,
    })
}

/// Describes a promotion from an owner-approved decision. Claim ids for `new`
/// and replace successors come from `new_ids` in that order; taint comes from
/// the episode, never from the model.
pub fn describe_promotion_decision(
    episode: &PromotionEpisode,
    decision: &PromotionDecision,
    new_ids: &[ClaimId],
    now: Timestamp,
    model: &ModelIdentity,
    lexical: &LexicalPolicy,
    fault: ApplyFault,
) -> Result<PromotionCommit, PromotionError> {
    if decision.skip {
        let promoted = mark_promoted(episode, now, model);
        if fault == ApplyFault::After(PromotionPhase::MarkPromoted) {
            return Err(PromotionError::RolledBack(PromotionPhase::MarkPromoted));
        }
        return Ok(PromotionCommit {
            claims: Vec::new(),
            mentions: Vec::new(),
            same_mentions: Vec::new(),
            replacements: Vec::new(),
            lexeme_edges: Vec::new(),
            promoted,
        });
    }
    let needed = decision.new.len() + decision.replaces.len();
    if new_ids.len() != needed {
        return Err(PromotionError::MissingField);
    }
    for id in new_ids {
        if episode.known_claim_ids.contains(id) {
            return Err(PromotionError::KnownId);
        }
    }
    for same in &decision.same {
        if !episode.known_claim_ids.contains(same) {
            return Err(PromotionError::UnknownClaimId);
        }
    }
    for replace in &decision.replaces {
        if !episode.known_claim_ids.contains(&replace.old) {
            return Err(PromotionError::UnknownClaimId);
        }
    }
    let mut cited = BTreeSet::new();
    for same in &decision.same {
        if !cited.insert(same.clone()) {
            return Err(PromotionError::DuplicateId);
        }
    }
    for replace in &decision.replaces {
        if !cited.insert(replace.old.clone()) {
            return Err(PromotionError::DuplicateId);
        }
    }
    let taint = joined_taint(&episode.segments);
    let sources = joined_sources(&episode.segments);
    let mut claims = Vec::new();
    let mut mentions = Vec::new();
    let mut replacements = Vec::new();
    let mut id_index = 0usize;
    for sentence in &decision.new {
        let id = new_ids[id_index].clone();
        id_index += 1;
        claims.push(CommittedClaim {
            id: id.clone(),
            sentence: sentence.clone(),
            episode_id: episode.id.clone(),
            taint,
            sources: sources.clone(),
            valid_from: episode.at,
            status: ClaimStatus::Provisional,
            lexemes: lexemes_for_sentence(sentence, lexical),
        });
        mentions.push(MentionEdge {
            claim_id: id,
            episode_id: episode.id.clone(),
        });
    }
    for replace in &decision.replaces {
        let id = new_ids[id_index].clone();
        id_index += 1;
        claims.push(CommittedClaim {
            id: id.clone(),
            sentence: replace.sentence.clone(),
            episode_id: episode.id.clone(),
            taint,
            sources: sources.clone(),
            valid_from: episode.at,
            status: ClaimStatus::Provisional,
            lexemes: lexemes_for_sentence(&replace.sentence, lexical),
        });
        mentions.push(MentionEdge {
            claim_id: id.clone(),
            episode_id: episode.id.clone(),
        });
        replacements.push(ClaimReplacement {
            old_claim_id: replace.old.clone(),
            new_claim_id: id,
        });
    }
    if fault == ApplyFault::After(PromotionPhase::InsertClaims) {
        return Err(PromotionError::RolledBack(PromotionPhase::InsertClaims));
    }
    let same_mentions = decision
        .same
        .iter()
        .map(|claim_id| MentionEdge {
            claim_id: claim_id.clone(),
            episode_id: episode.id.clone(),
        })
        .collect::<Vec<_>>();
    if fault == ApplyFault::After(PromotionPhase::InsertMentions) {
        return Err(PromotionError::RolledBack(PromotionPhase::InsertMentions));
    }
    let lexeme_edges = insert_lexeme_edges(&claims);
    if fault == ApplyFault::After(PromotionPhase::InsertLexemes) {
        return Err(PromotionError::RolledBack(PromotionPhase::InsertLexemes));
    }
    let promoted = mark_promoted(episode, now, model);
    if fault == ApplyFault::After(PromotionPhase::MarkPromoted) {
        return Err(PromotionError::RolledBack(PromotionPhase::MarkPromoted));
    }
    Ok(PromotionCommit {
        claims,
        mentions,
        same_mentions,
        replacements,
        lexeme_edges,
        promoted,
    })
}

fn insert_claims(
    episode: &PromotionEpisode,
    drafts: &[crate::dream::ClaimDraft],
    lexical: &LexicalPolicy,
) -> Vec<CommittedClaim> {
    let taint = joined_taint(&episode.segments);
    let sources = joined_sources(&episode.segments);
    drafts
        .iter()
        .map(|draft| CommittedClaim {
            id: draft.id.clone(),
            sentence: draft.sentence.clone(),
            episode_id: episode.id.clone(),
            taint,
            sources: sources.clone(),
            valid_from: episode.at,
            status: ClaimStatus::Provisional,
            lexemes: lexemes_for_sentence(&draft.sentence, lexical),
        })
        .collect()
}

fn insert_mentions(
    episode: &PromotionEpisode,
    drafts: &[crate::dream::ClaimDraft],
) -> Vec<MentionEdge> {
    drafts
        .iter()
        .map(|draft| MentionEdge {
            claim_id: draft.id.clone(),
            episode_id: episode.id.clone(),
        })
        .collect()
}

fn insert_lexeme_edges(claims: &[CommittedClaim]) -> Vec<LexemeEdge> {
    let mut edges = Vec::new();
    for claim in claims {
        for lexeme in &claim.lexemes {
            edges.push(LexemeEdge {
                claim_id: claim.id.clone(),
                lexeme_id: lexeme.clone(),
            });
        }
    }
    edges
}

fn mark_promoted(
    episode: &PromotionEpisode,
    now: Timestamp,
    model: &ModelIdentity,
) -> PromotedMark {
    PromotedMark {
        episode_id: episode.id.clone(),
        model: model.clone(),
        now,
    }
}

fn joined_taint(segments: &[EpisodeSegment]) -> Taint {
    segments.iter().fold(Taint::Trusted, |acc, segment| {
        if segment.taint > acc {
            segment.taint
        } else {
            acc
        }
    })
}

fn joined_sources(segments: &[EpisodeSegment]) -> BTreeSet<SourceRef> {
    let mut sources = BTreeSet::new();
    for segment in segments {
        sources.extend(segment.sources.iter().cloned());
    }
    sources
}
