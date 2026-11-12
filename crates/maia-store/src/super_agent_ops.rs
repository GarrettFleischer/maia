//! Super Agent router and task session persistence.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Row;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use rusqlite::types::ValueRef;

use crate::canonical::require_text;
use crate::error::StoreError;
use crate::limits::MAX_PROSE_BYTES;
use crate::limits::MAX_THREAD_EVENT_BODY_BYTES;
use crate::limits::require_bounded;
use crate::super_agent_contract::CanonicalTextRequirement;
use crate::super_agent_contract::SuperAgentCanonicalError;
use crate::super_agent_contract::validate_canonical_text;
use crate::super_agent_contract::validate_child_contract;
use crate::super_agent_contract::validate_completion_view_contract;
use crate::super_agent_contract::validate_context_item_contract;
use crate::super_agent_contract::validate_criterion_contract;
use crate::super_agent_contract::validate_envelope_contract;
use crate::super_agent_contract::validate_phase_contract;
use crate::super_agent_contract::validate_pin_contract;
use crate::super_agent_contract::validate_router_message_contract;
use crate::types::ChildAssignmentWrite;
use crate::types::ChildLink;
use crate::types::ContinueTaskWrite;
use crate::types::HostMutationWrite;
use crate::types::MessageSubmissionState;
use crate::types::MessageSubmissionWrite;
use crate::types::RouterMessageWrite;
use crate::types::RuntimeAttempt;
use crate::types::RuntimeChild;
use crate::types::RuntimeContextItem;
use crate::types::RuntimeEnvelope;
use crate::types::RuntimeEvidence;
use crate::types::RuntimeIdBlock;
use crate::types::RuntimeIdNamespace;
use crate::types::RuntimeIdSeeds;
use crate::types::RuntimeInput;
use crate::types::RuntimeMessage;
use crate::types::RuntimeReport;
use crate::types::RuntimeSnapshot;
use crate::types::RuntimeTask;
use crate::types::SnapshotItemWrite;
use crate::types::StoredCriterion;
use crate::types::StoredHelper;
use crate::types::StoredReport;
use crate::types::StoredSubmissionOutcome;
use crate::types::TaskAggregateWrite;
use crate::types::TaskAttemptWrite;
use crate::types::TaskCriterionWrite;
use crate::types::TaskEnvelopeWrite;
use crate::types::TaskEvidenceWrite;
use crate::types::TaskInputWrite;
use crate::types::TaskInspection;
use crate::types::TaskReportWrite;
use crate::types::TaskView;
use crate::types::TaskWrite;
use crate::types::runtime_id_contracts;

fn immediate(connection: &mut Connection) -> Result<rusqlite::Transaction<'_>, StoreError> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StoreError::from)
}

fn require_blob(field: &'static str, bytes: &[u8]) -> Result<(), StoreError> {
    require_bounded(field, bytes.len(), MAX_THREAD_EVENT_BODY_BYTES)
}

fn require_prose(field: &'static str, value: &str) -> Result<(), StoreError> {
    require_bounded(field, value.len(), MAX_PROSE_BYTES)
}

fn canonical(error: SuperAgentCanonicalError) -> StoreError {
    StoreError::InvalidRequest {
        message: error.to_string(),
    }
}

fn validate_phase_value(phase: &str) -> Result<(), StoreError> {
    require_prose("phase", phase)?;
    validate_phase_contract(phase).map_err(canonical)
}

pub(crate) fn validate_router_message(request: &RouterMessageWrite) -> Result<(), StoreError> {
    require_prose("router_message_body", &request.body)?;
    validate_router_message_contract(&request.message_id, &request.role, &request.body)
        .map_err(canonical)
}

pub(crate) fn validate_task(request: &TaskWrite) -> Result<(), StoreError> {
    require_text("task_id", &request.task_id)?;
    validate_phase_value(&request.phase)?;
    require_prose("task_title", &request.title)?;
    validate_pin_contract(&request.pin).map_err(canonical)?;
    validate_completion_view_contract(&request.completion_view).map_err(canonical)?;
    require_text("attempt_id", &request.attempt_id)?;
    require_text("attempt_state", &request.attempt_state)?;
    if request.attempt_state != "active" {
        return Err(StoreError::InvalidRequest {
            message: "attempt state is not canonical".to_owned(),
        });
    }
    if let Some(prior) = &request.prior_task_id {
        require_text("prior_task_id", prior)?;
    }
    Ok(())
}

pub(crate) fn validate_envelope(request: &TaskEnvelopeWrite) -> Result<(), StoreError> {
    require_text("task_id", &request.task_id)?;
    require_blob("task_prompt", &request.prompt)?;
    require_prose("task_brief", &request.brief)?;
    require_prose("routing_reason", &request.routing_reason)?;
    validate_envelope_contract(
        &request.prompt,
        &request.brief,
        &request.routing_reason,
        &request.snapshot_id,
    )
    .map_err(canonical)
}

pub(crate) fn validate_task_input(request: &TaskInputWrite) -> Result<(), StoreError> {
    require_text("task_id", &request.task_id)?;
    require_text("message_id", &request.message_id)?;
    require_blob("task_input_prompt", &request.prompt)?;
    Ok(())
}

pub(crate) fn validate_task_id(task_id: &str) -> Result<(), StoreError> {
    require_text("task_id", task_id)
}

pub(crate) fn validate_phase(task_id: &str, phase: &str) -> Result<(), StoreError> {
    validate_task_id(task_id)?;
    validate_phase_value(phase)
}

pub(crate) fn validate_evidence_id(evidence_id: &str) -> Result<(), StoreError> {
    require_text("evidence_id", evidence_id)
}

pub(crate) fn validate_evidence(request: &TaskEvidenceWrite) -> Result<(), StoreError> {
    validate_evidence_id(&request.evidence_id)?;
    validate_task_id(&request.task_id)?;
    require_text("attempt_id", &request.attempt_id)?;
    require_text("evidence_body", &request.body)?;
    require_prose("evidence_body", &request.body)
}

pub(crate) fn validate_report(request: &TaskReportWrite) -> Result<(), StoreError> {
    require_text("report_id", &request.report_id)?;
    require_text("task_id", &request.task_id)?;
    require_text("attempt_id", &request.attempt_id)?;
    require_text("kind", &request.kind)?;
    require_prose("report_summary", &request.summary)?;
    if !request.call_id.is_empty() {
        require_prose("report_call_id", &request.call_id)?;
    }
    Ok(())
}

pub(crate) fn validate_criterion(request: &TaskCriterionWrite) -> Result<(), StoreError> {
    require_text("criterion_id", &request.criterion_id)?;
    require_text("task_id", &request.task_id)?;
    require_text("source_kind", &request.source_kind)?;
    require_text("source_ref", &request.source_ref)?;
    validate_canonical_text(
        "criterion text",
        &request.text,
        CanonicalTextRequirement::Nonempty,
    )
    .map_err(canonical)?;
    match (request.span_start, request.span_end) {
        (None, None) | (Some(_), Some(_)) => Ok(()),
        (Some(_), None) | (None, Some(_)) => Err(StoreError::InvalidRequest {
            message: "criterion span must include both ends".to_owned(),
        }),
    }
}

fn validate_snapshot(snapshot_id: &str, items: &[SnapshotItemWrite]) -> Result<(), StoreError> {
    require_text("snapshot_id", snapshot_id)?;
    for item in items {
        require_prose("provenance", &item.provenance)?;
        require_prose("sentence", &item.sentence)?;
        validate_context_item_contract(
            &item.memory_id,
            &item.provenance,
            &item.trust,
            &item.sentence,
        )
        .map_err(canonical)?;
    }
    Ok(())
}

