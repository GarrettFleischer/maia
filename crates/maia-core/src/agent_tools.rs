//! Subagent tool catalog. Names and schemas follow published conventions.
//!
//! The owner chat can read the catalog text. Only a subagent caller can be admitted.

use std::collections::BTreeMap;

/// Who is asking to call a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCaller {
    /// Owner router session. Execution tools are refused.
    Owner,
    /// Parent or child task worker.
    Subagent,
}

/// Why a tool call was not admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmitError {
    /// The owner chat cannot call an execution tool.
    OwnerForbidden,
    /// The name is not in the admitted catalog.
    UnknownTool,
    /// Arguments were not one JSON object.
    ArgumentsNotObject,
    /// A required argument was absent.
    MissingRequired {
        /// Argument name.
        name: String,
    },
}

/// Why a catalog could not accept a tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    /// Two tools resolved to the same callable name.
    DuplicateName {
        /// Conflicting name.
        name: String,
    },
    /// The parameter schema was not a JSON object.
    InvalidSchema {
        /// Tool that carried the schema.
        name: String,
    },
}

/// One function the subagent may call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionTool {
    /// Callable name.
    pub name: String,
    /// Model-facing description.
    pub description: String,
    /// JSON Schema object for the arguments.
    pub parameters_json: String,
    /// Top-level required argument names.
    pub required: Vec<String>,
}

/// Admitted subagent tools, keyed by callable name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedCatalog {
    tools: BTreeMap<String, FunctionTool>,
}

impl AdmittedCatalog {
    /// Bash plus the published computer-use members.
    ///
    /// `shell_kind` is the host shell named in the bash description. The callable
    /// name stays `bash`.
    pub fn local(shell_kind: &str) -> Self {
        let mut tools = BTreeMap::new();
        for tool in local_tools(shell_kind) {
            tools.insert(tool.name.clone(), tool);
        }
        Self { tools }
    }

    /// Inserts a remote tool, prefixing `server__` when the bare name is taken.
    pub fn insert_remote(&mut self, server: &str, tool: FunctionTool) -> Result<(), CatalogError> {
        if !crate::router::is_json_object(&tool.parameters_json) {
            return Err(CatalogError::InvalidSchema { name: tool.name });
        }
        let name = qualify_tool_name(server, &tool.name, &self.tools);
        if self.tools.contains_key(&name) {
            return Err(CatalogError::DuplicateName { name });
        }
        let mut stored = tool;
        if stored.name != name {
            stored.description = format!("{} ({})", stored.description, stored.name);
            stored.name = name.clone();
        }
        self.tools.insert(name, stored);
        Ok(())
    }

    /// OpenAI-compatible tools array.
    pub fn tools_json(&self) -> String {
        let mut body = String::from("[");
        for (index, tool) in self.tools.values().enumerate() {
            if index > 0 {
                body.push(',');
            }
            body.push_str(&function_json(tool));
        }
        body.push(']');
        body
    }

    /// Text catalog for the owner chat. It cannot call these tools.
    pub fn owner_text(&self, notes: &[String]) -> String {
        let mut text = String::from(
            "Subagent tools. The owner chat cannot call these. Use them only to brief a subagent.\n",
        );
        for tool in self.tools.values() {
            text.push_str(&tool.name);
            text.push_str(": ");
            text.push_str(&tool.description);
            text.push('\n');
        }
        for note in notes {
            text.push_str(note);
            text.push('\n');
        }
        text
    }

    /// Admits one call for the given caller.
    pub fn admit(
        &self,
        caller: ToolCaller,
        name: &str,
        arguments_json: &str,
    ) -> Result<(), AdmitError> {
        if caller == ToolCaller::Owner {
            return Err(AdmitError::OwnerForbidden);
        }
        let Some(tool) = self.tools.get(name) else {
            return Err(AdmitError::UnknownTool);
        };
        let Some(entries) = top_level_entries(arguments_json) else {
            return Err(AdmitError::ArgumentsNotObject);
        };
        if name == "bash" {
            let has_command = entries.iter().any(|(key, _)| key == "command");
            let restart = entries
                .iter()
                .any(|(key, value)| key == "restart" && value.trim() == "true");
            if !has_command && !restart {
                return Err(AdmitError::MissingRequired {
                    name: "command".to_owned(),
                });
            }
            return Ok(());
        }
        for required in &tool.required {
            if !entries.iter().any(|(key, _)| key == required) {
                return Err(AdmitError::MissingRequired {
                    name: required.clone(),
                });
            }
        }
        Ok(())
    }

