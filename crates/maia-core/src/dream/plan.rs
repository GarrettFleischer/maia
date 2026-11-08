//! Validation and commit assembly for one consolidation description.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use crate::audit::Timestamp;
use crate::brain::FactId;
use crate::brain::lexemes_for_sentence;
use crate::dream::apply::ClaimStatus;
use crate::dream::batch::ConsolidationDraft;
use crate::dream::batch::EntityScope;
use crate::dream::batch::ReplacementRef;
use crate::dream::consolidate::BatchRecord;
use crate::dream::consolidate::ConsolidationCommit;
use crate::dream::consolidate::ConsolidationRequest;
use crate::dream::consolidate::ConsolidationSnapshot;
use crate::dream::consolidate::CorrectionConsumption;
use crate::dream::consolidate::CorrectionOutcome;
use crate::dream::consolidate::DreamProposal;
use crate::dream::consolidate::EntityRow;
use crate::dream::consolidate::ProjectionProgress;
use crate::dream::consolidate::ProjectionRecord;
use crate::dream::consolidate::ProposalDecision;
use crate::dream::consolidate::ProposalId;
use crate::dream::consolidate::ProposedOperation;
use crate::dream::error::DreamError;
use crate::dream::prepass::DreamCandidates;
use crate::dream::prepass::DreamFact;
use crate::dream::prepass::EntityId;
use crate::dream::prepass::FactCurrency;
use crate::dream::schedule::DreamBatchId;
use crate::security::Taint;
use crate::vault::VaultPath;

pub(crate) struct ApplyPlan {
    pub(crate) sources: BTreeMap<FactId, Vec<crate::brain::EpisodeId>>,
    pub(crate) applied_merges: Vec<(FactId, FactId)>,
    pub(crate) applied_closures: BTreeMap<FactId, Timestamp>,
    pub(crate) proposals: Vec<DreamProposal>,
}

pub(crate) fn validate_batch(
    request: &ConsolidationRequest<'_>,
    draft: &ConsolidationDraft,
    context_taint: Taint,
    candidates: &DreamCandidates,
) -> Result<ApplyPlan, DreamError> {
    let snapshot = request.snapshot;
    ensure_partition(snapshot)?;
    validate_entities(snapshot, draft)?;
    let sources = validate_facts(snapshot, draft)?;
    validate_links(snapshot, draft)?;
    let (applied_merges, applied_closures, proposals) = classify_operations(
        snapshot,
        draft,
        &sources,
        context_taint,
        request.now,
        &request.batch_id,
    )?;
    answer_candidates(snapshot, draft, candidates, &applied_closures, &proposals)?;
    Ok(ApplyPlan {
        sources,
        applied_merges,
        applied_closures,
        proposals,
    })
}

pub(crate) fn assemble_commit(
    request: &ConsolidationRequest<'_>,
    draft: &ConsolidationDraft,
    plan: &ApplyPlan,
    context_taint: Taint,
    candidates: DreamCandidates,
) -> Result<ConsolidationCommit, DreamError> {
    let new_facts = new_fact_rows(request, draft, plan, context_taint)?;
    let facts = clear_holds(
        updated_facts(request.snapshot, plan, &new_facts),
        &updated_corrections(request.snapshot, draft, plan),
    );
    let corrections = updated_corrections(request.snapshot, draft, plan);
    let entities = updated_entities(request.snapshot, draft, context_taint);
    Ok(ConsolidationCommit {
        claims: updated_claims(request.snapshot, draft),
        facts,
        entities: entities.clone(),
        mentions: request.snapshot.mentions.clone(),
        proposals: plan.proposals.clone(),
        corrections,
        dismissals: draft.dismissals.clone(),
        batch: batch_record(request, candidates),
        projection: projection_record(request, draft, &entities)?,
        context_taint,
    })
}

