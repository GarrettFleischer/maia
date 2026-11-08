//! Deterministic sink decision table.

use crate::audit::Timestamp;
use crate::security::grant_match::{required_capability, sink_grant_id};
use crate::security::types::{
    ApprovalTier, CanonicalAction, CapabilityGrant, ConsoleNetworkState, DestinationPublicity,
    GrantState, OperationRisk, Provenance, RuleId, SecurityPolicy, SinkDecision, SinkKind,
    SinkReason, Taint,
};

/// Published rule ids for contract tests (version-one table).
pub mod rule {
    use super::RuleId;
    /// Console denied without grant (floor).
    pub const FLOOR_CONSOLE_DENY: RuleId = RuleId(100);
    /// Non-public egress blocked (floor).
    pub const FLOOR_NON_PUBLIC: RuleId = RuleId(101);
    /// Write without grant (floor).
    pub const FLOOR_WRITE_DENY: RuleId = RuleId(102);
    /// Irreversible write under untrusted (floor).
    pub const FLOOR_IRREVERSIBLE: RuleId = RuleId(103);
    /// Credentialed action without grant (floor).
    pub const FLOOR_CREDENTIAL: RuleId = RuleId(104);
    /// Secret use without grant (floor).
    pub const FLOOR_SECRET: RuleId = RuleId(105);
    /// Admin change forbidden (floor).
    pub const FLOOR_ADMIN: RuleId = RuleId(106);
    /// Captcha without grant (floor).
    pub const FLOOR_CAPTCHA: RuleId = RuleId(107);
    /// Context egress without grant (floor).
    pub const FLOOR_CONTEXT_EGRESS: RuleId = RuleId(108);
    /// Open thread / post without grant (floor).
    pub const FLOOR_THREAD: RuleId = RuleId(109);
    /// Console workspace allow.
    pub const ROW_CONSOLE_ALLOW: RuleId = RuleId(200);
    /// Console with network allowlist.
    pub const ROW_CONSOLE_NET: RuleId = RuleId(201);
    /// Web read/navigate granted origin.
    pub const ROW_WEB_GRANTED: RuleId = RuleId(202);
    /// Web read/navigate ungranted public origin.
    pub const ROW_WEB_UNGRANTED: RuleId = RuleId(203);
    /// Reversible write granted.
    pub const ROW_WRITE_REV: RuleId = RuleId(204);
    /// Irreversible write granted.
    pub const ROW_WRITE_IRREV: RuleId = RuleId(205);
    /// Credentialed action granted.
    pub const ROW_CREDENTIAL: RuleId = RuleId(206);
    /// Secret use granted.
    pub const ROW_SECRET: RuleId = RuleId(207);
    /// Context egress granted.
    pub const ROW_EGRESS: RuleId = RuleId(208);
    /// Open thread or post message granted.
    pub const ROW_THREAD: RuleId = RuleId(209);
    /// Vault read granted.
    pub const ROW_VAULT: RuleId = RuleId(210);
    /// Captcha with grant.
    pub const ROW_CAPTCHA: RuleId = RuleId(211);
}

use rule::*;

