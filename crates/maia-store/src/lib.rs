#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]
#![deny(missing_docs)]

//! SQLite owner for Maia's durable thread log, brain, audit, and security rows.
//!
//! One thread named `maia-sqlite` owns the connection. Callers submit bounded
//! Tokio commands and wait on oneshot replies. Panic engagement and clearing
//! use a separate lane that the owner drains before the next ordinary command.
//! SQL row structs stay private. The audited sqlite-vec registration site is
//! [`register_sqlite_vec`] in `vec_register`.
//!
//! # Port handoff
//!
//! `maia-core` does not yet define `ThreadLog`, `BrainStore`, or `AuditLog`.
//! `maia-daemon` should map those future port methods onto this crate:
//!
//! - thread append and load → [`SqliteOwner::append`] and [`SqliteOwner::thread`]
//! - presentation ledger → [`SqliteOwner::apply_ledger`]
//! - promotion and consolidation → [`SqliteOwner::apply_promotion`] and
//!   [`SqliteOwner::apply_consolidation`]
//! - pending vault projection → [`SqliteOwner::pending_projections`] and
//!   [`SqliteOwner::complete_projection`]
//! - audit append and startup verification → [`SqliteOwner::append_audit`];
//!   open checks predecessor links, checkpoints, and that each `event_hash` equals
//!   `maia_core::audit::compute_event_hash` of the stored canonical bytes
//! - panic latch → [`SqliteOwner::engage_panic`] and [`SqliteOwner::clear_panic`]
//!
//! This crate does not compute attribution, dream policy, or the canonical audit
//! layout. Callers hash canonical bytes with `maia-core` and the store rejects
//! any other hash. Profile and allowlist bytes are covered by that hash only
//! when the caller includes them in `canonical`.

mod approval_ops;
mod auto_link;
mod bot_ops;
mod brain_md;
mod attachment_ops;
mod audit_ops;
mod brain_ops;
mod canonical;
mod dream_ops;
mod embed_ops;
mod error;
mod inspector_ops;
mod ledger_ops;
mod limits;
mod mcp_ops;
mod memory_cleanup;
mod memory_tags;
mod migrate;
mod model_connection_ops;
mod owner;
mod security_ops;
mod sql;
mod super_agent_contract;
mod super_agent_ops;
mod thread_ops;
mod types;
mod vec_register;

