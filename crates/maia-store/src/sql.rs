//! Forward-only schema statements. SQLite stores this text in `sqlite_master`.

/// Migration 1 creates only the migration journal.
pub(crate) const MIGRATION_V1: &[&str] = &[
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
];

/// Migration 2 creates the durable v1 schema.
pub(crate) const MIGRATION_V2: &[&str] = &[
    "CREATE TABLE threads (thread_id TEXT PRIMARY KEY, version INTEGER NOT NULL, participants TEXT NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE thread_events (thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY (thread_id, ordinal), FOREIGN KEY (thread_id) REFERENCES threads (thread_id))",
    "CREATE TABLE episodes (episode_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, body TEXT NOT NULL, taint TEXT NOT NULL CHECK (taint IN ('trusted', 'untrusted')), reasoning TEXT, participants TEXT NOT NULL, created_at INTEGER NOT NULL, write_canonical TEXT NOT NULL, promoted_at INTEGER, promoted_model TEXT, promotion_canonical TEXT, FOREIGN KEY (thread_id) REFERENCES threads (thread_id))",
    "CREATE TABLE episode_segments (episode_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, taint TEXT NOT NULL CHECK (taint IN ('trusted', 'untrusted')), sources TEXT NOT NULL, PRIMARY KEY (episode_id, ordinal), FOREIGN KEY (episode_id) REFERENCES episodes (episode_id))",
    "CREATE VIRTUAL TABLE episode_fts USING fts5(episode_id UNINDEXED, body, tokenize='unicode61')",
    "CREATE TABLE claims (claim_id TEXT PRIMARY KEY, sentence TEXT NOT NULL, episode_id TEXT NOT NULL, taint TEXT NOT NULL CHECK (taint IN ('trusted', 'untrusted')), status TEXT NOT NULL CHECK (status IN ('provisional', 'superseded')), valid_from INTEGER NOT NULL, consolidated_by TEXT, FOREIGN KEY (episode_id) REFERENCES episodes (episode_id), FOREIGN KEY (consolidated_by) REFERENCES facts (fact_id))",
    "CREATE VIRTUAL TABLE claim_fts USING fts5(claim_id UNINDEXED, sentence, tokenize='unicode61')",
    "CREATE TABLE lexemes (lexeme_id TEXT PRIMARY KEY)",
    "CREATE TABLE edges (edge_kind TEXT NOT NULL, from_kind TEXT NOT NULL, from_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY (edge_kind, from_kind, from_id, to_kind, to_id))",
    "CREATE TABLE entities (entity_id TEXT PRIMARY KEY, slug TEXT NOT NULL, description TEXT NOT NULL, scope_kind TEXT NOT NULL CHECK (scope_kind IN ('world', 'agent')), scope_agent TEXT NOT NULL, UNIQUE (scope_kind, scope_agent, slug))",
    "CREATE TABLE entity_links (from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL, PRIMARY KEY (from_entity_id, to_entity_id), FOREIGN KEY (from_entity_id) REFERENCES entities (entity_id), FOREIGN KEY (to_entity_id) REFERENCES entities (entity_id))",
    "CREATE TABLE facts (fact_id TEXT PRIMARY KEY, sentence TEXT NOT NULL, entity_id TEXT, taint TEXT NOT NULL CHECK (taint IN ('trusted', 'untrusted')), sources TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, replacement_fact_id TEXT, merged_into TEXT, FOREIGN KEY (entity_id) REFERENCES entities (entity_id), FOREIGN KEY (replacement_fact_id) REFERENCES facts (fact_id), FOREIGN KEY (merged_into) REFERENCES facts (fact_id))",
    "CREATE TABLE fact_claims (fact_id TEXT NOT NULL, claim_id TEXT NOT NULL, PRIMARY KEY (fact_id, claim_id), FOREIGN KEY (fact_id) REFERENCES facts (fact_id), FOREIGN KEY (claim_id) REFERENCES claims (claim_id))",
    "CREATE TABLE fact_episodes (fact_id TEXT NOT NULL, episode_id TEXT NOT NULL, PRIMARY KEY (fact_id, episode_id), FOREIGN KEY (fact_id) REFERENCES facts (fact_id), FOREIGN KEY (episode_id) REFERENCES episodes (episode_id))",
    "CREATE TABLE ledgers (ledger_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, request_id TEXT NOT NULL, compiled_prefix_hash TEXT NOT NULL, applied_at INTEGER NOT NULL, canonical TEXT NOT NULL, FOREIGN KEY (thread_id) REFERENCES threads (thread_id))",
    "CREATE TABLE presentations (presentation_id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, candidate_kind TEXT NOT NULL, candidate_id TEXT NOT NULL, source TEXT NOT NULL, weight REAL NOT NULL, source_span_start INTEGER NOT NULL, source_span_end INTEGER NOT NULL, evidence_span_start INTEGER NOT NULL, evidence_span_end INTEGER NOT NULL, thread_id TEXT NOT NULL, FOREIGN KEY (ledger_id) REFERENCES ledgers (ledger_id))",
    "CREATE TABLE ledger_heat (ledger_id TEXT NOT NULL, slot_id TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY (ledger_id, slot_id), FOREIGN KEY (ledger_id) REFERENCES ledgers (ledger_id))",
    "CREATE TABLE slot_heat (thread_id TEXT NOT NULL, slot_id TEXT NOT NULL, heat REAL NOT NULL, PRIMARY KEY (thread_id, slot_id))",
    "CREATE TABLE dream_queue (dream_queue_id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, enqueued_at INTEGER NOT NULL, consumed_at INTEGER, ledger_id TEXT NOT NULL, FOREIGN KEY (ledger_id) REFERENCES ledgers (ledger_id))",
    "CREATE TABLE negative_marks (mark_id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, presentation_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL, evidence_span_start INTEGER NOT NULL, evidence_span_end INTEGER NOT NULL, occurred_at INTEGER NOT NULL, dream_queue_id TEXT NOT NULL, FOREIGN KEY (ledger_id) REFERENCES ledgers (ledger_id), FOREIGN KEY (presentation_id) REFERENCES presentations (presentation_id), FOREIGN KEY (dream_queue_id) REFERENCES dream_queue (dream_queue_id))",
    "CREATE TABLE correction_holds (target_kind TEXT NOT NULL, target_id TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (target_kind, target_id))",
    "CREATE TABLE consolidation_batches (batch_id TEXT PRIMARY KEY, canonical TEXT NOT NULL, context_taint TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE proposals (proposal_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, operation_kind TEXT NOT NULL, left_id TEXT NOT NULL, right_id TEXT NOT NULL, target_fact_id TEXT NOT NULL, batch_taint TEXT NOT NULL, created_at INTEGER NOT NULL, decision TEXT NOT NULL, FOREIGN KEY (batch_id) REFERENCES consolidation_batches (batch_id))",
    "CREATE TABLE dismissals (batch_id TEXT NOT NULL, existing_fact_id TEXT NOT NULL, episode_id TEXT NOT NULL, subject_key TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (batch_id, existing_fact_id, episode_id, subject_key), FOREIGN KEY (batch_id) REFERENCES consolidation_batches (batch_id))",
    "CREATE TABLE projections (batch_id TEXT PRIMARY KEY, progress TEXT NOT NULL CHECK (progress IN ('pending', 'complete')), created_at INTEGER NOT NULL, completed_at INTEGER, FOREIGN KEY (batch_id) REFERENCES consolidation_batches (batch_id))",
    "CREATE TABLE projection_entities (batch_id TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY (batch_id, entity_id), FOREIGN KEY (batch_id) REFERENCES projections (batch_id))",
    "CREATE TABLE projection_folders (batch_id TEXT NOT NULL, folder TEXT NOT NULL, PRIMARY KEY (batch_id, folder), FOREIGN KEY (batch_id) REFERENCES projections (batch_id))",
    "CREATE TABLE audit_events (sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, thread_id TEXT, actor_kind TEXT NOT NULL, actor_id TEXT, kind TEXT NOT NULL, cause_event_id TEXT, request_id TEXT, occurred_at INTEGER NOT NULL, payload_hash TEXT NOT NULL, previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL, canonical BLOB NOT NULL, profile TEXT NOT NULL, allowlist_entry_id TEXT)",
    "CREATE TABLE audit_checkpoints (sequence INTEGER PRIMARY KEY, event_hash TEXT NOT NULL, policy_version INTEGER NOT NULL, occurred_at INTEGER NOT NULL)",
    "CREATE TABLE audit_blobs (payload_hash TEXT PRIMARY KEY, body BLOB NOT NULL)",
    "CREATE TABLE panic_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation INTEGER NOT NULL, engaged INTEGER NOT NULL CHECK (engaged IN (0, 1)), engaged_by TEXT, engaged_at INTEGER)",
    "INSERT INTO panic_state (singleton, generation, engaged, engaged_by, engaged_at) VALUES (1, 0, 0, NULL, NULL)",
    "CREATE TABLE security_settings (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), profile TEXT NOT NULL CHECK (profile IN ('protected', 'allowlisted', 'unrestricted')), activated_at INTEGER NOT NULL, activated_by TEXT NOT NULL, confirmation_at INTEGER, confirmation_desktop_client TEXT, confirmation_presence_proof TEXT)",
    "CREATE TABLE allowlist_entries (grant_id TEXT PRIMARY KEY, capability TEXT NOT NULL, matcher_kind TEXT NOT NULL, matcher_canonical TEXT NOT NULL, agent_id TEXT, lifetime_kind TEXT NOT NULL, lifetime_at INTEGER, lifetime_generation INTEGER, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), created_at INTEGER NOT NULL, created_by TEXT NOT NULL)",
    "CREATE TABLE credential_backend_settings (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), active_backend TEXT NOT NULL CHECK (active_backend IN ('native', 'encrypted_file', 'vault_openbao')), encrypted_file_idle_timeout_ms INTEGER NOT NULL)",
    "CREATE TABLE platform_capability_snapshots (snapshot_id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, platform TEXT NOT NULL, adapter_version TEXT NOT NULL, verdict TEXT NOT NULL, kernel TEXT, landlock_abi INTEGER, probe_canonical TEXT NOT NULL)",
    "CREATE TABLE embedding_models (model_id TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, weights_sha256 TEXT NOT NULL, tokenizer_sha256 TEXT NOT NULL, query_prefix TEXT NOT NULL, document_prefix TEXT NOT NULL, recorded_at INTEGER NOT NULL)",
    "CREATE TABLE embedding_rows (target_kind TEXT NOT NULL, target_id TEXT NOT NULL, model_id TEXT NOT NULL, vec_rowid INTEGER NOT NULL, PRIMARY KEY (target_kind, target_id), UNIQUE (target_kind, vec_rowid), FOREIGN KEY (model_id) REFERENCES embedding_models (model_id))",
    "CREATE VIRTUAL TABLE episode_vec USING vec0(embedding float[384])",
    "CREATE VIRTUAL TABLE claim_vec USING vec0(embedding float[384])",
    "CREATE VIRTUAL TABLE fact_vec USING vec0(embedding float[384])",
    "CREATE UNIQUE INDEX idx_thread_events_event ON thread_events (thread_id, event_id)",
    "CREATE INDEX idx_claims_episode ON claims (episode_id)",
    "CREATE INDEX idx_claims_status ON claims (status)",
    "CREATE INDEX idx_edges_to ON edges (edge_kind, to_kind, to_id)",
    "CREATE INDEX idx_facts_entity ON facts (entity_id)",
    "CREATE INDEX idx_presentations_ledger ON presentations (ledger_id)",
    "CREATE INDEX idx_negative_marks_target ON negative_marks (target_kind, target_id)",
    "CREATE INDEX idx_projections_progress ON projections (progress)",
    "CREATE INDEX idx_audit_events_thread ON audit_events (thread_id)",
    "CREATE INDEX idx_allowlist_enabled ON allowlist_entries (enabled)",
    "CREATE INDEX idx_snapshots_observed ON platform_capability_snapshots (observed_at, snapshot_id)",
    "CREATE INDEX idx_dream_queue_open ON dream_queue (consumed_at)",
];

