//! Destination classification and egress policy.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::audit::Timestamp;
use crate::security::types::{
    CapabilityGrant, CapabilityKind, DestinationClass, EgressDecision, EgressPolicy, EgressPurpose,
    ResolvedDestination, RuleId,
};

const RULE_PUBLIC: RuleId = RuleId(300);
const RULE_LOOPBACK: RuleId = RuleId(301);
const RULE_DENY_CLASS: RuleId = RuleId(302);
const RULE_GRANTED_NON_PUBLIC: RuleId = RuleId(303);

/// Classifies a resolved IP address per policy version one.
pub fn classify_destination(address: IpAddr) -> DestinationClass {
    let normalized = normalize_ip(address);
    match normalized {
        IpAddr::V4(v4) => classify_ipv4(v4),
        IpAddr::V6(v6) => classify_ipv6(v6),
    }
}

/// Parses dotted IPv4 literals including decimal, `0`-prefixed octal, and `0x` hex segments.
pub fn parse_ipv4_literal(text: &str) -> Option<Ipv4Addr> {
    let parts: Vec<u32> = text
        .split('.')
        .map(parse_ipv4_part)
        .collect::<Option<_>>()?;
    let value = match parts.as_slice() {
        [value] => *value,
        [first, rest] if *first <= 0xff && *rest <= 0x00ff_ffff => (*first << 24) | *rest,
        [first, second, rest] if *first <= 0xff && *second <= 0xff && *rest <= 0x0000_ffff => {
            (*first << 24) | (*second << 16) | *rest
        }
        [first, second, third, fourth]
            if [first, second, third, fourth]
                .into_iter()
                .all(|part| *part <= 0xff) =>
        {
            (*first << 24) | (*second << 16) | (*third << 8) | *fourth
        }
        _ => return None,
    };
    Some(Ipv4Addr::from(value))
}

/// Evaluates egress against resolved addresses; any denied answer denies all.
pub fn check_egress(
    destination: &ResolvedDestination,
    purpose: EgressPurpose,
    grants: &[CapabilityGrant],
    policy: &EgressPolicy,
    now: Timestamp,
) -> EgressDecision {
    if destination.addresses.is_empty() {
        return EgressDecision::Deny {
            rule: RULE_DENY_CLASS,
        };
    }
    for address in &destination.addresses {
        if address_allowed(*address, purpose, grants, policy, now) {
            continue;
        }
        return EgressDecision::Deny {
            rule: RULE_DENY_CLASS,
        };
    }
    let used_grant = destination.addresses.iter().any(|address| {
        classify_destination(*address) != DestinationClass::Public
            && classify_destination(*address) != DestinationClass::Loopback
            && grant_covers_address(grants, *address, now)
    });
    EgressDecision::Allow {
        rule: if used_grant {
            RULE_GRANTED_NON_PUBLIC
        } else if destination
            .addresses
            .iter()
            .all(|address| classify_destination(*address) == DestinationClass::Loopback)
        {
            RULE_LOOPBACK
        } else {
            RULE_PUBLIC
        },
    }
}

fn address_allowed(
    address: IpAddr,
    purpose: EgressPurpose,
    grants: &[CapabilityGrant],
    policy: &EgressPolicy,
    now: Timestamp,
) -> bool {
    let class = classify_destination(address);
    if class == DestinationClass::Public {
        return true;
    }
    if class == DestinationClass::Loopback
        && purpose == EgressPurpose::Router
        && policy.allow_loopback_router
    {
        return true;
    }
    grant_covers_address(grants, address, now)
}

fn grant_covers_address(grants: &[CapabilityGrant], address: IpAddr, now: Timestamp) -> bool {
    grants.iter().any(|grant| {
        grant.capability == CapabilityKind::NonPublicEgress
            && grant.egress_address == Some(address)
            && grant.not_after.is_none_or(|expiry| expiry.0 > now.0)
    })
}

fn classify_ipv4(v4: Ipv4Addr) -> DestinationClass {
    if v4.is_unspecified() {
        return DestinationClass::Unspecified;
    }
    if v4.is_loopback() {
        return DestinationClass::Loopback;
    }
    if v4.is_link_local() || v4.octets() == [169, 254, 169, 254] {
        return DestinationClass::LinkLocal;
    }
    if v4.is_multicast() {
        return DestinationClass::Multicast;
    }
    if v4.is_private() {
        return DestinationClass::Private;
    }
    if v4.octets()[0] == 100 && (v4.octets()[1] & 0b1100_0000) == 0b0100_0000 {
        return DestinationClass::Tailnet;
    }
    if v4.octets()[0] >= 240 {
        return DestinationClass::Reserved;
    }
    DestinationClass::Public
}

fn classify_ipv6(v6: Ipv6Addr) -> DestinationClass {
    if v6.is_unspecified() {
        return DestinationClass::Unspecified;
    }
    if v6.is_loopback() {
        return DestinationClass::Loopback;
    }
    if v6.is_multicast() {
        return DestinationClass::Multicast;
    }
    if v6.segments()[0] & 0xffc0 == 0xfe80 {
        return DestinationClass::LinkLocal;
    }
    if v6.segments()[0] == 0xfd7a && v6.segments()[1] == 0x115c && v6.segments()[2] == 0xa1e0 {
        return DestinationClass::Tailnet;
    }
    if (v6.segments()[0] & 0xfe00) == 0xfc00 {
        return DestinationClass::Private;
    }
    DestinationClass::Public
}

fn normalize_ip(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(v6) => {
            if let Some(v4) = embedded_ipv4(v6) {
                return IpAddr::V4(v4);
            }
            IpAddr::V6(v6)
        }
        other => other,
    }
}

fn parse_ipv4_part(segment: &str) -> Option<u32> {
    if segment.is_empty() {
        return None;
    }
    if let Some(hex) = segment
        .strip_prefix("0x")
        .or_else(|| segment.strip_prefix("0X"))
    {
        return u32::from_str_radix(hex, 16).ok();
    }
    if segment.starts_with('0') && segment.len() > 1 {
        return u32::from_str_radix(segment, 8).ok();
    }
    segment.parse::<u32>().ok()
}

fn embedded_ipv4(address: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return Some(mapped);
    }
    let segments = address.segments();
    if !address.is_unspecified()
        && !address.is_loopback()
        && segments[..6].iter().all(|segment| *segment == 0)
    {
        return Some(ipv4_from_segments(segments[6], segments[7]));
    }
    if segments[0] == 0x0064
        && segments[1] == 0xff9b
        && segments[2..6].iter().all(|segment| *segment == 0)
    {
        return Some(ipv4_from_segments(segments[6], segments[7]));
    }
    if segments[0] == 0x2002 {
        return Some(ipv4_from_segments(segments[1], segments[2]));
    }
    if segments[0] == 0x2001 && segments[1] == 0 {
        return Some(ipv4_from_segments(!segments[6], !segments[7]));
    }
    None
}

fn ipv4_from_segments(high: u16, low: u16) -> Ipv4Addr {
    let [a, b] = high.to_be_bytes();
    let [c, d] = low.to_be_bytes();
    Ipv4Addr::new(a, b, c, d)
}
