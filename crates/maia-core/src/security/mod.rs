//! Grants, taint, approvals, destination classification, profiles, and allowlists.

mod admission;
mod allowlist;
mod approval;
mod egress;
mod grant_match;
mod grants;
mod matcher;
mod profile;
mod provenance;
mod sink;
mod types;

pub use admission::{
    AdmissionBlocker, AdmissionSubject, AdmissionVerdict, AdmitAction, BudgetGate,
    ContainmentAdmission, CoveringGrant, ExternalBlocker, GateObligation, GrantObligation,
    NonBypassable, PromptDisposition, PromptSuppression, RequiredControl, ToolPolicy, admit_action,
};
pub use allowlist::{
    AgentScope, AllowlistDraft, AllowlistEntry, AllowlistEntryId, AllowlistError, AllowlistQuery,
    AllowlistSnapshot, Broaden, DaemonGeneration, EntryStatus, GrantLifetime,
    broaden_allowlist_entry, exact_allowlist_entry, match_allowlist, try_restore_allowlist_entry,
    with_entry_status,
};
pub use approval::render_approval;
pub use egress::{check_egress, classify_destination, parse_ipv4_literal};
pub use grants::attenuate_grants;
pub use matcher::{
    ActionFieldError, ActionMatcherSnapshot, BrowserAction, BrowserMatcherSnapshot, BrowserVerb,
    CanonicalAbsolutePath, CanonicalAllowAction, CommandMatcherSnapshot, FieldMatch,
    FileMatcherSnapshot, MatcherField, PathError, PlatformKind, SecretMatcherSnapshot, SecretName,
    ThreadAction, ThreadMatcherSnapshot, ThreadVerb, WebAction, WebMatcherSnapshot,
    WebOriginSnapshot, canonical_absolute_path,
};
pub use profile::{
    ActiveUnsandboxedAction, CancellationOutcome, CancellationRequirement, ClientClass,
    ConfirmationRecord, ExternalEffectEvidence, OwnerActor, OwnerClientId, PresenceProof,
    ProfileError, ProfileSelection, ProfileTransition, SecurityProfile, SecuritySettings,
    TailnetNodeId, TailnetUserId, UnsandboxedActionId, reduce_security_profile,
    select_onboarding_profile,
};
pub use provenance::{endorse_source, request_provenance};
pub use sink::{check_sink, decision_at_least_as_strict, rule as sink_rule};
pub use types::{
    ApprovalAction, ApprovalTier, ApprovalView, CanonicalAction, CapabilityGrant, CapabilityKind,
    CapabilityRequest, ConsoleNetworkState, DestinationClass, DestinationPublicity, EgressDecision,
    EgressPolicy, EgressPurpose, GrantError, GrantId, GrantState, OperationRisk, PresenceRule,
    Provenance, ResolvedDestination, RuleId, RunPresence, SecurityPolicy, SinkDecision, SinkKind,
    SinkReason, SlotProvenance, SourceRef, Taint,
};
