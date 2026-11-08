//! Workspace policy contract from `docs/design/08-rust.md` and accepted `13-platform.md`.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

const DESIGN_CRATES: &[&str] = &[
    "maia-core",
    "maia-store",
    "maia-vault",
    "maia-router",
    "maia-embedder",
    "maia-tools",
    "maia-secrets",
    "maia-daemon",
    "maia-containment",
    "maia-windows",
    "maia-linux",
    "maia-macos",
    "maia-win32",
];

const PLATFORM_ADAPTERS: &[&str] = &["maia-windows", "maia-linux", "maia-macos"];

/// `(module name, source path under `crates/maia-core/`).
const IMPLEMENTED_CORE_MODULES: &[(&str, &str)] = &[
    ("vault", "src/vault/mod.rs"),
    ("brain", "src/brain/mod.rs"),
    ("credit", "src/credit/mod.rs"),
    ("agents", "src/agents/mod.rs"),
    ("security", "src/security/mod.rs"),
    ("audit", "src/audit/mod.rs"),
    ("thread_cache", "src/thread_cache/mod.rs"),
    ("dream", "src/dream/mod.rs"),
    ("router", "src/router/mod.rs"),
    ("embedder", "src/embedder/mod.rs"),
    ("super_agent", "src/super_agent/mod.rs"),
];

const EMPTY_CORE_MODULES: &[(&str, &str)] = &[];

const PERMITTED_WORKSPACE_EDGES: &[(&str, &str)] = &[
    ("maia-store", "maia-core"),
    ("maia-vault", "maia-core"),
    ("maia-router", "maia-core"),
    ("maia-embedder", "maia-core"),
    ("maia-tools", "maia-core"),
    ("maia-secrets", "maia-core"),
    ("maia-containment", "maia-core"),
    ("maia-daemon", "maia-core"),
    ("maia-daemon", "maia-store"),
    ("maia-daemon", "maia-vault"),
    ("maia-daemon", "maia-router"),
    ("maia-daemon", "maia-embedder"),
    ("maia-daemon", "maia-tools"),
    ("maia-daemon", "maia-secrets"),
    ("maia-daemon", "maia-containment"),
    ("maia-daemon", "maia-windows"),
    ("maia-daemon", "maia-linux"),
    ("maia-daemon", "maia-macos"),
    ("maia-tools", "maia-windows"),
    ("maia-tools", "maia-linux"),
    ("maia-tools", "maia-macos"),
    ("maia-secrets", "maia-windows"),
    ("maia-secrets", "maia-linux"),
    ("maia-secrets", "maia-macos"),
    ("maia-windows", "maia-containment"),
    ("maia-linux", "maia-containment"),
    ("maia-macos", "maia-containment"),
];

const PLATFORM_CONSUMER_CRATES: &[&str] = &["maia-daemon", "maia-tools", "maia-secrets"];

const AUDITED_UNSAFE_FFI_CRATES: &[&str] =
    &["maia-windows", "maia-linux", "maia-macos", "maia-win32"];

const WORKSPACE_RUST_FLOOR: &str = "1.90";

const SLICE_BCH_WORKSPACE_ALIASES: &[&str] = &[
    "rusqlite",
    "sqlite-vec",
    "tokio",
    "reqwest",
    "serde",
    "serde_json",
    "thiserror",
    "futures-util",
    "candle-core",
    "candle-nn",
    "candle-transformers",
    "safetensors",
    "tokenizers",
    "sha2",
    "windows",
];

const DEFERRED_WORKSPACE_ALIASES: &[&str] = &["axum", "tauri"];

const SLICE_B_STORE_DEPS: &[&str] = &["rusqlite", "sqlite-vec", "tokio"];

const SLICE_C_ROUTER_DEPS: &[&str] = &[
    "reqwest",
    "serde",
    "serde_json",
    "thiserror",
    "futures-util",
];

const SLICE_C_EMBEDDER_DEPS: &[&str] = &[
    "candle-core",
    "candle-nn",
    "candle-transformers",
    "safetensors",
    "tokenizers",
    "sha2",
    "thiserror",
];

const SLICE_H_WINDOWS_DEPS: &[&str] = &["windows"];

