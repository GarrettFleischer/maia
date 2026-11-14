//! Bot catalog, per-bot transcripts, and shared work notes.
//!
//! Messages with no bot row belong to Maia, so an existing conversation stays
//! the first bot after the migration.

use std::path::Path;

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::error::StoreError;

/// One Super Agent the owner can open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotRecord {
    /// Stable id. The migrated conversation is `maia`.
    pub bot_id: String,
    /// Name shown in the list.
    pub name: String,
    /// Avatar color.
    pub color: String,
    /// Standing instructions for this bot only.
    pub instructions: String,
    /// Pinned bots stay at the top of the list.
    pub pinned: bool,
    /// Archived bots stay in a collapsed section.
    pub archived: bool,
    /// Creation time.
    pub created_at: i64,
    /// Last catalog edit.
    pub updated_at: i64,
    /// Time of the latest transcript row, when there is one.
    pub last_message_at: Option<i64>,
    /// One-line preview of the latest message.
    pub preview: String,
    /// Replies that arrived while another bot was open.
    pub unread: i64,
    /// A task for this bot is queued or running.
    pub running: bool,
    /// Current work, such as "Working on dog-house list".
    pub status_line: String,
}

/// One stored transcript row for a bot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotTranscriptRow {
    /// Message id.
    pub message_id: String,
    /// Stored role.
    pub role: String,
    /// Stored body.
    pub body: String,
}

/// Current work other bots may recall.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkNoteRecord {
    /// Bot that owns the work.
    pub bot_id: String,
    /// Display name.
    pub name: String,
    /// Goal text.
    pub goal: String,
    /// Status line.
    pub activity: String,
}

/// Where a memory row was learned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvenanceRecord {
    /// Source bot.
    pub bot_id: String,
    /// Session or message id.
    pub session_id: String,
    /// When it was noted.
    pub noted_at: i64,
}

/// One catalog command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotRequest {
    /// List every bot.
    List,
    /// Create a bot.
    Create {
        /// Display name.
        name: String,
        /// Optional standing instructions.
        instructions: String,
        /// Injected clock.
        now: i64,
    },
    /// Rename a bot.
    Rename {
        /// Bot id.
        bot_id: String,
        /// New name.
        name: String,
        /// Injected clock.
        now: i64,
    },
    /// Replace standing instructions.
    Instructions {
        /// Bot id.
        bot_id: String,
        /// New instructions.
        instructions: String,
        /// Injected clock.
        now: i64,
    },
    /// Pin or unpin.
    Pin {
        /// Bot id.
        bot_id: String,
        /// Whether the bot stays at the top.
        pinned: bool,
        /// Injected clock.
        now: i64,
    },
    /// Archive or restore.
    Archive {
        /// Bot id.
        bot_id: String,
        /// Whether the bot is archived.
        archived: bool,
        /// Injected clock.
        now: i64,
    },
    /// Delete a bot and its transcript links.
    Delete {
        /// Bot id.
        bot_id: String,
    },
    /// Remember the last opened bot.
    Select {
        /// Bot id.
        bot_id: String,
    },
    /// Read the last opened bot.
    Selected,
    /// Read one bot.
    Get {
        /// Bot id.
        bot_id: String,
    },
    /// Attach a transcript row to a bot and refresh its preview.
    BindMessage {
        /// Message id.
        message_id: String,
        /// Bot id.
        bot_id: String,
        /// Visible preview text.
        preview: String,
        /// Injected clock.
        now: i64,
        /// Owner sends clear unread. Assistant replies can increment it.
        from_owner: bool,
    },
    /// Attach a task to the bot that started it.
    BindTask {
        /// Task id.
        task_id: String,
        /// Bot id.
        bot_id: String,
    },
    /// Bot that owns a task. Unbound tasks belong to Maia.
    TaskBot {
        /// Task id.
        task_id: String,
    },
    /// Bot that owns a message. Unbound messages belong to Maia.
    MessageBot {
        /// Message id.
        message_id: String,
    },
    /// Replace the current-work note.
    UpsertWork {
        /// Bot id.
        bot_id: String,
        /// Goal text.
        goal: String,
        /// Todo list JSON.
        todos_json: String,
        /// Status line.
        activity: String,
        /// Injected clock.
        now: i64,
    },
    /// Every bot's current work.
    WorkNotes,
    /// Tag a memory row with the bot that learned it.
    NoteProvenance {
        /// `episode` or `claim`.
        target_kind: String,
        /// Target id.
        target_id: String,
        /// Source bot.
        bot_id: String,
        /// Session or message id.
        session_id: String,
        /// Injected clock.
        noted_at: i64,
    },
    /// Copy provenance from one memory row to another.
    CopyProvenance {
        /// Source kind.
        from_kind: String,
        /// Source id.
        from_id: String,
        /// Destination kind.
        to_kind: String,
        /// Destination id.
        to_id: String,
    },
    /// Read provenance. Missing rows are empty, not an error.
    Provenance {
        /// `episode` or `claim`.
        target_kind: String,
        /// Target id.
        target_id: String,
    },
    /// Transcript rows for one bot.
    Transcript {
        /// Bot id.
        bot_id: String,
    },
}

