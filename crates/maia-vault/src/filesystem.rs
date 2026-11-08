//! Vault filesystem adapter (I/O skin).

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use maia_core::vault::{
    GeneratedVaultUpdate, NoteBody, VaultError, VaultIndexEntry, VaultMap, VaultPath, VaultStore,
    is_personality_note, parse_note,
};

/// Obsidian vault access confined to a canonical root directory.
pub struct VaultFilesystem {
    root: PathBuf,
}

impl VaultFilesystem {
    /// Opens a vault at `root`, which must exist and be a directory.
    pub fn open(root: PathBuf) -> Result<Self, VaultError> {
        let metadata = fs::metadata(&root).map_err(|_| VaultError::Io)?;
        if !metadata.is_dir() {
            return Err(VaultError::NotFound);
        }
        let canonical = fs::canonicalize(&root).map_err(|_| VaultError::Io)?;
        Ok(Self { root: canonical })
    }

    fn candidate_note_file(&self, path: &VaultPath) -> PathBuf {
        let mut candidate = self.root.clone();
        for component in path.as_str().split('/') {
            candidate.push(component);
        }
        if candidate.extension().is_none() {
            candidate.set_extension("md");
        }
        candidate
    }

    fn candidate_folder(&self, path: &VaultPath) -> PathBuf {
        let mut candidate = self.root.clone();
        for component in path.as_str().split('/') {
            candidate.push(component);
        }
        candidate
    }

    fn resolve_note_file(&self, path: &VaultPath) -> Result<PathBuf, VaultError> {
        self.confine(&self.candidate_note_file(path))
    }

    fn resolve_folder(&self, path: &VaultPath) -> Result<PathBuf, VaultError> {
        self.confine(&self.candidate_folder(path))
    }

    fn resolve_generated_target(&self, path: &VaultPath) -> Result<PathBuf, VaultError> {
        let candidate = self.candidate_note_file(path);
        if candidate.exists() {
            return self.confine(&candidate);
        }
        let parent = candidate.parent().ok_or(VaultError::InvalidPath)?;
        let confined_parent = self.confine(parent)?;
        let file_name = candidate.file_name().ok_or(VaultError::InvalidPath)?;
        Ok(confined_parent.join(file_name))
    }

