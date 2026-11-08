//! Router adapter contract tests.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use maia_core::audit::RequestId;
use maia_core::router::{
    RouterCapabilities, RouterConfig, RouterError, RouterStreamMode, TrailingInstructionPlacement,
    normalize_router_json,
};
use maia_router::{
    RouterAuth, RouterHttp, build_router_client_with_loopback, chat_completions_url,
    error_redacts_secret,
};

fn capabilities() -> RouterCapabilities {
    RouterCapabilities {
        readable_reasoning: true,
        tool_calls: true,
        cached_token_usage: true,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    }
}

#[test]
fn router_client_disables_redirects() {
    let config = RouterConfig {
        base_url: "https://example.com/v1".to_owned(),
        model: "m".to_owned(),
        request_timeout: Duration::from_secs(5),
        stream_mode: RouterStreamMode::Json,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    };
    build_router_client_with_loopback(&config, false).expect("client builds");
}

#[test]
fn router_http_rejects_insecure_public_base_url() {
    let config = RouterConfig {
        base_url: "http://example.com/v1".to_owned(),
        model: "m".to_owned(),
        request_timeout: Duration::from_secs(5),
        stream_mode: RouterStreamMode::Json,
        trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
    };
    match RouterHttp::new(config, capabilities(), false, RouterAuth::bearer("secret")) {
        Ok(_) => panic!("expected insecure base url rejection"),
        Err(RouterError::Configuration(maia_core::router::RouterConfigError::InsecureBaseUrl)) => {}
        Err(other) => panic!("unexpected error: {other:?}"),
    }
}

#[test]
fn loopback_fixture_posts_exact_messages_and_normalizes_response() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("addr");
    let captured = Arc::new(Mutex::new(String::new()));
    let captured_thread = Arc::clone(&captured);
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buffer = [0u8; 4096];
        let read = stream.read(&mut buffer).expect("read");
        captured_thread
            .lock()
            .expect("lock")
            .push_str(core::str::from_utf8(&buffer[..read]).expect("utf8"));
        let body = r#"{"id":"resp","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"pong"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).expect("write");
    });
    let base = format!("http://127.0.0.1:{}/v1", address.port());
    chat_completions_url(&base).expect("url");
    let posted = r#"{"model":"test-model","messages":[{"role":"user","content":"hello"}],"tools":[],"max_tokens":16,"stream":false}"#;
    let path = "/v1/chat/completions";
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer super-secret-key\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{posted}",
        address.port(),
        posted.len()
    );
    let mut stream = TcpStream::connect(address).expect("connect");
    stream.write_all(request.as_bytes()).expect("write request");
    let mut response_bytes = Vec::new();
    stream
        .read_to_end(&mut response_bytes)
        .expect("read response");
    let response_text = String::from_utf8_lossy(&response_bytes);
    let body = response_text
        .split("\r\n\r\n")
        .nth(1)
        .expect("response body");
    let normalized = normalize_router_json(body, RequestId(1), &capabilities()).expect("normalize");
    assert_eq!(normalized.reply.as_deref(), Some("pong"));
    let request_bytes = captured.lock().expect("lock").clone();
    assert!(request_bytes.contains("\"content\":\"hello\""));
    assert!(request_bytes.contains("Authorization: Bearer"));
}

#[test]
fn router_errors_do_not_leak_injected_secret() {
    let secret = "super-secret-key";
    let auth_error = match RouterHttp::new(
        RouterConfig {
            base_url: "http://example.com/v1".to_owned(),
            model: "m".to_owned(),
            request_timeout: Duration::from_secs(5),
            stream_mode: RouterStreamMode::Json,
            trailing_instruction_placement: TrailingInstructionPlacement::TrailingSystem,
        },
        capabilities(),
        false,
        RouterAuth::bearer(secret),
    ) {
        Ok(_) => panic!("expected configuration error"),
        Err(error) => error,
    };
    assert!(error_redacts_secret(&auth_error, secret));
}
