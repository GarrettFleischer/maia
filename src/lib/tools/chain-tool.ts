/**
 * @fileoverview Chain tool: run a pipeline of tool calls (e.g. terminal(...).stdout | knowledge_search).
 * @module lib/tools/chain-tool
 *
 * Expression format: segment | segment | ... where each segment is toolName(args).property?
 * Args are JSON; use "@prev" as placeholder for the previous stage result (or "@prev.prop" for a property).
 * On error returns { error, callStack, failedTool, message }.
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";

const SEGMENT_REGEX = /^(\w+)\((.*)\)(\.(\w+))?$/;

interface ChainSegment {
  toolName: string;
  args: Record<string, unknown>;
  property?: string;
}

/**
 * Parses a chain expression into segments.
 * @param expression - e.g. "terminal_exec({\"command\":\"cat x\"}).stdout | knowledge_search({\"query\":\"@prev\"})"
 */
export function parseChainExpression(expression: string): ChainSegment[] {
  const segments: ChainSegment[] = [];
  const parts = expression.split("|").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(SEGMENT_REGEX);
    if (match) {
      const [, toolName, argsStr, , prop] = match;
      let args: Record<string, unknown> = {};
      const trimmed = argsStr?.trim();
      if (trimmed && trimmed !== "{}") {
        try {
          args = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      segments.push({ toolName: toolName!, args, property: prop });
    } else {
      const toolName = part;
      if (toolName) segments.push({ toolName, args: {}, property: undefined });
    }
  }
  return segments;
}

function substitutePrev(args: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === "@prev") {
      out[k] = value;
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      out[k] = substitutePrev(v as Record<string, unknown>, value);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface ChainErrorResult {
  error: true;
  callStack: string[];
  failedTool: string;
  message: string;
}

const chainSchema = z.object({
  expr: z.string().describe("Pipeline: tool(args).prop | tool(args). Use @prev for previous result."),
});

export const chainTool: Tool<z.infer<typeof chainSchema>, unknown | ChainErrorResult> = {
  name: "chain",
  description:
    "Run a pipeline of tools: segment | segment | ... Use @prev in args for previous result. Example: terminal_exec({cmd:'cat file.md'}).stdout | knowledge_search({q:'@prev'}). On error returns { error, callStack, failedTool, message }.",
  schema: chainSchema,
  async execute(args, ctx): Promise<unknown | ChainErrorResult> {
    const tools = ctx.getToolsForAgent?.(ctx.agentId) ?? [];
    const getTool = (name: string) => tools.find((t) => t.name === name);
    const expression = args.expr ?? (args as { expression?: string }).expression;
    if (expression == null || expression === "") {
      return { error: true, callStack: [], failedTool: "", message: "Empty chain" };
    }
    const segments = parseChainExpression(expression);
    if (segments.length === 0) return { error: true, callStack: [], failedTool: "", message: "Empty chain" };

    let prev: unknown = undefined;
    const callStack: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const tool = getTool(seg.toolName);
      if (!tool) {
        return {
          error: true,
          callStack: [...callStack, seg.toolName],
          failedTool: seg.toolName,
          message: `Tool not found: ${seg.toolName}`,
        };
      }
      const resolvedArgs = prev !== undefined ? substitutePrev(seg.args, prev) : seg.args;
      const parsed = tool.schema.safeParse(resolvedArgs);
      if (!parsed.success) {
        return {
          error: true,
          callStack: [...callStack, seg.toolName],
          failedTool: seg.toolName,
          message: parsed.error.message,
        };
      }
      try {
        const result = await tool.execute(parsed.data, ctx);
        callStack.push(seg.toolName);
        prev = seg.property && result !== null && typeof result === "object" && seg.property in result
          ? (result as Record<string, unknown>)[seg.property]
          : result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: true,
          callStack: [...callStack, seg.toolName],
          failedTool: seg.toolName,
          message,
        };
      }
    }
    return prev;
  },
  toDefinition: () => ({
    name: "chain",
    description:
      "Run a pipeline of tools: segment | segment | ... Use @prev for previous result. Example: chain({ expr: 'terminal_exec({cmd:\"cat file.md\"}).stdout | knowledge_search({q:\"@prev\"})' }).",
    parameters: zodToJsonSchema(chainSchema),
    returns: "Last stage result or ChainErrorResult on failure",
  }),
};
