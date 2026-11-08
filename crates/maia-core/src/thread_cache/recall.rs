//! Turn-local recall block. It is not part of the durable prefix.

use std::collections::{BTreeMap, BTreeSet};

use crate::brain::{ClaimId, FactId, RankedPath, RecallItem, RecallTaintMode};
use crate::credit::PrefixHash;
use crate::security::Taint;
use crate::thread_cache::types::{ByteDigest, CompileError, CompiledPrefix};

/// Claim/fact lineage used to keep one sentence per installed line.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RecallLineage {
    /// Claim that was consolidated into a canonical fact.
    pub consolidated_claims: BTreeMap<ClaimId, FactId>,
    /// Source claims of a canonical fact.
    pub fact_sources: BTreeMap<FactId, Vec<ClaimId>>,
}

/// Explicit packing inputs. The token estimator is a separate function argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecallPackPolicy {
    /// Maximum estimate of the recall block, including its header.
    pub token_budget: u32,
    /// Whether untrusted ranked items may be rendered.
    pub taint_mode: RecallTaintMode,
    /// Lineage exclusions supplied by the caller.
    pub lineage: RecallLineage,
}

/// Appends a recall block without changing the durable prefix hash.
pub fn append_recall(
    prefix: &CompiledPrefix,
    ranked: &[RankedPath],
    policy: &RecallPackPolicy,
    estimate_tokens: fn(&str) -> u32,
    digest: ByteDigest,
) -> Result<CompiledWithRecall, CompileError> {
    let claims = installed_claims(prefix);
    let facts = installed_facts(prefix);
    let header = "## recall\n";
    let mut cost = estimate_tokens(header);
    let mut lines = Vec::new();
    let mut items = Vec::new();
    for path in ranked {
        if excluded(path, policy, &claims, &facts) {
            continue;
        }
        let line = format!("`{}`: {}\n", item_label(&path.item), path.sentence);
        let line_cost = estimate_tokens(&line);
        let Some(next) = cost.checked_add(line_cost) else {
            return Err(CompileError::TokenOverflow);
        };
        if next > policy.token_budget {
            break;
        }
        cost = next;
        items.push(path.item.clone());
        lines.push(line);
    }
    let recall_bytes = if lines.is_empty() {
        let empty = format!("{header}\n");
        if estimate_tokens(&empty) > policy.token_budget {
            return Err(CompileError::RecallBudgetTooSmall);
        }
        empty
    } else {
        let mut bytes = String::from(header);
        for line in &lines {
            bytes.push_str(line);
        }
        bytes
    };
    Ok(finish(prefix, recall_bytes, items, digest))
}

/// Reattaches an already rendered recall block for a later tool request in the turn.
#[must_use]
pub fn reuse_recall(
    prefix: &CompiledPrefix,
    recall_bytes: &str,
    recall_items: &[RecallItem],
    digest: ByteDigest,
) -> CompiledWithRecall {
    finish(
        prefix,
        recall_bytes.to_owned(),
        recall_items.to_vec(),
        digest,
    )
}

fn finish(
    prefix: &CompiledPrefix,
    recall_bytes: String,
    recall_items: Vec<RecallItem>,
    digest: ByteDigest,
) -> CompiledWithRecall {
    let recall_hash = digest.apply(recall_bytes.as_bytes());
    CompiledWithRecall {
        prefix: prefix.clone(),
        recall_bytes,
        recall_hash,
        recall_items,
    }
}

fn installed_claims(prefix: &CompiledPrefix) -> BTreeSet<ClaimId> {
    let mut claims = BTreeSet::new();
    for memory in &prefix.installed_memories {
        if let crate::brain::MemoryRef::Claim(claim_id) = memory {
            claims.insert(claim_id.clone());
        }
    }
    claims
}

fn installed_facts(prefix: &CompiledPrefix) -> BTreeSet<FactId> {
    let mut facts = BTreeSet::new();
    for memory in &prefix.installed_memories {
        if let crate::brain::MemoryRef::Fact(fact_id) = memory {
            facts.insert(fact_id.clone());
        }
    }
    facts
}

fn excluded(
    path: &RankedPath,
    policy: &RecallPackPolicy,
    claims: &BTreeSet<ClaimId>,
    facts: &BTreeSet<FactId>,
) -> bool {
    if policy.taint_mode == RecallTaintMode::TrustedOnly && path.taint == Taint::Untrusted {
        return true;
    }
    match &path.item {
        RecallItem::Claim { claim_id } => {
            if claims.contains(claim_id) {
                return true;
            }
            if let Some(fact_id) = policy.lineage.consolidated_claims.get(claim_id) {
                return facts.contains(fact_id);
            }
            false
        }
        RecallItem::Fact { fact_id } => {
            if facts.contains(fact_id) {
                return true;
            }
            policy
                .lineage
                .fact_sources
                .get(fact_id)
                .is_some_and(|sources| sources.iter().any(|claim| claims.contains(claim)))
        }
    }
}

fn item_label(item: &RecallItem) -> &str {
    match item {
        RecallItem::Claim { claim_id } => claim_id.as_str(),
        RecallItem::Fact { fact_id } => fact_id.as_str(),
    }
}

/// Prefix hash carried beside a recall block. Defined with the recall types so
/// scratch and wire can share one request value.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledWithRecall {
    /// Unchanged durable prefix.
    pub prefix: CompiledPrefix,
    /// Canonical recall block.
    pub recall_bytes: String,
    /// Digest of [`Self::recall_bytes`] only.
    pub recall_hash: PrefixHash,
    /// Items that were packed, in ranked order.
    pub recall_items: Vec<RecallItem>,
}
