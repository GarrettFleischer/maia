//! Keychain, lock, and PTY descriptors. No Keychain or sandbox call is made.

use maia_containment::{
    CredentialStoreDescriptor, EventSourceDescriptor, NativeCredentialStore, PlatformEventSource,
    PlatformKind, PtyCreatePlan, PtyPlanError, PtySize, plan_pty_creation,
};

/// Keychain is the native store. This descriptor does not open it.
pub fn keychain_descriptor() -> CredentialStoreDescriptor {
    CredentialStoreDescriptor {
        store: NativeCredentialStore::MacOsKeychain,
        bus_name: None,
    }
}

/// Screen-lock and sleep sources. This does not register for notifications.
pub fn macos_event_sources() -> &'static [EventSourceDescriptor] {
    const SOURCES: [EventSourceDescriptor; 2] = [
        EventSourceDescriptor {
            source: PlatformEventSource::MacOsScreenIsLocked,
            subsystem: "distributed-notification",
            name: "com.apple.screenIsLocked",
        },
        EventSourceDescriptor {
            source: PlatformEventSource::MacOsWillSleep,
            subsystem: "NSWorkspace",
            name: "NSWorkspaceWillSleepNotification",
        },
    ];
    &SOURCES
}

/// POSIX PTY plan. `posix_openpt` is not called.
pub fn pty_plan(size: PtySize) -> Result<PtyCreatePlan, PtyPlanError> {
    plan_pty_creation(PlatformKind::MacOs, size)
}
