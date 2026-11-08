//! Structured allowlist matching (`13-platform.md` AC-16, AC-22..AC-24).
//!
//! Entries are exact by default. A match is structural equality of typed
//! fields, never a substring. Broadening is a separate explicit input.
//! Lifetimes use the injected clock and daemon generation. `enabled` is not
//! rewritten by a profile change.

use maia_core::agents::{AgentId, ThreadId};
use maia_core::audit::Timestamp;
use maia_core::security::{
    ActionFieldError, AllowlistDraft, AllowlistEntryId, AllowlistError, AllowlistQuery, Broaden,
    BrowserAction, BrowserVerb, CanonicalAllowAction, CapabilityKind, ClientClass,
    DaemonGeneration, EntryStatus, GrantLifetime, MatcherField, OwnerActor, OwnerClientId,
    PathError, PlatformKind, ProfileSelection, SecretName, SecurityProfile, ThreadAction,
    ThreadVerb, WebAction, broaden_allowlist_entry, canonical_absolute_path, exact_allowlist_entry,
    match_allowlist, reduce_security_profile, select_onboarding_profile, with_entry_status,
};

fn owner() -> OwnerClientId {
    OwnerClientId(4)
}

fn draft(
    id: u64,
    capability: CapabilityKind,
    action: CanonicalAllowAction,
    agent: u64,
    lifetime: GrantLifetime,
) -> AllowlistDraft {
    AllowlistDraft {
        id: AllowlistEntryId(id),
        capability,
        action,
        agent: AgentId(agent),
        lifetime,
        created_at: Timestamp(1),
        created_by: owner(),
    }
}

fn query(
    capability: CapabilityKind,
    action: CanonicalAllowAction,
    agent: u64,
    now: i64,
    generation: u64,
) -> AllowlistQuery {
    AllowlistQuery {
        capability,
        action,
        agent: AgentId(agent),
        now: Timestamp(now),
        daemon_generation: DaemonGeneration(generation),
    }
}

fn linux_path(raw: &str) -> maia_core::security::CanonicalAbsolutePath {
    let Ok(path) = canonical_absolute_path(PlatformKind::Linux, raw) else {
        panic!("expected canonical linux path {raw}");
    };
    path
}

fn command(
    path: maia_core::security::CanonicalAbsolutePath,
    args: &[&str],
) -> CanonicalAllowAction {
    CanonicalAllowAction::Command {
        executable: path,
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    }
}

fn web(host: &str, path: &str, query_text: &str, port: u16) -> CanonicalAllowAction {
    let Ok(action) = WebAction::new("https", host, port, path, query_text) else {
        panic!("web action {host}{path}");
    };
    CanonicalAllowAction::Web(action)
}

fn must_entry(draft: AllowlistDraft) -> maia_core::security::AllowlistEntry {
    let Ok(entry) = exact_allowlist_entry(draft) else {
        panic!("exact entry");
    };
    entry
}

