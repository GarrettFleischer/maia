use std::collections::BTreeSet;

use maia_core::super_agent::*;

fn criterion(id: &str) -> Criterion {
    Criterion {
        id: CriterionId(id.into()),
        text: "pin control".into(),
        source: CriterionSource::UserText {
            message: MessageId("m1".into()),
            start: 6,
            end: 17,
        },
    }
}

fn satisfied(id: &str, evidence: &str) -> CriterionMark {
    CriterionMark::Satisfied {
        criterion: CriterionId(id.into()),
        evidence: EvidenceId(evidence.into()),
    }
}

fn pending(id: &str) -> CriterionMark {
    CriterionMark::Pending {
        criterion: CriterionId(id.into()),
    }
}

fn waived(id: &str, decision: &str) -> CriterionMark {
    CriterionMark::Waived {
        criterion: CriterionId(id.into()),
        decision: DecisionId(decision.into()),
    }
}

fn inapplicable(id: &str, source: CriterionSource) -> CriterionMark {
    CriterionMark::Inapplicable {
        criterion: CriterionId(id.into()),
        source,
    }
}

fn evidence(ids: &[&str]) -> BTreeSet<EvidenceId> {
    ids.iter().map(|id| EvidenceId((*id).into())).collect()
}

fn admit(criteria: &[Criterion], marks: &[CriterionMark], stored: &[&str]) -> EvidenceSetId {
    admit_completion(criteria, marks, &evidence(stored)).unwrap()
}

#[test]
fn satisfied_mark_requires_known_evidence() {
    let marks = vec![satisfied("c1", "e1")];
    let set = admit_completion(&[criterion("c1")], &marks, &evidence(&["e1"])).unwrap();
    assert_eq!(set, EvidenceSetId("c1:e1".into()));
}

#[test]
fn memory_id_is_not_evidence() {
    let marks = vec![satisfied("c1", "fact-1")];
    let error = admit_completion(&[criterion("c1")], &marks, &BTreeSet::new()).unwrap_err();
    assert_eq!(error, CompletionError::MissingEvidence);
}

#[test]
fn absent_evidence_id_is_missing_evidence() {
    let marks = vec![satisfied("c1", "e-missing")];
    let error = admit_completion(&[criterion("c1")], &marks, &evidence(&["e1"])).unwrap_err();
    assert_eq!(error, CompletionError::MissingEvidence);
}

#[test]
fn stored_evidence_id_satisfies_even_if_it_looks_like_memory() {
    let marks = vec![satisfied("c1", "fact-1")];
    let set = admit_completion(&[criterion("c1")], &marks, &evidence(&["fact-1"])).unwrap();
    assert_eq!(set, EvidenceSetId("c1:fact-1".into()));
}

#[test]
fn pending_criterion_rejects_completion() {
    let marks = vec![pending("c1")];
    let error = admit_completion(&[criterion("c1")], &marks, &BTreeSet::new()).unwrap_err();
    assert_eq!(error, CompletionError::Incomplete);
}

#[test]
fn pending_rejects_even_when_evidence_is_stored() {
    let marks = vec![pending("c1")];
    let error = admit_completion(&[criterion("c1")], &marks, &evidence(&["e1"])).unwrap_err();
    assert_eq!(error, CompletionError::Incomplete);
}

#[test]
fn missing_mark_rejects_completion() {
    let criteria = [criterion("c1"), criterion("c2")];
    let marks = vec![satisfied("c1", "e1")];
    let error = admit_completion(&criteria, &marks, &evidence(&["e1"])).unwrap_err();
    assert_eq!(error, CompletionError::MissingMark);
}

#[test]
fn duplicate_mark_rejects_completion() {
    let marks = vec![satisfied("c1", "e1"), waived("c1", "d1")];
    let error = admit_completion(&[criterion("c1")], &marks, &evidence(&["e1"])).unwrap_err();
    assert_eq!(error, CompletionError::DuplicateMark);
}

