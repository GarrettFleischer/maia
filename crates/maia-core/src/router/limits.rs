//! Explicit router parser and transport accumulation budgets (`10-security.md`).

use crate::router::error::RouterError;

/// Maximum bytes read from one JSON completion body.
pub const MAX_ROUTER_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// Maximum bytes buffered for one SSE line including partial chunks.
pub const MAX_SSE_LINE_BUFFER_BYTES: usize = 256 * 1024;

/// Maximum bytes accumulated for streamed assistant reply text.
pub const MAX_SSE_ACCUMULATED_REPLY_BYTES: usize = 4 * 1024 * 1024;

/// Maximum bytes accumulated for streamed reasoning text.
pub const MAX_SSE_ACCUMULATED_REASONING_BYTES: usize = 4 * 1024 * 1024;

/// Maximum bytes accumulated for one tool-call arguments payload.
pub const MAX_TOOL_ARGUMENTS_BYTES: usize = 1 * 1024 * 1024;

/// Ensures `current + additional` stays within `max`.
pub fn ensure_within_limit(
    current: usize,
    additional: usize,
    max: usize,
    field: &'static str,
) -> Result<(), RouterError> {
    let next = current
        .checked_add(additional)
        .ok_or(RouterError::ResourceLimit { field })?;
    if next > max {
        return Err(RouterError::ResourceLimit { field });
    }
    Ok(())
}

/// Accumulates response bytes while enforcing [`MAX_ROUTER_RESPONSE_BYTES`].
#[derive(Debug, Default)]
pub struct BoundedResponseCollector {
    total: usize,
    bytes: Vec<u8>,
}

impl BoundedResponseCollector {
    /// Starts an empty collector.
    pub fn new() -> Self {
        Self::default()
    }

    /// Total bytes accumulated so far.
    pub fn len(&self) -> usize {
        self.total
    }

    /// Returns true when no bytes have been accumulated.
    pub fn is_empty(&self) -> bool {
        self.total == 0
    }

    /// Appends one chunk or returns [`RouterError::ResourceLimit`].
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), RouterError> {
        ensure_within_limit(
            self.total,
            chunk.len(),
            MAX_ROUTER_RESPONSE_BYTES,
            "response_body",
        )?;
        self.total += chunk.len();
        self.bytes.extend_from_slice(chunk);
        Ok(())
    }

    /// Returns accumulated bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

/// Tracks streamed response bytes without retaining them.
#[derive(Debug, Default)]
pub struct ResponseByteBudget {
    total: usize,
}

impl ResponseByteBudget {
    /// Starts a zero budget.
    pub fn new() -> Self {
        Self::default()
    }

    /// Accounts for another streamed chunk.
    pub fn account(&mut self, chunk_len: usize) -> Result<(), RouterError> {
        ensure_within_limit(
            self.total,
            chunk_len,
            MAX_ROUTER_RESPONSE_BYTES,
            "response_body",
        )?;
        self.total += chunk_len;
        Ok(())
    }
}
