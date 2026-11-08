//! The one sqlite-vec registration site in this crate.

use std::sync::atomic::AtomicU8;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use crate::error::StoreError;

const UNSET: u8 = 0;
const RUNNING: u8 = 1;
const READY: u8 = 2;

static STATE: AtomicU8 = AtomicU8::new(UNSET);
static ENTRIES: AtomicU64 = AtomicU64::new(0);

/// Decision for one observed sqlite-vec registration state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VecRegistrationGate {
    /// This caller should try to enter the audited sqlite-vec initializer.
    Enter,
    /// Another caller is inside the initializer.
    Wait,
    /// Registration has already succeeded.
    Ready,
}

/// How many times the audited sqlite-vec registration body has been entered.
///
/// A second successful call does not increment this counter and does not re-enter
/// the registration block.
#[must_use]
pub fn sqlite_vec_registration_entries() -> u64 {
    ENTRIES.load(Ordering::Acquire)
}

/// Maps a registration state byte to the next step.
///
/// Unknown bytes fail closed. This function does not touch the atomic or the audited block.
///
/// # Errors
///
/// Returns [`StoreError::VecRegistrationCorrupt`] for any state other than unset,
/// running, or ready.
pub fn classify_vec_registration(state: u8) -> Result<VecRegistrationGate, StoreError> {
    match state {
        UNSET => Ok(VecRegistrationGate::Enter),
        RUNNING => Ok(VecRegistrationGate::Wait),
        READY => Ok(VecRegistrationGate::Ready),
        other => Err(StoreError::VecRegistrationCorrupt { state: other }),
    }
}

/// Registers statically linked sqlite-vec for every later SQLite connection.
///
/// The entry point is process-global. A second call is a no-op and does not
/// re-enter the audited registration block. Registration does not parse untrusted bytes and does not
/// open a database.
///
/// # Errors
///
/// Returns the SQLite error when `sqlite3_auto_extension` rejects the entry.
/// A corrupt registration state fails closed. A failed attempt may be retried;
/// a successful attempt may not be repeated without winning the one-time gate again.
#[allow(unsafe_code)]
pub fn register_sqlite_vec() -> Result<(), StoreError> {
    loop {
        match classify_vec_registration(STATE.load(Ordering::Acquire))? {
            VecRegistrationGate::Ready => return Ok(()),
            VecRegistrationGate::Wait => std::thread::yield_now(),
            VecRegistrationGate::Enter => {
                if STATE
                    .compare_exchange(UNSET, RUNNING, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    continue;
                }
                ENTRIES.fetch_add(1, Ordering::AcqRel);
                // SAFETY: `sqlite3_vec_init` is the statically linked sqlite-vec initializer.
                // Its C signature is `sqlite3_vec_init(sqlite3 *, char **, sqlite3_api_routines *)`.
                // The Rust binding omits those parameters, so this transmute only retypes the
                // static function pointer into `RawAutoExtension` for `sqlite3_auto_extension`.
                // It is not called as a zero-argument Rust function. The initializer does not
                // open a database, close SQLite's handle, change the auto-extension list, or
                // parse untrusted bytes. This block runs only after winning the one-time
                // `STATE` transition from unset to running.
                let result = unsafe {
                    let init: rusqlite::auto_extension::RawAutoExtension =
                        std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
                    rusqlite::auto_extension::register_auto_extension(init)
                        .map_err(StoreError::from)
                };
                if result.is_ok() {
                    STATE.store(READY, Ordering::Release);
                } else {
                    STATE.store(UNSET, Ordering::Release);
                }
                return result;
            }
        }
    }
}
