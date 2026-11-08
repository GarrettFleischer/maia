use maia_core::agents::{CommandId, HumanRequestId, ThreadId};
use maia_core::brain::{ClaimId, EpisodeId};
use maia_core::super_agent::{
    AttemptId, BudgetCeiling, ChildAssignmentDraft, ChildId, Confidence, ConfidenceError,
    CriterionSource, GrantCeiling, GrantKey, MemoryProvenance, MessageId, RouteDecision,
    SessionTranscript, SnapshotId, SourcedSlice, TaskId, TaskInput, TurnSource, UserPromptBytes,
    WaitReason,
};
use std::collections::BTreeSet;

#[test]
fn confidence_rejects_values_above_one_thousand() {
    let error = Confidence::from_thousandths(1001).expect_err("1001");
    assert_eq!(error, ConfidenceError::OutOfRange);
}

#[test]
fn confidence_accepts_boundaries() {
    assert_eq!(Confidence::from_thousandths(0).unwrap().thousandths(), 0);
    assert_eq!(
        Confidence::from_thousandths(1000).unwrap().thousandths(),
        1000
    );
}

#[test]
fn memory_provenance_uses_brain_and_scheduler_thread_ids() {
    let claim = MemoryProvenance::Claim {
        claim: ClaimId::new("claim_1"),
    };
    assert!(matches!(claim, MemoryProvenance::Claim { .. }));

    let episode = MemoryProvenance::Episode {
        episode: EpisodeId::new("ep_1"),
        thread: ThreadId(7),
    };
    assert!(matches!(
        episode,
        MemoryProvenance::Episode {
            thread: ThreadId(7),
            ..
        }
    ));
}

#[test]
fn host_control_and_approval_use_agent_ids() {
    let source = TurnSource::HostControl {
        command: CommandId(99),
    };
    assert_eq!(
        source,
        TurnSource::HostControl {
            command: CommandId(99)
        }
    );

    let wait = WaitReason::Approval {
        request: HumanRequestId(42),
    };
    assert_eq!(
        wait,
        WaitReason::Approval {
            request: HumanRequestId(42)
        }
    );
}

#[test]
fn byte_bearing_debug_redacts_payload() {
    const SENTINEL: &str = "super-secret-prompt";
    let bytes = SENTINEL.as_bytes().to_vec();

    let cases: Vec<String> = vec![
        format!(
            "{:?}",
            UserPromptBytes {
                message: MessageId("m1".into()),
                utf8: bytes.clone(),
            }
        ),
        format!(
            "{:?}",
            TaskInput {
                task: TaskId("task-1".into()),
                message: MessageId("m2".into()),
                utf8: bytes.clone(),
                admitted: RouteDecision::CreateTask,
            }
        ),
        format!(
            "{:?}",
            SourcedSlice {
                source: CriterionSource::UserText {
                    message: MessageId("m1".into()),
                    start: 0,
                    end: bytes.len() as u32,
                },
                utf8: bytes.clone(),
            }
        ),
        format!(
            "{:?}",
            SessionTranscript {
                utf8: bytes.clone(),
            }
        ),
    ];

    for debug in cases {
        assert!(
            !debug.contains(SENTINEL),
            "debug must not leak payload: {debug}"
        );
        assert!(
            debug.contains("byte_len"),
            "debug must expose byte length: {debug}"
        );
    }
}

#[test]
fn child_assignment_draft_uses_grant_ceiling() {
    let grants = BTreeSet::from([GrantKey("shell".into())]);
    let draft = ChildAssignmentDraft {
        child: ChildId("child-1".into()),
        parent: TaskId("task-1".into()),
        parent_attempt: AttemptId("a1".into()),
        subgoal: SourcedSlice {
            source: CriterionSource::UserText {
                message: MessageId("m1".into()),
                start: 0,
                end: 3,
            },
            utf8: b"sub".to_vec(),
        },
        envelope_slices: vec![],
        context: SnapshotId("snap-1".into()),
        ceiling: GrantCeiling {
            grants: grants.clone(),
        },
        budget: BudgetCeiling {
            router_tokens: 10,
            tool_turns: 1,
        },
    };
    assert_eq!(draft.ceiling.grants, grants);
}
