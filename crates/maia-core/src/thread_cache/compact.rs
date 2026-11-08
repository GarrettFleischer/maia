//! Model-free compaction decisions. Token costs and distances are caller inputs.

use std::collections::BTreeSet;

use crate::audit::Timestamp;
use crate::brain::MemoryRef;
use crate::brain::SlotId;
use crate::security::Taint;
use crate::thread_cache::types::{
    FrozenMemory, MemoryBody, ProvenanceLabel, ReplayedThread, SectionInput, SlotKind, section_of,
};

/// Documented default for consecutive turns over the centroid threshold.
pub const DEFAULT_CONSECUTIVE_TURNS: u32 = 2;
/// Documented default centroid window.
pub const DEFAULT_CENTROID_WINDOW: u32 = 8;
/// Documented default unused-slot window.
pub const DEFAULT_UNUSED_TURN_WINDOW: u32 = 6;
/// Documented default turns between compactions.
pub const DEFAULT_MIN_INTERVAL_TURNS: u32 = 3;

/// Explicit compaction thresholds. None of these are read from configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionPolicy {
    /// Mean cosine distance must be strictly greater than this.
    pub centroid_distance_threshold: f64,
    /// Consecutive turns that must exceed the threshold.
    pub consecutive_turns: u32,
    /// How many recent per-turn means are visible.
    pub centroid_window: u32,
    /// Turns without a use-hit before an installed note is unused.
    pub unused_slot_turn_window: u32,
    /// Turns required since the previous compaction.
    pub min_interval_turns: u32,
    /// Memory notes plus the compacted block must fit in this token budget.
    pub memory_budget_tokens: u32,
    /// Transcript token budget. Exceeding it is unfixable.
    pub transcript_budget_tokens: u32,
    /// Minimum heat kept. Equality keeps the slot.
    pub slot_heat_floor: f64,
}

/// One slot visible to compaction. Transcript slots are ignored as inputs.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionSlot {
    /// Stable id.
    pub id: SlotId,
    /// Slot kind.
    pub kind: SlotKind,
    /// Canonical text copied into the regrouped body when this slot survives.
    pub canonical_text: String,
    /// Ledger heat. Compilation does not update it.
    pub heat: f64,
    /// Install time supplied by the caller.
    pub installed_at: Timestamp,
    /// Caller-supplied token cost.
    pub token_cost: u32,
    /// Turns since the last use-hit, supplied by the caller.
    pub turns_since_use: u32,
}

/// Compaction inputs for one thread at one explicit moment.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionState {
    /// Turns since the last compaction record.
    pub turns_since_compaction: u32,
    /// Per-turn mean cosine distances, oldest first.
    pub recent_mean_distances: Vec<f64>,
    /// Current slots, including transcript slots that must not be rewritten.
    pub slots: Vec<CompactionSlot>,
    /// Caller-supplied transcript token total.
    pub transcript_tokens: u32,
}

/// Which locked trigger fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionTrigger {
    /// Centroid drift held for the required consecutive turns.
    CentroidDrift,
    /// An installed memory note has no recent use-hit.
    UnusedInstalledMemory,
    /// Installed memory plus the compacted block exceed the memory budget.
    MemoryBudget,
}

/// Why compaction must not rewrite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnfixableReason {
    /// Transcript alone exceeds its budget.
    TranscriptOverBudget,
    /// No eligible memory slot fits the memory budget.
    NothingFits,
}

/// Decision returned by [`should_compact`].
#[derive(Debug, Clone, PartialEq)]
pub enum CompactionDecision {
    /// No trigger fired.
    Hold,
    /// A trigger fired before the minimum interval elapsed.
    IntervalNotElapsed {
        /// Turns since the previous compaction.
        turns_since: u32,
        /// Policy interval.
        required: u32,
    },
    /// One or more triggers fired, in stable trigger order.
    Triggered {
        /// Fired triggers.
        triggers: Vec<CompactionTrigger>,
    },
    /// Compaction must not rewrite.
    Unfixable {
        /// Why.
        reason: UnfixableReason,
    },
    /// A threshold, distance, or heat was not finite, or a window was zero.
    InvalidPolicy,
}

