use std::collections::BTreeSet;

use maia_core::security::SecurityProfile;
use maia_core::super_agent::*;

fn prompt() -> Vec<u8> {
    b"Add a pin control".to_vec()
}

fn envelope() -> TaskEnvelope {
    TaskEnvelope {
        id: EnvelopeId("env-1".into()),
        task: TaskId("task-1".into()),
        origin_attempt: AttemptId("a1".into()),
        original_prompt: UserPromptBytes {
            message: MessageId("m1".into()),
            utf8: prompt(),
        },
        brief: AdvisoryBrief("invented brief".into()),
        criteria: vec![
            Criterion {
                id: CriterionId("c1".into()),
                text: "pin control".into(),
                source: CriterionSource::UserText {
                    message: MessageId("m1".into()),
                    start: 6,
                    end: 17,
                },
            },
            Criterion {
                id: CriterionId("c-rule".into()),
                text: "keep the pin".into(),
                source: CriterionSource::BindingRule {
                    rule: RuleId("rule-1".into()),
                },
            },
            Criterion {
                id: CriterionId("c-decision".into()),
                text: "owner waived color".into(),
                source: CriterionSource::AcceptedDecision {
                    decision: DecisionId("dec-2".into()),
                },
            },
        ],
        constraints: vec![
            Constraint {
                text: "no network".into(),
                source: CriterionSource::AcceptedDecision {
                    decision: DecisionId("dec-1".into()),
                },
            },
            Constraint {
                text: "stay local".into(),
                source: CriterionSource::BindingRule {
                    rule: RuleId("rule-2".into()),
                },
            },
        ],
        context: SnapshotId("snap-parent".into()),
        routing_reason: RoutingReason("new goal".into()),
        assumptions: vec![Assumption("guess the color".into())],
        question_log: vec![ResolvedQuestion {
            decision: DecisionId("dec-unsealed".into()),
        }],
    }
}

fn grants(keys: &[&str]) -> BTreeSet<GrantKey> {
    keys.iter().map(|key| GrantKey((*key).into())).collect()
}

fn budget(tokens: u64, turns: u32) -> BudgetCeiling {
    BudgetCeiling {
        router_tokens: tokens,
        tool_turns: turns,
    }
}

fn user_slice(message: &str, start: u32, end: u32, utf8: &[u8]) -> SourcedSlice {
    SourcedSlice {
        source: CriterionSource::UserText {
            message: MessageId(message.into()),
            start,
            end,
        },
        utf8: utf8.to_vec(),
    }
}

fn rule_slice(rule: &str, utf8: &[u8]) -> SourcedSlice {
    SourcedSlice {
        source: CriterionSource::BindingRule {
            rule: RuleId(rule.into()),
        },
        utf8: utf8.to_vec(),
    }
}

fn decision_slice(decision: &str, utf8: &[u8]) -> SourcedSlice {
    SourcedSlice {
        source: CriterionSource::AcceptedDecision {
            decision: DecisionId(decision.into()),
        },
        utf8: utf8.to_vec(),
    }
}

fn draft(ceiling: BTreeSet<GrantKey>, tokens: u64) -> ChildAssignmentDraft {
    ChildAssignmentDraft {
        child: ChildId("child-1".into()),
        parent: TaskId("task-1".into()),
        parent_attempt: AttemptId("a1".into()),
        subgoal: user_slice("m1", 4, 17, b"a pin control"),
        envelope_slices: vec![],
        context: SnapshotId("snap-parent".into()),
        ceiling: GrantCeiling { grants: ceiling },
        budget: budget(tokens, 1),
    }
}

fn admit(
    parent: &TaskEnvelope,
    assignment: &ChildAssignmentDraft,
    parent_grants: &BTreeSet<GrantKey>,
    parent_budget: BudgetCeiling,
    depth: u32,
    max_depth: u32,
) -> Result<ChildAssignment, NarrowError> {
    narrow_child(
        parent,
        assignment,
        parent_grants,
        parent_budget,
        depth,
        &ChildPolicy { max_depth },
    )
}

