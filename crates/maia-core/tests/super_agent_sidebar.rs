use std::collections::BTreeSet;

use maia_core::security::Taint;
use maia_core::super_agent::*;

const UNPINNED_SECTIONS: &[(&str, &str, SidebarSection)] = &[
    ("waiting_for_user", "unopened", SidebarSection::NeedsYou),
    ("waiting_for_user", "open", SidebarSection::NeedsYou),
    ("waiting_for_user", "closed_once", SidebarSection::NeedsYou),
    ("blocked", "unopened", SidebarSection::NeedsYou),
    ("blocked", "open", SidebarSection::NeedsYou),
    ("blocked", "closed_once", SidebarSection::NeedsYou),
    ("failed", "unopened", SidebarSection::NeedsYou),
    ("failed", "open", SidebarSection::NeedsYou),
    ("failed", "closed_once", SidebarSection::NeedsYou),
    ("stopped", "unopened", SidebarSection::NeedsYou),
    ("stopped", "open", SidebarSection::NeedsYou),
    ("stopped", "closed_once", SidebarSection::NeedsYou),
    ("queued", "unopened", SidebarSection::Working),
    ("queued", "open", SidebarSection::Working),
    ("queued", "closed_once", SidebarSection::Working),
    ("running", "unopened", SidebarSection::Working),
    ("running", "open", SidebarSection::Working),
    ("running", "closed_once", SidebarSection::Working),
    ("completed", "unopened", SidebarSection::Completed),
    ("completed", "open", SidebarSection::Completed),
    ("completed", "closed_once", SidebarSection::Archive),
    ("cancelled", "unopened", SidebarSection::Archive),
    ("cancelled", "open", SidebarSection::Archive),
    ("cancelled", "closed_once", SidebarSection::Archive),
    ("abandoned", "unopened", SidebarSection::Archive),
    ("abandoned", "open", SidebarSection::Archive),
    ("abandoned", "closed_once", SidebarSection::Archive),
];

fn phase_categories() -> Vec<(&'static str, TaskPhase)> {
    vec![
        (
            "waiting_for_user",
            TaskPhase::WaitingForUser {
                reason: WaitReason::Clarification,
            },
        ),
        (
            "blocked",
            TaskPhase::Blocked {
                reason: BlockerId("b1".into()),
            },
        ),
        (
            "failed",
            TaskPhase::Failed {
                attempt: AttemptId("a1".into()),
                kind: FailureKind::WorkerReported,
            },
        ),
        ("queued", TaskPhase::Queued),
        (
            "running",
            TaskPhase::Running {
                attempt: AttemptId("a1".into()),
            },
        ),
        (
            "completed",
            TaskPhase::Completed {
                evidence: EvidenceSetId("set-1".into()),
            },
        ),
        (
            "stopped",
            TaskPhase::Stopped {
                command: CommandId(3),
            },
        ),
        (
            "cancelled",
            TaskPhase::Cancelled {
                command: CommandId(4),
            },
        ),
        (
            "abandoned",
            TaskPhase::Abandoned {
                decision: DecisionId("d1".into()),
            },
        ),
    ]
}

fn view_categories() -> Vec<(&'static str, CompletionView)> {
    vec![
        ("unopened", CompletionView::Unopened),
        (
            "open",
            CompletionView::Open {
                detail: DetailSessionId("d1".into()),
            },
        ),
        ("closed_once", CompletionView::ClosedOnce),
    ]
}

fn unpinned_section(phase: &str, view: &str) -> SidebarSection {
    UNPINNED_SECTIONS
        .iter()
        .find_map(|(phase_name, view_name, section)| {
            (*phase_name == phase && *view_name == view).then_some(*section)
        })
        .unwrap_or_else(|| panic!("missing unpinned cell {phase} x {view}"))
}

fn completed() -> TaskPhase {
    TaskPhase::Completed {
        evidence: EvidenceSetId("set-1".into()),
    }
}

fn wait_phases() -> Vec<TaskPhase> {
    [
        WaitReason::Clarification,
        WaitReason::TaskQuestion {
            report: ReportId("r1".into()),
        },
        WaitReason::WaiverNeeded {
            criterion: CriterionId("c1".into()),
        },
        WaitReason::UnknownExternalOutcome {
            attempt: AttemptId("a1".into()),
            call: CallId("call-1".into()),
        },
        WaitReason::Approval {
            request: HumanRequestId(3),
        },
        WaitReason::TranscriptBudget,
        WaitReason::Settled {
            report: ReportId("r1".into()),
        },
    ]
    .into_iter()
    .map(|reason| TaskPhase::WaitingForUser { reason })
    .collect()
}