const LICENSES_V2_MARKER: &str = "version = 2";

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("workspace root should resolve")
}

fn read_manifest(crate_name: &str) -> String {
    let path = workspace_root()
        .join("crates")
        .join(crate_name)
        .join("Cargo.toml");
    fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "missing manifest for `{crate_name}` at {}: {error}",
            path.display()
        )
    })
}

fn workspace_members(root_toml: &str) -> BTreeSet<String> {
    let mut members = BTreeSet::new();
    let Some(start) = root_toml.find("members = ") else {
        return members;
    };
    let rest = &root_toml[start + "members = ".len()..];
    let Some(open) = rest.find('[') else {
        return members;
    };
    let after_open = &rest[open + 1..];
    let close = after_open.find(']').unwrap_or(after_open.len());
    let body = &after_open[..close];
    for segment in body.split(',') {
        let member = segment.trim().trim_matches('"');
        if member.is_empty() {
            continue;
        }
        let normalized = if member.starts_with("crates/") {
            member.to_owned()
        } else {
            format!("crates/{member}")
        };
        members.insert(normalized);
    }
    members
}

fn maia_dependency_lines(manifest: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut in_deps = false;
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_deps = trimmed == "[dependencies]"
                || (trimmed.starts_with("[target.") && trimmed.ends_with(".dependencies]"));
            continue;
        }
        if !in_deps {
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let name = trimmed.split('=').next().unwrap_or("").trim();
        if name.starts_with("maia-") {
            lines.push(name.to_owned());
        }
    }
    lines
}

fn workspace_maia_edges(crate_name: &str, manifest: &str) -> BTreeSet<(String, String)> {
    maia_dependency_lines(manifest)
        .into_iter()
        .map(|dep| (crate_name.to_owned(), dep))
        .collect()
}

fn direct_crate_dependencies(manifest: &str) -> BTreeSet<String> {
    let mut deps = BTreeSet::new();
    let mut in_deps = false;
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_deps = trimmed == "[dependencies]";
            continue;
        }
        if !in_deps {
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let name = trimmed.split('=').next().unwrap_or("").trim();
        if !name.is_empty() {
            deps.insert(name.to_owned());
        }
    }
    deps
}

fn workspace_dependencies(root_toml: &str) -> BTreeSet<String> {
    let mut deps = BTreeSet::new();
    let mut in_section = false;
    for line in root_toml.lines() {
        let trimmed = line.trim();
        if trimmed == "[workspace.dependencies]" {
            in_section = true;
            continue;
        }
        if in_section {
            if trimmed.starts_with('[') {
                break;
            }
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let name = trimmed.split('=').next().unwrap_or("").trim();
            if !name.is_empty() {
                deps.insert(name.to_owned());
            }
        }
    }
    deps
}

fn maia_core_lib_rs() -> String {
    crate_lib_rs("maia-core")
}

fn declared_public_modules(lib_rs: &str) -> BTreeSet<String> {
    let mut modules = BTreeSet::new();
    for line in lib_rs.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix("pub mod ") {
            let name = name.trim_end_matches(';').trim();
            if !name.is_empty() {
                modules.insert(name.to_owned());
            }
        }
    }
    modules
}

fn crate_lib_rs(crate_name: &str) -> String {
    let path = workspace_root()
        .join("crates")
        .join(crate_name)
        .join("src")
        .join("lib.rs");
    fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "missing lib.rs for `{crate_name}` at {}: {error}",
            path.display()
        )
    })
}

/// Where unsafe code is allowed. This is scope, not a requirement to use unsafe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CrateUnsafeRole {
    /// Must forbid unsafe and must not contain an unsafe item.
    Closed,
    /// May forbid unsafe, or contain unsafe items that each carry a `SAFETY` comment.
    AuditedBoundary,
}

