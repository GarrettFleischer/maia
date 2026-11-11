//! Untrusted attachment rows. Bytes stay on disk; this module stores the reference.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::require_text;
use crate::error::StoreError;
use crate::types::AttachmentRow;
use crate::types::AttachmentWrite;
use crate::types::DeletedAttachment;

/// Largest accepted attachment, in bytes.
pub const MAX_ATTACHMENT_BYTES: i64 = 10 * 1024 * 1024;

const ALLOWED_MEDIA: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "text/plain",
    "application/pdf",
];

/// Whether `media_type` is on the attachment allowlist.
#[must_use]
pub fn attachment_media_allowed(media_type: &str) -> bool {
    ALLOWED_MEDIA.contains(&media_type)
}

pub(crate) fn insert(
    connection: &mut Connection,
    request: &AttachmentWrite,
) -> Result<(), StoreError> {
    validate(request)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<(String, i64, String)> = transaction
        .query_row(
            "SELECT content_sha256, byte_size, media_type FROM attachments WHERE attachment_id = ?1",
            params![request.attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((hash, size, media)) = existing {
        if hash == request.content_sha256
            && size == request.byte_size
            && media == request.media_type
        {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.attachment_id.clone(),
        });
    }
    transaction.execute(
        "INSERT INTO attachments (attachment_id, content_sha256, byte_size, media_type, safe_name, \
         relative_path, taint, created_at, message_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'untrusted', ?7, NULL)",
        params![
            request.attachment_id,
            request.content_sha256,
            request.byte_size,
            request.media_type,
            request.safe_name,
            request.relative_path,
            request.created_at
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn get(
    connection: &Connection,
    attachment_id: &str,
) -> Result<Option<AttachmentRow>, StoreError> {
    require_text("attachment_id", attachment_id)?;
    let mut statement = connection.prepare(
        "SELECT attachment_id, content_sha256, byte_size, media_type, safe_name, relative_path, \
         created_at, message_id FROM attachments WHERE attachment_id = ?1",
    )?;
    let row = statement
        .query_row(params![attachment_id], read_row)
        .optional()?;
    Ok(row)
}

pub(crate) fn for_message(
    connection: &Connection,
    message_id: &str,
) -> Result<Vec<AttachmentRow>, StoreError> {
    require_text("message_id", message_id)?;
    let mut statement = connection.prepare(
        "SELECT attachment_id, content_sha256, byte_size, media_type, safe_name, relative_path, \
         created_at, message_id FROM attachments WHERE message_id = ?1 ORDER BY attachment_id",
    )?;
    let mapped = statement.query_map(params![message_id], read_row)?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    Ok(rows)
}

pub(crate) fn bind(
    connection: &mut Connection,
    ids: &[String],
    message_id: &str,
) -> Result<(), StoreError> {
    require_text("message_id", message_id)?;
    if ids.is_empty() {
        return Ok(());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for id in ids {
        require_text("attachment_id", id)?;
        let bound: Option<Option<String>> = transaction
            .query_row(
                "SELECT message_id FROM attachments WHERE attachment_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(current) = bound else {
            return Err(StoreError::NotFound {
                entity: "attachment",
                id: id.clone(),
            });
        };
        match current.as_deref() {
            Some(existing) if existing == message_id => {}
            Some(_) => {
                return Err(StoreError::IdempotencyConflict { key: id.clone() });
            }
            None => {
                transaction.execute(
                    "UPDATE attachments SET message_id = ?1 WHERE attachment_id = ?2",
                    params![message_id, id],
                )?;
            }
        }
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn delete(
    connection: &mut Connection,
    attachment_id: &str,
) -> Result<DeletedAttachment, StoreError> {
    require_text("attachment_id", attachment_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<(String, String, Option<String>)> = transaction
        .query_row(
            "SELECT content_sha256, relative_path, message_id FROM attachments WHERE attachment_id = ?1",
            params![attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((hash, relative_path, message_id)) = row else {
        return Err(StoreError::NotFound {
            entity: "attachment",
            id: attachment_id.to_owned(),
        });
    };
    if message_id.is_some() {
        return Err(StoreError::InvalidRequest {
            message: "a sent attachment cannot be removed".to_owned(),
        });
    }
    transaction.execute(
        "DELETE FROM attachments WHERE attachment_id = ?1",
        params![attachment_id],
    )?;
    let remaining: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM attachments WHERE content_sha256 = ?1",
        params![hash],
        |row| row.get(0),
    )?;
    transaction.commit()?;
    Ok(DeletedAttachment {
        relative_path,
        remove_file: remaining == 0,
    })
}

fn validate(request: &AttachmentWrite) -> Result<(), StoreError> {
    require_text("attachment_id", &request.attachment_id)?;
    if request.attachment_id.len() > 80
        || request
            .attachment_id
            .bytes()
            .any(|byte| byte.is_ascii_whitespace())
    {
        return Err(StoreError::InvalidRequest {
            message: "attachment_id is not a safe id".to_owned(),
        });
    }
    if !is_lower_hex(&request.content_sha256, 64) {
        return Err(StoreError::InvalidRequest {
            message: "attachment hash must be lowercase sha256".to_owned(),
        });
    }
    if request.byte_size <= 0 || request.byte_size > MAX_ATTACHMENT_BYTES {
        return Err(StoreError::InvalidRequest {
            message: "attachment is empty or larger than 10 MB".to_owned(),
        });
    }
    if !attachment_media_allowed(&request.media_type) {
        return Err(StoreError::InvalidRequest {
            message: "attachment type is not allowed".to_owned(),
        });
    }
    if !safe_display_name(&request.safe_name) {
        return Err(StoreError::InvalidRequest {
            message: "attachment name is not safe to display".to_owned(),
        });
    }
    let expected = format!("attachments/{}", request.content_sha256);
    if request.relative_path != expected {
        return Err(StoreError::InvalidRequest {
            message: "attachment path must be the content hash".to_owned(),
        });
    }
    Ok(())
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttachmentRow> {
    Ok(AttachmentRow {
        attachment_id: row.get(0)?,
        content_sha256: row.get(1)?,
        byte_size: row.get(2)?,
        media_type: row.get(3)?,
        safe_name: row.get(4)?,
        relative_path: row.get(5)?,
        created_at: row.get(6)?,
        message_id: row.get(7)?,
    })
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn safe_display_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 120 || name == "." || name == ".." {
        return false;
    }
    bytes.iter().all(|byte| {
        matches!(byte, 0x20..=0x7e) && !matches!(byte, b'/' | b'\\' | b':' | b'<' | b'>' | b'"')
    })
}
