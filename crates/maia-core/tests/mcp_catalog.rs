use std::collections::BTreeSet;

use maia_core::mcp::AdmitError;
use maia_core::mcp::ArgumentError;
use maia_core::mcp::CatalogEntry;
use maia_core::mcp::CatalogStatus;
use maia_core::mcp::CatalogTool;
use maia_core::mcp::ConnectionView;
use maia_core::mcp::GuidanceError;
use maia_core::mcp::GuidanceRoute;
use maia_core::mcp::ListedState;
use maia_core::mcp::ListedTool;
use maia_core::mcp::LiveTool;
use maia_core::mcp::ManifestError;
use maia_core::mcp::McpExchangeClass;
use maia_core::mcp::SecretNeedle;
use maia_core::mcp::StdioError;
use maia_core::mcp::TargetError;
use maia_core::mcp::ToolPart;
use maia_core::mcp::admit_mcp_call;
use maia_core::mcp::bound_tool_text;
use maia_core::mcp::canonical_manifest;
use maia_core::mcp::catalog_lines;
use maia_core::mcp::check_arguments;
use maia_core::mcp::classify_mcp_exchange;
use maia_core::mcp::connection_entries;
use maia_core::mcp::guidance_for_route;
use maia_core::mcp::manifest_hash;
use maia_core::mcp::mcp_audit_record;
use maia_core::mcp::mcp_grants;
use maia_core::mcp::open_stdio;
use maia_core::mcp::parameter_names;
use maia_core::mcp::prepare_manifest;
use maia_core::mcp::redact_secret_needles;
use maia_core::mcp::render_tool_result;
use maia_core::mcp::validate_connection_target;
use maia_core::mcp::wire_name;
use maia_core::mcp::worker_tools_json;
use maia_core::super_agent::ChildAssignmentDraft;
use maia_core::super_agent::ChildId;
use maia_core::super_agent::ChildPolicy;
use maia_core::super_agent::CriterionSource;
use maia_core::super_agent::GrantCeiling;
use maia_core::super_agent::GrantKey;
use maia_core::super_agent::MessageId;
use maia_core::super_agent::NarrowError;
use maia_core::super_agent::SessionRole;
use maia_core::super_agent::SourcedSlice;
use maia_core::super_agent::TaskEnvelope;
use maia_core::super_agent::TaskId;
use maia_core::super_agent::UserPromptBytes;
use maia_core::super_agent::narrow_child;

fn scrape() -> ListedTool {
    ListedTool {
        name: "scrape".into(),
        description: "Read a page".into(),
        input_schema: r#"{"type":"object","properties":{"url":{"type":"string"},"geo":{"type":"string"}},"required":["url"]}"#
            .into(),
    }
}

fn parent() -> SessionRole {
    SessionRole::ParentTask {
        task: TaskId("task-1".into()),
    }
}

fn live_scrape() -> LiveTool {
    LiveTool {
        wire_name: "web__scrape".into(),
        server_tool: "scrape".into(),
        description: "Read a page".into(),
        input_schema: scrape().input_schema,
    }
}

#[test]
fn manifest_hash_changes_when_one_schema_byte_changes() {
    let first = canonical_manifest(&[scrape()]).expect("schema");
    let mut changed = scrape();
    changed.description.push('x');
    let second = canonical_manifest(std::slice::from_ref(&changed)).expect("schema");
    assert_ne!(first, second);
    assert_ne!(manifest_hash(&first), manifest_hash(&second));
    let entries = connection_entries(&ConnectionView {
        label: "Web".into(),
        blocked: None,
        listed: ListedState::Drifted {
            admitted: manifest_hash(&first),
            listed: manifest_hash(&second),
        },
        tools: vec![CatalogTool {
            wire_name: "web__scrape".into(),
            description: "Read a page".into(),
            parameters: vec!["url".into()],
        }],
    });
    assert_eq!(
        entries,
        vec![CatalogEntry::Hidden {
            label: "Web".into(),
            status: CatalogStatus::SchemaChanged,
        }]
    );
    let lines = catalog_lines(&entries);
    assert!(!lines.contains("Read a page"));
    assert!(!lines.contains("scrape"));
    assert!(lines.contains("schema changed"));
    let grants = mcp_grants(&parent(), &[], &BTreeSet::new());
    assert!(grants.is_empty());
}

