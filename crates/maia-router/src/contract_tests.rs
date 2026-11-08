//! Loopback test transport contract (not reqwest async proof).
//!
//! Async `RouterHttp::complete` coverage is specified in [`crate::async_integration_handoff`].

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use maia_core::audit::RequestId;
use maia_core::credit::PrefixHash;
use maia_core::router::{
    CanonicalJson, MAX_ROUTER_RESPONSE_BYTES, ReasoningEffort, Router, RouterCapabilities,
    RouterConfig, RouterError, RouterStreamMode, TrailingInstructionPlacement,
    classify_router_failure,
};
use maia_core::thread_cache::{ChatMessage, ChatRole};

use crate::test_loopback_http::write_http_response;
use crate::{RouterAuth, RouterHttp, error_redacts_secret};

fn capabilities() -> RouterCapabilities {
    RouterCapabilities {
        readable_reasoning: true,
        tool_calls: true,
        cached_token_usage: true,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    }
}

fn sample_request(request_id: RequestId) -> maia_core::router::RouterRequest {
    maia_core::router::RouterRequest {
        request_id,
        model: "test-model".to_owned(),
        messages: vec![ChatMessage::text(ChatRole::User, "hello")],
        tools_json: CanonicalJson("[]".to_owned()),
        prefix_hash: PrefixHash::new("prefix"),
        recall_hash: None,
        reasoning_effort: ReasoningEffort::Low,
        max_output_tokens: 16,
        prior_provider_tool_state: None,
    }
}

fn loopback_router(port: u16, stream_mode: RouterStreamMode) -> Result<RouterHttp, RouterError> {
    let config = RouterConfig {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        model: "test-model".to_owned(),
        request_timeout: Duration::from_secs(5),
        stream_mode,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    };
    RouterHttp::new(
        config,
        capabilities(),
        true,
        RouterAuth::bearer("super-secret-key"),
    )
}

fn spawn_loopback_server(serve: impl FnOnce(TcpStream) + Send + 'static) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::spawn(move || {
        ready_tx.send(()).expect("ready");
        let (stream, _) = listener.accept().expect("accept");
        serve(stream);
    });
    ready_rx.recv().expect("server ready");
    port
}

#[test]
fn router_http_complete_json_posts_auth_and_normalizes() {
    let captured = Arc::new(Mutex::new(String::new()));
    let captured_thread = Arc::clone(&captured);
    let port = spawn_loopback_server(move |mut stream| {
        let request = RouterHttp::read_loopback_request(&mut stream).expect("read request");
        captured_thread.lock().expect("lock").push_str(&request);
        let lowered = request.to_ascii_lowercase();
        assert!(lowered.contains("authorization: bearer super-secret-key"));
        assert!(request.contains("hello"));
        let body = r#"{"id":"resp","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"pong"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#;
        write_http_response(&mut stream, "200 OK", body.as_bytes()).expect("write");
    });
    let router = loopback_router(port, RouterStreamMode::Json).expect("router");
    let response = router
        .complete_via_loopback_test_transport(&sample_request(RequestId(1)))
        .expect("complete");
    assert_eq!(response.reply.as_deref(), Some("pong"));
}

#[test]
fn router_http_complete_sse_normalizes_stream() {
    let port = spawn_loopback_server(move |mut stream| {
        let _request = RouterHttp::read_loopback_request(&mut stream).expect("read request");
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        write_http_response(&mut stream, "200 OK", body.as_bytes()).expect("write");
    });
    let router = loopback_router(port, RouterStreamMode::ServerSentEvents).expect("router");
    let response = router
        .complete_via_loopback_test_transport(&sample_request(RequestId(2)))
        .expect("complete");
    assert_eq!(response.reply.as_deref(), Some("hi"));
}

