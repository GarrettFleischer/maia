//! Windows containment plans and host wrappers. FFI checks run only on Windows.

use std::collections::BTreeSet;

use maia_containment::{
    CONTAINMENT_ADAPTER_VERSION, CONTAINMENT_PROBE_SCHEMA, CapabilityObservation,
    ContainmentCapability, ContainmentFailure, ContainmentVerdict, NativeCredentialStore,
    PlatformKind, ProbeIdentity, ProbeVersion, ReportPurpose, TerminalNeed, Timestamp,
    containment_verdict, required_capabilities,
};
use maia_windows::{
    ChromePipePlanError, WindowsFailure, WindowsProbeInput, chrome_pipe_dacl, create_lpac_profile,
    credential_manager_descriptor, interpret_windows_probe, pty_plan, try_chrome_pipe_plan,
    try_job_limit_plan, try_lpac_plan, windows_event_sources,
};

fn claim<T, E: std::fmt::Debug>(result: Result<T, E>) -> T {
    match result {
        Ok(value) => value,
        Err(err) => panic!("expected ok, got {err:?}"),
    }
}

fn refuse<T, E>(result: Result<T, E>) -> E {
    match result {
        Ok(_) => panic!("expected error"),
        Err(err) => err,
    }
}

fn identity() -> ProbeIdentity {
    ProbeIdentity {
        version: ProbeVersion {
            schema: CONTAINMENT_PROBE_SCHEMA,
            adapter: CONTAINMENT_ADAPTER_VERSION,
        },
        purpose: ReportPurpose::Spawn { generation: 3 },
        observed_at: Timestamp(10),
    }
}

#[test]
fn lpac_creation_stays_fail_closed_without_the_isolation_feature() {
    let missing = refuse(try_lpac_plan(0));
    assert_eq!(missing, maia_windows::LpacPlanError::EmptyProfileId);

    let plan = claim(try_lpac_plan(9));
    assert_eq!(plan.network(), maia_windows::NetworkGrant::None);
    let err = refuse(create_lpac_profile(&plan));
    let rendered = format!("{err} {err:?}");
    assert_eq!(err, WindowsFailure::AppContainerNotLinked);
    assert!(!rendered.contains('\\'));
    assert!(!rendered.contains("profile"));
}

#[test]
fn interpreter_preserves_unavailable_lpac_and_does_not_pass() {
    let report = interpret_windows_probe(WindowsProbeInput {
        lpac: CapabilityObservation::Unavailable,
        kill_on_close_job: CapabilityObservation::Present,
        assign_before_resume: CapabilityObservation::Present,
        conpty: CapabilityObservation::Present,
        identity: identity(),
    });
    let required = required_capabilities(
        PlatformKind::Windows,
        TerminalNeed::Required,
        3,
        Timestamp(10),
        30,
    );
    assert_eq!(
        containment_verdict(&report, &required),
        ContainmentVerdict::NeedsHuman(ContainmentFailure::Capability {
            capability: ContainmentCapability::LpacAppContainer,
            observation: CapabilityObservation::Unavailable,
        })
    );
}

#[test]
fn hypothetical_complete_evidence_matches_the_windows_matrix() {
    let report = interpret_windows_probe(WindowsProbeInput {
        lpac: CapabilityObservation::Present,
        kill_on_close_job: CapabilityObservation::Present,
        assign_before_resume: CapabilityObservation::Present,
        conpty: CapabilityObservation::Present,
        identity: identity(),
    });
    let required = required_capabilities(
        PlatformKind::Windows,
        TerminalNeed::Required,
        3,
        Timestamp(10),
        30,
    );
    assert_eq!(
        report.observations.keys().copied().collect::<BTreeSet<_>>(),
        required.capabilities.clone()
    );
    assert!(matches!(
        containment_verdict(&report, &required),
        ContainmentVerdict::UnattendedReady(_)
    ));
}

#[test]
fn chrome_pipe_plan_rejects_profile_material_and_dacl_is_owner_only() {
    let dacl = chrome_pipe_dacl();
    assert!(dacl.contains("OW"));
    assert!(!dacl.contains("WD"));
    assert!(!dacl.contains("AC"));
    assert!(!dacl.contains("S-1-15-2"));

    let plan = claim(try_chrome_pipe_plan("maia-containment-1"));
    assert!(!plan.grants_everyone());
    assert!(!plan.grants_all_application_packages());

    let err = refuse(try_chrome_pipe_plan("sentinel-profile-9f3a\\Cookies"));
    let rendered = format!("{err} {err:?}");
    assert_eq!(err, ChromePipePlanError::ProfileOrCredentialMaterial);
    assert!(!rendered.contains("sentinel-profile-9f3a"));
    assert!(!rendered.contains("Cookies"));
}

#[test]
fn event_and_credential_descriptors_name_the_os_sources() {
    let sources = windows_event_sources();
    assert!(
        sources
            .iter()
            .any(|source| source.name == "WTS_SESSION_LOCK")
    );
    assert!(sources.iter().any(|source| source.name == "PBT_APMSUSPEND"));
    let credential = credential_manager_descriptor();
    assert_eq!(
        credential.store,
        NativeCredentialStore::WindowsCredentialManager
    );
    assert!(credential.bus_name.is_none());
}

#[test]
fn pty_plan_selects_conpty_without_inherited_browser_handles() {
    let plan = claim(pty_plan(maia_containment::PtySize { cols: 80, rows: 24 }));
    assert!(plan.posix_calls().is_none());
    assert!(!plan.inherits_browser_handles());
}

