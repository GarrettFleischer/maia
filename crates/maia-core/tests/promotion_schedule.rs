//! Promotion admission: one call, ceilings, quarantine, and no tool port.

use maia_core::audit::Timestamp;
use maia_core::brain::EpisodeId;
use maia_core::dream::{
    CallKind, CallTarget, DEFAULT_PROMOTION_FAILURE_LIMIT, EpisodeLedger, NoTools,
    OrchestrationPort, PanicLatch, PendingPromotion, PromotionAdmission, PromotionPolicy,
    PromotionQueue, PromotionSchedule, QuarantineChannel, RunnerOccupancy, ScheduleSkip,
    StructuredCall, note_promotion_failure, plan_promotion_call, promotion_orchestration_ports,
    release_quarantine, schedule_promotion,
};

fn policy() -> PromotionPolicy {
    PromotionPolicy {
        failure_limit: DEFAULT_PROMOTION_FAILURE_LIMIT,
        daily_ceiling: 2,
        input_byte_cap: 8,
    }
}

fn pending(id: &str, at: i64, failures: u32, bytes: usize) -> PendingPromotion {
    PendingPromotion {
        id: EpisodeId::new(id),
        committed_at: Timestamp(at),
        failures,
        input_bytes: bytes,
        text: format!("exchange {id}"),
    }
}

fn queue<'a>(
    pending: &'a [PendingPromotion],
    occupancy: RunnerOccupancy,
    calls_today: u32,
    latch: PanicLatch,
    policy: &'a PromotionPolicy,
) -> PromotionQueue<'a> {
    PromotionQueue {
        pending,
        occupancy,
        calls_today,
        latch,
        policy,
    }
}

#[test]
fn schedules_one_oldest_pending_episode_and_describes_one_toolless_call() {
    assert_eq!(DEFAULT_PROMOTION_FAILURE_LIMIT, 3);
    let policy = policy();
    let pending = vec![
        pending("episode_b", 20, 0, 4),
        pending("episode_a", 10, 0, 4),
    ];
    let schedule = schedule_promotion(&queue(
        &pending,
        RunnerOccupancy::Idle,
        0,
        PanicLatch::Clear,
        &policy,
    ));
    assert_eq!(
        schedule,
        PromotionSchedule::One(EpisodeId::new("episode_a"))
    );
    assert_eq!(
        plan_promotion_call(&EpisodeId::new("episode_a")),
        StructuredCall {
            kind: CallKind::Promotion,
            target: CallTarget::Episode(EpisodeId::new("episode_a")),
            tool_host: NoTools,
        }
    );
    assert_eq!(pending[0].text, "exchange episode_b");
    assert_eq!(pending[1].text, "exchange episode_a");
}

#[test]
fn refuses_a_second_call_when_busy_panicked_or_over_ceiling() {
    let policy = policy();
    let pending = vec![pending("episode_a", 10, 0, 4)];
    let cases = [
        (
            RunnerOccupancy::Busy,
            0,
            PanicLatch::Clear,
            ScheduleSkip::Busy,
        ),
        (
            RunnerOccupancy::Idle,
            0,
            PanicLatch::Engaged,
            ScheduleSkip::Panic,
        ),
        (
            RunnerOccupancy::Idle,
            2,
            PanicLatch::Clear,
            ScheduleSkip::Ceiling,
        ),
    ];
    for (occupancy, calls_today, latch, skip) in cases {
        assert_eq!(
            schedule_promotion(&queue(&pending, occupancy, calls_today, latch, &policy)),
            PromotionSchedule::None(skip)
        );
    }
}

#[test]
fn skips_quarantined_and_over_cap_episodes_without_erasing_them() {
    let policy = policy();
    let pending = vec![
        pending("episode_old", 1, 3, 4),
        pending("episode_big", 2, 0, 9),
        pending("episode_ok", 3, 2, 8),
    ];
    assert_eq!(
        schedule_promotion(&queue(
            &pending,
            RunnerOccupancy::Idle,
            1,
            PanicLatch::Clear,
            &policy,
        )),
        PromotionSchedule::One(EpisodeId::new("episode_ok"))
    );
    assert_eq!(
        pending
            .iter()
            .map(|episode| episode.text.clone())
            .collect::<Vec<_>>(),
        vec![
            "exchange episode_old".to_owned(),
            "exchange episode_big".to_owned(),
            "exchange episode_ok".to_owned(),
        ]
    );
}

#[test]
fn quarantine_after_three_failures_keeps_the_episode_searchable() {
    let mut ledger = EpisodeLedger {
        id: EpisodeId::new("episode_a"),
        text: "raw exchange".to_owned(),
        failures: 2,
        admission: PromotionAdmission::Eligible,
    };
    let (next, notice) = note_promotion_failure(&ledger, DEFAULT_PROMOTION_FAILURE_LIMIT);
    assert_eq!(next.failures, 3);
    assert_eq!(next.admission, PromotionAdmission::Quarantined);
    assert_eq!(next.text, ledger.text);
    let notice = notice.expect("threshold notice");
    assert_eq!(notice.episode_id, ledger.id);
    assert_eq!(notice.channel, QuarantineChannel::Promotion);
    ledger = next;
    let released = release_quarantine(&ledger);
    assert_eq!(released.failures, 0);
    assert_eq!(released.admission, PromotionAdmission::Eligible);
    assert_eq!(released.text, "raw exchange");
}

#[test]
fn promotion_ports_exclude_tools_and_the_vault() {
    assert_eq!(
        promotion_orchestration_ports(),
        &[
            OrchestrationPort::Brain,
            OrchestrationPort::Router,
            OrchestrationPort::Embedder,
        ]
    );
}
