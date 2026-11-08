//! Async reqwest E2E belongs in the daemon integration slice (Tokio runtime).
//!
//! RED specification — enable in `crates/maia-daemon/tests/router_http_async_contract.rs`
//! once that crate adds a `tokio` dev-dependency (manifest change outside Slice C):
//!
//! ```ignore
//! #[tokio::test]
//! async fn router_http_complete_cancels_stalled_sse_before_timeout() {
//!     // Bind `127.0.0.1:0` delayed SSE loopback server:
//!     //   - accept POST /v1/chat/completions with Bearer auth header present
//!     //   - flush first SSE chunk, then block 2s before `[DONE]`
//!     let router = RouterHttp::new(loopback_config, caps, true, RouterAuth::bearer("secret"))?;
//!     let request = sample_request(RequestId(42));
//!     let router = Arc::new(router);
//!     let handle = tokio::spawn({
//!         let router = Arc::clone(&router);
//!         let request = request.clone();
//!         async move { router.complete(&request).await }
//!     });
//!     tokio::time::sleep(Duration::from_millis(50)).await;
//!     router.cancel(request.request_id).await?;
//!     let error = tokio::time::timeout(Duration::from_millis(500), handle)
//!         .await
//!         .expect("cancel should finish quickly")
//!         .expect("join")
//!         .expect_err("cancelled");
//!     assert!(matches!(error, RouterError::Cancelled));
//! }
//!
//! #[tokio::test]
//! async fn router_http_complete_async_json_auth_redirect_and_success() {
//!     // Same scenarios as `contract_tests`, but call `RouterHttp::complete` (async) only.
//! }
//! ```
