//! Append-only signed audit chain types and verification policy.

mod chain;
mod types;

pub use chain::{
    AuditChainError, canonical_event_bytes, compute_event_hash, seal_event, stable_hash,
    verify_audit_chain, verify_audit_chain_against_checkpoint,
};
pub use types::{
    AuditActor, AuditCheckpoint, AuditEvent, AuditEventId, AuditHash, AuditKind, AuditSequence,
    RequestId, ThreadId, Timestamp,
};