/// Result of a catalog command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotResponse {
    /// The catalog.
    List(Vec<BotRecord>),
    /// One bot.
    Bot(BotRecord),
    /// A bot id.
    Text(String),
    /// Current work notes.
    Notes(Vec<WorkNoteRecord>),
    /// Provenance, when one was stored.
    Provenance(Option<ProvenanceRecord>),
    /// One bot's transcript.
    Transcript(Vec<BotTranscriptRow>),
    /// The command stored nothing to return.
    Empty,
}

/// Applies `request` on the owner connection.
///
/// # Errors
///
/// Returns a validation, missing-bot, or SQLite failure.
pub(crate) fn apply(
    connection: &mut Connection,
    request: &BotRequest,
) -> Result<BotResponse, StoreError> {
    match request {
        BotRequest::List => Ok(BotResponse::List(list(connection)?)),
        BotRequest::Create {
            name,
            instructions,
            now,
        } => Ok(BotResponse::Bot(create(
            connection,
            name,
            instructions,
            *now,
        )?)),
        BotRequest::Rename { bot_id, name, now } => {
            require_name(name)?;
            touch(connection, bot_id, "name = ?1", name.trim(), *now)?;
            Ok(BotResponse::Bot(get(connection, bot_id)?))
        }
        BotRequest::Instructions {
            bot_id,
            instructions,
            now,
        } => {
            require_instructions(instructions)?;
            touch(
                connection,
                bot_id,
                "instructions = ?1",
                instructions.trim(),
                *now,
            )?;
            Ok(BotResponse::Bot(get(connection, bot_id)?))
        }
        BotRequest::Pin {
            bot_id,
            pinned,
            now,
        } => {
            let flag = if *pinned { "1" } else { "0" };
            touch(connection, bot_id, "pinned = ?1", flag, *now)?;
            Ok(BotResponse::Bot(get(connection, bot_id)?))
        }
        BotRequest::Archive {
            bot_id,
            archived,
            now,
        } => {
            let flag = if *archived { "1" } else { "0" };
            touch(connection, bot_id, "archived = ?1", flag, *now)?;
            Ok(BotResponse::Bot(get(connection, bot_id)?))
        }
        BotRequest::Delete { bot_id } => {
            delete_bot(connection, bot_id)?;
            Ok(BotResponse::Empty)
        }
        BotRequest::Select { bot_id } => {
            select_bot(connection, bot_id)?;
            Ok(BotResponse::Text(bot_id.clone()))
        }
        BotRequest::Selected => Ok(BotResponse::Text(selected(connection)?)),
        BotRequest::Get { bot_id } => Ok(BotResponse::Bot(get(connection, bot_id)?)),
        BotRequest::BindMessage {
            message_id,
            bot_id,
            preview,
            now,
            from_owner,
        } => {
            bind_message(connection, message_id, bot_id, preview, *now, *from_owner)?;
            Ok(BotResponse::Empty)
        }
        BotRequest::BindTask { task_id, bot_id } => {
            bind_task(connection, task_id, bot_id)?;
            Ok(BotResponse::Empty)
        }
        BotRequest::TaskBot { task_id } => Ok(BotResponse::Text(task_bot(connection, task_id)?)),
        BotRequest::MessageBot { message_id } => {
            Ok(BotResponse::Text(message_bot(connection, message_id)?))
        }
        BotRequest::UpsertWork {
            bot_id,
            goal,
            todos_json,
            activity,
            now,
        } => {
            upsert_work(connection, bot_id, goal, todos_json, activity, *now)?;
            Ok(BotResponse::Empty)
        }
        BotRequest::WorkNotes => Ok(BotResponse::Notes(work_notes(connection)?)),
        BotRequest::NoteProvenance {
            target_kind,
            target_id,
            bot_id,
            session_id,
            noted_at,
        } => {
            note_provenance(
                connection,
                target_kind,
                target_id,
                bot_id,
                session_id,
                *noted_at,
            )?;
            Ok(BotResponse::Empty)
        }
        BotRequest::CopyProvenance {
            from_kind,
            from_id,
            to_kind,
            to_id,
        } => {
            copy_provenance(connection, from_kind, from_id, to_kind, to_id)?;
            Ok(BotResponse::Empty)
        }
        BotRequest::Provenance {
            target_kind,
            target_id,
        } => Ok(BotResponse::Provenance(provenance(
            connection,
            target_kind,
            target_id,
        )?)),
        BotRequest::Transcript { bot_id } => {
            Ok(BotResponse::Transcript(transcript(connection, bot_id)?))
        }
    }
}