/// Migration 3 adds Super Agent router and task session tables beside legacy threads.
pub(crate) const MIGRATION_V3: &[&str] = &[
    "CREATE TABLE router_sessions (router_session_id TEXT PRIMARY KEY CHECK (router_session_id = 'router'), created_at INTEGER NOT NULL)",
    "INSERT INTO router_sessions (router_session_id, created_at) VALUES ('router', 0)",
    "CREATE TABLE router_messages (message_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE TABLE task_sessions (task_id TEXT PRIMARY KEY, phase TEXT NOT NULL, title TEXT NOT NULL, pinned TEXT NOT NULL, completion_view TEXT NOT NULL, prior_task_id TEXT, created_at INTEGER NOT NULL, FOREIGN KEY (prior_task_id) REFERENCES task_sessions (task_id))",
    "CREATE TABLE task_attempts (task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (task_id, attempt_id), FOREIGN KEY (task_id) REFERENCES task_sessions (task_id))",
    "CREATE TABLE task_envelopes (task_id TEXT PRIMARY KEY, prompt BLOB NOT NULL, brief TEXT NOT NULL, routing_reason TEXT NOT NULL, snapshot_id TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES task_sessions (task_id))",
    "CREATE TABLE task_inputs (task_id TEXT NOT NULL, message_id TEXT NOT NULL, prompt BLOB NOT NULL, PRIMARY KEY (task_id, message_id), FOREIGN KEY (task_id) REFERENCES task_sessions (task_id))",
    "CREATE TABLE task_criteria (criterion_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, span_start INTEGER, span_end INTEGER, text TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES task_sessions (task_id))",
    "CREATE TABLE task_evidence (evidence_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, body TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES task_sessions (task_id))",
    "CREATE TABLE task_reports (report_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, call_id TEXT NOT NULL DEFAULT '', FOREIGN KEY (task_id) REFERENCES task_sessions (task_id))",
    "CREATE TABLE child_assignments (child_id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL, depth INTEGER NOT NULL, subgoal BLOB NOT NULL, budget_tokens INTEGER NOT NULL, budget_turns INTEGER NOT NULL, phase TEXT NOT NULL DEFAULT 'queued')",
    "CREATE TABLE context_snapshots (snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, memory_id TEXT NOT NULL, provenance TEXT NOT NULL, trust TEXT NOT NULL, sentence TEXT NOT NULL, PRIMARY KEY (snapshot_id, ordinal))",
    "CREATE TABLE legacy_threads (thread_id TEXT PRIMARY KEY, marked_at INTEGER NOT NULL, FOREIGN KEY (thread_id) REFERENCES threads (thread_id))",
    "CREATE INDEX idx_task_attempts_task ON task_attempts (task_id)",
    "CREATE INDEX idx_task_inputs_task ON task_inputs (task_id)",
    "CREATE INDEX idx_task_criteria_task ON task_criteria (task_id)",
    "CREATE INDEX idx_task_evidence_task ON task_evidence (task_id)",
    "CREATE INDEX idx_task_reports_task ON task_reports (task_id, created_at)",
    "CREATE INDEX idx_child_assignments_parent ON child_assignments (parent_task_id)",
    "CREATE INDEX idx_context_snapshots_snapshot ON context_snapshots (snapshot_id, ordinal)",
    "CREATE INDEX idx_legacy_threads_marked ON legacy_threads (marked_at, thread_id)",
];

