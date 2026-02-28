/**
 * @fileoverview Unified stream API for LLM completions. Maps model to provider and
 * returns a standard event stream (text_delta, tool_call, thinking_delta, usage, stop).
 * @module lib/ai/stream
 */

import { createProvider } from "./factory";
import type { Message, StreamEvent, StreamOptions, ToolDefinition } from "./types";
import type { AppContext } from "../context";

/**
 * Stream completion events for the given model using the appropriate provider.
 * @param model - Model id (e.g. ollama/llama3.2, openrouter/anthropic/claude-3.5-haiku).
 * @param ctx - Application context (for settings and HTTP).
 * @param messages - Conversation messages.
 * @param tools - Tool definitions for the provider.
 * @param options - Stream options (e.g. signal for cancellation).
 * @returns AsyncIterable of StreamEvent.
 * @throws Error if model is not whitelisted or provider is unknown.
 */
export async function* stream(
  model: string,
  ctx: AppContext,
  messages: Message[],
  tools: ToolDefinition[],
  options?: StreamOptions,
): AsyncIterable<StreamEvent> {
  const provider = createProvider(model, ctx);
  yield* provider.stream(messages, tools, options);
}
