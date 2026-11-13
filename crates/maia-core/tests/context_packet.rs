//! Budgeted context packet for the live Super Agent prompt (Honcho slice 3).

use maia_core::task_loop::estimate_tokens;
use maia_core::thread_cache::{
    CONTEXT_PACKET_BUDGET, CONTEXT_PACKET_CARD_CAP, CONTEXT_PACKET_CONCLUSIONS_CAP, ContextPacket,
    ContextPacketInput, PacketRole, PacketTurn, pack_context_packet,
};

fn tokens(text: &str) -> u32 {
    estimate_tokens(text.chars().count())
}

fn turn(role: PacketRole, text: &str) -> PacketTurn {
    PacketTurn {
        role,
        text: text.to_owned(),
    }
}

fn long_line(label: &str, token_target: u32) -> String {
    // Four characters per token; build slightly over the target so a cap must truncate.
    let chars = (token_target as usize).saturating_mul(4).saturating_add(16);
    format!("{label}:{}", "x".repeat(chars.saturating_sub(label.len() + 1)))
}

#[test]
fn packed_suffix_stays_within_budget_and_keeps_the_card() {
    let card = long_line("card", 180);
    let conclusions = long_line("claim", 400);
    let summary = long_line("summary", 600);
    let recent = vec![
        turn(PacketRole::User, &long_line("old-user", 400)),
        turn(PacketRole::Assistant, &long_line("old-asst", 400)),
        turn(PacketRole::User, &long_line("new-user", 200)),
        turn(PacketRole::Assistant, &long_line("new-asst", 200)),
    ];
    let packed = pack_context_packet(
        ContextPacketInput {
            card: &card,
            conclusions: &conclusions,
            summary: &summary,
            recent: &recent,
            budget: CONTEXT_PACKET_BUDGET,
        },
        tokens,
    );
    assert!(
        packed.total_tokens <= CONTEXT_PACKET_BUDGET,
        "over budget: {} > {}",
        packed.total_tokens,
        CONTEXT_PACKET_BUDGET
    );
    assert!(
        !packed.card.is_empty(),
        "card must survive packing: {packed:?}"
    );
    assert!(
        tokens(&packed.card) <= CONTEXT_PACKET_CARD_CAP,
        "card over cap: {}",
        tokens(&packed.card)
    );
    assert!(
        tokens(&packed.conclusions) <= CONTEXT_PACKET_CONCLUSIONS_CAP,
        "conclusions over cap: {}",
        tokens(&packed.conclusions)
    );
    assert!(
        packed
            .recent
            .iter()
            .any(|item| item.text.starts_with("new-user")),
        "newer turns are preferred: {:?}",
        packed.recent
    );
    assert!(
        !packed
            .recent
            .iter()
            .any(|item| item.text.starts_with("old-user")),
        "over-budget older turns drop from the front: {:?}",
        packed.recent
    );
}

#[test]
fn empty_summary_still_yields_a_valid_packet() {
    let packed = pack_context_packet(
        ContextPacketInput {
            card: "Name: Garrett",
            conclusions: "Garrett prefers oat milk.",
            summary: "",
            recent: &[
                turn(PacketRole::User, "hello"),
                turn(PacketRole::Assistant, "hi"),
            ],
            budget: CONTEXT_PACKET_BUDGET,
        },
        tokens,
    );
    assert!(packed.summary.is_empty());
    assert_eq!(packed.card, "Name: Garrett");
    assert_eq!(packed.conclusions, "Garrett prefers oat milk.");
    assert_eq!(packed.recent.len(), 2);
    assert!(packed.total_tokens <= CONTEXT_PACKET_BUDGET);
    assert!(!packed.memory_block().is_empty());
}

#[test]
fn same_inputs_are_byte_stable() {
    let recent = vec![
        turn(PacketRole::User, "alpha"),
        turn(PacketRole::Assistant, "beta"),
        turn(PacketRole::User, "gamma"),
    ];
    let input = ContextPacketInput {
        card: "card line",
        conclusions: "conclusion line",
        summary: "summary line",
        recent: &recent,
        budget: CONTEXT_PACKET_BUDGET,
    };
    let first = pack_context_packet(input.clone(), tokens);
    let second = pack_context_packet(input, tokens);
    assert_eq!(first, second);
    assert_eq!(first.memory_block(), second.memory_block());
}

#[test]
fn card_cap_and_conclusion_cap_match_section_three() {
    assert_eq!(CONTEXT_PACKET_BUDGET, 2_000);
    assert_eq!(CONTEXT_PACKET_CARD_CAP, 200);
    assert_eq!(CONTEXT_PACKET_CONCLUSIONS_CAP, 500);
    let _unused: fn(ContextPacketInput<'_>, fn(&str) -> u32) -> ContextPacket =
        pack_context_packet;
}
