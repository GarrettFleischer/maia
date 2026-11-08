//! Structured allowlist entries.
//!
//! A match suppresses nothing by itself. Callers still apply grants, sinks,
//! egress, and containment. Time and daemon generation are parameters.

use crate::agents::AgentId;
use crate::audit::Timestamp;
use crate::security::matcher::{
    ActionMatcher, ActionMatcherSnapshot, CanonicalAllowAction, MatcherField, MatcherRestoreError,
    broaden_field, capability_compatible, exact_matcher, matcher_covers, restore_matcher,
    snapshot_matcher,
};
use crate::security::types::CapabilityKind;

/// Owner client that created an entry.
pub use crate::security::profile::OwnerClientId;

/// How long an allowlist entry may match.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GrantLifetime {
    /// Matches until revoked.
    Permanent,
    /// Matches while the injected clock is strictly before this instant.
    ExpiresAt(Timestamp),
    /// Matches only the daemon process generation that created the entry.
    DaemonLifetime {
        /// Daemon process generation.
        generation: DaemonGeneration,
    },
}

/// Daemon process generation. This is not an authenticated client session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DaemonGeneration(pub u64);

/// Identity of an allowlist row. This is not a capability [`crate::security::GrantId`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AllowlistEntryId(pub u64);

/// Whether the owner has enabled an entry. Independent of the active profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntryStatus {
    /// The entry may match.
    Enabled,
    /// The entry is stored and never matches.
    Disabled,
}

/// Why an allowlist edit was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AllowlistError {
    /// Capability does not belong to the matcher kind.
    IncompatibleCapability,
    /// The named field is not part of this matcher.
    BroadenTargetMismatch,
    /// A path platform disagrees with the matcher platform.
    PlatformMismatch,
    /// An exact field is not already in canonical form.
    NotCanonical,
    /// A typed snapshot field failed validation.
    InvalidSnapshotField(crate::security::matcher::ActionFieldError),
}

/// Explicit broaden request. Matching never broadens on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Broaden {
    /// Replace the capability with another compatible kind.
    Capability(CapabilityKind),
    /// Match any acting agent.
    AnyAgent,
    /// Replace the lifetime.
    Lifetime(GrantLifetime),
    /// Set one typed field to any value.
    Field(MatcherField),
}

/// Inputs for an exact entry copied from one canonical action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowlistDraft {
    /// Allowlist row id. Not a capability grant.
    pub id: AllowlistEntryId,
    /// Capability the entry covers.
    pub capability: CapabilityKind,
    /// Canonical action to copy exactly.
    pub action: CanonicalAllowAction,
    /// Acting agent. Exact entries start scoped to this agent.
    pub agent: AgentId,
    /// When the entry may match.
    pub lifetime: GrantLifetime,
    /// Creation time supplied by the caller.
    pub created_at: Timestamp,
    /// Creating owner client.
    pub created_by: OwnerClientId,
}

/// Action and clock inputs for `match_allowlist`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowlistQuery {
    /// Capability being exercised.
    pub capability: CapabilityKind,
    /// Canonical action.
    pub action: CanonicalAllowAction,
    /// Acting agent.
    pub agent: AgentId,
    /// Injected clock.
    pub now: Timestamp,
    /// Current daemon process generation.
    pub daemon_generation: DaemonGeneration,
}

/// Acting-agent scope stored on an allowlist row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentScope {
    /// Only this acting agent.
    Only(AgentId),
    /// Any acting agent. Produced only by an explicit broaden.
    Any,
}

/// Read-only persistence view of one allowlist row.
///
/// Building a snapshot does not admit the row. [`try_restore_allowlist_entry`]
/// is the validation gate. Paths inside the matcher are lexical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowlistSnapshot {
    /// Allowlist row id. Not a capability grant.
    pub id: AllowlistEntryId,
    /// Capability the row covers.
    pub capability: CapabilityKind,
    /// Typed matcher, including exact and broadened fields.
    pub matcher: ActionMatcherSnapshot,
    /// Agent scope.
    pub agent: AgentScope,
    /// Lifetime.
    pub lifetime: GrantLifetime,
    /// Enabled state, independent of the active profile.
    pub status: EntryStatus,
    /// Creation time supplied by the caller.
    pub created_at: Timestamp,
    /// Creating owner.
    pub created_by: OwnerClientId,
}

/// One structured allowlist row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowlistEntry {
    id: AllowlistEntryId,
    capability: CapabilityKind,
    matcher: ActionMatcher,
    agent: AgentScope,
    lifetime: GrantLifetime,
    status: EntryStatus,
    created_at: Timestamp,
    created_by: OwnerClientId,
}

impl AllowlistEntry {
    /// Allowlist row id. Not a capability grant.
    pub fn id(&self) -> AllowlistEntryId {
        self.id
    }

    /// Acting-agent scope.
    pub fn agent_scope(&self) -> AgentScope {
        self.agent
    }

    /// Lossless view for persistence. Restoring it re-validates the row.
    pub fn snapshot(&self) -> AllowlistSnapshot {
        AllowlistSnapshot {
            id: self.id,
            capability: self.capability,
            matcher: snapshot_matcher(&self.matcher),
            agent: self.agent,
            lifetime: self.lifetime,
            status: self.status,
            created_at: self.created_at,
            created_by: self.created_by,
        }
    }

    /// Enabled or disabled. Profile changes do not rewrite this.
    pub fn status(&self) -> EntryStatus {
        self.status
    }