pub(crate) fn validate_child(request: &ChildAssignmentWrite) -> Result<(), StoreError> {
    require_blob("child_subgoal", &request.subgoal)?;
    validate_child_contract(
        &request.child_id,
        &request.parent_task_id,
        request.depth,
        &request.subgoal,
        request.budget_tokens,
        request.budget_turns,
    )
    .map_err(canonical)
}

pub(crate) fn validate_pin(pin: &str) -> Result<(), StoreError> {
    require_prose("pin", pin)?;
    validate_pin_contract(pin).map_err(canonical)
}

pub(crate) fn validate_completion_view(view: &str) -> Result<(), StoreError> {
    require_prose("completion_view", view)?;
    validate_completion_view_contract(view).map_err(canonical)
}

pub(crate) fn insert_router_message(
    connection: &mut Connection,
    request: &RouterMessageWrite,
) -> Result<(), StoreError> {
    validate_router_message(request)?;
    let transaction = immediate(connection)?;
    insert_router_message_row(&transaction, request)?;
    transaction.commit()?;
    Ok(())
}

fn insert_router_message_row(
    connection: &Connection,
    request: &RouterMessageWrite,
) -> Result<(), StoreError> {
    let ordinal: i64 = connection.query_row(
        "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM router_messages",
        [],
        |row| row.get(0),
    )?;
    connection.execute(
        "INSERT INTO router_messages (message_id, ordinal, role, body, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            request.message_id,
            ordinal,
            request.role,
            request.body,
            request.created_at
        ],
    )?;
    Ok(())
}

pub(crate) fn validate_message_submission(
    request: &MessageSubmissionWrite,
) -> Result<(), StoreError> {
    require_text("operation_id", &request.operation_id)?;
    require_prose("submission_text", &request.text)?;
    validate_router_message(&request.message)?;
    if request.message.role != "user" || request.message.body != request.text {
        return Err(StoreError::InvalidRequest {
            message: "submission owner row must match text".to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn lookup_message_submission(
    connection: &Connection,
    operation_id: &str,
    text: &str,
) -> Result<MessageSubmissionState, StoreError> {
    require_text("operation_id", operation_id)?;
    require_prose("submission_text", text)?;
    lookup_message_submission_in(connection, operation_id, text)
}

fn lookup_message_submission_in(
    connection: &Connection,
    operation_id: &str,
    text: &str,
) -> Result<MessageSubmissionState, StoreError> {
    let stored = connection
        .query_row(
            "SELECT text, message_id, state, outcome_kind, outcome_detail \
             FROM message_submissions WHERE operation_id = ?1",
            params![operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    read_outcome_field(row, 3)?,
                    read_outcome_field(row, 4)?,
                ))
            },
        )
        .optional()?;
    let Some((stored_text, message_id, state, kind, detail)) = stored else {
        return Ok(MessageSubmissionState::Missing);
    };
    if stored_text != text {
        return Err(StoreError::IdempotencyConflict {
            key: operation_id.to_owned(),
        });
    }
    match state.as_str() {
        "pending"
            if matches!(kind, RawOutcomeField::Null) && matches!(detail, RawOutcomeField::Null) =>
        {
            Ok(MessageSubmissionState::Pending { message_id })
        }
        "terminal" => Ok(MessageSubmissionState::Terminal {
            message_id,
            outcome: decode_submission_outcome(kind, detail),
        }),
        _ => Err(StoreError::InvalidRequest {
            message: "stored submission state is invalid".to_owned(),
        }),
    }
}

pub(crate) fn begin_message_submission(
    connection: &mut Connection,
    request: &MessageSubmissionWrite,
) -> Result<MessageSubmissionState, StoreError> {
    validate_message_submission(request)?;
    let transaction = immediate(connection)?;
    match lookup_message_submission_in(&transaction, &request.operation_id, &request.text)? {
        MessageSubmissionState::Missing => {}
        MessageSubmissionState::Pending { message_id } => {
            transaction.commit()?;
            return Ok(MessageSubmissionState::Pending { message_id });
        }
        MessageSubmissionState::Terminal {
            message_id,
            outcome,
        } => {
            transaction.commit()?;
            return Ok(MessageSubmissionState::Terminal {
                message_id,
                outcome,
            });
        }
        MessageSubmissionState::New { .. } => {
            return Err(StoreError::InvalidRequest {
                message: "stored submission cannot be new".to_owned(),
            });
        }
    }
    insert_router_message_row(&transaction, &request.message)?;
    transaction.execute(
        "INSERT INTO message_submissions \
         (operation_id, text, message_id, state, outcome_kind, outcome_detail, created_at) \
         VALUES (?1, ?2, ?3, 'pending', NULL, NULL, ?4)",
        params![
            request.operation_id,
            request.text,
            request.message.message_id,
            request.message.created_at
        ],
    )?;
    transaction.commit()?;
    Ok(MessageSubmissionState::New {
        message_id: request.message.message_id.clone(),
    })
}

pub(crate) fn finish_message_submission(
    connection: &mut Connection,
    operation_id: &str,
    outcome: &StoredSubmissionOutcome,
) -> Result<(), StoreError> {
    require_text("operation_id", operation_id)?;
    let (kind, detail) = encode_submission_outcome(outcome);
    let transaction = immediate(connection)?;
    let stored = transaction
        .query_row(
            "SELECT state, outcome_kind, outcome_detail FROM message_submissions \
             WHERE operation_id = ?1",
            params![operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    read_outcome_field(row, 1)?,
                    read_outcome_field(row, 2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "message_submission",
            id: operation_id.to_owned(),
        })?;
    if stored.0 == "terminal" {
        let existing = decode_submission_outcome(stored.1, stored.2);
        if existing == *outcome {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: operation_id.to_owned(),
        });
    }
    if stored.0 != "pending" {
        return Err(StoreError::InvalidRequest {
            message: "stored submission state is invalid".to_owned(),
        });
    }
    transaction.execute(
        "UPDATE message_submissions SET state = 'terminal', outcome_kind = ?2, \
         outcome_detail = ?3 WHERE operation_id = ?1",
        params![operation_id, kind, detail],
    )?;
    transaction.commit()?;
    Ok(())
}

fn encode_submission_outcome(outcome: &StoredSubmissionOutcome) -> (&'static str, Option<&str>) {
    match outcome {
        StoredSubmissionOutcome::Routed { route } => ("routed", Some(route)),
        StoredSubmissionOutcome::RoutingFailed { reason } => ("routing_failed", Some(reason)),
        StoredSubmissionOutcome::ProcessingFailed => ("processing_failed", None),
        StoredSubmissionOutcome::Unknown => ("unknown_outcome", None),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RawOutcomeField {
    Null,
    Text(String),
    Opaque,
}

fn read_outcome_field(row: &Row<'_>, index: usize) -> rusqlite::Result<RawOutcomeField> {
    Ok(match row.get_ref(index)? {
        ValueRef::Null => RawOutcomeField::Null,
        ValueRef::Text(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => RawOutcomeField::Text(text.to_owned()),
            Err(_) => RawOutcomeField::Opaque,
        },
        ValueRef::Integer(_) | ValueRef::Real(_) | ValueRef::Blob(_) => RawOutcomeField::Opaque,
    })
}

fn decode_submission_outcome(
    kind: RawOutcomeField,
    detail: RawOutcomeField,
) -> StoredSubmissionOutcome {
    match (kind, detail) {
        (RawOutcomeField::Text(kind), RawOutcomeField::Text(route))
            if kind == "routed" && matches!(route.as_str(), "admit" | "ask" | "refuse") =>
        {
            StoredSubmissionOutcome::Routed { route }
        }
        (RawOutcomeField::Text(kind), RawOutcomeField::Text(reason))
            if kind == "routing_failed"
                && matches!(
                    reason.as_str(),
                    "model_provider_unavailable" | "route_unreadable"
                ) =>
        {
            StoredSubmissionOutcome::RoutingFailed { reason }
        }
        (RawOutcomeField::Text(kind), RawOutcomeField::Null) if kind == "processing_failed" => {
            StoredSubmissionOutcome::ProcessingFailed
        }
        _ => StoredSubmissionOutcome::Unknown,
    }
}

pub(crate) fn next_message_sequence(connection: &Connection) -> Result<u64, StoreError> {
    let mut statement = connection.prepare(
        "SELECT message_id FROM router_messages \
         UNION ALL SELECT message_id FROM task_inputs \
         UNION ALL SELECT message_id FROM negative_marks",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut latest = 0_u64;
    for row in rows {
        let message_id = row?;
        let Some(sequence) = message_id
            .strip_prefix("m-")
            .and_then(|suffix| suffix.parse::<u64>().ok())
        else {
            continue;
        };
        latest = latest.max(sequence);
    }
    latest
        .checked_add(1)
        .ok_or_else(|| StoreError::InvalidRequest {
            message: "message id sequence overflow".to_owned(),
        })
}

pub(crate) fn runtime_snapshot(connection: &Connection) -> Result<RuntimeSnapshot, StoreError> {
    validate_runtime_references(connection)?;
    let router_messages = load_runtime_messages(connection)?;
    let tasks = load_runtime_tasks(connection)?;
    let children = load_runtime_children(connection)?;
    let id_seeds = runtime_id_seeds(connection)?;
    Ok(RuntimeSnapshot {
        router_messages,
        tasks,
        children,
        id_seeds,
    })
}

fn load_runtime_messages(connection: &Connection) -> Result<Vec<RuntimeMessage>, StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT m.message_id, m.role, m.body, COALESCE(b.bot_id, 'maia') \
             FROM router_messages m \
             LEFT JOIN message_bots b ON b.message_id = m.message_id \
             ORDER BY m.ordinal",
        )?;
    let mapped = statement.query_map([], |row| {
        Ok(RuntimeMessage {
            message_id: row.get(0)?,
            role: row.get(1)?,
            body: row.get(2)?,
            bot_id: row.get(3)?,
        })
    })?;
    let mut messages = Vec::new();
    for message in mapped {
        messages.push(message?);
    }
    Ok(messages)
}

fn validate_runtime_references(connection: &Connection) -> Result<(), StoreError> {
    let orphan_queries = [
        "SELECT 1 FROM task_attempts a LEFT JOIN task_sessions t ON t.task_id = a.task_id \
         WHERE t.task_id IS NULL LIMIT 1",
        "SELECT 1 FROM task_envelopes e LEFT JOIN task_sessions t ON t.task_id = e.task_id \
         WHERE t.task_id IS NULL LIMIT 1",
        "SELECT 1 FROM task_inputs i LEFT JOIN task_sessions t ON t.task_id = i.task_id \
         WHERE t.task_id IS NULL LIMIT 1",
        "SELECT 1 FROM task_criteria c LEFT JOIN task_sessions t ON t.task_id = c.task_id \
         WHERE t.task_id IS NULL LIMIT 1",
        "SELECT 1 FROM task_reports r LEFT JOIN task_sessions t ON t.task_id = r.task_id \
         WHERE t.task_id IS NULL LIMIT 1",
        "SELECT 1 FROM task_evidence e LEFT JOIN task_sessions t ON t.task_id = e.task_id \
         WHERE t.task_id IS NULL LIMIT 1",
        "SELECT 1 FROM context_snapshots c LEFT JOIN task_envelopes e \
         ON e.snapshot_id = c.snapshot_id WHERE e.snapshot_id IS NULL LIMIT 1",
        "SELECT 1 FROM child_assignments c LEFT JOIN task_sessions t \
         ON t.task_id = c.parent_task_id LEFT JOIN child_assignments p \
         ON p.child_id = c.parent_task_id \
         WHERE t.task_id IS NULL AND p.child_id IS NULL LIMIT 1",
    ];
    for sql in orphan_queries {
        if connection
            .query_row(sql, [], |_| Ok(()))
            .optional()?
            .is_some()
        {
            return Err(StoreError::InvalidRequest {
                message: "runtime snapshot contains an orphan row".to_owned(),
            });
        }
    }
    Ok(())
}

fn load_runtime_tasks(connection: &Connection) -> Result<Vec<RuntimeTask>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT task_id, phase, title, pinned, completion_view, prior_task_id, created_at \
         FROM task_sessions \
         WHERE title NOT LIKE '[archived:%' \
         ORDER BY created_at, task_id",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, i64>(6)?,
        ))
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    drop(statement);
    rows.into_iter()
        .map(
            |(task_id, phase, title, pin, completion_view, prior_task_id, created_at)| {
                Ok(RuntimeTask {
                    envelope: load_runtime_envelope(connection, &task_id)?,
                    inputs: load_runtime_inputs(connection, &task_id)?,
                    attempts: load_runtime_attempts(connection, &task_id)?,
                    criteria: load_criteria(connection, &task_id)?,
                    reports: load_runtime_reports(connection, &task_id)?,
                    evidence: load_runtime_evidence(connection, &task_id)?,
                    task_id,
                    phase,
                    title,
                    pin,
                    completion_view,
                    prior_task_id,
                    created_at,
                })
            },
        )
        .collect()
}

