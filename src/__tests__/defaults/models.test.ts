/**
 * @fileoverview Tests for default model configuration (defaults/models.json).
 * @module __tests__/defaults/models.test
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface DefaultModelEntry {
  provider: string;
  name: string;
}

describe("defaults/models.json", () => {
  const modelsPath = join(process.cwd(), "defaults", "models.json");
  const models = JSON.parse(
    readFileSync(modelsPath, "utf8"),
  ) as DefaultModelEntry[];

  it("uses a valid Q4_K_M tag for all Unsloth GGUF models (<=16GB VRAM and exists on Hugging Face)", () => {
    const unslothModels = models.filter(
      (m) => m.provider === "ollama" && m.name.startsWith("hf.co/unsloth/"),
    );
    expect(unslothModels.length).toBeGreaterThan(0);

    for (const model of unslothModels) {
      const parts = model.name.split(":");
      expect(parts.length).toBe(2);
      const tag = parts[1];
      expect(tag).toBe("Q4_K_M");
    }
  });
});
