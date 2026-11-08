//! Minimal JSON helpers for router normalization (no serde in `maia-core`).

use crate::router::error::RouterError;

/// Returns true when `text` is a JSON object with balanced braces and valid string escapes.
pub fn is_json_object(text: &str) -> bool {
    let trimmed = text.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return false;
    }
    json_object_depth_ok(trimmed)
}

fn json_object_depth_ok(text: &str) -> bool {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for byte in text.bytes() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            if byte == b'\\' {
                escape = true;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0 && !in_string
}

/// Reads a string field value for a quoted key in a JSON object.
pub fn read_string_field(object: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let start = object.find(&needle)?;
    let after_key = &object[start + needle.len()..];
    let colon = after_key.find(':')?;
    let rest = after_key[colon + 1..].trim_start();
    if rest.starts_with("null") {
        return None;
    }
    if !rest.starts_with('"') {
        return None;
    }
    decode_json_string(&rest[1..])
}

/// Reads provider thinking from `reasoning` or `reasoning_content`.
pub fn read_reasoning_text(object: &str) -> Option<String> {
    read_string_field(object, "reasoning")
        .or_else(|| read_string_field(object, "reasoning_content"))
}

fn decode_json_string(input: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            return Some(out);
        }
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next()? {
            escaped @ ('"' | '\\' | '/') => out.push(escaped),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'u' => out.push(decode_unicode_escape(&mut chars)?),
            _ => return None,
        }
    }
    None
}

fn decode_unicode_escape(chars: &mut impl Iterator<Item = char>) -> Option<char> {
    let code = read_hex4(chars)?;
    if !(0xD800..=0xDBFF).contains(&code) {
        return char::from_u32(code);
    }
    if chars.next()? != '\\' || chars.next()? != 'u' {
        return None;
    }
    let low = read_hex4(chars)?;
    if !(0xDC00..=0xDFFF).contains(&low) {
        return None;
    }
    let combined = 0x1_0000 + (((code - 0xD800) << 10) | (low - 0xDC00));
    char::from_u32(combined)
}

fn read_hex4(chars: &mut impl Iterator<Item = char>) -> Option<u32> {
    let mut hex = [0u8; 4];
    for slot in &mut hex {
        let digit = chars.next()?;
        if !digit.is_ascii_hexdigit() {
            return None;
        }
        *slot = u8::try_from(digit).ok()?;
    }
    let text = std::str::from_utf8(&hex).ok()?;
    u32::from_str_radix(text, 16).ok()
}

/// Reads a numeric field as u64 when present.
pub fn read_u64_field(object: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let start = object.find(&needle)?;
    let after_key = &object[start + needle.len()..];
    let colon = after_key.find(':')?;
    let rest = after_key[colon + 1..].trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest.get(..end)?.parse().ok()
}

/// Reads the first object inside `"choices":[{...}]`.
pub fn first_choice_object(body: &str) -> Result<String, RouterError> {
    let choices_key = body
        .find("\"choices\"")
        .ok_or_else(|| protocol("missing choices"))?;
    let after = &body[choices_key..];
    let open = after
        .find('[')
        .ok_or_else(|| protocol("missing choices array"))?;
    let slice = &after[open + 1..];
    let start = slice
        .find('{')
        .ok_or_else(|| protocol("missing choice object"))?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (offset, byte) in slice[start..].bytes().enumerate() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            if byte == b'\\' {
                escape = true;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(slice[start..start + offset + 1].to_owned());
                }
            }
            _ => {}
        }
    }
    Err(protocol("unterminated choice object"))
}

/// Reads `"message":{...}` from a choice object.
pub fn message_object(choice: &str) -> Result<String, RouterError> {
    let key = choice
        .find("\"message\"")
        .ok_or_else(|| protocol("missing message"))?;
    let after = &choice[key..];
    let start = after
        .find('{')
        .ok_or_else(|| protocol("missing message object"))?;
    extract_balanced_object(&after[start..])
}

fn extract_balanced_object(text: &str) -> Result<String, RouterError> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (offset, byte) in text.bytes().enumerate() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            if byte == b'\\' {
                escape = true;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(text[..=offset].to_owned());
                }
            }
            _ => {}
        }
    }
    Err(protocol("unterminated object"))
}

fn protocol(detail: impl Into<String>) -> RouterError {
    RouterError::Protocol {
        detail: detail.into(),
    }
}
