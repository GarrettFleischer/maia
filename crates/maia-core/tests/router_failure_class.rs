//! Secret-safe router failure classes. These tests do not perform network I/O.

use maia_core::router::{
    RouterConfigError, RouterError, RouterFailureClass, classify_router_failure,
};

#[test]
fn unexpected_http_status_is_a_numeric_class() {
    let class = classify_router_failure(&RouterError::Protocol {
        detail: "unexpected status 400".to_owned(),
    });
    assert_eq!(
        class.redacted_log(),
        "router_failure category=status code=400"
    );
    assert_eq!(class.status_code(), Some(400));
}

#[test]
fn status_text_with_a_suffix_is_not_parsed() {
    let class = classify_router_failure(&RouterError::Protocol {
        detail: "unexpected status 400 https://provider.example/v1".to_owned(),
    });
    assert_eq!(class.redacted_log(), "router_failure category=unclassified");
    assert_eq!(class.status_code(), None);
}

#[test]
fn failure_log_redacts_url_header_model_and_body() {
    let secret = "sk-SECRET";
    let error = RouterError::Protocol {
        detail: format!(
            "Bearer {secret} https://provider.example/v1 model-secret {{\"error\":\"upstream-body\"}}"
        ),
    };
    let line = classify_router_failure(&error).redacted_log();
    assert!(!line.contains(secret));
    assert!(!line.contains("https://"));
    assert!(!line.contains("provider.example"));
    assert!(!line.contains("model-secret"));
    assert!(!line.contains("upstream-body"));
    assert!(!line.contains("Bearer"));
    assert_eq!(line, "router_failure category=unclassified");
}

#[test]
fn transport_json_schema_status_and_empty_reply_are_distinct() {
    assert_eq!(
        classify_router_failure(&RouterError::Timeout).redacted_log(),
        "router_failure category=transport kind=timeout"
    );
    assert_eq!(
        classify_router_failure(&RouterError::Protocol {
            detail: "transport failure".to_owned(),
        })
        .redacted_log(),
        "router_failure category=transport kind=transport"
    );
    assert_eq!(
        classify_router_failure(&RouterError::Protocol {
            detail: "redirects are disabled".to_owned(),
        })
        .redacted_log(),
        "router_failure category=transport kind=redirect"
    );
    assert_eq!(
        classify_router_failure(&RouterError::Protocol {
            detail: "invalid utf-8 in json body".to_owned(),
        })
        .redacted_log(),
        "router_failure category=json"
    );
    assert_eq!(
        classify_router_failure(&RouterError::Protocol {
            detail: "body must be a JSON object".to_owned(),
        })
        .redacted_log(),
        "router_failure category=json"
    );
    assert_eq!(
        classify_router_failure(&RouterError::Protocol {
            detail: "missing choices".to_owned(),
        })
        .redacted_log(),
        "router_failure category=schema"
    );
    assert_eq!(
        classify_router_failure(&RouterError::Protocol {
            detail: "missing message".to_owned(),
        })
        .redacted_log(),
        "router_failure category=schema"
    );
    assert_eq!(
        classify_router_failure(&RouterError::Authentication).redacted_log(),
        "router_failure category=status family=authentication"
    );
    assert_eq!(
        classify_router_failure(&RouterError::RateLimited).redacted_log(),
        "router_failure category=status family=rate_limited"
    );
    assert_eq!(
        classify_router_failure(&RouterError::Server { code: 500 }).redacted_log(),
        "router_failure category=status code=500"
    );
    assert_eq!(
        classify_router_failure(&RouterError::ResourceLimit {
            field: "response_body",
        })
        .redacted_log(),
        "router_failure category=unclassified kind=resource_limit"
    );
    assert_eq!(
        classify_router_failure(&RouterError::Configuration(
            RouterConfigError::InvalidBaseUrl
        ))
        .redacted_log(),
        "router_failure category=unclassified kind=configuration"
    );
    let empty = RouterFailureClass::empty_reply().redacted_log();
    assert_eq!(empty, "router_failure category=empty_reply");
    assert!(!empty.contains("response_body"));
}
