//! Security profile onboarding and transitions (`13-platform.md` AC-15..AC-21).
//!
//! One `SecurityProfile` is the only selector. Remote owners may tighten.
//! Only a local desktop `ConfirmationRecord` with OS user verification can
//! enable `Unrestricted`. Leaving it returns cancellation requirements and the
//! `UnknownOutcome` classification input for each active unsandboxed action.

use maia_core::audit::Timestamp;
use maia_core::security::{
    ActiveUnsandboxedAction, CancellationOutcome, CancellationRequirement, ClientClass,
    ConfirmationRecord, ExternalEffectEvidence, OwnerActor, OwnerClientId, PresenceProof,
    ProfileError, ProfileSelection, SecurityProfile, TailnetNodeId, TailnetUserId,
    UnsandboxedActionId, reduce_security_profile, select_onboarding_profile,
};

fn desktop() -> OwnerActor {
    OwnerActor {
        id: OwnerClientId(4),
        class: ClientClass::DesktopWindow,
    }
}

fn phone() -> OwnerActor {
    OwnerActor {
        id: OwnerClientId(8),
        class: ClientClass::PairedPhone {
            user: TailnetUserId(70),
            node: TailnetNodeId(71),
        },
    }
}

fn os_confirm(at: i64) -> ConfirmationRecord {
    ConfirmationRecord {
        confirmed_at: Timestamp(at),
        desktop_client_id: OwnerClientId(4),
        presence_proof: PresenceProof::OsUserVerification,
    }
}

fn session_confirm() -> ConfirmationRecord {
    ConfirmationRecord {
        confirmed_at: Timestamp(1),
        desktop_client_id: OwnerClientId(4),
        presence_proof: PresenceProof::SessionOnly,
    }
}

fn mismatched_confirm() -> ConfirmationRecord {
    ConfirmationRecord {
        confirmed_at: Timestamp(1),
        desktop_client_id: OwnerClientId(99),
        presence_proof: PresenceProof::OsUserVerification,
    }
}

fn future_confirm() -> ConfirmationRecord {
    ConfirmationRecord {
        confirmed_at: Timestamp(50),
        desktop_client_id: OwnerClientId(4),
        presence_proof: PresenceProof::OsUserVerification,
    }
}

fn action(id: u64, effects: ExternalEffectEvidence) -> ActiveUnsandboxedAction {
    ActiveUnsandboxedAction {
        id: UnsandboxedActionId(id),
        external_effects: effects,
    }
}

fn requirement(
    id: u64,
    classification_input: ExternalEffectEvidence,
    outcome: CancellationOutcome,
) -> CancellationRequirement {
    CancellationRequirement {
        action_id: UnsandboxedActionId(id),
        classification_input,
        outcome,
    }
}

struct OnboardExpect {
    profile: SecurityProfile,
    activated_by: OwnerClientId,
    confirmation: Option<ConfirmationRecord>,
}

struct OnboardCase {
    name: &'static str,
    selection: ProfileSelection,
    actor: OwnerActor,
    now: Timestamp,
    expect: Result<OnboardExpect, ProfileError>,
}

struct TransitionExpect {
    profile: SecurityProfile,
    activated_at: Timestamp,
    activated_by: OwnerClientId,
    confirmation: Option<ConfirmationRecord>,
    cancellations: Vec<CancellationRequirement>,
}

struct TransitionCase {
    name: &'static str,
    start: ProfileSelection,
    start_actor: OwnerActor,
    target: ProfileSelection,
    actor: OwnerActor,
    now: Timestamp,
    actions: Vec<ActiveUnsandboxedAction>,
    expect: Result<TransitionExpect, ProfileError>,
}

