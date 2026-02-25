import { describe, it, expect, beforeEach } from "bun:test";
import {
  credentialCreateTool,
  credentialUpdateTool,
  credentialDeleteTool,
  credentialListTool,
} from "@/lib/tools/credentials";
import { credentialGet } from "@/lib/security/credential-vault";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";

function makeToolCtx(): ToolContext {
  const ctx = makeTestContext();
  return { ...ctx, agentId: "agent-1", sessionId: "session-1", volumeRoot: "/workspace" };
}

describe("credentialCreateTool", () => {
  it("creates a retrievable credential", async () => {
    const ctx = makeToolCtx();
    await credentialCreateTool.execute({ key: "MY_KEY", value: "secret" }, ctx);
    expect(credentialGet(ctx, "MY_KEY")).toBe("secret");
  });

  it("has correct name and parameters", () => {
    const def = credentialCreateTool.toDefinition();
    expect(def.name).toBe("credential_create");
    expect(def.parameters).toBeDefined();
  });
});

describe("credentialUpdateTool", () => {
  it("updates an existing credential's value", async () => {
    const ctx = makeToolCtx();
    await credentialCreateTool.execute({ key: "TOKEN", value: "old" }, ctx);
    await credentialUpdateTool.execute({ key: "TOKEN", value: "new" }, ctx);
    expect(credentialGet(ctx, "TOKEN")).toBe("new");
  });

  it("throws when key does not exist", async () => {
    const ctx = makeToolCtx();
    await expect(credentialUpdateTool.execute({ key: "MISSING", value: "v" }, ctx)).rejects.toThrow();
  });
});

describe("credentialDeleteTool", () => {
  it("deletes a credential", async () => {
    const ctx = makeToolCtx();
    await credentialCreateTool.execute({ key: "DEL_ME", value: "bye" }, ctx);
    await credentialDeleteTool.execute({ key: "DEL_ME" }, ctx);
    expect(() => credentialGet(ctx, "DEL_ME")).toThrow();
  });
});

describe("credentialListTool", () => {
  it("returns list of keys", async () => {
    const ctx = makeToolCtx();
    await credentialCreateTool.execute({ key: "KEY_A", value: "a" }, ctx);
    await credentialCreateTool.execute({ key: "KEY_B", value: "b" }, ctx);
    const result = await credentialListTool.execute({}, ctx);
    expect(result).toContain("KEY_A");
    expect(result).toContain("KEY_B");
  });

  it("never exposes values", async () => {
    const ctx = makeToolCtx();
    await credentialCreateTool.execute({ key: "SECRET", value: "top-secret-value" }, ctx);
    const result = (await credentialListTool.execute({}, ctx) as string[]).join(",");
    expect(result).not.toContain("top-secret-value");
  });
});