fn load_runtime_envelope(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<RuntimeEnvelope>, StoreError> {
    let stored = connection
        .query_row(
            "SELECT prompt, brief, routing_reason, snapshot_id \
             FROM task_envelopes WHERE task_id = ?1",
            params![task_id],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((prompt, brief, routing_reason, snapshot_id)) = stored else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT ordinal, memory_id, provenance, trust, sentence FROM context_snapshots \
         WHERE snapshot_id = ?1 ORDER BY ordinal",
    )?;
    let mapped = statement.query_map(params![snapshot_id], |row| {
        Ok(RuntimeContextItem {
            ordinal: row.get(0)?,
            memory_id: row.get(1)?,
            provenance: row.get(2)?,
            trust: row.get(3)?,
            sentence: row.get(4)?,
        })
    })?;
    let mut context = Vec::new();
    for item in mapped {
        context.push(item?);
    }
    Ok(Some(RuntimeEnvelope {
        prompt,
        brief,
        routing_reason,
        snapshot_id,
        context,
    }))
}

fn load_runtime_inputs(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<RuntimeInput>, StoreError> {
    let mut statement = connection
        .prepare("SELECT message_id, prompt FROM task_inputs WHERE task_id = ?1 ORDER BY rowid")?;
    let mapped = statement.query_map(params![task_id], |row| {
        Ok(RuntimeInput {
            message_id: row.get(0)?,
            prompt: row.get(1)?,
        })
    })?;
    let mut inputs = Vec::new();
    for input in mapped {
        inputs.push(input?);
    }
    Ok(inputs)
}

fn load_runtime_attempts(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<RuntimeAttempt>, StoreError> {
    let mut statement = connection
        .prepare("SELECT attempt_id, state FROM task_attempts WHERE task_id = ?1 ORDER BY rowid")?;
    let mapped = statement.query_map(params![task_id], |row| {
        Ok(RuntimeAttempt {
            attempt_id: row.get(0)?,
            state: row.get(1)?,
        })
    })?;
    let mut attempts = Vec::new();
    for attempt in mapped {
        attempts.push(attempt?);
    }
    Ok(attempts)
}

fn load_runtime_reports(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<RuntimeReport>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT report_id, attempt_id, kind, summary, created_at, call_id \
         FROM task_reports WHERE task_id = ?1 ORDER BY created_at, report_id",
    )?;
    let mapped = statement.query_map(params![task_id], |row| {
        Ok(RuntimeReport {
            report_id: row.get(0)?,
            attempt_id: row.get(1)?,
            kind: row.get(2)?,
            summary: row.get(3)?,
            created_at: row.get(4)?,
            call_id: row.get(5)?,
        })
    })?;
    let mut reports = Vec::new();
    for report in mapped {
        reports.push(report?);
    }
    Ok(reports)
}

fn load_runtime_evidence(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<RuntimeEvidence>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT evidence_id, attempt_id, body FROM task_evidence \
         WHERE task_id = ?1 ORDER BY evidence_id",
    )?;
    let mapped = statement.query_map(params![task_id], |row| {
        Ok(RuntimeEvidence {
            evidence_id: row.get(0)?,
            attempt_id: row.get(1)?,
            body: row.get(2)?,
        })
    })?;
    let mut evidence = Vec::new();
    for item in mapped {
        evidence.push(item?);
    }
    Ok(evidence)
}

fn load_runtime_children(connection: &Connection) -> Result<Vec<RuntimeChild>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT child_id, parent_task_id, depth, subgoal, budget_tokens, budget_turns, phase \
         FROM child_assignments ORDER BY child_id",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok(RuntimeChild {
            child_id: row.get(0)?,
            parent_task_id: row.get(1)?,
            depth: row.get(2)?,
            subgoal: row.get(3)?,
            budget_tokens: row.get(4)?,
            budget_turns: row.get(5)?,
            phase: row.get(6)?,
        })
    })?;
    let mut children = Vec::new();
    for child in mapped {
        children.push(child?);
    }
    Ok(children)
}

