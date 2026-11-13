//! Owner-approved promotion decision schema. Ids and taint stay outside the model.

use std::collections::BTreeSet;

use crate::brain::ClaimId;
use crate::dream::error::PromotionError;
use crate::dream::json::Json;
use crate::dream::json::has_tool_channel;
use crate::dream::json::parse_json;
use crate::dream::sentence::validate_sentence;

/// Maximum characters allowed in one promoted sentence.
pub const MAX_CLAIM_SENTENCE_CHARS: usize = 280;

/// Maximum characters allowed in one session summary from the promoter.
pub const MAX_SESSION_SUMMARY_CHARS: usize = 2_000;

/// How a conclusion was formed. Induced rows are dream-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimKind {
    /// Said or restated by the owner or the reply.
    Explicit,
    /// Direct deduction from the episode.
    Deduction,
    /// Pattern induction from a dream. Not written online.
    Induced,
}

impl ClaimKind {
    /// Stable wire and column value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Explicit => "explicit",
            Self::Deduction => "deduction",
            Self::Induced => "induced",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "explicit" => Some(Self::Explicit),
            "deduction" => Some(Self::Deduction),
            "induced" => Some(Self::Induced),
            _ => None,
        }
    }
}

/// One new conclusion draft. Strings in JSON default to [`ClaimKind::Explicit`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewClaimDraft {
    /// One-sentence claim text.
    pub sentence: String,
    /// Explicit or deduction. Induced is rejected online.
    pub kind: ClaimKind,
}

/// One replace draft: close an existing claim and insert a successor sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceDraft {
    /// Existing claim to close.
    pub old: ClaimId,
    /// Successor one-sentence claim text.
    pub sentence: String,
}

/// Strict promotion model output. Claim ids for `new` are assigned by code later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionDecision {
    /// Model asks to write nothing.
    pub skip: bool,
    /// New one-sentence claims.
    pub new: Vec<NewClaimDraft>,
    /// Existing claim ids that are merely repeated.
    pub same: Vec<ClaimId>,
    /// Existing claims to close with a successor sentence.
    pub replaces: Vec<ReplaceDraft>,
    /// Updated rolling session summary for this bot. Empty means leave the stored summary alone.
    pub summary: String,
}

/// Parses one promotion decision. Unknown fields and tool channels fail the call.
///
/// A code fence or short preamble may wrap the object. The object itself is
/// still rejected for unknown fields, missing fields, and tool channels.
/// Items in `new` may be a sentence string or `{"sentence","kind"}`.
pub fn parse_promotion_decision(response: &str) -> Result<PromotionDecision, PromotionError> {
    let text = json_object_text(response).ok_or(PromotionError::Malformed)?;
    let value = parse_json(text).ok_or(PromotionError::Malformed)?;
    if has_tool_channel(&value) {
        return Err(PromotionError::ToolChannel);
    }
    let Json::Object(map) = value else {
        return Err(PromotionError::InvalidType);
    };
    const ALLOWED: [&str; 5] = ["new", "replaces", "same", "skip", "summary"];
    if map.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(PromotionError::UnknownField);
    }
    let skip = match map.get("skip") {
        None => return Err(PromotionError::MissingField),
        Some(Json::Bool(value)) => *value,
        Some(_) => return Err(PromotionError::InvalidType),
    };
    let new = new_claim_array(map.get("new").ok_or(PromotionError::MissingField)?)?;
    let same = id_array(map.get("same").ok_or(PromotionError::MissingField)?)?;
    let replaces = replace_array(map.get("replaces").ok_or(PromotionError::MissingField)?)?;
    let summary = match map.get("summary") {
        None => String::new(),
        Some(Json::String(text)) => {
            let trimmed = text.trim().to_owned();
            if trimmed.chars().count() > MAX_SESSION_SUMMARY_CHARS {
                return Err(PromotionError::SentenceTooLong);
            }
            trimmed
        }
        Some(_) => return Err(PromotionError::InvalidType),
    };
    Ok(PromotionDecision {
        skip,
        new,
        same,
        replaces,
        summary,
    })
}

