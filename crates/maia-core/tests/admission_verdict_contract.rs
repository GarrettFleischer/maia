//! Callers must match `AdmissionVerdict` before any controllable gate is visible.
//!
//! Blocked and DesktopConfirm results do not carry grant, sink, egress,
//! presence, or containment obligations. This file is also the daemon handoff
//! specification. There is no in-tree consumer of that skin.

use maia_core::agents::AgentId;
use maia_core::audit::Timestamp;
use maia_core::security::{
    ActiveUnsandboxedAction, AdmissionBlocker, AdmissionSubject, AdmissionVerdict, AdmitAction,
    AllowlistEntryId, BudgetGate, CancellationOutcome, CanonicalAllowAction, CapabilityKind,
    ClientClass, ContainmentAdmission, CoveringGrant, DaemonGeneration, ExternalBlocker,
    ExternalEffectEvidence, GateObligation, GrantId, GrantObligation, NonBypassable, OwnerActor,
    OwnerClientId, PlatformKind, PresenceProof, ProfileSelection, PromptDisposition,
    PromptSuppression, RunPresence, SecurityProfile, ToolPolicy, UnsandboxedActionId, admit_action,
    canonical_absolute_path, reduce_security_profile, select_onboarding_profile,
};

fn git() -> CanonicalAllowAction {
    let Ok(executable) = canonical_absolute_path(PlatformKind::Linux, "/usr/bin/git") else {
        panic!("path");
    };
    CanonicalAllowAction::Command {
        executable,
        args: vec!["status".to_owned()],
    }
}

fn admit(profile: SecurityProfile, budget: BudgetGate, policy: ToolPolicy) -> AdmissionVerdict {
    admit_action(&AdmitAction {
        profile,
        subject: AdmissionSubject::Tool {
            capability: CapabilityKind::ConsoleExec,
            action: git(),
            policy,
            external: None,
        },
        allowlist: &[],
        grants: &[],
        presence: RunPresence::Attended,
        now: Timestamp(1),
        daemon_generation: DaemonGeneration(1),
        agent: AgentId(1),
        budget,
    })
}

/// Obligations are only reachable on `Admitted`. A blocked match has no gate fields.
fn gates_after_match(verdict: &AdmissionVerdict) -> Option<GateObligation> {
    match verdict {
        AdmissionVerdict::Blocked { .. } => None,
        AdmissionVerdict::Admitted { sink, .. } => Some(*sink),
    }
}

#[test]
fn blocked_verdict_hides_controllable_gates_until_matched() {
    let blocked = admit(
        SecurityProfile::Unrestricted,
        BudgetGate::Rejected,
        ToolPolicy::Auto,
    );
    assert_eq!(gates_after_match(&blocked), None);
    match blocked {
        AdmissionVerdict::Blocked {
            blocker,
            non_bypassable,
        } => {
            assert_eq!(blocker, AdmissionBlocker::BudgetRejected);
            assert_eq!(non_bypassable, NonBypassable::all_required());
        }
        AdmissionVerdict::Admitted { .. } => panic!("budget rejection must not be admitted"),
    }

    let mfa = admit_action(&AdmitAction {
        profile: SecurityProfile::Unrestricted,
        subject: AdmissionSubject::Tool {
            capability: CapabilityKind::ConsoleExec,
            action: git(),
            policy: ToolPolicy::Auto,
            external: Some(ExternalBlocker::Mfa),
        },
        allowlist: &[],
        grants: &[],
        presence: RunPresence::Unattended,
        now: Timestamp(1),
        daemon_generation: DaemonGeneration(1),
        agent: AgentId(1),
        budget: BudgetGate::Admitted,
    });
    assert!(matches!(
        mfa,
        AdmissionVerdict::Blocked {
            blocker: AdmissionBlocker::NeedsHuman(ExternalBlocker::Mfa),
            ..
        }
    ));

    let forbidden = admit(
        SecurityProfile::Allowlisted,
        BudgetGate::Admitted,
        ToolPolicy::Forbidden,
    );
    assert!(matches!(
        forbidden,
        AdmissionVerdict::Blocked {
            blocker: AdmissionBlocker::Forbidden,
            ..
        }
    ));

    let desktop = admit_action(&AdmitAction {
        profile: SecurityProfile::Unrestricted,
        subject: AdmissionSubject::DesktopConfirmAdministration,
        allowlist: &[],
        grants: &[],
        presence: RunPresence::Attended,
        now: Timestamp(1),
        daemon_generation: DaemonGeneration(1),
        agent: AgentId(1),
        budget: BudgetGate::Admitted,
    });
    assert!(matches!(
        desktop,
        AdmissionVerdict::Blocked {
            blocker: AdmissionBlocker::DesktopConfirmRequired,
            ..
        }
    ));
}