/// Why a crate's source does not match the unsafe boundary in `13-platform.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum UnsafePolicyViolation {
    /// A non-boundary crate omitted `#![forbid(unsafe_code)]`.
    ClosedCrateMissingForbid,
    /// Unsafe appears outside an audited boundary.
    UnsafeOutsideAuditedBoundary {
        /// Source label supplied by the caller.
        file: String,
    },
    /// An audited boundary strengthened with `forbid` still contains unsafe.
    StrengthenedCrateContainsUnsafe {
        /// Source label supplied by the caller.
        file: String,
    },
    /// A boundary that does not forbid unsafe omitted `deny(unsafe_op_in_unsafe_fn)`.
    BoundaryMissingUnsafeOpDeny,
    /// An audited or dormant boundary manifest does not allow the `unsafe_code` lint.
    BoundaryManifestDoesNotAllow,
    /// An unsafe item has no preceding `SAFETY:` comment.
    UnsafeBlockMissingSafetyComment {
        /// Source label supplied by the caller.
        file: String,
    },
}

fn unsafe_role(crate_name: &str) -> CrateUnsafeRole {
    if AUDITED_UNSAFE_FFI_CRATES.contains(&crate_name) || crate_name == "maia-store" {
        CrateUnsafeRole::AuditedBoundary
    } else {
        CrateUnsafeRole::Closed
    }
}

/// Classify unsafe policy from source text. The caller reads files.
fn classify_unsafe_policy(
    role: CrateUnsafeRole,
    lib_rs: &str,
    rust_sources: &[(&str, &str)],
    manifest: &str,
) -> Result<(), UnsafePolicyViolation> {
    let forbids = lib_rs.contains("#![forbid(unsafe_code)]");
    let denies_unsafe_op = lib_rs.contains("#![deny(unsafe_op_in_unsafe_fn)]");
    let manifest_allows =
        manifest.contains("[lints.rust]") && manifest.contains("unsafe_code = \"allow\"");
    let unsafe_file = rust_sources
        .iter()
        .find(|(_, source)| source_contains_unsafe_item(source))
        .map(|(file, _)| (*file).to_owned());
    let unaudited = rust_sources.iter().find(|(_, source)| {
        source_contains_unsafe_item(source) && !unsafe_items_have_safety_comments(source)
    });

    match role {
        CrateUnsafeRole::Closed => {
            if !forbids {
                return Err(UnsafePolicyViolation::ClosedCrateMissingForbid);
            }
            if let Some(file) = unsafe_file {
                return Err(UnsafePolicyViolation::UnsafeOutsideAuditedBoundary { file });
            }
            Ok(())
        }
        CrateUnsafeRole::AuditedBoundary => {
            if !manifest_allows {
                return Err(UnsafePolicyViolation::BoundaryManifestDoesNotAllow);
            }
            if forbids {
                if let Some(file) = unsafe_file {
                    return Err(UnsafePolicyViolation::StrengthenedCrateContainsUnsafe { file });
                }
                return Ok(());
            }
            if !denies_unsafe_op {
                return Err(UnsafePolicyViolation::BoundaryMissingUnsafeOpDeny);
            }
            if let Some((file, _)) = unaudited {
                return Err(UnsafePolicyViolation::UnsafeBlockMissingSafetyComment {
                    file: (*file).to_owned(),
                });
            }
            Ok(())
        }
    }
}

fn source_contains_unsafe_item(source: &str) -> bool {
    source.lines().any(line_has_unsafe_item)
}

fn line_has_unsafe_item(line: &str) -> bool {
    let code = match line.find("//") {
        Some(index) => &line[..index],
        None => line,
    };
    let without_lint_names = code
        .replace("unsafe_op_in_unsafe_fn", "")
        .replace("unsafe_code", "");
    without_lint_names.contains("unsafe")
}

fn unsafe_items_have_safety_comments(source: &str) -> bool {
    let lines: Vec<&str> = source.lines().collect();
    lines.iter().enumerate().all(|(index, line)| {
        !line_has_unsafe_item(line) || preceding_comments_state_safety(&lines, index)
    })
}

fn preceding_comments_state_safety(lines: &[&str], index: usize) -> bool {
    let mut cursor = index;
    while cursor > 0 {
        cursor -= 1;
        let trimmed = lines[cursor].trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("//") {
            if trimmed.contains("SAFETY:") {
                return true;
            }
            continue;
        }
        return false;
    }
    false
}

