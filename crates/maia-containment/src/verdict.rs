//! Deny-by-default containment admission.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::Timestamp;

/// Accepted capability-report schema. Unknown schemas are not a pass.
pub const CONTAINMENT_PROBE_SCHEMA: u32 = 1;

/// Adapter contract version stamped on reports. Zero is malformed.
pub const CONTAINMENT_ADAPTER_VERSION: u32 = 1;

/// Operating system a report or requirement describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PlatformKind {
    /// Windows host.
    Windows,
    /// Linux host.
    Linux,
    /// macOS host. Arbitrary unattended process containment is unavailable.
    MacOs,
}

/// Matrix control named by `13-platform.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ContainmentCapability {
    /// LPAC / AppContainer identity.
    LpacAppContainer,
    /// Job Object configured to kill the tree when the owner handle closes.
    KillOnCloseJob,
    /// Child assigned to that job before its primary thread is resumed.
    AssignBeforeResume,
    /// ConPTY, required only when the spawn needs a terminal.
    ConPty,
    /// Linux kernel 6.4 or newer.
    KernelAtLeast6_4,
    /// User namespaces available to the daemon user.
    UserNamespaces,
    /// bubblewrap helper present.
    Bubblewrap,
    /// seccomp available.
    Seccomp,
    /// Landlock ABI 6 or newer.
    LandlockAbiAtLeast6,
    /// cgroup v2 mounted and usable for ownership.
    CgroupV2,
    /// A private devpts instance, not the host's.
    FreshDevpts,
    /// Blanket unattended-process claim. A report cannot prove this by itself.
    ArbitraryUnattendedProcess,
    /// Deprecated `sandbox-exec`. Presence is never a pass.
    DeprecatedSandboxExec,
    /// Endpoint Security presence. Never a pass.
    EndpointSecurity,
}

/// What a probe established for one capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapabilityObservation {
    /// Proved sufficient for the matrix row.
    Present,
    /// Probed and absent.
    Missing,
    /// Not probed, or the probe could not decide.
    Unknown,
    /// Present only as a deprecated interface.
    Deprecated,
    /// Present but below the required version or ABI.
    Insufficient,
    /// Known not to be available on this adapter.
    Unavailable,
}

/// Schema and adapter versions carried by a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProbeVersion {
    /// Report schema.
    pub schema: u32,
    /// Adapter implementation version.
    pub adapter: u32,
}

/// Why a report was produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReportPurpose {
    /// Health and Settings display. Cannot authorize a spawn.
    Display,
    /// Fresh probe bound to one spawn attempt.
    Spawn {
        /// Spawn generation chosen by the caller.
        generation: u64,
    },
}

/// Parsed Linux kernel version supplied by the probe, not read here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct KernelVersion {
    /// Major component.
    pub major: u32,
    /// Minor component.
    pub minor: u32,
    /// Patch component.
    pub patch: u32,
}

/// Landlock ABI evidence supplied by the probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LandlockAbi {
    /// The probe could not read an ABI.
    Unknown,
    /// Landlock is absent.
    Missing,
    /// Reported ABI number.
    Version(u32),
}

/// Linux facts that must agree with `Present` observations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LinuxProbeFacts {
    /// Kernel version the probe observed.
    pub kernel: KernelVersion,
    /// Landlock ABI, when the probe obtained a number.
    pub landlock_abi: Option<u32>,
}

/// Identity of one probe. The caller supplies time and generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProbeIdentity {
    /// Schema and adapter version.
    pub version: ProbeVersion,
    /// Display snapshot or spawn authorization attempt.
    pub purpose: ReportPurpose,
    /// When the probe ran, in caller-supplied unix seconds.
    pub observed_at: Timestamp,
}

