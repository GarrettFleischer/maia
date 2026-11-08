//! Vault note and index domain types.

use crate::vault::error::FrontmatterIssue;
use crate::vault::error::VaultError;

/// Closed set of note categories in the vault layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteKind {
    /// Root navigation note (`agents.md`, `index.md` at vault root).
    Root,
    /// Agent listing folder index.
    Agents,
    /// Single agent folder index or profile-adjacent notes.
    Agent,
    /// Human-authored `personality.md`; never dream-generated.
    Personality,
    /// Folder index listing child entities.
    Entities,
    /// Entity page with generated and human regions.
    Entity,
}

impl NoteKind {
    pub(crate) fn parse(raw: &str) -> Result<Self, FrontmatterIssue> {
        match raw {
            "root" => Ok(Self::Root),
            "agents" => Ok(Self::Agents),
            "agent" => Ok(Self::Agent),
            "personality" => Ok(Self::Personality),
            "entities" => Ok(Self::Entities),
            "entity" => Ok(Self::Entity),
            _ => Err(FrontmatterIssue::InvalidValue),
        }
    }
}

/// Parsed YAML frontmatter for a vault note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteFrontmatter {
    /// Stable identifier unique across the vault.
    pub id: String,
    /// Single-line plain-text summary for indexes and map.
    pub description: String,
    /// Vault-relative wikilink targets without `.md` suffixes.
    pub see: Vec<String>,
    /// Note category.
    pub kind: NoteKind,
}

/// A note split into validated frontmatter and exact post-frontmatter body bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedNote {
    /// Validated metadata.
    pub frontmatter: NoteFrontmatter,
    /// Every byte after the closing frontmatter delimiter.
    pub body: Vec<u8>,
}

/// Child header data used when rendering a folder `index.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteHeader {
    /// Normalized vault-relative link (no `.md` suffix).
    pub link: String,
    /// Plain-text description copied from the child's frontmatter.
    pub description: String,
}

/// One canonical fact row projected into an entity page generated region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityFact {
    /// Stable fact identifier.
    pub id: String,
    /// One-sentence text; neutralized before rendering.
    pub sentence: String,
}

/// Validated vault-relative path using `/` separators.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VaultPath(String);

impl VaultPath {
    /// Parses and normalizes a vault-relative path, rejecting unsafe forms.
    pub fn parse(raw: &str) -> Result<Self, VaultError> {
        crate::vault::path::validate_vault_relative(raw).map(VaultPath)
    }

    /// Borrows the normalized path string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for VaultPath {
    fn as_ref(&self) -> &str {
        &self.0
    }
}
