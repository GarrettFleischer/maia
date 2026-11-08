//! macOS fail-closed containment, event sources, and the POSIX PTY plan.

use maia_containment::{
    CONTAINMENT_ADAPTER_VERSION, CONTAINMENT_PROBE_SCHEMA, CapabilityObservation,
    ContainmentCapability, ContainmentFailure, ContainmentVerdict, PlatformKind, PosixPtyCall,
    ProbeIdentity, ProbeVersion, ReportPurpose, TerminalNeed, Timestamp, containment_verdict,
    required_capabilities,
};
use maia_macos::{
    DeprecatedTool, MacosProbeInput, interpret_macos_probe, keychain_descriptor,
    macos_event_sources, pty_plan,
};

fn claim<T, E: std::fmt::Debug>(result: Result<T, E>) -> T {
    match result {
        Ok(value) => value,
        Err(err) => panic!("expected ok, got {err:?}"),
    }
}

fn spawn_input(os_major: u32) -> MacosProbeInput {
    MacosProbeInput {
        os_major,
        sandbox_exec: DeprecatedTool::Present,
        endpoint_security: DeprecatedTool::Present,
        identity: ProbeIdentity {
            version: ProbeVersion {
                schema: CONTAINMENT_PROBE_SCHEMA,
                adapter: CONTAINMENT_ADAPTER_VERSION,
            },
            purpose: ReportPurpose::Spawn { generation: 4 },
            observed_at: Timestamp(50),
        },
    }
}

#[test]
fn arbitrary_unattended_containment_stays_unavailable_on_macos() {
    for os_major in [12, 13, 14, 15] {
        let probed = interpret_macos_probe(spawn_input(os_major));
        assert_eq!(probed.os_major, os_major);
        let report = probed.shared;
        assert_eq!(
            report
                .observations
                .get(&ContainmentCapability::ArbitraryUnattendedProcess),
            Some(&CapabilityObservation::Unavailable)
        );
        assert_eq!(
            report
                .observations
                .get(&ContainmentCapability::DeprecatedSandboxExec),
            Some(&CapabilityObservation::Deprecated)
        );
        assert_eq!(
            report
                .observations
                .get(&ContainmentCapability::EndpointSecurity),
            Some(&CapabilityObservation::Deprecated)
        );
        assert!(
            report
                .observations
                .values()
                .all(|observation| { *observation != CapabilityObservation::Present })
        );
        let required = required_capabilities(
            PlatformKind::MacOs,
            TerminalNeed::Required,
            4,
            Timestamp(50),
            30,
        );
        assert_eq!(
            containment_verdict(&report, &required),
            ContainmentVerdict::NeedsHuman(ContainmentFailure::UnsupportedPlatform {
                platform: PlatformKind::MacOs,
            })
        );
    }
}

#[test]
fn absent_deprecated_tools_are_missing_and_still_not_a_pass() {
    let mut input = spawn_input(14);
    input.sandbox_exec = DeprecatedTool::Absent;
    input.endpoint_security = DeprecatedTool::Absent;
    let report = interpret_macos_probe(input).shared;
    assert_eq!(
        report
            .observations
            .get(&ContainmentCapability::DeprecatedSandboxExec),
        Some(&CapabilityObservation::Missing)
    );
    assert_eq!(
        report
            .observations
            .get(&ContainmentCapability::EndpointSecurity),
        Some(&CapabilityObservation::Missing)
    );
    assert_eq!(
        report
            .observations
            .get(&ContainmentCapability::ArbitraryUnattendedProcess),
        Some(&CapabilityObservation::Unavailable)
    );
}

#[test]
fn screen_lock_and_sleep_sources_are_descriptors_only() {
    let sources = macos_event_sources();
    assert!(sources.iter().any(|source| {
        source.name == "com.apple.screenIsLocked" && source.subsystem == "distributed-notification"
    }));
    assert!(sources.iter().any(|source| {
        source.name == "NSWorkspaceWillSleepNotification" && source.subsystem == "NSWorkspace"
    }));
}

#[test]
fn pty_plan_names_posix_openpt_grantpt_and_unlockpt() {
    let plan = claim(pty_plan(maia_containment::PtySize {
        cols: 120,
        rows: 40,
    }));
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

#[test]
fn keychain_descriptor_does_not_claim_a_live_store() {
    let descriptor = keychain_descriptor();
    assert_eq!(
        descriptor.store,
        maia_containment::NativeCredentialStore::MacOsKeychain
    );
    assert!(descriptor.bus_name.is_none());
}
