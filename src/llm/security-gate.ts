/**
 * @fileoverview Pre-LLM security gate: classify request via separate LLM call; returns allowed or block reason.
 * @module llm/security-gate
 */

import type { OllamaMessage } from "./ollama";
import { debug } from "@/lib/logger";
import { SECURITY_GATE_SYSTEM_PROMPT } from "@/prompts";

export type SecurityGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Ollama chat response shape used by the gate (minimal). */
export type GateOllamaResponse = {
  message: { content: string };
  done: boolean;
};

export type SecurityGateOptions = {
  baseUrl?: string;
  model?: string;
};

/**
 * Runs the security gate: sends messages to the classifier and parses JSON { allowed, reason? }.
 * When OLLAMA_SECURITY_GATE_MODEL is unset, skips the check and allows all.
 *
 * @param messages - Outgoing request (system + messages or next user content)
 * @param ollamaChat - Function that performs one chat call and returns { message: { content }, done }
 * @param options - Optional baseUrl/model override (defaults from env)
 * @returns Allowed when gate is disabled or when the classifier allows; blocked with reason otherwise.
 */
export async function runSecurityGate(
  messages: OllamaMessage[],
  ollamaChat: (opts: {
    baseUrl: string;
    model: string;
    messages: OllamaMessage[];
  }) => Promise<GateOllamaResponse>,
  options?: SecurityGateOptions
): Promise<SecurityGateResult> {
  const modelEnv = process.env.OLLAMA_SECURITY_GATE_MODEL?.trim();
  if (!modelEnv) {
    return { allowed: true };
  }
  const baseUrl = options?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const model = options?.model ?? modelEnv;
  const combined: OllamaMessage[] = [
    { role: "system", content: SECURITY_GATE_SYSTEM_PROMPT },
    ...messages,
  ];
  const res = await ollamaChat({
    baseUrl,
    model,
    messages: combined,
  });
  const raw = res.message.content.trim();
  try {
    const parsed = JSON.parse(raw) as { allowed?: boolean; reason?: string };
    if (parsed.allowed === true) {
      return { allowed: true };
    }
    const reason = typeof parsed.reason === "string" ? parsed.reason : "Unsafe content";
    debug("security_gate", { event: "blocked", reason });
    return {
      allowed: false,
      reason,
    };
  } catch {
    debug("security_gate", { event: "blocked", reason: "Classifier returned invalid JSON" });
    return { allowed: false, reason: "Classifier returned invalid JSON" };
  }
}
