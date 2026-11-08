use maia_core::vault::{GeneratedVaultUpdate, VaultError, VaultMap, VaultPath};
use maia_vault::VaultFilesystem;

#[test]
fn map_never_leaks_child_body_sentinel() {
    let temp = std::env::temp_dir().join(format!("maia-vault-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(temp.join("world/entities")).expect("mkdir");
    std::fs::write(
        temp.join("index.md"),
        "---\nid: root_index\ndescription: Root.\nsee: []\nkind: root\n---\n",
    )
    .expect("write root index");
    std::fs::write(
        temp.join("world/entities/index.md"),
        "---\nid: entities_world\ndescription: Shared.\nsee: []\nkind: entities\n---\n",
    )
    .expect("write folder index");
    std::fs::write(
        temp.join("world/entities/secret.md"),
        "---\nid: entity_secret\ndescription: Public.\nsee: []\nkind: entity\n---\nSENTINEL_BODY_SECRET\n",
    )
    .expect("write entity note");

    let vault = VaultFilesystem::open(temp.clone()).expect("open vault");
    let folder = VaultPath::parse("world/entities").expect("path");
    let mapped = vault.map_sync(Some(&folder)).expect("map folder");
    let serialized = format!("{mapped:?}");
    assert!(
        !serialized.contains("SENTINEL_BODY_SECRET"),
        "map leaked child body bytes"
    );
    if let VaultMap::Index { entries, .. } = mapped {
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].link, "world/entities/secret");
        assert_eq!(entries[0].description, "Public.");
    } else {
        panic!("expected index map result");
    }
    let _ = std::fs::remove_dir_all(temp);
}

