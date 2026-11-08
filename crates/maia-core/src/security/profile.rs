//! Global security profile selection and transitions.
//!
//! The profile is one enum. Callers pass the actor, confirmation, clock, and
//! active unsandboxed actions. This module does not read a clock, store, or client.

use crate::audit::Timestamp;

/// Global autonomy profile. One value, not a pair of independent switches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecurityProfile {
    /// Risky actions prompt. Containment stays on.
    Protected,
    /// A matching allowlist entry suppresses only the approval prompt.
    Allowlisted,
    /// Controllable Maia gates auto-allow and process containment is off.
    Unrestricted,
}

/// Authenticated owner client identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OwnerClientId(pub u64);

/// Tailnet user half of a paired remote identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TailnetUserId(pub u64);

/// Tailnet node half of a paired remote identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TailnetNodeId(pub u64);

/// Where an owner action came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClientClass {
    /// Local desktop window.
    DesktopWindow,
    /// Paired phone or other remote owner client.
    PairedPhone {
        /// Tailnet user.
        user: TailnetUserId,
        /// Tailnet node.
        node: TailnetNodeId,
    },
}

/// Owner identity used for profile changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct OwnerActor {
    /// Authenticated client id.
    pub id: OwnerClientId,
    /// Desktop or remote class.
    pub class: ClientClass,
}

/// Proof presented with a desktop confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PresenceProof {
    /// Session cookie only. Not enough for `Unrestricted`.
    SessionOnly,
    /// OS user verification such as Windows Hello.
    OsUserVerification,
}

/// Local desktop confirmation recorded when enabling `Unrestricted`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConfirmationRecord {
    /// When the desktop confirmation happened.
    pub confirmed_at: Timestamp,
    /// Desktop client that confirmed.
    pub desktop_client_id: OwnerClientId,
    /// How the owner proved presence.
    pub presence_proof: PresenceProof,
}

/// Explicit onboarding or transition choice. There is no implicit profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProfileSelection {
    /// Select `Protected`.
    Protected,
    /// Select `Allowlisted`.
    Allowlisted,
    /// Select `Unrestricted` with a desktop confirmation record.
    Unrestricted(ConfirmationRecord),
}

/// Why a profile selection was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProfileError {
    /// A remote owner tried to enable or reassert `Unrestricted`.
    RemoteEnableUnrestricted,
    /// A remote owner tried to move to a looser profile.
    RemoteLoosen,
    /// `Unrestricted` was requested without OS user verification.
    MissingOsVerification,
    /// The confirmation names a different desktop client.
    ConfirmationClientMismatch,
    /// The confirmation timestamp is after the injected clock.
    ConfirmationAfterNow,
}

/// Active unsandboxed action identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct UnsandboxedActionId(pub u64);

/// Whether external side effects of an unsandboxed action can be disproved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExternalEffectEvidence {
    /// External side effects were disproved.
    Disproved,
    /// External side effects cannot be disproved.
    NotDisproved,
}

/// Active unsandboxed action supplied by the caller when leaving `Unrestricted`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ActiveUnsandboxedAction {
    /// Action to cancel.
    pub id: UnsandboxedActionId,
    /// Classification input for the cancellation outcome.
    pub external_effects: ExternalEffectEvidence,
}

/// Outcome of cancelling one unsandboxed action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CancellationOutcome {
    /// Side effects were disproved, so cancellation is enough.
    Cancelled,
    /// Side effects cannot be disproved.
    UnknownOutcome,
}

/// Cancellation the daemon must perform, plus the classification input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CancellationRequirement {
    /// Action that must be cancelled.
    pub action_id: UnsandboxedActionId,
    /// Evidence the caller supplied. `NotDisproved` records `UnknownOutcome`.
    pub classification_input: ExternalEffectEvidence,
    /// Outcome class derived from that evidence.
    pub outcome: CancellationOutcome,
}

/// Singleton profile settings. Constructed only by selection or transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SecuritySettings {
    profile: SecurityProfile,
    activated_at: Timestamp,
    activated_by: OwnerClientId,
    local_unrestricted_confirmation: Option<ConfirmationRecord>,
}

impl SecuritySettings {
    /// Active profile.
    pub fn profile(self) -> SecurityProfile {
        self.profile
    }

    /// When the current profile became active.
    pub fn activated_at(self) -> Timestamp {
        self.activated_at
    }

    /// Owner client that activated the current profile.
    pub fn activated_by(self) -> OwnerClientId {
        self.activated_by
    }

    /// Desktop confirmation. Present only while `Unrestricted` is active.
    pub fn local_unrestricted_confirmation(&self) -> Option<&ConfirmationRecord> {
        self.local_unrestricted_confirmation.as_ref()
    }
}

/// Result of a successful profile transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileTransition {
    /// Settings after the transition.
    pub settings: SecuritySettings,
    /// Cancellations required because the profile left `Unrestricted`.
    pub cancellations: Vec<CancellationRequirement>,
}

