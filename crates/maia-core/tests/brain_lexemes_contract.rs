//! Lexical seeding contracts from `docs/design/02-brain.md`.

use std::collections::{BTreeMap, BTreeSet};

use maia_core::brain::{LexemeId, LexicalPolicy, lexemes_for_sentence};

fn policy(stopwords: &[&str], high_fan: &[(&str, u32)], cutoff: u32) -> LexicalPolicy {
    let mut fan_out = BTreeMap::new();
    for (term, fan) in high_fan {
        fan_out.insert((*term).to_owned(), *fan);
    }
    LexicalPolicy {
        stopwords: stopwords.iter().map(|word| (*word).to_owned()).collect(),
        fan_out,
        high_fan_cutoff: cutoff,
    }
}

#[test]
fn folds_case_and_strips_possessives_to_bob() {
    let policy = policy(&[], &[], 100);
    let from_lower = lexemes_for_sentence("bob's", &policy);
    let from_title = lexemes_for_sentence("Bob's", &policy);
    let from_sentence = lexemes_for_sentence("The project is named Bob's Best Burgers", &policy);
    assert_eq!(from_lower, vec![LexemeId::new("bob")]);
    assert_eq!(from_title, vec![LexemeId::new("bob")]);
    assert!(
        from_sentence.contains(&LexemeId::new("bob")),
        "sentence lexemes should include bob: {from_sentence:?}"
    );
}

#[test]
fn stopwords_and_high_fan_terms_do_not_seed() {
    let mut stopwords = BTreeSet::new();
    stopwords.insert("the".to_owned());
    stopwords.insert("is".to_owned());
    let policy = LexicalPolicy {
        stopwords,
        fan_out: BTreeMap::from([("named".to_owned(), 50)]),
        high_fan_cutoff: 40,
    };
    let lexemes = lexemes_for_sentence("The project is named Bob's", &policy);
    assert_eq!(
        lexemes,
        vec![LexemeId::new("project"), LexemeId::new("bob")],
        "stopwords and high-fan 'named' must be excluded"
    );
}

#[test]
fn first_seen_order_is_stable_and_deduplicated() {
    let policy = policy(&[], &[], 100);
    let lexemes = lexemes_for_sentence("Bob burger bob's Burger", &policy);
    assert_eq!(lexemes, vec![LexemeId::new("bob"), LexemeId::new("burger")]);
}
