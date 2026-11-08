//! Escapes dangerous inline Markdown before generated vault bytes are written.

const FULLWIDTH_LEFT_BRACKET: char = '\u{FF3B}';
const FULLWIDTH_RIGHT_BRACKET: char = '\u{FF3D}';
const FULLWIDTH_EXCLAMATION: char = '\u{FF01}';
const FULLWIDTH_LEFT_PAREN: char = '\u{FF08}';
const FULLWIDTH_BACKSLASH: char = '\u{FF3C}';
const FULLWIDTH_GRAVE: char = '\u{FF40}';
const FULLWIDTH_COLON: char = '\u{FF1A}';
const SINGLE_ANGLE_QUOTATION: char = '\u{2039}';
const FULLWIDTH_PERCENT: char = '\u{FF05}';

const SCHEMES: [&str; 4] = ["javascript", "obsidian", "file", "data"];

/// Returns deterministic text safe for generated vault Markdown per `10-security.md`.
pub fn neutralize_inline_markdown(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if is_bidi_control(ch) {
            continue;
        }
        out.push(ch);
    }

    out = replace_scheme_colons(&out);

    out = replace_all(
        &out,
        "![[",
        &format!("{FULLWIDTH_EXCLAMATION}{FULLWIDTH_LEFT_BRACKET}{FULLWIDTH_LEFT_BRACKET}"),
    );
    out = replace_all(
        &out,
        "[[",
        &format!("{FULLWIDTH_LEFT_BRACKET}{FULLWIDTH_LEFT_BRACKET}"),
    );
    out = replace_all(
        &out,
        "![",
        &format!("{FULLWIDTH_EXCLAMATION}{FULLWIDTH_LEFT_BRACKET}"),
    );
    out = replace_all(
        &out,
        "](",
        &format!("{FULLWIDTH_RIGHT_BRACKET}{FULLWIDTH_LEFT_PAREN}"),
    );
    out = replace_all(&out, "<%", &format!("{SINGLE_ANGLE_QUOTATION}%"));
    out = replace_all(&out, "%%", &format!("%{FULLWIDTH_PERCENT}"));
    out = replace_all(
        &out,
        "```",
        &format!("{FULLWIDTH_GRAVE}{FULLWIDTH_GRAVE}{FULLWIDTH_GRAVE}"),
    );

    let mut escaped = String::with_capacity(out.len());
    for ch in out.chars() {
        if ch == '<' {
            escaped.push(SINGLE_ANGLE_QUOTATION);
        } else if ch == '\\' {
            escaped.push(FULLWIDTH_BACKSLASH);
        } else {
            escaped.push(ch);
        }
    }
    escaped
}

fn replace_scheme_colons(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;
    while !rest.is_empty() {
        let mut matched = false;
        for scheme in SCHEMES {
            if rest.len() > scheme.len()
                && rest[..scheme.len()].eq_ignore_ascii_case(scheme)
                && rest.as_bytes()[scheme.len()] == b':'
            {
                out.push_str(&rest[..scheme.len()]);
                out.push(FULLWIDTH_COLON);
                rest = &rest[scheme.len() + 1..];
                matched = true;
                break;
            }
        }
        if matched {
            continue;
        }
        let next = rest.chars().next().expect("non-empty rest");
        out.push(next);
        rest = &rest[next.len_utf8()..];
    }
    out
}

fn replace_all(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_owned();
    }
    let mut out = String::new();
    let mut rest = haystack;
    while let Some(index) = rest.find(needle) {
        out.push_str(&rest[..index]);
        out.push_str(replacement);
        rest = &rest[index + needle.len()..];
    }
    out.push_str(rest);
    out
}

fn is_bidi_control(ch: char) -> bool {
    matches!(
        ch,
        '\u{200E}'
            | '\u{200F}'
            | '\u{202A}'
            | '\u{202B}'
            | '\u{202C}'
            | '\u{202D}'
            | '\u{202E}'
            | '\u{2066}'
            | '\u{2067}'
            | '\u{2068}'
            | '\u{2069}'
    )
}
