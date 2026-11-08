//! Data-only bubblewrap plans. Nothing in this module starts a process.

use std::fmt;

use maia_containment::{
    ChildPlanError, CommandPlan, CommandPlanError, PlatformKind, path_lies_in_chrome_profile,
    try_command_plan,
};

/// How a devpts mount is supposed to be created.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DevptsFreshness {
    /// A new instance owned by the sandbox.
    Fresh,
    /// The host devpts. This is not a pass.
    HostInstance,
}

/// One requested mount before validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountDraft {
    /// Mount class.
    pub kind: MountDraftKind,
    /// Source path for bind mounts.
    pub source: Option<String>,
    /// Target path inside the sandbox.
    pub target: String,
}

/// Mount class requested by a draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MountDraftKind {
    /// Read-only bind.
    ReadOnly,
    /// tmpfs.
    Tmpfs,
    /// devpts, fresh or host.
    Devpts {
        /// Whether the instance is private.
        freshness: DevptsFreshness,
    },
    /// procfs.
    Proc,
}

/// Namespace mode. Shared-with-host is rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NamespaceMode {
    /// Create a new namespace.
    Unshare,
    /// Keep the host namespace.
    SharedWithHost,
}

/// Namespace draft. Every field must be [`NamespaceMode::Unshare`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NamespaceDraft {
    /// User namespace.
    pub user: NamespaceMode,
    /// PID namespace.
    pub pid: NamespaceMode,
    /// Mount namespace.
    pub mount: NamespaceMode,
    /// Network namespace.
    pub net: NamespaceMode,
    /// IPC namespace.
    pub ipc: NamespaceMode,
    /// UTS namespace.
    pub uts: NamespaceMode,
}

/// Inputs to [`try_bubblewrap_plan`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BubblewrapDraft {
    /// Absolute `bwrap` path.
    pub bwrap_executable: String,
    /// Absolute child executable.
    pub child_executable: String,
    /// Child argv, one element per argument.
    pub child_args: Vec<String>,
    /// Mounts. The Chrome profile must not appear.
    pub mounts: Vec<MountDraft>,
    /// Absolute Chrome profile directory that must stay outside the mounts.
    pub chrome_profile: String,
    /// Required unshare set.
    pub namespaces: NamespaceDraft,
}

/// Syscall policy recorded on a plan. It is not installed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SyscallFilter {
    /// seccomp is required before any future exec.
    SeccompRequired,
}

/// Filesystem policy recorded on a plan. It is not installed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FilesystemPolicy {
    /// Landlock ABI 6 or newer is required before any future exec.
    LandlockAbiAtLeast6,
}

/// Validated plan. [`argument_vector`] is data, not a shell string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BubblewrapPlan {
    bwrap_executable: String,
    child: CommandPlan,
    mounts: Vec<StoredMount>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredMount {
    kind: StoredKind,
    source: Option<String>,
    target: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StoredKind {
    ReadOnly,
    Tmpfs,
    FreshDevpts,
    Proc,
}

impl BubblewrapPlan {
    /// Argv a future launcher could pass to `bwrap` without a shell.
    ///
    /// Seccomp and Landlock are not argv flags. [`contained_spawn_boundary`] refuses to exec this.
    pub fn argument_vector(&self) -> Vec<String> {
        let mut argv = Vec::new();
        argv.push(self.bwrap_executable.clone());
        argv.extend(
            [
                "--unshare-user",
                "--unshare-pid",
                "--unshare-mount",
                "--unshare-ipc",
                "--unshare-uts",
                "--unshare-net",
            ]
            .into_iter()
            .map(str::to_string),
        );
        for mount in &self.mounts {
            match mount.kind {
                StoredKind::ReadOnly => {
                    argv.push("--ro-bind".to_string());
                    if let Some(source) = &mount.source {
                        argv.push(source.clone());
                    }
                    argv.push(mount.target.clone());
                }
                StoredKind::Tmpfs => {
                    argv.push("--tmpfs".to_string());
                    argv.push(mount.target.clone());
                }
                StoredKind::FreshDevpts => {
                    argv.push("--fresh-devpts".to_string());
                    argv.push(mount.target.clone());
                }
                StoredKind::Proc => {
                    argv.push("--proc".to_string());
                    argv.push(mount.target.clone());
                }
            }
        }
        argv.push("--".to_string());
        argv.push(self.child.program().to_string());
        argv.extend(self.child.arguments().iter().cloned());
        argv
    }

    /// Syscall filter the plan requires and does not install.
    pub fn syscall_filter(&self) -> SyscallFilter {
        SyscallFilter::SeccompRequired
    }

    /// Landlock policy the plan requires and does not install.
    pub fn filesystem_policy(&self) -> FilesystemPolicy {
        FilesystemPolicy::LandlockAbiAtLeast6
    }
}

/// Why a bubblewrap plan was rejected. Text does not include host paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BubblewrapPlanError {
    /// A mount named the Chrome profile or a path inside it.
    ChromeProfileIncluded,
    /// A devpts mount used the host instance.
    HostDevpts,
    /// A namespace would be shared with the host.
    NamespaceSharedWithHost,
    /// The executable plan was rejected.
    Command(CommandPlanError),
    /// A mount path was rejected.
    Mount(CommandPlanError),
    /// The profile path could not be checked.
    Profile(ChildPlanError),
    /// A bind mount had no source, or a non-bind mount had one.
    MountShape,
}