/// Reads the catalog without taking the owner thread.
///
/// # Errors
///
/// Returns a SQLite failure.
pub fn load_bots(connection: &Connection) -> Result<Vec<BotRecord>, StoreError> {
    list(connection)
}

/// Reads the last opened bot without taking the owner thread.
///
/// # Errors
///
/// Returns a SQLite failure.
pub fn load_selected_bot(connection: &Connection) -> Result<String, StoreError> {
    selected(connection)
}

/// Opens `path` and reads the catalog. Used by HTTP while a model call holds the actor.
///
/// # Errors
///
/// Returns a SQLite failure.
pub fn read_bot_catalog(path: &Path) -> Result<(Vec<BotRecord>, String), StoreError> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok((list(&connection)?, selected(&connection)?))
}

const BOT_TASK_SCOPE: &str = "( \
    (SELECT bot_id FROM task_bots tb WHERE tb.task_id = t.task_id) = b.bot_id \
    OR ( \
        NOT EXISTS (SELECT 1 FROM task_bots tb WHERE tb.task_id = t.task_id) \
        AND b.bot_id = 'maia' \
        AND t.title NOT LIKE '[archived:%' \
    ) \
)";

const RUNNING_PHASES: &str =
    "(t.phase = 'queued' OR t.phase LIKE 'running:%' OR t.phase LIKE 'blocked:%')";

const WAITING_PHASES: &str = "(t.phase LIKE 'waiting:%')";

