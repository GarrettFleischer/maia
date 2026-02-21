import { z } from "zod";

// Minimal Zod → JSON Schema converter for the subset of Zod used in tools
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
