//! Sidebar section and completion-view edges for one parent task.

use super::types::{
    CompletionView, CompletionViewError, CompletionViewEvent, PinMark, SidebarSection, TaskPhase,
};

/// Returns the one sidebar section for a parent task.
///
/// [`PinMark::Pinned`] wins for every phase and view. Otherwise
/// `WaitingForUser`, `Blocked`, `Failed`, and `Stopped` are [`SidebarSection::NeedsYou`];
/// `Queued` and `Running` are [`SidebarSection::Working`]; `Completed` stays
/// [`SidebarSection::Completed`] until [`CompletionView::ClosedOnce`], which is
/// [`SidebarSection::Archive`]; `Cancelled` and `Abandoned` are
/// [`SidebarSection::Archive`]. The view is ignored except for `Completed`.
///
/// The result is a section label. This function does not delete records or
/// change phase, pin, or view.
pub fn place_sidebar(phase: &TaskPhase, pin: PinMark, view: &CompletionView) -> SidebarSection {
    match pin {
        PinMark::Pinned => SidebarSection::Pinned,
        PinMark::Unpinned => match phase {
            TaskPhase::WaitingForUser { .. }
            | TaskPhase::Blocked { .. }
            | TaskPhase::Failed { .. }
            | TaskPhase::Stopped { .. } => SidebarSection::NeedsYou,
            TaskPhase::Queued | TaskPhase::Running { .. } => SidebarSection::Working,
            TaskPhase::Completed { .. } => match view {
                CompletionView::Unopened | CompletionView::Open { .. } => SidebarSection::Completed,
                CompletionView::ClosedOnce => SidebarSection::Archive,
            },
            TaskPhase::Cancelled { .. } | TaskPhase::Abandoned { .. } => SidebarSection::Archive,
        },
    }
}

/// Returns the next completion detail view for one host event.
///
/// `Unopened` accepts `Open` and stores that detail id. `Open` accepts only
/// `Close`, which yields `ClosedOnce`. `ClosedOnce` stays `ClosedOnce` for a
/// later `Open` or `Close` and does not store the later detail id.
/// `Unopened` rejects `Close`. A second `Open` while already `Open` is
/// rejected, so the stored detail id is not replaced.
///
/// Rejected edges return [`CompletionViewError::InvalidTransition`] and do not
/// produce a new view. This function does not read a clock, store, or UI.
pub fn reduce_completion_view(
    current: &CompletionView,
    event: &CompletionViewEvent,
) -> Result<CompletionView, CompletionViewError> {
    match (current, event) {
        (CompletionView::Unopened, CompletionViewEvent::Open { detail }) => {
            Ok(CompletionView::Open {
                detail: detail.clone(),
            })
        }
        (CompletionView::Open { .. }, CompletionViewEvent::Close) => Ok(CompletionView::ClosedOnce),
        (CompletionView::ClosedOnce, CompletionViewEvent::Open { .. })
        | (CompletionView::ClosedOnce, CompletionViewEvent::Close) => {
            Ok(CompletionView::ClosedOnce)
        }
        (CompletionView::Unopened, CompletionViewEvent::Close)
        | (CompletionView::Open { .. }, CompletionViewEvent::Open { .. }) => {
            Err(CompletionViewError::InvalidTransition)
        }
    }
}