fn failure_phases() -> Vec<TaskPhase> {
    [
        FailureKind::WorkerReported,
        FailureKind::BudgetExhausted,
        FailureKind::AttemptFailed,
    ]
    .into_iter()
    .map(|kind| TaskPhase::Failed {
        attempt: AttemptId("a1".into()),
        kind,
    })
    .collect()
}

fn assert_same_section(phases: &[TaskPhase], label: &str) {
    assert!(phases.len() >= 2, "{label} needs two payloads to compare");
    let pins = [PinMark::Pinned, PinMark::Unpinned];
    let views = view_categories();
    let first = &phases[0];
    for phase in phases.iter().skip(1) {
        for pin in pins {
            for (_, view) in &views {
                assert_eq!(
                    place_sidebar(phase, pin, view),
                    place_sidebar(first, pin, view),
                    "{label} payload changed the section"
                );
            }
        }
    }
}

fn ranked_rows() -> Vec<RankedMemory> {
    let fact = RankedMemory {
        memory: MemoryId("fact-1".into()),
        sentence: "Pins stay visible".into(),
        provenance: MemoryProvenance::Fact {
            fact: FactId::new("fact-1"),
        },
        trust: Taint::Untrusted,
    };
    let exact_duplicate = fact.clone();
    let mut same_id = fact.clone();
    same_id.sentence = "Pins stay visible ".into();
    same_id.trust = Taint::Trusted;
    same_id.provenance = MemoryProvenance::Fact {
        fact: FactId::new("fact-other"),
    };
    vec![
        fact,
        RankedMemory {
            memory: MemoryId("ep-9".into()),
            sentence: "  Episode stays.  ".into(),
            provenance: MemoryProvenance::Episode {
                episode: EpisodeId::new("episode-9"),
                thread: ThreadId(7),
            },
            trust: Taint::Trusted,
        },
        RankedMemory {
            memory: MemoryId("claim-2".into()),
            sentence: "Cafe\u{0301} claim".into(),
            provenance: MemoryProvenance::Claim {
                claim: ClaimId::new("claim-2"),
            },
            trust: Taint::Untrusted,
        },
        same_id,
        RankedMemory {
            memory: MemoryId("claim-empty".into()),
            sentence: String::new(),
            provenance: MemoryProvenance::Claim {
                claim: ClaimId::new("claim-empty"),
            },
            trust: Taint::Trusted,
        },
        RankedMemory {
            memory: MemoryId("ep-long".into()),
            sentence: "n".repeat(280),
            provenance: MemoryProvenance::Episode {
                episode: EpisodeId::new("episode-long"),
                thread: ThreadId(8),
            },
            trust: Taint::Untrusted,
        },
        exact_duplicate,
    ]
}

#[test]
fn completed_unopened_stays_completed_until_close() {
    let phase = completed();
    assert_eq!(
        place_sidebar(&phase, PinMark::Unpinned, &CompletionView::Unopened),
        SidebarSection::Completed
    );
    assert_eq!(
        place_sidebar(
            &phase,
            PinMark::Unpinned,
            &CompletionView::Open {
                detail: DetailSessionId("d1".into()),
            }
        ),
        SidebarSection::Completed
    );
    assert_eq!(
        place_sidebar(&phase, PinMark::Unpinned, &CompletionView::ClosedOnce),
        SidebarSection::Archive
    );
}

#[test]
fn pin_wins_over_archive() {
    let phase = completed();
    assert_eq!(
        place_sidebar(&phase, PinMark::Pinned, &CompletionView::ClosedOnce),
        SidebarSection::Pinned
    );
}

