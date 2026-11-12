//! Several Super Agents share one brain and keep separate chats.
//!
//! Each bot has its own transcript. Facts and current work are recallable from
//! any bot, with the source bot named on the note.

/// One bot's current work. This is activity, not a durable fact about the owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkNote {
    /// Bot that owns the work.
    pub bot_id: String,
    /// Name shown in the chat list.
    pub name: String,
    /// Owner goal, which may be empty.
    pub goal: String,
    /// Short status line, such as "Working on the dog-house list".
    pub activity: String,
}

const PALETTE: &[&str] = &[
    "#6f8f7a",
    "#d98b5f",
    "#7aa2c4",
    "#c47aa2",
    "#c4b36a",
    "#8b7ad9",
];

/// Palette color for the bot created at `index`, starting at zero.
#[must_use]
pub fn bot_color(index: usize) -> &'static str {
    PALETTE[index % PALETTE.len()]
}

/// One-line status for the sidebar and for other bots' recall.
#[must_use]
pub fn work_status_line(goal: &str, active_item: Option<&str>) -> String {
    let focus = active_item
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| first_line(goal));
    let short = human_focus(focus);
    if short.is_empty() {
        return if focus.to_lowercase().starts_with("working") {
            "Working".to_owned()
        } else {
            String::new()
        };
    }
    format!("Working on {short}")
}

/// Drops a request preamble and keeps a few words of what the work is about.
fn human_focus(text: &str) -> String {
    let trimmed = text.trim();
    let body = trimmed
        .strip_prefix("Working on ")
        .or_else(|| trimmed.strip_prefix("working on "))
        .unwrap_or(trimmed);
    clip_words(strip_request_lead(body.trim()), 5)
}

fn strip_request_lead(text: &str) -> &str {
    let lower = text.to_lowercase();
    for lead in [
        "i want you to ",
        "i'd like you to ",
        "i would like you to ",
        "please ",
        "can you ",
        "could you ",
    ] {
        if lower.starts_with(lead) {
            return text[lead.len()..].trim();
        }
    }
    text
}

fn clip_words(text: &str, max_words: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }
    if words.len() <= max_words && text.chars().count() <= 42 {
        return text.to_owned();
    }
    format!("{}…", words.into_iter().take(max_words).collect::<Vec<_>>().join(" "))
}

/// Last-message preview, collapsed to one line and capped by characters.
///
/// A stored turn envelope contributes its sentence, not the wrapper.
#[must_use]
pub fn message_preview(body: &str, limit: usize) -> String {
    let visible = visible_message_text(body);
    let flat = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    if limit == 0 || flat.chars().count() <= limit {
        return flat;
    }
    let mut kept = String::new();
    for word in flat.split_whitespace() {
        let next = if kept.is_empty() {
            word.chars().count()
        } else {
            kept.chars().count() + 1 + word.chars().count()
        };
        if next + 1 > limit {
            break;
        }
        if !kept.is_empty() {
            kept.push(' ');
        }
        kept.push_str(word);
    }
    if kept.is_empty() {
        let end = limit.saturating_sub(1);
        let truncated: String = flat.chars().take(end).collect();
        return format!("{truncated}…");
    }
    format!("{kept}…")
}

/// Short "also happening" lines for bots other than the one being asked.
///
/// A named bot is the only match when the question names it. A general
/// question about other agents includes every other bot that has current work.
/// An unrelated question returns nothing, so another bot's transcript is not dumped.
#[must_use]
pub fn also_happening(query: &str, asker_id: &str, notes: &[WorkNote]) -> Vec<String> {
    let folded = query.to_lowercase();
    let candidates = notes
        .iter()
        .filter(|note| note.bot_id != asker_id)
        .filter_map(|note| {
            let status = note_status(note);
            if status.is_empty() {
                None
            } else {
                Some((note, status))
            }
        })
        .collect::<Vec<_>>();
    let named = candidates
        .iter()
        .filter(|(note, _)| name_mentioned(&folded, &note.name))
        .map(|(note, status)| also_line(&note.name, status))
        .collect::<Vec<_>>();
    if !named.is_empty() {
        return named;
    }
    if asks_about_other_work(&folded) {
        return candidates
            .iter()
            .map(|(note, status)| also_line(&note.name, status))
            .collect();
    }
    candidates
        .iter()
        .filter(|(_, status)| shares_word(&folded, &status.to_lowercase()))
        .map(|(note, status)| also_line(&note.name, status))
        .collect()
}