#[test]
fn unknown_mark_rejects_completion() {
    let marks = vec![satisfied("c1", "e1"), satisfied("c9", "e9")];
    let error = admit_completion(&[criterion("c1")], &marks, &evidence(&["e1", "e9"])).unwrap_err();
    assert_eq!(error, CompletionError::UnknownMark);
}

#[test]
fn duplicate_criterion_ids_reject_completion() {
    let criteria = [criterion("c1"), criterion("c1")];
    let marks = vec![satisfied("c1", "e1")];
    let error = admit_completion(&criteria, &marks, &evidence(&["e1"])).unwrap_err();
    assert_eq!(error, CompletionError::DuplicateCriterion);
}

#[test]
fn waived_contributes_waived_slot() {
    let marks = vec![waived("c1", "d-waive")];
    let set = admit_completion(&[criterion("c1")], &marks, &BTreeSet::new()).unwrap();
    assert_eq!(set, EvidenceSetId("c1:waived".into()));
}

#[test]
fn inapplicable_contributes_inapplicable_slot() {
    let criteria = [criterion("c1"), criterion("c2"), criterion("c3")];
    let marks = vec![
        inapplicable(
            "c3",
            CriterionSource::AcceptedDecision {
                decision: DecisionId("d1".into()),
            },
        ),
        inapplicable(
            "c1",
            CriterionSource::UserText {
                message: MessageId("m1".into()),
                start: 0,
                end: 4,
            },
        ),
        inapplicable(
            "c2",
            CriterionSource::BindingRule {
                rule: RuleId("r1".into()),
            },
        ),
    ];
    let set = admit_completion(&criteria, &marks, &BTreeSet::new()).unwrap();
    assert_eq!(
        set,
        EvidenceSetId("c1:inapplicable,c2:inapplicable,c3:inapplicable".into())
    );
}

#[test]
fn slots_follow_criterion_order() {
    let criteria = [criterion("c2"), criterion("c10"), criterion("c1")];
    let marks = vec![
        waived("c1", "d1"),
        satisfied("c10", "e10"),
        inapplicable(
            "c2",
            CriterionSource::BindingRule {
                rule: RuleId("r1".into()),
            },
        ),
    ];
    let set = admit_completion(&criteria, &marks, &evidence(&["e10"])).unwrap();
    assert_eq!(
        set,
        EvidenceSetId("c2:inapplicable,c10:e10,c1:waived".into())
    );
}

#[test]
fn empty_criteria_are_incomplete() {
    let error = admit_completion(&[], &[], &BTreeSet::new()).unwrap_err();
    assert_eq!(error, CompletionError::Incomplete);
}

