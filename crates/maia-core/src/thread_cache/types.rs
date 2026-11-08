//! Replay values and compiled prefix metadata.

use crate::agents::{AgentId, ThreadId};
use crate::brain::{EpisodeId, MemoryRef, SlotId};
use crate::credit::{PrefixHash, TextSpan};
use crate::security::Taint;

/// Caller-supplied byte digest.
///
/// The cryptographic algorithm is not chosen in this crate. Callers pass the
/// function that turns canonical bytes into a [`PrefixHash`].
#[derive(Clone, Copy)]
pub struct ByteDigest {
    digest: fn(&[u8]) -> PrefixHash,
}

impl ByteDigest {
    /// Captures an explicit digest function.
    #[must_use]
    pub fn from_fn(digest: fn(&[u8]) -> PrefixHash) -> Self {
        Self { digest }
    }

    /// Digests `bytes` with the captured function.
    #[must_use]
    pub fn apply(self, bytes: &[u8]) -> PrefixHash {
        (self.digest)(bytes)
    }
}

impl std::fmt::Debug for ByteDigest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ByteDigest")
    }
}

/// Closed advisory label inside an untrusted envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvenanceLabel {
    /// Web content.
    Web,
    /// Console output.
    Console,
    /// Vault bytes.
    Vault,
    /// Another agent.
    Agent,
    /// Several untrusted sources.
    Join,
}

impl ProvenanceLabel {
    /// Grammar token for this label.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Console => "console",
            Self::Vault => "vault",
            Self::Agent => "agent",
            Self::Join => "join",
        }
    }
}

/// Durable role for a transcript turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnRole {
    /// Human or inter-thread user message.
    User,
    /// Agent utterance.
    Assistant,
}

impl TurnRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

/// Wire role for a provider message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRole {
    /// System content.
    System,
    /// User content.
    User,
    /// Assistant content.
    Assistant,
    /// Tool result content.
    Tool,
}

/// Kind of a compiled durable slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    /// Canonical tool JSON section.
    Tools,
    /// Frozen `agents.md` excerpt.
    Agents,
    /// One participant persona.
    Persona,
    /// Compacted memory block.
    CompactedMemory,
    /// Transcript turn.
    TranscriptTurn,
    /// Installed memory note.
    MemoryNote,
    /// Current user message.
    CurrentUser,
}

/// One fixed prefix section supplied by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionInput {
    /// Stable slot id. It must appear in the rendered canonical text.
    pub id: SlotId,
    /// Exact section body. Tool JSON is already canonical.
    pub body: String,
    /// Provenance of the body.
    pub taint: Taint,
    /// Required when [`Taint::Untrusted`].
    pub label: Option<ProvenanceLabel>,
    /// Envelope version frozen at insertion. Only `1` is canonical.
    pub version: u32,
}

/// Persona text for one participant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonaInput {
    /// Slot id, body, and provenance.
    pub section: SectionInput,
    /// Participant this persona belongs to.
    pub agent_id: AgentId,
}

/// Historical transcript turn. Opaque provider state does not belong here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptTurn {
    /// Stable slot id.
    pub id: SlotId,
    /// Sort key. Compilation orders turns by this value, not by vec position.
    pub log_ordinal: u64,
    /// Turn id rendered inside the durable label.
    pub turn_id: String,
    /// Durable role.
    pub role: TurnRole,
    /// Exact body bytes.
    pub body: String,
    /// Provenance of the body.
    pub taint: Taint,
    /// Required when [`Taint::Untrusted`].
    pub label: Option<ProvenanceLabel>,
    /// Envelope version frozen at insertion.
    pub version: u32,
}

/// Installed memory note at a fixed cursor.
#[derive(Debug, Clone, PartialEq)]
pub struct InstalledNote {
    /// Stable slot id.
    pub id: SlotId,
    /// Item or episode id rendered as `` `mem:{item_id}` ``.
    pub item_id: String,
    /// Note text. A second load is a new note; it does not replace an earlier one.
    pub text: String,
    /// Transcript turn slot that this note follows.
    pub cursor_after: SlotId,
    /// Claim or fact identity, when the note is one.
    pub memory: Option<MemoryRef>,
    /// Episode identity for a second load.
    pub episode: Option<EpisodeId>,
    /// Provenance of the text.
    pub taint: Taint,
    /// Required when [`Taint::Untrusted`].
    pub label: Option<ProvenanceLabel>,
    /// Envelope version frozen at insertion.
    pub version: u32,
    /// Slot heat supplied by the ledger fold. Compilation does not change it.
    pub heat: f64,
}

/// Current user or inter-thread message already appended to the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentUser {
    /// Stable slot id.
    pub id: SlotId,
    /// Turn id rendered inside the durable label.
    pub turn_id: String,
    /// Exact body. Wire content stays this body for trusted turns.
    pub body: String,
    /// Provenance of the body.
    pub taint: Taint,
    /// Required when [`Taint::Untrusted`].
    pub label: Option<ProvenanceLabel>,
    /// Envelope version frozen at insertion.
    pub version: u32,
}

/// Compacted memory block.
///
/// [`MemoryBody::Frozen`] is inserted verbatim so compaction does not wrap
/// survivors in a second envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryBody {
    /// Body still rendered with the envelope rules.
    Editable(SectionInput),
    /// Canonical grouping already produced by compaction.
    Frozen(FrozenMemory),
}

