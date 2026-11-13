//! Non-durable, budgeted context packet for each Super Agent turn.
//!
//! Card, conclusions, session summary, and recent messages share one token
//! budget. The router contract and tool catalog sit outside this packet.

/// Total token budget for the packet (four characters per token in production).
pub const CONTEXT_PACKET_BUDGET: u32 = 2_000;
/// Soft cap for the peer card block inside the packet.
pub const CONTEXT_PACKET_CARD_CAP: u32 = 200;
/// Soft cap for ranked conclusions inside the packet.
pub const CONTEXT_PACKET_CONCLUSIONS_CAP: u32 = 500;

/// Role of one recent transcript turn in the packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketRole {
    /// Owner or user utterance.
    User,
    /// Assistant utterance.
    Assistant,
}

/// One whole recent turn. Packing never splits a turn mid-text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketTurn {
    /// Speaker role.
    pub role: PacketRole,
    /// Turn text already stripped of thinking/route wrappers.
    pub text: String,
}

/// Explicit packing inputs. The token estimator is a separate function argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextPacketInput<'a> {
    /// Owner peer card lines (may be empty until the card slice lands).
    pub card: &'a str,
    /// Ranked conclusion block (may be empty).
    pub conclusions: &'a str,
    /// Rolling session summary (may be empty until the summary slice lands).
    pub summary: &'a str,
    /// Recent transcript turns, oldest first and newest last.
    pub recent: &'a [PacketTurn],
    /// Total token budget for the packed suffix.
    pub budget: u32,
}

/// Budgeted packet parts ready for the orchestrator to place on the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextPacket {
    /// Card text that fit the card cap and overall budget.
    pub card: String,
    /// Conclusions text that fit the conclusions cap and overall budget.
    pub conclusions: String,
    /// Summary text that fit its share of the narrative remainder.
    pub summary: String,
    /// Recent turns kept newest-last after dropping oldest over budget.
    pub recent: Vec<PacketTurn>,
    /// Sum of estimated tokens for card, conclusions, summary, and recent turns.
    pub total_tokens: u32,
}

impl ContextPacket {
    /// Renders the non-transcript memory block (card, conclusions, summary).
    #[must_use]
    pub fn memory_block(&self) -> String {
        let mut parts = Vec::new();
        if !self.card.is_empty() {
            parts.push(format!("## card\n{}", self.card.trim_end()));
        }
        if !self.conclusions.is_empty() {
            parts.push(self.conclusions.trim_end().to_owned());
        }
        if !self.summary.is_empty() {
            parts.push(format!("## summary\n{}", self.summary.trim_end()));
        }
        parts.join("\n\n")
    }
}

/// Packs card, conclusions, summary, and recent turns into one budgeted packet.
///
/// Over-budget recent turns are dropped from the front. The card is kept when
/// any budget remains. Empty summary still yields a valid packet.
#[must_use]
pub fn pack_context_packet(
    input: ContextPacketInput<'_>,
    estimate_tokens: fn(&str) -> u32,
) -> ContextPacket {
    let card = take_fitting(input.card, CONTEXT_PACKET_CARD_CAP, input.budget, estimate_tokens);
    let mut used = estimate_tokens(&card);
    let conclusions_budget = input
        .budget
        .saturating_sub(used)
        .min(CONTEXT_PACKET_CONCLUSIONS_CAP);
    let conclusions = take_fitting(
        input.conclusions,
        conclusions_budget,
        conclusions_budget,
        estimate_tokens,
    );
    used = used.saturating_add(estimate_tokens(&conclusions));

    let narrative = input.budget.saturating_sub(used);
    let summary_cap = narrative.saturating_mul(2) / 5; // ~40% of narrative remainder
    let summary = take_fitting(input.summary, summary_cap, narrative, estimate_tokens);
    used = used.saturating_add(estimate_tokens(&summary));

    let recent_budget = input.budget.saturating_sub(used);
    let recent = take_recent(input.recent, recent_budget, estimate_tokens);
    used = used.saturating_add(recent_cost(&recent, estimate_tokens));

    ContextPacket {
        card,
        conclusions,
        summary,
        recent,
        total_tokens: used,
    }
}

fn take_fitting(
    text: &str,
    soft_cap: u32,
    hard_cap: u32,
    estimate_tokens: fn(&str) -> u32,
) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() || soft_cap == 0 || hard_cap == 0 {
        return String::new();
    }
    let cap = soft_cap.min(hard_cap);
    if estimate_tokens(trimmed) <= cap {
        return trimmed.to_owned();
    }
    // Prefer whole lines; fall back to a character prefix that fits the cap.
    let mut kept = String::new();
    for line in trimmed.lines() {
        let candidate = if kept.is_empty() {
            line.to_owned()
        } else {
            format!("{kept}\n{line}")
        };
        if estimate_tokens(&candidate) > cap {
            break;
        }
        kept = candidate;
    }
    if !kept.is_empty() {
        return kept;
    }
    let mut prefix = String::new();
    for ch in trimmed.chars() {
        let mut next = prefix.clone();
        next.push(ch);
        if estimate_tokens(&next) > cap {
            break;
        }
        prefix = next;
    }
    prefix
}

fn take_recent(
    recent: &[PacketTurn],
    budget: u32,
    estimate_tokens: fn(&str) -> u32,
) -> Vec<PacketTurn> {
    if budget == 0 || recent.is_empty() {
        return Vec::new();
    }
    let mut start = recent.len();
    let mut cost = 0_u32;
    while start > 0 {
        let turn = &recent[start - 1];
        let turn_cost = estimate_tokens(&turn.text);
        let Some(next) = cost.checked_add(turn_cost) else {
            break;
        };
        if next > budget {
            break;
        }
        cost = next;
        start -= 1;
    }
    recent[start..].to_vec()
}

fn recent_cost(recent: &[PacketTurn], estimate_tokens: fn(&str) -> u32) -> u32 {
    recent
        .iter()
        .fold(0_u32, |acc, turn| acc.saturating_add(estimate_tokens(&turn.text)))
}
