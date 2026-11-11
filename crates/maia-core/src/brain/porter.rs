//! Original Porter stemmer for lowercase ASCII words.
//!
//! The neuron index uses SQLite's porter tokenizer. Recall overlap uses this
//! copy so `live` and `lives` meet without a model.

/// Stems one lowercase ASCII word. Anything else is returned unchanged.
#[must_use]
pub(crate) fn porter_stem(word: &str) -> String {
    if word.len() <= 2 || !word.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return word.to_owned();
    }
    let mut chars: Vec<u8> = word.bytes().collect();
    step1a(&mut chars);
    step1b(&mut chars);
    step1c(&mut chars);
    step2(&mut chars);
    step3(&mut chars);
    step4(&mut chars);
    step5(&mut chars);
    match String::from_utf8(chars) {
        Ok(stem) => stem,
        Err(_) => word.to_owned(),
    }
}

fn is_consonant(word: &[u8], index: usize) -> bool {
    match word[index] {
        b'a' | b'e' | b'i' | b'o' | b'u' => false,
        b'y' => index == 0 || !is_consonant(word, index - 1),
        _ => true,
    }
}

fn measure(word: &[u8]) -> usize {
    let mut count = 0;
    let mut index = 0;
    while index < word.len() && is_consonant(word, index) {
        index += 1;
    }
    while index < word.len() {
        while index < word.len() && !is_consonant(word, index) {
            index += 1;
        }
        if index >= word.len() {
            break;
        }
        while index < word.len() && is_consonant(word, index) {
            index += 1;
        }
        count += 1;
    }
    count
}

fn has_vowel(word: &[u8]) -> bool {
    (0..word.len()).any(|index| !is_consonant(word, index))
}

fn ends_with(word: &[u8], suffix: &[u8]) -> bool {
    word.ends_with(suffix)
}

fn replace_suffix(word: &mut Vec<u8>, suffix: &[u8], replacement: &[u8]) {
    let stem_len = word.len() - suffix.len();
    word.truncate(stem_len);
    word.extend_from_slice(replacement);
}

fn ends_double_consonant(word: &[u8]) -> bool {
    word.len() >= 2
        && word[word.len() - 1] == word[word.len() - 2]
        && is_consonant(word, word.len() - 1)
}

fn ends_cvc(word: &[u8]) -> bool {
    if word.len() < 3 {
        return false;
    }
    let last = word.len() - 1;
    is_consonant(word, last)
        && !is_consonant(word, last - 1)
        && is_consonant(word, last - 2)
        && !matches!(word[last], b'w' | b'x' | b'y')
}

fn step1a(word: &mut Vec<u8>) {
    if ends_with(word, b"sses") {
        replace_suffix(word, b"sses", b"ss");
    } else if ends_with(word, b"ies") {
        replace_suffix(word, b"ies", b"i");
    } else if !ends_with(word, b"ss") && ends_with(word, b"s") {
        word.pop();
    }
}

fn step1b(word: &mut Vec<u8>) {
    if ends_with(word, b"eed") {
        let stem_len = word.len() - 3;
        if measure(&word[..stem_len]) > 0 {
            word.pop();
        }
        return;
    }
    let suffix: &[u8] = if ends_with(word, b"ed") {
        b"ed"
    } else if ends_with(word, b"ing") {
        b"ing"
    } else {
        return;
    };
    let stem_len = word.len() - suffix.len();
    if !has_vowel(&word[..stem_len]) {
        return;
    }
    word.truncate(stem_len);
    if ends_with(word, b"at") || ends_with(word, b"bl") || ends_with(word, b"iz") {
        word.push(b'e');
    } else if ends_double_consonant(word)
        && !matches!(*word.last().unwrap_or(&0), b'l' | b's' | b'z')
    {
        word.pop();
    } else if measure(word) == 1 && ends_cvc(word) {
        word.push(b'e');
    }
}

fn step1c(word: &mut [u8]) {
    if !ends_with(word, b"y") {
        return;
    }
    let stem_len = word.len() - 1;
    if has_vowel(&word[..stem_len]) {
        word[stem_len] = b'i';
    }
}

fn step2(word: &mut Vec<u8>) {
    const RULES: &[(&[u8], &[u8])] = &[
        (b"ational", b"ate"),
        (b"tional", b"tion"),
        (b"enci", b"ence"),
        (b"anci", b"ance"),
        (b"izer", b"ize"),
        (b"abli", b"able"),
        (b"alli", b"al"),
        (b"entli", b"ent"),
        (b"eli", b"e"),
        (b"ousli", b"ous"),
        (b"ization", b"ize"),
        (b"ation", b"ate"),
        (b"ator", b"ate"),
        (b"alism", b"al"),
        (b"iveness", b"ive"),
        (b"fulness", b"ful"),
        (b"ousness", b"ous"),
        (b"aliti", b"al"),
        (b"iviti", b"ive"),
        (b"biliti", b"ble"),
    ];
    apply_measured(word, RULES, 0);
}

fn step3(word: &mut Vec<u8>) {
    const RULES: &[(&[u8], &[u8])] = &[
        (b"icate", b"ic"),
        (b"ative", b""),
        (b"alize", b"al"),
        (b"iciti", b"ic"),
        (b"ical", b"ic"),
        (b"ful", b""),
        (b"ness", b""),
    ];
    apply_measured(word, RULES, 0);
}

fn step4(word: &mut Vec<u8>) {
    const RULES: &[&[u8]] = &[
        b"ement", b"ance", b"ence", b"able", b"ible", b"ment", b"ent", b"ion", b"ous", b"ism",
        b"ate", b"iti", b"ive", b"ize", b"ant", b"al", b"er", b"ic", b"ou",
    ];
    for suffix in RULES {
        if !ends_with(word, suffix) {
            continue;
        }
        let stem_len = word.len() - suffix.len();
        if *suffix == b"ion" {
            let previous = word[..stem_len].last().copied().unwrap_or(0);
            if previous != b's' && previous != b't' {
                continue;
            }
        }
        if measure(&word[..stem_len]) > 1 {
            word.truncate(stem_len);
        }
        return;
    }
}

fn step5(word: &mut Vec<u8>) {
    if ends_with(word, b"e") {
        let stem = &word[..word.len() - 1];
        let weight = measure(stem);
        if weight > 1 || (weight == 1 && !ends_cvc(stem)) {
            word.pop();
        }
    }
    if measure(word) > 1 && ends_double_consonant(word) && word.last() == Some(&b'l') {
        word.pop();
    }
}

fn apply_measured(word: &mut Vec<u8>, rules: &[(&[u8], &[u8])], minimum: usize) {
    for (suffix, replacement) in rules {
        if !ends_with(word, suffix) {
            continue;
        }
        let stem_len = word.len() - suffix.len();
        if measure(&word[..stem_len]) > minimum {
            replace_suffix(word, suffix, replacement);
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::porter_stem;

    #[test]
    fn porter_folds_regular_plurals_and_verb_endings() {
        assert_eq!(porter_stem("live"), "live");
        assert_eq!(porter_stem("lives"), "live");
        assert_eq!(porter_stem("lived"), "live");
        assert_eq!(porter_stem("living"), "live");
        assert_eq!(porter_stem("box"), "box");
        assert_eq!(porter_stem("boxes"), "box");
        assert_eq!(porter_stem("city"), porter_stem("cities"));
        assert_eq!(porter_stem("note"), porter_stem("notes"));
        assert_eq!(porter_stem("bob"), "bob");
        assert_ne!(porter_stem("portland"), porter_stem("port"));
    }
}
