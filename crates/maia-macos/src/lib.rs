#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(unsafe_op_in_unsafe_fn)]

//! macOS Keychain and lifecycle descriptors.
//!
//! Arbitrary unattended process containment is unavailable. `sandbox-exec` and Endpoint Security
//! are never treated as a pass, and this crate does not invoke them.

mod descriptor;
mod probe;

pub use descriptor::{keychain_descriptor, macos_event_sources, pty_plan};
pub use probe::{DeprecatedTool, MacosProbeInput, MacosProbeReport, interpret_macos_probe};
