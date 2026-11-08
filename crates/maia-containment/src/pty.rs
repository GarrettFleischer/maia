//! PTY creation plans. This module does not open a terminal.

use std::fmt;

use crate::PlatformKind;

/// Fixed POSIX PTY call order from `13-platform.md`.
pub const POSIX_PTY_CALLS: [PosixPtyCall; 3] = [
    PosixPtyCall::Openpt,
    PosixPtyCall::Grantpt,
    PosixPtyCall::Unlockpt,
];

/// One POSIX PTY setup call. The adapter performs it; this crate only names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PosixPtyCall {
    /// `posix_openpt`.
    Openpt,
    /// `grantpt`.
    Grantpt,
    /// `unlockpt`.
    Unlockpt,
}

/// Terminal size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PtySize {
    /// Columns.
    pub cols: u16,
    /// Rows.
    pub rows: u16,
}

/// Which PTY backend a platform plan uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PtyBackendKind {
    /// Windows ConPTY.
    ConPty,
    /// POSIX PTY calls in [`POSIX_PTY_CALLS`] order.
    Posix,
}

/// Why a PTY plan was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PtyPlanError {
    /// A dimension was zero.
    ZeroDimension,
}

impl fmt::Display for PtyPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroDimension => formatter.write_str("pty size must be non-zero"),
        }
    }
}

impl std::error::Error for PtyPlanError {}

/// Data-only PTY plan. Browser handles are never inherited.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PtyCreatePlan {
    backend: PtyBackendKind,
    size: PtySize,
}

impl PtyCreatePlan {
    /// Backend selected for the platform.
    pub fn backend(&self) -> PtyBackendKind {
        self.backend
    }

    /// Requested size.
    pub fn size(&self) -> PtySize {
        self.size
    }

    /// POSIX call order, or `None` for ConPTY.
    pub fn posix_calls(&self) -> Option<&'static [PosixPtyCall]> {
        match self.backend {
            PtyBackendKind::ConPty => None,
            PtyBackendKind::Posix => Some(POSIX_PTY_CALLS.as_slice()),
        }
    }

    /// Browser and profile handles are not part of the plan.
    pub fn inherits_browser_handles(&self) -> bool {
        false
    }
}

/// Plan a PTY session without opening one.
pub fn plan_pty_creation(
    platform: PlatformKind,
    size: PtySize,
) -> Result<PtyCreatePlan, PtyPlanError> {
    if size.cols == 0 || size.rows == 0 {
        return Err(PtyPlanError::ZeroDimension);
    }
    let backend = match platform {
        PlatformKind::Windows => PtyBackendKind::ConPty,
        PlatformKind::Linux | PlatformKind::MacOs => PtyBackendKind::Posix,
    };
    Ok(PtyCreatePlan { backend, size })
}