fn onboarding_cases() -> Vec<OnboardCase> {
    vec![
        OnboardCase {
            name: "local desktop selects protected",
            selection: ProfileSelection::Protected,
            actor: desktop(),
            now: Timestamp(1),
            expect: Ok(OnboardExpect {
                profile: SecurityProfile::Protected,
                activated_by: OwnerClientId(4),
                confirmation: None,
            }),
        },
        OnboardCase {
            name: "remote owner selects protected",
            selection: ProfileSelection::Protected,
            actor: phone(),
            now: Timestamp(2),
            expect: Ok(OnboardExpect {
                profile: SecurityProfile::Protected,
                activated_by: OwnerClientId(8),
                confirmation: None,
            }),
        },
        OnboardCase {
            name: "local desktop selects allowlisted",
            selection: ProfileSelection::Allowlisted,
            actor: desktop(),
            now: Timestamp(3),
            expect: Ok(OnboardExpect {
                profile: SecurityProfile::Allowlisted,
                activated_by: OwnerClientId(4),
                confirmation: None,
            }),
        },
        OnboardCase {
            name: "remote owner selects allowlisted",
            selection: ProfileSelection::Allowlisted,
            actor: phone(),
            now: Timestamp(4),
            expect: Ok(OnboardExpect {
                profile: SecurityProfile::Allowlisted,
                activated_by: OwnerClientId(8),
                confirmation: None,
            }),
        },
        OnboardCase {
            name: "local desktop selects unrestricted after os confirmation",
            selection: ProfileSelection::Unrestricted(os_confirm(5)),
            actor: desktop(),
            now: Timestamp(5),
            expect: Ok(OnboardExpect {
                profile: SecurityProfile::Unrestricted,
                activated_by: OwnerClientId(4),
                confirmation: Some(os_confirm(5)),
            }),
        },
        OnboardCase {
            name: "remote owner cannot select unrestricted",
            selection: ProfileSelection::Unrestricted(os_confirm(1)),
            actor: phone(),
            now: Timestamp(1),
            expect: Err(ProfileError::RemoteEnableUnrestricted),
        },
        OnboardCase {
            name: "session-only proof does not enable unrestricted",
            selection: ProfileSelection::Unrestricted(session_confirm()),
            actor: desktop(),
            now: Timestamp(1),
            expect: Err(ProfileError::MissingOsVerification),
        },
        OnboardCase {
            name: "confirmation client must be the local desktop",
            selection: ProfileSelection::Unrestricted(mismatched_confirm()),
            actor: desktop(),
            now: Timestamp(1),
            expect: Err(ProfileError::ConfirmationClientMismatch),
        },
        OnboardCase {
            name: "future confirmation does not enable unrestricted",
            selection: ProfileSelection::Unrestricted(future_confirm()),
            actor: desktop(),
            now: Timestamp(1),
            expect: Err(ProfileError::ConfirmationAfterNow),
        },
    ]
}

fn mixed_actions() -> Vec<ActiveUnsandboxedAction> {
    vec![
        action(1, ExternalEffectEvidence::Disproved),
        action(2, ExternalEffectEvidence::NotDisproved),
        action(3, ExternalEffectEvidence::Disproved),
    ]
}

fn mixed_requirements() -> Vec<CancellationRequirement> {
    vec![
        requirement(
            1,
            ExternalEffectEvidence::Disproved,
            CancellationOutcome::Cancelled,
        ),
        requirement(
            2,
            ExternalEffectEvidence::NotDisproved,
            CancellationOutcome::UnknownOutcome,
        ),
        requirement(
            3,
            ExternalEffectEvidence::Disproved,
            CancellationOutcome::Cancelled,
        ),
    ]
}

