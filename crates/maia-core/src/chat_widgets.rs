//! In-chat question cards and secret requests.
//!
//! Honest leaves: parse tool payloads, format owner replies, and build
//! transcript widget payloads. I/O and storage live at the daemon skin.

use serde::Deserialize;
use serde::Serialize;

/// Single-choice (radio) or multi-select (checkboxes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    /// Exactly one choice (plus optional Other).
    Single,
    /// Zero or more choices (plus optional Other).
    Multi,
}

/// One question inside an `ask_questions` card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionSpec {
    /// Stable id within the card (used when answering).
    pub id: String,
    /// Prompt shown to the owner.
    pub prompt: String,
    /// Choice mode.
    pub kind: QuestionKind,
    /// Optional preset choices. Other is always available in the UI.
    #[serde(default)]
    pub choices: Vec<String>,
}

/// One answered question from the owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionAnswer {
    /// Matches [`QuestionSpec::id`].
    pub id: String,
    /// Selected preset labels.
    #[serde(default)]
    pub selected: Vec<String>,
    /// Free-text Other, when used.
    #[serde(default)]
    pub other: String,
}

/// Parsed `ask_questions` tool arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskQuestionsPayload {
    /// Optional intro sentence above the card.
    #[serde(default)]
    pub intro: String,
    /// Questions to show (at least one).
    pub questions: Vec<QuestionSpec>,
}

/// A secret the agent needs the owner to provide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretRequest {
    /// Env / vault name tools will read (never the value).
    pub name: String,
}

/// Open CEO question for wake briefs (prompt-first reminders).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenQuestionBrief {
    /// Short question text.
    pub text: String,
    /// Seconds since the ask was posted.
    pub age_secs: u64,
}

/// Parses `ask_questions` arguments JSON.
#[must_use]
pub fn parse_ask_questions(arguments_json: &str) -> Option<AskQuestionsPayload> {
    let value: serde_json::Value = serde_json::from_str(arguments_json).ok()?;
    if let Ok(payload) = serde_json::from_value::<AskQuestionsPayload>(value.clone()) {
        return normalize_ask_questions(payload);
    }
    // Allow message-wrapped JSON: {"message":"{...}"} or {"message":"[...]"}.
    let message = value.get("message")?.as_str()?.trim();
    if message.is_empty() {
        return None;
    }
    if let Ok(payload) = serde_json::from_str::<AskQuestionsPayload>(message) {
        return normalize_ask_questions(payload);
    }
    if let Ok(questions) = serde_json::from_str::<Vec<QuestionSpec>>(message) {
        return normalize_ask_questions(AskQuestionsPayload {
            intro: String::new(),
            questions,
        });
    }
    None
}

/// Parses `request_secret` arguments JSON (`name` or `message`).
#[must_use]
pub fn parse_secret_request(arguments_json: &str) -> Option<SecretRequest> {
    let value: serde_json::Value = serde_json::from_str(arguments_json).ok()?;
    let raw = value
        .get("name")
        .and_then(|item| item.as_str())
        .or_else(|| value.get("message").and_then(|item| item.as_str()))
        .unwrap_or("")
        .trim();
    let name = sanitize_secret_name(raw)?;
    Some(SecretRequest { name })
}

/// Keeps env-safe secret names (letters, digits, `_`, `-`, `.`).
#[must_use]
pub fn sanitize_secret_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return None;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
    {
        return None;
    }
    if trimmed.starts_with('.') || trimmed.starts_with('-') {
        return None;
    }
    Some(trimmed.to_owned())
}

/// Formats owner answers as the chat reply the orchestrator receives.
#[must_use]
pub fn format_question_answers_reply(intro: &str, answers: &[QuestionAnswer]) -> String {
    let mut lines = Vec::new();
    let intro = intro.trim();
    if !intro.is_empty() {
        lines.push(intro.to_owned());
    } else {
        lines.push("Answers:".to_owned());
    }
    for answer in answers {
        let mut parts = answer.selected.clone();
        let other = answer.other.trim();
        if !other.is_empty() {
            parts.push(format!("Other: {other}"));
        }
        let body = if parts.is_empty() {
            "(no selection)".to_owned()
        } else {
            parts.join(", ")
        };
        lines.push(format!("{}: {body}", answer.id));
    }
    lines.join("\n")
}