#[test]
fn mixed_defects_use_fixed_priority() {
    let stray = vec![pending("c9"), satisfied("c1", "missing")];
    assert_eq!(
        admit_completion(&[], &stray, &BTreeSet::new()),
        Err(CompletionError::Incomplete)
    );

    let duplicated = [criterion("c1"), criterion("c1"), criterion("c2")];
    let duplicated_marks_a = vec![
        satisfied("c9", "missing"),
        pending("c2"),
        satisfied("c1", "e1"),
        satisfied("c1", "e1"),
    ];
    let duplicated_marks_b = vec![
        satisfied("c1", "e1"),
        satisfied("c1", "e1"),
        pending("c2"),
        satisfied("c9", "missing"),
    ];
    assert_eq!(
        admit_completion(&duplicated, &duplicated_marks_a, &BTreeSet::new()),
        Err(CompletionError::DuplicateCriterion)
    );
    assert_eq!(
        admit_completion(&duplicated, &duplicated_marks_b, &evidence(&["e1"])),
        Err(CompletionError::DuplicateCriterion)
    );

    let covered = [criterion("c1"), criterion("c2")];
    let unknown_a = vec![
        satisfied("c9", "e9"),
        satisfied("c1", "missing"),
        satisfied("c1", "e1"),
        pending("c2"),
    ];
    let unknown_b = vec![
        pending("c2"),
        satisfied("c1", "e1"),
        satisfied("c1", "missing"),
        satisfied("c8", "e8"),
    ];
    assert_eq!(
        admit_completion(&covered, &unknown_a, &evidence(&["e1"])),
        Err(CompletionError::UnknownMark)
    );
    assert_eq!(
        admit_completion(&covered, &unknown_b, &BTreeSet::new()),
        Err(CompletionError::UnknownMark)
    );

    let duplicate_marks_a = vec![
        satisfied("c1", "missing"),
        waived("c1", "d1"),
        pending("c2"),
    ];
    let duplicate_marks_b = vec![
        pending("c2"),
        waived("c1", "d1"),
        satisfied("c1", "missing"),
    ];
    assert_eq!(
        admit_completion(&covered, &duplicate_marks_a, &BTreeSet::new()),
        Err(CompletionError::DuplicateMark)
    );
    assert_eq!(
        admit_completion(&covered, &duplicate_marks_b, &evidence(&["missing"])),
        Err(CompletionError::DuplicateMark)
    );

    let missing_a = vec![pending("c1")];
    let missing_b = vec![satisfied("c2", "missing")];
    assert_eq!(
        admit_completion(&covered, &missing_a, &evidence(&["e1"])),
        Err(CompletionError::MissingMark)
    );
    assert_eq!(
        admit_completion(&covered, &missing_b, &BTreeSet::new()),
        Err(CompletionError::MissingMark)
    );

    let pending_first = vec![pending("c1"), satisfied("c2", "missing")];
    let evidence_first = vec![satisfied("c1", "missing"), pending("c2")];
    assert_eq!(
        admit_completion(&covered, &pending_first, &BTreeSet::new()),
        Err(CompletionError::Incomplete)
    );
    assert_eq!(
        admit_completion(&covered, &evidence_first, &evidence(&["e1"])),
        Err(CompletionError::Incomplete)
    );

    let both_missing_a = vec![satisfied("c1", "missing-a"), satisfied("c2", "missing-b")];
    let both_missing_b = vec![satisfied("c2", "missing-b"), satisfied("c1", "missing-a")];
    assert_eq!(
        admit_completion(&covered, &both_missing_a, &evidence(&["e1"])),
        Err(CompletionError::MissingEvidence)
    );
    assert_eq!(
        admit_completion(&covered, &both_missing_b, &BTreeSet::new()),
        Err(CompletionError::MissingEvidence)
    );
}

#[test]
fn evidence_set_id_collision_reserved_characters() {
    let colon_in_criterion = admit(&[criterion("p:q")], &[satisfied("p:q", "e")], &["e"]);
    let colon_in_evidence = admit(&[criterion("p")], &[satisfied("p", "q:e")], &["q:e"]);
    assert_ne!(colon_in_criterion, colon_in_evidence, "colon");
    assert_eq!(colon_in_criterion, EvidenceSetId("p%3Aq:e".into()));
    assert_eq!(colon_in_evidence, EvidenceSetId("p:q%3Ae".into()));

    let comma_joined = admit(
        &[criterion("a"), criterion("b")],
        &[satisfied("b", "d"), satisfied("a", "c")],
        &["c", "d"],
    );
    let comma_inside = admit(&[criterion("a:c,b")], &[satisfied("a:c,b", "d")], &["d"]);
    assert_ne!(comma_joined, comma_inside, "comma");
    assert_eq!(comma_joined, EvidenceSetId("a:c,b:d".into()));
    assert_eq!(comma_inside, EvidenceSetId("a%3Ac%2Cb:d".into()));

    let percent_in_criterion = admit(&[criterion("p%:q")], &[satisfied("p%:q", "e")], &["e"]);
    let percent_then_split = admit(&[criterion("p%")], &[satisfied("p%", "q:e")], &["q:e"]);
    assert_ne!(percent_in_criterion, percent_then_split, "percent");
    assert_eq!(percent_in_criterion, EvidenceSetId("p%25%3Aq:e".into()));
    assert_eq!(percent_then_split, EvidenceSetId("p%25:q%3Ae".into()));

    let literal_percent = admit(&[criterion("c1")], &[satisfied("c1", "%3A")], &["%3A"]);
    let encoded_colon = admit(&[criterion("c1")], &[satisfied("c1", ":")], &[":"]);
    assert_ne!(literal_percent, encoded_colon, "percent alias");
    assert_eq!(literal_percent, EvidenceSetId("c1:%253A".into()));
    assert_eq!(encoded_colon, EvidenceSetId("c1:%3A".into()));

    let forward = admit(
        &[criterion("b:x"), criterion("a,y")],
        &[satisfied("b:x", "e"), satisfied("a,y", "f")],
        &["e", "f"],
    );
    let reverse = admit(
        &[criterion("b:x"), criterion("a,y")],
        &[satisfied("a,y", "f"), satisfied("b:x", "e")],
        &["f", "e"],
    );
    assert_eq!(forward, reverse);
    assert_eq!(forward, EvidenceSetId("b%3Ax:e,a%2Cy:f".into()));
    assert_eq!(
        admit(&[criterion("c1")], &[satisfied("c1", "e1")], &["e1"]),
        EvidenceSetId("c1:e1".into())
    );
}