/// Migration 4 adds durable client submission idempotency beside legacy rows.
pub(crate) const MIGRATION_V4: &[&str] = &[
    "CREATE TABLE message_submissions (operation_id TEXT PRIMARY KEY, text TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('pending', 'terminal')), outcome_kind TEXT, outcome_detail TEXT, created_at INTEGER NOT NULL, FOREIGN KEY (message_id) REFERENCES router_messages (message_id), CHECK ((state = 'pending' AND outcome_kind IS NULL AND outcome_detail IS NULL) OR (state = 'terminal' AND outcome_kind IS NOT NULL)))",
    "CREATE INDEX idx_message_submissions_message ON message_submissions (message_id)",
];

/// Migration 6 stores the model endpoint. The API key stays out of this database.
pub(crate) const MIGRATION_V6: &[&str] = &[
    "CREATE TABLE model_connection (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), base_url TEXT NOT NULL, model_id TEXT NOT NULL, reasoning TEXT NOT NULL CHECK (reasoning IN ('low', 'medium', 'high')))",
];

/// Migration 7 stores one inspector snapshot for each completed router turn.
pub(crate) const MIGRATION_V7: &[&str] = &[
    "CREATE TABLE router_turn_snapshots (ordinal INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, slots_json TEXT NOT NULL, usage_json TEXT NOT NULL, recall_json TEXT NOT NULL, thinking TEXT, route TEXT, reply TEXT NOT NULL, created_at INTEGER NOT NULL)",
];