fn runtime_id_seeds(connection: &Connection) -> Result<RuntimeIdSeeds, StoreError> {
    let phases = load_text_column(
        connection,
        "SELECT phase FROM task_sessions UNION ALL SELECT phase FROM child_assignments",
    )?;
    let task_ids = load_text_column(connection, "SELECT task_id FROM task_sessions")?;
    let message = next_message_sequence(connection)?;
    let task = next_prefixed_id("task-", task_ids.iter().map(String::as_str))?;
    let mut seeds = RuntimeIdSeeds {
        message,
        task,
        attempt: next_prefixed_query(connection, "attempt-", "SELECT attempt_id FROM task_attempts")?,
        envelope: 1,
        report: next_prefixed_query(connection, "report-", "SELECT report_id FROM task_reports")?,
        call: next_prefixed_query(
            connection,
            "call-",
            "SELECT call_id FROM task_reports WHERE call_id <> ''",
        )?,
        evidence: next_prefixed_query(
            connection,
            "evidence-",
            "SELECT evidence_id FROM task_evidence",
        )?,
        snapshot: next_prefixed_query(
            connection,
            "snap-",
            "SELECT snapshot_id FROM task_envelopes",
        )?,
        criterion: next_prefixed_query(
            connection,
            "criterion-",
            "SELECT criterion_id FROM task_criteria",
        )?,
        request: 1,
        child: next_prefixed_query(
            connection,
            "child-",
            "SELECT child_id FROM child_assignments",
        )?,
        detail: next_prefixed_id(
            "detail-",
            load_text_column(
                connection,
                "SELECT completion_view FROM task_sessions WHERE completion_view LIKE 'open:detail-%'",
            )?
            .iter()
            .filter_map(|view| view.strip_prefix("open:")),
        )?,
        decision: next_prefixed_id(
            "decision-",
            phases
                .iter()
                .filter_map(|phase| phase.strip_prefix("abandoned:")),
        )?,
        command: next_prefixed_id(
            "",
            phases.iter().filter_map(|phase| {
                phase
                    .strip_prefix("cancelled:")
                    .or_else(|| phase.strip_prefix("stopped:"))
            }),
        )?,
    };
    for contract in runtime_id_contracts() {
        let derived = seeds.value(contract.namespace);
        seeds.set(
            contract.namespace,
            next_with_high_water(connection, contract.key, derived)?,
        );
    }
    Ok(seeds)
}

pub(crate) fn reserve_runtime_id_block(
    connection: &mut Connection,
    count: u64,
) -> Result<RuntimeIdBlock, StoreError> {
    if count == 0 {
        return Err(StoreError::InvalidRequest {
            message: "runtime id reservation must not be empty".to_owned(),
        });
    }
    let transaction = immediate(connection)?;
    let first = runtime_id_seeds(&transaction)?;
    for contract in runtime_id_contracts() {
        let consumed = first
            .value(contract.namespace)
            .checked_add(count - 1)
            .ok_or_else(|| StoreError::InvalidRequest {
                message: format!("{} id reservation overflow", contract.key),
            })?;
        let updated = transaction.execute(
            "UPDATE runtime_id_high_water SET value = ?2 WHERE namespace = ?1",
            params![contract.key, consumed.to_string()],
        )?;
        if updated != 1 {
            return Err(StoreError::InvalidRequest {
                message: format!("{} id registry row is missing", contract.key),
            });
        }
    }
    transaction.commit()?;
    Ok(RuntimeIdBlock::new(first, count))
}

fn next_with_high_water(
    connection: &Connection,
    namespace: &str,
    derived_next: u64,
) -> Result<u64, StoreError> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM runtime_id_high_water WHERE namespace = ?1",
            params![namespace],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored) = stored else {
        return Ok(derived_next);
    };
    let consumed = stored
        .parse::<u64>()
        .map_err(|_| StoreError::InvalidRequest {
            message: "runtime id high-water mark is invalid".to_owned(),
        })?;
    let high_water_next = consumed
        .checked_add(1)
        .ok_or_else(|| StoreError::InvalidRequest {
            message: "runtime id high-water mark overflow".to_owned(),
        })?;
    Ok(derived_next.max(high_water_next))
}

fn next_prefixed_query(
    connection: &Connection,
    prefix: &str,
    sql: &str,
) -> Result<u64, StoreError> {
    let values = load_text_column(connection, sql)?;
    next_prefixed_id(prefix, values.iter().map(String::as_str))
}

fn load_text_column(connection: &Connection, sql: &str) -> Result<Vec<String>, StoreError> {
    let mut statement = connection.prepare(sql)?;
    let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut values = Vec::new();
    for value in mapped {
        values.push(value?);
    }
    Ok(values)
}

fn next_prefixed_id<'a>(
    prefix: &str,
    values: impl Iterator<Item = &'a str>,
) -> Result<u64, StoreError> {
    let mut latest = 0_u64;
    for value in values {
        let Some(sequence) = prefixed_sequence(value, prefix) else {
            continue;
        };
        latest = latest.max(sequence);
    }
    latest
        .checked_add(1)
        .ok_or_else(|| StoreError::InvalidRequest {
            message: format!("{prefix} id sequence overflow"),
        })
}

fn prefixed_sequence(value: &str, prefix: &str) -> Option<u64> {
    value.strip_prefix(prefix)?.parse::<u64>().ok()
}

pub(crate) fn insert_task(
    connection: &mut Connection,
    request: &TaskWrite,
) -> Result<(), StoreError> {
    validate_task(request)?;
    let transaction = immediate(connection)?;
    insert_task_rows(&transaction, request)?;
    transaction.commit()?;
    Ok(())
}

fn insert_task_rows(connection: &Connection, request: &TaskWrite) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO task_sessions (task_id, phase, title, pinned, completion_view, prior_task_id, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            request.task_id,
            request.phase,
            request.title,
            request.pin,
            request.completion_view,
            request.prior_task_id,
            request.created_at
        ],
    )?;
    connection.execute(
        "INSERT INTO task_attempts (task_id, attempt_id, state) VALUES (?1, ?2, ?3)",
        params![request.task_id, request.attempt_id, request.attempt_state],
    )?;
    Ok(())
}