/// Capability evidence. Invalid combinations fail closed in [`containment_verdict`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityReport {
    /// Platform the probe describes.
    pub platform: PlatformKind,
    /// Schema and adapter version.
    pub version: ProbeVersion,
    /// Display or spawn purpose.
    pub purpose: ReportPurpose,
    /// Probe time supplied by the caller.
    pub observed_at: Timestamp,
    /// Observations. A missing key is [`CapabilityObservation::Unknown`].
    pub observations: BTreeMap<ContainmentCapability, CapabilityObservation>,
    /// Linux kernel and Landlock facts. Required on Linux and forbidden elsewhere.
    pub linux: Option<LinuxProbeFacts>,
}

/// Whether this spawn needs a terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TerminalNeed {
    /// Headless spawn. Windows does not require ConPTY.
    NotRequired,
    /// Terminal spawn. Windows requires ConPTY.
    Required,
}

/// Capabilities a spawn must have already proved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequiredCapabilities {
    /// Platform that will run the spawn.
    pub platform: PlatformKind,
    /// Non-empty set required for this spawn. Empty is denied.
    pub capabilities: BTreeSet<ContainmentCapability>,
    /// Generation that must match [`ReportPurpose::Spawn`].
    pub spawn_generation: u64,
    /// Schema the daemon currently accepts.
    pub accepted_schema: u32,
    /// Caller-supplied evaluation time, in unix seconds.
    pub evaluated_at: Timestamp,
    /// Maximum age in seconds. Age equal to this value is still fresh.
    pub max_age_secs: u64,
}

/// Admission result. Only a fresh, sufficient report is ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContainmentVerdict {
    /// Every required capability was proved on a fresh spawn report.
    UnattendedReady(CapabilityReport),
    /// Fail closed. The failure carries no host path.
    NeedsHuman(ContainmentFailure),
}

/// Why unattended containment was denied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainmentFailure {
    /// The report contradicts itself or omits a required fact.
    Malformed(MalformedReport),
    /// The report is older than this spawn or bound to another generation.
    Stale(StaleReport),
    /// A display snapshot was offered as spawn authorization.
    DisplayOnly,
    /// Report platform and required platform differ.
    PlatformMismatch {
        /// Platform written on the report.
        report: PlatformKind,
        /// Platform required for the spawn.
        required: PlatformKind,
    },
    /// No capability was required, so nothing was proved.
    EmptyRequirement,
    /// The platform cannot authorize arbitrary unattended processes.
    UnsupportedPlatform {
        /// Platform that cannot pass.
        platform: PlatformKind,
    },
    /// A required capability was not `Present`.
    Capability {
        /// Capability that failed.
        capability: ContainmentCapability,
        /// Observation, or `Unknown` when the key was absent.
        observation: CapabilityObservation,
    },
    /// Schema is non-zero and not the accepted schema.
    UnsupportedSchema {
        /// Schema found on the report.
        schema: u32,
    },
}

/// Structural report failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MalformedReport {
    /// Schema version zero.
    SchemaUnset,
    /// Adapter version zero.
    AdapterUnset,
    /// `observed_at` is later than the evaluation time.
    FutureObservation,
    /// Subtracting the timestamps overflowed.
    TimestampOverflow,
    /// Linux facts were attached to a non-Linux report.
    FactsOnWrongPlatform,
    /// A Linux report omitted kernel and Landlock facts.
    MissingLinuxFacts,
    /// A `Present` observation disagrees with the Linux facts.
    LinuxFactsContradict {
        /// Capability whose facts disagree.
        capability: ContainmentCapability,
    },
    /// A `Present` observation belongs to another platform.
    ForeignCapability {
        /// Capability that does not belong on this platform.
        capability: ContainmentCapability,
    },
    /// A deprecated API was marked `Present`.
    DeprecatedMarkedPresent {
        /// Deprecated capability.
        capability: ContainmentCapability,
    },
    /// `ArbitraryUnattendedProcess` was marked `Present`.
    NotAProbeResult {
        /// Capability that is not a probe primitive.
        capability: ContainmentCapability,
    },
}

