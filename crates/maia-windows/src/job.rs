//! Kill-on-close Job Objects and assignment before resume.

use std::ffi::c_void;
use std::mem::size_of;

use maia_containment::CommandPlan;
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
    JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicProcessIdList,
    JobObjectBasicUIRestrictions, JobObjectCpuRateControlInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess, PROCESS_INFORMATION,
    ResumeThread, STARTUPINFOW, TerminateProcess, WaitForSingleObject,
};
use windows::core::{HSTRING, PCWSTR, PWSTR};

use crate::WindowsFailure;
use crate::handle::{OwnedHandle, last_error, win32_code};
use crate::plan::{
    BreakawayFlag, ClipboardFlag, JobLimitObservation, JobLimitPlan, KillOnCloseFlag,
};

/// Job that kills every assigned process when its last handle closes.
pub struct KillOnCloseJob {
    handle: OwnedHandle,
}

/// Process created suspended and assigned to a job before resume.
pub struct AssignedSuspended {
    process: Option<OwnedHandle>,
    thread: Option<OwnedHandle>,
    pid: u32,
}

/// Process resumed only after job assignment.
pub struct RunningInJob {
    process: OwnedHandle,
    thread: OwnedHandle,
    previous_suspend_count: u32,
}

#[repr(C)]
struct ProcessIdQuery {
    assigned: u32,
    listed: u32,
    ids: [usize; 64],
}

impl KillOnCloseJob {
    /// Read the limits this adapter set.
    pub fn observed_limits(&self) -> Result<JobLimitObservation, WindowsFailure> {
        let extended = query_extended(self.handle.get())?;
        let ui = query_ui(self.handle.get())?;
        let cpu_rate = query_cpu_rate(self.handle.get())?;
        let flags = extended.BasicLimitInformation.LimitFlags;
        let kill_on_close = if flag_set(flags, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) {
            KillOnCloseFlag::Set
        } else {
            KillOnCloseFlag::Absent
        };
        let breakaway = if flag_set(flags, JOB_OBJECT_LIMIT_BREAKAWAY_OK)
            || flag_set(flags, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)
        {
            BreakawayFlag::Allowed
        } else {
            BreakawayFlag::Denied
        };
        let clipboard = if flag_set(ui.UIRestrictionsClass, JOB_OBJECT_UILIMIT_READCLIPBOARD)
            && flag_set(ui.UIRestrictionsClass, JOB_OBJECT_UILIMIT_WRITECLIPBOARD)
        {
            ClipboardFlag::Denied
        } else {
            ClipboardFlag::Allowed
        };
        let cpu_rate_percent =
            u8::try_from(cpu_rate / 100).map_err(|_| WindowsFailure::QueryFailed { code: 0 })?;
        Ok(JobLimitObservation {
            kill_on_close,
            breakaway,
            clipboard,
            active_process_limit: extended.BasicLimitInformation.ActiveProcessLimit,
            cpu_rate_percent,
        })
    }

    /// Process ids currently in the job.
    pub fn assigned_process_ids(&self) -> Result<Vec<u32>, WindowsFailure> {
        let mut query = ProcessIdQuery {
            assigned: 0,
            listed: 0,
            ids: [0; 64],
        };
        let length = u32::try_from(size_of::<ProcessIdQuery>())
            .map_err(|_| WindowsFailure::QueryFailed { code: 0 })?;
        // SAFETY: `query` is writable, aligned for `u32`/`usize`, and `length` is its full size.
        // The job handle is open and owned by `self`. The API does not retain `query`.
        unsafe {
            QueryInformationJobObject(
                Some(self.handle.get()),
                JobObjectBasicProcessIdList,
                (&mut query as *mut ProcessIdQuery).cast(),
                length,
                None,
            )
        }
        .map_err(|error| WindowsFailure::QueryFailed {
            code: win32_code(&error),
        })?;
        if query.assigned > 64 {
            return Err(WindowsFailure::QueryFailed { code: 0 });
        }
        let count = usize::try_from(query.listed.min(64))
            .map_err(|_| WindowsFailure::QueryFailed { code: 0 })?;
        let mut ids = Vec::with_capacity(count);
        for id in query.ids.iter().take(count) {
            let Ok(pid) = u32::try_from(*id) else {
                return Err(WindowsFailure::QueryFailed { code: 0 });
            };
            ids.push(pid);
        }
        Ok(ids)
    }

