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

const messageSendSchema = z.object({
  to: z
    .string()
    .describe(
      "Target: 'user' (message in active session), 'maia', or a persona id from persona_list (same thread)",
    ),
  text: z.string().describe("Message content"),
});

export const messageSendTool: Tool<z.infer<typeof messageSendSchema>, string> = {
  name: "message_send",
  description:
    "Send a message. Use to: 'user' for the user in this session, 'maia' for the orchestrator, or a persona id (see persona_list). Replies appear in this thread. Example: message_send({ to: 'user', text: 'Done.' }) or message_send({ to: 'typescript-pro', text: 'Please review.' }).",
  schema: messageSendSchema,
  toDefinition: () => ({
    name: "message_send",
    description:
      "Send a message. Use to: 'user' for the user in this session, 'maia' for the orchestrator, or a persona id (see persona_list). Replies appear in this thread. Example: message_send({ to: 'user', text: 'Done.' }) or message_send({ to: 'typescript-pro', text: 'Please review.' }).",
    parameters: zodToJsonSchema(messageSendSchema),
  }),
  async execute({ to: toTarget, text: content }, ctx) {
    if (toTarget === "user") {
      if (!_messageToUserImpl) throw new Error("Messaging service not initialized");
      await _messageToUserImpl(ctx.agentId, ctx.sessionId, content);
      return "Message sent to user.";
    }
    if (!_messageSendImpl) throw new Error("Messaging service not initialized");
    return _messageSendImpl(ctx.agentId, toTarget, content, ctx.sessionId);
  },
};

export const messagingTools: Tool[] = [messageSendTool];