#[test]
fn router_has_no_tools_when_unrestricted() {
    for profile in [
        SecurityProfile::Protected,
        SecurityProfile::Allowlisted,
        SecurityProfile::Unrestricted,
    ] {
        let tools: BTreeSet<GrantKey> = execution_tools(&SessionRole::Router, profile);
        assert!(tools.is_empty(), "{profile:?}");
    }
}

#[test]
fn task_roles_have_no_execution_tools_from_this_leaf() {
    let roles = [
        SessionRole::ParentTask {
            task: TaskId("task-1".into()),
        },
        SessionRole::ChildTask {
            task: TaskId("task-1".into()),
            child: ChildId("child-1".into()),
        },
    ];
    for role in &roles {
        for profile in [
            SecurityProfile::Protected,
            SecurityProfile::Allowlisted,
            SecurityProfile::Unrestricted,
        ] {
            let tools: BTreeSet<GrantKey> = execution_tools(role, profile);
            assert!(tools.is_empty(), "{role:?} {profile:?}");
        }
    }
}

#[test]
fn child_depth_accepts_boundary_and_rejects_one_past() {
    let parent = envelope();
    let parent_grants = grants(&["shell"]);
    let parent_budget = budget(40, 1);
    let assignment = draft(grants(&["shell"]), 10);
    let child = admit(&parent, &assignment, &parent_grants, parent_budget, 3, 3).unwrap();
    assert_eq!(child.child, ChildId("child-1".into()));
    let at_zero = admit(&parent, &assignment, &parent_grants, parent_budget, 0, 0).unwrap();
    assert_eq!(at_zero.child, assignment.child);
    let error = admit(&parent, &assignment, &parent_grants, parent_budget, 4, 3).unwrap_err();
    assert_eq!(error, NarrowError::DepthExceeded);
}

#[test]
fn child_grants_empty_and_equal_are_accepted() {
    let parent = envelope();
    let parent_budget = budget(40, 1);
    let empty = admit(
        &parent,
        &draft(BTreeSet::new(), 10),
        &grants(&["shell"]),
        parent_budget,
        1,
        3,
    )
    .unwrap();
    assert!(empty.ceiling.grants.is_empty());
    let equal = admit(
        &parent,
        &draft(grants(&["shell"]), 10),
        &grants(&["shell"]),
        parent_budget,
        1,
        3,
    )
    .unwrap();
    assert_eq!(equal.ceiling.grants, grants(&["shell"]));
}

#[test]
fn child_grant_outside_parent_is_rejected() {
    let parent = envelope();
    let parent_grants = grants(&["shell"]);
    let parent_budget = budget(40, 1);
    let error = admit(
        &parent,
        &draft(grants(&["browser"]), 10),
        &parent_grants,
        parent_budget,
        1,
        3,
    )
    .unwrap_err();
    assert_eq!(error, NarrowError::GrantWidened);
    let widened = grants(&["shell", "browser"]);
    let error = admit(
        &parent,
        &draft(widened, 10),
        &parent_grants,
        parent_budget,
        1,
        3,
    )
    .unwrap_err();
    assert_eq!(error, NarrowError::GrantWidened);
    let child = admit(
        &parent,
        &draft(grants(&["shell"]), 10),
        &parent_grants,
        parent_budget,
        1,
        3,
    )
    .unwrap();
    assert_eq!(child.child, ChildId("child-1".into()));
    assert_eq!(child.ceiling.grants, grants(&["shell"]));
}

#[test]
fn child_budget_exact_remainder_is_accepted() {
    let parent = envelope();
    let assignment = draft(grants(&["shell"]), 40);
    let child = admit(
        &parent,
        &assignment,
        &grants(&["shell"]),
        budget(40, 1),
        1,
        3,
    )
    .unwrap();
    assert_eq!(child.budget, assignment.budget);
}

#[test]
fn child_budget_above_parent_is_rejected() {
    let error = admit(
        &envelope(),
        &draft(grants(&["shell"]), 50),
        &grants(&["shell"]),
        budget(40, 1),
        1,
        3,
    )
    .unwrap_err();
    assert_eq!(error, NarrowError::BudgetWidened);
}

