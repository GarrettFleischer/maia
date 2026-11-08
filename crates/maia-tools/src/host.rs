//! Subagent tool host: bash, computer use, and admitted MCP servers.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use maia_core::agent_tools::AdmittedCatalog;
use maia_core::agent_tools::FunctionTool;
use maia_core::mcp::CatalogEntry;
use maia_core::mcp::CatalogStatus;
use maia_core::mcp::CatalogTool;
use maia_core::mcp::ConnectionView;
use maia_core::mcp::ListedState;
use maia_core::mcp::ListedTool;
use maia_core::mcp::LiveTool;
use maia_core::mcp::ToolPart;
use maia_core::mcp::bound_tool_text;
use maia_core::mcp::connection_entries;
use maia_core::mcp::manifest_hash;
use maia_core::mcp::parameter_names;
use maia_core::mcp::prepare_manifest;
use maia_core::mcp::render_tool_result;
use maia_core::mcp::valid_connection_id;
use maia_core::mcp::valid_stdio_launch;
use maia_core::mcp::wire_name;
use serde_json::Value;

use crate::desktop::DesktopOutcome;
use crate::desktop::parse_desktop_call;
use crate::desktop::run_desktop;
use crate::mcp_client::ClientError;
use crate::mcp_client::McpSession;
use crate::mcp_client::RpcOutgoing;
use crate::mcp_client::RpcPost;
use crate::mcp_client::RpcReply;
use crate::mcp_client::post_json;
use crate::shell::ShellError;
use crate::shell::ShellSession;
use crate::stdio_post::StdioPost;

const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const SHELL_CONNECTION: &str = "shell";
const DESKTOP_CONNECTION: &str = "desktop";
const MAX_PNG_BYTES: usize = 1_000_000;

/// One configured MCP server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSpec {
    /// Connection id.
    pub id: String,
    /// Owner label.
    pub label: String,
    /// How to reach the server.
    pub transport: ServerTransport,
}

/// Stdio or HTTP transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerTransport {
    /// A local process speaking MCP on stdin and stdout.
    Stdio {
        /// Executable.
        command: String,
        /// Arguments.
        args: Vec<String>,
    },
    /// A remote MCP endpoint.
    Http {
        /// Absolute URL.
        url: String,
    },
}

/// Text and an optional PNG returned to the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolReceipt {
    /// Text the model can read.
    pub text: String,
    /// Base64 PNG when the tool returned a screenshot.
    pub image_png_base64: Option<String>,
    /// The request bytes were written.
    pub sent: bool,
    /// A complete response arrived.
    pub completed: bool,
}

/// Catalog rows, live tools, and the host that executes them.
pub struct OpenedHost {
    /// Owner-chat catalog rows.
    pub entries: Vec<CatalogEntry>,
    /// Tools a subagent may call.
    pub live: Vec<LiveTool>,
    /// Wire name to connection id and manifest hash.
    pub origin: BTreeMap<String, (String, String)>,
    /// Executor. The owner chat does not receive this.
    pub host: SubagentHost,
}

struct ConnectedServer {
    id: String,
    session: McpSession,
    post: Box<dyn RpcPost + Send>,
}

/// Shell, desktop, and connected MCP servers for one subagent.
pub struct SubagentHost {
    shell: Option<ShellSession>,
    servers: Vec<ConnectedServer>,
}

impl SubagentHost {
    /// Starts the shell and connects each configured server.
    ///
    /// A server that fails stays in the catalog as hidden. Bash and computer
    /// tools stay available.
    pub fn open(specs: &[ServerSpec]) -> OpenedHost {
        Self::open_with(ShellSession::start().ok(), specs)
    }

    fn open_with(shell: Option<ShellSession>, specs: &[ServerSpec]) -> OpenedHost {
        let shell_kind = shell
            .as_ref()
            .map(ShellSession::kind)
            .unwrap_or(if cfg!(windows) { "PowerShell" } else { "bash" });
        let catalog = AdmittedCatalog::local(shell_kind);
        let mut entries = Vec::new();
        let mut live = Vec::new();
        let mut origin = BTreeMap::new();
        let mut taken = BTreeSet::new();
        admit_local(
            "Shell",
            SHELL_CONNECTION,
            catalog.tools().filter(|tool| tool.name == "bash"),
            &mut entries,
            &mut live,
            &mut origin,
            &mut taken,
        );
        admit_local(
            "Desktop",
            DESKTOP_CONNECTION,
            catalog.tools().filter(|tool| tool.name != "bash"),
            &mut entries,
            &mut live,
            &mut origin,
            &mut taken,
        );
        let mut servers = Vec::new();
        for spec in specs {
            match connect_server(spec, &mut taken) {
                Ok(connected) => {
                    entries.extend(connected.entries);
                    for tool in connected.live {
                        origin.insert(
                            tool.wire_name.clone(),
                            (spec.id.clone(), connected.hash.clone()),
                        );
                        live.push(tool);
                    }
                    servers.push(connected.server);
                }
                Err(()) => entries.push(CatalogEntry::Hidden {
                    label: spec.label.clone(),
                    status: CatalogStatus::Unreachable,
                }),
            }
        }
        OpenedHost {
            entries,
            live,
            origin,
            host: Self { shell, servers },
        }
    }

