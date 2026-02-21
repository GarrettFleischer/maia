import { describe, it, expect, beforeEach } from "bun:test";
import {
  credentialCreate,
  credentialUpdate,
  credentialDelete,
  credentialList,
  credentialGet,
} from "@/lib/security/credential-vault";
import { makeTestContext } from "../../helpers/fakes";
import type { AppContext } from "@/lib/context";

describe("credential-vault", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  describe("credentialCreate", () => {
    it("stores a credential that can be retrieved", () => {
      credentialCreate(ctx, "MY_KEY", "secret-value");
      const val = credentialGet(ctx, "MY_KEY");
      expect(val).toBe("secret-value");
    });

    it("stores encrypted bytes — raw DB row does not contain plaintext", () => {
      credentialCreate(ctx, "API_KEY", "super-secret");
      const row = ctx.db.prepare("SELECT ciphertext FROM credentials WHERE key = 'API_KEY'").get() as { ciphertext: string };
      expect(row.ciphertext).not.toContain("super-secret");
    });

    it("allows multiple credentials with different keys", () => {
      credentialCreate(ctx, "KEY_A", "value-a");
      credentialCreate(ctx, "KEY_B", "value-b");
      expect(credentialGet(ctx, "KEY_A")).toBe("value-a");
      expect(credentialGet(ctx, "KEY_B")).toBe("value-b");
    });
  });

  describe("credentialList", () => {
    it("returns empty array when no credentials", () => {
      expect(credentialList(ctx)).toEqual([]);
    });

    it("returns keys in alphabetical order", () => {
      credentialCreate(ctx, "Z_KEY", "z");
      credentialCreate(ctx, "A_KEY", "a");
      credentialCreate(ctx, "M_KEY", "m");
      expect(credentialList(ctx)).toEqual(["A_KEY", "M_KEY", "Z_KEY"]);
    });

    it("never returns plaintext values — only keys", () => {
      credentialCreate(ctx, "SECRET_KEY", "top-secret");
      const keys = credentialList(ctx);
      expect(keys).toContain("SECRET_KEY");
      expect(keys.join(",")).not.toContain("top-secret");
    });
  });

  describe("credentialUpdate", () => {
    it("updates the value of an existing credential", () => {
      credentialCreate(ctx, "TOKEN", "old-value");
      credentialUpdate(ctx, "TOKEN", "new-value");
      expect(credentialGet(ctx, "TOKEN")).toBe("new-value");
    });

    it("throws when key does not exist", () => {
      expect(() => credentialUpdate(ctx, "NONEXISTENT", "val")).toThrow();
    });
  });

  describe("credentialDelete", () => {
    it("removes the credential", () => {
      credentialCreate(ctx, "DEL_KEY", "some-value");
      credentialDelete(ctx, "DEL_KEY");
      expect(() => credentialGet(ctx, "DEL_KEY")).toThrow();
    });

    it("does nothing (no error) when key does not exist", () => {
      expect(() => credentialDelete(ctx, "NONEXISTENT")).not.toThrow();
    });

    it("removes only the targeted key", () => {
      credentialCreate(ctx, "KEEP", "keep-me");
      credentialCreate(ctx, "DELETE_ME", "bye");
      credentialDelete(ctx, "DELETE_ME");
      expect(credentialList(ctx)).toEqual(["KEEP"]);
      expect(credentialGet(ctx, "KEEP")).toBe("keep-me");
    });
  });

  describe("getMasterKey validation", () => {
    it("throws when CREDENTIAL_MASTER_KEY is set but not 32 bytes (64 hex chars)", () => {
      const prev = process.env.CREDENTIAL_MASTER_KEY;
      process.env.CREDENTIAL_MASTER_KEY = "ab";
      try {
        expect(() => credentialCreate(ctx, "KEY", "value")).toThrow(
          "CREDENTIAL_MASTER_KEY must be a 64-character hex string (32 bytes)"
        );
      } finally {
        if (prev !== undefined) process.env.CREDENTIAL_MASTER_KEY = prev;
        else delete process.env.CREDENTIAL_MASTER_KEY;
      }
    });
  });

  describe("credentialGet", () => {
    it("throws when key not found", () => {
      expect(() => credentialGet(ctx, "MISSING")).toThrow();
    });

    it("returns exact plaintext, preserving special chars", () => {
      const value = "p@ssw0rd!#$%^&*()_+-=[]{}|;':\",./<>?";
      credentialCreate(ctx, "SPECIAL", value);
      expect(credentialGet(ctx, "SPECIAL")).toBe(value);
    });

    it("returns exact plaintext, preserving unicode", () => {
      const value = "日本語テスト 🔐";
      credentialCreate(ctx, "UNICODE", value);
      expect(credentialGet(ctx, "UNICODE")).toBe(value);
    });
  });
});
