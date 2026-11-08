//! Response-body accumulation limits during streaming reads.

use maia_core::router::{
    BoundedResponseCollector, MAX_ROUTER_RESPONSE_BYTES, RouterError, ensure_within_limit,
};

#[test]
fn response_collector_accepts_exact_max_boundary() {
    let mut collector = BoundedResponseCollector::new();
    let chunk_a = MAX_ROUTER_RESPONSE_BYTES - 1;
    let chunk_b = 1usize;
    collector
        .push_chunk(&vec![b'a'; chunk_a])
        .expect("under limit");
    collector
        .push_chunk(&vec![b'b'; chunk_b])
        .expect("exact max");
    assert_eq!(collector.len(), MAX_ROUTER_RESPONSE_BYTES);
    assert!(!collector.is_empty());
}

#[test]
fn response_collector_starts_empty() {
    let collector = BoundedResponseCollector::new();
    assert!(collector.is_empty());
    assert_eq!(collector.len(), 0);
}

#[test]
fn response_collector_rejects_one_byte_over_max() {
    let mut collector = BoundedResponseCollector::new();
    collector
        .push_chunk(&vec![0u8; MAX_ROUTER_RESPONSE_BYTES])
        .expect("at max");
    let error = collector.push_chunk(&[1u8]).expect_err("over limit");
    assert!(matches!(
        error,
        RouterError::ResourceLimit {
            field: "response_body"
        }
    ));
}

#[test]
fn ensure_within_limit_rejects_oversize_single_chunk() {
    let error = ensure_within_limit(
        0,
        MAX_ROUTER_RESPONSE_BYTES + 1,
        MAX_ROUTER_RESPONSE_BYTES,
        "response_body",
    )
    .expect_err("single chunk");
    assert!(matches!(
        error,
        RouterError::ResourceLimit {
            field: "response_body"
        }
    ));
}
