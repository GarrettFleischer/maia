//! Admission matrix for security profiles (`13-platform.md` AC-19, AC-20, AC-22).
//!
//! An allowlist hit suppresses only the Maia approval prompt. Covering grants,
//! sink, egress, presence, and containment stay required. `Unrestricted`
//! auto-allows only those controllable gates. Budget admission, the durable
//! audit start, panic, Stop all, audit verification, log redaction, and
//! `DesktopConfirm` administration stay required for every profile.

use maia_core::agents::AgentId;
use maia_core::audit::Timestamp;
use maia_core::security::{
    AdmissionBlocker, AdmissionSubject, AdmissionVerdict, AdmitAction, AllowlistDraft,
    AllowlistEntry, AllowlistEntryId, ApprovalTier, BudgetGate, CanonicalAllowAction,
    CapabilityGrant, CapabilityKind, ContainmentAdmission, CoveringGrant, DaemonGeneration,
    EntryStatus, ExternalBlocker, GateObligation, GrantId, GrantLifetime, GrantObligation,
    NonBypassable, PlatformKind, PresenceRule, PromptDisposition, PromptSuppression, RunPresence,
    SecurityProfile, ToolPolicy, admit_action, canonical_absolute_path, exact_allowlist_entry,
    with_entry_status,
};

const ENTRY_ID: u64 = 42;
const GRANT_ID: u64 = 11;
const NOW: i64 = 100;

#[derive(Clone, Copy)]
enum GrantKind {
    None,
    Covering,
    ExpiresAfterNow,
    Expired,
    AttendedOnly,
}

