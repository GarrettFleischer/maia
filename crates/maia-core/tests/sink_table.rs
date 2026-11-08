//! Version-one sink decision table matrix (`10-security.md`).

use maia_core::audit::Timestamp;
use maia_core::security::{
    CanonicalAction, CapabilityGrant, CapabilityKind, ConsoleNetworkState, DestinationPublicity,
    GrantId, GrantState, OperationRisk, PresenceRule, Provenance, RuleId, RunPresence,
    SecurityPolicy, SinkDecision, SinkKind, Taint, check_sink, sink_rule,
};

struct Row {
    name: &'static str,
    sink: SinkKind,
    taint: Taint,
    grants: &'static [CapabilityKind],
    console_network: ConsoleNetworkState,
    destination_public: DestinationPublicity,
    expected: SinkExpect,
}

#[derive(Debug)]
enum SinkExpect {
    Allow(RuleId),
    Deny(RuleId),
    Confirm(RuleId),
}

fn grants(kinds: &[CapabilityKind]) -> Vec<CapabilityGrant> {
    kinds
        .iter()
        .enumerate()
        .map(|(index, kind)| CapabilityGrant {
            id: GrantId(u64::try_from(index).unwrap_or(0) + 1),
            holder_agent: 1,
            capability: *kind,
            not_after: None,
            egress_address: None,
            presence: PresenceRule::AttendedOrUnattended,
        })
        .collect()
}

fn decide(row: &Row) -> SinkDecision {
    let action = CanonicalAction {
        sink: row.sink,
        grant_state: if row.grants.is_empty() {
            GrantState::Ungranted
        } else {
            GrantState::Granted
        },
        console_network: row.console_network,
        destination_public: row.destination_public,
    };
    let context = Provenance {
        taint: row.taint,
        sources: Default::default(),
    };
    check_sink(
        &action,
        &context,
        &grants(row.grants),
        RunPresence::Attended,
        &SecurityPolicy {
            trusted_irreversible_write_tier: maia_core::security::ApprovalTier::Confirm,
            untrusted_console_network_tier: maia_core::security::ApprovalTier::Confirm,
        },
        Timestamp(0),
    )
}

fn assert_rule(decision: SinkDecision, expect: SinkExpect) {
    match (decision, expect) {
        (SinkDecision::Allow { rule, .. }, SinkExpect::Allow(expected)) => {
            assert_eq!(rule, expected);
        }
        (SinkDecision::Deny { rule, .. }, SinkExpect::Deny(expected)) => {
            assert_eq!(rule, expected);
        }
        (SinkDecision::RequireApproval { rule, .. }, SinkExpect::Confirm(expected)) => {
            assert_eq!(rule, expected);
        }
        (other, expect) => panic!("unexpected decision {other:?} for {expect:?}"),
    }
}

#[test]
fn sink_table_v1_matrix() {
    let rows = [
        Row {
            name: "console_no_grant_floor",
            sink: SinkKind::ConsoleExec,
            taint: Taint::Untrusted,
            grants: &[],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Deny(sink_rule::FLOOR_CONSOLE_DENY),
        },
        Row {
            name: "console_granted_trusted",
            sink: SinkKind::ConsoleExec,
            taint: Taint::Trusted,
            grants: &[CapabilityKind::ConsoleExec],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Allow(sink_rule::ROW_CONSOLE_ALLOW),
        },
        Row {
            name: "console_network_untrusted_confirm",
            sink: SinkKind::ConsoleExec,
            taint: Taint::Untrusted,
            grants: &[CapabilityKind::ConsoleExec],
            console_network: ConsoleNetworkState::Allowlist,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Confirm(sink_rule::ROW_CONSOLE_NET),
        },
        Row {
            name: "web_ungranted_confirm",
            sink: SinkKind::WebRead,
            taint: Taint::Untrusted,
            grants: &[],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Confirm(sink_rule::ROW_WEB_UNGRANTED),
        },
        Row {
            name: "write_ungranted_floor",
            sink: SinkKind::WebWrite {
                risk: OperationRisk::ReversibleWrite,
            },
            taint: Taint::Trusted,
            grants: &[],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Deny(sink_rule::FLOOR_WRITE_DENY),
        },
        Row {
            name: "non_public_egress_floor",
            sink: SinkKind::ApiCall {
                risk: OperationRisk::ReversibleWrite,
            },
            taint: Taint::Trusted,
            grants: &[CapabilityKind::WebWrite],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::NonPublic,
            expected: SinkExpect::Deny(sink_rule::FLOOR_NON_PUBLIC),
        },
        Row {
            name: "secret_granted_trusted",
            sink: SinkKind::SecretUse,
            taint: Taint::Trusted,
            grants: &[CapabilityKind::SecretUse],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Allow(sink_rule::ROW_SECRET),
        },
        Row {
            name: "secret_granted_untrusted_confirm",
            sink: SinkKind::SecretUse,
            taint: Taint::Untrusted,
            grants: &[CapabilityKind::SecretUse],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Confirm(sink_rule::FLOOR_SECRET),
        },
        Row {
            name: "credentialed_granted_untrusted_confirm",
            sink: SinkKind::CredentialedAction,
            taint: Taint::Untrusted,
            grants: &[CapabilityKind::WebCredentialed],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Confirm(sink_rule::FLOOR_CREDENTIAL),
        },
        Row {
            name: "context_egress_granted",
            sink: SinkKind::ContextEgress,
            taint: Taint::Untrusted,
            grants: &[CapabilityKind::ContextEgress],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Allow(sink_rule::ROW_EGRESS),
        },
        Row {
            name: "post_message_granted",
            sink: SinkKind::PostMessage,
            taint: Taint::Untrusted,
            grants: &[CapabilityKind::PostMessage],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Allow(sink_rule::ROW_THREAD),
        },
        Row {
            name: "admin_change_floor",
            sink: SinkKind::AdminChange,
            taint: Taint::Trusted,
            grants: &[],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Deny(sink_rule::FLOOR_ADMIN),
        },
        Row {
            name: "captcha_ungranted_floor",
            sink: SinkKind::CaptchaOrMfa,
            taint: Taint::Trusted,
            grants: &[],
            console_network: ConsoleNetworkState::None,
            destination_public: DestinationPublicity::Public,
            expected: SinkExpect::Deny(sink_rule::FLOOR_CAPTCHA),
        },
    ];
    for row in rows {
        let decision = decide(&row);
        assert_rule(decision, row.expected);
        let _ = row.name;
    }
}
