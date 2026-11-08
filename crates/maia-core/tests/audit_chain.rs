//! Hash-chain verification contract from `docs/design/06-agents.md`.

use maia_core::audit::{
    AuditActor, AuditEventId, AuditHash, AuditKind, ThreadId, Timestamp, seal_event,
    verify_audit_chain, verify_audit_chain_against_checkpoint,
};

fn sample_event(
    sequence: u64,
    previous_hash: AuditHash,
    payload_seed: u8,
) -> maia_core::audit::AuditEvent {
    seal_event(
        sequence,
        AuditEventId(sequence),
        Some(ThreadId(1)),
        AuditActor::System,
        AuditKind::Transition,
        None,
        None,
        Timestamp(1_700_000_000),
        AuditHash::from_seed(payload_seed),
        previous_hash,
    )
}

#[test]
fn verify_audit_chain_accepts_valid_three_event_chain() {
    let genesis = AuditHash::genesis();
    let e1 = sample_event(1, genesis, 10);
    let e2 = sample_event(2, e1.event_hash, 20);
    let e3 = sample_event(3, e2.event_hash, 30);
    verify_audit_chain(&[e1, e2, e3]).expect("valid chain");
}

#[test]
fn verify_audit_chain_rejects_edited_payload_hash() {
    let genesis = AuditHash::genesis();
    let mut e1 = sample_event(1, genesis, 10);
    e1.payload_hash = AuditHash::from_seed(99);
    let err = verify_audit_chain(&[e1]).expect_err("edited payload must fail");
    assert!(matches!(
        err,
        maia_core::audit::AuditChainError::HashMismatch { .. }
    ));
}

#[test]
fn verify_audit_chain_rejects_truncation_against_expected_head() {
    let genesis = AuditHash::genesis();
    let e1 = sample_event(1, genesis, 10);
    let e2 = sample_event(2, e1.event_hash, 20);
    let head = e2.event_hash;
    let err = verify_audit_chain_against_checkpoint(&[e1], 2, head)
        .expect_err("truncated chain must fail");
    assert!(matches!(
        err,
        maia_core::audit::AuditChainError::Truncated { .. }
            | maia_core::audit::AuditChainError::CheckpointSequenceMismatch { .. }
    ));
}

#[test]
fn verify_audit_chain_rejects_reordered_events() {
    let genesis = AuditHash::genesis();
    let e1 = sample_event(1, genesis, 10);
    let e2 = sample_event(2, e1.event_hash, 20);
    let err = verify_audit_chain(&[e2, e1]).expect_err("reordered chain must fail");
    assert!(matches!(
        err,
        maia_core::audit::AuditChainError::SequenceGap { .. }
            | maia_core::audit::AuditChainError::PreviousHashMismatch { .. }
    ));
}
