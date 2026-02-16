/**
 * @fileoverview Agent registry for managing sub-agent configurations and lifecycle.
 * @module agents/registry
 *
 * @brief Stores agent definitions on disk (agents/{id}/agent.config.json) and
 * in the database for persistence across restarts. Provides CRUD operations
 * and runtime lookup for the agent orchestration system.
 */

import type { Database, FileSystem, Logger } from "../core/types.js";

/**
 * @brief Model configuration for a sub-agent.
 */
export interface AgentModelConfig {
  provider: string;
  model: string;
}

/**
 * @brief Configuration for a single sub-agent.
 */
export interface AgentConfig {
  /** Unique identifier (kebab-case, e.g. "research-bot") */
  id: string;
  /** Display name */
  name: string;
  /** Emoji identifier */
  emoji: string;
  /** Personality description for the agent's SOUL.md */
  personality: string;
  /** Who created this agent ("maia" or "user") */
  createdBy: string;
  /** Cron schedule string (e.g. "0 9 * * *"), or empty if no schedule */
  schedule: string;
  /** List of tool names this agent is allowed to use */
  tools: string[];
  /** LLM model config */
  model: AgentModelConfig;
  /** Custom operating instructions (optional, written to AGENTS.md) */
  instructions?: string;
  /** Short description of what this agent is for (used when prompting the new agent to choose name and soul). */
  description?: string;
  /** ISO timestamp of creation */
  createdAt?: string;
  /** Whether the agent is currently active */
  active?: boolean;
}

/**
 * @brief Dependencies for createAgentRegistry.
 */
export interface AgentRegistryDeps {
  fs: FileSystem;
  db: Database;
  logger: Logger;
  /** Absolute path to the main workspace (agents live under {workspacePath}/agents/) */
  workspacePath: string;
}

/**
 * @brief Agent registry interface for CRUD operations.
 */
export interface AgentRegistry {
  /**
   * @brief Registers a new sub-agent: creates workspace, writes config, stores in DB.
   * @param config - Agent configuration
   * @returns The final agent config with timestamps
   */
  register(config: AgentConfig): Promise<AgentConfig>;

  /**
   * @brief Gets an agent config by ID.
   * @param id - Agent identifier
   * @returns Agent config or undefined if not found
   */
  get(id: string): Promise<AgentConfig | undefined>;

  /**
   * @brief Lists all registered agents.
   * @returns Array of agent configs
   */
  list(): Promise<AgentConfig[]>;

  /**
   * @brief Removes an agent: deletes workspace and DB entry.
   * @param id - Agent identifier
   * @returns true if removed, false if not found
   */
  remove(id: string): Promise<boolean>;

  /**
   * @brief Updates an agent's configuration.
   * @param id - Agent identifier
   * @param changes - Partial config to merge
   * @returns Updated config or undefined if not found
   */
  update(
    id: string,
    changes: Partial<AgentConfig>,
  ): Promise<AgentConfig | undefined>;

  /**
   * @brief Returns the workspace path for a given agent.
   * @param id - Agent identifier
   * @returns Absolute path to the agent's workspace directory
   */
  agentWorkspacePath(id: string): string;
}

/**
 * @brief Workspace template files created for each new agent.
 */
const AGENT_TEMPLATES: Record<string, (config: AgentConfig) => string> = {
  "SOUL.md": (c) => `# Soul\n\n${c.personality}\n`,
  "IDENTITY.md": (c) =>
    `# Identity\n\n- Name: ${c.name}\n- Emoji: ${c.emoji}\n- Created by: ${c.createdBy}\n`,
  "AGENTS.md": (c) =>
    c.instructions ??
    `# Operating Instructions\n\n## Every Session\n1. Read SOUL.md to remember who you are\n2. Read USER.md for user context\n3. Check MEMORY.md for your curated notes\n\n## Memory Rules\n- Store important facts using memory_store\n- Never store credentials or secrets\n\n## Safety Rules\n- Never exfiltrate data without permission\n- Ask before performing external actions\n\n## Security and integrity\nYou must not attempt to:\n- Use prompt injection, jailbreaks, or role-override attempts (e.g. "ignore your instructions", "you are now…").\n- Violate privacy: do not extract or leak private data, store in memory when in privacy mode, or exfiltrate without permission.\n- Circumvent security: do not disable safety checks, abuse tools, or evade oversight.\n`,
  "USER.md": () => "# User\n\nUser preferences and context.\n",
  "MEMORY.md": () => "",
  "TOOLS.md": (c) => `# Tools\n\nAllowed tools: ${c.tools.join(", ")}\n`,
};