fn list(connection: &Connection) -> Result<Vec<BotRecord>, StoreError> {
    let sql = format!(
        "SELECT b.bot_id, b.name, b.color, b.instructions, b.pinned, b.archived, \
                b.created_at, b.updated_at, b.last_message_at, b.preview, b.unread, \
                COALESCE(w.activity, ''), \
                EXISTS ( \
                    SELECT 1 FROM task_sessions t \
                    WHERE {BOT_TASK_SCOPE} \
                    AND {RUNNING_PHASES} \
                ), \
                COALESCE(( \
                    SELECT t.title FROM task_sessions t \
                    WHERE {BOT_TASK_SCOPE} \
                    AND {RUNNING_PHASES} \
                    ORDER BY t.created_at DESC \
                    LIMIT 1 \
                ), ''), \
                COALESCE(( \
                    SELECT t.title FROM task_sessions t \
                    WHERE {BOT_TASK_SCOPE} \
                    AND {WAITING_PHASES} \
                    ORDER BY t.created_at DESC \
                    LIMIT 1 \
                ), '') \
         FROM bots b \
         LEFT JOIN bot_work w ON w.bot_id = b.bot_id \
         ORDER BY b.archived ASC, b.pinned DESC, COALESCE(b.last_message_at, 0) DESC, b.name COLLATE NOCASE ASC"
    );
    let mut statement = connection.prepare(&sql)?;
    let mapped = statement.query_map([], read_bot)?;
    let mut bots = Vec::new();
    for bot in mapped {
        bots.push(bot?);
    }
    Ok(bots)
}

fn read_bot(row: &rusqlite::Row<'_>) -> rusqlite::Result<BotRecord> {
    let last_message_at: Option<i64> = row.get(8)?;
    let stored_preview: String = row.get(9)?;
    let activity: String = row.get(11)?;
    let running = row.get::<_, i64>(12)? != 0;
    let running_title: String = row.get(13)?;
    let waiting_title: String = row.get(14)?;
    Ok(BotRecord {
        bot_id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        instructions: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        archived: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        last_message_at,
        preview: maia_core::bots::catalog_preview(&stored_preview, &waiting_title, 80),
        unread: row.get(10)?,
        status_line: maia_core::bots::catalog_status_line(&activity, &running_title, &waiting_title),
        running,
    })
}

fn get(connection: &Connection, bot_id: &str) -> Result<BotRecord, StoreError> {
    list(connection)?
        .into_iter()
        .find(|bot| bot.bot_id == bot_id)
        .ok_or_else(|| StoreError::NotFound {
            entity: "bot",
            id: bot_id.to_owned(),
        })
}

fn create(
    connection: &mut Connection,
    name: &str,
    instructions: &str,
    now: i64,
) -> Result<BotRecord, StoreError> {
    require_name(name)?;
    require_instructions(instructions)?;
    let name = name.trim();
    let transaction = connection.transaction()?;
    let count: i64 = transaction.query_row("SELECT COUNT(*) FROM bots", [], |row| row.get(0))?;
    let bot_id = next_bot_id(&transaction, count)?;
    let color = maia_core::bots::bot_color(usize::try_from(count).unwrap_or(0));
    transaction.execute(
        "INSERT INTO bots (bot_id, name, color, instructions, pinned, archived, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?5)",
        params![bot_id, name, color, instructions.trim(), now],
    )?;
    transaction.commit()?;
    get(connection, &bot_id)
}

fn next_bot_id(connection: &Connection, count: i64) -> Result<String, StoreError> {
    let mut n = count.saturating_add(1);
    for _ in 0..1000 {
        let candidate = format!("bot-{n}");
        let exists: i64 = connection.query_row(
            "SELECT COUNT(*) FROM bots WHERE bot_id = ?1",
            params![candidate],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Ok(candidate);
        }
        n = n.saturating_add(1);
    }
    Err(StoreError::InvalidRequest {
        message: "bot id space is exhausted".to_owned(),
    })
}

fn touch(
    connection: &Connection,
    bot_id: &str,
    assignment: &str,
    value: &str,
    now: i64,
) -> Result<(), StoreError> {
    let _ = get(connection, bot_id)?;
    let sql = format!("UPDATE bots SET {assignment}, updated_at = ?2 WHERE bot_id = ?3");
    let changed = connection.execute(&sql, params![value, now, bot_id])?;
    if changed == 0 {
        return Err(StoreError::NotFound {
            entity: "bot",
            id: bot_id.to_owned(),
        });
    }
    Ok(())
}