/// Freshness failures for an otherwise well-formed report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaleReport {
    /// Spawn generation does not match the report.
    GenerationMismatch,
    /// The report is older than `max_age_secs`.
    Expired,
}

/// Native credential store named by a platform adapter. This is not a liveness probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NativeCredentialStore {
    /// Windows Credential Manager.
    WindowsCredentialManager,
    /// macOS Keychain.
    MacOsKeychain,
    /// Linux Secret Service API.
    LinuxSecretService,
}

/// Secret Service API generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretServiceApi {
    /// `org.freedesktop.secrets` API v2.
    V2,
}

/// Bus name for [`SecretServiceApi::V2`].
pub const SECRET_SERVICE_BUS_NAME: &str = "org.freedesktop.secrets";

/// Descriptor of the native store for a platform. Reachability is a separate probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CredentialStoreDescriptor {
    /// Which store the adapter implements.
    pub store: NativeCredentialStore,
    /// D-Bus name when the store is Secret Service.
    pub bus_name: Option<&'static str>,
}

impl fmt::Display for ContainmentFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(reason) => {
                write!(formatter, "malformed containment report: {reason:?}")
            }
            Self::Stale(reason) => write!(formatter, "stale containment report: {reason:?}"),
            Self::DisplayOnly => formatter.write_str("display report cannot authorize a spawn"),
            Self::PlatformMismatch { report, required } => {
                write!(
                    formatter,
                    "platform mismatch: {report:?} required {required:?}"
                )
            }
            Self::EmptyRequirement => formatter.write_str("empty containment requirement"),
            Self::UnsupportedPlatform { platform } => {
                write!(formatter, "unsupported containment platform: {platform:?}")
            }
            Self::Capability {
                capability,
                observation,
            } => write!(formatter, "capability {capability:?} is {observation:?}"),
            Self::UnsupportedSchema { schema } => {
                write!(formatter, "unsupported containment schema {schema}")
            }
        }
    }
}

impl std::error::Error for ContainmentFailure {}

/// Kernel 6.4.0 is sufficient. `0.0.0` is unknown. Older versions are insufficient.
pub fn kernel_observation(version: KernelVersion) -> CapabilityObservation {
    if version.major == 0 && version.minor == 0 && version.patch == 0 {
        return CapabilityObservation::Unknown;
    }
    if (version.major, version.minor, version.patch) >= (6, 4, 0) {
        CapabilityObservation::Present
    } else {
        CapabilityObservation::Insufficient
    }
}

/// Landlock ABI 6 is the minimum that counts as present.
pub fn landlock_observation(abi: LandlockAbi) -> CapabilityObservation {
    match abi {
        LandlockAbi::Unknown => CapabilityObservation::Unknown,
        LandlockAbi::Missing => CapabilityObservation::Missing,
        LandlockAbi::Version(version) if version >= 6 => CapabilityObservation::Present,
        LandlockAbi::Version(_) => CapabilityObservation::Insufficient,
    }
}

/// Matrix requirements for one platform and terminal need.
pub fn required_capabilities(
    platform: PlatformKind,
    terminal: TerminalNeed,
    spawn_generation: u64,
    evaluated_at: Timestamp,
    max_age_secs: u64,
) -> RequiredCapabilities {
    let mut capabilities = BTreeSet::new();
    match (platform, terminal) {
        (PlatformKind::Windows, TerminalNeed::Required) => {
            insert_windows_base(&mut capabilities);
            capabilities.insert(ContainmentCapability::ConPty);
        }
        (PlatformKind::Windows, TerminalNeed::NotRequired) => {
            insert_windows_base(&mut capabilities);
        }
        (PlatformKind::Linux, _) => {
            capabilities.extend([
                ContainmentCapability::KernelAtLeast6_4,
                ContainmentCapability::UserNamespaces,
                ContainmentCapability::Bubblewrap,
                ContainmentCapability::Seccomp,
                ContainmentCapability::LandlockAbiAtLeast6,
                ContainmentCapability::CgroupV2,
                ContainmentCapability::FreshDevpts,
            ]);
        }
        (PlatformKind::MacOs, _) => {
            capabilities.insert(ContainmentCapability::ArbitraryUnattendedProcess);
        }
    }
    RequiredCapabilities {
        platform,
        capabilities,
        spawn_generation,
        accepted_schema: CONTAINMENT_PROBE_SCHEMA,
        evaluated_at,
        max_age_secs,
    }
}

