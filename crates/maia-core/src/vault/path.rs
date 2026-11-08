//! Vault-relative path validation (pure; no filesystem access).

use crate::vault::error::VaultError;

const NUL: char = '\0';

/// Validates and normalizes a vault-relative path.
pub fn validate_vault_relative(raw: &str) -> Result<String, VaultError> {
    if raw.is_empty() {
        return Err(VaultError::InvalidPath);
    }
    if raw.contains(NUL) {
        return Err(VaultError::InvalidPath);
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(VaultError::InvalidPath);
    }
    if looks_like_drive_prefix(raw) {
        return Err(VaultError::InvalidPath);
    }
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return Err(VaultError::InvalidPath);
    }

    let mut normalized = String::new();
    for component in raw.split('/') {
        if component.is_empty() {
            return Err(VaultError::InvalidPath);
        }
        if component == "." || component == ".." {
            return Err(VaultError::InvalidPath);
        }
        if component.contains('\\') || invalid_windows_component(component) {
            return Err(VaultError::InvalidPath);
        }
        if !normalized.is_empty() {
            normalized.push('/');
        }
        normalized.push_str(component);
    }

    Ok(normalized)
}

fn looks_like_drive_prefix(raw: &str) -> bool {
    let mut chars = raw.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    matches!(chars.next(), Some(':'))
}

fn invalid_windows_component(component: &str) -> bool {
    if component.contains(':') || component.ends_with('.') || component.ends_with(' ') {
        return true;
    }
    let stem = component
        .split_once('.')
        .map_or(component, |(before_dot, _)| before_dot);
    let upper = stem.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) || matches!(
        upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT")),
        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
    )
}

#[cfg(test)]
mod tests {
    use super::validate_vault_relative;
    use crate::vault::error::VaultError;

    #[test]
    fn accepts_normalized_relative_paths() {
        assert_eq!(
            validate_vault_relative("world/entities/maia").expect("valid"),
            "world/entities/maia"
        );
    }

    #[test]
    fn rejects_traversal_and_absolute_forms() {
        for path in [
            "",
            ".",
            "..",
            "world/../outside",
            "/etc/passwd",
            "C:/outside",
            r"\\server\share",
            "agents/\0hack",
        ] {
            assert_eq!(
                validate_vault_relative(path),
                Err(VaultError::InvalidPath),
                "path: {path:?}"
            );
        }
    }
}
