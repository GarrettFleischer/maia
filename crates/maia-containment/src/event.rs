//! Platform lock and suspend event classification.

/// OS signal a credential-lock skin may subscribe to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlatformEventSource {
    /// Windows `WTS_SESSION_LOCK`.
    WindowsSessionLock,
    /// Windows `PBT_APMSUSPEND`.
    WindowsSuspend,
    /// Linux `org.freedesktop.login1.Session` `LockedHint`.
    LinuxLockedHint,
    /// Linux `PrepareForSleep`.
    LinuxPrepareForSleep,
    /// macOS `com.apple.screenIsLocked`.
    MacOsScreenIsLocked,
    /// macOS `NSWorkspaceWillSleepNotification`.
    MacOsWillSleep,
}

/// Lock or suspend, for the encrypted-file idle contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlatformEventKind {
    /// Session or screen lock.
    Lock,
    /// Suspend or sleep.
    Suspend,
}

/// Classified platform event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PlatformEvent {
    /// Source that produced the event.
    pub source: PlatformEventSource,
    /// Lock or suspend.
    pub kind: PlatformEventKind,
}

/// Static description of an event source. Subscribing is the adapter's job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EventSourceDescriptor {
    /// Classified source.
    pub source: PlatformEventSource,
    /// OS subsystem or interface name.
    pub subsystem: &'static str,
    /// Signal or notification name.
    pub name: &'static str,
}

/// Map a known source to lock or suspend. There is no third kind.
pub fn classify_platform_event(source: PlatformEventSource) -> PlatformEvent {
    let kind = match source {
        PlatformEventSource::WindowsSessionLock
        | PlatformEventSource::LinuxLockedHint
        | PlatformEventSource::MacOsScreenIsLocked => PlatformEventKind::Lock,
        PlatformEventSource::WindowsSuspend
        | PlatformEventSource::LinuxPrepareForSleep
        | PlatformEventSource::MacOsWillSleep => PlatformEventKind::Suspend,
    };
    PlatformEvent { source, kind }
}
