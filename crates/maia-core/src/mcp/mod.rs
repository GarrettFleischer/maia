//! Admitted MCP catalog leaves.
//!
//! These functions take manifests, roles, and bytes as parameters. They do not
//! read a clock, a store, a secret, or the network.

mod admit;
mod arguments;
mod catalog;
mod exchange;
mod guidance;
mod manifest;
mod stdio;
mod target;

pub use admit::AdmitError;
pub use admit::McpCall;
pub use admit::admit_mcp_call;
pub use admit::mcp_grants;
pub use arguments::ArgumentError;
pub use arguments::check_arguments;
pub use arguments::parameter_names;
pub use catalog::CatalogEntry;
pub use catalog::CatalogStatus;
pub use catalog::CatalogTool;
pub use catalog::ConnectionView;
pub use catalog::ListedState;
pub use catalog::catalog_lines;
pub use catalog::connection_entries;
pub use exchange::McpAuditRecord;
pub use exchange::McpExchangeClass;
pub use exchange::SecretNeedle;
pub use exchange::ToolPart;
pub use exchange::bound_tool_text;
pub use exchange::classify_mcp_exchange;
pub use exchange::mcp_audit_record;
pub use exchange::redact_secret_needles;
pub use exchange::render_tool_result;
pub use guidance::GuidanceError;
pub use guidance::GuidanceRoute;
pub use guidance::guidance_for_route;
pub use manifest::ListedTool;
pub use manifest::LiveTool;
pub use manifest::ManifestError;
pub use manifest::PreparedManifest;
pub use manifest::canonical_manifest;
pub use manifest::manifest_hash;
pub use manifest::prepare_manifest;
pub use manifest::valid_connection_id;
pub use manifest::valid_owner_label;
pub use manifest::valid_secret_name;
pub use manifest::valid_stdio_launch;
pub use manifest::wire_name;
pub use manifest::worker_tools_json;
pub use stdio::StdioError;
pub use stdio::open_stdio;
pub use target::TargetError;
pub use target::validate_connection_target;
