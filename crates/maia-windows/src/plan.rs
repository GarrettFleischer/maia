//! Pure Windows plans. These functions do not call Win32.

use std::collections::BTreeMap;

use maia_containment::{
    CapabilityObservation, CapabilityReport, ContainmentCapability, CredentialStoreDescriptor,
    EventSourceDescriptor, NativeCredentialStore, PlatformEventSource, PlatformKind, ProbeIdentity,
    PtyCreatePlan, PtyPlanError, PtySize, plan_pty_creation,
};

use crate::WindowsFailure;

/// Host evidence produced by a Windows probe. LPAC stays unavailable in this slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsHostEvidence {
    /// AppContainer / LPAC.
    pub lpac: CapabilityObservation,
    /// Kill-on-close job creation.
    pub kill_on_close_job: CapabilityObservation,
    /// Assignment before resume. A light probe does not demonstrate this.
    pub assign_before_resume: CapabilityObservation,
    /// ConPTY creation.
    pub conpty: CapabilityObservation,
}

/// Evidence interpreted into a [`CapabilityReport`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsProbeInput {
    /// LPAC evidence.
    pub lpac: CapabilityObservation,
    /// Kill-on-close job evidence.
    pub kill_on_close_job: CapabilityObservation,
    /// Assignment-before-resume evidence.
    pub assign_before_resume: CapabilityObservation,
    /// ConPTY evidence.
    pub conpty: CapabilityObservation,
    /// Caller-supplied identity. No clock is read here.
    pub identity: ProbeIdentity,
}

/// Copy evidence into a report. Observations are not upgraded.
pub fn interpret_windows_probe(input: WindowsProbeInput) -> CapabilityReport {
    let mut observations = BTreeMap::new();
    observations.insert(ContainmentCapability::LpacAppContainer, input.lpac);
    observations.insert(
        ContainmentCapability::KillOnCloseJob,
        input.kill_on_close_job,
    );
    observations.insert(
        ContainmentCapability::AssignBeforeResume,
        input.assign_before_resume,
    );
    observations.insert(ContainmentCapability::ConPty, input.conpty);
    CapabilityReport {
        platform: PlatformKind::Windows,
        version: input.identity.version,
        purpose: input.identity.purpose,
        observed_at: input.identity.observed_at,
        observations,
        linux: None,
    }
}

/// Limits applied to every kill-on-close job. Breakaway and UI access stay denied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobLimitPlan {
    active_process_limit: u32,
    job_memory_bytes: u64,
    cpu_rate_percent: u8,
}

impl JobLimitPlan {
    pub(crate) fn active_process_limit(self) -> u32 {
        self.active_process_limit
    }

    pub(crate) fn job_memory_bytes(self) -> u64 {
        self.job_memory_bytes
    }

    pub(crate) fn cpu_rate_percent(self) -> u8 {
        self.cpu_rate_percent
    }
}

/// Why a job limit plan was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobPlanError {
    /// The active-process limit was zero.
    ActiveProcessLimit,
    /// The memory limit was zero or does not fit `usize`.
    MemoryLimit,
    /// The CPU cap was outside 1..=100.
    CpuRate,
}

/// Build the only job limit plan this adapter will apply.
pub fn try_job_limit_plan(
    active_process_limit: u32,
    job_memory_bytes: u64,
    cpu_rate_percent: u8,
) -> Result<JobLimitPlan, JobPlanError> {
    if active_process_limit == 0 {
        return Err(JobPlanError::ActiveProcessLimit);
    }
    if job_memory_bytes == 0 || usize::try_from(job_memory_bytes).is_err() {
        return Err(JobPlanError::MemoryLimit);
    }
    if cpu_rate_percent == 0 || cpu_rate_percent > 100 {
        return Err(JobPlanError::CpuRate);
    }
    Ok(JobLimitPlan {
        active_process_limit,
        job_memory_bytes,
        cpu_rate_percent,
    })
}

/// Whether kill-on-close was observed on a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillOnCloseFlag {
    /// The kill-on-close bit is set.
    Set,
    /// The kill-on-close bit is absent.
    Absent,
}

/// Whether a job allows breakaway.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakawayFlag {
    /// Breakaway bits are unset.
    Denied,
    /// A breakaway bit is set.
    Allowed,
}

/// Whether a job may use the clipboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardFlag {
    /// Clipboard read and write are restricted.
    Denied,
    /// A clipboard restriction is missing.
    Allowed,
}

