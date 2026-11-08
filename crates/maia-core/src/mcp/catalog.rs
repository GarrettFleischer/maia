/// How much of a connection the owner chat may see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogEntry {
    /// An admitted tool whose schema hash still matches.
    Live {
        /// Owner label for the connection.
        label: String,
        /// Model-facing tool name.
        wire_name: String,
        /// Admitted description.
        description: String,
        /// Sorted parameter names.
        parameters: Vec<String>,
    },
    /// A connection the owner chat may name, without tool text.
    Hidden {
        /// Owner label for the connection.
        label: String,
        /// Why tool text is withheld.
        status: CatalogStatus,
    },
}

/// Why tool text stays out of a prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogStatus {
    /// A list exists and the owner has not admitted its hash.
    PendingApproval,
    /// The latest list hash differs from the admitted hash.
    SchemaChanged,
    /// A required secret is absent.
    SecretMissing,
    /// Stdio containment is not ready.
    Containment,
    /// The server protocol version is unsupported.
    Protocol,
    /// The server could not be listed.
    Unreachable,
}

/// One admitted tool used to build a live catalog row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogTool {
    /// Model-facing tool name.
    pub wire_name: String,
    /// Admitted description.
    pub description: String,
    /// Parameter names.
    pub parameters: Vec<String>,
}

/// Caller-classified connection state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionView {
    /// Owner label.
    pub label: String,
    /// A block that hides tool text even when a list is stored.
    pub blocked: Option<CatalogStatus>,
    /// Relationship of the admitted hash to the listed hash.
    pub listed: ListedState,
    /// Tools supplied only for [`ListedState::Matches`].
    pub tools: Vec<CatalogTool>,
}

/// Hash relationship for one connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListedState {
    /// No list is stored.
    Absent,
    /// A list is stored and no hash is admitted.
    Pending {
        /// Listed manifest hash.
        hash: String,
    },
    /// The listed hash equals the admitted hash.
    Matches {
        /// Shared hash.
        hash: String,
    },
    /// The listed hash and the admitted hash differ.
    Drifted {
        /// Previously admitted hash.
        admitted: String,
        /// Newly listed hash.
        listed: String,
    },
}

/// Renders catalog rows. Hidden rows contain the label and status only.
#[must_use]
pub fn catalog_lines(entries: &[CatalogEntry]) -> String {
    if entries.is_empty() {
        return "No subagent tools are configured.".to_owned();
    }
    let mut lines = Vec::with_capacity(entries.len());
    for entry in entries {
        lines.push(match entry {
            CatalogEntry::Live {
                label,
                wire_name,
                description,
                parameters,
            } => format!(
                "{label}\n{wire_name}: {description}\nParameters: {}",
                parameters.join(", ")
            ),
            CatalogEntry::Hidden { label, status } => {
                format!("{label}: {}", status_text(*status))
            }
        });
    }
    lines.join("\n\n")
}

/// Maps a classified connection to prompt entries.
///
/// Drifted and blocked connections do not copy tool descriptions.
#[must_use]
pub fn connection_entries(view: &ConnectionView) -> Vec<CatalogEntry> {
    if let Some(status) = view.blocked {
        return vec![CatalogEntry::Hidden {
            label: view.label.clone(),
            status,
        }];
    }
    match &view.listed {
        ListedState::Drifted { .. } => vec![CatalogEntry::Hidden {
            label: view.label.clone(),
            status: CatalogStatus::SchemaChanged,
        }],
        ListedState::Pending { .. } => vec![CatalogEntry::Hidden {
            label: view.label.clone(),
            status: CatalogStatus::PendingApproval,
        }],
        ListedState::Absent => Vec::new(),
        ListedState::Matches { .. } => view
            .tools
            .iter()
            .map(|tool| CatalogEntry::Live {
                label: view.label.clone(),
                wire_name: tool.wire_name.clone(),
                description: tool.description.clone(),
                parameters: tool.parameters.clone(),
            })
            .collect(),
    }
}

fn status_text(status: CatalogStatus) -> &'static str {
    match status {
        CatalogStatus::PendingApproval => "pending approval",
        CatalogStatus::SchemaChanged => "schema changed",
        CatalogStatus::SecretMissing => "secret missing",
        CatalogStatus::Containment => "containment is not ready",
        CatalogStatus::Protocol => "protocol is unsupported",
        CatalogStatus::Unreachable => "unreachable",
    }
}