#[test]
fn every_phase_pin_and_view_lands_in_exactly_one_section() {
    let phases = phase_categories();
    let views = view_categories();
    assert_eq!(phases.len(), 9, "one representative per TaskPhase variant");
    assert_eq!(
        views.len(),
        3,
        "one representative per CompletionView variant"
    );

    let mut table_keys = BTreeSet::new();
    for (phase_name, view_name, _) in UNPINNED_SECTIONS {
        assert!(
            table_keys.insert((*phase_name, *view_name)),
            "duplicate unpinned cell {phase_name} {view_name}"
        );
    }
    assert_eq!(table_keys.len(), phases.len() * views.len());

    let mut covered = BTreeSet::new();
    for (phase_name, phase) in &phases {
        for (view_name, view) in &views {
            assert!(
                table_keys.contains(&(*phase_name, *view_name)),
                "table missing {phase_name} {view_name}"
            );
            assert!(
                covered.insert((*phase_name, *view_name)),
                "category visited twice: {phase_name} {view_name}"
            );
            assert_eq!(
                place_sidebar(phase, PinMark::Unpinned, view),
                unpinned_section(phase_name, view_name),
                "unpinned {phase_name} {view_name}"
            );
            assert_eq!(
                place_sidebar(phase, PinMark::Pinned, view),
                SidebarSection::Pinned,
                "pinned {phase_name} {view_name}"
            );
        }
    }
    assert_eq!(covered.len(), 27);
}

#[test]
fn placement_returns_a_section_without_changing_phase_or_view() {
    for (_, phase) in phase_categories() {
        for pin in [PinMark::Pinned, PinMark::Unpinned] {
            for (_, view) in view_categories() {
                let phase_before = phase.clone();
                let view_before = view.clone();
                let pin_before = pin;
                let section: SidebarSection = place_sidebar(&phase, pin, &view);
                assert_eq!(phase, phase_before);
                assert_eq!(view, view_before);
                assert_eq!(pin, pin_before);
                assert_eq!(place_sidebar(&phase, pin, &view), section);
            }
        }
    }
}

#[test]
fn same_phase_category_places_alike_for_every_payload() {
    assert_same_section(&wait_phases(), "wait reason");
    assert_eq!(wait_phases().len(), 6);
    assert_same_section(&failure_phases(), "failure kind");
    assert_eq!(failure_phases().len(), 3);
    assert_same_section(
        &[
            TaskPhase::Running {
                attempt: AttemptId("a1".into()),
            },
            TaskPhase::Running {
                attempt: AttemptId("a9".into()),
            },
        ],
        "running attempt",
    );
    assert_same_section(
        &[
            TaskPhase::Blocked {
                reason: BlockerId("b1".into()),
            },
            TaskPhase::Blocked {
                reason: BlockerId("b9".into()),
            },
        ],
        "blocker",
    );
    assert_same_section(
        &[
            TaskPhase::Completed {
                evidence: EvidenceSetId("set-1".into()),
            },
            TaskPhase::Completed {
                evidence: EvidenceSetId("set-9".into()),
            },
        ],
        "completed evidence",
    );
    assert_same_section(
        &[
            TaskPhase::Cancelled {
                command: CommandId(1),
            },
            TaskPhase::Cancelled {
                command: CommandId(99),
            },
        ],
        "cancel command",
    );
    assert_same_section(
        &[
            TaskPhase::Abandoned {
                decision: DecisionId("d1".into()),
            },
            TaskPhase::Abandoned {
                decision: DecisionId("d9".into()),
            },
        ],
        "abandon decision",
    );

    let open_a = CompletionView::Open {
        detail: DetailSessionId("d1".into()),
    };
    let open_b = CompletionView::Open {
        detail: DetailSessionId("d9".into()),
    };
    for (_, phase) in phase_categories() {
        for pin in [PinMark::Pinned, PinMark::Unpinned] {
            assert_eq!(
                place_sidebar(&phase, pin, &open_a),
                place_sidebar(&phase, pin, &open_b),
                "detail id changed the section"
            );
        }
    }
}

#[test]
fn advisory_items_cannot_change_trust_or_drop_provenance() {
    let snapshot = SnapshotId("snap-1".into());
    let ranked = vec![RankedMemory {
        memory: MemoryId("fact-1".into()),
        sentence: "Pins stay visible".into(),
        provenance: MemoryProvenance::Fact {
            fact: FactId::new("fact-1"),
        },
        trust: Taint::Untrusted,
    }];
    let items = advisory_items(&snapshot, &ranked);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].snapshot, snapshot);
    assert_eq!(items[0].memory, MemoryId("fact-1".into()));
    assert_eq!(items[0].standing, AdvisoryStanding::Advisory);
    assert_eq!(items[0].trust, Taint::Untrusted);
    assert_eq!(items[0].sentence, "Pins stay visible");
    assert_eq!(
        items[0].provenance,
        MemoryProvenance::Fact {
            fact: FactId::new("fact-1"),
        }
    );
}

