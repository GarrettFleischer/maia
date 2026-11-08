//! Compaction triggers and deterministic regrouping.

use std::collections::BTreeSet;

use maia_core::agents::{AgentId, ThreadId};
use maia_core::audit::Timestamp;
use maia_core::brain::{
    ClaimId, ComponentScores, FactId, MemoryRef, NodeId, RankedPath, RecallItem, RecallTaintMode,
    SlotId,
};
use maia_core::credit::PrefixHash;
use maia_core::security::{SlotProvenance, Taint, request_provenance};
use maia_core::thread_cache::{
    ByteDigest, CompactionDecision, CompactionError, CompactionPolicy, CompactionRecord,
    CompactionSlot, CompactionState, CompactionTrigger, CurrentUser, DEFAULT_CENTROID_WINDOW,
    DEFAULT_CONSECUTIVE_TURNS, DEFAULT_MIN_INTERVAL_TURNS, DEFAULT_UNUSED_TURN_WINDOW,
    InstalledNote, MemoryBody, PersonaInput, ProvenanceLabel, RecallLineage, RecallPackPolicy,
    ReplayedThread, SectionInput, SlotKind, TranscriptTurn, TurnRole, UnfixableReason,
    append_recall, apply_compaction, compact, compile_prompt, mean_cosine_distance, should_compact,
};

fn digest_hex(bytes: &[u8]) -> PrefixHash {
    let mut encoded = String::new();
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    PrefixHash::new(encoded)
}

fn slot(
    id: &str,
    kind: SlotKind,
    heat: f64,
    tokens: u32,
    turns_since: u32,
    at: i64,
    text: &str,
) -> CompactionSlot {
    CompactionSlot {
        id: SlotId::new(id),
        kind,
        canonical_text: text.to_owned(),
        heat,
        installed_at: Timestamp(at),
        token_cost: tokens,
        turns_since_use: turns_since,
    }
}

fn base_policy() -> CompactionPolicy {
    CompactionPolicy {
        centroid_distance_threshold: 0.5,
        consecutive_turns: 2,
        centroid_window: 8,
        unused_slot_turn_window: 6,
        min_interval_turns: 3,
        memory_budget_tokens: 10,
        transcript_budget_tokens: 10,
        slot_heat_floor: 1.0,
    }
}

fn with_window(window: u32) -> CompactionPolicy {
    let mut policy = base_policy();
    policy.centroid_window = window;
    policy
}

fn with_memory_budget(budget: u32) -> CompactionPolicy {
    let mut policy = base_policy();
    policy.memory_budget_tokens = budget;
    policy
}

fn with_budgets(memory: u32, transcript: u32) -> CompactionPolicy {
    let mut policy = base_policy();
    policy.memory_budget_tokens = memory;
    policy.transcript_budget_tokens = transcript;
    policy
}

fn with_nan_threshold() -> CompactionPolicy {
    let mut policy = base_policy();
    policy.centroid_distance_threshold = f64::NAN;
    policy
}

fn state(
    distances: &[f64],
    turns_since: u32,
    slots: Vec<CompactionSlot>,
    transcript_tokens: u32,
) -> CompactionState {
    CompactionState {
        turns_since_compaction: turns_since,
        recent_mean_distances: distances.to_vec(),
        slots,
        transcript_tokens,
    }
}

#[test]
fn documented_compaction_defaults() {
    assert_eq!(DEFAULT_CONSECUTIVE_TURNS, 2);
    assert_eq!(DEFAULT_CENTROID_WINDOW, 8);
    assert_eq!(DEFAULT_UNUSED_TURN_WINDOW, 6);
    assert_eq!(DEFAULT_MIN_INTERVAL_TURNS, 3);
}

#[test]
fn mean_cosine_distance_is_one_minus_similarity() {
    let mean = mean_cosine_distance(&[1.0, 0.0], &[vec![1.0, 0.0], vec![0.0, 1.0]]).expect("mean");
    assert_eq!(mean, 0.5);
    let identical = mean_cosine_distance(&[3.0, 0.0], &[vec![3.0, 0.0]]).expect("identical");
    assert_eq!(identical, 0.0);
    assert_eq!(
        mean_cosine_distance(&[1.0, 0.0], &[vec![1.0, 0.0, 0.0]]).expect_err("dim"),
        CompactionError::DimensionMismatch
    );
    assert_eq!(
        mean_cosine_distance(&[0.0, 0.0], &[vec![0.0, 0.0]]).expect_err("zero"),
        CompactionError::ZeroVector
    );
    assert_eq!(
        mean_cosine_distance(&[1.0], &[]).expect_err("empty"),
        CompactionError::EmptyPoints
    );
    assert_eq!(
        mean_cosine_distance(&[1.0, f64::NAN], &[vec![1.0, 0.0]]).expect_err("nan"),
        CompactionError::NonFinite
    );
}

