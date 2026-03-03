/**
 * @fileoverview Standard API error response helper for Next.js route handlers.
 * @module lib/api-response
 *
 * Ensures JSON error responses use the contract { error: string; code?: string }.
 * See docs/api/endpoints.md#error-responses.
 */
import { NextResponse } from "next/server";

/**
 * Standard JSON error body returned by API routes.
 */
export interface ApiErrorBody {
  error: string;
  code?: string;
}

/**
 * Returns a NextResponse with the standard error shape for API routes.
 * @param message - Human-readable error message (returned to client)
 * @param status - HTTP status (400, 404, 500, etc.)
 * @param code - Optional machine-readable code (e.g. "VALIDATION", "NOT_FOUND")
 * @returns NextResponse with JSON body { error, code? }
 */
export function apiError(
  message: string,
  status: number,
  code?: string
): NextResponse {
  const body: ApiErrorBody = { error: message };
  if (code) body.code = code;
  return NextResponse.json(body, { status });
}