    fn confine(&self, candidate: &Path) -> Result<PathBuf, VaultError> {
        let canonical = fs::canonicalize(candidate).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound,
            _ => VaultError::Io,
        })?;
        if !canonical.starts_with(&self.root) {
            return Err(VaultError::OutsideVault);
        }
        Ok(canonical)
    }

    fn vault_relative(&self, absolute: &Path) -> Result<String, VaultError> {
        let relative = absolute
            .strip_prefix(&self.root)
            .map_err(|_| VaultError::OutsideVault)?;
        link_from_relative(relative)
    }

    fn read_note_bytes(&self, path: &VaultPath) -> Result<Vec<u8>, VaultError> {
        let file_path = self.resolve_note_file(path)?;
        let metadata = fs::metadata(&file_path).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound,
            _ => VaultError::Io,
        })?;
        if metadata.is_dir() {
            return Err(VaultError::InvalidPath);
        }
        fs::read(&file_path).map_err(|_| VaultError::Io)
    }

    /// Synchronous `map` for deterministic adapter tests and skins that block locally.
    pub fn map_sync(&self, path: Option<&VaultPath>) -> Result<VaultMap, VaultError> {
        match path {
            None => self.map_index(None, self.root.join("index.md")),
            Some(requested) => self.map_some(requested),
        }
    }

    fn map_some(&self, requested: &VaultPath) -> Result<VaultMap, VaultError> {
        let file_path = self.candidate_note_file(requested);
        let folder_path = self.candidate_folder(requested);
        let file_is_file = file_path.is_file();
        let dir_is_dir = folder_path.is_dir();
        if file_is_file && dir_is_dir {
            return Err(VaultError::AmbiguousPath);
        }
        if file_is_file {
            let confined = self.confine(&file_path)?;
            let bytes = fs::read(&confined).map_err(|_| VaultError::Io)?;
            let note = parse_note(&bytes)?;
            return Ok(VaultMap::NoteHeader {
                path: requested.clone(),
                frontmatter: note.frontmatter,
            });
        }
        if dir_is_dir {
            let folder = self.resolve_folder(requested)?;
            return self.map_index(Some(requested.clone()), folder.join("index.md"));
        }
        Err(VaultError::NotFound)
    }

    fn map_index(
        &self,
        path: Option<VaultPath>,
        index_path: PathBuf,
    ) -> Result<VaultMap, VaultError> {
        let bytes = fs::read(&index_path).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound,
            _ => VaultError::Io,
        })?;
        let note = parse_note(&bytes)?;
        let folder = index_path.parent().ok_or(VaultError::Io)?.to_path_buf();
        let mut seen_ids = BTreeSet::new();
        if !seen_ids.insert(note.frontmatter.id.clone()) {
            return Err(VaultError::DuplicateId);
        }
        let entries = self.index_entries(&folder, &mut seen_ids)?;
        Ok(VaultMap::Index {
            path,
            frontmatter: note.frontmatter,
            entries,
        })
    }

    fn index_entries(
        &self,
        folder: &Path,
        seen_ids: &mut BTreeSet<String>,
    ) -> Result<Vec<VaultIndexEntry>, VaultError> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(folder).map_err(|_| VaultError::Io)? {
            let entry = entry.map_err(|_| VaultError::Io)?;
            let file_type = entry.file_type().map_err(|_| VaultError::Io)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "index.md" {
                continue;
            }
            if file_type.is_dir() {
                let index = entry.path().join("index.md");
                if !index.is_file() {
                    continue;
                }
                let canonical_folder =
                    fs::canonicalize(entry.path()).map_err(|_| VaultError::Io)?;
                let link = self.vault_relative(&canonical_folder)?;
                let bytes = fs::read(index).map_err(|_| VaultError::Io)?;
                let note = parse_note(&bytes)?;
                if !seen_ids.insert(note.frontmatter.id.clone()) {
                    return Err(VaultError::DuplicateId);
                }
                entries.push(VaultIndexEntry {
                    link,
                    description: note.frontmatter.description,
                });
            } else if name.ends_with(".md") {
                let canonical = fs::canonicalize(entry.path()).map_err(|_| VaultError::Io)?;
                let link = self.vault_relative(&canonical.with_extension(""))?;
                let bytes = fs::read(entry.path()).map_err(|_| VaultError::Io)?;
                let note = parse_note(&bytes)?;
                if !seen_ids.insert(note.frontmatter.id.clone()) {
                    return Err(VaultError::DuplicateId);
                }
                entries.push(VaultIndexEntry {
                    link,
                    description: note.frontmatter.description,
                });
            }
        }
        entries.sort_by(|left, right| left.link.cmp(&right.link));
        Ok(entries)
    }

    /// Synchronous `read` for deterministic adapter tests.
    pub fn read_sync(&self, path: &VaultPath) -> Result<NoteBody, VaultError> {
        let bytes = self.read_note_bytes(path)?;
        let note = parse_note(&bytes)?;
        Ok(NoteBody(note.body))
    }

    /// Synchronous `apply_generated` for deterministic adapter tests.
    pub fn apply_generated_sync(&self, update: &GeneratedVaultUpdate) -> Result<(), VaultError> {
        if is_personality_note(&update.path) {
            return Err(VaultError::InvalidPath);
        }
        let target = self.resolve_generated_target(&update.path)?;
        let current = match self.read_note_bytes(&update.path) {
            Ok(bytes) => bytes,
            Err(VaultError::NotFound) => Vec::new(),
            Err(error) => return Err(error),
        };
        if current != update.expected_before {
            return Err(VaultError::ConcurrentEdit);
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| VaultError::Io)?;
        }
        let temp = target.with_extension("md.maia-tmp");
        {
            let mut file = fs::File::create(&temp).map_err(|_| VaultError::Io)?;
            file.write_all(&update.bytes).map_err(|_| VaultError::Io)?;
            file.sync_all().map_err(|_| VaultError::Io)?;
        }
        match fs::rename(&temp, &target) {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temp);
                Err(match error.kind() {
                    io::ErrorKind::NotFound => VaultError::NotFound,
                    _ => VaultError::Io,
                })
            }
        }
    }
}

fn link_from_relative(relative: &Path) -> Result<String, VaultError> {
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(VaultError::InvalidPath);
            }
        }
    }
    VaultPath::parse(&parts.join("/")).map(|path| path.as_str().to_owned())
}

impl VaultStore for VaultFilesystem {
    async fn map(&self, path: Option<&VaultPath>) -> Result<VaultMap, VaultError> {
        self.map_sync(path)
    }

    async fn read(&self, path: &VaultPath) -> Result<NoteBody, VaultError> {
        self.read_sync(path)
    }

    async fn apply_generated(&self, update: &GeneratedVaultUpdate) -> Result<(), VaultError> {
        self.apply_generated_sync(update)
    }
}
