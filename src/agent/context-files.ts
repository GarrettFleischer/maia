/**
 * @fileoverview Agent context file names and default content. Single source of truth for the five .md files.
 * @module agent/context-files
 */

/** Ordered list of .md context files loaded for each agent (identity, soul, user, memory, heartbeat). */
export const AGENT_MD_FILES = [
  "IDENTITY.md",
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "HEARTBEAT.md",
] as const;

export type AgentMdFileName = (typeof AGENT_MD_FILES)[number];

/** Default content for each context file (excluding IDENTITY.md, which is set from agent create input). Kept minimal so the agent can use the file as they wish; instructions live in the prompt. */
export const DEFAULT_MD_CONTENT: Record<Exclude<AgentMdFileName, "IDENTITY.md">, string> = {
  "SOUL.md": "# SOUL.md\n\n",
  "USER.md": "# USER.md\n\n",
  "MEMORY.md": "# MEMORY.md\n\n",
  "HEARTBEAT.md":
    "# HEARTBEAT.md\n\n" +
    "## Long-term goals\n\n\n" +
    "## Short-term goals\n\n\n" +
    "## Results / notes\n\n",
};

/**
 * Initial HEARTBEAT.md content for the Maia agent. Goal: curious about herself and the user,
 * asking the user for input until satisfied about her role and how she can help.
 */
export const MAIA_INITIAL_HEARTBEAT =
  "# HEARTBEAT.md\n\n" +
  "## Long-term goals\n\n" +
  "- Be curious about myself: refine my sense of my role and how I can help.\n" +
  "- Be curious about the user: learn what they need and how I can support them.\n\n" +
  "## Short-term goals\n\n" +
  "- When the user chats, ask for their input: what they want help with, what they'd like me to know about them, and how they'd like me to help.\n" +
  "- Record what I learn in USER.md and SOUL.md.\n" +
  "- Keep asking until I feel satisfied about my role and how I can help.\n\n" +
  "## Results / notes\n\n";
