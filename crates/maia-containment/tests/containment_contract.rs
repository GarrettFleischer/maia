//! Shared containment contract: verdict matrix, freshness, cancellation, PTY, events.

use std::collections::BTreeSet;

use maia_containment::{
    CONTAINMENT_ADAPTER_VERSION, CONTAINMENT_PROBE_SCHEMA, CancellationInput, CancellationReason,
    CapabilityObservation, CapabilityReport, CgroupOwnership, ChildPlanError, CommandPlanError,
    ContainmentCapability, ContainmentFailure, ContainmentVerdict, EnvPlanError, ExternalEffects,
    JobOwnership, KernelVersion, LandlockAbi, LinuxProbeFacts, MalformedReport, OwnershipEvidence,
    PlatformEventKind, PlatformEventSource, PlatformKind, PosixPtyCall, ProbeVersion,
    ProcessTreeDisposition, ProcessTreeId, PtyBackendKind, RecordedOutcome, ReportPurpose,
    RequiredCapabilities, StaleReport, TerminalNeed, ThreadFollowUp, Timestamp,
    assess_probe_freshness, classify_cancellation, classify_platform_event,
    command_excludes_chrome_profile, containment_verdict, kernel_observation, landlock_observation,
    plan_pty_creation, plan_tree_cancellation, required_capabilities, try_command_plan,
    try_env_plan,
};

const GENERATION: u64 = 7;
const NOW: i64 = 1_000;

fn version() -> ProbeVersion {
    ProbeVersion {
        schema: CONTAINMENT_PROBE_SCHEMA,
        adapter: CONTAINMENT_ADAPTER_VERSION,
    }
}

fn observed(capabilities: &[(ContainmentCapability, CapabilityObservation)]) -> CapabilityReport {
    ready_report(PlatformKind::Windows, capabilities, None)
}

fn ready_report(
    platform: PlatformKind,
    capabilities: &[(ContainmentCapability, CapabilityObservation)],
    linux: Option<LinuxProbeFacts>,
) -> CapabilityReport {
    CapabilityReport {
        platform,
        version: version(),
        purpose: ReportPurpose::Spawn {
            generation: GENERATION,
        },
        observed_at: Timestamp(NOW),
        observations: capabilities.iter().copied().collect(),
        linux,
    }
}

fn require(platform: PlatformKind, terminal: TerminalNeed) -> RequiredCapabilities {
    required_capabilities(platform, terminal, GENERATION, Timestamp(NOW), 30)
}

fn windows_present(terminal: TerminalNeed) -> CapabilityReport {
    let required = require(PlatformKind::Windows, terminal);
    let observations = required
        .capabilities
        .iter()
        .map(|capability| (*capability, CapabilityObservation::Present))
        .collect::<Vec<_>>();
    observed(&observations)
}

fn linux_facts_ok() -> LinuxProbeFacts {
    LinuxProbeFacts {
        kernel: KernelVersion {
            major: 6,
            minor: 4,
            patch: 0,
        },
        landlock_abi: Some(6),
    }
}

fn linux_present() -> CapabilityReport {
    let required = require(PlatformKind::Linux, TerminalNeed::NotRequired);
    let observations = required
        .capabilities
        .iter()
        .map(|capability| (*capability, CapabilityObservation::Present))
        .collect::<Vec<_>>();
    ready_report(PlatformKind::Linux, &observations, Some(linux_facts_ok()))
}

fn claim<T, E: std::fmt::Debug>(result: Result<T, E>) -> T {
    match result {
        Ok(value) => value,
        Err(err) => panic!("expected ok, got {err:?}"),
    }
}

fn refuse<T: std::fmt::Debug, E>(result: Result<T, E>) -> E {
    match result {
        Ok(value) => panic!("expected error, got {value:?}"),
        Err(err) => err,
    }
}

fn non_empty_subsets(items: &[ContainmentCapability]) -> Vec<BTreeSet<ContainmentCapability>> {
    let mut subsets = Vec::new();
    let count = items.len();
    for mask in 1u32..(1u32 << count) {
        let mut subset = BTreeSet::new();
        for (index, capability) in items.iter().enumerate() {
            if mask & (1u32 << index) != 0 {
                subset.insert(*capability);
            }
        }
        subsets.push(subset);
    }
    subsets
}