fn visible_message_text(body: &str) -> String {
    const MARK: &str = "\u{1}maia-turn\u{1}";
    if let Some(json) = body.strip_prefix(MARK)
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(json)
        && let Some(text) = value.get("text").and_then(|item| item.as_str())
        && !text.is_empty()
    {
        return text.to_owned();
    }
    body.to_owned()
}

fn note_status(note: &WorkNote) -> String {
    let activity = note.activity.trim();
    if !activity.is_empty() {
        return activity.to_owned();
    }
    work_status_line(&note.goal, None)
}

fn also_line(name: &str, status: &str) -> String {
    format!("Also happening: {name} — {status}.")
}

fn name_mentioned(query: &str, name: &str) -> bool {
    let name = name.trim().to_lowercase();
    name.chars().count() >= 3 && query.contains(&name)
}

fn asks_about_other_work(query: &str) -> bool {
    query.contains("working") || query.contains("other agent") || query.contains("other bot")
}

fn shares_word(query: &str, text: &str) -> bool {
    text.split(|ch: char| !ch.is_alphanumeric())
        .any(|word| word.len() >= 4 && query.contains(word))
}

fn first_line(text: &str) -> &str {
    text.split(['\n', '.']).next().unwrap_or("").trim()
}

#[cfg(test)]
mod tests {
    use super::WorkNote;
    use super::also_happening;
    use super::bot_color;
    use super::message_preview;
    use super::work_status_line;

    fn coding() -> WorkNote {
        WorkNote {
            bot_id: "coding".to_owned(),
            name: "Coding".to_owned(),
            goal: "dog-house list".to_owned(),
            activity: "Working on dog-house list".to_owned(),
        }
    }

    #[test]
    fn another_bot_reports_the_named_agents_current_work() {
        let lines = also_happening(
            "what is the coding agent working on?",
            "maia",
            &[coding()],
        );
        assert_eq!(
            lines,
            vec!["Also happening: Coding — Working on dog-house list.".to_owned()]
        );
    }

    #[test]
    fn a_general_work_question_includes_every_other_bot() {
        let lines = also_happening(
            "what are the other agents working on?",
            "maia",
            &[
                coding(),
                WorkNote {
                    bot_id: "arise".to_owned(),
                    name: "Arise".to_owned(),
                    goal: "invoice draft".to_owned(),
                    activity: String::new(),
                },
            ],
        );
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("Coding"));
        assert!(lines[1].contains("Arise"));
        assert!(lines[1].contains("invoice draft"));
    }

    #[test]
    fn an_unrelated_question_does_not_dump_other_work() {
        let lines = also_happening("what time is it?", "maia", &[coding()]);
        assert!(lines.is_empty());
    }

    #[test]
    fn the_asker_does_not_hear_their_own_work_as_also_happening() {
        let lines = also_happening("what is Coding working on?", "coding", &[coding()]);
        assert!(lines.is_empty());
    }

    #[test]
    fn status_line_prefers_the_active_item() {
        assert_eq!(
            work_status_line("Build a dog house", Some("cut the lumber")),
            "Working on cut the lumber"
        );
        assert_eq!(work_status_line("", None), "");
    }

    #[test]
    fn a_long_request_becomes_a_short_status() {
        let line = work_status_line(
            "I want you to investigate it and ideally fix the chat layout on the phone",
            None,
        );
        assert!(line.starts_with("Working on "));
        assert!(!line.to_lowercase().contains("i want you"));
        assert!(line.chars().count() <= 48);
        assert_eq!(
            work_status_line(
                "Working on I want you to investigate it and ideally fix the chat",
                None,
            )
            .to_lowercase()
            .contains("i want you"),
            false
        );
    }

    #[test]
    fn colors_cycle_and_previews_stay_one_line() {
        assert_eq!(bot_color(0), "#6f8f7a");
        assert_eq!(bot_color(6), "#6f8f7a");
        assert_eq!(message_preview("hello\nthere friend", 8), "hello…");
    }

    #[test]
    fn preview_uses_the_sentence_inside_a_turn_envelope() {
        let body = "\u{1}maia-turn\u{1}{\"route\":\"inspect_task\",\"text\":\"The chat is stuck on the investigation.\"}";
        assert_eq!(
            message_preview(body, 80),
            "The chat is stuck on the investigation."
        );
    }
}
