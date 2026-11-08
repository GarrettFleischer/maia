//! Fail-closed macOS containment report.

use std::collections::BTreeMap;

use maia_containment::{
    CapabilityObservation, CapabilityReport, ContainmentCapability, PlatformKind, ProbeIdentity,
};

/// Whether a deprecated tool is installed. Installation is not readiness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeprecatedTool {
    /// The tool was not observed.
    Absent,
    /// The tool was observed and must be recorded as deprecated.
    Present,
}

/// Inputs for a macOS probe. `os_major` is recorded and does not grant readiness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MacosProbeInput {
    /// Major macOS version supplied by the caller.
    pub os_major: u32,
    /// `sandbox-exec` observation.
    pub sandbox_exec: DeprecatedTool,
    /// Endpoint Security observation.
    pub endpoint_security: DeprecatedTool,
    /// Caller-supplied identity. No clock is read here.
    pub identity: ProbeIdentity,
}

/// Interpreted macOS probe. `shared` never authorizes arbitrary unattended processes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacosProbeReport {
    /// Report consumed by [`maia_containment::containment_verdict`].
    pub shared: CapabilityReport,
    /// Recorded OS major version. It is not a containment capability.
    pub os_major: u32,
}

/// Build a report that marks arbitrary process containment unavailable.
pub fn interpret_macos_probe(input: MacosProbeInput) -> MacosProbeReport {
    let mut observations = BTreeMap::new();
    observations.insert(
        ContainmentCapability::ArbitraryUnattendedProcess,
        CapabilityObservation::Unavailable,
    );
    observations.insert(
        ContainmentCapability::DeprecatedSandboxExec,
        deprecated_observation(input.sandbox_exec),
    );
    observations.insert(
        ContainmentCapability::EndpointSecurity,
        deprecated_observation(input.endpoint_security),
    );
    MacosProbeReport {
        shared: CapabilityReport {
            platform: PlatformKind::MacOs,
            version: input.identity.version,
            purpose: input.identity.purpose,
            observed_at: input.identity.observed_at,
            observations,
            linux: None,
        },
        os_major: input.os_major,
    }
}

fn deprecated_observation(tool: DeprecatedTool) -> CapabilityObservation {
    match tool {
        DeprecatedTool::Present => CapabilityObservation::Deprecated,
        DeprecatedTool::Absent => CapabilityObservation::Missing,
    }
}