#[test]
fn windows_matrix_lists_lpac_job_assignment_and_conpty_when_a_terminal_is_required() {
    let with_terminal = require(PlatformKind::Windows, TerminalNeed::Required);
    assert_eq!(
        with_terminal.capabilities,
        BTreeSet::from([
            ContainmentCapability::LpacAppContainer,
            ContainmentCapability::KillOnCloseJob,
            ContainmentCapability::AssignBeforeResume,
            ContainmentCapability::ConPty,
        ])
    );

    let headless = require(PlatformKind::Windows, TerminalNeed::NotRequired);
    assert_eq!(headless.capabilities.len(), 3);
    assert!(
        !headless
            .capabilities
            .contains(&ContainmentCapability::ConPty)
    );
}

#[test]
fn linux_matrix_lists_kernel_namespaces_bwrap_seccomp_landlock_cgroup_and_devpts() {
    let required = require(PlatformKind::Linux, TerminalNeed::Required);
    assert_eq!(
        required.capabilities,
        BTreeSet::from([
            ContainmentCapability::KernelAtLeast6_4,
            ContainmentCapability::UserNamespaces,
            ContainmentCapability::Bubblewrap,
            ContainmentCapability::Seccomp,
            ContainmentCapability::LandlockAbiAtLeast6,
            ContainmentCapability::CgroupV2,
            ContainmentCapability::FreshDevpts,
        ])
    );
}

#[test]
fn macos_matrix_requires_arbitrary_process_containment_and_not_deprecated_apis() {
    let required = require(PlatformKind::MacOs, TerminalNeed::Required);
    assert!(
        required
            .capabilities
            .contains(&ContainmentCapability::ArbitraryUnattendedProcess)
    );
    assert!(
        !required
            .capabilities
            .contains(&ContainmentCapability::DeprecatedSandboxExec)
    );
    assert!(
        !required
            .capabilities
            .contains(&ContainmentCapability::EndpointSecurity)
    );
}

#[test]
fn kernel_6_4_is_the_linux_readiness_boundary() {
    assert_eq!(
        kernel_observation(KernelVersion {
            major: 6,
            minor: 4,
            patch: 0
        }),
        CapabilityObservation::Present
    );
    assert_eq!(
        kernel_observation(KernelVersion {
            major: 6,
            minor: 4,
            patch: 1
        }),
        CapabilityObservation::Present
    );
    assert_eq!(
        kernel_observation(KernelVersion {
            major: 7,
            minor: 0,
            patch: 0
        }),
        CapabilityObservation::Present
    );
    assert_eq!(
        kernel_observation(KernelVersion {
            major: 6,
            minor: 3,
            patch: 999
        }),
        CapabilityObservation::Insufficient
    );
    assert_eq!(
        kernel_observation(KernelVersion {
            major: 0,
            minor: 0,
            patch: 0
        }),
        CapabilityObservation::Unknown
    );
}

#[test]
fn landlock_abi_6_is_the_minimum_sufficient_abi() {
    assert_eq!(
        landlock_observation(LandlockAbi::Version(6)),
        CapabilityObservation::Present
    );
    assert_eq!(
        landlock_observation(LandlockAbi::Version(7)),
        CapabilityObservation::Present
    );
    assert_eq!(
        landlock_observation(LandlockAbi::Version(5)),
        CapabilityObservation::Insufficient
    );
    assert_eq!(
        landlock_observation(LandlockAbi::Missing),
        CapabilityObservation::Missing
    );
    assert_eq!(
        landlock_observation(LandlockAbi::Unknown),
        CapabilityObservation::Unknown
    );
}