#[test]
fn admitted_unrestricted_exposes_auto_allow_only_after_match() {
    let verdict = admit(
        SecurityProfile::Unrestricted,
        BudgetGate::Admitted,
        ToolPolicy::Confirm,
    );
    assert_eq!(gates_after_match(&verdict), Some(GateObligation::AutoAllow));
    match verdict {
        AdmissionVerdict::Admitted {
            prompt,
            grant,
            sink,
            egress,
            presence,
            containment,
            non_bypassable,
        } => {
            assert_eq!(
                prompt,
                PromptDisposition::Suppressed(PromptSuppression::UnrestrictedProfile)
            );
            assert_eq!(grant, GrantObligation::AutoAllow);
            assert_eq!(sink, GateObligation::AutoAllow);
            assert_eq!(egress, GateObligation::AutoAllow);
            assert_eq!(presence, GateObligation::AutoAllow);
            assert_eq!(containment, ContainmentAdmission::Disabled);
            assert_eq!(non_bypassable, NonBypassable::all_required());
        }
        AdmissionVerdict::Blocked { .. } => panic!("unrestricted tool should be admitted"),
    }
}

/// Daemon handoff specification. This crate does not execute the skin.
///
/// The future daemon must, in order:
/// 1. pattern-match `AdmissionVerdict::Blocked` before reading any obligation;
/// 2. run every `NonBypassable` control on both variants;
/// 3. on `Admitted`, execute the grant, sink, egress, presence, and containment
///    obligations in that variant, and only those;
/// 4. apply `ProfileTransition::cancellations` before the profile API reports success.
#[test]
fn daemon_handoff_matches_blocked_before_obligations_and_cancellations() {
    let allowlist_id = AllowlistEntryId(42);
    let capability_grant = GrantId(11);
    let _ids_are_distinct = (allowlist_id, capability_grant);

    let blocked = admit(
        SecurityProfile::Protected,
        BudgetGate::Rejected,
        ToolPolicy::Confirm,
    );
    match &blocked {
        AdmissionVerdict::Blocked {
            blocker,
            non_bypassable,
        } => {
            assert_eq!(*blocker, AdmissionBlocker::BudgetRejected);
            assert_eq!(*non_bypassable, NonBypassable::all_required());
        }
        AdmissionVerdict::Admitted { .. } => panic!("step 1: blocked must be matched first"),
    }

    let admitted = admit(
        SecurityProfile::Protected,
        BudgetGate::Admitted,
        ToolPolicy::Confirm,
    );
    match admitted {
        AdmissionVerdict::Blocked { .. } => panic!("step 3: this row is admitted"),
        AdmissionVerdict::Admitted {
            grant,
            sink,
            egress,
            presence,
            containment,
            non_bypassable,
            ..
        } => {
            assert_eq!(non_bypassable, NonBypassable::all_required());
            assert_eq!(grant, GrantObligation::Required(CoveringGrant::Missing));
            assert_eq!(sink, GateObligation::Required);
            assert_eq!(egress, GateObligation::Required);
            assert_eq!(presence, GateObligation::Required);
            assert_eq!(containment, ContainmentAdmission::Required);
        }
    }

    let Ok(settings) = select_onboarding_profile(
        ProfileSelection::Unrestricted(maia_core::security::ConfirmationRecord {
            confirmed_at: Timestamp(1),
            desktop_client_id: OwnerClientId(4),
            presence_proof: PresenceProof::OsUserVerification,
        }),
        OwnerActor {
            id: OwnerClientId(4),
            class: ClientClass::DesktopWindow,
        },
        Timestamp(1),
    ) else {
        panic!("onboarding");
    };
    let Ok(transition) = reduce_security_profile(
        &settings,
        ProfileSelection::Protected,
        OwnerActor {
            id: OwnerClientId(8),
            class: ClientClass::PairedPhone {
                user: maia_core::security::TailnetUserId(1),
                node: maia_core::security::TailnetNodeId(2),
            },
        },
        Timestamp(2),
        &[ActiveUnsandboxedAction {
            id: UnsandboxedActionId(9),
            external_effects: ExternalEffectEvidence::NotDisproved,
        }],
    ) else {
        panic!("transition");
    };
    assert_eq!(transition.cancellations.len(), 1);
    assert_eq!(
        transition.cancellations[0].outcome,
        CancellationOutcome::UnknownOutcome
    );
}