/// Migration 8 stores MCP connections, admitted hashes, guidance, and call audit rows.
pub(crate) const MIGRATION_V8: &[&str] = &[
    "CREATE TABLE mcp_connections (connection_id TEXT PRIMARY KEY, label TEXT NOT NULL, transport_kind TEXT NOT NULL CHECK (transport_kind IN ('http', 'stdio')), url TEXT, command TEXT, args_json TEXT NOT NULL DEFAULT '[]', admitted_hash TEXT, listed_canonical TEXT, listed_hash TEXT, refresh_error TEXT)",
    "CREATE TABLE mcp_secret_slots (connection_id TEXT NOT NULL, ordinal INTEGER NOT NULL, slot_kind TEXT NOT NULL CHECK (slot_kind IN ('header', 'env')), name TEXT NOT NULL, secret_ref TEXT NOT NULL, PRIMARY KEY (connection_id, ordinal), FOREIGN KEY (connection_id) REFERENCES mcp_connections (connection_id) ON DELETE CASCADE)",
    "CREATE TABLE task_guidance (task_id TEXT PRIMARY KEY, guidance TEXT NOT NULL, FOREIGN KEY (task_id) REFERENCES task_sessions (task_id))",
    "CREATE TABLE mcp_call_audit (row_id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL, wire_name TEXT NOT NULL, manifest_hash TEXT NOT NULL, exchange_class TEXT NOT NULL, result_sha256 TEXT NOT NULL)",
];

