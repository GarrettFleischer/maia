//! Reqwest client construction with router security settings.

use std::time::Duration;

use maia_core::router::{
    RouterConfig, RouterConfigError, RouterError, RouterStreamMode, TrailingInstructionPlacement,
    validate_router_config,
};
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode};

/// Builds the shared HTTP client for router calls.
pub fn build_router_client(config: &RouterConfig) -> Result<Client, RouterError> {
    validate_router_config(config, false).map_err(RouterError::Configuration)?;
    Client::builder()
        .redirect(Policy::none())
        .timeout(config.request_timeout)
        .user_agent("maia-router/0.1")
        .build()
        .map_err(|error| RouterError::Protocol {
            detail: error.to_string(),
        })
}

/// Builds a client that permits loopback HTTP base URLs when policy allows it.
pub fn build_router_client_with_loopback(
    config: &RouterConfig,
    allow_loopback_http: bool,
) -> Result<Client, RouterError> {
    validate_router_config(config, allow_loopback_http).map_err(RouterError::Configuration)?;
    Client::builder()
        .redirect(Policy::none())
        .timeout(config.request_timeout)
        .user_agent("maia-router/0.1")
        .build()
        .map_err(|error| RouterError::Protocol {
            detail: error.to_string(),
        })
}

/// Maps HTTP status codes to typed router errors before body parsing.
pub fn map_http_status(status: StatusCode) -> Option<RouterError> {
    match status.as_u16() {
        401 | 403 => Some(RouterError::Authentication),
        429 => Some(RouterError::RateLimited),
        500..=599 => Some(RouterError::Server {
            code: status.as_u16(),
        }),
        _ => None,
    }
}

/// Classifies reqwest transport failures without leaking secrets.
pub fn map_transport_error(error: reqwest::Error) -> RouterError {
    if error.is_timeout() {
        RouterError::Timeout
    } else if error.is_redirect() {
        RouterError::Protocol {
            detail: "redirects are disabled".to_owned(),
        }
    } else {
        RouterError::Protocol {
            detail: "transport failure".to_owned(),
        }
    }
}

/// Returns chat completions URL for a validated base URL.
pub fn chat_completions_url(base_url: &str) -> Result<String, RouterConfigError> {
    let trimmed = trimmed_provider_base(base_url)?;
    Ok(format!("{trimmed}/chat/completions"))
}

/// Returns the models URL for a provider base.
///
/// Trailing-slash trimming matches [`chat_completions_url`]. The base must
/// pass [`validate_router_config`] with loopback HTTP permitted, so HTTPS
/// provider URLs and loopback HTTP URLs are accepted and other cleartext or
/// unsupported schemes are rejected. Userinfo, query strings, and fragments
/// are rejected. This function does not send a request.
pub fn models_url(base: &str) -> Result<String, RouterConfigError> {
    let trimmed = trimmed_provider_base(base)?;
    if trimmed.contains('?') || trimmed.contains('#') {
        return Err(RouterConfigError::InvalidBaseUrl);
    }
    accept_discovery_base(trimmed)?;
    Ok(format!("{trimmed}/models"))
}

fn trimmed_provider_base(base_url: &str) -> Result<&str, RouterConfigError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(RouterConfigError::InvalidBaseUrl);
    }
    Ok(trimmed)
}

fn accept_discovery_base(base: &str) -> Result<(), RouterConfigError> {
    let config = RouterConfig {
        base_url: base.to_owned(),
        model: String::new(),
        request_timeout: DISCOVERY_URL_CHECK,
        stream_mode: RouterStreamMode::Json,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    };
    validate_router_config(&config, DISCOVERY_ALLOWS_LOOPBACK_HTTP)
}

/// Loopback HTTP stays allowed. Public cleartext still fails inside validation.
const DISCOVERY_ALLOWS_LOOPBACK_HTTP: bool = true;

/// Present only because router URL validation rejects a zero timeout.
/// `models_url` does not place a request, and this duration is not returned.
const DISCOVERY_URL_CHECK: Duration = Duration::from_secs(1);

/// Parses retry-after seconds when present.
pub fn retry_after_delay(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let seconds = value.parse::<u64>().ok()?;
    Some(Duration::from_secs(seconds))
}
