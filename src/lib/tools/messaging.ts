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
  to: z.string().describe("Target: 'user' (message in active session) or agent ID (agent-to-agent; replies until [DONE])"),
  text: z.string().describe("Message content"),
});

export const messageSendTool: Tool<z.infer<typeof messageSendSchema>, string> = {
  name: "message_send",
  description:
    "Send a message. Use to: 'user' to message the user in the active session, or to: '<agent-id>' to message another agent (replies forwarded until [DONE]). Example: message_send({ to: 'user', text: 'Done.' }) or message_send({ to: 'agent-uuid', text: 'Please review.' }).",
  schema: messageSendSchema,
  toDefinition: () => ({
    name: "message_send",
    description:
      "Send a message. Use to: 'user' to message the user in the active session, or to: '<agent-id>' to message another agent (replies forwarded until [DONE]). Example: message_send({ to: 'user', text: 'Done.' }) or message_send({ to: 'agent-uuid', text: 'Please review.' }).",
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