fn delete_bot(connection: &mut Connection, bot_id: &str) -> Result<(), StoreError> {
    let bot = get(connection, bot_id)?;
    let others: i64 = connection.query_row(
        "SELECT COUNT(*) FROM bots WHERE bot_id != ?1",
        params![bot_id],
        |row| row.get(0),
    )?;
    if others == 0 {
        return Err(StoreError::InvalidRequest {
            message: "keep at least one bot".to_owned(),
        });
    }
    let transaction = connection.transaction()?;
    let next: String = transaction.query_row(
        "SELECT bot_id FROM bots WHERE bot_id != ?1 ORDER BY pinned DESC, created_at ASC LIMIT 1",
        params![bot_id],
        |row| row.get(0),
    )?;
    transaction.execute(
        "UPDATE bot_selection SET bot_id = ?1 WHERE bot_id = ?2",
        params![next, bot_id],
    )?;
    let task_ids = string_column(
        &transaction,
        "SELECT task_id FROM task_bots WHERE bot_id = ?1",
        bot_id,
    )?;
    let mut finished = Vec::new();
    let mut unfinished = Vec::new();
    for task_id in task_ids {
        let phase: String = transaction.query_row(
            "SELECT phase FROM task_sessions WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )?;
        if task_phase_is_finished(&phase) {
            finished.push(task_id);
        } else {
            unfinished.push(task_id);
        }
    }
    archive_finished_tasks(&transaction, &bot.name, &finished)?;
    purge_tasks(&transaction, &unfinished)?;
    let message_ids = string_column(
        &transaction,
        "SELECT message_id FROM message_bots WHERE bot_id = ?1",
        bot_id,
    )?;
    for message_id in &message_ids {
        transaction.execute(
            "DELETE FROM message_submissions WHERE message_id = ?1",
            params![message_id],
        )?;
    }
    transaction.execute(
        "DELETE FROM message_bots WHERE bot_id = ?1",
        params![bot_id],
    )?;
    for message_id in &message_ids {
        remove_unpromoted_episode(&transaction, message_id)?;
        transaction.execute(
            "DELETE FROM router_turn_snapshots WHERE message_id = ?1",
            params![message_id],
        )?;
        transaction.execute(
            "DELETE FROM router_messages WHERE message_id = ?1",
            params![message_id],
        )?;
    }
    transaction.execute("DELETE FROM bot_work WHERE bot_id = ?1", params![bot_id])?;
    transaction.execute(
        "DELETE FROM memory_provenance WHERE bot_id = ?1",
        params![bot_id],
    )?;
    transaction.execute("DELETE FROM bots WHERE bot_id = ?1", params![bot_id])?;
    transaction.commit()?;
    Ok(())
}

fn task_phase_is_finished(phase: &str) -> bool {
    phase.starts_with("completed:")
        || phase.starts_with("cancelled:")
        || phase.starts_with("failed:")
        || phase.starts_with("abandoned:")
}

/// Keeps finished work as an archive that no longer depends on the bot's chat.
///
/// Softens owner-message criteria, stamps the bot name into the title, and
/// unbinds the task so it cannot fall through to Maia after the catalog row
/// is removed.
fn archive_finished_tasks(
    connection: &rusqlite::Connection,
    bot_name: &str,
    task_ids: &[String],
) -> Result<(), StoreError> {
    let soft_ref = format!("archived-bot:{bot_name}");
    for task_id in task_ids {
        let (title, phase): (String, String) = connection.query_row(
            "SELECT title, phase FROM task_sessions WHERE task_id = ?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let archived_title = if title.starts_with("[archived:") {
            title
        } else {
            format!("[archived: {bot_name}] {title}")
        };
        let next_phase = if phase.starts_with("failed:") {
            "abandoned:bot-deleted".to_owned()
        } else {
            phase
        };
        connection.execute(
            "UPDATE task_sessions \
             SET title = ?1, phase = ?2, completion_view = 'closed_once', pinned = 'unpinned' \
             WHERE task_id = ?3",
            params![archived_title, next_phase, task_id],
        )?;
        connection.execute(
            "UPDATE task_criteria \
             SET source_kind = 'accepted_decision', source_ref = ?1, \
                 span_start = NULL, span_end = NULL \
             WHERE task_id = ?2 AND source_kind = 'user_text'",
            params![soft_ref, task_id],
        )?;
        connection.execute("DELETE FROM task_bots WHERE task_id = ?1", params![task_id])?;
    }
    Ok(())
}

fn string_column(connection: &Connection, sql: &str, id: &str) -> Result<Vec<String>, StoreError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params![id], |row| row.get(0))?;
    let mut values = Vec::new();
    for row in rows {
        values.push(row?);
    }
    Ok(values)
}

