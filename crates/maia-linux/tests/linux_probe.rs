//! Linux probe interpretation, mount exclusion, and the spawn boundary.

use maia_containment::{
    CONTAINMENT_ADAPTER_VERSION, CONTAINMENT_PROBE_SCHEMA, CapabilityObservation, CommandPlanError,
    ContainmentCapability, ContainmentFailure, ContainmentVerdict, KernelVersion, LandlockAbi,
    PlatformKind, ProbeIdentity, ProbeVersion, ReportPurpose, TerminalNeed, Timestamp,
    containment_verdict, required_capabilities,
};
use maia_linux::{
    BubblewrapDraft, BubblewrapPlanError, DevptsFreshness, LinuxProbeInput, LinuxSpawnBoundary,
    MountDraft, MountDraftKind, NamespaceDraft, NamespaceMode, contained_spawn_boundary,
    interpret_linux_probe, linux_event_sources, pty_plan, secret_service_descriptor,
    try_bubblewrap_plan,
};

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

fn spawn_identity() -> ProbeIdentity {
    ProbeIdentity {
        version: ProbeVersion {
            schema: CONTAINMENT_PROBE_SCHEMA,
            adapter: CONTAINMENT_ADAPTER_VERSION,
        },
        purpose: ReportPurpose::Spawn { generation: 7 },
        observed_at: Timestamp(1_000),
    }
}

fn ready_input() -> LinuxProbeInput {
    LinuxProbeInput {
        kernel: KernelVersion {
            major: 6,
            minor: 4,
            patch: 0,
        },
        user_namespaces: CapabilityObservation::Present,
        bubblewrap: CapabilityObservation::Present,
        seccomp: CapabilityObservation::Present,
        landlock: LandlockAbi::Version(6),
        cgroup_v2: CapabilityObservation::Present,
        fresh_devpts: CapabilityObservation::Present,
        identity: spawn_identity(),
    }
}

fn required() -> maia_containment::RequiredCapabilities {
    required_capabilities(
        PlatformKind::Linux,
        TerminalNeed::Required,
        7,
        Timestamp(1_000),
        30,
    )
}

fn observation(
    input: &LinuxProbeInput,
    capability: ContainmentCapability,
) -> CapabilityObservation {
    let report = interpret_linux_probe(*input);
    match report.observations.get(&capability).copied() {
        Some(observation) => observation,
        None => panic!("missing {capability:?}"),
    }
}

#[test]
fn qualifying_probe_is_ready_and_a_display_copy_is_not() {
    let report = interpret_linux_probe(ready_input());
    assert!(matches!(
        containment_verdict(&report, &required()),
        ContainmentVerdict::UnattendedReady(_)
    ));

    let mut display = ready_input();
    display.identity.purpose = ReportPurpose::Display;
    let report = interpret_linux_probe(display);
    assert_eq!(
        containment_verdict(&report, &required()),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::DisplayOnly)
    );
}

#[test]
fn kernel_older_than_6_4_and_landlock_below_6_are_insufficient() {
    let mut kernel = ready_input();
    kernel.kernel.minor = 3;
    assert_eq!(
        observation(&kernel, ContainmentCapability::KernelAtLeast6_4),
        CapabilityObservation::Insufficient
    );
    assert!(matches!(
        containment_verdict(&interpret_linux_probe(kernel), &required()),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Capability {
            capability: ContainmentCapability::KernelAtLeast6_4,
            observation: CapabilityObservation::Insufficient,
        })
    ));

    let mut abi = ready_input();
    abi.landlock = LandlockAbi::Version(5);
    assert_eq!(
        observation(&abi, ContainmentCapability::LandlockAbiAtLeast6),
        CapabilityObservation::Insufficient
    );
    assert!(matches!(
        containment_verdict(&interpret_linux_probe(abi), &required()),
        ContainmentVerdict::NeedsHuman(_)
    ));
}

#[test]
fn every_missing_control_is_needs_human() {
    let gaps = [
        (
            ContainmentCapability::UserNamespaces,
            LinuxProbeInput {
                user_namespaces: CapabilityObservation::Missing,
                ..ready_input()
            },
        ),
        (
            ContainmentCapability::Bubblewrap,
            LinuxProbeInput {
                bubblewrap: CapabilityObservation::Missing,
                ..ready_input()
            },
        ),
        (
            ContainmentCapability::Seccomp,
            LinuxProbeInput {
                seccomp: CapabilityObservation::Unknown,
                ..ready_input()
            },
        ),
        (
            ContainmentCapability::CgroupV2,
            LinuxProbeInput {
                cgroup_v2: CapabilityObservation::Unavailable,
                ..ready_input()
            },
        ),
        (
            ContainmentCapability::FreshDevpts,
            LinuxProbeInput {
                fresh_devpts: CapabilityObservation::Deprecated,
                ..ready_input()
            },
        ),
        (
            ContainmentCapability::LandlockAbiAtLeast6,
            LinuxProbeInput {
                landlock: LandlockAbi::Missing,
                ..ready_input()
            },
        ),
    ];

    for (capability, input) in gaps {
        let report = interpret_linux_probe(input);
        assert!(
            matches!(
                containment_verdict(&report, &required()),
                ContainmentVerdict::NeedsHuman(ContainmentFailure::Capability {
                    capability: denied,
                    ..
                }) if denied == capability
            ),
            "{capability:?} must fail closed"
        );
    }
}

