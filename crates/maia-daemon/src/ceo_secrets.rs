//! CEO-supplied secrets for tools (never logged or put in model context).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use crate::mcp_settings::McpApiError;
use crate::mcp_settings::McpSecretStore;

const NAMES_FILE: &str = "ceo_secret_names.json";
const REF_PREFIX: &str = "ceo-secret:";

/// Skin that persists CEO secret names on disk and values in [`McpSecretStore`].
pub struct CeoSecretSkin {
    names_path: PathBuf,
    store: Arc<dyn McpSecretStore>,
    /// In-process mirror for shell env injection (values never logged).
    live: Mutex<BTreeMap<String, String>>,
}

impl CeoSecretSkin {
    /// Opens beside the database path (`data/ceo_secret_names.json`).
    ///
    /// Values live in a dedicated in-process store (never MCP headers / chat).
    /// Names are listed on disk so wakes can remind which secrets exist.
    #[must_use]
    pub fn open(database: &Path, _shared: Arc<dyn McpSecretStore>) -> Self {
        let names_path = database
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(NAMES_FILE);
        let skin = Self {
            names_path,
            store: Arc::new(crate::mcp_settings::MemoryMcpSecretStore::new()),
            live: Mutex::new(BTreeMap::new()),
        };
        skin
    }

    /// In-memory store for tests (no disk writes required).
    #[must_use]
    pub fn memory_for_tests() -> Self {
        Self {
            names_path: PathBuf::from("ceo_secret_names.json"),
            store: Arc::new(crate::mcp_settings::MemoryMcpSecretStore::new()),
            live: Mutex::new(BTreeMap::new()),
        }
    }

    /// Stores a secret, updates the name index, and keeps a live env mirror.
    ///
    /// # Errors
    ///
    /// Returns when the name is empty/invalid or the store rejects the write.
    pub fn put(&self, name: &str, value: &str) -> Result<(), McpApiError> {
        let name = maia_core::chat_widgets::sanitize_secret_name(name).ok_or(McpApiError::Secret)?;
        if value.is_empty() {
            return Err(McpApiError::Secret);
        }
        self.store
            .write_secret(&format!("{REF_PREFIX}{name}"), value)?;
        if let Ok(mut live) = self.live.lock() {
            live.insert(name.clone(), value.to_owned());
        }
        let _ = self.persist_names();
        Ok(())
    }

    /// True when a secret with this name is stored.
    #[must_use]
    pub fn has(&self, name: &str) -> bool {
        self.live
            .lock()
            .map(|live| live.contains_key(name))
            .unwrap_or(false)
    }

    /// Env pairs for worker shells (name, value). Caller must not log values.
    #[must_use]
    pub fn env_pairs(&self) -> Vec<(String, String)> {
        self.live
            .lock()
            .map(|live| live.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    }

    /// Names currently stored (never values).
    #[must_use]
    pub fn names(&self) -> Vec<String> {
        self.live
            .lock()
            .map(|live| live.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn persist_names(&self) -> Result<(), McpApiError> {
        let names = self.names();
        let json = serde_json::to_string(&names).map_err(|_| McpApiError::Secret)?;
        if let Some(parent) = self.names_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&self.names_path, json).map_err(|_| McpApiError::Secret)
    }

    fn reload_from_store(&self) {
        let Ok(bytes) = fs::read(&self.names_path) else {
            return;
        };
        let Ok(names) = serde_json::from_slice::<Vec<String>>(&bytes) else {
            return;
        };
        let Ok(mut live) = self.live.lock() else {
            return;
        };
        for name in names {
            let Ok(Some(value)) = self.store.read_secret(&format!("{REF_PREFIX}{name}")) else {
                continue;
            };
            live.insert(name, value);
        }
    }
}
