//! Security domain types for provenance, sinks, and egress.

use std::collections::BTreeSet;
use std::net::IpAddr;

use crate::audit::Timestamp;

/// Provenance taint level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Taint {
    /// Owner-originated or declassified content.
    Trusted,
    /// Attacker-controlled or unknown content.
    Untrusted,
}

/// Reference to a provenance source.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SourceRef {
    /// Owner message.
    OwnerMessage(u64),
    /// Pasted span.
    Pasted(u64),
    /// Web origin.
    WebOrigin(String),
    /// Console output.
    Console {
        /// Thread id.
        thread: u64,
        /// Tool call id.
        call: u64,
    },
    /// Endorsement action.
    Endorsement(u64),
}

/// Joined provenance for a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provenance {
    /// Maximum taint across sources.
    pub taint: Taint,
    /// Contributing sources.
    pub sources: BTreeSet<SourceRef>,
}

/// Slot or recall provenance fragment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotProvenance {
    /// Taint of the slot.
    pub taint: Taint,
    /// Sources attached to the slot.
    pub sources: BTreeSet<SourceRef>,
}

/// Side-effect category for sink checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkKind {
    /// Shell execution.
    ConsoleExec,
    /// Browser navigation.
    WebNavigate,
    /// Browser read.
    WebRead,
    /// Web mutation.
    WebWrite {
        /// Operation risk tier.
        risk: OperationRisk,
    },
    /// HTTP API call.
    ApiCall {
        /// Operation risk tier.
        risk: OperationRisk,
    },
    /// Credentialed browser action.
    CredentialedAction,
    /// Secret resolution.
    SecretUse,
    /// Router context egress.
    ContextEgress,
    /// Open child thread.
    OpenThread,
    /// Post to another thread.
    PostMessage,
    /// Vault read.
    VaultRead,
    /// Captcha or MFA automation.
    CaptchaOrMfa,
    /// Administrative change (forbidden tool surface).
    AdminChange,
}

/// Write risk classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationRisk {
    /// Reversible mutation.
    ReversibleWrite,
    /// Irreversible mutation.
    IrreversibleWrite,
}

/// Grant identifier referenced by allow decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GrantId(pub u64);

/// Policy rule identifier recorded on decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RuleId(pub u64);

/// Approval tier required for an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ApprovalTier {
    /// Grant is sufficient.
    Auto,
    /// Owner confirm on any client.
    Confirm,
    /// Desktop-only administration.
    DesktopConfirm,
}

/// Attended vs unattended execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunPresence {
    /// Owner present.
    Attended,
    /// Unattended lease.
    Unattended,
}

/// Presence under which a capability grant may be exercised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceRule {
    /// Grant is valid only while the owner is attending the run.
    AttendedOnly,
    /// Grant is valid for attended and unattended runs.
    AttendedOrUnattended,
}

/// Sink decision outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SinkDecision {
    /// Allowed under a grant.
    Allow {
        /// Covering grant.
        grant: GrantId,
        /// Rule that fired.
        rule: RuleId,
    },
    /// Needs owner approval.
    RequireApproval {
        /// Required tier.
        tier: ApprovalTier,
        /// Rule that fired.
        rule: RuleId,
        /// Stable reason code.
        reason: SinkReason,
    },
    /// Forbidden.
    Deny {
        /// Rule that fired.
        rule: RuleId,
        /// Stable reason code.
        reason: SinkReason,
    },
}

/// Stable sink reason for auditing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkReason {
    /// No grant for console.
    ConsoleNoGrant,
    /// Non-public egress blocked.
    NonPublicEgress,
    /// Write without grant.
    WriteUngranted,
    /// Admin surface forbidden.
    AdminForbidden,
    /// Captcha without grant.
    CaptchaUngranted,
    /// Vault read outside scope.
    VaultOutOfScope,
}

/// Canonical action digest input for sink checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalAction {
    /// Sink being requested.
    pub sink: SinkKind,
    /// Whether a grant covers the action.
    pub grant_state: GrantState,
    /// Whether console network is granted.
    pub console_network: ConsoleNetworkState,
    /// Whether destination is public when relevant.
    pub destination_public: DestinationPublicity,
}