#[test]
fn each_trigger_and_boundary_is_independent() {
    let standard = base_policy();
    let quiet = slot("note", SlotKind::MemoryNote, 2.0, 1, 0, 1, "n\n");
    let cases = [
        (
            "drift",
            state(&[0.1, 0.9, 0.9], 3, vec![quiet.clone()], 1),
            standard.clone(),
            CompactionDecision::Triggered {
                triggers: vec![CompactionTrigger::CentroidDrift],
            },
        ),
        (
            "drift ended",
            state(&[0.9, 0.9, 0.1], 3, vec![quiet.clone()], 1),
            standard.clone(),
            CompactionDecision::Hold,
        ),
        (
            "threshold equal",
            state(&[0.5, 0.5], 3, vec![quiet.clone()], 1),
            standard.clone(),
            CompactionDecision::Hold,
        ),
        (
            "outside window",
            state(&[0.9, 0.1, 0.1], 3, vec![quiet.clone()], 1),
            with_window(2),
            CompactionDecision::Hold,
        ),
        (
            "unused at six",
            state(
                &[],
                3,
                vec![slot("note", SlotKind::MemoryNote, 2.0, 1, 6, 1, "n\n")],
                1,
            ),
            standard.clone(),
            CompactionDecision::Triggered {
                triggers: vec![CompactionTrigger::UnusedInstalledMemory],
            },
        ),
        (
            "unused at five",
            state(
                &[],
                3,
                vec![slot("note", SlotKind::MemoryNote, 2.0, 1, 5, 1, "n\n")],
                1,
            ),
            standard.clone(),
            CompactionDecision::Hold,
        ),
        (
            "transcript age is not unused memory",
            state(
                &[],
                3,
                vec![slot(
                    "user:t1",
                    SlotKind::TranscriptTurn,
                    0.0,
                    50,
                    100,
                    1,
                    "t\n",
                )],
                1,
            ),
            standard.clone(),
            CompactionDecision::Hold,
        ),
        (
            "memory over",
            state(
                &[],
                3,
                vec![
                    slot("note", SlotKind::MemoryNote, 2.0, 6, 0, 1, "n\n"),
                    slot("memory", SlotKind::CompactedMemory, 2.0, 4, 0, 1, "m\n"),
                ],
                1,
            ),
            with_memory_budget(9),
            CompactionDecision::Triggered {
                triggers: vec![CompactionTrigger::MemoryBudget],
            },
        ),
        (
            "memory equal",
            state(
                &[],
                3,
                vec![
                    slot("note", SlotKind::MemoryNote, 2.0, 6, 0, 1, "n\n"),
                    slot("memory", SlotKind::CompactedMemory, 2.0, 4, 0, 1, "m\n"),
                ],
                1,
            ),
            base_policy(),
            CompactionDecision::Hold,
        ),
        (
            "transcript tokens do not count as memory",
            state(
                &[],
                3,
                vec![slot(
                    "user:t1",
                    SlotKind::TranscriptTurn,
                    0.0,
                    1_000,
                    0,
                    1,
                    "t\n",
                )],
                1,
            ),
            standard.clone(),
            CompactionDecision::Hold,
        ),
        (
            "interval blocks a real trigger",
            state(
                &[],
                2,
                vec![slot("note", SlotKind::MemoryNote, 2.0, 1, 6, 1, "n\n")],
                1,
            ),
            standard.clone(),
            CompactionDecision::IntervalNotElapsed {
                turns_since: 2,
                required: 3,
            },
        ),
        (
            "transcript over budget",
            state(
                &[],
                3,
                vec![slot("note", SlotKind::MemoryNote, 2.0, 1, 6, 1, "n\n")],
                11,
            ),
            standard.clone(),
            CompactionDecision::Unfixable {
                reason: UnfixableReason::TranscriptOverBudget,
            },
        ),
        (
            "transcript equal to budget",
            state(&[], 3, vec![quiet.clone()], 10),
            standard.clone(),
            CompactionDecision::Hold,
        ),
        (
            "nan threshold",
            state(&[], 3, vec![quiet.clone()], 1),
            with_nan_threshold(),
            CompactionDecision::InvalidPolicy,
        ),
    ];

    for (name, sample, sample_policy, expected) in cases {
        assert_eq!(should_compact(&sample, &sample_policy), expected, "{name}");
    }
}

