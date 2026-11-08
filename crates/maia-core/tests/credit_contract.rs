//! Attribution, co-use, and correction contracts from `docs/design/04-credit.md`.

use maia_core::agents::{PresentationId, ThreadId};
use maia_core::audit::{RequestId, Timestamp};
use maia_core::brain::{ClaimId, FactId, MemoryRef, RecallItem, SlotId};
use maia_core::credit::{
    Acceptance, AppliedLedger, Attributability, AttributionError, AttributionScope,
    CanonicalMessage, CorrectionEvidence, MessageId, PrefixHash, Presentation,
    ReasoningAvailability, RejectionReason, ScopedRecallItem, ScopedSlot, TextSpan, ToolTrace,
    UseSource, attribute_uses, co_use_updates, correction_mark,
};

fn hash(bytes: &str) -> PrefixHash {
    PrefixHash::new(bytes)
}

fn slot(id: &str, ordinal: u32, text: &str, fact: &str) -> ScopedSlot {
    ScopedSlot {
        id: SlotId::new(id),
        ordinal,
        canonical_text: text.to_owned(),
        memory: Some(MemoryRef::Fact(FactId::new(fact))),
    }
}

fn recall(fact: &str, text: &str) -> ScopedRecallItem {
    ScopedRecallItem {
        item: RecallItem::Fact {
            fact_id: FactId::new(fact),
        },
        canonical_text: text.to_owned(),
    }
}

fn scope_with_reasoning(text: &str, slots: Vec<ScopedSlot>) -> AttributionScope {
    AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(10),
        compiled_prefix_hash: hash("prefix-a"),
        slots,
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Available {
            text: text.to_owned(),
        },
        tools: Vec::new(),
        reply: String::new(),
    }
}

fn accepted_weights(
    ledger: &maia_core::credit::AttributionLedger,
) -> Vec<(String, f64, UseSource)> {
    ledger
        .presentations
        .iter()
        .map(|presentation| {
            let id = match &presentation.candidate {
                maia_core::credit::CandidateRef::Slot { slot_id, .. } => {
                    slot_id.as_str().to_owned()
                }
                maia_core::credit::CandidateRef::Recall { item } => match item {
                    RecallItem::Fact { fact_id } => fact_id.as_str().to_owned(),
                    RecallItem::Claim { claim_id } => claim_id.as_str().to_owned(),
                },
            };
            (id, presentation.weight, presentation.source)
        })
        .collect()
}

#[test]
fn absent_slot_receives_no_presentation() {
    let scope = scope_with_reasoning(
        "The project is named Bob's Best Burgers",
        vec![slot(
            "slot_other",
            0,
            "Unrelated resident note.",
            "fact_other",
        )],
    );
    let ledger = attribute_uses(&scope).expect("scope is consistent");
    assert!(
        ledger.presentations.is_empty(),
        "text matching a fact absent from ordinals must not credit: {:?}",
        ledger.presentations
    );
}

#[test]
fn reasoning_match_has_full_weight_and_spans() {
    let scope = scope_with_reasoning(
        "I used Bob's Best Burgers in the plan.",
        vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
    );
    let ledger = attribute_uses(&scope).expect("reasoning match");
    assert_eq!(
        accepted_weights(&ledger),
        vec![("slot_name".to_owned(), 1.0, UseSource::Reasoning)]
    );
    let matched = &ledger.matches[0];
    assert_eq!(matched.source_span, TextSpan { start: 0, end: 18 });
    assert_eq!(matched.evidence_span, TextSpan { start: 7, end: 25 });
    assert_eq!(ledger.heat[0].weight, 1.0);
    assert_eq!(ledger.brain_presentations.len(), 1);
}

#[test]
fn tool_argument_match_has_full_weight() {
    let scope = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(11),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Missing,
        tools: vec![ToolTrace {
            arguments: "query=Bob's Best Burgers".to_owned(),
            results: String::new(),
        }],
        reply: String::new(),
    };
    let ledger = attribute_uses(&scope).expect("tool-arg match");
    assert_eq!(
        accepted_weights(&ledger),
        vec![("slot_name".to_owned(), 1.0, UseSource::Tool)]
    );
}