#[test]
fn complete_windows_and_linux_reports_are_ready_only_for_their_matrix() {
    let windows = windows_present(TerminalNeed::Required);
    let windows_required = require(PlatformKind::Windows, TerminalNeed::Required);
    assert!(matches!(
        containment_verdict(&windows, &windows_required),
        ContainmentVerdict::UnattendedReady(_)
    ));

    let linux = linux_present();
    let linux_required = require(PlatformKind::Linux, TerminalNeed::Required);
    assert!(matches!(
        containment_verdict(&linux, &linux_required),
        ContainmentVerdict::UnattendedReady(_)
    ));

    assert!(matches!(
        containment_verdict(&windows, &linux_required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::PlatformMismatch { .. })
    ));
}

#[test]
fn headless_windows_spawn_does_not_require_conpty() {
    let report = windows_present(TerminalNeed::NotRequired);
    let required = require(PlatformKind::Windows, TerminalNeed::NotRequired);
    assert!(matches!(
        containment_verdict(&report, &required),
        ContainmentVerdict::UnattendedReady(_)
    ));

    let with_terminal = require(PlatformKind::Windows, TerminalNeed::Required);
    assert!(matches!(
        containment_verdict(&report, &with_terminal),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Capability {
            capability: ContainmentCapability::ConPty,
            observation: CapabilityObservation::Unknown,
        })
    ));
}

#[test]
fn ready_non_empty_subsets_stay_ready_and_empty_requirements_are_denied() {
    let report = windows_present(TerminalNeed::Required);
    let required = require(PlatformKind::Windows, TerminalNeed::Required);
    let items: Vec<_> = required.capabilities.iter().copied().collect();
    for subset in non_empty_subsets(&items) {
        let mut narrowed = required.clone();
        narrowed.capabilities = subset;
        assert!(matches!(
            containment_verdict(&report, &narrowed),
            ContainmentVerdict::UnattendedReady(_)
        ));
    }

    let mut empty = required.clone();
    empty.capabilities.clear();
    assert_eq!(
        containment_verdict(&report, &empty),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::EmptyRequirement)
    );
}

#[test]
fn weakening_any_required_observation_denies_and_supersets_stay_denied() {
    let report = windows_present(TerminalNeed::Required);
    let required = require(PlatformKind::Windows, TerminalNeed::Required);
    let weakened = [
        CapabilityObservation::Missing,
        CapabilityObservation::Unknown,
        CapabilityObservation::Deprecated,
        CapabilityObservation::Insufficient,
        CapabilityObservation::Unavailable,
    ];
    for capability in &required.capabilities {
        for observation in weakened {
            let mut denied = report.clone();
            denied.observations.insert(*capability, observation);
            assert_eq!(
                containment_verdict(&denied, &required),
                ContainmentVerdict::NeedsHuman(ContainmentFailure::Capability {
                    capability: *capability,
                    observation,
                })
            );

            let mut only = required.clone();
            only.capabilities = BTreeSet::from([*capability]);
            assert!(matches!(
                containment_verdict(&denied, &only),
                ContainmentVerdict::NeedsHuman(_)
            ));
        }
    }
}

#[test]
fn each_linux_matrix_gap_denies_the_full_requirement() {
    let report = linux_present();
    let required = require(PlatformKind::Linux, TerminalNeed::Required);
    for capability in required.capabilities.clone() {
        let mut denied = report.clone();
        denied
            .observations
            .insert(capability, CapabilityObservation::Missing);
        if capability == ContainmentCapability::KernelAtLeast6_4 {
            denied.linux = Some(LinuxProbeFacts {
                kernel: KernelVersion {
                    major: 6,
                    minor: 3,
                    patch: 0,
                },
                landlock_abi: Some(6),
            });
        }
        if capability == ContainmentCapability::LandlockAbiAtLeast6 {
            denied.linux = Some(LinuxProbeFacts {
                kernel: KernelVersion {
                    major: 6,
                    minor: 4,
                    patch: 0,
                },
                landlock_abi: Some(5),
            });
        }
        assert_eq!(
            containment_verdict(&denied, &required),
            ContainmentVerdict::NeedsHuman(ContainmentFailure::Capability {
                capability,
                observation: CapabilityObservation::Missing,
            })
        );
    }
}

