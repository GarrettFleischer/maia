//! Model-free word forms for keyword search and mention matching.
//!
//! Porter stemming lives in the neuron FTS tokenizer. This module supplies the
//! pieces Porter does not: stopwords, possessives, and irregular forms.

use std::collections::BTreeSet;

/// Surface forms that share a lemma. A form may sit in two groups when it is
/// genuinely ambiguous (`leaves`, `lay`).
const GROUPS: &[&[&str]] = &[
    &["go", "goes", "went", "gone", "going"],
    &["buy", "buys", "bought", "buying"],
    &["run", "runs", "ran", "running"],
    &["come", "comes", "came", "coming"],
    &["get", "gets", "got", "gotten", "getting"],
    &["make", "makes", "made", "making"],
    &["take", "takes", "took", "taken", "taking"],
    &["see", "sees", "saw", "seen", "seeing"],
    &["know", "knows", "knew", "known", "knowing"],
    &["think", "thinks", "thought", "thinking"],
    &["say", "says", "said", "saying"],
    &["find", "finds", "found", "finding"],
    &["give", "gives", "gave", "given", "giving"],
    &["tell", "tells", "told", "telling"],
    &["leave", "leaves", "left", "leaving"],
    &["feel", "feels", "felt", "feeling"],
    &["keep", "keeps", "kept", "keeping"],
    &["begin", "begins", "began", "begun", "beginning"],
    &["hear", "hears", "heard", "hearing"],
    &["write", "writes", "wrote", "written", "writing"],
    &["sit", "sits", "sat", "sitting"],
    &["stand", "stands", "stood", "standing"],
    &["lose", "loses", "lost", "losing"],
    &["pay", "pays", "paid", "paying"],
    &["meet", "meets", "met", "meeting"],
    &["speak", "speaks", "spoke", "spoken", "speaking"],
    &["spend", "spends", "spent", "spending"],
    &["grow", "grows", "grew", "grown", "growing"],
    &["lead", "leads", "led", "leading"],
    &["send", "sends", "sent", "sending"],
    &["build", "builds", "built", "building"],
    &["fall", "falls", "fell", "fallen", "falling"],
    &["sell", "sells", "sold", "selling"],
    &["break", "breaks", "broke", "broken", "breaking"],
    &["bring", "brings", "brought", "bringing"],
    &["hold", "holds", "held", "holding"],
    &["eat", "eats", "ate", "eaten", "eating"],
    &["catch", "catches", "caught", "catching"],
    &["draw", "draws", "drew", "drawn", "drawing"],
    &["choose", "chooses", "chose", "chosen", "choosing"],
    &["drive", "drives", "drove", "driven", "driving"],
    &["wear", "wears", "wore", "worn", "wearing"],
    &["sleep", "sleeps", "slept", "sleeping"],
    &["win", "wins", "won", "winning"],
    &["teach", "teaches", "taught", "teaching"],
    &["fly", "flies", "flew", "flown", "flying"],
    &["drink", "drinks", "drank", "drunk", "drinking"],
    &["sing", "sings", "sang", "sung", "singing"],
    &["swim", "swims", "swam", "swum", "swimming"],
    &["ring", "rings", "rang", "rung", "ringing"],
    &["throw", "throws", "threw", "thrown", "throwing"],
    &["forget", "forgets", "forgot", "forgotten", "forgetting"],
    &["hide", "hides", "hid", "hidden", "hiding"],
    &["rise", "rises", "rose", "risen", "rising"],
    &["shake", "shakes", "shook", "shaken", "shaking"],
    &["become", "becomes", "became", "becoming"],
    &["show", "shows", "showed", "shown", "showing"],
    &["mean", "means", "meant", "meaning"],
    &["lie", "lies", "lay", "lain", "lying"],
    &["lay", "lays", "laid", "laying"],
    &["understand", "understands", "understood", "understanding"],
    &["fight", "fights", "fought", "fighting"],
    &["seek", "seeks", "sought", "seeking"],
    &["shoot", "shoots", "shot", "shooting"],
    &["strike", "strikes", "struck", "striking"],
    &["stick", "sticks", "stuck", "sticking"],
    &["hang", "hangs", "hung", "hanging"],
    &["dig", "digs", "dug", "digging"],
    &["blow", "blows", "blew", "blown", "blowing"],
    &["bite", "bites", "bit", "bitten", "biting"],
    &["lend", "lends", "lent", "lending"],
    &["forgive", "forgives", "forgave", "forgiven", "forgiving"],
    &["freeze", "freezes", "froze", "frozen", "freezing"],
    &["steal", "steals", "stole", "stolen", "stealing"],
    &["wake", "wakes", "woke", "woken", "waking"],
    &["tear", "tears", "tore", "torn", "tearing"],
    &["swear", "swears", "swore", "sworn", "swearing"],
    &["sink", "sinks", "sank", "sunk", "sinking"],
    &["spin", "spins", "spun", "spinning"],
    &["child", "children"],
    &["person", "people", "persons"],
    &["man", "men"],
    &["woman", "women"],
    &["tooth", "teeth"],
    &["foot", "feet"],
    &["mouse", "mice"],
    &["goose", "geese"],
    &["ox", "oxen"],
    &["leaf", "leaves"],
    &["knife", "knives"],
    &["wife", "wives"],
    &["life", "lives"],
    &["half", "halves"],
    &["self", "selves"],
    &["calf", "calves"],
    &["elf", "elves"],
    &["loaf", "loaves"],
    &["thief", "thieves"],
    &["wolf", "wolves"],
    &["shelf", "shelves"],
    &["criterion", "criteria"],
    &["phenomenon", "phenomena"],
    &["datum", "data"],
    &["medium", "media"],
    &["analysis", "analyses"],
    &["crisis", "crises"],
    &["thesis", "theses"],
    &["index", "indices", "indexes"],
    &["cactus", "cacti"],
    &["fungus", "fungi"],
    &["nucleus", "nuclei"],
    &["syllabus", "syllabi"],
    &["alumnus", "alumni"],
    &["louse", "lice"],
    &["appendix", "appendices"],
];