#[test]
fn canonical_command_paths_are_os_specific() {
    let windows = canonical_absolute_path(
        PlatformKind::Windows,
        r"C:/Windows/System32/../System32/cmd.exe",
    );
    let windows_verbatim =
        canonical_absolute_path(PlatformKind::Windows, r"\\?\C:\Windows\System32\cmd.exe");
    let windows_case =
        canonical_absolute_path(PlatformKind::Windows, r"c:\windows\system32\CMD.EXE");
    let Ok(windows) = windows else {
        panic!("windows canonical");
    };
    let Ok(windows_verbatim) = windows_verbatim else {
        panic!("verbatim canonical");
    };
    let Ok(windows_case) = windows_case else {
        panic!("case canonical");
    };
    assert_eq!(windows.as_str(), r"C:\WINDOWS\SYSTEM32\CMD.EXE");
    assert_eq!(windows, windows_verbatim);
    assert_eq!(windows, windows_case);
    assert_eq!(windows.platform(), PlatformKind::Windows);

    let linux = linux_path("/usr/bin/../bin//git");
    let linux_dot = linux_path("/usr/./bin/git");
    assert_eq!(linux.as_str(), "/usr/bin/git");
    assert_eq!(linux, linux_dot);
    let linux_case = linux_path("/Usr/bin/git");
    assert_ne!(linux, linux_case);

    let macos = canonical_absolute_path(PlatformKind::MacOs, "/usr/bin/git");
    let Ok(macos) = macos else {
        panic!("macos path");
    };
    assert_eq!(macos.as_str(), "/usr/bin/git");
    assert_ne!(linux, macos);

    let rejected = [
        (PlatformKind::Linux, ""),
        (PlatformKind::Linux, "usr/bin/git"),
        (PlatformKind::Linux, "/../git"),
        (PlatformKind::Linux, "/usr/bin/../../.."),
        (PlatformKind::Linux, "/usr/bin/\0git"),
        (PlatformKind::Linux, "//usr/bin/git"),
        (PlatformKind::Linux, r"C:\Windows\System32\cmd.exe"),
        (PlatformKind::MacOs, "bin/zsh"),
        (PlatformKind::Windows, "cmd.exe"),
        (PlatformKind::Windows, r"\Windows\System32\cmd.exe"),
        (PlatformKind::Windows, r"\\server\share\cmd.exe"),
        (PlatformKind::Windows, r"\\?\UNC\server\share\cmd.exe"),
        (PlatformKind::Windows, r"\\.\C:\Windows\System32\cmd.exe"),
        (PlatformKind::Windows, r"C:\..\cmd.exe"),
        (PlatformKind::Windows, "C:cmd.exe"),
        (PlatformKind::Windows, r"C:\Windows\NUL"),
        (PlatformKind::Windows, r"C:\Windows\System32\cmd.exe:stream"),
        (PlatformKind::Windows, r"C:\Windows\System32\cmd.exe."),
    ];
    for (platform, raw) in rejected {
        assert!(
            matches!(
                canonical_absolute_path(platform, raw),
                Err(PathError::Empty
                    | PathError::InteriorNul
                    | PathError::NotAbsolute
                    | PathError::EscapesRoot
                    | PathError::UnsupportedPrefix
                    | PathError::InvalidComponent)
            ),
            "{platform:?} {raw:?} should be rejected"
        );
    }
}

