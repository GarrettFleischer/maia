//! Strict JSON subset for locked promotion and consolidation schemas.

use std::collections::BTreeMap;

/// Parsed JSON value. Objects keep deterministic key order via [`BTreeMap`].
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Json {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

pub(crate) fn parse_json(input: &str) -> Option<Json> {
    let mut parser = Parser {
        input: input.as_bytes(),
        index: 0,
    };
    let value = parser.parse_value()?;
    parser.skip_ws();
    if parser.index != parser.input.len() {
        return None;
    }
    Some(value)
}

pub(crate) fn has_tool_channel(value: &Json) -> bool {
    match value {
        Json::Object(map) => {
            map.keys().any(|key| is_tool_key(key)) || map.values().any(has_tool_channel)
        }
        Json::Array(items) => items.iter().any(has_tool_channel),
        Json::Null | Json::Bool(_) | Json::Number(_) | Json::String(_) => false,
    }
}

fn is_tool_key(key: &str) -> bool {
    matches!(key, "tool_calls" | "tool_call" | "function_call")
}

struct Parser<'a> {
    input: &'a [u8],
    index: usize,
}

impl<'a> Parser<'a> {
    fn parse_value(&mut self) -> Option<Json> {
        self.skip_ws();
        let byte = self.peek()?;
        match byte {
            b'n' => self.parse_literal(b"null", Json::Null),
            b't' => self.parse_literal(b"true", Json::Bool(true)),
            b'f' => self.parse_literal(b"false", Json::Bool(false)),
            b'"' => self.parse_string().map(Json::String),
            b'[' => self.parse_array(),
            b'{' => self.parse_object(),
            b'-' | b'0'..=b'9' => self.parse_number(),
            _ => None,
        }
    }

    fn parse_literal(&mut self, literal: &[u8], value: Json) -> Option<Json> {
        if self.input.get(self.index..)?.starts_with(literal) {
            self.index += literal.len();
            Some(value)
        } else {
            None
        }
    }

    fn parse_array(&mut self) -> Option<Json> {
        self.bump_byte(b'[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.bump();
            return Some(Json::Array(items));
        }
        loop {
            items.push(self.parse_value()?);
            self.skip_ws();
            match self.peek()? {
                b']' => {
                    self.bump();
                    break;
                }
                b',' => {
                    self.bump();
                }
                _ => return None,
            }
        }
        Some(Json::Array(items))
    }

    fn parse_object(&mut self) -> Option<Json> {
        self.bump_byte(b'{')?;
        let mut map = BTreeMap::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.bump();
            return Some(Json::Object(map));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return None;
            }
            let key = self.parse_string()?;
            if map.contains_key(&key) {
                return None;
            }
            self.skip_ws();
            self.bump_byte(b':')?;
            let value = self.parse_value()?;
            map.insert(key, value);
            self.skip_ws();
            match self.peek()? {
                b'}' => {
                    self.bump();
                    break;
                }
                b',' => {
                    self.bump();
                }
                _ => return None,
            }
        }
        Some(Json::Object(map))
    }

    fn parse_number(&mut self) -> Option<Json> {
        let start = self.index;
        if self.peek() == Some(b'-') {
            self.bump();
        }
        match self.peek()? {
            b'0' => {
                self.bump();
            }
            b'1'..=b'9' => {
                self.bump();
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.bump();
                }
            }
            _ => return None,
        }
        if self.peek() == Some(b'.') {
            self.bump();
            let mut digits = false;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                digits = true;
                self.bump();
            }
            if !digits {
                return None;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.bump();
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.bump();
            }
            let mut digits = false;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                digits = true;
                self.bump();
            }
            if !digits {
                return None;
            }
        }
        let raw = std::str::from_utf8(self.input.get(start..self.index)?).ok()?;
        Some(Json::Number(raw.to_owned()))
    }

    fn parse_string(&mut self) -> Option<String> {
        self.bump_byte(b'"')?;
        let mut out = String::new();
        loop {
            let byte = self.peek()?;
            match byte {
                b'"' => {
                    self.bump();
                    return Some(out);
                }
                b'\\' => {
                    self.bump();
                    out.push(self.parse_escape()?);
                }
                0x00..=0x1f => return None,
                _ => out.push(self.parse_char()?),
            }
        }
    }

    fn parse_escape(&mut self) -> Option<char> {
        match self.bump()? {
            b'"' => Some('"'),
            b'\\' => Some('\\'),
            b'/' => Some('/'),
            b'b' => Some('\u{0008}'),
            b'f' => Some('\u{000c}'),
            b'n' => Some('\n'),
            b'r' => Some('\r'),
            b't' => Some('\t'),
            b'u' => self.parse_unicode_escape(),
            _ => None,
        }
    }

    fn parse_unicode_escape(&mut self) -> Option<char> {
        let mut code = 0u32;
        for _ in 0..4 {
            let hex = self.bump()?;
            code = code * 16 + hex_value(hex)?;
        }
        char::from_u32(code)
    }

    fn parse_char(&mut self) -> Option<char> {
        let rest = self.input.get(self.index..)?;
        let text = std::str::from_utf8(rest).ok()?;
        let ch = text.chars().next()?;
        self.index += ch.len_utf8();
        Some(ch)
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.bump();
        }
    }

    fn bump_byte(&mut self, expected: u8) -> Option<()> {
        if self.peek() == Some(expected) {
            self.bump();
            Some(())
        } else {
            None
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.index).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.index += 1;
        Some(byte)
    }
}

fn hex_value(byte: u8) -> Option<u32> {
    match byte {
        b'0'..=b'9' => Some(u32::from(byte - b'0')),
        b'a'..=b'f' => Some(u32::from(byte - b'a') + 10),
        b'A'..=b'F' => Some(u32::from(byte - b'A') + 10),
        _ => None,
    }
}
