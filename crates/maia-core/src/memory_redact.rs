//! Strip common secrets before durable memory / skill / session-summary saves.

/// Marker written in place of redacted material.
pub const REDACTED: &str = "[REDACTED]";

/// Redacts API-key patterns, known stored secret values, and `<private>` blocks.
///
/// Honest leaf: only `text` and `known_secret_values` are read. Never logs.
#[must_use]
pub fn redact_secrets_for_save(text: &str, known_secret_values: &[&str]) -> String {
    let without_private = strip_private_blocks(text);
    let without_known = redact_known_values(&without_private, known_secret_values);
    redact_common_patterns(&without_known)
}

fn strip_private_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<private>") {
        out.push_str(&rest[..start]);
        out.push_str(REDACTED);
        let after_open = start + "<private>".len();
        match rest[after_open..].find("</private>") {
            Some(rel_end) => {
                rest = &rest[after_open + rel_end + "</private>".len()..];
            }
            None => {
                // Unclosed: drop the remainder as private.
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

fn redact_known_values(text: &str, known: &[&str]) -> String {
    let mut ordered: Vec<&str> = known
        .iter()
        .copied()
        .filter(|value| !value.is_empty())
        .collect();
    ordered.sort_by_key(|value| std::cmp::Reverse(value.len()));
    let mut out = text.to_owned();
    for value in ordered {
        out = out.replace(value, REDACTED);
    }
    out
}

fn redact_common_patterns(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if let Some((consumed, _)) = match_prefixed_token(&chars[i..]) {
            out.push_str(REDACTED);
            i += consumed;
            continue;
        }
        if let Some((consumed, _)) = match_bearer(&chars[i..]) {
            out.push_str(REDACTED);
            i += consumed;
            continue;
        }
        if let Some((consumed, _)) = match_key_value_secret(&chars[i..]) {
            // Keep the key= prefix; redact only the value.
            let eq = chars[i..i + consumed]
                .iter()
                .position(|ch| *ch == '=')
                .unwrap_or(0);
            for ch in &chars[i..=i + eq] {
                out.push(*ch);
            }
            out.push_str(REDACTED);
            i += consumed;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn match_prefixed_token(chars: &[char]) -> Option<(usize, usize)> {
    const PREFIXES: &[&str] = &["sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "xoxb-", "xoxp-", "AKIA"];
    for prefix in PREFIXES {
        let p: Vec<char> = prefix.chars().collect();
        if chars.len() < p.len() + 8 {
            continue;
        }
        if !chars.starts_with(&p) {
            continue;
        }
        let mut end = p.len();
        while end < chars.len() && is_secret_token_char(chars[end]) {
            end += 1;
        }
        if end - p.len() >= 8 {
            return Some((end, end));
        }
    }
    None
}

fn match_bearer(chars: &[char]) -> Option<(usize, usize)> {
    const BEARER: &str = "Bearer ";
    let p: Vec<char> = BEARER.chars().collect();
    if chars.len() < p.len() + 8 || !chars.starts_with(&p) {
        return None;
    }
    let mut end = p.len();
    while end < chars.len() && is_secret_token_char(chars[end]) {
        end += 1;
    }
    if end - p.len() >= 8 {
        Some((end, end))
    } else {
        None
    }
}

fn match_key_value_secret(chars: &[char]) -> Option<(usize, usize)> {
    // ident = long_hex_or_base64
    if chars.is_empty() || !is_ident_start(chars[0]) {
        return None;
    }
    let mut i = 1;
    while i < chars.len() && is_ident_char(chars[i]) {
        i += 1;
    }
    if i >= chars.len() || chars[i] != '=' {
        return None;
    }
    let value_start = i + 1;
    if value_start >= chars.len() {
        return None;
    }
    let mut end = value_start;
    while end < chars.len() && is_secret_token_char(chars[end]) {
        end += 1;
    }
    let value_len = end - value_start;
    if value_len < 32 {
        return None;
    }
    let value: String = chars[value_start..end].iter().collect();
    if looks_like_hex(&value) || looks_like_base64(&value) {
        Some((end, end))
    } else {
        None
    }
}

fn is_secret_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '/' | '+' | '=' | '.')
}

fn is_ident_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn looks_like_hex(value: &str) -> bool {
    value.len() >= 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn looks_like_base64(value: &str) -> bool {
    if value.len() < 32 {
        return false;
    }
    let ok = value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'));
    ok && value.bytes().any(|b| b.is_ascii_uppercase()) && value.bytes().any(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_common_api_key_prefixes() {
        let fake_openai = "sk-testFAKESECRET_w1x2y3z4a5b6c7d8e9f0";
        let fake_github = "ghp_testFAKE00000000000000000001";
        let fake_slack = "xoxb-test-FAKE0000000000000001";
        let fake_aws = "AKIATESTFAKE00000001";
        let text = format!(
            "keys {fake_openai} {fake_github} {fake_slack} {fake_aws} Bearer FAKESECRET_m3n4o5p6q7r8s9t0u1v2"
        );
        let out = redact_secrets_for_save(&text, &[]);
        assert!(!out.contains(fake_openai));
        assert!(!out.contains(fake_github));
        assert!(!out.contains(fake_slack));
        assert!(!out.contains(fake_aws));
        assert!(!out.contains("tok_test_FAKE_bearer_00000001"));
        assert!(out.contains(REDACTED));
        assert_eq!(out.matches(REDACTED).count(), 5);
    }

    #[test]
    fn redacts_private_blocks_and_known_values() {
        let known = "ceo-stored-fake-secret-value-75";
        let text = format!("before <private>hidden-bits</private> after and {known}");
        let out = redact_secrets_for_save(&text, &[known]);
        assert!(!out.contains("hidden-bits"));
        assert!(!out.contains(known));
        assert!(out.contains("before"));
        assert!(out.contains("after"));
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn redacts_long_hex_in_key_equals_value() {
        let hex = "0123456789abcdef0123456789abcdef";
        let text = format!("config api_key={hex} ok");
        let out = redact_secrets_for_save(&text, &[]);
        assert!(!out.contains(hex));
        assert!(out.contains("api_key=[REDACTED]"));
        assert!(out.ends_with(" ok") || out.contains(" ok"));
    }

    #[test]
    fn leaves_ordinary_sentences_alone() {
        let text = "Tried path F:\\tmp\\run75_throwaway.py and got ECONNREFUSED_75.";
        let out = redact_secrets_for_save(text, &[]);
        assert_eq!(out, text);
    }
}