impl fmt::Display for BubblewrapPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ChromeProfileIncluded => {
                formatter.write_str("chrome profile excluded from mount plan")
            }
            Self::HostDevpts => formatter.write_str("host devpts is not a fresh instance"),
            Self::NamespaceSharedWithHost => formatter.write_str("namespace shared with host"),
            Self::Command(error) => write!(formatter, "bubblewrap command rejected: {error}"),
            Self::Mount(error) => write!(formatter, "mount path rejected: {error}"),
            Self::Profile(error) => write!(formatter, "profile boundary rejected: {error}"),
            Self::MountShape => formatter.write_str("mount shape rejected"),
        }
    }
}

impl std::error::Error for BubblewrapPlanError {}

/// Why this crate will not spawn a contained process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LinuxSpawnBoundary {
    /// Process ownership cannot be made kill-on-close before exec with the linked dependencies.
    ProcessOwnershipIncomplete,
}

impl fmt::Display for LinuxSpawnBoundary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProcessOwnershipIncomplete => formatter.write_str(
                "linux containment spawn refused: process ownership incomplete; bwrap is not executed",
            ),
        }
    }
}

impl std::error::Error for LinuxSpawnBoundary {}

/// The only spawn result this crate can return. It does not look at a plan and does not exec.
pub fn contained_spawn_boundary() -> LinuxSpawnBoundary {
    LinuxSpawnBoundary::ProcessOwnershipIncomplete
}

/// Validate a bubblewrap plan. The Chrome profile is excluded. No process is started.
pub fn try_bubblewrap_plan(draft: BubblewrapDraft) -> Result<BubblewrapPlan, BubblewrapPlanError> {
    if !namespaces_unshared(draft.namespaces) {
        return Err(BubblewrapPlanError::NamespaceSharedWithHost);
    }
    let child_args: Vec<&str> = draft.child_args.iter().map(String::as_str).collect();
    let child = try_command_plan(PlatformKind::Linux, &draft.child_executable, &child_args)
        .map_err(BubblewrapPlanError::Command)?;
    let bwrap = try_command_plan(PlatformKind::Linux, &draft.bwrap_executable, &[])
        .map_err(BubblewrapPlanError::Command)?;
    let mounts = draft
        .mounts
        .iter()
        .map(|mount| store_mount(mount, &draft.chrome_profile))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(BubblewrapPlan {
        bwrap_executable: bwrap.program().to_string(),
        child,
        mounts,
    })
}

fn namespaces_unshared(namespaces: NamespaceDraft) -> bool {
    matches!(
        (
            namespaces.user,
            namespaces.pid,
            namespaces.mount,
            namespaces.net,
            namespaces.ipc,
            namespaces.uts,
        ),
        (
            NamespaceMode::Unshare,
            NamespaceMode::Unshare,
            NamespaceMode::Unshare,
            NamespaceMode::Unshare,
            NamespaceMode::Unshare,
            NamespaceMode::Unshare,
        )
    )
}

fn store_mount(mount: &MountDraft, profile: &str) -> Result<StoredMount, BubblewrapPlanError> {
    let kind = match mount.kind {
        MountDraftKind::Devpts {
            freshness: DevptsFreshness::HostInstance,
        } => return Err(BubblewrapPlanError::HostDevpts),
        MountDraftKind::Devpts {
            freshness: DevptsFreshness::Fresh,
        } => StoredKind::FreshDevpts,
        MountDraftKind::ReadOnly => StoredKind::ReadOnly,
        MountDraftKind::Tmpfs => StoredKind::Tmpfs,
        MountDraftKind::Proc => StoredKind::Proc,
    };
    let needs_source = matches!(kind, StoredKind::ReadOnly);
    if needs_source != mount.source.is_some() {
        return Err(BubblewrapPlanError::MountShape);
    }
    reject_profile_path(&mount.target, profile)?;
    if let Some(source) = &mount.source {
        reject_profile_path(source, profile)?;
        try_command_plan(PlatformKind::Linux, source, &[]).map_err(BubblewrapPlanError::Mount)?;
    }
    try_command_plan(PlatformKind::Linux, &mount.target, &[])
        .map_err(BubblewrapPlanError::Mount)?;
    Ok(StoredMount {
        kind,
        source: mount.source.clone(),
        target: mount.target.clone(),
    })
}

fn reject_profile_path(path: &str, profile: &str) -> Result<(), BubblewrapPlanError> {
    match path_lies_in_chrome_profile(PlatformKind::Linux, path, profile) {
        Ok(true) => Err(BubblewrapPlanError::ChromeProfileIncluded),
        Ok(false) => Ok(()),
        Err(ChildPlanError::ChromeProfileIncluded) => {
            Err(BubblewrapPlanError::ChromeProfileIncluded)
        }
        Err(error) => Err(BubblewrapPlanError::Profile(error)),
    }
}