/// Onboarding selection. The caller must name `Protected`, `Allowlisted`, or `Unrestricted`.
pub fn select_onboarding_profile(
    selection: ProfileSelection,
    actor: OwnerActor,
    now: Timestamp,
) -> Result<SecuritySettings, ProfileError> {
    match selection {
        ProfileSelection::Unrestricted(record) => {
            authorize_unrestricted(actor, &record, now)?;
            Ok(settings(
                SecurityProfile::Unrestricted,
                actor,
                now,
                Some(record),
            ))
        }
        ProfileSelection::Protected => Ok(settings(SecurityProfile::Protected, actor, now, None)),
        ProfileSelection::Allowlisted => {
            Ok(settings(SecurityProfile::Allowlisted, actor, now, None))
        }
    }
}

/// Changes the global profile.
///
/// Remote actors may only tighten. Enabling `Unrestricted` requires a local
/// desktop actor and a confirmation record. Leaving `Unrestricted` returns one
/// cancellation requirement per active unsandboxed action.
pub fn reduce_security_profile(
    current: &SecuritySettings,
    target: ProfileSelection,
    actor: OwnerActor,
    now: Timestamp,
    active_unsandboxed: &[ActiveUnsandboxedAction],
) -> Result<ProfileTransition, ProfileError> {
    if let ProfileSelection::Unrestricted(record) = target {
        return enable_unrestricted(current, record, actor, now);
    }
    let target_profile = profile_of(target);
    if !is_local_desktop(actor) && looseness(target_profile) > looseness(current.profile) {
        return Err(ProfileError::RemoteLoosen);
    }
    if target_profile == current.profile {
        return Ok(unchanged(current));
    }
    let cancellations = if current.profile == SecurityProfile::Unrestricted {
        cancellation_requirements(active_unsandboxed)
    } else {
        Vec::new()
    };
    Ok(ProfileTransition {
        settings: settings(target_profile, actor, now, None),
        cancellations,
    })
}

fn enable_unrestricted(
    current: &SecuritySettings,
    record: ConfirmationRecord,
    actor: OwnerActor,
    now: Timestamp,
) -> Result<ProfileTransition, ProfileError> {
    if !is_local_desktop(actor) {
        return Err(ProfileError::RemoteEnableUnrestricted);
    }
    if current.profile == SecurityProfile::Unrestricted {
        return Ok(unchanged(current));
    }
    authorize_unrestricted(actor, &record, now)?;
    Ok(ProfileTransition {
        settings: settings(SecurityProfile::Unrestricted, actor, now, Some(record)),
        cancellations: Vec::new(),
    })
}

fn authorize_unrestricted(
    actor: OwnerActor,
    record: &ConfirmationRecord,
    now: Timestamp,
) -> Result<(), ProfileError> {
    if !is_local_desktop(actor) {
        return Err(ProfileError::RemoteEnableUnrestricted);
    }
    if record.presence_proof != PresenceProof::OsUserVerification {
        return Err(ProfileError::MissingOsVerification);
    }
    if record.desktop_client_id != actor.id {
        return Err(ProfileError::ConfirmationClientMismatch);
    }
    if record.confirmed_at > now {
        return Err(ProfileError::ConfirmationAfterNow);
    }
    Ok(())
}

fn cancellation_requirements(actions: &[ActiveUnsandboxedAction]) -> Vec<CancellationRequirement> {
    actions.iter().copied().map(classify_cancellation).collect()
}

fn classify_cancellation(action: ActiveUnsandboxedAction) -> CancellationRequirement {
    let outcome = match action.external_effects {
        ExternalEffectEvidence::Disproved => CancellationOutcome::Cancelled,
        ExternalEffectEvidence::NotDisproved => CancellationOutcome::UnknownOutcome,
    };
    CancellationRequirement {
        action_id: action.id,
        classification_input: action.external_effects,
        outcome,
    }
}

fn unchanged(current: &SecuritySettings) -> ProfileTransition {
    ProfileTransition {
        settings: *current,
        cancellations: Vec::new(),
    }
}

fn settings(
    profile: SecurityProfile,
    actor: OwnerActor,
    now: Timestamp,
    confirmation: Option<ConfirmationRecord>,
) -> SecuritySettings {
    SecuritySettings {
        profile,
        activated_at: now,
        activated_by: actor.id,
        local_unrestricted_confirmation: confirmation,
    }
}

fn profile_of(selection: ProfileSelection) -> SecurityProfile {
    match selection {
        ProfileSelection::Protected => SecurityProfile::Protected,
        ProfileSelection::Allowlisted => SecurityProfile::Allowlisted,
        ProfileSelection::Unrestricted(_) => SecurityProfile::Unrestricted,
    }
}

fn looseness(profile: SecurityProfile) -> u8 {
    match profile {
        SecurityProfile::Protected => 0,
        SecurityProfile::Allowlisted => 1,
        SecurityProfile::Unrestricted => 2,
    }
}

fn is_local_desktop(actor: OwnerActor) -> bool {
    matches!(actor.class, ClientClass::DesktopWindow)
}