    /// Runs one admitted tool call.
    pub fn execute(
        &mut self,
        connection: &str,
        server_tool: &str,
        arguments_json: &str,
    ) -> ToolReceipt {
        if connection == SHELL_CONNECTION {
            return self.execute_bash(arguments_json);
        }
        if connection == DESKTOP_CONNECTION {
            return execute_desktop(server_tool, arguments_json);
        }
        self.execute_mcp(connection, server_tool, arguments_json)
    }

    fn execute_bash(&mut self, arguments_json: &str) -> ToolReceipt {
        let Ok(value) = serde_json::from_str::<Value>(arguments_json) else {
            return known_failure("bash arguments must be a JSON object.".to_owned());
        };
        let restart = value
            .get("restart")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let command = value
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(shell) = self.shell.as_mut() else {
            return known_failure("The shell is not available.".to_owned());
        };
        match shell.run(command.as_deref(), restart, CALL_TIMEOUT) {
            Ok(output) => completed(bound_tool_text(&output), None),
            Err(ShellError::Timeout) => {
                self.shell = ShellSession::start().ok();
                unknown_receipt()
            }
            Err(error) => known_failure(error.to_string()),
        }
    }

    fn execute_mcp(
        &mut self,
        connection: &str,
        server_tool: &str,
        arguments_json: &str,
    ) -> ToolReceipt {
        let Some(index) = self
            .servers
            .iter()
            .position(|server| server.id == connection)
        else {
            return known_failure(format!("{server_tool} is not connected."));
        };
        let server = &mut self.servers[index];
        match server
            .session
            .call_tool(server.post.as_mut(), server_tool, arguments_json)
        {
            Ok(parts) => {
                let image = first_image(&parts);
                completed(bound_tool_text(&render_tool_result(&parts)), image)
            }
            Err(ClientError::Timeout) => unknown_receipt(),
            Err(error) => known_failure(client_text(&error)),
        }
    }
}

struct Connected {
    entries: Vec<CatalogEntry>,
    live: Vec<LiveTool>,
    hash: String,
    server: ConnectedServer,
}

fn connect_server(spec: &ServerSpec, taken: &mut BTreeSet<String>) -> Result<Connected, ()> {
    let mut post = open_post(spec)?;
    let mut session = McpSession::new();
    let listed = session.list_tools(post.as_mut()).map_err(|_| ())?;
    let admitted = admit_remote(&spec.id, &spec.label, &listed, taken).map_err(|_| ())?;
    Ok(Connected {
        entries: admitted.entries,
        live: admitted.live,
        hash: admitted.hash,
        server: ConnectedServer {
            id: spec.id.clone(),
            session,
            post,
        },
    })
}

fn open_post(spec: &ServerSpec) -> Result<Box<dyn RpcPost + Send>, ()> {
    match &spec.transport {
        ServerTransport::Stdio { command, args } => {
            let process = maia_core::mcp::open_stdio(true, || StdioPost::spawn(command, args))
                .map_err(|_| ())?;
            Ok(Box::new(process))
        }
        ServerTransport::Http { url } => Ok(Box::new(HttpPost { url: url.clone() })),
    }
}

struct HttpPost {
    url: String,
}

impl RpcPost for HttpPost {
    fn round_trip(&mut self, outgoing: &RpcOutgoing) -> Result<RpcReply, ClientError> {
        post_json(&self.url, &[], outgoing, CALL_TIMEOUT)
    }
}

struct AdmittedRemote {
    entries: Vec<CatalogEntry>,
    live: Vec<LiveTool>,
    hash: String,
}

