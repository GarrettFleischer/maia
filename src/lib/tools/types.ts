import type { ZodTypeAny } from "zod";
import type { ToolDefinition } from "../ai/types";
import type { AppContext } from "../context";

export interface ToolContext extends AppContext {
  agentId: string;
  sessionId: string;
  volumeRoot: string;
}

export interface Tool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  schema: ZodTypeAny;
  execute(args: TArgs, context: ToolContext): Promise<TResult>;
  toDefinition(): ToolDefinition;
}

export interface ToolRegistration {
  tool: Tool;
  maiaOnly: boolean;
}

export interface ToolResult {
  tool_name: string;
  result?: unknown;
  error?: string;
  success: boolean;
}