#[test]
fn advisory_items_preserve_order_count_provenance_and_trust() {
    let snapshot = SnapshotId("snap-7".into());
    let ranked = ranked_rows();
    assert!(
        ranked
            .iter()
            .any(|row| matches!(row.provenance, MemoryProvenance::Episode { .. }))
    );
    assert!(
        ranked
            .iter()
            .any(|row| matches!(row.provenance, MemoryProvenance::Claim { .. }))
    );
    assert!(
        ranked
            .iter()
            .any(|row| matches!(row.provenance, MemoryProvenance::Fact { .. }))
    );
    assert!(ranked.iter().any(|row| row.trust == Taint::Trusted));
    assert!(ranked.iter().any(|row| row.trust == Taint::Untrusted));
    assert!(ranked.iter().any(|row| row.sentence.contains('\u{0301}')));
    assert!(ranked.iter().any(|row| row.sentence.is_empty()));
    assert!(ranked.iter().any(|row| row.sentence.len() == 280));
    assert_eq!(
        ranked
            .iter()
            .filter(|row| row.memory == MemoryId("fact-1".into()))
            .count(),
        3
    );

    let items = advisory_items(&snapshot, &ranked);
    assert_eq!(items.len(), ranked.len());
    for (index, (item, row)) in items.iter().zip(ranked.iter()).enumerate() {
        assert_eq!(item.snapshot, snapshot, "snapshot {index}");
        assert_eq!(item.memory, row.memory, "memory {index}");
        assert_eq!(item.sentence, row.sentence, "sentence {index}");
        assert_eq!(item.provenance, row.provenance, "provenance {index}");
        assert_eq!(item.trust, row.trust, "trust {index}");
        assert_eq!(
            item.standing,
            AdvisoryStanding::Advisory,
            "standing {index}"
        );
    }
    assert_eq!(items[1].sentence, "  Episode stays.  ");
    assert_eq!(
        items[1].provenance,
        MemoryProvenance::Episode {
            episode: EpisodeId::new("episode-9"),
            thread: ThreadId(7),
        }
    );
    assert_eq!(items[2].sentence, "Cafe\u{0301} claim");
    assert_eq!(items[3].sentence, "Pins stay visible ");
    assert_eq!(items[3].trust, Taint::Trusted);
    assert_eq!(items[4].sentence, "");
    assert_eq!(items[5].sentence.len(), 280);
    assert_eq!(items[6], items[0]);
}

#[test]
fn advisory_items_empty_input_is_empty() {
    let snapshot = SnapshotId("snap-empty".into());
    assert_eq!(advisory_items(&snapshot, &[]), Vec::<ContextItem>::new());
}

#[test]
fn advisory_items_use_the_supplied_snapshot() {
    let ranked = vec![RankedMemory {
        memory: MemoryId("fact-1".into()),
        sentence: "Pins stay visible".into(),
        provenance: MemoryProvenance::Fact {
            fact: FactId::new("fact-1"),
        },
        trust: Taint::Untrusted,
    }];
    let first = SnapshotId("snap-a".into());
    let second = SnapshotId("snap-b".into());
    let from_first = advisory_items(&first, &ranked);
    let from_second = advisory_items(&second, &ranked);
    assert_eq!(from_first.len(), 1);
    assert_eq!(from_second.len(), 1);
    assert_eq!(from_first[0].snapshot, first);
    assert_eq!(from_second[0].snapshot, second);
    assert_ne!(from_first[0].snapshot, from_second[0].snapshot);
    assert_eq!(from_first[0].memory, from_second[0].memory);
    assert_eq!(from_first[0].sentence, from_second[0].sentence);
    assert_eq!(from_first[0].provenance, from_second[0].provenance);
    assert_eq!(from_first[0].trust, from_second[0].trust);
    assert_eq!(from_first[0].trust, Taint::Untrusted);
    assert_eq!(from_first[0].standing, AdvisoryStanding::Advisory);
    assert_eq!(from_second[0].standing, AdvisoryStanding::Advisory);
}

fn detail(id: &str) -> DetailSessionId {
    DetailSessionId(id.into())
}

fn open_view(id: &str) -> CompletionView {
    CompletionView::Open { detail: detail(id) }
}

fn open_event(id: &str) -> CompletionViewEvent {
    CompletionViewEvent::Open { detail: detail(id) }
}

