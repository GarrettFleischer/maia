//! In-memory tool host for parent and child task scripts.
//!
//! Real execution tools are refused. This module does not spawn a process,
//! open a shell, or read the clock, environment, or a global script table.
//! Each host owns its queues and its non-replayable call set.

use std::collections::BTreeSet;
use std::collections::VecDeque;

use maia_core::security::SecurityProfile;
use maia_core::super_agent::CallId;
use maia_core::super_agent::ExecutionTool;
use maia_core::super_agent::SessionRole;

/// Why the scripted host refused a tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolHostError {
    /// `SessionRole::Router` has no execution path.
    RouterForbidden,
    /// A real shell, computer, or process tool is not available.
    ContainmentUnavailable,
    /// The script ended without a known external result.
    Unknown {
        /// Call that must not be issued again.
        call_id: CallId,
    },
    /// The call was already recorded as an unknown outcome.
    ReplayForbidden {
        /// Call the host will not run again.
        call_id: CallId,
    },
    /// The role's script queue was empty.
    NoScript,
}

impl std::fmt::Display for ToolHostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::RouterForbidden => "The router session cannot execute tools.",
            Self::ContainmentUnavailable => "Process containment is not available.",
            Self::Unknown { .. } => "The tool call ended with an unknown outcome.",
            Self::ReplayForbidden { .. } => "That tool call cannot be replayed.",
            Self::NoScript => "The scripted tool host has no queued call.",
        };
        formatter.write_str(text)
    }
}

impl std::error::Error for ToolHostError {}

/// How a scripted completion proposal cites evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionEvidence {
    /// Store one evidence id and cite it.
    Stored,
    /// Cite an evidence id the host has not stored.
    Missing,
    /// Propose completion without a criterion mark.
    CriterionOmitted,
}

/// One explicit parent or child script step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptedCall {
    /// Ordinary progress text.
    Progress {
        /// Worker summary stored unchanged.
        summary: String,
    },
    /// Unknown external outcome for the supplied call id.
    Unknown,
    /// Completion proposal. The host still runs the completion gate.
    Completion {
        /// Worker summary stored unchanged.
        summary: String,
        /// How the proposal relates to stored evidence.
        evidence: CompletionEvidence,
    },
    /// Prose that must not be treated as completion.
    Prose {
        /// Worker summary stored unchanged.
        summary: String,
    },
    /// Worker-reported attempt failure.
    Failure {
        /// Failure summary stored on the task report.
        summary: String,
    },
    /// The host must park the task for an owner decision. The kind is code, not model text.
    NeedsApproval {
        /// What the owner is being asked to grant.
        kind: ApprovalKind,
    },
}

/// Owner decision a scripted task is allowed to request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalKind {
    /// Sign in to a service.
    Login,
    /// Consent to continue.
    Consent,
    /// Grant a capability.
    Capability,
}

impl ApprovalKind {
    /// Store kind token.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::Consent => "consent",
            Self::Capability => "capability",
        }
    }
}

/// Per-instance scripted parent and child queues.
#[derive(Debug, Default)]
pub struct ScriptedToolHost {
    parent_script: VecDeque<ScriptedCall>,
    child_script: VecDeque<ScriptedCall>,
    blocked: BTreeSet<CallId>,
    script_calls: u64,
}

impl ScriptedToolHost {
    /// Empty queues. Nothing is shared with another host.
    pub fn create() -> Self {
        Self::default()
    }

    /// Queues one parent script step.
    pub fn push_parent(&mut self, call: ScriptedCall) {
        self.parent_script.push_back(call);
    }

    /// Queues one child script step.
    pub fn push_child(&mut self, call: ScriptedCall) {
        self.child_script.push_back(call);
    }

    /// Parent steps not yet consumed.
    pub fn pending_parent(&self) -> usize {
        self.parent_script.len()
    }

    /// Child steps not yet consumed.
    pub fn pending_child(&self) -> usize {
        self.child_script.len()
    }

    /// Script steps that were actually dequeued.
    pub fn call_count(&self) -> u64 {
        self.script_calls
    }

    /// Whether this host will refuse `call` without running a script.
    pub fn replay_blocked(&self, call: &CallId) -> bool {
        self.blocked.contains(call)
    }

    /// Refuses router execution and every real tool.
    ///
    /// Router refusal happens before the script queues are read. Parent and
    /// child calls do not spawn a process under any security profile.
    pub fn execute(
        &self,
        role: &SessionRole,
        tool: ExecutionTool,
        profile: SecurityProfile,
    ) -> Result<(), ToolHostError> {
        match role {
            SessionRole::Router => Err(ToolHostError::RouterForbidden),
            SessionRole::ParentTask { .. } | SessionRole::ChildTask { .. } => {
                Err(refuse_real_tool(tool, profile))
            }
        }
    }

    /// Runs one queued parent or child script.
    ///
    /// A router role returns [`ToolHostError::RouterForbidden`] before the
    /// queues or the replay set are changed. A blocked call id returns
    /// [`ToolHostError::ReplayForbidden`] without dequeuing.
    pub fn execute_scripted(
        &mut self,
        role: &SessionRole,
        call_id: CallId,
        profile: SecurityProfile,
    ) -> Result<ScriptedCall, ToolHostError> {
        if matches!(role, SessionRole::Router) {
            return Err(ToolHostError::RouterForbidden);
        }
        profile_seen(profile);
        if self.blocked.contains(&call_id) {
            return Err(ToolHostError::ReplayForbidden { call_id });
        }
        let call = self.take_script(role)?;
        self.script_calls = self.script_calls.saturating_add(1);
        match call {
            ScriptedCall::Unknown => {
                self.blocked.insert(call_id.clone());
                Err(ToolHostError::Unknown { call_id })
            }
            other => Ok(other),
        }
    }

    fn take_script(&mut self, role: &SessionRole) -> Result<ScriptedCall, ToolHostError> {
        let queue = match role {
            SessionRole::Router => return Err(ToolHostError::RouterForbidden),
            SessionRole::ParentTask { .. } => &mut self.parent_script,
            SessionRole::ChildTask { .. } => &mut self.child_script,
        };
        queue.pop_front().ok_or(ToolHostError::NoScript)
    }
}

/// Names every real tool and every profile, and still refuses the call.
fn refuse_real_tool(tool: ExecutionTool, profile: SecurityProfile) -> ToolHostError {
    match (tool, profile) {
        (
            ExecutionTool::Shell
            | ExecutionTool::Filesystem
            | ExecutionTool::Browser
            | ExecutionTool::Network
            | ExecutionTool::Vault
            | ExecutionTool::OpenThread
            | ExecutionTool::PostToThread,
            SecurityProfile::Protected
            | SecurityProfile::Allowlisted
            | SecurityProfile::Unrestricted,
        ) => ToolHostError::ContainmentUnavailable,
    }
}

/// Names every profile so a new one cannot skip this host.
fn profile_seen(profile: SecurityProfile) {
    match profile {
        SecurityProfile::Protected
        | SecurityProfile::Allowlisted
        | SecurityProfile::Unrestricted => {}
    }
}