#[test]
fn child_tool_turns_above_remainder_are_rejected() {
    let mut assignment = draft(grants(&["shell"]), 40);
    assignment.budget.tool_turns = 2;
    let error = admit(
        &envelope(),
        &assignment,
        &grants(&["shell"]),
        budget(40, 1),
        1,
        3,
    )
    .unwrap_err();
    assert_eq!(error, NarrowError::BudgetWidened);
}

#[test]
fn draft_parent_must_equal_envelope_task() {
    let mut assignment = draft(grants(&["shell"]), 10);
    assignment.parent = TaskId("task-2".into());
    let error = admit(
        &envelope(),
        &assignment,
        &grants(&["shell"]),
        budget(40, 1),
        1,
        3,
    )
    .unwrap_err();
    assert_eq!(error, NarrowError::ParentMismatch);
}

#[test]
fn user_text_must_cite_the_envelope_message_and_exact_span() {
    let parent = envelope();
    let parent_grants = grants(&["shell"]);
    let parent_budget = budget(40, 1);
    let mut assignment = draft(grants(&["shell"]), 10);
    assignment.subgoal = user_slice("m1", 6, 17, b"pin control");
    let child = admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap();
    assert_eq!(child.subgoal.utf8, b"pin control");

    assignment.subgoal = user_slice("other", 4, 17, b"a pin control");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.subgoal = user_slice("m1", 4, 17, b"a pin controls");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.subgoal = user_slice("m1", 5, 4, b"");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.subgoal = user_slice("m1", 4, 100, b"a pin control");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.subgoal = user_slice("m1", 100, 101, b"x");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.subgoal = user_slice("m1", u32::MAX, u32::MAX, b"");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
}

#[test]
fn user_text_byte_span_does_not_panic_on_utf8_boundaries() {
    let text = "Add a café pin";
    let utf8 = text.as_bytes();
    let split = utf8
        .windows(2)
        .position(|pair| pair == [0xC3, 0xA9])
        .expect("é");
    let start = u32::try_from(split).unwrap();
    let mut parent = envelope();
    parent.original_prompt.utf8 = utf8.to_vec();
    let parent_grants = grants(&["shell"]);
    let parent_budget = budget(40, 1);
    let mut assignment = draft(grants(&["shell"]), 10);

    assignment.subgoal = user_slice("m1", start, start + 1, &[0xC3]);
    assert!(admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).is_ok());
    assignment.subgoal = user_slice("m1", start, start + 2, &[0xC3, 0xA9]);
    assert!(admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).is_ok());
    assignment.subgoal = user_slice("m1", start, start, b"");
    assert!(admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).is_ok());
    assignment.subgoal = user_slice("m1", 0, u32::MAX, utf8);
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
}

#[test]
fn binding_rule_and_decision_must_match_sealed_bytes() {
    let parent = envelope();
    let parent_grants = grants(&["shell"]);
    let parent_budget = budget(40, 1);
    let mut assignment = draft(grants(&["shell"]), 10);

    assignment.subgoal = rule_slice("rule-1", b"keep the pin");
    assert!(admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).is_ok());
    assignment.subgoal = rule_slice("rule-2", b"stay local");
    assert!(admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).is_ok());
    assignment.subgoal = decision_slice("dec-1", b"no network");
    assert!(admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).is_ok());
    assignment.subgoal = decision_slice("dec-2", b"owner waived color");
    assert!(admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).is_ok());

    assignment.subgoal = rule_slice("rule-1", b"keep the pins");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.subgoal = rule_slice("rule-9", b"keep the pin");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.subgoal = decision_slice("dec-1", b"no networks");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.subgoal = decision_slice("dec-unsealed", b"no network");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.subgoal = rule_slice("rule-1", b"no network");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
}

#[test]
fn extra_envelope_slice_mismatch_is_rejected() {
    let parent = envelope();
    let parent_grants = grants(&["shell"]);
    let parent_budget = budget(40, 1);
    let mut assignment = draft(grants(&["shell"]), 10);
    assignment.envelope_slices = vec![
        rule_slice("rule-1", b"keep the pin"),
        decision_slice("dec-1", b"network"),
    ];
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );

    assignment.envelope_slices = vec![
        rule_slice("rule-1", b"keep the pin"),
        decision_slice("dec-1", b"no network"),
    ];
    let child = admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap();
    assert_eq!(child.envelope_slices, assignment.envelope_slices);
}

