//! Deterministic durable prefix compilation.

use std::collections::{BTreeMap, BTreeSet};

use crate::brain::{EpisodeId, MemoryRef, SlotId};
use crate::credit::TextSpan;
use crate::security::Taint;
use crate::thread_cache::types::{
    ByteDigest, ChatRole, CompileError, CompiledPrefix, CompiledSlot, CurrentUser, InstalledNote,
    MemoryBody, PersonaInput, ProvenanceLabel, ReplayedThread, SectionInput, SlotKind,
    TranscriptTurn, role_label, section_of, turn_role_wire,
};

/// Compiles one replayed thread into canonical durable prefix bytes.
///
/// `digest` is the only hash. This function does not read a clock, store, or
/// scratch suffix.
pub fn compile_prompt(
    log: &ReplayedThread,
    digest: ByteDigest,
) -> Result<CompiledPrefix, CompileError> {
    validate(log)?;
    let rendered = render(log)?;
    let hash = digest.apply(rendered.bytes.as_bytes());
    Ok(CompiledPrefix {
        thread_id: log.thread_id,
        bytes: rendered.bytes,
        hash,
        tools_json: rendered.tools_json,
        system_sections: rendered.system_sections,
        slots: rendered.slots,
        installed_memories: rendered.installed_memories,
        installed_episodes: rendered.installed_episodes,
    })
}

fn validate(log: &ReplayedThread) -> Result<(), CompileError> {
    if log.version != 1 {
        return Err(CompileError::UnknownVersion);
    }
    if log.tools.taint != Taint::Trusted {
        return Err(CompileError::UntrustedTools);
    }
    reject_carriage_returns(log)?;
    reject_duplicate_ids(log)?;
    reject_duplicate_ordinals(log)?;
    reject_participant_mismatch(log)?;
    reject_bad_provenance(&log.tools)?;
    reject_bad_provenance(&log.agents)?;
    for persona in &log.personas {
        reject_bad_provenance(&persona.section)?;
    }
    reject_bad_provenance(section_of(&log.memory))?;
    for turn in &log.turns {
        reject_turn_provenance(turn)?;
    }
    for note in &log.notes {
        reject_note_provenance(note)?;
    }
    reject_user_provenance(&log.current_user)?;
    let _opaque_is_not_rendered = log.opaque_excluded.len();
    Ok(())
}

fn reject_carriage_returns(log: &ReplayedThread) -> Result<(), CompileError> {
    reject_cr(&log.tools.body)?;
    reject_cr(log.tools.id.as_str())?;
    reject_cr(&log.agents.body)?;
    reject_cr(log.agents.id.as_str())?;
    for persona in &log.personas {
        reject_cr(&persona.section.body)?;
        reject_cr(persona.section.id.as_str())?;
    }
    let memory = section_of(&log.memory);
    reject_cr(&memory.body)?;
    reject_cr(memory.id.as_str())?;
    for turn in &log.turns {
        reject_cr(&turn.body)?;
        reject_cr(turn.id.as_str())?;
        reject_cr(&turn.turn_id)?;
    }
    for note in &log.notes {
        reject_cr(&note.text)?;
        reject_cr(note.id.as_str())?;
        reject_cr(&note.item_id)?;
    }
    reject_cr(&log.current_user.body)?;
    reject_cr(log.current_user.id.as_str())?;
    reject_cr(&log.current_user.turn_id)?;
    Ok(())
}

fn reject_cr(text: &str) -> Result<(), CompileError> {
    if text.contains('\r') {
        Err(CompileError::CarriageReturn)
    } else {
        Ok(())
    }
}

fn reject_duplicate_ids(log: &ReplayedThread) -> Result<(), CompileError> {
    let mut ids = BTreeSet::new();
    insert_id(&mut ids, &log.tools.id)?;
    insert_id(&mut ids, &log.agents.id)?;
    for persona in &log.personas {
        insert_id(&mut ids, &persona.section.id)?;
    }
    insert_id(&mut ids, &section_of(&log.memory).id)?;
    for turn in &log.turns {
        insert_id(&mut ids, &turn.id)?;
    }
    for note in &log.notes {
        insert_id(&mut ids, &note.id)?;
    }
    insert_id(&mut ids, &log.current_user.id)?;
    Ok(())
}

fn insert_id(ids: &mut BTreeSet<SlotId>, id: &SlotId) -> Result<(), CompileError> {
    if ids.insert(id.clone()) {
        Ok(())
    } else {
        Err(CompileError::DuplicateSlotId)
    }
}

