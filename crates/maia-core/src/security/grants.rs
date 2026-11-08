//! Grant attenuation for child threads and posts.

use crate::audit::Timestamp;
use crate::security::types::{
    CapabilityGrant, CapabilityRequest, GrantError, GrantId, SecurityPolicy,
};

/// Derives child grants as a subset of parent effective grants.
pub fn attenuate_grants(
    parent: &[CapabilityGrant],
    requested: &[CapabilityRequest],
    _policy: &SecurityPolicy,
    now: Timestamp,
) -> Result<Vec<CapabilityGrant>, GrantError> {
    let _ = _policy;
    let mut out = Vec::new();
    for (index, request) in requested.iter().enumerate() {
        let Some(parent_grant) = parent
            .iter()
            .filter(|g| g.capability == request.capability)
            .min_by_key(|g| g.not_after)
        else {
            return Err(GrantError::NotHeldByParent);
        };
        if let (Some(parent_expiry), Some(child_expiry)) =
            (parent_grant.not_after, request.not_after)
        {
            if child_expiry > parent_expiry {
                return Err(GrantError::ExpiryTooLate);
            }
        }
        if parent_grant.not_after.is_some_and(|expiry| expiry <= now) {
            return Err(GrantError::NotHeldByParent);
        }
        out.push(CapabilityGrant {
            id: GrantId(parent_grant.id.0 + u64::try_from(index).unwrap_or(0) + 1),
            holder_agent: parent_grant.holder_agent,
            capability: request.capability,
            not_after: match (parent_grant.not_after, request.not_after) {
                (Some(p), Some(c)) => Some(if c < p { c } else { p }),
                (Some(p), None) => Some(p),
                (None, Some(c)) => Some(c),
                (None, None) => None,
            },
            egress_address: parent_grant.egress_address,
            presence: parent_grant.presence,
        });
    }
    Ok(out)
}
