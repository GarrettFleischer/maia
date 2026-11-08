//! Honest consolidation schema parse. References against the brain are checked later.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use crate::brain::ClaimId;
use crate::brain::EpisodeId;
use crate::brain::FactId;
use crate::dream::error::DreamError;
use crate::dream::json::Json;
use crate::dream::json::has_tool_channel;
use crate::dream::json::parse_json;
use crate::dream::prepass::EntityId;
use crate::dream::prepass::SubjectKey;
use crate::dream::sentence::validate_sentence;

/// Entity scope tagged union.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum EntityScope {
    /// Shared world entity.
    World,
    /// Private to one existing participant.
    Agent {
        /// Participant id supplied by the caller.
        agent_id: String,
    },
}

/// Entity object accepted by the schema parser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityDraft {
    /// Entity id.
    pub id: EntityId,
    /// Path slug.
    pub slug: String,
    /// Single-line description.
    pub description: String,
    /// World or agent scope.
    pub scope: EntityScope,
    /// Related entity ids.
    pub see: Vec<EntityId>,
}

/// Canonical fact object accepted by the schema parser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactDraft {
    /// New fact id.
    pub id: FactId,
    /// Entity the fact belongs to.
    pub entity_id: EntityId,
    /// Declarative sentence.
    pub sentence: String,
    /// Provisional claims this fact consolidates.
    pub claim_ids: Vec<ClaimId>,
    /// Source episodes. Inspection only for taint.
    pub episode_ids: Vec<EpisodeId>,
    /// Optional inspection origin. It cannot lower taint.
    pub origin: Option<String>,
}

/// Merge object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeDraft {
    /// Fact that becomes noncanonical.
    pub duplicate_fact_id: FactId,
    /// Fact that remains canonical.
    pub canonical_fact_id: FactId,
}

/// Replacement link on a closure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplacementRef {
    /// Retraction without a successor.
    None,
    /// Successor fact.
    Fact(FactId),
}

/// Closure object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosureDraft {
    /// Fact whose validity ends.
    pub fact_id: FactId,
    /// Successor, or none for a retraction.
    pub replacement: ReplacementRef,
}

/// Dismissal object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DismissalDraft {
    /// Fact that stays current.
    pub existing_fact_id: FactId,
    /// Episode in the candidate key.
    pub episode_id: EpisodeId,
    /// Pre-pass subject key.
    pub subject_key: SubjectKey,
    /// Inspection reason.
    pub reason: String,
}

/// One parsed consolidation response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsolidationDraft {
    /// Entities.
    pub entities: Vec<EntityDraft>,
    /// Canonical facts.
    pub canonical_facts: Vec<FactDraft>,
    /// Merges.
    pub merges: Vec<MergeDraft>,
    /// Closures.
    pub closures: Vec<ClosureDraft>,
    /// Dismissals.
    pub dismissals: Vec<DismissalDraft>,
}

/// Parses one consolidation response. Unknown fields and tool channels fail the batch.
pub fn parse_consolidation(response: &str) -> Result<ConsolidationDraft, DreamError> {
    let value = parse_json(response).ok_or(DreamError::Malformed)?;
    if has_tool_channel(&value) {
        return Err(DreamError::ToolChannel);
    }
    let Json::Object(map) = value else {
        return Err(DreamError::InvalidType);
    };
    require_only(
        &map,
        &[
            "canonical_facts",
            "closures",
            "dismissals",
            "entities",
            "merges",
        ],
    )?;
    let draft = ConsolidationDraft {
        entities: parse_entities(required(&map, "entities")?)?,
        canonical_facts: parse_facts(required(&map, "canonical_facts")?)?,
        merges: parse_merges(required(&map, "merges")?)?,
        closures: parse_closures(required(&map, "closures")?)?,
        dismissals: parse_dismissals(required(&map, "dismissals")?)?,
    };
    reject_contradictions(&draft)?;
    Ok(draft)
}

fn parse_entities(value: &Json) -> Result<Vec<EntityDraft>, DreamError> {
    let items = array(value)?;
    let mut entities = Vec::with_capacity(items.len());
    let mut seen = BTreeSet::new();
    for item in items {
        let entity = parse_entity(item)?;
        if !seen.insert(entity.id.clone()) {
            return Err(DreamError::DuplicateId);
        }
        entities.push(entity);
    }
    Ok(entities)
}