fn rust_sources(crate_name: &str) -> Vec<(String, String)> {
    let src = workspace_root().join("crates").join(crate_name).join("src");
    let mut files = Vec::new();
    collect_rust_sources(&src, &src, &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

fn collect_rust_sources(
    dir: &std::path::Path,
    src: &std::path::Path,
    files: &mut Vec<(String, String)>,
) {
    let entries = fs::read_dir(dir).unwrap_or_else(|error| {
        panic!("could not read {}: {error}", dir.display());
    });
    for entry in entries {
        let entry =
            entry.unwrap_or_else(|error| panic!("could not read a directory entry: {error}"));
        let path = entry.path();
        if path.is_dir() {
            collect_rust_sources(&path, src, files);
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("rs") {
            continue;
        }
        let relative = path.strip_prefix(src).unwrap_or(path.as_path());
        let label = format!("src/{}", relative.to_string_lossy().replace('\\', "/"));
        let text = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("could not read {}: {error}", path.display());
        });
        files.push((label, text));
    }
}

fn platform_target_dependencies(manifest: &str) -> BTreeSet<String> {
    let mut deps = BTreeSet::new();
    let mut in_target = false;
    for line in manifest.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_target = trimmed.starts_with("[target.") && trimmed.ends_with(".dependencies]");
            continue;
        }
        if !in_target {
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let name = trimmed.split('=').next().unwrap_or("").trim();
        if name.starts_with("maia-") {
            deps.insert(name.to_owned());
        }
    }
    deps
}

#[test]
fn workspace_lists_all_design_crates() {
    let root_toml =
        fs::read_to_string(workspace_root().join("Cargo.toml")).expect("root Cargo.toml");
    let members = workspace_members(&root_toml);
    for crate_name in DESIGN_CRATES {
        let expected = format!("crates/{crate_name}");
        assert!(
            members.contains(&expected),
            "workspace members should include `{expected}`; got {members:?}"
        );
    }
}

#[test]
fn dependency_edges_match_08_rust_and_13_platform() {
    let mut actual = BTreeSet::new();
    for crate_name in DESIGN_CRATES {
        if *crate_name == "maia-core" {
            continue;
        }
        let manifest = read_manifest(crate_name);
        actual.extend(workspace_maia_edges(crate_name, &manifest));
    }

    let permitted: BTreeSet<(String, String)> = PERMITTED_WORKSPACE_EDGES
        .iter()
        .map(|(from, to)| (from.to_string(), to.to_string()))
        .collect();

    assert_eq!(
        actual, permitted,
        "workspace dependency edges must match docs/design/08-rust.md and accepted 13-platform.md"
    );
}

#[test]
fn platform_consumers_depend_on_exactly_one_platform_adapter_per_target() {
    for crate_name in PLATFORM_CONSUMER_CRATES {
        let manifest = read_manifest(crate_name);
        let platform_deps = platform_target_dependencies(&manifest);
        assert_eq!(
            platform_deps,
            BTreeSet::from_iter(PLATFORM_ADAPTERS.iter().map(|name| (*name).to_owned())),
            "{crate_name} must declare all three platform adapters under target-specific dependencies"
        );
    }
}

#[test]
fn maia_win32_has_no_workspace_dependencies() {
    let manifest = read_manifest("maia-win32");
    assert!(
        maia_dependency_lines(&manifest).is_empty(),
        "maia-win32 must not depend on workspace crates during strangler migration"
    );
}

#[test]
fn closed_crates_must_forbid_unsafe_and_boundary_crates_may_strengthen() {
    let closed = classify_unsafe_policy(
        CrateUnsafeRole::Closed,
        "//! domain\n",
        &[("src/lib.rs", "//! domain\n")],
        "[lints]\nworkspace = true\n",
    );
    assert_eq!(closed, Err(UnsafePolicyViolation::ClosedCrateMissingForbid));

    let strengthened = "#![forbid(unsafe_code)]\n";
    assert_eq!(
        classify_unsafe_policy(
            CrateUnsafeRole::Closed,
            strengthened,
            &[("src/lib.rs", strengthened)],
            "[lints]\nworkspace = true\n",
        ),
        Ok(())
    );

    let boundary_forbid = "#![forbid(unsafe_code)]\n#![deny(unsafe_op_in_unsafe_fn)]\n";
    assert_eq!(
        classify_unsafe_policy(
            CrateUnsafeRole::AuditedBoundary,
            boundary_forbid,
            &[("src/lib.rs", boundary_forbid)],
            "[lints.rust]\nunsafe_code = \"allow\"\n",
        ),
        Ok(()),
        "an audited boundary may forbid unsafe until it needs FFI"
    );
}

