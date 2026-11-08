//! Turn-local scratch suffix. Canonical bytes are supplied by the caller.

use crate::credit::PrefixHash;
use crate::thread_cache::recall::CompiledWithRecall;
use crate::thread_cache::types::{ByteDigest, CompileError};
use crate::vault::VaultPath;

/// Caller decision for scratch bytes.
///
/// This crate does not choose a scratch grammar. `None` with paths is an error
/// rather than a rendered path list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScratchCanon {
    /// No scratch suffix.
    None,
    /// Canonical scratch text already produced by the caller.
    Bytes(String),
    /// Canonicalization failed. The outbound request must be omitted.
    Failed,
}

/// Non-durable scratch region recorded on one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScratchRegion {
    /// Proposed vault paths, in caller order.
    pub paths: Vec<VaultPath>,
    /// Caller-supplied canonical bytes.
    pub bytes: String,
    /// Digest of [`Self::bytes`] only.
    pub hash: PrefixHash,
    /// Residence flag. [`append_scratch`] always sets this to `false`.
    pub durable: bool,
}

/// Durable prefix plus turn-local recall and optional scratch.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledRequest {
    /// Prefix and recall. Their hashes are not recomputed from scratch.
    pub with_recall: CompiledWithRecall,
    /// Present only when canonical scratch bytes were supplied with paths.
    pub scratch: Option<ScratchRegion>,
}

/// Attaches scratch without mutating the durable log or the prefix hash.
pub fn append_scratch(
    with_recall: &CompiledWithRecall,
    proposed_paths: &[VaultPath],
    canon: &ScratchCanon,
    digest: ByteDigest,
) -> Result<CompiledRequest, CompileError> {
    let scratch = match canon {
        ScratchCanon::Failed => return Err(CompileError::ScratchCanonicalizationFailed),
        ScratchCanon::None if proposed_paths.is_empty() => None,
        ScratchCanon::None => return Err(CompileError::ScratchBytesMissing),
        ScratchCanon::Bytes(_) if proposed_paths.is_empty() => {
            return Err(CompileError::ScratchInconsistent);
        }
        ScratchCanon::Bytes(bytes) => {
            if bytes.contains('\r') {
                return Err(CompileError::ScratchCarriageReturn);
            }
            Some(ScratchRegion {
                paths: proposed_paths.to_vec(),
                hash: digest.apply(bytes.as_bytes()),
                bytes: bytes.clone(),
                durable: false,
            })
        }
    };
    Ok(CompiledRequest {
        with_recall: with_recall.clone(),
        scratch,
    })
}
