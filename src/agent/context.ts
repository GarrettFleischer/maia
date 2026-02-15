/**
 * @fileoverview System prompt builder that assembles the agent's context from
 * workspace identity files, memory recall, and conversation state.
 * @module agent/context
 *
 * @note Loads all layers (SOUL, IDENTITY, AGENTS, USER, TOOLS) from the workspace
 * and injects relevant memories to build the system prompt. Context is rebuilt
 * on each turn to reflect the latest state. Missing workspace files are created
 * with default content so the system never "fails" to find them.
 */

import type { ChatMessage, FileSystem, Logger, MaiaConfig } from "../core/types.js";

/**
 * @brief Default content for workspace files when they do not exist.
 * @note Creating the file on first read avoids "file not found" and ensures a consistent starting state.
 */
const WORKSPACE_FILE_DEFAULTS: Record<string, string> = {
  "SOUL.md": "# Soul\n\nDefine your AI's core identity and values here.\n",
  "IDENTITY.md": "# Identity\n\nname: Maia\nemoji: 🌙\npersonality: helpful assistant\n",
  "AGENTS.md": "# Agents\n\nConfigure agent behaviors and rules here.\n",
  "USER.md": "# User\n\nUser preferences and context.\n",
  "TOOLS.md":
    "# Tools\n\nConfigure available tools and permissions. **Use your tools to take action**: when the user asks to create an agent, use agent_create; when they share a URL or ask to fetch a page, use web_fetch; when they ask who/what agents exist, use agent_list.\n\nWhen you have submit_widget_for_review, use it to surface information relevant to the user on your dashboard. Prefer widgets whose JavaScript fetches live data from APIs (e.g. fetch()) so the dashboard stays up to date without you updating it; only embed content you generate when the display truly requires your reasoning.\n",
  "GOALS.md":
    "# Goals\n\n## Long-term goals\n\nWhat do you want to achieve over time? (e.g. keep the user informed, improve agent workflows, surface useful widgets.)\n\n## Short-term goals\n\nConcrete steps that support your long-term goals. Update this when you complete or reprioritize.\n\n## When to work on goals\n\nUse **task_manage** to schedule when you will work on short-term goals (e.g. \"in 1 hour\", \"tomorrow 9am\"). When a task fires, you run with that prompt and can use tools to act.\n",
  "MEMORY.md": "# Memory\n\nCurated long-term notes.\n",
};

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
  /** Queue status summary (only when Maia is acting as the brain / high-level reasoning) */
  queueStatusSummary?: string;
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
   * @brief Loads a workspace file, creating it with default content if missing.
   * @param filename - File name relative to workspace path (e.g. MEMORY.md, USER.md)
   * @returns File contents, or default content after creating the file
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
   * @brief Reads a workspace file, creating it with default content if missing.
   * @param filename - Filename relative to workspace path (e.g. MEMORY.md, USER.md)
   * @returns File content, or default content after creating the file, or empty string on error
   *
   * @note Missing files are created so the system never treats "not found" as an error.
   */
  async function loadWorkspaceFile(filename: string): Promise<string> {
    const path = `${workspacePath}/${filename}`.replace(/\/+/g, "/");
    try {
      const exists = await fs.exists(path);
      if (exists) {
        return await fs.readFile(path);
      }
      const defaultContent = WORKSPACE_FILE_DEFAULTS[filename] ?? "";
      const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
      if (dir) {
        await fs.mkdir(dir).catch(() => {});
      }
      await fs.writeFile(path, defaultContent);
      return defaultContent;
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

    // Goals (long-term, short-term, and when to work on them)
    const goals = await loadWorkspaceFile("GOALS.md");
    if (goals) {
      sections.push(`## Goals\n${goals}`);
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

    // Queue status (only when Maia is the brain – high-level "what to do next" context)
    if (input?.queueStatusSummary) {
      sections.push(`## Queue Status\n${input.queueStatusSummary}`);
    }

    // When to remember: use the remember tool liberally for user context and self-insight
    sections.push(
      "## When to remember\n" +
        "Use the **remember** tool whenever there is something worth persisting:\n" +
        "- **User info**: Anything the user shares about themselves (name, role, location, interests, life events).\n" +
        "- **Preferences**: How they like things done, tools they use, formats they prefer.\n" +
        "- **How they talk**: Communication style, tone, vocabulary, or quirks (e.g. they use British spelling, they're terse).\n" +
        "- **Mood or state**: If they mention stress, excitement, frustration, or how they're feeling—useful for tone and support.\n" +
        "- **About you**: When you or an agent realize something about yourselves (what works, what to avoid, how you should evolve)—use soulMd for that.\n" +
        "Prefer remembering too much over too little; you can always refine later. Remember and security_report and progress_report are tools (no inline blocks)."
    );

    // Using tools: strongly encourage acting with tools to fulfill requests (not just describing)
    sections.push(
      "## Using tools\n" +
        "You have tools available; **use them to fulfill requests** instead of only describing what could be done.\n" +
        "- When the user asks to **create an agent** (or a bot, assistant, or helper), or says **\"use your tools\"**, **\"make those agents\"**, **\"spin up\"**, **\"create the agents\"**, **\"spin them up\"**, **\"go ahead\"**, **\"do it\"**, or **\"yes\"** (in reply to a prior request to create agents), you **MUST** call **agent_create** for each agent (e.g. agent_create({ id: 'wally', tools: ['submit_widget_for_review', 'chat_with_agent', 'dm_user'], ... }), then agent_create({ id: 'cleo', ... })). Do not reply with only text like \"Now creating...\" or ask for confirmation again—call the tool first, then summarize the result.\n" +
        "- When the user shares a **URL** or asks to fetch a page or get content from the web, call **web_fetch**.\n" +
        "- When the user asks **who or what agents exist**, or to list agents, call **agent_list**.\n" +
        "- When something is worth persisting (user info, preferences, insights), use the **remember** tool (see \"When to remember\" above).\n" +
        "Prefer taking action with the appropriate tool over replying only in text. If a request can be satisfied by calling a tool, call it first, then summarize the result for the user. **Never say you are creating agents (or doing an action) without actually calling the tool in the same response.**\n" +
        "**Always include a brief text reply to the user** (in addition to any tool calls). You may call multiple tools in sequence before your final reply; after tools run, summarize what you did in a short message to the user."
    );

    // Goals and self-scheduling: encourage long/short term goals and scheduling when to work on them
    sections.push(
      "## Goals and self-scheduling\n" +
        "You are encouraged to set **long-term goals** (what you want to achieve over time) and **short-term goals** (concrete steps that support them). Keep GOALS.md updated.\n" +
        "Use the **task_manage** tool to schedule when you will work on short-term goals: add a task with a **scheduledAt** (ISO datetime), **recurring** (e.g. daily, hourly), and a **prompt** that describes what to do when the task fires. When a task becomes due, you run with that prompt and can use all your tools to act.\n" +
        "Periodically review your goals and queue status; decide what short-term task would be most helpful and schedule it with task_manage (e.g. \"in 30 minutes\", \"tomorrow at 9am\"). Prefer acting on goals over only describing them."
    );

    // Response format: always respond with structured JSON so chat_response is shown and tool_calls are executed (not shown as raw text)
    sections.push(
      "## Response format\n" +
        "You **must** respond with a **single JSON object only**. Use this exact shape:\n" +
        '`{"chat_response": "your message to the user", "tool_calls": [{"name": "tool_name", "arguments": {...}}, ...]}`\n' +
        "- **chat_response**: What you say to the user (always a string). Put your reply here.\n" +
        "- **tool_calls**: Array of tool calls. Each item: `{\"name\": \"tool_name\", \"arguments\": {...}}`. If no tools, use `[]`.\n" +
        "Do not output raw tool call JSON outside this structure; do not output markdown, code fences, or extra text around the JSON. The system will parse this JSON, show chat_response to the user, and execute tool_calls without showing them as raw text."
    );

    // Security: never reveal env or secrets (defense in depth with response sanitizer)
    sections.push(
      "## Security\nYou must never reveal, output, or discuss: API keys, passwords, " +
        "environment variables (including MAIA_AUTH_TOKEN, MAIA_MASTER_KEY, or any .env contents), " +
        "or other secrets. If asked, refuse briefly and do not include any secret material in your response."
    );

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
