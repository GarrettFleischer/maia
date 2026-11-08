//! Model endpoint row. The API key is never written here.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::error::StoreError;
use crate::types::ModelConnectionRecord;

const MAX_BASE_URL_BYTES: usize = 2048;
const MAX_MODEL_ID_BYTES: usize = 256;

pub(crate) fn put(
    connection: &mut Connection,
    record: &ModelConnectionRecord,
) -> Result<(), StoreError> {
    let base_url = required(&record.base_url, MAX_BASE_URL_BYTES, "base url")?;
    let model_id = required(&record.model_id, MAX_MODEL_ID_BYTES, "model")?;
    let reasoning = reasoning(&record.reasoning)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "INSERT INTO model_connection (singleton, base_url, model_id, reasoning) \
         VALUES (1, ?1, ?2, ?3) ON CONFLICT (singleton) DO UPDATE SET \
         base_url = excluded.base_url, model_id = excluded.model_id, reasoning = excluded.reasoning",
        params![base_url, model_id, reasoning],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn get(connection: &Connection) -> Result<Option<ModelConnectionRecord>, StoreError> {
    connection
        .query_row(
            "SELECT base_url, model_id, reasoning FROM model_connection WHERE singleton = 1",
            [],
            |row| {
                Ok(ModelConnectionRecord {
                    base_url: row.get(0)?,
                    model_id: row.get(1)?,
                    reasoning: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(StoreError::from)
}

fn required(value: &str, max_bytes: usize, label: &str) -> Result<String, StoreError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_bytes || trimmed.chars().any(char::is_control) {
        return Err(StoreError::InvalidRequest {
            message: format!("model connection {label} is invalid"),
        });
    }
    Ok(trimmed.to_owned())
}

fn reasoning(value: &str) -> Result<&'static str, StoreError> {
    match value.trim() {
        "low" => Ok("low"),
        "medium" => Ok("medium"),
        "high" => Ok("high"),
        _ => Err(StoreError::InvalidRequest {
            message: "model connection reasoning is invalid".to_owned(),
        }),
    }
}
