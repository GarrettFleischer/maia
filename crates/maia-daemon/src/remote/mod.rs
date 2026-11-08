//! Tailscale phone access. Leaves live in `admit`; the file, process, and sockets live here.

mod admit;
mod hub;
mod serve;

pub(crate) use admit::ListenerClass;
pub(crate) use admit::TailnetPeer;
pub(crate) use hub::RemoteHub;
pub(crate) use hub::UnpairActor;
pub(crate) use hub::unix_now;
pub(crate) use serve::code_response;
pub(crate) use serve::desktop_status_response;
pub(crate) use serve::enable_response;
pub(crate) use serve::error_response;
pub(crate) use serve::mark_loopback;
pub(crate) use serve::pair_response;
pub(crate) use serve::phone_status_response;
pub(crate) use serve::session_response;
pub(crate) use serve::supervise;
pub(crate) use serve::tailnet_gate;
pub(crate) use serve::unpair_response;
