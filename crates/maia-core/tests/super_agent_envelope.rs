use std::collections::BTreeMap;

use maia_core::super_agent::*;

fn message(bytes: &[u8]) -> UserPromptBytes {
    UserPromptBytes {
        message: MessageId("m1".into()),
        utf8: bytes.to_vec(),
    }
}

fn message_with_id(id: &str, bytes: &[u8]) -> UserPromptBytes {
    UserPromptBytes {
        message: MessageId(id.into()),
        utf8: bytes.to_vec(),
    }
}

/// Minimal draft that seals when admitted bytes and empty rule/decision maps match.
fn valid_sealable_draft(bytes: &[u8]) -> EnvelopeDraft {
    EnvelopeDraft {
        id: EnvelopeId("env-keep".into()),
        task: TaskId("task-1".into()),
        origin_attempt: AttemptId("a1".into()),
        original_prompt: message(bytes),
        brief: AdvisoryBrief("label only".into()),
        criteria: vec![Criterion {
            id: CriterionId("c1".into()),
            text: "pin control".into(),
            source: CriterionSource::UserText {
                message: MessageId("m1".into()),
                start: 6,
                end: 17,
            },
        }],
        constraints: vec![],
        context: SnapshotId("snapshot-keep".into()),
        assumptions: vec![],
        question_log: vec![],
        open_question_count: 0,
        routing_reason: RoutingReason("new goal".into()),
    }
}

#[test]
fn seal_keeps_exact_prompt_bytes() {
    let bytes = b"Add a pin control".to_vec();
    let draft = EnvelopeDraft {
        id: EnvelopeId("env-1".into()),
        task: TaskId("task-1".into()),
        origin_attempt: AttemptId("a1".into()),
        original_prompt: message(&bytes),
        brief: AdvisoryBrief("label only".into()),
        criteria: vec![Criterion {
            id: CriterionId("c1".into()),
            text: "pin control".into(),
            source: CriterionSource::UserText {
                message: MessageId("m1".into()),
                start: 6,
                end: 17,
            },
        }],
        constraints: vec![],
        context: SnapshotId("snapshot-1".into()),
        assumptions: vec![],
        question_log: vec![],
        open_question_count: 0,
        routing_reason: RoutingReason("new goal".into()),
    };
    let sealed =
        seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap();
    assert_eq!(sealed.original_prompt.utf8, bytes);
    assert_eq!(&sealed.original_prompt.utf8[6..17], b"pin control");
}

#[test]
fn unsourced_criterion_is_rejected() {
    let bytes = b"Add a pin control".to_vec();
    let mut draft = EnvelopeDraft {
        id: EnvelopeId("env-1".into()),
        task: TaskId("task-1".into()),
        origin_attempt: AttemptId("a1".into()),
        original_prompt: message(&bytes),
        brief: AdvisoryBrief("invent a dashboard".into()),
        criteria: vec![Criterion {
            id: CriterionId("c1".into()),
            text: "dashboard".into(),
            source: CriterionSource::UserText {
                message: MessageId("m1".into()),
                start: 0,
                end: 9,
            },
        }],
        constraints: vec![],
        context: SnapshotId("snapshot-1".into()),
        assumptions: vec![],
        question_log: vec![],
        open_question_count: 0,
        routing_reason: RoutingReason("new goal".into()),
    };
    let error =
        seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap_err();
    assert_eq!(error, SealError::SpanMismatch);
    draft.criteria.clear();
    draft.open_question_count = 1;
    let error =
        seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap_err();
    assert_eq!(error, SealError::UnresolvedQuestion);
}

