//! Promoter provider environment. Separate from the router composition root.
//!
//! Callers pass owned pairs. This module does not read process environment
//! variables. Secrets are never displayed.

use crate::env::EnvError;
use crate::env::ModelEnv;
use crate::env::ProviderApiKey;
use crate::env::read_model_env;

/// Default promoter model id when `PROMOTER_MODEL` is absent.
pub const DEFAULT_PROMOTER_MODEL: &str = "auto";

/// Default daily promotion call ceiling.
pub const DEFAULT_PROMOTER_DAILY_CALL_CAP: u32 = 1_000;

/// Default daily promotion token ceiling.
pub const DEFAULT_PROMOTER_DAILY_TOKEN_CAP: u64 = 1_000_000;

/// Promoter endpoint and ceilings read only at the composition root.
#[derive(Debug)]
pub struct PromoterEnv {
    model_env: ModelEnv,
    model: String,
    daily_call_cap: u32,
    daily_token_cap: u64,
}

impl PromoterEnv {
    /// Trimmed promoter base URL.
    pub fn base_url(&self) -> &str {
        self.model_env.base_url()
    }

    /// Promoter API key.
    pub fn api_key(&self) -> &ProviderApiKey {
        self.model_env.api_key()
    }

    /// Promoter model id.
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Per-day call ceiling.
    pub fn daily_call_cap(&self) -> u32 {
        self.daily_call_cap
    }

    /// Per-day token ceiling.
    pub fn daily_token_cap(&self) -> u64 {
        self.daily_token_cap
    }
}

/// Reads `PROMOTER_*` with fallback to router `BASE_URL` / `API_KEY`.
///
/// Model defaults to [`DEFAULT_PROMOTER_MODEL`]. Caps default to
/// [`DEFAULT_PROMOTER_DAILY_CALL_CAP`] and [`DEFAULT_PROMOTER_DAILY_TOKEN_CAP`].
pub fn read_promoter_env(vars: &[(&str, &str)]) -> Result<PromoterEnv, EnvError> {
    let mut promoter_base = None;
    let mut promoter_key = None;
    let mut router_base = None;
    let mut router_key = None;
    let mut model = None;
    let mut call_cap = None;
    let mut token_cap = None;
    for &(name, value) in vars {
        match name {
            "PROMOTER_BASE_URL" => insert_once(&mut promoter_base, value)?,
            "PROMOTER_API_KEY" => insert_once(&mut promoter_key, value)?,
            "PROMOTER_MODEL" => insert_once(&mut model, value)?,
            "PROMOTER_DAILY_CALL_CAP" => insert_once(&mut call_cap, value)?,
            "PROMOTER_DAILY_TOKEN_CAP" => insert_once(&mut token_cap, value)?,
            "BASE_URL" => insert_once(&mut router_base, value)?,
            "API_KEY" => insert_once(&mut router_key, value)?,
            _ => {}
        }
    }
    let base = first_present(promoter_base, router_base).ok_or(EnvError::MissingBaseUrl)?;
    let key = first_present(promoter_key, router_key).ok_or(EnvError::MissingApiKey)?;
    let model_env = read_model_env(&[("BASE_URL", base.as_str()), ("API_KEY", key.as_str())])?;
    let model = model
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_PROMOTER_MODEL.to_owned());
    let daily_call_cap = parse_u32(call_cap, DEFAULT_PROMOTER_DAILY_CALL_CAP)?;
    let daily_token_cap = parse_u64(token_cap, DEFAULT_PROMOTER_DAILY_TOKEN_CAP)?;
    Ok(PromoterEnv {
        model_env,
        model,
        daily_call_cap,
        daily_token_cap,
    })
}

fn insert_once(slot: &mut Option<String>, value: &str) -> Result<(), EnvError> {
    if slot.is_some() {
        return Err(EnvError::DuplicateEntry);
    }
    *slot = Some(value.to_owned());
    Ok(())
}

fn first_present(preferred: Option<String>, fallback: Option<String>) -> Option<String> {
    preferred
        .filter(|value| !value.trim().is_empty())
        .or_else(|| fallback.filter(|value| !value.trim().is_empty()))
}

fn parse_u32(raw: Option<String>, default: u32) -> Result<u32, EnvError> {
    Ok(match raw {
        None => default,
        Some(text) if text.trim().is_empty() => default,
        Some(text) => text.trim().parse().unwrap_or(default),
    })
}

fn parse_u64(raw: Option<String>, default: u64) -> Result<u64, EnvError> {
    Ok(match raw {
        None => default,
        Some(text) if text.trim().is_empty() => default,
        Some(text) => text.trim().parse().unwrap_or(default),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_router_env_and_auto_model() {
        let env = read_promoter_env(&[("BASE_URL", "http://127.0.0.1:1/v1"), ("API_KEY", "k")])
            .expect("env");
        assert_eq!(env.base_url(), "http://127.0.0.1:1/v1");
        assert_eq!(env.model(), "auto");
        assert_eq!(env.daily_call_cap(), 1_000);
        assert_eq!(env.daily_token_cap(), 1_000_000);
        assert_eq!(env.daily_call_cap(), DEFAULT_PROMOTER_DAILY_CALL_CAP);
        assert_eq!(env.daily_token_cap(), DEFAULT_PROMOTER_DAILY_TOKEN_CAP);
    }

    #[test]
    fn prefers_promoter_overrides() {
        let env = read_promoter_env(&[
            ("BASE_URL", "http://router/v1"),
            ("API_KEY", "router-key"),
            ("PROMOTER_BASE_URL", "http://promoter/v1"),
            ("PROMOTER_API_KEY", "promoter-key"),
            ("PROMOTER_MODEL", "small"),
            ("PROMOTER_DAILY_CALL_CAP", "12"),
        ])
        .expect("env");
        assert_eq!(env.base_url(), "http://promoter/v1");
        assert_eq!(env.api_key().as_str(), "promoter-key");
        assert_eq!(env.model(), "small");
        assert_eq!(env.daily_call_cap(), 12);
    }
}