fn reject_duplicate_ordinals(log: &ReplayedThread) -> Result<(), CompileError> {
    let mut ordinals = BTreeSet::new();
    for turn in &log.turns {
        if !ordinals.insert(turn.log_ordinal) {
            return Err(CompileError::DuplicateOrdinal);
        }
    }
    Ok(())
}

fn reject_participant_mismatch(log: &ReplayedThread) -> Result<(), CompileError> {
    let mut agents = BTreeSet::new();
    for persona in &log.personas {
        if !agents.insert(persona.agent_id) {
            return Err(CompileError::ParticipantMismatch);
        }
    }
    if agents == log.participants {
        Ok(())
    } else {
        Err(CompileError::ParticipantMismatch)
    }
}

fn reject_bad_provenance(section: &SectionInput) -> Result<(), CompileError> {
    reject_version_and_label(section.version, section.taint, section.label)
}

fn reject_turn_provenance(turn: &TranscriptTurn) -> Result<(), CompileError> {
    reject_version_and_label(turn.version, turn.taint, turn.label)
}

fn reject_note_provenance(note: &InstalledNote) -> Result<(), CompileError> {
    reject_version_and_label(note.version, note.taint, note.label)
}

fn reject_user_provenance(user: &CurrentUser) -> Result<(), CompileError> {
    reject_version_and_label(user.version, user.taint, user.label)
}

fn reject_version_and_label(
    version: u32,
    taint: Taint,
    label: Option<ProvenanceLabel>,
) -> Result<(), CompileError> {
    if version != 1 {
        return Err(CompileError::UnsupportedEnvelopeVersion);
    }
    if taint == Taint::Untrusted && label.is_none() {
        return Err(CompileError::MissingProvenanceLabel);
    }
    Ok(())
}

struct Rendered {
    bytes: String,
    slots: Vec<CompiledSlot>,
    tools_json: String,
    system_sections: String,
    installed_memories: Vec<MemoryRef>,
    installed_episodes: Vec<EpisodeId>,
}

fn render(log: &ReplayedThread) -> Result<Rendered, CompileError> {
    let mut bytes = String::new();
    let mut slots = Vec::new();
    let mut system_sections = String::new();
    let mut installed_memories = Vec::new();
    let mut installed_episodes = Vec::new();
    if let MemoryBody::Frozen(frozen) = &log.memory {
        installed_memories.extend(frozen.installed.iter().cloned());
    }

    let tools_payload = canonical_payload(&log.tools)?;
    let tools_slot = plain_slot(
        log.tools.id.clone(),
        SlotKind::Tools,
        headed("## tools\n", &tools_payload),
        log.tools.taint,
        log.tools.label,
    )?;
    push_slot(&mut bytes, &mut slots, tools_slot)?;

    let agents_payload = canonical_payload(&log.agents)?;
    let agents_text = headed("## agents\n", &agents_payload);
    system_sections.push_str(&agents_text);
    let agents_slot = plain_slot(
        log.agents.id.clone(),
        SlotKind::Agents,
        agents_text,
        log.agents.taint,
        log.agents.label,
    )?;
    push_slot(&mut bytes, &mut slots, agents_slot)?;

    bytes.push_str("## personas\n");
    system_sections.push_str("## personas\n");
    let mut personas = log.personas.clone();
    personas.sort_by_key(|persona| persona.agent_id);
    for persona in &personas {
        let text = persona_text(persona)?;
        system_sections.push_str(&text);
        let slot = plain_slot(
            persona.section.id.clone(),
            SlotKind::Persona,
            text,
            persona.section.taint,
            persona.section.label,
        )?;
        push_slot(&mut bytes, &mut slots, slot)?;
    }

    let memory_text = memory_text(&log.memory)?;
    system_sections.push_str(&memory_text);
    let memory_section = section_of(&log.memory);
    let memory_slot = plain_slot(
        memory_section.id.clone(),
        SlotKind::CompactedMemory,
        memory_text,
        memory_section.taint,
        memory_section.label,
    )?;
    push_slot(&mut bytes, &mut slots, memory_slot)?;

    bytes.push_str("## transcript\n");
    render_transcript(
        log,
        &mut bytes,
        &mut slots,
        &mut installed_memories,
        &mut installed_episodes,
    )?;

    let user_payload = user_payload(&log.current_user)?;
    let user_wire = wire_body(
        log.current_user.taint,
        log.current_user.label,
        &log.current_user.body,
        log.current_user.id.as_str(),
    )?;
    let user_text = headed(
        "## user\n",
        &format!(
            "`{}:{}`:\n{user_payload}",
            role_label(crate::thread_cache::types::TurnRole::User),
            log.current_user.turn_id
        ),
    );
    let user_slot = drafted(Draft {
        id: log.current_user.id.clone(),
        kind: SlotKind::CurrentUser,
        canonical_text: user_text,
        wire_role: Some(ChatRole::User),
        wire_content: Some(user_wire),
        taint: log.current_user.taint,
        label: log.current_user.label,
        memory: None,
        episode: None,
        heat: 0.0,
    })?;
    push_slot(&mut bytes, &mut slots, user_slot)?;

    Ok(Rendered {
        bytes,
        slots,
        tools_json: log.tools.body.clone(),
        system_sections,
        installed_memories,
        installed_episodes,
    })
}

