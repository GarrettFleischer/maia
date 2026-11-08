//! Event, credential, and PTY descriptors. None of these subscribe or open a device.

use maia_containment::{
    CapabilityObservation, EventSourceDescriptor, PlatformEventSource, PlatformKind, PtyCreatePlan,
    PtyPlanError, PtySize, SECRET_SERVICE_BUS_NAME, plan_pty_creation,
};

use crate::SecretServiceApi;

/// Secret Service identity. `reachable` stays unknown until a live bus probe exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SecretServiceDescriptor {
    /// Well-known bus name.
    pub bus_name: &'static str,
    /// API generation.
    pub api: SecretServiceApi,
    /// This slice does not talk to D-Bus, so reachability is unknown.
    pub reachable: CapabilityObservation,
}

/// Descriptor for `org.freedesktop.secrets`. This does not connect.
pub fn secret_service_descriptor() -> SecretServiceDescriptor {
    SecretServiceDescriptor {
        bus_name: SECRET_SERVICE_BUS_NAME,
        api: SecretServiceApi::V2,
        reachable: CapabilityObservation::Unknown,
    }
}

/// login1 lock and sleep sources. This does not subscribe.
pub fn linux_event_sources() -> &'static [EventSourceDescriptor] {
    const SOURCES: [EventSourceDescriptor; 2] = [
        EventSourceDescriptor {
            source: PlatformEventSource::LinuxLockedHint,
            subsystem: "org.freedesktop.login1.Session",
            name: "LockedHint",
        },
        EventSourceDescriptor {
            source: PlatformEventSource::LinuxPrepareForSleep,
            subsystem: "org.freedesktop.login1.Manager",
            name: "PrepareForSleep",
        },
    ];
    &SOURCES
}

/// POSIX PTY plan. `posix_openpt` is not called.
pub fn pty_plan(size: PtySize) -> Result<PtyCreatePlan, PtyPlanError> {
    plan_pty_creation(PlatformKind::Linux, size)
}