pub(crate) fn insert_task_aggregate(
    connection: &mut Connection,
    request: &TaskAggregateWrite,
) -> Result<(), StoreError> {
    validate_task_aggregate(request)?;
    let transaction = immediate(connection)?;
    validate_task_aggregate_sources(&transaction, request)?;
    insert_task_rows(&transaction, &request.task)?;
    insert_envelope_row(&transaction, &request.envelope)?;
    insert_snapshot_rows(
        &transaction,
        &request.envelope.snapshot_id,
        &request.snapshot_items,
    )?;
    for criterion in &request.criteria {
        insert_criterion_row(&transaction, criterion)?;
    }
    transaction.commit()?;
    Ok(())
}

fn validate_task_aggregate_sources(
    connection: &Connection,
    request: &TaskAggregateWrite,
) -> Result<(), StoreError> {
    let mut prompt_source_matches = false;
    for criterion in &request.criteria {
        let source = load_criterion_source(connection, criterion)?;
        validate_criterion_source(criterion, source.as_deref())?;
        if criterion.source_kind == "user_text"
            && source.as_deref() == Some(request.envelope.prompt.as_slice())
        {
            prompt_source_matches = true;
        }
    }
    if !prompt_source_matches {
        return Err(StoreError::InvalidRequest {
            message: "task prompt source is not canonical".to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn validate_task_aggregate(request: &TaskAggregateWrite) -> Result<(), StoreError> {
    validate_task(&request.task)?;
    validate_envelope(&request.envelope)?;
    validate_snapshot(&request.envelope.snapshot_id, &request.snapshot_items)?;
    if request.task.task_id != request.envelope.task_id {
        return Err(StoreError::InvalidRequest {
            message: "task aggregate ids must match".to_owned(),
        });
    }
    for criterion in &request.criteria {
        validate_criterion(criterion)?;
        if criterion.task_id != request.task.task_id {
            return Err(StoreError::InvalidRequest {
                message: "task aggregate criterion id must match".to_owned(),
            });
        }
    }
    Ok(())
}

fn insert_envelope_row(
    connection: &Connection,
    request: &TaskEnvelopeWrite,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO task_envelopes (task_id, prompt, brief, routing_reason, snapshot_id) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            request.task_id,
            request.prompt,
            request.brief,
            request.routing_reason,
            request.snapshot_id
        ],
    )?;
    Ok(())
}

fn insert_snapshot_rows(
    connection: &Connection,
    snapshot_id: &str,
    items: &[SnapshotItemWrite],
) -> Result<(), StoreError> {
    for (ordinal, item) in items.iter().enumerate() {
        let ordinal = i64::try_from(ordinal).map_err(|_| StoreError::InvalidRequest {
            message: "snapshot ordinal overflow".to_owned(),
        })?;
        connection.execute(
            "INSERT INTO context_snapshots \
             (snapshot_id, ordinal, memory_id, provenance, trust, sentence) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                snapshot_id,
                ordinal,
                item.memory_id,
                item.provenance,
                item.trust,
                item.sentence
            ],
        )?;
    }
    Ok(())
}

fn insert_criterion_row(
    connection: &Connection,
    request: &TaskCriterionWrite,
) -> Result<(), StoreError> {
    let ordinal: i64 = connection.query_row(
        "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM task_criteria WHERE task_id = ?1",
        params![request.task_id],
        |row| row.get(0),
    )?;
    connection.execute(
        "INSERT INTO task_criteria \
         (criterion_id, task_id, source_kind, source_ref, span_start, span_end, text, ordinal) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            request.criterion_id,
            request.task_id,
            request.source_kind,
            request.source_ref,
            request.span_start,
            request.span_end,
            request.text,
            ordinal
        ],
    )?;
    Ok(())
}