fn parse_entity(value: &Json) -> Result<EntityDraft, DreamError> {
    let map = object(value)?;
    require_only(map, &["description", "id", "scope", "see", "slug"])?;
    let id = nonempty_id(req_string(map, "id")?)?;
    let slug = req_string(map, "slug")?;
    if !valid_slug(slug) {
        return Err(DreamError::InvalidSlug);
    }
    let description = req_string(map, "description")?;
    if !valid_description(description) {
        return Err(DreamError::InvalidDescription);
    }
    Ok(EntityDraft {
        id: EntityId::new(id),
        slug: slug.to_owned(),
        description: description.to_owned(),
        scope: parse_scope(required(map, "scope")?)?,
        see: parse_id_list(required(map, "see")?, EntityId::new)?,
    })
}

fn parse_scope(value: &Json) -> Result<EntityScope, DreamError> {
    let map = object(value)?;
    let kind = match map.get("kind") {
        Some(Json::String(kind)) => kind.as_str(),
        Some(_) => return Err(DreamError::InvalidScope),
        None => return Err(DreamError::InvalidScope),
    };
    match kind {
        "world" => {
            require_only(map, &["kind"]).map_err(|_| DreamError::InvalidScope)?;
            Ok(EntityScope::World)
        }
        "agent" => {
            require_only(map, &["agent_id", "kind"]).map_err(|_| DreamError::InvalidScope)?;
            let agent_id = match map.get("agent_id") {
                Some(Json::String(agent_id)) if !agent_id.is_empty() => agent_id.clone(),
                Some(Json::String(_)) => return Err(DreamError::EmptyId),
                _ => return Err(DreamError::InvalidScope),
            };
            Ok(EntityScope::Agent { agent_id })
        }
        _ => Err(DreamError::InvalidScope),
    }
}

fn parse_facts(value: &Json) -> Result<Vec<FactDraft>, DreamError> {
    let items = array(value)?;
    let mut facts = Vec::with_capacity(items.len());
    let mut seen = BTreeSet::new();
    for item in items {
        let fact = parse_fact(item)?;
        if !seen.insert(fact.id.clone()) {
            return Err(DreamError::DuplicateId);
        }
        facts.push(fact);
    }
    Ok(facts)
}

fn parse_fact(value: &Json) -> Result<FactDraft, DreamError> {
    let map = object(value)?;
    require_only(
        map,
        &[
            "claim_ids",
            "entity_id",
            "episode_ids",
            "id",
            "origin",
            "sentence",
        ],
    )?;
    let id = nonempty_id(req_string(map, "id")?)?;
    let entity_id = nonempty_id(req_string(map, "entity_id")?)?;
    let sentence = req_string(map, "sentence")?;
    validate_sentence(sentence).map_err(DreamError::InvalidSentence)?;
    let claim_ids = parse_id_list(required(map, "claim_ids")?, ClaimId::new)?;
    let episode_ids = parse_id_list(required(map, "episode_ids")?, EpisodeId::new)?;
    if episode_ids.is_empty() || has_duplicates(episode_ids.iter()) {
        return Err(DreamError::InvalidProvenance);
    }
    if has_duplicates(claim_ids.iter()) {
        return Err(DreamError::DuplicateId);
    }
    let origin = match map.get("origin") {
        None => None,
        Some(Json::String(origin)) => Some(origin.clone()),
        Some(_) => return Err(DreamError::InvalidType),
    };
    Ok(FactDraft {
        id: FactId::new(id),
        entity_id: EntityId::new(entity_id),
        sentence: sentence.to_owned(),
        claim_ids,
        episode_ids,
        origin,
    })
}

fn parse_merges(value: &Json) -> Result<Vec<MergeDraft>, DreamError> {
    let items = array(value)?;
    let mut merges = Vec::with_capacity(items.len());
    for item in items {
        let map = object(item)?;
        require_only(map, &["canonical_fact_id", "duplicate_fact_id"])?;
        merges.push(MergeDraft {
            duplicate_fact_id: FactId::new(nonempty_id(req_string(map, "duplicate_fact_id")?)?),
            canonical_fact_id: FactId::new(nonempty_id(req_string(map, "canonical_fact_id")?)?),
        });
    }
    Ok(merges)
}

fn parse_closures(value: &Json) -> Result<Vec<ClosureDraft>, DreamError> {
    let items = array(value)?;
    let mut closures = Vec::with_capacity(items.len());
    for item in items {
        let map = object(item)?;
        require_only(map, &["fact_id", "replacement_fact_id"])?;
        let fact_id = FactId::new(nonempty_id(req_string(map, "fact_id")?)?);
        let replacement = match required(map, "replacement_fact_id")? {
            Json::Null => ReplacementRef::None,
            Json::String(id) => ReplacementRef::Fact(FactId::new(nonempty_id(id)?)),
            _ => return Err(DreamError::InvalidType),
        };
        closures.push(ClosureDraft {
            fact_id,
            replacement,
        });
    }
    Ok(closures)
}