fn ensure_partition(snapshot: &ConsolidationSnapshot) -> Result<(), DreamError> {
    if snapshot
        .episodes
        .iter()
        .any(|episode| episode.taint != Taint::Trusted)
    {
        return Ok(());
    }
    let untrusted = snapshot
        .facts
        .iter()
        .any(|fact| fact.taint != Taint::Trusted)
        || snapshot
            .claims
            .iter()
            .any(|claim| claim.taint != Taint::Trusted)
        || snapshot
            .corrections
            .iter()
            .any(|correction| correction.taint != Taint::Trusted);
    if untrusted {
        Err(DreamError::TaintPartition)
    } else {
        Ok(())
    }
}

fn validate_entities(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
) -> Result<(), DreamError> {
    let mut slugs = BTreeSet::new();
    for entity in &snapshot.entities {
        slugs.insert((scope_key(&entity.scope), entity.slug.clone()));
    }
    for entity in &draft.entities {
        if let EntityScope::Agent { agent_id } = &entity.scope {
            if !snapshot.participants.contains(agent_id) {
                return Err(DreamError::UnknownAgent);
            }
        }
        if let Some(existing) = snapshot.entities.iter().find(|row| row.id == entity.id) {
            if existing.slug != entity.slug
                || existing.description != entity.description
                || existing.scope != entity.scope
                || existing.see != entity.see
            {
                return Err(DreamError::IdentityMismatch);
            }
            continue;
        }
        if !slugs.insert((scope_key(&entity.scope), entity.slug.clone())) {
            return Err(DreamError::InvalidSlug);
        }
    }
    let known = known_entities(snapshot, draft);
    for entity in &draft.entities {
        for see in &entity.see {
            if !known.contains(see) {
                return Err(DreamError::UnknownId);
            }
        }
    }
    Ok(())
}

fn validate_facts(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
) -> Result<BTreeMap<FactId, Vec<crate::brain::EpisodeId>>, DreamError> {
    let mut sources = BTreeMap::new();
    let mut used_claims = BTreeSet::new();
    let known = known_entities(snapshot, draft);
    for fact in &draft.canonical_facts {
        if snapshot.facts.iter().any(|existing| existing.id == fact.id) {
            return Err(DreamError::DuplicateId);
        }
        if !known.contains(&fact.entity_id) {
            return Err(DreamError::UnknownId);
        }
        let mut real = BTreeSet::new();
        for claim_id in &fact.claim_ids {
            if !used_claims.insert(claim_id.clone()) {
                return Err(DreamError::DuplicateId);
            }
            let Some(claim) = snapshot.claims.iter().find(|claim| &claim.id == claim_id) else {
                return Err(DreamError::UnknownId);
            };
            if claim.status != ClaimStatus::Provisional {
                return Err(DreamError::StaleSnapshot);
            }
            real.insert(claim.episode_id.clone());
        }
        if real.is_empty() {
            return Err(DreamError::InvalidProvenance);
        }
        for episode_id in &fact.episode_ids {
            if !real.contains(episode_id) {
                return Err(DreamError::InventedProvenance);
            }
        }
        for episode_id in &real {
            if !snapshot
                .episodes
                .iter()
                .any(|episode| &episode.id == episode_id)
            {
                return Err(DreamError::UnknownId);
            }
        }
        sources.insert(fact.id.clone(), real.into_iter().collect());
    }
    Ok(sources)
}

fn validate_links(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
) -> Result<(), DreamError> {
    let new_ids: BTreeSet<&FactId> = draft.canonical_facts.iter().map(|fact| &fact.id).collect();
    for merge in &draft.merges {
        let _ = current_fact(snapshot, &merge.duplicate_fact_id)?;
        if !new_ids.contains(&merge.canonical_fact_id)
            && current_fact(snapshot, &merge.canonical_fact_id).is_err()
        {
            return Err(DreamError::UnknownId);
        }
    }
    for closure in &draft.closures {
        let _ = current_fact(snapshot, &closure.fact_id)?;
        if let ReplacementRef::Fact(replacement) = &closure.replacement {
            if !new_ids.contains(replacement) && current_fact(snapshot, replacement).is_err() {
                return Err(DreamError::UnknownId);
            }
        }
    }
    Ok(())
}

type ClassifiedOps = (
    Vec<(FactId, FactId)>,
    BTreeMap<FactId, Timestamp>,
    Vec<DreamProposal>,
);

