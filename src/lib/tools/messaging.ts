import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";

// These are thin wrappers — actual logic is in the messaging service
// to avoid circular imports. The messaging service patches these at runtime.

let _messageToUserImpl: ((agentId: string, sessionId: string, content: string) => Promise<void>) | null = null;
/** Sends a message to another agent. When run in background, returns a status string; recipient reply is delivered to caller session when done. */
let _messageSendImpl: ((
  fromAgentId: string,
  toAgentId: string,
  content: string,
  callerSessionId: string,
) => Promise<string>) | null = null;

export function registerMessagingImpls(
  toUser: typeof _messageToUserImpl,
  toAgent: typeof _messageSendImpl
) {
  _messageToUserImpl = toUser;
  _messageSendImpl = toAgent;
}

const messageToUserSchema = z.object({
  content: z.string().describe("Message content to send to the user"),
});

export const messageToUserTool: Tool<z.infer<typeof messageToUserSchema>> = {
  name: "message_to_user",
  description: "Send a message to the user in the active session.",
  schema: messageToUserSchema,
  toDefinition: () => ({
    name: "message_to_user",
    description: "Send a message to the user in the active session.",
    parameters: zodToJsonSchema(messageToUserSchema),
  }),
  async execute({ content }, ctx) {
    if (!_messageToUserImpl) throw new Error("Messaging service not initialized");
    await _messageToUserImpl(ctx.agentId, ctx.sessionId, content);
  },
};

const messageSendSchema = z.object({
  toAgentId: z.string().describe("Target agent ID"),
  content: z.string().describe("Message content to send"),
});

export const messageSendTool: Tool<z.infer<typeof messageSendSchema>, string> = {
  name: "message_send",
  description:
    "Send a message to another agent. They work in a separate thread; when they reply, you will be run again in this thread to review and report to the user. Returns immediately.",
  schema: messageSendSchema,
  toDefinition: () => ({
    name: "message_send",
    description:
      "Send a message to another agent. They work in a separate thread; when they reply, you will be run again in this thread to review and report to the user. Returns immediately.",
    parameters: zodToJsonSchema(messageSendSchema),
  }),
  async execute({ toAgentId, content }, ctx) {
    if (!_messageSendImpl) throw new Error("Messaging service not initialized");
    return _messageSendImpl(ctx.agentId, toAgentId, content, ctx.sessionId);
  },
};

export const messagingTools: Tool[] = [messageToUserTool, messageSendTool];
