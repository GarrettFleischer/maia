//! OpenAI-compatible HTTP router adapter.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::{Either, select};
use futures_util::pin_mut;
use maia_core::audit::RequestId;
use maia_core::router::{
    BoundedResponseCollector, CancelRegistry, MAX_ROUTER_RESPONSE_BYTES, RequestCancelGuard,
    ResponseByteBudget, Router, RouterCapabilities, RouterConfig, RouterError, RouterRequest,
    RouterResponse, RouterSseAssembler, RouterStreamMode, ensure_within_limit,
    normalize_and_validate_json, validate_router_config,
};
use maia_core::thread_cache::ChatRole;
use reqwest::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};

use crate::client::{
    build_router_client_with_loopback, chat_completions_url, map_http_status, map_transport_error,
    models_url,
};

/// Injected authentication material for one router adapter instance.
#[derive(Clone)]
pub struct RouterAuth {
    header_name: String,
    header_value: String,
}

impl RouterAuth {
    /// Builds one auth header injected by the composition root.
    pub fn bearer(api_key: impl Into<String>) -> Self {
        let key = api_key.into();
        Self {
            header_name: AUTHORIZATION.as_str().to_owned(),
            header_value: format!("Bearer {key}"),
        }
    }

    /// Builds a custom header name and value pair.
    pub fn header(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            header_name: name.into(),
            header_value: value.into(),
        }
    }

    fn apply(&self, headers: &mut HeaderMap) -> Result<(), RouterError> {
        let name =
            reqwest::header::HeaderName::from_bytes(self.header_name.as_bytes()).map_err(|_| {
                RouterError::Configuration(maia_core::router::RouterConfigError::InvalidBaseUrl)
            })?;
        let value =
            HeaderValue::from_str(&self.header_value).map_err(|_| RouterError::Protocol {
                detail: "invalid auth header value".to_owned(),
            })?;
        headers.insert(name, value);
        Ok(())
    }
}

fn outbound_message(message: &maia_core::thread_cache::ChatMessage) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    object.insert(
        "role".to_owned(),
        serde_json::Value::String(role_as_str(message.role).to_owned()),
    );
    if let Some(png) = &message.image_png_base64 {
        object.insert(
            "content".to_owned(),
            serde_json::json!([
                {"type": "text", "text": message.content},
                {"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{png}")}}
            ]),
        );
    } else {
        object.insert(
            "content".to_owned(),
            serde_json::Value::String(message.content.clone()),
        );
    }
    if let Some(id) = &message.tool_call_id {
        object.insert("tool_call_id".to_owned(), serde_json::json!(id));
    }
    if let Some(calls) = &message.tool_calls_json
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(calls)
    {
        object.insert("tool_calls".to_owned(), value);
    }
    serde_json::Value::Object(object)
}

fn tool_choice_for(tools: &serde_json::Value) -> Option<&'static str> {
    tools
        .as_array()
        .is_some_and(|items| !items.is_empty())
        .then_some("auto")
}

/// HTTP adapter implementing [`Router`].
pub struct RouterHttp {
    config: RouterConfig,
    capabilities: RouterCapabilities,
    #[allow(dead_code)]
    allow_loopback_http: bool,
    client: Client,
    auth: RouterAuth,
    completions_url: String,
    cancellations: Arc<CancelRegistry>,
}

impl RouterHttp {
    /// Opens a router adapter with validated configuration and injected auth.
    pub fn new(
        config: RouterConfig,
        capabilities: RouterCapabilities,
        allow_loopback_http: bool,
        auth: RouterAuth,
    ) -> Result<Self, RouterError> {
        validate_router_config(&config, allow_loopback_http).map_err(RouterError::Configuration)?;
        let client = build_router_client_with_loopback(&config, allow_loopback_http)?;
        let completions_url =
            chat_completions_url(&config.base_url).map_err(RouterError::Configuration)?;
        Ok(Self {
            config,
            capabilities,
            allow_loopback_http,
            client,
            auth,
            completions_url,
            cancellations: Arc::new(CancelRegistry::new()),
        })
    }

    fn build_body(&self, request: &RouterRequest) -> Result<serde_json::Value, RouterError> {
        let tools: serde_json::Value =
            serde_json::from_str(&request.tools_json.0).map_err(|_| RouterError::Protocol {
                detail: "tools_json must be valid JSON".to_owned(),
            })?;
        let mut body = serde_json::json!({
            "model": request.model,
            "messages": request.messages.iter().map(outbound_message).collect::<Vec<_>>(),
            "tools": tools,
            "max_tokens": request.max_output_tokens,
            "stream": matches!(self.config.stream_mode, RouterStreamMode::ServerSentEvents),
        });
        if let Some(choice) = tool_choice_for(body.get("tools").unwrap_or(&serde_json::Value::Null))
        {
            body["tool_choice"] = serde_json::json!(choice);
        }
        Ok(body)
    }