#[test]
fn exact_matchers_do_not_use_substrings() {
    let git = command(linux_path("/usr/bin/git"), &["status"]);
    let entry = must_entry(draft(
        1,
        CapabilityKind::ConsoleExec,
        git.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    let misses = [
        command(linux_path("/usr/bin/git-lfs"), &["status"]),
        command(linux_path("/usr/bin/git2"), &["status"]),
        command(linux_path("/usr/bin/gi"), &["status"]),
        command(linux_path("/usr/bin/git"), &["status", "--porcelain"]),
        command(linux_path("/usr/bin/git"), &["status --porcelain"]),
        command(linux_path("/usr/bin/git"), &["stat"]),
        command(linux_path("/usr/bin/git"), &["--porcelain", "status"]),
        command(
            canonical_absolute_path(PlatformKind::Windows, r"C:\Windows\System32\git.exe")
                .unwrap_or_else(|_| panic!("windows git")),
            &["status"],
        ),
        command(
            canonical_absolute_path(PlatformKind::MacOs, "/usr/bin/git")
                .unwrap_or_else(|_| panic!("macos git")),
            &["status"],
        ),
    ];
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&entry),
            &query(CapabilityKind::ConsoleExec, git, 5, 10, 1)
        ),
        Some(AllowlistEntryId(1))
    );
    for miss in misses {
        assert_eq!(
            match_allowlist(
                std::slice::from_ref(&entry),
                &query(CapabilityKind::ConsoleExec, miss, 5, 10, 1)
            ),
            None
        );
    }

    let page = web("example.com", "/files", "q=1", 443);
    let web_entry = must_entry(draft(
        2,
        CapabilityKind::WebRead,
        page.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    let web_misses = [
        web("example.com.evil", "/files", "q=1", 443),
        web("notexample.com", "/files", "q=1", 443),
        web("example.co", "/files", "q=1", 443),
        web("example.com", "/files/secret", "q=1", 443),
        web("example.com", "/files2", "q=1", 443),
        web("example.com", "/file", "q=1", 443),
        web("example.com", "/files", "q=1&x=2", 443),
        web("example.com", "/files", "q=1", 80),
    ];
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&web_entry),
            &query(CapabilityKind::WebRead, page, 5, 10, 1)
        ),
        Some(AllowlistEntryId(2))
    );
    for miss in web_misses {
        assert_eq!(
            match_allowlist(
                std::slice::from_ref(&web_entry),
                &query(CapabilityKind::WebRead, miss, 5, 10, 1)
            ),
            None
        );
    }
    let http = WebAction::new("http", "example.com", 443, "/files", "q=1");
    let Ok(http) = http else {
        panic!("http action");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&web_entry),
            &query(
                CapabilityKind::WebRead,
                CanonicalAllowAction::Web(http),
                5,
                10,
                1
            )
        ),
        None
    );

    let notes = CanonicalAllowAction::File {
        path: linux_path("/workspace/notes.txt"),
    };
    let file_entry = must_entry(draft(
        3,
        CapabilityKind::VaultRead,
        notes.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&file_entry),
            &query(CapabilityKind::VaultRead, notes, 5, 10, 1)
        ),
        Some(AllowlistEntryId(3))
    );
    for raw in [
        "/workspace/notes.txt.bak",
        "/workspace/notes.tx",
        "/workspace/notes.txt/extra",
    ] {
        assert_eq!(
            match_allowlist(
                std::slice::from_ref(&file_entry),
                &query(
                    CapabilityKind::VaultRead,
                    CanonicalAllowAction::File {
                        path: linux_path(raw)
                    },
                    5,
                    10,
                    1
                )
            ),
            None
        );
    }
    let Ok(windows_notes) =
        canonical_absolute_path(PlatformKind::Windows, r"C:\workspace\notes.txt")
    else {
        panic!("windows notes");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&file_entry),
            &query(
                CapabilityKind::VaultRead,
                CanonicalAllowAction::File {
                    path: windows_notes
                },
                5,
                10,
                1
            )
        ),
        None
    );

    let Ok(secret) = SecretName::new("openai") else {
        panic!("secret name");
    };
    let secret_action = CanonicalAllowAction::Secret { name: secret };
    let secret_entry = must_entry(draft(
        4,
        CapabilityKind::SecretUse,
        secret_action.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&secret_entry),
            &query(CapabilityKind::SecretUse, secret_action, 5, 10, 1)
        ),
        Some(AllowlistEntryId(4))
    );
    for name in ["openai-test", "my-openai", "open"] {
        let Ok(other) = SecretName::new(name) else {
            panic!("name {name}");
        };
        assert_eq!(
            match_allowlist(
                std::slice::from_ref(&secret_entry),
                &query(
                    CapabilityKind::SecretUse,
                    CanonicalAllowAction::Secret { name: other },
                    5,
                    10,
                    1
                )
            ),
            None
        );
    }

    let Ok(browser) = BrowserAction::new(BrowserVerb::Click, "https", "bank.example", 443, "Pay")
    else {
        panic!("browser");
    };
    let browser_action = CanonicalAllowAction::Browser(browser);
    let browser_entry = must_entry(draft(
        5,
        CapabilityKind::WebCredentialed,
        browser_action.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&browser_entry),
            &query(CapabilityKind::WebCredentialed, browser_action, 5, 10, 1)
        ),
        Some(AllowlistEntryId(5))
    );
    for (host, locator) in [
        ("bank.example.evil", "Pay"),
        ("notbank.example", "Pay"),
        ("bank.example", "Pay now"),
        ("bank.example", "Unpay"),
        ("bank.example", "Pa"),
    ] {
        let Ok(other) = BrowserAction::new(BrowserVerb::Click, "https", host, 443, locator) else {
            panic!("browser {host} {locator}");
        };
        assert_eq!(
            match_allowlist(
                std::slice::from_ref(&browser_entry),
                &query(
                    CapabilityKind::WebCredentialed,
                    CanonicalAllowAction::Browser(other),
                    5,
                    10,
                    1
                )
            ),
            None
        );
    }

    let thread_action = CanonicalAllowAction::Thread(ThreadAction {
        verb: ThreadVerb::Open,
        thread: ThreadId(15),
        peer: AgentId(8),
    });
    let thread_entry = must_entry(draft(
        6,
        CapabilityKind::OpenThread,
        thread_action.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&thread_entry),
            &query(CapabilityKind::OpenThread, thread_action, 5, 10, 1)
        ),
        Some(AllowlistEntryId(6))
    );
    let thread_misses = [
        ThreadAction {
            verb: ThreadVerb::Open,
            thread: ThreadId(16),
            peer: AgentId(8),
        },
        ThreadAction {
            verb: ThreadVerb::Open,
            thread: ThreadId(15),
            peer: AgentId(9),
        },
        ThreadAction {
            verb: ThreadVerb::Post,
            thread: ThreadId(15),
            peer: AgentId(8),
        },
    ];
    for miss in thread_misses {
        assert_eq!(
            match_allowlist(
                std::slice::from_ref(&thread_entry),
                &query(
                    CapabilityKind::OpenThread,
                    CanonicalAllowAction::Thread(miss),
                    5,
                    10,
                    1
                )
            ),
            None
        );
    }
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&thread_entry),
            &query(
                CapabilityKind::PostMessage,
                CanonicalAllowAction::Thread(ThreadAction {
                    verb: ThreadVerb::Post,
                    thread: ThreadId(15),
                    peer: AgentId(8),
                }),
                5,
                10,
                1
            )
        ),
        None
    );
}