/// Migration 9 adds promotion quarantine, claim replacement links, and day stats.
pub(crate) const MIGRATION_V9: &[&str] = &[
    "ALTER TABLE episodes ADD COLUMN promotion_failures INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE episodes ADD COLUMN promotion_quarantined INTEGER NOT NULL DEFAULT 0 CHECK (promotion_quarantined IN (0, 1))",
    "ALTER TABLE claims ADD COLUMN replaced_by TEXT REFERENCES claims (claim_id)",
    "CREATE TABLE promotion_day_stats (day_key TEXT PRIMARY KEY, calls INTEGER NOT NULL, tokens INTEGER NOT NULL)",
];

/// Migration 11 adds a rebuildable neuron index, keyword search, and auto-link provenance.
///
/// Existing rows are copied into the new tables. No claim, fact, or episode is rewritten.
pub(crate) const MIGRATION_V11: &[&str] = &[
    "ALTER TABLE edges ADD COLUMN source_tag TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE edges ADD COLUMN taint TEXT NOT NULL DEFAULT 'trusted'",
    "ALTER TABLE edges ADD COLUMN span_start INTEGER",
    "ALTER TABLE edges ADD COLUMN span_end INTEGER",
    "CREATE TABLE neuron_text (kind TEXT NOT NULL, neuron_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, taint TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, aliases TEXT NOT NULL DEFAULT '', PRIMARY KEY (kind, neuron_id))",
    "CREATE VIRTUAL TABLE neuron_fts USING fts5(kind UNINDEXED, neuron_id UNINDEXED, title, body, tokenize='unicode61')",
    "CREATE TABLE pending_links (source_kind TEXT NOT NULL, source_id TEXT NOT NULL, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, target_ref TEXT NOT NULL, edge_type TEXT NOT NULL, taint TEXT NOT NULL CHECK (taint IN ('trusted', 'untrusted')), PRIMARY KEY (source_kind, source_id, span_start, target_ref))",
    "CREATE TABLE brain_md_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), exported_at INTEGER, directory TEXT NOT NULL DEFAULT '', neuron_count INTEGER NOT NULL DEFAULT 0, edge_count INTEGER NOT NULL DEFAULT 0, keyword_count INTEGER NOT NULL DEFAULT 0, vector_count INTEGER NOT NULL DEFAULT 0, graph_count INTEGER NOT NULL DEFAULT 0)",
    "INSERT INTO brain_md_state (singleton) VALUES (1)",
    "CREATE TABLE brain_md_member (kind TEXT NOT NULL, neuron_id TEXT NOT NULL, updated_at INTEGER NOT NULL, body_hash TEXT NOT NULL, PRIMARY KEY (kind, neuron_id))",
    "CREATE TRIGGER neuron_claim_ai AFTER INSERT ON claims BEGIN INSERT INTO neuron_text (kind, neuron_id, title, body, taint, updated_at, deleted_at, aliases) VALUES ('claim', new.claim_id, new.sentence, new.sentence, new.taint, new.valid_from, NULL, ''); INSERT INTO neuron_fts (kind, neuron_id, title, body) VALUES ('claim', new.claim_id, new.sentence, new.sentence); END",
    "CREATE TRIGGER neuron_claim_au AFTER UPDATE OF sentence, taint, status ON claims BEGIN UPDATE neuron_text SET title = new.sentence, body = new.sentence, taint = new.taint, updated_at = neuron_text.updated_at + 1, deleted_at = NULL WHERE kind = 'claim' AND neuron_id = new.claim_id; DELETE FROM neuron_fts WHERE kind = 'claim' AND neuron_id = old.claim_id; INSERT INTO neuron_fts (kind, neuron_id, title, body) VALUES ('claim', new.claim_id, new.sentence, new.sentence); END",
    "CREATE TRIGGER neuron_claim_ad AFTER DELETE ON claims BEGIN DELETE FROM neuron_text WHERE kind = 'claim' AND neuron_id = old.claim_id; DELETE FROM neuron_fts WHERE kind = 'claim' AND neuron_id = old.claim_id; DELETE FROM pending_links WHERE source_kind = 'claim' AND source_id = old.claim_id; END",
    "CREATE TRIGGER neuron_fact_ai AFTER INSERT ON facts BEGIN INSERT INTO neuron_text (kind, neuron_id, title, body, taint, updated_at, deleted_at, aliases) VALUES ('fact', new.fact_id, new.sentence, new.sentence, new.taint, new.valid_from, NULL, ''); INSERT INTO neuron_fts (kind, neuron_id, title, body) VALUES ('fact', new.fact_id, new.sentence, new.sentence); END",
    "CREATE TRIGGER neuron_fact_au AFTER UPDATE OF sentence, taint ON facts BEGIN UPDATE neuron_text SET title = new.sentence, body = new.sentence, taint = new.taint, updated_at = neuron_text.updated_at + 1, deleted_at = NULL WHERE kind = 'fact' AND neuron_id = new.fact_id; DELETE FROM neuron_fts WHERE kind = 'fact' AND neuron_id = old.fact_id; INSERT INTO neuron_fts (kind, neuron_id, title, body) VALUES ('fact', new.fact_id, new.sentence, new.sentence); END",
    "CREATE TRIGGER neuron_fact_ad AFTER DELETE ON facts BEGIN DELETE FROM neuron_text WHERE kind = 'fact' AND neuron_id = old.fact_id; DELETE FROM neuron_fts WHERE kind = 'fact' AND neuron_id = old.fact_id; DELETE FROM pending_links WHERE source_kind = 'fact' AND source_id = old.fact_id; END",
    "CREATE TRIGGER neuron_episode_ai AFTER INSERT ON episodes BEGIN INSERT INTO neuron_text (kind, neuron_id, title, body, taint, updated_at, deleted_at, aliases) VALUES ('episode', new.episode_id, substr(new.body, 1, 80), new.body, new.taint, new.created_at, NULL, ''); INSERT INTO neuron_fts (kind, neuron_id, title, body) VALUES ('episode', new.episode_id, substr(new.body, 1, 80), new.body); END",
    "CREATE TRIGGER neuron_episode_au AFTER UPDATE OF body, taint ON episodes BEGIN UPDATE neuron_text SET title = substr(new.body, 1, 80), body = new.body, taint = new.taint, updated_at = neuron_text.updated_at + 1, deleted_at = NULL WHERE kind = 'episode' AND neuron_id = new.episode_id; DELETE FROM neuron_fts WHERE kind = 'episode' AND neuron_id = old.episode_id; INSERT INTO neuron_fts (kind, neuron_id, title, body) VALUES ('episode', new.episode_id, substr(new.body, 1, 80), new.body); END",
    "CREATE TRIGGER neuron_episode_ad AFTER DELETE ON episodes BEGIN DELETE FROM neuron_text WHERE kind = 'episode' AND neuron_id = old.episode_id; DELETE FROM neuron_fts WHERE kind = 'episode' AND neuron_id = old.episode_id; DELETE FROM pending_links WHERE source_kind = 'episode' AND source_id = old.episode_id; END",
    "INSERT INTO neuron_text (kind, neuron_id, title, body, taint, updated_at, deleted_at, aliases) SELECT 'claim', claim_id, sentence, sentence, taint, valid_from, NULL, '' FROM claims",
    "INSERT INTO neuron_text (kind, neuron_id, title, body, taint, updated_at, deleted_at, aliases) SELECT 'fact', fact_id, sentence, sentence, taint, valid_from, NULL, '' FROM facts",
    "INSERT INTO neuron_text (kind, neuron_id, title, body, taint, updated_at, deleted_at, aliases) SELECT 'episode', episode_id, substr(body, 1, 80), body, taint, created_at, NULL, '' FROM episodes",
    "INSERT INTO neuron_fts (kind, neuron_id, title, body) SELECT kind, neuron_id, title, body FROM neuron_text",
];