/// Durable regrouping of memory slots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionRecord {
    /// Survivors in stable id order.
    pub survivors: Vec<SlotId>,
    /// Eligible memory slots that were not kept, in stable id order.
    pub removed: Vec<SlotId>,
    /// Canonical memory-block body. Empty when nothing survived.
    pub canonical_body: String,
    /// Triggers copied from the decision.
    pub triggers: Vec<CompactionTrigger>,
}

/// Compaction failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionError {
    /// The decision does not authorize a rewrite.
    DecisionNotActionable,
    /// The decision or the pack refused to rewrite.
    Unfixable(UnfixableReason),
    /// Token costs overflowed `u32`.
    TokenOverflow,
    /// A survivor or removed id is fixed prefix or transcript material.
    RefusedTranscriptRewrite,
    /// A survivor or removed id is not memory material on this log.
    UnknownSurvivor,
    /// An untrusted survivor has no provenance label.
    MissingSurvivorLabel,
    /// Vectors differ in length.
    DimensionMismatch,
    /// A vector has no direction.
    ZeroVector,
    /// A component was NaN or infinite.
    NonFinite,
    /// The point list was empty.
    EmptyPoints,
}

/// Mean cosine distance of `points` from `centroid`.
///
/// Distance is `1 - cosine_similarity`.
pub fn mean_cosine_distance(centroid: &[f64], points: &[Vec<f64>]) -> Result<f64, CompactionError> {
    if points.is_empty() {
        return Err(CompactionError::EmptyPoints);
    }
    let mut total = 0.0;
    for point in points {
        total += cosine_distance(centroid, point)?;
    }
    Ok(total / points.len() as f64)
}

/// Reports which compaction trigger fired. It does not rewrite slots.
#[must_use]
pub fn should_compact(state: &CompactionState, policy: &CompactionPolicy) -> CompactionDecision {
    if !policy_sane(policy) {
        return CompactionDecision::InvalidPolicy;
    }
    if state
        .recent_mean_distances
        .iter()
        .any(|distance| !distance.is_finite())
    {
        return CompactionDecision::InvalidPolicy;
    }
    for slot in &state.slots {
        if is_memory(slot.kind) && !slot.heat.is_finite() {
            return CompactionDecision::InvalidPolicy;
        }
    }
    if state.transcript_tokens > policy.transcript_budget_tokens {
        return CompactionDecision::Unfixable {
            reason: UnfixableReason::TranscriptOverBudget,
        };
    }
    let Some(memory_tokens) = memory_tokens(state) else {
        return CompactionDecision::InvalidPolicy;
    };
    let mut triggers = Vec::new();
    if centroid_fired(state, policy) {
        triggers.push(CompactionTrigger::CentroidDrift);
    }
    if unused_fired(state, policy) {
        triggers.push(CompactionTrigger::UnusedInstalledMemory);
    }
    if memory_tokens > policy.memory_budget_tokens {
        triggers.push(CompactionTrigger::MemoryBudget);
    }
    if triggers.is_empty() {
        return CompactionDecision::Hold;
    }
    if state.turns_since_compaction < policy.min_interval_turns {
        return CompactionDecision::IntervalNotElapsed {
            turns_since: state.turns_since_compaction,
            required: policy.min_interval_turns,
        };
    }
    CompactionDecision::Triggered { triggers }
}

