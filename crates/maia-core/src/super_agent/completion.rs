//! Completion admission for sealed task criteria.

use std::collections::{BTreeMap, BTreeSet};

use super::types::{
    CompletionError, Criterion, CriterionId, CriterionMark, EvidenceId, EvidenceSetId,
};

/// One sealed criterion paired with the single mark that cites it.
struct Covered<'a> {
    id: &'a CriterionId,
    mark: &'a CriterionMark,
}

/// Admits completion when every sealed criterion has one non-pending mark.
///
/// `Satisfied` must cite an id in `evidence`. `Waived` carries a host-supplied
/// `DecisionId` and is not checked against a decision set. `Inapplicable` carries
/// a `CriterionSource` and its bytes are not revalidated. The result joins
/// `criterion:slot` in criterion order with `,`. `%`, `:`, and `,` in string
/// ids are percent-encoded. Satisfied evidence that is exactly `waived` or
/// `inapplicable` also percent-encodes its first byte.
///
/// Several defects return the first of: empty criteria (`Incomplete`),
/// `DuplicateCriterion`, `UnknownMark`, `DuplicateMark`, `MissingMark`, pending
/// (`Incomplete`), then `MissingEvidence`.
pub fn admit_completion(
    criteria: &[Criterion],
    marks: &[CriterionMark],
    evidence: &BTreeSet<EvidenceId>,
) -> Result<EvidenceSetId, CompletionError> {
    if criteria.is_empty() {
        return Err(CompletionError::Incomplete);
    }
    let ids = unique_criterion_ids(criteria)?;
    let covered = cover_marks(criteria, &ids, marks)?;
    evidence_set_id(&covered, evidence)
}

/// Returns the sealed criterion id carried by a mark.
fn mark_criterion(mark: &CriterionMark) -> &CriterionId {
    match mark {
        CriterionMark::Pending { criterion }
        | CriterionMark::Satisfied { criterion, .. }
        | CriterionMark::Waived { criterion, .. }
        | CriterionMark::Inapplicable { criterion, .. } => criterion,
    }
}

/// Collects criterion ids, rejecting a repeated id in list order.
fn unique_criterion_ids(criteria: &[Criterion]) -> Result<BTreeSet<&CriterionId>, CompletionError> {
    let mut ids = BTreeSet::new();
    for criterion in criteria {
        if !ids.insert(&criterion.id) {
            return Err(CompletionError::DuplicateCriterion);
        }
    }
    Ok(ids)
}

/// Pairs each sealed criterion with the one mark that cites it.
fn cover_marks<'a>(
    criteria: &'a [Criterion],
    ids: &BTreeSet<&CriterionId>,
    marks: &'a [CriterionMark],
) -> Result<Vec<Covered<'a>>, CompletionError> {
    let mut indexed: BTreeMap<&CriterionId, &CriterionMark> = BTreeMap::new();
    let mut unknown = false;
    let mut duplicate = false;
    for mark in marks {
        let id = mark_criterion(mark);
        if !ids.contains(id) {
            unknown = true;
            continue;
        }
        if indexed.insert(id, mark).is_some() {
            duplicate = true;
        }
    }
    if unknown {
        return Err(CompletionError::UnknownMark);
    }
    if duplicate {
        return Err(CompletionError::DuplicateMark);
    }

    let mut covered = Vec::with_capacity(criteria.len());
    for criterion in criteria {
        match indexed.get(&criterion.id) {
            Some(mark) => covered.push(Covered {
                id: &criterion.id,
                mark,
            }),
            None => return Err(CompletionError::MissingMark),
        }
    }
    Ok(covered)
}

/// Role of a string id inside one evidence-set slot.
#[derive(Clone, Copy)]
enum IdToken {
    Criterion,
    Evidence,
}

/// Percent-encodes `%`, `:`, and `,` so those bytes cannot act as slot syntax.
///
/// Evidence whose escaped form is exactly `waived` or `inapplicable` then
/// percent-encodes its first byte. That second pass runs only on those two
/// ASCII words, which contain no `%`, so a literal percent cannot alias it.
fn encode_id(raw: &str, token: IdToken) -> String {
    let mut encoded = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '%' => push_percent_byte(&mut encoded, b'%'),
            ':' => push_percent_byte(&mut encoded, b':'),
            ',' => push_percent_byte(&mut encoded, b','),
            other => encoded.push(other),
        }
    }
    if let IdToken::Evidence = token {
        encoded = disambiguate_evidence_sentinel(encoded);
    }
    encoded
}

/// Writes one byte as an uppercase percent escape.
fn push_percent_byte(out: &mut String, byte: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    out.push('%');
    out.push(char::from(HEX[usize::from(byte >> 4)]));
    out.push(char::from(HEX[usize::from(byte & 0x0f)]));
}

/// Encodes the first byte of a satisfied evidence id that matches a sentinel.
fn disambiguate_evidence_sentinel(encoded: String) -> String {
    let lead = match encoded.as_str() {
        "waived" => b'w',
        "inapplicable" => b'i',
        _ => return encoded,
    };
    let mut out = String::with_capacity(encoded.len() + 2);
    push_percent_byte(&mut out, lead);
    out.push_str(&encoded[1..]);
    out
}

/// Builds the evidence-set id, or the disposition error that blocks it.
fn evidence_set_id(
    covered: &[Covered<'_>],
    evidence: &BTreeSet<EvidenceId>,
) -> Result<EvidenceSetId, CompletionError> {
    let mut slots = Vec::with_capacity(covered.len());
    let mut missing_evidence = false;
    for item in covered {
        match item.mark {
            CriterionMark::Pending { .. } => return Err(CompletionError::Incomplete),
            CriterionMark::Satisfied {
                evidence: cited, ..
            } => {
                if !evidence.contains(cited) {
                    missing_evidence = true;
                }
                slots.push(format!(
                    "{}:{}",
                    encode_id(&item.id.0, IdToken::Criterion),
                    encode_id(&cited.0, IdToken::Evidence)
                ));
            }
            CriterionMark::Waived { .. } => slots.push(format!(
                "{}:waived",
                encode_id(&item.id.0, IdToken::Criterion)
            )),
            CriterionMark::Inapplicable { .. } => {
                slots.push(format!(
                    "{}:inapplicable",
                    encode_id(&item.id.0, IdToken::Criterion)
                ));
            }
        }
    }
    if missing_evidence {
        return Err(CompletionError::MissingEvidence);
    }
    Ok(EvidenceSetId(slots.join(",")))
}