/// Limits read back from a live job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobLimitObservation {
    /// Kill-on-close bit.
    pub kill_on_close: KillOnCloseFlag,
    /// Breakaway bits.
    pub breakaway: BreakawayFlag,
    /// Clipboard restrictions.
    pub clipboard: ClipboardFlag,
    /// Active process cap.
    pub active_process_limit: u32,
    /// CPU hard cap in percent.
    pub cpu_rate_percent: u8,
}

/// Network grant recorded on an LPAC plan. v1 has no grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkGrant {
    /// No network capability.
    None,
}

/// One thread's LPAC identity plan. The profile id is not a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LpacPlan {
    profile_id: u64,
}

impl LpacPlan {
    /// Opaque per-thread id.
    pub fn profile_id(self) -> u64 {
        self.profile_id
    }

    /// Network capability. Always none.
    pub fn network(self) -> NetworkGrant {
        NetworkGrant::None
    }
}

/// Why an LPAC plan was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LpacPlanError {
    /// Profile id zero is not a distinct identity.
    EmptyProfileId,
}

/// Accept a non-zero profile id. This does not create a Windows profile.
pub fn try_lpac_plan(profile_id: u64) -> Result<LpacPlan, LpacPlanError> {
    if profile_id == 0 {
        return Err(LpacPlanError::EmptyProfileId);
    }
    Ok(LpacPlan { profile_id })
}

/// LPAC creation is fail-closed until the Isolation API is linked.
pub fn create_lpac_profile(plan: &LpacPlan) -> Result<std::convert::Infallible, WindowsFailure> {
    match plan.network() {
        NetworkGrant::None => Err(WindowsFailure::AppContainerNotLinked),
    }
}

/// Owner-only pipe DACL. `OW` is the owner; Everyone and All Application Packages are absent.
pub fn chrome_pipe_dacl() -> &'static str {
    "D:P(A;;GA;;;OW)"
}

/// Validated Chrome pipe name. The name is not a profile path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChromePipePlan {
    name: String,
}

impl ChromePipePlan {
    /// The DACL grants Everyone.
    pub fn grants_everyone(&self) -> bool {
        false
    }

    /// The DACL grants All Application Packages.
    pub fn grants_all_application_packages(&self) -> bool {
        false
    }

    /// Pipe name token.
    pub fn name(&self) -> &str {
        &self.name
    }
}

/// Why a pipe name was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChromePipePlanError {
    /// The name was empty or too long.
    EmptyName,
    /// The name looks like a path, profile, or credential file.
    ProfileOrCredentialMaterial,
}

impl std::fmt::Display for ChromePipePlanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("pipe plan rejected")
    }
}

impl std::error::Error for ChromePipePlanError {}

/// Reject path-like and credential-like pipe names.
pub fn try_chrome_pipe_plan(name: &str) -> Result<ChromePipePlan, ChromePipePlanError> {
    if name.is_empty() || name.len() > 64 {
        return Err(ChromePipePlanError::EmptyName);
    }
    let upper = name.to_ascii_uppercase();
    if name.contains('\\')
        || name.contains('/')
        || name.contains("..")
        || upper.contains("COOKIE")
        || upper.contains("PROFILE")
        || upper.contains("USER DATA")
    {
        return Err(ChromePipePlanError::ProfileOrCredentialMaterial);
    }
    Ok(ChromePipePlan {
        name: name.to_string(),
    })
}

/// Session-lock and suspend sources. This does not register a window.
pub fn windows_event_sources() -> &'static [EventSourceDescriptor] {
    const SOURCES: [EventSourceDescriptor; 2] = [
        EventSourceDescriptor {
            source: PlatformEventSource::WindowsSessionLock,
            subsystem: "WTS",
            name: "WTS_SESSION_LOCK",
        },
        EventSourceDescriptor {
            source: PlatformEventSource::WindowsSuspend,
            subsystem: "Power",
            name: "PBT_APMSUSPEND",
        },
    ];
    &SOURCES
}

/// Credential Manager descriptor. This does not read a credential.
pub fn credential_manager_descriptor() -> CredentialStoreDescriptor {
    CredentialStoreDescriptor {
        store: NativeCredentialStore::WindowsCredentialManager,
        bus_name: None,
    }
}

/// ConPTY plan. The host module creates the pseudoconsole.
pub fn pty_plan(size: PtySize) -> Result<PtyCreatePlan, PtyPlanError> {
    plan_pty_creation(PlatformKind::Windows, size)
}
