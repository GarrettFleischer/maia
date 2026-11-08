#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Shared containment capability reports and admission types (`13-platform.md`).
//!
//! This crate performs no I/O. Platform adapters translate OS primitives into these types.
//! A startup report is display data. Only a fresh spawn report can authorize a launch.

mod cancel;
mod command;
mod event;
mod pty;
mod verdict;

pub use cancel::{
    CancellationClassification, CancellationInput, CancellationReason, CgroupOwnership,
    ExternalEffects, JobOwnership, OwnershipEvidence, ProcessTreeDisposition, ProcessTreeId,
    RecordedOutcome, ThreadFollowUp, TreeCancelPlan, classify_cancellation, plan_tree_cancellation,
};
pub use command::{
    ChildPlanError, CommandPlan, CommandPlanError, EnvPlan, EnvPlanError,
    command_excludes_chrome_profile, path_lies_in_chrome_profile, try_command_plan, try_env_plan,
};
pub use event::{
    EventSourceDescriptor, PlatformEvent, PlatformEventKind, PlatformEventSource,
    classify_platform_event,
};
pub use pty::{
    POSIX_PTY_CALLS, PosixPtyCall, PtyBackendKind, PtyCreatePlan, PtyPlanError, PtySize,
    plan_pty_creation,
};
pub use verdict::{
    CONTAINMENT_ADAPTER_VERSION, CONTAINMENT_PROBE_SCHEMA, CapabilityObservation, CapabilityReport,
    ContainmentCapability, ContainmentFailure, ContainmentVerdict, CredentialStoreDescriptor,
    KernelVersion, LandlockAbi, LinuxProbeFacts, MalformedReport, NativeCredentialStore,
    PlatformKind, ProbeIdentity, ProbeVersion, ReportPurpose, RequiredCapabilities,
    SECRET_SERVICE_BUS_NAME, SecretServiceApi, StaleReport, TerminalNeed, assess_probe_freshness,
    containment_verdict, kernel_observation, landlock_observation, required_capabilities,
};

/// Caller-supplied unix timestamp in seconds. Containment code never reads a clock.
pub use maia_core::audit::Timestamp;
