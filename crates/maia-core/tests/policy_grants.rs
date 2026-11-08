//! Grant attenuation monotonicity.

use maia_core::audit::Timestamp;
use maia_core::security::{
    CapabilityGrant, CapabilityKind, CapabilityRequest, GrantId, PresenceRule, SecurityPolicy,
    attenuate_grants,
};

#[test]
fn attenuated_child_expiry_cannot_exceed_parent() {
    let parent = vec![CapabilityGrant {
        id: GrantId(1),
        holder_agent: 1,
        capability: CapabilityKind::WebRead,
        not_after: Some(Timestamp(100)),
        egress_address: None,
        presence: PresenceRule::AttendedOrUnattended,
    }];
    let requested = vec![CapabilityRequest {
        capability: CapabilityKind::WebRead,
        not_after: Some(Timestamp(200)),
    }];
    let err = attenuate_grants(
        &parent,
        &requested,
        &SecurityPolicy {
            trusted_irreversible_write_tier: maia_core::security::ApprovalTier::Confirm,
            untrusted_console_network_tier: maia_core::security::ApprovalTier::Confirm,
        },
        Timestamp(0),
    )
    .expect_err("child expiry beyond parent must fail");
    assert!(matches!(
        err,
        maia_core::security::GrantError::ExpiryTooLate
    ));
}
