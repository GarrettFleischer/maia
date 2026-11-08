//! Provider environment and model discovery contracts.
//!
//! Fixtures are written in this file. These tests do not read process
//! environment variables.

use maia_core::router::RouterConfigError;
use maia_daemon::{
    DiscoveryError, EnvError, ModelEnv, ProviderApiKey, read_model_env, select_model_id,
};
use maia_router::{chat_completions_url, models_url};

const FIXED_ENV_ERROR: &str = "Model provider is not configured.";

#[test]
fn missing_key_fails_closed_without_echoing_values() {
    let error =
        read_model_env(&[("BASE_URL", "https://example.test/v1")]).expect_err("missing key");
    let rendered = format!("{error}");
    assert!(matches!(error, EnvError::MissingApiKey));
    assert!(!rendered.contains("example.test"));
    assert!(!rendered.to_lowercase().contains("key"));
}

#[test]
fn missing_or_blank_provider_env_uses_one_fixed_sentence() {
    let cases = [
        (Vec::new(), EnvError::MissingBaseUrl),
        (
            vec![("API_KEY", "fixture-secret")],
            EnvError::MissingBaseUrl,
        ),
        (
            vec![("BASE_URL", "https://example.test/v1")],
            EnvError::MissingApiKey,
        ),
        (
            vec![("BASE_URL", "   "), ("API_KEY", "fixture-secret")],
            EnvError::MissingBaseUrl,
        ),
        (
            vec![("BASE_URL", "https://example.test/v1"), ("API_KEY", " \t")],
            EnvError::MissingApiKey,
        ),
        (
            vec![("BASE_URL", ""), ("API_KEY", "")],
            EnvError::MissingBaseUrl,
        ),
        (
            vec![
                (" BASE_URL", "https://example.test/v1"),
                ("API_KEY", "fixture-secret"),
            ],
            EnvError::MissingBaseUrl,
        ),
    ];
    for (vars, expected) in cases {
        let error = read_model_env(&vars).expect_err("closed");
        assert_eq!(error, expected);
        let rendered = format!("{error}");
        let debug = format!("{error:?}");
        assert_eq!(rendered, FIXED_ENV_ERROR);
        assert!(!rendered.contains("BASE_URL"));
        assert!(!rendered.contains("API_KEY"));
        assert!(!rendered.contains("example.test"));
        assert!(!rendered.contains("fixture-secret"));
        assert!(!debug.contains("example.test"));
        assert!(!debug.contains("fixture-secret"));
    }
}

#[test]
fn duplicate_provider_names_are_rejected() {
    let cases = [
        vec![
            ("BASE_URL", "https://one.test/v1"),
            ("BASE_URL", "https://two.test/v1"),
            ("API_KEY", "fixture-secret"),
        ],
        vec![
            ("BASE_URL", "https://example.test/v1"),
            ("API_KEY", "fixture-secret"),
            ("API_KEY", "other-secret"),
        ],
        vec![
            ("API_KEY", "fixture-secret"),
            ("API_KEY", "fixture-secret"),
            ("BASE_URL", "https://example.test/v1"),
        ],
        vec![
            ("BASE_URL", " "),
            ("BASE_URL", "https://example.test/v1"),
            ("API_KEY", "fixture-secret"),
        ],
    ];
    for vars in cases {
        let error = read_model_env(&vars).expect_err("duplicate");
        assert_eq!(error, EnvError::DuplicateEntry);
        let rendered = format!("{error}");
        let debug = format!("{error:?}");
        assert_eq!(rendered, FIXED_ENV_ERROR);
        assert!(!rendered.contains("one.test"));
        assert!(!rendered.contains("two.test"));
        assert!(!rendered.contains("example.test"));
        assert!(!rendered.contains("fixture-secret"));
        assert!(!rendered.contains("other-secret"));
        assert!(!rendered.contains("BASE_URL"));
        assert!(!rendered.contains("API_KEY"));
        assert!(!debug.contains("fixture-secret"));
        assert!(!debug.contains("other-secret"));
        assert!(!debug.contains("example.test"));
    }
}

#[test]
fn provider_env_trims_and_redacts_debug() {
    let env = read_model_env(&[
        ("OTHER", "ignore-me"),
        ("OTHER", "still-ignored"),
        ("API_KEY", "  fixture-secret  "),
        ("BASE_URL", "  https://example.test/v1/  "),
    ])
    .expect("env");
    assert_eq!(env.base_url(), "https://example.test/v1/");
    assert_eq!(env.api_key().as_str(), "fixture-secret");
    assert_eq!(format!("{env:?}"), "ModelEnv([redacted])");
    assert_eq!(format!("{:?}", env.api_key()), "ProviderApiKey([redacted])");
    assert!(!format!("{env:?}").contains("example.test"));
    assert!(!format!("{env:?}").contains("fixture-secret"));
    assert!(!format!("{:?}", env.api_key()).contains("fixture-secret"));
    let _typed_env: ModelEnv = env;
    let _typed_key: &ProviderApiKey = _typed_env.api_key();
}

