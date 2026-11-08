//! Cancellation registry with scoped active lifecycles.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use crate::audit::RequestId;
use crate::router::error::RouterError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct CancelWaitKey {
    request_id: RequestId,
    generation: u64,
}

#[derive(Debug, Clone, Copy)]
struct ActiveSlot {
    generation: u64,
    cancelled: bool,
}

/// Tracks in-flight request cancellation scoped to one active lifecycle per id.
#[derive(Debug, Default)]
pub struct CancelRegistry {
    next_generation: Mutex<u64>,
    active: Mutex<HashMap<RequestId, ActiveSlot>>,
    waiters: Mutex<HashMap<CancelWaitKey, Waker>>,
}

impl CancelRegistry {
    /// Creates an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Opens one active cancellation scope for a request id.
    pub fn begin_active(
        self: &Arc<Self>,
        request_id: RequestId,
    ) -> Result<RequestCancelGuard, RouterError> {
        let mut next = self
            .next_generation
            .lock()
            .map_err(|_| RouterError::Protocol {
                detail: "cancel registry poisoned".to_owned(),
            })?;
        let generation = *next;
        *next = next.saturating_add(1);
        let mut active = self.active.lock().map_err(|_| RouterError::Protocol {
            detail: "cancel registry poisoned".to_owned(),
        })?;
        if active.contains_key(&request_id) {
            return Err(RouterError::Protocol {
                detail: "duplicate active request id".to_owned(),
            });
        }
        active.insert(
            request_id,
            ActiveSlot {
                generation,
                cancelled: false,
            },
        );
        Ok(RequestCancelGuard {
            request_id,
            generation,
            registry: Arc::clone(self),
        })
    }

    /// Cancels the active lifecycle for `request_id`, or no-ops when inactive.
    pub fn register_cancel(&self, request_id: RequestId) -> Result<(), RouterError> {
        let generation = {
            let mut active = self.active.lock().map_err(|_| RouterError::Protocol {
                detail: "cancel registry poisoned".to_owned(),
            })?;
            let Some(slot) = active.get_mut(&request_id) else {
                return Ok(());
            };
            slot.cancelled = true;
            slot.generation
        };
        self.wake_waiters(CancelWaitKey {
            request_id,
            generation,
        });
        Ok(())
    }

    /// Ends one lifecycle only when the generation still matches (test/support hook).
    pub fn end_lifecycle_for_generation(&self, request_id: RequestId, generation: u64) {
        self.end_lifecycle(request_id, generation);
    }

    fn end_lifecycle(&self, request_id: RequestId, generation: u64) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .get(&request_id)
                .is_some_and(|slot| slot.generation == generation)
            {
                active.remove(&request_id);
            }
        }
        if let Ok(mut waiters) = self.waiters.lock() {
            waiters.remove(&CancelWaitKey {
                request_id,
                generation,
            });
        }
    }

    fn is_cancelled_generation(&self, request_id: RequestId, generation: u64) -> bool {
        self.active
            .lock()
            .ok()
            .and_then(|active| active.get(&request_id).copied())
            .filter(|slot| slot.generation == generation)
            .is_some_and(|slot| slot.cancelled)
    }

    fn wake_waiters(&self, key: CancelWaitKey) {
        if let Ok(mut waiters) = self.waiters.lock() {
            if let Some(waker) = waiters.remove(&key) {
                waker.wake();
            }
        }
    }

    fn store_waiter(&self, key: CancelWaitKey, waker: Waker) {
        if let Ok(mut waiters) = self.waiters.lock() {
            waiters.insert(key, waker);
        }
    }
}

/// RAII guard for one active request cancellation scope.
#[derive(Debug)]
pub struct RequestCancelGuard {
    request_id: RequestId,
    generation: u64,
    registry: Arc<CancelRegistry>,
}

impl RequestCancelGuard {
    /// Request id bound to this active scope.
    pub fn request_id(&self) -> RequestId {
        self.request_id
    }

    /// Generation token separating reused request ids.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Returns true when this active scope has been cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.registry
            .is_cancelled_generation(self.request_id, self.generation)
    }

    /// Returns a future that completes when this scope is cancelled.
    pub fn wait_for(&self) -> WaitForCancel {
        WaitForCancel {
            key: CancelWaitKey {
                request_id: self.request_id,
                generation: self.generation,
            },
            registry: Arc::clone(&self.registry),
        }
    }
}

impl Drop for RequestCancelGuard {
    fn drop(&mut self) {
        self.registry
            .end_lifecycle(self.request_id, self.generation);
    }
}

/// Future that resolves when one scoped request lifecycle is cancelled.
pub struct WaitForCancel {
    key: CancelWaitKey,
    registry: Arc<CancelRegistry>,
}

impl Future for WaitForCancel {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self
            .registry
            .is_cancelled_generation(self.key.request_id, self.key.generation)
        {
            return Poll::Ready(());
        }
        self.registry.store_waiter(self.key, cx.waker().clone());
        if self
            .registry
            .is_cancelled_generation(self.key.request_id, self.key.generation)
        {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}

impl Drop for WaitForCancel {
    fn drop(&mut self) {
        if let Ok(mut waiters) = self.registry.waiters.lock() {
            waiters.remove(&self.key);
        }
    }
}
