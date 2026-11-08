//! Wire placement from `docs/design/03-thread-cache.md`.

use std::collections::BTreeSet;

use maia_core::agents::{AgentId, ThreadId};
use maia_core::brain::{RecallTaintMode, SlotId};
use maia_core::credit::PrefixHash;
use maia_core::security::Taint;
use maia_core::thread_cache::{
    ByteDigest, ChatMessage, ChatRole, CompileError, CurrentUser, MemoryBody, PersonaInput,
    PlacementMode, RecallLineage, RecallPackPolicy, ReplayedThread, ScratchCanon, SectionInput,
    TranscriptTurn, TurnRole, WirePlan, append_recall, append_scratch, compile_prompt,
    to_router_messages,
};
use maia_core::vault::VaultPath;

fn digest_hex(bytes: &[u8]) -> PrefixHash {
    let mut encoded = String::new();
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    PrefixHash::new(encoded)
}

fn digest() -> ByteDigest {
    ByteDigest::from_fn(digest_hex)
}

fn chars_as_tokens(text: &str) -> u32 {
    u32::try_from(text.chars().count()).expect("tokens")
}

fn section(id: &str, body: &str) -> SectionInput {
    SectionInput {
        id: SlotId::new(id),
        body: body.to_owned(),
        taint: Taint::Trusted,
        label: None,
        version: 1,
    }
}

fn participants(ids: &[u64]) -> BTreeSet<AgentId> {
    ids.iter().copied().map(AgentId).collect()
}

fn thread(turns: Vec<TranscriptTurn>, current: &str, turn_id: &str) -> ReplayedThread {
    ReplayedThread {
        version: 1,
        thread_id: ThreadId(9),
        participants: participants(&[1]),
        tools: section("tools", "TOOLJSON_9f3a"),
        agents: section("agents", "constitution"),
        personas: vec![PersonaInput {
            section: section("agent:1", "persona"),
            agent_id: AgentId(1),
        }],
        memory: MemoryBody::Editable(section("memory", "")),
        turns,
        notes: Vec::new(),
        current_user: CurrentUser {
            id: SlotId::new(format!("user:{turn_id}")),
            turn_id: turn_id.to_owned(),
            body: current.to_owned(),
            taint: Taint::Trusted,
            label: None,
            version: 1,
        },
        opaque_excluded: Vec::new(),
    }
}

fn request_for(
    log: &ReplayedThread,
    scratch: ScratchCanon,
    paths: &[VaultPath],
) -> maia_core::thread_cache::CompiledRequest {
    let prefix = compile_prompt(log, digest()).expect("compile");
    let recalled = append_recall(
        &prefix,
        &[],
        &RecallPackPolicy {
            token_budget: 11,
            taint_mode: RecallTaintMode::IncludeUntrusted,
            lineage: RecallLineage {
                consolidated_claims: std::collections::BTreeMap::new(),
                fact_sources: std::collections::BTreeMap::new(),
            },
        },
        chars_as_tokens,
        digest(),
    )
    .expect("recall");
    append_scratch(&recalled, paths, &scratch, digest()).expect("scratch")
}

fn plan(placement: PlacementMode, speaker: Option<AgentId>, in_turn: Vec<ChatMessage>) -> WirePlan {
    WirePlan {
        placement,
        speaker,
        in_turn,
    }
}

fn hello_turn() -> TranscriptTurn {
    TranscriptTurn {
        id: SlotId::new("user:t1"),
        log_ordinal: 0,
        turn_id: "t1".to_owned(),
        role: TurnRole::User,
        body: "hello".to_owned(),
        taint: Taint::Trusted,
        label: None,
        version: 1,
    }
}

fn expected_system() -> &'static str {
    concat!(
        "## agents\n",
        "constitution\n",
        "## personas\n",
        "`agent:1`:\n",
        "persona\n",
        "## memory\n",
        "\n",
    )
}

fn assert_hello_stable(placement: PlacementMode) {
    let first = request_for(&thread(Vec::new(), "hello", "t1"), ScratchCanon::None, &[]);
    let second = request_for(
        &thread(vec![hello_turn()], "next", "t2"),
        ScratchCanon::None,
        &[],
    );
    let wire_plan = plan(placement, None, Vec::new());
    let first_messages = to_router_messages(&first, &wire_plan).expect("turn n");
    let second_messages = to_router_messages(&second, &wire_plan).expect("turn n+1");
    assert_eq!(first_messages[1].role, ChatRole::User);
    assert_eq!(first_messages[1].content, "hello");
    assert_eq!(second_messages[1].content, "hello");
    assert_eq!(first_messages[1], second_messages[1]);
    assert_eq!(first_messages[0].content, expected_system());
    assert_eq!(second_messages[0].content, first_messages[0].content);
    assert!(!first_messages[1].content.contains("## recall"));
    assert!(!second_messages[1].content.contains("## recall"));
    assert!(
        !first_messages
            .iter()
            .any(|message| message.content.contains("TOOLJSON_9f3a"))
    );
    assert!(first.with_recall.prefix.bytes.contains("TOOLJSON_9f3a"));
    assert_eq!(first.with_recall.prefix.tools_json, "TOOLJSON_9f3a");
}

