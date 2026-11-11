//! Embedding metadata and sqlite-vec rows.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::require_text;
use crate::canonical::validate_model;
use crate::error::StoreError;
use crate::types::EmbeddingModelWrite;
use crate::types::EmbeddingTarget;
use crate::types::EmbeddingWrite;
use crate::types::VecTable;
use crate::types::VecVersionMetadata;

pub(crate) fn put_model(
    connection: &mut Connection,
    request: &EmbeddingModelWrite,
) -> Result<(), StoreError> {
    validate_model(request)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<EmbeddingModelWrite> = transaction
        .query_row(
            "SELECT model_id, dimensions, weights_sha256, tokenizer_sha256, query_prefix, document_prefix, recorded_at \
             FROM embedding_models WHERE model_id = ?1",
            params![request.model_id],
            |row| {
                let dimensions: i64 = row.get(1)?;
                Ok(EmbeddingModelWrite {
                    model_id: row.get(0)?,
                    dimensions: dimensions as u64,
                    weights_sha256: row.get(2)?,
                    tokenizer_sha256: row.get(3)?,
                    query_prefix: row.get(4)?,
                    document_prefix: row.get(5)?,
                    recorded_at: row.get(6)?,
                })
            },
        )
        .optional()?;
    if let Some(stored) = existing {
        if stored == *request {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.model_id.clone(),
        });
    }
    transaction.execute(
        "INSERT INTO embedding_models (model_id, dimensions, weights_sha256, tokenizer_sha256, query_prefix, \
         document_prefix, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            request.model_id,
            request.dimensions as i64,
            request.weights_sha256,
            request.tokenizer_sha256,
            request.query_prefix,
            request.document_prefix,
            request.recorded_at
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn models(connection: &Connection) -> Result<Vec<EmbeddingModelWrite>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT model_id, dimensions, weights_sha256, tokenizer_sha256, query_prefix, document_prefix, recorded_at \
         FROM embedding_models ORDER BY model_id",
    )?;
    let mapped = statement.query_map([], |row| {
        let dimensions: i64 = row.get(1)?;
        Ok(EmbeddingModelWrite {
            model_id: row.get(0)?,
            dimensions: dimensions as u64,
            weights_sha256: row.get(2)?,
            tokenizer_sha256: row.get(3)?,
            query_prefix: row.get(4)?,
            document_prefix: row.get(5)?,
            recorded_at: row.get(6)?,
        })
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    Ok(rows)
}

fn encode_f32(values: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len().saturating_mul(4));
    for value in values {
        bytes.extend(value.to_le_bytes());
    }
    bytes
}

fn decode_f32(bytes: &[u8]) -> Result<Vec<f32>, StoreError> {
    if !bytes.len().is_multiple_of(4) {
        return Err(StoreError::InvalidRequest {
            message: "vector blob length is not a multiple of 4".to_owned(),
        });
    }
    let mut values = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let mut encoded = [0_u8; 4];
        encoded.copy_from_slice(chunk);
        values.push(f32::from_le_bytes(encoded));
    }
    Ok(values)
}

fn same_vector(left: &[f32], right: &[f32]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    for (left_value, right_value) in left.iter().zip(right.iter()) {
        if left_value.to_bits() != right_value.to_bits() {
            return false;
        }
    }
    true
}

fn target_kind(target: EmbeddingTarget) -> &'static str {
    match target {
        EmbeddingTarget::Episode => "episode",
        EmbeddingTarget::Claim => "claim",
        EmbeddingTarget::Fact => "fact",
    }
}

fn ensure_target(
    connection: &Connection,
    target: EmbeddingTarget,
    target_id: &str,
) -> Result<(), StoreError> {
    let sql = match target {
        EmbeddingTarget::Episode => "SELECT 1 FROM episodes WHERE episode_id = ?1",
        EmbeddingTarget::Claim => "SELECT 1 FROM claims WHERE claim_id = ?1",
        EmbeddingTarget::Fact => "SELECT 1 FROM facts WHERE fact_id = ?1",
    };
    let found: Option<i64> = connection
        .query_row(sql, params![target_id], |row| row.get(0))
        .optional()?;
    if found.is_none() {
        return Err(StoreError::NotFound {
            entity: target_kind(target),
            id: target_id.to_owned(),
        });
    }
    Ok(())
}

fn load_vector(
    connection: &Connection,
    target: EmbeddingTarget,
    rowid: i64,
) -> Result<Vec<f32>, StoreError> {
    let sql = match target {
        EmbeddingTarget::Episode => "SELECT embedding FROM episode_vec WHERE rowid = ?1",
        EmbeddingTarget::Claim => "SELECT embedding FROM claim_vec WHERE rowid = ?1",
        EmbeddingTarget::Fact => "SELECT embedding FROM fact_vec WHERE rowid = ?1",
    };
    let blob: Vec<u8> = connection.query_row(sql, params![rowid], |row| row.get(0))?;
    decode_f32(&blob)
}

