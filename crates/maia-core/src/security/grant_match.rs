//! Grant lookup helpers for sink and egress leaves.

use crate::audit::Timestamp;
use crate::security::types::{
    CapabilityGrant, CapabilityKind, GrantId, PresenceRule, RunPresence, SinkKind,
};

/// Returns the capability required to cover a sink kind.
pub fn required_capability(sink: SinkKind) -> Option<CapabilityKind> {
    match sink {
        SinkKind::AdminChange => None,
        SinkKind::ConsoleExec => Some(CapabilityKind::ConsoleExec),
        SinkKind::WebNavigate | SinkKind::WebRead => Some(CapabilityKind::WebRead),
        SinkKind::WebWrite { .. } | SinkKind::ApiCall { .. } => Some(CapabilityKind::WebWrite),
        SinkKind::CredentialedAction => Some(CapabilityKind::WebCredentialed),
        SinkKind::SecretUse | SinkKind::CaptchaOrMfa => Some(CapabilityKind::SecretUse),
        SinkKind::ContextEgress => Some(CapabilityKind::ContextEgress),
        SinkKind::OpenThread => Some(CapabilityKind::OpenThread),
        SinkKind::PostMessage => Some(CapabilityKind::PostMessage),
        SinkKind::VaultRead => Some(CapabilityKind::VaultRead),
    }
}

/// Finds an unexpired grant covering the required capability.
pub fn covering_grant(
    grants: &[CapabilityGrant],
    kind: CapabilityKind,
    presence: RunPresence,
    now: Timestamp,
) -> Option<&CapabilityGrant> {
    grants.iter().find(|grant| {
        grant.capability == kind
            && presence_allowed(grant.presence, presence)
            && grant.not_after.is_none_or(|expiry| expiry.0 > now.0)
    })
}

/// Resolves grant id for a sink from the grant slice (authoritative).
pub fn sink_grant_id(
    sink: SinkKind,
    grants: &[CapabilityGrant],
    presence: RunPresence,
    now: Timestamp,
) -> Option<GrantId> {
    let kind = required_capability(sink)?;
    covering_grant(grants, kind, presence, now).map(|grant| grant.id)
}

fn presence_allowed(rule: PresenceRule, presence: RunPresence) -> bool {
    match (rule, presence) {
        (PresenceRule::AttendedOnly, RunPresence::Unattended) => false,
        (
            PresenceRule::AttendedOnly | PresenceRule::AttendedOrUnattended,
            RunPresence::Attended,
        )
        | (PresenceRule::AttendedOrUnattended, RunPresence::Unattended) => true,
    }
}
