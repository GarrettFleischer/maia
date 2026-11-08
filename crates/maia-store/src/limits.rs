//! Named store input caps. The daemon must not enqueue anything larger.

use crate::error::ResourceLimit;
use crate::error::StoreError;

/// Inclusive maximum UTF-8 bytes of one thread-event body.
pub const MAX_THREAD_EVENT_BODY_BYTES: usize = 64 * 1024;

/// Inclusive maximum number of events in one append.
pub const MAX_THREAD_EVENTS_PER_APPEND: usize = 32;

/// Inclusive maximum total event-body bytes in one append.
pub const MAX_THREAD_BATCH_BYTES: usize = 256 * 1024;

/// Inclusive maximum bytes of one audit canonical blob.
pub const MAX_AUDIT_CANONICAL_BYTES: usize = 64 * 1024;

/// Inclusive maximum bytes of one audit payload blob.
pub const MAX_AUDIT_PAYLOAD_BYTES: usize = 64 * 1024;

/// Inclusive maximum bytes of one FTS query string.
pub const MAX_FTS_QUERY_BYTES: usize = 512;

/// Inclusive maximum bytes of one prose field (episode, claim, fact, entity).
pub const MAX_PROSE_BYTES: usize = 64 * 1024;

pub(crate) fn require_bounded(
    field: &'static str,
    actual: usize,
    limit: usize,
) -> Result<(), StoreError> {
    if actual > limit {
        return Err(StoreError::ResourceLimit(ResourceLimit {
            field,
            limit,
            actual,
        }));
    }
    Ok(())
}

pub(crate) fn require_fts_query(query: &str) -> Result<(), StoreError> {
    require_bounded("fts_query", query.len(), MAX_FTS_QUERY_BYTES)
}