#[test]
fn display_reports_never_authorize_a_spawn() {
    let mut report = windows_present(TerminalNeed::Required);
    report.purpose = ReportPurpose::Display;
    let required = require(PlatformKind::Windows, TerminalNeed::Required);
    assert_eq!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::DisplayOnly)
    );
    assert_eq!(
        assess_probe_freshness(&report, &required),
        Err(ContainmentFailure::DisplayOnly)
    );
}

#[test]
fn stale_generation_age_and_schema_never_authorize() {
    let report = windows_present(TerminalNeed::Required);
    let mut required = require(PlatformKind::Windows, TerminalNeed::Required);

    required.spawn_generation = GENERATION + 1;
    assert_eq!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Stale(StaleReport::GenerationMismatch))
    );

    required.spawn_generation = GENERATION;
    required.evaluated_at = Timestamp(NOW + 31);
    assert_eq!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Stale(StaleReport::Expired))
    );

    required.evaluated_at = Timestamp(NOW + 30);
    assert!(assess_probe_freshness(&report, &required).is_ok());

    required.evaluated_at = Timestamp(NOW);
    required.accepted_schema = CONTAINMENT_PROBE_SCHEMA + 1;
    assert_eq!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::UnsupportedSchema {
            schema: CONTAINMENT_PROBE_SCHEMA,
        })
    );
}

#[test]
fn malformed_reports_fail_closed_without_path_text() {
    let required = require(PlatformKind::Windows, TerminalNeed::Required);
    let mut report = windows_present(TerminalNeed::Required);
    report.version.schema = 0;
    assert_eq!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Malformed(MalformedReport::SchemaUnset))
    );

    report.version = version();
    report.version.adapter = 0;
    assert_eq!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Malformed(
            MalformedReport::AdapterUnset
        ))
    );

    report.version = version();
    report.observed_at = Timestamp(NOW + 1);
    assert_eq!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Malformed(
            MalformedReport::FutureObservation
        ))
    );

    report.observed_at = Timestamp(i64::MIN);
    let mut overflow = required.clone();
    overflow.evaluated_at = Timestamp(i64::MAX);
    assert!(matches!(
        containment_verdict(&report, &overflow),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Malformed(_))
    ));

    let mut foreign = windows_present(TerminalNeed::Required);
    foreign.observations.insert(
        ContainmentCapability::LandlockAbiAtLeast6,
        CapabilityObservation::Present,
    );
    assert_eq!(
        containment_verdict(&foreign, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Malformed(
            MalformedReport::ForeignCapability {
                capability: ContainmentCapability::LandlockAbiAtLeast6,
            }
        ))
    );

    let mut claimed = windows_present(TerminalNeed::Required);
    claimed.observations.insert(
        ContainmentCapability::DeprecatedSandboxExec,
        CapabilityObservation::Present,
    );
    assert_eq!(
        containment_verdict(&claimed, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Malformed(
            MalformedReport::DeprecatedMarkedPresent {
                capability: ContainmentCapability::DeprecatedSandboxExec,
            }
        ))
    );

    let mut linux = linux_present();
    linux.linux = Some(LinuxProbeFacts {
        kernel: KernelVersion {
            major: 6,
            minor: 3,
            patch: 0,
        },
        landlock_abi: Some(6),
    });
    let linux_required = require(PlatformKind::Linux, TerminalNeed::Required);
    assert_eq!(
        containment_verdict(&linux, &linux_required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Malformed(
            MalformedReport::LinuxFactsContradict {
                capability: ContainmentCapability::KernelAtLeast6_4,
            }
        ))
    );

    linux.linux = None;
    assert_eq!(
        containment_verdict(&linux, &linux_required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Malformed(
            MalformedReport::MissingLinuxFacts
        ))
    );

    let mut windows = windows_present(TerminalNeed::Required);
    windows.linux = Some(linux_facts_ok());
    assert_eq!(
        containment_verdict(&windows, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Malformed(
            MalformedReport::FactsOnWrongPlatform
        ))
    );

    let ContainmentVerdict::NeedsHuman(failure) = containment_verdict(&windows, &required) else {
        panic!("expected needs human");
    };
    let rendered = format!("{failure} {failure:?}");
    assert!(!rendered.contains('\\'));
    assert!(!rendered.contains("/home"));
    assert!(!rendered.contains("C:"));
}