fn classify_operations(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
    sources: &BTreeMap<FactId, Vec<crate::brain::EpisodeId>>,
    context_taint: Taint,
    now: Timestamp,
    batch_id: &DreamBatchId,
) -> Result<ClassifiedOps, DreamError> {
    let mut applied_merges = Vec::new();
    let mut proposals = Vec::new();
    for merge in &draft.merges {
        let duplicate = current_fact(snapshot, &merge.duplicate_fact_id)?;
        if protects(context_taint, duplicate.taint) {
            proposals.push(make_proposal(
                batch_id,
                now,
                ProposedOperation::Merge {
                    duplicate: merge.duplicate_fact_id.clone(),
                    canonical: merge.canonical_fact_id.clone(),
                },
                merge.duplicate_fact_id.clone(),
                "merge",
            ));
        } else {
            applied_merges.push((
                merge.duplicate_fact_id.clone(),
                merge.canonical_fact_id.clone(),
            ));
        }
    }
    let mut applied_closures = BTreeMap::new();
    for closure in &draft.closures {
        let fact = current_fact(snapshot, &closure.fact_id)?;
        if protects(context_taint, fact.taint) {
            proposals.push(make_proposal(
                batch_id,
                now,
                ProposedOperation::Close {
                    fact: closure.fact_id.clone(),
                    replacement: replacement_id(&closure.replacement),
                },
                closure.fact_id.clone(),
                "close",
            ));
        } else {
            applied_closures.insert(
                closure.fact_id.clone(),
                closure_end(snapshot, draft, sources, closure, now)?,
            );
        }
    }
    Ok((applied_merges, applied_closures, proposals))
}

fn answer_candidates(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
    candidates: &DreamCandidates,
    applied_closures: &BTreeMap<FactId, Timestamp>,
    proposals: &[DreamProposal],
) -> Result<(), DreamError> {
    let mut required = BTreeSet::new();
    for candidate in &candidates.contradictions {
        required.insert((
            candidate.existing_fact_id.clone(),
            candidate.episode_id.clone(),
            candidate.subject_key.clone(),
        ));
    }
    for correction in &snapshot.corrections {
        required.insert((
            correction.fact_id.clone(),
            correction.episode_id.clone(),
            correction.subject_key.clone(),
        ));
    }
    let mut closed = applied_closures.keys().cloned().collect::<BTreeSet<_>>();
    for proposal in proposals {
        if let ProposedOperation::Close { fact, .. } = &proposal.operation {
            closed.insert(fact.clone());
        }
    }
    required.retain(|(fact_id, _, _)| !closed.contains(fact_id));
    let mut answered = BTreeSet::new();
    for dismissal in &draft.dismissals {
        let key = (
            dismissal.existing_fact_id.clone(),
            dismissal.episode_id.clone(),
            dismissal.subject_key.clone(),
        );
        if !required.contains(&key) || !answered.insert(key) {
            return Err(DreamError::ExtraDismissal);
        }
    }
    if answered.len() != required.len() {
        Err(DreamError::UnansweredCandidate)
    } else {
        Ok(())
    }
}

fn new_fact_rows(
    request: &ConsolidationRequest<'_>,
    draft: &ConsolidationDraft,
    plan: &ApplyPlan,
    context_taint: Taint,
) -> Result<Vec<DreamFact>, DreamError> {
    let mut facts = Vec::with_capacity(draft.canonical_facts.len());
    for fact in &draft.canonical_facts {
        let episode_ids = plan
            .sources
            .get(&fact.id)
            .cloned()
            .ok_or(DreamError::InvalidProvenance)?;
        let valid_from = max_timestamp(request.snapshot, &episode_ids)?;
        facts.push(DreamFact {
            id: fact.id.clone(),
            sentence: fact.sentence.clone(),
            taint: context_taint,
            lexemes: lexemes_for_sentence(&fact.sentence, &request.lexical),
            episode_ids,
            entity_id: Some(fact.entity_id.clone()),
            claim_ids: fact.claim_ids.clone(),
            valid_from,
            hold: None,
            currency: FactCurrency::Current,
        });
    }
    Ok(facts)
}