#[test]
fn provider_502_keeps_the_status_code_and_drops_the_body() {
    let secret = "sk-SECRET-status";
    let port = spawn_loopback_server(move |mut stream| {
        let _request = RouterHttp::read_loopback_request(&mut stream).expect("read request");
        let body = format!(r#"{{"error":"{secret}"}}"#);
        write_http_response(&mut stream, "502 Bad Gateway", body.as_bytes()).expect("write");
    });
    let router = loopback_router(port, RouterStreamMode::Json).expect("router");
    let error = router
        .complete_via_loopback_test_transport(&sample_request(RequestId(13)))
        .expect_err("502");
    assert_eq!(classify_router_failure(&error).status_code(), Some(502));
    assert_eq!(
        classify_router_failure(&error).redacted_log(),
        "router_failure category=status code=502"
    );
    assert!(error_redacts_secret(&error, secret));
}

#[test]
fn provider_5xx_is_server_and_drops_the_body() {
    let secret = "sk-SECRET-upstream";
    let port = spawn_loopback_server(move |mut stream| {
        let _request = RouterHttp::read_loopback_request(&mut stream).expect("read request");
        let body = format!(r#"{{"error":"{secret}"}}"#);
        write_http_response(&mut stream, "500 Internal Server Error", body.as_bytes())
            .expect("write");
    });
    let router = loopback_router(port, RouterStreamMode::Json).expect("router");
    let error = router
        .complete_via_loopback_test_transport(&sample_request(RequestId(11)))
        .expect_err("5xx");
    assert!(matches!(error, RouterError::Server { code: 500 }));
    assert!(error_redacts_secret(&error, secret));
    assert_eq!(
        classify_router_failure(&error).redacted_log(),
        "router_failure category=status code=500"
    );
}

#[test]
fn router_http_complete_maps_auth_failure_without_leaking_secret() {
    let port = spawn_loopback_server(move |mut stream| {
        let _request = RouterHttp::read_loopback_request(&mut stream).expect("read request");
        write_http_response(&mut stream, "401 Unauthorized", b"invalid key").expect("write");
    });
    let router = loopback_router(port, RouterStreamMode::Json).expect("router");
    let secret = "super-secret-key";
    let error = router
        .complete_via_loopback_test_transport(&sample_request(RequestId(3)))
        .expect_err("401");
    assert!(matches!(error, RouterError::Authentication));
    assert!(error_redacts_secret(&error, secret));
}

#[test]
fn router_http_complete_rejects_redirects() {
    let port = spawn_loopback_server(move |mut stream| {
        let _request = RouterHttp::read_loopback_request(&mut stream).expect("read request");
        write_http_response(&mut stream, "302 Found", b"").expect("write");
    });
    let router = loopback_router(port, RouterStreamMode::Json).expect("router");
    let error = router
        .complete_via_loopback_test_transport(&sample_request(RequestId(4)))
        .expect_err("redirect");
    assert!(matches!(
        error,
        RouterError::Protocol { detail } if detail.contains("redirect")
    ));
}

#[test]
fn router_http_test_transport_rejects_oversize_response_body() {
    let oversize = MAX_ROUTER_RESPONSE_BYTES + 1;
    let port = spawn_loopback_server(move |mut stream| {
        let _request = RouterHttp::read_loopback_request(&mut stream).expect("read request");
        let body = vec![b'x'; oversize];
        write_http_response(&mut stream, "200 OK", &body).expect("write");
    });
    let router = loopback_router(port, RouterStreamMode::Json).expect("router");
    let error = router
        .complete_via_loopback_test_transport(&sample_request(RequestId(6)))
        .expect_err("oversize");
    assert!(matches!(
        error,
        RouterError::ResourceLimit {
            field: "response_body"
        }
    ));
}

#[test]
fn router_http_complete_cancels_mid_sse_stream() {
    let port = spawn_loopback_server(move |mut stream| {
        let _request = RouterHttp::read_loopback_request(&mut stream).expect("read request");
        let first = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
        let tail = concat!(
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let body_len = first.len() + tail.len();
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {body_len}\r\n\r\n"
        );
        stream.write_all(headers.as_bytes()).expect("headers");
        stream.write_all(first.as_bytes()).expect("first");
        thread::sleep(Duration::from_millis(150));
        stream.write_all(tail.as_bytes()).expect("tail");
    });
    let router =
        Arc::new(loopback_router(port, RouterStreamMode::ServerSentEvents).expect("router"));
    let request = sample_request(RequestId(5));
    let router_cancel = Arc::clone(&router);
    let cancel_id = request.request_id;
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(30));
        router_cancel.cancel_sync(cancel_id).expect("cancel");
    });
    let error = router
        .complete_via_loopback_test_transport(&request)
        .expect_err("cancelled");
    assert!(matches!(error, RouterError::Cancelled));
}

