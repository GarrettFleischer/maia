//! Host probe that demonstrates linked primitives and leaves LPAC unavailable.

use maia_containment::{CapabilityObservation, PtySize};

use crate::conpty::create_conpty;
use crate::job::create_kill_on_close_job;
use crate::plan::{WindowsHostEvidence, try_job_limit_plan};

/// Probe job and ConPTY creation. Assignment before resume is not demonstrated here.
///
/// LPAC is [`CapabilityObservation::Unavailable`] because `Win32_Security_Isolation` is not linked.
pub fn collect_windows_host_evidence() -> WindowsHostEvidence {
    let kill_on_close_job = match try_job_limit_plan(4, 64 * 1024 * 1024, 10) {
        Ok(plan) => match create_kill_on_close_job(&plan) {
            Ok(_job) => CapabilityObservation::Present,
            Err(_) => CapabilityObservation::Unavailable,
        },
        Err(_) => CapabilityObservation::Unavailable,
    };
    let conpty = match create_conpty(PtySize { cols: 80, rows: 24 }) {
        Ok(_session) => CapabilityObservation::Present,
        Err(_) => CapabilityObservation::Unavailable,
    };
    WindowsHostEvidence {
        lpac: CapabilityObservation::Unavailable,
        kill_on_close_job,
        assign_before_resume: CapabilityObservation::Unknown,
        conpty,
    }
}