#[test]
fn audited_boundary_may_contain_unsafe_only_with_safety_comments() {
    let root = "#![deny(unsafe_op_in_unsafe_fn)]\n";
    let audited = "// SAFETY: the handle is exclusively owned.\nunsafe { close_handle(); }\n";
    assert_eq!(
        classify_unsafe_policy(
            CrateUnsafeRole::AuditedBoundary,
            root,
            &[("src/lib.rs", root), ("src/job.rs", audited)],
            "[lints.rust]\nunsafe_code = \"allow\"\n",
        ),
        Ok(())
    );

    let bare = "unsafe { close_handle(); }\n";
    assert_eq!(
        classify_unsafe_policy(
            CrateUnsafeRole::AuditedBoundary,
            root,
            &[("src/lib.rs", root), ("src/job.rs", bare)],
            "[lints.rust]\nunsafe_code = \"allow\"\n",
        ),
        Err(UnsafePolicyViolation::UnsafeBlockMissingSafetyComment {
            file: "src/job.rs".to_owned(),
        })
    );
}

#[test]
fn unsafe_outside_the_audited_boundary_fails() {
    let source = "#![forbid(unsafe_code)]\n// SAFETY: not a boundary.\nunsafe { poke(); }\n";
    assert_eq!(
        classify_unsafe_policy(
            CrateUnsafeRole::Closed,
            source,
            &[("src/lib.rs", source)],
            "[lints]\nworkspace = true\n",
        ),
        Err(UnsafePolicyViolation::UnsafeOutsideAuditedBoundary {
            file: "src/lib.rs".to_owned(),
        })
    );
}

#[test]
fn audited_unsafe_boundary_crates_match_13_platform() {
    for crate_name in DESIGN_CRATES {
        let lib_rs = crate_lib_rs(crate_name);
        let owned = rust_sources(crate_name);
        let sources: Vec<(&str, &str)> = owned
            .iter()
            .map(|(file, text)| (file.as_str(), text.as_str()))
            .collect();
        let manifest = read_manifest(crate_name);
        assert_eq!(
            classify_unsafe_policy(unsafe_role(crate_name), &lib_rs, &sources, &manifest),
            Ok(()),
            "{crate_name} must match the unsafe permission in accepted 13-platform.md"
        );
    }
}

#[test]
fn maia_store_sqlite_vec_site_is_an_active_audited_boundary() {
    assert_eq!(unsafe_role("maia-store"), CrateUnsafeRole::AuditedBoundary);
    let lib_rs = crate_lib_rs("maia-store");
    let owned = rust_sources("maia-store");
    let sources: Vec<(&str, &str)> = owned
        .iter()
        .map(|(file, text)| (file.as_str(), text.as_str()))
        .collect();
    let manifest = read_manifest("maia-store");
    assert!(lib_rs.contains("#![deny(unsafe_code)]"));
    assert!(lib_rs.contains("#![deny(unsafe_op_in_unsafe_fn)]"));
    assert!(!lib_rs.contains("#![forbid(unsafe_code)]"));
    assert_eq!(
        classify_unsafe_policy(
            CrateUnsafeRole::AuditedBoundary,
            &lib_rs,
            &sources,
            &manifest
        ),
        Ok(())
    );
    let allows = sources
        .iter()
        .map(|(_, source)| source.matches("#[allow(unsafe_code)]").count())
        .sum::<usize>();
    assert_eq!(allows, 1);
    let unsafe_lines = sources
        .iter()
        .flat_map(|(file, source)| {
            source
                .lines()
                .filter(|line| line_has_unsafe_item(line))
                .map(move |line| (*file, line))
        })
        .count();
    assert_eq!(unsafe_lines, 1);
}

#[test]
fn compile_only_platform_shells_contain_no_unsafe_blocks() {
    for crate_name in PLATFORM_ADAPTERS {
        let source = crate_lib_rs(crate_name);
        assert!(
            !source.contains("unsafe "),
            "{crate_name} compile-only shell must not contain unsafe blocks"
        );
    }
}

