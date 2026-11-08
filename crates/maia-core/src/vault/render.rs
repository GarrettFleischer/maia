//! Generated index and entity page rendering.

use crate::vault::error::RenderEntityError;
use crate::vault::neutralize::neutralize_inline_markdown;
use crate::vault::types::EntityFact;
use crate::vault::types::NoteHeader;

const GENERATED_START: &str = "<!-- maia:generated:start -->";
const GENERATED_END: &str = "<!-- maia:generated:end -->";
const HUMAN_START: &str = "<!-- maia:human:start -->";
const HUMAN_END: &str = "<!-- maia:human:end -->";

/// Renders a generated folder index body from child headers (LF line endings).
pub fn render_index(children: &[NoteHeader]) -> String {
    let mut sorted: Vec<&NoteHeader> = children.iter().collect();
    sorted.sort_by_key(|child| child.link.as_str());
    let mut out = String::new();
    for child in sorted {
        out.push_str("- [[");
        out.push_str(&child.link);
        out.push_str("]] — ");
        out.push_str(&neutralize_inline_markdown(&child.description));
        out.push('\n');
    }
    out
}

/// Replaces the generated region of an entity page while preserving human bytes exactly.
pub fn render_entity_page(
    existing: &str,
    facts: &[EntityFact],
) -> Result<String, RenderEntityError> {
    let body_start = note_body_start(existing).ok_or(RenderEntityError::InvalidRegionMarkers)?;
    let body = &existing[body_start..];
    let human_tail = human_region_tail(body)?;

    let mut sorted: Vec<&EntityFact> = facts.iter().collect();
    sorted.sort_by_key(|fact| fact.id.as_str());

    let mut generated = String::new();
    for fact in sorted {
        generated.push_str("- `");
        generated.push_str(&fact.id);
        generated.push_str("`: ");
        generated.push_str(&neutralize_inline_markdown(&fact.sentence));
        generated.push('\n');
    }

    let mut out = String::with_capacity(existing.len() + generated.len());
    out.push_str(&existing[..body_start]);
    out.push_str(GENERATED_START);
    out.push('\n');
    out.push_str(&generated);
    out.push_str(GENERATED_END);
    out.push('\n');
    out.push_str(human_tail);
    Ok(out)
}

fn note_body_start(note: &str) -> Option<usize> {
    if !note.starts_with("---") {
        return Some(0);
    }
    let after_open = note.get(3..)?;
    let open_len = if after_open.starts_with('\n') {
        4
    } else if after_open.starts_with("\r\n") {
        5
    } else {
        return None;
    };
    let rest = note.get(open_len..)?;
    let close = find_line_marker(rest, "---")?;
    Some(open_len + close.end)
}

fn human_region_tail(body: &str) -> Result<&str, RenderEntityError> {
    let generated_starts = find_line_markers(body, GENERATED_START);
    let generated_ends = find_line_markers(body, GENERATED_END);
    let human_starts = find_line_markers(body, HUMAN_START);
    let human_ends = find_line_markers(body, HUMAN_END);
    if generated_starts.len() != 1
        || generated_ends.len() != 1
        || human_starts.len() != 1
        || human_ends.len() != 1
    {
        return Err(RenderEntityError::InvalidRegionMarkers);
    }
    let generated_start = &generated_starts[0];
    let generated_end = &generated_ends[0];
    let human_start = &human_starts[0];
    let human_end = &human_ends[0];
    if !(generated_start.start < generated_end.start
        && generated_end.start < human_start.start
        && human_start.start < human_end.start)
    {
        return Err(RenderEntityError::InvalidRegionMarkers);
    }
    body.get(human_start.start..human_end.end)
        .ok_or(RenderEntityError::InvalidRegionMarkers)
}

struct MarkerSpan {
    start: usize,
    end: usize,
}

fn find_line_marker(haystack: &str, marker: &str) -> Option<MarkerSpan> {
    find_line_markers(haystack, marker).into_iter().next()
}

fn find_line_markers(haystack: &str, marker: &str) -> Vec<MarkerSpan> {
    let mut markers = Vec::new();
    let mut offset = 0;
    for line in haystack.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == marker {
            markers.push(MarkerSpan {
                start: offset,
                end: offset + line.len(),
            });
        }
        offset += line.len();
    }
    markers
}