#[test]
fn message_n_is_byte_identical_under_trailing_system() {
    assert_hello_stable(PlacementMode::TrailingSystem);
}

#[test]
fn message_n_is_byte_identical_under_trailing_user_part() {
    assert_hello_stable(PlacementMode::TrailingUserPart);
}

#[test]
fn trailing_system_keeps_recall_scratch_and_tools_apart() {
    let path = VaultPath::parse("notes/a.md").expect("path");
    let scratch = "SCRATCH_BYTES\n";
    let request = request_for(
        &thread(Vec::new(), "hello", "t1"),
        ScratchCanon::Bytes(scratch.to_owned()),
        &[path],
    );
    let messages = to_router_messages(
        &request,
        &plan(
            PlacementMode::TrailingSystem,
            None,
            vec![ChatMessage::text(ChatRole::Tool, "TOOL_BYTES_9f3a")],
        ),
    )
    .expect("wire");
    assert_eq!(
        messages,
        vec![
            ChatMessage::text(ChatRole::System, expected_system()),
            ChatMessage::text(ChatRole::User, "hello"),
            ChatMessage::text(ChatRole::Tool, "TOOL_BYTES_9f3a"),
            ChatMessage::text(ChatRole::System, "## recall\n\n"),
            ChatMessage::text(ChatRole::System, scratch),
        ]
    );
    assert!(!request.with_recall.prefix.bytes.contains("TOOL_BYTES_9f3a"));
    assert!(!request.with_recall.prefix.bytes.contains("SCRATCH_BYTES"));
}

#[test]
fn trailing_user_part_concatenates_in_order() {
    let path = VaultPath::parse("notes/a.md").expect("path");
    let request = request_for(
        &thread(Vec::new(), "hello", "t1"),
        ScratchCanon::Bytes("SCRATCH_BYTES\n".to_owned()),
        &[path],
    );
    let messages = to_router_messages(
        &request,
        &plan(PlacementMode::TrailingUserPart, None, Vec::new()),
    )
    .expect("wire");
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[2],
        ChatMessage::text(ChatRole::User, "## recall\n\nSCRATCH_BYTES\n")
    );
    assert_eq!(messages[1].content, "hello");
}

#[test]
fn speaker_line_follows_personas_without_reordering_them() {
    let mut log = thread(Vec::new(), "hello", "t1");
    log.participants = participants(&[1, 2]);
    log.personas = vec![
        PersonaInput {
            section: section("agent:2", "second"),
            agent_id: AgentId(2),
        },
        PersonaInput {
            section: section("agent:1", "first"),
            agent_id: AgentId(1),
        },
    ];
    log.turns.push(TranscriptTurn {
        id: SlotId::new("assistant:a2"),
        log_ordinal: 0,
        turn_id: "a2".to_owned(),
        role: TurnRole::Assistant,
        body: "speaker body stays".to_owned(),
        taint: Taint::Trusted,
        label: None,
        version: 1,
    });
    let request = request_for(&log, ScratchCanon::None, &[]);
    let messages = to_router_messages(
        &request,
        &plan(PlacementMode::TrailingSystem, Some(AgentId(2)), Vec::new()),
    )
    .expect("wire");
    let system = &messages[0].content;
    let first = system.find("`agent:1`:").expect("agent 1");
    let second = system.find("`agent:2`:").expect("agent 2");
    assert!(first < second);
    assert_eq!(messages[1].role, ChatRole::Assistant);
    assert_eq!(messages[1].content, "speaker body stays");
    assert_eq!(messages[2].content, "hello");
    let last = messages.last().expect("speaker");
    assert_eq!(last.role, ChatRole::System);
    assert_eq!(last.content, "`speaker:2`\n");
    assert!(!request.with_recall.prefix.bytes.contains("speaker:2"));
}

#[test]
fn user_role_in_turn_tool_state_is_rejected() {
    let request = request_for(&thread(Vec::new(), "hello", "t1"), ScratchCanon::None, &[]);
    let error = to_router_messages(
        &request,
        &plan(
            PlacementMode::TrailingSystem,
            None,
            vec![ChatMessage::text(ChatRole::User, "nope")],
        ),
    )
    .expect_err("role");
    assert_eq!(error, CompileError::InvalidToolRole);
}
