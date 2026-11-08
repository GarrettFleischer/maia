//! Router validation and protocol errors.

/// Why a router configuration is rejected before any network I/O.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouterConfigError {
    /// Base URL is missing or not a URL.
    InvalidBaseUrl,
    /// Non-loopback HTTP is forbidden.
    InsecureBaseUrl,
    /// Timeout must be positive.
    InvalidTimeout,
}

/// Errors surfaced by router normalization and adapter boundaries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouterError {
    /// Static configuration rejected before start.
    Configuration(RouterConfigError),
    /// HTTP 401 or 403 from the provider.
    Authentication,
    /// HTTP 429 from the provider.
    RateLimited,
    /// HTTP 5xx before a usable body. `code` is the numeric status only.
    Server {
        /// HTTP status in `500..=599`.
        code: u16,
    },
    /// Request timed out or disconnected.
    Timeout,
    /// Malformed provider JSON, SSE, or tool schema.
    Protocol {
        /// Redacted summary safe for logs.
        detail: String,
    },
    /// Stream ended before tool arguments were complete.
    IncompleteStream,
    /// Provider outcome unknown for the same request id.
    OutcomeUnknown,
    /// In-flight request was cancelled.
    Cancelled,
    /// Parser or stream accumulation exceeded an explicit budget.
    ResourceLimit {
        /// Which accumulator tripped the budget.
        field: &'static str,
    },
}

/// Closed category for one router failure. The log line never copies free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouterFailureClass {
    category: FailureCategory,
    status_code: Option<u16>,
    kind: Option<FailureKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureCategory {
    Transport,
    Status,
    Json,
    Schema,
    EmptyReply,
    Unclassified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    Timeout,
    Transport,
    Redirect,
    Authentication,
    RateLimited,
    Server,
    ResourceLimit,
    Configuration,
}

impl RouterFailureClass {
    /// A normalized body had no assistant text.
    pub fn empty_reply() -> Self {
        Self {
            category: FailureCategory::EmptyReply,
            status_code: None,
            kind: None,
        }
    }

    /// A reply was present and was not the route schema.
    pub fn schema() -> Self {
        Self {
            category: FailureCategory::Schema,
            status_code: None,
            kind: None,
        }
    }

    /// HTTP status when this class came from a numeric status line.
    pub fn status_code(self) -> Option<u16> {
        self.status_code
    }

    /// One stable line. Tokens are fixed; the only integer is an HTTP status.
    pub fn redacted_log(self) -> String {
        match (self.category, self.status_code, self.kind) {
            (FailureCategory::Status, Some(code), _) => {
                format!("router_failure category=status code={code}")
            }
            (FailureCategory::Status, None, Some(FailureKind::Authentication)) => {
                "router_failure category=status family=authentication".to_owned()
            }
            (FailureCategory::Status, None, Some(FailureKind::RateLimited)) => {
                "router_failure category=status family=rate_limited".to_owned()
            }
            (FailureCategory::Status, None, Some(FailureKind::Server)) => {
                "router_failure category=status family=server".to_owned()
            }
            (FailureCategory::Transport, _, Some(FailureKind::Timeout)) => {
                "router_failure category=transport kind=timeout".to_owned()
            }
            (FailureCategory::Transport, _, Some(FailureKind::Redirect)) => {
                "router_failure category=transport kind=redirect".to_owned()
            }
            (FailureCategory::Transport, _, _) => {
                "router_failure category=transport kind=transport".to_owned()
            }
            (FailureCategory::Json, _, _) => "router_failure category=json".to_owned(),
            (FailureCategory::Schema, _, _) => "router_failure category=schema".to_owned(),
            (FailureCategory::EmptyReply, _, _) => "router_failure category=empty_reply".to_owned(),
            (FailureCategory::Unclassified, _, Some(FailureKind::ResourceLimit)) => {
                "router_failure category=unclassified kind=resource_limit".to_owned()
            }
            (FailureCategory::Unclassified, _, Some(FailureKind::Configuration)) => {
                "router_failure category=unclassified kind=configuration".to_owned()
            }
            (FailureCategory::Unclassified, _, _) => {
                "router_failure category=unclassified".to_owned()
            }
            (FailureCategory::Status, None, _) => "router_failure category=status".to_owned(),
        }
    }
}

/// Classifies a router error without copying its detail text.
pub fn classify_router_failure(error: &RouterError) -> RouterFailureClass {
    match error {
        RouterError::Timeout => transport(FailureKind::Timeout),
        RouterError::Authentication => status_family(FailureKind::Authentication),
        RouterError::RateLimited => status_family(FailureKind::RateLimited),
        RouterError::Server { code } => RouterFailureClass {
            category: FailureCategory::Status,
            status_code: Some(*code),
            kind: Some(FailureKind::Server),
        },
        RouterError::ResourceLimit { .. } => unclassified(Some(FailureKind::ResourceLimit)),
        RouterError::Configuration(_) => unclassified(Some(FailureKind::Configuration)),
        RouterError::Protocol { detail } => classify_protocol(detail),
        RouterError::IncompleteStream | RouterError::OutcomeUnknown | RouterError::Cancelled => {
            unclassified(None)
        }
    }
}

fn classify_protocol(detail: &str) -> RouterFailureClass {
    if let Some(code) = exact_unexpected_status(detail) {
        return RouterFailureClass {
            category: FailureCategory::Status,
            status_code: Some(code),
            kind: None,
        };
    }
    match detail {
        "transport failure" | "router stopped" => transport(FailureKind::Transport),
        "redirects are disabled" => transport(FailureKind::Redirect),
        "invalid utf-8 in json body"
        | "invalid utf-8 in sse chunk"
        | "body must be a JSON object"
        | "failed to encode request"
        | "tools_json must be valid JSON" => json_class(),
        "missing choices"
        | "missing choices array"
        | "missing choice object"
        | "unterminated choice object"
        | "missing message"
        | "missing message object"
        | "unterminated object"
        | "missing object"
        | "missing tool_calls array"
        | "unterminated tool_calls array"
        | "tool call missing id"
        | "tool call missing function"
        | "tool call missing name"
        | "tool call missing arguments"
        | "tool arguments must be valid JSON object"
        | "tool arguments must be a JSON object"
        | "tool calls unsupported for this provider"
        | "tools_json must be an array"
        | "tools_json missing function names"
        | "duplicate tool call id"
        | "unknown tool name" => RouterFailureClass::schema(),
        _ => unclassified(None),
    }
}

fn exact_unexpected_status(detail: &str) -> Option<u16> {
    let rest = detail.strip_prefix("unexpected status ")?;
    if rest.len() == 3 && rest.bytes().all(|byte| byte.is_ascii_digit()) {
        rest.parse().ok()
    } else {
        None
    }
}

fn transport(kind: FailureKind) -> RouterFailureClass {
    RouterFailureClass {
        category: FailureCategory::Transport,
        status_code: None,
        kind: Some(kind),
    }
}

fn status_family(kind: FailureKind) -> RouterFailureClass {
    RouterFailureClass {
        category: FailureCategory::Status,
        status_code: None,
        kind: Some(kind),
    }
}

fn json_class() -> RouterFailureClass {
    RouterFailureClass {
        category: FailureCategory::Json,
        status_code: None,
        kind: None,
    }
}

fn unclassified(kind: Option<FailureKind>) -> RouterFailureClass {
    RouterFailureClass {
        category: FailureCategory::Unclassified,
        status_code: None,
        kind,
    }
}