fn render_transcript(
    log: &ReplayedThread,
    bytes: &mut String,
    slots: &mut Vec<CompiledSlot>,
    installed_memories: &mut Vec<MemoryRef>,
    installed_episodes: &mut Vec<EpisodeId>,
) -> Result<(), CompileError> {
    let mut notes_by_cursor: BTreeMap<SlotId, Vec<&InstalledNote>> = BTreeMap::new();
    for note in &log.notes {
        notes_by_cursor
            .entry(note.cursor_after.clone())
            .or_default()
            .push(note);
    }
    for grouped in notes_by_cursor.values_mut() {
        grouped.sort_by(|left, right| left.id.cmp(&right.id));
    }
    let turn_ids: BTreeSet<&SlotId> = log.turns.iter().map(|turn| &turn.id).collect();
    for cursor in notes_by_cursor.keys() {
        if !turn_ids.contains(cursor) {
            return Err(CompileError::InvalidCursor);
        }
    }

    let mut turns = log.turns.clone();
    turns.sort_by_key(|turn| turn.log_ordinal);
    for turn in &turns {
        let payload = turn_payload(turn)?;
        let wire = wire_body(turn.taint, turn.label, &turn.body, turn.id.as_str())?;
        let text = format!("`{}:{}`:\n{payload}", role_label(turn.role), turn.turn_id);
        let slot = drafted(Draft {
            id: turn.id.clone(),
            kind: SlotKind::TranscriptTurn,
            canonical_text: text,
            wire_role: Some(turn_role_wire(turn.role)),
            wire_content: Some(wire),
            taint: turn.taint,
            label: turn.label,
            memory: None,
            episode: None,
            heat: 0.0,
        })?;
        push_slot(bytes, slots, slot)?;
        if let Some(notes) = notes_by_cursor.get(&turn.id) {
            for note in notes {
                push_note(bytes, slots, note, installed_memories, installed_episodes)?;
            }
        }
    }
    Ok(())
}

fn push_note(
    bytes: &mut String,
    slots: &mut Vec<CompiledSlot>,
    note: &InstalledNote,
    installed_memories: &mut Vec<MemoryRef>,
    installed_episodes: &mut Vec<EpisodeId>,
) -> Result<(), CompileError> {
    let payload = note_payload(note)?;
    let text = format!("`mem:{}`:\n{payload}", note.item_id);
    if let Some(memory) = &note.memory {
        installed_memories.push(memory.clone());
    }
    if let Some(episode) = &note.episode {
        installed_episodes.push(episode.clone());
    }
    let slot = drafted(Draft {
        id: note.id.clone(),
        kind: SlotKind::MemoryNote,
        canonical_text: text.clone(),
        wire_role: Some(ChatRole::Assistant),
        wire_content: Some(text),
        taint: note.taint,
        label: note.label,
        memory: note.memory.clone(),
        episode: note.episode.clone(),
        heat: note.heat,
    })?;
    push_slot(bytes, slots, slot)
}

fn push_slot(
    bytes: &mut String,
    slots: &mut Vec<CompiledSlot>,
    mut slot: CompiledSlot,
) -> Result<(), CompileError> {
    let start = bytes.len();
    bytes.push_str(&slot.canonical_text);
    slot.byte_range = TextSpan {
        start,
        end: bytes.len(),
    };
    slot.ordinal = u32::try_from(slots.len()).map_err(|_| CompileError::OrdinalOverflow)?;
    slots.push(slot);
    Ok(())
}

