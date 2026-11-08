//! Consolidation validation and all-or-nothing mutation descriptions.

use std::collections::BTreeSet;

use crate::audit::Timestamp;
use crate::brain::ClaimId;
use crate::brain::EpisodeId;
use crate::brain::FactId;
use crate::brain::LexicalPolicy;
use crate::credit::CorrectionHold;
use crate::dream::apply::ClaimStatus;
use crate::dream::apply::MentionEdge;
use crate::dream::apply::ModelIdentity;
use crate::dream::batch::DismissalDraft;
use crate::dream::batch::EntityScope;
use crate::dream::error::ConsolidationPhase;
use crate::dream::error::DreamError;
use crate::dream::error::ModelFailure;
use crate::dream::plan::assemble_commit;
use crate::dream::plan::validate_batch;
use crate::dream::prepass::DreamCandidates;
use crate::dream::prepass::DreamEpisode;
use crate::dream::prepass::DreamFact;
use crate::dream::prepass::EntityId;
use crate::dream::prepass::FactCurrency;
use crate::dream::prepass::SubjectKey;
use crate::dream::prepass::propose_dream_candidates;
use crate::dream::schedule::DreamBatchId;
use crate::security::Taint;
use crate::vault::VaultPath;

/// How a consolidation description fails closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsolidationFault {
    /// Validate and commit the description.
    None,
    /// Roll back after this planned step.
    After(ConsolidationPhase),
    /// Router failure. The response is not applied.
    Model(ModelFailure),
}

/// Claim row visible to one consolidation description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotClaim {
    /// Claim id.
    pub id: ClaimId,
    /// Sentence.
    pub sentence: String,
    /// Claim taint from promotion.
    pub taint: Taint,
    /// Source episode.
    pub episode_id: EpisodeId,
    /// Provisional or already superseded.
    pub status: ClaimStatus,
}

/// Queued negative mark visible to the batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotCorrection {
    /// Corrected fact.
    pub fact_id: FactId,
    /// Episode in the candidate key.
    pub episode_id: EpisodeId,
    /// Pre-pass subject key.
    pub subject_key: SubjectKey,
    /// Mark taint. It joins into the dream context.
    pub taint: Taint,
    /// Hold placed when the mark was queued.
    pub hold: CorrectionHold,
}

/// Entity identity visible to the batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityRow {
    /// Entity id.
    pub id: EntityId,
    /// Slug.
    pub slug: String,
    /// Single-line description.
    pub description: String,
    /// Scope.
    pub scope: EntityScope,
    /// Related entities.
    pub see: Vec<EntityId>,
    /// Entity taint.
    pub taint: Taint,
}

/// Brain rows the consolidation call is allowed to see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsolidationSnapshot {
    /// Selected claims.
    pub claims: Vec<SnapshotClaim>,
    /// Source and context episodes.
    pub episodes: Vec<DreamEpisode>,
    /// Context facts.
    pub facts: Vec<DreamFact>,
    /// Known entities.
    pub entities: Vec<EntityRow>,
    /// Queued corrections.
    pub corrections: Vec<SnapshotCorrection>,
    /// Mention edges that must survive supersession.
    pub mentions: Vec<MentionEdge>,
    /// Participant agent ids allowed in agent scope.
    pub participants: BTreeSet<String>,
}

/// Inputs to [`describe_consolidation`].
#[derive(Debug, Clone)]
pub struct ConsolidationRequest<'a> {
    /// Snapshot the response was validated against.
    pub snapshot: &'a ConsolidationSnapshot,
    /// Brain state at transaction start.
    pub current: &'a ConsolidationSnapshot,
    /// Raw structured response.
    pub response: &'a str,
    /// Injected clock.
    pub now: Timestamp,
    /// Model identity.
    pub model: ModelIdentity,
    /// Caller-supplied batch id.
    pub batch_id: DreamBatchId,
    /// Lexical policy for new fact lexemes.
    pub lexical: LexicalPolicy,
    /// Store or model fault.
    pub fault: ConsolidationFault,
}

/// Whether a correction mark was consumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrectionConsumption {
    /// Still queued.
    Queued,
    /// Closed or dismissed in this description.
    Consumed,
}

/// Correction row after a committed description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionOutcome {
    /// Corrected fact.
    pub fact_id: FactId,
    /// Episode key.
    pub episode_id: EpisodeId,
    /// Subject key.
    pub subject_key: SubjectKey,
    /// Mark taint.
    pub taint: Taint,
    /// Hold after this description.
    pub hold: Option<CorrectionHold>,
    /// Consumption.
    pub consumption: CorrectionConsumption,
}

/// Proposal id.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProposalId(String);

impl ProposalId {
    /// Builds a proposal id.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed id.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Merge or closure diverted away from a trusted fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposedOperation {
    /// Mark a duplicate noncanonical.
    Merge {
        /// Duplicate fact.
        duplicate: FactId,
        /// Canonical fact.
        canonical: FactId,
    },
    /// End a fact's validity.
    Close {
        /// Fact to close.
        fact: FactId,
        /// Replacement, when there is one.
        replacement: Option<FactId>,
    },
}

/// Owner decision recorded on a proposal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalDecision {
    /// Waiting for the owner.
    Pending,
    /// Accepted at `Confirm`.
    Accepted {
        /// Owner identity supplied by the caller.
        by: String,
    },
    /// Rejected at `Confirm`.
    Rejected {
        /// Owner identity supplied by the caller.
        by: String,
    },
}

/// Decision the owner supplies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerDecision {
    /// Apply the operation.
    Accept {
        /// Owner identity.
        by: String,
    },
    /// Leave the fact unchanged.
    Reject {
        /// Owner identity.
        by: String,
    },
}