fn admit_remote(
    connection: &str,
    label: &str,
    listed: &[crate::mcp_client::RemoteTool],
    taken: &mut BTreeSet<String>,
) -> Result<AdmittedRemote, ()> {
    let mut named = Vec::new();
    for tool in listed {
        let Some(callable) = callable_name(connection, &tool.name, taken) else {
            continue;
        };
        named.push((callable, tool));
    }
    named.truncate(32);
    if named.is_empty() {
        return Err(());
    }
    let listed_tools: Vec<ListedTool> = named
        .iter()
        .map(|(_, tool)| ListedTool {
            name: tool.name.clone(),
            description: tool.description.clone(),
            input_schema: tool.input_schema.clone(),
        })
        .collect();
    let hash = prepare_manifest(connection, &listed_tools)
        .map(|prepared| prepared.hash)
        .unwrap_or_else(|_| manifest_hash(connection));
    let live: Vec<LiveTool> = named
        .into_iter()
        .map(|(callable, tool)| LiveTool {
            wire_name: callable,
            server_tool: tool.name.clone(),
            description: tool.description.clone(),
            input_schema: tool.input_schema.clone(),
        })
        .collect();
    let entries = connection_entries(&ConnectionView {
        label: label.to_owned(),
        blocked: None,
        listed: ListedState::Matches { hash: hash.clone() },
        tools: catalog_tools(&live),
    });
    Ok(AdmittedRemote {
        entries,
        live,
        hash,
    })
}

fn admit_local<'a>(
    label: &str,
    connection: &str,
    tools: impl Iterator<Item = &'a FunctionTool>,
    entries: &mut Vec<CatalogEntry>,
    live: &mut Vec<LiveTool>,
    origin: &mut BTreeMap<String, (String, String)>,
    taken: &mut BTreeSet<String>,
) {
    let tools: Vec<&FunctionTool> = tools.collect();
    let listed: Vec<ListedTool> = tools
        .iter()
        .map(|tool| ListedTool {
            name: tool.name.clone(),
            description: tool.description.clone(),
            input_schema: tool.parameters_json.clone(),
        })
        .collect();
    let hash = prepare_manifest(connection, &listed)
        .map(|prepared| prepared.hash)
        .unwrap_or_else(|_| manifest_hash(connection));
    let group: Vec<LiveTool> = tools
        .iter()
        .map(|tool| {
            taken.insert(tool.name.clone());
            LiveTool {
                wire_name: tool.name.clone(),
                server_tool: tool.name.clone(),
                description: tool.description.clone(),
                input_schema: tool.parameters_json.clone(),
            }
        })
        .collect();
    entries.extend(connection_entries(&ConnectionView {
        label: label.to_owned(),
        blocked: None,
        listed: ListedState::Matches { hash: hash.clone() },
        tools: catalog_tools(&group),
    }));
    for tool in &group {
        origin.insert(
            tool.wire_name.clone(),
            (connection.to_owned(), hash.clone()),
        );
    }
    live.extend(group);
}

fn catalog_tools(live: &[LiveTool]) -> Vec<CatalogTool> {
    live.iter()
        .map(|tool| CatalogTool {
            wire_name: tool.wire_name.clone(),
            description: tool.description.clone(),
            parameters: parameter_names(&tool.input_schema).unwrap_or_default(),
        })
        .collect()
}

fn callable_name(server: &str, tool: &str, taken: &mut BTreeSet<String>) -> Option<String> {
    if wire_name(server, tool).is_err() {
        return None;
    }
    let mut name = if taken.contains(tool) {
        format!("{server}__{tool}")
    } else {
        tool.to_owned()
    };
    let mut suffix = 2u32;
    while taken.contains(&name) {
        name = format!("{server}__{tool}_{suffix}");
        suffix = suffix.saturating_add(1);
        if suffix > 100 {
            return None;
        }
    }
    if name.len() > 64 {
        return None;
    }
    taken.insert(name.clone());
    Some(name)
}

fn execute_desktop(name: &str, arguments_json: &str) -> ToolReceipt {
    match parse_desktop_call(name, arguments_json).and_then(|call| run_desktop(&call)) {
        Ok(DesktopOutcome::Text(text)) => completed(text, None),
        Ok(DesktopOutcome::Png { note, bytes }) => {
            if bytes.len() > MAX_PNG_BYTES {
                completed(
                    format!("{note} The screenshot was too large to attach."),
                    None,
                )
            } else {
                completed(note, Some(STANDARD.encode(bytes)))
            }
        }
        Err(error) => known_failure(error),
    }
}

fn first_image(parts: &[ToolPart]) -> Option<String> {
    parts.iter().find_map(|part| match part {
        ToolPart::Image { png_base64 } if png_base64.len() <= 1_500_000 => Some(png_base64.clone()),
        _ => None,
    })
}

fn completed(text: String, image_png_base64: Option<String>) -> ToolReceipt {
    ToolReceipt {
        text,
        image_png_base64,
        sent: true,
        completed: true,
    }
}

