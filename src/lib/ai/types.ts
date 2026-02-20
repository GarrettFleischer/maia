export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AIResponse {
  content: string;
  toolCalls: ToolCall[];
  stopped: boolean;
}

export interface StreamChunk {
  type: "token" | "tool_call" | "done";
  content?: string;
  toolCall?: ToolCall;
}

export interface AIProvider {
  complete(
    messages: Message[],
    tools: ToolDefinition[],
    onToken: (token: string) => void
  ): Promise<AIResponse>;
}