fn insert_windows_base(capabilities: &mut BTreeSet<ContainmentCapability>) {
    capabilities.insert(ContainmentCapability::LpacAppContainer);
    capabilities.insert(ContainmentCapability::KillOnCloseJob);
    capabilities.insert(ContainmentCapability::AssignBeforeResume);
}

/// Schema, age, generation, and purpose checks. Time comes only from the arguments.
pub fn assess_probe_freshness(
    report: &CapabilityReport,
    required: &RequiredCapabilities,
) -> Result<(), ContainmentFailure> {
    if report.version.schema == 0 {
        return Err(ContainmentFailure::Malformed(MalformedReport::SchemaUnset));
    }
    if report.version.adapter == 0 {
        return Err(ContainmentFailure::Malformed(MalformedReport::AdapterUnset));
    }
    if report.version.schema != required.accepted_schema {
        return Err(ContainmentFailure::UnsupportedSchema {
            schema: report.version.schema,
        });
    }
    match required.evaluated_at.0.checked_sub(report.observed_at.0) {
        None => {
            return Err(ContainmentFailure::Malformed(
                MalformedReport::TimestampOverflow,
            ));
        }
        Some(age) if age < 0 => {
            return Err(ContainmentFailure::Malformed(
                MalformedReport::FutureObservation,
            ));
        }
        Some(age) => {
            let Ok(age) = u64::try_from(age) else {
                return Err(ContainmentFailure::Malformed(
                    MalformedReport::TimestampOverflow,
                ));
            };
            if age > required.max_age_secs {
                return Err(ContainmentFailure::Stale(StaleReport::Expired));
            }
        }
    }
    match report.purpose {
        ReportPurpose::Display => Err(ContainmentFailure::DisplayOnly),
        ReportPurpose::Spawn { generation } if generation != required.spawn_generation => {
            Err(ContainmentFailure::Stale(StaleReport::GenerationMismatch))
        }
        ReportPurpose::Spawn { .. } => Ok(()),
    }
}

/// Deny-by-default admission. Unknown, missing, deprecated, and insufficient evidence are `NeedsHuman`.
pub fn containment_verdict(
    report: &CapabilityReport,
    required: &RequiredCapabilities,
) -> ContainmentVerdict {
    if let Err(failure) = assess_probe_freshness(report, required) {
        return ContainmentVerdict::NeedsHuman(failure);
    }
    if let Err(failure) = reject_inconsistent_report(report) {
        return ContainmentVerdict::NeedsHuman(failure);
    }
    if report.platform == PlatformKind::MacOs || required.platform == PlatformKind::MacOs {
        return ContainmentVerdict::NeedsHuman(ContainmentFailure::UnsupportedPlatform {
            platform: PlatformKind::MacOs,
        });
    }
    if report.platform != required.platform {
        return ContainmentVerdict::NeedsHuman(ContainmentFailure::PlatformMismatch {
            report: report.platform,
            required: required.platform,
        });
    }
    if required.capabilities.is_empty() {
        return ContainmentVerdict::NeedsHuman(ContainmentFailure::EmptyRequirement);
    }
    for capability in &required.capabilities {
        let observation = report
            .observations
            .get(capability)
            .copied()
            .unwrap_or(CapabilityObservation::Unknown);
        if never_authorizes(*capability) || observation != CapabilityObservation::Present {
            return ContainmentVerdict::NeedsHuman(ContainmentFailure::Capability {
                capability: *capability,
                observation,
            });
        }
    }
    ContainmentVerdict::UnattendedReady(report.clone())
}

