//! Obsidian vault parsing, rendering, and path confinement types.

mod error;
mod neutralize;
mod parse;
mod path;
mod port;
mod render;
mod types;

pub use error::FrontmatterIssue;
pub use error::RenderEntityError;
pub use error::VaultError;
pub use neutralize::neutralize_inline_markdown;
pub use parse::parse_note;
pub use port::GeneratedVaultUpdate;
pub use port::NoteBody;
pub use port::VaultIndexEntry;
pub use port::VaultMap;
pub use port::VaultStore;
pub use port::is_personality_note;
pub use render::render_entity_page;
pub use render::render_index;
pub use types::EntityFact;
pub use types::NoteFrontmatter;
pub use types::NoteHeader;
pub use types::NoteKind;
pub use types::ParsedNote;
pub use types::VaultPath;
