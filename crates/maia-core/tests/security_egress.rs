//! Destination classification and egress checks.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use maia_core::security::{
    CapabilityGrant, CapabilityKind, DestinationClass, EgressPolicy, EgressPurpose, GrantId,
    PresenceRule, ResolvedDestination, check_egress, classify_destination, parse_ipv4_literal,
};

#[test]
fn classify_tailnet_ipv4_and_metadata_link_local() {
    assert_eq!(
        classify_destination(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))),
        DestinationClass::Tailnet
    );
    assert_eq!(
        classify_destination(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))),
        DestinationClass::LinkLocal
    );
}

#[test]
fn classify_ipv4_mapped_loopback() {
    let mapped = IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x1));
    assert_eq!(classify_destination(mapped), DestinationClass::Loopback);
}

#[test]
fn classify_embedded_private_ipv4_forms_as_private() {
    let compatible = IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0x0a00, 0x0001));
    let nat64 = IpAddr::V6(Ipv6Addr::new(0x0064, 0xff9b, 0, 0, 0, 0, 0x0a00, 0x0001));
    let six_to_four = IpAddr::V6(Ipv6Addr::new(0x2002, 0x0a00, 0x0001, 0, 0, 0, 0, 0));
    let teredo = IpAddr::V6(Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0xf5ff, 0xfffe));
    for address in [compatible, nat64, six_to_four, teredo] {
        assert_eq!(
            classify_destination(address),
            DestinationClass::Private,
            "embedded form must retain IPv4 classification: {address}"
        );
    }
}

#[test]
fn tailnet_ipv6_requires_the_full_documented_prefix() {
    let tailnet = IpAddr::V6(Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 1));
    let other_ula = IpAddr::V6(Ipv6Addr::new(0xfd7a, 0x115c, 0xffff, 0, 0, 0, 0, 1));
    assert_eq!(classify_destination(tailnet), DestinationClass::Tailnet);
    assert_eq!(classify_destination(other_ula), DestinationClass::Private);
}

#[test]
fn check_egress_denies_private_by_default() {
    let destination = ResolvedDestination {
        addresses: vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))],
        class: DestinationClass::Private,
    };
    let decision = check_egress(
        &destination,
        EgressPurpose::Router,
        &[],
        &EgressPolicy {
            allow_loopback_router: false,
        },
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        maia_core::security::EgressDecision::Deny { .. }
    ));
}

#[test]
fn loopback_router_setting_does_not_allow_browser_loopback() {
    let destination = ResolvedDestination {
        addresses: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
        class: DestinationClass::Loopback,
    };
    let decision = check_egress(
        &destination,
        EgressPurpose::Browser,
        &[],
        &EgressPolicy {
            allow_loopback_router: true,
        },
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        maia_core::security::EgressDecision::Deny { .. }
    ));
}

#[test]
fn check_egress_denies_an_empty_resolution() {
    let destination = ResolvedDestination {
        addresses: Vec::new(),
        class: DestinationClass::Public,
    };
    let decision = check_egress(
        &destination,
        EgressPurpose::Router,
        &[],
        &EgressPolicy {
            allow_loopback_router: false,
        },
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        maia_core::security::EgressDecision::Deny { .. }
    ));
}

#[test]
fn check_egress_allows_private_when_grant_matches_address() {
    let address = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5));
    let destination = ResolvedDestination {
        addresses: vec![address],
        class: DestinationClass::Private,
    };
    let grants = vec![CapabilityGrant {
        id: GrantId(1),
        holder_agent: 1,
        capability: CapabilityKind::NonPublicEgress,
        not_after: None,
        egress_address: Some(address),
        presence: PresenceRule::AttendedOrUnattended,
    }];
    let decision = check_egress(
        &destination,
        EgressPurpose::Sandbox,
        &grants,
        &EgressPolicy {
            allow_loopback_router: false,
        },
        maia_core::audit::Timestamp(0),
    );
    assert!(matches!(
        decision,
        maia_core::security::EgressDecision::Allow { .. }
    ));
}

#[test]
fn parse_ipv4_literal_supports_hex_and_octal_segments() {
    assert_eq!(
        parse_ipv4_literal("127.0.0.1"),
        Some(Ipv4Addr::new(127, 0, 0, 1))
    );
    assert_eq!(
        parse_ipv4_literal("127.0.0.0x01"),
        Some(Ipv4Addr::new(127, 0, 0, 1))
    );
    assert_eq!(
        parse_ipv4_literal("127.0.0.010"),
        Some(Ipv4Addr::new(127, 0, 0, 8))
    );
    assert_eq!(
        parse_ipv4_literal("127.1"),
        Some(Ipv4Addr::new(127, 0, 0, 1))
    );
    assert_eq!(
        parse_ipv4_literal("0x7f000001"),
        Some(Ipv4Addr::new(127, 0, 0, 1))
    );
}
