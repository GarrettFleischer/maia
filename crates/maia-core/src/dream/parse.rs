//! Honest promotion schema parse. The brain is not read.

use std::collections::BTreeSet;

use crate::brain::ClaimId;
use crate::brain::EpisodeId;
use crate::dream::error::PromotionError;
use crate::dream::json::Json;
use crate::dream::json::has_tool_channel;
use crate::dream::json::parse_json;
use crate::dream::sentence::validate_sentence;

/// One provisional claim draft accepted by [`parse_promotion`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimDraft {
    /// New opaque claim id.
    pub id: ClaimId,
    /// One declarative sentence.
    pub sentence: String,
    /// Provenance episode. Must equal the request episode.
    pub episode_id: EpisodeId,
}

/// Parses one promotion response against the single episode in scope.
pub fn parse_promotion(
    response: &str,
    episode: &EpisodeId,
) -> Result<Vec<ClaimDraft>, PromotionError> {
    let value = parse_json(response).ok_or(PromotionError::Malformed)?;
    if has_tool_channel(&value) {
        return Err(PromotionError::ToolChannel);
    }
    let Json::Object(map) = value else {
        return Err(PromotionError::InvalidType);
    };
    if map.keys().any(|key| key != "claims") {
        return Err(PromotionError::UnknownField);
    }
    let claims = map.get("claims").ok_or(PromotionError::MissingField)?;
    let Json::Array(items) = claims else {
        return Err(PromotionError::InvalidType);
    };
    let mut drafts = Vec::with_capacity(items.len());
    let mut seen = BTreeSet::new();
    for item in items {
        let draft = parse_claim(item, episode)?;
        if !seen.insert(draft.id.clone()) {
            return Err(PromotionError::DuplicateId);
        }
        drafts.push(draft);
    }
    Ok(drafts)
}

fn parse_claim(value: &Json, episode: &EpisodeId) -> Result<ClaimDraft, PromotionError> {
    let Json::Object(map) = value else {
        return Err(PromotionError::InvalidType);
    };
    const ALLOWED: [&str; 3] = ["episode_id", "id", "sentence"];
    if map.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(PromotionError::UnknownField);
    }
    let id = required_string(map, "id")?;
    if id.is_empty() {
        return Err(PromotionError::EmptyId);
    }
    let sentence = required_string(map, "sentence")?;
    validate_sentence(sentence).map_err(PromotionError::InvalidSentence)?;
    let episode_id = required_string(map, "episode_id")?;
    if episode_id != episode.as_str() {
        return Err(PromotionError::ForgedEpisodeId);
    }
    Ok(ClaimDraft {
        id: ClaimId::new(id),
        sentence: sentence.to_owned(),
        episode_id: episode.clone(),
    })
}

fn required_string<'a>(
    map: &'a std::collections::BTreeMap<String, Json>,
    key: &str,
) -> Result<&'a str, PromotionError> {
    match map.get(key) {
        None => Err(PromotionError::MissingField),
        Some(Json::String(value)) => Ok(value.as_str()),
        Some(_) => Err(PromotionError::InvalidType),
    }
}
