//! Deterministic nearest-claim merge, claim ids, and retry backoff.

use maia_core::brain::ClaimId;
use maia_core::dream::ClaimSeed;
use maia_core::dream::merge_claim_seeds;
use maia_core::dream::promotion_backoff_seconds;
use maia_core::dream::promotion_claim_id;

fn seed(id: &str, distance: Option<u32>) -> ClaimSeed {
    ClaimSeed {
        claim_id: id.to_owned(),
        sentence: format!("Sentence {id}."),
        distance_bits: distance,
    }
}

#[test]
fn merge_claim_seeds_is_independent_of_input_order() {
    let full_text = vec![seed("claim-b", None), seed("claim-a", None)];
    let vectors = vec![seed("claim-a", Some(5)), seed("claim-c", Some(1))];
    let forward = merge_claim_seeds(&full_text, &vectors, 5);
    let reverse_text = vec![seed("claim-a", None), seed("claim-b", None)];
    let reverse_vectors = vec![seed("claim-c", Some(1)), seed("claim-a", Some(5))];
    let backward = merge_claim_seeds(&reverse_text, &reverse_vectors, 5);
    let ids = |rows: &[ClaimSeed]| {
        rows.iter()
            .map(|row| row.claim_id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&forward), vec!["claim-a", "claim-c", "claim-b"]);
    assert_eq!(ids(&forward), ids(&backward));
    assert_eq!(merge_claim_seeds(&full_text, &vectors, 1).len(), 1);
}

#[test]
fn promotion_claim_ids_stay_unique_across_episodes() {
    assert_eq!(
        promotion_claim_id("episode-a", 0),
        ClaimId::new("claim-episode-a-0")
    );
    assert_ne!(
        promotion_claim_id("episode-a", 0),
        promotion_claim_id("episode-b", 0)
    );
    assert_ne!(
        promotion_claim_id("episode-a", 0),
        promotion_claim_id("episode-a", 1)
    );
}

#[test]
fn promotion_backoff_grows_and_then_caps() {
    assert_eq!(promotion_backoff_seconds(1), 2);
    assert_eq!(promotion_backoff_seconds(2), 4);
    assert_eq!(promotion_backoff_seconds(3), 8);
    assert_eq!(promotion_backoff_seconds(9), 8);
}