/// Evaluates the version-one sink table for an action under provenance.
pub fn check_sink(
    action: &CanonicalAction,
    context: &Provenance,
    grants: &[CapabilityGrant],
    presence: crate::security::types::RunPresence,
    policy: &SecurityPolicy,
    now: Timestamp,
) -> SinkDecision {
    let taint = context.taint;
    if action.grant_state == GrantState::Granted
        && sink_grant_id(action.sink, grants, presence, now).is_none()
        && required_capability(action.sink).is_some()
    {
        return deny_missing_grant(action.sink);
    }
    let Some(grant_id) = sink_grant_id(action.sink, grants, presence, now) else {
        return match action.sink {
            SinkKind::AdminChange => SinkDecision::Deny {
                rule: FLOOR_ADMIN,
                reason: SinkReason::AdminForbidden,
            },
            SinkKind::ConsoleExec => SinkDecision::Deny {
                rule: FLOOR_CONSOLE_DENY,
                reason: SinkReason::ConsoleNoGrant,
            },
            SinkKind::WebNavigate | SinkKind::WebRead => require_confirm(ROW_WEB_UNGRANTED),
            SinkKind::WebWrite { .. } | SinkKind::ApiCall { .. } => {
                if action.destination_public == DestinationPublicity::NonPublic {
                    return SinkDecision::Deny {
                        rule: FLOOR_NON_PUBLIC,
                        reason: SinkReason::NonPublicEgress,
                    };
                }
                SinkDecision::Deny {
                    rule: FLOOR_WRITE_DENY,
                    reason: SinkReason::WriteUngranted,
                }
            }
            SinkKind::CredentialedAction => SinkDecision::Deny {
                rule: FLOOR_CREDENTIAL,
                reason: SinkReason::WriteUngranted,
            },
            SinkKind::SecretUse => SinkDecision::Deny {
                rule: FLOOR_SECRET,
                reason: SinkReason::WriteUngranted,
            },
            SinkKind::ContextEgress => SinkDecision::Deny {
                rule: FLOOR_CONTEXT_EGRESS,
                reason: SinkReason::NonPublicEgress,
            },
            SinkKind::OpenThread | SinkKind::PostMessage => SinkDecision::Deny {
                rule: FLOOR_THREAD,
                reason: SinkReason::WriteUngranted,
            },
            SinkKind::VaultRead => require_confirm(ROW_VAULT),
            SinkKind::CaptchaOrMfa => SinkDecision::Deny {
                rule: FLOOR_CAPTCHA,
                reason: SinkReason::CaptchaUngranted,
            },
        };
    };
    match action.sink {
        SinkKind::AdminChange => SinkDecision::Deny {
            rule: FLOOR_ADMIN,
            reason: SinkReason::AdminForbidden,
        },
        SinkKind::ConsoleExec => match action.console_network {
            ConsoleNetworkState::None => allow(grant_id, ROW_CONSOLE_ALLOW),
            ConsoleNetworkState::Allowlist => {
                if taint == Taint::Trusted {
                    allow(grant_id, ROW_CONSOLE_NET)
                } else {
                    tier_decision(
                        policy.untrusted_console_network_tier,
                        ROW_CONSOLE_NET,
                        SinkReason::ConsoleNoGrant,
                        grant_id,
                    )
                }
            }
        },
        SinkKind::WebNavigate | SinkKind::WebRead => allow(grant_id, ROW_WEB_GRANTED),
        SinkKind::WebWrite { risk } | SinkKind::ApiCall { risk } => {
            if action.destination_public == DestinationPublicity::NonPublic {
                return SinkDecision::Deny {
                    rule: FLOOR_NON_PUBLIC,
                    reason: SinkReason::NonPublicEgress,
                };
            }
            match risk {
                OperationRisk::ReversibleWrite => {
                    if taint == Taint::Trusted {
                        allow(grant_id, ROW_WRITE_REV)
                    } else {
                        require_confirm(ROW_WRITE_REV)
                    }
                }
                OperationRisk::IrreversibleWrite => {
                    if taint == Taint::Untrusted {
                        return tier_decision(
                            ApprovalTier::Confirm,
                            FLOOR_IRREVERSIBLE,
                            SinkReason::WriteUngranted,
                            grant_id,
                        );
                    }
                    let tier = policy.trusted_irreversible_write_tier;
                    if tier == ApprovalTier::Auto {
                        allow(grant_id, ROW_WRITE_IRREV)
                    } else {
                        tier_decision(tier, ROW_WRITE_IRREV, SinkReason::WriteUngranted, grant_id)
                    }
                }
            }
        }
        SinkKind::CredentialedAction => {
            if taint == Taint::Untrusted {
                tier_decision(
                    ApprovalTier::Confirm,
                    FLOOR_CREDENTIAL,
                    SinkReason::WriteUngranted,
                    grant_id,
                )
            } else {
                allow(grant_id, ROW_CREDENTIAL)
            }
        }
        SinkKind::SecretUse => {
            if taint == Taint::Untrusted {
                tier_decision(
                    ApprovalTier::Confirm,
                    FLOOR_SECRET,
                    SinkReason::WriteUngranted,
                    grant_id,
                )
            } else {
                allow(grant_id, ROW_SECRET)
            }
        }
        SinkKind::ContextEgress => allow(grant_id, ROW_EGRESS),
        SinkKind::OpenThread | SinkKind::PostMessage => allow(grant_id, ROW_THREAD),
        SinkKind::VaultRead => allow(grant_id, ROW_VAULT),
        SinkKind::CaptchaOrMfa => {
            if taint == Taint::Untrusted {
                tier_decision(
                    ApprovalTier::Confirm,
                    ROW_CAPTCHA,
                    SinkReason::CaptchaUngranted,
                    grant_id,
                )
            } else {
                allow(grant_id, ROW_CAPTCHA)
            }
        }
    }
}