/// Removes unfinished work before a bot's chat rows are deleted.
///
/// Finished tasks are archived instead. Live rows that still point at owner
/// messages would make the next boot reject the runtime snapshot.
fn purge_tasks(connection: &rusqlite::Connection, task_ids: &[String]) -> Result<(), StoreError> {
    for task_id in task_ids {
        connection.execute(
            "UPDATE task_sessions SET prior_task_id = NULL WHERE prior_task_id = ?1",
            params![task_id],
        )?;
        connection.execute(
            "UPDATE task_plans SET handoff_of = NULL WHERE handoff_of = ?1",
            params![task_id],
        )?;
        connection.execute(
            "DELETE FROM child_assignments WHERE parent_task_id = ?1",
            params![task_id],
        )?;
        connection.execute(
            "DELETE FROM pending_approvals WHERE task_id = ?1",
            params![task_id],
        )?;
        connection.execute("DELETE FROM task_bots WHERE task_id = ?1", params![task_id])?;
        connection.execute("DELETE FROM task_plans WHERE task_id = ?1", params![task_id])?;
        connection.execute(
            "DELETE FROM task_guidance WHERE task_id = ?1",
            params![task_id],
        )?;
        connection.execute(
            "DELETE FROM task_reports WHERE task_id = ?1",
            params![task_id],
        )?;
        connection.execute(
            "DELETE FROM task_evidence WHERE task_id = ?1",
            params![task_id],
        )?;
        connection.execute(
            "DELETE FROM task_criteria WHERE task_id = ?1",
            params![task_id],
        )?;
        connection.execute("DELETE FROM task_inputs WHERE task_id = ?1", params![task_id])?;
        connection.execute(
            "DELETE FROM task_attempts WHERE task_id = ?1",
            params![task_id],
        )?;
        let snapshot_ids = string_column(
            connection,
            "SELECT snapshot_id FROM task_envelopes WHERE task_id = ?1",
            task_id,
        )?;
        connection.execute(
            "DELETE FROM task_envelopes WHERE task_id = ?1",
            params![task_id],
        )?;
        for snapshot_id in snapshot_ids {
            connection.execute(
                "DELETE FROM context_snapshots WHERE snapshot_id = ?1",
                params![snapshot_id],
            )?;
        }
        connection.execute(
            "DELETE FROM task_sessions WHERE task_id = ?1",
            params![task_id],
        )?;
    }
    Ok(())
}

/// Drops a chat episode that has not become a memory yet.
fn remove_unpromoted_episode(connection: &Connection, turn_id: &str) -> Result<(), StoreError> {
    let episode_ids = string_column(
        connection,
        "SELECT episode_id FROM episodes WHERE turn_id = ?1 AND promoted_at IS NULL \
         AND NOT EXISTS (SELECT 1 FROM claims WHERE claims.episode_id = episodes.episode_id) \
         AND NOT EXISTS (SELECT 1 FROM fact_episodes WHERE fact_episodes.episode_id = episodes.episode_id)",
        turn_id,
    )?;
    for episode_id in episode_ids {
        connection.execute(
            "DELETE FROM episode_fts WHERE episode_id = ?1",
            params![episode_id],
        )?;
        connection.execute(
            "DELETE FROM episode_segments WHERE episode_id = ?1",
            params![episode_id],
        )?;
        connection.execute(
            "DELETE FROM episodes WHERE episode_id = ?1",
            params![episode_id],
        )?;
    }
    Ok(())
}

