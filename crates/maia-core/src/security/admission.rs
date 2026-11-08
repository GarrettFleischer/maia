//! Profile-aware admission plan.
//!
//! Allowlist matches and `Unrestricted` change prompt and controllable-gate
//! obligations only. Budget admission, the durable audit start, panic, Stop all,
//! audit verification, log redaction, and `DesktopConfirm` stay on the verdict.
//! Grant coverage reuses `covering_grant`. Sink and egress are not evaluated here.

use crate::agents::AgentId;
use crate::audit::Timestamp;
use crate::security::allowlist::{
    AllowlistEntry, AllowlistEntryId, AllowlistQuery, DaemonGeneration, match_allowlist,
};
use crate::security::grant_match::covering_grant;
use crate::security::matcher::CanonicalAllowAction;
use crate::security::profile::SecurityProfile;
use crate::security::types::{ApprovalTier, CapabilityGrant, CapabilityKind, GrantId, RunPresence};

/// Whether budget admission already passed. Admission does not measure spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BudgetGate {
    /// Budget admission returned a reservation.
    Admitted,
    /// Budget admission rejected the step.
    Rejected,
}

/// Policy class of a tool action before the profile is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolPolicy {
    /// A covering grant is enough while the owner is attending.
    Auto,
    /// Owner confirm is required unless an allowlist entry matches.
    Confirm,
    /// The action is forbidden for every profile.
    Forbidden,
}

/// External human requirement no profile can satisfy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExternalBlocker {
    /// Site or provider MFA.
    Mfa,
    /// CAPTCHA.
    Captcha,
    /// Legal consent.
    LegalConsent,
    /// Operating system consent.
    OsConsent,
    /// The selected credential backend is locked.
    LockedCredentialBackend,
    /// A required credential is missing.
    MissingCredential,
}

/// What is being admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionSubject {
    /// Tool execution under a capability.
    Tool {
        /// Capability passed to grant matching.
        capability: CapabilityKind,
        /// Canonical action passed to the allowlist.
        action: CanonicalAllowAction,
        /// Policy prompt class before the profile.
        policy: ToolPolicy,
        /// External blocker, when one is already known.
        external: Option<ExternalBlocker>,
    },
    /// Desktop administration. No profile suppresses it.
    DesktopConfirmAdministration,
}

/// Inputs for one admission decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmitAction<'a> {
    /// Active global profile.
    pub profile: SecurityProfile,
    /// Tool or desktop administration.
    pub subject: AdmissionSubject,
    /// Allowlist rows. Consulted only for `Allowlisted` tool actions.
    pub allowlist: &'a [AllowlistEntry],
    /// Capability grants. Coverage uses `covering_grant`.
    pub grants: &'a [CapabilityGrant],
    /// Attended or unattended run.
    pub presence: RunPresence,
    /// Injected clock.
    pub now: Timestamp,
    /// Current daemon process generation.
    pub daemon_generation: DaemonGeneration,
    /// Acting agent for allowlist scope.
    pub agent: AgentId,
    /// Result of budget admission.
    pub budget: BudgetGate,
}

/// How the Maia approval prompt is treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptDisposition {
    /// No Maia prompt is required for this action.
    NotRequired,
    /// The owner must approve at this tier.
    Required(ApprovalTier),
    /// The profile or an allowlist entry suppressed the Maia prompt.
    Suppressed(PromptSuppression),
}

/// Why a Maia prompt was suppressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PromptSuppression {
    /// This allowlist row matched. The id is not a capability grant.
    Allowlist(AllowlistEntryId),
    /// `Unrestricted` suppressed Maia prompts for this tool action.
    UnrestrictedProfile,
}

/// Whether grant matching still applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GrantObligation {
    /// The caller must keep the covering-grant result.
    Required(CoveringGrant),
    /// `Unrestricted` auto-allows the grant gate.
    AutoAllow,
}

/// Covering grant found by `covering_grant`, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CoveringGrant {
    /// A grant covers the capability, presence, and expiry.
    Found(GrantId),
    /// No covering grant.
    Missing,
}

/// Whether a controllable gate is enforced or auto-allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GateObligation {
    /// The caller still runs the check.
    Required,
    /// `Unrestricted` auto-allows this controllable gate.
    AutoAllow,
}

/// Process containment for this admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContainmentAdmission {
    /// Containment is required.
    Required,
    /// `Unrestricted` does not admit a process sandbox.
    Disabled,
}

/// Hard stop that no profile removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AdmissionBlocker {
    /// Budget admission failed.
    BudgetRejected,
    /// An external human requirement remains.
    NeedsHuman(ExternalBlocker),
    /// Desktop confirmation is still required.
    DesktopConfirmRequired,
    /// Policy forbids the action.
    Forbidden,
}

/// Marker that a non-bypassable control is still required.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RequiredControl;

/// Controls every profile must keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NonBypassable {
    /// Budget admission.
    pub budget_admission: RequiredControl,
    /// Durable audit start.
    pub durable_audit_start: RequiredControl,
    /// Panic.
    pub panic: RequiredControl,
    /// Stop all.
    pub stop_all: RequiredControl,
    /// Audit-chain verification.
    pub audit_verification: RequiredControl,
    /// Log redaction.
    pub log_redaction: RequiredControl,
    /// `DesktopConfirm` administration.
    pub desktop_confirm_administration: RequiredControl,
}

impl NonBypassable {
    /// All non-bypassable controls, required together.
    pub const fn all_required() -> Self {
        Self {
            budget_admission: RequiredControl,
            durable_audit_start: RequiredControl,
            panic: RequiredControl,
            stop_all: RequiredControl,
            audit_verification: RequiredControl,
            log_redaction: RequiredControl,
            desktop_confirm_administration: RequiredControl,
        }
    }
}