    /// Create the child suspended, assign it, and return before resume.
    pub fn spawn_assigned_suspended(
        &self,
        plan: &CommandPlan,
    ) -> Result<AssignedSuspended, WindowsFailure> {
        let command = windows_command_line(plan)?;
        let application = HSTRING::from(plan.program());
        let mut command_wide = wide(&command);
        let startup = STARTUPINFOW {
            cb: u32::try_from(size_of::<STARTUPINFOW>())
                .map_err(|_| WindowsFailure::ProcessCreateFailed { code: 0 })?,
            ..STARTUPINFOW::default()
        };
        let mut info = PROCESS_INFORMATION::default();
        let command_line = PWSTR(command_wide.as_mut_ptr());
        // SAFETY: `application` and `command_wide` are nul-terminated and live for the call.
        // `startup` and `info` are valid out-parameters. Handles are not inherited.
        // CREATE_SUSPENDED keeps the process from running before assignment.
        let created = unsafe {
            CreateProcessW(
                &application,
                Some(command_line),
                None,
                None,
                false,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                None,
                PCWSTR::null(),
                &startup,
                &mut info,
            )
        };
        if let Err(error) = created {
            return Err(WindowsFailure::ProcessCreateFailed {
                code: win32_code(&error),
            });
        }
        let process = OwnedHandle::new(info.hProcess);
        let thread = OwnedHandle::new(info.hThread);
        // SAFETY: both handles are open. The process is still suspended, so assignment happens
        // before any user-mode instruction of the child.
        if let Err(error) = unsafe { AssignProcessToJobObject(self.handle.get(), process.get()) } {
            // SAFETY: `process` is the suspended process created above and still owned here.
            unsafe {
                let _ = TerminateProcess(process.get(), 1);
            }
            return Err(WindowsFailure::AssignFailed {
                code: win32_code(&error),
            });
        }
        Ok(AssignedSuspended {
            process: Some(process),
            thread: Some(thread),
            pid: info.dwProcessId,
        })
    }
}

impl Drop for AssignedSuspended {
    fn drop(&mut self) {
        if let Some(process) = self.process.take() {
            // SAFETY: `process` is the suspended process still owned by this value.
            unsafe {
                let _ = TerminateProcess(process.get(), 1);
            }
        }
    }
}

impl AssignedSuspended {
    /// OS process id.
    pub fn process_id(&self) -> u32 {
        self.pid
    }

    /// Resume the primary thread. The returned count is the suspend count from before the resume.
    pub fn resume(mut self) -> Result<RunningInJob, WindowsFailure> {
        let (Some(process), Some(thread)) = (self.process.take(), self.thread.take()) else {
            return Err(WindowsFailure::ResumeFailed { code: 0 });
        };
        // SAFETY: `thread` is the primary thread created with CREATE_SUSPENDED and not resumed yet.
        let previous = unsafe { ResumeThread(thread.get()) };
        if previous == u32::MAX {
            let code = last_error();
            // SAFETY: resume failed; `process` is still the process we own.
            unsafe {
                let _ = TerminateProcess(process.get(), 1);
            }
            return Err(WindowsFailure::ResumeFailed { code });
        }
        Ok(RunningInJob {
            process,
            thread,
            previous_suspend_count: previous,
        })
    }
}

impl RunningInJob {
    /// Suspend count returned by `ResumeThread`.
    pub fn previous_suspend_count(&self) -> u32 {
        self.previous_suspend_count
    }

    /// Whether the process is still running.
    pub fn is_still_active(&self) -> Result<bool, WindowsFailure> {
        let mut code = 0u32;
        // SAFETY: `process` is open. `code` is a writable `u32` the call does not retain.
        unsafe { GetExitCodeProcess(self.process.get(), &mut code) }.map_err(|error| {
            WindowsFailure::QueryFailed {
                code: win32_code(&error),
            }
        })?;
        Ok(code == 259)
    }

    /// Wait until the process exits.
    pub fn wait_until_exited(&self, timeout_ms: u32) -> Result<(), WindowsFailure> {
        if self.thread.get().is_invalid() {
            return Err(WindowsFailure::WaitFailed { code: 0 });
        }
        // SAFETY: `process` is an open process handle owned by `self`.
        let status = unsafe { WaitForSingleObject(self.process.get(), timeout_ms) };
        if status == WAIT_OBJECT_0 {
            Ok(())
        } else {
            Err(WindowsFailure::WaitFailed { code: status.0 })
        }
    }
}

/// Create an unnamed job with kill-on-close, no breakaway, UI restrictions, and the given caps.
pub fn create_kill_on_close_job(plan: &JobLimitPlan) -> Result<KillOnCloseJob, WindowsFailure> {
    // SAFETY: a null name creates an unnamed job local to this process. The returned handle is
    // exclusively owned by `KillOnCloseJob`.
    let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|error| {
        WindowsFailure::JobCreateFailed {
            code: win32_code(&error),
        }
    })?;
    let job = KillOnCloseJob {
        handle: OwnedHandle::new(handle),
    };
    apply_limits(job.handle.get(), plan)?;
    Ok(job)
}