#[test]
fn maia_containment_forbids_unsafe_and_depends_only_on_core() {
    let manifest = read_manifest("maia-containment");
    assert_eq!(
        workspace_maia_edges("maia-containment", &manifest),
        BTreeSet::from([("maia-containment".to_owned(), "maia-core".to_owned())])
    );
    let source = crate_lib_rs("maia-containment");
    assert!(
        source.contains("#![forbid(unsafe_code)]"),
        "maia-containment must forbid unsafe_code"
    );
}

#[test]
fn maia_core_denies_missing_docs() {
    let source = maia_core_lib_rs();
    assert!(
        source.contains("#![deny(missing_docs)]"),
        "maia-core must deny missing_docs on all items"
    );
}

#[test]
fn maia_core_declares_implemented_and_next_boundary_modules() {
    let lib_rs = maia_core_lib_rs();
    let declared = declared_public_modules(&lib_rs);
    let expected: BTreeSet<String> = IMPLEMENTED_CORE_MODULES
        .iter()
        .chain(EMPTY_CORE_MODULES)
        .map(|(name, _)| (*name).to_owned())
        .collect();
    assert_eq!(
        declared, expected,
        "lib.rs must declare exactly the implemented modules and documented next-boundary shells"
    );
}

#[test]
fn maia_core_registered_modules_exist_on_disk() {
    let core_root = workspace_root().join("crates").join("maia-core");
    for (name, rel_path) in IMPLEMENTED_CORE_MODULES.iter().chain(EMPTY_CORE_MODULES) {
        let path = core_root.join(rel_path);
        assert!(
            path.is_file(),
            "expected registered module `{name}` at {}",
            path.display()
        );
    }
}

#[test]
fn maia_core_next_boundary_modules_are_documented_empty_shells() {
    let core_root = workspace_root().join("crates").join("maia-core");
    for (name, rel_path) in EMPTY_CORE_MODULES {
        let path = core_root.join(rel_path);
        let source = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("could not read {}: {error}", path.display());
        });
        assert!(
            source.starts_with("//!"),
            "empty module `{name}` must start with module documentation"
        );
        assert!(
            !source.contains("pub ")
                && !source.contains("mod ")
                && !source.contains("fn ")
                && !source.contains("struct ")
                && !source.contains("enum ")
                && !source.contains("trait "),
            "module `{name}` must remain an empty documented shell"
        );
    }
}

#[test]
fn maia_core_implemented_modules_may_export_public_api() {
    let core_root = workspace_root().join("crates").join("maia-core");
    for (name, rel_path) in IMPLEMENTED_CORE_MODULES {
        let path = core_root.join(rel_path);
        let source = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("could not read {}: {error}", path.display());
        });
        assert!(
            source.contains("pub use "),
            "implemented module `{name}` should own exports in its module registry"
        );
    }
}

#[test]
fn maia_core_lib_rs_does_not_reexport_module_internals() {
    let lib_rs = maia_core_lib_rs();
    assert!(
        !lib_rs.contains("pub use "),
        "lib.rs is a registry only; workers export from their modules"
    );
}

#[test]
fn workspace_rust_floor_matches_accepted_tauri_requirement() {
    let root_toml =
        fs::read_to_string(workspace_root().join("Cargo.toml")).expect("root Cargo.toml");
    assert!(
        root_toml.contains(&format!("rust-version = \"{WORKSPACE_RUST_FLOOR}\"")),
        "workspace rust-version must be {WORKSPACE_RUST_FLOOR} for Tauri 2.12.5"
    );
    let toolchain =
        fs::read_to_string(workspace_root().join("rust-toolchain.toml")).expect("rust-toolchain");
    assert!(
        toolchain.contains(&format!("channel = \"{WORKSPACE_RUST_FLOOR}\"")),
        "rust-toolchain must pin stable {WORKSPACE_RUST_FLOOR}"
    );
}

