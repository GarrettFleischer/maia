import type { ZodTypeAny } from "zod";
import type { ToolDefinition } from "../ai/types";
import type { AppContext } from "../context";
import type { AIProvider } from "../ai/types";
import type { CreateProviderOptions } from "../ai/factory";

/**
 * Factory to create an AI provider for a given model. Used by smart_context tool
 * for query extraction and summarization. Passed from the runner when available.
 */
export type ProviderFactory = (
  model: string,
  ctx: AppContext,
  options?: CreateProviderOptions,
) => AIProvider;

export interface ToolContext extends AppContext {
  agentId: string;
  sessionId: string;
  volumeRoot: string;
  /** Used by smart_context tool for query extraction; absent in tests or when not provided by runner. */
  providerFactory?: ProviderFactory;
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