#[test]
fn tool_result_only_match_has_zero_weight_and_no_presentation() {
    let scope = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(12),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Missing,
        tools: vec![ToolTrace {
            arguments: "query=other".to_owned(),
            results: "echo Bob's Best Burgers".to_owned(),
        }],
        reply: String::new(),
    };
    let ledger = attribute_uses(&scope).expect("tool-result only");
    assert!(ledger.presentations.is_empty());
    assert_eq!(ledger.matches[0].weight, 0.0);
    assert_eq!(
        ledger.matches[0].status,
        maia_core::credit::MatchStatus::Rejected {
            reason: RejectionReason::ToolResultOnly
        }
    );
    assert!(ledger.heat.is_empty());
    assert!(ledger.co_use.is_empty());
}

#[test]
fn eligible_reply_match_wins_over_tool_result_echo() {
    let scope = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(121),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Missing,
        tools: vec![ToolTrace {
            arguments: "query=other".to_owned(),
            results: "echo Bob's Best Burgers".to_owned(),
        }],
        reply: "We should visit Bob's Best Burgers.".to_owned(),
    };
    let ledger = attribute_uses(&scope).expect("eligible reply fallback");
    assert_eq!(
        accepted_weights(&ledger),
        vec![("slot_name".to_owned(), 0.5, UseSource::Reply)]
    );
}

#[test]
fn reply_only_is_half_weight_when_reasoning_is_missing() {
    let scope = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(13),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Missing,
        tools: Vec::new(),
        reply: "We should visit Bob's Best Burgers.".to_owned(),
    };
    let ledger = attribute_uses(&scope).expect("reply fallback");
    assert_eq!(
        accepted_weights(&ledger),
        vec![("slot_name".to_owned(), 0.5, UseSource::Reply)]
    );
}

#[test]
fn blank_reasoning_also_allows_reply_fallback() {
    let scope = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(14),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Blank,
        tools: Vec::new(),
        reply: "Bob's Best Burgers is open.".to_owned(),
    };
    let ledger = attribute_uses(&scope).expect("blank reasoning");
    assert_eq!(accepted_weights(&ledger)[0].1, 0.5);
}

#[test]
fn available_reasoning_does_not_award_reply_fallback() {
    let scope = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(15),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Available {
            text: "No memory was needed.".to_owned(),
        },
        tools: Vec::new(),
        reply: "We should visit Bob's Best Burgers.".to_owned(),
    };
    let ledger = attribute_uses(&scope).expect("no reply fallback");
    assert!(ledger.presentations.is_empty());
}

#[test]
fn unknown_reasoning_is_unattributable_and_skips_reply() {
    let scope = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(16),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Unknown,
        tools: Vec::new(),
        reply: "Bob's Best Burgers".to_owned(),
    };
    let ledger = attribute_uses(&scope).expect("unknown reasoning");
    assert_eq!(ledger.attributability, Attributability::Unattributable);
    assert!(ledger.presentations.is_empty());
}

#[test]
fn rejection_sentence_scores_zero() {
    let scope = scope_with_reasoning(
        "Bob's Best Burgers is incorrect.",
        vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
    );
    let ledger = attribute_uses(&scope).expect("rejection");
    assert!(ledger.presentations.is_empty());
    assert_eq!(ledger.matches[0].weight, 0.0);
    assert_eq!(
        ledger.matches[0].status,
        maia_core::credit::MatchStatus::Rejected {
            reason: RejectionReason::FactRejected
        }
    );
}

#[test]
fn source_priority_does_not_duplicate_one_use() {
    let scope = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(17),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Available {
            text: "Considering Bob's Best Burgers.".to_owned(),
        },
        tools: vec![ToolTrace {
            arguments: "Bob's Best Burgers".to_owned(),
            results: String::new(),
        }],
        reply: "Bob's Best Burgers".to_owned(),
    };
    let ledger = attribute_uses(&scope).expect("priority");
    assert_eq!(ledger.presentations.len(), 1);
    assert_eq!(ledger.presentations[0].source, UseSource::Reasoning);
    assert_eq!(ledger.presentations[0].weight, 1.0);
}

