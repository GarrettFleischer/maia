//! Relatedness selection is deterministic, capped, and model-safe.

use maia_core::dream::EntitySlug;
use maia_core::dream::RELATEDNESS_FANOUT;
use maia_core::dream::RelatedCandidate;
use maia_core::dream::RelatedChannel;
use maia_core::dream::select_entity_links;
use maia_core::dream::select_related_claims;

fn candidate(
    id: &str,
    lexemes: &[&str],
    untrusted: bool,
    cosine_millis: Option<i32>,
    model_id: Option<&str>,
) -> RelatedCandidate {
    RelatedCandidate {
        claim_id: id.to_owned(),
        lexemes: lexemes.iter().map(|lexeme| (*lexeme).to_owned()).collect(),
        untrusted,
        cosine_millis,
        model_id: model_id.map(str::to_owned),
    }
}

#[test]
fn related_claims_are_deterministic_and_capped() {
    let lexemes = ["northwind", "pantry", "ships", "oats"];
    let mut rows = Vec::new();
    for index in 0..6 {
        let id = format!("claim-{index}");
        rows.push(candidate(
            &id,
            &lexemes,
            false,
            None,
            None,
        ));
    }
    let forward = select_related_claims(&owned(&lexemes), false, None, &rows, RELATEDNESS_FANOUT);
    rows.reverse();
    let backward = select_related_claims(&owned(&lexemes), false, None, &rows, RELATEDNESS_FANOUT);
    assert_eq!(forward, backward);
    assert_eq!(forward.len(), RELATEDNESS_FANOUT);
    let ids: Vec<_> = forward.iter().map(|link| link.claim_id.as_str()).collect();
    assert_eq!(ids, vec!["claim-0", "claim-1", "claim-2", "claim-3"]);
    assert!(forward.iter().all(|link| link.weight_millis == 1000));
    assert!(forward.iter().all(|link| link.channel == RelatedChannel::Lexeme));
}

#[test]
fn an_untrusted_endpoint_halves_the_relatedness_weight() {
    let link = select_related_claims(
        &owned(&["northwind", "pantry", "ships", "oats"]),
        true,
        None,
        &[candidate(
            "claim-old",
            &["northwind", "pantry", "stores", "flour"],
            true,
            None,
            None,
        )],
        RELATEDNESS_FANOUT,
    );
    assert_eq!(link.len(), 1);
    assert_eq!(link[0].weight_millis, 250);
}

#[test]
fn a_different_embedder_model_cannot_create_a_vector_link() {
    let foreign = select_related_claims(
        &owned(&["alpha"]),
        false,
        Some("model-a"),
        &[candidate(
            "claim-foreign",
            &["other"],
            false,
            Some(990),
            Some("model-b"),
        )],
        RELATEDNESS_FANOUT,
    );
    assert!(foreign.is_empty());
    let same = select_related_claims(
        &owned(&["alpha"]),
        false,
        Some("model-a"),
        &[candidate(
            "claim-same",
            &["other"],
            false,
            Some(900),
            Some("model-a"),
        )],
        RELATEDNESS_FANOUT,
    );
    assert_eq!(same.len(), 1);
    assert_eq!(same[0].channel, RelatedChannel::Vector);
    assert_eq!(same[0].weight_millis, 900);
}

#[test]
fn shared_entity_slugs_link_in_id_order() {
    let links = select_entity_links(
        &owned(&["northwind", "pantry"]),
        &[
            EntitySlug {
                entity_id: "entity-b".to_owned(),
                slug: "pantry".to_owned(),
            },
            EntitySlug {
                entity_id: "entity-a".to_owned(),
                slug: "northwind".to_owned(),
            },
            EntitySlug {
                entity_id: "entity-c".to_owned(),
                slug: "missing".to_owned(),
            },
        ],
        true,
        4,
    );
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].entity_id, "entity-a");
    assert_eq!(links[1].entity_id, "entity-b");
    assert_eq!(links[0].weight_millis, 500);
}

fn owned(lexemes: &[&str]) -> Vec<String> {
    lexemes.iter().map(|lexeme| (*lexeme).to_owned()).collect()
}