#[test]
fn macos_spawn_report_is_never_unattended_ready() {
    let mut report = ready_report(
        PlatformKind::MacOs,
        &[
            (
                ContainmentCapability::ArbitraryUnattendedProcess,
                CapabilityObservation::Unavailable,
            ),
            (
                ContainmentCapability::DeprecatedSandboxExec,
                CapabilityObservation::Deprecated,
            ),
            (
                ContainmentCapability::EndpointSecurity,
                CapabilityObservation::Deprecated,
            ),
        ],
        None,
    );
    let required = require(PlatformKind::MacOs, TerminalNeed::Required);
    assert_eq!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::UnsupportedPlatform {
            platform: PlatformKind::MacOs,
        })
    );

    report.observations.insert(
        ContainmentCapability::ArbitraryUnattendedProcess,
        CapabilityObservation::Present,
    );
    assert!(matches!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(_)
    ));
    assert!(!matches!(
        containment_verdict(&report, &required),
        ContainmentVerdict::UnattendedReady(_)
    ));
}

#[test]
fn arbitrary_process_flag_is_not_a_windows_or_linux_pass() {
    let mut report = windows_present(TerminalNeed::NotRequired);
    report.observations.insert(
        ContainmentCapability::ArbitraryUnattendedProcess,
        CapabilityObservation::Present,
    );
    let mut required = require(PlatformKind::Windows, TerminalNeed::NotRequired);
    required.capabilities = BTreeSet::from([ContainmentCapability::ArbitraryUnattendedProcess]);
    assert!(matches!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(_)
    ));
}

#[test]
fn cancellation_records_unknown_outcome_when_effects_or_ownership_are_uncertain() {
    let rows = [
        (
            CancellationReason::ContainmentLost,
            ExternalEffects::CannotDisprove,
            ProcessTreeDisposition::Killed,
            RecordedOutcome::UnknownOutcome,
            ThreadFollowUp::NeedsHuman,
        ),
        (
            CancellationReason::ContainmentLost,
            ExternalEffects::Disproved,
            ProcessTreeDisposition::Killed,
            RecordedOutcome::ContainedStop,
            ThreadFollowUp::NeedsHuman,
        ),
        (
            CancellationReason::ContainmentLost,
            ExternalEffects::Disproved,
            ProcessTreeDisposition::AlreadyExited,
            RecordedOutcome::ContainedStop,
            ThreadFollowUp::NeedsHuman,
        ),
        (
            CancellationReason::ContainmentLost,
            ExternalEffects::Disproved,
            ProcessTreeDisposition::KillFailed,
            RecordedOutcome::UnknownOutcome,
            ThreadFollowUp::NeedsHuman,
        ),
        (
            CancellationReason::ContainmentLost,
            ExternalEffects::Disproved,
            ProcessTreeDisposition::NotOwned,
            RecordedOutcome::UnknownOutcome,
            ThreadFollowUp::NeedsHuman,
        ),
        (
            CancellationReason::LeftUnrestricted,
            ExternalEffects::CannotDisprove,
            ProcessTreeDisposition::Killed,
            RecordedOutcome::UnknownOutcome,
            ThreadFollowUp::NeedsHuman,
        ),
        (
            CancellationReason::LeftUnrestricted,
            ExternalEffects::Disproved,
            ProcessTreeDisposition::Killed,
            RecordedOutcome::ContainedStop,
            ThreadFollowUp::Stopped,
        ),
        (
            CancellationReason::StopAll,
            ExternalEffects::Disproved,
            ProcessTreeDisposition::AlreadyExited,
            RecordedOutcome::ContainedStop,
            ThreadFollowUp::Stopped,
        ),
        (
            CancellationReason::OwnerStop,
            ExternalEffects::Disproved,
            ProcessTreeDisposition::Killed,
            RecordedOutcome::ContainedStop,
            ThreadFollowUp::Stopped,
        ),
        (
            CancellationReason::OwnerStop,
            ExternalEffects::Disproved,
            ProcessTreeDisposition::NotOwned,
            RecordedOutcome::UnknownOutcome,
            ThreadFollowUp::NeedsHuman,
        ),
    ];

    for (reason, external_effects, tree, outcome, thread) in rows {
        let classification = classify_cancellation(CancellationInput {
            reason,
            external_effects,
            tree,
        });
        assert_eq!(classification.outcome, outcome);
        assert_eq!(classification.thread, thread);
    }
}