#[test]
fn evidence_set_id_collision_waived_sentinel() {
    let cited = admit(
        &[criterion("c1")],
        &[satisfied("c1", "waived")],
        &["waived"],
    );
    let waiver = admit(&[criterion("c1")], &[waived("c1", "d-waive")], &[]);
    assert_ne!(cited, waiver);
    assert_eq!(waiver, EvidenceSetId("c1:waived".into()));
    assert_eq!(cited, EvidenceSetId("c1:%77aived".into()));
    let literal_escape = admit(
        &[criterion("c1")],
        &[satisfied("c1", "%77aived")],
        &["%77aived"],
    );
    assert_ne!(cited, literal_escape, "percent alias");
    assert_eq!(literal_escape, EvidenceSetId("c1:%2577aived".into()));

    let cited_reserved = admit(
        &[criterion("a:b")],
        &[satisfied("a:b", "waived")],
        &["waived"],
    );
    let waiver_reserved = admit(&[criterion("a:b")], &[waived("a:b", "d1")], &[]);
    assert_ne!(cited_reserved, waiver_reserved);
    assert_eq!(waiver_reserved, EvidenceSetId("a%3Ab:waived".into()));
    assert_eq!(cited_reserved, EvidenceSetId("a%3Ab:%77aived".into()));
}

#[test]
fn evidence_set_id_collision_inapplicable_sentinel() {
    let source = CriterionSource::BindingRule {
        rule: RuleId("r1".into()),
    };
    let cited = admit(
        &[criterion("c1")],
        &[satisfied("c1", "inapplicable")],
        &["inapplicable"],
    );
    let marked = admit(
        &[criterion("c1")],
        &[inapplicable("c1", source.clone())],
        &[],
    );
    assert_ne!(cited, marked);
    assert_eq!(marked, EvidenceSetId("c1:inapplicable".into()));
    assert_eq!(cited, EvidenceSetId("c1:%69napplicable".into()));
    let literal_escape = admit(
        &[criterion("c1")],
        &[satisfied("c1", "%69napplicable")],
        &["%69napplicable"],
    );
    assert_ne!(cited, literal_escape, "percent alias");
    assert_eq!(literal_escape, EvidenceSetId("c1:%2569napplicable".into()));

    let cited_reserved = admit(
        &[criterion("a,b")],
        &[satisfied("a,b", "inapplicable")],
        &["inapplicable"],
    );
    let marked_reserved = admit(&[criterion("a,b")], &[inapplicable("a,b", source)], &[]);
    assert_ne!(cited_reserved, marked_reserved);
    assert_eq!(marked_reserved, EvidenceSetId("a%2Cb:inapplicable".into()));
    assert_eq!(cited_reserved, EvidenceSetId("a%2Cb:%69napplicable".into()));
}