/// Notice posted after a secret is stored (never includes the value).
#[must_use]
pub fn format_secret_provided_notice(name: &str) -> String {
    format!("Secret {name} provided.")
}

/// Preview / chat sentence for a question card.
#[must_use]
pub fn ask_questions_summary(payload: &AskQuestionsPayload) -> String {
    let intro = payload.intro.trim();
    if !intro.is_empty() {
        return intro.to_owned();
    }
    match payload.questions.len() {
        0 => "Need a few decisions.".to_owned(),
        1 => payload.questions[0].prompt.clone(),
        n => format!("Need your answers to {n} questions."),
    }
}

/// Preview / chat sentence for a secret request (never includes a value).
#[must_use]
pub fn secret_request_summary(request: &SecretRequest) -> String {
    format!(
        "Need secret `{}` (value stays private).",
        request.name
    )
}

/// True when `name` is a duplicate of an already-open question (token overlap).
#[must_use]
pub fn is_duplicate_open_question(candidate: &str, open: &[OpenQuestionBrief]) -> bool {
    let keys = distinctive_tokens(candidate);
    if keys.is_empty() {
        return false;
    }
    open.iter().any(|item| {
        let lower = item.text.to_ascii_lowercase();
        keys.iter().any(|key| lower.contains(key.as_str()))
    })
}

fn normalize_ask_questions(mut payload: AskQuestionsPayload) -> Option<AskQuestionsPayload> {
    payload.intro = payload.intro.trim().to_owned();
    payload.questions.retain(|question| {
        !question.id.trim().is_empty() && !question.prompt.trim().is_empty()
    });
    for question in &mut payload.questions {
        question.id = question.id.trim().to_owned();
        question.prompt = question.prompt.trim().to_owned();
        question.choices = question
            .choices
            .iter()
            .map(|choice| choice.trim().to_owned())
            .filter(|choice| !choice.is_empty())
            .collect();
    }
    if payload.questions.is_empty() {
        None
    } else {
        Some(payload)
    }
}

fn distinctive_tokens(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = text
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .map(str::to_ascii_lowercase)
        .filter(|token| token.len() >= 5)
        .collect();
    tokens.sort();
    tokens.dedup();
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ask_questions_accepts_direct_payload() {
        let raw = r#"{
            "intro": "Pick shipping options",
            "questions": [
                {"id": "channel", "prompt": "Channel?", "kind": "single", "choices": ["email", "sms"]},
                {"id": "topics", "prompt": "Topics?", "kind": "multi", "choices": ["a", "b"]}
            ]
        }"#;
        let parsed = parse_ask_questions(raw).expect("payload");
        assert_eq!(parsed.intro, "Pick shipping options");
        assert_eq!(parsed.questions.len(), 2);
        assert_eq!(parsed.questions[0].kind, QuestionKind::Single);
        assert_eq!(parsed.questions[1].kind, QuestionKind::Multi);
    }

    #[test]
    fn parse_secret_request_sanitizes_name() {
        assert_eq!(
            parse_secret_request(r#"{"name":"RUN67_TEST_KEY"}"#)
                .expect("ok")
                .name,
            "RUN67_TEST_KEY"
        );
        assert!(parse_secret_request(r#"{"name":"bad name"}"#).is_none());
        assert!(parse_secret_request(r#"{"message":"OK_SECRET"}"#).is_some());
    }

    #[test]
    fn format_answers_includes_other() {
        let text = format_question_answers_reply(
            "",
            &[
                QuestionAnswer {
                    id: "channel".to_owned(),
                    selected: vec!["email".to_owned()],
                    other: String::new(),
                },
                QuestionAnswer {
                    id: "topics".to_owned(),
                    selected: vec!["a".to_owned()],
                    other: "custom".to_owned(),
                },
            ],
        );
        assert!(text.contains("channel: email"));
        assert!(text.contains("topics: a, Other: custom"));
    }
}