fn unshared() -> NamespaceDraft {
    NamespaceDraft {
        user: NamespaceMode::Unshare,
        pid: NamespaceMode::Unshare,
        mount: NamespaceMode::Unshare,
        net: NamespaceMode::Unshare,
        ipc: NamespaceMode::Unshare,
        uts: NamespaceMode::Unshare,
    }
}

fn safe_mounts() -> Vec<MountDraft> {
    vec![
        MountDraft {
            kind: MountDraftKind::ReadOnly,
            source: Some("/usr".to_string()),
            target: "/usr".to_string(),
        },
        MountDraft {
            kind: MountDraftKind::Devpts {
                freshness: DevptsFreshness::Fresh,
            },
            source: None,
            target: "/dev/pts".to_string(),
        },
    ]
}

fn draft() -> BubblewrapDraft {
    BubblewrapDraft {
        bwrap_executable: "/usr/bin/bwrap".to_string(),
        child_executable: "/usr/bin/tool".to_string(),
        child_args: vec!["hello; rm".to_string()],
        mounts: safe_mounts(),
        chrome_profile: "/var/lib/maia/chrome-profile".to_string(),
        namespaces: unshared(),
    }
}

#[test]
fn bubblewrap_plan_is_data_only_and_excludes_the_chrome_profile() {
    let plan = claim(try_bubblewrap_plan(draft()));
    let argv = plan.argument_vector();
    assert_eq!(argv.first().map(String::as_str), Some("/usr/bin/bwrap"));
    assert!(argv.iter().any(|arg| arg == "hello; rm"));
    assert!(!argv.iter().any(|arg| arg == "-c" || arg == "/bin/sh"));
    let profile = "/var/lib/maia/chrome-profile";
    assert!(
        !argv
            .iter()
            .any(|arg| arg == profile || arg.starts_with(&format!("{profile}/")))
    );
    assert_eq!(
        plan.syscall_filter(),
        maia_linux::SyscallFilter::SeccompRequired
    );
    assert_eq!(
        plan.filesystem_policy(),
        maia_linux::FilesystemPolicy::LandlockAbiAtLeast6
    );

    let mut sibling = draft();
    sibling.mounts.push(MountDraft {
        kind: MountDraftKind::ReadOnly,
        source: Some("/var/lib/maia/chrome-profile-backup".to_string()),
        target: "/backup".to_string(),
    });
    let sibling = claim(try_bubblewrap_plan(sibling));
    assert!(
        sibling
            .argument_vector()
            .iter()
            .any(|arg| arg == "/var/lib/maia/chrome-profile-backup")
    );

    let mut included = draft();
    included.mounts.push(MountDraft {
        kind: MountDraftKind::ReadOnly,
        source: Some("/var/lib/maia/chrome-profile/Default".to_string()),
        target: "/profile".to_string(),
    });
    let err = refuse(try_bubblewrap_plan(included));
    let rendered = format!("{err} {err:?}");
    assert_eq!(err, BubblewrapPlanError::ChromeProfileIncluded);
    assert!(!rendered.contains("chrome-profile"));

    let mut host_pts = draft();
    host_pts.mounts[1].kind = MountDraftKind::Devpts {
        freshness: DevptsFreshness::HostInstance,
    };
    assert_eq!(
        refuse(try_bubblewrap_plan(host_pts)),
        BubblewrapPlanError::HostDevpts
    );

    let mut shared = draft();
    shared.namespaces.net = NamespaceMode::SharedWithHost;
    assert_eq!(
        refuse(try_bubblewrap_plan(shared)),
        BubblewrapPlanError::NamespaceSharedWithHost
    );

    let mut shell = draft();
    shell.child_executable = "/bin/sh".to_string();
    shell.child_args = vec!["-c".to_string(), "rm -rf /".to_string()];
    assert_eq!(
        refuse(try_bubblewrap_plan(shell)),
        BubblewrapPlanError::Command(CommandPlanError::ShellExecutable)
    );
}

#[test]
fn contained_spawn_is_refused_and_bwrap_is_not_executed() {
    let boundary = contained_spawn_boundary();
    assert_eq!(boundary, LinuxSpawnBoundary::ProcessOwnershipIncomplete);
    assert_eq!(
        boundary.to_string(),
        "linux containment spawn refused: process ownership incomplete; bwrap is not executed"
    );
}

#[test]
fn secret_service_and_login1_descriptors_are_not_live_passes() {
    let secret = secret_service_descriptor();
    assert_eq!(secret.bus_name, "org.freedesktop.secrets");
    assert_eq!(secret.api, maia_linux::SecretServiceApi::V2);
    assert_eq!(secret.reachable, CapabilityObservation::Unknown);

    let sources = linux_event_sources();
    assert!(sources.iter().any(|source| source.name == "LockedHint"));
    assert!(
        sources
            .iter()
            .any(|source| source.name == "PrepareForSleep")
    );
    assert!(
        sources
            .iter()
            .all(|source| { source.subsystem.starts_with("org.freedesktop.login1") })
    );
}

#[test]
fn pty_plan_uses_the_posix_call_order() {
    let plan = claim(pty_plan(maia_containment::PtySize { cols: 80, rows: 24 }));
    assert_eq!(plan.posix_calls().map(|calls| calls.len()), Some(3));
    assert!(!plan.inherits_browser_handles());
}
