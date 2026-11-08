#![deny(unsafe_op_in_unsafe_fn)]
#![deny(missing_docs)]

//! Windows containment, ConPTY, pipe ACLs, and Credential Manager FFI.
//!
//! LPAC profile creation stays fail-closed: the pinned `windows` crate does not enable
//! `Win32_Security_Isolation`, so AppContainer calls are not linked. Job Objects, ConPTY,
//! parent-owned pipes, and Credential Manager are implemented behind `cfg(windows)`.

mod error;
mod plan;

#[cfg(windows)]
mod conpty;
#[cfg(windows)]
mod credential;
#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod evidence;
#[cfg(windows)]
mod handle;
#[cfg(windows)]
mod job;
#[cfg(windows)]
mod pipe;

pub use error::{CredentialError, WindowsFailure};
pub use plan::{
    BreakawayFlag, ChromePipePlan, ChromePipePlanError, ClipboardFlag, JobLimitObservation,
    JobLimitPlan, JobPlanError, KillOnCloseFlag, LpacPlan, LpacPlanError, NetworkGrant,
    WindowsHostEvidence, WindowsProbeInput, chrome_pipe_dacl, create_lpac_profile,
    credential_manager_descriptor, interpret_windows_probe, pty_plan, try_chrome_pipe_plan,
    try_job_limit_plan, try_lpac_plan, windows_event_sources,
};

#[cfg(windows)]
pub use conpty::{ConPtySession, create_conpty};
#[cfg(windows)]
pub use desktop::{
    DesktopError, capture_display, capture_region, cursor_position, hold_key, left_button_down,
    left_button_up, pointer_click, pointer_drag, pointer_move, press_key, scroll_wheel, type_text,
    wait_seconds,
};
#[cfg(windows)]
pub use credential::{
    SecretBytes, delete_session_credential, read_session_credential, write_local_credential,
    write_session_credential,
};
#[cfg(windows)]
pub use evidence::collect_windows_host_evidence;
#[cfg(windows)]
pub use job::{AssignedSuspended, KillOnCloseJob, RunningInJob, create_kill_on_close_job};
#[cfg(windows)]
pub use pipe::{ParentChromePipe, create_parent_owned_chrome_pipe};