#[test]
fn several_triggers_keep_a_stable_order() {
    let decision = should_compact(
        &state(
            &[0.9, 0.9],
            3,
            vec![slot("note", SlotKind::MemoryNote, 2.0, 20, 6, 1, "n\n")],
            1,
        ),
        &base_policy(),
    );
    assert_eq!(
        decision,
        CompactionDecision::Triggered {
            triggers: vec![
                CompactionTrigger::CentroidDrift,
                CompactionTrigger::UnusedInstalledMemory,
                CompactionTrigger::MemoryBudget,
            ],
        }
    );
}

#[test]
fn compact_packs_by_heat_then_time_then_id_and_regroups_by_id() {
    let policy = with_budgets(8, 100);
    let decision = CompactionDecision::Triggered {
        triggers: vec![CompactionTrigger::MemoryBudget],
    };
    let slots = vec![
        slot("b", SlotKind::MemoryNote, 10.0, 4, 0, 1, "B\n"),
        slot("a", SlotKind::MemoryNote, 1.0, 4, 0, 1, "A\n"),
        slot("c", SlotKind::MemoryNote, 0.5, 4, 0, 1, "C\n"),
        slot(
            "user:t1",
            SlotKind::TranscriptTurn,
            9.0,
            100,
            0,
            1,
            "turn\n",
        ),
    ];
    let record = compact(&slots, &decision, &policy).expect("pack both hot notes");
    assert_eq!(record.survivors, vec![SlotId::new("a"), SlotId::new("b")]);
    assert_eq!(record.removed, vec![SlotId::new("c")]);
    assert_eq!(record.canonical_body, "A\nB\n");
    assert_eq!(record.triggers, vec![CompactionTrigger::MemoryBudget]);
    let again = compact(&slots, &decision, &policy).expect("deterministic");
    assert_eq!(record, again);

    let tighter = with_budgets(4, 100);
    let hotter = compact(&slots, &decision, &tighter).expect("higher heat");
    assert_eq!(hotter.survivors, vec![SlotId::new("b")]);
    assert_eq!(hotter.canonical_body, "B\n");

    let tied = vec![
        slot("b", SlotKind::MemoryNote, 5.0, 4, 0, 1, "B\n"),
        slot("a", SlotKind::MemoryNote, 5.0, 4, 0, 9, "A\n"),
    ];
    let newer = compact(&tied, &decision, &tighter).expect("newer");
    assert_eq!(newer.survivors, vec![SlotId::new("a")]);

    let same_time = vec![
        slot("b", SlotKind::MemoryNote, 5.0, 4, 0, 1, "B\n"),
        slot("a", SlotKind::MemoryNote, 5.0, 4, 0, 1, "A\n"),
    ];
    let lower_id = compact(&same_time, &decision, &tighter).expect("id");
    assert_eq!(lower_id.survivors, vec![SlotId::new("a")]);
}

#[test]
fn nothing_fits_refuses_without_changing_slots() {
    let policy = with_budgets(10, 100);
    let decision = CompactionDecision::Triggered {
        triggers: vec![CompactionTrigger::MemoryBudget],
    };
    let slots = vec![slot("a", SlotKind::MemoryNote, 5.0, 100, 0, 1, "A\n")];
    let before = slots.clone();
    let error = compact(&slots, &decision, &policy).expect_err("unfixable");
    assert_eq!(
        error,
        CompactionError::Unfixable(UnfixableReason::NothingFits)
    );
    assert_eq!(slots, before);
}

