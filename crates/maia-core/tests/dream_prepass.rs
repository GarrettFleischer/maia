//! Deterministic duplicate and contradiction candidates. The pre-pass does not write.

use maia_core::audit::Timestamp;
use maia_core::brain::{EpisodeId, FactId, LexemeId};
use maia_core::dream::{
    ContradictionCandidate, DreamEpisode, DreamFact, DuplicateCandidate, FactCurrency, SubjectKey,
    propose_dream_candidates,
};
use maia_core::security::Taint;

fn lexeme(text: &str) -> LexemeId {
    LexemeId::new(text)
}

fn episode(id: &str, lexemes: &[&str]) -> DreamEpisode {
    DreamEpisode {
        id: EpisodeId::new(id),
        at: Timestamp(1),
        taint: Taint::Trusted,
        lexemes: lexemes.iter().copied().map(lexeme).collect(),
        text: format!("exchange {id}"),
    }
}

fn fact(id: &str, sentence: &str, lexemes: &[&str], sources: &[&str]) -> DreamFact {
    DreamFact {
        id: FactId::new(id),
        sentence: sentence.to_owned(),
        taint: Taint::Trusted,
        lexemes: lexemes.iter().copied().map(lexeme).collect(),
        episode_ids: sources.iter().copied().map(EpisodeId::new).collect(),
        entity_id: None,
        claim_ids: Vec::new(),
        valid_from: Timestamp(0),
        hold: None,
        currency: FactCurrency::Current,
    }
}

#[test]
fn prepass_orders_duplicate_and_contradiction_pairs_without_writes() {
    let episodes = vec![
        episode("episode_b", &["vault", "obsidian"]),
        episode("episode_a", &["vault"]),
    ];
    let facts = vec![
        fact(
            "fact_b",
            "Obsidian opens the vault.",
            &["obsidian", "vault"],
            &["episode_old"],
        ),
        fact(
            "fact_a",
            "Obsidian opens the vault.",
            &["obsidian", "vault"],
            &["episode_a"],
        ),
        fact("fact_closed", "Obsidian opens the vault.", &["vault"], &[]),
    ];
    let mut closed = facts[2].clone();
    closed.currency = FactCurrency::Closed {
        valid_end: Timestamp(4),
    };
    let mut stored = facts.clone();
    stored[2] = closed;
    let before = stored.clone();
    let candidates = propose_dream_candidates(&episodes, &stored);
    assert_eq!(stored, before);
    assert_eq!(
        candidates.duplicates,
        vec![DuplicateCandidate {
            left_fact_id: FactId::new("fact_a"),
            right_fact_id: FactId::new("fact_b"),
        }]
    );
    assert_eq!(
        candidates.contradictions,
        vec![
            ContradictionCandidate {
                existing_fact_id: FactId::new("fact_a"),
                episode_id: EpisodeId::new("episode_b"),
                subject_key: SubjectKey::new("lexeme:obsidian"),
            },
            ContradictionCandidate {
                existing_fact_id: FactId::new("fact_a"),
                episode_id: EpisodeId::new("episode_b"),
                subject_key: SubjectKey::new("lexeme:vault"),
            },
            ContradictionCandidate {
                existing_fact_id: FactId::new("fact_b"),
                episode_id: EpisodeId::new("episode_a"),
                subject_key: SubjectKey::new("lexeme:vault"),
            },
            ContradictionCandidate {
                existing_fact_id: FactId::new("fact_b"),
                episode_id: EpisodeId::new("episode_b"),
                subject_key: SubjectKey::new("lexeme:obsidian"),
            },
            ContradictionCandidate {
                existing_fact_id: FactId::new("fact_b"),
                episode_id: EpisodeId::new("episode_b"),
                subject_key: SubjectKey::new("lexeme:vault"),
            },
        ]
    );
}

#[test]
fn reversed_inputs_emit_the_same_candidates() {
    let episodes = vec![
        episode("episode_a", &["vault"]),
        episode("episode_b", &["vault"]),
    ];
    let reversed_episodes = vec![episodes[1].clone(), episodes[0].clone()];
    let facts = vec![
        fact("fact_b", "Same sentence.", &["vault"], &[]),
        fact("fact_a", "Same sentence.", &["vault"], &[]),
    ];
    let reversed_facts = vec![facts[1].clone(), facts[0].clone()];
    assert_eq!(
        propose_dream_candidates(&episodes, &facts),
        propose_dream_candidates(&reversed_episodes, &reversed_facts)
    );
}