#[test]
fn broadening_is_an_explicit_input_and_exact_entries_stay_exact() {
    let narrow = web("example.com", "/files", "q=1", 443);
    let wider_path = web("example.com", "/files/secret", "q=1", 443);
    let other_host = web("other.example", "/files/secret", "q=1", 443);
    let exact = must_entry(draft(
        7,
        CapabilityKind::WebRead,
        narrow.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    let saved = exact.clone();
    let Ok(widened) = broaden_allowlist_entry(exact, Broaden::Field(MatcherField::WebPath)) else {
        panic!("broaden path");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&saved),
            &query(CapabilityKind::WebRead, narrow, 5, 10, 1)
        ),
        Some(AllowlistEntryId(7))
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&saved),
            &query(CapabilityKind::WebRead, wider_path.clone(), 5, 10, 1)
        ),
        None
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&widened),
            &query(CapabilityKind::WebRead, wider_path, 5, 10, 1)
        ),
        Some(AllowlistEntryId(7))
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&widened),
            &query(CapabilityKind::WebRead, other_host.clone(), 5, 10, 1)
        ),
        None
    );
    let Ok(any_host) = broaden_allowlist_entry(widened, Broaden::Field(MatcherField::WebHost))
    else {
        panic!("broaden host");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_host),
            &query(CapabilityKind::WebRead, other_host, 5, 10, 1)
        ),
        Some(AllowlistEntryId(7))
    );
    let other_scheme = WebAction::new("http", "other.example", 443, "/files/secret", "q=1");
    let Ok(other_scheme) = other_scheme else {
        panic!("scheme");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_host),
            &query(
                CapabilityKind::WebRead,
                CanonicalAllowAction::Web(other_scheme),
                5,
                10,
                1
            )
        ),
        None
    );

    let git = command(linux_path("/usr/bin/git"), &["status"]);
    let command_entry = must_entry(draft(
        8,
        CapabilityKind::ConsoleExec,
        git.clone(),
        5,
        GrantLifetime::DaemonLifetime {
            generation: DaemonGeneration(4),
        },
    ));
    assert!(
        broaden_allowlist_entry(command_entry.clone(), Broaden::Field(MatcherField::WebPath))
            .is_err()
    );
    let Ok(any_args) =
        broaden_allowlist_entry(command_entry, Broaden::Field(MatcherField::CommandArgs))
    else {
        panic!("broaden args");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_args),
            &query(
                CapabilityKind::ConsoleExec,
                command(linux_path("/usr/bin/git"), &["status", "--porcelain"]),
                5,
                10,
                4
            )
        ),
        Some(AllowlistEntryId(8))
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_args),
            &query(
                CapabilityKind::ConsoleExec,
                command(linux_path("/usr/bin/git-lfs"), &["status"]),
                5,
                10,
                4
            )
        ),
        None
    );

    let Ok(web_read) = exact_allowlist_entry(draft(
        9,
        CapabilityKind::WebRead,
        web("example.com", "/", "", 443),
        5,
        GrantLifetime::Permanent,
    )) else {
        panic!("web read");
    };
    let Ok(web_write) = broaden_allowlist_entry(
        web_read.clone(),
        Broaden::Capability(CapabilityKind::WebWrite),
    ) else {
        panic!("broaden capability");
    };
    assert!(
        broaden_allowlist_entry(web_read, Broaden::Capability(CapabilityKind::ConsoleExec))
            .is_err()
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&web_write),
            &query(
                CapabilityKind::WebRead,
                web("example.com", "/", "", 443),
                5,
                10,
                1
            )
        ),
        None
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&web_write),
            &query(
                CapabilityKind::WebWrite,
                web("example.com", "/", "", 443),
                5,
                10,
                1
            )
        ),
        Some(AllowlistEntryId(9))
    );

    assert!(matches!(
        exact_allowlist_entry(draft(
            10,
            CapabilityKind::WebRead,
            command(linux_path("/usr/bin/git"), &[]),
            5,
            GrantLifetime::Permanent,
        )),
        Err(AllowlistError::IncompatibleCapability)
    ));
    assert!(matches!(
        SecretName::new(""),
        Err(ActionFieldError::EmptySecretName)
    ));
    assert!(WebAction::new("https", "example.com", 443, "/files/../secret", "q=1").is_err());
    assert!(WebAction::new("https", "", 443, "/", "q=1").is_err());

    let notes = CanonicalAllowAction::File {
        path: linux_path("/workspace/notes.txt"),
    };
    let file_entry = must_entry(draft(
        14,
        CapabilityKind::VaultRead,
        notes,
        5,
        GrantLifetime::Permanent,
    ));
    let Ok(any_file) = broaden_allowlist_entry(file_entry, Broaden::Field(MatcherField::FilePath))
    else {
        panic!("broaden file");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_file),
            &query(
                CapabilityKind::VaultRead,
                CanonicalAllowAction::File {
                    path: linux_path("/workspace/other.txt"),
                },
                5,
                10,
                1
            )
        ),
        Some(AllowlistEntryId(14))
    );
    let Ok(windows_notes) =
        canonical_absolute_path(PlatformKind::Windows, r"C:\workspace\other.txt")
    else {
        panic!("windows file");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_file),
            &query(
                CapabilityKind::VaultRead,
                CanonicalAllowAction::File {
                    path: windows_notes
                },
                5,
                10,
                1
            )
        ),
        None
    );

    let Ok(secret) = SecretName::new("openai") else {
        panic!("secret");
    };
    let secret_entry = must_entry(draft(
        15,
        CapabilityKind::SecretUse,
        CanonicalAllowAction::Secret { name: secret },
        5,
        GrantLifetime::Permanent,
    ));
    let Ok(any_secret) =
        broaden_allowlist_entry(secret_entry, Broaden::Field(MatcherField::SecretName))
    else {
        panic!("broaden secret");
    };
    let Ok(other_secret) = SecretName::new("other") else {
        panic!("other secret");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_secret),
            &query(
                CapabilityKind::SecretUse,
                CanonicalAllowAction::Secret { name: other_secret },
                5,
                10,
                1
            )
        ),
        Some(AllowlistEntryId(15))
    );

    let Ok(browser) = BrowserAction::new(BrowserVerb::Click, "https", "bank.example", 443, "Pay")
    else {
        panic!("browser");
    };
    let browser_entry = must_entry(draft(
        16,
        CapabilityKind::WebCredentialed,
        CanonicalAllowAction::Browser(browser),
        5,
        GrantLifetime::Permanent,
    ));
    let Ok(any_locator) =
        broaden_allowlist_entry(browser_entry, Broaden::Field(MatcherField::BrowserLocator))
    else {
        panic!("broaden locator");
    };
    let Ok(other_locator) =
        BrowserAction::new(BrowserVerb::Click, "https", "bank.example", 443, "Pay now")
    else {
        panic!("locator");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_locator),
            &query(
                CapabilityKind::WebCredentialed,
                CanonicalAllowAction::Browser(other_locator),
                5,
                10,
                1
            )
        ),
        Some(AllowlistEntryId(16))
    );
    let Ok(other_origin) =
        BrowserAction::new(BrowserVerb::Click, "https", "other.example", 443, "Pay now")
    else {
        panic!("origin");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_locator),
            &query(
                CapabilityKind::WebCredentialed,
                CanonicalAllowAction::Browser(other_origin),
                5,
                10,
                1
            )
        ),
        None
    );

    let thread_entry = must_entry(draft(
        17,
        CapabilityKind::OpenThread,
        CanonicalAllowAction::Thread(ThreadAction {
            verb: ThreadVerb::Open,
            thread: ThreadId(15),
            peer: AgentId(8),
        }),
        5,
        GrantLifetime::Permanent,
    ));
    let Ok(any_thread) =
        broaden_allowlist_entry(thread_entry, Broaden::Field(MatcherField::ThreadId))
    else {
        panic!("broaden thread");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_thread),
            &query(
                CapabilityKind::OpenThread,
                CanonicalAllowAction::Thread(ThreadAction {
                    verb: ThreadVerb::Open,
                    thread: ThreadId(99),
                    peer: AgentId(8),
                }),
                5,
                10,
                1
            )
        ),
        Some(AllowlistEntryId(17))
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_thread),
            &query(
                CapabilityKind::OpenThread,
                CanonicalAllowAction::Thread(ThreadAction {
                    verb: ThreadVerb::Open,
                    thread: ThreadId(99),
                    peer: AgentId(3),
                }),
                5,
                10,
                1
            )
        ),
        None
    );
}

