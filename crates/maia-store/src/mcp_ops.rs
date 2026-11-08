//! MCP connection rows. Secret values are never written here.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use maia_core::mcp::valid_connection_id;
use maia_core::mcp::valid_owner_label;
use maia_core::mcp::valid_secret_name;
use maia_core::mcp::valid_stdio_launch;
use maia_core::mcp::validate_connection_target;

use crate::error::StoreError;
use crate::types::McpAuditWrite;
use crate::types::McpConnectionRecord;
use crate::types::McpSecretSlot;
use crate::types::McpTransportRecord;

const MAX_GUIDANCE_BYTES: usize = 2000;

pub(crate) fn create(
    connection: &mut Connection,
    record: &McpConnectionRecord,
) -> Result<(), StoreError> {
    validate_record(record)?;
    if record.admitted_hash.is_some() || record.listed_hash.is_some() || record.listed_canonical.is_some()
    {
        return Err(invalid("mcp connection starts without an admitted list"));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists = transaction
        .query_row(
            "SELECT 1 FROM mcp_connections WHERE connection_id = ?1",
            params![record.id],
            |_| Ok(()),
        )
        .optional()?;
    if exists.is_some() {
        return Err(invalid("mcp connection already exists"));
    }
    insert_connection(&transaction, record)?;
    insert_slots(&transaction, &record.id, &record.transport)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn replace_transport(
    connection: &mut Connection,
    id: &str,
    transport: &McpTransportRecord,
) -> Result<(), StoreError> {
    validate_transport(transport)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let updated = transaction.execute(
        "UPDATE mcp_connections SET transport_kind = ?2, url = ?3, command = ?4, args_json = ?5, \
         admitted_hash = NULL, listed_canonical = NULL, listed_hash = NULL, refresh_error = NULL \
         WHERE connection_id = ?1",
        params![
            id,
            kind(transport),
            url_of(transport),
            command_of(transport),
            args_json(transport)?,
        ],
    )?;
    if updated == 0 {
        return Err(invalid("mcp connection is missing"));
    }
    transaction.execute(
        "DELETE FROM mcp_secret_slots WHERE connection_id = ?1",
        params![id],
    )?;
    insert_slots(&transaction, id, transport)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn update_label(
    connection: &Connection,
    id: &str,
    label: &str,
) -> Result<(), StoreError> {
    if !valid_owner_label(label) {
        return Err(invalid("mcp label is invalid"));
    }
    let updated = connection.execute(
        "UPDATE mcp_connections SET label = ?2 WHERE connection_id = ?1",
        params![id, label],
    )?;
    if updated == 0 {
        return Err(invalid("mcp connection is missing"));
    }
    Ok(())
}

pub(crate) fn delete(connection: &Connection, id: &str) -> Result<(), StoreError> {
    let updated = connection.execute(
        "DELETE FROM mcp_connections WHERE connection_id = ?1",
        params![id],
    )?;
    if updated == 0 {
        return Err(invalid("mcp connection is missing"));
    }
    Ok(())
}

pub(crate) fn list(connection: &Connection) -> Result<Vec<McpConnectionRecord>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT connection_id, label, transport_kind, url, command, args_json, admitted_hash, \
         listed_canonical, listed_hash, refresh_error FROM mcp_connections ORDER BY connection_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(RowParts {
            id: row.get(0)?,
            label: row.get(1)?,
            kind: row.get(2)?,
            url: row.get(3)?,
            command: row.get(4)?,
            args_json: row.get(5)?,
            admitted_hash: row.get(6)?,
            listed_canonical: row.get(7)?,
            listed_hash: row.get(8)?,
            refresh_error: row.get(9)?,
        })
    })?;
    let mut records = Vec::new();
    for row in rows {
        let row = row?;
        let slots = slots(connection, &row.id)?;
        records.push(record_from_row(row, slots)?);
    }
    Ok(records)
}

pub(crate) fn store_list(
    connection: &Connection,
    id: &str,
    canonical: &str,
    hash: &str,
) -> Result<(), StoreError> {
    let updated = connection.execute(
        "UPDATE mcp_connections SET listed_canonical = ?2, listed_hash = ?3, refresh_error = NULL \
         WHERE connection_id = ?1",
        params![id, canonical, hash],
    )?;
    if updated == 0 {
        return Err(invalid("mcp connection is missing"));
    }
    Ok(())
}