/// Function words that must not compete with names and verbs in bm25.
const STOPWORDS: &[&str] = &[
    "a", "about", "after", "am", "an", "and", "are", "as", "at", "be", "been", "before", "being",
    "between", "but", "by", "can", "could", "did", "do", "does", "doing", "during", "for", "from",
    "had", "has", "have", "having", "he", "her", "here", "him", "his", "how", "i", "if", "in",
    "into", "is", "it", "its", "may", "me", "might", "must", "my", "no", "nor", "not", "of", "on",
    "or", "our", "over", "s", "shall", "she", "should", "so", "than", "that", "the", "their",
    "them", "then", "there", "these", "they", "this", "those", "through", "to", "us", "was", "we",
    "were", "what", "when", "where", "which", "who", "whom", "whose", "why", "will", "with",
    "within", "without", "would", "you", "your",
];

/// Case-folded content tokens, stopwords removed, irregulars expanded.
///
/// The original token is emitted before the other forms of its lemma. Regular
/// plurals and verb endings are left for the Porter tokenizer.
pub(crate) fn keyword_query_terms(raw: &str, max_tokens: usize, max_chars: usize) -> Vec<String> {
    let tokens = keyword_tokens(raw, max_tokens, max_chars);
    expand_keyword_tokens(&tokens)
}

/// Lowercase label, possessive base, and irregular surface forms.
///
/// Multi-word labels and paths stay whole. `"Alice's"` yields `alice's` and `alice`.
/// `"children"` yields `children` and `child`.
#[must_use]
pub fn link_match_keys(raw: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let lower = raw.to_lowercase();
    push_unique(&mut keys, lower.clone());
    let stripped = strip_possessive(&lower);
    if stripped != lower {
        push_unique(&mut keys, stripped.to_owned());
    }
    if is_single_word(stripped) {
        for form in irregular_surface_forms(stripped) {
            push_unique(&mut keys, (*form).to_owned());
        }
    }
    keys
}

fn keyword_tokens(raw: &str, max_tokens: usize, max_chars: usize) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            if current.chars().count() < max_chars {
                current.push(ch.to_ascii_lowercase());
            }
        } else {
            push_token(&mut tokens, &mut current, max_tokens);
        }
    }
    push_token(&mut tokens, &mut current, max_tokens);
    tokens
}