pub(crate) fn insert_task_envelope(
    connection: &mut Connection,
    request: &TaskEnvelopeWrite,
) -> Result<(), StoreError> {
    validate_envelope(request)?;
    let transaction = immediate(connection)?;
    let existing: Option<Vec<u8>> = transaction
        .query_row(
            "SELECT prompt FROM task_envelopes WHERE task_id = ?1",
            params![request.task_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(stored) = existing {
        if stored == request.prompt {
            let stored_brief: String = transaction.query_row(
                "SELECT brief FROM task_envelopes WHERE task_id = ?1",
                params![request.task_id],
                |row| row.get(0),
            )?;
            let stored_reason: String = transaction.query_row(
                "SELECT routing_reason FROM task_envelopes WHERE task_id = ?1",
                params![request.task_id],
                |row| row.get(0),
            )?;
            let stored_snapshot: String = transaction.query_row(
                "SELECT snapshot_id FROM task_envelopes WHERE task_id = ?1",
                params![request.task_id],
                |row| row.get(0),
            )?;
            if stored_brief == request.brief
                && stored_reason == request.routing_reason
                && stored_snapshot == request.snapshot_id
            {
                transaction.commit()?;
                return Ok(());
            }
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.task_id.clone(),
        });
    }
    insert_envelope_row(&transaction, request)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn load_prompt(connection: &Connection, task_id: &str) -> Result<Vec<u8>, StoreError> {
    require_text("task_id", task_id)?;
    connection
        .query_row(
            "SELECT prompt FROM task_envelopes WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "task_envelope",
            id: task_id.to_owned(),
        })
}

pub(crate) fn validate_attempt(request: &TaskAttemptWrite) -> Result<(), StoreError> {
    require_text("task_id", &request.task_id)?;
    require_text("attempt_id", &request.attempt_id)?;
    require_text("attempt_state", &request.state)?;
    require_prose("attempt_state", &request.state)?;
    if request.state != "active" {
        return Err(StoreError::InvalidRequest {
            message: "attempt state is not canonical".to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn insert_context_snapshot(
    connection: &mut Connection,
    snapshot_id: &str,
    items: &[SnapshotItemWrite],
) -> Result<(), StoreError> {
    validate_snapshot(snapshot_id, items)?;
    let transaction = immediate(connection)?;
    let mut statement = transaction.prepare(
        "SELECT memory_id, provenance, trust, sentence FROM context_snapshots \
         WHERE snapshot_id = ?1 ORDER BY ordinal",
    )?;
    let mapped = statement.query_map(params![snapshot_id], |row| {
        Ok(SnapshotItemWrite {
            memory_id: row.get(0)?,
            provenance: row.get(1)?,
            trust: row.get(2)?,
            sentence: row.get(3)?,
        })
    })?;
    let mut stored = Vec::new();
    for item in mapped {
        stored.push(item?);
    }
    drop(statement);
    if !stored.is_empty() {
        if stored == items {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: snapshot_id.to_owned(),
        });
    }
    insert_snapshot_rows(&transaction, snapshot_id, items)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn insert_task_criterion(
    connection: &mut Connection,
    request: &TaskCriterionWrite,
) -> Result<(), StoreError> {
    validate_criterion(request)?;
    let transaction = immediate(connection)?;
    let task: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM task_sessions WHERE task_id = ?1",
            params![request.task_id],
            |row| row.get(0),
        )
        .optional()?;
    if task.is_none() {
        return Err(StoreError::NotFound {
            entity: "task_session",
            id: request.task_id.clone(),
        });
    }
    let source = load_criterion_source(&transaction, request)?;
    validate_criterion_source(request, source.as_deref())?;
    let existing = load_criterion_in(&transaction, &request.criterion_id)?;
    if let Some(stored) = existing {
        if stored == *request {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.criterion_id.clone(),
        });
    }
    insert_criterion_row(&transaction, request)?;
    transaction.commit()?;
    Ok(())
}

fn validate_criterion_source(
    request: &TaskCriterionWrite,
    source: Option<&[u8]>,
) -> Result<(), StoreError> {
    validate_criterion_contract(
        &request.criterion_id,
        &request.source_kind,
        &request.source_ref,
        request.span_start,
        request.span_end,
        &request.text,
        source,
    )
    .map_err(canonical)
}

fn load_criterion_source(
    connection: &Connection,
    request: &TaskCriterionWrite,
) -> Result<Option<Vec<u8>>, StoreError> {
    if request.source_kind != "user_text" {
        return Ok(None);
    }
    let input = connection
        .query_row(
            "SELECT prompt FROM task_inputs WHERE task_id = ?1 AND message_id = ?2",
            params![request.task_id, request.source_ref],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()?;
    if input.is_some() {
        return Ok(input);
    }
    connection
        .query_row(
            "SELECT body FROM router_messages WHERE message_id = ?1 AND role = 'user'",
            params![request.source_ref],
            |row| row.get::<_, String>(0).map(String::into_bytes),
        )
        .optional()
        .map_err(StoreError::from)
}

fn load_criterion_in(
    connection: &Connection,
    criterion_id: &str,
) -> Result<Option<TaskCriterionWrite>, StoreError> {
    connection
        .query_row(
            "SELECT criterion_id, task_id, source_kind, source_ref, span_start, span_end, text \
             FROM task_criteria WHERE criterion_id = ?1",
            params![criterion_id],
            |row| {
                Ok(TaskCriterionWrite {
                    criterion_id: row.get(0)?,
                    task_id: row.get(1)?,
                    source_kind: row.get(2)?,
                    source_ref: row.get(3)?,
                    span_start: row.get(4)?,
                    span_end: row.get(5)?,
                    text: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(StoreError::from)
}

pub(crate) fn load_task_view(
    connection: &Connection,
    task_id: &str,
) -> Result<TaskView, StoreError> {
    require_text("task_id", task_id)?;
    let (title, phase): (String, String) = connection
        .query_row(
            "SELECT title, phase FROM task_sessions WHERE task_id = ?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "task_session",
            id: task_id.to_owned(),
        })?;
    let brief: String = connection
        .query_row(
            "SELECT brief FROM task_envelopes WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "task_envelope",
            id: task_id.to_owned(),
        })?;
    let prompt = load_prompt(connection, task_id)?;
    Ok(TaskView {
        reports: load_reports(connection, task_id)?,
        attempts: load_attempts(connection, task_id)?,
        criteria: load_criteria(connection, task_id)?,
        artifacts: load_artifacts(connection, task_id)?,
        helpers: load_helpers(connection, task_id)?,
        task_id: task_id.to_owned(),
        title,
        phase,
        brief,
        prompt,
    })
}

pub(crate) fn list_task_views(connection: &Connection) -> Result<Vec<TaskView>, StoreError> {
    let mut statement =
        connection.prepare("SELECT task_id FROM task_sessions ORDER BY created_at, task_id")?;
    let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut task_ids = Vec::new();
    for task_id in mapped {
        task_ids.push(task_id?);
    }
    task_ids
        .iter()
        .map(|task_id| load_task_view(connection, task_id))
        .collect()
}

fn load_reports(connection: &Connection, task_id: &str) -> Result<Vec<StoredReport>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT report_id, summary, call_id FROM task_reports WHERE task_id = ?1 \
         ORDER BY created_at, report_id",
    )?;
    let mapped = statement.query_map(params![task_id], |row| {
        Ok(StoredReport {
            report_id: row.get(0)?,
            summary: row.get(1)?,
            call_id: row.get(2)?,
        })
    })?;
    let mut reports = Vec::new();
    for report in mapped {
        reports.push(report?);
    }
    Ok(reports)
}

fn load_attempts(connection: &Connection, task_id: &str) -> Result<Vec<String>, StoreError> {
    let mut statement = connection
        .prepare("SELECT attempt_id FROM task_attempts WHERE task_id = ?1 ORDER BY rowid")?;
    let mapped = statement.query_map(params![task_id], |row| row.get(0))?;
    let mut attempts = Vec::new();
    for attempt in mapped {
        attempts.push(attempt?);
    }
    Ok(attempts)
}

fn load_criteria(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<StoredCriterion>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT ordinal, criterion_id, text, source_kind, source_ref, span_start, span_end \
         FROM task_criteria WHERE task_id = ?1 ORDER BY ordinal",
    )?;
    let mapped = statement.query_map(params![task_id], |row| {
        Ok(StoredCriterion {
            ordinal: row.get(0)?,
            criterion_id: row.get(1)?,
            text: row.get(2)?,
            source_kind: row.get(3)?,
            source_ref: row.get(4)?,
            span_start: row.get(5)?,
            span_end: row.get(6)?,
        })
    })?;
    let mut criteria = Vec::new();
    for criterion in mapped {
        criteria.push(criterion?);
    }
    Ok(criteria)
}

fn load_artifacts(connection: &Connection, task_id: &str) -> Result<Vec<String>, StoreError> {
    let mut statement = connection
        .prepare("SELECT evidence_id FROM task_evidence WHERE task_id = ?1 ORDER BY evidence_id")?;
    let mapped = statement.query_map(params![task_id], |row| row.get(0))?;
    let mut artifacts = Vec::new();
    for artifact in mapped {
        artifacts.push(artifact?);
    }
    Ok(artifacts)
}

fn load_helpers(connection: &Connection, task_id: &str) -> Result<Vec<StoredHelper>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT child_id, subgoal FROM child_assignments WHERE parent_task_id = ?1 \
         ORDER BY child_id",
    )?;
    let mapped = statement.query_map(params![task_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    let mut helpers = Vec::new();
    for helper in mapped {
        let (child_id, subgoal) = helper?;
        helpers.push(StoredHelper {
            child_id,
            title: String::from_utf8(subgoal).unwrap_or_default(),
        });
    }
    Ok(helpers)
}

pub(crate) fn insert_task_attempt(
    connection: &mut Connection,
    request: &TaskAttemptWrite,
) -> Result<(), StoreError> {
    validate_attempt(request)?;
    let transaction = immediate(connection)?;
    let task: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM task_sessions WHERE task_id = ?1",
            params![request.task_id],
            |row| row.get(0),
        )
        .optional()?;
    if task.is_none() {
        return Err(StoreError::NotFound {
            entity: "task_session",
            id: request.task_id.clone(),
        });
    }
    let existing: Option<String> = transaction
        .query_row(
            "SELECT state FROM task_attempts WHERE task_id = ?1 AND attempt_id = ?2",
            params![request.task_id, request.attempt_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(state) = existing {
        if state == request.state {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.attempt_id.clone(),
        });
    }
    transaction.execute(
        "INSERT INTO task_attempts (task_id, attempt_id, state) VALUES (?1, ?2, ?3)",
        params![request.task_id, request.attempt_id, request.state],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn retry_task_phase(
    connection: &mut Connection,
    request: &TaskAttemptWrite,
    expected_phase: &str,
    next_phase: &str,
) -> Result<(), StoreError> {
    validate_attempt(request)?;
    validate_phase_value(expected_phase)?;
    validate_phase_value(next_phase)?;
    let transaction = immediate(connection)?;
    let current: String = transaction
        .query_row(
            "SELECT phase FROM task_sessions WHERE task_id = ?1",
            params![request.task_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "task_session",
            id: request.task_id.clone(),
        })?;
    if current != expected_phase {
        return Err(StoreError::IdempotencyConflict {
            key: request.task_id.clone(),
        });
    }
    let existing: Option<String> = transaction
        .query_row(
            "SELECT state FROM task_attempts WHERE task_id = ?1 AND attempt_id = ?2",
            params![request.task_id, request.attempt_id],
            |row| row.get(0),
        )
        .optional()?;
    match existing {
        Some(state) if state != request.state => {
            return Err(StoreError::IdempotencyConflict {
                key: request.attempt_id.clone(),
            });
        }
        Some(_) => {}
        None => {
            transaction.execute(
                "INSERT INTO task_attempts (task_id, attempt_id, state) VALUES (?1, ?2, ?3)",
                params![request.task_id, request.attempt_id, request.state],
            )?;
        }
    }
    transaction.execute(
        "UPDATE task_sessions SET phase = ?2 WHERE task_id = ?1",
        params![request.task_id, next_phase],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn insert_task_input(
    connection: &mut Connection,
    request: &TaskInputWrite,
) -> Result<(), StoreError> {
    validate_task_input(request)?;
    let transaction = immediate(connection)?;
    transaction.execute(
        "INSERT INTO task_inputs (task_id, message_id, prompt) VALUES (?1, ?2, ?3)",
        params![request.task_id, request.message_id, request.prompt],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn continue_task(
    connection: &mut Connection,
    request: &ContinueTaskWrite,
) -> Result<(), StoreError> {
    validate_task_id(&request.task_id)?;
    validate_phase_value(&request.expected_phase)?;
    validate_phase_value(&request.next_phase)?;
    if let Some(input) = &request.input {
        validate_task_input(input)?;
        if input.task_id != request.task_id {
            return Err(StoreError::InvalidRequest {
                message: "continuation input task must match".to_owned(),
            });
        }
    }
    let transaction = immediate(connection)?;
    let current: String = transaction
        .query_row(
            "SELECT phase FROM task_sessions WHERE task_id = ?1",
            params![request.task_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "task_session",
            id: request.task_id.clone(),
        })?;
    if current != request.expected_phase {
        return Err(StoreError::IdempotencyConflict {
            key: request.task_id.clone(),
        });
    }
    transaction.execute(
        "UPDATE task_sessions SET phase = ?2 WHERE task_id = ?1",
        params![request.task_id, request.next_phase],
    )?;
    if let Some(input) = &request.input {
        transaction.execute(
            "INSERT INTO task_inputs (task_id, message_id, prompt) VALUES (?1, ?2, ?3)",
            params![input.task_id, input.message_id, input.prompt],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn insert_report(
    connection: &mut Connection,
    request: &TaskReportWrite,
) -> Result<(), StoreError> {
    validate_report(request)?;
    let transaction = immediate(connection)?;
    transaction.execute(
        "INSERT INTO task_reports \
         (report_id, task_id, attempt_id, kind, summary, created_at, call_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            request.report_id,
            request.task_id,
            request.attempt_id,
            request.kind,
            request.summary,
            request.created_at,
            request.call_id
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn update_task_phase(
    connection: &mut Connection,
    task_id: &str,
    phase: &str,
) -> Result<(), StoreError> {
    validate_phase(task_id, phase)?;
    let transaction = immediate(connection)?;
    let updated = transaction.execute(
        "UPDATE task_sessions SET phase = ?2 WHERE task_id = ?1",
        params![task_id, phase],
    )?;
    if updated == 0 {
        return Err(StoreError::NotFound {
            entity: "task_session",
            id: task_id.to_owned(),
        });
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn load_task_phase(
    connection: &Connection,
    task_id: &str,
) -> Result<String, StoreError> {
    validate_task_id(task_id)?;
    connection
        .query_row(
            "SELECT phase FROM task_sessions WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "task_session",
            id: task_id.to_owned(),
        })
}

pub(crate) fn insert_task_evidence(
    connection: &mut Connection,
    request: &TaskEvidenceWrite,
) -> Result<(), StoreError> {
    validate_evidence(request)?;
    let transaction = immediate(connection)?;
    require_attempt(&transaction, &request.task_id, &request.attempt_id)?;
    let existing = load_evidence_in(&transaction, &request.evidence_id)?;
    if let Some(stored) = existing {
        if stored == *request {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.evidence_id.clone(),
        });
    }
    transaction.execute(
        "INSERT INTO task_evidence (evidence_id, task_id, attempt_id, body) \
         VALUES (?1, ?2, ?3, ?4)",
        params![
            request.evidence_id,
            request.task_id,
            request.attempt_id,
            request.body
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn load_task_evidence(
    connection: &Connection,
    evidence_id: &str,
) -> Result<TaskEvidenceWrite, StoreError> {
    validate_evidence_id(evidence_id)?;
    load_evidence_in(connection, evidence_id)?.ok_or_else(|| StoreError::NotFound {
        entity: "task_evidence",
        id: evidence_id.to_owned(),
    })
}

fn require_attempt(
    connection: &Connection,
    task_id: &str,
    attempt_id: &str,
) -> Result<(), StoreError> {
    let task: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM task_sessions WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?;
    if task.is_none() {
        return Err(StoreError::NotFound {
            entity: "task_session",
            id: task_id.to_owned(),
        });
    }
    let attempt: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM task_attempts WHERE task_id = ?1 AND attempt_id = ?2",
            params![task_id, attempt_id],
            |row| row.get(0),
        )
        .optional()?;
    if attempt.is_none() {
        return Err(StoreError::NotFound {
            entity: "task_attempt",
            id: attempt_id.to_owned(),
        });
    }
    Ok(())
}

fn load_evidence_in(
    connection: &Connection,
    evidence_id: &str,
) -> Result<Option<TaskEvidenceWrite>, StoreError> {
    connection
        .query_row(
            "SELECT evidence_id, task_id, attempt_id, body FROM task_evidence WHERE evidence_id = ?1",
            params![evidence_id],
            |row| {
                Ok(TaskEvidenceWrite {
                    evidence_id: row.get(0)?,
                    task_id: row.get(1)?,
                    attempt_id: row.get(2)?,
                    body: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(StoreError::from)
}

pub(crate) fn insert_child(
    connection: &mut Connection,
    request: &ChildAssignmentWrite,
) -> Result<(), StoreError> {
    validate_child(request)?;
    let transaction = immediate(connection)?;
    if !child_parent_exists(&transaction, &request.parent_task_id)? {
        return Err(StoreError::Constraint {
            message: "child parent is not a stored task or child".to_owned(),
        });
    }
    transaction.execute(
        "INSERT INTO child_assignments (child_id, parent_task_id, depth, subgoal, budget_tokens, budget_turns) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            request.child_id,
            request.parent_task_id,
            request.depth,
            request.subgoal,
            request.budget_tokens,
            request.budget_turns
        ],
    )?;
    if let Some(sequence) = prefixed_sequence(&request.child_id, "child-") {
        record_runtime_high_water(&transaction, RuntimeIdNamespace::Child, sequence)?;
    }
    transaction.commit()?;
    Ok(())
}

fn child_parent_exists(connection: &Connection, parent_id: &str) -> Result<bool, StoreError> {
    let task: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM task_sessions WHERE task_id = ?1",
            params![parent_id],
            |row| row.get(0),
        )
        .optional()?;
    if task.is_some() {
        return Ok(true);
    }
    let child: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM child_assignments WHERE child_id = ?1",
            params![parent_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(child.is_some())
}

pub(crate) fn list_child_links(connection: &Connection) -> Result<Vec<ChildLink>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT child_id, parent_task_id, phase FROM child_assignments ORDER BY child_id",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok(ChildLink {
            child_id: row.get(0)?,
            parent_task_id: row.get(1)?,
            phase: row.get(2)?,
        })
    })?;
    let mut links = Vec::new();
    for link in mapped {
        links.push(link?);
    }
    Ok(links)
}

pub(crate) fn update_child_phase(
    connection: &mut Connection,
    child_id: &str,
    phase: &str,
) -> Result<(), StoreError> {
    require_text("child_id", child_id)?;
    validate_phase_value(phase)?;
    let transaction = immediate(connection)?;
    let existing: Option<String> = transaction
        .query_row(
            "SELECT phase FROM child_assignments WHERE child_id = ?1",
            params![child_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored) = existing else {
        return Err(StoreError::NotFound {
            entity: "child_assignment",
            id: child_id.to_owned(),
        });
    };
    if stored != phase {
        transaction.execute(
            "UPDATE child_assignments SET phase = ?2 WHERE child_id = ?1",
            params![child_id, phase],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn update_child_phases(
    connection: &mut Connection,
    child_ids: &[String],
    phase: &str,
) -> Result<(), StoreError> {
    if child_ids.is_empty() {
        return Ok(());
    }
    validate_phase_value(phase)?;
    for child_id in child_ids {
        require_text("child_id", child_id)?;
    }
    let transaction = immediate(connection)?;
    for child_id in child_ids {
        let existing: Option<i64> = transaction
            .query_row(
                "SELECT 1 FROM child_assignments WHERE child_id = ?1",
                params![child_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_none() {
            return Err(StoreError::NotFound {
                entity: "child_assignment",
                id: child_id.clone(),
            });
        }
    }
    for child_id in child_ids {
        transaction.execute(
            "UPDATE child_assignments SET phase = ?2 WHERE child_id = ?1",
            params![child_id, phase],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn apply_host_mutation(
    connection: &mut Connection,
    request: &HostMutationWrite,
) -> Result<(), StoreError> {
    if request.tasks.is_empty() {
        return Err(StoreError::InvalidRequest {
            message: "host mutation has no parent task".to_owned(),
        });
    }
    for task in &request.tasks {
        validate_task_id(&task.task_id)?;
        validate_phase_value(&task.expected_phase)?;
        validate_phase_value(&task.next_phase)?;
    }
    for child in &request.children {
        require_text("child_id", &child.child_id)?;
        validate_phase_value(&child.expected_phase)?;
        validate_phase_value(&child.next_phase)?;
    }
    let transaction = immediate(connection)?;
    for task in &request.tasks {
        require_exact_phase(
            &transaction,
            "task_sessions",
            "task_id",
            &task.task_id,
            &task.expected_phase,
        )?;
    }
    for child in &request.children {
        require_exact_phase(
            &transaction,
            "child_assignments",
            "child_id",
            &child.child_id,
            &child.expected_phase,
        )?;
    }
    for child in &request.children {
        transaction.execute(
            "UPDATE child_assignments SET phase = ?2 WHERE child_id = ?1",
            params![child.child_id, child.next_phase],
        )?;
    }
    for task in &request.tasks {
        transaction.execute(
            "UPDATE task_sessions SET phase = ?2 WHERE task_id = ?1",
            params![task.task_id, task.next_phase],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn require_exact_phase(
    connection: &Connection,
    table: &'static str,
    id_column: &'static str,
    id: &str,
    expected: &str,
) -> Result<(), StoreError> {
    let sql = format!("SELECT phase FROM {table} WHERE {id_column} = ?1");
    let current: Option<String> = connection
        .query_row(&sql, params![id], |row| row.get(0))
        .optional()?;
    match current {
        Some(current) if current == expected => Ok(()),
        Some(_) => Err(StoreError::IdempotencyConflict { key: id.to_owned() }),
        None => Err(StoreError::NotFound {
            entity: table,
            id: id.to_owned(),
        }),
    }
}

pub(crate) fn set_pin(
    connection: &mut Connection,
    task_id: &str,
    pin: &str,
) -> Result<(), StoreError> {
    require_text("task_id", task_id)?;
    validate_pin(pin)?;
    let updated = connection.execute(
        "UPDATE task_sessions SET pinned = ?2 WHERE task_id = ?1",
        params![task_id, pin],
    )?;
    if updated == 0 {
        return Err(StoreError::NotFound {
            entity: "task_session",
            id: task_id.to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn set_completion_view(
    connection: &mut Connection,
    task_id: &str,
    view: &str,
) -> Result<(), StoreError> {
    require_text("task_id", task_id)?;
    validate_completion_view(view)?;
    let transaction = immediate(connection)?;
    let current: Option<String> = transaction
        .query_row(
            "SELECT completion_view FROM task_sessions WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(current) = current else {
        return Err(StoreError::NotFound {
            entity: "task_session",
            id: task_id.to_owned(),
        });
    };
    for detail in [detail_sequence(&current), detail_sequence(view)]
        .into_iter()
        .flatten()
    {
        record_runtime_high_water(&transaction, RuntimeIdNamespace::Detail, detail)?;
    }
    transaction.execute(
        "UPDATE task_sessions SET completion_view = ?2 WHERE task_id = ?1",
        params![task_id, view],
    )?;
    transaction.commit()?;
    Ok(())
}

fn detail_sequence(view: &str) -> Option<u64> {
    view.strip_prefix("open:detail-")?.parse().ok()
}

fn record_runtime_high_water(
    connection: &Connection,
    namespace: RuntimeIdNamespace,
    value: u64,
) -> Result<(), StoreError> {
    let key = namespace.key();
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM runtime_id_high_water WHERE namespace = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    let stored = stored
        .map(|text| {
            text.parse::<u64>().map_err(|_| StoreError::InvalidRequest {
                message: "runtime id high-water mark is invalid".to_owned(),
            })
        })
        .transpose()?;
    if stored.is_none_or(|stored| value > stored) {
        connection.execute(
            "INSERT INTO runtime_id_high_water (namespace, value) VALUES (?1, ?2) \
             ON CONFLICT(namespace) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
    }
    Ok(())
}

pub(crate) fn mark_legacy_threads(
    connection: &mut Connection,
    marked_at: i64,
) -> Result<(), StoreError> {
    let transaction = immediate(connection)?;
    transaction.execute(
        "INSERT OR IGNORE INTO legacy_threads (thread_id, marked_at) \
         SELECT thread_id, ?1 FROM threads",
        params![marked_at],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn legacy_thread_ids(connection: &Connection) -> Result<Vec<String>, StoreError> {
    let mut statement =
        connection.prepare("SELECT thread_id FROM legacy_threads ORDER BY thread_id")?;
    let mapped = statement.query_map([], |row| row.get(0))?;
    let mut ids = Vec::new();
    for id in mapped {
        ids.push(id?);
    }
    Ok(ids)
}

pub(crate) fn task_inspection(
    connection: &Connection,
    task_id: &str,
) -> Result<TaskInspection, StoreError> {
    require_text("task_id", task_id)?;
    let prompt = load_prompt(connection, task_id)?;
    let (pin, completion_view): (String, String) = connection
        .query_row(
            "SELECT pinned, completion_view FROM task_sessions WHERE task_id = ?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound {
            entity: "task_session",
            id: task_id.to_owned(),
        })?;
    let mut input_statement = connection
        .prepare("SELECT message_id FROM task_inputs WHERE task_id = ?1 ORDER BY message_id")?;
    let input_mapped = input_statement.query_map(params![task_id], |row| row.get(0))?;
    let mut input_message_ids = Vec::new();
    for message_id in input_mapped {
        input_message_ids.push(message_id?);
    }
    let mut report_statement = connection.prepare(
        "SELECT summary FROM task_reports WHERE task_id = ?1 ORDER BY created_at, report_id",
    )?;
    let report_mapped = report_statement.query_map(params![task_id], |row| row.get(0))?;
    let mut report_summaries = Vec::new();
    for summary in report_mapped {
        report_summaries.push(summary?);
    }
    let mut child_statement = connection.prepare(
        "SELECT child_id FROM child_assignments WHERE parent_task_id = ?1 ORDER BY child_id",
    )?;
    let child_mapped = child_statement.query_map(params![task_id], |row| row.get(0))?;
    let mut child_ids = Vec::new();
    for child_id in child_mapped {
        child_ids.push(child_id?);
    }
    Ok(TaskInspection {
        prompt,
        pin,
        completion_view,
        input_message_ids,
        report_summaries,
        child_ids,
    })
}