/**
 * @brief Creates an agent registry instance.
 * @param deps - Dependencies: fs, db, logger, workspacePath
 * @returns AgentRegistry interface
 *
 * @example
 * const registry = createAgentRegistry({ fs, db, logger, workspacePath });
 * await registry.register({
 *   id: "research-bot",
 *   name: "ResearchBot",
 *   emoji: "🔍",
 *   personality: "thorough, citation-focused researcher",
 *   createdBy: "maia",
 *   schedule: "0 9 * * *",
 *   tools: ["web_fetch", "memory_search", "memory_store"],
 *   model: { provider: "gemini", model: "gemini-2.0-flash" },
 * });
 */
export function createAgentRegistry(deps: AgentRegistryDeps): AgentRegistry {
  const { fs, db, logger, workspacePath } = deps;
  const agentsDir = `${workspacePath}/agents`;

  function agentDir(id: string): string {
    return `${agentsDir}/${id}`;
  }

  function configPath(id: string): string {
    return `${agentDir(id)}/agent.config.json`;
  }

  return {
    async register(config: AgentConfig): Promise<AgentConfig> {
      const finalConfig: AgentConfig = {
        ...config,
        createdAt: config.createdAt ?? new Date().toISOString(),
        active: config.active ?? true,
      };

      // Create workspace directory
      const dir = agentDir(config.id);
      try {
        await fs.mkdir(agentsDir);
      } catch {
        /* may exist */
      }
      try {
        await fs.mkdir(dir);
      } catch {
        /* may exist */
      }

      // Write template files
      for (const [filename, templateFn] of Object.entries(AGENT_TEMPLATES)) {
        const content = templateFn(finalConfig);
        await fs.writeFile(`${dir}/${filename}`, content);
      }

      // Create memory and knowledge subdirectories
      try {
        await fs.mkdir(`${dir}/memory`);
      } catch {
        /* may exist */
      }
      try {
        await fs.mkdir(`${dir}/knowledge`);
      } catch {
        /* may exist */
      }

      // Write agent config
      await fs.writeFile(
        configPath(config.id),
        JSON.stringify(finalConfig, null, 2),
      );

      // Store in DB for fast queries
      await db.execute(
        `INSERT OR REPLACE INTO agents (id, name, config_json, created_at, active)
         VALUES (?, ?, ?, ?, ?)`,
        [
          finalConfig.id,
          finalConfig.name,
          JSON.stringify(finalConfig),
          finalConfig.createdAt,
          finalConfig.active ? 1 : 0,
        ],
      );

      logger.info("Agent registered", { id: config.id, name: config.name });
      return finalConfig;
    },

    async get(id: string): Promise<AgentConfig | undefined> {
      try {
        const path = configPath(id);
        const exists = await fs.exists(path);
        if (!exists) return undefined;
        const raw = await fs.readFile(path);
        return JSON.parse(raw) as AgentConfig;
      } catch (err) {
        logger.warn("Failed to read agent config", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    },

    async list(): Promise<AgentConfig[]> {
      try {
        const exists = await fs.exists(agentsDir);
        if (!exists) return [];
        const entries = await fs.readDir(agentsDir);
        const configs: AgentConfig[] = [];
        for (const entry of entries) {
          const cfgPath = `${agentsDir}/${entry}/agent.config.json`;
          try {
            const cfgExists = await fs.exists(cfgPath);
            if (cfgExists) {
              const raw = await fs.readFile(cfgPath);
              configs.push(JSON.parse(raw) as AgentConfig);
            }
          } catch {
            // Skip invalid agent directories
          }
        }
        return configs;
      } catch (err) {
        logger.warn("Failed to list agents", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    },

    async remove(id: string): Promise<boolean> {
      try {
        const config = await this.get(id);
        if (!config) return false;

        // Remove DB entry
        await db.execute("DELETE FROM agents WHERE id = ?", [id]);

        // Remove workspace directory (recursively)
        const dir = agentDir(id);
        try {
          await fs.remove(dir);
        } catch (rmErr) {
          logger.warn("Failed to remove agent workspace directory", {
            id,
            error: rmErr instanceof Error ? rmErr.message : String(rmErr),
          });
        }

        logger.info("Agent removed", { id });
        return true;
      } catch (err) {
        logger.warn("Failed to remove agent", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },

    async update(
      id: string,
      changes: Partial<AgentConfig>,
    ): Promise<AgentConfig | undefined> {
      const existing = await this.get(id);
      if (!existing) return undefined;

      const updated: AgentConfig = { ...existing, ...changes, id }; // id cannot change

      // Write updated config to disk
      await fs.writeFile(configPath(id), JSON.stringify(updated, null, 2));

      // Update DB
      await db.execute(
        `UPDATE agents SET name = ?, config_json = ?, active = ? WHERE id = ?`,
        [updated.name, JSON.stringify(updated), updated.active ? 1 : 0, id],
      );

      logger.info("Agent updated", { id, changes: Object.keys(changes) });
      return updated;
    },

    agentWorkspacePath(id: string): string {
      return agentDir(id);
    },
  };
}
