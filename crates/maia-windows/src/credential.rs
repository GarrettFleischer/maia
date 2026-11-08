//! Session-scoped Credential Manager wrappers. Secrets are not copied into errors.

use std::sync::atomic::{Ordering, compiler_fence};

use windows::Win32::Foundation::FILETIME;
use windows::Win32::Security::Credentials::{
    CRED_PERSIST_LOCAL_MACHINE, CRED_PERSIST_SESSION, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW,
    CredFree, CredReadW, CredWriteW,
};
use windows::core::{HSTRING, PWSTR};

use crate::CredentialError;
use crate::handle::win32_code;

const ERROR_NOT_FOUND: u32 = 1168;
const MAX_BLOB: usize = 2560;

/// Secret bytes cleared on drop. `Debug` does not print them.
pub struct SecretBytes {
    bytes: Vec<u8>,
}

impl SecretBytes {
    pub(crate) fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    /// Borrow the secret. Callers must not log this slice.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        for byte in &mut self.bytes {
            *byte = 0;
        }
        compiler_fence(Ordering::SeqCst);
    }
}

impl std::fmt::Debug for SecretBytes {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SecretBytes([redacted])")
    }
}

/// Write a generic credential for the current logon session.
pub fn write_session_credential(target: &str, secret: &[u8]) -> Result<(), CredentialError> {
    write_credential(target, secret, CRED_PERSIST_SESSION)
}

/// Write a generic credential that remains for this user after the daemon restarts.
pub fn write_local_credential(target: &str, secret: &[u8]) -> Result<(), CredentialError> {
    write_credential(target, secret, CRED_PERSIST_LOCAL_MACHINE)
}

fn write_credential(
    target: &str,
    secret: &[u8],
    persist: windows::Win32::Security::Credentials::CRED_PERSIST,
) -> Result<(), CredentialError> {
    validate_target(target)?;
    if secret.is_empty() {
        return Err(CredentialError::EmptySecret);
    }
    if secret.len() > MAX_BLOB {
        return Err(CredentialError::Rejected { code: 0 });
    }
    let mut target_wide = wide(target);
    let mut user_wide = wide("maia");
    let mut blob = secret.to_vec();
    let blob_size = u32::try_from(blob.len()).map_err(|_| CredentialError::Rejected { code: 0 })?;
    let credential = CREDENTIALW {
        Flags: windows::Win32::Security::Credentials::CRED_FLAGS(0),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target_wide.as_mut_ptr()),
        Comment: PWSTR(std::ptr::null_mut()),
        LastWritten: FILETIME::default(),
        CredentialBlobSize: blob_size,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: persist,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: PWSTR(std::ptr::null_mut()),
        UserName: PWSTR(user_wide.as_mut_ptr()),
    };
    // SAFETY: every pointer in `credential` is either null or addresses a buffer that lives for
    // this call. `CredentialBlob` is readable for `CredentialBlobSize` bytes. CredWriteW copies
    // the blob and does not retain the pointers.
    let written = unsafe { CredWriteW(&credential, 0) };
    zero(&mut blob);
    written.map_err(map_cred)
}

/// Read a generic session credential. `NotFound` carries neither the target nor a secret.
pub fn read_session_credential(target: &str) -> Result<SecretBytes, CredentialError> {
    validate_target(target)?;
    let name = HSTRING::from(target);
    let mut raw = std::ptr::null_mut();
    // SAFETY: `name` is a nul-terminated target. `raw` is a writable out pointer. On success the
    // API allocates `*raw`, which `CredGuard` frees exactly once.
    unsafe { CredReadW(&name, CRED_TYPE_GENERIC, Some(0), &mut raw) }.map_err(map_cred)?;
    let guard = CredGuard(raw);
    let bytes = copy_blob(guard.0)?;
    drop(guard);
    Ok(SecretBytes::new(bytes))
}

/// Delete a generic session credential.
pub fn delete_session_credential(target: &str) -> Result<(), CredentialError> {
    validate_target(target)?;
    let name = HSTRING::from(target);
    // SAFETY: `name` is a nul-terminated target and is not retained.
    unsafe { CredDeleteW(&name, CRED_TYPE_GENERIC, Some(0)) }.map_err(map_cred)
}

struct CredGuard(*mut CREDENTIALW);

impl Drop for CredGuard {
    fn drop(&mut self) {
        if self.0.is_null() {
            return;
        }
        // SAFETY: `self.0` was allocated by a successful CredReadW and has not been freed.
        unsafe { CredFree(self.0.cast()) };
        self.0 = std::ptr::null_mut();
    }
}

fn copy_blob(raw: *mut CREDENTIALW) -> Result<Vec<u8>, CredentialError> {
    if raw.is_null() {
        return Err(CredentialError::Rejected { code: 0 });
    }
    // SAFETY: `raw` is the non-null credential returned by CredReadW and still owned by the guard.
    // The blob is readable for `CredentialBlobSize` bytes, which we cap before forming a slice.
    unsafe {
        let credential = &*raw;
        let len = credential.CredentialBlobSize;
        if usize::try_from(len)
            .map(|len| len > MAX_BLOB)
            .unwrap_or(true)
        {
            return Err(CredentialError::Rejected { code: 0 });
        }
        if credential.CredentialBlob.is_null() {
            return if len == 0 {
                Ok(Vec::new())
            } else {
                Err(CredentialError::Rejected { code: 0 })
            };
        }
        Ok(std::slice::from_raw_parts(credential.CredentialBlob, len as usize).to_vec())
    }
}

fn validate_target(target: &str) -> Result<(), CredentialError> {
    if target.is_empty()
        || target.len() > 128
        || !target
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(CredentialError::InvalidTarget);
    }
    let upper = target.to_ascii_uppercase();
    let blocked = [
        "PASSWORD",
        "SECRET",
        "TOKEN",
        "COOKIE",
        "CREDENTIAL",
        "CHROME",
    ];
    if blocked.iter().any(|marker| upper.contains(marker)) {
        return Err(CredentialError::InvalidTarget);
    }
    Ok(())
}

fn map_cred(error: windows::core::Error) -> CredentialError {
    let code = win32_code(&error);
    if code == ERROR_NOT_FOUND {
        CredentialError::NotFound
    } else {
        CredentialError::Rejected { code }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn zero(bytes: &mut [u8]) {
    for byte in bytes {
        *byte = 0;
    }
    compiler_fence(Ordering::SeqCst);
}