#[derive(Clone, Copy)]
enum AllowKind {
    None,
    Match,
    Disabled,
    Expired,
    StaleGeneration,
    OtherAgent,
    DifferentArgs,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SubjectKind {
    Tool,
    DesktopConfirm,
}

enum Expect {
    Blocked(AdmissionBlocker),
    Admitted {
        prompt: PromptDisposition,
        grant: GrantObligation,
        gates: GateObligation,
        containment: ContainmentAdmission,
    },
}

struct Scenario {
    name: String,
    profile: SecurityProfile,
    presence: RunPresence,
    policy: ToolPolicy,
    grant: GrantKind,
    allow: AllowKind,
    budget: BudgetGate,
    external: Option<ExternalBlocker>,
    subject: SubjectKind,
    expect: Expect,
}

fn enforced_prompt(prompt: PromptDisposition, grant: GrantObligation) -> Expect {
    Expect::Admitted {
        prompt,
        grant,
        gates: GateObligation::Required,
        containment: ContainmentAdmission::Required,
    }
}

fn blocked(blocker: AdmissionBlocker) -> Expect {
    Expect::Blocked(blocker)
}

fn auto_allow() -> Expect {
    Expect::Admitted {
        prompt: PromptDisposition::Suppressed(PromptSuppression::UnrestrictedProfile),
        grant: GrantObligation::AutoAllow,
        gates: GateObligation::AutoAllow,
        containment: ContainmentAdmission::Disabled,
    }
}

fn git_status() -> CanonicalAllowAction {
    let Ok(executable) = canonical_absolute_path(PlatformKind::Linux, "/usr/bin/git") else {
        panic!("git path");
    };
    CanonicalAllowAction::Command {
        executable,
        args: vec!["status".to_owned()],
    }
}

fn grant_for(kind: GrantKind) -> Vec<CapabilityGrant> {
    let (presence, not_after) = match kind {
        GrantKind::None => return Vec::new(),
        GrantKind::Covering => (PresenceRule::AttendedOrUnattended, None),
        GrantKind::ExpiresAfterNow => {
            (PresenceRule::AttendedOrUnattended, Some(Timestamp(NOW + 1)))
        }
        GrantKind::Expired => (PresenceRule::AttendedOrUnattended, Some(Timestamp(NOW))),
        GrantKind::AttendedOnly => (PresenceRule::AttendedOnly, None),
    };
    vec![CapabilityGrant {
        id: GrantId(GRANT_ID),
        holder_agent: 5,
        capability: CapabilityKind::ConsoleExec,
        not_after,
        egress_address: None,
        presence,
    }]
}

fn entry_for(kind: AllowKind, action: &CanonicalAllowAction) -> Vec<AllowlistEntry> {
    if matches!(kind, AllowKind::None) {
        return Vec::new();
    }
    let mut matched = action.clone();
    let (agent, lifetime, status) = match kind {
        AllowKind::None => unreachable!("none returns above"),
        AllowKind::Match | AllowKind::Disabled => (
            5,
            GrantLifetime::Permanent,
            if matches!(kind, AllowKind::Disabled) {
                EntryStatus::Disabled
            } else {
                EntryStatus::Enabled
            },
        ),
        AllowKind::Expired => (
            5,
            GrantLifetime::ExpiresAt(Timestamp(NOW)),
            EntryStatus::Enabled,
        ),
        AllowKind::StaleGeneration => (
            5,
            GrantLifetime::DaemonLifetime {
                generation: DaemonGeneration(1),
            },
            EntryStatus::Enabled,
        ),
        AllowKind::OtherAgent => (9, GrantLifetime::Permanent, EntryStatus::Enabled),
        AllowKind::DifferentArgs => {
            if let CanonicalAllowAction::Command { executable, .. } = action {
                matched = CanonicalAllowAction::Command {
                    executable: executable.clone(),
                    args: vec!["diff".to_owned()],
                };
            }
            (5, GrantLifetime::Permanent, EntryStatus::Enabled)
        }
    };
    let Ok(entry) = exact_allowlist_entry(AllowlistDraft {
        id: AllowlistEntryId(ENTRY_ID),
        capability: CapabilityKind::ConsoleExec,
        action: matched,
        agent: AgentId(agent),
        lifetime,
        created_at: Timestamp(1),
        created_by: maia_core::security::OwnerClientId(4),
    }) else {
        panic!("allowlist entry");
    };
    let entry = if matches!(kind, AllowKind::Disabled) {
        with_entry_status(entry, status)
    } else {
        entry
    };
    vec![entry]
}

fn run(scenario: &Scenario) {
    let action = git_status();
    let grants = grant_for(scenario.grant);
    let entries = entry_for(scenario.allow, &action);
    let subject = match scenario.subject {
        SubjectKind::DesktopConfirm => AdmissionSubject::DesktopConfirmAdministration,
        SubjectKind::Tool => AdmissionSubject::Tool {
            capability: CapabilityKind::ConsoleExec,
            action,
            policy: scenario.policy,
            external: scenario.external,
        },
    };
    let verdict = admit_action(&AdmitAction {
        profile: scenario.profile,
        subject,
        allowlist: &entries,
        grants: &grants,
        presence: scenario.presence,
        now: Timestamp(NOW),
        daemon_generation: DaemonGeneration(3),
        agent: AgentId(5),
        budget: scenario.budget,
    });
    assert_verdict(&scenario.name, &verdict, &scenario.expect);
}

fn assert_verdict(name: &str, verdict: &AdmissionVerdict, expect: &Expect) {
    match (verdict, expect) {
        (
            AdmissionVerdict::Blocked {
                blocker,
                non_bypassable,
            },
            Expect::Blocked(expected),
        ) => {
            assert_eq!(blocker, expected, "{name} blocker");
            assert_eq!(
                non_bypassable,
                &NonBypassable::all_required(),
                "{name} controls"
            );
        }
        (
            AdmissionVerdict::Admitted {
                prompt,
                grant,
                sink,
                egress,
                presence,
                containment,
                non_bypassable,
            },
            Expect::Admitted {
                prompt: expected_prompt,
                grant: expected_grant,
                gates,
                containment: expected_containment,
            },
        ) => {
            assert_eq!(prompt, expected_prompt, "{name} prompt");
            assert_eq!(grant, expected_grant, "{name} grant");
            assert_eq!(sink, gates, "{name} sink");
            assert_eq!(egress, gates, "{name} egress");
            assert_eq!(presence, gates, "{name} presence");
            assert_eq!(containment, expected_containment, "{name} containment");
            assert_eq!(
                non_bypassable,
                &NonBypassable::all_required(),
                "{name} controls"
            );
        }
        (AdmissionVerdict::Blocked { .. }, Expect::Admitted { .. }) => {
            panic!("{name} blocked a verdict that should expose obligations");
        }
        (AdmissionVerdict::Admitted { .. }, Expect::Blocked(_)) => {
            panic!("{name} exposed obligations for a blocked verdict");
        }
    }
}

fn found_grant() -> GrantObligation {
    GrantObligation::Required(CoveringGrant::Found(GrantId(GRANT_ID)))
}

fn missing_grant() -> GrantObligation {
    GrantObligation::Required(CoveringGrant::Missing)
}

fn suppressed() -> PromptDisposition {
    PromptDisposition::Suppressed(PromptSuppression::Allowlist(AllowlistEntryId(ENTRY_ID)))
}

fn confirm() -> PromptDisposition {
    PromptDisposition::Required(ApprovalTier::Confirm)
}

fn scenario(
    name: &str,
    profile: SecurityProfile,
    presence: RunPresence,
    policy: ToolPolicy,
    grant: GrantKind,
    allow: AllowKind,
    expect: Expect,
) -> Scenario {
    Scenario {
        name: name.to_owned(),
        profile,
        presence,
        policy,
        grant,
        allow,
        budget: BudgetGate::Admitted,
        external: None,
        subject: SubjectKind::Tool,
        expect,
    }
}

fn prompt_rows() -> Vec<Scenario> {
    vec![
        scenario(
            "protected attended auto with covering grant does not prompt",
            SecurityProfile::Protected,
            RunPresence::Attended,
            ToolPolicy::Auto,
            GrantKind::Covering,
            AllowKind::None,
            enforced_prompt(PromptDisposition::NotRequired, found_grant()),
        ),
        scenario(
            "protected attended auto uses the grant expiry boundary",
            SecurityProfile::Protected,
            RunPresence::Attended,
            ToolPolicy::Auto,
            GrantKind::ExpiresAfterNow,
            AllowKind::None,
            enforced_prompt(PromptDisposition::NotRequired, found_grant()),
        ),
        scenario(
            "protected unattended auto still prompts",
            SecurityProfile::Protected,
            RunPresence::Unattended,
            ToolPolicy::Auto,
            GrantKind::Covering,
            AllowKind::None,
            enforced_prompt(confirm(), found_grant()),
        ),
        scenario(
            "protected confirm prompts even with a grant",
            SecurityProfile::Protected,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Covering,
            AllowKind::None,
            enforced_prompt(confirm(), found_grant()),
        ),
        scenario(
            "protected auto without a grant still prompts and reports the grant missing",
            SecurityProfile::Protected,
            RunPresence::Attended,
            ToolPolicy::Auto,
            GrantKind::None,
            AllowKind::None,
            enforced_prompt(confirm(), missing_grant()),
        ),
        scenario(
            "protected ignores a matching allowlist entry",
            SecurityProfile::Protected,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Covering,
            AllowKind::Match,
            enforced_prompt(confirm(), found_grant()),
        ),
        scenario(
            "allowlisted match suppresses only the prompt",
            SecurityProfile::Allowlisted,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Covering,
            AllowKind::Match,
            enforced_prompt(suppressed(), found_grant()),
        ),
        scenario(
            "allowlisted match does not invent a covering grant",
            SecurityProfile::Allowlisted,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::None,
            AllowKind::Match,
            enforced_prompt(suppressed(), missing_grant()),
        ),
        scenario(
            "allowlisted miss follows the confirm policy",
            SecurityProfile::Allowlisted,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Covering,
            AllowKind::DifferentArgs,
            enforced_prompt(confirm(), found_grant()),
        ),
        scenario(
            "allowlisted attended auto without a match does not prompt",
            SecurityProfile::Allowlisted,
            RunPresence::Attended,
            ToolPolicy::Auto,
            GrantKind::Covering,
            AllowKind::None,
            enforced_prompt(PromptDisposition::NotRequired, found_grant()),
        ),
        scenario(
            "allowlisted unattended auto without a match still prompts",
            SecurityProfile::Allowlisted,
            RunPresence::Unattended,
            ToolPolicy::Auto,
            GrantKind::Covering,
            AllowKind::None,
            enforced_prompt(confirm(), found_grant()),
        ),
        scenario(
            "allowlisted unattended match suppresses the prompt",
            SecurityProfile::Allowlisted,
            RunPresence::Unattended,
            ToolPolicy::Auto,
            GrantKind::Covering,
            AllowKind::Match,
            enforced_prompt(suppressed(), found_grant()),
        ),
        scenario(
            "disabled allowlist entry does not suppress",
            SecurityProfile::Allowlisted,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Covering,
            AllowKind::Disabled,
            enforced_prompt(confirm(), found_grant()),
        ),
        scenario(
            "expired allowlist entry does not suppress",
            SecurityProfile::Allowlisted,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Covering,
            AllowKind::Expired,
            enforced_prompt(confirm(), found_grant()),
        ),
        scenario(
            "stale daemon generation does not suppress",
            SecurityProfile::Allowlisted,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Covering,
            AllowKind::StaleGeneration,
            enforced_prompt(confirm(), found_grant()),
        ),
        scenario(
            "other agent does not suppress",
            SecurityProfile::Allowlisted,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Covering,
            AllowKind::OtherAgent,
            enforced_prompt(confirm(), found_grant()),
        ),
        scenario(
            "expired capability grant stays missing when the prompt is suppressed",
            SecurityProfile::Allowlisted,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Expired,
            AllowKind::Match,
            enforced_prompt(suppressed(), missing_grant()),
        ),
        scenario(
            "attended-only grant does not cover an unattended allowlisted match",
            SecurityProfile::Allowlisted,
            RunPresence::Unattended,
            ToolPolicy::Confirm,
            GrantKind::AttendedOnly,
            AllowKind::Match,
            enforced_prompt(suppressed(), missing_grant()),
        ),
        scenario(
            "attended-only grant covers an attended protected auto action",
            SecurityProfile::Protected,
            RunPresence::Attended,
            ToolPolicy::Auto,
            GrantKind::AttendedOnly,
            AllowKind::None,
            enforced_prompt(PromptDisposition::NotRequired, found_grant()),
        ),
        scenario(
            "unrestricted auto-allows controllable gates without a grant",
            SecurityProfile::Unrestricted,
            RunPresence::Unattended,
            ToolPolicy::Confirm,
            GrantKind::None,
            AllowKind::None,
            auto_allow(),
        ),
        scenario(
            "unrestricted suppression is the profile even when an entry matches",
            SecurityProfile::Unrestricted,
            RunPresence::Attended,
            ToolPolicy::Confirm,
            GrantKind::Covering,
            AllowKind::Match,
            auto_allow(),
        ),
    ]
}

fn blocker_rows() -> Vec<Scenario> {
    let profiles = [
        SecurityProfile::Protected,
        SecurityProfile::Allowlisted,
        SecurityProfile::Unrestricted,
    ];
    let externals = [
        ExternalBlocker::Mfa,
        ExternalBlocker::Captcha,
        ExternalBlocker::LegalConsent,
        ExternalBlocker::OsConsent,
        ExternalBlocker::LockedCredentialBackend,
        ExternalBlocker::MissingCredential,
    ];
    let mut rows = Vec::new();
    for profile in profiles {
        for external in externals {
            rows.push(Scenario {
                name: format!("{profile:?} external {external:?}"),
                profile,
                presence: RunPresence::Attended,
                policy: ToolPolicy::Auto,
                grant: GrantKind::Covering,
                allow: AllowKind::Match,
                budget: BudgetGate::Admitted,
                external: Some(external),
                subject: SubjectKind::Tool,
                expect: blocked(AdmissionBlocker::NeedsHuman(external)),
            });
        }
        rows.push(Scenario {
            name: format!("{profile:?} forbidden"),
            profile,
            presence: RunPresence::Attended,
            policy: ToolPolicy::Forbidden,
            grant: GrantKind::Covering,
            allow: AllowKind::Match,
            budget: BudgetGate::Admitted,
            external: None,
            subject: SubjectKind::Tool,
            expect: blocked(AdmissionBlocker::Forbidden),
        });
        rows.push(Scenario {
            name: format!("{profile:?} budget rejected"),
            profile,
            presence: RunPresence::Attended,
            policy: ToolPolicy::Auto,
            grant: GrantKind::Covering,
            allow: AllowKind::Match,
            budget: BudgetGate::Rejected,
            external: None,
            subject: SubjectKind::Tool,
            expect: blocked(AdmissionBlocker::BudgetRejected),
        });
        rows.push(Scenario {
            name: format!("{profile:?} desktop confirm"),
            profile,
            presence: RunPresence::Attended,
            policy: ToolPolicy::Auto,
            grant: GrantKind::Covering,
            allow: AllowKind::Match,
            budget: BudgetGate::Admitted,
            external: None,
            subject: SubjectKind::DesktopConfirm,
            expect: Expect::Blocked(AdmissionBlocker::DesktopConfirmRequired),
        });
    }
    rows
}

#[test]
fn admit_action_matrix_keeps_grants_and_non_bypassable_controls() {
    for row in prompt_rows().into_iter().chain(blocker_rows()) {
        run(&row);
    }
}