pub(crate) fn set_refresh_error(
    connection: &Connection,
    id: &str,
    message: &str,
) -> Result<(), StoreError> {
    let updated = connection.execute(
        "UPDATE mcp_connections SET refresh_error = ?2 WHERE connection_id = ?1",
        params![id, message],
    )?;
    if updated == 0 {
        return Err(invalid("mcp connection is missing"));
    }
    Ok(())
}

pub(crate) fn admit(connection: &Connection, id: &str, hash: &str) -> Result<(), StoreError> {
    let listed: Option<String> = connection
        .query_row(
            "SELECT listed_hash FROM mcp_connections WHERE connection_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| invalid("mcp connection is missing"))?;
    if listed.as_deref() != Some(hash) {
        return Err(invalid("mcp admit hash does not match the listed manifest"));
    }
    connection.execute(
        "UPDATE mcp_connections SET admitted_hash = ?2 WHERE connection_id = ?1",
        params![id, hash],
    )?;
    Ok(())
}

pub(crate) fn revoke(connection: &Connection, id: &str) -> Result<(), StoreError> {
    let updated = connection.execute(
        "UPDATE mcp_connections SET admitted_hash = NULL WHERE connection_id = ?1",
        params![id],
    )?;
    if updated == 0 {
        return Err(invalid("mcp connection is missing"));
    }
    Ok(())
}

pub(crate) fn put_guidance(
    connection: &Connection,
    task_id: &str,
    guidance: &str,
) -> Result<(), StoreError> {
    if guidance.len() > MAX_GUIDANCE_BYTES {
        return Err(invalid("mcp guidance is too long"));
    }
    connection.execute(
        "INSERT INTO task_guidance (task_id, guidance) VALUES (?1, ?2) \
         ON CONFLICT (task_id) DO UPDATE SET guidance = excluded.guidance",
        params![task_id, guidance],
    )?;
    Ok(())
}

pub(crate) fn guidance(connection: &Connection, task_id: &str) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT guidance FROM task_guidance WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::from)
}

pub(crate) fn insert_audit(connection: &Connection, audit: &McpAuditWrite) -> Result<(), StoreError> {
    if audit.exchange_class != "known_failure"
        && audit.exchange_class != "known_result"
        && audit.exchange_class != "unknown"
    {
        return Err(invalid("mcp audit class is invalid"));
    }
    connection.execute(
        "INSERT INTO mcp_call_audit \
         (connection_id, wire_name, manifest_hash, exchange_class, result_sha256) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            audit.connection_id,
            audit.wire_name,
            audit.manifest_hash,
            audit.exchange_class,
            audit.result_sha256,
        ],
    )?;
    Ok(())
}

struct RowParts {
    id: String,
    label: String,
    kind: String,
    url: Option<String>,
    command: Option<String>,
    args_json: String,
    admitted_hash: Option<String>,
    listed_canonical: Option<String>,
    listed_hash: Option<String>,
    refresh_error: Option<String>,
}

fn record_from_row(row: RowParts, slots: Vec<(String, String, String)>) -> Result<McpConnectionRecord, StoreError> {
    let transport = match row.kind.as_str() {
        "http" => McpTransportRecord::Http {
            url: row.url.unwrap_or_default(),
            headers: named_slots(&slots, "header"),
        },
        "stdio" => McpTransportRecord::Stdio {
            command: row.command.unwrap_or_default(),
            args: decode_args(&row.args_json)?,
            env: named_slots(&slots, "env"),
        },
        _ => return Err(invalid("mcp transport is invalid")),
    };
    Ok(McpConnectionRecord {
        id: row.id,
        label: row.label,
        transport,
        admitted_hash: row.admitted_hash,
        listed_canonical: row.listed_canonical,
        listed_hash: row.listed_hash,
        refresh_error: row.refresh_error,
    })
}

fn named_slots(slots: &[(String, String, String)], kind: &str) -> Vec<McpSecretSlot> {
    slots
        .iter()
        .filter(|(slot_kind, _, _)| slot_kind == kind)
        .map(|(_, name, secret_ref)| McpSecretSlot {
            name: name.clone(),
            secret_ref: secret_ref.clone(),
        })
        .collect()
}

