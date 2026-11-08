//! Strict vault note frontmatter parsing.

use crate::vault::error::FrontmatterIssue;
use crate::vault::error::VaultError;
use crate::vault::path::validate_vault_relative;
use crate::vault::types::NoteFrontmatter;
use crate::vault::types::NoteKind;
use crate::vault::types::ParsedNote;

const ALLOWED_KEYS: [&str; 4] = ["description", "id", "kind", "see"];

/// Parses a full note, returning validated frontmatter and exact post-frontmatter body bytes.
pub fn parse_note(bytes: &[u8]) -> Result<ParsedNote, VaultError> {
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        return Err(VaultError::InvalidEncoding);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| VaultError::InvalidEncoding)?;
    let (yaml, body_start) = split_frontmatter(text)?;
    let frontmatter = parse_frontmatter(yaml)?;
    let body = bytes[body_start..].to_vec();
    Ok(ParsedNote { frontmatter, body })
}

fn split_frontmatter(text: &str) -> Result<(&str, usize), VaultError> {
    if !text.starts_with("---") {
        return Err(VaultError::InvalidFrontmatter(
            FrontmatterIssue::MissingField,
        ));
    }
    let after_open = &text[3..];
    let open_len = if after_open.starts_with('\n') {
        4
    } else if after_open.starts_with("\r\n") {
        5
    } else {
        return Err(VaultError::InvalidFrontmatter(
            FrontmatterIssue::InvalidValue,
        ));
    };
    let rest = &text[open_len..];
    let close = find_frontmatter_close(rest).ok_or(VaultError::InvalidFrontmatter(
        FrontmatterIssue::MissingField,
    ))?;
    let yaml = &rest[..close.start];
    let body_start = open_len + close.end;
    Ok((yaml, body_start))
}

struct Span {
    start: usize,
    end: usize,
}

fn find_frontmatter_close(yaml_and_rest: &str) -> Option<Span> {
    let mut offset = 0;
    for line in yaml_and_rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" {
            return Some(Span {
                start: offset,
                end: offset + line.len(),
            });
        }
        offset += line.len();
    }
    None
}

fn parse_frontmatter(yaml: &str) -> Result<NoteFrontmatter, VaultError> {
    let mut id: Option<String> = None;
    let mut description: Option<String> = None;
    let mut see: Option<Vec<String>> = None;
    let mut kind: Option<NoteKind> = None;
    let mut seen_keys = std::collections::BTreeSet::new();

    let mut lines = yaml.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            return Err(VaultError::InvalidFrontmatter(
                FrontmatterIssue::InvalidValue,
            ));
        }
        let Some((key, value)) = line.split_once(':') else {
            return Err(VaultError::InvalidFrontmatter(
                FrontmatterIssue::InvalidValue,
            ));
        };
        let key = key.trim();
        if !ALLOWED_KEYS.contains(&key) {
            return Err(VaultError::InvalidFrontmatter(
                FrontmatterIssue::UnknownField,
            ));
        }
        if !seen_keys.insert(key) {
            return Err(VaultError::InvalidFrontmatter(
                FrontmatterIssue::DuplicateKey,
            ));
        }

        match key {
            "id" => {
                let parsed = parse_scalar(value)?;
                if parsed.is_empty() {
                    return Err(VaultError::InvalidFrontmatter(
                        FrontmatterIssue::InvalidValue,
                    ));
                }
                id = Some(parsed);
            }
            "description" => {
                let parsed = parse_scalar(value)?;
                if parsed.is_empty() || parsed.contains(['\r', '\n']) {
                    return Err(VaultError::InvalidFrontmatter(
                        FrontmatterIssue::InvalidValue,
                    ));
                }
                description = Some(parsed);
            }
            "kind" => {
                let parsed_kind = NoteKind::parse(parse_scalar(value)?.as_str())
                    .map_err(VaultError::InvalidFrontmatter)?;
                kind = Some(parsed_kind);
            }
            "see" => {
                see = Some(parse_see(value, &mut lines)?);
            }
            _ => unreachable!("allowed key set is exhaustive"),
        }
    }

    Ok(NoteFrontmatter {
        id: id.ok_or(VaultError::InvalidFrontmatter(
            FrontmatterIssue::MissingField,
        ))?,
        description: description.ok_or(VaultError::InvalidFrontmatter(
            FrontmatterIssue::MissingField,
        ))?,
        see: see.ok_or(VaultError::InvalidFrontmatter(
            FrontmatterIssue::MissingField,
        ))?,
        kind: kind.ok_or(VaultError::InvalidFrontmatter(
            FrontmatterIssue::MissingField,
        ))?,
    })
}

fn parse_scalar(raw: &str) -> Result<String, VaultError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(VaultError::InvalidFrontmatter(
            FrontmatterIssue::InvalidValue,
        ));
    }
    if trimmed == ">" || trimmed == "|" {
        return Err(VaultError::InvalidFrontmatter(
            FrontmatterIssue::InvalidValue,
        ));
    }
    if trimmed.starts_with(['&', '*', '!']) {
        return Err(VaultError::InvalidFrontmatter(
            FrontmatterIssue::InvalidValue,
        ));
    }
    if let Some(quoted) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return unescape_yaml_double_quoted(quoted);
    }
    if let Some(quoted) = trimmed
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
    {
        return Ok(quoted.to_owned());
    }
    Ok(trimmed.to_owned())
}

fn unescape_yaml_double_quoted(raw: &str) -> Result<String, VaultError> {
    let mut out = String::new();
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let Some(next) = chars.next() else {
                return Err(VaultError::InvalidFrontmatter(
                    FrontmatterIssue::InvalidValue,
                ));
            };
            match next {
                '"' | '\\' | '/' => out.push(next),
                'n' => out.push('\n'),
                't' => out.push('\t'),
                _ => {
                    return Err(VaultError::InvalidFrontmatter(
                        FrontmatterIssue::InvalidValue,
                    ));
                }
            }
        } else {
            out.push(ch);
        }
    }
    Ok(out)
}

fn parse_see(
    first_line_value: &str,
    lines: &mut std::iter::Peekable<std::str::Lines<'_>>,
) -> Result<Vec<String>, VaultError> {
    let trimmed = first_line_value.trim();
    if trimmed.is_empty() {
        return parse_see_list(lines);
    }
    if trimmed == "[]" {
        return Ok(Vec::new());
    }
    Err(VaultError::InvalidFrontmatter(
        FrontmatterIssue::InvalidValue,
    ))
}

fn parse_see_list(
    lines: &mut std::iter::Peekable<std::str::Lines<'_>>,
) -> Result<Vec<String>, VaultError> {
    let mut links = Vec::new();
    while let Some(line) = lines.peek() {
        let trimmed = line.trim();
        if !trimmed.starts_with("- ") {
            break;
        }
        lines.next();
        let item = trimmed.strip_prefix("- ").unwrap_or(trimmed);
        let scalar = parse_scalar(item)?;
        links.push(parse_wikilink_path(&scalar)?);
    }
    Ok(links)
}

fn parse_wikilink_path(raw: &str) -> Result<String, VaultError> {
    let inner = raw
        .strip_prefix("[[")
        .and_then(|s| s.strip_suffix("]]"))
        .ok_or(VaultError::InvalidFrontmatter(
            FrontmatterIssue::InvalidValue,
        ))?;
    if inner.ends_with(".md") {
        return Err(VaultError::InvalidFrontmatter(
            FrontmatterIssue::InvalidValue,
        ));
    }
    validate_vault_relative(inner)
        .map_err(|_| VaultError::InvalidFrontmatter(FrontmatterIssue::InvalidValue))
}