fn parse_dismissals(value: &Json) -> Result<Vec<DismissalDraft>, DreamError> {
    let items = array(value)?;
    let mut dismissals = Vec::with_capacity(items.len());
    for item in items {
        let map = object(item)?;
        require_only(
            map,
            &["episode_id", "existing_fact_id", "reason", "subject_key"],
        )?;
        let reason = req_string(map, "reason")?;
        if reason.is_empty() {
            return Err(DreamError::InvalidType);
        }
        dismissals.push(DismissalDraft {
            existing_fact_id: FactId::new(nonempty_id(req_string(map, "existing_fact_id")?)?),
            episode_id: EpisodeId::new(nonempty_id(req_string(map, "episode_id")?)?),
            subject_key: SubjectKey::new(req_string(map, "subject_key")?),
            reason: reason.to_owned(),
        });
    }
    Ok(dismissals)
}

fn reject_contradictions(draft: &ConsolidationDraft) -> Result<(), DreamError> {
    let mut merged = BTreeSet::new();
    for merge in &draft.merges {
        if merge.duplicate_fact_id == merge.canonical_fact_id
            || !merged.insert(merge.duplicate_fact_id.clone())
        {
            return Err(DreamError::ContradictoryOperation);
        }
    }
    let mut closed = BTreeSet::new();
    for closure in &draft.closures {
        if !closed.insert(closure.fact_id.clone()) {
            return Err(DreamError::ContradictoryOperation);
        }
        if merged.contains(&closure.fact_id) {
            return Err(DreamError::ContradictoryOperation);
        }
        if let ReplacementRef::Fact(replacement) = &closure.replacement {
            if replacement == &closure.fact_id {
                return Err(DreamError::ContradictoryOperation);
            }
        }
    }
    let mut dismissed = BTreeSet::new();
    for dismissal in &draft.dismissals {
        let key = (
            dismissal.existing_fact_id.clone(),
            dismissal.episode_id.clone(),
            dismissal.subject_key.clone(),
        );
        if !dismissed.insert(key) {
            return Err(DreamError::ContradictoryOperation);
        }
    }
    Ok(())
}

fn parse_id_list<T>(value: &Json, new_id: impl Fn(String) -> T) -> Result<Vec<T>, DreamError>
where
    T: Clone + Ord,
{
    let items = array(value)?;
    let mut ids = Vec::with_capacity(items.len());
    let mut seen = BTreeSet::new();
    for item in items {
        let Json::String(id) = item else {
            return Err(DreamError::InvalidType);
        };
        let id = nonempty_id(id)?;
        let typed = new_id(id.to_owned());
        if !seen.insert(typed.clone()) {
            return Err(DreamError::DuplicateId);
        }
        ids.push(typed);
    }
    Ok(ids)
}

fn has_duplicates<T: Ord>(items: impl Iterator<Item = T>) -> bool {
    let mut seen = BTreeSet::new();
    for item in items {
        if !seen.insert(item) {
            return true;
        }
    }
    false
}

fn valid_slug(slug: &str) -> bool {
    let mut parts = slug.split('-');
    match parts.next() {
        Some(part) if part_ok(part) => parts.all(part_ok),
        _ => false,
    }
}

fn part_ok(part: &str) -> bool {
    !part.is_empty()
        && part
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn valid_description(description: &str) -> bool {
    !description.is_empty()
        && !description.contains(['\n', '\r'])
        && description != ">"
        && description != "|"
}

fn nonempty_id(id: &str) -> Result<&str, DreamError> {
    if id.is_empty() {
        Err(DreamError::EmptyId)
    } else {
        Ok(id)
    }
}

fn require_only(map: &BTreeMap<String, Json>, allowed: &[&str]) -> Result<(), DreamError> {
    if map.keys().any(|key| !allowed.contains(&key.as_str())) {
        Err(DreamError::UnknownField)
    } else {
        Ok(())
    }
}

fn required<'a>(map: &'a BTreeMap<String, Json>, key: &str) -> Result<&'a Json, DreamError> {
    map.get(key).ok_or(DreamError::MissingField)
}

fn req_string<'a>(map: &'a BTreeMap<String, Json>, key: &str) -> Result<&'a str, DreamError> {
    match required(map, key)? {
        Json::String(value) => Ok(value.as_str()),
        _ => Err(DreamError::InvalidType),
    }
}

fn object(value: &Json) -> Result<&BTreeMap<String, Json>, DreamError> {
    match value {
        Json::Object(map) => Ok(map),
        _ => Err(DreamError::InvalidType),
    }
}

fn array(value: &Json) -> Result<&[Json], DreamError> {
    match value {
        Json::Array(items) => Ok(items.as_slice()),
        _ => Err(DreamError::InvalidType),
    }
}