#[test]
fn recall_item_can_be_credited_but_does_not_accrue_heat() {
    let scope = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(18),
        compiled_prefix_hash: hash("prefix-a"),
        slots: Vec::new(),
        recall: vec![recall("fact_name", "Bob's Best Burgers")],
        reasoning: ReasoningAvailability::Available {
            text: "Considering Bob's Best Burgers.".to_owned(),
        },
        tools: Vec::new(),
        reply: String::new(),
    };
    let ledger = attribute_uses(&scope).expect("recall credit");
    assert_eq!(
        accepted_weights(&ledger),
        vec![("fact_name".to_owned(), 1.0, UseSource::Reasoning)]
    );
    assert!(ledger.heat.is_empty(), "recall does not accrue slot heat");
}

#[test]
fn opaque_signature_does_not_match_fact_text() {
    let scope = scope_with_reasoning(
        "opaque:sk-provider-signature-abc",
        vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
    );
    let ledger = attribute_uses(&scope).expect("opaque");
    assert!(ledger.presentations.is_empty());
    assert!(ledger.matches.is_empty());
}

#[test]
fn missing_hash_is_rejected() {
    let mut scope = scope_with_reasoning("x", vec![slot("slot_name", 0, "x", "fact_x")]);
    scope.compiled_prefix_hash = hash("");
    let error = attribute_uses(&scope).expect_err("empty hash");
    assert_eq!(error, AttributionError::MissingCompiledHash);
}

#[test]
fn duplicate_slot_identities_are_rejected() {
    let duplicate_id = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(20),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![
            slot("slot_name", 0, "A", "fact_a"),
            slot("slot_name", 1, "B", "fact_b"),
        ],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Missing,
        tools: Vec::new(),
        reply: String::new(),
    };
    assert_eq!(
        attribute_uses(&duplicate_id).expect_err("duplicate id"),
        AttributionError::DuplicateSlotId
    );
    let duplicate_ordinal = AttributionScope {
        thread_id: ThreadId(1),
        request_id: RequestId(21),
        compiled_prefix_hash: hash("prefix-a"),
        slots: vec![
            slot("slot_a", 0, "A", "fact_a"),
            slot("slot_b", 0, "B", "fact_b"),
        ],
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Missing,
        tools: Vec::new(),
        reply: String::new(),
    };
    assert_eq!(
        attribute_uses(&duplicate_ordinal).expect_err("duplicate ordinal"),
        AttributionError::DuplicateOrdinal
    );
}

#[test]
fn same_scope_is_idempotent() {
    let scope = scope_with_reasoning(
        "Considering Bob's Best Burgers.",
        vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
    );
    let first = attribute_uses(&scope).expect("first");
    let second = attribute_uses(&scope).expect("second");
    assert_eq!(first, second);
}

#[test]
fn two_full_uses_add_co_use_of_one() {
    let presentations = vec![
        Presentation {
            id: PresentationId(1),
            memory: MemoryRef::Fact(FactId::new("fact_a")),
            source: UseSource::Reasoning,
            weight: 1.0,
            acceptance: Acceptance::Accepted,
        },
        Presentation {
            id: PresentationId(2),
            memory: MemoryRef::Fact(FactId::new("fact_b")),
            source: UseSource::Tool,
            weight: 1.0,
            acceptance: Acceptance::Accepted,
        },
    ];
    let edges = co_use_updates(&presentations);
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].weight, 1.0);
    assert_eq!(edges[0].left, MemoryRef::Fact(FactId::new("fact_a")));
    assert_eq!(edges[0].right, MemoryRef::Fact(FactId::new("fact_b")));
}

#[test]
fn full_and_half_use_add_co_use_of_half() {
    let presentations = vec![
        Presentation {
            id: PresentationId(1),
            memory: MemoryRef::Claim(ClaimId::new("claim_a")),
            source: UseSource::Reasoning,
            weight: 1.0,
            acceptance: Acceptance::Accepted,
        },
        Presentation {
            id: PresentationId(2),
            memory: MemoryRef::Fact(FactId::new("fact_b")),
            source: UseSource::Reply,
            weight: 0.5,
            acceptance: Acceptance::Accepted,
        },
    ];
    let edges = co_use_updates(&presentations);
    assert_eq!(edges[0].weight, 0.5);
}

#[test]
fn resident_or_zero_uses_create_no_edge() {
    let presentations = vec![
        Presentation {
            id: PresentationId(1),
            memory: MemoryRef::Fact(FactId::new("fact_a")),
            source: UseSource::Tool,
            weight: 0.0,
            acceptance: Acceptance::Rejected,
        },
        Presentation {
            id: PresentationId(2),
            memory: MemoryRef::Fact(FactId::new("fact_b")),
            source: UseSource::Reply,
            weight: 0.5,
            acceptance: Acceptance::Rejected,
        },
    ];
    assert!(co_use_updates(&presentations).is_empty());
    assert!(co_use_updates(&[]).is_empty());
}