fn push_token(tokens: &mut Vec<String>, current: &mut String, max_tokens: usize) {
    if current.is_empty() {
        return;
    }
    let token = std::mem::take(current);
    if is_keyword_stopword(&token) || tokens.len() >= max_tokens {
        return;
    }
    tokens.push(token);
}

fn expand_keyword_tokens(tokens: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut expanded = Vec::new();
    for token in tokens {
        push_term(&mut expanded, &mut seen, token);
        for form in irregular_surface_forms(token) {
            push_term(&mut expanded, &mut seen, form);
        }
    }
    expanded
}

fn push_term(expanded: &mut Vec<String>, seen: &mut BTreeSet<String>, form: &str) {
    if form.is_empty() || is_keyword_stopword(form) {
        return;
    }
    if seen.insert(form.to_owned()) {
        expanded.push(form.to_owned());
    }
}

fn irregular_surface_forms(token: &str) -> Vec<&'static str> {
    let mut forms = Vec::new();
    for group in GROUPS {
        if !group.contains(&token) {
            continue;
        }
        for form in *group {
            if !forms.contains(form) {
                forms.push(*form);
            }
        }
    }
    forms
}

fn is_keyword_stopword(token: &str) -> bool {
    STOPWORDS.binary_search(&token).is_ok()
}

fn strip_possessive(token: &str) -> &str {
    const SUFFIXES: [&str; 4] = ["'s", "\u{2019}s", "'", "\u{2019}"];
    for suffix in SUFFIXES {
        if let Some(stripped) = token.strip_suffix(suffix)
            && !stripped.is_empty()
        {
            return stripped;
        }
    }
    token
}

/// True when two tokens are the same word, a possessive pair, an irregular
/// form pair, or the same Porter stem.
#[must_use]
pub fn same_keyword_term(left: &str, right: &str) -> bool {
    let left = left.to_lowercase();
    let right = right.to_lowercase();
    if left == right {
        return true;
    }
    let left_base = strip_possessive(&left);
    let right_base = strip_possessive(&right);
    if left_base == right_base {
        return true;
    }
    if shares_irregular(left_base, right_base) {
        return true;
    }
    super::porter::porter_stem(left_base) == super::porter::porter_stem(right_base)
}

fn shares_irregular(left: &str, right: &str) -> bool {
    irregular_surface_forms(left).contains(&right) || irregular_surface_forms(right).contains(&left)
}

fn is_single_word(token: &str) -> bool {
    !token.is_empty() && token.chars().all(|ch| ch.is_ascii_alphabetic())
}

fn push_unique(keys: &mut Vec<String>, key: String) {
    if keys.iter().all(|existing| existing != &key) {
        keys.push(key);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn irregular_forms_cover_common_verbs_and_plurals() {
        let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
        for group in GROUPS {
            for form in *group {
                *counts.entry(form).or_insert(0) += 1;
            }
        }
        assert!(
            counts.len() >= 150,
            "irregular table has {} forms",
            counts.len()
        );
        for (form, count) in &counts {
            assert!(*count <= 2, "{form} is in {count} groups");
        }
        assert!(shares("went", "goes"));
        assert!(shares("buy", "bought"));
        assert!(shares("people", "person"));
        assert!(shares("children", "child"));
        assert!(shares("ran", "running"));
        assert!(shares("leaves", "leaf"));
        assert!(shares("leaves", "left"));
    }

    #[test]
    fn stopwords_are_sorted_and_cover_query_glue() {
        assert!(STOPWORDS.windows(2).all(|pair| pair[0] < pair[1]));
        for word in ["where", "does", "the", "will", "is", "a", "who", "to", "s"] {
            assert!(is_keyword_stopword(word), "{word}");
        }
        assert!(!is_keyword_stopword("live"));
        assert!(!is_keyword_stopword("bob"));
        assert_eq!(strip_possessive("bob's"), "bob");
        assert_eq!(strip_possessive("bob\u{2019}s"), "bob");
        assert!(same_keyword_term("live", "lives"));
        assert!(same_keyword_term("went", "goes"));
        assert!(same_keyword_term("Bob's", "bob"));
        assert!(!same_keyword_term("bob", "portland"));
    }

    fn shares(left: &str, right: &str) -> bool {
        irregular_surface_forms(left).contains(&right)
    }
}