fn transition_cases() -> Vec<TransitionCase> {
    let running = mixed_actions();
    vec![
        TransitionCase {
            name: "local desktop may loosen protected to allowlisted",
            start: ProfileSelection::Protected,
            start_actor: desktop(),
            target: ProfileSelection::Allowlisted,
            actor: desktop(),
            now: Timestamp(10),
            actions: running.clone(),
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Allowlisted,
                activated_at: Timestamp(10),
                activated_by: OwnerClientId(4),
                confirmation: None,
                cancellations: Vec::new(),
            }),
        },
        TransitionCase {
            name: "remote owner cannot loosen protected to allowlisted",
            start: ProfileSelection::Protected,
            start_actor: desktop(),
            target: ProfileSelection::Allowlisted,
            actor: phone(),
            now: Timestamp(10),
            actions: running.clone(),
            expect: Err(ProfileError::RemoteLoosen),
        },
        TransitionCase {
            name: "remote owner may tighten allowlisted to protected",
            start: ProfileSelection::Allowlisted,
            start_actor: phone(),
            target: ProfileSelection::Protected,
            actor: phone(),
            now: Timestamp(10),
            actions: running.clone(),
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Protected,
                activated_at: Timestamp(10),
                activated_by: OwnerClientId(8),
                confirmation: None,
                cancellations: Vec::new(),
            }),
        },
        TransitionCase {
            name: "local desktop enables unrestricted from protected",
            start: ProfileSelection::Protected,
            start_actor: desktop(),
            target: ProfileSelection::Unrestricted(os_confirm(10)),
            actor: desktop(),
            now: Timestamp(10),
            actions: running.clone(),
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Unrestricted,
                activated_at: Timestamp(10),
                activated_by: OwnerClientId(4),
                confirmation: Some(os_confirm(10)),
                cancellations: Vec::new(),
            }),
        },
        TransitionCase {
            name: "local desktop enables unrestricted from allowlisted",
            start: ProfileSelection::Allowlisted,
            start_actor: desktop(),
            target: ProfileSelection::Unrestricted(os_confirm(9)),
            actor: desktop(),
            now: Timestamp(10),
            actions: Vec::new(),
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Unrestricted,
                activated_at: Timestamp(10),
                activated_by: OwnerClientId(4),
                confirmation: Some(os_confirm(9)),
                cancellations: Vec::new(),
            }),
        },
        TransitionCase {
            name: "remote owner cannot enable unrestricted from protected",
            start: ProfileSelection::Protected,
            start_actor: desktop(),
            target: ProfileSelection::Unrestricted(os_confirm(10)),
            actor: phone(),
            now: Timestamp(10),
            actions: Vec::new(),
            expect: Err(ProfileError::RemoteEnableUnrestricted),
        },
        TransitionCase {
            name: "remote owner cannot enable unrestricted from allowlisted",
            start: ProfileSelection::Allowlisted,
            start_actor: desktop(),
            target: ProfileSelection::Unrestricted(os_confirm(10)),
            actor: phone(),
            now: Timestamp(10),
            actions: Vec::new(),
            expect: Err(ProfileError::RemoteEnableUnrestricted),
        },
        TransitionCase {
            name: "desktop session-only proof is rejected",
            start: ProfileSelection::Protected,
            start_actor: desktop(),
            target: ProfileSelection::Unrestricted(session_confirm()),
            actor: desktop(),
            now: Timestamp(10),
            actions: Vec::new(),
            expect: Err(ProfileError::MissingOsVerification),
        },
        TransitionCase {
            name: "desktop confirmation for another client is rejected",
            start: ProfileSelection::Allowlisted,
            start_actor: desktop(),
            target: ProfileSelection::Unrestricted(mismatched_confirm()),
            actor: desktop(),
            now: Timestamp(10),
            actions: Vec::new(),
            expect: Err(ProfileError::ConfirmationClientMismatch),
        },
        TransitionCase {
            name: "desktop confirmation after now is rejected",
            start: ProfileSelection::Protected,
            start_actor: desktop(),
            target: ProfileSelection::Unrestricted(future_confirm()),
            actor: desktop(),
            now: Timestamp(10),
            actions: Vec::new(),
            expect: Err(ProfileError::ConfirmationAfterNow),
        },
        TransitionCase {
            name: "remote owner leaving unrestricted for protected cancels unsandboxed work",
            start: ProfileSelection::Unrestricted(os_confirm(1)),
            start_actor: desktop(),
            target: ProfileSelection::Protected,
            actor: phone(),
            now: Timestamp(10),
            actions: running.clone(),
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Protected,
                activated_at: Timestamp(10),
                activated_by: OwnerClientId(8),
                confirmation: None,
                cancellations: mixed_requirements(),
            }),
        },
        TransitionCase {
            name: "remote owner leaving unrestricted for allowlisted cancels unsandboxed work",
            start: ProfileSelection::Unrestricted(os_confirm(1)),
            start_actor: desktop(),
            target: ProfileSelection::Allowlisted,
            actor: phone(),
            now: Timestamp(12),
            actions: vec![action(9, ExternalEffectEvidence::NotDisproved)],
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Allowlisted,
                activated_at: Timestamp(12),
                activated_by: OwnerClientId(8),
                confirmation: None,
                cancellations: vec![requirement(
                    9,
                    ExternalEffectEvidence::NotDisproved,
                    CancellationOutcome::UnknownOutcome,
                )],
            }),
        },
        TransitionCase {
            name: "local desktop leaving unrestricted classifies disproved effects as cancelled",
            start: ProfileSelection::Unrestricted(os_confirm(1)),
            start_actor: desktop(),
            target: ProfileSelection::Protected,
            actor: desktop(),
            now: Timestamp(11),
            actions: vec![action(4, ExternalEffectEvidence::Disproved)],
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Protected,
                activated_at: Timestamp(11),
                activated_by: OwnerClientId(4),
                confirmation: None,
                cancellations: vec![requirement(
                    4,
                    ExternalEffectEvidence::Disproved,
                    CancellationOutcome::Cancelled,
                )],
            }),
        },
        TransitionCase {
            name: "leaving unrestricted with no active actions still changes profile",
            start: ProfileSelection::Unrestricted(os_confirm(1)),
            start_actor: desktop(),
            target: ProfileSelection::Protected,
            actor: desktop(),
            now: Timestamp(11),
            actions: Vec::new(),
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Protected,
                activated_at: Timestamp(11),
                activated_by: OwnerClientId(4),
                confirmation: None,
                cancellations: Vec::new(),
            }),
        },
        TransitionCase {
            name: "same protected profile is a no-op for a remote owner",
            start: ProfileSelection::Protected,
            start_actor: desktop(),
            target: ProfileSelection::Protected,
            actor: phone(),
            now: Timestamp(20),
            actions: running.clone(),
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Protected,
                activated_at: Timestamp(1),
                activated_by: OwnerClientId(4),
                confirmation: None,
                cancellations: Vec::new(),
            }),
        },
        TransitionCase {
            name: "same unrestricted profile does not recancel or replace confirmation",
            start: ProfileSelection::Unrestricted(os_confirm(1)),
            start_actor: desktop(),
            target: ProfileSelection::Unrestricted(os_confirm(10)),
            actor: desktop(),
            now: Timestamp(10),
            actions: running,
            expect: Ok(TransitionExpect {
                profile: SecurityProfile::Unrestricted,
                activated_at: Timestamp(1),
                activated_by: OwnerClientId(4),
                confirmation: Some(os_confirm(1)),
                cancellations: Vec::new(),
            }),
        },
        TransitionCase {
            name: "remote owner cannot reassert unrestricted",
            start: ProfileSelection::Unrestricted(os_confirm(1)),
            start_actor: desktop(),
            target: ProfileSelection::Unrestricted(os_confirm(1)),
            actor: phone(),
            now: Timestamp(10),
            actions: Vec::new(),
            expect: Err(ProfileError::RemoteEnableUnrestricted),
        },
    ]
}