#[test]
fn select_model_id_sorts_and_does_not_prefer_a_vendor() {
    let id = select_model_id(&["zeta".into(), "alpha".into()]).expect("id");
    assert_eq!(id, "alpha");
    let error = select_model_id(&[]).expect_err("empty");
    assert_eq!(error, DiscoveryError::NoModels);
}

#[test]
fn select_model_id_is_lexicographic_and_does_not_mutate() {
    let mut ids = vec![
        "gpt-4o".to_owned(),
        "claude-3".to_owned(),
        "llama".to_owned(),
        "Alpha".to_owned(),
    ];
    let snapshot = ids.clone();
    let id = select_model_id(&ids).expect("id");
    assert_eq!(id, "Alpha");
    assert_eq!(ids, snapshot);
    ids.push("aaa".to_owned());
    assert_eq!(select_model_id(&ids).expect("id"), "Alpha");
    assert_eq!(
        select_model_id(&["model-2".into(), "model-10".into()]).expect("id"),
        "model-10"
    );
    assert_eq!(
        select_model_id(&["b".into(), "a".into(), "b".into()]).expect("id"),
        "a"
    );
}

#[test]
fn select_model_id_rejects_blank_ids() {
    let cases = [
        vec![String::new()],
        vec![" ".to_owned()],
        vec!["\t".to_owned()],
        vec!["alpha".to_owned(), " ".to_owned()],
        vec!["  ".to_owned(), "zeta".to_owned()],
    ];
    for ids in cases {
        let snapshot = ids.clone();
        let error = select_model_id(&ids).expect_err("blank");
        assert_eq!(error, DiscoveryError::BlankModelId);
        assert_eq!(ids, snapshot);
        let rendered = format!("{error}");
        assert!(!rendered.contains("alpha"));
        assert!(!rendered.contains("zeta"));
    }
}

#[test]
fn models_url_matches_chat_completions_normalization() {
    let bases = [
        "https://example.test/v1",
        "https://example.test/v1/",
        "https://example.test/v1///",
        "  https://example.test/v1/  ",
        "https://api.example.com/v1/extra",
        "HTTPS://api.example.com/v1",
        "http://127.0.0.1:8080/v1",
        "http://127.0.0.1:8080/v1/",
        "http://localhost:8080/v1",
        "http://[::1]:8080/v1",
        "http://127.1:8080/v1",
        "http://0x7f000001:8080/v1",
        "HTTP://127.0.0.1/v1",
    ];
    for base in bases {
        let models = models_url(base).expect("models");
        let completions = chat_completions_url(base).expect("completions");
        let prefix = completions
            .strip_suffix("/chat/completions")
            .expect("suffix");
        assert_eq!(models, format!("{prefix}/models"));
        assert!(!models.contains('?'));
        assert!(!models.contains('#'));
        assert!(!models.contains('@'));
    }
}

#[test]
fn models_url_rejects_userinfo_query_fragment_and_unsupported_bases() {
    let invalid = [
        "",
        "   ",
        "///",
        "https://user:super-secret@example.com/v1",
        "http://user:pass@127.0.0.1:8080/v1",
        "https://example.com/v1?token=super-secret",
        "https://example.com/v1#fragment",
        "https://example.com/v1/?token=super-secret",
    ];
    for base in invalid {
        let error = models_url(base).expect_err("invalid");
        assert_eq!(error, RouterConfigError::InvalidBaseUrl);
        let debug = format!("{error:?}");
        assert!(!debug.contains("super-secret"));
        assert!(!debug.contains("pass"));
        assert!(!debug.contains("example.com"));
        assert!(!debug.contains("token"));
    }
    let insecure = [
        "http://example.com/v1",
        "http://127.0.0.1.evil.com/v1",
        "http://localhost.attacker/v1",
        "ftp://example.com/v1",
        "ws://example.com/v1",
        "not a url",
    ];
    for base in insecure {
        let error = models_url(base).expect_err("insecure");
        assert_eq!(error, RouterConfigError::InsecureBaseUrl);
        let debug = format!("{error:?}");
        assert!(!debug.contains("example.com"));
        assert!(!debug.contains("evil"));
        assert!(!debug.contains("attacker"));
    }
}
