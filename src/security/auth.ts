/**
 * @fileoverview Bearer token authentication verifier for the gateway. Verifies tokens
 * using timing-safe comparison, extracts tokens from Authorization headers, and logs
 * auth events to the audit log.
 * @module security/auth
 */

import type { MaiaContext } from "../core/types.js";

const encoder = new TextEncoder();
const BEARER_PREFIX = "Bearer ";

/**
 * @brief Metadata passed to verify/verifyHeader for audit logging (e.g. IP, user-agent).
 */
export interface AuthMeta {
  ip?: string;
  [key: string]: unknown;
}

/**
 * @brief Result of token verification.
 */
export interface VerifyResult {
  valid: boolean;
  statusCode?: number;
}

/**
 * @brief Auth verifier returned by createAuth.
 */
export interface AuthVerifier {
  verify(token: string, meta?: AuthMeta): Promise<VerifyResult>;
  verifyHeader(header: string | null | undefined, meta?: AuthMeta): Promise<VerifyResult>;
}

/**
 * @brief Creates an auth verifier that validates bearer tokens against the configured
 * gateway token using timing-safe comparison.
 * @param ctx - Maia context with config, crypto, and auditLog
 * @returns Auth verifier with verify and verifyHeader methods
 */
export function createAuth(ctx: MaiaContext): AuthVerifier {
  const expectedToken = ctx.config.gateway.auth.token;

  /**
   * @brief Verifies a bearer token against the configured gateway token using timing-safe comparison.
   * @param token - The token string to verify
   * @param meta - Optional metadata (e.g. ip) for audit logging
   * @returns Promise resolving to { valid: boolean }
   */
  async function verify(token: string, meta?: AuthMeta): Promise<VerifyResult> {
    const expected = encoder.encode(expectedToken);
    const provided = encoder.encode(token);

    const maxLen = Math.max(expected.length, provided.length);
    const paddedExpected = new Uint8Array(maxLen);
    const paddedProvided = new Uint8Array(maxLen);
    paddedExpected.set(expected);
    paddedProvided.set(provided);

    const comparisonResult = ctx.crypto.timingSafeEqual(paddedExpected, paddedProvided);
    const valid = expected.length === provided.length && comparisonResult;
    if (valid) {
      await ctx.auditLog.log("AUTH_SUCCESS", meta ?? {});
    } else {
      const reason = expected.length !== provided.length ? "length_mismatch" : "invalid_token";
      await ctx.auditLog.log("AUTH_FAILURE", { ...meta, reason });
    }
    return { valid };
  }

  /**
   * @brief Extracts token from "Bearer <token>" header and verifies it.
   * @param header - The Authorization header value (or null/undefined)
   * @param meta - Optional metadata (e.g. ip) for audit logging
   * @returns Promise resolving to { valid: boolean, statusCode?: number }
   */
  async function verifyHeader(
    header: string | null | undefined,
    meta?: AuthMeta
  ): Promise<VerifyResult> {
    if (!header || typeof header !== "string") {
      await ctx.auditLog.log("AUTH_FAILURE", { ...meta, reason: "missing_header" });
      return { valid: false, statusCode: 401 };
    }

    const trimmed = header.trim();
    if (!trimmed.startsWith(BEARER_PREFIX)) {
      await ctx.auditLog.log("AUTH_FAILURE", { ...meta, reason: "invalid_format" });
      return { valid: false, statusCode: 401 };
    }

    const token = trimmed.slice(BEARER_PREFIX.length).trim();
    const result = await verify(token, meta);
    if (!result.valid) {
      return { ...result, statusCode: 401 };
    }
    return result;
  }

  return { verify, verifyHeader };
}
