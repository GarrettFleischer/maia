//! Cache residence is not a use presentation.

use std::collections::BTreeSet;

use maia_core::agents::{AgentId, ThreadId};
use maia_core::audit::RequestId;
use maia_core::brain::{FactId, MemoryRef, SlotId};
use maia_core::credit::{
    AttributionScope, PrefixHash, ReasoningAvailability, ScopedSlot, attribute_uses,
};
use maia_core::security::Taint;
use maia_core::thread_cache::{
    ByteDigest, CurrentUser, InstalledNote, MemoryBody, PersonaInput, ReplayedThread, SectionInput,
    TranscriptTurn, TurnRole, compile_prompt,
};

fn digest_hex(bytes: &[u8]) -> PrefixHash {
    let mut encoded = String::new();
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    PrefixHash::new(encoded)
}

fn section(id: &str, body: &str) -> SectionInput {
    SectionInput {
        id: SlotId::new(id),
        body: body.to_owned(),
        taint: Taint::Trusted,
        label: None,
        version: 1,
    }
}

#[test]
fn compiling_or_retaining_a_slot_writes_no_use_presentation() {
    let mut participants = BTreeSet::new();
    participants.insert(AgentId(1));
    let log = ReplayedThread {
        version: 1,
        thread_id: ThreadId(8),
        participants,
        tools: section("tools", "{}"),
        agents: section("agents", "constitution"),
        personas: vec![PersonaInput {
            section: section("agent:1", "persona"),
            agent_id: AgentId(1),
        }],
        memory: MemoryBody::Editable(section("memory", "")),
        turns: vec![TranscriptTurn {
            id: SlotId::new("assistant:a1"),
            log_ordinal: 0,
            turn_id: "a1".to_owned(),
            role: TurnRole::Assistant,
            body: "ack".to_owned(),
            taint: Taint::Trusted,
            label: None,
            version: 1,
        }],
        notes: vec![InstalledNote {
            id: SlotId::new("mem:fact_resident"),
            item_id: "fact_resident".to_owned(),
            text: "resident fact sentence".to_owned(),
            cursor_after: SlotId::new("assistant:a1"),
            memory: Some(MemoryRef::Fact(FactId::new("fact_resident"))),
            episode: None,
            taint: Taint::Trusted,
            label: None,
            version: 1,
            heat: 4.5,
        }],
        current_user: CurrentUser {
            id: SlotId::new("user:t1"),
            turn_id: "t1".to_owned(),
            body: "hello".to_owned(),
            taint: Taint::Trusted,
            label: None,
            version: 1,
        },
        opaque_excluded: Vec::new(),
    };
    let prefix = compile_prompt(&log, ByteDigest::from_fn(digest_hex)).expect("compile");
    let resident = prefix
        .slots
        .iter()
        .find(|slot| slot.id.as_str() == "mem:fact_resident")
        .expect("resident slot");
    assert_eq!(resident.heat, 4.5);
    let ordinals: Vec<u32> = prefix.slots.iter().map(|slot| slot.ordinal).collect();
    let expected_ordinals: Vec<u32> = (0..ordinals.len()).map(|ordinal| ordinal as u32).collect();
    assert_eq!(ordinals, expected_ordinals);
    let scope = AttributionScope {
        thread_id: prefix.thread_id,
        request_id: RequestId(1),
        compiled_prefix_hash: prefix.hash.clone(),
        slots: prefix
            .slots
            .iter()
            .map(|slot| ScopedSlot {
                id: slot.id.clone(),
                ordinal: slot.ordinal,
                canonical_text: slot.canonical_text.clone(),
                memory: slot.memory.clone(),
            })
            .collect(),
        recall: Vec::new(),
        reasoning: ReasoningAvailability::Available {
            text: String::new(),
        },
        tools: Vec::new(),
        reply: String::new(),
    };
    let ledger = attribute_uses(&scope).expect("attribute residence");
    assert!(ledger.presentations.is_empty());
    assert!(ledger.heat.is_empty());
    assert!(ledger.brain_presentations.is_empty());
}
