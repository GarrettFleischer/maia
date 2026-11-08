use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::thread;
use std::time::Duration;

use maia_tools::mcp_client::ClientError;
use maia_tools::mcp_client::McpSession;
use maia_tools::mcp_client::RpcOutgoing;
use maia_tools::mcp_client::RpcPost;
use maia_tools::mcp_client::RpcReply;
use maia_tools::mcp_client::launch_stdio;
use maia_tools::mcp_client::post_json;

struct ScriptedPost {
    posts: Vec<String>,
    model_calls: u32,
}

impl RpcPost for ScriptedPost {
    fn round_trip(&mut self, outgoing: &RpcOutgoing) -> Result<RpcReply, ClientError> {
        self.posts.push(outgoing.body.clone());
        if outgoing.body.contains("sampling") {
            return Ok(RpcReply {
                body: String::new(),
                session: None,
            });
        }
        Ok(RpcReply {
            body: r#"{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage","params":{"messages":[]}}"#
                .to_owned(),
            session: None,
        })
    }
}

#[test]
fn sampling_request_is_refused_without_a_model_call() {
    let mut post = ScriptedPost {
        posts: Vec::new(),
        model_calls: 0,
    };
    let error = McpSession::new()
        .list_tools(&mut post)
        .expect_err("sampling");
    assert_eq!(error, ClientError::MethodRefused);
    assert_eq!(post.model_calls, 0);
    assert!(post.posts.iter().any(|body| body.contains("-32601")));
    assert!(!post.posts.iter().any(|body| body.contains("completions")));
}

#[test]
fn unready_stdio_does_not_spawn() {
    let error = launch_stdio(false, "maia-mcp-should-not-spawn", &[]).expect_err("gate");
    assert!(matches!(error, maia_core::mcp::StdioError::Containment));
}

#[test]
fn loopback_list_returns_the_fixture_tool() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("addr");
    thread::spawn(move || {
        for _ in 0..3 {
            let (mut stream, _) = listener.accept().expect("accept");
            let request = read_http(&mut stream);
            let body = if request.contains("notifications/initialized") {
                ""
            } else if request.contains("\"method\":\"initialize\"") {
                r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{}}}"#
            } else {
                r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"scrape","description":"Read a page","inputSchema":{"type":"object"}}]}}"#
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    let url = format!("http://{address}/mcp");
    struct HttpPost {
        url: String,
    }
    impl RpcPost for HttpPost {
        fn round_trip(&mut self, outgoing: &RpcOutgoing) -> Result<RpcReply, ClientError> {
            post_json(
                &self.url,
                &[("Authorization", "Bearer fixture-secret")],
                outgoing,
                Duration::from_secs(5),
            )
        }
    }
    let tools = McpSession::new()
        .list_tools(&mut HttpPost { url })
        .expect("list");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "scrape");
    assert!(!tools[0].description.contains("fixture-secret"));
}

fn read_http(stream: &mut impl Read) -> String {
    let mut buffer = [0_u8; 8192];
    let count = stream.read(&mut buffer).expect("read");
    String::from_utf8_lossy(&buffer[..count]).into_owned()
}
