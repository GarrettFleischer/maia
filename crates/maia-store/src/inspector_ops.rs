//! Inspector rows for completed router turns.

use rusqlite::Connection;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::require_text;
use crate::error::StoreError;
use crate::limits::MAX_PROSE_BYTES;
use crate::types::RouterTurnWrite;

pub(crate) fn insert_router_turn(
    connection: &mut Connection,
    request: &RouterTurnWrite,
) -> Result<(), StoreError> {
    require_text("message_id", &request.message_id)?;
    require_prose("slots_json", &request.slots_json)?;
    require_prose("usage_json", &request.usage_json)?;
    require_prose("recall_json", &request.recall_json)?;
    require_prose("reply", &request.reply)?;
    if let Some(thinking) = &request.thinking {
        require_prose("thinking", thinking)?;
    }
    if let Some(route) = &request.route {
        require_text("route", route)?;
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let ordinal: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM router_turn_snapshots",
        [],
        |row| row.get(0),
    )?;
    transaction.execute(
        "INSERT INTO router_turn_snapshots \
         (ordinal, message_id, slots_json, usage_json, recall_json, thinking, route, reply, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            ordinal,
            request.message_id,
            request.slots_json,
            request.usage_json,
            request.recall_json,
            request.thinking,
            request.route,
            request.reply,
            request.created_at,
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

fn require_prose(field: &'static str, value: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > MAX_PROSE_BYTES {
        return Err(StoreError::InvalidRequest {
            message: format!("{field} is not valid"),
        });
    }
    Ok(())
}
