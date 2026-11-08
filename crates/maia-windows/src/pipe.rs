//! Parent-owned Chrome pipe with an owner-only DACL.

use std::mem::size_of;

use windows::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE};
use windows::core::HSTRING;

use crate::WindowsFailure;
use crate::chrome_pipe_dacl;
use crate::handle::{OwnedHandle, last_error, win32_code};

/// Server end of a parent-owned named pipe.
pub struct ParentChromePipe {
    server: OwnedHandle,
}

impl ParentChromePipe {
    /// Whether the server handle is marked inheritable.
    pub fn inherits_handles(&self) -> Result<bool, WindowsFailure> {
        let mut flags = 0u32;
        // SAFETY: `server` is an open pipe handle. `flags` is a writable `u32` not retained.
        unsafe { GetHandleInformation(self.server.get(), &mut flags) }.map_err(|error| {
            WindowsFailure::PipeFailed {
                code: win32_code(&error),
            }
        })?;
        Ok(flags & HANDLE_FLAG_INHERIT.0 != 0)
    }
}

/// Create `\\.\pipe\maia-containment-{nonce}` with the owner-only DACL.
pub fn create_parent_owned_chrome_pipe(nonce: u64) -> Result<ParentChromePipe, WindowsFailure> {
    let name = HSTRING::from(format!("\\\\.\\pipe\\maia-containment-{nonce}"));
    let dacl = HSTRING::from(chrome_pipe_dacl());
    let mut descriptor = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    // SAFETY: `dacl` is a constant SDDL string that lives for the call. `descriptor` is a
    // writable out-parameter. On success it owns a LocalAlloc buffer freed below.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &dacl,
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(|error| WindowsFailure::PipeFailed {
        code: win32_code(&error),
    })?;
    let attrs = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .map_err(|_| WindowsFailure::PipeFailed { code: 0 })?,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    // SAFETY: `name` is a nul-terminated pipe path we generated from a nonce, not a profile path.
    // `attrs` lives for the call, is not inheritable, and points at the descriptor just built.
    // The returned handle is owned by `ParentChromePipe`.
    let handle = unsafe {
        CreateNamedPipeW(
            &name,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            4096,
            4096,
            0,
            Some(&attrs),
        )
    };
    if !descriptor.0.is_null() {
        // SAFETY: `descriptor.0` was allocated by ConvertStringSecurityDescriptor and is freed once.
        unsafe {
            LocalFree(Some(HLOCAL(descriptor.0)));
        }
    }
    if handle.is_invalid() {
        return Err(WindowsFailure::PipeFailed { code: last_error() });
    }
    Ok(ParentChromePipe {
        server: OwnedHandle::new(handle),
    })
}
