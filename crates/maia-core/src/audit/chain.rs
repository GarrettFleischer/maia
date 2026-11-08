//! Canonical audit serialization and hash-chain verification.

use crate::audit::types::{
    AuditActor, AuditEvent, AuditEventId, AuditHash, AuditKind, RequestId, ThreadId, Timestamp,
};

/// Errors detected while verifying an audit hash chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditChainError {
    /// No events were supplied.
    EmptyChain,
    /// Sequence numbers are not contiguous from one.
    SequenceGap {
        /// Expected sequence number.
        expected: u64,
        /// Observed sequence number.
        found: u64,
    },
    /// Recomputed hash does not match stored `event_hash`.
    HashMismatch {
        /// Offending sequence.
        sequence: u64,
    },
    /// `previous_hash` does not match the prior event head.
    PreviousHashMismatch {
        /// Offending sequence.
        sequence: u64,
    },
    /// Chain ends before the checkpoint head.
    Truncated {
        /// Checkpoint head hash.
        expected_head: AuditHash,
        /// Actual chain head hash.
        actual_head: AuditHash,
    },
    /// Checkpoint sequence does not match the last event.
    CheckpointSequenceMismatch {
        /// Checkpoint sequence.
        checkpoint: u64,
        /// Chain tail sequence.
        chain: u64,
    },
}

/// Deterministic FNV-1a 64-bit hash for audit links (std-only, stable across platforms).
pub fn stable_hash(bytes: &[u8]) -> AuditHash {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    AuditHash(hash)
}

/// Serializes audit fields into canonical bytes for hashing.
#[allow(clippy::too_many_arguments)]
pub fn canonical_event_bytes(
    sequence: u64,
    id: &AuditEventId,
    thread_id: Option<&ThreadId>,
    actor: &AuditActor,
    kind: AuditKind,
    cause: Option<&AuditEventId>,
    request_id: Option<&RequestId>,
    occurred_at: Timestamp,
    payload_hash: AuditHash,
    previous_hash: AuditHash,
) -> Vec<u8> {
    let mut out = Vec::new();
    push_u64(&mut out, sequence);
    push_u64(&mut out, id.0);
    match thread_id {
        Some(thread) => {
            out.push(1);
            push_u64(&mut out, thread.0);
        }
        None => out.push(0),
    }
    match actor {
        AuditActor::Owner(action) => {
            out.push(0);
            push_u64(&mut out, *action);
        }
        AuditActor::Agent(agent) => {
            out.push(1);
            push_u64(&mut out, *agent);
        }
        AuditActor::System => out.push(2),
    }
    push_u64(&mut out, kind_discriminant(kind));
    match cause {
        Some(c) => {
            out.push(1);
            push_u64(&mut out, c.0);
        }
        None => out.push(0),
    }
    match request_id {
        Some(r) => {
            out.push(1);
            push_u64(&mut out, r.0);
        }
        None => out.push(0),
    }
    push_i64(&mut out, occurred_at.0);
    push_u64(&mut out, payload_hash.0);
    push_u64(&mut out, previous_hash.0);
    out
}

/// Hashes canonical event bytes into the event link value.
pub fn compute_event_hash(canonical: &[u8]) -> AuditHash {
    stable_hash(canonical)
}

/// Builds a verified event ready for append once predecessor hash is known.
#[allow(clippy::too_many_arguments)]
pub fn seal_event(
    sequence: u64,
    id: AuditEventId,
    thread_id: Option<ThreadId>,
    actor: AuditActor,
    kind: AuditKind,
    cause: Option<AuditEventId>,
    request_id: Option<RequestId>,
    occurred_at: Timestamp,
    payload_hash: AuditHash,
    previous_hash: AuditHash,
) -> AuditEvent {
    let canonical = canonical_event_bytes(
        sequence,
        &id,
        thread_id.as_ref(),
        &actor,
        kind,
        cause.as_ref(),
        request_id.as_ref(),
        occurred_at,
        payload_hash,
        previous_hash,
    );
    let event_hash = compute_event_hash(&canonical);
    AuditEvent {
        sequence,
        id,
        thread_id,
        actor,
        kind,
        cause,
        request_id,
        occurred_at,
        payload_hash,
        previous_hash,
        event_hash,
        canonical,
    }
}

/// Verifies hash links, sequences, and recomputed heads; returns the chain head.
pub fn verify_audit_chain(events: &[AuditEvent]) -> Result<AuditHash, AuditChainError> {
    if events.is_empty() {
        return Err(AuditChainError::EmptyChain);
    }
    let mut previous_head = AuditHash::genesis();
    for (expected_sequence, event) in (1_u64..).zip(events.iter()) {
        if event.sequence != expected_sequence {
            return Err(AuditChainError::SequenceGap {
                expected: expected_sequence,
                found: event.sequence,
            });
        }
        if event.previous_hash != previous_head {
            return Err(AuditChainError::PreviousHashMismatch {
                sequence: event.sequence,
            });
        }
        let canonical = canonical_event_bytes(
            event.sequence,
            &event.id,
            event.thread_id.as_ref(),
            &event.actor,
            event.kind,
            event.cause.as_ref(),
            event.request_id.as_ref(),
            event.occurred_at,
            event.payload_hash,
            event.previous_hash,
        );
        let recomputed = compute_event_hash(&canonical);
        if recomputed != event.event_hash {
            return Err(AuditChainError::HashMismatch {
                sequence: event.sequence,
            });
        }
        previous_head = event.event_hash;
    }
    Ok(previous_head)
}

/// Verifies the chain and that it matches a checkpoint head at the same sequence.
pub fn verify_audit_chain_against_checkpoint(
    events: &[AuditEvent],
    checkpoint_sequence: u64,
    checkpoint_head: AuditHash,
) -> Result<(), AuditChainError> {
    let head = verify_audit_chain(events)?;
    let Some(last) = events.last() else {
        return Err(AuditChainError::EmptyChain);
    };
    if last.sequence != checkpoint_sequence {
        return Err(AuditChainError::CheckpointSequenceMismatch {
            checkpoint: checkpoint_sequence,
            chain: last.sequence,
        });
    }
    if head != checkpoint_head {
        return Err(AuditChainError::Truncated {
            expected_head: checkpoint_head,
            actual_head: head,
        });
    }
    Ok(())
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_i64(out: &mut Vec<u8>, value: i64) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn kind_discriminant(kind: AuditKind) -> u64 {
    match kind {
        AuditKind::WakeAccepted => 1,
        AuditKind::Transition => 2,
        AuditKind::LeaseCreated => 3,
        AuditKind::LeaseExpired => 4,
        AuditKind::RouterStarted => 5,
        AuditKind::RouterCompleted => 6,
        AuditKind::ToolAccepted => 7,
        AuditKind::BudgetReserved => 8,
        AuditKind::HumanRequestOpened => 9,
        AuditKind::Stop => 10,
        AuditKind::PanicEngaged => 11,
        AuditKind::PresentationReversed => 12,
    }
}