#[test]
fn catalog_shows_live_tools_and_hides_unapproved_descriptions() {
    let entries = vec![
        CatalogEntry::Live {
            label: "Web".into(),
            wire_name: "web__scrape".into(),
            description: "Read a page".into(),
            parameters: vec!["geo".into(), "url".into()],
        },
        CatalogEntry::Hidden {
            label: "Waiting".into(),
            status: CatalogStatus::PendingApproval,
        },
    ];
    let lines = catalog_lines(&entries);
    assert!(lines.contains("web__scrape"));
    assert!(lines.contains("Read a page"));
    assert!(lines.contains("geo"));
    assert!(lines.contains("url"));
    assert!(lines.contains("Waiting"));
    assert!(lines.contains("pending approval"));
    assert!(!lines.contains("hidden description"));
}

#[test]
fn wire_name_and_prepare_reject_a_second_live_name() {
    let name = wire_name("web", "scrape").expect("wire");
    assert_eq!(name, "web__scrape");
    let prepared = prepare_manifest("web", &[scrape()]).expect("manifest");
    assert_eq!(prepared.wire_names, vec!["web__scrape".to_owned()]);
    assert_eq!(prepared.hash, manifest_hash(&prepared.canonical));
    assert!(matches!(
        wire_name("Web", "scrape"),
        Err(ManifestError::ConnectionId)
    ));
}

#[test]
fn router_call_is_refused_before_argument_checks() {
    let grants = mcp_grants(&parent(), &["web__scrape".to_owned()], &BTreeSet::new());
    let error = admit_mcp_call(
        &SessionRole::Router,
        "web__scrape",
        "not-json",
        &[live_scrape()],
        &grants,
    )
    .expect_err("router");
    assert_eq!(error, AdmitError::RouterRole);
}