#[test]
fn job_limit_plan_rejects_a_zero_cpu_cap() {
    assert!(try_job_limit_plan(4, 1024 * 1024, 0).is_err());
    assert!(try_job_limit_plan(4, 1024 * 1024, 50).is_ok());
}

#[cfg(windows)]
mod host {
    use super::{claim, refuse};

    use maia_containment::{CapabilityObservation, PlatformKind, PtySize, try_command_plan};
    use maia_windows::{
        BreakawayFlag, ClipboardFlag, CredentialError, KillOnCloseFlag,
        collect_windows_host_evidence, create_conpty, create_kill_on_close_job,
        create_parent_owned_chrome_pipe, delete_session_credential, read_session_credential,
        try_job_limit_plan, write_local_credential, write_session_credential,
    };

    #[test]
    fn host_probe_demonstrates_job_and_conpty_and_keeps_lpac_unavailable() {
        let evidence = collect_windows_host_evidence();
        assert_eq!(evidence.lpac, CapabilityObservation::Unavailable);
        assert_eq!(
            evidence.assign_before_resume,
            CapabilityObservation::Unknown
        );
        assert_eq!(evidence.kill_on_close_job, CapabilityObservation::Present);
        assert_eq!(evidence.conpty, CapabilityObservation::Present);
    }

    #[test]
    fn job_assigns_before_resume_and_kills_on_close() {
        let plan = claim(try_job_limit_plan(8, 256 * 1024 * 1024, 25));
        let job = claim(create_kill_on_close_job(&plan));
        let limits = claim(job.observed_limits());
        assert_eq!(limits.kill_on_close, KillOnCloseFlag::Set);
        assert_eq!(limits.breakaway, BreakawayFlag::Denied);
        assert_eq!(limits.clipboard, ClipboardFlag::Denied);
        assert_eq!(limits.active_process_limit, 8);
        assert_eq!(limits.cpu_rate_percent, 25);

        let root = match std::env::var("SystemRoot") {
            Ok(root) => root,
            Err(err) => panic!("SystemRoot missing: {err}"),
        };
        let executable = format!("{root}\\System32\\ping.exe");
        let command = claim(try_command_plan(
            PlatformKind::Windows,
            &executable,
            &["-n", "30", "127.0.0.1"],
        ));
        let assigned = claim(job.spawn_assigned_suspended(&command));
        let ids = claim(job.assigned_process_ids());
        assert!(ids.contains(&assigned.process_id()));
        let running = claim(assigned.resume());
        assert!(running.previous_suspend_count() >= 1);
        assert!(claim(running.is_still_active()));
        drop(job);
        claim(running.wait_until_exited(5_000));
        assert!(!claim(running.is_still_active()));
    }

    #[test]
    fn process_create_failure_omits_the_executable_path() {
        let plan = claim(try_job_limit_plan(4, 64 * 1024 * 1024, 10));
        let job = claim(create_kill_on_close_job(&plan));
        let missing = "C:\\maia-sentinel-path-do-not-leak\\nope.exe";
        let command = claim(try_command_plan(PlatformKind::Windows, missing, &[]));
        let err = refuse(job.spawn_assigned_suspended(&command));
        let rendered = format!("{err} {err:?}");
        assert!(!rendered.contains("maia-sentinel-path-do-not-leak"));
        assert!(!rendered.contains("nope.exe"));
    }

    #[test]
    fn conpty_opens_and_resizes() {
        let session = claim(create_conpty(PtySize { cols: 80, rows: 24 }));
        claim(session.resize(PtySize {
            cols: 100,
            rows: 40,
        }));
    }

    #[test]
    fn parent_chrome_pipe_is_not_inheritable() {
        let pipe = claim(create_parent_owned_chrome_pipe(std::process::id() as u64));
        assert!(!claim(pipe.inherits_handles()));
    }

    #[test]
    fn credential_manager_round_trip_hides_the_secret_and_target() {
        let absent = format!("MaiaContainmentAbsent-7f3c9a-{}", std::process::id());
        let missing = refuse(read_session_credential(&absent));
        assert_eq!(missing, CredentialError::NotFound);
        assert!(!format!("{missing:?}").contains("7f3c9a"));

        let target = format!("MaiaContainmentProbe-{}", std::process::id());
        let _cleanup = CredentialCleanup {
            target: target.clone(),
        };
        let secret = b"containment-probe-secret";
        claim(write_session_credential(&target, secret));
        let read = claim(read_session_credential(&target));
        let matches_secret = read.as_bytes() == secret;
        drop(read);
        assert!(matches_secret);
        claim(delete_session_credential(&target));
        assert_eq!(
            refuse(read_session_credential(&target)),
            CredentialError::NotFound
        );
    }

    #[test]
    fn local_credential_survives_the_writer_and_stays_out_of_errors() {
        let target = format!("MaiaRouterKeyProbe-{}", std::process::id());
        let _cleanup = CredentialCleanup {
            target: target.clone(),
        };
        let secret = b"router-key-probe";
        claim(write_local_credential(&target, secret));
        let read = claim(read_session_credential(&target));
        let matches_secret = read.as_bytes() == secret;
        drop(read);
        assert!(matches_secret);
        let missing = refuse(read_session_credential(&format!(
            "MaiaRouterKeyAbsent-{}",
            std::process::id()
        )));
        assert_eq!(missing, CredentialError::NotFound);
        assert!(!format!("{missing:?}").contains("router-key-probe"));
        claim(delete_session_credential(&target));
    }

    struct CredentialCleanup {
        target: String,
    }

    impl Drop for CredentialCleanup {
        fn drop(&mut self) {
            let _ = delete_session_credential(&self.target);
        }
    }
}
