/**
 * @fileoverview Tests for models-config: ensure copy from defaults, read, write.
 * @module __tests__/lib/models-config
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  ensureModelsJson,
  readModelsConfig,
  writeModelsConfig,
  getModelsJsonPath,
} from "@/lib/models-config";
import type { ModelsJsonEntry } from "@/lib/types";

describe("models-config", () => {
  const originalDataDir = process.env.MAIA_DATA_DIR;

  beforeEach(() => {
    const tmp = path.join(process.cwd(), "tmp-models-config-test-" + Math.random().toString(36).slice(2));
    fs.mkdirSync(tmp, { recursive: true });
    process.env.MAIA_DATA_DIR = tmp;
  });

  afterEach(() => {
    const dir = process.env.MAIA_DATA_DIR;
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    process.env.MAIA_DATA_DIR = originalDataDir;
  });

  describe("ensureModelsJson", () => {
    it("copies defaults/models.json to data/models.json when missing", () => {
      ensureModelsJson();
      const dataPath = getModelsJsonPath();
      expect(fs.existsSync(dataPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
      expect(Array.isArray(content)).toBe(true);
      expect(content.length).toBeGreaterThan(0);
      expect(content[0]).toHaveProperty("provider");
      expect(content[0]).toHaveProperty("name");
    });

    it("does not overwrite existing data/models.json", () => {
      ensureModelsJson();
      const dataPath = getModelsJsonPath();
      const custom = [{ provider: "ollama", name: "custom-only" }];
      fs.writeFileSync(dataPath, JSON.stringify(custom, null, 2));
      ensureModelsJson();
      const after = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
      expect(after).toEqual(custom);
    });
  });

  describe("readModelsConfig", () => {
    it("returns whitelistedModels as provider/name and modelParams from entries", () => {
      ensureModelsJson();
      const { whitelistedModels, modelParams } = readModelsConfig();
      expect(whitelistedModels).toContain("ollama/nomic-embed-text");
      expect(whitelistedModels).toContain("openrouter/free");
      expect(Array.isArray(whitelistedModels)).toBe(true);
      expect(typeof modelParams).toBe("object");
    });

    it("includes optional params from entries in modelParams", () => {
      const dataPath = getModelsJsonPath();
      fs.mkdirSync(path.dirname(dataPath), { recursive: true });
      fs.writeFileSync(
        dataPath,
        JSON.stringify([
          { provider: "ollama", name: "llama3.2", temperature: 0.7, top_p: 0.9 },
        ])
      );
      const { whitelistedModels, modelParams } = readModelsConfig();
      expect(whitelistedModels).toEqual(["ollama/llama3.2"]);
      expect(modelParams["ollama/llama3.2"]).toEqual({
        temperature: 0.7,
        top_p: 0.9,
      });
    });
  });

  describe("writeModelsConfig", () => {
    it("writes entries and readModelsConfig returns them", () => {
      const entries: ModelsJsonEntry[] = [
        { provider: "ollama", name: "a" },
        { provider: "openrouter", name: "b/c", temperature: 0.5 },
      ];
      writeModelsConfig(entries);
      const { whitelistedModels, modelParams } = readModelsConfig();
      expect(whitelistedModels).toEqual(["ollama/a", "openrouter/b/c"]);
      expect(modelParams["openrouter/b/c"]?.temperature).toBe(0.5);
    });
  });
});
