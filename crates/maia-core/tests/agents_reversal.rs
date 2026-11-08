//! Presentation reversal idempotency and exact compensation.

use std::collections::BTreeSet;

use maia_core::agents::{
    Presentation, PresentationId, ReversalRequest, ReversalRequestId, reverse_presentations,
};

#[test]
fn reversal_is_exact_idempotent_and_skips_already_reversed() {
    let source = vec![
        Presentation {
            id: PresentationId(1),
            activation: 2.0,
            co_use: 0.5,
        },
        Presentation {
            id: PresentationId(2),
            activation: 1.0,
            co_use: 0.25,
        },
    ];
    let mut already = BTreeSet::new();
    already.insert(PresentationId(2));
    let request = ReversalRequest {
        id: ReversalRequestId(99),
        presentation_ids: vec![PresentationId(1), PresentationId(2)],
    };
    let compensations =
        reverse_presentations(&source, &already, &BTreeSet::new(), &request).expect("reverse");
    assert_eq!(compensations.len(), 1);
    assert_eq!(compensations[0].presentation_id, PresentationId(1));
    assert_eq!(compensations[0].activation_delta, -2.0);
    assert_eq!(compensations[0].co_use_delta, -0.5);

    let mut applied = BTreeSet::new();
    applied.insert(ReversalRequestId(99));
    let again = reverse_presentations(&source, &already, &applied, &request).expect("idempotent");
    assert!(again.is_empty());
}

#[test]
fn duplicate_ids_in_one_request_produce_one_compensation() {
    let source = vec![Presentation {
        id: PresentationId(1),
        activation: 2.0,
        co_use: 0.5,
    }];
    let request = ReversalRequest {
        id: ReversalRequestId(100),
        presentation_ids: vec![PresentationId(1), PresentationId(1)],
    };
    let compensations =
        reverse_presentations(&source, &BTreeSet::new(), &BTreeSet::new(), &request)
            .expect("duplicate selection is idempotent");
    assert_eq!(compensations.len(), 1);
}