fn updated_facts(
    snapshot: &ConsolidationSnapshot,
    plan: &ApplyPlan,
    new_facts: &[DreamFact],
) -> Vec<DreamFact> {
    let mut facts = Vec::with_capacity(snapshot.facts.len() + new_facts.len());
    for fact in &snapshot.facts {
        let mut next = fact.clone();
        if let Some((_, canonical)) = plan
            .applied_merges
            .iter()
            .find(|(duplicate, _)| duplicate == &fact.id)
        {
            next.currency = FactCurrency::Merged {
                into: canonical.clone(),
            };
        }
        if let Some(valid_end) = plan.applied_closures.get(&fact.id) {
            next.currency = FactCurrency::Closed {
                valid_end: *valid_end,
            };
        }
        facts.push(next);
    }
    facts.extend(new_facts.iter().cloned());
    facts
}

fn updated_claims(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
) -> Vec<crate::dream::consolidate::SnapshotClaim> {
    snapshot
        .claims
        .iter()
        .map(|claim| {
            let mut next = claim.clone();
            if let Some(fact) = draft
                .canonical_facts
                .iter()
                .find(|fact| fact.claim_ids.iter().any(|id| id == &claim.id))
            {
                next.status = ClaimStatus::Superseded {
                    by: fact.id.clone(),
                };
            }
            next
        })
        .collect()
}

fn updated_entities(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
    context_taint: Taint,
) -> Vec<EntityRow> {
    let mut entities = snapshot.entities.clone();
    for entity in &draft.entities {
        if entities.iter().any(|existing| existing.id == entity.id) {
            continue;
        }
        entities.push(EntityRow {
            id: entity.id.clone(),
            slug: entity.slug.clone(),
            description: entity.description.clone(),
            scope: entity.scope.clone(),
            see: entity.see.clone(),
            taint: context_taint,
        });
    }
    entities
}

fn updated_corrections(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
    plan: &ApplyPlan,
) -> Vec<CorrectionOutcome> {
    snapshot
        .corrections
        .iter()
        .map(|correction| {
            let dismissed = draft.dismissals.iter().any(|dismissal| {
                dismissal.existing_fact_id == correction.fact_id
                    && dismissal.episode_id == correction.episode_id
                    && dismissal.subject_key == correction.subject_key
            });
            let consumed = dismissed || plan.applied_closures.contains_key(&correction.fact_id);
            CorrectionOutcome {
                fact_id: correction.fact_id.clone(),
                episode_id: correction.episode_id.clone(),
                subject_key: correction.subject_key.clone(),
                taint: correction.taint,
                hold: if consumed {
                    None
                } else {
                    Some(correction.hold)
                },
                consumption: if consumed {
                    CorrectionConsumption::Consumed
                } else {
                    CorrectionConsumption::Queued
                },
            }
        })
        .collect()
}

fn clear_holds(mut facts: Vec<DreamFact>, corrections: &[CorrectionOutcome]) -> Vec<DreamFact> {
    for fact in &mut facts {
        let queued = corrections.iter().any(|correction| {
            correction.fact_id == fact.id && correction.consumption == CorrectionConsumption::Queued
        });
        let touched = corrections
            .iter()
            .any(|correction| correction.fact_id == fact.id);
        if touched && !queued {
            fact.hold = None;
        }
    }
    facts
}

fn projection_record(
    request: &ConsolidationRequest<'_>,
    draft: &ConsolidationDraft,
    entities: &[EntityRow],
) -> Result<ProjectionRecord, DreamError> {
    let mut ids = BTreeSet::new();
    for entity in &draft.entities {
        ids.insert(entity.id.clone());
    }
    for fact in &draft.canonical_facts {
        ids.insert(fact.entity_id.clone());
    }
    let mut folders = BTreeSet::new();
    for id in &ids {
        let entity = entities
            .iter()
            .find(|entity| &entity.id == id)
            .ok_or(DreamError::UnknownId)?;
        folders.insert(folder_for(&entity.scope)?);
    }
    Ok(ProjectionRecord {
        batch_id: request.batch_id.clone(),
        entities: ids.into_iter().collect(),
        folders: folders.into_iter().collect(),
        progress: ProjectionProgress::Pending,
    })
}