    /// Capability kind.
    pub fn capability(&self) -> CapabilityKind {
        self.capability
    }

    /// Lifetime stored on the entry.
    pub fn lifetime(&self) -> GrantLifetime {
        self.lifetime
    }

    /// Creation time.
    pub fn created_at(&self) -> Timestamp {
        self.created_at
    }

    /// Creating owner.
    pub fn created_by(&self) -> OwnerClientId {
        self.created_by
    }
}

/// Copies `draft.action` into an enabled exact entry scoped to `draft.agent`.
pub fn exact_allowlist_entry(draft: AllowlistDraft) -> Result<AllowlistEntry, AllowlistError> {
    let matcher = exact_matcher(&draft.action);
    if !capability_compatible(draft.capability, &matcher) {
        return Err(AllowlistError::IncompatibleCapability);
    }
    Ok(AllowlistEntry {
        id: draft.id,
        capability: draft.capability,
        matcher,
        agent: AgentScope::Only(draft.agent),
        lifetime: draft.lifetime,
        status: EntryStatus::Enabled,
        created_at: draft.created_at,
        created_by: draft.created_by,
    })
}

/// Returns a new entry with one explicit broaden applied.
pub fn broaden_allowlist_entry(
    entry: AllowlistEntry,
    broaden: Broaden,
) -> Result<AllowlistEntry, AllowlistError> {
    let AllowlistEntry {
        id,
        capability,
        matcher,
        agent,
        lifetime,
        status,
        created_at,
        created_by,
    } = entry;
    let (capability, matcher, agent, lifetime) = match broaden {
        Broaden::Capability(kind) => {
            if !capability_compatible(kind, &matcher) {
                return Err(AllowlistError::IncompatibleCapability);
            }
            (kind, matcher, agent, lifetime)
        }
        Broaden::AnyAgent => (capability, matcher, AgentScope::Any, lifetime),
        Broaden::Lifetime(lifetime) => (capability, matcher, agent, lifetime),
        Broaden::Field(field) => {
            let Some(matcher) = broaden_field(matcher, field) else {
                return Err(AllowlistError::BroadenTargetMismatch);
            };
            (capability, matcher, agent, lifetime)
        }
    };
    Ok(AllowlistEntry {
        id,
        capability,
        matcher,
        agent,
        lifetime,
        status,
        created_at,
        created_by,
    })
}

/// Replaces the enabled state and leaves the matcher unchanged.
pub fn with_entry_status(mut entry: AllowlistEntry, status: EntryStatus) -> AllowlistEntry {
    entry.status = status;
    entry
}

/// Validates `snapshot` and builds an entry. A snapshot is not itself a row.
pub fn try_restore_allowlist_entry(
    snapshot: AllowlistSnapshot,
) -> Result<AllowlistEntry, AllowlistError> {
    let matcher = restore_matcher(snapshot.matcher).map_err(allowlist_restore_error)?;
    if !capability_compatible(snapshot.capability, &matcher) {
        return Err(AllowlistError::IncompatibleCapability);
    }
    Ok(AllowlistEntry {
        id: snapshot.id,
        capability: snapshot.capability,
        matcher,
        agent: snapshot.agent,
        lifetime: snapshot.lifetime,
        status: snapshot.status,
        created_at: snapshot.created_at,
        created_by: snapshot.created_by,
    })
}

impl TryFrom<AllowlistSnapshot> for AllowlistEntry {
    type Error = AllowlistError;

    fn try_from(snapshot: AllowlistSnapshot) -> Result<Self, Self::Error> {
        try_restore_allowlist_entry(snapshot)
    }
}

fn allowlist_restore_error(error: MatcherRestoreError) -> AllowlistError {
    match error {
        MatcherRestoreError::InvalidField(error) => AllowlistError::InvalidSnapshotField(error),
        MatcherRestoreError::NotCanonical => AllowlistError::NotCanonical,
        MatcherRestoreError::PlatformMismatch => AllowlistError::PlatformMismatch,
    }
}

/// First enabled, unexpired, in-scope entry whose matcher covers the action.
///
/// `None` means the prompt is not suppressed. A hit does not grant capability.
pub fn match_allowlist(
    entries: &[AllowlistEntry],
    query: &AllowlistQuery,
) -> Option<AllowlistEntryId> {
    entries
        .iter()
        .find(|entry| entry_matches(entry, query))
        .map(|entry| entry.id)
}

fn entry_matches(entry: &AllowlistEntry, query: &AllowlistQuery) -> bool {
    entry.status == EntryStatus::Enabled
        && entry.capability == query.capability
        && agent_in_scope(entry.agent, query.agent)
        && lifetime_active(entry.lifetime, query.now, query.daemon_generation)
        && matcher_covers(&entry.matcher, &query.action)
}

fn agent_in_scope(scope: AgentScope, agent: AgentId) -> bool {
    match scope {
        AgentScope::Any => true,
        AgentScope::Only(expected) => expected == agent,
    }
}

fn lifetime_active(lifetime: GrantLifetime, now: Timestamp, generation: DaemonGeneration) -> bool {
    match lifetime {
        GrantLifetime::Permanent => true,
        // Same exclusive bound as `covering_grant`: `expiry` itself is already past.
        GrantLifetime::ExpiresAt(expiry) => expiry.0 > now.0,
        GrantLifetime::DaemonLifetime {
            generation: entry_generation,
        } => entry_generation == generation,
    }
}
