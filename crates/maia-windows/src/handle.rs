//! Exclusive kernel-handle owner.

use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};

use crate::error::win32_code_from_raw;

pub(crate) struct OwnedHandle(HANDLE);

impl OwnedHandle {
    pub(crate) fn new(handle: HANDLE) -> Self {
        Self(handle)
    }

    pub(crate) fn get(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if self.0.is_invalid() {
            return;
        }
        let handle = self.0;
        self.0 = HANDLE::default();
        // SAFETY: `handle` is an open kernel handle exclusively owned by this value.
        // CloseHandle does not retain it. A double close is prevented by writing an invalid
        // handle back before the call returns.
        let _ = unsafe { CloseHandle(handle) };
    }
}

pub(crate) fn last_error() -> u32 {
    // SAFETY: GetLastError reads this thread's last-error code and has no pointer precondition.
    let code = unsafe { GetLastError() };
    code.0
}

pub(crate) fn win32_code(error: &windows::core::Error) -> u32 {
    win32_code_from_raw(error.code().0 as u32)
}
