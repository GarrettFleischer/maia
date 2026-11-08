#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Tool execution for subagents: MCP, a persistent shell, and desktop computer use.

mod desktop;
mod host;
pub mod mcp_client;
mod shell;
mod stdio_post;

pub use host::OpenedHost;
pub use host::ServerSpec;
pub use host::ServerTransport;
pub use host::SubagentHost;
pub use host::ToolReceipt;
pub use host::parse_server_config;