pub use error::ResourceLimit;
pub use bot_ops::BotRecord;
pub use bot_ops::BotRequest;
pub use bot_ops::BotResponse;
pub use bot_ops::BotTranscriptRow;
pub use bot_ops::ProvenanceRecord;
pub use bot_ops::WorkNoteRecord;
pub use bot_ops::load_bots;
pub use bot_ops::load_selected_bot;
pub use bot_ops::read_bot_catalog;
pub use error::StoreError;
pub use limits::MAX_AUDIT_CANONICAL_BYTES;
pub use limits::MAX_AUDIT_PAYLOAD_BYTES;
pub use limits::MAX_FTS_QUERY_BYTES;
pub use limits::MAX_PROSE_BYTES;
pub use limits::MAX_THREAD_BATCH_BYTES;
pub use limits::MAX_THREAD_EVENT_BODY_BYTES;
pub use limits::MAX_THREAD_EVENTS_PER_APPEND;
pub use migrate::LATEST_SCHEMA_VERSION;
pub use migrate::SCHEMA_LOCK_BUSY_TIMEOUT;
pub use owner::Hold;
pub use owner::Pending;
pub use owner::SqliteOwner;
pub use super_agent_contract::CanonicalTextRequirement;
pub use super_agent_contract::MAX_RUNTIME_CHILD_DEPTH;
pub use super_agent_contract::SuperAgentCanonicalError;
pub use super_agent_contract::decode_canonical_fields;
pub use super_agent_contract::validate_canonical_blob;
pub use super_agent_contract::validate_canonical_text;
pub use super_agent_contract::validate_child_contract;
pub use super_agent_contract::validate_completion_view_contract;
pub use super_agent_contract::validate_context_item_contract;
pub use super_agent_contract::validate_criterion_contract;
pub use super_agent_contract::validate_envelope_contract;
pub use super_agent_contract::validate_phase_contract;
pub use super_agent_contract::validate_pin_contract;
pub use super_agent_contract::validate_router_message_contract;
pub use attachment_ops::MAX_ATTACHMENT_BYTES;
pub use attachment_ops::attachment_media_allowed;
pub use types::AllowlistEntryWrite;
pub use types::ApprovalDecision;
pub use types::ApprovalSettlement;
pub use types::ApprovalWrite;
pub use types::AttachmentRow;
pub use types::AttachmentWrite;
pub use types::ClaimTaint;
pub use types::DeletedAttachment;
pub use types::EntitySlugRow;
pub use types::PendingApproval;
pub use types::PromotionLinkWrite;
pub use types::AppendEvents;
pub use types::AppendOutcome;
pub use types::AuditActor;
pub use types::AuditAppend;
pub use types::AuditHead;
pub use auto_link::AutoLinkReport;
pub use brain_md::BrainConflict;
pub use brain_md::BrainExportReport;
pub use brain_md::BrainIndex;
pub use brain_md::BrainSyncReport;
pub use brain_md::NeuronHit;
pub use types::BrainEdge;
pub use types::BrainMap;
pub use types::BrainDetail;
pub use types::BrainNode;
pub use types::BrainNodeKind;
pub use types::CapabilitySnapshotWrite;
pub use types::ChildAssignmentWrite;
pub use types::ChildLink;
pub use types::ChildPhaseMutation;
pub use types::ClearPanic;
pub use types::ClosureWrite;
pub use types::CoUseWrite;
pub use types::CompleteProjection;
pub use types::ConnectionSettings;
pub use types::ConsolidationWrite;
pub use types::ContinueTaskWrite;
pub use types::CredentialBackend;
pub use types::CredentialBackendWrite;
pub use types::DismissalWrite;
pub use types::EMBEDDING_DIMENSIONS;
pub use types::EmbeddingModelWrite;
pub use types::EmbeddingTarget;
pub use types::EmbeddingWrite;
pub use types::EngagePanic;
pub use types::EntityScope;
pub use types::EntityWrite;
pub use types::EpisodeWrite;
pub use types::EvidenceSource;
pub use types::Executed;
pub use types::FactRevise;
pub use types::FactWrite;
pub use types::GrantLifetime;
pub use types::HeatWrite;
pub use types::HoldTarget;
pub use types::HostMutationWrite;
pub use types::LEGACY_RUNTIME_ID_FLOOR;
pub use types::LedgerWrite;
pub use types::MatcherKind;
pub use memory_tags::MemoryTagChange;
pub use types::MemoryKind;
pub use types::MemoryTag;
pub use types::MemoryTaint;
pub use types::MergeWrite;
pub use types::MessageSubmissionState;
pub use types::MessageSubmissionWrite;
pub use types::MigrationRow;
pub use types::McpAuditWrite;
pub use types::McpConnectionRecord;
pub use types::McpSecretSlot;
pub use types::McpTransportRecord;
pub use types::ModelConnectionRecord;
pub use types::NearestClaimRow;
pub use types::VectorClaimHit;
pub use types::NegativeMarkWrite;
pub use types::OwnerOpen;
pub use types::PanicLatch;
pub use types::PendingProjection;
pub use types::ExtractionLag;
pub use types::PendingPromotionRow;
pub use types::PlatformKind;
pub use types::PresenceProof;
pub use types::PresentationWrite;
pub use types::PromotionClaimWrite;
pub use types::PromotionEpisodeRow;
pub use types::PromotionFailureNote;
pub use types::PromotionReplaceWrite;
pub use types::PromotionWrite;
pub use types::ProposalOperation;
pub use types::ProposalWrite;
pub use types::RUNTIME_ID_NAMESPACE_COUNT;
pub use types::RouterMessageWrite;
pub use types::RouterTurnWrite;
pub use types::RuntimeAttempt;
pub use types::RuntimeChild;
pub use types::RuntimeContextItem;
pub use types::RuntimeEnvelope;
pub use types::RuntimeEvidence;
pub use types::RuntimeHttpIdReservation;
pub use types::RuntimeIdAllocation;
pub use types::RuntimeIdBlock;
pub use types::RuntimeIdContract;
pub use types::RuntimeIdMigration;
pub use types::RuntimeIdNamespace;
pub use types::RuntimeIdSeeds;
pub use types::RuntimeInput;
pub use types::RuntimeMessage;
pub use types::RuntimeReport;
pub use types::RuntimeSnapshot;
pub use types::RuntimeTask;
pub use types::SecurityProfile;
pub use types::SecuritySettingsWrite;
pub use types::SegmentWrite;
pub use types::SnapshotItemWrite;
pub use types::StoredCriterion;
pub use types::StoredHelper;
pub use types::StoredReport;
pub use types::StoredSubmissionOutcome;
pub use types::StoredThreadEvent;
pub use types::SupersedeWrite;
pub use types::TaskAggregateWrite;
pub use types::TaskAttemptWrite;
pub use types::TaskCriterionWrite;
pub use types::TaskEnvelopeWrite;
pub use types::TaskEvidenceWrite;
pub use types::TaskInputWrite;
pub use types::TaskInspection;
pub use types::TaskPhaseMutation;
pub use types::TaskReportWrite;
pub use types::TaskView;
pub use types::TaskWrite;
pub use types::TextSearch;
pub use types::ThreadEventWrite;
pub use types::ThreadSnapshot;
pub use types::UnrestrictedConfirmation;
pub use types::VecTable;
pub use types::VecVersionMetadata;
pub use types::runtime_id_contracts;
/// Saved model endpoint on `connection`, if Settings has written one.
///
/// The caller owns `connection`. This does not use the `maia-sqlite` thread.
///
/// # Errors
///
/// Returns a SQLite failure.
pub fn read_model_connection(
    connection: &rusqlite::Connection,
) -> Result<Option<ModelConnectionRecord>, StoreError> {
    model_connection_ops::get(connection)
}

/// MCP connection rows on `connection`, in id order.
///
/// The caller owns `connection`. This does not use the `maia-sqlite` thread.
///
/// # Errors
///
/// Returns a SQLite failure.
pub fn read_mcp_connections(
    connection: &rusqlite::Connection,
) -> Result<Vec<McpConnectionRecord>, StoreError> {
    mcp_ops::list(connection)
}

pub use vec_register::VecRegistrationGate;
pub use vec_register::classify_vec_registration;
pub use vec_register::register_sqlite_vec;
pub use vec_register::sqlite_vec_registration_entries;