#[test]
fn tree_cancellation_plans_kill_only_owned_jobs_and_cgroups() {
    let tree = ProcessTreeId(4);
    assert!(matches!(
        plan_tree_cancellation(
            OwnershipEvidence::WindowsJob(JobOwnership::KillOnCloseAndAssignedBeforeResume),
            tree,
            CancellationReason::ContainmentLost,
        ),
        maia_containment::TreeCancelPlan::KillOwned { .. }
    ));
    assert!(matches!(
        plan_tree_cancellation(
            OwnershipEvidence::WindowsJob(JobOwnership::MissingKillOnClose),
            tree,
            CancellationReason::StopAll,
        ),
        maia_containment::TreeCancelPlan::NotOwned { .. }
    ));
    assert!(matches!(
        plan_tree_cancellation(
            OwnershipEvidence::WindowsJob(JobOwnership::AssignedAfterResume),
            tree,
            CancellationReason::StopAll,
        ),
        maia_containment::TreeCancelPlan::NotOwned { .. }
    ));
    assert!(matches!(
        plan_tree_cancellation(
            OwnershipEvidence::LinuxCgroup(CgroupOwnership::V2WithKill),
            tree,
            CancellationReason::ContainmentLost,
        ),
        maia_containment::TreeCancelPlan::KillOwned { .. }
    ));
    assert!(matches!(
        plan_tree_cancellation(
            OwnershipEvidence::LinuxCgroup(CgroupOwnership::NotV2),
            tree,
            CancellationReason::ContainmentLost,
        ),
        maia_containment::TreeCancelPlan::NotOwned { .. }
    ));
    assert!(matches!(
        plan_tree_cancellation(
            OwnershipEvidence::Unowned,
            tree,
            CancellationReason::OwnerStop,
        ),
        maia_containment::TreeCancelPlan::NotOwned { .. }
    ));
}

#[test]
fn pty_plans_use_conpty_or_the_posix_sequence_and_inherit_nothing() {
    let size = maia_containment::PtySize { cols: 80, rows: 24 };
    let windows = claim(plan_pty_creation(PlatformKind::Windows, size));
    assert_eq!(windows.backend(), PtyBackendKind::ConPty);
    assert!(windows.posix_calls().is_none());
    assert!(!windows.inherits_browser_handles());

    for platform in [PlatformKind::Linux, PlatformKind::MacOs] {
        let plan = claim(plan_pty_creation(platform, size));
        assert_eq!(plan.backend(), PtyBackendKind::Posix);
        assert_eq!(
            plan.posix_calls(),
            Some(
                [
                    PosixPtyCall::Openpt,
                    PosixPtyCall::Grantpt,
                    PosixPtyCall::Unlockpt,
                ]
                .as_slice()
            )
        );
        assert!(!plan.inherits_browser_handles());
    }

    let zero = maia_containment::PtySize { cols: 0, rows: 24 };
    assert!(plan_pty_creation(PlatformKind::Linux, zero).is_err());
}

#[test]
fn platform_events_classify_lock_and_suspend_sources() {
    let locks = [
        PlatformEventSource::WindowsSessionLock,
        PlatformEventSource::LinuxLockedHint,
        PlatformEventSource::MacOsScreenIsLocked,
    ];
    for source in locks {
        assert_eq!(
            classify_platform_event(source).kind,
            PlatformEventKind::Lock
        );
    }
    let suspends = [
        PlatformEventSource::WindowsSuspend,
        PlatformEventSource::LinuxPrepareForSleep,
        PlatformEventSource::MacOsWillSleep,
    ];
    for source in suspends {
        assert_eq!(
            classify_platform_event(source).kind,
            PlatformEventKind::Suspend
        );
    }
}

