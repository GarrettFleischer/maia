//! Failures that carry Win32 codes and never host paths or secret bytes.

use std::fmt;

/// Windows adapter failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsFailure {
    /// This build is not running on Windows.
    UnsupportedHost,
    /// `Win32_Security_Isolation` is not linked, so LPAC cannot be created.
    AppContainerNotLinked,
    /// An argument could not be placed on a Windows command line safely.
    ArgumentRejected,
    /// `CreateJobObject` failed.
    JobCreateFailed {
        /// Win32 code.
        code: u32,
    },
    /// A job limit could not be set or read back.
    JobLimitFailed {
        /// Win32 code.
        code: u32,
    },
    /// `CreateProcess` failed.
    ProcessCreateFailed {
        /// Win32 code.
        code: u32,
    },
    /// The suspended process could not be assigned to the job.
    AssignFailed {
        /// Win32 code.
        code: u32,
    },
    /// `ResumeThread` failed.
    ResumeFailed {
        /// Win32 code.
        code: u32,
    },
    /// A job query failed.
    QueryFailed {
        /// Win32 code.
        code: u32,
    },
    /// Waiting for process exit failed or timed out.
    WaitFailed {
        /// Win32 or wait code.
        code: u32,
    },
    /// ConPTY setup failed.
    ConPtyFailed {
        /// Win32 code.
        code: u32,
    },
    /// Pipe setup failed.
    PipeFailed {
        /// Win32 code.
        code: u32,
    },
    /// Credential Manager returned an unexpected code.
    CredentialFailed {
        /// Win32 code.
        code: u32,
    },
}

impl fmt::Display for WindowsFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedHost => {
                formatter.write_str("windows containment is unavailable on this host")
            }
            Self::AppContainerNotLinked => {
                formatter.write_str("appcontainer isolation api is not linked")
            }
            Self::ArgumentRejected => formatter.write_str("command argument rejected"),
            Self::JobCreateFailed { code } => write!(formatter, "job create failed ({code})"),
            Self::JobLimitFailed { code } => write!(formatter, "job limit failed ({code})"),
            Self::ProcessCreateFailed { code } => {
                write!(formatter, "process create failed ({code})")
            }
            Self::AssignFailed { code } => write!(formatter, "job assign failed ({code})"),
            Self::ResumeFailed { code } => write!(formatter, "resume failed ({code})"),
            Self::QueryFailed { code } => write!(formatter, "job query failed ({code})"),
            Self::WaitFailed { code } => write!(formatter, "process wait failed ({code})"),
            Self::ConPtyFailed { code } => write!(formatter, "conpty failed ({code})"),
            Self::PipeFailed { code } => write!(formatter, "pipe failed ({code})"),
            Self::CredentialFailed { code } => write!(formatter, "credential call failed ({code})"),
        }
    }
}

impl std::error::Error for WindowsFailure {}

/// Credential Manager failure. The target name and secret are not stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialError {
    /// The target name is not an ASCII token this adapter will pass to Credential Manager.
    InvalidTarget,
    /// The secret was empty.
    EmptySecret,
    /// Credential Manager has no such target.
    NotFound,
    /// Credential Manager rejected the call.
    Rejected {
        /// Win32 code.
        code: u32,
    },
}

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTarget => formatter.write_str("credential target rejected"),
            Self::EmptySecret => formatter.write_str("credential secret empty"),
            Self::NotFound => formatter.write_str("credential not found"),
            Self::Rejected { code } => write!(formatter, "credential call failed ({code})"),
        }
    }
}

impl std::error::Error for CredentialError {}

#[cfg(windows)]
pub(crate) fn win32_code_from_raw(raw: u32) -> u32 {
    if raw & 0xFFFF_0000 == 0x8007_0000 {
        raw & 0xFFFF
    } else {
        raw
    }
}
