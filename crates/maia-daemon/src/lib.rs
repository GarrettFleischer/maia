#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Composition root: configuration, scheduling, and framework hooks.

mod attachment_prompt;
mod attribution_wire;
mod discovery;
mod env;
mod http;
pub mod inspector;
mod mcp_settings;
mod model_connection;
mod orchestrator;
mod promoter_env;
mod promotion;
mod remote;
mod scripted_tools;

pub use discovery::{DiscoveryError, select_model_id};
pub use env::{EnvError, ModelEnv, ProviderApiKey, read_model_env};
pub use http::{
    HttpIdSupply, HttpIdSupplyError, ModelKeyError, ModelListError, ModelLister, ModelPorts,
    RouterKeyStore, RuntimeRouter, ServeFailure, ServerShutdown, SuperAgentServer,
    coalesce_sidebar, discover_model_id, discover_model_id_bounded, live_model_lister,
    native_router_key_store, parse_model_ids, serve_super_agent_with_ids,
    serve_super_agent_with_model, ui_bind_addr,
};
pub use inspector::{PackedRecall, RecallKind, RecallLine};
pub use mcp_settings::{MemoryMcpSecretStore, NativeMcpSecretStore};
pub use model_connection::{PublicModelConnection, parse_reasoning_effort, router_from_connection};
pub use orchestrator::{
    AdmittedMcpTool, AdmittedOutcome, ChildNarrowing, HostIntent, IdSupply, McpToolReply,
    MessageOutcome, Orchestrator, OrchestratorConfig, OrchestratorError, ParentWork,
    PhaseCodecError, ProposalParseError, ReplayGuard, RoutedOutcome, RouterTurn,
    RoutingFailureReason, StagedAttachment, StepOutcome, SubmissionAdmission, TurnOutcome,
    UNKNOWN_OUTCOME_SUMMARY, accepted_routing_policy, open_routing_policy, canonical_phase, encode_route_proposal,
    named_tool_response, parse_canonical_phase, present_router_body, route_tool_response,
    validate_runtime_snapshot,
};
pub use promoter_env::{
    DEFAULT_PROMOTER_DAILY_CALL_CAP, DEFAULT_PROMOTER_DAILY_TOKEN_CAP, DEFAULT_PROMOTER_MODEL,
    PromoterEnv, read_promoter_env,
};
pub use promotion::{
    ClaimEmbedder, ClaimEmbedderIdentity, CoreClaimEmbedder, EmbedFailure, PromoterModel,
    PromotionAttempt, PromotionCaps, PromotionRunner, RouterPromoter, ScriptedPromoter,
    bounded_recall, open_candle_claim_embedder,
};
pub use scripted_tools::{
    ApprovalKind, CompletionEvidence, ScriptedCall, ScriptedToolHost, ToolHostError,
};