struct Draft {
    id: SlotId,
    kind: SlotKind,
    canonical_text: String,
    wire_role: Option<ChatRole>,
    wire_content: Option<String>,
    taint: Taint,
    label: Option<ProvenanceLabel>,
    memory: Option<MemoryRef>,
    episode: Option<EpisodeId>,
    heat: f64,
}

fn plain_slot(
    id: SlotId,
    kind: SlotKind,
    canonical_text: String,
    taint: Taint,
    label: Option<ProvenanceLabel>,
) -> Result<CompiledSlot, CompileError> {
    drafted(Draft {
        id,
        kind,
        canonical_text,
        wire_role: None,
        wire_content: None,
        taint,
        label,
        memory: None,
        episode: None,
        heat: 0.0,
    })
}

fn drafted(draft: Draft) -> Result<CompiledSlot, CompileError> {
    if !draft.canonical_text.contains(draft.id.as_str()) {
        return Err(CompileError::SlotIdAbsent);
    }
    Ok(CompiledSlot {
        id: draft.id,
        kind: draft.kind,
        ordinal: 0,
        canonical_text: draft.canonical_text,
        byte_range: TextSpan { start: 0, end: 0 },
        wire_role: draft.wire_role,
        wire_content: draft.wire_content,
        taint: draft.taint,
        label: draft.label,
        memory: draft.memory,
        episode: draft.episode,
        heat: draft.heat,
    })
}

fn memory_text(memory: &MemoryBody) -> Result<String, CompileError> {
    let payload = match memory {
        MemoryBody::Editable(section) => canonical_payload(section)?,
        MemoryBody::Frozen(frozen) => terminate(&frozen.section.body),
    };
    Ok(headed("## memory\n", &payload))
}

fn persona_text(persona: &PersonaInput) -> Result<String, CompileError> {
    let payload = canonical_payload(&persona.section)?;
    Ok(format!("`agent:{}`:\n{payload}", persona.agent_id.0))
}

fn canonical_payload(section: &SectionInput) -> Result<String, CompileError> {
    wire_body(
        section.taint,
        section.label,
        &section.body,
        section.id.as_str(),
    )
    .map(|body| match section.taint {
        Taint::Trusted => terminate(&section.body),
        Taint::Untrusted => body,
    })
}

fn turn_payload(turn: &TranscriptTurn) -> Result<String, CompileError> {
    match turn.taint {
        Taint::Trusted => Ok(terminate(&turn.body)),
        Taint::Untrusted => wire_body(turn.taint, turn.label, &turn.body, turn.id.as_str()),
    }
}

fn user_payload(user: &CurrentUser) -> Result<String, CompileError> {
    match user.taint {
        Taint::Trusted => Ok(terminate(&user.body)),
        Taint::Untrusted => wire_body(user.taint, user.label, &user.body, user.id.as_str()),
    }
}

fn note_payload(note: &InstalledNote) -> Result<String, CompileError> {
    match note.taint {
        Taint::Trusted => Ok(terminate(&note.text)),
        Taint::Untrusted => wire_body(note.taint, note.label, &note.text, note.id.as_str()),
    }
}

fn wire_body(
    taint: Taint,
    label: Option<ProvenanceLabel>,
    body: &str,
    slot_id: &str,
) -> Result<String, CompileError> {
    match taint {
        Taint::Trusted => Ok(body.to_owned()),
        Taint::Untrusted => {
            let label = label.ok_or(CompileError::MissingProvenanceLabel)?;
            Ok(envelope(slot_id, label.as_str(), body))
        }
    }
}

fn envelope(slot_id: &str, label: &str, body: &str) -> String {
    let escaped = body.replace("<<maia:", "<<maia\\:");
    let mut out = format!("<<maia:untrusted id={slot_id} source={label} v=1>>\n");
    out.push_str(&escaped);
    if !escaped.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format!("<<maia:end id={slot_id}>>\n"));
    out
}

fn terminate(body: &str) -> String {
    if body.ends_with('\n') {
        body.to_owned()
    } else {
        let mut terminated = String::with_capacity(body.len() + 1);
        terminated.push_str(body);
        terminated.push('\n');
        terminated
    }
}

fn headed(header: &str, payload: &str) -> String {
    let mut text = String::with_capacity(header.len() + payload.len());
    text.push_str(header);
    text.push_str(payload);
    text
}