#[test]
fn agent_lifetime_and_enabled_state_gate_matches() {
    let git = command(linux_path("/usr/bin/git"), &["status"]);
    let permanent = must_entry(draft(
        11,
        CapabilityKind::ConsoleExec,
        git.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&permanent),
            &query(CapabilityKind::ConsoleExec, git.clone(), 5, 0, 99)
        ),
        Some(AllowlistEntryId(11))
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&permanent),
            &query(CapabilityKind::ConsoleExec, git.clone(), 6, 0, 99)
        ),
        None
    );
    let Ok(any_agent) = broaden_allowlist_entry(permanent.clone(), Broaden::AnyAgent) else {
        panic!("any agent");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&any_agent),
            &query(CapabilityKind::ConsoleExec, git.clone(), 6, 0, 99)
        ),
        Some(AllowlistEntryId(11))
    );
    assert_eq!(permanent.status(), EntryStatus::Enabled);

    let expiring = must_entry(draft(
        12,
        CapabilityKind::ConsoleExec,
        git.clone(),
        5,
        GrantLifetime::ExpiresAt(Timestamp(100)),
    ));
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&expiring),
            &query(CapabilityKind::ConsoleExec, git.clone(), 5, 99, 1)
        ),
        Some(AllowlistEntryId(12))
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&expiring),
            &query(CapabilityKind::ConsoleExec, git.clone(), 5, 100, 1)
        ),
        None
    );
    let Ok(made_permanent) =
        broaden_allowlist_entry(expiring, Broaden::Lifetime(GrantLifetime::Permanent))
    else {
        panic!("lifetime");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&made_permanent),
            &query(CapabilityKind::ConsoleExec, git.clone(), 5, 100, 1)
        ),
        Some(AllowlistEntryId(12))
    );

    let session = must_entry(draft(
        13,
        CapabilityKind::ConsoleExec,
        git.clone(),
        5,
        GrantLifetime::DaemonLifetime {
            generation: DaemonGeneration(4),
        },
    ));
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&session),
            &query(CapabilityKind::ConsoleExec, git.clone(), 5, 5, 4)
        ),
        Some(AllowlistEntryId(13))
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&session),
            &query(CapabilityKind::ConsoleExec, git.clone(), 5, 5, 5)
        ),
        None
    );
    assert_eq!(session.status(), EntryStatus::Enabled);

    let disabled = with_entry_status(session, EntryStatus::Disabled);
    assert_eq!(disabled.status(), EntryStatus::Disabled);
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&disabled),
            &query(CapabilityKind::ConsoleExec, git.clone(), 5, 5, 4)
        ),
        None
    );

    let first = with_entry_status(
        must_entry(draft(
            1,
            CapabilityKind::ConsoleExec,
            git.clone(),
            5,
            GrantLifetime::Permanent,
        )),
        EntryStatus::Disabled,
    );
    let second = must_entry(draft(
        2,
        CapabilityKind::ConsoleExec,
        git.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    assert_eq!(
        match_allowlist(
            &[first, second],
            &query(CapabilityKind::ConsoleExec, git.clone(), 5, 5, 4)
        ),
        Some(AllowlistEntryId(2))
    );
    let earlier = must_entry(draft(
        20,
        CapabilityKind::ConsoleExec,
        git.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    let later = must_entry(draft(
        21,
        CapabilityKind::ConsoleExec,
        git,
        5,
        GrantLifetime::Permanent,
    ));
    assert_eq!(
        match_allowlist(
            &[earlier, later],
            &query(
                CapabilityKind::ConsoleExec,
                command(linux_path("/usr/bin/git"), &["status"]),
                5,
                5,
                4
            )
        ),
        Some(AllowlistEntryId(20))
    );
}

#[test]
fn enabled_entries_persist_independently_of_profile() {
    let git = command(linux_path("/usr/bin/git"), &["status"]);
    let entry = must_entry(draft(
        30,
        CapabilityKind::ConsoleExec,
        git.clone(),
        5,
        GrantLifetime::Permanent,
    ));
    let snapshot = entry.clone();
    let Ok(protected) = select_onboarding_profile(
        ProfileSelection::Protected,
        OwnerActor {
            id: owner(),
            class: ClientClass::DesktopWindow,
        },
        Timestamp(1),
    ) else {
        panic!("protected");
    };
    let Ok(allowlisted) = reduce_security_profile(
        &protected,
        ProfileSelection::Allowlisted,
        OwnerActor {
            id: owner(),
            class: ClientClass::DesktopWindow,
        },
        Timestamp(2),
        &[],
    ) else {
        panic!("allowlisted");
    };
    assert_eq!(allowlisted.settings.profile(), SecurityProfile::Allowlisted);
    assert_eq!(entry, snapshot);
    assert_eq!(entry.status(), EntryStatus::Enabled);
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&entry),
            &query(CapabilityKind::ConsoleExec, git, 5, 2, 1)
        ),
        Some(AllowlistEntryId(30))
    );
}
