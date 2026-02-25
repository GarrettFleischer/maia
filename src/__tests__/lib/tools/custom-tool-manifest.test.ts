/**
 * @fileoverview Tests for custom tool manifest parsing and loader.
 */
import { describe, it, expect } from "bun:test";
import path from "path";
import {
  parseManifest,
  isSlugSafe,
  buildToolsFromManifest,
  loadManifestFromFs,
} from "@/lib/tools/custom-tool-manifest";
import { getToolsDir } from "@/lib/data-dir";
import { FakeFs } from "../../helpers/fakes";

const TOOLS_DIR = getToolsDir();

describe("parseManifest", () => {
  it("parses valid manifest with one function", () => {
    const params = { type: "object", properties: { city: { type: "string" } }, required: ["city"] as string[] };
    const json = JSON.stringify({
      name: "weather_lookup",
      description: "Look up weather",
      functions: [
        {
          name: "weather_get",
          description: "Get weather for a city",
          parameters: params,
        },
      ],
    });
    const m = parseManifest(json);
    expect(m.name).toBe("weather_lookup");
    expect(m.functions).toHaveLength(1);
    expect(m.functions[0]!.name).toBe("weather_get");
    expect(m.functions[0]!.parameters).toEqual(params);
  });

  it("parses valid manifest with multiple functions", () => {
    const json = JSON.stringify({
      name: "multi",
      description: "Multi",
      functions: [
        { name: "fn_a", description: "A", parameters: {} },
        { name: "fn_b", description: "B", parameters: {} },
      ],
    });
    const m = parseManifest(json);
    expect(m.functions).toHaveLength(2);
    expect(m.functions[0]!.name).toBe("fn_a");
    expect(m.functions[1]!.name).toBe("fn_b");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseManifest("not json")).toThrow("Invalid manifest JSON");
  });

  it("throws on missing name", () => {
    const json = JSON.stringify({
      description: "x",
      functions: [{ name: "f", description: "d", parameters: {} }],
    });
    expect(() => parseManifest(json)).toThrow();
  });

  it("throws on empty functions array", () => {
    const json = JSON.stringify({
      name: "x",
      description: "x",
      functions: [],
    });
    expect(() => parseManifest(json)).toThrow();
  });
});

describe("isSlugSafe", () => {
  it("accepts alphanumeric and hyphen slugs", () => {
    expect(isSlugSafe("my-tool")).toBe(true);
    expect(isSlugSafe("my_tool_2")).toBe(false);
    expect(isSlugSafe("MyTool")).toBe(true);
  });

  it("rejects path traversal and special chars", () => {
    expect(isSlugSafe("")).toBe(false);
    expect(isSlugSafe("../etc")).toBe(false);
    expect(isSlugSafe("a/b")).toBe(false);
  });
});

describe("buildToolsFromManifest", () => {
  it("returns one Tool per function with stub execute", async () => {
    const manifest = parseManifest(
      JSON.stringify({
        name: "weather",
        description: "Weather",
        functions: [
          { name: "weather_get", description: "Get", parameters: {} },
        ],
      }),
    );
    const tools = buildToolsFromManifest("my-tool", manifest);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("weather_get");
    expect(tools[0]!.description).toBe("Get");
    const def = tools[0]!.toDefinition();
    expect(def.name).toBe("weather_get");
    expect(def.parameters).toEqual({});
    const result = await tools[0]!.execute({}, {} as never);
    expect(result).toContain("weather_get");
    expect(result).toContain("execution not yet implemented");
  });
});

describe("loadManifestFromFs", () => {
  it("loads and parses manifest from tools dir", () => {
    const fs = new FakeFs();
    const manifestPath = path.join(TOOLS_DIR, "my-tool", "manifest.json");
    fs.seed(
      manifestPath,
      JSON.stringify({
        name: "my_tool",
        description: "My tool",
        functions: [{ name: "run", description: "Run", parameters: {} }],
      }),
    );
    const m = loadManifestFromFs("my-tool", fs);
    expect(m.name).toBe("my_tool");
    expect(m.functions[0]!.name).toBe("run");
  });

  it("throws on invalid slug", () => {
    const fs = new FakeFs();
    expect(() => loadManifestFromFs("../etc", fs)).toThrow("Invalid tool slug");
  });
});
