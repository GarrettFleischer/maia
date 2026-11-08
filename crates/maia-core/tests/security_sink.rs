//! Sink decision table and monotonicity contracts.

use maia_core::security::{
    CanonicalAction, CapabilityGrant, CapabilityKind, ConsoleNetworkState, DestinationPublicity,
    GrantId, GrantState, OperationRisk, PresenceRule, Provenance, RunPresence, SecurityPolicy,
    SinkDecision, SinkKind, SlotProvenance, Taint, check_sink, decision_at_least_as_strict,
    sink_rule,
};

fn grant(kind: CapabilityKind, id: u64) -> CapabilityGrant {
    CapabilityGrant {
        id: GrantId(id),
        holder_agent: 1,
        capability: kind,
        not_after: None,
        egress_address: None,
        presence: PresenceRule::AttendedOrUnattended,
    }
}

fn trusted() -> Provenance {
    Provenance {
        taint: Taint::Trusted,
        sources: Default::default(),
    }
}

fn untrusted() -> Provenance {
    Provenance {
        taint: Taint::Untrusted,
        sources: Default::default(),
    }
}

fn policy() -> SecurityPolicy {
    SecurityPolicy {
        trusted_irreversible_write_tier: maia_core::security::ApprovalTier::Confirm,
        untrusted_console_network_tier: maia_core::security::ApprovalTier::Confirm,
    }
}

#[test]
fn check_sink_secret_use_ungranted_is_deny_even_when_trusted() {
    let action = CanonicalAction {
        sink: SinkKind::SecretUse,
        grant_state: GrantState::Ungranted,
        console_network: ConsoleNetworkState::None,
        destination_public: DestinationPublicity::Public,
    };
    let decision = check_sink(
        &action,
        &trusted(),
        &[],
        RunPresence::Attended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(decision, SinkDecision::Deny { .. }));
}

#[test]
fn check_sink_credentialed_ungranted_is_deny_even_when_trusted() {
    let action = CanonicalAction {
        sink: SinkKind::CredentialedAction,
        grant_state: GrantState::Ungranted,
        console_network: ConsoleNetworkState::None,
        destination_public: DestinationPublicity::Public,
    };
    let decision = check_sink(
        &action,
        &trusted(),
        &[],
        RunPresence::Attended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        SinkDecision::Deny {
            rule: sink_rule::FLOOR_CREDENTIAL,
            ..
        }
    ));
}

#[test]
fn check_sink_denies_when_grants_empty_but_grant_state_granted() {
    let action = CanonicalAction {
        sink: SinkKind::SecretUse,
        grant_state: GrantState::Granted,
        console_network: ConsoleNetworkState::None,
        destination_public: DestinationPublicity::Public,
    };
    let decision = check_sink(
        &action,
        &trusted(),
        &[],
        RunPresence::Attended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        SinkDecision::Deny {
            rule: sink_rule::FLOOR_SECRET,
            ..
        }
    ));
}

#[test]
fn check_sink_context_egress_ungranted_denies() {
    let action = CanonicalAction {
        sink: SinkKind::ContextEgress,
        grant_state: GrantState::Ungranted,
        console_network: ConsoleNetworkState::None,
        destination_public: DestinationPublicity::Public,
    };
    let decision = check_sink(
        &action,
        &trusted(),
        &[],
        RunPresence::Attended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        SinkDecision::Deny {
            rule: sink_rule::FLOOR_CONTEXT_EGRESS,
            ..
        }
    ));
}

#[test]
fn check_sink_post_message_ungranted_denies() {
    let action = CanonicalAction {
        sink: SinkKind::PostMessage,
        grant_state: GrantState::Ungranted,
        console_network: ConsoleNetworkState::None,
        destination_public: DestinationPublicity::Public,
    };
    let decision = check_sink(
        &action,
        &trusted(),
        &[],
        RunPresence::Attended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        SinkDecision::Deny {
            rule: sink_rule::FLOOR_THREAD,
            ..
        }
    ));
}

#[test]
fn console_without_grant_is_floor_deny() {
    let action = CanonicalAction {
        sink: SinkKind::ConsoleExec,
        grant_state: GrantState::Ungranted,
        console_network: ConsoleNetworkState::None,
        destination_public: DestinationPublicity::Public,
    };
    let decision = check_sink(
        &action,
        &trusted(),
        &[],
        RunPresence::Attended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(decision, SinkDecision::Deny { .. }));
}

#[test]
fn unattended_sink_rejects_attended_only_grant() {
    let action = CanonicalAction {
        sink: SinkKind::ConsoleExec,
        grant_state: GrantState::Granted,
        console_network: ConsoleNetworkState::None,
        destination_public: DestinationPublicity::Public,
    };
    let mut attended_only = grant(CapabilityKind::ConsoleExec, 29);
    attended_only.presence = PresenceRule::AttendedOnly;
    let decision = check_sink(
        &action,
        &trusted(),
        &[attended_only],
        RunPresence::Unattended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        SinkDecision::Deny {
            rule: sink_rule::FLOOR_CONSOLE_DENY,
            ..
        }
    ));
}

#[test]
fn irreversible_write_untrusted_requires_confirm_floor() {
    let action = CanonicalAction {
        sink: SinkKind::WebWrite {
            risk: OperationRisk::IrreversibleWrite,
        },
        grant_state: GrantState::Granted,
        console_network: ConsoleNetworkState::None,
        destination_public: DestinationPublicity::Public,
    };
    let grants = vec![grant(CapabilityKind::WebWrite, 30)];
    let decision = check_sink(
        &action,
        &untrusted(),
        &grants,
        RunPresence::Attended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        SinkDecision::RequireApproval {
            tier: maia_core::security::ApprovalTier::Confirm,
            rule: sink_rule::FLOOR_IRREVERSIBLE,
            ..
        }
    ));
}

#[test]
fn taint_monotonicity_for_console_network_grant() {
    let action = CanonicalAction {
        sink: SinkKind::ConsoleExec,
        grant_state: GrantState::Granted,
        console_network: ConsoleNetworkState::Allowlist,
        destination_public: DestinationPublicity::Public,
    };
    let grants = vec![grant(CapabilityKind::ConsoleExec, 40)];
    let trusted_decision = check_sink(
        &action,
        &trusted(),
        &grants,
        RunPresence::Attended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    let untrusted_decision = check_sink(
        &action,
        &untrusted(),
        &grants,
        RunPresence::Attended,
        &policy(),
        maia_core::audit::Timestamp(0),
    );
    assert!(decision_at_least_as_strict(
        &trusted_decision,
        &untrusted_decision
    ));
}

#[test]
fn request_provenance_joins_taint_from_recall() {
    use maia_core::security::request_provenance;
    let included = [SlotProvenance {
        taint: Taint::Trusted,
        sources: Default::default(),
    }];
    let recall = [SlotProvenance {
        taint: Taint::Untrusted,
        sources: Default::default(),
    }];
    let joined = request_provenance(&included, &[], &recall);
    assert_eq!(joined.taint, Taint::Untrusted);
}