/// Chooses survivors and regroups their canonical text by stable id.
pub fn compact(
    slots: &[CompactionSlot],
    decision: &CompactionDecision,
    policy: &CompactionPolicy,
) -> Result<CompactionRecord, CompactionError> {
    let triggers = match decision {
        CompactionDecision::Triggered { triggers } => triggers.clone(),
        CompactionDecision::Unfixable { reason } => {
            return Err(CompactionError::Unfixable(*reason));
        }
        CompactionDecision::Hold
        | CompactionDecision::IntervalNotElapsed { .. }
        | CompactionDecision::InvalidPolicy => {
            return Err(CompactionError::DecisionNotActionable);
        }
    };
    let mut eligible = Vec::new();
    for slot in slots {
        if is_memory(slot.kind) {
            if !slot.heat.is_finite() {
                return Err(CompactionError::NonFinite);
            }
            eligible.push(slot);
        }
    }
    let mut hot = Vec::new();
    for slot in &eligible {
        if slot.heat >= policy.slot_heat_floor {
            hot.push(*slot);
        }
    }
    hot.sort_by(|left, right| {
        right
            .heat
            .total_cmp(&left.heat)
            .then(right.installed_at.cmp(&left.installed_at))
            .then(left.id.cmp(&right.id))
    });
    let mut packed = Vec::new();
    let mut used = 0_u32;
    for slot in hot {
        let Some(next) = used.checked_add(slot.token_cost) else {
            return Err(CompactionError::TokenOverflow);
        };
        if next <= policy.memory_budget_tokens {
            used = next;
            packed.push(slot);
        }
    }
    if packed.is_empty()
        && eligible
            .iter()
            .any(|slot| slot.heat >= policy.slot_heat_floor)
    {
        return Err(CompactionError::Unfixable(UnfixableReason::NothingFits));
    }
    let mut survivors: Vec<&CompactionSlot> = packed;
    survivors.sort_by(|left, right| left.id.cmp(&right.id));
    let survivor_ids: BTreeSet<&SlotId> = survivors.iter().map(|slot| &slot.id).collect();
    let mut removed = Vec::new();
    for slot in &eligible {
        if !survivor_ids.contains(&slot.id) {
            removed.push(slot.id.clone());
        }
    }
    removed.sort();
    let mut canonical_body = String::new();
    for slot in &survivors {
        canonical_body.push_str(&slot.canonical_text);
        if !slot.canonical_text.is_empty() && !slot.canonical_text.ends_with('\n') {
            canonical_body.push('\n');
        }
    }
    Ok(CompactionRecord {
        survivors: survivors.into_iter().map(|slot| slot.id.clone()).collect(),
        removed,
        canonical_body,
        triggers,
    })
}

/// Returns a new replay value with the compaction record applied.
///
/// The input log is not modified. A refusal leaves the caller holding the previous value.
pub fn apply_compaction(
    log: &ReplayedThread,
    record: &CompactionRecord,
) -> Result<ReplayedThread, CompactionError> {
    let memory_id = section_of(&log.memory).id.clone();
    let mut protected = BTreeSet::new();
    protected.insert(log.tools.id.clone());
    protected.insert(log.agents.id.clone());
    protected.insert(log.current_user.id.clone());
    for persona in &log.personas {
        protected.insert(persona.section.id.clone());
    }
    for turn in &log.turns {
        protected.insert(turn.id.clone());
    }
    let note_ids: BTreeSet<SlotId> = log.notes.iter().map(|note| note.id.clone()).collect();
    for id in record.survivors.iter().chain(record.removed.iter()) {
        if protected.contains(id) {
            return Err(CompactionError::RefusedTranscriptRewrite);
        }
        if *id != memory_id && !note_ids.contains(id) {
            return Err(CompactionError::UnknownSurvivor);
        }
    }
    let mut installed = Vec::new();
    if !record.removed.iter().any(|id| id == &memory_id) {
        if let MemoryBody::Frozen(frozen) = &log.memory {
            installed.extend(frozen.installed.iter().cloned());
        }
    }
    let survivor_ids: BTreeSet<&SlotId> = record.survivors.iter().collect();
    for note in &log.notes {
        if survivor_ids.contains(&note.id) {
            push_memory(&mut installed, note.memory.as_ref());
        }
    }
    let mut next = log.clone();
    let folded: BTreeSet<&SlotId> = record
        .survivors
        .iter()
        .chain(record.removed.iter())
        .collect();
    next.notes.retain(|note| !folded.contains(&note.id));
    let previous = section_of(&log.memory);
    let (taint, label) = joined_survivor_provenance(log, &survivor_ids, &memory_id)?;
    next.memory = MemoryBody::Frozen(FrozenMemory {
        section: SectionInput {
            id: previous.id.clone(),
            body: record.canonical_body.clone(),
            taint,
            label,
            version: previous.version,
        },
        installed,
    });
    Ok(next)
}