fn batch_record(request: &ConsolidationRequest<'_>, candidates: DreamCandidates) -> BatchRecord {
    let mut claim_ids: Vec<_> = request
        .snapshot
        .claims
        .iter()
        .map(|claim| claim.id.clone())
        .collect();
    claim_ids.sort();
    let mut episode_ids: Vec<_> = request
        .snapshot
        .episodes
        .iter()
        .map(|episode| episode.id.clone())
        .collect();
    episode_ids.sort();
    BatchRecord {
        id: request.batch_id.clone(),
        claim_ids,
        episode_ids,
        candidates,
        response: request.response.to_owned(),
        model: request.model.clone(),
        now: request.now,
    }
}

fn current_fact<'a>(
    snapshot: &'a ConsolidationSnapshot,
    id: &FactId,
) -> Result<&'a DreamFact, DreamError> {
    let fact = snapshot
        .facts
        .iter()
        .find(|fact| &fact.id == id)
        .ok_or(DreamError::UnknownId)?;
    if fact.currency == FactCurrency::Current {
        Ok(fact)
    } else {
        Err(DreamError::ContradictoryOperation)
    }
}

fn closure_end(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
    sources: &BTreeMap<FactId, Vec<crate::brain::EpisodeId>>,
    closure: &crate::dream::batch::ClosureDraft,
    now: Timestamp,
) -> Result<Timestamp, DreamError> {
    match &closure.replacement {
        ReplacementRef::None => Ok(now),
        ReplacementRef::Fact(id) => {
            if draft.canonical_facts.iter().any(|fact| &fact.id == id) {
                let episodes = sources.get(id).ok_or(DreamError::InvalidProvenance)?;
                return max_timestamp(snapshot, episodes);
            }
            Ok(current_fact(snapshot, id)?.valid_from)
        }
    }
}

fn max_timestamp(
    snapshot: &ConsolidationSnapshot,
    episodes: &[crate::brain::EpisodeId],
) -> Result<Timestamp, DreamError> {
    episodes
        .iter()
        .filter_map(|episode_id| {
            snapshot
                .episodes
                .iter()
                .find(|episode| &episode.id == episode_id)
                .map(|episode| episode.at)
        })
        .max()
        .ok_or(DreamError::InvalidProvenance)
}

fn make_proposal(
    batch_id: &DreamBatchId,
    now: Timestamp,
    operation: ProposedOperation,
    target: FactId,
    kind: &str,
) -> DreamProposal {
    DreamProposal {
        id: ProposalId::new(format!(
            "proposal:{}:{kind}:{}",
            batch_id.as_str(),
            target.as_str()
        )),
        batch_id: batch_id.clone(),
        operation,
        target_fact: target,
        batch_taint: Taint::Untrusted,
        created_at: now,
        decision: ProposalDecision::Pending,
    }
}

fn replacement_id(replacement: &ReplacementRef) -> Option<FactId> {
    match replacement {
        ReplacementRef::None => None,
        ReplacementRef::Fact(id) => Some(id.clone()),
    }
}

fn protects(context: Taint, fact: Taint) -> bool {
    context == Taint::Untrusted && fact == Taint::Trusted
}

fn scope_key(scope: &EntityScope) -> String {
    match scope {
        EntityScope::World => "world".to_owned(),
        EntityScope::Agent { agent_id } => format!("agent:{agent_id}"),
    }
}

fn known_entities(
    snapshot: &ConsolidationSnapshot,
    draft: &ConsolidationDraft,
) -> BTreeSet<EntityId> {
    snapshot
        .entities
        .iter()
        .map(|entity| entity.id.clone())
        .chain(draft.entities.iter().map(|entity| entity.id.clone()))
        .collect()
}

fn folder_for(scope: &EntityScope) -> Result<VaultPath, DreamError> {
    let raw = match scope {
        EntityScope::World => "world/entities/index".to_owned(),
        EntityScope::Agent { agent_id } => format!("agents/{agent_id}/entities/index"),
    };
    VaultPath::parse(&raw).map_err(|_error| DreamError::InvalidSlug)
}
