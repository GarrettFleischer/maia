//! Lossless allowlist snapshots for a future store. Restore re-validates.
//! Paths in this leaf are lexical; the daemon supplies already-normalized paths.

use maia_core::agents::{AgentId, ThreadId};
use maia_core::audit::Timestamp;
use maia_core::security::{
    ActionFieldError, ActionMatcherSnapshot, AgentScope, AllowlistDraft, AllowlistEntry,
    AllowlistEntryId, AllowlistError, AllowlistQuery, AllowlistSnapshot, Broaden, BrowserAction,
    BrowserMatcherSnapshot, BrowserVerb, CanonicalAllowAction, CapabilityKind, DaemonGeneration,
    EntryStatus, FieldMatch, FileMatcherSnapshot, GrantLifetime, MatcherField, OwnerClientId,
    PlatformKind, SecretMatcherSnapshot, SecretName, ThreadAction, ThreadMatcherSnapshot,
    ThreadVerb, WebAction, WebMatcherSnapshot, WebOriginSnapshot, broaden_allowlist_entry,
    canonical_absolute_path, exact_allowlist_entry, match_allowlist, try_restore_allowlist_entry,
    with_entry_status,
};

fn owner() -> OwnerClientId {
    OwnerClientId(4)
}

fn linux(raw: &str) -> maia_core::security::CanonicalAbsolutePath {
    let Ok(path) = canonical_absolute_path(PlatformKind::Linux, raw) else {
        panic!("lexical path {raw}");
    };
    path
}

fn draft(action: CanonicalAllowAction, capability: CapabilityKind) -> AllowlistDraft {
    AllowlistDraft {
        id: AllowlistEntryId(7),
        capability,
        action,
        agent: AgentId(5),
        lifetime: GrantLifetime::Permanent,
        created_at: Timestamp(3),
        created_by: owner(),
    }
}

fn command_action() -> CanonicalAllowAction {
    CanonicalAllowAction::Command {
        executable: linux("/usr/bin/../bin/git"),
        args: vec!["status".to_owned()],
    }
}

fn must(draft: AllowlistDraft) -> AllowlistEntry {
    let Ok(entry) = exact_allowlist_entry(draft) else {
        panic!("entry");
    };
    entry
}

fn round_trip(entry: &AllowlistEntry) -> AllowlistEntry {
    let snapshot = entry.snapshot();
    let Ok(restored) = try_restore_allowlist_entry(snapshot.clone()) else {
        panic!("restore");
    };
    assert_eq!(restored.snapshot(), snapshot);
    let Ok(again) = AllowlistEntry::try_from(snapshot) else {
        panic!("try_from");
    };
    assert_eq!(again.snapshot(), entry.snapshot());
    restored
}

fn query(capability: CapabilityKind, action: CanonicalAllowAction, agent: u64) -> AllowlistQuery {
    AllowlistQuery {
        capability,
        action,
        agent: AgentId(agent),
        now: Timestamp(10),
        daemon_generation: DaemonGeneration(4),
    }
}

