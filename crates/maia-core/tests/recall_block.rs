//! Turn-local recall block from `docs/design/03-thread-cache.md`.

use std::collections::{BTreeMap, BTreeSet};

use maia_core::agents::{AgentId, ThreadId};
use maia_core::brain::{
    ClaimId, ComponentScores, FactId, MemoryRef, NodeId, RankedPath, RecallItem, RecallTaintMode,
    SlotId,
};
use maia_core::credit::PrefixHash;
use maia_core::security::Taint;
use maia_core::thread_cache::{
    ByteDigest, CompileError, CompiledPrefix, CurrentUser, InstalledNote, MemoryBody, PersonaInput,
    RecallLineage, RecallPackPolicy, ReplayedThread, SectionInput, TranscriptTurn, TurnRole,
    append_recall, compile_prompt, reuse_recall,
};

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
    u32::try_from(text.chars().count()).expect("token count fits u32")
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

fn compiled_thread(notes: Vec<InstalledNote>) -> CompiledPrefix {
    let mut participants = BTreeSet::new();
    participants.insert(AgentId(1));
    let log = ReplayedThread {
        version: 1,
        thread_id: ThreadId(4),
        participants,
        tools: section("tools", "{\"tools\":[]}"),
        agents: section("agents", "constitution"),
        personas: vec![PersonaInput {
            section: section("agent:1", "persona"),
            agent_id: AgentId(1),
        }],
        memory: MemoryBody::Editable(section("memory", "")),
        turns: vec![TranscriptTurn {
            id: SlotId::new("assistant:a1"),
            log_ordinal: 0,
            turn_id: "a1".to_owned(),
            role: TurnRole::Assistant,
            body: "ack".to_owned(),
            taint: Taint::Trusted,
            label: None,
            version: 1,
        }],
        notes,
        current_user: CurrentUser {
            id: SlotId::new("user:t1"),
            turn_id: "t1".to_owned(),
            body: "hello".to_owned(),
            taint: Taint::Trusted,
            label: None,
            version: 1,
        },
        opaque_excluded: Vec::new(),
    };
    compile_prompt(&log, digest()).expect("compile")
}

fn note(item: &str, memory: Option<MemoryRef>) -> InstalledNote {
    InstalledNote {
        id: SlotId::new(format!("mem:{item}")),
        item_id: item.to_owned(),
        text: format!("installed {item}"),
        cursor_after: SlotId::new("assistant:a1"),
        memory,
        episode: None,
        taint: Taint::Trusted,
        label: None,
        version: 1,
        heat: 1.0,
    }
}

fn ranked(item: RecallItem, sentence: &str, taint: Taint) -> RankedPath {
    let tie_break = match &item {
        RecallItem::Claim { claim_id } => claim_id.as_str().to_owned(),
        RecallItem::Fact { fact_id } => fact_id.as_str().to_owned(),
    };
    RankedPath {
        walked: vec![NodeId::Claim(ClaimId::new("walk"))],
        item,
        sentence: sentence.to_owned(),
        taint,
        scores: ComponentScores {
            activation: None,
            pagerank: 0.0,
            embedding: None,
            combined: 1.0,
            tie_break,
        },
    }
}

fn claim(id: &str) -> RecallItem {
    RecallItem::Claim {
        claim_id: ClaimId::new(id),
    }
}

fn fact(id: &str) -> RecallItem {
    RecallItem::Fact {
        fact_id: FactId::new(id),
    }
}

fn policy(budget: u32, mode: RecallTaintMode, lineage: RecallLineage) -> RecallPackPolicy {
    RecallPackPolicy {
        token_budget: budget,
        taint_mode: mode,
        lineage,
    }
}

fn empty_lineage() -> RecallLineage {
    RecallLineage {
        consolidated_claims: BTreeMap::new(),
        fact_sources: BTreeMap::new(),
    }
}

