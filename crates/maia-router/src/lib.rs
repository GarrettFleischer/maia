#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! OpenAI-compatible HTTP router adapter.

mod adapter;
mod client;
mod dto;

#[cfg(test)]
mod async_integration_handoff;
#[cfg(test)]
mod contract_tests;
#[cfg(test)]
mod test_loopback_http;

pub use adapter::{ReplyProgress, RouterAuth, RouterHttp, error_redacts_secret};
pub use client::{
    build_router_client, build_router_client_with_loopback, chat_completions_url, map_http_status,
    map_transport_error, models_url, retry_after_delay,
};