#[test]
fn exact_and_broadened_snapshots_round_trip_every_matcher() {
    let command = must(draft(command_action(), CapabilityKind::ConsoleExec));
    let command_snap = command.snapshot();
    assert_eq!(command_snap.id, AllowlistEntryId(7));
    assert_eq!(command_snap.agent, AgentScope::Only(AgentId(5)));
    assert_eq!(command_snap.status, EntryStatus::Enabled);
    match &command_snap.matcher {
        ActionMatcherSnapshot::Command(matcher) => {
            assert_eq!(matcher.platform, PlatformKind::Linux);
            match &matcher.executable {
                FieldMatch::Exact(path) => assert_eq!(path.as_str(), "/usr/bin/git"),
                FieldMatch::Any => panic!("exact executable"),
            }
            match &matcher.args {
                FieldMatch::Exact(args) => assert_eq!(args.as_slice(), ["status"]),
                FieldMatch::Any => panic!("exact args"),
            }
        }
        _ => panic!("command matcher"),
    }
    let restored = round_trip(&command);
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&restored),
            &query(CapabilityKind::ConsoleExec, command_action(), 5)
        ),
        Some(AllowlistEntryId(7))
    );

    let Ok(any_args) = broaden_allowlist_entry(command, Broaden::Field(MatcherField::CommandArgs))
    else {
        panic!("args");
    };
    let Ok(any_agent) = broaden_allowlist_entry(any_args, Broaden::AnyAgent) else {
        panic!("agent");
    };
    let broadened = with_entry_status(any_agent, EntryStatus::Disabled);
    let snap = broadened.snapshot();
    assert_eq!(snap.agent, AgentScope::Any);
    assert_eq!(snap.status, EntryStatus::Disabled);
    match &snap.matcher {
        ActionMatcherSnapshot::Command(matcher) => {
            assert!(matches!(matcher.args, FieldMatch::Any));
            assert!(matches!(matcher.executable, FieldMatch::Exact(_)));
        }
        _ => panic!("command"),
    }
    let restored = round_trip(&broadened);
    assert_eq!(restored.status(), EntryStatus::Disabled);
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&restored),
            &query(CapabilityKind::ConsoleExec, command_action(), 9)
        ),
        None
    );

    let Ok(web) = WebAction::new("https", "example.com", 443, "/files", "q=1") else {
        panic!("web");
    };
    let web_entry = must(draft(
        CanonicalAllowAction::Web(web),
        CapabilityKind::WebRead,
    ));
    let Ok(wide) = broaden_allowlist_entry(web_entry, Broaden::Field(MatcherField::WebPath)) else {
        panic!("path");
    };
    let snap = wide.snapshot();
    match &snap.matcher {
        ActionMatcherSnapshot::Web(matcher) => {
            assert!(matches!(matcher.path, FieldMatch::Any));
            assert!(matches!(
                &matcher.host,
                FieldMatch::Exact(host) if host == "example.com"
            ));
        }
        _ => panic!("web"),
    }
    round_trip(&wide);

    let file = must(draft(
        CanonicalAllowAction::File {
            path: linux("/workspace/notes.txt"),
        },
        CapabilityKind::VaultRead,
    ));
    let Ok(any_file) = broaden_allowlist_entry(file, Broaden::Field(MatcherField::FilePath)) else {
        panic!("file");
    };
    match &any_file.snapshot().matcher {
        ActionMatcherSnapshot::File(matcher) => {
            assert_eq!(matcher.platform, PlatformKind::Linux);
            assert!(matches!(matcher.path, FieldMatch::Any));
        }
        _ => panic!("file"),
    }
    round_trip(&any_file);

    let Ok(secret) = SecretName::new("openai") else {
        panic!("secret");
    };
    let secret_entry = must(draft(
        CanonicalAllowAction::Secret { name: secret },
        CapabilityKind::SecretUse,
    ));
    let Ok(any_secret) =
        broaden_allowlist_entry(secret_entry, Broaden::Field(MatcherField::SecretName))
    else {
        panic!("secret broaden");
    };
    match &any_secret.snapshot().matcher {
        ActionMatcherSnapshot::Secret(matcher) => assert!(matches!(matcher.name, FieldMatch::Any)),
        _ => panic!("secret"),
    }
    round_trip(&any_secret);

    let Ok(browser) = BrowserAction::new(BrowserVerb::Click, "https", "bank.example", 443, "Pay")
    else {
        panic!("browser");
    };
    let browser_entry = must(draft(
        CanonicalAllowAction::Browser(browser),
        CapabilityKind::WebCredentialed,
    ));
    let Ok(any_locator) =
        broaden_allowlist_entry(browser_entry, Broaden::Field(MatcherField::BrowserLocator))
    else {
        panic!("locator");
    };
    match &any_locator.snapshot().matcher {
        ActionMatcherSnapshot::Browser(matcher) => {
            assert!(matches!(matcher.locator, FieldMatch::Any));
            assert!(matches!(matcher.origin, FieldMatch::Exact(_)));
        }
        _ => panic!("browser"),
    }
    round_trip(&any_locator);

    let thread = must(draft(
        CanonicalAllowAction::Thread(ThreadAction {
            verb: ThreadVerb::Open,
            thread: ThreadId(15),
            peer: AgentId(8),
        }),
        CapabilityKind::OpenThread,
    ));
    let session = {
        let snap = thread.snapshot();
        AllowlistSnapshot {
            lifetime: GrantLifetime::DaemonLifetime {
                generation: DaemonGeneration(4),
            },
            ..snap
        }
    };
    let Ok(session_entry) = try_restore_allowlist_entry(session) else {
        panic!("session restore");
    };
    assert_eq!(
        session_entry.lifetime(),
        GrantLifetime::DaemonLifetime {
            generation: DaemonGeneration(4)
        }
    );
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&session_entry),
            &AllowlistQuery {
                capability: CapabilityKind::OpenThread,
                action: CanonicalAllowAction::Thread(ThreadAction {
                    verb: ThreadVerb::Open,
                    thread: ThreadId(15),
                    peer: AgentId(8),
                }),
                agent: AgentId(5),
                now: Timestamp(10),
                daemon_generation: DaemonGeneration(4),
            }
        ),
        Some(AllowlistEntryId(7))
    );
    let expired = AllowlistSnapshot {
        lifetime: GrantLifetime::ExpiresAt(Timestamp(10)),
        ..thread.snapshot()
    };
    let Ok(expired_entry) = try_restore_allowlist_entry(expired) else {
        panic!("expiry");
    };
    assert_eq!(
        match_allowlist(
            std::slice::from_ref(&expired_entry),
            &AllowlistQuery {
                capability: CapabilityKind::OpenThread,
                action: CanonicalAllowAction::Thread(ThreadAction {
                    verb: ThreadVerb::Open,
                    thread: ThreadId(15),
                    peer: AgentId(8),
                }),
                agent: AgentId(5),
                now: Timestamp(10),
                daemon_generation: DaemonGeneration(4),
            }
        ),
        None
    );
    round_trip(&thread);
}