/// Migration 12 rebuilds the neuron keyword index with the Porter stemmer.
///
/// Neuron text is copied into the new index. Claim, fact, and episode rows stay put.
pub(crate) const MIGRATION_V12: &[&str] = &[
    "DROP TABLE neuron_fts",
    "CREATE VIRTUAL TABLE neuron_fts USING fts5(kind UNINDEXED, neuron_id UNINDEXED, title, body, tokenize='porter unicode61 remove_diacritics 2')",
    "INSERT INTO neuron_fts (kind, neuron_id, title, body) SELECT kind, neuron_id, title, body FROM neuron_text",
];

/// Migration 13 records claim categories, hidden rows, entities, and task plans.
///
/// Existing rows stay. Junk claims and status episodes are marked hidden by code
/// after these columns exist. Nothing is deleted.
pub(crate) const MIGRATION_V13: &[&str] = &[
    "ALTER TABLE claims ADD COLUMN category TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE claims ADD COLUMN subject TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE claims ADD COLUMN confidence_millis INTEGER NOT NULL DEFAULT 700",
    "ALTER TABLE claims ADD COLUMN last_used_at INTEGER",
    "ALTER TABLE claims ADD COLUMN hidden_reason TEXT",
    "ALTER TABLE claims ADD COLUMN owner_edited INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE episodes ADD COLUMN hidden_reason TEXT",
    "ALTER TABLE entities ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'",
    "CREATE TABLE task_plans (task_id TEXT PRIMARY KEY, goal_json TEXT NOT NULL, todo_json TEXT NOT NULL, handoff_count INTEGER NOT NULL DEFAULT 0, handoff_of TEXT, FOREIGN KEY (task_id) REFERENCES task_sessions (task_id))",
];