#[test]
fn below_floor_notes_can_clear_without_rewriting_transcript() {
    let policy = with_budgets(10, 100);
    let decision = CompactionDecision::Triggered {
        triggers: vec![CompactionTrigger::UnusedInstalledMemory],
    };
    let slots = vec![
        slot("a", SlotKind::MemoryNote, 0.4, 100, 6, 1, "A\n"),
        slot("user:t1", SlotKind::TranscriptTurn, 0.0, 1, 0, 1, "turn\n"),
    ];
    let record = compact(&slots, &decision, &policy).expect("clear");
    assert!(record.survivors.is_empty());
    assert_eq!(record.canonical_body, "");
    assert_eq!(record.removed, vec![SlotId::new("a")]);
}

#[test]
fn transcript_decision_refuses_rewrite() {
    let policy = base_policy();
    let slots = vec![slot("a", SlotKind::MemoryNote, 5.0, 1, 0, 1, "A\n")];
    let before = slots.clone();
    let decision = CompactionDecision::Unfixable {
        reason: UnfixableReason::TranscriptOverBudget,
    };
    assert_eq!(
        compact(&slots, &decision, &policy).expect_err("transcript"),
        CompactionError::Unfixable(UnfixableReason::TranscriptOverBudget)
    );
    assert_eq!(slots, before);
    assert_eq!(
        compact(&slots, &CompactionDecision::Hold, &policy,).expect_err("hold"),
        CompactionError::DecisionNotActionable
    );
}

#[test]
fn applied_compaction_replays_identical_bytes_and_a_failed_apply_does_not() {
    let log = sample_log();
    let before = compile_prompt(&log, ByteDigest::from_fn(digest_hex)).expect("before");
    let forged = CompactionRecord {
        survivors: vec![SlotId::new("user:t1")],
        removed: Vec::new(),
        canonical_body: "rewritten".to_owned(),
        triggers: vec![CompactionTrigger::MemoryBudget],
    };
    assert_eq!(
        apply_compaction(&log, &forged).expect_err("forged"),
        CompactionError::RefusedTranscriptRewrite
    );
    let still = compile_prompt(&log, ByteDigest::from_fn(digest_hex)).expect("still");
    assert_eq!(still.bytes, before.bytes);
    assert_eq!(still.hash, before.hash);

    let record = CompactionRecord {
        survivors: vec![SlotId::new("mem:fact_a")],
        removed: Vec::new(),
        canonical_body: "A\n".to_owned(),
        triggers: vec![CompactionTrigger::UnusedInstalledMemory],
    };
    let applied = apply_compaction(&log, &record).expect("apply");
    let first = compile_prompt(&applied, ByteDigest::from_fn(digest_hex)).expect("once");
    let second = compile_prompt(&applied, ByteDigest::from_fn(digest_hex)).expect("twice");
    assert_eq!(first.bytes, second.bytes);
    assert_eq!(first.hash, second.hash);
    assert!(first.bytes.contains("## memory\nA\n"));
    assert!(!first.bytes.contains("kept sentence"));
    assert!(first.bytes.contains("ack"));
    assert!(before.bytes.contains("kept sentence"));
}

#[test]
fn compacted_survivor_stays_out_of_later_recall() {
    let mut log = sample_log();
    log.notes[0].memory = Some(MemoryRef::Fact(FactId::new("fact_a")));
    let record = CompactionRecord {
        survivors: vec![SlotId::new("mem:fact_a")],
        removed: Vec::new(),
        canonical_body: "A\n".to_owned(),
        triggers: vec![CompactionTrigger::UnusedInstalledMemory],
    };
    let applied = apply_compaction(&log, &record).expect("apply");
    let prefix = compile_prompt(&applied, ByteDigest::from_fn(digest_hex)).expect("compile");
    let packed = append_recall(
        &prefix,
        &[RankedPath {
            walked: vec![NodeId::Claim(ClaimId::new("walk"))],
            item: RecallItem::Fact {
                fact_id: FactId::new("fact_a"),
            },
            sentence: "should stay out".to_owned(),
            taint: Taint::Trusted,
            scores: ComponentScores {
                activation: None,
                pagerank: 0.0,
                embedding: None,
                combined: 1.0,
                tie_break: "fact_a".to_owned(),
            },
        }],
        &RecallPackPolicy {
            token_budget: 200,
            taint_mode: RecallTaintMode::IncludeUntrusted,
            lineage: RecallLineage {
                consolidated_claims: std::collections::BTreeMap::new(),
                fact_sources: std::collections::BTreeMap::new(),
            },
        },
        |text| u32::try_from(text.chars().count()).expect("tokens"),
        ByteDigest::from_fn(digest_hex),
    )
    .expect("recall");
    assert!(!packed.recall_bytes.contains("should stay out"));
}

