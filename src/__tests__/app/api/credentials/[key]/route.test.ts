/**
 * @fileoverview Tests for PUT/DELETE /api/credentials/[key].
 * @module __tests__/app/api/credentials/[key]/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { credentialCreate } from "@/lib/security/credential-vault";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { PUT, DELETE } from "@/app/api/credentials/[key]/route";

describe("PUT /api/credentials/[key]", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    credentialCreate(ctx, "my_key", "old");
    _setTestContext(ctx);
  });

  it("updates credential and returns ok", async () => {
    const req = createNextRequest("http://localhost/api/credentials/my_key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "new_value" }),
    });
    const res = await PUT(req, { params: Promise.resolve({ key: "my_key" }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("DELETE /api/credentials/[key]", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    credentialCreate(ctx, "to_delete", "v");
    _setTestContext(ctx);
  });

  it("deletes credential and returns ok", async () => {
    const req = createNextRequest("http://localhost/api/credentials/to_delete", {
      method: "DELETE",
    });
    const res = await DELETE(req, {
      params: Promise.resolve({ key: "to_delete" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