#[test]
fn valid_source_id_with_different_text_is_rejected() {
    let bytes = b"Use the accepted rules".to_vec();
    let rule = RuleId("rule-1".into());
    let decision = DecisionId("decision-1".into());
    let mut draft = EnvelopeDraft {
        id: EnvelopeId("env-2".into()),
        task: TaskId("task-2".into()),
        origin_attempt: AttemptId("a1".into()),
        original_prompt: message(&bytes),
        brief: AdvisoryBrief("label only".into()),
        criteria: vec![Criterion {
            id: CriterionId("c1".into()),
            text: "invented rule text".into(),
            source: CriterionSource::BindingRule { rule: rule.clone() },
        }],
        constraints: vec![],
        context: SnapshotId("snapshot-2".into()),
        assumptions: vec![],
        question_log: vec![ResolvedQuestion {
            decision: decision.clone(),
        }],
        open_question_count: 0,
        routing_reason: RoutingReason("new goal".into()),
    };
    let rules = BTreeMap::from([(rule, BindingText("actual rule text".into()))]);
    let decisions = BTreeMap::from([(decision, BindingText("actual decision text".into()))]);
    assert_eq!(
        seal_envelope(&draft, &message(&bytes), &rules, &decisions).unwrap_err(),
        SealError::SourceTextMismatch
    );

    draft.criteria[0] = Criterion {
        id: CriterionId("c1".into()),
        text: "invented decision text".into(),
        source: CriterionSource::AcceptedDecision {
            decision: DecisionId("decision-1".into()),
        },
    };
    assert_eq!(
        seal_envelope(&draft, &message(&bytes), &rules, &decisions).unwrap_err(),
        SealError::SourceTextMismatch
    );
}

#[test]
fn recall_query_is_prompt_plus_brief() {
    let prompt = message(b"Add a pin control");
    let text = recall_query_text(&prompt, &AdvisoryBrief("label only".into())).unwrap();
    assert_eq!(text, "Add a pin control\nlabel only");
}

#[test]
fn seal_rejects_admitted_message_id_mismatch() {
    let bytes = b"Add a pin control".to_vec();
    let draft = valid_sealable_draft(&bytes);
    let admitted = message_with_id("m2", &bytes);
    assert_eq!(
        seal_envelope(&draft, &admitted, &BTreeMap::new(), &BTreeMap::new()).unwrap_err(),
        SealError::PromptMismatch
    );
}

#[test]
fn seal_rejects_admitted_bytes_mismatch() {
    let bytes = b"Add a pin control".to_vec();
    let draft = valid_sealable_draft(&bytes);
    let admitted = message(b"Add a pin control!");
    assert_eq!(
        seal_envelope(&draft, &admitted, &BTreeMap::new(), &BTreeMap::new()).unwrap_err(),
        SealError::PromptMismatch
    );
}

#[test]
fn recall_query_rejects_invalid_utf8_prompt() {
    let prompt = UserPromptBytes {
        message: MessageId("m1".into()),
        utf8: vec![0xff, 0xfe],
    };
    assert_eq!(
        recall_query_text(&prompt, &AdvisoryBrief("label only".into())).unwrap_err(),
        SealError::PromptNotUtf8
    );
}

#[test]
fn constraint_user_text_span_mismatch_is_rejected() {
    let bytes = b"Add a pin control".to_vec();
    let mut draft = valid_sealable_draft(&bytes);
    draft.criteria.clear();
    draft.constraints.push(Constraint {
        text: "dashboard".into(),
        source: CriterionSource::UserText {
            message: MessageId("m1".into()),
            start: 0,
            end: 9,
        },
    });
    assert_eq!(
        seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap_err(),
        SealError::SpanMismatch
    );
}

#[test]
fn binding_rule_missing_from_map_is_rejected() {
    let bytes = b"Use the accepted rules".to_vec();
    let mut draft = valid_sealable_draft(&bytes);
    draft.criteria = vec![Criterion {
        id: CriterionId("c1".into()),
        text: "stored rule text".into(),
        source: CriterionSource::BindingRule {
            rule: RuleId("rule-missing".into()),
        },
    }];
    assert_eq!(
        seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap_err(),
        SealError::MissingRule
    );
}

#[test]
fn resolved_question_missing_decision_is_rejected() {
    let bytes = b"Add a pin control".to_vec();
    let mut draft = valid_sealable_draft(&bytes);
    draft.question_log = vec![ResolvedQuestion {
        decision: DecisionId("decision-missing".into()),
    }];
    assert_eq!(
        seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap_err(),
        SealError::MissingDecision
    );
}

#[test]
fn seal_preserves_draft_id_and_context() {
    let bytes = b"Add a pin control".to_vec();
    let draft = valid_sealable_draft(&bytes);
    let sealed =
        seal_envelope(&draft, &message(&bytes), &BTreeMap::new(), &BTreeMap::new()).unwrap();
    assert_eq!(sealed.id, EnvelopeId("env-keep".into()));
    assert_eq!(sealed.context, SnapshotId("snapshot-keep".into()));
}