fn known_failure(text: String) -> ToolReceipt {
    ToolReceipt {
        text,
        image_png_base64: None,
        sent: false,
        completed: false,
    }
}

fn unknown_receipt() -> ToolReceipt {
    ToolReceipt {
        text: "The tool call ended with an unknown outcome and will not be replayed.".to_owned(),
        image_png_base64: None,
        sent: true,
        completed: false,
    }
}

fn client_text(error: &ClientError) -> String {
    match error {
        ClientError::Target => "The MCP URL is not allowed.".to_owned(),
        ClientError::Transport => "The MCP server could not be reached.".to_owned(),
        ClientError::Protocol => {
            "The MCP server returned a response Maia could not use.".to_owned()
        }
        ClientError::MethodRefused => {
            "The server asked Maia to call a model, and that was refused.".to_owned()
        }
        ClientError::TooManyTools => "The tool list is larger than 32.".to_owned(),
        ClientError::Timeout => unknown_receipt().text,
    }
}

/// Reads an owner MCP config document.
///
/// # Errors
///
/// Returns a sentence when the document is not a usable server list.
pub fn parse_server_config(text: &str) -> Result<Vec<ServerSpec>, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|_| "MCP config is not JSON.".to_owned())?;
    let servers = value
        .get("servers")
        .and_then(Value::as_array)
        .ok_or_else(|| "MCP config needs a servers array.".to_owned())?;
    servers.iter().map(parse_server).collect()
}

fn parse_server(value: &Value) -> Result<ServerSpec, String> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "A server is missing id.".to_owned())?
        .to_owned();
    if !valid_connection_id(&id) || id == SHELL_CONNECTION || id == DESKTOP_CONNECTION {
        return Err(format!("{id} is not a usable connection id."));
    }
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_owned();
    let kind = value
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("stdio");
    let transport = match kind {
        "stdio" => {
            let command = required_config_string(value, "command")?;
            let args = string_array(value, "args")?;
            if !valid_stdio_launch(&command, &args) {
                return Err(format!("{id} has a launch command Maia will not run."));
            }
            ServerTransport::Stdio { command, args }
        }
        "http" => {
            let url = required_config_string(value, "url")?;
            maia_core::mcp::validate_connection_target(&url)
                .map_err(|_| "The MCP URL must be https, or http on localhost.".to_owned())?;
            ServerTransport::Http { url }
        }
        _ => return Err(format!("{id} has an unknown transport.")),
    };
    Ok(ServerSpec {
        id,
        label,
        transport,
    })
}

fn required_config_string(value: &Value, name: &str) -> Result<String, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("A server is missing {name}."))
}

fn string_array(value: &Value, name: &str) -> Result<Vec<String>, String> {
    match value.get(name) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{name} must be strings."))
            })
            .collect(),
        _ => Err(format!("{name} must be an array.")),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::SubagentHost;
    use super::callable_name;
    use super::parse_server_config;

    #[test]
    fn colliding_remote_name_is_prefixed() {
        let mut taken = BTreeSet::from(["screenshot".to_owned()]);
        let name = callable_name("other", "screenshot", &mut taken).expect("name");
        assert_eq!(name, "other__screenshot");
    }

    #[test]
    fn config_accepts_stdio_and_rejects_public_http() {
        let specs = parse_server_config(
            r#"{"servers":[{"id":"playwright","label":"Playwright","transport":"stdio","command":"npx","args":["-y","@playwright/mcp@latest"]}]}"#,
        )
        .expect("config");
        assert_eq!(specs[0].id, "playwright");
        let error = parse_server_config(
            r#"{"servers":[{"id":"web","transport":"http","url":"http://example.com/mcp"}]}"#,
        );
        assert!(error.is_err());
    }

    #[test]
    fn local_surface_admits_bash_and_screenshot_without_a_process() {
        let opened = SubagentHost::open_with(None, &[]);
        assert!(opened.live.iter().any(|tool| tool.wire_name == "bash"));
        assert!(
            opened
                .live
                .iter()
                .any(|tool| tool.wire_name == "screenshot")
        );
        assert_eq!(
            opened.origin.get("bash").map(|(id, _)| id.as_str()),
            Some("shell")
        );
        assert_eq!(
            opened.origin.get("zoom").map(|(id, _)| id.as_str()),
            Some("desktop")
        );
    }

    #[test]
    fn zoom_without_a_region_is_a_known_failure() {
        let mut opened = SubagentHost::open_with(None, &[]);
        let receipt = opened.host.execute("desktop", "zoom", "{}");
        assert!(!receipt.sent);
        assert!(!receipt.completed);
        assert!(receipt.text.contains("region"));
    }
}
