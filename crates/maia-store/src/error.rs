//! Recoverable failures from the SQLite owner.

use std::fmt;

/// A rejected input size. `actual` is the supplied size and `limit` is the inclusive maximum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceLimit {
    /// Which input exceeded its cap.
    pub field: &'static str,
    /// Inclusive maximum.
    pub limit: usize,
    /// Supplied size.
    pub actual: usize,
}

/// Failure returned by the SQLite owner.
///
/// Third-party SQLite errors are reduced to text so callers do not depend on
/// `rusqlite`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// A command channel capacity was zero.
    InvalidCapacity,
    /// The bounded command channel has no room.
    QueueFull,
    /// The owner thread stopped before the reply was delivered.
    OwnerStopped,
    /// The barrier registry mutex was poisoned.
    LockPoisoned,
    /// The file was written by a newer schema than this binary understands.
    DatabaseTooNew {
        /// `user_version` found in the file.
        found: i64,
        /// Highest schema version this binary can open.
        supported: i64,
    },
    /// The thread log was not at `expected`.
    VersionConflict {
        /// Version the caller expected to append onto.
        expected: u64,
        /// Version stored at the time of the append.
        actual: u64,
    },
    /// The idempotency key is already stored with a different body.
    IdempotencyConflict {
        /// Caller-supplied key that already exists.
        key: String,
    },
    /// A required row was not stored.
    NotFound {
        /// Table or entity name.
        entity: &'static str,
        /// Missing identifier.
        id: String,
    },
    /// The stored audit predecessor link or checkpoint does not match.
    AuditChainInvalid {
        /// First sequence that failed verification.
        sequence: u64,
    },
    /// `event_hash` is not [`maia_core::audit::compute_event_hash`] of the canonical bytes.
    AuditHashMismatch {
        /// Sequence whose stored or supplied hash does not match.
        sequence: u64,
    },
    /// An input exceeded a named store limit before it was queued or written.
    ResourceLimit(ResourceLimit),
    /// sqlite-vec registration state is not one of the three known values.
    VecRegistrationCorrupt {
        /// Observed atomic state byte.
        state: u8,
    },
    /// The request failed validation before a write.
    InvalidRequest {
        /// What was rejected.
        message: String,
    },
    /// SQLite rejected a constraint inside a transaction that was rolled back.
    Constraint {
        /// SQLite constraint text.
        message: String,
    },
    /// SQLite reported a failure that was not a constraint.
    Sqlite {
        /// Display text from the driver.
        message: String,
        /// True when SQLite returned `SQLITE_BUSY` or `SQLITE_LOCKED` at the I/O boundary.
        schema_lock_contention: bool,
    },
    /// The operating system refused to start `maia-sqlite`.
    ThreadSpawn {
        /// OS error text.
        message: String,
    },
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidCapacity => formatter.write_str("channel capacity must be at least 1"),
            Self::QueueFull => formatter.write_str("sqlite owner queue is full"),
            Self::OwnerStopped => formatter.write_str("sqlite owner stopped"),
            Self::LockPoisoned => formatter.write_str("sqlite owner barrier lock poisoned"),
            Self::DatabaseTooNew { found, supported } => {
                write!(
                    formatter,
                    "database version {found} is newer than supported version {supported}"
                )
            }
            Self::VersionConflict { expected, actual } => {
                write!(
                    formatter,
                    "thread version conflict: expected {expected}, actual {actual}"
                )
            }
            Self::IdempotencyConflict { key } => {
                write!(
                    formatter,
                    "idempotency key `{key}` already has a different body"
                )
            }
            Self::NotFound { entity, id } => write!(formatter, "{entity} `{id}` was not found"),
            Self::AuditChainInvalid { sequence } => {
                write!(formatter, "audit chain invalid at sequence {sequence}")
            }
            Self::AuditHashMismatch { sequence } => {
                write!(formatter, "audit hash mismatch at sequence {sequence}")
            }
            Self::ResourceLimit(limit) => write!(
                formatter,
                "{} exceeds {} bytes (got {})",
                limit.field, limit.limit, limit.actual
            ),
            Self::VecRegistrationCorrupt { state } => {
                write!(
                    formatter,
                    "sqlite-vec registration state {state} is corrupt"
                )
            }
            Self::InvalidRequest { message } => formatter.write_str(message),
            Self::Constraint { message }
            | Self::Sqlite { message, .. }
            | Self::ThreadSpawn { message } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for StoreError {}

/// Whether SQLite reported schema open/migrate lock contention.
pub(crate) fn rusqlite_schema_lock_contention(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

/// Whether a store error should be retried while another opener holds the schema lock.
pub(crate) fn store_error_is_schema_lock_contention(error: &StoreError) -> bool {
    matches!(
        error,
        StoreError::Sqlite {
            schema_lock_contention: true,
            ..
        }
    )
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        let schema_lock_contention = rusqlite_schema_lock_contention(&error);
        match error {
            rusqlite::Error::SqliteFailure(code, message)
                if code.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Self::Constraint {
                    message: message.unwrap_or_else(|| code.to_string()),
                }
            }
            other => Self::Sqlite {
                message: other.to_string(),
                schema_lock_contention,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::ErrorCode;

    use super::StoreError;
    use super::store_error_is_schema_lock_contention;

    fn sqlite_failure(code: ErrorCode, extended_code: i32, message: &str) -> rusqlite::Error {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code,
                extended_code,
            },
            Some(message.to_owned()),
        )
    }

    #[test]
    fn schema_lock_contention_uses_sqlite_codes_not_messages() {
        let busy: StoreError = sqlite_failure(
            ErrorCode::DatabaseBusy,
            rusqlite::ffi::SQLITE_BUSY,
            "unrelated driver text",
        )
        .into();
        assert!(store_error_is_schema_lock_contention(&busy));

        let locked: StoreError = sqlite_failure(
            ErrorCode::DatabaseLocked,
            rusqlite::ffi::SQLITE_LOCKED,
            "still unrelated",
        )
        .into();
        assert!(store_error_is_schema_lock_contention(&locked));

        let decoy = StoreError::Sqlite {
            message: "database is locked".to_owned(),
            schema_lock_contention: false,
        };
        assert!(!store_error_is_schema_lock_contention(&decoy));

        let unrelated: StoreError = sqlite_failure(
            ErrorCode::ConstraintViolation,
            rusqlite::ffi::SQLITE_CONSTRAINT_NOTNULL,
            "database is locked",
        )
        .into();
        assert!(!store_error_is_schema_lock_contention(&unrelated));
    }
}
