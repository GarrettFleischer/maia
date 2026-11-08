//! Consolidation wake policy and taint-partitioned batch selection.

use maia_core::audit::Timestamp;
use maia_core::brain::{ClaimId, EpisodeId};
use maia_core::dream::{
    BatchPolicy, BatchQueue, BatchSelection, BatchSkip, CallKind, CallTarget,
    DEFAULT_CONSOLIDATION_FAILURE_LIMIT, DEFAULT_IDLE_SECONDS, DEFAULT_UNCONSOLIDATED_THRESHOLD,
    DreamBatchId, DreamRequestMode, EpisodeLedger, NoTools, OrchestrationPort, PanicLatch,
    PromotionAdmission, QuarantineChannel, RunnerOccupancy, SelectableClaim, SelectedBatch,
    StructuredCall, WakeDecision, WakeObservation, WakePolicy, consolidation_due,
    consolidation_orchestration_ports, note_consolidation_failure, plan_consolidation_call,
    select_batch,
};
use maia_core::security::Taint;

fn wake_policy() -> WakePolicy {
    WakePolicy {
        claim_threshold: DEFAULT_UNCONSOLIDATED_THRESHOLD,
        idle_seconds: DEFAULT_IDLE_SECONDS,
    }
}

fn observation(unconsolidated: u32, idle_for: i64, request: DreamRequestMode) -> WakeObservation {
    WakeObservation {
        unconsolidated,
        idle_for,
        request,
    }
}

fn claim(id: &str, taint: Taint, episode: &str, at: i64, failures: u32) -> SelectableClaim {
    SelectableClaim {
        id: ClaimId::new(id),
        taint,
        episode_id: EpisodeId::new(episode),
        pending_since: Timestamp(at),
        consolidation_failures: failures,
    }
}

#[test]
fn threshold_idle_and_explicit_request_wake_only_on_their_conditions() {
    assert_eq!(DEFAULT_UNCONSOLIDATED_THRESHOLD, 20);
    assert_eq!(DEFAULT_IDLE_SECONDS, 30 * 60);
    assert_eq!(DEFAULT_CONSOLIDATION_FAILURE_LIMIT, 3);
    let policy = wake_policy();
    assert_eq!(
        consolidation_due(&observation(20, 0, DreamRequestMode::None), &policy),
        WakeDecision::Wake
    );
    assert_eq!(
        consolidation_due(&observation(19, 0, DreamRequestMode::None), &policy),
        WakeDecision::Sleep
    );
    assert_eq!(
        consolidation_due(&observation(1, 30 * 60, DreamRequestMode::None), &policy),
        WakeDecision::Wake
    );
    assert_eq!(
        consolidation_due(&observation(0, 30 * 60, DreamRequestMode::None), &policy),
        WakeDecision::Sleep
    );
    assert_eq!(
        consolidation_due(
            &observation(1, (30 * 60) - 1, DreamRequestMode::None),
            &policy
        ),
        WakeDecision::Sleep
    );
    assert_eq!(
        consolidation_due(&observation(0, 0, DreamRequestMode::Explicit), &policy),
        WakeDecision::Wake
    );
    let custom = WakePolicy {
        claim_threshold: 2,
        idle_seconds: 5,
    };
    assert_eq!(
        consolidation_due(&observation(2, 0, DreamRequestMode::None), &custom),
        WakeDecision::Wake
    );
}

#[test]
fn selection_is_one_taint_partition_oldest_first() {
    let policy = BatchPolicy {
        max_claims: 2,
        failure_limit: DEFAULT_CONSOLIDATION_FAILURE_LIMIT,
    };
    let claims = vec![
        claim("claim_t_early", Taint::Trusted, "episode_t", 2, 0),
        claim("claim_u_later", Taint::Untrusted, "episode_u2", 3, 0),
        claim("claim_u_old", Taint::Untrusted, "episode_u1", 1, 0),
        claim("claim_u_quarantine", Taint::Untrusted, "episode_q", 0, 3),
    ];
    let selected = select_batch(&BatchQueue {
        claims: &claims,
        occupancy: RunnerOccupancy::Idle,
        latch: PanicLatch::Clear,
        policy: &policy,
    });
    assert_eq!(
        selected,
        BatchSelection::Batch(SelectedBatch {
            taint: Taint::Untrusted,
            claims: vec![ClaimId::new("claim_u_old"), ClaimId::new("claim_u_later")],
        })
    );
}

#[test]
fn trusted_partition_excludes_untrusted_claims_when_it_is_older() {
    let policy = BatchPolicy {
        max_claims: 10,
        failure_limit: 3,
    };
    let claims = vec![
        claim("claim_u", Taint::Untrusted, "episode_u", 5, 0),
        claim("claim_t", Taint::Trusted, "episode_t", 1, 0),
    ];
    assert_eq!(
        select_batch(&BatchQueue {
            claims: &claims,
            occupancy: RunnerOccupancy::Idle,
            latch: PanicLatch::Clear,
            policy: &policy,
        }),
        BatchSelection::Batch(SelectedBatch {
            taint: Taint::Trusted,
            claims: vec![ClaimId::new("claim_t")],
        })
    );
}

#[test]
fn busy_or_panic_admits_no_batch_and_one_call_has_no_tools() {
    let policy = BatchPolicy {
        max_claims: 10,
        failure_limit: 3,
    };
    let claims = vec![claim("claim_t", Taint::Trusted, "episode_t", 1, 0)];
    assert_eq!(
        select_batch(&BatchQueue {
            claims: &claims,
            occupancy: RunnerOccupancy::Busy,
            latch: PanicLatch::Clear,
            policy: &policy,
        }),
        BatchSelection::None(BatchSkip::Busy)
    );
    assert_eq!(
        select_batch(&BatchQueue {
            claims: &claims,
            occupancy: RunnerOccupancy::Idle,
            latch: PanicLatch::Engaged,
            policy: &policy,
        }),
        BatchSelection::None(BatchSkip::Panic)
    );
    let batch = DreamBatchId::new("batch_01");
    assert_eq!(
        plan_consolidation_call(&batch),
        StructuredCall {
            kind: CallKind::Consolidation,
            target: CallTarget::Batch(batch),
            tool_host: NoTools,
        }
    );
    assert_eq!(
        consolidation_orchestration_ports(),
        &[
            OrchestrationPort::Brain,
            OrchestrationPort::Vault,
            OrchestrationPort::Router,
            OrchestrationPort::Embedder,
        ]
    );
}

#[test]
fn consolidation_failures_quarantine_per_episode_and_keep_text() {
    let ledger = EpisodeLedger {
        id: EpisodeId::new("episode_u1"),
        text: "web page".to_owned(),
        failures: 2,
        admission: PromotionAdmission::Eligible,
    };
    let (next, notice) = note_consolidation_failure(&ledger, DEFAULT_CONSOLIDATION_FAILURE_LIMIT);
    assert_eq!(next.text, "web page");
    assert_eq!(next.admission, PromotionAdmission::Quarantined);
    let notice = notice.expect("notice");
    assert_eq!(notice.channel, QuarantineChannel::Consolidation);
    assert_eq!(notice.episode_id, ledger.id);
}