#[test]
fn chat_completion_lists_models_and_retries_when_the_provider_is_down() {
    let paths = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&paths);
    let port = spawn_provider(move |request| {
        let path = request_target(&request);
        recorded.lock().expect("paths").push(path.clone());
        if path.contains("/models") {
            return provider_response("200 OK", r#"{"data":[{"id":"auto"}]}"#);
        }
        let chats = recorded
            .lock()
            .expect("paths")
            .iter()
            .filter(|path| path.contains("/chat/completions"))
            .count();
        if chats == 1 {
            provider_response("503 Service Unavailable", r#"{"error":"down"}"#)
        } else {
            provider_response(
                "200 OK",
                r#"{"id":"resp","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"pong"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#,
            )
        }
    });
    let router = loopback_router(port, RouterStreamMode::Json).expect("router");
    let response = runtime_complete(&router, &sample_request(RequestId(21)));
    assert_eq!(
        response.expect("retried completion").reply.as_deref(),
        Some("pong")
    );
    assert_eq!(
        paths.lock().expect("paths").as_slice(),
        [
            "/v1/chat/completions".to_owned(),
            "/v1/models".to_owned(),
            "/v1/chat/completions".to_owned(),
        ]
    );
}

#[test]
fn authentication_failure_does_not_list_models() {
    let paths = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&paths);
    let port = spawn_provider(move |request| {
        recorded
            .lock()
            .expect("paths")
            .push(request_target(&request));
        provider_response("401 Unauthorized", "invalid key")
    });
    let router = loopback_router(port, RouterStreamMode::Json).expect("router");
    let error = runtime_complete(&router, &sample_request(RequestId(22))).expect_err("401");
    assert!(matches!(error, RouterError::Authentication));
    assert_eq!(
        paths.lock().expect("paths").as_slice(),
        ["/v1/chat/completions".to_owned()]
    );
}

fn runtime_complete(
    router: &RouterHttp,
    request: &maia_core::router::RouterRequest,
) -> Result<maia_core::router::RouterResponse, RouterError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(router.complete(request))
}

fn spawn_provider(respond: impl Fn(String) -> String + Send + 'static) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    listener.set_nonblocking(true).expect("nonblocking");
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::spawn(move || {
        ready_tx.send(()).expect("ready");
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .expect("timeout");
                    let request = read_provider_request(&mut stream);
                    let response = respond(request);
                    let _ = stream.write_all(response.as_bytes());
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });
    ready_rx.recv().expect("server ready");
    port
}

fn read_provider_request(stream: &mut TcpStream) -> String {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
        }
        if buffer.len() > 64 * 1024 {
            break;
        }
    }
    let header = String::from_utf8_lossy(&buffer).to_string();
    let length = header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    let have = header.split("\r\n\r\n").nth(1).map(str::len).unwrap_or(0);
    let mut rest = vec![0u8; length.saturating_sub(have)];
    if !rest.is_empty() {
        let _ = stream.read_exact(&mut rest);
    }
    header
}

fn request_target(request: &str) -> String {
    request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("")
        .to_owned()
}

fn provider_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn loopback_contracts_stable_under_default_parallelism() {
    std::thread::scope(|scope| {
        for id in 0u64..8 {
            scope.spawn(move || {
                let port = spawn_loopback_server(move |mut stream| {
                    let _request =
                        RouterHttp::read_loopback_request(&mut stream).expect("read request");
                    let body = r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]}"#;
                    write_http_response(&mut stream, "200 OK", body.as_bytes()).expect("write");
                });
                let router = loopback_router(port, RouterStreamMode::Json).expect("router");
                let response = router
                    .complete_via_loopback_test_transport(&sample_request(RequestId(id)))
                    .expect("complete");
                assert_eq!(response.reply.as_deref(), Some("ok"));
            });
        }
    });
}
