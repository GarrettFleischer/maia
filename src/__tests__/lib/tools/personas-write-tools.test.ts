/**
 * @fileoverview Tests for Maia-only persona catalog / override writes on disk (uses MAIA_DATA_DIR).
 * @module __tests__/lib/tools/personas-write-tools.test
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import {
  personaCatalogUpsertTool,
  personaOverrideWriteTool,
} from "@/lib/tools/personas-tools";
import { clearPersonaCatalogCache, getPersonaById } from "@/lib/personas/registry";
import {
  getPersonasDataCatalogDir,
  getPersonasOverridesDir,
} from "@/lib/data-dir";

describe("persona override / catalog tools", () => {
  let tmpRoot: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.MAIA_DATA_DIR;
    tmpRoot = path.join(process.cwd(), ".tmp-personas-tools-test");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.MAIA_DATA_DIR = tmpRoot;
    clearPersonaCatalogCache();
  });

  afterEach(() => {
    if (prevDataDir !== undefined) process.env.MAIA_DATA_DIR = prevDataDir;
    else delete process.env.MAIA_DATA_DIR;
    clearPersonaCatalogCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function minimalCtx(): ToolContext {
    const ctx = makeTestContext();
    return {
      ...ctx,
      agentId: "maia",
      sessionId: "sess-test",
      volumeRoot: "/unused",
    };
  }

  it("persona_override_write creates markdown merged into catalog personas", async () => {
    clearPersonaCatalogCache();
    const before = getPersonaById("typescript-pro");
    expect(before).not.toBeNull();

    const res = await personaOverrideWriteTool.execute(
      {
        persona_id: "typescript-pro",
        markdown: "## Extra\nPrefer strict types.",
      },
      minimalCtx(),
    );

    expect(typeof res === "object" && res !== null && "ok" in res && res.ok).toBe(true);

    clearPersonaCatalogCache();
    const after = getPersonaById("typescript-pro");
    expect(after?.instructions).toContain("Prefer strict types.");
    expect(after?.instructions).toContain(before!.instructions.slice(0, 40));

    const overridePath = path.join(
      getPersonasOverridesDir(),
      "typescript-pro.md",
    );
    expect(fs.readFileSync(overridePath, "utf-8")).toContain("Prefer strict types.");
  });

  it("persona_catalog_upsert writes data catalog entry loadable after cache clear", async () => {
    const id = `catalog-upsert-${Date.now()}`;
    const res = await personaCatalogUpsertTool.execute(
      {
        persona_id: id,
        description: "Integration persona",
        instructions: "Say hello.\nSecond line.",
      },
      minimalCtx(),
    );

    expect(typeof res === "object" && res !== null && "ok" in res && res.ok).toBe(true);

    clearPersonaCatalogCache();
    const p = getPersonaById(id);
    expect(p).not.toBeNull();
    expect(p!.description).toBe("Integration persona");
    expect(p!.instructions).toContain("Second line.");

    const writtenPath = path.join(getPersonasDataCatalogDir(), `${id}.toml`);
    expect(fs.existsSync(writtenPath)).toBe(true);
  });
});
