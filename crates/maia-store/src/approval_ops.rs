//! Owner approvals. Copy is fixed in code. Model output never chooses it.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::require_text;
use crate::error::StoreError;
use crate::types::ApprovalDecision;
use crate::types::ApprovalSettlement;
use crate::types::ApprovalWrite;
use crate::types::MemoryTaint;
use crate::types::PendingApproval;

pub(crate) fn insert(
    connection: &mut Connection,
    request: &ApprovalWrite,
) -> Result<(), StoreError> {
    require_digits("approval_id", &request.approval_id)?;
    require_text("task_id", &request.task_id)?;
    if request.task_id.len() > 128 {
        return Err(StoreError::InvalidRequest {
            message: "task_id is too long".to_owned(),
        });
    }
    if request.expires_at <= request.created_at {
        return Err(StoreError::InvalidRequest {
            message: "approval expiry must be after creation".to_owned(),
        });
    }
    let (grant_text, reason) = copy_for_kind(&request.kind)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<(String, String, String, i64, i64)> = transaction
        .query_row(
            "SELECT task_id, kind, taint, created_at, expires_at FROM pending_approvals \
             WHERE approval_id = ?1",
            params![request.approval_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    if let Some((task_id, kind, taint, created_at, expires_at)) = existing {
        let same = task_id == request.task_id
            && kind == request.kind
            && taint == request.taint.as_str()
            && created_at == request.created_at
            && expires_at == request.expires_at;
        if same {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.approval_id.clone(),
        });
    }
    transaction.execute(
        "INSERT INTO pending_approvals (approval_id, task_id, kind, taint, grant_text, reason, \
         created_at, expires_at, status, decided_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', NULL)",
        params![
            request.approval_id,
            request.task_id,
            request.kind,
            request.taint.as_str(),
            grant_text,
            reason,
            request.created_at,
            request.expires_at
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn pending(
    connection: &Connection,
    now: i64,
) -> Result<Vec<PendingApproval>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT approval_id, task_id, kind, taint, grant_text, reason, created_at, expires_at \
         FROM pending_approvals \
         WHERE status = 'pending' AND expires_at > ?1 \
         ORDER BY created_at, approval_id",
    )?;
    let mapped = statement.query_map(params![now], read_pending)?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    Ok(rows)
}

pub(crate) fn expire_due(connection: &mut Connection, now: i64) -> Result<Vec<String>, StoreError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut tasks = Vec::new();
    {
        let mut statement = transaction.prepare(
            "SELECT task_id FROM pending_approvals \
             WHERE status = 'pending' AND expires_at <= ?1 ORDER BY approval_id",
        )?;
        let mapped = statement.query_map(params![now], |row| row.get::<_, String>(0))?;
        for task in mapped {
            let task = task?;
            if !tasks.contains(&task) {
                tasks.push(task);
            }
        }
    }
    transaction.execute(
        "UPDATE pending_approvals SET status = 'expired', decided_at = ?1 \
         WHERE status = 'pending' AND expires_at <= ?1",
        params![now],
    )?;
    transaction.commit()?;
    Ok(tasks)
}

pub(crate) fn decide(
    connection: &mut Connection,
    approval_id: &str,
    decision: ApprovalDecision,
    now: i64,
) -> Result<ApprovalSettlement, StoreError> {
    require_digits("approval_id", approval_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<(String, String, i64)> = transaction
        .query_row(
            "SELECT task_id, status, expires_at FROM pending_approvals WHERE approval_id = ?1",
            params![approval_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((task_id, status, expires_at)) = row else {
        return Err(StoreError::NotFound {
            entity: "approval",
            id: approval_id.to_owned(),
        });
    };
    if status != "pending" {
        transaction.commit()?;
        return Ok(ApprovalSettlement::AlreadySettled);
    }
    if expires_at <= now {
        transaction.execute(
            "UPDATE pending_approvals SET status = 'expired', decided_at = ?1 WHERE approval_id = ?2",
            params![now, approval_id],
        )?;
        transaction.commit()?;
        return Ok(ApprovalSettlement::Expired { task_id });
    }
    let (status, settlement) = match decision {
        ApprovalDecision::Approve => ("approved", ApprovalSettlement::Approved { task_id }),
        ApprovalDecision::Deny => ("denied", ApprovalSettlement::Denied { task_id }),
    };
    transaction.execute(
        "UPDATE pending_approvals SET status = ?1, decided_at = ?2 WHERE approval_id = ?3",
        params![status, now, approval_id],
    )?;
    transaction.commit()?;
    Ok(settlement)
}

fn read_pending(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingApproval> {
    let taint: String = row.get(3)?;
    Ok(PendingApproval {
        approval_id: row.get(0)?,
        task_id: row.get(1)?,
        kind: row.get(2)?,
        taint: match taint.as_str() {
            "trusted" => MemoryTaint::Trusted,
            _ => MemoryTaint::Untrusted,
        },
        grant_text: row.get(4)?,
        reason: row.get(5)?,
        created_at: row.get(6)?,
        expires_at: row.get(7)?,
    })
}

fn copy_for_kind(kind: &str) -> Result<(&'static str, &'static str), StoreError> {
    match kind {
        "login" => Ok((
            "Sign in to the service this task needs",
            "This task is waiting for you to sign in.",
        )),
        "consent" => Ok((
            "Allow this task to continue",
            "This task is waiting for your consent.",
        )),
        "capability" => Ok((
            "Grant the capability this task requested",
            "This task is waiting for a capability grant.",
        )),
        _ => Err(StoreError::InvalidRequest {
            message: "approval kind must be login, consent, or capability".to_owned(),
        }),
    }
}

fn require_digits(field: &str, value: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(StoreError::InvalidRequest {
            message: format!("{field} must be a decimal id"),
        });
    }
    Ok(())
}
