/**
 * @fileoverview Parses Maia app env vars that control LLM/API behavior (e.g. streaming).
 * @module lib/streaming-env
 */

/**
 * Whether LLM response streaming is enabled for the send API.
 * When false, the server waits for the full response (including thinking and tool calls) before sending.
 *
 * @brief Reads MAIA_LLM_STREAMING from env; true only for "true", "1", or "yes" (case-insensitive).
 * @returns true if streaming is enabled, false otherwise (default).
 * @example
 *   // MAIA_LLM_STREAMING=true  -> true
 *   // MAIA_LLM_STREAMING=1     -> true
 *   // unset or MAIA_LLM_STREAMING=false -> false
 */
export function isStreamingEnabled(): boolean {
  const raw = process.env.MAIA_LLM_STREAMING?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}
