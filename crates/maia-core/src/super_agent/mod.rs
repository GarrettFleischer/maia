//! Super Agent router session, task envelope, and lifecycle contracts.

mod child;
mod completion;
mod envelope;
mod memory;
mod phase;
mod route;
mod sidebar;
mod types;

pub use crate::agents::{CommandId, HumanRequestId, ThreadId};
pub use crate::brain::{ClaimId, EpisodeId, FactId};
pub use child::{execution_tools, narrow_child};
pub use completion::admit_completion;
pub use envelope::{recall_query_text, seal_envelope};
pub use memory::advisory_items;
pub use phase::reduce_phase;
pub use route::{admit_route, authorize_control, host_ask_user};
pub use sidebar::{place_sidebar, reduce_completion_view};
pub use types::*;