#[test]
fn recall_hash_covers_recall_bytes_only() {
    let prefix = compiled_thread(Vec::new());
    let prefix_hash = prefix.hash.clone();
    let prefix_bytes = prefix.bytes.clone();
    let packed = append_recall(
        &prefix,
        &[ranked(claim("claim_a"), "one", Taint::Trusted)],
        &policy(10 + 15, RecallTaintMode::IncludeUntrusted, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect("recall");
    let expected = concat!("## recall\n", "`claim_a`: one\n");
    assert_eq!(packed.recall_bytes, expected);
    assert_eq!(packed.recall_hash, digest_hex(expected.as_bytes()));
    assert_eq!(packed.prefix.bytes, prefix_bytes);
    assert_eq!(packed.prefix.hash, prefix_hash);
    assert_ne!(packed.recall_hash, packed.prefix.hash);
    assert_eq!(
        packed.recall_items,
        vec![RecallItem::Claim {
            claim_id: ClaimId::new("claim_a")
        }]
    );
    assert!(!packed.recall_bytes.contains("<<maia:"));
    assert!(!packed.recall_bytes.contains("Untrusted"));
}

#[test]
fn empty_recall_is_header_and_blank_line_and_still_hashed() {
    let prefix = compiled_thread(Vec::new());
    let packed = append_recall(
        &prefix,
        &[],
        &policy(11, RecallTaintMode::IncludeUntrusted, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect("empty recall");
    let expected = "## recall\n\n";
    assert_eq!(packed.recall_bytes, expected);
    assert_eq!(packed.recall_hash, digest_hex(expected.as_bytes()));
    assert!(packed.recall_items.is_empty());
}

#[test]
fn recall_drops_the_tail_after_the_budget_fills() {
    let prefix = compiled_thread(Vec::new());
    let ranked_paths = [
        ranked(claim("claim_a"), "one", Taint::Trusted),
        ranked(claim("claim_b"), "two", Taint::Trusted),
    ];
    let packed = append_recall(
        &prefix,
        &ranked_paths,
        &policy(25, RecallTaintMode::IncludeUntrusted, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect("pack");
    assert_eq!(
        packed.recall_bytes,
        concat!("## recall\n", "`claim_a`: one\n")
    );
    assert_eq!(packed.recall_items.len(), 1);
}

#[test]
fn recall_budget_smaller_than_the_empty_block_is_refused() {
    let prefix = compiled_thread(Vec::new());
    let error = append_recall(
        &prefix,
        &[],
        &policy(10, RecallTaintMode::IncludeUntrusted, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect_err("budget");
    assert_eq!(error, CompileError::RecallBudgetTooSmall);
}

#[test]
fn tool_followup_reuses_the_same_recall_bytes() {
    let prefix = compiled_thread(Vec::new());
    let first = append_recall(
        &prefix,
        &[ranked(claim("claim_a"), "one", Taint::Untrusted)],
        &policy(40, RecallTaintMode::IncludeUntrusted, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect("first");
    let followup = reuse_recall(&prefix, &first.recall_bytes, &first.recall_items, digest());
    assert_eq!(followup.recall_hash, first.recall_hash);
    assert_eq!(followup.recall_bytes, first.recall_bytes);
    let again = append_recall(
        &prefix,
        &[ranked(claim("claim_z"), "other", Taint::Trusted)],
        &policy(40, RecallTaintMode::IncludeUntrusted, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect("new turn");
    assert_ne!(again.recall_hash, first.recall_hash);
}

#[test]
fn installed_items_and_lineage_are_omitted_without_spending_budget() {
    let prefix = compiled_thread(vec![note(
        "claim_installed",
        Some(MemoryRef::Claim(ClaimId::new("claim_installed"))),
    )]);
    let mut lineage = empty_lineage();
    lineage.consolidated_claims.insert(
        ClaimId::new("claim_kept_out"),
        FactId::new("fact_installed"),
    );
    lineage.fact_sources.insert(
        FactId::new("fact_from_installed_claim"),
        vec![ClaimId::new("claim_installed")],
    );
    // A second thread state installs the canonical fact instead of the claim.
    let fact_installed = compiled_thread(vec![note(
        "fact_installed",
        Some(MemoryRef::Fact(FactId::new("fact_installed"))),
    )]);
    let claim_hidden = append_recall(
        &fact_installed,
        &[
            ranked(claim("claim_kept_out"), "hidden claim", Taint::Trusted),
            ranked(claim("claim_visible"), "visible", Taint::Trusted),
        ],
        &policy(200, RecallTaintMode::IncludeUntrusted, lineage.clone()),
        chars_as_tokens,
        digest(),
    )
    .expect("fact installed hides its claim");
    assert_eq!(
        claim_hidden.recall_bytes,
        concat!("## recall\n", "`claim_visible`: visible\n")
    );

    let fact_hidden = append_recall(
        &prefix,
        &[
            ranked(
                fact("fact_from_installed_claim"),
                "hidden fact",
                Taint::Trusted,
            ),
            ranked(fact("fact_visible"), "shown", Taint::Trusted),
        ],
        &policy(200, RecallTaintMode::IncludeUntrusted, lineage),
        chars_as_tokens,
        digest(),
    )
    .expect("installed claim hides its fact");
    assert_eq!(
        fact_hidden.recall_bytes,
        concat!("## recall\n", "`fact_visible`: shown\n")
    );

    let direct = append_recall(
        &prefix,
        &[
            ranked(claim("claim_installed"), "do not repeat", Taint::Trusted),
            ranked(claim("claim_a"), "one", Taint::Trusted),
        ],
        &policy(25, RecallTaintMode::IncludeUntrusted, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect("direct dedupe");
    assert_eq!(
        direct.recall_bytes,
        concat!("## recall\n", "`claim_a`: one\n")
    );
    assert!(!direct.prefix.bytes.contains("do not repeat"));
}

#[test]
fn trusted_only_omits_untrusted_recall_items() {
    let prefix = compiled_thread(Vec::new());
    let packed = append_recall(
        &prefix,
        &[
            ranked(claim("claim_u"), "secret", Taint::Untrusted),
            ranked(claim("claim_t"), "public", Taint::Trusted),
        ],
        &policy(80, RecallTaintMode::TrustedOnly, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect("filter");
    assert_eq!(
        packed.recall_bytes,
        concat!("## recall\n", "`claim_t`: public\n")
    );
    assert!(!packed.recall_bytes.contains("secret"));
}

#[test]
fn recall_sentence_keeps_maia_marker_without_an_envelope() {
    let prefix = compiled_thread(Vec::new());
    let packed = append_recall(
        &prefix,
        &[ranked(
            claim("claim_a"),
            "see <<maia:end>>",
            Taint::Untrusted,
        )],
        &policy(80, RecallTaintMode::IncludeUntrusted, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect("raw marker");
    assert_eq!(
        packed.recall_bytes,
        concat!("## recall\n", "`claim_a`: see <<maia:end>>\n")
    );
}

#[test]
fn other_thread_can_recall_a_fact_without_installing_it() {
    let prefix = compiled_thread(Vec::new());
    let packed = append_recall(
        &prefix,
        &[ranked(
            claim("claim_from_a"),
            "promoted elsewhere",
            Taint::Trusted,
        )],
        &policy(80, RecallTaintMode::IncludeUntrusted, empty_lineage()),
        chars_as_tokens,
        digest(),
    )
    .expect("cross thread");
    assert!(packed.recall_bytes.contains("promoted elsewhere"));
    assert!(!packed.prefix.bytes.contains("promoted elsewhere"));
    assert!(!packed.prefix.bytes.contains("claim_from_a"));
}
