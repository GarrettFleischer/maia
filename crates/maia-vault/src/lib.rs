#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Obsidian vault filesystem adapter implementing `VaultStore`.

mod filesystem;

pub use filesystem::VaultFilesystem;
