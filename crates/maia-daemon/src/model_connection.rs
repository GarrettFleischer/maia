//! Model connection values for Settings.
//!
//! The API key is write-only. Public JSON never includes it, and errors do not
//! interpolate the base URL or the key.

use std::time::Duration;

use maia_core::router::ReasoningEffort;
use maia_core::router::RouterCapabilities;
use maia_core::router::RouterConfig;
use maia_core::router::RouterError;
use maia_core::router::RouterStreamMode;
use maia_core::router::TrailingInstructionPlacement;
use maia_router::RouterAuth;
use maia_router::RouterHttp;
use maia_router::models_url;
use serde::Deserialize;
use serde_json::Value;

const MAX_BASE_URL_BYTES: usize = 2048;
const MAX_MODEL_BYTES: usize = 256;
const MAX_KEY_BYTES: usize = 2560;

/// How long one chat call stays open.
///
/// A local gateway such as FreeLLMAPI gives each upstream provider its own
/// 60-second hop. Hanging up at that same moment cancels failover and leaves
/// the slow provider unbenched, so the next message stalls the same way.
/// Test connection only lists models, which returns immediately. Three minutes
/// covers two of those hops and the fallback body.
const LIVE_ROUTER_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// Why a model connection form could not be accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelConnectionError {
    /// The form is missing a field or a field is not acceptable.
    Invalid,
}

impl std::fmt::Display for ModelConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Model connection is incomplete.")
    }
}

impl std::error::Error for ModelConnectionError {}

/// What to do with the stored API key.
pub enum KeyChoice {
    /// Leave the stored key in place.
    Keep,
    /// Replace the stored key. The value is not shown again.
    Replace(String),
}

/// Fields accepted from Settings. The key is not returned to the browser.
pub struct ModelConnectionWrite {
    /// Trimmed provider base URL.
    pub base_url: String,
    /// Trimmed model id.
    pub model: String,
    /// Reasoning effort copied onto later router requests.
    pub reasoning: ReasoningEffort,
    /// Keep or replace the stored key.
    pub key: KeyChoice,
}

/// A connection test names the endpoint and may supply a new key.
pub struct ModelTestRequest {
    /// Trimmed provider base URL.
    pub base_url: String,
    /// Keep or replace, without saving.
    pub key: KeyChoice,
}

/// Connection fields the browser is allowed to see.
#[derive(Clone)]
pub struct PublicModelConnection {
    /// Provider base URL.
    pub base_url: String,
    /// Whether a key is stored. The key itself is absent.
    pub key_set: bool,
    /// Selected model id.
    pub model: String,
    /// Saved reasoning effort.
    pub reasoning: ReasoningEffort,
}

/// Parses a Settings save body. The raw value is consumed.
///
/// # Errors
///
/// Returns [`ModelConnectionError::Invalid`] when a field is missing or rejected.
pub fn parse_model_write(value: Value) -> Result<ModelConnectionWrite, ModelConnectionError> {
    let wire: WireSave =
        serde_json::from_value(value).map_err(|_| ModelConnectionError::Invalid)?;
    Ok(ModelConnectionWrite {
        base_url: accept_base_url(&wire.base_url)?,
        model: accept_model(&wire.model)?,
        reasoning: parse_reasoning_effort(&wire.reasoning)?,
        key: key_choice(wire.api_key)?,
    })
}

/// Parses a connection test body. The raw value is consumed.
///
/// # Errors
///
/// Returns [`ModelConnectionError::Invalid`] when the base URL is rejected.
pub fn parse_model_test(value: Value) -> Result<ModelTestRequest, ModelConnectionError> {
    let wire: WireTest =
        serde_json::from_value(value).map_err(|_| ModelConnectionError::Invalid)?;
    Ok(ModelTestRequest {
        base_url: accept_base_url(&wire.base_url)?,
        key: key_choice(wire.api_key)?,
    })
}

/// Resolves the key to use for a save or a test.
///
/// A replacement wins. Otherwise the stored key is used, then the process boot
/// key. Nothing is copied into an error.
///
/// # Errors
///
/// Returns [`ModelConnectionError::Invalid`] when no key is available.
pub fn resolve_key(
    choice: KeyChoice,
    stored: Option<String>,
    boot: Option<&str>,
) -> Result<String, ModelConnectionError> {
    match choice {
        KeyChoice::Replace(key) => Ok(key),
        KeyChoice::Keep => stored
            .filter(|key| !key.is_empty())
            .or_else(|| {
                boot.filter(|key| !key.trim().is_empty())
                    .map(|key| key.trim().to_owned())
            })
            .ok_or(ModelConnectionError::Invalid),
    }
}

/// Parses `low`, `medium`, or `high`.
///
/// # Errors
///
/// Returns [`ModelConnectionError::Invalid`] for any other text.
pub fn parse_reasoning_effort(value: &str) -> Result<ReasoningEffort, ModelConnectionError> {
    match value.trim() {
        "low" => Ok(ReasoningEffort::Low),
        "medium" => Ok(ReasoningEffort::Medium),
        "high" => Ok(ReasoningEffort::High),
        _ => Err(ModelConnectionError::Invalid),
    }
}

/// Stable reasoning name stored and shown in Settings.
pub fn reasoning_name(reasoning: ReasoningEffort) -> &'static str {
    match reasoning {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
    }
}