#[test]
fn missing_required_argument_is_rejected() {
    let error = check_arguments(scrape().input_schema.as_str(), r#"{"geo":"us"}"#)
        .expect_err("required");
    assert_eq!(error, ArgumentError::Invalid);
    let grants = mcp_grants(&parent(), &["web__scrape".to_owned()], &BTreeSet::new());
    let error = admit_mcp_call(
        &parent(),
        "web__scrape",
        r#"{"geo":"us"}"#,
        &[live_scrape()],
        &grants,
    )
    .expect_err("call");
    assert_eq!(error, AdmitError::Arguments);
    assert!(check_arguments(scrape().input_schema.as_str(), r#"{"url":"https://example.test"}"#).is_ok());
    assert_eq!(
        check_arguments(r#"{"type":"object","properties":{"n":{"type":"integer"}}}"#, r#"{"n":1.5}"#),
        Err(ArgumentError::Invalid)
    );
    assert!(
        check_arguments(r#"{"type":"object","properties":{"n":{"type":"integer"}}}"#, r#"{"n":1}"#)
            .is_ok()
    );
}

#[test]
fn parameter_names_are_sorted_property_keys() {
    assert_eq!(
        parameter_names(scrape().input_schema.as_str()).expect("names"),
        vec!["geo".to_owned(), "url".to_owned()]
    );
}

#[test]
fn guidance_bounds_and_route_fields() {
    let accepted = "a".repeat(2000);
    assert_eq!(
        guidance_for_route(GuidanceRoute::Spawn, Some(accepted.as_str())).expect("fit"),
        Some(accepted)
    );
    let too_long = "a".repeat(2001);
    assert_eq!(
        guidance_for_route(GuidanceRoute::Continue, Some(too_long.as_str())),
        Err(GuidanceError::TooLong)
    );
    assert_eq!(
        guidance_for_route(GuidanceRoute::Inspect, Some("use the tool")),
        Err(GuidanceError::NotAllowed)
    );
    assert_eq!(
        guidance_for_route(GuidanceRoute::Cancel, None).expect("absent"),
        None
    );
    assert_eq!(
        guidance_for_route(GuidanceRoute::Link, Some("call web__scrape")).expect("link"),
        Some("call web__scrape".to_owned())
    );
}

#[test]
fn child_cannot_add_a_wire_grant() {
    let parent_grants = mcp_grants(&parent(), &["web__scrape".to_owned()], &BTreeSet::new());
    let mut widened = parent_grants.clone();
    widened.insert(GrantKey("web__other".into()));
    let child = SessionRole::ChildTask {
        task: TaskId("task-1".into()),
        child: ChildId("child-1".into()),
    };
    let narrowed = mcp_grants(&child, &["web__scrape".to_owned(), "web__other".to_owned()], &parent_grants);
    assert_eq!(narrowed, parent_grants);
    let draft = ChildAssignmentDraft {
        child: ChildId("child-1".into()),
        parent: TaskId("task-1".into()),
        parent_attempt: maia_core::super_agent::AttemptId("a1".into()),
        subgoal: SourcedSlice {
            source: CriterionSource::UserText {
                message: MessageId("m1".into()),
                start: 0,
                end: 3,
            },
            utf8: b"Add".to_vec(),
        },
        envelope_slices: Vec::new(),
        context: maia_core::super_agent::SnapshotId("snap".into()),
        ceiling: GrantCeiling { grants: widened },
        budget: maia_core::super_agent::BudgetCeiling {
            router_tokens: 10,
            tool_turns: 1,
        },
    };
    let envelope = TaskEnvelope {
        id: maia_core::super_agent::EnvelopeId("env".into()),
        task: TaskId("task-1".into()),
        origin_attempt: maia_core::super_agent::AttemptId("a1".into()),
        original_prompt: UserPromptBytes {
            message: MessageId("m1".into()),
            utf8: b"Add a pin".to_vec(),
        },
        brief: maia_core::super_agent::AdvisoryBrief("advisory".into()),
        criteria: Vec::new(),
        constraints: Vec::new(),
        context: maia_core::super_agent::SnapshotId("snap".into()),
        routing_reason: maia_core::super_agent::RoutingReason("create_task".into()),
        assumptions: Vec::new(),
        question_log: Vec::new(),
    };
    let error = narrow_child(
        &envelope,
        &draft,
        &parent_grants,
        draft.budget,
        1,
        &ChildPolicy { max_depth: 3 },
    )
    .expect_err("widen");
    assert_eq!(error, NarrowError::GrantWidened);
}

#[test]
fn exchange_class_follows_send_and_completion() {
    assert_eq!(
        classify_mcp_exchange(false, false),
        McpExchangeClass::KnownFailure
    );
    assert_eq!(
        classify_mcp_exchange(true, true),
        McpExchangeClass::KnownResult
    );
    assert_eq!(classify_mcp_exchange(true, false), McpExchangeClass::Unknown);
}

#[test]
fn tool_text_redacts_secrets_and_omits_binary() {
    let rendered = render_tool_result(&[
        ToolPart::Text("token sk-live ".into()),
        ToolPart::Binary { byte_len: 12 },
    ]);
    let redacted = redact_secret_needles(&rendered, &[SecretNeedle("sk-live")]);
    assert!(redacted.contains("[redacted]"));
    assert!(!redacted.contains("sk-live"));
    assert!(redacted.contains("binary content"));
    let huge = "x".repeat(70_000);
    let bounded = bound_tool_text(&huge);
    assert!(bounded.ends_with("\n[truncated]"));
    assert!(bounded.len() > 65_536);
}

#[test]
fn audit_record_omits_arguments_and_secret_text() {
    let record = mcp_audit_record(
        "web",
        "web__scrape",
        "abc",
        McpExchangeClass::KnownResult,
        "page [redacted]",
    );
    let debug = format!("{record:?}");
    assert!(!debug.contains("sk-live"));
    assert!(!debug.contains("arguments"));
    assert_eq!(record.result_sha256, manifest_hash("page [redacted]"));
}

#[test]
fn stdio_does_not_spawn_when_containment_is_unready() {
    let mut spawns = 0;
    let error = open_stdio(false, || {
        spawns += 1;
        Ok::<(), ()>(())
    })
    .expect_err("gate");
    assert_eq!(error, StdioError::Containment);
    assert_eq!(spawns, 0);
}

#[test]
fn http_targets_are_https_or_loopback() {
    assert_eq!(
        validate_connection_target("http://example.com/mcp"),
        Err(TargetError::Url)
    );
    assert!(validate_connection_target("http://127.0.0.1/mcp").is_ok());
    assert!(validate_connection_target("https://mcp.example.com/mcp").is_ok());
    assert!(validate_connection_target("http://localhost:9/mcp").is_ok());
    assert_eq!(
        validate_connection_target("http://[::1]/mcp"),
        Ok(())
    );
}

#[test]
fn worker_tool_list_uses_live_wire_names_only() {
    let json = worker_tools_json(&[live_scrape()]);
    assert!(json.contains("web__scrape"));
    assert!(!json.contains("web__other"));
}

#[test]
fn router_role_grants_stay_empty_for_every_profile() {
    for profile in [
        maia_core::security::SecurityProfile::Protected,
        maia_core::security::SecurityProfile::Allowlisted,
        maia_core::security::SecurityProfile::Unrestricted,
    ] {
        let tools = maia_core::super_agent::execution_tools(&SessionRole::Router, profile);
        assert!(tools.is_empty(), "{profile:?}");
    }
    assert!(mcp_grants(&SessionRole::Router, &["web__scrape".to_owned()], &BTreeSet::new()).is_empty());
}