fn apply_limits(
    job: windows::Win32::Foundation::HANDLE,
    plan: &JobLimitPlan,
) -> Result<(), WindowsFailure> {
    let mut extended = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    extended.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_JOB_MEMORY;
    extended.BasicLimitInformation.ActiveProcessLimit = plan.active_process_limit();
    extended.JobMemoryLimit = usize::try_from(plan.job_memory_bytes())
        .map_err(|_| WindowsFailure::JobLimitFailed { code: 0 })?;
    set_job(
        job,
        JobObjectExtendedLimitInformation,
        (&extended as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
        size_of_u32::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()?,
    )?;

    let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
        UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
            | JOB_OBJECT_UILIMIT_READCLIPBOARD
            | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
            | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
            | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
            | JOB_OBJECT_UILIMIT_GLOBALATOMS
            | JOB_OBJECT_UILIMIT_DESKTOP
            | JOB_OBJECT_UILIMIT_EXITWINDOWS,
    };
    set_job(
        job,
        JobObjectBasicUIRestrictions,
        (&ui as *const JOBOBJECT_BASIC_UI_RESTRICTIONS).cast(),
        size_of_u32::<JOBOBJECT_BASIC_UI_RESTRICTIONS>()?,
    )?;

    let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
        ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
        ..JOBOBJECT_CPU_RATE_CONTROL_INFORMATION::default()
    };
    // `ControlFlags` selects the `CpuRate` field. The value is percent times 100.
    cpu.Anonymous.CpuRate = u32::from(plan.cpu_rate_percent()) * 100;
    set_job(
        job,
        JobObjectCpuRateControlInformation,
        (&cpu as *const JOBOBJECT_CPU_RATE_CONTROL_INFORMATION).cast(),
        size_of_u32::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>()?,
    )
}

fn set_job(
    job: windows::Win32::Foundation::HANDLE,
    class: windows::Win32::System::JobObjects::JOBOBJECTINFOCLASS,
    info: *const c_void,
    length: u32,
) -> Result<(), WindowsFailure> {
    // SAFETY: `job` is an open job handle. `info` points at a valid object of `class` for `length`
    // bytes and is not retained. The caller owns that memory for the duration of the call.
    unsafe { SetInformationJobObject(job, class, info, length) }.map_err(|error| {
        WindowsFailure::JobLimitFailed {
            code: win32_code(&error),
        }
    })
}

fn query_extended(
    job: windows::Win32::Foundation::HANDLE,
) -> Result<JOBOBJECT_EXTENDED_LIMIT_INFORMATION, WindowsFailure> {
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    query_job(
        job,
        JobObjectExtendedLimitInformation,
        (&mut info as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
        size_of_u32::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()?,
    )?;
    Ok(info)
}

fn query_ui(
    job: windows::Win32::Foundation::HANDLE,
) -> Result<JOBOBJECT_BASIC_UI_RESTRICTIONS, WindowsFailure> {
    let mut info = JOBOBJECT_BASIC_UI_RESTRICTIONS::default();
    query_job(
        job,
        JobObjectBasicUIRestrictions,
        (&mut info as *mut JOBOBJECT_BASIC_UI_RESTRICTIONS).cast(),
        size_of_u32::<JOBOBJECT_BASIC_UI_RESTRICTIONS>()?,
    )?;
    Ok(info)
}

fn query_cpu_rate(job: windows::Win32::Foundation::HANDLE) -> Result<u32, WindowsFailure> {
    let mut info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION::default();
    query_job(
        job,
        JobObjectCpuRateControlInformation,
        (&mut info as *mut JOBOBJECT_CPU_RATE_CONTROL_INFORMATION).cast(),
        size_of_u32::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>()?,
    )?;
    // SAFETY: the query filled the `CpuRate` field for a hard-cap control block we previously set.
    Ok(unsafe { info.Anonymous.CpuRate })
}

fn query_job(
    job: windows::Win32::Foundation::HANDLE,
    class: windows::Win32::System::JobObjects::JOBOBJECTINFOCLASS,
    info: *mut c_void,
    length: u32,
) -> Result<(), WindowsFailure> {
    // SAFETY: `job` is open. `info` is writable for `length` bytes and is not retained.
    unsafe { QueryInformationJobObject(Some(job), class, info, length, None) }.map_err(|error| {
        WindowsFailure::QueryFailed {
            code: win32_code(&error),
        }
    })
}

fn size_of_u32<T>() -> Result<u32, WindowsFailure> {
    u32::try_from(size_of::<T>()).map_err(|_| WindowsFailure::JobLimitFailed { code: 0 })
}

fn flag_set<T>(value: T, bit: T) -> bool
where
    T: Copy + PartialEq + std::ops::BitAnd<Output = T>,
{
    value & bit == bit
}

fn windows_command_line(plan: &CommandPlan) -> Result<String, WindowsFailure> {
    let mut parts = Vec::with_capacity(1 + plan.arguments().len());
    parts.push(quote_arg(plan.program())?);
    for arg in plan.arguments() {
        parts.push(quote_arg(arg)?);
    }
    Ok(parts.join(" "))
}

fn quote_arg(arg: &str) -> Result<String, WindowsFailure> {
    if arg.contains('"') || arg.contains('\n') || arg.contains('\r') {
        return Err(WindowsFailure::ArgumentRejected);
    }
    if arg.is_empty() || arg.contains(' ') || arg.contains('\t') {
        Ok(format!("\"{arg}\""))
    } else {
        Ok(arg.to_string())
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
