//! Framed loopback HTTP helpers for cfg(test) contract servers and sync transport.

use std::io::{Read, Write};
use std::net::TcpStream;

use maia_core::router::{MAX_ROUTER_RESPONSE_BYTES, RouterError, ensure_within_limit};
use reqwest::StatusCode;

fn protocol(detail: impl Into<String>) -> RouterError {
    RouterError::Protocol {
        detail: detail.into(),
    }
}

/// Reads one inbound HTTP request (headers + declared body) from a connection.
pub fn read_framed_http_request(stream: &mut TcpStream) -> Result<String, RouterError> {
    let header_block = read_header_block(stream)?;
    let header_text = std::str::from_utf8(&header_block).map_err(|_| protocol("invalid utf-8"))?;
    let content_length = parse_content_length(header_text)?;
    let mut body = vec![0u8; content_length];
    read_exact(stream, &mut body)?;
    Ok(format!("{}{}", header_text, String::from_utf8_lossy(&body)))
}

/// Reads one HTTP response with a bounded body allocation.
pub fn read_framed_http_response(
    stream: &mut TcpStream,
    max_body_bytes: usize,
) -> Result<(StatusCode, Vec<u8>), RouterError> {
    let header_block = read_header_block(stream)?;
    let header_text = std::str::from_utf8(&header_block).map_err(|_| protocol("invalid utf-8"))?;
    let status = parse_status_line(header_text)?;
    let content_length = parse_content_length(header_text)?;
    ensure_within_limit(0, content_length, max_body_bytes, "response_body")?;
    let mut body = vec![0u8; content_length];
    read_exact(stream, &mut body)?;
    Ok((status, body))
}

fn read_header_block(stream: &mut TcpStream) -> Result<Vec<u8>, RouterError> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1];
    loop {
        read_exact(stream, &mut chunk)?;
        buffer.push(chunk[0]);
        if buffer.len() >= 4 && buffer.ends_with(b"\r\n\r\n") {
            return Ok(buffer);
        }
        ensure_within_limit(0, buffer.len(), 64 * 1024, "http_header_block")?;
    }
}

fn parse_status_line(header_text: &str) -> Result<StatusCode, RouterError> {
    let status_line = header_text
        .lines()
        .next()
        .ok_or_else(|| protocol("malformed response"))?;
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .and_then(|code| StatusCode::from_u16(code).ok())
        .ok_or_else(|| protocol("malformed response"))?;
    Ok(code)
}

fn parse_content_length(header_text: &str) -> Result<usize, RouterError> {
    for line in header_text.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            return value
                .trim()
                .parse::<usize>()
                .map_err(|_| protocol("invalid content-length"));
        }
    }
    Err(protocol("missing content-length"))
}

fn read_exact(stream: &mut TcpStream, buffer: &mut [u8]) -> Result<(), RouterError> {
    let mut offset = 0usize;
    while offset < buffer.len() {
        let read = stream
            .read(&mut buffer[offset..])
            .map_err(|_| protocol("transport failure"))?;
        if read == 0 {
            return Err(protocol("unexpected eof"));
        }
        offset += read;
    }
    Ok(())
}

/// Writes a complete HTTP/1.1 response with Content-Length.
pub fn write_http_response(
    stream: &mut TcpStream,
    status: &str,
    body: &[u8],
) -> Result<(), RouterError> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|_| protocol("transport failure"))?;
    stream
        .write_all(body)
        .map_err(|_| protocol("transport failure"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn framed_request_reader_reads_exact_post_body() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (ready_tx, ready_rx) = mpsc::channel();
        thread::spawn(move || {
            ready_tx.send(()).expect("ready");
            let (mut stream, _) = listener.accept().expect("accept");
            let request = read_framed_http_request(&mut stream).expect("read request");
            assert!(request.contains("POST /v1/chat/completions"));
            assert!(request.contains("{\"q\":1}"));
            write_http_response(&mut stream, "200 OK", b"ok").expect("write");
        });
        ready_rx.recv().expect("ready");
        let mut client = TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect");
        client
            .write_all(
                b"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 7\r\n\r\n{\"q\":1}",
            )
            .expect("write");
        let (status, body) =
            read_framed_http_response(&mut client, MAX_ROUTER_RESPONSE_BYTES).expect("response");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, b"ok");
    }
}
