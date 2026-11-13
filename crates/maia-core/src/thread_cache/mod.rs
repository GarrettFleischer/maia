//! Durable per-thread prompt cache.
//!
//! Compilation is a pure function of a replayed thread value. Persistence,
//! ranking, and the router stay outside this module.

mod compact;
mod compile;
mod context_packet;
mod recall;
mod scratch;
mod types;
mod wire;

pub use compact::{
    CompactionDecision, CompactionError, CompactionPolicy, CompactionRecord, CompactionSlot,
    CompactionState, CompactionTrigger, DEFAULT_CENTROID_WINDOW, DEFAULT_CONSECUTIVE_TURNS,
    DEFAULT_MIN_INTERVAL_TURNS, DEFAULT_UNUSED_TURN_WINDOW, UnfixableReason, apply_compaction,
    compact, mean_cosine_distance, should_compact,
};
pub use compile::compile_prompt;
pub use context_packet::{
    CONTEXT_PACKET_BUDGET, CONTEXT_PACKET_CARD_CAP, CONTEXT_PACKET_CONCLUSIONS_CAP, ContextPacket,
    ContextPacketInput, PacketRole, PacketTurn, pack_context_packet,
};
pub use recall::{
    CompiledWithRecall, RecallLineage, RecallPackPolicy, append_recall, reuse_recall,
};
pub use scratch::{CompiledRequest, ScratchCanon, ScratchRegion, append_scratch};
pub use types::{
    ByteDigest, ChatRole, CompileError, CompiledPrefix, CompiledSlot, CurrentUser, FrozenMemory,
    InstalledNote, MemoryBody, PersonaInput, ProvenanceLabel, ReplayedThread, SectionInput,
    SlotKind, TranscriptTurn, TurnRole,
};
pub use wire::{ChatMessage, PlacementMode, WirePlan, to_router_messages};
