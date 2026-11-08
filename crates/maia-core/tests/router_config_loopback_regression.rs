//! Loopback base URL structural parsing regressions.

use std::time::Duration;

use maia_core::router::{
    RouterConfig, RouterConfigError, RouterStreamMode, TrailingInstructionPlacement,
    validate_router_config,
};

fn config(base_url: &str) -> RouterConfig {
    RouterConfig {
        base_url: base_url.to_owned(),
        model: "m".to_owned(),
        request_timeout: Duration::from_secs(5),
        stream_mode: RouterStreamMode::Json,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    }
}

#[test]
fn router_cleartext_rejects_ipv4_loopback_prefix_spoof() {
    assert!(matches!(
        validate_router_config(&config("http://127.0.0.1.evil.com/v1"), true),
        Err(RouterConfigError::InsecureBaseUrl)
    ));
}

#[test]
fn router_cleartext_rejects_localhost_suffix_spoof() {
    assert!(matches!(
        validate_router_config(&config("http://localhost.attacker/v1"), true),
        Err(RouterConfigError::InsecureBaseUrl)
    ));
}

#[test]
fn router_cleartext_rejects_userinfo_on_loopback() {
    assert!(matches!(
        validate_router_config(&config("http://user:pass@127.0.0.1:8080/v1"), true),
        Err(RouterConfigError::InvalidBaseUrl)
    ));
}

#[test]
fn router_https_rejects_userinfo_without_echoing_credentials() {
    let error = validate_router_config(&config("https://user:super-secret@example.com/v1"), false)
        .expect_err("https userinfo");
    assert!(matches!(error, RouterConfigError::InvalidBaseUrl));
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("super-secret"));
}

#[test]
fn router_cleartext_accepts_alternate_loopback_literals() {
    validate_router_config(&config("http://127.1:8080/v1"), true).expect("127.1");
    validate_router_config(&config("http://0x7f000001:8080/v1"), true).expect("hex loopback");
}

#[test]
fn router_cleartext_rejects_rebound_loopback_hostnames() {
    assert!(matches!(
        validate_router_config(&config("http://127.0.0.1.nip.io/v1"), true),
        Err(RouterConfigError::InsecureBaseUrl)
    ));
}

#[test]
fn router_cleartext_accepts_structural_loopback_hosts() {
    validate_router_config(&config("http://127.0.0.1:8080/v1"), true).expect("ipv4 loopback");
    validate_router_config(&config("http://localhost:8080/v1"), true).expect("localhost");
    validate_router_config(&config("http://[::1]:8080/v1"), true).expect("ipv6 loopback");
}