#[test]
fn slice_bch_workspace_aliases_gate_immediate_adapter_dependencies() {
    let root_toml =
        fs::read_to_string(workspace_root().join("Cargo.toml")).expect("root Cargo.toml");
    let aliases = workspace_dependencies(&root_toml);
    for dep in SLICE_BCH_WORKSPACE_ALIASES {
        assert!(
            aliases.contains(*dep),
            "workspace.dependencies should declare `{dep}` for slices B/C/H"
        );
    }
    for dep in DEFERRED_WORKSPACE_ALIASES {
        assert!(
            !aliases.contains(*dep),
            "workspace.dependencies must not declare deferred slice dependency `{dep}` yet"
        );
    }
}

#[test]
fn slice_b_store_manifest_declares_sqlite_owner_stack() {
    let deps = direct_crate_dependencies(&read_manifest("maia-store"));
    for dep in SLICE_B_STORE_DEPS {
        assert!(
            deps.contains(*dep),
            "maia-store [dependencies] must declare `{dep}` for slice B"
        );
    }
}

#[test]
fn slice_c_router_manifest_declares_http_client_stack() {
    let deps = direct_crate_dependencies(&read_manifest("maia-router"));
    for dep in SLICE_C_ROUTER_DEPS {
        assert!(
            deps.contains(*dep),
            "maia-router [dependencies] must declare `{dep}` for slice C"
        );
    }
}

#[test]
fn slice_c_embedder_manifest_declares_candle_stack() {
    let deps = direct_crate_dependencies(&read_manifest("maia-embedder"));
    for dep in SLICE_C_EMBEDDER_DEPS {
        assert!(
            deps.contains(*dep),
            "maia-embedder [dependencies] must declare `{dep}` for slice C"
        );
    }
}

#[test]
fn slice_h_windows_manifest_declares_windows_crate() {
    let deps = direct_crate_dependencies(&read_manifest("maia-windows"));
    for dep in SLICE_H_WINDOWS_DEPS {
        assert!(
            deps.contains(*dep),
            "maia-windows [dependencies] must declare `{dep}` for slice H"
        );
    }
}

#[test]
fn maia_core_manifest_stays_free_of_serde() {
    let deps = direct_crate_dependencies(&read_manifest("maia-core"));
    assert!(
        !deps.contains("serde") && !deps.contains("serde_json"),
        "maia-core must not depend on serde or serde_json"
    );
}

#[test]
fn root_rustfmt_matches_design() {
    let rustfmt = fs::read_to_string(workspace_root().join("rustfmt.toml")).expect("rustfmt.toml");
    assert!(rustfmt.contains("edition = \"2024\""));
    assert!(rustfmt.contains("max_width = 100"));
}

#[test]
fn workspace_clippy_lints_configured() {
    let root_toml =
        fs::read_to_string(workspace_root().join("Cargo.toml")).expect("root Cargo.toml");
    for lint in [
        "all = \"deny\"",
        "borrowed_box = \"deny\"",
        "unwrap_used = \"deny\"",
        "await_holding_lock = \"deny\"",
    ] {
        assert!(
            root_toml.contains(lint),
            "workspace clippy lint missing: {lint}"
        );
    }
    assert!(
        root_toml.contains("unsafe_code = \"forbid\""),
        "workspace should forbid unsafe by default"
    );
}

#[test]
fn deny_toml_exists_at_workspace_root() {
    let path = workspace_root().join("deny.toml");
    assert!(path.is_file(), "deny.toml should exist at workspace root");
}

#[test]
fn deny_toml_denies_copyleft_licenses_and_allows_common_permissive_licenses() {
    let deny = fs::read_to_string(workspace_root().join("deny.toml")).expect("deny.toml");
    assert!(
        deny.contains(LICENSES_V2_MARKER),
        "deny.toml should use licenses {LICENSES_V2_MARKER} so only allow-listed licenses pass"
    );
    assert!(
        deny.contains("GPL") && deny.contains("BUSL"),
        "deny.toml should document GPL/AGPL/Business-Source denial under the allow list"
    );
    for license in ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"] {
        assert!(
            deny.contains(license),
            "deny.toml should allow permissive license `{license}` for adapter dependencies"
        );
    }
}

#[test]
fn gitignore_ignores_target_directory() {
    let gitignore =
        fs::read_to_string(workspace_root().join(".gitignore")).expect(".gitignore should exist");
    assert!(
        gitignore.lines().any(|line| line.trim() == "/target"),
        ".gitignore should ignore /target"
    );
}
