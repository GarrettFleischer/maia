use std::collections::BTreeSet;

use crate::mcp::arguments::check_arguments;
use crate::mcp::manifest::LiveTool;
use crate::super_agent::GrantKey;
use crate::super_agent::SessionRole;

/// A call the host may send to an MCP server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpCall {
    /// Server tool name, without the connection prefix.
    pub server_tool: String,
    /// Argument JSON the model supplied.
    pub arguments_json: String,
}

/// Why a call was not sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmitError {
    /// The owner chat cannot call MCP tools.
    RouterRole,
    /// The wire name is not in the live set.
    UnknownTool,
    /// The role's grants do not include the wire name.
    Grant,
    /// The arguments missed the pinned schema subset.
    Arguments,
}

/// Grants for one role. The router set is empty. A child receives the intersection.
#[must_use]
pub fn mcp_grants(
    role: &SessionRole,
    live_wire_names: &[String],
    parent_grants: &BTreeSet<GrantKey>,
) -> BTreeSet<GrantKey> {
    match role {
        SessionRole::Router => BTreeSet::new(),
        SessionRole::ParentTask { .. } => live_wire_names.iter().map(|name| GrantKey(name.clone())).collect(),
        SessionRole::ChildTask { .. } => live_wire_names
            .iter()
            .filter(|name| parent_grants.contains(&GrantKey((*name).clone())))
            .map(|name| GrantKey(name.clone()))
            .collect(),
    }
}

/// Admits one MCP call for a parent or child.
///
/// The router role returns [`AdmitError::RouterRole`] before argument checks.
///
/// # Errors
///
/// Returns [`AdmitError`] when the role, name, grant, or arguments fail.
pub fn admit_mcp_call(
    role: &SessionRole,
    wire_name: &str,
    arguments_json: &str,
    live: &[LiveTool],
    grants: &BTreeSet<GrantKey>,
) -> Result<McpCall, AdmitError> {
    if matches!(role, SessionRole::Router) {
        return Err(AdmitError::RouterRole);
    }
    let Some(tool) = live.iter().find(|tool| tool.wire_name == wire_name) else {
        return Err(AdmitError::UnknownTool);
    };
    if !grants.contains(&GrantKey(wire_name.to_owned())) {
        return Err(AdmitError::Grant);
    }
    check_arguments(&tool.input_schema, arguments_json).map_err(|_| AdmitError::Arguments)?;
    Ok(McpCall {
        server_tool: tool.server_tool.clone(),
        arguments_json: arguments_json.to_owned(),
    })
}
