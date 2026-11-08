//! Stable brain identifiers reused by ranking and credit.

/// Stable lexeme node identity after lexical normalization.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LexemeId(String);

impl LexemeId {
    /// Builds a lexeme id from already-normalized text.
    pub fn new(normalized: impl Into<String>) -> Self {
        Self(normalized.into())
    }

    /// Borrowed normalized text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable provisional-claim identity (`claim_…` in recall).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ClaimId(String);

impl ClaimId {
    /// Builds a claim id from its stable text.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed stable id.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable canonical-fact identity (`fact_…` in recall).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FactId(String);

impl FactId {
    /// Builds a fact id from its stable text.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed stable id.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable episode identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EpisodeId(String);

impl EpisodeId {
    /// Builds an episode id from its stable text.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed stable id.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Durable thread-cache slot identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SlotId(String);

impl SlotId {
    /// Builds a slot id from its stable text.
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// Borrowed stable id.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Claim or fact identity used by quarantine, attribution, and correction.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MemoryRef {
    /// Provisional claim.
    Claim(ClaimId),
    /// Canonical fact.
    Fact(FactId),
}

/// Graph node visited while walking a recall path.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum NodeId {
    /// Lexeme seed.
    Lexeme(LexemeId),
    /// Provisional claim.
    Claim(ClaimId),
    /// Canonical fact.
    Fact(FactId),
    /// Source episode.
    Episode(EpisodeId),
}