/// Memory block whose bytes and installed identities are already fixed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenMemory {
    /// Section id and canonical body.
    pub section: SectionInput,
    /// Claim and fact identities still installed inside the block.
    pub installed: Vec<MemoryRef>,
}

/// Durable thread state replayed by the caller.
///
/// This is a value, not a store handle. The same value compiles to the same bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayedThread {
    /// Durable record version. Only `1` compiles.
    pub version: u32,
    /// Thread that owns this cache.
    pub thread_id: ThreadId,
    /// Participants whose personas must be present.
    pub participants: std::collections::BTreeSet<AgentId>,
    /// Canonical tool JSON section.
    pub tools: SectionInput,
    /// Frozen constitution excerpt.
    pub agents: SectionInput,
    /// Personas in any order. Compilation sorts by [`AgentId`].
    pub personas: Vec<PersonaInput>,
    /// Compacted memory block.
    pub memory: MemoryBody,
    /// Historical turns. Vec order is not slot order.
    pub turns: Vec<TranscriptTurn>,
    /// Installed notes. Vec order is not slot order.
    pub notes: Vec<InstalledNote>,
    /// Current message rendered under `## user`.
    pub current_user: CurrentUser,
    /// Opaque provider bytes. Compilation reads the length and never copies them.
    pub opaque_excluded: Vec<u8>,
}

/// One slot in compiled prefix order.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledSlot {
    /// Stable slot id.
    pub id: SlotId,
    /// Slot kind.
    pub kind: SlotKind,
    /// Dense ordinal in prefix order, starting at 0.
    pub ordinal: u32,
    /// Canonical slot text, including its stable id.
    pub canonical_text: String,
    /// Byte range of `canonical_text` inside the prefix.
    pub byte_range: TextSpan,
    /// Wire role when this slot becomes its own message.
    pub wire_role: Option<ChatRole>,
    /// Wire body. Turn labels stay in `canonical_text` only.
    pub wire_content: Option<String>,
    /// Provenance copied from the input. Compaction stores the survivor join here.
    pub taint: Taint,
    /// Advisory provenance label. Absent on trusted slots.
    pub label: Option<ProvenanceLabel>,
    /// Linked claim or fact.
    pub memory: Option<MemoryRef>,
    /// Linked episode.
    pub episode: Option<EpisodeId>,
    /// Heat copied from the input. Residence does not add to it.
    pub heat: f64,
}

/// Canonical durable prefix.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledPrefix {
    /// Owning thread.
    pub thread_id: ThreadId,
    /// Full durable prefix, UTF-8, LF only.
    pub bytes: String,
    /// Digest of [`Self::bytes`] using the caller-supplied function.
    pub hash: PrefixHash,
    /// Exact tool JSON body supplied by the caller.
    pub tools_json: String,
    /// Agents, personas, and memory canonical text, in that order.
    pub system_sections: String,
    /// Slots in prefix order.
    pub slots: Vec<CompiledSlot>,
    /// Memories installed as notes or carried on a frozen block.
    pub installed_memories: Vec<MemoryRef>,
    /// Episodes installed as notes.
    pub installed_episodes: Vec<EpisodeId>,
}

/// Why compilation refused a log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompileError {
    /// Record version is not `1`.
    UnknownVersion,
    /// A durable string contains CR.
    CarriageReturn,
    /// Two slots share an id.
    DuplicateSlotId,
    /// Two turns share a log ordinal.
    DuplicateOrdinal,
    /// Persona agent ids are not the participant set.
    ParticipantMismatch,
    /// Rendered canonical text does not contain the slot id.
    SlotIdAbsent,
    /// A note cursor does not name a transcript turn.
    InvalidCursor,
    /// An untrusted slot has no provenance label.
    MissingProvenanceLabel,
    /// Envelope version is not `1`.
    UnsupportedEnvelopeVersion,
    /// Ordinal does not fit in `u32`.
    OrdinalOverflow,
    /// The empty recall block does not fit the token budget.
    RecallBudgetTooSmall,
    /// A caller token estimate overflowed `u32`.
    TokenOverflow,
    /// Scratch canonicalization failed. No request is produced.
    ScratchCanonicalizationFailed,
    /// Paths were proposed without caller-supplied canonical bytes.
    ScratchBytesMissing,
    /// Canonical scratch bytes were supplied without paths.
    ScratchInconsistent,
    /// Scratch bytes contain CR.
    ScratchCarriageReturn,
    /// In-turn tool state used a user or system role.
    InvalidToolRole,
    /// A transcript slot was missing its wire body.
    MissingWireBody,
    /// Tool schemas must stay trusted canonical JSON. An untrusted tools section
    /// would hash an envelope while `tools_json` stayed raw JSON.
    UntrustedTools,
}

/// Borrows the section stored in either memory form.
pub(crate) fn section_of(memory: &MemoryBody) -> &SectionInput {
    match memory {
        MemoryBody::Editable(section) | MemoryBody::Frozen(FrozenMemory { section, .. }) => section,
    }
}

/// Maps a durable turn role onto the wire role.
pub(crate) fn turn_role_wire(role: TurnRole) -> ChatRole {
    match role {
        TurnRole::User => ChatRole::User,
        TurnRole::Assistant => ChatRole::Assistant,
    }
}

/// Durable label token for a turn role.
pub(crate) fn role_label(role: TurnRole) -> &'static str {
    role.as_str()
}