/// Admission plan. Gates exist only on [`AdmissionVerdict::Admitted`].
///
/// # Daemon handoff
///
/// This function does not execute anything. The future daemon skin must:
///
/// 1. pattern-match [`AdmissionVerdict::Blocked`] before reading any obligation;
/// 2. run every [`NonBypassable`] control on both variants;
/// 3. on [`AdmissionVerdict::Admitted`], execute that variant's grant, sink,
///    egress, presence, and containment obligations;
/// 4. apply profile-transition cancellations before the profile API reports success.
///
/// There is no in-tree consumer of that skin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionVerdict {
    /// Hard stop. Controllable gates are not represented.
    Blocked {
        /// Why execution must not proceed.
        blocker: AdmissionBlocker,
        /// Controls that still run.
        non_bypassable: NonBypassable,
    },
    /// Tool admission whose obligations are visible only in this variant.
    Admitted {
        /// Maia approval prompt.
        prompt: PromptDisposition,
        /// Capability grant obligation. An allowlist id is not this grant.
        grant: GrantObligation,
        /// Sink check obligation. This function does not call `check_sink`.
        sink: GateObligation,
        /// Egress check obligation. This function does not call `check_egress`.
        egress: GateObligation,
        /// Presence gate obligation.
        presence: GateObligation,
        /// Process containment obligation.
        containment: ContainmentAdmission,
        /// Controls that still run.
        non_bypassable: NonBypassable,
    },
}

/// Plans prompt suppression and which gates remain.
///
/// See [`AdmissionVerdict`] for the daemon handoff order.
pub fn admit_action(input: &AdmitAction<'_>) -> AdmissionVerdict {
    if matches!(
        input.subject,
        AdmissionSubject::DesktopConfirmAdministration
    ) {
        return desktop_verdict();
    }
    if input.budget == BudgetGate::Rejected {
        return blocked(AdmissionBlocker::BudgetRejected);
    }
    let AdmissionSubject::Tool {
        capability,
        action,
        policy,
        external,
    } = &input.subject
    else {
        return desktop_verdict();
    };
    if let Some(blocker) = external {
        return blocked(AdmissionBlocker::NeedsHuman(*blocker));
    }
    if *policy == ToolPolicy::Forbidden {
        return blocked(AdmissionBlocker::Forbidden);
    }
    if input.profile == SecurityProfile::Unrestricted {
        return unrestricted_verdict();
    }
    let covering = lookup_grant(input, *capability);
    let suppression = allowlist_hit(input, *capability, action);
    enforced_verdict(
        prompt_for(input.presence, *policy, covering, suppression),
        covering,
    )
}

fn lookup_grant(input: &AdmitAction<'_>, capability: CapabilityKind) -> CoveringGrant {
    match covering_grant(input.grants, capability, input.presence, input.now) {
        Some(grant) => CoveringGrant::Found(grant.id),
        None => CoveringGrant::Missing,
    }
}

fn allowlist_hit(
    input: &AdmitAction<'_>,
    capability: CapabilityKind,
    action: &CanonicalAllowAction,
) -> Option<AllowlistEntryId> {
    if input.profile != SecurityProfile::Allowlisted {
        return None;
    }
    match_allowlist(
        input.allowlist,
        &AllowlistQuery {
            capability,
            action: action.clone(),
            agent: input.agent,
            now: input.now,
            daemon_generation: input.daemon_generation,
        },
    )
}

fn prompt_for(
    presence: RunPresence,
    policy: ToolPolicy,
    covering: CoveringGrant,
    suppression: Option<AllowlistEntryId>,
) -> PromptDisposition {
    if let Some(entry) = suppression {
        return PromptDisposition::Suppressed(PromptSuppression::Allowlist(entry));
    }
    if presence == RunPresence::Unattended {
        return PromptDisposition::Required(ApprovalTier::Confirm);
    }
    match (policy, covering) {
        (ToolPolicy::Auto, CoveringGrant::Found(_)) => PromptDisposition::NotRequired,
        // `Forbidden` is returned as `Blocked` before this function runs.
        (ToolPolicy::Auto, CoveringGrant::Missing)
        | (ToolPolicy::Confirm | ToolPolicy::Forbidden, _) => {
            PromptDisposition::Required(ApprovalTier::Confirm)
        }
    }
}

fn enforced_verdict(prompt: PromptDisposition, covering: CoveringGrant) -> AdmissionVerdict {
    AdmissionVerdict::Admitted {
        prompt,
        grant: GrantObligation::Required(covering),
        sink: GateObligation::Required,
        egress: GateObligation::Required,
        presence: GateObligation::Required,
        containment: ContainmentAdmission::Required,
        non_bypassable: NonBypassable::all_required(),
    }
}

fn unrestricted_verdict() -> AdmissionVerdict {
    AdmissionVerdict::Admitted {
        prompt: PromptDisposition::Suppressed(PromptSuppression::UnrestrictedProfile),
        grant: GrantObligation::AutoAllow,
        sink: GateObligation::AutoAllow,
        egress: GateObligation::AutoAllow,
        presence: GateObligation::AutoAllow,
        containment: ContainmentAdmission::Disabled,
        non_bypassable: NonBypassable::all_required(),
    }
}

fn blocked(blocker: AdmissionBlocker) -> AdmissionVerdict {
    AdmissionVerdict::Blocked {
        blocker,
        non_bypassable: NonBypassable::all_required(),
    }
}

fn desktop_verdict() -> AdmissionVerdict {
    blocked(AdmissionBlocker::DesktopConfirmRequired)
}
