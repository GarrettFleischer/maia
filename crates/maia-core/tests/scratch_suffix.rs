//! Turn-local scratch suffix. The grammar is caller-supplied.

use std::collections::BTreeSet;

use maia_core::agents::{AgentId, ThreadId};
use maia_core::brain::{ClaimId, RankedPath, RecallItem, RecallTaintMode, SlotId};
use maia_core::brain::{ComponentScores, NodeId};
use maia_core::credit::PrefixHash;
use maia_core::security::Taint;
use maia_core::thread_cache::{
    ByteDigest, CompileError, CurrentUser, MemoryBody, PersonaInput, RecallLineage,
    RecallPackPolicy, ReplayedThread, ScratchCanon, SectionInput, append_recall, append_scratch,
    compile_prompt,
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
    u32::try_from(text.chars().count()).expect("token count fits")
}

fn log() -> ReplayedThread {
    let mut participants = BTreeSet::new();
    participants.insert(AgentId(1));
    ReplayedThread {
        version: 1,
        thread_id: ThreadId(3),
        participants,
        tools: section("tools", "{\"tools\":[]}"),
        agents: section("agents", "constitution"),
        personas: vec![PersonaInput {
            section: section("agent:1", "persona"),
            agent_id: AgentId(1),
        }],
        memory: MemoryBody::Editable(section("memory", "")),
        turns: Vec::new(),
        notes: Vec::new(),
        current_user: CurrentUser {
            id: SlotId::new("user:t1"),
            turn_id: "t1".to_owned(),
            body: "hello".to_owned(),
            taint: Taint::Trusted,
            label: None,
            version: 1,
        },
        opaque_excluded: Vec::new(),
    }
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

fn with_recall() -> maia_core::thread_cache::CompiledWithRecall {
    let prefix = compile_prompt(&log(), digest()).expect("compile");
    append_recall(
        &prefix,
        &[RankedPath {
            walked: vec![NodeId::Claim(ClaimId::new("walk"))],
            item: RecallItem::Claim {
                claim_id: ClaimId::new("claim_a"),
            },
            sentence: "one".to_owned(),
            taint: Taint::Trusted,
            scores: ComponentScores {
                activation: None,
                pagerank: 0.0,
                embedding: None,
                combined: 1.0,
                tie_break: "claim_a".to_owned(),
            },
        }],
        &RecallPackPolicy {
            token_budget: 40,
            taint_mode: RecallTaintMode::IncludeUntrusted,
            lineage: RecallLineage {
                consolidated_claims: std::collections::BTreeMap::new(),
                fact_sources: std::collections::BTreeMap::new(),
            },
        },
        chars_as_tokens,
        digest(),
    )
    .expect("recall")
}

#[test]
fn scratch_bytes_are_hashed_apart_from_prefix_and_recall() {
    let recalled = with_recall();
    let path = VaultPath::parse("notes/a.md").expect("path");
    let scratch = "notes/a.md\n";
    let request = append_scratch(
        &recalled,
        &[path],
        &ScratchCanon::Bytes(scratch.to_owned()),
        digest(),
    )
    .expect("scratch");
    let region = request.scratch.expect("region");
    assert_eq!(region.bytes, scratch);
    assert_eq!(region.hash, digest_hex(scratch.as_bytes()));
    assert!(!region.durable);
    assert_eq!(region.paths.len(), 1);
    assert_eq!(request.with_recall.prefix.hash, recalled.prefix.hash);
    assert_eq!(request.with_recall.prefix.bytes, recalled.prefix.bytes);
    assert_eq!(request.with_recall.recall_hash, recalled.recall_hash);
    assert_ne!(region.hash, request.with_recall.prefix.hash);
    assert_ne!(region.hash, request.with_recall.recall_hash);
    assert!(!request.with_recall.prefix.bytes.contains("notes/a.md"));
    let replayed = compile_prompt(&log(), digest()).expect("replay");
    assert_eq!(replayed.bytes, request.with_recall.prefix.bytes);
    assert_eq!(replayed.hash, request.with_recall.prefix.hash);
}

#[test]
fn failed_scratch_canonicalization_does_not_build_a_request() {
    let recalled = with_recall();
    let path = VaultPath::parse("notes/a.md").expect("path");
    let error = append_scratch(&recalled, &[path], &ScratchCanon::Failed, digest())
        .expect_err("failed canon");
    assert_eq!(error, CompileError::ScratchCanonicalizationFailed);
    assert_eq!(recalled.prefix.hash, with_recall().prefix.hash);
}

#[test]
fn paths_without_supplied_bytes_are_not_invented() {
    let recalled = with_recall();
    let path = VaultPath::parse("notes/a.md").expect("path");
    let error =
        append_scratch(&recalled, &[path], &ScratchCanon::None, digest()).expect_err("missing");
    assert_eq!(error, CompileError::ScratchBytesMissing);
}

#[test]
fn bytes_without_paths_are_refused() {
    let recalled = with_recall();
    let error = append_scratch(
        &recalled,
        &[],
        &ScratchCanon::Bytes("notes/a.md\n".to_owned()),
        digest(),
    )
    .expect_err("inconsistent");
    assert_eq!(error, CompileError::ScratchInconsistent);
}

#[test]
fn no_paths_omit_the_scratch_region() {
    let recalled = with_recall();
    let request = append_scratch(&recalled, &[], &ScratchCanon::None, digest()).expect("none");
    assert!(request.scratch.is_none());
    assert_eq!(request.with_recall.recall_hash, recalled.recall_hash);
}