fn select_bot(connection: &Connection, bot_id: &str) -> Result<(), StoreError> {
    let _ = get(connection, bot_id)?;
    connection.execute(
        "UPDATE bot_selection SET bot_id = ?1 WHERE singleton = 1",
        params![bot_id],
    )?;
    connection.execute(
        "UPDATE bots SET unread = 0 WHERE bot_id = ?1",
        params![bot_id],
    )?;
    Ok(())
}

fn selected(connection: &Connection) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT bot_id FROM bot_selection WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StoreError::InvalidRequest {
            message: "bot selection is missing".to_owned(),
        })
}

fn bind_message(
    connection: &Connection,
    message_id: &str,
    bot_id: &str,
    preview: &str,
    now: i64,
    from_owner: bool,
) -> Result<(), StoreError> {
    let _ = get(connection, bot_id)?;
    connection.execute(
        "INSERT INTO message_bots (message_id, bot_id) VALUES (?1, ?2) \
         ON CONFLICT(message_id) DO UPDATE SET bot_id = excluded.bot_id",
        params![message_id, bot_id],
    )?;
    let preview = maia_core::bots::message_preview(preview, 80);
    let chosen = selected(connection).unwrap_or_else(|_| "maia".to_owned());
    let keep_preview = maia_core::bots::is_ephemeral_status_note(&preview);
    if keep_preview {
        if from_owner || bot_id == chosen {
            connection.execute(
                "UPDATE bots SET last_message_at = ?1, updated_at = ?1, unread = 0 \
                 WHERE bot_id = ?2",
                params![now, bot_id],
            )?;
        } else {
            connection.execute(
                "UPDATE bots SET last_message_at = ?1, updated_at = ?1, unread = unread + 1 \
                 WHERE bot_id = ?2",
                params![now, bot_id],
            )?;
        }
        return Ok(());
    }
    if from_owner || bot_id == chosen {
        connection.execute(
            "UPDATE bots SET preview = ?1, last_message_at = ?2, updated_at = ?2, unread = 0 \
             WHERE bot_id = ?3",
            params![preview, now, bot_id],
        )?;
    } else {
        connection.execute(
            "UPDATE bots SET preview = ?1, last_message_at = ?2, updated_at = ?2, unread = unread + 1 \
             WHERE bot_id = ?3",
            params![preview, now, bot_id],
        )?;
    }
    Ok(())
}

fn bind_task(connection: &Connection, task_id: &str, bot_id: &str) -> Result<(), StoreError> {
    let _ = get(connection, bot_id)?;
    connection.execute(
        "INSERT INTO task_bots (task_id, bot_id) VALUES (?1, ?2) \
         ON CONFLICT(task_id) DO UPDATE SET bot_id = excluded.bot_id",
        params![task_id, bot_id],
    )?;
    Ok(())
}