#[test]
fn map_folder_entries_link_to_the_folder_not_its_index_note() {
    let temp = std::env::temp_dir().join(format!("maia-vault-folder-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(temp.join("agents/scout")).expect("mkdir");
    std::fs::write(
        temp.join("index.md"),
        "---\nid: root_index\ndescription: Root.\nsee: []\nkind: root\n---\n",
    )
    .expect("write root index");
    std::fs::write(
        temp.join("agents/index.md"),
        "---\nid: agents_index\ndescription: Agents.\nsee: []\nkind: agents\n---\n",
    )
    .expect("write agents index");
    std::fs::write(
        temp.join("agents/scout/index.md"),
        "---\nid: agent_scout\ndescription: Scout.\nsee: []\nkind: agent\n---\n",
    )
    .expect("write scout index");

    let vault = VaultFilesystem::open(temp.clone()).expect("open vault");
    let agents = VaultPath::parse("agents").expect("path");
    let mapped = vault.map_sync(Some(&agents)).expect("map agents");
    let VaultMap::Index { entries, .. } = mapped else {
        panic!("expected index map result");
    };
    assert_eq!(entries[0].link, "agents/scout");
    let _ = std::fs::remove_dir_all(temp);
}

#[test]
fn read_returns_exact_post_frontmatter_bytes() {
    let temp = std::env::temp_dir().join(format!("maia-vault-read-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).expect("mkdir");
    let body = b"Line one.\r\nLine two.  \r\n";
    let mut file =
        Vec::from(b"---\nid: entity_x\ndescription: X.\nsee: []\nkind: entity\n---\n" as &[u8]);
    file.extend_from_slice(body);
    std::fs::write(temp.join("note.md"), file).expect("write note");

    let vault = VaultFilesystem::open(temp.clone()).expect("open");
    let path = VaultPath::parse("note").expect("path");
    let read = vault.read_sync(&path).expect("read");
    assert_eq!(read.0, body);
    let _ = std::fs::remove_dir_all(temp);
}

#[test]
fn apply_generated_rejects_personality_targets() {
    let temp = std::env::temp_dir().join(format!("maia-vault-personality-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(temp.join("agents/scout")).expect("mkdir");
    std::fs::write(
        temp.join("agents/scout/personality.md"),
        "---\nid: personality_scout\ndescription: Scout.\nsee: []\nkind: personality\n---\n",
    )
    .expect("write personality");
    let vault = VaultFilesystem::open(temp.clone()).expect("open");
    let path = VaultPath::parse("agents/scout/personality").expect("path");
    let update = GeneratedVaultUpdate {
        path,
        bytes: b"forbidden".to_vec(),
        expected_before:
            b"---\nid: personality_scout\ndescription: Scout.\nsee: []\nkind: personality\n---\n"
                .to_vec(),
    };
    assert_eq!(
        vault.apply_generated_sync(&update),
        Err(VaultError::InvalidPath)
    );
    let _ = std::fs::remove_dir_all(temp);
}

#[test]
fn apply_generated_detects_concurrent_edit() {
    let temp = std::env::temp_dir().join(format!("maia-vault-race-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).expect("mkdir");
    let original =
        b"---\nid: entity_x\ndescription: X.\nsee: []\nkind: entity\n---\nHuman bytes.\n";
    std::fs::write(temp.join("note.md"), original).expect("write note");
    let vault = VaultFilesystem::open(temp.clone()).expect("open");
    let path = VaultPath::parse("note").expect("path");
    let staged = original.to_vec();
    std::fs::write(
        temp.join("note.md"),
        b"---\nid: entity_x\ndescription: X.\nsee: []\nkind: entity\n---\nChanged.\n",
    )
    .expect("simulate concurrent edit");
    let update = GeneratedVaultUpdate {
        path,
        bytes: b"replacement".to_vec(),
        expected_before: staged,
    };
    assert_eq!(
        vault.apply_generated_sync(&update),
        Err(VaultError::ConcurrentEdit)
    );
    let on_disk = std::fs::read(temp.join("note.md")).expect("read back");
    assert!(
        on_disk
            .windows(b"Changed.".len())
            .any(|window| window == b"Changed.")
    );
    let _ = std::fs::remove_dir_all(temp);
}

#[test]
fn apply_generated_creates_a_new_note_when_expected_before_is_empty() {
    let temp = std::env::temp_dir().join(format!("maia-vault-create-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(temp.join("world/entities")).expect("mkdir");
    std::fs::write(
        temp.join("index.md"),
        "---\nid: root_index\ndescription: Root.\nsee: []\nkind: root\n---\n",
    )
    .expect("write root index");
    let bytes = b"---\nid: entity_new\ndescription: New.\nsee: []\nkind: entity\n---\n".to_vec();
    let vault = VaultFilesystem::open(temp.clone()).expect("open");
    let update = GeneratedVaultUpdate {
        path: VaultPath::parse("world/entities/new").expect("path"),
        bytes: bytes.clone(),
        expected_before: Vec::new(),
    };
    vault
        .apply_generated_sync(&update)
        .expect("create generated note");
    assert_eq!(
        std::fs::read(temp.join("world/entities/new.md")).expect("read new note"),
        bytes
    );
    let _ = std::fs::remove_dir_all(temp);
}

#[test]
fn map_duplicate_id_in_folder_returns_duplicate_id_error() {
    let temp = std::env::temp_dir().join(format!("maia-vault-dup-id-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(temp.join("world/entities")).expect("mkdir");
    std::fs::write(
        temp.join("index.md"),
        "---\nid: root_index\ndescription: Root.\nsee: []\nkind: root\n---\n",
    )
    .expect("write root index");
    std::fs::write(
        temp.join("world/entities/index.md"),
        "---\nid: entities_world\ndescription: Shared.\nsee: []\nkind: entities\n---\n",
    )
    .expect("write folder index");
    for name in ["alpha.md", "beta.md"] {
        std::fs::write(
            temp.join(format!("world/entities/{name}")),
            "---\nid: entity_same\ndescription: Dup.\nsee: []\nkind: entity\n---\n",
        )
        .expect("write entity");
    }

    let vault = VaultFilesystem::open(temp.clone()).expect("open");
    let folder = VaultPath::parse("world/entities").expect("path");
    assert_eq!(vault.map_sync(Some(&folder)), Err(VaultError::DuplicateId));
    let _ = std::fs::remove_dir_all(temp);
}

#[test]
fn map_ambiguous_file_and_folder_returns_ambiguous_path() {
    let temp = std::env::temp_dir().join(format!("maia-vault-ambig-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).expect("mkdir");
    std::fs::write(
        temp.join("index.md"),
        "---\nid: root_index\ndescription: Root.\nsee: []\nkind: root\n---\n",
    )
    .expect("write root index");
    std::fs::write(
        temp.join("clash.md"),
        "---\nid: entity_clash_file\ndescription: File.\nsee: []\nkind: entity\n---\n",
    )
    .expect("write file");
    std::fs::create_dir_all(temp.join("clash")).expect("mkdir clash dir");
    std::fs::write(
        temp.join("clash/index.md"),
        "---\nid: entities_clash\ndescription: Folder.\nsee: []\nkind: entities\n---\n",
    )
    .expect("write folder index");

    let vault = VaultFilesystem::open(temp.clone()).expect("open");
    let path = VaultPath::parse("clash").expect("path");
    assert_eq!(vault.map_sync(Some(&path)), Err(VaultError::AmbiguousPath));
    let _ = std::fs::remove_dir_all(temp);
}

#[cfg(unix)]
#[test]
fn vault_symlink_outside_root_returns_outside_vault() {
    use std::os::unix::fs::symlink;

    let temp = std::env::temp_dir().join(format!("maia-vault-symlink-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    let outside = temp.join("outside");
    std::fs::create_dir_all(&outside).expect("mkdir outside");
    std::fs::write(
        outside.join("secret.md"),
        "---\nid: entity_out\ndescription: Outside.\nsee: []\nkind: entity\n---\nSECRET\n",
    )
    .expect("write outside note");
    let vault_root = temp.join("vault");
    std::fs::create_dir_all(&vault_root).expect("mkdir vault");
    std::fs::write(
        vault_root.join("index.md"),
        "---\nid: root_index\ndescription: Root.\nsee: []\nkind: root\n---\n",
    )
    .expect("write index");
    symlink(&outside, vault_root.join("escape")).expect("symlink");

    let vault = VaultFilesystem::open(vault_root).expect("open");
    let path = VaultPath::parse("escape/secret").expect("path");
    assert_eq!(vault.read_sync(&path), Err(VaultError::OutsideVault));
    let _ = std::fs::remove_dir_all(temp);
}

#[cfg(windows)]
#[test]
fn vault_junction_outside_root_is_outside_vault() {
    let temp = std::env::temp_dir().join(format!("maia-vault-junction-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    let outside = temp.join("outside");
    std::fs::create_dir_all(&outside).expect("mkdir outside");
    std::fs::write(
        outside.join("secret.md"),
        "---\nid: entity_out\ndescription: Outside.\nsee: []\nkind: entity\n---\nSECRET\n",
    )
    .expect("write outside note");
    let vault_root = temp.join("vault");
    std::fs::create_dir_all(&vault_root).expect("mkdir vault");
    std::fs::write(
        vault_root.join("index.md"),
        "---\nid: root_index\ndescription: Root.\nsee: []\nkind: root\n---\n",
    )
    .expect("write index");
    let link = vault_root.join("escape");
    let status = std::process::Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &link.to_string_lossy(),
            &outside.to_string_lossy(),
        ])
        .status()
        .expect("mklink status");
    if !status.success() {
        eprintln!(
            "skipping junction test: mklink /J failed (developer mode or elevation may be required)"
        );
        let _ = std::fs::remove_dir_all(temp);
        return;
    }

    let vault = VaultFilesystem::open(vault_root).expect("open");
    let path = VaultPath::parse("escape/secret").expect("path");
    assert_eq!(vault.read_sync(&path), Err(VaultError::OutsideVault));
    let _ = std::fs::remove_dir_all(temp);
}
