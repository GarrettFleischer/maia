import { z, ZodTypeAny } from "zod";

// Minimal Zod → JSON Schema converter for the subset of Zod used in tools
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return convertType(schema);
}

function convertType(schema: ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(schema.shape)) {
      properties[key] = convertType(val as ZodTypeAny);
      if (!(val instanceof z.ZodOptional)) required.push(key);
    }
    return { type: "object", properties, required };
  }
  if (schema instanceof z.ZodString) {
    const base: Record<string, unknown> = { type: "string" };
    if (schema.description) base.description = schema.description;
    return base;
  }
  if (schema instanceof z.ZodNumber) {
    const base: Record<string, unknown> = { type: "number" };
    if (schema.description) base.description = schema.description;
    return base;
  }
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodOptional) {
    return convertType(schema.unwrap());
  }
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: convertType(schema.element) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: schema.options };
  }
  // fallback
  return { type: "string" };
}
