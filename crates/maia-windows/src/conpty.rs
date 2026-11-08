//! ConPTY sessions owned by the parent.

use std::mem::size_of;

use maia_containment::PtySize;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows::Win32::System::Pipes::CreatePipe;

use crate::WindowsFailure;
use crate::handle::{OwnedHandle, win32_code};

/// Parent-owned pseudoconsole. Drop closes it.
pub struct ConPtySession {
    console: HPCON,
    input_write: OwnedHandle,
    output_read: OwnedHandle,
}

impl Drop for ConPtySession {
    fn drop(&mut self) {
        // SAFETY: `console` was returned by CreatePseudoConsole and has not been closed.
        // ClosePseudoConsole does not use the parent pipe ends stored beside it.
        unsafe { ClosePseudoConsole(self.console) };
    }
}

impl ConPtySession {
    /// Resize the pseudoconsole.
    pub fn resize(&self, size: PtySize) -> Result<(), WindowsFailure> {
        if self.input_write.get().is_invalid() || self.output_read.get().is_invalid() {
            return Err(WindowsFailure::ConPtyFailed { code: 0 });
        }
        let coord = coord(size)?;
        // SAFETY: `console` is an open pseudoconsole owned by `self`. `coord` is a value.
        unsafe { ResizePseudoConsole(self.console, coord) }.map_err(|error| {
            WindowsFailure::ConPtyFailed {
                code: win32_code(&error),
            }
        })
    }
}

/// Create a ConPTY of `size` with non-inheritable parent pipe ends.
pub fn create_conpty(size: PtySize) -> Result<ConPtySession, WindowsFailure> {
    let coord = coord(size)?;
    let (input_read, input_write) = pipe_pair()?;
    let (output_read, output_write) = pipe_pair()?;
    // SAFETY: the two pipe ends are open and synchronous. CreatePseudoConsole duplicates them
    // and does not require the caller to keep these particular ends. Flags 0 select the default
    // pseudoconsole. The returned HPCON is owned by the session.
    let console = unsafe { CreatePseudoConsole(coord, input_read.get(), output_write.get(), 0) }
        .map_err(|error| WindowsFailure::ConPtyFailed {
            code: win32_code(&error),
        })?;
    drop(input_read);
    drop(output_write);
    Ok(ConPtySession {
        console,
        input_write,
        output_read,
    })
}

fn coord(size: PtySize) -> Result<COORD, WindowsFailure> {
    let x = i16::try_from(size.cols).map_err(|_| WindowsFailure::ConPtyFailed { code: 0 })?;
    let y = i16::try_from(size.rows).map_err(|_| WindowsFailure::ConPtyFailed { code: 0 })?;
    if x == 0 || y == 0 {
        return Err(WindowsFailure::ConPtyFailed { code: 0 });
    }
    Ok(COORD { X: x, Y: y })
}

fn pipe_pair() -> Result<(OwnedHandle, OwnedHandle), WindowsFailure> {
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    let attrs = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .map_err(|_| WindowsFailure::PipeFailed { code: 0 })?,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: false.into(),
    };
    // SAFETY: `read` and `write` are writable handle slots. `attrs` lives for the call and
    // requests a non-inheritable pipe. The API does not retain `attrs`.
    unsafe { CreatePipe(&mut read, &mut write, Some(&attrs), 0) }.map_err(|error| {
        WindowsFailure::PipeFailed {
            code: win32_code(&error),
        }
    })?;
    Ok((OwnedHandle::new(read), OwnedHandle::new(write)))
}
