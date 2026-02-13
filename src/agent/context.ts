/**
 * @fileoverview System prompt builder that assembles the agent's context from
 * workspace identity files, memory recall, and conversation state.
 * @module agent/context
 *
 * @note Loads all layers (SOUL, IDENTITY, AGENTS, USER, TOOLS) from the workspace
 * and injects relevant memories to build the system prompt. Context is rebuilt
 * on each turn to reflect the latest state.
 */

import type { ChatMessage, FileSystem, Logger, MaiaConfig } from "../core/types.js";

/**
 * @brief Dependencies for createContextBuilder.
 */
export interface ContextBuilderDeps {
  fs: FileSystem;
  config: MaiaConfig;
  logger: Logger;
}

/**
 * @brief Input data for building a system prompt.
 */
export interface ContextInput {
  /** Recalled memory context block (from auto-recall) */
  memoryContext?: string;
  /** Current conversation thread/topic summary */
  threadSummary?: string;
  /** Additional instructions or context */
  additionalContext?: string;
}

/**
 * @brief Context builder interface.
 */
export interface ContextBuilder {
  /**
   * @brief Builds the full system prompt from workspace files and context.
   * @param input - Optional additional context data
   * @returns Promise resolving to the system ChatMessage
   */
  buildSystemPrompt(input?: ContextInput): Promise<ChatMessage>;

  /**
   * @brief Loads a single workspace file safely.
   * @param filename - File name relative to workspace path
   * @returns File contents or empty string if not found
   */
  loadWorkspaceFile(filename: string): Promise<string>;
}

/**
 * @brief Creates a context builder that assembles the system prompt.
 * @param deps - Dependencies: fs, config, logger
 * @returns ContextBuilder instance
 *
 * @example
 * const builder = createContextBuilder({ fs, config, logger });
 * const systemMessage = await builder.buildSystemPrompt({
 *   memoryContext: "User prefers dark mode.",
 *   threadSummary: "Discussing UI preferences.",
 * });
 */
export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  const { fs, config, logger } = deps;
  const workspacePath = config.workspace.path;

  /**
   * @brief Safely reads a file from the workspace directory.
   * @param filename - Filename relative to workspace path
   * @returns File content or empty string on error
   */
  async function loadWorkspaceFile(filename: string): Promise<string> {
    const path = `${workspacePath}/${filename}`.replace(/\/+/g, "/");
    try {
      const exists = await fs.exists(path);
      if (!exists) {
        logger.debug("Workspace file not found", { filename });
        return "";
      }
      return await fs.readFile(path);
    } catch (err) {
      logger.warn("Failed to load workspace file", {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }

  /**
   * @brief Assembles the system prompt from all workspace layers.
   * @param input - Optional context additions (memory, thread summary, etc.)
   * @returns ChatMessage with role "system" and assembled content
   */
  async function buildSystemPrompt(input?: ContextInput): Promise<ChatMessage> {
    const sections: string[] = [];

    // Identity layers
    const soul = await loadWorkspaceFile("SOUL.md");
    if (soul) {
      sections.push(`## Core Persona\n${soul}`);
    }

    const identity = await loadWorkspaceFile("IDENTITY.md");
    if (identity) {
      sections.push(`## Identity\n${identity}`);
    }

    // Operating instructions
    const agents = await loadWorkspaceFile("AGENTS.md");
    if (agents) {
      sections.push(`## Operating Instructions\n${agents}`);
    }

    // User information
    const user = await loadWorkspaceFile("USER.md");
    if (user) {
      sections.push(`## About the User\n${user}`);
    }

    // Available tools
    const tools = await loadWorkspaceFile("TOOLS.md");
    if (tools) {
      sections.push(`## Available Tools\n${tools}`);
    }

    // Curated memory
    const memory = await loadWorkspaceFile("MEMORY.md");
    if (memory) {
      sections.push(`## Curated Memory\n${memory}`);
    }

    // Injected memory context from auto-recall
    if (input?.memoryContext) {
      sections.push(`## Relevant Memories\n${input.memoryContext}`);
    }

    // Thread summary
    if (input?.threadSummary) {
      sections.push(`## Current Topic\n${input.threadSummary}`);
    }

    // Additional context
    if (input?.additionalContext) {
      sections.push(input.additionalContext);
    }

    // System metadata
    const now = new Date().toISOString();
    sections.push(
      `## System Info\n- Name: ${config.identity.name}\n- Emoji: ${config.identity.emoji}\n- Current time: ${now}`
    );

    const content = sections.join("\n\n---\n\n");
    logger.debug("System prompt built", {
      sections: sections.length,
      length: content.length,
    });

    return { role: "system", content };
  }

  return { buildSystemPrompt, loadWorkspaceFile };
}
