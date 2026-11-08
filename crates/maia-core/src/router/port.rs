//! `Router` port.

use core::future::Future;

use crate::audit::RequestId;
use crate::router::error::RouterError;
use crate::router::types::{RouterRequest, RouterResponse};

/// OpenAI-compatible completion transport.
pub trait Router {
    /// Sends one completion request and returns a normalized response.
    fn complete(
        &self,
        request: &RouterRequest,
    ) -> impl Future<Output = Result<RouterResponse, RouterError>> + Send;

    /// Cancels an in-flight completion when supported.
    fn cancel(&self, request_id: RequestId)
    -> impl Future<Output = Result<(), RouterError>> + Send;
}