/// Monotone compare: `Untrusted` must not be more permissive than `Trusted`.
pub fn decision_at_least_as_strict(trusted: &SinkDecision, untrusted: &SinkDecision) -> bool {
    permissiveness(untrusted) <= permissiveness(trusted)
}

fn deny_missing_grant(sink: SinkKind) -> SinkDecision {
    match sink {
        SinkKind::ConsoleExec => SinkDecision::Deny {
            rule: FLOOR_CONSOLE_DENY,
            reason: SinkReason::ConsoleNoGrant,
        },
        SinkKind::SecretUse => SinkDecision::Deny {
            rule: FLOOR_SECRET,
            reason: SinkReason::WriteUngranted,
        },
        SinkKind::CredentialedAction => SinkDecision::Deny {
            rule: FLOOR_CREDENTIAL,
            reason: SinkReason::WriteUngranted,
        },
        SinkKind::ContextEgress => SinkDecision::Deny {
            rule: FLOOR_CONTEXT_EGRESS,
            reason: SinkReason::NonPublicEgress,
        },
        SinkKind::OpenThread | SinkKind::PostMessage => SinkDecision::Deny {
            rule: FLOOR_THREAD,
            reason: SinkReason::WriteUngranted,
        },
        _ => SinkDecision::Deny {
            rule: FLOOR_WRITE_DENY,
            reason: SinkReason::WriteUngranted,
        },
    }
}

fn permissiveness(decision: &SinkDecision) -> u8 {
    match decision {
        SinkDecision::Deny { .. } => 0,
        SinkDecision::RequireApproval { tier, .. } => match tier {
            ApprovalTier::DesktopConfirm => 1,
            ApprovalTier::Confirm => 2,
            ApprovalTier::Auto => 3,
        },
        SinkDecision::Allow { .. } => 4,
    }
}

fn allow(grant: crate::security::types::GrantId, rule: RuleId) -> SinkDecision {
    SinkDecision::Allow { grant, rule }
}

fn require_confirm(rule: RuleId) -> SinkDecision {
    SinkDecision::RequireApproval {
        tier: ApprovalTier::Confirm,
        rule,
        reason: SinkReason::WriteUngranted,
    }
}

fn tier_decision(
    tier: ApprovalTier,
    rule: RuleId,
    reason: SinkReason,
    grant: crate::security::types::GrantId,
) -> SinkDecision {
    match tier {
        ApprovalTier::Auto => SinkDecision::Allow { grant, rule },
        ApprovalTier::Confirm | ApprovalTier::DesktopConfirm => {
            SinkDecision::RequireApproval { tier, rule, reason }
        }
    }
}