fn insert_vector(
    connection: &Connection,
    target: EmbeddingTarget,
    rowid: i64,
    bytes: &[u8],
) -> Result<(), StoreError> {
    let sql = match target {
        EmbeddingTarget::Episode => {
            "INSERT INTO episode_vec (rowid, embedding) VALUES (?1, vec_f32(?2))"
        }
        EmbeddingTarget::Claim => {
            "INSERT INTO claim_vec (rowid, embedding) VALUES (?1, vec_f32(?2))"
        }
        EmbeddingTarget::Fact => "INSERT INTO fact_vec (rowid, embedding) VALUES (?1, vec_f32(?2))",
    };
    connection.execute(sql, params![rowid, bytes])?;
    Ok(())
}

pub(crate) fn upsert(
    connection: &mut Connection,
    request: &EmbeddingWrite,
) -> Result<(), StoreError> {
    require_text("target_id", &request.target_id)?;
    require_text("model_id", &request.model_id)?;
    for value in &request.values {
        if !value.is_finite() {
            return Err(StoreError::InvalidRequest {
                message: "embedding values must be finite".to_owned(),
            });
        }
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let dimensions: i64 = transaction
        .query_row(
            "SELECT dimensions FROM embedding_models WHERE model_id = ?1",
            params![request.model_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "embedding_model",
            id: request.model_id.clone(),
        })?;
    let width = usize::try_from(dimensions).map_err(|_| StoreError::InvalidRequest {
        message: "stored embedding width is invalid".to_owned(),
    })?;
    if request.values.len() != width {
        return Err(StoreError::InvalidRequest {
            message: format!(
                "embedding has {} values, model width is {width}",
                request.values.len()
            ),
        });
    }
    ensure_target(&transaction, request.target, &request.target_id)?;
    let kind = target_kind(request.target);
    let existing: Option<(String, i64)> = transaction
        .query_row(
            "SELECT model_id, vec_rowid FROM embedding_rows WHERE target_kind = ?1 AND target_id = ?2",
            params![kind, request.target_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((model_id, rowid)) = existing {
        if model_id != request.model_id {
            return Err(StoreError::IdempotencyConflict {
                key: request.target_id.clone(),
            });
        }
        let stored = load_vector(&transaction, request.target, rowid)?;
        if same_vector(&stored, &request.values) {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.target_id.clone(),
        });
    }
    let next: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(vec_rowid), 0) + 1 FROM embedding_rows WHERE target_kind = ?1",
        params![kind],
        |row| row.get(0),
    )?;
    insert_vector(
        &transaction,
        request.target,
        next,
        &encode_f32(&request.values),
    )?;
    transaction.execute(
        "INSERT INTO embedding_rows (target_kind, target_id, model_id, vec_rowid) VALUES (?1, ?2, ?3, ?4)",
        params![kind, request.target_id, request.model_id, next],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn embedding_for_model(
    connection: &Connection,
    target: EmbeddingTarget,
    target_id: &str,
    model_id: &str,
) -> Result<Option<Vec<f32>>, StoreError> {
    require_text("target_id", target_id)?;
    require_text("model_id", model_id)?;
    let kind = target_kind(target);
    let rowid: Option<i64> = connection
        .query_row(
            "SELECT vec_rowid FROM embedding_rows \
             WHERE target_kind = ?1 AND target_id = ?2 AND model_id = ?3",
            params![kind, target_id, model_id],
            |row| row.get(0),
        )
        .optional()?;
    match rowid {
        None => Ok(None),
        Some(rowid) => Ok(Some(load_vector(connection, target, rowid)?)),
    }
}

pub(crate) fn nearest_claim_vectors(
    connection: &Connection,
    model_id: &str,
    values: &[f32],
    limit: i64,
) -> Result<Vec<crate::types::VectorClaimHit>, StoreError> {
    require_text("model_id", model_id)?;
    if limit < 1 {
        return Err(StoreError::InvalidRequest {
            message: "nearest claim vector limit must be at least 1".to_owned(),
        });
    }
    if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
        return Err(StoreError::InvalidRequest {
            message: "query vector values must be finite".to_owned(),
        });
    }
    let model_total: i64 = connection.query_row(
        "SELECT COUNT(*) FROM embedding_rows WHERE target_kind = 'claim' AND model_id = ?1",
        params![model_id],
        |row| row.get(0),
    )?;
    if model_total == 0 {
        return Ok(Vec::new());
    }
    // KNN scans every claim vector. Other model ids can sit nearer than this
    // model's rows, so `k` is the claim-vector count and the model filter is
    // applied after the scan.
    let total: i64 = connection.query_row(
        "SELECT COUNT(*) FROM embedding_rows WHERE target_kind = 'claim'",
        [],
        |row| row.get(0),
    )?;
    let k = total.clamp(1, 1024);
    let bytes = encode_f32(values);
    let raw = {
        let mut statement = connection.prepare(
            "SELECT rowid, distance FROM claim_vec WHERE embedding MATCH vec_f32(?1) AND k = ?2",
        )?;
        let mapped = statement.query_map(params![bytes, k], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
        })?;
        let mut rows = Vec::new();
        for row in mapped {
            rows.push(row?);
        }
        rows
    };
    let mut hits = Vec::new();
    for (rowid, distance) in raw {
        if !distance.is_finite() {
            continue;
        }
        let claim: Option<(String, String, String)> = connection
            .query_row(
                "SELECT embedding_rows.target_id, claims.sentence, embedding_rows.model_id \
                 FROM embedding_rows \
                 JOIN claims ON claims.claim_id = embedding_rows.target_id \
                 WHERE embedding_rows.target_kind = 'claim' \
                   AND embedding_rows.vec_rowid = ?1 \
                   AND claims.status = 'provisional' \
                   AND claims.consolidated_by IS NULL",
                params![rowid],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((claim_id, sentence, stored_model)) = claim else {
            continue;
        };
        if stored_model != model_id {
            continue;
        }
        hits.push(crate::types::VectorClaimHit {
            claim_id,
            sentence,
            distance_bits: (distance as f32).to_bits(),
        });
    }
    hits.sort_by(|left, right| {
        left.distance_bits
            .cmp(&right.distance_bits)
            .then_with(|| left.claim_id.cmp(&right.claim_id))
    });
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    hits.truncate(limit);
    Ok(hits)
}

pub(crate) fn probe_vector_write(connection: &mut Connection) -> Result<(), StoreError> {
    let version = vec_version(connection)?;
    if version.is_empty() {
        return Err(StoreError::InvalidRequest {
            message: "vector extension returned an empty version".to_owned(),
        });
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let next: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(rowid), 0) + 1 FROM claim_vec",
        [],
        |row| row.get(0),
    )?;
    let bytes = encode_f32(&vec![0.0_f32; crate::types::EMBEDDING_DIMENSIONS]);
    transaction.execute(
        "INSERT INTO claim_vec (rowid, embedding) VALUES (?1, vec_f32(?2))",
        params![next, bytes],
    )?;
    transaction.execute("DELETE FROM claim_vec WHERE rowid = ?1", params![next])?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn embedding(
    connection: &Connection,
    target: EmbeddingTarget,
    target_id: &str,
) -> Result<Option<Vec<f32>>, StoreError> {
    let kind = target_kind(target);
    let rowid: Option<i64> = connection
        .query_row(
            "SELECT vec_rowid FROM embedding_rows WHERE target_kind = ?1 AND target_id = ?2",
            params![kind, target_id],
            |row| row.get(0),
        )
        .optional()?;
    match rowid {
        None => Ok(None),
        Some(rowid) => Ok(Some(load_vector(connection, target, rowid)?)),
    }
}

pub(crate) fn vec_version(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row("SELECT vec_version()", [], |row| row.get(0))
        .map_err(StoreError::from)
}

pub(crate) fn vec_metadata(
    connection: &Connection,
    table: VecTable,
) -> Result<VecVersionMetadata, StoreError> {
    let sql = match table {
        VecTable::Episode => "SELECT CAST(value AS TEXT) FROM episode_vec_info WHERE key = ?1",
        VecTable::Claim => "SELECT CAST(value AS TEXT) FROM claim_vec_info WHERE key = ?1",
        VecTable::Fact => "SELECT CAST(value AS TEXT) FROM fact_vec_info WHERE key = ?1",
    };
    let version: String = connection.query_row(sql, params!["CREATE_VERSION"], |row| row.get(0))?;
    let major = info_i64(connection, sql, "CREATE_VERSION_MAJOR")?;
    let minor = info_i64(connection, sql, "CREATE_VERSION_MINOR")?;
    let patch = info_i64(connection, sql, "CREATE_VERSION_PATCH")?;
    Ok(VecVersionMetadata {
        version,
        major,
        minor,
        patch,
    })
}

fn info_i64(connection: &Connection, sql: &str, key: &str) -> Result<i64, StoreError> {
    let text: String = connection.query_row(sql, params![key], |row| row.get(0))?;
    text.parse::<i64>().map_err(|_| StoreError::InvalidRequest {
        message: format!("vector metadata `{key}` is not an integer"),
    })
}
