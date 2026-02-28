/**
 * @fileoverview Thread (session) management tools for Maia. Create, list, update,
 * delete sessions and get/set the active session. Maia-only.
 * @module lib/tools/thread-management
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import {
  listSessions,
  createSession,
  updateSessionMeta,
  deleteSession,
  getActiveSessionId,
  setActiveSessionId,
} from "../history";
import type { Tool, ToolContext } from "./types";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({ name, description, parameters: zodToJsonSchema(schema) }),
  };
}

/**
 * @brief List sessions (threads), optionally filtered by type.
 * @param args.type - Optional: "user" | "agents" | "all" (default all)
 * @returns Array of session metadata (no message content)
 */
export const threadListTool = makeTool(
  "thread_list",
  "List all threads (sessions). Optionally filter by type: user, agents, or all. Example: thread_list({}).",
  z.object({
    type: z.enum(["user", "agents", "all"]).optional().describe("Filter by session type; omit for all"),
  }),
  async ({ type }, ctx) => listSessions(ctx, type)
);

/**
 * @brief Create a new thread (session).
 * @param args.participants - Optional participant IDs (default ["user", "maia"])
 * @param args.type - Optional: "user" | "agents" (default "user")
 * @returns New session ID
 */
export const threadCreateTool = makeTool(
  "thread_create",
  "Create a new thread (session). Use thread_list first to see existing threads. Optionally set participants and type (user or agents). Example: thread_create({ type: 'user' }).",
  z.object({
    participants: z.array(z.string()).optional().describe("Participant IDs; default [\"user\", \"maia\"]"),
    type: z.enum(["user", "agents"]).optional().describe("Session type; default user"),
  }),
  async (args, ctx) =>
    createSession(
      ctx,
      args.participants ?? ["user", "maia"],
      args.type ?? "user"
    )
);

/**
 * @brief Update thread metadata (name, description, tags).
 * @param args.sessionId - Session to update
 * @param args.name - Optional new name
 * @param args.description - Optional new description
 * @param args.tags - Optional new tags array
 */
export const threadUpdateTool = makeTool(
  "thread_update",
  "Update a thread's metadata: name, description, or tags. Example: thread_update({ id: 'id', name: 'Project X' }).",
  z.object({
    id: z.string().describe("Session ID"),
    name: z.string().optional().describe("Display name"),
    desc: z.string().optional().describe("Description"),
    tags: z.array(z.string()).optional().describe("Tags"),
  }),
  async ({ id: sessionId, name, desc: description, tags }, ctx) => {
    const meta: Partial<{ name: string; description: string; tags: string[] }> = {};
    if (name !== undefined) meta.name = name;
    if (description !== undefined) meta.description = description;
    if (tags !== undefined) meta.tags = tags;
    updateSessionMeta(ctx, sessionId, meta);
  }
);

/**
 * @brief Delete a thread (session) and its history.
 * @param args.sessionId - Session to delete
 * @returns true if deleted, false if session did not exist
 */
export const threadDeleteTool = makeTool(
  "thread_delete",
  "Delete a thread (session) and all its messages. Clears active session if it was active. Example: thread_delete({ id: 'id' }).",
  z.object({
    id: z.string().describe("Session ID"),
  }),
  async ({ id: sessionId }, ctx) => deleteSession(ctx, sessionId)
);

/**
 * @brief Get the currently active session ID.
 * @returns Active session ID or null
 */
export const threadGetActiveTool = makeTool(
  "thread_get_active",
  "Get the ID of the currently active thread (session). Returns null if none is set. Example: thread_get_active({}).",
  z.object({}),
  async (_args, ctx) => getActiveSessionId(ctx)
);

/**
 * @brief Set the active thread (session).
 * @param args.sessionId - Session to make active
 */
export const threadSetActiveTool = makeTool(
  "thread_set_active",
  "Set the currently active thread (session) by ID. Example: thread_set_active({ id: 'id' }).",
  z.object({
    id: z.string().describe("Session ID"),
  }),
  async ({ id: sessionId }, ctx) => {
    setActiveSessionId(ctx, sessionId);
  }
);

export const threadManagementTools: Tool[] = [
  threadListTool,
  threadCreateTool,
  threadUpdateTool,
  threadDeleteTool,
  threadGetActiveTool,
  threadSetActiveTool,
];