fn assert_view_edge(
    current: &CompletionView,
    event: &CompletionViewEvent,
    expected: Result<CompletionView, CompletionViewError>,
) {
    let current_before = current.clone();
    let event_before = event.clone();
    assert_eq!(
        reduce_completion_view(current, event),
        expected,
        "{current:?} + {event:?}"
    );
    assert_eq!(current, &current_before);
    assert_eq!(event, &event_before);
}

fn admitted_view(current: &CompletionView, event: &CompletionViewEvent) -> CompletionView {
    match reduce_completion_view(current, event) {
        Ok(view) => view,
        Err(error) => panic!("expected an admitted view, got {error:?}"),
    }
}

#[test]
fn unopened_open_stores_the_supplied_detail() {
    assert_view_edge(
        &CompletionView::Unopened,
        &open_event("d1"),
        Ok(open_view("d1")),
    );
    assert_view_edge(
        &CompletionView::Unopened,
        &open_event("d9"),
        Ok(open_view("d9")),
    );
}

#[test]
fn open_close_moves_to_closed_once() {
    assert_view_edge(
        &open_view("d1"),
        &CompletionViewEvent::Close,
        Ok(CompletionView::ClosedOnce),
    );
    assert_view_edge(
        &open_view("d9"),
        &CompletionViewEvent::Close,
        Ok(CompletionView::ClosedOnce),
    );
}

#[test]
fn unopened_close_is_rejected() {
    assert_view_edge(
        &CompletionView::Unopened,
        &CompletionViewEvent::Close,
        Err(CompletionViewError::InvalidTransition),
    );
}

#[test]
fn second_open_is_rejected_without_replacing_detail() {
    let current = open_view("d1");
    assert_view_edge(
        &current,
        &open_event("d1"),
        Err(CompletionViewError::InvalidTransition),
    );
    assert_view_edge(
        &current,
        &open_event("d9"),
        Err(CompletionViewError::InvalidTransition),
    );
    assert_eq!(current, open_view("d1"));
    assert_eq!(
        place_sidebar(&completed(), PinMark::Unpinned, &current),
        SidebarSection::Completed
    );
}

#[test]
fn archived_task_can_open_and_close_without_leaving_archive() {
    let phase = completed();
    let current = CompletionView::ClosedOnce;
    for event in [
        open_event("d2"),
        open_event("d9"),
        CompletionViewEvent::Close,
    ] {
        let result = reduce_completion_view(&current, &event);
        assert_eq!(result, Ok(CompletionView::ClosedOnce), "{event:?}");
        let view = match result {
            Ok(view) => view,
            Err(error) => panic!("expected ClosedOnce, got {error:?}"),
        };
        assert_eq!(
            place_sidebar(&phase, PinMark::Unpinned, &view),
            SidebarSection::Archive,
            "{event:?}"
        );
        assert_eq!(
            place_sidebar(&phase, PinMark::Pinned, &view),
            SidebarSection::Pinned,
            "{event:?}"
        );
    }
    assert_eq!(current, CompletionView::ClosedOnce);
}

#[test]
fn reduced_closed_once_archives_unless_pinned() {
    let phase = completed();
    let opened = admitted_view(&CompletionView::Unopened, &open_event("d1"));
    assert_eq!(opened, open_view("d1"));
    assert_eq!(
        place_sidebar(&phase, PinMark::Unpinned, &opened),
        SidebarSection::Completed
    );
    assert_eq!(
        place_sidebar(&phase, PinMark::Pinned, &opened),
        SidebarSection::Pinned
    );

    let closed = admitted_view(&opened, &CompletionViewEvent::Close);
    assert_eq!(closed, CompletionView::ClosedOnce);
    assert_eq!(
        place_sidebar(&phase, PinMark::Unpinned, &closed),
        SidebarSection::Archive
    );
    assert_eq!(
        place_sidebar(&phase, PinMark::Pinned, &closed),
        SidebarSection::Pinned
    );

    let reopened = admitted_view(&closed, &open_event("d2"));
    assert_eq!(reopened, CompletionView::ClosedOnce);
    assert_eq!(
        place_sidebar(&phase, PinMark::Unpinned, &reopened),
        SidebarSection::Archive
    );
    let reclosed = admitted_view(&closed, &CompletionViewEvent::Close);
    assert_eq!(reclosed, CompletionView::ClosedOnce);
    assert_eq!(
        place_sidebar(&phase, PinMark::Pinned, &reclosed),
        SidebarSection::Pinned
    );
    assert_eq!(closed, CompletionView::ClosedOnce);
}
