/**
 * @fileoverview Integration tests for secrets store (CRUD; values never exposed to LLM).
 * @module tests/db/secrets.test
 */

import { describe, expect, it } from "bun:test";
import { openDb } from "@/db/client";
import { createSecretsRepository } from "@/db/secrets";

describe("secrets repository", () => {
  it("set and get value server-side", async () => {
    const db = await openDb(":memory:");
    const repo = createSecretsRepository(db, "test-encryption-key-32bytes!!");
    await repo.set("API_KEY", "secret-value");
    const value = await repo.get("API_KEY");
    expect(value).toBe("secret-value");
    db.close();
  });

  it("listKeys returns only key names", async () => {
    const db = await openDb(":memory:");
    const repo = createSecretsRepository(db, "key");
    await repo.set("K1", "v1");
    await repo.set("K2", "v2");
    const keys = await repo.listKeys();
    expect(keys.sort()).toEqual(["K1", "K2"]);
    db.close();
  });

  it("delete removes key", async () => {
    const db = await openDb(":memory:");
    const repo = createSecretsRepository(db, "key");
    await repo.set("K", "v");
    await repo.delete("K");
    expect(await repo.get("K")).toBeNull();
    db.close();
  });
});
