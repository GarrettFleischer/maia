//! Router configuration validation.

use crate::router::error::{RouterConfigError, RouterError};
use crate::router::types::RouterConfig;
use crate::router::url::{cleartext_base_url_is_loopback, reject_userinfo_in_base_url};

/// Validates router configuration before any network I/O.
pub fn validate_router_config(
    config: &RouterConfig,
    allow_loopback_http: bool,
) -> Result<(), RouterConfigError> {
    if config.request_timeout.is_zero() {
        return Err(RouterConfigError::InvalidTimeout);
    }
    let base = config.base_url.trim();
    if base.is_empty() {
        return Err(RouterConfigError::InvalidBaseUrl);
    }
    let lower = base.to_ascii_lowercase();
    if lower.starts_with("https://") {
        reject_userinfo_in_base_url(base)?;
        return Ok(());
    }
    if lower.starts_with("http://") {
        if !allow_loopback_http {
            return Err(RouterConfigError::InsecureBaseUrl);
        }
        return match cleartext_base_url_is_loopback(base) {
            Ok(true) => Ok(()),
            Ok(false) => Err(RouterConfigError::InsecureBaseUrl),
            Err(error) => Err(error),
        };
    }
    Err(RouterConfigError::InsecureBaseUrl)
}

/// Maps configuration errors into router errors for adapter boundaries.
pub fn configuration_error(error: RouterConfigError) -> RouterError {
    RouterError::Configuration(error)
}