#[test]
fn command_plans_are_argv_data_and_failures_omit_sensitive_paths() {
    let sentinel = "C:\\sentinel-profile-9f3a\\User Data";
    let cookie = "C:\\sentinel-profile-9f3a\\User Data\\Default\\Cookies";
    let plan = claim(try_command_plan(
        PlatformKind::Windows,
        "C:\\Windows\\System32\\timeout.exe",
        &["/t", "30"],
    ));
    assert_eq!(plan.program(), "C:\\Windows\\System32\\timeout.exe");
    assert_eq!(plan.arguments(), &["/t".to_string(), "30".to_string()][..]);

    let command_shell = refuse(try_command_plan(
        PlatformKind::Windows,
        "C:\\Windows\\System32\\cmd.exe",
        &["/c", "whoami"],
    ));
    assert_eq!(command_shell, CommandPlanError::ShellExecutable);
    assert!(!format!("{command_shell:?}").contains("whoami"));

    let shell = refuse(try_command_plan(
        PlatformKind::Linux,
        "/bin/sh",
        &["-c", "rm -rf /"],
    ));
    assert_eq!(shell, CommandPlanError::ShellExecutable);
    assert!(!format!("{shell} {shell:?}").contains("rm -rf"));

    let injected = claim(try_command_plan(
        PlatformKind::Linux,
        "/usr/bin/tool",
        &["hello; rm"],
    ));
    assert_eq!(injected.arguments(), &["hello; rm".to_string()][..]);

    let credential = refuse(try_command_plan(PlatformKind::Windows, cookie, &[]));
    let rendered = format!("{credential} {credential:?}");
    assert_eq!(credential, CommandPlanError::CredentialFile);
    assert!(!rendered.contains("Cookies"));
    assert!(!rendered.contains("sentinel-profile-9f3a"));

    let browser = refuse(try_command_plan(
        PlatformKind::Linux,
        "/usr/bin/chrome",
        &["--user-data-dir=/sentinel-profile-9f3a"],
    ));
    let rendered = format!("{browser} {browser:?}");
    assert_eq!(browser, CommandPlanError::BrowserProfileArgument);
    assert!(!rendered.contains("sentinel-profile-9f3a"));

    let relative = refuse(try_command_plan(PlatformKind::Linux, "bin/tool", &[]));
    assert_eq!(relative, CommandPlanError::RelativeExecutable);
    let traversal = refuse(try_command_plan(
        PlatformKind::Linux,
        "/usr/bin/../tool",
        &[],
    ));
    assert_eq!(traversal, CommandPlanError::ParentSegment);
    let unc = refuse(try_command_plan(
        PlatformKind::Windows,
        "\\\\server\\share\\tool.exe",
        &[],
    ));
    assert_eq!(unc, CommandPlanError::UncOrDevice);

    let excluded = command_excludes_chrome_profile(&plan, PlatformKind::Windows, sentinel);
    assert_eq!(excluded, Ok(()));
    let leaked = claim(try_command_plan(
        PlatformKind::Windows,
        "C:\\Windows\\System32\\timeout.exe",
        &[sentinel],
    ));
    let profile_error = refuse(command_excludes_chrome_profile(
        &leaked,
        PlatformKind::Windows,
        sentinel,
    ));
    let rendered = format!("{profile_error} {profile_error:?}");
    assert_eq!(profile_error, ChildPlanError::ChromeProfileIncluded);
    assert!(!rendered.contains("sentinel-profile-9f3a"));

    let env = claim(try_env_plan(&["LANG", "TZ"]));
    assert_eq!(env.names(), &["LANG".to_string(), "TZ".to_string()][..]);
    let secret = refuse(try_env_plan(&["CHROME_PROFILE_PATH"]));
    let rendered = format!("{secret} {secret:?}");
    assert_eq!(secret, EnvPlanError::SecretName);
    assert!(!rendered.contains("CHROME_PROFILE_PATH"));
}