#[test]
fn advisory_brief_assumption_and_context_are_not_slice_sources() {
    let parent = envelope();
    let parent_grants = grants(&["shell"]);
    let parent_budget = budget(40, 1);
    let mut assignment = draft(grants(&["shell"]), 10);
    let brief = parent.brief.0.as_bytes();
    let brief_len = u32::try_from(brief.len()).unwrap();
    assignment.subgoal = user_slice("m1", 0, brief_len, brief);
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );

    assignment.subgoal = rule_slice("assumption", parent.assumptions[0].0.as_bytes());
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
    assignment.envelope_slices = vec![rule_slice("assumption", parent.assumptions[0].0.as_bytes())];
    assignment.subgoal = user_slice("m1", 4, 17, b"a pin control");
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );

    let context = parent.context.0.as_bytes();
    let context_len = u32::try_from(context.len()).unwrap();
    assignment.envelope_slices.clear();
    assignment.subgoal = user_slice("m1", 0, context_len, context);
    assert_eq!(
        admit(&parent, &assignment, &parent_grants, parent_budget, 1, 3).unwrap_err(),
        NarrowError::SliceMismatch
    );
}

#[test]
fn admitted_child_copies_draft_without_widening() {
    let parent = envelope();
    let mut assignment = draft(grants(&["shell"]), 10);
    assignment.parent_attempt = AttemptId("a-later".into());
    assignment.context = SnapshotId("snap-child".into());
    assignment.budget.tool_turns = 0;
    assignment.envelope_slices = vec![
        rule_slice("rule-2", b"stay local"),
        decision_slice("dec-2", b"owner waived color"),
        user_slice("m1", 0, 3, b"Add"),
    ];
    let child = admit(
        &parent,
        &assignment,
        &grants(&["shell", "browser"]),
        budget(40, 1),
        3,
        3,
    )
    .unwrap();
    assert_eq!(
        child,
        ChildAssignment {
            child: assignment.child.clone(),
            parent: assignment.parent.clone(),
            parent_attempt: assignment.parent_attempt.clone(),
            subgoal: assignment.subgoal.clone(),
            envelope_slices: assignment.envelope_slices.clone(),
            context: assignment.context.clone(),
            ceiling: assignment.ceiling.clone(),
            budget: assignment.budget,
        }
    );
    assert_ne!(child.parent_attempt, parent.origin_attempt);
    assert_ne!(child.context, parent.context);
    assert!(!child.ceiling.grants.contains(&GrantKey("browser".into())));
}

/// First defect wins: parent task, depth, slices (subgoal then envelope order), grants, budget.
#[test]
fn narrow_child_error_priority_is_stable() {
    let parent = envelope();
    let parent_grants = grants(&["shell"]);
    let parent_budget = budget(40, 1);
    let mut assignment = draft(grants(&["browser"]), 50);
    assignment.parent = TaskId("other-task".into());
    assignment.subgoal = user_slice("m1", 0, 3, b"NOPE");
    assignment.budget.tool_turns = 9;
    assignment.envelope_slices = vec![rule_slice("missing", b"keep the pin")];

    let error = |assignment: &ChildAssignmentDraft, depth: u32| {
        admit(&parent, assignment, &parent_grants, parent_budget, depth, 3).unwrap_err()
    };

    assert_eq!(error(&assignment, 9), NarrowError::ParentMismatch);
    assignment.parent = TaskId("task-1".into());
    assert_eq!(error(&assignment, 9), NarrowError::DepthExceeded);
    assert_eq!(error(&assignment, 3), NarrowError::SliceMismatch);
    assignment.subgoal = user_slice("m1", 4, 17, b"a pin control");
    assert_eq!(error(&assignment, 3), NarrowError::SliceMismatch);
    assignment.envelope_slices.clear();
    assert_eq!(error(&assignment, 3), NarrowError::GrantWidened);
    assignment.ceiling.grants = grants(&["shell"]);
    assert_eq!(error(&assignment, 3), NarrowError::BudgetWidened);
    assignment.budget.router_tokens = 40;
    assert_eq!(error(&assignment, 3), NarrowError::BudgetWidened);
}