    /// Whether the catalog contains `name`.
    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// Admitted tools in name order.
    pub fn tools(&self) -> impl Iterator<Item = &FunctionTool> {
        self.tools.values()
    }
}

/// Worker instructions when execution tools are attached.
pub fn subagent_contract(shell_kind: &str) -> String {
    format!(
        "Maia task worker. You are the subagent for this one task.\n\
The next message is the owner's request. Do that work and nothing else.\n\
Call a tool by its published name. The bash tool runs {shell_kind}. \
On Windows that command is {shell_kind}, not a bash script.\n\
Computer tools act on the interactive desktop, including apps other than the browser. \
screenshot captures the whole display. zoom captures a region [x0, y0, x1, y1]. \
screenshot with window captures one app by process name or window title.\n\
Browser tools are the Playwright server's own names when that server is connected.\n\
When the work is finished, answer in prose the owner can read and call no tool.\n\
Do not invent results. Stay inside this task.\n"
    )
}

/// Published computer-use member names.
pub fn computer_tool_names() -> &'static [&'static str] {
    &[
        "screenshot",
        "zoom",
        "left_click",
        "right_click",
        "middle_click",
        "double_click",
        "triple_click",
        "left_click_drag",
        "mouse_move",
        "left_mouse_down",
        "left_mouse_up",
        "cursor_position",
        "scroll",
        "type",
        "key",
        "hold_key",
        "wait",
    ]
}

/// Chooses a callable name that does not collide with tools already admitted.
pub fn qualify_tool_name(
    server: &str,
    tool: &str,
    taken: &BTreeMap<String, FunctionTool>,
) -> String {
    if !taken.contains_key(tool) {
        return tool.to_owned();
    }
    let qualified = format!("{server}__{tool}");
    if !taken.contains_key(&qualified) {
        return qualified;
    }
    let mut suffix = 2u32;
    loop {
        let candidate = format!("{qualified}_{suffix}");
        if !taken.contains_key(&candidate) {
            return candidate;
        }
        suffix = suffix.saturating_add(1);
    }
}