    fn request_headers(&self) -> Result<HeaderMap, RouterError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        self.auth.apply(&mut headers)?;
        Ok(headers)
    }

    fn push_sse_lines(
        cancel: &RequestCancelGuard,
        assembler: &mut RouterSseAssembler,
        lines: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Result<(), RouterError> {
        for line in lines {
            if cancel.is_cancelled() {
                return Err(RouterError::Cancelled);
            }
            assembler.push_line(line.as_ref())?;
        }
        Ok(())
    }

    fn finish_sse_assembly(
        cancel: &RequestCancelGuard,
        request: &RouterRequest,
        assembler: RouterSseAssembler,
    ) -> Result<RouterResponse, RouterError> {
        if cancel.is_cancelled() {
            return Err(RouterError::Cancelled);
        }
        let normalized = assembler.finish()?;
        maia_core::router::validate_tool_calls(&request.tools_json.0, &normalized.tool_calls)?;
        Ok(normalized)
    }

    fn reject_non_success_status(status: reqwest::StatusCode) -> Result<(), RouterError> {
        if status.is_redirection() {
            return Err(RouterError::Protocol {
                detail: "redirects are disabled".to_owned(),
            });
        }
        if let Some(error) = map_http_status(status) {
            return Err(error);
        }
        if !status.is_success() {
            return Err(RouterError::Protocol {
                detail: format!("unexpected status {}", status.as_u16()),
            });
        }
        Ok(())
    }

    async fn complete_once(&self, request: &RouterRequest) -> Result<RouterResponse, RouterError> {
        let cancel = self.cancellations.begin_active(request.request_id)?;
        let body = self.build_body(request)?;
        let headers = self.request_headers()?;
        let send = self
            .client
            .post(&self.completions_url)
            .headers(headers)
            .json(&body)
            .send();
        pin_mut!(send);
        let cancel_wait = cancel.wait_for();
        pin_mut!(cancel_wait);
        let response = match select(cancel_wait, send).await {
            Either::Left(((), _)) => return Err(RouterError::Cancelled),
            Either::Right((Ok(response), _)) => response,
            Either::Right((Err(error), _)) => return Err(map_transport_error(error)),
        };
        let status = response.status();
        Self::reject_non_success_status(status)?;
        match self.config.stream_mode {
            RouterStreamMode::Json => {
                let mut collector = BoundedResponseCollector::new();
                let mut stream = response.bytes_stream();
                loop {
                    let next = stream.next();
                    pin_mut!(next);
                    let cancel_wait = cancel.wait_for();
                    pin_mut!(cancel_wait);
                    match select(cancel_wait, next).await {
                        Either::Left(((), _)) => return Err(RouterError::Cancelled),
                        Either::Right((None, _)) => break,
                        Either::Right((Some(Ok(chunk)), _)) => {
                            collector.push_chunk(&chunk)?;
                        }
                        Either::Right((Some(Err(error)), _)) => {
                            return Err(map_transport_error(error));
                        }
                    }
                }
                self.normalize_json_body(request, &collector.into_bytes())
            }
            RouterStreamMode::ServerSentEvents => {
                let mut assembler =
                    RouterSseAssembler::new(request.request_id, self.capabilities.clone());
                let mut budget = ResponseByteBudget::new();
                let mut stream = response.bytes_stream();
                loop {
                    let next = stream.next();
                    pin_mut!(next);
                    let cancel_wait = cancel.wait_for();
                    pin_mut!(cancel_wait);
                    match select(cancel_wait, next).await {
                        Either::Left(((), _)) => return Err(RouterError::Cancelled),
                        Either::Right((None, _)) => break,
                        Either::Right((Some(Ok(chunk)), _)) => {
                            budget.account(chunk.len())?;
                            let text =
                                std::str::from_utf8(&chunk).map_err(|_| RouterError::Protocol {
                                    detail: "invalid utf-8 in sse chunk".to_owned(),
                                })?;
                            Self::push_sse_lines(
                                &cancel,
                                &mut assembler,
                                text.split_inclusive('\n'),
                            )?;
                        }
                        Either::Right((Some(Err(error)), _)) => {
                            return Err(map_transport_error(error));
                        }
                    }
                }
                Self::finish_sse_assembly(&cancel, request, assembler)
            }
        }
    }

    /// Asks the provider for its model list. A restarted local router often
    /// answers chat only after this request, which is what Test connection sends.
    async fn probe_models(&self) -> Result<(), RouterError> {
        let url = models_url(&self.config.base_url).map_err(RouterError::Configuration)?;
        let headers = self.request_headers()?;
        let response = self
            .client
            .get(url)
            .headers(headers)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(map_transport_error)?;
        let status = response.status();
        let mut read = 0usize;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(map_transport_error)?;
            read = read.saturating_add(chunk.len());
            if read > 1024 * 1024 {
                break;
            }
        }
        Self::reject_non_success_status(status)
    }

    fn normalize_json_body(
        &self,
        request: &RouterRequest,
        body: &[u8],
    ) -> Result<RouterResponse, RouterError> {
        let text = std::str::from_utf8(body).map_err(|_| RouterError::Protocol {
            detail: "invalid utf-8 in json body".to_owned(),
        })?;
        ensure_within_limit(0, text.len(), MAX_ROUTER_RESPONSE_BYTES, "response_body")?;
        normalize_and_validate_json(
            text,
            request.request_id,
            &self.capabilities,
            &request.tools_json.0,
        )
    }
}