/// Public connection JSON. The key is not a field on [`PublicModelConnection`].
pub fn connection_json(view: &PublicModelConnection, models: &[String]) -> Value {
    serde_json::json!({
        "base_url": view.base_url,
        "key_set": view.key_set,
        "model": view.model,
        "reasoning": reasoning_name(view.reasoning),
        "models": models,
    })
}

/// Builds the router adapter used for later model calls.
///
/// # Errors
///
/// Returns [`ModelConnectionError::Invalid`] when the adapter rejects the endpoint.
pub fn router_from_connection(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<RouterHttp, ModelConnectionError> {
    router_with_stream(base_url, api_key, model, RouterStreamMode::Json)
}

/// Same adapter as [`router_from_connection`], asking the provider for tokens.
///
/// # Errors
///
/// Returns [`ModelConnectionError::Invalid`] when the adapter rejects the endpoint.
pub fn streaming_router_from_connection(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<RouterHttp, ModelConnectionError> {
    router_with_stream(base_url, api_key, model, RouterStreamMode::ServerSentEvents)
}

fn router_with_stream(
    base_url: &str,
    api_key: &str,
    model: &str,
    stream_mode: RouterStreamMode,
) -> Result<RouterHttp, ModelConnectionError> {
    let config = RouterConfig {
        base_url: base_url.to_owned(),
        model: model.to_owned(),
        request_timeout: LIVE_ROUTER_REQUEST_TIMEOUT,
        stream_mode,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    };
    let capabilities = RouterCapabilities {
        readable_reasoning: true,
        tool_calls: true,
        cached_token_usage: false,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    };
    RouterHttp::new(config, capabilities, true, RouterAuth::bearer(api_key)).map_err(hide_router)
}

fn hide_router(error: RouterError) -> ModelConnectionError {
    let _ = error;
    ModelConnectionError::Invalid
}

fn key_choice(submitted: Option<String>) -> Result<KeyChoice, ModelConnectionError> {
    match submitted {
        None => Ok(KeyChoice::Keep),
        Some(value) if value.trim().is_empty() => Ok(KeyChoice::Keep),
        Some(value) if value.trim().len() > MAX_KEY_BYTES => Err(ModelConnectionError::Invalid),
        Some(value) => Ok(KeyChoice::Replace(value.trim().to_owned())),
    }
}

fn accept_base_url(value: &str) -> Result<String, ModelConnectionError> {
    let trimmed = value.trim().trim_end_matches('/').to_owned();
    if trimmed.is_empty()
        || trimmed.len() > MAX_BASE_URL_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err(ModelConnectionError::Invalid);
    }
    models_url(&trimmed).map_err(|_| ModelConnectionError::Invalid)?;
    Ok(trimmed)
}

fn accept_model(value: &str) -> Result<String, ModelConnectionError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_MODEL_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return Err(ModelConnectionError::Invalid);
    }
    Ok(trimmed.to_owned())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSave {
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    model: String,
    reasoning: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireTest {
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_router_outlasts_one_gateway_provider_hop() {
        let router =
            router_from_connection("http://127.0.0.1:9/v1", "test-key", "auto").expect("router");
        assert!(router.request_timeout() >= Duration::from_secs(180));
        assert!(!router.streams_replies());
    }

    #[test]
    fn the_chat_router_asks_for_tokens_as_they_arrive() {
        let router = streaming_router_from_connection("http://127.0.0.1:9/v1", "test-key", "auto")
            .expect("router");
        assert!(router.streams_replies());
    }

    #[test]
    fn public_json_omits_the_api_key() {
        let write = parse_model_write(serde_json::json!({
            "base_url": "https://example.test/v1/",
            "api_key": "sk-hidden-value",
            "model": " example-chat ",
            "reasoning": "high"
        }))
        .expect("write");
        let KeyChoice::Replace(key) = write.key else {
            panic!("replacement key");
        };
        assert_eq!(key, "sk-hidden-value");
        let public = connection_json(
            &PublicModelConnection {
                base_url: write.base_url,
                key_set: true,
                model: write.model,
                reasoning: write.reasoning,
            },
            &[],
        );
        let text = public.to_string();
        assert!(!text.contains("sk-hidden-value"));
        assert!(text.contains("example-chat"));
        assert!(text.contains("https://example.test/v1"));
        assert!(!text.contains("https://example.test/v1/"));
    }

    #[test]
    fn keep_uses_the_stored_key_and_a_blank_submission_does_not_replace_it() {
        let kept = resolve_key(
            KeyChoice::Keep,
            Some("stored-key".to_owned()),
            Some("boot-key"),
        )
        .expect("stored");
        assert_eq!(kept, "stored-key");
        let write = parse_model_write(serde_json::json!({
            "base_url": "https://example.test/v1",
            "api_key": "   ",
            "model": "example-chat",
            "reasoning": "low"
        }))
        .expect("blank means keep");
        assert!(matches!(write.key, KeyChoice::Keep));
        assert!(resolve_key(KeyChoice::Keep, None, None).is_err());
    }

    #[test]
    fn cleartext_public_urls_and_oversized_keys_are_rejected() {
        assert!(
            parse_model_write(serde_json::json!({
                "base_url": "http://example.test/v1",
                "api_key": "sk-hidden-value",
                "model": "example-chat",
                "reasoning": "medium"
            }))
            .is_err()
        );
        let huge = "k".repeat(MAX_KEY_BYTES + 1);
        assert!(
            parse_model_write(serde_json::json!({
                "base_url": "https://example.test/v1",
                "api_key": huge,
                "model": "example-chat",
                "reasoning": "medium"
            }))
            .is_err()
        );
    }
}
