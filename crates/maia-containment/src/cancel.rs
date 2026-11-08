//! Owned process-tree cancellation plans and outcome classification.

use std::fmt;

/// Why the daemon is cancelling contained work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CancellationReason {
    /// The sandbox no longer meets the admission contract.
    ContainmentLost,
    /// The owner left `Unrestricted` while unsandboxed work was running.
    LeftUnrestricted,
    /// Global stop.
    StopAll,
    /// Owner stop of one thread.
    OwnerStop,
}

/// Whether external side effects were ruled out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExternalEffects {
    /// The daemon can show the action had no external effect.
    Disproved,
    /// An external effect cannot be ruled out.
    CannotDisprove,
}

/// What the owner knows about the process tree after a cancel attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProcessTreeDisposition {
    /// The owned tree was killed.
    Killed,
    /// The tree had already exited before cancellation.
    AlreadyExited,
    /// No kill-on-close owner was held.
    NotOwned,
    /// The kill was attempted and failed.
    KillFailed,
}

/// Inputs to [`classify_cancellation`]. No clock and no process handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CancellationInput {
    /// Why cancellation was requested.
    pub reason: CancellationReason,
    /// External-effect knowledge.
    pub external_effects: ExternalEffects,
    /// Process-tree result.
    pub tree: ProcessTreeDisposition,
}

/// Outcome recorded for the cancelled action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RecordedOutcome {
    /// The tree stopped and external effects were disproved.
    ContainedStop,
    /// External effects cannot be disproved.
    UnknownOutcome,
}

/// What the thread should do after cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThreadFollowUp {
    /// A person must decide before the thread continues.
    NeedsHuman,
    /// The action stopped with a known outcome.
    Stopped,
}

/// Classification of one cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CancellationClassification {
    /// Audit outcome.
    pub outcome: RecordedOutcome,
    /// Thread follow-up.
    pub thread: ThreadFollowUp,
}

/// Identifier of one owned tree. The platform adapter maps it to a job or cgroup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProcessTreeId(pub u64);

/// Windows job ownership evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum JobOwnership {
    /// Kill-on-close is set and the process was assigned before resume.
    KillOnCloseAndAssignedBeforeResume,
    /// The job does not kill its tree when the owner handle closes.
    MissingKillOnClose,
    /// The process was placed in the job only after it was allowed to run.
    AssignedAfterResume,
}

/// Linux cgroup ownership evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CgroupOwnership {
    /// cgroup v2 with a kill controller held by the daemon.
    V2WithKill,
    /// Not cgroup v2.
    NotV2,
    /// cgroup v2 without a kill controller.
    MissingKill,
}

/// Who can kill the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OwnershipEvidence {
    /// Windows Job Object evidence.
    WindowsJob(JobOwnership),
    /// Linux cgroup evidence.
    LinuxCgroup(CgroupOwnership),
    /// No owner.
    Unowned,
}

/// Pure cancellation plan. It does not signal a process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TreeCancelPlan {
    /// The tree is owned and should be killed.
    KillOwned {
        /// Tree to kill.
        tree: ProcessTreeId,
        /// Why.
        reason: CancellationReason,
    },
    /// There is no safe owner, so a kill must not be reported as contained.
    NotOwned {
        /// Tree that was not owned.
        tree: ProcessTreeId,
    },
}

impl fmt::Display for TreeCancelPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::KillOwned { tree, reason } => {
                write!(formatter, "kill owned tree {} for {reason:?}", tree.0)
            }
            Self::NotOwned { tree } => write!(formatter, "tree {} is not owned", tree.0),
        }
    }
}

/// Classify a cancellation. Uncertain kills and undiproved effects are `UnknownOutcome`.
pub fn classify_cancellation(input: CancellationInput) -> CancellationClassification {
    let kill_uncertain = matches!(
        input.tree,
        ProcessTreeDisposition::KillFailed | ProcessTreeDisposition::NotOwned
    );
    let outcome = if input.external_effects == ExternalEffects::CannotDisprove || kill_uncertain {
        RecordedOutcome::UnknownOutcome
    } else {
        RecordedOutcome::ContainedStop
    };
    let thread = if input.reason == CancellationReason::ContainmentLost
        || outcome == RecordedOutcome::UnknownOutcome
    {
        ThreadFollowUp::NeedsHuman
    } else {
        ThreadFollowUp::Stopped
    };
    CancellationClassification { outcome, thread }
}

/// Plan a tree kill only when ownership evidence is complete.
pub fn plan_tree_cancellation(
    owner: OwnershipEvidence,
    tree: ProcessTreeId,
    reason: CancellationReason,
) -> TreeCancelPlan {
    let owned = matches!(
        owner,
        OwnershipEvidence::WindowsJob(JobOwnership::KillOnCloseAndAssignedBeforeResume)
            | OwnershipEvidence::LinuxCgroup(CgroupOwnership::V2WithKill)
    );
    if owned {
        TreeCancelPlan::KillOwned { tree, reason }
    } else {
        TreeCancelPlan::NotOwned { tree }
    }
}
