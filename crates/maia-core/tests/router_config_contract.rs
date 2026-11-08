//! Router configuration validation contract.

use std::time::Duration;

use maia_core::router::{
    RouterConfig, RouterConfigError, RouterStreamMode, TrailingInstructionPlacement,
    validate_router_config,
};

#[test]
fn public_base_url_must_use_https() {
    let config = RouterConfig {
        base_url: "http://api.example.com/v1".to_owned(),
        model: "test-model".to_owned(),
        request_timeout: Duration::from_secs(30),
        stream_mode: RouterStreamMode::Json,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    };
    let error = validate_router_config(&config, false).expect_err("http must fail");
    assert!(matches!(error, RouterConfigError::InsecureBaseUrl));
}

#[test]
fn loopback_http_allowed_only_when_policy_permits() {
    let config = RouterConfig {
        base_url: "http://127.0.0.1:8080/v1".to_owned(),
        model: "local".to_owned(),
        request_timeout: Duration::from_secs(5),
        stream_mode: RouterStreamMode::ServerSentEvents,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingUserPart,
    };
    assert!(matches!(
        validate_router_config(&config, false),
        Err(RouterConfigError::InsecureBaseUrl)
    ));
    validate_router_config(&config, true).expect("loopback http permitted");
}

#[test]
fn zero_timeout_is_rejected() {
    let config = RouterConfig {
        base_url: "https://router.example/v1".to_owned(),
        model: "m".to_owned(),
        request_timeout: Duration::ZERO,
        stream_mode: RouterStreamMode::Json,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    };
    assert!(matches!(
        validate_router_config(&config, false),
        Err(RouterConfigError::InvalidTimeout)
    ));
}