#[test]
fn attribute_uses_records_min_weight_co_use() {
    let scope = scope_with_reasoning(
        "Bob's Best Burgers and the secret sauce.",
        vec![
            slot("slot_name", 0, "Bob's Best Burgers", "fact_name"),
            slot("slot_sauce", 1, "secret sauce", "fact_sauce"),
        ],
    );
    let ledger = attribute_uses(&scope).expect("pair");
    assert_eq!(ledger.co_use.len(), 1);
    assert_eq!(ledger.co_use[0].weight, 1.0);
}

#[test]
fn next_message_correction_writes_hold_and_preserves_history() {
    let scope = scope_with_reasoning(
        "Considering Bob's Best Burgers.",
        vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
    );
    let ledger = attribute_uses(&scope).expect("prior use");
    let prior = AppliedLedger {
        thread_id: ledger.thread_id,
        request_id: ledger.request_id,
        presentations: ledger.presentations.clone(),
    };
    let marks = correction_mark(
        &prior,
        &CanonicalMessage {
            thread_id: ThreadId(1),
            message_id: MessageId(99),
            prior_request: RequestId(10),
            text: "Bob's Best Burgers is wrong.".to_owned(),
        },
        &[CorrectionEvidence {
            target: MemoryRef::Fact(FactId::new("fact_name")),
            span: TextSpan { start: 0, end: 18 },
        }],
        Timestamp(50),
    )
    .expect("next-message correction");
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0].target, MemoryRef::Fact(FactId::new("fact_name")));
    assert_eq!(marks[0].hold.since, Timestamp(50));
    assert_eq!(marks[0].presentation_id, prior.presentations[0].id);
    assert_eq!(prior.presentations.len(), 1, "history is not erased");
}

#[test]
fn later_or_unrelated_correction_is_not_attached() {
    let scope = scope_with_reasoning(
        "Considering Bob's Best Burgers.",
        vec![slot("slot_name", 0, "Bob's Best Burgers", "fact_name")],
    );
    let ledger = attribute_uses(&scope).expect("prior use");
    let prior = AppliedLedger {
        thread_id: ledger.thread_id,
        request_id: ledger.request_id,
        presentations: ledger.presentations.clone(),
    };
    let later = correction_mark(
        &prior,
        &CanonicalMessage {
            thread_id: ThreadId(1),
            message_id: MessageId(100),
            prior_request: RequestId(99),
            text: "Bob's Best Burgers is wrong.".to_owned(),
        },
        &[CorrectionEvidence {
            target: MemoryRef::Fact(FactId::new("fact_name")),
            span: TextSpan { start: 0, end: 18 },
        }],
        Timestamp(51),
    )
    .expect("later message");
    assert!(later.is_empty(), "later correction is not next-message");
    let unrelated = correction_mark(
        &prior,
        &CanonicalMessage {
            thread_id: ThreadId(1),
            message_id: MessageId(101),
            prior_request: RequestId(10),
            text: "Something else is wrong.".to_owned(),
        },
        &[CorrectionEvidence {
            target: MemoryRef::Fact(FactId::new("fact_other")),
            span: TextSpan { start: 0, end: 14 },
        }],
        Timestamp(51),
    )
    .expect("unrelated target");
    assert!(unrelated.is_empty());
}

#[test]
fn correction_rejects_span_outside_the_message() {
    let prior = AppliedLedger {
        thread_id: ThreadId(1),
        request_id: RequestId(10),
        presentations: Vec::new(),
    };
    let error = correction_mark(
        &prior,
        &CanonicalMessage {
            thread_id: ThreadId(1),
            message_id: MessageId(1),
            prior_request: RequestId(10),
            text: "short".to_owned(),
        },
        &[CorrectionEvidence {
            target: MemoryRef::Fact(FactId::new("fact_name")),
            span: TextSpan { start: 0, end: 40 },
        }],
        Timestamp(1),
    )
    .expect_err("invalid span");
    assert_eq!(error, AttributionError::InvalidSpan);
}