/// Grant coverage for sink table rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantState {
    /// No covering grant.
    Ungranted,
    /// Granted for the action.
    Granted,
}

/// Console network grant state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleNetworkState {
    /// No network egress.
    None,
    /// Allowlisted network egress.
    Allowlist,
}

/// Whether a web destination is public.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DestinationPublicity {
    /// Public internet destination.
    Public,
    /// Non-public class.
    NonPublic,
}

/// Compiled security policy version one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecurityPolicy {
    /// Owner lowered irreversible write tier for trusted context.
    pub trusted_irreversible_write_tier: ApprovalTier,
    /// Owner lowered console network tier for untrusted context.
    pub untrusted_console_network_tier: ApprovalTier,
}

/// Capability grant record (subset for attenuation).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityGrant {
    /// Grant id.
    pub id: GrantId,
    /// Holder agent id.
    pub holder_agent: u64,
    /// Capability kind tag.
    pub capability: CapabilityKind,
    /// Expiration instant.
    pub not_after: Option<Timestamp>,
    /// Allowed destination IP when capability is `NonPublicEgress`.
    pub egress_address: Option<IpAddr>,
    /// Presence under which this grant remains effective.
    pub presence: PresenceRule,
}

/// Capability kind tag for attenuation checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CapabilityKind {
    /// Vault read scope.
    VaultRead,
    /// Console execution.
    ConsoleExec,
    /// Web read or navigate.
    WebRead,
    /// Web or API write.
    WebWrite,
    /// Secret use.
    SecretUse,
    /// Credentialed browser site action.
    WebCredentialed,
    /// Screenshot or DOM egress to the router.
    ContextEgress,
    /// Open a child thread.
    OpenThread,
    /// Post to another thread.
    PostMessage,
    /// Owner-granted non-public egress to one address.
    NonPublicEgress,
}

/// Requested child grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityRequest {
    /// Requested capability.
    pub capability: CapabilityKind,
    /// Requested expiry.
    pub not_after: Option<Timestamp>,
}

/// Grant attenuation failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantError {
    /// Requested capability absent from parent.
    NotHeldByParent,
    /// Child expiry later than parent.
    ExpiryTooLate,
}

/// IP destination class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DestinationClass {
    /// Public internet.
    Public,
    /// Loopback.
    Loopback,
    /// Private RFC1918.
    Private,
    /// Tailscale range.
    Tailnet,
    /// Link-local including metadata.
    LinkLocal,
    /// Multicast.
    Multicast,
    /// Unspecified.
    Unspecified,
    /// Reserved.
    Reserved,
}

/// Resolved destination for egress checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDestination {
    /// Resolved addresses (all must pass).
    pub addresses: Vec<IpAddr>,
    /// Destination class of the primary address.
    pub class: DestinationClass,
}

/// Purpose of an egress attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressPurpose {
    /// Router HTTP client.
    Router,
    /// Browser proxy.
    Browser,
    /// Sandbox network.
    Sandbox,
}

/// Egress policy inputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EgressPolicy {
    /// Allow loopback router base URL.
    pub allow_loopback_router: bool,
}

/// Egress decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EgressDecision {
    /// Allowed.
    Allow {
        /// Rule id.
        rule: RuleId,
    },
    /// Denied.
    Deny {
        /// Rule id.
        rule: RuleId,
    },
}

/// Canonical action for approval rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalAction {
    /// Sink summary.
    pub sink: SinkKind,
    /// Destination host in ASCII or punycode.
    pub destination: String,
    /// Exact command or path.
    pub command: String,
    /// Digest bytes.
    pub digest: [u8; 32],
}

/// Human-readable approval view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalView {
    /// Sink label.
    pub sink_label: String,
    /// Destination line.
    pub destination: String,
    /// Command line with visible controls.
    pub command: String,
    /// Hex digest.
    pub digest_hex: String,
}
