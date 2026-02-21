import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema } from "@/lib/zod-to-json";

describe("zodToJsonSchema", () => {
  it("converts a simple object schema", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe("object");
    expect((result.properties as Record<string, unknown>).name).toBeDefined();
    expect((result.properties as Record<string, unknown>).age).toBeDefined();
  });

  it("handles optional fields", () => {
    const schema = z.object({ required: z.string(), optional: z.string().optional() });
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe("object");
    expect(result.required).toContain("required");
  });

  it("handles enum", () => {
    const schema = z.enum(["a", "b", "c"]);
    const result = zodToJsonSchema(schema);
    expect(result.enum).toEqual(["a", "b", "c"]);
  });

  it("handles array of strings", () => {
    const schema = z.array(z.string());
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe("array");
    expect((result.items as Record<string, unknown>).type).toBe("string");
  });

  it("handles nested objects", () => {
    const schema = z.object({ inner: z.object({ x: z.number() }) });
    const result = zodToJsonSchema(schema);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.inner.type).toBe("object");
  });

  it("preserves .describe() as JSON Schema description", () => {
    const schema = z.object({ q: z.string().describe("Search query") });
    const result = zodToJsonSchema(schema);
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.q.description).toBe("Search query");
  });

  it("returns a plain object, not a Zod object", () => {
    const schema = z.object({ x: z.boolean() });
    const result = zodToJsonSchema(schema);
    expect(typeof result).toBe("object");
    expect(result).not.toBeInstanceOf(z.ZodObject);
  });
});