#[test]
fn malformed_snapshots_are_rejected() {
    let entry = must(draft(command_action(), CapabilityKind::ConsoleExec));
    let mut incompatible = entry.snapshot();
    incompatible.capability = CapabilityKind::WebRead;
    assert!(matches!(
        try_restore_allowlist_entry(incompatible),
        Err(AllowlistError::IncompatibleCapability)
    ));

    let mut crossed = entry.snapshot();
    if let ActionMatcherSnapshot::Command(matcher) = &mut crossed.matcher {
        matcher.platform = PlatformKind::MacOs;
    }
    assert!(matches!(
        try_restore_allowlist_entry(crossed),
        Err(AllowlistError::PlatformMismatch)
    ));

    let mut web = entry.snapshot();
    web.capability = CapabilityKind::WebRead;
    web.matcher = ActionMatcherSnapshot::Web(WebMatcherSnapshot {
        scheme: FieldMatch::Exact("HTTPS".to_owned()),
        host: FieldMatch::Exact("example.com".to_owned()),
        port: FieldMatch::Exact(443),
        path: FieldMatch::Exact("/files".to_owned()),
        query: FieldMatch::Exact("q=1".to_owned()),
    });
    assert!(matches!(
        try_restore_allowlist_entry(web),
        Err(AllowlistError::NotCanonical)
    ));

    let mut traversal = entry.snapshot();
    traversal.capability = CapabilityKind::WebRead;
    traversal.matcher = ActionMatcherSnapshot::Web(WebMatcherSnapshot {
        scheme: FieldMatch::Exact("https".to_owned()),
        host: FieldMatch::Exact("example.com".to_owned()),
        port: FieldMatch::Exact(443),
        path: FieldMatch::Exact("/files/../secret".to_owned()),
        query: FieldMatch::Exact("q=1".to_owned()),
    });
    assert!(matches!(
        try_restore_allowlist_entry(traversal),
        Err(AllowlistError::InvalidSnapshotField(
            ActionFieldError::InvalidWebPath
        ))
    ));

    let mut secret = entry.snapshot();
    secret.capability = CapabilityKind::SecretUse;
    secret.matcher = ActionMatcherSnapshot::Secret(SecretMatcherSnapshot {
        name: FieldMatch::Exact(String::new()),
    });
    assert!(matches!(
        try_restore_allowlist_entry(secret),
        Err(AllowlistError::InvalidSnapshotField(
            ActionFieldError::EmptySecretName
        ))
    ));

    let mut file = entry.snapshot();
    file.capability = CapabilityKind::VaultRead;
    file.matcher = ActionMatcherSnapshot::File(FileMatcherSnapshot {
        platform: PlatformKind::Windows,
        path: FieldMatch::Exact(linux("/workspace/notes.txt")),
    });
    assert!(matches!(
        try_restore_allowlist_entry(file),
        Err(AllowlistError::PlatformMismatch)
    ));

    let mut browser = entry.snapshot();
    browser.capability = CapabilityKind::WebCredentialed;
    browser.matcher = ActionMatcherSnapshot::Browser(BrowserMatcherSnapshot {
        verb: FieldMatch::Exact(BrowserVerb::Click),
        origin: FieldMatch::Exact(WebOriginSnapshot {
            scheme: "https".to_owned(),
            host: "Bank.Example".to_owned(),
            port: 443,
        }),
        locator: FieldMatch::Exact("Pay".to_owned()),
    });
    assert!(matches!(
        try_restore_allowlist_entry(browser),
        Err(AllowlistError::NotCanonical)
    ));

    let mut thread = entry.snapshot();
    thread.capability = CapabilityKind::PostMessage;
    thread.matcher = ActionMatcherSnapshot::Thread(ThreadMatcherSnapshot {
        verb: FieldMatch::Exact(ThreadVerb::Open),
        thread: FieldMatch::Exact(ThreadId(15)),
        peer: FieldMatch::Exact(AgentId(8)),
    });
    assert!(matches!(
        try_restore_allowlist_entry(thread),
        Err(AllowlistError::IncompatibleCapability)
    ));
}
