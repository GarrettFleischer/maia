//! Newline-delimited JSON stdio transport for an MCP server process.

use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::mcp_client::ClientError;
use crate::mcp_client::RpcOutgoing;
use crate::mcp_client::RpcPost;
use crate::mcp_client::RpcReply;

/// One MCP process speaking newline-delimited JSON on stdin and stdout.
pub struct StdioPost {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
}

impl StdioPost {
    /// Spawns `command`. On Windows, `npx` and `npm` run through `cmd /c`.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::Transport`] when the process cannot be started.
    pub fn spawn(command: &str, args: &[String]) -> Result<Self, ClientError> {
        let mut child = command_for(command, args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| ClientError::Transport)?;
        let stdin = child.stdin.take().ok_or(ClientError::Transport)?;
        let stdout = child.stdout.take().ok_or(ClientError::Transport)?;
        let (sender, lines) = channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(text) = line else { break };
                if text.trim_start().starts_with('{') && sender.send(text).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            lines,
        })
    }

    fn write_message(&mut self, message: &str) -> Result<(), ClientError> {
        self.stdin
            .write_all(message.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|_| ClientError::Transport)
    }

    fn next_response(&mut self, timeout: Duration) -> Result<String, ClientError> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(ClientError::Timeout);
            }
            let line = self
                .lines
                .recv_timeout(remaining)
                .map_err(|error| match error {
                    RecvTimeoutError::Timeout => ClientError::Timeout,
                    RecvTimeoutError::Disconnected => ClientError::Transport,
                })?;
            if response_or_request(&line) {
                return Ok(line);
            }
        }
    }
}

impl RpcPost for StdioPost {
    fn round_trip(&mut self, outgoing: &RpcOutgoing) -> Result<RpcReply, ClientError> {
        self.write_message(&outgoing.body)?;
        if json_has_id(&outgoing.body) {
            let body = self.next_response(Duration::from_secs(60))?;
            return Ok(RpcReply {
                body,
                session: None,
            });
        }
        Ok(RpcReply {
            body: String::new(),
            session: None,
        })
    }
}

impl Drop for StdioPost {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn command_for(command: &str, args: &[String]) -> Command {
    if cfg!(windows) && matches!(command, "npx" | "npm" | "pnpm" | "yarn") {
        let mut command_line = Command::new("cmd");
        command_line.arg("/c").arg(command).args(args);
        command_line
    } else {
        let mut command_line = Command::new(command);
        command_line.args(args);
        command_line
    }
}

fn json_has_id(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("id").cloned())
        .is_some()
}

fn response_or_request(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    let has_id = value.get("id").is_some();
    let response = value.get("result").is_some() || value.get("error").is_some();
    let request = value.get("method").is_some() && has_id;
    response || request
}
