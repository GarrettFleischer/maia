//! Promotion and consolidation failures. A failure never carries partial rows.

/// Why a declarative sentence was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SentenceIssue {
    /// Empty or whitespace-only text.
    Empty,
    /// Does not end in exactly one period.
    NotDeclarative,
    /// More than one sentence terminator.
    MultipleSentences,
    /// Markdown list marker.
    ListMarker,
    /// Contains a stable `claim_` / `fact_` / `episode_` / `entity_` / `agent_` id.
    StableId,
    /// Contains frontmatter delimiters or keys.
    Frontmatter,
}

/// Ordered promotion transaction steps. A fault after any step rolls all of them back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromotionPhase {
    /// Provisional claim rows.
    InsertClaims,
    /// Mention edges back to the episode.
    InsertMentions,
    /// Lexeme edges derived from the sentence.
    InsertLexemes,
    /// Episode promoted mark.
    MarkPromoted,
}

/// Promotion parse or apply rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromotionError {
    /// Response is not the locked JSON schema.
    Malformed,
    /// An object contains a key outside the schema.
    UnknownField,
    /// A required key is absent.
    MissingField,
    /// A required key has the wrong JSON type.
    InvalidType,
    /// An id string is empty.
    EmptyId,
    /// The same claim id appears twice in one response.
    DuplicateId,
    /// `episode_id` is not the single episode in scope.
    ForgedEpisodeId,
    /// Sentence shape violates the promotion contract.
    InvalidSentence(SentenceIssue),
    /// A tool-call channel is present.
    ToolChannel,
    /// Claim id is already stored in the supplied brain scope.
    KnownId,
    /// Simulated store failure rolled the description back.
    RolledBack(PromotionPhase),
}

/// Ordered consolidation transaction steps. A fault after any step rolls all of them back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsolidationPhase {
    /// Batch inspection record.
    RecordBatch,
    /// Entity inserts and identity checks.
    ApplyEntities,
    /// Trusted-fact proposals.
    DivertProtected,
    /// Canonical facts and ordinary merges.
    ApplyFactsAndMerges,
    /// Closures and dismissals.
    ApplyClosuresAndDismissals,
    /// Claim status, correction consumption, and holds.
    FinishBrainState,
    /// Pending vault projection record.
    EnqueueProjection,
}

/// Model-call failure supplied by the router skin. No brain rows are described.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFailure {
    /// The router timed out.
    Timeout,
    /// The router transport failed.
    Transport,
}

/// Consolidation parse, validation, or apply rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DreamError {
    /// Response is not the locked JSON schema.
    Malformed,
    /// An object contains a key outside the schema.
    UnknownField,
    /// A required key is absent.
    MissingField,
    /// A required key has the wrong JSON type.
    InvalidType,
    /// An id string is empty.
    EmptyId,
    /// The same id is introduced twice.
    DuplicateId,
    /// An episode or claim id is outside the supplied batch scope.
    ForgedId,
    /// Sentence shape violates the contract.
    InvalidSentence(SentenceIssue),
    /// Description violates the single-line vault contract.
    InvalidDescription,
    /// Slug is not a lowercase path segment.
    InvalidSlug,
    /// Scope is not the world/agent tagged union.
    InvalidScope,
    /// Agent scope names a participant that was not supplied.
    UnknownAgent,
    /// A reference does not resolve to the snapshot or this response.
    UnknownId,
    /// Provenance lists an episode the cited claims do not source.
    InventedProvenance,
    /// Provenance drops a source episode of the cited claims.
    DiscardedProvenance,
    /// `episode_ids` is empty or contains duplicates.
    InvalidProvenance,
    /// An existing entity's identity, slug, scope, description, or links differ.
    IdentityMismatch,
    /// Merge or closure graph is contradictory.
    ContradictoryOperation,
    /// A pre-pass contradiction candidate was not closed or dismissed.
    UnansweredCandidate,
    /// A dismissal does not match a remaining candidate.
    ExtraDismissal,
    /// Snapshot at apply time differs from the validated snapshot.
    StaleSnapshot,
    /// Batch mixes taints or a trusted batch sees an untrusted fact.
    TaintPartition,
    /// A tool-call channel is present.
    ToolChannel,
    /// Output path is `personality.md`.
    PersonalityTarget,
    /// Entity page markers cannot be preserved.
    InvalidRegionMarkers,
    /// On-disk bytes changed after the read used for rendering.
    ConcurrentEdit,
    /// Frontmatter id does not match the brain entity.
    FrontmatterMismatch,
    /// A proposal was already accepted or rejected.
    AlreadyDecided,
    /// Simulated store failure rolled the description back.
    RolledBack(ConsolidationPhase),
    /// Model or router failure before a transaction description.
    Model(ModelFailure),
}
