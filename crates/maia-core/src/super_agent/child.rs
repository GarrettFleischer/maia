//! Child narrowing and the router's empty execution-grant proof.

use std::collections::BTreeSet;

use crate::security::SecurityProfile;

use super::types::{
    BudgetCeiling, ChildAssignment, ChildAssignmentDraft, ChildPolicy, CriterionSource, GrantKey,
    NarrowError, SessionRole, SourcedSlice, TaskEnvelope,
};

/// Proves this leaf admits no execution grants.
///
/// Every [`SessionRole`] and [`SecurityProfile`] returns an empty set.
/// `Unrestricted` does not add router grants. Parent and child catalogs stay
/// with security admission; callers pass those grants to [`narrow_child`].
pub fn execution_tools(role: &SessionRole, profile: SecurityProfile) -> BTreeSet<GrantKey> {
    match role {
        SessionRole::Router => empty_grants(profile),
        SessionRole::ParentTask { .. } => empty_grants(profile),
        SessionRole::ChildTask { .. } => empty_grants(profile),
    }
}

/// Returns no grants for one security profile.
fn empty_grants(profile: SecurityProfile) -> BTreeSet<GrantKey> {
    match profile {
        SecurityProfile::Protected => BTreeSet::new(),
        SecurityProfile::Allowlisted => BTreeSet::new(),
        SecurityProfile::Unrestricted => BTreeSet::new(),
    }
}

/// Admits a child that preserves or tightens its parent's sourced scope.
///
/// The first failing check wins, in this order:
/// 1. `draft.parent` equals `parent_envelope.task` ([`NarrowError::ParentMismatch`]).
/// 2. `depth` is at most `policy.max_depth` ([`NarrowError::DepthExceeded`]).
/// 3. The subgoal, then each envelope slice in index order, cites sealed bytes
///    ([`NarrowError::SliceMismatch`]).
/// 4. Every child grant is in `parent_grants` ([`NarrowError::GrantWidened`]).
/// 5. `router_tokens` and `tool_turns` are each at most the parent remainder
///    ([`NarrowError::BudgetWidened`]). Either field alone is enough to fail.
///
/// `parent_attempt` is not compared with `origin_attempt`. `context` is copied
/// and is not a slice source. The brief, assumptions, and question log are not
/// slice sources. Success clones `draft` without adding grants, budget, or slices.
pub fn narrow_child(
    parent_envelope: &TaskEnvelope,
    draft: &ChildAssignmentDraft,
    parent_grants: &BTreeSet<GrantKey>,
    parent_budget: BudgetCeiling,
    depth: u32,
    policy: &ChildPolicy,
) -> Result<ChildAssignment, NarrowError> {
    if draft.parent != parent_envelope.task {
        return Err(NarrowError::ParentMismatch);
    }
    if depth > policy.max_depth {
        return Err(NarrowError::DepthExceeded);
    }
    if !slice_matches(&draft.subgoal, parent_envelope)
        || draft
            .envelope_slices
            .iter()
            .any(|slice| !slice_matches(slice, parent_envelope))
    {
        return Err(NarrowError::SliceMismatch);
    }
    if !draft.ceiling.grants.is_subset(parent_grants) {
        return Err(NarrowError::GrantWidened);
    }
    if draft.budget.router_tokens > parent_budget.router_tokens
        || draft.budget.tool_turns > parent_budget.tool_turns
    {
        return Err(NarrowError::BudgetWidened);
    }
    Ok(ChildAssignment {
        child: draft.child.clone(),
        parent: draft.parent.clone(),
        parent_attempt: draft.parent_attempt.clone(),
        subgoal: draft.subgoal.clone(),
        envelope_slices: draft.envelope_slices.clone(),
        context: draft.context.clone(),
        ceiling: draft.ceiling.clone(),
        budget: draft.budget,
    })
}

/// Returns whether one slice cites bytes sealed on the envelope.
fn slice_matches(slice: &SourcedSlice, envelope: &TaskEnvelope) -> bool {
    match &slice.source {
        CriterionSource::UserText {
            message,
            start,
            end,
        } => {
            if message != &envelope.original_prompt.message {
                return false;
            }
            let Ok(start) = usize::try_from(*start) else {
                return false;
            };
            let Ok(end) = usize::try_from(*end) else {
                return false;
            };
            if start > end {
                return false;
            }
            envelope.original_prompt.utf8.get(start..end) == Some(slice.utf8.as_slice())
        }
        source @ (CriterionSource::BindingRule { .. }
        | CriterionSource::AcceptedDecision { .. }) => {
            envelope
                .criteria
                .iter()
                .any(|item| binding_matches(source, &slice.utf8, &item.source, &item.text))
                || envelope
                    .constraints
                    .iter()
                    .any(|item| binding_matches(source, &slice.utf8, &item.source, &item.text))
        }
    }
}

/// Returns whether a sealed item has the same source and exact text bytes.
fn binding_matches(
    source: &CriterionSource,
    utf8: &[u8],
    item_source: &CriterionSource,
    text: &str,
) -> bool {
    item_source == source && text.as_bytes() == utf8
}
