//! Vault validation and rendering errors.

/// Why frontmatter failed strict validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontmatterIssue {
    /// A required field (`id`, `description`, `see`, or `kind`) is absent.
    MissingField,
    /// The same top-level key appears more than once.
    DuplicateKey,
    /// A key other than the four allowed fields is present.
    UnknownField,
    /// A field value violates the vault contract.
    InvalidValue,
}

/// Errors returned by vault parsing, path resolution, and rendering entrypoints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    /// Bytes are not valid UTF-8 or start with a BOM.
    InvalidEncoding,
    /// Frontmatter failed structural or semantic validation.
    InvalidFrontmatter(FrontmatterIssue),
    /// A vault-relative path is syntactically invalid.
    InvalidPath,
    /// A path resolves outside the canonical vault root.
    OutsideVault,
    /// No note or folder exists at the resolved path.
    NotFound,
    /// A path could refer to both a file and a folder.
    AmbiguousPath,
    /// The same note `id` appears on more than one file.
    DuplicateId,
    /// Entity region markers are missing, duplicated, or out of order.
    InvalidRegionMarkers,
    /// On-disk bytes changed since staging (concurrent human edit).
    ConcurrentEdit,
    /// Filesystem or permission failure at the adapter boundary.
    Io,
}

/// Entity page rendering failed before any output bytes were produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderEntityError {
    /// Region markers are missing, duplicated, or out of order.
    InvalidRegionMarkers,
}

impl From<RenderEntityError> for VaultError {
    fn from(value: RenderEntityError) -> Self {
        match value {
            RenderEntityError::InvalidRegionMarkers => Self::InvalidRegionMarkers,
        }
    }
}