fn recovers_with_models_probe(error: &RouterError) -> bool {
    match error {
        RouterError::Timeout | RouterError::Server { .. } => true,
        RouterError::Protocol { detail } => detail == "transport failure",
        _ => false,
    }
}

impl Router for RouterHttp {
    async fn complete(&self, request: &RouterRequest) -> Result<RouterResponse, RouterError> {
        let first = self.complete_once(request).await;
        if first.as_ref().is_err_and(recovers_with_models_probe) {
            let _ = self.probe_models().await;
            return self.complete_once(request).await;
        }
        first
    }

    async fn cancel(&self, request_id: RequestId) -> Result<(), RouterError> {
        self.cancellations.register_cancel(request_id)
    }
}

fn role_as_str(role: ChatRole) -> &'static str {
    match role {
        ChatRole::System => "system",
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
        ChatRole::Tool => "tool",
    }
}

/// Returns true when an error string does not contain a secret needle.
pub fn error_redacts_secret(error: &RouterError, secret: &str) -> bool {
    let rendered = format!("{error:?}");
    !rendered.contains(secret)
}

#[cfg(test)]
impl RouterHttp {
    /// Test-only loopback transport: shared normalization/status policy, not reqwest async I/O.
    pub fn complete_via_loopback_test_transport(
        &self,
        request: &RouterRequest,
    ) -> Result<RouterResponse, RouterError> {
        use loopback_sync::{post_json_sync, post_json_sync_stream_body};

        let cancel = self.cancellations.begin_active(request.request_id)?;
        let body = self.build_body(request)?;
        let headers = self.request_headers()?;
        let json_body = serde_json::to_string(&body).map_err(|_| RouterError::Protocol {
            detail: "failed to encode request".to_owned(),
        })?;
        match self.config.stream_mode {
            RouterStreamMode::Json => {
                let (status, bytes) = post_json_sync(&self.completions_url, &headers, &json_body)?;
                Self::reject_non_success_status(status)?;
                self.normalize_json_body(request, &bytes)
            }
            RouterStreamMode::ServerSentEvents => {
                let mut assembler =
                    RouterSseAssembler::new(request.request_id, self.capabilities.clone());
                let status = post_json_sync_stream_body(
                    &self.completions_url,
                    &headers,
                    &json_body,
                    |chunk| {
                        let text =
                            std::str::from_utf8(chunk).map_err(|_| RouterError::Protocol {
                                detail: "invalid utf-8 in sse chunk".to_owned(),
                            })?;
                        Self::push_sse_lines(&cancel, &mut assembler, text.split_inclusive('\n'))
                    },
                    || {
                        if cancel.is_cancelled() {
                            Err(RouterError::Cancelled)
                        } else {
                            Ok(())
                        }
                    },
                )?;
                Self::reject_non_success_status(status)?;
                Self::finish_sse_assembly(&cancel, request, assembler)
            }
        }
    }

    /// Registers cancellation without an async runtime (test-only).
    pub fn cancel_sync(&self, request_id: RequestId) -> Result<(), RouterError> {
        self.cancellations.register_cancel(request_id)
    }

    #[doc(hidden)]
    pub fn read_loopback_request(stream: &mut std::net::TcpStream) -> Result<String, RouterError> {
        crate::test_loopback_http::read_framed_http_request(stream)
    }
}

#[cfg(test)]
mod loopback_sync {
    use std::io::Write;
    use std::net::TcpStream;

    use maia_core::router::{MAX_ROUTER_RESPONSE_BYTES, ResponseByteBudget, RouterError};
    use reqwest::StatusCode;
    use reqwest::header::HeaderMap;

