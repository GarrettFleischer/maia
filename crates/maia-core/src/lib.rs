#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic domain contracts for Maia.

/// Obsidian vault parsing, rendering, and path confinement types.
pub mod vault;

/// Shared brain retrieval graph, episodes, facts, and `BrainStore` port types.
pub mod brain;

/// Activation, attribution, and presentation credit policy.
pub mod credit;

/// Thread lifecycle, budgets, scheduler state, and run-loop policy.
pub mod agents;

/// Grants, taint, approvals, and destination classification policy.
pub mod security;

/// Append-only signed audit chain types and verification policy.
pub mod audit;

/// Durable per-thread prompt cache contracts.
pub mod thread_cache;

/// Tool-less promotion and consolidation contracts.
pub mod dream;

/// Router port types (adapter in `maia-router`).
pub mod router;

/// Embedder port types (adapter in `maia-embedder`).
pub mod embedder;

/// Super Agent router session, task envelope, and lifecycle contracts.
pub mod super_agent;

/// Several Super Agents with separate chats and one shared brain.
pub mod bots;

/// Loop detection and transcript compaction for long tasks.
pub mod task_loop;

/// Published subagent tool catalog and call admission.
pub mod agent_tools;

/// Admitted MCP catalogs, grants, and call checks.
pub mod mcp;
