/**
 * @fileoverview API key authentication for Maia. Validates Authorization Bearer token.
 * @module lib/auth
 *
 * Every API request must include header: Authorization: Bearer <MAIA_API_KEY>
 * unless MAIA_API_KEY is not set (e.g. dev with no key).
 */

/**
 * Validates the request's Authorization header against the configured API key.
 * @brief Returns a 401 Response if invalid; null if valid (caller proceeds).
 * @param request - Incoming request (must have headers)
 * @param apiKey - Configured MAIA_API_KEY (from env). Empty string = no auth required.
 * @returns Response to send (401) or null if authorized
 */
export function requireApiKey(
  request: Request,
  apiKey: string
): Response | null {
  if (!apiKey || apiKey.trim() === "") {
    return null;
  }
  const auth = request.headers.get("Authorization");
  if (!auth || typeof auth !== "string") {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const trimmed = auth.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const token = trimmed.slice(7).trim();
  if (token !== apiKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/**
 * Validates the request's token from Authorization header or from query param "token".
 * Used for SSE (EventSource) which cannot send custom headers.
 * @brief Returns a 401 Response if invalid; null if valid.
 * @param request - Incoming request
 * @param apiKey - Configured MAIA_API_KEY (from env). Empty string = no auth required.
 * @returns Response to send (401) or null if authorized
 */
export function requireApiKeyOrQuery(
  request: Request,
  apiKey: string
): Response | null {
  if (!apiKey || apiKey.trim() === "") {
    return null;
  }
  const headerAuth = request.headers.get("Authorization");
  const tokenFromHeader =
    headerAuth?.trim().toLowerCase().startsWith("bearer ") === true
      ? headerAuth.trim().slice(7).trim()
      : null;
  const url = new URL(request.url);
  const tokenFromQuery = url.searchParams.get("token")?.trim() ?? null;
  const token = tokenFromHeader ?? tokenFromQuery;
  if (!token || token !== apiKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