fn reject_inconsistent_report(report: &CapabilityReport) -> Result<(), ContainmentFailure> {
    if report.platform != PlatformKind::Linux && report.linux.is_some() {
        return Err(ContainmentFailure::Malformed(
            MalformedReport::FactsOnWrongPlatform,
        ));
    }
    if report.platform == PlatformKind::Linux && report.linux.is_none() {
        return Err(ContainmentFailure::Malformed(
            MalformedReport::MissingLinuxFacts,
        ));
    }
    if let Some(facts) = report.linux {
        reject_linux_contradiction(report, facts)?;
    }
    for (capability, observation) in &report.observations {
        if *observation != CapabilityObservation::Present {
            continue;
        }
        if is_deprecated_api(*capability) {
            return Err(ContainmentFailure::Malformed(
                MalformedReport::DeprecatedMarkedPresent {
                    capability: *capability,
                },
            ));
        }
        if *capability == ContainmentCapability::ArbitraryUnattendedProcess {
            return Err(ContainmentFailure::Malformed(
                MalformedReport::NotAProbeResult {
                    capability: *capability,
                },
            ));
        }
        if !capability_belongs_to(*capability, report.platform) {
            return Err(ContainmentFailure::Malformed(
                MalformedReport::ForeignCapability {
                    capability: *capability,
                },
            ));
        }
    }
    Ok(())
}

fn reject_linux_contradiction(
    report: &CapabilityReport,
    facts: LinuxProbeFacts,
) -> Result<(), ContainmentFailure> {
    if report
        .observations
        .get(&ContainmentCapability::KernelAtLeast6_4)
        == Some(&CapabilityObservation::Present)
        && kernel_observation(facts.kernel) != CapabilityObservation::Present
    {
        return Err(ContainmentFailure::Malformed(
            MalformedReport::LinuxFactsContradict {
                capability: ContainmentCapability::KernelAtLeast6_4,
            },
        ));
    }
    let abi = match facts.landlock_abi {
        Some(version) => LandlockAbi::Version(version),
        None => LandlockAbi::Missing,
    };
    if report
        .observations
        .get(&ContainmentCapability::LandlockAbiAtLeast6)
        == Some(&CapabilityObservation::Present)
        && landlock_observation(abi) != CapabilityObservation::Present
    {
        return Err(ContainmentFailure::Malformed(
            MalformedReport::LinuxFactsContradict {
                capability: ContainmentCapability::LandlockAbiAtLeast6,
            },
        ));
    }
    Ok(())
}

fn never_authorizes(capability: ContainmentCapability) -> bool {
    is_deprecated_api(capability) || capability == ContainmentCapability::ArbitraryUnattendedProcess
}

fn is_deprecated_api(capability: ContainmentCapability) -> bool {
    matches!(
        capability,
        ContainmentCapability::DeprecatedSandboxExec | ContainmentCapability::EndpointSecurity
    )
}

fn capability_belongs_to(capability: ContainmentCapability, platform: PlatformKind) -> bool {
    match capability {
        ContainmentCapability::LpacAppContainer
        | ContainmentCapability::KillOnCloseJob
        | ContainmentCapability::AssignBeforeResume
        | ContainmentCapability::ConPty => platform == PlatformKind::Windows,
        ContainmentCapability::KernelAtLeast6_4
        | ContainmentCapability::UserNamespaces
        | ContainmentCapability::Bubblewrap
        | ContainmentCapability::Seccomp
        | ContainmentCapability::LandlockAbiAtLeast6
        | ContainmentCapability::CgroupV2
        | ContainmentCapability::FreshDevpts => platform == PlatformKind::Linux,
        ContainmentCapability::ArbitraryUnattendedProcess
        | ContainmentCapability::DeprecatedSandboxExec
        | ContainmentCapability::EndpointSecurity => true,
    }
}