/// Pending or decided trusted-fact operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamProposal {
    /// Proposal id.
    pub id: ProposalId,
    /// Batch that proposed it.
    pub batch_id: DreamBatchId,
    /// Merge or closure.
    pub operation: ProposedOperation,
    /// Fact the operation would change.
    pub target_fact: FactId,
    /// Batch taint. Proposals are untrusted.
    pub batch_taint: Taint,
    /// Injected creation time.
    pub created_at: Timestamp,
    /// Owner decision.
    pub decision: ProposalDecision,
}

/// Inspection record for one consolidation call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchRecord {
    /// Batch id.
    pub id: DreamBatchId,
    /// Selected claim ids.
    pub claim_ids: Vec<ClaimId>,
    /// Episode ids the call saw.
    pub episode_ids: Vec<EpisodeId>,
    /// Pre-pass candidates.
    pub candidates: DreamCandidates,
    /// Raw response.
    pub response: String,
    /// Model identity.
    pub model: ModelIdentity,
    /// Injected clock.
    pub now: Timestamp,
}

/// Projection lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionProgress {
    /// Filesystem projection has not finished.
    Pending,
    /// Every target and index succeeded.
    Complete,
}

/// Durable projection intent. Rendering does not call the model again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionRecord {
    /// Batch that enqueued it.
    pub batch_id: DreamBatchId,
    /// Affected entity ids.
    pub entities: Vec<EntityId>,
    /// Affected folder indexes.
    pub folders: Vec<VaultPath>,
    /// Progress.
    pub progress: ProjectionProgress,
}

/// Complete consolidation mutation. `Err` means this value does not exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsolidationCommit {
    /// Claims, including superseded rows.
    pub claims: Vec<SnapshotClaim>,
    /// Facts, including closed and duplicate history.
    pub facts: Vec<DreamFact>,
    /// Entities.
    pub entities: Vec<EntityRow>,
    /// Mention edges.
    pub mentions: Vec<MentionEdge>,
    /// Trusted-fact proposals.
    pub proposals: Vec<DreamProposal>,
    /// Correction outcomes.
    pub corrections: Vec<CorrectionOutcome>,
    /// Stored dismissals.
    pub dismissals: Vec<DismissalDraft>,
    /// Batch inspection record.
    pub batch: BatchRecord,
    /// Pending projection.
    pub projection: ProjectionRecord,
    /// Join of everything the call saw.
    pub context_taint: Taint,
}

/// Renders the model-visible batch. Vault human regions are not inputs.
#[must_use]
pub fn render_consolidation_model_input(snapshot: &ConsolidationSnapshot) -> String {
    let mut out = String::new();
    for claim in &snapshot.claims {
        out.push_str(&claim.sentence);
        out.push('\n');
    }
    for episode in &snapshot.episodes {
        out.push_str(episode.id.as_str());
        out.push('\n');
        out.push_str(&episode.text);
        out.push('\n');
    }
    for fact in &snapshot.facts {
        out.push_str(&fact.sentence);
        out.push('\n');
    }
    for correction in &snapshot.corrections {
        out.push_str(correction.subject_key.as_str());
        out.push('\n');
    }
    out
}

/// Validates `response` and describes one brain transaction.
pub fn describe_consolidation(
    request: &ConsolidationRequest<'_>,
) -> Result<ConsolidationCommit, DreamError> {
    if let ConsolidationFault::Model(failure) = request.fault {
        return Err(DreamError::Model(failure));
    }
    let draft = crate::dream::batch::parse_consolidation(request.response)?;
    let taint = context_taint(request.snapshot);
    let candidates = propose_dream_candidates(&request.snapshot.episodes, &request.snapshot.facts);
    let plan = validate_batch(request, &draft, taint, &candidates)?;
    if request.snapshot != request.current {
        return Err(DreamError::StaleSnapshot);
    }
    let commit = assemble_commit(request, &draft, &plan, taint, candidates)?;
    if let ConsolidationFault::After(phase) = request.fault {
        drop(commit);
        return Err(DreamError::RolledBack(phase));
    }
    Ok(commit)
}

/// Applies or rejects one proposal without rewriting sentence or episode provenance.
pub fn decide_proposal(
    proposal: &DreamProposal,
    decision: &OwnerDecision,
    fact: &DreamFact,
    now: Timestamp,
) -> Result<(DreamProposal, DreamFact), DreamError> {
    if proposal.decision != ProposalDecision::Pending {
        return Err(DreamError::AlreadyDecided);
    }
    if fact.id != proposal.target_fact {
        return Err(DreamError::UnknownId);
    }
    let mut next_fact = fact.clone();
    let next_decision = match decision {
        OwnerDecision::Reject { by } => ProposalDecision::Rejected { by: by.clone() },
        OwnerDecision::Accept { by } => {
            match &proposal.operation {
                ProposedOperation::Merge { canonical, .. } => {
                    next_fact.currency = FactCurrency::Merged {
                        into: canonical.clone(),
                    };
                }
                ProposedOperation::Close { .. } => {
                    next_fact.currency = FactCurrency::Closed { valid_end: now };
                }
            }
            ProposalDecision::Accepted { by: by.clone() }
        }
    };
    let mut next = proposal.clone();
    next.decision = next_decision;
    Ok((next, next_fact))
}

pub(crate) fn context_taint(snapshot: &ConsolidationSnapshot) -> Taint {
    let mut taint = Taint::Trusted;
    for episode in &snapshot.episodes {
        taint = taint.max(episode.taint);
    }
    for claim in &snapshot.claims {
        taint = taint.max(claim.taint);
    }
    for fact in &snapshot.facts {
        taint = taint.max(fact.taint);
    }
    for correction in &snapshot.corrections {
        taint = taint.max(correction.taint);
    }
    taint
}
