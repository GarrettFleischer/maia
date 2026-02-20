/**
 * @fileoverview Parses Ollama-related environment variables for use by the LLM client.
 * @module lib/ollama-env
 */

/**
 * Parsed value for Ollama's "think" parameter: true for most models, or level for GPT-OSS.
 */
export type OllamaThinkValue = true | "low" | "medium" | "high";

/**
 * Parses OLLAMA_THINK and OLLAMA_THINK_LEVEL from env.
 *
 * @brief Returns a value to send as the "think" body field for /api/chat, or undefined to omit.
 * @returns undefined when thinking is disabled; true or a level string when enabled.
 * @note Compatible models: DeepSeek R1, Qwen 3 (boolean); GPT-OSS (low|medium|high).
 * @example
 *   // OLLAMA_THINK=true  -> true
 *   // OLLAMA_THINK=1, OLLAMA_THINK_LEVEL=high -> "high"
 *   // OLLAMA_THINK=no or unset -> undefined
 */
export function parseOllamaThink(): OllamaThinkValue | undefined {
  const raw = process.env.OLLAMA_THINK?.trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0" || raw === "no") return undefined;
  if (raw !== "true" && raw !== "1" && raw !== "yes") return undefined;

  const level = process.env.OLLAMA_THINK_LEVEL?.trim().toLowerCase();
  if (level === "low" || level === "medium" || level === "high") return level;
  return true;
}

/**
 * Parses OLLAMA_NUM_CTX from env for context length (tokens).
 *
 * @brief Returns a value to send as options.num_ctx in /api/chat, or undefined to omit.
 * @returns undefined when unset or invalid; otherwise a positive number.
 * @note Ollama uses this to set the model's context window; can override model default.
 * @example
 *   // OLLAMA_NUM_CTX=8192  -> 8192
 *   // OLLAMA_NUM_CTX=128000 -> 128000
 *   // unset or 0 -> undefined
 */
export function parseOllamaNumCtx(): number | undefined {
  const raw = process.env.OLLAMA_NUM_CTX?.trim();
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}