    use crate::test_loopback_http::read_framed_http_response;

    pub(super) fn parse_completions_target(
        url: &str,
    ) -> Result<(String, u16, String), RouterError> {
        let trimmed = url.trim();
        let lower = trimmed.to_ascii_lowercase();
        if !lower.starts_with("http://") {
            return Err(RouterError::Protocol {
                detail: "sync transport requires loopback http".to_owned(),
            });
        }
        let scheme_end = trimmed.find("://").expect("checked") + 3;
        let rest = &trimmed[scheme_end..];
        let (authority, path) = rest
            .split_once('/')
            .map(|(auth, tail)| (auth, format!("/{tail}")))
            .unwrap_or((rest, "/".to_owned()));
        if authority.contains('@') {
            return Err(RouterError::Protocol {
                detail: "userinfo not permitted".to_owned(),
            });
        }
        let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
            let end = stripped.find(']').ok_or_else(|| RouterError::Protocol {
                detail: "invalid ipv6 authority".to_owned(),
            })?;
            let host = format!("[{}]", &stripped[..end]);
            let port_part = stripped[end + 1..].strip_prefix(':').unwrap_or("80");
            let port = port_part.parse().map_err(|_| RouterError::Protocol {
                detail: "invalid port".to_owned(),
            })?;
            (host, port)
        } else if let Some((host, port)) = authority.rsplit_once(':') {
            if port.chars().all(|ch| ch.is_ascii_digit()) && !port.is_empty() {
                (
                    host.to_owned(),
                    port.parse().map_err(|_| RouterError::Protocol {
                        detail: "invalid port".to_owned(),
                    })?,
                )
            } else {
                (authority.to_owned(), 80)
            }
        } else {
            (authority.to_owned(), 80)
        };
        Ok((host, port, path))
    }

    fn post_json_and_read_response(
        completions_url: &str,
        headers: &HeaderMap,
        json_body: &str,
    ) -> Result<(StatusCode, Vec<u8>), RouterError> {
        let (host, port, path) = parse_completions_target(completions_url)?;
        let mut header_lines = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Length: {}\r\n",
            json_body.len()
        );
        for (name, value) in headers.iter() {
            let value = value.to_str().map_err(|_| RouterError::Protocol {
                detail: "invalid header value".to_owned(),
            })?;
            header_lines.push_str(&format!("{name}: {value}\r\n"));
        }
        header_lines.push_str("\r\n");
        let mut stream =
            TcpStream::connect(format!("{host}:{port}")).map_err(|_| RouterError::Protocol {
                detail: "transport failure".to_owned(),
            })?;
        stream
            .write_all(header_lines.as_bytes())
            .map_err(|_| RouterError::Protocol {
                detail: "transport failure".to_owned(),
            })?;
        stream
            .write_all(json_body.as_bytes())
            .map_err(|_| RouterError::Protocol {
                detail: "transport failure".to_owned(),
            })?;
        read_framed_http_response(&mut stream, MAX_ROUTER_RESPONSE_BYTES)
    }

    pub(super) fn post_json_sync(
        completions_url: &str,
        headers: &HeaderMap,
        json_body: &str,
    ) -> Result<(StatusCode, Vec<u8>), RouterError> {
        post_json_and_read_response(completions_url, headers, json_body)
    }

    pub(super) fn post_json_sync_stream_body<F, G>(
        completions_url: &str,
        headers: &HeaderMap,
        json_body: &str,
        mut on_body_chunk: F,
        mut between_reads: G,
    ) -> Result<StatusCode, RouterError>
    where
        F: FnMut(&[u8]) -> Result<(), RouterError>,
        G: FnMut() -> Result<(), RouterError>,
    {
        let (status, body) = post_json_and_read_response(completions_url, headers, json_body)?;
        let mut budget = ResponseByteBudget::new();
        let mut offset = 0usize;
        while offset < body.len() {
            between_reads()?;
            let end = (offset + 4096).min(body.len());
            let chunk = &body[offset..end];
            budget.account(chunk.len())?;
            on_body_chunk(chunk)?;
            offset = end;
        }
        Ok(status)
    }
}

#[cfg(test)]
mod tool_choice_tests {
    use super::tool_choice_for;

    #[test]
    fn route_tools_choose_auto_and_an_empty_list_omits_the_choice() {
        assert_eq!(
            tool_choice_for(
                &serde_json::json!([{"type":"function","function":{"name":"spawn_task"}}])
            ),
            Some("auto")
        );
        assert_eq!(tool_choice_for(&serde_json::json!([])), None);
    }
}
