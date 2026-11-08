#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]

//! Linux bubblewrap, seccomp, Landlock, and namespace containment.
//!
//! Probe interpretation and launch plans are pure. This crate does not execute `bwrap`.
//! `std::process` cannot install seccomp or Landlock, enter user namespaces, or own a cgroup
//! kill controller before the child image runs, and no `nix` or `rustix` dependency is linked.

mod descriptor;
mod plan;
mod probe;

pub use descriptor::{linux_event_sources, pty_plan, secret_service_descriptor};
pub use plan::{
    BubblewrapDraft, BubblewrapPlan, BubblewrapPlanError, DevptsFreshness, FilesystemPolicy,
    LinuxSpawnBoundary, MountDraft, MountDraftKind, NamespaceDraft, NamespaceMode, SyscallFilter,
    contained_spawn_boundary, try_bubblewrap_plan,
};
pub use probe::{LinuxProbeInput, SecretServiceApi, interpret_linux_probe};