fn slots(
    connection: &Connection,
    id: &str,
) -> Result<Vec<(String, String, String)>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT slot_kind, name, secret_ref FROM mcp_secret_slots \
         WHERE connection_id = ?1 ORDER BY ordinal",
    )?;
    let rows = statement.query_map(params![id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    let mut slots = Vec::new();
    for row in rows {
        slots.push(row?);
    }
    Ok(slots)
}

fn insert_connection(connection: &Connection, record: &McpConnectionRecord) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO mcp_connections \
         (connection_id, label, transport_kind, url, command, args_json, admitted_hash, \
          listed_canonical, listed_hash, refresh_error) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            record.id,
            record.label,
            kind(&record.transport),
            url_of(&record.transport),
            command_of(&record.transport),
            args_json(&record.transport)?,
            record.admitted_hash,
            record.listed_canonical,
            record.listed_hash,
            record.refresh_error,
        ],
    )?;
    Ok(())
}

fn insert_slots(
    connection: &Connection,
    id: &str,
    transport: &McpTransportRecord,
) -> Result<(), StoreError> {
    let (kind, slots) = match transport {
        McpTransportRecord::Http { headers, .. } => ("header", headers),
        McpTransportRecord::Stdio { env, .. } => ("env", env),
    };
    for (ordinal, slot) in slots.iter().enumerate() {
        connection.execute(
            "INSERT INTO mcp_secret_slots (connection_id, ordinal, slot_kind, name, secret_ref) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, i64::try_from(ordinal).unwrap_or(i64::MAX), kind, slot.name, slot.secret_ref],
        )?;
    }
    Ok(())
}

fn validate_record(record: &McpConnectionRecord) -> Result<(), StoreError> {
    if !valid_connection_id(&record.id) {
        return Err(invalid("mcp connection id is invalid"));
    }
    if !valid_owner_label(&record.label) {
        return Err(invalid("mcp label is invalid"));
    }
    validate_transport(&record.transport)
}

fn validate_transport(transport: &McpTransportRecord) -> Result<(), StoreError> {
    match transport {
        McpTransportRecord::Http { url, headers } => {
            validate_connection_target(url).map_err(|_| invalid("mcp url is invalid"))?;
            validate_slots(headers)?;
        }
        McpTransportRecord::Stdio { command, args, env } => {
            if !valid_stdio_launch(command, args) {
                return Err(invalid("mcp stdio launch is invalid"));
            }
            validate_slots(env)?;
        }
    }
    Ok(())
}

fn validate_slots(slots: &[McpSecretSlot]) -> Result<(), StoreError> {
    for slot in slots {
        if !valid_secret_name(&slot.name) || slot.secret_ref.trim().is_empty() || slot.secret_ref.len() > 128
        {
            return Err(invalid("mcp secret slot is invalid"));
        }
        if slot.secret_ref.chars().any(char::is_control) {
            return Err(invalid("mcp secret slot is invalid"));
        }
    }
    Ok(())
}

fn kind(transport: &McpTransportRecord) -> &'static str {
    match transport {
        McpTransportRecord::Http { .. } => "http",
        McpTransportRecord::Stdio { .. } => "stdio",
    }
}

fn url_of(transport: &McpTransportRecord) -> Option<&str> {
    match transport {
        McpTransportRecord::Http { url, .. } => Some(url.as_str()),
        McpTransportRecord::Stdio { .. } => None,
    }
}

fn command_of(transport: &McpTransportRecord) -> Option<&str> {
    match transport {
        McpTransportRecord::Stdio { command, .. } => Some(command.as_str()),
        McpTransportRecord::Http { .. } => None,
    }
}

fn args_json(transport: &McpTransportRecord) -> Result<String, StoreError> {
    match transport {
        McpTransportRecord::Http { .. } => Ok("[]".to_owned()),
        McpTransportRecord::Stdio { args, .. } => {
            serde_json::to_string(args).map_err(|_| invalid("mcp arguments are invalid"))
        }
    }
}

fn decode_args(text: &str) -> Result<Vec<String>, StoreError> {
    serde_json::from_str(text).map_err(|_| invalid("mcp arguments are invalid"))
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidRequest {
        message: message.to_owned(),
    }
}
