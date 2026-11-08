//! Cancellation lifecycle: active scope, reuse, and cleanup contracts.

use std::sync::Arc;

use maia_core::audit::RequestId;
use maia_core::router::{CancelRegistry, RouterError};

#[test]
fn cancel_active_request_then_reuse_id_is_not_pre_cancelled() {
    let registry = Arc::new(CancelRegistry::new());
    let id = RequestId(42);
    {
        let active = registry.begin_active(id).expect("first active");
        registry.register_cancel(id).expect("cancel");
        assert!(active.is_cancelled());
    }
    let reused = registry.begin_active(id).expect("reuse id");
    assert!(!reused.is_cancelled());
}

#[test]
fn cancel_inactive_request_id_is_no_op() {
    let registry = Arc::new(CancelRegistry::new());
    registry
        .register_cancel(RequestId(99))
        .expect("inactive cancel");
    let active = registry.begin_active(RequestId(99)).expect("active");
    assert!(!active.is_cancelled());
}

#[test]
fn duplicate_active_request_id_fails_closed() {
    let registry = Arc::new(CancelRegistry::new());
    let id = RequestId(7);
    let _first = registry.begin_active(id).expect("first");
    let error = registry.begin_active(id).expect_err("duplicate");
    assert!(matches!(error, RouterError::Protocol { .. }));
}

#[test]
fn lifecycle_cleanup_on_guard_drop_after_success_path() {
    let registry = Arc::new(CancelRegistry::new());
    let id = RequestId(3);
    {
        let _active = registry.begin_active(id).expect("active");
    }
    registry
        .register_cancel(id)
        .expect("cancel after end is no-op");
    let active = registry.begin_active(id).expect("reuse");
    assert!(!active.is_cancelled());
}

#[test]
fn stale_generation_end_does_not_remove_newer_active() {
    let registry = Arc::new(CancelRegistry::new());
    let id = RequestId(5);
    let first = registry.begin_active(id).expect("first");
    let first_generation = first.generation();
    drop(first);
    let second = registry.begin_active(id).expect("second");
    assert_ne!(first_generation, second.generation());
    registry.end_lifecycle_for_generation(id, first_generation);
    registry.register_cancel(id).expect("cancel second");
    assert!(second.is_cancelled());
}

#[test]
fn dropped_waiter_does_not_leave_permanent_cancel_state() {
    let registry = Arc::new(CancelRegistry::new());
    let id = RequestId(11);
    let active = registry.begin_active(id).expect("active");
    {
        let _wait = active.wait_for();
    }
    assert!(!active.is_cancelled());
    registry.register_cancel(id).expect("cancel");
    assert!(active.is_cancelled());
}
