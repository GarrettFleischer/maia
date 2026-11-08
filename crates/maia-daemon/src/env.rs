//! Provider environment parsing for the daemon composition root.
//!
//! Callers pass owned pairs. This module does not read process environment
//! variables. `BASE_URL` and `API_KEY` must each appear at most once; a second
//! entry is rejected rather than replaced. Empty and whitespace-only values
//! are missing. `Debug` redacts the base URL and the API key. The API key type
//! has no `Display` implementation.

/// Why provider environment could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvError {
    /// `BASE_URL` was absent, empty, or whitespace.
    MissingBaseUrl,
    /// `API_KEY` was absent, empty, or whitespace.
    MissingApiKey,
    /// `BASE_URL` or `API_KEY` was present more than once.
    DuplicateEntry,
}

impl std::fmt::Display for EnvError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingBaseUrl | Self::MissingApiKey | Self::DuplicateEntry => {
                formatter.write_str("Model provider is not configured.")
            }
        }
    }
}

impl std::error::Error for EnvError {}

/// Base URL and API key supplied by the composition root.
pub struct ModelEnv {
    base_url: String,
    api_key: ProviderApiKey,
}

impl ModelEnv {
    /// Returns the trimmed provider base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Returns the provider API key.
    pub fn api_key(&self) -> &ProviderApiKey {
        &self.api_key
    }
}

impl std::fmt::Debug for ModelEnv {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ModelEnv([redacted])")
    }
}

/// API key bytes. `Debug` is redacted. This type does not implement `Display`.
pub struct ProviderApiKey(String);

impl ProviderApiKey {
    /// Borrows the key for the composition root to inject into a client.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ProviderApiKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ProviderApiKey([redacted])")
    }
}

const BASE_URL_NAME: &str = "BASE_URL";
const API_KEY_NAME: &str = "API_KEY";

/// Reads `BASE_URL` and `API_KEY` from an explicit pair list.
///
/// Names are matched exactly. Other names are ignored. The first repeated
/// `BASE_URL` or `API_KEY` returns [`EnvError::DuplicateEntry`]. After that
/// scan, a missing or blank base URL returns [`EnvError::MissingBaseUrl`],
/// then a missing or blank API key returns [`EnvError::MissingApiKey`].
/// Stored values are trimmed.
pub fn read_model_env(vars: &[(&str, &str)]) -> Result<ModelEnv, EnvError> {
    let mut base_url = None;
    let mut api_key = None;
    for &(name, value) in vars {
        match name {
            BASE_URL_NAME => insert_once(&mut base_url, value)?,
            API_KEY_NAME => insert_once(&mut api_key, value)?,
            _ => {}
        }
    }
    let base_url = required_text(base_url, EnvError::MissingBaseUrl)?;
    let api_key = required_text(api_key, EnvError::MissingApiKey)?;
    Ok(ModelEnv {
        base_url,
        api_key: ProviderApiKey(api_key),
    })
}

fn insert_once(slot: &mut Option<String>, value: &str) -> Result<(), EnvError> {
    if slot.is_some() {
        return Err(EnvError::DuplicateEntry);
    }
    *slot = Some(value.to_owned());
    Ok(())
}

fn required_text(value: Option<String>, missing: EnvError) -> Result<String, EnvError> {
    match value {
        Some(text) if !text.trim().is_empty() => Ok(text.trim().to_owned()),
        Some(_) | None => Err(missing),
    }
}