fn joined_survivor_provenance(
    log: &ReplayedThread,
    survivors: &BTreeSet<&SlotId>,
    memory_id: &SlotId,
) -> Result<(Taint, Option<ProvenanceLabel>), CompactionError> {
    let mut taint = Taint::Trusted;
    let mut labels = Vec::new();
    if survivors.contains(memory_id) {
        let section = section_of(&log.memory);
        absorb_provenance(section.taint, section.label, &mut taint, &mut labels)?;
    }
    for note in &log.notes {
        if survivors.contains(&note.id) {
            absorb_provenance(note.taint, note.label, &mut taint, &mut labels)?;
        }
    }
    let label = match taint {
        Taint::Trusted => None,
        Taint::Untrusted => match labels.as_slice() {
            [label] => Some(*label),
            [] => return Err(CompactionError::MissingSurvivorLabel),
            _ => Some(ProvenanceLabel::Join),
        },
    };
    Ok((taint, label))
}

fn absorb_provenance(
    part_taint: Taint,
    part_label: Option<ProvenanceLabel>,
    taint: &mut Taint,
    labels: &mut Vec<ProvenanceLabel>,
) -> Result<(), CompactionError> {
    if part_taint > *taint {
        *taint = part_taint;
    }
    if part_taint != Taint::Untrusted {
        return Ok(());
    }
    let Some(part_label) = part_label else {
        return Err(CompactionError::MissingSurvivorLabel);
    };
    if !labels.contains(&part_label) {
        labels.push(part_label);
    }
    Ok(())
}

fn push_memory(installed: &mut Vec<MemoryRef>, memory: Option<&MemoryRef>) {
    if let Some(memory) = memory {
        installed.push(memory.clone());
    }
}

fn cosine_distance(left: &[f64], right: &[f64]) -> Result<f64, CompactionError> {
    if left.len() != right.len() || left.is_empty() {
        return Err(CompactionError::DimensionMismatch);
    }
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for (left_value, right_value) in left.iter().zip(right.iter()) {
        if !left_value.is_finite() || !right_value.is_finite() {
            return Err(CompactionError::NonFinite);
        }
        dot += left_value * right_value;
        left_norm += left_value * left_value;
        right_norm += right_value * right_value;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        return Err(CompactionError::ZeroVector);
    }
    let cosine = dot / (left_norm.sqrt() * right_norm.sqrt());
    Ok(1.0 - cosine)
}

fn policy_sane(policy: &CompactionPolicy) -> bool {
    policy.centroid_distance_threshold.is_finite()
        && policy.slot_heat_floor.is_finite()
        && policy.consecutive_turns > 0
        && policy.centroid_window > 0
}

fn is_memory(kind: SlotKind) -> bool {
    matches!(kind, SlotKind::MemoryNote | SlotKind::CompactedMemory)
}

fn memory_tokens(state: &CompactionState) -> Option<u32> {
    let mut total = 0_u32;
    for slot in &state.slots {
        if is_memory(slot.kind) {
            total = total.checked_add(slot.token_cost)?;
        }
    }
    Some(total)
}

fn centroid_fired(state: &CompactionState, policy: &CompactionPolicy) -> bool {
    let window = policy.centroid_window as usize;
    let distances = &state.recent_mean_distances;
    let start = distances.len().saturating_sub(window);
    let windowed = &distances[start..];
    let need = policy.consecutive_turns as usize;
    if windowed.len() < need {
        return false;
    }
    let tail = &windowed[windowed.len() - need..];
    tail.iter()
        .all(|distance| *distance > policy.centroid_distance_threshold)
}

fn unused_fired(state: &CompactionState, policy: &CompactionPolicy) -> bool {
    state
        .slots
        .iter()
        .any(|slot| is_memory(slot.kind) && slot.turns_since_use >= policy.unused_slot_turn_window)
}