#[test]
fn onboarding_requires_an_explicit_profile_choice() {
    for case in onboarding_cases() {
        let result = select_onboarding_profile(case.selection, case.actor, case.now);
        match (result, case.expect) {
            (Ok(settings), Ok(expect)) => {
                assert_eq!(settings.profile(), expect.profile, "{}", case.name);
                assert_eq!(settings.activated_at(), case.now, "{}", case.name);
                assert_eq!(
                    settings.activated_by(),
                    expect.activated_by,
                    "{}",
                    case.name
                );
                assert_eq!(
                    settings.local_unrestricted_confirmation(),
                    expect.confirmation.as_ref(),
                    "{}",
                    case.name
                );
            }
            (Err(error), Err(expected)) => assert_eq!(error, expected, "{}", case.name),
            (other, _) => panic!("{} unexpected {other:?}", case.name),
        }
    }
}

#[test]
fn profile_transitions_follow_tighten_and_local_unrestricted_rules() {
    for case in transition_cases() {
        let Ok(current) = select_onboarding_profile(case.start, case.start_actor, Timestamp(1))
        else {
            panic!("{} could not onboard", case.name);
        };
        let result =
            reduce_security_profile(&current, case.target, case.actor, case.now, &case.actions);
        match (result, case.expect) {
            (Ok(got), Ok(expect)) => {
                assert_eq!(got.settings.profile(), expect.profile, "{}", case.name);
                assert_eq!(
                    got.settings.activated_at(),
                    expect.activated_at,
                    "{}",
                    case.name
                );
                assert_eq!(
                    got.settings.activated_by(),
                    expect.activated_by,
                    "{}",
                    case.name
                );
                assert_eq!(
                    got.settings.local_unrestricted_confirmation(),
                    expect.confirmation.as_ref(),
                    "{}",
                    case.name
                );
                assert_eq!(got.cancellations, expect.cancellations, "{}", case.name);
            }
            (Err(error), Err(expected)) => assert_eq!(error, expected, "{}", case.name),
            (other, _) => panic!("{} unexpected {other:?}", case.name),
        }
    }
}

#[test]
fn second_tighten_does_not_classify_actions_again() {
    let Ok(unrestricted) = select_onboarding_profile(
        ProfileSelection::Unrestricted(os_confirm(1)),
        desktop(),
        Timestamp(1),
    ) else {
        panic!("onboarding unrestricted");
    };
    let actions = mixed_actions();
    let Ok(allowlisted) = reduce_security_profile(
        &unrestricted,
        ProfileSelection::Allowlisted,
        phone(),
        Timestamp(10),
        &actions,
    ) else {
        panic!("leave unrestricted");
    };
    assert_eq!(allowlisted.cancellations, mixed_requirements());
    let Ok(protected) = reduce_security_profile(
        &allowlisted.settings,
        ProfileSelection::Protected,
        phone(),
        Timestamp(11),
        &actions,
    ) else {
        panic!("tighten again");
    };
    assert_eq!(protected.settings.profile(), SecurityProfile::Protected);
    assert!(protected.cancellations.is_empty());
    assert!(
        protected
            .settings
            .local_unrestricted_confirmation()
            .is_none()
    );
}