/// Migration 10 stores approval waits, ledger reversals, and untrusted attachments.
pub(crate) const MIGRATION_V10: &[&str] = &[
    "CREATE TABLE ledger_reversals (ledger_id TEXT PRIMARY KEY, reversed_at INTEGER NOT NULL, FOREIGN KEY (ledger_id) REFERENCES ledgers (ledger_id))",
    "CREATE TABLE pending_approvals (approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('login', 'consent', 'capability')), taint TEXT NOT NULL CHECK (taint IN ('trusted', 'untrusted')), grant_text TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')), decided_at INTEGER)",
    "CREATE INDEX idx_pending_approvals_open ON pending_approvals (status, expires_at)",
    "CREATE TABLE attachments (attachment_id TEXT PRIMARY KEY, content_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, media_type TEXT NOT NULL, safe_name TEXT NOT NULL, relative_path TEXT NOT NULL, taint TEXT NOT NULL CHECK (taint = 'untrusted'), created_at INTEGER NOT NULL, message_id TEXT)",
    "CREATE INDEX idx_attachments_message ON attachments (message_id)",
    "CREATE INDEX idx_attachments_hash ON attachments (content_sha256)",
];

/// Migration 5 preserves consumed durable ID high-water marks whose owning row can be replaced.
pub(crate) const MIGRATION_V5: &[&str] = &[
    "CREATE TABLE runtime_id_high_water (namespace TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "ALTER TABLE task_criteria ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0",
    "UPDATE task_criteria SET ordinal = (SELECT COUNT(*) FROM task_criteria prior \
     WHERE prior.task_id = task_criteria.task_id AND prior.rowid < task_criteria.rowid)",
    "CREATE UNIQUE INDEX idx_task_criteria_ordinal ON task_criteria (task_id, ordinal)",
    "INSERT INTO runtime_id_high_water (namespace, value) \
     WITH legacy(value) AS (SELECT CASE WHEN \
       EXISTS (SELECT 1 FROM router_messages LIMIT 1) OR \
       EXISTS (SELECT 1 FROM task_sessions LIMIT 1) OR \
       EXISTS (SELECT 1 FROM child_assignments LIMIT 1) OR \
       EXISTS (SELECT 1 FROM negative_marks LIMIT 1) OR \
       EXISTS (SELECT 1 FROM message_submissions LIMIT 1) \
       THEN '4000000000000000000' ELSE '0' END) \
     SELECT 'message', value FROM legacy UNION ALL \
     SELECT 'task', value FROM legacy UNION ALL \
     SELECT 'attempt', value FROM legacy UNION ALL \
     SELECT 'envelope', value FROM legacy UNION ALL \
     SELECT 'report', value FROM legacy UNION ALL \
     SELECT 'call', value FROM legacy UNION ALL \
     SELECT 'evidence', value FROM legacy UNION ALL \
     SELECT 'snapshot', value FROM legacy UNION ALL \
     SELECT 'criterion', value FROM legacy UNION ALL \
     SELECT 'request', value FROM legacy UNION ALL \
     SELECT 'child', value FROM legacy UNION ALL \
     SELECT 'detail', value FROM legacy UNION ALL \
     SELECT 'decision', value FROM legacy UNION ALL \
     SELECT 'command', value FROM legacy",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(sequence) FROM (\
         SELECT CAST(SUBSTR(message_id, 3) AS INTEGER) AS sequence FROM router_messages \
           WHERE SUBSTR(message_id, 1, 2) = 'm-' AND SUBSTR(message_id, 3) <> '' \
             AND SUBSTR(message_id, 3) NOT GLOB '*[^0-9]*' \
         UNION ALL SELECT CAST(SUBSTR(message_id, 3) AS INTEGER) FROM task_inputs \
           WHERE SUBSTR(message_id, 1, 2) = 'm-' AND SUBSTR(message_id, 3) <> '' \
             AND SUBSTR(message_id, 3) NOT GLOB '*[^0-9]*' \
         UNION ALL SELECT CAST(SUBSTR(message_id, 3) AS INTEGER) FROM negative_marks \
           WHERE SUBSTR(message_id, 1, 2) = 'm-' AND SUBSTR(message_id, 3) <> '' \
             AND SUBSTR(message_id, 3) NOT GLOB '*[^0-9]*')), 0)) AS TEXT) \
     WHERE namespace = 'message'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(task_id, 6) AS INTEGER)) FROM task_sessions \
       WHERE SUBSTR(task_id, 1, 5) = 'task-' AND SUBSTR(task_id, 6) <> '' \
         AND SUBSTR(task_id, 6) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'task'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(attempt_id, 9) AS INTEGER)) FROM task_attempts \
       WHERE SUBSTR(attempt_id, 1, 8) = 'attempt-' AND SUBSTR(attempt_id, 9) <> '' \
         AND SUBSTR(attempt_id, 9) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'attempt'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(report_id, 8) AS INTEGER)) FROM task_reports \
       WHERE SUBSTR(report_id, 1, 7) = 'report-' AND SUBSTR(report_id, 8) <> '' \
         AND SUBSTR(report_id, 8) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'report'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(call_id, 6) AS INTEGER)) FROM task_reports \
       WHERE SUBSTR(call_id, 1, 5) = 'call-' AND SUBSTR(call_id, 6) <> '' \
         AND SUBSTR(call_id, 6) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'call'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(evidence_id, 10) AS INTEGER)) FROM task_evidence \
       WHERE SUBSTR(evidence_id, 1, 9) = 'evidence-' AND SUBSTR(evidence_id, 10) <> '' \
         AND SUBSTR(evidence_id, 10) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'evidence'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(snapshot_id, 6) AS INTEGER)) FROM task_envelopes \
       WHERE SUBSTR(snapshot_id, 1, 5) = 'snap-' AND SUBSTR(snapshot_id, 6) <> '' \
         AND SUBSTR(snapshot_id, 6) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'snapshot'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(criterion_id, 11) AS INTEGER)) FROM task_criteria \
       WHERE SUBSTR(criterion_id, 1, 10) = 'criterion-' AND SUBSTR(criterion_id, 11) <> '' \
         AND SUBSTR(criterion_id, 11) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'criterion'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(child_id, 7) AS INTEGER)) FROM child_assignments \
       WHERE SUBSTR(child_id, 1, 6) = 'child-' AND SUBSTR(child_id, 7) <> '' \
         AND SUBSTR(child_id, 7) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'child'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(completion_view, 13) AS INTEGER)) FROM task_sessions \
       WHERE SUBSTR(completion_view, 1, 12) = 'open:detail-' AND SUBSTR(completion_view, 13) <> '' \
         AND SUBSTR(completion_view, 13) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'detail'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(CAST(SUBSTR(phase, 20) AS INTEGER)) FROM task_sessions \
       WHERE SUBSTR(phase, 1, 19) = 'abandoned:decision-' AND SUBSTR(phase, 20) <> '' \
         AND SUBSTR(phase, 20) NOT GLOB '*[^0-9]*'), 0)) AS TEXT) WHERE namespace = 'decision'",
    "UPDATE runtime_id_high_water SET value = CAST(MAX(CAST(value AS INTEGER), COALESCE((\
       SELECT MAX(sequence) FROM (\
         SELECT CAST(SUBSTR(phase, 11) AS INTEGER) AS sequence FROM task_sessions \
           WHERE SUBSTR(phase, 1, 10) = 'cancelled:' AND SUBSTR(phase, 11) <> '' \
             AND SUBSTR(phase, 11) NOT GLOB '*[^0-9]*' \
         UNION ALL SELECT CAST(SUBSTR(phase, 11) AS INTEGER) FROM child_assignments \
           WHERE SUBSTR(phase, 1, 10) = 'cancelled:' AND SUBSTR(phase, 11) <> '' \
             AND SUBSTR(phase, 11) NOT GLOB '*[^0-9]*')), 0)) AS TEXT) \
     WHERE namespace = 'command'",
];