fn json_object_text(input: &str) -> Option<&str> {
    let trimmed = input.trim();
    if parse_json(trimmed).is_some() {
        return Some(trimmed);
    }
    let start = trimmed.find('{')?;
    let end = balanced_object_end(&trimmed[start..])?;
    Some(&trimmed[start..start + end])
}

fn balanced_object_end(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (index, byte) in bytes.iter().enumerate() {
        if in_string {
            if escape {
                escape = false;
                continue;
            }
            match *byte {
                b'\\' => escape = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn validate_decision_sentence(sentence: &str) -> Result<(), PromotionError> {
    validate_sentence(sentence).map_err(PromotionError::InvalidSentence)?;
    if sentence.chars().count() > MAX_CLAIM_SENTENCE_CHARS {
        return Err(PromotionError::SentenceTooLong);
    }
    Ok(())
}

fn new_claim_array(value: &Json) -> Result<Vec<NewClaimDraft>, PromotionError> {
    let Json::Array(items) = value else {
        return Err(PromotionError::InvalidType);
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        out.push(parse_new_claim(item)?);
    }
    Ok(out)
}

fn parse_new_claim(value: &Json) -> Result<NewClaimDraft, PromotionError> {
    match value {
        Json::String(text) => {
            validate_decision_sentence(text)?;
            Ok(NewClaimDraft {
                sentence: text.clone(),
                kind: ClaimKind::Explicit,
            })
        }
        Json::Object(map) => {
            const ALLOWED: [&str; 2] = ["sentence", "kind"];
            if map.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
                return Err(PromotionError::UnknownField);
            }
            let sentence = match map.get("sentence") {
                None => return Err(PromotionError::MissingField),
                Some(Json::String(text)) => text.clone(),
                Some(_) => return Err(PromotionError::InvalidType),
            };
            validate_decision_sentence(&sentence)?;
            let kind = match map.get("kind") {
                None => ClaimKind::Explicit,
                Some(Json::String(text)) => match ClaimKind::parse(text) {
                    Some(ClaimKind::Induced) | None => return Err(PromotionError::InvalidType),
                    Some(kind) => kind,
                },
                Some(_) => return Err(PromotionError::InvalidType),
            };
            Ok(NewClaimDraft { sentence, kind })
        }
        _ => Err(PromotionError::InvalidType),
    }
}

fn id_array(value: &Json) -> Result<Vec<ClaimId>, PromotionError> {
    let Json::Array(items) = value else {
        return Err(PromotionError::InvalidType);
    };
    let mut out = Vec::with_capacity(items.len());
    let mut seen = BTreeSet::new();
    for item in items {
        let Json::String(id) = item else {
            return Err(PromotionError::InvalidType);
        };
        if id.is_empty() {
            return Err(PromotionError::EmptyId);
        }
        let claim = ClaimId::new(id.clone());
        if !seen.insert(claim.clone()) {
            return Err(PromotionError::DuplicateId);
        }
        out.push(claim);
    }
    Ok(out)
}

fn replace_array(value: &Json) -> Result<Vec<ReplaceDraft>, PromotionError> {
    let Json::Array(items) = value else {
        return Err(PromotionError::InvalidType);
    };
    let mut out = Vec::with_capacity(items.len());
    let mut seen = BTreeSet::new();
    for item in items {
        let Json::Object(map) = item else {
            return Err(PromotionError::InvalidType);
        };
        const ALLOWED: [&str; 2] = ["old", "sentence"];
        if map.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
            return Err(PromotionError::UnknownField);
        }
        let old = match map.get("old") {
            None => return Err(PromotionError::MissingField),
            Some(Json::String(id)) if !id.is_empty() => ClaimId::new(id.clone()),
            Some(Json::String(_)) => return Err(PromotionError::EmptyId),
            Some(_) => return Err(PromotionError::InvalidType),
        };
        if !seen.insert(old.clone()) {
            return Err(PromotionError::DuplicateId);
        }
        let sentence = match map.get("sentence") {
            None => return Err(PromotionError::MissingField),
            Some(Json::String(text)) => text.clone(),
            Some(_) => return Err(PromotionError::InvalidType),
        };
        validate_decision_sentence(&sentence)?;
        out.push(ReplaceDraft { old, sentence });
    }
    Ok(out)
}