fn provenance_note(id: &str, taint: Taint, label: Option<ProvenanceLabel>) -> InstalledNote {
    InstalledNote {
        id: SlotId::new(id),
        item_id: id.trim_start_matches("mem:").to_owned(),
        text: id.to_owned(),
        cursor_after: SlotId::new("assistant:a1"),
        memory: None,
        episode: None,
        taint,
        label,
        version: 1,
        heat: 1.0,
    }
}

fn compiled_memory_after(
    notes: Vec<InstalledNote>,
    body: &str,
) -> maia_core::thread_cache::CompiledSlot {
    let mut log = sample_log();
    log.notes = notes;
    let survivors = log.notes.iter().map(|note| note.id.clone()).collect();
    let record = CompactionRecord {
        survivors,
        removed: Vec::new(),
        canonical_body: body.to_owned(),
        triggers: vec![CompactionTrigger::UnusedInstalledMemory],
    };
    let applied = apply_compaction(&log, &record).expect("apply");
    let compiled = compile_prompt(&applied, ByteDigest::from_fn(digest_hex)).expect("compile");
    compiled
        .slots
        .into_iter()
        .find(|slot| slot.kind == SlotKind::CompactedMemory)
        .expect("memory slot")
}

#[test]
fn compacted_memory_joins_survivor_taint_without_reading_bytes() {
    let mixed_labels = compiled_memory_after(
        vec![
            provenance_note("mem:web", Taint::Untrusted, Some(ProvenanceLabel::Web)),
            provenance_note(
                "mem:console",
                Taint::Untrusted,
                Some(ProvenanceLabel::Console),
            ),
        ],
        "WEB\nCONSOLE\n",
    );
    assert_eq!(mixed_labels.taint, Taint::Untrusted);
    assert_eq!(mixed_labels.label, Some(ProvenanceLabel::Join));
    assert_eq!(
        request_provenance(
            &[SlotProvenance {
                taint: mixed_labels.taint,
                sources: BTreeSet::new(),
            }],
            &[],
            &[],
        )
        .taint,
        Taint::Untrusted
    );
    assert_eq!(mixed_labels.canonical_text, "## memory\nWEB\nCONSOLE\n");

    let mixed_taint = compiled_memory_after(
        vec![
            provenance_note("mem:web", Taint::Untrusted, Some(ProvenanceLabel::Web)),
            provenance_note("mem:trusted", Taint::Trusted, None),
        ],
        "WEB\nTRUSTED\n",
    );
    assert_eq!(mixed_taint.taint, Taint::Untrusted);
    assert_eq!(mixed_taint.label, Some(ProvenanceLabel::Web));
    assert_eq!(
        request_provenance(
            &[SlotProvenance {
                taint: mixed_taint.taint,
                sources: BTreeSet::new(),
            }],
            &[],
            &[],
        )
        .taint,
        Taint::Untrusted
    );

    let trusted = compiled_memory_after(
        vec![
            provenance_note("mem:one", Taint::Trusted, None),
            provenance_note("mem:two", Taint::Trusted, None),
        ],
        "ONE\nTWO\n",
    );
    assert_eq!(trusted.taint, Taint::Trusted);
    assert_eq!(trusted.label, None);
    assert_eq!(
        request_provenance(
            &[SlotProvenance {
                taint: trusted.taint,
                sources: BTreeSet::new(),
            }],
            &[],
            &[],
        )
        .taint,
        Taint::Trusted
    );
}

fn sample_log() -> ReplayedThread {
    let mut participants = BTreeSet::new();
    participants.insert(AgentId(1));
    ReplayedThread {
        version: 1,
        thread_id: ThreadId(5),
        participants,
        tools: section("tools", "{}"),
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
        notes: vec![maia_core::thread_cache::InstalledNote {
            id: SlotId::new("mem:fact_a"),
            item_id: "fact_a".to_owned(),
            text: "kept sentence".to_owned(),
            cursor_after: SlotId::new("assistant:a1"),
            memory: None,
            episode: None,
            taint: Taint::Trusted,
            label: None,
            version: 1,
            heat: 4.5,
        }],
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
