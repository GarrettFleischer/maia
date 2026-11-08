use maia_core::vault::{VaultError, VaultPath};

#[test]
fn vault_path_rejects_escape_and_device_forms() {
    for path in [
        "",
        ".",
        "..",
        "world/..",
        "../agents",
        "/absolute",
        r"\windows\path",
        "C:/Windows",
        r"\\server\share\vault",
        "agents/\0note",
        "note/.hidden/../escape",
        "world/entities/note:stream",
        "world/entities/CON",
        "world/entities/lpt1.md",
        "world/entities/trailing.",
        "world/entities/trailing ",
    ] {
        assert_eq!(
            VaultPath::parse(path),
            Err(VaultError::InvalidPath),
            "path: {path:?}"
        );
    }
}

#[test]
fn vault_path_accepts_layout_paths() {
    let cases = [
        "index",
        "agents/scout/index",
        "agents/scout/personality",
        "world/entities/maia",
    ];
    for path in cases {
        VaultPath::parse(path).unwrap_or_else(|_| panic!("valid path rejected: {path}"));
    }
}

#[test]
fn vault_path_allows_single_letter_folder_names() {
    let path = VaultPath::parse("a/note").expect("single-letter folder is relative");
    assert_eq!(path.as_str(), "a/note");
}