fn task_bot(connection: &Connection, task_id: &str) -> Result<String, StoreError> {
    Ok(connection
        .query_row(
            "SELECT bot_id FROM task_bots WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "maia".to_owned()))
}

fn message_bot(connection: &Connection, message_id: &str) -> Result<String, StoreError> {
    Ok(connection
        .query_row(
            "SELECT bot_id FROM message_bots WHERE message_id = ?1",
            params![message_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "maia".to_owned()))
}

fn upsert_work(
    connection: &Connection,
    bot_id: &str,
    goal: &str,
    todos_json: &str,
    activity: &str,
    now: i64,
) -> Result<(), StoreError> {
    let _ = get(connection, bot_id)?;
    connection.execute(
        "INSERT INTO bot_work (bot_id, goal, todos_json, activity, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(bot_id) DO UPDATE SET \
            goal = excluded.goal, \
            todos_json = excluded.todos_json, \
            activity = excluded.activity, \
            updated_at = excluded.updated_at",
        params![bot_id, goal, todos_json, activity, now],
    )?;
    Ok(())
}

fn work_notes(connection: &Connection) -> Result<Vec<WorkNoteRecord>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT w.bot_id, b.name, w.goal, w.activity \
         FROM bot_work w JOIN bots b ON b.bot_id = w.bot_id \
         WHERE w.goal != '' OR w.activity != '' \
         ORDER BY b.name COLLATE NOCASE ASC",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok(WorkNoteRecord {
            bot_id: row.get(0)?,
            name: row.get(1)?,
            goal: row.get(2)?,
            activity: row.get(3)?,
        })
    })?;
    let mut notes = Vec::new();
    for note in mapped {
        notes.push(note?);
    }
    Ok(notes)
}

fn note_provenance(
    connection: &Connection,
    target_kind: &str,
    target_id: &str,
    bot_id: &str,
    session_id: &str,
    noted_at: i64,
) -> Result<(), StoreError> {
    let _ = get(connection, bot_id)?;
    connection.execute(
        "INSERT INTO memory_provenance (target_kind, target_id, bot_id, session_id, noted_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(target_kind, target_id) DO UPDATE SET \
            bot_id = excluded.bot_id, \
            session_id = excluded.session_id, \
            noted_at = excluded.noted_at",
        params![target_kind, target_id, bot_id, session_id, noted_at],
    )?;
    Ok(())
}

fn copy_provenance(
    connection: &Connection,
    from_kind: &str,
    from_id: &str,
    to_kind: &str,
    to_id: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO memory_provenance (target_kind, target_id, bot_id, session_id, noted_at) \
         SELECT ?1, ?2, bot_id, session_id, noted_at FROM memory_provenance \
         WHERE target_kind = ?3 AND target_id = ?4 \
         ON CONFLICT(target_kind, target_id) DO UPDATE SET \
            bot_id = excluded.bot_id, \
            session_id = excluded.session_id, \
            noted_at = excluded.noted_at",
        params![to_kind, to_id, from_kind, from_id],
    )?;
    Ok(())
}

fn provenance(
    connection: &Connection,
    target_kind: &str,
    target_id: &str,
) -> Result<Option<ProvenanceRecord>, StoreError> {
    Ok(connection
        .query_row(
            "SELECT bot_id, session_id, noted_at FROM memory_provenance \
             WHERE target_kind = ?1 AND target_id = ?2",
            params![target_kind, target_id],
            |row| {
                Ok(ProvenanceRecord {
                    bot_id: row.get(0)?,
                    session_id: row.get(1)?,
                    noted_at: row.get(2)?,
                })
            },
        )
        .optional()?)
}

fn transcript(connection: &Connection, bot_id: &str) -> Result<Vec<BotTranscriptRow>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT m.message_id, m.role, m.body \
         FROM router_messages m \
         LEFT JOIN message_bots b ON b.message_id = m.message_id \
         WHERE COALESCE(b.bot_id, 'maia') = ?1 \
         ORDER BY m.ordinal, m.message_id",
    )?;
    let mapped = statement.query_map(params![bot_id], |row| {
        Ok(BotTranscriptRow {
            message_id: row.get(0)?,
            role: row.get(1)?,
            body: row.get(2)?,
        })
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    Ok(rows)
}

fn require_name(name: &str) -> Result<(), StoreError> {
    let trimmed = name.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > 80 {
        return Err(StoreError::InvalidRequest {
            message: "bot name is empty or too long".to_owned(),
        });
    }
    Ok(())
}

fn require_instructions(instructions: &str) -> Result<(), StoreError> {
    if instructions.chars().count() > 2000 {
        return Err(StoreError::InvalidRequest {
            message: "bot instructions are too long".to_owned(),
        });
    }
    Ok(())
}
