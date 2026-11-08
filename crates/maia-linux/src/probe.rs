//! Pure Linux probe interpretation.

use std::collections::BTreeMap;

use maia_containment::{
    CapabilityObservation, CapabilityReport, ContainmentCapability, KernelVersion, LandlockAbi,
    LinuxProbeFacts, PlatformKind, ProbeIdentity, kernel_observation, landlock_observation,
};

/// Secret Service API generation named by the descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretServiceApi {
    /// org.freedesktop.secrets API v2.
    V2,
}

/// Evidence collected by a future I/O skin. This function does not read `/proc`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxProbeInput {
    /// Kernel version.
    pub kernel: KernelVersion,
    /// User-namespace evidence.
    pub user_namespaces: CapabilityObservation,
    /// bubblewrap evidence.
    pub bubblewrap: CapabilityObservation,
    /// seccomp evidence.
    pub seccomp: CapabilityObservation,
    /// Landlock ABI evidence.
    pub landlock: LandlockAbi,
    /// cgroup v2 evidence.
    pub cgroup_v2: CapabilityObservation,
    /// Fresh devpts evidence.
    pub fresh_devpts: CapabilityObservation,
    /// Caller-supplied probe identity. No clock is read here.
    pub identity: ProbeIdentity,
}

/// Translate probe evidence into a capability report.
///
/// Kernel and Landlock observations come from the version and ABI. Other controls are copied
/// and never upgraded to [`CapabilityObservation::Present`].
pub fn interpret_linux_probe(input: LinuxProbeInput) -> CapabilityReport {
    let mut observations = BTreeMap::new();
    observations.insert(
        ContainmentCapability::KernelAtLeast6_4,
        kernel_observation(input.kernel),
    );
    observations.insert(ContainmentCapability::UserNamespaces, input.user_namespaces);
    observations.insert(ContainmentCapability::Bubblewrap, input.bubblewrap);
    observations.insert(ContainmentCapability::Seccomp, input.seccomp);
    observations.insert(
        ContainmentCapability::LandlockAbiAtLeast6,
        landlock_observation(input.landlock),
    );
    observations.insert(ContainmentCapability::CgroupV2, input.cgroup_v2);
    observations.insert(ContainmentCapability::FreshDevpts, input.fresh_devpts);
    let landlock_abi = match input.landlock {
        LandlockAbi::Version(version) => Some(version),
        LandlockAbi::Unknown | LandlockAbi::Missing => None,
    };
    CapabilityReport {
        platform: PlatformKind::Linux,
        version: input.identity.version,
        purpose: input.identity.purpose,
        observed_at: input.identity.observed_at,
        observations,
        linux: Some(LinuxProbeFacts {
            kernel: input.kernel,
            landlock_abi,
        }),
    }
}