fn local_tools(shell_kind: &str) -> Vec<FunctionTool> {
    let mut tools = vec![FunctionTool {
        name: "bash".to_owned(),
        description: format!(
            "Run one command in the persistent {shell_kind} session. \
Pass command, or restart true to replace the session. \
The working directory and variables carry to the next command."
        ),
        parameters_json: object_schema(
            &[
                ("command", r#"{"type":"string"}"#),
                ("restart", r#"{"type":"boolean"}"#),
            ],
            &[],
        ),
        required: Vec::new(),
    }];
    tools.extend(computer_tools());
    tools
}

fn computer_tools() -> Vec<FunctionTool> {
    let coordinate = r#"{"type":"array","items":{"type":"number"},"minItems":2,"maxItems":2}"#;
    let region = r#"{"type":"array","items":{"type":"number"},"minItems":4,"maxItems":4}"#;
    let modifiers = r#"{"type":"string","description":"Modifier chord such as ctrl+shift."}"#;
    let click = |name: &str, description: &str| FunctionTool {
        name: name.to_owned(),
        description: description.to_owned(),
        parameters_json: object_schema(
            &[("coordinate", coordinate), ("text", modifiers)],
            &[],
        ),
        required: Vec::new(),
    };
    vec![
        FunctionTool {
            name: "screenshot".to_owned(),
            description: "Capture the whole display. Pass window to capture one app by process name or window title.".to_owned(),
            parameters_json: object_schema(
                &[(
                    "window",
                    r#"{"type":"string","description":"Process name or window title."}"#,
                )],
                &[],
            ),
            required: Vec::new(),
        },
        FunctionTool {
            name: "zoom".to_owned(),
            description: "Capture one region of the display. region is [x0, y0, x1, y1] in pixels.".to_owned(),
            parameters_json: object_schema(&[("region", region)], &["region"]),
            required: vec!["region".to_owned()],
        },
        click(
            "left_click",
            "Left-click at coordinate, or at the cursor when coordinate is omitted.",
        ),
        click("right_click", "Right-click at coordinate, or at the cursor."),
        click("middle_click", "Middle-click at coordinate, or at the cursor."),
        click("double_click", "Double-click at coordinate, or at the cursor."),
        click("triple_click", "Triple-click at coordinate, or at the cursor."),
        FunctionTool {
            name: "left_click_drag".to_owned(),
            description: "Press at start_coordinate, drag to coordinate, and release.".to_owned(),
            parameters_json: object_schema(
                &[
                    ("start_coordinate", coordinate),
                    ("coordinate", coordinate),
                    ("text", modifiers),
                ],
                &["start_coordinate", "coordinate"],
            ),
            required: vec!["start_coordinate".to_owned(), "coordinate".to_owned()],
        },
        FunctionTool {
            name: "mouse_move".to_owned(),
            description: "Move the pointer to coordinate.".to_owned(),
            parameters_json: object_schema(&[("coordinate", coordinate)], &["coordinate"]),
            required: vec!["coordinate".to_owned()],
        },
        FunctionTool {
            name: "left_mouse_down".to_owned(),
            description: "Press the left button at the current pointer.".to_owned(),
            parameters_json: object_schema(&[], &[]),
            required: Vec::new(),
        },
        FunctionTool {
            name: "left_mouse_up".to_owned(),
            description: "Release the left button at the current pointer.".to_owned(),
            parameters_json: object_schema(&[], &[]),
            required: Vec::new(),
        },
        FunctionTool {
            name: "cursor_position".to_owned(),
            description: "Report the pointer position.".to_owned(),
            parameters_json: object_schema(&[], &[]),
            required: Vec::new(),
        },
        FunctionTool {
            name: "scroll".to_owned(),
            description: "Scroll at coordinate, or at the cursor. scroll_direction is up, down, left, or right.".to_owned(),
            parameters_json: object_schema(
                &[
                    ("scroll_direction", r#"{"type":"string"}"#),
                    ("scroll_amount", r#"{"type":"number"}"#),
                    ("coordinate", coordinate),
                    ("text", modifiers),
                ],
                &["scroll_direction"],
            ),
            required: vec!["scroll_direction".to_owned()],
        },
        FunctionTool {
            name: "type".to_owned(),
            description: "Type literal text at the current keyboard focus.".to_owned(),
            parameters_json: object_schema(&[("text", r#"{"type":"string"}"#)], &["text"]),
            required: vec!["text".to_owned()],
        },
        FunctionTool {
            name: "key".to_owned(),
            description: "Press a key or chord such as Return or ctrl+s. repeat defaults to 1.".to_owned(),
            parameters_json: object_schema(
                &[
                    ("text", r#"{"type":"string"}"#),
                    ("repeat", r#"{"type":"integer"}"#),
                ],
                &["text"],
            ),
            required: vec!["text".to_owned()],
        },
        FunctionTool {
            name: "hold_key".to_owned(),
            description: "Hold a key for duration seconds, at most 300.".to_owned(),
            parameters_json: object_schema(
                &[
                    ("text", r#"{"type":"string"}"#),
                    ("duration", r#"{"type":"number"}"#),
                ],
                &["text", "duration"],
            ),
            required: vec!["text".to_owned(), "duration".to_owned()],
        },
        FunctionTool {
            name: "wait".to_owned(),
            description: "Pause for duration seconds, at most 300.".to_owned(),
            parameters_json: object_schema(&[("duration", r#"{"type":"number"}"#)], &["duration"]),
            required: vec!["duration".to_owned()],
        },
    ]
}

fn object_schema(properties: &[(&str, &str)], required: &[&str]) -> String {
    let mut body = String::from("{\"type\":\"object\",\"properties\":{");
    for (index, (name, schema)) in properties.iter().enumerate() {
        if index > 0 {
            body.push(',');
        }
        body.push_str(&json_string(name));
        body.push(':');
        body.push_str(schema);
    }
    body.push_str("},\"required\":[");
    for (index, name) in required.iter().enumerate() {
        if index > 0 {
            body.push(',');
        }
        body.push_str(&json_string(name));
    }
    body.push_str("]}");
    body
}

fn function_json(tool: &FunctionTool) -> String {
    format!(
        "{{\"type\":\"function\",\"function\":{{\"name\":{},\"description\":{},\"parameters\":{}}}}}",
        json_string(&tool.name),
        json_string(&tool.description),
        tool.parameters_json
    )
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if other.is_control() => {
                out.push_str(&format!("\\u{:04x}", u32::from(other)));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Top-level keys and raw JSON values of one object.
pub fn top_level_entries(object: &str) -> Option<Vec<(String, String)>> {
    let text = object.trim();
    let mut index = 0usize;
    if !eat(text, &mut index, b'{') {
        return None;
    }
    skip_ws(text, &mut index);
    let mut entries = Vec::new();
    if eat(text, &mut index, b'}') {
        return Some(entries);
    }
    loop {
        skip_ws(text, &mut index);
        let key = parse_string(text, &mut index)?;
        skip_ws(text, &mut index);
        if !eat(text, &mut index, b':') {
            return None;
        }
        skip_ws(text, &mut index);
        let start = index;
        skip_value(text, &mut index)?;
        entries.push((key, text[start..index].to_owned()));
        skip_ws(text, &mut index);
        if eat(text, &mut index, b',') {
            continue;
        }
        if eat(text, &mut index, b'}') && index == text.len() {
            return Some(entries);
        }
        return None;
    }
}

fn eat(text: &str, index: &mut usize, byte: u8) -> bool {
    if text.as_bytes().get(*index) == Some(&byte) {
        *index += 1;
        true
    } else {
        false
    }
}

fn skip_ws(text: &str, index: &mut usize) {
    while matches!(text.as_bytes().get(*index), Some(b' ' | b'\n' | b'\r' | b'\t')) {
        *index += 1;
    }
}

fn parse_string(text: &str, index: &mut usize) -> Option<String> {
    if !eat(text, index, b'"') {
        return None;
    }
    let mut out = String::new();
    let bytes = text.as_bytes();
    while *index < bytes.len() {
        let byte = bytes[*index];
        if byte == b'"' {
            *index += 1;
            return Some(out);
        }
        if byte == b'\\' {
            *index += 1;
            let escaped = *bytes.get(*index)?;
            *index += 1;
            match escaped {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' => {
                    let hex = text.get(*index..*index + 4)?;
                    let code = u32::from_str_radix(hex, 16).ok()?;
                    out.push(char::from_u32(code)?);
                    *index += 4;
                }
                _ => return None,
            }
            continue;
        }
        let character = text[*index..].chars().next()?;
        out.push(character);
        *index += character.len_utf8();
    }
    None
}

fn skip_value(text: &str, index: &mut usize) -> Option<()> {
    let bytes = text.as_bytes();
    match bytes.get(*index)? {
        b'"' => {
            parse_string(text, index)?;
        }
        b'{' => {
            *index = top_level_span(text, *index)?;
        }
        b'[' => skip_array(text, index)?,
        b't' => skip_literal(text, index, "true")?,
        b'f' => skip_literal(text, index, "false")?,
        b'n' => skip_literal(text, index, "null")?,
        b'-' | b'0'..=b'9' => skip_number(text, index)?,
        _ => return None,
    }
    Some(())
}

fn top_level_span(text: &str, start: usize) -> Option<usize> {
    let mut index = start;
    if !eat(text, &mut index, b'{') {
        return None;
    }
    let mut depth = 1i32;
    let bytes = text.as_bytes();
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'"' {
            parse_string(text, &mut index)?;
            continue;
        }
        index += 1;
        if byte == b'{' {
            depth += 1;
        } else if byte == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn skip_array(text: &str, index: &mut usize) -> Option<()> {
    if !eat(text, index, b'[') {
        return None;
    }
    skip_ws(text, index);
    if eat(text, index, b']') {
        return Some(());
    }
    loop {
        skip_value(text, index)?;
        skip_ws(text, index);
        if eat(text, index, b',') {
            skip_ws(text, index);
            continue;
        }
        if eat(text, index, b']') {
            return Some(());
        }
        return None;
    }
}

fn skip_literal(text: &str, index: &mut usize, literal: &str) -> Option<()> {
    if text.get(*index..)?.starts_with(literal) {
        *index += literal.len();
        Some(())
    } else {
        None
    }
}

fn skip_number(text: &str, index: &mut usize) -> Option<()> {
    let bytes = text.as_bytes();
    if bytes.get(*index) == Some(&b'-') {
        *index += 1;
    }
    if !matches!(bytes.get(*index), Some(b'0'..=b'9')) {
        return None;
    }
    while matches!(bytes.get(*index), Some(b'0'..=b'9')) {
        *index += 1;
    }
    if bytes.get(*index) == Some(&b'.') {
        *index += 1;
        if !matches!(bytes.get(*index), Some(b'0'..=b'9')) {
            return None;
        }
        while matches!(bytes.get(*index), Some(b'0'..=b'9')) {
            *index += 1;
        }
    }
    Some(())
}
